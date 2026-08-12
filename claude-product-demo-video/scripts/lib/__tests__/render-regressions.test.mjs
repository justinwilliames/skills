/**
 * Regressions for four shipped defects:
 *   1. a short frames/video scene truncated the WHOLE video (no last-frame hold)
 *   2. selector autozoom was dead — resolvedTargets never reached motion.mjs
 *   3. the music manifest was read under a name music.mjs never writes
 *   4. sub-second rounding overflowed the SRT/ASS fraction instead of carrying
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveSceneDurations,
  sceneHoldSec,
  sceneVideoFilter,
  normaliseManifest,
  loadMusicSelection,
  HOLD_SLACK_SEC,
} from '../render.mjs';
import { buildMotionFilter, computeKeyframes } from '../motion.mjs';
import { formatSrtTime, formatAssTime } from '../captions.mjs';

// ---------------------------------------------------------------------------
// 1 — hold the last frame when narration outruns the captured flow
// ---------------------------------------------------------------------------

test('resolveSceneDurations reports capturedSec alongside the planned duration', () => {
  const [d] = resolveSceneDurations([{ id: 'a' }], {
    voDurations: { a: 3.4 },
    captureDurations: { a: 2 },
    padSec: 0.8,
  });
  assert.equal(Math.round(d.durationSec * 1000), 4200);
  assert.equal(d.capturedSec, 2);
});

test('sceneHoldSec: covers the deficit for frames and video, never for a still', () => {
  assert.equal(sceneHoldSec({ kind: 'frames', capturedSec: 2, durationSec: 3.57 }), 1.82);
  assert.equal(sceneHoldSec({ kind: 'video', capturedSec: 2, durationSec: 3.57 }), 1.82);
  assert.equal(sceneHoldSec({ kind: 'still', capturedSec: 2, durationSec: 3.57 }), 0);
});

test('sceneHoldSec: no hold when the capture is already long enough', () => {
  assert.equal(sceneHoldSec({ kind: 'frames', capturedSec: 6, durationSec: 4 }), 0);
  assert.equal(sceneHoldSec({ kind: 'frames', capturedSec: 4, durationSec: 4 }), 0);
});

test('sceneHoldSec: an unmeasured capture is padded for the whole scene, not left short', () => {
  assert.equal(sceneHoldSec({ kind: 'video', capturedSec: 0, durationSec: 3.5 }), 3.5);
});

test('sceneHoldSec: the pad carries slack because capturedSec is an estimate', () => {
  const hold = sceneHoldSec({ kind: 'frames', capturedSec: 1, durationSec: 2 });
  assert.equal(hold, 1 + HOLD_SLACK_SEC);
});

test('sceneVideoFilter: tpad holds the last frame BEFORE the trim, and before the motion', () => {
  const f = sceneVideoFilter({
    index: 0,
    entry: { kind: 'frames' },
    scene: {},
    fps: 30,
    width: 1920,
    height: 1080,
    durationSec: 3.57,
    capturedSec: 2,
    motionFilter: "zoompan=z='1.1':d=1",
  });
  assert.match(f, /tpad=stop_mode=clone:stop_duration=1\.82/);
  assert.ok(
    f.indexOf('tpad=') < f.indexOf('zoompan='),
    'tpad must precede zoompan so the push spreads over the padded length',
  );
  assert.ok(f.indexOf('tpad=') < f.indexOf('trim=duration='), 'tpad must precede the trim');
});

test('sceneVideoFilter: a still is never padded — -loop 1 -t already holds it', () => {
  const f = sceneVideoFilter({
    index: 0,
    entry: { kind: 'still' },
    scene: {},
    fps: 30,
    width: 1920,
    height: 1080,
    durationSec: 4,
    capturedSec: 0,
    motionFilter: null,
  });
  assert.ok(!f.includes('tpad='), f);
});

test('sceneVideoFilter: a long-enough capture emits no tpad at all', () => {
  const f = sceneVideoFilter({
    index: 1,
    entry: { kind: 'video' },
    scene: {},
    fps: 30,
    width: 1920,
    height: 1080,
    durationSec: 4,
    capturedSec: 9,
    motionFilter: null,
  });
  assert.ok(!f.includes('tpad='), f);
});

// ---------------------------------------------------------------------------
// 2 — selector autozoom must reach the element, not the frame centre
// ---------------------------------------------------------------------------

test('normaliseManifest carries the captured geometry and resolvedTargets through', () => {
  const out = normaliseManifest(
    {
      scenes: [
        {
          id: 'a',
          pattern: 'scenes/a/%06d.png',
          width: 3840,
          height: 2160,
          resolvedTargets: { '#billing': { x: 200, y: 100, w: 400, h: 200 } },
        },
      ],
    },
    { work: '/w' },
  );
  assert.equal(out.a.width, 3840);
  assert.equal(out.a.height, 2160);
  assert.deepEqual(out.a.resolvedTargets['#billing'], { x: 200, y: 100, w: 400, h: 200 });
});

test('normaliseManifest defaults resolvedTargets to an object so motion never sees undefined', () => {
  const out = normaliseManifest({ scenes: [{ id: 'a', path: 'a.png' }] });
  assert.deepEqual(out.a.resolvedTargets, {});
});

test('a selector autozoom centres on the element box, not the frame centre', () => {
  const entry = normaliseManifest(
    {
      scenes: [
        {
          id: 'a',
          pattern: 'a/%06d.png',
          width: 2000,
          height: 1000,
          // Box sits top-left: centre (0.15, 0.2), nowhere near (0.5, 0.5).
          resolvedTargets: { '#panel': { x: 200, y: 100, w: 200, h: 200 } },
        },
      ],
    },
    { work: '/w' },
  ).a;

  const args = {
    motion: { type: 'autozoom', target: '#panel' },
    scene: { id: 'a', motion: { type: 'autozoom', target: '#panel' } },
    durationSec: 4,
    fps: 30,
    width: 1920,
    height: 1080,
    geometry: { width: entry.width, height: entry.height, resolvedTargets: entry.resolvedTargets },
  };

  const keys = computeKeyframes(
    { durationMs: 4000, motion: args.motion },
    args.geometry,
    { fps: 30 },
  );
  const last = keys[keys.length - 1];
  assert.ok(last.zoom > 1.5, `expected a real push, got zoom ${last.zoom}`);
  assert.ok(Math.abs(last.cx - 0.5) > 0.05, `cx ${last.cx} is the frame centre, not the element`);
  assert.ok(Math.abs(last.cy - 0.5) > 0.05, `cy ${last.cy} is the frame centre, not the element`);

  // And the filter render.mjs actually asks for must build without throwing.
  const filter = buildMotionFilter(args);
  assert.match(filter, /zoompan=/);
});

test('without geometry the same selector throws — the bug was that nobody saw it', () => {
  assert.throws(
    () => buildMotionFilter({
      motion: { type: 'autozoom', target: '#panel' },
      scene: {},
      durationSec: 4,
      fps: 30,
      width: 1920,
      height: 1080,
    }),
    /was not resolved during capture/,
  );
});

// ---------------------------------------------------------------------------
// 3 — read the manifest music.mjs actually writes
// ---------------------------------------------------------------------------

async function musicDir(manifestName, manifest, extraFiles = []) {
  const dir = await mkdtemp(join(tmpdir(), 'pdv-music-'));
  await mkdir(dir, { recursive: true });
  for (const f of extraFiles) await writeFile(join(dir, f), 'not really audio', 'utf8');
  if (manifest) await writeFile(join(dir, manifestName), JSON.stringify(manifest), 'utf8');
  return dir;
}

test('loadMusicSelection reads music-manifest.json and honours disabled', async () => {
  const dir = await musicDir(
    'music-manifest.json',
    { disabled: true, gainDb: -12, duck: false },
    ['aaa-stale-cached.mp3'],
  );
  const sel = await loadMusicSelection(dir);
  assert.equal(sel.disabled, true);
  assert.equal(sel.path, null);
  assert.equal(sel.settings.gainDb, -12);
  assert.equal(sel.settings.duck, false);
});

test('loadMusicSelection returns the manifest track, not the first file alphabetically', async () => {
  const dir = await musicDir(
    'music-manifest.json',
    { track: { id: 'chosen', path: 'chosen.mp3' }, gainDb: -20, duck: true, fadeInMs: 900 },
    ['aaa-stale-cached.mp3', 'chosen.mp3'],
  );
  const sel = await loadMusicSelection(dir);
  assert.equal(sel.path, join(dir, 'chosen.mp3'));
  assert.equal(sel.settings.gainDb, -20);
  assert.equal(sel.settings.fadeInMs, 900);
});

test('loadMusicSelection falls back to a directory scan only when no manifest exists', async () => {
  const dir = await musicDir(null, null, ['only-track.mp3']);
  const sel = await loadMusicSelection(dir);
  assert.equal(sel.path, join(dir, 'only-track.mp3'));
  assert.equal(sel.source, 'directory-scan');
});

// ---------------------------------------------------------------------------
// 4 — sub-second rounding must carry into the seconds
// ---------------------------------------------------------------------------

test('formatSrtTime carries the rounded millisecond instead of overflowing the field', () => {
  assert.equal(formatSrtTime(0.9996), '00:00:01,000');
  assert.equal(formatSrtTime(59.9996), '00:01:00,000');
  assert.equal(formatSrtTime(3599.9996), '01:00:00,000');
  assert.equal(formatSrtTime(3661.5), '01:01:01,500');
  assert.equal(formatSrtTime(-1), '00:00:00,000');
});

test('formatAssTime carries the rounded centisecond', () => {
  assert.equal(formatAssTime(12.997), '0:00:13.00');
  assert.equal(formatAssTime(59.999), '0:01:00.00');
  assert.equal(formatAssTime(3599.999), '1:00:00.00');
  assert.equal(formatAssTime(3661.5), '1:01:01.50');
});

test('no timestamp is ever malformed across the full sub-second sweep', () => {
  const srt = /^\d{2}:[0-5]\d:[0-5]\d,\d{3}$/;
  const ass = /^\d+:[0-5]\d:[0-5]\d\.\d{2}$/;
  for (let i = 0; i < 200000; i += 1) {
    const t = (i / 200000) * 3700;
    assert.match(formatSrtTime(t), srt);
    assert.match(formatAssTime(t), ass);
  }
});
