// Parametric per-source pre-flight check. Runs BEFORE any extraction code
// is wired for that source. Three proofs:
//
//   1. Source exists in v1 DB, enabled, with valid scraper_config.
//   2. Discovery method works:
//        - if feed_url set → fetch + parse RSS, show sample entries
//        - if scraper_config.sitemap_url → fetch + parse sitemap XML
//        - else → flag as needs-investigation (Phase 2.5)
//   3. v2's hashUrl produces BYTE-IDENTICAL hashes to v1's stored url_hash
//      for 5 existing rows from this source — parallel v1+v2 writes
//      against the same DB must not duplicate.
//
// Usage:  npx tsx src/cli/precheck.ts "Splash247"
//
// READ-ONLY. NO DB write. NO scraper config edit.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Parser from 'rss-parser';
import { hashUrl } from '@/lib/url-hash';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

type Source = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  runner: string | null;
  feed_url: string | null;
  scraper_config: Record<string, unknown> | null;
};

async function checkRss(url: string): Promise<void> {
  console.log(`\n═══ (2) RSS feed parse ═══`);
  const parser = new Parser({ timeout: 20_000 });
  let feed: Awaited<ReturnType<typeof parser.parseURL>>;
  try {
    feed = await parser.parseURL(url);
  } catch (e) {
    console.log(`  ✗ feed parse FAILED: ${(e as Error).message}`);
    process.exit(3);
  }
  const items = feed.items ?? [];
  console.log(`  ✓ parsed. feed title: "${feed.title ?? '(none)'}"`);
  console.log(`  total entries: ${items.length}`);
  if (items.length === 0) {
    console.log('  ⚠ zero entries — POC would have nothing to dry-run.');
    process.exit(4);
  }
  // Show 3 sample entries — shape sanity for orchestrator design
  console.log(`  first 3 entries (shape sanity):`);
  for (const e of items.slice(0, 3)) {
    console.log(`    ── title:    ${e.title?.slice(0, 80) ?? '(none)'}`);
    console.log(`       link:     ${e.link ?? '(none)'}`);
    console.log(`       pubDate:  ${e.pubDate ?? '(none)'}`);
    console.log(`       isoDate:  ${e.isoDate ?? '(none)'}`);
    const snippet = e.contentSnippet?.replace(/\s+/g, ' ').slice(0, 120) ?? '(none)';
    console.log(`       snippet:  ${snippet}`);
    // Some RSS feeds have full body in content:encoded — note presence
    const fullBody = (e as { 'content:encoded'?: string })['content:encoded'];
    if (fullBody) console.log(`       full body in content:encoded (${fullBody.length} chars) ✓`);
  }
}

async function checkSitemap(url: string, urlPattern?: string): Promise<void> {
  console.log(`\n═══ (2) Sitemap parse ═══`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; maritime-reader-v2)' },
  });
  if (!res.ok) {
    console.log(`  ✗ sitemap fetch FAILED: HTTP ${res.status}`);
    process.exit(3);
  }
  const xml = await res.text();
  const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const re = urlPattern ? new RegExp(urlPattern) : null;
  let total = 0;
  let matched = 0;
  const samples: string[] = [];
  for (const b of blocks) {
    const loc = b.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (!loc) continue;
    total++;
    if (!re || re.test(loc)) {
      matched++;
      if (samples.length < 3) samples.push(loc);
    }
  }
  console.log(`  ✓ parsed. total <url> entries: ${total}`);
  console.log(`  matched url_pattern: ${matched}`);
  console.log(`  first 3 matched URLs:`);
  for (const s of samples) console.log(`    ${s}`);
  if (matched === 0) {
    console.log('  ⚠ url_pattern matched zero entries — pattern wrong or sitemap empty.');
    process.exit(4);
  }
}

async function checkHashCompat(sourceId: string): Promise<void> {
  console.log(`\n═══ (3) v1 ↔ v2 url_hash compatibility ═══`);
  const { data: rows, error } = await sb
    .from('articles')
    .select('url, url_hash')
    .eq('source_id', sourceId)
    .not('url_hash', 'is', null)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw new Error(`articles lookup: ${error.message}`);
  if (!rows || rows.length === 0) {
    console.log('  ⚠ no existing rows with url_hash — cannot prove compat.');
    console.log('  → proceed at 2.2 with extra caution; first writes will create the baseline.');
    return;
  }
  let match = 0;
  let mismatch = 0;
  for (const r of rows as { url: string; url_hash: string }[]) {
    const computed = hashUrl(r.url);
    const ok = computed === r.url_hash;
    if (ok) match++;
    else mismatch++;
    console.log(
      `  ${ok ? '✓' : '✗'} stored=${r.url_hash.slice(0, 10)}… v2=${computed.slice(0, 10)}… ${r.url.slice(0, 70)}`,
    );
  }
  console.log(`  Result: ${match} match / ${mismatch} mismatch (of ${rows.length})`);
  if (mismatch > 0) {
    console.log('  ✗ HASH INCOMPATIBILITY — parallel v1+v2 writes WILL duplicate.');
    console.log('  → Fix url-hash.ts canonicalization to match v1 EXACTLY before 2.1 build.');
    process.exit(5);
  }
  console.log('  ✓ v1-compatible. Dedup will work across parallel writes.');
}

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: npx tsx src/cli/precheck.ts "<source name>"');
    process.exit(2);
  }
  console.log(`═══ (1) Source discovery: ${name} ═══`);
  const { data: src, error } = await sb
    .from('sources')
    .select('id, name, type, feed_url, scraper_config, enabled, runner')
    .eq('name', name)
    .maybeSingle();
  if (error) throw new Error(`source lookup: ${error.message}`);
  if (!src) {
    console.log(`  ✗ source "${name}" not found.`);
    process.exit(2);
  }
  const s = src as Source;
  console.log(`  source_id: ${s.id}`);
  console.log(`  type:      ${s.type}`);
  console.log(`  enabled:   ${s.enabled}`);
  console.log(`  runner:    ${s.runner}`);
  console.log(`  feed_url:  ${s.feed_url ?? '(null)'}`);
  console.log(`  scraper_config: ${JSON.stringify(s.scraper_config)}`);
  if (!s.enabled) console.log('  ⚠ source is disabled in v1.');

  const cfg = (s.scraper_config ?? {}) as Record<string, unknown>;
  let mode: 'rss' | 'sitemap' | 'unknown';
  if (s.feed_url) {
    mode = 'rss';
    await checkRss(s.feed_url);
  } else if (typeof cfg.sitemap_url === 'string') {
    mode = 'sitemap';
    const urlPattern = typeof cfg.url_pattern === 'string' ? cfg.url_pattern : undefined;
    await checkSitemap(cfg.sitemap_url, urlPattern);
  } else if (Array.isArray(cfg.jobs)) {
    console.log('\n  ⚠ multi-job config; precheck handles single-mode only.');
    console.log('     Run precheck on the first job\'s discovery target separately (Phase 2.5).');
    process.exit(0);
  } else {
    mode = 'unknown';
    console.log('\n  ⚠ no feed_url, no sitemap_url, no jobs[] — discovery method unknown.');
    console.log('     Flag for Phase 2.5 per-source investigation.');
    process.exit(0);
  }

  await checkHashCompat(s.id);
  console.log(`\n📋 Precheck PASSED for "${name}" (mode=${mode}). Safe to wire pipeline.`);
}

main().catch((e: Error) => {
  console.error(`✗ precheck failed: ${e.message}`);
  process.exit(1);
});
