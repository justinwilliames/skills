/*
 * Scene runtime.
 *
 * CONTRACT WITH capture.mjs
 * -------------------------
 *   window.__DATA = { brand, scene, meta, tokens? }   set before load
 *                                                     (page.addInitScript)
 *   window.__render(data)                             or set it after load
 *   document.documentElement.dataset.ready === 'true' when fonts have settled
 *                                                     and layout is final —
 *                                                     wait on this, not a timer
 *   document.documentElement.dataset.motion = 'on'    opt in to reveal motion;
 *                                                     off by default so a still
 *                                                     frame is deterministic
 *   window.PDV.probeContrast()                        [{role, fg, rect, ...}]
 *   document.documentElement.dataset.probe = 'bg'     hide ink, keep layout
 *
 * `brand` is the schema shape (schemas/brand.schema.json), raw or already
 * resolved by util.mjs — both work. `tokens` is the flat map from
 * resolveBrandObject(); when present it wins, so Node stays the authority on
 * derived colours.
 *
 * Loaded as a classic script on purpose: a type="module" script is blocked by
 * CORS on file:// URLs, and these templates must render from disk.
 *
 * The colour maths below is duplicated from scripts/lib/util.mjs. It cannot be
 * imported — util.mjs pulls in node:child_process. Keep the two in step.
 */
