// B1 watchdog helper — turn an HTTP failure into a CLASSIFIED, countable signal.
//
// The failure that motivated this: a 403 on an additive fetch path (WP REST,
// supplemental feed) was caught and logged as a plain string, so in the run
// summary it was indistinguishable from "success + 0 new links". 403 (blocked /
// bot-challenge — the source is alive, we're being refused) and 404 (gone —
// the URL/selector is wrong) demand DIFFERENT responses and must be counted
// SEPARATELY. This module is the deterministic, dependency-free classifier +
// the `HTTP <code> <first 200 chars>` formatter B1 specifies. No side effects.

export type FetchFailureKind =
  | 'forbidden'      // 403 — blocked / bot challenge (source alive)
  | 'rate_limited'   // 429
  | 'not_found'      // 404 / 410 — URL or selector wrong
  | 'server_error'   // 5xx — publisher-side, usually transient
  | 'client_error'   // other 4xx
  | 'network'        // no HTTP status (DNS/timeout/abort)
  | 'unknown';

export function classifyHttpFailure(status: number | null): { kind: FetchFailureKind; label: string } {
  if (status === null) return { kind: 'network', label: 'network/timeout' };
  if (status === 403) return { kind: 'forbidden', label: '403 forbidden' };
  if (status === 429) return { kind: 'rate_limited', label: '429 rate-limited' };
  if (status === 404 || status === 410) return { kind: 'not_found', label: `${status} not-found` };
  if (status >= 500) return { kind: 'server_error', label: `${status} server-error` };
  if (status >= 400) return { kind: 'client_error', label: `${status} client-error` };
  return { kind: 'unknown', label: `HTTP ${status}` };
}

/** Extract the numeric HTTP status from the various shapes failures arrive in:
 *  a FetchError (`.status`), or a thrown Error whose message is `Status code NNN`
 *  (fetchFeedXml / fetchWpRest) or contains `HTTP NNN`. Returns null when there
 *  is no HTTP status (network/timeout/abort). */
export function parseStatusFromError(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number' && s >= 100 && s <= 599) return s;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const m = msg.match(/(?:status code|http|status)\D{0,3}(\d{3})/i);
  if (m) { const n = Number(m[1]); if (n >= 100 && n <= 599) return n; }
  return null;
}

/** B1 last_error format: `HTTP <code> <first 200 chars of message>` (or
 *  `FETCH <kind> …` when there is no HTTP status). Deterministic. */
export function formatFetchError(err: unknown): string {
  const status = parseStatusFromError(err);
  const { kind, label } = classifyHttpFailure(status);
  const msg = (err instanceof Error ? err.message : String(err ?? '')).slice(0, 200);
  return status === null ? `FETCH ${kind} — ${msg}` : `HTTP ${status} (${label}) — ${msg}`;
}

/** Per-source accumulator so a run can report "additive WP REST: 403×2, 404×1"
 *  instead of a wall of identical console lines. */
export class FetchHealth {
  readonly counts: Partial<Record<FetchFailureKind, number>> = {};
  readonly notes: string[] = [];
  record(context: string, err: unknown): { kind: FetchFailureKind; status: number | null } {
    const status = parseStatusFromError(err);
    const { kind } = classifyHttpFailure(status);
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    this.notes.push(`${context}: ${formatFetchError(err)}`);
    return { kind, status };
  }
  get hasFailures(): boolean { return this.notes.length > 0; }
  /** e.g. "forbidden×2, not_found×1" — for the run summary / alarm line. */
  summary(): string {
    return Object.entries(this.counts).map(([k, n]) => `${k}×${n}`).join(', ');
  }
}
