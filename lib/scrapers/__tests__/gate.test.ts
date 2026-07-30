// Tests for lib/tagging/gate.ts — the deterministic quality gate.
// Run: npx tsx lib/scrapers/__tests__/gate.test.ts
//
// Uses the same self-asserting pattern as dedup.test.ts (no vitest/jest in this
// repo). Real garbage examples come from the measured 100%-garbage sources
// (Ship and Bunker, Shipowners' Club) plus clean article prose as positives.
import { gateText, filterContentTerms, isProperNounOrAcronym } from '../../tagging/gate';

let pass = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  failures.push(`  ${name}\n     beklenen: ${JSON.stringify(expected)}\n     gelen   : ${JSON.stringify(actual)}`);
};

// ---------------------------------------------------------------------------
// 1. REAL garbage → rejected
// ---------------------------------------------------------------------------
// Ship and Bunker (measured 100% garbage): browser-nag boilerplate.
check('SnB outdated-browser → boilerplate',
  gateText('Bunker Prices Rise in Rotterdam',
    'You are using an outdated browser. Please upgrade your browser to improve your experience.'),
  { ok: false, reason: 'boilerplate' });

// Shipowners' Club (measured 100% garbage): nav chrome.
check("Shipowners' nav chrome → boilerplate",
  gateText('Loss Prevention Bulletin: Mooring Safety',
    'Emergency Contact Club Rules Home Latest updates and guidance for members worldwide.'),
  { ok: false, reason: 'boilerplate' });

check('cookie wall → boilerplate',
  gateText('New MARPOL Annex VI Amendments Enter Force',
    'This website uses cookies. Cookie policy applies. Please subscribe for full access to content.'),
  { ok: false, reason: 'boilerplate' });

check('© copyright chrome → boilerplate',
  gateText('Some Real Maritime Headline Here Today',
    '© 2026 Example Shipping News. All rights reserved. Reproduction prohibited without permission.'),
  { ok: false, reason: 'boilerplate' });

// ---------------------------------------------------------------------------
// 2. Too short → rejected
// ---------------------------------------------------------------------------
check('empty → too-short', gateText('A Title With Several Words', ''), { ok: false, reason: 'too-short' });
check('24 chars → too-short', gateText('Container Ship Grounding', 'x'.repeat(24)), { ok: false, reason: 'too-short' });

// ---------------------------------------------------------------------------
// 3. No title overlap → rejected (title has 3+ content words, none in text)
// ---------------------------------------------------------------------------
check('sidebar unrelated to title → no-title-overlap',
  gateText('Evergreen Vessel Detained Singapore Inspection',
    'Follow our social channels for daily maritime market commentary and analysis every morning.'),
  { ok: false, reason: 'no-title-overlap' });

// ---------------------------------------------------------------------------
// 4. Clean article prose → accepted
// ---------------------------------------------------------------------------
check('clean article body → ok',
  gateText('Port of Rotterdam Reports Record Container Throughput',
    'The Port of Rotterdam handled a record volume of containers in the first quarter, with throughput up 4.2% year on year driven by strong transhipment demand.'),
  { ok: true });

check('clean excerpt overlapping title → ok',
  gateText('Gard Issues Circular on Nickel Ore Liquefaction',
    'Gard has issued a new circular warning members about the liquefaction risk of nickel ore cargoes loaded during the monsoon season in the Philippines and Indonesia.'),
  { ok: true });

// Short title (<3 content words) → overlap rule does NOT apply; passes on prose.
check('short title bypasses overlap rule → ok',
  gateText('EMEA News',
    'Bunker prices at the port of Rotterdam climbed sharply this week amid tighter supply and stronger demand from the container segment.'),
  { ok: true });

// Boilerplate word appearing LATER (past 150 chars) must NOT reject.
check('boilerplate only after 150 chars → ok',
  gateText('Grain Cargo Shifting Incident Under Investigation',
    'The grain cargo shifting incident aboard the bulk carrier is under investigation by the flag state after the vessel developed a list. Investigators are reviewing the loading plan and stability calculations that were prepared before departure from the load port. Note: sign in for the full report.'),
  { ok: true });

// ---------------------------------------------------------------------------
// 5. content_terms quality filter (B fix)
// ---------------------------------------------------------------------------
// isProperNounOrAcronym
check('proper noun 2 words', isProperNounOrAcronym('Onego Otra'), true);
check('proper noun w/ connector', isProperNounOrAcronym('Port of Tyne'), true);
check('acronym RIMPAC', isProperNounOrAcronym('RIMPAC'), true);
check('acronym P&I', isProperNounOrAcronym('P&I'), true);
check('acronym EnBW (mixed)', isProperNounOrAcronym('EnBW'), true);
check('single proper noun Vestas', isProperNounOrAcronym('Vestas'), true);
check('lowercase fragment rejected', isProperNounOrAcronym('is under investigation'), false);
check('4 capitalized words rejected', isProperNounOrAcronym('Odesa Regional Military Administration'), false);
check('lowercase word rejected', isProperNounOrAcronym('according'), false);

// filterContentTerms: drop title slices + stopwords + fragments, keep proper nouns.
{
  const title = 'Russia Strikes Ukrainian Ships In Black Sea';
  const raw = ['Russia Strikes Ukrainian', 'Black Sea', 'Image Credits', 'July', 'Tuesday',
    'According', 'Onego Otra', 'If Muscat', 'Officials', 'Dmitry Peskov', 'YouTube'];
  const out = filterContentTerms(title, raw);
  check('drops title slice "Russia Strikes Ukrainian"', out.includes('Russia Strikes Ukrainian'), false);
  check('drops "Black Sea" (title slice)', out.includes('Black Sea'), false);
  check('drops "Image Credits" (stopword)', out.includes('Image Credits'), false);
  check('drops "July" (month)', out.includes('July'), false);
  check('drops "Tuesday" (day)', out.includes('Tuesday'), false);
  check('drops "According" (stopword)', out.includes('According'), false);
  check('drops "If Muscat" (leading fragment)', out.includes('If Muscat'), false);
  check('drops "Officials" (leading generic)', out.includes('Officials'), false);
  check('drops "YouTube" (social)', out.includes('YouTube'), false);
  check('keeps "Onego Otra" (ship)', out.includes('Onego Otra'), true);
  check('keeps "Dmitry Peskov" (person)', out.includes('Dmitry Peskov'), true);
  check('every surviving term is proper-noun/acronym', out.every(isProperNounOrAcronym), true);
}

console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
