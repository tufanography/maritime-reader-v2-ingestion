// Decoupled service client for standalone (GHA / Node) ingestion.
//
// v1's lib/supabase/server.ts also exported createServerClient() — a
// session/cookie client that imports `next/headers`. The scraper never calls
// it, so this port DROPS it: that single import was the ONLY thing tying v1's
// scraper to Next.js. createServiceClient() itself was always Next-free.
//
// Env vars match v1 (so no copied-file edits), with a fallback to the plainer
// SUPABASE_URL the v2-ingestion .env already uses for local runs.
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY. ' +
        'Ingestion needs the service-role key for writes.',
    );
  }
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
