/**
 * Captions rendered by the browser, not by ffmpeg.
 *
 * The obvious way to burn in captions is libass via ffmpeg's `ass` filter. It
 * has two problems. The first is availability: plenty of ffmpeg builds — the
 * current Homebrew bottle among them — ship without libass, drawtext AND
 * freetype, so ffmpeg cannot draw a glyph at all and captions silently
 * degrade to a sidecar nobody opens.
 *
 * The second is quality. libass is not the brand's typesetter. It does not do
 * the same letter-spacing, the same weight, or the same rounded bar as the
 * scene templates, so the captions look like they belong to a different video.
 *
 * Chromium is already a hard dependency of this pipeline and it is a very good
 * typesetter. So each cue is rendered to a transparent PNG with the real brand
 * font and composited with ffmpeg's `overlay`, which exists in every build.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, extname } from 'node:path';
import { existsSync } from 'node:fs';

import { contrastRatio } from './util.mjs';

/** Caption band geometry as a fraction of frame height. */
const BAND = {
  fontRatio: 0.0324, // ~35px at 1080p — legible on a phone, not shouty on a TV
  lineHeight: 1.28,
  paddingXRatio: 0.62, // of font size
  paddingYRatio: 0.42,
  bottomMarginRatio: 0.072,
  radiusRatio: 0.28,
};

async function fontFaceCss(brand, brandDir) {
  const blocks = [];
  for (const role of ['display', 'body']) {
    const spec = brand.type?.[role];
    for (const file of spec?.fontFiles ?? []) {
      const path = isAbsolute(file.path) ? file.path : resolve(brandDir, file.path);
      if (!existsSync(path)) continue;
      const ext = extname(path).toLowerCase();
      const format = ext === '.woff2' ? 'woff2' : ext === '.woff' ? 'woff' : 'truetype';
      const data = await readFile(path);
      blocks.push(
        `@font-face{font-family:'${spec.family}';src:url(data:font/${format};base64,${data.toString('base64')}) format('${format}');` +
          `font-weight:${file.weight ?? spec.weight ?? 400};font-style:${file.style ?? 'normal'};font-display:block}`,
      );
    }
  }
  return blocks.join('\n');
}

/**
 * Colours for the three caption styles, plus the contrast the QA gate reads.
 * `bar` is the default because a scrim is the only style that stays legible
 * over arbitrary product footage.
 */
