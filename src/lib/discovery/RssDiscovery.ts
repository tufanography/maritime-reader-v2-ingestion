import Parser from 'rss-parser';
import type { DiscoveryStrategy } from './DiscoveryStrategy';
import type { DiscoveryConfig, DiscoveredItem } from './types';

// RSS implementation. rss-parser handles RFC822 dates, namespace prefixes,
// and most malformed feeds gracefully. content:encoded (full body markup)
// is captured when the feed provides it; otherwise we fall back to
// contentSnippet (typically the first ~120 chars).
export class RssDiscovery implements DiscoveryStrategy {
  readonly name = 'rss' as const;

  async *discover(config: DiscoveryConfig): AsyncGenerator<DiscoveredItem, void, void> {
    if (!config.feedUrl) throw new Error('RssDiscovery: feedUrl required');
    const parser = new Parser({
      timeout: 20_000,
      customFields: { item: [['content:encoded', 'contentEncoded']] },
    });
    const feed = await parser.parseURL(config.feedUrl);
    const items = feed.items ?? [];
    const limit = Math.min(items.length, config.maxItems);
    for (let i = 0; i < limit; i++) {
      const e = items[i];
      if (!e.link) continue;
      const contentEncoded = (e as { contentEncoded?: string }).contentEncoded ?? null;
      // Prefer rss-parser's isoDate (already parsed); fall back to raw pubDate.
      const pub = e.isoDate ? new Date(e.isoDate) : e.pubDate ? new Date(e.pubDate) : null;
      yield {
        url: e.link,
        title: e.title ?? null,
        excerpt: e.contentSnippet ?? null,
        imageUrl: e.enclosure?.url ?? null,
        rawDateLabel: e.pubDate ?? null,
        rssPubDate: pub && !isNaN(pub.getTime()) ? pub : null,
        sitemapLastmod: null,
        fullBodyHtml: contentEncoded,
        discoveredVia: 'rss',
      };
    }
  }
}
