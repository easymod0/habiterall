import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  ACTIONS, answerText, encodeAction, parseAction, reminderComponents,
} = await import('../src/notify.js');

const {
  CALLBACK, INTERACTION, MAX_ANSWER_AGE_DAYS, amountModal, answeredUpdate,
  discordRequest, ephemeral, handleInteraction, postReminder,
} = await import('../src/discord.js');

const { FATAL_CLOSE_CODES, OP, connectGateway, resumeTarget } =
  await import('../src/discord-gateway.js');

const habit = (over = {}) => ({
  id: 7, name: 'Meditate', description: '', type: 'boolean', unit: '',
  target_value: 0, target_type: 'at_least', freq_numerator: 1,
  freq_denominator: 1, color: '#3b82f6', reminder_time: '08:00',
  reminder_message: '', archived: false, ...over,
});

/** A fetch stand-in that records calls. */
function fakeFetch(responses = [{ status: 204 }]) {
  const calls = [];
  const queue = [...responses];
  const doFetch = async (url, init) => {
    calls.push({ url, init, headers: init.headers, body: init.body && JSON.parse(init.body) });
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

/* ---------- what a button carries ---------- */

test('a button id round-trips', () => {
  const id = encodeAction({ habitId: 7, date: '2026-08-13', action: 'yes' });
  assert.equal(id, 'hab|7|2026-08-13|yes');
  assert.deepEqual(parseAction(id),
    { test: false, habitId: 7, date: '2026-08-13', action: 'yes' });
});

test('every action can be encoded, and fits Discord\'s 100-character id', () => {
  for (const action of ACTIONS) {
    const id = encodeAction({ habitId: 9_007_199_254_740_991, date: '2026-08-13', action });
    assert.ok(id.length <= 100, `${id} is ${id.length} characters`);
    assert.equal(parseAction(id)?.action, action);
  }
});

test('a test message\'s buttons are marked as such', () => {
  const id = encodeAction({ habitId: 0, date: '', action: 'yes', test: true });
  assert.equal(id, 'test|yes');
  assert.deepEqual(parseAction(id), { test: true, habitId: 0, date: '', action: 'yes' });
});

test('anything not ours is not parsed', () => {
  const foreign = [
    '', null, undefined, 'someotherbot|1|x', 'hab|1|2026-08-13',
    'hab|1|2026-08-13|yes|extra',
    'hab|0|2026-08-13|yes',            // habit ids start at 1
    'hab|-1|2026-08-13|yes',
    'hab|abc|2026-08-13|yes',
    'hab|1|13-08-2026|yes',            // not ISO
    'hab|1|2026-08-13|delete',         // not an action we offer
    'test|delete',
  ];
  for (const id of foreign) {
    assert.equal(parseAction(id), null, `parsed ${JSON.stringify(id)}`);
  }
});

test('a yes/no habit gets two buttons, a measurable one gets a box', () => {
  const [row] = reminderComponents(habit(), { date: '2026-08-13' });
  assert.equal(row.type, 1);
  assert.deepEqual(row.components.map((b) => b.label), ['Yes', 'No']);

  const [numeric] = reminderComponents(habit({ type: 'numerical' }), { date: '2026-08-13' });
  assert.deepEqual(numeric.components.map((b) => b.label), ['Enter amount']);
  // There is no button that can mean "6", so the first one opens a modal.
  assert.equal(parseAction(numeric.components[0].custom_id).action, 'amount');
});

test('Skip is offered only when the account uses skip days', () => {
  // The setting has to reach every surface that can record one, or it hides the
  // step from the two clients with a grid while the shade goes on offering it.
  const opts = { date: '2026-08-13', skipDays: true };
  const [row] = reminderComponents(habit(), opts);
  assert.deepEqual(row.components.map((b) => b.label), ['Yes', 'No', 'Skip']);
  assert.equal(parseAction(row.components[2].custom_id).action, 'skip');

  const [numeric] = reminderComponents(habit({ type: 'numerical' }), opts);
  assert.deepEqual(numeric.components.map((b) => b.label), ['Enter amount', 'Skip']);
});

test('an answer reads back as what was recorded', () => {
  assert.equal(answerText(habit(), { action: 'yes' }), 'Done');
  assert.equal(answerText(habit(), { action: 'no' }), 'Not done');
  assert.equal(answerText(habit(), { action: 'skip' }), 'Skipped');
  assert.equal(answerText(habit({ unit: 'glasses' }), { action: 'amount', value: 6 }),
    '6 glasses');
  assert.equal(answerText(habit({ unit: '' }), { action: 'amount', value: 6 }), '6');
});

/* ---------- posting as a bot ---------- */

test('a bot message carries the buttons and the token', async () => {
  const fetch = fakeFetch();
  const result = await postReminder({
    token: 'bot-token', channelId: '123456789012345678',
    habit: habit({ reminder_message: 'Did you exercise today?' }),
    date: '2026-08-13',
    skipDays: true,
  }, { fetch });

  assert.equal(result.ok, true);
  const call = fetch.calls[0];
  assert.equal(call.url, 'https://discord.com/api/v10/channels/123456789012345678/messages');
  assert.equal(call.headers.Authorization, 'Bot bot-token');
  assert.equal(call.body.embeds[0].title, 'Did you exercise today?');
  assert.deepEqual(call.body.components[0].components.map((b) => b.label),
    ['Yes', 'No', 'Skip']);
  // `username` is a webhook-only field; a bot message carrying it is rejected.
  assert.equal(call.body.username, undefined);
  assert.deepEqual(call.body.allowed_mentions, { parse: [] });
});

test('a test message\'s buttons record nothing', async () => {
  const fetch = fakeFetch();
  await postReminder({
    token: 't', channelId: '1', habit: habit(), test: true,
  }, { fetch });

  const ids = fetch.calls[0].body.components[0].components.map((b) => b.custom_id);
  for (const id of ids) {
    assert.equal(parseAction(id).test, true, `${id} would have recorded a real entry`);
  }
});

test('a rejected token or channel is a permanent failure', async () => {
  for (const status of [401, 403, 404]) {
    const result = await discordRequest({ token: 't', path: '/x' },
      { fetch: fakeFetch([{ status }]) });
    assert.equal(result.permanent, true, `${status} should be permanent`);
  }
  assert.match(
    (await discordRequest({ token: 't', path: '/x' }, { fetch: fakeFetch([{ status: 401 }]) })).error,
    /DISCORD_BOT_TOKEN/,
    'a 401 must point at the token, not at the channel'
  );
  assert.match(
    (await discordRequest({ token: 't', path: '/x' }, { fetch: fakeFetch([{ status: 403 }]) })).error,
    /invited/,
    'a 403 is usually a bot that was never invited'
  );
});

test('a 500 is retryable and a 429 says how long to wait', async () => {
  const server = await discordRequest({ path: '/x' }, { fetch: fakeFetch([{ status: 500 }]) });
  assert.equal(server.ok, false);
  assert.ok(!server.permanent);

  const limited = await discordRequest({ path: '/x' },
    { fetch: fakeFetch([{ status: 429, headers: { 'retry-after': '1.5' } }]) });
  assert.equal(limited.retryAfterMs, 1500);
});

/* ---------- the shapes of an answer ---------- */

test('an answered reminder keeps its embed and loses its buttons', () => {
  const message = { embeds: [{ title: 'Did you exercise today?', color: 123 }] };
  const response = answeredUpdate(message, 'Done');

  assert.equal(response.type, CALLBACK.UPDATE_MESSAGE);
  assert.equal(response.data.embeds[0].title, 'Did you exercise today?');
  assert.equal(response.data.embeds[0].color, 123);
  assert.deepEqual(response.data.embeds[0].fields, [{ name: 'Recorded', value: 'Done' }]);
  // Removing the components is what stops a second click recording twice.
  assert.deepEqual(response.data.components, []);
});

test('answering twice replaces the note rather than stacking it', () => {
  const first = answeredUpdate({ embeds: [{ title: 't' }] }, 'Done');
  const second = answeredUpdate({ embeds: first.data.embeds }, 'Skipped');
  assert.deepEqual(second.data.embeds[0].fields, [{ name: 'Recorded', value: 'Skipped' }]);
});

test('an answer survives a message with no embed at all', () => {
  const response = answeredUpdate({}, 'Done');
  assert.equal(response.data.embeds.length, 1);
});

test('the amount box asks the habit\'s own question, within Discord\'s limits', () => {
  const modal = amountModal(habit({ type: 'numerical', unit: 'glasses' }), {
    date: '2026-08-13', prompt: 'How many glasses of water so far?',
  });

  assert.equal(modal.type, CALLBACK.MODAL);
  assert.equal(modal.data.custom_id, 'hab|7|2026-08-13|amount');
  const input = modal.data.components[0].components[0];
  assert.equal(input.label, 'How many glasses of water so far?');
  assert.equal(input.custom_id, 'amount');
  assert.equal(input.required, true);

  // Discord caps a modal title at 45 characters and a label at 45.
  const long = amountModal(habit({ name: 'n'.repeat(80) }), {
    date: '2026-08-13', prompt: 'q'.repeat(120),
  });
  assert.equal(long.data.title.length, 45);
  assert.equal(long.data.components[0].components[0].label.length, 45);
});

test('a default label is offered when the habit has no prompt', () => {
  const modal = amountModal(habit({ type: 'numerical', unit: 'km' }),
    { date: '2026-08-13', prompt: '' });
  assert.match(modal.data.components[0].components[0].label, /how many km/i);
});

/* ---------- handling a click ---------- */

const TODAY = '2026-08-13';

/** An adapter that records what it was asked to do. */
function adapter(over = {}) {
  const recorded = [];
  const sent = [];
  const base = {
    resolveChannel: async () => ({
      id: 42,
      settings: { discordChannelId: '123456789012345678', notifyTimezone: 'UTC' },
    }),
    today: async () => TODAY,
    findHabit: async () => habit({ type: 'numerical', unit: 'glasses' }),
    record: async (account, args) => {
      recorded.push(args);
      return { ok: true, habit: habit(), text: answerText(habit(), args) };
    },
    respond: async (interaction, response) => { sent.push(response); },
    log: { warn: () => {}, error: () => {} },
  };
  return { ...base, ...over, recorded, sent };
}

const click = (over = {}) => ({
  id: 'i1',
  token: 'tok',
  type: INTERACTION.COMPONENT,
  channel_id: '123456789012345678',
  member: { user: { id: '999999999999999999' } },
  message: { embeds: [{ title: 'Did you exercise today?' }] },
  data: { custom_id: `hab|7|${TODAY}|yes` },
  ...over,
});

test('a click records the entry and updates the message', async () => {
  const a = adapter();
  await handleInteraction(click(), a);

  assert.deepEqual(a.recorded, [{ habitId: 7, date: TODAY, action: 'yes', value: undefined }]);
  assert.equal(a.sent[0].type, CALLBACK.UPDATE_MESSAGE);
  assert.deepEqual(a.sent[0].data.embeds[0].fields, [{ name: 'Recorded', value: 'Done' }]);
});

test('another application\'s component is ignored entirely', async () => {
  const a = adapter();
  const result = await handleInteraction(
    click({ data: { custom_id: 'someotherbot|do-a-thing' } }), a);

  assert.equal(result, null);
  assert.deepEqual(a.sent, [], 'answering would put a message in someone else\'s conversation');
  assert.deepEqual(a.recorded, []);
});

test('a slash command or an autocomplete is not ours to answer', async () => {
  const a = adapter();
  assert.equal(await handleInteraction(click({ type: INTERACTION.COMMAND }), a), null);
  assert.equal(await handleInteraction(click({ type: INTERACTION.AUTOCOMPLETE }), a), null);
  assert.deepEqual(a.sent, []);
});

test('a test button records nothing and says so', async () => {
  const a = adapter({ record: async () => { throw new Error('must not be called'); } });
  await handleInteraction(click({ data: { custom_id: 'test|yes' } }), a);

  assert.match(a.sent[0].data.embeds[0].fields[0].value, /test message/i);
  assert.deepEqual(a.recorded, []);
});

test('a channel nobody owns gets a private note, not a write', async () => {
  const a = adapter({ resolveChannel: async () => null });
  await handleInteraction(click(), a);

  assert.equal(a.sent[0].type, CALLBACK.MESSAGE);
  assert.match(a.sent[0].data.content, /not linked/i);
  assert.deepEqual(a.recorded, []);
});

test('with a Discord user set, only that user\'s clicks count', async () => {
  const locked = adapter({
    resolveChannel: async () => ({
      id: 42,
      settings: { discordUserId: '111111111111111111', notifyTimezone: 'UTC' },
    }),
  });

  await handleInteraction(click(), locked);
  assert.match(locked.sent[0].data.content, /not your habits/i);
  assert.deepEqual(locked.recorded, []);

  // The owner's own click goes through.
  const owner = adapter({
    resolveChannel: async () => ({
      id: 42,
      settings: { discordUserId: '999999999999999999', notifyTimezone: 'UTC' },
    }),
  });
  await handleInteraction(click(), owner);
  assert.equal(owner.recorded.length, 1);
});

test('a click in a DM is attributed to the DM user', async () => {
  const a = adapter({
    resolveChannel: async () => ({
      id: 42, settings: { discordUserId: '555555555555555555' },
    }),
  });
  // No `member` outside a guild; the user sits at the top level instead.
  await handleInteraction(
    click({ member: undefined, user: { id: '555555555555555555' } }), a);
  assert.equal(a.recorded.length, 1);
});

test('a stale reminder cannot rewrite history', async () => {
  const a = adapter();
  const old = new Date(Date.parse(`${TODAY}T00:00:00Z`) - (MAX_ANSWER_AGE_DAYS + 1) * 86_400_000)
    .toISOString().slice(0, 10);

  await handleInteraction(click({ data: { custom_id: `hab|7|${old}|yes` } }), a);
  assert.match(a.sent[0].data.content, /days old/);
  assert.deepEqual(a.recorded, []);
});

test('yesterday\'s reminder can still be answered', async () => {
  const a = adapter();
  const yesterday = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000)
    .toISOString().slice(0, 10);
  await handleInteraction(click({ data: { custom_id: `hab|7|${yesterday}|yes` } }), a);
  assert.equal(a.recorded[0].date, yesterday);
});

test('a future date is refused', async () => {
  const a = adapter();
  await handleInteraction(click({ data: { custom_id: 'hab|7|2027-01-01|yes' } }), a);
  assert.match(a.sent[0].data.content, /future/i);
  assert.deepEqual(a.recorded, []);
});

test('the amount button opens a box rather than recording', async () => {
  const a = adapter();
  await handleInteraction(click({ data: { custom_id: `hab|7|${TODAY}|amount` } }), a);

  assert.equal(a.sent[0].type, CALLBACK.MODAL);
  assert.equal(a.sent[0].data.custom_id, `hab|7|${TODAY}|amount`);
  assert.deepEqual(a.recorded, []);
});

test('the box\'s value is recorded', async () => {
  const a = adapter();
  await handleInteraction({
    ...click(),
    type: INTERACTION.MODAL,
    data: {
      custom_id: `hab|7|${TODAY}|amount`,
      components: [{ type: 1, components: [{ custom_id: 'amount', value: '6' }] }],
    },
  }, a);

  assert.deepEqual(a.recorded, [{ habitId: 7, date: TODAY, action: 'amount', value: 6 }]);
  assert.equal(a.sent[0].type, CALLBACK.UPDATE_MESSAGE);
});

test('a decimal comma is accepted, and nonsense is not', async () => {
  const a = adapter();
  const submit = (value) => ({
    ...click(),
    type: INTERACTION.MODAL,
    data: {
      custom_id: `hab|7|${TODAY}|amount`,
      components: [{ type: 1, components: [{ custom_id: 'amount', value }] }],
    },
  });

  await handleInteraction(submit('2,5'), a);
  assert.equal(a.recorded[0].value, 2.5);

  const bad = adapter();
  for (const value of ['abc', '', '-1', 'NaN']) {
    await handleInteraction(submit(value), bad);
  }
  assert.deepEqual(bad.recorded, []);
  assert.equal(bad.sent.length, 4);
  for (const response of bad.sent) {
    assert.equal(response.type, CALLBACK.MESSAGE, 'a bad amount is a private note');
  }
});

test('a habit that no longer exists is reported, not written', async () => {
  const a = adapter({
    record: async () => ({ ok: false, error: 'That habit no longer exists.' }),
  });
  await handleInteraction(click(), a);
  assert.match(a.sent[0].data.content, /no longer exists/);
});

test('a storage failure does not leave the click unanswered', async () => {
  // An interaction must be answered within three seconds or Discord shows
  // "This interaction failed" — so even a thrown error has to produce a reply.
  const a = adapter({ record: async () => { throw new Error('database gone'); } });
  await handleInteraction(click(), a);
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].data.content, /went wrong/i);
});

