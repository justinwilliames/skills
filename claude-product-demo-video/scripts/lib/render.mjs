/**
 * render — assemble out/<slug>.mp4 from captured scenes, voiceover, music and
 * captions.
 *
 * Reads:
 *   <work>/capture-manifest.json     what capture produced per scene
 *   <work>/vo/<sceneId>.wav          narration, one file per scene (optional)
 *   <work>/music/*                   one licensed track (optional)
 *   storyboard.json + brand.json     timing, transitions, styling
 *
 * Writes (stem = --out basename, else meta.slug):
 *   out/<stem>.mp4                   the video
 *   out/<stem>.srt / .ass            caption sidecars
 *   out/<stem>.render.json           what was actually done, for qa.mjs
 */

import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import {
  generateCaptionFiles,
  loadBrand,
  probeDurationSec,
  checkCaptionContrast,
} from './captions.mjs';
import { renderCaptionImages, buildCaptionOverlay, captionPalette } from './caption-images.mjs';

/** Above this many filter statements ffmpeg gets slow and unreadable, and one
 *  bad node fails the whole graph. Past it we render scenes to intermediates. */
export const MAX_GRAPH_NODES = 200;

const STILL_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac', '.aac']);

const DEFAULTS = {
  width: 1920,
  height: 1080,
  fps: 30,
  sceneDurationSec: 4,
  voPaddingSec: 0.8,
  transitionSec: 0.6,
  musicGainDb: -18,
  fadeInSec: 1.2,
  fadeOutSec: 2.0,
};

// ---------------------------------------------------------------------------
// pure timeline maths
// ---------------------------------------------------------------------------

/**
 * Resolve each scene's on-screen duration.
 *
 * Precedence: explicit `durationMs` wins; otherwise narration length plus
 * padding, so a scene is never cut mid-word; otherwise whatever capture
 * reported; otherwise the default.
 */
export function resolveSceneDurations(scenes, { voDurations = {}, captureDurations = {}, padSec = DEFAULTS.voPaddingSec, defaultSec = DEFAULTS.sceneDurationSec } = {}) {
  return scenes.map((scene) => {
    const vo = voDurations[scene.id] ?? 0;
    const captured = captureDurations[scene.id] ?? 0;
    let durationSec;
    if (scene.durationMs) durationSec = scene.durationMs / 1000;
    else if (vo > 0) durationSec = vo + padSec;
    else if (captured > 0) durationSec = captured;
    else durationSec = defaultSec;
    // capturedSec travels with the duration so the render can tell how much of
    // the scene has no source frames behind it — see sceneHoldSec.
    return { id: scene.id, durationSec, speechSec: vo, capturedSec: captured };
  });
}

/** Slack on top of the computed deficit. capturedSec is an estimate (frame
 *  count / fps, or a probe); under-padding by a frame truncates the whole
 *  timeline, and over-padding is discarded by the trim that follows. */
export const HOLD_SLACK_SEC = 0.25;

/**
 * How long the last captured frame must be held to fill the planned duration.
 *
 * A `frames` or `video` scene is a finite stream: if the narration outruns the
 * flow, ffmpeg's xfade ends when the source does and EVERY LATER SCENE IS
 * DROPPED — the video is silently truncated while the report still claims full
 * length. Stills do not need this; `-loop 1 -t` already holds them.
 */
export function sceneHoldSec({ kind, capturedSec, durationSec }) {
  if (kind === 'still') return 0;
  // Capture reported nothing: we cannot compute a deficit, so cover the whole
  // scene. Frames past the trim are discarded, a truncated timeline is not.
  if (!(capturedSec > 0)) return round3(durationSec);
  const deficit = durationSec - capturedSec;
  if (!(deficit > 0.001)) return 0;
  return round3(deficit + HOLD_SLACK_SEC);
}

/**
 * Build the xfade chain over a list of clips.
 *
 * The offset of the Nth transition is cumulative output duration MINUS the
 * transitions already consumed — every xfade overlaps its two neighbours, so an
 * offset computed from raw clip starts drifts later by the sum of all preceding
 * transition durations and the tail of the video plays over silence.
 *
 *   start_k  = SUM(d_0..d_k-1) - SUM(t_0..t_k-1)
 *   offset_k = start_k + d_k - t_k     (transition joining clips 0..k with k+1)
 *   total    = SUM(d) - SUM(t)
 *
 * @param {Array<{id:string, durationSec:number, transition?:{type?:string, durationSec?:number}}>} clips
 */
