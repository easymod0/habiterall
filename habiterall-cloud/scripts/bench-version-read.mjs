#!/usr/bin/env node
/**
 * What a per-request version read would cost `/overview`, measured. (#192)
 *
 *   DATABASE_URL=postgres://habiterall_app:apptestpw@localhost:5432/habiterall \
 *   ADMIN_URL=postgres://owner:testpw@localhost:5432/habiterall \
 *   node bench-version-read.mjs
 *
 * #192 has two candidate shapes and `docs/decisions/caching.md` picks one of
 * them on a cost claim rather than on a measurement:
 *
 *   ECHO  — the write response carries the account's new version, the client
 *           echoes it back, the memo entry records the version it was built at.
 *           No database read on the memo HIT path. Closes read-your-own-writes
 *           across replicas; leaves one account's OTHER devices ≤ TTL stale,
 *           and so pins `OVERVIEW_TTL_MS` at 2 s permanently, since the TTL
 *           stays the correctness mechanism.
 *
 *   READ  — the route reads `users.data_version` on every request and puts it
 *           in the memo key. Closes both halves on every replica with no client
 *           cooperation at all, and lets the TTL become a backstop. Costs one
 *           primary-key lookup and a pool checkout on the hit path — which the
 *           archive rejects as "puts back the round trip the memo exists to
 *           remove five of".
 *
 * That phrase is the claim under test. The read removes ONE round trip, not
 * five, and what it is worth depends on three numbers nobody has taken:
 *
 *   1. what the version read actually costs through `withUser`;
 *   2. what a hit and a miss cost end to end, so the read can be priced
 *      against the rebuild it lets the memo avoid;
 *   3. what the read costs while the pool is BUSY — the honest worst case,
 *      where a hit that is free today has to queue behind rebuilds for one of
 *      `PG_POOL_MAX` connections. That is the "the memo stops being a load
 *      shedder" objection, and it is the one that could kill the idea.
 *
 * ...and a fourth that has nothing to do with the read and everything to do
 * with what #192 does to the TTL:
 *
 *   4. how big ONE memo entry is, in the unit `sizeOf` returns. A 60 s TTL
 *      makes `MAX_OVERVIEW_CACHED` a number derived from `MAX_OVERVIEW_BYTES`
 *      and a measured entry, rather than from the residency argument a 2 s TTL
 *      supported — so the entry size is now load bearing for a CONSTANT, and
 *      `cache.test.js` restates all four figures as literals. They were left as
 *      a claim in a comment when this file first shipped, which is the shape
 *      this file exists to refuse; the previous generation of exactly these
 *      numbers was wrong, so a size measured nowhere is one that goes stale
 *      again in silence.
 *
 * Measured through the real route, over HTTP, against a real Postgres, as
 * `habiterall_app` inside `withUser` — never as the owner, for the reason
 * `bench-queries.mjs` gives: a plan taken as a superuser bypasses RLS and is a
 * plan of a query this application never issues.
 *
 * ## How a hit and a miss are forced
 *
 * A **MISS** is forced the way the shipped design makes one: `data_version` is
 * bumped on the ADMIN connection between requests, which moves the memo key,
 * so the next request cannot reach anything already stored. That is a real
 * miss and not a simulated one — the same event a write on another replica
 * produces — and it needs no second fixture and no waiting out the TTL. The
 * bump is issued outside the timed region, so what is measured is the request.
 *
 * A **HIT** is any request after that with no bump in between, inside the TTL.
 *
 * The first version of this file forced its miss with `X-Habiterall-Fresh: 1`,
 * the header #192 deleted. Re-run against the shipped route that header does
 * nothing at all, so every "miss" it reported would have been a hit and the
 * two numbers this file exists to compare would have been the same number.
 *
 * ## A hit is no longer free, and the rows say so
 *
 * Before #192 a memo hit touched Postgres zero times, so the interesting
 * quantity was a PROJECTION: hit plus the version read. The shipped route reads
 * the version in front of the memo, so the measured hit already CARRIES it, and
 * the row that said "no database touch" would now be describing something else
 * entirely. The read is measured beside the hit instead, and the projection
 * runs the other way — hit minus read is what a hit cost before this change,
 * which is the baseline the rebuild has to be priced against.
 *
 * ## It is DESTRUCTIVE
 *
 * It writes its own accounts and habits. Point it at a throwaway database, as
 * `bench-queries.mjs` and the tenancy suite already ask. It needs migration 017
 * applied and refuses to run without it, rather than adding the column itself:
 * a bench that provisions its own schema is measuring a database no deployment
 * has.
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';

process.env.ADMIN_URL ??= 'postgres://owner:testpw@localhost:5432/habiterall';
process.env.DATABASE_URL ??=
  'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

const SECRET = 'bench-version-read-secret';
const SID = 'benchversionreadsid000000001';

/** Habit counts, the three `docs/decisions/caching.md` states measurements at. */
const SHAPES = [8, 20, 50];

