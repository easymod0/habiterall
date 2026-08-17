import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  CHANNELS, CHANNEL_IDS, CATCH_UP_MINUTES, DEFAULT_CHANNELS,
  answeredIds, callerDay, channelConfigured, discordPayload, dueReminders, enabledChannels,
  minutesOfDay, needsServerDelivery, ntfyAllowlist, ntfyAllowlistProblems,
  ntfyPayload, ntfyTarget,
  parseChannelList, parseDiscordWebhook, parseNtfyToken, parseNtfyUrl,
  parseTimeZone, reminderMessage, reportedZone, resolveTimeZone, serverChannels,
  zonedClock, AUTO_ZONE, DEVICE_ZONE_HEADER,
} = await import('../src/notify.js');

const { deliverAccount, postWebhook, resetSaid, runTick, sendToChannel, warnUnreachable } =
  await import('../src/notify-send.js');

const { parseSettings } = await import('../src/validate.js');

const { daysBetween } = await import('../src/stats.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A habit with a reminder, overridable per test. */
const habit = (over = {}) => ({
  id: 1, name: 'Meditate', description: '', type: 'boolean', unit: '',
  target_value: 0, target_type: 'at_least', freq_numerator: 1,
  freq_denominator: 1, color: '#3b82f6', reminder_time: '08:00',
  archived: false, ...over,
});

/** An instant, given as UTC parts. */
const utc = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi));

/* ---------- the registry and the UI must agree ---------- */

test('every channel offered in the UI is one the server knows', () => {
  // ui/settings.js declares what the dialog renders and notify.js declares
  // what the server delivers. A channel in one and not the other is either a
  // dead control or a destination nobody can switch on.
  // Anchored at column 0 with /m, so the literal that is read is the
  // DECLARATION. Unanchored, the regex takes the first match anywhere in the
  // file — and a JSDoc line quoting the correct list above a broken real
  // declaration would satisfy it while the module exported the wrong thing.
  // Nothing had done that; the hole was found by a review of the same pattern
  // copied one test down, and both are closed by the same anchor.
  const ui = readFileSync(join(root, 'public', 'ui', 'settings.js'), 'utf8');
  const block = /^const CHANNEL_OPTIONS = \[([\s\S]*?)\n\];/m.exec(ui);
  assert.ok(block, 'failed to find CHANNEL_OPTIONS in ui/settings.js');

  const offered = [...block[1].matchAll(/\{ value: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(offered, [...CHANNEL_IDS],
    'the UI channel list must match CHANNELS in shared/src/notify.js, in order');
});

test('the UI knows which destinations the DEVICE decides', () => {
  // A second mirror of the same registry, needing a pin for the same reason the
  // list above does: `shared/src` is not served, so the browser cannot read
  // `delivery` and has to restate it. `DEVICE_CHANNELS` gates `notifyTimezone`,
  // which names the clock the SERVER sends on — get it wrong and a preference
  // that governs nothing is offered in the very section where "why am I not
  // getting my reminders?" is answered.
  //
  // It shipped unpinned: mutating it to `['android']` left the whole unit run
  // green, and only a browser suite noticed, only in Chrome, only for `web`. A
  // third device destination added later would have been caught by nothing.
  // Anchored at column 0, for the reason the test above says: an indented
  // mention in a comment must not be able to answer for the declaration.
  const ui = readFileSync(join(root, 'public', 'ui', 'settings.js'), 'utf8');
  const block = /^const DEVICE_CHANNELS = \[([^\]]*)\];/m.exec(ui);
  assert.ok(block, 'failed to find DEVICE_CHANNELS in ui/settings.js');

  const listed = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const device = CHANNEL_IDS.filter((id) => CHANNELS[id].delivery === 'device');
  assert.ok(device.length > 0, 'no device-delivered channel in CHANNELS at all');
  assert.deepEqual(listed, device,
    'ui/settings.js must list exactly the channels CHANNELS marks '
    + "delivery: 'device', in registry order");
});

test('every channel declares how it is delivered', () => {
  for (const [id, channel] of Object.entries(CHANNELS)) {
    assert.ok(['device', 'server'].includes(channel.delivery),
      `${id} has no usable delivery`);
    assert.ok(Array.isArray(channel.configKeys), `${id} has no configKeys`);
  }
});

/* ---------- webhook URLs ---------- */

test('a real Discord webhook URL is accepted and canonicalised', () => {
  const url = 'https://discord.com/api/webhooks/123456789012345678/aB3-_xYz';
  assert.equal(parseDiscordWebhook(url), url);
  assert.equal(parseDiscordWebhook(`  ${url}  `), url);
  assert.equal(parseDiscordWebhook(`${url}?wait=true`), url,
    'the query string must be dropped, not stored for the server to fetch');
  assert.equal(parseDiscordWebhook(`${url}#frag`), url);
  assert.equal(
    parseDiscordWebhook('https://DISCORD.COM/api/webhooks/1/abc'),
    'https://discord.com/api/webhooks/1/abc'
  );
  assert.equal(
    parseDiscordWebhook('https://discord.com/api/v10/webhooks/1/abc'),
    'https://discord.com/api/v10/webhooks/1/abc'
  );
  assert.equal(parseDiscordWebhook('https://ptb.discord.com/api/webhooks/1/abc'),
    'https://ptb.discord.com/api/webhooks/1/abc');
  assert.equal(parseDiscordWebhook('https://discordapp.com/api/webhooks/1/abc'),
    'https://discordapp.com/api/webhooks/1/abc');
});

test('an empty webhook means "not configured", not an error', () => {
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(parseDiscordWebhook(blank), '');
  }
});

test('the webhook host allowlist closes off request forgery', () => {
  // The SERVER fetches this URL, so anything that is not Discord is a way to
  // aim it at the private network and read the result back as a status code.
  const hostile = [
    'http://discord.com/api/webhooks/1/abc',            // plaintext
    'https://169.254.169.254/api/webhooks/1/abc',       // cloud metadata
    'https://localhost/api/webhooks/1/abc',
    'https://127.0.0.1:5432/api/webhooks/1/abc',
    'https://10.0.0.5/api/webhooks/1/abc',
    'https://discord.com.evil.test/api/webhooks/1/abc', // the host as a PREFIX
    'https://evil.test/api/webhooks/1/abc',
    // ...and as a SUFFIX, which is the case a `host.endsWith(allowed)` check
    // lets through and a whole-host comparison does not. `notdiscord.com`
    // happens to have the same property; both are spelled out because the
    // ntfy guard next door needed the case added and this one only had it by
    // accident. Neither host is ours; both would be somebody's to register.
    'https://notdiscord.com/api/webhooks/1/abc',
    'https://evildiscord.com/api/webhooks/1/abc',
    'https://xdiscordapp.com/api/webhooks/1/abc',
    // An unlisted SUBDOMAIN of a listed host. The list is exact, and this is
    // the case that survives `endsWith('.' + allowed)` — the plausible-looking
    // relaxation, which is exactly why it is written down. Suffix matching is
    // done deliberately in one place only, `resumeTarget`, where the value is
    // regional and the regions are not enumerable.
    'https://evil.discord.com/api/webhooks/1/abc',
    'https://user:pass@discord.com/api/webhooks/1/abc', // credentials
    'file:///etc/passwd',
    'gopher://discord.com/api/webhooks/1/abc',
    'https://discord.com/api/webhooks/1/abc/../../admin', // path escape
    'https://discord.com/login',                         // right host, wrong path
    'javascript:alert(1)',
    'not a url at all',
    `https://discord.com/api/webhooks/1/${'a'.repeat(300)}`, // over the length cap
  ];
  for (const url of hostile) {
    assert.equal(parseDiscordWebhook(url), undefined, `accepted ${url}`);
  }
});

test('an embedded-credential URL cannot smuggle a host past the allowlist', () => {
  // The classic: everything before the last @ is userinfo, so the real host is
  // evil.test. Rejected for the host, not merely for the credentials.
  assert.equal(
    parseDiscordWebhook('https://discord.com@evil.test/api/webhooks/1/abc'),
    undefined
  );
});

/* ---------- ntfy topic URLs ---------- */

/** The operator has allowed nothing but the public service. */
const PUBLIC_NTFY = {};
/** ...one who runs their own, on a port. */
const OWN_NTFY = { NTFY_ALLOWED_HOSTS: 'ntfy.example.com,inside.example.com:8443' };
/** ...and one whose ntfy is reverse-proxied under a path on a shared host. */
const PROXIED_NTFY = { NTFY_ALLOWED_HOSTS: 'example.com/ntfy' };

test('a topic URL is accepted and canonicalised', () => {
  assert.equal(parseNtfyUrl('https://ntfy.sh/my-habits', PUBLIC_NTFY),
    'https://ntfy.sh/my-habits');
  assert.equal(parseNtfyUrl('  https://ntfy.sh/my-habits  ', PUBLIC_NTFY),
    'https://ntfy.sh/my-habits');
  assert.equal(parseNtfyUrl('https://NTFY.SH/my-habits', PUBLIC_NTFY),
    'https://ntfy.sh/my-habits');
  assert.equal(parseNtfyUrl('https://ntfy.sh/my-habits/', PUBLIC_NTFY),
    'https://ntfy.sh/my-habits', 'a pasted trailing slash is forgiven');
  assert.equal(parseNtfyUrl('https://ntfy.sh/my-habits?auth=abc', PUBLIC_NTFY),
    'https://ntfy.sh/my-habits',
    'the query string must be dropped, not stored for the server to fetch');
  assert.equal(parseNtfyUrl('https://ntfy.sh/my-habits#frag', PUBLIC_NTFY),
    'https://ntfy.sh/my-habits');
  // A reverse-proxied ntfy lives under a base path — one the OPERATOR named.
  assert.equal(parseNtfyUrl('https://example.com/ntfy/habits', PROXIED_NTFY),
    'https://example.com/ntfy/habits');
});

test('an empty topic URL means "not configured", not an error', () => {
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(parseNtfyUrl(blank, PUBLIC_NTFY), '');
  }
});

