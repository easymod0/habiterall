import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'public', 'style.css'), 'utf8');

/**
 * Regression guard for issue #231: `.check.before-start { opacity: 0.35 }`
 * sat in `style.css`, commented as dimming a day before the habit existed,
 * with nothing anywhere setting the class — dead from the day it was
 * written. See `shared/public/CLAUDE.md`'s "A day before the habit existed
 * was considered and declined, not lost" for the decision this guards.
 *
 * WHY this is allowed to exist, unlike the source-text regex
 * `css-hidden.test.js`'s own closing comment records deleting: that one read
 * a variable NAME out of JS source, so a rename broke the guard while the
 * behaviour it watched was never in danger — a source-text check on a
 * BINDING cannot see a rename. A CSS class selector and the string a script
 * sets on `className`/`classList` are not a binding and a reference to it;
 * they are the same literal spelled twice, on either side of a coupling that
 * has no indirection to rename through. The class and the selector can only
 * ever drift by being renamed TOGETHER (a class rename that misses one side
 * is exactly the bug this guard exists to catch), so there is no rename this
 * check is blind to the way a binding rename would be.
 *
 * THAT PREMISE COST TWO FAILED VERSIONS before this one, and both are worth
 * recording so a future reader does not repeat them. A bare word-boundary
 * match over raw source was tried first, then a scan of every string
 * literal in the file. Both were checked against the mutation that matters
 * — rename the real assignment in `ui/day-strip.js` from `' today'` to
 * `' istoday'`, i.e. actually break the wiring — and BOTH STILL PASSED,
 * because `today` is an ordinary English word: it occurs as a standalone
 * token in unrelated prose all over `shared/public/` (`'Jump to today'` in
 * `ui/detail.js`, `"1 habit still to answer today"` in `ui/nudge.js`,
 * `'today on the left'` in `ui/theme.js`, and more), so the guard passed
 * `.check.today` for a reason that had nothing to do with `day-strip.js`
 * setting it.
 *
 * WHAT is actually checked, and why it has to be this narrow: a class token
 * is set through `className` or `classList` (`.add`, `.toggle`, `.remove`,
 * `.replace`), so this looks only at LINES containing one of those and reads
 * their string literals, split into whitespace-delimited tokens. A literal
 * on a class-setting LINE is not a guarantee that literal is the class being
 * set — see the two counterexamples below — but a literal anywhere else in the
 * file (a comment, a URL, an error message, a UI label) is not even that
 * much evidence, which is the hole the two earlier versions had. Checked
 * against the same mutation: with `' today'` renamed to `' istoday'` in
 * `day-strip.js`, no class-setting line anywhere under `shared/public/`
 * carries the token `today`, and the guard fails, naming it.
 *
 * The claim "a literal on a class-setting line is the class" is ALSO not
 * exactly true, and both counterexamples are in this tree today:
 * `settings-dialog.js`'s `label.className = def.type === 'toggle' ?
 * 'checkbox' : '';` puts `toggle` — a setting TYPE being compared, never a
 * class — into the token set alongside the real class `checkbox`, on the
 * strength of sharing a line with `className`; and `dashboard.js`'s
 * `row.classList.contains('drop-below')` puts `drop-below` into the token
 * set from a READ, not a set. Both make the guard MORE permissive than it
 * claims — a hypothetical `.check.toggle` or `.check.drop-below` would pass
 * green — which is the same direction of error the vocabulary hole above
 * was, and is why the modifier `#231` actually named, `before-start`, and
 * the ~80-token real vocabulary of every class genuinely set in this tree
 * do not overlap: the guard still catches a modifier outside that
 * vocabulary, which is the case it exists for.
 *
 * WHAT this cannot see, split by which direction it is wrong in. Three are
 * loud false FAILURES — the guard names a modifier dead when a module does
 * set it, which sends a reader to look and cannot ship silently:
 *   - a class ASSEMBLED dynamically, e.g. a template literal that
 *     interpolates the modifier rather than spelling it
 *     (`` `check ${state}` ``);
 *   - a `className`/`classList` call whose class-bearing string literal
 *     sits on a DIFFERENT LINE from the `className`/`classList` token
 *     itself (a multi-line assignment or call);
 *   - a compound selector spelled in the other order, `.before-start.check`
 *     rather than `.check.before-start` — CSS treats them identically, this
 *     scan does not attempt to, and a real selector parser is more than
 *     this issue warrants.
 * One is a silent false PASS, and it is the accepted limit of a scan that
 * is not element-scoped: a modifier whose NAME collides with a class that
 * IS genuinely set, just on some other element entirely. `.check.dragging`
 * added to `style.css` today would pass, because `row.classList.add(
 * 'dragging')` at `dashboard.js:729` sets `dragging` on a habit row during
 * drag-and-drop reordering — nothing to do with a `.check` cell, but enough
 * to satisfy a check that only asks "is this token set somewhere," never
 * "on what." `.check.checkbox` and `.check.archived` pass the same way. The
 * guard's real claim is narrower than its assertion message states: not
 * "some module sets this on a `.check` cell," but "some module sets this
 * token on SOME element" — which is still what #231 needed, since
 * `before-start` was not merely set on the wrong element, it was not set at
 * all, and every other modifier this guard has ever had to catch a real bug
 * about has been the same kind of case.
 *
 * No behavioural test accompanies this one. Every candidate is vacuous here:
 * nothing set `.check.before-start` before #231 and nothing sets any
 * `.check.<modifier>` class this guard doesn't already know is set, so an
 * assertion about a rendered cell's appearance would pass identically
 * against a tree with the dead rule still in it — the "test that cannot
 * fail" the root CLAUDE.md warns against.
 */

