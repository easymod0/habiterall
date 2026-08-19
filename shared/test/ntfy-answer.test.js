import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const {
  NTFY_ANSWER_PATH, signNtfyAnswer, verifyNtfyAnswer, handleNtfyAnswer, ntfyActions,
} = await import('../src/ntfy-answer.js');

const SECRET = 'a-test-secret-that-is-long-enough';

const habit = (over = {}) => ({
  id: 7, name: 'Meditate', description: '', type: 'boolean', unit: '',
  target_value: 0, target_type: 'at_least', freq_numerator: 1,
  freq_denominator: 1, color: '#3b82f6', reminder_time: '08:00',
  reminder_message: '', archived: false, ...over,
});

// All three of `isAvoided`'s questions are set on purpose — a two-of-three
// fixture pins nothing, because the predicate would still read false and the
// test would pass against the unfixed code (see #221).
const avoid = (over = {}) => habit({
  type: 'numerical', target_type: 'at_most', target_value: 0,
  show_as: 'avoid', unit: 'cigarettes', ...over,
});

const numeric = (over = {}) => habit({
  type: 'numerical', target_type: 'at_least', target_value: 8, unit: 'glasses', ...over,
});

const sign = (fields) => signNtfyAnswer({ secret: SECRET, account: 'acct1', ...fields });

/* ---------- the code ---------- */

test('a code round-trips every field unchanged', () => {
  const token = signNtfyAnswer({
    secret: SECRET, account: 'acct1', habitId: 7, date: '2026-08-13',
    action: 'yes', value: 3, test: false,
  });
  assert.deepEqual(verifyNtfyAnswer(token, { secret: SECRET }), {
    account: 'acct1', habitId: 7, date: '2026-08-13', action: 'yes', value: 3, test: false,
  });
});

test('the MAC segment is exactly 22 base64url characters', () => {
  const token = sign({ habitId: 7, date: '2026-08-13', action: 'yes' });
  const [, , mac] = token.split('.');
  assert.equal(mac.length, 22, `expected a 16-byte MAC (22 base64url chars), got "${mac}"`);
});

test('a tampered payload is rejected', () => {
  const token = sign({ habitId: 7, date: '2026-08-13', action: 'yes' });
  const [version, payload, mac] = token.split('.');
  // Flip a byte in the payload — re-encode it as a different habit id.
  const tampered = Buffer.from(Buffer.from(payload, 'base64url').toString('utf8')
    .replace('"habitId":7', '"habitId":8'), 'utf8').toString('base64url');
  assert.equal(verifyNtfyAnswer(`${version}.${tampered}.${mac}`, { secret: SECRET }), null);
});

test('a tampered MAC is rejected', () => {
  const token = sign({ habitId: 7, date: '2026-08-13', action: 'yes' });
  const [version, payload, mac] = token.split('.');
  const flipped = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);
  assert.equal(verifyNtfyAnswer(`${version}.${payload}.${flipped}`, { secret: SECRET }), null);
});

test('a truncated MAC is rejected, not thrown into a crash', () => {
  const token = sign({ habitId: 7, date: '2026-08-13', action: 'yes' });
  const [version, payload, mac] = token.split('.');
  assert.equal(
    verifyNtfyAnswer(`${version}.${payload}.${mac.slice(0, 4)}`, { secret: SECRET }), null);
});

test('a wrong version prefix is rejected', () => {
  const token = sign({ habitId: 7, date: '2026-08-13', action: 'yes' });
  const [, payload, mac] = token.split('.');
  assert.equal(verifyNtfyAnswer(`v2.${payload}.${mac}`, { secret: SECRET }), null);
});

test('a code signed with a different secret is rejected', () => {
  const token = sign({ habitId: 7, date: '2026-08-13', action: 'yes' });
  assert.equal(verifyNtfyAnswer(token, { secret: 'a different secret entirely' }), null);
});

