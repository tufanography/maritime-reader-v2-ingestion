// Phase 2.1 minimal body extraction.
//
// For RSS sources: use the feed-provided contentSnippet / contentEncoded.
// We do NOT fetch the detail page for body in 2.1 — that lands at 2.5
// with @mozilla/readability + jsdom. This is a deliberate POC trade-off:
// raw_excerpt from RSS snippets is short (~120 chars) but PROVES the
// pipeline end-to-end without dragging in DOM parsing now.
//
// For sources without an RSS body, this returns null and the orchestrator
// flags the outcome as needing detail-fetch (post-2.1 work).

// Very basic HTML → text. Good enough to strip RSS content:encoded
// markup into plain text for storage. Full Readability-grade extraction
// is Phase 2.5.
export function htmlToText(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

// Build raw_excerpt from whatever the discovery step captured.
// Preference: contentEncoded (longest) > contentSnippet (RSS feed snippet)
//             > null (orchestrator will flag pending-detail-fetch).
export function buildExcerpt(args: {
  fullBodyHtml: string | null;
  rssExcerpt: string | null;
}): string | null {
  const full = htmlToText(args.fullBodyHtml);
  if (full && full.length > 200) return full;
  if (args.rssExcerpt && args.rssExcerpt.trim().length > 0) return args.rssExcerpt.trim();
  return full ?? null;
}
