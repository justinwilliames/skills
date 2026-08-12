#!/usr/bin/env node
/**
 * Renders every scene template at 1920x1080 with Chromium and proves three
 * things about each frame:
 *
 *   1. the PNG is exactly the requested frame size (read back with ffprobe)
 *   2. no page error or failed console message occurred while rendering
 *   3. every piece of on-screen type clears 4.5:1 against the pixels actually
 *      behind it — not against an assumed background
 *
 * (3) is measured, not asserted: the page is re-rendered with the ink hidden
 * but the layout intact, that frame is decoded to raw RGB, and the worst pixel
 * inside each text box is fed to contrastRatio() from util.mjs.
 *
 *   node scripts/lib/__tests__/render-templates.mjs [--out <dir>] [--keep]
 */

import { chromium } from 'playwright';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { contrastRatio, ensureDir, readJson, relativeLuminance, resolveBrandObject, run } from '../util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const SCENES = join(ROOT, 'templates/scenes');
const WIDTH = 1920;
const HEIGHT = 1080;
const MIN_CONTRAST = 4.5;

/* ── a tiny JSON Schema check, enough for the brand contract ─────────────── */

function validate(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;

  if (schema.type && schema.type !== kind) {
    if (!(schema.type === 'integer' && Number.isInteger(value))) {
      if (!(schema.type === 'number' && kind === 'number')) {
        errors.push(`${path}: expected ${schema.type}, got ${kind}`);
        return;
      }
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (kind === 'array' && schema.items) {
    value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors));
  }
  if (kind !== 'object') return;

  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
  }
  for (const [key, child] of Object.entries(value)) {
    const childSchema = schema.properties?.[key];
    if (childSchema) {
      validate(child, childSchema, `${path}.${key}`, errors);
      continue;
    }
    if (schema.additionalProperties === false) {
      errors.push(`${path}: unexpected property "${key}"`);
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      validate(child, schema.additionalProperties, `${path}.${key}`, errors);
    }
  }
}

/* ── pixels ──────────────────────────────────────────────────────────────── */

const SRGB = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function luminanceAt(buf, offset) {
  return 0.2126 * SRGB[buf[offset]] + 0.7152 * SRGB[buf[offset + 1]] + 0.0722 * SRGB[buf[offset + 2]];
}

