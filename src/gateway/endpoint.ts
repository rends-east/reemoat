import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WireProtocol } from "../acp/systems.js";
import { forward, type RequestKind } from "./forward.js";
import type { GatewayDeps, GatewayGrant, GatewayGrants, GrantSpec } from "./types.js";

/** Above the largest request a harness was measured to send, a 323 KiB tool list, by two orders; a body is held whole before it is forwarded. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_IN_FLIGHT_PER_GRANT = 16;

const ROUTES: Record<string, { protocol: WireProtocol; kind: RequestKind }> = {
  "/v1/messages": { protocol: "anthropic-messages", kind: "infer" },
  "/v1/messages/count_tokens": { protocol: "anthropic-messages", kind: "count" },
  "/v1/responses": { protocol: "openai-responses", kind: "infer" },
  "/v1/chat/completions": { protocol: "openai-chat", kind: "infer" },
};

/** What a harness asks before it holds anything to present: claude once per process, grok before each session (Q6.123, Q6.127). */
const PREWARM_PATHS = new Set(["/", "/api/hello"]);

interface Held {
  spec: GrantSpec;
  inFlight: number;
}

/** Where every routed harness is pointed: loopback only, one credential per agent process, and the vendor's key added on the way out. */
export class ModelGatewayEndpoint implements GatewayGrants {
  private readonly grants = new Map<string, Held>();

  private constructor(
    private readonly server: Server,
    readonly origin: string,
  ) {}

  static async listen(deps: GatewayDeps): Promise<ModelGatewayEndpoint> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const port = (server.address() as { port: number }).port;
    const endpoint = new ModelGatewayEndpoint(server, `http://127.0.0.1:${port}`);
    server.on("request", (req, res) => {
      void endpoint.handle(deps, port, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    return endpoint;
  }

  open(spec: GrantSpec): GatewayGrant {
    const bearer = randomBytes(32).toString("hex");
    this.grants.set(bearer, { spec, inFlight: 0 });
    return { origin: this.origin, bearer, close: () => void this.grants.delete(bearer) };
  }

  async close(): Promise<void> {
    this.grants.clear();
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
  }

  private async handle(deps: GatewayDeps, port: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A page in a browser reaches loopback too: it sends Origin, and a name rebound to this address sends its own Host.
    const host = req.headers.host ?? "";
    if (req.headers.origin !== undefined || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      req.resume();
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", this.origin);
    if ((req.method === "GET" || req.method === "HEAD") && PREWARM_PATHS.has(url.pathname)) {
      req.resume();
      res.writeHead(204).end();
      return;
    }

    const held = this.grants.get(presented(req) ?? "");
    if (held === undefined) {
      req.resume();
      res.writeHead(401).end();
      return;
    }
    const route = req.method === "POST" ? ROUTES[url.pathname] : undefined;
    if (route === undefined || route.protocol !== held.spec.inbound) {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    if (held.inFlight >= MAX_IN_FLIGHT_PER_GRANT) {
      req.resume();
      res.writeHead(429, { "retry-after": "1" }).end();
      return;
    }

    held.inFlight += 1;
    try {
      const body = await bodyOf(req);
      if (body === null) {
        res.writeHead(413).end();
        return;
      }
      await forward({ spec: held.spec, kind: route.kind, search: url.search, headers: req.headers, body }, res, deps);
    } finally {
      held.inFlight -= 1;
    }
  }
}

/** claude carries it as x-api-key, since it replaces authorization with a constant of its own; the rest as a bearer. */
function presented(req: IncomingMessage): string | null {
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && key.length > 0) return key;
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

async function bodyOf(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
