import { initWeaviateClient } from '@/lib/weaviate/client';
import { Chunks } from '@/types/weaviate';

/**
 * Named entities rolled up across every recording in the collection.
 *
 * Entities are stored per chunk, so the story page can only answer "who is
 * mentioned in this recording?". The question curators actually ask is the
 * reverse — "where does this person appear across the whole collection?" —
 * which needs every mention of an entity gathered with the recordings it
 * appears in.
 *
 * Surface forms are grouped case- and punctuation-insensitively, so the
 * transcription variants of one name (`Bay Area`, `Bay area`, `Bay Area—`)
 * arrive as a single row carrying its variants rather than as near-duplicates
 * the reader has to reconcile. This is the cleanup Stanford asked for after
 * seeing `Stanford`, `Stanford."` and `Stanford?"` listed separately.
 */
const CHUNK_BATCH_SIZE = 500;
const MAX_CHUNKS = 50_000;

export type EntityStoryRef = {
  storyUuid: string;
  interviewTitle: string;
  mentions: number;
  /** Earliest mention in that recording, for a deep link into the player. */
  firstStartTime?: number;
};

export type EntityVariant = {
  text: string;
  mentions: number;
};

export type EntityAggregate = {
  /** Cleanest surface form; what the UI shows. */
  text: string;
  label: string;
  /** Normalized grouping key: lowercased, unpunctuated, article-stripped. */
  key: string;
  mentions: number;
  /** Every spelling seen in the transcripts, most frequent first. */
  variants: EntityVariant[];
  stories: EntityStoryRef[];
};

export type EntityAggregateResult = {
  entities: EntityAggregate[];
  labels: { label: string; distinctEntities: number }[];
  totalMentions: number;
  /** True when the scan hit its ceiling and the aggregate may be partial. */
  truncated: boolean;
};

type NerDatum = { text?: unknown; label?: unknown; start_time?: unknown };

