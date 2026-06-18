// Dry-run validator core (extracted from cli/verify.ts so apply.ts can
// run it internally without subprocess). The rule set is the single
// source of truth for what "safe to write" means. CLI wrapper at
// cli/verify.ts; apply.ts re-runs this before every --confirm write
// (D1 belt-and-suspenders).

import type { DryRunReport, ScrapeOutcome } from '@/lib/repository/types';

export type Issue = {
  rule: string;
  outcomeIndex: number;
  url: string;
  detail: string;
};

const HEX32 = /^[0-9a-f]{32}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Calendar components from a raw date string, WITHOUT going through
// new Date()/toISOString() — that's the bug class we're guarding against.
export function extractRawDateComponents(
  raw: string,
): { year: number; month: number; day: number } | null {
  // RFC822/RFC2822 "Fri, 29 May 2026 10:00:00 +0000" — Day Month Year
  const m = raw.match(
    /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/,
  );
  if (m) return { day: parseInt(m[1], 10), month: MONTHS.indexOf(m[2]) + 1, year: parseInt(m[3], 10) };
  // "May 29, 2026" — Month Day, Year
  const m2 = raw.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/,
  );
  if (m2) return { month: MONTHS.indexOf(m2[1]) + 1, day: parseInt(m2[2], 10), year: parseInt(m2[3], 10) };
  // ISO already: "2026-05-29..."
  const m3 = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m3) return { year: parseInt(m3[1], 10), month: parseInt(m3[2], 10), day: parseInt(m3[3], 10) };
  return null;
}

export function extractIsoComponents(
  iso: string,
): { year: number; month: number; day: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10), day: parseInt(m[3], 10) };
}

// R11: ISO-with-TZ rollforward/rollback detector. For raw labels of the
// shape "YYYY-MM-DDThh:mm[:ss][.sss](Z|±hh:mm|±hhmm)", compute the UTC
// calendar day from the canonical instant and compare to the parsed
// published_at. If they disagree, the cascade derived its date from
// LOCAL components when it should have used UTC — the Hellenic
// 2026-05-24T22:50:02+00:00 → 2026-05-25 symptom in Istanbul (+3).
//
// Returns the UTC date {year,month,day} if `raw` is recognised as a
// fully-qualified ISO datetime with explicit TZ, else null (rule
// silently passes for inputs it doesn't claim authority over).
export function extractUtcDateFromIsoWithTz(
  raw: string,
): { year: number; month: number; day: number } | null {
  // Must look like ISO datetime with explicit TZ marker
  if (!/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw.trim())) {
    return null;
  }
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// R14 — category/landing tokens. If the LAST non-empty path segment of
// an article URL is one of these, the URL is a listing page (or worse,
// a category landing), not an article. Cascade may still produce a
// plausible date+title from a jsonld block on the page (a stale feature
// article gets re-pinned to the landing nav), but it does not belong in
// the articles table. v1's Offshore Energy `/news/` is the canonical
// case; the registry's url_pattern is the primary defence, this is the
// validator backstop in case a regex change misses it.
const LANDING_TOKENS = new Set<string>([
  'news', 'category', 'categories', 'tag', 'tags', 'author', 'authors',
  'page', 'pages', 'topic', 'topics', 'section', 'sections',
  'articles', 'posts', 'magazine', 'magazines', 'archive', 'archives',
  'feed', 'rss', 'index', 'all', 'home', 'video', 'videos',
]);

function lastPathSegment(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const segs = u.pathname.split('/').filter((s) => s.length > 0);
    if (segs.length === 0) return null;
    return segs[segs.length - 1].toLowerCase();
  } catch {
    return null;
  }
}

