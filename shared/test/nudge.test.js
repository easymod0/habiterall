/**
 * The browser's own reminder: the rule, the watermark and the call site.
 *
 * `ui/nudge.js` is importable here because it has no imports of its own —
 * deliberately, exactly as `ui/toggle.js` is, since the absolute `/shared/...`
 * specifiers the rest of `public/ui` uses do not resolve under Node. That is
 * what makes this file able to run the whole thing rather than only the
 * extracted predicate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  WEB_CHANNEL, alreadyNudged, announce, check, init, isDayAnswered, markNudged,
  nudgeMessage, outstanding, permissionState,
} = await import('../public/ui/nudge.js');

const { browserNudgeProblems } = await import('../public/ui/settings.js');

const { answeredIds, CHANNELS, CHANNEL_IDS, DEFAULT_CHANNELS,
  channelConfigured, needsServerDelivery, serverChannels, unreachableChannels } =
  await import('../src/notify.js');
const { isCompleted } = await import('../src/stats.js');
const values = await import('../public/ui/values.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- the registry, on both sides ---------- */

test('this destination is one the server knows, and one it does nothing for', () => {
  // The id is declared in ui/nudge.js as well as in CHANNELS, for the reason
  // the module has no imports at all. A third spelling of a channel id is how
  // a destination becomes impossible to switch on.
  assert.ok(CHANNEL_IDS.includes(WEB_CHANNEL), 'CHANNELS has no `web` entry');
  assert.equal(CHANNELS[WEB_CHANNEL].delivery, 'device');

  // The notifier must not acquire an opinion about it. `serverChannels` is what
  // `deliverAccount` iterates and `needsServerDelivery` is what decides whether
  // an account is visited at all — an account with this and nothing else on
  // costs the tick nothing.
  const on = { notifyChannels: [WEB_CHANNEL] };
  assert.deepEqual(serverChannels(on), []);
  assert.equal(needsServerDelivery(on), false);

  // ...and it is not "enabled but unreachable" either, which would put a
  // `notify.unreachable` warning in the log about a destination the server has
  // no business delivering.
  assert.deepEqual(unreachableChannels(on), []);

  // Always configured: there are no keys, and the thing it actually needs — one
  // browser's permission — is not something an account can hold.
  assert.equal(channelConfigured(WEB_CHANNEL, {}), true);
  assert.deepEqual(CHANNELS[WEB_CHANNEL].configKeys, []);

  // Off until asked for. A fresh account must not arrive with a destination it
  // has never been able to grant.
  assert.ok(!DEFAULT_CHANNELS.includes(WEB_CHANNEL));
});

test('nudge.js\'s own copy of the wire value matches ui/values.js', () => {
  // A fourth copy of YES, for the same reason toggle.js holds a third. Read out
  // of the source rather than the exports, since it is deliberately not one.
  const src = readFileSync(join(root, 'public', 'ui', 'nudge.js'), 'utf8');
  const line = /^const YES = (\d+);$/m.exec(src);
  assert.ok(line, 'nudge.js no longer declares YES on a line of its own');
  assert.equal(Number(line[1]), values.YES);
});

/* ---------- the mirror ---------- */

/**
 * One habit of every shape whose answer could differ, including the at-most
 * pair that is the whole reason this fixture is not three rows long.
 */
const HABITS = [
  { id: 1, name: 'Meditate', type: 'boolean', target_type: 'at_least', target_value: 0 },
  { id: 2, name: 'Water', type: 'numerical', target_type: 'at_least', target_value: 8 },
  // A limit whose unlogged days follow the account (default `miss`)...
  { id: 3, name: 'Coffee', type: 'numerical', target_type: 'at_most', target_value: 2,
    at_most_unlogged: 'default' },
  // ...and one that overrides it to `success`, which is the reading that makes
  // a day with no row look like a perfect one.
  { id: 4, name: 'Soda', type: 'numerical', target_type: 'at_most', target_value: 2,
    at_most_unlogged: 'success' },
  // A limit of zero: how a bad habit is expressed, and the shape where 0 and
  // "no row" are hardest to keep apart.
  { id: 5, name: 'Smoke', type: 'numerical', target_type: 'at_most', target_value: 0,
    at_most_unlogged: 'success' },
];

