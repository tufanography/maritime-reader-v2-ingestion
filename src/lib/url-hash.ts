import { createHash } from 'node:crypto';

// Canonicalize URL and produce a 32-char sha256 hex digest.
// MUST match v1's hashUrl in lib/scrapers/util.ts so v1-and-v2 ingestion
// share the same dedup space against the live articles table:
//   - strip UTM / fbclid / gclid query params
//   - drop fragment
//   - strip trailing slash
//   - sha256, hex, first 32 chars
//
// If we ever change the canonicalization, every existing url_hash in the
// DB becomes stale; treat this function as DB-shape, not application code.
export function hashUrl(url: string): string {
  let cleaned = url.trim();
  try {
    const u = new URL(url);
    for (const k of [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
    ]) {
      u.searchParams.delete(k);
    }
    u.hash = '';
    cleaned = u.toString().replace(/\/$/, '');
  } catch {
    // leave as raw if URL parsing fails — at least the hash is stable
  }
  return createHash('sha256').update(cleaned).digest('hex').slice(0, 32);
}
