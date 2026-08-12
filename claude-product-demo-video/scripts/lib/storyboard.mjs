/**
 * storyboard — turn a feature brief plus a brand contract into storyboard.json.
 *
 * The cut is the one a good release video actually uses: title, context, two
 * to four capability scenes that show the thing working, a proof or summary
 * beat, then an outro with the CTA. Target runtime is 45-90 seconds.
 *
 * Every narration sentence is either traceable to a cited capability or is
 * structural (product and feature names, and the CTA). A thin brief produces
 * a SHORTER video, never a padded one.
 *
 * Also home to the dependency-free draft-07 subset validator the pipeline uses
 * (type, required, enum, const, oneOf, pattern, minItems/maxItems,
 * minimum/maximum, properties, items, additionalProperties, $ref).
 */

import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { driftDirection, kenBurnsPoses } from './motion.mjs';
import { readJson, slugify, writeJson } from './util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const TARGET_MIN_MS = 45_000;
const TARGET_MAX_MS = 90_000;
const SCENE_PAD_MS = 900;
const DEFAULT_WPM = 165;
const MAX_CAPABILITY_SCENES = 4;
const MIN_CAPABILITY_SCENES = 2;

/* ------------------------------------------------------- schema validation */

export async function loadSchema(name) {
  return readJson(resolve(HERE, '..', '..', 'schemas', name));
}