test('a payload re-pointed at another account is rejected', () => {
  // Editing `account` after signing is exactly the tamper a forger would try —
  // it must fail the MAC the same way any other field edit does.
  const token = sign({ habitId: 7, date: '2026-08-13', action: 'yes' });
  const [version, payload, mac] = token.split('.');
  const repointed = Buffer.from(Buffer.from(payload, 'base64url').toString('utf8')
    .replace('"acct1"', '"acct2"'), 'utf8').toString('base64url');
  assert.equal(verifyNtfyAnswer(`${version}.${repointed}.${mac}`, { secret: SECRET }), null);
});

test('malformed tokens never throw', () => {
  for (const bad of [
    '', 'not-a-token', 'v1.onlyonepart', 'v1..', 'v1.a.b.c', null, undefined, 42, {},
  ]) {
    assert.doesNotThrow(() => verifyNtfyAnswer(bad, { secret: SECRET }));
    assert.equal(verifyNtfyAnswer(bad, { secret: SECRET }), null);
  }
});

test('the signing key is derived — signing with the raw secret does not verify', () => {
  // Sign "by hand" with the raw secret rather than the derived key, in the
  // exact shape `signNtfyAnswer` produces, and confirm it is rejected: a code
  // must not be usable as an oracle against session signing.
  const payload = { account: 'acct1', habitId: 7, date: '2026-08-13', action: 'yes', value: null, test: false };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const rawMac = createHmac('sha256', SECRET).update(payloadBytes).digest().subarray(0, 16);
  const forged = `v1.${payloadBytes.toString('base64url')}.${rawMac.toString('base64url')}`;
  assert.equal(verifyNtfyAnswer(forged, { secret: SECRET }), null);
});

/* ---------- the post-MAC shape check ---------- */

// Each of these re-signs a full payload with one field mutated — never raw
// byte tampering — because tampering-without-re-signing would fail on the MAC
// alone (already covered above) and prove nothing about the shape check.

test('an action outside ACTIONS is rejected even with a valid MAC', () => {
  const token = sign({ habitId: 7, date: '2026-08-13', action: 'dance' });
  assert.equal(verifyNtfyAnswer(token, { secret: SECRET }), null);
});

test('a date not matching DATE_RE is rejected even with a valid MAC', () => {
  const token = sign({ habitId: 7, date: 'not-a-date', action: 'yes' });
  assert.equal(verifyNtfyAnswer(token, { secret: SECRET }), null);
});

test('a non-positive or non-integer habitId is rejected even with a valid MAC', () => {
  for (const habitId of [0, -1, 1.5, 'seven']) {
    const token = sign({ habitId, date: '2026-08-13', action: 'yes' });
    assert.equal(verifyNtfyAnswer(token, { secret: SECRET }), null,
      `habitId ${JSON.stringify(habitId)} must be rejected`);
  }
});

test('a negative or non-numeric value is rejected even with a valid MAC', () => {
  // NaN and Infinity are not tried here: `JSON.stringify` turns both into
  // `null` at SIGNING time, so a code carrying either never reaches
  // `verifyNtfyAnswer` as anything but a legitimate `null` — there is no wire
  // representation of "bad" for those two to prove the check rejects.
  for (const value of [-1, 'five']) {
    const token = sign({
      habitId: 7, date: '2026-08-13', action: 'amount', value,
    });
    assert.equal(verifyNtfyAnswer(token, { secret: SECRET }), null,
      `value ${JSON.stringify(value)} must be rejected`);
  }
});

test('a null value is accepted — it means the action itself carries no amount', () => {
  const token = sign({
    habitId: 7, date: '2026-08-13', action: 'yes', value: null,
  });
  assert.notEqual(verifyNtfyAnswer(token, { secret: SECRET }), null);
});

test('a test code is exempt from the habitId and date checks, exactly as parseAction is', () => {
  const token = sign({
    habitId: 'not-a-real-id', date: 'not-a-real-date', action: 'yes', test: true,
  });
  const parsed = verifyNtfyAnswer(token, { secret: SECRET });
  assert.notEqual(parsed, null, 'a test code must not be rejected for its habitId/date shape');
  assert.equal(parsed.habitId, 'not-a-real-id');
  assert.equal(parsed.date, 'not-a-real-date');
});

