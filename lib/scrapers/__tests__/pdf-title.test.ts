// Regression tests for PDF headline selection.
//
// Every case here is a REAL failure that reached production, kept so the same
// bug cannot return quietly. Run: npx tsx lib/scrapers/__tests__/pdf-title.test.ts
import { isUsableTitle, pickPdfTitle, titleFromUrl } from '../pdf-title';
import { recoverPdfTitle } from '../pdf-title-recover';

let pass = 0;
const failures: string[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { pass++; return; }
  failures.push(`  ${name}\n     beklenen: ${JSON.stringify(expected)}\n     gelen   : ${JSON.stringify(actual)}`);
}
function checkThat(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; return; }
  failures.push(`  ${name}\n     ${detail}`);
}

// --- isUsableTitle: template names and page furniture -----------------------
// PDF Title fields inherited from the design file (2,549 rows carried these).
for (const junk of [
  'May 4, 2007', 'master template', 'Layout 1', 'abc', 'Dec 2020', '23 November 2011',
  'Britannia steamship.qxd', 'Microsoft Word - 5429.doc', 'Download pdf', 'PDF', '2026',
  'untitled', 'TELEFAX', 'RiskAlertTemplate.docx',
]) check(`reddedilmeli: "${junk}"`, isUsableTitle(junk), false);

// Crew Watch running headers — these pass every other test, hence their own rule.
for (const header of [
  'CREW WATCH | 7 CREW WATCH A thorough risk assessme',
  '8 | CREW WATCH CREW WATCH JOBIN MATHEW, ASSISTANT',
  '12 | CREW WATCHCREW WATCH | 13 CREW WATCH These ta',
]) check(`sayfa ustbilgisi reddedilmeli: "${header.slice(0, 28)}…"`, isUsableTitle(header), false);

// Real headlines must survive.
for (const good of [
  'CREW WATCH – JUNE 2026 – JAPANESE',
  "Circular No. 16/26 - The American Club's Annual Meeting of the Members",
  'RISK WATCH – MARCH 2026',
  'PROTECTION & INDEMNITY WAR RISKS CLAUSE',
  'DURING RO-RO CARGO LOADING OPERATIONS, A CREW MEMBER WAS INJURED',
]) check(`kabul edilmeli: "${good.slice(0, 34)}…"`, isUsableTitle(good), true);

// --- pickPdfTitle: anchor beats metadata, junk falls through ----------------
check('junk metadata + iyi link -> link',
  pickPdfTitle('master template', 'CREW WATCH – JUNE 2026', null), 'CREW WATCH – JUNE 2026');
check('iyi metadata + junk link -> metadata',
  pickPdfTitle("Circular No. 16/26 - The American Club's Annual Meeting", 'Download pdf', null),
  "Circular No. 16/26 - The American Club's Annual Meeting");
check('ikisi de junk, govde yok -> null',
  pickPdfTitle('Layout 1', 'Download pdf', null), null);
checkThat('ikisi de junk, govde var -> govdeden',
  (pickPdfTitle('November 2008', 'Download pdf',
    'A thorough risk assessment must be carried out before any enclosed space entry.') ?? '').startsWith('A thorough risk assessment'),
  'govdenin ilk cumlesine dusmeliydi');

// --- recoverPdfTitle: the "subject to" trap --------------------------------
// `/SUBJECT\s*:?/` (optional colon) matched the ordinary phrase "subject to",
// producing headlines like "to annual variations in the surcharge rates".
const subjectToTrap = 'The rates set out in this circular are subject to annual variations in the surcharge rates applied by terminals, and members should budget accordingly for the coming policy year.';
checkThat('"subject to" konu etiketi sanilmamali',
  (recoverPdfTitle(subjectToTrap, 'Gard') ?? { title: '' }).title.startsWith('to ') === false,
  `gelen: ${JSON.stringify(recoverPdfTitle(subjectToTrap, 'Gard')?.title)}`);

