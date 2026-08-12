/**
 * demo — builds a self-contained interactive HTML reconstruction of a product
 * surface into work/demo/<app>/, for Chrome to be driven through and recorded.
 *
 * The build is a RECONSTRUCTION from repository facts, not production. Every
 * visible string is classified in PROVENANCE.json as either `evidence` (traced
 * to a feature-brief evidence id) or `sample` (invented neutral placeholder).
 *
 * The generated page exposes window.__pdv — see CONTROL_API below. Capture
 * turns transitions OFF and drives motion itself, so anything time-based in
 * the page must also accept an explicit progress value.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { ensureDir, exists, readJson, resolveBrandObject, slugify, writeJson } from './util.mjs';

export const CONTROL_API = [
  'ready',
  'goto',
  'setState',
  'highlight',
  'clearHighlight',
  'toast',
  'cursor',
  'cursorPress',
  'setTransitions',
];

const TEXT_KEYS = new Set([
  'label', 'text', 'title', 'subtitle', 'sub', 'body', 'placeholder', 'value',
  'meta', 'caption', 'hint', 'name', 'search', 'badge', 'description',
]);

/* The CSS format() keyword is not the extension — format('ttf') makes Chrome
   discard the src and fall back silently. */
const FONT_FORMATS = {
  '.woff2': { mime: 'font/woff2', format: 'woff2' },
  '.woff': { mime: 'font/woff', format: 'woff' },
  '.ttf': { mime: 'font/ttf', format: 'truetype' },
  '.otf': { mime: 'font/otf', format: 'opentype' },
};

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const attr = (name, value) => (value == null || value === '' ? '' : ` ${name}="${esc(value)}"`);

const jsonAttr = (name, value) =>
  value == null ? '' : ` ${name}="${esc(JSON.stringify(value))}"`;

