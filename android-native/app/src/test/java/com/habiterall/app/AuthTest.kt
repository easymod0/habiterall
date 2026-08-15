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
            assertTrue("$status was read as an answer", session is Session.Unusable)
            assertEquals(status, (session as Session.Unusable).status)
        }
    }

    @Test
    fun `an unreachable server is a different state from an odd answer`() {
        // `Auth.read` never produces it — it only ever sees an answer — but the
        // distinction it guards is the one a phone meets most. A server that
        // answered nothing says nothing about the session, and blocking the app
        // on it would put a dead end in front of a dropped signal. A server that
        // answered 502 has to be reported, because every screen behind it fails
        // the same way with a worse message.
        //
        // Pinned here so the two cannot be merged back into one without the
        // reasoning being read again.
        assertTrue(Auth.read(502, "") is Session.Unusable)
        assertFalse(Auth.read(502, "") is Session.Unreachable)
    }

    @Test
    fun `a 403 is an error to report, not a sign-in prompt`() {
        // A suspended cloud account. Sending that user to a sign-in screen would
        // loop them through a provider that will authenticate them perfectly
        // well, back to the same refusal.
        val session = Auth.read(403, body("error" to str("account suspended")))
        assertTrue(session is Session.Unusable)
        assertEquals("account suspended", (session as Session.Unusable).message)
    }

    @Test
    fun `a body that is not JSON is not read as a session`() {
        // A captive portal answering 200 with a login page is the case a phone
        // meets and a browser does not. Reading that as "signed in" would leave
        // the app in a state no retry escapes.
        val session = Auth.read(200, "<html><body>Sign in to the hotel wifi</body></html>")
        assertTrue(session is Session.Active)
        // Nothing was claimed about the account, and the mode falls back to the
        // one that assumes there IS auth — see below.
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
