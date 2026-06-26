// DAILY COVERAGE AUDIT — for the top news + P&I sources, surface two anomalies,
// BOTH grounded in production's own behaviour (no re-implemented extraction, so
// no false alarms on sitemap/RSS/requires_js sources):
//
//   SIGNAL 1 — extraction break (DB-only): production's `articles_found` (from
//     scrape_logs) collapsed vs the source's own baseline, or it's been silent
//     (median 0), or the last 3 runs all errored. Catches "URL changed / selector
//     broke / source went dark".
//
//   SIGNAL 2 — coverage gap (reuses production fetchRaw): items production EXTRACTS
//     from the source right now but that are NOT in our DB (rejected by the
//     quality/date gate, or a new URL pattern). Persistent non-zero = real gap.
//
// Read-only. Run: npx tsx scripts/audit-coverage.ts [--only=Gard,Splash247]
import 'dotenv/config';
import { fetchRaw } from '../lib/scrapers/orchestrator';
import { hashUrl } from '../lib/scrapers/util';
import type { Source } from '../lib/supabase/types';

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const AUDIT_SOURCES = [
  'gCaptain', 'Splash247', 'Marine Insight', 'The Maritime Executive', 'Hellenic Shipping News',
  'Container News', 'Safety4Sea', 'Marine Log', 'Maritime Cyprus', 'Riviera Maritime Media Ltd',
  'Gard', 'UK P&I Club', 'Britannia P&I', 'Steamship Mutual', 'NorthStandard', 'Skuld',
  'Swedish Club', 'London P&I Club', 'American P&I Club', 'West of England', 'Japan P&I Club',
];
const FOUND_BASELINE_MIN = 5;  // only judge a collapse when the source normally finds >= this
const UNCAPTURED_WARN = 3;     // warn when this many extracted items are missing from our DB
const STALE_DAYS = 14;         // "dark" only after this long with zero captures. 14 (not 7) to
                               // avoid false SILENT on low-frequency sources (MoU detention lists,
                               // USCG, Panama Canal publish ~monthly). KNOWN RESIDUAL: a genuinely
                               // monthly source can still trip SILENT in a quiet stretch — proper
                               // fix is per-source cadence baselining (TODO). CHRONIC_REJECTION
                               // (found high / new ~0) is unaffected and is the higher-signal check.

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;

