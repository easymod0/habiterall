/**
 * Provision the habiterall OIDC application in Authentik, and apply the two
 * blueprints beside this file: self-service registration, and the branding
 * on the sign-in pages.
 *
 * Authentik has no declarative config for the OIDC application in the free
 * tier, so instead of a click-through checklist we drive its API with the
 * bootstrap token. Safe to re-run: everything is looked up by slug/name
 * first, which is why compose runs it on every `up` rather than once.
 *
 *   node scripts/bootstrap-authentik.mjs
 *
 * OIDC_CLIENT_ID / OIDC_CLIENT_SECRET are the credentials the provider is
 * GIVEN — the app and the IdP read the same two lines of .env and nothing has
 * to be pasted between them. There is no leave-them-empty path: compose
 * interpolates the whole file before it starts anything, and `app` declares
 * both `:?`, so an empty value fails `docker compose up` outright rather than
 * reaching this script.
 */

const BASE = process.env.AUTHENTIK_URL ?? 'http://localhost:9000';
const TOKEN = process.env.AUTHENTIK_BOOTSTRAP_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3100';
const SLUG = 'habiterall';

// Where the ISSUER lives, which is not always where the API lives: inside
// compose this script talks to `authentik-server:9000`, while the issuer has
// to be the string a browser sees. Falls back to the API base for a run from
// the host, where they are the same.
const ISSUER_BASE = (process.env.AUTHENTIK_PUBLIC_URL || BASE).replace(/\/+$/, '');

const SIGNUP_BLUEPRINT = 'custom/self-signup.yaml';
const BRANDING_BLUEPRINT = 'custom/branding.yaml';

/**
 * Where to put the files Authentik reads, when it is this container's job to
 * put them there.
 *
 * Two ways in, and they are for two different people. From a checkout,
 * compose bind-mounts the directories straight into the Authentik containers
 * and these are unset — editing a blueprint or an image then takes effect on
 * the next request, which is what you want while working on one. From the
 * PUBLISHED image there is no checkout to mount, so the files ride inside the
 * image and are copied into volumes the Authentik containers share; that is
 * what makes `docker compose up -d` on a bare server a complete install
 * rather than the first half of one.
 *
 * Either way Authentik sees the same paths, so the blueprints and their asset
 * URLs do not know which of the two happened.
 */
const COPY_TARGETS = [
  ['../blueprints', process.env.AUTHENTIK_BLUEPRINTS_OUT],
  ['../../shared/public/icons', process.env.AUTHENTIK_ICONS_OUT],
  ['../branding', process.env.AUTHENTIK_IMAGES_OUT],
];

/**
 * A yes/no from the environment, or an error. Deliberately strict: this
 * decides whether strangers can create accounts, and the blueprint it feeds
 * tests plain truthiness — so a typo silently reading as ON is the one
 * outcome worth refusing.
 */
const YES = new Set(['1', 'on', 'true', 'yes', 'enabled']);
const NO = new Set(['0', 'off', 'false', 'no', 'disabled']);
const flag = (name, fallback = false) => {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  if (YES.has(raw)) return true;
  if (NO.has(raw)) return false;
  throw new Error(`${name}=${process.env[name]} is not a yes/no value — use "on" or "off"`);
};

// Parsed before anything is created, so a bad value fails the run rather than
// leaving Authentik half configured.
//
// `flag` reaches the environment through a VARIABLE key, so nothing reading
// this file can see which variables these are — `shared/test/compose.test.js`
// walks the source to check every one is documented in a compose file, and a
// `process.env[name]` is where that walk goes blind. The marker below is what
// it reads instead, and it fails the build if a file does this and has none.
// Add the name here as well as calling `flag` with it.
//
// @env AUTHENTIK_SELF_SIGNUP AUTHENTIK_SELF_SIGNUP_VERIFY_EMAIL AUTHENTIK_BRANDING
const selfSignup = flag('AUTHENTIK_SELF_SIGNUP');
const verifyEmail = flag('AUTHENTIK_SELF_SIGNUP_VERIFY_EMAIL');
// On unless someone says otherwise: this Authentik exists to log people into
// habiterall, and its sign-in page saying so is the expected state.
const branding = flag('AUTHENTIK_BRANDING', true);

