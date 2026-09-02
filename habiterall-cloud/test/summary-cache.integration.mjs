/**
 * A write clears the habit summary cache — the habits it touched, and no more.
 *
 * `/overview`'s two lifetime figures (`bestStreak`, `totalCompleted`) are stored
 * on the habit row beside `summary_asof`, the day they were computed for. That
 * stamp is the only thing that decides whether the pair is served, so what goes
 * wrong when a write fails to clear it is not a failing request: it is a
 * dashboard reporting a figure from before the tap, on every replica, until the
 * calendar day rolls over. Nothing reports it, and a test that only ever reads a
 * freshly-computed pair passes throughout.
 *
 * So the pin is here, at the write paths, one case per path, and the assertion
 * is the crude out-of-band one that only the clear actually happening can
 * satisfy: stamp the row, make the request, and require the stamp to be gone.
 * Read and written with the ADMIN connection for the reason
 * `data-version.integration.mjs` gives about `data_version` — the app role can
 * see these columns perfectly well, but asking the API would pin only what the
 * API is willing to say about itself, and the API is deliberately never willing
 * to say anything about these three.
 *
 * **Priming goes through the ROUTE, and that is not a detail.** `prime()` is a
 * real `GET /overview`, so what every case below invalidates is a cache the
 * APPLICATION wrote. An earlier round of this suite wrote the three columns
 * through the ADMIN connection instead, because the read path that fills them
 * did not exist yet — and a suite primed that way goes on passing against a
 * write-back that never happens, which is a cache nothing ever hits and a test
 * that cannot see it. The one case still primed out of band is the schema's
 * own: the CHECK constraint has to be shown a stamp with nothing behind it, and
 * that is a row the app will not write.
 *
 * Seven things only this file can see:
 *
 *  1. **The narrowing is real.** A tap on habit A must leave habit B's stamp
 *     alone. Without that case the whole `{habits: [...]}` option could be a
 *     no-op — every other case here would still pass, and the change would have
 *     bought nothing, because a tap-then-refetch is the dominant dashboard
 *     interaction and clearing the account on one recovers none of the cost.
 *  2. **`atMostUnlogged` clears EVERY habit.** `bestStreak` depends on the
 *     ACCOUNT-level setting, not only on entries: `unansweredCounts` falls
 *     through to it for every at-most habit left on `'default'`. A settings
 *     write narrowed to one habit would be silent and long-lived.
 *  3. **The two write paths that never reach the `/api` router clear too** — the
 *     signed ntfy answer, mounted above it, and the Discord button, which never
 *     touches Express at all. Both land in `interactionAdapter().record`.
 *  4. **A READ clears nothing.** The control that makes the rest mean something:
 *     the clear lives in `withUserWrite`, and moved one level down into
 *     `withUser` it would satisfy every case above while making every dashboard
 *     load throw away the cache it had just been served from.
 *  5. **A figure on the WIRE moves after a write.** Everything above is about
 *     the stamp; this is about the number the dashboard draws, which is the
 *     only thing anyone loses. Load, write, load, and require the figure to
 *     have moved — the one assertion that fails when the clear is removed and
 *     that no amount of reading a freshly-computed pair can make.
 *  6. **A cache HIT is genuinely served.** Every case above proves a WRITE
 *     invalidates; none of them proves a READ that finds a live stamp actually
 *     serves what the row holds rather than recomputing regardless. Plant a
 *     deliberately wrong pair through the ADMIN connection, stamp it with the
 *     CALLER's own day, and require `/overview` to answer with that wrong
 *     pair. Without this, `summaryCacheHit` hardcoded to `return false` — a
 *     cache that never hits, so every load recomputes and the three columns do
 *     nothing at all — leaves every other case in this file green, because
 *     both a hit and a permanent miss produce a CORRECT figure, only ever
 *     computed a different number of times.
 *  7. **A stamp dated AHEAD of `summaryEnd` is stale too.** Every other
 *     fixture here stamps a day in the past, so a suite built only from those
 *     cannot tell `asof !== summaryEnd` from `asof < summaryEnd` — both
 *     spellings call a stamp dated yesterday stale. `summary-cache.js`'s own
 *     comment names the direction that does: `summaryEnd` is the CALLER's
 *     day, so an account used from two zones can move it BACKWARDS across a
 *     date boundary, and a pair built for what was then "today" can be ahead
 *     of a later request's `summaryEnd`. Plant a stamp dated TOMORROW and
 *     require the pair to be recomputed, and the stamp moved back onto the
 *     caller's own day rather than left pointing at a day that has not
 *     happened yet.
 *
 * The Discord half is driven in process, through `handleInteraction` over the
 * real `interactionAdapter()`, because the alternative is faking a gateway
 * socket; the ntfy half goes over the real route on the booted server.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/summary-cache.integration.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';

import { NTFY_ANSWER_PATH, signNtfyAnswer } from '@habiterall/shared/ntfy-answer.js';
import { addDays } from '@habiterall/shared/stats.js';

process.env.ADMIN_URL ??= 'postgres://owner:testpw@localhost:5432/habiterall';
process.env.DATABASE_URL ??= 'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

const SECRET = 'summary-cache-integration-secret';
const SID = 'summarycacheintegrationsid01';
const SUBJECT = 'ci-summary-cache';
const CHANNEL = '515151515151515151';

/**
 * What the two OUT-OF-BAND cases stamp, and none of it is a default.
 *
 * The date is deliberately not today and the figures are deliberately not zero
 * — a fixture holding the value the code under test would produce anyway is the
 * one that passes with the code deleted. Two cases need a stamp the application
 * would never write: the CHECK constraint, which has to be shown a stamp with
 * nothing behind it, and `writeBackSummaries`' version guard, which has to be
 * able to say "this row did not move" about something recognisable. Ordinary
 * priming is a real `GET /overview` and stamps the CALLER's own day.
 */
