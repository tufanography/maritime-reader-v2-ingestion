// Derive a V3 document_type for an article. Used by both the backfill script
// and the live scraper. The same function MUST produce the same value given
// the same inputs — we rely on this for idempotent re-runs.
//
// Resolution order (first match wins):
//   1. Port State Control source        → psc_report
//   2. P&I source                       → pi_circular
//   3. Classification source             → class_notice
//   4. Article category 'accidents'      → casualty_report
//   5. Article category 'regulations'    → regulation
//   6. Market-style title patterns       → market_report
//   7. Default                           → news

export type DocumentType =
  | 'news'
  | 'press_release'
  | 'pi_circular'
  | 'class_notice'
  | 'regulation'
  | 'market_report'
  | 'casualty_report'
  | 'psc_report';

const MARKET_REPORT_PATTERNS: RegExp[] = [
  /\bbaltic\s+(dry|capesize|panamax|supramax|handysize|clean|dirty)\s+index\b/i,
  /\b(BDI|BCI|BPI|BSI|BHSI)\b/,
  /\bfreight\s+rate(s)?\b/i,
  /\b(quarterly|q[1-4])\s+(results|earnings|outlook)\b/i,
  /\bmarket\s+(report|outlook|forecast|update|review|wrap)\b/i,
  /\bweekly\s+(report|outlook|forecast)\b/i,
  /\b(VLCC|Suezmax|Aframax|MR|LR1|LR2)\s+(rates|earnings|spot)\b/i,
  /\bcontainer\s+rates\b/i,
  /\bspot\s+rates\b/i,
  /\bcharter\s+rates\b/i,
  /\bvessel\s+earnings\b/i,
  /\bship\s+demolition\s+(prices|market)\b/i,
];

function looksLikeMarketReport(title: string, excerpt: string): boolean {
  const text = `${title}\n${excerpt.slice(0, 600)}`;
  return MARKET_REPORT_PATTERNS.some((p) => p.test(text));
}

export function deriveDocumentType(args: {
  /** Source's category_hint; null for generic news outlets. */
  sourceCategoryHint: string | null;
  /** Source name (lowercase doesn't matter — we compare uppercase substrings). */
  sourceName: string | null;
  /** Article category slug (resolved or 'general'). */
  categorySlug: string | null;
  title: string;
  excerpt: string;
}): DocumentType {
  const { sourceCategoryHint, sourceName, categorySlug, title, excerpt } = args;

  // 1. Port State Control MOUs and PSC-specific feeds
  if (sourceCategoryHint === 'port-state-control') return 'psc_report';

  // 2. P&I clubs
  if (sourceCategoryHint === 'pi-insurance') return 'pi_circular';

  // 3. Classification societies (excluding their PSC-specific feeds, which
  //    are caught by step 1 via category_hint='port-state-control').
  if (sourceCategoryHint === 'classification') return 'class_notice';

  // Some news outlets are press-release heavy (Hellenic re-publishes club press releases,
  // GAC's "HOT PORT NEWS"). We still treat these as news for V3 unless the article
  // category clearly signals something different.

  // 3. Casualty / accident
  if (categorySlug === 'accidents') return 'casualty_report';

  // 4. Regulation
  if (categorySlug === 'regulations') return 'regulation';

  // 5. Market report — keyword fingerprint
  if (looksLikeMarketReport(title, excerpt)) return 'market_report';

  // 6. Press release vs news — best-effort by source name
  if (sourceName && /press\s*release/i.test(sourceName)) return 'press_release';

  return 'news';
}

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  news: 'News',
  press_release: 'Press',
  pi_circular: 'P&I Circular',
  class_notice: 'Class Notice',
  regulation: 'Regulation',
  market_report: 'Market Report',
  casualty_report: 'Casualty',
  psc_report: 'PSC Report',
};

// V3 spec section 11 — must stay in sync with TailwindCSS design tokens.
export const DOCUMENT_TYPE_PALETTE: Record<DocumentType, { bg: string; text: string; active: string }> = {
  news:            { bg: 'bg-slate-100',   text: 'text-slate-700',   active: 'bg-slate-700' },
  press_release:   { bg: 'bg-slate-100',   text: 'text-slate-700',   active: 'bg-slate-700' },
  pi_circular:     { bg: 'bg-blue-100',    text: 'text-blue-800',    active: 'bg-blue-600' },
  class_notice:    { bg: 'bg-emerald-100', text: 'text-emerald-800', active: 'bg-emerald-600' },
  regulation:      { bg: 'bg-red-100',     text: 'text-red-800',     active: 'bg-red-600' },
  market_report:   { bg: 'bg-amber-100',   text: 'text-amber-800',   active: 'bg-amber-600' },
  casualty_report: { bg: 'bg-rose-100',    text: 'text-rose-800',    active: 'bg-rose-600' },
  psc_report:      { bg: 'bg-indigo-100',  text: 'text-indigo-800',  active: 'bg-indigo-600' },
};