if (!TOKEN) {
  // Not an error: SETUP.md has you delete this token once the stack is up,
  // and compose runs this service on every `up`. Nothing to do without it,
  // and what was configured last time stands.
  //
  // Said plainly, and said every time. There WAS a warning here for the case
  // that matters — `AUTHENTIK_SELF_SIGNUP=off` reaching a bootstrap that
  // cannot apply it, so registration stays open — but it fired on every boot
  // instead: it tested whether the three switches were set, and both compose
  // files give all three a default, so they always are. Whether they still
  // describe Authentik is not knowable from here, because the only way to
  // read back what was applied is the API this token opens. A WARNING on
  // every `up` is one nobody reads by the time it means something, so this
  // states the fact and leaves the alarm to the operator's own memory —
  // which is what the production checklist is for.
  console.log(
    'AUTHENTIK_BOOTSTRAP_TOKEN is not set — Authentik keeps the configuration it ' +
      'already has. AUTHENTIK_SELF_SIGNUP, AUTHENTIK_SELF_SIGNUP_VERIFY_EMAIL and ' +
      'AUTHENTIK_BRANDING have no effect until the token is restored.'
  );
  process.exit(0);
}

// A published placeholder is not a secret. `.env.example` ships CHANGE_ME
// values like every other line in it, and unlike the rest these three are
// PUSHED onto the identity provider or ARE the credential that drives it — so
// an unedited file would hand out a client secret that is in the repository,
// and Authentik would turn the token line into a working admin API token for
// `akadmin` on every boot. Refused here rather than in compose, because this
// is the process that would use them. The token is checked after the block
// above deliberately: a deleted token is a supported way to run, a published
// one is not.
const PLACEHOLDERS = {
  OIDC_CLIENT_ID: 'openssl rand -hex 32',
  OIDC_CLIENT_SECRET: 'openssl rand -hex 32',
  AUTHENTIK_BOOTSTRAP_TOKEN: 'openssl rand -base64 36',
};
for (const [name, how] of Object.entries(PLACEHOLDERS)) {
  if ((process.env[name] ?? '').startsWith('CHANGE_ME')) {
    throw new Error(`${name} is still the placeholder from .env.example — generate one (${how})`);
  }
}

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE}/api/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await res.text();
  // Status first, body second. An error is not always JSON — a first boot, or
  // anything behind a reverse proxy, answers with an HTML 502 or 503 — and
  // parsing it first threw `SyntaxError: Unexpected token '<'` in place of the
  // line below, losing the status entirely. That line is the whole diagnostic
  // for the writes further down, and it is where SETUP.md's "the app will not
  // start" sends the operator.
  if (!res.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
};

const ID_STAGE = 'default-authentication-identification';
const ENROLLMENT_SLUG = 'habiterall-enrollment';

/**
 * The one object a filtered list was asked for, or null.
 *
 * Every lookup here re-checks the field it filtered on rather than taking
 * `results[0]`, because a server-side filter that stops filtering — a
 * filterset that loses a field across an Authentik upgrade, a name that no
 * longer matches — returns the whole list instead of nothing, and the first
 * row of it looks like an answer. The objects on the other end of these are
 * instance-wide and shared with every other application on it.
 */
const only = (list, field, value) => (list.results ?? []).find((o) => o[field] === value) ?? null;

/**
 * Everything the provider is assembled from, or an error saying which piece is
 * missing.
 *
 * All four are created by Authentik's OWN default blueprints, and it serves
 * its API before it has finished applying them — so on a first boot these are
 * absent for a while and this is the wait that matters. Waiting on
 * `/admin/version/` alone is what the script used to do, and it was enough
 * only because a human ran it minutes later; run by compose, it failed every
 * clean install with "no authorization flow found in Authentik".
 */
