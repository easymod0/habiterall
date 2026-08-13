# Screenshots

All of these are the real app. Nothing here is a mockup, a mock, or a redraw —
if a control is in a screenshot, it works.

**Where the data came from.** A personal-edition server seeded with the browser
suites' sample habits (`shared/test/browser/fixtures.mjs`): a daily yes/no habit,
a 3×/week one, an *at least 20 pages* measurable habit, and an *at most 0* one.
That is deliberate — the same four habits the tests assert against, so a
screenshot cannot show a state the app never produces.

**Web** — headless Chrome over the DevTools protocol, `deviceScaleFactor: 2`, at
1280px wide (desktop) and 390px (mobile), clipped to the element rather than the
viewport. Driven through the same launch/teardown the browser suites use
(`shared/test/browser/chrome.mjs`), so it cannot leak a browser either.

**Android** — `adb exec-out screencap` on an API 36 emulator running a debug
build. `android-reminder.png` is a real reminder: a habit's time set two minutes
out, the app restarted to arm the alarm, and the shade opened when it fired.

`shared/test/readme-assets.test.js` fails if a file here stops being referenced
by the README, if the README points at one that is missing, or if an `<img>`
loses its alt text. Retaking one is fine; renaming it without updating README.md
is what that test is for.