test('the ntfy URL guard closes off request forgery', () => {
  // The SERVER fetches this, so anything it will follow is somewhere it can be
  // aimed. There is no Discord-shaped host list to write here — the whole point
  // of ntfy is a self-hosted one — so the shape of the check is: https, a
  // destination the OPERATOR named, and exactly one topic segment after it.
  const hostile = [
    'http://ntfy.sh/habits',                       // plaintext, on an allowed host
    'http://169.254.169.254/habits',               // both at once
    'https://169.254.169.254/habits',              // cloud metadata
    'https://localhost/habits',
    'https://127.0.0.1:5432/habits',
    'https://10.0.0.5/habits',
    'https://ntfy.sh.evil.test/habits',            // the allowed host as a PREFIX
    'https://evilntfy.sh/habits',                  // ...and as a SUFFIX
    'https://xntfy.sh/habits',
    'https://evil.ntfy.sh/habits',                 // ...and as a SUBDOMAIN
    'https://evil.test/habits',
    'https://ntfy.sh:8443/habits',                 // a port the operator did not name
    'https://ntfy.sh./habits',                     // a trailing dot is a different host
    'https://user:pass@ntfy.sh/habits',            // credentials
    'https://ntfy.sh@evil.test/habits',            // the classic: the host is evil.test
    'file:///etc/passwd',
    'gopher://ntfy.sh/habits',
    'javascript:alert(1)',
    'https://ntfy.sh//habits',                     // an empty segment
    'https://ntfy.sh/a/b/c/d/e',
    'https://ntfy.sh/',                            // names no topic at all
    'https://ntfy.sh',
    'not a url at all',
    `https://ntfy.sh/${'a'.repeat(300)}`,          // over the length cap
  ];
  for (const url of hostile) {
    assert.equal(parseNtfyUrl(url, PUBLIC_NTFY), undefined, `accepted ${url}`);
  }

  // Traversal is not on that list, and stating why is the point: `new URL`
  // resolves `..` before this sees it, so what is checked and what is stored is
  // the RESOLVED path — one segment, on an allowed host, and therefore not an
  // escape from anything. What makes that safe is that the segment pattern has
  // no dots in it at all, so there is nothing to normalise AFTER the check.
  assert.equal(parseNtfyUrl('https://ntfy.sh/habits/../admin', PUBLIC_NTFY),
    'https://ntfy.sh/admin');
});

test('the operator names the base path, and a user may add ONE topic to it', () => {
  // The half that makes this equivalent to `parseDiscordWebhook` rather than
  // merely similar to it. That one pins the path, so allowlisting a host allows
  // one KIND of request; allowing any shallow path did not. With the
  // reverse-proxy deployment our own docs recommend,
  // `https://example.com/internal/admin/reset/x` used to be a JSON POST to
  // `https://example.com/internal/admin/reset/` — chosen title, chosen body,
  // chosen bearer token, and the status handed back to the user as prose.
  assert.equal(parseNtfyUrl('https://example.com/internal/admin/reset/x', PROXIED_NTFY),
    undefined, 'a base path the operator never named');
  assert.equal(parseNtfyUrl('https://example.com/api/v1/users/delete', PROXIED_NTFY),
    undefined);

  // A sibling of the named base is not the named base.
  assert.equal(parseNtfyUrl('https://example.com/other/habits', PROXIED_NTFY), undefined);
  // Nor is a deeper path under it: exactly one topic segment, no more.
  assert.equal(parseNtfyUrl('https://example.com/ntfy/deeper/habits', PROXIED_NTFY),
    undefined);
  // Nor is the base itself with nothing after it.
  assert.equal(parseNtfyUrl('https://example.com/ntfy', PROXIED_NTFY), undefined);
  // And an entry with no base path permits no base path at all.
  assert.equal(parseNtfyUrl('https://ntfy.sh/team/habits', PUBLIC_NTFY), undefined);

  // Whole segments, never a string prefix — `startsWith` would let this pass.
  assert.equal(parseNtfyUrl('https://example.com/ntfyadmin/habits', PROXIED_NTFY),
    undefined);
  assert.equal(parseNtfyUrl('https://example.com/ntfy-internal/habits', PROXIED_NTFY),
    undefined);

  // What the operator DID name works, and the stored URL is spelled with the
  // entry's own base path rather than the caller's — so the request goes to the
  // path the operator wrote and the caller's casing decides only the topic's.
  assert.equal(parseNtfyUrl('https://example.com/ntfy/habits', PROXIED_NTFY),
    'https://example.com/ntfy/habits');
  assert.equal(parseNtfyUrl('https://example.com/NTFY/Habits', PROXIED_NTFY),
    'https://example.com/ntfy/Habits');
  assert.equal(parseNtfyUrl('https://example.com/ntfy/habits/', PROXIED_NTFY),
    'https://example.com/ntfy/habits');
  // A deeper base, named as such, is allowed to be deep.
  assert.equal(
    parseNtfyUrl('https://example.com/a/b/c/topic', { NTFY_ALLOWED_HOSTS: 'example.com/a/b/c' }),
    'https://example.com/a/b/c/topic'
  );
});

test('which destinations are reachable is the OPERATOR\'s answer, not the user\'s', () => {
  // The difference from parseDiscordWebhook, and the reason this cannot be a
  // list in the source: the host that matters is the one running THIS ntfy.
  assert.equal(parseNtfyUrl('https://ntfy.example.com/habits', PUBLIC_NTFY), undefined,
    'an instance that has named nothing reaches the public service only');
  assert.equal(parseNtfyUrl('https://ntfy.example.com/habits', OWN_NTFY),
    'https://ntfy.example.com/habits');
  assert.equal(parseNtfyUrl('https://ntfy.sh/habits', OWN_NTFY), undefined,
    'naming your own REPLACES the default rather than adding to it');
  // A port is part of the decision: allowing a host must not allow every
  // service on it.
  assert.equal(parseNtfyUrl('https://inside.example.com:8443/habits', OWN_NTFY),
    'https://inside.example.com:8443/habits');
  assert.equal(parseNtfyUrl('https://inside.example.com/habits', OWN_NTFY), undefined);
  assert.equal(parseNtfyUrl('https://ntfy.example.com:8443/habits', OWN_NTFY), undefined);

  // ...and the whole destination can be refused for an instance.
  for (const off of ['off', 'OFF', ' off ']) {
    assert.equal(parseNtfyUrl('https://ntfy.sh/habits', { NTFY_ALLOWED_HOSTS: off }),
      undefined, `${off} should refuse every host`);
  }
  assert.deepEqual([...ntfyAllowlist(PUBLIC_NTFY)], ['ntfy.sh'],
    'the documented default is the public service and nothing else');
});

test('an allowlist entry nothing can be made of allows nothing, and says so', () => {
  // Every one of these fails CLOSED, which is the direction that has to be
  // pinned rather than assumed: a wildcard nobody implemented must not read as
  // one that works, and a scheme somebody pasted in must not become a hostname.
  const useless = [
    ',', ',,,', '*', '*.example.com', '.example.com', 'example.com.',
    'https://ntfy.sh', 'http://ntfy.sh', 'ntfy.sh:', 'ntfy.sh:not-a-port',
    'ntfy sh', 'ntfy.sh/../admin', 'ntfy.sh/a/b/c/d/e', '-ntfy.sh', 'ntfy..sh',
  ];
  for (const entry of useless) {
    assert.equal(parseNtfyUrl('https://ntfy.sh/habits', { NTFY_ALLOWED_HOSTS: entry }),
      undefined, `${entry} allowed something`);
    assert.deepEqual([...ntfyAllowlist({ NTFY_ALLOWED_HOSTS: entry })], [],
      `${entry} produced an entry`);
  }

  // ...and each is REPORTED, because dropping it in silence leaves a user's URL
  // snapping back to blank as the only surface for an operator's typo.
  assert.deepEqual(ntfyAllowlistProblems({ NTFY_ALLOWED_HOSTS: '*.example.com' }),
    ['*.example.com']);
  assert.deepEqual(
    ntfyAllowlistProblems({ NTFY_ALLOWED_HOSTS: 'ntfy.sh, *.example.com , https://x.test' }),
    ['*.example.com', 'https://x.test'],
    'a good entry beside two bad ones is not a reason to say nothing');
  // The two values that are not typos: unset (the ntfy.sh default) and `off`.
  assert.deepEqual(ntfyAllowlistProblems({}), []);
  assert.deepEqual(ntfyAllowlistProblems({ NTFY_ALLOWED_HOSTS: 'off' }), []);
  assert.deepEqual(ntfyAllowlistProblems({ NTFY_ALLOWED_HOSTS: 'ntfy.sh,,example.com/ntfy' }), [],
    'an empty entry between two commas is punctuation, not a mistake');

  // The one fail-OPEN case, deliberately: blank is the default, which is what
  // the shipped compose files interpolate when an operator leaves the template
  // line empty. Pinned here so changing it is a decision rather than a slip.
  assert.equal(parseNtfyUrl('https://ntfy.sh/habits', { NTFY_ALLOWED_HOSTS: '' }),
    'https://ntfy.sh/habits');
});

