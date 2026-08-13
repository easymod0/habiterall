# Building the APK

A signed APK, built in GitHub Actions and attached to a Release. Nothing needs
installing on your machine.

## One-time setup

### 1. Serve habiterall over HTTPS

A Trusted Web Activity needs a real certificate — self-signed will not do, and
plain HTTP additionally disables the service worker, so you would lose offline
support and the queued check-offs.

Any of these work:

```
# Caddy — gets and renews a certificate automatically
habits.example.com {
  reverse_proxy 127.0.0.1:3000     # 3100 for the cloud edition
}
```

- **Cloudflare Tunnel** — no open ports, no public IP needed
- **Tailscale Funnel** — same, if you already use Tailscale

For the cloud edition, also set `PUBLIC_URL=https://habits.example.com` in
`.env` and re-run the Authentik bootstrap so the redirect URI matches.

Check it from your phone's browser before going further. If the site does not
load there, the APK will not either.

### 2. Create a signing keystore

```bash
keytool -genkeypair -v -keystore android.keystore \
  -alias habiterall -keyalg RSA -keysize 2048 -validity 10000
```

**Keep this file.** Losing it means future APKs cannot install over an
existing one — users would have to uninstall first, losing nothing but the
convenience. It is gitignored; store a copy somewhere safe.

### 3. Add the repository secrets

Settings → Secrets and variables → Actions.

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 android.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password from step 2 |
| `ANDROID_KEY_ALIAS` | `habiterall` |
| `ANDROID_KEY_PASSWORD` | the key password from step 2 |

And one **variable** (not a secret):

| Variable | Value |
| --- | --- |
| `TWA_HOST` | `habits.example.com` — host only, no scheme or path |

### 4. Build once to obtain the fingerprint

Actions → **Android APK** → Run workflow.

The run summary prints the SHA-256 fingerprint of the signing key. It is also
recoverable at any time from the keystore itself:

```bash
keytool -list -v -keystore android.keystore -alias habiterall | grep SHA256
```

### 5. Publish the fingerprint so the URL bar disappears

```bash
node shared/scripts/make-assetlinks.mjs \
  --package com.example.habiterall \
  --fingerprint AA:BB:CC:...
```

That writes `shared/public/.well-known/assetlinks.json`, which both editions
serve immediately. Deploy, then confirm:

```bash
curl https://habits.example.com/.well-known/assetlinks.json
```

Without this the app still works — it just shows a URL bar across the top,
which is the most common TWA complaint and gives no error explaining itself.

## Releasing

```bash
git tag android-v1.0.0
git push origin android-v1.0.0
```

The workflow builds, signs, creates a GitHub Release, and attaches
`app-release-signed.apk`. The version name and code are derived from the tag,
so each release installs cleanly over the previous one.

Install on a phone by opening the release page and tapping the APK. Android
asks once for permission to install from that source.

## Troubleshooting

**A URL bar appears at the top.** Domain verification failed. The fingerprint
in `assetlinks.json` must match the key that actually signed the installed
APK. Re-check with `keytool -printcert -jarfile app-release-signed.apk`.

**"Cannot fetch .../shared/manifest.json".** The workflow checks this before
building. The site must be publicly reachable over HTTPS — a LAN-only address
will not work, because the runner fetches it from the internet.

**Offline does not work.** Service workers need a secure context. Confirm the
site is HTTPS and that `/sw.js` returns 200.

**App installs but shows a blank screen.** Usually a CSP problem on the cloud
edition. Check `worker-src` and `manifest-src` are `'self'` in
`habiterall-cloud/src/server.js`.

## Updating the app

The APK is a thin shell: it loads your site at run time. **Changes to the UI
need no new APK** — deploy the web app and the phone picks them up on next
launch (the service worker revalidates).

Rebuild the APK only when the icon, name, or wrapped host changes.