/**
 * Every row shape a day can hold, `null` meaning there is no row at all.
 *
 * The two string rows are what make this fixture able to see a dropped
 * coercion. With numbers alone, replacing `Number(entry.value) || 0` with a
 * bare `entry.value` left every case here green while genuinely diverging from
 * the server: `normalizeEntry` coerces, so on an at-most habit `'x' <= 2` is
 * false in the browser and `0 <= 2` is true on the server. Not a live shape —
 * `/overview` sends numbers — but the mirror rests entirely on this list.
 */
const ROWS = [
  null,
  { value: 0, status: '' },
  { value: 1, status: '' },
  { value: 2, status: '' },
  { value: 3, status: '' },
  { value: 8, status: '' },
  { value: '3', status: '' },
  { value: 'x', status: '' },
  { value: 0, status: 'skip' },
  { value: 5, status: 'skip' },
];

test('the browser and the server agree about what an answered day is', () => {
  // `answeredIds` is the server's rule and `isDayAnswered` is the browser's
  // mirror of it, because the nudge runs from `state` with no network. Both are
  // run over the same fixtures rather than compared by reading: a mirror with
  // nothing pinning it to its original is the thing this project keeps paying
  // for.
  let compared = 0;

  for (const habit of HABITS) {
    for (const row of ROWS) {
      const rows = row ? [{ habit_id: habit.id, ...row }] : [];
      const server = answeredIds([habit], rows).has(habit.id);
      const browser = isDayAnswered(habit, row);

      assert.equal(browser, server,
        `${habit.name} (${habit.type} ${habit.target_type} ${habit.target_value}) `
        + `with ${JSON.stringify(row)}: browser said ${browser}, server ${server}`);
      compared++;
    }
  }

  assert.equal(compared, HABITS.length * ROWS.length);
});

test('a skip is an answer and a stated "no" is not', () => {
  // The two clauses the mirror is made of, asserted directly so a failure says
  // which one moved rather than only that something did.
  const habit = HABITS[0];
  assert.equal(isDayAnswered(habit, { value: 0, status: 'skip' }), true,
    'a skip is an ANSWER — isCompleted returns null for it, not false');
  assert.equal(isDayAnswered(habit, { value: 0, status: '' }), false,
    'a row holding 0 is a stated miss and still deserves its nudge');
  assert.equal(isDayAnswered(habit, { value: values.YES, status: '' }), true);
});

test('a day with no row is unanswered whatever the account says about limits', () => {
  // The trap, and the reason the fixture carries two at-most habits. Written
  // the obvious way — `isCompleted(habit, entryMap.get(date) ?? UNSET)`, or
  // simply passing the missing entry straight through — an at-most habit whose
  // unlogged days count as staying under reports every untouched day as
  // ANSWERED, and this destination goes quiet exactly where Discord and the
  // phone do not.
  //
  // The first assertion is what proves the fixture can tell the difference: if
  // `isCompleted` ever stopped answering `true` here, the rest of this test
  // would pass for the wrong reason.
  for (const habit of HABITS.filter((h) => h.target_type === 'at_most')) {
    assert.equal(isCompleted(habit, undefined, 'success'), true,
      `${habit.name}: an unlogged day IS a success under the other reading — `
      + 'without that this test is checking nothing');

    assert.equal(isDayAnswered(habit, undefined), false,
      `${habit.name}: an unlogged day must never read as answered`);
    assert.equal(isDayAnswered(habit, null), false);

    // ...and the server agrees, because it walks the rows that exist.
    assert.equal(answeredIds([habit], []).has(habit.id), false);
  }
});

/* ---------- which habits are outstanding ---------- */

const TODAY = '2026-08-17';

/** A habit with a reminder and no entries, overridable. */
const due = (over = {}) => ({
  id: 1, name: 'Meditate', type: 'boolean', target_type: 'at_least',
  target_value: 0, reminder_time: '08:00', archived: false,
  entries: {}, skips: [], ...over,
});

const at = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** The window `/overview` answered with, ending on the day being judged. */
const WINDOW = { start: '2026-08-04', end: TODAY };

