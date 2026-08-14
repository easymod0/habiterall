/**
 * A minimal Discord gateway client — enough to receive button presses.
 *
 * Discord delivers interactions two ways: an HTTPS endpoint it calls, or this
 * WebSocket the bot opens. The socket is the right one here by a distance: a
 * self-hosted habiterall behind a home router has no inbound port and no public
 * hostname, and requiring one would mean the interactive reminders only worked
 * for people who had already solved a harder problem. An outbound connection
 * needs nothing.
 *
 * It is also why there is no request-signature verification anywhere in this
 * feature: an HTTP interactions endpoint must prove each request really came
 * from Discord, whereas a socket is authenticated once, by the bot token, and
 * nothing else can put frames on it.
 *
 * Hand-rolled rather than a library: this needs four opcodes out of Discord's
 * twelve, no voice, no cache, no sharding, and one intent-free IDENTIFY —
 * against a dependency that would be the largest in the project. Node 22's
 * global WebSocket does the rest.
 *
 * The state machine below is the part that is easy to get subtly wrong, so it
 * is written once and tested against a fake socket (test/discord.test.js):
 *
 *   HELLO(10)          -> start heartbeating, then IDENTIFY(2)
 *   HEARTBEAT_ACK(11)  -> the connection is alive
 *   HEARTBEAT(1)       -> Discord asking for one immediately
 *   DISPATCH(0)        -> READY (session) or INTERACTION_CREATE (a click)
 *   RECONNECT(7)       -> close and RESUME(6) where we left off
 *   INVALID_SESSION(9) -> resume if it says we may, otherwise start over
 *
 * A missing ACK is the failure that matters most: the socket stays open and
 * silent, so without watching for it the bot looks connected and receives
 * nothing. That is what the `acked` flag is for — an unacknowledged heartbeat
 * closes the socket and resumes rather than waiting for a close that will never
 * come.
 *
 * One disconnect must produce exactly ONE reconnect, and that is harder than it
 * looks: closing a socket ourselves also fires its own `onclose`, so a handler
 * left attached schedules a second one. Two sockets then race, only the newer is
 * heartbeated, and Discord closes the older a couple of intervals later — whose
 * `onclose` schedules a third. `detach` and the identity guard in `open` are
 * both there for that, and `scheduleReconnect` is idempotent as a third line of
 * defence.
 */

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

/**
 * Close codes Discord will not let us recover from by reconnecting.
 * Retrying these is how a bad token turns into a reconnect loop that hammers
 * the gateway until it bans the IP.
 */
export const FATAL_CLOSE_CODES = new Set([
  4004,  // authentication failed — the token is wrong
  4010,  // invalid shard
  4011,  // sharding required
  4012,  // invalid API version
  4013,  // invalid intents
  4014,  // disallowed intents (a privileged intent we did not enable)
]);

/** Backoff between reconnect attempts, in ms. Capped, and never zero. */
const RECONNECT_DELAYS = [1_000, 5_000, 15_000, 30_000, 60_000];

/**
 * No intents at all.
 *
 * Intents gate *events about the guild* — messages, members, presence. An
 * application's own interactions are delivered regardless, so asking for
 * nothing is both sufficient and the smallest possible grant: this bot cannot
 * read a single message in the channel it posts to.
 */
const INTENTS = 0;

/**
 * Connect, and call `onInteraction` for every button press.
 *
 * @param {object} opts
 * @param {string} opts.token
 * @param {(interaction: any) => any} opts.onInteraction
 * @param {new (url: string) => any} [opts.WebSocketImpl] injected for tests
 * @param {{log?: Function, warn?: Function, error?: Function}} [opts.log]
 * @param {(fn: () => void, ms: number) => any} [opts.setTimeoutImpl] injected for
 *   tests, so a reconnect can be observed without waiting for one
 * @returns {{stop: () => void, state: () => string}}
 */
