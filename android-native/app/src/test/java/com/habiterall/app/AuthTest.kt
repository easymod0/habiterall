package com.habiterall.app

import com.habiterall.app.data.Auth
import com.habiterall.app.data.AuthMode
import com.habiterall.app.data.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The same rules as `shared/public/auth-session.js`, deliberately.
 *
 * Both clients ask one server the same question and boot the whole app on the
 * answer, so reading it two ways is indistinguishable from one of them being
 * broken — the same argument that pins `ReminderTimeTest` and `GridTest` to
 * their JavaScript twins.
 *
 * The cases below are the ones that file's comments describe, including the two
 * it shipped wrong: a response that says nothing about authentication used to be
 * read as a statement about it, and both of the guesses that produced were wrong
 * somewhere.
 */
class AuthTest {

    private fun body(vararg pairs: Pair<String, String>) =
        pairs.joinToString(",", "{", "}") { (k, v) -> "\"$k\":$v" }

    private fun str(value: String) = "\"$value\""

    /* ---------------------------------------------------------- signed in */

    @Test
    fun `an instance with no sign-in reports an active session and no need for one`() {
        val session = Auth.read(200, body("mode" to str("none"), "name" to str("")))
        assertTrue(session is Session.Active)
        assertEquals(AuthMode.NONE, (session as Session.Active).mode)
        assertFalse(session.mode.needsSignIn)
    }

    @Test
    fun `a signed-in personal session carries the account name`() {
        val session = Auth.read(
            200,
            body("mode" to str("password"), "name" to str("mark"), "managed" to "true"),
        )
        assertTrue(session is Session.Active)
        session as Session.Active
        assertEquals("mark", session.name)
        assertEquals(AuthMode.PASSWORD, session.mode)
        assertTrue("the environment owns the credential", session.managed)
    }

    /* --------------------------------------------------------- signed out */

    @Test
    fun `a 401 carries the mode, which is what decides the screen to draw`() {
        // The whole reason the mode rides the 401: a signed-OUT client is the one
        // that has to choose between a form and a link, and this is the only
        // answer it can get.
        val cases = mapOf(
            "password" to AuthMode.PASSWORD,
            "setup" to AuthMode.SETUP,
            "oidc" to AuthMode.OIDC,
        )
        for ((wire, expected) in cases) {
            val session = Auth.read(401, body("error" to str("authentication required"),
                "mode" to str(wire)))
            assertTrue("failed on $wire", session is Session.Absent)
            assertEquals(wire, expected, (session as Session.Absent).mode)
        }
    }

    /* ------------------------------------- everything else is NOT an answer */

    @Test
    fun `only 200 and 401 say anything about how an instance authenticates`() {
        // The regression the web adapter shipped, and the reason this function
        // exists at all. A 429 from the rate limiter carries no mode — and the
        // personal edition keys on IP, so one household behind one NAT shares the
        // bucket — which replaced a working app with a sign-in screen whose only
        // control 404s, on an instance with no authentication at all.
        //
        // 502 is a proxy that is up while the app is not. 503 is what the service
        // worker synthesises when the API cannot be reached, so it arrives
        // instead of a thrown error rather than alongside one. 500 is the app
        // itself. None of them is a statement about sign-in.
        for (status in listOf(429, 500, 502, 503)) {
            val session = Auth.read(status, "")
            assertTrue("$status was read as an answer", session is Session.Unknown)
            assertEquals(status, (session as Session.Unknown).status)
        }
    }

    @Test
    fun `an instance with no sign-in is never blocked by this endpoint`() {
        // The configuration this app shipped supporting, and the one that must
        // not acquire a new way to fail. It answers 200 with mode `none`, and
        // nothing about it needs a session.
        val ok = Auth.read(200, body("mode" to str("none"), "id" to "0", "name" to str("")))
        assertTrue(ok is Session.Active)
        assertFalse((ok as Session.Active).mode.needsSignIn)

        // And when this one request fails on such an instance — a 429 from the
        // read limiter, which the personal edition keys on IP, or no answer at
        // all — the answer is `Unknown`, which the app carries on past. Nothing
        // here may report a signed-OUT session, because that is what would draw
        // a sign-in screen over a server that has none.
        for (session in listOf(Auth.read(429, ""), Auth.read(0, ""))) {
            assertTrue(session is Session.Unknown)
            assertFalse(session is Session.Absent)
        }
    }

    @Test
    fun `a 403 is an error to report, not a sign-in prompt`() {
        // A suspended cloud account. Sending that user to a sign-in screen would
        // loop them through a provider that will authenticate them perfectly
        // well, back to the same refusal.
        //
        // It must not be re-asked about either, and that is a sharper rule than
        // it sounds: cloud answers 403 on every route including this one, so an
        // app that treats it as "ask again" spins — ask, carry on, fetch, 403,
        // ask again, with no delay anywhere in it. `Api` fires its re-ask on 401
        // alone for that reason.
        val session = Auth.read(403, body("error" to str("account suspended")))
        assertTrue(session is Session.Unknown)
        assertFalse(session is Session.Absent)
        assertEquals("account suspended", (session as Session.Unknown).message)
    }

    @Test
    fun `a body that is not JSON is not read as a session`() {
        // A captive portal answering 200 with a login page is the case a phone
        // meets and a browser does not. Reading it as a session put a "Sign out"
        // item on an instance with no sign-in, because the absent mode fell back
        // to one that has it.
        for (body in listOf(
            "<html><body>Sign in to the hotel wifi</body></html>",
            "",
            "[]",                       // JSON, but not an object
        )) {
            assertTrue(body, Auth.read(200, body) is Session.Unknown)
        }
    }

    @Test
    fun `an empty object is still a session, because it came from this API`() {
        // The distinction the case above turns on. A server that answered this
        // contract without the `mode` field is an older build; a server that
        // answered HTML is not this server at all.
        val session = Auth.read(200, "{}")
        assertTrue(session is Session.Active)
        assertEquals("", (session as Session.Active).name)
        assertEquals(AuthMode.OIDC, session.mode)
    }

    /* ------------------------------------------- the one guess this makes */

    @Test
    fun `a missing mode assumes there is auth rather than none`() {
        // An older server, or an answer cached before the field existed. The
        // guess costs nothing on an instance with no auth — nothing there ever
        // 401s — while the opposite disarms the 401 handling on one that does,
        // and leaves an expired session reporting errors forever.
        assertEquals(AuthMode.OIDC, (Auth.read(401, "{}") as Session.Absent).mode)
        assertEquals(AuthMode.OIDC, (Auth.read(200, "{}") as Session.Active).mode)
    }

    @Test
    fun `a mode this client does not know falls back to the browser flow`() {
        // A server newer than the app. The browser flow is the only sign-in that
        // works without knowing what it is: it opens the server's own page,
        // which renders whatever that server has.
        val session = Auth.read(401, body("mode" to str("passkey")))
        assertEquals(AuthMode.OIDC, (session as Session.Absent).mode)
    }

    @Test
    fun `every mode the server can send is understood`() {
        // Mirrors the four states in shared/public/auth-session.js. If the server
        // grows a fifth, this is where the two stop agreeing.
        for (wire in listOf("none", "password", "setup", "oidc")) {
            assertEquals(wire, AuthMode.of(wire).wire)
        }
    }

    @Test
    fun `only the no-auth mode skips sign-in`() {
        assertFalse(AuthMode.NONE.needsSignIn)
        for (mode in listOf(AuthMode.PASSWORD, AuthMode.SETUP, AuthMode.OIDC)) {
            assertTrue(mode.name, mode.needsSignIn)
        }
    }
}
