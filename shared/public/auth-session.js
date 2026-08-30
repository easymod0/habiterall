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

import { syncEntry as syncCompareEntry } from '/shared/ui/categories.js';
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

/**
 * The four modes the server can report. Anything else is an unknown build or a
 * response that is not ours, and resolves to `oidc` — the same answer
 * `AuthMode.of` gives on the phone, and the safe one: it leaves
 * `onUnauthorized` armed.
 */
const MODES = new Set(['none', 'password', 'setup', 'oidc']);

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
    let res, body = null;
    try {
      res = await fetch('/api/me', { credentials: 'same-origin' });
      body = await res.json().catch(() => null);
    } catch {
      this.mode = null;
      this.enabled = false;
      throw new Error('Could not reach the server');
    }

    // Only a session (200) or a refusal (401) says anything about how this
    // instance authenticates. EVERYTHING else is a fault, and must reach the
    // caller's error path rather than the sign-in view.
    //
    // This read the absence of a field as a positive statement — `body.mode ??
    // (res.ok ? 'none' : 'oidc')` — and both defaults were wrong somewhere. A
    // 429 from the API limiter carries no mode, so one burst (and this edition
    // keys on IP, so one household behind one NAT shares the bucket) replaced a
    // working app with "sign in with your organisation account" above a link
    // that 404s — on an instance with no authentication at all. A 500 or a
    // proxy's 502 did the same, permanently. The offline case is the sharper
    // one: the service worker answers an unreachable API with a synthetic 503
    // rather than throwing, so the `catch` above never ran and the comment that
    // used to sit in it — "guessing a mode here would paint a sign-in form over
    // cached data" — described exactly what happened.
    if (!res.ok && res.status !== 401) {
      this.mode = null;
      this.enabled = false;
      throw new Error(body?.error || `The server answered ${res.status}.`);
    }

    // A body that is not a JSON object is not an answer to this question, and
    // degrading it to `{}` is how a 200 full of HTML became a SESSION. A
    // reverse proxy with an SPA fallback (`try_files $uri /index.html`) and a
    // captive portal both do exactly that, and `{}` is truthy: `render()` took
    // the signed-in branch, the chip read "Signed in", New habit and Settings
    // appeared, and — because the absent `mode` falls back to `oidc` below — an
    // instance with no sign-in at all grew a Sign out control.
    //
    // An empty but VALID `{}` is a different thing and must still read as a
    // session: that is a server answering this contract without the field,
    // which is what the `mode` fallback below exists for. So the test is
    // whether it PARSED, not whether it holds anything.
    //
    // `Auth.read` in the Kotlin client already had this guard, with the bug it
    // was written for named in its comment. Two clients boot the whole app on
    // this one answer, so the reading of it cannot differ between them.
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      this.mode = null;
      this.enabled = false;
      throw new Error('The server did not answer with a session.');
    }

    // A missing mode from a server that DID answer one of those two is an older
    // build, or an answer cached before this field existed. Assume there is
    // auth: on an instance that has none nothing ever 401s, so the guess costs
    // nothing, while the opposite guess disarms `onUnauthorized` on one that
    // does and leaves an expired cloud session toasting errors forever.
    //
    // An UNRECOGNISED one lands in the same place, which is what `AuthMode.of`
    // does on the phone. It also has to, rather than being passed through: the
    // sign-in copy is `COPY[this.mode]`, and a key lookup from a value off the
    // wire is the case the root CLAUDE.md keeps for `Object.hasOwn` —
    // `COPY['__proto__']` resolves to `Object.prototype`, which is truthy, so
    // the `?? COPY.oidc` fallback never fires and the form renders `undefined`
    // as its own title.
    this.mode = MODES.has(body.mode) ? body.mode : 'oidc';
    this.enabled = this.mode !== 'none';

    return res.ok ? body : null;
  },

  /**
   * Reflect the session in the chrome.
   * @param {{id:number,name?:string,email?:string}|null} user
   *   null renders the signed-out state
   */
  render(user) {
    const signin = $('#view-signin');
    const chip = $('#user-chip');

    // With auth off there is no user chip and no sign-in view, and a 401 can
    // only be a bug. The buttons still have to be turned ON, though: they start
    // hidden in the markup so an authenticated instance does not paint its whole
    // signed-in shell for one round trip before the sign-in view replaces it.
    if (this.mode === 'none') {
      show(signin, false);
      for (const id of SIGNED_IN_ONLY) show($(`#${id}`), true);
      return;
    }

    if (!user) {
      // An open <dialog> lives in the top layer and takes focus and clicks with
      // it, so a session that expired while Settings was open left a sign-in
      // form that could be seen and not typed into. The likeliest source of a
      // 401 is that dialog's own save.
      for (const el of document.querySelectorAll('dialog[open]')) {
        /** @type {HTMLDialogElement} */ (el).close();
      }

      this.renderSignin();
      show(signin, true);
      hideAll();
      show(chip, false);
      for (const id of SIGNED_IN_ONLY) show($(`#${id}`), false);
      // Compare goes too, and it cannot be in the list above: that list turns
      // its buttons ON again for any signed-in account, and this one is shown
      // only for an account that HAS a category. So the module that owns it is
      // asked to put it away, which is the one direction the two rules agree
      // on — nothing here ever reveals it, and `dashboard.paint()` is what
      // decides whether it comes back.
      syncCompareEntry(false);
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

    // A password manager should offer to GENERATE on setup and to FILL on
    // sign-in; the markup can only state one, so the mode picks.
    const pass = $('#signin-pass');
    if (pass) pass.autocomplete = this.mode === 'setup' ? 'new-password' : 'current-password';

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
        // Unhide BEFORE writing: a role="alert" that is not rendered when its
        // text changes is not reliably announced, and this is the one message a
        // screen-reader user most needs to hear.
        if (msg) error.hidden = false;
        error.textContent = msg;
        if (!msg) error.hidden = true;
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
        //
        // `reload`, not `assign('/')`, which dropped the fragment — so signing
        // in from a deep link to one habit (the native client's ordinary way in)
        // landed on the dashboard instead of the habit that was asked for.
        window.location.reload();
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
