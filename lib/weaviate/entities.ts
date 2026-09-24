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

/**
 * Chunking overlaps by design, so one spoken mention is carried by two or three
 * neighbouring chunks and its entity is repeated in each. Counting raw entries
 * therefore overstates the collection by about a quarter. An occurrence is
 * identified by where it is spoken, not by how many chunks happen to cover it.
 */
const OCCURRENCE_TIME_PRECISION = 2;

const occurrenceKey = (storyUuid: string, label: string, start: number, text: string) =>
  `${storyUuid}::${label}::${start.toFixed(OCCURRENCE_TIME_PRECISION)}::${text.toLowerCase()}`;

export type EntityOccurrence = {
  /** Seconds into the recording. */
  start: number;
  end?: number;
  /** The surface form actually spoken at this moment. */
  text: string;
};

export type EntityStoryRef = {
  storyUuid: string;
  interviewTitle: string;
  mentions: number;
  /** Earliest mention in that recording, for a deep link into the player. */
  firstStartTime?: number;
  /**
   * Every mention in this recording, earliest first, so a reader can jump
   * between them. Capped — a name repeated hundreds of times in one interview
   * is navigated by scrubbing, not by a list that long.
   */
  occurrences: EntityOccurrence[];
};

const MAX_OCCURRENCES_PER_STORY = 200;

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