const ask = (habits, time, already = [], loaded = WINDOW) =>
  outstanding(habits, { date: TODAY, minutes: at(time), loaded, already })
    .map((h) => h.id);

test('a reminder that has not come round yet says nothing', () => {
  assert.deepEqual(ask([due()], '07:59'), []);
  assert.deepEqual(ask([due()], '08:00'), [1], 'the minute itself counts');
  assert.deepEqual(ask([due()], '08:01'), [1]);
});

test('there is no catch-up window, deliberately', () => {
  // `dueReminders` drops a server-sent reminder half an hour past its minute,
  // because a wall-clock promise delivered four hours late is worse than none.
  // This one fires when you OPEN the app, so the same habit is exactly as
  // outstanding at 23:00 — and a window here would mean opening the app at
  // 08:31 and being told nothing at all, which is the whole feature.
  assert.deepEqual(ask([due()], '23:59'), [1]);
});

test('a habit with no reminder time is not this destination\'s business', () => {
  assert.deepEqual(ask([due({ reminder_time: '' })], '23:00'), []);
  assert.deepEqual(ask([due({ reminder_time: undefined })], '23:00'), []);
  assert.deepEqual(ask([due({ reminder_time: '25:00' })], '23:00'), []);
});

test('an archived habit is never outstanding', () => {
  assert.deepEqual(ask([due({ archived: true })], '09:00'), []);
});

test('an answered day drops out, and the four states are told apart', () => {
  const done = due({ id: 2, entries: { [TODAY]: values.YES } });
  const skipped = due({ id: 3, entries: { [TODAY]: values.SKIP }, skips: [TODAY] });
  const stated = due({ id: 4, entries: { [TODAY]: 0 } });
  const unknown = due({ id: 5 });

  assert.deepEqual(ask([done, skipped, stated, unknown], '09:00'), [4, 5],
    'done and skipped are answers; a stated 0 and an untouched day are not');
});

test('a measurable day is read against its target, not against having a row', () => {
  // The phone once had a third rule — "does a row exist for today?" — and it
  // silenced six-of-eight-glasses while the server went on asking.
  const short = due({ id: 6, type: 'numerical', target_type: 'at_least',
    target_value: 8, entries: { [TODAY]: 6 } });
  const met = due({ id: 7, type: 'numerical', target_type: 'at_least',
    target_value: 8, entries: { [TODAY]: 8 } });

  assert.deepEqual(ask([short, met], '09:00'), [6]);
});

test('a value of 3 on a measurable habit is three, not a skip', () => {
  // The collision the whole out-of-band skip column exists to avoid. `skips` is
  // what says a day was skipped; the value never is.
  const three = due({ id: 8, type: 'numerical', target_type: 'at_least',
    target_value: 8, entries: { [TODAY]: 3 } });
  assert.deepEqual(ask([three], '09:00'), [8], 'three glasses is not a skipped day');

  three.skips = [TODAY];
  assert.deepEqual(ask([three], '09:00'), [], 'and `skips` is what makes it one');
});

test('the entries map is asked whether it HOLDS the day', () => {
  // `entries[date]` cannot tell a row holding 0 from no row, and reading it
  // that way is the collapse shared/CLAUDE.md forbids of a reader. Both are
  // outstanding for a yes/no habit, so the case that shows it is an at-most
  // limit, where 0 is a success and silence is not.
  const limit = due({ id: 9, type: 'numerical', target_type: 'at_most',
    target_value: 2 });
  assert.deepEqual(ask([limit], '09:00'), [9], 'nobody has answered today');

  limit.entries = { [TODAY]: 0 };
  assert.deepEqual(ask([limit], '09:00'), [], 'a stated "none today" is an answer');
});

test('a habit already nudged about today is not raised again', () => {
  assert.deepEqual(ask([due()], '09:00', [1]), []);
  assert.deepEqual(ask([due()], '09:00', new Set([1])), []);
  assert.deepEqual(ask([due()], '09:00', [2]), [1], 'and only that habit');
});

/* ---------- the fifth state: not fetched ---------- */

