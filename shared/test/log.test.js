import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/log.js';

/** A logger writing into an array, with a fixed clock. */
function capture(options = {}) {
  const lines = [];
  const logger = createLogger({
    format: 'json',
    now: () => '2026-08-13T12:00:00.000Z',
    write: (line) => lines.push(line),
    ...options,
  });
  return { logger, lines, records: () => lines.map((l) => JSON.parse(l)) };
}

test('a record is one line of JSON with a level and a message', () => {
  const { logger, lines, records } = capture();
  logger.info('notify.sent', { channel: 'discord', habit: 7 });

  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('\n'), 'a record must never span lines');
  assert.deepEqual(records()[0], {
    t: '2026-08-13T12:00:00.000Z',
    level: 'info',
    msg: 'notify.sent',
    channel: 'discord',
    habit: 7,
  });
});

test('the level filters, and silent emits nothing', () => {
  const { logger, lines } = capture({ level: 'warn' });
  logger.debug('a');
  logger.info('b');
  logger.warn('c');
  logger.error('d');
  assert.deepEqual(lines.map((l) => JSON.parse(l).msg), ['c', 'd']);

  const quiet = capture({ level: 'silent' });
  quiet.logger.error('boom');
  assert.deepEqual(quiet.lines, []);
});

test('console-style arguments still work', () => {
  // shared/src injects `ctx.log ?? console` and calls it printf-style. Those
  // call sites must not have to change for a logger to be usable.
  const { logger, records } = capture();
  logger.warn('notify:', 'account 3 failed');
  assert.equal(records()[0].msg, 'notify: account 3 failed');
});

test('an Error becomes fields, with the stack on the same line', () => {
  const { logger, lines, records } = capture();
  const err = new Error('webhook exploded');
  err.status = 502;
  logger.error('notify.failed', err);

  const [r] = records();
  assert.equal(r.msg, 'notify.failed');
  assert.equal(r.err, 'webhook exploded');
  assert.equal(r.err_type, 'Error');
  assert.equal(r.err_status, 502);
  assert.match(r.stack, /webhook exploded/);
  assert.ok(!lines[0].includes('\n'), 'the stack must be a field, not extra lines');
});

test('a cause chain is flattened rather than nested', () => {
  const { logger, records } = capture();
  logger.error('failed', new Error('outer', { cause: new Error('inner') }));
  assert.equal(records()[0].err_cause, 'inner');
});

test('secrets are redacted whatever the key is called', () => {
  const { logger, lines, records } = capture();
  logger.info('startup', {
    botToken: 'MTIzNDU2Nzg5.abc.def',
    DISCORD_BOT_TOKEN: 'x',
    SESSION_SECRET: 'y',
    DATABASE_URL: 'postgres://user:pw@db/x',
    discordWebhook: 'https://discord.com/api/webhooks/1/abcdef',
    cookie: 'habiterall.sid=s%3A...',
    port: 3000,
  });

  const [r] = records();
  for (const key of ['botToken', 'DISCORD_BOT_TOKEN', 'SESSION_SECRET',
    'DATABASE_URL', 'discordWebhook', 'cookie']) {
    assert.equal(r[key], '[redacted]', `${key} was not redacted`);
  }
  assert.equal(r.port, 3000, 'a harmless field must survive');
  assert.ok(!lines[0].includes('abcdef'), 'no part of a secret may appear');
  assert.ok(!lines[0].includes('pw@db'));
});

test('personal content is redacted; ids are not', () => {
  // The policy is to log ids. This is the backstop for forgetting it: a habit's
  // name, a note and an entry's value are the private content of the app, and a
  // log is shipped off the box and retained.
  const { logger, records } = capture();
  logger.info('entry.written', {
    habit: 7, user: 3, date: '2026-08-13',
    name: 'Antidepressants', notes: 'felt awful', value: 2000,
  });

  const [r] = records();
  assert.equal(r.habit, 7);
  assert.equal(r.user, 3);
  assert.equal(r.date, '2026-08-13');
  assert.equal(r.name, '[redacted]');
  assert.equal(r.notes, '[redacted]');
  assert.equal(r.value, '[redacted]');
});

test('a line an aggregator would drop is truncated instead', () => {
  const { logger, lines, records } = capture();
  logger.error('import.failed', { body: 'x'.repeat(50_000) });

  assert.ok(lines[0].length < 10_000, `line was ${lines[0].length} bytes`);
  assert.equal(records()[0].msg, 'import.failed');
});

test('child loggers carry their context', () => {
  const { logger, records } = capture();
  const req = logger.child({ req: 'abc123', user: 3 });
  req.info('http.slow', { ms: 1200 });

  assert.deepEqual(records()[0], {
    t: '2026-08-13T12:00:00.000Z',
    level: 'info',
    msg: 'http.slow',
    req: 'abc123',
    user: 3,
    ms: 1200,
  });
});

test('enabled() reports what would actually be written', () => {
  // So a caller can skip building a debug payload nobody will read.
  const { logger } = capture({ level: 'info' });
  assert.equal(logger.enabled('debug'), false);
  assert.equal(logger.enabled('warn'), true);
});

test('the pretty format is for a terminal only, and may span lines', () => {
  const lines = [];
  const logger = createLogger({
    format: 'pretty', now: () => '2026-08-13T12:00:00.000Z',
    write: (l) => lines.push(l),
  });
  logger.info('notify.sent', { channel: 'discord', habit: 7 });
  assert.equal(lines[0], '12:00:00 INFO  notify.sent channel=discord habit=7');
});

test('an unserialisable field does not take the process down', () => {
  const { logger, records } = capture();
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  logger.info('weird', { thing: cyclic, n: 1 });
  assert.equal(records()[0].n, 1);
});
