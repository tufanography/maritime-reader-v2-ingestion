// Orchestrates a scrape run for one source: fetch → dedupe → AI summarize → insert.
// Designed to be called from API route handlers (manual or cron).
import { createServiceClient } from '../supabase/server';
import { summarizeAndCategorize } from '../ai/claude';
import { categorizeByRules, extractSummary } from '../ai/rules';
import type { Source, Category } from '../supabase/types';
import { fetchRss, fetchWpRest, type RawArticle } from './rss';
import { fetchHtmlSource, FetchError, type HtmlScraperConfig } from './html';
import { hashUrl, sleep } from './util';
import { looksLikeArticle } from './quality';
import { moderate } from './moderation';
import { resolveFallbackDate } from './date-fallback';
import { extractTagIds } from '../tagging/extract';
import { extractKeywords } from '../tagging/keywords';
import { deriveDocumentType } from '../v3/document-type';
import { deriveSegments } from '../v3/segments';

const USE_AI = !!process.env.ANTHROPIC_API_KEY;

export type ScrapeResult = {
  source_id: string;
  source_name: string;
  status: 'success' | 'error' | 'blocked' | 'partial';
  found: number;
  inserted: number;
  error?: string;
};

/** Pick the active job set for a source. When the config defines
 *  `job_groups`, only one group runs per tick — the orchestrator
 *  advances `sources.last_group_index` after, so each group's URLs
 *  get scraped every Nth tick instead of every tick. Heavy sources
 *  (Steamship Mutual's 8 list_urls + PDFs) would otherwise blow past
 *  the 3-minute per-source timeout; partitioning trades discovery
 *  latency for reliability. Sources without `job_groups` are
 *  unaffected. Returns a flat config compatible with fetchHtmlSource:
 *  the selected group's contents become `jobs`. */
function selectActiveConfig(source: Source): HtmlScraperConfig {
  const config = (source.scraper_config ?? {}) as HtmlScraperConfig;
  const groups = config.job_groups;
  if (!groups || groups.length === 0) return config;

  const i = ((source.last_group_index ?? 0) % groups.length + groups.length) % groups.length;
  const active = groups[i];
  console.log(
    `job_groups: ${source.name} running group ${i + 1}/${groups.length} ` +
    `(${active.length} job${active.length === 1 ? '' : 's'})`,
  );
  // Re-emit as a flat config: keep top-level fields (rss_feeds,
  // require_date, etc.), but replace jobs/list_url/sitemap_url with
  // the selected group. The {...config, jobs: active} spread keeps
  // top-level fields the multi-job branch in html.ts doesn't read.
  return { ...config, jobs: active, list_url: undefined, sitemap_url: undefined };
}

