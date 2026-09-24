import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import { constants as h2 } from "node:http2";
import { DEFAULT_RELAY_ID, type PresenceWriter } from "./presence.js";
import {
  MAX_STREAMS_PER_SUBJECT,
  STREAM_ENCRYPTION_HEADER,
  STREAM_SUBJECT_HEADER,
  STREAM_VERSION_HEADER,
} from "../../../../src/relay/protocol.js";

// The in-memory authority on which machines hold a tunnel; presence rows only mirror it. No queue for an absent tunnel.

export interface TunnelStats {
  machineId: string;
  /** Which relay reports it: the only shipped way to spot a wrong REEMOAT_CP_RELAY_URLS entry. */
  relayId: string;
  since: number;
  activeStreams: number;
  requestsProxied: number;
}

export interface RelayView {
  isOnline(machineId: string): boolean;
  stats(): TunnelStats[];
  /** The relay_id holding this machine's tunnel: a name, never a URL. null covers both "no tunnel" and "cannot tell". */
  relayFor(machineId: string): string | null;
}

export class RelayTunnel {
  private closed = false;
  private opened = 0;
  private active = 0;
  // Live streams per caller, so one grantee cannot hold the whole tunnel. Entries are deleted at zero.
  private readonly perSubject = new Map<string, number>();

  constructor(
    readonly machineId: string,
    readonly since: number,
    /** What this tunnel negotiated, not RELAY_PROTOCOL_VERSION: the daemon refuses a stream stamped otherwise. */
    readonly protocolVersion: number,
    private readonly session: ClientHttp2Session,
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

  /** A CONNECT stream the daemon splices to its own listener. encryption has no default: the relay must never choose the mode. */
  open(subject: string, encryption: string): ClientHttp2Stream | null {
    if (this.isClosed) return null;
    // Checked before the stream exists, so a grantee cannot exhaust MAX_CONCURRENT_STREAMS and lock out the owner.
    if ((this.perSubject.get(subject) ?? 0) >= MAX_STREAMS_PER_SUBJECT) return null;
    let stream: ClientHttp2Stream;
    try {
      stream = this.session.request({
        [h2.HTTP2_HEADER_METHOD]: "CONNECT",
        [h2.HTTP2_HEADER_AUTHORITY]: "daemon",
        [STREAM_VERSION_HEADER]: String(this.protocolVersion),
        [STREAM_ENCRYPTION_HEADER]: encryption,
        [STREAM_SUBJECT_HEADER]: subject,
      });
    } catch {
      return null;
    }
    this.opened += 1;
    this.active += 1;
    this.perSubject.set(subject, (this.perSubject.get(subject) ?? 0) + 1);
    const done = (): void => {
      if (this.active > 0) this.active -= 1;
      const held = this.perSubject.get(subject) ?? 0;
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
    private readonly presence: PresenceWriter | null = null,
    // Must match what this relay writes into relay_tunnels.relay_id; relay/main.ts passes the same value to both.
    private readonly relayId: string = DEFAULT_RELAY_ID,
  ) {}

  /** Newest always wins: after a partition the relay may still hold a dead socket it cannot detect. */
  register(tunnel: RelayTunnel, supersededCode: number): void {
    const existing = this.tunnels.get(tunnel.machineId);
    this.tunnels.set(tunnel.machineId, tunnel);
    if (existing) {
      this.onEvent("tunnel_superseded", tunnel.machineId);
      existing.close(supersededCode, "superseded by a newer tunnel");
    }
    this.onEvent("tunnel_up", tunnel.machineId);
    this.presence?.up(tunnel.machineId, tunnel.since);
  }

  /** Only if it is still the registered one: a superseded tunnel's close fires after its replacement registered. */
  unregister(tunnel: RelayTunnel): void {
    if (this.tunnels.get(tunnel.machineId) !== tunnel) return;
    this.tunnels.delete(tunnel.machineId);
    this.onEvent("tunnel_down", tunnel.machineId);
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
      // Explicit: the clear below makes every later unregister a no-op, so the row would outlive a clean shutdown.
      this.presence?.down(tunnel.machineId);
    }
    this.tunnels.clear();
  }
}
