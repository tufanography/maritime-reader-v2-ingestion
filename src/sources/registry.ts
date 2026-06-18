import type { DiscoveryMode } from '@/lib/discovery/types';

// Registry of v2-managed sources. Phase 2.1 ships exactly one (Splash247).
// New sources land here one at a time during Phase 2.5 multi-source rollout,
// each gated by its own precheck run.

export type SourceConfig = {
  /** Must match `sources.name` in Supabase. */
  name: string;
  mode: DiscoveryMode;
  feedUrl?: string;
  sitemapUrl?: string;
  listUrl?: string;
  urlPattern?: string;
  /** HTML listing: cheerio selector for anchor elements on the listing page. */
  itemSelector?: string;
  maxItems: number;
  stopOnKnown?: number;
  /** Lowercase short id used in CLI args and audit filenames. */
  slug: string;
  /** D22: source is paywalled / login-gated. Discovery and detail-fetch
   *  are skipped entirely for the source — the dry-run CLI reports
   *  "skipped: paywalled" and exits without DB or network work. The
   *  page-level paywall detector in detail-fetch still runs on
   *  non-paywalled sources as defence-in-depth, so a previously-open
   *  source that adds a paywall mid-stream is also caught. Keep an
   *  entry in the registry (rather than deleting it) so the decision
   *  trail and the open-source-list audit stay coherent. */
  paywalled?: boolean;
};