function deref(schema, root) {
  let s = schema;
  let guard = 0;
  while (s && typeof s.$ref === 'string' && guard++ < 20) {
    let node = root;
    for (const seg of s.$ref.replace(/^#\/?/, '').split('/')) {
      if (!seg) continue;
      node = node?.[decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'))];
    }
    s = node;
  }
  return s ?? {};
}

function typeOk(type, value) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function check(schemaIn, value, path, root, errors) {
  const schema = deref(schemaIn, root);
  if (!schema || typeof schema !== 'object') return;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) {
      errors.push({ path, message: `expected ${types.join(' or ')}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}` });
      return;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({ path, message: `${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}` });
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push({ path, message: `${JSON.stringify(value)} does not match ${schema.pattern}` });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `must be <= ${schema.maximum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `needs at least ${schema.minItems} items, has ${value.length}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `allows at most ${schema.maxItems} items, has ${value.length}` });
    }
    if (schema.items) value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, root, errors));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push({ path, message: `missing required property "${key}"` });
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) check(sub, value[key], `${path}.${key}`, root, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) errors.push({ path, message: `unexpected property "${key}"` });
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) check(schema.additionalProperties, value[key], `${path}.${key}`, root, errors);
      }
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((sub) => {
      const errs = [];
      check(sub, value, path, root, errs);
      return errs;
    });
    const passing = branches.filter((e) => e.length === 0).length;
    if (passing !== 1) {
      const closest = branches.reduce((a, b) => (b.length < a.length ? b : a), branches[0] ?? []);
      errors.push({
        path,
        message: `matched ${passing} of ${schema.oneOf.length} oneOf branches; closest failed with: ${closest.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      });
    }
  }
}

export function validateAgainstSchema(schema, data, root = schema) {
  const errors = [];
  check(schema, data, '$', root, errors);
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------ copy handling */

const INFLATION = [
  'revolutionary', 'game-changing', 'game changing', 'seamlessly', 'seamless', 'effortlessly',
  'effortless', 'delightful', 'best-in-class', 'world-class', 'cutting-edge', 'supercharge',
  'supercharged', 'magical', 'blazing-fast', 'blazingly fast', 'incredible', 'amazing',
];

export function bannedWordsFor(brand) {
  return [...new Set([...INFLATION, ...((brand?.voice?.bannedWords ?? []).map((w) => String(w).toLowerCase()))])];
}

export function stripBanned(text, banned) {
  let out = String(text ?? '');
  for (const word of banned) {
    out = out.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '');
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

const CLAUSE_BREAKS = [', and ', ', which ', ', so ', '; ', ' — ', ' -- '];

/** One idea per sentence: cut at the first clause boundary once it runs long. */
export function oneIdea(text, maxWords = 22) {
  const s = String(text ?? '').trim();
  if (s.split(/\s+/).length <= maxWords) return s;

  // A whole first sentence beats a clause cut: cutting at ", and " drops the
  // last item of a list, which quietly misstates what the evidence said.
  const sentence = s.match(/^(.{20,}?[.?])(?:\s|$)/);
  if (sentence && wordCount(sentence[1]) <= maxWords + 6) return sentence[1].trim();

  for (const brk of CLAUSE_BREAKS) {
    const i = s.indexOf(brk);
    if (i > 20) return s.slice(0, i).trim();
  }
  const cut = s.split(/\s+/).slice(0, maxWords).join(' ');
  // A hard word cut can end mid-list; fall back to the last whole clause.
  const comma = cut.lastIndexOf(',');
  return (comma > 20 ? cut.slice(0, comma) : cut).trim();
}

const SECOND_PERSON = [
  [/^adds?\s+(?:support\s+for\s+)?/i, 'You can now use '],
  [/^added\s+(?:support\s+for\s+)?/i, 'You can now use '],
  [/^support\s+for\s+/i, 'You can now use '],
  [/^supports?\s+/i, 'You can now use '],
  [/^allows?\s+(?:users?\s+)?to\s+/i, 'You can '],
  [/^enables?\s+(?:users?\s+)?to\s+/i, 'You can '],
  [/^enables?\s+/i, 'You can now use '],
  [/^lets?\s+(?:users?|you)\s+/i, 'You can '],
  [/^introduces?\s+/i, 'There is now '],
  [/^new:\s*/i, 'There is now '],
  [/^improves?d?\s+/i, 'We improved '],
  [/^fixe?d?s?\s+/i, 'We fixed '],
];

export function secondPerson(statement) {
  let s = String(statement ?? '').trim();
  for (const [re, replacement] of SECOND_PERSON) {
    if (re.test(s)) {
      s = s.replace(re, replacement);
      break;
    }
  }
  return s;
}

export function narrate(text, brand) {
  let s = stripBanned(secondPerson(text), bannedWordsFor(brand));
  s = oneIdea(s).replace(/!+/g, '.').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s[0].toUpperCase() + s.slice(1);
  return /[.?]$/.test(s) ? s : `${s}.`;
}

export function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/* A card has to sit on screen long enough to be read, whatever the VO length. */
const MIN_SCENE_MS = { title: 3800, feature: 4200, product: 4600, stat: 4000, steps: 4800, quote: 4000, outro: 4500 };

export function estimateSceneMs(scene, rateWpm = DEFAULT_WPM) {
  if (scene.durationMs) return scene.durationMs;
  const ms = (wordCount(scene.narration) / rateWpm) * 60_000 + SCENE_PAD_MS;
  return Math.max(MIN_SCENE_MS[scene.type] ?? 2200, Math.round(ms));
}

export function estimateTotalMs(scenes, rateWpm = DEFAULT_WPM) {
  const raw = scenes.reduce((sum, s) => sum + estimateSceneMs(s, rateWpm), 0);
  const overlap = scenes.reduce((sum, s) => sum + (s.transitionOut?.durationMs ?? 0), 0);
  return Math.max(0, raw - overlap);
}

/* ------------------------------------------------------------ motion & cuts */

const TRANSITION_POOL = ['fade', 'smoothleft', 'dissolve', 'wipeleft', 'slideup', 'circleopen'];
const TRANSITION_ENUM = new Set([...TRANSITION_POOL, 'wiperight', 'slidedown', 'none']);

export function transitionSequence(count, brand) {
  const preferred = brand?.motion?.defaultTransition;
  const pool = TRANSITION_ENUM.has(preferred)
    ? [preferred, ...TRANSITION_POOL.filter((t) => t !== preferred)]
    : [...TRANSITION_POOL];
  const ms = brand?.motion?.transitionMs ?? 600;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push({ type: pool[i % pool.length], durationMs: ms });
  return out;
}

/**
 * Poses come from motion.mjs so the storyboard writes the same drift the
 * renderer would derive — a centred [0.5,0.5,z] pair here is what made every
 * kenburns scene a dead-centre zoom no matter what motion.mjs computed.
 * Direction alternates with the index, so consecutive scenes never repeat.
 */
export function kenBurns(index, brand) {
  const intensity = brand?.motion?.kenBurnsIntensity ?? 0.08;
  const { start, end } = kenBurnsPoses(intensity, driftDirection({}, { sceneIndex: index }));
  const push = index % 2 === 0;
  return {
    type: 'kenburns',
    from: push ? start : end,
    to: push ? end : start,
    easing: easingFor(brand),
  };
}

export function autoZoom(target, brand) {
  const intensity = brand?.motion?.kenBurnsIntensity ?? 0.08;
  return {
    type: 'autozoom',
    from: [0.5, 0.5, 1],
    to: [0.5, 0.5, 1 + intensity * 2],
    target,
    holdMs: 700,
    easing: easingFor(brand),
  };
}

function easingFor(brand) {
  const e = brand?.motion?.easing;
  return ['linear', 'easeInOutCubic', 'easeOutQuint'].includes(e) ? e : 'easeInOutCubic';
}

/* ------------------------------------------------------------- demo specs */

/* Invented, neutral, and marked source:'sample' so demo.mjs's PROVENANCE.json
   separates it from wording actually read out of the repository. */
const SAMPLE_ROWS = [
  { name: 'Acme Pty Ltd', detail: 'Connected', at: 'Today, 9:14am' },
  { name: 'Northwind Trading', detail: 'Connected', at: 'Today, 8:02am' },
  { name: 'PaymentsCo', detail: 'Pending', at: 'Yesterday' },
  { name: 'Riverside Clinic', detail: 'Connected', at: 'Yesterday' },
];

const SCREEN_ID = 'main';
const DONE_KEY = 'demoDone';

/**
 * Emits the spec shape demo.mjs consumes: kind-tagged elements with HTML ids,
 * a state key the primary action flips, and source/evidenceRef provenance on
 * every string lifted from the repo.
 */
export function demoSpecFor(surface, capability, brand) {
  const title = surface.title ?? surface.id;
  const raw = (surface.elements ?? []).filter((e) => e.label);
  const heading = raw.find((e) => e.role === 'heading');
  const search = raw.find((e) => e.role === 'field' && /search|find|filter/i.test(e.label));
  const subtitle = raw.find((e) => e.role === 'text' && e.label.length > 12);
  const consumed = new Set([heading, search, subtitle].filter(Boolean));

  const usable = raw.filter((e) => !consumed.has(e) && !['icon', 'nav'].includes(e.role)).slice(0, 10);
  const elements = [];
  let primary = null;

  usable.forEach((e, i) => {
    const cited = { source: 'evidence', ...(e.evidenceRef ? { evidenceRef: e.evidenceRef } : {}) };
    const id = `el-${i + 1}`;
    switch (e.role) {
      case 'button': {
        const el = { kind: 'button', id, label: e.label, variant: primary ? 'secondary' : 'primary', ...cited };
        if (!primary) {
          el.action = [{ type: 'setState', key: DONE_KEY, value: true }];
          primary = el;
        }
        elements.push(el);
        break;
      }
      case 'toggle':
        elements.push({ kind: 'toggle', id, label: e.label, stateKey: DONE_KEY, ...cited });
        break;
      case 'field':
        elements.push({ kind: 'field', id, label: e.label, placeholder: e.label, ...cited });
        break;
      case 'badge':
        elements.push({ kind: 'badge', id, label: e.label, tone: 'info', ...cited });
        break;
      case 'heading':
        elements.push({ kind: 'heading', id, text: e.label, level: 2, ...cited });
        break;
      default:
        elements.push({ kind: 'text', id, text: e.label, ...cited });
    }
  });

  const reveal = {
    kind: 'list',
    id: 'el-result',
    source: 'sample',
    title: 'Recent activity',
    items: SAMPLE_ROWS.map((r, i) => ({
      id: `row-${i + 1}`,
      title: r.name,
      meta: r.at,
      badge: r.detail,
      badgeTone: r.detail === 'Pending' ? 'warning' : 'success',
    })),
  };
  // Only gate the reveal when something on screen can actually flip the state.
  if (primary) reveal.when = { [DONE_KEY]: true };
  elements.push(reveal);

  const spec = {
    id: surface.id,
    demonstrates: capability.statement,
    product: { name: brand?.name ?? 'Product' },
    nav: [{ id: 'nav-main', label: title, screen: SCREEN_ID, icon: 'link', source: 'evidence' }],
    state: { [DONE_KEY]: false },
    initialScreen: SCREEN_ID,
    screens: [
      {
        id: SCREEN_ID,
        layout: 'single',
        title,
        ...(subtitle ? { subtitle: subtitle.label } : {}),
        source: 'evidence',
        ...(heading?.evidenceRef ? { evidenceRef: heading.evidenceRef } : {}),
        elements,
      },
    ],
  };
  if (search) spec.topbar = { search: search.label, source: 'evidence' };
  return spec;
}

/**
 * demo.mjs renders `fill` targets as styled divs, so the flow never uses fill —
 * Playwright's fill() only works on real inputs.
 */
export function flowFor(spec) {
  const els = spec.screens[0].elements;
  const primary = els.find((e) => e.kind === 'button' && e.action) ?? els.find((e) => e.kind === 'toggle');
  const reveal = els.find((e) => e.source === 'sample');

  const flow = [{ action: 'waitForSelector', selector: `[data-screen="${SCREEN_ID}"]` }];
  if (primary) {
    flow.push({ action: 'moveCursor', selector: `#${primary.id}`, ms: 700 });
    flow.push({ action: 'click', selector: `#${primary.id}`, label: primary.label });
    flow.push({ action: 'wait', ms: 800 });
  } else {
    flow.push({ action: 'scroll', ms: 900 });
  }

  const target = reveal ? `#${reveal.id}` : primary ? `#${primary.id}` : `[data-screen="${SCREEN_ID}"]`;
  flow.push({ action: 'highlight', selector: target, ms: 900 });
  return { flow, zoomTarget: target };
}

/* --------------------------------------------------------- storyboard build */

function posix(p) {
  return p.split(sep).join('/');
}

/** Numbers may only be shown if they appear verbatim in a cited excerpt. */
export function citedNumber(capability, evidenceById) {
  for (const ref of capability.evidenceRefs ?? []) {
    const excerpt = evidenceById.get(ref)?.excerpt ?? '';
    const m = excerpt.match(/\b(\d{1,3}(?:[.,]\d+)?\s?(?:%|x|ms|s\b|×))/);
    if (m) return { value: m[1].trim(), ref };
  }
  return null;
}

export function buildStoryboard({ brief, brand, storyboardDir, workDir }) {
  const evidenceById = new Map((brief.evidence ?? []).map((e) => [e.id, e]));
  const surfaceById = new Map((brief.surfaces ?? []).map((s) => [s.id, s]));
  const feature = brief.feature ?? {};
  const brandName = brand?.name ?? 'the product';

  const cited = (brief.capabilities ?? []).filter((c) =>
    (c.evidenceRefs ?? []).some((r) => evidenceById.has(r)),
  );
  if (cited.length === 0) {
    throw new Error('brief has no cited capabilities — there is nothing this video is allowed to claim.');
  }

  const ranked = [...cited].sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));
  let chosen = dedupeStatements(ranked).slice(0, MAX_CAPABILITY_SCENES);

  const demoSpecs = [];
  const build = () => {
    demoSpecs.length = 0;
    return assemble({ brief, brand, brandName, feature, chosen, evidenceById, surfaceById, storyboardDir, workDir, demoSpecs });
  };

  let storyboard = build();
  // Overlong loses people. Drop the weakest capability rather than speed the read up.
  while (estimateTotalMs(storyboard.scenes) > TARGET_MAX_MS && chosen.length > MIN_CAPABILITY_SCENES) {
    chosen = chosen.slice(0, chosen.length - 1);
    storyboard = build();
  }

  return { storyboard, demoSpecs, estimateMs: estimateTotalMs(storyboard.scenes) };
}

