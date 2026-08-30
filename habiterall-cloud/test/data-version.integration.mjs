/**
 * `users.data_version` moves on every write, and on nothing else.
 *
 * The counter is read into the `/overview` memo key, so what goes wrong when it
 * fails to move is not a failing request: it is a cache entry that stays
 * reachable after the write that should have retired it, and every reader on
 * every replica served that payload until the TTL expires. Nothing reports it,
 * and every test that reads THROUGH the cache passes. So the pin is here, at
 * the write paths, one case per route, and the assertion is the crude one that
 * can only be satisfied by the bump actually happening: read the column before,
 * make the request, read it after, and require it to have strictly increased.
 *
 * Read out of band with the ADMIN connection on purpose. The app role can see
 * its own `data_version` perfectly well, but reading it through the API would
 * pin only what the API is willing to say about itself; the owner sees the row.
 *
 * Four things only this file can see:
 *
 *  1. Every mutating route bumps — including `POST /notify/test`, which writes
 *     nothing `/overview` reads and bumps for uniformity, exactly as the
 *     invalidation middleware already forgets on it.
 *  2. `DELETE /habits/:id/entries/:date` bumps, as its own case. It is the
 *     transition a row-timestamp design gets wrong — a day going back to
 *     `unknown` leaves nothing behind to carry a newer timestamp — and it is
 *     the one shape where "the data changed" and "a row exists" disagree.
 *  3. The two write paths that never reach the `/api` router bump: the signed
 *     ntfy answer, mounted above it, and the Discord button, which never
 *     touches Express at all. Both land in `interactionAdapter().record`.
 *  4. **A READ does not bump.** That is the control that makes the rest mean
 *     something: `withUser` wraps the reads too, so a bump moved into it would
 *     satisfy every case above while making the counter a request counter —
 *     one that turns each read into a write and never lets a memo entry live.
 *
 * The Discord half is driven in process, through `handleInteraction` over the
 * real `interactionAdapter()`, because the alternative is faking a gateway
 * socket; the ntfy half goes over the real route on the booted server. Both
 * write through the same `record`, and it is `record` that carries the bump.
 *
 *   DATABASE_URL=... ADMIN_URL=... node test/data-version.integration.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';

import { NTFY_ANSWER_PATH, signNtfyAnswer } from '@habiterall/shared/ntfy-answer.js';

process.env.ADMIN_URL ??= 'postgres://owner:testpw@localhost:5432/habiterall';
process.env.DATABASE_URL ??= 'postgres://habiterall_app:apptestpw@localhost:5432/habiterall';

const SECRET = 'data-version-integration-secret';
const SID = 'dataversionintegrationsid001';
const SUBJECT = 'ci-data-version';
const CHANNEL = '424242424242424242';

// Imported AFTER the admin client is constructed below would be the trap the
// memo suite records; imported here, before anything reads a bigint, is the
// other side of it — `db/pool.js` installs a BIGINT parser on the `pg` module,
// and this file reads `data_version::text` so it does not care either way.
const { interactionAdapter } = await import('../src/notifier.js');
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
const port = 3800 + (process.pid % 150);
const { child, base } = await boot(issuer, port);

try {
  await admin.connect();

  await admin.query(`DELETE FROM users WHERE idp_subject = $1`, [SUBJECT]);
  const { rows: [row] } = await admin.query(
    `INSERT INTO users (idp_subject, idp_issuer, email, display_name)
     VALUES ($1, 'https://ci.example', 'version@example.com', 'version')
     RETURNING id`,
    [SUBJECT]
  );
  const user = Number(row.id);
  await admin.query(
    `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, $3)
     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
    [SID, JSON.stringify({
      cookie: { originalMaxAge: 6048e5, httpOnly: true, path: '/', sameSite: 'lax' },
      user: { id: user, email: 'version@example.com', name: 'version', blocked: false },
    }), new Date(Date.now() + 7 * 864e5)]
  );
  const cookie = `habiterall.sid=${signed(SID, SECRET)}`;

  /**
   * The counter, as a NUMBER, read by the owner.
   *
   * `::text` because this process has `db/pool.js` loaded (for the Discord
   * adapter below), which installs a BIGINT parser on the shared `pg` module —
   * so whether this arrives as a string or a number depends on import order,
   * which is not something a comparison should depend on.
   */
  const version = async () => Number((await admin.query(
    `SELECT data_version::text AS v FROM users WHERE id = $1`, [user])).rows[0].v);

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

  /**
   * Run FN, and require the counter to have strictly increased across it.
   *
   * The status is checked as its own control: a route that 400s writes nothing
   * and would fail the version check for a reason that has nothing to do with
   * the bump, and reading "the version did not move" off a request that never
   * happened is how this suite would lie about which line is broken.
   *
   * @param {string} label
   * @param {() => Promise<{status: number, body?: any}>} fn
   */
  const bumps = async (label, fn) => {
    const before = await version();
    const res = await fn();
    const after = await version();
    ck(`control: ${label} was accepted`, res.status < 300,
      `-> ${res.status} ${JSON.stringify(res.body ?? '').slice(0, 140)}`);
    ck(`${label} bumps data_version`, after > before, `${before} -> ${after}`);
    return res;
  };

  const today = dayIn('UTC');

  console.log('--- every mutating route on the /api router ---');

  const created = await bumps('POST /habits', () => call('/habits', {
    method: 'POST',
    body: { name: 'Version probe', type: 'boolean', freq_numerator: 1, freq_denominator: 1 },
  }));
  const habitId = created.body.id;

  await bumps('PUT /habits/:id', () => call(`/habits/${habitId}`, {
    method: 'PUT',
    body: { name: 'Version probe renamed', type: 'boolean', freq_numerator: 1, freq_denominator: 1 },
  }));

  await bumps('POST /habits/reorder', () => call('/habits/reorder', {
    method: 'POST', body: { order: [habitId] },
  }));

  const category = await bumps('POST /categories', () => call('/categories', {
    method: 'POST', body: { name: 'Version probe category', color: '#3b82f6' },
  }));
  const categoryId = category.body.id;

  await bumps('PUT /categories/:id', () => call(`/categories/${categoryId}`, {
    method: 'PUT', body: { name: 'Version probe category renamed', color: '#ef4444' },
  }));

  await bumps('POST /categories/reorder', () => call('/categories/reorder', {
    method: 'POST', body: { order: [categoryId] },
  }));

  await bumps('DELETE /categories/:id', () =>
    call(`/categories/${categoryId}`, { method: 'DELETE' }));

  // The tap, and then the untap. Two routes, one case each, because the second
  // is the one a design keyed on row timestamps cannot express: the row is
  // GONE, so there is nothing left to carry the newer time, and the account
  // reads as though the day had never been answered rather than as changed.
  await bumps('PUT /habits/:id/entries/:date', () =>
    call(`/habits/${habitId}/entries/${today}`, { method: 'PUT', body: { value: 2 } }));

  await bumps('DELETE /habits/:id/entries/:date', () =>
    call(`/habits/${habitId}/entries/${today}`, { method: 'DELETE' }));

  await bumps('PUT /settings', () =>
    call('/settings', { method: 'PUT', body: { weekStart: 'sunday' } }));

  await bumps('DELETE /settings', () => call('/settings', { method: 'DELETE' }));

  // Nothing `/overview` reads, and it bumps anyway — see the comment at the
  // route. With no server-delivered channel configured this sends nothing, so
  // the reply is an empty result list and no outbound traffic leaves the box.
  const test = await bumps('POST /notify/test', () =>
    call('/notify/test', { method: 'POST', body: {} }));
  ck('control: the test send had no destination to reach',
    Array.isArray(test.body?.results) && test.body.results.length === 0,
    JSON.stringify(test.body));

  const backup = Buffer.from(JSON.stringify({
    version: 1,
    app: 'habiterall',
    habits: [{
      name: 'Imported by the version suite',
      type: 'boolean',
      freq_numerator: 1,
      freq_denominator: 1,
      entries: [{ date: today, value: 2 }],
    }],
  }), 'utf8');
  const imported = await bumps('POST /import', () =>
    call('/import?mode=merge', { method: 'POST', raw: backup }));
  ck('control: the import actually wrote a habit',
    imported.body?.habitsCreated === 1, JSON.stringify(imported.body));

  console.log('\n--- the two write paths that never reach the /api router ---');

  // The channel is what authorises a Discord press, so the account has to claim
  // one. Set with the ADMIN connection, which is not the app and does not bump —
  // if this line moved the counter, the case below would pass without a press.
  await admin.query(
    `UPDATE users SET settings = settings || $2::jsonb WHERE id = $1`,
    [user, JSON.stringify({ discordChannelId: CHANNEL })]
  );

  const beforePress = await version();
  const sent = [];
  await handleInteraction({
    id: 'i1', token: 'tok', type: INTERACTION.COMPONENT,
    channel_id: CHANNEL,
    member: { user: { id: '999999999999999999' } },
    message: { embeds: [{ title: 'Did you?' }] },
    data: { custom_id: `hab|${habitId}|${today}|yes` },
  }, { ...interactionAdapter(), respond: async (i, r) => { sent.push(r); } });
  const afterPress = await version();
  ck('control: the Discord press was answered in place',
    sent.at(-1)?.type === 7, JSON.stringify(sent.at(-1)).slice(0, 160));
  ck('a Discord button press bumps data_version', afterPress > beforePress,
    `${beforePress} -> ${afterPress}`);

  const code = signNtfyAnswer({
    secret: SECRET, account: String(user), habitId, date: today, action: 'no',
  });
  const beforeNtfy = await version();
  const pressed = await fetch(`${base}${NTFY_ANSWER_PATH}?c=${encodeURIComponent(code)}`,
    { method: 'POST' });
  const afterNtfy = await version();
  ck('control: the ntfy press was accepted', pressed.ok, `-> ${pressed.status}`);
  ck('a signed ntfy answer bumps data_version', afterNtfy > beforeNtfy,
    `${beforeNtfy} -> ${afterNtfy}`);

  console.log('\n--- and the route that ends the habit ---');

  await bumps('DELETE /habits/:id', () => call(`/habits/${habitId}`, { method: 'DELETE' }));

  console.log('\n--- a read does not bump ---');
  // The control the whole suite rests on. `withUser` wraps the reads too, so a
  // bump written into IT rather than into `withUserWrite` passes every case
  // above — while making the counter count requests, turning every dashboard
  // fetch into a write, and leaving no memo entry ever reachable twice.
  //
  // Four reads, not one: the same shapes a client actually issues between two
  // writes, and `/overview` in particular is the route whose own memo is what
  // the version is for.
  const beforeReads = await version();
  const reads = [
    await call('/overview'),
    await call('/habits'),
    await call('/categories'),
    await call('/settings'),
  ];
  const afterReads = await version();
  ck('control: all four reads answered', reads.every((r) => r.status === 200),
    reads.map((r) => r.status).join(','));
  ck('four reads leave data_version exactly where it was',
    afterReads === beforeReads, `${beforeReads} -> ${afterReads}`);

  await admin.query(`DELETE FROM session WHERE sid = $1`, [SID]);
  await admin.query(`DELETE FROM users WHERE idp_subject = $1`, [SUBJECT]);
} finally {
  child.kill();
  srv.close();
  await admin.end().catch(() => {});
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL DATA VERSION CHECKS PASSED');
process.exit(fails ? 1 : 0);
