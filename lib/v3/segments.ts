// Derive vessel-segment tags for an article. Segments are an OR-able multi-select
// dimension on the V3 home page, parallel to (and independent of) document_type.
//
// An article can belong to ZERO, ONE, or MANY segments. A regulation about
// tanker emissions can be in ['tanker'] segment, while a P&I circular discussing
// both bulkers and containers can be in ['dry_bulk','container'].
//
// Backfill rule order (all matching segments are added):
//   1. Source-name signal — "Container News", "LNG Prime" etc. set a baseline
//   2. Category slug → segment (if applicable)
//   3. Keyword patterns in title + excerpt → additional segments

export type Segment =
  | 'tanker'
  | 'dry_bulk'
  | 'container'
  | 'lng_lpg'
  | 'offshore'
  | 'cruise';

const SEGMENT_LABELS: Record<Segment, string> = {
  tanker: 'Tankers',
  dry_bulk: 'Dry Bulk',
  container: 'Container',
  lng_lpg: 'LNG / LPG',
  offshore: 'Offshore',
  cruise: 'Cruise',
};

export function segmentLabel(s: Segment): string {
  return SEGMENT_LABELS[s];
}

export const ALL_SEGMENTS: Segment[] = ['tanker', 'dry_bulk', 'container', 'lng_lpg', 'offshore', 'cruise'];

// Map our existing category slugs to segments where the mapping is direct.
const CATEGORY_TO_SEGMENT: Record<string, Segment> = {
  tankers: 'tanker',
  container: 'container',
  'dry-bulk': 'dry_bulk',
  offshore: 'offshore',
};

// Source-name signal — when the source's name unambiguously slots into
// a segment (Container News → container), every article from it inherits
// that segment as a baseline. Specific keyword rules still apply on top
// and can add additional segments.
const SOURCE_NAME_TO_SEGMENT: Array<{ pattern: RegExp; segment: Segment }> = [
  { pattern: /\bcontainer\b/i, segment: 'container' },
  { pattern: /\btanker\b/i,    segment: 'tanker' },
  { pattern: /\b(LNG|LPG)\b/i, segment: 'lng_lpg' },
  { pattern: /\boffshore\b/i,  segment: 'offshore' },
  { pattern: /\b(bulk|bulker)\b/i, segment: 'dry_bulk' },
  { pattern: /\bcruise\b/i,    segment: 'cruise' },
];

type SegmentRule = { segment: Segment; patterns: RegExp[] };

