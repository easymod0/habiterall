/**
 * The bootstrap script cannot be imported — it configures Authentik at the top
 * level and exits — so what is pinned here is read out of its text and out of
 * the two compose files beside it. That is the same trade `branding.test.js`
 * makes, and for the same reason: every rule below is one nothing at runtime
 * would notice, on a path that only runs on someone else's server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUD = join(HERE, '..');
const REPO = join(CLOUD, '..');

const read = (...parts) => readFileSync(join(...parts), 'utf8');
const bootstrap = read(CLOUD, 'scripts', 'bootstrap-authentik.mjs');

const COMPOSE = {
  'habiterall-cloud/docker-compose.yml': read(CLOUD, 'docker-compose.yml'),
  'examples/docker-compose.cloud-authentik.yml':
    read(REPO, 'examples', 'docker-compose.cloud-authentik.yml'),
};

test('every published placeholder the bootstrap could use is refused', () => {
  // The OIDC pair is written ONTO the provider, and the bootstrap token IS an
  // admin API token for `akadmin` — Authentik creates it from that env var on
  // every boot. `.env.example` ships all three as CHANGE_ME lines, so an
  // unedited file otherwise brings up a stack that reports success and accepts
  // a credential whose value is in a public repository.
  for (const name of ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'AUTHENTIK_BOOTSTRAP_TOKEN']) {
    assert.match(
      bootstrap,
      new RegExp(`^\\s*${name}:`, 'm'),
      `${name} is not in the CHANGE_ME guard`,
    );
    assert.match(
      read(CLOUD, '.env.example'),
      new RegExp(`^${name}=CHANGE_ME`, 'm'),
      `${name} no longer ships as a placeholder — the guard above may be stale`,
    );
  }
});

test('the API helper reports the status before it parses the body', () => {
  // An error is not always JSON. Parse first and an HTML 502 from a proxy or a
  // half-booted Authentik arrives as `SyntaxError: Unexpected token '<'`, with
  // the status — the whole diagnostic for the provider writes — thrown away.
  const api = bootstrap.slice(bootstrap.indexOf('const api = async'));
  const body = api.slice(0, api.indexOf('\n};'));
  assert.ok(
    body.indexOf('!res.ok') < body.indexOf('JSON.parse'),
    'api() parses the body before checking the status',
  );
});

test('nothing is written to whatever a filtered list happened to return first', () => {
  // Scoped to linkSignupFlow, because this is about the WRITES. The
  // identification stage it PUTs is instance-wide — it is the login form every
  // other application on that Authentik shares — and the flow it points at
  // decides where a "Sign up" link leads. A server-side filter that stops
  // filtering (a filterset that loses a field across an upgrade) returns the
  // whole list instead of nothing, and the first row of it looks like an
  // answer. So each lookup re-checks the field it filtered on, through
  // `only()` — the defence the scope and provider lookups already had, and the
  // reason the deliberate `?? results[0]` fallbacks elsewhere are all reads
  // with a documented preference in front of them.
  const fn = bootstrap.slice(bootstrap.indexOf('async function linkSignupFlow'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.includes('PUT'), 'linkSignupFlow no longer writes — this test is stale');
  assert.ok(!/results\[0\]/.test(body), 'a write still targets results[0] unverified');
  assert.equal((body.match(/\bonly\(/g) ?? []).length, 3,
    'expected the stage and both enrollment-flow lookups to go through only()');
});

test('the image copies its blueprints and branding over what is already there', () => {
  // They ship inside the image and are versioned with it. With `force: false`
  // the first run's copies were the last: an upgraded image went on applying
  // the previous release's blueprint, while logging that it had published one.
  const publish = bootstrap.slice(bootstrap.indexOf('async function publishFiles'));
  assert.match(publish.slice(0, publish.indexOf('\n}')), /force: true/);
});

test('both compose files default outgoing mail to submission and STARTTLS', () => {
  // These are fallbacks for an .env written before the AUTHENTIK_EMAIL__ lines
  // existed, and the minimal edit to such a file is a host and a password. On
  // port 25 with TLS off that edit puts the SMTP password and every
  // account-activation link on the wire in the clear.
  for (const [name, text] of Object.entries(COMPOSE)) {
    const ports = [...text.matchAll(/AUTHENTIK_EMAIL__PORT:\s*\$\{AUTHENTIK_EMAIL__PORT:-(\d+)\}/g)];
    const tls = [...text.matchAll(/AUTHENTIK_EMAIL__USE_TLS:\s*\$\{AUTHENTIK_EMAIL__USE_TLS:-(\w+)\}/g)];

    // Both containers, not one: the worker is what sends the mail, the server
    // is what the settings are read back from.
    assert.equal(ports.length, 2, `${name} does not set a mail port on both Authentik services`);
    assert.equal(tls.length, 2, `${name} does not set TLS on both Authentik services`);

    for (const [, port] of ports) assert.equal(port, '587', `${name} defaults mail to port ${port}`);
    for (const [, on] of tls) assert.equal(on, 'true', `${name} defaults STARTTLS to ${on}`);
  }
});

test('signing out is registered, and its two halves cannot ship apart', () => {
  // Authentik has no separate post-logout field. `post_logout_redirect_uris`
  // is `redirect_uris` filtered on a per-entry `redirect_uri_type`, which
  // defaults to `authorization` — so with only the callback registered the
  // list is empty, EndSessionView drops the `post_logout_redirect_uri` the app
  // sends without a word, and signing out stops on Authentik's page.
  assert.match(
    bootstrap, /redirect_uri_type:\s*'logout'/,
    'no logout-typed redirect URI: post_logout_redirect_uri will be discarded'
  );

  // And the half that must land WITH it. Once a logout URI exists, Authentik
  // validates `id_token_hint` BEFORE planning the invalidation flow, so a
  // missing hint turns a redirect that went nowhere into an error page that
  // does not sign you out at all. Registering the URI alone is worse than
  // neither, which is why one test guards both.
  const server = read(CLOUD, 'src', 'server.js');
  assert.match(
    server, /logoutUrl\(req\.session\?\.idToken\)/,
    'the logout route sends no id_token_hint: Authentik will answer '
    + 'id_token_hint_missing rather than ending the session'
  );
  assert.match(
    server, /req\.session\.idToken = idToken/,
    'nothing stores the ID token, so the hint above is always undefined'
  );

  // Built from parts rather than interpolated. PUBLIC_URL is used raw where
  // ISSUER_BASE strips a trailing slash, and Authentik compares these as exact
  // strings — a PUBLIC_URL ending in `/` would register a double slash the app
  // never sends. The logout entry, whose path is a bare `/`, is where that
  // bites hardest.
  assert.doesNotMatch(
    bootstrap, /url:\s*`\$\{PUBLIC_URL\}/,
    'a redirect URI is interpolated: a trailing slash in PUBLIC_URL breaks it'
  );
});
