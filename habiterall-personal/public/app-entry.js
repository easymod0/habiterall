/**
 * Entry point for the single-user edition.
 *
 * Both editions load the same adapter now: it asks the server which mode this
 * instance is in, because the personal edition decides at runtime whether it
 * has auth at all. See shared/public/auth-session.js.
 */
import { start } from '/shared/app.js';
import { auth } from '/shared/auth-session.js';

start(auth);
