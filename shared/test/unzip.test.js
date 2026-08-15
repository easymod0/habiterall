import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { unzip } from '../src/unzip.js';
import { zip } from '../src/zip.js';

/**
 * The ZIP reader is the only place where an unauthenticated request hands us
 * attacker-controlled compressed data (`POST /api/import` accepts Loop's CSV
 * export). These tests exist because a per-entry size cap looked like a
 * defence and was not one.
 */

/* ---------- helpers ---------- */

const LFH_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/**
 * Build an archive whose central directory has `count` entries that ALL point
 * at the same local header. Perfectly legal ZIP; the format has no rule
 * against it, which is exactly what makes it an amplifier.
 */
function sharedPayloadArchive({ count, payload, method, declaredUncompressed }) {
  const name = Buffer.from('a.csv');
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(LFH_SIG, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt32LE(payload.length, 18);
  lfh.writeUInt32LE(declaredUncompressed, 22);
  lfh.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([lfh, name, payload]);

  const cds = [];
  for (let i = 0; i < count; i++) {
    const nm = Buffer.from(`f${i}.csv`);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CD_SIG, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(declaredUncompressed, 24);
    cd.writeUInt16LE(nm.length, 28);
    cd.writeUInt32LE(0, 42);          // every entry -> offset 0
    cds.push(cd, nm);
  }

  const central = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);

  return Buffer.concat([local, central, eocd]);
}

/* ---------- amplification ---------- */

test('a deflate bomb sharing one payload across many entries is rejected', () => {
  // 200 entries x 31MB, every one honestly declared and individually UNDER the
  // 32MB per-entry cap. Measured before the fix: 41KB in, 6.05GB out in four
  // seconds — a 153,000x amplification from an unauthenticated endpoint.
  const SIZE = 31 * 1024 * 1024;
  const bomb = sharedPayloadArchive({
    count: 200,
    payload: deflateRawSync(Buffer.alloc(SIZE), { level: 9 }),
    method: 8,
    declaredUncompressed: SIZE,
  });

  assert.ok(bomb.length < 100 * 1024, `bomb should be tiny, was ${bomb.length}`);
  assert.throws(() => unzip(bomb), (err) => err.status === 400,
    'an archive that expands past the total budget must be refused');
});

test('a stored-method bomb declaring zero size is rejected', () => {
  // The other half of the hole: stored entries were copied straight from
  // `compressedSize`, so declaring uncompressedSize 0 slipped past the cap
  // entirely and 500 entries replayed one 20MB member.
  const bomb = sharedPayloadArchive({
    count: 500,
    payload: Buffer.alloc(20 * 1024 * 1024, 65),
    method: 0,
    declaredUncompressed: 0,
  });

  assert.throws(() => unzip(bomb), (err) => err.status === 400);
});

test('the entry count itself is bounded', () => {
  // Bounds the work before any decompression happens. Loop's export has two
  // members; nothing legitimate comes close.
  const many = sharedPayloadArchive({
    count: 60000,
    payload: Buffer.from('x'),
    method: 0,
    declaredUncompressed: 1,
  });
  const out = unzip(many);
  assert.ok(out.size <= 512, `read ${out.size} members`);
});

/* ---------- legitimate archives still work ---------- */

test('a Loop-shaped archive round-trips', () => {
  const archive = zip([
    { name: 'Habits.csv', data: 'Position,Name\n0,Run\n' },
    { name: 'Checkmarks.csv', data: 'Date,Run\n2026-01-01,YES_MANUAL\n' },
  ]);

  const out = unzip(archive);
  assert.deepEqual([...out.keys()].sort(), ['Checkmarks.csv', 'Habits.csv']);
  assert.match(out.get('Habits.csv').toString(), /^Position,Name/);
});

test('a large but legitimate archive is accepted', () => {
  // Years of history is a few hundred KB; 10MB is far beyond any real export
  // and must still import, or the fix would have broken the feature it guards.
  const archive = zip([{ name: 'Checkmarks.csv', data: 'x'.repeat(10 * 1024 * 1024) }]);
  const out = unzip(archive);
  assert.equal(out.get('Checkmarks.csv').length, 10 * 1024 * 1024);
});

test('a member over the per-entry cap is named, not silently dropped', () => {
  // A real Checkmarks.csv past 32MB, stored uncompressed. It used to be
  // `continue`d past, which left the only remaining evidence to `parseZipExport`
  // — and what it said was "zip does not contain a Checkmarks.csv", about a
  // file the user could see in the archive. The cap is not the bug; the
  // sentence was.
  const archive = zip([
    { name: 'Habits.csv', data: 'Position,Name\n0,Run\n' },
    { name: 'Checkmarks.csv', data: 'x'.repeat(33 * 1024 * 1024) },
  ]);

  assert.throws(() => unzip(archive), (err) =>
    err.status === 400 &&
    err.message.includes('Checkmarks.csv') &&
    /limit/.test(err.message));
});

test('one corrupt member does not abort the whole import', () => {
  // Deliberately distinct from the budget failure above: per-member damage is
  // tolerated, an over-budget archive is not.
  const archive = zip([
    { name: 'Habits.csv', data: 'Position,Name\n0,Run\n' },
    { name: 'Checkmarks.csv', data: 'Date,Run\n2026-01-01,YES_MANUAL\n' },
  ]);
  // Corrupt the first member's payload without touching the directory.
  const broken = Buffer.from(archive);
  const at = broken.indexOf(Buffer.from('Position,Name'));
  broken.writeUInt16LE(8, 8);   // claim deflate on data that is not deflated
  assert.ok(at > 0);

  const out = unzip(broken);
  assert.ok(out.has('Checkmarks.csv'), 'the intact member should survive');
});

/* ---------- existing defences must stay ---------- */

test('path traversal and absolute paths are refused', () => {
  for (const name of ['../escape.csv', '/etc/passwd', 'C:\\windows\\x.csv']) {
    const archive = zip([{ name, data: 'x' }]);
    assert.equal(unzip(archive).size, 0, `${name} should be skipped`);
  }
});

test('a non-zip is rejected outright', () => {
  assert.throws(() => unzip(Buffer.from('not a zip at all')),
    (err) => err.status === 400);
});
