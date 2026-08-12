/**
 * qa — the verification gate.
 *
 * This is a gate, not a report. It reads the rendered file with ffprobe/ffmpeg
 * and refuses to certify a video that fails any check. `QA: PASS` on stdout is
 * the only thing anywhere in this pipeline that means a video is finished.
 *
 * Every check answers a question about the FILE, never about the intent that
 * produced it — the whole point is to catch the case where the pipeline
 * believed it succeeded and the artefact says otherwise.
 *
 *   pdv qa --video out/x.mp4 --storyboard storyboard.json
 *   pdv qa --storyboard storyboard.json          # infers the video from meta.slug
 */

import { join, dirname, basename, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { run as sh, readJson, writeJson, exists } from './util.mjs';

/** A scene fade legitimately dips dark; only a sustained black frame is a defect. */
export const BLACK_MIN_SEC = 0.5;
export const BLACK_PIXEL_THRESHOLD = 0.98;

/** Below this the audio track exists but carries nothing audible. */
export const SILENCE_MEAN_DB = -70;

/** Storyboard totals are estimates until VO is measured; 5% absorbs that. */
export const DURATION_TOLERANCE = 0.05;

/** Burned-in captions sit over live footage, so they need more than body-text contrast. */
export const MIN_CAPTION_CONTRAST = 3.0;

export async function ffprobeJson(file, args) {
  const { stdout } = await sh('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    ...args,
    file,
  ]);
  return JSON.parse(stdout);
}

/**
 * ffmpeg reports blackdetect and volumedetect on stderr, so both are parsed out
 * of a single decode pass rather than paying for the file twice.
 */
export async function analyseStream(file) {
  const { stderr } = await sh(
    'ffmpeg',
    [
      '-hide_banner', '-nostats',
      '-i', file,
      '-vf', `blackdetect=d=${BLACK_MIN_SEC}:pic_th=${BLACK_PIXEL_THRESHOLD}`,
      '-af', 'volumedetect',
      '-f', 'null', '-',
    ],
    { allowFail: true },
  );

  const blackIntervals = [];
  for (const m of stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
    blackIntervals.push({
      startSec: Number(m[1]),
      endSec: Number(m[2]),
      durationSec: Number(m[3]),
    });
  }

  const meanMatch = stderr.match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  const maxMatch = stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  const toDb = (v) => (v === undefined || v === '-inf' ? -Infinity : Number(v));

  return {
    blackIntervals,
    meanVolumeDb: toDb(meanMatch?.[1]),
    maxVolumeDb: toDb(maxMatch?.[1]),
  };
}

function check(id, passed, detail) {
  return { id, passed: Boolean(passed), detail };
}

/**
 * @returns {{passed: boolean, checks: Array, facts: object}}
 */
