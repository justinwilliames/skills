/**
 * Shared helpers. No stage lives here — only things two or more stages need.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path}: invalid JSON — ${err.message}`);
  }
}

export async function writeJson(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

export async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a command, stream it, and reject with the real stderr on a non-zero
 * exit. Every external tool in this pipeline goes through here so a failure
 * surfaces the tool's own message rather than "command failed".
 */
export function run(cmd, args = [], opts = {}) {
  const { cwd, env, stream = false, input, allowFail = false } = opts;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stream) process.stderr.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stream) process.stderr.write(d);
    });
    child.on('error', (err) =>
      rejectPromise(new Error(`${cmd}: ${err.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0 || allowFail) {
        resolvePromise({ code, stdout, stderr });
        return;
      }
      const detail = (stderr.trim() || stdout.trim() || '(no output)').split('\n').slice(-20).join('\n');
      rejectPromise(
        new Error(`${cmd} ${args.join(' ')} exited ${code}\n${detail}`),
      );
    });
    if (input != null) {
      child.stdin.end(input);
    }
  });
}

/** Absolute path of an executable on PATH, or null. */
export async function which(cmd) {
  if (isAbsolute(cmd)) return (await exists(cmd)) ? cmd : null;
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'untitled';
}

export function msToTimecode(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(milli, 3)}`;
}

export const easing = {
  linear: (t) => t,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  easeOutQuint: (t) => 1 - (1 - t) ** 5,
};

export function ease(name, t) {
  const fn = easing[name] ?? easing.easeInOutCubic;
  return fn(Math.min(1, Math.max(0, t)));
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`;
}

export function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function mixHex(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

export function isDark(hex) {
  return relativeLuminance(hex) < 0.4;
}

const SYSTEM_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const SYSTEM_MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

/**
 * Documented defaults for every optional brand field.
 * Anything derived (rather than fixed) is derived from a REQUIRED field, so a
 * three-colour brand.json still produces a complete token set.
 */
export const BRAND_DEFAULTS = {
  'color.secondary': 'color.primary',
  'color.accent': 'color.primary',
  'color.surface': 'background nudged 4% toward the text colour',
  'color.textMuted': 'text mixed 42% into background',
  'color.border': 'text mixed 86% into background',
  'color.gradient.from': 'color.primary',
  'color.gradient.to': 'color.accent',
  'color.gradient.angleDeg': 135,
  'type.display.fallbackStack': SYSTEM_SANS,
  'type.display.weight': 700,
  'type.display.letterSpacingEm': -0.02,
  'type.body.family': 'type.display.family',
  'type.body.fallbackStack': SYSTEM_SANS,
  'type.body.weight': 400,
  'type.mono.family': SYSTEM_MONO,
  'shape.radiusButtonPx': 8,
  'shape.radiusCardPx': 12,
  'shape.shadow': '0 24px 64px rgba(0,0,0,0.18)',
  'motion.pace': 'standard',
  'motion.defaultTransition': 'fade',
  'motion.transitionMs': 600,
  'motion.kenBurnsIntensity': 0.08,
  'motion.easing': 'easeInOutCubic',
  'logo.safeAreaRatio': 0.5,
  'logo.minHeightPx': 48,
  'voice.provider': 'say',
  'legal.demoFootageNotice': true,
};

function fontFamilyCss(family, fallback) {
  const quoted = /[^a-zA-Z0-9-]/.test(family) ? `'${family}'` : family;
  return `${quoted}, ${fallback}`;
}

/**
 * Fill in every optional brand field and flatten to render tokens.
 * Accepts an already-parsed brand object; `resolveBrand` is the path form.
 */
export function resolveBrandObject(input, { source = '(inline)' } = {}) {
  const brand = structuredClone(input ?? {});
  const warnings = [];
  const applied = [];

  const missing = [];
  if (!brand.name) missing.push('name');
  if (!brand.color?.primary) missing.push('color.primary');
  if (!brand.color?.background) missing.push('color.background');
  if (!brand.color?.text) missing.push('color.text');
  if (!brand.type?.display?.family) missing.push('type.display.family');
  if (missing.length) {
    throw new Error(`${source}: brand is missing required fields: ${missing.join(', ')}`);
  }

  const c = brand.color;
  const def = (obj, key, value, note) => {
    if (obj[key] == null) {
      obj[key] = value;
      applied.push(note);
    }
  };

  def(c, 'secondary', c.primary, 'color.secondary = color.primary');
  def(c, 'accent', c.secondary, 'color.accent = color.secondary');
  def(c, 'surface', mixHex(c.background, c.text, 0.04), 'color.surface derived from background');
  def(c, 'textMuted', mixHex(c.text, c.background, 0.42), 'color.textMuted derived from text');
  def(c, 'border', mixHex(c.text, c.background, 0.86), 'color.border derived from text');
  c.gradient = c.gradient ?? {};
  def(c.gradient, 'from', c.primary, 'color.gradient.from = color.primary');
  def(c.gradient, 'to', c.accent, 'color.gradient.to = color.accent');
  def(c.gradient, 'angleDeg', 135, 'color.gradient.angleDeg = 135');

  const t = brand.type;
  def(t.display, 'fallbackStack', SYSTEM_SANS, 'type.display.fallbackStack = system sans');
  def(t.display, 'weight', 700, 'type.display.weight = 700');
  def(t.display, 'letterSpacingEm', -0.02, 'type.display.letterSpacingEm = -0.02');
  def(t.display, 'fontFiles', [], 'type.display.fontFiles = []');
  t.body = t.body ?? {};
  def(t.body, 'family', t.display.family, 'type.body.family = type.display.family');
  def(t.body, 'fallbackStack', SYSTEM_SANS, 'type.body.fallbackStack = system sans');
  def(t.body, 'weight', 400, 'type.body.weight = 400');
  def(t.body, 'fontFiles', [], 'type.body.fontFiles = []');
  t.mono = t.mono ?? {};
  def(t.mono, 'family', SYSTEM_MONO, 'type.mono.family = system mono');
  def(t.mono, 'fallbackStack', SYSTEM_MONO, 'type.mono.fallbackStack = system mono');

  brand.shape = brand.shape ?? {};
  def(brand.shape, 'radiusButtonPx', 8, 'shape.radiusButtonPx = 8');
  def(brand.shape, 'radiusCardPx', 12, 'shape.radiusCardPx = 12');
  def(brand.shape, 'shadow', BRAND_DEFAULTS['shape.shadow'], 'shape.shadow = house default');

  brand.motion = brand.motion ?? {};
  def(brand.motion, 'pace', 'standard', 'motion.pace = standard');
  def(brand.motion, 'defaultTransition', 'fade', 'motion.defaultTransition = fade');
  def(brand.motion, 'transitionMs', 600, 'motion.transitionMs = 600');
  def(brand.motion, 'kenBurnsIntensity', 0.08, 'motion.kenBurnsIntensity = 0.08');
  def(brand.motion, 'easing', 'easeInOutCubic', 'motion.easing = easeInOutCubic');

  brand.logo = brand.logo ?? {};
  def(brand.logo, 'safeAreaRatio', 0.5, 'logo.safeAreaRatio = 0.5');
  def(brand.logo, 'minHeightPx', 48, 'logo.minHeightPx = 48');

  brand.voice = brand.voice ?? {};
  def(brand.voice, 'provider', 'say', 'voice.provider = say');
  def(brand.voice, 'bannedWords', [], 'voice.bannedWords = []');
  def(brand.voice, 'spellings', {}, 'voice.spellings = {}');

  brand.legal = brand.legal ?? {};
  def(brand.legal, 'demoFootageNotice', true, 'legal.demoFootageNotice = true');

  const bodyContrast = contrastRatio(c.text, c.background);
  if (bodyContrast < 4.5) {
    warnings.push(
      `color.text on color.background is ${bodyContrast}:1 — below the 4.5:1 the QA gate expects`,
    );
  }
  const mutedContrast = contrastRatio(c.textMuted, c.background);
  if (mutedContrast < 3) {
    warnings.push(`color.textMuted on background is ${mutedContrast}:1 — below 3:1`);
  }

  const dark = isDark(c.background);
  const onPrimary = contrastRatio('#ffffff', c.primary) >= contrastRatio('#000000', c.primary)
    ? '#ffffff'
    : '#000000';

  const tokens = {
    'brand-name': brand.name,
    'color-primary': c.primary,
    'color-on-primary': onPrimary,
    'color-secondary': c.secondary,
    'color-accent': c.accent,
    'color-background': c.background,
    'color-surface': c.surface,
    'color-surface-alt': mixHex(c.surface, c.text, 0.04),
    'color-text': c.text,
    'color-text-muted': c.textMuted,
    'color-border': c.border,
    'color-success': c.accent,
    'color-warning': dark ? '#f5b544' : '#b7791f',
    'color-danger': dark ? '#f77066' : '#b42318',
    'color-gradient-from': c.gradient.from,
    'color-gradient-to': c.gradient.to,
    'color-gradient-angle': `${c.gradient.angleDeg}deg`,
    'font-display': fontFamilyCss(t.display.family, t.display.fallbackStack),
    'font-body': fontFamilyCss(t.body.family, t.body.fallbackStack),
    'font-mono': fontFamilyCss(t.mono.family, t.mono.fallbackStack),
    'weight-display': String(t.display.weight),
    'weight-body': String(t.body.weight),
    'tracking-display': `${t.display.letterSpacingEm}em`,
    'radius-button': `${brand.shape.radiusButtonPx}px`,
    'radius-card': `${brand.shape.radiusCardPx}px`,
    'shadow-card': brand.shape.shadow,
    'motion-transition-ms': `${brand.motion.transitionMs}ms`,
    'motion-easing': brand.motion.easing,
    'scheme': dark ? 'dark' : 'light',
  };

  const cssVars = (prefix = 'pdv', indent = '  ') =>
    Object.entries(tokens)
      .map(([k, v]) => `${indent}--${prefix}-${k}: ${v};`)
      .join('\n');

  return { brand, tokens, cssVars, warnings, applied, source };
}

/** Load brand.json from disk and resolve it. */
export async function resolveBrand(brandPath, { cwd = process.cwd() } = {}) {
  const path = isAbsolute(brandPath) ? brandPath : resolve(cwd, brandPath);
  const raw = await readJson(path);
  return resolveBrandObject(raw, { source: path });
}
