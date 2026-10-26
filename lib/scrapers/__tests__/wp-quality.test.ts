// WP post → row: a publisher excerpt that only fails the title-overlap test is kept
// but held hidden; everything else behaves as before.
// Run: npx tsx lib/scrapers/__tests__/wp-quality.test.ts
import { wpPostToRawArticle } from '../rss';

let pass = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  failures.push(`  ${name}\n     beklenen: ${JSON.stringify(expected)}\n     gelen   : ${JSON.stringify(actual)}`);
};
const post = (title: string, excerpt: string, content = '') => ({
  link: 'https://x.com/p/', date_gmt: '2026-10-26T08:00:00',
  title: { rendered: title }, excerpt: { rendered: excerpt }, content: { rendered: content },
});
const view = (r: any) => ({ excerpt: r.excerpt, hold_hidden: r.hold_hidden ?? false, wp_post: r.wp_post });

const normal = 'Tanker rates rose sharply this week as Middle East demand recovered strongly.';
check('normal post: excerpt kept, not held, marked wp_post',
  view(wpPostToRawArticle(post('Tanker rates rise on Middle East demand', normal))),
  { excerpt: normal, hold_hidden: false, wp_post: true });

const noOverlap = 'In the tanker space, VLCC sales continued with two resales reported this week.';
check('excerpt with no title word: kept now, held hidden',
  view(wpPostToRawArticle(post('CLARKSONS HELLAS SnP WEEKLY', noOverlap))),
  { excerpt: noOverlap, hold_hidden: true, wp_post: true });

check('boilerplate excerpt: still not stored, not held by this rule',
  view(wpPostToRawArticle(post('Tanker rates rise on Middle East demand', 'The post Tanker rates rise appeared first on Hellenic Shipping News.'))).hold_hidden,
  false);

const body = 'Swedish Club advice on cargo claims: check the bills of lading before loading begins.';
check('empty excerpt, content passes: content teaser, visible as before',
  view(wpPostToRawArticle(post('Cargo claims advice from Swedish Club', '', body))),
  { excerpt: body, hold_hidden: false, wp_post: true });

check('empty excerpt, empty content: nothing stored (the scraper decides)',
  view(wpPostToRawArticle(post('Cargo claims advice from Swedish Club', '', ''))),
  { excerpt: '', hold_hidden: false, wp_post: true });

console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
