// Dry-run validator CLI. Thin wrapper around src/lib/validate/dryrun-validator.ts.
// apply.ts re-runs the same validator internally so the two cannot drift.
//
// Usage:  npx tsx src/cli/verify.ts <dryrun-json-path>

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import type { DryRunReport } from '@/lib/repository/types';
import { ALL_RULES, validateDryRun, type Issue } from '@/lib/validate/dryrun-validator';

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: npx tsx src/cli/verify.ts <dryrun-json-path>');
    process.exit(2);
  }
  const report: DryRunReport = JSON.parse(readFileSync(path, 'utf8'));
  const scrapeTime = new Date(report.generated_at);
  console.log(`Validating: ${path}`);
  console.log(`  source:     ${report.source_name}`);
  console.log(`  generated:  ${report.generated_at}`);
  console.log(`  outcomes:   ${report.outcomes.length} (${report.would_insert} would_insert, ${report.duplicate} dup, ${report.rejected} rej)\n`);

  const issues: Issue[] = validateDryRun(report, scrapeTime);

  const byRule = new Map<string, number>();
  for (const i of issues) byRule.set(i.rule, (byRule.get(i.rule) || 0) + 1);
  console.log(`── Rule results (${ALL_RULES.length} rules × ${report.outcomes.length} outcomes) ──`);
  for (const r of ALL_RULES) {
    const fail = byRule.get(r) || 0;
    const mark = fail === 0 ? '✓' : '✗';
    console.log(`  ${mark} ${r}: ${fail === 0 ? 'pass' : `${fail} fail`}`);
  }

  if (issues.length > 0) {
    console.log(`\n── Issues (${issues.length}) ──`);
    for (const i of issues.slice(0, 20)) {
      console.log(`  [${i.rule}] outcome #${i.outcomeIndex}: ${i.detail}`);
      console.log(`        url: ${i.url}`);
    }
    if (issues.length > 20) console.log(`  ... +${issues.length - 20} more`);
  }

  const samples = report.outcomes.filter((o) => o.scraper_decision === 'would_insert').slice(0, 3);
  if (samples.length > 0) {
    console.log(`\n── 3 sample would_insert outcomes (manual spot-check) ──`);
    for (const o of samples) {
      const p = o.proposed_record!;
      console.log(`  • ${p.title.slice(0, 80)}`);
      console.log(`    raw "${o.raw_date_label}" → parsed "${p.published_at}" (${p.published_at_confidence})`);
      console.log(`    url_hash=${p.url_hash}  source_id=${p.source_id.slice(0, 8)}…  body=${p.raw_excerpt?.length ?? 0} chars`);
    }
  }

  console.log(`\n${issues.length === 0 ? '🟢 VERDICT: PASS — safe to proceed to 2.2 apply' : '🔴 VERDICT: FAIL — fix issues above before 2.2 apply'}`);
  process.exit(issues.length === 0 ? 0 : 1);
}

main().catch((e: Error) => {
  console.error(`✗ verify failed: ${e.message}`);
  process.exit(1);
});
