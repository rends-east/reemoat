/**
 * The vocabulary both ends of the relay tunnel agree on.
 *
 * This file is imported by the daemon (`src/relay/tunnel.ts`) *and* by the
 * control plane (`packages/control-plane/src/relay/*`). The dependency still
 * runs one way — the control plane may import from `src/`, never the reverse —
 * so the shared names live here rather than being typed out twice and drifting.
 *
 * There is no framing code here. Multiplexing is HTTP/2 over the tunnel socket,
 * so stream ids, per-stream flow control, per-stream reset and connection
 * shutdown are all h2's and none of them is ours to invent. What is ours is the
 * handshake: which headers open a stream, what they may say, and which close
 * codes mean what.
 */

/**
 * The newest tunnel protocol version this build speaks.
 *
 * Sent on the tunnel handshake and on every stream. A relay that cannot speak
 * what a daemon offers refuses the handshake with an ordinary HTTP status rather
 * than guessing, because the alternative is a daemon that appears connected and
 * silently mis-parses every request.
 */
export const RELAY_PROTOCOL_VERSION = 1;

/**
 * The oldest tunnel protocol version this build still speaks.
 *
 * **This pair is what stops a protocol bump being a flag day**, and the flag day
 * was real: the relay used to compare the daemon's version to its own with
 * `!==`, so the moment either side moved to 2 it refused the other with 426. On
 * a fleet where the control plane is deployed centrally every week and daemons
 * are updated by hand on other people's laptops, that is the whole fleet dark
 * until the last machine is touched — and the relay is the only way in, so
 * "dark" is not a degradation, it is off.
 *
 * With a range, a bump is instead: ship a relay that speaks `1..2` first, let
 * daemons move to 2 whenever their owners get to it, and raise the floor only
 * once nothing is left below it — which `cpctl admin fleet` is what answers.
 *
 * Equal to the maximum today, which is the honest state of a project at 0.1.0
 * with one protocol version. The mechanism is still live, and `relaycheck`
 * asserts it by offering a version from the future.
 */
export const RELAY_PROTOCOL_MIN_VERSION = 1;

/**
 * What a peer that sends no version header is speaking.
 *
 * ⚠ **A literal, and it may never become `RELAY_PROTOCOL_MIN_VERSION`.** Both
 * ends have a missing-header rule — the relay for a daemon that omits
 * `TUNNEL_VERSION_HEADER`, the daemon for a relay that omits
 * `TUNNEL_AGREED_VERSION_HEADER` — and both were written as "the floor", which is
 * the same number today and is not the same *fact*. Silence means the peer
 * predates version negotiation, and something that predates it speaks 1 for ever;
 * the floor is a thing this build chooses and moves.
 *
 * The two come apart at step 4 of the rollout in `.claude/rules/compatibility.md`,
 * which is the moment the floor is raised. Read as the floor, a pre-header daemon
 * offering nothing is taken to have offered 2, negotiated to 2, **accepted**, and
 * told it agreed v2 — so the one class of machine raising the floor is meant to
 * cut off is instead let in and handed frames it cannot parse. That is
 * `RELAY_PROTOCOL_VERSION`'s own "appears connected and silently mis-parses every
 * request", arriving through the door left open for compatibility.
 *
 * Read as 1 it is refused with a 426 that names what to do, which is what a floor
 * being raised past a machine is supposed to look like.
 */
export const PRE_NEGOTIATION_PROTOCOL_VERSION = 1;

/**
 * The version both ends will actually speak, or `null` if there is no overlap.
 *
 * Pure, exported, and shared by both ends rather than written twice — the relay
 * decides with it and `relaycheck` asserts it directly, with no socket. The rule
 * is "the newest both can speak": a daemon offering more than this relay knows
 * is negotiated **down** rather than refused, which is the half that makes a
 * daemon safe to update before the relay it dials.
 */
export function negotiateProtocolVersion(offered: number): number | null {
  if (!Number.isInteger(offered)) return null;
  if (offered < RELAY_PROTOCOL_MIN_VERSION) return null;
  return Math.min(offered, RELAY_PROTOCOL_VERSION);
}

/** The one path the relay keeps for itself. Everything else is proxied to a daemon. */
export const TUNNEL_PATH = "/__relay/tunnel";

/**
 * The header a daemon presents its tunnel credential in.
 *
 * A credential, and *only* a credential. There is deliberately no machine-id
 * header, query parameter or handshake field anywhere in this protocol: the
 * relay derives the machine id by looking the credential up. "A daemon cannot
 * open a tunnel claiming a machine id that isn't its own" is therefore a
 * property of the lookup rather than a check somebody has to remember to write.
 */