// Exported so the daily coverage audit (scripts/audit-coverage.ts) can reuse the
// EXACT production extraction (rss / html / sitemap / job_groups / requires_js)
// rather than re-implementing it — a re-implementation diverged and false-flagged
// healthy sitemap/RSS sources (Gard) as broken. Read-only; no insert side effects.
export async function fetchRaw(source: Source): Promise<RawArticle[]> {
  const rawCfg = (source.scraper_config ?? {}) as HtmlScraperConfig & { skip_og_image?: boolean; wp_rest_url?: string; wp_rest_per_page?: number };
  const all: RawArticle[] = [];

  if (source.type === 'rss') {
    if (!source.feed_url) throw new Error('rss source missing feed_url');
    all.push(...await fetchRss(source.feed_url, { skipOgImage: !!rawCfg.skip_og_image }));
  } else {
    // html / press_release
    const config = selectActiveConfig(source);
    const hasJob = !!config?.list_url || !!config?.sitemap_url || (config?.jobs && config.jobs.length > 0);
    const hasFeeds = !!rawCfg?.rss_feeds && rawCfg.rss_feeds.length > 0;
    if (!hasJob && !hasFeeds && !rawCfg.wp_rest_url) {
      throw new Error('html source missing scraper_config.list_url, sitemap_url, jobs, job_groups, rss_feeds, or wp_rest_url');
    }
    if (hasJob || hasFeeds) {
      const sb = createServiceClient();
      // Fetch ALL known url_hashes for this source, paginated. PostgREST enforces a
      // server-side max-rows=1000 cap (MEASURED 2026-06-09: even .limit(100000) still
      // returns only 1000), so a single select gave an INCOMPLETE knownUrls set for
      // sources with >1000 articles (NorthStandard 1959, West 1708, Britannia 1516, …)
      // → already-scraped URLs looked "new" → the scraper re-rendered up to max_items
      // of them (10s each via requires_js) → the 3-min per-source timeout. Page through
      // in 1000-row windows until a short page signals the end (~2-3 queries even for
      // the largest source).
      const knownUrls = new Set<string>();
      for (let from = 0; ; from += 1000) {
        const { data: page } = await sb.from('articles').select('url_hash').eq('source_id', source.id).range(from, from + 999);
        if (!page || page.length === 0) break;
        for (const r of page as { url_hash: string }[]) knownUrls.add(r.url_hash);
        if (page.length < 1000) break;
      }
      if (hasJob) {
        all.push(...await fetchHtmlSource({ config, delayMs: source.request_delay_ms, knownUrls }));
      }
      // Supplemental RSS/Atom feeds — e.g. a publisher's YouTube channel alongside its
      // website news. Each feed is independent; one failure doesn't kill the html job.
      if (hasFeeds) {
        for (const feed of config.rss_feeds!) {
          try { all.push(...await fetchRss(feed, { skipOgImage: true })); }
          catch (e) { console.error(`supplemental feed failed for ${source.name}: ${feed} — ${e instanceof Error ? e.message : String(e)}`); }
        }
      }
    }
  }

  // ADDITIVE WP REST path (any type) — a DYNAMIC, uncached second source that stays
  // fresh when a CDN hands the scraper a STALE cached RSS feed (Splash247, 2026-07-17).
  // Best-effort: an intermittent Cloudflare 403 must NOT kill the primary results, and
  // url_hash dedup downstream keeps the richer primary copy and only ADDS what the
  // stale feed missed. Configured per source via scraper_config.wp_rest_url.
  if (rawCfg.wp_rest_url) {
    try { all.push(...await fetchWpRest(rawCfg.wp_rest_url, { perPage: rawCfg.wp_rest_per_page })); }
    catch (e) { console.error(`WP REST failed for ${source.name}: ${rawCfg.wp_rest_url} — ${e instanceof Error ? e.message : String(e)}`); }
  }
  return all;
}

