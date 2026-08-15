/**
 * An express-session store over `node:sqlite`.
 *
 * Written rather than installed on purpose. `connect-sqlite3`, the obvious
 * choice, is built on the `sqlite3` native module — which would undo the single
 * property this edition's storage was chosen for: no native module to compile,
 * no rebuild on a Node upgrade, and a Docker image that builds in about a
 * second with one runtime dependency (see CLAUDE.md, "Why node:sqlite"). A
 * session store is about forty lines; a toolchain is not.
 *
 * The cloud edition's equivalent is `connect-pg-simple` against Postgres. Both
 * keep sessions server-side so a sign-out can actually revoke one, which a
 * signed stateless cookie cannot.
 */

import session from 'express-session';

const { Store } = session;

/**
 * How often expired rows are swept, in ms.
 *
 * Sessions are deleted lazily on read as well, so this only exists to stop an
 * abandoned instance growing a table of dead rows forever. Hourly is far more
 * often than it needs to be and costs one indexed DELETE.
 */
const SWEEP_MS = 60 * 60 * 1000;

export class SqliteStore extends Store {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   */
  constructor(db) {
    super();
    this.db = db;

    // Statements are prepared once. `DatabaseSync` is synchronous, which is
    // exactly why this edition is single-user — see CLAUDE.md.
    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET data = excluded.data,
                                          expires_at = excluded.expires_at`
      ),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      sweep: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
      clear: db.prepare('DELETE FROM sessions'),
      length: db.prepare('SELECT COUNT(*) AS n FROM sessions'),
    };

    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    // Never hold the process open for a cleanup job.
    this.timer.unref?.();
  }

  /** Expiry for a session, as epoch ms. */
  #expiry(sess) {
    const ms = sess?.cookie?.originalMaxAge ?? sess?.cookie?.maxAge;
    // A session with no maxAge is a browser-session cookie; give the row a day
    // so it is not immortal. express-session will re-`set` it on every request.
    return Date.now() + (typeof ms === 'number' && ms > 0 ? ms : 24 * 60 * 60 * 1000);
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid);
      if (!row) return cb(null, null);

      // Expired rows are deleted on read as well as swept: between sweeps a
      // stale row would otherwise still authenticate a request.
      if (Number(row.expires_at) <= Date.now()) {
        this.stmts.destroy.run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(String(row.data)));
    } catch (e) {
      // A row that will not parse is a corrupt session, not a server fault:
      // report "no session" so the user signs in again.
      return cb(null, null);
    }
  }

  set(sid, sess, cb) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), this.#expiry(sess));
      cb?.(null);
    } catch (e) { cb?.(e); }
  }

  destroy(sid, cb) {
    try {
      this.stmts.destroy.run(sid);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }

  /**
   * Extend a session without rewriting its data.
   *
   * Required because the app runs `rolling: true`, so every request renews the
   * cookie. Without a `touch`, express-session falls back to a full `set` on
   * each request and rewrites the whole row for a timestamp.
   */
  touch(sid, sess, cb) {
    try {
      this.stmts.touch.run(this.#expiry(sess), sid);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }

  length(cb) {
    try { cb(null, this.stmts.length.get().n); } catch (e) { cb(e); }
  }

  clear(cb) {
    try { this.stmts.clear.run(); cb?.(null); } catch (e) { cb?.(e); }
  }

  sweep() {
    try { this.stmts.sweep.run(Date.now()); } catch { /* next hour will do */ }
  }

  /** Stop the sweep timer, so a test can exit. */
  close() {
    clearInterval(this.timer);
  }
}
