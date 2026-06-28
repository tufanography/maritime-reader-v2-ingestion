// Generic HTML scraper for press-release / news index pages.
// Reads `scraper_config`:
//   { list_url: string,
//     item_selector?: string,        // CSS selector for article links on the index
//     title_selector?: string,       // CSS selector for the article title on the detail page
//     content_selector?: string }    // CSS selector for body text on detail page
//
// PDF handling: items whose URL ends with .pdf are processed via pdf-parse instead
// of HTML fetch. Title falls back to the link text from the index page.
//
// Strategy: fetch the index → find article links → for each, fetch detail HTML or
// extract PDF text (delay between requests). Limits to 15 most recent links per run.
import * as cheerio from 'cheerio';
import { hashUrl, randomUserAgent, sleep, stripHtml } from './util';
import { tryParse, extractFirstDate, findAllDates, pickBestDate, type DateCandidate, type DateResolution } from './date';
import { isPdfUrl, extractPdf } from './pdf';
import { looksLikeArticle, looksLikeHub } from './quality';
import { extractPdfSections, extractPdfSectionsAi } from '../ai/pdf-sections';
import type { RawArticle } from './rss';

/** Best-of date resolution for a parsed article page. Collects every
 *  possible date candidate (per-source selector → meta → <time> → URL
 *  path → body labelled → body bare → URL slug → title), tags each with
 *  explicit provenance/confidence, then ranks them via pickBestDate.
 *
 *  Exported so dry-run validation scripts can exercise the exact same
 *  logic as production without duplicating the cascade.
 *
 *  Confidence rules (conservative — see column comments in migration 037):
 *    high   — structured/curated source: date_selector, meta tag,
 *             <time datetime>, or explicit "Published:" body label with
 *             exact day.
 *    medium — URL path with day (may reflect archive routing, not
 *             publish date), or bare body date (no label context).
 *    low    — URL slug month-only, title month+year fallback.
 *
 *  URL path dates are deliberately capped at MEDIUM. Even /YYYY/MM/DD/
 *  URLs occasionally reflect CMS routing or migration dates rather than
 *  publication dates; an explicit body label is a stronger signal of
 *  intent and should outrank a URL date in ties. */
