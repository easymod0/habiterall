import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, authEnabled, authFlagMisread, envCredentials, AUTH_OFF,
} from '../src/password.js';

test('a password verifies against its own hash', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
});

test('a wrong password does not', async () => {
  const hash = await hashPassword('hunter2');
  assert.equal(await verifyPassword('hunter3', hash), false);
  assert.equal(await verifyPassword('', hash), false);
  assert.equal(await verifyPassword('HUNTER2', hash), false);
});

test('the same password hashes differently every time', async () => {
  // Salted, so two accounts with the same password do not share a hash and a
  // precomputed table is worth nothing.
  const [a, b] = [await hashPassword('same'), await hashPassword('same')];
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same', a), true);
  assert.equal(await verifyPassword('same', b), true);
});

test('the hash carries its own parameters', async () => {
  const hash = await hashPassword('whatever');
  const [scheme, N, r, p] = hash.split('$');
  assert.equal(scheme, 'scrypt');
  // Present and numeric, so raising the cost later cannot invalidate old hashes.
  for (const v of [N, r, p]) assert.ok(Number.isInteger(Number(v)) && Number(v) > 0);
});

test('a malformed hash is rejected, never thrown on', async () => {
  // The caller is a login route; a corrupt row must read as "wrong password"
  // rather than 500 and tell a stranger the difference.
  for (const bad of ['', 'x', 'scrypt$', 'bcrypt$1$2$3$a$b', 'scrypt$0$8$1$YQ==$Yg==',
                     'scrypt$16384$8$1$$', 'scrypt$a$b$c$d$e', '$$$$$']) {
    assert.equal(await verifyPassword('anything', bad), false, bad);
  }
});

test('an empty password cannot be hashed', async () => {
  await assert.rejects(() => hashPassword(''));
});

test('auth is on unless the flag is exactly "off"', () => {
  assert.equal(authEnabled(AUTH_OFF), false);
  assert.equal(authEnabled('off'), false);
  assert.equal(authEnabled('OFF'), false);
  assert.equal(authEnabled('  off  '), false);

  // The whole point: everything else means ON, including every plausible way
  // of trying to say "off" and getting it wrong.
  for (const raw of [undefined, '', 'false', '0', 'no', 'none', 'disabled',
                     'of', 'ofF ', 'off ', 'true', 'on', 'yes']) {
    if (String(raw ?? '').trim().toLowerCase() === 'off') continue;
    assert.equal(authEnabled(raw), true, JSON.stringify(raw));
  }
});

test('a value meant to disable auth but not understood is reported', () => {
  // Failing safe silently is correct and undebuggable, so the server says so.
  assert.equal(authFlagMisread('false'), true);
  assert.equal(authFlagMisread('0'), true);
  assert.equal(authFlagMisread('disabled'), true);

  // Nothing to report: unset is the normal case, and 'off' worked.
  assert.equal(authFlagMisread(undefined), false);
  assert.equal(authFlagMisread(''), false);
  assert.equal(authFlagMisread('   '), false);
  assert.equal(authFlagMisread('off'), false);
});

test('env credentials are absent unless a password or hash is given', () => {
  assert.equal(envCredentials({}), null);
  assert.equal(envCredentials({ HABITERALL_USERNAME: 'mark' }), null);
});

test('a hash in the environment is preferred over plaintext', () => {
  const creds = envCredentials({
    HABITERALL_USERNAME: 'mark',
    HABITERALL_PASSWORD: 'plain',
    HABITERALL_PASSWORD_HASH: 'scrypt$16384$8$1$YQ==$Yg==',
  });
  assert.equal(creds.username, 'mark');
  assert.equal(creds.hash, 'scrypt$16384$8$1$YQ==$Yg==');
});

test('a username defaults rather than arriving blank', () => {
  // A blank field in the sign-in form reads as broken, and a username is not
  // a secret — so it defaults instead of being required.
  assert.equal(envCredentials({ HABITERALL_PASSWORD: 'x' }).username, 'admin');
  assert.equal(envCredentials({ HABITERALL_USERNAME: '  ', HABITERALL_PASSWORD: 'x' }).username, 'admin');
});
