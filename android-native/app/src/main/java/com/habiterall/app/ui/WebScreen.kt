package com.habiterall.app.ui

import android.annotation.SuppressLint
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

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
 * What it deliberately does NOT do:
 *   - no JavaScript bridge. The page talks to the same REST API over the same
 *     session as any browser; a bridge would be a second, privileged path into
 *     the app for a page to use, which is a thing to justify rather than to add.
 *   - no cookie or cache sharing with Chrome. A WebView has its own store, so
 *     the cloud edition's OIDC sign-in happens here on its own terms.
 */
@SuppressLint("SetJavaScriptEnabled")   // it is our own page
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WebScreen(
    url: String,
    title: String,
    onClose: () -> Unit,
) {
    // Held so the back gesture and the back arrow can walk the page history,
    // and so a reload survives recomposition.
    var webView by remember { mutableStateOf<WebView?>(null) }
    var loading by remember { mutableStateOf(true) }
    var canGoBack by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }

    // Back goes back through the pages first, and only then out of the screen.
    // A Custom Tab could not do this: its back stack was the browser's.
    BackHandler(enabled = true) {
        val view = webView
        if (view != null && view.canGoBack()) view.goBack() else onClose()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = {
                        val view = webView
                        if (view != null && view.canGoBack()) view.goBack() else onClose()
                    }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    TextButton(onClick = { webView?.reload() }) { Text("Reload") }
                },
            )
        }
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            // A thin bar rather than a spinner over the page: the web app paints
            // its own shell quickly, so covering it would look slower than it is.
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())

            failure?.let { message ->
                Text(
                    message,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(24.dp),
                )
            }

            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    WebView(context).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        settings.javaScriptEnabled = true       // the app IS JavaScript
                        settings.domStorageEnabled = true       // localStorage: the settings cache
                        settings.databaseEnabled = true
                        // The PWA's own service worker and outbox keep working,
                        // so a check-off made in here survives a dropped
                        // connection exactly as it does in a browser.
                        webViewClient = object : WebViewClient() {
                            override fun onPageFinished(view: WebView?, url: String?) {
                                loading = false
                                canGoBack = view?.canGoBack() == true
                            }

                            override fun onReceivedError(
                                view: WebView?,
                                request: WebResourceRequest?,
                                error: WebResourceError?,
                            ) {
                                // Only the main document; a failed icon is not
                                // worth a full-screen error.
                                if (request?.isForMainFrame == true) {
                                    loading = false
                                    failure = "Could not load $url"
                                }
                            }
                        }
                        loadUrl(url)
                        webView = this
                    }
                },
            )
        }
    }

    // A WebView holds a process and a surface; leaving one alive behind a
    // screen that is gone is how an app starts using memory it cannot explain.
    DisposableEffect(Unit) {
        onDispose {
            webView?.apply {
                stopLoading()
                destroy()
            }
            webView = null
        }
    }
}