export const TUNNEL_AUTH_HEADER = "authorization";

/** Announced by the daemon on the tunnel handshake so the relay can refuse a version it cannot speak. */
export const TUNNEL_VERSION_HEADER = "x-reemoat-relay-version";

/**
 * What the relay answers with on the 101, so the daemon learns what was agreed.
 *
 * Without it the daemon knows only that it was not refused, which is enough for
 * one version and stops being enough at two: a daemon offering 2 to a relay that
 * speaks 1 is *accepted*, and has to be told to speak 1. The negotiated number
 * comes back here.
 */
export const TUNNEL_AGREED_VERSION_HEADER = "x-reemoat-relay-agreed";

/**
 * The daemon's own build, announced on the handshake.
 *
 * **Advisory, and never a decision** — the same rule as `reemoat-sub`. Nothing
 * authorizes on it, nothing branches on it, and a daemon that omits it is
 * treated exactly as one that sends it. What it buys is the question a staged
 * rollout cannot be planned without: *what is actually out there?* The relay
 * records it against the machine, and `cpctl admin fleet` reads it back.
 *
 * It rides the tunnel handshake rather than the enrollment exchange on purpose.
 * Enrollment happens **once, ever** — a daemon captures its key set there and
 * never asks the control plane anything again — so a fact recorded at enrollment
 * is frozen for the life of the machine and would describe the build that
 * enrolled rather than the build running now. The handshake repeats on every
 * reconnect, which is what makes it the right place for anything that changes.
 */
export const DAEMON_VERSION_HEADER = "x-reemoat-daemon-version";

/** How much of a daemon-supplied version string is recorded. It is a label, not a key. */
export const MAX_DAEMON_VERSION_CHARS = 64;

/**
 * Which build of each coding-agent CLI the daemon would launch, announced on the
 * handshake beside `DAEMON_VERSION_HEADER` and under exactly the same rule:
 * **advisory, recorded, branched on by nothing.** A daemon that omits it — every
 * daemon older than this header — dials, enrolls and is listed the same as one
 * that sends it, with the field `null`.
 *
 * What it buys is the second half of the question the daemon version already
 * answers: *which machines are running a July claude?* The CLIs move under a
 * running daemon — `deploy/agents.sh` repoints them daily, an operator may pin one
 * by hand, a copy dropped into `~/.local/bin` is the build within ten minutes
 * (Q6.106) — so the daemon's own version says nothing about them, and until this
 * header the only way to learn what a machine was running was to open a shell on
 * it. `cpctl admin fleet` reads it back, offline machines included. A report,
 * never a verb: nothing here is a step toward the control plane *changing* what a
 * machine runs, which is its owner's act (Q7.42).
 *
 * The value is one compact string, `claude=2.1.259;codex=0.153.1;kimi=-`:
 * harness id `=` version, `;`-separated, in the order the daemon ships its
 * harnesses. A harness with **no CLI on the machine is absent**; one whose binary
 * runs but would not say which build it is carries `-`. The grammar is
 * `parseAgentClis`, shared with the relay rather than written twice, and it is a
 * grammar rather than a label on purpose — `readDaemonVersionHeader` can *cut* an
 * over-long version and store what is left, because a label cut short is still a
 * label; an entry list cut short mid-version is a **false** version, so the relay
 * refuses the whole value to `null` instead. Absence of the header and refusal of
 * it land on the same `null`, and nothing needs to tell them apart: both read as
 * "did not say".
 *
 * **As fresh as the last dial, and that is stated rather than fixed.** The
 * handshake repeats on every (re)dial and never in between, and the daily agent
 * update does not redial — a redial drops every live stream, so making the
 * inventory current would cost every browser on the machine its socket for a
 * report nobody is blocked on. The row therefore describes what the daemon would
 * have launched *when it last connected*; a relay restart, a network blip or a
 * daemon update refreshes it, and the daemon's own `GET /agents/capabilities`
 * is the live answer for one machine.
 */
export const AGENT_CLIS_HEADER = "x-reemoat-agent-clis";

/**
 * How long an `AGENT_CLIS_HEADER` value may be before the relay refuses it whole.
 *
 * Four built-in harnesses at the widest id and version the grammar admits is
 * under 400 characters; the bound is the same order as `MAX_DAEMON_VERSION_CHARS`
 * scaled to a list, not a budget anything legitimate approaches.
 */
export const MAX_AGENT_CLIS_CHARS = 512;

