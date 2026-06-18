import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { extractPdf } from './pdf-extract';

// Phase 2.4. Fetches an article URL and pulls every date-bearing signal
// the page exposes in metadata. The granular signals go into the date
// cascade (extract/date.ts) and let it score cross-signal agreement —
// 2+ agreeing signals → DateConfidence='high'.
//
// Body extraction is intentionally out of scope here; it lands in
// Phase 2.5 (@mozilla/readability + jsdom). For now `bodyHtml` is null
// so the orchestrator keeps using the RSS snippet.
//
// Polite by design: callers should serialise fetches with a delay
// between them (orchestrator handles that).

export type DetailSignals = {
  jsonLdDatePublished: string | null;
  metaArticlePublishedTime: string | null;
  ogPublishedTime: string | null;
  timeElementDatetime: string | null;
  /** PDF /Info CreationDate, parsed from `D:YYYYMMDDHHmmSS±HH'mm'` to
   *  ISO. Only set on PDF responses; null on HTML. Lowest priority in
   *  the date cascade (file-write time ≠ article publish time). */
  pdfMetadataCreation: string | null;
  /** Plausible body-header date label scraped from the first ~500 chars
   *  of PDF text — chrono-node parses "November 6, 2012"-style strings
   *  here. Only set on PDF responses with non-empty text. */
  pdfBodyHeaderProbe: string | null;
};

export type DetailFetchResult = {
  ok: boolean;
  httpStatus: number | null;
  signals: DetailSignals;
  fetchError: string | null;
  /** Page title (og:title preferred, then <title> minus site suffix, then <h1>). */
  title: string | null;
  /** Lean text excerpt — first N joined <p> chars. Not Readability-grade
   *  (that's deferred); good enough to fill `raw_excerpt` for sitemap
   *  sources where the discovery step provides no body at all. */
  bodyExcerpt: string | null;
  /** Reserved for Phase 2.5 full body. */
  bodyHtml: string | null;
  /** True iff the response is a PDF (Content-Type application/pdf OR
   *  URL ends `.pdf`). When true, title/bodyExcerpt/signals are filled
   *  from PDF extraction (unpdf); when false, from HTML (cheerio). */
  isPdf: boolean;
  /** Safety net: response content-length exceeded PDF_MAX_BYTES. The
   *  bytes were never downloaded. Orchestrator rejects as
   *  `pdf_too_large`. Stays false for HTML and small PDFs. */
  pdfTooLarge: boolean;
  /** Safety net: PDF was downloaded but unpdf returned near-zero text
   *  (image-only/scanned PDF, OCR territory). Orchestrator rejects as
   *  `pdf_no_text` (honest visible failure per D16/D18). */
  pdfNoText: boolean;
  /** D22 v3: length of the body excerpt extracted from the DOM via the
   *  Phase 2 container walk ALONE — i.e. what a non-JS reader would
   *  actually see in SSR HTML. Distinct from `bodyExcerpt`, which may
   *  also include Phase 2.5 (__NEXT_DATA__ JSON) or Phase 3 (meta
   *  description) fallback content that hydrates client-side or lives
   *  in head metadata. The orchestrator uses visibleBodyLength to
   *  decide whether the page is publisher-paywalled (small visible
   *  body + paywall phrase ⇒ reader will hit a wall ⇒ reject); the
   *  full bodyExcerpt still feeds search/tagging via DB. */
  visibleBodyLength: number;
  /** D22 v3: SSR-visible text matches at least one of the paywall
   *  phrases ("subscribe to read", "log in to view", "subscribers
   *  only", "begin free trial", "subscribe now", etc.). Combined
   *  with visibleBodyLength: a short visible body AND a paywall
   *  signal ⇒ orchestrator rejects as `paywalled_thin` (reader would
   *  be sent to a teaser-plus-wall page). A long visible body wins
   *  regardless: publisher's full-article paywall doesn't matter if
   *  enough lede is already public. */
  isPaywalled: boolean;
  /** PDF Mode #2: when the fetched page is HTML with a thin body AND
   *  exactly one main-content PDF link (MPA Singapore Port Marine
   *  Notice pattern — the notice title is HTML, the notice BODY is the
   *  linked PDF), detail-fetch follows that link, extracts the PDF, and
   *  merges (HTML title + PDF body + PDF date signals). This field
   *  records the resolved absolute PDF URL so the audit keeps BOTH the
   *  page_url (detected_url) and the pdf_url. Null on every other path
   *  (pure HTML, direct PDF, RSS). */
  embeddedPdfUrl?: string | null;
};

