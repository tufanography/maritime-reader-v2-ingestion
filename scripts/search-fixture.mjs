// STEP 0 — PERMANENT regression fixture generator (v2). DO NOT DELETE tmp/search-fixture.json.
//
// Builds a fixture of RARE, distinctive body-terms (person / ship / company names)
// that live in an article's BODY but not its title/excerpt — exactly what today's
// search cannot find. A rare term (≤3 DB articles) ranks its article #1 when the
// body is indexed, so "is the expected article in the result set" is an unambiguous
// pass/fail (search-check.mjs measures Pagefind's FULL result set, not rendered cards).
//
// RULES (per 2026-07-30 course-correction):
//  - RARE: reject a candidate if it appears in >3 DB articles (title/raw_excerpt).
//  - NO geography / institutions / photo credits / page chrome.
//  - SELF-CHECK: a known-good page must yield >=500c of body text or the tool STOPS
//    and shouts (guards against the silent 259c->0c extractor regression).
//  - SEQUENTIAL fetches with delay (concurrent trips Cloudflare → false 403s).
//  - Splash247 403s from this datacenter/home IP → measured on GHA instead
//    (search-fixture-splash.yml); locally it is recorded as gha_deferred.
import { readFileSync, writeFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

// Local: load .env. CI (GHA search-fixture-splash.yml): no .env — use process.env
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY set from secrets by the workflow).
try { readFileSync('.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); }); } catch { /* no .env in CI */ }
const SUPA_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const sb = createClient(SUPA_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ONLY_SPLASH = process.argv.includes('--splash-only');   // for the GHA workflow
const TARGET_SOURCES = ONLY_SPLASH ? {
  'Splash247': '402c34b2-d804-4a5e-b375-2aeb114f743a',
} : {
  'gCaptain': '6f0b5d09-74b1-4e11-948a-589eea2447f6',
  'The Maritime Executive': '3090d965-7b8c-4d31-b5c0-d7855af8a48f',
  'Marine Insight': 'f0cab8fc-e56e-4180-8169-7c39186b0bd3',
  'Swedish Club': '24f977b4-6c00-4b15-858e-3936f20a1126',
  'Splash247': '402c34b2-d804-4a5e-b375-2aeb114f743a',   // attempted; 403→gha_deferred
};
const PER_SOURCE_TARGET = 6;
const CANDIDATE_POOL = 20;
const RARE_MAX_DB_ARTICLES = 3;       // >3 DB articles → not distinctive → reject
const MIN_BODY_CHARS = 500;           // self-check floor for a known-good page
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome/boilerplate words (nav, dates, widgets, wire agencies, image credits).
const CHROME = new Set(['published','related','posts','post','categories','category','email','contact','photo','image','images','credit','credits','file','views','total','share','tags','tag','comment','comments','subscribe','newsletter','cookie','cookies','privacy','menu','home','features','feature','advertisement','sponsored','reuters','bloomberg','author','byline','print','draft','survey','build','read','more','watch','video','listen','jan','feb','mar','apr','may','jun','jul','aug','sep','sept','oct','nov','dec','monday','tuesday','wednesday','thursday','friday','saturday','sunday']);
// Geography + institutions — FORBIDDEN as fixture terms (too common / not a distinctive
// per-article identifier). A phrase containing ANY of these words is rejected.
const GEO_INST = new Set(['us','usa','united','states','state','america','american','europe','european','union','council','commission','parliament','white','house','washington','nations','navy','coast','guard','ministry','federal','agency','administration','department','government','republic','kingdom','britain','british','england','uk','china','chinese','russia','russian','moscow','iran','iranian','tehran','ukraine','ukrainian','odesa','kyiv','yemen','houthi','houthis','saudi','arabia','arabian','oman','omani','gulf','qatar','uae','dubai','abu','dhabi','turkey','turkish','india','indian','japan','japanese','korea','korean','vietnam','vietnamese','germany','german','france','french','italy','italian','spain','spanish','norway','norwegian','sweden','swedish','denmark','danish','netherlands','dutch','poland','polish','greece','greek','egypt','egyptian','israel','israeli','singapore','malaysia','indonesia','philippines','philippine','australia','canada','canadian','brazil','africa','african','sea','seas','ocean','strait','straits','bay','gulf','canal','river','port','ports','red','black','baltic','mediterranean','pacific','atlantic','caribbean','hormuz','suez','panama','malacca','aden','azov','tyne','danube','rhine','hamburg','rotterdam','antwerp','shanghai','ningbo','angeles','palmas','orleans','york','london','paris','berlin','rome','madrid','tokyo','beijing','mumbai','shields','tyneside','southampton','queenstown','fredrikstad','mykolaiv','damietta','spratly','vietnam']);
const MONTHS = /^(january|february|march|april|june|july|august|september|october|november|december)$/i;
const PHRASE_RE = /\b([A-Z][a-z]+(?:\s+(?:of\s+|the\s+|and\s+)?[A-Z][a-z]+){1,2})\b/g;
const WORD_RE = /\b([A-Z][A-Za-z]{4,})\b/g;
const SECTION_TITLES = /^(emea|world|asia\/pacific|americas|europe|features?|news|home|latest)\b/i;
const PHOTO_CTX = /(image|photo|credit|credits|file photo|reuters|getty|bloomberg|©)/i;

/** Extract body text: paragraph prose first; if that yields < MIN_BODY_CHARS fall
 *  back to the broader article/main container text with chrome elements removed.
 *  Returns {ok,status,text,mode}. The fallback is the fix for the 0c regression on
 *  pages that don't use <p> for prose. */
async function fetchBody(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, text: '', mode: 'none' };
    const html = await res.text();
    const $ = cheerio.load(html);
    $('script,style,noscript,figcaption').remove();
    let scope = $('article').first(); if (!scope.length) scope = $('main').first(); if (!scope.length) scope = $('body');
    // paragraph prose
    const paras = [];
    scope.find('p').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t.length < 70 || !/[a-z]/.test(t) || !/[.!?]/.test(t)) return;
      if (/^(by |photo|image|credit|source:|copyright|©)/i.test(t)) return;
      paras.push(t);
    });
    let text = paras.join(' \n '); let mode = 'paragraphs';
    if (text.length < MIN_BODY_CHARS) {
      // fallback: strip chrome containers, take broad text
      scope.find('nav,header,footer,aside,form,[class*="menu"],[class*="nav"],[class*="footer"],[class*="header"],[class*="related"],[class*="share"],[class*="sidebar"],[class*="widget"],[id*="menu"],[id*="nav"]').remove();
      const broad = scope.text().replace(/\s+/g, ' ').trim();
      if (broad.length > text.length) { text = broad; mode = 'broad'; }
    }
    return { ok: true, status: res.status, text, mode };
  } catch (e) {
    return { ok: false, status: 0, text: '', mode: 'err', err: String(e.message || e).slice(0, 80) };
  } finally { clearTimeout(timer); }
}