test('a private note is only visible to the person who clicked', () => {
  assert.equal(ephemeral('x').data.flags, 64);
});

/* ---------- the gateway ---------- */

/** A stand-in socket the test drives frame by frame. */
class FakeSocket {
  static last = null;
  static made = 0;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = null;
    FakeSocket.made++;
    FakeSocket.last = this;
  }

  send(text) { this.sent.push(JSON.parse(text)); }
  close(code) { this.closed = code; this.onclose?.({ code }); }
  /** Push a frame in, as Discord would. */
  emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  /** What was sent, by opcode. */
  ops() { return this.sent.map((f) => f.op); }
}

const hello = { op: OP.HELLO, d: { heartbeat_interval: 45_000 } };
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

/**
 * A gateway whose reconnect timers are collected rather than run, so a test can
 * count how many one disconnect produced without waiting a second for the first
 * backoff step.
 */
function withFakeTimers(overrides = {}) {
  const timers = [];
  const gateway = connectGateway({
    token: 't',
    onInteraction: () => {},
    WebSocketImpl: FakeSocket,
    log: quiet,
    setTimeoutImpl: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref() {} };
    },
    ...overrides,
  });
  return { gateway, timers };
}

test('HELLO is answered with IDENTIFY, and no intents are asked for', () => {
  const gateway = connectGateway({
    token: 'bot-token', onInteraction: () => {},
    WebSocketImpl: FakeSocket, log: quiet,
  });
  const socket = FakeSocket.last;
  socket.emit(hello);

  const identify = socket.sent.find((f) => f.op === OP.IDENTIFY);
  assert.ok(identify, 'no IDENTIFY was sent');
  assert.equal(identify.d.token, 'bot-token');
  // Interactions arrive regardless of intents, so asking for none is both
  // sufficient and the smallest possible grant.
  assert.equal(identify.d.intents, 0);
  gateway.stop();
});