test('a day outside the loaded window is not judged at all', () => {
  // `/overview` answers a WINDOW, and `dashboard.load()` sends
  // `end=state.gridEnd` — so paging the grid back a fortnight returns habits
  // whose `entries` legitimately stop before today. Read without the window, a
  // missing key is "no row exists": the `?? UNSET` collapse arriving from the
  // other side, and measured in Chrome as "1 habit still to answer today"
  // about a habit answered an hour earlier.
  const paged = { start: '2026-07-21', end: '2026-08-03' };
  assert.deepEqual(ask([due()], '09:00', [], paged), [],
    'the payload cannot speak for today, so there is nothing to say');

  // ...and the refusal is about the WINDOW, not about the habit: the same
  // habit and the same clock, with a window that reaches today, is outstanding.
  assert.deepEqual(ask([due()], '09:00', [], WINDOW), [1]);
});

test('an answered day inside a stale window is not read as unanswered', () => {
  // The exact reproduction: today IS answered, and the payload in hand simply
  // does not carry it. Judging it would nag about a day already dealt with.
  const answered = due({ entries: { [TODAY]: values.YES } });
  const stale = { ...answered, entries: { '2026-08-03': values.YES } };
  const paged = { start: '2026-07-21', end: '2026-08-03' };

  assert.deepEqual(ask([answered], '09:00'), [], 'the row is there: silent');
  assert.deepEqual(ask([stale], '09:00', [], paged), [],
    'the row is not there because it was never fetched: also silent');
});

test('nothing is judged before the first load, or after a failed one', () => {
  // An unknown window refuses too. `state.gridLoaded` is null until
  // `dashboard.load()` has answered, and a deep link never loads the list at
  // all — so the honest answer there is silence rather than a guess made from
  // an empty map.
  // Called directly rather than through `ask`, whose default would substitute a
  // good window for `undefined` and hide the case that matters most.
  const clock = { date: TODAY, minutes: at('09:00') };
  for (const loaded of [null, undefined, {}, { start: '2026-08-04' }, { end: TODAY }]) {
    assert.deepEqual(outstanding([due()], { ...clock, loaded }), [],
      `judged a day with loaded = ${JSON.stringify(loaded)}`);
  }

  // ...and omitting it entirely refuses too, which is the direction a new
  // caller gets wrong: forgetting the window must cost silence, never a guess.
  assert.deepEqual(outstanding([due()], clock), []);
  assert.deepEqual(outstanding([due()], { ...clock, loaded: WINDOW }).map((h) => h.id), [1],
    'and the fixture is one that WOULD be outstanding, or this proves nothing');
});

/* ---------- what it says ---------- */

test('the message counts and names, and never claims to be a reminder', () => {
  const one = nudgeMessage([{ name: 'Meditate' }]);
  assert.equal(one.title, '1 habit still to answer today');
  assert.equal(one.body, 'Meditate');

  const two = nudgeMessage([{ name: 'Meditate' }, { name: 'Water' }]);
  assert.equal(two.title, '2 habits still to answer today');
  assert.equal(two.body, 'Meditate, Water');

  // Long lists are counted rather than listed: a notification body is
  // truncated by the platform, and "and 3 more" is information where a
  // half-shown fifth name is not.
  const many = nudgeMessage(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name })));
  assert.equal(many.title, '6 habits still to answer today');
  assert.equal(many.body, 'a, b, c, d and 2 more');
});

test('the wording does not promise a time', () => {
  // The one thing the copy has to get right, and the reason it is asserted
  // rather than left to review: this destination cannot wake anybody, and a
  // word that suggests it can is a bug report six months from now.
  const text = JSON.stringify(nudgeMessage([{ name: 'x' }])).toLowerCase();
  for (const word of ['remind', 'alarm', 'scheduled', 'at 08']) {
    assert.ok(!text.includes(word), `the message says "${word}"`);
  }
});

/* ---------- the watermark ---------- */

/** A localStorage stand-in, since Node has none. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

/**
 * Install browser globals for one block, and put them back afterwards.
 *
 * `await run()` and not `return run()`. Written the second way the `finally`
 * fires the moment the block hands back a PROMISE, so every global is restored
 * before the first `await` inside it resumes — and `announce`, which awaits a
 * service-worker lookup before it raises anything, then ran with no
 * `Notification` at all and reported the in-app fallback. Every caller awaits
 * this for the same reason: an assertion that throws inside an async block is a
 * rejection, and a rejection nobody awaits is a passing test.
 */
