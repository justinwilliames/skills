/**
 * voice — narration synthesis with graceful provider fallback.
 *
 * Reads:  storyboard.json (audio.voice, scenes[].narration), brand.json (voice.*)
 * Writes: work/vo/<sceneId>.wav       48kHz mono, loudness-normalised
 *         work/vo/durations.json      REAL measured durations from ffprobe
 *
 * Scene durations are derived from these files, so a guessed length would
 * desync the whole render. Nothing here is estimated after synthesis: every
 * number in durations.json comes out of ffprobe.
 *
 * The cache is keyed on CONTENT, not on the file existing: durations.json
 * carries a textHash per scene, and a rewritten narration therefore always
 * re-synthesises. Keying on the filename alone shipped videos whose captions
 * (regenerated from the new text) disagreed with the voice (still the old wav).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';

const run_ = promisify(execFile);

const TARGET_RATE = 48000;
const TARGET_LUFS = -16; // spoken-word target; music sits under it via sidechain
const TARGET_TP = -1.5;
const TARGET_LRA = 11;

const PROVIDER_ENV = {
  elevenlabs: 'ELEVENLABS_API_KEY',
  openai: 'OPENAI_API_KEY',
};

async function sh(cmd, args, { debug = () => {}, allowFail = false } = {}) {
  debug(`$ ${cmd} ${args.join(' ')}`);
  try {
    return await run_(cmd, args, { maxBuffer: 1024 * 1024 * 32 });
  } catch (err) {
    if (allowFail) return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', failed: true };
    const detail = (err.stderr ?? err.message ?? '').toString().trim().split('\n').slice(-6).join('\n');
    throw new Error(`${cmd} failed: ${detail}`);
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasBinary(name) {
  try {
    await run_(name, ['-version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * detectProvider — check the key env var exists rather than trying and crashing.
 * Returns { provider, reason } where reason is non-null when we fell back.
 */
export function detectProvider(requested, { platform = process.platform, env = process.env } = {}) {
  const want = requested ?? 'say';

  if (want === 'none') return { provider: 'none', reason: null };

  if (want === 'elevenlabs' || want === 'openai') {
    const key = PROVIDER_ENV[want];
    if (env[key]) return { provider: want, reason: null };
    const fallback = platform === 'darwin' ? 'say' : 'none';
    return {
      provider: fallback,
      reason: `${want} requested but ${key} is not set — falling back to "${fallback}"`,
    };
  }

  if (want === 'say') {
    if (platform === 'darwin') return { provider: 'say', reason: null };
    return {
      provider: 'none',
      reason: `provider "say" is macOS-only and this is ${platform} — falling back to silent narration ` +
        `(captions still render). Set ELEVENLABS_API_KEY or OPENAI_API_KEY for real speech.`,
    };
  }

  throw new Error(`unknown voice provider "${want}". Use say, elevenlabs, openai or none.`);
}

/**
 * applySpellings — products with odd casing get mispronounced otherwise.
 * Keys are matched whole-word and case-insensitively; values are what the
 * synthesiser actually receives (often a phonetic respelling).
 */
export function applySpellings(text, spellings = {}) {
  let out = text;
  for (const [from, to] of Object.entries(spellings)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = /^[\w]/.test(from) && /[\w]$/.test(from) ? '\\b' : '';
    out = out.replace(new RegExp(`${boundary}${escaped}${boundary}`, 'gi'), to);
  }
  return out;
}

/** Fail loudly — a banned word in narration is a copy bug, not a warning. */
export function assertNoBannedWords(scenes, bannedWords = []) {
  if (!bannedWords.length) return;
  const hits = [];
  for (const scene of scenes) {
    const text = scene.narration ?? '';
    for (const word of bannedWords) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
        hits.push(`scene "${scene.id}" uses banned word "${word}"`);
      }
    }
  }
  if (hits.length) {
    throw new Error(`narration violates brand.voice.bannedWords:\n  - ${hits.join('\n  - ')}`);
  }
}