export function connectGateway(opts) {
  const {
    token,
    onInteraction,
    WebSocketImpl = globalThis.WebSocket,
    log = console,
    setTimeoutImpl = setTimeout,
  } = opts;

  if (!token) throw new Error('connectGateway needs a bot token');
  if (!WebSocketImpl) throw new Error('no WebSocket implementation available');

  let ws = null;
  let heartbeat = null;
  let reconnect = null;
  let sequence = null;
  let sessionId = null;
  let resumeUrl = null;
  let acked = true;
  let attempt = 0;
  let stopped = false;
  let state = 'connecting';

  function clearHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  /**
   * Stop listening to a socket we are done with.
   *
   * `close()` fires `onclose`, so a socket being deliberately discarded still
   * reports itself as an unexpected disconnect unless its handlers come off
   * first — which is how one reconnect became two.
   */
  function detach(socket) {
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  function send(payload) {
    try {
      ws?.send(JSON.stringify(payload));
    } catch (err) {
      log.warn?.('discord gateway: send failed', err?.message ?? err);
    }
  }

  function startHeartbeat(intervalMs) {
    clearHeartbeat();
    acked = true;
    heartbeat = setInterval(() => {
      if (!acked) {
        // Silent socket: Discord's own guidance is to close with a non-1000
        // code and resume, because a plain close would drop the session.
        log.warn?.('discord gateway: no heartbeat ack, reconnecting');
        closeAndReconnect(4000);
        return;
      }
      acked = false;
      send({ op: OP.HEARTBEAT, d: sequence });
    }, intervalMs);
    heartbeat.unref?.();
  }

  function identify() {
    if (sessionId && sequence !== null) {
      state = 'resuming';
      send({ op: OP.RESUME, d: { token, session_id: sessionId, seq: sequence } });
      return;
    }
    state = 'identifying';
    send({
      op: OP.IDENTIFY,
      d: {
        token,
        intents: INTENTS,
        properties: { os: process.platform, browser: 'habiterall', device: 'habiterall' },
      },
    });
  }

  function closeAndReconnect(code = 4000) {
    clearHeartbeat();
    // Nulled BEFORE the close, so the identity guard in `open` already sees this
    // socket as superseded if its `onclose` fires synchronously.
    const dying = ws;
    ws = null;
    detach(dying);
    try {
      dying?.close(code);
    } catch { /* already gone */ }
    scheduleReconnect();
  }

  /**
   * Idempotent: a second call while one is already pending is a no-op rather
   * than a second socket. Nothing should reach here twice for one disconnect,
   * but the cost of being wrong about that is socket churn against Discord's
   * identify limit, so it is cheap insurance.
   */
  function scheduleReconnect() {
    if (stopped || reconnect) return;
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    attempt++;
    state = 'waiting';
    reconnect = setTimeoutImpl(() => {
      reconnect = null;
      open();
    }, delay);
    reconnect?.unref?.();
  }

  function handle(frame) {
    if (frame.s !== null && frame.s !== undefined) sequence = frame.s;

    switch (frame.op) {
      case OP.HELLO:
        startHeartbeat(frame.d?.heartbeat_interval ?? 41_250);
        identify();
        break;

      case OP.HEARTBEAT:
        // Discord asking for one now, outside our own interval.
        send({ op: OP.HEARTBEAT, d: sequence });
        break;

      case OP.HEARTBEAT_ACK:
        acked = true;
        break;

      case OP.INVALID_SESSION:
        // `d === true` means the session may still be resumed; anything else
        // means forget it and identify afresh.
        if (frame.d !== true) {
          sessionId = null;
          sequence = null;
        }
        closeAndReconnect(4000);
        break;

      case OP.RECONNECT:
        closeAndReconnect(4000);
        break;

      case OP.DISPATCH:
        if (frame.t === 'READY') {
          sessionId = frame.d?.session_id ?? null;
          resumeUrl = frame.d?.resume_gateway_url ?? null;
          attempt = 0;                       // a good connection resets backoff
          state = 'ready';
          log.log?.(`discord gateway: connected as ${frame.d?.user?.username ?? 'bot'}`);
        } else if (frame.t === 'RESUMED') {
          attempt = 0;
          state = 'ready';
        } else if (frame.t === 'INTERACTION_CREATE') {
          // Never let a handler's failure take the socket down with it: the
          // next click has to still work.
          Promise.resolve()
            .then(() => onInteraction(frame.d))
            .catch((err) => log.error?.('discord gateway: interaction handler failed', err));
        }
        break;

      default:
        break;                               // an opcode we do not need
    }
  }

  function open() {
    if (stopped) return;
    state = 'connecting';

    // Resuming must go to the URL READY gave us; a fresh session uses the
    // published one.
    const url = sessionId && resumeUrl ? `${resumeUrl}/?v=10&encoding=json` : GATEWAY_URL;

    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (err) {
      log.error?.('discord gateway: could not open a socket', err?.message ?? err);
      scheduleReconnect();
      return;
    }
    ws = socket;

    // Every handler below asks whether it is still the current socket first. A
    // real close is asynchronous, so a socket can be replaced before its own
    // events arrive; without the guard, a superseded socket's late close tears
    // down the connection that replaced it.
    socket.onmessage = (event) => {
      if (socket !== ws) return;
      let frame;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;                              // not JSON; nothing to do with it
      }
      try {
        handle(frame);
      } catch (err) {
        log.error?.('discord gateway: frame handling failed', err);
      }
    };

    socket.onclose = (event) => {
      if (socket !== ws) return;
      clearHeartbeat();
      ws = null;
      const code = event?.code;

      if (FATAL_CLOSE_CODES.has(code)) {
        state = 'failed';
        log.error?.(
          `discord gateway: closed ${code} — this will not recover by retrying. ` +
          (code === 4004
            ? 'DISCORD_BOT_TOKEN is wrong or was regenerated.'
            : 'Check the application\'s gateway configuration.')
        );
        stopped = true;                      // deliberate: do not loop on this
        return;
      }

      if (stopped) return;
      log.warn?.(`discord gateway: closed ${code ?? '(no code)'}, reconnecting`);
      scheduleReconnect();
    };

    socket.onerror = (err) => {
      // A socket error is always followed by a close, which is where the
      // reconnect happens; logging twice would be noise.
      log.warn?.('discord gateway: socket error', err?.message ?? '');
    };
  }

  open();

  return {
    stop() {
      stopped = true;
      clearHeartbeat();
      if (reconnect) clearTimeout(reconnect);
      reconnect = null;
      const dying = ws;
      ws = null;
      detach(dying);
      try {
        dying?.close(1000);
      } catch { /* already gone */ }
      state = 'stopped';
    },
    state: () => state,
  };
}
