// Fast spam / off-topic detection at scrape time.
//
// Architectural note: this is the *moderation* layer, distinct from
// semantic intelligence (segments / themes / quality). Moderation runs
// inline on every insert — its job is to keep obvious garbage from
// flashing on the home feed before async AI review reaches it. It
// must be:
//
//   - cheap (regex / keyword counts, no network, no AI)
//   - conservative (false positives are MUCH worse than false
//     negatives: hiding a real maritime article is a worse failure
//     than briefly showing a spam one)
//   - deterministic (same input → same verdict, no flakiness)
//
// AI semantic review can later downgrade a 'pending' article to
// 'hidden' if it sees subtler spam — moderation only catches the
// loud cases.

// Maritime positives — when 2+ of these appear in title+excerpt, the
// article is almost certainly maritime regardless of any spam hint.
// List intentionally short; broad terms only. Adding specific operator
// names or vessel-class jargon would push it over from "moderation"
// into "semantic classification".
const MARITIME_KEYWORDS = [
  /\bship(s|ping|owner|builder|yard|broker|management)?\b/i,
  /\bvessel(s)?\b/i,
  /\b(port|terminal)s?\b/i,
  /\bcontainer(s|ship|ised|ized)?\b/i,
  /\btanker(s)?\b/i,
  /\bcargo(es)?\b/i,
  /\bfreight\b/i,
  /\bbulk\s*carrier(s)?\b/i,
  /\bTEU(s)?\b/,
  /\b(carrier|line|operator)s?\b.{0,40}\b(ocean|maritime|sea|liner|shipping)\b/i,
  /\b(charter(ing)?|charterer|charterparty)\b/i,
  /\bP&I\b/,
  /\bIMO\b/,
  /\bMOU\b/,
  /\bMARPOL\b/,
  /\bSOLAS\b/,
  /\bPSC\b/,
  /\bIACS\b/,
  /\b(LNG|LPG)\s+(carrier|terminal|fleet|bunker)/i,
  /\bcrude\s+(tanker|carrier|oil)\b/i,
  /\boffshore\s+(wind|vessel|installation|oil|gas)/i,
  /\bcruise\s+(ship|line|industry)/i,
  /\bclass(ification)?\s+societ(y|ies)\b/i,
];

// Obvious off-topic patterns. Each entry below would block an article
// only if it appears AND no strong maritime signal counters it (see
// the algorithm below). Keep this list specific — generic phrases
// like "tips for" or "how to" trigger far too many false positives.
const SPAM_PATTERNS = [
  // Gaming
  /\bthrone\s+and\s+liberty\b/i,
  /\bvideo\s+game\b/i,
  /\bgaming\s+(guide|build|playstyle|tips)\b/i,
  /\b(weapon|skill|build|loadout)s?\s+(guide|tier|meta)\b/i,
  // Dating / relationships
  /\b(finding|find)\s+love\b/i,
  /\bafter\s+divorce\b/i,
  /\bdating\s+(again|tips|advice)\b/i,
  /\brelationship\s+advice\b/i,
  // Lifestyle car content
  /\bluxury\s+car\s+rental\b/i,
  /\b(VIP|exotic)\s+car(s)?\b/i,
  /\b(BMW|Mercedes|Ferrari|Rolls-?Royce|Audi)\b.{0,40}\b(rent|rental|dubai)\b/i,
  // Generic SEO marketing
  /\btwitter\s+(marketing|impact|engagement)\b/i,
  /\btiktok\s+(strategy|marketing)\b/i,
  /\bsocial\s+media\s+(marketing|tips)\b/i,
  /\bbrand\s+marketing\s+and\s+customer\s+engagement\b/i,
  // Generic office furniture / desk content
  /\brotating\s+file\s+cabinet\b/i,
  /\boffice\s+(furniture|design|chair|desk)\b/i,
  /\bergonomic\s+(chair|desk)\b/i,
  // Generic business advice (only when paired with no maritime context)
  /\bprofessional\s+development\s+paths?\s+for\s+marketers\b/i,
  /\bavailability\s+tracker\b/i,
  /\bsupply\s+chain\s+visibility\s+software\b/i,
];

export type ModerationVerdict =
  | { decision: 'pass'; reason: 'maritime'; maritimeHits: number }
  | { decision: 'pass'; reason: 'unknown'; maritimeHits: number }       // no clear signal either way; default permissive
  | { decision: 'hide'; reason: 'spam'; matchedPattern: string };

/** Runs the moderation check on a title + excerpt pair. The result
 *  drives `articles.content_quality` at insert time:
 *
 *    pass + trusted source     → 'visible' (shown immediately)
 *    pass + aggregator source  → 'pending' (visible, semantic review later)
 *    hide                      → 'hidden'  (never visible)
 *
 *  The caller (orchestrator) decides which content_quality to apply
 *  based on source.trust_level; this function only returns the
 *  moderation verdict. */
export function moderate(title: string, excerpt: string): ModerationVerdict {
  const text = `${title}\n${excerpt}`;

  // Maritime keyword count — used both for the pass signal and to
  // override a spam pattern hit when the article is clearly on-topic.
  let maritimeHits = 0;
  for (const re of MARITIME_KEYWORDS) {
    if (re.test(text)) {
      maritimeHits++;
      if (maritimeHits >= 2) break;   // 2+ is enough
    }
  }
  const looksMaritime = maritimeHits >= 2;

  // Spam patterns — only fire if maritime signal is weak. A real
  // maritime article that happens to mention "luxury car" in passing
  // shouldn't get hidden.
  if (!looksMaritime) {
    for (const re of SPAM_PATTERNS) {
      const m = re.exec(text);
      if (m) {
        return { decision: 'hide', reason: 'spam', matchedPattern: m[0].slice(0, 50) };
      }
    }
  }

  if (looksMaritime) {
    return { decision: 'pass', reason: 'maritime', maritimeHits };
  }
  // No spam hit AND no strong maritime signal — default to permissive
  // pass. AI semantic review will figure it out.
  return { decision: 'pass', reason: 'unknown', maritimeHits };
}