export function captionPalette(brand, style = 'bar') {
  const text = brand.color?.background ?? '#FFFFFF';
  const bar = brand.color?.text ?? '#111827';

  if (style === 'block') {
    return { text, bar, barAlpha: 1, outline: null, ratio: contrastRatio(text, bar) };
  }
  if (style === 'outline') {
    // No bar: type sits directly on footage with a dark outline carrying it.
    const t = brand.color?.background ?? '#FFFFFF';
    return { text: t, bar: null, barAlpha: 0, outline: brand.color?.text ?? '#111827', ratio: contrastRatio(t, brand.color?.text ?? '#111827') };
  }
  return { text, bar, barAlpha: 0.88, outline: null, ratio: contrastRatio(text, bar) };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/**
 * Render one transparent PNG per cue.
 *
 * @returns {Promise<{images: Array<{path, startSec, endSec, width, height}>, palette: object}>}
 */
export async function renderCaptionImages(cues, { brand, brandDir, meta, outDir, log } = {}) {
  if (!cues?.length) return { images: [], palette: null };

  const width = meta.width ?? 1920;
  const height = meta.height ?? 1080;
  const style = meta.captionStyle ?? 'bar';
  const palette = captionPalette(brand, style);

  const fontPx = Math.round(height * BAND.fontRatio);
  const padX = Math.round(fontPx * BAND.paddingXRatio);
  const padY = Math.round(fontPx * BAND.paddingYRatio);
  const radius = Math.round(fontPx * BAND.radiusRatio);
  const family = brand.type?.body?.family ?? brand.type?.display?.family ?? 'sans-serif';
  const stack = brand.type?.body?.fallbackStack ?? `'${family}', sans-serif`;

  const css = await fontFaceCss(brand, brandDir);
  await mkdir(outDir, { recursive: true });

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const images = [];

  try {
    // deviceScaleFactor 2 for the same reason scenes capture at 2x: caption
    // type is small, and small type is where upscaling shows first.
    const page = await browser.newPage({ viewport: { width, height: 400 }, deviceScaleFactor: 2 });

    for (const [i, cue] of cues.entries()) {
      const lines = (cue.lines ?? String(cue.text ?? '').split('\n')).filter(Boolean);
      if (!lines.length) continue;

      const barCss =
        palette.bar && palette.barAlpha > 0
          ? `background:${palette.bar};opacity:1;`
          : 'background:transparent;';
      const textShadow = palette.outline
        ? `text-shadow:0 0 ${Math.round(fontPx * 0.14)}px ${palette.outline}, 0 2px ${Math.round(fontPx * 0.1)}px ${palette.outline};`
        : '';

      await page.setContent(
        `<style>${css}
         html,body{margin:0;background:transparent}
         #wrap{display:flex;justify-content:center;width:${width}px}
         #cap{
           ${barCss}
           border-radius:${radius}px;
           padding:${padY}px ${padX}px;
           max-width:${Math.round(width * 0.78)}px;
           font-family:${stack};
           font-weight:${brand.type?.body?.weight ?? 500};
           font-size:${fontPx}px;
           line-height:${BAND.lineHeight};
           color:${palette.text};
           text-align:center;
           ${textShadow}
           opacity:${palette.barAlpha > 0 ? palette.barAlpha : 1};
         }</style>
         <div id="wrap"><div id="cap">${lines.map(escapeHtml).join('<br>')}</div></div>`,
        { waitUntil: 'load' },
      );
      await page.evaluate(() => document.fonts.ready);

      const el = await page.$('#cap');
      const path = join(outDir, `cue-${String(i).padStart(4, '0')}.png`);
      await el.screenshot({ path, omitBackground: true });
      const box = await el.boundingBox();

      images.push({
        path,
        startSec: cue.startSec,
        endSec: cue.endSec,
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
    }
  } finally {
    await browser.close();
  }

  log?.(`render: rendered ${images.length} caption image(s) at ${fontPx}px, contrast ${palette.ratio.toFixed(2)}:1`);
  return { images, palette };
}

/**
 * ffmpeg inputs and an overlay chain for the rendered cues.
 *
 * Each cue is one input and one overlay gated by `enable=between(t,...)`.
 * Cues are short and few (a 60s video runs to roughly 15), so the graph stays
 * well inside ffmpeg's limits.
 */
export function buildCaptionOverlay({ images, firstInputIndex, meta, inLabel = 'vchain', outLabel = 'vout' }) {
  if (!images?.length) return { inputArgs: [], filters: [], inLabel, outLabel: inLabel };

  const height = meta.height ?? 1080;
  const bottom = Math.round(height * BAND.bottomMarginRatio);
  const position = meta.captionPosition ?? 'bottom';

  const inputArgs = [];
  const filters = [];
  let cur = inLabel;

  images.forEach((img, i) => {
    inputArgs.push('-i', img.path);
    const idx = firstInputIndex + i;
    const next = i === images.length - 1 ? outLabel : `cap${i}`;
    const y = position === 'top' ? bottom : `H-h-${bottom}`;
    filters.push(
      `[${cur}][${idx}:v]overlay=x=(W-w)/2:y=${y}:` +
        `enable='between(t,${img.startSec.toFixed(3)},${img.endSec.toFixed(3)})'[${next}]`,
    );
    cur = next;
  });

  // inLabel is returned so the caller can splice this chain onto whatever
  // label its own pipeline ended on — without it the graph silently leaves the
  // preceding filter's output unconnected and ffmpeg refuses the whole thing.
  return { inputArgs, filters, inLabel, outLabel: cur };
}

/** Write the .srt sidecar alongside, since it costs nothing and travels well. */
export async function writeSidecar(path, text) {
  await writeFile(path, text, 'utf8');
  return path;
}