export async function scrapeSource(source: Source): Promise<ScrapeResult> {
  const sb = createServiceClient();

  const { data: logRow } = await sb
    .from('scrape_logs')
    .insert({ source_id: source.id, status: 'running' })
    .select('id')
    .single();
  const logId = logRow?.id as string | undefined;

  const finishLog = async (patch: Record<string, unknown>) => {
    if (!logId) return;
    await sb.from('scrape_logs').update({ ...patch, finished_at: new Date().toISOString() }).eq('id', logId);
  };

  let raws: RawArticle[];
  try {
    raws = await fetchRaw(source);
  } catch (err) {
    const blocked =
      err instanceof FetchError && (err.status === 403 || err.status === 429);
    const message = err instanceof Error ? err.message : String(err);
    const httpStatus = err instanceof FetchError ? err.status : null;
    await finishLog({
      status: blocked ? 'blocked' : 'error',
      error_message: message,
      http_status: httpStatus,
    });
    await sb.from('sources').update({
      last_scraped_at: new Date().toISOString(),
      last_status: blocked ? 'blocked' : 'error',
      last_error: message,
      // Advance the rotation even on failure — otherwise one broken
      // group's URL would lock the whole source on that group forever.
      last_group_index: (source.last_group_index ?? 0) + 1,
    }).eq('id', source.id);
    return {
      source_id: source.id,
      source_name: source.name,
      status: blocked ? 'blocked' : 'error',
      found: 0,
      inserted: 0,
      error: message,
    };
  }

  // Dedupe against existing rows
  const hashes = raws.map((r) => ({ raw: r, hash: hashUrl(r.url) }));
  const allHashes = hashes.map((h) => h.hash);
  const { data: existing } = allHashes.length
    ? await sb.from('articles').select('url_hash').in('url_hash', allHashes)
    : { data: [] as { url_hash: string }[] };
  const existingSet = new Set((existing ?? []).map((e) => e.url_hash));
  const fresh = hashes.filter((h) => !existingSet.has(h.hash));

  // Categories lookup
  const { data: cats } = await sb.from('categories').select('id, slug');
  const catBySlug = new Map<string, string>((cats ?? []).map((c: Pick<Category, 'id' | 'slug'>) => [c.slug, c.id]));

  let inserted = 0;
  let aiErrors = 0;
  let rejected = 0;

  // require_date is now ON BY DEFAULT for every source. Articles whose
  // published_at couldn't be resolved float to the top under created_at
  // via effective_at and look like "just added" content even though
  // they're stale archive material (Caribbean MOU pre-2021 circulars,
  // Steamship Mutual layout-button "Press Release" rows, etc.). To keep
  // a specific source publishing dateless rows (e.g. for backfill of a
  // genuinely undated archive) set `require_date: false` in its config
  // — undefined / true both mean "must have a date".
  const requireDate = (source.scraper_config as { require_date?: boolean } | null)?.require_date !== false;

  for (const { raw, hash } of fresh) {
    // Quality gate: reject CTA / aggregator / nav-landing pages before they
    // get inserted. The scraper's CSS selectors capture too much on some
    // sources (ABS "Rules and Guides", LR "Stay alert" sign-up, etc.).
    const verdict = looksLikeArticle({ title: raw.title, excerpt: raw.excerpt, url: raw.url });
    if (!verdict.ok) {
      rejected++;
      continue;
    }
    if (!raw.published_at) {
      // Dateless content. Sources that opt in (scraper_config.date_fallback) get
      // an INFERRED date instead of being dropped — many P&I circulars/press
      // releases carry no date at all (or only a month+year), so the date gate
      // was silently rejecting all of them (Gard 120/run, Steamship, American).
      // resolveFallbackDate: past month → its last day; current month / no month
      // → capture time. Marked published_at_source='scraper_default' + confidence
      // 'low' — the date is INFERRED (day unknown), so the SITE keeps these out of
      // the freshness-ordered feed while still indexing them for search/archive.
      // ('scraper_default' is the inferred-date marker: it's an allowed CHECK value
      // — 'inferred' is NOT and would 400 the insert — and only 6 legacy rows carry
      // it, so the feed exclusion is effectively dedicated to these.) looksLikeArticle
      // already ran above, so nav/CTA pages don't reach here — VERIFY the inserted
      // scraper_default rows are real articles before wiring the site side.
      const useFallback = (source.scraper_config as { date_fallback?: boolean } | null)?.date_fallback === true;
      if (useFallback) {
        // TITLE ONLY for the month-year scan, NOT the body: circular/press-release
        // bodies routinely CITE other dates ("the Jan 2020 MARPOL amendments…",
        // "following the May 2021 incident") and YouTube excerpts leak unrelated
        // article titles — the first-match would back-date a brand-new item by
        // years. The title is the publish context and rarely cites a foreign date.
        const fb = resolveFallbackDate(raw.title ?? '', new Date().toISOString());
        if (!fb) {
          // No month+year anywhere → we have zero date signal. Do NOT stamp it
          // with "today" (the old behaviour that surfaced dateless decades-old
          // circulars as fresh). Drop it instead — honest over complete.
          rejected++;
          continue;
        }
        raw.published_at = fb.iso;
        raw.published_at_source = 'scraper_default';
        raw.published_at_confidence = 'low';
      } else if (requireDate) {
        rejected++;
        continue;
      }
    }

    let summary = extractSummary(raw.excerpt);
    let categorySlug: string;
    let confidence: number;
    let aiOk = false;

    if (USE_AI) {
      try {
        const ai = await summarizeAndCategorize({
          title: raw.title,
          excerpt: raw.excerpt,
          hint: source.category_hint,
        });
        summary = ai.summary;
        categorySlug = source.category_hint && ai.confidence < 0.6 ? source.category_hint : ai.category;
        confidence = ai.confidence;
        aiOk = true;
      } catch {
        aiErrors++;
        const r = categorizeByRules({ title: raw.title, excerpt: raw.excerpt, hint: source.category_hint });
        categorySlug = r.category;
        confidence = r.confidence;
      }
    } else {
      const r = categorizeByRules({ title: raw.title, excerpt: raw.excerpt, hint: source.category_hint });
      categorySlug = r.category;
      confidence = r.confidence;
    }

    const categoryId = catBySlug.get(categorySlug) ?? catBySlug.get('general') ?? null;

    // V3: derive document_type and segments at insert time so new articles
    // are immediately ready for the V3 home page queries.
    const documentType = deriveDocumentType({
      sourceCategoryHint: source.category_hint,
      sourceName: source.name,
      categorySlug,
      title: raw.title,
      excerpt: raw.excerpt,
    });
    const segments = deriveSegments({
      categorySlug,
      title: raw.title,
      excerpt: raw.excerpt,
      sourceName: source.name,
    });

    const keywords = extractKeywords({ title: raw.title, excerpt: raw.excerpt }, 5);

    // Quality gating happens in TWO layers, not one:
    //
    //   1) Moderation (fast, inline) — moderate() runs a regex
    //      heuristic to catch obvious spam: gaming guides, divorce
    //      lifestyle posts, luxury-car rentals, generic SEO. If it
    //      fires, we set content_quality='hidden' which keeps
    //      the article out of public views permanently.
    //
    //   2) Source trust (only if moderation passed) —
    //        trusted    → 'visible', visible immediately
    //        aggregator → 'pending', also visible (post migration
    //                     035), but semantic AI review hasn't run
    //                     yet so segments + themes are empty
    //
    // The split matters: breaking news from Container News must
    // surface within minutes, not wait hours for async AI tagging.
    // The heuristic stops only the loud spam; everything subtler
    // gets refined later when AI semantic review reads the body.
    const modVerdict = moderate(raw.title, raw.excerpt);
    let contentQuality: 'visible' | 'pending' | 'hidden';
    if (modVerdict.decision === 'hide') {
      contentQuality = 'hidden';
    } else if (source.trust_level === 'aggregator') {
      contentQuality = 'pending';
    } else {
      contentQuality = 'visible';
    }

    // Date provenance: scrapers that resolved a date populate
    // raw.published_at_source / _confidence directly (RSS pubDate,
    // html.ts best-of cascade, ABS list_only cards). When the scraper
    // didn't tag provenance (older code paths or no date resolved at
    // all), fall back to scraper_default/low — 'unknown' is reserved
    // for pre-migration legacy rows and should never be re-introduced
    // by a fresh insert.
    const dateSource = raw.published_at_source ?? 'scraper_default';
    const dateConfidence = raw.published_at_confidence ?? 'low';

    const { data: insertedRow, error: insertErr } = await sb.from('articles').insert({
      source_id: source.id,
      category_id: categoryId,
      title: raw.title,
      url: raw.url,
      url_hash: hash,
      author: raw.author,
      published_at: raw.published_at,
      published_at_source: dateSource,
      published_at_confidence: dateConfidence,
      raw_excerpt: raw.excerpt.slice(0, 4000),
      summary,
      ai_categorized: aiOk,
      ai_confidence: confidence,
      image_url: raw.image_url,
      document_type: documentType,
      segments,
      keywords,
      content_quality: contentQuality,
    }).select('id').single();
    if (!insertErr && insertedRow) {
      inserted++;
      // Tag the new article. Failures here are non-fatal.
      try {
        const tagIds = await extractTagIds({ sb, title: raw.title, excerpt: raw.excerpt, url: raw.url });
        if (tagIds.length > 0) {
          await sb.from('article_tags').insert(
            tagIds.map((tag_id) => ({ article_id: insertedRow.id, tag_id })),
          );
          // Refresh counts (best-effort)
          for (const tag_id of tagIds) {
            sb.rpc('refresh_tag_count', { tag_uuid: tag_id }).then(() => {});
          }
        }
      } catch {
        /* tagging failure shouldn't block article ingestion */
      }
    }

    if (USE_AI) await sleep(150);
  }

  const status: ScrapeResult['status'] = aiErrors > 0 && inserted > 0 ? 'partial' : 'success';
  const errorParts: string[] = [];
  if (aiErrors > 0) errorParts.push(`${aiErrors} ai failures`);
  if (rejected > 0) errorParts.push(`${rejected} rejected by quality filter`);
  await finishLog({
    status,
    articles_found: raws.length,
    articles_new: inserted,
    error_message: errorParts.length ? errorParts.join('; ') : null,
  });
  await sb.from('sources').update({
    last_scraped_at: new Date().toISOString(),
    last_status: status,
    last_error: null,
    last_group_index: (source.last_group_index ?? 0) + 1,
  }).eq('id', source.id);

  return {
    source_id: source.id,
    source_name: source.name,
    status,
    found: raws.length,
    inserted,
  };
}

