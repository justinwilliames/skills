import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOZOOM_PAD,
  DEFAULT_KEN_BURNS_INTENSITY,
  MAX_KEN_BURNS_INTENSITY,
  MAX_ZOOM,
  boxToPose,
  buildMotionFilter,
  clampCentre,
  computeKeyframes,
  computeMotion,
  driftDirection,
  frameCount,
  kenBurnsPoses,
  maxZoomFor,
  resolveTargetBox,
} from '../motion.mjs';

const META = { fps: 30, width: 1920, height: 1080 };
const GEO = { width: 3840, height: 2160, kind: 'still' };

const near = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} within ${eps} of ${b}`);

/** Collect the notices a call emits instead of letting them hit the console. */
const withLog = () => {
  const lines = [];
  return { log: (m) => lines.push(m), lines };
};

/**
 * The fraction of the source the furthest edge loses at a pose. Every safe-area
 * constant in templates/scenes is drawn against the value a centred push to
 * 1+intensity produces, so this is the number no move may exceed.
 */
const edgeCrop = (k) =>
  Math.max(Math.abs(k.cx - 0.5), Math.abs(k.cy - 0.5)) + (0.5 - 0.5 / k.zoom);
const cropBudget = (intensity) => 0.5 - 0.5 / (1 + intensity);

test('frameCount rounds to whole frames and never returns fewer than two', () => {
  assert.equal(frameCount(4000, 30), 120);
  assert.equal(frameCount(1000, 24), 24);
  assert.equal(frameCount(1, 30), 2);
});

test('kenburns scale is monotonic and peaks at the brand intensity', () => {
  const kf = computeKeyframes({ durationMs: 2000 }, GEO, META);
  assert.equal(kf.length, 60);
  for (let i = 1; i < kf.length; i += 1) {
    assert.ok(kf[i].zoom >= kf[i - 1].zoom, `zoom fell at frame ${i}`);
  }
  // The push starts slightly in, which is what buys the pan its lateral room.
  near(kf[0].zoom, 1 / (1 - cropBudget(DEFAULT_KEN_BURNS_INTENSITY)));
  near(kf.at(-1).zoom, 1 + DEFAULT_KEN_BURNS_INTENSITY);
});

test('kenburns actually pans — it is not a dead-centre zoom', () => {
  const kf = computeKeyframes({ id: 'hero', durationMs: 4000 }, GEO, META);
  const travelPx = Math.abs(kf.at(-1).cx - kf[0].cx) * 1920;
  assert.ok(travelPx > 24, `lateral travel should be visible, got ${travelPx.toFixed(1)}px`);
  assert.ok(travelPx < 96, `and still atmosphere, not a camera move, got ${travelPx.toFixed(1)}px`);
  assert.notEqual(kf[0].cx, 0.5, 'the start pose must be off centre for any pan to exist');
  // Monotonic in one direction: a drift that reverses reads as a wobble.
  const dir = Math.sign(kf.at(-1).cx - kf[0].cx);
  for (let i = 1; i < kf.length; i += 1) {
    const step = (kf[i].cx - kf[i - 1].cx) * dir;
    assert.ok(step >= -1e-12, `pan reversed at frame ${i}`);
  }
});

test('the derived drift never crops deeper than a centred push at the same intensity', () => {
  for (const intensity of [0.01, 0.02, 0.05, 0.08, MAX_KEN_BURNS_INTENSITY]) {
    for (const id of ['a', 'b', 'c', 'd']) {
      const kf = computeKeyframes({ id, durationMs: 4000 }, GEO, { ...META, kenBurnsIntensity: intensity });
      const budget = cropBudget(intensity);
      for (const k of kf) {
        assert.ok(
          edgeCrop(k) <= budget + 1e-12,
          `intensity ${intensity} scene ${id}: crop ${edgeCrop(k)} exceeded budget ${budget}`,
        );
      }
    }
  }
});

test('drift direction alternates with the scene index, and is stable per scene id', () => {
  assert.deepEqual(driftDirection({}, { sceneIndex: 0 }), [1, 1]);
  assert.deepEqual(driftDirection({}, { sceneIndex: 1 }), [-1, 1]);
  assert.deepEqual(driftDirection({}, { sceneIndex: 2 }), [1, -1]);
  assert.deepEqual(driftDirection({}, { sceneIndex: 3 }), [-1, -1]);
  for (let i = 1; i < 8; i += 1) {
    assert.notDeepEqual(
      driftDirection({}, { sceneIndex: i - 1 }),
      driftDirection({}, { sceneIndex: i }),
      `scenes ${i - 1} and ${i} drift the same way`,
    );
  }
  assert.deepEqual(driftDirection({ id: 'hero' }), driftDirection({ id: 'hero' }));
});

test('two scenes with different ids do not make the identical move', () => {
  const move = (id) => {
    const kf = computeKeyframes({ id, durationMs: 2000 }, GEO, META);
    return [kf[0].cx, kf[0].cy];
  };
  assert.notDeepEqual(move('hero'), move('flow'));
});

test('kenBurnsPoses splits the crop budget between zoom and offset', () => {
  const { start, end } = kenBurnsPoses(0.08, [1, 1]);
  const budget = cropBudget(0.08);
  near(start[2], 1 / (1 - budget));
  near(end[0], 0.5);
  near(end[1], 0.5);
  near(end[2], 1.08);
  // Half the budget goes to the start zoom, the rest (bar the bulge margin) to offset.
  assert.ok(start[0] - 0.5 > 0.9 * (budget / 2), 'the offset should be most of half the budget');
  assert.ok(start[0] - 0.5 <= budget / 2, 'and never more than half of it');
});

test('brand kenBurnsIntensity is honoured below the maximum', () => {
  const kf = computeKeyframes({ durationMs: 1000 }, GEO, { ...META, kenBurnsIntensity: 0.05 });
  near(kf.at(-1).zoom, 1.05);
});

test('an intensity past the maximum is clamped, and says so', () => {
  const { log, lines } = withLog();
  const kf = computeKeyframes({ durationMs: 1000 }, GEO, { ...META, kenBurnsIntensity: 0.2, log });
  near(kf.at(-1).zoom, 1 + MAX_KEN_BURNS_INTENSITY);
  assert.equal(lines.length, 1, 'the operator has to be told the brand value was not used');
  assert.match(lines[0], /kenBurnsIntensity 0\.2 exceeds the 0\.09 maximum/);
});

test('an explicit `from` is honoured as a centred push, not overridden by the drift', () => {
  const kf = computeKeyframes(
    { durationMs: 1000, motion: { type: 'kenburns', from: [0.45, 0.55, 1.2] } },
    GEO,
    META,
  );
  near(kf[0].cx, 0.45);
  near(kf[0].cy, 0.55);
  near(kf.at(-1).cx, 0.45);
  near(kf.at(-1).zoom, 1.2 + DEFAULT_KEN_BURNS_INTENSITY);
});

test('easing endpoints are exact — first frame is `from`, last is `to`', () => {
  const scene = {
    durationMs: 2000,
    motion: { type: 'kenburns', from: [0.48, 0.52, 1.1], to: [0.55, 0.45, 1.35] },
  };
  const kf = computeKeyframes(scene, GEO, META);
  near(kf[0].cx, 0.48);
  near(kf[0].cy, 0.52);
  near(kf[0].zoom, 1.1);
  near(kf.at(-1).cx, 0.55);
  near(kf.at(-1).cy, 0.45);
  near(kf.at(-1).zoom, 1.35);
  near(kf[0].progress, 0);
  near(kf.at(-1).progress, 1);
});

test('an out-of-bounds endpoint is pulled in by the clamp, not honoured', () => {
  const scene = { durationMs: 1000, motion: { from: [0.4, 0.5, 1.1], to: [0.4, 0.5, 1.1] } };
  const kf = computeKeyframes(scene, GEO, META);
  near(kf[0].cx, 0.5 / 1.1);
});

test('easeInOutCubic is symmetric about the midpoint and lags linear early', () => {
  // 61 frames so one keyframe lands exactly on t=0.5 rather than near it.
  const scene = { durationMs: 2033, motion: { from: [0.5, 0.5, 1], to: [0.5, 0.5, 2] } };
  const kf = computeKeyframes(scene, GEO, META);
  assert.equal(kf.length, 61);
  const mid = kf[30];
  near(mid.t, 0.5);
  near(mid.zoom, 1.5);
  const quarter = kf[15];
  const threeQuarter = kf[45];
  assert.ok(quarter.zoom < 1.25, `easeInOutCubic should lag linear at t=0.25, got ${quarter.zoom}`);
  near(quarter.zoom - 1 + (threeQuarter.zoom - 1), 1, 1e-12);
});

test('holdMs is respected — the pose does not move until the hold expires', () => {
  const scene = {
    durationMs: 2000,
    motion: { type: 'kenburns', from: [0.5, 0.5, 1], to: [0.5, 0.5, 1.4], holdMs: 500 },
  };
  const kf = computeKeyframes(scene, GEO, META);
  const holdFrames = 15;
  for (let f = 0; f <= holdFrames; f += 1) {
    near(kf[f].zoom, 1);
    near(kf[f].progress, 0);
  }
  assert.ok(kf[holdFrames + 1].zoom > 1, 'movement should begin the frame after the hold');
  near(kf.at(-1).zoom, 1.4);
});

test('centres are clamped so the zoom window never leaves the source image', () => {
  const scene = {
    durationMs: 1000,
    motion: { type: 'kenburns', from: [0, 0, 2], to: [1, 1, 2] },
  };
  const kf = computeKeyframes(scene, GEO, META);
  for (const k of kf) {
    const half = 0.5 / k.zoom;
    assert.ok(k.cx >= half - 1e-9 && k.cx <= 1 - half + 1e-9, `cx ${k.cx} escaped at zoom ${k.zoom}`);
    assert.ok(k.cy >= half - 1e-9 && k.cy <= 1 - half + 1e-9, `cy ${k.cy} escaped at zoom ${k.zoom}`);
  }
  near(kf[0].cx, 0.25);
  near(kf.at(-1).cx, 0.75);
});

test('clampCentre leaves an in-bounds centre alone', () => {
  assert.deepEqual(clampCentre(0.5, 0.5, 1), [0.5, 0.5]);
  assert.deepEqual(clampCentre(0.5, 0.5, 2), [0.5, 0.5]);
});

test('autozoom ends centred on the target box', () => {
  const box = { x: 1920, y: 1080, w: 480, h: 270 };
  const kf = computeKeyframes(
    { durationMs: 1000, motion: { type: 'autozoom', target: [box.x, box.y, box.w, box.h] } },
    GEO,
    { ...META, log: () => {} },
  );
  const end = kf.at(-1);
  const wantZoom = Math.min(GEO.width / (box.w * AUTOZOOM_PAD), GEO.height / (box.h * AUTOZOOM_PAD));
  near(end.zoom, Math.min(wantZoom, MAX_ZOOM));
  const half = 0.5 / end.zoom;
  const rawCx = (box.x + box.w / 2) / GEO.width;
  const rawCy = (box.y + box.h / 2) / GEO.height;
  near(end.cx, Math.min(Math.max(rawCx, half), 1 - half));
  near(end.cy, Math.min(Math.max(rawCy, half), 1 - half));
  near(kf[0].zoom, 1);
});

test('autozoom pads the target box rather than cropping it tight', () => {
  // Big enough that the padded frame is still inside the resolution ceiling.
  const box = { x: 0, y: 0, w: 1600, h: 900 };
  const [, , zoom] = boxToPose(box, GEO);
  const visibleW = GEO.width / zoom;
  assert.ok(visibleW > box.w, 'padded viewport must be wider than the target box');
  near(visibleW, box.w * AUTOZOOM_PAD);
});

test('autozoom zoom is clamped to MAX_ZOOM on a tiny target', () => {
  const [, , zoom] = boxToPose({ x: 100, y: 100, w: 8, h: 8 }, GEO, { log: () => {} });
  assert.equal(zoom, MAX_ZOOM);
});

test('MAX_ZOOM keeps at least one source pixel behind every output pixel', () => {
  // capture.mjs records at deviceScaleFactor 2: a 1920-wide frame off 3840.
  const sourcePixelsShown = GEO.width / MAX_ZOOM;
  assert.ok(
    sourcePixelsShown >= META.width,
    `zoom ${MAX_ZOOM} shows ${sourcePixelsShown} source px across ${META.width} output px — an upscale`,
  );
});

test('a target the source cannot serve is limited to native resolution, and logged', () => {
  const { log, lines } = withLog();
  const [, , zoom] = boxToPose({ x: 100, y: 100, w: 200, h: 60 }, GEO, { maxZoom: 2, log });
  assert.equal(zoom, 2, 'a 200x60 button wants 7.5x — the source has nowhere near that');
  assert.equal(lines.length, 1, 'a silently softened zoom is how mush ships');
  assert.match(lines[0], /wants zoom 15\.00, limited to 2\.00/);
});

test('a zoom the source can serve is not logged', () => {
  const { log, lines } = withLog();
  boxToPose({ x: 0, y: 0, w: 1600, h: 900 }, GEO, { maxZoom: 2, log });
  assert.deepEqual(lines, []);
});

test('maxZoomFor tracks the capture scale rather than a hard-coded constant', () => {
  assert.equal(maxZoomFor({ width: 3840 }, { width: 1920 }), 2);
  assert.equal(maxZoomFor({ width: 5760 }, { width: 1920 }), 3, 'a 3x capture earns a 3x ceiling');
  // render.mjs hands motion the OUTPUT size as geometry; deriving 1.0 there
  // would disable autozoom entirely, so the constant has to win.
  assert.equal(maxZoomFor({ width: 1920 }, { width: 1920 }), MAX_ZOOM);
  assert.equal(maxZoomFor({}, {}), MAX_ZOOM);
});

test('computeKeyframes limits an autozoom to what the captured geometry can serve', () => {
  const { log, lines } = withLog();
  const kf = computeKeyframes(
    { durationMs: 1000, motion: { type: 'autozoom', target: [100, 100, 200, 60] } },
    GEO,
    { ...META, log },
  );
  assert.equal(kf.at(-1).zoom, 2);
  assert.equal(lines.length, 1);
});

test('autozoom never zooms out on a target larger than the frame', () => {
  const [, , zoom] = boxToPose({ x: 0, y: 0, w: GEO.width, h: GEO.height }, GEO);
  assert.equal(zoom, 1);
});

test('a selector target resolves from capture geometry, and names the miss otherwise', () => {
  const geometry = { ...GEO, resolvedTargets: { '#invoice-total': { x: 100, y: 200, w: 300, h: 80 } } };
  assert.deepEqual(resolveTargetBox('#invoice-total', geometry), { x: 100, y: 200, w: 300, h: 80 });
  assert.throws(
    () => resolveTargetBox('#missing', geometry),
    /was not resolved during capture.*#invoice-total/s,
  );
});

test('motion none is static for every frame', () => {
  const kf = computeKeyframes({ durationMs: 1000, motion: { type: 'none' } }, GEO, META);
  for (const k of kf) {
    assert.equal(k.zoom, 1);
    assert.equal(k.cx, 0.5);
    assert.equal(k.cy, 0.5);
  }
});

test('buildMotionFilter returns a bare zoompan string at the frame size', () => {
  const filter = buildMotionFilter({ durationMs: 2000 }, GEO, META);
  assert.equal(typeof filter, 'string', 'render.mjs discards anything that is not a string');
  assert.match(filter, /^zoompan=/);
  assert.match(filter, /s=1920x1080/);
  assert.match(filter, /fps=30/);
  // render.mjs oversamples around this filter; doing it again would make it 4x.
  assert.doesNotMatch(filter, /scale=/);
  assert.match(filter, /d=1:/, 'every input in this pipeline is a stream, so one in one out');
});

test('computeMotion returns the keyframes alongside the filter', () => {
  const { filter, keyframes, frames } = computeMotion({ durationMs: 2000 }, GEO, META);
  assert.equal(frames, 60);
  assert.equal(keyframes.length, 60);
  assert.ok(filter.startsWith('zoompan='));
});

test('oversample:2 prepends the upscale for a caller that does not do its own', () => {
  const filter = buildMotionFilter({ durationMs: 1000 }, GEO, META, { oversample: 2 });
  assert.match(filter, /^scale=iw\*2:ih\*2:flags=lanczos,zoompan=/);
  assert.ok(filter.indexOf('scale=iw*2') < filter.indexOf('zoompan='), 'oversample must precede zoompan');
});

test('render can buy the finer position quantum by passing oversample through', () => {
  // zoompan truncates x and the crop size to whole INPUT pixels, so the pan
  // position steps. Measured: 0.26 output px per step at the shipped 2x input,
  // 0.125 px at 4x. The knob has to survive render.mjs's call shape.
  const filter = buildMotionFilter({
    scene: { id: 'hero' }, durationSec: 4, fps: 30, width: 1920, height: 1080, intensity: 0.08,
    oversample: 2,
  });
  assert.match(filter, /^scale=iw\*2:ih\*2:flags=lanczos,zoompan=/);
});

test('motion none returns null so the caller can skip the filter entirely', () => {
  assert.equal(buildMotionFilter({ durationMs: 1000, motion: { type: 'none' } }, GEO, META), null);
});

test("render.mjs's single-object call shape produces the same curve", () => {
  const scene = { id: 'hero', motion: { type: 'kenburns', from: [0.5, 0.5, 1], to: [0.5, 0.5, 1.2] } };
  const viaRender = buildMotionFilter({
    motion: scene.motion,
    scene,
    durationSec: 2,
    fps: 30,
    width: 1920,
    height: 1080,
    brand: { motion: { kenBurnsIntensity: 0.08, easing: 'easeInOutCubic' } },
    intensity: 0.08,
  });
  const direct = buildMotionFilter({ ...scene, durationMs: 2000 }, { width: 1920, height: 1080 }, META);
  assert.equal(viaRender, direct);
});

test("render's durationSec overrides a stale scene.durationMs", () => {
  const scene = { durationMs: 999999, motion: { type: 'kenburns' } };
  const { frames } = computeMotion({ scene, durationSec: 2, fps: 30, width: 1920, height: 1080, intensity: 0.08 });
  assert.equal(frames, 60);
});

test("render's intensity reaches the kenburns endpoint", () => {
  const { keyframes } = computeMotion({ scene: {}, durationSec: 1, fps: 30, width: 1920, height: 1080, intensity: 0.06 });
  near(keyframes.at(-1).zoom, 1.06);
});

test("render's over-max intensity is clamped on the way through", () => {
  const { log, lines } = withLog();
  const { keyframes } = computeMotion({
    scene: {}, durationSec: 1, fps: 30, width: 1920, height: 1080, intensity: 0.3, log,
  });
  near(keyframes.at(-1).zoom, 1 + MAX_KEN_BURNS_INTENSITY);
  assert.equal(lines.length, 1);
});

test('the emitted filter carries the pan, not just the zoom', () => {
  const filter = buildMotionFilter({ id: 'hero', durationMs: 4000 }, GEO, META);
  const [, xExpr] = /:x='([^']+)'/.exec(filter);
  // The x expression must have a non-zero travel term, or the pan is decorative.
  const [, travel] = /\)\*iw/.exec(xExpr) ? /\+\((-?[\d.]+)\)\*ld\(1\)\)\*iw/.exec(xExpr) : [];
  assert.ok(Math.abs(Number(travel)) > 0.005, `x travel term should pan, got ${travel}`);
});
