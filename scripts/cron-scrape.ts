// GitHub Actions runner for the scheduled scrape. Replaces hitting
// the /api/cron/scrape Vercel endpoint, which had a 60-second
// function-timeout problem on the Hobby plan — slow sources
// (Shipowners' Club, American P&I etc) couldn't finish there.
//
// Running here, the workflow has 10 minutes total before GHA kills
// it, plenty for our 8-source rotation. Each source gets whatever
// time it needs.

import 'dotenv/config';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import { scrapeAllDue } from '../lib/scrapers/orchestrator';
import { closePlaywright } from '../lib/scrapers/playwright-fetcher';

async function main() {
  // Force flag: skip the per-source "due" check and scrape every
  // enabled source. Triggered either by passing --force on the CLI or
  // by setting SCRAPE_FORCE=1 in the environment (the GHA workflow_dispatch
  // input wires through to that env var). Off by default so scheduled
  // runs still respect each source's interval.
  const force = process.argv.includes('--force') || process.env.SCRAPE_FORCE === '1';

  // Runner: 'cloud' = sources we scrape from GitHub Actions (default).
  // 'local' = Cloudflare-blocked sources the operator runs from a
  // residential IP via Windows Task Scheduler. The orchestrator filters
  // the source list on this column (migration 027).
  // Read from `--runner=local` / `--runner=cloud` CLI arg or
  // SCRAPE_RUNNER env var. Omit to scrape every source regardless.
  const cliRunner = process.argv.find((a) => a.startsWith('--runner='))?.slice('--runner='.length);
  const envRunner = process.env.SCRAPE_RUNNER;
  const runner = (cliRunner || envRunner || '').trim().toLowerCase();
  const runnerOpt: 'cloud' | 'local' | undefined =
    runner === 'cloud' ? 'cloud' : runner === 'local' ? 'local' : undefined;

  const t0 = Date.now();
  const results = await scrapeAllDue({ force, runner: runnerOpt });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (force) console.log('(force mode — ignoring per-source intervals)');
  if (runnerOpt) console.log(`(runner: ${runnerOpt} — sources tagged 'runner=${runnerOpt}' only)`);

  let totalInserted = 0;
  for (const r of results) totalInserted += r.inserted ?? 0;

  console.log(`\nDone in ${dt}s — ${results.length} source(s) ran, ${totalInserted} new article(s)\n`);
  console.log('Per-source results:');
  for (const r of results) {
    console.log(`  [${r.status}] ${r.source_name?.padEnd(32) ?? '?'} inserted=${r.inserted ?? 0}${r.error ? ' err=' + r.error.slice(0, 60) : ''}`);
  }

  // Release the Playwright browser before exiting. Without this the lazily-
  // launched Chromium (used by requires_js sources) stays connected and keeps
  // Node's event loop alive — the process can't exit on its own, so the GHA
  // job sits idle after "Done" until the job timeout KILLS it and the run is
  // marked "cancelled" (root-caused 2026-06-29: 8/8 cancelled runs had a
  // chrome-headless-shell orphan + a multi-minute post-"Done" hang; clean-exit
  // runs had neither). closePlaywright() force-closes the browser even if a
  // requires_js source left a dangling page.goto after its per-source timeout;
  // the explicit exit(0) is a bulletproof backstop so a stray handle can never
  // pad the run out to the timeout again.
  await closePlaywright();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