// D22 v3 (2026-05-31): paywall phrase detector RE-INTRODUCED after the
// 2026-05-30 → 2026-05-31 reversal proved over-corrected. Decision
// history (logged so the audit trail is honest, not silently rewritten):
//
//   v1 (2026-05-30 morning): "any paywall phrase ⇒ reject". Too strict.
//     Soft-paywall sites with rich open ledes were skipped even though
//     the open content was substantive.
//   v2 (2026-05-30 evening): "no phrase detection; R15 (body < 400)
//     handles real hard paywalls". Too loose. Misses the exact pattern
//     the user actually objects to: the publisher renders ~3-5 lines of
//     teaser (200-1000 chars, R15-passing) and then a "subscribe to
//     read more" wall. Reader clicks our link → frustration.
//   v3 (2026-05-31, this version): combine BOTH signals. Reject only
//     when SSR-visible body is short (< ~1100 chars) AND a paywall
//     phrase fires in the page. A long visible body wins regardless
//     (the publisher exposed enough lede; the rest being subscriber-
//     only is the publisher's decision and not our concern).
//
// Why this matches the user's stated rule literally:
//   "Okuyucu source sayfasında 3-5 satır + paywall görüyorsa → ALMA.
//    1100+ char görüyorsa → AL."
//
// Implementation:
//   visibleBodyLength = result of Phase 2 (container walk over SSR DOM,
//                       AFTER noise removal). The Phase 2.5 (__NEXT_DATA__
//                       JSON) and Phase 3 (meta description) fallbacks
//                       are EXCLUDED from this measurement on purpose:
//                       they represent content the publisher does NOT
//                       render to a non-subscriber. They still feed
//                       bodyExcerpt for our search/tagging needs, but
//                       they DO NOT count as "what the reader sees".
//   isPaywalled         = case-insensitive substring match of any
//                       paywall phrase against (a) bodyExcerpt,
//                       (b) title, (c) trailing 4KB of raw HTML
//                       (where the paywall CTA usually renders SSR).
//   reject_reason       = 'paywalled_thin' fires when
//                       visibleBodyLength < THRESHOLD && isPaywalled.
//   THRESHOLD           = 1100 chars, per the user's stated example.
//
// The PAYWALL_PHRASES list is the same conservative substring set used
// in v1 — about 50 distinct phrasings observed on real paywalled news
// sites. Subscribe-to-newsletter false positives are mitigated by the
// combination rule: a footer "subscribe to newsletter" won't trigger
// rejection on a page whose article body is long.
const PAYWALL_PHRASES = [
  'only available to subscribers',
  'only available to paid subscribers',
  'only available to members',
  'log in to view',
  'log in to read',
  'log in to continue',
  'log in to see',
  'please log in to read',
  'please log in to view',
  'please log in to continue',
  'log in to your account to continue',
  'sign in to view',
  'sign in to read',
  'sign in to continue',
  'sign in to your account',
  'subscribe to read',
  'subscribe to view',
  'subscribe to continue',
  'subscribe now to read',
  'subscribe now to view',
  'subscribe now to continue',
  'subscribe now',
  'subscribers only',
  'paid subscribers only',
  'premium subscribers only',
  'members only',
  'subscription required',
  'subscription needed',
  'begin free trial',
  'begin a free trial',
  'begin your free trial',
  'start free trial',
  'start your free trial',
  'free trial to read',
  'free trial to view',
  'free trial to continue',
  'register to read',
  'register to view',
  'register to continue',
  'register now to read',
  'sign up to read',
  'sign up to view',
  'sign up to continue',
  'create an account to read',
  'create an account to view',
  'create an account to continue',
  'join to read',
  'join to continue',
  'this content is locked',
  'this article is for subscribers',
  'this article is for paid subscribers',
  'this article is for members',
  'become a subscriber to',
  'become a member to',
  'unlock the rest of this article',
  'unlock this article',
];

/** D22 v3 — threshold for "visible enough" in the combination rule.
 *  Below this AND with a paywall signal ⇒ reject. The user picked
 *  ~1100 from observation ("3-5 lines = reject, ~1100 = accept"); the
 *  exact line is a soft choice and can be tuned by re-running per-source
 *  dry-runs if too many real articles are over-cut or paywalled teasers
 *  slip through. */
export const PAYWALLED_THIN_THRESHOLD = 1100;

function detectPaywall(...texts: (string | null | undefined)[]): boolean {
  for (const t of texts) {
    if (!t) continue;
    const lower = t.toLowerCase();
    for (const phrase of PAYWALL_PHRASES) {
      if (lower.includes(phrase)) return true;
    }
  }
  return false;
}

