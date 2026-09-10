/**
 * Claude-based entity extraction.
 *
 * Replaces the GLiNER output for already-imported recordings. GLiNER runs per
 * paragraph with no view of the interview, so it tags pronouns and generic nouns
 * ("you", "it", "dad") as people and mislabels a lot else.
 *
 * Split of responsibilities:
 *   - Claude does the judgement: read the transcript and return a deduplicated
 *     list of real named entities, each with a label and the surface forms the
 *     transcript actually uses for it.
 *   - This script does the locating: scan the word stream for those surface forms
 *     to produce every occurrence with exact start/end times.
 *
 * That keeps highlight timings exact (they come from word timestamps, not from
 * the model guessing offsets) and keeps the model's output small and cheap.
 *
 * Usage:
 *   WEAVIATE_HOST_URL=localhost WEAVIATE_PORT=8081 \
 *     yarn tsx scripts/extract-entities-claude.ts --all [--dry-run] [--model claude-opus-5]
 *   ... --uuid <testimony-uuid>     one recording
 *   ... --title "Cody Coleman"      one recording by title
 */

import Anthropic from '@anthropic-ai/sdk';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type WordEntry = { text: string; start: number; end: number };
type ParagraphEntry = { index: number; speaker: string; firstWord: number; lastWord: number; text: string };
type ClaudeEntity = { name: string; label: string; aliases?: string[] };
type Occurrence = {
  text: string;
  label: string;
  start_time: number;
  end_time: number;
  start_word: number;
  end_word: number;
};

const WEAVIATE_URL = `${process.env.WEAVIATE_SECURE === 'true' ? 'https' : 'http'}://${
  process.env.WEAVIATE_HOST_URL ?? 'weaviate'
}:${process.env.WEAVIATE_PORT ?? '8080'}`;

const DEFAULT_MODEL = 'claude-opus-5';
const WORDS_PER_WINDOW = 1200;
const WINDOW_CONCURRENCY = 4;
const MAX_TOKENS = 16000;

/* ------------------------------------------------------------------ cli */

type Options = {
  all: boolean;
  uuid: string;
  title: string;
  model: string;
  dryRun: boolean;
  fromCache: boolean;
  cacheDir: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    all: false,
    uuid: '',
    title: '',
    model: DEFAULT_MODEL,
    dryRun: false,
    fromCache: false,
    cacheDir: './.entity-cache',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--uuid') options.uuid = argv[++i] ?? '';
    else if (arg === '--title') options.title = argv[++i] ?? '';
    else if (arg === '--model') options.model = argv[++i] ?? DEFAULT_MODEL;
    else if (arg === '--from-cache') options.fromCache = true;
    else if (arg === '--cache-dir') options.cacheDir = argv[++i] ?? './.entity-cache';
  }

  if (!options.all && !options.uuid && !options.title) {
    throw new Error('Specify --all, --uuid <id>, or --title "<interview title>"');
  }

  return options;
}

/* ------------------------------------------------------------- weaviate */

