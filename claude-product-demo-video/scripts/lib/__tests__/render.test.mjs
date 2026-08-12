import test from 'node:test';
import assert from 'node:assert/strict';

import {
  xfadeChain,
  resolveSceneDurations,
  sceneTiming,
  normaliseManifest,
  buildChainFilters,
  buildAudioFilters,
  builtinMotionFilter,
  escapeFilterPath,
  countInputs,
  MAX_GRAPH_NODES,
} from '../render.mjs';

import {
  wrapLines,
  clauseSegments,
  splitIntoCues,
  distributeCues,
  buildCues,
  toSrt,
  toAss,
  formatSrtTime,
  formatAssTime,
  assColour,
  contrastRatio,
  checkCaptionContrast,
} from '../captions.mjs';

const clip = (id, durationSec, durationMsTransition = 600, type = 'fade') => ({
  id,
  durationSec,
  transition: { type, durationSec: durationMsTransition / 1000 },
});

// ---------------------------------------------------------------------------
// xfade offsets — the bug this whole file exists to prevent
// ---------------------------------------------------------------------------

test('xfadeChain: two clips, offset is d0 - t0', () => {
  const chain = xfadeChain([clip('a', 4), clip('b', 4)]);
  assert.equal(chain.steps.length, 1);
  assert.equal(chain.steps[0].offsetSec, 3.4);
  assert.equal(chain.totalSec, 7.4);
});

test('xfadeChain: offsets subtract ALL accumulated transition durations', () => {
  const chain = xfadeChain([clip('a', 5), clip('b', 5), clip('c', 5), clip('d', 5)]);
  // naive (wrong) offsets would be 4.4 / 9.4 / 14.4
  assert.deepEqual(
    chain.steps.map((s) => s.offsetSec),
    [4.4, 8.8, 13.2],
  );
  assert.equal(chain.totalSec, 20 - 1.8);
});

test('xfadeChain: totalSec always equals sum(d) - sum(t)', () => {
  const clips = [clip('a', 3.2), clip('b', 7.9), clip('c', 2.5), clip('d', 6.1), clip('e', 4)];
  const chain = xfadeChain(clips);
  const sumD = clips.reduce((a, c) => a + c.durationSec, 0);
  const sumT = chain.transitions.reduce((a, t) => a + t.durationSec, 0);
  assert.equal(chain.totalSec, Math.round((sumD - sumT) * 1000) / 1000);
});

test('xfadeChain: each offset equals the next clip start, and starts never regress', () => {
  const clips = [clip('a', 4), clip('b', 6), clip('c', 3), clip('d', 5)];
  const chain = xfadeChain(clips);
  chain.steps.forEach((step, i) => {
    assert.equal(step.offsetSec, chain.starts[i + 1], `step ${i} offset must equal clip ${i + 1} start`);
  });
  for (let i = 1; i < chain.starts.length; i += 1) {
    assert.ok(chain.starts[i] > chain.starts[i - 1]);
  }
});

test('xfadeChain: transition is clamped to half of the shorter neighbour', () => {
  const chain = xfadeChain([clip('a', 4), clip('b', 0.8), clip('c', 4)]);
  assert.equal(chain.transitions[0].durationSec, 0.4);
  assert.equal(chain.transitions[1].durationSec, 0.4);
});

test('xfadeChain: transition type "none" collapses to a zero-length hard cut', () => {
  const chain = xfadeChain([clip('a', 3, 600, 'none'), clip('b', 3)]);
  assert.equal(chain.transitions[0].durationSec, 0);
  assert.equal(chain.totalSec, 6);
});

test('xfadeChain: single clip has no steps and total equals its duration', () => {
  const chain = xfadeChain([clip('a', 4.25)]);
  assert.deepEqual(chain.steps, []);
  assert.equal(chain.totalSec, 4.25);
  assert.deepEqual(chain.starts, [0]);
});

test('xfadeChain: empty input is total zero, not NaN', () => {
  assert.deepEqual(xfadeChain([]), { steps: [], starts: [], totalSec: 0, transitions: [] });
});

test('xfadeChain: the last transition ends exactly at totalSec', () => {
  const clips = [clip('a', 4), clip('b', 5), clip('c', 6)];
  const chain = xfadeChain(clips);
  const last = chain.steps.at(-1);
  assert.equal(round3(last.offsetSec + last.durationSec + clips.at(-1).durationSec - last.durationSec), chain.totalSec);
});

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// durations & timing
// ---------------------------------------------------------------------------

