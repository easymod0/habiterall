import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOriginOnly, warnOnUntrustedProxy, trustProxy } from '../src/security.js';

/** Drive the middleware without Express. */
function run(guard, { method = 'POST', origin, host = 'habits.example.com', xfh, reqHost } = {}) {
  const req = { method, path: '/api/habits', headers: {} };
  if (origin) req.headers.origin = origin;
  if (host) req.headers.host = host;
  if (xfh) req.headers['x-forwarded-host'] = xfh;
  // What Express computes: the forwarded host ONLY when `trust proxy` says so,
  // the socket's Host otherwise. The guard reads this, never the raw header.
  if (reqHost !== undefined) req.host = reqHost;

  let result = null;
  const res = {
    status(code) { result = { status: code }; return this; },
    json(body) { if (result) result.body = body; return this; },
  };
  guard(req, res, () => { result = { passed: true }; });
  return result;
}

test('a same-origin write passes', () => {
  const g = sameOriginOnly();
  assert.equal(run(g, { origin: 'https://habits.example.com' }).passed, true);
});

test('a cross-origin write is refused', () => {
  const g = sameOriginOnly();
  const r = run(g, { origin: 'https://evil.example.com' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /cross-origin/);
});

test('reads are never refused, whatever the origin', () => {
  // A GET cannot change anything, and refusing one would break an embed or a
  // link for no gain.
  const g = sameOriginOnly();
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(run(g, { method, origin: 'https://evil.example.com' }).passed, true, method);
  }
});

test('a request with no Origin passes — that is the native client', () => {
  // The attack needs a browser and browsers always send it. Refusing these
  // would break Api.kt answering a notification, to stop a request it cannot
  // make. See the header of sameOriginOnly.
  const g = sameOriginOnly();
  assert.equal(run(g, { origin: undefined }).passed, true);
});

test('an extra allowed origin is honoured, trailing slash or not', () => {
  const g = sameOriginOnly({ allow: ['https://other.example.com/'] });
  assert.equal(run(g, { origin: 'https://other.example.com' }).passed, true);
  assert.equal(run(g, { origin: 'https://other.example.com/' }).passed, true);
});

test('a garbled Origin is refused rather than throwing', () => {
  const g = sameOriginOnly();
  assert.equal(run(g, { origin: 'not a url' }).status, 403);
  assert.equal(run(g, { origin: '://' }).status, 403);
});

test('the port is part of the origin', () => {
  // https://host and https://host:8443 are different origins, and treating
  // them as one would accept a write from anything sharing the hostname.
  const g = sameOriginOnly();
  assert.equal(run(g, { origin: 'https://habits.example.com:8443' }).status, 403);
});

test('a scheme change on the same host still matches', () => {
  // Host carries no scheme, so http and https on one name are one origin here.
  // That is deliberate: an instance answering on both is the LAN case, and
  // SameSite plus TLS are what separate them.
  const g = sameOriginOnly();
  assert.equal(run(g, { origin: 'http://habits.example.com' }).passed, true);
});

test('a proxy the app trusts is followed', () => {
  // The browser's Origin is the public name; the Host the app sees is the
  // proxy's. Express resolves that into `req.host` when `trust proxy` is set,
  // and comparing against the socket's Host alone would refuse every real write.
  const g = sameOriginOnly();
  assert.equal(run(g, {
    origin: 'https://habits.example.com',
    host: 'app:3000',
    reqHost: 'habits.example.com',   // what Express gives with trust proxy on
  }).passed, true);
});

test('a forwarded-host header the app does NOT trust is ignored', () => {
  // The guard read `x-forwarded-host` straight from the headers, so any client
  // able to set one named its own origin and walked past — and it did so most
  // readily on a directly exposed instance, where `trust proxy` is off and no
  // forwarded header should be believed at all. Express leaves `req.host` as the
  // real Host there, which is what this asserts.
  const g = sameOriginOnly();
  const r = run(g, {
    origin: 'https://evil.example.com',
    host: 'habits.example.com',
    xfh: 'evil.example.com',          // spoofed, and untrusted
    reqHost: 'habits.example.com',
  });
  assert.equal(r.status, 403);
});

test('a rejection is reported to the caller-supplied hook', () => {
  const seen = [];
  const g = sameOriginOnly({ onReject: (req, origin) => seen.push([req.path, origin]) });
  run(g, { origin: 'https://evil.example.com' });
  assert.deepEqual(seen, [['/api/habits', 'https://evil.example.com']]);
});


/* ---------- the proxy that nobody trusts ---------- */

/** Drive the warning middleware without Express. */
function proxyRun(mw, headers = {}) {
  let passed = false;
  mw({ headers }, {}, () => { passed = true; });
  return passed;
}

test('an untrusted proxy is reported, once', () => {
  const said = [];
  const mw = warnOnUntrustedProxy({ trusted: false, warn: (f) => said.push(f) });

  assert.equal(proxyRun(mw, { 'x-forwarded-for': '203.0.113.9' }), true);
  assert.equal(said.length, 1);
  assert.match(said[0].fix, /TRUST_PROXY/);

  // Once per process: a warning repeated per request is one nobody reads, and
  // a client can forge the header to make it repeat.
  proxyRun(mw, { 'x-forwarded-for': '203.0.113.10' });
  proxyRun(mw, { 'x-forwarded-for': '203.0.113.11' });
  assert.equal(said.length, 1);
});

test('nothing is said when no forwarded header ever arrives', () => {
  // The ordinary LAN case, which is what the default is for. A warning here
  // would train the operator to ignore the one that matters.
  const said = [];
  const mw = warnOnUntrustedProxy({ trusted: false, warn: (f) => said.push(f) });
  proxyRun(mw, {});
  proxyRun(mw, { host: 'habits.example.com' });
  assert.equal(said.length, 0);
});

test('nothing is said when a proxy IS trusted', () => {
  const said = [];
  const mw = warnOnUntrustedProxy({ trusted: 1, warn: (f) => said.push(f) });
  assert.equal(proxyRun(mw, { 'x-forwarded-for': '203.0.113.9' }), true);
  assert.equal(said.length, 0);
});

test('the warning fires for whatever trustProxy resolved to falsy', () => {
  // `trustProxy` returns `false` for "0", and Express treats the number 0 the
  // same way — so both have to count as untrusted here or the check is blind to
  // half its own inputs.
  for (const trusted of [trustProxy('0'), 0, false]) {
    const said = [];
    const mw = warnOnUntrustedProxy({ trusted, warn: (f) => said.push(f) });
    proxyRun(mw, { 'x-forwarded-for': '203.0.113.9' });
    assert.equal(said.length, 1, String(trusted));
  }
});
