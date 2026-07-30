// TARGETED backfill — ONLY the ~24 fixture articles (NOT the 65k archive), so
// search-check.mjs gets a REAL before/after on the SAME rows it measures. url_hash
// dedup means a normal re-scrape will NOT re-write these existing rows, so without
// this the fixture stays flat even with a perfect fix.
//
// Per article: fetch the publisher page (SEQUENTIAL, ~2.5s apart), run the SHIPPED
// gate+extractor (selectAndExtract — parity with production), and write
// content_terms / text_source / gate_reason. raw_excerpt is NEVER touched (copyright
// rule: excerpt-only, ≤500c). CF 403 (Splash247 locally) → skip + report.
//
// Run:  npx tsx scripts/backfill-fixture.ts            # DRY RUN (writes nothing)
//       npx tsx scripts/backfill-fixture.ts --apply    # write to DB (needs migration 040)
import { readFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { selectAndExtract } from '../lib/scrapers/rss';

try { readFileSync('.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }); } catch { /* CI */ }
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const sb = createClient(url!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const APPLY = process.argv.includes('--apply');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Load fixture rows (+ GHA Splash slice if present).
type Fx = { query: string; expected_article_id: string; source: string; url: string; title: string };
let rows: Fx[] = JSON.parse(readFileSync('tmp/search-fixture.json', 'utf8')).fixture;
if (existsSync('tmp/search-fixture-splash.json')) rows = rows.concat(JSON.parse(readFileSync('tmp/search-fixture-splash.json', 'utf8')).fixture ?? []);

// Guard: writing needs migration 040. Probe once; refuse --apply if absent.
if (APPLY) {
  const { error } = await sb.from('articles').select('content_terms').limit(1);
  if (error) { console.error(`REFUSING --apply: content_terms column absent — apply migration 040 first (${error.message})`); process.exit(2); }
}

async function fetchBody(u: string): Promise<{ ok: boolean; status: number; text: string }> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    const $ = cheerio.load(await res.text());
    $('script,style,noscript,figcaption').remove();
    let scope = $('article').first(); if (!scope.length) scope = $('main').first(); if (!scope.length) scope = $('body');
    const paras: string[] = [];
    scope.find('p').each((_, el) => { const x = $(el).text().replace(/\s+/g, ' ').trim(); if (x.length >= 70 && /[a-z]/.test(x) && /[.!?]/.test(x)) paras.push(x); });
    let text = paras.join(' \n ');
    if (text.length < 500) { scope.find('nav,header,footer,aside,form').remove(); const broad = scope.text().replace(/\s+/g, ' ').trim(); if (broad.length > text.length) text = broad; }
    return { ok: true, status: res.status, text };
  } catch { return { ok: false, status: 0, text: '' }; }
  finally { clearTimeout(t); }
}

let updated = 0, skipped = 0, blocked = 0;
console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} fixture articles\n`);
for (const r of rows) {
  const { data: row } = await sb.from('articles').select('id,title,raw_excerpt').eq('id', r.expected_article_id).single();
  if (!row) { console.log(`  MISSING row ${r.expected_article_id}`); skipped++; continue; }
  const body = await fetchBody(r.url);
  if (!body.ok) { console.log(`  ${body.status || 'ERR'} skip "${r.query}" (${r.source}) ${r.url.slice(0, 50)}`); if (body.status === 403 || body.status === 429) blocked++; else skipped++; await sleep(2500); continue; }
  const sel = selectAndExtract(row.title, body.text, row.raw_excerpt ?? '');
  const termInTerms = sel.content_terms.some((t) => t.toLowerCase() === r.query.toLowerCase());
  console.log(`  "${r.query}" [${r.source}] src=${sel.text_source} terms=${sel.content_terms.length} query-in-terms=${termInTerms ? 'YES' : 'no'}`);
  console.log(`      NEW content_terms: ${sel.content_terms.join(' | ')}`);
  if (APPLY) {
    const { error } = await sb.from('articles').update({ content_terms: sel.content_terms, text_source: sel.text_source, gate_reason: sel.gate_reason ?? null }).eq('id', row.id);
    if (error) { console.log(`      WRITE FAILED: ${error.message}`); skipped++; }
    else { updated++; }
  }
  await sleep(2500);   // SEQUENTIAL + polite (CF)
}

if (APPLY) {
  // Independent verify: re-read and confirm content_terms present.
  let verified = 0;
  for (const r of rows) { const { data } = await sb.from('articles').select('content_terms').eq('id', r.expected_article_id).single(); if (Array.isArray((data as any)?.content_terms) && (data as any).content_terms.length) verified++; }
  console.log(`\nAPPLIED: updated=${updated} verified-nonempty=${verified} skipped=${skipped} blocked(CF)=${blocked}`);
} else {
  console.log(`\nDRY RUN done: ${rows.length - skipped - blocked} extractable, skipped=${skipped}, blocked(CF)=${blocked}. Re-run with --apply after migration 040.`);
}
