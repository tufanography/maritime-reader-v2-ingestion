// Permissive date extraction shared between the live scraper
// (lib/scrapers/html.ts) and one-off redate scripts. One source of
// truth for "what does a date look like".
//
// Covers: "April 20, 2026" · "20 April 2026" · "20 Apr, 2026" ·
//         "Apr 20th 2026" · "20-04-2026" · "20.04.2026" · "4/20/2026"
//         · "2026-04-20".
// Future dates (>24h ahead) are rejected — "1 August 2026" mentioned
// in an article we have today can't be its publish date.

const MONTHS_3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthIdx(m: string): number {
  return MONTHS_3.indexOf(m.slice(0, 3).toLowerCase());
}

function mkIso(year: number, monthZero: number, day: number): string | null {
  if (monthZero < 0 || monthZero > 11) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1990 || year > 2100) return null;
  const iso = `${year.toString().padStart(4, '0')}-${(monthZero + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T00:00:00.000Z`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  // Sanity: rebuilt date should match what we passed.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthZero || d.getUTCDate() !== day) return null;
  return d.toISOString();
}

const FUTURE_GRACE_MS = 86400_000;
function isFuture(iso: string): boolean {
  return new Date(iso).getTime() - Date.now() > FUTURE_GRACE_MS;
}

/** Parse a single date string from one of many sources (meta tag,
 *  selector text, etc). Rejects future dates. Tries native Date parsing
 *  first, falls back to first regex hit if that fails. */
export function tryParse(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Epoch
  if (/^\d{10,}$/.test(trimmed)) {
    const n = Number(trimmed);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      const iso = d.toISOString();
      return isFuture(iso) ? null : iso;
    }
    return null;
  }
  // Date-only strings ("18 May 2026", "30/05/2026") FIRST, via the regex path
  // which builds UTC midnight (mkIso → T00:00:00Z). `new Date("18 May 2026")`
  // parses in the MACHINE's local timezone, so on a UTC+ host it lands at the
  // previous day's 21:00Z and the day slices one short (root cause of the
  // NorthStandard/Gard "-1 day" mis-dating when run locally vs GHA). Native
  // parse is reserved below for strings that carry an explicit time / TZ
  // (ISO timestamps), where new Date() is already unambiguous.
  const hasExplicitTime = /\dT\d|\d:\d{2}/.test(trimmed) || /([+-]\d{2}:?\d{2}|Z)$/.test(trimmed);
  if (!hasExplicitTime) {
    for (const iso of findAllDates(trimmed)) if (!isFuture(iso)) return iso;
  }
  // Native parse (full ISO timestamps with explicit time/zone)
  const direct = new Date(trimmed);
  if (!isNaN(direct.getTime())) {
    const iso = direct.toISOString();
    if (!isFuture(iso)) return iso;
  }
  // Fall through: regex extraction for anything left.
  for (const iso of findAllDates(trimmed)) if (!isFuture(iso)) return iso;
  return null;
}

/** Returns ISO strings for every date-shaped substring in `text`. The
 *  caller decides which one to keep (typically the first non-future). */
