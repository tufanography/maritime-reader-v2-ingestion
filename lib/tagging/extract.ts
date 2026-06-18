// Tag extraction with differentiated scoring + phrase proximity.
//
// Scoring (ChatGPT-suggested, refined):
//   URL slug match                        +10
//   Title — multi-word phrase match        +6
//   Title — single keyword match           +4
//   Excerpt — multi-word phrase match      +2
//   Excerpt — single keyword match         +1
//   ──────────────────────────────────────────
//   threshold                              ≥ 4 (tag persisted)
//
// Multi-word phrase rules:
//   In TITLE  — words must be within 35 characters of each other.
//   In EXCERPT — words must be within 90 characters of each other.
// This blocks the common false positive where "grain" and "cargo" each
// appear far apart in a YouTube footer's reading list and falsely
// pull the "grain cargo" tag onto a Black Sea tanker video.
//
// Multiple variants per tag (name + aliases) contribute AT MOST ONE
// score per area — phrase wins over keyword. So a tag like
// "Russia sanctions" can match either the phrase OR a single-word
// alias if one is defined, but not double-count.

import type { SupabaseClient } from '@supabase/supabase-js';
import { tagsFromUrl } from './url-rules';
import { suppressedSlugs } from './false-contexts';

type TagRow = {
  id: string;
  type: string;
  slug: string;
  name: string;
  aliases: string[];
  requires_cooccurrence?: string[] | null;
};

const CACHE_TTL_MS = 5 * 60_000;

// Scoring constants — single source of truth so the audit dashboard
// can show the same numbers a re-tag job uses.
export const TAG_SCORE = {
  url: 10,
  title_phrase: 6,
  title_keyword: 4,
  excerpt_phrase: 2,
  excerpt_keyword: 1,
} as const;
export const TAG_THRESHOLD = 4;
export const PROXIMITY_TITLE = 35;
export const PROXIMITY_EXCERPT = 90;

// Acronym slugs we want matched case-sensitively to avoid e.g.
// "abs" inside "absorption" or "MSc" matching the carrier.
const CASE_SENSITIVE_SLUGS = new Set<string>([
  'one-line', 'msc', 'abs', 'cii', 'eedi', 'eexi', 'ais', 'imo',
  'bimco', 'ics-shipping', 'emsa', 'us-coast-guard',
  'eu-ets', 'fueleu-maritime', 'lloyds-register', 'classnk',
  'rina-class', 'ccs-class', 'bureau-veritas',
]);

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type CompiledVariant = {
  raw: string;
  words: string[];
  isPhrase: boolean;
};

type CompiledTag = {
  id: string;
  slug: string;
  variants: CompiledVariant[];
  caseSensitive: boolean;
  cooccur: string[] | null;     // any of these terms must also appear
};

type TagCache = {
  tags: CompiledTag[];
  loadedAt: number;
};

let cacheState: TagCache | null = null;

async function loadTags(sb: SupabaseClient): Promise<TagCache> {
  if (cacheState && Date.now() - cacheState.loadedAt < CACHE_TTL_MS) {
    return cacheState;
  }
  // requires_cooccurrence: text[] (or null). Fail-soft if the column
  // hasn't been added yet — we just treat it as no co-occurrence rule.
  const { data } = await sb.from('tags').select('id, type, slug, name, aliases, requires_cooccurrence');
  const rows = (data ?? []) as TagRow[];

  const tags: CompiledTag[] = rows.map((t) => {
    const variantStrings = [t.name, ...(t.aliases ?? [])].map((s) => s.trim()).filter(Boolean);
    const variants: CompiledVariant[] = variantStrings.map((raw) => {
      const words = raw.split(/\s+/).filter(Boolean);
      return { raw, words, isPhrase: words.length >= 2 };
    });
    return {
      id: t.id,
      slug: t.slug,
      variants,
      caseSensitive: CASE_SENSITIVE_SLUGS.has(t.slug),
      cooccur: (t.requires_cooccurrence && t.requires_cooccurrence.length > 0) ? t.requires_cooccurrence : null,
    };
  });
  cacheState = { tags, loadedAt: Date.now() };
  return cacheState;
}

export function clearTagCache() { cacheState = null; }

/** Word-bounded substring match. Whole-word, no false positives like
 *  "grain" hitting "engrained". */
