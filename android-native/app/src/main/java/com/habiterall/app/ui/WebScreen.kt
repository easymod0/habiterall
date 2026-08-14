package com.habiterall.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import org.json.JSONObject

/**
 * The one WebView this app has, for as long as the activity does.
 *
 * It used to be built inside [WebScreen] and destroyed on the way out, which
 * meant every single tap on a habit paid the whole cold cost in front of the
 * user: renderer process spawn, TLS, the shell, the service worker booting, the
 * app's own `start()`, and only then `/habits/:id/stats`. That is the stutter
 * between tapping a habit and seeing its charts — the WebView was never warm,
 * because nothing was ever allowed to stay alive long enough to get warm.
 *
 * Note the list underneath had already been given the opposite treatment, and
 * for the same reason (see the "stays composed underneath" note in
 * MainActivity): swapping a screen out discards everything it remembers. The web
 * side simply never got the same fix.
 *
 * Two things follow from keeping it, and both are the point rather than a
 * side effect:
 *
 *  - **Habit to habit stops being a page load at all.** `#/habit/42` to
 *    `#/habit/43` is a fragment change on a document that is already parsed, so
 *    `routes.js` handles it as a same-document navigation. No request for the
 *    shell, no re-parse, no service worker. This is the payoff for the fragment
 *    routing that CLAUDE.md says was chosen for the native client.
 *  - **It is laid out from the moment the server is known**, not from the tap.
 *    That matters more than it looks: `ui/dashboard.js` reads `window.innerWidth`
 *    when it renders and only re-renders when the 640px media query flips, and
 *    `ui/components.js` measures `clientWidth`. A WebView warmed detached, or at
 *    zero size, would boot against a zero-width viewport and keep that column
 *    count. So it lives in the layout the whole time and is merely INVISIBLE,
 *    which is laid out and measured but neither drawn nor touchable.
 *
 * What warming deliberately does NOT do is load the dashboard. Pre-loading the
 * app's own shell would be faster still, and it would put the web dashboard on
 * screen for the instant between the tap and the habit rendering — which is the
 * flash of the wrong screen that `start()` was changed to stop doing, on this
 * client's most used path in. `about:blank` buys the renderer process without
 * buying a screen nobody asked for.
 *
 * The third thing that follows is a bill rather than a payoff, and it is Back.
 * `about:blank` is a real back-forward entry, so it sits underneath the habit and
 * makes `canGoBack()` true where a per-tap WebView had nothing beneath it at all
 * — and the page then adds an entry of its own on top, from `app.js`, after the
 * load has committed. Both together meant the first Back press walked the page
 * instead of leaving the screen. [WebBackStack] owns the rule and
 * [truncateOnLoad] is how a document load gets back to the list shape that was
 * already right: the document at 0, the page's own push above it, nothing below.
 */
class WebHost {

    private var webView: WebView? = null
    private var warmed = false
    private var floor = 0

    /**
     * A target asked for before there was anything to ask.
     *
     * The WebView is built by the AndroidView factory and the navigation comes
     * from a LaunchedEffect, so composition orders them correctly today. That is
     * an ordering guarantee this class does not own, though, and the failure it
     * would produce is the worst kind: [show] returning quietly, and the screen
     * opening on nothing at all. [warm] is covered by [view] doing it on the way
     * out rather than by a second flag — losing that race costs no correctness,
     * only the entire point of this class, silently.
     */
    private var pendingTarget: String? = null

    /**
     * Whether the load in flight should take the back-forward list with it.
     *
     * Set for a cross-document open and answered in `doUpdateVisitedHistory`,
     * because [WebBackStack] cannot count a floor for one: the page pushes an
     * entry of its own AFTER the document commits, so the index measured before
     * the load is short of where Back has to stop. Truncating on commit makes the
     * loaded entry 0 and the page's push entry 1 — which is exactly the list a
     * per-tap WebView had, and `canGoBack()` was already right about it.
     *
     * Only ever true for a load this class started, so a document the user
     * reached themselves keeps the history behind it.
     */
    private var truncateOnLoad = false

    /** True while a document is loading. Fragment changes are not one. */
    var loading by mutableStateOf(false)
        private set

    /** The main-frame failure to report, if the last load produced one. */
    var failure by mutableStateOf<String?>(null)
        private set

    /** The URL the WebView is currently showing, as far as it has told us. */
    private val currentUrl: String? get() = webView?.url

    @SuppressLint("SetJavaScriptEnabled")   // it is our own page
    fun view(context: Context): WebView {
        webView?.let { existing ->
            // Re-entering composition (the server address being changed and set
            // again is the way there) hands the same instance to a new holder.
            // A View may only have one parent, so the old one has to let go —
            // detaching does not destroy a WebView or drop what it has loaded.
            (existing.parent as? ViewGroup)?.removeView(existing)
            return existing
        }

        val created = WebView(context).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.javaScriptEnabled = true       // the app IS JavaScript
            settings.domStorageEnabled = true       // localStorage: the settings cache
            settings.databaseEnabled = true
            // The PWA's own service worker and outbox keep working, so a
            // check-off made in here survives a dropped connection exactly as it
            // does in a browser.
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                    // Only a document load reaches this, which is exactly the
                    // set of navigations worth a progress bar. A fragment change
                    // fires neither this nor onPageFinished — so leaving both
                    // ends here is what keeps the bar off the fast path instead
                    // of needing a rule about which loads to show it for.
                    loading = true
                    failure = null
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    loading = false
                }