/** Real duration, always from ffprobe. Never derived from text length. */
export async function probeDuration(path, opts = {}) {
  const { stdout } = await sh(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
    opts,
  );
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe returned no duration for ${path}`);
  return seconds;
}

/**
 * voiceCacheKey — everything that changes the bytes of the wav.
 * Text is the post-spellings string, because that is what the synthesiser hears.
 */
export function voiceCacheKey({ text, provider, voiceId = null, rateWpm = null, gainDb = 0 }) {
  return createHash('sha256')
    .update(JSON.stringify([text, provider, voiceId, rateWpm, gainDb]))
    .digest('hex');
}

function estimateSpeechSeconds(text, rateWpm = 165) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.2, (words / rateWpm) * 60 + 0.6);
}

async function synthSay(text, dest, { voiceId, rateWpm, debug }) {
  const aiff = `${dest}.aiff`;
  const args = [];
  if (voiceId) args.push('-v', voiceId);
  if (rateWpm) args.push('-r', String(rateWpm));
  args.push('-o', aiff, text);
  await sh('say', args, { debug });
  return aiff;
}

async function synthElevenLabs(text, dest, { voiceId, debug }) {
  const id = voiceId ?? '21m00Tcm4TlvDq8ikWAM';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env[PROVIDER_ENV.elevenlabs],
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
  });
  if (!res.ok) {
    throw new Error(`elevenlabs TTS failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const raw = `${dest}.mp3`;
  await writeFile(raw, Buffer.from(await res.arrayBuffer()));
  debug(`elevenlabs wrote ${raw}`);
  return raw;
}