async function jget(path: string): Promise<any> {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
function median(ns: number[]): number {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function runAudit(topNames: string[]) {
  // Signal 1 (cheap, scrape_logs-only — incl. CHRONIC_REJECTION) runs on EVERY
  // enabled source, so a newly-broken source is caught even if it isn't on the
  // hand-picked list. Signal 2 (expensive fetchRaw coverage) runs only for the
  // top news + P&I set.
  const sources = (await jget(`sources?select=*&enabled=eq.true`)) as Source[];
  const topSet = new Set(topNames);
  const report: any[] = [];

  for (const src of sources) {
    const name = src.name;

    // SIGNAL 1 — found-count baseline (production truth), GATED on recent capture.
    // found=0 alone is NOT "broken": a fully-captured source returns 0 NEW items
    // (stop_on_known bails on already-known URLs). So we only call a source
    // silent/collapsed when found dropped AND it has captured NOTHING into the DB
    // for STALE_DAYS — that's the difference between "all caught up" and "dark".
    // (Measured 2026-06-26: UK P&I/Swedish showed found=0 but had 4/11 fresh DB
    // rows in the last week → healthy; London/American had 0 → genuinely dark.)
    const logs = await jget(`scrape_logs?select=status,articles_found,articles_new,error_message&source_id=eq.${src.id}&order=started_at.desc&limit=20`);
    const founds = logs.map((l: any) => l.articles_found ?? 0);
    const foundSum = founds.reduce((a: number, b: number) => a + b, 0);
    const newSum = logs.reduce((a: number, l: any) => a + (l.articles_new ?? 0), 0);
    // CHRONIC_REJECTION: finds plenty but inserts ~nothing AND the runs explicitly
    // report rejections. The rejRuns gate is essential — `articles_found` re-counts
    // already-known URLs every run (RSS feed size, stop_on_known re-lists), so a
    // healthy fully-caught-up source in a quiet window also has high foundSum + low
    // newSum. Only a source whose logs say "N rejected by quality filter" is truly
    // rejecting (Gard/Steamship/Japan), not just caught up.
    const rejRuns = logs.filter((l: any) => /reject/i.test(l.error_message || '')).length;
    const chronicReject = foundSum >= 20 && newSum <= 2 && rejRuns >= 3;
    const med = median(founds);
    const latest2 = founds.slice(0, 2);
    const newestRow = await jget(`articles?select=created_at&source_id=eq.${src.id}&order=created_at.desc&limit=1`);
    const newestTs = newestRow[0]?.created_at ? Date.parse(newestRow[0].created_at) : 0;
    const daysSinceCapture = newestTs ? Math.round((Date.now() - newestTs) / 86_400_000) : 999;
    const noRecentCapture = daysSinceCapture > STALE_DAYS;
    const errStreak = logs.length >= 3 && logs.slice(0, 3).every((l: any) => l.status === 'error');
    const foundCollapse = noRecentCapture && med >= FOUND_BASELINE_MIN && latest2.length >= 2 && latest2.every((f: number) => f < Math.max(2, med * 0.3));
    const silent = noRecentCapture && med === 0 && founds.length >= 4;

    // SIGNAL 2 — coverage gap. Run the REAL production extraction (so no
    // divergence on rss/sitemap/requires_js), then do the DB-presence check
    // HERE: fetchRaw does NOT filter the rss / rss_feeds branches by knownUrls,
    // so its raw output is "everything extracted", not "everything new". We
    // hash each extracted url (the SAME hashUrl production stores) and keep only
    // the ones genuinely absent from our DB → true extracted-but-not-captured.
    let extractedTotal = 0;
    let uncaptured: { title: string; url: string }[] = [], covErr: string | null = null;
    if (topSet.has(name)) try {
      const extracted = await fetchRaw(src);
      extractedTotal = extracted.length;
      const hashes = extracted.map((r) => hashUrl(r.url));
      const inDb = new Set<string>();
      for (let i = 0; i < hashes.length; i += 50) {
        const chunk = hashes.slice(i, i + 50).filter(Boolean);
        if (!chunk.length) continue;
        const rows = await jget(`articles?select=url_hash&source_id=eq.${src.id}&url_hash=in.(${chunk.join(',')})`);
        for (const r of rows) inDb.add(r.url_hash);
      }
      // Dedup by url so a list page that links the same item twice (or an rss
      // branch with dupes) doesn't double-count one missing item toward UNCAPTURED_WARN.
      const seenU = new Set<string>();
      uncaptured = extracted
        .filter((r, i) => !inDb.has(hashes[i]) && !seenU.has(r.url) && (seenU.add(r.url), true))
        .map((r) => ({ title: (r.title || '').slice(0, 60), url: r.url }));
    } catch (e: any) { covErr = (e?.message || String(e)).slice(0, 120); }

    const flags: string[] = [];
    if (errStreak) flags.push('ERROR_STREAK');
    if (silent) flags.push('SILENT');
    else if (foundCollapse) flags.push('FOUND_COLLAPSE');
    if (chronicReject) flags.push('CHRONIC_REJECTION');
    if (uncaptured.length >= UNCAPTURED_WARN) flags.push('UNCAPTURED_ITEMS');
    if (covErr) flags.push('EXTRACT_ERROR');

    report.push({ name, type: src.type, foundMedian: med, latestFound: latest2, foundSum, newSum, daysSinceCapture, extracted: extractedTotal, uncaptured: uncaptured.length, flags, sample: uncaptured.slice(0, 4), covErr });
    if (flags.length) console.log(`  ${name.padEnd(26)} found(med ${med}, Σ${foundSum}/new Σ${newSum}) lastCap ${daysSinceCapture}d | not-in-DB ${covErr ? 'ERR' : uncaptured.length} ⚠ ${flags.join(',')}`);
  }
  return report;
}

const FEED_STALE_HOURS = 4;    // homepage feed should be within ~2 delta cycles of the DB
const BASE_STALE_DAYS = 9;     // base index (full-archive search) rebuilds weekly → flag at >9d

// SITE FRESHNESS (gap #2, 2026-06-26) — the one user-visible failure with no alarm:
// the deployed feed/search can lag the DB (publish-delta stopped) or the base
// search index can age out (source-filtered search showed 3-day-stale). Compares
// what the LIVE site shows to what the DB has — no GHA cross-repo token needed for
// FEED_STALE; BASE_STALE uses V2_DISPATCH_TOKEN if present (else skipped, noted).
async function checkSiteFreshness(): Promise<{ name: string; flags: string[]; note: string }> {
  const flags: string[] = [];
  const notes: string[] = [];
  // FEED_STALE — apex newest <time> vs DB newest feed-eligible (matches the feed query)
  try {
    const html = await (await fetch('https://maritimereader.com/', { headers: { 'User-Agent': 'coverage-audit' } })).text();
    const m = html.match(/datetime="([^"]+)"/);
    const siteNewest = m ? Date.parse(m[1]) : NaN;
    const dbRows = await jget(`articles?select=published_at&content_quality=in.(visible,pending)&published_at_source=neq.scraper_default&published_at=lte.${new Date().toISOString()}&order=published_at.desc&limit=1`);
    const dbNewest = dbRows[0]?.published_at ? Date.parse(dbRows[0].published_at) : NaN;
    if (!Number.isNaN(siteNewest) && !Number.isNaN(dbNewest)) {
      const lagH = (dbNewest - siteNewest) / 3_600_000;
      notes.push(`feed lag ${lagH.toFixed(1)}h (site ${m![1].slice(0, 16)} vs DB ${dbRows[0].published_at.slice(0, 16)})`);
      if (lagH > FEED_STALE_HOURS) flags.push('FEED_STALE');
    } else if (Number.isNaN(siteNewest) && !Number.isNaN(dbNewest)) {
      // Homepage rendered NO <time> (empty/garbled feed) while the DB HAS content —
      // the worst failure mode. Must ALARM, not stay a silent note.
      flags.push('FEED_STALE');
      notes.push('feed: NO dated article on homepage but DB has content (empty/broken build?)');
    } else notes.push('feed freshness: could not read site/DB newest');
  } catch (e: any) { notes.push('feed check error: ' + (e?.message || e).slice(0, 60)); }
  // BASE_STALE — last successful deploy-base age (needs cross-repo token)
  const tok = process.env.V2_DISPATCH_TOKEN;
  if (tok) {
    try {
      const runs = await (await fetch('https://api.github.com/repos/tufanography/maritime-reader-v2/actions/workflows/deploy-base.yml/runs?status=success&per_page=1', { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'coverage-audit' } })).json();
      const last = runs?.workflow_runs?.[0]?.created_at;
      if (last) {
        const days = (Date.now() - Date.parse(last)) / 86_400_000;
        notes.push(`base build ${days.toFixed(1)}d ago`);
        if (days > BASE_STALE_DAYS) flags.push('BASE_STALE');
      }
    } catch (e: any) { notes.push('base-age check error'); }
  } else notes.push('base-age skipped (no V2_DISPATCH_TOKEN)');
  return { name: 'SITE FRESHNESS', flags, note: notes.join(' · ') };
}

