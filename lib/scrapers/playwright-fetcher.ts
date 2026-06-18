// JS-rendered fallback for sources whose article body is built by a SPA
// (NorthStandard, etc.). Default scraper path stays on Cheerio + fetch
// for speed; only sources explicitly tagged `requires_js: true` in their
// HtmlScraperConfig touch this module.
//
// Browser is launched lazily on first use and reused across calls within
// a single Node process — launching costs ~1-2s, so amortizing across an
// entire scrape run is what makes Playwright viable here at all.
// Long-running cron jobs should call closePlaywright() before exit to
// release the browser cleanly; one-shot scripts can let process exit
// reap it.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let cookieConsentDismissed = false;

// Cookie consent button selectors, ordered most-specific to most-generic.
// First hit wins. Source-agnostic — these patterns cover OneTrust, Cookiebot,
// and most custom banners. Once dismissed, the cookie is stored in the shared
// BrowserContext so subsequent page loads in the same process don't see the
// banner; this flag short-circuits the dismissal attempt after the first
// success.
const COOKIE_CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',                    // OneTrust (very common)
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', // Cookiebot
  'button:has-text("Allow all")',
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("I agree")',
  'button:has-text("Got it")',
  '[aria-label="Accept all"]',
  '[aria-label="Accept All Cookies"]',
];

async function getContext(): Promise<BrowserContext> {
  if (browser && !browser.isConnected()) {
    browser = null;
    context = null;
    cookieConsentDismissed = false;
  }
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  if (!context) {
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
  }
  return context;
}

async function dismissCookieBanner(page: Page): Promise<boolean> {
  for (const sel of COOKIE_CONSENT_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ timeout: 2000 });
        // Brief settle for any post-click DOM/network activity.
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        return true;
      }
    } catch {
      // selector miss or click failed — try next candidate
    }
  }
  return false;
}

export async function fetchHtmlWithPlaywright(
  url: string,
  opts: { timeoutMs?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' } = {},
): Promise<string> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, {
      waitUntil: opts.waitUntil ?? 'networkidle',
      timeout: opts.timeoutMs ?? 45000,
    });
    if (!cookieConsentDismissed) {
      const ok = await dismissCookieBanner(page);
      if (ok) {
        cookieConsentDismissed = true;
        // Some sites re-render after consent; give the article DOM a moment
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      }
    }
    return await page.content();
  } finally {
    await page.close();
  }
}

export async function closePlaywright(): Promise<void> {
  try {
    if (context) await context.close();
  } catch { /* ignore */ }
  context = null;
  try {
    if (browser) await browser.close();
  } catch { /* ignore */ }
  browser = null;
}
