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
const PLAN: Record<string, { addJobs?: any[]; addGroup?: any[]; addToGroup?: { index: number; jobs: any[] } }> = {
  'UK P&I Club': {
    addJobs: [
      { list_url: 'https://www.ukpandi.com/news-and-resources/news/' },
      { list_url: 'https://www.ukpandi.com/news-and-resources/safety-advice-training/' },
    ],
  },
  'Skuld': {
    addJobs: [
      { list_url: 'https://www.skuld.com/topics/', item_selector: 'a[href*="/topics/"][href*="/20"], a[href*="/cargo/"], a[href*="/safety/"]' },
    ],
  },
  // Add to an EXISTING group (not a new one) so the rotation length — and thus
  // per-section freshness — does NOT degrade. West circulars join grp0 (news);
  // Steamship info-notices join grp2 (loss-prevention/circulars).
  'West of England': {
    addToGroup: { index: 0, jobs: [{ list_url: 'https://www.westpandi.com/news-and-resources/notice-to-members', item_selector: 'a[href*="/notice-to-members/"]' }] },
  },
  'Steamship Mutual': {
    addToGroup: { index: 2, jobs: [{ list_url: 'https://www.steamshipmutual.com/information-notices' }] },
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
