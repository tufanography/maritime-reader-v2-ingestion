// Section detection for consolidated / newsletter-style PDFs.
//
// Used when a single PDF bundles several distinct articles. Returns one
// entry per article found; empty array for single-topic PDFs (caller
// keeps the regular code path).
//
// Default implementation is a free heuristic — it scans the PDF text for
// SEQUENTIAL numbered headings ("1. Title" / "2. Title" / ... or
// "Article 1: ..." / "Article 2: ..."). Only triggers when a run of >=3
// consecutive numbers is found, which keeps false positives down on
// PDFs that happen to contain numbered LISTS rather than article
// boundaries.
//
// An AI-driven variant (extractPdfSectionsAi) lives below for sources
// where the heuristic isn't enough — opt-in via `pdf_split_sections_ai`
// in scraper_config. It costs ~$0.0005 per PDF and is more flexible at
// detecting non-numbered article boundaries.

import Anthropic from '@anthropic-ai/sdk';

export type PdfSection = {
  title: string;
  /** Short factual summary for THIS section (not the whole PDF). */
  snippet: string;
};

const NUMBERED_TITLE = /^\s*(\d+)[.)]\s+(.{8,200})$/;
const NAMED_TITLE = /^\s*(?:Article|Section|Chapter|Part|Issue|Item|Update|Topic)\s+(\d+)\s*[:.\-—]\s*(.{4,200})$/i;
const NOISE = /^(?:Page \d+|\d+ of \d+|Confidential|Internal use only|All rights reserved|Copyright|©|www\.)/i;

/** Free heuristic — scan for SEQUENTIAL numbered article headings.
 *  Returns sections only when a run of >=3 consecutive numbers exists,
 *  which is the strongest signal that the PDF is structured as
 *  "Article 1, Article 2, Article 3" rather than just having a few
 *  numbered list items. */
export function extractPdfSections(text: string): PdfSection[] {
  if (!text || text.length < 4000) return [];

  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // Collect candidate headings: { number, line index, title }.
  const candidates: { n: number; idx: number; title: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || NOISE.test(line)) continue;
    const num = NUMBERED_TITLE.exec(line);
    if (num) {
      candidates.push({ n: parseInt(num[1], 10), idx: i, title: num[2].trim() });
      continue;
    }
    const named = NAMED_TITLE.exec(line);
    if (named) {
      candidates.push({ n: parseInt(named[1], 10), idx: i, title: named[2].trim() });
    }
  }
  if (candidates.length < 3) return [];

  // Find the longest contiguous sub-run of strictly increasing
  // consecutive numbers. (1, 2, 3, 4 ...). Has to start at 1 — anything
  // else is more likely a list item run mid-document.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].n !== 1) continue;
    let len = 1;
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[j].n === candidates[j - 1].n + 1) len++;
      else break;
    }
    if (len > bestLen) {
      bestLen = len;
      bestStart = i;
    }
  }
  if (bestLen < 3) return [];

  const seq = candidates.slice(bestStart, bestStart + bestLen);
  const sections: PdfSection[] = [];
  for (let i = 0; i < seq.length; i++) {
    const start = seq[i];
    const end = seq[i + 1]?.idx ?? lines.length;
    const bodyLines = lines.slice(start.idx + 1, end).filter((l) => l.length > 0);
    const snippet = bodyLines.join(' ').slice(0, 400) || start.title;
    sections.push({ title: start.title, snippet });
  }
  return sections;
}

const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AI_SYSTEM_PROMPT =
  'You are a maritime publication parser. Identify distinct articles or ' +
  'sections inside the PDF text below. Each section has its own headline, ' +
  'topic, and body. If the PDF is a single-topic document (one circular, ' +
  'one report, one notice), return a SINGLE section. ' +
  'Otherwise (newsletter / quarterly review / consolidated report), return ' +
  'one entry per article. Output STRICT JSON, no commentary.';

/** AI-driven section detection — opt-in fallback for PDFs whose
 *  structure the heuristic can't recognise (no numbered headings, mixed
 *  layouts). One Haiku call per PDF, ~$0.0005. */
export async function extractPdfSectionsAi(args: {
  fallbackTitle: string;
  text: string;
}): Promise<PdfSection[]> {
  const { fallbackTitle, text } = args;
  if (!text || text.length < 4000) return [];
  if (!process.env.ANTHROPIC_API_KEY) return [];

  const userPrompt = `PDF text (may be truncated):
${text.slice(0, 12000)}

Return JSON shaped:
{"sections": [{"title": string, "snippet": "1-2 sentence factual summary of THIS section"}, ...]}

Rules:
- "title": the headline as written in the PDF (verbatim, max ~150 chars).
- Order: as they appear in the PDF.
- If the document covers ONE topic, return ONE section.
- Skip table-of-contents listings, mastheads, and "About us" boilerplate.`;

  try {
    const resp = await aiClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const respText = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const jsonMatch = respText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as { sections?: unknown };
    if (!Array.isArray(parsed.sections)) return [];
    const out: PdfSection[] = [];
    for (const s of parsed.sections) {
      if (typeof s !== 'object' || s === null) continue;
      const title = (s as { title?: unknown }).title;
      const snippet = (s as { snippet?: unknown }).snippet;
      if (typeof title !== 'string' || title.trim().length < 4) continue;
      out.push({
        title: title.trim().slice(0, 250),
        snippet: typeof snippet === 'string' ? snippet.trim().slice(0, 600) : fallbackTitle,
      });
    }
    return out;
  } catch (e) {
    console.error('extractPdfSectionsAi failed:', e instanceof Error ? e.message : String(e));
    return [];
  }
}
