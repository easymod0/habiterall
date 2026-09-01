/**
 * Answering from an ntfy button, over the real route.
 *
 * The tenancy question — a code minted for one account cannot reach another's
 * habit — is answered in notify.integration.mjs, beside the rest of that
 * file's `withUser` checks, since only Postgres can prove it. What this file
 * proves is everything only a booted `src/server.js` can show: that the route
 * is mounted where an unauthenticated request reaches it, that the origin
 * guard mounted above it applies here too, and that its own inline limiter
 * bites. Pinning the decision is not pinning the wiring, so this drives the
 * real HTTP surface rather than calling `handleNtfyAnswer` in process.
 *
 * Cloud's `server.js` has no `isEntryPoint` guard — importing it starts
 * listening — so the real server is booted as a child process, the same way
 * `healthz.integration.mjs` does, complete with a fake OIDC issuer so
 * `initAuth` can complete without a real one.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/ntfy-answer.integration.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

process.env.ADMIN_URL ??= 'postgres://owner:testpw@localhost:5432/habiterall';
process.env.DATABASE_URL ??= 'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

const SECRET = 'ntfy-answer-integration-secret';

const { withUser } = await import('../src/db/pool.js');
const { signNtfyAnswer, NTFY_ANSWER_PATH } = await import('@habiterall/shared/ntfy-answer.js');
const { MAX_ANSWER_AGE_DAYS } = await import('@habiterall/shared/discord.js');
const { RATE_LIMITS } = await import('@habiterall/shared/security.js');

const pg = (await import('pg')).default;
const admin = new pg.Client({ connectionString: process.env.ADMIN_URL });

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

/** Minimal OIDC discovery, so `initAuth` can complete without a real IdP. */
async function fakeIssuer() {
  let base;
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/.well-known/openid-configuration')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/auth`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, base };
}

const idle = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(issuer, port) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      SESSION_SECRET: SECRET,
      PUBLIC_URL: `http://localhost:${port}`,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'test-client',
      OIDC_CLIENT_SECRET: 'test-secret',
      ALLOW_INSECURE_OIDC: 'true',
      HABITERALL_NOTIFY: 'off',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => {
    const s = String(b);
    if (!s.includes('oidc.insecure')) process.stderr.write(`  [server] ${s}`);
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { child, base };
    } catch { /* not listening yet */ }
    await idle(100);
  }
  throw new Error('server never became ready');
}

const { srv, base: issuer } = await fakeIssuer();
const port = 3600 + (process.pid % 200);
const { child, base } = await boot(issuer, port);

// The five fixture subjects this file owns, so setup and the `finally`
// cleanup cannot drift apart into deleting a different set.
const SUBJECTS = [
  'sub-ntfy-http', 'sub-ntfy-http-e', 'sub-ntfy-http-w',
  'sub-ntfy-http-e-auto', 'sub-ntfy-http-w-auto',
];

