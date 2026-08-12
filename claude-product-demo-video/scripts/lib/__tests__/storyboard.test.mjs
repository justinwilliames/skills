/**
 * storyboard — built from the same acme/webapp fixtures, validated against the
 * real schema by the bundled draft-07 subset validator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBrief } from '../discover.mjs';
import { buildFromSpec, collectProvenance } from '../demo.mjs';
import {
  buildStoryboard,
  copyCheck,
  estimateTotalMs,
  kenBurns,
  loadSchema,
  narrate,
  oneIdea,
  stripBanned,
  traceability,
  validateAgainstSchema,
} from '../storyboard.mjs';

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const json = async (name) => JSON.parse(await readFile(resolve(FIX, name), 'utf8'));
const text = (name) => readFile(resolve(FIX, name), 'utf8');

async function fixtures() {
  const brief = buildBrief({
    repo: 'acme/webapp',
    ref: 'v2.5.0',
    readAt: '2026-03-03T00:00:00Z',
    feature: 'Connections',
    releases: await json('releases.json'),
    pulls: (await json('pulls-search.json')).items,
    changelog: { path: 'CHANGELOG.md', text: (await text('CHANGELOG.md')).split('\n## 2.4.1')[0] },
    files: [
      { path: 'apps/web/src/pages/connections.tsx', ref: 'v2.5.0', content: await text('files/connections.tsx') },
      { path: 'apps/web/src/pages/billing.tsx', ref: 'v2.5.0', content: await text('files/billing.tsx') },
    ],
    docs: [],
  });
  const brand = await json('brand.json');
  return { brief, brand };
}

const build = async () => {
  const { brief, brand } = await fixtures();
  return { brief, brand, ...buildStoryboard({ brief, brand, storyboardDir: '/tmp/sb', workDir: '/tmp/sb/work' }) };
};

test('storyboard validates against storyboard.schema.json', async () => {
  const { storyboard } = await build();
  const schema = await loadSchema('storyboard.schema.json');
  const { ok, errors } = validateAgainstSchema(schema, storyboard);
  assert.ok(ok, JSON.stringify(errors, null, 2));
});

test('the cut is title -> context -> capabilities -> proof -> outro', async () => {
  const { storyboard } = await build();
  const ids = storyboard.scenes.map((s) => s.id);
  assert.equal(ids[0], 'title');
  assert.equal(ids[1], 'context');
  assert.equal(ids.at(-1), 'outro');
  const caps = ids.filter((id) => id.startsWith('capability-'));
  assert.ok(caps.length >= 2 && caps.length <= 4, `capability scenes: ${caps.length}`);
  assert.ok(ids.includes('proof') || ids.includes('summary'));
});

test('runtime lands inside the 45-90s target', async () => {
  const { estimateMs } = await build();
  assert.ok(estimateMs <= 90_000, `${estimateMs}ms is over the 90s ceiling`);
  assert.ok(estimateMs >= 20_000, `${estimateMs}ms is implausibly short`);
});

test('narrated scenes leave durationMs unset so voice measurement drives timing', async () => {
  const { storyboard } = await build();
  for (const scene of storyboard.scenes) {
    if (scene.narration) assert.equal(scene.durationMs, undefined, `${scene.id} pins its own duration`);
  }
});

test('every claim-bearing scene cites evidence that exists in the brief', async () => {
  const { storyboard, brief } = await build();
  const rows = traceability(storyboard, brief);
  assert.deepEqual(rows.filter((r) => !r.ok), []);
  const claims = rows.filter((r) => !r.structural);
  assert.ok(claims.length >= 3, `expected cited scenes, got ${claims.length}`);
  for (const r of claims) assert.deepEqual(r.dangling, []);
});

test('copy: no exclamation marks, no banned words, one idea per sentence', async () => {
  const { storyboard, brand } = await build();
  assert.deepEqual(copyCheck(storyboard, brand), []);
  for (const scene of storyboard.scenes) {
    assert.ok(scene.narration.length > 0, `${scene.id} has no narration`);
    assert.ok(scene.narration.split(/\s+/).length <= 26, `${scene.id} narration runs long: ${scene.narration}`);
  }
});

test('consecutive scenes never repeat the same move', async () => {
  const { storyboard } = await build();
  for (let i = 1; i < storyboard.scenes.length; i += 1) {
    assert.notEqual(
      JSON.stringify(storyboard.scenes[i - 1].motion),
      JSON.stringify(storyboard.scenes[i].motion),
      `scenes ${storyboard.scenes[i - 1].id} and ${storyboard.scenes[i].id} make the same move`,
    );
  }
});

test('a generated kenburns move actually pans — centred poses made the fix inert', () => {
  // kenBurns() used to hard-code [0.5,0.5,z] endpoints, which overrode whatever
  // motion.mjs derived: every card got the identical dead-centre zoom.
  const seen = new Set();
  for (let i = 0; i < 4; i += 1) {
    const m = kenBurns(i, { motion: { kenBurnsIntensity: 0.08 } });
    const lateral = Math.abs(m.to[0] - m.from[0]) * 1920;
    assert.ok(lateral > 24, `scene ${i} pans only ${lateral.toFixed(1)}px`);
    assert.ok(m.from[0] !== 0.5 || m.to[0] !== 0.5, `scene ${i} sits dead centre at both ends`);
    seen.add(JSON.stringify([m.from, m.to]));
  }
  assert.equal(seen.size, 4, 'four consecutive scenes should not make the same move');
});

test('a generated kenburns move stays inside the crop budget its intensity implies', () => {
  const intensity = 0.08;
  const budget = 0.5 - 0.5 / (1 + intensity);
  for (let i = 0; i < 4; i += 1) {
    const m = kenBurns(i, { motion: { kenBurnsIntensity: intensity } });
    for (const [cx, cy, z] of [m.from, m.to]) {
      const crop = Math.max(Math.abs(cx - 0.5), Math.abs(cy - 0.5)) + (0.5 - 0.5 / z);
      assert.ok(crop <= budget + 1e-12, `scene ${i} crops ${crop} of a ${budget} budget`);
    }
  }
});

test('transitions come from the brand and alternate', async () => {
  const { storyboard, brand } = await build();
  const transitions = storyboard.scenes.map((s) => s.transitionOut).filter(Boolean);
  assert.equal(transitions.length, storyboard.scenes.length - 1);
  assert.equal(transitions[0].type, brand.motion.defaultTransition);
  for (const t of transitions) assert.equal(t.durationMs, brand.motion.transitionMs);
  for (let i = 1; i < transitions.length; i += 1) {
    assert.notEqual(transitions[i - 1].type, transitions[i].type);
  }
});

test('a demo scene reuses the literal UI strings read out of the repo', async () => {
  const { storyboard, demoSpecs } = await build();
  const demo = storyboard.scenes.find((s) => s.capture.kind === 'demo');
  assert.ok(demo, 'expected at least one demo scene for a repo with UI surfaces');
  assert.ok(demo.capture.flow.length > 0);
  assert.ok(demo.capture.spec.endsWith('demo-spec.json'));

  const spec = demoSpecs.find((d) => d.spec.id === demo.capture.app)?.spec;
  assert.ok(spec, 'the scene references a demo spec that was emitted');
  const screen = spec.screens[0];
  assert.equal(screen.title, 'Connections');
  const strings = screen.elements.map((e) => e.label ?? e.text);
  assert.ok(strings.includes('Connect account'), JSON.stringify(strings));
  assert.ok(strings.includes('Beta'), JSON.stringify(strings));
  assert.equal(spec.topbar.search, 'Search connections');

  const selectors = new Set([`[data-screen="${screen.id}"]`, ...screen.elements.map((e) => `#${e.id}`)]);
  for (const step of demo.capture.flow) {
    if (step.selector) assert.ok(selectors.has(step.selector), `flow targets an element the spec does not define: ${step.selector}`);
  }
  assert.ok(!demo.capture.flow.some((s) => s.action === 'fill'), 'demo fields render as divs, so fill would throw');
  assert.equal(demo.motion.type, 'autozoom');
  assert.ok(selectors.has(demo.motion.target));
});

test('the emitted demo spec is what demo.mjs actually consumes', async () => {
  const { storyboard, demoSpecs, brand } = await build();
  const demo = storyboard.scenes.find((s) => s.capture.kind === 'demo');
  const spec = demoSpecs.find((d) => d.spec.id === demo.capture.app).spec;

  const outDir = await mkdtemp(join(tmpdir(), 'pdv-demo-'));
  const built = await buildFromSpec(spec, outDir, brand, { cwd: outDir });
  assert.equal(built.app, spec.id);

  const html = await readFile(join(built.dir, 'index.html'), 'utf8');
  assert.match(html, /Connect account/);
  assert.match(html, /id="el-\d+"/);

  // Provenance must separate repo wording from the invented sample rows.
  const p = collectProvenance(spec);
  assert.ok(p.counts.evidence >= 4, JSON.stringify(p.counts));
  assert.ok(p.counts.sample >= 4, JSON.stringify(p.counts));
  assert.ok(p.fields.some((f) => f.value === 'Connect account' && f.origin === 'evidence'));
  assert.ok(p.fields.some((f) => f.value === 'Acme Pty Ltd' && f.origin === 'sample'));
});

test('a brief with no cited capability produces no video at all', () => {
  assert.throws(
    () => buildStoryboard({ brief: { feature: { name: 'x' }, evidence: [], capabilities: [] }, brand: {}, storyboardDir: '/tmp', workDir: '/tmp/work' }),
    /nothing this video is allowed to claim/,
  );
});

test('copy helpers', () => {
  assert.equal(stripBanned('A seamless, revolutionary flow', ['seamless', 'revolutionary']), 'A, flow');
  assert.equal(narrate('Adds support for per-workspace limits', {}), 'You can now use per-workspace limits.');
  assert.equal(narrate('Fixed a crash on open!', {}), 'We fixed a crash on open.');
  assert.equal(
    oneIdea('one two three four five six, and seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 8),
    'one two three four five six',
  );
  // A complete first sentence is preferred over a clause cut that would drop a list item.
  assert.equal(
    oneIdea('Called only when a retry is allowed by limit, methods, and errorCodes. Set the option to opt out.', 12),
    'Called only when a retry is allowed by limit, methods, and errorCodes.',
  );
});

test('the validator enforces the draft-07 subset it claims to', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    additionalProperties: false,
    properties: {
      a: { type: 'string', pattern: '^[a-z]+$' },
      b: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } },
      c: { enum: ['x', 'y'] },
      d: { oneOf: [{ type: 'object', properties: { k: { const: 'p' } }, required: ['k'], additionalProperties: false }, { type: 'string' }] },
    },
  };
  assert.ok(validateAgainstSchema(schema, { a: 'ok', b: [1], c: 'x', d: { k: 'p' } }).ok);
  assert.ok(!validateAgainstSchema(schema, { a: 'NO' }).ok, 'pattern must fail');
  assert.ok(!validateAgainstSchema(schema, {}).ok, 'required must fail');
  assert.ok(!validateAgainstSchema(schema, { a: 'ok', z: 1 }).ok, 'additionalProperties:false must fail');
  assert.ok(!validateAgainstSchema(schema, { a: 'ok', b: [] }).ok, 'minItems must fail');
  assert.ok(!validateAgainstSchema(schema, { a: 'ok', b: [-1] }).ok, 'minimum must fail');
  assert.ok(!validateAgainstSchema(schema, { a: 'ok', c: 'z' }).ok, 'enum must fail');
  assert.ok(!validateAgainstSchema(schema, { a: 'ok', d: { k: 'q' } }).ok, 'const inside oneOf must fail');

  const withRef = { definitions: { leaf: { type: 'integer' } }, type: 'array', items: { $ref: '#/definitions/leaf' } };
  assert.ok(validateAgainstSchema(withRef, [1, 2]).ok);
  assert.ok(!validateAgainstSchema(withRef, [1, 'two']).ok, '$ref must be followed');
});

test('estimateTotalMs subtracts transition overlap', () => {
  const scenes = [
    { narration: 'one two three four five six seven eight nine ten', transitionOut: { durationMs: 600 } },
    { durationMs: 4000 },
  ];
  const total = estimateTotalMs(scenes, 150);
  assert.equal(total, Math.round((10 / 150) * 60_000 + 900) + 4000 - 600);
});
