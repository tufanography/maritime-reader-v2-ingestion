// ARCHIVE COVERAGE-HOLE backfill — inserts the articles a source published in a
// date window that we never captured (measured ~2.5-year hole 2024-01→2026-04 in
// gCaptain / Marine Log / Offshore Energy). This is a COVERAGE fill, NOT a re-write:
// only posts whose url_hash we do NOT already hold are inserted.
//
// Every new row goes through the SAME pipeline a normal scrape uses:
//   wpPostToRawArticle (shared with fetchWpRest → content_terms + raw_excerpt rule)
//   → looksLikeArticle gate → categorizeByRules (deterministic, NO AI) → document_type
//   → segments → keywords → moderate → content_quality → insert (+ tags).
// raw_excerpt rule UNCHANGED: excerpt.rendered only, ≤500c, empty-on-boilerplate.
//
// GHA-READY: env from process.env (no .env needed), no Playwright, SEQUENTIAL with a
// 2.5s gap, 403/429 STOPS the source (never hammer into a block). The eventual full
// run is a GHA matrix (one source per job, resumable via --after/--before) — this
// script runs identically there; Marine Log can ONLY be sized/run from GHA (CF-403
// locally).
//
// Usage:
//   npx tsx scripts/backfill-archive.ts --source gCaptain --after 2026-04-01 --before 2026-05-01
//   npx tsx scripts/backfill-archive.ts --source gCaptain --after 2026-04-01 --before 2026-05-01 --apply
import { readFileSync } from 'fs';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { hashUrl, sleep } from '../lib/scrapers/util';
import { wpPostToRawArticle } from '../lib/scrapers/rss';
import { fetchKnownHashes } from '../lib/scrapers/orchestrator';
import { looksLikeArticle } from '../lib/scrapers/quality';
import { categorizeByRules, extractSummary } from '../lib/ai/rules';
import { deriveDocumentType } from '../lib/v3/document-type';
import { deriveSegments } from '../lib/v3/segments';
import { extractKeywords } from '../lib/tagging/keywords';
import { moderate } from '../lib/scrapers/moderation';
import { extractTagIds } from '../lib/tagging/extract';
import { isProperNounOrAcronym } from '../lib/tagging/gate';
import type { Source } from '../lib/supabase/types';

try { readFileSync('.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }); } catch { /* CI */ }
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const SOURCE = arg('--source');
const AFTER = arg('--after');
const BEFORE = arg('--before');
const APPLY = process.argv.includes('--apply');
if (!SOURCE || !AFTER || !BEFORE) { console.error('usage: --source <name|id> --after <ISO> --before <ISO> [--apply]'); process.exit(1); }

const SUPA_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const sb: SupabaseClient = createClient(SUPA_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const toISO = (d: string) => (d.includes('T') ? d : d + 'T00:00:00');

async function resolveSource(): Promise<Source> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(SOURCE!);
  const q = isUuid ? sb.from('sources').select('*').eq('id', SOURCE) : sb.from('sources').select('*').ilike('name', SOURCE!);
  const { data, error } = await q;
  if (error) throw error;
  if (!data || data.length === 0) throw new Error(`source not found: ${SOURCE}`);
  if (data.length > 1) throw new Error(`ambiguous source "${SOURCE}": ${data.map((s: any) => s.name).join(', ')}`);
  return data[0] as Source;
}

async function fetchWindowPage(wpUrl: string, page: number): Promise<{ status: number; posts: any[]; total: number; totalPages: number }> {
  const sep = wpUrl.includes('?') ? '&' : '?';
  const u = `${wpUrl}${sep}after=${encodeURIComponent(toISO(AFTER!))}&before=${encodeURIComponent(toISO(BEFORE!))}&per_page=100&page=${page}&orderby=date&order=asc&_fields=link,date_gmt,title,excerpt,content`;
  // Retry transient network/abort failures (a single 25s-timeout page used to
  // throw and crash the whole run — that's how the Offshore backfill died at
  // page 60/117). 3 attempts with 3s/6s backoff; only a persistent failure
  // returns status -2, which the caller treats as a clean PARTIAL stop, not a crash.
  const MAX = 3;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'follow', signal: ctrl.signal });
      if (res.status === 400) return { status: 200, posts: [], total: 0, totalPages: 0 };  // WP returns 400 past the last page
      if (!res.ok) return { status: res.status, posts: [], total: 0, totalPages: 0 };
      const total = Number(res.headers.get('x-wp-total') ?? 0);
      const totalPages = Number(res.headers.get('x-wp-totalpages') ?? 0);
      const posts = JSON.parse(await res.text());
      return { status: res.status, posts: Array.isArray(posts) ? posts : [], total, totalPages };
    } catch (e: any) {
      if (attempt === MAX) { console.error(`\n  page ${page}: fetch failed after ${MAX} attempts (${e?.name ?? e}) — clean PARTIAL stop, not a crash`); return { status: -2, posts: [], total: 0, totalPages: 0 }; }
      await sleep(3000 * attempt);
    } finally { clearTimeout(t); }
  }
  return { status: -2, posts: [], total: 0, totalPages: 0 };
}

