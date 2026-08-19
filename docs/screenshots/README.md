# Screenshots

All of these are the real app. Nothing here is a mockup, a mock, or a redraw —
if a control is in a screenshot, it works.

**Retaking the web set is one command:**

```bash
node scripts/capture-screenshots.mjs          # all of them
node scripts/capture-screenshots.mjs dashboard statistics
```

It starts a throwaway personal-edition server, seeds it, drives headless Chrome
and overwrites the PNGs below. Nothing is cropped or resized afterwards.

**Where the data came from.** The demo set in that script: six habits, each with
an icon, covering every shape the UI draws differently — a daily yes/no, a
3×/week one, an *at least 20 pages* measurable habit, and two *at most* habits
shown as things to avoid. Fourteen months of history, from a **seeded** PRNG
rather than `Math.random`, because a set of screenshots is compared by eye
against the last one and data that moves between runs makes every image differ
for no reason. (`habiterall-personal/scripts/seed.js` is random for the opposite
reason: a demo install wants variety.)

**Web** — headless Chrome over the DevTools protocol, `deviceScaleFactor: 2`, at
1280px wide (desktop) and 390px (mobile), clipped to a real
`getBoundingClientRect()` rather than to the viewport. Driven through the same
launch/teardown the browser suites use (`shared/test/browser/chrome.mjs`), so it
cannot leak a browser either.

Two framing rules are in the script because getting them wrong is silent. A
card-only shot **removes `.topbar` first**: it is `position: sticky`, and
`captureBeyondViewport` re-renders the page at the size of the clip, so the bar
sticks to the top of the *clip* and paints over the card's own title. And a shot
that opens a dialog is captured **without** `captureBeyondViewport`, because that
re-render does not preserve a nested scroll container — the rect was measured
with Notifications scrolled into view and the capture came back showing the
section above it, correctly framed on the wrong content.

**Android** — `adb exec-out screencap` on an API 36 emulator running a debug
build, cropped with ImageMagick. Not scripted: it needs an emulator, an APK and
the notification shade. `android-list.png` and `android-list-light.png` are the
same screen under `adb shell cmd uimode night yes|no`, which is what the app
reads (`isSystemInDarkTheme`) — it does not follow the account's theme setting.
`android-reminder.png` is a real reminder: today's entry deleted so the day is
unanswered, the habit's time set two minutes out, the app restarted to arm the
alarm, and the shade opened when it fired.

Note the native list shows no habit icons. The emoji is a web surface only —
`Api.kt` carries the field, no Compose screen reads it.

`shared/test/readme-assets.test.js` fails if a file here stops being referenced
by the README, if the README points at one that is missing, or if an `<img>`
loses its alt text. Retaking one is fine; renaming it without updating README.md
is what that test is for.
