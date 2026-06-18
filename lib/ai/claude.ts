// Claude API: summarize + categorize an article.
// Uses Haiku 4.5 for cost (~$0.0005 / article). Falls back gracefully on failure.
import Anthropic from '@anthropic-ai/sdk';

const CATEGORY_SLUGS = [
  'tankers',
  'container',
  'dry-bulk',
  'regulations',
  'accidents',
  'pi-insurance',
  'classification',
  'shipbuilding',
  'offshore',
  'ports',
  'crew',
  'general',
] as const;

export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

export type AiResult = {
  summary: string;
  category: CategorySlug;
  confidence: number;
};

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function summarizeAndCategorize(args: {
  title: string;
  excerpt: string;
  hint?: string | null;
}): Promise<AiResult> {
  const { title, excerpt, hint } = args;

  const systemPrompt =
    'You are a maritime news editor. Output STRICT JSON matching the schema requested. ' +
    'Summary must be 2 short sentences, factual, no opinions. ' +
    `Category MUST be one of: ${CATEGORY_SLUGS.join(', ')}.`;

  const userPrompt = `Title: ${title}

Excerpt:
${excerpt.slice(0, 4000)}

${hint ? `Source hint: this source typically publishes "${hint}" content.\n` : ''}
Return JSON: {"summary": string, "category": string, "confidence": number 0-1}`;

  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(jsonMatch[0]) as {
    summary?: unknown;
    category?: unknown;
    confidence?: unknown;
  };

  const summary = typeof parsed.summary === 'string' ? parsed.summary : title;
  const rawCategory = typeof parsed.category === 'string' ? parsed.category : 'general';
  const category = (CATEGORY_SLUGS as readonly string[]).includes(rawCategory)
    ? (rawCategory as CategorySlug)
    : 'general';
  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.5;

  return { summary, category, confidence };
}