test('an interaction reaches the handler', async () => {
  const seen = [];
  const gateway = connectGateway({
    token: 't', onInteraction: (i) => seen.push(i),
    WebSocketImpl: FakeSocket, log: quiet,
  });
  const socket = FakeSocket.last;
  socket.emit(hello);
  socket.emit({ op: OP.DISPATCH, s: 1, t: 'READY', d: { session_id: 's1', user: { username: 'b' } } });
  socket.emit({ op: OP.DISPATCH, s: 2, t: 'INTERACTION_CREATE', d: { id: 'i1' } });
  await Promise.resolve();

  assert.deepEqual(seen, [{ id: 'i1' }]);
  assert.equal(gateway.state(), 'ready');
  gateway.stop();
});

test('a handler that throws does not take the socket down', async () => {
  const gateway = connectGateway({
    token: 't', onInteraction: () => { throw new Error('handler bug'); },
    WebSocketImpl: FakeSocket, log: quiet,
  });
  const socket = FakeSocket.last;
  socket.emit(hello);
  socket.emit({ op: OP.DISPATCH, s: 1, t: 'READY', d: { session_id: 's1' } });
  socket.emit({ op: OP.DISPATCH, s: 2, t: 'INTERACTION_CREATE', d: { id: 'i1' } });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(socket.closed, null, 'the next click has to still work');
  assert.equal(gateway.state(), 'ready');
  gateway.stop();
});

