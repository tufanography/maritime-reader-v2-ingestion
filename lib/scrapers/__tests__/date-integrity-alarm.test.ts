// No-network tests for folding the date-integrity result into coverage-audit's
// existing alarm. Covers the THREE-STATE contract the user required:
//   N>0 → alarm · N=0 → clean · anything-unverifiable → UNKNOWN (never clean).
// Run: npx tsx lib/scrapers/__tests__/date-integrity-alarm.test.ts
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDateIntegrity, CRITICAL, buildBody } from '../../../scripts/audit-coverage';

let pass = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  failures.push(`  ${name}\n     beklenen: ${JSON.stringify(expected)}\n     gelen   : ${JSON.stringify(actual)}`);
};

const dir = mkdtempSync(join(tmpdir(), 'di-'));
// Helper: write out/exit fixtures, run readDateIntegrity against them, return result.
function run(outText: string | null, exitText: string | null) {
  const o = join(dir, 'o'), e = join(dir, 'e');
  try { unlinkSync(o); } catch {}
  try { unlinkSync(e); } catch {}
  if (outText !== null) writeFileSync(o, outText);
  if (exitText !== null) writeFileSync(e, exitText);
  return readDateIntegrity(o, e);
}
// Real printed line shapes from scripts/audit-date-integrity.ts
const CLEAN_OUT = '\n=== DATE-INTEGRITY AUDIT ===\nVISIBLE articles dated at scrape-time (scraper_default, |pub-created|<600s): 0\n';
const HIT_OUT = '\n=== DATE-INTEGRITY AUDIT ===\nVISIBLE articles dated at scrape-time (scraper_default, |pub-created|<600s): 7\nby source:\n  Gard                     5\n  NorthStandard            2\nsamples:\n  2026-10-09 | Gard | Some circular\n';

// ── State 1: CLEAN (exit 0, count 0) → no flag, stays OUT of the issue
check('clean → no flag', run(CLEAN_OUT, '0').flags, []);
check('clean → name stable', run(CLEAN_OUT, '0').name, 'DATE INTEGRITY');

// ── State 2: ALARM (exit 2, count>0) → DATE_INTEGRITY, note carries count + by-source
const alarm = run(HIT_OUT, '2');
check('alarm → DATE_INTEGRITY flag', alarm.flags, ['DATE_INTEGRITY']);
check('alarm → note has count', /\b7 visible article/.test(alarm.note), true);
check('alarm → note has by-source', /Gard 5/.test(alarm.note), true);

// ── State 3: UNKNOWN (never clean) — every unverifiable case
check('missing both files → UNKNOWN', run(null, null).flags, ['DATE_INTEGRITY_UNKNOWN']);
check('missing exit file → UNKNOWN', run(HIT_OUT, null).flags, ['DATE_INTEGRITY_UNKNOWN']);
check('runtime failure exit 1 → UNKNOWN', run('Error: DB timeout\n    at ...', '1').flags, ['DATE_INTEGRITY_UNKNOWN']);
check('exit 2 but output unparseable → UNKNOWN', run('garbage, no count line', '2').flags, ['DATE_INTEGRITY_UNKNOWN']);
check('contradiction exit 0 + count>0 → UNKNOWN', run(HIT_OUT, '0').flags, ['DATE_INTEGRITY_UNKNOWN']);
check('contradiction exit 2 + count 0 → UNKNOWN', run(CLEAN_OUT, '2').flags, ['DATE_INTEGRITY_UNKNOWN']);
check('non-numeric exit → UNKNOWN', run(HIT_OUT, 'boom').flags, ['DATE_INTEGRITY_UNKNOWN']);
check('UNKNOWN → name stable (same row as alarm)', run(null, null).name, 'DATE INTEGRITY');
check('UNKNOWN note says not-clean', /NOT treated as clean/.test(run(null, null).note), true);

// ── The close/no-close property depends on exactly two facts the set-diff
// (name-based, already shipped) consumes. Lock them:
// (1) both error and unknown carry the SAME row name → during error→unknown the
//     name stays in the critical set → NOT "recovered" → alarm does NOT close.
check('error & unknown share one row name', run(HIT_OUT, '2').name === run(null, null).name, true);
// (2) both flags are CRITICAL; clean has none → only a clean run drops from the set → closes.
check('DATE_INTEGRITY is critical', CRITICAL.has('DATE_INTEGRITY'), true);
check('DATE_INTEGRITY_UNKNOWN is critical', CRITICAL.has('DATE_INTEGRITY_UNKNOWN'), true);
check('clean carries no critical flag', run(CLEAN_OUT, '0').flags.some((f) => CRITICAL.has(f)), false);

// ── ALARM → UNKNOWN transition: the ISSUE BODY must show the CURRENT state, not
// stay on the old ALARM text. buildBody rebuilds from the current report every run
// and postIssue PATCHes the WHOLE body (full replace, not append), so the body can
// never carry stale text. Prove it: same row name, different note → body swaps.
const alarmRow = run(HIT_OUT, '2');       // {name:'DATE INTEGRITY', flags:['DATE_INTEGRITY'], note:'7 visible...'}
const unknownRow = run(null, null);       // {name:'DATE INTEGRITY', flags:['DATE_INTEGRITY_UNKNOWN'], note:'⚠...UNKNOWN...'}
const alarmBody = buildBody([alarmRow]);
const unknownBody = buildBody([unknownRow]);
check('alarm body shows the alarm count', /7 visible article/.test(alarmBody), true);
check('alarm body lists DATE INTEGRITY as broken', /DATE INTEGRITY/.test(alarmBody) && /DATE_INTEGRITY\b/.test(alarmBody), true);
check('UNKNOWN body shows the UNKNOWN warning', /UNKNOWN/.test(unknownBody) && /did NOT complete cleanly/.test(unknownBody), true);
check('UNKNOWN body does NOT retain old alarm count', /7 visible article/.test(unknownBody), false);
check('UNKNOWN body does NOT claim it is clean/OK', /date-integrity OK/.test(unknownBody), false);

try { unlinkSync(join(dir, 'o')); } catch {}
try { unlinkSync(join(dir, 'e')); } catch {}
console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
