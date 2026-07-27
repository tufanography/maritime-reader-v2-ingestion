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
const FEED_LAG_HOURS = 12;     // our newest real article vs the source's LIVE feed newest.
                               // Healthy sources lag < ~5h (one scrape interval + article
                               // age); 12h = clearly "serving stale content". Self-calibrates:
                               // a genuinely quiet source has a live-newest that's old too, so
                               // the lag stays ~0 and it never false-flags.
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
    // SILENT gate uses PUBLISH cadence, not capture timing. created_at is polluted
    // by bulk backfills (a source backfilled in one batch then quiet looks "silent"
    // via created_at even though its real publish rhythm is fine — the v2 cutover +
    // backfills made created_at meaningless for this). Baseline each source's OWN
    // rhythm from published_at (real dates only — exclude scraper_default), in
    // DISTINCT PUBLISHING DAYS so a same-day burst (USCG) isn't a ~0 gap. SILENT
    // only when the newest real article is older than 3x the source's median
    // day-gap, clamped [3,365], with a 60d floor for low-data sources (ultra-rare
    // or single-burst sources aren't false-flagged). Validated 2026-06-27 on the
    // live set: USCG/Caribbean/Black Sea/NorthStandard cleared, London/Xinde kept.
    const pubRows = await jget(`articles?select=published_at&source_id=eq.${src.id}&published_at_source=neq.scraper_default&published_at=lte.${new Date().toISOString()}&order=published_at.desc&limit=120`);
    const pubTimes = (pubRows as any[]).map((r) => Date.parse(r.published_at)).filter((n) => !Number.isNaN(n));
    let noRecentCapture: boolean;
    if (pubTimes.length >= 4) {
      const pubStaleDays = (Date.now() - pubTimes[0]) / 86_400_000;
      const days = [...new Set(pubTimes.map((t) => Math.floor(t / 86_400_000)))].sort((a, b) => b - a);
      const dGaps: number[] = [];
      for (let i = 1; i < days.length; i++) dGaps.push(days[i - 1] - days[i]);
      const cadence = Math.max(3, Math.min(365, 3 * median(dGaps)));
      const threshold = days.length < 6 ? Math.max(60, cadence) : cadence;
      noRecentCapture = pubStaleDays > threshold;
    } else {
      noRecentCapture = daysSinceCapture > STALE_DAYS;  // too few real dates to baseline → flat fallback
    }
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
    let srcNewestPub = NaN;   // the source's LIVE newest published_at (from fetchRaw)
    let uncaptured: { title: string; url: string }[] = [], covErr: string | null = null;
    if (topSet.has(name)) try {
      const extracted = await fetchRaw(src);
      extractedTotal = extracted.length;
      const extPubs = extracted.map((r) => (r.published_at ? Date.parse(r.published_at) : NaN)).filter((n) => !Number.isNaN(n));
      srcNewestPub = extPubs.length ? Math.max(...extPubs) : NaN;
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

    // SIGNAL 3 — FEED_LAG: our newest real article vs the source's LIVE newest (from the
    // same fetchRaw, so no extra fetch). Catches "scraper reports success but serves STALE
    // content" — the exact failure Splash247 hid behind found=10/new=0 when a CDN handed
    // the scraper a stale cached feed for ~24h (MEASURED 2026-07-16: our newest lagged the
    // live feed 18h). found-count checks miss it (count stays healthy); comparing us to the
    // source directly self-calibrates — a genuinely quiet source lags ~0.
    let feedLagH: number | null = null;
    if (!Number.isNaN(srcNewestPub) && pubTimes.length) feedLagH = (srcNewestPub - pubTimes[0]) / 3_600_000;

    const flags: string[] = [];
    if (errStreak) flags.push('ERROR_STREAK');
    if (silent) flags.push('SILENT');
    else if (foundCollapse) flags.push('FOUND_COLLAPSE');
    if (chronicReject) flags.push('CHRONIC_REJECTION');
    if (feedLagH != null && feedLagH > FEED_LAG_HOURS) flags.push('FEED_LAG');
    if (uncaptured.length >= UNCAPTURED_WARN) flags.push('UNCAPTURED_ITEMS');
    if (covErr) flags.push('EXTRACT_ERROR');

    const lagNote = (feedLagH != null && feedLagH > FEED_LAG_HOURS)
      ? `our newest article is ${Math.round(feedLagH)}h behind ${name}'s LIVE feed — the scraper looks healthy (found ${med}/run) but is serving stale content`
      : undefined;
    report.push({ name, type: src.type, foundMedian: med, latestFound: latest2, foundSum, newSum, daysSinceCapture, extracted: extractedTotal, uncaptured: uncaptured.length, feedLagH: feedLagH == null ? null : Math.round(feedLagH), note: lagNote, flags, sample: uncaptured.slice(0, 4), covErr });
    if (flags.length) console.log(`  ${name.padEnd(26)} found(med ${med}, Σ${foundSum}/new Σ${newSum}) lastCap ${daysSinceCapture}d${feedLagH != null ? ' feedLag ' + feedLagH.toFixed(0) + 'h' : ''} | not-in-DB ${covErr ? 'ERR' : uncaptured.length} ⚠ ${flags.join(',')}`);
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

// CRITICAL = a source broke / site is stale (emails on it); the rest are coverage FYIs.
// EXTRACT_ERROR is NOT critical: it means the AUDIT's own fetchRaw threw (often a
// requires_js/CF render hiccup) while the source itself may be capturing fine
// (NorthStandard 2026-06-26: EXTRACT_ERROR but 28 articles captured that day). Real
// outages are caught by SILENT/ERROR_STREAK/FOUND_COLLAPSE; EXTRACT_ERROR stays a
// FYI so it never emails a false "broken" alarm.
const CRITICAL = new Set(['SILENT', 'ERROR_STREAK', 'FOUND_COLLAPSE', 'FEED_LAG', 'MISSING_SOURCE', 'FEED_STALE', 'BASE_STALE']);

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
  // crit-sources marker: the SET of CRITICAL source names the last write recorded,
  // so the next run can diff it and email only on what NEWLY entered.
  //
  // This replaces a `crit-state:<count>` marker gated on 0→N. That gate was a design
  // error: it can only fire when the board is completely green first, and a real
  // system with 55 sources is never completely green. MEASURED 2026-07-27: 11 sources
  // critical, issue #1 open and updated daily since 2026-06-26, Splash247 72h behind
  // and Safety4Sea 92h behind — and not one email had ever been sent, because the
  // count never returned to 0. The monitor was working; nobody was being told.
  // A set-diff fires on the event that actually matters (a source that was fine is
  // now broken) and stays quiet on a persisting baseline.
  const critNames = JSON.stringify(crit.map((r) => r.name).sort());
  b += `\nNote: multi-job sources (Steamship/West/etc.) rotate one job-group per run, so a single audit samples one group; coverage flags clear/appear across the rotation. <!-- coverage-audit --><!-- crit-sources:${critNames} -->`;
  return b;
}

