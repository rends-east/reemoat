import { hostname } from "node:os";
import { approvalCode, keyFingerprint, readMachineKey, weighOfferedKey } from "@reemoat/protocol";
import { Authority, type MachineRow, type Me, type Minted } from "./authority.js";
import { channelRequest, decodeBody, CHANNEL_TIMEOUT_MS } from "./channel.js";
import { DeviceNotApproved, MachineKeyChanged, ReemoatError, machineError, relayError } from "./errors.js";
import { clientHome, deviceKeyFrom, loadDeviceKey, PinFile, type DeviceKey } from "./identity.js";
import { loopbackRequest } from "./loopback.js";

export interface ReemoatOptions {
  /** The address you sign in at; the Authority, never the relay. */
  server: string;
  apiKey: string;
  /** Where this installation's device key and machine pins live; `clientHome()` by default. */
  home?: string;
  /** A device key held elsewhere (a CI secret), as `reemoat device export` prints it: never written to disk. */
  deviceKey?: string;
  /** How the machine's own list of devices names this one. */
  deviceName?: string;
  /** Machine keys known before first contact, by machine id or by the name you call it, so the first dial is not trust on first use. */
  machineKeys?: Record<string, string>;
  /** A daemon on this computer: loopback rather than the relay. */
  localUrl?: string;
  /** That daemon's REEMOAT_TOKEN, else a token minted from the API key. */
  localToken?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface RequestOptions {
  method: string;
  path: string;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as it is, with its own content type. */
  text?: { value: string; type: string };
  headers?: Record<string, string>;
  /** Whether sending it twice is harmless; a failure after it went out is retried only then. */
  replayable?: boolean;
}

export interface Answer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Renewed this long before it expires, as the terminal client renews. */
const TOKEN_RENEW_MARGIN_MS = 90_000;
const NO_TUNNEL_RETRY_MS = 1_500;

interface Attempt {
  rebound: boolean;
  reminted: boolean;
  redialled: boolean;
  relayUrl: string | null;
}

export class Reemoat {
  private device: DeviceKey | null = null;
  private binding: Promise<void> | null = null;
  private readonly tokens = new Map<string, { minted: Minted; skewMs: number }>();
  private readonly pins: PinFile;

  private constructor(
    private readonly options: ReemoatOptions,
    private readonly authority: Authority,
    readonly me: Me,
  ) {
    this.pins = new PinFile(options.home ?? clientHome(), authority.origin);
  }

  static async connect(options: ReemoatOptions): Promise<Reemoat> {
    if (options.apiKey.length === 0) throw new ReemoatError("client", 0, "missing_api_key", "no API key", null, "set REEMOAT_API_KEY to a key made in the Reemoat app's settings");
    const authority = new Authority(options.server, options.apiKey, options.fetch ?? fetch);
    return new Reemoat(options, authority, await authority.me());
  }

  async machines(): Promise<MachineRow[]> {
    return await this.authority.machines();
  }

  /** The key this installation dials with, binding it to the API key on first use. */
  async deviceKey(): Promise<DeviceKey> {
    const device = this.localDevice();
    await this.bind(false);
    return device;
  }

  /** The key on disk or in the environment, bound or not. */
  localDevice(): DeviceKey {
    this.device ??= this.options.deviceKey !== undefined ? deviceKeyFrom(this.options.deviceKey) : loadDeviceKey(this.options.home ?? clientHome(), this.authority.origin, this.me.id);
    return this.device;
  }

  /** Moves this API key's binding here from another installation, which stops reaching any machine until it gets a key of its own. */
  async rebind(): Promise<void> {
    this.binding = null;
    this.tokens.clear();
    await this.bind(true);
  }

