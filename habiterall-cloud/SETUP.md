# habiterall-cloud setup

The compose stack runs the app, its Postgres, and an
[Authentik](https://goauthentik.io) identity provider (server, worker), plus
two one-shot services that run to completion on every `up`: the schema
migrations, and the bootstrap that configures Authentik from `.env`. Only the
reverse proxy needs to face the internet.

## 1. Configure

```bash
cd habiterall-cloud
cp .env.example .env
```

Generate a distinct value for every secret:

```bash
for k in DB_OWNER_PASSWORD APP_DB_PASSWORD AUTHENTIK_DB_PASSWORD \
         SESSION_SECRET AUTHENTIK_SECRET_KEY AUTHENTIK_BOOTSTRAP_TOKEN \
         OIDC_CLIENT_ID OIDC_CLIENT_SECRET; do
  # hex for the DB passwords, and for the OIDC pair: those go into a
  # connection URL or an Authorization header, and base64 emits '/', which
  # ends a URL's authority. The rest may be base64.
  #
  # DB_OWNER_PASSWORD is named separately because it does NOT match
  # *DB_PASSWORD — it ends in OWNER_PASSWORD — and it is interpolated into
  # DATABASE_URL_ADMIN, so it is the one that most needs to be hex.
  case "$k" in
    DB_OWNER_PASSWORD|*DB_PASSWORD|OIDC_*) echo "$k=$(openssl rand -hex 32)" ;;
    *) echo "$k=$(openssl rand -base64 36 | tr -d '\n')" ;;
  esac
done
```

`OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are generated here rather than read
back out of Authentik afterwards: the bootstrap **sets** them on the provider,
so the app and the identity provider are configured from the same two lines
and nothing has to be pasted between them.

Set `PUBLIC_URL` to the URL users will actually visit. In production this
**must** be `https://` — the session cookie is only marked `Secure` when it is,
and the app logs a warning otherwise.

## 2. Start it

```bash
docker compose up -d
```

That is the whole of it. Compose starts the database, then Authentik and the
schema migrations alongside each other, then the bootstrap once Authentik's
containers have *started* — `condition: service_started`, not a healthcheck, so
the bootstrap script polls for readiness itself — and the app once both
one-shots have finished. A first boot takes a minute or two while Authentik
migrates its own database.

The bootstrap is `scripts/bootstrap-authentik.mjs`, and it creates the OIDC
provider and application, applies the self-registration setting, and applies
the branding. It is **idempotent and runs on every `up`**, which is also how
you apply a change: edit `.env`, `docker compose up -d`, done. It prints what
it configured:

```
--- habiterall OIDC application ---
OIDC_ISSUER=http://localhost:9000/application/o/habiterall/
OIDC_CLIENT_ID=…
```

Read it with `docker compose logs authentik-bootstrap`.

The app will not start until the bootstrap has succeeded, which is the trade
for having it configure everything: an Authentik that never comes up, or a
`.env` the bootstrap refuses, stops `up` rather than leaving an app running
that can log nobody in. Already-running containers are unaffected.

`OIDC_ISSUER` must be reachable **and identical** from two places: the user's
browser and the app container. In production both use the same public https
URL, so this is automatic. For a local HTTP stack, the compose file aliases the
browser-facing host into the container via `extra_hosts`.

Migrations run as a **separate admin credential** the app never holds. Re-run
`docker compose build migrate` after adding a migration, or the service will
use a cached image — and the same applies to `authentik-bootstrap` after
editing its script.

## 3. Accounts

Open Authentik at `http://localhost:9000` (or your public URL) and sign in as
`akadmin` with `AUTHENTIK_BOOTSTRAP_PASSWORD`. **Change that password
immediately.**

By default, accounts exist only where you create them, under *Directory →
Users*. A habiterall account is provisioned automatically the first time
someone signs in; there is no separate step for that.

### Letting people register themselves

```ini
AUTHENTIK_SELF_SIGNUP=on
```

then `docker compose up -d`. The login page grows a **Sign up** link, and
anyone who can reach it can create an account — on an instance exposed to the
internet, that is the internet. `off` removes the link *and* the sign-up page
behind it, so there is nothing to reach directly either.

**If this Authentik serves anything besides habiterall, read on.** The link
goes on the default login flow, which is the one every application on the
instance uses, and what a stranger creates is an *Authentik* account. It
reaches habiterall because habiterall admits anyone who signs in — and it
would reach any other application that admits any authenticated user. Bind a
group policy to those applications, or leave this off. The enrollment flow
also has no password policy and no CAPTCHA (Authentik's own example flows have
neither); *Customisation → Policies*, bound to the sign-up prompt stage, is
where those go.

Nothing is applied without `AUTHENTIK_BOOTSTRAP_TOKEN`. If you removed it per
the production checklist, a later `AUTHENTIK_SELF_SIGNUP=off` changes nothing:
registration stays open until you put the token back and run `up -d` again.
The bootstrap says which switches are inert every time it runs without the
token — it cannot tell you whether one of them now disagrees with Authentik,
because reading that back is what the token is for.

To make people prove the address first:

```ini
AUTHENTIK_SELF_SIGNUP_VERIFY_EMAIL=on
AUTHENTIK_EMAIL__HOST=smtp.example.com
AUTHENTIK_EMAIL__PORT=587
AUTHENTIK_EMAIL__USERNAME=…
AUTHENTIK_EMAIL__PASSWORD=…
AUTHENTIK_EMAIL__USE_TLS=true
AUTHENTIK_EMAIL__FROM=habiterall@example.com
```

The account is created switched off, and the link in the mail is what switches
it on — so **this needs a working SMTP server**. Without one, sign-ups stall at
"check your inbox" and never become accounts; the bootstrap warns when the
setting is on and no mail host is configured.

Both switches take `on`/`off` (`true`/`false`, `yes`/`no`, `1`/`0`,
`enabled`/`disabled`). Anything else stops the bootstrap rather than being
guessed at, because the guess that matters would be reading a typo as "let the
world in".

## 4. Put TLS in front

Compose publishes the app on `${APP_PORT:-3100}` and Authentik on
`${AUTHENTIK_PORT:-9000}`, and `BIND_ADDR` decides which interface they appear
on. It defaults to `0.0.0.0` — every interface — because browsing the app
directly from another machine is a perfectly ordinary way to run it.

That default is the wrong one the moment you put TLS in front. A reverse proxy
on this host only needs loopback, and while the port is also on the LAN the
proxy is something callers can step around by asking for `:3100` directly —
plain HTTP, no HSTS, and on cloud a session cookie that will not be marked
`Secure`. So for the deployment below, set:

```
BIND_ADDR=127.0.0.1
```

If the proxy runs on a *different* host, leave the default and firewall the two
ports to that host instead — binding to loopback would put the app out of the
proxy's reach as well as everyone else's.

With Caddy:

```
habits.example.com {
  reverse_proxy 127.0.0.1:3100
}
auth.example.com {
  reverse_proxy 127.0.0.1:9000
}
```

Then set `PUBLIC_URL=https://habits.example.com`,
`OIDC_ISSUER=https://auth.example.com/application/o/habiterall/` and
`AUTHENTIK_PUBLIC_URL=https://auth.example.com`, and run `docker compose up -d`
— the bootstrap re-registers the redirect URI to match.

## 5. Branding (optional)

The sign-in and sign-up pages carry habiterall's name, mark and colours out of
the box; `AUTHENTIK_BRANDING=off` stops that being managed. The page headings
and the backdrop are scoped to those pages, but the tab title, the favicon and
the accent colour are brand-wide settings and also reach Authentik's own admin
and user interfaces — cosmetic, and worth knowing before you meet it.

The two images are `../shared/public/icons/logo.svg` and
`branding/auth-background.svg`, mounted into the Authentik containers and
served by it. They are mounted as directories precisely so that replacing a
file takes effect on the next request, with nothing to restart.

---

## Production checklist

- [ ] `PUBLIC_URL` and `OIDC_ISSUER` both use `https://`
- [ ] `ALLOW_INSECURE_OIDC` is unset or `false`
- [ ] Every secret in `.env` is unique and randomly generated
- [ ] The Authentik admin password has been changed from the bootstrap value
- [ ] `AUTHENTIK_SELF_SIGNUP` is what you meant it to be — `on` means anyone
      who can reach the login page can create an account
- [ ] `AUTHENTIK_BOOTSTRAP_TOKEN` removed from `.env`, *if* you are done
      configuring: without it the bootstrap does nothing and says so, so the
      settings above stop taking effect (everything already applied stays)
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

**A changed `.env` did nothing** — the bootstrap only runs as part of `docker
compose up -d`, and only while `AUTHENTIK_BOOTSTRAP_TOKEN` is set. Check
`docker compose logs authentik-bootstrap`: with no token it names the switches
it cannot apply and exits 0, leaving Authentik exactly as it was.

**The app will not start** — look at `docker compose logs authentik-bootstrap`
first. `app` waits for it to succeed, so a refused `.env` value (a placeholder
client secret, a placeholder bootstrap token, a switch set to something that is
not yes or no) or an Authentik that never becomes ready stops the app too. The
failure is one line ending in the API status Authentik answered with.

**Sign-ups stop at "check your inbox"** — email verification is on and mail is
not being delivered. The bootstrap warns about a missing `AUTHENTIK_EMAIL__HOST`;
for a host that is set but wrong, the error is in
`docker compose logs authentik-worker`, which is what sends. The accounts are
real but inactive, under *Directory → Users*.

**Every sign-in fails with "The request is otherwise malformed"** — the OIDC
provider has no grant types. Re-run the bootstrap (`docker compose up -d`); it
sets `authorization_code` explicitly, because Authentik's own default for that
field is an empty list that permits nothing.
