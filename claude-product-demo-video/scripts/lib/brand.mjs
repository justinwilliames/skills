/**
 * brand — the intake stage.
 *
 * Collects everything the renderer needs to make output that looks like the
 * product rather than like a template: logos, palette, type, motion rules,
 * voice rules and licensing. Runs once per product, then gets cached and
 * reused by every video after it.
 *
 * The rule this module exists to enforce: an unanswered field falls back to a
 * documented neutral default AND IS REPORTED. The pipeline never quietly
 * invents a brand, because a video that is 80% on-brand is harder to spot as
 * wrong than one that is obviously unstyled.
 *
 *   pdv brand --out brand.json                 interactive
 *   pdv brand --out brand.json --from ./design scan a directory for assets first
 *   pdv brand --out brand.json --yes           accept every default, no prompts
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve, join, relative, basename, extname, dirname } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readJson, writeJson, contrastRatio, isDark } from './util.mjs';
import { validateAgainstSchema, loadSchema } from './storyboard.mjs';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Filename fragments that reliably indicate a logo role. Ordered: first match wins. */
const LOGO_HINTS = [
  { key: 'inverse', patterns: [/white/i, /inverse/i, /reversed?/i, /light[-_]?on/i, /dark[-_]?bg/i] },
  { key: 'mark', patterns: [/favicon/i, /isotype/i, /\bmark\b/i, /icon/i, /symbol/i, /logomark/i, /glyph/i] },
  { key: 'primary', patterns: [/primary/i, /wordmark/i, /lockup/i, /logo/i] },
];

const FONT_EXT = new Set(['.woff2', '.woff', '.ttf', '.otf']);
const IMAGE_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);

/**
 * Walk a directory and sort what is there into logo roles, fonts and imagery.
 * Deliberately shallow-ish — a brand folder five levels deep is a folder of
 * archives, not a brand kit.
 */
export async function scanAssets(dir, { maxDepth = 3 } = {}) {
  const found = { logos: {}, fonts: [], images: [], guidelines: [], all: [] };
  if (!existsSync(dir)) return found;

  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const ext = extname(e.name).toLowerCase();
      found.all.push(full);

      if (FONT_EXT.has(ext)) {
        found.fonts.push(full);
      } else if (IMAGE_EXT.has(ext)) {
        let role = null;
        for (const hint of LOGO_HINTS) {
          if (hint.patterns.some((p) => p.test(e.name))) {
            role = hint.key;
            break;
          }
        }
        // Prefer SVG over raster for the same role — it survives any frame size.
        if (role) {
          const existing = found.logos[role];
          if (!existing || (ext === '.svg' && extname(existing).toLowerCase() !== '.svg')) {
            found.logos[role] = full;
          }
        } else {
          found.images.push(full);
        }
      } else if (/\.(pdf|md|docx?)$/i.test(e.name) && /brand|guideline|identity|style/i.test(e.name)) {
        found.guidelines.push(full);
      }
    }
  }

  await walk(dir, 0);
  return found;
}

/** Pull hex colours out of an SVG so the palette prompt can suggest real values. */
export async function coloursFromSvg(file) {
  if (!file || extname(file).toLowerCase() !== '.svg') return [];
  try {
    const text = await readFile(file, 'utf8');
    const counts = new Map();
    for (const m of text.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const hex = `#${m[1].toLowerCase()}`;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([hex]) => hex)
      .filter((hex) => hex !== '#ffffff' && hex !== '#000000')
      .slice(0, 6);
  } catch {
    return [];
  }
}

class Asker {
  constructor({ interactive, log }) {
    this.interactive = interactive;
    this.log = log;
    this.defaulted = [];
    this.rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  }