async function findPrerequisites() {
  /* ---- flows: one to authorise, one to invalidate (log out) ---- */
  const flows = await api('/flows/instances/?designation=authorization');

  // Prefer implicit consent: this is a first-party application, so making the
  // user approve it on every sign-in adds a click and no security.
  //
  // Named explicitly rather than taken as `results[0]`, because the viewset
  // orders by slug and "...authorization-explicit-consent" sorts BEFORE
  // "...-implicit-consent" — so the first result is the flow that asks.
  const authFlow =
    flows.results.find((f) => f.slug.includes('implicit-consent')) ??
    flows.results[0];
  if (!authFlow) throw new Error('no authorization flow yet');

  const invFlows = await api('/flows/instances/?designation=invalidation');
  const invalidationFlow =
    invFlows.results.find((f) => f.slug.includes('provider')) ?? invFlows.results[0];
  if (!invalidationFlow) throw new Error('no invalidation flow yet');

  // The login flow, and the stage that carries the "Sign up" link. Waited for
  // here rather than assumed later: linkSignupFlow() is the first thing to
  // need it and has no retry of its own, and Authentik's default blueprints
  // land in no particular order.
  const identification = only(
    await api(`/stages/identification/?name=${ID_STAGE}`), 'name', ID_STAGE
  );
  if (!identification) throw new Error('no default identification stage yet');

  /* ---- a signing key ---- */
  //
  // By NAME, not `results[0]`. That list is ordered by name and holds every
  // keypair the operator has ever imported, so a certificate called
  // `auth.example.com` — an ordinary thing to add for a reverse proxy — sorts
  // first and would silently become the key every id_token is signed with, on
  // an `up` that changed nothing else. Authentik's own generated keypair is
  // the one meant for this.
  const keys = await api('/crypto/certificatekeypairs/?has_key=true');
  const signingKey =
    keys.results.find((k) => k.name.startsWith('authentik Self-signed')) ?? keys.results[0];
  if (!signingKey) throw new Error('no signing keypair yet');

  /* ---- scopes: openid, profile, email ---- */
  //
  // Asked for one at a time. An unfiltered list is one page of 20 by default,
  // ordered by scope name, so an instance with its own scope mappings can
  // push these off the end — and this is a startup dependency, so failing to
  // find them stops the app from starting at all.
  const wanted = ['openid', 'profile', 'email'];
  const scopeIds = [];
  for (const scope of wanted) {
    const found = await api(`/propertymappings/provider/scope/?scope_name=${scope}`);
    const mapping = found.results.find((s) => s.scope_name === scope);
    if (!mapping) throw new Error(`the "${scope}" scope mapping is not there yet`);
    scopeIds.push(mapping.pk);
  }

  return { authFlow, invalidationFlow, identification, signingKey, scopeIds };
}

/**
 * Put the blueprints and the brand's images where Authentik will look, before
 * anything asks it to read them. A no-op unless the destinations are set.
 *
 * Every run overwrites what is there, because these are versioned artifacts
 * that ship INSIDE the image rather than configuration. With `force: false`
 * the first run's copies were the last ones: upgrading the image to a release
 * whose `self-signup.yaml` had gained a stage left the old file in the volume,
 * and this went on logging that it had published the blueprints while
 * `applyBlueprint` applied the previous release's forever. The copy cannot
 * tell an operator's edit from an older image's file, so it does not try — a
 * local change belongs in a bind mount, which is exactly what the compose
 * file in the repository does, or in a rebuilt image.
 */
async function publishFiles() {
  const { cp } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));

  for (const [from, to] of COPY_TARGETS) {
    if (!to) continue;
    await cp(join(here, from), to, { recursive: true, force: true });
    console.log(`published ${from.replace(/^\.\.\//, '')} -> ${to}`);
  }
}

await publishFiles();

