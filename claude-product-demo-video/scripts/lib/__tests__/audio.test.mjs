/**
 * audio — regressions for the two ways this pipeline has lied about audio:
 * a voiceover cache that kept the old take after a script rewrite, and a
 * licensing record that omitted the track that actually shipped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { voiceCacheKey } from '../voice.mjs';
import { selectTrack, writeAttribution } from '../music.mjs';

const base = { text: 'Acme ships payouts on Tuesday.', provider: 'say', voiceId: null, rateWpm: 165, gainDb: 0 };

test('voiceCacheKey changes when the narration changes', () => {
  const edited = { ...base, text: 'Acme ships payouts on Thursday.' };
  assert.notEqual(voiceCacheKey(base), voiceCacheKey(edited));
});

test('voiceCacheKey is stable for identical inputs', () => {
  assert.equal(voiceCacheKey(base), voiceCacheKey({ ...base }));
});

test('voiceCacheKey covers provider, voiceId, rate and gain', () => {
  for (const delta of [{ provider: 'openai' }, { voiceId: 'alloy' }, { rateWpm: 180 }, { gainDb: -3 }]) {
    assert.notEqual(voiceCacheKey(base), voiceCacheKey({ ...base, ...delta }), `${Object.keys(delta)[0]} not keyed`);
  }
});

const catalogue = {
  tracks: [
    { id: 'by-a', mood: 'calm', license: 'CC BY 4.0', attributionRequired: true },
    { id: 'by-b', mood: 'calm', license: 'CC BY 4.0', attributionRequired: true },
    { id: 'zero-a', mood: 'calm', license: 'CC0 1.0', attributionRequired: false },
    { id: 'by-c', mood: 'energetic', license: 'CC BY 4.0', attributionRequired: true },
  ],
};

test('selectTrack prefers CC0 when the storyboard pins no track', () => {
  const pick = selectTrack({ meta: { slug: 'acme-payouts' }, audio: { music: { mood: 'calm' } } }, catalogue);
  assert.equal(pick.id, 'zero-a');
});

test('selectTrack falls back to CC-BY when a mood has no CC0 entry', () => {
  const pick = selectTrack({ meta: { slug: 'acme-payouts' }, audio: { music: { mood: 'energetic' } } }, catalogue);
  assert.equal(pick.id, 'by-c');
});

test('an explicit trackId still wins over the CC0 preference', () => {
  const pick = selectTrack({ meta: { slug: 'acme-payouts' }, audio: { music: { trackId: 'by-a' } } }, catalogue);
  assert.equal(pick.id, 'by-a');
});

test('ATTRIBUTION.md records an operator-supplied track with no declared licence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdv-attr-'));
  await writeAttribution(dir, [
    {
      id: 'local',
      title: 'brand-bed.wav',
      artist: null,
      source: 'operator-supplied (--music-file)',
      license: 'not declared',
      attributionRequired: true,
      attributionLine: '"brand-bed.wav" — user-supplied track, licence not declared.',
      localFile: 'local.wav',
    },
  ]);
  const md = await readFile(join(dir, 'ATTRIBUTION.md'), 'utf8');
  assert.match(md, /brand-bed\.wav/);
  assert.match(md, /licence not declared/);
  assert.doesNotMatch(md, /No third-party music was used/);
});

test('ATTRIBUTION.md still lists a CC0 track even though attribution is not required', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdv-attr-'));
  await writeAttribution(dir, [
    { id: 'zero-a', title: 'A Public Domain Piece', artist: 'unnamed', license: 'CC0 1.0', attributionRequired: false },
  ]);
  const md = await readFile(join(dir, 'ATTRIBUTION.md'), 'utf8');
  assert.match(md, /A Public Domain Piece/);
  assert.doesNotMatch(md, /No third-party music was used/);
});

test('ATTRIBUTION.md says so plainly when nothing was used', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdv-attr-'));
  await writeAttribution(dir, []);
  const md = await readFile(join(dir, 'ATTRIBUTION.md'), 'utf8');
  assert.match(md, /No third-party music was used/);
});