export function findAllDates(text: string): string[] {
  // Strip ordinals so "April 20th, 2026" parses as "April 20, 2026".
  const s = text.replace(/(\d+)(?:st|nd|rd|th)\b/gi, '$1');
  const out: string[] = [];

  // MONTH-DAY-YEAR with named month, space separator:
  //   "April 20, 2026" / "Apr 20 2026" / "Apr 20th 2026"
  for (const m of s.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/gi)) {
    const iso = mkIso(+m[3], monthIdx(m[1]), +m[2]);
    if (iso) out.push(iso);
  }
  // DAY-MONTH-YEAR with named month, space separator:
  //   "20 April 2026" / "20 Apr, 2026" / "20th April 2026" / "16 of February 2026"
  // The optional "of" handles UK-formal ordinal phrasing ("16th of February 2026")
  // that Paris MoU and several P&I clubs use in publication headers. Ordinals
  // are stripped above, so "16th of February 2026" reaches this regex as
  // "16 of February 2026".
  for (const m of s.matchAll(/\b(\d{1,2})(?:\s+of)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?\s+(\d{4})\b/gi)) {
    const iso = mkIso(+m[3], monthIdx(m[2]), +m[1]);
    if (iso) out.push(iso);
  }
  // Hyphen-separated with named month:  "20-Apr-2026" / "Apr-20-2026"
  for (const m of s.matchAll(/\b(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*-(\d{4})\b/gi)) {
    const iso = mkIso(+m[3], monthIdx(m[2]), +m[1]);
    if (iso) out.push(iso);
  }
  for (const m of s.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*-(\d{1,2})-(\d{4})\b/gi)) {
    const iso = mkIso(+m[3], monthIdx(m[1]), +m[2]);
    if (iso) out.push(iso);
  }
  // ISO YYYY-MM-DD (also accepts YYYY/MM/DD).
  for (const m of s.matchAll(/\b(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})\b/g)) {
    const iso = mkIso(+m[1], +m[2] - 1, +m[3]);
    if (iso) out.push(iso);
  }
  // DMY with dots/dashes (European convention):
  //   "20-04-2026" / "20.04.2026" / "2026.04.20" reverse handled above
  for (const m of s.matchAll(/\b(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})\b/g)) {
    const a = +m[1], b = +m[2], y = +m[3];
    // Disambiguate: if first > 12 it's definitely the day. Otherwise
    // default to DMY (dots/dashes are European convention).
    let day = a, month = b;
    if (a <= 12 && b > 12) { month = a; day = b; }
    const iso = mkIso(y, month - 1, day);
    if (iso) out.push(iso);
  }
  // Slash dates "4/20/2026" / "20/04/2026" — disambiguate by which
  // number is > 12.
  for (const m of s.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const a = +m[1], b = +m[2], y = +m[3];
    let month: number, day: number;
    if (a > 12 && b <= 12) { day = a; month = b; }       // unambiguous DMY
    else if (a <= 12 && b > 12) { month = a; day = b; }  // unambiguous MDY
    else { month = a; day = b; }                          // ambiguous → assume US MDY
    const iso = mkIso(y, month - 1, day);
    if (iso) out.push(iso);
  }
  // Month + year only, last-resort precision (e.g. "April 2026").
  // Resolved to the 1st of the month. We push these AFTER everything
  // else so a more-precise day match wins when both exist.
  for (const m of s.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/gi)) {
    const iso = mkIso(+m[2], monthIdx(m[1]), 1);
    if (iso) out.push(iso);
  }
  return out;
}

/** Returns the first non-future date inside `text`, or null. Used by
 *  the body bare-date and labelled-date steps. */
export function extractFirstDate(text: string): string | null {
  for (const iso of findAllDates(text)) {
    if (!isFuture(iso)) return iso;
  }
  return null;
}

// Best-of date selection — collect candidates from multiple extraction
// strategies, then pick the most trustworthy. Kept deliberately lightweight:
// confidence rank first, then a small ordered step preference for ties.
// Rejected candidates are returned so debug logs can show why others lost.

export type DateCandidate = {
  iso: string;
  source: 'original' | 'scraper_default';
  confidence: 'high' | 'medium' | 'low';
  /** Which extraction step produced this candidate. Free-form string used
   *  only for debug observability and tiebreak ordering — see STEP_RANK. */
  step: string;
  /** The raw text the date was pulled from. Optional, for debug logs. */
  raw?: string;
};

const CONFIDENCE_RANK: Record<DateCandidate['confidence'], number> = {
  high: 3, medium: 2, low: 1,
};

const SOURCE_RANK: Record<DateCandidate['source'], number> = {
  original: 2, scraper_default: 1,
};

// Step preference for tiebreaks. Lower number = preferred. The ordering
// encodes a few semantic intuitions:
//   - per-source curated selectors are most authoritative (manually picked)
//   - structured HTML metadata (meta tags, semantic <time>) ranks above
//     body-text extraction
//   - explicit "Published:" labels in the body rank above bare body dates
//   - URL-path dates rank below body candidates because URLs sometimes
//     reflect CMS routing / archive structure rather than publication
//   - time_element_loose (a <time> element without datePublished-related
//     markup or class) ranks BELOW even URL slug month-only — chrome
//     templates routinely inject "today" times into article scope, so
//     when there's any other candidate at the same confidence tier, the
//     non-time signal is preferred.
const STEP_RANK: Record<string, number> = {
  date_selector: 1,
  meta: 2,
  time_element_semantic: 3,
  body_labelled: 4,
  body_bare: 5,
  url_path_day: 6,
  url_slug_month: 7,
  time_element_loose: 8,
  title_fallback: 9,
};
const STEP_RANK_DEFAULT = 99;

export type DateResolution = {
  winner: DateCandidate;
  rejected: DateCandidate[];
};

/** Pick the best candidate from the list. Returns null if empty. Ordering:
 *  confidence DESC → source DESC → step preference ASC. */
export function pickBestDate(candidates: DateCandidate[]): DateResolution | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const cdiff = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (cdiff !== 0) return cdiff;
    const sdiff = SOURCE_RANK[b.source] - SOURCE_RANK[a.source];
    if (sdiff !== 0) return sdiff;
    return (STEP_RANK[a.step] ?? STEP_RANK_DEFAULT) - (STEP_RANK[b.step] ?? STEP_RANK_DEFAULT);
  });
  return { winner: sorted[0], rejected: sorted.slice(1) };
}