function escLike(s) { return s.replace(/[%_\\]/g, (m) => '\\' + m); }

/** DB rarity: how many articles carry this term in title or raw_excerpt. */
async function dbArticleFreq(term) {
  const pat = `%${escLike(term)}%`;
  const [{ count: ct }, { count: ce }] = await Promise.all([
    sb.from('articles').select('id', { count: 'exact', head: true }).ilike('title', pat),
    sb.from('articles').select('id', { count: 'exact', head: true }).ilike('raw_excerpt', pat),
  ]);
  return Math.max(ct ?? 0, ce ?? 0);
}

function candidateTerms(title, body) {
  const tl = title.toLowerCase();
  const paras = body.split('\n');
  const out = [];
  const seen = new Set();
  const okWords = (words) => words.every((w) => {
    const lw = w.toLowerCase().replace(/[^a-z]/gi, '');
    return lw.length > 1 && !CHROME.has(lw) && !GEO_INST.has(lw) && !MONTHS.test(lw);
  });
  // multi-word proper nouns first (person/ship/company), then rare single caps words
  for (const para of paras) {
    for (const m of para.matchAll(PHRASE_RE)) {
      const p = m[1].trim(); const key = p.toLowerCase();
      if (seen.has(key)) continue; seen.add(key);
      const words = p.split(/\s+/);
      if (words.length < 2 || !okWords(words)) continue;
      if (tl.includes(key)) continue;
      if (p.length < 7 || p.length > 40) continue;
      // reject photo-credit context (±40 chars around the phrase)
      const idx = body.indexOf(p); const ctx = body.slice(Math.max(0, idx - 40), idx + p.length + 40);
      if (PHOTO_CTX.test(ctx)) continue;
      out.push(p);
    }
  }
  return out;
}

