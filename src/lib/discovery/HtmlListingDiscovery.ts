import * as cheerio from 'cheerio';
import type { DiscoveryStrategy } from './DiscoveryStrategy';
import type { DiscoveryConfig, DiscoveredItem } from './types';

// HTML listing discovery. Third discovery type after RSS and sitemap.
// Mirrors v1's press-release / html_listing scraper pattern:
//   1. fetch a listing page (e.g. https://american-club.com/page/circulars)
//   2. run a cheerio selector to find <a> elements (e.g. a[href$=".pdf"])
//   3. yield each as a DiscoveredItem with URL resolved absolute
//
// Unlike RSS, HTML listings give us only URL + anchor text — no
// authoritative date, no body, no image. Detail-fetch must fill the
// rest. (For PDF URLs that's the mode #1 PDF handler from 2026-05-30.)
//
// Optional urlPattern filter is applied AFTER selector match, identical
// to SitemapDiscovery's behaviour: lets a single config say "find PDFs
// matching this URL shape" without re-doing the selector.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function fetchListingPage(url: string, timeoutMs = 20_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export class HtmlListingDiscovery implements DiscoveryStrategy {
  readonly name = 'html_listing' as const;

  async *discover(config: DiscoveryConfig): AsyncGenerator<DiscoveredItem, void, void> {
    if (!config.listUrl) throw new Error('HtmlListingDiscovery: listUrl required');
    const selector = config.itemSelector ?? 'a[href]';
    const html = await fetchListingPage(config.listUrl);
    const $ = cheerio.load(html);
    const re = config.urlPattern ? new RegExp(config.urlPattern) : null;

    // Deduplicate within the listing page (some sites repeat the same
    // link in nav + body + sidebar). Order-preserving so the visual
    // top-of-page items still come first.
    const seen = new Set<string>();
    const items: { url: string; title: string | null }[] = [];

    $(selector).each((_, el) => {
      if (items.length >= config.maxItems) return false; // break
      const href = $(el).attr('href');
      if (!href) return;
      let resolved: string;
      try {
        resolved = new URL(href, config.listUrl).toString();
      } catch {
        return; // malformed href, skip
      }
      if (re && !re.test(resolved)) return;
      if (seen.has(resolved)) return;
      seen.add(resolved);
      const anchorText = $(el).text().replace(/\s+/g, ' ').trim();
      items.push({
        url: resolved,
        title: anchorText.length > 0 ? anchorText : null,
      });
    });

    for (const it of items) {
      yield {
        url: it.url,
        title: it.title,                  // anchor text — may be PDF filename
        excerpt: null,                    // detail-fetch must fill
        imageUrl: null,                   // detail-fetch may fill
        rawDateLabel: null,               // no date at this layer
        rssPubDate: null,
        sitemapLastmod: null,
        fullBodyHtml: null,
        discoveredVia: 'html_listing',
      };
    }
  }
}