(function () {
  'use strict';

  var SYSTEM_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  var SYSTEM_MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
  var MIN_CONTRAST = 4.5;

  /* ── colour ──────────────────────────────────────────────────────────── */

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    var h = m[1].length === 3 ? m[1].split('').map(function (c) { return c + c; }).join('') : m[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function rgbToHex(c) {
    var clamp = function (n) { return Math.max(0, Math.min(255, Math.round(n))); };
    return '#' + [c.r, c.g, c.b].map(function (n) {
      return clamp(n).toString(16).padStart(2, '0');
    }).join('');
  }

  function rgba(hex, alpha) {
    var c = hexToRgb(hex);
    if (!c) return 'transparent';
    return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + alpha + ')';
  }

  function mixHex(a, b, t) {
    var x = hexToRgb(a);
    var y = hexToRgb(b);
    if (!x || !y) return a;
    return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
  }

  function relativeLuminance(hex) {
    var c = hexToRgb(hex);
    if (!c) return 0;
    var channel = function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }

  function contrastRatio(a, b) {
    var la = relativeLuminance(a);
    var lb = relativeLuminance(b);
    var hi = Math.max(la, lb);
    var lo = Math.min(la, lb);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  }

  /** Computed-style colour string -> {r,g,b,a}. */
  function parseCssColor(value) {
    var m = /^rgba?\(([^)]+)\)$/i.exec(String(value).trim());
    if (!m) return null;
    var parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    if (parts.length < 3 || parts.some(isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function over(fg, alpha, bgHex) {
    var f = typeof fg === 'string' ? hexToRgb(fg) : fg;
    var b = hexToRgb(bgHex);
    if (!f || !b) return bgHex;
    return rgbToHex({
      r: f.r * alpha + b.r * (1 - alpha),
      g: f.g * alpha + b.g * (1 - alpha),
      b: f.b * alpha + b.b * (1 - alpha),
    });
  }

  /* ── brand -> tokens ─────────────────────────────────────────────────── */

  function fontFamilyCss(family, fallback) {
    if (!family) return fallback;
    var quoted = /[^a-zA-Z0-9-]/.test(family) ? "'" + family + "'" : family;
    return quoted + ', ' + fallback;
  }

  /**
   * Derive the same token map util.mjs writes, from a raw brand object. Used
   * only when the caller did not supply `tokens`.
   */
  function deriveTokens(brand) {
    var c = (brand && brand.color) || {};
    var t = (brand && brand.type) || {};
    var display = t.display || {};
    var body = t.body || {};
    var mono = t.mono || {};
    var shape = brand.shape || {};
    var motion = brand.motion || {};

    var background = c.background || '#ffffff';
    var text = c.text || '#101828';
    var primary = c.primary || '#2f5bea';
    var secondary = c.secondary || primary;
    var accent = c.accent || secondary;
    var gradient = c.gradient || {};

    var onPrimary = contrastRatio('#ffffff', primary) >= contrastRatio('#000000', primary) ? '#ffffff' : '#000000';
    var surface = c.surface || mixHex(background, text, 0.04);

    return {
      'brand-name': brand.name || '',
      'color-primary': primary,
      'color-on-primary': onPrimary,
      'color-secondary': secondary,
      'color-accent': accent,
      'color-background': background,
      'color-surface': surface,
      'color-surface-alt': mixHex(surface, text, 0.04),
      'color-text': text,
      'color-text-muted': c.textMuted || mixHex(text, background, 0.42),
      'color-border': c.border || mixHex(text, background, 0.86),
      'color-gradient-from': gradient.from || primary,
      'color-gradient-to': gradient.to || accent,
      'color-gradient-angle': (gradient.angleDeg == null ? 135 : gradient.angleDeg) + 'deg',
      'font-display': fontFamilyCss(display.family, display.fallbackStack || SYSTEM_SANS),
      'font-body': fontFamilyCss(body.family || display.family, body.fallbackStack || SYSTEM_SANS),
      'font-mono': fontFamilyCss(mono.family, mono.fallbackStack || SYSTEM_MONO),
      'weight-display': String(display.weight == null ? 700 : display.weight),
      'weight-body': String(body.weight == null ? 400 : body.weight),
      'tracking-display': (display.letterSpacingEm == null ? -0.02 : display.letterSpacingEm) + 'em',
      'radius-button': (shape.radiusButtonPx == null ? 8 : shape.radiusButtonPx) + 'px',
      'radius-card': (shape.radiusCardPx == null ? 12 : shape.radiusCardPx) + 'px',
      'shadow-card': shape.shadow || '0 24px 64px rgba(0,0,0,0.18)',
      'motion-transition-ms': (motion.transitionMs == null ? 600 : motion.transitionMs) + 'ms',
      'motion-easing': motion.easing || 'easeInOutCubic',
      scheme: relativeLuminance(background) < 0.4 ? 'dark' : 'light',
    };
  }

  /* ── fonts ───────────────────────────────────────────────────────────── */

  function fontUrl(path, baseDir) {
    var p = String(path);
    if (/^(https?:|file:|data:)/i.test(p)) return p;
    if (p.charAt(0) === '/') return 'file://' + p;
    if (baseDir) return 'file://' + String(baseDir).replace(/\/+$/, '') + '/' + p;
    return p;
  }

  /**
   * Self-hosted faces only. The renderer is offline: a CDN URL will not load,
   * and the template must still look deliberate when that happens, which is
   * what the fallback stack is for.
   */
  function injectFonts(brand, baseDir) {
    var t = (brand && brand.type) || {};
    var rules = [];
    ['display', 'body', 'mono'].forEach(function (slot) {
      var spec = t[slot];
      if (!spec || !spec.family || !Array.isArray(spec.fontFiles)) return;
      spec.fontFiles.forEach(function (file) {
        if (!file || !file.path) return;
        var url = fontUrl(file.path, baseDir);
        var format = /\.woff2$/i.test(url) ? 'woff2' : /\.woff$/i.test(url) ? 'woff' : /\.otf$/i.test(url) ? 'opentype' : 'truetype';
        rules.push(
          '@font-face{font-family:"' + spec.family + '";' +
          'src:url("' + url + '") format("' + format + '");' +
          'font-weight:' + (file.weight || spec.weight || 400) + ';' +
          'font-style:' + (file.style || 'normal') + ';' +
          'font-display:block;}'
        );
      });
    });
    if (!rules.length) return;
    var style = document.createElement('style');
    style.setAttribute('data-pdv', 'fonts');
    style.textContent = rules.join('\n');
    document.head.appendChild(style);
  }

  /* ── apply ───────────────────────────────────────────────────────────── */

  function applyBrand(brand, tokens, meta) {
    var map = tokens && Object.keys(tokens).length ? tokens : deriveTokens(brand || {});
    var root = document.documentElement;
    Object.keys(map).forEach(function (k) {
      root.style.setProperty('--pdv-' + k, String(map[k]));
    });

    var bg = map['color-background'];
    var from = map['color-gradient-from'];
    var to = map['color-gradient-to'];

    // Wash alphas are deliberately low; the scrim, not the wash, is what makes
    // type legible, and a heavy wash is the thing that makes a card look cheap.
    root.style.setProperty('--pdv-wash-a', rgba(from, 0.18));
    root.style.setProperty('--pdv-wash-b', rgba(to, 0.16));
    root.style.setProperty('--pdv-wash-c', rgba(from, 0.06));
    root.style.setProperty('--pdv-wash-d', rgba(to, 0.06));
    root.style.setProperty('--pdv-scrim-core', rgba(bg, 0.94));
    root.style.setProperty('--pdv-scrim-zero', rgba(bg, 0));

    var logo = (brand && brand.logo) || {};
    var minH = Math.max(48, Number(logo.minHeightPx) || 48);
    // rem here is 1/108 of frame height, so px -> rem is px/10 at 1080p.
    root.style.setProperty('--pdv-logo-h', Math.max(minH, 72) / 10 + 'rem');
    root.style.setProperty('--pdv-logo-hero-h', Math.max(minH * 2, 130) / 10 + 'rem');
    root.style.setProperty('--pdv-logo-clear', (Number(logo.safeAreaRatio) || 0.5) * Math.max(minH, 72) / 10 + 'rem');

    injectFonts(brand, meta && meta.brandDir);
    root.setAttribute('data-scheme', map.scheme || 'light');
    return map;
  }

  /* ── ink ─────────────────────────────────────────────────────────────── */

  /**
   * Candidate inks per role, best-looking first. The first candidate that
   * clears MIN_CONTRAST against the element's backdrop wins, so a brand whose
   * accent is too light for body copy degrades to something legible instead of
   * shipping unreadable type.
   */
  function inkCandidates(role, map) {
    var text = map['color-text'];
    var bw = relativeLuminance(map['color-background']) < 0.4 ? '#ffffff' : '#000000';
    switch (role) {
      case 'muted':      return [map['color-text-muted'], text, bw];
      case 'accent':     return [map['color-primary'], map['color-accent'], map['color-secondary'], text, bw];
      case 'onPrimary':  return [map['color-on-primary'], '#ffffff', '#000000'];
      case 'inverse':    return [map['color-background'], bw];
      default:           return [text, bw];
    }
  }

  /**
   * The colour actually sitting behind an element. Walks up to the first opaque
   * background, compositing translucent layers on the way. `data-scrim` marks a
   * block whose soft background pool is dense enough to count as opaque — the
   * gradient is not a background-color and cannot be read off computed style.
   */
  function backdropOf(el, map) {
    var layers = [];
    var node = el;
    var base = null;
    while (node && node !== document.documentElement) {
      var scrim = node.getAttribute && node.getAttribute('data-scrim');
      if (scrim) { base = scrim; break; }
      var parsed = parseCssColor(getComputedStyle(node).backgroundColor);
      if (parsed && parsed.a > 0.001) {
        if (parsed.a >= 0.999) { base = rgbToHex(parsed); break; }
        layers.push(parsed);
      }
      node = node.parentElement;
    }
    if (!base) base = map['color-background'];
    for (var i = layers.length - 1; i >= 0; i -= 1) {
      base = over(layers[i], layers[i].a, base);
    }
    return base;
  }

  function resolveInk(el, map) {
    var role = el.getAttribute('data-ink') || 'text';
    var backdrop = backdropOf(el, map);
    var candidates = inkCandidates(role, map).filter(Boolean);
    var best = candidates[0];
    var bestRatio = contrastRatio(best, backdrop);
    var chosenIndex = 0;
    for (var i = 0; i < candidates.length; i += 1) {
      var ratio = contrastRatio(candidates[i], backdrop);
      if (ratio >= MIN_CONTRAST) { best = candidates[i]; bestRatio = ratio; chosenIndex = i; break; }
      if (ratio > bestRatio) { best = candidates[i]; bestRatio = ratio; chosenIndex = i; }
    }
    el.style.color = best;
    el.classList.add('ink');
    el.setAttribute('data-ink-resolved', best);
    el.setAttribute('data-ink-backdrop', backdrop);
    el.setAttribute('data-ink-ratio', String(bestRatio));
    if (chosenIndex > 0) el.setAttribute('data-ink-fallback', 'true');
    return bestRatio;
  }

  function applyInk(map) {
    var els = document.querySelectorAll('[data-ink]');
    for (var i = 0; i < els.length; i += 1) resolveInk(els[i], map);
  }

  /* ── fit ─────────────────────────────────────────────────────────────── */

  /**
   * Count laid-out line boxes. Display type is set with a line-height under 1,
   * which makes scrollHeight report the glyph overflow rather than the line
   * budget — measuring rects is the only reading that holds at those settings.
   */
  function lineCount(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var rects = range.getClientRects();
    var tops = {};
    for (var i = 0; i < rects.length; i += 1) {
      if (rects[i].width > 0) tops[Math.round(rects[i].top)] = 1;
    }
    return Object.keys(tops).length;
  }

  /**
   * Shrink display type until it fits its line budget. Headlines are set large
   * on purpose; this stops a long one running into the safe area rather than
   * setting everything timidly small to be safe.
   */
  function fitText(el, maxLines) {
    el.style.fontSize = '';
    var rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
    var size = parseFloat(getComputedStyle(el).fontSize);
    if (!size) return;
    var floor = rootPx * 2.4;
    var guard = 80;
    while (guard > 0) {
      var lines = lineCount(el);
      var fits = lines <= maxLines && el.scrollWidth <= el.clientWidth + 2;
      if (fits || size <= floor) break;
      size *= 0.96;
      el.style.fontSize = size + 'px';
      guard -= 1;
    }
  }

  function applyFit() {
    var els = document.querySelectorAll('[data-fit]');
    for (var i = 0; i < els.length; i += 1) {
      fitText(els[i], parseInt(els[i].getAttribute('data-fit'), 10) || 3);
    }
  }

  /* ── slots ───────────────────────────────────────────────────────────── */

  /** Write text into [data-slot], hiding the element when there is nothing. */
  function setSlot(name, value, opts) {
    var el = document.querySelector('[data-slot="' + name + '"]');
    if (!el) return null;
    var text = value == null ? '' : String(value).trim();
    if (!text) {
      if (!opts || opts.keepEmpty !== true) el.classList.add('is-hidden');
      return el;
    }
    el.textContent = text;
    el.classList.remove('is-hidden');
    return el;
  }

  /**
   * Logo, with a wordmark fallback. A missing file must not produce a broken
   * image glyph in a frame that is about to be shown to customers.
   */
  function setLogo(name, brand, meta, variant) {
    var host = document.querySelector('[data-slot="' + name + '"]');
    if (!host) return;
    var logo = (brand && brand.logo) || {};
    var dark = document.documentElement.getAttribute('data-scheme') === 'dark';
    var order = variant === 'mark'
      ? [logo.mark, dark ? logo.inverse : logo.primary]
      : dark
        ? [logo.inverse, logo.primary, logo.mark]
        : [logo.primary, logo.inverse, logo.mark];
    var src = order.filter(Boolean)[0];
    host.innerHTML = '';
    var word = document.createElement('span');
    word.className = 'logo__word ink';
    word.setAttribute('data-ink', 'text');
    word.textContent = (brand && brand.name) || '';
    if (!src) { host.appendChild(word); return; }
    var img = document.createElement('img');
    img.className = 'logo__img';
    img.alt = (brand && brand.name) || 'logo';
    img.addEventListener('error', function () {
      img.remove();
      host.appendChild(word);
      applyInk(window.PDV._tokens || {});
    });
    img.src = fontUrl(src, meta && meta.brandDir);
    host.appendChild(img);
  }

  /* ── probe ───────────────────────────────────────────────────────────── */

  /**
   * Every inked element with its resolved colour and its box, for the render
   * test to check against the real composited pixels behind it.
   */
  function probeContrast() {
    var out = [];
    var els = document.querySelectorAll('[data-ink-resolved]');
    for (var i = 0; i < els.length; i += 1) {
      var el = els[i];
      var rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      var text = (el.textContent || '').trim();
      if (!text) continue;
      out.push({
        role: el.getAttribute('data-ink') || 'text',
        tag: el.tagName.toLowerCase(),
        cls: el.className.replace(/\bink\b/, '').trim(),
        text: text.length > 48 ? text.slice(0, 45) + '...' : text,
        fg: el.getAttribute('data-ink-resolved'),
        assumedBg: el.getAttribute('data-ink-backdrop'),
        assumedRatio: Number(el.getAttribute('data-ink-ratio')),
        fallback: el.getAttribute('data-ink-fallback') === 'true',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
    return out;
  }

  /* ── boot ────────────────────────────────────────────────────────────── */

  function fontsSettled() {
    if (!document.fonts || !document.fonts.ready) return Promise.resolve();
    return Promise.race([
      document.fonts.ready,
      new Promise(function (r) { setTimeout(r, 3000); }),
    ]);
  }

  function apply(data) {
    var d = data || {};
    var brand = d.brand || {};
    var meta = d.meta || {};
    var scene = d.scene || {};
    var map = applyBrand(brand, d.tokens, meta);
    window.PDV._tokens = map;

    // Scrim blocks declare the colour that sits behind their type, so the ink
    // resolver has a real backdrop rather than a gradient sample.
    var scrims = document.querySelectorAll('.scrim');
    for (var i = 0; i < scrims.length; i += 1) {
      scrims[i].setAttribute('data-scrim', map['color-background']);
    }

    if (typeof window.PDV._render === 'function') {
      window.PDV._render({ brand: brand, scene: scene, meta: meta, content: scene.content || {}, tokens: map });
    }

    applyInk(map);
    applyFit();

    return fontsSettled().then(function () {
      applyFit();
      applyInk(map);
      return new Promise(function (resolve) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            document.documentElement.dataset.ready = 'true';
            resolve();
          });
        });
      });
    });
  }

  function boot(renderFn) {
    window.PDV._render = renderFn;
    window.__render = function (data) {
      window.__DATA = data;
      document.documentElement.removeAttribute('data-ready');
      return apply(data);
    };
    if (window.__DATA) return apply(window.__DATA);
    return Promise.resolve();
  }

  window.PDV = {
    _render: null,
    _tokens: null,
    boot: boot,
    apply: apply,
    applyBrand: applyBrand,
    applyInk: applyInk,
    setSlot: setSlot,
    setLogo: setLogo,
    fitText: fitText,
    probeContrast: probeContrast,
    contrastRatio: contrastRatio,
    relativeLuminance: relativeLuminance,
    deriveTokens: deriveTokens,
    resolveUrl: fontUrl,
    MIN_CONTRAST: MIN_CONTRAST,
  };
}());
