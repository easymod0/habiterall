/**
 * The only auth adapter. One module covers all four states both editions can
 * be in, because the server tells the page which one it is:
 *
 *   none      the personal edition with auth off — no sign-in, no chip
 *   password  the personal edition with auth on — a username/password form
 *   setup     the personal edition with auth on and no account yet
 *   oidc      the cloud edition — a link out to the identity provider
 *
 * This replaced a pair of modules (`auth-none.js`, `auth-oidc.js`) picked by
 * each edition's `app-entry.js`. With no build step there is nothing to select
 * a module at package time, so the edition was baked into a file — which meant
 * the personal edition could not have auth be a runtime choice at all. Asking
 * the server is what makes it one, and it costs no extra request: `load()`
 * already had to fetch `/api/me`.
 *
 * The session lives in an httpOnly cookie the page cannot read, so "am I signed
 * in?" is answered by asking the server, never by inspecting storage.
 */

import { hideAll } from '/shared/ui/views.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Buttons that mean nothing to a signed-out visitor.
 *
 * The gear is in the list because backup and restore moved inside it: hiding
 * `btn-data` used to be what kept an export button away from someone with no
 * session, and every other thing the dialog offers is per-account anyway.
 */
const SIGNED_IN_ONLY = ['btn-new', 'btn-settings'];

/** Copy per mode, so the one form can introduce itself correctly. */
const COPY = {
  password: {
    title: 'Sign in to habiterall',
    sub: 'This instance is password protected.',
    submit: 'Sign in',
  },
  setup: {
    title: 'Create your account',
    sub: 'Nobody has claimed this instance yet. Choose the username and '
       + 'password you will sign in with.',
    submit: 'Create account',
  },
  oidc: {
    title: 'Sign in to habiterall',
    sub: 'Your habits are private to your account. Sign in with your '
       + 'organisation account to continue.',
    submit: 'Sign in',
  },
};

const show = (el, visible) => { if (el) el.hidden = !visible; };

export const auth = {
  /**
   * Which of the four states the server reported. Null until `load()` has run —
   * nothing may branch on it before then.
   * @type {'none'|'password'|'setup'|'oidc'|null}
   */
  mode: null,

  /** Whether this instance has sign-in at all. Meaningless before `load()`. */
  enabled: false,

  /**
   * Resolve the current session, and the mode along with it.
   *
   * The mode has to be readable while signed OUT — it is what decides whether
   * to draw a form or a link — so it rides on the 401 body as well as the 200.
   * A 401 with no mode is treated as `oidc`: that is the only edition that can
   * 401 without having been asked, and guessing `none` there would render a
   * signed-out cloud instance as if it were wide open.
   *
   * @returns {Promise<object|null>} null means "show the sign-in screen"
   */
  async load() {
    let res, body = {};
    try {
      res = await fetch('/api/me', { credentials: 'same-origin' });
      body = await res.json().catch(() => ({}));
    } catch {
      // Offline. Say nothing about auth and let the caller's error path run;
      // guessing a mode here would paint a sign-in form over cached data.
      this.mode = null;
      this.enabled = false;
      throw new Error('Could not reach the server');
    }

    this.mode = body.mode ?? (res.ok ? 'none' : 'oidc');
    this.enabled = this.mode !== 'none';

    return res.ok ? body : null;
  },

  /**
   * Reflect the session in the chrome.
   * @param {{id:number,name?:string,email?:string}|null} user
   *   null renders the signed-out state
   */
  render(user) {
    // With auth off there is no user chip, no sign-in view, and nothing hidden:
    // a 401 can only be a bug, and the whole UI is always available.
    if (this.mode === 'none') return;

    const signin = $('#view-signin');
    const chip = $('#user-chip');

    if (!user) {
      this.renderSignin();
      show(signin, true);
      hideAll();
      show(chip, false);
      for (const id of SIGNED_IN_ONLY) show($(`#${id}`), false);
      return;
    }

    show(signin, false);
    const name = $('#user-name');
    if (name) name.textContent = user.name || user.email || 'Signed in';
    show(chip, true);
    for (const id of SIGNED_IN_ONLY) show($(`#${id}`), true);
  },

  /** Dress the sign-in view for the current mode: a form, or a link out. */
  renderSignin() {
    const copy = COPY[this.mode] ?? COPY.oidc;
    const title = $('#signin-title');
    const sub = $('#signin-sub');
    if (title) title.textContent = copy.title;
    if (sub) sub.textContent = copy.sub;

    const isForm = this.mode === 'password' || this.mode === 'setup';
    show($('#signin-oidc'), !isForm);
    show($('#signin-form'), isForm);
    // Only a new account asks twice; confirming a password you already have
    // is a field that can only ever be wrong.
    show($('#signin-confirm-row'), this.mode === 'setup');

    const submit = $('#signin-submit');
    if (submit) submit.textContent = copy.submit;

    show($('#signin-error'), false);
    if (isForm) this.bindForm();
  },

  /**
   * Attach the submit handler once.
   *
   * `renderSignin` runs on every failed request that turns out to be a 401, so
   * binding unconditionally would stack handlers and post the form once per
   * expired session since page load.
   */
  bindForm() {
    const form = $('#signin-form');
    if (!form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = $('#signin-error');
      const submit = $('#signin-submit');
      const setError = (msg) => {
        if (!error) return;
        error.textContent = msg;
        error.hidden = !msg;
      };

      const username = $('#signin-user')?.value ?? '';
      const password = $('#signin-pass')?.value ?? '';
      const confirm = $('#signin-confirm')?.value ?? '';

      if (this.mode === 'setup' && password !== confirm) {
        return setError('Those passwords do not match.');
      }

      setError('');
      if (submit) submit.disabled = true;
      try {
        const path = this.mode === 'setup' ? '/auth/setup' : '/auth/login';
        const res = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return setError(body.error ?? 'Sign in failed.');

        // A full reload rather than re-entering start(): the app boots a lot of
        // state from the session, and replaying that in place is a second boot
        // path to keep correct for no gain on a once-per-session action.
        window.location.assign('/');
      } catch {
        setError('Could not reach the server.');
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  },

  async signOut() {
    try {
      const res = await fetch('/auth/logout', {
        method: 'POST', credentials: 'same-origin',
      });
      const body = await res.json().catch(() => ({}));
      // Follow the IdP's end-session URL where there is one, so the provider
      // session ends too. The personal edition just returns '/'.
      window.location.href = body.redirect ?? '/';
    } catch {
      window.location.href = '/';
    }
  },

  /**
   * What to do when the API returns 401.
   *
   * With auth off this is a genuine fault, so it goes to the normal error path
   * rather than painting a sign-in screen the instance does not have.
   */
  onUnauthorized() {
    if (this.mode === 'none') return false;   // not handled
    this.render(null);
    return true;
  },
};