// Scoped alarm email (Resend, direct API — GHA-safe). Mirrors source-health's
// proven transition-only design: sent ONLY when CRITICAL count crosses 0↔N, never
// on a persisting state, so the standing chronic/coverage-gap baseline (known: ~4
// dark P&I, ~14 chronic) does NOT flood the inbox — those live in the issue only.
async function sendEmail(subject: string, html: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  const from = process.env.RESEND_FROM_ADDRESS || 'Maritime Reader <onboarding@resend.dev>';
  if (!key || !to) { console.log('  (no RESEND_API_KEY/ALERT_EMAIL → email skipped)'); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    console.log(res.ok ? '  ✉️  alert email sent' : `  email FAILED ${res.status}: ${await res.text()}`);
  } catch (e: any) { console.log('  email FAILED', e.message); }
}

const critLi = (r: any) =>
  `<li><strong>${r.name}</strong> [${(r.flags || []).join(', ')}] — ${r.note ?? `found median ${r.foundMedian}, nothing captured in ${r.daysSinceCapture} day(s)`}</li>`;

// `newly` is what changed since the last audit and leads the mail; `persisting` is
// the standing baseline, listed after so the new break is never buried in it.
function critHtml(newly: any[], persisting: any[] = []): string {
  const UL = 'style="font-family:ui-monospace,monospace;font-size:13px"';
  return `<p><strong>Maritime Reader — coverage audit</strong></p>` +
    `<p>${newly.length} source(s) newly broken since the last audit:</p>` +
    `<ul ${UL}>` + newly.map(critLi).join('') + `</ul>` +
    (persisting.length
      ? `<p style="color:#666">Still broken from before (${persisting.length}, already reported):</p>` +
        `<ul ${UL} >` + persisting.map(critLi).join('') + `</ul>`
      : '') +
    `<p style="color:#666;font-size:12px">Full detail (chronic rejections + coverage gaps) is in the GitHub coverage-audit issue. ${new Date().toISOString()}</p>`;
}