function dedupeStatements(caps) {
  const seen = new Set();
  const out = [];
  for (const c of caps) {
    const key = c.statement.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function assemble(a) {
  const { brief, brand, brandName, feature, chosen, evidenceById, surfaceById, storyboardDir, workDir, demoSpecs } = a;
  const scenes = [];

  // 1. Title — names only, no claim.
  scenes.push({
    id: 'title',
    type: 'title',
    narration: `${brandName}. ${stripStop(feature.name)}.`,
    content: {
      heading: feature.name,
      subheading: brand?.tagline ?? '',
      cites: [],
      claimSource: 'structural',
    },
    capture: { kind: 'html', template: 'title.html' },
  });

  // 2. Context — the summary, which is a claim, so it carries its citation.
  // When the summary just restates the first capability, the spoken line drops
  // to a structural framer so scene 2 and scene 3 are not the same sentence.
  const summaryCap = chosen[0];
  const summary = feature.summary ?? summaryCap.statement;
  const restates = stripStop(summary).toLowerCase() === stripStop(summaryCap.statement).toLowerCase();
  scenes.push({
    id: 'context',
    type: 'feature',
    narration: restates ? `Here is what changed in ${stripStop(feature.name)}.` : narrate(summary, brand),
    content: {
      heading: 'What changed',
      body: withStop(summary),
      audience: feature.audience ?? '',
      cites: summaryCap.evidenceRefs,
      claimSource: 'capability',
    },
    capture: { kind: 'html', template: 'feature.html' },
  });

  // 3. Capability scenes — each shows the thing working.
  chosen.forEach((cap, i) => {
    const surface = cap.surface ? surfaceById.get(cap.surface) : null;
    const id = `capability-${i + 1}`;
    const narration = narrate(cap.statement, brand);
    const content = {
      heading: shortHeading(cap.statement),
      body: withStop(cap.statement),
      cites: cap.evidenceRefs,
      claimSource: 'capability',
    };

    if (surface && (surface.elements ?? []).length > 0) {
      const spec = demoSpecFor(surface, cap, brand);
      const { flow, zoomTarget } = flowFor(spec);
      const specPath = resolve(workDir, 'demo', spec.id, 'demo-spec.json');
      demoSpecs.push({ path: specPath, spec });
      scenes.push({
        id,
        type: 'product',
        narration,
        content,
        capture: {
          kind: 'demo',
          app: spec.id,
          spec: posix(relative(storyboardDir, specPath)),
          flow,
          cursor: true,
          chrome: true,
          viewport: [1600, 900],
        },
        motion: autoZoom(zoomTarget, brand),
      });
    } else {
      scenes.push({
        id,
        type: 'feature',
        narration,
        content: { ...content, bullets: bulletsFor(cap, evidenceById) },
        capture: { kind: 'html', template: 'feature.html' },
        motion: kenBurns(i, brand),
      });
    }
  });

  // 4. Proof or summary — a number only if it is quoted in an excerpt.
  const stat = chosen.map((c) => ({ cap: c, hit: citedNumber(c, evidenceById) })).find((x) => x.hit);
  if (stat) {
    scenes.push({
      id: 'proof',
      type: 'stat',
      narration: narrate(stat.cap.statement, brand),
      content: {
        statValue: stat.hit.value,
        statLabel: shortHeading(stat.cap.statement),
        cites: [stat.hit.ref],
        claimSource: 'capability',
      },
      capture: { kind: 'html', template: 'stat.html' },
    });
  } else {
    scenes.push({
      id: 'summary',
      type: 'steps',
      narration: `That is ${numberWord(chosen.length)} ${chosen.length === 1 ? 'change' : 'changes'} in this release.`,
      content: {
        heading: 'In this release',
        steps: chosen.map((c) => shortHeading(c.statement)),
        cites: [...new Set(chosen.flatMap((c) => c.evidenceRefs))],
        claimSource: 'capability',
      },
      capture: { kind: 'html', template: 'steps.html' },
    });
  }

  // 5. Outro — CTA. Status is stated only when the brief cited it.
  const statusRef = feature.status ? statusEvidenceRef(feature.status, brief) : null;
  const statusLine = feature.status && statusRef ? `${statusSentence(feature.status)} ` : '';
  scenes.push({
    id: 'outro',
    type: 'outro',
    narration: `${statusLine}${brand?.url ? `Find it at ${brand.url}.` : `Open ${brandName} to try it.`}`,
    content: {
      heading: brandName,
      url: brand?.url ?? '',
      disclaimer: brand?.legal?.disclaimer ?? '',
      cites: statusRef ? [statusRef] : [],
      claimSource: statusRef ? 'status' : 'structural',
    },
    capture: { kind: 'html', template: 'outro.html' },
  });

  // Motion for scenes that did not get their own, alternating so no two
  // consecutive scenes make the same move.
  scenes.forEach((scene, i) => {
    if (!scene.motion) scene.motion = kenBurns(i, brand);
  });
  for (let i = 1; i < scenes.length; i += 1) {
    if (JSON.stringify(scenes[i - 1].motion) !== JSON.stringify(scenes[i].motion)) continue;
    const cur = scenes[i].motion;
    scenes[i].motion = cur.type === 'kenburns' ? kenBurns(i + 1, brand) : { ...cur, holdMs: (cur.holdMs ?? 0) + 300 };
  }

  const transitions = transitionSequence(scenes.length - 1, brand);
  transitions.forEach((t, i) => {
    scenes[i].transitionOut = t;
  });

  const meta = {
    title: feature.name,
    slug: videoSlug(feature.name),
    width: 1920,
    height: 1080,
    fps: 30,
    aspect: '16:9',
  };
  if (feature.summary) meta.subtitle = stripStop(feature.summary);
  if (brand?.__path) meta.brandPath = posix(relative(storyboardDir, brand.__path));

  return {
    meta,
    audio: {
      voice: {
        provider: brand?.voice?.provider ?? 'say',
        ...(brand?.voice?.voiceId ? { voiceId: brand.voice.voiceId } : {}),
        rateWpm: DEFAULT_WPM,
        gainDb: 0,
      },
      music: {
        mood: moodFor(brand),
        gainDb: -18,
        duck: true,
        fadeInMs: 1200,
        fadeOutMs: 2000,
      },
    },
    captions: { enabled: true, style: 'bar', position: 'bottom', maxCharsPerLine: 42 },
    scenes,
  };
}

function bulletsFor(cap, evidenceById) {
  const excerpt = evidenceById.get(cap.evidenceRefs[0])?.excerpt ?? '';
  return excerpt
    .split('\n')
    .map((l) => l.replace(/^\s*[-*+]\s*/, '').trim())
    .filter((l) => l.length > 8 && l.length < 70)
    .slice(0, 3);
}

function statusEvidenceRef(status, brief) {
  const markers = {
    ga: /\b(generally available|self-serve GA|now GA|out of beta|beta (?:gate|flag) removed|removed the beta (?:gate|flag))\b/i,
    beta: /\bbeta\b/i,
    'rolling-out': /\b(rolling out|staged rollout|gradual rollout|percentage rollout)\b/i,
    planned: /\b(coming soon|on the roadmap|planned for a future)\b/i,
  };
  const re = markers[status];
  if (!re) return null;
  return (brief.evidence ?? []).find((e) => re.test(e.excerpt ?? ''))?.id ?? null;
}

function statusSentence(status) {
  switch (status) {
    case 'beta':
      return 'It is in beta.';
    case 'rolling-out':
      return 'It is rolling out now.';
    case 'planned':
      return 'It is planned, not shipped yet.';
    case 'ga':
      return 'It is generally available.';
    default:
      return '';
  }
}

function moodFor(brand) {
  switch (brand?.motion?.pace) {
    case 'calm':
      return 'calm';
    case 'brisk':
      return 'energetic';
    default:
      return 'uplifting';
  }
}

function numberWord(n) {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six'][n] ?? String(n);
}

export function shortHeading(statement) {
  const s = stripStop(String(statement ?? '').trim());
  const words = s.split(/\s+/);
  return words.length <= 7 ? s : `${words.slice(0, 7).join(' ')}`;
}

function stripStop(s) {
  return String(s ?? '').replace(/[.\s]+$/, '');
}

function withStop(s) {
  const t = String(s ?? '').trim();
  return !t || /[.?]$/.test(t) ? t : `${t}.`;
}

/** meta.slug is the output filename stem, so it stays short and file-safe. */
export function videoSlug(text) {
  return slugify(text).slice(0, 60).replace(/-+$/, '') || 'release';
}

/* ------------------------------------------------------------ traceability */

/**
 * A narration line is legal only if it is structural (product/feature names
 * and the CTA) or cites evidence that exists in the brief.
 */
export function traceability(storyboard, brief) {
  const ids = new Set((brief.evidence ?? []).map((e) => e.id));
  const rows = [];
  for (const scene of storyboard.scenes) {
    const cites = scene.content?.cites ?? [];
    const dangling = cites.filter((c) => !ids.has(c));
    const structural = (scene.content?.claimSource ?? 'structural') === 'structural';
    rows.push({
      id: scene.id,
      structural,
      cites,
      dangling,
      ok: dangling.length === 0 && (structural || cites.length > 0),
    });
  }
  return rows;
}

export function copyCheck(storyboard, brand) {
  const banned = bannedWordsFor(brand);
  const problems = [];
  for (const scene of storyboard.scenes) {
    const text = scene.narration ?? '';
    if (/!/.test(text)) problems.push(`${scene.id}: exclamation mark in narration`);
    for (const w of banned) {
      if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
        problems.push(`${scene.id}: banned word "${w}"`);
      }
    }
  }
  return problems;
}

/* ----------------------------------------------------------------- the stage */

export async function run(ctx) {
  const briefPath = resolve(ctx.cwd, ctx.brief ?? 'feature-brief.json');
  const brandPath = resolve(ctx.cwd, ctx.brand ?? 'brand.json');
  const out = resolve(ctx.cwd, ctx.out ?? 'storyboard.json');
  const workDir = ctx.work ?? resolve(ctx.cwd, 'work');

  const brief = await readJson(briefPath);
  const brand = await readJson(brandPath);
  brand.__path = brandPath;

  const brandSchema = await loadSchema('brand.schema.json');
  const brandCheck = validateAgainstSchema(brandSchema, stripPrivate(brand));
  if (!brandCheck.ok) {
    throw new Error(
      `${brandPath} is not a valid brand contract:\n  ${brandCheck.errors.map((e) => `${e.path}: ${e.message}`).join('\n  ')}`,
    );
  }

  const { storyboard, demoSpecs, estimateMs } = buildStoryboard({
    brief,
    brand,
    storyboardDir: dirname(out),
    workDir,
  });

  const rows = traceability(storyboard, brief);
  for (const r of rows) {
    ctx.log(
      `  ${r.ok ? 'ok  ' : 'FAIL'} ${r.id.padEnd(14)} ${r.structural ? 'structural (names + CTA)' : `cites ${r.cites.join(', ')}`}`,
    );
  }
  const untraceable = rows.filter((r) => !r.ok);
  if (untraceable.length) {
    throw new Error(
      `narration is not traceable to evidence: ${untraceable.map((r) => `${r.id} (${r.dangling.join(', ') || 'no citation'})`).join('; ')}`,
    );
  }

  const copyProblems = copyCheck(storyboard, brand);
  if (copyProblems.length) throw new Error(`copy check failed:\n  ${copyProblems.join('\n  ')}`);

  const schema = await loadSchema('storyboard.schema.json');
  const { ok, errors } = validateAgainstSchema(schema, storyboard);
  ctx.log(`SCHEMA: ${ok ? 'PASS' : 'FAIL'} (storyboard.schema.json)`);
  if (!ok) {
    throw new Error(`storyboard failed schema validation:\n  ${errors.map((e) => `${e.path}: ${e.message}`).join('\n  ')}`);
  }

  for (const { path, spec } of demoSpecs) {
    await writeJson(path, spec);
    ctx.log(`  demo spec: ${path}`);
  }

  await writeJson(out, storyboard);

  const seconds = (estimateMs / 1000).toFixed(1);
  const inRange = estimateMs >= TARGET_MIN_MS && estimateMs <= TARGET_MAX_MS;
  ctx.log(
    `STORYBOARD: OK  ${storyboard.scenes.length} scenes, ~${seconds}s ` +
      `(${inRange ? 'inside' : 'outside'} the 45-90s target)`,
  );
  ctx.log(`wrote ${out}`);
  return storyboard;
}

function stripPrivate(brand) {
  const { __path, ...rest } = brand;
  return rest;
}
