// Local ONNX text embeddings for semantic search. Runs in-process (GHA worker,
// $0 — no external embedding API). Used at INGESTION time to embed each new
// article, and by backfill scripts. The CF Worker query path uses Cloudflare
// Workers AI with the SAME bge model id, so query and document vectors live in
// the same space (cosine-comparable).
//
// Model: bge-base-en-v1.5 (768-dim). Chosen over bge-small (384-dim) because
// the POC synonym-bridge benchmark showed the larger model widens semantic's
// recall lead on vocabulary-gap queries (the whole point of adding semantic on
// top of the existing keyword/Pagefind index). Swap via EMBED_MODEL.
//
// bge convention: passages are embedded as-is; QUERIES get a task-instruction
// prefix. embedQuery() applies it; embedPassages() does not.
import { pipeline, env, type FeatureExtractionPipeline } from '@xenova/transformers';

export const EMBED_MODEL = process.env.EMBED_MODEL || 'Xenova/bge-base-en-v1.5';
export const EMBED_DIM = Number(process.env.EMBED_DIM || 768);
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let pipePromise: Promise<FeatureExtractionPipeline> | null = null;
function embedder(): Promise<FeatureExtractionPipeline> {
  if (!pipePromise) pipePromise = pipeline('feature-extraction', EMBED_MODEL) as Promise<FeatureExtractionPipeline>;
  return pipePromise;
}

/** Build the text we embed for an article: title carries the most signal, then
 *  the lede. Capped so we stay within the model's 512-token window. */
export function articleEmbedText(title: string, excerpt: string | null | undefined): string {
  return `${title}. ${(excerpt ?? '').slice(0, 1200)}`.trim();
}

/** Embed passages (documents). Returns one unit-normalized vector per input. */
export async function embedPassages(texts: string[], batchSize = 32): Promise<number[][]> {
  const ex = await embedder();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => t || ' ');
    const res = await ex(batch, { pooling: 'mean', normalize: true });
    const d = res.dims[1];
    for (let j = 0; j < batch.length; j++) out.push(Array.from(res.data).slice(j * d, (j + 1) * d) as number[]);
  }
  return out;
}

/** Embed a single article (convenience for the ingestion hot path). Returns
 *  null on any failure — embedding is best-effort enrichment, never fatal to
 *  an insert. */
export async function embedArticle(title: string, excerpt: string | null | undefined): Promise<number[] | null> {
  try {
    const [v] = await embedPassages([articleEmbedText(title, excerpt)]);
    return v ?? null;
  } catch {
    return null;
  }
}

/** Embed a search query (applies the bge query instruction prefix). */
export async function embedQuery(q: string): Promise<number[]> {
  const ex = await embedder();
  const res = await ex([`${QUERY_PREFIX}${q}`], { pooling: 'mean', normalize: true });
  return Array.from(res.data) as number[];
}

/** pgvector literal: '[0.1,0.2,...]'. Supabase-js sends this as a text param
 *  that Postgres casts to vector. */
export function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`;
}
