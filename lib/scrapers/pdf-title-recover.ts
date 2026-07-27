// RECOVERING A TITLE FROM THE DOCUMENT BODY
//
// Used in two places, deliberately the same code:
//   - live scraping, as the last fallback in pickPdfTitle
//   - the one-off backfill over rows whose stored title is page furniture
//
// Deterministic and free — no model calls. Circular publishers are extremely
// consistent in their layout, so the subject line can be lifted directly.
// MEASURED body shapes 2026-07-27:
//
//   Panama Canal   "…Panama Canal Authority Vice Presidency for Operations
//                   Advisory To Shipping No. A-16-2026 May 18, 2026
//                   TO: All Shipping Agents, Owners, and Operators
//                   SUBJECT: Update to Notice to Shipping N-7 – Auction Process…"
//   American P&I   "MARCH 31, 2009 CIRCULAR NO. 10/09 TO MEMBERS OF THE
//                   ASSOCIATION Dear Member: OIL COMPANIES INTERNATIONAL MARINE
//                   FORUM (OCIMF): PIRACY – THE EAST AFRICA/SOMALIA SITUATION…"
//   Steamship      "RA74 - Containerised Cargo – Stowage and Securing Introduction…"
//   London P&I     legal boilerplate first ("The London P&I Club is the trading
//                   name of…"), the subject sits after "Dear Sir or Madam".
//
// A PDF text layer often runs columns together, so labels can arrive detached
// from their values: "TO : SUBJECT : All Shipping Agents, Owners, and Operators
// Monthly Canal Operations Summary – April 2026". The recipient phrase is a known
// constant, so it can be stripped to leave the subject behind.

import { isUsableTitle } from './pdf-title';

/** Recipient boilerplate that can be glued in front of a subject line. */
const RECIPIENT_PHRASES = [
  /^All Shipping Agents,?\s*Owners,?\s*and Operators\b[:,\s]*/i,
  /^(To\s+)?(All\s+)?Members?\s+of\s+the\s+Association\b[:,\s]*/i,
  /^(To\s+)?All\s+(Class\s+\d+\s+)?\(?[A-Za-z\s]{0,20}\)?\s*Members\b[:,\s]*/i,
  /^Dear\s+(Sirs?|Madam|Member|Sir\s+or\s+Madam)\b[:,\s]*/i,
];

/** Where a subject line stops and the letter's body starts. The text layer has
 *  already been collapsed to single spaces, so there is no blank-line boundary
 *  left to cut on — these opening phrases are the reliable signal instead. */
const BODY_STARTS = new RegExp(
  '\\s(?:' + [
    'The\\s+[A-Z]', 'This\\s+(?:Circular|Advisory|Notice|Bulletin)', 'Reference\\s+is\\s+made',
    'Please\\s+(?:note|be\\s+advised)', 'Members?\\s+(?:are|should|will)', 'Effective\\s+',
    'Beginning\\s+at', 'Further\\s+to', 'It\\s+(?:is|has)', 'We\\s+(?:are|have|write)',
    'Your\\s+Managers', 'At\\s+the\\s+', 'In\\s+(?:accordance|light|view)', 'Following\\s+',
    '\\d{1,2}\\s*[.)]\\s*[A-Z]',
  ].join('|') + ')',
);

/** Trailing junk left by the text layer: page numbers, list markers, dot leaders. */
function trimTail(s: string): string {
  let out = s
    .replace(/\s*\.{3,}.*$/, '')          // "…Transit Pilot Force ........"
    .replace(/\s+\d{1,3}$/, '')           // trailing bare page number
    .replace(/\s*[|·•]\s*\d{1,3}$/, '');
  const cut = out.search(BODY_STARTS);
  if (cut > 12) out = out.slice(0, cut);  // stop where the letter body begins
  return out.replace(/[\s.,;:–—-]+$/, '').trim();
}

/** Run of capitals used as a subject heading — the strongest boundary available
 *  in American and London circulars: "Dear Member: OIL COMPANIES INTERNATIONAL
 *  MARINE FORUM (OCIMF): PIRACY … ATTACKS OCIMF, in conjunction with…" — the
 *  heading ends at the first ordinary lower-case word. */
function capitalRun(s: string): string {
  const m = s.match(/^((?:[A-Z0-9][A-Z0-9''&()/.,:;\-–—\s]{2,}?))(?=\s+[a-z]|$)/);
  if (!m) return '';
  return trimTail(m[1].replace(/\s+/g, ' ').trim());
}

function clean(s: string): string {
  let out = s.replace(/\s+/g, ' ').trim();
  for (const p of RECIPIENT_PHRASES) out = out.replace(p, '').trim();
  return trimTail(out);
}

