package com.habiterall.app.data

/**
 * Validation for the server address the user types in.
 *
 * The rule the network security config cannot express: plaintext http:// is
 * acceptable for a host that provably cannot leave the local network, and
 * refused otherwise. See res/xml/network_security_config.xml.
 */
object ServerUrl {

    sealed interface Result {
        /** [url] is normalised: scheme lowercased, trailing slash removed. */
        data class Ok(val url: String) : Result
        data class Invalid(val reason: String) : Result
    }

    private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

    /**
     * Hostnames that can only refer to the local network.
     *
     * A bare name with no dots (`raspberrypi`) is resolved by the LAN's own
     * DNS or by mDNS — it cannot be a public host, because public names are
     * fully qualified. `.local` is mDNS by definition, and `.home`/`.lan`/
     * `.internal` are reserved for private use.
     *
     * These were previously refused, which made the app unusable for the
     * setup it exists to serve: someone who reaches `http://raspberrypi:3000`
     * in a browser types exactly that and was told to use https, for a server
     * that has no certificate and cannot get one.
     */
    private val PRIVATE_SUFFIXES = listOf(".local", ".lan", ".home", ".internal", ".localdomain")

    /**
     * Private per RFC 1918, plus loopback, link-local, and names that cannot
     * escape the local network.
     *
     * A dotted name outside those suffixes still needs https: it resolves
     * through public DNS and could point anywhere.
     */
    fun isPrivateHost(host: String): Boolean {
        val h = host.lowercase().trim('[', ']')
        if (h == "localhost" || h == "::1") return true

        // Unqualified single-label names and reserved private suffixes are
        // LAN-only by construction.
        if (!h.contains('.')) return true
        if (PRIVATE_SUFFIXES.any { h.endsWith(it) }) return true

        val m = IPV4.matchEntire(h) ?: return false
        val (a, b) = m.groupValues.let { it[1].toInt() to it[2].toInt() }
        if (m.groupValues.drop(1).any { it.toInt() > 255 }) return false

        return when {
            a == 10 -> true                     // 10.0.0.0/8
            a == 127 -> true                    // loopback
            a == 192 && b == 168 -> true         // 192.168.0.0/16
            a == 172 && b in 16..31 -> true      // 172.16.0.0/12
            a == 169 && b == 254 -> true         // link-local
            else -> false
        }
    }

    /**
     * Where the web UI shows one habit.
     *
     * Mirrors `hashFor` in shared/public/ui/routes.js, and deliberately: the
     * route is a **fragment**, so it is never sent to the server and needs
     * nothing added to either edition to answer it. That is also why this can
     * be built by string concatenation rather than asked for — there is no
     * endpoint here, only a URL the page reads once it has loaded.
     *
     * [base] is already normalised by [parse], but not every caller's value
     * came from there — a URL restored from storage predates a normalisation
     * rule that changed — so the trailing slash is trimmed again rather than
     * assumed away. `//#/habit/3` loads the shell and then shows the
     * dashboard, which is the confusing kind of wrong: it works, just not the
     * way it was asked to.
     */
    fun habitRoute(base: String, habitId: Long): String =
        "${base.trimEnd('/')}/#/habit/$habitId"

    fun parse(input: String): Result {
        val raw = input.trim()
        if (raw.isEmpty()) return Result.Invalid("Enter your server address")

        // A bare "192.168.1.50:3000" is what people actually type. Assume the
        // scheme rather than rejecting it, then let the rules below decide.
        val withScheme = if (raw.contains("://")) raw else "http://$raw"

        val uri = runCatching { java.net.URI(withScheme) }.getOrNull()
            ?: return Result.Invalid("That does not look like a valid address")

        val scheme = uri.scheme?.lowercase()
        val host = uri.host
        if (host.isNullOrBlank()) return Result.Invalid("Missing a host name")
        if (scheme != "http" && scheme != "https") {
            return Result.Invalid("Use http:// or https://")
        }
        if (uri.port !in -1..65535) return Result.Invalid("Invalid port")

        if (scheme == "http" && !isPrivateHost(host)) {
            return Result.Invalid(
                "Plain http is only allowed for a local address " +
                    "(10.x, 192.168.x, 172.16–31.x). Use https:// for $host."
            )
        }

        val port = if (uri.port == -1) "" else ":${uri.port}"
        val path = uri.path.orEmpty().trimEnd('/')
        return Result.Ok("$scheme://${host.lowercase()}$port$path")
    }
}
