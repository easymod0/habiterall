import { test } from 'node:test';
import assert from 'node:assert/strict';

const { EMOJI, previewIcon, searchEmoji } = await import('../public/ui/icon-field.js');
const { LIMITS, parseIcon } = await import('../src/validate.js');

/* ---------- previewIcon agrees with parseIcon, and both are pinned ---------- */

// Every case shared/test/validate.test.js:124-166 already exercises, plus a
// skin-toned emoji and the ZWJ family, each with its LITERAL expected value —
// agreement alone would pass if both functions were broken the same way.
const ZWJ_FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
const ZALGO = 'e' + '́'.repeat(200);
const SKIN_TONED = '\u{1F44D}\u{1F3FD}'; // thumbs up, medium skin tone

const EXAMPLES = [
  [ZWJ_FAMILY, ZWJ_FAMILY],
  ['\u{1F9D8} extra words here', '\u{1F9D8}'],
  ['7', '7'],
  ['運', '運'],
  ['a\nb', 'a'],
  ['a\r\nb', 'a'],
  ['‮evil', 'e'],
  ['', ''],
  ['\u{1F9D8}', '\u{1F9D8}'],
  [ZALGO, ''],
  ['ab', 'a'],
  [SKIN_TONED, SKIN_TONED],
  // The ONE witness for the `\p{Cc}` strip clause — `validate.test.js:145-158`'s
  // own comment says so, because `a\nb` above is decided by `.trim()` either
  // way and cannot tell "the strip set is right" from "the strip set is
  // missing \p{Cc}". Without stripping BEL (U+0007), `previewIcon('\u0007')`
  // would return the BEL itself rather than '' — the preview promising to
  // save a control character the server discards.
  ['\u0007', ''],
  ['\u0007' + '\u{1F9D8}', '\u{1F9D8}'],
];

test('previewIcon agrees with parseIcon over the shared example table', () => {
  for (const [input, expected] of EXAMPLES) {
    assert.equal(previewIcon(input), expected, `previewIcon(${JSON.stringify(input)})`);
    assert.equal(parseIcon(input), expected, `parseIcon(${JSON.stringify(input)})`);
    assert.equal(previewIcon(input), parseIcon(input),
      `previewIcon and parseIcon disagree on ${JSON.stringify(input)}`);
  }
});

test('the cap sits at exactly 32 UTF-16 units, both as a literal and against LIMITS.icon', () => {
  // Two assertions pulling in opposite directions, deliberately both present:
  // the LITERAL 32 is what pins previewIcon's own copy of the cap (the repo
  // rule that a test importing the constant it checks pins the name and
  // nothing else — EMOJI.length above does the same for the same reason),
  // and the import of LIMITS.icon is what makes a future change to that
  // constant fail LOUDLY here instead of leaving previewIcon's literal to
  // silently drift out of step with what the server actually enforces.
  assert.equal(LIMITS.icon, 32);

  const atCap = 'e' + '́'.repeat(31); // 1 + 31 = 32 UTF-16 units — kept
  const overCap = 'e' + '́'.repeat(32); // 1 + 32 = 33 UTF-16 units — dropped
  assert.equal(atCap.length, 32);
  assert.equal(overCap.length, 33);

  assert.equal(previewIcon(atCap), atCap);
  assert.equal(parseIcon(atCap), atCap);
  assert.equal(previewIcon(overCap), '');
  assert.equal(parseIcon(overCap), '');
});

/* ---------- the dataset itself ---------- */

test('every EMOJI glyph survives parseIcon unchanged', () => {
  for (const { glyph } of EMOJI) {
    assert.equal(parseIcon(glyph), glyph, `${JSON.stringify(glyph)} did not round-trip`);
  }
});

test('EMOJI has between 150 and 250 entries', () => {
  // Literals, not LIMITS.icon or any constant imported from the module under
  // test — a test importing the count it checks pins the name, not the range.
  assert.ok(EMOJI.length >= 150, `expected at least 150 entries, got ${EMOJI.length}`);
  assert.ok(EMOJI.length <= 250, `expected at most 250 entries, got ${EMOJI.length}`);
});

test('no glyph appears twice', () => {
  const seen = new Set();
  for (const { glyph } of EMOJI) {
    assert.ok(!seen.has(glyph), `duplicate glyph ${JSON.stringify(glyph)}`);
    seen.add(glyph);
  }
});

test('every entry has a name and at least one keyword', () => {
  for (const entry of EMOJI) {
    assert.ok(typeof entry.name === 'string' && entry.name.trim().length > 0,
      `${JSON.stringify(entry.glyph)} has no name`);
    assert.ok(Array.isArray(entry.keywords) && entry.keywords.length > 0,
      `${JSON.stringify(entry.glyph)} has no keywords`);
  }
});

/* ---------- search ---------- */

test('searchEmoji finds by keyword, returns everything for an empty query, and [] for no match', () => {
  const waterHits = searchEmoji('water');
  assert.ok(waterHits.length > 0, 'expected at least one hit for "water"');
  assert.ok(waterHits.some((e) => e.glyph === '💧'), 'expected the droplet among the water hits');

  assert.equal(searchEmoji('').length, EMOJI.length);

  assert.deepEqual(searchEmoji('xyzzyquux-not-an-emoji-concept'), []);
});

test('the curated vocabulary actually covers the habit concepts named in the issue', () => {
  const concepts = [
    'exercise', 'food', 'water', 'sleep', 'reading', 'money', 'cleaning',
    'meditation', 'medication', 'study', 'music', 'code', 'outdoors', 'social',
    'no-smoking', 'no-alcohol',
  ];
  for (const concept of concepts) {
    const hits = searchEmoji(concept);
    assert.ok(hits.length > 0, `no emoji found for concept "${concept}"`);
  }
});
