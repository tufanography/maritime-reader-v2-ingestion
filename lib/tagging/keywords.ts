// Free heuristic keyword extraction for article cards. Looks for the
// "essence-capturing" terms — capitalized multi-word entity phrases
// (ports, regulations, companies) plus frequent non-stopword content
// words. No AI, no network calls.
//
// Returns up to 5 keywords ordered roughly by salience (title words
// outweigh body words; phrases outweigh single words).

const STOPWORDS = new Set<string>([
  // Articles, conjunctions, common verbs
  'the', 'and', 'or', 'but', 'nor', 'for', 'yet', 'so', 'a', 'an',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'done',
  'will', 'would', 'should', 'could', 'may', 'might', 'must', 'shall', 'can',
  // Prepositions
  'of', 'in', 'on', 'at', 'to', 'from', 'by', 'with', 'about',
  'as', 'into', 'onto', 'through', 'during', 'before', 'after',
  'above', 'below', 'between', 'against', 'over', 'under', 'across',
  // Pronouns / determiners
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'who', 'whom', 'whose',
  'which', 'what', 'where', 'when', 'why', 'how',
  // Common time / vague words
  'today', 'yesterday', 'tomorrow', 'now', 'then', 'soon', 'recent', 'recently',
  'said', 'says', 'reported', 'reports', 'announced', 'announces',
  'also', 'still', 'just', 'only', 'even', 'much', 'many',
  'more', 'most', 'less', 'least', 'some', 'any', 'all', 'every',
  'one', 'two', 'three', 'four', 'five', 'first', 'second', 'last', 'next',
  'new', 'old', 'good', 'bad', 'big', 'small', 'long', 'short', 'high', 'low',
  // Maritime generics — too vague to be useful keywords on a maritime site
  'ship', 'ships', 'vessel', 'vessels', 'maritime', 'shipping',
  'sea', 'seas', 'ocean', 'oceans', 'water', 'waters',
  'industry', 'company', 'companies', 'business', 'businesses', 'organisation',
  'news', 'article', 'articles', 'report', 'reports', 'release', 'releases',
  'circular', 'circulars', 'notice', 'notices', 'bulletin', 'bulletins',
  'update', 'updates', 'information', 'details',
  'club', 'clubs', 'member', 'members', 'association',
  'page', 'home', 'website',
]);

const NUMERIC = /^\d+$/;
const PHRASE_RE = /\b([A-Z][a-z]+(?:\s+(?:of\s+|the\s+)?[A-Z][a-z]+){1,3})\b/g;
const TOKEN_RE = /\b([A-Za-z][A-Za-z\-]+)\b/g;

function isStop(w: string): boolean {
  return STOPWORDS.has(w.toLowerCase());
}

/** Heuristic tokeniser → up to `max` salient keywords. Not perfect; aims
 *  to be cheap and right enough for a card-level visual aid. */
export function extractKeywords(args: { title: string; excerpt: string }, max = 5): string[] {
  const title = (args.title ?? '').slice(0, 500);
  const excerpt = (args.excerpt ?? '').slice(0, 4000);

  // Phrase pass: 2-4 consecutive capitalized words. Title hits weighed
  // 5x; body hits 1x. "Port of Hamburg" / "EU Sanctions" / "Lloyd's Register"
  // get captured here.
  const phraseScore = new Map<string, number>();
  for (const m of title.matchAll(PHRASE_RE)) {
    phraseScore.set(m[1], (phraseScore.get(m[1]) ?? 0) + 5);
  }
  for (const m of excerpt.matchAll(PHRASE_RE)) {
    phraseScore.set(m[1], (phraseScore.get(m[1]) ?? 0) + 1);
  }

  // Single-word pass:
  //   - title words >=4 chars, not stopwords → 5x
  //   - body capitalized words >=4 chars, not stopwords → 1x (proxy
  //     for "topic-bearing" content vs. ordinary verbs/adjectives)
  const wordScore = new Map<string, number>();
  for (const m of title.matchAll(TOKEN_RE)) {
    const w = m[1];
    if (w.length < 4 || isStop(w) || NUMERIC.test(w)) continue;
    wordScore.set(w, (wordScore.get(w) ?? 0) + 5);
  }
  for (const m of excerpt.matchAll(TOKEN_RE)) {
    const w = m[1];
    if (w.length < 4 || isStop(w) || NUMERIC.test(w)) continue;
    if (w[0] !== w[0].toUpperCase()) continue;
    wordScore.set(w, (wordScore.get(w) ?? 0) + 1);
  }

  // Merge: drop single-word entries already covered by a higher-scoring
  // phrase (e.g. don't emit both "Hamburg" and "Port of Hamburg").
  const candidates: { text: string; score: number }[] = [];
  const phraseLowerSet = new Set([...phraseScore.keys()].map((p) => p.toLowerCase()));
  for (const [text, score] of phraseScore) candidates.push({ text, score });
  for (const [text, score] of wordScore) {
    const lc = text.toLowerCase();
    let coveredByPhrase = false;
    for (const p of phraseLowerSet) {
      if (p.split(/\s+/).includes(lc)) { coveredByPhrase = true; break; }
    }
    if (coveredByPhrase) continue;
    candidates.push({ text, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const key = c.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.text);
    if (out.length >= max) break;
  }
  return out;
}
