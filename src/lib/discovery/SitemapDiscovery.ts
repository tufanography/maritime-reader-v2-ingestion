import type { DiscoveryStrategy } from './DiscoveryStrategy';
import type { DiscoveryConfig, DiscoveredItem } from './types';

// Sitemap implementation. Mirrors v1's lib/scrapers/html.ts
// fetchSitemapUrls() — including the "walk into the freshest child"
// recursion for sitemap-index trees and the url_pattern filter.
//
// Unlike RSS, sitemap entries provide ONLY url + lastmod. Title, body,
// publish date, image must come from detail-fetch in the orchestrator.
// (RSS often gives all four; sitemap is metadata-only.)

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function fetchOne(url: string, timeoutMs = 20_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

type Entry = { url: string; lastmod: number; lastmodStr: string | null };

async function fetchSitemapEntries(
  sitemapUrl: string,
  urlPattern: string | undefined,
  depth = 0,
): Promise<Entry[]> {
  if (depth > 3) return [];
  const xml = await fetchOne(sitemapUrl);

  // sitemap-index: walk into the freshest child by lastmod.
  if (/<sitemapindex\b/i.test(xml)) {
    const blocks = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)].map((m) => m[1]);
    let best: { url: string; lastmod: number } | null = null;
    for (const b of blocks) {
      const loc = b.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
      if (!loc) continue;
      const lastmodStr = b.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim();
      const lastmod = lastmodStr ? Date.parse(lastmodStr) || 0 : 0;
      if (!best || lastmod > best.lastmod) best = { url: loc, lastmod };
    }
    if (!best) return [];
    return fetchSitemapEntries(best.url, urlPattern, depth + 1);
  }

  // Leaf urlset: <url><loc>...</loc><lastmod>...</lastmod></url>
  const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const re = urlPattern ? new RegExp(urlPattern) : null;
  const entries: Entry[] = [];
  for (const b of blocks) {
    const loc = b.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (!loc) continue;
    if (re && !re.test(loc)) continue;
    const lastmodStr = b.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() ?? null;
    const lastmod = lastmodStr ? Date.parse(lastmodStr) || 0 : 0;
    entries.push({ url: loc, lastmod, lastmodStr });
  }
  // Newest first — matches what cron-style incremental scrapers expect.
  entries.sort((a, b) => b.lastmod - a.lastmod);
  return entries;
}

export class SitemapDiscovery implements DiscoveryStrategy {
  readonly name = 'sitemap' as const;

  async *discover(config: DiscoveryConfig): AsyncGenerator<DiscoveredItem, void, void> {
    if (!config.sitemapUrl) throw new Error('SitemapDiscovery: sitemapUrl required');
    const all = await fetchSitemapEntries(config.sitemapUrl, config.urlPattern);
    const limit = Math.min(all.length, config.maxItems);
    for (let i = 0; i < limit; i++) {
      const e = all[i];
      yield {
        url: e.url,
        title: null,                           // detail-fetch must fill
        excerpt: null,                          // detail-fetch must fill
        imageUrl: null,                         // detail-fetch may fill
        rawDateLabel: e.lastmodStr,
        rssPubDate: null,
        sitemapLastmod: e.lastmod > 0 ? new Date(e.lastmod) : null,
        fullBodyHtml: null,
        discoveredVia: 'sitemap',
      };
    }
  }
}