export function validateDryRun(report: DryRunReport, scrapeTime: Date): Issue[] {
  const issues: Issue[] = [];
  const tomorrow = new Date(scrapeTime.getTime() + 24 * 3600_000);
  const seenHashes = new Map<string, number>();

  report.outcomes.forEach((o: ScrapeOutcome, i: number) => {
    // R11 / R12 — audit-side date correctness rules. Must run on EVERY
    // outcome (insert, duplicate, rejected), not only writes — we want
    // to know when the cascade derived a wrong date even for rows we
    // won't write, because the same code path will mishandle a future
    // non-duplicate row identically. parsed_published_at lives on the
    // outcome regardless of write decision.

    // Hoisted (was R10-local): does the CHOSEN signal (date_signals[0],
    // the cascade winner) come from DISCOVERY? raw_date_label always
    // reflects the discovery signal (rss_pubdate for RSS, sitemap_lastmod
    // for sitemap; null for html_listing). So raw_date_label only
    // corresponds to the parsed date when the discovery signal actually
    // WON the cascade. Both R10 and R11 must guard on this, else they
    // false-positive when a detail-fetch signal (jsonld/meta/<time>)
    // legitimately outranks the discovery signal and gives a different day.
    const chosenIsDiscoverySignal =
      o.date_signals.length > 0 &&
      (o.date_signals[0] === 'rss_pubdate' || o.date_signals[0] === 'sitemap_lastmod');

    // R11: ISO-with-TZ rollforward/rollback. If raw_date_label is ISO
    // with explicit TZ, the parsed date must equal the canonical UTC day.
    // GUARDED by chosenIsDiscoverySignal: a sitemap <lastmod> (the raw
    // label) is the MODIFICATION date; when jsonld_datePublished (the real
    // publish date) outranks it the two legitimately differ — that is
    // correct disagreement, not a TZ roll. gCaptain 2011 archive surfaced
    // this (lastmod 2011-03-30 vs jsonld publish 2011-02-25). The bug R11
    // actually targets (Hellenic 22:50+00:00 → wrong local day) has the
    // discovery signal WINNING, so it stays caught.
    if (o.raw_date_label && o.parsed_published_at && chosenIsDiscoverySignal) {
      const utcRaw = extractUtcDateFromIsoWithTz(o.raw_date_label);
      const iso = extractIsoComponents(o.parsed_published_at);
      if (utcRaw && iso) {
        if (utcRaw.year !== iso.year || utcRaw.month !== iso.month || utcRaw.day !== iso.day) {
          issues.push({
            rule: 'R11',
            outcomeIndex: i,
            url: o.detected_url,
            detail: `TZ ROLL: raw "${o.raw_date_label}" (UTC day ${utcRaw.year}-${String(utcRaw.month).padStart(2, '0')}-${String(utcRaw.day).padStart(2, '0')}) → parsed "${o.parsed_published_at}". Cascade used local components on an ISO-with-TZ input.`,
          });
        }
      }
    }

    // R12: sitemap_lastmod cannot be the sole basis for medium/high
    // confidence. lastmod is "last modified", not "first published".
    // Per D18, single-signal sitemap_lastmod must cap at 'low'.
    if (
      o.proposed_record &&
      o.date_signals.length === 1 &&
      o.date_signals[0] === 'sitemap_lastmod' &&
      (o.proposed_record.published_at_confidence === 'medium' ||
        o.proposed_record.published_at_confidence === 'high')
    ) {
      issues.push({
        rule: 'R12',
        outcomeIndex: i,
        url: o.detected_url,
        detail: `D18: sitemap_lastmod-only outcome has confidence "${o.proposed_record.published_at_confidence}" — must be "low" (lastmod is corroborator, not primary publish signal).`,
      });
    }

    const isInsert = o.scraper_decision === 'would_insert';
    if (isInsert && !o.proposed_record) {
      issues.push({ rule: 'R1', outcomeIndex: i, url: o.detected_url, detail: 'would_insert but proposed_record null' });
    }
    if (!isInsert) return;
    const p = o.proposed_record!;
    if (!p.title || p.title.trim().length === 0) {
      issues.push({ rule: 'R2', outcomeIndex: i, url: o.detected_url, detail: 'title empty' });
    }
    try {
      new URL(p.url);
    } catch {
      issues.push({ rule: 'R3', outcomeIndex: i, url: o.detected_url, detail: `url unparseable: ${p.url}` });
    }
    if (!p.source_id || p.source_id.length < 30) {
      issues.push({ rule: 'R4', outcomeIndex: i, url: o.detected_url, detail: `source_id missing/short: "${p.source_id}"` });
    }
    if (!HEX32.test(p.url_hash)) {
      issues.push({ rule: 'R5', outcomeIndex: i, url: o.detected_url, detail: `url_hash not 32-hex: "${p.url_hash}"` });
    }
    if (!p.published_at || !/^\d{4}-\d{2}-\d{2}/.test(p.published_at)) {
      issues.push({ rule: 'R6', outcomeIndex: i, url: o.detected_url, detail: `published_at missing/malformed: "${p.published_at}"` });
    }
    if (p.published_at) {
      const d = new Date(p.published_at);
      if (!isNaN(d.getTime()) && d > tomorrow) {
        issues.push({ rule: 'R7', outcomeIndex: i, url: o.detected_url, detail: `published_at in future: ${p.published_at}` });
      }
    }
    if (p.url_hash) {
      const prev = seenHashes.get(p.url_hash);
      if (prev !== undefined) {
        issues.push({ rule: 'R8', outcomeIndex: i, url: o.detected_url, detail: `duplicate url_hash within dry-run (first seen at outcome #${prev})` });
      } else {
        seenHashes.set(p.url_hash, i);
      }
    }
    // R9 was checking proposed_record.published_at_source directly, but
    // after the 2026-05-30 db-canonical mapping the granular 'rss_pubdate'
    // value collapses to 'original' in proposed_record. The granular
    // signal still lives in ScrapeOutcome.date_signals[] (audit-side),
    // which is where R9 must look now.
    if (o.date_signals.includes('rss_pubdate') && !o.raw_date_label) {
      issues.push({ rule: 'R9', outcomeIndex: i, url: o.detected_url, detail: 'rss_pubdate signal but raw_date_label null' });
    }

    // R14: defence-in-depth backstop for landing/category pages slipping
    // through url_pattern. Articles end with a slug (`some-headline-123`),
    // not a generic category token. Triggers only on would_insert (we
    // care about what's about to be written, not duplicates) and only
    // when the LAST non-empty segment is in the landing-token list.
    {
      const last = lastPathSegment(p.url);
      if (last && LANDING_TOKENS.has(last)) {
        issues.push({
          rule: 'R14',
          outcomeIndex: i,
          url: o.detected_url,
          detail: `LANDING URL: last path segment "${last}" is a category/listing token, not an article slug. Tighten url_pattern (registry-level) or the discovery filter.`,
        });
      }
    }

    // R15: thin-content sentinel. If raw_excerpt is consistently the
    // length of an SEO meta-description (~100-300 chars), detail-fetch
    // most likely fell to the meta-description fallback rather than
    // extracting the real article body. Per user-stated standard
    // (2026-05-30): "every source must extract real article body; if it
    // falls to meta-description we treat that source as not ready and
    // block apply." Threshold of 400 chars chosen because: meta-desc
    // tops out around 280 chars universally (Twitter/og:description
    // norms), so 400 catches the fallback without false-positiving the
    // rare genuinely-short real article. BIMCO/MarineLink reference
    // with the 2000-char cap should hit 500-2000 chars on a real body.
    // R13's sibling: R13 catches "different rows share same body"
    // (was-bug), R15 catches "row body is thin even if unique"
    // (is-bug). Sentinel for the same family of failures.
    const bodyLen = p.raw_excerpt ? p.raw_excerpt.length : 0;
    if (bodyLen < 400) {
      issues.push({
        rule: 'R15',
        outcomeIndex: i,
        url: o.detected_url,
        detail: `THIN BODY: raw_excerpt only ${bodyLen} chars (threshold 400). Likely meta-description fallback fired — real article body was not extracted. Per the "every source must produce a full body" standard, this row is not safe to apply. Investigate the page DOM for the real article container, add a source-specific selector if needed.`,
      });
    }
    // R10: off-by-one detector — only meaningful when the chosen
    // signal CORRESPONDS to raw_date_label. raw_date_label is always
    // set by discovery (rss_pubdate for RSS, sitemap_lastmod for
    // sitemap, null for html_listing). If the cascade chose a
    // higher-priority signal from detail-fetch (jsonld/meta/time),
    // the parsed date legitimately differs from the discovery's raw —
    // not a bug, two different signals correctly disagreeing.
    // The chosen signal is `date_signals[0]` (cascade puts it first).
    //
    // Also: ISO-with-TZ inputs are owned by R11 (UTC-day check). R10
    // skips them silently rather than complaining about regex coverage.
    // chosenIsDiscoverySignal is hoisted to the top of the forEach (shared
    // with R11). rawIsIsoWithTz stays local — only R10 uses it.
    const rawIsIsoWithTz = !!(
      o.raw_date_label &&
      /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(o.raw_date_label.trim())
    );
    if (
      o.raw_date_label &&
      p.published_at &&
      chosenIsDiscoverySignal &&
      !rawIsIsoWithTz
    ) {
      const raw = extractRawDateComponents(o.raw_date_label);
      const iso = extractIsoComponents(p.published_at);
      if (raw && iso) {
        if (raw.year !== iso.year || raw.month !== iso.month || raw.day !== iso.day) {
          issues.push({
            rule: 'R10',
            outcomeIndex: i,
            url: o.detected_url,
            detail: `OFF-BY-ONE: raw "${o.raw_date_label}" (y${raw.year}-m${raw.month}-d${raw.day}) → parsed "${p.published_at}" (y${iso.year}-m${iso.month}-d${iso.day}). TZ rollback or wrong parser.`,
          });
        }
      }
      // No `else if (!raw)` issue — unrecognised formats are silently
      // skipped. R11 owns ISO-with-TZ; anything else falling through is
      // outside R10's authority.
    }
  });

  // R13 — repeated-excerpt body bug. Cross-outcome pass: if ≥2 distinct
  // URLs in this dry-run carry the SAME first-250-char raw_excerpt prefix,
  // detail-fetch is picking a site-wide boilerplate (sticky promo, weekly
  // briefing box, intro tease) instead of the article body. JoC's
  // 10/10 identical excerpt in the 2026-05-30 dry-run is the canonical
  // case. Sibling of R10/R11 (date-side detectors): catch the bug here
  // so a future regression in another source is flagged automatically.
  //
  // Threshold: 250 chars. Shorter would false-positive on common
  // boilerplate lead-ins ("In a statement..."); longer would miss the
  // case where only the opening boilerplate matches and the tail
  // diverges.
  const PREFIX_LEN = 250;
  const prefixGroups = new Map<string, Array<{ index: number; url: string }>>();
  report.outcomes.forEach((o, i) => {
    if (o.scraper_decision !== 'would_insert') return;
    const ex = o.proposed_record?.raw_excerpt;
    if (!ex || ex.length < PREFIX_LEN) return;
    const key = ex.slice(0, PREFIX_LEN);
    const arr = prefixGroups.get(key);
    if (arr) arr.push({ index: i, url: o.detected_url });
    else prefixGroups.set(key, [{ index: i, url: o.detected_url }]);
  });
  for (const [key, members] of prefixGroups) {
    if (members.length < 2) continue;
    const sample = key.slice(0, 80).replace(/\s+/g, ' ').trim();
    for (const m of members) {
      issues.push({
        rule: 'R13',
        outcomeIndex: m.index,
        url: m.url,
        detail: `REPEATED EXCERPT: ${members.length} would_insert outcomes share the same first ${PREFIX_LEN}-char body prefix. Detail-fetch is likely picking a site-wide boilerplate (promo/tease/sticky briefing) instead of the article. Sample: "${sample}..."`,
      });
    }
  }

  return issues;
}

export const ALL_RULES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15'] as const;
