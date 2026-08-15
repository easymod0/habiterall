import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOriginOnly } from '../src/security.js';

/** Drive the middleware without Express. */
function run(guard, { method = 'POST', origin, host = 'habits.example.com', xfh } = {}) {
  const req = { method, path: '/api/habits', headers: {} };
  if (origin) req.headers.origin = origin;
  if (host) req.headers.host = host;
  if (xfh) req.headers['x-forwarded-host'] = xfh;

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

test('the forwarded host wins behind a proxy', () => {
  // The browser's Origin is the public name; the Host the app sees may be the
  // proxy's. Comparing against the raw Host would refuse every real write.
  const g = sameOriginOnly();
  assert.equal(run(g, {
    origin: 'https://habits.example.com',
    host: 'app:3000',
    xfh: 'habits.example.com',
  }).passed, true);
});

test('a rejection is reported to the caller-supplied hook', () => {
  const seen = [];
  const g = sameOriginOnly({ onReject: (req, origin) => seen.push([req.path, origin]) });
  run(g, { origin: 'https://evil.example.com' });
  assert.deepEqual(seen, [['/api/habits', 'https://evil.example.com']]);
});