// PDF magic header check. A genuine PDF response starts with the bytes
// `%PDF-` (0x25 0x50 0x44 0x46 0x2D) within the first ~1KB (most start
// in byte 0; some are wrapped in HTTP-level transformations and start a
// few bytes in). If a request returned 200 OK with Content-Type
// application/pdf or a `.pdf` URL but the body is NOT a PDF, the server
// almost certainly returned an HTML login/paywall page dressed as a
// PDF download — common pattern for P&I-club and class-society
// commercial bulletins. Returns true if the response IS a valid PDF.
function looksLikeRealPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  const head = bytes.subarray(0, Math.min(1024, bytes.length));
  // %PDF- = [0x25, 0x50, 0x44, 0x46, 0x2D]
  for (let i = 0; i <= head.length - 5; i++) {
    if (
      head[i] === 0x25 &&
      head[i + 1] === 0x50 &&
      head[i + 2] === 0x44 &&
      head[i + 3] === 0x46 &&
      head[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

// Strip common " | Site Name", " - Site Name", " — Site Name" suffixes
// from <title>. Keeps the article headline only.
function stripTitleSuffix(t: string): string {
  return t.replace(/\s*[|\-–—]\s*[^|\-–—]+\s*$/, '').trim();
}

// Real-browser UA. Major news CDNs (Cloudflare, Akamai) reject UAs that
// self-identify as bots — Splash247 returned HTTP 403 to a transparent
// "maritime-reader-v2" UA. v1's `lib/scrapers/util.ts` runs a Chrome
// pool for the same reason. The page itself is publicly served; only
// the bot-UA path is blocked. RSS feed (which announces source name in
// its title) stays public regardless.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

function emptySignals(): DetailSignals {
  return {
    jsonLdDatePublished: null,
    metaArticlePublishedTime: null,
    ogPublishedTime: null,
    timeElementDatetime: null,
    pdfMetadataCreation: null,
    pdfBodyHeaderProbe: null,
  };
}

// Per-PDF size limit. Caps memory + parse time on the rare scanned-
// document PDF (often hundreds of pages, image-only, dozens of MB).
// Hit BEFORE downloading bytes via Content-Length header; if the header
// is absent we accept and read defensively (most maritime advisories
// are well under this anyway).
const PDF_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

// 2026-05-30: raised 600 → 2000. With 600, BIMCO/ML were saturating the
// cap (real article body is longer than 600 chars) and getting truncated;
// search/tagging downstream gets thinner content than the source page
// actually carries. 2000 is enough headroom for a typical maritime news
// article's first ~3-5 paragraphs (the part that carries the lede +
// dateline + first concrete facts — the highest-value chunk for keyword
// search and AI segment/theme classification). Pages that legitimately
// have < 2000 chars of article body still pass; the cap only matters
// when there IS more content available and we were chopping it.
const EXCERPT_MAX_CHARS = 2000;

// PDF detection. Two signals, either is sufficient:
//   - Response Content-Type starts with application/pdf (sometimes
//     followed by ;charset=... or other params; lowercase + startsWith)
//   - URL path ends with .pdf, case-insensitive (covers cases where
//     server returns a generic content-type or strips it via CDN)
// Used by detail-fetch to set DetailFetchResult.isPdf so the orchestrator
// can reject as `pdf_unsupported` (honest) rather than `no_title` (mask).
function isPdfResponse(url: string, contentType: string | null): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase().trim();
    if (ct.startsWith('application/pdf')) return true;
  }
  try {
    const u = new URL(url);
    if (/\.pdf(?:$|\?)/i.test(u.pathname)) return true;
  } catch {
    // unparseable URL — fall through, isPdf stays false
  }
  return false;
}

// D21: scope body extraction to main-content containers and strip
// global site chrome before reading <p>. Site-wide nav/header/footer/
// sidebar/promo/subscribe boxes wrap real article content with their
// own paragraphs; without removal, a densest-<p> pass picks up "Learn
// all about how commercial shipping works..." (BIMCO global tease) or
// a sticky weekly-briefing promo (JoC, identical excerpt across all 10
// articles). The sibling of D7 for HTML body: "extracted != correct".
//
// Two-phase approach:
//   1. Globally remove noise containers (nav, header, footer, aside,
//      ARIA navigation/banner/contentinfo/complementary, common
//      class-name patterns for sidebars/promo/subscribe/related/share).
//   2. Walk a tightened container preference list, most-semantic first
//      ([itemprop="articleBody"], <article>) before falling back to
//      generic main/.entry-content/body.
//
// Mutates `$` (cheerio doesn't expose a clone). Title extraction reads
// <head> meta + <title> + <h1>; we keep <h1> intact (only the global
// chrome wrappers go), so title extraction still works after this runs.
// Callers MUST evaluate extractTitle() before extractBodyExcerpt() if
// they depend on the same $ — JS object-literal property evaluation in
// fetchDetail() does this in source order.
type BodyExtractResult = {
  /** Final body excerpt the orchestrator uses for raw_excerpt — may be
   *  any of: DOM container walk (Phase 2), __NEXT_DATA__ JSON (Phase 2.5),
   *  or meta description (Phase 3). Null when nothing usable surfaced. */
  excerpt: string | null;
  /** D22 v3: length of the body excerpt from Phase 2 (DOM container
   *  walk) ALONE. Reflects what a non-JS reader sees in SSR HTML — the
   *  "open content" portion of the page. Zero when Phase 2 found
   *  nothing and the orchestrator had to fall back to JSON or meta. */
  visibleLength: number;
  /** Which phase produced `excerpt`. Useful in diagnostics; not consumed
   *  by the orchestrator decision (visibleLength + isPaywalled are what
   *  decide). */
  source: 'dom' | 'next_data' | 'meta_description' | 'none';
};

function extractBodyExcerpt($: CheerioAPI): BodyExtractResult {
  // Phase 1 — strip global site chrome and known boilerplate wrappers.
  // NOTE on script handling: blanket `<script>` removal would also nuke
  // `<script id="__NEXT_DATA__">` and similar SSR-payload-in-script tags
  // that Phase 2.5 below needs to read for client-hydrated sites (JoC
  // pattern). Use `:not()` to keep the SSR-data scripts intact while
  // still stripping the rest (analytics, framework runtime, etc.).
  const noiseSelectors = [
    'nav', 'header', 'footer', 'aside',
    'script:not(#__NEXT_DATA__):not([id*="NEXT_DATA"]):not([type="application/ld+json"])',
    'style', 'noscript', 'iframe', 'form',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
    '[role="search"]',
    '.nav', '.navbar', '.menu', '.navigation', '.main-nav', '.primary-nav', '.site-nav',
    '.header', '.site-header', '.global-header', '.page-header', '.masthead',
    '.footer', '.site-footer', '.global-footer', '.page-footer',
    '.sidebar', '.side-bar', '.aside',
    '.related', '.related-posts', '.related-articles', '.recommended', '.you-may-also-like',
    '.promo', '.promotional', '.promo-box', '.promo-banner',
    '.subscribe', '.subscription', '.newsletter', '.newsletter-signup', '.signup', '.cta',
    '.social', '.social-share', '.share', '.share-buttons', '.share-bar', '.sharing',
    '.comments', '.comment-list', '.comment-section',
    '.breadcrumb', '.breadcrumbs',
    '.advertisement', '.ad', '.ads', '.ad-container', '.adsbygoogle',
    '.cookie', '.cookie-banner', '.cookie-consent', '.gdpr',
    '.modal', '.popup', '.overlay',
    '.tease', '.tease-content', '.intro-block', '.lead-in',
    // BEM-style "additional news" / "more articles" / "next reads" widgets:
    // tend to wrap a card list of OTHER articles' lede paragraphs inside
    // <main>, which a generic densest-<p> picker happily grabs. JoC's
    // c-additional-news + VerticalCard pair was the 2026-05-30 doğuş vaka.
    '[class*="additional-news"]', '[class*="additional-articles"]',
    '[class*="more-news"]', '[class*="more-articles"]', '[class*="more-stories"]',
    '[class*="other-news"]', '[class*="other-articles"]',
    '[class*="latest-news"]', '[class*="next-read"]', '[class*="next-article"]',
    '[class*="recommended"]', '[class*="suggested"]',
    // CSS-modules card pattern (Next.js / styled-components emit
    // class names like `VerticalCard_description__abc123`). These are
    // almost always card/widget wrappers, not real article body.
    '[class*="Card_"]', '[class*="VerticalCard"]', '[class*="HorizontalCard"]',
    '[class*="ArticleCard"]', '[class*="NewsCard"]', '[class*="StoryCard"]',
  ];
  for (const sel of noiseSelectors) {
    $(sel).remove();
  }

  // Phase 2 — preferred container hierarchy, most-semantic first.
  const containers = [
    '[itemprop="articleBody"]',
    'article [itemprop="articleBody"]',
    'article',
    '[role="article"]',
    '[role="main"] article',
    '[role="main"]',
    'main article',
    'main',
    '.entry-content',
    '.post-content',
    '.article-content',
    '.article-body',
    '.story-body',
    '.content-body',
    '.post-body',
    '.content',
    'body',
  ];
  for (const sel of containers) {
    const node = $(sel).first();
    if (node.length === 0) continue;
    const paragraphs: string[] = [];
    node.find('p').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t.length >= 40) paragraphs.push(t);
    });
    if (paragraphs.length === 0) continue;
    const joined = paragraphs.join(' ').slice(0, EXCERPT_MAX_CHARS).trim();
    if (joined.length >= 80) {
      // Phase 2 win: this is the DOM-visible body the reader sees in
      // SSR HTML. visibleLength = its length, source = 'dom'.
      return { excerpt: joined, visibleLength: joined.length, source: 'dom' };
    }
  }

  // Phase 2.5 — __NEXT_DATA__ JSON probe. Next.js / Gatsby / many modern
  // CMSes embed the SSR data as a JSON blob in a <script id="__NEXT_DATA__">
  // (or similar). When the DOM body is hydrated client-side (JoC pattern)
  // the article body never lands in HTML at all, but the JSON blob
  // carries it in a field with a common name. Walk the parsed JSON
  // looking for the first long-enough string under a known field name.
  // This is BEFORE the meta-description fallback because the JSON body
  // is the real article content (paragraphs joined), while meta-desc is
  // a 1-2 sentence SEO summary. Full > summary every time.
  //
  // D22 v3 note: anything we surface from JSON is content the non-JS
  // reader does NOT see — it's the SUBSCRIBER's body, not the
  // teaser. visibleLength stays 0 so the orchestrator's combination
  // rule (short visible + paywall ⇒ reject) fires.
  const nextDataRaw = $('script#__NEXT_DATA__').first().contents().text().trim()
    || $('script[id*="NEXT_DATA"]').first().contents().text().trim();
  if (nextDataRaw) {
    try {
      const parsed = JSON.parse(nextDataRaw);
      const body = findArticleBodyInJson(parsed);
      if (body && body.length >= 80) {
        const cleaned = body.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX_CHARS);
        return { excerpt: cleaned, visibleLength: 0, source: 'next_data' };
      }
    } catch {
      // Malformed JSON — skip silently and fall through to meta-desc.
    }
  }

  // Phase 3 — meta-description fallback for SSR-thin pages. Sites that
  // hydrate body content client-side (Next.js + Suspense, JoC pattern)
  // leave nothing useful inside <main> after noise removal — the SSR
  // HTML carries cards/teaser shells but the real article body lands
  // only after JS runs. The page still ships an article-specific
  // `<meta name="description">` (or og:description / twitter:description)
  // that holds the lede paragraph or summary. Three checks in priority:
  // standard meta-desc → og:description → twitter:description. Each is
  // article-specific (we proved this across 3 JoC articles, each meta
  // was a different lede paragraph). Better than null; far better than
  // boilerplate.
  //
  // D22 v3 note: meta description sits in `<head>`, never rendered to
  // the reader on the page itself — same logic as the JSON fallback,
  // visibleLength stays 0.
  const metaProbes = [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
  ];
  for (const sel of metaProbes) {
    const v = $(sel).attr('content');
    if (v) {
      const cleaned = v.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX_CHARS);
      if (cleaned.length >= 80) {
        return { excerpt: cleaned, visibleLength: 0, source: 'meta_description' };
      }
    }
  }
  return { excerpt: null, visibleLength: 0, source: 'none' };
}