export function xfadeChain(clips) {
  if (!clips.length) return { steps: [], starts: [], totalSec: 0, transitions: [] };

  const transitions = clips.slice(0, -1).map((clip, i) => {
    const requested = clip.transition?.durationSec ?? DEFAULTS.transitionSec;
    const type = clip.transition?.type ?? 'fade';
    if (type === 'none' || !(requested > 0)) return { type: 'none', durationSec: 0 };
    // A transition longer than half of either neighbour eats the clip it is
    // supposed to join; ffmpeg accepts it and produces a mush of two scenes.
    const capped = Math.min(requested, clips[i].durationSec / 2, clips[i + 1].durationSec / 2);
    return { type, durationSec: Math.max(0, round3(capped)) };
  });

  const starts = [];
  let cursor = 0;
  for (let i = 0; i < clips.length; i += 1) {
    starts.push(round3(cursor));
    cursor += clips[i].durationSec - (transitions[i]?.durationSec ?? 0);
  }
  const totalSec = round3(
    clips.reduce((a, c) => a + c.durationSec, 0) - transitions.reduce((a, t) => a + t.durationSec, 0),
  );

  const steps = transitions.map((t, i) => ({
    index: i,
    left: i === 0 ? clips[0].id : `chain${i - 1}`,
    right: clips[i + 1].id,
    type: t.type,
    durationSec: t.durationSec,
    // Offset is where the transition BEGINS in the accumulated output stream.
    offsetSec: round3(starts[i] + clips[i].durationSec - t.durationSec),
  }));

  return { steps, starts, totalSec, transitions };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** Scene id -> position on the finished timeline, for captions and VO delay. */
export function sceneTiming(clips, chain) {
  const map = {};
  clips.forEach((clip, i) => {
    map[clip.id] = {
      startSec: chain.starts[i],
      durationSec: clip.durationSec,
      speechSec: clip.speechSec ?? clip.durationSec,
    };
  });
  return map;
}

// ---------------------------------------------------------------------------
// manifest normalisation
// ---------------------------------------------------------------------------

/**
 * capture.mjs may report an array or a keyed map, and may name the file `path`,
 * `file`, `video` or `pattern`. Normalise to one shape and infer the kind from
 * the extension when it is not stated.
 */
export function normaliseManifest(manifest, { work = '', cwd = '' } = {}) {
  const raw = Array.isArray(manifest)
    ? manifest
    : Array.isArray(manifest?.scenes)
      ? manifest.scenes
      : Object.entries(manifest ?? {}).map(([id, v]) => ({ id, ...v }));

  const entries = {};
  for (const item of raw) {
    if (!item?.id) continue;
    const pattern = item.pattern ?? item.frames ?? null;
    const file = item.path ?? item.file ?? item.video ?? item.still ?? item.image ?? null;
    const target = pattern ?? file;
    if (!target) continue;

    const ext = extname(String(target)).toLowerCase();
    let kind = item.kind ?? item.type ?? null;
    if (!kind) {
      if (pattern && /%\d*d/.test(String(pattern))) kind = 'frames';
      else if (VIDEO_EXT.has(ext)) kind = 'video';
      else if (STILL_EXT.has(ext)) kind = 'still';
    }
    if (kind === 'image' || kind === 'png' || kind === 'screenshot') kind = 'still';
    if (kind === 'webm' || kind === 'recording') kind = 'video';

    const durationSec = item.durationSec ?? (item.durationMs ? item.durationMs / 1000 : undefined);

    entries[item.id] = {
      id: item.id,
      kind: kind ?? 'still',
      path: resolvePath(target, work, cwd),
      fps: item.fps,
      frameCount: item.frameCount ?? item.frames?.length,
      startNumber: item.startNumber ?? 0,
      durationSec,
      // Captured geometry. motion.mjs resolves selector autozooms against these
      // boxes; drop them and every selector target degrades to a centre zoom.
      width: item.width,
      height: item.height,
      resolvedTargets: item.resolvedTargets ?? {},
    };
  }
  return entries;
}

function resolvePath(p, work, cwd) {
  const s = String(p);
  if (s.startsWith('/')) return s;
  const fromWork = work ? resolve(work, s) : null;
  // Patterns cannot be existence-checked; prefer the work dir, which is where
  // capture writes, and fall back to cwd for hand-authored manifests.
  if (fromWork && (existsSync(fromWork) || /%\d*d/.test(s))) return fromWork;
  const fromCwd = cwd ? resolve(cwd, s) : resolve(s);
  if (existsSync(fromCwd)) return fromCwd;
  return fromWork ?? fromCwd;
}

// ---------------------------------------------------------------------------
// filter construction
// ---------------------------------------------------------------------------

/** ffmpeg filter arguments are colon-delimited and bracket-scoped; a raw path
 *  containing either silently truncates the option. */
export function escapeFilterPath(p) {
  return String(p)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}

export function sceneInputArgs(entry, { fps, durationSec }) {
  if (entry.kind === 'frames') {
    return ['-framerate', String(fps), '-start_number', String(entry.startNumber ?? 0), '-i', entry.path];
  }
  if (entry.kind === 'video') {
    return ['-i', entry.path];
  }
  return ['-loop', '1', '-framerate', String(fps), '-t', String(durationSec), '-i', entry.path];
}

/**
 * Built-in motion, used when `motion.mjs` is absent or declines the scene.
 * zoompan runs with d=1 so one input frame yields one output frame and the zoom
 * is a function of the output frame index — the alternative (d=frames on a
 * single looped still) re-times the stream and desynchronises the chain.
 */
export function builtinMotionFilter({ motion, durationSec, fps, width, height, intensity = 0.08 }) {
  const type = motion?.type ?? 'kenburns';
  if (type === 'none') return null;

  const frames = Math.max(2, Math.round(durationSec * fps));
  const from = motion?.from ?? [0.5, 0.5, 1];
  const to = motion?.to ?? [0.5, 0.5, 1 + (type === 'autozoom' ? intensity * 2 : intensity)];
  const holdFrames = Math.round(((motion?.holdMs ?? 0) / 1000) * fps);
  const p = `min(max((on-${holdFrames})/${Math.max(1, frames - holdFrames - 1)},0),1)`;

  const lerp = (a, b) => `(${a}+(${b}-${a})*${p})`;
  const z = lerp(from[2] ?? 1, to[2] ?? 1);
  const cx = lerp(from[0] ?? 0.5, to[0] ?? 0.5);
  const cy = lerp(from[1] ?? 0.5, to[1] ?? 0.5);

  return (
    `zoompan=z='${z}':d=1:x='iw*${cx}-(iw/zoom/2)':y='ih*${cy}-(ih/zoom/2)'` +
    `:s=${width}x${height}:fps=${fps}`
  );
}

export function sceneVideoFilter({ index, entry, scene, fps, width, height, durationSec, capturedSec, motionFilter }) {
  const parts = [];
  // Oversample before zoompan or the pushed-in frame is a scaled-up crop of a
  // 1080p source and small type turns to mush.
  const sample = motionFilter ? 2 : 1;
  parts.push(`scale=${width * sample}:${height * sample}:force_original_aspect_ratio=increase`);
  parts.push(`crop=${width * sample}:${height * sample}`);
  parts.push('setsar=1');
  parts.push(`fps=${fps}`);
  // Hold the last frame BEFORE the motion filter: zoompan reads the output
  // frame index, so padding first spreads the push across the whole scene
  // instead of racing it and then freezing.
  const hold = sceneHoldSec({ kind: entry?.kind, capturedSec, durationSec });
  if (hold > 0) parts.push(`tpad=stop_mode=clone:stop_duration=${hold}`);
  if (motionFilter) parts.push(motionFilter);
  else if (sample !== 1) parts.push(`scale=${width}:${height}`);
  parts.push(`trim=duration=${durationSec}`);
  parts.push('setpts=PTS-STARTPTS');
  parts.push('format=yuv420p');
  void scene;
  return `[${index}:v]${parts.join(',')}[v${index}]`;
}

/** Chain the scene clips. Zero-duration joins become `concat`, which is a hard
 *  cut; xfade rejects duration=0 outright.
 *
 *  `concat` re-times its output to 1/1000000 and the next `xfade` then refuses
 *  the link ("input link timebases do not match"), so every concat is pinned
 *  back to the frame timebase. */
export function buildChainFilters(chain, clipLabels, { fps = DEFAULTS.fps } = {}) {
  const filters = [];
  let current = clipLabels[0];
  chain.steps.forEach((step, i) => {
    const next = clipLabels[i + 1];
    const label = i === chain.steps.length - 1 ? 'vchain' : `chain${i}`;
    if (step.durationSec <= 0 || step.type === 'none') {
      filters.push(`[${current}][${next}]concat=n=2:v=1:a=0,settb=1/${fps}[${label}]`);
    } else {
      filters.push(
        `[${current}][${next}]xfade=transition=${step.type}:duration=${step.durationSec}` +
          `:offset=${step.offsetSec}[${label}]`,
      );
    }
    current = label;
  });
  if (!chain.steps.length) filters.push(`[${clipLabels[0]}]null[vchain]`);
  return filters;
}

const AFMT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

export function buildAudioFilters({ voInputs, musicInput, totalSec, music = {}, voGainDb = 0 }) {
  const filters = [];
  const hasVo = voInputs.length > 0;
  const hasMusic = musicInput != null;

  if (hasVo) {
    voInputs.forEach((vo, i) => {
      const delayMs = Math.max(0, Math.round(vo.startSec * 1000));
      filters.push(
        `[${vo.index}:a]${AFMT},adelay=${delayMs}|${delayMs},volume=${voGainDb}dB[vo${i}]`,
      );
    });
    if (voInputs.length === 1) {
      filters.push(`[vo0]apad,atrim=0:${totalSec},asetpts=N/SR/TB[vobus]`);
    } else {
      const inputs = voInputs.map((_, i) => `[vo${i}]`).join('');
      filters.push(
        `${inputs}amix=inputs=${voInputs.length}:duration=longest:normalize=0[vosum]`,
        `[vosum]apad,atrim=0:${totalSec},asetpts=N/SR/TB[vobus]`,
      );
    }
  }

  if (hasMusic) {
    const gain = music.gainDb ?? DEFAULTS.musicGainDb;
    const fadeIn = (music.fadeInMs ?? DEFAULTS.fadeInSec * 1000) / 1000;
    const fadeOut = (music.fadeOutMs ?? DEFAULTS.fadeOutSec * 1000) / 1000;
    filters.push(
      `[${musicInput}:a]${AFMT},atrim=0:${totalSec},asetpts=N/SR/TB,volume=${gain}dB,` +
        `afade=t=in:st=0:d=${fadeIn},` +
        `afade=t=out:st=${round3(Math.max(0, totalSec - fadeOut))}:d=${fadeOut}[music]`,
    );
  }

  if (hasVo && hasMusic) {
    if (music.duck !== false) {
      filters.push(
        '[vobus]asplit=2[vomain][vosc]',
        // Music keys off the VO bus: it drops under narration and recovers in
        // the gaps. Without this the mix is a slideshow with a song over it.
        '[music][vosc]sidechaincompress=threshold=0.035:ratio=8:attack=15:release=350[mduck]',
        '[mduck][vomain]amix=inputs=2:duration=first:normalize=0[amixed]',
      );
    } else {
      filters.push('[music][vobus]amix=inputs=2:duration=first:normalize=0[amixed]');
    }
  } else if (hasVo) {
    filters.push('[vobus]anull[amixed]');
  } else if (hasMusic) {
    filters.push('[music]anull[amixed]');
  } else {
    return { filters, label: null };
  }

  // -16 LUFS stereo is the streaming target; without it a quiet VO and a loud
  // track land at wildly different levels on every platform.
  filters.push(`[amixed]loudnorm=I=-16:TP=-1.5:LRA=11,${AFMT}[aout]`);
  return { filters, label: 'aout' };
}

/**
 * ffmpeg has no SVG decoder — it reports `no decoder found for: svg` and aborts
 * the whole graph. The brand schema tells people to prefer SVG (correctly: it
 * survives any frame size), so the two would collide on every vector watermark.
 * Rasterise through the browser we already depend on, and cache the result.
 *
 * @returns a path ffmpeg can actually read, or null when there is no watermark.
 */
export async function rasterisedWatermark(watermarkPath, { workDir, heightPx, log } = {}) {
  if (!watermarkPath || !existsSync(watermarkPath)) return null;
  if (extname(watermarkPath).toLowerCase() !== '.svg') return watermarkPath;

  const outPath = join(workDir, `watermark-${heightPx}.png`);
  if (existsSync(outPath)) return outPath;

  const svg = await readFile(watermarkPath, 'utf8');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 16, height: 16 }, deviceScaleFactor: 1 });
    // A transparent background matters: the watermark is composited over video.
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;height:${heightPx}px;width:auto}</style>${svg}`,
      { waitUntil: 'load' },
    );
    const el = await page.$('svg');
    if (!el) {
      log?.(`  watermark has no <svg> root, skipping: ${basename(watermarkPath)}`);
      return null;
    }
    await mkdir(workDir, { recursive: true });
    await el.screenshot({ path: outPath, omitBackground: true });
    log?.(`render: rasterised watermark ${basename(watermarkPath)} -> ${basename(outPath)} (${heightPx}px)`);
    return outPath;
  } finally {
    await browser.close();
  }
}

export function buildPostFilters({ watermarkIndex, watermarkHeight, margin, assPath, fontsDir, captionOverlay, inLabel = 'vchain', outLabel = 'vout' }) {
  const filters = [];
  let current = inLabel;

  if (watermarkIndex != null) {
    filters.push(`[${watermarkIndex}:v]scale=-1:${watermarkHeight}[wm]`);
    filters.push(`[${current}][wm]overlay=W-w-${margin}:H-h-${margin}[vwm]`);
    current = 'vwm';
  }
  // Browser-rendered caption PNGs. Preferred over the ass filter: it needs
  // libass, which plenty of ffmpeg builds ship without, and it cannot match the
  // brand's typesetting even when present. See caption-images.mjs.
  if (captionOverlay?.filters?.length) {
    const relabelled = captionOverlay.filters.map((f, i) =>
      i === 0 ? f.replace(`[${captionOverlay.inLabel}]`, `[${current}]`) : f,
    );
    filters.push(...relabelled);
    current = captionOverlay.outLabel;
  }
  if (assPath) {
    // fontsdir keeps burn-in off system font installation — the brand font
    // ships with the project or the captions render in a substitute.
    const args = [`filename='${escapeFilterPath(assPath)}'`];
    if (fontsDir) args.push(`fontsdir='${escapeFilterPath(fontsDir)}'`);
    filters.push(`[${current}]ass=${args.join(':')}[vass]`);
    current = 'vass';
  }
  filters.push(`[${current}]null[${outLabel}]`);
  return filters;
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

export function runFfmpeg(args, { log, debug } = {}) {
  return new Promise((res, rej) => {
    debug?.(`ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    proc.on('error', rej);
    proc.on('close', (code) => {
      if (code === 0) return res(stderr);
      log?.(stderr.split('\n').slice(-25).join('\n'));
      rej(new Error(`ffmpeg exited ${code}`));
    });
  });
}

