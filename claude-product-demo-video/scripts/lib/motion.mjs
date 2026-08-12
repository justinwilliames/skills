/**
 * Motion — a scene's motion spec plus its captured geometry, turned into
 * keyframes and then into one ffmpeg filter string.
 *
 * `computeKeyframes` is pure: no ffmpeg, no filesystem, no browser. Everything
 * the filter builder emits is derived from it, so the maths is unit-testable on
 * its own and the filter string is only a serialisation of a tested curve.
 *
 * Coordinate space: geometry.width/height are the CAPTURED pixel dimensions
 * (already multiplied by the capture device scale factor). resolvedTargets
 * boxes are in that same space. Keyframe centres are 0-1 fractions, matching
 * the storyboard schema's `motion.from` / `motion.to`.
 */

import { ease } from './util.mjs';

export const DEFAULT_KEN_BURNS_INTENSITY = 0.08;
export const DEFAULT_DURATION_MS = 4000;
/** Grow an autozoom target box by this factor so the element is not cropped tight. */
export const AUTOZOOM_PAD = 1.28;
/**
 * Beyond this the source pixels run out and the push reads as an upscale.
 *
 * capture.mjs records at CAPTURE_SCALE 2, so a 1920x1080 frame is sourced from
 * 3840x2160 and one output pixel is backed by two source pixels. At zoom 2 the
 * visible window is 1920 source pixels wide filling 1920 output pixels — 1:1,
 * the last zoom that shows real detail. Past it the small UI element the
 * autozoom was aimed at is being enlarged, which is the opposite of the point.
 * `maxZoomFor` derives the real limit from the geometry when it is known, so a
 * future 3x capture raises the ceiling without this constant drifting.
 */
export const MAX_ZOOM = 2;
/**
 * Peak scale delta a kenburns push may ask for, mirrored in
 * schemas/brand.schema.json. Every safe-area constant in templates/scenes is
 * drawn against the crop this produces; see `kenBurnsPoses` for the maths.
 */
export const MAX_KEN_BURNS_INTENSITY = 0.09;
/** Vertical drift as a fraction of the horizontal, so the move is not a tram line. */
const VERTICAL_DRIFT = 0.35;
/**
 * The straight line between two poses that each sit exactly on the crop budget
 * bulges past it in the middle — the budget curve is concave in the eased
 * parameter while the pose path is a chord. Measured overshoot at the 0.08
 * default is 0.49% of the budget; 0.95 is the largest factor that removes it
 * across the whole legal intensity range (verified by sampling 20k points).
 */
const DRIFT_SAFETY = 0.95;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const lerp = (a, b, t) => a + (b - a) * t;

/** Notices are build defects worth seeing; a caller with a ctx can pass its own. */
const defaultLog = (msg) => console.warn(`motion: ${msg}`);
const logger = (...sources) => {
  for (const s of sources) if (typeof s?.log === 'function') return s.log;
  return defaultLog;
};

export function frameCount(durationMs, fps) {
  return Math.max(2, Math.round((Number(durationMs) / 1000) * Number(fps)));
}

/**
 * Keep the zoom viewport inside the source image. At zoom z the visible window
 * is 1/z of the frame, so its centre cannot come closer than 0.5/z to an edge.
 */
export function clampCentre(cx, cy, zoom) {
  const half = 0.5 / Math.max(1, zoom);
  return [clamp(cx, half, 1 - half), clamp(cy, half, 1 - half)];
}

/** Explicit [x,y,w,h] box, or a CSS selector resolved during capture. */
export function resolveTargetBox(target, geometry = {}) {
  if (Array.isArray(target)) {
    if (target.length !== 4) {
      throw new Error(`motion.target box needs 4 numbers, got ${target.length}`);
    }
    const [x, y, w, h] = target.map(Number);
    return { x, y, w, h };
  }
  if (typeof target === 'string') {
    const box = geometry.resolvedTargets?.[target];
    if (!box) {
      const known = Object.keys(geometry.resolvedTargets ?? {});
      throw new Error(
        `motion.target selector "${target}" was not resolved during capture` +
          (known.length ? ` — capture resolved: ${known.join(', ')}` : ' — capture resolved nothing'),
      );
    }
    return { x: Number(box.x), y: Number(box.y), w: Number(box.w), h: Number(box.h) };
  }
  throw new Error('autozoom needs motion.target: an [x,y,w,h] box or a CSS selector');
}