export function resolveArticleDate(args: {
  $: cheerio.CheerioAPI;
  link: string;
  title: string;
  date_selector?: string;
  date_format?: 'dmy' | 'mdy';
}): DateResolution | null {
  const { $, link, title, date_selector, date_format } = args;
  const candidates: DateCandidate[] = [];
  const addCandidate = (iso: string | null, c: Omit<DateCandidate, 'iso'>) => {
    if (iso) candidates.push({ iso, ...c });
  };

  // Step 1 — per-source date_selector (curated, highest trust).
  if (date_selector) {
    const el = $(date_selector).first();
    addCandidate(
      tryParse(el.attr('datetime')),
      { source: 'original', confidence: 'high', step: 'date_selector', raw: el.attr('datetime') },
    );
    let raw = el.text();
    if (date_format === 'dmy') {
      raw = raw.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_, d, m, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    addCandidate(tryParse(raw), { source: 'original', confidence: 'high', step: 'date_selector', raw });
    addCandidate(extractFirstDate(raw), { source: 'original', confidence: 'high', step: 'date_selector', raw });
  }

  // Step 2 — meta tags.
  const metaRaw =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[name="article:published_time"]').attr('content') ||
    $('meta[name="publish_date"]').attr('content') ||
    $('meta[name="publication_date"]').attr('content') ||
    $('meta[itemprop="datePublished"]').attr('content') ||
    null;
  addCandidate(tryParse(metaRaw), { source: 'original', confidence: 'high', step: 'meta', raw: metaRaw ?? undefined });

  // Step 2b — JSON-LD structured data (schema.org). Many SPA sites (Gard's
  // chakra-ui circulars, etc.) omit meta/<time> tags but embed an authoritative
  // `datePublished` in a <script type="application/ld+json">. This is curated,
  // machine-readable publication intent — high confidence, on par with meta.
  // Without it, Gard circulars fell through to body_bare and picked a YEAR out
  // of the title ("…Act 2002…" → 2002), mis-dating real 2003 circulars; or to
  // the scraper_default scrape-time fallback, showing decades-old circulars as
  // "just published". Walk every ld+json block, including @graph arrays, and
  // take the first datePublished / dateCreated / datePosted we can parse.
  const jsonLdDate = (() => {
    const nodes = $('script[type="application/ld+json"]').toArray();
    for (const node of nodes) {
      const raw = $(node).contents().text();
      if (!raw || !/datePublished|dateCreated|datePosted/i.test(raw)) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { continue; }
      const stack: unknown[] = [parsed];
      while (stack.length) {
        const cur = stack.pop();
        if (Array.isArray(cur)) { stack.push(...cur); continue; }
        if (cur && typeof cur === 'object') {
          const o = cur as Record<string, unknown>;
          for (const key of ['datePublished', 'dateCreated', 'datePosted']) {
            const v = o[key];
            if (typeof v === 'string' && v.trim()) return v.trim();
          }
          for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v);
        }
      }
    }
    return null;
  })();
  addCandidate(tryParse(jsonLdDate), { source: 'original', confidence: 'high', step: 'json_ld', raw: jsonLdDate ?? undefined });

  // Step 3 — <time datetime="...">. Semantic-aware: not every <time>
  // element is a publication timestamp. Modern templates also use <time>
  // for sidebar widgets, "current time" indicators, last-modified
  // footers, event dates, etc. Validation against NAPA caught a chrome
  // <time> showing today's date beating the correct body publication
  // date — the lesson is that POSITION alone (inside <article>) isn't
  // enough; we need semantic intent signals too.
  //
  // Three tiers:
  //   high   — element carries explicit publish-date semantics
  //            (itemprop="datePublished", pubdate attr, or a class name
  //            containing "publish" / "post-date" / "entry-date").
  //   low    — no semantic markup. We can't tell if it's publication
  //            time or chrome, so demote so body candidates win ties.
  //
  // We deliberately don't grant a middle "scoped but unmarked" tier:
  // experience says that simply being inside <article> is a weak signal
  // because templates routinely inject chrome times into article scope.
  const SEMANTIC_TIME_SEL = [
    'time[itemprop="datePublished"][datetime]',
    'time[pubdate][datetime]',
    'time[class*="publish" i][datetime]',
    'time[class*="post-date" i][datetime]',
    'time[class*="entry-date" i][datetime]',
  ].join(', ');
  const semanticTimeAttr = $(SEMANTIC_TIME_SEL).first().attr('datetime') ?? null;
  if (semanticTimeAttr) {
    addCandidate(tryParse(semanticTimeAttr), { source: 'original', confidence: 'high', step: 'time_element_semantic', raw: semanticTimeAttr });
  } else {
    const looseTimeAttr = $('time[datetime]').first().attr('datetime') ?? null;
    addCandidate(tryParse(looseTimeAttr), { source: 'original', confidence: 'low', step: 'time_element_loose', raw: looseTimeAttr ?? undefined });
  }

  // Step 4 — URL path numeric date /(YYYY)/(MM)/(DD)?/.
  const pathMatch = link.match(/\/(20\d{2})\/(\d{1,2})(?:\/(\d{1,2}))?\//);
  if (pathMatch) {
    const [, y, mo, d] = pathMatch;
    const hasDay = !!d;
    const iso = tryParse(`${y}-${mo.padStart(2, '0')}-${(d ?? '01').padStart(2, '0')}T00:00:00Z`);
    addCandidate(iso, {
      source: hasDay ? 'original' : 'scraper_default',
      confidence: hasDay ? 'medium' : 'low',
      step: hasDay ? 'url_path_day' : 'url_slug_month',
      raw: pathMatch[0],
    });
  }

  // Step 5 — body labelled. Iterate ALL matches: the FIRST keyword
  // occurrence is often a nav/footer "Updates" / "Date" link with no
  // real date in the capture. Walk until one parses non-future.
  //
  // 30 000-char window: traditional server-rendered pages have "Published"
  // near the top, but modern SPA shells (NorthStandard, etc.) front-load
  // cookie banner + nav + search + sidebar, pushing the article's labelled
  // date past 10 KB before article content starts. POC measured ~10 850
  // for NorthStandard; 30 000 keeps a safety margin without inviting
  // regex DoS on huge pages.
  const bodyText = $('body').text().replace(/\s+/g, ' ').slice(0, 30000);
  const LABELLED_RE = /(?:Published|Posted|Date|Updated|Last\s+updated)\s*[:\-]?\s*([^.\n]{4,80})/gi;
  for (const m of bodyText.matchAll(LABELLED_RE)) {
    const iso = extractFirstDate(m[1]);
    if (iso) {
      addCandidate(iso, { source: 'original', confidence: 'high', step: 'body_labelled', raw: m[0] });
      break;
    }
  }

  // Step 6 — bare date in <article>/<main>, headings stripped.
  //
  // Confidence is context-sensitive: when the body contains MANY
  // distinct dates (detention dates, departure dates, regulation
  // effective dates, historical case references), the first one isn't
  // reliably the publication date. Validation against a Paris MoU
  // banning notice surfaced this — body_bare picked up the detention
  // date 2025-12-16 instead of the 2026-02-16 publication date.
  //
  //   1 date in scoped body         → medium (likely the article's date)
  //   2+ dates in scoped body       → low    (ambiguous, could be event
  //                                           date rather than pub date)
  const $scope = $('article').length ? $('article')
    : $('main').length ? $('main')
    : null;
  let scopedText: string;
  if ($scope) {
    const $clone = $scope.clone();
    $clone.find('h1, h2').remove();
    scopedText = $clone.text();
  } else {
    scopedText = bodyText;
  }
  const head = scopedText.replace(/\s+/g, ' ').slice(0, 5000);
  const bareIso = extractFirstDate(head);
  if (bareIso) {
    // Count distinct ISO dates in the head — collapse duplicates so a
    // single date repeated by multiple regex passes (e.g. "23 April 2025"
    // also matching the month-year fallback "April 2025") doesn't count
    // twice and incorrectly downgrade confidence.
    const distinctDates = new Set(findAllDates(head));
    const bareConfidence: 'medium' | 'low' = distinctDates.size <= 1 ? 'medium' : 'low';
    addCandidate(bareIso, { source: 'original', confidence: bareConfidence, step: 'body_bare' });
  }

  // Step 7 — URL slug month-only (/april-2026/).
  const MONTHS_LONG = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const slugMatch = link.toLowerCase().match(
    /(?:^|[\/\-])(january|february|march|april|may|june|july|august|september|october|november|december)-(20\d{2})(?:[\/\-\.]|$)/,
  );
  if (slugMatch) {
    const monthNum = MONTHS_LONG.indexOf(slugMatch[1]) + 1;
    if (monthNum > 0) {
      const iso = tryParse(`${slugMatch[2]}-${String(monthNum).padStart(2, '0')}-01T00:00:00Z`);
      addCandidate(iso, { source: 'scraper_default', confidence: 'low', step: 'url_slug_month', raw: slugMatch[0] });
    }
  }

  // Step 8 — title month+year fallback ("MARS Report No.370 August 2023").
  if (title) {
    addCandidate(extractFirstDate(title), { source: 'scraper_default', confidence: 'low', step: 'title_fallback', raw: title });
  }

  return pickBestDate(candidates);
}

export type HtmlScraperConfig = {
  /** HTML index page. Optional only when `sitemap_url` is set instead. */
  list_url?: string;
  item_selector?: string;
  title_selector?: string;
  content_selector?: string;
  max_items?: number;
  /** Optional suffix appended to each scraped item URL. Lets us rewrite
   *  index links like /pdf/ → /pdf/download where the actual binary lives. */
  url_suffix?: string;
  /** When true, if a fetched detail page looks like a HUB (aggregator/
   *  catalogue rather than a real article), harvest its in-body article-y
   *  links and fetch them as additional candidates. One level of recursion. */
  unfold_hubs?: boolean;
  /** When set, fetch this XML sitemap instead of running an HTML index.
   *  Article URLs are pulled from the <loc> elements. Good for sites whose
   *  listing pages are JS-rendered (NorthStandard, etc.). Combine with
   *  `url_pattern` to filter the sitemap down to real article paths. */
  sitemap_url?: string;
  /** Regex (string form) applied to sitemap URLs. Only URLs whose absolute
   *  form matches will be visited. Example:
   *    "/insights-and-resources/resources/(circulars|news|articles)/" */
  url_pattern?: string;
  /** When true, the scraper does NOT fetch each item's detail page. Instead
   *  it pulls the full card (title, date, link, image) straight out of the
   *  list page. Useful for sites whose detail pages are JS-rendered while
   *  the listing markup still exposes everything we need (e.g. ABS
   *  newsroom). Combine with list_card_*_selector below. */
  list_only?: boolean;
  /** Per-source date selector. Tried BEFORE the generic meta/time chain so
   *  sites that put their publish date in a specific element (e.g. "Published:
   *  3 May 2026" inside `.publication-date`) can override the heuristics.
   *  The selector's text is parsed with new Date(). */
  date_selector?: string;
  /** Disambiguator for slash-dates in the per-source selector. Default
   *  parsing assumes US MDY when the date is ambiguous (e.g. "5/3/2026"
   *  could be either May 3 or March 5). Set to 'dmy' on European /
   *  UK-locale sites (ITIC: "12/05/2026" means 12 May) so we don't end
   *  up classifying their dates as future and rejecting the article. */
  date_format?: 'dmy' | 'mdy';
  /** When true, the scraper routes through Playwright (headless Chromium)
   *  to fetch this source — JS executes, SPA shells render, content
   *  becomes extractable. Default false: fast Cheerio path. Only set
   *  this for sources whose article body never appears in initial HTML
   *  (Laravel/Inertia, Vue/React app shells, etc.). Verified via the
   *  Phase E POC for NorthStandard. */
  requires_js?: boolean;
  list_card_selector?: string;   // outer card wrapper (one per article)
  list_title_selector?: string;  // selector relative to card
  list_date_selector?: string;
  list_link_selector?: string;   // anchor to the (possibly JS-rendered) detail page
  list_image_selector?: string;
  /** Compose multiple scraper jobs under one source. Each job is a complete
   *  HtmlScraperConfig (different list_url / mode / selectors) and runs in
   *  turn. All emitted articles end up under the same source_id, so the
   *  user sees one entry in the Sources filter even when we're scraping
   *  several pages on that domain. */
  jobs?: HtmlScraperConfig[];
  /** Round-robin job rotation: each cron tick scrapes ONE group from this
   *  list instead of every job at once. Keeps heavy sources (8+ list_urls,
   *  PDF parsing) under the 3-minute per-source timeout without losing
   *  any URL — each URL just gets scraped every N×interval minutes
   *  instead of every interval. Orchestrator advances
   *  `sources.last_group_index` after each run; readers do `index %
   *  job_groups.length` so the count can change without a migration. */
  job_groups?: HtmlScraperConfig[][];
  /** When true, the orchestrator skips any RawArticle whose published_at
   *  resolved to null. Useful for sources where dateless rows are stale
   *  archive material we don't want surfacing as "just added" content
   *  (Caribbean MOU's old COVID guidance, etc.). */
  require_date?: boolean;
  /** When set (>1), after fetching list_url also fetch additional list
   *  pages 2..N. Default URL pattern is the WordPress convention
   *  `${list_url}page/${n}/`; override with `pagination_url_template` for
   *  sites that use query-string pagination (?p=2, ?paged=2, etc.). */
  pages?: number;
  /** URL template for paginated list pages. Must contain a literal `{n}`
   *  which is replaced with the page number (>=2). Examples:
   *    "https://example.com/news?paged={n}"  (Shipowners' Club)
   *    "https://example.com/circulars/?p={n}" (London P&I)
   *  Page 1 always uses list_url verbatim; only pages 2+ use the template. */
  pagination_url_template?: string;
  /** Adaptive pagination cutoff. While walking paginated list pages,
   *  count items whose url_hash is already in `knownUrls` (i.e. we've
   *  scraped them before). When N consecutive known items appear, stop
   *  paginating — the rest are almost certainly also old. Resets to 0
   *  whenever a fresh URL appears, so a sparse mix of known + new keeps
   *  walking. Default 5; set to null/0 to disable. Replaces a fixed
   *  `pages` budget for routine catchup runs. */
  stop_on_known?: number | null;
  /** Opt-in: when scraping a PDF, attempt to split it into per-article
   *  records using a FREE heuristic (sequential numbered headings:
   *  "1. ...", "2. ...", "Article 1: ...", etc). Each detected section
   *  gets its own row, all pointing back to the same PDF with a
   *  `?part=N` disambiguator (keeps url_hash unique). Single-topic PDFs
   *  fall through to the normal one-record path. */
  pdf_split_sections?: boolean;
  /** Stronger but paid alternative — ~$0.0005 per PDF via Claude Haiku.
   *  Useful when the heuristic finds no numbered headings but the PDF
   *  is genuinely a newsletter / consolidated report. The heuristic is
   *  always tried first; AI only runs as a fallback. */
  pdf_split_sections_ai?: boolean;
  /** Extra RSS / Atom feeds to fold into this html source. Each URL
   *  is fetched after the html jobs run; results merge into the same
   *  source_id so the user sees one entry in the Sources filter. Used
   *  for things like a publisher's YouTube channel feed alongside its
   *  website news. */
  rss_feeds?: string[];
};

/** Cap how many child links we follow per hub. Keeps a runaway page (one
 *  with hundreds of links) from blowing up a single scrape run. */
const MAX_HUB_CHILDREN = 8;

/** Extract article-shaped links from a hub page's body. Same-domain only,
 *  excludes obvious nav/CTA targets, prefers PDFs and paths that look
 *  article-y (`/article/`, `/news/`, `/circular/`, etc.). */
function harvestArticleLinks(
  $: cheerio.CheerioAPI,
  hubUrl: string,
  alreadySeen: Set<string>,
): LinkItem[] {
  let hubHost: string;
  try { hubHost = new URL(hubUrl).hostname; } catch { return []; }

  const seen = new Set<string>();
  const items: LinkItem[] = [];
  // Match a literal path SEGMENT — `/news/...` or `/circular/...`. Substring-
  // matching `/rule/` or `/news` would also catch `/rules-and-resources/`,
  // which on sites like ABS is itself a navigation hub, not an article.
  const ARTICLE_HINT = /\/(articles?|news|insights?|circulars?|advisor(?:y|ies)|publications?|notices?|bulletins?|reports?|guides?|rules?)\//i;
  const NAV_REJECT = /\/(signup|login|sign-in|sign-up|subscribe|contact|about|privacy|terms|cookie|search|home|careers|legal|disclaimer)(\b|\/|$)/i;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let abs: string;
    try { abs = new URL(href, hubUrl).toString(); } catch { return; }
    if (!abs.startsWith('http')) return;
    if (abs === hubUrl || abs.split('#')[0] === hubUrl.split('#')[0]) return;

    let host: string;
    try { host = new URL(abs).hostname; } catch { return; }
    if (host !== hubHost) return;

    if (seen.has(abs) || alreadySeen.has(abs)) return;
    if (NAV_REJECT.test(abs)) return;

    const isPdf = /\.pdf(\?|#|$)/i.test(abs);
    const looksArticle = ARTICLE_HINT.test(abs);
    if (!isPdf && !looksArticle) return;

    seen.add(abs);
    const linkText = ($(el).text() || $(el).attr('title') || '').replace(/\s+/g, ' ').trim();
    items.push({ url: abs, linkText });
  });
  return items;
}

