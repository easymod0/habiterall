/**
 * Password hashing, and the rule that decides whether auth is on at all.
 *
 * Pure logic with no storage coupling, so it sits here rather than in the
 * personal edition: the hash format is a thing both a server and a test have to
 * agree on, and the "is auth enabled?" rule is the kind of question that must
 * have exactly one answer.
 *
 * The cloud edition uses none of this — it never sees a password, by design
 * (see the header of habiterall-cloud/src/auth.js). This is the personal
 * edition's half of a shared sign-in flow.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * scrypt parameters. N=16384 needs 128*N*r = 16MB, which fits under Node's
 * default 32MB `maxmem` — raise both together or hashing throws at runtime
 * rather than at review time.
 */
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Format identifier, so the stored value says how to verify itself. */
const SCHEME = 'scrypt';

const derive = (plain, salt, { N, r, p, keylen }) =>
  new Promise((resolve, reject) => {
    scrypt(plain, salt, keylen, { N, r, p }, (err, key) =>
      err ? reject(err) : resolve(key));
  });

/**
 * Hash a password for storage.
 *
 * The parameters travel inside the string rather than living as a constant
 * here, so raising them later does not invalidate every hash already stored:
 * an old hash still says how it was made and still verifies.
 *
 * @param {string} plain
 * @returns {Promise<string>} `scrypt$N$r$p$<salt b64>$<key b64>`
 */
export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain === '') {
    throw new Error('password must be a non-empty string');
  }
  const salt = randomBytes(16);
  const key = await derive(plain, salt, PARAMS);
  const { N, r, p } = PARAMS;
  return [SCHEME, N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Check a password against a stored hash.
 *
 * Returns false rather than throwing for every malformed input, because the
 * caller is a login route and the difference between "wrong password" and
 * "corrupt hash" is not something to tell an unauthenticated stranger. The
 * server logs the distinction; the response does not carry it.
 *
 * @param {string} plain
 * @param {string} stored a string from `hashPassword`
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;

  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== SCHEME) return false;

  const N = Number(n), rr = Number(r), pp = Number(p);
  if (![N, rr, pp].every((v) => Number.isInteger(v) && v > 0)) return false;

  let salt, expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(keyB64, 'base64');
  } catch { return false; }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await derive(plain, salt, { N, r: rr, p: pp, keylen: expected.length });
    // Lengths are equal by construction above, but timingSafeEqual throws
    // rather than returning false when they are not, so it is checked.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** The one value of HABITERALL_AUTH that turns authentication off. */
export const AUTH_OFF = 'off';

/**
 * Is authentication enabled?
 *
 * Deliberately inverted from the usual feature flag: **anything that is not
 * exactly `off` means on**, including unset, empty, `false`, `0`, `no`, and
 * every typo of `off`. The failure this guards is a personal instance put on
 * the public internet with an env var that did not take — a mistake whose
 * symptom is that everything works, for everyone, including strangers.
 *
 * The cost is that turning auth off is not guessable, only documented. That is
 * the right way round: leaving it on by accident costs a login prompt, and
 * turning it off by accident costs the whole database.
 *
 * @param {string|undefined} raw `process.env.HABITERALL_AUTH`
 * @returns {boolean}
 */
export function authEnabled(raw) {
  return String(raw ?? '').trim().toLowerCase() !== AUTH_OFF;
}

/**
 * Whether a value was *meant* to disable auth but did not.
 *
 * `authEnabled` fails safe silently, which is the correct behaviour and the
 * worst possible debugging experience — an operator who wrote
 * `HABITERALL_AUTH=false` gets a login prompt and no reason for it. The server
 * uses this to say so at startup.
 *
 * @param {string|undefined} raw
 * @returns {boolean} true when a non-empty value was given and rejected
 */
export function authFlagMisread(raw) {
  const value = String(raw ?? '').trim();
  return value !== '' && authEnabled(value);
}

/**
 * Credentials supplied by the environment, if any.
 *
 * `HABITERALL_PASSWORD_HASH` is preferred: it keeps the plaintext out of the
 * process environment, out of `docker inspect`, and out of any log that dumps
 * config. `HABITERALL_PASSWORD` is accepted because typing a hash by hand is a
 * barrier that pushes people toward no password at all — it is hashed on the
 * way in and the plaintext is never stored.
 *
 * Environment credentials WIN over anything in the database, and the caller
 * disables the change-password path when they are present. Two sources of
 * truth for one credential is how an operator changes a password in the UI,
 * redeploys, and silently gets the old one back.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{username: string, hash: string|null, plain: string|null}|null}
 */
export function envCredentials(env) {
  const username = (env.HABITERALL_USERNAME ?? '').trim();
  const hash = (env.HABITERALL_PASSWORD_HASH ?? '').trim();
  const plain = env.HABITERALL_PASSWORD ?? '';

  if (!hash && !plain) return null;

  return {
    // A username is not a secret and not a second factor; it exists because
    // password managers expect a pair and because a blank field reads as broken.
    username: username || 'admin',
    hash: hash || null,
    plain: plain || null,
  };
}