async function ffmpegHasFilter(name) {
  return new Promise((res) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d.toString();
    });
    proc.on('error', () => res(false));
    proc.on('close', () => res(new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(out)));
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * motion.mjs is a sibling stage helper owned elsewhere in the pipeline. Probe
 * for it rather than hard-importing, so render still assembles a video when it
 * has not landed yet, and log which motion path was taken.
 */
async function loadMotionBuilder(ctx) {
  try {
    const mod = await import('./motion.mjs');
    for (const name of ['buildMotionFilter', 'motionFilter', 'buildFilter', 'toFilter']) {
      if (typeof mod[name] === 'function') return { fn: mod[name], source: `motion.mjs:${name}` };
    }
    ctx.log('render: motion.mjs exports no known filter builder — using built-in motion');
  } catch {
    ctx.debug('render: motion.mjs not present — using built-in motion');
  }
  return { fn: null, source: 'builtin' };
}

/** music.mjs writes `music-manifest.json`; the other two names are older
 *  hand-authored layouts, kept so an existing work dir still renders. */
const MUSIC_MANIFEST_NAMES = ['music-manifest.json', 'manifest.json', 'music.json'];

/**
 * The music stage's decision, not a directory guess.
 *
 * Reading the manifest is what makes `--no-music`, `--music-file` and the
 * gain/duck/fade settings reach the mix; scanning the directory instead picks
 * the alphabetically-first file and ignores every one of them.
 *
 * @returns {{path: string|null, disabled: boolean, settings: object, source: string}}
 */