/** Maximum runtime for a single scrape before we treat it as stuck.
 *  Vercel functions get killed at 60–300s depending on the plan, so any
 *  scrape_logs row sitting in `running` for >30 min is by definition a
 *  function that crashed without writing back. We mark those as
 *  bypassed at the start of the next cron run. */
const STUCK_SCRAPE_THRESHOLD_MS = 30 * 60_000;

type StuckScrape = { source_id: string; source_name: string; started_at: string };

/** Find scrape_logs stuck in `running` for too long, mark them as
 *  errored, and stamp their source's `last_scraped_at = NOW` so the
 *  cron doesn't keep re-picking the same broken source on every tick.
 *  Returns the affected rows so the caller can email the operator. */
async function detectStuckScrapes(): Promise<StuckScrape[]> {
  const sb = createServiceClient();
  const cutoff = new Date(Date.now() - STUCK_SCRAPE_THRESHOLD_MS).toISOString();
  const { data: stuckLogs } = await sb
    .from('scrape_logs')
    .select('id, source_id, started_at')
    .eq('status', 'running')
    .lt('started_at', cutoff);
  if (!stuckLogs || stuckLogs.length === 0) return [];

  const out: StuckScrape[] = [];
  const now = new Date().toISOString();
  for (const row of stuckLogs as { id: string; source_id: string; started_at: string }[]) {
    const { data: src } = await sb.from('sources').select('name').eq('id', row.source_id).maybeSingle();
    const name = (src as { name?: string } | null)?.name ?? row.source_id;

    await sb.from('scrape_logs').update({
      status: 'error',
      error_message: 'auto-bypass: scrape exceeded 30 min — likely Vercel function timeout',
      finished_at: now,
    }).eq('id', row.id);

    await sb.from('sources').update({
      last_scraped_at: now,
      last_status: 'blocked',
      last_error: 'auto-bypass: scrape repeatedly exceeded 30 min (function timeout)',
    }).eq('id', row.source_id);

    out.push({ source_id: row.source_id, source_name: name, started_at: row.started_at });
  }
  return out;
}