// --- recoverPdfTitle: per-source parsers -----------------------------------
const panama = 'Panama Canal Authority Vice Presidency for Operations Advisory To Shipping No. A-16-2026 May 18, 2026 TO: All Shipping Agents, Owners, and Operators SUBJECT: Update to Notice to Shipping N-7 Auction Process Information The Panama Canal Authority hereby informs its customers.';
check('panama: advisory no + konu',
  recoverPdfTitle(panama, 'Panama Canal Authority')?.title,
  'Advisory A-16-2026: Update to Notice to Shipping N-7 Auction Process Information');

const american = "JANUARY 8, 2009 CIRCULAR NO. 01/09 TO MEMBERS OF THE ASSOCIATION Dear Member: COPING WITH ECONOMIC TURMOIL: AMERICAN CLUB'S IMPROVED INVESTMENT RESULTS AT YEAR-END 2008 The Club is pleased to report.";
check('american: circular no + buyuk harf blogu',
  recoverPdfTitle(american, 'American P&I Club')?.title,
  "Circular 01/09: COPING WITH ECONOMIC TURMOIL: AMERICAN CLUB'S IMPROVED INVESTMENT RESULTS AT YEAR-END 2008");

const london = "The London P&I Club is the trading name of The London Steam-Ship Owners' Mutual Insurance Association Limited. Dear Sirs CLASS 5 PROTECTING & INDEMNITY ADVANCE, SUPPLEMENTARY AND RELEASE CALLS. At its meeting on 8 November the Board considered the position of the open policy years.";
check('london: konu satiri, mektup govdesine tasmamali',
  recoverPdfTitle(london, 'London P&I Club')?.title,
  'CLASS 5 PROTECTING & INDEMNITY ADVANCE, SUPPLEMENTARY AND RELEASE CALLS');

// --- finalize: length and word boundaries ----------------------------------
const longDirective = 'JULY 10, 2009 CIRCULAR NO. 19/09 TO MEMBERS OF THE ASSOCIATION Dear Member: DIRECTIVE 2004/35/CE OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL OF APRIL 21, 2004 ON ENVIRONMENTAL LIABILITY WITH REGARD TO THE PREVENTION AND REMEDYING OF ENVIRONMENTAL DAMAGE Members are reminded.';
const cut = recoverPdfTitle(longDirective, 'American P&I Club')?.title ?? '';
checkThat('110 karakteri asmamali', cut.length <= 110, `uzunluk=${cut.length}`);
checkThat('kelime ortasinda kesilmemeli', !/\s\S{1,2}$/.test(cut) || cut.endsWith('ON'), `son: "${cut.slice(-24)}"`);
checkThat('circular no korunmali', cut.startsWith('Circular 19/09:'), `gelen: "${cut.slice(0, 30)}"`);

// --- titleFromUrl: the publisher's own file name --------------------------
// Britannia's Crew Watch articles are SEPARATE PDFs whose text opens with the
// magazine running header. Before this source existed, the first case below was
// dropped outright and the second published its page furniture as a headline.
check('dosya adindan baslik',
  titleFromUrl('https://britanniapandi.com/wp-content/uploads/2026/07/Preventing-falls-from-hatch-cover-edges.pdf'),
  'Preventing falls from hatch cover edges');
check('iki kelimelik dosya adi kabul (dosya adi zaten spesifik)',
  titleFromUrl('https://britanniapandi.com/wp-content/uploads/2026/07/Lifeboat-safety.pdf'),
  'Lifeboat safety');
check('kodlu dosya adi reddedilmeli',
  titleFromUrl('https://www.american-club.com/files/files/cir_16_26.pdf'), null);
check('sayisal dosya adi reddedilmeli',
  titleFromUrl('https://www.londonpandi.com/files/5429.PDF'), null);
check('tek kelime reddedilmeli',
  titleFromUrl('https://example.com/files/circulars.pdf'), null);
check('url olmayan girdi -> null', titleFromUrl('not a url'), null);

// --- nothing trustworthy -> null, never invented ---------------------------
check('kurtarilamayan govde -> null', recoverPdfTitle('12 | CREW WATCH CREW WATCH | 13', 'Britannia P&I'), null);
check('cok kisa govde -> null', recoverPdfTitle('kisa', 'Gard'), null);

console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