test('resolveSceneDurations: explicit durationMs wins over voiceover length', () => {
  const [d] = resolveSceneDurations([{ id: 'a', durationMs: 2500 }], { voDurations: { a: 9 } });
  assert.equal(d.durationSec, 2.5);
});

test('resolveSceneDurations: narration length plus padding when no explicit duration', () => {
  const [d] = resolveSceneDurations([{ id: 'a' }], { voDurations: { a: 3.4 }, padSec: 0.8 });
  assert.equal(round3(d.durationSec), 4.2);
  assert.equal(d.speechSec, 3.4);
});

test('resolveSceneDurations: falls back to capture length, then to the default', () => {
  const out = resolveSceneDurations([{ id: 'a' }, { id: 'b' }], { captureDurations: { a: 6.5 } });
  assert.equal(out[0].durationSec, 6.5);
  assert.equal(out[1].durationSec, 4);
});

test('sceneTiming: scene starts match the chain and carry speech length', () => {
  const clips = [clip('a', 4), clip('b', 4)];
  clips[0].speechSec = 3;
  const timing = sceneTiming(clips, xfadeChain(clips));
  assert.equal(timing.a.startSec, 0);
  assert.equal(timing.b.startSec, 3.4);
  assert.equal(timing.a.speechSec, 3);
});

// ---------------------------------------------------------------------------
// manifest + filter strings
// ---------------------------------------------------------------------------

test('normaliseManifest: infers kind from extension and accepts a keyed map', () => {
  const out = normaliseManifest(
    { a: { path: 'scenes/a.png' }, b: { path: 'scenes/b.webm' }, c: { pattern: 'scenes/c/f-%05d.png' } },
    { work: '/w', cwd: '/c' },
  );
  assert.equal(out.a.kind, 'still');
  assert.equal(out.b.kind, 'video');
  assert.equal(out.c.kind, 'frames');
  assert.equal(out.c.path, '/w/scenes/c/f-%05d.png');
});

test('normaliseManifest: converts durationMs to seconds and drops entries with no file', () => {
  const out = normaliseManifest({ scenes: [{ id: 'a', path: 'a.png', durationMs: 3200 }, { id: 'b' }] });
  assert.equal(out.a.durationSec, 3.2);
  assert.equal(out.b, undefined);
});

test('buildChainFilters: emits xfade per join and concat for zero-length cuts', () => {
  const clips = [clip('a', 3, 600), clip('b', 3, 600, 'none'), clip('c', 3)];
  const chain = xfadeChain(clips);
  const filters = buildChainFilters(chain, ['v0', 'v1', 'v2'], { fps: 30 });
  assert.match(filters[0], /xfade=transition=fade:duration=0\.6:offset=2\.4\[chain0\]/);
  assert.match(filters[1], /\[chain0\]\[v2\]concat=n=2:v=1:a=0,settb=1\/30\[vchain\]/);
});

test('buildChainFilters: concat is pinned back to the frame timebase for the next xfade', () => {
  // concat outputs 1/1000000; an unpinned xfade downstream fails to configure.
  const clips = [clip('a', 3, 0, 'none'), clip('b', 3, 600), clip('c', 3)];
  const filters = buildChainFilters(xfadeChain(clips), ['v0', 'v1', 'v2'], { fps: 25 });
  assert.match(filters[0], /concat=n=2:v=1:a=0,settb=1\/25\[chain0\]/);
  assert.match(filters[1], /\[chain0\]\[v2\]xfade=/);
});

test('buildChainFilters: a single clip still produces a vchain label', () => {
  const filters = buildChainFilters(xfadeChain([clip('a', 3)]), ['v0']);
  assert.deepEqual(filters, ['[v0]null[vchain]']);
});

test('buildAudioFilters: VO is delayed to its scene start and music is ducked off it', () => {
  const { filters, label } = buildAudioFilters({
    voInputs: [
      { index: 3, startSec: 0 },
      { index: 4, startSec: 3.4 },
    ],
    musicInput: 5,
    totalSec: 7.4,
    music: { duck: true, gainDb: -18, fadeInMs: 1200, fadeOutMs: 2000 },
  });
  assert.equal(label, 'aout');
  assert.match(filters[1], /adelay=3400\|3400/);
  assert.ok(filters.some((f) => f.includes('sidechaincompress')));
  assert.ok(filters.some((f) => f.includes('afade=t=out:st=5.4:d=2')));
  assert.ok(filters.at(-1).includes('loudnorm=I=-16'));
});

test('buildAudioFilters: duck:false mixes without a sidechain', () => {
  const { filters } = buildAudioFilters({
    voInputs: [{ index: 1, startSec: 0 }],
    musicInput: 2,
    totalSec: 5,
    music: { duck: false },
  });
  assert.ok(!filters.some((f) => f.includes('sidechaincompress')));
});

