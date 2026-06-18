import { extractText, getMeta } from 'unpdf';

// Phase 2.5 PDF handler. Turns raw PDF bytes into the same shape
// detail-fetch produces for HTML: title + bodyExcerpt + (new) a
// creation-date signal. The orchestrator then runs the SAME pipeline
// over a PDF article as over an HTML article — tagging, search,
// segment, type, keyword indexing are all PDF-blind.
//
// Two safety nets the caller MUST honour:
//   1. Size limit — enforced BEFORE calling here (caller checks
//      content-length; we should never receive a 200MB buffer).
//   2. Empty-text → image-only/scanned PDF. extractText returns
//      < EMPTY_TEXT_THRESHOLD chars → `isEmpty: true`. The orchestrator
//      rejects these as `pdf_no_text` (D16/D18 doctrine: silent failures
//      become visible failures). OCR is a separate deferred decision.

const EXCERPT_MAX_CHARS = 600;
const TITLE_MIN_LENGTH = 12;
const TITLE_MAX_LENGTH = 220;
const EMPTY_TEXT_THRESHOLD = 50;
// Window of the first N chars of body text inside which we search for
// an explicit-month date phrase. Tight enough to stay near the header
// (which is where article dates appear in advisories/circulars), wide
// enough to skip a few boilerplate lines first.
const BODY_HEADER_SEARCH_WINDOW = 800;

// Strict article-date pattern: REQUIRES an English month name (full or
// 3-letter abbrev) followed by day and 4-digit year. Two orderings:
//   "November 6, 2012" / "Nov 6, 2012" / "Nov. 6 2012"
//   "6 November 2012"  / "6 Nov 2012"
// Numeric-only forms like "11/06/2012" or "v. 3-2-2011" are REJECTED
// here on purpose — they're ambiguous and the Panama Canal probe
// (2026-05-30) showed Microsoft Word version stamps ("v. 3-2-2011")
// poison chrono if we let it scan loose text. Strict month token wins.
const ARTICLE_DATE_PATTERN = new RegExp(
  // Variant A: Month Day, Year
  String.raw`\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|` +
    String.raw`Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|` +
    String.raw`Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}\b` +
    String.raw`|` +
    // Variant B: Day Month Year
    String.raw`\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|` +
    String.raw`Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|` +
    String.raw`Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{4}\b`,
  'i',
);

export type PdfExtraction = {
  /** Best-effort article title from PDF text (info.Title is often a
   *  template artifact like "May 4, 2007" — never trusted as primary). */
  title: string | null;
  /** First EXCERPT_MAX_CHARS of cleaned text, for raw_excerpt. */
  bodyExcerpt: string | null;
  /** Total extracted text length (after whitespace collapse). Lets the
   *  orchestrator log/note real coverage. */
  bodyLength: number;
  /** First explicit-month-name date phrase found in the early body
   *  text — e.g. "November 6, 2012". Pre-filtered here rather than
   *  handing chrono the full ~500 chars: PDF boilerplate (Microsoft
   *  Word version stamps like "v. 3-2-2011", form template dates,
   *  numeric reference codes) poisons loose chrono parsing. Extracting
   *  just the strict-month-token phrase isolates the signal. null if
   *  no such pattern in the first BODY_HEADER_SEARCH_WINDOW chars. */
  bodyHeaderProbe: string | null;
  /** PDF metadata CreationDate, parsed from `D:YYYYMMDDHHmmss±HH'mm'`
   *  to ISO 8601. Reflects file CREATION, often days off from article
   *  publish date; cascade weighs it accordingly (low priority). */
  pdfCreationDate: string | null;
  /** Number of pages. Lets us log scope of the document. */
  totalPages: number;
  /** True when extractText returned < EMPTY_TEXT_THRESHOLD chars.
   *  Indicates an image-only/scanned PDF — unpdf cannot reach the
   *  text without OCR. Caller MUST reject these with `pdf_no_text`. */
  isEmpty: boolean;
};

