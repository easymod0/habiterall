/**
 * Provision the habiterall OIDC application in Authentik.
 *
 * Authentik has no declarative config for this in the free tier, so instead
 * of a click-through checklist we drive its API with the bootstrap token.
 * Safe to re-run: everything is looked up by slug/name first.
 *
 *   node scripts/bootstrap-authentik.mjs
 *
 * Prints the client id and secret to paste into .env.
 */

const BASE = process.env.AUTHENTIK_URL ?? 'http://localhost:9000';
const TOKEN = process.env.AUTHENTIK_BOOTSTRAP_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3100';
const SLUG = 'habiterall';

if (!TOKEN) {
  console.error('AUTHENTIK_BOOTSTRAP_TOKEN must be set (see .env)');
  process.exit(1);
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

/** Wait for Authentik to finish booting. */
async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      await api('/admin/version/');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Authentik did not become ready in time');
}

console.log(`waiting for Authentik at ${BASE} ...`);
await waitReady();
console.log('Authentik is up');

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
if (!authFlow) throw new Error('no authorization flow found in Authentik');
console.log(`using authorization flow: ${authFlow.slug}`);

const invFlows = await api('/flows/instances/?designation=invalidation');
const invalidationFlow =
  invFlows.results.find((f) => f.slug.includes('provider')) ?? invFlows.results[0];
if (!invalidationFlow) throw new Error('no invalidation flow found in Authentik');

/* ---- a signing key ---- */
const keys = await api('/crypto/certificatekeypairs/?has_key=true');
const signingKey = keys.results[0];
if (!signingKey) throw new Error('no signing keypair found in Authentik');

/* ---- scopes: openid, profile, email ---- */
const scopes = await api('/propertymappings/provider/scope/');
const wanted = ['openid', 'profile', 'email'];
const scopeIds = scopes.results
  .filter((s) => wanted.includes(s.scope_name))
  .map((s) => s.pk);

/* ---- provider ---- */
const existingProviders = await api(
  `/providers/oauth2/?name=${encodeURIComponent('habiterall')}`
);
let provider = existingProviders.results.find((p) => p.name === 'habiterall');

const providerBody = {
  name: 'habiterall',
  authorization_flow: authFlow.pk,
  invalidation_flow: invalidationFlow.pk,
  client_type: 'confidential',
  // Authentik derives the issuer from this slug.
  redirect_uris: [{ matching_mode: 'strict', url: `${PUBLIC_URL}/auth/callback` }],
  property_mappings: scopeIds,
  signing_key: signingKey.pk,
  sub_mode: 'hashed_user_id',
  include_claims_in_id_token: true,
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

/* ---- report the credentials ---- */
const full = await api(`/providers/oauth2/${provider.pk}/`);

console.log('\n--- paste these into habiterall-cloud/.env ---');
console.log(`OIDC_ISSUER=${BASE}/application/o/${SLUG}/`);
console.log(`OIDC_CLIENT_ID=${full.client_id}`);
console.log(`OIDC_CLIENT_SECRET=${full.client_secret}`);
console.log('---------------------------------------------\n');
console.log('Then: docker compose up -d app');
