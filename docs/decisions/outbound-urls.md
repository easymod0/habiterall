# Outbound URLs: Discord webhooks, ntfy, the gateway

Long-form reasoning moved out of `CLAUDE.md` (2026-08-17) to keep that file
under the size that is loaded into every session. Nothing here is loaded
automatically; the operative rules live in the nearest `CLAUDE.md`.

**A user-supplied URL that the server fetches is a request-forgery
primitive.** `parseDiscordWebhook` allowlists Discord's hosts, requires HTTPS,
rebuilds the URL from the parts it checked, and the sender refuses redirects.
Without the host check, `discordWebhook` aims the server at cloud metadata or a
port on its own network and reports the result as a status code.

**...and the second destination could not reuse that check, because there is no
host list anybody here could write.** ntfy's whole point is that most people run
their own, so `parseNtfyUrl` cannot name four hosts the way
`parseDiscordWebhook` names Discord's. What it can do is notice that there are
two people in this — one who runs the server and one who types the URL — and
that on the cloud edition they are **not the same person**. Which networks this
process may be aimed at is the operator's question, so it is answered where
operators answer things: `NTFY_ALLOWED_HOSTS`, defaulting to `ntfy.sh` alone,
naming your own **replaces** that rather than adding to it, and `off` refuses
every URL — a way to switch the destination off for a whole instance that still
tells the user why rather than silently doing nothing.

**An allowlist entry names a host and optionally a BASE PATH, and that second
half is what makes this equivalent to the Discord rule rather than merely
similar to it.** The property worth copying from `parseDiscordWebhook` is not
"it checks the host", it is that allowlisting a destination allows **one KIND of
request** — because it pins the path too. The first version of this allowed any
1–4 dotless segments and posted to everything but the last, which with the
reverse-proxy deployment our own docs recommend meant
`https://example.com/internal/admin/reset/x` was a JSON POST to
`https://example.com/internal/admin/reset/`, carrying a chosen title, 4000
characters of chosen body and a chosen bearer token, with the response status
handed back to the user as prose through `notify_status` and repeatable on
demand from the test button. A path and service enumeration oracle, for any
account, on the operator's own network. So `example.com/ntfy` is an entry, a
user's URL may append **exactly one topic segment** to what the operator named,
and a bare `ntfy.sh` permits `https://ntfy.sh/<topic>` and nothing deeper. The
depth is one and not configurable because the topic is the only part of the URL
the operator cannot know in advance; a deployment that needs more says so by
naming more base.

Two details in that comparison are load bearing and neither is the obvious one.
It is a **whole-segment** match — `Set.has` on the joined base — never a string
prefix, or `example.com/ntfy` would also allow `/ntfyadmin`. And the stored URL
is rebuilt with the **entry's** spelling of the base path, so what gets fetched
is the path the operator wrote and the caller's casing decides nothing but the
topic's.

The rest of the shape is the same and each clause is load bearing: **https
only**, because a reminder carries a habit's name and a token would ride beside
it; **no credentials**, since `https://ntfy.sh@evil.test/x` has a host of
`evil.test` and reads as the opposite to a person; the host matched **whole and
with its port** — never a suffix test, because `evilntfy.sh` ends with `ntfy.sh`
— so allowing a host does not allow every service on it or every host that ends
like it; segments containing **no dots at all**, which makes `..`
unrepresentable rather than filtered; and the URL **rebuilt from the parts that
were checked**. Note what is deliberately not on the hostile list:
`https://ntfy.sh/a/../b` is accepted as `https://ntfy.sh/b`, because `new URL`
resolves traversal before any of this sees it — the resolved path is one segment
on an allowed host, so there is nothing to escape from, and the dotless segments
are what guarantee no second normalisation can follow the check.

**DNS rebinding is closed by construction, which is why no IP pinning appears
here.** The gap between checking a name and connecting to it is only reachable
by an attacker who can introduce a name whose resolution they control, and every
name in this allowlist was chosen by the OPERATOR. Pinning an address would buy
nothing and break every ntfy behind a load balancer.