/** Email the operator about cron runs that had to be bypassed. Best-
 *  effort: silently no-ops when ALERT_EMAIL or RESEND_API_KEY isn't set. */
async function notifyStuckScrapes(stuck: StuckScrape[]): Promise<void> {
  const alertEmail = process.env.ALERT_EMAIL;
  if (!alertEmail || !process.env.RESEND_API_KEY || stuck.length === 0) return;
  try {
    const { getResend, FROM_ADDRESS } = await import('../email/resend');
    const lines = stuck.map((s) => {
      const minsAgo = Math.round((Date.now() - new Date(s.started_at).getTime()) / 60_000);
      return `- ${s.source_name}: started ${minsAgo} min ago, never finished`;
    });
    const html =
      `<p><strong>Maritime Reader — stuck cron auto-bypass</strong></p>` +
      `<p>${stuck.length} source${stuck.length === 1 ? '' : 's'} had a scrape running for >30 min and were auto-bypassed:</p>` +
      `<pre style="font:12px ui-monospace,monospace;background:#f5f5f5;padding:12px;border-radius:6px;">${lines.join('\n')}</pre>` +
      `<p>Most likely cause: the Vercel function timed out before scrapeSource could finish. Each affected source's <code>last_scraped_at</code> was stamped to NOW so cron skips it for one full interval. To recover, lower that source's <code>max_items</code> in <code>scraper_config</code>, or fix the underlying URL/selector. Recent <code>scrape_logs</code> rows show the trail.</p>` +
      `<p>Run at ${new Date().toISOString()}.</p>`;
    await getResend().emails.send({
      from: FROM_ADDRESS,
      to: alertEmail,
      subject: `Maritime Reader — ${stuck.length} stuck cron auto-bypassed`,
      html,
    });
  } catch (e) {
    console.error('stuck-cron alert send failed', e instanceof Error ? e.message : String(e));
  }
}

