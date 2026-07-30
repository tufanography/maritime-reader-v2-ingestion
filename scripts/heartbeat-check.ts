// B4 watchdog — total-scraper-death detector. Runs on its OWN GHA cron
// (heartbeat.yml), independent of the scrape workflow, so it still fires if
// scrape.yml itself stops running. If no scrape has SUCCEEDED in > STALE_H hours,
// it alarms through the existing Resend channel (same env as notifyStuckScrapes).
//
// Deliberately separate from the scraper: a monitor that lives inside the thing it
// monitors dies with it. Read-only; best-effort email (no-op if unset). Never fails
// the workflow — it is a monitor, not a gate.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const STALE_H = Number(process.env.HEARTBEAT_STALE_HOURS ?? 6);
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(0); }

const sb = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await sb
  .from('scrape_logs')
  .select('finished_at')
  .in('status', ['success', 'partial'])
  .not('finished_at', 'is', null)
  .order('finished_at', { ascending: false })
  .limit(1);
if (error) { console.error(`heartbeat query failed — scraper health UNKNOWN this tick: ${error.message}`); process.exit(0); }

const last = data?.[0]?.finished_at as string | undefined;
const ageH = last ? (Date.now() - Date.parse(last)) / 3_600_000 : Infinity;
console.log(`last successful scrape: ${last ?? 'NONE'} (${ageH === Infinity ? '∞' : ageH.toFixed(2)}h ago); threshold ${STALE_H}h`);
if (ageH <= STALE_H) { console.log('OK — scraper alive'); process.exit(0); }

const alertEmail = process.env.ALERT_EMAIL;
if (!alertEmail || !process.env.RESEND_API_KEY) {
  console.warn(`STALE (${ageH === Infinity ? '∞' : ageH.toFixed(1)}h) but ALERT_EMAIL/RESEND_API_KEY unset — cannot send alarm`);
  process.exit(0);
}
try {
  const { getResend, FROM_ADDRESS } = await import('../lib/email/resend');
  await getResend().emails.send({
    from: FROM_ADDRESS,
    to: alertEmail,
    subject: `Maritime Reader — scraper SILENT for ${ageH === Infinity ? 'ever' : ageH.toFixed(1) + 'h'}`,
    html: `<p><strong>No successful scrape in ${ageH === Infinity ? 'the recorded history' : ageH.toFixed(1) + ' hours'}</strong> (threshold ${STALE_H}h).</p>`
      + `<p>Last success: ${last ?? 'never'}. Check scrape.yml runs, the CF watchdog, and source health.</p>`
      + `<p>Heartbeat run at ${new Date().toISOString()}.</p>`,
  });
  console.log('alarm email sent');
} catch (e) {
  console.error('alarm send failed:', e instanceof Error ? e.message : String(e));
}
process.exit(0);
