# Discord reminders and interactions

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**Buttons in Discord need a bot; a webhook cannot carry them.** Discord accepts
`components` on an *application-owned* webhook only, so the plain channel
webhook anyone can create is text-only, permanently. Bot mode therefore exists
alongside it rather than replacing it: with `DISCORD_BOT_TOKEN` and a channel id
the reminder gets Yes / No / Skip and a number modal; with only a URL it gets
the same text as before. `sendToChannel` picks, and `CHANNELS.discord.ready` is
why "configured" is a predicate rather than a list of required keys.

**Interactions arrive over a WebSocket, not an HTTP endpoint.** Discord will
call an endpoint if you have one, but a self-hosted instance behind a router has
no inbound port and no hostname — requiring one would mean the interactive
reminders only worked for people who had already solved a harder problem. The
outbound socket in `shared/src/discord-gateway.js` needs nothing. It is also why
no request-signature verification appears anywhere here: a socket is
authenticated once, by the token.

**The bot token is an environment variable, never a setting.** It can post to
every channel the bot is in, and `GET /api/settings` hands settings to the
browser — so a stolen session would exfiltrate the operator's token. The channel
id *is* a setting, because it is per user and worth nothing on its own.

**A button press is authorised by the CHANNEL it came from, not by its
`custom_id`.** The id carries a habit and a date because that is all Discord
gives back, and it is trusted for neither: `resolveChannel` decides whose data
is written, and the habit is then looked up inside that account, so a forged id
finds nothing. `discordUserId` narrows it further to one Discord user — without
it, anyone who can see the channel can answer.

**A press is acknowledged before any storage is touched.** Discord allows an
interaction three seconds, and answering one used to be the LAST thing
`handleInteraction` did — after resolving the channel, asking what day it is
there, and recording. Three round trips through a database, under RLS on the
cloud side; on a cold pool or a container that has just started that is over the
line, and the user is shown **"This interaction failed"** on a press that *was*
written. The worst kind of failure message: it says the opposite of what
happened, and the natural response is to press again. So the first thing out is
`DEFER_UPDATE` (type **6**, not `DEFER`'s 5 — 6 leaves the message alone, where
5 posts a visible "thinking" placeholder that would then need cleaning up), and
the real answer follows on the same token, good for fifteen minutes.
`respondInteraction` takes `acknowledged` and picks the endpoint: the callback
first, then `PATCH …/messages/@original` for an edit or `POST …/webhooks/{app}`
for a private note — chosen from the response shape the handler already built,
so everything above that line reads the same either way. `application_id` rides
on the interaction, so this needs no extra call and still no bot token.

One consequence of deferring is that the *old* failure mode was at least
visible: an unanswered interaction showed "This interaction failed", which was
wrong but loud. A type-6 defer has no loading state to time out, so an uncaught
throw afterwards leaves the reminder sitting unchanged and the press looking
like it did nothing. The `try` therefore wraps **all** the storage — a pool that
has gone away takes `resolveChannel` and `today` down as readily as `record` —
and the defer itself is wrapped too, so a failure to acknowledge cannot skip the
write it exists to protect. Deferring also requires `application_id`: without it
the follow-up would post to `/webhooks/undefined/…` after spending the callback.

Two exceptions, and both are deliberate. **A modal cannot be deferred at all** —
it has to be *opened* inside the three seconds, and a callback of type MODAL is
the only way to open one — so the `amount` button keeps its lookup-and-answer
shape; it does one read and no write. And the **test button** touches no storage.
Note the ordering this costs: it is removing the buttons that stops a second
click recording twice, and a defer delays that, so the buttons stay live while
the write is in flight. `record` is an upsert for every action, so a double press
is idempotent and the window costs nothing.


