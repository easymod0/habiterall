# Answering an ntfy reminder from the shade

`shared/CLAUDE.md`'s ntfy section states the current rule tightly: the button
now comes to us, an HMAC over `(account, habit, date, action, value)`
authorises the write, and `interactive` is a predicate on `appUrl`. This file
is the reasoning that does not fit there — the refusal it reverses, why each
half of that refusal did or did not survive, the four button-table decisions,
and the two implementation choices (the query string, the inline limiters)
that look like style and are not.

## The original refusal, in its two clauses

The pre-existing comment on `CHANNELS.ntfy` (and the "It ships as `interactive:
false`" paragraph this replaces) gave two reasons, and they are not the same
reason twice:

1. **An ntfy action button is an HTTP request the SUBSCRIBING DEVICE makes** —
   to a URL written into the notification payload, from wherever that phone
   happens to be. Building an inbound endpoint to receive it means this server
   standing up unauthenticated HTTP that anything able to reach it may call.
   That is precisely the shape `discord-gateway.js` exists to avoid: a
   self-hosted instance behind a home router has no inbound port and no
   hostname, so the endpoint has to exist at all for the feature to work — and
   once it exists, something has to say what a request to it may do.
2. **The rule that saves the Discord buttons has no counterpart here.**
   `handleInteraction` trusts the *channel a press arrived on*, not the
   `custom_id` on the button — `resolveChannel` decides whose account is being
   written to, and only then is the habit id on the button looked up, inside
   that account. That works for Discord because a channel is something the
   user configured with the bot present to observe it. An ntfy topic is a URL
   somebody typed into a text field; there is no channel-shaped thing to
   resolve an account from, and no gateway watching who is in it.

Both were correct descriptions of the design as it stood. Neither is an
argument against buttons in general — they are arguments against two specific
half-designs, and the question worth re-asking periodically is whether either
half is still true of the design on the table.

## Why clause 1 dissolved

It dissolves the moment the button's request target is not "wherever ntfy
tells the phone to send it" but **our own route**. The endpoint this PR adds,
`POST /notify/ntfy/answer`, is exactly the unauthenticated inbound HTTP surface
clause 1 described — that part was never avoidable, because *something* has to
receive the phone's request and there is no session to require. What changed
is that "unauthenticated" stopped meaning "un-authorised": the request carries
a token that is itself the authorisation, checked before anything it names is
trusted. An inbound endpoint that accepts a bearer capability is a completely
ordinary shape (it is what a webhook secret or a signed upload URL is), and it
was available the whole time — the original design simply never proposed
carrying one, because the obvious version of "ntfy has buttons" is one where
the button's URL and the reminder's authority are the same thing, and they do
not have to be.

Nothing about `discord-gateway.js`'s reasoning is wrong; a *webhook-only*
Discord destination has exactly the same gap this ntfy button used to, and
picks up no inbound surface at all because it never has buttons. The gateway
exists so bot mode does not need one. ntfy has no equivalent to a gateway
socket — there is nothing living on a public server for a self-hosted
subscriber to maintain a connection to — so for ntfy the inbound endpoint is
the only shape available, and the question was always whether it could be made
safe rather than avoided.

## Why the HMAC answers clause 2, and what its bounded worst case is

Clause 2 is a real gap and stays real: there is no channel here, no gateway,
nothing watching who typed the topic URL in. The code has to do the entire job
`resolveChannel` + the in-account habit lookup did for Discord, by itself.

`signNtfyAnswer` / `verifyNtfyAnswer` (`shared/src/ntfy-answer.js`) are built so
that job is answerable from the token alone, with no state to consult first:

- The **key is derived**, `hmac_sha256(secret, 'habiterall/ntfy-answer/v1')`,
  never the raw session secret. A code is handed to arbitrary phones over
  arbitrary networks; the session secret protects login cookies, a much larger
  blast radius, and a derived key means a compromised or misused ntfy code
  gives an attacker nothing usable against session signing. This is the same
  domain-separation reflex as hashing a password with a per-purpose key rather
  than reusing a secret that does something else.
- The **MAC is verified before anything is parsed out of the payload** — a
  timing-safe compare on fixed-length buffers, length-checked first because
  `timingSafeEqual` throws rather than returning false on a length mismatch.
  Parsing first and verifying after would make the parser itself an oracle:
  a payload that fails to parse in one way versus another leaks structure to
  an attacker who has not yet proven they are allowed to make claims about the
  structure at all.
- **After** the MAC verifies, the payload gets the same shape checks Discord's
  `parseAction` already does on its own callback — `action` in `ACTIONS`,
  `date` matching `DATE_RE`, `habitId` a positive safe integer, `value` `null`
  or a finite number `>= 0`. The MAC establishes provenance (this payload was
  built by us, unaltered) but says nothing about whether the fields inside it
  are the shape the rest of the system assumes; ntfy having no counterpart to
  that second check was an asymmetry with no reasoning behind it, not a
  decision.
- **No expiry field.** The date already in the payload IS the expiry — a
  reminder for 2026-08-01 has no reason to still be answerable in October, and
  adding a second timestamp to expire on would be a second clock to keep in
  step with the first. `handleNtfyAnswer` applies `MAX_ANSWER_AGE_DAYS`
  (imported from `discord.js`, not redeclared — see below) against
  the account's own `today`, so what "too old" means is asked in the same zone
  the reminder itself was sent in.
- **The forged-code and unknown-account paths return the identical 403.** A
  request naming an account id that does not exist gets no different answer
  from a request with a mangled MAC — otherwise the endpoint is an oracle an
  attacker could use to enumerate which numeric account ids exist at all, one
  guess at a time, with no rate cost beyond the limiter's.

What this buys is a **capability**, in the object-capability sense: the token
IS the authorisation, not a pointer to look one up. Its bounded worst case,
stated plainly, is what one leaked (or forwarded, or logged) code can do:

> Record one answer — Yes, No, Skip, or one specific amount — for one named
> habit, on one named date, for one named account. Nothing else. It cannot
> read anything back (there is no response body worth exfiltrating — success
> is a short confirmation string). It cannot enumerate habits, accounts or
> dates it was not told. It cannot be replayed to different effect, because
> every write this route makes is an upsert on `(habit, date)` — a second
> press with the same code lands the same value it already recorded. It
> cannot be used past `MAX_ANSWER_AGE_DAYS`, so a code that leaks long after
> its reminder aged out is already inert. And it authorises nothing outside
> `record()` — not settings, not habit creation, not deletion, not any other
> route.

That is a materially smaller blast radius than a stolen session cookie (every
habit, every date, every setting, indefinitely) or a leaked webhook secret
(post arbitrary text to the destination, indefinitely). It is closer in shape
to "somebody read your phone's lock-screen notification and tapped a button on
it" — which, notably, is a worse-shaped but PRE-EXISTING risk for the Android
and Discord buttons already shipped, and this design does not make that risk
larger; it extends the same shape to a third channel.

## Why the code rides in the query string, not the path

`NTFY_ANSWER_PATH` is a fixed literal (`/notify/ntfy/answer`); the code is
`?c=<token>`, never a path segment. Two independent reasons, both load
bearing:

- **`requestLog` in `observe.js` strips the query string before it ever
  reaches a log line** (`path: ... .split('?')[0]`, `observe.js:95`) — a
  deliberate choice made for cardinality, not for secrecy, but it has the
  useful side effect that a bearer code in the query string is *not* written
  to the access log by construction, where a code embedded in the path would
  be. Nothing about this route relies on that as its ONLY protection — the
  code is one-shot-bounded and upsert-idempotent regardless of who reads it —
  but it is a real second layer, free, from a rule that already existed for an
  unrelated reason.
- **A fixed path is what lets both the button-builder and the route mount
  import one shared constant with nothing to drift.** If the code were part of
  the path, the route would need a wildcard or a param matcher, which is one
  more place the two could disagree about the exact shape (trailing slash,
  encoding) of what is accepted versus what is built. `?c=` needs no such
  matching: the whole path is `NTFY_ANSWER_PATH`, always, and everything that
  varies is inert to the router.

## Why the limiter is inline in both editions, not through a switchable helper

The root `CLAUDE.md` already states the general rule this follows
(`HABITERALL_RATE_LIMIT=off` briefly reaching `/auth/login`, found by CodeQL).
Restated for this route specifically: `POST /notify/ntfy/answer` takes no
session and no Origin check can substitute for one here in the way it does for
a same-origin browser request, because the caller is a phone's ntfy client
making a bare `fetch` with no page behind it — the request legitimately carries
no `Origin` at all, and `sameOriginOnly` already has to let that through for
the Android client's sake. That means this route's ENTIRE defence against
someone hammering it with junk codes to find one that verifies, or against
using it to burn CPU on repeated HMAC checks, is the rate limiter. A route
whose only defence is its limiter is the last place that limiter should be
reachable through a helper that can return a pass-through, `off` or not —
static analysis stops being able to see through the indirection at exactly the
route where seeing it matters most. Both editions therefore write
`rateLimit({ ...RATE_LIMITS.ntfyAnswer, keyGenerator: byIp })` (or the
cloud equivalent, keyed on `ipKeyGenerator(req.ip)`) directly at the route
registration, beside a comment saying so, next to the existing comment that
says the same thing about the credential limiter.

Cloud keys on IP and not on the claimed account id in the payload for a
related reason: keying on the account would let anyone starve a CHOSEN
tenant's rate-limit bucket by sending garbage codes naming that tenant's id —
a denial-of-service on one victim's ability to answer their own reminders,
paid for by an attacker who need not guess anything about that victim beyond
their numeric id. IP is the only thing known about the caller before the code
is verified, so it is the only thing safe to key on.

## The ntfy.sh-vs-self-hosted ACL difference

The topic still gates who can *see* the reminder text and buttons at all — a
private or randomly-named topic is still worth having, still the first line of
defence, and nothing about this change weakens it. What changed is what
happens after someone can see a reminder.

A **self-hosted** ntfy server can be configured with per-topic access control:
an operator can require auth to subscribe to a topic, so "can see the topic"
already implies some vetting happened.

**ntfy.sh, the default and the common case, has no such control for an
arbitrary topic name** — anyone who knows or guesses the string subscribes and
sees everything published to it. Before this change that was an acceptable
risk because seeing the reminder was ALL that granted: the worst a topic leak
bought was someone else learning "this account has a reminder for Meditate at
08:00" and, previously, being unable to do anything with that beyond reading
it. After this change, seeing the topic also means seeing the buttons, and the
buttons carry live capabilities. So on ntfy.sh specifically, the HMAC is not a
second lock on a door that already had one — for that deployment, it is now
THE lock; the topic string alone answers "can you see it" and no longer has
any bearing on "can you act on it", which is exactly the intended shift. This
is also why `ntfyTopicUrl`'s help text in `ui/settings.js` says the anyone-can-
answer sentence plainly and singles out ntfy.sh's lack of a per-topic ACL,
rather than leaving it implied.

## The four button-table decisions

`ntfyActions` (`shared/src/ntfy-answer.js`) builds at most three buttons from
one small table. Each row was a real choice among alternatives, not the only
shape available:

1. **Skip takes the THIRD slot, and the midpoint is what drops, when
   `skipDays` is on** — for both plain at-least habits and `at_most`. The
   alternative was dropping the ZERO button instead, on the reasoning that "0"
   is closer to "no answer" than a positive count is. Rejected because zero is
   frequently the MOST common real answer for both shapes — "I had none of my
   at-most habit today" and "I haven't gotten to my at-least habit yet, don't
   count me as skipping" are both routine, ordinary presses, where Skip is
   comparatively rare. Losing the button people press most to make room for
   the one they press least would be a regression dressed as symmetry.
2. **The count threshold is an integer target `<= 10`,** above which (or for
   any non-integer target) there is no derived midpoint, only `0 / target`.
   The alternative — always deriving `round(target/2)` — breaks down exactly
   at a non-integer target (there is no sane "midpoint" of 2.5 that isn't
   itself a decimal a button then has to display) and gets less useful as the
   target grows: three buttons on a target of 200 offer 0, 100, 200, which is
   not meaningfully more actionable than 0 and 200 alone, while the row is
   already at its three-button ceiling. Ten was chosen as a small round number
   past which a fixed midpoint stops reading as "the natural halfway point"
   and starts reading as an arbitrary number nobody asked for.
3. **`at_most` habits are always `0 / 1 / 2`, whatever the actual limit.** This
   is deliberately NOT "0 / limit/2 / limit" — the point of an at-most habit's
   buttons is to make the SMALL, EARLY counts fast to record (did you have
   zero, one, or two of the thing you're limiting, today, so far), not to
   offer a button for "at the limit exactly", which for most at-most habits is
   already a failure state the user does not need a fast path to confirm. Over
   the limit is explicitly out of scope for the buttons (an "app trip" per the
   brief) — a limit of 2 does not get a button for 3, because the row exists
   to make staying under easy to log, not to make going over easy to log.
4. **`at_most` + `skipDays` is `0 / 1 / Skip`** — the TOP count (2) drops, not
   the bottom (0) and not the middle (1). This is the same reasoning as
   decision 1 generalised: an at-most habit counts UP from zero, so its most
   useful two numeric buttons are the low end, and its least useful is the one
   closest to the ceiling everybody is trying to stay under.

## Two other implementation notes worth recording here

**`ntfyPayload` never imports `ntfy-answer.js`,** and this is a cycle
avoidance, not a style preference: `ntfy-answer.js` imports `discord.js` (for
`MAX_ANSWER_AGE_DAYS`, deliberately reused rather than redeclared — see the
brief's own note that collapsing `discord.js`'s private `daysApart` into
`stats.js`'s exported `daysBetween` is a separate, tempting, and out-of-scope
tidy-up), and `discord.js` imports `notify.js`. A `notify.js -> ntfy-answer.js`
edge would close that into an import cycle. `postNtfy` in `notify-send.js`
sits above all three modules and is where the actions are built and handed to
`ntfyPayload`, which only ever receives a plain array it did not build.

**`signAnswer` travels the same route `botToken` and `appUrl` already do** —
bound to an account, passed into `startNotifier`, threaded through the tick's
payload build, and never read from `process.env` inside `shared/src`. This
mirrors the existing rule that `shared/src` has no edition-specific
configuration reads of its own; the edition is what knows where its secret
lives (`sessionSecret()` on personal, `process.env.SESSION_SECRET` on cloud),
and `shared/src` only ever receives a closure that already has it bound in.
