/**
 * How the two Postgres timeouts read their environment, and how a checkout
 * that cannot be had is named.
 *
 * A unit test rather than a line in `api.integration.mjs`, because the value
 * that matters most is the one no running pool can demonstrate: `0`. Postgres
 * spells "no timeout" as 0, and the module has to be imported afresh for each
 * setting, which is what the `?v=` cache-buster below is for.
 *
 * **None of this needs a database, and the last test needs there to be no
 * database**, which is the same fact from the other side. `new Pool` is lazy,
 * so the timeout tests open nothing; the checkout test points `DATABASE_URL` at
 * a port with nothing behind it and asserts the failure is named rather than
 * anonymous. Both run under `npm test` with no Postgres anywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??=
  'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

/**
 * Import `pool.js` with `env` applied, as if the process had started with it.
 *
 * ESM caches by specifier, so the query string is what makes a second import a
 * second evaluation. The variable is restored afterwards; a leak here would
 * silently decide the next test.
 */
let stamp = 0;
async function poolWith(env) {
  const before = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try {
    const mod = await import(`../src/db/pool.js?v=${++stamp}`);
    return mod.poolTimeouts();
  } finally {
    for (const k of Object.keys(env)) {
      if (k in before) process.env[k] = before[k]; else delete process.env[k];
    }
  }
}

/**
 * Run `fn` with the default logger's sink captured — and FORWARDED.
 *
 * `shared/src/log.js` takes an injectable `write`, but the `log` that
 * `db/pool.js` imports is the shared DEFAULT one, so its sink is
 * `process.stdout` and standing in front of it is the only way to read what a
 * module logged without changing the module to be readable.
 *
 * **Forwarded rather than swallowed, and that is not tidiness.** `node --test`
 * runs a single file in process and its reporter is a stream piped to stdout,
 * so results for tests that have ALREADY finished can be flushed on a later
 * tick — inside this window. Measured while writing the checkout test below: a
 * version of this helper that dropped what it captured made the four tests
 * above it disappear from the run entirely, reported as `# tests 1` with no
 * error anywhere. A stub that can delete another test's RESULT can delete its
 * FAILURE, which is this file quietly becoming one that cannot fail.
 *
 * Only the logger's own records are returned — a line is one if it parses as
 * JSON carrying a string `msg`, which is `log.js`'s shape and nothing the
 * reporter emits. So an assertion over `text` cannot accidentally be satisfied
 * by a test NAME that happened to contain the string it was looking for.
 *
 * @param {() => Promise<any>} fn
 */
