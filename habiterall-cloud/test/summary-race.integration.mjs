/**
 * The summary cache under a FORCED interleaving — the half `test:summarycache`
 * cannot reach.
 *
 * `summary-cache.integration.mjs` is the invalidation inventory: one case per
 * write path, stamp the row, make the request, require the stamp to be gone.
 * Every one of its cases is SEQUENTIAL, and that is why two concurrency defects
 * shipped underneath a green suite.
 *
 *  - The write-back's guard was the ACCOUNT's `data_version`, compared with a
 *    correlated subquery on `users`. Sequentially it holds perfectly, which is
 *    what that suite proved. Under a race it cannot hold at all: the subquery
 *    correlates only to the user id, so the planner hoists it into an InitPlan
 *    behind a One-Time Filter ABOVE the habits scan — one evaluation, cached in
 *    a PARAM_EXEC slot, and no per-row qual anywhere. When the statement blocks
 *    on a concurrent writer and resumes, Postgres re-checks the qual against
 *    the newly committed target tuple (EvalPlanQual); EPQ re-checks the TARGET
 *    relation's columns and cannot re-run an InitPlan. The write-back resumed
 *    and stamped pre-write figures as of TODAY. Measured consequence:
 *    `GET /overview` serving `totalCompleted=5` against a ground truth of 6, on
 *    every replica, until the calendar day rolled over.
 *  - The commoner interleaving needed no EPQ. The clear carried
 *    `AND summary_asof IS NOT NULL` as a WAL-saving predicate, so with the
 *    stamp already NULL — the state after every single write — it matched no
 *    row, wrote no row and took NO ROW LOCK. There was nothing for the
 *    write-back to block on, and nothing about the stamp to compare either: the
 *    reader read NULL and the clear left NULL.
 *  - And the clear itself introduced a lock-order INVERSION. Every mutating
 *    path reached `users` last through the `data_version` bump, except
 *    `PUT /settings`, whose own `fn` writes `users` and only then reached an
 *    account-wide clear on `habits`. Five pairs of ordinary write paths
 *    deadlocked; the victim surfaced as an unhandled 500 on a user's tap,
 *    because nothing in this edition handles `40P01`.
 *
 * **So the rule this file exists to keep is: a concurrency claim needs a forced
 * interleaving, and a forced interleaving needs PROOF that it happened.** Every
 * racing block below stalls one transaction at a chosen point with an
 * `pg_advisory_xact_lock` a third session holds. A harness that silently ran
 * sequentially would pass every assertion here and teach nothing — that is
 * precisely the shape of the suite these defects shipped under.
 *
 * **The proof mechanism is `lockProbe`, and it is not the obvious one.** The
 * first version of this file proved an interleaving by requiring the write-back
 * to be QUEUED behind the clear, read out of `pg_stat_activity`. That is no
 * longer available, because the write-back now declines to queue at all: it
 * takes its rows `FOR NO KEY UPDATE SKIP LOCKED`, so a habit somebody else is
 * writing is dropped from the statement instead of waited for. The lock
 * therefore has to be established independently — by asking, from a third
 * session, whether the row can be locked — and "the write-back did NOT block"
 * becomes an ASSERTION rather than the proof.
 *
 * Seven things only this file can see:
 *
 *  1. **R2 — the clear takes a row lock even when the stamp is ALREADY NULL,
 *     and the write-back skips rather than waits.** The row write is the direct
 *     pin on dropping `AND summary_asof IS NOT NULL`: without it there is no
 *     lock, `lockProbe` says so, and the stale pair goes back on the row. The
 *     write-back returning while the writer is still open is the pin on
 *     `SKIP LOCKED`.
 *  2. **The skip is PER ROW.** One `/overview` stamps every habit it recomputed
 *     in one statement, so all-or-nothing would mean a single tap costing the
 *     whole account its write-back on every concurrent load. Two habits, one
 *     held and one free, in one call: the free one is stamped and the held one
 *     is not.
 *  3. **The SEQUENTIAL control.** The guard refusing with no contention at all,
 *     which is the case the old `data_version` guard passed and the reason it
 *     shipped. It is here so that a guard which is simply deleted fails too.
 *  4. **The LEGITIMATE control.** A write-back with nothing racing it must
 *     stamp its row. Without this every assertion above is satisfied by a
 *     `writeBackSummaries` hardcoded to `return 0` — a cache that never fills,
 *     so every load recomputes and the whole feature does nothing.
 *  5. **The lock ORDER, asserted positively.** `PUT /settings` stalled with its
 *     transaction open, a tap driven concurrently, and the tap's queue position
 *     read out of the catalog: it must be waiting at the `habits` clear holding
 *     NO lock on `entries`, because the clear now runs before `fn`. Under the
 *     old ordering it waits at the `users` bump with its entry row already
 *     written — and the two transactions deadlock. "No deadlock" alone is a
 *     weak assertion (a scheduler can be lucky); the lock the blocked
 *     transaction HOLDS is not.
 *  6. **The user-visible consequence, over the real route.** Everything above
 *     is row counts and lock modes. This is `GET /overview` answering with the
 *     TRUE completion count after the race, and answering it WITHOUT waiting
 *     for the tap — which is the only thing anyone loses either way.
 *  7. **A skipped stamp is RECOVERED.** `SKIP LOCKED` trades a wait for a miss,
 *     and the whole trade rests on the miss being temporary. Contend the row,
 *     watch the stamp not appear, release, load again through the real route,
 *     and require the stamp and the true figure. If this were false the cache
 *     would decay under write pressure and never refill, which is a worse
 *     defect than the deadlock it replaced.
 *
 * Runs against a database the cloud migrations have been applied to, and boots
 * a real server for blocks 5, 6 and 7.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/summary-race.integration.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';

import { addDays } from '@habiterall/shared/stats.js';

process.env.ADMIN_URL ??= 'postgres://owner:testpw@localhost:5432/habiterall';
process.env.DATABASE_URL ??= 'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

const SECRET = 'summary-race-integration-secret';
const SID = 'summaryraceintegrationsid001';
const SUBJECT = 'ci-summary-race';
const ZONE = 'UTC';

/**
 * The advisory key every stall in this file uses.
 *
 * Advisory locks are the stall mechanism rather than a sleep because a sleep is
 * a guess in both directions: too short and the interleaving never forms, too
 * long and the suite is slow and still not deterministic. A third session holds
 * this key for the whole run of a block, so a transaction that asks for it
 * stops exactly where it asked and stays there until this file says otherwise.
 * Transaction-scoped (`_xact_`), so a crashed block cannot leave it held.
 */
