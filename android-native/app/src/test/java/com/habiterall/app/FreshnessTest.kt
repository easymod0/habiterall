package com.habiterall.app

import com.habiterall.app.data.Freshness
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Whether this client asks cloud's `/overview` memo to rebuild, and for how
 * long after a write.
 *
 * Everything the interceptor DECIDES is here, and that split is the point:
 * `AppSettingsDefaultsTest` can only read source text, and source text cannot
 * see an inverted comparison. Measured while writing this — with the method
 * gate lifted out of the interceptor's condition and its binding left in
 * place, the wiring guard passed unchanged while the phone had begun asking
 * for a rebuild on every write it made. So the rule moved into a pure function
 * and this drives it directly; the guard is left asserting only that the
 * interceptor calls it.
 *
 * Every boundary is a LITERAL rather than `Freshness.WINDOW_MS`, for the
 * reason the root `CLAUDE.md` gives: a test that imports the constant it
 * checks pins the name and nothing else, and would follow the window silently
 * down under cloud's 2s TTL — the one value that reintroduces the bug the
 * header exists for.
 */
class FreshnessTest {

    @Before
    fun clean() {
        Freshness.reset()
    }

    @Test
    fun `no write means no header, however late it is asked`() {
        assertNull("a client that has written nothing has nothing to be fresh about",
            Freshness.headerFor("GET", 0L))
        // The overflow case, and the reason `lastWriteAt` is null rather than a
        // sentinel: `now - Long.MIN_VALUE` wraps negative, which compares BELOW
        // the window and would report it open on a client that never wrote.
        assertNull(Freshness.headerFor("GET", Long.MAX_VALUE))
    }

    @Test
    fun `the window is open for three seconds after a write and then shut`() {
        Freshness.noteAnswer("PUT", 1_000L)

        assertEquals("the refetch immediately behind the write is the whole point",
            "1", Freshness.headerFor("GET", 1_000L))
        assertEquals("1", Freshness.headerFor("GET", 1_000L + 2_999L))
        assertNull("3000ms is outside it, not the last millisecond inside it",
            Freshness.headerFor("GET", 1_000L + 3_000L))
        assertNull(Freshness.headerFor("GET", 1_000L + 60_000L))
    }

    @Test
    fun `only a read carries it`() {
        Freshness.noteAnswer("PUT", 1_000L)

        // A write has no memoised answer to be refused, so sending it there
        // asks the server to rebuild a dashboard nobody is about to read. This
        // is the check that the wiring guard cannot make: it is one `!=` away
        // from the version that sends it on every write and no read.
        for (method in listOf("PUT", "POST", "DELETE", "PATCH")) {
            assertNull("$method must not carry the header",
                Freshness.headerFor(method, 1_500L))
        }
        assertEquals("1", Freshness.headerFor("GET", 1_500L))
    }

    @Test
    fun `only a write opens it`() {
        // The other half of the same `!=`, and the direction that fails
        // silently: a version keying on reads leaves the window shut after
        // every real write, so the phone stops asking exactly when it matters
        // and nothing anywhere reports it.
        Freshness.noteAnswer("GET", 1_000L)
        assertNull("a read must not open the window", Freshness.headerFor("GET", 1_100L))

        Freshness.noteAnswer("POST", 2_000L)
        assertEquals("1", Freshness.headerFor("GET", 2_100L))
    }

    @Test
    fun `it exceeds cloud's own TTL, which is the whole argument for the number`() {
        // 2_000 is `OVERVIEW_TTL_MS`. A window at or under it leaves a gap in
        // which a replica can still hold an entry built before the write while
        // this client has stopped asking for a rebuild — which reads exactly
        // like the bug the header was added to close. Asserted as a relation to
        // a literal 2000 rather than by importing anything, since the two
        // numbers live in different languages.
        assertTrue("the freshness window must outlast cloud's 2s memo TTL",
            Freshness.WINDOW_MS > 2_000L)
    }

    @Test
    fun `a later write reopens it`() {
        Freshness.noteAnswer("PUT", 1_000L)
        assertNull(Freshness.headerFor("GET", 10_000L))

        // The outbox draining a queued check-off is a write like any other, and
        // it is the one that must not be followed by a memoised dashboard.
        Freshness.noteAnswer("PUT", 10_000L)
        assertEquals("1", Freshness.headerFor("GET", 10_500L))
    }
}
