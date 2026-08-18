import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import { constants as h2 } from "node:http2";
import { DEFAULT_RELAY_ID, type PresenceWriter } from "./presence.js";
import {
  MAX_STREAMS_PER_SUBJECT,
  STREAM_ENCRYPTION_HEADER,
  STREAM_ENCRYPTION_NONE,
  STREAM_SUBJECT_HEADER,
  STREAM_VERSION_HEADER,
} from "../../../../src/relay/protocol.js";

/**
 * Which machines currently hold a tunnel, and how to open a stream down one.
 *
 * In-memory and single-instance, which is the whole of the scaling story today.
 * The seam that keeps it from being a dead end is that every caller goes through
 * `RelayView` — a lookup and a counter, nothing more — so a shared-state
 * implementation can replace this class without any caller changing. Nothing
 * here assumes the map is local; it assumes only that `get` answers. That seam
 * has since been used: `dbRelayView` in `presence.ts` is the same interface over
 * a table, and it is how the API process answers `relayOnline` now that it no
 * longer shares a process with this map.
 *
 * The `PresenceWriter` is the other half of that. This class stays the authority
 * — the map is what `get` reads and what a request is routed by — and mirrors
 * its transitions into a row so another process can see them. A mirror that
 * fails is still just a mirror: nothing here awaits it, checks it, or refuses on
 * it.
 *
 * What is *not* here, deliberately: any notion of routing a request to a machine
 * whose tunnel is absent. There is no queue and no wait. A relay that holds
 * requests until a daemon reappears is a relay whose memory grows during exactly
 * the incident it should be surviving.
 */

export interface TunnelStats {
  machineId: string;
  /**
   * Which relay is reporting it.
   *
   * The only shipped way to see whether `REEMOAT_CP_RELAY_URLS` is right. A
   * wrong entry degrades to the shared name and keeps working — one request in
   * N slowly — so the failure has no error and no log; without this column the
   * detection story is `sqlite3` inside the volume. `cpctl admin relay` prints
   * it, and in external mode `stats()` merges every relay's rows, which is
   * exactly when telling them apart matters.
   */
  relayId: string;
  /** When this tunnel connected. A tunnel that flaps has a young `since`. */
  since: number;
  activeStreams: number;
  /**
   * Requests proxied down this tunnel since it connected.
   *
   * Load-bearing for more than curiosity: it is how "a client that can reach the
   * daemon directly does so, and traffic does not touch the relay" becomes a
   * measurement rather than an assertion.
   */
  requestsProxied: number;
}

/** All the relay's HTTP surface needs. Deliberately tiny so it can be reimplemented. */
export interface RelayView {
  isOnline(machineId: string): boolean;
  stats(): TunnelStats[];
  /**
   * Which relay holds this machine's tunnel, by `relay_id`, or `null`.
   *
   * The one question a fleet with more than one relay cannot answer without
   * asking, and the reason it is on this interface rather than derived: a
   * `TunnelRegistry` is one process and answers "me or nobody", while
   * `dbRelayView` reads a column that already exists and can answer about a
   * relay this process has never spoken to.
   *
   * **A name, never a URL.** `relay_tunnels.relay_id` is a slot the operator
   * chose (`REEMOAT_CP_RELAY_ID`), and turning it into somewhere a browser can
   * dial is `app.ts`'s job through configuration — the relay must not have to
   * know its own public address, which it does not and cannot: it binds a port
   * behind whatever terminates TLS.
   *
   * `null` covers both "no tunnel" and "cannot tell", for `isOnline`'s stated
   * reason: nothing is *granted* by this answer, and a caller that gets it wrong
   * pays one `503 no_tunnel` and re-resolves.
   */
  relayFor(machineId: string): string | null;
}

export class RelayTunnel {
  private closed = false;
  private opened = 0;
  private active = 0;
  /**
   * Live streams per caller, so one grantee cannot hold the whole tunnel.
   *
   * A `Map` rather than a counter, and bounded by construction: an entry exists
   * only while that subject holds a stream, and `done` deletes it at zero. The
   * number of distinct subjects that can be in here at once is therefore bounded
   * by `MAX_CONCURRENT_STREAMS`, not by how many people have ever connected.
   */
  private readonly perSubject = new Map<string, number>();