async function graphql<T>(query: string): Promise<T> {
  const response = await fetch(`${WEAVIATE_URL}/v1/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  const payload = await response.json();
  if (payload.errors) {
    throw new Error(`Weaviate GraphQL error: ${JSON.stringify(payload.errors).slice(0, 400)}`);
  }
  return payload.data as T;
}

async function patchObject(className: string, uuid: string, properties: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${WEAVIATE_URL}/v1/objects/${className}/${uuid}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ class: className, id: uuid, properties }),
  });

  if (!response.ok) {
    throw new Error(`PATCH ${className}/${uuid} failed: HTTP ${response.status} ${await response.text()}`);
  }
}

/* ----------------------------------------------------------- transcript */

function buildWordStream(transcription: string): { words: WordEntry[]; paragraphs: ParagraphEntry[] } {
  const blob = JSON.parse(transcription);
  const words: WordEntry[] = [];
  const paragraphs: ParagraphEntry[] = [];

  for (const section of blob.sections ?? []) {
    for (const paragraph of section.paragraphs ?? []) {
      const paragraphWords = paragraph.words ?? [];
      if (paragraphWords.length === 0) continue;

      const firstWord = words.length;
      for (const word of paragraphWords) {
        words.push({
          text: String(word.text ?? ''),
          start: Number(word.start ?? 0),
          end: Number(word.end ?? 0),
        });
      }

      paragraphs.push({
        index: paragraphs.length,
        speaker: String(paragraph.speaker ?? 'Unknown'),
        firstWord,
        lastWord: words.length - 1,
        text: paragraphWords.map((word: { text?: string }) => String(word.text ?? '')).join(' '),
      });
    }
  }

  return { words, paragraphs };
}

/** Punctuation-insensitive token used for matching entity names to words. */
function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9'’-]/g, '')
    .replace(/^['’-]+|['’-]+$/g, '');
}

function tokenize(value: string): string[] {
  return value.split(/\s+/).map(normalizeToken).filter(Boolean);
}

/** Same as normalizeToken but keeps case, so "US" can be told from "us". */
function normalizeTokenCased(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9'\u2019-]/g, '')
    .replace(/^['\u2019-]+|['\u2019-]+$/g, '');
}

function tokenizeCased(value: string): string[] {
  return value.split(/\s+/).map(normalizeTokenCased).filter(Boolean);
}

/**
 * Never treat these as entity surface forms. Short acronyms collide with common
 * words once case is discarded - "US" (the country) vs. the pronoun "us" - so
 * such forms are matched case-sensitively instead (see isAcronymForm).
 */
const PRONOUNS = new Set([
  'i', 'me', 'my', 'mine', 'myself',
  'you', 'your', 'yours', 'yourself',
  'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself',
  'we', 'us', 'our', 'ours', 'ourselves',
  'they', 'them', 'their', 'theirs', 'themselves',
  'this', 'that', 'these', 'those', 'there', 'here',
]);

/** A short all-caps form such as "US", "MIT", "NASA", "U.S.". */
function isAcronymForm(surface: string): boolean {
  const stripped = surface.replace(/[^A-Za-z]/g, '');
  return stripped.length > 0 && stripped.length <= 4 && stripped === stripped.toUpperCase();
}

/* -------------------------------------------------------------- claude */

function buildWindows(paragraphs: ParagraphEntry[]): ParagraphEntry[][] {
  const windows: ParagraphEntry[][] = [];
  let current: ParagraphEntry[] = [];
  let currentWords = 0;

  for (const paragraph of paragraphs) {
    const size = paragraph.lastWord - paragraph.firstWord + 1;
    if (currentWords + size > WORDS_PER_WINDOW && current.length > 0) {
      windows.push(current);
      current = [];
      currentWords = 0;
    }
    current.push(paragraph);
    currentWords += size;
  }

  if (current.length > 0) windows.push(current);
  return windows;
}

const SYSTEM_PROMPT = `You extract named entities from oral history interview transcripts for a research archive.

Return ONLY real, specific named entities - things a researcher would want to search or browse by.

Include:
- Named people (full names where given), organizations, institutions, companies
- Named places (cities, states, countries, neighbourhoods, campuses, buildings)
- Specific dates and named time periods ("April 30th, 1960", "the Great Depression")
- Named events, named awards, named publications/books, named technologies, named social movements, named languages

Exclude, without exception:
- Pronouns and possessives ("I", "you", "he", "we", "my", "your")
- Generic role or kinship nouns with no name ("dad", "mother", "the professor", "people", "the company")
- Generic nouns, filler words, verbs, adjectives
- Vague time references ("later", "back then", "a few years ago")
- Anything you are not confident is a specific named entity

For each entity give:
- "name": the canonical form (e.g. "Maynard Ansley Holliday", "Carnegie Mellon University")
- "label": exactly one of the allowed labels
- "aliases": every other surface form used in THIS excerpt for the same entity, exactly as transcribed (e.g. ["Holliday", "Maynard", "Carnegie Mellon"]). Omit or use [] if none.

Deduplicate: one object per distinct entity, not one per mention.

Respond with a JSON array only - no prose, no markdown fence.`;

function buildUserPrompt(windowParagraphs: ParagraphEntry[], labels: string[]): string {
  const transcript = windowParagraphs
    .map((paragraph) => `[${paragraph.speaker}] ${paragraph.text}`)
    .join('\n\n');

  return `Allowed labels (use these exact strings): ${labels.join(', ')}

Transcript excerpt:
"""
${transcript}
"""

Return the JSON array of entities found in this excerpt.`;
}

function parseEntityJson(raw: string): ClaudeEntity[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => item && typeof item.name === 'string' && typeof item.label === 'string')
      .map((item) => ({
        name: item.name.trim(),
        label: item.label.trim().toLowerCase(),
        aliases: Array.isArray(item.aliases)
          ? item.aliases.filter((alias: unknown) => typeof alias === 'string').map((alias: string) => alias.trim())
          : [],
      }));
  } catch {
    return [];
  }
}

async function extractWindowEntities(
  client: Anthropic,
  model: string,
  windowParagraphs: ParagraphEntry[],
  labels: string[],
): Promise<{ entities: ClaudeEntity[]; inputTokens: number; outputTokens: number }> {
  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(windowParagraphs, labels) }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return {
    entities: parseEntityJson(text),
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------ matching */

function mergeEntities(batches: ClaudeEntity[][], allowedLabels: Set<string>): ClaudeEntity[] {
  const merged = new Map<string, { name: string; labelVotes: Map<string, number>; aliases: Set<string> }>();

  for (const batch of batches) {
    for (const entity of batch) {
      if (!allowedLabels.has(entity.label)) continue;
      if (tokenize(entity.name).length === 0) continue;

      const key = tokenize(entity.name).join(' ');
      const existing = merged.get(key) ?? { name: entity.name, labelVotes: new Map(), aliases: new Set<string>() };
      existing.labelVotes.set(entity.label, (existing.labelVotes.get(entity.label) ?? 0) + 1);
      for (const alias of entity.aliases ?? []) {
        if (tokenize(alias).length > 0) existing.aliases.add(alias);
      }
      merged.set(key, existing);
    }
  }

  return [...merged.values()].map((entry) => ({
    name: entry.name,
    // Windows can disagree on a label; take the most frequent reading.
    label: [...entry.labelVotes.entries()].sort((a, b) => b[1] - a[1])[0][0],
    aliases: [...entry.aliases],
  }));
}

/**
 * Find every occurrence of each entity's surface forms in the word stream.
 * Longer forms win, so "Carnegie Mellon University" is not also counted as a
 * separate "Carnegie Mellon" occurrence at the same position.
 */
function locateOccurrences(entities: ClaudeEntity[], words: WordEntry[]): Occurrence[] {
  const tokens = words.map((word) => normalizeToken(word.text));
  const tokensCased = words.map((word) => normalizeTokenCased(word.text));

  type Form = { tokens: string[]; label: string; display: string; caseSensitive: boolean };
  const forms: Form[] = [];

  for (const entity of entities) {
    const surfaceForms = [entity.name, ...(entity.aliases ?? [])];
    for (const surface of surfaceForms) {
      const formTokens = tokenize(surface);
      // Single-character forms match far too much to be useful.
      if (formTokens.length === 0 || formTokens.join('').length < 2) continue;

      const caseSensitive = formTokens.length === 1 && isAcronymForm(surface);

      // A lowercase pronoun is never an entity mention. Acronyms that merely
      // collide with one ("US") are kept, but matched with case respected.
      if (!caseSensitive && formTokens.some((token) => PRONOUNS.has(token))) continue;

      forms.push({
        tokens: caseSensitive ? tokenizeCased(surface) : formTokens,
        label: entity.label,
        display: entity.name,
        caseSensitive,
      });
    }
  }

  forms.sort((a, b) => b.tokens.length - a.tokens.length);

  const claimed = new Uint8Array(words.length);
  const occurrences: Occurrence[] = [];

  for (const form of forms) {
    const width = form.tokens.length;

    const haystack = form.caseSensitive ? tokensCased : tokens;

    for (let i = 0; i + width <= haystack.length; i++) {
      let matched = true;
      for (let j = 0; j < width; j++) {
        if (haystack[i + j] !== form.tokens[j]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      let overlaps = false;
      for (let j = 0; j < width; j++) {
        if (claimed[i + j]) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      for (let j = 0; j < width; j++) claimed[i + j] = 1;

      occurrences.push({
        text: words
          .slice(i, i + width)
          .map((word) => word.text)
          .join(' ')
          .replace(/[,.;:!?]+$/, ''),
        label: form.label,
        start_time: words[i].start,
        end_time: words[i + width - 1].end,
        start_word: i,
        end_word: i + width - 1,
      });
    }
  }

  return occurrences.sort((a, b) => a.start_time - b.start_time);
}

/* --------------------------------------------------------------- cache */

/**
 * The model's entity list is cached per recording so the matching logic can be
 * re-tuned and re-applied without paying for extraction again.
 */
async function readCache(options: Options, uuid: string): Promise<ClaudeEntity[] | null> {
  try {
    const raw = await readFile(join(options.cacheDir, `${uuid}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entities) ? parsed.entities : null;
  } catch {
    return null;
  }
}

