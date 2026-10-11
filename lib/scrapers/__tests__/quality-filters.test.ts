// Tests for the 2026-10-11 content-filter correction. Every positive case is a
// REAL item the old rules rejected; every negative case is a real junk page (or
// label) that must stay rejected.
// Run: npx tsx lib/scrapers/__tests__/quality-filters.test.ts
import { looksLikeArticle } from '../quality';
import { classifyRejectReason, sourceListUrls } from '../orchestrator';

let pass = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  failures.push(`  ${name}\n     beklenen: ${JSON.stringify(expected)}\n     gelen   : ${JSON.stringify(actual)}`);
};
const BODY = 'The Association draws Members’ attention to the following development and the practical steps that owners and operators should consider when planning forthcoming voyages through the affected area. '.repeat(2);
const ok = (title: string, url = 'https://example.org/news/some-article/', listUrls?: string[]) => looksLikeArticle({ title, excerpt: BODY, url, listUrls }).ok;
const why = (title: string, url = 'https://example.org/news/some-article/', listUrls?: string[]) => { const v = looksLikeArticle({ title, excerpt: BODY, url, listUrls }); return v.ok ? 'ok' : v.reason; };

// ── 1. Skuld circular: was rejected TWICE (title rule and URL rule) ──────────
const SKULD = 'https://www.skuld.com/about/-/circulars/2024/buy-back-cover-available-in-respect-of-certain-war-risks/';
check('Skuld buy-back circular accepted (title + its real URL)', ok('Buy-back cover available in respect of certain war risks', SKULD), true);
check('…title alone no longer trips the commercial rule', ok('Buy-back cover available in respect of certain war risks'), true);
check('…URL alone no longer trips the /buy rule', ok('War risks: cover available to Members', SKULD), true);

// ── 2. Real headlines that only START with a commercial word ────────────────
check('headline "Plans made to save…"', ok('Plans made to save Houthi-struck bulker from sinking'), true);
check('headline "Plans revealed for…"', ok('Plans revealed for $500m shipping fund in India'), true);
check('headline "Pricing cascades…"', ok('Pricing cascades: Inflation in a networked economy'), true);
check('slug starting with order- is not the /order path', ok('Order book hits record high for LNG carriers', 'https://example.org/news/order-book-hits-record-high/'), true);

// ── 3. Short one-word technical titles (real publications) ──────────────────
check('Shipowners "Liens"', ok('Liens', 'https://www.shipownersclub.com/latest-updates/publications/liens/'), true);
check('Shipowners "Piracy"', ok('Piracy', 'https://www.shipownersclub.com/latest-updates/publications/piracy/'), true);
check('Swedish Club "Piracy"', ok('Piracy', 'https://www.swedishclub.com/loss-prevention/loss-prevention-advice/piracy/'), true);

// ── 4. Commercial labels and paths stay rejected ────────────────────────────
for (const t of ['Pricing', 'Plans', 'Buy now', 'Order online', 'Purchase options']) check(`label "${t}" rejected`, ok(t), false);
for (const u of ['https://ww2.eagle.org/en/buy', 'https://example.org/pricing/', 'https://example.org/checkout?step=1', 'https://example.org/shop/cart/'])
  check(`commercial path rejected: ${u}`, ok('A perfectly normal looking page title', u), false);

// ── 5. Section labels, indexes, categories, login shells stay rejected ──────
for (const t of ['News', 'Home', 'Safety', 'Topics', 'TOPICS', 'Resources', 'Insights']) check(`section label "${t}" rejected`, ok(t), false);
for (const t of ['EU', 'IWT', 'FAQ', '2025年规则', '2016年规则']) check(`stub title "${t}" rejected`, ok(t), false);
check('category index rejected by URL', why('Position Paper', 'https://www.worldshipping.org/publications/category/Position+Paper').startsWith('url matches junk path'), true);
check('category index rejected even with a short title', ok('Safety', 'https://www.worldshipping.org/publications/category/Safety'), false);
check('candidate that IS the listing page rejected (Skuld /topics/)', why('TOPICS', 'https://www.skuld.com/topics/', ['https://www.skuld.com/topics/']), 'url is a listing page of this source');
check('listing page rejected whatever its title (UK P&I)', why('Knowledge and resources for Members', 'https://www.ukpandi.com/news-and-resources/?page=1', ['https://www.ukpandi.com/news-and-resources/']), 'url is a listing page of this source');
check('an article UNDER the listing path is not the listing', ok('Bulletin: stowaway risks in West Africa', 'https://www.ukpandi.com/news-and-resources/bulletins/stowaway-risks/', ['https://www.ukpandi.com/news-and-resources/']), true);
check('login shell still a login_wall', why('Login - Japan P&I Club'), 'login_wall');
// Real page London P&I served instead of an article (2026-10-11)
check('bot-challenge page is never an article',
  looksLikeArticle({ title: 'Just a moment...', excerpt: 'www.londonpandi.com Performing security verification This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.' + ' x'.repeat(100) }).reason, 'login_wall');
check('challenge body under a normal title',
  looksLikeArticle({ title: 'Additional Premium Areas', excerpt: 'Performing security verification. This website uses a security service to protect against malicious bots.' + ' x'.repeat(100) }).reason, 'login_wall');
check('a real article on port security checks passes', why('Port security checks tightened after Red Sea attacks'), 'ok');
check('"Press Release" placeholder still rejected', ok('Press Release'), false);
check('ordinary article unaffected', ok('Fines for excess bunker in Türkiye'), true);

// ── 6. NOT solved by the general filter — kept separate on purpose ──────────
// Steamship "Liquefied Natural Gas Operations - An Overview": rejected by CTA
// density on the page body, a per-source content-selector problem.
const cta = ('Learn more about this topic. Download the guide. Read more here. Visit our pages. Register for alerts. Subscribe today. View all items. Go to the library. Sign up now. ' + BODY).repeat(2);
check('CTA-heavy body still rejected (needs a source-level fix)', looksLikeArticle({ title: 'Liquefied Natural Gas Operations - An Overview', excerpt: cta, url: 'https://www.steamshipmutual.com/publications/articles/liquefied-natural-gas-operations-overview' }).ok, false);
// Shipowners "Tug and Barge Safety" passes this gate; it is dropped later by the
// DATE gate (no date on the detail page) — a listing-date setting, not a filter.
check('"Tug and Barge Safety" passes the quality gate (its problem is the date)', ok('Tug and Barge Safety', 'https://www.shipownersclub.com/latest-updates/news/tug-and-barge-safety/'), true);

// ── 7. plumbing ─────────────────────────────────────────────────────────────
check('listing reason is counted as non_article_page', classifyRejectReason('url is a listing page of this source'), 'non_article_page');
check('sourceListUrls collects top-level, jobs and job_groups', sourceListUrls({ scraper_config: { list_url: 'https://a/x', jobs: [{ list_url: 'https://a/y' }, { sitemap_url: 'https://a/s.xml' }], job_groups: [[{ list_url: 'https://a/z' }], [{ list_url: 'https://a/x' }]] } } as any).sort(), ['https://a/x', 'https://a/y', 'https://a/z']);

console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
