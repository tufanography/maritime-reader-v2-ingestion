import * as chrono from 'chrono-node';
import type {
  DateConfidence,
  DateProvenance,
  DbDateConfidence,
  DbDateProvenance,
} from '@/lib/repository/types';

// Granular internal provenance → DB-allowed canonical bucket.
// All "source published this date" signals collapse to 'original';
// scraper-derived fallbacks collapse to 'body_repaired'; truly unknown
// stays 'unknown'. ai_corrected is reserved for the AI date-correction
// gate (Phase 3+), never produced by the cascade itself.
export function toDbProvenance(p: DateProvenance): DbDateProvenance {
  switch (p) {
    case 'jsonld_datePublished':
    case 'meta_article_published_time':
    case 'opengraph':
    case 'time_element_datetime':
    case 'time_element_text':
    case 'rss_pubdate':
    case 'sitemap_lastmod':
    case 'pdf_metadata_creation':
    case 'wire_header_date':
    case 'body_header_label':
      return 'original';
    case 'url_slug_yyyy_mm':
      return 'body_repaired';
    case 'unknown':
      return 'unknown';
  }
}

// 'none' is our internal "no date" sentinel and is NOT a DB-allowed
// value. Caller MUST reject rows whose cascade returned confidence='none'
// before reaching the write path. Returning null here is a contract
// signal: "this row should not be written".
export function toDbConfidence(c: DateConfidence): DbDateConfidence | null {
  if (c === 'none') return null;
  return c;
}

// D2 / D7: deterministic date cascade.
//
// Tries signals in priority order, records WHICH ones agreed, returns
// the first signal that produced a valid date AND a confidence based on
// how many independent signals agreed (cross-signal agreement = truth).
//
// NEVER uses `new Date(string)` on locale-ambiguous human strings —
// chrono-node returns parsed components in local time without UTC
// coercion, which kills the v1 TZ-rollback bug class (D8).

export type DateSignal = {
  source: DateProvenance;
  iso: string | null; // YYYY-MM-DD if parsed, null if signal missing
  raw: string | null; // raw label as we saw it
  instant: string | null; // full ISO datetime when the signal carries a
                          // time-of-day (RSS/sitemap/meta/jsonld/<time>/pdf-meta);
                          // null for time-less inputs (chrono'd body labels)
};

export type DateCascadeResult = {
  published_at: string | null;          // full ISO instant from the chosen signal
                                        // when it carries a time (preserves intra-day
                                        // order, parity with v1); YYYY-MM-DD for
                                        // time-less signals (chrono'd body labels)
  published_at_source: DateProvenance;
  published_at_confidence: DateConfidence;
  signals: DateSignal[];                // all signals attempted (for audit)
  agreeing: DateProvenance[];           // signals that produced the same iso as the chosen one
};

