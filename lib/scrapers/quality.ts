// Heuristics for filtering out "scraped pages that aren't actually articles":
// nav landing pages, CTA sign-up pages, aggregator catalogues, etc.
//
// We err on the side of letting borderline content through — false positives
// here mean a genuine article gets dropped, which is worse than a slightly
// noisy aggregator page sneaking in. The thresholds are tuned for what we
// actually saw in production (ABS "Rules and Guides", LR "Stay alert").

// Hub-shaped titles: aggregator / catalogue pages that genuinely contain
// many sub-resources. When the scraper has `unfold_hubs: true`, we harvest
// the page's links instead of inserting it as an article.
const HUB_TITLE_PATTERNS: RegExp[] = [
  /^rules?\s*(and|&)\s*(guides?|resources?|regulations?)\s*$/i,
  /^news?\s*(and|&)\s*(resources?|insights?|publications?)\s*$/i,
  /^(explore|browse)\s+(our\s+)?(rules?|resources?|publications?|services?|insights?)\s*$/i,
  /^(home|homepage|main\s+page|landing\s+page)$/i,
  /^(forms?|databases?|portal|dashboard|directory)$/i,
  /^(latest|all)\s+(news|articles|publications|updates)$/i,
  /^downloads?$/i,
  /^(table\s+of\s+contents?|content\s+page|index)$/i,
  /^page\s+\d+\s*(of\s+\d+)?$/i,
  /^articles?$/i,
  /^publications?$/i,
  /^events?$/i,
];

// CTA / policy / sign-up titles. These pages are usually empty of editorial
// content. Not worth unfolding either — they don't contain article links.
const CTA_TITLE_PATTERNS: RegExp[] = [
  /^(stay\s+alert|stay\s+up\s+to\s+date|stay\s+informed)\b/i,
  /^subscribe\s+(to\s+)?(our\s+)?(newsletter|alerts?|updates?|mailing\s+lists?)\b/i,
  /^(sign\s*(in|up)|log\s*(in|out))\s*(to|for)?\b/i,
  /^(privacy\s+(policy|notice)|terms\s+(of|and)|cookie\s+(policy|notice)|legal\s+notice|disclaimer)\b/i,
  /^(about\s+us|contact\s+us|careers?\s+at|our\s+team|join\s+us)$/i,
  /^webinar\s+test$/i,
  // Commercial / product / portal pages — not news.
  /^(explore\s+(global|our|the)\s+\w+)$/i,    // "Explore Global Marine", "Explore Our Services"
  /^(engineering\s+applications?|engineering\s+software)$/i,
  /^(flag\s+(and|&)\s+port\s+state\s+info)$/i,
  /^[A-Z][a-zA-Z]*[™®]/,            // "ABS MyFreedom™", "Foo®" — branded products
  /\b(portal|client\s+portal|my\s*\w+\s+portal)\s*$/i,
  /^(buy|purchase|order|pricing|plans?)\b/i,
  /^(membership|enroll|register\s+today)\b/i,
  // Template / placeholder titles that the scraper picked up from CTA
  // buttons or layout elements rather than real article headlines.
  // Steamship Mutual was inserting many "Press Release" rows because
  // their listing page uses that exact text on multiple click targets.
  /^press\s+release\s*$/i,
  /^download\s+(v?card|brochure|pdf|file)\s*$/i,
  /^(read|learn)\s+more\s*$/i,
  /^(view|see)\s+(all|more|details)\s*$/i,
  /^(click|tap)\s+here\s*$/i,
  /^(more|all|see)\s+(news|articles|updates|publications)\s*$/i,
];

// URL paths that signal commercial / product / portal content rather than
// editorial. Applied to the article URL string.
const JUNK_URL_PATTERNS: RegExp[] = [
  /\/(products?-and-services?|products?\/|services?\/)/i,
  /\/(my-?freedom|client-?portal|portal\/?$|dashboard\/?$)/i,
  /\/(login|signin|sign-in|signup|sign-up|register|enroll)/i,
  /\/(software|engineering-software|engineering-applications)/i,
  /\/(pricing|plans|buy|purchase|order|cart|checkout)/i,
  /\/(my-account|profile|settings)/i,
];

const JUNK_TITLE_PATTERNS: RegExp[] = [...HUB_TITLE_PATTERNS, ...CTA_TITLE_PATTERNS];