async function synthOpenAI(text, dest, { voiceId, debug }) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env[PROVIDER_ENV.openai]}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: voiceId ?? 'alloy',
      input: text,
      response_format: 'wav',
    }),
  });
  if (!res.ok) {
    throw new Error(`openai TTS failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const raw = `${dest}.raw.wav`;
  await writeFile(raw, Buffer.from(await res.arrayBuffer()));
  debug(`openai wrote ${raw}`);
  return raw;
}

async function synthSilence(text, dest, { rateWpm, debug }) {
  const seconds = estimateSpeechSeconds(text, rateWpm);
  const raw = `${dest}.raw.wav`;
  await sh(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', `anullsrc=r=${TARGET_RATE}:cl=mono`, '-t', seconds.toFixed(3), raw],
    { debug },
  );
  return raw;
}

function parseLoudnormJson(stderr) {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(stderr.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * normaliseTo48kMono — two-pass EBU R128 so one loud scene cannot wreck the mix.
 * Pass one measures, pass two applies the measurement; a linear correction keeps
 * the clip's own dynamics intact. Falls back to single-pass if measurement fails
 * (very short clips can defeat the measurement).
 */
export async function normaliseTo48kMono(src, dest, { gainDb = 0, debug = () => {}, silent = false } = {}) {
  const gain = gainDb ? `,volume=${gainDb}dB` : '';

  if (silent) {
    // Normalising digital silence produces noise; just conform the format.
    await sh('ffmpeg', ['-y', '-i', src, '-ar', String(TARGET_RATE), '-ac', '1', '-c:a', 'pcm_s16le', dest], { debug });
    return dest;
  }

  const base = `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`;
  const pass1 = await sh(
    'ffmpeg',
    ['-y', '-i', src, '-af', `${base}:print_format=json`, '-f', 'null', '-'],
    { debug, allowFail: true },
  );
  const m = parseLoudnormJson(pass1.stderr ?? '');

  const filter = m
    ? `${base}:measured_I=${m.input_i}:measured_LRA=${m.input_lra}:measured_TP=${m.input_tp}` +
      `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary${gain}`
    : `${base}${gain}`;

  if (!m) debug('loudnorm measurement unavailable — using single-pass dynamic normalisation');

  await sh(
    'ffmpeg',
    ['-y', '-i', src, '-af', filter, '-ar', String(TARGET_RATE), '-ac', '1', '-c:a', 'pcm_s16le', dest],
    { debug },
  );
  return dest;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function run(ctx) {
  const log = ctx.log ?? (() => {});
  const debug = ctx.debug ?? (() => {});

  if (!ctx.storyboard) throw new Error('voice: --storyboard <path> is required');
  const storyboardPath = resolve(ctx.cwd ?? process.cwd(), ctx.storyboard);
  const storyboard = await readJson(storyboardPath);

  const brandPath = storyboard?.meta?.brandPath
    ? resolve(dirname(storyboardPath), storyboard.meta.brandPath)
    : ctx.brand
      ? resolve(ctx.cwd ?? process.cwd(), ctx.brand)
      : null;
  const brand = brandPath && (await exists(brandPath)) ? await readJson(brandPath) : {};

  if (!(await hasBinary('ffprobe'))) {
    throw new Error('voice: ffprobe not found on PATH — scene durations cannot be measured. Install ffmpeg.');
  }

  const cfg = storyboard?.audio?.voice ?? {};
  const requested = cfg.provider ?? brand?.voice?.provider ?? 'say';
  const { provider, reason } = detectProvider(requested);
  if (reason) log(`voice: ${reason}`);
  log(`voice: provider "${provider}"`);

  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  assertNoBannedWords(scenes, brand?.voice?.bannedWords ?? []);

  const spellings = brand?.voice?.spellings ?? {};
  const voiceId = cfg.voiceId ?? brand?.voice?.voiceId ?? null;
  const rateWpm = cfg.rateWpm ?? 165;
  const gainDb = cfg.gainDb ?? 0;

  const voDir = resolve(ctx.work ?? resolve(process.cwd(), 'work'), 'vo');
  await mkdir(voDir, { recursive: true });

  // The previous run's durations.json is the cache sidecar: it carries the
  // textHash each wav was synthesised from. No sidecar, or an older one written
  // before hashing existed, means every scene re-synthesises — the safe way round.
  const durationsPath = resolve(voDir, 'durations.json');
  let previousScenes = {};
  if (await exists(durationsPath)) {
    try {
      previousScenes = (await readJson(durationsPath))?.scenes ?? {};
    } catch {
      debug('voice: previous durations.json is unreadable — treating every scene as a cache miss');
    }
  }

  const durations = {
    generatedAt: new Date().toISOString(),
    provider,
    requestedProvider: requested,
    sampleRate: TARGET_RATE,
    channels: 1,
    targetLufs: TARGET_LUFS,
    storyboard: storyboardPath,
    scenes: {},
  };

  for (const scene of scenes) {
    const narration = (scene.narration ?? '').trim();
    if (!narration) {
      durations.scenes[scene.id] = { file: null, seconds: 0, spoken: false, silent: true };
      debug(`voice: ${scene.id} has no narration`);
      continue;
    }

    const dest = resolve(voDir, `${scene.id}.wav`);
    const spoken = applySpellings(narration, spellings);
    if (spoken !== narration) debug(`voice: ${scene.id} spellings applied -> ${spoken}`);
    const textHash = voiceCacheKey({ text: spoken, provider, voiceId, rateWpm, gainDb });

    const prior = previousScenes[scene.id];
    const onDisk = await exists(dest);
    if (!ctx.force && onDisk && prior?.textHash === textHash) {
      const seconds = await probeDuration(dest, { debug });
      durations.scenes[scene.id] = {
        file: dest,
        seconds: Number(seconds.toFixed(3)),
        spoken: provider !== 'none',
        silent: provider === 'none',
        textHash,
        cached: true,
      };
      log(`voice: ${scene.id} cached (${seconds.toFixed(2)}s)`);
      continue;
    }
    if (!ctx.force && onDisk) {
      log(
        `voice: ${scene.id} narration or voice settings changed since the cached take — re-synthesising`,
      );
    }

    let raw;
    if (provider === 'say') raw = await synthSay(spoken, dest, { voiceId, rateWpm, debug });
    else if (provider === 'elevenlabs') raw = await synthElevenLabs(spoken, dest, { voiceId, debug });
    else if (provider === 'openai') raw = await synthOpenAI(spoken, dest, { voiceId, debug });
    else raw = await synthSilence(spoken, dest, { rateWpm, debug });

    await normaliseTo48kMono(raw, dest, { gainDb, debug, silent: provider === 'none' });
    await rm(raw, { force: true });

    const seconds = await probeDuration(dest, { debug });
    durations.scenes[scene.id] = {
      file: dest,
      seconds: Number(seconds.toFixed(3)),
      spoken: provider !== 'none',
      silent: provider === 'none',
      textHash,
      cached: false,
    };
    log(`voice: ${scene.id} -> ${dest} (${seconds.toFixed(2)}s)`);
  }

  durations.totalSeconds = Number(
    Object.values(durations.scenes).reduce((a, s) => a + s.seconds, 0).toFixed(3),
  );

  await writeFile(durationsPath, `${JSON.stringify(durations, null, 2)}\n`, 'utf8');
  log(`voice: durations ${durationsPath} (total ${durations.totalSeconds}s)`);

  return { durationsPath, durations };
}