// ---- SELF-CHECK: a known-good article page must extract >= MIN_BODY_CHARS ----
// Canary = newest gCaptain visible row (rich prose). If even that yields <500c the
// extractor is broken → STOP and shout (guards the 259c→0c silent regression).
async function canaryOk() {
  const { data } = await sb.from('articles').select('url').eq('source_id', '6f0b5d09-74b1-4e11-948a-589eea2447f6')
    .or('content_quality.is.null,content_quality.in.(visible,pending)').order('created_at', { ascending: false }).limit(1);
  if (!data?.[0]) return true;
  const r = await fetchBody(data[0].url);
  if (r.ok && r.text.length < MIN_BODY_CHARS) {
    console.error(`\n*** SELF-CHECK FAILED: known-good gCaptain page ${data[0].url} extracted only ${r.text.length}c (< ${MIN_BODY_CHARS}). The body extractor is BROKEN. STOPPING. ***`);
    process.exit(3);
  }
  console.log(`  self-check: canary extracted ${r.ok ? r.text.length + 'c OK' : r.status + ' (network, skipped)'}`);
  return true;
}

await canaryOk();
await sleep(2000);

const fixture = [];
const perSourceLog = {};

for (const [srcName, srcId] of Object.entries(TARGET_SOURCES)) {
  const { data } = await sb.from('articles').select('id,title,url,raw_excerpt').eq('source_id', srcId)
    .or('content_quality.is.null,content_quality.in.(visible,pending)').order('created_at', { ascending: false }).limit(CANDIDATE_POOL);
  perSourceLog[srcName] = { candidates: (data || []).length, fetched: 0, ok: 0, blocked: 0, usable: 0, gha_deferred: false, statuses: {} };
  let got = 0, consec403 = 0;
  for (const a of (data || [])) {
    if (got >= PER_SOURCE_TARGET) break;
    if (SECTION_TITLES.test(a.title.trim())) continue;
    const r = await fetchBody(a.url);
    perSourceLog[srcName].fetched++;
    perSourceLog[srcName].statuses[r.status] = (perSourceLog[srcName].statuses[r.status] || 0) + 1;
    if (!r.ok) {
      if (r.status === 403 || r.status === 429) { perSourceLog[srcName].blocked++; consec403++; if (consec403 >= 3) { perSourceLog[srcName].gha_deferred = true; console.log(`  [${srcName}] 3× ${r.status} → CF-blocked from this IP; DEFERRED to GHA`); break; } }
      await sleep(2500); continue;
    }
    consec403 = 0; perSourceLog[srcName].ok++;
    if (r.text.length < 300) { await sleep(2000); continue; }
    // find first RARE, clean candidate
    let chosen = null;
    for (const cand of candidateTerms(a.title, r.text)) {
      const freq = await dbArticleFreq(cand);
      if (freq > RARE_MAX_DB_ARTICLES) continue;
      chosen = { term: cand, db_freq: freq }; break;
    }
    if (!chosen) { console.log(`  [${srcName}] no-rare-term ${a.title.slice(0, 45)}`); await sleep(2000); continue; }
    fixture.push({ query: chosen.term, expected_article_id: a.id, source: srcName, db_freq: chosen.db_freq, title: a.title.slice(0, 90), url: a.url });
    perSourceLog[srcName].usable++; got++;
    console.log(`  [${srcName}] +"${chosen.term}" (db_freq=${chosen.db_freq})  <- ${a.title.slice(0, 50)}`);
    await sleep(2500);
  }
}

const payload = { generated_at: new Date().toISOString(), rules: { rare_max_db_articles: RARE_MAX_DB_ARTICLES, method: 'pagefind-full-result-set' }, count: fixture.length, perSourceLog, fixture };
// MERGE mode: --splash-only writes into a separate file the GHA workflow commits,
// so a local run never clobbers GHA-measured Splash terms.
const outFile = ONLY_SPLASH ? 'tmp/search-fixture-splash.json' : 'tmp/search-fixture.json';
writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(`\nWROTE ${outFile}  count=${fixture.length}`);
console.log('per-source:', JSON.stringify(perSourceLog, null, 2));
