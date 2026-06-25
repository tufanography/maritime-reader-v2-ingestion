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

export async function runAudit(names: string[]) {
  const sources = await jget(`sources?select=*&enabled=eq.true`);
  const byName = new Map(sources.map((s: any) => [s.name, s]));
  const report: any[] = [];

  for (const name of names) {
    const src = byName.get(name) as Source | undefined;
    if (!src) { report.push({ name, flags: ['MISSING_SOURCE'] }); console.log(`  ${name}: MISSING_SOURCE`); continue; }

    // SIGNAL 1 — found-count baseline (production truth)
    const logs = await jget(`scrape_logs?select=status,articles_found&source_id=eq.${src.id}&order=started_at.desc&limit=10`);
    const founds = logs.map((l: any) => l.articles_found ?? 0);
    const med = median(founds);
    const latest2 = founds.slice(0, 2);
    const errStreak = logs.length >= 3 && logs.slice(0, 3).every((l: any) => l.status === 'error');
    const foundCollapse = med >= FOUND_BASELINE_MIN && latest2.length >= 2 && latest2.every((f: number) => f < Math.max(2, med * 0.3));
    const silent = med === 0 && founds.length >= 4;

    // SIGNAL 2 — coverage gap. Run the REAL production extraction (so no
    // divergence on rss/sitemap/requires_js), then do the DB-presence check
    // HERE: fetchRaw does NOT filter the rss / rss_feeds branches by knownUrls,
    // so its raw output is "everything extracted", not "everything new". We
    // hash each extracted url (the SAME hashUrl production stores) and keep only
    // the ones genuinely absent from our DB → true extracted-but-not-captured.
    let extractedTotal = 0;
    let uncaptured: { title: string; url: string }[] = [], covErr: string | null = null;
    try {
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
      uncaptured = extracted.filter((_, i) => !inDb.has(hashes[i])).map((r) => ({ title: (r.title || '').slice(0, 60), url: r.url }));
    } catch (e: any) { covErr = (e?.message || String(e)).slice(0, 120); }

    const flags: string[] = [];
    if (errStreak) flags.push('ERROR_STREAK');
    if (silent) flags.push('SILENT');
    else if (foundCollapse) flags.push('FOUND_COLLAPSE');
    if (uncaptured.length >= UNCAPTURED_WARN) flags.push('UNCAPTURED_ITEMS');
    if (covErr) flags.push('EXTRACT_ERROR');

    report.push({ name, type: src.type, foundMedian: med, latestFound: latest2, extracted: extractedTotal, uncaptured: uncaptured.length, flags, sample: uncaptured.slice(0, 4), covErr });
    console.log(`  ${name.padEnd(26)} found(med ${med}, last ${JSON.stringify(latest2)}) | extracted ${extractedTotal}, not-in-DB ${covErr ? 'ERR' : uncaptured.length} ${flags.length ? '⚠ ' + flags.join(',') : 'ok'}`);
  }
  return report;
}

// CRITICAL = a source broke (acts on it); the rest are coverage FYIs.
const CRITICAL = new Set(['SILENT', 'ERROR_STREAK', 'FOUND_COLLAPSE', 'EXTRACT_ERROR', 'MISSING_SOURCE']);

function buildBody(report: any[]): string {
  const crit = report.filter((r) => (r.flags || []).some((f: string) => CRITICAL.has(f)));
  const gaps = report.filter((r) => (r.flags || []).includes('UNCAPTURED_ITEMS') && !crit.includes(r));
  let b = `Daily coverage audit of ${report.length} top sources. Signals are grounded in production (scrape_logs \`articles_found\` + the real \`fetchRaw\` extraction), so no re-implementation false alarms.\n\n`;
  b += `## 🚨 Broken / silent (${crit.length})\n`;
  if (!crit.length) b += `_none_\n`;
  for (const r of crit) b += `- **${r.name}** [${r.flags.join(', ')}] — found median ${r.foundMedian}, last ${JSON.stringify(r.latestFound)}\n`;
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
    const flagged = report.filter((r) => r.flags && r.flags.length);
    console.log(`\n=== AUDIT SUMMARY: ${flagged.length}/${report.length} sources flagged ===`);
    for (const r of flagged) {
      console.log(`\n[${r.flags.join(', ')}] ${r.name} (found med ${r.foundMedian}, last ${JSON.stringify(r.latestFound)}; ${r.uncaptured}/${r.extracted} extracted-but-not-in-DB)`);
      for (const s of (r.sample || [])) console.log(`    • ${s.title}  ${s.url}`);
      if (r.covErr) console.log(`    extract error: ${r.covErr}`);
    }
    await postIssue(report);
  })();
}