test('an ntfy token is bounded and cannot carry a header break', () => {
  assert.equal(parseNtfyToken('tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2'),
    'tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2');
  assert.equal(parseNtfyToken('  tk_abc  '), 'tk_abc');
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(parseNtfyToken(blank), '');
  }
  for (const bad of [
    'tk_abc\r\nX-Evil: 1',       // request splitting, into an Authorization header
    'tk_abc\nX-Evil: 1',
    'tk abc',                     // a space ends the credential
    'tk_é',                  // outside printable ASCII
    'tk_\u0000',             // a control byte is not a credential
    'a'.repeat(129),
  ]) {
    assert.equal(parseNtfyToken(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a topic URL is split into the endpoint to post to and the topic to name', () => {
  // ntfy publishes JSON to the SERVER, naming the topic in the body — posting
  // JSON to the topic URL would file the JSON itself as the message text.
  assert.deepEqual(ntfyTarget('https://ntfy.sh/habits', PUBLIC_NTFY),
    { endpoint: 'https://ntfy.sh/', topic: 'habits' });
  assert.deepEqual(ntfyTarget('https://example.com/ntfy/habits', PROXIED_NTFY),
    { endpoint: 'https://example.com/ntfy/', topic: 'habits' });
  assert.equal(ntfyTarget('https://evil.test/habits', PUBLIC_NTFY), null);
  assert.equal(ntfyTarget('https://example.com/other/habits', PROXIED_NTFY), null,
    'the endpoint this builds is always a base the operator named');
  assert.equal(ntfyTarget('', PUBLIC_NTFY), null);
});

test('ntfy is not interactive, and that is a decision', () => {
  // Its action buttons would fire HTTP AT THIS SERVER from a subscriber's
  // device, authorised by nothing but the request — the inbound endpoint
  // discord-gateway.js exists to avoid. Pinned so that turning it on is a
  // change somebody has to make deliberately.
  assert.equal(CHANNELS.ntfy.interactive, false);
  assert.equal(CHANNELS.ntfy.delivery, 'server');
  assert.deepEqual(CHANNELS.ntfy.configKeys, ['ntfyTopicUrl'],
    'the token is optional — a public topic needs none');
  assert.equal(channelConfigured('ntfy', {}), false);
  assert.equal(channelConfigured('ntfy', { ntfyTopicUrl: 'https://ntfy.sh/x' }), true);
});

test('the ntfy payload carries what the embed does, and no free text in a header', () => {
  const payload = ntfyPayload({
    habit: habit({ name: 'Meditate', description: 'ten minutes' }),
    message: reminderMessage(habit({ name: 'Meditate', description: 'ten minutes' })),
    topic: 'habits',
    date: '2026-08-13',
    appUrl: 'https://habits.example.com///',
  });
  assert.equal(payload.topic, 'habits');
  assert.equal(payload.title, 'Meditate');
  assert.match(payload.message, /ten minutes/);
  assert.match(payload.message, /2026-08-13/);
  assert.equal(payload.click, 'https://habits.example.com/');

  // Long values are clamped rather than rejected, as the Discord embed's are.
  const big = ntfyPayload({
    habit: habit({ name: 'n'.repeat(400), description: 'd'.repeat(9000) }),
    message: reminderMessage(habit({ name: 'n'.repeat(400) })),
    topic: 'habits',
  });
  assert.equal(big.title.length, 250);
  assert.ok(big.message.length <= 4000);
});

/* ---------- channel lists and time zones ---------- */

test('a channel list is normalised, not trusted', () => {
  assert.deepEqual(parseChannelList(['discord', 'android']), ['android', 'discord'],
    'stored in registry order so the value is canonical');
  assert.deepEqual(parseChannelList(['android', 'android']), ['android']);
  assert.deepEqual(parseChannelList([]), []);
  assert.deepEqual(parseChannelList(['android', 'telegram']), ['android'],
    'an unknown id is dropped so an older server tolerates a newer client');
  for (const bad of ['android', null, 42, { android: true }]) {
    assert.equal(parseChannelList(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
});

test('an account that has never touched the setting gets the defaults', () => {
  assert.deepEqual(enabledChannels({}), [...DEFAULT_CHANNELS]);
  assert.deepEqual(enabledChannels(), [...DEFAULT_CHANNELS]);
  // An explicit empty list is a choice, not an absence: it must not be
  // overwritten by the defaults, or "no notifications at all" is unreachable.
  assert.deepEqual(enabledChannels({ notifyChannels: [] }), []);
});

test('a channel is only ready when its configuration is filled in', () => {
  assert.equal(channelConfigured('android', {}), true, 'needs nothing');
  assert.equal(channelConfigured('discord', {}), false);
  assert.equal(channelConfigured('discord', { discordWebhook: '' }), false);
  assert.equal(channelConfigured('discord', { discordWebhook: 'x' }), true);
  assert.equal(channelConfigured('__proto__', {}), false,
    'a key from a request body must not resolve to Object.prototype');
});

test('the server only delivers for channels that are on, its own, and ready', () => {
  const url = 'https://discord.com/api/webhooks/1/abc';

  assert.deepEqual(serverChannels({ notifyChannels: ['android'], discordWebhook: url }), [],
    'the phone delivers its own alarms');
  assert.deepEqual(serverChannels({ notifyChannels: ['discord'] }), [],
    'enabled but unconfigured is not deliverable');
  assert.deepEqual(
    serverChannels({ notifyChannels: ['android', 'discord'], discordWebhook: url }),
    ['discord']
  );
  assert.equal(needsServerDelivery({ notifyChannels: ['android'] }), false);
  assert.equal(
    needsServerDelivery({ notifyChannels: ['discord'], discordWebhook: url }), true);
});

test('which clock a reminder is on: named beats device beats server', () => {
  // Three tiers, two of which the user sees. The precedence lives in exactly
  // one function so the tick and the Discord button handler cannot disagree
  // about which day it is for an account.
  assert.equal(resolveTimeZone({ notifyTimezone: 'Europe/Berlin' }, 'Pacific/Auckland'),
    'Europe/Berlin', 'a named zone always wins — this is "keep me on home time"');
  assert.equal(resolveTimeZone({ notifyTimezone: AUTO_ZONE }, 'Pacific/Auckland'),
    'Pacific/Auckland');
  assert.equal(resolveTimeZone({}, 'Pacific/Auckland'), 'Pacific/Auckland',
    'auto is the default, so an untouched account follows its device');
  assert.equal(resolveTimeZone({ notifyTimezone: AUTO_ZONE }, ''), '',
    'and falls back to the server when no client has ever reported one');

  // `''` keeps its old meaning: the server's clock, chosen deliberately. This
  // is the opt-out, and it must not be overridden by what a device says.
  assert.equal(resolveTimeZone({ notifyTimezone: '' }, 'Pacific/Auckland'), '',
    "an account that picked the server's clock is not followed anywhere");

  // A device value is re-validated here, not trusted: it arrives on a header.
  assert.equal(resolveTimeZone({}, 'Moon/Base'), '');
  assert.equal(resolveTimeZone({}, AUTO_ZONE), '',
    'a client echoing the setting back is an account asking itself');
});

test("the day a route judges by is the CALLER's, not the process's", () => {
  // A fixed instant, so this says something about the rule rather than about
  // the day it happens to be run on.
  const instant = Date.UTC(2026, 7, 16, 10, 0);

  assert.equal(callerDay('Pacific/Kiritimati', instant), '2026-08-17',
    'UTC+14 has already started the next day');
  assert.equal(callerDay('Etc/GMT+12', instant), '2026-08-15',
    'UTC-12 has not yet finished the previous one');

  // TWO calendar days apart, at one instant, between two real zone names —
  // and the same holds for inhabited ones (Pacific/Niue at UTC-11 against
  // Kiritimati at UTC+14 is 25 hours). This is why the fix is not "allow
  // tomorrow": a `today + 1` rule is still wrong at the edges, and it is
  // wrong in the permissive direction for every caller on Earth in between.
  assert.equal(
    daysBetween(callerDay('Etc/GMT+12', instant),
      callerDay('Pacific/Kiritimati', instant)), 2);
  assert.equal(
    daysBetween(callerDay('Pacific/Niue', instant),
      callerDay('Pacific/Kiritimati', instant)), 2);

  // A caller that reports nothing is one we cannot place, so it gets the
  // server's own clock — which is exactly what it got before this existed, so
  // adding the rule moves no caller's day. Anything unusable is the same
  // answer by the same reasoning, and `auto` is unusable here for the reason
  // `reportedZone` gives: it is the setting's word for "ask the device".
  const host = zonedClock(instant, '').date;
  for (const nothing of ['', undefined, null, 'auto', 'Moon/Base', 42]) {
    assert.equal(callerDay(nothing, instant), host,
      `placed a caller by ${JSON.stringify(nothing)}`);
  }
});

test('a reported zone is a header value, and is treated as one', () => {
  assert.equal(DEVICE_ZONE_HEADER, 'X-Habiterall-Timezone');
  assert.equal(reportedZone('Pacific/Auckland'), 'Pacific/Auckland');
  for (const junk of ['', undefined, null, 'auto', 'Moon/Base', 'x'.repeat(80), 42]) {
    assert.equal(reportedZone(junk), '', `accepted ${JSON.stringify(junk)}`);
  }
});

test('a zone Intl will not take does not end the tick', () => {
  // `new Intl.DateTimeFormat` throws RangeError for an unknown zone, and
  // `formatterFor` runs once per account INSIDE the tick — so one account with
  // an unusable value would have ended the pass for everyone. It can arrive by
  // a direct database edit, a restore, or ICU data changing under a downgrade.
  const noon = new Date(Date.UTC(2026, 7, 16, 12, 0));
  assert.equal(zonedClock(noon, 'Moon/Base').date, zonedClock(noon, '').date);
  assert.equal(zonedClock(noon, AUTO_ZONE).date, zonedClock(noon, '').date,
    'including `auto`, if it ever reaches here unresolved');
});

test('a time zone is validated by asking Intl, not by pattern', () => {
  assert.equal(parseTimeZone('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(parseTimeZone('UTC'), 'UTC');
  assert.equal(parseTimeZone(''), '');
  // Shaped like a zone, and not one. Storing it would throw inside the
  // notifier tick — on a schedule, for one user, where nobody sees it.
  assert.equal(parseTimeZone('Europe/Atlantis'), undefined);
  assert.equal(parseTimeZone('Not/A/Zone'), undefined);
  assert.equal(parseTimeZone('a'.repeat(200)), undefined);
});

test('a zone is normalised to its canonical name, whatever spelling arrived', () => {
  // Not tidiness — a BOUND. `formatterFor` caches a built formatter per key and
  // never evicts, and `callerDay` reads its key off a request header, so the
  // cache grows by whatever spellings a caller can mint. Intl matches
  // case-insensitively and resolves aliases, so one zone has thousands of
  // accepted spellings: 16,384 case variants of `America/New_York` measured at
  // 2.2MB retained after GC, unreclaimable for the life of the process.
  for (const spelling of ['america/new_york', 'AMERICA/NEW_YORK', 'AmErIcA/nEw_YoRk']) {
    assert.equal(parseTimeZone(spelling), 'America/New_York', spelling);
  }
  assert.equal(parseTimeZone('US/Eastern'), 'America/New_York', 'an alias resolves');
  assert.equal(parseTimeZone('Etc/UTC'), 'UTC');

  // And it reaches the day, or the bound would sit in front of a cache the
  // callers walk straight past.
  const instant = new Date(Date.UTC(2026, 7, 17, 3, 0));
  assert.equal(callerDay('pacific/kiritimati', instant), callerDay('Pacific/Kiritimati', instant));
});

test('an offset is not a zone name, and is refused', () => {
  // The other unbounded family — ~2,900 accepted spellings, none of them a
  // name — and a fixed offset does not observe DST, so a stored one would put
  // a reminder an hour out for half the year. Neither client can send one:
  // both report `resolvedOptions().timeZone`, which is always a name.
  for (const offset of ['+05:30', '+23:59', '-12:00', '+2359', '+00:00']) {
    assert.equal(parseTimeZone(offset), undefined, offset);
  }
  // `+23:59` is also the one that made CLAUDE.md's arithmetic wrong: the
  // guard's window is reasoned over UTC-12..UTC+14, and an offset zone let a
  // caller claim a day about two days ahead of it.
  assert.equal(reportedZone('+23:59'), '', 'so it never reaches the day either');

  // Named zones that merely look like offsets are untouched: these are real
  // IANA entries, and `Etc/GMT+12` is what the personal suite pins the west
  // side of the window with.
  assert.equal(parseTimeZone('Etc/GMT+12'), 'Etc/GMT+12');
  assert.equal(parseTimeZone('UTC'), 'UTC');
  assert.equal(parseTimeZone('GMT'), 'UTC');
});

/* ---------- the settings surface ---------- */

test('the notification settings go through the same validator as the rest', () => {
  const url = 'https://discord.com/api/webhooks/123/abc';
  const { accepted, rejected } = parseSettings({
    notifyChannels: ['discord', 'android'],
    discordWebhook: `${url}?wait=true`,
    notifyTimezone: 'America/Toronto',
  });

  assert.deepEqual(accepted, {
    notifyChannels: ['android', 'discord'],
    discordWebhook: url,
    notifyTimezone: 'America/Toronto',
  }, 'a normaliser stores what it returns, not what arrived');
  assert.deepEqual(rejected, []);
});

test('a rejected notification setting is dropped like any other bad value', () => {
  const { accepted, rejected } = parseSettings({
    discordWebhook: 'https://evil.test/api/webhooks/1/abc',
    notifyTimezone: 'Mars/Olympus',
    notifyChannels: 'android',
    dayOrder: 'newest-left',
  });
  assert.deepEqual(accepted, { dayOrder: 'newest-left' });
  assert.deepEqual(rejected.sort(),
    ['discordWebhook', 'notifyChannels', 'notifyTimezone']);
});

/* ---------- the clock ---------- */

test('the local clock is read in the account\'s own zone', () => {
  // 2026-08-13 23:30 UTC is already the 14th in Tokyo and still the 13th in
  // Toronto. Both the date and the minute-of-day have to follow the zone: the
  // date keys the "already sent" watermark.
  const instant = utc(2026, 8, 13, 23, 30);

  assert.deepEqual(zonedClock(instant, 'UTC'),
    { date: '2026-08-13', time: '23:30', minutes: 23 * 60 + 30 });
  assert.deepEqual(zonedClock(instant, 'Asia/Tokyo'),
    { date: '2026-08-14', time: '08:30', minutes: 8 * 60 + 30 });
  assert.deepEqual(zonedClock(instant, 'America/Toronto'),
    { date: '2026-08-13', time: '19:30', minutes: 19 * 60 + 30 });
});

test('midnight is hour 00, not hour 24', () => {
  // With `hour12: false` en-US resolves to the h24 cycle and formats midnight
  // as '24' — so a 00:00 reminder would be compared against 1440 minutes and
  // could never fire, while the date beside it stayed correct.
  const clock = zonedClock(utc(2026, 8, 13, 0, 0), 'UTC');
  assert.equal(clock.time, '00:00');
  assert.equal(clock.minutes, 0);
  assert.equal(clock.date, '2026-08-13');
});

test('a reminder keeps its wall time across a DST change', () => {
  // Toronto springs forward on 2026-03-08. 08:00 local is 13:00 UTC before and
  // 12:00 UTC after; computing in UTC offsets would drift the reminder by an
  // hour for half the year.
  const before = zonedClock(utc(2026, 3, 7, 13, 0), 'America/Toronto');
  const after = zonedClock(utc(2026, 3, 9, 12, 0), 'America/Toronto');
  assert.equal(before.time, '08:00');
  assert.equal(after.time, '08:00');
});

test('minutesOfDay only accepts a real HH:MM', () => {
  assert.equal(minutesOfDay('00:00'), 0);
  assert.equal(minutesOfDay('08:30'), 510);
  assert.equal(minutesOfDay('23:59'), 1439);
  for (const bad of ['', '8:30', '24:00', '23:60', 'ab:cd', null, undefined, '08:30:00']) {
    assert.equal(minutesOfDay(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

/* ---------- what is due ---------- */

const dueAt = (isoUtc, over = {}, args = {}) => dueReminders({
  habits: [habit(over)],
  instant: new Date(isoUtc),
  timeZone: 'UTC',
  ...args,
});

test('a reminder fires in its own minute', () => {
  const due = dueAt('2026-08-13T08:00:00Z');
  assert.equal(due.length, 1);
  assert.deepEqual(
    { date: due[0].date, time: due[0].time },
    { date: '2026-08-13', time: '08:00' }
  );
});

test('a reminder does not fire before its time', () => {
  assert.deepEqual(dueAt('2026-08-13T07:59:00Z'), []);
});

test('a missed reminder is caught up, but only briefly', () => {
  // The server may have been restarting. Half an hour late is still useful;
  // six hours late is a lie, and waking up after a day of downtime must not
  // fire a day of reminders at once.
  assert.equal(dueAt(`2026-08-13T08:${String(CATCH_UP_MINUTES).padStart(2, '0')}:00Z`).length, 1);
  assert.equal(dueAt('2026-08-13T08:31:00Z').length, 0);
  assert.equal(dueAt('2026-08-13T14:00:00Z').length, 0);
});

test('a reminder whose window straddles midnight is dropped, not re-dated', () => {
  // 23:50 with the next tick at 00:05 the following day. Sending it then would
  // file it under tomorrow's date — misreporting the day AND consuming
  // tomorrow's slot, so tomorrow's real reminder would never go.
  const late = habit({ reminder_time: '23:50' });
  assert.equal(dueReminders({
    habits: [late], instant: new Date('2026-08-14T00:05:00Z'), timeZone: 'UTC',
  }).length, 0);
  assert.equal(dueReminders({
    habits: [late], instant: new Date('2026-08-13T23:55:00Z'), timeZone: 'UTC',
  }).length, 1);
});

test('habits without a reminder, or archived, are never due', () => {
  assert.deepEqual(dueAt('2026-08-13T08:00:00Z', { reminder_time: '' }), []);
  assert.deepEqual(dueAt('2026-08-13T08:00:00Z', { archived: true }), []);
});

test('every reason a reminder is not sent reports itself', () => {
  // Six conditions decide this and none is visible from outside, so a reminder
  // that does not arrive looks identical to a broken webhook — which sends
  // people to check the part that is working. `too_late` is the one nobody
  // guesses: a time already past on the server's clock is not late, it is gone
  // until tomorrow, and that is what an unset container timezone produces.
  const reasons = (instant, over = {}, extra = {}) => {
    const seen = [];
    dueReminders({
      habits: [habit(over)], instant: new Date(instant), timeZone: 'UTC',
      onSkip: (h, reason, detail) => seen.push({ reason, ...detail }),
      ...extra,
    });
    return seen;
  };

  assert.deepEqual(reasons('2026-08-13T08:00:00Z'), [], 'a due reminder is not a skip');

  assert.equal(reasons('2026-08-13T08:00:00Z', { archived: true })[0].reason, 'archived');
  assert.equal(reasons('2026-08-13T08:00:00Z', { reminder_time: '' })[0].reason,
    'no_reminder_time');

  const early = reasons('2026-08-13T07:30:00Z')[0];
  assert.deepEqual(
    { reason: early.reason, at: early.at, in_minutes: early.in_minutes },
    { reason: 'not_yet', at: '08:00', in_minutes: 30 }
  );

  const late = reasons('2026-08-13T20:23:00Z')[0];
  assert.deepEqual(
    { reason: late.reason, late_minutes: late.late_minutes, catch_up: late.catch_up },
    { reason: 'too_late', late_minutes: 743, catch_up: CATCH_UP_MINUTES }
  );

  assert.equal(
    reasons('2026-08-13T08:00:00Z', {}, { doneToday: new Set([1]) })[0].reason,
    'done_today');
  assert.equal(
    reasons('2026-08-13T08:00:00Z', {}, { alreadySent: () => true })[0].reason,
    'already_sent');

  // Both of those are asked before lateness, and that ordering is what makes
  // `too_late` mean a reminder was lost: at 20:23 the window is long closed for
  // every habit, including the one whose reminder went out on time at 08:00.
  assert.equal(
    reasons('2026-08-13T20:23:00Z', {}, { alreadySent: () => true })[0].reason,
    'already_sent');
  assert.equal(
    reasons('2026-08-13T20:23:00Z', {}, { doneToday: new Set([1]) })[0].reason,
    'done_today');

  // The clock it judged against, on every skip — the field that makes a
  // timezone mistake self-evident instead of a hypothesis.
  assert.deepEqual(
    { now: late.now, date: late.date, zone: late.zone },
    { now: '20:23', date: '2026-08-13', zone: 'UTC' }
  );
});

test('a habit already done today is not nagged', () => {
  const done = dueAt('2026-08-13T08:00:00Z', {}, { doneToday: new Set([1]) });
  assert.deepEqual(done, []);
});

test('a reminder already sent today is not sent again', () => {
  const args = { alreadySent: (id, date) => id === 1 && date === '2026-08-13' };
  assert.deepEqual(dueAt('2026-08-13T08:00:00Z', {}, args), []);
  // The next day is a different key, so it fires again.
  assert.equal(dueAt('2026-08-14T08:00:00Z', {}, args).length, 1);
});

test('the due date follows the user\'s zone, not the server\'s', () => {
  // 08:00 in Tokyo on the 14th is 23:00 UTC on the 13th. A watermark written
  // under the UTC date would be the wrong day for this user.
  const due = dueReminders({
    habits: [habit()],
    instant: utc(2026, 8, 13, 23, 0),
    timeZone: 'Asia/Tokyo',
  });
  assert.equal(due.length, 1);
  assert.equal(due[0].date, '2026-08-14');
});

test('answeredIds asks isCompleted, so a numerical 3 is an amount', () => {
  const habits = [
    habit({ id: 1, type: 'boolean' }),
    habit({ id: 2, type: 'numerical', target_value: 3, target_type: 'at_least' }),
    habit({ id: 3, type: 'numerical', target_value: 3, target_type: 'at_least' }),
    habit({ id: 4, type: 'numerical', target_value: 8, target_type: 'at_least' }),
    habit({ id: 5, type: 'boolean' }),
  ];
  const done = answeredIds(habits, [
    { habit_id: 1, value: 2, status: '' },     // a checkmark
    { habit_id: 2, value: 3, status: '' },     // three of something: done
    { habit_id: 3, value: 3, status: 'skip' }, // a skip that happens to hold 3
    { habit_id: 4, value: 3, status: '' },     // three of eight: not done
    { habit_id: 5, value: 0, status: '' },     // a 'no' kept alive by a note
  ]);
  // 3 is there because a skip is an ANSWER; 4 and 5 are not, because a partial
  // amount and an explicit 'no' are days that still deserve a nudge. Asking for
  // the merely *completed* ids nagged about every skipped day; asking whether a
  // row exists — which is what the phone used to do — silenced 4 and 5 too.
  assert.deepEqual([...done].sort(), [1, 2, 3]);
});

/* ---------- what it says ---------- */

test('the reminder text describes the goal it is reminding about', () => {
  assert.match(reminderMessage(habit()).body, /have you done this today/i);
  assert.match(
    reminderMessage(habit({ type: 'numerical', target_value: 8, unit: 'glasses' })).body,
    /at least 8 glasses/
  );
  assert.match(
    reminderMessage(habit({
      type: 'numerical', target_value: 2, target_type: 'at_most', unit: 'cigarettes',
    })).body,
    /at most 2 cigarettes/
  );
  assert.match(reminderMessage(habit(), { test: true }).body, /test notification/i);
});

test('a target is not scaled by 1000 — only entry values are', () => {
  // Scaling the target once turned "at most 2 times" into "at most 0.002".
  const body = reminderMessage(habit({
    type: 'numerical', target_value: 2, target_type: 'at_most', unit: '',
  })).body;
  assert.match(body, /at most 2\b/);
  assert.doesNotMatch(body, /0\.002/);
});

test('a Discord payload carries the habit, its colour, and no mentions', () => {
  const payload = discordPayload({
    habit: habit({ description: 'ten minutes' }),
    message: reminderMessage(habit()),
    date: '2026-08-13',
    appUrl: 'https://habits.example/',
  });

  const [embed] = payload.embeds;
  assert.equal(embed.title, 'Meditate');
  assert.equal(embed.color, 0x3b82f6);
  assert.equal(embed.footer.text, '2026-08-13');
  assert.equal(embed.url, 'https://habits.example/');
  assert.deepEqual(embed.fields, [{ name: 'Notes', value: 'ten minutes' }]);
  // A habit may be named '@everyone'. Embeds do not resolve mentions today,
  // but this is the guarantee rather than an accident of where the text sits.
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('a Discord payload omits what it does not know', () => {
  const payload = discordPayload({ habit: habit(), message: reminderMessage(habit()) });
  const [embed] = payload.embeds;
  assert.equal(embed.url, undefined, 'no invented link when no public URL is set');
  assert.equal(embed.fields, undefined);
  assert.equal(embed.footer, undefined);
});

test('the app link ends in exactly one slash, however many were configured', () => {
  const link = (appUrl) => discordPayload({
    habit: habit(), message: reminderMessage(habit()), appUrl,
  }).embeds[0].url;

  assert.equal(link('https://habits.example'), 'https://habits.example/');
  assert.equal(link('https://habits.example/'), 'https://habits.example/');
  assert.equal(link('https://habits.example///'), 'https://habits.example/');
  assert.equal(link('https://habits.example/app/'), 'https://habits.example/app/');
  assert.equal(link('ftp://habits.example'), undefined);

  // The regex this replaced was `/\/+$/`, unanchored at the start: on a run of
  // slashes with no match at the end, the engine retries from every one of them.
  const started = process.hrtime.bigint();
  link(`https://habits.example/${'/'.repeat(200_000)}x`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 500, `trailing-slash normalisation took ${ms}ms`);
});

test('an over-long name or note is truncated to Discord\'s limits', () => {
  const payload = discordPayload({
    habit: habit({ name: 'n'.repeat(400), description: 'd'.repeat(2000) }),
    message: reminderMessage(habit({ name: 'n'.repeat(400) })),
  });
  const [embed] = payload.embeds;
  assert.equal(embed.title.length, 256);
  assert.equal(embed.fields[0].value.length, 1024);
});

/* ---------- delivery ---------- */

/** A fetch stand-in that records what it was asked to do. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const doFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      headers: { get: (h) => next.headers?.[h.toLowerCase()] ?? null },
    };
  };
  doFetch.calls = calls;
  return doFetch;
}

test('a successful post reports ok', async () => {
  const fetch = fakeFetch([{ status: 204 }]);
  const result = await postWebhook('https://discord.com/api/webhooks/1/a', { x: 1 },
    { fetch });

  assert.deepEqual(result, { ok: true, status: 204 });
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].init.redirect, 'manual',
    'following a redirect would walk straight around the host allowlist');
  assert.deepEqual(fetch.calls[0].body, { x: 1 });
});

test('a deleted webhook is a permanent failure, not something to retry', async () => {
  for (const status of [401, 403, 404]) {
    const result = await postWebhook('https://discord.com/api/webhooks/1/a', {},
      { fetch: fakeFetch([{ status }]) });
    assert.equal(result.ok, false);
    assert.equal(result.permanent, true, `${status} should be permanent`);
  }
});

test('a 500 or a timeout is a retryable failure', async () => {
  const server = await postWebhook('https://discord.com/api/webhooks/1/a', {},
    { fetch: fakeFetch([{ status: 500 }]) });
  assert.equal(server.ok, false);
  assert.ok(!server.permanent);

  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const timeout = await postWebhook('https://discord.com/api/webhooks/1/a', {},
    { fetch: fakeFetch([aborted]) });
  assert.equal(timeout.ok, false);
  assert.ok(!timeout.permanent);
  assert.match(timeout.error, /no response within/);
});

test('a 429 reports how long Discord asked us to wait', async () => {
  const result = await postWebhook('https://discord.com/api/webhooks/1/a', {},
    { fetch: fakeFetch([{ status: 429, headers: { 'retry-after': '2.5' } }]) });
  assert.equal(result.ok, false);
  assert.equal(result.retryAfterMs, 2500);
});

test('a 429 with no advice still asks for a wait, not zero', async () => {
  // Zero would read as "no wait requested" and therefore as "do not retry",
  // turning a transient limit into a dropped reminder.
  for (const headers of [undefined, { 'retry-after': 'soon' }, { 'retry-after': '0' }]) {
    const result = await postWebhook('https://discord.com/api/webhooks/1/a', {},
      { fetch: fakeFetch([{ status: 429, headers }]) });
    assert.ok(result.retryAfterMs > 0, `${JSON.stringify(headers)} gave ${result.retryAfterMs}`);
  }
  // And an absurd one is capped rather than parking the tick for an hour.
  const capped = await postWebhook('https://discord.com/api/webhooks/1/a', {},
    { fetch: fakeFetch([{ status: 429, headers: { 'retry-after': '99999' } }]) });
  assert.equal(capped.retryAfterMs, 60_000);
});

test('a device channel is never posted anywhere', async () => {
  // Every one of them, taken from the registry rather than named: `web` joined
  // `android` here, and the next device destination joins it without anybody
  // remembering to add a line. `serverChannels` is what normally keeps these
  // out of `deliverAccount`; this is the backstop for a caller that names one
  // directly.
  const device = Object.keys(CHANNELS).filter((id) => CHANNELS[id].delivery === 'device');
  assert.ok(device.length >= 2, 'expected at least android and web');

  for (const channel of device) {
    const fetch = fakeFetch([{ status: 204 }]);
    const result = await sendToChannel(channel, { habit: habit(), settings: {} }, { fetch });
    assert.equal(result.ok, false, channel);
    assert.match(result.error, /delivered by the device/, channel);
    assert.equal(fetch.calls.length, 0, `${channel} was posted somewhere`);
  }
});

/* ---------- delivering to ntfy ---------- */

const ntfySettings = (over = {}) => ({
  notifyChannels: ['ntfy'],
  ntfyTopicUrl: 'https://ntfy.sh/my-habits',
  ...over,
});

const toNtfy = (fetch, settings = ntfySettings(), env = PUBLIC_NTFY, over = {}) =>
  sendToChannel('ntfy', { habit: habit(), settings, date: '2026-08-13', ...over },
    { fetch, env });

test('an ntfy reminder is published as JSON to the server, not as headers', async () => {
  const fetch = fakeFetch([{ status: 200 }]);
  const result = await toNtfy(fetch);

  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(fetch.calls[0].url, 'https://ntfy.sh/',
    'the JSON API posts to the server and names the topic in the body');
  assert.equal(fetch.calls[0].body.topic, 'my-habits');
  assert.equal(fetch.calls[0].body.title, 'Meditate');
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].init.redirect, 'manual',
    'a redirect is how an allowed host walks this request onto one that is not');

  // The whole reason for the JSON shape: a habit name is free text, and the
  // other way of publishing puts it in a `Title:` header.
  const headers = Object.entries(fetch.calls[0].init.headers);
  assert.ok(!headers.some(([, v]) => String(v).includes('Meditate')),
    'no habit text may reach a header');
  assert.ok(!headers.some(([k]) => k.toLowerCase() === 'authorization'),
    'a public topic sends no credential');
});

test('a token rides in the Authorization header, and only if it could', async () => {
  const fetch = fakeFetch([{ status: 200 }]);
  await toNtfy(fetch, ntfySettings({ ntfyToken: 'tk_secret' }));
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer tk_secret');

  // parseNtfyToken cannot let this through; a hand-edited settings row can, and
  // the sink is where a header break has to be stopped rather than trimmed.
  const split = fakeFetch([{ status: 200 }]);
  const result = await toNtfy(split, ntfySettings({ ntfyToken: 'tk\r\nX-Evil: 1' }));
  assert.equal(result.ok, false);
  assert.equal(result.permanent, true);
  assert.equal(split.calls.length, 0, 'nothing may be sent with an unusable token');
});

test('a URL the operator no longer allows is refused at the moment of sending', async () => {
  // The stored value was legal when it was saved: `NTFY_ALLOWED_HOSTS` is the
  // operator's and can be narrowed afterwards, so `parseNtfyUrl` at write time
  // is not the last word about what this process may connect to.
  const fetch = fakeFetch([{ status: 200 }]);
  const result = await toNtfy(fetch, ntfySettings(), OWN_NTFY);

  assert.equal(result.ok, false);
  assert.equal(fetch.calls.length, 0, 'no request may leave for a host that is not allowed');
  assert.equal(result.permanent, true,
    'nothing about this changes until a setting or the environment does');
  assert.match(result.error, /NTFY_ALLOWED_HOSTS/,
    'the sender says why, because that sentence is what the settings dialog shows');
});

test('ntfy failures are told apart, in ntfy\'s own words', async () => {
  for (const status of [401, 403, 404]) {
    const result = await toNtfy(fakeFetch([{ status }]));
    assert.equal(result.ok, false);
    assert.equal(result.permanent, true, `${status} should be permanent`);
    assert.ok(!/webhook/i.test(result.error),
      'the Discord sender\'s advice is for a thing an ntfy user does not have');
  }

  const server = await toNtfy(fakeFetch([{ status: 500 }]));
  assert.equal(server.ok, false);
  assert.ok(!server.permanent);
  assert.match(server.error, /ntfy returned 500/);

  const limited = await toNtfy(
    fakeFetch([{ status: 429, headers: { 'retry-after': '2.5' } }]));
  assert.equal(limited.retryAfterMs, 2500);
  assert.ok(!limited.permanent);

  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const timeout = await toNtfy(fakeFetch([aborted]));
  assert.equal(timeout.ok, false);
  assert.ok(!timeout.permanent);
  assert.match(timeout.error, /no response within/);
});

/* ---------- a whole tick ---------- */

const account = (over = {}) => ({
  id: 7,
  settings: {
    notifyChannels: ['android', 'discord'],
    discordWebhook: 'https://discord.com/api/webhooks/1/abc',
    notifyTimezone: 'UTC',
  },
  habits: [habit()],
  doneToday: new Set(),
  alreadySent: () => false,
  ...over,
});

test('a tick delivers what is due and records it', async () => {
  const marked = [];
  const fetch = fakeFetch([{ status: 204 }]);

  const result = await runTick({
    collect: () => [account()],
    mark: (acc, habitId, channel, date) => marked.push([acc.id, habitId, channel, date]),
    instant: utc(2026, 8, 13, 8, 0),
    fetch,
  });

  assert.deepEqual(result, { accounts: 1, sent: 1, failed: 0, skipped: {} });
  assert.deepEqual(marked, [[7, 1, 'discord', '2026-08-13']]);
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0].url, /^https:\/\/discord\.com\/api\/webhooks\//);
});

test('an allowlist entry that can never match is reported to the operator', async () => {
  // The only other surface for this typo is a user's topic URL snapping back to
  // blank, which reads as an app bug and is reported as one — while the person
  // who can fix it sees nothing at all.
  resetSaid();
  const warned = [];
  const ctx = {
    collect: () => [],
    mark: () => {},
    instant: utc(2026, 8, 13, 8, 0),
    env: { NTFY_ALLOWED_HOSTS: 'ntfy.sh,*.example.com' },
    log: { warn: (event, detail) => warned.push([event, detail]) },
  };

  await runTick(ctx);
  assert.deepEqual(warned.map(([event, d]) => [event, d.entry]),
    [['notify.ntfy_allowlist_unusable', '*.example.com']],
    'the good entry is not news and the bad one is');
  assert.match(warned[0][1].reason, /host\/base\/path/,
    'the line has to say what a usable entry looks like');

  // Once per process, not once a minute: this is a configuration, and it stays
  // wrong until somebody edits it.
  await runTick(ctx);
  assert.equal(warned.length, 1);
});

test('a second server destination is delivered, and watermarked, on its own', async () => {
  // `notify_log` is keyed on habit + channel + local date, so switching ntfy on
  // must not be silenced for its first day by the send that already went to
  // Discord. Adding a destination is exactly the case that key exists for, and
  // this is the first time there has been a second one to prove it with.
  const before = process.env.NTFY_ALLOWED_HOSTS;
  // The tick reaches `postNtfy` without a `deps.env`, which is the real path:
  // the allowlist comes from the process it is running in.
  process.env.NTFY_ALLOWED_HOSTS = 'ntfy.sh';
  try {
    const marked = [];
    const fetch = fakeFetch([{ status: 204 }]);
    const both = account({
      settings: {
        notifyChannels: ['android', 'discord', 'ntfy'],
        discordWebhook: 'https://discord.com/api/webhooks/1/abc',
        ntfyTopicUrl: 'https://ntfy.sh/my-habits',
        notifyTimezone: 'UTC',
      },
    });

    const result = await runTick({
      collect: () => [both],
      mark: (acc, habitId, channel, date) => marked.push([habitId, channel, date]),
      instant: utc(2026, 8, 13, 8, 0),
      fetch,
    });

    assert.deepEqual(result.sent, 2);
    assert.deepEqual(marked, [
      [1, 'discord', '2026-08-13'],
      [1, 'ntfy', '2026-08-13'],
    ]);
    assert.deepEqual(fetch.calls.map((c) => c.url),
      ['https://discord.com/api/webhooks/1/abc', 'https://ntfy.sh/']);
  } finally {
    if (before === undefined) delete process.env.NTFY_ALLOWED_HOSTS;
    else process.env.NTFY_ALLOWED_HOSTS = before;
  }
});

test('a collect that throws is named, not left to a printf', async () => {
  // The one outcome in this module that produced no `notify.*` event: a total
  // read failure fell out of `runTick` to `startNotifier`'s
  // `log.error('notify: tick failed:', err)`, which is the least greppable line
  // in the file. It still ends the tick — there is nothing to deliver — but it
  // says so in the same shape as everything else.
  const errors = [];
  const result = await runTick({
    collect: () => { throw new Error('pool timeout'); },
    mark: () => {},
    instant: utc(2026, 8, 13, 8, 0),
    log: { error: (event) => errors.push(event) },
  });

  assert.deepEqual(result, { accounts: 0, sent: 0, failed: 0, skipped: {} });
  assert.deepEqual(errors, ['notify.collect_failed']);
});

test('collect is handed the tick\'s own instant', async () => {
  // Not left to read its own clock: it has to resolve the user's local date to
  // answer "already sent today", and two clock reads either side of local
  // midnight would check yesterday's watermark against today's date.
  let seen;
  await runTick({
    collect: (instant) => { seen = instant; return []; },
    mark: () => {},
    instant: utc(2026, 8, 13, 8, 0),
  });
  assert.equal(Number(seen), Number(utc(2026, 8, 13, 8, 0)));
});

test('a failed send is not recorded, so the next tick retries it', async () => {
  const marked = [];
  const result = await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: (...args) => marked.push(args),
    fetch: fakeFetch([{ status: 500 }]),
    log: { warn: () => {} },
  });

  assert.deepEqual(result, { sent: 0, failed: 1, skipped: {} });
  assert.deepEqual(marked, [], 'a retryable failure must leave the slot open');
});

test('a permanently failed send IS recorded, so it is not retried all day', async () => {
  const marked = [];
  await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: (...args) => marked.push(args),
    fetch: fakeFetch([{ status: 404 }]),
    log: { warn: () => {} },
  });
  assert.equal(marked.length, 1, 'a deleted webhook will not start working before midnight');
});

test('a watermark that will not store does not abandon the account', async () => {
  // `mark` was the one storage call in the loop with nothing around it, beside a
  // `noteOutcome` that has had a try/catch since it was written — and on the
  // cloud side it opens its own pool connection per habit, so pool exhaustion
  // reaches it first. An exception unwound `deliverAccount` entirely: the habit
  // whose reminder had JUST been delivered took the two behind it down with it,
  // never attempted, and `runTick` reported `sent: 0` about a message the user
  // was looking at.
  const errors = [];
  const three = account({
    habits: [habit({ id: 1 }), habit({ id: 2 }), habit({ id: 3 })],
  });
  const fetch = fakeFetch([{ status: 204 }]);

  const result = await deliverAccount(three, {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => { throw new Error('pool timeout'); },
    fetch,
    log: { error: (event, fields) => errors.push([event, fields.habit]) },
  });

  assert.equal(fetch.calls.length, 3, 'every due habit is still attempted');
  assert.deepEqual(result, { sent: 3, failed: 0, skipped: {} },
    'and a delivered reminder is reported as delivered');
  // Loud, because the consequence outlives the tick: with no watermark the next
  // minute re-sends, for the whole catch-up window.
  assert.deepEqual(errors, [
    ['notify.watermark_not_stored', 1],
    ['notify.watermark_not_stored', 2],
    ['notify.watermark_not_stored', 3],
  ]);
});

test('a failure is written down where the user can see it', async () => {
  // The whole point: a deleted webhook was recorded as sent, logged at warn, and
  // that was the ONLY surface. Reminders stopped while the habit, its time and
  // the destination toggle all went on looking correct — and on a shared
  // instance the log is unreachable to the person it concerns.
  const outcomes = [];
  await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    recordOutcome: (acc, channel, outcome) => outcomes.push({ user: acc.id, channel, ...outcome }),
    fetch: fakeFetch([{ status: 404 }]),
    log: { warn: () => {} },
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, false);
  assert.equal(outcomes[0].channel, 'discord');
  assert.equal(outcomes[0].permanent, true);
  assert.equal(outcomes[0].date, '2026-08-13');
  // The sender's own words, not a second phrasing invented for the UI.
  assert.match(outcomes[0].error, /webhook/i);
});

test('an outcome is written when it CHANGES, not once per reminder', async () => {
  // Five habits failing at 08:00 is one piece of news, not five writes — and the
  // second through fifth say nothing the first did not.
  const outcomes = [];
  const ctx = {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    recordOutcome: (acc, channel, outcome) => outcomes.push({ channel, ok: outcome.ok }),
    log: { warn: () => {} },
  };
  const three = account({
    habits: [habit({ id: 1 }), habit({ id: 2 }), habit({ id: 3 })],
  });

  await deliverAccount(three, { ...ctx, fetch: fakeFetch([{ status: 404 }]) });
  assert.deepEqual(outcomes, [{ channel: 'discord', ok: false }]);

  // A tick that finds it still broken, for the same reason, has nothing new to
  // say. `delivered` carries the stored REASON and not just `ok`, so that the
  // reason changing IS news — the test below this one is why.
  const gone = {
    discord: {
      ok: false,
      status: 404,
      error: 'the webhook was deleted or is no longer accepted — create a new one',
      permanent: true,
    },
  };
  outcomes.length = 0;
  await deliverAccount({ ...three, delivered: gone },
    { ...ctx, fetch: fakeFetch([{ status: 404 }]) });
  assert.deepEqual(outcomes, [], 'the same failure was written twice');

  // ...and a success once it is fixed IS news, because it clears the notice the
  // user is being shown.
  outcomes.length = 0;
  await deliverAccount({ ...three, delivered: gone },
    { ...ctx, fetch: fakeFetch([{ status: 204 }]) });
  assert.deepEqual(outcomes, [{ channel: 'discord', ok: true }]);

  // A healthy instance writes to this table roughly never.
  outcomes.length = 0;
  await deliverAccount(
    { ...three, delivered: { discord: { ok: true, status: 204, error: undefined } } },
    { ...ctx, fetch: fakeFetch([{ status: 204 }]) });
  assert.deepEqual(outcomes, []);
});

test('a failure that changes its REASON is news, even though it is still a failure', async () => {
  // REGRESSION. Both a 500 and a deleted webhook are `ok: false`, so a change
  // test that compares only that wrote nothing for the second — and the user
  // was shown "webhook returned 500" indefinitely while the one actionable
  // sentence Discord gave us, "create a new one", never arrived. A softer
  // version of the exact silence this feature exists to end.
  const outcomes = [];
  const ctx = {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    recordOutcome: (_a, channel, outcome) => outcomes.push({ channel, ...outcome }),
    log: { warn: () => {} },
  };

  const wasFlaky = account({
    delivered: {
      discord: { ok: false, status: 500, error: 'webhook returned 500', permanent: false },
    },
  });
  await deliverAccount(wasFlaky, { ...ctx, fetch: fakeFetch([{ status: 404 }]) });

  assert.equal(outcomes.length, 1, 'the reason changed and was not written down');
  assert.equal(outcomes[0].permanent, true);
  assert.equal(outcomes[0].status, 404);
  assert.match(outcomes[0].error, /deleted|create a new one/i);
  // ...and the date moves with it, because what is stored is when THIS state
  // began — which is what the dialog's "not delivered since" reads from.
  assert.equal(outcomes[0].date, '2026-08-13');

  // The identical failure again says nothing new. This is the half that keeps
  // it from being a write per reminder, so it has to survive the fix above.
  outcomes.length = 0;
  const wasGone = account({
    delivered: {
      discord: {
        ok: false,
        status: 404,
        error: 'the webhook was deleted or is no longer accepted — create a new one',
        permanent: true,
      },
    },
  });
  await deliverAccount(wasGone, { ...ctx, fetch: fakeFetch([{ status: 404 }]) });
  assert.deepEqual(outcomes, [], 'the same failure was written twice');
});

test('one channel\'s verdict does not stand in for another\'s', async () => {
  // `delivered` is per channel and the comparison must be too, or a working
  // webhook would vouch for a broken bot. Two destinations, one of each.
  const outcomes = [];
  const both = account({
    settings: {
      notifyChannels: ['android', 'discord'],
      discordWebhook: 'https://discord.com/api/webhooks/1/abc',
      notifyTimezone: 'UTC',
    },
    delivered: { discord: { ok: true, status: 204 } },
  });

  await deliverAccount(both, {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    recordOutcome: (_a, channel, outcome) => outcomes.push({ channel, ok: outcome.ok }),
    fetch: fakeFetch([{ status: 404 }]),
    log: { warn: () => {} },
  });

  // Android is delivered by the phone and never reaches a send, so the only
  // verdict here is Discord's own.
  assert.deepEqual(outcomes, [{ channel: 'discord', ok: false }]);
});

test('failing to STORE an outcome does not fail the delivery', async () => {
  // This is a diagnostic bolted onto the send. The reminder has already gone
  // out (or already not); losing the note about it must not cost the reminder,
  // and must not take the rest of the tick's accounts down with it.
  const errors = [];
  const result = await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    recordOutcome: () => { throw new Error('storage gone'); },
    fetch: fakeFetch([{ status: 204 }]),
    log: { warn: () => {}, error: (msg) => errors.push(msg) },
  });

  assert.deepEqual(result, { sent: 1, failed: 0, skipped: {} });
  assert.deepEqual(errors, ['notify.outcome_not_stored']);
});

test('an edition that supplies no recordOutcome still delivers', async () => {
  // The adapter property is optional, and both editions had shipped without it.
  const result = await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    fetch: fakeFetch([{ status: 204 }]),
    log: { warn: () => {} },
  });
  assert.deepEqual(result, { sent: 1, failed: 0, skipped: {} });
});

test('a reminder lost to the catch-up window is a warning, once', async () => {
  // Every other skip is a normal outcome. This one means the reminder is GONE:
  // its minute passed while nothing was running, and it will not be retried
  // today. At debug it was indistinguishable from "not yet".
  const warned = [];
  const log = { debug: () => {}, warn: (msg, fields) => warned.push({ msg, ...fields }) };
  resetSaid();

  const ctx = {
    instant: utc(2026, 8, 13, 20, 23),   // 12 hours past an 08:00 reminder
    mark: () => {},
    fetch: fakeFetch([{ status: 204 }]),
    log,
  };

  const result = await deliverAccount(account(), ctx);
  assert.deepEqual(result.skipped, { too_late: 1 });
  assert.equal(warned.length, 1);
  assert.deepEqual(
    { msg: warned[0].msg, habit: warned[0].habit, date: warned[0].date, late: warned[0].late_minutes },
    { msg: 'notify.too_late', habit: 1, date: '2026-08-13', late: 743 }
  );

  // The condition holds for the rest of the day, and a tick a minute would make
  // it 1,400 lines about one loss.
  await deliverAccount(account(), ctx);
  assert.equal(warned.length, 1, 'the same loss was reported twice');

  // Tomorrow is a different loss.
  await deliverAccount(account(), { ...ctx, instant: utc(2026, 8, 14, 20, 23) });
  assert.equal(warned.length, 2);
});

test('a reminder that WAS delivered is not reported lost for the rest of the day', async () => {
  // The window closes half an hour after the reminder, so from 08:31 every tick
  // is looking at a habit whose time has passed — including the one that went out
  // at 08:00 exactly as it should have. Asked in the wrong order, that is a
  // warning per habit per channel every single healthy day, which leaves a real
  // loss indistinguishable from the whole fleet working.
  const warned = [];
  const log = { debug: () => {}, warn: (msg, fields) => warned.push({ msg, ...fields }) };
  const ctx = {
    instant: utc(2026, 8, 13, 20, 23),
    mark: () => {},
    fetch: fakeFetch([{ status: 204 }]),
    log,
  };

  resetSaid();
  const sent = await deliverAccount(account({ alreadySent: () => true }), ctx);
  assert.deepEqual(sent.skipped, { already_sent: 1 });
  assert.deepEqual(warned, [], 'a delivered reminder was reported as lost');

  // Answered rather than sent — the phone got there first, and the day is handled
  // however it was handled.
  resetSaid();
  const done = await deliverAccount(account({ doneToday: new Set([1]) }), ctx);
  assert.deepEqual(done.skipped, { done_today: 1 });
  assert.deepEqual(warned, [], 'an answered day was reported as lost');
});

test('a destination that can never deliver says so, rather than nothing', () => {
  // The silent state: enabled, so the user believes it is on; unconfigured, so
  // `needsServerDelivery` is false and the account is skipped before anything is
  // logged above debug. Every visible surface looks right.
  resetSaid();
  const warned = [];
  const log = { warn: (msg, fields) => warned.push({ msg, ...fields }) };

  const botOnly = { notifyChannels: ['discord'], discordChannelId: '123456789012345678' };

  // A channel id with no bot token on this instance — the recommended setup,
  // missing the one credential the user cannot supply themselves.
  assert.deepEqual(warnUnreachable({ id: 7, settings: botOnly }, { log }), ['discord']);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].msg, 'notify.unreachable');
  assert.match(warned[0].reason, /DISCORD_BOT_TOKEN/);

  assert.equal(warnUnreachable({ id: 7, settings: botOnly }, { log }).length, 1);
  assert.equal(warned.length, 1, 'a configuration does not change every minute');

  // The same settings on an instance that HAS a bot are reachable.
  resetSaid();
  assert.deepEqual(warnUnreachable({ id: 7, settings: botOnly }, { log, botToken: 't' }), []);
  assert.equal(warned.length, 1, 'nothing further to say');

  // Enabled with nothing filled in at all gets the general message.
  resetSaid();
  warnUnreachable({ id: 8, settings: { notifyChannels: ['discord'] } }, { log });
  assert.match(warned[1].reason, /nothing is configured/);

  // The device channel is never this server's business, however it is set up.
  resetSaid();
  assert.deepEqual(warnUnreachable({ id: 9, settings: { notifyChannels: ['android'] } }, { log }), []);
});

