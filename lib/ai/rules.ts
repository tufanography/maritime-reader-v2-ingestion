// Free, deterministic alternative to Claude. Used when ANTHROPIC_API_KEY is not set.
// - summary: first 2 sentences of the RSS excerpt (or first 220 chars).
// - category: keyword-match against title + excerpt, weighted; falls back to source hint, then 'general'.

import type { CategorySlug } from './claude';

type RuleSet = { slug: CategorySlug; weight: number; patterns: RegExp[] };

const CATEGORY_RULES: RuleSet[] = [
  {
    slug: 'tankers',
    weight: 1,
    patterns: [
      /\btankers?\b/i, /\bvlccs?\b/i, /\bsuezmax\b/i, /\baframax\b/i, /\bMR tanker\b/i,
      /\b(lr1|lr2)\b/i, /\bcrude (oil )?(carrier|tanker)\b/i, /\bproduct tanker\b/i,
      /\bchemical tanker\b/i, /\b(lng|lpg) (carrier|tanker|vessel)\b/i,
    ],
  },
  {
    slug: 'container',
    weight: 1,
    patterns: [
      // Strong signals — concept words specific to container shipping.
      /\bcontainer ?ships?\b/i,
      /\bbox ?ships?\b/i,
      /\b\d{2,3},?\d{3}\s?teu\b/i,           // "15,000 TEU"
      /\bteu\b/i,                            // generic TEU
      /\bfeeder vessels?\b/i,
      /\bmainline (carrier|service|operator)\b/i,
      /\bliner shipping\b/i,
      /\bcontainer (terminal|trade|fleet|market|line)\b/i,
      // Alliance names — case-sensitive on purpose, "the alliance" alone is ambiguous.
      /\bGemini Cooperation\b/,
      /\b(2M|MSC\+|Ocean|THE|Premier) Alliance\b/,
      // Carrier names — case-sensitive proper nouns to avoid matching common words
      // like "one" or "hmm" mid-sentence.
      /\bMaersk\b/,
      /\bMSC\b/,
      /\bCMA[\s-]?CGM\b/,
      /\bHapag-?Lloyd\b/,
      /\bEvergreen Marine\b/i,                // require "Marine" qualifier
      /\bCOSCO Shipping\b/i,                  // require "Shipping" qualifier
      /\bOcean Network Express\b/i,
      /\b\(ONE\)\b/,                          // ONE only when parenthesized
      /\bZIM (Integrated|Lines?)\b/i,
      /\bYang Ming\b/i,
      /\bHMM Co\b/,                           // HMM only with "Co" suffix
      /\bWan Hai\b/i,
      /\bPIL Pacific\b/i,
    ],
  },
  {
    slug: 'dry-bulk',
    weight: 1,
    patterns: [
      /\bbulk carriers?\b/i, /\bcapesize\b/i, /\bpanamax\b/i, /\bsupramax\b/i,
      /\bhandymax\b/i, /\bhandysize\b/i, /\biron ore\b/i, /\bcoal (cargo|shipment)\b/i,
      /\bgrain (shipment|cargo|export)\b/i, /\bdry bulk\b/i, /\bbaltic dry index\b/i, /\bbdi\b/i,
    ],
  },
  {
    slug: 'regulations',
    weight: 1,
    patterns: [
      /\bIMO\b/, /\bMARPOL\b/i, /\bSOLAS\b/i, /\bMEPC\s*\d+/i, /\bMSC\s*\d+/i,
      /\b(maritime|shipping|vessel|ship) regulations?\b/i,    // contextual, not standalone
      /\bEU directive\b/i, /\bregulatory (framework|update)\b/i,
      /\b(EU ETS|FuelEU|CII|EEDI|EEXI)\b/i,
      /\b(sanction(ed|s)|sanctions list)\b/i,
      /\bport state control\b/i, /\bPSC inspection\b/i,
      /\b(maritime|shipping|imo|stcw|mlc) (treaty|convention|amendment|protocol)\b/i,
    ],
  },
  {
    slug: 'accidents',
    weight: 2,
    patterns: [
      /\bcollision\b/i, /\bgroundings?\b/i, /\bsink(ing|ed|s)\b/i, /\bfire (on board|aboard|broke out)\b/i,
      /\bexplosion\b/i, /\bcapsiz(e|ed|ing)\b/i, /\bcasualt(y|ies)\b/i,
      /\bdistress (call|signal)\b/i, /\bsalvage\b/i, /\bmayday\b/i,
      /\bship (incident|accident)\b/i, /\boil spill\b/i, /\b(allision|allided)\b/i,
    ],
  },
  {
    slug: 'pi-insurance',
    weight: 1,
    patterns: [
      /\bP&I\b/i, /\bP and I\b/i, /\bprotection and indemnity\b/i,
      /\bFD&D\b/i, /\bhull (and|&) machinery\b/i, /\bH&M\b/i,
      /\bwar risk (insurance|cover)\b/i, /\bkidnap and ransom\b/i, /\bK&R\b/i,
      /\bmarine insurance\b/i, /\bunderwriters?\b/i, /\bclub circular\b/i,
    ],
  },
  {
    slug: 'classification',
    weight: 1,
    patterns: [
      /\bclassification societ(y|ies)\b/i,
      /\bclass societ(y|ies)\b/i,
      /\bIACS\b/,
      /\btype approval\b/i,
      /\bclass notation\b/i,
      /\bclass(ed|ification) (with|by)\b/i,
      // Class society names — disambiguated to avoid colliding with other acronyms.
      /\bDNV\b/,
      /\bABS class\b/i,
      /\bAmerican Bureau of Shipping\b/i,
      /\bLloyd's Register\b/i,
      /\bBureau Veritas\b/i,
      /\bClassNK\b/,
      /\bKorean Register\b/i,
      /\bChina Classification Society\b/i,        // CCS alone is ambiguous (carbon capture)
      /\bRINA (S\.p\.A|class|register)\b/i,
      /\bIndian Register of Shipping\b/i,         // IRS alone is ambiguous (revenue service)
      /\bPolish Register of Shipping\b/i,
    ],
  },
  {
    slug: 'shipbuilding',
    weight: 1,
    patterns: [
      /\bshipyards?\b/i, /\bnewbuild(ing)?s?\b/i, /\bdelivered (the|its|first)\b/i,
      /\bkeel (laid|laying)\b/i, /\blaunch ceremony\b/i, /\b(steel cutting|first steel)\b/i,
      /\b(Hyundai Heavy|Samsung Heavy|Hanwha Ocean|Daewoo|DSME|CSSC|Hudong-Zhonghua|Imabari|JMU|Tsuneishi)\b/i,
      /\bordered (\d+ )?(vessels|ships|tankers|carriers|boxships)\b/i,
    ],
  },
  {
    slug: 'offshore',
    weight: 1,
    patterns: [
      /\boffshore wind\b/i, /\bFPSO\b/, /\bdrilling rigs?\b/i, /\bjack-?ups?\b/i,
      /\bsemi-?submersibles?\b/i, /\bsubsea\b/i, /\boil platforms?\b/i,
      /\bdecommission(ing)?\b/i, /\b(AHTS|PSV|OSV)\b/, /\b(CTV|SOV|WTIV)\b/,
      /\bwind (farm|turbine installation)\b/i,
    ],
  },
  {
    slug: 'ports',
    weight: 1,
    patterns: [
      /\bport of [A-Z][a-z]+/, /\bcontainer terminal\b/i, /\bterminals?\b/i,
      /\bcargo throughput\b/i, /\bdredging\b/i, /\bport authority\b/i,
      /\bharbor ?master\b/i, /\bstevedor(e|ing)\b/i, /\bberths?\b/i,
    ],
  },
  {
    slug: 'crew',
    weight: 1,
    patterns: [
      /\bseafarers?\b/i, /\bcrew change\b/i, /\bMLC\b/, /\bmaritime labou?r\b/i,
      /\bmanning agenc(y|ies)\b/i, /\bcadets?\b/i, /\bship (manager|owner) wages\b/i,
      /\bcertificate of competenc(y|e)\b/i, /\bshore leave\b/i, /\brepatriation\b/i,
      /\bcrew welfare\b/i, /\babandoned crew\b/i,
    ],
  },
];