const initialsOf = (name) =>
  String(name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

/* ------------------------------------------------------------------ icons */

const ICONS = {
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-5.7-5.7L11 8"/><path d="M14 10a4 4 0 0 0-6-.5l-2 2A4 4 0 0 0 11.7 17L13 16"/>',
  chart: '<path d="M5 19V10M12 19V5M19 19v-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  bell: '<path d="M18 15V10a6 6 0 1 0-12 0v5l-2 3h16z"/><path d="M10 21h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  inbox: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M5 5h14l2 8v6H3v-6z"/>',
};

function icon(name, cls = 'pdv-icon') {
  const glyph = ICONS[name] ?? '<rect x="5" y="5" width="14" height="14" rx="3"/>';
  return (
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`
  );
}

/* --------------------------------------------------------------- elements */

function commonAttrs(el) {
  return attr('id', el.id) + jsonAttr('data-when', el.when) + attr('data-src', el.source === 'evidence' ? 'evidence' : null);
}

function renderButton(el) {
  const variant = el.variant ?? 'primary';
  return (
    `<button class="pdv-btn pdv-btn--${esc(variant)}" type="button"` +
    commonAttrs(el) +
    jsonAttr('data-action', el.action) +
    `>${el.icon ? icon(el.icon, 'pdv-icon pdv-icon--btn') : ''}<span>${esc(el.label)}</span></button>`
  );
}

function renderField(el) {
  const type = el.inputType ?? 'text';
  const inner =
    type === 'select'
      ? `<div class="pdv-input pdv-input--select"><span>${esc(el.value ?? el.placeholder ?? '')}</span>` +
        `<svg viewBox="0 0 24 24" class="pdv-icon" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 10l5 5 5-5"/></svg></div>`
      : type === 'textarea'
        ? `<div class="pdv-input pdv-input--area">${esc(el.value ?? el.placeholder ?? '')}</div>`
        : `<div class="pdv-input${el.value ? '' : ' is-empty'}">${esc(el.value ?? el.placeholder ?? '')}</div>`;
  return (
    `<label class="pdv-field"${commonAttrs(el)}>` +
    `<span class="pdv-field__label">${esc(el.label)}</span>${inner}` +
    (el.hint ? `<span class="pdv-field__hint">${esc(el.hint)}</span>` : '') +
    `</label>`
  );
}

function renderToggle(el) {
  return (
    `<div class="pdv-toggle"${commonAttrs(el)}${attr('data-state-key', el.stateKey)}>` +
    `<button class="pdv-switch" type="button" role="switch"${attr('data-state-key', el.stateKey)}><span></span></button>` +
    `<div class="pdv-toggle__copy"><div class="pdv-toggle__label">${esc(el.label)}</div>` +
    (el.description ? `<div class="pdv-muted">${esc(el.description)}</div>` : '') +
    `</div></div>`
  );
}

function renderBadge(el) {
  return `<span class="pdv-badge pdv-badge--${esc(el.tone ?? 'neutral')}"${commonAttrs(el)}>${esc(el.label)}</span>`;
}

function renderTable(el) {
  const cols = el.columns ?? [];
  const head = cols
    .map((c) => `<th${attr('style', c.align ? `text-align:${c.align}` : null)}>${esc(c.label ?? c.key)}</th>`)
    .join('');
  const body = (el.rows ?? [])
    .map((row) => {
      const cells = cols
        .map((c) => {
          const raw = row[c.key];
          const cell =
            raw && typeof raw === 'object'
              ? raw.kind === 'badge'
                ? renderBadge(raw)
                : esc(raw.label ?? raw.text ?? '')
              : esc(raw);
          return `<td${attr('style', c.align ? `text-align:${c.align}` : null)}${attr('class', c.strong ? 'pdv-strong' : null)}>${cell}</td>`;
        })
        .join('');
      return `<tr${attr('id', row.id)}>${cells}</tr>`;
    })
    .join('');
  return (
    `<div class="pdv-card pdv-table-wrap"${commonAttrs(el)}>` +
    (el.caption ? `<div class="pdv-card__head"><span>${esc(el.caption)}</span></div>` : '') +
    `<table class="pdv-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  );
}

function renderCards(el) {
  const items = (el.items ?? [])
    .map(
      (it) =>
        `<div class="pdv-card pdv-card--tile"${attr('id', it.id)}>` +
        (it.icon ? `<div class="pdv-tile__icon">${icon(it.icon)}</div>` : '') +
        (it.badge ? `<span class="pdv-badge pdv-badge--${esc(it.badgeTone ?? 'neutral')}">${esc(it.badge)}</span>` : '') +
        `<div class="pdv-tile__title">${esc(it.title)}</div>` +
        (it.body ? `<div class="pdv-muted">${esc(it.body)}</div>` : '') +
        (it.meta ? `<div class="pdv-tile__meta">${esc(it.meta)}</div>` : '') +
        `</div>`,
    )
    .join('');
  return `<div class="pdv-grid" style="--pdv-cols:${Number(el.columns ?? 3)}"${commonAttrs(el)}>${items}</div>`;
}

function renderList(el) {
  const items = (el.items ?? [])
    .map(
      (it) =>
        `<li class="pdv-listitem"${attr('id', it.id)}>` +
        (it.avatar
          ? `<span class="pdv-avatar pdv-avatar--sm">${esc(it.initials ?? initialsOf(it.avatar))}</span>`
          : it.icon
            ? `<span class="pdv-listitem__icon">${icon(it.icon)}</span>`
            : '') +
        `<span class="pdv-listitem__body"><span class="pdv-listitem__title">${esc(it.title)}</span>` +
        (it.meta ? `<span class="pdv-muted">${esc(it.meta)}</span>` : '') +
        `</span>` +
        (it.badge ? `<span class="pdv-badge pdv-badge--${esc(it.badgeTone ?? 'neutral')}">${esc(it.badge)}</span>` : '') +
        `</li>`,
    )
    .join('');
  return (
    `<div class="pdv-card"${commonAttrs(el)}>` +
    (el.title ? `<div class="pdv-card__head"><span>${esc(el.title)}</span></div>` : '') +
    `<ul class="pdv-list">${items}</ul></div>`
  );
}

function renderAvatar(el) {
  return (
    `<div class="pdv-person"${commonAttrs(el)}>` +
    `<span class="pdv-avatar">${esc(el.initials ?? initialsOf(el.name))}</span>` +
    `<span class="pdv-person__body"><span class="pdv-person__name">${esc(el.name)}</span>` +
    (el.meta ? `<span class="pdv-muted">${esc(el.meta)}</span>` : '') +
    `</span></div>`
  );
}

function renderIcon(el) {
  return (
    `<div class="pdv-iconslot"${commonAttrs(el)}>${icon(el.name)}` +
    (el.label ? `<span class="pdv-muted">${esc(el.label)}</span>` : '') +
    `</div>`
  );
}

function renderEmpty(el) {
  return (
    `<div class="pdv-card pdv-empty"${commonAttrs(el)}>` +
    `<div class="pdv-empty__icon">${icon(el.icon ?? 'inbox')}</div>` +
    `<div class="pdv-empty__title">${esc(el.title)}</div>` +
    (el.body ? `<div class="pdv-muted">${esc(el.body)}</div>` : '') +
    (el.action ? renderButton({ ...el.action, kind: 'button' }) : '') +
    `</div>`
  );
}

function renderSkeleton(el) {
  const lines = Array.from({ length: Number(el.lines ?? 3) })
    .map((_, i) => `<div class="pdv-skel__line" style="width:${[100, 82, 64, 90, 74][i % 5]}%"></div>`)
    .join('');
  return `<div class="pdv-card pdv-skel"${commonAttrs(el)}>${lines}</div>`;
}

function renderRow(el) {
  return `<div class="pdv-row"${commonAttrs(el)}>${(el.items ?? []).map(renderElement).join('')}</div>`;
}

function renderHeading(el) {
  const level = Math.min(3, Math.max(1, Number(el.level ?? 2)));
  return (
    `<div class="pdv-heading pdv-heading--${level}"${commonAttrs(el)}>` +
    `<h${level}>${esc(el.text)}</h${level}>` +
    (el.sub ? `<p class="pdv-muted">${esc(el.sub)}</p>` : '') +
    `</div>`
  );
}

function renderElement(el) {
  if (!el || typeof el !== 'object') return '';
  switch (el.kind) {
    case 'heading': return renderHeading(el);
    case 'text': return `<p class="pdv-text${el.muted ? ' pdv-muted' : ''}"${commonAttrs(el)}>${esc(el.text)}</p>`;
    case 'button': return renderButton(el);
    case 'field': return renderField(el);
    case 'toggle': return renderToggle(el);
    case 'badge': return renderBadge(el);
    case 'table': return renderTable(el);
    case 'cards': return renderCards(el);
    case 'list': return renderList(el);
    case 'avatar': return renderAvatar(el);
    case 'icon': return renderIcon(el);
    case 'empty': return renderEmpty(el);
    case 'skeleton': return renderSkeleton(el);
    case 'row': return renderRow(el);
    case 'divider': return `<hr class="pdv-divider"${commonAttrs(el)}>`;
    // Pushes everything after it to the far edge of a row. Real product lists
    // align their trailing controls to one right edge; without this the buttons
    // sit wherever the description text happens to end and the column reads ragged.
    case 'spacer': return `<div class="pdv-spacer"${commonAttrs(el)}></div>`;
    default:
      throw new Error(`unknown demo element kind: ${el.kind}`);
  }
}

/* ----------------------------------------------------------------- shell */

function renderScreen(screen) {
  const cls = `pdv-screen pdv-screen--${esc(screen.layout ?? 'single')}`;
  return (
    `<section class="${cls}" data-screen="${esc(screen.id)}" hidden>` +
    (screen.title
      ? `<div class="pdv-screen__head"><h1>${esc(screen.title)}</h1>` +
        (screen.subtitle ? `<p class="pdv-muted">${esc(screen.subtitle)}</p>` : '') +
        `</div>`
      : '') +
    `<div class="pdv-screen__body">${(screen.elements ?? []).map(renderElement).join('')}</div>` +
    `</section>`
  );
}

function renderOverlay(ov) {
  const kind = ov.kind === 'drawer' ? 'drawer' : 'modal';
  const actions = (ov.actions ?? []).map((a) => renderButton({ ...a, kind: 'button' })).join('');
  return (
    `<div class="pdv-overlay pdv-overlay--${kind}" data-overlay="${esc(ov.id)}" hidden>` +
    `<div class="pdv-overlay__panel">` +
    `<div class="pdv-overlay__head"><div><h2>${esc(ov.title)}</h2>` +
    (ov.subtitle ? `<p class="pdv-muted">${esc(ov.subtitle)}</p>` : '') +
    `</div><button class="pdv-iconbtn" type="button" data-action='{"type":"closeOverlay"}' aria-label="Close">` +
    `<svg viewBox="0 0 24 24" class="pdv-icon" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>` +
    `<div class="pdv-overlay__body">${(ov.elements ?? []).map(renderElement).join('')}</div>` +
    (actions ? `<div class="pdv-overlay__foot">${actions}</div>` : '') +
    `</div></div>`
  );
}

function renderSidebar(spec, showDemoNotice) {
  const product = spec.product ?? {};
  const items = (spec.nav ?? [])
    .map(
      (n) =>
        `<button class="pdv-nav__item" type="button"${attr('id', n.id)} data-nav="${esc(n.screen)}"` +
        jsonAttr('data-when', n.when) +
        `>${icon(n.icon ?? 'list')}<span>${esc(n.label)}</span>` +
        (n.badge ? `<span class="pdv-pill">${esc(n.badge)}</span>` : '') +
        `</button>`,
    )
    .join('');
  return (
    `<aside class="pdv-sidebar">` +
    `<div class="pdv-brandmark"><span class="pdv-mark">${esc(product.mark ?? initialsOf(product.name))}</span>` +
    `<span class="pdv-brandmark__name">${esc(product.name ?? 'Product')}</span></div>` +
    `<nav class="pdv-nav">${items}</nav>` +
    `<div class="pdv-sidebar__foot">` +
    (showDemoNotice ? `<span class="pdv-demo-note">Demo build</span>` : '') +
    `</div></aside>`
  );
}

function renderTopbar(spec) {
  const top = spec.topbar ?? {};
  const actions = (top.actions ?? []).map((a) => renderButton({ ...a, kind: 'button' })).join('');
  const av = top.avatar;
  return (
    `<header class="pdv-topbar">` +
    (top.search
      ? `<div class="pdv-search">${icon('search')}<span>${esc(top.search)}</span></div>`
      : `<div class="pdv-search pdv-search--ghost"></div>`) +
    `<div class="pdv-topbar__actions">${actions}` +
    `<button class="pdv-iconbtn" type="button" aria-label="Notifications">${icon('bell')}</button>` +
    (av
      ? `<div class="pdv-person pdv-person--top"><span class="pdv-avatar">${esc(av.initials ?? initialsOf(av.name))}</span>` +
        `<span class="pdv-person__body"><span class="pdv-person__name">${esc(av.name)}</span>` +
        (av.meta ? `<span class="pdv-muted">${esc(av.meta)}</span>` : '') +
        `</span></div>`
      : '') +
    `</div></header>`
  );
}

export function renderHtml(spec, { fontFaces = '', showDemoNotice = true } = {}) {
  const title = `${spec.product?.name ?? 'Product'} — demo build`;
  return `<!doctype html>
<html lang="en" class="pdv-no-motion">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="pdv-demo-build" content="reconstruction from repository facts; not production">
<link rel="stylesheet" href="app.css">
${fontFaces ? `<style>${fontFaces}</style>` : ''}
</head>
<body>
<div class="pdv-app">
${renderSidebar(spec, showDemoNotice)}
<div class="pdv-main">
${renderTopbar(spec)}
<main class="pdv-content">
${(spec.screens ?? []).map(renderScreen).join('\n')}
</main>
</div>
</div>
<div class="pdv-scrim" hidden></div>
${(spec.overlays ?? []).map(renderOverlay).join('\n')}
<div class="pdv-toasts" aria-hidden="true"></div>
<div class="pdv-fx" aria-hidden="true">
  <div class="pdv-ring" hidden></div>
  <div class="pdv-cursor" hidden>
    <div class="pdv-ripple"></div>
    <svg viewBox="0 0 24 24" width="26" height="26">
      <path d="M5 2.5l13.2 8.1-5.6 1-2.6 5.3z" fill="#ffffff" stroke="#101010" stroke-width="1.1" stroke-linejoin="round"/>
    </svg>
  </div>
</div>
<script src="app.js"></script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------- css */

export function renderCss(tokens) {
  return `:root {
${Object.entries(tokens).map(([k, v]) => `  --pdv-${k}: ${v};`).join('\n')}
  --pdv-sidebar-w: 264px;
  --pdv-topbar-h: 68px;
  --pdv-gap: 20px;
}

*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
/* Author display rules outrank the UA [hidden] rule, so state-driven
   visibility needs this or every conditional element stays on screen. */
[hidden] { display: none !important; }
body {
  background: var(--pdv-color-background);
  color: var(--pdv-color-text);
  font-family: var(--pdv-font-body);
  font-weight: var(--pdv-weight-body);
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
h1, h2, h3 { font-family: var(--pdv-font-display); font-weight: var(--pdv-weight-display); letter-spacing: var(--pdv-tracking-display); margin: 0; }
p { margin: 0; }
button { font: inherit; color: inherit; }

/* Capture steps frames itself; every transition and animation must be
   switchable off or the recorder sees mid-flight states. */
.pdv-no-motion *, .pdv-no-motion *::before, .pdv-no-motion *::after {
  transition: none !important;
  animation: none !important;
}

.pdv-app { display: grid; grid-template-columns: var(--pdv-sidebar-w) 1fr; height: 100vh; }

.pdv-sidebar {
  display: flex; flex-direction: column; gap: 22px;
  padding: 22px 16px;
  background: var(--pdv-color-surface);
  border-right: 1px solid var(--pdv-color-border);
}
.pdv-brandmark { display: flex; align-items: center; gap: 11px; padding: 0 6px; }
.pdv-mark {
  width: 34px; height: 34px; border-radius: 10px;
  display: grid; place-items: center;
  background: linear-gradient(var(--pdv-color-gradient-angle), var(--pdv-color-gradient-from), var(--pdv-color-gradient-to));
  color: var(--pdv-color-on-primary);
  font-family: var(--pdv-font-display); font-weight: var(--pdv-weight-display); font-size: 16px;
}
.pdv-brandmark__name { font-family: var(--pdv-font-display); font-weight: var(--pdv-weight-display); font-size: 17px; letter-spacing: var(--pdv-tracking-display); }
.pdv-nav { display: flex; flex-direction: column; gap: 2px; }
.pdv-nav__item {
  display: flex; align-items: center; gap: 11px;
  padding: 10px 12px; border: 0; border-radius: var(--pdv-radius-button);
  background: transparent; color: var(--pdv-color-text-muted);
  text-align: left; cursor: pointer;
  transition: background var(--pdv-motion-transition-ms) ease, color var(--pdv-motion-transition-ms) ease;
}
.pdv-nav__item:hover { background: var(--pdv-color-surface-alt); }
.pdv-nav__item.is-active { background: var(--pdv-color-background); color: var(--pdv-color-text); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
.pdv-nav__item.is-active .pdv-icon { color: var(--pdv-color-primary); }
.pdv-pill {
  margin-left: auto; min-width: 22px; padding: 1px 7px; border-radius: 999px;
  background: var(--pdv-color-primary); color: var(--pdv-color-on-primary);
  font-size: 11px; font-weight: 600; text-align: center;
}
.pdv-sidebar__foot { margin-top: auto; }
.pdv-demo-note {
  display: inline-block; padding: 4px 9px; border-radius: 999px;
  border: 1px dashed var(--pdv-color-border);
  color: var(--pdv-color-text-muted); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase;
}

.pdv-main { display: flex; flex-direction: column; min-width: 0; }
.pdv-topbar {
  height: var(--pdv-topbar-h); flex: 0 0 auto;
  display: flex; align-items: center; gap: 16px;
  padding: 0 26px; border-bottom: 1px solid var(--pdv-color-border);
  background: var(--pdv-color-background);
}
.pdv-search {
  display: flex; align-items: center; gap: 9px;
  flex: 1 1 auto; max-width: 460px; height: 38px; padding: 0 13px;
  border: 1px solid var(--pdv-color-border); border-radius: var(--pdv-radius-button);
  background: var(--pdv-color-surface); color: var(--pdv-color-text-muted); font-size: 14px;
}
.pdv-search--ghost { visibility: hidden; }
.pdv-topbar__actions { margin-left: auto; display: flex; align-items: center; gap: 12px; }

.pdv-content { flex: 1 1 auto; overflow: hidden; padding: 26px; }
.pdv-screen { display: none; flex-direction: column; gap: var(--pdv-gap); height: 100%; }
.pdv-screen:not([hidden]) { display: flex; }
.pdv-screen__head { display: flex; flex-direction: column; gap: 4px; }
.pdv-screen__head h1 { font-size: 28px; }
.pdv-screen__body { display: flex; flex-direction: column; gap: var(--pdv-gap); min-height: 0; }
.pdv-screen--two-col .pdv-screen__body { display: grid; grid-template-columns: 1.4fr 1fr; align-items: start; }

/* Inline-sized elements are stretched by the flex-column stacks otherwise. */
.pdv-screen__body > .pdv-badge, .pdv-screen__body > .pdv-btn,
.pdv-screen__body > .pdv-person, .pdv-screen__body > .pdv-iconslot,
.pdv-overlay__body > .pdv-badge, .pdv-overlay__body > .pdv-btn,
.pdv-overlay__body > .pdv-person, .pdv-overlay__body > .pdv-iconslot { align-self: flex-start; }

.pdv-muted { color: var(--pdv-color-text-muted); }
.pdv-strong { font-weight: 600; }
.pdv-text { max-width: 68ch; }
.pdv-heading h1 { font-size: 26px; }
.pdv-heading h2 { font-size: 20px; }
.pdv-heading h3 { font-size: 16px; }
.pdv-heading p { margin-top: 3px; font-size: 14px; }
.pdv-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pdv-spacer { flex: 1 1 auto; }
.pdv-divider { border: 0; border-top: 1px solid var(--pdv-color-border); margin: 4px 0; }

.pdv-card {
  background: var(--pdv-color-background);
  border: 1px solid var(--pdv-color-border);
  border-radius: var(--pdv-radius-card);
  overflow: hidden;
}
.pdv-card__head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--pdv-color-border);
  font-weight: 600;
}
.pdv-grid { display: grid; grid-template-columns: repeat(var(--pdv-cols, 3), minmax(0, 1fr)); gap: var(--pdv-gap); }
.pdv-card--tile { padding: 18px; display: flex; flex-direction: column; gap: 7px; align-items: flex-start; background: var(--pdv-color-surface); }
.pdv-tile__icon { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: var(--pdv-color-background); border: 1px solid var(--pdv-color-border); color: var(--pdv-color-primary); }
.pdv-tile__title { font-family: var(--pdv-font-display); font-weight: var(--pdv-weight-display); font-size: 22px; letter-spacing: var(--pdv-tracking-display); }
.pdv-tile__meta { font-size: 13px; color: var(--pdv-color-text-muted); }

.pdv-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.pdv-table th {
  text-align: left; padding: 11px 18px; font-size: 12px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--pdv-color-text-muted); background: var(--pdv-color-surface);
  border-bottom: 1px solid var(--pdv-color-border);
}
.pdv-table td { padding: 13px 18px; border-bottom: 1px solid var(--pdv-color-border); }
.pdv-table tbody tr:last-child td { border-bottom: 0; }

.pdv-list { list-style: none; margin: 0; padding: 0; }
.pdv-listitem { display: flex; align-items: center; gap: 12px; padding: 13px 18px; border-bottom: 1px solid var(--pdv-color-border); }
.pdv-listitem:last-child { border-bottom: 0; }
.pdv-listitem__icon { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; background: var(--pdv-color-surface); color: var(--pdv-color-primary); }
.pdv-listitem__body { display: flex; flex-direction: column; min-width: 0; }
.pdv-listitem__title { font-weight: 600; }
.pdv-listitem .pdv-badge { margin-left: auto; }
.pdv-listitem .pdv-muted { font-size: 13px; }

.pdv-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
  border: 1px solid var(--pdv-color-border); background: var(--pdv-color-surface); color: var(--pdv-color-text-muted);
}
/* Tones mix against the brand background so a dark brand.json does not get
   light-theme status chips punched into it. */
.pdv-badge--success { background: color-mix(in srgb, var(--pdv-color-success) 14%, var(--pdv-color-background)); color: var(--pdv-color-success); border-color: color-mix(in srgb, var(--pdv-color-success) 34%, var(--pdv-color-background)); }
.pdv-badge--info { background: color-mix(in srgb, var(--pdv-color-primary) 12%, var(--pdv-color-background)); color: color-mix(in srgb, var(--pdv-color-primary) 78%, var(--pdv-color-text)); border-color: color-mix(in srgb, var(--pdv-color-primary) 32%, var(--pdv-color-background)); }
.pdv-badge--warning { background: color-mix(in srgb, var(--pdv-color-warning) 14%, var(--pdv-color-background)); color: var(--pdv-color-warning); border-color: color-mix(in srgb, var(--pdv-color-warning) 32%, var(--pdv-color-background)); }
.pdv-badge--danger { background: color-mix(in srgb, var(--pdv-color-danger) 14%, var(--pdv-color-background)); color: var(--pdv-color-danger); border-color: color-mix(in srgb, var(--pdv-color-danger) 32%, var(--pdv-color-background)); }

.pdv-btn {
  display: inline-flex; align-items: center; gap: 8px;
  height: 38px; padding: 0 16px; border-radius: var(--pdv-radius-button);
  border: 1px solid transparent; cursor: pointer; font-weight: 600; font-size: 14px;
  transition: filter var(--pdv-motion-transition-ms) ease, background var(--pdv-motion-transition-ms) ease;
}
.pdv-btn--primary { background: var(--pdv-color-primary); color: var(--pdv-color-on-primary); }
.pdv-btn--secondary { background: var(--pdv-color-surface); color: var(--pdv-color-text); border-color: var(--pdv-color-border); }
.pdv-btn--ghost { background: transparent; color: var(--pdv-color-primary); }
.pdv-btn--danger { background: var(--pdv-color-danger); color: var(--pdv-color-background); }
.pdv-btn:hover { filter: brightness(0.96); }
.pdv-iconbtn {
  width: 38px; height: 38px; border-radius: var(--pdv-radius-button);
  border: 1px solid var(--pdv-color-border); background: var(--pdv-color-background);
  color: var(--pdv-color-text-muted); display: grid; place-items: center; cursor: pointer;
}
.pdv-icon { width: 18px; height: 18px; flex: 0 0 auto; }
.pdv-icon--btn { width: 16px; height: 16px; }
.pdv-iconslot { display: inline-flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px dashed var(--pdv-color-border); border-radius: var(--pdv-radius-button); color: var(--pdv-color-text-muted); }

.pdv-field { display: flex; flex-direction: column; gap: 6px; max-width: 440px; }
.pdv-field__label { font-size: 13px; font-weight: 600; }
.pdv-field__hint { font-size: 12px; color: var(--pdv-color-text-muted); }
.pdv-input {
  min-height: 40px; padding: 9px 13px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  border: 1px solid var(--pdv-color-border); border-radius: var(--pdv-radius-button);
  background: var(--pdv-color-background); font-size: 14px;
}
.pdv-input.is-empty { color: var(--pdv-color-text-muted); }
.pdv-input--area { min-height: 92px; align-items: flex-start; }

.pdv-toggle { display: flex; align-items: flex-start; gap: 12px; }
.pdv-toggle__label { font-weight: 600; }
.pdv-switch {
  width: 42px; height: 24px; flex: 0 0 auto; margin-top: 2px; padding: 3px;
  border-radius: 999px; border: 1px solid var(--pdv-color-border);
  background: var(--pdv-color-surface-alt); cursor: pointer;
  display: flex; align-items: center;
  transition: background var(--pdv-motion-transition-ms) ease;
}
.pdv-switch span { width: 18px; height: 18px; border-radius: 50%; background: var(--pdv-color-background); box-shadow: 0 1px 2px rgba(0,0,0,0.25); transition: transform var(--pdv-motion-transition-ms) ease; }
.pdv-switch[aria-checked="true"] { background: var(--pdv-color-primary); border-color: var(--pdv-color-primary); }
.pdv-switch[aria-checked="true"] span { transform: translateX(18px); }

.pdv-avatar {
  width: 34px; height: 34px; flex: 0 0 auto; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--pdv-color-secondary); color: var(--pdv-color-on-primary);
  font-size: 13px; font-weight: 600;
}
.pdv-avatar--sm { width: 28px; height: 28px; font-size: 11px; }
.pdv-person { display: flex; align-items: center; gap: 10px; }
.pdv-person__body { display: flex; flex-direction: column; line-height: 1.25; }
.pdv-person__name { font-weight: 600; font-size: 14px; }
.pdv-person .pdv-muted { font-size: 12px; }

.pdv-empty { padding: 44px 24px; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; background: var(--pdv-color-surface); }
.pdv-empty__icon { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; background: var(--pdv-color-background); border: 1px solid var(--pdv-color-border); color: var(--pdv-color-text-muted); }
.pdv-empty__title { font-family: var(--pdv-font-display); font-weight: var(--pdv-weight-display); font-size: 18px; }

.pdv-skel { padding: 18px; display: flex; flex-direction: column; gap: 12px; }
.pdv-skel__line { height: 12px; border-radius: 6px; background: linear-gradient(90deg, var(--pdv-color-surface), var(--pdv-color-surface-alt), var(--pdv-color-surface)); background-size: 200% 100%; animation: pdv-shimmer 1.4s linear infinite; }
@keyframes pdv-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

.pdv-scrim { position: fixed; inset: 0; background: color-mix(in srgb, var(--pdv-color-text) 12%, rgba(6, 8, 14, 0.52)); z-index: 40; }
.pdv-overlay { position: fixed; inset: 0; z-index: 50; display: flex; }
.pdv-overlay--modal { align-items: center; justify-content: center; }
.pdv-overlay--modal .pdv-overlay__panel { width: min(560px, 90vw); border-radius: var(--pdv-radius-card); }
.pdv-overlay--drawer { justify-content: flex-end; }
.pdv-overlay--drawer .pdv-overlay__panel { width: min(460px, 92vw); height: 100%; border-radius: 0; border-right: 0; }
.pdv-overlay__panel {
  background: var(--pdv-color-background); border: 1px solid var(--pdv-color-border);
  box-shadow: var(--pdv-shadow-card); display: flex; flex-direction: column; max-height: 100%;
}
.pdv-overlay__head { display: flex; align-items: flex-start; gap: 16px; padding: 20px 22px; border-bottom: 1px solid var(--pdv-color-border); }
.pdv-overlay__head h2 { font-size: 19px; }
.pdv-overlay__head .pdv-iconbtn { margin-left: auto; }
.pdv-overlay__body { padding: 20px 22px; display: flex; flex-direction: column; gap: 16px; overflow: auto; }
.pdv-overlay__foot { padding: 16px 22px; border-top: 1px solid var(--pdv-color-border); display: flex; justify-content: flex-end; gap: 10px; }

.pdv-toasts { position: fixed; right: 24px; bottom: 24px; z-index: 60; display: flex; flex-direction: column; gap: 10px; align-items: flex-end; }
.pdv-toast {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-radius: var(--pdv-radius-button);
  background: var(--pdv-color-text); color: var(--pdv-color-background);
  box-shadow: var(--pdv-shadow-card); font-size: 14px; font-weight: 500;
}
.pdv-toast--success { background: var(--pdv-color-success); color: var(--pdv-color-background); }
.pdv-toast--danger { background: var(--pdv-color-danger); color: var(--pdv-color-background); }

.pdv-fx { position: fixed; inset: 0; z-index: 70; pointer-events: none; }
.pdv-ring {
  position: absolute; border-radius: calc(var(--pdv-radius-card) + 4px);
  border: 2px solid var(--pdv-color-primary);
  box-shadow: 0 0 0 6px color-mix(in srgb, var(--pdv-color-primary) 22%, transparent);
  transition: all var(--pdv-motion-transition-ms) cubic-bezier(0.4, 0, 0.2, 1);
}
.pdv-cursor { position: absolute; top: 0; left: 0; will-change: transform; filter: drop-shadow(0 3px 5px rgba(0,0,0,0.38)); }
.pdv-ripple {
  position: absolute; top: -18px; left: -18px; width: 36px; height: 36px; border-radius: 50%;
  background: color-mix(in srgb, var(--pdv-color-primary) 45%, transparent);
  transform: scale(var(--pdv-ripple-scale, 0)); opacity: var(--pdv-ripple-opacity, 0);
}
`;
}

/* -------------------------------------------------------------------- js */

/**
 * Written as concatenated strings, not template literals: this source is
 * itself emitted from a template literal and nested backticks are a trap.
 */
export function renderJs(spec) {
  const boot = {
    app: spec.id,
    initialState: spec.state ?? {},
    initialScreen: spec.initialScreen ?? spec.screens?.[0]?.id ?? null,
    toasts: spec.toasts ?? [],
    toastMs: Number(spec.toastMs ?? 2600),
  };
  return (
    '(function () {\n' +
    "  'use strict';\n" +
    '  var BOOT = ' + JSON.stringify(boot) + ';\n' +
    '  var root = document.documentElement;\n' +
    '  var state = Object.assign({}, BOOT.initialState);\n' +
    '  var currentScreen = null;\n' +
    '  var motionOn = false;\n' +
    '  var cursorAt = { x: 0, y: 0 };\n' +
    '  var readyResolve;\n' +
    '  var ready = new Promise(function (res) { readyResolve = res; });\n' +
    '\n' +
    '  function matches(cond) {\n' +
    '    if (!cond) return true;\n' +
    '    return Object.keys(cond).every(function (k) { return state[k] === cond[k]; });\n' +
    '  }\n' +
    '\n' +
    '  function applyConditions() {\n' +
    '    var nodes = document.querySelectorAll("[data-when]");\n' +
    '    for (var i = 0; i < nodes.length; i++) {\n' +
    '      var node = nodes[i];\n' +
    '      var cond = null;\n' +
    '      try { cond = JSON.parse(node.getAttribute("data-when")); } catch (e) { cond = null; }\n' +
    '      node.hidden = !matches(cond);\n' +
    '    }\n' +
    '    var switches = document.querySelectorAll(".pdv-switch[data-state-key]");\n' +
    '    for (var j = 0; j < switches.length; j++) {\n' +
    '      var key = switches[j].getAttribute("data-state-key");\n' +
    '      switches[j].setAttribute("aria-checked", state[key] ? "true" : "false");\n' +
    '    }\n' +
    '    root.setAttribute("data-pdv-state", JSON.stringify(state));\n' +
    '  }\n' +
    '\n' +
    '  function goto(screenId) {\n' +
    '    var screens = document.querySelectorAll("[data-screen]");\n' +
    '    var found = false;\n' +
    '    for (var i = 0; i < screens.length; i++) {\n' +
    '      var on = screens[i].getAttribute("data-screen") === screenId;\n' +
    '      screens[i].hidden = !on;\n' +
    '      if (on) found = true;\n' +
    '    }\n' +
    '    if (!found) throw new Error("no such screen: " + screenId);\n' +
    '    var navs = document.querySelectorAll("[data-nav]");\n' +
    '    for (var j = 0; j < navs.length; j++) {\n' +
    '      navs[j].classList.toggle("is-active", navs[j].getAttribute("data-nav") === screenId);\n' +
    '    }\n' +
    '    currentScreen = screenId;\n' +
    '    root.setAttribute("data-pdv-screen", screenId);\n' +
    '    return screenId;\n' +
    '  }\n' +
    '\n' +
    '  function setState(key, value) {\n' +
    '    state[key] = value;\n' +
    '    applyConditions();\n' +
    '    return state[key];\n' +
    '  }\n' +
    '\n' +
    '  var ring = document.querySelector(".pdv-ring");\n' +
    '  function highlight(selector, pad) {\n' +
    '    var el = typeof selector === "string" ? document.querySelector(selector) : selector;\n' +
    '    if (!el) throw new Error("highlight: no element for " + selector);\n' +
    '    var p = typeof pad === "number" ? pad : 8;\n' +
    '    var r = el.getBoundingClientRect();\n' +
    '    ring.style.left = (r.left - p) + "px";\n' +
    '    ring.style.top = (r.top - p) + "px";\n' +
    '    ring.style.width = (r.width + p * 2) + "px";\n' +
    '    ring.style.height = (r.height + p * 2) + "px";\n' +
    '    ring.hidden = false;\n' +
    '    return { x: r.left, y: r.top, width: r.width, height: r.height };\n' +
    '  }\n' +
    '  function clearHighlight() { ring.hidden = true; }\n' +
    '\n' +
    '  var toastLayer = document.querySelector(".pdv-toasts");\n' +
    '  function toast(text, tone) {\n' +
    '    var preset = null;\n' +
    '    for (var i = 0; i < BOOT.toasts.length; i++) {\n' +
    '      if (BOOT.toasts[i].id === text) preset = BOOT.toasts[i];\n' +
    '    }\n' +
    '    var body = preset ? preset.text : text;\n' +
    '    var kind = tone || (preset && preset.tone) || "neutral";\n' +
    '    var node = document.createElement("div");\n' +
    '    node.className = "pdv-toast pdv-toast--" + kind;\n' +
    '    node.textContent = body;\n' +
    '    toastLayer.appendChild(node);\n' +
    '    if (motionOn) window.setTimeout(function () { node.remove(); }, BOOT.toastMs);\n' +
    '    return node;\n' +
    '  }\n' +
    '  function clearToasts() { toastLayer.innerHTML = ""; }\n' +
    '\n' +
    '  var cursorEl = document.querySelector(".pdv-cursor");\n' +
    '  function cursor(x, y) {\n' +
    '    cursorAt = { x: x, y: y };\n' +
    '    cursorEl.hidden = false;\n' +
    '    cursorEl.style.transform = "translate(" + x + "px, " + y + "px)";\n' +
    '    return cursorAt;\n' +
    '  }\n' +
    '  function hideCursor() { cursorEl.hidden = true; }\n' +
    '\n' +
    '  /* progress is explicit so a frame-stepping recorder gets the same ripple\n' +
    '     pose every run; with motion on and no argument it self-animates. */\n' +
    '  function cursorPress(progress) {\n' +
    '    if (typeof progress === "number") {\n' +
    '      var p = Math.max(0, Math.min(1, progress));\n' +
    '      cursorEl.style.setProperty("--pdv-ripple-scale", String(0.2 + p * 1.1));\n' +
    '      cursorEl.style.setProperty("--pdv-ripple-opacity", String(1 - p));\n' +
    '      return p;\n' +
    '    }\n' +
    '    var start = performance.now();\n' +
    '    var dur = 420;\n' +
    '    (function step(now) {\n' +
    '      var t = Math.min(1, (now - start) / dur);\n' +
    '      cursorEl.style.setProperty("--pdv-ripple-scale", String(0.2 + t * 1.1));\n' +
    '      cursorEl.style.setProperty("--pdv-ripple-opacity", String(1 - t));\n' +
    '      if (t < 1) requestAnimationFrame(step);\n' +
    '    })(start);\n' +
    '    return 1;\n' +
    '  }\n' +
    '\n' +
    '  function setTransitions(on) {\n' +
    '    motionOn = !!on;\n' +
    '    root.classList.toggle("pdv-no-motion", !motionOn);\n' +
    '    return motionOn;\n' +
    '  }\n' +
    '\n' +
    '  function openOverlay(id) {\n' +
    '    var all = document.querySelectorAll("[data-overlay]");\n' +
    '    var found = false;\n' +
    '    for (var i = 0; i < all.length; i++) {\n' +
    '      var on = all[i].getAttribute("data-overlay") === id;\n' +
    '      all[i].hidden = !on;\n' +
    '      if (on) found = true;\n' +
    '    }\n' +
    '    if (!found) throw new Error("no such overlay: " + id);\n' +
    '    document.querySelector(".pdv-scrim").hidden = false;\n' +
    '    return id;\n' +
    '  }\n' +
    '  function closeOverlay() {\n' +
    '    var all = document.querySelectorAll("[data-overlay]");\n' +
    '    for (var i = 0; i < all.length; i++) all[i].hidden = true;\n' +
    '    document.querySelector(".pdv-scrim").hidden = true;\n' +
    '  }\n' +
    '\n' +
    '  function runAction(spec) {\n' +
    '    if (!spec) return;\n' +
    '    var list = Array.isArray(spec) ? spec : [spec];\n' +
    '    for (var i = 0; i < list.length; i++) {\n' +
    '      var a = list[i];\n' +
    '      if (a.type === "goto") goto(a.screen);\n' +
    '      else if (a.type === "setState") setState(a.key, a.value);\n' +
    '      else if (a.type === "toast") toast(a.toast || a.text, a.tone);\n' +
    '      else if (a.type === "openOverlay") openOverlay(a.overlay);\n' +
    '      else if (a.type === "closeOverlay") closeOverlay();\n' +
    '    }\n' +
    '  }\n' +
    '\n' +
    '  document.addEventListener("click", function (ev) {\n' +
    '    var nav = ev.target.closest ? ev.target.closest("[data-nav]") : null;\n' +
    '    if (nav) { goto(nav.getAttribute("data-nav")); return; }\n' +
    '    var sw = ev.target.closest ? ev.target.closest(".pdv-switch[data-state-key]") : null;\n' +
    '    if (sw) { var k = sw.getAttribute("data-state-key"); setState(k, !state[k]); return; }\n' +
    '    var act = ev.target.closest ? ev.target.closest("[data-action]") : null;\n' +
    '    if (act) {\n' +
    '      try { runAction(JSON.parse(act.getAttribute("data-action"))); } catch (e) { /* malformed action */ }\n' +
    '    }\n' +
    '  });\n' +
    '\n' +
    '  window.__pdv = {\n' +
    '    app: BOOT.app,\n' +
    '    ready: ready,\n' +
    '    goto: goto,\n' +
    '    setState: setState,\n' +
    '    highlight: highlight,\n' +
    '    clearHighlight: clearHighlight,\n' +
    '    toast: toast,\n' +
    '    clearToasts: clearToasts,\n' +
    '    cursor: cursor,\n' +
    '    hideCursor: hideCursor,\n' +
    '    cursorPress: cursorPress,\n' +
    '    setTransitions: setTransitions,\n' +
    '    openOverlay: openOverlay,\n' +
    '    closeOverlay: closeOverlay,\n' +
    '    screen: function () { return currentScreen; },\n' +
    '    state: function () { return Object.assign({}, state); },\n' +
    '    rect: function (sel) {\n' +
    '      var el = document.querySelector(sel);\n' +
    '      if (!el) return null;\n' +
    '      var r = el.getBoundingClientRect();\n' +
    '      return { x: r.left, y: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };\n' +
    '    }\n' +
    '  };\n' +
    '\n' +
    '  applyConditions();\n' +
    '  if (BOOT.initialScreen) goto(BOOT.initialScreen);\n' +
    '  setTransitions(false);\n' +
    '\n' +
    '  var fonts = document.fonts ? document.fonts.ready : Promise.resolve();\n' +
    '  fonts.then(function () {\n' +
    '    requestAnimationFrame(function () {\n' +
    '      requestAnimationFrame(function () {\n' +
    '        root.setAttribute("data-pdv-ready", "1");\n' +
    '        readyResolve(true);\n' +
    '      });\n' +
    '    });\n' +
    '  });\n' +
    '})();\n'
  );
}

/* ----------------------------------------------------------- provenance */

/**
 * Classify every visible string. `source: "evidence"` on a node (with an
 * evidenceRef) marks that node and its children as traced to the repo; anything
 * else is invented sample data and is labelled as such.
 */
export function collectProvenance(spec) {
  const fields = [];
  const walk = (node, path, inherited) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`, inherited));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const own =
      node.source === 'evidence'
        ? { origin: 'evidence', evidenceRef: node.evidenceRef ?? inherited.evidenceRef ?? null }
        : node.source === 'sample'
          ? { origin: 'sample', evidenceRef: null }
          : inherited;
    for (const [key, value] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (typeof value === 'string' && TEXT_KEYS.has(key)) {
        fields.push({
          path: childPath,
          value,
          origin: own.origin,
          evidenceRef: own.evidenceRef ?? null,
        });
      } else if (value && typeof value === 'object') {
        walk(value, childPath, own);
      }
    }
  };
  walk(spec, '', { origin: 'sample', evidenceRef: null });

  const evidence = fields.filter((f) => f.origin === 'evidence');
  return {
    notice:
      'This demo app is a reconstruction assembled from repository facts and neutral sample data. ' +
      'It is not a screen capture of a production system. Fields marked "sample" are invented ' +
      'placeholders and carry no real customer, account or performance information.',
    counts: { total: fields.length, evidence: evidence.length, sample: fields.length - evidence.length },
    fields,
  };
}

/* ---------------------------------------------------------------- build */

async function embedFonts(brand, { baseDir }) {
  const faces = [];
  const embedded = [];
  const missing = [];
  const roles = [
    ['display', brand.type?.display],
    ['body', brand.type?.body],
  ];
  for (const [role, face] of roles) {
    for (const file of face?.fontFiles ?? []) {
      const path = isAbsolute(file.path) ? file.path : resolve(baseDir, file.path);
      if (!(await exists(path))) {
        missing.push(file.path);
        continue;
      }
      const ext = extname(path).toLowerCase();
      const spec = FONT_FORMATS[ext];
      if (!spec) {
        missing.push(`${file.path} (unsupported ${ext})`);
        continue;
      }
      const b64 = (await readFile(path)).toString('base64');
      faces.push(
        `@font-face{font-family:'${face.family}';font-style:${file.style ?? 'normal'};` +
          `font-weight:${file.weight ?? face.weight ?? 400};font-display:block;` +
          `src:url(data:${spec.mime};base64,${b64}) format('${spec.format}');}`,
      );
      embedded.push({ role, family: face.family, file: basename(path), bytes: b64.length });
    }
  }
  return { css: faces.join('\n'), embedded, missing };
}

function validateSpec(spec, source) {
  if (!spec || typeof spec !== 'object') throw new Error(`${source}: demo spec is not an object`);
  if (!Array.isArray(spec.screens) || spec.screens.length === 0) {
    throw new Error(`${source}: demo spec needs at least one screen`);
  }
  const ids = new Set();
  for (const screen of spec.screens) {
    if (!screen.id) throw new Error(`${source}: every screen needs an id`);
    if (ids.has(screen.id)) throw new Error(`${source}: duplicate screen id ${screen.id}`);
    ids.add(screen.id);
  }
  for (const nav of spec.nav ?? []) {
    if (nav.screen && !ids.has(nav.screen)) {
      throw new Error(`${source}: nav item "${nav.label}" points at unknown screen ${nav.screen}`);
    }
  }
  if (spec.initialScreen && !ids.has(spec.initialScreen)) {
    throw new Error(`${source}: initialScreen ${spec.initialScreen} is not a screen`);
  }
}

/**
 * Build one demo app. `spec` is a path or an already-parsed object; `brand` is
 * a raw brand.json object (defaults are applied here).
 */
export async function buildFromSpec(spec, outDir, brand, opts = {}) {
  const specPath = typeof spec === 'string' ? resolve(opts.cwd ?? process.cwd(), spec) : null;
  const parsed = specPath ? await readJson(specPath) : structuredClone(spec);
  const source = specPath ?? '(inline spec)';
  validateSpec(parsed, source);

  const resolved = resolveBrandObject(brand, { source: opts.brandSource ?? '(brand object)' });
  const dir = resolve(opts.cwd ?? process.cwd(), outDir);
  await ensureDir(dir);

  /* brand.schema calls font paths "absolute or project-relative", so they
     resolve from the brand file's directory, never from the spec's. */
  const fonts = await embedFonts(resolved.brand, {
    baseDir: opts.brandDir ?? opts.cwd ?? process.cwd(),
  });

  const showDemoNotice = resolved.brand.legal?.demoFootageNotice !== false;
  const html = renderHtml(parsed, { fontFaces: fonts.css, showDemoNotice });
  const css = renderCss(resolved.tokens);
  const js = renderJs(parsed);

  await writeFile(join(dir, 'index.html'), html, 'utf8');
  await writeFile(join(dir, 'app.css'), css, 'utf8');
  await writeFile(join(dir, 'app.js'), js, 'utf8');

  const provenance = collectProvenance(parsed);
  await writeJson(join(dir, 'PROVENANCE.json'), {
    generatedAt: new Date().toISOString(),
    app: parsed.id ?? slugify(parsed.product?.name ?? basename(dir)),
    specSource: specPath ? basename(specPath) : 'inline',
    brand: resolved.brand.name,
    fonts: {
      embedded: fonts.embedded,
      missing: fonts.missing,
      fallbackStackUsed: fonts.embedded.length === 0,
    },
    brandDefaultsApplied: resolved.applied,
    brandWarnings: resolved.warnings,
    ...provenance,
  });

  return {
    dir,
    app: parsed.id ?? slugify(parsed.product?.name ?? basename(dir)),
    files: ['index.html', 'app.css', 'app.js', 'PROVENANCE.json'].map((f) => join(dir, f)),
    provenance,
    fonts,
    brandWarnings: resolved.warnings,
  };
}

function inlineSpecOf(scene) {
  const content = scene.content ?? {};
  if (content.demoSpec) return content.demoSpec;
  if (content.spec && typeof content.spec === 'object') return content.spec;
  if (Array.isArray(content.screens)) return content;
  return null;
}

export async function run(ctx) {
  if (!ctx.storyboard) throw new Error('demo: --storyboard <path> is required');
  const storyboardPath = resolve(ctx.cwd, ctx.storyboard);
  const storyboard = await readJson(storyboardPath);
  const sbDir = dirname(storyboardPath);

  const brandPath = resolve(
    sbDir,
    ctx.brand ?? storyboard.meta?.brandPath ?? 'brand.json',
  );
  if (!(await exists(brandPath))) {
    throw new Error(`demo: brand not found at ${brandPath} (set meta.brandPath or pass --brand)`);
  }
  const brand = await readJson(brandPath);

  const scenes = (storyboard.scenes ?? []).filter((s) => s.capture?.kind === 'demo');
  if (scenes.length === 0) {
    ctx.log('demo: no scenes with capture.kind "demo" — nothing to build');
    return { apps: [] };
  }

  const byApp = new Map();
  for (const scene of scenes) {
    const app = scene.capture.app;
    if (!app) throw new Error(`demo: scene ${scene.id} has capture.kind "demo" with no app id`);
    const specRef = scene.capture.spec ? resolve(sbDir, scene.capture.spec) : inlineSpecOf(scene);
    if (!specRef) {
      throw new Error(
        `demo: scene ${scene.id} has no capture.spec path and no inline spec on scene.content`,
      );
    }
    const entry = byApp.get(app);
    if (!entry) {
      byApp.set(app, { app, specRef, scenes: [scene.id], viewport: scene.capture.viewport ?? [1600, 900] });
      continue;
    }
    const same = typeof specRef === 'string' && typeof entry.specRef === 'string'
      ? specRef === entry.specRef
      : JSON.stringify(specRef) === JSON.stringify(entry.specRef);
    if (!same) {
      throw new Error(`demo: app "${app}" is referenced by two scenes with different specs`);
    }
    entry.scenes.push(scene.id);
  }

  const apps = [];
  for (const entry of byApp.values()) {
    const outDir = join(ctx.work, 'demo', entry.app);
    const built = await buildFromSpec(entry.specRef, outDir, brand, {
      cwd: ctx.cwd,
      brandDir: dirname(brandPath),
      brandSource: brandPath,
    });
    for (const w of built.brandWarnings) ctx.log(`demo: brand warning — ${w}`);
    ctx.log(
      `demo: built ${entry.app} -> ${built.dir} ` +
        `(${built.provenance.counts.evidence} evidence / ${built.provenance.counts.sample} sample fields)`,
    );
    apps.push({
      app: entry.app,
      dir: built.dir,
      entry: join(built.dir, 'index.html'),
      scenes: entry.scenes,
      viewport: entry.viewport,
    });
  }

  const manifestPath = join(ctx.work, 'demo', 'manifest.json');
  await writeJson(manifestPath, { generatedAt: new Date().toISOString(), apps });
  ctx.log(`demo: ${apps.length} app(s) -> ${manifestPath}`);
  return { apps, manifest: manifestPath };
}
