import { ReemoatError, serverError } from "./errors.js";

// The Authority sees who is asking, which machine, and a public key: never a task, which goes over the channel (Q1.661).

export interface Me {
  id: string;
  name: string;
  apiKey: { id: string; bound: boolean; keySetAt: number | null } | null;
}

export interface MachineRow {
  id: string;
  name: string;
  enrolled: boolean;
  owned: boolean;
  scopes: string[];
  relayUrl: string | null;
  relayOnline: boolean;
  key: string | null;
}

export interface Minted {
  token: string;
  expiresAt: number;
  scopes: string[];
  machine: { id: string; name: string; relayUrl: string | null; relayOnline: boolean; key: string | null };
  serverTime: number;
}

export interface Binding {
  keyId: string;
  keySetAt: number;
  replaced: boolean;
}

export class Authority {
  readonly origin: string;

  constructor(
    server: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    let url: URL;
    try {
      url = new URL(server);
    } catch {
      throw new ReemoatError("client", 0, "bad_server", `${JSON.stringify(server)} is not a server address`, null, "set REEMOAT_SERVER to the address you sign in at, https://…");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ReemoatError("client", 0, "bad_server", "a server address starts with https://");
    }
    this.origin = url.origin;
  }

  async me(): Promise<Me> {
    const body = (await this.call("GET", "/v1/me")) as Record<string, unknown>;
    const key = body["apiKey"] as Record<string, unknown> | null | undefined;
    return {
      id: String(body["id"]),
      name: String(body["name"]),
      apiKey:
        key === null || key === undefined
          ? null
          : { id: String(key["id"]), bound: key["bound"] === true, keySetAt: typeof key["keySetAt"] === "number" ? key["keySetAt"] : null },
    };
  }

  async machines(): Promise<MachineRow[]> {
    const body = (await this.call("GET", "/v1/machines")) as { machines?: unknown };
    if (!Array.isArray(body.machines)) return [];
    return body.machines.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row["id"]),
        name: String(row["name"]),
        enrolled: row["enrolled"] === true,
        owned: row["owned"] === true,
        scopes: Array.isArray(row["scopes"]) ? row["scopes"].map(String) : [],
        relayUrl: typeof row["relayUrl"] === "string" ? row["relayUrl"] : null,
        relayOnline: row["relayOnline"] === true,
        key: typeof row["key"] === "string" ? row["key"] : null,
      };
    });
  }

  /** Idempotent for the key already held; `replace` moves the binding here from another installation. */
  async bind(publicKey: string, replace: boolean): Promise<Binding> {
    try {
      const body = (await this.call("PUT", "/v1/me/keys/current/binding", { publicKey, ...(replace ? { replace: true } : {}) })) as Record<string, unknown>;
      return { keyId: String(body["keyId"]), keySetAt: Number(body["keySetAt"]), replaced: body["replaced"] === true };
    } catch (error) {
      if (error instanceof ReemoatError && error.where === "server" && error.code === "not_found") {
        throw new ReemoatError("server", 404, "binding_unsupported", "this server cannot bind a device key to an API key yet", null, "update the control plane");
      }
      throw error;
    }
  }

  async mint(machine: string): Promise<Minted> {
    const body = (await this.call("POST", "/v1/tokens", { machine })) as Record<string, unknown>;
    const about = (body["machine"] ?? {}) as Record<string, unknown>;
    return {
      token: String(body["token"]),
      expiresAt: Number(body["expiresAt"]),
      scopes: Array.isArray(body["scopes"]) ? body["scopes"].map(String) : [],
      machine: {
        id: String(about["id"]),
        name: String(about["name"]),
        relayUrl: typeof about["relayUrl"] === "string" ? about["relayUrl"] : null,
        relayOnline: about["relayOnline"] === true,
        key: typeof about["key"] === "string" ? about["key"] : null,
      },
      serverTime: Number(body["serverTime"]),
    };
  }

  private async call(method: string, path: string, body?: unknown, retried = false): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ReemoatError("client", 0, "unreachable", `the server at ${this.origin} did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed: unknown = await response.json().catch(() => null);
    // The write throttle is shared with the person's own app: one wait, as long as it asks, then the refusal.
    if (response.status === 429 && !retried) {
      const after = Number(response.headers.get("retry-after") ?? "0");
      if (Number.isFinite(after) && after > 0 && after <= 60) {
        await new Promise((resolve) => setTimeout(resolve, after * 1000));
        return await this.call(method, path, body, true);
      }
    }
    if (!response.ok) throw serverError(response.status, parsed);
    return parsed;
  }
}
