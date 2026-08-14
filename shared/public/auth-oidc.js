/**
 * Auth adapter for the multi-user edition.
 *
 * The session lives in an httpOnly cookie the page cannot read, so "am I
 * signed in?" is answered by asking the server, never by inspecting storage.
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

export const auth = {
  enabled: true,

  async load() {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok) return null;
    return res.json();
  },

  /**
   * Reflect the session in the chrome.
   * @param {{id:number,name?:string,email?:string}|null} user
   *   null renders the signed-out state
   */
  render(user) {
    const signin = $('#view-signin');
    const chip = $('#user-chip');

    if (!user) {
      if (signin) signin.hidden = false;
      hideAll();
      if (chip) chip.hidden = true;
      for (const id of SIGNED_IN_ONLY) { const el = $(`#${id}`); if (el) el.hidden = true; }
      return;
    }

    if (signin) signin.hidden = true;
    const name = $('#user-name');
    if (name) name.textContent = user.name || user.email || 'Signed in';
    if (chip) chip.hidden = false;
    for (const id of SIGNED_IN_ONLY) { const el = $(`#${id}`); if (el) el.hidden = false; }
  },

  async signOut() {
    try {
      const res = await fetch('/auth/logout', {
        method: 'POST', credentials: 'same-origin',
      });
      const body = await res.json().catch(() => ({}));
      // Follow the IdP's end-session URL so the provider session ends too.
      window.location.href = body.redirect ?? '/';
    } catch {
      window.location.href = '/';
    }
  },

  /** A 401 means the session expired: drop back to the sign-in screen. */
  onUnauthorized() {
    this.render(null);
    return true; // handled
  },
};