const STALL_KEY = 918301101;

/**
 * What the out-of-band fixtures stamp, and none of it is a default.
 *
 * A fixture holding the value the code under test would produce anyway is the
 * one that passes with the code deleted, so the stale stamp is a date nothing
 * would ever compute and the figures are deliberately not zero and deliberately
 * not the truth.
 */
const STALE_STAMP = '2001-02-03';
const PLANTED_BEST = 41;
const PLANTED_TOTAL = 17;

// Imported after `process.env` is set and before anything reads a bigint — the
// ordering `data-version.integration.mjs` explains: `db/pool.js` installs
// parsers on the shared `pg` module, and this file reads its dates and its
// counters as text.
const { withUser, withUserWrite, pool } = await import('../src/db/pool.js');
const { writeBackSummaries } = await import('../src/api.js');

const admin = new pg.Client({ connectionString: process.env.ADMIN_URL });
/** A second admin session, so a watch query never queues behind a fixture. */
const watch = new pg.Client({ connectionString: process.env.ADMIN_URL });
/** The session that holds `STALL_KEY`. Nothing else runs on it. */
const holder = new pg.Client({ connectionString: process.env.ADMIN_URL });
/** Asks whether a row is locked, without joining any queue. See `lockProbe`. */
const probe = new pg.Client({ connectionString: process.env.ADMIN_URL });

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
      // Blocks 5 and 6 drive several requests per second on one account, which
      // the read limiter would answer with a 429 — and a 429 is not a lock
      // order.
      HABITERALL_RATE_LIMIT: 'off',
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

/**
 * Wait until a backend is genuinely queued on a lock, and THROW naming what was
 * wanted if it never is.
 *
 * This is the whole difference between this file and a hopeful one. `waitedMs`
 * is reported so a reader can see the interleaving was observed rather than
 * assumed, and the ungranted `pg_locks` rows and the blocked statement come
 * back with it so a caller can assert WHERE the queue formed.
 *
 * A row-lock wait shows in `pg_locks` as an ungranted `transactionid ShareLock`
 * and so names no relation. That is why `held` is returned too: the relations a
 * blocked transaction ALREADY holds are what say which statement it got to, and
 * they come from the catalog rather than from a string.
 *
 * @param {string} what named in the throw
 * @param {{pid?: number, like?: string, by?: number}} opts `by` requires a
 *   specific blocker, which is what stops this reporting an unrelated wait
 */