/**
 * The zoom at which source pixels stop outnumbering output pixels.
 *
 * Only derived when the geometry says the source really is larger than the
 * frame; render.mjs currently hands motion the OUTPUT size as geometry, and a
 * derived ceiling of 1.0 there would silently disable autozoom altogether.
 */
export function maxZoomFor(geometry = {}, meta = {}) {
  const src = Number(geometry.width);
  const out = Number(meta.width ?? geometry.outputWidth);
  if (src > 0 && out > 0 && src / out > 1) return src / out;
  return MAX_ZOOM;
}

/** Target box -> the [centreX, centreY, zoom] pose that frames it. */
export function boxToPose(box, geometry, opts = {}) {
  const W = Number(geometry.width);
  const H = Number(geometry.height);
  if (!(W > 0 && H > 0)) throw new Error('geometry.width/height are required for autozoom');
  const ceiling = Number(opts.maxZoom ?? MAX_ZOOM);
  const wanted = Math.min(W / (box.w * AUTOZOOM_PAD), H / (box.h * AUTOZOOM_PAD));
  const zoom = clamp(wanted, 1, ceiling);
  if (wanted > ceiling) {
    logger(opts)(
      `autozoom target ${box.w}x${box.h} wants zoom ${wanted.toFixed(2)}, limited to ${ceiling.toFixed(2)} ` +
        'so the source still has a pixel per output pixel — the element will read smaller than asked for',
    );
  }
  return [(box.x + box.w / 2) / W, (box.y + box.h / 2) / H, zoom];
}

/**
 * Default kenburns poses — an actual drift, not a dead-centre zoom.
 *
 * The safety maths, because this is what the templates' safe areas are drawn
 * against. At zoom z the visible window is 1/z of the frame, so the edge
 * furthest from the centre loses (0.5 - 0.5/z) + |c - 0.5| of the source. A
 * centred push to 1+i therefore spends B = 0.5 - 0.5/(1+i) on its worst edge,
 * and that B is the number _frame.html's inset and _base.css's edge rail were
 * sized for. A pan has to come out of the same B or the browser chrome starts
 * losing its title bar.
 *
 * Splitting B evenly between zoom and offset maximises the lateral move the
 * budget allows — min(c, B - c) peaks at c = B/2 — which is a start pose at
 * zoom 1/(1 - B), offset B/2 from centre. From there the move pushes in to the
 * full 1+i and settles centred, where the offset must be zero because the zoom
 * has taken the whole budget back. At the 0.08 default that is 1.038 -> 1.080
 * with 1.76% of lateral travel (33.8px of a 1920 frame, 7px vertical):
 * atmosphere, not a camera move, and no deeper a crop than the old centred
 * push at any point in the move.
 */
export function kenBurnsPoses(intensity, direction = [1, 1]) {
  const i = clamp(Number(intensity) || 0, 0, MAX_KEN_BURNS_INTENSITY);
  const budget = 0.5 - 0.5 / (1 + i);
  const offset = (budget / 2) * DRIFT_SAFETY;
  const [dirX, dirY] = direction;
  return {
    start: [0.5 + dirX * offset, 0.5 + dirY * offset * VERTICAL_DRIFT, 1 / (1 - budget)],
    end: [0.5, 0.5, 1 + i],
  };
}

/**
 * Which way this scene drifts. Alternating by scene index is what stops six
 * scenes reading as the same move six times; the id hash is the fallback for
 * callers (render.mjs today) that do not pass an index.
 */
export function driftDirection(scene = {}, meta = {}) {
  let idx = Number(meta.sceneIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    idx = 0;
    for (const ch of String(scene.id ?? '')) idx = (idx * 33 + ch.codePointAt(0)) % 1024;
  }
  return [idx % 2 === 0 ? 1 : -1, Math.floor(idx / 2) % 2 === 0 ? 1 : -1];
}

/** Brand intensity, clamped to what the templates' safe areas can absorb. */
function kenBurnsIntensity(meta = {}, log = defaultLog) {
  const asked = Number(meta.kenBurnsIntensity ?? DEFAULT_KEN_BURNS_INTENSITY);
  if (!Number.isFinite(asked)) return DEFAULT_KEN_BURNS_INTENSITY;
  if (asked > MAX_KEN_BURNS_INTENSITY) {
    log(
      `brand.motion.kenBurnsIntensity ${asked} exceeds the ${MAX_KEN_BURNS_INTENSITY} maximum — clamped. ` +
        'Above it the browser-chrome frame and the title-safe insets are cropped off the frame.',
    );
  }
  return clamp(asked, 0, MAX_KEN_BURNS_INTENSITY);
}

