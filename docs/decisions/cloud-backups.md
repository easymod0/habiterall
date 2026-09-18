# Scheduled backups in the cloud edition (#75, #194)

Why the dump is instance-level, what role it needs, and the four
mechanisms that keep one crashed run from costing the next. The rules are
in `habiterall-cloud/CLAUDE.md`; this is what was measured behind them.

**The dump used to run inside a multi-replica `app`, with nothing here
serialising it across processes — that race is now removed by DEPLOYMENT
SHAPE, not by a lock, and the difference matters.** Since #194 the tick, the
gateway and this dump all run in the singleton `notifier` container (see
above), so the no-two-runs-at-once guarantee — `inFlight` and
`lastAttemptDate`, both **per-process module state**, exactly as before — is
now sufficient on its own: there is exactly one process left for it to be
true of. That guarantee still cannot coordinate a SECOND process by
construction, which is precisely why "run exactly one `notifier`, ever" above
is a rule and not a suggestion — scaling `notifier` would reopen the same race
this section used to warn about. Each run's temporary file carries a random,
per-run suffix rather than a fixed `.tmp` name, so two notifiers can no longer
interleave their bytes into one corrupt file logged as `backup.ok` on both
sides, but that fix only ever removed the CORRUPTION, not the RACE: two
processes both pointed at one `HABITERALL_BACKUP_DIR` would still both see
`todaysFileExists` false, both dump the whole database, and both `renameSync`
onto the same final name — one wins, one's work is simply thrown away.

**A crashed run's own `.tmp` is reclaimed at the START of the next run, and
only because of an age gate.** The per-run UUID suffix above stopped a `.tmp`
from being overwritten by a second writer, but it also made a crashed run's
leftover un-namable by anything ever again — invisible to `prunableBackups`
(anchored, deliberately) and to `todaysFileExists`, so `HABITERALL_BACKUP_KEEP`
stopped bounding it and a dump-sized file per crash sat on the volume forever.
`reclaimStaleTmp` deletes one only once it is older than
`BACKUP_TIMEOUT_MS + KILL_GRACE_MS` — this module's own upper bound on how
long a LIVE run can hold its `.tmp` open — so by construction nothing that old
can belong to a run still in progress, and reclaiming it can never race a live
writer the way a blanket "delete any `.tmp`" would.

**A fix round following review of 13aa15d changed two things worth reading
before touching this file again, because neither is visible from the diff
alone:**

- **`backupConfig` is deliberately free of logging side effects.**
  `GET /backup/status` calls `backupEnabled()` -> `backupConfig()` on every
  request, so a version of `backupConfig` that logged `backup.admin_url_missing`
  as a side effect of computing `enabled` meant any ONE of N tenants opening
  the "Backup and restore" dialog could drive an error-level line into the
  operator's log, repeatedly, in exactly the state this feature ships
  deliberately (a directory set before `DATABASE_URL_ADMIN` is added).
  `backupConfig` now only classifies what it found (`scheduleInvalid`,
  `keepInvalid`, `adminUrlMissing`, plus the raw values); `reportBackupConfig`
  is the separate function that actually logs, called exactly ONCE, at boot,
  from `server.js`, never from a route.
- **A write-stream failure now kills the child.** Without it, `pg_dump`
  writing to a destination that has started erroring (e.g. `ENOSPC`) blocks on
  its own `write()` once the OS pipe fills (64 KiB), and nothing notices until
  `BACKUP_TIMEOUT_MS` (two hours) finally kills it — for those two hours the
  child holds its `REPEATABLE READ` snapshot open, which pins the xmin horizon
  and bloats every table `pg_dump` has already touched, while `inFlight` blocks
  every later attempt for the rest of that window. `runBackup` now destroys
  `child.stdout` (closing the pipe's read end, so the child's next write fails
  with `EPIPE`) and sends `SIGKILL` the moment the write stream errors, rather
  than waiting on the timeout to notice.