console.log(`waiting for Authentik at ${BASE} ...`);
let ready = null;
for (let attempt = 1; !ready; attempt++) {
  try {
    ready = await findPrerequisites();
  } catch (err) {
    if (attempt >= 120) throw new Error(`Authentik never finished booting: ${err.message}`);
    if (attempt % 15 === 0) console.log(`  still waiting (${err.message})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const { authFlow, invalidationFlow, signingKey, scopeIds } = ready;
console.log(`signing key: ${signingKey.name}`);
console.log(`Authentik is up; using authorization flow: ${authFlow.slug}`);

/* ---- provider ---- */
const existingProviders = await api(
  `/providers/oauth2/?name=${encodeURIComponent('habiterall')}`
);
let provider = existingProviders.results.find((p) => p.name === 'habiterall');

const wantClientId = (process.env.OIDC_CLIENT_ID ?? '').trim();
const wantClientSecret = (process.env.OIDC_CLIENT_SECRET ?? '').trim();

const providerBody = {
  name: 'habiterall',
  authorization_flow: authFlow.pk,
  invalidation_flow: invalidationFlow.pk,
  client_type: 'confidential',
  // Explicit, because the field defaults to an EMPTY list and an empty list
  // permits nothing: a provider created without this looks completely
  // correct in the admin UI and rejects every sign-in at the authorize
  // endpoint with "Invalid grant_type for provider", which reaches the app as
  // "The request is otherwise malformed" and reaches the user as a 500 on
  // /auth/callback. Only this one — habiterall asks for no offline access and
  // never refreshes a token.
  grant_types: ['authorization_code'],
  // Authentik derives the issuer from this slug.
  //
  // TWO entries, and the second is not decoration. Authentik has no separate
  // post-logout field: `post_logout_redirect_uris` is a property over THIS list
  // filtered on a per-entry `redirect_uri_type`, which defaults to
  // `authorization`. With only the callback here that property is empty, and
  // `EndSessionView` gates its whole redirect block on it being non-empty — so
  // the `post_logout_redirect_uri` the app sends was discarded in silence and
  // signing out stopped on Authentik's own page instead of coming home.
  //
  // Built with `new URL` rather than interpolated. `PUBLIC_URL` is used raw
  // where `ISSUER_BASE` strips a trailing slash, so a `PUBLIC_URL` ending in `/`
  // registered `https://host//auth/callback` against the single-slash form the
  // app actually sends. Authentik compares these as exact strings, so both
  // sides have to build them the same way — and the logout entry, whose path is
  // a bare `/`, is where that would bite hardest.
  redirect_uris: [
    { matching_mode: 'strict', url: new URL('/auth/callback', PUBLIC_URL).href },
    {
      matching_mode: 'strict',
      url: new URL('/', PUBLIC_URL).href,
      redirect_uri_type: 'logout',
    },
  ],
  property_mappings: scopeIds,
  signing_key: signingKey.pk,
  sub_mode: 'hashed_user_id',
  include_claims_in_id_token: true,
  // Only when supplied. Omitting the keys is what lets Authentik generate a
  // pair on create and keep the existing one on update — sending empty
  // strings would instead wipe the credentials the app is running on.
  ...(wantClientId ? { client_id: wantClientId } : {}),
  ...(wantClientSecret ? { client_secret: wantClientSecret } : {}),
};

if (provider) {
  provider = await api(`/providers/oauth2/${provider.pk}/`, {
    method: 'PATCH', body: JSON.stringify(providerBody),
  });
  console.log('updated existing provider');
} else {
  provider = await api('/providers/oauth2/', {
    method: 'POST', body: JSON.stringify(providerBody),
  });
  console.log('created provider');
}

/* ---- application ---- */
const existingApps = await api(`/core/applications/?slug=${SLUG}`);
if (existingApps.results.length) {
  await api(`/core/applications/${SLUG}/`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'habiterall', slug: SLUG, provider: provider.pk }),
  });
  console.log('updated existing application');
} else {
  await api('/core/applications/', {
    method: 'POST',
    body: JSON.stringify({
      name: 'habiterall', slug: SLUG, provider: provider.pk,
      meta_description: 'Self-hosted habit tracker',
    }),
  });
  console.log('created application');
}

/* ---- self-service registration ---- */

/**
 * Apply one of the mounted blueprints with a context of our choosing.
 *
 * `import/` rather than a saved blueprint instance: it applies once, right
 * now, and answers with the importer's own logs, so a broken blueprint fails
 * this run instead of leaving a task to check on. It also means nothing in
 * Authentik re-applies the file behind our back with a context we did not
 * choose — which matters because an empty context means "signup off", and
 * discovery would supply exactly that.
 */