async function withGlobals(globals, run) {
  const saved = new Map();
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name,
      { value, configurable: true, writable: true });
  }
  try {
    return await run();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test('the watermark is per habit and per LOCAL day', async () => {
  await withGlobals({ localStorage: fakeStorage() }, () => {
    assert.deepEqual([...alreadyNudged(TODAY)], []);

    markNudged(TODAY, [1, 2]);
    assert.deepEqual([...alreadyNudged(TODAY)].sort(), [1, 2]);

    // A new day starts clean, and the record does not accumulate: the date is
    // stored WITH the ids, so tomorrow replaces today rather than appending.
    assert.deepEqual([...alreadyNudged('2026-08-18')], []);
    markNudged('2026-08-18', [3]);
    assert.deepEqual([...alreadyNudged('2026-08-18')], [3]);
    assert.deepEqual([...alreadyNudged(TODAY)], [],
      'yesterday\'s ids must not survive into a record for another day');
  });
});

test('the watermark is a device record and never a setting', async () => {
  // It is written to localStorage under its own key and nowhere else. Anything
  // in the settings blob is carried by `/api/export`, so a key there would end
  // up in people's backups — the same argument that keeps `notify_status` out
  // of it. And it must not be sent to the server at all.
  const storage = fakeStorage();
  await withGlobals({ localStorage: storage }, () => {
    markNudged(TODAY, [1]);
    assert.deepEqual([...storage._map.keys()], ['habiterall-nudged']);
    assert.ok(!storage._map.has('habiterall-settings'));
  });

  const src = readFileSync(join(root, 'public', 'ui', 'nudge.js'), 'utf8');
  assert.ok(!/fetch\s*\(/.test(src),
    'ui/nudge.js makes a request — this destination writes nothing to the server');
});

test('storage that is missing or corrupt costs a repeat, never a throw', async () => {
  // No localStorage at all: private browsing, a security policy, or Node.
  assert.deepEqual([...alreadyNudged(TODAY)], []);
  assert.doesNotThrow(() => markNudged(TODAY, [1]));

  const storage = fakeStorage();
  storage.setItem('habiterall-nudged', 'not json');
  await withGlobals({ localStorage: storage }, () => {
    assert.deepEqual([...alreadyNudged(TODAY)], [],
      'a corrupt record means nudging once more, not failing');
  });
});

/* ---------- saying it ---------- */

/** A `Notification` stand-in whose permission and constructor are steerable. */
function fakeNotification({ permission = 'granted', throws = false } = {}) {
  const raised = [];
  function Ctor(title, options) {
    if (throws) throw new TypeError('Illegal constructor');
    raised.push({ title, options });
  }
  Ctor.permission = permission;
  Ctor.raised = raised;
  return Ctor;
}

test('a granted browser gets a notification', async () => {
  const Ctor = fakeNotification();
  await withGlobals({ Notification: Ctor }, async () => {
    const said = [];
    assert.equal(await announce({ title: 'T', body: 'B' }, (t) => said.push(t)),
      'notification');
    assert.deepEqual(said, [], 'the in-app fallback must not double up');
    assert.equal(Ctor.raised.length, 1);
    assert.equal(Ctor.raised[0].title, 'T');
    assert.equal(Ctor.raised[0].options.body, 'B');
    assert.equal(Ctor.raised[0].options.tag, 'habiterall-nudge',
      'a second nudge must replace the first rather than stack under it');
  });
});

test('a refusal is answered in the app, not with silence', async () => {
  // The fallback is what issue #70 asks for by name, and it is what this
  // destination DOES for everyone who has said no.
  for (const permission of ['denied', 'default']) {
    await withGlobals({ Notification: fakeNotification({ permission }) }, async () => {
      const said = [];
      assert.equal(await announce({ title: 'T', body: 'B' }, (t) => said.push(t)),
        'app', permission);
      assert.deepEqual(said, ['T: B']);
    });
  }
});

test('a browser with no Notification API at all still says it', async () => {
  const said = [];
  assert.equal(await announce({ title: 'T', body: 'B' }, (t) => said.push(t)), 'app');
  assert.deepEqual(said, ['T: B']);
  assert.equal(permissionState(), 'unsupported');
});

test('a constructor that throws falls through to the app', async () => {
  // Android Chrome: `new Notification(...)` is illegal there and only
  // `registration.showNotification` works. With no usable worker in this
  // process the honest outcome is the in-app line — never nothing.
  await withGlobals({ Notification: fakeNotification({ throws: true }) }, async () => {
    const said = [];
    assert.equal(await announce({ title: 'T', body: 'B' }, (t) => said.push(t)), 'app');
    assert.deepEqual(said, ['T: B']);
  });
});

test('an active service worker is preferred to the constructor', async () => {
  // ...and it is `getRegistration`, never `ready`: that promise does not settle
  // until a worker is active, so on a page with none it would hang forever —
  // holding the one path that has to work.
  const shown = [];
  const navigator = {
    serviceWorker: {
      getRegistration: async () => ({
        active: {},
        showNotification: async (title, options) => shown.push({ title, options }),
      }),
    },
  };
  const Ctor = fakeNotification();
  await withGlobals({ Notification: Ctor, navigator }, async () => {
    assert.equal(await announce({ title: 'T', body: 'B' }, () => {}), 'notification');
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, 'T');
    assert.equal(Ctor.raised.length, 0, 'the constructor must not also fire');
  });

  const src = readFileSync(join(root, 'public', 'ui', 'nudge.js'), 'utf8');
  assert.ok(!/serviceWorker\??\.ready/.test(src),
    'ui/nudge.js awaits serviceWorker.ready, which never settles without one');
});

/* ---------- what the dialog says about the permission ---------- */

/** The draft the settings dialog would hand `SECTION_NOTICES`. */
const withWeb = { notifyChannels: ['android', WEB_CHANNEL] };

test('nothing is reported for a destination that is switched off', async () => {
  await withGlobals({ Notification: fakeNotification({ permission: 'denied' }) }, () => {
    assert.deepEqual(browserNudgeProblems({ notifyChannels: ['android'] }), []);
    assert.deepEqual(browserNudgeProblems({}), []);
  });
});

test('a granted browser has nothing to say', async () => {
  await withGlobals({ Notification: fakeNotification({ permission: 'granted' }) }, () => {
    assert.deepEqual(browserNudgeProblems(withWeb), []);
  });
});

test('each permission state gets its own sentence', async () => {
  for (const [permission, expected] of [
    ['denied', /site settings/i],
    ['default', /not allowed yet/i],
  ]) {
    await withGlobals({ Notification: fakeNotification({ permission }) }, () => {
      const said = browserNudgeProblems(withWeb).join(' ');
      assert.match(said, expected, permission);
      // Every one of them has to say where the answer goes instead, or the
      // destination reads as broken rather than as degraded.
      assert.match(said, /inside the app/i, permission);
    });
  }
});

test('a browser with no Notification API is told that, not told to allow it', async () => {
  const said = browserNudgeProblems(withWeb).join(' ');
  assert.match(said, /cannot show notifications/i);
  assert.match(said, /inside the app/i);
});

test('an insecure origin is named as the reason, before the permission is read', async () => {
  // The branch that was unreachable when this shipped. On plain http Chrome
  // still exposes the constructor and answers `denied` — measured on
  // `http://192.168.50.232:3249`: isSecureContext false, Notification a
  // function, requestPermission() resolving denied with no prompt. So every
  // check below it gives advice that cannot work, and the user is sent to a
  // site setting that has nothing to do with it.
  //
  // It is the plain-http half of HABITERALL_UPGRADE_INSECURE: https from
  // outside, http from the LAN, same database.
  await withGlobals({
    isSecureContext: false,
    Notification: fakeNotification({ permission: 'denied' }),
  }, () => {
    const said = browserNudgeProblems(withWeb).join(' ');
    assert.match(said, /secure origin|https/i, 'the origin must be named');
    assert.doesNotMatch(said, /site settings/i,
      'a site setting cannot fix a non-secure context, so it must not be offered');
    assert.match(said, /inside the app/i);
  });
});

test('a runtime with no isSecureContext at all falls through to the permission', async () => {
  // `=== false` and not falsy. Node has no such flag, and neither does an old
  // browser — reading `undefined` as insecure would tell a perfectly good
  // origin that it is the problem.
  await withGlobals({ Notification: fakeNotification({ permission: 'denied' }) }, () => {
    assert.match(browserNudgeProblems(withWeb).join(' '), /site settings/i);
  });
  await withGlobals({
    isSecureContext: true,
    Notification: fakeNotification({ permission: 'denied' }),
  }, () => {
    assert.match(browserNudgeProblems(withWeb).join(' '), /site settings/i);
  });
});

/* ---------- the call site ---------- */

/**
 * Wire `init` to controllable stand-ins and hand back what it did.
 *
 * The point of testing here rather than only in the browser is that `check` is
 * where the four rules meet — the destination toggle, the clock, the watermark
 * and the sink — and every one of them is a place a correct predicate can be
 * called wrongly.
 */
function wire({
  habits = [], enabled = [WEB_CHANNEL], today = TODAY, loaded = WINDOW,
} = {}) {
  const said = [];
  const events = new Map();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => events.set(name, fn),
  };
  init({
    habits: () => habits,
    enabled: () => enabled,
    today: () => today,
    loaded: () => loaded,
    fallback: (text) => said.push(text),
    doc,
  });
  return { said, events, doc };
}

