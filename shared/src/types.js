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
 * @property {FrequencyBucket[]} frequency
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
