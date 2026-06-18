// DB-FREE direct-PDF regression. After adding PDF Mode #2 (the HTML-branch
// embedded-PDF hook), confirm the EXISTING direct-PDF path (mode #1 — a
// URL that IS a .pdf) still extracts clean text and date signals exactly
// as before. The new code lives only in the HTML else-branch; a direct
// .pdf URL is detected by isPdfResponse() and routed to the untouched PDF
// branch — this proves that empirically rather than by assertion (D16).
//
// Discovers 2 PDFs from the American P&I Club circulars listing (the
// proven mode #1 source) and probes them. No DB, no write.
//
// Usage:  npx tsx src/cli/directpdf-check.ts [<pdfUrl> ...]

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { fetchDetail } from '@/lib/extract/detail-fetch';
import { extractDate } from '@/lib/extract/date';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const LIST = 'https://www.american-club.com/page/circulars';

async function discoverAmericanPdfs(limit: number): Promise<string[]> {
  const res = await fetch(LIST, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  const html = await res.text();
  const $ = cheerio.load(html);
  const urls: string[] = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (/\.pdf(\?|#|$)/i.test(href)) {
      try { urls.push(new URL(href, LIST).toString()); } catch { /* skip */ }
    }
  });
  return Array.from(new Set(urls)).slice(0, limit);
}

async function probe(url: string) {
  console.log('═'.repeat(92));
  console.log(url);
  const d = await fetchDetail(url);
  const date = extractDate({
    rssPubDate: null, sitemapLastmod: null, metaArticlePublishedTime: null,
    jsonLdDatePublished: null, timeElementDatetime: null,
    bodyHeaderLabel: d.signals.pdfBodyHeaderProbe,
    pdfMetadataCreation: d.signals.pdfMetadataCreation,
    rawPubDateLabel: null,
  });
  console.log(`  HTTP ${d.httpStatus} | isPdf=${d.isPdf}  pdfNoText=${d.pdfNoText}  pdfTooLarge=${d.pdfTooLarge}  embeddedPdfUrl=${d.embeddedPdfUrl ?? '(none)'}`);
  console.log(`  title: ${d.title?.slice(0, 84) ?? '(null)'}`);
  console.log(`  body: ${d.bodyExcerpt?.length ?? 0} chars`);
  console.log(`  body[0..300]: ${(d.bodyExcerpt ?? '').slice(0, 300).replace(/\s+/g, ' ')}`);
  console.log(`  pdf signals: metaCreation=${d.signals.pdfMetadataCreation ?? '—'}  bodyHeaderProbe=${d.signals.pdfBodyHeaderProbe ?? '—'}`);
  console.log(`  date: ${date.published_at} (${date.published_at_confidence}, signals=${date.agreeing.join(',') || '—'})`);
  // regression assertion: a direct .pdf URL MUST take the PDF branch
  const ok = d.isPdf === true && d.embeddedPdfUrl == null;
  console.log(`  ⇒ direct-PDF path intact: ${ok ? 'YES (isPdf=true, no embedded hook fired)' : 'NO — REGRESSION!'}`);
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  const urls = argv.length ? argv : await discoverAmericanPdfs(2);
  console.log(`Direct-PDF regression — ${urls.length} URL(s)\n`);
  for (const u of urls) await probe(u);
}

main().catch((e) => { console.error(e); process.exit(1); });