export const SOURCES: SourceConfig[] = [
  {
    name: 'Splash247',
    slug: 'splash247',
    mode: 'rss',
    feedUrl: 'https://splash247.com/feed/',
    // POC: 10 items max (matches RSS feed size). v1's max_items=1000 is
    // for sitemap fallback; RSS feed itself is ~10. Lift later if useful.
    maxItems: 10,
    stopOnKnown: 10,
  },
  {
    // Phase 2.5 slice 1: second discovery type (sitemap) for pluggable
    // architecture validation. Config mirrors v1's Hellenic scraper_config:
    // dated sitemap + URL pattern that keeps only article paths.
    name: 'Hellenic Shipping News',
    slug: 'hellenic',
    mode: 'sitemap',
    sitemapUrl: 'https://www.hellenicshippingnews.com/sitemap-posttype-post.2026.xml',
    urlPattern: '^https?://www\\.hellenicshippingnews\\.com/[^/]+/?$',
    maxItems: 10, // POC limit; v1 uses 30
    stopOnKnown: 5,
  },
  // Phase 2.5 Yol C step 1 (2026-05-30): sitemap rollout to 5 more
  // sources. NorthStandard deferred — its v1 config sets
  // requires_js:true (needs Playwright we don't have yet) and mixes PDF
  // circulars with HTML news/articles + stub-rejection logic per the
  // NorthStandard recovery doctrine; not a simple config-add.
  {
    name: 'BIMCO',
    slug: 'bimco',
    mode: 'sitemap',
    sitemapUrl: 'https://www.bimco.org/sitemap.xml',
    urlPattern: '^https?://www\\.bimco\\.org/news-insights/[^/]+/\\d{4}/\\d{2}/',
    maxItems: 10, // POC; v1 uses 5
    stopOnKnown: 5,
  },
  {
    name: 'gCaptain',
    slug: 'gcaptain',
    mode: 'sitemap',
    sitemapUrl: 'https://gcaptain.com/post-sitemap.xml',
    urlPattern: '^https://gcaptain\\.com/(?!(category|tag|author|page|wp-)).+/$',
    maxItems: 10, // POC; v1 uses 30
    stopOnKnown: 5,
  },
  {
    name: 'Offshore Energy',
    slug: 'offshore-energy',
    mode: 'sitemap',
    sitemapUrl: 'https://www.offshore-energy.biz/sitemap_index.xml',
    // v2 deviation from v1: add `news` to the negative lookahead. v1's
    // pattern allowed `/news/` (the category landing page) through, and
    // R11 caught it in the 2026-05-30 dry-run — jsonld on /news/ returns
    // a stale 2020 feature article, body_length=0, title="News".
    // Listing pages have no business in articles.
    //
    // 2026-05-30 (D21 fix): a bare `news` in the negative lookahead also
    // rejects legitimate article slugs that *start with* "news" (e.g.
    // `news-summary-q3/`). The 16:34 dry-run still let `/news/` through
    // — root cause uncertain (regex compile? cached run?), but the
    // path-segment-anchored form below is the airtight version. Each
    // listed token must be followed by `/` (i.e. it IS the path
    // segment, not just a prefix), so `news-foo/` keeps passing while
    // `news/` is rejected. R14 in the validator is a defence-in-depth
    // backstop for any landing URL that still slips through.
    urlPattern: '^https?://www\\.offshore-energy\\.biz/(?!(category|tag|author|page|wp-|news)/)[^/]+/?$',
    maxItems: 10, // POC; v1 uses 30
    stopOnKnown: 5,
  },
  {
    name: 'MarineLink',
    slug: 'marinelink',
    mode: 'sitemap',
    sitemapUrl: 'https://www.marinelink.com/sitemap.xml',
    urlPattern: '^https?://www\\.marinelink\\.com/(news|maritime|magazine)/',
    maxItems: 10, // POC; v1 uses 30
    stopOnKnown: 5,
  },
  {
    name: 'Journal of Commerce',
    slug: 'joc',
    mode: 'sitemap',
    sitemapUrl: 'https://www.joc.com/sitemap.xml',
    urlPattern: '^https?://(www\\.)?joc\\.com/(article|news)/',
    maxItems: 10, // POC; v1 uses 30
    stopOnKnown: 5,
    // D22 v3 (2026-05-31, ground-truth corrected). NOT paywalled-flagged
    // at registry level — the page-level combination detector handles it
    // (visibleBodyLength < 1100 AND paywall phrase ⇒ reject paywalled_thin).
    //
    // The same-day v2 reversal claimed "JoC's open teaser is ~1100 chars
    // of real lede" and re-enabled it as a normal source. A D16 ground-
    // truth probe (src/cli/joc-groundtruth.ts, 4 live articles) DISPROVED
    // that: the SSR DOM open body the reader actually sees is 0 chars —
    // JoC is fully client-hydrated, the entire 3500-7400-char body lives
    // ONLY in the __NEXT_DATA__ JSON blob (the subscriber payload), and a
    // "Subscribe Now" wall renders over it. The "2000 char" the reversal
    // trusted was that JSON, not reader-visible content. So JoC is exactly
    // the teaser-plus-wall case the user's rule rejects. v3 detector fires
    // (visible=0 < 1100 AND isPaywalled) ⇒ all JoC rows rejected. Body is
    // still pulled into bodyExcerpt for would-be search/tagging, but no
    // row is written because the reader following our link hits a wall.
    // Re-evaluate only if JoC opens free access (visibleBodyLength rises).
  },
  {
    // Phase 2.5 sub-slice (2026-05-30): third discovery type
    // (html_listing) + first PDF DB-write target. Config mirrors v1's
    // American P&I scraper_config exactly: list page + PDF-anchor
    // selector. Each yielded URL is a circular PDF; mode #1 PDF handler
    // turns it into a ScrapedArticle.
    name: 'American P&I Club',
    slug: 'american',
    mode: 'html_listing',
    listUrl: 'https://www.american-club.com/page/circulars',
    itemSelector: 'a[href$=".pdf"]',
    maxItems: 10, // POC limit for first PDF write; v1 uses 30
    stopOnKnown: 3,
  },
  {
    // PDF Mode #2 source (2026-05-31): RSS discovery → HTML notice pages,
    // each carrying ONE embedded PDF link that IS the notice body (Port
    // Marine Notices). detail-fetch's Mode #2 path (thin HTML body + single
    // main-content PDF link ⇒ follow + extract) turns them into articles.
    // The feed also yields plain-HTML media releases (handled as ordinary
    // HTML) and the odd junk row ("Data Migration Item", body 0 / 1970)
    // which validator R15 blocks at apply. Name MUST match the existing v1
    // DB row "MPA Singapore" (verified present, rss, enabled).
    name: 'MPA Singapore',
    slug: 'mpa',
    mode: 'rss',
    feedUrl: 'https://www.mpa.gov.sg/feeds/media-releases',
    maxItems: 15, // POC: enough to include several PMNs + the junk + an HTML release
    stopOnKnown: 10,
  },
  {
    // Ç3 net-new proof (2026-06-18): Shipowners' Club is DISABLED in v1
    // (enabled=false since 2026-06-12, last_status=error — the per-source
    // timeout from the orchestrator knownUrls 1000-cap; root cause fixed in
    // v1 but the source was never re-enabled). So v1 has NOT ingested it for
    // ~6 days → anything it published since is net-new → the first source
    // where v2 can prove an independent insert (every v1-active source shows
    // 0 would_insert because v1 already has everything).
    //
    // v1's live scraper_config is multi_job (news + publications). v2's
    // orchestrator only implements html_listing (single job) today, so this
    // mirrors v1's NEWS job verbatim (item_selector byte-for-byte). The
    // publications job + a proper multi_job strategy come in the rollout.
    name: "Shipowners' Club",
    slug: 'shipowners',
    mode: 'html_listing',
    listUrl: 'https://www.shipownersclub.com/latest-updates/news/',
    itemSelector: 'a[href*="/latest-updates/news/"]:not([href$="/latest-updates/news/"])',
    maxItems: 10, // POC; v1 uses 60
    stopOnKnown: 3,
  },
];

export function findBySlug(slug: string): SourceConfig | undefined {
  return SOURCES.find((s) => s.slug === slug);
}
