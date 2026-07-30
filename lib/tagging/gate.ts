// Quality gate for the text we run the deterministic keyword extractor on.
//
// Context: WordPress REST / HTML sources often hand us BOILERPLATE instead of
// article prose — "You are using an outdated browser…", cookie/subscribe walls,
// nav chrome ("Emergency Contact Club Rules Home Latest updates"). Running the
// keyword extractor on that produces garbage content_terms which then pollute
// search. This gate is the deterministic, network-free, AI-free filter that
// decides whether a candidate text is worth extracting from.
//
// It is intentionally CONSERVATIVE and cheap (regex + word overlap). Same input
// → same verdict. Used by rss.ts to pick the FIRST candidate (content, then
// excerpt) that passes; if none pass, text_source='none' and NO extraction runs.

/** First-150-char boilerplate signatures. These are start-of-page chrome that
 *  betrays a non-article capture (browser nag, cookie/login wall, nav menu).
 *  Matched case-insensitively against the first 150 chars only — real articles
 *  don't open with these. */
const BOILERPLATE_PATTERNS: RegExp[] = [
  /you are using/i,
  /outdated browser/i,
  /upgrade to a modern/i,
  /enable javascript/i,
  /enable cookies/i,
  /please subscribe/i,
  /latest updates/i,
  /emergency contact/i,
  /skip to content/i,
  /cookie policy/i,
  /sign in/i,
  /log in/i,
  /main menu/i,
  /toggle navigation/i,
  /^home\b/i,
  /^menu\b/i,
  /all rights reserved/i,
  /©/,
];

export type GateResult = { ok: true } | { ok: false; reason: 'too-short' | 'boilerplate' | 'no-title-overlap' };

// ── content_terms quality control ──────────────────────────────────────────
// The deterministic extractor (reused, not modified — it also fills `keywords`)
// scores title phrases highest, so its raw output leads with SLICES OF THE TITLE
// ("Russia Strikes Liberian", "Iran Rejects Oman") and leaks single boilerplate
// words (Image, According, July, Tuesday). Those are noise on a search page: the
// title is already indexed, and stopwords match everything. filterContentTerms()
// keeps ONLY genuine proper nouns / acronyms that are NOT already in the title.

/** Sibling of BOILERPLATE_PATTERNS: single words that must never be a term. */
export const TERM_STOPLIST = new Set<string>([
  // page chrome / widgets
  'image', 'images', 'credit', 'credits', 'photo', 'photos', 'file', 'caption',
  'related', 'posts', 'post', 'categories', 'category', 'tags', 'tag', 'read',
  'more', 'share', 'comment', 'comments', 'subscribe', 'newsletter', 'cookie',
  'cookies', 'privacy', 'home', 'menu', 'features', 'feature', 'advertisement',
  'sponsored', 'video', 'watch', 'listen', 'print', 'author', 'byline', 'published',
  'update', 'updates', 'source', 'sources', 'newsroom',
  // wire agencies / generic attribution
  'reuters', 'bloomberg', 'getty', 'afp', 'associated', 'press',
  // vague connective / filler words that slip through as "Capitalized"
  'according', 'everyone', 'commercial', 'meanwhile', 'however', 'additionally',
  'the', 'this', 'that', 'these', 'those', 'there', 'here', 'today', 'yesterday',
  'tomorrow', 'earlier', 'later', 'recently',
  // months
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  // days
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // social platforms / UI (leak in as capitalized single words)
  'youtube', 'linkedin', 'twitter', 'facebook', 'instagram', 'tiktok', 'whatsapp',
  'telegram', 'screengrab', 'staff', 'spokesperson', 'statement',
]);

// Reject when the term's FIRST word is one of these — a sentence-initial function
// word or a bare generic noun signals a fragment, not a proper noun ("If Muscat",
// "As Ukraine", "Speaking", "Officials", "Built"). Only the leading word is checked
// so a legit multi-word org keeping a generic word later still survives.
const TERM_LEADING_STOP = new Set<string>([
  'if', 'as', 'when', 'while', 'after', 'before', 'instead', 'given', 'speaking',
  'meanwhile', 'however', 'also', 'unlike', 'despite', 'during', 'since', 'though',
  'although', 'officials', 'official', 'authorities', 'authority', 'general', 'built',
  'added', 'earlier', 'later', 'overall',
  'by',   // drops wire-service byline fragments: "By Marwa Rashad", "By Jonathan Saul"
]);