test('a test code is still rejected for a bad action or a bad value', () => {
  const badAction = sign({ habitId: 7, date: '2026-08-13', action: 'dance', test: true });
  assert.equal(verifyNtfyAnswer(badAction, { secret: SECRET }), null);

  const badValue = sign({
    habitId: 7, date: '2026-08-13', action: 'amount', value: -1, test: true,
  });
  assert.equal(verifyNtfyAnswer(badValue, { secret: SECRET }), null);
});

/* ---------- the buttons ---------- */

const APP_URL = 'https://h.example';

// Every button in this section is decoded with `verifyNtfyAnswer`, which since
// step 3 also shape-checks the payload — a `date` is required unless `test` is
// set, so every `ntfyActions` call below needs a real one (production always
// supplies the reminder's own date; only a hand-built fixture could omit it).
const DATE = '2026-08-13';

// A button's `action`/`value` are not on the object itself — they live inside
// the signed code, as the URL's `c` query param — so every assertion about
// what a button DOES decodes it first with `verifyNtfyAnswer`.
function decodeActions(actions) {
  return actions.map((a) => {
    const url = new URL(a.url);
    const code = url.searchParams.get('c');
    const parsed = verifyNtfyAnswer(code, { secret: SECRET });
    return { label: a.label, action: parsed.action, value: parsed.value };
  });
}

test('a boolean habit offers Yes / No, and Skip when skipDays is on', () => {
  const plain = decodeActions(ntfyActions(habit(), { date: DATE, appUrl: APP_URL, sign }));
  assert.deepEqual(plain, [
    { label: 'Yes', action: 'yes', value: null },
    { label: 'No', action: 'no', value: null },
  ]);

  const withSkip = decodeActions(
    ntfyActions(habit(), { date: DATE, appUrl: APP_URL, sign, skipDays: true }));
  assert.deepEqual(withSkip, [
    { label: 'Yes', action: 'yes', value: null },
    { label: 'No', action: 'no', value: null },
    { label: 'Skip', action: 'skip', value: null },
  ]);
});

test('an avoided habit offers Clean / Slipped in place of Yes / No', () => {
  const plain = decodeActions(ntfyActions(avoid(), { date: DATE, appUrl: APP_URL, sign }));
  assert.deepEqual(plain, [
    { label: 'Clean', action: 'yes', value: null },
    { label: 'Slipped', action: 'no', value: null },
  ]);

  const withSkip = decodeActions(
    ntfyActions(avoid(), { date: DATE, appUrl: APP_URL, sign, skipDays: true }));
  assert.deepEqual(withSkip.map((a) => a.label), ['Clean', 'Slipped', 'Skip']);
});

/** Just the recorded value for each button — the button table's shorthand. */
function values(h, opts = {}) {
  return decodeActions(ntfyActions(h, { date: DATE, appUrl: APP_URL, sign, ...opts }))
    .map((a) => a.value);
}

const table = [
  // [habit, opts, expected values]
  [numeric({ target_value: 1 }), {}, [0, 1]],
  [numeric({ target_value: 2 }), {}, [0, 1, 2]],
  [numeric({ target_value: 3 }), {}, [0, 2, 3]],
  [numeric({ target_value: 4 }), {}, [0, 2, 4]],
  [numeric({ target_value: 8 }), {}, [0, 4, 8]],
  [numeric({ target_value: 10 }), {}, [0, 5, 10]],
  [numeric({ target_value: 12 }), {}, [0, 12]],
  [numeric({ target_value: 2.5 }), {}, [0, 2.5]],
  [numeric({ target_value: 0 }), {}, [0]],
  [numeric({ target_value: 20, target_type: 'at_most' }), {}, [0, 1, 2]],
  [numeric({ target_value: 0, target_type: 'at_most' }), {}, [0, 1, 2]],
];

for (const [h, opts, expected] of table) {
  test(`numerical ${h.target_type} target ${h.target_value}${JSON.stringify(opts) === '{}' ? '' : ' ' + JSON.stringify(opts)} -> ${expected}`, () => {
    assert.deepEqual(values(h, opts), expected);
  });
}