test('an account with no server destination costs no requests', async () => {
  const fetch = fakeFetch([{ status: 204 }]);
  const result = await deliverAccount(
    account({ settings: { notifyChannels: ['android'] } }),
    { instant: utc(2026, 8, 13, 8, 0), mark: () => {}, fetch }
  );
  assert.deepEqual(result, { sent: 0, failed: 0, skipped: {} });
  assert.equal(fetch.calls.length, 0);
});

test('one account\'s storage failure does not stop the others', async () => {
  const errors = [];
  const result = await runTick({
    collect: () => [
      account({ id: 1, alreadySent: () => { throw new Error('database gone'); } }),
      account({ id: 2 }),
    ],
    mark: () => {},
    instant: utc(2026, 8, 13, 8, 0),
    fetch: fakeFetch([{ status: 204 }]),
    log: { warn: () => {}, error: (...a) => errors.push(a) },
  });

  assert.equal(result.sent, 1, 'the second account still got its reminder');
  assert.equal(errors.length, 1);
});

test('the watermark is per channel, so a new destination is not silenced', async () => {
  // The phone handled this habit this morning, and Discord was switched on
  // afterwards. A watermark keyed on the habit alone would swallow the first
  // Discord reminder.
  const sent = new Set(['1:android']);
  const marked = [];
  await deliverAccount(
    account({ alreadySent: (id, channel) => sent.has(`${id}:${channel}`) }),
    {
      instant: utc(2026, 8, 13, 8, 0),
      mark: (...args) => marked.push(args),
      fetch: fakeFetch([{ status: 204 }]),
    }
  );
  assert.equal(marked.length, 1);
  assert.equal(marked[0][2], 'discord');
});

