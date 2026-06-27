// Add PROVEN-clean coverage sections to existing sources' scraper_config.
// DRY-RUN by default (prints OLD vs NEW jobs, no write). Set APPLY=1 to write,
// then it re-reads each source to verify. Only the 5 sections proven end-to-end
// (fetch + date + readable body + quality-gate + tags) are included here.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const APPLY = process.env.APPLY === '1';

// name -> { addJobs?: append to scraper_config.jobs, addGroup?: append a new job_group }
// BATCH 2 (2026-06-27). Batch 1 (UK P&I news/safety, Skuld topics, West
// notice-to-members, Steamship info-notices) already APPLIED — do NOT re-add or
// it duplicates jobs. This batch: Japan P&I English news (the chronic-reject was
// a selector bug, NOT a login wall — `a[href*="/en/news/"]` extracts 5/6 clean)
// and UK P&I press-releases (static, distinct from news/circulars).
const PLAN: Record<string, { addJobs?: any[]; addGroup?: any[]; addToGroup?: { index: number; jobs: any[] } }> = {
  'Japan P&I Club': {
    addJobs: [
      { list_url: 'https://www.piclub.or.jp/en/topics/news', item_selector: 'a[href*="/en/news/"]' },
    ],
  },
  'UK P&I Club': {
    addJobs: [
      { list_url: 'https://www.ukpandi.com/news-and-resources/press-releases/' },
    ],
  },
};

const jobUrls = (cfg: any): string[] => {
  const out: string[] = [];
  for (const j of cfg?.jobs ?? []) out.push(j.list_url || j.sitemap_url || JSON.stringify(j).slice(0, 50));
  (cfg?.job_groups ?? []).forEach((g: any[], i: number) => g.forEach((j) => out.push(`grp${i}:${j.list_url || j.sitemap_url}`)));
  return out;
};

for (const [name, plan] of Object.entries(PLAN)) {
  const { data: rows } = await sb.from('sources').select('id,name,scraper_config').eq('name', name);
  const src = rows?.[0];
  if (!src) { console.log(`\n❌ ${name}: NOT FOUND`); continue; }
  const cfg = JSON.parse(JSON.stringify(src.scraper_config || {}));
  console.log(`\n■ ${name}`);
  console.log(`  OLD (${jobUrls(cfg).length}): ${jobUrls(cfg).join('  |  ')}`);

  if (plan.addJobs) {
    cfg.jobs = [...(cfg.jobs ?? []), ...plan.addJobs];
  }
  if (plan.addGroup) {
    if (!Array.isArray(cfg.job_groups)) { console.log('  ⚠ no job_groups array — SKIP, manual review'); continue; }
    cfg.job_groups = [...cfg.job_groups, plan.addGroup];
  }
  if (plan.addToGroup) {
    if (!Array.isArray(cfg.job_groups) || !cfg.job_groups[plan.addToGroup.index]) { console.log(`  ⚠ group ${plan.addToGroup.index} missing — SKIP`); continue; }
    cfg.job_groups = cfg.job_groups.map((g: any[], i: number) => i === plan.addToGroup!.index ? [...g, ...plan.addToGroup!.jobs] : g);
  }
  const added = plan.addJobs ?? plan.addGroup ?? plan.addToGroup?.jobs ?? [];
  console.log(`  + ADD${plan.addToGroup ? ` (into grp${plan.addToGroup.index})` : ''}: ${added.map((j: any) => j.list_url + (j.item_selector ? ` [sel]` : '')).join('  |  ')}`);
  console.log(`  NEW (${jobUrls(cfg).length}): ${jobUrls(cfg).join('  |  ')}`);
  if (Array.isArray(cfg.job_groups)) console.log(`  rotation: ${cfg.job_groups.length} groups (unchanged → freshness preserved)`);

  if (APPLY) {
    const { error } = await sb.from('sources').update({ scraper_config: cfg }).eq('id', src.id);
    if (error) { console.log(`  ❌ WRITE FAILED: ${error.message}`); continue; }
    const { data: chk } = await sb.from('sources').select('scraper_config').eq('id', src.id);
    console.log(`  ✅ WROTE. verify NEW (${jobUrls(chk?.[0]?.scraper_config).length}): ${jobUrls(chk?.[0]?.scraper_config).join('  |  ')}`);
  }
}
console.log(APPLY ? '\n=== APPLIED ===' : '\n=== DRY-RUN (set APPLY=1 to write) ===');