/** One harness id as the header carries it: what `AGENT_IDS` looks like, and no more. */
export const AGENT_CLI_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * One announced version. What `LocalRuntime.cliVersion` extracts is a dotted
 * number, and a prerelease tag is the widest thing a vendor prints after it;
 * `-` alone is "runs, but would not say". No space, no `=` and no `;`, so the
 * value cannot be mistaken for the next entry.
 */
export const AGENT_CLI_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;

/**
 * Harness id → the build its CLI reports, `null` where the binary runs but would
 * not say. A harness with no CLI has no entry at all.
 */
export type AgentClis = Record<string, string | null>;

/**
 * The header's value, from what the daemon resolved. The inverse of
 * `parseAgentClis`, and the daemon's only spelling of it.
 *
 * Does not validate: the daemon feeds it ids from `AGENT_IDS` and versions that
 * `announcedAgentClis` has already held to `AGENT_CLI_VERSION_RE`, so the one
 * spelling and the one grammar cannot disagree. An empty map formats to the empty
 * string, which the daemon turns into **no header** rather than an empty one.
 */
export function formatAgentClis(clis: AgentClis): string {
  return Object.entries(clis)
    .map(([id, version]) => `${id}=${version ?? "-"}`)
    .join(";");
}

/**
 * The header's value, read. `null` for anything that is not exactly the grammar
 * above — too long, an id or version outside its character set, a duplicate id,
 * a dangling separator, an empty value. Refusal of the whole thing rather than of
 * the offending entry, for the reason in `AGENT_CLIS_HEADER`'s docblock: a
 * partial list would be reported as if it were the inventory.
 *
 * Pure and shared: the relay reads with it on the dial, `GET /v1/admin/fleet`
 * reads the stored string back with it, and `relaycheck` drives it with no
 * socket.
 */
export function parseAgentClis(text: string): AgentClis | null {
  if (text.length === 0 || text.length > MAX_AGENT_CLIS_CHARS) return null;
  const clis: AgentClis = {};
  for (const entry of text.split(";")) {
    const at = entry.indexOf("=");
    if (at === -1) return null;
    const id = entry.slice(0, at);
    const version = entry.slice(at + 1);
    if (!AGENT_CLI_ID_RE.test(id) || !AGENT_CLI_VERSION_RE.test(version)) return null;
    if (Object.hasOwn(clis, id)) return null;
    clis[id] = version === "-" ? null : version;
  }
  return clis;
}

/**
 * Per-stream handshake headers, carried on the h2 CONNECT request.
 *
 * h2 request headers are already a negotiated key/value handshake per stream,
 * which is why the encryption seam below costs nothing to reserve: adding a
 * parameter later is another header, not a new frame type and not a version
 * bump.
 */
export const STREAM_VERSION_HEADER = "reemoat-v";

/**
 * The reserved encryption slot. Today the only legal value is `none`.
 *
 * The relay terminates TLS and sees plaintext. Later we may negotiate
 * application-level end-to-end encryption here — `x25519-aesgcm` or whatever it
 * turns out to be — with its parameters in further `reemoat-*` headers. None of
 * that is implemented and none of it should be until it is its own piece of work.
 *
 * The rule that makes the seam real: an unrecognised value is a *stream* error,
 * answered with a 501 on that one CONNECT, never a tunnel-level failure. An old
 * daemon meeting a new relay loses one request, not the whole fleet.
 */
export const STREAM_ENCRYPTION_HEADER = "reemoat-enc";

/** The only encryption mode that exists today. */
export const STREAM_ENCRYPTION_NONE = "none";

/**
 * Who the relay believes is calling.
 *
 * **Advisory. Never a decision.** The proxied request carries the caller's real
 * token and the daemon verifies it exactly as on the direct path, so this adds no
 * authority and must never be read as if it did.
 *
 * It rides the CONNECT headers, which means it stays on the tunnel: the daemon's
 * tunnel code sees it, the daemon's *HTTP server* never does. That is deliberate
 * and is the stronger arrangement — putting it into the request would mean
 * parsing and rewriting HTTP inside the tunnel, which is exactly what carrying
 * opaque bytes exists to avoid, and it would hand the relay a way to inject
 * headers into a request it is only supposed to carry. Its use is correlating a
 * relay log line with a daemon log line while debugging.
 */
export const STREAM_SUBJECT_HEADER = "reemoat-sub";

/**
 * Every header in this namespace is relay-controlled.
 *
 * The relay strips client-supplied copies from the forwarded request. Since the
 * relay's own metadata never enters that request either, the daemon's HTTP layer
 * sees nothing in this namespace from any source — which is what makes the
 * namespace safe to extend later without auditing what a client could put in it.
 */
