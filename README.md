# habiterall

A self-hosted habit tracker with the statistics of [Loop Habit Tracker](https://github.com/iSoron/uhabits), in two editions that share one core.

```
habiterall/
├── shared/               logic used by both editions — no database, no HTTP
│   ├── src/stats.js        scoring, streaks, aggregation
│   ├── src/import.js       Loop .db / CSV / JSON parsers
│   ├── src/export-loop.js  writes a Loop-compatible .db
│   ├── src/unzip.js        minimal ZIP reader
│   ├── public/charts.js    hand-rolled SVG charts
│   └── test/               68 tests covering all of the above
│
├── habiterall-personal/  single user, SQLite, no login
├── habiterall-cloud/     multi user, Postgres, OIDC login
└── android/              Trusted Web Activity wrapper (ships the PWA)
```

Both editions are installable **progressive web apps**: add to home screen for a
full-screen app with an icon, offline access to your dashboard, and check-offs
that queue on the device and sync when you reconnect. `android/` wraps the same
PWA as a Play Store app — see [android/README.md](android/README.md).

`shared/` also holds the PWA pieces — the manifest, the service worker, and the
offline write queue — so both editions get identical installable behaviour.

`shared/` holds everything that is pure logic over data. Storage and auth stay per-edition, because one is single-user SQLite and the other is multi-tenant Postgres. A fix to the scoring maths or the Loop format applies to both editions at once.

This is an npm workspace, so `shared` resolves as a normal dependency (`@habiterall/shared/stats.js`) with no build step or symlink juggling.

```bash
npm install          # once, at the repo root
npm test             # every workspace
```

## Which edition do I want?

| | personal | cloud |
| --- | --- | --- |
| Users | one | many, each isolated |
| Login | none | any OIDC provider |
| Database | SQLite file | Postgres |
| Setup | `npm start` | Docker Compose + an identity provider |
| Best for | your own machine or LAN | a server other people log in to |

**Start with personal.** It has no moving parts, and a JSON backup imports straight into cloud later if you outgrow it.

---

## habiterall-personal

```bash
cd habiterall-personal
npm start            # http://localhost:3000
npm run seed         # optional sample data
```

Or with Docker: `docker compose up -d --build`.

See [habiterall-personal/README.md](habiterall-personal/README.md) for the full feature list, API, and Loop import/export details.

---

## habiterall-cloud

Multi-user, built so that isolation is enforced by the database rather than by application code.

### Security model

- **Row-Level Security.** Every table is `FORCE ROW LEVEL SECURITY` with a policy keyed on `app.user_id`, set per transaction. A query that forgets its `WHERE` clause returns *nothing* — the isolation fails closed rather than leaking.
- **Least privilege.** The app connects as `habiterall_app`, which is not the table owner, has `NOBYPASSRLS`, and cannot run DDL. Migrations use a separate admin credential the running app never holds.
- **No passwords stored.** Authentication is delegated to an OIDC provider, which owns credentials, MFA, and resets. Users are keyed on `(issuer, subject)` — never on email, which can change or be reassigned.
- **Opaque session cookies**, `httpOnly` + `Secure` + `SameSite=Lax`, stored server-side so they can be revoked instantly. Tokens never reach the browser, so XSS cannot exfiltrate a bearer credential.
- **Imports are confined to the importer.** Ids inside an uploaded backup are ignored entirely; every written row carries the session's `user_id`. A backup from another account imports into *your* account.
- Session regeneration on login (fixation), PKCE + state + nonce on the OIDC flow, CSP with no inline scripts, and rate limits on login, API, and import.

All of the above is verified adversarially — see `habiterall-cloud/test/README.md`. The suite tries to read, modify, and delete another user's data, and to smuggle rows in through an import.

### Setup

1. **Pick an identity provider.** [Authentik](https://goauthentik.io) is the recommended self-hosted choice: no user cap, no feature gating, MIT-licensed. [Keycloak](https://www.keycloak.org) is the more battle-tested alternative. For a managed option, Supabase Auth is free to 50k monthly users and self-hostable later. Register habiterall-cloud as an OIDC confidential client with redirect URI `https://your-domain/auth/callback`.

2. **Write `.env`** next to `habiterall-cloud/docker-compose.yml`:

   ```ini
   DB_OWNER_PASSWORD=<random>
   APP_DB_PASSWORD=<random>
   SESSION_SECRET=<random, 32+ bytes>
   PUBLIC_URL=https://habits.example.com
   OIDC_ISSUER=https://auth.example.com/application/o/habiterall/
   OIDC_CLIENT_ID=<from your IdP>
   OIDC_CLIENT_SECRET=<from your IdP>
   ```

   Generate secrets with `openssl rand -base64 32`.

3. **Migrate and start:**

   ```bash
   cd habiterall-cloud
   docker compose run --rm app npm run migrate
   docker compose up -d
   ```

4. **Put a TLS-terminating reverse proxy in front.** The app binds to `127.0.0.1:3100` and sets `Secure` cookies, so it needs real HTTPS. Caddy needs two lines:

   ```
   habits.example.com {
     reverse_proxy 127.0.0.1:3100
   }
   ```

### Operating it

- **Back up the database, not a file:** `docker compose exec db pg_dump -U habiterall_owner habiterall | gzip > backup.sql.gz`. Test a restore before you rely on it.
- **Per-user limits** (`MAX_HABITS_PER_USER`, `MAX_ENTRIES_PER_IMPORT`, `MAX_UPLOAD_MB`) are env-tunable.
- **Suspending an account:** set `blocked = true` on the user row. Their data is retained; their session stops working.

### Not built yet

Admin dashboard, per-user usage metrics, automated backups, and billing. The foundations (RLS, migrations, pooling, quotas) are in place for them.

## License

MIT
