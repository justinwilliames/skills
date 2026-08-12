/**
 * music — pick one licensed track, fetch it, and write the attribution file.
 *
 * Reads:  storyboard.json (audio.music), brand.json (motion.pace), CATALOGUE.json
 * Writes: work/music/<id>.<ext>
 *         work/music/music-manifest.json   (what render.mjs reads)
 *         <out>/ATTRIBUTION.md             (what qa.mjs gates on)
 *
 * No audio binary is committed to this repository. Everything is fetched at
 * build time from the URLs in assets/music/CATALOGUE.json.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile, copyFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const DEFAULT_CATALOGUE = resolve(REPO_ROOT, 'assets/music/CATALOGUE.json');

const MOODS = ['uplifting', 'calm', 'focused', 'energetic', 'cinematic'];

const FETCH_UA = 'pdv-music-fetch/1.0 (product demo video skill; +https://github.com/justinwilliames/skills)';

/** brand.motion.pace is the fallback when a storyboard names no mood. */
const PACE_MOOD = { calm: 'calm', standard: 'focused', brisk: 'energetic' };

// pdv.mjs parses with strict:false, so an unknown `--flag value` lands its value
// in positionals rather than values. Read our own flags off argv to accept both
// `--music-file x` and `--music-file=x`.
export function readFlag(ctx, name, envVar) {
  const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (const key of [name, camel]) {
    const v = ctx?.[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  if (envVar && process.env[envVar]) return process.env[envVar];
  return null;
}

export function readBoolFlag(ctx, name) {
  const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (ctx?.[name] === true || ctx?.[camel] === true) return true;
  return process.argv.slice(2).includes(`--${name}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadCatalogue(path = DEFAULT_CATALOGUE) {
  const cat = await readJson(path);
  if (!Array.isArray(cat.tracks) || cat.tracks.length === 0) {
    throw new Error(`music catalogue at ${path} has no tracks`);
  }
  return cat;
}

/** Deterministic per-video pick: the same slug always gets the same track. */
function pickStable(candidates, seed) {
  const h = createHash('sha256').update(seed).digest();
  return candidates[h.readUInt32BE(0) % candidates.length];
}

/**
 * selectTrack — trackId wins, then mood, then brand pace.
 * Returns null when music is switched off (mood 'none').
 *
 * Within a mood, CC0 / public-domain tracks (attributionRequired === false) are
 * preferred: MUSIC-LICENSING.md calls CC0 the safest default for anything
 * customer-facing, so an unpinned pick should not hand someone a CC-BY
 * obligation they never asked for. Pin `audio.music.trackId` to override.
 */
export function selectTrack(storyboard, catalogue, brand = {}) {
  const music = storyboard?.audio?.music ?? {};
  if (music.mood === 'none') return null;

  if (music.trackId) {
    const hit = catalogue.tracks.find((t) => t.id === music.trackId);
    if (!hit) {
      const ids = catalogue.tracks.map((t) => t.id).join(', ');
      throw new Error(`audio.music.trackId "${music.trackId}" is not in the catalogue. Known ids: ${ids}`);
    }
    return hit;
  }

  const mood = music.mood ?? PACE_MOOD[brand?.motion?.pace ?? 'standard'] ?? 'focused';
  if (!MOODS.includes(mood)) {
    throw new Error(`unknown mood "${mood}". Catalogue moods: ${MOODS.join(', ')}`);
  }

  const candidates = catalogue.tracks.filter((t) => t.mood === mood);
  if (candidates.length === 0) {
    throw new Error(`no catalogue track has mood "${mood}"`);
  }

  const cc0 = candidates.filter((t) => t.attributionRequired === false);
  const pool = cc0.length > 0 ? cc0 : candidates;

  // A video shorter than the track never needs a loop; only filter on loopable
  // when we know the track has to be repeated.
  const seed = storyboard?.meta?.slug ?? storyboard?.meta?.title ?? mood;
  return pickStable(pool, seed);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * fetchTrack — cache-checked download with sha256 verification.
 * A dead entry is named, not swallowed: catalogues rot.
 */
export async function fetchTrack(track, workDir, { log = () => {}, force = false } = {}) {
  const musicDir = resolve(workDir, 'music');
  await mkdir(musicDir, { recursive: true });

  const ext = extname(new URL(track.downloadUrl).pathname) || '.mp3';
  const dest = resolve(musicDir, `${track.id}${ext}`);

  if (!force && (await exists(dest))) {
    if (!track.sha256) {
      log(`music: cached ${basename(dest)} (catalogue carries no sha256 to check it against)`);
      return dest;
    }
    const have = await sha256File(dest);
    if (have === track.sha256) {
      log(`music: cached ${basename(dest)} (sha256 ok)`);
      return dest;
    }
    log(`music: cached ${basename(dest)} failed its sha256 check, re-fetching`);
  }

  log(`music: fetching ${track.id} <- ${track.downloadUrl}`);
  let res;
  try {
    // A descriptive User-Agent is not optional on some hosts: Wikimedia's policy
    // rate-limits anonymous clients, and a bare Node fetch was observed taking
    // HTTP 429 on upload.wikimedia.org mid-batch.
    res = await fetch(track.downloadUrl, { redirect: 'follow', headers: { 'user-agent': FETCH_UA } });
  } catch (err) {
    throw new Error(
      `catalogue entry "${track.id}" (${track.title}) could not be reached: ${err.message}. ` +
        `Fix or remove it in assets/music/CATALOGUE.json.`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `catalogue entry "${track.id}" (${track.title}) is dead: HTTP ${res.status} from ${track.downloadUrl}. ` +
        `Fix or remove it in assets/music/CATALOGUE.json.`,
    );
  }

  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const { rename } = await import('node:fs/promises');
  await rename(tmp, dest);

  if (track.sha256) {
    const have = await sha256File(dest);
    if (have !== track.sha256) {
      throw new Error(
        `catalogue entry "${track.id}" downloaded but its sha256 does not match: ` +
          `expected ${track.sha256}, got ${have}. The source re-encoded the file — ` +
          `listen to it, then update the hash in assets/music/CATALOGUE.json.`,
      );
    }
  }

  const { size } = await stat(dest);
  log(`music: wrote ${dest} (${size} bytes)`);
  return dest;
}

function fontLicences(brand = {}) {
  const out = [];
  for (const role of ['display', 'body', 'mono']) {
    const spec = brand?.type?.[role];
    if (!spec?.license) continue;
    out.push({ role, family: spec.family ?? '(unnamed family)', license: spec.license });
  }
  return out;
}

/**
 * writeAttribution — the record of every track that went into the video.
 * Every track is listed, including CC0 and operator-supplied ones: attribution
 * not being *required* is not a reason to omit the asset from the provenance
 * file. "No third-party music was used" is only ever written when that is true.
 */
export async function writeAttribution(outDir, tracks, brand = {}) {
  await mkdir(outDir, { recursive: true });
  const path = resolve(outDir, 'ATTRIBUTION.md');
  const fonts = fontLicences(brand);
  const name = brand?.name ?? 'this video';

  const lines = [`# Attribution`, ``, `Third-party assets used in ${name}.`, ``];

  lines.push(`## Music`, ``);
  if (tracks.length === 0) {
    lines.push(`No third-party music was used in this video.`, ``);
  } else {
    for (const t of tracks) {
      const line =
        t.attributionLine ?? `"${t.title}" by ${t.artist ?? 'unknown artist'}, licensed under ${t.license}`;
      lines.push(`### ${t.title}`, ``);
      lines.push(line, ``);
      lines.push(`- Artist: ${t.artist ?? 'unknown'}`);
      lines.push(`- Source: ${t.source ?? 'unknown'}${t.sourceUrl ? ` — ${t.sourceUrl}` : ''}`);
      lines.push(`- Licence: ${t.license}${t.licenseUrl ? ` — ${t.licenseUrl}` : ''}`);
      lines.push(
        `- Attribution required: ${t.attributionRequired === false ? 'no (recorded anyway)' : 'yes'}`,
      );
      if (t.downloadUrl) lines.push(`- File: ${t.downloadUrl}`);
      else if (t.localFile) lines.push(`- File: ${t.localFile} (supplied locally, not fetched)`);
      lines.push(``);
    }
  }

  lines.push(`## Fonts`, ``);
  if (fonts.length === 0) {
    lines.push(`No font licence was recorded in the brand contract.`, ``);
  } else {
    for (const f of fonts) lines.push(`- ${f.family} (${f.role}) — ${f.license}`);
    lines.push(``);
  }

  if (brand?.legal?.attributionFooter) {
    lines.push(`## Notice`, ``, brand.legal.attributionFooter, ``);
  }

  await writeFile(path, lines.join('\n'), 'utf8');
  return path;
}

function resolveOutDir(ctx) {
  const raw = ctx.out ?? 'out';
  const abs = isAbsolute(raw) ? raw : resolve(ctx.cwd ?? process.cwd(), raw);
  return extname(abs) ? dirname(abs) : abs;
}

export async function run(ctx) {
  const log = ctx.log ?? (() => {});
  const storyboardPath = ctx.storyboard
    ? resolve(ctx.cwd ?? process.cwd(), ctx.storyboard)
    : null;
  if (!storyboardPath) throw new Error('music: --storyboard <path> is required');

  const storyboard = await readJson(storyboardPath);
  const brandPath = storyboard?.meta?.brandPath
    ? resolve(dirname(storyboardPath), storyboard.meta.brandPath)
    : ctx.brand
      ? resolve(ctx.cwd ?? process.cwd(), ctx.brand)
      : null;
  const brand = brandPath && (await exists(brandPath)) ? await readJson(brandPath) : {};

  const musicCfg = storyboard?.audio?.music ?? {};
  const workDir = ctx.work ?? resolve(process.cwd(), 'work');
  const musicDir = resolve(workDir, 'music');
  const outDir = resolveOutDir(ctx);

  const manifest = {
    generatedAt: new Date().toISOString(),
    storyboard: storyboardPath,
    gainDb: musicCfg.gainDb ?? -18,
    duck: musicCfg.duck ?? true,
    fadeInMs: musicCfg.fadeInMs ?? 1200,
    fadeOutMs: musicCfg.fadeOutMs ?? 2000,
    track: null,
    tracks: [],
  };

  const noMusic = readBoolFlag(ctx, 'no-music') || musicCfg.mood === 'none';
  const overrideFile = readFlag(ctx, 'music-file', 'PDV_MUSIC_FILE');
  const overrideCatalogue = readFlag(ctx, 'music-catalogue', 'PDV_MUSIC_CATALOGUE');

  if (noMusic) {
    log('music: disabled (--no-music or audio.music.mood "none") — video will carry voiceover only');
    manifest.disabled = true;
  } else if (overrideFile) {
    // Someone with their own licensed library bypasses the catalogue entirely.
    const src = resolve(ctx.cwd ?? process.cwd(), overrideFile);
    if (!(await exists(src))) throw new Error(`music: --music-file ${src} does not exist`);
    await mkdir(musicDir, { recursive: true });
    const dest = resolve(musicDir, `local${extname(src) || '.mp3'}`);
    await copyFile(src, dest);
    const { size } = await stat(dest);
    log(`music: local override ${src} -> ${dest} (${size} bytes)`);
    // A track the operator supplied is still a track that shipped. Record it,
    // and say plainly when no licence was declared rather than writing the
    // false "no third-party music was used" line.
    const declaredLicense =
      readFlag(ctx, 'music-license', 'PDV_MUSIC_LICENSE') ?? musicCfg.license ?? null;
    const declaredArtist = readFlag(ctx, 'music-artist', 'PDV_MUSIC_ARTIST') ?? musicCfg.artist ?? null;
    manifest.track = {
      id: 'local',
      title: basename(src),
      artist: declaredArtist,
      source: 'operator-supplied (--music-file)',
      license: declaredLicense ?? 'not declared',
      licenseUrl: musicCfg.licenseUrl ?? null,
      // Undeclared means unknown, and unknown is not "no attribution needed".
      attributionRequired: declaredLicense === null ? true : musicCfg.attributionRequired !== false,
      attributionLine: declaredLicense
        ? `"${basename(src)}"${declaredArtist ? ` by ${declaredArtist}` : ''}, operator-supplied, licensed under ${declaredLicense}`
        : `"${basename(src)}" — user-supplied track, licence not declared. Confirm the licence before publishing.`,
      localFile: basename(dest),
      path: dest,
      bytes: size,
    };
    manifest.tracks = [manifest.track];
    if (!declaredLicense) {
      log(
        'music: --music-file carries no declared licence — ATTRIBUTION.md will say so. ' +
          'Declare one with --music-license "<licence>" (and --music-artist) before publishing.',
      );
    }
  } else {
    const catalogue = await loadCatalogue(
      overrideCatalogue ? resolve(ctx.cwd ?? process.cwd(), overrideCatalogue) : DEFAULT_CATALOGUE,
    );
    const track = selectTrack(storyboard, catalogue, brand);
    if (!track) {
      manifest.disabled = true;
    } else {
      const path = await fetchTrack(track, workDir, { log, force: ctx.force === true });
      const { size } = await stat(path);
      manifest.track = { ...track, path, bytes: size };
      // Recorded whether or not attribution is required — a CC0 track that went
      // into a published video is still part of its provenance.
      manifest.tracks = [track];
    }
  }

  await mkdir(musicDir, { recursive: true });
  const manifestPath = resolve(musicDir, 'music-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const attributionPath = await writeAttribution(outDir, manifest.tracks, brand);
  log(`music: manifest ${manifestPath}`);
  log(`music: attribution ${attributionPath}`);

  return { manifestPath, attributionPath, track: manifest.track };
}