test('buildAudioFilters: no VO and no music yields no audio label', () => {
  const { label } = buildAudioFilters({ voInputs: [], musicInput: null, totalSec: 5 });
  assert.equal(label, null);
});

test('builtinMotionFilter: none means no filter; kenburns drives zoom off the frame index', () => {
  assert.equal(builtinMotionFilter({ motion: { type: 'none' }, durationSec: 3, fps: 30, width: 1920, height: 1080 }), null);
  const f = builtinMotionFilter({ motion: { type: 'kenburns' }, durationSec: 3, fps: 30, width: 1920, height: 1080 });
  assert.match(f, /^zoompan=/);
  assert.match(f, /d=1/);
  assert.match(f, /s=1920x1080/);
  assert.match(f, /on/);
});

test('escapeFilterPath: colons and brackets are escaped so options do not truncate', () => {
  assert.equal(escapeFilterPath('/a/b:c[d],e'), '/a/b\\:c\\[d\\]\\,e');
});

test('countInputs: counts -i occurrences, not argv positions', () => {
  assert.equal(countInputs(['-y', '-loop', '1', '-i', 'a.png', '-i', 'b.wav']), 2);
});

test('MAX_GRAPH_NODES is a sane threshold', () => {
  assert.ok(MAX_GRAPH_NODES > 20 && MAX_GRAPH_NODES <= 1000);
});

// ---------------------------------------------------------------------------
// caption cue splitting
// ---------------------------------------------------------------------------

test('wrapLines: never breaks inside a word', () => {
  const lines = wrapLines('the quick brown fox jumps over the lazy dog', 12);
  for (const line of lines) assert.ok(line.length <= 12, `"${line}" is ${line.length} chars`);
  assert.equal(lines.join(' '), 'the quick brown fox jumps over the lazy dog');
});

test('wrapLines: a word longer than the limit gets its own line rather than being cut', () => {
  const lines = wrapLines('use the supercalifragilistic flag', 10);
  assert.ok(lines.includes('supercalifragilistic'));
  assert.equal(lines.join(' '), 'use the supercalifragilistic flag');
});

test('clauseSegments: splits after sentence and clause punctuation', () => {
  assert.deepEqual(clauseSegments('One thing, then another. And a third'), [
    'One thing,',
    'then another.',
    'And a third',
  ]);
});

test('splitIntoCues: no cue exceeds two lines and no line exceeds the limit', () => {
  const narration =
    'Open the billing page, pick the plan you want, and confirm. ' +
    'The change applies immediately, and the next invoice is prorated automatically.';
  const cues = splitIntoCues(narration, { maxCharsPerLine: 42 });
  assert.ok(cues.length >= 2);
  for (const cue of cues) {
    assert.ok(cue.lines.length <= 2, `cue "${cue.text}" wrapped to ${cue.lines.length} lines`);
    for (const line of cue.lines) assert.ok(line.length <= 42, `line "${line}" is ${line.length} chars`);
  }
});

test('splitIntoCues: preserves every word in order', () => {
  const narration = 'First we read the repository, then we storyboard it, then we render the video.';
  const cues = splitIntoCues(narration, { maxCharsPerLine: 24 });
  assert.equal(cues.map((c) => c.text).join(' '), narration);
});

test('splitIntoCues: keeps a clause pair together while it still fits two lines', () => {
  const cues = splitIntoCues('Pick a plan, then confirm it.', { maxCharsPerLine: 20 });
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0].lines, ['Pick a plan, then', 'confirm it.']);
});

test('splitIntoCues: when a break is needed it lands on the clause boundary', () => {
  const cues = splitIntoCues('Pick a plan, then confirm it now.', { maxCharsPerLine: 14 });
  assert.equal(cues[0].text, 'Pick a plan,');
  assert.equal(cues[1].text, 'then confirm it now.');
});

test('splitIntoCues: one long unpunctuated clause is chunked, never truncated', () => {
  const narration = 'a b c d e f g h i j k l m n o p q r s t u v w x y z';
  const cues = splitIntoCues(narration, { maxCharsPerLine: 10 });
  assert.ok(cues.length > 1);
  for (const cue of cues) assert.ok(cue.lines.length <= 2);
  assert.equal(cues.map((c) => c.text).join(' '), narration);
});

test('splitIntoCues: empty narration yields no cues', () => {
  assert.deepEqual(splitIntoCues('   '), []);
});

// ---------------------------------------------------------------------------
// caption timing
// ---------------------------------------------------------------------------

