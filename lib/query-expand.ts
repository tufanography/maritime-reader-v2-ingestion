// Query expansion — the #1 recall lever for hybrid search (measured: vocab-gap
// recall@10 hybrid 27% -> 66%, far bigger than the embedding-model choice).
// Bridges maritime vocabulary gaps so the cheap keyword engine (Pagefind) can
// match a synonym the user didn't type ("ship blaze" -> also search "fire").
//
// $0, deterministic, no LLM at query time. The SEED map below is hand-curated;
// the self-learning jargon miner (PPMI distributional similarity over the
// corpus) GROWS it over time, but only via the guardrail pipeline:
//   support >= 5 articles  AND  high PPMI strength  AND  boilerplate-stripped
//   AND  human/quarantine review  AND  a precision re-test before going live.
// A bad synonym hurts precision, so additions are gated, never auto-applied.
//
// Used on the QUERY side only (never mutates stored data): expand(query) ->
// the keyword + semantic search both run on the enriched query.

/** Bidirectional maritime synonym groups. Any term in a group expands to the
 *  others. Curated seed proven on the POC corpus; the miner appends here. */
export const SYNONYM_GROUPS: string[][] = [
  ['fire', 'blaze', 'inferno'],
  ['collision', 'allision'],
  ['sinking', 'sank', 'foundering', 'foundered'],
  ['capsize', 'capsized', 'overturned'],
  ['grounding', 'aground', 'ran aground', 'stranded'],
  ['oil spill', 'spill', 'hydrocarbon discharge', 'pollution', 'contamination'],
  ['sanctions', 'embargo', 'restrictions', 'blacklisted'],
  ['detention', 'detained', 'port state control', 'psc', 'deficiencies'],
  ['crew', 'seafarers', 'mariners', 'crewmembers'],
  ['abandonment', 'unpaid crew', 'stranded seafarers'],
  ['piracy', 'armed robbery', 'hijacking', 'sea robbery'],
  ['scrubber', 'scrubbers', 'exhaust gas cleaning', 'egcs'],
  ['decarbonisation', 'decarbonization', 'green shipping', 'energy transition'],
  ['lng', 'liquefied natural gas'],
  ['lpg', 'liquefied petroleum gas'],
  ['newbuilding', 'newbuild', 'newly ordered', 'new order'],
  ['congestion', 'port backlog', 'backlog', 'waiting times', 'delays'],
  ['bunker', 'marine fuel', 'bunkering'],
  ['tanker', 'crude carrier', 'product carrier'],
  ['bulk carrier', 'bulker', 'dry bulk'],
  ['container ship', 'boxship', 'containership'],
  ['shadow fleet', 'dark fleet', 'covert tankers', 'sanctioned tankers'],
  ['salvage', 'wreck removal', 'wreck recovery'],
  ['casualty', 'maritime accident', 'incident'],
  ['emissions', 'carbon output', 'ghg', 'greenhouse gas'],
  ['drydock', 'dry dock', 'ship repair'],
  ['cyber attack', 'ransomware', 'cyber incident'],
];

// Build a lookup once: lowercased term -> set of expansion terms (excluding self).
const INDEX: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const key = term.toLowerCase();
      const set = m.get(key) ?? new Set<string>();
      for (const other of group) if (other.toLowerCase() !== key) set.add(other);
      m.set(key, set);
    }
  }
  return m;
})();

/** Longest-match scan: find synonym-group terms (incl. multi-word phrases) that
 *  appear in the query, and return the extra terms to add. Phrases are matched
 *  on word boundaries so "lng" doesn't fire inside "challenging". */
export function expansionTerms(query: string): string[] {
  const q = ` ${query.toLowerCase()} `;
  const add = new Set<string>();
  for (const [term, extras] of INDEX) {
    const re = new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`);
    if (re.test(q)) for (const e of extras) add.add(e);
  }
  // Don't echo terms already present in the query.
  for (const w of q.split(/[^a-z0-9]+/)) add.delete(w);
  return [...add];
}

/** Expand a query string with its maritime synonyms (appended). Returns the
 *  original query unchanged when nothing matches. Both the keyword and the
 *  semantic search should run on this expanded string. */
export function expandQuery(query: string): string {
  const extra = expansionTerms(query);
  return extra.length ? `${query} ${extra.join(' ')}` : query;
}
