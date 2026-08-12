/**
 * discover — unit tests over recorded gh JSON fixtures for the invented repo
 * acme/webapp. No network: buildBrief takes already-fetched payloads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBrief,
  danglingRefs,
  extractUiStrings,
  inferStatus,
  matchesFeature,
  routeFromFilePath,
  splitBullets,
  isUserFacingString,
} from '../discover.mjs';
import { loadSchema, validateAgainstSchema } from '../storyboard.mjs';

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const json = async (name) => JSON.parse(await readFile(resolve(FIX, name), 'utf8'));
const text = (name) => readFile(resolve(FIX, name), 'utf8');

async function fixtureInput(overrides = {}) {
  const releases = await json('releases.json');
  const pulls = (await json('pulls-search.json')).items;
  const changelogText = await text('CHANGELOG.md');
  const connections = await text('files/connections.tsx');
  const billing = await text('files/billing.tsx');

  return {
    repo: 'acme/webapp',
    ref: 'v2.5.0',
    readAt: '2026-03-03T00:00:00Z',
    feature: 'Connections',
    releases,
    pulls,
    changelog: {
      path: 'CHANGELOG.md',
      url: 'https://github.com/acme/webapp/blob/v2.5.0/CHANGELOG.md',
      text: changelogText.split('\n## 2.4.1')[0],
    },
    files: [
      {
        path: 'apps/web/src/pages/connections.tsx',
        url: 'https://github.com/acme/webapp/blob/v2.5.0/apps/web/src/pages/connections.tsx',
        ref: 'v2.5.0',
        content: connections,
      },
      {
        path: 'apps/web/src/pages/billing.tsx',
        url: 'https://github.com/acme/webapp/blob/v2.5.0/apps/web/src/pages/billing.tsx',
        ref: 'v2.5.0',
        content: billing,
      },
    ],
    docs: [],
    ...overrides,
  };
}

test('brief built from recorded fixtures matches feature-brief.schema.json', async () => {
  const brief = buildBrief(await fixtureInput());
  const schema = await loadSchema('feature-brief.schema.json');
  const { ok, errors } = validateAgainstSchema(schema, brief);
  assert.ok(ok, JSON.stringify(errors, null, 2));
  assert.equal(brief.source.repo, 'acme/webapp');
  assert.equal(brief.source.ref, 'v2.5.0');
  assert.ok(brief.capabilities.length >= 3, `expected capabilities, got ${brief.capabilities.length}`);
});

test('every evidenceRef resolves to a real evidence entry', async () => {
  const brief = buildBrief(await fixtureInput());
  assert.deepEqual(danglingRefs(brief), []);
  const ids = new Set(brief.evidence.map((e) => e.id));
  assert.ok(ids.size === brief.evidence.length, 'evidence ids must be unique');
  for (const cap of brief.capabilities) {
    assert.ok(cap.evidenceRefs.length >= 1, `${cap.statement} has no citation`);
    for (const ref of cap.evidenceRefs) assert.ok(ids.has(ref), `${cap.statement} cites missing ${ref}`);
  }
});

test('every evidence excerpt is real text, and every element label is verbatim inside its excerpt', async () => {
  const brief = buildBrief(await fixtureInput());
  const byId = new Map(brief.evidence.map((e) => [e.id, e]));
  for (const e of brief.evidence) assert.ok(e.excerpt.trim().length > 0, `${e.id} has an empty excerpt`);

  let checked = 0;
  for (const surface of brief.surfaces) {
    for (const el of surface.elements ?? []) {
      const evidence = byId.get(el.evidenceRef);
      assert.ok(evidence, `element "${el.label}" cites missing ${el.evidenceRef}`);
      assert.ok(
        evidence.excerpt.includes(el.label),
        `element "${el.label}" is not verbatim in the excerpt of ${el.evidenceRef}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 5, `expected several cited UI elements, checked ${checked}`);
});

test('a release with an empty body produces no claim and lands in excluded', async () => {
  const brief = buildBrief(await fixtureInput());
  const entry = brief.excluded.find((x) => /v2\.4\.1/.test(x.claim));
  assert.ok(entry, `expected v2.4.1 in excluded, got ${JSON.stringify(brief.excluded)}`);
  assert.match(entry.reason, /empty body|nothing citable/i);
  assert.ok(!brief.evidence.some((e) => e.ref === 'v2.4.1'), 'an empty release must not become evidence');
});

test('a feature term nothing cites is excluded, not softened into a claim', async () => {
  const brief = buildBrief(await fixtureInput({ feature: 'telemetry' }));
  const entry = brief.excluded.find((x) => x.claim === 'telemetry');
  assert.ok(entry, `expected the uncited term in excluded, got ${JSON.stringify(brief.excluded)}`);
  assert.match(entry.reason, /appears in no release|CHANGELOG|merged PR|source file/i);
  for (const cap of brief.capabilities) {
    assert.ok(!/telemetry/i.test(cap.statement), 'no capability may assert the uncited term');
  }
});

test('a merged PR with no title or body text is excluded rather than cited', () => {
  const brief = buildBrief({
    repo: 'acme/webapp',
    feature: null,
    releases: [],
    pulls: [{ number: 900, title: '', body: '', html_url: 'https://github.com/acme/webapp/pull/900' }],
    files: [],
    changelog: {
      path: 'CHANGELOG.md',
      text: '## 1.0.0\n\n- Connect a PaymentsCo account from the Connections page',
    },
  });
  const entry = brief.excluded.find((x) => x.claim === 'pull request #900');
  assert.ok(entry, JSON.stringify(brief.excluded));
  assert.ok(!brief.evidence.some((e) => e.id === 'pr-900'));
});

test('noise commits never become capability claims', async () => {
  const brief = buildBrief(await fixtureInput({ feature: null }));
  for (const cap of brief.capabilities) {
    assert.ok(!/^(chore|bump|merge|revert|full changelog)/i.test(cap.statement), `noise claim: ${cap.statement}`);
  }
});

test('status: a Beta pill in source infers beta', async () => {
  const input = await fixtureInput();
  const brief = buildBrief(input);
  assert.equal(brief.feature.status, 'beta');

  const hit = inferStatus(brief.evidence);
  assert.equal(hit.status, 'beta');
  assert.ok(
    brief.evidence.some((e) => e.id === hit.evidenceRef),
    'the status citation must resolve to a real evidence entry',
  );
});

test('status: a self-serve GA doc infers ga and outranks a stale beta pill', async () => {
  const input = await fixtureInput({
    docs: [
      {
        path: 'docs/connections.md',
        url: 'https://github.com/acme/webapp/blob/v2.5.0/docs/connections.md',
        text: 'Connections is generally available on every plan. The beta gate was removed in 2.5.0.',
      },
    ],
  });
  const brief = buildBrief(input);
  assert.equal(brief.feature.status, 'ga');
  const hit = inferStatus(brief.evidence);
  assert.equal(hit.status, 'ga');
  assert.equal(brief.evidence.find((e) => e.id === hit.evidenceRef).type, 'docs');
});

test('status is left unstated when nothing cites one — GA is never assumed', () => {
  const brief = buildBrief({
    repo: 'acme/webapp',
    feature: null,
    releases: [],
    pulls: [],
    files: [],
    changelog: { path: 'CHANGELOG.md', text: '## 1.0.0\n\n- Connect a PaymentsCo account in two clicks' },
  });
  assert.equal(brief.feature.status, undefined);
  assert.equal(inferStatus(brief.evidence), null);
});

test('extractUiStrings returns the literal product wording with its source line', async () => {
  const strings = extractUiStrings(await text('files/connections.tsx'));
  const byLabel = new Map(strings.map((s) => [s.label, s]));

  assert.equal(byLabel.get('Connections')?.role, 'heading');
  assert.equal(byLabel.get('Connect account')?.role, 'button');
  assert.equal(byLabel.get('Beta')?.role, 'badge');
  assert.equal(byLabel.get('Search connections')?.role, 'field');
  assert.ok(byLabel.has('Link the tools your team already uses.'));

  for (const s of strings) assert.ok(s.line.includes(s.label), `${s.label} not in its own source line`);
  for (const s of strings) assert.ok(!/className|useState|import /.test(s.label), `code leaked: ${s.label}`);
});

test('surfaces carry the route and the component path read from the repo', async () => {
  const brief = buildBrief(await fixtureInput());
  const surface = brief.surfaces.find((s) => s.id === 'connections');
  assert.ok(surface, JSON.stringify(brief.surfaces.map((s) => s.id)));
  assert.equal(surface.route, '/connections');
  assert.equal(surface.componentPath, 'apps/web/src/pages/connections.tsx');
  assert.equal(surface.title, 'Connections');
});

test('helpers', () => {
  assert.equal(routeFromFilePath('apps/web/src/pages/connections.tsx'), '/connections');
  assert.equal(routeFromFilePath('src/app/(marketing)/pricing/page.tsx'), '/pricing');
  assert.equal(routeFromFilePath('src/lib/util.ts'), null);

  assert.deepEqual(splitBullets('- One thing\n* Two thing\n\nprose\n- chore: bump deps'), ['One thing', 'Two thing']);
  // GitHub bodies are CRLF; `.` does not match \r, so unnormalised text yielded nothing.
  assert.deepEqual(splitBullets('### Fixes\r\n\r\n- One thing\r\n- Two thing\r\n'), ['One thing', 'Two thing']);
  assert.deepEqual(splitBullets('- Fix: preserve the body on redirects (#2460)  aee9249\r\n'), [
    'Fix: preserve the body on redirects',
  ]);

  assert.ok(matchesFeature('Connections page limits', 'connections'));
  assert.ok(!matchesFeature('Billing page', 'connections'));
  assert.ok(matchesFeature('anything', null));

  assert.ok(isUserFacingString('Connect account'));
  assert.ok(!isUserFacingString('onClick'));
  assert.ok(!isUserFacingString('connections-page'));
  assert.ok(!isUserFacingString('{value}'));
});
