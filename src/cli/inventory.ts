// One-shot source-distribution inventory. Read-only. Answers:
// how many enabled sources use RSS vs sitemap vs HTML-listing
// vs other? This decides the POC source order in Phase 2.1.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data, error } = await sb
    .from('sources')
    .select('name, type, feed_url, scraper_config, enabled, runner')
    .eq('enabled', true);
  if (error) throw new Error(error.message);
  const sources = data ?? [];

  let rss = 0,
    sitemap = 0,
    htmlListing = 0,
    multiJob = 0,
    listOnly = 0,
    unknown = 0;
  const samples: Record<string, string[]> = {
    rss: [],
    sitemap: [],
    htmlListing: [],
    multiJob: [],
    listOnly: [],
    unknown: [],
  };

  for (const s of sources) {
    const cfg = (s.scraper_config ?? {}) as Record<string, unknown>;
    let bucket: keyof typeof samples;
    if (s.feed_url) {
      bucket = 'rss';
      rss++;
    } else if (Array.isArray(cfg.jobs)) {
      bucket = 'multiJob';
      multiJob++;
    } else if (cfg.sitemap_url) {
      bucket = 'sitemap';
      sitemap++;
    } else if (cfg.list_only) {
      bucket = 'listOnly';
      listOnly++;
    } else if (cfg.list_url) {
      bucket = 'htmlListing';
      htmlListing++;
    } else {
      bucket = 'unknown';
      unknown++;
    }
    if (samples[bucket].length < 5) samples[bucket].push(s.name as string);
  }

  console.log(`Enabled sources: ${sources.length}\n`);
  console.log(`── Discovery method distribution ──`);
  const rows: [string, number, string[]][] = [
    ['rss (feed_url set)', rss, samples.rss],
    ['multi-job (jobs[])', multiJob, samples.multiJob],
    ['sitemap (sitemap_url)', sitemap, samples.sitemap],
    ['list_only', listOnly, samples.listOnly],
    ['html_listing (list_url)', htmlListing, samples.htmlListing],
    ['unknown', unknown, samples.unknown],
  ];
  for (const [label, count, sample] of rows) {
    const pct = sources.length > 0 ? Math.round((count / sources.length) * 100) : 0;
    console.log(`  ${label.padEnd(28)} ${String(count).padStart(3)} (${pct}%)`);
    if (count > 0) {
      console.log(`     samples: ${sample.join(', ')}`);
    }
  }

  console.log(`\n── Verdict for Phase 2.1 POC ──`);
  const sitemapTotal = sitemap + multiJob;
  if (rss > sitemapTotal + htmlListing) {
    console.log(`  RSS dominant (${rss} / ${sources.length}) → POC with a real RSS source.`);
  } else if (sitemapTotal > rss) {
    console.log(
      `  Sitemap/multi-job dominant (${sitemapTotal} / ${sources.length} sitemap-shaped vs ${rss} RSS) → POC with sitemap discovery (e.g. Hellenic).`,
    );
  } else {
    console.log(`  Mixed. POC pattern preference is a wash; go by simplicity of first chosen source.`);
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