async function postIssue(report: any[]) {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return; // local run — console only
  const flagged = report.filter((r) => r.flags && r.flags.length);
  const gh = (path: string, init?: any) => fetch(`https://api.github.com/repos/${repo}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'coverage-audit' } });
  const existing = await (await gh(`issues?state=open&labels=coverage-audit`)).json();
  const open = Array.isArray(existing) ? existing[0] : null;
  const critRows = report.filter((r) => (r.flags || []).some((f: string) => CRITICAL.has(f)));
  const critCount = critRows.length;
  // Prior CRITICAL source SET, read from the marker the LAST write embedded, so we
  // can diff instead of counting. Falls back to the legacy crit-state:<count> marker
  // for the first run after this change: an unknown prior set means every current
  // critical reads as "newly entered" and one catch-up email goes out — which is the
  // right behaviour, since the 0→N gate meant they were never reported at all.
  const setMatch = (open?.body || '').match(/<!-- crit-sources:(\[.*?\]) -->/);
  let priorNames: string[] | null = null;
  if (setMatch) { try { priorNames = JSON.parse(setMatch[1]); } catch { priorNames = null; } }
  const priorSet = new Set(priorNames ?? []);
  const priorCrit = priorNames ? priorNames.length : (+(((open?.body || '').match(/<!-- crit-state:(\d+) -->/) || [])[1] ?? 0));

  const newlyBroken = critRows.filter((r) => !priorSet.has(r.name));
  const persisting = critRows.filter((r) => priorSet.has(r.name));
  const recovered = [...priorSet].filter((n) => !critRows.some((r) => r.name === n));

  if (!flagged.length) {
    if (open) {
      await gh(`issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
      console.log(`closed audit issue #${open.number} (all clear)`);
      // Email on resolve ONLY if the issue we just closed had CRITICAL signals —
      // a gaps-only issue closing is routine and stays silent.
      if (priorCrit > 0) await sendEmail('✅ Maritime Reader: coverage audit clear', '<p>All previously-flagged source/site issues have cleared — the coverage audit is green again.</p>');
    }
    return;
  }
  const title = `🔎 Coverage audit — ${critCount} broken, ${flagged.length - critCount} coverage gap(s)`;
  const body = buildBody(report);
  if (open) { await gh(`issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ title, body, state: 'open' }) }); console.log(`updated audit issue #${open.number}`); }
  else { const r = await (await gh(`issues`, { method: 'POST', body: JSON.stringify({ title, body, labels: ['coverage-audit'] }) })).json(); console.log(`opened audit issue #${r.number}`); }

  // Delta email — fires on what CHANGED, not on how many are broken:
  //   newly entered → ping, listing the new breaks first and the standing ones after.
  //   all cleared   → ping "cleared".
  // A source that was already critical yesterday sends nothing today, so the standing
  // baseline (dark P&I clubs, chronic rejections) stays in the issue and out of the
  // inbox — while a source that breaks TODAY is reported the same day.
  if (newlyBroken.length) {
    const subj = newlyBroken.length === 1
      ? `🔴 Maritime Reader: ${newlyBroken[0].name} just broke`
      : `🔴 Maritime Reader: ${newlyBroken.length} sources just broke`;
    await sendEmail(subj, critHtml(newlyBroken, persisting));
  } else if (critCount === 0 && priorCrit > 0) {
    await sendEmail('✅ Maritime Reader: critical coverage issues cleared',
      `<p>The critical source/site issues have cleared (coverage gaps may remain — tracked in the GitHub issue).</p>` +
      (recovered.length ? `<p>Recovered: ${recovered.join(', ')}</p>` : ''));
  }
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
