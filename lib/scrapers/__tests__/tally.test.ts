// Tests for the per-run tally and the audit liveness check built on it: a healthy
// source with nothing new must look DIFFERENT from a scraper that sees nothing.
// Run: npx tsx lib/scrapers/__tests__/tally.test.ts
import { formatTally, parseTally } from '../orchestrator';
import { liveness, talliedOrAll } from '../../../scripts/audit-coverage';

let pass = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  failures.push(`  ${name}\n     beklenen: ${JSON.stringify(expected)}\n     gelen   : ${JSON.stringify(actual)}`);
};

// ── format / parse ──────────────────────────────────────────────────────────
const t = { seen: 10, known: 10, candidates: 0, filtered: 0, inserted: 0 };
check('format', formatTally(t), 'tally [seen=10 known=10 candidates=0 filtered=0 new=0]');
check('round trip', parseTally(formatTally(t)), { ...t, deferred: 0 });
check('deferred is carried when present', parseTally(formatTally({ ...t, seen: 30, known: 4, candidates: 6, deferred: 20 })), { seen: 30, known: 4, candidates: 6, filtered: 0, inserted: 0, deferred: 20 });
check('parsed out of a combined message', parseTally('2 rejected by quality filter; reject-breakdown [bad_title:2]; tally [seen=2 known=0 candidates=2 filtered=2 new=0]')?.filtered, 2);
check('no tally in legacy / error messages', [parseTally(null), parseTally('HTTP 403 (403 forbidden) — Status code 403'), parseTally('1 rejected: no usable date; reject-breakdown [missing_date:1]')], [null, null, null]);
// the audit counts runs whose message matches /reject/ as rejection runs — a clean
// run's tally must never look like one
check('a clean tally never matches the audit\'s /reject/ test', /reject/i.test(formatTally(t)), false);

// ── liveness: the distinction this change exists for ────────────────────────
const run = (found: number, tally?: string) => ({ articles_found: found, error_message: tally ?? null });
// Polish Register-like: listing shows 10 links every run, all already held → found 0
const healthyIdle = Array.from({ length: 12 }, () => run(0, formatTally({ seen: 10, known: 10, candidates: 0, filtered: 0, inserted: 0 })));
// London P&I-like: selector matches nothing → listing shows 0 links
const broken = Array.from({ length: 12 }, () => run(0, formatTally({ seen: 0, known: 0, candidates: 0, filtered: 0, inserted: 0 })));
check('healthy source with nothing new: NOT dead', [liveness(healthyIdle, true).zeroStreak, liveness(healthyIdle, true).silentDeath], [0, false]);
check('scraper that sees nothing: dead', [liveness(broken, true).zeroStreak, liveness(broken, true).silentDeath], [12, true]);
check('both logged found=0 — only the tally separates them', healthyIdle.every((l) => l.articles_found === 0) && broken.every((l) => l.articles_found === 0), true);

// ── backward compatibility ──────────────────────────────────────────────────
const legacy = Array.from({ length: 12 }, () => run(0));            // logs written before the tally existed
check('legacy logs keep the old behaviour (found-based)', liveness(legacy, true).silentDeath, true);
check('legacy logs with content are alive as before', liveness([run(5), ...legacy], true).zeroStreak, 0);
check('first tally run clears a legacy zero streak for a healthy source', liveness([healthyIdle[0], ...legacy], true).silentDeath, false);
check('a broken source stays dead across the legacy→tally boundary', liveness([broken[0], broken[1], ...legacy], true).silentDeath, true);
check('never-proven source can never alarm', liveness(broken, false).silentDeath, false);
check('under 10 empty runs is not death yet', liveness(broken.slice(0, 9), true).silentDeath, false);
check('an error run without a tally counts as seeing nothing', liveness([{ articles_found: 0, error_message: 'HTTP 403 (403 forbidden) — Status code 403' }], true).zeroStreak, 1);
check('seens exposes what each run saw', liveness([healthyIdle[0], broken[0], run(3)], true).seens, [10, 0, 3]);

// ── SILENT input: tallied runs win over pre-tally zeros ─────────────────────
check('one tallied run outweighs 19 legacy zeros', talliedOrAll([healthyIdle[0], ...legacy]).length, 1);
check('no tally yet → all logs, unchanged', talliedOrAll(legacy).length, 12);
check('a tallied seen=0 run still reads as seeing nothing', liveness(talliedOrAll([broken[0], ...legacy]), false).seens, [0]);

console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
