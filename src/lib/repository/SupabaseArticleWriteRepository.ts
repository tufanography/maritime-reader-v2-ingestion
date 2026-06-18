import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ScrapedArticle } from './types';
import type { ArticleWriteRepository } from './ArticleWriteRepository';

// Supabase implementation. Uses the service-role key (bypasses RLS for
// writes). Service-role key MUST stay server/local-only — never
// committed, never sent to the browser. Ingestion runs on the operator
// machine only, so this is fine.
export class SupabaseArticleWriteRepository implements ArticleWriteRepository {
  private sb: SupabaseClient;

  constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env. ' +
          'Ingestion needs write access; the site\'s public anon key is not enough.',
      );
    }
    this.sb = createClient(url, key, { auth: { persistSession: false } });
  }

  async resolveSourceId(name: string): Promise<string | null> {
    const { data, error } = await this.sb
      .from('sources')
      .select('id')
      .eq('name', name)
      .maybeSingle();
    if (error) throw new Error(`resolveSourceId(${name}): ${error.message}`);
    return data?.id ?? null;
  }

  async knownUrlHashes(hashes: string[]): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    // Chunk the IN() lookup — Supabase HTTP header limit ~16 KB caps us
    // around ~400 32-char hashes per request (we saw the issue in v1
    // diag500r verify). 200 is a safe chunk.
    const out = new Set<string>();
    for (let i = 0; i < hashes.length; i += 200) {
      const chunk = hashes.slice(i, i + 200);
      const { data, error } = await this.sb
        .from('articles')
        .select('url_hash')
        .in('url_hash', chunk);
      if (error) throw new Error(`knownUrlHashes: ${error.message}`);
      for (const r of data as { url_hash: string }[]) out.add(r.url_hash);
    }
    return out;
  }

  async insertOne(article: ScrapedArticle): Promise<void> {
    const { error } = await this.sb.from('articles').insert(article);
    if (error) throw new Error(`insertOne: ${error.message}`);
  }

  async insertMany(
    articles: ScrapedArticle[],
  ): Promise<{ inserted: number; failed: number }> {
    // D11: chunked bulk insert. 200/chunk worked well in v1 null-cohort
    // recovery and stays well under Supabase's PostgREST row limits.
    let inserted = 0;
    let failed = 0;
    for (let i = 0; i < articles.length; i += 200) {
      const chunk = articles.slice(i, i + 200);
      const { error, count } = await this.sb
        .from('articles')
        .insert(chunk, { count: 'exact' });
      if (error) {
        failed += chunk.length;
        // eslint-disable-next-line no-console
        console.error(`insertMany chunk failed: ${error.message}`);
      } else {
        inserted += count ?? chunk.length;
      }
    }
    return { inserted, failed };
  }
}

// Singleton for CLI scripts. Tests can construct their own instance with
// a different env if needed.
export const articleWriteRepo: ArticleWriteRepository =
  new SupabaseArticleWriteRepository();