// CRITICAL = a source broke / site is stale (acts on it); the rest are coverage FYIs.
const CRITICAL = new Set(['SILENT', 'ERROR_STREAK', 'FOUND_COLLAPSE', 'EXTRACT_ERROR', 'MISSING_SOURCE', 'FEED_STALE', 'BASE_STALE']);

function buildBody(report: any[]): string {
  const crit = report.filter((r) => (r.flags || []).some((f: string) => CRITICAL.has(f)));
  const chronic = report.filter((r) => (r.flags || []).includes('CHRONIC_REJECTION') && !crit.includes(r));
  const gaps = report.filter((r) => (r.flags || []).includes('UNCAPTURED_ITEMS') && !crit.includes(r) && !chronic.includes(r));
  let b = `Daily coverage audit of ${report.length} enabled sources. Signal 1 (scrape_logs found/new — incl. CHRONIC_REJECTION) runs on all; Signal 2 (fetchRaw coverage) on the top news + P&I set. Grounded in production, so no re-implementation false alarms.\n\n`;
  b += `## 🚨 Broken / silent (${crit.length})\n`;
  if (!crit.length) b += `_none_\n`;
  for (const r of crit) b += `- **${r.name}** [${r.flags.join(', ')}] — ${r.note ?? `found median ${r.foundMedian}, last ${JSON.stringify(r.latestFound)}, nothing captured in ${r.daysSinceCapture} day(s)`}\n`;
  b += `\n## 🔁 Chronic rejection — finds content but captures ~none (${chronic.length})\n`;
  if (!chronic.length) b += `_none_\n`;
  for (const r of chronic) b += `- **${r.name}** — found Σ${r.foundSum} / new Σ${r.newSum} over last 20 runs (dateless circulars, login wall, or quality reject)\n`;
  b += `\n## 📉 Coverage gaps — extracted but not in our DB (${gaps.length})\n`;
  if (!gaps.length) b += `_none_\n`;
  for (const r of gaps) {
    b += `- **${r.name}** — ${r.uncaptured} of ${r.extracted} extracted items are NOT captured (rejected by quality/date gate or new URL pattern):\n`;
    for (const s of (r.sample || [])) b += `    - ${s.title} — ${s.url}\n`;
  }
  b += `\nNote: multi-job sources (Steamship/West/etc.) rotate one job-group per run, so a single audit samples one group; coverage flags clear/appear across the rotation. <!-- coverage-audit -->`;
  return b;
}