export async function gate({ video, storyboard, report, outDir }) {
  const checks = [];

  const probe = await ffprobeJson(video, ['-show_streams', '-show_format']);
  const vStream = probe.streams?.find((s) => s.codec_type === 'video');
  const aStream = probe.streams?.find((s) => s.codec_type === 'audio');
  const durationSec = Number(probe.format?.duration ?? 0);

  const wantW = storyboard?.meta?.width ?? 1920;
  const wantH = storyboard?.meta?.height ?? 1080;

  // 1. Resolution — exact, not "close enough". A 1918px video is a broken filter graph.
  checks.push(
    check(
      'resolution',
      vStream && vStream.width === wantW && vStream.height === wantH,
      vStream
        ? `${vStream.width}x${vStream.height} (want ${wantW}x${wantH})`
        : 'no video stream',
    ),
  );

  // yuv420p is the only pixel format that plays everywhere. yuv444p looks fine
  // locally and fails on half the devices the video will actually be watched on.
  checks.push(
    check(
      'pixel-format',
      vStream?.pix_fmt === 'yuv420p',
      `pix_fmt=${vStream?.pix_fmt ?? 'none'}`,
    ),
  );

  // 2. Audio present and audible.
  checks.push(check('audio-stream', Boolean(aStream), aStream ? `${aStream.codec_name} ${aStream.sample_rate}Hz` : 'no audio stream'));

  const analysis = aStream || vStream ? await analyseStream(video) : { blackIntervals: [], meanVolumeDb: -Infinity, maxVolumeDb: -Infinity };

  if (aStream) {
    const audible = Number.isFinite(analysis.meanVolumeDb) && analysis.meanVolumeDb > SILENCE_MEAN_DB;
    checks.push(
      check(
        'audio-audible',
        audible,
        `mean_volume=${analysis.meanVolumeDb === -Infinity ? '-inf' : analysis.meanVolumeDb} dB (floor ${SILENCE_MEAN_DB})`,
      ),
    );
  }

  // 3. No sustained black frame. Catches a capture that produced nothing and a
  //    filter graph that dropped a scene — both render as black, both look
  //    identical to "still encoding" until someone watches it.
  checks.push(
    check(
      'no-black-frames',
      analysis.blackIntervals.length === 0,
      analysis.blackIntervals.length
        ? analysis.blackIntervals
            .map((b) => `${b.startSec}s-${b.endSec}s (${b.durationSec}s)`)
            .join(', ')
        : `none over ${BLACK_MIN_SEC}s`,
    ),
  );

  // 4. Duration within tolerance of what was planned.
  const plannedSec = Number(report?.totalSec ?? 0);
  if (plannedSec > 0) {
    const drift = Math.abs(durationSec - plannedSec) / plannedSec;
    checks.push(
      check(
        'duration',
        drift <= DURATION_TOLERANCE,
        `${durationSec.toFixed(2)}s vs planned ${plannedSec.toFixed(2)}s (${(drift * 100).toFixed(1)}% drift, tolerance ${DURATION_TOLERANCE * 100}%)`,
      ),
    );
  } else {
    checks.push(check('duration', true, `${durationSec.toFixed(2)}s (no render report to compare against)`));
  }

  // 5. Attribution. A CC-BY track with no attribution file is a licence breach,
  //    so it fails the build rather than warning.
  const attributionPath = join(outDir, 'ATTRIBUTION.md');
  const hasAttribution = await exists(attributionPath);
  const musicManifest = await readMusicManifest(dirname(video), report);
  const needsAttribution = musicManifest.tracks.some((t) => t.attributionRequired !== false);

  if (needsAttribution) {
    let namesEveryTrack = false;
    if (hasAttribution) {
      const text = await readFile(attributionPath, 'utf8');
      namesEveryTrack = musicManifest.tracks
        .filter((t) => t.attributionRequired !== false)
        .every((t) => (t.title ? text.includes(t.title) : true));
    }
    checks.push(
      check(
        'attribution',
        hasAttribution && namesEveryTrack,
        hasAttribution
          ? namesEveryTrack
            ? `${basename(attributionPath)} names all ${musicManifest.tracks.length} track(s)`
            : 'ATTRIBUTION.md exists but does not name every attribution-required track'
          : 'ATTRIBUTION.md missing while an attribution-required track is used',
      ),
    );
  } else {
    checks.push(
      check('attribution', true, musicManifest.tracks.length ? 'no attribution-required tracks' : 'no music'),
    );
  }

  // 6. Caption legibility, from the contrast measured at render time.
  const cap = report?.captions;
  if (cap?.burnedIn) {
    const ratio = cap.contrast?.ratio;
    checks.push(
      check(
        'caption-contrast',
        typeof ratio === 'number' && ratio >= MIN_CAPTION_CONTRAST,
        `ratio=${ratio ?? 'unmeasured'} (floor ${MIN_CAPTION_CONTRAST})`,
      ),
    );
  } else {
    checks.push(check('caption-contrast', true, 'captions not burned in'));
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
    facts: {
      video,
      durationSec,
      width: vStream?.width ?? null,
      height: vStream?.height ?? null,
      fps: vStream?.r_frame_rate ?? null,
      videoCodec: vStream?.codec_name ?? null,
      pixFmt: vStream?.pix_fmt ?? null,
      audioCodec: aStream?.codec_name ?? null,
      meanVolumeDb: analysis.meanVolumeDb === -Infinity ? null : analysis.meanVolumeDb,
      sizeBytes: Number(probe.format?.size ?? 0),
      blackIntervals: analysis.blackIntervals,
    },
  };
}

/**
 * The music manifest filename has moved once already, so probe the known names
 * rather than pinning one and silently reading nothing.
 */
async function readMusicManifest(outDir, report) {
  const candidates = [
    report?.audio?.musicManifest,
    join(outDir, '..', 'work', 'music', 'music-manifest.json'),
    join(outDir, '..', 'work', 'music', 'manifest.json'),
    'work/music/music-manifest.json',
    'work/music/manifest.json',
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      const m = await readJson(p).catch(() => null);
      if (m) return { tracks: m.tracks ?? [], source: p };
    }
  }
  return { tracks: [], source: null };
}

export async function run(ctx) {
  const storyboardPath = ctx.storyboard ? resolve(ctx.storyboard) : null;
  const storyboard = storyboardPath ? await readJson(storyboardPath) : null;

  let video = ctx.video ? resolve(ctx.video) : null;
  if (!video) {
    const slug = storyboard?.meta?.slug;
    if (!slug) throw new Error('pass --video, or --storyboard with meta.slug set');
    video = resolve(ctx.out ?? 'out', `${slug}.mp4`);
  }

  if (!existsSync(video)) {
    throw new Error(`no such video: ${video}\n  run the render stage first`);
  }

  const outDir = dirname(video);
  const stem = basename(video).replace(/\.[^.]+$/, '');
  const reportPath = join(outDir, `${stem}.render.json`);
  const report = existsSync(reportPath) ? await readJson(reportPath) : null;

  if (!report) {
    ctx.log(`qa: no ${basename(reportPath)} — duration and caption checks run in reduced mode`);
  }

  const result = await gate({ video, storyboard, report, outDir });

  const width = Math.max(...result.checks.map((c) => c.id.length));
  ctx.log('');
  for (const c of result.checks) {
    ctx.log(`  ${c.passed ? 'ok  ' : 'FAIL'}  ${c.id.padEnd(width)}  ${c.detail}`);
  }
  ctx.log('');

  const qaPath = join(outDir, `${stem}.qa.json`);
  await writeJson(qaPath, {
    passed: result.passed,
    checkedAt: new Date().toISOString(),
    ...result.facts,
    checks: result.checks,
  });

  // The literal line is the contract. Nothing else counts as evidence of a pass.
  if (result.passed) {
    process.stdout.write('QA: PASS\n');
    ctx.log(`qa: wrote ${qaPath}`);
    return result;
  }

  const failed = result.checks.filter((c) => !c.passed).map((c) => c.id);
  process.stdout.write(`QA: FAIL (${failed.join(', ')})\n`);
  ctx.log(`qa: wrote ${qaPath}`);
  process.exitCode = 1;
  return result;
}
