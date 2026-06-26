// Date fallback for genuinely dateless content (many P&I circulars / press
// releases expose no publish date at all, or only a month+year). Used ONLY
// when a source opts in (scraper_config.date_fallback === true) AND the normal
// date extraction (date.ts) found nothing — so we never override a real date.
//
// Rule (user-specified 2026-06-26):
//   • A month+year is found and it is a PAST month  → LAST DAY of that month.
//       (It wasn't there during that month and only surfaced later, so it must
//        not look freshly-published today; both "we scraped that month" and "we
//        didn't" collapse to the same answer: end of that month.)
//   • A month+year is found and it is the CURRENT month → capture date (today).
//   • No month+year at all → capture date (today).
//
// Every fallback date is marked dayKnown:false so the SITE can keep these out
// of the freshness-ordered feed (they'd otherwise pollute it) while still
// surfacing them in search / the archive. NEVER returns null → the article is
// always datable, so the date gate stops dropping real content.
//
// SITE-SIDE CONTRACT (Phase 2, maritime-reader-v2): inferred dates are written
// with published_at_source='scraper_default' (an allowed CHECK value; 'inferred'
// is rejected by the constraint). The feed query will therefore exclude
// `published_at_source = 'scraper_default'`. ⚠️ ACCEPTED SIDE EFFECT: 6 pre-existing
// rows already carry 'scraper_default' (genuine scraper-assigned dates, NOT
// these inferred ones) and will also drop out of the feed — deemed negligible
// (6 rows) and intentional. They remain searchable/archived like the inferred ones.

export interface FallbackDate {
  iso: string;
  dayKnown: false;
  basis: 'past_month_end' | 'current_month_capture' | 'no_date_capture';
}

const MONTH_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(20\d{2})\b/i;
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthIndex(token: string): number {
  return MONTH_KEYS.indexOf(token.slice(0, 3).toLowerCase());
}

/** Extract the FIRST "<month> <year>" in the text (full or abbreviated month). */
export function findMonthYear(text: string): { year: number; month: number } | null {
  const m = MONTH_RE.exec(text || '');
  if (!m) return null;
  const month = monthIndex(m[1]);
  if (month < 0) return null;
  return { year: parseInt(m[2], 10), month }; // month is 0-based
}

/** Resolve a fallback publish date per the rule above. `nowIso` is the capture time. */
export function resolveFallbackDate(text: string, nowIso: string): FallbackDate {
  const now = new Date(nowIso);
  const curY = now.getUTCFullYear();
  const curM = now.getUTCMonth(); // 0-based
  const my = findMonthYear(text);
  if (my) {
    const isPast = my.year < curY || (my.year === curY && my.month < curM);
    if (isPast) {
      const lastDay = new Date(Date.UTC(my.year, my.month + 1, 0)).getUTCDate();
      const iso = `${my.year}-${String(my.month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T12:00:00.000Z`;
      return { iso, dayKnown: false, basis: 'past_month_end' };
    }
    // current month (or, rarely, a future month) → treat as captured now
    return { iso: nowIso, dayKnown: false, basis: 'current_month_capture' };
  }
  return { iso: nowIso, dayKnown: false, basis: 'no_date_capture' };
}
