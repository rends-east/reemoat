import { mintToken, registerDevice } from "./cp";
import {
  ChannelRefused,
  bodyBytes,
  bodyText,
  openChannel,
  type Channel,
  type ChannelFactory,
  type ChannelRequest,
  type ChannelResponse,
  type StreamSocket,
} from "./e2ee";
import {
  ApiError,
  contentTypeFor,
  isTransportFailure,
  meansDeviceKeyMissing,
  meansMachineGone,
  meansWrongMachine,
  parseBody,
  withTimeout,
} from "./http";
import { localBaseFor } from "./localRoute";
import type { MachineId } from "./ids";
import type { DaemonHealth, MachineRecord, Scope } from "./wire";

/** Renew this far ahead of expiry. Larger than the daemon's 60s clock leeway. */
export const TOKEN_RENEW_MARGIN_MS = 90_000;

/** Smaller than TOKEN_RENEW_MARGIN_MS, so the token is already fresh when the socket rotates. */
export const SOCKET_ROTATE_MARGIN_MS = 60_000;

const PROBE_TIMEOUT_MS = 1_500;

const REQUEST_TIMEOUT_MS = 15_000;

/** Added to a slow route's daemon chain, so the daemon's own answer or error arrives before this client gives up. */
export const SLOW_ROUTE_MARGIN_MS = 30_000;

/** No slow route gets less, however short its chain. */
export const SLOW_ROUTE_FLOOR_MS = 90_000;

const TRANSFER_TIMEOUT_MS = 120_000;

/** Checked on content-length, which is CORS-safelisted; content-disposition is not, so the name comes from the path. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

const UPLOAD_STALL_MS = 30_000;

const UPLOAD_FLOOR_BYTES_PER_MS = 50;

const UPLOAD_HARD_CAP_MS = 45 * 60 * 1000;

export function uploadDeadlines(bytes: number): { stallMs: number; hardMs: number } {
  const scaled = 20_000 + Math.ceil(Math.max(bytes, 0) / UPLOAD_FLOOR_BYTES_PER_MS);
  return {
    stallMs: UPLOAD_STALL_MS,
    hardMs: Math.min(UPLOAD_HARD_CAP_MS, Math.max(scaled, REQUEST_TIMEOUT_MS)),
  };
}

// A relay route goes down the tunnel the daemon dialled; a local one is loopback to this computer's daemon (Q7.137).
export interface Route {
  base: string;
  kind: "relay" | "local";
}

export type Reach = "unknown" | "probing" | "online" | "offline";

export type OfflineReason =
  | "no_route"
  | "no_token"
  | "not_enrolled"
  | "cp_unreachable"
  | "over_limit"
  | "owner_disabled"
  // The daemon never announced its static key: refuse rather than fall back to plaintext.
  | "no_machine_key"
  // The Authority still refuses this installation's device key after mint's one re-registration attempt.
  | "no_device_key"
  | null;

export type MissingRow = "loading" | "no_machine" | "not_here" | "unreachable";

/** An online machine that has never listed sessions is still `loading`, not `not_here`. */
export function missingRowReason(reach: Reach | null, listed: boolean): MissingRow {
  if (reach === null) return "no_machine";
  if (reach === "unknown" || reach === "probing") return "loading";
  if (reach === "offline") return "unreachable";
  return listed ? "not_here" : "loading";
}

export function daemonReadable(reach: Reach): boolean {
  return daemonRead(reach) === "readable";
}

export type DaemonRead = "readable" | "asking" | "unreachable";

/** `unknown` and `probing` both mean no answer yet, so they read as `asking`, never `unreachable`; webcheck's REACH_SCREENS lists the screens drawing it. */
export function daemonRead(reach: Reach): DaemonRead {
  if (reach === "online") return "readable";
  if (reach === "offline") return "unreachable";
  return "asking";
}

