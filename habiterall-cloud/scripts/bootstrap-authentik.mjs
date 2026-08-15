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
 * With OIDC_CLIENT_ID / OIDC_CLIENT_SECRET set, those are the credentials the
 * provider is given — the app and the IdP read the same two lines of .env and
 * nothing has to be pasted between them. Left empty, Authentik generates a
 * pair and this prints it.
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
const selfSignup = flag('AUTHENTIK_SELF_SIGNUP');
const verifyEmail = flag('AUTHENTIK_SELF_SIGNUP_VERIFY_EMAIL');
// On unless someone says otherwise: this Authentik exists to log people into
// habiterall, and its sign-in page saying so is the expected state.
const branding = flag('AUTHENTIK_BRANDING', true);

if (!TOKEN) {
  // Not an error: SETUP.md has you delete this token once the stack is up,
  // and compose runs this service on every `up`. Nothing to do without it,
  // and what was configured last time stands.
  console.log('AUTHENTIK_BOOTSTRAP_TOKEN is not set — leaving Authentik as it is.');
  process.exit(0);
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
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
  }
  return body;
};

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
  // Match on 'implicit-consent', NOT `includes('implicit')` — the *explicit*
  // flow is named "...authorization-explicit-consent", which contains
  // "implicit" as a substring of "explicit" and silently matched first.
  const authFlow =
    flows.results.find((f) => f.slug.includes('implicit-consent')) ??
    flows.results[0];
  if (!authFlow) throw new Error('no authorization flow yet');

  const invFlows = await api('/flows/instances/?designation=invalidation');
  const invalidationFlow =
    invFlows.results.find((f) => f.slug.includes('provider')) ?? invFlows.results[0];
  if (!invalidationFlow) throw new Error('no invalidation flow yet');

  /* ---- a signing key ---- */
  const keys = await api('/crypto/certificatekeypairs/?has_key=true');
  const signingKey = keys.results[0];
  if (!signingKey) throw new Error('no signing keypair yet');

  /* ---- scopes: openid, profile, email ---- */
  const scopes = await api('/propertymappings/provider/scope/');
  const wanted = ['openid', 'profile', 'email'];
  const scopeIds = scopes.results
    .filter((s) => wanted.includes(s.scope_name))
    .map((s) => s.pk);
  if (scopeIds.length !== wanted.length) throw new Error('the OIDC scopes are not all there yet');

  return { authFlow, invalidationFlow, signingKey, scopeIds };
}

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
  redirect_uris: [{ matching_mode: 'strict', url: `${PUBLIC_URL}/auth/callback` }],
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
  const stages = await api(
    '/stages/identification/?name=default-authentication-identification'
  );
  const stage = stages.results[0];
  if (!stage) throw new Error('the default identification stage is missing');

  let flowPk = null;
  if (selfSignup) {
    const found = await api('/flows/instances/?slug=habiterall-enrollment');
    flowPk = found.results[0]?.pk ?? null;
    if (!flowPk) throw new Error('the enrollment flow was not created');
  }

  if ((stage.enrollment_flow ?? null) === flowPk) return;
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