async function logged(fn) {
  const raw = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    raw.push(String(chunk));
    return write(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  // Per CHUNK, never `raw.join('')`. Each `log` call is one `write` of one
  // complete line, but the reporter's writes do not always end in a newline —
  // so joining first glues a reporter chunk onto the FRONT of the next record
  // and that record stops parsing. Measured: it silently dropped the first of
  // the three below, and the test then read as "one call site does not log".
  const records = raw.flatMap((chunk) => chunk.split('\n')).flatMap((line) => {
    try {
      const r = JSON.parse(line);
      return r && typeof r.msg === 'string' ? [r] : [];
    } catch { return []; }
  });
  return { records, text: records.map((r) => JSON.stringify(r)).join('\n') };
}

// The prototype-key half of `noteTimeout` is in `api.integration.mjs`, not
// here: `withoutUser` takes its connection BEFORE its `try`, so with no
// database reachable it rejects with an AggregateError long before the lookup
// under test is ever reached — and a test that green-lights that is a test of
// nothing.

test('the defaults are 15s and 30s', async () => {
  // The literals. Importing the constants would compare each with itself and
  // pass with both parameters dropped from the Pool entirely.
  const t = await poolWith({
    PG_STATEMENT_TIMEOUT_MS: undefined, PG_IDLE_TX_TIMEOUT_MS: undefined,
  });
  assert.equal(t.pg_statement_timeout_ms, 15_000);
  assert.equal(t.pg_idle_tx_timeout_ms, 30_000);
});

test('an operator can set the timeouts', async () => {
  const t = await poolWith({
    PG_STATEMENT_TIMEOUT_MS: '60000', PG_IDLE_TX_TIMEOUT_MS: '90000',
  });
  assert.equal(t.pg_statement_timeout_ms, 60_000);
  assert.equal(t.pg_idle_tx_timeout_ms, 90_000);
});

test('0 means no timeout, which is the one value `||` swallows', async () => {
  // `Number(env) || 15_000` is the idiom at `PG_POOL_MAX` next door and it is
  // wrong here, because 0 is a value POSTGRES HAS A MEANING FOR: it disables
  // the timeout. Through `||` it silently becomes the default — so the single
  // setting the README tells an operator to reach for, when an export of a very
  // long history is being cancelled, is the one setting they cannot make.
  //
  // `PG_POOL_MAX=0` has no such meaning, which is why the idiom is fine there
  // and only there.
  const t = await poolWith({
    PG_STATEMENT_TIMEOUT_MS: '0', PG_IDLE_TX_TIMEOUT_MS: '0',
  });
  assert.equal(t.pg_statement_timeout_ms, 0, 'PG_STATEMENT_TIMEOUT_MS=0 must disable it');
  assert.equal(t.pg_idle_tx_timeout_ms, 0, 'PG_IDLE_TX_TIMEOUT_MS=0 must disable it');
});

test('a typo falls back to the default rather than removing the bound', async () => {
  // The direction matters: an unparseable value must not be read as "off". A
  // compose file with `PG_STATEMENT_TIMEOUT_MS: 15s` is the realistic way to
  // get here, and silently unbounding every query is the wrong way to answer it.
  let t;
  const { text: warned } = await logged(async () => {
    t = await poolWith({ PG_STATEMENT_TIMEOUT_MS: '15s', PG_IDLE_TX_TIMEOUT_MS: '-1' });
  });

  assert.equal(t.pg_statement_timeout_ms, 15_000);
  assert.equal(t.pg_idle_tx_timeout_ms, 30_000);

  // ...and it SAYS so. Falling back silently is how a typo survives to
  // production looking like a deliberate setting.
  assert.match(warned, /pg\.timeout_env_ignored/);
  // The logger redacts `name` and `value` as PII, so the fields are called
  // something else — a warning that names neither the setting nor what was
  // written in it is a warning about nothing.
  assert.match(warned, /PG_STATEMENT_TIMEOUT_MS/, 'the warning must name the setting');
  assert.match(warned, /15s/, 'the warning must quote what was actually written');
  assert.doesNotMatch(warned, /redacted/, 'redaction here would empty the warning');
});

/* ---------- the failure that had no name ---------- */

/**
 * A `DATABASE_URL` with nothing behind it.
 *
 * Port 1 rather than a high one nothing happens to be using: it is refused
 * immediately and deterministically, so this test measures a connection that
 * cannot be made rather than one that has not been made YET. Waiting out
 * `connectionTimeoutMillis` would take five seconds and assert the same thing.
 */
const DEAD_URL = 'postgres://nobody:nothing@127.0.0.1:1/nowhere';

test('a checkout that cannot be had is named, and says which helper wanted it', async () => {
  // **The failure this repo had no name for.** All three helpers take their
  // connection BEFORE their `try`, so the rejection escapes `noteTimeout`
  // entirely — and `noteTimeout` matches SQLSTATEs, which an error that never
  // reached Postgres does not have. What an operator saw was a 500 and nothing
  // else. Since #192 `/overview` reads `data_version` on every request, so this
  // is now the first thing a saturated pool produces on the busiest route.
  //
  // All THREE call sites, one case each, because the wrapper is only worth
  // having if nothing kept its own `pool.connect()` — and a test naming one of
  // them passes with the other two reverted.
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = DEAD_URL;

  /** @type {any[]} */
  let events = [];
  let refused = 0;
  try {
    const pool = await import(`../src/db/pool.js?v=${++stamp}`);
    ({ records: events } = await logged(async () => {
      for (const call of [
        () => pool.withUser(1, async () => 'unreachable'),
        () => pool.withNotifierScope(async () => 'unreachable'),
        () => pool.withoutUser(async () => 'unreachable'),
      ]) {
        // Rejecting is the control: if one of these ever RESOLVED there would
        // be a database on port 1 and the whole test would be measuring it.
        await call().then(() => {}, () => { refused++; });
      }
    }));
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  }

  assert.equal(refused, 3, 'control: all three must fail to take a connection');

  // `msg` rather than `event`: that is what `shared/src/log.js` calls the name
  // of a record, and asserting the wrong key is a filter that matches nothing
  // and an empty list that agrees with every mutation.
  const named = events.filter((e) => e.msg === 'pg.checkout_failed');
  // One, not three. This control answers "did the stub capture anything at
  // all?", so that an empty `named` below is read as a missing LOG rather than
  // as a broken helper — and it must not be the assertion that fires when a
  // call site is reverted, or the mutation reports itself as a test bug.
  assert.ok(events.length >= 1,
    'control: the stub must capture the logger at all, or `named` is empty for '
    + 'the wrong reason');
  assert.deepEqual(
    named.map((e) => e.scope).sort(),
    ['withNotifierScope', 'withUser', 'withoutUser'],
    'each helper must name ITSELF, or the log says a checkout failed somewhere'
  );

  // The literal, not the constant — the event name is what an operator greps
  // for and what an alert is written against, so renaming it is a thing to do
  // on purpose. And `error`, because every one of these is a request that
  // failed; a warn would be filtered out of exactly the incident it describes.
  assert.ok(named.every((e) => e.level === 'error'), 'a refused checkout is an error');

  // **The gauge is the half that makes the line worth reading.** Saturation and
  // an unreachable database are the same rejection with the same message, and
  // the numbers are what separate them: `pg_total` at `pg_max` is a pool too
  // small, `pg_total` 0 is a database that is not there. That is why this is
  // logged rather than matched on `pg`'s own prose, which carries no code to
  // match on anyway.
  //
  // `pg_waiting` is not part of that test, and the saturated half of it is not
  // in this file: `api.integration.mjs` holds a real pool at `max` and pins
  // both `pg_total === pg_max` and `pg_waiting === 0`, the second because a
  // waiter that times out has already been removed from `pg`'s queue and so
  // does not count itself. Only the presence of the four keys is asserted here.
  for (const e of named) {
    for (const key of ['pg_total', 'pg_idle', 'pg_waiting', 'pg_max']) {
      assert.ok(key in e, `${e.scope} must carry ${key}, or the line cannot say WHY`);
    }
  }
  assert.ok(named.every((e) => e.pg_total === 0),
    'control: nothing is connected here, which is what a dead database looks like');
});

/* ---------- the guard that is now the injection guard too (#188) ---------- */

/**
 * `withUser` folds `BEGIN` and `set_config('app.user_id', ...)` into one
 * multi-statement `query()` call, which only works with `userId`
 * INTERPOLATED into the string rather than bound — so this guard is now the
 * only thing standing between a crafted id and a second SQL statement, not
 * merely a correctness check. This pins that it still does the job, for
 * every shape of value that must not reach the template literal.
 *
 * `DEAD_URL`, not the module's default `DATABASE_URL` — deliberately. If the
 * guard were ever loosened enough to let a value past it, the very next thing
 * `withUser` does is take a real connection and run the interpolated string,
 * and that must never be a thing this suite can do against a real Postgres.
 * `checkout` fails fast and the same way against `DEAD_URL` regardless, which
 * is what makes the MESSAGE the discriminator rather than "did it reject":
 * the guard's own throw always reads `requires a valid user id`; a failed
 * checkout never does. So a case that only rejects because the connection
 * failed — the guard having waved it through — is caught by the message
 * assertion, not by "it threw".
 */
test('withUser rejects every invalid id at the guard, and never runs fn', async () => {
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = DEAD_URL;

  const cases = [
    ['a string that looks like SQL', '1; DROP TABLE users'],
    ['a non-integer number', 1.5],
    ['a numeric string', '1'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a negative integer', -1],
    ['zero', 0],
    ['null', null],
    ['undefined', undefined],
    // The shape a coercive guard cannot catch: `Number(x)` reads `valueOf`,
    // `${x}` reads `toString`, and here they disagree — `Number.isInteger`
    // rejects this before either conversion runs, because it demands the JS
    // type `number` and this is an object.
    ['an object with mismatched valueOf/toString', {
      valueOf: () => 1,
      toString: () => "1'; DROP TABLE users; --",
    }],
    ['true', true],
  ];

  try {
    const pool = await import(`../src/db/pool.js?v=${++stamp}`);
    for (const [label, userId] of cases) {
      let called = false;
      await assert.rejects(
        () => pool.withUser(userId, async () => { called = true; return 'unreachable'; }),
        /requires a valid user id/,
        `${label}: must be rejected by the guard itself, not by a failed checkout`
      );
      assert.equal(called, false, `${label}: fn must never run`);
    }
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  }
});

/* ---------- the fold itself is pinned, not just the guard (#188) ---------- */

/**
 * A fake `PoolClient` that RECORDS every `query()` call rather than running
 * one, so the shape of the calls `withUser` / `withNotifierScope` issue can be
 * counted without a database anywhere.
 */
function recordingClient() {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    client: {
      query: async (sql) => { calls.push(sql); return { rows: [] }; },
      release: () => {},
    },
  };
}

/**
 * #188 folds `BEGIN` (or `BEGIN READ ONLY`) and `set_config(...)` into ONE
 * multi-statement `query()` call — four round trips around the transaction
 * down to three — and that is the entire performance claim the commit is
 * named for. Nothing above this pins the SHAPE of it: the guard tests above
 * only pin that a bad `userId` is rejected, and a correct-but-unfolded revert
 *
 *   await client.query('BEGIN');
 *   await client.query(`SELECT set_config('app.user_id', '${userId}', true)`);
 *
 * would stay just as correct and just as safe, and would pass every one of
 * them — silently giving back the round trip #188 removed. So `pool.connect`
 * is stubbed to hand `withUser` a fake client instead of a real checkout, and
 * the calls it is given are counted directly.
 *
 * The count is asserted as the LITERAL `3`, not a constant read back out of
 * the module: importing the number under test would pin its name and nothing
 * about whether the module still folds the two statements together.
 */
test('withUser folds BEGIN and set_config into one query() call', async () => {
  const pool = await import(`../src/db/pool.js?v=${++stamp}`);
  const { calls, client } = recordingClient();
  pool.pool.connect = async () => client;

  await pool.withUser(7, async (c) => {
    await c.query('SELECT 1'); // the body's own round trip, between the fold and COMMIT
    return 'ok';
  });

  assert.equal(calls.length, 3,
    'expected [fold, the callback\'s own query, COMMIT] — a revert to two '
    + 'separate statements for BEGIN and set_config would make this 4');
  assert.match(calls[0], /BEGIN/, 'the FIRST call must open the transaction');
  assert.match(calls[0], /set_config\(\s*'app\.user_id',\s*'7',\s*true\s*\)/,
    'the FIRST call must also carry set_config, folded into the same string');
});

/** Same shape, for the read-only notifier scope. */
test('withNotifierScope folds BEGIN READ ONLY and set_config into one query() call', async () => {
  const pool = await import(`../src/db/pool.js?v=${++stamp}`);
  const { calls, client } = recordingClient();
  pool.pool.connect = async () => client;

  await pool.withNotifierScope(async (c) => {
    await c.query('SELECT 1');
    return 'ok';
  });

  assert.equal(calls.length, 3,
    'expected [fold, the callback\'s own query, COMMIT] — a revert to two '
    + 'separate statements for BEGIN READ ONLY and set_config would make this 4');
  assert.match(calls[0], /BEGIN READ ONLY/, 'the FIRST call must open the read-only transaction');
  assert.match(calls[0], /set_config\(\s*'app\.scope',\s*'notifier',\s*true\s*\)/,
    'the FIRST call must also carry set_config, folded into the same string');
});