export async function loadMusicSelection(musicDir) {
  const none = { path: null, disabled: false, settings: {}, source: 'none' };
  if (!existsSync(musicDir)) return none;
  const names = await readdir(musicDir);

  const manifestName = MUSIC_MANIFEST_NAMES.find((n) => names.includes(n));
  if (manifestName) {
    let m = null;
    try {
      m = await readJson(join(musicDir, manifestName));
    } catch {
      m = null;
    }
    if (m) {
      const settings = {};
      for (const k of ['gainDb', 'duck', 'fadeInMs', 'fadeOutMs']) {
        if (m[k] !== undefined && m[k] !== null) settings[k] = m[k];
      }
      if (m.disabled) return { path: null, disabled: true, settings, source: manifestName };
      const declared = m.track?.path ?? m.path ?? m.file ?? (typeof m.track === 'string' ? m.track : null);
      if (declared) {
        const p = declared.startsWith('/') ? declared : join(musicDir, basename(declared));
        if (existsSync(p)) return { path: p, disabled: false, settings, source: manifestName };
      }
      // A manifest that names no playable track is a decision too: silence.
      return { path: null, disabled: false, settings, source: manifestName };
    }
  }

  const audio = names.filter((n) => AUDIO_EXT.has(extname(n).toLowerCase())).sort();
  return audio.length
    ? { path: join(musicDir, audio[0]), disabled: false, settings: {}, source: 'directory-scan' }
    : none;
}

