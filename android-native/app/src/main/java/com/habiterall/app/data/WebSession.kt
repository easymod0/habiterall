package com.habiterall.app.data

import android.webkit.CookieManager
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The session cookie, and the single store both halves of this app read.
 *
 * The app talks to the server two ways — [Api] over OkHttp, and the WebView
 * that shows the charts — and they have to be signed in together. A session the
 * WebView holds and the API client does not is a stats screen that works above
 * a list that 401s; the other way round is a list that works above a sign-in
 * page.
 *
 * So there is one store rather than two, and it is Android's own
 * [CookieManager]: it is the WebView's cookie jar whether we like it or not,
 * and it is reachable natively, while nothing can push a cookie the other way
 * into a WebView that has already decided it has none. `shared/src/security.js`
 * chose the cookie's shape with this in mind — one name and one `SameSite` for
 * both editions, so that this is one code path and not two.
 *
 * That is also what makes cloud sign-in possible at all. OIDC is a redirect to
 * an identity provider and back; no native form can stand in for it, and a
 * Custom Tab's cookies belong to the browser and are unreachable. Signing in
 * inside our own WebView leaves the cookie exactly where OkHttp reads it.
 *
 * `httpOnly` does not hide it here: that flag stops **JavaScript** reading a
 * cookie, and this is the native API underneath. It is still doing its job in
 * the page.
 */
object WebSession {

    /**
     * Mirrors `SESSION_NAME` in `shared/src/security.js`. Both editions issue
     * this one name, which is the whole reason a single code path serves both.
     */
    const val COOKIE = "habiterall.sid"

    /**
     * Android's cookie store, or null when it cannot be had.
     *
     * [CookieManager.getInstance] loads the WebView provider, which throws while
     * that package is being updated and on the rare device that has none. Null
     * rather than a crash: the callers below turn it into "no session", and a
     * request that then 401s is queued and retried rather than discarded — see
     * [Outbox]. The alternative is the app dying in a background worker, at the
     * moment a notification was tapped.
     */
    private fun manager(): CookieManager? = runCatching {
        CookieManager.getInstance().also { it.setAcceptCookie(true) }
    }.getOrNull()

    /**
     * OkHttp's view of that store.
     *
     * Cookies are read and written per request, never cached in this process: a
     * sign-in that happens in the WebView has to be visible to the very next API
     * call, and a stale copy here is exactly the "signed in on one half" state
     * this object exists to prevent.
     */
    fun jar(): CookieJar = object : CookieJar {
        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val header = manager()?.getCookie(url.toString()) ?: return emptyList()
            // `getCookie` answers in `Cookie:` header form — pairs separated by
            // "; " and no attributes — which is what a request wants anyway.
            return header.split(';').mapNotNull { Cookie.parse(url, it.trim()) }
        }

        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            val store = manager() ?: return
            // `Cookie.toString()` re-emits the attributes, so the expiry and the
            // flags the server set are what get stored rather than a bare pair.
            cookies.forEach { store.setCookie(url.toString(), it.toString()) }
            // `setCookie` writes through a store that persists lazily, so
            // without this a process killed between here and the next idle
            // moment loses the cookie — and a check-off from a notification
            // after a reboot then finds no session and asks the user to sign in
            // again for no reason. (The cookie itself is persistent: the server
            // gives it a 14-day `maxAge`, not a session lifetime.)
            store.flush()
        }
    }

    /**
     * Forget the session for this server.
     *
     * Expiring the one cookie by name rather than [CookieManager.removeAllCookies],
     * which would also empty every OTHER site's — including the identity
     * provider's, so signing out of habiterall would sign you out of everything
     * that shares it. Signing out here means signing out of this app.
     *
     * Which is why this is not the whole of a cloud sign-out, and reading it as
     * one is the bug it grew: the provider's session survives on its own origin
     * and silently signs you back in. Ending that is a VISIT rather than a
     * deletion — `Auth.endSession` and the screen that loads it — so the
     * provider ends its own session and clears its own cookie, and this stays
     * the narrow thing it says it is.
     *
     * The server is asked first (`POST /auth/logout`) and this is the local
     * half; it runs even when that request fails, because a sign-out that
     * depends on the network is one that cannot be done on a lost phone's
     * behalf.
     */
    fun clear(baseUrl: String) {
        val store = manager() ?: return
        val host = baseUrl.toHttpUrlOrNull()?.host ?: return
        // Set-Cookie with a past expiry is how a cookie is deleted; there is no
        // "remove one" in this API. Both host forms, because a cookie set for
        // `.example.com` is not removed by expiring it on `example.com`.
        for (domain in listOf(host, ".$host")) {
            store.setCookie(baseUrl, "$COOKIE=; Domain=$domain; Path=/; Max-Age=0")
        }
        store.setCookie(baseUrl, "$COOKIE=; Path=/; Max-Age=0")
        store.flush()
    }
}