export const normalizeEntityKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/['‘’]s\b/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9&\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const TRIM_EDGES = /^[\s"'“”([]+|[\s"'“”.,;:!?)\]—-]+$/g;

const hasEdgePunctuation = (value: string) => value !== value.replace(TRIM_EDGES, '');

const capitalizationScore = (value: string): number => {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  return words.filter((word) => /^[A-Z0-9]/.test(word)).length / words.length;
};

/**
 * Chooses the display form for a group: clean before punctuated, better
 * capitalized before worse, then most frequent.
 *
 * Frequency alone is the wrong rule — it picks `Bay area` over `Bay Area`
 * purely because one speaker's transcript is longer than the others.
 */
export const pickCanonicalForm = (variants: EntityVariant[]): string => {
  const sorted = [...variants].sort((a, b) => {
    const dirtyDelta = Number(hasEdgePunctuation(a.text)) - Number(hasEdgePunctuation(b.text));
    if (dirtyDelta !== 0) return dirtyDelta;

    const capDelta = capitalizationScore(b.text) - capitalizationScore(a.text);
    if (Math.abs(capDelta) > 0.01) return capDelta;

    if (a.mentions !== b.mentions) return b.mentions - a.mentions;
    return a.text.length - b.text.length;
  });

  return sorted[0]?.text ?? '';
};

type GroupAccumulator = {
  key: string;
  label: string;
  mentions: number;
  variants: Map<string, number>;
  stories: Map<string, { interviewTitle: string; mentions: number; firstStartTime?: number }>;
};

/** One chunk's worth of input to the aggregate. */
export type EntityChunkInput = {
  interviewTitle: string;
  storyUuid: string;
  nerData: NerDatum[];
};

const toAggregate = (group: GroupAccumulator): EntityAggregate => {
  const variants = Array.from(group.variants.entries())
    .map(([text, mentions]) => ({ text, mentions }))
    .sort((a, b) => b.mentions - a.mentions || a.text.localeCompare(b.text));

  return {
    text: pickCanonicalForm(variants),
    label: group.label,
    key: group.key,
    mentions: group.mentions,
    variants,
    stories: Array.from(group.stories.entries())
      .map(([storyUuid, story]) => ({ storyUuid, ...story }))
      .sort((a, b) => b.mentions - a.mentions),
  };
};

/**
 * Builds the aggregate from already-fetched chunks.
 *
 * Kept separate from the query so the grouping rules can be exercised against
 * a real export of the collection without standing up Weaviate.
 */
export const aggregateEntitiesFromChunks = (chunks: EntityChunkInput[], truncated = false): EntityAggregateResult => {
  const groups = new Map<string, GroupAccumulator>();

  for (const chunk of chunks) {
    if (!chunk.storyUuid) continue;

    for (const datum of chunk.nerData ?? []) {
      const text = String(datum?.text ?? '').trim();
      const label = String(datum?.label ?? '').trim();
      if (!text || !label) continue;

      const normalized = normalizeEntityKey(text);
      if (!normalized) continue;

      const groupKey = `${normalized}::${label}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { key: normalized, label, mentions: 0, variants: new Map(), stories: new Map() };
        groups.set(groupKey, group);
      }

      group.mentions += 1;
      group.variants.set(text, (group.variants.get(text) ?? 0) + 1);

      const startTime = Number(datum?.start_time);
      const story = group.stories.get(chunk.storyUuid);
      if (story) {
        story.mentions += 1;
        if (Number.isFinite(startTime) && (story.firstStartTime === undefined || startTime < story.firstStartTime)) {
          story.firstStartTime = startTime;
        }
      } else {
        group.stories.set(chunk.storyUuid, {
          interviewTitle: chunk.interviewTitle,
          mentions: 1,
          firstStartTime: Number.isFinite(startTime) ? startTime : undefined,
        });
      }
    }
  }

  const entities = Array.from(groups.values())
    .map(toAggregate)
    .sort((a, b) => b.mentions - a.mentions || a.text.localeCompare(b.text));

  const labelCounts = new Map<string, number>();
  entities.forEach((entity) => labelCounts.set(entity.label, (labelCounts.get(entity.label) ?? 0) + 1));

  return {
    entities,
    labels: Array.from(labelCounts.entries())
      .map(([label, distinctEntities]) => ({ label, distinctEntities }))
      .sort((a, b) => b.distinctEntities - a.distinctEntities || a.label.localeCompare(b.label)),
    totalMentions: entities.reduce((sum, entity) => sum + entity.mentions, 0),
    truncated,
  };
};

/**
 * Scans every chunk once and builds the aggregate in memory.
 *
 * One pass is deliberate: the per-entity filter queries used elsewhere cost a
 * round trip each, which is fine for "related recordings" on a story page but
 * would be thousands of queries to build a browse page.
 */
export const getEntityAggregates = async (): Promise<EntityAggregateResult> => {
  const client = await initWeaviateClient();
  const collection = client.collections.get<Chunks>('Chunks');

  const chunks: EntityChunkInput[] = [];
  let offset = 0;
  let truncated = false;

  for (;;) {
    if (chunks.length >= MAX_CHUNKS) {
      truncated = true;
      break;
    }

    const response = await collection.query.fetchObjects({
      limit: CHUNK_BATCH_SIZE,
      offset,
      returnProperties: ['ner_data', 'interview_title', 'theirstory_id'] as never,
    });

    const objects = response?.objects ?? [];
    if (objects.length === 0) break;

    for (const object of objects) {
      const properties = (object.properties ?? {}) as Partial<Chunks>;
      chunks.push({
        interviewTitle: String(properties.interview_title ?? ''),
        // theirstory_id on a chunk is its parent Testimony's uuid, which is
        // also the /story/<uuid> route param — no extra lookup needed to link.
        storyUuid: String(properties.theirstory_id ?? ''),
        nerData: Array.isArray(properties.ner_data) ? properties.ner_data : [],
      });
    }

    offset += objects.length;
    if (objects.length < CHUNK_BATCH_SIZE) break;
  }

  return aggregateEntitiesFromChunks(chunks, truncated);
};
