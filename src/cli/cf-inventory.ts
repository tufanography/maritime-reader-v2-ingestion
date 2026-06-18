// CF-protection inventory across all enabled RSS sources. Read-only.
//
// 11. madde of Phase 2.5: data-driven Playwright decision. For each RSS
// source, fetch its feed → take one article URL → run fetchDetail() →
// classify HTTP outcome. Counts how many sources Cloudflare/Akamai TLS-
// fingerprinting locks out of Node's undici fetch (Splash247 was the
// first; we need to know if there are 1 or 11 like it).
//
// Output: console summary + tmp/cf-inventory-<ts>.json with per-source
// rows. Polite 2s delay between probes (~21 sources × ~3-5s each → 1-2 min).
//
// Usage:  npx tsx src/cli/cf-inventory.ts
//
// What the result drives:
//   ≤2 CF-blocked  → Playwright stays deferred (not worth 150MB chromium).
//   3-7 CF-blocked → Playwright becomes a Phase 2.5+ subphase.
//   ≥8 CF-blocked  → Playwright is the next priority after sitemap rollout.

import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import Parser from 'rss-parser';
import { createClient } from '@supabase/supabase-js';
import { fetchDetail } from '@/lib/extract/detail-fetch';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const PROBE_DELAY_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Verdict =
  | 'accessible'           // HTTP 200, content read
  | 'cf_blocked_403'       // HTTP 403 — classic CF TLS-fingerprint signature
  | 'cf_blocked_other'     // 503/429/418 — other CF/anti-bot signatures
  | 'feed_unreachable'     // RSS feed itself failed (can't even probe detail)
  | 'no_items_in_feed'     // Feed parsed but empty
  | 'network_error'        // detail-fetch threw / aborted
  | 'other_http_error';    // 4xx/5xx that isn't 403/503/429

type Row = {
  source_name: string;
  feed_url: string;
  sample_article_url: string | null;
  http_status: number | null;
  fetch_error: string | null;
  verdict: Verdict;
  notes: string;
};

function classify(httpStatus: number | null, fetchError: string | null): Verdict {
  if (fetchError && httpStatus === null) return 'network_error';
  if (httpStatus === 200) return 'accessible';
  if (httpStatus === 403) return 'cf_blocked_403';
  if (httpStatus === 503 || httpStatus === 429 || httpStatus === 418) {
    return 'cf_blocked_other';
  }
  return 'other_http_error';
}

async function pickSampleUrl(feedUrl: string): Promise<string | null> {
  const parser = new Parser({ timeout: 15_000 });
  const feed = await parser.parseURL(feedUrl);
  const first = (feed.items ?? []).find((i) => !!i.link);
  return first?.link ?? null;
}

async function probeSource(name: string, feedUrl: string): Promise<Row> {
  let sampleUrl: string | null = null;
  try {
    sampleUrl = await pickSampleUrl(feedUrl);
  } catch (e) {
    return {
      source_name: name,
      feed_url: feedUrl,
      sample_article_url: null,
      http_status: null,
      fetch_error: (e as Error).message,
      verdict: 'feed_unreachable',
      notes: 'RSS feed parse failed; cannot reach detail page.',
    };
  }
  if (!sampleUrl) {
    return {
      source_name: name,
      feed_url: feedUrl,
      sample_article_url: null,
      http_status: null,
      fetch_error: null,
      verdict: 'no_items_in_feed',
      notes: 'Feed parsed but contained zero items with a link.',
    };
  }

  const r = await fetchDetail(sampleUrl);
  return {
    source_name: name,
    feed_url: feedUrl,
    sample_article_url: sampleUrl,
    http_status: r.httpStatus,
    fetch_error: r.fetchError,
    verdict: classify(r.httpStatus, r.fetchError),
    notes: '',
  };
}

