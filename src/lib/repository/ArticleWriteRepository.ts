import type { ScrapedArticle } from './types';

// Clean-architecture port for the WRITE side. Ingestion code depends on
// THIS, never on Supabase directly. The day we swap Supabase for
// SQLite-via-R2 (HANDOFF §7 alternative), only a new implementation file
// is written — no scraper, no orchestrator, no CLI changes.
//
// Methods are intentionally minimal. Add only when a CLI/orchestrator
// actually needs the call; YAGNI applies to the port too.
export interface ArticleWriteRepository {
  /** Returns the source's UUID, or null if no source with that name. */
  resolveSourceId(name: string): Promise<string | null>;

  /** url_hash → boolean — already in DB? Used for dedup before fetch. */
  knownUrlHashes(hashes: string[]): Promise<Set<string>>;

  /** Insert a single article. Throws on DB error so callers can audit. */
  insertOne(article: ScrapedArticle): Promise<void>;

  /** Bulk insert. Implementations should chunk internally per D11. */
  insertMany(articles: ScrapedArticle[]): Promise<{ inserted: number; failed: number }>;
}
