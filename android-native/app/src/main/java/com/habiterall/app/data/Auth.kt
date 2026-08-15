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
     * The server answered something that says nothing about authentication.
     * This is an error to report, never a reason to draw a sign-in screen.
     */
    data class Unusable(val status: Int, val message: String) : Session

    /**
     * The server could not be reached at all.
     *
     * Kept apart from [Unusable] because a phone is the client this happens to,
     * and the two want opposite treatment. A server that ANSWERED something
     * useless — a proxy's 502, a rate limit, a captive portal — is a state the
     * user has to be told about, because every screen behind it would fail the
     * same way with a worse message.
     *
     * A server that answered nothing is just a tunnel. Blocking the whole app on
     * it would put a dead-end error page in front of someone whose signal
     * dropped for a moment, in place of screens that already report their own
     * network trouble and offer to retry. And it costs nothing to be wrong: if
     * there IS a session to ask for, the first request to get through 401s, and
     * that is already what sends the app to the sign-in screen.
     */
    data class Unreachable(val message: String) : Session
}

object Auth {

    /**
     * Read `GET /api/me`.
     *
     * **Only 200 and 401 say anything about how an instance authenticates.**
     * Everything else is a fault and belongs on an error path. The web adapter
     * learned this the expensive way: it read the absence of a field as a
     * statement, so a 429 from the rate limiter — which the personal edition
     * keys on IP, and one household behind one NAT shares — replaced a working
     * app with a sign-in screen whose only control 404s, on an instance with no
     * authentication at all. A 500 or a proxy's 502 did the same, permanently.
     *
     * The same trap is sharper here than in a browser: a phone meets captive
     * portals and proxies that answer 200 with HTML, and reading one of those as
     * "signed in, mode unknown" would put the app into a state no retry escapes.
     * A body that is not an object is therefore treated as no body at all, which
     * on a 200 leaves [AuthMode.of] to make the one guess this makes at all.
     *
     * @param status the HTTP status
     * @param body the response body, which need not be JSON
     */
    fun read(status: Int, body: String): Session {
        val json = runCatching { Json.parseToJsonElement(body).jsonObject }
            .getOrElse { JsonObject(emptyMap()) }

        if (status != 200 && status != 401) {
            return Session.Unusable(status, json.str("error") ?: "The server answered $status.")
        }

        val mode = AuthMode.of(json.str("mode"))
        if (status == 401) return Session.Absent(mode)

        // A 200 in `none` mode is the edition's implicit user: no session, no
        // name, and nothing to sign in to.
        return Session.Active(
            name = json.str("name").orEmpty(),
            mode = mode,
            managed = json.bool("managed") ?: false,
        )
    }

    private fun JsonObject.str(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.bool(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.booleanOrNull
}
