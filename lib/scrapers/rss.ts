import Parser from 'rss-parser';
import { randomUserAgent, sleep, stripHtml } from './util';

/** Trim the noisy tail of a YouTube video description — promo links,
 *  social handles, hashtags, "Marine Traffic" reference rows, and the
 *  embedded list of "related articles" some channels (WGOW Shipping,
 *  in particular) append below the actual description.
 *
 *  Why this matters: those related-articles lists include the FULL
 *  TITLES of unrelated articles, which then leak into our excerpt and
 *  cause false positives in search. e.g. a tanker-strike video
 *  surfaced for "grain cargo" because its description footer contained
 *  "Ukraine seizes cargo ship accused of transporting grain from
 *  Crimea" as a related-reading link.
 *
 *  Strategy: scan for known section-break markers (social handles,
 *  Patreon/Subscribe lines, hashtag-only lines, "Source:"-style cite
 *  lines, timestamp chapter lines). Cut at the FIRST marker that
 *  appears — anything after is structural noise, not editorial. */
export function trimYouTubeDescription(desc: string): string {
  if (!desc) return desc;
  const MARKERS: RegExp[] = [
    /\n#\w+(\s+#\w+){1,}/i,               // two or more hashtags on one line
    /\nPatreon\s*:/i,
    /\nTwitter\s*:/i,
    /\nBluesky\s*:/i,
    /\nFacebook\s*:/i,
    /\nInstagram\s*:/i,
    /\nLinkedIn\s*:/i,
    /\nTikTok\s*:/i,
    /\nYouTube\s*:/i,
    /\nDiscord\s*:/i,
    /\nEmail\s*:/i,
    /\nWebsite\s*:/i,
    /\nSupport (this|the|us|our|me|my)/i,
    /\nSubscribe (to|here|now|for)/i,
    /\nFollow (me|us|on)/i,
    /\nJoin (this|the|our|my)/i,
    /\nMarine Traffic\s*\n/i,             // common reference link blob
    /\n(0?0:00|0:00)\s/i,                 // timestamp / chapter lines
    /\nChapters?\s*:/i,
    /\n=+\s*\n/,                          // === divider lines
    /\n-{3,}\s*\n/,                        // --- divider lines
    /\n#supplychain/i,                     // commonly the start of a tag block
  ];

  let cutAt = desc.length;
  for (const re of MARKERS) {
    const m = desc.match(re);
    if (m && m.index != null && m.index < cutAt) {
      cutAt = m.index;
    }
  }
  return desc.slice(0, cutAt).trim();
}

/** Browser-shaped headers for the feed fetch. Some publishers (FreightWaves
 *  via Cloudflare) intermittently 403 plain `User-Agent`-only requests
 *  from Vercel's IP ranges; the full set matches what our HTML scraper
 *  uses and clears those gates most of the time. */
function feedHeaders(): Record<string, string> {
  return {
    'User-Agent': randomUserAgent(),
    Accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    // No Sec-Fetch-* / Upgrade-Insecure-Requests here: declaring
    // `Sec-Fetch-Dest: document` on an XML /feed/ endpoint makes some
    // Cloudflare WAFs return 415 (declared HTML doc vs actual RSS/XML) —
    // this 415'd Maritime Cyprus & Splash247. Non-browser clients shouldn't
    // send Sec-Fetch-* anyway; omitting them is the correct request shape.
  };
}

/** Fetch the RSS XML ourselves so we can:
 *    (a) send richer headers than rss-parser's default,
 *    (b) retry once with a fresh User-Agent + small delay if the first
 *        attempt hits a 403/429 (Cloudflare bot challenge from a
 *        flagged Vercel IP). */
