/**
 * capture — record every scene's visual to work/scenes/<id>/ and write
 * work/capture-manifest.json.
 *
 * Frames are stepped DETERMINISTICALLY, not recorded against a wall clock: for
 * a demo scene the recorder computes how many frames each flow step occupies at
 * meta.fps, eases the synthetic cursor one frame at a time, applies each state
 * change on the exact frame it should land, and screenshots after every step.
 * The result is exact 30fps with no compositor drops and no codec mush on small
 * type. Playwright's recordVideo exists only for `url` scenes that depend on
 * animation the harness cannot step.
 *
 * Everything is captured at deviceScaleFactor 2 into a viewport the size of the
 * finished frame, so a 1920x1080 video is composed from 3840x2160 source and
 * downsampled at render. 1080p text captured at 1x looks soft.
 *
 * DEMO RUNTIME CONTRACT — a page built by `pdv demo` may expose:
 *   window.__pdv.ready               Promise resolving when the app has mounted
 *   window.__pdv.setTransitions(bool) disable CSS transitions for stepped frames
 * Both are optional. When absent the recorder waits for load and injects its own
 * transition killer, so any static page can be driven.
 */

import { createReadStream } from 'node:fs';
import { copyFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { chromium } from 'playwright';

import { ease, ensureDir, exists, readJson, resolveBrand, writeJson } from './util.mjs';

/** Source is captured at 2x and downsampled at render; see the header note. */
export const CAPTURE_SCALE = 2;
export const DEFAULT_FPS = 30;
export const DEFAULT_FRAME = [1920, 1080];
export const DEFAULT_DEMO_VIEWPORT = [1600, 900];

/** How long each flow action occupies when the step does not say. */
export const DEFAULT_STEP_MS = {
  click: 900,
  fill: 1400,
  hover: 700,
  press: 600,
  wait: 600,
  scroll: 1000,
  moveCursor: 700,
  highlight: 900,
  waitForSelector: 0,
};

/** A click needs a beat afterwards or the cut reads as a jump. */
export const CLICK_SETTLE_MS = 260;
/** The cursor arrives over the first 70% of a step; the rest is the settle. */
export const CURSOR_TRAVEL_FRACTION = 0.7;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pad6 = (n) => String(n).padStart(6, '0');

export function normaliseMeta(meta = {}) {
  return {
    width: Number(meta.width ?? DEFAULT_FRAME[0]),
    height: Number(meta.height ?? DEFAULT_FRAME[1]),
    fps: Number(meta.fps ?? DEFAULT_FPS),
    title: meta.title ?? '',
    slug: meta.slug ?? 'video',
    brandPath: meta.brandPath,
  };
}

/**
 * Turn a flow into a frame plan. Pure — no browser, no clock.
 * `actFrame` is the frame the state change lands on; the cursor travels to the
 * target over the frames before it and holds afterwards.
 */
export function planFlow(flow = [], fps = DEFAULT_FPS) {
  const steps = [];
  let cursor = 0;
  for (const step of flow) {
    const base = Number(step.ms ?? DEFAULT_STEP_MS[step.action] ?? 800);
    const ms = base + (step.action === 'click' ? CLICK_SETTLE_MS : 0);
    const frames = ms > 0 ? Math.max(1, Math.round((ms / 1000) * fps)) : 0;
    const travel = Math.max(1, Math.round(frames * CURSOR_TRAVEL_FRACTION));
    steps.push({
      step,
      ms,
      frames,
      startFrame: cursor,
      travelFrames: travel,
      actFrame: Math.min(Math.max(frames - 1, 0), travel),
    });
    cursor += frames;
  }
  return { steps, totalFrames: cursor, durationMs: Math.round((cursor / fps) * 1000) };
}

/**
 * Static file server on an ephemeral localhost port.
 * `extraRoutes` maps an exact pathname to { body, type } and wins over disk. The
 * object is held by reference, so a route can be added after listen() — which is
 * how the shell page learns its own origin.
 */
export function serveDir(root, extraRoutes = {}) {
  const rootAbs = resolve(root);
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const extra = extraRoutes[url.pathname];
      if (extra) {
        res.writeHead(200, { 'content-type': extra.type ?? 'text/html; charset=utf-8' });
        res.end(extra.body);
        return;
      }
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const target = resolve(rootAbs, `.${pathname}`);
      if (target !== rootAbs && !target.startsWith(`${rootAbs}/`)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const stream = createReadStream(target);
      stream.on('error', () => {
        res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${pathname}`);
      });
      stream.on('open', () => {
        res.writeHead(200, {
          'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        stream.pipe(res);
      });
    });
    server.on('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolvePromise({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * Self-hosted fonts as data URIs. The renderer runs offline and a file:// page
 * cannot fetch a font from another directory, so embedding is the only path
 * that always works.
 */
const IMAGE_MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Inline every brand image as a data URI.
 *
 * A scene template is loaded over file:// from templates/scenes/, so a relative
 * logo path in brand.json resolves against the TEMPLATE directory, not the
 * brand file — the image 404s and the template quietly falls back to setting
 * the product name as type. The user supplied a logo and never sees it. Data
 * URIs remove the resolution step entirely, which is the same reason fonts are
 * embedded rather than linked.
 *
 * @returns a brand clone; the original is left untouched.
 */
export async function embedBrandImages(brand, { cwd = process.cwd(), log } = {}) {
  const out = structuredClone(brand);

  const inline = async (value, label) => {
    if (!value || /^(data:|https?:)/i.test(value)) return value;
    const path = isAbsolute(value) ? value : resolve(cwd, value);
    if (!(await exists(path))) {
      log?.(`  brand image missing, template will fall back: ${label} -> ${value}`);
      return value;
    }
    const mime = IMAGE_MIME[extname(path).toLowerCase()];
    if (!mime) {
      log?.(`  unsupported brand image type, left as a path: ${label} -> ${value}`);
      return value;
    }
    const data = await readFile(path);
    return `data:${mime};base64,${data.toString('base64')}`;
  };

  for (const key of ['primary', 'inverse', 'mark']) {
    if (out.logo?.[key]) out.logo[key] = await inline(out.logo[key], `logo.${key}`);
  }
  if (out.assets?.watermark) {
    out.assets.watermark = await inline(out.assets.watermark, 'assets.watermark');
  }
  return out;
}

export async function fontFaceCss(brand, { cwd = process.cwd(), log } = {}) {
  const blocks = [];
  for (const role of ['display', 'body', 'mono']) {
    const spec = brand.type?.[role];
    for (const file of spec?.fontFiles ?? []) {
      const path = isAbsolute(file.path) ? file.path : resolve(cwd, file.path);
      if (!(await exists(path))) {
        log?.(`  font missing, falling back to the stack: ${file.path}`);
        continue;
      }
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

/** Kills every transition, animation and caret so a stepped frame is stable. */
export const DETERMINISM_CSS = `*,*::before,*::after{transition:none!important;animation:none!important;` +
  `animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important;` +
  `scroll-behavior:auto!important}`;

/**
 * The outer page: a branded browser window with the captured surface inside it.
 * The frame is drawn HERE, in the page, so it captures at full resolution —
 * compositing it later in ffmpeg would resample the whole shot.
 */
export function shellHtml({ tokens, brand, meta, targetUrl, viewport, chrome, fontCss = '' }) {
  const [vw, vh] = viewport;
  const scaleUnit = meta.width / 1920;
  const barH = Math.round(52 * scaleUnit);
  const margin = chrome ? Math.round(meta.width * 0.042) : 0;
  const radius = chrome ? Math.round(18 * scaleUnit) : 0;
  const urlLabel = brand.url ?? 'localhost';
  const vars = Object.entries(tokens)
    .map(([k, v]) => `  --pdv-${k}: ${v};`)
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>capture shell</title><style>
${fontCss}
:root{
${vars}
}
html,body{margin:0;padding:0;width:${meta.width}px;height:${meta.height}px;overflow:hidden;
  background:var(--pdv-color-background);font-family:var(--pdv-font-body);}
#pdv-stage{position:relative;width:${meta.width}px;height:${meta.height}px;
  background:linear-gradient(var(--pdv-color-gradient-angle),var(--pdv-color-background),var(--pdv-color-surface));}
#pdv-window{position:absolute;left:${margin}px;top:${margin}px;
  width:${meta.width - margin * 2}px;height:${meta.height - margin * 2}px;
  border-radius:${radius}px;overflow:hidden;background:var(--pdv-color-surface);
  ${chrome ? 'box-shadow:var(--pdv-shadow-card);border:1px solid var(--pdv-color-border);' : ''}}
#pdv-bar{display:${chrome ? 'flex' : 'none'};align-items:center;height:${barH}px;padding:0 ${Math.round(20 * scaleUnit)}px;
  gap:${Math.round(9 * scaleUnit)}px;background:var(--pdv-color-surface-alt);border-bottom:1px solid var(--pdv-color-border);}
.pdv-dot{width:${Math.round(13 * scaleUnit)}px;height:${Math.round(13 * scaleUnit)}px;border-radius:50%;
  background:var(--pdv-color-border);}
#pdv-url{flex:1;margin-left:${Math.round(18 * scaleUnit)}px;height:${Math.round(32 * scaleUnit)}px;
  border-radius:${Math.round(16 * scaleUnit)}px;background:var(--pdv-color-background);
  color:var(--pdv-color-text-muted);font-size:${Math.round(15 * scaleUnit)}px;font-family:var(--pdv-font-body);
  display:flex;align-items:center;padding:0 ${Math.round(18 * scaleUnit)}px;}
#pdv-wrap{position:relative;width:100%;height:calc(100% - ${chrome ? barH : 0}px);overflow:hidden;
  background:var(--pdv-color-background);}
#pdv-frame{position:absolute;left:0;top:0;width:${vw}px;height:${vh}px;border:0;transform-origin:0 0;}
#pdv-cursor{position:absolute;left:0;top:0;width:${Math.round(30 * scaleUnit)}px;height:${Math.round(30 * scaleUnit)}px;
  pointer-events:none;z-index:40;opacity:0;will-change:transform;}
#pdv-cursor[data-visible="1"]{opacity:1;}
#pdv-ring{position:absolute;left:0;top:0;width:${Math.round(46 * scaleUnit)}px;height:${Math.round(46 * scaleUnit)}px;
  margin-left:${Math.round(-23 * scaleUnit)}px;margin-top:${Math.round(-23 * scaleUnit)}px;border-radius:50%;
  border:${Math.round(3 * scaleUnit)}px solid var(--pdv-color-primary);pointer-events:none;z-index:39;opacity:0;}
#pdv-label{position:absolute;left:50%;bottom:${Math.round(36 * scaleUnit)}px;transform:translateX(-50%);
  max-width:70%;padding:${Math.round(12 * scaleUnit)}px ${Math.round(22 * scaleUnit)}px;
  border-radius:999px;background:var(--pdv-color-primary);color:var(--pdv-color-on-primary);
  font-family:var(--pdv-font-body);font-size:${Math.round(22 * scaleUnit)}px;font-weight:600;
  z-index:41;display:none;}
</style></head>
<body><div id="pdv-stage">
  <div id="pdv-window">
    <div id="pdv-bar">
      <span class="pdv-dot"></span><span class="pdv-dot"></span><span class="pdv-dot"></span>
      <div id="pdv-url">${esc(urlLabel)}</div>
    </div>
    <div id="pdv-wrap">
      <iframe id="pdv-frame" src="${esc(targetUrl)}" title="capture surface"></iframe>
      <div id="pdv-ring"></div>
      <svg id="pdv-cursor" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 2.5 19.5 12.2l-6.4.6 3.3 7.1-2.6 1.2-3.3-7.2-4.5 4.4z"
              fill="#ffffff" stroke="#111111" stroke-width="1.2" stroke-linejoin="round"/>
      </svg>
    </div>
  </div>
  <div id="pdv-label"></div>
</div>
<script>
(() => {
  const VW = ${vw}, VH = ${vh};
  const wrap = document.getElementById('pdv-wrap');
  const frame = document.getElementById('pdv-frame');
  const cursor = document.getElementById('pdv-cursor');
  const ring = document.getElementById('pdv-ring');
  const label = document.getElementById('pdv-label');
  const s = Math.min(wrap.clientWidth / VW, wrap.clientHeight / VH);
  frame.style.transform = 'translate(' + ((wrap.clientWidth - VW * s) / 2) + 'px,'
    + ((wrap.clientHeight - VH * s) / 2) + 'px) scale(' + s + ')';
  frame.dataset.pdvScale = String(s);
  window.__pdvShell = {
    scale: s,
    setCursor(x, y, visible) {
      const r = wrap.getBoundingClientRect();
      cursor.style.transform = 'translate(' + (x - r.left) + 'px,' + (y - r.top) + 'px)';
      ring.style.transform = 'translate(' + (x - r.left) + 'px,' + (y - r.top) + 'px) scale(1)';
      cursor.dataset.visible = visible === false ? '0' : '1';
    },
    setPressed(on) { ring.style.opacity = on ? '0.85' : '0'; },
    setLabel(text) {
      label.textContent = text || '';
      label.style.display = text ? 'block' : 'none';
    },
  };
})();
</script></body></html>`;
}

/** Scene page for an `html` capture when templates/scenes/<template>.html is absent. */
export function fallbackSceneHtml({ tokens, scene, meta }) {
  const c = scene.content ?? {};
  const vars = Object.entries(tokens).map(([k, v]) => `  --pdv-${k}: ${v};`).join('\n');
  const bullets = Array.isArray(c.bullets) && c.bullets.length
    ? `<ul>${c.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
    : '';
  const unit = meta.width / 1920;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(c.heading ?? scene.id)}</title><style>
:root{
${vars}
}
html,body{margin:0;width:${meta.width}px;height:${meta.height}px;overflow:hidden;background:var(--pdv-color-background);}
main{box-sizing:border-box;width:100%;height:100%;padding:${Math.round(160 * unit)}px;display:flex;flex-direction:column;
  justify-content:center;gap:${Math.round(28 * unit)}px;font-family:var(--pdv-font-body);color:var(--pdv-color-text);}
.eyebrow{font-size:${Math.round(28 * unit)}px;letter-spacing:0.14em;text-transform:uppercase;color:var(--pdv-color-primary);}
h1{margin:0;font-family:var(--pdv-font-display);font-weight:var(--pdv-weight-display);
  letter-spacing:var(--pdv-tracking-display);font-size:${Math.round(104 * unit)}px;line-height:1.04;}
p{margin:0;font-size:${Math.round(38 * unit)}px;line-height:1.4;color:var(--pdv-color-text-muted);max-width:72%;}
ul{margin:0;padding-left:${Math.round(32 * unit)}px;font-size:${Math.round(34 * unit)}px;line-height:1.7;}
</style></head><body><main>
${c.eyebrow ? `<div class="eyebrow" data-pdv="eyebrow">${esc(c.eyebrow)}</div>` : ''}
<h1 data-pdv="heading">${esc(c.heading ?? scene.content?.title ?? meta.title)}</h1>
${c.body ? `<p data-pdv="body">${esc(c.body)}</p>` : ''}
${bullets}
</main></body></html>`;
}

/** Resolve a selector to a box in CAPTURED pixel space (frame px * CAPTURE_SCALE). */
async function resolveBox(scope, selector) {
  try {
    const box = await scope.locator(selector).first().boundingBox({ timeout: 2000 });
    if (!box) return null;
    return {
      x: Math.round(box.x * CAPTURE_SCALE),
      y: Math.round(box.y * CAPTURE_SCALE),
      w: Math.round(box.width * CAPTURE_SCALE),
      h: Math.round(box.height * CAPTURE_SCALE),
    };
  } catch {
    return null;
  }
}

/** Centre of a captured box, back in page (CSS) coordinates. */
const boxCentre = (box) => ({
  x: (box.x + box.w / 2) / CAPTURE_SCALE,
  y: (box.y + box.h / 2) / CAPTURE_SCALE,
});

async function killTransitions(page) {
  await page.addStyleTag({ content: DETERMINISM_CSS }).catch(() => {});
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    await frame
      .evaluate((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head?.appendChild(style);
      }, DETERMINISM_CSS)
      .catch(() => {});
  }
}

/** Honour the demo runtime contract when the page offers it. */
async function awaitDemoRuntime(frame, log) {
  const hasRuntime = await frame.evaluate(() => Boolean(window.__pdv)).catch(() => false);
  if (!hasRuntime) {
    log?.('  no window.__pdv on the demo page — using injected determinism CSS only');
    return false;
  }
  await frame.evaluate(async () => {
    if (window.__pdv?.ready) await window.__pdv.ready;
    window.__pdv?.setTransitions?.(false);
  });
  return true;
}

async function shot(page, path, { mask, maskColor = '#140934' } = {}) {
  await page.screenshot({
    path,
    animations: 'disabled',
    caret: 'hide',
    scale: 'device',
    // Painted at screenshot time, so a late re-render cannot expose what a
    // DOM-level redaction had already replaced.
    ...(mask?.length ? { mask, maskColor } : {}),
  });
}

/**
 * A page built by `pdv demo` draws and animates its OWN cursor, and its
 * cursorPress takes an explicit progress value precisely so a frame-stepper
 * gets the same ripple pose every run. Use it when it is there. The shell's
 * cursor is the fallback for storybook and url pages, which know nothing about
 * pdv — running both would put two pointers on screen.
 *
 * The two drivers work in different coordinate spaces: the demo's cursor takes
 * coordinates inside the demo document, the shell's takes main-frame page
 * coordinates. `rect()` on each returns centres in its own space.
 */
function makeDriver({ page, demoFrame, hasRuntime, meta, viewport }) {
  const label = (text) => page.evaluate((t) => window.__pdvShell?.setLabel(t ?? ''), text ?? '');

  if (hasRuntime && demoFrame) {
    return {
      space: 'demo',
      home: { x: viewport[0] / 2, y: viewport[1] * 0.6 },
      label,
      centre: async (selector) => {
        const r = await demoFrame.evaluate((s) => window.__pdv.rect(s), selector);
        return r ? { x: r.cx, y: r.cy } : null;
      },
      setCursor: (x, y) => demoFrame.evaluate(([cx, cy]) => window.__pdv.cursor(cx, cy), [x, y]),
      hideCursor: () => demoFrame.evaluate(() => window.__pdv.hideCursor()),
      press: (progress) => demoFrame.evaluate((p) => window.__pdv.cursorPress(p), progress),
      highlight: (selector) => demoFrame.evaluate((s) => window.__pdv.highlight(s), selector),
      clearHighlight: () => demoFrame.evaluate(() => window.__pdv.clearHighlight()),
      // Not every change in a product is user-initiated. A call arriving, a
      // webhook landing, a sync completing — these have no button to click, and
      // without a way to drive them the demo can only show self-service flows.
      setState: (key, value) =>
        demoFrame.evaluate(([k, v]) => window.__pdv.setState(k, v), [key, value]),
      toast: (text) => demoFrame.evaluate((t) => window.__pdv.toast(t), text),
      goto: (screen) => demoFrame.evaluate((s) => window.__pdv.goto(s), screen),
    };
  }

  const shell = page;
  return {
    space: 'page',
    home: { x: meta.width / 2, y: meta.height * 0.62 },
    label,
    centre: async (selector, surface) => {
      const box = await resolveBox(surface, selector);
      return box ? boxCentre(box) : null;
    },
    setCursor: (x, y) => shell.evaluate(([cx, cy]) => window.__pdvShell?.setCursor(cx, cy, true), [x, y]),
    hideCursor: () => shell.evaluate(() => window.__pdvShell?.setCursor(-100, -100, false)),
    press: (progress) => shell.evaluate((p) => window.__pdvShell?.setPressed(p > 0 && p < 1), progress),
    highlight: async () => {},
    clearHighlight: async () => {},
    // A storybook story or a live page has no demo runtime to drive.
    setState: async () => {},
    toast: async () => {},
    goto: async () => {},
  };
}

/**
 * Record one scene frame by frame. No wall clock: each step's frame count comes
 * from planFlow, the cursor is eased one frame at a time, and the state change
 * lands on an exact frame index.
 *
 * Returns { frameCount, durationMs, resolvedTargets }.
 */
async function recordFlow(page, { flow, meta, framesDir, driver, log, debug, mask }) {
  const surface = page.frameLocator('#pdv-frame');
  const plan = planFlow(flow, meta.fps);
  const resolvedTargets = {};

  let cursor = { ...driver.home };
  let frameIndex = 0;

  for (const entry of plan.steps) {
    const { step, frames, actFrame, travelFrames } = entry;

    if (step.action === 'waitForSelector') {
      await surface.locator(step.selector).first().waitFor({ state: 'visible', timeout: 15000 });
      continue;
    }

    // Resolve in BOTH spaces: the driver's for the cursor, the main frame's for
    // the manifest, because motion.mjs zooms against the captured image.
    if (step.selector) {
      const box = await resolveBox(surface, step.selector);
      if (box) resolvedTargets[step.selector] = box;
      else log?.(`  selector did not resolve, cursor holds position: ${step.selector}`);
    }
    const dest = step.selector ? ((await driver.centre(step.selector, surface)) ?? cursor) : cursor;
    const from = { ...cursor };

    await driver.label(step.label);
    if (step.action === 'highlight' && step.selector) await driver.highlight(step.selector);

    for (let f = 0; f < frames; f += 1) {
      const travel = ease('easeInOutCubic', Math.min(1, (f + 1) / travelFrames));
      cursor = { x: from.x + (dest.x - from.x) * travel, y: from.y + (dest.y - from.y) * travel };
      await driver.setCursor(cursor.x, cursor.y);

      if (f === actFrame) await applyAction(surface, page, step, { driver, debug });

      // The press ripple is driven by explicit progress across the settle
      // frames, so frame N looks identical on every run.
      if (step.action === 'click' || step.action === 'fill') {
        if (f >= actFrame) {
          await driver.press(Math.min(1, (f - actFrame) / Math.max(1, frames - 1 - actFrame)));
        }
      }
      if (step.action === 'fill' && f > actFrame && step.value) {
        const typed = Math.min(
          step.value.length,
          Math.round(((f - actFrame) / Math.max(1, frames - 1 - actFrame)) * step.value.length),
        );
        await surface.locator(step.selector).first().fill(step.value.slice(0, typed));
      }
      if (step.action === 'scroll') {
        await surface.locator('body').first().evaluate((el, by) => {
          (el.ownerDocument.scrollingElement ?? el).scrollBy(0, by);
        }, Number(step.value ?? 600) / frames);
      }

      await shot(page, join(framesDir, `${pad6(frameIndex)}.png`), { mask });
      frameIndex += 1;
    }
    if (step.action === 'highlight') await driver.clearHighlight();
  }

  await driver.label('');
  return { frameCount: frameIndex, durationMs: plan.durationMs, resolvedTargets };
}

async function applyAction(surface, page, step, { driver, debug }) {
  const locator = step.selector ? surface.locator(step.selector).first() : null;
  switch (step.action) {
    case 'click':
      if (locator) await locator.click({ timeout: 10000, force: true });
      break;
    case 'hover':
      if (locator) await locator.hover({ timeout: 10000, force: true }).catch(() => {});
      break;
    case 'fill':
      if (locator) await locator.fill('');
      break;
    case 'press':
      if (locator) await locator.press(step.value ?? 'Enter');
      else await page.keyboard.press(step.value ?? 'Enter');
      break;
    case 'highlight':
      if (step.selector) await driver.highlight(step.selector);
      break;
    case 'setState':
      if (step.key !== undefined) await driver.setState(step.key, step.value ?? true);
      else debug?.('setState step has no key — ignored');
      break;
    case 'toast':
      if (step.value) await driver.toast(step.value);
      break;
    case 'goto':
      if (step.value) await driver.goto(step.value);
      break;
    default:
      debug?.(`no state change for action ${step.action}`);
  }
}

/** Credentials come from env var NAMES in the storyboard — never literals. */
function resolveStepValue(value, auth = {}) {
  if (typeof value !== 'string') return value;
  if (value === '{{username}}') return process.env[auth.usernameEnv] ?? '';
  if (value === '{{password}}') return process.env[auth.passwordEnv] ?? '';
  if (value.startsWith('env:')) return process.env[value.slice(4)] ?? '';
  return value;
}

/**
 * One manifest entry.
 *
 * `kind` is the GEOMETRY kind (still | frames | video), not the storyboard's
 * capture kind — that is what render.mjs switches on to build its ffmpeg input
 * args, and an entry it cannot classify is dropped from the video silently. The
 * storyboard's own kind is kept as `captureKind`.
 *
 * Paths are written twice: once under this stage's own names (framesDir,
 * stillPath, videoPath) and once under the aliases render.mjs looks for
 * (pattern, still, video). Absolute, so no consumer has to guess a base dir.
 *
 * width/height and every resolvedTargets box are in CAPTURED pixels — frame size
 * times CAPTURE_SCALE. motion.mjs zooms in that same space, so the two travel
 * together and neither has to know the other's scale.
 */
export function manifestEntry(captureKind, entry, meta) {
  const { geometryKind, stillPath, videoPath, framesDir, framePattern, ...rest } = entry;
  const out = {
    kind: geometryKind,
    captureKind,
    fps: meta.fps,
    width: meta.width * CAPTURE_SCALE,
    height: meta.height * CAPTURE_SCALE,
    scale: CAPTURE_SCALE,
    resolvedTargets: {},
    ...rest,
  };
  if (framesDir) {
    out.framesDir = framesDir;
    out.framePattern = framePattern;
    out.pattern = framePattern;
    out.startNumber = 0;
  }
  if (stillPath) {
    out.stillPath = stillPath;
    out.still = stillPath;
  }
  if (videoPath) {
    out.videoPath = videoPath;
    out.video = videoPath;
  }
  return out;
}

export async function run(ctx) {
  const storyboardPath = resolve(ctx.cwd, ctx.storyboard ?? 'storyboard.json');
  if (!(await exists(storyboardPath))) {
    throw new Error(`capture: no storyboard at ${storyboardPath} — pass --storyboard`);
  }
  const storyboard = await readJson(storyboardPath);
  const meta = normaliseMeta(storyboard.meta);

  const brandPath = ctx.brand
    ? resolve(ctx.cwd, ctx.brand)
    : meta.brandPath
      ? resolve(dirname(storyboardPath), meta.brandPath)
      : null;
  if (!brandPath) throw new Error('capture: no brand — pass --brand or set meta.brandPath');
  const { brand: rawBrand, tokens, warnings } = await resolveBrand(brandPath, { cwd: ctx.cwd });
  const brand = await embedBrandImages(rawBrand, { cwd: dirname(brandPath), log: ctx.log });
  for (const w of warnings) ctx.log(`  brand warning: ${w}`);
  const fontCss = await fontFaceCss(brand, { cwd: dirname(brandPath), log: ctx.log });

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const scenesRoot = await ensureDir(join(ctx.work, 'scenes'));
  const manifest = {};

  const browser = await chromium.launch({
    args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'],
  });

  try {
    for (const scene of storyboard.scenes) {
      const kind = scene.capture?.kind;
      const sceneDir = await ensureDir(join(scenesRoot, scene.id));
      ctx.log(`  ${scene.id} (${kind})`);
      const common = {
        browser, brand, tokens, meta, scene, sceneDir, fontCss, repoRoot, ctx,
      };
      let entry;
      switch (kind) {
        case 'html': entry = await captureHtml(common); break;
        case 'demo': entry = await captureDemo(common); break;
        case 'storybook': entry = await captureStorybook(common); break;
        case 'url': entry = await captureUrl(common); break;
        case 'asset': entry = await captureAsset(common); break;
        default: throw new Error(`scene ${scene.id}: unsupported capture kind "${kind}"`);
      }
      manifest[scene.id] = manifestEntry(kind, entry, meta);
    }
  } finally {
    await browser.close();
  }

  const manifestPath = join(ctx.work, 'capture-manifest.json');
  await writeJson(manifestPath, manifest);
  ctx.log(`capture: ${Object.keys(manifest).length} scene(s) -> ${manifestPath}`);
  return manifest;
}

async function newPage(browser, meta, extra = {}) {
  const context = await browser.newContext({
    viewport: { width: meta.width, height: meta.height },
    deviceScaleFactor: CAPTURE_SCALE,
    reducedMotion: 'reduce',
    colorScheme: 'no-preference',
    ...extra,
  });
  const page = await context.newPage();
  return { context, page };
}

/** Motion targets are resolved at capture time so render never guesses a box. */
async function resolveMotionTarget(scope, scene, into) {
  const target = scene.motion?.target;
  if (typeof target !== 'string') return;
  const box = await resolveBox(scope, target);
  if (box) into[target] = box;
}

/**
 * The scene templates declare their own contract at the top of
 * templates/scenes/_base.js: window.__DATA set BEFORE load, or __render(data)
 * after it, and readiness signalled by documentElement.dataset.ready — which is
 * what to wait on, never a timer. Motion is opt-in and stays off so a still
 * frame is deterministic.
 */
async function captureHtml({ browser, brand, tokens, meta, scene, sceneDir, fontCss, repoRoot, ctx }) {
  const template = scene.capture.template ?? `${scene.type ?? 'title'}.html`;
  const templatePath = join(repoRoot, 'templates', 'scenes', template);
  const { context, page } = await newPage(browser, meta);
  try {
    if (await exists(templatePath)) {
      await page.addInitScript(
        ([b, m, s, t]) => {
          window.__DATA = { brand: b, meta: m, scene: s, tokens: t };
        },
        [brand, meta, scene, tokens],
      );
      await page.goto(pathToFileURL(templatePath).href, { waitUntil: 'load' });
      // A template loaded before __DATA landed still renders through __render.
      await page.evaluate(
        async ([b, m, s, t]) => {
          if (!document.documentElement.dataset.ready && typeof window.__render === 'function') {
            await window.__render({ brand: b, meta: m, scene: s, tokens: t });
          }
        },
        [brand, meta, scene, tokens],
      );
      await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, {
        timeout: 15000,
      });
    } else {
      ctx.log(`  templates/scenes/${template} not found — using the built-in fallback scene`);
      await page.setContent(fallbackSceneHtml({ tokens, scene, meta }), { waitUntil: 'load' });
      await page.addStyleTag({ content: fontCss }).catch(() => {});
      await page.evaluate(() => document.fonts?.ready);
    }
    await page.addStyleTag({ content: DETERMINISM_CSS });
    const resolvedTargets = {};
    await resolveMotionTarget(page, scene, resolvedTargets);
    const stillPath = join(sceneDir, 'still.png');
    await shot(page, stillPath);
    return { stillPath, geometryKind: 'still', durationMs: scene.durationMs ?? null, resolvedTargets };
  } finally {
    await context.close();
  }
}

/**
 * Serve the shell and open it. The document root is the scene's own work dir —
 * never the project cwd, which would put the whole checkout on a listening port.
 */
async function withShell({ browser, brand, tokens, meta, scene, sceneDir, fontCss, targetUrl, viewport, chrome, contextExtra }) {
  const routes = {};
  const server = await serveDir(sceneDir, routes);
  routes['/__pdv/shell.html'] = {
    body: shellHtml({ tokens, brand, meta, targetUrl, viewport, chrome, fontCss }),
  };
  const { context, page } = await newPage(browser, meta, contextExtra);
  await page.goto(`${server.origin}/__pdv/shell.html`, { waitUntil: 'load' });
  return { server, context, page };
}

async function captureDemo({ browser, brand, tokens, meta, scene, sceneDir, fontCss, ctx }) {
  const appDir = resolve(ctx.work, 'demo', scene.capture.app);
  if (!(await exists(join(appDir, 'index.html')))) {
    throw new Error(
      `scene ${scene.id}: no demo app at ${appDir}/index.html — run \`pdv demo\` before capture`,
    );
  }
  const viewport = scene.capture.viewport ?? DEFAULT_DEMO_VIEWPORT;
  const chrome = scene.capture.chrome !== false;
  const routes = {};
  const server = await serveDir(appDir, routes);
  routes['/__pdv/shell.html'] = {
    body: shellHtml({ tokens, brand, meta, targetUrl: `${server.origin}/`, viewport, chrome, fontCss }),
  };
  const { context, page } = await newPage(browser, meta);
  try {
    await page.goto(`${server.origin}/__pdv/shell.html`, { waitUntil: 'load' });
    const demoFrame = page.frames().find((f) => f !== page.mainFrame());
    if (!demoFrame) throw new Error(`scene ${scene.id}: the demo iframe never loaded`);
    await demoFrame.waitForLoadState('load');
    const hasRuntime = await awaitDemoRuntime(demoFrame, ctx.log);
    await killTransitions(page);
    await page.evaluate(() => document.fonts?.ready);

    await rm(join(sceneDir, 'frames'), { recursive: true, force: true });
    const framesDir = await ensureDir(join(sceneDir, 'frames'));

    const flow = scene.capture.flow ?? [{ action: 'wait', ms: scene.durationMs ?? 2000 }];
    const driver = makeDriver({ page, demoFrame, hasRuntime, meta, viewport });
    ctx.debug(`cursor driver: ${driver.space}`);
    const result = await recordFlow(page, {
      flow, meta, framesDir, driver, log: ctx.log, debug: ctx.debug,
    });
    await resolveMotionTarget(page.frameLocator('#pdv-frame'), scene, result.resolvedTargets);
    return {
      framesDir,
      framePattern: join(framesDir, '%06d.png'),
      frameCount: result.frameCount,
      durationMs: result.durationMs,
      geometryKind: 'frames',
      resolvedTargets: result.resolvedTargets,
    };
  } finally {
    await context.close();
    await server.close();
  }
}

async function captureStorybook({ browser, brand, tokens, meta, scene, sceneDir, fontCss, ctx }) {
  const baseUrl = (scene.capture.baseUrl ?? 'http://localhost:6006').replace(/\/$/, '');
  const storyUrl = `${baseUrl}/iframe.html?id=${encodeURIComponent(scene.capture.storyId)}&viewMode=story`;
  const chrome = scene.capture.chrome !== false;
  const { server, context, page } = await withShell({
    browser, brand, tokens, meta, scene, sceneDir, fontCss,
    targetUrl: storyUrl, viewport: DEFAULT_DEMO_VIEWPORT, chrome,
  });
  try {
    const surface = page.frameLocator('#pdv-frame');
    await surface.locator('#storybook-root, #root, body').first().waitFor({ state: 'visible', timeout: 20000 });
    await killTransitions(page);
    const resolvedTargets = {};
    if (scene.capture.selector) {
      const box = await resolveBox(surface, scene.capture.selector);
      if (box) resolvedTargets[scene.capture.selector] = box;
      else ctx.log(`  storybook selector did not resolve: ${scene.capture.selector}`);
    }
    await resolveMotionTarget(surface, scene, resolvedTargets);
    const stillPath = join(sceneDir, 'still.png');
    await shot(page, stillPath);
    return { stillPath, geometryKind: 'still', durationMs: scene.durationMs ?? null, resolvedTargets };
  } finally {
    await context.close();
    await server.close();
  }
}

/**
 * PII treatment for live-product capture.
 *
 * Recording a real logged-in account puts real customer names, addresses, phone
 * numbers and invoice totals into a file that is about to be published. There is
 * no undo once a video ships, so this is DEFAULT-DENY: a `url` scene refuses to
 * capture until someone has looked at the screen and declared what to hide.
 *
 * Three treatments, applied before any pixel is captured:
 *   replace — swap the real string for a safe one. Best: the frame still reads
 *             naturally, and nothing sensitive was ever rasterised.
 *   blur    — CSS blur. Use for whole regions (a customer list) where replacing
 *             every field is impractical.
 *   mask    — solid boxes via Playwright's native mask. The bluntest and safest.
 *
 * Prefer a dedicated demo tenant over any of this. Masking is a net that catches
 * what you thought of; a demo tenant has nothing to catch.
 */
export async function applyPiiTreatment(surface, page, pii, { log } = {}) {
  if (!pii) return { maskLocators: [], applied: { replace: 0, blur: 0, mask: 0 } };

  const applied = { replace: 0, blur: 0, mask: 0 };

  for (const rule of pii.replace ?? []) {
    if (!rule.selector) continue;
    const n = await surface
      .locator(rule.selector)
      .evaluateAll((els, text) => {
        els.forEach((el) => {
          el.textContent = text;
        });
        return els.length;
      }, rule.text ?? '—')
      .catch(() => 0);
    applied.replace += n;
  }

  if (pii.blur?.length) {
    const css = `${pii.blur.join(', ')} { filter: blur(10px) !important; }`;
    await surface.locator('body').evaluate((body, styleText) => {
      const s = body.ownerDocument.createElement('style');
      s.textContent = styleText;
      body.ownerDocument.head.appendChild(s);
    }, css).catch(() => {});
    applied.blur = pii.blur.length;
  }

  // Playwright's mask paints over the element at screenshot time, so it cannot
  // be defeated by a late re-render the way a DOM edit can.
  const maskLocators = (pii.mask ?? []).map((sel) => surface.locator(sel));
  applied.mask = maskLocators.length;

  log?.(
    `  pii: replaced ${applied.replace} node(s), blurred ${applied.blur} selector(s), masking ${applied.mask} selector(s)`,
  );
  return { maskLocators, applied };
}

/** Refuse to record a live product until someone has signed off what is on screen. */
function assertPiiAcknowledged(scene) {
  const pii = scene.capture.pii;
  if (pii?.acknowledged === true) return pii;
  throw new Error(
    `scene "${scene.id}" captures a live URL but has no acknowledged PII declaration.\n\n` +
      `  Recording a logged-in product puts real customer data into a published file.\n` +
      `  Add to this scene's capture block:\n\n` +
      `    "pii": {\n` +
      `      "acknowledged": true,\n` +
      `      "replace": [{ "selector": ".customer-name", "text": "Jordan Blake" }],\n` +
      `      "blur":    [".invoice-total"],\n` +
      `      "mask":    [".contact-list"]\n` +
      `    }\n\n` +
      `  Safer still: point --url at a demo tenant with seeded data, and there is\n` +
      `  nothing to redact in the first place.`,
  );
}

async function captureUrl({ browser, brand, tokens, meta, scene, sceneDir, fontCss, ctx }) {
  const pii = assertPiiAcknowledged(scene);
  const auth = scene.capture.auth ?? {};
  const contextExtra = {};
  if (auth.storageStatePath) {
    const statePath = resolve(ctx.cwd, auth.storageStatePath);
    if (!(await exists(statePath))) {
      throw new Error(`scene ${scene.id}: storageStatePath not found: ${statePath}`);
    }
    contextExtra.storageState = statePath;
  }
  const record = scene.capture.record === true;
  if (record) contextExtra.recordVideo = { dir: sceneDir, size: { width: meta.width, height: meta.height } };

  const chrome = scene.capture.chrome !== false;
  const { server, context, page } = await withShell({
    browser, brand, tokens, meta, scene, sceneDir, fontCss,
    targetUrl: scene.capture.url, viewport: DEFAULT_DEMO_VIEWPORT, chrome, contextExtra,
  });
  try {
    const surface = page.frameLocator('#pdv-frame');
    await page.frames().find((f) => f !== page.mainFrame())?.waitForLoadState('load');
    await killTransitions(page);
    // Redact before anything is captured, and again after each step, because a
    // click can re-render the very node that was just sanitised.
    const { maskLocators } = await applyPiiTreatment(surface, page, pii, { log: ctx.log });
    const reapplyPii = () => applyPiiTreatment(surface, page, { ...pii, mask: [] });
    const resolvedTargets = {};

    if (record) {
      for (const step of scene.capture.steps ?? []) {
        await applyAction(surface, page, { ...step, value: resolveStepValue(step.value, auth) }, {
          setPressed: async () => {}, debug: ctx.debug,
        });
        await reapplyPii();
        if (step.ms) await page.waitForTimeout(step.ms);
        if (step.selector) {
          const box = await resolveBox(surface, step.selector);
          if (box) resolvedTargets[step.selector] = box;
        }
      }
      await resolveMotionTarget(surface, scene, resolvedTargets);
      const video = page.video();
      await context.close();
      const videoPath = await video.path();
      return { videoPath, geometryKind: 'video', durationMs: scene.durationMs ?? null, resolvedTargets };
    }

    const framesDir = await ensureDir(join(sceneDir, 'frames'));
    const flow = (scene.capture.steps ?? []).map((s) => ({ ...s, value: resolveStepValue(s.value, auth) }));
    if (flow.length) {
      const driver = makeDriver({ page, demoFrame: null, hasRuntime: false, meta, viewport: DEFAULT_DEMO_VIEWPORT });
      const result = await recordFlow(page, { flow, meta, framesDir, driver, log: ctx.log, debug: ctx.debug, mask: maskLocators });
      await resolveMotionTarget(surface, scene, result.resolvedTargets);
      return {
        framesDir,
        framePattern: join(framesDir, '%06d.png'),
        frameCount: result.frameCount,
        durationMs: result.durationMs,
        geometryKind: 'frames',
        resolvedTargets: result.resolvedTargets,
      };
    }
    await rm(framesDir, { recursive: true, force: true });
    await resolveMotionTarget(surface, scene, resolvedTargets);
    const stillPath = join(sceneDir, 'still.png');
    await shot(page, stillPath, { mask: maskLocators });
    return { stillPath, geometryKind: 'still', durationMs: scene.durationMs ?? null, resolvedTargets };
  } finally {
    // The recordVideo path closes the context itself to flush the file.
    await context.close().catch(() => {});
    await server.close();
  }
}

async function captureAsset({ scene, sceneDir, ctx }) {
  const src = resolve(ctx.cwd, scene.capture.path);
  if (!(await exists(src))) throw new Error(`scene ${scene.id}: asset not found: ${src}`);
  const ext = extname(src).toLowerCase();
  const dest = join(sceneDir, `source${ext}`);
  await copyFile(src, dest);
  if (IMAGE_EXT.has(ext)) {
    return { stillPath: dest, geometryKind: 'still', fit: scene.capture.fit ?? 'cover', durationMs: scene.durationMs ?? null };
  }
  if (VIDEO_EXT.has(ext)) {
    return { videoPath: dest, geometryKind: 'video', fit: scene.capture.fit ?? 'cover', durationMs: scene.durationMs ?? null };
  }
  throw new Error(`scene ${scene.id}: unsupported asset type ${ext}`);
}