export const RELAY_HEADER_PREFIX = "reemoat-";

/* ------------------------------------------------------------------ *
 * Close codes
 * ------------------------------------------------------------------ */

/*
 * There is deliberately no close code for a bad credential or an unsupported
 * version. Both are refused with an ordinary HTTP status *before* the handshake
 * completes — see the comment at the top of `tunnel-endpoint.ts`'s
 * `handleUpgrade` — so a 4401 or 4426 here could never fire. The 4xxx codes
 * below are for conditions that arise once a tunnel is established, where a
 * status line is no longer available.
 */

/**
 * A newer tunnel for the same machine replaced this one.
 *
 * Newest wins, always. A daemon that reconnects after a network partition finds
 * its previous tunnel still registered and apparently healthy — the relay has no
 * way to know it is a zombie. Refusing the new one would leave the machine
 * unreachable until a TCP timeout that may never come.
 */
export const CLOSE_TUNNEL_SUPERSEDED = 4409;

/** The tunnel socket backed up past `MAX_TUNNEL_BUFFERED_BYTES`. */
export const CLOSE_TUNNEL_BACKPRESSURE = 4013;

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/**
 * The h2 per-stream receive window.
 *
 * This is the flow control. It is credit-based and granted on *consumption*: a
 * client that stops reading stops the sender at this many bytes and no further,
 * which is what keeps one stalled browser from growing memory or stalling the
 * other streams sharing the tunnel.
 *
 * Larger than h2's 64 KiB default because a `since=0` attach replays a whole
 * session backlog and 64 KiB makes that a lot of round trips.
 *
 * ⚠ **Coupled to `EVENTS_PAGE_BYTES`, and larger than it on purpose.** Never lower
 * this one alone. A response bigger than one window needs a `WINDOW_UPDATE` that
 * Node does not reliably grant for a stream read through `http.request`'s socket
 * interface — which is exactly what `relay/proxy.ts` does — so a transcript page
 * that fits in one window cannot wedge and one that does not, can. Q6.104.
 *
 * 1 MiB, against a 768 KiB page cap: the page is bounded *before* gzip and gzip
 * cannot meaningfully expand it, so the compressed bytes on the wire always fit,
 * with 256 KiB spare for the response headers on the same stream. It was 256 KiB,
 * where a real 2000-event page (437 390 bytes compressed) did not fit and stalled
 * at exactly `262144 − 210`.
 *
 * The price is buffered memory for streams whose client has stopped reading:
 * `MAX_CONCURRENT_STREAMS` stalled streams now cost 256 MiB rather than 64 MiB,
 * and one caller's `MAX_STREAMS_PER_SUBJECT` share 64 MiB rather than 16 MiB. It
 * also brings `MAX_TUNNEL_BUFFERED_BYTES` within reach of about 8 fully stalled
 * streams instead of about 32 — still an abnormal state, and that valve stays
 * where it is, but the two are closer together than they were.
 */
export const STREAM_WINDOW_BYTES = 1024 * 1024;

/** Concurrent streams per tunnel. Each is one browser connection to one daemon. */
export const MAX_CONCURRENT_STREAMS = 256;

/**
 * Concurrent streams per **caller** on one tunnel.
 *
 * ⚠ **The tunnel budget is shared and a grant is full access**, so without this
 * the 256 above is a shared resource with no per-person share: anybody holding a
 * grant on a machine could hold every slot, and the *owner* would then be refused
 * `503 no_tunnel` on their own machine — which `meansMachineGone` turns into
 * "this machine is not reachable", i.e. indistinguishable from a daemon that has
 * stopped. A person watching their own laptop go dark while it is sitting there
 * running is the worst reading available of a resource limit.
 *
 * Nothing here is about malice. The web client holds up to three sockets per
 * session plus a request in flight, so a person with several sessions open on one
 * machine is legitimately in double digits; two people are double that. 64 is
 * generous for one browser and a quarter of the tunnel, so four callers can be at
 * their ceiling before the tunnel's own limit is what refuses.
 *
 * The subject is the verified `sub` claim, taken from the token the relay has
 * already checked — never a header and never anything a caller writes. It is the
 * same value that rides `STREAM_SUBJECT_HEADER` as advisory information for the
 * daemon's logs, and it confers nothing there; here it is used only to divide a
 * budget, which is a question about fairness rather than about authority.
 */
export const MAX_STREAMS_PER_SUBJECT = 64;