const source = await resolveSource();
const cfg = (source.scraper_config ?? {}) as { wp_rest_url?: string };
if (!cfg.wp_rest_url) throw new Error(`source "${source.name}" has no scraper_config.wp_rest_url — this WP-REST backfill can't run it`);
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${source.name} [${source.trust_level}]  window [${AFTER}, ${BEFORE})  wp=${cfg.wp_rest_url}\n`);

// ── PER-PAGE loop: fetch → dedup → insert → sleep, one page at a time ─────────
// Was fetch-ALL-then-insert: a crash on page 116/117 threw away every fetched
// row and showed zero progress until the very end. Now each page is committed
// before the next is fetched, so a crash loses at most one page, a re-run skips
// what's already written (url_hash dedup), and progress is live. (2026-07-31)
const catBySlug = new Map<string, string>();
if (APPLY) {
  const { data: cats } = await sb.from('categories').select('id, slug');
  for (const c of (cats ?? []) as any[]) catBySlug.set(c.slug, c.id);
}
let windowTotal = 0, blocked = false;
let fetchedTotal = 0, alreadyHave = 0, freshTotal = 0;
let inserted = 0, rejectedQuality = 0, rejectedNoDate = 0, insertFailed = 0;
const tsDist: Record<string, number> = {};
const insertedIds: string[] = [];
for (let page = 1; page <= 200; page++) {
  const r = await fetchWindowPage(cfg.wp_rest_url, page);
  if (r.status === 403 || r.status === 429) { console.error(`\nSTOP: HTTP ${r.status} on page ${page} — CF/rate block. Run this source from GHA (different IP). Partial: ${fetchedTotal} fetched, ${inserted} inserted.`); blocked = true; break; }
  if (r.status === -2) { console.error(`\nSTOP: page ${page} fetch failed after retries (transient network/abort). Partial: ${fetchedTotal} fetched, ${inserted} inserted. Re-run to resume (dedup skips what's written).`); blocked = true; break; }
  if (r.status !== 200) { console.error(`\nSTOP: HTTP ${r.status} on page ${page}.`); blocked = true; break; }
  if (page === 1) windowTotal = r.total;
  if (r.posts.length === 0) break;

  // this page's raw articles
  const pageRaws: NonNullable<ReturnType<typeof wpPostToRawArticle>>[] = [];
  for (const p of r.posts) { const ra = wpPostToRawArticle(p); if (ra) pageRaws.push(ra); }
  fetchedTotal += pageRaws.length;

  // dedup THIS page by url_hash — only NEW items
  const hashes = pageRaws.map((ra) => hashUrl(ra.url));
  const { known, error: dedupErr } = await fetchKnownHashes(sb, hashes);
  if (dedupErr) throw new Error(`dedup failed on page ${page} (won't insert blind): ${dedupErr}`);
  const freshPage = pageRaws.filter((ra) => !known.has(hashUrl(ra.url)));
  alreadyHave += pageRaws.length - freshPage.length;
  freshTotal += freshPage.length;

  // insert THIS page through the same pipeline as a normal scrape (APPLY only)
  if (APPLY) for (const ra of freshPage) {
    if (!looksLikeArticle({ title: ra.title, excerpt: ra.excerpt, url: ra.url }).ok) { rejectedQuality++; continue; }
    if (!ra.published_at) { rejectedNoDate++; continue; }   // WP date_gmt should always be present
    const rules = categorizeByRules({ title: ra.title, excerpt: ra.excerpt, hint: source.category_hint });
    const categoryId = catBySlug.get(rules.category) ?? catBySlug.get('general') ?? null;
    const documentType = deriveDocumentType({ sourceCategoryHint: source.category_hint, sourceName: source.name, categorySlug: rules.category, title: ra.title, excerpt: ra.excerpt });
    const segments = deriveSegments({ categorySlug: rules.category, title: ra.title, excerpt: ra.excerpt, sourceName: source.name });
    const keywords = extractKeywords({ title: ra.title, excerpt: ra.excerpt }, 5);
    const mod = moderate(ra.title, ra.excerpt);
    const contentQuality = mod.decision === 'hide' ? 'hidden' : source.trust_level === 'aggregator' ? 'pending' : 'visible';
    const { data: row, error } = await sb.from('articles').insert({
      source_id: source.id,
      category_id: categoryId,
      title: ra.title,
      url: ra.url,
      url_hash: hashUrl(ra.url),
      author: ra.author,
      published_at: ra.published_at,
      published_at_source: ra.published_at_source ?? 'original',
      published_at_confidence: ra.published_at_confidence ?? 'high',
      raw_excerpt: ra.excerpt.slice(0, 500),   // ra.excerpt is ALREADY excerpt-only & ≤500 (capped in wpPostToRawArticle: excerptText.slice(0,500)); this is an explicit belt-and-suspenders 500 cap — NEVER 4000 on the raw_excerpt path
      summary: extractSummary(ra.excerpt),
      ai_categorized: false,
      ai_confidence: rules.confidence,
      image_url: ra.image_url,
      document_type: documentType,
      segments,
      keywords,
      content_quality: contentQuality,
      content_terms: ra.content_terms ?? null,
      text_source: ra.text_source ?? null,
      gate_reason: ra.gate_reason ?? null,
    }).select('id').single();
    if (error) { insertFailed++; if (insertFailed <= 5) console.error(`\n  insert failed: ${ra.url} — ${error.message}`); continue; }
    inserted++; insertedIds.push(row!.id); tsDist[ra.text_source ?? 'null'] = (tsDist[ra.text_source ?? 'null'] ?? 0) + 1;
    try {
      const tagIds = await extractTagIds({ sb, title: ra.title, excerpt: ra.excerpt, url: ra.url });
      if (tagIds.length > 0) { await sb.from('article_tags').insert(tagIds.map((tag_id) => ({ article_id: row!.id, tag_id }))); for (const tag_id of tagIds) sb.rpc('refresh_tag_count', { tag_uuid: tag_id }).then(() => {}); }
    } catch { /* non-fatal */ }
  }

  process.stdout.write(`  page ${page}/${r.totalPages || '?'}  fetched ${fetchedTotal}  new ${freshTotal}${APPLY ? `  inserted ${inserted}` : ''}\r`);
  if (r.totalPages && page >= r.totalPages) break;
  await sleep(2500);
}
console.log('');
console.log(`WINDOW: source WP total=${windowTotal} | fetched=${fetchedTotal} | already-have=${alreadyHave} | NEW ${APPLY ? 'inserted' : '(would insert)'}=${APPLY ? inserted : freshTotal}${blocked ? ' [PARTIAL — blocked]' : ''}\n`);