test('a rate-limited send waits the requested time and retries once', async () => {
  // Five habits due at 08:00 on one webhook is enough to trip Discord's limit.
  // Leaving it to the next tick would trip it again a minute later, so the wait
  // it asks for is honoured — once.
  const fetch = fakeFetch([
    { status: 429, headers: { 'retry-after': '0.01' } },
    { status: 204 },
  ]);
  const marked = [];
  const result = await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: (...args) => marked.push(args),
    fetch,
  });

  assert.deepEqual(result, { sent: 1, failed: 0, skipped: {} });
  assert.equal(fetch.calls.length, 2, 'the retry must actually be sent');
  assert.equal(marked.length, 1, 'and recorded once, not twice');
});

test('a second rate limit gives up rather than looping', async () => {
  const fetch = fakeFetch([{ status: 429, headers: { 'retry-after': '0.01' } }]);
  const result = await deliverAccount(account(), {
    instant: utc(2026, 8, 13, 8, 0),
    mark: () => {},
    fetch,
    log: { warn: () => {} },
  });

  assert.deepEqual(result, { sent: 0, failed: 1, skipped: {} });
  assert.equal(fetch.calls.length, 2);
});

/* ---------- a custom prompt per habit ---------- */

test('a custom prompt leads, and the habit name becomes the subtitle', () => {
  const message = reminderMessage(habit({ reminder_message: 'Did you exercise today?' }));
  assert.equal(message.title, 'Did you exercise today?');
  assert.equal(message.subtitle, 'Meditate',
    'a channel carrying several habits still has to say which one is asking');
  // The generated sentence is dropped: "have you done this today?" under
  // "Did you exercise today?" is the same question twice.
  assert.doesNotMatch(message.body, /have you done this today/i);
});