  /** Accepts the key the server now names for a machine, given the fingerprint somebody compared; any other is refused. */
  async trust(machine: string, fingerprint: string): Promise<string> {
    const minted = await this.token(machine, true);
    const offered = readMachineKey(minted.machine.key);
    if (offered === null) throw new ReemoatError("server", 0, "machine_key_missing", `${minted.machine.name} has announced no machine key`, null, "update that machine's daemon");
    const named = keyFingerprint(new Uint8Array(Buffer.from(offered, "base64url")));
    if (normalFingerprint(named) !== normalFingerprint(fingerprint)) {
      throw new ReemoatError("client", 0, "fingerprint_mismatch", `the key the server names for ${minted.machine.name} is ${named}, not ${fingerprint}`);
    }
    this.pins.set(minted.machine.id, offered);
    return named;
  }

  /** Any route on the machine's daemon, with the API key's grant there. */
  async request(machine: string, request: RequestOptions): Promise<Answer> {
    const headers: Record<string, string> = { ...request.headers };
    let body: Uint8Array | null = null;
    if (request.text !== undefined) {
      headers["content-type"] = request.text.type;
      body = new TextEncoder().encode(request.text.value);
    } else if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      body = new TextEncoder().encode(JSON.stringify(request.body));
    }
    const replayable = request.replayable ?? (request.method === "GET" || request.method === "DELETE");
    const shaped = { method: request.method, path: request.path, headers, body };
    if (this.options.localUrl !== undefined) return await this.viaLoopback(machine, shaped);
    return await this.viaRelay(machine, shaped, replayable, { rebound: false, reminted: false, redialled: false, relayUrl: null });
  }

  private async bind(replace: boolean): Promise<void> {
    const device = this.localDevice();
    this.binding ??= this.authority.bind(device.publicKey, replace).then(
      () => undefined,
      (error: unknown) => {
        this.binding = null;
        throw error;
      },
    );
    await this.binding;
  }

  private async token(machine: string, fresh = false): Promise<Minted> {
    const held = this.tokens.get(machine);
    if (!fresh && held !== undefined && held.minted.expiresAt - (Date.now() + held.skewMs) > TOKEN_RENEW_MARGIN_MS) return held.minted;
    const minted = await this.authority.mint(machine);
    this.tokens.set(machine, { minted, skewMs: Number.isFinite(minted.serverTime) ? minted.serverTime - Date.now() : 0 });
    return minted;
  }

  private async viaLoopback(machine: string, request: { method: string; path: string; headers: Record<string, string>; body: Uint8Array | null }): Promise<Answer> {
    const token = this.options.localToken ?? (await this.token(machine)).token;
    const answer = await loopbackRequest(this.options.localUrl!, token, request, this.options.fetch ?? fetch, this.options.timeoutMs ?? CHANNEL_TIMEOUT_MS);
    return settle(answer.status, answer.headers, answer.body);
  }