export interface MachineState {
  id: MachineId;
  name: string;
  relayUrl: string | null;
  relayOnline: boolean;
  enrolled: boolean;
  // undefined is a control plane predating the field, null one that never saw a tunnel: do not collapse them.
  lastSeenAt: number | null | undefined;
  owned: boolean;
  overLimit: boolean;
  ownerDisabled: boolean;
  enrolledBy: string | null;
  scopes: Scope[];
  route: Route | null;
  reach: Reach;
  offlineReason: OfflineReason;
  /** The control plane is unreachable and we are running on a token it already gave us. */
  tokenDegraded: boolean;
  tokenExpiresAt: number | null;
  health: DaemonHealth | null;
  lastError: string | null;
}

// Whitelist: an unknown method is unsafe, and the daemon's DELETEs are idempotent.
function isReplayable(method: string | undefined): boolean {
  const verb = (method ?? "GET").toUpperCase();
  return verb === "GET" || verb === "DELETE";
}

// An answered refusal becomes an ApiError so it is never replayed as a dead link (Q6.103).
function asAnsweredRefusal(error: unknown, machine: string): unknown {
  if (!ChannelRefused.is(error)) return error;
  return new ApiError(error.status, error.reason, `${machine} refused this connection: ${error.reason}`);
}

export class MachineConnection {
  readonly id: MachineId;
  private name: string;
  private relayUrl: string | null;
  private relayOnline: boolean;
  private enrolled: boolean;
  private lastSeenAt: number | null | undefined;
  private owned: boolean;
  private overLimit: boolean;
  private ownerDisabled: boolean;
  private enrolledBy: string | null;
  private scopes: Scope[];

  private token: { value: string; expiresAt: number } | null = null;
  private minting: Promise<string> | null = null;
  private machineKey: string | null = null;
  private channel: Channel | null = null;
  private channelKey: string | null = null;
  private channelBase: string | null = null;
  private chosen: Route | null = null;
  private resolving: Promise<Route | null> | null = null;
  // Set on a loopback wrong_machine and cleared in update on every wake.
  private localDenied = false;

  private reach: Reach = "unknown";
  private offlineReason: OfflineReason = null;
  private tokenDegraded = false;
  private health: DaemonHealth | null = null;
  private lastError: string | null = null;

  private readonly onChange: () => void;

  constructor(
    record: MachineRecord,
    onChange: () => void,
    private readonly channels: ChannelFactory = openChannel,
  ) {
    this.id = record.id as MachineId;
    this.name = record.name;
    this.relayUrl = record.relayUrl;
    this.relayOnline = record.relayOnline;
    this.enrolled = record.enrolled;
    this.lastSeenAt = record.lastSeenAt;
    this.owned = record.owned === true;
    this.overLimit = record.overLimit === true;
    this.ownerDisabled = record.ownerDisabled === true;
    this.enrolledBy = record.enrolledBy ?? null;
    this.scopes = record.scopes;
    this.onChange = onChange;
  }

  update(record: MachineRecord): void {
    this.localDenied = false;
    this.name = record.name;
    this.relayUrl = record.relayUrl;
    this.relayOnline = record.relayOnline;
    this.enrolled = record.enrolled;
    this.lastSeenAt = record.lastSeenAt;
    this.owned = record.owned === true;
    this.enrolledBy = record.enrolledBy ?? null;
    // Going over drops token and route (the relay refuses); coming back resets reach so the next resume re-probes.
    const was = this.switchedOff();
    this.overLimit = record.overLimit === true;
    this.ownerDisabled = record.ownerDisabled === true;
    const now = this.switchedOff();
    if (now && !was) {
      this.token = null;
      this.chosen = null;
    }
    if (!now && was) {
      this.reach = "unknown";
      this.offlineReason = null;
      this.lastError = null;
    }
    this.scopes = record.scopes;
    this.onChange();
  }

  state(): MachineState {
    return {
      id: this.id,
      name: this.name,
      relayUrl: this.relayUrl,
      relayOnline: this.relayOnline,
      enrolled: this.enrolled,
      lastSeenAt: this.lastSeenAt,
      owned: this.owned,
      overLimit: this.overLimit,
      ownerDisabled: this.ownerDisabled,
      enrolledBy: this.enrolledBy,
      scopes: this.scopes,
      route: this.chosen,
      reach: this.reach,
      offlineReason: this.offlineReason,
      tokenDegraded: this.tokenDegraded,
      tokenExpiresAt: this.token?.expiresAt ?? null,
      health: this.health,
      lastError: this.lastError,
    };
  }

