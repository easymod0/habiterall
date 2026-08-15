package com.habiterall.app.ui

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.habiterall.app.data.Api
import com.habiterall.app.data.AuthMode
import com.habiterall.app.data.Session
import kotlinx.coroutines.launch

/**
 * Sign in, in whichever of the two ways this server has.
 *
 * The split is not cosmetic. The personal edition holds one credential and can
 * be asked for it directly, so this draws a form and posts it. The cloud
 * edition signs people in by redirecting to an identity provider, which no
 * native form can stand in for — the provider decides what to ask, and it may
 * be a password, a passkey, or somebody else's login page entirely.
 *
 * So cloud gets the server's own sign-in, loaded in a WebView. That is not a
 * fallback: it is the only way a native client can reach an OIDC session
 * without either the server growing a token endpoint or this app shipping an
 * OAuth client the operator would have to register. And it works because the
 * session is a COOKIE — see `WebSession` for why one store serves both halves
 * of this app, and `shared/src/security.js` for the server side of the same
 * decision.
 *
 * The copy per mode mirrors `COPY` in `shared/public/auth-session.js`, for the
 * reason every mirror in this app exists: two clients describing one instance
 * differently reads as one of them being wrong.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SignInScreen(
    api: Api,
    mode: AuthMode,
    /** Called once the server confirms a session. */
    onSignedIn: () -> Unit,
    /** The way out for someone who typed the wrong server address. */
    onChangeServer: () -> Unit,
) {
    var browser by remember { mutableStateOf(false) }

    if (browser) {
        BrowserSignIn(
            api = api,
            onSignedIn = onSignedIn,
            onCancel = { browser = false },
        )
        return
    }

    val scope = rememberCoroutineScope()
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    // SETUP is the same form doing a different thing: there is no account yet,
    // and this creates it. Saying "sign in" there would be a lie about what the
    // button does, and the warning underneath is the point — the instance is
    // unclaimed, so the window is open to whoever reaches it first.
    val claiming = mode == AuthMode.SETUP

    Scaffold(
        topBar = {
            TopAppBar(title = { Text(if (claiming) "Create your account" else "Sign in") })
        },
    ) { pad ->
        Column(
            Modifier.padding(pad).padding(24.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (mode == AuthMode.OIDC) {
                Text(
                    "This server signs you in through your organisation's " +
                        "identity provider. The next screen is the provider's own.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Button(
                    onClick = { browser = true },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Continue") }
            } else {
                Text(
                    if (claiming) {
                        "This server has no account yet. The first person to " +
                            "create one owns it — do this now if the address is " +
                            "reachable from anywhere but your own network."
                    } else {
                        "Sign in with the account this server was set up with."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it; error = null },
                    label = { Text("Username") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it; error = null },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    isError = error != null,
                    supportingText = { error?.let { Text(it) } },
                    modifier = Modifier.fillMaxWidth(),
                )
                // Only when CREATING one, and `auth-session.js` shows the same
                // field in the same mode. A typo signing in costs one more
                // attempt; a typo here is stored as the only credential a
                // personal instance has, invisibly, with no way back to it from
                // this app — the operator has to go to the environment or the
                // database.
                if (claiming) {
                    OutlinedTextField(
                        value = confirm,
                        onValueChange = { confirm = it; error = null },
                        label = { Text("Confirm password") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Button(
                    enabled = !busy && username.isNotBlank() && password.isNotBlank() &&
                        (!claiming || confirm.isNotBlank()),
                    onClick = {
                        if (claiming && password != confirm) {
                            error = "The two passwords do not match."
                            return@Button
                        }
                        busy = true
                        error = null
                        scope.launch {
                            val why = if (claiming) {
                                api.createAccount(username, password)
                            } else {
                                api.signIn(username, password)
                            }
                            busy = false
                            // The server's own wording, not ours. It answers one
                            // message for a wrong username and a wrong password
                            // alike, and improving on it here would say which
                            // half was right.
                            if (why != null) error = why else onSignedIn()
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        when {
                            busy -> "Working…"
                            claiming -> "Create account"
                            else -> "Sign in"
                        }
                    )
                }
            }

            TextButton(onClick = onChangeServer, modifier = Modifier.fillMaxWidth()) {
                Text("Use a different server")
            }
        }
    }
}

/**
 * The server's own sign-in, in a WebView, for a session this app cannot ask for
 * directly.
 *
 * A WebView of its own rather than the activity's shared one. That one carries
 * a back-stack contract — see `WebBackStack`, where which entry a load lands on
 * is load bearing — and an OIDC round trip is several redirects through hosts
 * this app does not control, which is precisely the traffic that contract does
 * not describe. This one has no such contract: it is opened, it finishes, and
 * it goes away.
 *
 * **Completion is asked, not inferred.** The obvious test is "did a cookie
 * appear", and it is wrong twice: a session cookie can exist before anybody has
 * signed in, and the redirect chain ends at a URL this app has no business
 * pattern-matching. So every settled page asks `/api/me`, which is the one
 * authority on whether there is a session — the same question the app boots on.
 */
@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")   // an identity provider's page needs it
@Composable
private fun BrowserSignIn(
    api: Api,
    onSignedIn: () -> Unit,
    onCancel: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    BackHandler(onBack = onCancel)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Sign in") },
                actions = { TextButton(onClick = onCancel) { Text("Cancel") } },
            )
        },
    ) { pad ->
        AndroidView(
            modifier = Modifier.fillMaxSize().padding(pad),
            // Cancelling or finishing swaps this branch out, which detaches the
            // WebView without ending it — leaving an identity provider's page
            // and its JavaScript running in a pocket. `WebHost.destroy` exists
            // for exactly that on the other WebView in this app.
            onRelease = { view ->
                view.stopLoading()
                view.loadUrl("about:blank")
                view.destroy()
            },
            factory = { context ->
                WebView(context).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView?, url: String?) {
                            scope.launch {
                                if (api.me() is Session.Active) onSignedIn()
                            }
                        }
                    }
                    loadUrl(api.signInUrl)
                }
            },
        )
    }
}
