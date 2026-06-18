// Write-side article shape — what the scraper PRODUCES. Distinct from
// the site repo's read-side `Article` type because:
//   - field names mirror the DB schema (snake_case)
//   - includes scraper-only fields (url_hash, image_url provenance, etc.)
//   - does NOT include AI fields (segments, semantic_themes, content_quality);
//     those are filled by Phase 3 enrichment, not Phase 2 ingestion.
//
// Drift between this and the site's read shape would be caught when the
// site fails to render. Single source of truth is the DB schema itself.

// D8 (bug-fix locality): the discovery mode lives in one place
// (discovery/types.ts) and is imported here so adding a new mode (e.g.
// 'json_api') doesn't require a parallel edit on this file.
import type { DiscoveryMode } from '@/lib/discovery/types';

// Granular provenance used INTERNALLY by the date cascade + audit logs.
// Cross-signal agreement scoring uses the full granular set. Not written
// to DB directly — coerced to DbDateProvenance at write time.
export type DateProvenance =
  | 'jsonld_datePublished'
  | 'meta_article_published_time'
  | 'opengraph'
  | 'time_element_datetime'
  | 'time_element_text'
  | 'rss_pubdate'
  | 'sitemap_lastmod'
  | 'pdf_metadata_creation'
  | 'body_header_label'
  | 'url_slug_yyyy_mm'
  | 'wire_header_date'
  | 'unknown';

export type DateConfidence = 'high' | 'medium' | 'low' | 'none';

// What v1's `articles.published_at_source` CHECK constraint actually
// accepts (probed 2026-05-30 against live DB):
//   original        — source published this date in metadata/feed/body
//   body_repaired   — derived from body content via repair heuristic
//   ai_corrected    — AI gate proposed a correction that passed 4-clause
//   unknown         — no date found, scraper left field blank
//
// And confidence: 'high' | 'medium' | 'low' (no 'none' in DB — that's
// our internal "no date" sentinel; rows with confidence='none' must be
// rejected before write, not coerced).
export type DbDateProvenance = 'original' | 'body_repaired' | 'ai_corrected' | 'unknown';
export type DbDateConfidence = 'high' | 'medium' | 'low';

// Mirrors the 11 ingestion-relevant columns of v1's `articles` table.
// Verified against schema-probe output 2026-05-30 — all field names
// match DB columns exactly (no `is_pdf`; that column does not exist
// in v1 schema, was incorrectly added in initial Phase 2.0 scaffold
// and caught by D1 at first --confirm write).
export type ScrapedArticle = {
  source_id: string;          // resolved from source_name at write time
  title: string;
  url: string;
  url_hash: string;           // dedup key, sha256(canonicalized url) [32 hex]
  raw_excerpt: string | null;
  published_at: string | null; // ISO 8601 (date-only OR full datetime)
  published_at_source: DbDateProvenance;
  published_at_confidence: DbDateConfidence;
  image_url: string | null;
  is_broken: boolean;          // moderation flag; default false
};

// Single-row outcome of a scrape attempt. Used in dry-run JSON output
// for D1 (dry-run before mutation) and D7 (raw_label → parsed audit).
export type ScrapeOutcome = {
  source_name: string;
  discovered_via: DiscoveryMode;
  detected_url: string;
  http_status: number | null;
  scraper_decision: 'would_insert' | 'duplicate' | 'rejected' | 'fetch_failed';
  reject_reason: string | null;
  raw_date_label: string | null;         // D7: what we saw before parsing
  parsed_published_at: string | null;     // D7: what chrono-node produced
  date_signals: DateProvenance[];         // D2: which signals agreed
  body_length: number | null;
  proposed_record: ScrapedArticle | null; // null when not would_insert
  notes: string;
};

// Per-source-run summary for the dry-run audit JSON.
export type DryRunReport = {
  generated_at: string;
  source_name: string;
  discovered_count: number;
  would_insert: number;
  duplicate: number;
  rejected: number;
  fetch_failed: number;
  outcomes: ScrapeOutcome[];
};