const STAMP = '2001-02-03';
const BEST = 41;
const TOTAL = 17;

// Imported after `process.env` is set and before anything reads a bigint, the
// same ordering `data-version.integration.mjs` explains: `db/pool.js` installs
// parsers on the shared `pg` module, and this file reads its dates as text.
const { interactionAdapter } = await import('../src/notifier.js');
const { withUser, withUserWrite } = await import('../src/db/pool.js');
const { writeBackSummaries } = await import('../src/api.js');
const { handleInteraction, INTERACTION } = await import('@habiterall/shared/discord.js');

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

const { srv, base: issuer } = await fakeIssuer();
const port = 3960 + (process.pid % 130);
const { child, base } = await boot(issuer, port);

try {
  await admin.connect();

  await admin.query(`DELETE FROM users WHERE idp_subject = $1`, [SUBJECT]);
  const { rows: [row] } = await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
     VALUES ($1, 'https://ci.example', 'summary@example.com', 'summary')
     RETURNING id`,
    [SUBJECT]
  );
  const user = Number(row.id);
  await admin.query(
    `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, $3)
     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
    [SID, JSON.stringify({
      cookie: { originalMaxAge: 6048e5, httpOnly: true, path: '/', sameSite: 'lax' },
      user: { id: user, email: 'summary@example.com', name: 'summary', blocked: false },
    }), new Date(Date.now() + 7 * 864e5)]
  );
  const cookie = `habiterall.sid=${signed(SID, SECRET)}`;

  /**
   * @param {string} path
   * @param {{method?: string, body?: any, raw?: Buffer}} [o]
   */
  const call = async (path, { method = 'GET', body, raw } = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        cookie,
        'X-Habiterall-Timezone': 'UTC',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(raw ? { body: raw } : {}),
    });
    const text = res.status === 204 ? '' : await res.text();
    return { status: res.status, body: text === '' ? null : JSON.parse(text) };
  };

  /** The account's counter, read by the owner. */
  const version = async () => Number((await admin.query(
    `SELECT data_version::text AS v FROM users WHERE id = $1`, [user])).rows[0].v);

  /**
   * Every one of the account's habits, as `{id: summary_asof}`.
   *
   * `::text` rather than trusting a type parser: this process has `db/pool.js`
   * loaded for the Discord adapter, which installs one on the shared `pg`
   * module, and what a DATE arrives as here should not depend on import order.
   */
  const stamps = async () => Object.fromEntries((await admin.query(
    `SELECT id, summary_asof::text AS asof FROM habits WHERE user_id = $1 ORDER BY id`,
    [user])).rows.map((r) => [Number(r.id), r.asof]));

  /** One habit's stored pair, read by the owner. */
  const pair = async (id) => (await admin.query(
    `SELECT best_streak, total_completed, summary_asof::text AS asof
       FROM habits WHERE id = $1`, [id])).rows[0];

  /**
   * Give every one of the account's habits a cached pair — through the ROUTE.
   *
   * `GET /overview` is what fills these columns, so this is the priming that
   * proves there is anything to invalidate. It is idempotent twice over: a
   * second load with nothing written between is a memo hit and touches Postgres
   * once, and a load that does rebuild finds every stamp already equal to the
   * caller's day and writes nothing back.
   */
  const prime = async () => {
    const res = await call('/overview');
    if (res.status !== 200) throw new Error(`prime: /overview -> ${res.status}`);
  };

  /** Bump the counter out of band, which makes the next load a memo MISS. */
  const bumpVersion = () => admin.query(
    `UPDATE users SET data_version = data_version + 1 WHERE id = $1`, [user]);

  /** One habit's row out of a fresh `/overview`. */
  const overviewRow = async (id) => {
    const res = await call('/overview');
    if (res.status !== 200) throw new Error(`/overview -> ${res.status}`);
    return res.body.habits.find((h) => h.id === id);
  };

  /**
   * Prime, run FN, and say which habits came back with no stamp.
   *
   * The status is checked as its own control, for the reason the version
   * suite's `bumps` checks it: a route that 400s writes nothing, and "the stamp
   * did not move" read off a request that never happened names the wrong line.
   * The "was primed" control is the second half of the same idea — a `prime()`
   * that silently matched no rows would make every clear assertion vacuously
   * true.
   *
   * @param {string} label
   * @param {() => Promise<{status: number, body?: any}>} fn
   * @returns {Promise<Record<number, string|null>>} the stamps afterwards
   */
  const clears = async (label, fn) => {
    await prime();
    const before = await stamps();
    const ids = Object.keys(before);
    ck(`control: ${label} started from a primed cache`,
      ids.length > 0 && ids.every((id) => before[id] === today),
      JSON.stringify(before));

    const res = await fn();
    ck(`control: ${label} was accepted`, res.status < 300,
      `-> ${res.status} ${JSON.stringify(res.body ?? '').slice(0, 140)}`);

    return stamps();
  };

  const today = dayIn('UTC');

  console.log('--- the columns, as the migration declares them ---');

  const madeA = await call('/habits', {
    method: 'POST',
    body: { name: 'Summary probe A', type: 'boolean', freq_numerator: 1, freq_denominator: 1 },
  });
  const habitA = madeA.body.id;
  const madeB = await call('/habits', {
    method: 'POST',
    body: { name: 'Summary probe B', type: 'boolean', freq_numerator: 1, freq_denominator: 1 },
  });
  const habitB = madeB.body.id;
  ck('control: two habits exist to compare', madeA.status === 201 && madeB.status === 201,
    `${madeA.status}, ${madeB.status}`);

  // Nullable, with no DEFAULT — a habit that has genuinely never been completed
  // has `total_completed = 0`, and a habit whose pair has never been computed
  // has no answer at all. A `NOT NULL DEFAULT 0` collapses the two, which is
  // the mistake the root CLAUDE.md forbids everywhere else.
  const fresh = (await admin.query(
    `SELECT best_streak, total_completed, summary_asof FROM habits WHERE id = $1`,
    [habitA])).rows[0];
  ck('a new habit has NO cached pair, not a pair of zeroes',
    fresh.best_streak === null && fresh.total_completed === null
      && fresh.summary_asof === null,
    JSON.stringify(fresh));

  // The stamp is the single validity flag, so the schema must refuse a stamp
  // with nothing behind it — a row the read path would serve NULL as a number
  // for. Attempted as the OWNER, which bypasses RLS but not a CHECK.
  let refused = null;
  try {
    await admin.query(
      `UPDATE habits SET summary_asof = $2, best_streak = NULL WHERE id = $1`,
      [habitA, STAMP]);
  } catch (err) { refused = err; }
  ck('a stamp with no figures behind it is refused by habits_summary_cache_complete',
    refused?.code === '23514' && refused?.constraint === 'habits_summary_cache_complete',
    `${refused?.code} ${refused?.constraint ?? '(no violation raised)'}`);

  console.log('\n--- one case per write path on the /api router ---');

  let after = await clears('PUT /habits/:id/entries/:date', () =>
    call(`/habits/${habitA}/entries/${today}`, { method: 'PUT', body: { value: 2 } }));
  ck('PUT /habits/:id/entries/:date clears the habit it answered',
    after[habitA] === null, JSON.stringify(after));

  after = await clears('DELETE /habits/:id/entries/:date', () =>
    call(`/habits/${habitA}/entries/${today}`, { method: 'DELETE' }));
  ck('DELETE /habits/:id/entries/:date clears the habit whose day went back to unknown',
    after[habitA] === null, JSON.stringify(after));

  // The frequency moves, which is the completion rule itself moving —
  // `onPaceSeries` judges a day against the trailing `freq_denominator` window,
  // so both figures are derived through it. The name and the type are left
  // alone so the habit stays the one the Discord and ntfy cases below press a
  // yes/no button on, and the one the import below merges into by name.
  after = await clears('PUT /habits/:id', () => call(`/habits/${habitA}`, {
    method: 'PUT',
    body: { name: 'Summary probe A', type: 'boolean',
            freq_numerator: 1, freq_denominator: 2 },
  }));
  ck('PUT /habits/:id clears the habit whose completion rule it replaced',
    after[habitA] === null, JSON.stringify(after));

  console.log('\n--- the account-level writes, which must clear EVERY habit ---');

  // `bestStreak` depends on the account's `atMostUnlogged`, not only on entries:
  // `unansweredCounts` (shared/src/stats.js) falls through to it for every
  // at-most habit whose own `at_most_unlogged` is `'default'`, which is every
  // habit nobody has overridden. Narrowing this write to one habit would leave
  // every other limit on the account reporting a streak computed under the old
  // answer, silently, until each of them was next written to.
  after = await clears('PUT /settings {atMostUnlogged}', () =>
    call('/settings', { method: 'PUT', body: { atMostUnlogged: 'success' } }));
  ck('PUT /settings with atMostUnlogged clears EVERY habit, not just one',
    after[habitA] === null && after[habitB] === null, JSON.stringify(after));

  after = await clears('DELETE /settings', () => call('/settings', { method: 'DELETE' }));
  ck('DELETE /settings clears every habit', after[habitA] === null && after[habitB] === null,
    JSON.stringify(after));

  const backup = Buffer.from(JSON.stringify({
    version: 1,
    app: 'habiterall',
    habits: [{
      name: 'Summary probe A',
      type: 'boolean',
      freq_numerator: 1,
      freq_denominator: 1,
      entries: [{ date: today, value: 2 }],
    }],
  }), 'utf8');
  after = await clears('POST /import', () =>
    call('/import?mode=merge', { method: 'POST', raw: backup }));
  ck('POST /import clears every habit', after[habitA] === null && after[habitB] === null,
    JSON.stringify(after));

  console.log('\n--- the two write paths that never reach the /api router ---');

  // The channel is what authorises a Discord press, so the account has to claim
  // one. Set with the ADMIN connection, which is not the app — if this line
  // cleared anything, the case below would pass without a press.
  await admin.query(
    `UPDATE users SET settings = settings || $2::jsonb WHERE id = $1`,
    [user, JSON.stringify({ discordChannelId: CHANNEL })]
  );

  await prime();
  const sent = [];
  await handleInteraction({
    id: 'i1', token: 'tok', type: INTERACTION.COMPONENT,
    channel_id: CHANNEL,
    member: { user: { id: '999999999999999999' } },
    message: { embeds: [{ title: 'Did you?' }] },
    data: { custom_id: `hab|${habitA}|${today}|yes` },
  }, { ...interactionAdapter(), respond: async (i, r) => { sent.push(r); } });
  after = await stamps();
  ck('control: the Discord press was answered in place',
    sent.at(-1)?.type === 7, JSON.stringify(sent.at(-1)).slice(0, 160));
  ck('a Discord button press clears the habit it names',
    after[habitA] === null, JSON.stringify(after));
  ck('...and only that habit', after[habitB] === today, JSON.stringify(after));

  await prime();
  const code = signNtfyAnswer({
    secret: SECRET, account: String(user), habitId: habitA, date: today, action: 'no',
  });
  const pressed = await fetch(`${base}${NTFY_ANSWER_PATH}?c=${encodeURIComponent(code)}`,
    { method: 'POST' });
  after = await stamps();
  ck('control: the ntfy press was accepted', pressed.ok, `-> ${pressed.status}`);
  ck('a signed ntfy answer clears the habit it names',
    after[habitA] === null, JSON.stringify(after));
  ck('...and only that habit', after[habitB] === today, JSON.stringify(after));

  console.log('\n--- the narrowing is real ---');

  // Without this case every assertion above is satisfied by a `withUserWrite`
  // that ignores `{habits: [...]}` and clears the account on every write — and
  // the change would have bought nothing, because a tap followed by a refetch
  // is the dominant dashboard interaction and clearing the account on the tap
  // recovers none of the cost at the refetch.
  //
  // Primed here as well as inside `clears`, so the pair the route wrote can be
  // read BEFORE the tap. The second prime is a memo hit and writes nothing, so
  // the two reads are of the same stored pair.
  await prime();
  const pairBefore = await pair(habitA);
  after = await clears('a tap on habit A', () =>
    call(`/habits/${habitA}/entries/${today}`, { method: 'PUT', body: { value: 2 } }));
  ck('a tap on habit A clears habit A', after[habitA] === null, JSON.stringify(after));
  ck('a tap on habit A leaves habit B\'s stamp INTACT', after[habitB] === today,
    JSON.stringify(after));

  // The clear takes the STAMP and nothing else: the pair is left where it is,
  // unreadable rather than wrong, which is what the schema's CHECK is written to
  // permit (`summary_asof IS NULL OR ...`) and what `summaryCacheHit` relies on.
  //
  // Compared against what the ROUTE stored rather than against a literal, since
  // the priming is a real load now — with the control that it stored something
  // at all, or "unchanged" would be two nulls agreeing with each other.
  const cleared = await pair(habitA);
  ck('control: the route had actually written a pair to leave behind',
    pairBefore.best_streak !== null && pairBefore.total_completed !== null,
    JSON.stringify(pairBefore));
  ck('the clear takes the stamp alone and leaves the figures beside it',
    cleared.best_streak === pairBefore.best_streak
      && cleared.total_completed === pairBefore.total_completed,
    `${JSON.stringify(pairBefore)} -> ${JSON.stringify(cleared)}`);

  console.log('\n--- a read clears nothing ---');

  // The control the whole suite rests on. `withUser` wraps the reads too, so a
  // clear written into IT rather than into `withUserWrite` satisfies every case
  // above while making every dashboard load discard the cache it was just
  // served from — which is the cache never being used, at the cost of a write
  // per read. `data_version` is asserted beside it because the write-back STEP 3
  // adds runs on a GET: it must go through bare `withUser`, or `/overview`
  // invalidates the very memo it is filling.
  await prime();
  const beforeReads = await version();
  const reads = [
    await call('/overview'),
    await call('/overview'),
    await call('/habits'),
  ];
  const afterReads = await version();
  after = await stamps();
  ck('control: all three reads answered', reads.every((r) => r.status === 200),
    reads.map((r) => r.status).join(','));
  ck('two /overview loads and a /habits leave every stamp where it was',
    after[habitA] === today && after[habitB] === today, JSON.stringify(after));
  ck('...and leave data_version exactly where it was', afterReads === beforeReads,
    `${beforeReads} -> ${afterReads}`);

  console.log('\n--- the figure on the WIRE moves after a write ---');

  // Everything above this line is about the stamp. This is about the number the
  // dashboard draws, which is the only thing a user ever loses — and it is the
  // one assertion in the file that a `withUserWrite` with its clear removed
  // cannot satisfy. A suite that only ever reads a freshly-computed pair passes
  // throughout that mutation, because every figure it sees was derived a
  // moment earlier from the data it is checking against.
  const madeC = await call('/habits', {
    method: 'POST',
    body: { name: 'Summary probe C', type: 'boolean', freq_numerator: 1, freq_denominator: 1 },
  });
  const habitC = madeC.body.id;
  ck('control: the read-path probe exists', madeC.status === 201,
    `${madeC.status} ${JSON.stringify(madeC.body).slice(0, 120)}`);

  const day = (n) => addDays(today, -n);

  // A daily boolean habit, so the arithmetic is not in question: one completion
  // is a streak of one and two consecutive ones are a streak of two. Dated in
  // the PAST rather than today, so nothing here depends on when the suite runs
  // relative to midnight.
  const wroteFirst = await call(`/habits/${habitC}/entries/${day(5)}`,
    { method: 'PUT', body: { value: 2 } });
  const load1 = await overviewRow(habitC);
  const cachedAfterLoad1 = await pair(habitC);

  const wroteSecond = await call(`/habits/${habitC}/entries/${day(4)}`,
    { method: 'PUT', body: { value: 2 } });
  const load2 = await overviewRow(habitC);

  ck('control: both entries were accepted',
    wroteFirst.status < 300 && wroteSecond.status < 300,
    `${wroteFirst.status}, ${wroteSecond.status}`);
  ck('control: the first load derived the pair the fixture predicts',
    load1.totalCompleted === 1 && load1.bestStreak === 1,
    `best=${load1.bestStreak} total=${load1.totalCompleted}`);
  // Without this the two `MOVED` checks below hold against a route that caches
  // nothing at all, and the whole change could be absent.
  ck('control: that first load WROTE the pair back onto the row',
    cachedAfterLoad1.asof === today && cachedAfterLoad1.best_streak === 1
      && cachedAfterLoad1.total_completed === 1,
    JSON.stringify(cachedAfterLoad1));
  ck('totalCompleted MOVED on the load after the write',
    load2.totalCompleted === 2, `${load1.totalCompleted} -> ${load2.totalCompleted}`);
  ck('bestStreak MOVED on the load after the write',
    load2.bestStreak === 2, `${load1.bestStreak} -> ${load2.bestStreak}`);
  ck('...and the row was re-stamped for the caller\'s day, not left invalidated',
    (await pair(habitC)).asof === today, JSON.stringify(await pair(habitC)));

  console.log('\n--- bestStreak depends on an ACCOUNT setting, so flipping it must move it ---');

  // The hazard the issue does not mention. `bestStreak` reads
  // `unansweredCounts`, which falls through to the account's `atMostUnlogged`
  // for every at-most habit left on `'default'` — so a settings write narrowed
  // to one habit would leave every other limit on the account reporting a
  // streak computed under the old answer. Silent, and it lasts until each of
  // them is next written to.
  const setMiss = await call('/settings', { method: 'PUT', body: { atMostUnlogged: 'miss' } });
  const madeD = await call('/habits', {
    method: 'POST',
    body: {
      name: 'Summary limit D', type: 'numerical', unit: 'cups', target_value: 0,
      target_type: 'at_most', freq_numerator: 1, freq_denominator: 1,
      at_most_unlogged: 'default',
    },
  });
  const habitD = madeD.body.id;
  // One stated clean day, nine days back, and silence since. Under `miss` that
  // silence is nine misses; under `success` it is nine more kept days, and the
  // habit's first STATED answer is where the credit starts (#223).
  const cleanDay = await call(`/habits/${habitD}/entries/${day(9)}`,
    { method: 'PUT', body: { value: 0 } });
  const underMiss = await overviewRow(habitD);
  const setSuccess = await call('/settings',
    { method: 'PUT', body: { atMostUnlogged: 'success' } });
  const underSuccess = await overviewRow(habitD);

  ck('control: the limit habit and its one clean day were accepted',
    setMiss.status < 300 && madeD.status === 201 && cleanDay.status < 300,
    `${setMiss.status}, ${madeD.status}, ${cleanDay.status}`);
  ck('under `miss` the limit reports only the day it stated',
    underMiss.bestStreak === 1, `best=${underMiss.bestStreak}`);
  ck('flipping atMostUnlogged to `success` MOVES bestStreak on a habit nothing wrote to',
    underSuccess.bestStreak === 10,
    `${underMiss.bestStreak} -> ${underSuccess.bestStreak}`);

  await call('/settings', { method: 'PUT', body: { atMostUnlogged: 'miss' } });

  console.log('\n--- a cached load and an uncached load are the same payload ---');

  // What this proves is narrower than it sounds: that the PAYLOAD SHAPE a hit
  // and a miss produce is identical, key for key, when both start from the
  // same underlying data. It does NOT prove a hit ever happens — a
  // `summaryCacheHit` hardcoded to `return false` recomputes both loads from
  // the same rows and passes this check too, since two correct answers agree
  // whichever way each was produced. The case below named "a cache HIT is
  // genuinely served" is what actually distinguishes the two, with a planted
  // pair a recompute cannot arrive at by accident. Both loads here are memo
  // MISSES — the version is bumped out of band before each, which is the only
  // way to reach `buildOverview` twice with the same data — and the difference
  // between them is whether the three columns held anything.
  await prime();
  const primedStamps = await stamps();
  ck('control: every habit is stamped before the cached read',
    Object.values(primedStamps).length > 0
      && Object.values(primedStamps).every((v) => v === today),
    JSON.stringify(primedStamps));
  await bumpVersion();
  const cachedLoad = await call('/overview');

  await admin.query(
    `UPDATE habits SET best_streak = NULL, total_completed = NULL, summary_asof = NULL
      WHERE user_id = $1`, [user]);
  const nulled = await stamps();
  await bumpVersion();
  const freshLoad = await call('/overview');

  ck('control: the second read had no cached pair to serve from',
    Object.values(nulled).every((v) => v === null), JSON.stringify(nulled));
  let differ = null;
  try {
    assert.deepStrictEqual(cachedLoad.body, freshLoad.body);
  } catch (err) { differ = err; }
  ck('a cached load and an uncached load are the same payload, key for key',
    differ === null, (differ?.message ?? '').split('\n').slice(0, 8).join(' / '));

  console.log('\n--- a cache HIT is genuinely served, not silently recomputed ---');

  // THE assertion this suite was missing. Every case above proves a WRITE
  // invalidates the stamp; none of them proves a READ that finds a live one
  // actually serves what the row holds. A `summaryCacheHit` hardcoded to
  // `return false` recomputes on every load, so the columns do nothing at
  // all — and the whole rest of this file stays green, because a hit and a
  // permanent miss both answer correctly, only a different number of times.
  //
  // Planted through the ADMIN connection and stamped with the CALLER's own
  // day, so `/overview` has no honest way to arrive at these numbers except
  // by reading the row. One real completion makes the true pair (1, 1); 777
  // is not reachable from that fixture by any recompute, the same shape
  // personal's suite plants for the same reason.
  const madeHit = await call('/habits', {
    method: 'POST',
    body: { name: 'Summary cache hit', type: 'boolean', freq_numerator: 1, freq_denominator: 1 },
  });
  const habitHit = madeHit.body.id;
  const wroteHit = await call(`/habits/${habitHit}/entries/${today}`,
    { method: 'PUT', body: { value: 2 } });
  ck('control: the cache-hit probe and its one real completion were accepted',
    madeHit.status === 201 && wroteHit.status < 300, `${madeHit.status}, ${wroteHit.status}`);

  await admin.query(
    `UPDATE habits SET best_streak = 777, total_completed = 777, summary_asof = $2
      WHERE id = $1`, [habitHit, today]);

  const hitRow = await overviewRow(habitHit);
  ck('THE ASSERTION: /overview serves the deliberately WRONG cached pair, ' +
    'proving it is read off the row rather than recomputed',
    hitRow.bestStreak === 777 && hitRow.totalCompleted === 777, JSON.stringify(hitRow));

  console.log('\n--- a stamp dated AHEAD of summaryEnd is recomputed, not served ---');

  // Every fixture elsewhere in this file stamps a day in the PAST (`STAMP`,
  // and `day(n)` above), so a suite built only from those cannot distinguish
  // `asof !== summaryEnd` from `asof < summaryEnd` — a stamp dated yesterday
  // is stale under both spellings. `summary-cache.js`'s own comment names the
  // direction that does: `summaryEnd` is the CALLER's day, so an account used
  // from two zones can move it BACKWARDS across a date boundary, and a pair
  // built for what was then "today" can be dated ahead of a LATER request's
  // `summaryEnd`. `<` would still call that "fresh"; only `!==` catches it.
  const madeAhead = await call('/habits', {
    method: 'POST',
    body: { name: 'Summary cache tomorrow', type: 'boolean',
            freq_numerator: 1, freq_denominator: 1 },
  });
  const habitAhead = madeAhead.body.id;
  const wroteAhead = await call(`/habits/${habitAhead}/entries/${today}`,
    { method: 'PUT', body: { value: 2 } });
  ck('control: the tomorrow-stamp probe and its one real completion were accepted',
    madeAhead.status === 201 && wroteAhead.status < 300,
    `${madeAhead.status}, ${wroteAhead.status}`);

  const tomorrow = addDays(today, 1);
  await admin.query(
    `UPDATE habits SET best_streak = 888, total_completed = 888, summary_asof = $2
      WHERE id = $1`, [habitAhead, tomorrow]);

  const aheadRow = await overviewRow(habitAhead);
  const afterAhead = await pair(habitAhead);
  ck('THE ASSERTION: a stamp dated ahead of summaryEnd is recomputed, not ' +
    'served as fresh — the direction `!==` and `<` disagree on',
    aheadRow.bestStreak === 1 && aheadRow.totalCompleted === 1, JSON.stringify(aheadRow));
  ck('...and the stamp is moved back onto the caller\'s own day, not left ' +
    'pointing at a day that has not happened yet',
    afterAhead.asof === today, JSON.stringify(afterAhead));

  console.log('\n--- the write-back refuses a stale data_version ---');

  // Cloud's `withUser` is READ COMMITTED, so a write committing between the
  // entry reads and the write-back has already cleared the stamp — and without
  // the guard we would put it straight back, stamped as of TODAY, holding
  // figures built from pre-write data. That is the "version last" failure
  // `caching.md` describes, and it survives until the calendar day rolls over.
  //
  // The race is not deterministically reachable over HTTP, which is exactly why
  // `writeBackSummaries` is a named export: called directly it can be handed a
  // version that is deliberately behind.
  await admin.query(
    `UPDATE habits SET best_streak = $2, total_completed = $3, summary_asof = $4
      WHERE id = $1`, [habitB, BEST, TOTAL, STAMP]);
  const liveVersion = await version();
  const staleRows = await withUser(user, (db) =>
    writeBackSummaries(db, user, liveVersion - 1, today,
      [{ id: habitB, best_streak: 7, total_completed: 3 }]));
  const afterStale = await pair(habitB);
  ck('a write-back at a stale data_version stamps nothing', staleRows === 0,
    `rows=${staleRows}`);
  ck('...and leaves the row exactly as it found it',
    afterStale.best_streak === BEST && afterStale.total_completed === TOTAL
      && afterStale.asof === STAMP,
    JSON.stringify(afterStale));

  // The control without which the case above passes against a function that
  // writes nothing whatever it is handed.
  const liveRows = await withUser(user, (db) =>
    writeBackSummaries(db, user, liveVersion, today,
      [{ id: habitB, best_streak: 7, total_completed: 3 }]));
  const afterLive = await pair(habitB);
  ck('control: the same call at the LIVE version does stamp the row',
    liveRows === 1 && afterLive.best_streak === 7 && afterLive.total_completed === 3
      && afterLive.asof === today,
    `rows=${liveRows} ${JSON.stringify(afterLive)}`);

  console.log('\n--- the three columns never reach a client ---');

  // `api.integration.mjs`'s `PORTABLE_HABIT_KEYS` is the tripwire for `/export`
  // alone, and it is an exact key-set comparison that must keep passing
  // UNEDITED — these columns are never portable. This is the same claim at the
  // other seven serialisation points, where `SELECT *` and `RETURNING *` would
  // otherwise carry them. Asserted by NAME, spelled out here rather than
  // imported, so a rename in `SUMMARY_CACHE_COLUMNS` cannot silently take the
  // assertion with it.
  const SERVER_ONLY = ['best_streak', 'summary_asof', 'total_completed'];
  const carries = (o) => (o ? SERVER_ONLY.filter((k) => k in o) : ['(no payload)']);

  const madeE = await call('/habits', {
    method: 'POST',
    body: { name: 'Summary probe E', type: 'boolean', freq_numerator: 1, freq_denominator: 1 },
  });
  const putE = await call(`/habits/${madeE.body.id}`, {
    method: 'PUT',
    body: { name: 'Summary probe E2', type: 'boolean', freq_numerator: 1, freq_denominator: 1 },
  });
  const reordered = await call('/habits/reorder',
    { method: 'POST', body: { order: [habitB, habitA] } });

  // Primed AFTER those three writes, so every row below is read with all three
  // columns actually holding something. A `RETURNING *` carries a column
  // whether or not it is null, so the two write responses bite either way.
  await prime();
  const readStamps = await stamps();
  const habitsList = await call('/habits');
  const oneHabit = await call(`/habits/${habitA}`);
  const oneStats = await call(`/habits/${habitA}/stats`);
  const overviewBody = await call('/overview');
  const exportBody = await call('/export');

  ck('control: the rows carried a cached pair while those payloads were built',
    Object.values(readStamps).every((v) => v === today), JSON.stringify(readStamps));
  ck('control: all eight serialisation points answered',
    [madeE.status === 201, putE.status === 200, reordered.status === 200,
     habitsList.status === 200, oneHabit.status === 200, oneStats.status === 200,
     overviewBody.status === 200, exportBody.status === 200].every(Boolean),
    [madeE, putE, reordered, habitsList, oneHabit, oneStats, overviewBody, exportBody]
      .map((r) => r.status).join(','));

  const leaked = [
    ...carries(madeE.body).map((k) => `POST /habits:${k}`),
    ...carries(putE.body).map((k) => `PUT /habits/:id:${k}`),
    ...reordered.body.flatMap((h) => carries(h).map((k) => `reorder:${k}`)),
    ...habitsList.body.flatMap((h) => carries(h).map((k) => `GET /habits:${k}`)),
    ...carries(oneHabit.body).map((k) => `GET /habits/:id:${k}`),
    ...carries(oneStats.body.habit).map((k) => `GET /stats:${k}`),
    ...overviewBody.body.habits.flatMap((h) => carries(h).map((k) => `/overview:${k}`)),
    ...exportBody.body.habits.flatMap((h) => carries(h).map((k) => `/export:${k}`)),
  ];
  ck('no habit payload from any of the eight carries a summary-cache column',
    leaked.length === 0, leaked.join(', '));

  console.log('\n--- an empty narrowing means the whole account, not nothing ---');

  // `id = ANY('{}')` is false for every row, so `{habits: []}` is the one
  // spelling of the option that fails in the UNSAFE direction — it would clear
  // nothing at all, silently. No caller passes one today, which is precisely
  // why one will: a caller that computes an id list and finds it empty. The
  // asymmetry the function's own comment rests on decides it — over-clearing
  // costs a recomputation, under-clearing serves a figure from before the
  // write — so `[]` means what `null` means.
  await prime();
  const beforeEmpty = await stamps();
  await withUserWrite(user, async () => {}, { habits: [] });
  const afterEmpty = await stamps();
  ck('control: more than one habit was stamped before the empty-array write',
    Object.values(beforeEmpty).length > 1
      && Object.values(beforeEmpty).every((v) => v === today),
    JSON.stringify(beforeEmpty));
  ck('withUserWrite({habits: []}) clears EVERY habit, exactly as null does',
    Object.values(afterEmpty).every((v) => v === null), JSON.stringify(afterEmpty));

  await admin.query(`DELETE FROM session WHERE sid = $1`, [SID]);
  await admin.query(`DELETE FROM users WHERE idp_subject = $1`, [SUBJECT]);
} finally {
  child.kill();
  srv.close();
  await admin.end().catch(() => {});
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL SUMMARY CACHE CHECKS PASSED');
process.exit(fails ? 1 : 0);