async function writeCache(options: Options, uuid: string, title: string, entities: ClaudeEntity[]): Promise<void> {
  await mkdir(options.cacheDir, { recursive: true });
  await writeFile(
    join(options.cacheDir, `${uuid}.json`),
    JSON.stringify({ uuid, title, model: options.model, extractedAt: new Date().toISOString(), entities }, null, 2),
  );
}

/* ---------------------------------------------------------------- main */

async function loadAllowedLabels(): Promise<string[]> {
  const raw = await readFile('./config.json', 'utf8');
  const parsed = JSON.parse(raw);
  const labels = (parsed?.ner?.labels ?? [])
    .map((label: { id?: string }) => String(label?.id ?? '').trim().toLowerCase())
    .filter(Boolean);

  if (labels.length === 0) throw new Error('No ner.labels found in config.json');
  return labels;
}

type TestimonyRow = { uuid: string; title: string; transcription: string };

async function fetchTestimonies(options: Options): Promise<TestimonyRow[]> {
  const filter = options.uuid
    ? ''
    : options.title
      ? `where: {path: ["interview_title"], operator: Equal, valueText: ${JSON.stringify(options.title)}}, `
      : '';

  const data = await graphql<{ Get: { Testimonies: any[] } }>(
    `{Get{Testimonies(${filter}limit: 200){interview_title transcription _additional{id}}}}`,
  );

  return (data.Get.Testimonies ?? [])
    .map((row) => ({
      uuid: row._additional.id as string,
      title: String(row.interview_title ?? ''),
      transcription: String(row.transcription ?? ''),
    }))
    .filter((row) => (options.uuid ? row.uuid === options.uuid : true))
    .filter((row) => row.transcription.length > 0);
}