// Append a unique query param so a CDN can't hand us a STALE cached feed. Splash247's
// origin sends `Cache-Control: s-maxage=2592000` (30 days for shared caches), and the
// scraper — on a datacenter IP — was served the same ~10 items for ~24h, missing
// everything published between: our newest lagged the LIVE feed by ~18h while fetchRss
// from a clean IP returned the fresh items (MEASURED 2026-07-16). A fresh cache key per
// request forces the origin copy; the no-cache request headers reinforce it. Harmless
// for feeds that aren't cached (WordPress ignores the unknown param).
function bustCache(url: string): string {
  return url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
}

async function fetchFeedXml(feedUrl: string): Promise<string> {
  // Cache-busting is done by the unique ?_=<ts> query param ALONE (a fresh cache key →
  // the CDN can't serve a stale copy). NO `Cache-Control: no-cache` request header:
  // that made some origins bypass their cache toward a slow/broken backend and HANG or
  // 502 (MEASURED 2026-07-16: offshore-energy.biz/feed/ served 200 with the param but
  // timed out / 502'd once the no-cache header was added). The param is the safe fix.
  const ctrl1 = new AbortController();
  const t1 = setTimeout(() => ctrl1.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(bustCache(feedUrl), { headers: feedHeaders(), redirect: 'follow', signal: ctrl1.signal });
  } finally { clearTimeout(t1); }
  // Retry once on a Cloudflare bot challenge (403/429), the Sec-Fetch 415, or a
  // transient gateway error (502/503/504) — a fresh UA + fresh cache key usually clears it.
  if ([403, 415, 429, 502, 503, 504].includes(res.status)) {
    // Drain body so the connection can be reused.
    try { await res.text(); } catch { /* */ }
    // Wait 15-30 s, then try once more with a fresh UA + fresh cache key.
    await sleep(15_000 + Math.floor(Math.random() * 15_000));
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 25_000);
    try {
      res = await fetch(bustCache(feedUrl), { headers: feedHeaders(), redirect: 'follow', signal: ctrl2.signal });
    } finally { clearTimeout(t2); }
  }
  if (!res.ok) throw new Error(`Status code ${res.status}`);
  return await res.text();
}

export type RawArticle = {
  title: string;
  url: string;
  author: string | null;
  published_at: string | null;
  excerpt: string;
  image_url: string | null;
  /** Provenance of published_at. NULL means the scraper didn't track it
   *  (older code paths) — orchestrator will treat this as 'unknown'. */
  published_at_source?: 'original' | 'scraper_default' | null;
  /** Trust level for published_at. NULL means not assessed; consumers
   *  treat NULL as 'low' confidence (show "Approximate date" badge). */
  published_at_confidence?: 'high' | 'medium' | 'low' | null;
};

const OG_IMAGE_TIMEOUT_MS = 8000;
const OG_IMAGE_CONCURRENCY = 4;
const OG_IMAGE_BYTE_CAP = 80_000; // most og:image meta sits in the first 30-50 KB

/** Fetch the article page and pull `<meta property="og:image">` out of the
 *  first chunk of bytes. Designed for RSS items whose feed didn't include
 *  any thumbnail. Quick-and-dirty: aborts after OG_IMAGE_BYTE_CAP, doesn't
 *  build a DOM. Returns null on any failure. */