  /** Concurrent callers share one in-flight mint. */
  async ensureToken(force = false): Promise<string> {
    if (this.switchedOff()) {
      this.token = null;
      this.reach = "offline";
      this.offlineReason = this.ownerDisabled ? "owner_disabled" : "over_limit";
      this.onChange();
      throw this.ownerDisabled
        ? new ApiError(403, "owner_disabled", `${this.name} belongs to a disabled user`)
        : new ApiError(403, "machine_over_limit", `${this.name} is over the machine limit`);
    }
    const held = this.token;
    if (!force && held !== null && Date.now() < held.expiresAt - TOKEN_RENEW_MARGIN_MS) {
      return held.value;
    }
    this.minting ??= this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  tokenExpiresAt(): number | null {
    return this.token?.expiresAt ?? null;
  }

  private switchedOff(): boolean {
    return this.overLimit || this.ownerDisabled;
  }

  private async mint(firstAttempt = true): Promise<string> {
    let issued;
    try {
      issued = await mintToken(this.id);
    } catch (error) {
      if (firstAttempt && meansDeviceKeyMissing(error)) {
        const registered = await registerDevice().catch(() => null);
        if (registered !== null) return await this.mint(false);
      }
      // A control-plane outage is not a revocation: keep working on a held token that is still valid.
      const held = this.token;
      if (isTransportFailure(error) && held !== null && Date.now() < held.expiresAt) {
        this.tokenDegraded = true;
        this.onChange();
        return held.value;
      }
      this.token = null;
      this.reach = "offline";
      this.offlineReason = isTransportFailure(error)
        ? "cp_unreachable"
        : meansDeviceKeyMissing(error)
          ? "no_device_key"
          : "no_token";
      this.lastError = describe(error);
      this.onChange();
      throw error;
    }

    // serverTime turns the absolute expiry into a duration, so device clock drift cannot skew renewal.
    const lifetimeMs =
      typeof issued.serverTime === "number" ? issued.expiresAt - issued.serverTime : issued.expiresAt - Date.now();
    this.token = { value: issued.token, expiresAt: Date.now() + lifetimeMs };
    this.tokenDegraded = false;
    this.lastError = null;

    this.relayUrl = issued.machine.relayUrl;
    this.relayOnline = issued.machine.relayOnline;
    this.machineKey = issued.machine.key ?? null;

    this.onChange();
    return issued.token;
  }

  forgetRoute(): void {
    if (this.chosen === null) return;
    this.chosen = null;
    this.closeChannel();
    this.onChange();
  }

  // Forcing a mint re-reads the machine's current relay; only on an answered no_tunnel, never on a transport failure.
  private refetchRoute(): void {
    void this.ensureToken(true).catch(() => {
      // Recorded by mint or ensureToken already; the next probe's problem.
    });
  }

  currentRoute(): Route | null {
    return this.chosen;
  }

  async resolveRoute(): Promise<Route | null> {
    if (this.chosen !== null) return this.chosen;
    this.resolving ??= this.probeRoute().finally(() => {
      this.resolving = null;
    });
    return this.resolving;
  }

  // Try the local candidate before the relayOnline check: a laptop whose tunnel is down is exactly its case.
  private async probeRoute(): Promise<Route | null> {
    if (!this.enrolled) {
      this.reach = "offline";
      this.offlineReason = "not_enrolled";
      this.onChange();
      return null;
    }

    // Only a first probe publishes `probing`: a re-probe keeps the answer held, online or offline, or every screen keyed on reach flickers (Q7.101).
    if (this.reach === "unknown") {
      this.reach = "probing";
      this.onChange();
    }

    let token: string;
    try {
      token = await this.ensureToken();
    } catch {
      // `mint` has already recorded why and notified.
      return null;
    }

    const local = this.localDenied ? null : await localBaseFor(this.id);
    if (local !== null) {
      const health = await this.proveLocal(local, token);
      if (health !== null) {
        this.health = health;
        return this.settleRoute({ base: local, kind: "local" }, null);
      }
    }

    const relay = this.relayOnline ? this.relayUrl : null;
    if (relay === null) return this.settleRoute(null, "no_route");

    // No announced key means no route: there is no plaintext fallback.
    if (this.machineKey === null) return this.settleRoute(null, "no_machine_key");

    const health = await this.probe({ base: relay, kind: "relay" }, token);
    if (health === null) return this.settleRoute(null, "no_route");
    this.health = health;
    return this.settleRoute({ base: relay, kind: "relay" }, null);
  }

  private settleRoute(route: Route | null, reason: OfflineReason): Route | null {
    this.chosen = route;
    this.reach = route === null ? "offline" : "online";
    this.offlineReason = route === null ? reason : null;
    if (route !== null) this.lastError = null;
    this.onChange();
    return route;
  }

  // Any non-401 proves the audience matched (Q7.135); only wrong_machine denies loopback.
  private async proveLocal(base: string, token: string): Promise<DaemonHealth | null> {
    let response: Response;
    try {
      response = await fetch(new URL("/fs/roots", base), {
        signal: withTimeout(PROBE_TIMEOUT_MS),
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      // Usually a stopped daemon's leftover announcement: fall back to the relay.
      return null;
    }
    if (response.status === 401) {
      const body = await response.text();
      let refusal: unknown;
      try {
        parseBody(response.status, response.statusText, body);
      } catch (error) {
        refusal = error;
      }
      if (meansWrongMachine(refusal)) this.denyLocal();
      return null;
    }
    return await this.probe({ base, kind: "local" }, null);
  }

  // Not forgetRoute, which would retry loopback for ever, and not refetchRoute: no control-plane trip for a daemon's answer.
  private denyLocal(): void {
    this.localDenied = true;
    if (this.chosen?.kind === "local") {
      this.chosen = null;
      this.onChange();
    }
  }

  private async probe(route: Route, token: string | null): Promise<DaemonHealth | null> {
    try {
      if (route.kind === "relay") {
        const answer = await this.overChannel(route, {
          method: "GET",
          path: "/health",
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (answer.status < 200 || answer.status > 299) return null;
        return JSON.parse(bodyText(answer.body)) as DaemonHealth;
      }
      const response = await fetch(new URL("/health", route.base), {
        signal: withTimeout(PROBE_TIMEOUT_MS),
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      return (await response.json()) as DaemonHealth;
    } catch {
      // Every failure, an answered refusal included, means unreachable here.
      return null;
    }
  }

  /** Rebuilt rather than mutated when the machine key or the relay moves. */
  private channelFor(route: Route): Channel {
    const key = this.machineKey;
    if (key === null) {
      throw new ApiError(
        503,
        "machine_key_missing",
        `${this.name} has not told the control plane an encryption key — update the daemon on that machine`,
        null,
      );
    }
    if (this.channel !== null && (this.channelKey !== key || this.channelBase !== route.base)) {
      this.channel.dispose();
      this.channel = null;
    }
    if (this.channel === null) {
      this.channelKey = key;
      this.channelBase = route.base;
      this.channel = this.channels({
        relayUrl: route.base,
        machineKey: key,
        credential: async () => ({ token: await this.ensureToken(), expiresAt: this.token?.expiresAt ?? 0 }),
        // Register before minting, or the new capability repeats the stale device binding.
        onWrongDevice: async () => {
          await registerDevice();
          await this.ensureToken(true);
        },
      });
    }
    return this.channel;
  }

  /** The single door for channel requests, so every refusal passes through asAnsweredRefusal. */
  private async overChannel(route: Route, wanted: ChannelRequest): Promise<ChannelResponse> {
    try {
      return await this.channelFor(route).request(wanted);
    } catch (error) {
      throw asAnsweredRefusal(error, this.name);
    }
  }

  private closeChannel(): void {
    this.channel?.dispose();
    this.channel = null;
    this.channelKey = null;
    this.channelBase = null;
  }

  // Loopback stays plain fetch: same uid on 127.0.0.1, nothing to encrypt against.
  private async send(
    route: Route,
    token: string,
    path: string,
    init: RequestInit,
    timeoutMs: number,
    extra: { onProgress?: ((fraction: number) => void) | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<{ status: number; statusText: string; bytes: Uint8Array }> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const contentType = contentTypeFor(init.body);
    if (contentType !== null) headers["content-type"] = contentType;

    if (route.kind === "relay") {
      const answer = await this.overChannel(route, {
        method: (init.method ?? "GET").toUpperCase(),
        path,
        headers,
        body: await bodyBytes(init.body),
        onProgress: extra.onProgress,
        signal: extra.signal,
        timeoutMs,
      });
      return { status: answer.status, statusText: answer.statusText, bytes: answer.body };
    }

    const response = await fetch(new URL(path, route.base), {
      ...init,
      headers,
      signal: withTimeout(timeoutMs, extra.signal ?? init.signal ?? undefined),
    });
    return {
      status: response.status,
      statusText: response.statusText,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }

  // A route retry and a token retry share one firstAttempt budget.
  async request<T>(path: string, init: RequestInit = {}, firstAttempt = true): Promise<T> {
    const { route, token } = await this.prepare();
    const timeout = slowRouteTimeout(init.method, path) ?? REQUEST_TIMEOUT_MS;
    const retry = (): Promise<T> => this.request<T>(path, init, false);

    let answer: { status: number; statusText: string; bytes: Uint8Array };
    try {
      answer = await this.send(route, token, path, init, timeout, { signal: init.signal ?? undefined });
    } catch (error) {
      return this.settleTransport(error, isReplayable(init.method), firstAttempt, retry);
    }

    return this.settleAnswer<T>(answer.status, answer.statusText, bodyText(answer.bytes), firstAttempt, retry);
  }

  private async prepare(): Promise<{ route: Route; token: string }> {
    const route = await this.resolveRoute();
    if (route === null) {
      throw new ApiError(503, "unreachable", `${this.name} is not reachable`, {
        reason: this.offlineReason,
      });
    }
    return { route, token: await this.ensureToken() };
  }

  // An ApiError here is an answered refusal, not a dead link, so it is dispatched first (Q6.103).
  private async settleTransport<T>(
    error: unknown,
    replayable: boolean,
    firstAttempt: boolean,
    retry: () => Promise<T>,
  ): Promise<T> {
    if (ApiError.isApiError(error)) return this.settleRefusal(error, firstAttempt, retry);
    // Replay only replayable methods: a transport failure says nothing about whether the daemon acted.
    if (firstAttempt && replayable) {
      this.forgetRoute();
      const next = await this.resolveRoute();
      if (next !== null) return retry();
    } else if (firstAttempt) {
      this.forgetRoute();
    }
    this.markUnreachable("no_route", describe(error));
    throw error;
  }

  private async settleAnswer<T>(
    status: number,
    statusText: string,
    text: string,
    firstAttempt: boolean,
    retry: () => Promise<T>,
  ): Promise<T> {
    try {
      const body = parseBody<T>(status, statusText, text);
      if (this.reach !== "online") {
        this.reach = "online";
        this.offlineReason = null;
        this.onChange();
      }
      return body;
    } catch (error) {
      return this.settleRefusal(error, firstAttempt, retry);
    }
  }

  private async settleRefusal<T>(error: unknown, firstAttempt: boolean, retry: () => Promise<T>): Promise<T> {
    if (firstAttempt && ApiError.isApiError(error) && error.code === "token_expired") {
      // Drop the channel with the token: the daemon pins the HELLO capability, so a pooled channel keeps the expired one.
      this.closeChannel();
      await this.ensureToken(true);
      return retry();
    }
    // Loopback only; wrong_machine comes from the auth middleware, so no handler ran and any method may retry.
    if (this.chosen?.kind === "local" && meansWrongMachine(error)) {
      this.denyLocal();
      if (firstAttempt) return retry();
      throw error;
    }
    // Keyed on the code, never the status: the daemon's own 503 unresponsive is not a missing machine.
    if (meansMachineGone(error)) {
      this.forgetRoute();
      this.markUnreachable("no_route", (error as ApiError).message);
      this.refetchRoute();
    }
    throw error;
  }

  // XMLHttpRequest because fetch reports no upload progress; a caller's abort is never a network event.
  async upload<T>(
    path: string,
    file: Blob,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
    firstAttempt = true,
  ): Promise<T> {
    const { route, token } = await this.prepare();
    const { stallMs, hardMs } = uploadDeadlines(file.size);
    const retry = (): Promise<T> => this.upload<T>(path, file, onProgress, signal, false);

    let answer: { status: number; statusText: string; text: string };
    try {
      if (route.kind === "relay") {
        const sent = await this.send(route, token, path, { method: "POST", body: file }, hardMs, {
          onProgress,
          signal,
        });
        answer = { status: sent.status, statusText: sent.statusText, text: bodyText(sent.bytes) };
      } else {
        answer = await sendWithProgress(new URL(path, route.base), file, token, onProgress, {
          stallMs,
          hardMs,
          signal,
        });
      }
    } catch (error) {
      // The caller asked for this. Not a network fact, so nothing is recorded.
      if (signal.aborted) throw error;
      return this.settleTransport(error, isReplayable("POST"), firstAttempt, retry);
    }

    return this.settleAnswer<T>(answer.status, answer.statusText, answer.text, firstAttempt, retry);
  }

  async download(path: string, firstAttempt = true): Promise<Blob> {
    const { route, token } = await this.prepare();
    const retry = (): Promise<Blob> => this.download(path, false);

    let answer: { status: number; statusText: string; headers: Record<string, string>; bytes: Uint8Array };
    try {
      if (route.kind === "relay") {
        const got = await this.overChannel(route, {
          method: "GET",
          path,
          headers: { authorization: `Bearer ${token}` },
          timeoutMs: TRANSFER_TIMEOUT_MS,
        });
        answer = { status: got.status, statusText: got.statusText, headers: got.headers, bytes: got.body };
      } else {
        const response = await fetch(new URL(path, route.base), {
          headers: { authorization: `Bearer ${token}` },
          signal: withTimeout(TRANSFER_TIMEOUT_MS),
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
        answer = {
          status: response.status,
          statusText: response.statusText,
          headers,
          bytes: new Uint8Array(await response.arrayBuffer()),
        };
      }
    } catch (error) {
      return this.settleTransport(error, isReplayable("GET"), firstAttempt, retry);
    }

    if (answer.status < 200 || answer.status > 299) {
      // Always throws: parseBody refuses every non-2xx.
      return this.settleAnswer<Blob>(answer.status, answer.statusText, bodyText(answer.bytes), firstAttempt, retry);
    }

    const declared = Number(answer.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new ApiError(413, "file_too_large", "that file is too large to download here", {
        bytes: declared,
        limit: MAX_DOWNLOAD_BYTES,
      });
    }

    if (this.reach !== "online") {
      this.reach = "online";
      this.offlineReason = null;
      this.onChange();
    }
    const type = answer.headers["content-type"];
    return new Blob([answer.bytes as Uint8Array<ArrayBuffer>], type === undefined ? {} : { type });
  }

  // The token rides in the query only because a browser cannot set WebSocket headers; do not extend this to downloads.
  streamUrl(session: string, since: number, token: string, route: Route): string {
    const url = new URL(`/sessions/${encodeURIComponent(session)}/stream`, route.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("since", String(since));
    url.searchParams.set("token", token);
    return url.toString();
  }

  openStream(session: string, since: number, token: string, route: Route): StreamSocket {
    if (route.kind === "relay") {
      const path = `/sessions/${encodeURIComponent(session)}/stream?since=${String(since)}`;
      return this.channelFor(route).openSocket(path);
    }
    return new WebSocket(this.streamUrl(session, since, token, route));
  }

  markUnreachable(reason: OfflineReason, detail: string | null = null): void {
    this.reach = "offline";
    this.offlineReason = reason;
    if (detail !== null) this.lastError = detail;
    this.onChange();
  }
}

function sendWithProgress(
  url: URL,
  body: Blob,
  token: string,
  onProgress: (fraction: number) => void,
  bounds: { stallMs: number; hardMs: number; signal: AbortSignal },
): Promise<{ status: number; statusText: string; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stall: ReturnType<typeof setTimeout> | undefined;

    const fail = (reason: string): void => {
      clear();
      xhr.abort();
      reject(new TypeError(reason));
    };
    const hard = setTimeout(() => fail("upload timed out"), bounds.hardMs);
    const touch = (): void => {
      clearTimeout(stall);
      stall = setTimeout(() => fail("upload stalled"), bounds.stallMs);
    };
    const onAbort = (): void => {
      clear();
      xhr.abort();
      reject(new DOMException("upload cancelled", "AbortError"));
    };
    function clear(): void {
      clearTimeout(hard);
      clearTimeout(stall);
      bounds.signal.removeEventListener("abort", onAbort);
    }

    if (bounds.signal.aborted) {
      clearTimeout(hard);
      reject(new DOMException("upload cancelled", "AbortError"));
      return;
    }
    bounds.signal.addEventListener("abort", onAbort);

    xhr.open("POST", url.toString(), true);
    xhr.setRequestHeader("authorization", `Bearer ${token}`);
    // Set explicitly: the daemon reads the mime from this header.
    xhr.setRequestHeader("content-type", body.type || "application/octet-stream");

    xhr.upload.addEventListener("progress", (event) => {
      touch();
      onProgress(event.lengthComputable && event.total > 0 ? event.loaded / event.total : 0);
    });
    // Awaiting the answer is not a stall: the daemon may still be writing to disk.
    xhr.upload.addEventListener("load", () => clearTimeout(stall));
    xhr.addEventListener("load", () => {
      clear();
      resolve({ status: xhr.status, statusText: xhr.statusText, text: xhr.responseText });
    });
    xhr.addEventListener("error", () => fail("upload failed"));
    xhr.addEventListener("timeout", () => fail("upload timed out"));

    touch();
    xhr.send(body);
  });
}

// The daemon's worst case behind each slow route, first match wins; webcheck sums each chain from src/ and fails a number below it.
function daemonChainMs(verb: string, path: string): number | null {
  if (verb === "POST" && path === "/sessions") return 185_000;
  if (verb === "POST" && path === "/plugins/source") return 48_000;
  // A prompt may wait out a restart and resume an interrupted session first; unconditional so the transport needs no session state.
  if (verb === "POST" && /^\/sessions\/[^/]+\/prompt$/.test(path)) return 120_000;
  if (verb === "POST" && /^\/sessions\/[^/]+\/resume$/.test(path)) return 45_000;
  if (verb === "POST" && /^\/sessions\/[^/]+\/config$/.test(path)) return 60_000;
  // Every /agents read and /agent-auth call spawns a CLI; custom-agent writes validate against one, reads do not.
  if (verb === "GET" && path.startsWith("/agents/capabilities")) return 260_000;
  if (verb === "GET" && path.startsWith("/agents")) return 20_000;
  if (path.startsWith("/agent-auth")) return 20_000;
  if ((verb === "POST" || verb === "PATCH") && path.startsWith("/custom-agents")) return 260_000;
  if (verb === "POST" && /^\/plugins\/[^/]+\/state$/.test(path)) return 18_000;
  return null;
}

/** The deadline for a route whose daemon-side budget exceeds REQUEST_TIMEOUT_MS, or null; downloads and uploads are bounded separately. */
export function slowRouteTimeout(method: string | undefined, path: string): number | null {
  const chain = daemonChainMs((method ?? "GET").toUpperCase(), path);
  return chain === null ? null : Math.max(SLOW_ROUTE_FLOOR_MS, chain + SLOW_ROUTE_MARGIN_MS);
}

export function slowRoute(method: string | undefined, path: string): boolean {
  return slowRouteTimeout(method, path) !== null;
}

export function describe(error: unknown): string {
  if (ApiError.isApiError(error)) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
