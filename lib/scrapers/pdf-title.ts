// PDF TITLE SELECTION
//
// Neither candidate is reliable on its own. MEASURED on the live DB 2026-07-27:
// 2,549 of 3,979 PDF rows carry a REPEATED title — a template name, not a
// headline. Worst offenders:
//     596x  Panama Canal   "May 4, 2007"
//     131x  Britannia      "master template"
//      64x  Steamship      "London IGPI Circular"
//      43x  Britannia      "November 2008"
//      37x  Britannia      "Layout 1"
//      31x  London P&I     "23 November 2011"
//      26x  Britannia      "Britannia steamship.qxd"
//      13x  Britannia      "abc"
// Authors rarely set a PDF's Title field, so it keeps whatever the design file
// was named — and every circular exported from that file inherits it.
//
// Anchor text is usually the real headline: American P&I's 841 anchors all read
// "Circular No. 16/26 - The American Club's Annual Meeting of the Members".
// But Britannia alternates real headlines ("CREW WATCH – JUNE 2026") with a bare
// "Download pdf", so anchor text alone is not safe either.
//
// Therefore: run BOTH through the same junk test, prefer the anchor (human
// written), fall back to PDF metadata, then to the document's opening sentence.
// If nothing survives, return null — the caller must DROP and LOG the item
// rather than publish "Download pdf" as a headline.

/** Link/button labels that are navigation, not a headline. */
const GENERIC_LABEL =
  /^(download(\s+(the\s+)?(pdf|file|document|here))?|click\s+here|read\s+(more|on)|view(\s+pdf)?|open|pdf|more|link|here|continue)\.?$/i;

/** Design-tool template names left behind in the Title field. */
const TEMPLATE_NAME =
  /^(master\s*template|.*\bletter\s+template|layout\s*\d*|untitled(\s*\d*)?|document\s*\d*|abc|test|draft|final|print|copy)$/i;

/** Source-file artefacts: "Britannia steamship.qxd", "circular.indd".
 *  A title that ends in a design/office file extension IS the file name — the
 *  extension is not noise to be trimmed off, it is the proof. Reject outright;
 *  trimming it would turn "Britannia steamship.qxd" into the plausible-looking
 *  but still wrong "Britannia steamship". */
const FILE_ARTEFACT = /\.(qxd|indd|docx?|pdf|ai|psd|cdr|pub|pmd)\s*$/i;

/** Export wrappers that hide an otherwise fine title. */
const EXPORT_PREFIX = /^(microsoft\s+word|adobe\s+(acrobat|indesign)|word)\s*[-–—:]\s*/i;

/** A bare date is a publication date, not a title ("May 4, 2007", "Dec 2020"). */
const DATE_ONLY =
  /^\s*(\d{1,2}[\s.\-/]+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s.,\-/]*(\d{1,2})?[,\s]*\d{2,4}\s*$/i;

const NUMERIC_ONLY = /^[\d\s.,\-/_]+$/;

/** Collapse whitespace and unwrap an export prefix. Deliberately does NOT strip
 *  file extensions — see FILE_ARTEFACT. */
export function tidyTitle(s: string | null | undefined): string {
  return (s ?? '').replace(EXPORT_PREFIX, '').replace(/\s+/g, ' ').trim();
}

/** Would this string mislead a reader if shown as a headline? */
export function isUsableTitle(raw: string | null | undefined): boolean {
  const s = tidyTitle(raw);
  if (s.length < 12) return false;        // "abc", "Layout 1", "PDF"
  if (FILE_ARTEFACT.test(s)) return false;
  if (!/[a-z]/i.test(s)) return false;    // no letters at all
  if (GENERIC_LABEL.test(s)) return false;
  if (TEMPLATE_NAME.test(s)) return false;
  if (DATE_ONLY.test(s)) return false;
  if (NUMERIC_ONLY.test(s)) return false;
  // Needs at least three words — "Crew Watch", "Condition Survey Form" style
  // section labels repeat across dozens of documents and identify nothing.
  if (s.split(/\s+/).length < 3) return false;
  return true;
}

/** Opening sentence of the document — last resort when both candidates fail.
 *  Takes the first sentence up to 200 chars; if the document opens with a very
 *  long sentence (common in circulars: one clause runs past 120 chars before the
 *  first full stop), fall back to the first ~14 words so we still get something
 *  descriptive rather than nothing. */
function openingSentence(body: string | null | undefined): string {
  const s = (body ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 15) return '';
  const sentence = s.slice(0, 400).match(/^(.{15,200}?)(?:[.!?]\s|$)/);
  if (sentence && sentence[1].trim().length >= 15) return sentence[1].trim();
  const words = s.split(' ').slice(0, 14).join(' ');
  return words.length >= 15 ? words : '';
}

/** Pick the most trustworthy headline available for a PDF item.
 *  Returns null when every candidate is junk — the caller must drop and LOG it,
 *  never publish the junk. */
export function pickPdfTitle(
  pdfTitle: string | null | undefined,
  linkText: string | null | undefined,
  body?: string | null,
): string | null {
  const link = tidyTitle(linkText);
  const meta = tidyTitle(pdfTitle);
  if (isUsableTitle(link)) return link;   // anchor text: human-written headline
  if (isUsableTitle(meta)) return meta;   // PDF metadata: often a template name
  const opening = openingSentence(body);
  if (isUsableTitle(opening)) return opening;
  return null;
}
