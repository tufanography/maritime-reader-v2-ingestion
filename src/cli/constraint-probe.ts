// Probe DB CHECK constraints + actual distinct values in use, for every
// enum-shaped column ScrapedArticle writes to. Catches the drift class
// where the COLUMN exists but the value the scraper produces is outside
// the constraint's allowed set (attempt #2 failure on
// published_at_source: granular 'rss_pubdate' vs DB-allowed 'original').

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const COLS_TO_PROBE = [
  'published_at_source',
  'published_at_confidence',
  'content_quality',
];

async function probeColumn(col: string) {
  // Get distinct values in use + counts
  const { data, error } = await sb
    .from('articles')
    .select(col)
    .not(col, 'is', null)
    .limit(5000);
  if (error) {
    console.log(`  ✗ ${col}: ${error.message}`);
    return;
  }
  const counts = new Map<string, number>();
  const rows = (data ?? []) as unknown as Record<string, string>[];
  for (const r of rows) {
    const v = r[col];
    if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  console.log(`  ${col}:`);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [v, c] of sorted) console.log(`    "${v}"   (${c} rows)`);
}

async function main() {
  console.log('═══ Distinct values per enum column (sample 5k rows) ═══\n');
  for (const c of COLS_TO_PROBE) await probeColumn(c);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