  constructor(
    readonly machineId: string,
    readonly since: number,
    /**
     * The version **this tunnel negotiated**, which is what every stream down it
     * is stamped with.
     *
     * ⚠ **Not `RELAY_PROTOCOL_VERSION`, and that distinction is the whole point.**
     * `open()` used to send this build's maximum, which is a different number from
     * what the handshake agreed the moment `MIN < VERSION` — and the daemon
     * refuses any stream disagreeing with what it was told on the 101. So a relay
     * moved to v2 would have negotiated v1 with an older daemon and then stamped
     * every stream `2`: a tunnel that connects, reports online, and 501s every
     * request. That is worse than the 426 flag day this whole range replaced,
     * because a refused tunnel at least draws the machine as offline and says why.
     *
     * Per tunnel rather than per process for the same reason the daemon resets its
     * own copy per dial: a rolling deploy can hold relays of two versions at once,
     * so "what this build speaks" never answers "what this socket agreed".
     */
    readonly protocolVersion: number,
    private readonly session: ClientHttp2Session,
    /** Closes the underlying WebSocket. h2 `GOAWAY` alone leaves the socket up. */
    private readonly shutdown: (code: number, reason: string) => void,
  ) {}

  get requestsProxied(): number {
    return this.opened;
  }

  get activeStreams(): number {
    return this.active;
  }

  get isClosed(): boolean {
    return this.closed || this.session.closed || this.session.destroyed;
  }

  /**
   * Open a virtual connection to the daemon.
   *
   * A CONNECT stream, which the daemon splices to a fresh loopback connection to
   * its own listener. The tunnel therefore carries bytes, not parsed HTTP, which
   * is why a WebSocket upgrade needs no special handling anywhere in the relay:
   * it is bytes like everything else.
   *
   * `subject` rides along as an advisory header for the daemon's logs. It confers
   * nothing — the proxied request still carries the caller's real token and the
   * daemon verifies it exactly as on the direct path.
   */
  open(subject: string): ClientHttp2Stream | null {
    if (this.isClosed) return null;
    /*
     * **One caller's share of the tunnel, checked before the stream exists.**
     *
     * `MAX_CONCURRENT_STREAMS` is per tunnel and a grant is full access to the
     * machine, so it was a shared budget with no shares in it: a grantee opening
     * attaches could hold all 256 and the machine's *owner* would then be refused
     * with `503 no_tunnel` on their own machine — which the client reads as "not
     * reachable", i.e. exactly what a dead daemon looks like.
     *
     * Refusing here rather than counting after the fact is what keeps the h2
     * session's own `maxConcurrentStreams` from being the thing that answers:
     * that one refuses at the protocol level, where there is nothing left to say
     * about *why*.
     */
    if ((this.perSubject.get(subject) ?? 0) >= MAX_STREAMS_PER_SUBJECT) return null;
    let stream: ClientHttp2Stream;
    try {
      stream = this.session.request({
        [h2.HTTP2_HEADER_METHOD]: "CONNECT",
        // Required on a CONNECT request; the daemon ignores it and dials its own
        // listener, because the target is the daemon and there is nothing to choose.
        [h2.HTTP2_HEADER_AUTHORITY]: "daemon",
        // What this tunnel agreed, never this build's maximum. See the field.
        [STREAM_VERSION_HEADER]: String(this.protocolVersion),
        [STREAM_ENCRYPTION_HEADER]: STREAM_ENCRYPTION_NONE,
        [STREAM_SUBJECT_HEADER]: subject,
      });
    } catch {
      // The session died between the check above and here.
      return null;
    }
    this.opened += 1;
    this.active += 1;
    this.perSubject.set(subject, (this.perSubject.get(subject) ?? 0) + 1);
    const done = (): void => {
      if (this.active > 0) this.active -= 1;
      const held = this.perSubject.get(subject) ?? 0;
      // Deleted at zero rather than left holding a 0, which is what bounds the
      // map by live streams instead of by everybody who has ever connected.
      if (held <= 1) this.perSubject.delete(subject);
      else this.perSubject.set(subject, held - 1);
    };
    stream.once("close", done);
    return stream;
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session.close();
    } catch {
      // Already gone; the socket close below is what matters.
    }
    this.shutdown(code, reason);
  }
}

export class TunnelRegistry implements RelayView {
  private readonly tunnels = new Map<string, RelayTunnel>();