async function fetchOgImage(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OG_IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': randomUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok || !res.body) return null;
    let buf = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (buf.length < OG_IMAGE_BYTE_CAP) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        ?? buf.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
        ?? buf.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
      if (m) {
        try { reader.cancel(); } catch { /* */ }
        return new URL(m[1], url).toString();
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Run the og:image enhancer on items missing image_url, with a small
 *  concurrency cap so we don't hammer the publisher. In-place mutation. */
async function enhanceMissingImages(items: RawArticle[]): Promise<void> {
  const targets = items.filter((it) => !it.image_url);
  if (targets.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(OG_IMAGE_CONCURRENCY, targets.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const it = targets[idx];
      const img = await fetchOgImage(it.url);
      if (img) it.image_url = img;
    }
  });
  await Promise.all(workers);
}

const parser = new Parser({
  timeout: 20_000,
  headers: { 'User-Agent': randomUserAgent() },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      // YouTube channel RSS nests description/thumbnail INSIDE
      // <media:group> rather than at the item level, so we pull the
      // whole group and dig into it below.
      ['media:group', 'mediaGroup'],
      ['enclosure', 'enclosure'],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

export type FetchRssOptions = {
  /** Skip the og:image fallback for items missing a feed-level image.
   *  Each missing image triggers an extra HTTP fetch of the article
   *  page; for a 50-item feed that's 50 extra requests, which gets
   *  Vercel's IP pool flagged by Cloudflare-protected publishers
   *  (FreightWaves). Opt-in per source via `scraper_config.skip_og_image`. */
  skipOgImage?: boolean;
};

export async function fetchRss(feedUrl: string, opts: FetchRssOptions = {}): Promise<RawArticle[]> {
  // Fetch the XML ourselves (richer headers + retry on Cloudflare 403)
  // and hand the string to rss-parser for the heavy lifting.
  const xml = await fetchFeedXml(feedUrl);
  const feed = await parser.parseString(xml);

  const articles = (feed.items ?? [])
    .filter((it) => it.link && it.title)
    .map((it) => {
      const html = (it.contentEncoded as string) ?? it.content ?? it.summary ?? '';
      // YouTube channel feeds put the video description inside
      // <media:group><media:description>; pull it as a fallback when
      // the standard content/summary fields come back empty.
      const group = it.mediaGroup as { 'media:description'?: string[]; 'media:thumbnail'?: Array<{ $?: { url?: string } }> } | undefined;
      const ytDesc = group?.['media:description']?.[0] ?? '';
      let excerpt = stripHtml(html || ytDesc).slice(0, 2000);
      // For YouTube items, strip the promo/social/related-links tail
      // so it doesn't leak into search (e.g. a tanker-strike video
      // shouldn't surface for "grain cargo" just because its description
      // footer cites an unrelated grain-cargo article).
      const isYouTubeLink = it.link?.includes('youtube.com/watch') ?? false;
      if (isYouTubeLink) {
        excerpt = trimYouTubeDescription(excerpt);
      }
      // Last-resort fallback: YouTube Shorts ship with empty
      // descriptions, so the only content we have is the title.
      // Repeat it once so the quality gate's 30-char excerpt floor
      // doesn't drop the row — losing a Short is worse than having
      // a slightly redundant excerpt.
      if (excerpt.length < 30 && it.title) {
        excerpt = it.title.trim();
      }

      let image: string | null = null;
      const mc = (it.mediaContent as { $?: { url?: string } } | undefined)?.$?.url;
      const mt = (it.mediaThumbnail as { $?: { url?: string } } | undefined)?.$?.url;
      const enc = (it.enclosure as { url?: string; type?: string } | undefined);
      if (mc) image = mc;
      else if (mt) image = mt;
      else if (enc?.url && enc.type?.startsWith('image/')) image = enc.url;
      else {
        const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (m) image = m[1];
      }

      // RSS pubDate is a structured feed field with explicit semantics, so
      // treat it as original/high when present. Null = the feed item had no
      // date at all; orchestrator falls back to scrape-time downstream.
      const pubDate = it.isoDate ?? it.pubDate ?? null;
      return {
        title: it.title!.trim(),
        url: it.link!.trim(),
        author: it.creator ?? (it as { author?: string }).author ?? null,
        published_at: pubDate,
        published_at_source: pubDate ? 'original' : null,
        published_at_confidence: pubDate ? 'high' : null,
        excerpt,
        image_url: image,
      } satisfies RawArticle;
    });

  // Most maritime news RSS feeds (gCaptain, Maritime Executive, Loadstar,
  // Hellenic) ship items without any thumbnail. Fall back to og:image on
  // the article page for everything still missing an image — UNLESS
  // the source has opted out (Cloudflare-protected publishers where the
  // extra requests get our Vercel IPs flagged).
  if (!opts.skipOgImage) {
    await enhanceMissingImages(articles);
  }
  return articles;
}
