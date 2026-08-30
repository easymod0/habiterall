/**
 * How the two Postgres timeouts read their environment.
 *
 * A unit test rather than a line in `api.integration.mjs`, because the value
 * that matters most is the one no running pool can demonstrate: `0`. Postgres
 * spells "no timeout" as 0, and the module has to be imported afresh for each
 * setting, which is what the `?v=` cache-buster below is for. No connection is
 * ever opened — `new Pool` is lazy — so this needs no database.
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
  const lines = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };

  let t;
  try {
    t = await poolWith({ PG_STATEMENT_TIMEOUT_MS: '15s', PG_IDLE_TX_TIMEOUT_MS: '-1' });
  } finally {
    process.stdout.write = realWrite;
  }

  assert.equal(t.pg_statement_timeout_ms, 15_000);
  assert.equal(t.pg_idle_tx_timeout_ms, 30_000);

  // ...and it SAYS so. Falling back silently is how a typo survives to
  // production looking like a deliberate setting.
  const warned = lines.join('');
  assert.match(warned, /pg\.timeout_env_ignored/);
  // The logger redacts `name` and `value` as PII, so the fields are called
  // something else — a warning that names neither the setting nor what was
  // written in it is a warning about nothing.
  assert.match(warned, /PG_STATEMENT_TIMEOUT_MS/, 'the warning must name the setting');
  assert.match(warned, /15s/, 'the warning must quote what was actually written');
  assert.doesNotMatch(warned, /redacted/, 'redaction here would empty the warning');
});