/**
 * The tunnel socket's own safety valve.
 *
 * Per-stream windows should make this unreachable — that is the point of them —
 * so if it ever fires, something upstream is wrong and closing the tunnel is
 * better than growing without bound. The daemon reconnects.
 *
 * Deliberately its own constant, separate from `CONNECTION_WINDOW_BYTES` below
 * even though the two currently hold the same number. They are different facts:
 * this one is "how much unsent data may pile up in the WebSocket before we give
 * up on the tunnel", that one is "how much unread data the h2 layer will accept
 * across all streams". One constant serving both meant that tuning the valve
 * silently retuned flow control on both ends, which is not a thing anybody would
 * intend to do at the same time.
 */
export const MAX_TUNNEL_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * The largest single WebSocket message the relay will assemble from a daemon.
 *
 * ⚠ **Every other bound in this file sits *above* the ws layer and none of them
 * reaches this.** `STREAM_WINDOW_BYTES`, `CONNECTION_WINDOW_BYTES` and
 * `MAX_CONCURRENT_STREAMS` are h2 flow control, and h2 only sees bytes once `ws`
 * has finished assembling a message and handed it over. `MAX_TUNNEL_BUFFERED_BYTES`
 * is the *outbound* valve — `bufferedAmount` is data not yet sent — so it says
 * nothing about what arrives either. Inbound, the only limit was `ws`'s own
 * default of 100 MiB per message.
 *
 * What that allowed: an enrolled daemon — authenticated, but the relay holds
 * every tunnel in the fleet in one process — sending a fragmented message and
 * simply never setting FIN. The fragments accumulate in `ws`'s internal buffer,
 * the h2 layer never sees a byte so no window is ever consumed, and control
 * frames interleave legally so the 20s ping/pong heartbeat keeps answering. It is
 * not a burst that resolves; it is memory parked for the life of the socket, at
 * up to 100 MiB per machine, in a container `compose.yml` sets no `mem_limit` on.
 *
 * Set equal to `MAX_TUNNEL_BUFFERED_BYTES` because that is the honest ceiling for
 * "one message this tunnel is allowed to hold in memory", and comfortably above
 * anything legitimate: h2 frames are bounded by `STREAM_WINDOW_BYTES` (1 MiB) and
 * a coalesced write cannot exceed the connection window (8 MiB). Exceeding it
 * closes the socket with 1009, and the daemon reconnects on its own backoff —
 * the same recovery every other tunnel failure already uses.
 */
export const MAX_TUNNEL_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * The h2 *connection*-level receive window, shared by every stream on a tunnel.
 *
 * h2 defaults this to 64 KiB, and left there it is the real bottleneck no matter
 * how large `STREAM_WINDOW_BYTES` is: a few stalled browsers would hold the whole
 * connection window and slow the healthy streams sharing the tunnel. Both ends
 * must call `setLocalWindowSize` with it — miss it on one side and throughput
 * collapses in that direction only, which is a miserable thing to diagnose.
 *
 * Sized so that `CONNECTION_WINDOW_BYTES / STREAM_WINDOW_BYTES` = 32 fully
 * stalled streams can hold their whole window before the connection window is
 * exhausted.
 */
export const CONNECTION_WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * How long a tunnel must stay up before it counts as a success.
 *
 * Reconnect backoff is reset by a connection that survived this long, not by one
 * that merely opened. Without it a tunnel that dies immediately on connect keeps
 * `attempt` at 0 for ever and retries from a sub-second window indefinitely —
 * which is what two daemons sharing one tunnel key do to each other, and what a
 * `4013` backpressure close does to one daemon on its own.
 */
export const TUNNEL_STABLE_AFTER_MS = 60_000;

/**
 * Tunnel keepalive.
 *
 * Corporate proxies drop idle WSS connections, commonly at 60s. 20s matches the
 * daemon's own `PING_INTERVAL_MS` and sits well under that.
 */
export const TUNNEL_PING_INTERVAL_MS = 20_000;

/** Missed pongs before the tunnel is considered dead and torn down. */
export const TUNNEL_PING_MAX_MISSES = 2;

/**
 * Reconnect backoff, with **full** jitter — `random() * window`, not ±20%.
 *
 * The client's ±20% is right for one client reconnecting to one daemon. This is
 * every daemon in a fleet reconnecting to one relay the moment it restarts, and
 * narrow jitter there just synchronises the herd.
 */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** How long the daemon will wait to reach its own listener before resetting the stream. */
export const LOOPBACK_DIAL_TIMEOUT_MS = 5_000;

/** Backoff with full jitter. Exported so both ends and `relaycheck` use the same curve. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const window = Math.min(RECONNECT_MIN_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS);
  return Math.round(random() * window);
}
