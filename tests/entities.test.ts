import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregateEntitiesFromChunks,
  normalizeEntityKey,
  pickCanonicalForm,
  type EntityChunkInput,
} from '../lib/weaviate/entities';

const chunk = (storyUuid: string, interviewTitle: string, entities: [string, string, number?][]): EntityChunkInput => ({
  storyUuid,
  interviewTitle,
  nerData: entities.map(([text, label, start_time]) => ({ text, label, start_time })),
});

describe('normalizeEntityKey', () => {
  it('groups the transcription variants Stanford flagged', () => {
    const key = normalizeEntityKey('Stanford');
    for (const variant of ['Stanford."', 'Stanford?"', 'Stanford—', '  stanford  ']) {
      assert.equal(normalizeEntityKey(variant), key);
    }
  });

  it('ignores case and leading articles', () => {
    assert.equal(normalizeEntityKey('Bay area'), normalizeEntityKey('Bay Area'));
    assert.equal(normalizeEntityKey('The Bay Area'), normalizeEntityKey('Bay Area'));
  });

  it('strips possessives so "Stanford\'s" joins "Stanford"', () => {
    assert.equal(normalizeEntityKey("Stanford's"), normalizeEntityKey('Stanford'));
  });

  it('keeps genuinely different names apart', () => {
    assert.notEqual(normalizeEntityKey('Steve Jobs'), normalizeEntityKey('Steve'));
    assert.notEqual(normalizeEntityKey('HP'), normalizeEntityKey('Hewlett-Packard'));
  });
});

describe('pickCanonicalForm', () => {
  it('prefers better capitalization over raw frequency', () => {
    // The real case: "Bay area" outnumbers "Bay Area" only because one
    // speaker's transcript is longer.
    const canonical = pickCanonicalForm([
      { text: 'Bay area', mentions: 26 },
      { text: 'Bay Area', mentions: 9 },
    ]);
    assert.equal(canonical, 'Bay Area');
  });

  it('prefers a clean form over a punctuated one', () => {
    const canonical = pickCanonicalForm([
      { text: 'Stanford."', mentions: 50 },
      { text: 'Stanford', mentions: 3 },
    ]);
    assert.equal(canonical, 'Stanford');
  });

  it('falls back to frequency when forms are equally clean', () => {
    const canonical = pickCanonicalForm([
      { text: 'Apple', mentions: 5 },
      { text: 'APPLE', mentions: 2 },
    ]);
    assert.equal(canonical, 'Apple');
  });
});

describe('aggregateEntitiesFromChunks', () => {
  it('rolls one entity up across recordings', () => {
    const result = aggregateEntitiesFromChunks([
      chunk('uuid-a', 'Theresa Isaacs', [['Stanford', 'organization', 100]]),
      chunk('uuid-b', 'Cody Coleman', [['Stanford', 'organization', 50]]),
      chunk('uuid-a', 'Theresa Isaacs', [['Stanford', 'organization', 200]]),
    ]);

    assert.equal(result.entities.length, 1);
    const [entity] = result.entities;
    assert.equal(entity.mentions, 3);
    assert.equal(entity.stories.length, 2);
    // Most-mentioned recording first.
    assert.equal(entity.stories[0].interviewTitle, 'Theresa Isaacs');
    assert.equal(entity.stories[0].mentions, 2);
    // Earliest mention in that recording, for the deep link.
    assert.equal(entity.stories[0].firstStartTime, 100);
  });

  it('merges variants into one row that carries its spellings', () => {
    const result = aggregateEntitiesFromChunks([
      chunk('uuid-a', 'A', [
        ['Bay area', 'location'],
        ['Bay area', 'location'],
      ]),
      chunk('uuid-b', 'B', [
        ['Bay Area', 'location'],
        ['Bay Area—', 'location'],
      ]),
    ]);

    assert.equal(result.entities.length, 1);
    assert.equal(result.entities[0].text, 'Bay Area');
    assert.equal(result.entities[0].mentions, 4);
    assert.equal(result.entities[0].variants.length, 3);
  });

  it('keeps the same surface form apart when labelled differently', () => {
    const result = aggregateEntitiesFromChunks([
      chunk('uuid-a', 'A', [
        ['Washington', 'location'],
        ['Washington', 'person'],
      ]),
    ]);

    assert.equal(result.entities.length, 2);
    assert.deepEqual(result.entities.map((entity) => entity.label).sort(), ['location', 'person']);
  });

  it('skips entities with no text or label, and chunks with no story', () => {
    const result = aggregateEntitiesFromChunks([
      chunk('uuid-a', 'A', [
        ['', 'organization'],
        ['  ', 'person'],
        ['Valid', 'organization'],
      ]),
      chunk('', 'orphan chunk', [['Ignored', 'organization']]),
      { storyUuid: 'uuid-b', interviewTitle: 'B', nerData: [{ text: 'NoLabel' }] },
    ]);

    assert.deepEqual(
      result.entities.map((entity) => entity.text),
      ['Valid'],
    );
  });

  it('sorts by mentions and counts labels', () => {
    const result = aggregateEntitiesFromChunks([
      chunk('uuid-a', 'A', [
        ['Rare', 'person'],
        ['Common', 'organization'],
        ['Common', 'organization'],
      ]),
    ]);

    assert.deepEqual(
      result.entities.map((entity) => entity.text),
      ['Common', 'Rare'],
    );
    assert.equal(result.totalMentions, 3);
    assert.deepEqual(result.labels, [
      { label: 'organization', distinctEntities: 1 },
      { label: 'person', distinctEntities: 1 },
    ]);
  });

  it('returns an empty result for no chunks rather than throwing', () => {
    const result = aggregateEntitiesFromChunks([]);
    assert.deepEqual(result.entities, []);
    assert.equal(result.totalMentions, 0);
    assert.equal(result.truncated, false);
  });
});

describe('overlapping chunks', () => {
  it('counts a mention once even when several chunks carry it', () => {
    // Chunking overlaps, so the same spoken mention is repeated in neighbouring
    // chunks. Counting raw entries overstated this collection by ~25%.
    const result = aggregateEntitiesFromChunks([
      chunk('uuid-a', 'A', [['Stanford', 'organization', 100.0]]),
      chunk('uuid-a', 'A', [['Stanford', 'organization', 100.0]]),
      chunk('uuid-a', 'A', [['Stanford', 'organization', 100.004]]),
    ]);

    assert.equal(result.entities.length, 1);
    assert.equal(result.entities[0].mentions, 1);
    assert.equal(result.entities[0].stories[0].mentions, 1);
    assert.equal(result.entities[0].stories[0].occurrences.length, 1);
  });

  it('keeps genuinely separate mentions of the same name', () => {
    const result = aggregateEntitiesFromChunks([
      chunk('uuid-a', 'A', [
        ['Stanford', 'organization', 100],
        ['Stanford', 'organization', 250],
      ]),
    ]);
    assert.equal(result.entities[0].mentions, 2);
  });

  it('does not merge the same timestamp across different recordings', () => {
    const result = aggregateEntitiesFromChunks([
      chunk('uuid-a', 'A', [['Stanford', 'organization', 100]]),
      chunk('uuid-b', 'B', [['Stanford', 'organization', 100]]),
    ]);
    assert.equal(result.entities[0].mentions, 2);
    assert.equal(result.entities[0].stories.length, 2);
  });
});
