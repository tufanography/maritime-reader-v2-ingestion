// Independent check for migration 040: are content_terms / text_source / gate_reason
// present on articles? Run BEFORE apply (expect absent) and AFTER (expect present).
//   node scripts/verify-content-terms-columns.mjs
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
readFileSync('.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim(); });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
for (const col of ['content_terms', 'text_source', 'gate_reason']) {
  const { error } = await sb.from('articles').select(col).limit(1);
  console.log(`  ${col}: ${error ? 'ABSENT (' + error.message.slice(0, 60) + ')' : 'PRESENT'}`);
}
