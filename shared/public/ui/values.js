/**
 * The wire values an entry can carry, mirroring `shared/src/constants.js`.
 *
 * Declared again rather than imported because `shared/src` is not served to
 * the browser — only `shared/public` is mounted. `test/ui-modules.test.js`
 * fails if the two drift, the same arrangement `SETTING_VALUES` and the
 * settings registry already use.
 *
 * Three values, four states: the fourth is the ABSENCE of an entry, which no
 * constant can name. `UNSET` is a row that says "no" and a missing row says
 * nothing at all — see `ui/toggle.js`, which is where that distinction is turned
 * into what a tap does.
 */

export const UNSET = 0;
export const YES = 2;
export const SKIP = 3;
