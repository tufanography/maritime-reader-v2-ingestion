// "Trust nothing" date verifier — YOU run this; it does not trust me, the DB,
// or my memory. For each article it FETCHES THE LIVE SOURCE PAGE, reads the real
// published date off that page, and compares it to what our DB stores. Any
// MISMATCH is printed. This is ground truth: the source website itself.
//
// Scope = the SITE's visibility (null/visible/pending), so it sees exactly what
// users see. Pick what to check:
//   npx tsx scripts/verify-dates-vs-source.ts                 # 30 random NS+Gard
//   N=60 SOURCE=Gard npx tsx scripts/verify-dates-vs-source.ts # 60 random Gard
//   TITLE="CEO Update" npx tsx scripts/verify-dates-vs-source.ts # one article
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { fetchHtmlWithPlaywright, closePlaywright } from '../lib/scrapers/playwright-fetcher';
import { resolveArticleDate } from '../lib/scrapers/html';
import * as cheerio from 'cheerio';

const sb = createClient(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const N = Number(process.env.N || 30);
const SOURCE = process.env.SOURCE || ''; // '' = NorthStandard + Gard
const TITLE = process.env.TITLE || '';

const { data: srcs } = await sb.from('sources').select('id,name,scraper_config');
const sm = new Map((srcs ?? []).map((s) => [s.id, s]));
const wantIds = (srcs ?? []).filter((s) => SOURCE ? s.name.toLowerCase().includes(SOURCE.toLowerCase()) : /NorthStandard|^Gard$/i.test(s.name)).map((s) => s.id);

let rows: any[] = [];
if (TITLE) {
  const { data } = await sb.from('articles').select('id,title,url,published_at,source_id,content_quality').ilike('title', `%${TITLE}%`);
  rows = data ?? [];
} else {
  const { data } = await sb.from('articles')
    .select('id,title,url,published_at,source_id,content_quality')
    .or('content_quality.is.null,content_quality.in.(visible,pending)')
    .in('source_id', wantIds).not('published_at', 'is', null)
    .order('created_at', { ascending: false }).limit(Math.min(400, N * 6));
  // shuffle deterministically-ish by id, take N
  rows = (data ?? []).sort((a, b) => a.id < b.id ? -1 : 1).filter((_, i) => i % Math.max(1, Math.floor((data?.length ?? N) / N)) === 0).slice(0, N);
}

console.log(`Checking ${rows.length} articles against their LIVE source pages...\n`);
let match = 0, mismatch = 0, noPageDate = 0, err = 0;
const bad: string[] = [];
for (const a of rows) {
  const cfg = (sm.get(a.source_id) as any)?.scraper_config || {};
  try {
    const html = cfg.requires_js ? await fetchHtmlWithPlaywright(a.url) : await (await fetch(a.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36' } })).text();
    const $ = cheerio.load(html);
    const r = resolveArticleDate({ $, link: a.url, title: a.title, date_selector: cfg.date_selector, date_format: cfg.date_format });
    const dbDay = a.published_at.slice(0, 10);
    const pageDay = r?.winner.iso?.slice(0, 10);
    if (!pageDay) { noPageDate++; continue; }
    if (pageDay === dbDay) { match++; }
    else { mismatch++; bad.push(`  MISMATCH  DB=${dbDay}  SOURCE=${pageDay}  (${r!.winner.step})  ${a.title?.slice(0, 45)}\n            ${a.url}`); }
  } catch { err++; }
}
console.log(bad.join('\n') || '  (no mismatches)');
console.log(`\n================ RESULT ================`);
console.log(`matched DB==source : ${match}`);
console.log(`MISMATCH           : ${mismatch}   <-- must be 0`);
console.log(`page had no date   : ${noPageDate}`);
console.log(`fetch errors       : ${err}`);
console.log(`\nThis compared our DB to the REAL source pages. If MISMATCH is 0, the`);
console.log(`stored dates match what the publisher's own page says — independent of`);
console.log(`any claim. If > 0, the lines above show exactly which and where.`);
await closePlaywright();
process.exitCode = mismatch > 0 ? 2 : 0;