const JUNK_EXCERPT_PHRASES: RegExp[] = [
  /(sign\s*in|log\s*in)\b.{0,30}(subscribe|register|newsletter)/i,
  /(subscribe|sign\s*up).{0,40}(newsletter|alerts?|updates)/i,
];

/** Count how many CTA-style fragments appear in the excerpt. */
function ctaDensity(excerpt: string): number {
  const ctas = [
    /\blearn more\b/gi,
    /\bsign in\b/gi,
    /\bsign up\b/gi,
    /\bsubscribe\b/gi,
    /\bregister\b/gi,
    /\bview all\b/gi,
    /\bread more\b/gi,
    /\bdownload\b/gi,
    /\bgo to\b/gi,
    /\bvisit\b/gi,
  ];
  return ctas.reduce((sum, re) => sum + (excerpt.match(re)?.length ?? 0), 0);
}

export type QualityVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/** Decide whether a scraped row looks like a real article worth indexing. */
export function looksLikeArticle(args: { title: string; excerpt: string; url?: string }): QualityVerdict {
  const title = args.title.trim();
  const excerpt = args.excerpt.trim();

  if (title.length < 8) return { ok: false, reason: `title too short (${title.length} chars)` };
  for (const pat of JUNK_TITLE_PATTERNS) {
    if (pat.test(title)) return { ok: false, reason: `title matches junk pattern ${pat}` };
  }
  if (args.url) {
    for (const pat of JUNK_URL_PATTERNS) {
      if (pat.test(args.url)) return { ok: false, reason: `url matches junk path ${pat}` };
    }
  }

  // Excerpt minimum: only catches truly empty / one-line pages. Many real
  // P&I circulars and class advisories are condensed to a 30-50 char headline
  // by the AI summariser, so we set the floor very low.
  // EXCEPTION: YouTube video items often have short or empty descriptions
  // (especially Shorts and multi-language conference uploads like
  // "C/ES 36 - Day 1 (Spanish)"). For these, a meaningful title + a
  // valid publish date is enough — skip the excerpt-length check.
  const isYouTube = args.url ? /^https?:\/\/(www\.)?youtube\.com\/watch\?v=/.test(args.url) : false;
  if (!isYouTube && excerpt.length < 30) {
    return { ok: false, reason: `excerpt too short (${excerpt.length} chars)` };
  }

  // JUNK_EXCERPT_PHRASES catch pure CTA / sign-up landing pages where the
  // entire body is chrome. But the same phrases ("Sign up for alerts")
  // also appear once in real articles' template chrome — Shipowners' Club
  // puts that line above every article. Only fire when the excerpt is
  // short enough that the JUNK phrase dominates; long excerpts fall back
  // to the CTA-density check below.
  if (excerpt.length < 600) {
    for (const pat of JUNK_EXCERPT_PHRASES) {
      if (pat.test(excerpt)) return { ok: false, reason: `excerpt matches junk phrase ${pat}` };
    }
  }

  // Pages dominated by CTAs are almost always navigation indices ("Explore
  // our resources" hubs). Only fires for clearly hub-shaped content: the
  // excerpt has to be substantial AND the CTA hits very high. Real PDFs with
  // some footer chrome will trip 4-5; only 8+ should be a kill signal.
  if (excerpt.length > 800) {
    const ctaHits = ctaDensity(excerpt);
    if (ctaHits >= 8) return { ok: false, reason: `${ctaHits} CTA fragments in excerpt` };
  }

  return { ok: true };
}

/** Distinct from looksLikeArticle: classifies a rejected (or about-to-be-
 *  rejected) page as a HUB worth harvesting child links from. Hubs are
 *  aggregator/catalogue pages — "Rules and Guides", an issue's table of
 *  contents, a news landing — that contain many real article URLs inside.
 *
 *  Used by the scraper when `unfold_hubs: true` is set for a source. */
export function looksLikeHub(args: { title: string; excerpt: string }): boolean {
  const title = args.title.trim();
  const excerpt = args.excerpt.trim();

  for (const pat of HUB_TITLE_PATTERNS) {
    if (pat.test(title)) return true;
  }
  // High CTA density on a long excerpt is the other strong hub signal.
  if (excerpt.length > 800 && ctaDensity(excerpt) >= 8) return true;
  return false;
}