test('distributeCues: cues are contiguous and end exactly on the scene end', () => {
  const cues = splitIntoCues('Short one. A considerably longer second cue here.', { maxCharsPerLine: 30 });
  const timed = distributeCues(cues, 10, 6);
  assert.equal(timed[0].startSec, 10);
  assert.equal(round3(timed.at(-1).endSec), 16);
  for (let i = 1; i < timed.length; i += 1) assert.equal(timed[i].startSec, timed[i - 1].endSec);
});

test('distributeCues: duration is proportional to character count', () => {
  const cues = [{ text: 'ab', lines: ['ab'] }, { text: 'abcdef', lines: ['abcdef'] }];
  const timed = distributeCues(cues, 0, 8);
  assert.equal(round3(timed[0].endSec - timed[0].startSec), 2);
  assert.equal(round3(timed[1].endSec - timed[1].startSec), 6);
});

test('distributeCues: no cues in, no cues out', () => {
  assert.deepEqual(distributeCues([], 0, 5), []);
});

test('buildCues: uses the VO duration, not the padded scene duration', () => {
  const scenes = [{ id: 'a', narration: 'One two three four five six.' }];
  const cues = buildCues(scenes, { a: { startSec: 2, durationSec: 5, speechSec: 3 } }, { maxCharsPerLine: 40 });
  assert.equal(cues[0].startSec, 2);
  assert.equal(round3(cues.at(-1).endSec), 5);
  assert.equal(cues[0].sceneId, 'a');
});

test('buildCues: scenes with no narration or no timing are skipped', () => {
  const scenes = [{ id: 'a' }, { id: 'b', narration: 'Hello there.' }];
  assert.deepEqual(buildCues(scenes, { a: { startSec: 0, durationSec: 3, speechSec: 3 } }), []);
});

// ---------------------------------------------------------------------------
// caption serialisation + contrast
// ---------------------------------------------------------------------------

test('formatSrtTime and formatAssTime match their spec formats', () => {
  assert.equal(formatSrtTime(3661.5), '01:01:01,500');
  assert.equal(formatAssTime(3661.5), '1:01:01.50');
  assert.equal(formatSrtTime(-1), '00:00:00,000');
});

test('toSrt: numbered blocks with an arrow timestamp and wrapped lines', () => {
  const cues = distributeCues(splitIntoCues('Pick a plan, then confirm it now.', { maxCharsPerLine: 14 }), 0, 4);
  const srt = toSrt(cues);
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.match(srt, /\n2\n/);
});

test('assColour: byte-reversed RGB with inverted alpha', () => {
  assert.equal(assColour('#112233', 1), '&H00332211');
  assert.equal(assColour('#ffffff', 0.85), '&H26FFFFFF');
});

test('toAss: carries brand font, play resolution and a two-line cue break', () => {
  const cues = distributeCues(splitIntoCues('Pick a plan, then confirm it now please.', { maxCharsPerLine: 18 }), 0, 4);
  const ass = toAss(cues, {
    brand: { color: { text: '#ffffff', surface: '#0b0b0f' }, type: { display: { family: 'Acme Display', weight: 700 } } },
    width: 1920,
    height: 1080,
    style: 'bar',
  });
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /Style: PDV,Acme Display,/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,/);
  assert.match(ass, /\\N/);
});

test('toAss: top position uses alignment 8', () => {
  const ass = toAss([{ text: 'x', lines: ['x'], startSec: 0, endSec: 1 }], { position: 'top' });
  assert.match(ass, /,8,/);
});

test('contrastRatio: black on white is 21:1 and is symmetric', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#ffffff', '#000000'), contrastRatio('#000000', '#ffffff'));
});

test('checkCaptionContrast: judges the blended bar, not the bar colour alone', () => {
  const pass = checkCaptionContrast({
    brand: { color: { text: '#ffffff', surface: '#101014', background: '#101014' } },
    style: 'bar',
  });
  assert.equal(pass.pass, true);
  assert.ok(pass.ratio > 3);

  const fail = checkCaptionContrast({
    brand: { color: { text: '#cfcfcf', surface: '#f2f2f2', background: '#ffffff' } },
    style: 'bar',
  });
  assert.equal(fail.pass, false);
});

test('checkCaptionContrast: outline style is judged against the backdrop behind it', () => {
  const r = checkCaptionContrast({
    brand: { color: { text: '#ffffff', surface: '#101014', background: '#ffffff' } },
    style: 'outline',
    behind: '#ffffff',
  });
  assert.equal(r.background, '#ffffff');
  assert.equal(r.pass, false);
});
