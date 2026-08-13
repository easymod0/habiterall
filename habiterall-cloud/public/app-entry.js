/**
 * Entry point for the multi-user edition.
 *
 * The UI itself lives in shared/public/app.js; this only picks the auth
 * adapter, so a change to the interface applies to both editions at once.
 */
import { start } from '/shared/app.js';
import { auth } from '/shared/auth-oidc.js';

start(auth);