**A malformed entry fails closed, and says so once.** `*`, `*.example.com`,
`.example.com`, `https://ntfy.sh`, a bare comma — none of them allow anything,
which is the right direction and was worth pinning rather than assuming, since a
wildcard nobody implemented must not read as one that works. Dropping it in
silence was the wrong half: the only surface for the typo was a user's URL
snapping back to blank, which reads as an app bug and gets reported as one, by
somebody who cannot fix it. `notify.ntfy_allowlist_unusable` is the operator's
copy of that news, through the same `once` dedupe as `too_late`. The one
fail-OPEN value is **blank**, which is the `ntfy.sh` default — deliberate, and
worth knowing because the shipped compose files interpolate
`${NTFY_ALLOWED_HOSTS:-}`, so an operator who leaves the template line empty
gets it. Both `.env` templates say so in capitals.

**The stored value is not the last word, because the allowlist is not the
user's.** `postNtfy` asks `ntfyTarget` again at the moment of sending — the
WHOLE rule, base path included, not just the host: an operator can narrow
`NTFY_ALLOWED_HOSTS` months after somebody saved a URL, and a check that only
ran at write time would leave this process connecting somewhere it has since
been told not to. The refusal is `permanent`, since nothing about it changes
until a setting or the environment does, and its sentence names the variable —
that string is what the settings dialog shows, under the rule that the wording
is the sender's own.

**The two server-sent channels are not alike about rate limits, and the tick is
shared.** Discord limits per webhook, so a 429 is one account's own doing and
the inline `Retry-After` sleep in `deliverAccount` is paid by whoever caused it.
ntfy.sh limits per **visitor IP**, which for a server-sent reminder is the
instance — one bucket for every tenant on it — so on the cloud edition one
account can put that sequential loop to sleep on everybody else's behalf. Noted
at the sleep rather than fixed there: the tick's shape predates this and
restructuring it is its own change.

**A reminder is published as JSON to the ntfy SERVER, not as headers to the
topic.** The two are equally documented and only one is safe: publishing to the
topic URL puts the title in a `Title:` header, and a habit name is free text —
the same `\r\n` that made a Loop export's `X-Habiterall-Export-Skipped`
count-only, with a worse sink. So `ntfyTarget` splits the stored URL into the
endpoint and the topic (which is also what lets an ntfy proxied under
`/ntfy/` work), and the only header this builds is the optional `Authorization`,
whose value is refused outright if it could not go in one.

**It ships as `interactive: false`, and that is a decision rather than a gap.**
ntfy can carry action buttons and they would work — as an HTTP request the
SUBSCRIBER's device makes at this server, from wherever that phone is, carrying
what the notification told it to. That is an unauthenticated inbound endpoint,
which is exactly what `discord-gateway.js` exists to avoid, and the rule that
saves the Discord buttons has no counterpart: *a press is authorised by the
CHANNEL it came from* needs a channel to resolve an account from, and an ntfy
topic is a URL somebody typed. A test pins the flag so turning it on has to be
deliberate.

Two smaller consequences. Both keys are **unportable** — a topic URL is a bearer
capability exactly as a webhook is, and on a public ntfy it is a bearer
capability to *subscribe*, so a backup carrying one hands over every future
reminder. And the phone's `notMirrored` gained both with a reason that is
sharper than Discord's: ntfy HAS an Android app, so "the phone is involved" is
true and still does not make this a value habiterall's own client reads — the
subscriber is ntfy's app and the publisher is the server.

**The gateway's own frames are remote input too, and two of them steer this
process.** A settings URL is the obvious case; the socket is the one that reads
as trusted because it was authenticated. It is not: `resume_gateway_url` in READY
says where the NEXT socket opens, and the RESUME frame it then sends carries the
bot token — so `resumeTarget` applies `parseDiscordWebhook`'s reasoning one step
out, suffix-matching `*.discord.gg` / `*.discord.com` (the value is regional and
the regions are not enumerable from here) and rebuilding the URL from the host
alone. Falling back to the published gateway costs a fresh session and nothing
else, which is why a rejected value is not an error. HELLO's
`heartbeat_interval` is the same shape of problem with a different sink: it sets
a timer in this process, so anything outside 1s–10min takes Discord's published
default instead of being clamped to the nearer bound. Ungated, a `1` is a busy
loop starving the reminder tick that shares the event loop.