/** Every `.js` file under `shared/public`, recursively. */
function jsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Every whitespace-delimited token found inside a string literal
 * (single-quoted, double-quoted or a template literal), but only on lines
 * that mention `className` or `classList.` — a class token is set through
 * one of those, so a literal anywhere else in the file is not evidence a
 * class was set, only that the word appears somewhere. Line-oriented and
 * adequate rather than a real parse — it does not understand escapes, it
 * cannot tell a literal being ASSIGNED from one merely being COMPARED
 * against on the same line, and it cannot see a `className`/`classList`
 * call split across lines (see the "WHAT this cannot see" note above).
 */
function classSettingTokens(src) {
  const tokens = new Set();
  for (const line of src.split('\n')) {
    if (!line.includes('className') && !line.includes('classList.')) continue;
    const literals = line.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || [];
    for (const lit of literals) {
      const inner = lit.slice(1, -1);
      for (const tok of inner.split(/\s+/)) {
        if (tok) tokens.add(tok);
      }
    }
  }
  return tokens;
}

test('every .check-qualified CSS modifier is a class some module actually sets', () => {
  // Captures the WHOLE chain of modifiers directly after `.check`, not just
  // the first — `.check.today.before-start` must check both `today` and
  // `before-start`, which a `matchAll` that captured only one modifier per
  // match would silently skip past (the `g` flag resumes scanning after the
  // whole match, not after the first modifier). The chain requires an
  // immediate `.`, so a DESCENDANT selector breaks it correctly:
  // `.check.today .check-day` has a space before `.check-day`, so the chain
  // started by `.check` stops after `today` and `.check-day` is never
  // reached by this pattern at all (it does not itself start with
  // `.check.`). `.checks`, `.check-box` and `.checkbox` are excluded the
  // same way the single-modifier version excluded them: the character right
  // after `check` has to be a literal `.`.
  const modifiers = new Set();
  for (const m of css.matchAll(/\.check((?:\.[A-Za-z0-9_-]+)+)/g)) {
    for (const part of m[1].split('.')) {
      if (part) modifiers.add(part);
    }
  }
  assert.ok(modifiers.size > 0, 'expected to find at least one .check.<modifier> rule');

  const jsFiles = jsFilesUnder(join(root, 'public'));
  const tokenSets = jsFiles.map((f) => classSettingTokens(readFileSync(f, 'utf8')));

  for (const modifier of modifiers) {
    const isSet = tokenSets.some((tokens) => tokens.has(modifier));
    assert.ok(isSet,
      `style.css declares ".check.${modifier}" but no class-setting line (one ` +
      `mentioning className or classList.) in any module under shared/public/ carries ` +
      `"${modifier}" as a token. Either the rule is dead and should be deleted along ` +
      `with any comment that explains it (see shared/public/CLAUDE.md's "A day before ` +
      `the habit existed was considered and declined, not lost" for how #231 did ` +
      `this), or the class was meant to be set and the wiring that sets it is missing.`);
  }
});
