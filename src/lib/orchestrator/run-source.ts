import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { hashUrl } from '@/lib/url-hash';
import { extractDate, toDbConfidence, toDbProvenance } from '@/lib/extract/date';
import { buildExcerpt } from '@/lib/extract/body';
import { fetchDetail, PAYWALLED_THIN_THRESHOLD } from '@/lib/extract/detail-fetch';

// Polite delay between detail-page fetches so we don't hammer the
// source. 1 second is courteous and still finishes a 30-item run in
// ~30s. Override per-source later if needed.
const DETAIL_FETCH_DELAY_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import { RssDiscovery } from '@/lib/discovery/RssDiscovery';
import { SitemapDiscovery } from '@/lib/discovery/SitemapDiscovery';
import { HtmlListingDiscovery } from '@/lib/discovery/HtmlListingDiscovery';
import type { DiscoveryStrategy } from '@/lib/discovery/DiscoveryStrategy';
import type { DiscoveryMode } from '@/lib/discovery/types';
import type { SourceConfig } from '@/sources/registry';
import { articleWriteRepo } from '@/lib/repository/SupabaseArticleWriteRepository';
import type {
  DryRunReport,
  ScrapedArticle,
  ScrapeOutcome,
} from '@/lib/repository/types';

// Strategy lookup. Phase 2.5 adds Sitemap / HtmlListing / MultiJob;
// orchestrator code below is mode-agnostic, only this map grows.
function strategyFor(mode: DiscoveryMode): DiscoveryStrategy {
  switch (mode) {
    case 'rss':
      return new RssDiscovery();
    case 'sitemap':
      return new SitemapDiscovery();
    case 'html_listing':
      return new HtmlListingDiscovery();
    case 'multi_job':
    case 'manual':
      throw new Error(`Discovery strategy '${mode}' not implemented yet (Phase 2.5).`);
  }
}

