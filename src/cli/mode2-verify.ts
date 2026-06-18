// DB-FREE Mode #2 verification. Mirrors the orchestrator's per-item
// decision (extractDate + reject gates) WITHOUT touching Supabase, so it
// runs even while the DB is timing out — exactly like the paywall probe.
// The full dryrun.ts can't, because it resolves source_id first.
//
// Flow: read MPA media-releases RSS → for the first N items, fetchDetail
// (which now follows the embedded PDF for thin-HTML notice pages) →
// extractDate(rssPubDate + pdf signals) → apply the same reject ladder
// the orchestrator uses → print a per-item verdict the user can eyeball.
//
// Usage:  npx tsx src/cli/mode2-verify.ts [feedUrl] [N]

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { fetchDetail, PAYWALLED_THIN_THRESHOLD } from '@/lib/extract/detail-fetch';
import { extractDate } from '@/lib/extract/date';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const FEED = process.argv[2] || 'https://www.mpa.gov.sg/feeds/media-releases';
const N = parseInt(process.argv[3] || '5', 10);

async function rssItems(feedUrl: string): Promise<{ title: string; link: string; pubDate: string }[]> {
  const res = await fetch(feedUrl, { headers: { 'User-Agent': UA, Accept: 'application/xml,*/*' } });
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: { title: string; link: string; pubDate: string }[] = [];
  $('item').each((_, el) => {
    items.push({
      title: $(el).find('title').first().text().trim(),
      link: $(el).find('link').first().text().trim() || $(el).find('guid').first().text().trim(),
      pubDate: $(el).find('pubDate').first().text().trim(),
    });
  });
  return items;
}

// Mirror of run-source.ts reject ladder (the parts that don't need DB).
function decide(d: {
  pdfTooLarge: boolean; pdfNoText: boolean; isPdf: boolean; fetchError: string | null;
  visibleBodyLength: number; isPaywalled: boolean; title: string | null; publishedAt: string | null;
}): string {
  if (d.pdfTooLarge) return 'REJECT pdf_too_large';
  if (d.isPdf && d.fetchError) return 'REJECT pdf_fetch_failed';
  if (d.pdfNoText) return 'REJECT pdf_no_text';
  if (d.visibleBodyLength < PAYWALLED_THIN_THRESHOLD && d.isPaywalled) return 'REJECT paywalled_thin';
  if (!d.title) return 'REJECT no_title';
  if (!d.publishedAt) return 'REJECT no_date';
  return 'would_insert';
}

async function main() {
  const items = (await rssItems(FEED)).slice(0, N);
  console.log(`Mode #2 verify — ${FEED}\n${items.length} items. THRESHOLD=${PAYWALLED_THIN_THRESHOLD}\n`);
  for (const it of items) {
    console.log('═'.repeat(92));
    console.log(it.title.slice(0, 88));
    console.log(`  page: ${it.link}`);
    const d = await fetchDetail(it.link);
    const pub = it.pubDate ? new Date(it.pubDate) : null;
    const date = extractDate({
      rssPubDate: pub && !isNaN(pub.getTime()) ? pub : null,
      sitemapLastmod: null,
      metaArticlePublishedTime: d.signals.metaArticlePublishedTime,
      jsonLdDatePublished: d.signals.jsonLdDatePublished,
      timeElementDatetime: d.signals.timeElementDatetime,
      bodyHeaderLabel: d.signals.pdfBodyHeaderProbe,
      pdfMetadataCreation: d.signals.pdfMetadataCreation,
      rawPubDateLabel: it.pubDate,
    });
    const verdict = decide({
      pdfTooLarge: d.pdfTooLarge, pdfNoText: d.pdfNoText, isPdf: d.isPdf, fetchError: d.fetchError,
      visibleBodyLength: d.visibleBodyLength, isPaywalled: d.isPaywalled,
      title: d.title, publishedAt: date.published_at,
    });
    console.log(`  HTTP ${d.httpStatus} | embeddedPdfUrl: ${d.embeddedPdfUrl ?? '(none)'}`);
    console.log(`  chosen_title: ${d.title?.slice(0, 84) ?? '(null)'}`);
    console.log(`  body: ${d.bodyExcerpt?.length ?? 0} chars  |  visibleBodyLength=${d.visibleBodyLength}  isPaywalled=${d.isPaywalled}  pdfNoText=${d.pdfNoText}`);
    console.log(`  body[0..500]: ${(d.bodyExcerpt ?? '').slice(0, 500).replace(/\s+/g, ' ')}`);
    console.log(`  date: ${date.published_at} (${date.published_at_confidence}, source=${date.published_at_source}, signals=${date.agreeing.join(',') || '—'})  raw="${it.pubDate}"`);
    if (d.fetchError) console.log(`  fetchError: ${d.fetchError}`);
    console.log(`  ⇒ ${verdict}`);
    console.log('');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
