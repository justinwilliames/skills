#!/usr/bin/env node
/**
 * pdv — product demo video pipeline.
 *
 * Every stage reads files and writes files. Nothing is held in memory between
 * stages, so any stage can be re-run on its own after a failure or an edit.
 *
 *   pdv doctor                          check the toolchain
 *   pdv brand      --out brand.json     interactive brand intake
 *   pdv discover   --repo owner/name --feature "scheduled exports" --out brief.json
 *   pdv storyboard --brief brief.json --brand brand.json --out storyboard.json
 *   pdv demo       --storyboard s.json  build the local HTML demo apps
 *   pdv capture    --storyboard s.json  record scenes with Chrome
 *   pdv voice      --storyboard s.json  synthesise narration
 *   pdv music      --storyboard s.json  fetch the licensed track
 *   pdv render     --storyboard s.json  assemble the mp4
 *   pdv qa         --video out/x.mp4 --storyboard s.json
 *   pdv build      --storyboard s.json  every stage, in order, skipping fresh output
 */

import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STAGES = {
  doctor: () => import('./lib/doctor.mjs'),
  brand: () => import('./lib/brand.mjs'),
  discover: () => import('./lib/discover.mjs'),
  storyboard: () => import('./lib/storyboard.mjs'),
  demo: () => import('./lib/demo.mjs'),
  capture: () => import('./lib/capture.mjs'),
  voice: () => import('./lib/voice.mjs'),
  music: () => import('./lib/music.mjs'),
  render: () => import('./lib/render.mjs'),
  qa: () => import('./lib/qa.mjs'),
};

const BUILD_ORDER = ['demo', 'capture', 'voice', 'music', 'render', 'qa'];

const OPTIONS = {
  repo: { type: 'string' },
  ref: { type: 'string' },
  range: { type: 'string' },
  feature: { type: 'string' },
  local: { type: 'string' },
  brief: { type: 'string' },
  brand: { type: 'string' },
  storyboard: { type: 'string' },
  video: { type: 'string' },
  out: { type: 'string' },
  work: { type: 'string' },
  from: { type: 'string' },
  force: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  install: { type: 'boolean', default: false },
  verbose: { type: 'boolean', short: 'v', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

/**
 * Stages that touch the video toolchain. `discover`, `brand` and `storyboard`
 * are text-only and run on a bare Node install, so they skip the preflight.
 */
const NEEDS_TOOLCHAIN = new Set(['demo', 'capture', 'voice', 'music', 'render', 'qa', 'build']);

function have(bin) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
    stdio: 'ignore',
  }).status === 0;
}

/**
 * Refuse to start a stage that will fail three minutes in for a missing binary.
 * With --install we provision automatically; otherwise we name the one command
 * that fixes it.
 */
function preflight(stage, ctx) {
  if (!NEEDS_TOOLCHAIN.has(stage)) return;

  const missing = [];
  if (!have('ffmpeg')) missing.push('ffmpeg');
  if (!have('ffprobe')) missing.push('ffprobe');
  if (!existsSync(join(SKILL_DIR, 'node_modules', 'playwright'))) missing.push('playwright');

  if (missing.length === 0) return;

  const installer = join(SKILL_DIR, 'scripts', 'install.sh');

  if (ctx.install) {
    ctx.log(`missing: ${missing.join(', ')} — provisioning`);
    const r = spawnSync('bash', [installer, '--yes'], { stdio: 'inherit' });
    if (r.status !== 0) {
      throw new Error('provisioning failed — see the output above');
    }
    return;
  }

  throw new Error(
    `missing required tooling: ${missing.join(', ')}\n\n` +
      `  install it:  bash ${installer}\n` +
      `  or re-run this command with --install to provision automatically\n`,
  );
}

function usage() {
  process.stdout.write(
    `pdv — product demo video pipeline\n\n` +
      `Usage: pdv <stage> [options]\n\n` +
      `Stages: ${Object.keys(STAGES).join(', ')}, build\n\n` +
      `Common options:\n` +
      `  --repo owner/name     GitHub repository to read (primary source)\n` +
      `  --local <path>        optional local checkout, used when present and current\n` +
      `  --feature <text>      what to announce\n` +
      `  --brand <path>        brand.json\n` +
      `  --storyboard <path>   storyboard.json\n` +
      `  --out <path>          stage output\n` +
      `  --work <dir>          scratch dir (default ./work)\n` +
      `  --force               re-run even when output looks fresh\n` +
      `  --yes                 accept intake defaults without prompting\n` +
      `  --install             provision missing tooling automatically\n` +
      `  -v, --verbose         log every external command\n`,
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
  });

  const stage = positionals[0];

  if (!stage || values.help) {
    usage();
    process.exit(stage ? 0 : 1);
  }

  const ctx = {
    ...values,
    work: resolve(values.work ?? 'work'),
    cwd: process.cwd(),
    log: (...a) => process.stderr.write(`${a.join(' ')}\n`),
    debug: (...a) => values.verbose && process.stderr.write(`  ${a.join(' ')}\n`),
  };

  preflight(stage, ctx);

  if (stage === 'build') {
    for (const name of BUILD_ORDER) {
      ctx.log(`\n── ${name} ──`);
      const mod = await STAGES[name]();
      await mod.run(ctx);
    }
    return;
  }

  const loader = STAGES[stage];
  if (!loader) {
    process.stderr.write(`unknown stage: ${stage}\n\n`);
    usage();
    process.exit(1);
  }

  const mod = await loader();
  await mod.run(ctx);
}

main().catch((err) => {
  process.stderr.write(`\n${err?.stack ?? err}\n`);
  process.exit(1);
});
