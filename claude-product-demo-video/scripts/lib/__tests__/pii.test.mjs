import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTextRules, AUTO_PII_PATTERNS } from '../capture.mjs';

/** Apply rules the same way the in-page evaluate does, so the test covers the real logic. */
function redact(input, pii) {
  let out = input;
  for (const r of buildTextRules(pii)) {
    out = out.replace(new RegExp(r.source, r.flags), (m) => {
      if (r.minDigits && (m.match(/\d/g) ?? []).length < r.minDigits) return m;
      return r.replacement;
    });
  }
  return out;
}

test('email is redacted wherever it appears', () => {
  const out = redact('write to a.b-c+tag@sub.example.co.uk now', { autoRedact: ['email'] });
  assert.equal(out, 'write to you@example.com now');
});

test('phone is redacted across common formats', () => {
  const pii = { autoRedact: ['phone'] };
  assert.equal(redact('call +61 412 345 678', pii), 'call 04xx xxx xxx');
  assert.equal(redact('call 0412 345 678', pii), 'call 04xx xxx xxx');
  assert.equal(redact('call (07) 3555 1234', pii), 'call (04xx xxx xxx');
});

test('the minDigits guard protects job numbers, totals and dates', () => {
  // This is the whole reason the guard exists: a loose digit run also matches
  // things that must survive, and mangling them makes the footage look broken.
  const pii = { autoRedact: ['phone'] };
  assert.equal(redact('Job JOB-2843', pii), 'Job JOB-2843');
  assert.equal(redact('Invoice INV-1042', pii), 'Invoice INV-1042');
  assert.equal(redact('Total $1,480.00', pii), 'Total $1,480.00');
  assert.equal(redact('Due 12/08/2026', pii), 'Due 12/08/2026');
});

test('a literal string is regex-escaped, not interpreted', () => {
  const out = redact('owner a.b (co)', {
    redactText: [{ text: 'a.b (co)', replacement: 'Acme' }],
  });
  assert.equal(out, 'owner Acme');
  // The dot must not have matched any character.
  assert.equal(redact('axb (co)', { redactText: [{ text: 'a.b (co)', replacement: 'Acme' }] }), 'axb (co)');
});

test('literal matching is case-insensitive unless told otherwise', () => {
  const rule = [{ text: 'Dana Whitfield', replacement: 'X' }];
  assert.equal(redact('dana whitfield', { redactText: rule }), 'X');
  assert.equal(
    redact('dana whitfield', { redactText: [{ ...rule[0], caseSensitive: true }] }),
    'dana whitfield',
  );
});

test('autoRedact and redactText compose', () => {
  const out = redact('sam@acme.example / +61 412 345 678 / Sam Okonkwo', {
    autoRedact: ['email', 'phone'],
    redactText: [{ text: 'Sam Okonkwo', replacement: 'Dana Whitfield' }],
  });
  assert.equal(out, 'you@example.com / 04xx xxx xxx / Dana Whitfield');
});

test('no rules means no change', () => {
  assert.equal(redact('untouched', {}), 'untouched');
  assert.deepEqual(buildTextRules({}), []);
});

test('the phone preset carries its digit guard', () => {
  assert.equal(AUTO_PII_PATTERNS.phone.minDigits, 8);
});
