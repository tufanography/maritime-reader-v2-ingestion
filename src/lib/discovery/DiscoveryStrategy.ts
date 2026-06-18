import type { DiscoveryConfig, DiscoveredItem, DiscoveryMode } from './types';

// Pluggable port. Phase 2.1 ships one impl (RssDiscovery). Phase 2.5
// adds SitemapDiscovery, HtmlListingDiscovery, MultiJobDiscovery. Each
// is a single new file; orchestrator never changes.
//
// Yields items lazily so the orchestrator can apply `stopOnKnown` and
// `maxItems` without forcing the whole feed/sitemap to load first.
export interface DiscoveryStrategy {
  name: DiscoveryMode;
  discover(config: DiscoveryConfig): AsyncGenerator<DiscoveredItem, void, void>;
}