function extractTitle($: CheerioAPI): string | null {
  const og = $('meta[property="og:title"]').attr('content');
  if (og && og.trim().length > 0) return og.trim();
  const titleTag = $('title').first().text().trim();
  if (titleTag.length > 0) return stripTitleSuffix(titleTag);
  const h1 = $('h1').first().text().trim();
  if (h1.length > 0) return h1;
  return null;
}

// __NEXT_DATA__ (and similar JSON-payload-in-script patterns) embed the
// article body under one of several conventional field names. Walk the
// parsed JSON recursively, prefer longer strings, prefer common body
// field names. Depth-capped to keep walk bounded on huge SSR payloads.
//
// Strategy:
//   1. If a node is an object with a recognised body-field key whose
//      value is a string of length ≥ 200, return it (early winner).
//   2. Otherwise recurse into object values and array elements.
//   3. Return the longest qualifying string seen anywhere in the tree
//      (after a full walk), so that non-canonical field names still
//      surface real bodies as long as they're long enough.
const BODY_FIELD_NAMES = new Set<string>([
  'BodyPlainText',
  'bodyPlainText',
  'articleBody',
  'ArticleBody',
  'bodyText',
  'BodyText',
  'plainText',
  'PlainText',
  'fullText',
  'FullText',
  'storyBody',
  'StoryBody',
  'content',
  'Content',
  'body',
  'Body',
]);
const MAX_NEXT_DATA_DEPTH = 8;
const MIN_BODY_FIELD_LEN = 200;