try {
  await admin.connect();
  await admin.query('DELETE FROM entries');
  await admin.query('DELETE FROM habits');
  await admin.query(`DELETE FROM users WHERE idp_subject = ANY($1)`, [SUBJECTS]);

  const userId = (await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, display_name, settings, device_time_zone)
     VALUES ('sub-ntfy-http', 'https://idp', 'ntfy http test',
             '{"notifyTimezone":"UTC"}'::jsonb, 'Pacific/Kiritimati') RETURNING id`
  )).rows[0].id;

  const mkHabit = async (uid, name) => withUser(uid, (db) =>
    db.query(
      `INSERT INTO habits (user_id, name, type) VALUES ($1, $2, 'boolean') RETURNING id`,
      [uid, name]
    ).then((r) => r.rows[0].id));

  const entriesFor = async (uid, habitId) => withUser(uid, (db) =>
    db.query(`SELECT date, value, status FROM entries WHERE habit_id = $1`, [habitId])
      .then((r) => r.rows));

  // The route dates "today" in the ACCOUNT's resolved zone
  // (`interactionAdapter().today` in src/notifier.js), not in UTC — and the
  // fixture account above names `notifyTimezone: 'UTC'` explicitly, which is
  // `resolveTimeZone`'s first tier and wins over the reported device zone.
  // So the route's `today` is UTC by construction and this plain
  // `toISOString()` day agrees with it in every runner zone. Leaving either
  // clock unstated is #288: the suite used to assume UTC while the route
  // dated the account in whatever zone the server happened to be running in,
  // and the two disagreed everywhere the runner's local date differed from
  // the UTC date.
  const day = new Date().toISOString().slice(0, 10);
  let ntfyRequests = 0;
  const postNtfy = async (code, { origin } = {}) => {
    ntfyRequests++;
    const headers = {};
    if (origin !== undefined) headers.Origin = origin;
    const res = await fetch(
      `${base}${NTFY_ANSWER_PATH}?c=${encodeURIComponent(code)}`,
      { method: 'POST', headers }
    );
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body };
  };
  const ntfyCode = (fields) => signNtfyAnswer({ secret: SECRET, account: String(userId), ...fields });
  const shiftDay = (delta) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  };

  console.log('--- answering from an ntfy button, over the real route ---');

  const happyId = await mkHabit(userId, 'ntfy happy path');
  const happy = await postNtfy(ntfyCode({ habitId: happyId, date: day, action: 'yes' }));
  ck('a signed ntfy press is accepted', happy.status === 200, JSON.stringify(happy));
  const afterHappy = await entriesFor(userId, happyId);
  ck('and the entry is recorded, read back from storage',
    afterHappy.some((e) => e.date === day && Number(e.value) === 2),
    JSON.stringify(afterHappy));

  // Flipping the LAST base64url character of a 16-byte MAC is not safe: the
  // final character carries only 2 significant bits, the rest padding, so
  // some flips are a no-op about 1 time in 64. Flip a whole byte in the
  // middle of the decoded MAC instead, which always changes the value.
  const forgedId = await mkHabit(userId, 'ntfy forged');
  const validForForgery = ntfyCode({ habitId: forgedId, date: day, action: 'yes' });
  const [version, payloadB64, macB64] = validForForgery.split('.');
  const macBytes = Buffer.from(macB64, 'base64url');
  macBytes[0] ^= 0xff;
  const tamperedMac = `${version}.${payloadB64}.${macBytes.toString('base64url')}`;
  const forged = await postNtfy(tamperedMac);
  ck('a forged code is refused with 403', forged.status === 403, JSON.stringify(forged));
  ck('and nothing was written for it', (await entriesFor(userId, forgedId)).length === 0);

  const unknownId = await mkHabit(userId, 'ntfy unknown account');
  const unknownAccountCode = signNtfyAnswer({
    secret: SECRET, account: '999999999', habitId: unknownId, date: day, action: 'yes',
  });
  const unknownAccount = await postNtfy(unknownAccountCode);
  ck('an unknown account reference is refused with the identical 403 shape',
    unknownAccount.status === 403
      && JSON.stringify(unknownAccount.body) === JSON.stringify(forged.body),
    JSON.stringify(unknownAccount));
  ck('and nothing was written for it either', (await entriesFor(userId, unknownId)).length === 0);

  const deletedId = await mkHabit(userId, 'ntfy deleted');
  await withUser(userId, (db) => db.query('DELETE FROM habits WHERE id = $1', [deletedId]));
  const deletedNtfy = await postNtfy(ntfyCode({ habitId: deletedId, date: day, action: 'yes' }));
  ck('a deleted habit is refused, not recorded',
    deletedNtfy.status === 400 && /no longer exists/i.test(deletedNtfy.body?.error ?? ''),
    JSON.stringify(deletedNtfy));

  const staleId = await mkHabit(userId, 'ntfy stale');
  const staleDate = shiftDay(-(MAX_ANSWER_AGE_DAYS + 1));
  const staleNtfy = await postNtfy(ntfyCode({ habitId: staleId, date: staleDate, action: 'yes' }));
  ck('a stale reminder answers 410', staleNtfy.status === 410, JSON.stringify(staleNtfy));
  ck('and nothing was written for a stale press', (await entriesFor(userId, staleId)).length === 0);

  const futureId = await mkHabit(userId, 'ntfy future');
  const futureDate = shiftDay(1);
  const futureNtfy = await postNtfy(ntfyCode({ habitId: futureId, date: futureDate, action: 'yes' }));
  ck('a future-dated reminder answers 400', futureNtfy.status === 400, JSON.stringify(futureNtfy));
  ck('and nothing was written for a future press', (await entriesFor(userId, futureId)).length === 0);

  const testId = await mkHabit(userId, 'ntfy test-code target');
  const testNtfy = await postNtfy(ntfyCode({ habitId: testId, date: day, action: 'yes', test: true }));
  ck('a test code is accepted', testNtfy.status === 200, JSON.stringify(testNtfy));
  ck('and a test code writes nothing', (await entriesFor(userId, testId)).length === 0);

  const noOriginId = await mkHabit(userId, 'ntfy no origin');
  const noOrigin = await postNtfy(ntfyCode({ habitId: noOriginId, date: day, action: 'yes' }));
  ck('no Origin header is accepted', noOrigin.status === 200, JSON.stringify(noOrigin));

  const foreignId = await mkHabit(userId, 'ntfy foreign origin');
  const foreignOrigin = await postNtfy(
    ntfyCode({ habitId: foreignId, date: day, action: 'yes' }),
    { origin: 'https://evil.example' }
  );
  ck('a foreign Origin is refused, even with an otherwise-valid code',
    foreignOrigin.status === 403 && /cross-origin/i.test(foreignOrigin.body?.error ?? ''),
    JSON.stringify(foreignOrigin));
  ck('and nothing was written for the cross-origin attempt',
    (await entriesFor(userId, foreignId)).length === 0);

  // STEP 1 pins the fixture account to UTC, which makes the suite's own
  // `day` correct by construction — but it also means a route that ignored
  // the account entirely and just used UTC would be indistinguishable from a
  // correct one, in every runner zone. This pair is the guard for that: two
  // more fixture accounts, each naming a zone in `settings.notifyTimezone`
  // and each reporting `device_time_zone: 'UTC'` (the WRONG answer, so tier 1
  // beating tier 2 stays load-bearing here too). `Pacific/Kiritimati`
  // (UTC+14) and `Etc/GMT+12` (UTC−12) are 26 hours apart — wider than a
  // calendar day, so their local dates ALWAYS differ, at every instant
  // (docs/decisions/timezones.md:103-112). Signing the same date string `D`
  // (today in Kiritimati, computed independently of the route below) for
  // both: the east account's `today` is D or D+1 (age 0 or 1, always <=
  // MAX_ANSWER_AGE_DAYS) so it must accept; the west account's `today` is
  // always D-1 or D-2 (age negative) so it must be refused as a future date.
  // Any route judging both by ONE clock — UTC, or the server's own — gives
  // them the same answer and this pair catches it, race-free and in every
  // runner zone. #288.
  const D = (() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Kiritimati',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const part = (type) => parts.find((p) => p.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  })();

  const eastId = (await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, display_name, settings, device_time_zone)
     VALUES ('sub-ntfy-http-e', 'https://idp', 'ntfy http test east',
             '{"notifyTimezone":"Pacific/Kiritimati"}'::jsonb, 'UTC') RETURNING id`
  )).rows[0].id;
  const westId = (await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, display_name, settings, device_time_zone)
     VALUES ('sub-ntfy-http-w', 'https://idp', 'ntfy http test west',
             '{"notifyTimezone":"Etc/GMT+12"}'::jsonb, 'UTC') RETURNING id`
  )).rows[0].id;

  // One press of the pair's shared date `D`, for one fixture account: makes
  // its habit, signs and posts the code, and reads back what storage says
  // happened. The `ck` calls stay at each call site rather than inside here
  // — see the comment above each pair for which tier it pins, and each
  // label says so explicitly, since this helper cannot tell the difference
  // itself.
  const pressD = async (uid, habitName) => {
    const habitId = await mkHabit(uid, habitName);
    const ntfy = await postNtfy(
      signNtfyAnswer({ secret: SECRET, account: String(uid), habitId, date: D, action: 'yes' })
    );
    const entries = await entriesFor(uid, habitId);
    return { ntfy, entries };
  };

  const east = await pressD(eastId, 'ntfy tz-guard east');
  ck('the 26h pair (tier 1, notifyTimezone named explicitly): east accepts D',
    east.ntfy.status === 200, JSON.stringify(east.ntfy));
  ck('and the entry lands on D, read back from storage',
    east.entries.some((e) => e.date === D && Number(e.value) === 2),
    JSON.stringify(east.entries));

  const west = await pressD(westId, 'ntfy tz-guard west');
  ck('the 26h pair (tier 1): west refuses the same D as future',
    west.ntfy.status === 400 && /future/i.test(west.ntfy.body?.error ?? ''),
    JSON.stringify(west.ntfy));
  ck('and nothing was written for the west account',
    west.entries.length === 0);

  // Every account above — this pair included — names `notifyTimezone`
  // explicitly, so `resolveTimeZone`'s first tier answers every request in
  // this file and its second tier (`account.deviceZone`, the zone the LAST
  // client reported) is never read: mutating `ntfyAnswerAdapter()
  // .resolveAccount` in src/notifier.js to return `deviceZone: ''` — a
  // route that drops the reported device zone entirely — leaves the whole
  // suite passing. Every real account starts on `notifyTimezone: 'auto'`
  // (#288's own default), which is exactly the mode that reads the
  // reported zone, so that hole dates every such account by the server's
  // clock. This second pair closes it: both accounts leave `notifyTimezone`
  // on `'auto'` and put the 26-hour split on `device_time_zone` instead, so
  // the same `D` is resolved through tier 2 rather than tier 1.
  //
  // It has to be a PAIR for the same reason tier 1's does. A single `auto`
  // account asserted either way is caught only some hours of the day: under
  // `TZ=UTC`, a route that drops the reported zone and falls to the server
  // clock agrees with `D` for the ~10 hours a day Kiritimati and UTC share a
  // date. Two accounts 26 hours apart via the REPORTED zone must get
  // OPPOSITE answers for one date string at every hour, so any route that
  // drops or ignores tier 2 answers them identically and fails always.
  const eastAutoId = (await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, display_name, settings, device_time_zone)
     VALUES ('sub-ntfy-http-e-auto', 'https://idp', 'ntfy http test east auto',
             '{"notifyTimezone":"auto"}'::jsonb, 'Pacific/Kiritimati') RETURNING id`
  )).rows[0].id;
  const westAutoId = (await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, display_name, settings, device_time_zone)
     VALUES ('sub-ntfy-http-w-auto', 'https://idp', 'ntfy http test west auto',
             '{"notifyTimezone":"auto"}'::jsonb, 'Etc/GMT+12') RETURNING id`
  )).rows[0].id;

  const eastAuto = await pressD(eastAutoId, 'ntfy tz-guard east auto');
  ck('the 26h pair (tier 2, notifyTimezone: auto, resolved from the reported device zone): east-auto accepts D',
    eastAuto.ntfy.status === 200, JSON.stringify(eastAuto.ntfy));
  ck('and the entry lands on D for east-auto, read back from storage',
    eastAuto.entries.some((e) => e.date === D && Number(e.value) === 2),
    JSON.stringify(eastAuto.entries));

  const westAuto = await pressD(westAutoId, 'ntfy tz-guard west auto');
  ck('the 26h pair (tier 2): west-auto refuses the same D as future',
    westAuto.ntfy.status === 400 && /future/i.test(westAuto.ntfy.body?.error ?? ''),
    JSON.stringify(westAuto.ntfy));
  ck('and nothing was written for the west-auto account',
    westAuto.entries.length === 0);

  // The limiter is written inline at the route, keyed on IP, and there is no
  // env switch in this edition that turns it off (unlike personal's
  // HABITERALL_RATE_LIMIT=off) — it simply bites, full stop, for every
  // caller of this route including this test's own traffic.
  const junkCode = 'v1.notarealtoken.notarealmac12345678';
  let saw429 = false;
  const budget = RATE_LIMITS.ntfyAnswer.limit + 20 - ntfyRequests;
  for (let i = 0; i < budget && !saw429; i++) {
    const r = await postNtfy(junkCode);
    if (r.status === 429) saw429 = true;
  }
  ck('the ntfy-answer limiter bites, with no off-switch to defeat',
    saw429, `sent ${ntfyRequests} requests total, limit is ${RATE_LIMITS.ntfyAnswer.limit}/min`);

  console.log(`\n${fails === 0 ? 'ALL NTFY-ANSWER HTTP CHECKS PASSED' : `${fails} FAILED`}`);
} finally {
  await admin.query(`DELETE FROM users WHERE idp_subject = ANY($1)`, [SUBJECTS]).catch(() => {});
  await admin.end().catch(() => {});
  child.kill('SIGKILL');
  srv.close();
}

process.exit(fails === 0 ? 0 : 1);