export async function runSourceDryRun(source: SourceConfig): Promise<DryRunReport> {
  const strategy = strategyFor(source.mode);

  // Resolve source_id once. If null, fail loudly — writing with
  // source_id=null would corrupt the DB.
  const sourceId = await articleWriteRepo.resolveSourceId(source.name);
  if (!sourceId) throw new Error(`Source "${source.name}" not in DB — register it in sources first.`);

  // Collect discovered items first so we can batch the dedup query.
  const discovered = [];
  for await (const item of strategy.discover({
    feedUrl: source.feedUrl,
    sitemapUrl: source.sitemapUrl,
    listUrl: source.listUrl,
    urlPattern: source.urlPattern,
    itemSelector: source.itemSelector,
    maxItems: source.maxItems,
    stopOnKnown: source.stopOnKnown,
  })) {
    discovered.push(item);
  }

  // Dedup check via batched url_hash IN-query.
  const hashes = discovered.map((i) => hashUrl(i.url));
  const knownHashes = await articleWriteRepo.knownUrlHashes(hashes);

  const outcomes: ScrapeOutcome[] = [];
  let wouldInsert = 0;
  let duplicate = 0;
  let rejected = 0;
  let fetchFailed = 0;

  for (let i = 0; i < discovered.length; i++) {
    const item = discovered[i];
    const urlHash = hashes[i];
    const isDup = knownHashes.has(urlHash);

    // Phase 2.4: detail-fetch the article page to harvest meta / JSON-LD /
    // <time> date signals. Cross-signal agreement (≥2 matching dates)
    // bumps confidence from medium → high. Polite delay between fetches.
    // RSS POC sends ~10 items per run, so total added latency ~10s.
    let detailSignals = {
      jsonLdDatePublished: null as string | null,
      metaArticlePublishedTime: null as string | null,
      ogPublishedTime: null as string | null,
      timeElementDatetime: null as string | null,
      pdfMetadataCreation: null as string | null,
      pdfBodyHeaderProbe: null as string | null,
    };
    let detailHttpStatus: number | null = null;
    let detailFetchError: string | null = null;
    let detailTitle: string | null = null;
    let detailBodyExcerpt: string | null = null;
    let detailIsPdf = false;
    let detailPdfTooLarge = false;
    let detailPdfNoText = false;
    let detailVisibleBodyLength = 0;
    let detailIsPaywalled = false;
    if (i > 0) await sleep(DETAIL_FETCH_DELAY_MS);
    try {
      const fetched = await fetchDetail(item.url);
      detailHttpStatus = fetched.httpStatus;
      detailFetchError = fetched.fetchError;
      detailSignals = fetched.signals;
      detailTitle = fetched.title;
      detailBodyExcerpt = fetched.bodyExcerpt;
      detailIsPdf = fetched.isPdf;
      detailPdfTooLarge = fetched.pdfTooLarge;
      detailPdfNoText = fetched.pdfNoText;
      detailVisibleBodyLength = fetched.visibleBodyLength;
      detailIsPaywalled = fetched.isPaywalled;
    } catch (e) {
      detailFetchError = (e as Error).message;
    }

    // Discovery-vs-detail title preference: discovery (RSS gives a
    // canonical headline) wins when present; fall back to detail-fetch
    // (sitemap items have no discovery title).
    const effectiveTitle = item.title ?? detailTitle;
    // Body: prefer fullBodyHtml (RSS content:encoded), then RSS snippet,
    // then detail-fetch's lean excerpt. Sitemap items hit the last path.
    // Body: prefer by SOURCE RELIABILITY, not length. "Longer wins" would
    // fall into the D21 "extracted ≠ correct" trap — a long-but-dirty
    // detail body (nav/promo/footer) must NOT beat a short-but-clean RSS
    // excerpt. Instead: when detail-fetch produced a REAL body, use it;
    // otherwise fall back to RSS.
    //   `visibleBodyLength > 0` is the "real body extracted" signal — it
    //   is set by (a) Mode #2's followed embedded PDF (PDF text), (b) a
    //   direct PDF (mode #1), and (c) a D21 noise-stripped DOM container
    //   walk (clean HTML). It is 0 when detail produced nothing usable
    //   (Splash247 = HTTP 403; or a JSON/meta-only fallback).
    // MPA Port Marine Notices hit (a): the 600-char PDF text now wins over
    // the 45-char RSS snippet. Splash247 hits the else branch (403 → RSS
    // content:encoded), so its 2.2-proven path is byte-for-byte unchanged.
    const rssBuilt = buildExcerpt({ fullBodyHtml: item.fullBodyHtml, rssExcerpt: item.excerpt });
    const effectiveExcerpt =
      detailVisibleBodyLength > 0
        ? (detailBodyExcerpt ?? rssBuilt)
        : (rssBuilt ?? detailBodyExcerpt);

    const date = extractDate({
      rssPubDate: item.rssPubDate,
      sitemapLastmod: item.sitemapLastmod,
      metaArticlePublishedTime: detailSignals.metaArticlePublishedTime,
      jsonLdDatePublished: detailSignals.jsonLdDatePublished,
      timeElementDatetime: detailSignals.timeElementDatetime,
      // For PDF articles, feed first ~500 chars of extracted text into
      // chrono so dates like "November 6, 2012" in the body header
      // become the chosen signal (more authoritative than the PDF
      // file's CreationDate timestamp).
      bodyHeaderLabel: detailSignals.pdfBodyHeaderProbe,
      pdfMetadataCreation: detailSignals.pdfMetadataCreation,
      rawPubDateLabel: item.rawDateLabel,
    });

    const excerpt = effectiveExcerpt;

    // PDF safety-net rejections — both produce HONEST, COUNTABLE drops
    // per D16/D18 doctrine, not silent no_title masks.
    //
    // pdf_too_large: response exceeded the 20MB cap; bytes weren't
    // extracted. Common for scanned class-society bulletins, MOU
    // dossiers.
    if (detailPdfTooLarge) {
      rejected++;
      outcomes.push({
        source_name: source.name,
        discovered_via: item.discoveredVia,
        detected_url: item.url,
        http_status: detailHttpStatus,
        scraper_decision: 'rejected',
        reject_reason: 'pdf_too_large',
        raw_date_label: item.rawDateLabel,
        parsed_published_at: date.published_at,
        date_signals: date.agreeing,
        body_length: null,
        proposed_record: null,
        notes: detailFetchError ?? 'PDF exceeded 20MB cap.',
      });
      continue;
    }
    // pdf_fetch_failed: response self-identified as PDF (URL ends .pdf
    // or Content-Type was application/pdf), but the fetch itself failed
    // (HTTP 4xx/5xx or network error). Surfaced as the London P&I /
    // .pdf path in the 2026-05-30 cross-source probe (HTTP 403, CF-
    // style block). Without this gate the row would fall to `no_title`
    // — another silent-mask we just fought off in the visibility fix.
    if (detailIsPdf && detailFetchError) {
      rejected++;
      outcomes.push({
        source_name: source.name,
        discovered_via: item.discoveredVia,
        detected_url: item.url,
        http_status: detailHttpStatus,
        scraper_decision: 'rejected',
        reject_reason: 'pdf_fetch_failed',
        raw_date_label: item.rawDateLabel,
        parsed_published_at: date.published_at,
        date_signals: date.agreeing,
        body_length: null,
        proposed_record: null,
        notes: detailFetchError,
      });
      continue;
    }
    // pdf_no_text: PDF was downloaded but unpdf returned near-zero text
    // (image-only / scanned PDF, requires OCR which is a deferred
    // decision). Without OCR there's no body, no title, no date to
    // extract — the article would land in DB as an empty shell.
    if (detailPdfNoText) {
      rejected++;
      outcomes.push({
        source_name: source.name,
        discovered_via: item.discoveredVia,
        detected_url: item.url,
        http_status: detailHttpStatus,
        scraper_decision: 'rejected',
        reject_reason: 'pdf_no_text',
        raw_date_label: item.rawDateLabel,
        parsed_published_at: date.published_at,
        date_signals: date.agreeing,
        body_length: null,
        proposed_record: null,
        notes: detailFetchError ?? 'PDF text extraction returned near-zero chars (image-only/scanned).',
      });
      continue;
    }
    // D22 v3 (2026-05-31, evening) — paywalled_thin reject. The
    // reader's perspective drives this decision: when they click our
    // "Read original at [Source]" link, what do they see at the
    // publisher's page? If the publisher renders ~3-5 lines of teaser
    // and then a "subscribe to read more" wall, our link sends them
    // to frustration, and the row should never have been ingested.
    // If the publisher exposes ~1100+ chars of substantive lede before
    // any wall (or no wall at all), the row is fine — the reader gets
    // value at the source even with a paywall behind it.
    //
    // detail-fetch.ts measures these two signals in tandem:
    //   visibleBodyLength = Phase 2 (SSR DOM container walk) length —
    //                       what a non-JS reader would see in the
    //                       initial render. Fallback content from
    //                       __NEXT_DATA__ JSON or meta description
    //                       does NOT count as visible here.
    //   isPaywalled       = paywall phrase fired in body / title / tail.
    //
    // Combination: short visible body AND paywall signal ⇒ reject.
    // Either condition alone is not enough:
    //   - long visible body + paywall phrase = soft paywall with rich
    //     open content. Accept (e.g. NYT-style sites that publish full
    //     lede + 3 paragraphs free).
    //   - short visible body + no paywall phrase = short article, not
    //     a wall. Accept (e.g. one-paragraph regulatory notice).
    //
    // History: D22 v1 (morning of 2026-05-30) rejected on paywall
    // phrase alone — too strict. D22 v2 (evening of 2026-05-30)
    // removed the check entirely — too loose, missed the JoC pattern
    // the user actually wanted blocked. v3 combines both signals.
    if (detailVisibleBodyLength < PAYWALLED_THIN_THRESHOLD && detailIsPaywalled) {
      rejected++;
      outcomes.push({
        source_name: source.name,
        discovered_via: item.discoveredVia,
        detected_url: item.url,
        http_status: detailHttpStatus,
        scraper_decision: 'rejected',
        reject_reason: 'paywalled_thin',
        raw_date_label: item.rawDateLabel,
        parsed_published_at: date.published_at,
        date_signals: date.agreeing,
        body_length: detailBodyExcerpt?.length ?? null,
        proposed_record: null,
        notes: `D22 v3: visibleBodyLength=${detailVisibleBodyLength} (< ${PAYWALLED_THIN_THRESHOLD}) AND paywall phrase detected. Reader following our Read-original link would hit a teaser-plus-wall page; row blocked.`,
      });
      continue;
    }

    if (isDup) {
      duplicate++;
      const dupNotes = ['url_hash already in DB'];
      if (detailFetchError) dupNotes.push(`detail-fetch failed: ${detailFetchError}`);
      outcomes.push({
        source_name: source.name,
        discovered_via: item.discoveredVia,
        detected_url: item.url,
        http_status: detailHttpStatus,
        scraper_decision: 'duplicate',
        reject_reason: null,
        raw_date_label: item.rawDateLabel,
        parsed_published_at: date.published_at,
        date_signals: date.agreeing,
        body_length: excerpt?.length ?? null,
        proposed_record: null,
        notes: dupNotes.join('; '),
      });
      continue;
    }

    // Title is mandatory (DB NOT NULL); rejecting if missing.
    if (!effectiveTitle) {
      rejected++;
      outcomes.push({
        source_name: source.name,
        discovered_via: item.discoveredVia,
        detected_url: item.url,
        http_status: detailHttpStatus,
        scraper_decision: 'rejected',
        reject_reason: 'no_title',
        raw_date_label: item.rawDateLabel,
        parsed_published_at: date.published_at,
        date_signals: date.agreeing,
        body_length: excerpt?.length ?? null,
        proposed_record: null,
        notes: '',
      });
      continue;
    }

    // Confidence='none' is our internal sentinel for "no date extracted"
    // and is NOT a DB-allowed value (probed 2026-05-30). Reject these
    // rows here rather than coerce — a row with no date should not enter
    // the DB silently mislabelled.
    const dbConfidence = toDbConfidence(date.published_at_confidence);
    if (!date.published_at || dbConfidence === null) {
      rejected++;
      outcomes.push({
        source_name: source.name,
        discovered_via: item.discoveredVia,
        detected_url: item.url,
        http_status: null,
        scraper_decision: 'rejected',
        reject_reason: 'no_date',
        raw_date_label: item.rawDateLabel,
        parsed_published_at: date.published_at,
        date_signals: date.agreeing,
        body_length: excerpt?.length ?? null,
        proposed_record: null,
        notes: '',
      });
      continue;
    }

    // empty_body reject — the row carries NO body at all (null or
    // whitespace-only). Distinct from R15's thin-content sentinel (400):
    // this is "zero content", not "extraction shortfall". Live case: MPA's
    // RSS "Data Migration Item" placeholder (has a title, body is empty —
    // not a real article). Gate is body==0/null, NOT <50: the 1–49 band is
    // unobserved (the only data points are junk=0 and Splash=312), and the
    // one half-broken-PDF case that band would catch is ALREADY rejected
    // upstream (pdf-extract EMPTY_TEXT_THRESHOLD=50 → pdf_no_text). Widen to
    // <50 only when a real row in that band is actually seen.
    // LOGGED, never silently dropped (inverse-D21 guard): a future legit
    // article that loses its body to an extraction failure would also land
    // here — the log lets us audit monthly "real junk vs broken extraction"
    // rather than quietly lose maritime content.
    if (!excerpt || excerpt.trim().length === 0) {
      console.warn(`  empty_body reject: ${item.url}`);
      rejected++;
      outcomes.push({
        source_name: source.name,
        discovered_via: item.discoveredVia,
        detected_url: item.url,
        http_status: detailHttpStatus,
        scraper_decision: 'rejected',
        reject_reason: 'empty_body',
        raw_date_label: item.rawDateLabel,
        parsed_published_at: date.published_at,
        date_signals: date.agreeing,
        body_length: excerpt?.length ?? null,
        proposed_record: null,
        notes: 'No body content (null/whitespace). Distinct from R15 thin-content (400). Logged for inverse-D21 audit (real junk vs extraction-fail).',
      });
      continue;
    }

    const proposed: ScrapedArticle = {
      source_id: sourceId,
      title: effectiveTitle,
      url: item.url,
      url_hash: urlHash,
      raw_excerpt: excerpt,
      published_at: date.published_at,
      published_at_source: toDbProvenance(date.published_at_source),
      published_at_confidence: dbConfidence,
      image_url: item.imageUrl,
      is_broken: false,
    };

    wouldInsert++;
    outcomes.push({
      source_name: source.name,
      discovered_via: item.discoveredVia,
      detected_url: item.url,
      http_status: detailHttpStatus,
      scraper_decision: 'would_insert',
      reject_reason: null,
      raw_date_label: item.rawDateLabel,
      parsed_published_at: date.published_at,
      date_signals: date.agreeing,
      body_length: excerpt?.length ?? null,
      proposed_record: proposed,
      notes: detailFetchError ? `detail-fetch failed: ${detailFetchError}` : '',
    });
  }

  const report: DryRunReport = {
    generated_at: new Date().toISOString(),
    source_name: source.name,
    discovered_count: discovered.length,
    would_insert: wouldInsert,
    duplicate,
    rejected,
    fetch_failed: fetchFailed,
    outcomes,
  };

  return report;
}

export function writeReport(report: DryRunReport, slug: string): string {
  if (!existsSync('tmp')) mkdirSync('tmp');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `tmp/dryrun-${slug}-${ts}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}
