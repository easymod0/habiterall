# habiterall for Android

A **Trusted Web Activity** (TWA): a thin native shell that renders the PWA
full-screen in Chrome's engine, with no browser UI.

It ships the *same* code as the web app — there is no second implementation of
the scoring maths or the charts to drift out of sync — and works against
either edition, because their APIs are identical.

## Status

Ready to build. Everything on the web side is done and verified:

- Installable PWA: manifest, service worker, offline write queue, 192/512/
  maskable icons
- `/.well-known/assetlinks.json` is served by **both** editions (outside the
  auth gate on cloud, since Google fetches it unauthenticated)
- `shared/scripts/make-assetlinks.mjs` generates that file from your key
- `twa-manifest.json` holds the wrapper settings

What is left needs decisions and credentials only you have — a domain, a TLS
certificate, and a signing key. See below.

## What a TWA gives you over "Add to Home Screen"

A Play Store listing, an installable APK/AAB, a real task-switcher entry and
splash screen, no browser chrome at all, and Android share-target handling.

## What it still does not give you

A TWA *is* the PWA, so the PWA's limits apply: **no home-screen widget** and
**no reliable scheduled reminders**. If you want Loop's widget or an 8am
notification, that needs a genuinely native client.

---

## Prerequisites

1. **HTTPS with a real certificate.** A TWA will not suppress the URL bar
   without it, and self-signed will not do. Put a reverse proxy in front —
   Caddy needs two lines:

   ```
   habits.example.com {
     reverse_proxy 127.0.0.1:3000     # or 3100 for the cloud edition
   }
   ```

2. **JDK 17+** and the **Android SDK**. `bubblewrap` will offer to download
   the SDK for you on first run.

   ```bash
   npm install -g @bubblewrap/cli
   ```

## Build

```bash
# 1. point the wrapper at your domain
#    edit android/twa-manifest.json: host, iconUrl, webManifestUrl, fullScopeUrl

# 2. generate the project (creates a keystore if you have none)
cd android
bubblewrap init --manifest https://habits.example.com/shared/manifest.json
bubblewrap build
```

`bubblewrap build` prints the SHA-256 fingerprint of the signing key.

## Verify the domain (this is what removes the URL bar)

```bash
node shared/scripts/make-assetlinks.mjs \
  --package com.example.habiterall \
  --fingerprint AA:BB:CC:...
```

That writes `shared/public/.well-known/assetlinks.json`, which both editions
serve immediately. Confirm it after deploying:

```bash
curl https://habits.example.com/.well-known/assetlinks.json
```

**If you use Play App Signing** (the default for new apps), Google re-signs
your upload, so the key on devices is *theirs*. Pass both fingerprints:

```bash
node shared/scripts/make-assetlinks.mjs --package com.example.habiterall \
  --fingerprint "UPLOAD:KEY:...,PLAY:SIGNING:KEY:..."
```

Copy the Play one from **Play Console → Setup → App integrity → App signing
key certificate**.

A mismatched fingerprint is the single most common TWA problem: the app runs
but shows a URL bar, with no error explaining why.

## Pointing it at your instance

`host` in `twa-manifest.json` is baked in at build time, so one APK talks to
one origin.

- **Personal edition on a LAN** — it still needs real HTTPS, so terminate TLS
  at a proxy with a certificate your devices trust.
- **Cloud edition** — use your public domain. Login needs no changes: the TWA
  shares Chrome's cookie jar, so the existing OIDC flow works as-is.

## Testing before you publish

```bash
bubblewrap install          # side-load onto a connected device
```

Check that: the URL bar is absent (verification worked), the app opens
offline after one online launch, and check-offs made in airplane mode sync
when connectivity returns.

## If you later want widgets and reminders

Keep this wrapper for the main UI and add a native module alongside it, or
move to a fully native client. The server side is already prepared: the API is
stable and identical across editions; the only work needed is accepting
`Authorization: Bearer` alongside cookie sessions.
