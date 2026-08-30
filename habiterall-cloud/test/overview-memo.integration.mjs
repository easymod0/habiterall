/**
 * `/overview`'s memo, over the real route.
 *
 * `test/cache.test.js` proves the memo COLLAPSES a burst, expires, forgets by
 * prefix and refuses to store an answer computed before a write. None of that
 * proves the route uses it, that the key carries what it must, or that a write
 * reaches `forget` — and "pinning the DECISION is not pinning the WIRING" is
 * the defect class this repo ships most. So this boots the REAL `src/server.js`
 * and drives it over HTTP, the way `healthz.integration.mjs` does and for the
 * same reason.
 *
 * The six things only this file can see:
 *
 *  1. The memo is LIVE on the route — a change made out of band, behind the
 *     route's back, is not visible while the entry it is hiding stays
 *     reachable.
 *  2. **A write this process never saw is visible on the NEXT request** (#192).
 *     The memo is per process and so is `forget`, so a tap taken by replica A
 *     leaves B holding a pre-tap dashboard that nothing on B will clear, and B
 *     answers the refetch. `users.data_version` in the key is what makes B's
 *     entry unreachable instead — with no client cooperation, which is the half
 *     the deleted freshness header could never reach: a tab that did not itself
 *     write had nothing to say. The `admin` connection stands in for the other
 *     replica, because one process cannot host two memos.
 *  3. The answer still names the device zone in its `Vary` — the control that
 *     outlived the freshness header, and a rule about the service worker rather
 *     than about that header. See the comment at the check.
 *  4. A WRITE invalidates — the tap-then-refetch case, which is the one that
 *     can actually regress and the one that would paint a user's own tap away.
 *  5. A write that never touches the `/api` ROUTER invalidates as well. The
 *     first version of this invalidation was `api.use(...)` and nothing else,
 *     which is a rule about a router rather than about a write — and the ntfy
 *     button posts above that router while Discord's never reaches Express at
 *     all. Both are the same missing dashboard refresh.
 *  6. The CALLER'S DAY is in the key — two devices on one account either side
 *     of a date boundary send the same URL and must not share an answer.
 *
 * Three things it does NOT see, stated rather than left to be discovered.
 *
 * Whether the invalidation runs on the way OUT or on the way IN: every check
 * here is sequential, so a `forget` called before the handler passes all of
 * them — the case it gets wrong needs a read still computing when the write
 * commits, and nothing over HTTP can hold `buildOverview` open on demand. That
 * half is `cache.test.js`'s "an answer computed before a write is never stored
 * after it", which can hold the computation open because it injects it.
 *
 * And whether the version is read BEFORE the data rather than after. Same
 * limit, one level in: the case that separates them needs a write committing
 * between the two statements of one transaction. `cache.test.js` guards the
 * ordering on source text and `api.js` argues it at the read; neither is a
 * behavioural check and both say so.
 *
 * And whether a BURST IS JOINED — which this file used to claim, in a check
 * that could not fail. It fired six simultaneous `/overview`s on their own
 * sockets and asserted every one was answered 200 and that all six carried the
 * same bytes. Neither assertion can tell joined from not-joined, and the reason
 * is structural rather than a matter of timing: nothing writes during the
 * burst, so six INDEPENDENTLY computed dashboards over the same committed data
 * are byte-identical anyway, and six concurrent rebuilds are well inside
 * `PG_POOL_MAX` = 10, so nothing 500s either. Measured rather than argued: with
 * the join taken out at BOTH levels — the route's `return {pending:
 * hit.inflight}` branch deleted, and `memo()` made to step over a placeholder
 * instead of joining it, which takes the `hit?.inflight` return AND the settled
 * branch below it, or the joiners read the placeholder as an answer of
 * `undefined` and the mutation fails for the wrong reason — a counter in
 * `buildOverview` reported six builds where one was claimed, with both
 * assertions green, three runs in a row.
 *
 * The deleted comment stated it had been mutation-tested against exactly that
 * route, which is why this is a deletion and not a tightening. A timing
 * assertion is not the rescue — this repo waits on predicates, never on
 * durations — and a build counter is production code carried for a test to
 * read.
 *
 * Where it IS pinned: `cache.test.js`, deterministically and with no server at
 * all. `a burst on a cold memo costs one computation, not one each` counts the
 * computations over an injected one, and `peek answers hit, join or nothing,
 * and computes none of them` pins the three cases the route chooses between.
 * The route's own half — that the join branch returns `{pending}` and is
 * awaited OUTSIDE the `withUser` transaction, so a waiter does not hold a pool
 * connection for the length of somebody else's rebuild — is the source-text
 * guard beside them, `a joiner hands its connection back BEFORE waiting, not
 * after`.
 *
 * **It also no longer waits out the TTL, and could not.** The TTL is 60 s now
 * — it stopped being the correctness mechanism when the version went into the
 * key — so "visible once it expires" would be a minute of sleep proving what
 * `cache.test.js` already proves with an injected clock. What replaces it is
 * the check that matters more: visible once the VERSION moves.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/overview-memo.integration.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';

import { NTFY_ANSWER_PATH, signNtfyAnswer } from '@habiterall/shared/ntfy-answer.js';

process.env.ADMIN_URL ??= 'postgres://owner:testpw@localhost:5432/habiterall';
process.env.DATABASE_URL ??= 'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

const SECRET = 'overview-memo-integration-secret';
const SID = 'overviewmemointegrationsid01';

/** Must match `OVERVIEW_TTL_MS` in src/api.js — asserted below, not assumed. */
const TTL_MS = 60_000;

