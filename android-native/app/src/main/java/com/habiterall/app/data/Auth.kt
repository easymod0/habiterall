package com.habiterall.app.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject

/**
 * How an instance authenticates, and what `GET /api/me` is saying.
 *
 * A deliberate mirror of `shared/public/auth-session.js`, for the same reason
 * `ReminderTime` mirrors `ui/time.js` and `Grid.nextState` mirrors
 * `ui/toggle.js`: both clients ask one server the same question, and two
 * answers to it are indistinguishable from one of them being broken.
 * `AuthTest` is pinned to the same cases that file's comments describe.
 *
 * Nothing here touches Android or the network — it is the reading of an answer,
 * so it can be tested without either.
 */
enum class AuthMode(val wire: String) {
    /** No sign-in at all: the personal edition with `HABITERALL_AUTH=off`. */
    NONE("none"),

    /** The personal edition with a credential set. A username and password. */
    PASSWORD("password"),

    /**
     * The personal edition with auth on and no credential yet. The same form,
     * but it CLAIMS the instance rather than signing in to it — whoever reaches
     * it first owns the account, which is why the copy has to differ.
     */
    SETUP("setup"),

    /** The cloud edition. Sign-in is a redirect to an identity provider. */
    OIDC("oidc"),
    ;

    /** Whether this instance has sign-in at all. */
    val needsSignIn: Boolean get() = this != NONE

    companion object {
        /**
         * The mode a server named, or [OIDC] when it named none this client
         * knows.
         *
         * Two cases land on that fallback and it is right for both. A **missing**
         * `mode` is an older server, or an answer cached before the field
         * existed; assuming there is auth costs nothing on an instance that has
         * none, because nothing there ever 401s, while the opposite guess
         * disarms the 401 handling on an instance that does. An **unrecognised**
         * one is a server newer than this app, where the browser flow is the
         * only sign-in this client can offer that works without knowing what it
         * is: it opens the server's own page, which renders whatever sign-in
         * that server has.
         */
        fun of(wire: String?): AuthMode = entries.firstOrNull { it.wire == wire } ?: OIDC
    }
}

/** What the server said about this client's session. */
sealed interface Session {
    /** Signed in, or an instance with no sign-in — either way, go ahead. */
    data class Active(
        val name: String,
        val mode: AuthMode,
        /** The credential comes from the environment, so it cannot be changed here. */
        val managed: Boolean = false,
    ) : Session

    /** Not signed in. [mode] is what decides which sign-in to draw. */
    data class Absent(val mode: AuthMode) : Session

    /**
     * The server said nothing about authentication — a 429, a proxy's 502, a
     * captive portal's HTML, or no answer at all ([status] 0).
     *
     * **This is not a state the app stops for.** It is tempting to make it one:
     * something is clearly wrong, so say so. But the app cannot know what, and
     * the one configuration it must never break is the one with no sign-in at
     * all — where every screen worked before this endpoint was ever called, and
     * a boot-time gate over it is a new way to fail that instance for a reason
     * it does not have. The personal edition's read limiter keys on IP, so a
     * household behind one NAT can 429 this route while the server is perfectly
     * healthy: exactly the shape of the bug `auth-session.js` shipped, which put
     * a sign-in form over a working instance.
     *
     * So the app carries on, and the ordinary requests decide. They will: they
     * are the ones with data to fetch, they already report their own failures
     * with a retry, and a 401 among them is what routes to the sign-in screen.
     * Being wrong here costs a round trip; being wrong the other way costs the
     * whole app.
     *
     * The status and message are kept because they are worth reporting when a
     * screen does fail — not because anything branches on them.
     */
    data class Unknown(val status: Int, val message: String) : Session
}

object Auth {

    /**
     * Read `GET /api/me`.
     *
     * **Only 200 and 401 say anything about how an instance authenticates.**
     * Everything else is [Session.Unknown], which the app carries on past. The
     * web adapter learned the first half the expensive way: it read the absence
     * of a field as a statement, so a 429 from the rate limiter — which the
     * personal edition keys on IP, and one household behind one NAT shares —
     * replaced a working app with a sign-in screen whose only control 404s, on
     * an instance with no authentication at all. A 500 or a proxy's 502 did the
     * same, permanently.
     *
     * The second half is this client's own lesson, and it is why `Unknown` is
     * not an error screen: a native app boots through this route, so making a
     * bad answer fatal breaks the same instance the web bug broke, by a
     * different route. See [Session.Unknown].
     *
     * The trap is sharper here than in a browser: a phone meets captive portals
     * and proxies that answer 200 with HTML, and reading one of those as "signed
     * in, mode unknown" would put the app into a state no retry escapes. A body
     * that is not an object is therefore treated as no body at all, which on a
     * 200 leaves [AuthMode.of] to make the one guess this makes at all.
     *
     * @param status the HTTP status
     * @param body the response body, which need not be JSON
     */
    fun read(status: Int, body: String): Session {
        val json = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()

        if (status != 200 && status != 401) {
            return Session.Unknown(status, json?.str("error") ?: "The server answered $status.")
        }

        // A 200 whose body is not an object did not come from this API — a
        // captive portal's HTML is the one a phone actually meets. Reading it as
        // a session is what the paragraph above says must not happen, and the
        // first version of this did it anyway: it degraded a parse failure to an
        // empty object and returned an ACTIVE session from it. The visible cost
        // was on the configuration least able to afford it — an instance with no
        // sign-in behind a hotel portal grew a "Sign out" item, because the mode
        // fell back to one that has sign-in.
        //
        // An empty but VALID object is a different thing and still reads as a
        // session: that is a server answering this contract without the field,
        // which is the case [AuthMode.of] exists for.
        if (json == null) {
            return Session.Unknown(status, "The server did not answer with a session.")
        }

        val mode = AuthMode.of(json.str("mode"))
        if (status == 401) return Session.Absent(mode)

        // A 200 in `none` mode is the edition's implicit user: no session, no
        // name, and nothing to sign in to.
        return Session.Active(
            name = json.str("name").orEmpty(),
            mode = mode,
            managed = json.bool("managed") == true,
        )
    }

    private fun JsonObject.str(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.bool(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.booleanOrNull
}