test('at_least 10 gets a midpoint; at_least 11 does not (the literal threshold, 10)', () => {
  assert.deepEqual(values(numeric({ target_value: 10 })), [0, 5, 10]);
  assert.deepEqual(values(numeric({ target_value: 11 })), [0, 11]);
});

test('skipDays truncates at_most to 0 / 1 / Skip, never the target', () => {
  const actions = decodeActions(
    ntfyActions(numeric({ target_value: 20, target_type: 'at_most' }),
      { date: DATE, appUrl: APP_URL, sign, skipDays: true }));
  assert.deepEqual(actions.map((a) => a.action === 'skip' ? 'Skip' : a.value), [0, 1, 'Skip']);
});

test('skipDays truncates at_least to 0 / target / Skip, dropping the midpoint', () => {
  const actions = decodeActions(
    ntfyActions(numeric({ target_value: 8 }), { date: DATE, appUrl: APP_URL, sign, skipDays: true }));
  assert.deepEqual(actions.map((a) => a.action === 'skip' ? 'Skip' : a.value), [0, 8, 'Skip']);
});

test('never more than three actions, for every shape tried above', () => {
  for (const [h, opts] of table) {
    assert.ok(ntfyActions(h, { date: DATE, appUrl: APP_URL, sign, ...opts }).length <= 3);
    assert.ok(
      ntfyActions(h, { date: DATE, appUrl: APP_URL, sign, ...opts, skipDays: true }).length <= 3);
  }
  assert.ok(ntfyActions(habit(), { date: DATE, appUrl: APP_URL, sign, skipDays: true }).length <= 3);
  assert.ok(ntfyActions(avoid(), { date: DATE, appUrl: APP_URL, sign, skipDays: true }).length <= 3);
});

test('never two actions with the same recorded value', () => {
  for (const [h, opts] of table) {
    const vs = values(h, opts);
    assert.equal(new Set(vs).size, vs.length, `duplicate value in ${JSON.stringify(vs)}`);
  }
});

test('no appUrl means no buttons at all', () => {
  assert.deepEqual(ntfyActions(habit(), { sign }), []);
  assert.deepEqual(ntfyActions(habit(), { appUrl: '', sign }), []);
  assert.deepEqual(ntfyActions(habit(), { appUrl: 'not-a-url', sign }), []);
});

// A non-test button's code is checked by `verifyNtfyAnswer`'s post-MAC shape
// check against `DATE_RE`, so a missing or malformed date here would build a
// button that 403s forever and never even clears the notification. This is
// the same "no buttons" outcome as no `appUrl`, rather than a dead one.
test('a non-test call with no date means no buttons at all', () => {
  assert.deepEqual(ntfyActions(habit(), { appUrl: APP_URL, sign }), []);
});

test('a non-test call with a malformed date means no buttons at all', () => {
  assert.deepEqual(
    ntfyActions(habit(), { date: 'not-a-date', appUrl: APP_URL, sign }), []);
});

test('a test call still builds buttons with no date — the code never reaches storage', () => {
  const actions = ntfyActions(habit(), { appUrl: APP_URL, sign, test: true });
  assert.equal(actions.length, 2);
});

test('the URL is built from NTFY_ANSWER_PATH and normalises trailing slashes', () => {
  const [action] = ntfyActions(habit(), { date: DATE, appUrl: 'https://h.example///', sign });
  const url = new URL(action.url);
  assert.equal(`${url.origin}${url.pathname}`, `https://h.example${NTFY_ANSWER_PATH}`);
  assert.equal(action.method, 'POST');
  assert.equal(action.action, 'http');
  assert.equal(action.clear, true);
});

test('a single trailing slash is also counted off', () => {
  const [action] = ntfyActions(habit(), { date: DATE, appUrl: 'https://h.example/', sign });
  const url = new URL(action.url);
  assert.equal(`${url.origin}${url.pathname}`, `https://h.example${NTFY_ANSWER_PATH}`);
});

/* ---------- the handler ---------- */

const TODAY = '2026-08-19';