const admin = new pg.Client({ connectionString: process.env.ADMIN_URL });

let fails = 0;
const ck = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) fails++;
};

const idle = (ms) => new Promise((r) => setTimeout(r, ms));

/** express-session's cookie format: s:<sid>.<base64 hmac, unpadded>. */
const signed = (sid, secret) =>
  `s%3A${sid}.${encodeURIComponent(
    createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, ''))}`;

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

/** Today in a named zone, as the app spells a date. */
const dayIn = (zone) => new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

/**
 * Which fields two habit rows disagree about, so a failure names something.
 *
 * The figure that actually moves here is `score` — a trailing-window ratio
 * anchored on `summaryEnd`, which is the caller's own day — and it moves in the
 * third decimal. Reporting the field rather than asserting on it keeps the
 * claim the right size: what must be true is that the two answers are not the
 * SAME OBJECT, whichever figure happens to carry the difference.
 */
const differingFields = (a, b) => Object.entries(a)
  .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(b[k]))
  .map(([k, v]) => [k, JSON.stringify(v), JSON.stringify(b[k])]);

const shiftDate = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The two furthest-apart zones there are: UTC+14 and UTC-12.
 *
 * Twenty-six hours apart, so they are NEVER on the same calendar day — which
 * is what makes this fixture independent of when the suite happens to run.
 * `shared/CLAUDE.md` states the same spread at `callerDay`.
 */
const ZONE_LATE = 'Pacific/Kiritimati';
const ZONE_EARLY = 'Etc/GMT+12';

const { srv, base: issuer } = await fakeIssuer();
const port = 3600 + (process.pid % 200);
const { child, base } = await boot(issuer, port);