function keywordMatches(term: string, text: string, caseSensitive: boolean): boolean {
  const flags = caseSensitive ? '' : 'i';
  const re = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegex(term)}(?=$|[^A-Za-z0-9])`, flags);
  return re.test(text);
}

/** Multi-word phrase match with proximity tolerance:
 *  - First tries exact phrase (any whitespace between words).
 *  - For 2-word phrases, also accepts the two words within `proximity`
 *    chars of each other, in either order. Blocks the cross-page
 *    false positive ("grain" in headline, "cargo" 500 chars later
 *    in a footer) without losing legitimate matches ("massive grain
 *    cargo of wheat", "the cargo of grain"). */
function phraseMatches(words: string[], text: string, proximity: number, caseSensitive: boolean): boolean {
  if (words.length < 2) return false;
  const flags = caseSensitive ? '' : 'i';

  // Exact phrase (any whitespace) — works for any number of words.
  const exact = new RegExp(
    `(?:^|[^A-Za-z0-9])${words.map(escapeRegex).join('\\s+')}(?=$|[^A-Za-z0-9])`,
    flags,
  );
  if (exact.test(text)) return true;

  // Proximity only enabled for 2-word phrases. 3+ word phrases must
  // match exactly — proximity-on-three becomes noisy fast.
  if (words.length !== 2) return false;
  const a = escapeRegex(words[0]);
  const b = escapeRegex(words[1]);
  const fwd = new RegExp(`(?:^|[^A-Za-z0-9])${a}(?=$|[^A-Za-z0-9]).{0,${proximity}}(?:^|[^A-Za-z0-9])${b}(?=$|[^A-Za-z0-9])`, flags);
  const rev = new RegExp(`(?:^|[^A-Za-z0-9])${b}(?=$|[^A-Za-z0-9]).{0,${proximity}}(?:^|[^A-Za-z0-9])${a}(?=$|[^A-Za-z0-9])`, flags);
  return fwd.test(text) || rev.test(text);
}

/** Best score this tag can earn from one area's text (title or excerpt).
 *  Phrase variants get checked first; the first phrase hit wins and
 *  short-circuits. Otherwise any keyword variant gives the keyword
 *  score. Returns 0 if nothing matched. */
function scoreInArea(
  tag: CompiledTag,
  text: string,
  proximity: number,
  phraseScore: number,
  keywordScore: number,
): number {
  for (const v of tag.variants) {
    if (v.isPhrase && phraseMatches(v.words, text, proximity, tag.caseSensitive)) {
      return phraseScore;
    }
  }
  for (const v of tag.variants) {
    if (!v.isPhrase && keywordMatches(v.raw, text, tag.caseSensitive)) {
      return keywordScore;
    }
  }
  return 0;
}

/** Detail returned alongside the tag id — useful for the audit
 *  dashboard, debugging, and the re-tag script's diff output. */
export type TagMatchDetail = {
  id: string;
  slug: string;
  score: number;
  contributions: { area: 'url' | 'title' | 'excerpt'; score: number }[];
  blocked?: string;  // reason this tag was filtered out (cooccurrence/blocklist)
};

export async function extractTagDetails(args: {
  sb: SupabaseClient;
  title: string;
  excerpt: string;
  url?: string;
}): Promise<TagMatchDetail[]> {
  const { tags } = await loadTags(args.sb);
  if (tags.length === 0) return [];

  // URL slugs computed once per article, looked up per tag.
  const urlSlugs = args.url ? new Set(tagsFromUrl(args.url)) : new Set<string>();
  const titleText = args.title;
  const excerptText = args.excerpt;
  // False-context suppression — title-only check for phrases that
  // betray a different topic ("class action lawsuit" → not class
  // society). Returns the slugs we must NOT apply for this article.
  const suppressed = suppressedSlugs(titleText);
  // Combined text used for co-occurrence checks — we want the cooccur
  // term to appear ANYWHERE in the article (title or excerpt), not
  // specifically near the main term.
  const fullText = `${titleText}\n${excerptText}`;

  const out: TagMatchDetail[] = [];
  for (const tag of tags) {
    const contributions: TagMatchDetail['contributions'] = [];
    let score = 0;
    if (urlSlugs.has(tag.slug)) {
      score += TAG_SCORE.url;
      contributions.push({ area: 'url', score: TAG_SCORE.url });
    }
    const titleScore = scoreInArea(tag, titleText, PROXIMITY_TITLE, TAG_SCORE.title_phrase, TAG_SCORE.title_keyword);
    if (titleScore > 0) {
      score += titleScore;
      contributions.push({ area: 'title', score: titleScore });
    }
    const excerptScore = scoreInArea(tag, excerptText, PROXIMITY_EXCERPT, TAG_SCORE.excerpt_phrase, TAG_SCORE.excerpt_keyword);
    if (excerptScore > 0) {
      score += excerptScore;
      contributions.push({ area: 'excerpt', score: excerptScore });
    }

    if (score < TAG_THRESHOLD) continue;

    // False-context: title contains a phrase that disqualifies this tag.
    if (suppressed.has(tag.slug)) {
      out.push({ id: tag.id, slug: tag.slug, score, contributions, blocked: 'title has a false-context phrase' });
      continue;
    }

    // Co-occurrence gate: any of these terms must also be in the article.
    // Used to disambiguate generic country/topic names — e.g. "Russia"
    // alone shouldn't trigger "Russia sanctions"; a sanctions-related
    // term must also be present.
    if (tag.cooccur) {
      const hasAny = tag.cooccur.some((t) => keywordMatches(t, fullText, false));
      if (!hasAny) {
        out.push({ id: tag.id, slug: tag.slug, score, contributions, blocked: `requires one of: ${tag.cooccur.join(', ')}` });
        continue;
      }
    }

    out.push({ id: tag.id, slug: tag.slug, score, contributions });
  }
  return out;
}

/** Backwards-compatible API: just the IDs that passed scoring + gates. */
export async function extractTagIds(args: {
  sb: SupabaseClient;
  title: string;
  excerpt: string;
  url?: string;
}): Promise<string[]> {
  const details = await extractTagDetails(args);
  return details.filter((d) => !d.blocked).map((d) => d.id);
}