function adapter(over = {}) {
  const recorded = [];
  const base = {
    secret: () => SECRET,
    resolveAccount: async (ref) => (ref === 'acct1' ? { id: 'acct1' } : null),
    today: async () => TODAY,
    record: async (account, args) => {
      recorded.push(args);
      return { ok: true, text: 'Recorded' };
    },
    log: { error: () => {} },
  };
  return { ...base, ...over, recorded };
}

test('a forged code is rejected before any storage is touched', async () => {
  const a = adapter({ record: async () => { throw new Error('must not be called'); } });
  const result = await handleNtfyAnswer('v1.notavalidpayload.notavalidmac12345678', a);
  assert.deepEqual(result, { status: 403 });
  assert.deepEqual(a.recorded, []);
});

test('a test code returns 200 and touches no storage', async () => {
  const a = adapter({
    resolveAccount: async () => { throw new Error('must not be called'); },
    record: async () => { throw new Error('must not be called'); },
  });
  const token = sign({ habitId: 7, date: TODAY, action: 'yes', test: true });
  const result = await handleNtfyAnswer(token, a);
  assert.equal(result.status, 200);
  assert.match(result.text, /test message/i);
  assert.deepEqual(a.recorded, []);
});

test('a forged code and a genuine code for an unknown account produce the identical result, and record is never called', async () => {
  const neverRecord = { record: async () => { throw new Error('must not be called'); } };

  // Step 1: the MAC does not verify at all.
  const forged = await handleNtfyAnswer(
    'v1.garbage.garbage1234567890123456', adapter(neverRecord));

  // Step 3: a genuine, correctly-signed code, but for an account that does
  // not exist. A real forger cannot tell these two 403s apart, and neither
  // must this route: comparing them as ONE assertion is the point — asserting
  // each status separately would still pass if the two carried different
  // `error` text or different shapes.
  const genuineButUnknown = await handleNtfyAnswer(
    sign({ habitId: 7, date: TODAY, action: 'yes' }),
    adapter({ ...neverRecord, resolveAccount: async () => null }),
  );

  assert.deepEqual(forged, genuineButUnknown,
    'a forged code must not be distinguishable from a real one pointed at nobody');
  assert.deepEqual(forged, { status: 403 });
});

test('a future date is refused as a 400', async () => {
  const a = adapter();
  const token = sign({ habitId: 7, date: '2099-01-01', action: 'yes' });
  const result = await handleNtfyAnswer(token, a);
  assert.equal(result.status, 400);
  assert.deepEqual(a.recorded, []);
});

test('a stale reminder is refused as a 410', async () => {
  const a = adapter();
  const stale = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 30 * 86_400_000)
    .toISOString().slice(0, 10);
  const token = sign({ habitId: 7, date: stale, action: 'yes' });
  const result = await handleNtfyAnswer(token, a);
  assert.equal(result.status, 410);
  assert.deepEqual(a.recorded, []);
});

test('a valid, current answer is recorded and returns 200', async () => {
  const a = adapter();
  const token = sign({ habitId: 7, date: TODAY, action: 'yes' });
  const result = await handleNtfyAnswer(token, a);
  assert.equal(result.status, 200);
  assert.equal(result.text, 'Recorded');
  assert.deepEqual(a.recorded, [{ habitId: 7, date: TODAY, action: 'yes', value: null }]);
});

test('a recording failure is a 400, not a 500', async () => {
  const a = adapter({ record: async () => ({ ok: false, error: 'nope' }) });
  const token = sign({ habitId: 7, date: TODAY, action: 'yes' });
  const result = await handleNtfyAnswer(token, a);
  assert.equal(result.status, 400);
  assert.equal(result.error, 'nope');
});

test('a storage throw is a 500, logged rather than left to crash', async () => {
  let logged = false;
  const a = adapter({
    record: async () => { throw new Error('database gone'); },
    log: { error: () => { logged = true; } },
  });
  const token = sign({ habitId: 7, date: TODAY, action: 'yes' });
  const result = await handleNtfyAnswer(token, a);
  assert.deepEqual(result, { status: 500 });
  assert.ok(logged, 'the failure must be logged, not silent');
});
