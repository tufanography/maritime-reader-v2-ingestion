// Phase 2.2 apply. Reads a dry-run JSON, runs the validator internally,
// re-checks dedup against live DB, and (with --confirm) writes the
// would_insert rows. Without --confirm, prints the no-confirm preview
// for human review.
//
// Belt-and-suspenders D1 chain:
//   dryrun.ts → tmp/dryrun-*.json
//        ↓
//   apply.ts (this file)
//        ├─ re-validate via same validator core (R1–R10)
//        ├─ re-check knownUrlHashes (race-condition guard)
//        ├─ if no --confirm: print preview + exit (NO WRITE)
//        └─ if --confirm: insertMany → per-row audit JSONL → post-write read-back
//
// Usage:
//   npx tsx src/cli/apply.ts <dryrun-json>            # preview only
//   npx tsx src/cli/apply.ts <dryrun-json> --confirm  # actually write

import 'dotenv/config';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import type { DryRunReport, ScrapedArticle } from '@/lib/repository/types';
import { validateDryRun } from '@/lib/validate/dryrun-validator';
import { articleWriteRepo } from '@/lib/repository/SupabaseArticleWriteRepository';

function slugifySourceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  const path = process.argv[2];
  const confirm = process.argv.includes('--confirm');
  if (!path) {
    console.error('usage: npx tsx src/cli/apply.ts <dryrun-json-path> [--confirm]');
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`dry-run file not found: ${path}`);
    process.exit(2);
  }

  const report: DryRunReport = JSON.parse(readFileSync(path, 'utf8'));
  const slug = slugifySourceName(report.source_name);
  console.log(`Apply: ${path}`);
  console.log(`  source:        ${report.source_name} (slug=${slug})`);
  console.log(`  dry-run time:  ${report.generated_at}`);
  console.log(`  outcomes:      ${report.outcomes.length} (${report.would_insert} would_insert)\n`);

  // ── Step A: re-run validator internally ──────────────────────────
  console.log('── (A) re-validate dry-run JSON ──');
  const issues = validateDryRun(report, new Date(report.generated_at));
  if (issues.length > 0) {
    console.log(`  ✗ ${issues.length} issue(s) — REFUSING to proceed`);
    for (const i of issues.slice(0, 10)) {
      console.log(`    [${i.rule}] outcome #${i.outcomeIndex}: ${i.detail}`);
    }
    process.exit(3);
  }
  console.log('  ✓ R1–R10 all pass\n');

  // ── Step B: collect would_insert proposed_records ────────────────
  const insertCandidates: ScrapedArticle[] = report.outcomes
    .filter((o) => o.scraper_decision === 'would_insert' && o.proposed_record)
    .map((o) => o.proposed_record!);
  console.log(`── (B) collected ${insertCandidates.length} would_insert candidates ──`);

  // ── Step C: pre-write dedup re-check against live DB ─────────────
  console.log('── (C) re-check knownUrlHashes against live DB ──');
  const allHashes = insertCandidates.map((r) => r.url_hash);
  const stillKnown = await articleWriteRepo.knownUrlHashes(allHashes);
  const trulyNew = insertCandidates.filter((r) => !stillKnown.has(r.url_hash));
  const newlyDup = insertCandidates.length - trulyNew.length;
  console.log(`  candidates:     ${insertCandidates.length}`);
  console.log(`  now duplicate:  ${newlyDup} (became dup since dry-run)`);
  console.log(`  truly new:      ${trulyNew.length}\n`);

  if (trulyNew.length === 0) {
    console.log('Nothing to write. Exiting.');
    process.exit(0);
  }

  // ── Step D: no-confirm preview ───────────────────────────────────
  if (!confirm) {
    console.log('── (D) NO-CONFIRM PREVIEW — nothing will be written ──\n');
    console.log(`Row-by-row (${trulyNew.length} rows) — title / url / url_hash / parsed_published_at / source_id:\n`);
    for (let i = 0; i < trulyNew.length; i++) {
      const r = trulyNew[i];
      console.log(`  [${i + 1}/${trulyNew.length}]  ${r.title}`);
      console.log(`         url:         ${r.url}`);
      console.log(`         url_hash:    ${r.url_hash}`);
      console.log(`         date:        ${r.published_at}   (source=${r.published_at_source}, conf=${r.published_at_confidence})`);
      console.log(`         source_id:   ${r.source_id}`);
      console.log(`         body length: ${r.raw_excerpt?.length ?? 0}`);
      console.log('');
    }
    console.log('NO WRITE PERFORMED.');
    console.log(`Re-run with --confirm to apply: npx tsx src/cli/apply.ts ${path} --confirm`);
    process.exit(0);
  }

  // ── Step E: --confirm path — actually insert ─────────────────────
  console.log('── (E) --confirm given. Writing to DB. ──');
  const t0 = Date.now();
  const { inserted, failed } = await articleWriteRepo.insertMany(trulyNew);
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`  insertMany: inserted=${inserted}, failed=${failed}, elapsed=${dt}s\n`);

  // ── Step F: post-write read-back FIRST (audit reflects reality) ──
  // Apply attempt #1 (2026-05-30) had a bug: audit logged all rows as
  // "applied" even when 0 inserted (D7 violation — audit drift from
  // reality). Fix: post-verify FIRST, then write audit with actual
  // per-row insert/failed status derived from read-back.
  console.log('── (F) post-write verify (independent read-back) ──');
  const verifyHashes = await articleWriteRepo.knownUrlHashes(allHashes);
  const missing = trulyNew.filter((r) => !verifyHashes.has(r.url_hash));
  const postVerifyPassed = missing.length === 0 && failed === 0;
  if (!postVerifyPassed) {
    console.log(`  ✗ ${missing.length} row(s) NOT visible in DB read-back:`);
    for (const r of missing.slice(0, 10)) console.log(`    MISSING: ${r.url}  (hash=${r.url_hash})`);
  } else {
    console.log(`  ✓ all ${trulyNew.length} url_hash values visible in DB`);
  }

  // ── Step G: audit JSONL — per-row actual outcome (post-verified) ──
  if (!existsSync('tmp')) mkdirSync('tmp');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const auditPath = `tmp/apply-${slug}-${ts}.jsonl`;
  for (const r of trulyNew) {
    const actuallyInDb = verifyHashes.has(r.url_hash);
    appendFileSync(
      auditPath,
      JSON.stringify({
        applied_at: new Date().toISOString(),
        outcome: actuallyInDb ? 'inserted' : 'failed',
        url: r.url,
        url_hash: r.url_hash,
        source_id: r.source_id,
        title: r.title,
        published_at: r.published_at,
        published_at_source: r.published_at_source,
        published_at_confidence: r.published_at_confidence,
      }) + '\n',
    );
  }
  console.log(`── (G) audit log written: ${auditPath} ──\n`);

  // ── Final summary ────────────────────────────────────────────────
  console.log('═══ FINAL APPLY SUMMARY ═══');
  console.log(`  attempted:           ${insertCandidates.length}`);
  console.log(`  inserted:            ${inserted}`);
  console.log(`  skipped_duplicate:   ${newlyDup}`);
  console.log(`  failed:              ${failed}`);
  console.log(`  post_verify_passed:  ${postVerifyPassed ? '✓ yes' : '✗ NO — investigate'}`);
  console.log(`  audit log:           ${auditPath}`);

  process.exit(postVerifyPassed ? 0 : 1);
}

main().catch((e: Error) => {
  console.error(`✗ apply failed: ${e.message}`);
  process.exit(1);
});
