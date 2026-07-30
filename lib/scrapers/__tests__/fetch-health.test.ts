// Tests for lib/scrapers/fetch-health.ts (B1 watchdog classifier).
// Run: npx tsx lib/scrapers/__tests__/fetch-health.test.ts
import { classifyHttpFailure, parseStatusFromError, formatFetchError, FetchHealth } from '../fetch-health';
import { FetchError } from '../html';

let pass = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  failures.push(`  ${name}\n     beklenen: ${JSON.stringify(expected)}\n     gelen   : ${JSON.stringify(actual)}`);
};

// 403 and 404 classify DIFFERENTLY (the whole point of B1).
check('403 → forbidden', classifyHttpFailure(403).kind, 'forbidden');
check('404 → not_found', classifyHttpFailure(404).kind, 'not_found');
check('410 → not_found', classifyHttpFailure(410).kind, 'not_found');
check('429 → rate_limited', classifyHttpFailure(429).kind, 'rate_limited');
check('503 → server_error', classifyHttpFailure(503).kind, 'server_error');
check('418 → client_error', classifyHttpFailure(418).kind, 'client_error');
check('null → network', classifyHttpFailure(null).kind, 'network');

// Status parsing from the shapes failures really arrive in.
check('FetchError.status', parseStatusFromError(new FetchError(403, 'https://x')), 403);
check('"Status code 404"', parseStatusFromError(new Error('Status code 404')), 404);
check('"Status code 403" (WP REST throw)', parseStatusFromError(new Error('Status code 403')), 403);
check('network error → null', parseStatusFromError(new Error('fetch failed')), null);

// B1 last_error format.
check('formatFetchError 403 shape',
  formatFetchError(new FetchError(403, 'https://splash247.com/feed/')).startsWith('HTTP 403 (403 forbidden)'), true);
check('formatFetchError network shape',
  formatFetchError(new Error('aborted')).startsWith('FETCH network'), true);

// Accumulator counts 403 vs 404 SEPARATELY.
const h = new FetchHealth();
h.record('wp_rest', new Error('Status code 403'));
h.record('wp_rest', new Error('Status code 403'));
h.record('feed', new FetchError(404, 'https://x/feed'));
check('accumulator counts forbidden×2', h.counts.forbidden, 2);
check('accumulator counts not_found×1', h.counts.not_found, 1);
check('accumulator summary', h.summary(), 'forbidden×2, not_found×1');
check('accumulator hasFailures', h.hasFailures, true);

console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
