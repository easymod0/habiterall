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
 * @property {string} [icon]           one grapheme, decided by `parseIcon` in
 *   validate.js; '' means none. Never a second name field
 * @property {number} [position]       display order
 * @property {boolean|0|1} archived    boolean in Postgres, 0/1 in SQLite
 * @property {number|null} [category_id] which Category this habit belongs
 *   to, or null for uncategorised. A habit PUT REPLACES, so an absent value is
 *   a stated clear — see `parseHabit` in validate.js. At most one category per
 *   habit; grouping a list needs a partition, not a set of memberships
 */

/**
 * @typedef {object} Category
 * @property {number} id
 * @property {number} [user_id]        cloud only; absent in the personal edition
 * @property {string} name
 * @property {string} color            #rrggbb
 * @property {number} [position]       display order
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
 *   Coverage is its own pass over the window, worth declining for a caller
 *   that does not read it — see `computeStats`. `/overview`, in both editions,
 *   no longer calls `computeStats` at all: it calls `summaryStats` once per
 *   habit and keeps `score` and `currentStreak`.
 */

/**
 * The two fields `/overview` keeps, computed by `summaryStats` rather than
 * `computeStats` because the dashboard reads only these two of the eleven the
 * detail view's whole reading returns.
 * @typedef {object} SummaryStats
 * @property {number} score            latest strength, 0..1
 * @property {number} currentStreak
 */

/**
 * A category's strongest or weakest member, named rather than linked: the
 * comparison view links to no habit, because `ui/routes.js` tracks `ourEntry`
 * as a single boolean and `go(LIST)` unwinds by `history.back()`, which assumes
 * the entry underneath a habit is the dashboard.
 * @typedef {object} CategoryMember
 * @property {number} id
 * @property {string} name
 * @property {number} score            that member's strength at `end`, 0..1
 */

/**
 * The mean, spread and n over one set of category members, at a single
 * reading — what `summariseMembers` returns. The same shape `CategorySection`
 * carries for its own aggregate figures, factored out so a second caller can
 * ask the identical question without re-implementing which members count.
 * @typedef {object} MemberSummary
 * @property {number} members          rows handed in, landed or not
 * @property {number} unloggedExcluded members that have NEVER been logged,
 *   counted here instead of averaged in as a zero
 * @property {number|null} mean        equal weight per habit, over the
 *   members that have landed; null when none have, never 0
 * @property {CategoryMember|null} best
 * @property {CategoryMember|null} worst
 */

/**
 * One row of `summariseByCategory` — a `MemberSummary` named by category id.
 * `id: null` is Uncategorised, always present and always last, the same
 * convention `CategorySection` uses for the same reason.
 * @typedef {object} CategorySummaryRow
 * @property {number|null} id
 * @property {number} members
 * @property {number} unloggedExcluded
 * @property {number|null} mean
 * @property {CategoryMember|null} best
 * @property {CategoryMember|null} worst
 */

/**
 * One bucket of a category's aggregate strength, on the axis shared by every
 * category in the same response.
 * @typedef {object} CategorySeriesPoint
 * @property {string} bucket           as `HistoryBucket.bucket` spells it
 * @property {number|null} value       mean strength of the members that had
 *   landed by this bucket; null when none had
 * @property {number} members          how many members that mean is over — an
 *   absent member is never counted as 0
 */

/**
 * One row of a category comparison. `id: null` is Uncategorised, which is
 * always present and always last and carries no name or colour of its own —
 * naming it belongs to the view, as it already does on the grouped dashboard.
 * @typedef {object} CategorySection
 * @property {number|null} id
 * @property {string|null} name
 * @property {string|null} color
 * @property {number} members          habits in this category, archived aside
 * @property {number} archivedExcluded archived habits in THIS category, left out
 *   of `members` and every figure below it. Its own count rather than a share of
 *   the payload's total, because a section whose habits are all archived and one
 *   nobody has filled both arrive with `members: 0` and are different sentences
 * @property {number} unloggedExcluded members that have NEVER been logged,
 *   which have no strength rather than a strength of zero: counted here instead
 *   of averaged in, so adding a habit never moves a figure downward. Not
 *   "nothing in the fetched slice" — an abandoned habit has a real strength
 *   near zero and is in the mean. See `computeCategoryStats`
 * @property {number|null} mean        equal weight per habit, at `end`, over
 *   the members that have landed; null when none have, never 0
 * @property {CategoryMember|null} best
 * @property {CategoryMember|null} worst
 * @property {CategorySeriesPoint[]} series always ends at `mean`
 * @property {number|null} recoveryRate mean of the members whose rate is a
 *   number; null when no member has one
 * @property {number} recoveryExcluded members whose rate was null — no CLOSED
 *   lapse in the window, whether because nothing was ever missed, nothing was
 *   ever logged, or the only lapse is still open. Not the same claim as 100%
 */

/**
 * Which of an account's categories is holding up, over one window.
 * @typedef {object} CategoryStats
 * @property {string[]} buckets        the axis every `series` is drawn on
 * @property {number} archivedExcluded archived habits left out of every figure,
 *   account-wide; each section carries its own count as well
 * @property {CategorySection[]} categories
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