test('a measurable habit keeps its goal alongside a custom prompt', () => {
  const message = reminderMessage(habit({
    type: 'numerical', target_value: 8, unit: 'glasses',
    reminder_message: 'How many glasses of water so far?',
  }));
  assert.equal(message.title, 'How many glasses of water so far?');
  assert.match(message.body, /at least 8 glasses/);
});

test('no prompt behaves exactly as before', () => {
  const message = reminderMessage(habit({ reminder_message: '' }));
  assert.equal(message.title, 'Meditate');
  assert.equal(message.subtitle, '');
  assert.match(message.body, /have you done this today/i);
});

test('a blank-but-present prompt is not treated as one', () => {
  const message = reminderMessage(habit({ reminder_message: '   ' }));
  assert.equal(message.title, 'Meditate');
});

test('the Discord embed carries the prompt as its title', () => {
  const h = habit({ reminder_message: 'Did you exercise today?', description: '' });
  const payload = discordPayload({ habit: h, message: reminderMessage(h), date: '2026-08-13' });
  const [embed] = payload.embeds;
  assert.equal(embed.title, 'Did you exercise today?');
  assert.equal(embed.author.name, 'Meditate');
  assert.equal(embed.description, undefined, 'nothing to add for a yes/no habit');
});

test('a prompt at the limit is not truncated on the way out', () => {
  // LIMITS.reminderMessage is 200 and Discord's embed title cap is 256, so a
  // prompt the server accepted must always survive the send intact.
  const prompt = 'q'.repeat(200);
  const h = habit({ reminder_message: prompt });
  const payload = discordPayload({ habit: h, message: reminderMessage(h) });
  assert.equal(payload.embeds[0].title, prompt);
});
