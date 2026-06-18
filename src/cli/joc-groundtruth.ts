// D22 v3 GROUND-TRUTH probe (D16). One question only:
//
//   When a non-subscriber opens a JoC article in a browser, how much
//   OPEN article body do they actually see, and is there a paywall wall?
//
// The 2026-05-31 D22 reversal trusted "body_length 2000" — but that 2000
// came from __NEXT_DATA__ JSON (the SUBSCRIBER body embedded for SEO /
// hydration), NOT from what the reader sees rendered. This probe pulls
// the two apart, per URL:
//
//   visible (Phase2 DOM)  = noise-stripped container <p> walk over the
//                           SSR HTML — the open content a non-JS reader
//                           sees before any wall.
//   subscriber (NEXT_DATA)= the full body embedded in the JSON blob.
//   paywall phrase        = which exact phrase fires, and a snippet of
//                           its surrounding HTML (so we can SEE the wall).
//
// It ALSO calls the real fetchDetail() so the official numbers the
// orchestrator decides on (visibleBodyLength, isPaywalled) are printed
// side-by-side with the hand analysis — if they disagree, the code is
// wrong and we found it here, before any DB write (D1/D16).
//
// Usage:
//   npx tsx src/cli/joc-groundtruth.ts                 (discover 4 JoC URLs)
//   npx tsx src/cli/joc-groundtruth.ts <url> [<url> …]  (probe given URLs)

import 'dotenv/config';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { fetchDetail, PAYWALLED_THIN_THRESHOLD } from '@/lib/extract/detail-fetch';
import { SitemapDiscovery } from '@/lib/discovery/SitemapDiscovery';
import { findBySlug } from '@/sources/registry';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// A representative slice of the orchestrator's PAYWALL_PHRASES (not the
// full 55) — enough to identify WHICH wall fires on JoC for diagnostics.
const DIAG_PHRASES = [
  'subscribe to read', 'subscribe to view', 'subscribe to continue', 'subscribe now',
  'subscribers only', 'paid subscribers only', 'subscription required',
  'log in to read', 'log in to view', 'log in to continue', 'sign in to read',
  'sign in to continue', 'register to read', 'register to continue',
  'begin free trial', 'start free trial', 'free trial to read',
  'this content is locked', 'this article is for subscribers',
  'become a subscriber to', 'unlock this article', 'unlock the rest of this article',
  'create an account to read', 'members only',
];

// Mirror of detail-fetch.ts Phase 1 noise selectors (abridged but
// faithful for the visible-body measurement).
const NOISE = [
  'nav', 'header', 'footer', 'aside',
  'script:not(#__NEXT_DATA__):not([id*="NEXT_DATA"]):not([type="application/ld+json"])',
  'style', 'noscript', 'iframe', 'form',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]', '[role="search"]',
  '.nav', '.navbar', '.menu', '.navigation', '.header', '.site-header', '.masthead',
  '.footer', '.site-footer', '.sidebar', '.related', '.related-articles', '.recommended',
  '.promo', '.subscribe', '.subscription', '.newsletter', '.signup', '.cta',
  '.social', '.share', '.comments', '.breadcrumb', '.ad', '.ads',
  '.cookie', '.modal', '.popup', '.overlay', '.tease',
  '[class*="additional-news"]', '[class*="more-articles"]', '[class*="latest-news"]',
  '[class*="recommended"]', '[class*="Card_"]', '[class*="VerticalCard"]',
  '[class*="HorizontalCard"]', '[class*="ArticleCard"]', '[class*="NewsCard"]',
];

const CONTAINERS = [
  '[itemprop="articleBody"]', 'article [itemprop="articleBody"]', 'article',
  '[role="article"]', '[role="main"] article', '[role="main"]', 'main article', 'main',
  '.entry-content', '.post-content', '.article-content', '.article-body',
  '.story-body', '.content-body', '.post-body', '.content', 'body',
];

function visibleDomBody($: CheerioAPI): { text: string; container: string } {
  for (const sel of NOISE) $(sel).remove();
  for (const sel of CONTAINERS) {
    const node = $(sel).first();
    if (node.length === 0) continue;
    const paras: string[] = [];
    node.find('p').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t.length >= 40) paras.push(t);
    });
    if (paras.length === 0) continue;
    const joined = paras.join(' ').trim();
    if (joined.length >= 80) return { text: joined, container: sel };
  }
  return { text: '', container: '(none)' };
}

