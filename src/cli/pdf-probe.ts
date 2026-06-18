// Mode-#1 probe: takes a PDF URL, runs the full extraction pipeline
// fetchDetail → extractDate, prints the result the same way it would
// reach a ScrapedArticle. Lets us eyeball text quality, title pick,
// and date selection BEFORE running the orchestrator end-to-end.
//
// Usage:  npx tsx src/cli/pdf-probe.ts <url> [<url> ...]

import { fetchDetail } from '@/lib/extract/detail-fetch';
import { extractDate, toDbConfidence, toDbProvenance } from '@/lib/extract/date';

async function probeOne(url: string) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`URL: ${url}`);
  console.log('─'.repeat(72));

  const r = await fetchDetail(url);
  console.log(`HTTP:           ${r.httpStatus}`);
  console.log(`ok:             ${r.ok}`);
  console.log(`isPdf:          ${r.isPdf}`);
  console.log(`pdfTooLarge:    ${r.pdfTooLarge}`);
  console.log(`pdfNoText:      ${r.pdfNoText}`);
  console.log(`fetchError:     ${r.fetchError ?? '(none)'}`);
  console.log();
  console.log(`Title:          ${r.title ?? '(null)'}`);
  console.log(`Body length:    ${r.bodyExcerpt?.length ?? 0} chars`);
  if (r.bodyExcerpt) {
    console.log(`Body excerpt (first 300):`);
    console.log(`  ${r.bodyExcerpt.slice(0, 300).replace(/\n/g, ' ')}`);
  }
  console.log();
  console.log(`Signals:`);
  for (const [k, v] of Object.entries(r.signals)) {
    if (k === 'pdfBodyHeaderProbe') {
      console.log(`  ${k.padEnd(28)} ${v ? `"${(v as string).slice(0, 80)}..."` : '(null)'}`);
    } else {
      console.log(`  ${k.padEnd(28)} ${v ?? '(null)'}`);
    }
  }

  if (r.isPdf && !r.pdfNoText && !r.pdfTooLarge) {
    console.log();
    console.log('── Date cascade (PDF mode) ──');
    const d = extractDate({
      rssPubDate: null,
      sitemapLastmod: null,
      metaArticlePublishedTime: r.signals.metaArticlePublishedTime,
      jsonLdDatePublished: r.signals.jsonLdDatePublished,
      timeElementDatetime: r.signals.timeElementDatetime,
      bodyHeaderLabel: r.signals.pdfBodyHeaderProbe,
      pdfMetadataCreation: r.signals.pdfMetadataCreation,
      rawPubDateLabel: null,
    });
    console.log(`  chosen:        ${d.published_at_source}`);
    console.log(`  published_at:  ${d.published_at}`);
    console.log(`  confidence:    ${d.published_at_confidence} (db: ${toDbConfidence(d.published_at_confidence)})`);
    console.log(`  db_source:     ${toDbProvenance(d.published_at_source)}`);
    console.log(`  agreeing:      [${d.agreeing.join(', ')}]`);
    console.log(`  all signals:`);
    for (const s of d.signals) {
      console.log(`    ${s.source.padEnd(28)} ${s.iso ?? '(null)'}${s.raw ? `   raw: ${s.raw.slice(0, 60)}` : ''}`);
    }
  }
}

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('usage: npx tsx src/cli/pdf-probe.ts <url> [<url> ...]');
    process.exit(2);
  }
  for (const u of urls) {
    await probeOne(u);
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
