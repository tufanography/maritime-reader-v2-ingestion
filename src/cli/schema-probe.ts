// One-shot DB schema probe. Pulls the column list of the `articles`
// table by selecting an existing row and inspecting its keys. Then
// compares against ScrapedArticle field names to find ALL drift (D8:
// fix the same class of bug in every place at once).

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const SCRAPED_ARTICLE_FIELDS = [
  'source_id',
  'title',
  'url',
  'url_hash',
  'raw_excerpt',
  'published_at',
  'published_at_source',
  'published_at_confidence',
  'image_url',
  'is_pdf',
  'is_broken',
];

async function main() {
  // Pull one existing row to see actual columns
  const { data, error } = await sb.from('articles').select('*').limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('articles table empty?');

  const dbCols = Object.keys(data).sort();
  console.log(`Actual articles table columns (${dbCols.length}):`);
  for (const c of dbCols) console.log(`  ${c}`);

  console.log(`\nScrapedArticle fields we try to write (${SCRAPED_ARTICLE_FIELDS.length}):`);
  for (const f of SCRAPED_ARTICLE_FIELDS) {
    const exists = dbCols.includes(f);
    console.log(`  ${exists ? '✓' : '✗ MISSING'} ${f}`);
  }

  const drift = SCRAPED_ARTICLE_FIELDS.filter((f) => !dbCols.includes(f));
  console.log(`\nDrift: ${drift.length} field(s) in ScrapedArticle but NOT in DB:`);
  for (const d of drift) console.log(`  ✗ ${d}`);

  // What's in DB that we might want to populate?
  const interesting = dbCols.filter((c) =>
    /title|url|excerpt|publish|image|broken|pdf|source|hash|created/.test(c),
  );
  console.log(`\nDB columns that look ingestion-relevant (${interesting.length}):`);
  for (const c of interesting) console.log(`  ${c}`);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