/**
 * @param {object} scene      storyboard scene (durationMs, motion)
 * @param {object} geometry   { width, height, resolvedTargets, durationMs, kind }
 * @param {object} meta       { fps, kenBurnsIntensity, easing }
 * @returns {Array<{frame:number,t:number,progress:number,cx:number,cy:number,zoom:number}>}
 */
export function computeKeyframes(scene = {}, geometry = {}, meta = {}) {
  const fps = Number(meta.fps ?? 30);
  const durationMs = Number(scene.durationMs ?? geometry.durationMs ?? DEFAULT_DURATION_MS);
  const frames = frameCount(durationMs, fps);

  const spec = scene.motion ?? {};
  const type = spec.type ?? 'kenburns';
  const easingName = type === 'none' ? 'linear' : (spec.easing ?? meta.easing ?? 'easeInOutCubic');

  const holdFrames = clamp(Math.round((Number(spec.holdMs ?? 0) / 1000) * fps), 0, frames - 1);
  const moveFrames = Math.max(1, frames - 1 - holdFrames);

  const log = logger(meta);
  let start = spec.from ? spec.from.map(Number) : [0.5, 0.5, 1];
  let end;
  if (type === 'none') {
    end = start;
  } else if (spec.to) {
    end = spec.to.map(Number);
  } else if (type === 'autozoom') {
    end = boxToPose(resolveTargetBox(spec.target, geometry), geometry, {
      maxZoom: maxZoomFor(geometry, meta),
      log,
    });
  } else if (spec.from) {
    // An explicit `from` is a stated centre; pushing in from it is the honest
    // reading of the spec, so this stays a zoom rather than inventing a drift.
    end = [start[0], start[1], start[2] + kenBurnsIntensity(meta, log)];
  } else {
    const poses = kenBurnsPoses(kenBurnsIntensity(meta, log), driftDirection(scene, meta));
    start = poses.start;
    end = poses.end;
  }

  const keyframes = [];
  for (let f = 0; f < frames; f += 1) {
    const progress = clamp((f - holdFrames) / moveFrames, 0, 1);
    const e = type === 'none' ? 0 : ease(easingName, progress);
    const zoom = Math.max(1, lerp(start[2], end[2], e));
    const [cx, cy] = clampCentre(lerp(start[0], end[0], e), lerp(start[1], end[1], e), zoom);
    keyframes.push({ frame: f, t: f / (frames - 1), progress, cx, cy, zoom });
  }
  return keyframes;
}

const n = (v) => Number(v).toFixed(6);

/** ffmpeg eval of the easing curve, reading progress from register 0. */
function easeExpr(name) {
  switch (name) {
    case 'linear':
      return 'ld(0)';
    case 'easeOutQuint':
      return '1-pow(1-ld(0),5)';
    default:
      return 'if(lt(ld(0),0.5),4*pow(ld(0),3),1-pow(-2*ld(0)+2,3)/2)';
  }
}

/**
 * Accept both call shapes:
 *   computeMotion(scene, geometry, meta, opts)          — this module's own form
 *   computeMotion({ scene, motion, durationSec, fps, width, height, brand,
 *                   intensity, geometry })              — render.mjs's form
 * One positional argument means the render form; that is the only discriminator
 * that cannot be confused by a scene object carrying its own `motion`.
 */
function normaliseCall(a, b, c, d, argc) {
  if (argc > 1 || !a || typeof a !== 'object' || (!a.scene && a.durationSec === undefined && a.fps === undefined)) {
    return { scene: a ?? {}, geometry: b ?? {}, meta: c ?? {}, opts: d ?? {} };
  }
  const scene = a.scene ? { ...a.scene } : {};
  if (a.motion) scene.motion = a.motion;
  // render derives real scene durations from the voiceover, so its value wins.
  if (a.durationSec !== undefined) scene.durationMs = Number(a.durationSec) * 1000;
  const geometry = a.geometry ?? { width: a.width, height: a.height };
  return {
    scene,
    geometry,
    meta: {
      fps: a.fps,
      width: a.width,
      height: a.height,
      kenBurnsIntensity: a.intensity ?? a.brand?.motion?.kenBurnsIntensity,
      easing: a.brand?.motion?.easing,
      sceneIndex: a.sceneIndex,
      log: a.log,
    },
    opts: { oversample: a.oversample ?? 1, d: a.d },
  };
}