function hexAt(buf, offset) {
  return `#${[buf[offset], buf[offset + 1], buf[offset + 2]]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Decode a PNG to raw RGB with ffmpeg — the pipeline already requires it. */
async function decodeRgb(pngPath, rawPath) {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', pngPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath]);
  const buf = await readFile(rawPath);
  if (buf.length !== WIDTH * HEIGHT * 3) {
    throw new Error(`${pngPath}: decoded ${buf.length} bytes, expected ${WIDTH * HEIGHT * 3}`);
  }
  return buf;
}

/**
 * Worst-case contrast between an ink colour and every pixel behind its box.
 * Sampled on a 2px lattice; the pixel closest in luminance to the ink is the
 * one that decides the frame, so the minimum is what gets reported.
 */
function worstContrast(buf, fg, rect) {
  const fgL = relativeLuminance(fg);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(WIDTH, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(HEIGHT, Math.ceil(rect.y + rect.height));
  let worstOffset = -1;
  let worstDelta = Infinity;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const offset = (y * WIDTH + x) * 3;
      const delta = Math.abs(luminanceAt(buf, offset) - fgL);
      if (delta < worstDelta) {
        worstDelta = delta;
        worstOffset = offset;
      }
    }
  }
  if (worstOffset < 0) return null;
  const bg = hexAt(buf, worstOffset);
  return { bg, ratio: contrastRatio(fg, bg) };
}

/* ── fixtures ────────────────────────────────────────────────────────────── */

const META = {
  title: 'Same-day payouts',
  subtitle: 'Acme Ops · June release',
  slug: 'same-day-payouts',
  width: WIDTH,
  height: HEIGHT,
  fps: 30,
  brandDir: ROOT,
};

const SCENE_FIXTURES = {
  'title.html': {
    id: 'open',
    type: 'title',
    content: {
      eyebrow: 'June release',
      heading: 'Payouts now settle the same day',
      subheading: 'Every invoice you raise is reconciled the moment the money clears.',
    },
  },
  'feature.html': {
    id: 'dispatch',
    type: 'feature',
    content: {
      eyebrow: 'Scheduling',
      heading: 'Assign a job in two taps',
      body: 'The dispatch board pushes the change to every device on the crew before the van leaves.',
    },
  },
  'stat.html': {
    id: 'proof',
    type: 'stat',
    content: {
      eyebrow: 'Median settlement',
      statValue: '4.2 hrs',
      statLabel: 'from invoice raised to money landed',
      source: 'Measured across 1,284 invoices settled between January and June.',
    },
  },
  'steps.html': {
    id: 'how',
    type: 'steps',
    content: {
      eyebrow: 'How it works',
      heading: 'Three steps from job to paid',
      steps: [
        { title: 'Raise the invoice', body: 'From the job card, with the parts list already attached.' },
        { title: 'Send for approval', body: 'The customer signs on their own phone.' },
        { title: 'Get paid', body: 'Funds land in your account the same working day.' },
      ],
    },
  },
  'quote.html': {
    id: 'voice',
    type: 'quote',
    content: {
      quote: 'We stopped chasing invoices. That is the whole review.',
      attribution: { name: 'Dana Whitfield', role: 'Operations lead, Kestrel Plumbing' },
    },
  },
  'outro.html': {
    id: 'close',
    type: 'outro',
    content: { cta: 'See it on your own jobs' },
  },
  '_frame.html': {
    id: 'chrome',
    type: 'product',
    frame: { url: 'app.acme.example/jobs', title: 'Jobs' },
  },
};

/** A dark counterpart, so the templates are proven on both polarities. */
function darkVariant(brand) {
  const dark = structuredClone(brand);
  dark.name = 'Acme Ops';
  dark.color = {
    ...dark.color,
    primary: '#6d9bff',
    secondary: '#c3d2ff',
    accent: '#3ddc97',
    background: '#0b1020',
    surface: '#141a2e',
    text: '#f4f6fb',
    textMuted: '#a3adc7',
    border: '#2a3350',
    gradient: { from: '#6d9bff', to: '#3ddc97', angleDeg: 135 },
  };
  return dark;
}

/* ── run ─────────────────────────────────────────────────────────────────── */

async function renderOne(browser, { template, scene, brand, tokens, outDir, label }) {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  const problems = [];
  const missing = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => missing.push(req.url()));
  page.on('console', (msg) => {
    // Resource failures are reported through requestfailed, where the URL is
    // known and a missing font can be told apart from a missing logo.
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) {
      problems.push(`console: ${msg.text()}`);
    }
  });

  await page.addInitScript(
    ([b, t, s, m]) => {
      window.__DATA = { brand: b, tokens: t, scene: s, meta: m };
    },
    [brand, tokens, scene, META],
  );

  await page.goto(pathToFileURL(join(SCENES, template)).href, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 15000 });

  const shot = join(outDir, `${label}.png`);
  await page.screenshot({ path: shot });

  const probes = await page.evaluate(() => window.PDV.probeContrast());

  await page.evaluate(() => { document.documentElement.dataset.probe = 'bg'; });
  const backdrop = join(outDir, `${label}.backdrop.png`);
  await page.screenshot({ path: backdrop });
  await page.close();

  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x', shot,
  ]);
  const dims = stdout.trim();

  const raw = join(outDir, `${label}.raw`);
  const buf = await decodeRgb(backdrop, raw);
  await rm(raw, { force: true });

  const measured = probes.map((p) => {
    const worst = worstContrast(buf, p.fg, p.rect);
    return { ...p, measuredBg: worst?.bg ?? null, measuredRatio: worst?.ratio ?? null };
  });

  const declaredFonts = new Set(
    ['display', 'body', 'mono']
      .flatMap((slot) => brand.type?.[slot]?.fontFiles ?? [])
      .map((f) => f.path?.split('/').pop())
      .filter(Boolean),
  );
  const fontFallbacks = [];
  for (const url of missing) {
    const file = decodeURIComponent(url).split('/').pop();
    if (declaredFonts.has(file)) fontFallbacks.push(file);
    else problems.push(`missing resource: ${url}`);
  }

  return { template, label, shot, dims, probes: measured, problems, fontFallbacks };
}

/**
 * The two entry points capture.mjs is documented to use, exercised directly:
 * re-rendering a live page through window.__render, and reading the browser
 * frame's slot geometry.
 */
async function contractChecks(browser, resolved) {
  const failures = [];
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

  await page.goto(pathToFileURL(join(SCENES, 'title.html')).href, { waitUntil: 'load' });
  const ready = await page.evaluate(
    async ([brand, tokens, meta]) => {
      await window.__render({
        brand,
        tokens,
        meta,
        scene: { id: 'late', content: { heading: 'Rendered after load' } },
      });
      return {
        heading: document.querySelector('[data-slot="heading"]').textContent,
        ready: document.documentElement.dataset.ready,
      };
    },
    [resolved.brand, resolved.tokens, META],
  );
  if (ready.heading !== 'Rendered after load' || ready.ready !== 'true') {
    failures.push(`window.__render after load: ${JSON.stringify(ready)}`);
  }

  await page.addInitScript(
    ([brand, tokens, meta]) => {
      window.__DATA = { brand, tokens, meta, scene: { frame: { url: 'app.acme.example/jobs' } } };
    },
    [resolved.brand, resolved.tokens, META],
  );
  await page.goto(pathToFileURL(join(SCENES, '_frame.html')).href, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 15000 });
  const metrics = await page.evaluate(() => window.PDVFrame.metrics());
  if (!(metrics.width > 1500 && metrics.height > 800 && metrics.y > 0)) {
    failures.push(`PDVFrame.metrics(): ${JSON.stringify(metrics)}`);
  }

  await page.close();
  return { failures, metrics };
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : join(ROOT, 'work/template-check'));
  await ensureDir(outDir);

  const schema = await readJson(join(ROOT, 'schemas/brand.schema.json'));
  const rawBrand = await readJson(join(ROOT, 'templates/brand.example.json'));
  const schemaErrors = [];
  validate(rawBrand, schema, 'brand', schemaErrors);

  process.stdout.write(`brand.example.json vs brand.schema.json: ${schemaErrors.length ? 'FAIL' : 'ok'}\n`);
  schemaErrors.forEach((e) => process.stdout.write(`  - ${e}\n`));

  const light = resolveBrandObject(rawBrand, { source: 'templates/brand.example.json' });
  const dark = resolveBrandObject(darkVariant(rawBrand), { source: '(dark variant)' });
  light.warnings.concat(dark.warnings).forEach((w) => process.stdout.write(`brand warning: ${w}\n`));

  const browser = await chromium.launch();
  const results = [];
  let contracts = { failures: [], metrics: null };
  try {
    contracts = await contractChecks(browser, light);
    for (const [name, resolved] of [['light', light], ['dark', dark]]) {
      for (const [template, scene] of Object.entries(SCENE_FIXTURES)) {
        results.push(
          await renderOne(browser, {
            template,
            scene,
            brand: resolved.brand,
            tokens: resolved.tokens,
            outDir,
            label: `${name}-${template.replace(/\.html$/, '').replace(/^_/, '')}`,
          }),
        );
      }
    }
  } finally {
    await browser.close();
  }

  let failures = 0;
  process.stdout.write('\nframe                     size        probes  min contrast  worst element\n');
  process.stdout.write('------------------------- ----------- ------- ------------- --------------------------------\n');

  for (const r of results) {
    const sizeOk = r.dims === `${WIDTH}x${HEIGHT}`;
    const rated = r.probes.filter((p) => p.measuredRatio != null);
    const worst = rated.reduce((a, b) => (a == null || b.measuredRatio < a.measuredRatio ? b : a), null);
    const contrastOk = rated.length > 0 && worst.measuredRatio >= MIN_CONTRAST;
    if (!sizeOk || !contrastOk || r.problems.length) failures += 1;

    process.stdout.write(
      `${r.label.padEnd(25)} ${(r.dims + (sizeOk ? ' ok' : ' BAD')).padEnd(11)} ` +
      `${String(rated.length).padEnd(7)} ${String(worst ? worst.measuredRatio.toFixed(2) : 'n/a').padEnd(13)} ` +
      `${worst ? `${worst.cls || worst.tag} "${worst.text}"` : 'NO TEXT PROBED'}\n`,
    );

    for (const p of rated.filter((x) => x.measuredRatio < MIN_CONTRAST)) {
      process.stdout.write(`    FAIL ${p.role} ${p.fg} on ${p.measuredBg} = ${p.measuredRatio}:1 — "${p.text}"\n`);
    }
    for (const p of rated.filter((x) => x.fallback)) {
      process.stdout.write(`    note: ${p.role} ink fell back to ${p.fg} for legibility — "${p.text}"\n`);
    }
    for (const problem of r.problems) process.stdout.write(`    ${problem}\n`);
  }

  const fellBack = new Set(results.flatMap((r) => r.fontFallbacks));
  if (fellBack.size) {
    process.stdout.write(
      `\nfont files absent, system stack used (the documented offline fallback): ${[...fellBack].join(', ')}\n`,
    );
  }

  process.stdout.write(
    `capture contract: window.__render after load ok, ` +
    `PDVFrame.metrics() = ${JSON.stringify(contracts.metrics)}\n`,
  );
  contracts.failures.forEach((f) => process.stdout.write(`  FAIL ${f}\n`));

  const total = results.reduce((n, r) => n + r.probes.length, 0);
  process.stdout.write(`\n${results.length} frames, ${total} text probes, floor ${MIN_CONTRAST}:1\n`);
  process.stdout.write(`PNGs: ${outDir}\n`);

  failures += contracts.failures.length;
  if (schemaErrors.length) failures += 1;
  process.stdout.write(failures ? `TEMPLATES: FAIL (${failures})\n` : 'TEMPLATES: PASS\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`\n${err?.stack ?? err}\n`);
  process.exit(1);
});