  private async viaRelay(
    machine: string,
    request: { method: string; path: string; headers: Record<string, string>; body: Uint8Array | null },
    replayable: boolean,
    attempt: Attempt,
  ): Promise<Answer> {
    // Bound before the mint, so the token names this key.
    const device = await this.deviceKey();
    const minted = await this.token(machine);
    const name = minted.machine.name;
    const relayUrl = attempt.relayUrl ?? minted.machine.relayUrl;
    if (relayUrl === null) throw new ReemoatError("server", 0, "no_relay", `the server names no relay for ${name}`);

    const preset = readMachineKey(this.options.machineKeys?.[minted.machine.id] ?? this.options.machineKeys?.[machine]);
    const held = this.pins.get(minted.machine.id) ?? preset;
    const weighed = weighOfferedKey(held, readMachineKey(minted.machine.key));
    if (weighed.kind === "none") {
      throw new ReemoatError("server", 0, "machine_key_missing", `${name} has announced no machine key`, null, "update that machine's daemon");
    }
    const offered = weighed.kind === "changed" ? weighed.offered : null;
    // Pinned once the handshake has proved the machine holds it, never on the server's word alone.
    const pin = (): void => {
      if (weighed.kind === "use" && (weighed.pin || this.pins.get(minted.machine.id) === null)) this.pins.set(minted.machine.id, weighed.key);
    };

    const result = await channelRequest(
      { relayUrl, token: minted.token, machineKey: weighed.key, staticKey: device.staticKey, device: this.description() },
      request,
      this.options.timeoutMs,
    );
    const again = (next: Partial<Attempt>): Promise<Answer> => this.viaRelay(machine, request, replayable, { ...attempt, ...next });

    switch (result.kind) {
      case "answered":
        pin();
        return settle(result.status, result.headers, result.body);
      case "relay_refused":
        if (result.status === 421 && result.relayUrl !== null && attempt.relayUrl === null) return await again({ relayUrl: result.relayUrl });
        if (result.code === "no_tunnel" && !attempt.redialled) {
          await new Promise((resolve) => setTimeout(resolve, NO_TUNNEL_RETRY_MS));
          return await again({ redialled: true });
        }
        if (result.code === "token_expired" && !attempt.reminted) {
          this.tokens.delete(machine);
          return await again({ reminted: true });
        }
        throw relayError(result.status, result.code);
      case "refused":
        pin();
        if (!result.requestSent) {
          // A key the Authority never bound, or bound before this one: bind once more and ask again, once.
          if ((result.reason === "unbound_capability" || result.reason === "wrong_device") && !attempt.rebound) {
            this.binding = null;
            this.tokens.delete(machine);
            return await again({ rebound: true });
          }
          if (result.reason === "token_expired" && !attempt.reminted) {
            this.tokens.delete(machine);
            return await again({ reminted: true });
          }
          if (result.reason === "device_not_approved") {
            throw new DeviceNotApproved(name, approvalCode(new Uint8Array(Buffer.from(device.publicKey, "base64url"))));
          }
        }
        throw new ReemoatError("channel", result.status ?? 401, result.reason, `${name} refused the channel: ${result.reason}`);
      case "handshake_failed":
        if (offered !== null) {
          throw new MachineKeyChanged(name, weighed.key, offered, fingerprintOf(weighed.key), fingerprintOf(offered));
        }
        throw new ReemoatError(
          "channel",
          0,
          "handshake_failed",
          `${name} did not answer on its key`,
          { fingerprint: fingerprintOf(weighed.key) },
          "compare the fingerprint with what the daemon prints at start",
        );
      case "crypto_failure":
        throw new ReemoatError("channel", 0, "crypto_failure", `the channel to ${name} failed to decrypt; nothing more was read`);
      case "too_large":
        throw new ReemoatError("client", 0, "response_too_large", `the answer from ${name} is larger than this client takes`);
      case "unusable":
        throw new ReemoatError("channel", 0, "unusable_answer", `${name} answered something this client cannot read: ${result.reason}`);
      case "closed":
      case "aborted":
      case "unreachable": {
        const sent = result.kind === "unreachable" ? false : result.requestSent;
        // A responder holding another key cannot decrypt the first message and closes with nothing. A held token names the key
        // the machine had when it was minted, so mint once more to learn the one the server names now, then call it a change.
        const unanswered = result.kind !== "unreachable" && !result.handshaken;
        if (unanswered && !attempt.reminted) {
          this.tokens.delete(machine);
          return await again({ reminted: true });
        }
        if (unanswered && offered !== null) {
          throw new MachineKeyChanged(name, weighed.key, offered, fingerprintOf(weighed.key), fingerprintOf(offered));
        }
        if (!attempt.redialled && (!sent || replayable)) return await again({ redialled: true });
        const code = result.kind === "aborted" ? "timeout" : result.kind;
        const why = sent ? "; it may have acted, so this was not sent again" : "";
        throw new ReemoatError("client", 0, code, `the channel to ${name} ended without an answer${why}`);
      }
    }
  }

  private description(): { name: string; platform: string } {
    const name = this.options.deviceName ?? `reemoat CLI on ${hostname()}`;
    return { name: name.slice(0, 64), platform: process.platform };
  }
}

function settle(status: number, headers: Record<string, string>, raw: Uint8Array): Answer {
  const body = decodeBody(raw, headers);
  if (status >= 400) throw machineError(status, body);
  return { status, headers, body };
}

function fingerprintOf(key: string): string {
  return keyFingerprint(new Uint8Array(Buffer.from(key, "base64url")));
}

function normalFingerprint(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}
