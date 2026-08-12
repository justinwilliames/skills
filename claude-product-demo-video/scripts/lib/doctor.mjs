/**
 * Toolchain gate. Hard requirements fail the process; soft ones warn, because
 * they are only needed by one stage each (gh -> discover, TTS -> voice).
 */

import process from 'node:process';
import { run as exec, which, exists } from './util.mjs';

const HARD = 'hard';
const SOFT = 'soft';

function firstLine(text) {
  return String(text).trim().split('\n')[0] ?? '';
}

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    name: 'node',
    level: HARD,
    ok: major >= 20,
    detail: `v${process.versions.node}`,
    fix: 'install Node 20 or newer',
  };
}

async function checkFfTool(cmd) {
  const path = await which(cmd);
  if (!path) {
    return {
      name: cmd,
      level: HARD,
      ok: false,
      detail: 'not on PATH',
      fix: 'brew install ffmpeg (macOS) or apt install ffmpeg',
    };
  }
  const { stdout } = await exec(cmd, ['-version'], { allowFail: true });
  return {
    name: cmd,
    level: HARD,
    ok: true,
    detail: firstLine(stdout).replace(/ Copyright.*$/, ''),
  };
}

async function checkChromium() {
  let executablePath;
  try {
    const { chromium } = await import('playwright');
    executablePath = chromium.executablePath();
  } catch (err) {
    return {
      name: 'chromium',
      level: HARD,
      ok: false,
      detail: `playwright not importable: ${err.message}`,
      fix: 'npm install && npx playwright install chromium',
    };
  }
  const present = await exists(executablePath);
  return {
    name: 'chromium',
    level: HARD,
    ok: present,
    detail: present ? executablePath : `missing at ${executablePath}`,
    fix: 'npx playwright install chromium',
  };
}

async function checkGh() {
  const path = await which('gh');
  if (!path) {
    return {
      name: 'gh',
      level: SOFT,
      ok: false,
      detail: 'not on PATH — discover cannot read GitHub',
      fix: 'brew install gh && gh auth login',
    };
  }
  const { code, stdout, stderr } = await exec('gh', ['auth', 'status'], { allowFail: true });
  const authed = code === 0;
  const account = /Logged in to \S+ account (\S+)/.exec(`${stdout}\n${stderr}`)?.[1];
  return {
    name: 'gh',
    level: SOFT,
    ok: authed,
    detail: authed ? `authenticated${account ? ` as ${account}` : ''}` : 'present but not authenticated',
    fix: 'gh auth login',
  };
}

async function checkTts() {
  const providers = [];
  if (process.platform === 'darwin' && (await which('say'))) providers.push('say');
  if (process.env.ELEVENLABS_API_KEY) providers.push('elevenlabs');
  if (process.env.OPENAI_API_KEY) providers.push('openai');
  return {
    name: 'tts',
    level: SOFT,
    ok: providers.length > 0,
    detail: providers.length ? providers.join(', ') : 'no provider — voice stage will produce silence',
    fix: 'use macOS `say`, or set ELEVENLABS_API_KEY / OPENAI_API_KEY',
  };
}

/** Run every check and return the raw rows. No printing, no exit. */
export async function probe() {
  return Promise.all([
    checkNode(),
    checkFfTool('ffmpeg'),
    checkFfTool('ffprobe'),
    checkChromium(),
    checkGh(),
    checkTts(),
  ]);
}

export function formatTable(rows) {
  const header = ['', 'check', 'level', 'detail'];
  const body = rows.map((r) => [r.ok ? 'ok' : r.level === HARD ? 'FAIL' : 'warn', r.name, r.level, r.detail]);
  const all = [header, ...body];
  const widths = header.map((_, i) => Math.max(...all.map((row) => String(row[i]).length)));
  const line = (row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

export async function run(ctx = {}) {
  const rows = await probe();
  const out = ctx.log ?? ((...a) => process.stderr.write(`${a.join(' ')}\n`));
  out(formatTable(rows));

  const failed = rows.filter((r) => !r.ok && r.level === HARD);
  const warned = rows.filter((r) => !r.ok && r.level === SOFT);

  for (const r of warned) out(`warn: ${r.name} — ${r.detail}. ${r.fix}`);
  for (const r of failed) out(`FAIL: ${r.name} — ${r.detail}. ${r.fix}`);

  if (failed.length) {
    out(`\nDOCTOR: FAIL (${failed.length} hard requirement${failed.length === 1 ? '' : 's'} missing)`);
    process.exit(1);
  }
  out(`\nDOCTOR: PASS${warned.length ? ` (${warned.length} warning${warned.length === 1 ? '' : 's'})` : ''}`);
  return rows;
}
