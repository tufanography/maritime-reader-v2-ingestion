// D16 ground-truth probe for PDF Mode #2 (HTML page with an embedded PDF
// link). One question: when discovery yields an HTML article/notice page,
// does its MAIN content carry exactly one canonical PDF link that IS the
// article body — distinct from nav/footer/archive/related PDF links?
//
// If yes  → Mode #2 is real: fetch HTML, find the main PDF, hand to the
//           proven PDF mode #1 extractor.
// If the page links the PDF DIRECTLY (listing → .pdf) → that's mode #1 /
//           html_listing, no Mode #2 needed.
// If the page is pure HTML (no PDF) → ordinary sitemap/html detail-fetch.
//
// Read-only. No DB, no write. Usage:
//   npx tsx src/cli/mode2-probe.ts <url> [<url> …]
//   npx tsx src/cli/mode2-probe.ts --rss <feedUrl>     (list feed links)

import 'dotenv/config';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Same noise families as detail-fetch.ts Phase 1 (abridged), so the
// "main content PDF" count reflects what the real extractor would scope to.
const NOISE = [
  'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'iframe', 'form',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]', '[role="search"]',
  '.nav', '.navbar', '.menu', '.navigation', '.header', '.site-header', '.masthead',
  '.footer', '.site-footer', '.sidebar', '.related', '.recommended',
  '.promo', '.subscribe', '.newsletter', '.social', '.share', '.breadcrumb', '.ad', '.ads',
  '.cookie', '.modal', '.popup', '.archive', '.downloads-list', '.attachments-list',
  '[class*="related"]', '[class*="archive"]', '[class*="more-"]', '[class*="Card_"]',
];

const CONTAINERS = [
  '[itemprop="articleBody"]', 'article', '[role="article"]', '[role="main"] article',
  '[role="main"]', 'main article', 'main', '.entry-content', '.post-content',
  '.article-content', '.article-body', '.content-body', '.content', 'body',
];

async function fetchText(url: string): Promise<{ status: number; ct: string; body: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow', signal: ctrl.signal,
    });
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, ct, body: await res.text() };
  } finally { clearTimeout(t); }
}

function pdfLinksIn($: CheerioAPI, root: cheerio.Cheerio<any> | null): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const scope = root ?? $('body');
  scope.find('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (/\.pdf(\?|#|$)/i.test(href)) {
      out.push({ href, text: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 70) });
    }
  });
  return out;
}

function mainContainer($: CheerioAPI): { sel: string; node: cheerio.Cheerio<any> } | null {
  for (const sel of CONTAINERS) {
    const node = $(sel).first();
    if (node.length) return { sel, node };
  }
  return null;
}

async function probeHtml(url: string) {
  console.log('═'.repeat(90));
  console.log(url);
  const { status, ct, body } = await fetchText(url);
  console.log(`  HTTP ${status} | content-type: ${ct} | ${body.length} bytes`);
  if (/application\/pdf/i.test(ct) || /\.pdf(\?|#|$)/i.test(url)) {
    console.log(`  ⇒ DIRECT PDF (mode #1 / html_listing territory, not Mode #2).`);
    return;
  }
  const $ = cheerio.load(body);
  const allPdf = pdfLinksIn($, null);
  // main-content-scoped count: strip noise, then look inside the main container
  for (const sel of NOISE) $(sel).remove();
  const mc = mainContainer($);
  const mainPdf = mc ? pdfLinksIn($, mc.node) : [];
  const title = $('meta[property="og:title"]').attr('content')?.trim()
    || $('title').first().text().trim() || $('h1').first().text().trim();
  console.log(`  title: ${title?.slice(0, 80)}`);
  console.log(`  PDF links — whole page: ${allPdf.length} | main content (${mc?.sel ?? 'none'}): ${mainPdf.length}`);
  if (mainPdf.length) {
    console.log(`  ── MAIN-content PDF link(s) (Mode #2 candidate) ──`);
    for (const p of mainPdf.slice(0, 6)) console.log(`     [${p.text || '(no text)'}] → ${p.href}`);
  }
  const noisePdf = allPdf.filter((a) => !mainPdf.some((m) => m.href === a.href));
  if (noisePdf.length) {
    console.log(`  ── chrome/archive PDF links (should NOT be picked) ──`);
    for (const p of noisePdf.slice(0, 4)) console.log(`     [${p.text || '(no text)'}] → ${p.href}`);
  }
  // verdict
  if (mainPdf.length === 1) console.log(`  ⇒ MODE #2 CANONICAL: exactly 1 main-content PDF link.`);
  else if (mainPdf.length === 0 && allPdf.length === 0) console.log(`  ⇒ PURE HTML: no PDF anywhere — ordinary detail-fetch.`);
  else if (mainPdf.length === 0 && allPdf.length > 0) console.log(`  ⇒ PDF links exist but only in chrome — likely PURE HTML article.`);
  else console.log(`  ⇒ MULTIPLE main PDFs (${mainPdf.length}) — needs a pick rule (first? largest-text-match to title?).`);
}

async function listRss(feedUrl: string) {
  const { status, ct, body } = await fetchText(feedUrl);
  console.log(`RSS ${feedUrl} → HTTP ${status} | ${ct} | ${body.length} bytes`);
  const $ = cheerio.load(body, { xmlMode: true });
  const items: { title: string; link: string }[] = [];
  $('item').each((_, el) => {
    items.push({
      title: $(el).find('title').first().text().trim().slice(0, 60),
      link: $(el).find('link').first().text().trim() || ($(el).find('guid').first().text().trim()),
    });
  });
  console.log(`  ${items.length} items. First 8 links:`);
  for (const it of items.slice(0, 8)) console.log(`   • ${it.title}\n       ${it.link}`);
  return items.map((i) => i.link).filter(Boolean);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--rss') {
    const links = await listRss(argv[1]);
    console.log(`\n── probing first 2 item pages for embedded PDFs ──`);
    for (const u of links.slice(0, 2)) { await probeHtml(u); }
    return;
  }
  if (!argv.length) { console.error('usage: mode2-probe.ts <url> [...] | --rss <feed>'); process.exit(2); }
  for (const u of argv) await probeHtml(u);
}

main().catch((e) => { console.error(e); process.exit(1); });