type NerDatum = { text?: unknown; label?: unknown; start_time?: unknown; end_time?: unknown };

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
  stories: Map<
    string,
    { interviewTitle: string; mentions: number; firstStartTime?: number; occurrences: EntityOccurrence[] }
  >;
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
      .map(([storyUuid, story]) => ({
        storyUuid,
        ...story,
        occurrences: [...story.occurrences].sort((a, b) => a.start - b.start),
      }))
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
  const seen = new Set<string>();

  for (const chunk of chunks) {
    if (!chunk.storyUuid) continue;

    for (const datum of chunk.nerData ?? []) {
      const text = String(datum?.text ?? '').trim();
      const label = String(datum?.label ?? '').trim();
      if (!text || !label) continue;

      // Skip the same mention arriving again from an overlapping chunk.
      const start = Number(datum?.start_time);
      if (Number.isFinite(start)) {
        const key = occurrenceKey(chunk.storyUuid, label, start, text);
        if (seen.has(key)) continue;
        seen.add(key);
      }

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

      const startTime = start;
      const endTime = Number(datum?.end_time);
      const occurrence: EntityOccurrence | null = Number.isFinite(startTime)
        ? { start: startTime, ...(Number.isFinite(endTime) ? { end: endTime } : {}), text }
        : null;

      const story = group.stories.get(chunk.storyUuid);
      if (story) {
        story.mentions += 1;
        if (Number.isFinite(startTime) && (story.firstStartTime === undefined || startTime < story.firstStartTime)) {
          story.firstStartTime = startTime;
        }
        if (occurrence && story.occurrences.length < MAX_OCCURRENCES_PER_STORY) {
          story.occurrences.push(occurrence);
        }
      } else {
        group.stories.set(chunk.storyUuid, {
          interviewTitle: chunk.interviewTitle,
          mentions: 1,
          firstStartTime: Number.isFinite(startTime) ? startTime : undefined,
          occurrences: occurrence ? [occurrence] : [],
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

const weaviateGraphqlUrl = (): string => {
  const scheme = process.env.WEAVIATE_SECURE === 'true' ? 'https' : 'http';
  const configured = process.env.WEAVIATE_HOST_URL ?? 'localhost';
  const port = process.env.WEAVIATE_PORT ?? '8080';

  // Node's fetch resolves `localhost` to ::1 first and does not fall back to
  // IPv4, so it fails against a Weaviate bound only to 127.0.0.1 — which is
  // what docker-compose port publishing and SSH tunnels both give you. The
  // gRPC client is unaffected, so this only shows up on the REST path.
  const host = configured === 'localhost' ? '127.0.0.1' : configured;

  return `${scheme}://${host}:${port}/v1/graphql`;
};

type GraphqlChunk = {
  interview_title?: string;
  theirstory_id?: string;
  ner_data?: NerDatum[];
};

/**
 * Fetches one page of chunks over GraphQL.
 *
 * The typed gRPC client cannot serialize `ner_data` when it is named in
 * `returnProperties` — it is an object[] and the client rejects it with
 * "creating primitive value for ner_data: proto: invalid type". Elsewhere the
 * app only ever reads ner_data via fetchObjectById, which returns every
 * property and so never hits this.
 *
 * Dropping returnProperties would work but drags word_timestamps along for
 * every chunk, which is most of the collection's bytes. GraphQL asks for
 * exactly the three fields this needs.
 */
export const runWeaviateGraphql = async <T>(query: string): Promise<T> => {
  const adminKey = process.env.WEAVIATE_ADMIN_KEY;

  const response = await fetch(weaviateGraphqlUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(adminKey ? { authorization: `Bearer ${adminKey}` } : {}),
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Weaviate GraphQL returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as { data?: T; errors?: { message?: string }[] };

  if (body.errors?.length) {
    throw new Error(`Weaviate GraphQL error: ${body.errors.map((error) => error.message).join('; ')}`);
  }

  return body.data as T;
};

const fetchChunkPage = async (limit: number, offset: number): Promise<GraphqlChunk[]> => {
  const data = await runWeaviateGraphql<{ Get?: { Chunks?: GraphqlChunk[] } }>(
    `{Get{Chunks(limit:${limit},offset:${offset}){interview_title theirstory_id ner_data{text label start_time end_time}}}}`,
  );
  return data?.Get?.Chunks ?? [];
};

/**
 * Scans every chunk once and builds the aggregate in memory.
 *
 * One pass is deliberate: the per-entity filter queries used elsewhere cost a
 * round trip each, which is fine for "related recordings" on a story page but
 * would be thousands of queries to build a browse page.
 */
export const getEntityAggregates = async (): Promise<EntityAggregateResult> => {
  const chunks: EntityChunkInput[] = [];
  let offset = 0;
  let truncated = false;

  for (;;) {
    if (chunks.length >= MAX_CHUNKS) {
      truncated = true;
      break;
    }

    const page = await fetchChunkPage(CHUNK_BATCH_SIZE, offset);
    if (page.length === 0) break;

    for (const chunk of page) {
      chunks.push({
        interviewTitle: String(chunk.interview_title ?? ''),
        // theirstory_id on a chunk is its parent Testimony's uuid, which is
        // also the /story/<uuid> route param — no extra lookup needed to link.
        storyUuid: String(chunk.theirstory_id ?? ''),
        nerData: Array.isArray(chunk.ner_data) ? chunk.ner_data : [],
      });
    }

    offset += page.length;
    if (page.length < CHUNK_BATCH_SIZE) break;
  }

  return aggregateEntitiesFromChunks(chunks, truncated);
};

export type EntityRecordingOccurrences = {
  storyUuid: string;
  interviewTitle: string;
  videoUrl: string;
  isAudioFile: boolean;
  occurrences: (EntityOccurrence & { speaker: string; context: string; sectionTitle: string })[];
};

export type EntityCollectionOccurrences = {
  recordings: EntityRecordingOccurrences[];
  totalOccurrences: number;
  recordingCount: number;
};

/** Escapes a value for inline use in a Weaviate GraphQL string literal. */
const graphqlString = (value: string) => JSON.stringify(value);

/**
 * Every occurrence of one entity across the collection, deduplicated.
 *
 * The chunk-filtered search used elsewhere returns passages, and because
 * chunking overlaps, one spoken mention comes back as two or three
 * near-identical passages — which both inflates the count and shows the reader
 * the same moment repeatedly. This resolves chunks down to the distinct moments
 * the entity is actually spoken, keeping one passage per moment for context, so
 * it agrees with the entity map.
 */
export const getEntityOccurrencesAcrossCollection = async (
  entityText: string,
  entityLabel: string,
  /**
   * Other spellings of the same entity. The map groups transcription variants
   * (`Stanford."`, `Stanford—`) under one name, so without them the modal
   * reports fewer mentions than the square the reader just clicked.
   */
  variants: string[] = [],
): Promise<EntityCollectionOccurrences> => {
  const needle = entityText.trim();
  if (!needle || !entityLabel.trim()) {
    return { recordings: [], totalOccurrences: 0, recordingCount: 0 };
  }

  const forms = Array.from(
    new Set([needle, ...variants.map((variant) => variant.trim()).filter(Boolean)].map((form) => form.toLowerCase())),
  );

  const data = await runWeaviateGraphql<{
    Get?: {
      Chunks?: (GraphqlChunk & {
        transcription?: string;
        speaker?: string;
        section_title?: string;
        video_url?: string;
        isAudioFile?: boolean;
      })[];
    };
  }>(
    `{Get{Chunks(limit:10000,where:{operator:And,operands:[` +
      `{path:["ner_text"],operator:ContainsAny,valueText:[${forms.map(graphqlString).join(',')}]},` +
      `{path:["ner_labels"],operator:ContainsAny,valueText:[${graphqlString(entityLabel)}]}` +
      `]}){interview_title theirstory_id speaker transcription section_title video_url isAudioFile ner_data{text label start_time end_time}}}}`,
  );

  const byRecording = new Map<string, EntityRecordingOccurrences>();
  const seen = new Set<string>();

  for (const chunk of data?.Get?.Chunks ?? []) {
    const storyUuid = String(chunk.theirstory_id ?? '');
    if (!storyUuid) continue;

    for (const datum of chunk.ner_data ?? []) {
      const text = String(datum?.text ?? '').trim();
      const label = String(datum?.label ?? '').trim();
      if (!text || label !== entityLabel) continue;
      if (!forms.includes(text.toLowerCase())) continue;

      const start = Number(datum?.start_time);
      if (!Number.isFinite(start)) continue;

      const key = occurrenceKey(storyUuid, label, start, text);
      if (seen.has(key)) continue;
      seen.add(key);

      let recording = byRecording.get(storyUuid);
      if (!recording) {
        recording = {
          storyUuid,
          interviewTitle: String(chunk.interview_title ?? 'Unknown recording'),
          videoUrl: String(chunk.video_url ?? ''),
          isAudioFile: Boolean(chunk.isAudioFile),
          occurrences: [],
        };
        byRecording.set(storyUuid, recording);
      }

      const end = Number(datum?.end_time);
      recording.occurrences.push({
        start,
        ...(Number.isFinite(end) ? { end } : {}),
        text,
        speaker: String(chunk.speaker ?? ''),
        sectionTitle: String(chunk.section_title ?? ''),
        // The passage that carries this moment, for context around the name.
        context: String(chunk.transcription ?? ''),
      });
    }
  }

  const recordings = Array.from(byRecording.values())
    .map((recording) => ({
      ...recording,
      occurrences: recording.occurrences.sort((a, b) => a.start - b.start),
    }))
    .sort((a, b) => b.occurrences.length - a.occurrences.length);

  return {
    recordings,
    totalOccurrences: recordings.reduce((sum, recording) => sum + recording.occurrences.length, 0),
    recordingCount: recordings.length,
  };
};
