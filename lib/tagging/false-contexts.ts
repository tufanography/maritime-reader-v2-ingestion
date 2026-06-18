// Tag suppression rules for known false-context phrases. If a phrase
// from this list appears in the article TITLE, the listed tag slugs
// will NOT be applied to that article.
//
// Deliberately minimal — we don't speculate. Each rule represents an
// actual or near-actual false positive seen in the corpus. The admin
// audit dashboard surfaces wrong tags so this list can grow with
// evidence, not guesswork.

export type FalseContextRule = {
  phrase: RegExp;
  suppressSlugs: string[];
  reason: string;
};

export const FALSE_CONTEXTS: FalseContextRule[] = [
  {
    // "class action lawsuit" / "class-action complaint" pulls article
    // into class-society tags because their names contain "class".
    phrase: /\bclass[-\s]action\b/i,
    suppressSlugs: [
      'lloyds-register', 'classnk', 'abs', 'dnv', 'bureau-veritas',
      'rina-class', 'ccs-class', 'korean-register',
      'polish-register-of-shipping',
    ],
    reason: 'class-action legal term, not classification society',
  },
  {
    // Auto "gas station" wrongly hits LNG bunkering tag if "gas"
    // appears in the body.
    phrase: /\bgas station\b/i,
    suppressSlugs: ['lng-bunkering'],
    reason: 'auto gas station, not vessel bunkering',
  },
  {
    // "pilot project" / "pilot episode" in feature articles. Our
    // "pilot" matches port pilots in maritime context.
    phrase: /\b(?:pilot episode|pilot project|test pilot|pilot scheme)\b/i,
    suppressSlugs: ['ports'],
    reason: 'pilot project/episode, not port pilot',
  },
];

/** Return the set of tag slugs that the title's false-context phrases
 *  forbid applying to this article. Empty set when the title has no
 *  matching phrases (the common case). */
export function suppressedSlugs(title: string): Set<string> {
  const out = new Set<string>();
  for (const rule of FALSE_CONTEXTS) {
    if (rule.phrase.test(title)) {
      for (const slug of rule.suppressSlugs) out.add(slug);
    }
  }
  return out;
}