test('Discord asking for a heartbeat gets one immediately', () => {
  const gateway = connectGateway({
    token: 't', onInteraction: () => {}, WebSocketImpl: FakeSocket, log: quiet,
  });
  const socket = FakeSocket.last;
  socket.emit(hello);
  socket.emit({ op: OP.DISPATCH, s: 5, t: 'READY', d: { session_id: 's1' } });
  socket.emit({ op: OP.HEARTBEAT });

  const beat = socket.sent.filter((f) => f.op === OP.HEARTBEAT).at(-1);
  assert.ok(beat, 'no heartbeat was sent');
  // The last sequence number seen, so Discord knows what we have processed.
  assert.equal(beat.d, 5);
  gateway.stop();
});

test('a resumable session resumes; an unresumable one starts over', () => {
  const gateway = connectGateway({
    token: 't', onInteraction: () => {}, WebSocketImpl: FakeSocket, log: quiet,
  });
  let socket = FakeSocket.last;
  socket.emit(hello);
  socket.emit({
    op: OP.DISPATCH, s: 3, t: 'READY',
    d: { session_id: 's1', resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg' },
  });

  // Discord asks us to reconnect: the session is still good, so the next
  // handshake must RESUME rather than IDENTIFY — an IDENTIFY here would drop
  // every event between the two.
  socket.emit({ op: OP.RECONNECT });
  assert.equal(socket.closed, 4000, 'a plain 1000 close would discard the session');
  assert.equal(gateway.state(), 'waiting');

  gateway.stop();
});

test('a resume goes where READY said, but only if that is Discord', () => {
  // Regional, and the regions are not enumerable from here — so the rule is a
  // suffix, and the query READY sent is dropped in favour of our own.
  assert.equal(
    resumeTarget('wss://gateway-us-east1-b.discord.gg'),
    'wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json',
  );
  assert.equal(
    resumeTarget('wss://gateway.discord.gg/?v=6&encoding=etf'),
    'wss://gateway.discord.gg/?v=10&encoding=json',
  );

  // Anything else falls back to the published gateway, which costs a fresh
  // session and nothing else. The RESUME frame carries the bot token, so a
  // READY naming somewhere else is asking for it to be posted there.
  for (const bad of [
    'wss://evil.example',
    'wss://discord.gg.evil.example',     // suffix match must not be substring
    'ws://gateway.discord.gg',           // plaintext
    'https://gateway.discord.gg',        // not a socket
    'wss://user:pw@gateway.discord.gg',  // credentials in the authority
    'not a url', '', null, undefined,
  ]) {
    assert.equal(resumeTarget(bad), null, `accepted ${bad}`);
  }
});

test('a resume the socket actually opens is the canonical URL', () => {
  const opened = [];
  const gateway = connectGateway({
    token: 't', onInteraction: () => {}, log: quiet,
    WebSocketImpl: class extends FakeSocket {
      constructor(url) { super(url); opened.push(url); }
    },
    setTimeoutImpl: (fn) => { fn(); return { unref() {} }; },
  });
  const socket = FakeSocket.last;
  socket.emit(hello);
  socket.emit({
    op: OP.DISPATCH, s: 3, t: 'READY',
    d: { session_id: 's1', resume_gateway_url: 'wss://evil.example/steal' },
  });
  socket.emit({ op: OP.RECONNECT });

  assert.ok(opened.length >= 2, 'no reconnect happened');
  assert.match(opened.at(-1), /^wss:\/\/gateway\.discord\.gg\//);
  gateway.stop();
});

test('the heartbeat period HELLO asks for is gated, not clamped', () => {
  const periods = [];
  const run = (d) => {
    const gateway = connectGateway({
      token: 't', onInteraction: () => {}, WebSocketImpl: FakeSocket, log: quiet,
      setIntervalImpl: (fn, ms) => { periods.push(ms); return { unref() {} }; },
    });
    FakeSocket.last.emit({ op: OP.HELLO, d });
    gateway.stop();
  };

  run({ heartbeat_interval: 45_000 });
  run({ heartbeat_interval: 1_000 });        // the floor itself is in range
  run({ heartbeat_interval: 600_000 });      // and so is the ceiling
  // A HELLO is remote input that sets a timer in this process. `1` is a busy
  // loop that starves the reminder tick sharing the event loop; a day is a
  // socket Discord kills for going silent. Neither is clamped to the nearer
  // bound — a frame this wrong is not one to take a hint from.
  run({ heartbeat_interval: 1 });
  run({ heartbeat_interval: 86_400_000 });
  run({ heartbeat_interval: 'soon' });
  run({});

  assert.deepEqual(
    periods,
    [45_000, 1_000, 600_000, 41_250, 41_250, 41_250, 41_250],
  );
});

test('an invalid session that cannot be resumed forgets it', () => {
  const gateway = connectGateway({
    token: 't', onInteraction: () => {}, WebSocketImpl: FakeSocket, log: quiet,
  });
  const socket = FakeSocket.last;
  socket.emit(hello);
  socket.emit({ op: OP.DISPATCH, s: 3, t: 'READY', d: { session_id: 's1' } });
  socket.emit({ op: OP.INVALID_SESSION, d: false });

  assert.equal(socket.closed, 4000);
  gateway.stop();
});

test('a rejected token does not become a reconnect loop', () => {
  // 4004 means the token is wrong. Retrying it every second would hammer the
  // gateway until Discord bans the address, and it can never succeed.
  const gateway = connectGateway({
    token: 'wrong', onInteraction: () => {}, WebSocketImpl: FakeSocket, log: quiet,
  });
  const socket = FakeSocket.last;
  socket.emit(hello);
  socket.onclose({ code: 4004 });

  assert.equal(gateway.state(), 'failed');
  assert.ok(FATAL_CLOSE_CODES.has(4004));
});

test('one disconnect schedules exactly one reconnect', () => {
  // The socket's own onclose fires when we close it, so a handler left attached
  // reports a deliberate close as an unexpected one and schedules a second
  // reconnect. Two sockets then race, only the newer is heartbeated, and
  // Discord closing the older schedules a third — which is how a bot ends up
  // churning connections and answering a click twice.
  const { gateway, timers } = withFakeTimers();
  const socket = FakeSocket.last;
  socket.emit(hello);
  socket.emit({ op: OP.DISPATCH, s: 1, t: 'READY', d: { session_id: 's1' } });

  socket.emit({ op: OP.RECONNECT });

  assert.equal(socket.closed, 4000);
  assert.equal(timers.length, 1, `${timers.length} reconnects scheduled for one disconnect`);
  assert.equal(gateway.state(), 'waiting');
  gateway.stop();
});

test('a discarded socket is detached, and its replacement resumes', () => {
  const { gateway, timers } = withFakeTimers();
  const first = FakeSocket.last;
  first.emit(hello);
  first.emit({ op: OP.DISPATCH, s: 1, t: 'READY', d: { session_id: 's1' } });
  first.emit({ op: OP.RECONNECT });

  // A real close is asynchronous, so a socket we are done with can report itself
  // long after it has been replaced. Detaching is what makes that harmless.
  assert.equal(first.onclose, null);
  assert.equal(first.onmessage, null);

  const before = FakeSocket.made;
  timers[0].fn();                            // the backoff elapses
  const second = FakeSocket.last;
  assert.equal(FakeSocket.made, before + 1, 'exactly one new socket');
  assert.notEqual(second, first);

  second.emit(hello);
  assert.ok(second.sent.some((f) => f.op === OP.RESUME),
    'a reconnect must RESUME, or every event since the disconnect is lost');
  gateway.stop();
});

test('an ordinary close schedules a reconnect', () => {
  const gateway = connectGateway({
    token: 't', onInteraction: () => {}, WebSocketImpl: FakeSocket, log: quiet,
  });
  FakeSocket.last.onclose({ code: 1006 });
  assert.equal(gateway.state(), 'waiting');
  gateway.stop();
});

test('stopping closes cleanly and stays closed', () => {
  const gateway = connectGateway({
    token: 't', onInteraction: () => {}, WebSocketImpl: FakeSocket, log: quiet,
  });
  const socket = FakeSocket.last;
  socket.emit(hello);
  gateway.stop();

  assert.equal(socket.closed, 1000, 'a deliberate stop is a normal close');
  assert.equal(gateway.state(), 'stopped');
});

test('a silent socket is noticed rather than trusted', () => {
  // The failure mode that matters: the connection stays open, Discord stops
  // acknowledging, and nothing arrives. Without the ack check the bot looks
  // connected forever.
  //
  // The beat is driven by hand rather than waited out: a period under a second
  // is rejected in favour of the 41.25s default now, so a test that slept
  // through two of them would take a minute and a half to say the same thing.
  let beat = () => {};
  const gateway = connectGateway({
    token: 't', onInteraction: () => {}, WebSocketImpl: FakeSocket, log: quiet,
    setIntervalImpl: (fn) => { beat = fn; return { unref() {} }; },
  });
  const socket = FakeSocket.last;
  socket.emit(hello);
  socket.emit({ op: OP.DISPATCH, s: 1, t: 'READY', d: { session_id: 's1' } });

  beat();  // sends one, and marks it unacked
  beat();  // still unacked: the socket is silent
  assert.equal(socket.closed, 4000);
  gateway.stop();
});

test('a garbled frame is ignored, not fatal', () => {
  const gateway = connectGateway({
    token: 't', onInteraction: () => {}, WebSocketImpl: FakeSocket, log: quiet,
  });
  const socket = FakeSocket.last;
  socket.onmessage({ data: 'not json at all' });
  socket.emit(hello);
  assert.ok(socket.sent.some((f) => f.op === OP.IDENTIFY), 'the socket kept working');
  gateway.stop();
});
