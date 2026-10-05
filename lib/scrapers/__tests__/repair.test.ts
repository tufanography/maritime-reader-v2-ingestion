// Tests for the 2026-09-30 ingestion-repair work:
//   - login-wall detection (quality.looksLikeLoginWall + looksLikeArticle)
//   - reject-reason normalisation (orchestrator.classifyRejectReason)
//   - date cascade for circular-number / JSON-LD pages (html.resolveArticleDate)
// Run: npx tsx lib/scrapers/__tests__/repair.test.ts
// Self-asserting pattern (no vitest/jest in this repo), same as gate.test.ts.
import * as cheerio from 'cheerio';
import { looksLikeArticle, looksLikeLoginWall } from '../quality';
import { classifyRejectReason } from '../orchestrator';
import { resolveArticleDate, inheritJobConfig } from '../html';

let pass = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  failures.push(`  ${name}\n     beklenen: ${JSON.stringify(expected)}\n     gelen   : ${JSON.stringify(actual)}`);
};

// ---------------------------------------------------------------------------
// 1. LOGIN WALL — the Japan P&I failure (title IS a login shell)
// ---------------------------------------------------------------------------
check('Japan P&I login title → login wall',
  looksLikeLoginWall({ title: 'Login - Japan P&I Club', excerpt: 'Login SEARCH HOME SERVICES INSURANCE OUTLINE' }), true);
check('access denied title → login wall',
  looksLikeLoginWall({ title: 'Access Denied', excerpt: 'You do not have permission to view this page.' }), true);
check('login form body → login wall',
  looksLikeLoginWall({ title: 'Members Area', excerpt: 'Please enter your username and password to continue.' }), true);
check('please-log-in-to-view body → login wall',
  looksLikeLoginWall({ title: 'Circular 2026', excerpt: 'Please log in to view the full circular and its attachments.' }), true);

// CRITICAL false-positive guard: a real article whose page chrome merely CONTAINS
// a "Login" nav link must NOT be treated as a login wall.
check('real article with nav Login link → NOT login wall',
  looksLikeLoginWall({
    title: 'Fines for excess bunker in Türkiye',
    excerpt: 'Home News Login Search. Turkish authorities have begun issuing fines to vessels carrying excess bunker fuel beyond declared quantities, following an amendment to the customs regulations that took effect this month.',
  }), false);

// looksLikeArticle returns the DISTINCT login_wall reason (for audit categories)
check('looksLikeArticle flags login_wall reason',
  looksLikeArticle({ title: 'Login - Japan P&I Club', excerpt: 'Login SEARCH HOME SERVICES INSURANCE OUTLINE RISKS COVERED' }),
  { ok: false, reason: 'login_wall' });
// A genuine article still passes (login guard must not swallow real content)
check('genuine NorthStandard article passes quality',
  looksLikeArticle({
    title: 'Fines for excess bunker in Türkiye',
    excerpt: 'Turkish authorities have begun issuing fines to vessels carrying excess bunker fuel beyond declared quantities, following an amendment to the customs regulations.',
  }), { ok: true });

// ---------------------------------------------------------------------------
// 2. classifyRejectReason — stable audit categories
// ---------------------------------------------------------------------------
check('login_wall passthrough', classifyRejectReason('login_wall'), 'login_wall');
check('junk url path → non_article_page', classifyRejectReason('url matches junk path /\\/(login)/'), 'non_article_page');
check('CTA fragments → non_article_page', classifyRejectReason('9 CTA fragments in excerpt'), 'non_article_page');
check('title too short → bad_title', classifyRejectReason('title too short (7 chars)'), 'bad_title');
check('junk title pattern → bad_title', classifyRejectReason('title matches junk pattern /^news/'), 'bad_title');
check('excerpt too short → insufficient_content', classifyRejectReason('excerpt too short (0 chars)'), 'insufficient_content');
check('locked content → insufficient_content', classifyRejectReason('excerpt matches locked-content pattern /x/'), 'insufficient_content');
check('unknown → other_quality', classifyRejectReason('something new'), 'other_quality');

// ---------------------------------------------------------------------------
// 3. resolveArticleDate — Gard-style pages (JSON-LD present, circular-number title)
// ---------------------------------------------------------------------------
const gardHtml = `<html><head>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"12/2025: Rights of Recourse","datePublished":"2025-10-20T10:58:07.676Z"}</script>
  </head><body><article>12/2025: Rights of Recourse</article></body></html>`;
const gardRes = resolveArticleDate({ $: cheerio.load(gardHtml), link: 'https://gard.no/en/circulars/12-2025-rights-of-recourse/', title: '12/2025: Rights of Recourse' });
check('Gard JSON-LD datePublished is resolved', gardRes?.winner.iso?.slice(0, 10), '2025-10-20');
check('Gard date confidence is high (json_ld)', gardRes?.winner.step, 'json_ld');

// A circular-number title like "No. 1/2006" must NOT be mined for a fake date
// out of the "1/2006" fragment when no real date signal exists. (Data-correctness
// guard: better null → honest reject than an invented date.)
const noDateHtml = `<html><head></head><body><article>No. 1/2006 - Hamburg Rules. This circular summarises the Hamburg Rules.</article></body></html>`;
const noDateRes = resolveArticleDate({ $: cheerio.load(noDateHtml), link: 'https://example.com/circulars/no-1-2006-hamburg-rules/', title: 'No. 1/2006 - Hamburg Rules' });
// title_fallback may extract a low-confidence month+year ONLY if a month name is
// present; "No. 1/2006" has no month name, so there must be no high-confidence date.
check('circular-number title yields no high-confidence date',
  noDateRes?.winner.confidence === 'high' ? 'high' : 'not-high', 'not-high');

// meta article:published_time still wins as high confidence
const metaHtml = `<html><head><meta property="article:published_time" content="2026-03-15T09:00:00Z"></head><body><article>Some Article</article></body></html>`;
const metaRes = resolveArticleDate({ $: cheerio.load(metaHtml), link: 'https://example.com/a', title: 'Some Article' });
check('meta published_time resolved high', metaRes?.winner.iso?.slice(0, 10), '2026-03-15');

// ---------------------------------------------------------------------------
// 4. inheritJobConfig — source-level settings reach each job (BV date / London JS)
// ---------------------------------------------------------------------------
// requires_js + date_selector inherited into a job that doesn't set them
check('job inherits requires_js from parent',
  inheritJobConfig({ requires_js: true, date_selector: '.page-heading--date' } as any, { list_url: 'x' } as any).requires_js, true);
check('job inherits date_selector from parent',
  inheritJobConfig({ requires_js: true, date_selector: '.page-heading--date' } as any, { list_url: 'x' } as any).date_selector, '.page-heading--date');
// a job-specific value WINS over the parent
check('job-specific content_selector wins over parent',
  inheritJobConfig({ content_selector: '.parent' } as any, { content_selector: '.job' } as any).content_selector, '.job');
// parent value NOT present → nothing invented
check('no requires_js anywhere → stays undefined',
  inheritJobConfig({ list_url: 'p' } as any, { list_url: 'x' } as any).requires_js, undefined);
// non-inherited keys are NOT copied (list_url/max_items stay per-job)
check('parent list_url does NOT leak into job',
  inheritJobConfig({ list_url: 'parent-url', requires_js: true } as any, { item_selector: 'a' } as any).list_url, undefined);
check('job keeps its own item_selector',
  inheritJobConfig({ requires_js: true } as any, { item_selector: 'a.card' } as any).item_selector, 'a.card');

console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