const TERM_CONNECTORS = new Set<string>(['of', 'the', 'and', 'for', 'de', 'del', 'la', 'le', 'du', 'von', 'van', '&']);

/** A term is acceptable iff it is a PROPER NOUN (1–3 capitalized words, optional
 *  lowercase connectors) or an ABBREVIATION/ACRONYM (a single token carrying ≥2
 *  uppercase letters, e.g. IMO, P&I, MARPOL, RIMPAC, EnBW, CO2). Everything else
 *  — sentence fragments, lowercase words, 4+‑word noun piles — is rejected. */
export function isProperNounOrAcronym(term: string): boolean {
  const words = term.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  if (words.length === 1) {
    const w = words[0];
    const uppers = (w.match(/[A-Z]/g) ?? []).length;
    if (uppers >= 2 && /^[A-Za-z0-9][A-Za-z0-9&.\-]*$/.test(w)) return true;  // acronym: IMO, P&I, EnBW, RIMPAC, CO2
    if (/^[A-Z][a-z]{2,}$/.test(w)) return true;                              // single proper noun: Vestas, Odesa
    return false;
  }
  let capCount = 0;
  for (const w of words) {
    if (TERM_CONNECTORS.has(w.toLowerCase())) continue;
    if (!/^[A-Z]/.test(w)) return false;   // every non-connector word must be capitalized
    capCount++;
  }
  return capCount >= 1 && capCount <= 3;
}

/** Filter the extractor's raw output down to quality content_terms:
 *   1. drop any term whose word-sequence already appears in the title,
 *   2. drop any term containing a TERM_STOPLIST word,
 *   3. keep only proper nouns / acronyms (isProperNounOrAcronym),
 *   4. dedupe (case-insensitive), preserve order. */
export function filterContentTerms(title: string, terms: string[]): string[] {
  const titleNorm = ' ' + (title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.some((w) => TERM_STOPLIST.has(w.toLowerCase().replace(/[^a-z0-9]/gi, '')))) continue;
    if (TERM_LEADING_STOP.has(words[0].toLowerCase().replace(/[^a-z0-9]/gi, ''))) continue;
    const termNorm = key.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (termNorm && titleNorm.includes(' ' + termNorm + ' ')) continue;   // title slice → already indexed
    if (!isProperNounOrAcronym(t)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Words in the title that are "content-bearing" for the overlap test:
 *  longer than 3 chars, alphabetic. Punctuation stripped. */
function titleContentWords(title: string): string[] {
  return (title.match(/[A-Za-z][A-Za-z0-9'-]*/g) ?? [])
    .filter((w) => w.length > 3);
}

/**
 * Decide whether `text` is worth extracting keywords from, given the article
 * `title`. Rejection order (first failing rule wins):
 *   1. length < 25            → 'too-short'
 *   2. boilerplate in 0..150  → 'boilerplate'
 *   3. title has 3+ content words (>3 chars) and NONE appear in text
 *                             → 'no-title-overlap'
 */
export function gateText(title: string, text: string): GateResult {
  const t = (text ?? '').trim();

  // 1. too short
  if (t.length < 25) return { ok: false, reason: 'too-short' };

  // 2. boilerplate signature in the first 150 chars
  const head = t.slice(0, 150);
  for (const re of BOILERPLATE_PATTERNS) {
    if (re.test(head)) return { ok: false, reason: 'boilerplate' };
  }

  // 3. title/text overlap — only applies when the title has 3+ content words.
  //    If none of them appear in the text, the text isn't about the article
  //    (classic symptom: excerpt is a generic sidebar / cookie notice while the
  //    title is a specific circular).
  const words = titleContentWords(title ?? '');
  if (words.length >= 3) {
    const lc = t.toLowerCase();
    const anyOverlap = words.some((w) => lc.includes(w.toLowerCase()));
    if (!anyOverlap) return { ok: false, reason: 'no-title-overlap' };
  }

  return { ok: true };
}
