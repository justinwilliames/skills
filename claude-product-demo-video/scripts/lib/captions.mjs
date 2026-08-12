/**
 * captions — narration to timed, styled caption cues.
 *
 * Reads the storyboard plus the real voiceover durations and writes two files
 * per video: a portable `.srt` sidecar and a `.ass` styled for burn-in from
 * brand tokens. `render.mjs` burns the `.ass`; `qa.mjs` calls
 * `checkCaptionContrast` to prove the result is legible.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_MAX_CHARS_PER_LINE = 42;
export const DEFAULT_MAX_LINES = 2;

/** WCAG AA for large text. Captions are always large text at 1080p. */
export const MIN_CAPTION_CONTRAST = 3.0;

/** ASS `BackColour` opacity for the `bar` style. */
const BAR_OPACITY = 0.85;

// ---------------------------------------------------------------------------
// splitting
// ---------------------------------------------------------------------------

/**
 * Greedy word wrap. Never breaks inside a word: a token longer than the limit
 * gets a line to itself rather than being hyphenated or truncated.
 */
export function wrapLines(text, maxCharsPerLine = DEFAULT_MAX_CHARS_PER_LINE) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= maxCharsPerLine) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Break narration at clause boundaries — sentence enders first, then commas,
 * semicolons, colons and dashes. Splitting on punctuation rather than a fixed
 * character count is what keeps a cue from cutting across a grammatical unit.
 */
export function clauseSegments(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?,;:—–])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pack clause segments into cues of at most `maxLines` wrapped lines.
 * A single segment too long for one cue is split on line boundaries, which are
 * themselves word boundaries — so a cue never ends mid-word.
 */
export function splitIntoCues(text, options = {}) {
  const maxCharsPerLine = options.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const segments = clauseSegments(text);
  const cues = [];
  let current = '';

  const flush = () => {
    if (current) cues.push(current);
    current = '';
  };

  for (const segment of segments) {
    const candidate = current ? `${current} ${segment}` : segment;
    if (wrapLines(candidate, maxCharsPerLine).length <= maxLines) {
      current = candidate;
      continue;
    }
    flush();

    const wrapped = wrapLines(segment, maxCharsPerLine);
    if (wrapped.length <= maxLines) {
      current = segment;
      continue;
    }
    for (let i = 0; i < wrapped.length; i += maxLines) {
      const chunk = wrapped.slice(i, i + maxLines).join(' ');
      if (i + maxLines >= wrapped.length) current = chunk;
      else cues.push(chunk);
    }
  }
  flush();

  return cues.map((t) => ({ text: t, lines: wrapLines(t, maxCharsPerLine) }));
}

/**
 * Spread cues across the scene's ACTUAL voiceover duration, proportional to
 * character count. Timing off the real wav is the only way captions stay in
 * step with narration — a words-per-minute estimate drifts within one scene.
 */
export function distributeCues(cues, startSec, durationSec) {
  if (!cues.length) return [];
  const weights = cues.map((c) => Math.max(c.text.length, 1));
  const total = weights.reduce((a, b) => a + b, 0);

  let cursor = startSec;
  return cues.map((cue, i) => {
    const span = (weights[i] / total) * durationSec;
    const start = cursor;
    // Last cue lands exactly on the scene end; float drift never accumulates.
    const end = i === cues.length - 1 ? startSec + durationSec : start + span;
    cursor = end;
    return { ...cue, startSec: start, endSec: end };
  });
}

/**
 * @param {Array<{id:string, narration?:string}>} scenes
 * @param {Map<string,{startSec:number,durationSec:number}>|object} timing
 *        Per-scene position on the OUTPUT timeline, from render's xfade chain.
 */