function findArticleBodyInJson(node: unknown): string | null {
  // BFS (shallowest-match-wins). Page-level embeds like Next.js
  // __NEXT_DATA__ tend to hold the CURRENT article's body at a shallow
  // path (e.g. `props.pageProps.pageSpecificProps.article.BodyPlainText`,
  // depth ~5) and ALSO the bodies of every sidebar widget item (recent
  // headlines, "more articles", related, etc.) at a deeper path (depth
  // ~8+). A depth-first / longest-wins walk picks whichever sidebar
  // item happens to be longest, so EVERY page in a batch returns the
  // SAME body (the site's #1 latest headline) — JoC dry-run R13 surfaced
  // this 2026-05-31 with 10/10 rows sharing Seattle-Tacoma's body.
  //
  // BFS pre-order with first-match-wins keeps us on the canonical article
  // path: depth 5 fires before depth 8, so the per-page article body
  // beats the per-page sidebar feed every time. Fallback (no known body
  // field name anywhere) is the longest paragraph-shaped generic string,
  // which we ALSO collect during the BFS so a single pass covers both.
  if (node == null) return null;
  type Q = { val: unknown; depth: number };
  const queue: Q[] = [{ val: node, depth: 0 }];
  let bestGeneric: string | null = null;
  while (queue.length > 0) {
    const { val, depth } = queue.shift()!;
    if (depth > MAX_NEXT_DATA_DEPTH || val == null) continue;
    if (typeof val === 'string') {
      // Generic long-string fallback. Paragraph-shaped only (has spaces
      // and sentence punctuation), to avoid inline base64/JWT/CSS blobs.
      if (val.length >= MIN_BODY_FIELD_LEN && / /.test(val) && /[.!?]/.test(val)) {
        if (!bestGeneric || val.length > bestGeneric.length) bestGeneric = val;
      }
      continue;
    }
    if (Array.isArray(val)) {
      for (const el of val) queue.push({ val: el, depth: depth + 1 });
      continue;
    }
    if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      // Pre-order check: any known body-field name at THIS level wins
      // immediately. Shallowest match across the whole tree, courtesy
      // of BFS ordering.
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (BODY_FIELD_NAMES.has(k) && typeof v === 'string' && v.length >= MIN_BODY_FIELD_LEN) {
          return v;
        }
      }
      // Then enqueue children for the next depth ring.
      for (const k of Object.keys(obj)) {
        queue.push({ val: obj[k], depth: depth + 1 });
      }
    }
  }
  return bestGeneric;
}