  async ask(label, { def = '', hint, required = false, validate } = {}) {
    if (!this.interactive) {
      if (def === '' && required) this.defaulted.push(`${label} (required, left empty)`);
      else if (def !== '') this.defaulted.push(`${label} -> ${def}`);
      return def;
    }
    for (;;) {
      if (hint) this.log(`    ${hint}`);
      const suffix = def ? ` [${def}]` : required ? ' (required)' : ' (optional, enter to skip)';
      const raw = (await this.rl.question(`  ${label}${suffix}: `)).trim();
      const value = raw || def;
      if (!value && required) {
        this.log('    needed — please answer');
        continue;
      }
      if (value && validate) {
        const err = validate(value);
        if (err) {
          this.log(`    ${err}`);
          continue;
        }
      }
      if (!raw && def) this.defaulted.push(`${label} -> ${def}`);
      return value;
    }
  }

  async confirm(label, def = true) {
    if (!this.interactive) return def;
    const raw = (await this.rl.question(`  ${label} [${def ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
    if (!raw) return def;
    return raw.startsWith('y');
  }

  close() {
    this.rl?.close();
  }
}

const hexValidator = (v) => (HEX.test(v) ? null : 'six-digit hex like #2B84B4');
const pathValidator = (base) => (v) => (existsSync(resolve(base, v)) ? null : `no file at ${resolve(base, v)}`);

export async function collect({ interactive, from, outDir, log }) {
  const asker = new Asker({ interactive, log });

  // Keep paths relative when the asset sits under the brand file, so the
  // contract stays portable. Once it escapes upward the relative form is both
  // unreadable and fragile, so fall back to absolute.
  const rel = (p) => {
    if (!p) return '';
    const r = relative(outDir, p);
    return r.startsWith('..') ? p : `./${r}`;
  };

  try {
    const scanned = from ? await scanAssets(resolve(from)) : { logos: {}, fonts: [], images: [], guidelines: [] };
    if (from) {
      log(
        `\nscanned ${resolve(from)}: ` +
          `${Object.keys(scanned.logos).length} logo(s), ${scanned.fonts.length} font file(s), ` +
          `${scanned.images.length} other image(s), ${scanned.guidelines.length} guideline doc(s)`,
      );
      for (const [role, p] of Object.entries(scanned.logos)) log(`  ${role.padEnd(8)} ${basename(p)}`);
    }

    log('\n── identity ──');
    const name = await asker.ask('Product or company name', { required: true, def: interactive ? '' : 'Acme' });
    const tagline = await asker.ask('Tagline');
    const url = await asker.ask('URL shown on the outro', { def: '' });

    log('\n── logos ──');
    log('  SVG preferred. A PNG needs to be at least 1000px on its long edge to survive 1080p.');
    const logo = {};
    const primary = await asker.ask('Primary logo (for light backgrounds)', {
      def: rel(scanned.logos.primary),
      validate: pathValidator(outDir),
    });
    if (primary) logo.primary = primary;
    const inverse = await asker.ask('Reversed logo (for dark backgrounds)', {
      def: rel(scanned.logos.inverse),
      validate: pathValidator(outDir),
    });
    if (inverse) logo.inverse = inverse;
    const mark = await asker.ask('Icon / isotype only', {
      def: rel(scanned.logos.mark),
      validate: pathValidator(outDir),
    });
    if (mark) logo.mark = mark;
    if (!primary && !inverse && !mark) {
      log('  no logo supplied — title and outro cards will use the product name set in the display face');
      asker.defaulted.push('logo -> none (wordmark set as type)');
    }

    log('\n── colours ──');
    const suggestions = await coloursFromSvg(scanned.logos.primary ?? scanned.logos.mark);
    if (suggestions.length) log(`  found in your logo: ${suggestions.join('  ')}`);
    const colorPrimary = await asker.ask('Primary / CTA colour', {
      required: true,
      def: suggestions[0] ?? '#2B6CB0',
      validate: hexValidator,
    });
    const background = await asker.ask('Scene background', { def: '#FFFFFF', validate: hexValidator });
    const text = await asker.ask('Primary text colour', {
      def: isDark(background) ? '#FFFFFF' : '#111827',
      validate: hexValidator,
    });

    const ratio = contrastRatio(text, background);
    if (ratio < 4.5) {
      log(`  warning: text on background is ${ratio.toFixed(2)}:1, below the 4.5:1 floor — captions and body copy will be hard to read`);
      asker.defaulted.push(`contrast warning: text/background ${ratio.toFixed(2)}:1`);
    } else {
      log(`  contrast: ${ratio.toFixed(2)}:1`);
    }

    const color = { primary: colorPrimary, background, text };
    const secondary = await asker.ask('Secondary colour', { def: suggestions[1] ?? '', validate: hexValidator });
    if (secondary) color.secondary = secondary;
    const accent = await asker.ask('Accent colour', { def: suggestions[2] ?? '', validate: hexValidator });
    if (accent) color.accent = accent;
    const surface = await asker.ask('Card / panel fill', { def: isDark(background) ? '#1A1A22' : '#F5F5F4', validate: hexValidator });
    if (surface) color.surface = surface;
    const textMuted = await asker.ask('Muted text colour', { def: isDark(background) ? '#A1A1AA' : '#475569', validate: hexValidator });
    if (textMuted) color.textMuted = textMuted;
    const border = await asker.ask('Border colour', { def: isDark(background) ? '#2A2A35' : '#E5E5E5', validate: hexValidator });
    if (border) color.border = border;

    log('\n── type ──');
    log('  The renderer runs offline: it cannot reach a font CDN. Supply local woff2/ttf/otf paths');
    log('  or the video falls back to a system stack and stops looking like you.');
    if (scanned.fonts.length) {
      log(`  found: ${scanned.fonts.slice(0, 6).map((f) => basename(f)).join(', ')}${scanned.fonts.length > 6 ? ` (+${scanned.fonts.length - 6})` : ''}`);
    }

    const displayFamily = await asker.ask('Display font family (headlines)', { required: true, def: 'Inter' });
    const displayFile = await asker.ask('Display font file', {
      def: rel(scanned.fonts.find((f) => new RegExp(displayFamily.replace(/\s+/g, '[-_ ]?'), 'i').test(basename(f)))),
      validate: pathValidator(outDir),
    });
    const displayLicense = await asker.ask('Display font licence', {
      hint: 'recorded in ATTRIBUTION.md so the video can be cleared for public use',
      def: displayFile ? '' : 'system font',
    });

    const type = {
      display: {
        family: displayFamily,
        weight: 700,
        letterSpacingEm: -0.02,
        ...(displayFile ? { fontFiles: [{ path: displayFile, weight: 700, style: 'normal' }] } : {}),
        ...(displayLicense ? { license: displayLicense } : {}),
      },
    };

    const bodyFamily = await asker.ask('Body font family', { def: displayFamily });
    if (bodyFamily) {
      const bodyFile = await asker.ask('Body font file', {
        def: rel(scanned.fonts.find((f) => new RegExp(bodyFamily.replace(/\s+/g, '[-_ ]?'), 'i').test(basename(f)))),
        validate: pathValidator(outDir),
      });
      type.body = {
        family: bodyFamily,
        weight: 400,
        ...(bodyFile ? { fontFiles: [{ path: bodyFile, weight: 400, style: 'normal' }] } : {}),
        ...(displayLicense && bodyFamily === displayFamily ? { license: displayLicense } : {}),
      };
    }

    log('\n── motion ──');
    const pace = await asker.ask('Pace: calm | standard | brisk', {
      def: 'standard',
      validate: (v) => (['calm', 'standard', 'brisk'].includes(v) ? null : 'one of calm, standard, brisk'),
    });

    log('\n── voice ──');
    const tone = await asker.ask('Voice direction for the narration', {
      hint: 'e.g. "plain-spoken, second person, no hype" — this shapes every sentence written',
      def: 'Plain-spoken and direct. Second person. One idea per sentence. No hype.',
    });
    const bannedRaw = await asker.ask('Words the script must never use', {
      hint: 'comma separated',
      def: 'revolutionary, game-changing, seamless, effortless, supercharge',
    });
    const spellingsRaw = await asker.ask('Forced spellings', {
      hint: 'comma separated pairs like "Acme Co=AcmeCo" — stops TTS mispronouncing odd casing',
      def: '',
    });

    log('\n── assets and legal ──');
    const guidelines = await asker.ask('Brand guidelines doc or brand-kit URL', {
      def: scanned.guidelines[0] ? rel(scanned.guidelines[0]) : '',
    });
    const watermark = await asker.ask('Corner watermark shown for the whole video', {
      def: mark || '',
      validate: pathValidator(outDir),
    });
    const introVideo = await asker.ask('Pre-made intro sting', { validate: pathValidator(outDir) });
    const outroVideo = await asker.ask('Pre-made outro sting', { validate: pathValidator(outDir) });
    const demoNotice = await asker.confirm(
      'Stamp a demo-footage notice when product footage is a reconstruction?',
      true,
    );

    const brand = {
      name,
      ...(tagline ? { tagline } : {}),
      ...(url ? { url } : {}),
      ...(Object.keys(logo).length ? { logo: { ...logo, safeAreaRatio: 0.5, minHeightPx: 48 } } : {}),
      color,
      type,
      shape: { radiusButtonPx: 8, radiusCardPx: 12 },
      motion: {
        pace,
        defaultTransition: 'fade',
        transitionMs: pace === 'brisk' ? 450 : pace === 'calm' ? 800 : 600,
        kenBurnsIntensity: 0.08,
        easing: 'easeInOutCubic',
      },
      voice: {
        tone,
        provider: process.platform === 'darwin' ? 'say' : 'none',
        ...(bannedRaw
          ? { bannedWords: bannedRaw.split(',').map((s) => s.trim()).filter(Boolean) }
          : {}),
        ...(spellingsRaw
          ? {
              spellings: Object.fromEntries(
                spellingsRaw
                  .split(',')
                  .map((pair) => pair.split('=').map((s) => s.trim()))
                  .filter((kv) => kv.length === 2 && kv[0] && kv[1]),
              ),
            }
          : {}),
      },
      ...(guidelines || watermark || introVideo || outroVideo
        ? {
            assets: {
              ...(guidelines ? { guidelinesDoc: guidelines } : {}),
              ...(watermark ? { watermark } : {}),
              ...(introVideo ? { introVideo } : {}),
              ...(outroVideo ? { outroVideo } : {}),
            },
          }
        : {}),
      legal: { demoFootageNotice: demoNotice },
    };

    return { brand, defaulted: asker.defaulted };
  } finally {
    asker.close();
  }
}

export async function run(ctx) {
  const outPath = resolve(ctx.out ?? 'brand.json');
  const outDir = dirname(outPath);

  if (existsSync(outPath) && !ctx.force) {
    throw new Error(`${outPath} already exists — pass --force to overwrite it`);
  }

  const interactive = !ctx.yes && stdin.isTTY;
  if (!interactive && !ctx.yes) {
    ctx.log('brand: not a TTY — running with defaults. Pass --yes to make that explicit.');
  }

  ctx.log('\nBrand intake. Anything skipped falls back to a documented default and is listed at the end.');

  const { brand, defaulted } = await collect({
    interactive,
    from: ctx.from,
    outDir,
    log: (m) => ctx.log(m),
  });

  const schema = await loadSchema('brand.schema.json');
  const { ok, errors } = validateAgainstSchema(schema, brand);
  if (!ok) {
    ctx.log('\nbrand: the collected answers do not satisfy brand.schema.json:');
    for (const e of errors) ctx.log(`  ${e}`);
    throw new Error('brand intake produced an invalid contract');
  }

  await writeJson(outPath, brand);
  ctx.log(`\nbrand: wrote ${outPath} (validates against brand.schema.json)`);

  if (defaulted.length) {
    ctx.log('\nfell back to defaults — review these before rendering anything public:');
    for (const d of defaulted) ctx.log(`  ${d}`);
  }

  return brand;
}