                /**
                 * The history has changed, and this is the only callback that
                 * says so AFTER the entry is in the list.
                 *
                 * That is why the truncation lives here rather than in
                 * `onPageFinished`, and the difference was measured rather than
                 * reasoned about. On a load that succeeds, either would do. On a
                 * load that FAILS, the error page commits after `onPageFinished`
                 * has already run — at which point the list still holds only
                 * `about:blank`, so there is nothing to truncate, and the entry
                 * then arrives above a floor of 0 with `about:blank` reachable
                 * underneath it. Back walked to a blank screen instead of closing,
                 * which is the same bug in the same place for a second reason.
                 *
                 * A same-document push reaches here too — the page's own
                 * `routes.go()` is one — so the flag is what keeps this to the
                 * load it was armed for.
                 */
                override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                    if (!truncateOnLoad) return
                    truncateOnLoad = false
                    // Everything under this entry — the warm-up's about:blank, and
                    // whatever an earlier visit left — is not somewhere Back
                    // should be able to reach, and leaving it there is what made
                    // the first Back press walk off the screen instead of closing
                    // it. clearHistory keeps the entry showing and drops the rest,
                    // so the floor is 0 and the entry `app.js` pushes for its own
                    // route lands above it, still walkable.
                    view?.clearHistory()
                    floor = 0
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?,
                ) {
                    // Only the main document; a failed icon is not worth a
                    // full-screen error.
                    if (request?.isForMainFrame == true) {
                        loading = false
                        // `truncateOnLoad` is deliberately NOT cleared: an error
                        // page is still an entry, it still commits, and a screen
                        // showing one still has to be closeable.
                        failure = "Could not load ${request.url}"
                    }
                }
            }
        }
        webView = created
        // Whichever of the two got here first. Warming is what happens when the
        // WebView is built before anything wants it, which is the ordinary case.
        val target = pendingTarget
        pendingTarget = null
        if (target != null) show(target) else warm()
        return created
    }

    /**
     * Pay the startup cost while the user is still looking at the habit list.
     *
     * Called whenever no web screen is open, and a no-op after the first time —
     * which is what leaves the last habit loaded after the screen is closed, so
     * reopening it is free.
     */
    fun warm() {
        val view = webView ?: return
        if (warmed) return
        warmed = true
        view.loadUrl("about:blank")
    }

    /** Point the WebView at [target], and record where Back stops. */
    fun show(target: String) {
        val view = webView ?: run { pendingTarget = target; return }
        warmed = true

        val current = currentUrl
        // A failed load leaves the WebView sitting on the URL it could not reach,
        // so "already showing this" would decline to retry it: reopening the
        // habit showed the same error again with nothing having been attempted,
        // and only Reload got out of it. A retry is also a document load whatever
        // the URLs say — the fragment of an error page is not a route.
        val retry = failure != null
        val navigate = retry || current != target
        val sameDocument = !retry && WebBackStack.isSameDocument(current, target)
        val replaces = !retry && WebBackStack.replacesEntry(current, target)

        truncateOnLoad = navigate && !sameDocument
        floor = WebBackStack.floorAfterShow(
            indexBeforeLoad = view.copyBackForwardList().currentIndex,
            // A cross-document open gets its floor from doUpdateVisitedHistory
            // instead; until then this leaves it where it is, so Back during the
            // load closes the screen rather than walking somewhere behind it. A
            // replacing open adds nothing to stop at either.
            pushedOneEntry = navigate && sameDocument && !replaces,
        )
        // Reopening the habit already loaded is the case this skips, and it is
        // not rare: open a habit, Back to the list, open it again. loadUrl would
        // re-run the route for a document that is already showing the answer.
        if (!navigate) return
        failure = null

        if (!replaces) {
            view.loadUrl(target)
            return
        }
        // Habit over habit, and the only place this class speaks JavaScript.
        //
        // `loadUrl` of a fragment PUSHES, and an entry per habit tapped is what
        // left the page's own "← Back" walking to the habit viewed before this
        // one instead of to the dashboard — see [WebBackStack.replacesEntry].
        // There is no replacing form of loadUrl, so this is `location.replace`,
        // which is a same-document fragment navigation like the one it stands in
        // for: same hashchange, same cost, one fewer entry.
        //
        // Not a bridge, and the distinction is the one the class note draws: this
        // hands the page a URL, it does not hand it anything of the app's. The
        // target is quoted rather than interpolated because `habitRoute` says not
        // every base it is given came from `ServerUrl.parse`.
        view.evaluateJavascript("location.replace(${JSONObject.quote(target)})", null)
    }

    /** Back: walk the page while there is page to walk, then close the screen. */
    fun back(onClose: () -> Unit) {
        val view = webView
        val walk = view != null && WebBackStack.shouldWalkHistory(
            currentIndex = view.copyBackForwardList().currentIndex,
            floor = floor,
            canGoBack = view.canGoBack(),
        )
        if (walk) view!!.goBack() else onClose()
    }

    fun reload() {
        webView?.reload()
    }

    /**
     * Stop the page while the app is not on screen, and start it again after.
     *
     * A WebView that outlives the screen also outlives the app being looked at,
     * and nothing else stops its JavaScript — destroying it on the way out used
     * to. The page has a reason to keep running, too: `connectivity.js` re-probes
     * with a backoff while it believes the server is unreachable, so a phone put
     * in a pocket after a check-off in a dead spot would go on asking. `onPause`
     * is the per-WebView half and `pauseTimers` the process-wide one, which is
     * only safe to call because this is the single WebView the app has.
     */
    fun pause() {
        webView?.onPause()
        webView?.pauseTimers()
    }

    fun resume() {
        webView?.resumeTimers()
        webView?.onResume()
    }

    /**
     * A WebView holds a process and a surface, so it is destroyed with the
     * activity rather than with the screen — which is the whole change here.
     */
    fun destroy() {
        webView?.apply {
            stopLoading()
            (parent as? ViewGroup)?.removeView(this)
            destroy()
        }
        webView = null
    }
}

