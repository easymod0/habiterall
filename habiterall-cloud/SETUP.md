# habiterall-cloud setup

The compose stack runs four services: the app, its Postgres, and an
[Authentik](https://goauthentik.io) identity provider (server, worker).
Only the reverse proxy needs to face the internet.

## 1. Configure

```bash
cd habiterall-cloud
cp .env.example .env
```

Generate a distinct value for every secret:

```bash
for k in DB_OWNER_PASSWORD APP_DB_PASSWORD AUTHENTIK_DB_PASSWORD \
         SESSION_SECRET AUTHENTIK_SECRET_KEY AUTHENTIK_BOOTSTRAP_TOKEN; do
  # hex for the DB passwords: they go into a connection URL, and base64
  # emits '/', which ends the URL's authority. The rest may be base64.
  case "$k" in
    *DB_PASSWORD) echo "$k=$(openssl rand -hex 32)" ;;
    *) echo "$k=$(openssl rand -base64 36 | tr -d '\n')" ;;
  esac
done
```

Set `PUBLIC_URL` to the URL users will actually visit. In production this
**must** be `https://` — the session cookie is only marked `Secure` when it is,
and the app logs a warning otherwise.

## 2. Start the stack

```bash
docker compose up -d db authentik-server authentik-worker
```

Authentik takes a minute or two on first boot while it migrates its database.

## 3. Create the OIDC application

```bash
export $(grep AUTHENTIK_BOOTSTRAP_TOKEN .env | xargs)
export PUBLIC_URL=$(grep '^PUBLIC_URL=' .env | cut -d= -f2)
node scripts/bootstrap-authentik.mjs
```

This waits for Authentik, creates the provider and application, and prints the
credentials. Paste the three `OIDC_*` lines into `.env`.

`OIDC_ISSUER` must be reachable **and identical** from two places: the user's
browser and the app container. In production both use the same public https
URL, so this is automatic. For a local HTTP stack, the compose file aliases the
browser-facing host into the container via `extra_hosts`.

## 4. Migrate and start the app

```bash
docker compose run --rm migrate
docker compose up -d app
```

Migrations run as a **separate admin credential** the app never holds. Re-run
`docker compose build migrate` after adding a migration, or the service will
use a cached image.

## 5. Create users

Open Authentik at `http://localhost:9000` (or your public URL) and sign in as
`akadmin` with `AUTHENTIK_BOOTSTRAP_PASSWORD`. **Change that password
immediately**, then create users under *Directory → Users*.

A habiterall account is provisioned automatically the first time someone signs
in. There is no separate registration step.

## 6. Put TLS in front

The app binds to `127.0.0.1:3100`. With Caddy:

```
habits.example.com {
  reverse_proxy 127.0.0.1:3100
}
auth.example.com {
  reverse_proxy 127.0.0.1:9000
}
```

Then set `PUBLIC_URL=https://habits.example.com` and
`OIDC_ISSUER=https://auth.example.com/application/o/habiterall/`, re-run the
bootstrap script so the redirect URI matches, and restart the app.

---

## Production checklist

- [ ] `PUBLIC_URL` and `OIDC_ISSUER` both use `https://`
- [ ] `ALLOW_INSECURE_OIDC` is unset or `false`
- [ ] Every secret in `.env` is unique and randomly generated
- [ ] The Authentik admin password has been changed from the bootstrap value
- [ ] `AUTHENTIK_BOOTSTRAP_TOKEN` removed from `.env` after setup
- [ ] Postgres is **not** published to the host (it is not, by default)
- [ ] Backups are scheduled *and a restore has been tested*
- [ ] `.env` is not committed (it is gitignored)

## Backups

```bash
docker compose exec -T db pg_dump -U habiterall_owner habiterall \
  | gzip > habiterall-$(date +%F).sql.gz
```

Back up the `authentik` database too, or you lose your user directory.

## Troubleshooting

**App restarts with `OAUTH_HTTP_REQUEST_FORBIDDEN`** — `OIDC_ISSUER` is
plaintext HTTP. Use https, or set `ALLOW_INSECURE_OIDC=true` for local testing
only.

**Login loops back to the sign-in page** — the session cookie is being
dropped. Check that `PUBLIC_URL` matches the address in the browser's bar
exactly, including scheme and port.

**`issuer mismatch` on callback** — the app container and the browser resolve
`OIDC_ISSUER` differently. They must see the same string.

**Migration says "already up to date" after adding a file** — rebuild the
image: `docker compose build migrate`.
