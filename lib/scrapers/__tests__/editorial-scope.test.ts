// Publishing-policy check for general news outlets. Titles are real ones taken
// from the last two weeks of articles.
// Run: npx tsx lib/scrapers/__tests__/editorial-scope.test.ts
import { outOfEditorialScope } from '../moderation';

let pass = 0;
const failures: string[] = [];
const check = (title: string, expected: string | null, excerpt = '') => {
  const got = outOfEditorialScope(title, excerpt);
  if (got === expected) { pass++; return; }
  failures.push(`  ${title}\n     beklenen: ${expected}\n     gelen   : ${got}`);
};

// ── routine company items: hidden ───────────────────────────────────────────
check('DNV Appoints New Head of Miami Cruise Center', 'personnel');
check('Sea Machines Names Courtney Bradbury VP of Program Management', 'personnel');
check('HII promotes Greg Ennis to CFO at Mission Technologies', 'personnel');
check('ZIM adds Houston to VEL service', 'liner-service');
check('T.S. Lines reshuffles JTK and JTK2 services', 'liner-service');
check('ONE launches weekly Poland-Egypt service', 'liner-service');
check('Malin Group Receives Silver Award in Defence Employer Recognition Scheme', 'award');
check('Everllence Marks 50 Years of HHI-EMD as Two-Stroke Licensee', 'anniversary');
check('Hapag-Lloyd opens new office in Namibia', 'promo');
check('Island Oil rebrands as Island Energies to reflect broader energy focus', 'promo');

// ── a change at the top is not a minor appointment: stays ───────────────────
check('SOHAR Port and Freezone appoints new CEO', null);
check('Maersk names new chairman', null);
check('Port of Rotterdam appoints president', null);
check('Acme Marine names Jane Doe vice president of sales', 'personnel');

// ── in-scope signal always wins, in title or excerpt ────────────────────────
check('MSC suspends Red Sea service after Houthi attack', null);
check('Maersk adds port calls as strike closes Antwerp terminals', null);
check('ONE revises service rotation amid Panama Canal draft restrictions', null);
check('Port authority appoints director after fatal crane accident', null);
check('CMA CGM launches new service', null, 'The rotation avoids Suez because of continued attacks on merchant ships.');
check('Class society appoints head of detention review', null);
check('Singapore Ship Registry Marks 60 Years, Plans Digital Upgrade', null);
check('Shipowner wins award in demurrage arbitration', null);
check('ONE revises Red Sea service coverage', null);   // trade-route security, not a routine rotation

// ── ordinary in-scope news is never touched ─────────────────────────────────
for (const t of [
  'Bulk carrier runs aground off Mauritius',
  'Paris MoU detains tanker over ISM deficiencies',
  'Container ship loses 40 boxes in North Pacific storm',
  'Seafarers abandoned on tanker off UAE for nine months',
  'Capesize rates jump as Chinese iron ore buying returns',
  'Shipowner orders six LNG dual-fuel VLCCs at Hanwha',
  'Tanker market weekly report',
]) check(t, null);

console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
