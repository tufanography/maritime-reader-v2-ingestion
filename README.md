# maritime-reader-v2-ingestion

Independent ingestion pipeline for [Maritime Reader v2](https://maritimereader.com). Writes to the same Supabase DB the v2 static site reads.

**What this is (2026-06-18):** the live scraper for Maritime Reader, **reusing v1's (`maritime-pulse`) proven scraper engine** — discovery (RSS / sitemap / HTML listing), date extraction (8-step cascade), PDF + JS-rendered pages, dedup, and the full inline **enrichment** layer (summary, document_type, segments, keywords, content_quality/moderation). It is NOT a from-scratch rewrite: an earlier attempt under `src/` was retired after it proved to be missing the entire enrichment layer that v1 already does. The reused engine lives under `lib/` + `scripts/`, mirroring v1's layout so the imports port unchanged.

**Why a separate repo from the site:** Cloudflare builds the site repo (`maritime-reader-v2`) on every push. Keeping ingestion deps (Playwright, cheerio, pdf-parse, the Anthropic SDK, …) out of that repo keeps site builds small and fast. The contract between the repos is the DB schema itself.

## Runtime

Runs on **GitHub Actions** (this is a public repo → unlimited Actions minutes), reliability backed by the **Ç1 Cloudflare cron watchdog** (`maritime-reader-admin`) which re-dispatches the workflow if GitHub drops a scheduled run, plus a healthchecks.io dead-man's-switch. The operator machine is for **dev/test only** — never the permanent runtime (the v1 "local runner" once died and 12 sources silently starved ~13 days).

Cloudflare Workers themselves **cannot** run the scrape (heavy deps + CPU/time limits); CF only watches/triggers.

## Layout

```
lib/scrapers/   orchestrator, rss, html, util, quality, moderation, date, pdf, playwright-fetcher
lib/ai/         claude (optional AI summary/categorize), rules (rule-based fallback), pdf-sections
lib/tagging/    extract, keywords, url-rules, false-contexts
lib/v3/         document-type, segments
lib/supabase/   types, server (decoupled createServiceClient — no next/headers)
lib/email/      resend (best-effort stuck-scrape alert)
scripts/        cron-scrape.ts   ← entry point
src/            RETIRED from-scratch engine + its dry-run/apply/verify harness (kept for reference)
```

## Run

```sh
npm install
npm run scrape          # = tsx scripts/cron-scrape.ts  (SCRAPE_RUNNER=cloud)
npm run build           # tsc --noEmit typecheck
```

Required env (GH Actions secrets / local `.env`, never committed):
`NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY`.
Optional: `ANTHROPIC_API_KEY` (AI summary; rules fallback if absent), `RESEND_API_KEY` / `RESEND_FROM_ADDRESS` / `ALERT_EMAIL` (stuck-scrape email).

## Cutover status

The workflow ships **`workflow_dispatch`-only**. At cutover: enable the `schedule:` cron in `.github/workflows/scrape.yml`, point the Ç1 watchdog at this workflow, and disable v1's `scrape.yml` (only one scheduled scraper at a time — two would roughly double the Supabase-Nano Disk-IO load). Dedup by `url_hash` makes manual-dispatch testing safe alongside v1.