export function buildCues(scenes, timing, options = {}) {
  const get = (id) => (timing instanceof Map ? timing.get(id) : timing?.[id]);
  const out = [];
  for (const scene of scenes) {
    const t = get(scene.id);
    if (!t || !scene.narration) continue;
    const speech = Math.min(t.speechSec ?? t.durationSec, t.durationSec);
    if (!(speech > 0)) continue;
    const cues = splitIntoCues(scene.narration, options);
    for (const cue of distributeCues(cues, t.startSec, speech)) {
      out.push({ ...cue, sceneId: scene.id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

function pad(n, width = 2) {
  return String(Math.floor(n)).padStart(width, '0');
}

/**
 * Round ONCE, into the smallest unit, then derive every field from that integer.
 * Rounding the fraction on its own overflows it — 59.9996s became "59,1000",
 * which is both malformed (SRT wants exactly three digits) and a second wrong.
 */
function splitTime(sec, ticksPerSec) {
  const total = Math.round(Math.max(0, sec) * ticksPerSec);
  const frac = total % ticksPerSec;
  const whole = (total - frac) / ticksPerSec;
  return { h: Math.floor(whole / 3600), m: Math.floor(whole / 60) % 60, s: whole % 60, frac };
}

export function formatSrtTime(sec) {
  const { h, m, s, frac } = splitTime(sec, 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(frac, 3)}`;
}

export function formatAssTime(sec) {
  const { h, m, s, frac } = splitTime(sec, 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(frac, 2)}`;
}

export function toSrt(cues) {
  return (
    cues
      .map((cue, i) =>
        [
          String(i + 1),
          `${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}`,
          cue.lines.join('\n'),
        ].join('\n'),
      )
      .join('\n\n') + '\n'
  );
}

/** ASS colours are `&HAABBGGRR` — byte-reversed RGB, and alpha is INVERTED. */
export function assColour(hex, opacity = 1) {
  const { r, g, b } = parseHex(hex);
  const alpha = Math.round((1 - clamp01(opacity)) * 255);
  const h = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  return `&H${h(alpha)}${h(b)}${h(g)}${h(r)}`;
}

function assEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

export function assStyle(brand, options = {}) {
  const style = options.style ?? 'bar';
  const colour = brand?.color ?? {};
  const text = colour.text ?? '#ffffff';
  const surface = colour.surface ?? colour.background ?? '#101014';
  const height = options.height ?? 1080;

  const base = {
    fontName: brand?.type?.display?.family ?? 'Helvetica',
    fontSize: Math.round(height * 0.044),
    primary: assColour(text, 1),
    outline: assColour(surface, 1),
    back: assColour(surface, BAR_OPACITY),
    borderStyle: 3,
    outlineWidth: 12,
    shadow: 0,
    bold: (brand?.type?.display?.weight ?? 700) >= 600 ? -1 : 0,
  };

  if (style === 'outline') {
    // Border style 1 draws an outline + shadow with no box behind the glyphs.
    return { ...base, borderStyle: 1, outlineWidth: 4, shadow: 2, back: assColour(surface, 1) };
  }
  if (style === 'block') {
    return { ...base, back: assColour(surface, 1), outlineWidth: 16 };
  }
  return base;
}

export function toAss(cues, options = {}) {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const brand = options.brand ?? {};
  const s = assStyle(brand, { style: options.style ?? 'bar', height });
  const alignment = options.position === 'top' ? 8 : 2;
  const marginV = Math.round(height * 0.07);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,' +
      ' BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,' +
      ' BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: PDV,${s.fontName},${s.fontSize},${s.primary},${s.primary},${s.outline},${s.back},` +
      `${s.bold},0,0,0,100,100,0,0,${s.borderStyle},${s.outlineWidth},${s.shadow},` +
      `${alignment},${Math.round(width * 0.08)},${Math.round(width * 0.08)},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text',
  ];

  const events = cues.map(
    (cue) =>
      `Dialogue: 0,${formatAssTime(cue.startSec)},${formatAssTime(cue.endSec)},PDV,,0,0,0,,` +
      cue.lines.map(assEscape).join('\\N'),
  );

  return `${header.concat(events).join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// contrast — exported so qa.mjs can prove legibility rather than assume it
// ---------------------------------------------------------------------------

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function relativeLuminance(hex) {
  const { r, g, b } = parseHex(hex);
  const chan = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Blend `fg` over `bg` at `alpha`, so a translucent caption bar is judged on
 *  what the viewer actually sees rather than on the bar colour alone. */
export function blend(fg, bg, alpha) {
  const f = parseHex(fg);
  const b = parseHex(bg);
  const a = clamp01(alpha);
  const mix = (x, y) => Math.round(x * a + y * (1 - a));
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(mix(f.r, b.r))}${h(mix(f.g, b.g))}${h(mix(f.b, b.b))}`;
}

/**
 * @param {object} args
 * @param {object} args.brand
 * @param {'bar'|'outline'|'block'} [args.style]
 * @param {string} [args.behind] Worst-case colour behind the caption band.
 */
export function checkCaptionContrast({ brand, style = 'bar', behind, minRatio = MIN_CAPTION_CONTRAST } = {}) {
  const colour = brand?.color ?? {};
  const text = colour.text ?? '#ffffff';
  const surface = colour.surface ?? colour.background ?? '#101014';
  const backdrop = behind ?? colour.background ?? surface;

  const effective =
    style === 'bar' ? blend(surface, backdrop, BAR_OPACITY) : style === 'block' ? surface : backdrop;

  const ratio = contrastRatio(text, effective);
  return {
    style,
    foreground: text,
    background: effective,
    ratio: Number(ratio.toFixed(2)),
    minRatio,
    pass: ratio >= minRatio,
  };
}

// ---------------------------------------------------------------------------
// stage entry
// ---------------------------------------------------------------------------

export async function probeDurationSec(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  const n = Number.parseFloat(stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Standalone caption generation. `render.mjs` calls `generateCaptionFiles`
 * directly with the timeline it just computed; this entry point exists so
 * captions can be regenerated on their own after a copy edit.
 */
export async function run(ctx) {
  const storyboardPath = resolve(ctx.cwd, ctx.storyboard ?? 'storyboard.json');
  const storyboard = await readJson(storyboardPath);
  const brand = await loadBrand(storyboardPath, storyboard);

  let cursor = 0;
  const timing = {};
  for (const scene of storyboard.scenes) {
    const wav = resolve(ctx.work, 'vo', `${scene.id}.wav`);
    const speechSec = existsSync(wav) ? await probeDurationSec(wav) : 0;
    const durationSec = (scene.durationMs ?? 0) / 1000 || speechSec + 0.8 || 4;
    timing[scene.id] = { startSec: cursor, durationSec, speechSec: speechSec || durationSec };
    cursor += durationSec;
  }

  const slug = storyboard.meta?.slug ?? 'video';
  const outDir = resolve(ctx.cwd, ctx.out ?? 'out');
  const written = await generateCaptionFiles({
    storyboard,
    brand,
    timing,
    srtPath: resolve(outDir, `${slug}.srt`),
    assPath: resolve(outDir, `${slug}.ass`),
  });
  ctx.log(`captions: ${written.cueCount} cues -> ${written.srtPath}, ${written.assPath}`);
  return written;
}

export async function loadBrand(storyboardPath, storyboard) {
  const rel = storyboard?.meta?.brandPath;
  if (!rel) return {};
  const path = resolve(dirname(storyboardPath), rel);
  if (!existsSync(path)) return {};
  return readJson(path);
}

export async function generateCaptionFiles({ storyboard, brand, timing, srtPath, assPath }) {
  const meta = storyboard.meta ?? {};
  const captions = storyboard.captions ?? {};
  const cues = buildCues(storyboard.scenes ?? [], timing, {
    maxCharsPerLine: captions.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE,
  });

  const srt = toSrt(cues);
  const ass = toAss(cues, {
    brand,
    width: meta.width ?? 1920,
    height: meta.height ?? 1080,
    style: captions.style ?? 'bar',
    position: captions.position ?? 'bottom',
  });

  await mkdir(dirname(srtPath), { recursive: true });
  await mkdir(dirname(assPath), { recursive: true });
  await writeFile(srtPath, srt, 'utf8');
  await writeFile(assPath, ass, 'utf8');

  return { cues, cueCount: cues.length, srtPath, assPath };
}