async function fetchChunks(title: string): Promise<{ uuid: string; start: number; end: number }[]> {
  const collected: { uuid: string; start: number; end: number }[] = [];
  const seen = new Set<string>();

  // `after` cursors cannot be combined with `where`, so page by offset instead.
  for (let offset = 0; ; offset += 200) {
    const data = await graphql<{ Get: { Chunks: any[] } }>(
      `{Get{Chunks(limit: 200, offset: ${offset}, where: {path: ["interview_title"], operator: Equal, valueText: ${JSON.stringify(
        title,
      )}}){start_time end_time _additional{id}}}}`,
    );

    const rows = data.Get.Chunks ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const uuid = row._additional.id as string;
      if (seen.has(uuid)) continue;
      seen.add(uuid);
      collected.push({ uuid, start: Number(row.start_time ?? 0), end: Number(row.end_time ?? 0) });
    }

    if (rows.length < 200) break;
  }

  return collected;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const allowedLabels = await loadAllowedLabels();
  const client = new Anthropic({ apiKey });
  const testimonies = await fetchTestimonies(options);

  if (testimonies.length === 0) {
    console.log('[entities] No matching recordings found.');
    return;
  }

  console.log(`[entities] Model: ${options.model}`);
  console.log(`[entities] Labels: ${allowedLabels.join(', ')}`);
  console.log(`[entities] Recordings: ${testimonies.length}${options.dryRun ? ' (dry run)' : ''}\n`);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const testimony of testimonies) {
    const { words, paragraphs } = buildWordStream(testimony.transcription);
    const windows = buildWindows(paragraphs);

    const cached = options.fromCache ? await readCache(options, testimony.uuid) : null;

    if (cached) {
      console.log(`[entities] ${testimony.title}: ${words.length} words, ${cached.length} cached entities`);
    } else {
      console.log(`[entities] ${testimony.title}: ${words.length} words, ${windows.length} window(s)`);
    }

    let entities: ClaudeEntity[];

    if (cached) {
      entities = cached;
    } else {
      const batches = await mapWithConcurrency(windows, WINDOW_CONCURRENCY, async (windowParagraphs, index) => {
        const result = await extractWindowEntities(client, options.model, windowParagraphs, allowedLabels);
        totalInputTokens += result.inputTokens;
        totalOutputTokens += result.outputTokens;
        process.stdout.write(`    window ${index + 1}/${windows.length}: ${result.entities.length} entities\r`);
        return result.entities;
      });

      entities = mergeEntities(batches, new Set(allowedLabels));
      await writeCache(options, testimony.uuid, testimony.title, entities);
    }
    const occurrences = locateOccurrences(entities, words);
    const labels = [...new Set(occurrences.map((occurrence) => occurrence.label))];

    console.log(
      `\n    ${entities.length} distinct entities -> ${occurrences.length} occurrences across ${labels.length} label(s)`,
    );

    const byLabel = new Map<string, number>();
    for (const occurrence of occurrences) {
      byLabel.set(occurrence.label, (byLabel.get(occurrence.label) ?? 0) + 1);
    }
    console.log(
      `    ${[...byLabel.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => `${label}=${count}`)
        .join(' ')}`,
    );

    if (options.dryRun) {
      console.log(
        `    sample: ${entities
          .slice(0, 12)
          .map((entity) => `${entity.name} (${entity.label})`)
          .join(', ')}\n`,
      );
      continue;
    }

    await patchObject('Testimonies', testimony.uuid, {
      ner_data: occurrences,
      ner_labels: labels,
    });

    const chunks = await fetchChunks(testimony.title);
    let patchedChunks = 0;

    for (const chunk of chunks) {
      const chunkOccurrences = occurrences.filter(
        (occurrence) => occurrence.start_time >= chunk.start && occurrence.start_time <= chunk.end,
      );

      await patchObject('Chunks', chunk.uuid, {
        ner_data: chunkOccurrences.map(({ text, label, start_time, end_time }) => ({
          text,
          label,
          start_time,
          end_time,
        })),
        ner_labels: [...new Set(chunkOccurrences.map((occurrence) => occurrence.label))],
        ner_text: chunkOccurrences.map((occurrence) => occurrence.text),
      });
      patchedChunks++;
    }

    console.log(`    updated testimony + ${patchedChunks} chunk(s)\n`);
  }

  console.log(`[entities] Tokens: ${totalInputTokens} in / ${totalOutputTokens} out`);
  console.log('[entities] Done.');
}

run().catch((error) => {
  console.error(`[entities] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