async function requireBlocked(what, { pid, like, by } = {}) {
  for (let i = 0; i < 400; i++) {
    const { rows } = await watch.query(
      `SELECT pid, wait_event_type, wait_event, state,
              pg_blocking_pids(pid) AS blockers,
              left(regexp_replace(query, '\\s+', ' ', 'g'), 100) AS q
         FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND ($1::int IS NULL OR pid = $1)
          AND ($2::text IS NULL OR query LIKE $2)`,
      [pid ?? null, like ?? null]);
    const hit = rows.find((r) => by == null || (r.blockers ?? []).includes(by));
    if (hit) {
      const { rows: ungranted } = await watch.query(
        `SELECT locktype, mode, relation::regclass::text AS rel
           FROM pg_locks WHERE pid = $1 AND NOT granted`, [hit.pid]);
      const { rows: held } = await watch.query(
        `SELECT DISTINCT relation::regclass::text AS rel, mode
           FROM pg_locks
          WHERE pid = $1 AND granted AND locktype = 'relation'
            AND relation::regclass::text IN ('habits', 'users', 'entries')`,
        [hit.pid]);
      return { ...hit, ungranted, held, waitedMs: i * 25 };
    }
    await idle(25);
  }
  throw new Error(
    `${what}: no backend was ever observed queued on a lock after 10s `
    + `(pid=${pid ?? 'any'} like=${like ?? 'any'} by=${by ?? 'any'}). `
    + 'The interleaving this block asserts about did not form, so its '
    + 'assertions would have been vacuous.');
}

/**
 * Is this habit row currently row-locked by somebody else?
 *
 * A row lock does not appear in `pg_locks` — a waiter shows up as an ungranted
 * `transactionid ShareLock`, which names no relation and only exists once
 * something is already queued. Since the whole point of the write-back is that
 * it never queues, "the write-back blocked" is no longer available as the proof
 * that a lock existed, and something else has to establish it.
 *
 * `FOR NO KEY UPDATE SKIP LOCKED` answers exactly that question and answers it
 * instantly: zero rows back means the row was held. It is also
 * non-perturbing in the case that matters — when the row IS locked it skips,
 * so it takes no lock of its own and cannot be the reason a later write-back
 * skips. The transaction is rolled back either way, for the case where the row
 * was free and this did lock it.
 */
const lockProbe = async (probe, id) => {
  await probe.query('BEGIN');
  try {
    const { rows } = await probe.query(
      `SELECT id FROM habits WHERE id = $1 FOR NO KEY UPDATE SKIP LOCKED`, [id]);
    return rows.length === 0;
  } finally {
    await probe.query('ROLLBACK').catch(() => {});
  }
};

/** Nothing at all is waiting on a lock — the other half of the proof. */
async function requireNotBlocked(what, { like }) {
  await idle(400);
  const { rows } = await watch.query(
    `SELECT pid, left(regexp_replace(query, '\\s+', ' ', 'g'), 100) AS q
       FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
        AND query LIKE $1`, [like]);
  if (rows.length) {
    throw new Error(`${what}: expected nothing queued, found ${JSON.stringify(rows)}`);
  }
}

/** Today in a named zone, as the app spells a date. */
const dayIn = (zone) => new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const { srv, base: issuer } = await fakeIssuer();
const port = 3730 + (process.pid % 130);
const { child, base } = await boot(issuer, port);

/** @type {Array<() => Promise<any>>} */
const cleanups = [];

