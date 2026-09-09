# Sharing, accountability, and what RLS costs here (#77)

Moved out of #77, which was *"filed so the idea is recorded with its costs
attached rather than rediscovered as 'just add a share button'"* — the sentence
that makes it a decision record rather than a work item. #77 stays as the feature
request. Nothing here is loaded automatically; the tenancy rules themselves are in
`habiterall-cloud/CLAUDE.md`.

The cloud edition is multi-user and every account is an island. Nobody can see
anyone else's habits, which is correct as a default and leaves out the single most
effective motivator a habit tracker has: somebody else knows.

Two versions, and they cost very different amounts.

- **Read-only sharing.** A habit (or a whole account) visible to one other user,
  or via a link. "My partner can see whether I went to the gym."
- **Accountability pairs.** Mutual, with a notification when the other person
  falls off, or a shared streak that breaks if either of you misses. Much more
  motivating and much more to design.

## Why this is expensive here, specifically

Row-level security is the tenancy model, and it is written around the assumption
that **a row has exactly one owner**. Every policy on the habit-shaped tables
says so, and the tenancy suite (`npm run test:tenancy`) exists to attack
precisely the assumption that sharing would relax.

That is the whole cost in one sentence: this is not a feature that gets bolted on
behind a flag. It changes what "yours" means at the layer that is currently the
security boundary — so the thing being modified is the guarantee, not a view over
it, and the suite that would have caught a mistake is the suite whose premise is
being edited.

**There is one existing non-owner read path, and it is the prior art to copy.**
#77 says *"every policy"*, which overstates it: `users_notifier_scan`
(`008_notify_log.sql`) is `FOR SELECT TO habiterall_app USING (app_is_notifier())`,
where `app_is_notifier()` is `app_current_user_id() IS NULL AND
current_setting('app.scope', true) = 'notifier'`. The notifier is the one job
that legitimately starts without a user — it has to ask who has a webhook
configured before it knows whose day to look at.

Its construction is the shape a share grant would take, and the migration's own
comment enumerates why it is safe: SELECT only, so nothing can be written through
it; `app_current_user_id() IS NULL`, so **the two conditions are mutually
exclusive by construction** and it can never widen a request already scoped to a
user; and it grants nothing on `habits` or `entries` — the scan yields user ids
and settings, and the reminders themselves are then read back through the
ordinary `withUser` path, policies and all.

**An observation this record adds, which #77 does not make:** a share is harder
than that policy in one specific way, and naming it is most of the estimate. The
notifier policy's condition is a *constant* per transaction — two settings, read
once — while a share's has to consult a grant table, per row, inside the policy,
which is where the cost and the audit surface both live. Unverified, and worth
measuring before it is quoted as a number.

The pattern itself, though — a second policy beside the owner one, mutually
exclusive with it by construction and reaching exactly the tables it needs — is
already in this repo and already tested.

## What has to be answered before any code

- **Who can grant, and what exactly is granted** — one habit or the account.
  Per-habit is the right answer and the more expensive one.
- **Revocation**, and what a revoked viewer keeps (nothing).
- **What a share sees**: entries and stats, or just the summary? Notes are
  attached to days and are often personal — a share that leaks notes by default is
  a bad surprise.
- **`/api/export`** — a share must not travel in a backup, and must not be granted
  by a restore.
- **Reminders.** "Tell me when they miss" is a new destination-shaped thing
  pointed at a *different account*, and `notify_log` cannot express it: its
  primary key is `(habit_id, channel, date)` in both editions, with no recipient
  in it at all. "Already sent today" is a fact about a habit and a channel, so
  two watchers of one habit are one row, and the second never gets told.
- **Personal edition.** It is single-user by definition, so this is cloud-only —
  the first feature that would be. Worth being deliberate about, because the
  editions sharing one core is the thing that keeps this project maintainable, and
  a cloud-only feature is a crack in that.

## Where it landed

**Not soon, and not because it is a bad idea** — it is probably the
highest-ceiling feature on the list. But it is the one where getting it wrong
exposes other people's data, and the tenancy guarantees are currently simple
enough to be testable.

A much cheaper 80% is worth considering first: **an export or a read-only summary
the user sends themselves** — a weekly digest to Discord or email (see the
notification-destinations issues), which they can forward to whoever they want to
be accountable to. No sharing model, no RLS change, most of the social pressure.

That is also the shape to reach for if the feature is re-proposed: the motivator
is "somebody else knows", and the expensive part is the *server* deciding who may
read a row. A digest the account owner sends gets the first without touching the
second.