  constructor(
    private readonly onEvent: (event: string, detail: string) => void = () => {},
    /**
     * Where presence is mirrored, or nothing.
     *
     * Optional because a registry with no writer is exactly the embedded control
     * plane and every offline driver: correct, and writing rows nobody reads.
     */
    private readonly presence: PresenceWriter | null = null,
    /**
     * This process's own slot name, for `relayFor`.
     *
     * Defaulted rather than required, because the overwhelming majority of
     * callers are the single-relay shape where the answer is never compared
     * against anything: `pnpm cp`, every offline driver, and any deployment that
     * has not split. It matters only once `app.ts` is resolving a *browser*
     * URL per machine, and then it has to agree with what this relay writes into
     * `relay_tunnels.relay_id` — which is why `relay/main.ts` passes the same
     * value to both and nothing here invents one.
     */
    private readonly relayId: string = DEFAULT_RELAY_ID,
  ) {}

  /**
   * Register a tunnel, displacing any previous one for the same machine.
   *
   * Newest always wins. The alternative — refuse the second — sounds safer and is
   * not: after a network partition the daemon reconnects while the relay still
   * holds a socket it has no way to know is dead, and refusing would leave that
   * machine unreachable until a TCP timeout that may never arrive.
   */
  register(tunnel: RelayTunnel, supersededCode: number): void {
    const existing = this.tunnels.get(tunnel.machineId);
    this.tunnels.set(tunnel.machineId, tunnel);
    if (existing) {
      this.onEvent("tunnel_superseded", tunnel.machineId);
      existing.close(supersededCode, "superseded by a newer tunnel");
    }
    this.onEvent("tunnel_up", tunnel.machineId);
    /*
     * One row per machine, overwritten — the same "newest wins" the map above
     * just performed, rather than a second row for a second socket. The
     * superseded tunnel's own `unregister` arrives later and is refused by the
     * identity check, which is what keeps it from deleting this row.
     */
    this.presence?.up(tunnel.machineId, tunnel.since);
  }

  /**
   * Remove a tunnel, but only if it is still the registered one.
   *
   * The identity check is the point. A superseded tunnel's close event fires
   * *after* its replacement registered, so an unconditional delete here would
   * unregister the healthy new tunnel and leave the machine offline with a live
   * socket nobody can find.
   */
  unregister(tunnel: RelayTunnel): void {
    if (this.tunnels.get(tunnel.machineId) !== tunnel) return;
    this.tunnels.delete(tunnel.machineId);
    this.onEvent("tunnel_down", tunnel.machineId);
    // Below the guard, deliberately: it is the same sentence the guard exists
    // for, one layer down. A superseded tunnel's late close must not delete the
    // row its replacement has just written.
    this.presence?.down(tunnel.machineId);
  }

  get(machineId: string): RelayTunnel | null {
    const tunnel = this.tunnels.get(machineId);
    if (!tunnel) return null;
    if (tunnel.isClosed) {
      this.unregister(tunnel);
      return null;
    }
    return tunnel;
  }

  isOnline(machineId: string): boolean {
    return this.get(machineId) !== null;
  }

  /**
   * This relay, when it holds the tunnel — and never a guess about another.
   *
   * A registry is one process, so the honest answers are "me" and "I do not
   * have it". It deliberately does **not** fall back to reading the table: an
   * embedded control plane holds its own tunnels and knows about no others, and
   * a relay that answered on another relay's behalf would be routing a browser
   * on the strength of a row it does not maintain.
   */
  relayFor(machineId: string): string | null {
    return this.get(machineId) === null ? null : this.relayId;
  }

  stats(): TunnelStats[] {
    return [...this.tunnels.values()].map((tunnel) => ({
      machineId: tunnel.machineId,
      relayId: this.relayId,
      since: tunnel.since,
      activeStreams: tunnel.activeStreams,
      requestsProxied: tunnel.requestsProxied,
    }));
  }

  closeAll(code: number, reason: string): void {
    for (const tunnel of [...this.tunnels.values()]) {
      tunnel.close(code, reason);
      // Explicitly, because `clear()` below is what makes every later
      // `unregister` a no-op — so the row would otherwise survive a clean
      // shutdown and go on claiming the machine for a whole staleness window.
      this.presence?.down(tunnel.machineId);
    }
    this.tunnels.clear();
  }
}
