// STEP 0 / STEP 6 — run fixture queries through LIVE Pagefind and measure the FULL
// RESULT SET (not rendered cards). Loads the deployed base + delta indexes exactly
// as SearchFilter.astro does (same-origin /_pagefind + /_pagefind-delta merge) and
// calls pf.search(query) — which returns the COMPLETE ranked list. For each query we
// report: in_set (expected article present ANYWHERE in the set = THE pass/fail),
// rank (informational), total (result-set size). SEQUENTIAL.
//
// CONTROL GROUP: established (14–60d) titles → exact phrase → MUST be in set. If the
// control isn't ~fully found, the instrument is broken → STOP.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

readFileSync('.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const SITE = 'https://maritimereader.com/';
const SCAN_CAP = 150;                       // resolve at most this many results per query
const STOPW = new Set(['the','and','for','with','from','that','this','over','after','into','amid','says','warns','plans','adds','sees','their','more','than','have','has','not','are','was','will']);

// Merge local fixture + (if present) the GHA-measured Splash fixture.
const fx = JSON.parse(readFileSync('tmp/search-fixture.json', 'utf8'));
let fixture = fx.fixture.slice();
if (existsSync('tmp/search-fixture-splash.json')) {
  const sp = JSON.parse(readFileSync('tmp/search-fixture-splash.json', 'utf8'));
  fixture = fixture.concat(sp.fixture || []);
  console.log(`merged ${sp.fixture?.length || 0} GHA-measured Splash247 terms`);
}

function distinctiveTitlePhrase(title) {
  const words = title.split(/\s+/); let best = [], cur = [];
  for (const w of words) {
    const c = w.replace(/[^A-Za-z0-9]/g, '');
    if (/^[A-Z][A-Za-z0-9]/.test(c) && !STOPW.has(c.toLowerCase()) && c.length > 1) { cur.push(c); if (cur.length > best.length) best = [...cur]; }
    else cur = [];
  }
  return best;
}
const escLike = (s) => s.replace(/[%_\\]/g, (m) => '\\' + m);
async function dbArticleFreq(term) {
  const pat = `%${escLike(term)}%`;
  const [{ count: ct }, { count: ce }] = await Promise.all([
    sb.from('articles').select('id', { count: 'exact', head: true }).ilike('title', pat),
    sb.from('articles').select('id', { count: 'exact', head: true }).ilike('raw_excerpt', pat),
  ]);
  return Math.max(ct ?? 0, ce ?? 0);
}
async function buildControl() {
  const now = Date.now();
  const from = new Date(now - 60 * 864e5).toISOString(), to = new Date(now - 14 * 864e5).toISOString();
  const { data } = await sb.from('articles').select('id,title,created_at')
    .or('content_quality.is.null,content_quality.in.(visible,pending)').gte('created_at', from).lte('created_at', to)
    .order('created_at', { ascending: false }).limit(400);
  const out = [];
  for (const a of (data || [])) {
    const ph = distinctiveTitlePhrase(a.title);
    if (ph.length < 2) continue;
    const phrase = ph.slice(0, 3).join(' ');
    const q = `"${phrase}"`;
    if (out.some((o) => o.query.toLowerCase() === q.toLowerCase())) continue;
    // SAME rarity rule as the fixture: a control term that matches >3 articles
    // ("West Coast" → 799) is not a distinctive instrument check — skip it.
    const freq = await dbArticleFreq(phrase);
    if (freq > 3) continue;
    out.push({ query: q, expected_article_id: a.id, source: 'CONTROL', db_freq: freq, title: a.title.slice(0, 80) });
    if (out.length >= 8) break;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const control = await buildControl();
console.log(`Control group (${control.length}) built from established titles.`);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
// Load base + delta Pagefind exactly as the site does.
const init = await page.evaluate(async () => {
  const pf = await import('/_pagefind/pagefind.js');
  try { await pf.options({ baseUrl: '/' }); } catch (e) {}
  try { await pf.init(); } catch (e) {}
  let deltaOk = false;
  try { deltaOk = (await fetch('/_pagefind-delta/pagefind-entry.json', { cache: 'no-cache' })).ok; } catch (e) {}
  if (deltaOk) { try { await pf.mergeIndex('/_pagefind-delta', { baseUrl: '/' }); } catch (e) {} }
  window.__pf = pf; return { deltaOk };
});
console.log(`Pagefind loaded (delta merged: ${init.deltaOk}).`);

async function runQuery(query, expectedId) {
  return await page.evaluate(async ({ query, expectedId, cap }) => {
    const r = await window.__pf.search(query);
    const total = r.results.length;
    const N = Math.min(total, cap);
    let rank = -1;
    for (let i = 0; i < N; i++) {
      const d = await r.results[i].data();
      if (d.url && d.url.includes(expectedId)) { rank = i + 1; break; }
    }
    return { in_set: rank > 0, rank, total, scanned: N };
  }, { query, expectedId, cap: SCAN_CAP });
}

async function runSet(items, label) {
  const rows = [];
  for (const it of items) {
    let r;
    try { r = await runQuery(it.query, it.expected_article_id); }
    catch (e) { r = { in_set: false, rank: -1, total: -1, scanned: 0, err: String(e.message).slice(0, 60) }; }
    rows.push({ ...it, ...r });
    console.log(`  [${label}] ${r.in_set ? 'IN-SET rank=' + r.rank : 'MISS'} (total=${r.total}) "${it.query}"${it.db_freq != null ? ' fdb=' + it.db_freq : ''} <- ${it.source}`);
    await sleep(400);
  }
  return rows;
}

const results = { generated_at: new Date().toISOString(), site: SITE, method: 'pagefind-full-result-set', deltaMerged: init.deltaOk };

console.log('\n=== CONTROL GROUP (established titles — must be in set) ===');
results.control = await runSet(control, 'CTRL');
const ctrlHit = results.control.filter((r) => r.in_set).length;
console.log(`Control: in-set ${ctrlHit}/${control.length}`);
results.control_ok = ctrlHit >= Math.ceil(control.length * 0.8);
if (!results.control_ok) console.log('\n*** CONTROL FAILED (<80%) — instrument suspect; see diagnose-control-miss.mjs ***');

console.log('\n=== FIXTURE (rare body-terms) ===');
results.fixture = await runSet(fixture, 'FIX');

const bySource = {};
for (const r of results.fixture) { const s = bySource[r.source] ??= { total: 0, in_set: 0 }; s.total++; if (r.in_set) s.in_set++; }
results.summary = {
  control: { total: control.length, in_set: ctrlHit },
  fixture: { total: results.fixture.length, in_set: results.fixture.filter((r) => r.in_set).length },
  bySource,
};
writeFileSync('tmp/baseline.json', JSON.stringify(results, null, 2));
console.log('\n=== BASELINE SUMMARY ===');
console.log(JSON.stringify(results.summary, null, 2));
console.log('WROTE tmp/baseline.json');
await browser.close();