async function applyBlueprint(path, context) {
  const form = new FormData();
  form.set('path', path);
  form.set('context', JSON.stringify(context));

  const res = await fetch(`${BASE}/api/v3/managed/blueprints/import/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`blueprint import -> ${res.status} ${text}`);

  const body = JSON.parse(text);
  if (!body.success) {
    // Everything the importer logged is here, most of it routine chatter from
    // other requests that happened to overlap. The entry that failed is a
    // warning or worse.
    for (const log of body.logs ?? []) {
      if (log.log_level !== 'debug' && log.log_level !== 'info') {
        console.error(`  ${log.log_level}: ${log.event}`);
      }
    }
    throw new Error(`${path} failed to apply (see the log lines above)`);
  }
}

/**
 * The file listing the import endpoint validates `path` against is produced by
 * the WORKER, which boots alongside the server rather than before it. A retry
 * is cheaper than a healthcheck that would still be guessing.
 */
async function applyWithRetry(path, context) {
  for (let attempt = 1; ; attempt++) {
    try {
      await applyBlueprint(path, context);
      return;
    } catch (err) {
      if (attempt >= 10) throw err;
      console.log(`${path} not applied yet (${err.message}); retrying`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/**
 * Put the "Sign up" link on the login page, or take it away.
 *
 * This is one field on the login flow's identification stage, and it is here
 * rather than in the blueprint because that stage cannot be updated a field
 * at a time: its serializer re-validates "user fields or sources" against
 * whatever the request carries, so a partial update omitting `user_fields`
 * is rejected outright. Reading the stage first and sending it back with one
 * field changed is what keeps a customised login form customised.
 */
async function linkSignupFlow() {
  const stage = only(
    await api(`/stages/identification/?name=${ID_STAGE}`), 'name', ID_STAGE
  );
  if (!stage) throw new Error('the default identification stage is missing');
  const current = stage.enrollment_flow ?? null;

  if (!selfSignup) {
    // Clear the link only if it is OURS. This stage is shared with everything
    // else on the instance, and an operator may have pointed it at an
    // enrollment flow of their own — unlinking that on every `up`, silently,
    // is not what "self-signup off" asked for. Our own flow is deleted by the
    // blueprint anyway, and `enrollment_flow` is `on_delete=SET_DEFAULT`, so
    // by the time this runs the field is usually already null.
    if (current === null) return;
    const ours = only(
      await api(`/flows/instances/?slug=${ENROLLMENT_SLUG}`), 'slug', ENROLLMENT_SLUG
    );
    if (current !== (ours?.pk ?? null)) {
      console.log('leaving the sign-up link alone: it points at another flow');
      return;
    }
    await api(`/stages/identification/${stage.pk}/`, {
      method: 'PUT',
      body: JSON.stringify({ ...stage, enrollment_flow: null }),
    });
    return;
  }

  const found = only(
    await api(`/flows/instances/?slug=${ENROLLMENT_SLUG}`), 'slug', ENROLLMENT_SLUG
  );
  const flowPk = found?.pk ?? null;
  if (!flowPk) throw new Error('the enrollment flow was not created');
  if (current === flowPk) return;
  await api(`/stages/identification/${stage.pk}/`, {
    method: 'PUT',
    body: JSON.stringify({ ...stage, enrollment_flow: flowPk }),
  });
}

await applyWithRetry(SIGNUP_BLUEPRINT, { signup: selfSignup, verify_email: verifyEmail });
await linkSignupFlow();

/* ---- branding ---- */
if (branding) {
  // Authentik's API answers before Authentik has finished applying its own
  // default blueprints, and the default brand is one of the things they
  // create. Apply the branding before it exists and there is nothing to
  // brand — see the note on that entry.
  let brand = null;
  for (let attempt = 1; attempt <= 20 && !brand; attempt++) {
    brand = (await api('/core/brands/?domain=authentik-default')).results[0] ?? null;
    if (!brand) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!brand) {
    console.warn(
      'WARNING: the default Authentik brand has not appeared, so the sign-in ' +
        'page keeps its own branding. Re-run `docker compose up -d` once it has booted.'
    );
  }
  await applyWithRetry(BRANDING_BLUEPRINT, {});
  console.log(brand ? 'branding: habiterall' : 'branding: flow titles only');
} else {
  console.log('branding: not managed (AUTHENTIK_BRANDING is off)');
}

console.log(
  selfSignup
    ? `self-service registration: ON${verifyEmail ? ', email verified before the account works' : ', no verification'}`
    : 'self-service registration: OFF'
);

if (selfSignup && verifyEmail) {
  const host = (process.env.AUTHENTIK_EMAIL__HOST ?? '').trim();
  if (!host || host === 'localhost') {
    console.warn(
      'WARNING: email verification is on but AUTHENTIK_EMAIL__HOST is not set to a real ' +
        'SMTP server. Sign-ups will stall unconfirmed and the accounts stay inactive.'
    );
  }
}
if (!selfSignup && verifyEmail) {
  console.log('(AUTHENTIK_SELF_SIGNUP_VERIFY_EMAIL is set, but nobody can register.)');
}

/* ---- report the credentials ---- */
const full = await api(`/providers/oauth2/${provider.pk}/`);
const issuer = `${ISSUER_BASE}/application/o/${SLUG}/`;

console.log('\n--- habiterall OIDC application ---');
console.log(`OIDC_ISSUER=${issuer}`);
console.log(`OIDC_CLIENT_ID=${full.client_id}`);
if (wantClientSecret) {
  console.log('OIDC_CLIENT_SECRET=(the one already in .env — set on the provider)');
} else {
  // Only printed when it is the one thing the operator cannot get anywhere
  // else. Container logs outlive the terminal, so a secret they already hold
  // does not go into them a second time.
  console.log(`OIDC_CLIENT_SECRET=${full.client_secret}`);
}
console.log('-----------------------------------\n');

const configured = process.env.OIDC_ISSUER?.trim();
if (configured && configured !== issuer) {
  console.warn(
    `WARNING: OIDC_ISSUER in .env is ${configured}, but this provider issues ${issuer}. ` +
      'Token validation compares them byte for byte and will fail.'
  );
} else if (!wantClientId || !wantClientSecret) {
  console.log('Put the lines above into .env, then: docker compose up -d app');
}
