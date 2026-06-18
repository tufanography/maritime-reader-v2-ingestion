// Phase 2.0 smoke test. Single SELECT through the service-role client
// to prove the key authenticates. NO write. Run with:
//   npx tsx src/cli/smoke.ts

import 'dotenv/config';
import { articleWriteRepo } from '@/lib/repository/SupabaseArticleWriteRepository';

async function main() {
  // eslint-disable-next-line no-console
  console.log('Smoke: resolving source_id for "Hellenic Shipping News"…');
  const id = await articleWriteRepo.resolveSourceId('Hellenic Shipping News');
  if (id) {
    // eslint-disable-next-line no-console
    console.log(`  ✓ auth OK. source_id = ${id}`);
    // eslint-disable-next-line no-console
    console.log('  → service-role key valid; read path through write client works.');
  } else {
    // eslint-disable-next-line no-console
    console.log('  ⚠ source not found (auth probably OK, just no row named "Hellenic Shipping News").');
    // eslint-disable-next-line no-console
    console.log('  → if no auth error was thrown above, the key still authenticates.');
  }
}

main().catch((err: Error) => {
  // eslint-disable-next-line no-console
  console.error('  ✗ FAILED:', err.message);
  process.exit(1);
});