async function collectFontFiles(brand, destDir) {
  const files = [
    ...(brand?.type?.display?.fontFiles ?? []),
    ...(brand?.type?.body?.fontFiles ?? []),
  ]
    .map((f) => f?.path)
    .filter((p) => p && existsSync(p));
  if (!files.length) return null;
  await mkdir(destDir, { recursive: true });
  for (const f of files) await copyFile(f, join(destDir, basename(f)));
  return destDir;
}

const OUTPUT_ARGS = (fps, totalSec, hasAudio) => [
  '-c:v', 'libx264',
  '-profile:v', 'high',
  '-pix_fmt', 'yuv420p',
  '-crf', '18',
  '-preset', 'medium',
  '-r', String(fps),
  '-movflags', '+faststart',
  ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : ['-an']),
  '-t', String(totalSec),
];

/** intro/outro stings come from anywhere; concatenating them without matching
 *  resolution, fps, pixel format, timebase and sample rate corrupts the
 *  timeline instead of failing loudly. */
async function normaliseSting(src, dest, { width, height, fps }, ctx) {
  const vf =
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v]`;
  const encode = [
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '18',
    '-preset', 'medium', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
  ];

  // A silent sting must still carry a stereo 48k track or the concat drops the
  // audio stream for the whole timeline.
  const silent = !(await hasAudioStream(src));
  if (silent) ctx.debug(`render: sting ${basename(src)} has no audio — padding with silence`);

  const args = silent
    ? ['-y', '-i', src, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
       '-filter_complex', vf, '-map', '[v]', '-map', '1:a', '-shortest', ...encode, dest]
    : ['-y', '-i', src, '-filter_complex', `${vf};[0:a]${AFMT}[a]`,
       '-map', '[v]', '-map', '[a]', ...encode, dest];

  await runFfmpeg(args, ctx);
  return dest;
}

async function hasAudioStream(file) {
  return new Promise((res) => {
    const proc = spawn(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d.toString();
    });
    proc.on('error', () => res(false));
    proc.on('close', () => res(out.trim().length > 0));
  });
}

// ---------------------------------------------------------------------------
// stage entry
// ---------------------------------------------------------------------------

export async function run(ctx) {
  const storyboardPath = resolve(ctx.cwd, ctx.storyboard ?? 'storyboard.json');
  const storyboard = await readJson(storyboardPath);
  const brand = await loadBrand(storyboardPath, storyboard);
  // Brand asset paths are relative to brand.json, not to the storyboard.
  const brandDir = storyboard?.meta?.brandPath
    ? dirname(resolve(dirname(storyboardPath), storyboard.meta.brandPath))
    : dirname(storyboardPath);

  const meta = storyboard.meta ?? {};
  const width = meta.width ?? DEFAULTS.width;
  const height = meta.height ?? DEFAULTS.height;
  const fps = meta.fps ?? DEFAULTS.fps;
  const slug = meta.slug ?? 'video';

  const work = ctx.work;
  const renderDir = join(work, 'render');
  await mkdir(renderDir, { recursive: true });

  const manifestPath = existsSync(join(work, 'capture-manifest.json'))
    ? join(work, 'capture-manifest.json')
    : resolve(ctx.cwd, 'capture-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`capture manifest not found: ${manifestPath}`);
  const entries = normaliseManifest(await readJson(manifestPath), { work, cwd: ctx.cwd });

  const scenes = (storyboard.scenes ?? []).filter((s) => {
    if (entries[s.id]) return true;
    ctx.log(`render: scene "${s.id}" has no capture entry — skipped`);
    return false;
  });
  if (!scenes.length) throw new Error('no scenes with capture output');

  // Durations come off the real wavs, not a words-per-minute estimate.
  const voDurations = {};
  const voPaths = {};
  for (const scene of scenes) {
    const wav = join(work, 'vo', `${scene.id}.wav`);
    if (!existsSync(wav)) continue;
    voPaths[scene.id] = wav;
    voDurations[scene.id] = await probeDurationSec(wav);
  }
  // How much source there actually IS, measured off the stream rather than the
  // manifest's intent — the deficit that tpad has to cover is computed from it,
  // so a frame count that disagrees with a declared duration must not win.
  const captureDurations = {};
  for (const scene of scenes) {
    const e = entries[scene.id];
    if (e.kind === 'frames' && e.frameCount) captureDurations[scene.id] = e.frameCount / (e.fps ?? fps);
    else if (e.kind === 'video' && existsSync(e.path)) captureDurations[scene.id] = await probeDurationSec(e.path);
    else if (e.durationSec) captureDurations[scene.id] = e.durationSec;
  }

  const durations = resolveSceneDurations(scenes, { voDurations, captureDurations });
  const clips = scenes.map((scene, i) => ({
    id: scene.id,
    durationSec: durations[i].durationSec,
    speechSec: durations[i].speechSec,
    capturedSec: durations[i].capturedSec,
    transition: {
      type: scene.transitionOut?.type ?? brand?.motion?.defaultTransition ?? 'fade',
      durationSec: (scene.transitionOut?.durationMs ?? brand?.motion?.transitionMs ?? DEFAULTS.transitionSec * 1000) / 1000,
    },
  }));
  const chain = xfadeChain(clips);
  const timing = sceneTiming(clips, chain);
  ctx.log(`render: ${clips.length} scenes, ${chain.totalSec}s body at ${width}x${height}@${fps}`);

  // A held last frame is a visible freeze. Say so — loudly, per scene — so a
  // five-second stare at a static screen is a reported fact, not a surprise.
  const holds = clips.map((c, i) =>
    sceneHoldSec({ kind: entries[scenes[i].id].kind, capturedSec: c.capturedSec, durationSec: c.durationSec }),
  );
  clips.forEach((c, i) => {
    if (holds[i] <= 0) return;
    const freeze = round3(Math.max(0, c.durationSec - (c.capturedSec ?? 0)));
    ctx.log(
      `render: scene "${c.id}" captured ${round3(c.capturedSec ?? 0)}s but runs ${c.durationSec}s — ` +
        `HOLDING the last frame for ${freeze}s (narration outran the flow; give the scene more steps or trim the VO)`,
    );
  });

  // captions ------------------------------------------------------------
  // Sidecars are named after the OUTPUT file, not the slug: two runs of one
  // storyboard to different --out paths must not clobber each other's report.
  // --out is a directory in every other stage, so accept one here too rather
  // than failing with EISDIR after the whole render has already been paid for.
  const outArg = resolve(ctx.cwd, ctx.out ?? `out/${slug}.mp4`);
  const finalPath =
    extname(outArg) === '' || (existsSync(outArg) && statSync(outArg).isDirectory())
      ? join(outArg, `${slug}.mp4`)
      : outArg;
  const outDir = dirname(finalPath);
  const stem = basename(finalPath, extname(finalPath));
  await mkdir(outDir, { recursive: true });
  const captionsEnabled = storyboard.captions?.enabled !== false;
  let captionFiles = null;
  if (captionsEnabled) {
    captionFiles = await generateCaptionFiles({
      storyboard: { ...storyboard, scenes },
      brand,
      timing,
      srtPath: join(outDir, `${stem}.srt`),
      assPath: join(outDir, `${stem}.ass`),
    });
  }
  // Captions are burned in as browser-rendered PNGs rather than through the
  // ass filter: portable to any ffmpeg build, and typeset in the brand's own
  // font instead of libass's approximation of it.
  let captionImages = null;
  if (captionFiles?.cues?.length) {
    captionImages = await renderCaptionImages(captionFiles.cues, {
      brand,
      brandDir,
      meta: {
        width,
        height,
        captionStyle: storyboard.captions?.style ?? 'bar',
        captionPosition: storyboard.captions?.position ?? 'bottom',
      },
      outDir: join(renderDir, 'captions'),
      log: ctx.log,
    });
  }
  const burnCaptions = Boolean(captionImages?.images?.length);
  if (captionFiles && !burnCaptions) {
    ctx.log('render: no caption images produced — captions written as sidecars only, NOT burned in');
  }
  const fontsDir = null;

  // motion --------------------------------------------------------------
  const motion = await loadMotionBuilder(ctx);
  const motionFilters = scenes.map((scene, i) => {
    const entry = entries[scene.id];
    const args = {
      motion: scene.motion,
      scene,
      durationSec: clips[i].durationSec,
      fps,
      width,
      height,
      brand,
      intensity: brand?.motion?.kenBurnsIntensity ?? 0.08,
      // Captured pixel space + the element boxes capture resolved. Without this
      // every selector autozoom silently degrades to a dead-centre push.
      geometry: {
        width: entry.width ?? width,
        height: entry.height ?? height,
        resolvedTargets: entry.resolvedTargets ?? {},
      },
    };
    if (motion.fn) {
      try {
        const f = motion.fn(args);
        if (typeof f === 'string' && f.trim()) return f.trim();
      } catch (err) {
        // A motion spec that cannot be honoured is a build defect, not a debug
        // note — the fallback below ignores the target entirely.
        ctx.log(`render: motion for "${scene.id}" could not be built (${err.message}) — falling back to built-in motion`);
      }
    }
    return builtinMotionFilter(args);
  });
  ctx.log(`render: motion source = ${motion.source}`);

  // inputs --------------------------------------------------------------
  const inputArgs = [];
  const videoInputIndex = [];
  scenes.forEach((scene, i) => {
    videoInputIndex.push(countInputs(inputArgs));
    inputArgs.push(...sceneInputArgs(entries[scene.id], { fps, durationSec: clips[i].durationSec }));
  });

  const voInputs = [];
  for (const scene of scenes) {
    if (!voPaths[scene.id]) continue;
    voInputs.push({ index: countInputs(inputArgs), startSec: timing[scene.id].startSec });
    inputArgs.push('-i', voPaths[scene.id]);
  }

  // The music stage's manifest is authoritative: it carries --no-music,
  // --music-file and the gain/duck/fade settings the mix has to honour.
  const selection = await loadMusicSelection(join(work, 'music'));
  const musicCfg = { ...(storyboard.audio?.music ?? {}), ...selection.settings };
  const musicPath = musicCfg.mood === 'none' || selection.disabled ? null : selection.path;
  if (selection.disabled) ctx.log(`render: music disabled by ${selection.source} — voiceover only`);
  else if (musicPath) ctx.log(`render: music ${basename(musicPath)} (from ${selection.source})`);
  let musicIndex = null;
  if (musicPath) {
    musicIndex = countInputs(inputArgs);
    inputArgs.push('-stream_loop', '-1', '-i', musicPath);
  }

  const wmHeight = Math.round(height * 0.055);
  const watermarkSrc = brand?.assets?.watermark
    ? resolve(brandDir, brand.assets.watermark)
    : null;
  const watermarkPath = await rasterisedWatermark(watermarkSrc, {
    workDir: ctx.work,
    heightPx: wmHeight * 2,
    log: ctx.log,
  });
  let watermarkIndex = null;
  if (watermarkPath && existsSync(watermarkPath)) {
    watermarkIndex = countInputs(inputArgs);
    inputArgs.push('-i', watermarkPath);
  }

  const audio = buildAudioFilters({
    voInputs,
    musicInput: musicIndex,
    totalSec: chain.totalSec,
    music: musicCfg,
    voGainDb: storyboard.audio?.voice?.gainDb ?? 0,
  });

  const introVideo = pathIfExists(brand?.assets?.introVideo, ctx.cwd);
  const outroVideo = pathIfExists(brand?.assets?.outroVideo, ctx.cwd);
  const needsConcat = Boolean(introVideo || outroVideo);

  const wmMargin = Math.round(wmHeight * (brand?.logo?.safeAreaRatio ?? 0.5));
  // With a sting to concatenate the body is encoded first and captions are
  // burned after the join, where the timeline has shifted; otherwise it is all
  // one pass and one encode.
  const captionOverlay =
    !needsConcat && burnCaptions
      ? buildCaptionOverlay({
          images: captionImages.images,
          firstInputIndex: countInputs(inputArgs),
          meta: { width, height, captionPosition: storyboard.captions?.position ?? 'bottom' },
          inLabel: 'vcap-in',
          outLabel: 'vcaps',
        })
      : null;
  if (captionOverlay?.inputArgs?.length) inputArgs.push(...captionOverlay.inputArgs);

  const postFilters = needsConcat
    ? buildPostFilters({ watermarkIndex: null, inLabel: 'vchain', outLabel: 'vout' })
    : buildPostFilters({
        watermarkIndex,
        watermarkHeight: wmHeight,
        margin: wmMargin,
        captionOverlay,
        inLabel: 'vchain',
        outLabel: 'vout',
      });

  const sceneFilters = scenes.map((scene, i) =>
    sceneVideoFilter({
      index: videoInputIndex[i],
      entry: entries[scene.id],
      scene,
      fps,
      width,
      height,
      durationSec: clips[i].durationSec,
      capturedSec: clips[i].capturedSec,
      motionFilter: motionFilters[i],
    }),
  );
  const chainFilters = buildChainFilters(chain, scenes.map((_, i) => `v${videoInputIndex[i]}`), { fps });
  const graph = [...sceneFilters, ...chainFilters, ...postFilters, ...audio.filters];

  const bodyPath = join(renderDir, `${stem}.body.mp4`);
  let graphPath = 'single-graph';

  // Overridable so the intermediates path can be exercised without a
  // hundred-scene storyboard: `--max-graph-nodes 5`.
  const requestedMax = Number.parseInt(ctx['max-graph-nodes'] ?? ctx.maxGraphNodes, 10);
  const maxNodes = Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : MAX_GRAPH_NODES;

  if (graph.length > maxNodes) {
    graphPath = 'per-scene-intermediates';
    ctx.log(`render: filter graph is ${graph.length} nodes (> ${maxNodes}) — rendering scenes to intermediates first`);
    const intermediates = [];
    for (let i = 0; i < scenes.length; i += 1) {
      const dest = join(renderDir, 'scenes', `${scenes[i].id}.mp4`);
      await mkdir(dirname(dest), { recursive: true });
      await runFfmpeg(
        [
          '-y',
          ...sceneInputArgs(entries[scenes[i].id], { fps, durationSec: clips[i].durationSec }),
          '-filter_complex', sceneVideoFilter({
            index: 0,
            entry: entries[scenes[i].id],
            scene: scenes[i],
            fps,
            width,
            height,
            durationSec: clips[i].durationSec,
            capturedSec: clips[i].capturedSec,
            motionFilter: motionFilters[i],
          }).replace('[v0]', '[vout]'),
          '-map', '[vout]',
          ...OUTPUT_ARGS(fps, clips[i].durationSec, false),
          dest,
        ],
        ctx,
      );
      intermediates.push(dest);
    }
    const args2 = ['-y'];
    intermediates.forEach((p) => args2.push('-i', p));
    const offset = intermediates.length;
    const voArgs = [];
    voInputs.forEach((vo, i) => {
      voArgs.push({ index: offset + i, startSec: vo.startSec });
    });
    for (const scene of scenes) if (voPaths[scene.id]) args2.push('-i', voPaths[scene.id]);
    let musicIdx2 = null;
    if (musicPath) {
      musicIdx2 = countInputs(args2);
      args2.push('-stream_loop', '-1', '-i', musicPath);
    }
    let wmIdx2 = null;
    if (watermarkIndex != null && !needsConcat) {
      wmIdx2 = countInputs(args2);
      args2.push('-i', watermarkPath);
    }
    const audio2 = buildAudioFilters({
      voInputs: voArgs,
      musicInput: musicIdx2,
      totalSec: chain.totalSec,
      music: musicCfg,
      voGainDb: storyboard.audio?.voice?.gainDb ?? 0,
    });
    const pass = intermediates.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[v${i}]`);
    const post2 = needsConcat
      ? buildPostFilters({ watermarkIndex: null, inLabel: 'vchain', outLabel: 'vout' })
      : buildPostFilters({
          watermarkIndex: wmIdx2,
          watermarkHeight: wmHeight,
          margin: wmMargin,
          assPath: burnCaptions ? captionFiles.assPath : null,
          fontsDir,
          inLabel: 'vchain',
          outLabel: 'vout',
        });
    const graph2 = [
      ...pass,
      ...buildChainFilters(chain, intermediates.map((_, i) => `v${i}`), { fps }),
      ...post2,
      ...audio2.filters,
    ];
    args2.push('-filter_complex', graph2.join(';'), '-map', '[vout]');
    if (audio2.label) args2.push('-map', `[${audio2.label}]`);
    args2.push(...OUTPUT_ARGS(fps, chain.totalSec, Boolean(audio2.label)), bodyPath);
    await runFfmpeg(args2, ctx);
  } else {
    ctx.log(`render: single filter_complex graph, ${graph.length} nodes`);
    const args = ['-y', ...inputArgs, '-filter_complex', graph.join(';'), '-map', '[vout]'];
    if (audio.label) args.push('-map', `[${audio.label}]`);
    args.push(...OUTPUT_ARGS(fps, chain.totalSec, Boolean(audio.label)), bodyPath);
    await runFfmpeg(args, ctx);
  }

  // stings + final pass --------------------------------------------------
  let totalSec = chain.totalSec;

  if (!needsConcat) {
    await rename(bodyPath, finalPath).catch(async () => {
      await copyFile(bodyPath, finalPath);
    });
  } else {
    const pieces = [];
    let introSec = 0;
    if (introVideo) {
      const p = await normaliseSting(introVideo, join(renderDir, 'intro.mp4'), { width, height, fps }, ctx);
      introSec = await probeDurationSec(p);
      pieces.push(p);
    }
    pieces.push(bodyPath);
    if (outroVideo) {
      pieces.push(await normaliseSting(outroVideo, join(renderDir, 'outro.mp4'), { width, height, fps }, ctx));
    }
    const listPath = join(renderDir, 'concat.txt');
    await writeFile(listPath, pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const joined = join(renderDir, `${stem}.joined.mp4`);
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', joined], ctx);
    totalSec = round3(await probeDurationSec(joined));

    // Captions were timed against the body; prepending an intro shifts them.
    if (captionFiles && introSec > 0) {
      const shifted = shiftCues(captionFiles.cues, introSec);
      captionFiles = await generateCaptionFilesShifted(captionFiles, shifted, storyboard, brand, meta);
    }
    const finalArgs = ['-y', '-i', joined];
    let wmIdx = null;
    if (watermarkIndex != null) {
      wmIdx = 1;
      finalArgs.push('-i', watermarkPath);
    }
    const post = buildPostFilters({
      watermarkIndex: wmIdx,
      watermarkHeight: wmHeight,
      margin: wmMargin,
      assPath: burnCaptions ? captionFiles.assPath : null,
      fontsDir,
      inLabel: '0:v',
      outLabel: 'vout',
    });
    finalArgs.push('-filter_complex', post.join(';'), '-map', '[vout]', '-map', '0:a?');
    finalArgs.push(...OUTPUT_ARGS(fps, totalSec, true), finalPath);
    await runFfmpeg(finalArgs, ctx);
  }

  const attribution = join(work, 'music', 'ATTRIBUTION.md');
  if (existsSync(attribution)) await copyFile(attribution, join(outDir, 'ATTRIBUTION.md'));

  const report = {
    video: finalPath,
    slug,
    width,
    height,
    fps,
    totalSec,
    graphPath,
    motionSource: motion.source,
    scenes: clips.map((c, i) => ({ ...c, startSec: chain.starts[i], holdSec: holds[i] })),
    transitions: chain.steps,
    audio: {
      voTracks: voInputs.length,
      music: musicPath ? basename(musicPath) : null,
      ducked: Boolean(musicPath && voInputs.length && musicCfg.duck !== false),
      loudnormTarget: -16,
    },
    captions: captionFiles
      ? {
          burnedIn: burnCaptions,
          srt: captionFiles.srtPath,
          ass: captionFiles.assPath,
          cueCount: captionFiles.cueCount,
          // Measured off the palette the caption images were actually drawn
          // with, so the QA gate reads the real number rather than a prediction.
          contrast: captionImages?.palette
            ? { ratio: captionImages.palette.ratio, style: storyboard.captions?.style ?? 'bar' }
            : checkCaptionContrast({ brand, style: storyboard.captions?.style ?? 'bar' }),
        }
      : { burnedIn: false },
    attribution: existsSync(attribution) ? join(outDir, 'ATTRIBUTION.md') : null,
  };
  const reportPath = join(outDir, `${stem}.render.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  ctx.log(`render: wrote ${finalPath} (${totalSec}s) and ${reportPath}`);
  return report;
}

function shiftCues(cues, bySec) {
  return cues.map((c) => ({ ...c, startSec: c.startSec + bySec, endSec: c.endSec + bySec }));
}

async function generateCaptionFilesShifted(previous, cues, storyboard, brand, meta) {
  const { toSrt, toAss } = await import('./captions.mjs');
  await writeFile(previous.srtPath, toSrt(cues), 'utf8');
  await writeFile(
    previous.assPath,
    toAss(cues, {
      brand,
      width: meta.width ?? DEFAULTS.width,
      height: meta.height ?? DEFAULTS.height,
      style: storyboard.captions?.style ?? 'bar',
      position: storyboard.captions?.position ?? 'bottom',
    }),
    'utf8',
  );
  return { ...previous, cues };
}

/** ffmpeg numbers inputs by `-i` occurrence, not by argv position. */
export function countInputs(args) {
  return args.filter((a) => a === '-i').length;
}

function pathIfExists(p, cwd) {
  if (!p) return null;
  const abs = p.startsWith('/') ? p : resolve(cwd, p);
  return existsSync(abs) ? abs : null;
}
