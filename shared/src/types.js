/**
 * Shared type definitions.
 *
 * This file exports nothing at runtime — it exists so JSDoc in the rest of the
 * codebase can reference one canonical shape via `import('./types.js').Habit`.
 * `shared` is the contract between three packages, and until now nothing
 * enforced it: a field renamed here would surface as a runtime bug in two
 * apps rather than a type error.
 *
 * Storage differences are deliberately reflected: SQLite has no boolean, so
 * `archived` is 0/1 there and a real boolean in Postgres.
 */

/**
 * @typedef {'boolean'|'numerical'} HabitType
 * A boolean habit is a daily checkmark; a numerical one records an amount.
 */

/**
 * @typedef {'at_least'|'at_most'} TargetType
 * Whether the target is a floor ("8 glasses") or a ceiling ("0 cigarettes").
 */

/**
 * @typedef {''|'skip'} EntryStatus
 * A skip is stored out of band, never as a magic value, because a numerical
 * habit may legitimately record the number 3 (Loop's SKIP sentinel).
 */

/**
 * @typedef {object} Habit
 * @property {number} [id]
 * @property {number} [user_id]        cloud only; absent in the personal edition
 * @property {string} name
 * @property {string} description
 * @property {HabitType} type
 * @property {string} unit             numerical habits only, e.g. "glasses"
 * @property {number} target_value     0 for boolean habits
 * @property {TargetType} target_type
 * @property {number} freq_numerator   n, in "n times per m days"
 * @property {number} freq_denominator m, in "n times per m days"
 * @property {string} color            #rrggbb
 * @property {string} [reminder_time]  local 'HH:MM', or '' for no reminder
 * @property {string} [reminder_message] what the reminder asks, e.g. 'Did you
 *   exercise today?'; '' falls back to a sentence built from the habit
 * @property {string} [at_most_unlogged] what a day with NO ROW is worth on an
 *   at-most target: 'miss', 'success', or 'default' to follow the account's
 *   `atMostUnlogged`. See `unansweredCounts` in stats.js
 * @property {string} [show_as]        'amount' or 'avoid' — how the habit is
 *   RENDERED. Presentation only; the verdict still comes from `target_type`
 *   and `target_value`. See SHOW_AS in validate.js
 * @property {number} [position]       display order
 * @property {boolean|0|1} archived    boolean in Postgres, 0/1 in SQLite
 */

/**
 * @typedef {object} Entry
 * @property {string} date             local calendar date, 'YYYY-MM-DD'
 * @property {number} value            boolean: 2 = yes.  numerical: the amount
 * @property {EntryStatus} [status]
 * @property {string} [notes]
 */

/**
 * An entry as the scoring functions accept it: either the full record, or a
 * bare number for legacy/boolean callers.
 * @typedef {Entry|{value:number,status?:EntryStatus}|number} EntryLike
 */

/**
 * @typedef {object} Streak
 * @property {string} start
 * @property {string} end
 * @property {number} length           inclusive day count
 * @property {number} skips            skipped days bridged inside [start, end]
 */

/**
 * @typedef {object} ScorePoint
 * @property {string} date
 * @property {number} score            0..1
 */

/**
 * @typedef {object} HistoryBucket
 * @property {string} bucket           'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY-Qn' | 'YYYY'
 * @property {number} completed
 * @property {number} total            opportunities, excluding skips
 * @property {number} value            summed amount, numerical habits only
 * @property {number} skipped
 */

/**
 * @typedef {object} WeekdayBucket
 * @property {number} weekday          0 = Sunday
 * @property {number} completed
 * @property {number} total
 * @property {number} value
 */

/**
 * @typedef {object} FrequencyBucket
 * @property {string} month            'YYYY-MM'
 * @property {Record<number, number>} counts   completions-per-week -> week count
 */

/**
 * @typedef {object} Stats
 * @property {number} score            latest strength, 0..1
 * @property {ScorePoint[]} scores
 * @property {Streak[]} streaks
 * @property {number} currentStreak
 * @property {number} bestStreak
 * @property {number} totalCompleted
 * @property {HistoryBucket[]} history
 * @property {WeekdayBucket[]} weekdays
 * @property {WeekdayMonthBucket[]} weekdayByMonth
 * @property {FrequencyBucket[]} frequency
 * @property {Resilience} resilience
 * @property {CoverageMonth[]} [coverage] absent when the caller declined it.
 *   `/overview` does, in both editions: it calls `computeStats` once per habit
 *   and keeps `score` and `currentStreak`, and coverage is its own pass over
 *   the window. See `computeStats`.
 */

/**
 * One month the stats window entirely contains, and how much of it was
 * ANSWERED — a row of any kind, including a skip and a stated lapse. `days` is
 * always the length of the month; see `computeCoverage` for why only contained
 * months are reported.
 * @typedef {object} CoverageMonth
 * @property {string} month            'YYYY-MM'
 * @property {number} answered         days holding a row
 * @property {number} days             days in the month
 */

/**
 * Weekday consistency within one month. `rate` rather than a raw count,
 * because months hold four or five of each weekday.
 * @typedef {object} WeekdayMonthBucket
 * @property {string} month   'YYYY-MM'
 * @property {Array<{weekday: number, completed: number, total: number, rate: number}>} days
 */

/**
 * How a lapse is distributed by length.
 * @typedef {object} MissBucket
 * @property {string} label            e.g. "4–6 days"
 * @property {number} min              shortest run in this bucket
 * @property {number} count
 * @property {number} share            0..1 of all lapses
 */

/**
 * One point on the survival curve.
 * @typedef {object} SurvivalPoint
 * @property {number} days             threshold length
 * @property {number} reached          streaks that got this far
 * @property {number} total            streaks whose fate at this length is decided
 * @property {number} share            reached / total, 0..1
 */

/**
 * How reliably a lapse is recovered from.
 * @typedef {object} Recovery
 * @property {number|null} rate        share of lapses lasting a single day;
 *                                     null when nothing has ever been missed
 * @property {number} recovered
 * @property {number} lapses           closed lapses only
 * @property {number} openRun          length of an ongoing lapse, else 0
 * @property {number} longest          longest CLOSED lapse, 0 when there is none
 * @property {string|null} lastEnd     last day of the most recent closed lapse
 */

/**
 * What happens after a miss. A "miss" is a day the habit fell below its rate,
 * so this applies at any frequency; `applicable` is retained because the
 * response shape is public, and nothing sets it false any more.
 * @typedef {object} Resilience
 * @property {boolean} applicable
 * @property {Recovery|null} recovery
 * @property {MissBucket[]} missDistribution
 * @property {SurvivalPoint[]} survival
 * @property {number} worstLapse
 */

/**
 * The result of writing a parsed backup into a database.
 * @typedef {object} ImportResult
 * @property {number} habitsCreated
 * @property {number} habitsMerged
 * @property {number} entriesImported
 * @property {string[]} skipped        human-readable reasons
 */

/**
 * A habit plus its entries, as produced by the import parsers.
 * @typedef {Habit & {entries: Entry[]}} ImportedHabit
 */

export {};