// D18 (Hellenic POC 2026-05-30): there are TWO classes of date input,
// and they need OPPOSITE timezone handling.
//
//  1. ISO-with-TZ inputs (RSS RFC822 with +0000, sitemap <lastmod>,
//     JSON-LD/meta with ISO+TZ, <time datetime>). The source ALREADY
//     stated the canonical instant. The article's "calendar day" is the
//     UTC day of that instant — using local components would roll a
//     22:50 UTC into next-day-local in any positive UTC zone (Istanbul
//     +3 was the Hellenic symptom: 2026-05-24T22:50:02+00:00 → wrong
//     2026-05-25). UTC components keep the date semantically tied to
//     the source's stated instant.
//
//  2. Chrono-parsed natural-language inputs (body_header "Posted May 24,
//     2026"). Chrono returns a Date anchored in the LOCAL calendar day
//     (no timezone in the source string). Using UTC components would
//     pull a local-midnight back a day in negative-UTC zones — the v1
//     bug class the original toIsoDate() guarded against.
//
// Two helpers, picked by the caller based on input shape.
function toIsoDateUTC(d: Date | null): string | null {
  if (!d || isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toIsoDateLocal(d: Date | null): string | null {
  if (!d || isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Date-granularity parity (2026-06-18): preserve the source's full instant
// when it carries a time-of-day, so intra-day "newest first" ordering matches
// v1 (which stores the RSS/sitemap timestamp to the second). v2 previously
// collapsed every datetime to its YYYY-MM-DD day → all of a day's articles
// landed at 00:00:00Z and lost their order. The date-only `iso` is still used
// for cross-signal AGREEMENT scoring and the validator's UTC-day checks; this
// instant only feeds the written `published_at`. Returns null for time-less
// inputs (chrono'd natural-language body labels) so those stay date-only.
function toInstantUTC(d: Date | null): string | null {
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString();
}
function instantFromIso(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseChrono(raw: string | null): Date | null {
  if (!raw) return null;
  // chrono.strict requires an explicit month token (January, Jan, Feb...)
  // — it REJECTS bare numeric sequences like "3-2-2011" (which the
  // default parser greedily reads as M-D-YYYY). The Panama Canal PDF
  // probe (2026-05-30) failed exactly there: Microsoft Word's "v.
  // 3-2-2011" template version stamp got parsed as 2011-03-02 instead
  // of the real "November 6, 2012" four lines later in the body.
  // Strict-mode forces the month word and the actual article date wins.
  const parsed = chrono.strict.parseDate(raw);
  return parsed ?? null;
}

export type DateInputs = {
  rssPubDate: Date | null;
  sitemapLastmod: Date | null;
  metaArticlePublishedTime: string | null;
  jsonLdDatePublished: string | null;
  timeElementDatetime: string | null;
  bodyHeaderLabel: string | null;
  rawPubDateLabel: string | null; // the RFC822/etc raw string before parsing
  /** PDF /Info CreationDate, parsed to ISO. File-write time, not
   *  article publish — placed AFTER sitemap_lastmod in cascade priority
   *  for the same "corroborator, not primary" reason. */
  pdfMetadataCreation: string | null;
};

export function extractDate(inputs: DateInputs): DateCascadeResult {
  const signals: DateSignal[] = [];

  const pushIso = (
    source: DateProvenance,
    iso: string | null,
    raw: string | null,
    instant: string | null,
  ) => signals.push({ source, iso, raw, instant });

  // 1. RSS pubDate — already parsed by rss-parser from RFC822 with TZ;
  //    use UTC components so a 22:50 +0000 pubDate stays its UTC day.
  pushIso(
    'rss_pubdate',
    toIsoDateUTC(inputs.rssPubDate),
    inputs.rawPubDateLabel,
    toInstantUTC(inputs.rssPubDate),
  );

  // 2. JSON-LD datePublished — typically structured ISO with TZ
  if (inputs.jsonLdDatePublished) {
    const d = new Date(inputs.jsonLdDatePublished);
    pushIso(
      'jsonld_datePublished',
      isNaN(d.getTime()) ? null : toIsoDateUTC(d),
      inputs.jsonLdDatePublished,
      instantFromIso(inputs.jsonLdDatePublished),
    );
  }

  // 3. meta article:published_time — structured ISO with TZ
  if (inputs.metaArticlePublishedTime) {
    const d = new Date(inputs.metaArticlePublishedTime);
    pushIso(
      'meta_article_published_time',
      isNaN(d.getTime()) ? null : toIsoDateUTC(d),
      inputs.metaArticlePublishedTime,
      instantFromIso(inputs.metaArticlePublishedTime),
    );
  }

  // 4. <time datetime="…"> — datetime attr is ISO with TZ per HTML5
  if (inputs.timeElementDatetime) {
    const d = new Date(inputs.timeElementDatetime);
    pushIso(
      'time_element_datetime',
      isNaN(d.getTime()) ? null : toIsoDateUTC(d),
      inputs.timeElementDatetime,
      instantFromIso(inputs.timeElementDatetime),
    );
  }

  // 5. Sitemap lastmod — weakest among datetime signals (could be edit
  //    time, not publish time). Always ISO with TZ from sitemap spec.
  pushIso(
    'sitemap_lastmod',
    toIsoDateUTC(inputs.sitemapLastmod),
    null,
    toInstantUTC(inputs.sitemapLastmod),
  );

  // 6. Body header label parsed via chrono-node — natural-language
  //    source has no TZ; chrono returns Date in LOCAL day, keep local.
  //    For PDF articles this is fed from extractPdf.bodyHeaderProbe
  //    (first ~500 chars of extracted text) and is OFTEN the article's
  //    own stated date ("November 6, 2012" on the Panama Canal advisory)
  //    — more authoritative than the PDF file's write time below.
  if (inputs.bodyHeaderLabel) {
    pushIso(
      'body_header_label',
      toIsoDateLocal(parseChrono(inputs.bodyHeaderLabel)),
      inputs.bodyHeaderLabel,
      // Natural-language body labels ("November 6, 2012") carry no
      // time-of-day; chrono'd midnight is meaningless as an instant, so
      // this signal stays date-only by design.
      null,
    );
  }

  // 7. PDF /Info CreationDate — file CREATION time, NOT article publish
  //    time (Panama Canal A-27-2012: body says Nov 6, PDF CreationDate
  //    Nov 8 — two days off). Lowest-priority among datetime signals
  //    for the same reason sitemap_lastmod is low: it's a file-system
  //    timestamp masquerading as content metadata.
  if (inputs.pdfMetadataCreation) {
    const d = new Date(inputs.pdfMetadataCreation);
    pushIso(
      'pdf_metadata_creation',
      isNaN(d.getTime()) ? null : toIsoDateUTC(d),
      inputs.pdfMetadataCreation,
      instantFromIso(inputs.pdfMetadataCreation),
    );
  }

  // Pick the FIRST signal that produced a non-null iso (priority order).
  const chosen = signals.find((s) => s.iso !== null);
  if (!chosen) {
    return {
      published_at: null,
      published_at_source: 'unknown',
      published_at_confidence: 'none',
      signals,
      agreeing: [],
    };
  }
  // Cross-signal agreement: how many OTHER signals produced the SAME iso?
  const agreeing = signals
    .filter((s) => s.iso === chosen.iso)
    .map((s) => s.source);
  let confidence: DateConfidence =
    agreeing.length >= 2 ? 'high' : agreeing.length === 1 ? 'medium' : 'low';

  // D18 cap: sitemap_lastmod is "last modified", not "first published".
  // When it's the SOLE signal, even though agreeing.length === 1 would
  // normally yield medium, downgrade to 'low' because the signal class
  // is corroborator, not primary publication evidence. As a corroborator
  // (agreeing.length >= 2 with another real-publish signal), it counts
  // normally toward 'high' — that's its honest role.
  if (
    chosen.source === 'sitemap_lastmod' &&
    agreeing.length === 1 &&
    confidence === 'medium'
  ) {
    confidence = 'low';
  }

  return {
    // Write the full instant when the chosen signal carries a time (parity
    // with v1, preserves intra-day order); fall back to the date-only day
    // for time-less signals. Agreement/confidence above stay day-level.
    published_at: chosen.instant ?? chosen.iso,
    published_at_source: chosen.source,
    published_at_confidence: confidence,
    signals,
    agreeing,
  };
}
