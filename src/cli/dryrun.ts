// Phase 2.1 dry-run CLI.
// Discovers items for a source, runs deterministic extraction + dedup,
// emits a DryRunReport JSON to tmp/. NO DB MUTATION (D1).
//
// Usage:
//   npm run dryrun -- splash247
//   npx tsx src/cli/dryrun.ts splash247

import 'dotenv/config';
import { findBySlug, SOURCES } from '@/sources/registry';
import { runSourceDryRun, writeReport } from '@/lib/orchestrator/run-source';

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('usage: npx tsx src/cli/dryrun.ts <source-slug>');
    console.error(`available slugs: ${SOURCES.map((s) => s.slug).join(', ')}`);
    process.exit(2);
  }
  const source = findBySlug(slug);
  if (!source) {
    console.error(`unknown source slug: "${slug}". known: ${SOURCES.map((s) => s.slug).join(', ')}`);
    process.exit(2);
  }

  // D22 — paywalled source short-circuit. No discovery, no detail-fetch,
  // no DB read. Exits cleanly (code 0) with a status line so batch
  // loops that iterate over all sources don't error out, they just see
  // "skipped: paywalled" and move on.
  if (source.paywalled) {
    console.log(`Skipped: ${source.name} (mode=${source.mode}) — source marked paywalled in registry (D22). No discovery, no detail-fetch, no DB read. Re-enable by setting paywalled:false when open access is confirmed.`);
    process.exit(0);
  }

  console.log(`Dry-run: ${source.name} (mode=${source.mode}) — NO DB WRITE\n`);
  const t0 = Date.now();
  const report = await runSourceDryRun(source);
  const path = writeReport(report, source.slug);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`═══ Dry-run summary ═══`);
  console.log(`  source:           ${report.source_name}`);
  console.log(`  discovered:       ${report.discovered_count}`);
  console.log(`  would_insert:     ${report.would_insert}`);
  console.log(`  duplicate:        ${report.duplicate}`);
  console.log(`  rejected:         ${report.rejected}`);
  console.log(`  fetch_failed:     ${report.fetch_failed}`);
  console.log(`  elapsed:          ${dt}s`);
  console.log(`  report written:   ${path}\n`);

  // Surface a few would-insert sample lines for at-a-glance sanity.
  const toShow = report.outcomes
    .filter((o) => o.scraper_decision === 'would_insert')
    .slice(0, 5);
  if (toShow.length > 0) {
    console.log(`── First ${toShow.length} would-insert (raw → parsed date sanity, D7) ──`);
    for (const o of toShow) {
      console.log(`  ${o.proposed_record?.title?.slice(0, 70)}`);
      console.log(
        `    raw="${o.raw_date_label}" → parsed="${o.parsed_published_at}" (${o.proposed_record?.published_at_confidence}, signals=${o.date_signals.join(',')})`,
      );
      console.log(`    body_length=${o.body_length}  image=${o.proposed_record?.image_url ? 'yes' : 'no'}`);
    }
  }

  console.log(`\nD1: nothing written to DB. Inspect ${path} → if green, npm run apply -- ${source.slug}`);
}

main().catch((e: Error) => {
  console.error(`✗ dryrun failed: ${e.message}`);
  process.exit(1);
});