export class FetchError extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(`HTTP ${status} fetching ${url}`);
  }
}

// Full browser-like header set. Sites behind Cloudflare / similar WAFs
// (NorthStandard, some MOUs) return 403 on the minimal Accept+UA combo.
// Adding Sec-Fetch-* and Accept-Encoding gets us through.
function browserHeaders(): Record<string, string> {
  return {
    'User-Agent': randomUserAgent(),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}

async function fetchHtml(url: string, opts: { requiresJs?: boolean } = {}): Promise<string> {
  if (opts.requiresJs) {
    // Lazy import keeps the Playwright/Chromium dependency out of the hot
    // path for sources that don't need it — most scrape runs never touch
    // this module and shouldn't pay the import cost.
    const { fetchHtmlWithPlaywright } = await import('./playwright-fetcher');
    return fetchHtmlWithPlaywright(url);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(url, {
      headers: browserHeaders(),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new FetchError(res.status, url);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** HEAD-probe a URL to learn its real Content-Type. Some sites (e.g. Tokyo
 *  MOU press releases) serve PDFs from URLs that don't end in .pdf, so a
 *  filename check alone misroutes them. Returns null on any failure — caller
 *  treats null as "go with the URL extension heuristic". */
async function sniffContentType(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': randomUserAgent() },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) return null;
      return (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() || null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function absUrl(href: string, base: string): string {
  try {
    const u = new URL(href, base);
    // Normalise to https — some sites mix http and https links to the same
    // resource, which would defeat the seen-Set dedup and the article
    // url_hash uniqueness check.
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.toString();
  } catch {
    return href;
  }
}

type LinkItem = { url: string; linkText: string };

/** Pull <loc> URLs out of an XML sitemap. Returns the most recently
 *  modified entries first (by <lastmod> when present, else original
 *  document order). */
async function fetchOneSitemap(sitemapUrl: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(sitemapUrl, {
      headers: browserHeaders(),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new FetchError(res.status, sitemapUrl);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Read a sitemap URL and return its article URLs sorted newest-first.
 *  Transparently handles `<sitemapindex>` files by following the child
 *  with the most recent `<lastmod>` — useful for sites that split posts
 *  by year (Hellenic Shipping News' /sitemap.xml → .../2026.xml) or by
 *  numbered chunks (gCaptain's /sitemap_index.xml → /post-sitemap.xml).
 *  Caps recursion at 3 levels to avoid loops on misconfigured sitemaps. */
async function fetchSitemapUrls(sitemapUrl: string, urlPattern: string | undefined, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const xml = await fetchOneSitemap(sitemapUrl);

  // sitemap_index? Walk into the freshest child instead.
  if (/<sitemapindex\b/i.test(xml)) {
    const indexBlocks = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)].map((m) => m[1]);
    let best: { url: string; lastmod: number } | null = null;
    for (const b of indexBlocks) {
      const loc = b.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
      if (!loc) continue;
      const lastmodStr = b.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim();
      const lastmod = lastmodStr ? Date.parse(lastmodStr) || 0 : 0;
      if (!best || lastmod > best.lastmod) best = { url: loc, lastmod };
    }
    if (!best) return [];
    return fetchSitemapUrls(best.url, urlPattern, depth + 1);
  }

  // Leaf sitemap: pull <url><loc>...</loc>...<lastmod>...</lastmod></url> blocks.
  const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const re = urlPattern ? new RegExp(urlPattern) : null;
  const entries: { url: string; lastmod: number }[] = [];
  for (const b of blocks) {
    const loc = b.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (!loc) continue;
    if (re && !re.test(loc)) continue;
    const lastmodStr = b.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim();
    const lastmod = lastmodStr ? Date.parse(lastmodStr) || 0 : 0;
    entries.push({ url: loc, lastmod });
  }
  entries.sort((a, b) => b.lastmod - a.lastmod);
  return entries.map((e) => e.url);
}

export async function fetchHtmlSource(args: {
  config: HtmlScraperConfig;
  delayMs: number;
  /** Optional set of url_hashes already in the DB for this source. When
   *  provided, the scraper skips the (slow) detail fetch for any list-page
   *  URL whose hash is already known. Critical for paginated backfills
   *  where most candidates would otherwise be re-fetched and re-parsed
   *  before the orchestrator's per-run dedup runs. */
  knownUrls?: Set<string>;
}): Promise<RawArticle[]> {
  const { config, delayMs, knownUrls } = args;

  // Multi-job branch: a single source can run several scraper configurations
  // (e.g. ABS = newsroom cards + monthly PDFs + rules PDFs). Each job runs
  // independently and we concat the RawArticles.
  if (config.jobs && config.jobs.length > 0) {
    const all: RawArticle[] = [];
    for (const job of config.jobs) {
      try {
        const out = await fetchHtmlSource({ config: job, delayMs, knownUrls });
        all.push(...out);
      } catch (err) {
        // One bad job shouldn't kill the rest. Log and continue.
        console.error('job failed:', err instanceof Error ? err.message : String(err));
      }
    }
    return all;
  }

  const seen = new Set<string>();
  const items: LinkItem[] = [];

  // List-only branch: extract complete cards (title, date, image, url)
  // from the listing page itself, never visit detail pages. For sites
  // whose detail pages are JS-rendered but whose listing markup is plain
  // HTML — e.g. ABS newsroom (each card has h2 + .publish-date + img + a).
  if (config.list_only) {
    if (!config.list_url) throw new Error('list_only mode requires list_url');
    const indexHtml = await fetchHtml(config.list_url, { requiresJs: config.requires_js });
    const $ = cheerio.load(indexHtml);
    const cardSel = config.list_card_selector ?? 'article, .card, .post';
    const titleSel = config.list_title_selector ?? 'h2, h3';
    const dateSel = config.list_date_selector ?? 'time, .date, .publish-date';
    const linkSel = config.list_link_selector ?? 'a';
    const imgSel = config.list_image_selector ?? 'img';

    const out: RawArticle[] = [];
    $(cardSel).each((_, card) => {
      const $card = $(card);
      const title = $card.find(titleSel).first().text().replace(/\s+/g, ' ').trim();
      if (!title) return;

      let href = $card.find(linkSel).first().attr('href');
      if (!href) return;
      let url = absUrl(href, config.list_url!);
      if (config.url_suffix) url = url.replace(/\/$/, '') + config.url_suffix;
      if (seen.has(url)) return;
      seen.add(url);

      const dateText = $card.find(dateSel).first().text().trim();
      const parsedDate = dateText ? new Date(dateText) : null;
      const publishedAt = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null;

      const $img = $card.find(imgSel).first();
      const imgSrc = $img.attr('src') ?? null;
      const imgAlt = $img.attr('alt')?.trim() ?? '';

      // Build a minimal excerpt from the card so the quality filter passes
      // and FTS has something beyond the title to rank by.
      const excerptBits = [
        dateText && `${dateText}.`,
        title,
        imgAlt && imgAlt !== title ? imgAlt : null,
      ].filter(Boolean) as string[];
      const excerpt = excerptBits.join(' ');

      out.push({
        title,
        url,
        author: null,
        published_at: publishedAt,
        // list_only cards have a curated per-source date selector — when
        // it parses, treat the date as original/high. Null = no date found.
        published_at_source: publishedAt ? 'original' : null,
        published_at_confidence: publishedAt ? 'high' : null,
        excerpt,
        image_url: imgSrc ? absUrl(imgSrc, config.list_url!) : null,
      });
    });
    const max = config.max_items ?? 25;
    return out.slice(0, max);
  }

  // Sitemap branch: skip the HTML index entirely. Used for JS-rendered
  // listing pages where cheerio sees only an empty SPA shell — we read the
  // article URLs straight out of /sitemap.xml instead.
  if (config.sitemap_url) {
    const urls = await fetchSitemapUrls(config.sitemap_url, config.url_pattern);
    for (const u of urls) {
      // Normalise protocol (http→https) the same way absUrl does for HTML
      // anchors, so dedup and url_hash see one URL per resource.
      let abs = u;
      try {
        const parsed = new URL(u);
        if (parsed.protocol === 'http:') parsed.protocol = 'https:';
        abs = parsed.toString();
      } catch { /* leave as-is */ }
      if (config.url_suffix) abs = abs.replace(/\/$/, '') + config.url_suffix;
      if (seen.has(abs)) continue;
      seen.add(abs);
      // Use the slug as fallback link text — works fine for PDF titles.
      const slug = (() => {
        try { return decodeURIComponent(new URL(abs).pathname.split('/').filter(Boolean).pop() ?? ''); }
        catch { return ''; }
      })();
      items.push({ url: abs, linkText: slug.replace(/[-_]+/g, ' ') });
    }
  } else {
    if (!config.list_url) throw new Error('html source missing list_url');
    const listUrl = config.list_url;
    const itemSel = config.item_selector ?? 'article a, h2 a, h3 a';
    const pages = Math.max(1, config.pages ?? 1);

    // Build paginated list-page URLs. Page 1 is always listUrl as-is.
    // For pages 2..N: use pagination_url_template if set, else default to
    // the WordPress permalink convention `${listUrl}page/${n}/`.
    const tmpl = config.pagination_url_template;
    if (tmpl && !tmpl.includes('{n}')) {
      throw new Error(`pagination_url_template must contain {n}: ${tmpl}`);
    }
    const listPageUrls: string[] = [listUrl];
    for (let n = 2; n <= pages; n++) {
      if (tmpl) {
        listPageUrls.push(tmpl.replace(/\{n\}/g, String(n)));
      } else {
        const base = listUrl.endsWith('/') ? listUrl : listUrl + '/';
        listPageUrls.push(`${base}page/${n}/`);
      }
    }

    // Adaptive cutoff: stop paginating after N consecutive items that
    // are already in the DB. Default 5; null/0 disables.
    const stopOnKnown = config.stop_on_known === undefined ? 5 : (config.stop_on_known ?? 0);
    let consecutiveKnown = 0;
    let stopReason: 'pages_exhausted' | 'stop_on_known' | '404' | null = null;

    for (let p = 0; p < listPageUrls.length; p++) {
      const lu = listPageUrls[p];
      let indexHtml: string;
      try {
        indexHtml = await fetchHtml(lu, { requiresJs: config.requires_js });
      } catch (err) {
        // First page must succeed — re-throw so the source is marked
        // blocked/error. For paginated runs, a 404 typically means we ran
        // off the end of the archive; stop paginating but keep what we have.
        if (p === 0) throw err;
        if (err instanceof FetchError && err.status === 404) { stopReason = '404'; break; }
        // Non-404 mid-pagination: log and continue (next page might be ok).
        console.error('list page failed:', lu, err instanceof Error ? err.message : String(err));
        continue;
      }
      const $idx = cheerio.load(indexHtml);
      $idx(itemSel).each((_, el) => {
        const $el = $idx(el);
        const href = $el.attr('href');
        if (!href) return;
        let abs = absUrl(href, lu);
        if (!abs.startsWith('http')) return;
        if (config.url_suffix) {
          // Append the suffix exactly once. We strip an existing trailing slash so
          // /pdf/ + /download → /pdf/download (not /pdf//download).
          abs = abs.replace(/\/$/, '') + config.url_suffix;
        }
        if (seen.has(abs)) return;
        seen.add(abs);
        // Capture the link's anchor text as fallback title (used for PDFs that lack a Title tag).
        const linkText = ($el.text() || $el.attr('title') || '').replace(/\s+/g, ' ').trim();
        items.push({ url: abs, linkText });
        // Adaptive cutoff bookkeeping.
        if (knownUrls && stopOnKnown > 0) {
          if (knownUrls.has(hashUrl(abs))) consecutiveKnown++;
          else consecutiveKnown = 0;
        }
      });
      // Stop paginating once we've passed `stopOnKnown` consecutive known
      // URLs in a row — the deeper pages will almost certainly all be old.
      if (knownUrls && stopOnKnown > 0 && consecutiveKnown >= stopOnKnown) {
        stopReason = 'stop_on_known';
        break;
      }
      // Polite pause between paginated list fetches (only when paginating).
      if (p < listPageUrls.length - 1) await sleep(delayMs);
    }
    if (stopReason === 'stop_on_known') {
      console.log(`stop_on_known: bailed after ${consecutiveKnown} consecutive known URLs (config.list_url=${config.list_url})`);
    }
  }

  // Skip the (slow) detail fetch for any link whose hash is already in the
  // DB. Done before max_items truncation so a deep backfill can scan past
  // already-saved items and still come away with a full batch of new ones.
  const filteredItems = knownUrls
    ? items.filter((it) => !knownUrls.has(hashUrl(it.url)))
    : items;
  const max = config.max_items ?? 15;
  const targets = filteredItems.slice(0, max);

  const out: RawArticle[] = [];
  const visited = new Set<string>(seen);

  // Result of fetching one detail page: either a finished article, a hub
  // whose body we can harvest links from, multiple articles (PDF split into
  // sections), or null (fetch / parse failed).
  type FetchedDetail =
    | { kind: 'article'; article: RawArticle }
    | { kind: 'articles'; articles: RawArticle[] }
    | { kind: 'hub'; $: cheerio.CheerioAPI; provisional: RawArticle }
    | null;

  async function fetchDetail(link: string, linkText: string, allowHub: boolean): Promise<FetchedDetail> {
    try {
      await sleep(delayMs + Math.floor(Math.random() * 2000));

      // PDF detection: filename extension first (cheap), HEAD-sniff if the
      // URL doesn't look like a PDF (Tokyo MOU serves PDFs from URLs ending
      // in /press-releases/.../slug/ with no extension).
      let isPdf = isPdfUrl(link);
      if (!isPdf) {
        const ct = await sniffContentType(link);
        if (ct === 'application/pdf') isPdf = true;
      }
      if (isPdf) {
        const pdf = await extractPdf(link);
        if (!pdf) return null;
        const title = pdf.title ?? linkText;
        if (!title) return null;

        // Optional: split a multi-article PDF into per-section records.
        // Heuristic (free) by default — looks for sequential numbered
        // headings ("1. ...", "2. ...", "Article 1: ...", etc). Falls
        // back to AI (paid, ~$0.0005 per PDF) only when the source opts
        // in via pdf_split_sections_ai. Single-topic PDFs follow the
        // regular code path.
        if (config.pdf_split_sections || config.pdf_split_sections_ai) {
          let sections = extractPdfSections(pdf.excerpt);
          if (sections.length === 0 && config.pdf_split_sections_ai) {
            sections = await extractPdfSectionsAi({
              fallbackTitle: title,
              text: pdf.excerpt,
            });
          }
          if (sections.length > 1) {
            const articles: RawArticle[] = sections.map((s, i) => ({
              title: s.title,
              // Same PDF as target, but a `?part=N` query keeps each
              // section's url_hash unique (the hashUrl util preserves
              // non-tracking query params). Browser/PDF viewers ignore
              // the unknown param and just open the PDF.
              url: `${link}${link.includes('?') ? '&' : '?'}part=${i + 1}`,
              author: null,
              published_at: pdf.publishedAt,
              // PDF metadata is often stale or wrong (CMS export date,
              // template date), so cap at medium even when we got a date.
              published_at_source: pdf.publishedAt ? 'original' : null,
              published_at_confidence: pdf.publishedAt ? 'medium' : null,
              excerpt: `${s.snippet}\n\n— This article is one of several inside the linked PDF; please scroll to find the section titled "${s.title}".`,
              image_url: null,
            }));
            return { kind: 'articles', articles };
          }
        }

        return {
          kind: 'article',
          article: {
            title, url: link, author: null,
            published_at: pdf.publishedAt,
            published_at_source: pdf.publishedAt ? 'original' : null,
            published_at_confidence: pdf.publishedAt ? 'medium' : null,
            excerpt: pdf.excerpt, image_url: null,
          },
        };
      }

      const html = await fetchHtml(link, { requiresJs: config.requires_js });
      const $ = cheerio.load(html);

      // Trim each candidate BEFORE the || short-circuit. Some sites
      // (Japan P&I) ship empty-but-whitespace-padded <h1> elements; an
      // un-trimmed string is truthy, so the og:title / <title> fallbacks
      // would never fire and rawTitle would end up "" after the outer trim.
      const rawTitle =
        $(config.title_selector ?? 'h1').first().text().trim() ||
        ($('meta[property="og:title"]').attr('content') ?? '').trim() ||
        $('title').text().trim() ||
        linkText.trim() ||
        '';
      // Strip common "| Site Name" / " - Site Name" suffixes that <title>
      // tags accumulate. Only strip when the suffix is clearly the site name
      // (short, looks brandy) so we don't truncate real articles like
      // "Russia | What's next?".
      const title = rawTitle
        .replace(/\s*[|]\s*[A-Z][A-Za-z0-9 &.'-]{2,40}$/, '')
        .replace(/\s+-\s+(?:Journal of Commerce|North Standard|NorthStandard|gCaptain|Maritime Executive|Splash 247|Lloyd's List|Hellenic Shipping News|MarineLink|Offshore Energy)\s*$/i, '')
        .trim();
      if (!title) return null;

      let excerpt: string;
      if (config.content_selector) {
        const parts = $(config.content_selector)
          .map((_, el) => $(el).text())
          .get()
          .map((t) => t.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        excerpt = parts.join(' ').slice(0, 2000);
      } else {
        const bodyHtml = $('article').html() ?? $('main').html() ?? $('body').html() ?? '';
        excerpt = stripHtml(bodyHtml).slice(0, 2000);
      }

      const image =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="og:image"]').attr('content') ||
        $('meta[property="og:image:url"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content') ||
        $('meta[name="twitter:image:src"]').attr('content') ||
        $('link[rel="image_src"]').attr('href') ||
        $('article img').first().attr('src') ||
        $('main img').first().attr('src') ||
        null;
      // Date resolution — best-of candidate selection. See
      // resolveArticleDate below for the cascade implementation and
      // confidence semantics. Logging is gated on DEBUG_DATES.
      const dateResolution = resolveArticleDate({
        $, link, title,
        date_selector: config.date_selector,
        date_format: config.date_format,
      });
      if (process.env.DEBUG_DATES && dateResolution) {
        const w = dateResolution.winner;
        const rej = dateResolution.rejected;
        // eslint-disable-next-line no-console
        console.log(`[dates] ${link}\n  winner: ${w.iso} (${w.step}, ${w.confidence})${rej.length ? `\n  rejected:\n${rej.map(r => `    - ${r.iso} (${r.step}, ${r.confidence})`).join('\n')}` : ''}`);
      }

      const provisional: RawArticle = {
        title,
        url: link,
        author: $('meta[name="author"]').attr('content') ?? null,
        published_at: dateResolution?.winner.iso ?? null,
        published_at_source: dateResolution?.winner.source ?? null,
        published_at_confidence: dateResolution?.winner.confidence ?? null,
        excerpt,
        image_url: image ? absUrl(image, link) : null,
      };

      // Hub detection: only when caller allows unfolding (top-level items).
      // Children of a hub are NEVER unfolded again — bounds recursion to 1
      // level and avoids runaway crawls.
      if (allowHub && config.unfold_hubs) {
        const articleVerdict = looksLikeArticle({ title, excerpt });
        if (!articleVerdict.ok && looksLikeHub({ title, excerpt })) {
          return { kind: 'hub', $, provisional };
        }
      }
      return { kind: 'article', article: provisional };
    } catch (err) {
      if (err instanceof FetchError && (err.status === 403 || err.status === 429)) {
        throw err; // bail out — site is blocking
      }
      return null;
    }
  }

  for (const { url: link, linkText } of targets) {
    let detail: FetchedDetail;
    try {
      detail = await fetchDetail(link, linkText, true);
    } catch (err) {
      if (err instanceof FetchError && (err.status === 403 || err.status === 429)) break;
      continue;
    }
    if (!detail) continue;

    if (detail.kind === 'article') {
      out.push(detail.article);
      visited.add(link);
      continue;
    }

    if (detail.kind === 'articles') {
      // PDF split into multiple sections — emit them all under this same
      // source. Each section's URL has a `?part=N` disambiguator so the
      // url_hash uniqueness constraint sees them as distinct rows.
      for (const a of detail.articles) {
        out.push(a);
        visited.add(a.url);
      }
      visited.add(link);
      continue;
    }

    // Hub branch — harvest in-body article links and fetch them as
    // children. Skip the hub itself.
    visited.add(link);
    const childCandidates = harvestArticleLinks(detail.$, link, visited)
      .slice(0, MAX_HUB_CHILDREN);

    for (const child of childCandidates) {
      try {
        const childDetail = await fetchDetail(child.url, child.linkText, false);
        if (childDetail?.kind === 'article') {
          out.push(childDetail.article);
          visited.add(child.url);
        }
      } catch (err) {
        if (err instanceof FetchError && (err.status === 403 || err.status === 429)) break;
      }
    }
  }

  return out;
}