/** Days of history per habit. 365 is the memo's own worst documented case. */
const DAYS = 365;

/**
 * Samples per measurement — fewer over HTTP than against the database.
 *
 * `RATE_LIMITS.api` is 300/minute keyed per authenticated user, and this
 * edition has no `HABITERALL_RATE_LIMIT=off`: that switch is the PERSONAL
 * edition's, which has one account and so keys on IP. Keying per user is why
 * cloud does not need one — and it is also why this file cannot simply turn
 * the limiter off and send thousands of requests down one session. So every
 * measurement gets its OWN account, and each stays comfortably inside one
 * account's minute. A 429 mid-run is the limiter working, not a fixture
 * problem; if these counts are raised, raise the account count with them.
 */
const N_HTTP = 120;

/** Samples for the database-only measurements, which no limiter can see. */
const N_DB = 200;

/** `PG_POOL_MAX`'s default, which the pool-pressure section is written against. */
const POOL_MAX = 10;

const idle = (ms) => new Promise((r) => setTimeout(r, ms));

const signed = (sid, secret) =>
  `s%3A${sid}.${encodeURIComponent(
    createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, ''))}`;

/* ---------- statistics ---------- */

/**
 * p50 / p95 / p99 and the mean, in milliseconds.
 *
 * Percentiles rather than a mean alone because the whole question here is what
 * happens under CONTENTION, where the mean is exactly the statistic that hides
 * it: a pool checkout that is free nine times and waits 40 ms once reports a
 * flattering average and a p99 that names the problem.
 */
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s.at(-1),
  };
}

const ms = (x) => x.toFixed(2).padStart(8);
const row = (label, s) =>
  console.log(`  ${label.padEnd(38)} ${ms(s.mean)} ${ms(s.p50)} ${ms(s.p95)} ${ms(s.p99)} ${ms(s.max)}`);
const header = () =>
  console.log(`  ${''.padEnd(38)} ${'mean'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)}`);

