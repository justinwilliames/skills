/**
 * discover — read a GitHub repository and write a feature-brief.json.
 *
 * The GitHub repo is the primary source. A local checkout is used only when
 * --local is given AND its HEAD matches the remote ref, because a stale
 * checkout produces citations that do not exist at the ref being announced.
 *
 * Evidence discipline: every capability and every UI element carries an
 * evidenceRef into `evidence`, and every evidence excerpt is text actually
 * read — never a paraphrase. A candidate that cannot be cited is pushed to
 * `excluded` with a reason.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, basename, extname } from 'node:path';
import { promisify } from 'node:util';

import { validateAgainstSchema, loadSchema } from './storyboard.mjs';
import { slugify, writeJson } from './util.mjs';

const execFileAsync = promisify(execFile);

const MAX_EXCERPT = 600;
const MAX_SOURCE_FILES = 8;
const MAX_PULLS = 20;
const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.html', '.astro']);

/* ------------------------------------------------------------------ gh layer */

class GhError extends Error {}

let rateLimitProbed = false;

async function gh(args, ctx = {}) {
  ctx.debug?.(`gh ${args.join(' ')}`);
  try {
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new GhError(
        'GitHub CLI (gh) not found. Install it (https://cli.github.com) and run `gh auth login`.',
      );
    }
    const stderr = String(err.stderr ?? '');
    if (/gh auth login|not logged into|authentication token|HTTP 401/i.test(stderr)) {
      throw new GhError(`Not authenticated to GitHub. Run \`gh auth login\`.\n  gh said: ${stderr.trim()}`);
    }
    if (/rate limit/i.test(stderr)) {
      throw new GhError(`GitHub rate limit hit. ${await rateLimitHint(ctx)}\n  gh said: ${stderr.trim()}`);
    }
    if (/HTTP 404/i.test(stderr)) {
      const e = new GhError(`Not found: gh ${args.join(' ')}`);
      e.notFound = true;
      throw e;
    }
    const e = new GhError(`gh ${args.join(' ')} failed: ${stderr.trim() || err.message}`);
    e.stderr = stderr;
    throw e;
  }
}

async function rateLimitHint(ctx) {
  if (rateLimitProbed) return 'Wait for the window to reset before retrying.';
  rateLimitProbed = true;
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'rate_limit'], { maxBuffer: 1024 * 1024 });
    const core = JSON.parse(stdout)?.resources?.core;
    if (!core) return 'Wait for the window to reset before retrying.';
    return `Core quota ${core.remaining}/${core.limit}, resets at ${new Date(core.reset * 1000).toISOString()}.`;
  } catch {
    return 'Wait for the window to reset before retrying.';
  }
}

async function ghJson(args, ctx) {
  const out = await gh(args, ctx);
  return out.trim() ? JSON.parse(out) : null;
}

async function ghOptional(args, ctx) {
  try {
    return await ghJson(args, ctx);
  } catch (err) {
    if (err instanceof GhError && err.notFound) return null;
    throw err;
  }
}

export async function requireGh(ctx = {}) {
  const version = (await gh(['--version'], ctx)).split('\n')[0].trim();
  try {
    await execFileAsync('gh', ['auth', 'status'], { maxBuffer: 1024 * 1024 });
  } catch (err) {
    throw new GhError(
      `GitHub CLI is installed (${version}) but not authenticated. Run \`gh auth login\`.\n  gh said: ${String(err.stderr ?? err.message).trim()}`,
    );
  }
  return version;
}

/** Fetch a file at a ref through the contents API and base64-decode it. */
export async function fetchFile(repo, path, ref, ctx) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const body = await ghOptional(['api', `repos/${repo}/contents/${path}${q}`], ctx);
  if (!body || body.type !== 'file' || !body.content) return null;
  return {
    path: body.path,
    url: body.html_url,
    ref: body.sha,
    content: Buffer.from(body.content, 'base64').toString('utf8'),
  };
}