// PDF date format per ISO 32000-1 §7.9.4: "D:YYYYMMDDHHmmSSOHH'mm'"
// where O is one of '+', '-', 'Z'. Examples:
//   D:20121108101617-05'00'
//   D:20240301T120000Z      (rare)
//   D:20210515              (date-only, common from older producers)
export function parsePdfDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([+\-Z]?)(\d{2})?'?(\d{2})?'?/,
  );
  if (!m) return null;
  const [, yyyy, mm = '01', dd = '01', HH = '00', MM = '00', SS = '00', tzSign, tzH, tzM] = m;
  if (!yyyy) return null;
  let tz: string;
  if (!tzSign || tzSign === 'Z') tz = 'Z';
  else if (tzH) tz = `${tzSign}${tzH}:${tzM ?? '00'}`;
  else tz = 'Z';
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}${tz}`;
}

// Pick the first plausible title line from extracted PDF text. Skips:
//   - very short lines (< TITLE_MIN_LENGTH)
//   - all-caps administrative headers (often org-name boilerplate)
//   - URLs / pure numbers / version stamps ("v. 3-2-2011")
//   - common label prefixes that aren't titles ("TO :", "FROM :", "DATE :")
// Prefers lines starting with a domain marker ("ADVISORY", "NOTICE",
// "CIRCULAR", "SUBJECT:", "RE:") if any appears in the first ~15 lines.
function pickTitleFromText(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const marker = /^(advisory|notice|circular|bulletin|subject\s*:|re\s*:|memo)/i;
  const skip = /^(to|from|date|cc|via|attn|attention)\s*:/i;
  const versionStamp = /^v\.?\s*\d/i;
  const isUrl = (l: string) => /^https?:\/\//i.test(l);
  const isAdminAllCaps = (l: string) =>
    l === l.toUpperCase() && l.length > 30 && /^[A-Z][A-Z\s\d().,\-/&]+$/.test(l);

  // First pass: domain markers in first 15 lines
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const l = lines[i];
    if (marker.test(l) && l.length >= TITLE_MIN_LENGTH && l.length <= TITLE_MAX_LENGTH) {
      return l.replace(/^subject\s*:\s*/i, '').replace(/^re\s*:\s*/i, '').trim();
    }
  }

  // Second pass: first non-trivial line
  for (const l of lines.slice(0, 20)) {
    if (l.length < TITLE_MIN_LENGTH) continue;
    if (l.length > TITLE_MAX_LENGTH) continue;
    if (skip.test(l)) continue;
    if (versionStamp.test(l)) continue;
    if (isUrl(l)) continue;
    if (isAdminAllCaps(l)) continue;
    if (/^\d+$/.test(l)) continue;       // pure number
    if (/^[\d\s.\-/]+$/.test(l)) continue; // numeric/date-only
    return l;
  }
  return null;
}

// Collapse runs of whitespace and trim. Keeps single newlines as spaces
// (we're producing prose, not preserving layout).
function cleanText(t: string): string {
  return t.replace(/\s+/g, ' ').trim();
}

export async function extractPdf(bytes: Uint8Array): Promise<PdfExtraction> {
  // unpdf detaches the underlying buffer when passing to its pdfjs
  // worker, so each call needs its own Uint8Array view. We give
  // extractText one copy and getMeta another.
  const forText = new Uint8Array(bytes);
  const forMeta = new Uint8Array(bytes);

  let rawText = '';
  let totalPages = 0;
  try {
    const r = await extractText(forText);
    totalPages = r.totalPages;
    rawText = Array.isArray(r.text) ? r.text.join('\n') : r.text ?? '';
  } catch {
    // If extractText itself blows up, treat as empty — caller will
    // reject as pdf_no_text. Don't propagate; we want a structured
    // outcome, not a thrown exception that aborts the run.
    return {
      title: null,
      bodyExcerpt: null,
      bodyLength: 0,
      bodyHeaderProbe: null,
      pdfCreationDate: null,
      totalPages: 0,
      isEmpty: true,
    };
  }

  const cleanedFull = cleanText(rawText);
  const isEmpty = cleanedFull.length < EMPTY_TEXT_THRESHOLD;

  // Title heuristic operates on the RAW (line-preserved) text so we can
  // still spot "ADVISORY TO SHIPPING No. X-Y" as a discrete line. After
  // text cleaning all line breaks are gone.
  const title = isEmpty ? null : pickTitleFromText(rawText);

  let pdfCreationDate: string | null = null;
  try {
    const meta = await getMeta(forMeta);
    const info = meta?.info as { CreationDate?: string } | undefined;
    pdfCreationDate = parsePdfDate(info?.CreationDate);
  } catch {
    // getMeta failures are non-fatal — we already have the text.
  }

  // Locate FIRST explicit-month-name date inside the early body. We
  // search the first BODY_HEADER_SEARCH_WINDOW chars — wide enough to
  // skip boilerplate, tight enough to avoid grabbing a "Last revised"
  // line from a later section.
  let bodyHeaderProbe: string | null = null;
  if (!isEmpty) {
    const window = cleanedFull.slice(0, BODY_HEADER_SEARCH_WINDOW);
    const match = window.match(ARTICLE_DATE_PATTERN);
    if (match) bodyHeaderProbe = match[0];
  }

  return {
    title,
    bodyExcerpt: isEmpty ? null : cleanedFull.slice(0, EXCERPT_MAX_CHARS),
    bodyLength: cleanedFull.length,
    bodyHeaderProbe,
    pdfCreationDate,
    totalPages,
    isEmpty,
  };
}
