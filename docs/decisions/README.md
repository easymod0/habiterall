# Decision archive

Long-form reasoning moved out of the root `CLAUDE.md` on 2026-08-17, when that
file reached 175KB and stopped being loadable. **Nothing in this directory is
loaded into context automatically.** The operative rules — the invariant, and the
"this looks wrong and is deliberate" guard — live in the `CLAUDE.md` nearest the
code. What is here is the rest: how a rule was found, what was measured, which
wrong version shipped first, and which arguments were considered and refused.

Read the relevant file before re-opening a decision. Most objections to the rules
are already answered here, usually because they were the first thing tried.

| file | covers |
|---|---|
| `day-states.md` | the four day states, at-most habits, `show_as`, the score |
| `import-and-loop.md` | merge rules, Loop fidelity, parse ceilings, export skips |
| `awards.md` | the whole awards card, and what was refused from it |
| `dashboard-and-detail.md` | the `/overview` window, grid columns, `detailCards` |
| `settings-and-mirrors.md` | client mirrors, `notMirrored`, the theme record |
| `routing.md` | fragment routing, the deep-link flash, the WebView back stack |
| `android.md` | notifications, snooze, the home-screen widget |
| `notifications-web.md` | the `web` channel, the nudge, the settings dialog |
| `discord.md` | bot mode, the gateway, interaction handling |
| `timezones.md` | `resolveTimeZone` vs `callerDay`, the device clock header |
| `reminders.md` | the tick, `notify_log`, `notify_status`, the two warnings |
| `outbound-urls.md` | Discord webhooks, the ntfy allowlist, gateway frames |
| `ntfy-answers.md` | reversing "ntfy is notify-only": the HMAC capability, the button table, the query-string code, the inline limiters |
| `connectivity.md` | `/healthz`, the connectivity watcher, bounded requests |
| `auth.md` | the auth adapter, sign-in, sign-out, the security config |
| `amounts.md` | parsing a typed amount, `numberFormat` |
| `compose-and-env.md` | `extends`, the env templates, the discovery test |
| `testing.md` | the browser fleet: worker counts, the sleep audit, the theme split |
| `site.md` | habiterall.ca: why the wiki is generated from the README, the link check, the changelog source |
| `categories.md` | one category per habit, `ON DELETE SET NULL`, uncategorised as a state, the case-fold divergence |

The first sixteen files are the original prose verbatim, sliced by topic and
checked line-for-line against the pre-split `CLAUDE.md`; that split lost nothing.
`testing.md` came later, when the browser-suite measurements had grown to a third
of the root file's testing section with nowhere here to go. `site.md` came with
`site/` itself, which is new work rather than moved prose.

## Adding to this

Write the RULE where the code is. Come here only when the reasoning is long
enough to crowd it out and specific enough that someone will otherwise re-derive
it wrongly — a measurement, a refuted alternative, a bug whose shape is not
obvious from the fix. If a paragraph is mostly chronology ("a review caught this,
then the second version also broke"), it belongs here rather than in a
`CLAUDE.md`.
