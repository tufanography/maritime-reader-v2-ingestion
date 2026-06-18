// URL-pattern based topic detection for P&I clubs that organize content by URL slug.
// When article URLs contain certain path segments, we add topic tags automatically.
// Higher accuracy than keyword matching because the publisher pre-categorized.

type UrlRule = { pattern: RegExp; tagSlugs: string[] };

const RULES: UrlRule[] = [
  // ----- Skuld topic taxonomy -----
  // Skuld articles live under /topics/{section}/...
  { pattern: /skuld\.com\/topics\/cargo\//i,                 tagSlugs: ['cargo-claims'] },
  { pattern: /skuld\.com\/topics\/legal\/sanctions\//i,      tagSlugs: ['russia-sanctions'] },
  { pattern: /skuld\.com\/topics\/legal\/pi-and-defence\//i, tagSlugs: ['fdd'] },
  { pattern: /skuld\.com\/topics\/environment\//i,           tagSlugs: ['pollution-claims'] },
  { pattern: /skuld\.com\/topics\/port\/piracy\//i,          tagSlugs: ['piracy'] },
  { pattern: /skuld\.com\/topics\/port\//i,                  tagSlugs: ['ports'] },
  { pattern: /skuld\.com\/topics\/people\//i,                tagSlugs: ['crew-claims'] },
  { pattern: /skuld\.com\/topics\/ship\/safety\//i,          tagSlugs: ['loss-prevention'] },
  { pattern: /skuld\.com\/topics\/ship\/navigation\//i,      tagSlugs: ['loss-prevention'] },
  { pattern: /skuld\.com\/topics\/ship\/bunkers\//i,         tagSlugs: ['loss-prevention'] },

  // ----- Britannia P&I categories -----
  { pattern: /britanniapandi\.com\/category\/loss-prevention/i, tagSlugs: ['loss-prevention'] },
  { pattern: /britanniapandi\.com\/category\/risk-watch/i,      tagSlugs: ['risk-watch', 'loss-prevention'] },
  { pattern: /britanniapandi\.com\/category\/health-watch/i,    tagSlugs: ['health-watch', 'crew-claims'] },
  { pattern: /britanniapandi\.com\/category\/crew-watch/i,      tagSlugs: ['crew-watch', 'crew-claims'] },
  { pattern: /britanniapandi\.com\/category\/case-study/i,      tagSlugs: ['loss-prevention'] },
  { pattern: /britanniapandi\.com\/category\/bsafe/i,           tagSlugs: ['loss-prevention'] },

  // ----- West of England filter URLs (we capture both filter and per-article URLs) -----
  { pattern: /westpandi\.com\/.*topics=lossprevention/i, tagSlugs: ['loss-prevention'] },
  { pattern: /westpandi\.com\/.*topics=sanctions/i,      tagSlugs: ['russia-sanctions'] },
];

export function tagsFromUrl(url: string): string[] {
  const matches = new Set<string>();
  for (const rule of RULES) {
    if (rule.pattern.test(url)) {
      for (const slug of rule.tagSlugs) matches.add(slug);
    }
  }
  return [...matches];
}