/**
 * The server's own web UI, as a screen of this app.
 *
 * The charts, the calendar and history editing are the web app's, and there is
 * no appetite for a second implementation of any of them. What there was appetite
 * to change is the *seam*: this used to launch a Custom Tab, which leaves the
 * app entirely — a browser animates in over the top, with a URL bar, its own
 * back stack, and (on a fresh device) Chrome's own "Make Chrome your own"
 * sign-in prompt in front of your habits. It reads as being thrown out of the
 * app, because it is.
 *
 * A WebView inside a Scaffold reads as a screen: the app's own top bar, the
 * app's own back arrow, and the system back gesture walking the *page* history
 * before it leaves. Same HTML, no seam.
 *
 * **This composable is always in the tree**, and [shown] is what moves — see
 * [WebHost] for why the WebView has to be laid out before it is wanted. Hiding
 * is three separate things because they are three separate problems: `alpha` so
 * it is not drawn, `zIndex` so it sits behind the list rather than in front of
 * it, and `clearAndSetSemantics` so a screen reader does not walk a page nobody
 * can see. The WebView itself goes INVISIBLE, which is what stops it taking
 * touches while keeping the width its layout depends on.
 *
 * None of those four is hit testing, and the top bar looks like it should be a
 * problem: `alpha` does not stop a tap arriving, and the bar's Back and Reload
 * are Compose rather than View, so unlike the WebView they stay live while
 * hidden. They are unreachable anyway, and the reason is worth writing down
 * because the blocker Box in MainActivity exists for the same hazard in the
 * other direction. Compose hit-tests through anything that does not consume, and
 * the habit list's own `Text("Today")` does not — but the `TopAppBar` holding it
 * is a Material `Surface`, which does. So the list's bar covers this one for the
 * whole width of the screen. Measured on a device rather than assumed: three
 * taps on the list's title, and the page behind had not moved.
 *
 * What it deliberately does NOT do:
 *   - no JavaScript bridge. The page talks to the same REST API over the same
 *     session as any browser; a bridge would be a second, privileged path into
 *     the app for a page to use, which is a thing to justify rather than to add.
 *   - no cookie or cache sharing with Chrome. A WebView has its own store, so
 *     the cloud edition's OIDC sign-in happens here on its own terms.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WebScreen(
    host: WebHost,
    title: String,
    shown: Boolean,
    onClose: () -> Unit,
) {
    // Only when this screen is the one on top. Left always-enabled it would
    // swallow Back for the habit list underneath, which is now a live risk
    // rather than a theoretical one: the composable no longer leaves the tree
    // when the screen closes.
    BackHandler(enabled = shown) { host.back(onClose) }

    // The colour the WebView paints before it has anything to paint. Without it
    // that is white, which is a flash of the wrong colour on the way into a dark
    // theme — and the reused WebView means it is only ever seen once, so it
    // would have been easy to keep blaming on the page.
    val background = MaterialTheme.colorScheme.background.toArgb()

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .zIndex(if (shown) 1f else -1f)
            .alpha(if (shown) 1f else 0f)
            .then(if (shown) Modifier else Modifier.clearAndSetSemantics {}),
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = { host.back(onClose) }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    TextButton(onClick = { host.reload() }) { Text("Reload") }
                },
            )
        }
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            // A thin bar rather than a spinner over the page: the web app paints
            // its own shell quickly, so covering it would look slower than it is.
            if (host.loading) LinearProgressIndicator(Modifier.fillMaxWidth())

            host.failure?.let { message ->
                Text(
                    message,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(24.dp),
                )
            }

            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context -> host.view(context) },
                update = { view ->
                    view.setBackgroundColor(background)
                    view.visibility = if (shown) View.VISIBLE else View.INVISIBLE
                },
            )
        }
    }
}
