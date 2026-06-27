// Retro-fix segments to the new rules (dry_bulk ore/liquefaction additions +
// 400c lede narrowing). DRY-RUN by default (counts + OLD→NEW samples, no write).
// APPLY=1 writes changed rows. Keyset-paginated for Nano. Independent post-verify
// re-reads a sample after APPLY.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { deriveSegments } from '../lib/v3/segments';

const sb = createClient(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.env.APPLY === '1';

const cats = new Map<string, string>(((await sb.from('categories').select('id,slug')).data ?? []).map((c: any) => [c.id, c.slug]));
const srcs = new Map<string, string>(((await sb.from('sources').select('id,name')).data ?? []).map((s: any) => [s.id, s.name]));

const eq = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

let lastId = '00000000-0000-0000-0000-000000000000';
let scanned = 0, segmented = 0, changed = 0, written = 0;
const dropped: Record<string, number> = {}, added: Record<string, number> = {};
const samples: string[] = [];
const changedIds: string[] = [];

for (;;) {
  const { data, error } = await sb.from('articles')
    .select('id,title,raw_excerpt,category_id,source_id,segments')
    .gt('id', lastId).order('id', { ascending: true }).limit(1000);
  if (error) { console.error('page error', error.message); break; }
  if (!data || data.length === 0) break;
  lastId = data[data.length - 1].id;
  for (const a of data) {
    scanned++;
    const old: string[] = Array.isArray(a.segments) ? a.segments : [];
    if (!old.length) continue;            // only rows that currently HAVE segments can change-by-drop
    segmented++;
    const recomputed = deriveSegments({ categorySlug: a.category_id ? cats.get(a.category_id) ?? null : null, title: a.title || '', excerpt: a.raw_excerpt || '', sourceName: srcs.get(a.source_id) ?? null });
    // DROP-ONLY: keep only the old segments the current rules still confirm; never
    // ADD a segment (avoids the risky adds the full-retro dry-run surfaced).
    const next = old.filter((s: string) => recomputed.includes(s as any));
    if (eq(old, next)) continue;
    changed++;
    changedIds.push(a.id);
    for (const s of old) if (!next.includes(s as any)) dropped[s] = (dropped[s] || 0) + 1;
    if (samples.length < 12) samples.push(`   [${old.join(',') || '—'}] → [${next.join(',') || '—'}]  "${(a.title || '').slice(0, 50)}"`);
    if (APPLY) { const { error: e } = await sb.from('articles').update({ segments: next }).eq('id', a.id); if (!e) written++; }
  }
  process.stdout.write(`\r  scanned ${scanned}  segmented ${segmented}  changed ${changed}${APPLY ? `  written ${written}` : ''}   `);
}
console.log('\n\n=== SAMPLES (OLD → NEW) ===');
samples.forEach((s) => console.log(s));
console.log('\n=== DROPPED (segment removed from N rows) ===', JSON.stringify(dropped));
console.log('=== ADDED   (segment added to N rows)   ===', JSON.stringify(added));
console.log(`\nTotals: scanned ${scanned} · had-segments ${segmented} · would-change ${changed}${APPLY ? ` · WRITTEN ${written}` : ''}`);

if (APPLY && changedIds.length) {
  // independent post-verify: re-read 5 changed rows and recompute-compare
  let okv = 0; const probe = changedIds.slice(0, 5);
  for (const id of probe) {
    const { data } = await sb.from('articles').select('title,raw_excerpt,category_id,source_id,segments').eq('id', id).single();
    const recomp = deriveSegments({ categorySlug: data!.category_id ? cats.get(data!.category_id) ?? null : null, title: data!.title || '', excerpt: data!.raw_excerpt || '', sourceName: srcs.get(data!.source_id) ?? null });
    // drop-only invariant: every stored segment must still be confirmed by recompute
    if ((data!.segments || []).every((s: string) => recomp.includes(s as any))) okv++;
  }
  console.log(`post-verify: ${okv}/${probe.length} re-read rows match recompute`);
}
console.log(APPLY ? '\n=== APPLIED ===' : '\n=== DRY-RUN (set APPLY=1 to write) ===');