try {
  await admin.connect();

  await admin.query(`DELETE FROM users WHERE idp_subject = 'ci-memo'`);
  const { rows: [row] } = await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
     VALUES ('ci-memo', 'https://ci.example', 'memo@example.com', 'memo')
     RETURNING id`
  );
  // `Number`, and not decoration: `db/pool.js` installs a BIGINT type parser on
  // the `pg` module, and this client is built before that module is loaded
  // here — so the id arrives as a string, `withUser`'s `Number.isInteger` guard
  // refuses it, and every route answers 500 with the session looking perfect.
  const user = Number(row.id);
  await admin.query(
    `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, $3)
     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
    [SID, JSON.stringify({
      cookie: { originalMaxAge: 6048e5, httpOnly: true, path: '/', sameSite: 'lax' },
      user: { id: user, email: 'memo@example.com', name: 'memo', blocked: false },
    }), new Date(Date.now() + 7 * 864e5)]
  );
  const cookie = `habiterall.sid=${signed(SID, SECRET)}`;

  /**
   * @param {string} path
   * @param {{zone?: string, method?: string, body?: any}} [o]
   */
  const call = async (path, { zone = 'UTC', method = 'GET', body } = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        cookie,
        'X-Habiterall-Timezone': zone,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // Read ONCE, as text, and parse from that: the memo holds the serialised
    // payload now, so what a hit and a miss send byte for byte is a thing this
    // suite has to be able to compare and not merely deep-equal.
    const text = res.status === 204 ? '' : await res.text();
    return {
      status: res.status,
      vary: res.headers.get('vary') ?? '',
      contentType: res.headers.get('content-type') ?? '',
      text,
      body: text === '' ? null : JSON.parse(text),
    };
  };

  const created = await call('/habits', {
    method: 'POST',
    body: { name: 'Memo probe', type: 'boolean', freq_numerator: 1, freq_denominator: 1 },
  });
  ck('control: the fixture habit was created', created.status === 201,
    `-> ${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);
  const habitId = created.body.id;

  console.log('\n--- the memo is live on the route ---');
  // Out of band on purpose: `admin` is not the app, so nothing invalidates, it
  // bumps no version, and the only thing that can hide this change is the memo
  // itself.
  const first = await call('/overview');
  ck('control: /overview answers', first.status === 200, `-> ${first.status}`);

  await admin.query(`UPDATE habits SET name = 'Renamed behind the route' WHERE id = $1`,
    [habitId]);

  const cached = await call('/overview');
  ck('a change that bumped no version is not visible',
    cached.body.habits[0]?.name === 'Memo probe',
    cached.body.habits[0]?.name);

  // A MISS and a HIT are the same answer, byte for byte. The memo holds the
  // serialised payload, so the route is `res.type('application/json').send(str)`
  // where it used to be `res.json(obj)` — and `res.send` of a string defaults
  // the content type to text/html, which is the one way that swap goes wrong.
  // `first` is the miss and `cached` is the hit; nothing between them changed
  // the account except the rename the memo is currently hiding.
  ck('a hit and a miss agree on the body, byte for byte',
    first.text === cached.text,
    `${first.text.length} vs ${cached.text.length} chars`);
  ck('...and both are served as JSON',
    /^application\/json/.test(first.contentType)
      && first.contentType === cached.contentType,
    `${first.contentType} vs ${cached.contentType}`);

  console.log('\n--- a write this process never saw, visible on the NEXT request ---');
  // **The cross-replica case, and the whole point of #192.** The memo is per
  // process and so is `forget`: a tap taken by replica A leaves B holding a
  // pre-tap dashboard that nothing on B will ever clear, and the load balancer
  // hands B the refetch. `admin` is what stands in for "a write this process
  // never saw" — it is not the app, so no middleware runs and nothing here is
  // invalidated, which is exactly B's position after A took the write.
  //
  // What A's transaction commits is the row AND the bump, together
  // (`withUserWrite`). The rename above is already sitting there uncommunicated;
  // this is the bump that announces it. The very next request must see it, with
  // no header, no wait and no cooperation from the client at all — which is the
  // half the freshness header could never close, since a tab that did not write
  // has nothing to say.
  //
  // Mutation: take `${version}` out of the key in `api.js` and this check fails
  // while every invalidation check below it still passes.
  await admin.query(`UPDATE users SET data_version = data_version + 1 WHERE id = $1`,
    [user]);

  const bumped = await call('/overview');
  ck('a bumped version makes the entry unreachable on the very next request',
    bumped.body.habits[0]?.name === 'Renamed behind the route',
    bumped.body.habits[0]?.name);

  ck(`control: the TTL under test is ${TTL_MS}ms`,
    /OVERVIEW_TTL_MS = 60_000/.test(
      await (await import('node:fs/promises'))
        .readFile(new URL('../src/api.js', import.meta.url), 'utf8')));

  // ...and the answer names the device zone in its `Vary`. This is what is left
  // of the freshness header's own block here (#192 step 3), and it is kept
  // rather than deleted with the rest for a reason that has nothing to do with
  // that header: `shared/public/sw.js` stores `/api/overview` with
  // `cache.put(request, …)` and reads it back with `caches.match(request)`,
  // both of which select on the STORED RESPONSE's `Vary` — so a route the
  // worker caches may not vary on a header the page sends only SOMETIMES. The
  // zone is safe there precisely because a device sends one on every request,
  // and this asserts `res.vary` is reached at all, which is the half a route
  // that stopped calling it altogether would fail. `shared/public/CLAUDE.md`
  // states the rule; the freshness header was only the example that found it.
  ck('control: the answer varies by the device zone, so `res.vary` is reached',
    /x-habiterall-timezone/i.test(bumped.vary), bumped.vary || '(no Vary)');

  // **What went with the header and has no version-shaped equivalent**, stated
  // rather than left as a gap somebody rediscovers. The deleted block also
  // pinned that a rebuild is STORED and not merely read past — `memo.fresh`
  // deleted the entry and re-entered the memo, and a version of it that read
  // past the map without writing back would have served every later reader a
  // recomputation. That was worth its own check because `memo.fresh` was a
  // SECOND path to an answer, beside the ordinary miss. It is gone: a bumped
  // version is a new KEY, so a rebuild after one is an ordinary miss on the
  // ordinary path, and "a miss stores" is already what the first section here
  // asserts — `a change that bumped no version is not visible` and `a hit and a
  // miss agree on the body, byte for byte` both fail against a route that does
  // not store. Mutation-tested: replacing the miss path with a bare
  // `buildOverview` that never writes back fails those two and the rename check
  // above, so a fourth check re-expressing the same thing would have been a
  // duplicate rather than coverage.

  const today = dayIn('UTC');

  console.log("\n--- a second device's write is visible immediately ---");
  // **The half an ECHO shape could not close, and the reason #192 departs from
  // what `docs/decisions/caching.md` specified.** With an echoed version the
  // client sends back the newest version IT has seen; a device that never wrote
  // has nothing newer to echo, so its own check is satisfied and it is served
  // the same stale dashboard it would have been served with no version at all.
  //
  // So: another device on this account writes — the entry row AND the bump, in
  // ONE transaction, which is exactly what `withUserWrite` commits — and this
  // device reads with no freshness header, no wait, and nothing it could have
  // known. The rename above rides along on the same bump as a second signal.
  //
  // `admin` is the other device here for the same reason it is the other
  // replica above: a write made through this process's own router would be
  // caught by the invalidation middleware, which is not what is being asked.
  //
  // Mutation: take `${version}` out of the key and this fails while everything
  // below it still passes.
  await admin.query(`UPDATE habits SET name = 'Memo probe' WHERE id = $1`, [habitId]);
  await admin.query('BEGIN');
  await admin.query(
    `INSERT INTO entries (habit_id, user_id, date, value, status)
     VALUES ($1, $2, $3, 2, '')
     ON CONFLICT (habit_id, date) DO UPDATE SET value = EXCLUDED.value`,
    [habitId, user, today]);
  await admin.query(`UPDATE users SET data_version = data_version + 1 WHERE id = $1`, [user]);
  await admin.query('COMMIT');

  const otherDevice = await call('/overview');
  ck("a second device's tap is on this device's very next /overview",
    otherDevice.body.habits[0]?.entries?.[today] === 2,
    JSON.stringify(otherDevice.body.habits[0]?.entries));
  ck('...and so is everything else that write announced',
    otherDevice.body.habits[0]?.name === 'Memo probe',
    otherDevice.body.habits[0]?.name);

  console.log('\n--- a write invalidates: tap, then refetch ---');
  // The regression that matters. Warm the memo, tap a day through the API, and
  // refetch with no wait at all — which is exactly what the client does.
  //
  // Through the API, so the day is blank again and the invalidation middleware
  // has cleared what the section above warmed.
  const cleared = await call(`/habits/${habitId}/entries/${today}`, { method: 'DELETE' });
  ck('control: the second device\'s entry was cleared', cleared.status < 300,
    `-> ${cleared.status}`);
  await call('/overview');
  const tap = await call(`/habits/${habitId}/entries/${today}`,
    { method: 'PUT', body: { value: 2 } });
  ck('control: the tap was accepted', tap.status < 300, `-> ${tap.status}`);

  const afterTap = await call('/overview');
  ck('the tap is on the very next /overview',
    afterTap.body.habits[0]?.entries?.[today] === 2,
    JSON.stringify(afterTap.body.habits[0]?.entries));

  // ...and the same for a DELETE, which is the other half of the tap cycle and
  // takes a different route.
  const undo = await call(`/habits/${habitId}/entries/${today}`, { method: 'DELETE' });
  ck('control: the delete was accepted', undo.status < 300, `-> ${undo.status}`);
  const afterUndo = await call('/overview');
  ck('...and so is undoing it',
    afterUndo.body.habits[0]?.entries?.[today] === undefined,
    JSON.stringify(afterUndo.body.habits[0]?.entries));

  console.log('\n--- a write that never touches the /api router invalidates too ---');
  // The invalidation was `api.use(...)`, which is every non-safe method on the
  // `/api` ROUTER — and that is not every write. `NTFY_ANSWER_PATH` is mounted
  // in server.js ABOVE that router on purpose, so it is never reached through
  // `requireAuth`, and it writes a real entry through the same `entryWrite`
  // rule the API uses. Discord's button is the same write from further away
  // still: it arrives on the gateway socket and never touches Express.
  //
  // So: press the button, then refetch with no wait, exactly as a PWA left
  // open in another tab does when it foregrounds. Before the fix this served
  // the day still blank for the length of the TTL.
  //
  // This suite can reach the ntfy half over HTTP; the Discord half shares the
  // single `record` in `interactionAdapter()` that this proves, and driving it
  // would need a gateway socket to fake.
  const warm = await call('/overview');
  ck('control: today is blank before the button is pressed',
    warm.body.habits[0]?.entries?.[today] === undefined,
    JSON.stringify(warm.body.habits[0]?.entries));

  const code = signNtfyAnswer({
    secret: SECRET, account: String(user), habitId, date: today, action: 'yes',
  });
  const pressed = await fetch(`${base}${NTFY_ANSWER_PATH}?c=${encodeURIComponent(code)}`,
    { method: 'POST' });
  ck('control: the button press was accepted', pressed.ok, `-> ${pressed.status}`);

  const afterPress = await call('/overview');
  ck('a button press outside the /api router is on the very next /overview',
    afterPress.body.habits[0]?.entries?.[today] === 2,
    JSON.stringify(afterPress.body.habits[0]?.entries));

  await call(`/habits/${habitId}/entries/${today}`, { method: 'DELETE' });

  console.log('\n--- the caller\'s day is in the key ---');
  const dayLate = dayIn(ZONE_LATE);
  const dayEarly = dayIn(ZONE_EARLY);
  ck('control: the two zones really are on different days', dayLate !== dayEarly,
    `${ZONE_EARLY}=${dayEarly}  ${ZONE_LATE}=${dayLate}`);

  // One entry, on the EARLY zone's today — which is in that device's past-or-
  // present and is already yesterday-or-older for the late one.
  await call(`/habits/${habitId}/entries/${dayEarly}`,
    { method: 'PUT', zone: ZONE_EARLY, body: { value: 2 } });

  // A window ending well before either today, so `end` and `start` are
  // IDENTICAL for both callers and the only thing left that can differ is the
  // summary anchor — which is `summaryEnd`, which is the caller's own day.
  const paged = `/overview?days=5&end=${shiftDate(dayEarly, -10)}`;
  const early = await call(paged, { zone: ZONE_EARLY });
  const late = await call(paged, { zone: ZONE_LATE });

  ck('control: both callers got the same grid window',
    early.body.start === late.body.start && early.body.end === late.body.end,
    `${early.body.start}..${early.body.end} vs ${late.body.start}..${late.body.end}`);
  const differs = differingFields(early.body.habits[0], late.body.habits[0]);
  ck('two devices a day apart do not share one answer', differs.length > 0,
    differs.length
      ? differs.map(([k, a, b]) => `${k}: ${a} vs ${b}`).join(', ')
      : 'byte-identical, so one of them was served the other\'s memo');

  await admin.query(`DELETE FROM session WHERE sid = $1`, [SID]);
  await admin.query(`DELETE FROM users WHERE idp_subject = 'ci-memo'`);
} finally {
  child.kill();
  srv.close();
  await admin.end().catch(() => {});
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL OVERVIEW MEMO CHECKS PASSED');
process.exit(fails ? 1 : 0);
