/**
 * One check on a Postgres connection string, run before anything tries to use
 * it.
 *
 * `pg` does not parse the URL when the pool is constructed — it parses on the
 * first connection, several layers down. So a malformed `DATABASE_URL` does not
 * stop the app booting: it starts, serves the shell, signs you in, and then
 * every request that touches the database dies with
 *
 *   TypeError: Invalid URL
 *       at parse (pg-connection-string/index.js:30)
 *       at PGStore._asyncQuery (connect-pg-simple/index.js:322)
 *
 * which names neither the variable at fault nor the reason. That was a real
 * afternoon: the operator sees "internal error" on every page, a healthy
 * container, migrations up to date and a schema with all its tables.
 *
 * The cause is almost always the password. `openssl rand -base64 36` — which
 * this project's own docs recommended — emits `+`, `/` and `=`, and a `/` in
 * the password terminates the URL's authority, leaving no host at all. About
 * half of all generated passwords contain one, so it is a coin flip whether a
 * fresh install works.
 */

/**
 * Throw a message that names the variable and the likely cause.
 *
 * @param {string|undefined} url   the connection string
 * @param {string} varName         what to call it in the error
 */
export function assertConnectionString(url, varName = 'DATABASE_URL') {
  if (!url) throw new Error(`${varName} must be set`);

  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error(
      `${varName} is not a valid URL. The usual cause is an unescaped ` +
      "character in the password: `openssl rand -base64` emits '+', '/' and " +
      "'=', and a '/' ends the authority so the URL has no host. Generate it " +
      'with `openssl rand -hex 32`, or percent-encode the password.'
    );
  }
}
