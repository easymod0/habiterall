package com.habiterall.app

import com.habiterall.app.data.Auth
import com.habiterall.app.data.AuthMode
import com.habiterall.app.data.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    /* ------------------------------------------- the other end of a session */

    private val server = "https://habits.example.com"

    @Test
    fun `a cloud sign-out carries the provider's end-session URL`() {
        // The whole bug: this URL arrived and nothing visited it, so the app's
        // cookie went and the provider's — on its own origin, unreachable to
        // `WebSession.clear` — did not. Sign out, sign in, and you are straight
        // back in with no prompt.
        val logout = "https://id.example.com/application/o/end-session/" +
            "?id_token_hint=abc&post_logout_redirect_uri=https%3A%2F%2Fhabits.example.com%2F"
        assertEquals(logout, Auth.endSession(server, 200, body("redirect" to str(logout))))
    }

    @Test
    fun `the server's own root is nowhere to go`() {
        // The personal edition answers exactly this: it has no provider behind
        // it, and so does cloud when its provider has no end-session endpoint.
        // Both would otherwise put a sign-out screen in front of a page load
        // that ends nothing.
        for (redirect in listOf("/", server, "$server/")) {
            assertNull(redirect, Auth.endSession(server, 200, body("redirect" to str(redirect))))
        }
    }

    @Test
    fun `a provider on this host one port over is somewhere to go`() {
        // The rule is the ROOT and not the origin, deliberately. Self-hosting
        // an identity provider beside the app is the ordinary case — it is what
        // habiterall-cloud's own compose file does — and a same-origin test
        // would decide there was nothing to visit.
        val logout = "$server:9000/application/o/end-session/?id_token_hint=abc"
        assertEquals(logout, Auth.endSession(server, 200, body("redirect" to str(logout))))
    }

    @Test
    fun `nothing that is not an http URL is loaded`() {
        // The value ends up in `loadUrl`, which EXECUTES a `javascript:` URL in
        // the context of whatever the WebView is showing. It comes from the
        // server this client is authenticated to and is still checked, because
        // the cost of checking is this line.
        for (redirect in listOf(
            "javascript:alert(1)",
            "intent://scan/#Intent;scheme=zxing;end",
            "file:///data/data/com.habiterall.app/",
            "",
        )) {
            assertNull(redirect, Auth.endSession(server, 200, body("redirect" to str(redirect))))
        }
    }

    @Test
    fun `an answer that is not this contract sends the app nowhere`() {
        // Same reasoning as `read`: a captive portal or a proxy answers this
        // route too, and a 200 of HTML says nothing. A body with no `redirect`
        // is an older server, which also has nowhere for this to go.
        assertNull(Auth.endSession(server, 200, "<html>Sign in to the hotel wifi</html>"))
        assertNull(Auth.endSession(server, 200, "{}"))
        assertNull(Auth.endSession(server, 200, "[]"))
        assertNull(Auth.endSession(server, 502, body("redirect" to str("https://evil.example/"))))
        assertNull(Auth.endSession(server, 0, ""))
    }

    @Test
    fun `the trip is over when the provider sends us back to the server root`() {
        // `post_logout_redirect_uri` is this server's root, which is what the
        // screen watches for. A query on the landing is still the landing.
        assertTrue(Auth.signOutReturned(server, "$server/"))
        assertTrue(Auth.signOutReturned(server, "$server/?ok=1"))
    }

    @Test
    fun `a page on the provider is not the end of the trip`() {
        // Including one hosted on this very host, which is why the test is the
        // root rather than the origin: matching an origin would end the screen
        // on its own first page load, before anything had been signed out of.
        assertFalse(Auth.signOutReturned(server, "$server:9000/application/o/end-session/"))
        assertFalse(Auth.signOutReturned(server, "https://id.example.com/flow/logout/"))
        assertFalse(Auth.signOutReturned(server, "$server/api/me"))
        assertFalse(Auth.signOutReturned(server, "about:blank"))
        assertFalse(Auth.signOutReturned(server, null))
    }
}