/* ------------------------------------------------------- text helpers (pure) */

/**
 * GitHub returns CRLF in release and PR bodies. `.` does not match \r, so any
 * line-anchored regex fails on unnormalised text — that silently produced zero
 * bullets from real release notes.
 */
export function normaliseText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

export function excerptOf(text, max = MAX_EXCERPT) {
  const s = normaliseText(text).trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

const NOISE_BULLET =
  /^(bump|chore|ci|build|deps|dependabot|merge|revert|release|version|update dependenc|full changelog|what's changed|new contributors)\b/i;

/** Pull the bullet lines out of a release body or changelog section. */
export function splitBullets(text) {
  const out = [];
  for (const raw of normaliseText(text).split('\n')) {
    const m = raw.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (!m) continue;
    const line = cleanBullet(m[1]);
    if (line && !NOISE_BULLET.test(line)) out.push(line);
  }
  return out;
}

export function cleanBullet(line) {
  return normaliseText(line)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\(#\d+\)/g, '')
    .replace(/\s+by\s+@[\w-]+/gi, '')
    .replace(/\s+in\s+https?:\/\/\S+/gi, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    // release notes trail each entry with the commit it landed in
    .replace(/\s+\b[0-9a-f]{7,40}\b$/, '')
    .trim();
}

export function toStatement(line) {
  const s = cleanBullet(line).replace(/[.\s]+$/, '');
  if (!s) return '';
  return s[0].toUpperCase() + s.slice(1);
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'new', 'add', 'support']);

export function featureTokens(feature) {
  return String(feature ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Strict mode requires every significant token; loose mode requires any one. */
export function matchesFeature(text, feature, mode = 'all') {
  const tokens = featureTokens(feature);
  if (tokens.length === 0) return true;
  const hay = String(text ?? '').toLowerCase();
  return mode === 'all' ? tokens.every((t) => hay.includes(t)) : tokens.some((t) => hay.includes(t));
}

/** Evidence and surface ids: short enough to read in a citation. */
export function slug(text) {
  return slugify(text).slice(0, 60).replace(/-+$/, '') || 'item';
}

export function firstSentence(text) {
  const s = normaliseText(text)
    .replace(/\s+/g, ' ')
    .trim();
  const m = s.match(/^(.{10,240}?[.!?])(\s|$)/);
  return (m ? m[1] : s.slice(0, 200)).replace(/!/g, '.').trim();
}

/* --------------------------------------------------- UI string extraction */

const CODEY = new Set([
  'div', 'span', 'true', 'false', 'null', 'undefined', 'function', 'return', 'import', 'export',
  'const', 'let', 'var', 'className', 'onClick', 'props', 'children', 'default', 'string',
  'number', 'boolean', 'object', 'array', 'react', 'use client', 'use server',
]);

export function isUserFacingString(value) {
  const s = String(value ?? '').trim();
  if (s.length < 2 || s.length > 80) return false;
  if (!/\p{L}/u.test(s)) return false;
  if (/[{}<>;]|=>|\$\{|:\/\/|\\n|&&|\|\|/.test(s)) return false;
  if (CODEY.has(s.toLowerCase())) return false;
  if (/^[\d.\s%+-]+$/.test(s)) return false;
  const hasSpace = /\s/.test(s);
  if (!hasSpace) {
    if (/^[a-z][a-zA-Z0-9]*$/.test(s)) return false;
    if (/^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/.test(s)) return false;
    if (/^[A-Z][A-Z0-9_]+$/.test(s)) return false;
  }
  return true;
}

const STRING_PATTERNS = [
  { role: 'heading', re: /<h([1-6])[^>]*>\s*([^<>{}]{2,80}?)\s*<\/h\1>/g, group: 2 },
  { role: 'button', re: /<[Bb]utton[^>]*>\s*([^<>{}]{2,80}?)\s*<\/[Bb]utton>/g, group: 1 },
  { role: 'badge', re: /<(Badge|Pill|Chip|Tag|StatusPill)[^>]*>\s*([^<>{}]{2,40}?)\s*<\/\1>/g, group: 2 },
  { role: 'field', re: /\b(?:placeholder|aria-label|inputLabel)\s*[=:]\s*["'`]([^"'`]{2,80})["'`]/g, group: 1 },
  { role: 'field', re: /\blabel\s*[=:]\s*["'`]([^"'`]{2,80})["'`]/g, group: 1 },
  { role: 'button', re: /\b(?:buttonText|ctaLabel|submitLabel|actionLabel|cta)\s*[=:]\s*["'`]([^"'`]{2,80})["'`]/g, group: 1 },
  { role: 'heading', re: /\b(?:title|heading|pageTitle)\s*[=:]\s*["'`]([^"'`]{2,80})["'`]/g, group: 1 },
  { role: 'text', re: /\b(?:emptyState|emptyMessage|description|helperText|subtitle|tooltip)\s*[=:]\s*["'`]([^"'`]{2,80})["'`]/g, group: 1 },
  { role: 'text', re: />\s*([A-Z][^<>{}\n]{3,80}?)\s*</g, group: 1 },
];

/**
 * Literal user-facing strings from one source file, each tied to the exact
 * source line it was read from so the excerpt can be checked against it.
 */
export function extractUiStrings(source) {
  const content = normaliseText(source);
  const lines = content.split('\n');
  const seen = new Map();
  for (const { role, re, group } of STRING_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const label = m[group]?.trim();
      if (!label || !isUserFacingString(label)) continue;
      if (seen.has(label)) continue;
      const lineNo = lines.findIndex((l) => l.includes(label));
      if (lineNo < 0) continue;
      seen.set(label, { role, label, line: lines[lineNo].trim(), lineNo: lineNo + 1 });
    }
  }
  return [...seen.values()];
}

const ROUTE_PATTERNS = [
  /\bpath\s*[=:]\s*["'`](\/[^"'`\s]*)["'`]/g,
  /\brouter\.(?:get|post|put|patch|delete)\(\s*["'`](\/[^"'`]*)["'`]/g,
  /\bhref\s*=\s*["'`](\/[^"'`#?]*)["'`]/g,
  /\bnavigate\(\s*["'`](\/[^"'`]*)["'`]/g,
];

export function extractRoutes(path, source) {
  const content = normaliseText(source);
  const routes = new Set();
  const fromPath = routeFromFilePath(path);
  if (fromPath) routes.add(fromPath);
  for (const re of ROUTE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const r = m[1];
      if (r && r.length <= 60 && !/\.(png|jpg|svg|css|js)$/i.test(r)) routes.add(r);
    }
  }
  return [...routes];
}

export function routeFromFilePath(path) {
  const p = String(path ?? '');
  let m = p.match(/(?:^|\/)(?:app|src\/app)\/(.+?)\/(?:page|route)\.[jt]sx?$/);
  if (m) return `/${m[1].replace(/\((?:[^)]*)\)\/?/g, '').replace(/\/+$/, '')}`.replace(/\/{2,}/g, '/');
  m = p.match(/(?:^|\/)pages\/(.+?)(?:\/index)?\.[jt]sx?$/);
  if (m) return `/${m[1] === 'index' ? '' : m[1]}`;
  m = p.match(/(?:^|\/)routes\/(.+?)\/\+page\.svelte$/);
  if (m) return `/${m[1]}`;
  return null;
}

export function humanise(name) {
  return String(name)
    .replace(/\.[a-z]+$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/* --------------------------------------------------------- status inference */

const STATUS_MARKERS = [
  { status: 'ga', re: /\b(generally available|self-serve GA|now GA|out of beta|removed the beta (?:gate|flag)|beta (?:gate|flag) removed)\b/i },
  { status: 'beta', re: /(<(?:Badge|Pill|Chip|Tag|StatusPill)[^>]*>\s*Beta\s*<)|(["'`]Beta["'`])|\bis\s*Beta\b|\bbetaGate\b|\bBETA_ENABLED\b|\bin (?:public |private )?beta\b|\bbeta (?:release|programme|program)\b/i },
  { status: 'rolling-out', re: /\b(rolling out|staged rollout|gradual rollout|percentage rollout)\b/i },
  { status: 'planned', re: /\b(coming soon|on the roadmap|planned for a future)\b/i },
];

/** Status is only ever asserted with the evidence id that justifies it. */
export function inferStatus(evidence) {
  for (const { status, re } of STATUS_MARKERS) {
    for (const e of evidence) {
      const m = String(e.excerpt ?? '').match(re);
      if (m) return { status, evidenceRef: e.id, marker: m[0].trim() };
    }
  }
  return null;
}

export function inferKind(text) {
  const s = String(text ?? '').toLowerCase();
  if (/\bintegrat|\bconnect(s|ed|or)?\b|\bsync(s|ed)? with\b|\bwebhook\b/.test(s)) return 'integration';
  if (/\bfix(es|ed)?\b|\bbug\b|\bregression\b/.test(s) && !/\badd(s|ed)?\b|\bnew\b/.test(s)) return 'fix';
  if (/\bfaster\b|\bimprove|\bbetter\b|\breduce/.test(s) && !/\badd(s|ed)?\b|\bnew\b/.test(s)) return 'improvement';
  return 'feature';
}

/* --------------------------------------------------------------- brief build */

/**
 * Pure core: turns already-fetched GitHub payloads into a feature brief.
 * Everything network-shaped is passed in, so this is fully testable offline.
 */
export function buildBrief(input) {
  const {
    repo,
    ref,
    range,
    localPath,
    readAt = new Date().toISOString(),
    feature = null,
    releases = [],
    changelog = null,
    pulls = [],
    files = [],
    docs = [],
  } = input;

  const evidence = [];
  const excluded = [];
  const byId = new Map();

  const addEvidence = (entry) => {
    const excerpt = excerptOf(entry.excerpt);
    if (!excerpt) return null;
    let id = entry.id;
    let n = 2;
    while (byId.has(id)) id = `${entry.id}-${n++}`;
    const e = { id, type: entry.type, excerpt };
    for (const k of ['url', 'path', 'ref', 'date']) if (entry[k]) e[k] = entry[k];
    evidence.push(e);
    byId.set(id, e);
    return id;
  };

  const candidates = [];

  // 1. Releases.
  for (const rel of releases) {
    const tag = rel.tag_name ?? rel.name ?? 'release';
    const body = String(rel.body ?? '').trim();
    if (!body) {
      excluded.push({
        claim: rel.name || tag,
        reason: `release ${tag} has an empty body — nothing citable to build a claim from`,
      });
      continue;
    }
    const id = addEvidence({
      id: `rel-${slug(tag)}`,
      type: 'release',
      url: rel.html_url,
      ref: tag,
      date: rel.published_at ?? rel.created_at,
      excerpt: body,
    });
    if (!id) continue;
    const bullets = splitBullets(body);
    const lines = bullets.length ? bullets : [firstSentence(body)];
    for (const line of lines) {
      const statement = toStatement(line);
      if (statement) candidates.push({ statement, evidenceRefs: [id], priority: 1 });
    }
  }

  // 2. CHANGELOG.
  if (changelog?.text) {
    const id = addEvidence({
      id: 'chg-1',
      type: 'changelog',
      path: changelog.path,
      url: changelog.url,
      ref: changelog.ref,
      excerpt: changelog.text,
    });
    if (id) {
      for (const line of splitBullets(changelog.text)) {
        const statement = toStatement(line);
        if (statement) candidates.push({ statement, evidenceRefs: [id], priority: 2 });
      }
    }
  }

  // 3. Merged pull requests.
  for (const pr of pulls.slice(0, MAX_PULLS)) {
    const title = cleanBullet(pr.title ?? '');
    const body = String(pr.body ?? '').trim();
    const text = [title, body].filter(Boolean).join('\n\n');
    if (!text) {
      excluded.push({
        claim: `pull request #${pr.number}`,
        reason: 'merged PR has no title or body text — no excerpt to cite',
      });
      continue;
    }
    const id = addEvidence({
      id: `pr-${pr.number}`,
      type: 'pull-request',
      url: pr.html_url,
      ref: String(pr.number),
      date: pr.closed_at ?? pr.updated_at,
      excerpt: text,
    });
    if (!id) continue;
    const statement = toStatement(title);
    if (statement && !NOISE_BULLET.test(statement)) {
      candidates.push({ statement, evidenceRefs: [id], priority: 3 });
    }
  }

  // 4. Documentation (README, docs/*.md) — cited for status, not for capabilities.
  for (const [i, doc] of docs.entries()) {
    addEvidence({
      id: `doc-${i + 1}`,
      type: 'docs',
      path: doc.path,
      url: doc.url,
      ref: doc.ref,
      excerpt: doc.text ?? doc.content,
    });
  }

  // 5. Source files -> surfaces, with a verbatim excerpt of the lines read.
  const surfaces = [];
  for (const file of files.slice(0, MAX_SOURCE_FILES)) {
    const strings = extractUiStrings(file.content);
    const routes = extractRoutes(file.path, file.content);
    if (strings.length === 0 && routes.length === 0) continue;

    const excerpt = excerptOf(strings.map((s) => s.line).join('\n'), 900);
    const id = excerpt
      ? addEvidence({
          id: `src-${slug(basename(file.path))}`,
          type: 'source-file',
          path: file.path,
          url: file.url,
          ref: file.ref,
          excerpt,
        })
      : null;

    // An element survives only if its label is verbatim inside the excerpt.
    const elements = [];
    for (const s of strings) {
      if (!id || !byId.get(id).excerpt.includes(s.label)) {
        excluded.push({ claim: s.label, reason: `UI string in ${file.path} did not survive into a citable excerpt` });
        continue;
      }
      elements.push({ role: s.role, label: s.label, evidenceRef: id });
    }
    if (elements.length === 0 && routes.length === 0) continue;

    // A focused page component has one heading and that heading names the
    // screen. A monolith has many, and the first one is usually an error or a
    // dialog title — the component name is the more honest label there.
    const headings = elements.filter((e) => e.role === 'heading');
    const surface = {
      id: slug(basename(file.path, extname(file.path))),
      componentPath: file.path,
      title: headings.length === 1 ? headings[0].label : humanise(basename(file.path)),
    };
    if (routes[0]) surface.route = routes[0];
    if (elements.length) surface.elements = elements;
    surfaces.push(surface);
  }

  // Feature filter: strict first, relaxed only if strict finds nothing.
  let matched = candidates.filter((c) => matchesFeature(c.statement, feature, 'all'));
  let relaxed = false;
  if (feature && matched.length === 0 && candidates.length > 0) {
    matched = candidates.filter((c) => matchesFeature(c.statement, feature, 'any'));
    relaxed = matched.length > 0;
    if (relaxed) {
      excluded.push({
        claim: `every capability mentioning all of: ${featureTokens(feature).join(', ')}`,
        reason: 'no candidate matched the full feature term; fell back to a partial-term match',
      });
    }
  }

  if (feature && !evidence.some((e) => matchesFeature(e.excerpt, feature, 'any'))) {
    excluded.push({
      claim: String(feature),
      reason: 'feature term appears in no release, CHANGELOG entry, merged PR or source file that was read',
    });
  }

  // Merge duplicate statements, keep the strongest priority.
  const merged = new Map();
  for (const c of matched) {
    const key = c.statement.toLowerCase();
    const prev = merged.get(key);
    if (prev) {
      prev.evidenceRefs = [...new Set([...prev.evidenceRefs, ...c.evidenceRefs])];
      prev.priority = Math.min(prev.priority, c.priority);
    } else {
      merged.set(key, { ...c });
    }
  }

  const capabilities = [];
  for (const c of [...merged.values()].sort((a, b) => a.priority - b.priority)) {
    const refs = c.evidenceRefs.filter((r) => byId.has(r));
    if (refs.length === 0) {
      excluded.push({ claim: c.statement, reason: 'no resolvable evidence id after mining' });
      continue;
    }
    const cap = { statement: c.statement, evidenceRefs: refs, priority: c.priority };
    const surface = surfaceForStatement(c.statement, surfaces);
    if (surface) cap.surface = surface.id;
    capabilities.push(cap);
  }

  const inferred = inferStatus(evidence);
  const shipped = evidence
    .filter((e) => e.date && ['release', 'pull-request', 'commit', 'changelog'].includes(e.type))
    .map((e) => e.date)
    .sort();

  const primary = capabilities[0];
  const summarySource = primary
    ? byId.get(primary.evidenceRefs[0])
    : evidence.find((e) => e.type === 'release') ?? evidence[0];

  const name =
    (feature && titleTerm(String(feature).trim())) ||
    releases[0]?.name ||
    releases[0]?.tag_name ||
    (primary ? primary.statement : humanise(repo.split('/')[1] ?? repo));

  const brief = {
    feature: {
      name,
      kind: inferKind(capabilities.map((c) => c.statement).join(' ') || name),
      summary: primary ? withStop(primary.statement) : firstSentence(summarySource?.excerpt ?? name),
    },
    source: { repo, readAt },
    capabilities,
    surfaces,
    evidence,
    excluded,
  };

  if (ref) brief.source.ref = ref;
  if (range) brief.source.range = range;
  if (localPath) brief.source.localPath = localPath;
  if (inferred) brief.feature.status = inferred.status;
  if (shipped[0]) brief.feature.shippedAt = String(shipped[0]).slice(0, 10);

  return brief;
}

function withStop(s) {
  return /[.?]$/.test(s) ? s : `${s}.`;
}

/** A search term typed in lower case still has to read as a title on screen. */
function titleTerm(term) {
  return /[A-Z]/.test(term) ? term : term.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

function surfaceForStatement(statement, surfaces) {
  if (surfaces.length === 0) return null;
  const words = new Set(
    statement
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );
  let best = null;
  let bestScore = 0;
  for (const s of surfaces) {
    const hay = [s.title, s.route, s.componentPath, ...(s.elements ?? []).map((e) => e.label)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return bestScore > 0 ? best : null;
}

/** Every evidenceRef in the brief must resolve. Returns the dangling ones. */
export function danglingRefs(brief) {
  const ids = new Set((brief.evidence ?? []).map((e) => e.id));
  const bad = [];
  for (const c of brief.capabilities ?? []) {
    for (const r of c.evidenceRefs ?? []) if (!ids.has(r)) bad.push(`capability "${c.statement}" -> ${r}`);
  }
  for (const s of brief.surfaces ?? []) {
    for (const e of s.elements ?? []) {
      if (e.evidenceRef && !ids.has(e.evidenceRef)) bad.push(`surface ${s.id} element "${e.label}" -> ${e.evidenceRef}`);
    }
  }
  return bad;
}

/* ----------------------------------------------------------------- the stage */

export function parseRepo(value) {
  const m = String(value ?? '').match(/^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s.]+)(?:\.git)?\/?$/);
  if (!m) throw new Error(`--repo must be owner/name (got: ${value ?? '<missing>'})`);
  return `${m[1]}/${m[2]}`;
}

async function repoFromLocal(path, ctx) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'remote', 'get-url', 'origin'], {
      maxBuffer: 1024 * 1024,
    });
    return parseRepo(stdout.trim().replace(/^git@github\.com:/, 'https://github.com/'));
  } catch {
    ctx.debug?.(`could not read a GitHub origin from ${path}`);
    return null;
  }
}

async function localHeadSha(path) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', 'HEAD'], { maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

const CHANGELOG_PATHS = ['CHANGELOG.md', 'CHANGELOG', 'changelog.md', 'docs/CHANGELOG.md', 'CHANGES.md'];

export async function run(ctx) {
  const version = await requireGh(ctx);
  ctx.debug?.(version);

  const repo = ctx.repo ? parseRepo(ctx.repo) : ctx.local ? await repoFromLocal(resolve(ctx.cwd, ctx.local), ctx) : null;
  if (!repo) throw new Error('discover needs --repo owner/name (or --local <path> with a GitHub origin).');

  const feature = ctx.feature ?? null;
  const ref = ctx.ref ?? null;
  const out = resolve(ctx.cwd, ctx.out ?? 'feature-brief.json');

  // gh returns 404 for both "no such repo" and "no access", so say both.
  const meta = await ghOptional(['api', `repos/${repo}`], ctx);
  if (!meta) {
    throw new Error(
      `Cannot read ${repo}: it does not exist, or the signed-in gh account cannot see it. ` +
        `Check \`gh auth status\` — private repos need an account with access.`,
    );
  }
  ctx.log(`reading ${repo} (${meta.private ? 'private' : 'public'}, default branch ${meta.default_branch})${feature ? ` for "${feature}"` : ''}`);

  // A local checkout is only trusted when its HEAD matches the remote ref.
  let localPath = null;
  if (ctx.local) {
    const abs = resolve(ctx.cwd, ctx.local);
    const head = await localHeadSha(abs);
    const remote = await ghOptional(['api', `repos/${repo}/commits/${ref ?? 'HEAD'}`], ctx);
    if (head && remote?.sha === head) {
      localPath = abs;
      ctx.log(`local checkout is current at ${head.slice(0, 7)} — reading files from disk`);
    } else {
      ctx.log(`ignoring --local: HEAD ${head?.slice(0, 7) ?? '<unknown>'} != remote ${remote?.sha?.slice(0, 7) ?? '<unknown>'}`);
    }
  }

  // 1. Releases.
  const allReleases = (await ghOptional(['api', `repos/${repo}/releases?per_page=20`], ctx)) ?? [];
  let releases = allReleases.filter((r) => !r.draft);
  if (feature) {
    const hit = releases.filter((r) => matchesFeature(`${r.name ?? ''}\n${r.body ?? ''}`, feature, 'any'));
    if (hit.length) releases = hit;
  }
  releases = releases.slice(0, 5);
  ctx.log(`releases: ${releases.length} of ${allReleases.length}`);

  // 2. CHANGELOG.
  let changelog = null;
  for (const path of CHANGELOG_PATHS) {
    const file = await readSource(repo, path, ref, localPath, ctx);
    if (file) {
      changelog = { path: file.path, url: file.url, ref: file.ref, text: topChangelogSection(file.content, feature) };
      break;
    }
  }
  ctx.log(`changelog: ${changelog ? changelog.path : 'none found'}`);

  // 3. Merged PRs.
  const q = ['repo:' + repo, 'is:pr', 'is:merged', feature ?? ''].filter(Boolean).join(' ');
  let pulls = [];
  try {
    const search = await ghJson(
      ['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '-F', 'per_page=20', '-f', 'sort=updated'],
      ctx,
    );
    pulls = search?.items ?? [];
  } catch (err) {
    // A rejected search query must not sink a run that already has releases.
    ctx.log(`pull request search unavailable: ${err.message.split('\n')[0]}`);
  }
  ctx.log(`merged pull requests: ${pulls.length}`);

  // 4. Source files: paths changed by the top PRs, then a code search as backup.
  const paths = new Set();
  for (const pr of pulls.slice(0, 3)) {
    const changed = (await ghOptional(['api', `repos/${repo}/pulls/${pr.number}/files?per_page=50`], ctx)) ?? [];
    for (const f of changed) if (UI_EXTENSIONS.has(extname(f.filename))) paths.add(f.filename);
  }
  if (paths.size < MAX_SOURCE_FILES && feature) {
    for (const p of await codeSearch(repo, feature, ctx)) {
      if (UI_EXTENSIONS.has(extname(p))) paths.add(p);
    }
  }

  const files = [];
  for (const path of [...paths].slice(0, MAX_SOURCE_FILES)) {
    const file = await readSource(repo, path, ref, localPath, ctx);
    if (file) files.push(file);
  }
  ctx.log(`source files read: ${files.length}`);

  // 5. Docs — cited for status, never for capabilities.
  const docs = [];
  const readme = await readSource(repo, 'README.md', ref, localPath, ctx);
  if (readme) docs.push({ path: readme.path, url: readme.url, ref: readme.ref, text: statusSlice(readme.content, feature) });

  const brief = buildBrief({
    repo,
    ref,
    range: ctx.range ?? null,
    localPath,
    feature,
    releases,
    changelog,
    pulls,
    files,
    docs: docs.filter((d) => d.text),
  });

  const dangling = danglingRefs(brief);
  if (dangling.length) throw new Error(`evidence refs do not resolve:\n  ${dangling.join('\n  ')}`);

  const schema = await loadSchema('feature-brief.schema.json');
  const { ok, errors } = validateAgainstSchema(schema, brief);
  if (!ok) {
    throw new Error(`brief failed schema validation:\n  ${errors.map((e) => `${e.path}: ${e.message}`).join('\n  ')}`);
  }

  await writeJson(out, brief);

  ctx.log(
    `DISCOVER: OK  ${brief.capabilities.length} capabilities, ${brief.surfaces.length} surfaces, ` +
      `${brief.evidence.length} evidence, ${brief.excluded.length} excluded` +
      `${brief.feature.status ? `, status=${brief.feature.status}` : ', status=unstated (no citation)'}`,
  );
  ctx.log(`wrote ${out}`);
  return brief;
}

async function readSource(repo, path, ref, localPath, ctx) {
  if (localPath) {
    try {
      const content = await readFile(resolve(localPath, path), 'utf8');
      return { path, url: `https://github.com/${repo}/blob/${ref ?? 'HEAD'}/${path}`, ref: ref ?? undefined, content };
    } catch {
      /* fall through to the API */
    }
  }
  return fetchFile(repo, path, ref, ctx);
}

async function codeSearch(repo, feature, ctx) {
  try {
    const out = await gh(['search', 'code', '--repo', repo, '--limit', '15', '--json', 'path', ...featureTokens(feature)], ctx);
    return JSON.parse(out).map((r) => r.path);
  } catch (err) {
    ctx.debug?.(`code search unavailable: ${err.message}`);
    return [];
  }
}

/** The newest CHANGELOG section, or the first one mentioning the feature. */
export function topChangelogSection(text, feature) {
  const sections = normaliseText(text).split(/\n(?=#{1,3}\s)/);
  if (feature) {
    const hit = sections.find((s) => matchesFeature(s, feature, 'any'));
    if (hit) return hit.trim();
  }
  return (sections.find((s) => /^#{1,3}\s/.test(s) && splitBullets(s).length > 0) ?? sections[0] ?? '').trim();
}

/** Only the part of a doc that could justify a status claim. */
export function statusSlice(text, feature) {
  const lines = normaliseText(text).split('\n');
  const keep = [];
  for (const [i, line] of lines.entries()) {
    const relevant = STATUS_MARKERS.some((m) => m.re.test(line)) && (!feature || matchesFeature(lines.slice(Math.max(0, i - 2), i + 3).join(' '), feature, 'any'));
    if (relevant) keep.push(line.trim());
  }
  return keep.join('\n');
}