async function postIssue(report: any[]) {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return; // local run — console only
  const flagged = report.filter((r) => r.flags && r.flags.length);
  const gh = (path: string, init?: any) => fetch(`https://api.github.com/repos/${repo}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'coverage-audit' } });
  const existing = await (await gh(`issues?state=open&labels=coverage-audit`)).json();
  const open = Array.isArray(existing) ? existing[0] : null;
  const critCount = report.filter((r) => (r.flags || []).some((f: string) => CRITICAL.has(f))).length;
  if (!flagged.length) {
    if (open) { await gh(`issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) }); console.log(`closed audit issue #${open.number} (all clear)`); }
    return;
  }
  const title = `🔎 Coverage audit — ${critCount} broken, ${flagged.length - critCount} coverage gap(s)`;
  const body = buildBody(report);
  if (open) { await gh(`issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ title, body, state: 'open' }) }); console.log(`updated audit issue #${open.number}`); }
  else { const r = await (await gh(`issues`, { method: 'POST', body: JSON.stringify({ title, body, labels: ['coverage-audit'] }) })).json(); console.log(`opened audit issue #${r.number}`); }
}

if (process.argv[1] && process.argv[1].includes('audit-coverage')) {
  (async () => {
    const report = await runAudit(ONLY || AUDIT_SOURCES);
    report.unshift(await checkSiteFreshness());   // site-level FEED_STALE / BASE_STALE (gap #2)
    const flagged = report.filter((r) => r.flags && r.flags.length);
    console.log(`\n=== AUDIT SUMMARY: ${flagged.length} flagged ===`);
    for (const r of flagged) {
      if (r.note && r.foundMedian === undefined) { console.log(`\n[${r.flags.join(', ')}] ${r.name} — ${r.note}`); continue; }
      console.log(`\n[${r.flags.join(', ')}] ${r.name} (found med ${r.foundMedian}, last ${JSON.stringify(r.latestFound)}; ${r.uncaptured}/${r.extracted} extracted-but-not-in-DB)`);
      for (const s of (r.sample || [])) console.log(`    • ${s.title}  ${s.url}`);
      if (r.covErr) console.log(`    extract error: ${r.covErr}`);
    }
    await postIssue(report);
  })();
}