/**
 * Keyframes + the ffmpeg filter for one scene.
 *
 * zoompan truncates x/y AND the crop size to integers on its INPUT image, so a
 * slow pan over a 1x source steps sideways a whole pixel at a time. Oversampling
 * — scaling the input up before zoompan and letting its own `s=` bring the frame
 * back down — divides that step but never removes it. render.mjs already scales
 * to 2x around this filter, so `oversample` defaults to 1 here.
 *
 * Measured on a 4s 30fps push with the default 0.08 drift, reading the pan
 * position off a luma-ramp source (mean luma of the window is a sub-pixel
 * readout of its centre):
 *
 *   input 3840px (shipped): position quantum 0.26 output px. Through the moving
 *     part of the curve the pan tracks the ideal within 0.25 px; worst single
 *     frame in the fast section is 0.56 px off its intended step, and 1 of those
 *     27 frames does not move at all. On a real title card, 35 of 118 frame
 *     pairs are pixel-identical — 40 of the 50 frozen frames are in the eased
 *     tails, where the intended motion is under 0.15 px/frame anyway.
 *   input 7680px (oversample:2): quantum 0.125 px, zero frozen frames in the
 *     moving bands, worst step error 0.29 px. Costs 3.4x the filter CPU
 *     (3.9s -> 16.8s per 4s scene here) and +86MB peak RSS per scene chain,
 *     which render.mjs multiplies by the scene count in its single-graph path.
 *
 * So the default buys a quarter-pixel residual for no extra memory, and
 * oversample:2 is the knob when a scene's drift has to be glass-smooth. `d` is
 * not a lever here: it sets frames per input image, not positional precision.
 *
 * `d=1` is deliberate: every input in this pipeline is a stream (a
 * frame sequence, a video, or a still fed with `-loop 1 -t`), so one input frame
 * must yield one output frame. A `d` above 1 re-times the stream.
 *
 * @returns {{ filter: string|null, keyframes: Array, frames: number }}
 */
export function computeMotion(a, b, c, d) {
  const call = normaliseCall(a, b, c, d, arguments.length);
  const { scene, geometry, meta, opts } = call;
  const width = Math.round(Number(opts.width ?? meta.width ?? 1920));
  const height = Math.round(Number(opts.height ?? meta.height ?? 1080));
  const fps = Number(meta.fps ?? 30);
  const oversample = Number(opts.oversample ?? 1);

  const keyframes = computeKeyframes(scene, geometry, meta);
  const frames = keyframes.length;
  const type = scene.motion?.type ?? 'kenburns';

  if (type === 'none') return { filter: null, keyframes, frames };

  const first = keyframes[0];
  const last = keyframes[frames - 1];
  const spec = scene.motion ?? {};
  const easingName = spec.easing ?? meta.easing ?? 'easeInOutCubic';
  const holdFrames = clamp(Math.round((Number(spec.holdMs ?? 0) / 1000) * fps), 0, frames - 1);
  const moveFrames = Math.max(1, frames - 1 - holdFrames);

  // Register 0 holds raw progress, register 1 the eased value. Both are
  // recomputed per expression because zoompan evaluates z, x and y separately.
  const pre = `st(0,clip((on-${holdFrames})/${moveFrames},0,1));st(1,${easeExpr(easingName)});`;
  const z = `${pre}${n(first.zoom)}+(${n(last.zoom - first.zoom)})*ld(1)`;
  const x = `${pre}(${n(first.cx)}+(${n(last.cx - first.cx)})*ld(1))*iw-(iw/zoom/2)`;
  const y = `${pre}(${n(first.cy)}+(${n(last.cy - first.cy)})*ld(1))*ih-(ih/zoom/2)`;

  const chain = [];
  if (oversample > 1) chain.push(`scale=iw*${oversample}:ih*${oversample}:flags=lanczos`);
  chain.push(
    `zoompan=z='${z}':x='${x}':y='${y}':d=${Number(opts.d ?? 1)}:s=${width}x${height}:fps=${fps}`,
  );
  return { filter: chain.join(','), keyframes, frames };
}

/**
 * The filter string alone. This is the entry point render.mjs looks for, and it
 * must return a string (or null for static) — render falls back to its built-in
 * motion for anything else.
 */
export function buildMotionFilter(...args) {
  return computeMotion(...args).filter;
}