try {
  await admin.connect();
  await watch.connect();
  await holder.connect();
  await probe.connect();

  const today = dayIn(ZONE);

  await admin.query(`DELETE FROM users WHERE idp_subject = $1`, [SUBJECT]);
  const { rows: [row] } = await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, email, display_name, device_time_zone)
     VALUES ($1, 'https://ci.example', 'race@example.com', 'race', $2)
     RETURNING id`,
    [SUBJECT, ZONE]
  );
  const user = Number(row.id);
  await admin.query(
    `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, $3)
     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
    [SID, JSON.stringify({
      cookie: { originalMaxAge: 6048e5, httpOnly: true, path: '/', sameSite: 'lax' },
      user: { id: user, email: 'race@example.com', name: 'race', blocked: false },
    }), new Date(Date.now() + 7 * 864e5)]
  );
  const cookie = `habiterall.sid=${signed(SID, SECRET)}`;

  /** @param {string} path @param {{method?: string, body?: any}} [o] */
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        cookie,
        'X-Habiterall-Timezone': ZONE,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = res.status === 204 ? '' : await res.text();
    let json = null;
    try { json = text === '' ? null : JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: json };
  };

  /**
   * The habit row as `buildOverview` reads it, by the OWNER.
   *
   * `::text` on both the stamp and the counter rather than trusting a type
   * parser: `db/pool.js` is loaded in this process and installs parsers on the
   * shared `pg` module, and what these arrive as here must not depend on import
   * order.
   */
  const rowOf = async (id) => {
    const { rows } = await admin.query(
      `SELECT best_streak, total_completed, summary_asof::text AS summary_asof,
              summary_epoch::text AS summary_epoch
         FROM habits WHERE id = $1`, [id]);
    return { ...rows[0], summary_epoch: Number(rows[0].summary_epoch) };
  };

  /**
   * A habit with `n` completed days behind it, primed through the real route.
   *
   * Priming is a real `GET /overview`, so what every block below races against
   * is a cache the APPLICATION wrote — the distinction
   * `summary-cache.integration.mjs` learned the hard way. The `days` query
   * varies per call because `overviewMemo`'s key carries the window, and a memo
   * hit is a request that never reaches Postgres and so never fills anything.
   */
  let windowNudge = 0;
  const prime = async () => {
    const res = await call(`/overview?days=${30 + (windowNudge++ % 40)}`);
    if (res.status !== 200) throw new Error(`prime: /overview -> ${res.status}`);
    return res.body;
  };

  const makeHabit = async (name, completedDays) => {
    const made = await call('/habits', {
      method: 'POST',
      body: { name, type: 'boolean', freq_numerator: 1, freq_denominator: 1 },
    });
    if (made.status !== 201) throw new Error(`POST /habits -> ${made.status}`);
    const id = made.body.id;
    for (let d = 1; d <= completedDays; d++) {
      const res = await call(`/habits/${id}/entries/${addDays(today, -d)}`,
        { method: 'PUT', body: { value: 2 } });
      if (res.status !== 200) throw new Error(`tap -> ${res.status}`);
    }
    await prime();
    const primed = await rowOf(id);
    if (primed.summary_asof !== today) {
      throw new Error(`fixture ${name} was not primed through the route: `
        + `${JSON.stringify(primed)} — there is no cache here to race against`);
    }
    return id;
  };

  /**
   * Hold `STALL_KEY`, run `fn` as a real write, and hand back a release.
   *
   * `fn` is handed the transaction's client and is expected to ask for
   * `STALL_KEY` at the point it wants to stop. Everything before that point has
   * already run and its locks are already held, which is what makes the
   * interleaving a fact rather than a hope.
   */
  const stalledWrite = async (fn, opts) => {
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock($1)`, [STALL_KEY]);
    let pid = 0;
    const promise = withUserWrite(user, async (db) => {
      pid = Number((await db.query('SELECT pg_backend_pid() AS p')).rows[0].p);
      return fn(db);
    }, opts);
    promise.catch(() => { /* awaited by the caller */ });
    // Proof that the stall formed where it was asked for, and that everything
    // before it has run.
    const ev = await requireBlocked('the stalled writer', { like: '%pg_advisory_xact_lock%' });
    const release = async () => {
      await holder.query('COMMIT');
      return promise;
    };
    cleanups.push(async () => { await holder.query('ROLLBACK').catch(() => {}); });
    return { promise, release, pid: pid || ev.pid, ev };
  };

  /* ============ 1. R2: the clear locks the row even with a NULL stamp ======= */
  //
  // The state after EVERY write is `summary_asof IS NULL`, so this is not an
  // edge case — it is the common one. The clear used to carry
  // `AND summary_asof IS NOT NULL`, which made it write no row and take no row
  // lock in exactly this state; the write-back therefore never queued behind
  // it, and there was nothing about the stamp to compare either, since the
  // reader read NULL and the clear left NULL. The epoch is what makes this
  // state distinguishable, and it can only do that if the row is written.
  //
  // Asserted as a BLOCK. A clear that writes no row cannot be blocked on, and
  // this block's own proof helper throws by name when nothing queues.

  console.log('\n--- 1. R2: the clear takes a row lock even when the stamp is already NULL ---');

  const h2 = await makeHabit('race r2', 5);
  // The post-write state, planted out of band: stamp gone, figures left behind
  // it, epoch untouched. This is what a reader finds and recomputes from.
  await admin.query(
    `UPDATE habits SET summary_asof = NULL, best_streak = $2, total_completed = $3
      WHERE id = $1`, [h2, PLANTED_BEST, PLANTED_TOTAL]);
  const read2 = await rowOf(h2);
  ck('control: the reader\'s row really has a NULL stamp and a real epoch',
    read2.summary_asof === null && read2.summary_epoch > 0, JSON.stringify(read2));

  const w2 = await stalledWrite(
    (db) => db.query(`SELECT pg_advisory_xact_lock($1)`, [STALL_KEY]),
    { habits: [h2] });

  // THE PROOF, and it can no longer be "the write-back blocked": `SKIP LOCKED`
  // is what stops it queueing, so the lock has to be established independently
  // or every assertion below is about an interleaving that never formed.
  ck('THE PROOF: the clear holds a row lock on the habit even though the stamp '
    + 'was already NULL — so the clear really did write the row',
    await lockProbe(probe, h2), `habit=${h2}`);

  // The write-back, on its own connection, at the epoch the reader saw.
  const back2Promise = withUser(user, (db) =>
    writeBackSummaries(db, user, today,
      [{ id: h2, best_streak: 99, total_completed: 88,
         summary_epoch: read2.summary_epoch }]));
  // ...and it must come back WHILE the writer is still open. Under the previous
  // design this queued behind the clear; the whole point of `SKIP LOCKED` is
  // that the discardable party declines to wait, so this now resolves without
  // the writer having committed anything.
  await requireNotBlocked('the write-back over a locked row',
    { like: '%summary_asof = $2%' });
  const back2 = await back2Promise;
  const during2 = await rowOf(h2);
  ck('THE ASSERTION: it does not queue behind the clear — it returns while the '
    + 'writer is STILL OPEN', true, `rows=${back2}`);
  ck('...stamping nothing, because the row it wanted was skipped', back2 === 0,
    `rows=${back2}`);
  ck('...and leaving the row exactly as it found it — a skip is not a partial '
    + 'write', during2.summary_asof === null
      && during2.best_streak === PLANTED_BEST
      && during2.total_completed === PLANTED_TOTAL,
    JSON.stringify(during2));

  await w2.release();
  const after2 = await rowOf(h2);
  ck('...and the writer\'s own clear still committed, epoch advanced',
    after2.summary_asof === null && after2.summary_epoch === read2.summary_epoch + 1,
    JSON.stringify(after2));

  /* ============ 2. the skip is PER ROW, not per statement ================= */
  //
  // One `/overview` stamps every habit it recomputed in ONE statement, so the
  // question `SKIP LOCKED` raises is what happens to the rest when one row is
  // contended. All-or-nothing would be a real cost: a single tap on a single
  // habit would cost the whole account its write-back on every concurrent load,
  // and under sustained writing the cache would never fill.
  //
  // Two habits, one held by a concurrent narrowed clear and one free, in one
  // call: the free one must be stamped and the held one skipped. This is also
  // the case that fails if the CTE is written to lock the whole account rather
  // than the ids handed in.

  console.log('\n--- 2. the skip is per ROW: one contended habit, one free ---');

  const h1 = await makeHabit('race batch held', 5);
  const h1b = await makeHabit('race batch free', 3);
  await admin.query(
    `UPDATE habits SET summary_asof = $2, best_streak = $3, total_completed = $4
      WHERE id = ANY($1)`, [[h1, h1b], STALE_STAMP, PLANTED_BEST, PLANTED_TOTAL]);
  const read1 = await rowOf(h1);
  const read1b = await rowOf(h1b);
  ck('control: both rows carry a stale stamp the clear will match',
    read1.summary_asof === STALE_STAMP && read1b.summary_asof === STALE_STAMP,
    `${JSON.stringify(read1)} ${JSON.stringify(read1b)}`);

  // Narrowed to h1 alone, so h1b is genuinely uncontended.
  const w1 = await stalledWrite(
    (db) => db.query(`SELECT pg_advisory_xact_lock($1)`, [STALL_KEY]),
    { habits: [h1] });

  ck('THE PROOF: h1 is row-locked and h1b is not',
    (await lockProbe(probe, h1)) && !(await lockProbe(probe, h1b)),
    `h1=${h1} h1b=${h1b}`);

  const back1Promise = withUser(user, (db) =>
    writeBackSummaries(db, user, today, [
      { id: h1, best_streak: 99, total_completed: 88,
        summary_epoch: read1.summary_epoch },
      { id: h1b, best_streak: 77, total_completed: 66,
        summary_epoch: read1b.summary_epoch },
    ]));
  await requireNotBlocked('the two-habit write-back',
    { like: '%summary_asof = $2%' });
  const back1 = await back1Promise;
  const held1 = await rowOf(h1);
  const free1 = await rowOf(h1b);
  ck('THE ASSERTION: exactly one row is stamped — the uncontended one',
    back1 === 1, `rows=${back1}`);
  ck('...the free habit got its pair',
    free1.summary_asof === today && free1.best_streak === 77
      && free1.total_completed === 66, JSON.stringify(free1));
  ck('...and the held habit was left alone, not half-written',
    held1.summary_asof === STALE_STAMP && held1.best_streak === PLANTED_BEST
      && held1.total_completed === PLANTED_TOTAL, JSON.stringify(held1));

  await w1.release();

  /* ============ 3. the SEQUENTIAL control ================================= */
  //
  // The same refusal with no contention at all: the writer commits in full
  // BEFORE the write-back is issued, so the statement's own snapshot sees the
  // advanced epoch and no EPQ is involved. This is the case the guard that
  // shipped DID pass, and it is here so that a guard which is simply deleted
  // fails somewhere too. It also proves the harness above is doing something:
  // this block must NOT block, and the two racing blocks must.

  console.log('\n--- 3. control: sequential, no contention, still refused ---');

  const h3 = await makeHabit('race sequential', 5);
  await admin.query(
    `UPDATE habits SET summary_asof = NULL, best_streak = $2, total_completed = $3
      WHERE id = $1`, [h3, PLANTED_BEST, PLANTED_TOTAL]);
  const read3 = await rowOf(h3);

  await withUserWrite(user, (db) => db.query(
    `INSERT INTO entries (habit_id, user_id, date, value, status, notes)
     VALUES ($1, $2, $3, 2, '', '')
     ON CONFLICT (habit_id, date) DO UPDATE SET value = EXCLUDED.value`,
    [h3, user, addDays(today, -9)]), { habits: [h3] });

  const seqBackPromise = withUser(user, (db) =>
    writeBackSummaries(db, user, today,
      [{ id: h3, best_streak: 99, total_completed: 88,
         summary_epoch: read3.summary_epoch }]));
  await requireNotBlocked('the sequential control', { like: '%summary_asof = $2%' });
  const seqBack = await seqBackPromise;
  const after3 = await rowOf(h3);
  ck('a write-back at an epoch a COMMITTED write has moved past stamps nothing',
    seqBack === 0, `rows=${seqBack}`);
  ck('...and the row is left as the clear left it',
    after3.summary_asof === null && after3.summary_epoch === read3.summary_epoch + 1,
    JSON.stringify(after3));

  /* ============ 4. the LEGITIMATE control ================================= */
  //
  // Without this, everything above is satisfied by a write-back that never
  // writes — a cache that never fills, every load recomputing, and the three
  // columns doing nothing at all. Both a permanent refusal and a working guard
  // produce a CORRECT figure; only this case tells them apart.

  console.log('\n--- 4. control: an unraced write-back is still permitted ---');

  const h4 = await makeHabit('race legitimate', 5);
  await admin.query(
    `UPDATE habits SET summary_asof = NULL, best_streak = $2, total_completed = $3
      WHERE id = $1`, [h4, PLANTED_BEST, PLANTED_TOTAL]);
  const read4 = await rowOf(h4);
  const okBack = await withUser(user, (db) =>
    writeBackSummaries(db, user, today,
      [{ id: h4, best_streak: 99, total_completed: 88,
         summary_epoch: read4.summary_epoch }]));
  const after4 = await rowOf(h4);
  ck('THE ASSERTION: a write-back at the LIVE epoch stamps its row',
    okBack === 1 && after4.summary_asof === today
      && after4.best_streak === 99 && after4.total_completed === 88,
    `rows=${okBack} ${JSON.stringify(after4)}`);
  ck('...and does not advance the epoch, because a write-back is not a write',
    after4.summary_epoch === read4.summary_epoch, JSON.stringify(after4));

  /* ============ 5. the lock ORDER, settings x tap ========================= */
  //
  // `PUT /settings` is the one write path whose own `fn` touches `users`, and
  // its clear is deliberately account-wide (an `atMostUnlogged` change moves
  // every at-most habit's `bestStreak`, so narrowing it would be silent and
  // long-lived). With the clear issued AFTER `fn` that made it
  // `users -> habits` against every other path's `habits -> users`, and the two
  // deadlocked with the tap as the victim — an unhandled 500, since nothing in
  // this edition handles `40P01`.
  //
  // The assertion is not merely "no deadlock": a scheduler can be lucky. It is
  // WHERE the tap queues, read out of `pg_locks`. With the clear first the tap
  // is waiting at its own clear on `habits` and holds NO lock on `entries`,
  // because it has not reached its entry write yet. With the clear last it is
  // waiting at the `users` bump with the entry row already inserted — so the
  // `entries` lock is the discriminator, and it comes from the catalog rather
  // than from a string.

  console.log('\n--- 5. one lock order: PUT /settings stalled, a tap driven into it ---');

  const h5 = await makeHabit('race lockorder', 4);

  // The settings shape, through the REAL `withUserWrite` so the ordering under
  // test is the code's and not this file's. `fn` writes `users` and THEN asks
  // for the stall, which is the point at which the old ordering had `users`
  // held and `habits` still to come.
  const w5 = await stalledWrite(async (db) => {
    await db.query(
      `UPDATE users SET settings = settings || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ atMostUnlogged: 'success' }), user]);
    return db.query(`SELECT pg_advisory_xact_lock($1)`, [STALL_KEY]);
  });

  const tapPromise = call(`/habits/${h5}/entries/${addDays(today, -7)}`,
    { method: 'PUT', body: { value: 2 } });

  const ev5 = await requireBlocked('the tap, queued behind the settings write',
    { by: w5.pid });
  const heldRels = (ev5.held ?? []).map((r) => r.rel);
  ck('THE PROOF: the tap is queued behind the settings write',
    (ev5.blockers ?? []).includes(w5.pid),
    `waited=${ev5.waitedMs}ms at: ${ev5.q}`);
  ck('THE ASSERTION: it is queued at the `habits` clear, not at the `users` '
    + 'bump — it holds no lock on `entries` because it has not written one yet',
    !heldRels.includes('entries'),
    `held=${JSON.stringify(ev5.held)} at: ${ev5.q}`);
  ck('...and the statement it is waiting on is the clear',
    /UPDATE habits SET summary_asof/.test(ev5.q ?? ''), ev5.q);

  await w5.release();
  const tapRes = await tapPromise;
  ck('THE ASSERTION: neither transaction is a deadlock victim — the tap answers '
    + '200, not the unhandled 500 a 40P01 becomes',
    tapRes.status === 200, `${tapRes.status} ${JSON.stringify(tapRes.body)}`);
  const settingsRow = await admin.query(
    `SELECT settings ->> 'atMostUnlogged' AS u FROM users WHERE id = $1`, [user]);
  ck('...and both writes are actually there',
    settingsRow.rows[0].u === 'success', JSON.stringify(settingsRow.rows[0]));
  // Put it back: an account-level `atMostUnlogged` is exactly the setting the
  // next block's figures depend on.
  await admin.query(`UPDATE users SET settings = settings - 'atMostUnlogged' WHERE id = $1`,
    [user]);

  /* ============ 6. what the user actually loses =========================== */
  //
  // Row counts and lock modes are the mechanism. This is the consequence: a
  // dashboard reporting a figure from before the tap, on every replica, until
  // the calendar day rolls over. Driven over the real route, against the real
  // `entries` table, and compared with ground truth counted in SQL — the
  // measurement that read `totalCompleted=5` against a truth of 6.

  console.log('\n--- 6. the dashboard serves the TRUE figure after the race ---');

  const h6 = await makeHabit('race served', 5);
  const before6 = await rowOf(h6);
  ck('control: the fixture is primed and the cached total is the pre-write one',
    before6.summary_asof === today && before6.total_completed === 5,
    JSON.stringify(before6));

  // **The stamp has to be gone BEFORE the racing writer starts, and that is not
  // a shortcut — it is the shape of the hazard.** An uncommitted writer's clear
  // is invisible, so a `/overview` that begins after a live stamp is served the
  // cached pair and issues no write-back at all: correct, and nothing to race.
  // The dangerous order is the reader finding the habit STALE first, deriving
  // its answer, and only then having a write commit underneath it — and "stale"
  // is the state every account is left in by its own last write. So this is
  // that state, committed, exactly as a previous write would have left it.
  await admin.query(`UPDATE habits SET summary_asof = NULL WHERE id = $1`, [h6]);

  // The tap the dashboard must not paint away, stalled with its transaction
  // open so that a `/overview` runs entirely inside it.
  const newDay = addDays(today, -11);
  const w6 = await stalledWrite(async (db) => {
    await db.query(
      `INSERT INTO entries (habit_id, user_id, date, value, status, notes)
       VALUES ($1, $2, $3, 2, '', '')
       ON CONFLICT (habit_id, date) DO UPDATE SET value = EXCLUDED.value`,
      [h6, user, newDay]);
    return db.query(`SELECT pg_advisory_xact_lock($1)`, [STALL_KEY]);
  }, { habits: [h6] });

  // The clear has already run, so this load finds the habit stale, recomputes
  // it from data the uncommitted tap is not in, and tries to stamp it.
  ck('THE PROOF: the tap holds the habit row while the dashboard loads',
    await lockProbe(probe, h6), `habit=${h6}`);
  const overviewPromise = prime();
  // The load must COMPLETE while the tap is still open. It used to queue behind
  // the tap's clear; now it skips the row and answers. A dashboard that waits
  // on somebody's tap is the other half of what `SKIP LOCKED` is buying.
  await requireNotBlocked('the /overview write-back',
    { like: '%summary_asof = $2%' });
  const servedDuring = await overviewPromise;
  ck('...and the dashboard answered without waiting for the tap',
    Boolean(servedDuring.habits.find((h) => h.id === h6)),
    `habits=${servedDuring.habits.length}`);

  await w6.release();

  const truth = Number((await admin.query(
    `SELECT count(*)::text AS n FROM entries WHERE habit_id = $1 AND value > 0`,
    [h6])).rows[0].n);
  const after6 = await rowOf(h6);
  const served = (await prime()).habits.find((h) => h.id === h6);
  ck('THE ASSERTION: `/overview` serves the true completion count after the race',
    served.totalCompleted === truth,
    `served=${served.totalCompleted} truth=${truth} row=${JSON.stringify(after6)}`);
  ck('...and no pre-write figure was left stamped as of today',
    !(after6.summary_asof === today && after6.total_completed !== truth),
    JSON.stringify(after6));

  /* ============ 7. a skipped stamp is RECOVERED, not lost ================= */
  //
  // `SKIP LOCKED` trades a wait for a miss, and the whole trade rests on the
  // miss being temporary: a skipped row is simply left unstamped, so the next
  // load that finds no contention recomputes it and stamps it. If that were not
  // true the cache would decay under write pressure and never refill, which
  // would be a worse defect than the deadlock this replaced.
  //
  // Proven rather than reasoned: contend the row, watch the stamp not appear,
  // release, load again through the REAL route, and require the stamp AND the
  // correct figures. The second load is what the argument depends on and it is
  // the half that no amount of reading the first one can establish.

  console.log('\n--- 7. a skipped stamp is recovered by the next quiet load ---');

  const h7 = await makeHabit('race recovered', 4);
  await admin.query(`UPDATE habits SET summary_asof = NULL WHERE id = $1`, [h7]);

  const w7 = await stalledWrite(
    (db) => db.query(`SELECT pg_advisory_xact_lock($1)`, [STALL_KEY]),
    { habits: [h7] });
  ck('control: the row is held while the contended load runs',
    await lockProbe(probe, h7), `habit=${h7}`);
  await prime();
  const skipped7 = await rowOf(h7);
  ck('the contended load leaves the row UNSTAMPED', skipped7.summary_asof === null,
    JSON.stringify(skipped7));

  await w7.release();
  ck('control: the row is free again once the writer committed',
    !(await lockProbe(probe, h7)), `habit=${h7}`);

  const truth7 = Number((await admin.query(
    `SELECT count(*)::text AS n FROM entries WHERE habit_id = $1 AND value > 0`,
    [h7])).rows[0].n);
  const served7 = (await prime()).habits.find((h) => h.id === h7);
  const after7 = await rowOf(h7);
  ck('THE ASSERTION: the next uncontended load stamps it, with the true figure',
    after7.summary_asof === today && after7.total_completed === truth7,
    `${JSON.stringify(after7)} truth=${truth7}`);
  ck('...and the payload agrees with the row it just stored',
    served7.totalCompleted === truth7,
    `served=${served7.totalCompleted} truth=${truth7}`);

  /* ---------- clean up after ourselves ---------- */
  await admin.query(`DELETE FROM users WHERE id = $1`, [user]);
} finally {
  for (const c of cleanups) await c().catch(() => {});
  child.kill('SIGKILL');
  srv.close();
  await probe.end().catch(() => {});
  await holder.end().catch(() => {});
  await watch.end().catch(() => {});
  await admin.end().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(fails === 0
  ? '\nALL SUMMARY-RACE CHECKS PASSED'
  : `\n${fails} SUMMARY-RACE CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