function nextDataBody(html: string): string {
  const $ = cheerio.load(html);
  const raw = $('script#__NEXT_DATA__').first().contents().text().trim()
    || $('script[id*="NEXT_DATA"]').first().contents().text().trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    // shallow BFS for a long body-ish string, mirroring detail-fetch
    const queue: { v: unknown; d: number }[] = [{ v: parsed, d: 0 }];
    const FIELDS = new Set(['BodyPlainText', 'bodyPlainText', 'articleBody', 'ArticleBody', 'bodyText', 'plainText', 'fullText', 'content', 'body']);
    let best = '';
    while (queue.length) {
      const { v, d } = queue.shift()!;
      if (d > 8 || v == null) continue;
      if (typeof v === 'string') { if (v.length >= 200 && / /.test(v) && /[.!?]/.test(v) && v.length > best.length) best = v; continue; }
      if (Array.isArray(v)) { for (const e of v) queue.push({ v: e, d: d + 1 }); continue; }
      if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        for (const k of Object.keys(o)) { const val = o[k]; if (FIELDS.has(k) && typeof val === 'string' && val.length >= 200) return val; }
        for (const k of Object.keys(o)) queue.push({ v: o[k], d: d + 1 });
      }
    }
    return best;
  } catch { return ''; }
}

function paywallHits(html: string): { phrase: string; snippet: string }[] {
  const lower = html.toLowerCase();
  const hits: { phrase: string; snippet: string }[] = [];
  for (const p of DIAG_PHRASES) {
    const idx = lower.indexOf(p);
    if (idx >= 0) {
      const raw = html.slice(Math.max(0, idx - 50), idx + p.length + 50).replace(/\s+/g, ' ').trim();
      hits.push({ phrase: p, snippet: raw });
    }
  }
  return hits;
}

async function getUrls(): Promise<string[]> {
  // DB-FREE on purpose: D22 v3's decision (visibleBodyLength + isPaywalled)
  // is computed entirely from the page fetch — no Supabase needed. This
  // lets us verify the rule (incl. the open-source false-positive check)
  // even when the DB is timing out, which the full dryrun can't do
  // because it resolves source_id first.
  //
  // Args:
  //   (none)            → discover 4 JoC URLs (default)
  //   <slug>            → discover 4 URLs for that registry slug (sitemap only)
  //   <http…> [<http…>] → probe the given URLs verbatim
  const argv = process.argv.slice(2);
  const urlArgs = argv.filter((a) => /^https?:\/\//i.test(a));
  if (urlArgs.length) return urlArgs;
  const slug = argv.find((a) => !/^https?:\/\//i.test(a)) ?? 'joc';
  const src = findBySlug(slug);
  if (!src) { console.error(`unknown slug "${slug}"`); process.exit(2); }
  if (src.mode !== 'sitemap' || !src.sitemapUrl) {
    console.error(`slug "${slug}" is mode=${src.mode}; this probe discovers sitemap sources only. Pass explicit URLs instead.`);
    process.exit(2);
  }
  console.log(`(discovering via sitemap for slug="${slug}")`);
  const disc = new SitemapDiscovery();
  const urls: string[] = [];
  for await (const item of disc.discover({ sitemapUrl: src.sitemapUrl, urlPattern: src.urlPattern, maxItems: 4 })) {
    urls.push(item.url);
  }
  return urls;
}

async function main() {
  const urls = await getUrls();
  console.log(`D22 v3 GROUND-TRUTH — ${urls.length} JoC URL(s). THRESHOLD=${PAYWALLED_THIN_THRESHOLD}\n`);
  for (const url of urls) {
    console.log('═'.repeat(90));
    console.log(url);
    // raw fetch for hand analysis
    let html = '';
    let status = 0;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'follow' });
      status = res.status;
      html = await res.text();
    } catch (e) {
      console.log(`  raw fetch failed: ${(e as Error).message}\n`);
      continue;
    }
    const $ = cheerio.load(html);
    const vis = visibleDomBody($);
    const sub = nextDataBody(html);
    const hits = paywallHits(html);

    // official numbers from the real code path
    const det = await fetchDetail(url);

    console.log(`  HTTP ${status} | rawHtml ${html.length} bytes`);
    console.log(`  ── what the READER sees (Phase2 DOM, container=${vis.container}) ──`);
    console.log(`     visible open body: ${vis.text.length} chars`);
    console.log(`     "${vis.text.slice(0, 400).replace(/\n/g, ' ')}${vis.text.length > 400 ? ' …' : ''}"`);
    console.log(`  ── SUBSCRIBER body (__NEXT_DATA__ JSON, reader does NOT see) ──`);
    console.log(`     embedded body: ${sub.length} chars`);
    console.log(`     "${sub.slice(0, 200).replace(/\n/g, ' ')}${sub.length > 200 ? ' …' : ''}"`);
    console.log(`  ── PAYWALL phrase scan (${hits.length} hit) ──`);
    for (const h of hits.slice(0, 4)) console.log(`     [${h.phrase}]  …${h.snippet}…`);
    console.log(`  ── OFFICIAL fetchDetail() (what orchestrator decides on) ──`);
    console.log(`     visibleBodyLength=${det.visibleBodyLength}  isPaywalled=${det.isPaywalled}  bodyExcerpt=${det.bodyExcerpt?.length ?? 0}`);
    const wouldReject = det.visibleBodyLength < PAYWALLED_THIN_THRESHOLD && det.isPaywalled;
    console.log(`     ⇒ D22 v3 decision: ${wouldReject ? 'REJECT paywalled_thin' : 'ACCEPT'}`);
    console.log('');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