export function categorizeByRules(args: {
  title: string;
  excerpt: string;
  hint?: string | null;
}): { category: CategorySlug; confidence: number } {
  const text = `${args.title}\n${args.excerpt}`;

  let best: { slug: CategorySlug; score: number } = { slug: 'general', score: 0 };
  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const p of rule.patterns) {
      const matches = text.match(p);
      if (matches) score += rule.weight * (p.flags.includes('g') ? matches.length : 1);
      // bonus for hits in the title
      if (args.title.match(p)) score += rule.weight;
    }
    if (score > best.score) best = { slug: rule.slug, score };
  }

  // Source hint takes over only if rules found nothing strong
  if (best.score < 2 && args.hint) {
    return { category: args.hint as CategorySlug, confidence: 0.6 };
  }
  if (best.score === 0) {
    return { category: 'general', confidence: 0.3 };
  }
  // Crude confidence: 1 hit = 0.5, 3+ hits = 0.9
  const confidence = Math.min(0.9, 0.4 + best.score * 0.15);
  return { category: best.slug, confidence };
}

export function extractSummary(excerpt: string): string {
  if (!excerpt) return '';
  const cleaned = excerpt.replace(/\s+/g, ' ').trim();
  // Try to take first 2 sentences
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length >= 2) {
    const two = sentences.slice(0, 2).join(' ').trim();
    if (two.length >= 60) return two.slice(0, 320);
  }
  // Fallback: hard truncate at word boundary
  if (cleaned.length <= 280) return cleaned;
  return cleaned.slice(0, 280).replace(/\s+\S*$/, '') + '…';
}
