# habiterall for Android

A **Trusted Web Activity** (TWA) wrapper: a thin native shell that renders the
PWA full-screen in Chrome's engine, with no browser UI and no address bar.

It ships the *same* code as the web app — there is no second implementation of
the scoring maths or the charts to drift out of sync. It works against either
edition, because their APIs are identical.

## What a TWA gives you over "Add to Home Screen"

- A Play Store listing, and an installable APK/AAB
- A real app icon, task-switcher entry, and splash screen
- No browser chrome at all (a plain PWA shortcut still shows a URL bar on some
  launchers)
- Android share-target and intent handling

## What it still does not give you

TWAs are the PWA, so the PWA's limits apply: **no home-screen widget** and
**no reliable scheduled reminders**. If you want Loop's widget or 8am
notifications, that needs a genuinely native client — see the note at the
bottom.

## Requirements

- Your instance served over **HTTPS** with a valid certificate. A TWA will not
  suppress the URL bar without it. `localhost` works for development only.
- A domain you control, to host the Digital Asset Links file.

## Build

The simplest path is Google's `bubblewrap`, which generates and signs the
project for you:

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://habits.example.com/shared/manifest.json
bubblewrap build
```

`twa-manifest.json` in this directory records the settings to use when
prompted. Point `host` at your own domain first.

## Verify the domain (removes the URL bar)

Bubblewrap prints an SHA-256 fingerprint of your signing key. Serve it from
your instance at:

```
https://habits.example.com/.well-known/assetlinks.json
```

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.example.habiterall",
    "sha256_cert_fingerprints": ["YOUR:FINGERPRINT:HERE"]
  }
}]
```

Both editions already serve `/.well-known/` — drop the file in
`habiterall-personal/public/.well-known/` or the cloud equivalent.

If the fingerprint does not match, the app still runs but shows a URL bar.
That is the single most common TWA problem.

## Pointing it at your instance

`host` in `twa-manifest.json` is baked in at build time. For the **personal**
edition on a LAN, build with your server's hostname (it still needs HTTPS —
a self-signed certificate will not verify, so use a real one via a reverse
proxy).

For **cloud**, use your public domain. Login works unchanged: the TWA shares
Chrome's cookie jar, so the existing OIDC session flow needs no modification.

## If you later want widgets and reminders

Keep this wrapper for the main UI and add a small native module alongside it,
or move to a fully native client. The server side is already prepared for
that: the API is stable, and the only work needed is accepting
`Authorization: Bearer` alongside cookie sessions.