if (!APPLY) { console.log('DRY RUN — nothing inserted. Re-run with --apply to insert the NEW items.'); process.exit(0); }

// ── quality + raw_excerpt verification on inserted rows ───────────────────────
let terms = 0, proper = 0, rawOver500 = 0, rawEmpty = 0, rawFromContent = 0;
for (const id of insertedIds) {
  const { data } = await sb.from('articles').select('content_terms,raw_excerpt').eq('id', id).single();
  const ct = (data?.content_terms ?? []) as string[];
  terms += ct.length; proper += ct.filter(isProperNounOrAcronym).length;
  const re = data?.raw_excerpt ?? '';
  if (re.length > 500) rawOver500++;
  if (re.length === 0) rawEmpty++;
}
console.log(`\n=== APPLY RESULT — ${source.name} [${AFTER}, ${BEFORE}) ===`);
console.log(`  NEW=${freshTotal}  inserted=${inserted}  rejected(quality)=${rejectedQuality}  rejected(no-date)=${rejectedNoDate}  insert-failed=${insertFailed}  blocked=${blocked}`);
console.log(`  text_source: ${JSON.stringify(tsDist)}`);
console.log(`  content_terms: total=${terms}  proper-noun/acronym=${proper}/${terms} (${terms ? (100 * proper / terms).toFixed(0) : 0}%)`);
console.log(`  raw_excerpt rule: over-500c=${rawOver500} (must be 0)  empty(boilerplate)=${rawEmpty}/${inserted}`);