const SEGMENT_RULES: SegmentRule[] = [
  {
    segment: 'tanker',
    patterns: [
      /\btanker(s)?\b/i,
      /\bVLCC(s)?\b/,
      /\bULCC(s)?\b/,
      /\bSuezmax\b/i,
      /\bAframax\b/i,
      /\b(MR|LR1|LR2)\s+tanker\b/i,
      /\bcrude\s+(oil\s+)?(carrier|tanker)\b/i,
      /\bproduct\s+tanker\b/i,
      /\bchemical\s+tanker\b/i,
      /\boil\s+tanker\b/i,
      /\bshuttle\s+tanker\b/i,
      // Tanker freight-rate indices
      /\b(BDTI|BCTI|World\s*Scale|Worldscale|WS\s*\d{2,3})\b/i,
      // Major tanker operators (word-boundary safe)
      /\b(Frontline|Euronav|International\s+Seaways|Teekay\s+Tankers|Scorpio\s+Tankers|DHT\s+Holdings|TORM\s+(plc)?|Hafnia\s+Ltd?|Ardmore\s+Shipping)\b/i,
    ],
  },
  {
    segment: 'container',
    patterns: [
      /\bcontainer\s*ship(s)?\b/i,
      /\bbox\s*ship(s)?\b/i,
      /\b\d{1,2},?\d{3}\s*TEU\b/,
      /\b(\d{1,3})k\s+TEU\b/i,
      /\bfeeder\s+(vessel|service)\b/i,
      /\bmainline\s+(carrier|service)\b/i,
      /\bliner\s+(shipping|trade|service)\b/i,
      // "container ___" common nouns — was tightly scoped to terminal/trade/
      // fleet/line, now includes freight/rate/cargo/carrier/sector/etc.
      // This was the gap that left "container freight rates declined" untagged.
      /\bcontainer\s+(freight|rate|rates|cargo|carrier|sector|industry|market|operator|operation|business|earnings|volume|volumes|shipping|trade|fleet|line|lines|terminal|terminals)\b/i,
      // "containerized" — the standalone modifier covers "Containerized
      // Freight Index", "containerized cargo," etc.
      /\bcontaineri[sz]ed\b/i,
      // Container freight indices
      /\b(SCFI|CCFI|WCI|FBX|HRCI|XSI|HARPEX|Drewry\s+World\s+Container)\b/i,
      // Top container-line operators. Names chosen to minimise false
      // positives — "MSC" alone could be MSC Cruises, so we anchor on
      // their full-form "Mediterranean Shipping" instead, or pair with
      // shipping-context suffix. Same for "Maersk" (Maersk Drilling).
      /\b(HMM\s+(Co|Korea|Container)|HMM\b(?!\s+(Drilling|Offshore)))\b/,
      /\bHapag-Lloyd\b/i,
      /\b(Evergreen\s+Marine|Evergreen\s+Line)\b/i,
      /\bMediterranean\s+Shipping\s+Co/i,
      /\bCMA\s+CGM\b/i,
      /\b(COSCO\s+Shipping(\s+Lines)?)\b/i,
      /\bONE\s+(Network|Container|Line)\b/i,
      /\bYang\s+Ming\b/i,
      /\bWan\s+Hai\b/i,
      /\bZIM\s+(Integrated|Lines|Shipping)\b/i,
      // Container alliances
      /\b(2M|Ocean|THE|Premier|Gemini)\s+(Alliance|Cooperation)\b/,
    ],
  },
  {
    segment: 'dry_bulk',
    patterns: [
      /\bbulk\s+(carrier|carriers|fleet|trade|shipping|sector|market)\b/i,
      /\bdry\s+bulk\b/i,
      /\bcapesize(s)?\b/i,
      /\bpanamax(es)?\b/i,
      /\bkamsarmax(es)?\b/i,
      /\bsupramax(es)?\b/i,
      /\bultramax(es)?\b/i,
      /\bhandymax(es)?\b/i,
      /\bhandysize(s)?\b/i,
      /\bnewcastlemax\b/i,
      /\biron\s+ore\b/i,
      /\bcoal\s+(shipment|cargo|trade|carrier)\b/i,
      /\bgrain\s+(shipment|cargo|export|trade)\b/i,
      /\bbauxite\s+cargo\b/i,
      // Solid-bulk cargoes that recur in P&I loss-prevention (the IMSBC "Group A"
      // liquefaction family). These were missed: "nickel ore cargoes",
      // "cargo liquefaction", "Group A cargo" are unambiguously dry-bulk.
      // NOTE: bare "liquefaction" is NOT added — "LNG liquefaction" is lng_lpg.
      /\b(nickel|manganese|chrome|chromium|fluorspar|bauxite)\s+ore\b/i,
      /\bore\s+(cargo|cargoes)\b/i,
      /\bcargo\s+liquefaction\b/i,
      /\bmay\s+liquefy\b/i,
      /\bgroup\s+a\s+cargo(es)?\b/i,
      /\bsolid\s+bulk\s+cargo(es)?\b/i,
      /\b(BDI|BCI|BPI|BSI|BHSI)\b/,                  // Baltic Dry/Capesize/Panamax/Supramax/Handysize
      /\bBaltic\s+(Dry|Capesize|Panamax|Supramax|Handysize)\s+Index\b/i,
      // Major dry-bulk operators
      /\b(Star\s+Bulk|Genco\s+Shipping|Pacific\s+Basin|Eagle\s+Bulk|Diana\s+Shipping|Safe\s+Bulkers|Golden\s+Ocean|Berge\s+Bulk|2020\s+Bulkers|Himalaya\s+Shipping)\b/i,
    ],
  },
  {
    segment: 'lng_lpg',
    patterns: [
      /\b(LNG|LPG)\s+(carrier|carriers|tanker|tankers|vessel|vessels|ship|ships|terminal|trade|fleet|sector|market|industry)\b/i,
      /\b(LNG|LPG)\s+(bunkering|cargo|cargoes|export|imports?)\b/i,
      /\b(LNG|LPG)\s+(force\s+majeure|spot|charter|chartering)\b/i,
      /\bgas\s+carrier(s)?\b/i,
      /\bVLGC(s)?\b/,
      /\bMGC(s)?\b/,                                    // medium gas carrier
      /\bFSRU(s)?\b/,                                   // floating storage regasification unit
      /\bFLNG\b/,                                       // floating LNG
      /\bmethanol\s+(carrier|fuel|vessel|ship|bunker)\b/i,
      /\bammonia\s+(carrier|fuel|vessel|ship|bunker)\b/i,
      /\bliquefied\s+(natural\s+gas|petroleum\s+gas)\b/i,
      // LNG/LPG operators
      /\b(GasLog|BW\s+LPG|BW\s+LNG|H[öo]egh\s+LNG|Awilco\s+LNG|Cool\s+Company|Excelerate\s+Energy|Dynagas|Flex\s+LNG|Capital\s+Gas)\b/i,
      // Gas price benchmarks (signal LNG market context)
      /\b(JKM|TTF)\s+(price|index|spot)\b/i,
    ],
  },
  {
    segment: 'offshore',
    patterns: [
      /\boffshore\s+(wind|oil|gas|vessel|vessels|installation|fleet|sector|market|industry|service)\b/i,
      /\bFPSO(s)?\b/,
      /\bFPU(s)?\b/,
      /\bdrilling\s+rig(s)?\b/i,
      /\bjack-?up(s)?\b/i,
      /\bsemi-?submersible(s)?\b/i,
      /\bsubsea\b/i,
      /\boil\s+platform\b/i,
      /\b(AHTS|PSV|OSV|CTV|SOV|WTIV)\b/,
      /\bwind\s+(farm|turbine\s+installation)\b/i,
      // Offshore operators / contractors
      /\b(SBM\s+Offshore|Transocean|Saipem|Subsea\s*7|TechnipFMC|McDermott\s+International|Modec|Bumi\s+Armada|Yinson|Bourbon|Solstad\s+Offshore|DOF\s+Group)\b/i,
    ],
  },
  {
    segment: 'cruise',
    patterns: [
      /\bcruise\s+(ship|ships|line|lines|operator|operators|industry|sector|vessel|vessels|fleet|company|business|booking|bookings|deployment)\b/i,
      /\b(Royal\s+Caribbean\s+(Group|International|Cruises)|RCL\s+Holdings)\b/i,
      /\bCarnival\s+(Corporation|Cruise|Cruises|Cruise\s+Line)\b/i,
      /\bNorwegian\s+Cruise\s+Line\b/i,
      /\bMSC\s+Cruises\b/i,
      /\b(Princess|Holland\s+America|Celebrity|Costa|AIDA|Cunard|P&O\s+Cruises)\s+Cruises?\b/i,
      /\bpassenger\s+(ship|vessel|liner|cruise)\b/i,
    ],
  },
];

export function deriveSegments(args: {
  categorySlug: string | null;
  title: string;
  excerpt: string;
  sourceName?: string | null;
}): Segment[] {
  const { categorySlug, title, excerpt, sourceName } = args;
  const found = new Set<Segment>();

  // 1. Source-name baseline — Container News, LNG Prime, etc.
  if (sourceName) {
    for (const { pattern, segment } of SOURCE_NAME_TO_SEGMENT) {
      if (pattern.test(sourceName)) found.add(segment);
    }
  }

  // 2. Direct mapping from category
  if (categorySlug && CATEGORY_TO_SEGMENT[categorySlug]) {
    found.add(CATEGORY_TO_SEGMENT[categorySlug]);
  }

  // 3. Keyword scan over title + excerpt (title carries more weight implicitly
  //    because it tends to be more specific; we don't need a score here)
  const text = `${title}\n${excerpt.slice(0, 1500)}`;
  for (const rule of SEGMENT_RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      found.add(rule.segment);
    }
  }

  return [...found];
}