type Recovered = { title: string; how: string } | null;

const ok = (title: string, how: string): Recovered =>
  isUsableTitle(title) ? { title: title.slice(0, 160), how } : null;

/** Panama Canal advisories: "Advisory A-16-2026: <subject>". The advisory number
 *  is a stable public identifier, so it leads the title. */
function panama(s: string): Recovered {
  const no = s.match(/Advisor(?:y|ies)\s+(?:To\s+)?Shipping\s+No\.?\s*([A-Z]-\d{1,3}-\d{4})/i);
  const subj = s.match(/\bSUBJECT\s*:\s+(.{10,180}?)(?:\.\s|$)/i);
  if (!subj) return null;
  const body = clean(subj[1]);
  if (!body) return null;
  const title = no ? `Advisory ${no[1].toUpperCase()}: ${body}` : body;
  return ok(title, 'panama-subject');
}

/** American P&I circulars: "Circular 10/09: <SUBJECT IN CAPS>". The subject is the
 *  run of capitals right after "Dear Member:". */
function american(s: string): Recovered {
  const no = s.match(/CIRCULAR\s+NO\.?\s*([\d]{1,3}\/[\d]{2,4})/i);
  const after = s.match(/Dear\s+Members?\s*:\s*(.{10,300})/i);
  if (!after) return null;
  const body = capitalRun(after[1]) || clean(after[1]);
  if (!body) return null;
  const title = no ? `Circular ${no[1]}: ${body}` : body;
  return ok(title, 'american-circular');
}

/** Steamship risk alerts: "RA74 - Containerised Cargo – Stowage and Securing". */
function steamship(s: string): Recovered {
  const ra = s.match(/\b(RA\s?\d{1,3})\s*[-–—]\s*(.{10,140}?)(?:\s{2,}|\.\s|Introduction|Contents|$)/i);
  if (ra) {
    const body = clean(ra[2]);
    if (body) return ok(`${ra[1].replace(/\s+/g, '')} – ${body}`, 'steamship-ra');
  }
  // Bulletins whose first line is boilerplate: take the text after the contact block.
  const afterBoiler = s.match(/loss-prevention\/?\s+(.{10,140}?)(?:\s{2,}|\.\s|Contents|$)/i);
  if (afterBoiler) {
    const body = clean(afterBoiler[1]);
    if (body) return ok(body, 'steamship-after-boilerplate');
  }
  return null;
}

/** London P&I circulars: legal boilerplate leads, the subject follows the
 *  salutation. Also handles "TO ALL CLASS 7 (WAR RISKS) MEMBERS Dear Sir or
 *  Madam WAR RISKS RENEWALS – POLICY YEAR 2026/27". */
function london(s: string): Recovered {
  const after = s.match(/Dear\s+(?:Sirs?(?:\s+or\s+Madam)?|Madam|Members?)\b[:,\s]+(.{10,300})/i);
  if (!after) return null;
  const body = capitalRun(after[1]) || clean(after[1]);
  if (!body) return null;
  return ok(body, 'london-salutation');
}

/** Generic fallbacks for sources without a tuned parser. */
function generic(s: string): Recovered {
  const subj = s.match(/\bSUBJECT\s*:\s+(.{10,180}?)(?:\.\s|$)/i);
  if (subj) { const b = clean(subj[1]); if (b) { const r = ok(b, 'subject'); if (r) return r; } }
  const re = s.match(/\bRe\s*:\s+(.{10,180}?)(?:\.\s|$)/i);
  if (re) { const b = clean(re[1]); if (b) { const r = ok(b, 're'); if (r) return r; } }
  const dear = s.match(/Dear\s+(?:Sirs?(?:\s+or\s+Madam)?|Madam|Members?)\b[:,\s]+(.{10,300})/i);
  if (dear) { const b = capitalRun(dear[1]) || clean(dear[1]); if (b) { const r = ok(b, 'salutation'); if (r) return r; } }
  return null;
}

const TUNED: Record<string, (s: string) => Recovered> = {
  'Panama Canal Authority': panama,
  'American P&I Club': american,
  'Steamship Mutual': steamship,
  'London P&I Club': london,
};

/** Recover a headline from the document text. Returns null when nothing
 *  trustworthy is found — the caller must keep the existing title / drop the
 *  item, never invent one. */
export function recoverPdfTitle(body: string | null | undefined, sourceName?: string): Recovered {
  const s = (body ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 40) return null;
  const tuned = sourceName ? TUNED[sourceName] : undefined;
  return (tuned ? tuned(s) : null) ?? generic(s);
}
