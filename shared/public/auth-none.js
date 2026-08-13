/**
 * Auth adapter for the single-user edition: there is no sign-in.
 *
 * The app always renders as "signed in", nothing is ever hidden, and a 401
 * can only mean a bug rather than an expired session. Keeping this as a real
 * module (rather than a pile of `if (isCloud)` branches) is what lets the
 * whole UI live in shared/.
 */

export const auth = {
  /** Whether this edition has sign-in at all. */
  enabled: false,

  /**
   * Resolve the current user. The single-user edition has exactly one
   * implicit user, so this always succeeds.
   * @returns {Promise<object|null>} null means "show the sign-in screen"
   */
  async load() {
    return { id: 0, name: '', email: '' };
  },

  /** Nothing to render: there is no user chip and no sign-in view. */
  render() {},

  /** Unreachable without sign-in, but defined so callers need no branch. */
  async signOut() {},

  /**
   * What to do when the API returns 401. Without auth this is a genuine
   * fault, so let the normal error path surface it.
   */
  onUnauthorized() {
    return false; // not handled
  },
};
