/**
 * Validation and normalisation of user input, shared by both editions.
 *
 * These rules previously lived twice — once per edition — and had already
 * drifted: the cloud copy capped name/description/unit lengths and the
 * frequency denominator, the personal copy did not. Divergence in validation
 * is the worst kind, because it means data accepted by one edition can be
 * rejected (or silently truncated) by the other on import.
 *
 * Storage differences stay at the call site: SQLite has no boolean type, so
 * the personal edition maps `archived` to 0/1 itself.
 */

export const HABIT_TYPES = new Set(['boolean', 'numerical']);
export const TARGET_TYPES = new Set(['at_least', 'at_most']);

export const LIMITS = {
  name: 100,
  description: 500,
  unit: 20,
  notes: 500,
  /** A frequency period longer than a year is not a habit. */
  freqDenominator: 365,
};

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DEFAULT_COLOR = '#3b82f6';

/**
 * A validation failure carrying the HTTP status the API should return, so
 * callers can rethrow it directly without re-wrapping.
 */
export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

/**
 * Validate and normalise a habit payload.
 *
 * Returns a plain object with every field present and coerced. Throws
 * ValidationError for input that cannot be repaired; silently clamps input
 * that can (over-long text, unknown enum values).
 *
 * @param {Record<string, any>} [body]
 * @returns {import('./types.js').Habit}
 */
export function parseHabit(body = {}) {
  const name = String(body.name ?? '').trim();
  if (!name) throw new ValidationError('name is required');
  if (name.length > LIMITS.name) {
    throw new ValidationError(`name must be ${LIMITS.name} characters or fewer`);
  }

  const num = Number(body.freq_numerator ?? 1);
  const den = Number(body.freq_denominator ?? 1);
  if (!Number.isInteger(num) || !Number.isInteger(den) ||
      num < 1 || den < 1 || num > den || den > LIMITS.freqDenominator) {
    throw new ValidationError(
      `frequency must be integers with 1 <= numerator <= denominator <= ${LIMITS.freqDenominator}`
    );
  }

  const target = Number(body.target_value ?? 0);
  if (!Number.isFinite(target) || target < 0) {
    throw new ValidationError('target_value must be a non-negative number');
  }

  return {
    name,
    description: String(body.description ?? '').trim().slice(0, LIMITS.description),
    type: HABIT_TYPES.has(body.type) ? body.type : 'boolean',
    unit: String(body.unit ?? '').trim().slice(0, LIMITS.unit),
    target_value: target,
    target_type: TARGET_TYPES.has(body.target_type) ? body.target_type : 'at_least',
    freq_numerator: num,
    freq_denominator: den,
    color: COLOR_RE.test(body.color ?? '') ? body.color : DEFAULT_COLOR,
    archived: !!body.archived,
  };
}

/**
 * Validate an entry write.
 *
 * `habit` supplies the type, because a boolean habit accepts only the
 * sentinel values while a numerical one accepts any non-negative amount.
 * Returns `{ value, status, notes }`; a skip always carries value 0, since
 * skips are stored out of band and must never alias a real amount.
 *
 * @param {import('./types.js').Habit} habit
 * @param {{value?: unknown, status?: string, notes?: unknown}} body
 * @param {{UNSET: number, YES: number, SKIP: number}} sentinels from constants.js
 * @returns {{value: number, status: import('./types.js').EntryStatus, notes: string}}
 */
export function parseEntry(habit, body = {}, { UNSET, YES, SKIP }) {
  const notes = String(body.notes ?? '').slice(0, LIMITS.notes);

  // A skip may be requested explicitly, or (for boolean habits only) by the
  // legacy SKIP wire value. On a numerical habit 3 is a real amount.
  const wantsSkip = body.status === 'skip' ||
    (habit.type === 'boolean' && Number(body.value) === SKIP);

  if (wantsSkip) return { value: 0, status: 'skip', notes };

  const value = Number(body.value);
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError('value must be a non-negative number');
  }
  if (habit.type === 'boolean' && ![UNSET, YES].includes(value)) {
    throw new ValidationError(`boolean habits accept ${UNSET}, ${YES} or ${SKIP}`);
  }

  return { value, status: '', notes };
}

/**
 * The settable preferences and their allowed values.
 *
 * Duplicated deliberately from the browser's ui/settings.js registry: the
 * server must never trust the client's idea of what is valid, and this file
 * cannot import browser code. The two lists are kept honest by
 * test/settings.test.js, which fails if they drift.
 */
export const SETTING_VALUES = {
  dayOrder: ['newest-right', 'newest-left'],
  weekStart: ['monday', 'sunday'],
  confirmDelete: [true, false],
};

/**
 * Validate a settings patch, dropping anything unknown or out of range.
 *
 * Returns only the accepted keys, so a caller can merge the result without
 * re-checking. Unknown keys are ignored rather than rejected, so an older
 * server tolerates a newer client.
 *
 * @param {Record<string, any>} patch
 * @returns {{accepted: Record<string, any>, rejected: string[]}}
 */
export function parseSettings(patch = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('settings must be an object');
  }

  const accepted = {};
  const rejected = [];

  for (const [key, value] of Object.entries(patch)) {
    // Own-property check, not a plain lookup: SETTING_VALUES['__proto__']
    // resolves to Object.prototype, which is truthy and has no .includes —
    // so a `__proto__` key in the payload would throw and 500 the request.
    if (!Object.hasOwn(SETTING_VALUES, key)) { rejected.push(key); continue; }

    const allowed = SETTING_VALUES[key];
    if (!allowed.includes(value)) { rejected.push(key); continue; }
    accepted[key] = value;
  }
  return { accepted, rejected };
}

/** Reject anything that is not a 'YYYY-MM-DD' calendar date. */
export function assertDate(date) {
  if (!DATE_RE.test(date ?? '')) {
    throw new ValidationError('date must be YYYY-MM-DD');
  }
  return date;
}

/** Reject a date in the future, using the caller's notion of today. */
export function assertNotFuture(date, today) {
  if (date > today) {
    throw new ValidationError('cannot record entries in the future');
  }
  return date;
}
