package com.habiterall.app

import com.habiterall.app.data.ApiException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a queued check-off does when the server refuses it.
 *
 * The rule lives on [ApiException] rather than in `Outbox.SyncWorker` so it can
 * be pinned here without Android, and because it is a claim about the SERVER's
 * answer rather than about WorkManager.
 *
 * This is a mirror in spirit of the web outbox's replay loop: it drops any 4xx
 * other than 401 and 403 as permanently inapplicable, and the two exceptions
 * were each paid for. See the root CLAUDE.md.
 */
class OutboxRetryTest {

    private fun status(code: Int) = ApiException(code, "refused")

    @Test
    fun `a refused write is not retried`() {
        // The habit was deleted on another device; the date is in the future
        // because the phone's clock is ahead of the server's. Neither changes by
        // asking again, and this is a background worker with a battery to spend.
        for (code in listOf(400, 404, 409, 413, 422)) {
            assertTrue("$code should be permanent", status(code).isPermanent)
        }
    }

    @Test
    fun `a refused session keeps its place in the queue`() {
        // 401: the cookie expired while the phone was in a pocket. The answer
        // tapped on the notification is still true about that day, and it comes
        // back the moment the user signs in.
        //
        // 403: `sameOriginOnly` refusing a write whose Origin does not match,
        // which a proxy that rewrites Host with no hop trusted makes true of
        // EVERY write from this app. Treating that as a verdict on the write
        // destroyed the web app's entire queue on the first flush after such a
        // misconfiguration — and it is a misconfiguration that gets fixed.
        for (code in listOf(401, 403)) {
            assertFalse("$code must not be permanent", status(code).isPermanent)
            assertTrue("$code is about the session", status(code).isAuthFailure)
        }
    }

    @Test
    fun `a server fault is retried`() {
        for (code in listOf(500, 502, 503, 504)) {
            assertFalse("$code should be retried", status(code).isPermanent)
        }
    }

    @Test
    fun `a success is never mistaken for a refusal`() {
        // `isPermanent` is asked only on the error path today, but it is a
        // property on a type anyone can reach, and "2xx is permanent" would be a
        // memorable way to break the queue later.
        for (code in listOf(200, 201, 204)) {
            assertFalse(status(code).isPermanent)
            assertFalse(status(code).isAuthFailure)
        }
    }
}
