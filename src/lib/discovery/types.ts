// Output of any discovery strategy. Carries whatever info the strategy
// could harvest cheaply — orchestrator decides whether to fetch the
// detail page to fill gaps. (RSS often returns title+date+snippet up
// front; sitemap returns only URL+lastmod, so detail-fetch is required.)

export type DiscoveryMode = 'rss' | 'sitemap' | 'html_listing' | 'multi_job' | 'manual';

export type DiscoveredItem = {
  url: string;
  // Anything not known at discovery time stays null; orchestrator's
  // detail-fetch step fills in what extract/* needs.
  title: string | null;
  excerpt: string | null;
  imageUrl: string | null;
  // Date signals captured at discovery, in their raw forms. Date cascade
  // uses these BEFORE fetching the detail page.
  rawDateLabel: string | null;   // human-readable label (e.g. "Fri, 29 May 2026 10:00:00 +0000")
  rssPubDate: Date | null;        // rss-parser already parsed pubDate
  sitemapLastmod: Date | null;    // sitemap <lastmod> value
  // Full body markup if the source provided it (RSS content:encoded).
  // null means orchestrator should fetch the detail page if it needs body.
  fullBodyHtml: string | null;
  discoveredVia: DiscoveryMode;
};

export type DiscoveryConfig = {
  // RSS
  feedUrl?: string;
  // Sitemap / HTML listing
  sitemapUrl?: string;
  listUrl?: string;
  urlPattern?: string;
  /** HTML listing: cheerio selector that picks anchor elements on the
   *  listing page. Mirrors v1's scraper_config.item_selector. Default
   *  `a[href]` if not set, but most sources need something tighter like
   *  `a[href$=".pdf"]` to exclude nav/footer links. */
  itemSelector?: string;
  // Generic
  maxItems: number;
  stopOnKnown?: number;
};
