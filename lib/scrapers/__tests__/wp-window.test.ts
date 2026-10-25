// WP REST window start: overlap before the last successful run, capped.
// Run: npx tsx lib/scrapers/__tests__/wp-window.test.ts
import { wpWindowStart, windowOnly } from '../orchestrator';

let pass = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  failures.push(`  ${name}\n     beklenen: ${JSON.stringify(expected)}\n     gelen   : ${JSON.stringify(actual)}`);
};
const now = new Date('2026-10-25T12:00:00Z');
check('normal run: 72 h before the last ok run (3 h ago)', wpWindowStart('2026-10-25T09:00:00Z', 72, now), '2026-10-22T09:00:00.000Z');
check('never later than overlap before now', wpWindowStart('2026-10-25T13:00:00Z', 72, now), '2026-10-22T12:00:00.000Z');
check('after a 5-day outage the window widens on its own', wpWindowStart('2026-10-20T12:00:00Z', 72, now), '2026-10-17T12:00:00.000Z');
check('no successful run ever: overlap before now', wpWindowStart(null, 72, now), '2026-10-22T12:00:00.000Z');
check('a very long outage is capped at 30 days', wpWindowStart('2026-01-01T00:00:00Z', 72, now), '2026-09-25T12:00:00.000Z');
// windowOnly: the regular read keeps its posts untouched; the window adds only what it missed, held hidden
const mk = (url: string) => ({ title: 't', url, author: null, published_at: null, excerpt: '', image_url: null }) as any;
const regular = [mk('https://x.com/a/'), mk('https://x.com/b/')];
const added = windowOnly(regular, [mk('https://x.com/b/'), mk('https://x.com/c/'), mk('https://x.com/c/'), mk('https://x.com/d/')]);
check('only posts the regular read missed are added', added.map((r) => r.url), ['https://x.com/c/', 'https://x.com/d/']);
check('added posts are held hidden', added.every((r) => r.hold_hidden === true), true);
check('a post repeated inside the window is added once', added.filter((r) => r.url === 'https://x.com/c/').length, 1);
check('regular posts are not marked', regular.some((r) => r.hold_hidden), false);
console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