/** Time one async call, in ms, on the monotonic clock. */
async function timed(fn) {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

/* ---------- the server, and a session for it ---------- */

/** Minimal OIDC discovery, so `initAuth` completes without a real IdP. */
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
      OIDC_CLIENT_ID: 'bench-client',
      OIDC_CLIENT_SECRET: 'bench-secret',
      ALLOW_INSECURE_OIDC: 'true',
      HABITERALL_NOTIFY: 'off',
      // The read limiter is 300/min and this sends thousands. Off, because what
      // is being measured is the route and not the limiter.
      HABITERALL_RATE_LIMIT: 'off',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => {
    const s = String(b);
    if (!s.includes('oidc.insecure') && !s.includes('rate_limit')) {
      process.stderr.write(`  [server] ${s}`);
    }
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

/* ---------- run ---------- */

const admin = new pg.Client({ connectionString: process.env.ADMIN_URL });
const { srv, base: issuer } = await fakeIssuer();
const port = 3700 + (process.pid % 200);
const { child, base } = await boot(issuer, port);

/** The app role's own pool, configured exactly as `db/pool.js` configures its. */
const appPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

try {
  await admin.connect();

  // The column under test comes from migration 017 and is checked for rather
  // than created. An earlier draft added it here with `IF NOT EXISTS`, on the
  // reasoning that the measurement should not depend on which shape #192 ships
  // — which stopped being true the moment one did. Creating it now would let
  // this run green against an unmigrated database, measuring a route reading a
  // column no deployment has and a memo key no deployment builds.
  const { rows: [col] } = await admin.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'data_version'`);
  if (!col) throw new Error('users.data_version is missing — run the migrations first');
  await admin.query(`DELETE FROM users WHERE idp_subject LIKE 'bench-192-%'`);

  /**
   * One account, its session, and `habits` habits x `DAYS` days of entries.
   *
   * An account per measurement, for the limiter reason at `N_HTTP` — and it
   * costs the numbers nothing, because the memo is keyed per account anyway,
   * so two measurements on one account would share a memo while two on
   * separate accounts share nothing. Separate is the cleaner fixture as well
   * as the necessary one.
   *
   * @param {string} tag
   * @param {number} habits
   */
  async function account(tag, habits) {
    const sub = `bench-192-${tag}`;
    const sid = `benchversionread${tag}`.padEnd(28, '0').slice(0, 28);
    const { rows: [r] } = await admin.query(
      `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
       VALUES ($1, 'https://bench.example', $2, $3) RETURNING id`,
      [sub, `${tag}@bench.example`, tag]
    );
    // `Number`, for the reason `overview-memo.integration.mjs` states: this
    // client is built before `db/pool.js` installs its BIGINT parser, so the
    // id arrives as a string and `withUser`'s integer guard would refuse it.
    const id = Number(r.id);

    await admin.query(
      `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sid, JSON.stringify({
        cookie: { originalMaxAge: 6048e5, httpOnly: true, path: '/', sameSite: 'lax' },
        user: { id, email: `${tag}@bench.example`, name: tag, blocked: false },
      }), new Date(Date.now() + 7 * 864e5)]
    );

    await admin.query(
      `INSERT INTO habits (user_id, name, position, type, target_value, target_type)
       SELECT $1, 'habit ' || h, h, 'boolean', 1, 'at_least'
         FROM generate_series(1, $2) h`,
      [id, habits]
    );
    await admin.query(
      `INSERT INTO entries (habit_id, user_id, date, value, status)
       SELECT h.id, $2, (CURRENT_DATE - d)::date, 1, ''
         FROM habits h, generate_series(0, $1 - 1) d
        WHERE h.user_id = $2`,
      [DAYS, id]
    );

    const cookie = `habiterall.sid=${signed(sid, SECRET)}`;

    /** One `/overview` request. */
    const overview = async () => {
      const res = await fetch(`${base}/api/overview?days=${DAYS}`, {
        headers: { cookie, 'X-Habiterall-Timezone': 'UTC' },
      });
      // Drained, because an unread body leaves the socket unusable and the
      // next call would measure connection setup rather than the route.
      await res.text();
      if (!res.ok) throw new Error(`/overview answered ${res.status} for ${tag}`);
    };

    /**
     * Move this account's memo key, so the next request is a guaranteed miss.
     *
     * Through the admin connection rather than through a write route, because
     * a route would also change the DATA and so the payload being timed. This
     * is exactly what a write on ANOTHER replica looks like from here: the
     * counter moves, the route reads the new value, and every entry stored at
     * the old one is unreachable. `withUserWrite` does the same thing in the
     * write's own transaction; nothing here needs the write.
     */
    const bump = () =>
      admin.query('UPDATE users SET data_version = data_version + 1 WHERE id = $1', [id]);

    /**
     * The response BODY for a given grid window, for section 4.
     *
     * Separate from `overview` above rather than folded into it, because that
     * one is on a timed path and must not be measured drinking its own body
     * twice — and because the window is a parameter here where everything
     * timed uses `DAYS`. The default 30 is the dashboard's own, and the entry
     * it produces is the SMALLEST real one, which is the one that decides
     * whether the count bound binds before the byte bound.
     *
     * @param {number} days
     */
    const body = async (days) => {
      const res = await fetch(`${base}/api/overview?days=${days}`, {
        headers: { cookie, 'X-Habiterall-Timezone': 'UTC' },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`/overview answered ${res.status} for ${tag}`);
      return text;
    };

    return { id, overview, bump, body };
  }

  /**
   * The version read, exactly as a route would issue it: through the app role,
   * inside `withUser`'s transaction, with the same transaction-local
   * `set_config` the RLS policies read.
   */
  const versionRead = async (user) => {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.user_id', String(user)]);
      await c.query('SELECT data_version FROM users WHERE id = $1', [user]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  };

  /**
   * The same read with no transaction around it — what `withoutUser` would
   * cost. Reported for information only: it is an RLS BYPASS, and
   * `habiterall-cloud/CLAUDE.md` asks that those call sites stay countable on
   * one hand. It is here to separate the cost of the QUERY from the cost of
   * the transaction wrapper, which is the part that could be made cheaper
   * without touching the security boundary.
   */
  const versionReadBare = async (user) =>
    appPool.query('SELECT data_version FROM users WHERE id = $1', [user]);

  /** `n` samples of `fn`, timed, serially. */
  const sample = async (n, fn) => {
    const xs = [];
    for (let i = 0; i < n; i++) xs.push(await timed(fn));
    return stats(xs);
  };

  console.log(`\nhabiterall #192 — what a per-request version read costs`);
  console.log(`node ${process.version} · pool max ${POOL_MAX} · ${DAYS} days of history`);
  console.log(`${N_DB} samples per database measurement, ${N_HTTP} per HTTP one\n`);

  /* ---------- 1. the read itself, uncontended ---------- */

  const probe = await account('probe', 1);
  await admin.query(`ANALYZE habits, entries, users`);

  console.log('1. The version read, pool idle');
  header();
  await versionRead(probe.id); // warm, so connection setup is not in the sample
  row('withUser (BEGIN/set_config/SELECT/COMMIT)',
    await sample(N_DB, () => versionRead(probe.id)));
  await versionReadBare(probe.id);
  row('bare SELECT (no transaction; RLS bypass)',
    await sample(N_DB, () => versionReadBare(probe.id)));

  /* ---------- 2. hit and miss, per habit count ---------- */

  const shaped = [];
  for (const habits of SHAPES) shaped.push([habits, await account(`h${habits}`, habits)]);
  await admin.query(`ANALYZE habits, entries, users`);

  for (const [habits, acct] of shaped) {
    console.log(`\n2.${SHAPES.indexOf(habits) + 1} /overview end to end — ${habits} habits x ${DAYS} days`);
    header();

    // A rebuild every time. The bump is OUTSIDE the timed region, so what is
    // sampled is one request that could not have reached a stored entry.
    const missXs = [];
    for (let i = 0; i < 40; i++) {
      await acct.bump();
      missXs.push(await timed(() => acct.overview()));
    }
    const miss = stats(missXs);
    row('MISS (full rebuild)', miss);

    // Warm, then read back with no bump in between. Re-warmed every 20 samples
    // so no sample can fall past `OVERVIEW_TTL_MS` and be measured as a miss —
    // which would be silent, and would flatter the hit by averaging a rebuild
    // into it in exactly the direction this file is about.
    const hitXs = [];
    for (let i = 0; i < N_HTTP; i++) {
      if (i % 20 === 0) await acct.overview();
      hitXs.push(await timed(() => acct.overview()));
    }
    const hit = stats(hitXs);
    row('HIT (memo + the version read)', hit);

    // The read on its own, re-measured per shape against the same warm pool —
    // this is the part of the HIT above that #192 added, and the only part.
    const v = await sample(N_DB, () => versionRead(acct.id));
    row('  the version read inside it, alone', v);

    // What a hit cost BEFORE #192, on THIS machine: the hit above minus the
    // read it now carries. Stated as a mean and nothing else, deliberately —
    // subtracting a p95 from a p95 is not a p95 of anything, and the earlier
    // version of this file printed a whole projected percentile row that had
    // that arithmetic in it. The mean is the one figure the subtraction is
    // sound for, and it is the one the break-even below needs.
    //
    // Cross-checked rather than trusted: the shipped hit is one authenticated
    // request plus one `withUser` transaction, and `GET /api/habits` is
    // exactly that shape — it measured 2.36 ms against this hit's 2.46 ms
    // while `/healthz`, which is mounted above the session middleware and
    // touches no transaction, measured 1.33 ms. So the per-request floor here
    // is ~2 ms of HTTP and session, the read is the ~0.3 ms on top, and the
    // subtraction lands where the probes say it should.
    const wasHit = hit.mean - v.mean;
    console.log(`     a hit before #192 (hit − read): ${wasHit.toFixed(2)}ms mean`);

    // What fraction of requests the read has to convert from miss to hit to
    // pay for itself. This is the number the decision turned on: below it the
    // read is a net loss however cheap it is, above it a net win however dear.
    const rebuild = miss.mean - wasHit;
    const breakeven = v.mean / rebuild;
    console.log(`     break-even: pays if it converts >${(breakeven * 100).toFixed(2)}%`
      + ` of requests from miss to hit`);
    console.log(`     (version read ${v.mean.toFixed(2)}ms · rebuild avoided `
      + `${rebuild.toFixed(2)}ms)`);
  }

  /* ---------- 3. the read while the pool is busy ---------- */

  /**
   * The objection that could kill the idea, made measurable.
   *
   * Today a memo hit touches Postgres zero times, so it is answered at full
   * speed however saturated the pool is — the memo is a load SHEDDER. With a
   * version read on the hit path it has to check out one of `PG_POOL_MAX`
   * connections, behind whatever rebuilds are in flight. If a rebuild holds a
   * connection for ~30 ms and ten of them are running, the read waits.
   *
   * **The load and the read must contend on ONE pool, and the first version of
   * this section did not.** It drove the load through the server's `/overview`
   * — the server process's own pool — while the reads went through this file's
   * `appPool`, a second pool of ten connections to the same Postgres. What it
   * measured was therefore "is Postgres itself slower under load" (it is not:
   * flat to 20 concurrent rebuilds) and NOT "does the read queue for a
   * connection", which is the entire objection. It looked decisive and was
   * answering a question nobody had asked.
   *
   * So the load is synthetic and runs through `appPool`, whose `max` is
   * `POOL_MAX`: each loader holds one connection inside a `withUser`-shaped
   * transaction for `HOLD_MS`, which is what a rebuild does to a connection.
   * `buildOverview` runs its per-habit CPU INSIDE the `withUser` callback, so a
   * 20-habit rebuild holds its connection for the whole ~29 ms, most of that
   * Node CPU rather than Postgres work.
   *
   * What this isolates is the POOL component alone, and that is the right
   * comparison: the event-loop queueing heavy rebuild load also causes is paid
   * identically by a memo hit with the read and without it, so it cancels out
   * of the difference this decision turns on.
   */
  const HOLD_MS = 29;

  /**
   * ...and whether raising `PG_POOL_MAX` is the answer to it.
   *
   * It is a DEFAULT and not a limit — `Number(process.env.PG_POOL_MAX) || 10`
   * — so "just raise it" is a real option and worth measuring rather than
   * arguing. Two things bound how far: `max x replicas` against Postgres's own
   * `max_connections` (100 by default, one backend process each), which
   * `poolGauge`'s `waiting` exists to make visible; and the fact that Node is
   * single-threaded while `buildOverview` holds its connection through the
   * per-habit CPU, so a bigger pool does not buy more rebuild throughput — it
   * moves the queue from the pool to the event loop.
   *
   * That second argument does NOT apply to the version read, which is ~0.4 ms
   * of socket wait and almost no CPU. So the prediction under test is that the
   * cliff sits at "concurrent holders >= pool size" and moves out with it,
   * which would make a modestly larger pool a complete answer to section 3.
   *
   * @param {number} max
   * @param {number[]} ks
   */
  async function contention(max, ks) {
    const p = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
    });
    /** Hold one pool connection for `HOLD_MS`, the way a rebuild does. */
    const holder = async () => {
      const c = await p.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT set_config($1, $2, true)',
          ['app.user_id', String(probe.id)]);
        await c.query(`SELECT pg_sleep($1)`, [HOLD_MS / 1000]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    };
    const read = async () => {
      const c = await p.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT set_config($1, $2, true)',
          ['app.user_id', String(probe.id)]);
        await c.query('SELECT data_version FROM users WHERE id = $1', [probe.id]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    };

    try {
      for (const k of ks) {
        let running = true;
        const load = Array.from({ length: k }, async () => {
          while (running) await holder().catch(() => {});
        });
        await idle(200); // let the holders actually take their connections
        const s = await sample(60, read);
        running = false;
        await Promise.all(load);
        row(`pool ${String(max).padStart(2)} · ${String(k).padStart(2)} concurrent holders`, s);
      }
    } finally {
      await p.end().catch(() => {});
    }
  }

  console.log(`\n3. The version read while ${HOLD_MS}ms transactions hold the SAME pool`);
  header();
  await contention(10, [0, 4, 9, 10, 20]);
  console.log('');
  await contention(20, [10, 19, 20, 40]);
  console.log('');
  await contention(40, [20, 39, 40]);

  /* ---------- 4. what one memo entry costs, in bytes ---------- */

  /**
   * `MAX_OVERVIEW_BYTES`, restated rather than imported — the same treatment
   * `POOL_MAX` above gets, and for the reason the root `CLAUDE.md` gives about
   * tests that import the constant they check. If the two ever disagree, the
   * "fits" column below is what says so.
   */
  const MAX_BYTES = 48 * 1024 * 1024;

  /**
   * Measured as `sizeOf` measures it — `json.length * 2`, UTF-16 code units
   * doubled — because that is the number `capBytes` sums and therefore the
   * only one `MAX_OVERVIEW_BYTES` is a bound on. It is a CEILING on what V8
   * retains, not an estimate of it: a Latin-1 string costs one byte per unit,
   * so the true residency of an ASCII payload is about half this. That is the
   * safe direction for a bound and the wrong direction for a boast, which is
   * why it is stated here rather than left for someone to rediscover.
   *
   * The archive's older 18 KB / 499 KB / 1.2 MB are a different quantity
   * entirely — the retained OBJECT, measured with `--expose-gc`, from before
   * the memo held the serialised payload. Roughly twice the string, because
   * 365 dated grid keys per habit cost far more as object properties than as
   * JSON text. Do not compare the two columns.
   */
  console.log('\n4. One memo entry, in the unit `sizeOf` returns');
  console.log(`  ${'shape'.padEnd(30)} ${'one entry'.padStart(12)} `
    + `${'fits in 48 MB'.padStart(14)}`);
  for (const [habits, days, label] of [
    [8, 30, '8 habits x 30 days (typical)'],
    [8, DAYS, `8 habits x ${DAYS} days`],
    [20, DAYS, `20 habits x ${DAYS} days`],
    [50, DAYS, `50 habits x ${DAYS} days`],
  ]) {
    const acct = shaped.find(([n]) => n === habits)?.[1];
    // The four rows name their shapes independently of `SHAPES`, so a change
    // there drops rows from here. SAY so rather than printing a shorter table:
    // `MAX_OVERVIEW_CACHED` is derived from the smallest row, and a table
    // missing it reads exactly like a complete one.
    if (!acct) {
      console.log(`  ${label.padEnd(30)} ${'not measured'.padStart(9)}    `
        + `(no ${habits}-habit account; SHAPES is [${SHAPES}])`);
      continue;
    }
    const bytes = (await acct.body(days)).length * 2;
    console.log(`  ${label.padEnd(30)} ${(bytes / 1024).toFixed(1).padStart(9)} KB `
      + `${String(Math.floor(MAX_BYTES / bytes)).padStart(14)}`);
  }
  console.log('\n  The SMALLEST entry is the one that decides MAX_OVERVIEW_CACHED:');
  console.log('  a big dashboard reaches 48 MB in a few dozen entries and any count');
  console.log('  at all is a backstop for it, while a typical one has to be able to');
  console.log('  fill 48 MB before the count evicts anything still fresh.');

  console.log('');
} finally {
  child.kill('SIGTERM');
  srv.close();
  await appPool.end().catch(() => {});
  await admin.end().catch(() => {});
}