async function main() {
  const { data, error } = await sb
    .from('sources')
    .select('name, feed_url, enabled')
    .eq('enabled', true)
    .not('feed_url', 'is', null)
    .order('name');
  if (error) throw new Error(error.message);

  const sources = (data ?? []) as { name: string; feed_url: string }[];
  console.log(`CF-protection inventory: ${sources.length} RSS source(s) to probe`);
  console.log(`Polite delay: ${PROBE_DELAY_MS}ms between probes\n`);

  const rows: Row[] = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (i > 0) await sleep(PROBE_DELAY_MS);
    const tag = `[${String(i + 1).padStart(2)}/${sources.length}]`;
    process.stdout.write(`${tag} ${s.name.padEnd(36)} `);
    try {
      const row = await probeSource(s.name, s.feed_url);
      rows.push(row);
      const httpLabel = row.http_status !== null ? `HTTP ${row.http_status}` : '----';
      console.log(`${httpLabel.padEnd(10)} ${row.verdict}`);
    } catch (e) {
      const row: Row = {
        source_name: s.name,
        feed_url: s.feed_url,
        sample_article_url: null,
        http_status: null,
        fetch_error: (e as Error).message,
        verdict: 'network_error',
        notes: 'Unexpected throw in probeSource.',
      };
      rows.push(row);
      console.log(`----       network_error  (${(e as Error).message})`);
    }
  }

  // Tallies.
  const counts: Record<Verdict, number> = {
    accessible: 0,
    cf_blocked_403: 0,
    cf_blocked_other: 0,
    feed_unreachable: 0,
    no_items_in_feed: 0,
    network_error: 0,
    other_http_error: 0,
  };
  for (const r of rows) counts[r.verdict]++;

  console.log(`\n── Verdict distribution (${rows.length} source(s)) ──`);
  const order: Verdict[] = [
    'accessible',
    'cf_blocked_403',
    'cf_blocked_other',
    'other_http_error',
    'network_error',
    'feed_unreachable',
    'no_items_in_feed',
  ];
  for (const v of order) {
    const c = counts[v];
    if (c === 0) continue;
    const pct = Math.round((c / rows.length) * 100);
    console.log(`  ${v.padEnd(20)} ${String(c).padStart(3)} (${pct}%)`);
  }

  const cfBlocked = counts.cf_blocked_403 + counts.cf_blocked_other;
  console.log(`\n── Playwright decision input ──`);
  console.log(`  CF-blocked total: ${cfBlocked} / ${rows.length}`);
  if (cfBlocked <= 2) {
    console.log(`  → Playwright stays DEFERRED. ${cfBlocked} blocked source(s) accept`);
    console.log(`    graceful medium-confidence fallback (rss_pubdate only).`);
  } else if (cfBlocked <= 7) {
    console.log(`  → Playwright becomes a Phase 2.5+ SUBPHASE candidate.`);
    console.log(`    ${cfBlocked} sources lose detail signals — worth ~150MB chromium`);
    console.log(`    if cross-signal high-confidence dates matter for them.`);
  } else {
    console.log(`  → Playwright is the NEXT PRIORITY after sitemap rollout.`);
    console.log(`    ${cfBlocked} blocked sources are a majority of the RSS bucket;`);
    console.log(`    graceful-degradation is no longer an acceptable default.`);
  }

  // List the CF-blocked sources for the audit trail.
  if (cfBlocked > 0) {
    console.log(`\n── CF-blocked sources ──`);
    for (const r of rows) {
      if (r.verdict === 'cf_blocked_403' || r.verdict === 'cf_blocked_other') {
        console.log(`  • ${r.source_name}  (HTTP ${r.http_status})`);
      }
    }
  }

  // Write audit JSON.
  if (!existsSync('tmp')) mkdirSync('tmp');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `tmp/cf-inventory-${ts}.json`;
  writeFileSync(
    path,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        sources_probed: rows.length,
        counts,
        cf_blocked_total: cfBlocked,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`\nAudit JSON: ${path}`);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
