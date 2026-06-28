// Date-integrity guard — the recurring "double-check" so mis-dated articles are
// caught AUTOMATICALLY, never by hand. Two layers:
//
//   1. CHEAP heuristic (default, every run, no network): flag VISIBLE articles
//      whose published_at == the scrape time (|published_at - created_at| <
//      THRESHOLD) AND published_at_source = 'scraper_default'. That signature
//      means "the scraper could not extract a real date and fell back to now()",
//      which makes old circulars surface as fresh news (the 2026-06 NorthStandard
//      /Gard incident). Reports by source; exits non-zero (CRITICAL) if any
//      VISIBLE rows match, so the coverage-audit workflow can alert.
//
//   2. DEEP verify (VERIFY=1, sampled): re-fetch each flagged article and
//      compare the live page's real date to the DB. Auto-corrects when an
//      authoritative date (json_ld / date_selector / meta) is found; lists the
//      rest for review. Expensive (Playwright) → run weekly or on demand.
//
// Run: `npx tsx scripts/audit-date-integrity.ts`        (cheap, daily)
//      `VERIFY=1 FIX=1 npx tsx scripts/audit-date-integrity.ts`  (deep + fix)
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const SCRAPE_WINDOW_S = 600;      // published within 10 min of created == scrape-time
const VERIFY = process.env.VERIFY === '1';
const FIX = process.env.FIX === '1';

type Row = { id: string; title: string; url: string; published_at: string; created_at: string; published_at_source: string; published_at_confidence: string; source_id: string };

async function scan(): Promise<Row[]> {
  const flagged: Row[] = [];
  let cursor = '2000-01-01';
  for (;;) {
    const { data, error } = await sb.from('articles')
      .select('id,title,url,published_at,created_at,published_at_source,published_at_confidence,source_id')
      .eq('content_quality', 'visible').eq('published_at_source', 'scraper_default')
      .not('published_at', 'is', null).gt('created_at', cursor)
      .order('created_at', { ascending: true }).limit(1000);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    for (const a of data) {
      const dt = Math.abs(+new Date(a.created_at) - +new Date(a.published_at)) / 1000;
      if (dt < SCRAPE_WINDOW_S) flagged.push(a as Row);
    }
    cursor = data[data.length - 1].created_at;
    if (data.length < 1000) break;
  }
  return flagged;
}

const flagged = await scan();
const { data: srcs } = await sb.from('sources').select('id,name');
const sname = new Map((srcs ?? []).map((s) => [s.id, s.name]));
const bySource = new Map<string, number>();
for (const f of flagged) bySource.set(sname.get(f.source_id) ?? '?', (bySource.get(sname.get(f.source_id) ?? '?') ?? 0) + 1);

console.log(`\n=== DATE-INTEGRITY AUDIT ===`);
console.log(`VISIBLE articles dated at scrape-time (scraper_default, |pub-created|<${SCRAPE_WINDOW_S}s): ${flagged.length}`);
if (flagged.length) {
  console.log('by source:');
  [...bySource.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${n.padEnd(24)} ${c}`));
  console.log('samples:');
  flagged.slice(0, 8).forEach((f) => console.log(`  ${f.published_at.slice(0, 10)} | ${sname.get(f.source_id)} | ${f.title?.slice(0, 40)}`));
}

if (VERIFY && flagged.length) {
  console.log(`\n--- DEEP VERIFY: re-fetching ${flagged.length} pages ---`);
  const { fetchHtmlWithPlaywright, closePlaywright } = await import('../lib/scrapers/playwright-fetcher');
  const { resolveArticleDate } = await import('../lib/scrapers/html');
  const cheerio = await import('cheerio');
  const SAFE = new Set(['json_ld', 'date_selector', 'meta', 'time_element_semantic']);
  let fixedN = 0, review = 0;
  for (const a of flagged) {
    const cfg = (srcs ?? []).find((s) => s.id === a.source_id) as any;
    try {
      const $ = cheerio.load(await fetchHtmlWithPlaywright(a.url));
      const r = resolveArticleDate({ $, link: a.url, title: a.title, date_selector: cfg?.scraper_config?.date_selector, date_format: cfg?.scraper_config?.date_format });
      if (!r?.winner.iso) continue;
      if (r.winner.iso.slice(0, 10) === a.published_at.slice(0, 10)) continue;
      const safe = SAFE.has(r.winner.step);
      console.log(`  ${a.published_at.slice(0, 10)} → ${r.winner.iso.slice(0, 10)} (${r.winner.step}${safe ? '' : ', REVIEW'}) ${a.title?.slice(0, 34)}`);
      if (safe) { fixedN++; if (FIX) await sb.from('articles').update({ published_at: r.winner.iso, published_at_source: r.winner.source, published_at_confidence: r.winner.confidence }).eq('id', a.id); }
      else review++;
    } catch { /* skip on fetch error */ }
  }
  await closePlaywright();
  console.log(`\n${FIX ? 'FIXED' : 'would-fix'}=${fixedN} (authoritative)  review=${review} (body-only, manual)`);
}

// Non-zero exit signals the workflow to alert (CRITICAL = any visible scrape-time row).
if (flagged.length > 0 && !FIX) process.exitCode = 2;