// JSON-LD <script type="application/ld+json"> can be a single object, an
// array, or wrapped in @graph[]. Search recursively for datePublished;
// take the first non-empty value (priority: top-level > graph).
function findDatePublishedInJsonLd(node: unknown): string | null {
  if (!node) return null;
  if (typeof node !== 'object') return null;
  // Array: try each element.
  if (Array.isArray(node)) {
    for (const el of node) {
      const v = findDatePublishedInJsonLd(el);
      if (v) return v;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.datePublished === 'string' && obj.datePublished.length > 0) {
    return obj.datePublished;
  }
  // @graph wrapping (schema.org common pattern).
  if (obj['@graph']) {
    const v = findDatePublishedInJsonLd(obj['@graph']);
    if (v) return v;
  }
  return null;
}

// PDF Mode #2 — HTML page whose body IS a linked PDF (MPA Singapore Port
// Marine Notice: HTML carries title + a single "Pn26 75 (369 KB, .pdf)"
// download link; the notice content lives only in that PDF). Mode #2 is
// triggered when, after the Phase-1 noise strip, the HTML body the reader
// sees is THIN (real content isn't in the HTML) AND there is EXACTLY ONE
// PDF link in the main container. "Exactly one" is the safety rail: a
// rich HTML article that merely links a supplementary PDF has a non-thin
// body (so we never get here), and a notice page with nav/archive PDF
// noise would have >1 (so we abstain rather than guess). 0 or >1 ⇒ no
// Mode #2; the page is handled as ordinary HTML.
const EMBEDDED_PDF_HTML_THIN = 400; // matches R15's thin-content floor

// Scan the (already noise-stripped) tree's main container for PDF anchors.
// Returns the single absolute PDF URL, or null when there are 0 or >1
// (abstain — never guess which of several is the article).
function findMainPdfLink($: CheerioAPI, pageUrl: string): string | null {
  const containers = [
    '[itemprop="articleBody"]', 'article', '[role="article"]', '[role="main"] article',
    '[role="main"]', 'main article', 'main', '.entry-content', '.post-content',
    '.article-content', '.article-body', '.content-body', '.content', 'body',
  ];
  for (const sel of containers) {
    const node = $(sel).first();
    if (node.length === 0) continue;
    const hrefs: string[] = [];
    node.find('a[href]').each((_, el) => {
      const href = ($(el).attr('href') ?? '').trim();
      if (/\.pdf(\?|#|$)/i.test(href)) {
        try { hrefs.push(new URL(href, pageUrl).toString()); } catch { /* skip unparseable */ }
      }
    });
    // dedup (a notice often repeats the same download link as icon + text)
    const uniq = Array.from(new Set(hrefs));
    if (uniq.length === 0) continue;     // try the next, more-specific container up the list
    return uniq.length === 1 ? uniq[0] : null; // >1 in the first container that has any ⇒ abstain
  }
  return null;
}

type EmbeddedPdfResult = {
  ok: boolean;          // true only when a real PDF with extractable text was obtained
  httpStatus: number | null;
  fetchError: string | null;
  pdfNoText: boolean;   // magic-byte fail (login wall dressed as .pdf) OR image-only/empty
  pdfTooLarge: boolean;
  pdfMetadataCreation: string | null;
  pdfBodyHeaderProbe: string | null;
  title: string | null;
  bodyExcerpt: string | null;
};

// Fetch + validate + extract a single embedded PDF URL, reusing the same
// proven primitives the direct-PDF branch uses (PDF_MAX_BYTES, the
// looksLikeRealPdf magic-byte gate, unpdf-based extractPdf). Any failure
// surfaces as pdfNoText/pdfTooLarge so the orchestrator's EXISTING honest-
// rejection gates (pdf_no_text / pdf_too_large) fire — including the D22
// case where the "PDF" is really a login/paywall HTML wrapper (magic-byte
// fail ⇒ pdfNoText ⇒ reject). Never masks a wall as a real article.
async function fetchEmbeddedPdf(pdfUrl: string, timeoutMs = 15_000): Promise<EmbeddedPdfResult> {
  const base: EmbeddedPdfResult = {
    ok: false, httpStatus: null, fetchError: null, pdfNoText: false, pdfTooLarge: false,
    pdfMetadataCreation: null, pdfBodyHeaderProbe: null, title: null, bodyExcerpt: null,
  };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(pdfUrl, { headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' }, redirect: 'follow', signal: controller.signal });
  } catch (e) {
    clearTimeout(t);
    return { ...base, fetchError: `embedded PDF fetch failed: ${(e as Error).message}`, pdfNoText: true };
  }
  clearTimeout(t);
  base.httpStatus = res.status;
  if (!res.ok) return { ...base, fetchError: `embedded PDF HTTP ${res.status}`, pdfNoText: true };

  const lenHeader = res.headers.get('content-length');
  const declared = lenHeader ? parseInt(lenHeader, 10) : NaN;
  if (Number.isFinite(declared) && declared > PDF_MAX_BYTES) {
    return { ...base, fetchError: `embedded PDF too large: ${declared} > ${PDF_MAX_BYTES}`, pdfTooLarge: true };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return { ...base, fetchError: `embedded PDF read failed: ${(e as Error).message}`, pdfNoText: true };
  }
  if (bytes.length > PDF_MAX_BYTES) {
    return { ...base, fetchError: `embedded PDF too large after download: ${bytes.length} > ${PDF_MAX_BYTES}`, pdfTooLarge: true };
  }
  if (!looksLikeRealPdf(bytes)) {
    // The "PDF" link returned non-PDF bytes — almost always a login /
    // paywall HTML wrapper. D22: reader following our link hits a wall.
    return {
      ...base,
      fetchError: `embedded PDF failed %PDF- magic-byte (likely login/paywall HTML wrapper). First bytes: ${Array.from(bytes.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`,
      pdfNoText: true,
    };
  }
  const pdf = await extractPdf(bytes);
  if (pdf.isEmpty) {
    return { ...base, fetchError: `embedded PDF text extraction returned ${pdf.bodyLength} chars (image-only/scanned)`, pdfNoText: true };
  }
  return {
    ok: true,
    httpStatus: res.status,
    fetchError: null,
    pdfNoText: false,
    pdfTooLarge: false,
    pdfMetadataCreation: pdf.pdfCreationDate,
    pdfBodyHeaderProbe: pdf.bodyHeaderProbe,
    title: pdf.title,
    bodyExcerpt: pdf.bodyExcerpt,
  };
}

export async function fetchDetail(url: string, timeoutMs = 15_000): Promise<DetailFetchResult> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="121", "Google Chrome";v="121"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(t);
    return {
      ok: false,
      httpStatus: null,
      signals: emptySignals(),
      fetchError: (e as Error).message,
      title: null,
      bodyExcerpt: null,
      bodyHtml: null,
      isPdf: isPdfResponse(url, null), // URL-only check on network failure
      pdfTooLarge: false,
      pdfNoText: false,
      visibleBodyLength: 0,
      isPaywalled: false,
    };
  }
  clearTimeout(t);

  // Detect PDF BEFORE trying to cheerio-parse. Two signals: response
  // Content-Type and URL extension.
  const pdfDetected = isPdfResponse(url, res.headers.get('content-type'));

  if (!res.ok) {
    return {
      ok: false,
      httpStatus: res.status,
      signals: emptySignals(),
      fetchError: `HTTP ${res.status}`,
      title: null,
      bodyExcerpt: null,
      bodyHtml: null,
      isPdf: pdfDetected,
      pdfTooLarge: false,
      pdfNoText: false,
      visibleBodyLength: 0,
      isPaywalled: false,
    };
  }

  // PDF branch (Phase 2.5 sub-slice): download bytes (subject to size
  // limit), extract title/body/date via unpdf, return a result that
  // SHARES the same DetailFetchResult shape as HTML — orchestrator and
  // downstream tagging/search/segment code don't need to know whether
  // an article was sourced from PDF or HTML.
  if (pdfDetected) {
    // Pre-flight size check via Content-Length. If the server didn't
    // send one we still proceed (most maritime advisories are small);
    // if it did and exceeds the cap, refuse to download.
    const lenHeader = res.headers.get('content-length');
    const declaredSize = lenHeader ? parseInt(lenHeader, 10) : NaN;
    if (Number.isFinite(declaredSize) && declaredSize > PDF_MAX_BYTES) {
      return {
        ok: false,
        httpStatus: res.status,
        signals: emptySignals(),
        fetchError: `PDF too large: ${declaredSize} bytes > ${PDF_MAX_BYTES} cap`,
        title: null,
        bodyExcerpt: null,
        bodyHtml: null,
        isPdf: true,
        pdfTooLarge: true,
        pdfNoText: false,
        visibleBodyLength: 0,
        isPaywalled: false,
        };
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      return {
        ok: false,
        httpStatus: res.status,
        signals: emptySignals(),
        fetchError: `PDF body read failed: ${(e as Error).message}`,
        title: null,
        bodyExcerpt: null,
        bodyHtml: null,
        isPdf: true,
        pdfTooLarge: false,
        pdfNoText: false,
        visibleBodyLength: 0,
        isPaywalled: false,
        };
    }

    // Defensive post-download size check: if Content-Length was missing
    // or lied and the real body exceeds the cap, refuse to extract.
    if (bytes.length > PDF_MAX_BYTES) {
      return {
        ok: false,
        httpStatus: res.status,
        signals: emptySignals(),
        fetchError: `PDF too large after download: ${bytes.length} bytes > ${PDF_MAX_BYTES} cap`,
        title: null,
        bodyExcerpt: null,
        bodyHtml: null,
        isPdf: true,
        pdfTooLarge: true,
        pdfNoText: false,
        visibleBodyLength: 0,
        isPaywalled: false,
        };
    }

    // PDF magic-byte validation. URL said `.pdf` (or server claimed
    // application/pdf) but the body bytes are NOT a real PDF: server
    // returned an HTML page (often a login/paywall wall, sometimes a
    // generic 200-OK error page) wearing a PDF URL. Reject as
    // `pdf_no_text` — from the extractor's point of view there is no
    // PDF content here, which is exactly the meaning of pdf_no_text.
    // Honest, technical, no paywall heuristic.
    if (!looksLikeRealPdf(bytes)) {
      return {
        ok: false,
        httpStatus: res.status,
        signals: emptySignals(),
        fetchError: `PDF response failed %PDF- magic-byte validation (server returned non-PDF bytes — likely an HTML wrapper). First bytes: ${Array.from(bytes.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`,
        title: null,
        bodyExcerpt: null,
        bodyHtml: null,
        isPdf: true,
        pdfTooLarge: false,
        pdfNoText: true,
        visibleBodyLength: 0,
        isPaywalled: false,
      };
    }

    const pdf = await extractPdf(bytes);
    const sig = emptySignals();
    sig.pdfMetadataCreation = pdf.pdfCreationDate;
    sig.pdfBodyHeaderProbe = pdf.bodyHeaderProbe;
    // D22 v3 — PDF content is fully "visible" to the reader once they
    // open the PDF (no incremental paywall mechanic the way HTML pages
    // have). Treat the extracted PDF text length as visibleBodyLength
    // so the orchestrator's combination rule treats short-but-paywall-
    // phrased PDFs (e.g. "subscribe to read the rest" notice PDFs)
    // consistently with their HTML cousins.
    const pdfBodyLen = pdf.bodyExcerpt?.length ?? 0;
    const pdfPaywall = detectPaywall(pdf.bodyExcerpt, pdf.title);
    return {
      ok: true,
      httpStatus: res.status,
      signals: sig,
      fetchError: pdf.isEmpty
        ? `PDF text extraction returned ${pdf.bodyLength} chars (likely scanned/image-only)`
        : null,
      title: pdf.title,
      bodyExcerpt: pdf.bodyExcerpt,
      bodyHtml: null,
      isPdf: true,
      pdfTooLarge: false,
      pdfNoText: pdf.isEmpty,
      visibleBodyLength: pdfBodyLen,
      isPaywalled: pdfPaywall,
    };
  }

  let html: string;
  try {
    html = await res.text();
  } catch (e) {
    return {
      ok: false,
      httpStatus: res.status,
      signals: emptySignals(),
      fetchError: `body read failed: ${(e as Error).message}`,
      title: null,
      bodyExcerpt: null,
      bodyHtml: null,
      isPdf: false,
      pdfTooLarge: false,
      pdfNoText: false,
      visibleBodyLength: 0,
      isPaywalled: false,
    };
  }

  const $ = cheerio.load(html);
  const signals = emptySignals();

  // <meta property="article:published_time" content="...">
  const metaArticle = $('meta[property="article:published_time"]').attr('content');
  if (metaArticle) signals.metaArticlePublishedTime = metaArticle.trim();

  // <meta property="og:published_time" content="...">  (less common, but seen)
  const og = $('meta[property="og:published_time"]').attr('content');
  if (og) signals.ogPublishedTime = og.trim();

  // First <time datetime="...">
  const timeAttr = $('time[datetime]').first().attr('datetime');
  if (timeAttr) signals.timeElementDatetime = timeAttr.trim();

  // JSON-LD: every <script type="application/ld+json">, parse each, search.
  $('script[type="application/ld+json"]').each((_, el) => {
    if (signals.jsonLdDatePublished) return; // already found
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const dp = findDatePublishedInJsonLd(parsed);
      if (dp) signals.jsonLdDatePublished = dp;
    } catch {
      // JSON-LD blocks sometimes contain template literals or are
      // malformed; skip silently rather than blow up the whole fetch.
    }
  });

  // Title BEFORE extractBodyExcerpt — that function mutates the cheerio
  // tree (Phase 1 noise removal). Title reads head meta + <title> + <h1>,
  // all of which we want to evaluate against the pre-mutated tree.
  const title = extractTitle($);
  const body = extractBodyExcerpt($);
  // D22 v3 — paywall phrase check across the WHOLE SSR HTML, not just
  // the last 4KB. On client-hydrated sites (JoC), the "Subscribe now"
  // CTA can render anywhere in the SSR shell — earlier probing showed
  // JoC's CTA lives well before the last 4KB of a 226KB page, so a
  // tail-only scan missed it and let paywalled rows through. indexOf
  // across 200-300KB is sub-ms; the cost is negligible compared to the
  // single network fetch we already paid for. body.excerpt + title are
  // checked separately so a paywall marker on either surface alone
  // (e.g. a "Premium" badge in the title) still triggers.
  const isPaywalled = detectPaywall(body.excerpt, title, html);

  // PDF Mode #2 — thin HTML body + exactly one main-content PDF link ⇒
  // the article body IS the linked PDF (MPA Port Marine Notice pattern).
  // Follow it, extract via the proven PDF path, merge HTML title + PDF
  // body/date. Only attempt when the HTML body is thin so a rich HTML
  // article that merely links a supplementary PDF is never hijacked.
  if (body.visibleLength < EMBEDDED_PDF_HTML_THIN) {
    const embeddedPdfUrl = findMainPdfLink($, url);
    if (embeddedPdfUrl) {
      const ep = await fetchEmbeddedPdf(embeddedPdfUrl);
      if (ep.ok) {
        // Success: keep the HTML notice title (cleaner than the PDF's
        // internal title), take the PDF's body + date signals. The PDF,
        // once opened, is fully visible to the reader (no incremental
        // wall) — so visibleBodyLength = PDF body length, consistent
        // with the direct-PDF branch.
        const sig = { ...signals, pdfMetadataCreation: ep.pdfMetadataCreation, pdfBodyHeaderProbe: ep.pdfBodyHeaderProbe };
        return {
          ok: true,
          httpStatus: res.status,
          signals: sig,
          fetchError: null,
          title: title ?? ep.title,
          bodyExcerpt: ep.bodyExcerpt,
          bodyHtml: null,
          isPdf: false, // HTML-wrapped; the page itself is HTML
          pdfTooLarge: false,
          pdfNoText: false,
          visibleBodyLength: ep.bodyExcerpt?.length ?? 0,
          isPaywalled: detectPaywall(ep.bodyExcerpt, title),
          embeddedPdfUrl,
        };
      }
      // Failure (login wall / image-only / too large / fetch error):
      // surface via pdfNoText/pdfTooLarge so the orchestrator's existing
      // honest-rejection gates fire. D22: an embedded "PDF" that is really
      // a login wall ⇒ magic-byte fail ⇒ pdfNoText ⇒ rejected, not written.
      return {
        ok: false,
        httpStatus: ep.httpStatus,
        signals,
        fetchError: ep.fetchError,
        title,
        bodyExcerpt: body.excerpt,
        bodyHtml: null,
        isPdf: false,
        pdfTooLarge: ep.pdfTooLarge,
        pdfNoText: ep.pdfNoText,
        visibleBodyLength: body.visibleLength,
        isPaywalled,
        embeddedPdfUrl,
      };
    }
  }

  return {
    ok: true,
    httpStatus: res.status,
    signals,
    fetchError: null,
    title,
    bodyExcerpt: body.excerpt,
    bodyHtml: null, // Phase 2.5 full body via Readability reserved
    isPdf: false,
    pdfTooLarge: false,
    pdfNoText: false,
    visibleBodyLength: body.visibleLength,
    isPaywalled,
    embeddedPdfUrl: null,
  };
}