// Maximum time we'll wait for a single source's scrape to finish.
// Anything beyond this is almost certainly a stuck detail-page fetch
// or a runaway pagination loop; cutting it lets the orchestrator move
// on to the rest. The source's last_status gets stamped to 'error' so
// the next cron tick still picks it up after its normal interval.
const PER_SOURCE_TIMEOUT_MS = 3 * 60_000;

async function scrapeWithTimeout(source: Source): Promise<ScrapeResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<ScrapeResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        source_id: source.id,
        source_name: source.name,
        status: 'error',
        found: 0,
        inserted: 0,
        error: `per-source timeout after ${PER_SOURCE_TIMEOUT_MS / 60_000}m`,
      });
    }, PER_SOURCE_TIMEOUT_MS);
  });
  const result = await Promise.race([scrapeSource(source), timeoutPromise]);
  if (timer) clearTimeout(timer);

  // If the timeout fired, scrapeSource may still be running in the
  // background. Update sources + close the open scrape_logs row so the
  // stuck-detection sweeper doesn't keep flagging this on every run.
  if (result.status === 'error' && result.error?.startsWith('per-source timeout')) {
    const sb = createServiceClient();
    await sb.from('sources').update({
      last_status: 'error',
      last_error: result.error,
      last_scraped_at: new Date().toISOString(),
      // Advance the rotation: a group that timed out shouldn't repeat
      // forever; let the next cron tick try a different group.
      last_group_index: (source.last_group_index ?? 0) + 1,
    }).eq('id', source.id);
    await sb.from('scrape_logs').update({
      status: 'error',
      error_message: result.error,
      finished_at: new Date().toISOString(),
    }).eq('source_id', source.id).is('finished_at', null);
  }
  return result;
}

export async function scrapeAllDue(opts?: { force?: boolean; runner?: 'cloud' | 'local' }): Promise<ScrapeResult[]> {
  // Step 1 — clean up scrapes left half-running by previous cron ticks.
  // Without this any source whose scrape exceeds Vercel's function
  // timeout gets re-picked on every tick, blocking the rest forever.
  const stuck = await detectStuckScrapes();
  if (stuck.length > 0) {
    console.log(`Auto-bypassed ${stuck.length} stuck scrape(s):`, stuck.map((s) => s.source_name).join(', '));
    notifyStuckScrapes(stuck).catch((e) => console.error('email send failed', e));
  }

  const sb = createServiceClient();
  // Pull sources, optionally filtered by runner. Runner column was
  // added in migration 027; if it isn't there yet (fresh checkout)
  // we fall back to treating every source as cloud-eligible.
  let sources: Source[] = [];
  {
    let query = sb.from('sources').select('*').eq('enabled', true);
    if (opts?.runner) query = query.eq('runner', opts.runner);
    const { data, error } = await query;
    if (error) {
      if (error.code === '42703' || /runner/i.test(error.message)) {
        console.warn('runner column missing — selecting all sources. Apply migration 027 to enable hybrid mode.');
        const fallback = await sb.from('sources').select('*').eq('enabled', true);
        sources = (fallback.data ?? []) as Source[];
      } else {
        throw error;
      }
    } else {
      sources = (data ?? []) as Source[];
    }
  }
  if (sources.length === 0) return [];

  const now = Date.now();
  const due = sources.filter((s) => {
    if (opts?.force) return true;
    if (!s.last_scraped_at) return true;
    const last = new Date(s.last_scraped_at).getTime();
    return now - last >= s.scrape_interval_minutes * 60_000;
  });

  const runnerLabel = opts?.runner ? ` [runner=${opts.runner}]` : '';
  console.log(`scrapeAllDue: ${due.length} source(s) due${opts?.force ? ' (force mode)' : ''}${runnerLabel}`);

  const results: ScrapeResult[] = [];
  for (let i = 0; i < due.length; i++) {
    const source = due[i];
    const t0 = Date.now();
    console.log(`  [${i + 1}/${due.length}] ${source.name} starting…`);
    const result = await scrapeWithTimeout(source);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [${i + 1}/${due.length}] ${source.name} ${result.status} in ${dt}s · found=${result.found} new=${result.inserted}${result.error ? ' err=' + result.error.slice(0, 80) : ''}`);
    results.push(result);
    // Small pause between sources so we don't hammer shared
    // infrastructure (Supabase rate limits, OG-image hosts, etc).
    await sleep(1500);
  }
  return results;
}
