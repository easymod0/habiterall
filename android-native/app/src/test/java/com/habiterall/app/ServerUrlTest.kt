package com.habiterall.app

import com.habiterall.app.data.ServerUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The private-range rule is enforced here rather than in the network security
 * config, which cannot express CIDR ranges. That makes these tests the only
 * thing standing between a typo and habit data sent over plaintext HTTP to a
 * public host.
 */
class ServerUrlTest {

    private fun ok(input: String): String {
        val r = ServerUrl.parse(input)
        assertTrue("expected $input to be accepted, got $r", r is ServerUrl.Result.Ok)
        return (r as ServerUrl.Result.Ok).url
    }

    private fun rejected(input: String) {
        val r = ServerUrl.parse(input)
        assertTrue("expected $input to be rejected", r is ServerUrl.Result.Invalid)
    }

    @Test
    fun `http is allowed for private ranges`() {
        assertEquals("http://192.168.1.50:3000", ok("http://192.168.1.50:3000"))
        assertEquals("http://10.0.0.5:3000", ok("http://10.0.0.5:3000"))
        assertEquals("http://172.16.0.1", ok("http://172.16.0.1"))
        assertEquals("http://172.31.255.254", ok("http://172.31.255.254"))
        assertEquals("http://localhost:3000", ok("http://localhost:3000"))
    }

    @Test
    fun `http is refused for public hosts`() {
        rejected("http://example.com")
        rejected("http://8.8.8.8")
        // 172.15 and 172.32 sit just outside the private block — the most
        // likely place for an off-by-one in the range check.
        rejected("http://172.15.0.1")
        rejected("http://172.32.0.1")
        // A dotted public name still needs https.
        rejected("http://habits.example.com")
        rejected("http://myserver.example.org")
    }

    @Test
    fun `LAN hostnames are accepted over plain http`() {
        // The setup this app exists for. A single-label name cannot be a
        // public host — public names are fully qualified — and .local/.lan/
        // .home/.internal are reserved for private networks. Refusing these
        // told someone who reaches http://raspberrypi:3000 in a browser to
        // use https for a server that cannot have a certificate.
        assertEquals("http://raspberrypi:3000", ok("http://raspberrypi:3000"))
        assertEquals("http://habiterall:3000", ok("habiterall:3000"))
        assertEquals("http://nas.local:3000", ok("http://nas.local:3000"))
        assertEquals("http://server.lan:3000", ok("http://server.lan:3000"))
        assertEquals("http://box.home:3000", ok("http://box.home:3000"))
    }

    @Test
    fun `https is allowed anywhere`() {
        assertEquals("https://habits.example.com", ok("https://habits.example.com"))
        assertEquals("https://192.168.1.50:8443", ok("https://192.168.1.50:8443"))
    }

    @Test
    fun `a bare address is assumed to be http`() {
        assertEquals("http://192.168.1.50:3000", ok("192.168.1.50:3000"))
        // ...and the private-range rule still applies to it.
        rejected("example.com")
    }

    @Test
    fun `normalisation strips trailing slashes and lowercases the host`() {
        assertEquals("http://192.168.1.50:3000", ok("http://192.168.1.50:3000/"))
        assertEquals("https://habits.example.com", ok("HTTPS://Habits.Example.COM/"))
        assertEquals("https://example.com/habits", ok("https://example.com/habits/"))
    }

    @Test
    fun `junk is refused`() {
        rejected("")
        rejected("   ")
        rejected("ftp://192.168.1.50")
        rejected("http://")
        // Octets above 255 are not a valid address, so not a private one.
        rejected("http://192.168.1.999")
        rejected("http://999.999.999.999")
    }

    /**
     * Pinned to the same examples as `shared/test/routes.test.js`, because the
     * fragment this builds is parsed by `shared/public/ui/routes.js` — one of
     * them changing shape alone is a habit page that silently opens the
     * dashboard instead.
     */
    @Test
    fun `habitRoute names the habit the web UI will show`() {
        assertEquals(
            "http://192.168.1.50:3000/#/habit/42",
            ServerUrl.habitRoute("http://192.168.1.50:3000", 42)
        )
        assertEquals(
            "https://habits.example.com/#/habit/1",
            ServerUrl.habitRoute("https://habits.example.com", 1)
        )
    }

    @Test
    fun `habitRoute does not double the slash`() {
        // A base with a trailing slash yields `//#/habit/3`, which loads the
        // app and then shows the dashboard — it works, just not as asked.
        assertEquals(
            "http://10.0.2.2:3000/#/habit/3",
            ServerUrl.habitRoute("http://10.0.2.2:3000/", 3)
        )
    }

    @Test
    fun `isPrivateHost covers the boundaries`() {
        assertTrue(ServerUrl.isPrivateHost("10.0.0.0"))
        assertTrue(ServerUrl.isPrivateHost("10.255.255.255"))
        assertTrue(ServerUrl.isPrivateHost("192.168.0.0"))
        assertTrue(ServerUrl.isPrivateHost("127.0.0.1"))
        assertTrue(ServerUrl.isPrivateHost("169.254.1.1"))
        assertTrue(!ServerUrl.isPrivateHost("11.0.0.1"))
        assertTrue(!ServerUrl.isPrivateHost("192.169.0.1"))
        assertTrue(!ServerUrl.isPrivateHost("1.1.1.1"))
    }
}