test('nothing is said unless the destination is switched on', async () => {
  await withGlobals({ localStorage: fakeStorage() }, async () => {
    const { said } = wire({ habits: [due()], enabled: ['android', 'discord'] });
    assert.deepEqual(await check({ now: new Date(2026, 7, 17, 9, 0) }), []);
    assert.deepEqual(said, []);
  });
});

test('switched on, an outstanding habit is announced once a day', async () => {
  await withGlobals({ localStorage: fakeStorage() }, async () => {
    const { said } = wire({ habits: [due()] });
    const now = new Date(2026, 7, 17, 9, 0);

    assert.deepEqual((await check({ now })).map((h) => h.id), [1]);
    assert.deepEqual(said, ['1 habit still to answer today: Meditate']);

    // The watermark. Without it every `visibilitychange` re-announces the same
    // day, which is the surest way to have the destination switched off.
    assert.deepEqual(await check({ now }), []);
    assert.equal(said.length, 1);
  });
});

test('a habit that comes due later the same day is still announced', async () => {
  // The watermark is per HABIT, not "have we said anything today" — otherwise
  // the first reminder of the morning silences every one after it.
  await withGlobals({ localStorage: fakeStorage() }, async () => {
    const habits = [due(), due({ id: 2, name: 'Water', reminder_time: '18:00' })];
    const { said } = wire({ habits });

    assert.deepEqual((await check({ now: new Date(2026, 7, 17, 9, 0) })).map((h) => h.id), [1]);
    assert.deepEqual((await check({ now: new Date(2026, 7, 17, 19, 0) })).map((h) => h.id), [2]);
    assert.equal(said.length, 2);
    assert.match(said[1], /Water/);
  });
});

test('the trigger is `visibilitychange`, and only when visible', async () => {
  await withGlobals({ localStorage: fakeStorage() }, async () => {
    const { said, events, doc } = wire({ habits: [due({ reminder_time: '00:00' })] });
    assert.ok(events.has('visibilitychange'), 'nothing listens for the tab coming back');

    doc.visibilityState = 'hidden';
    await events.get('visibilitychange')();
    assert.deepEqual(said, [], 'a tab going away must not raise anything');

    doc.visibilityState = 'visible';
    await events.get('visibilitychange')();
    assert.equal(said.length, 1);
  });
});

test('check before init does nothing rather than throwing', async () => {
  // It is called at the tail of boot and from an event handler; a nudge that
  // fails must take neither down with it.
  const src = readFileSync(join(root, 'public', 'ui', 'nudge.js'), 'utf8');
  assert.match(src, /if \(!wiring\) return \[\];/);

  await withGlobals({ localStorage: fakeStorage() }, async () => {
    const { said } = wire({ habits: [{ /* junk */ }, null, due()] });
    await assert.doesNotReject(check({ now: new Date(2026, 7, 17, 9, 0) }));
    assert.equal(said.length, 1, 'a malformed habit must not silence the rest');
  });
});
