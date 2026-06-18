// One-shot probe of detail-fetch on a single URL. Diagnoses what date
// signals a source actually exposes.
//
// Usage:  npx tsx src/cli/detail-probe.ts <url>

import { fetchDetail } from '@/lib/extract/detail-fetch';

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: npx tsx src/cli/detail-probe.ts <url>');
    process.exit(2);
  }
  const r = await fetchDetail(url);
  console.log(`url:        ${url}`);
  console.log(`HTTP:       ${r.httpStatus}`);
  console.log(`ok:         ${r.ok}`);
  if (r.fetchError) console.log(`fetchError: ${r.fetchError}`);
  console.log(`Signals harvested:`);
  for (const [k, v] of Object.entries(r.signals)) {
    console.log(`  ${k.padEnd(28)} ${v ?? '(null)'}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
