import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { MachineCatalogue, SystemId, SystemSignInPort } from "../../acp/systems.js";
import { SignInError, type IdentityTransport, type SignInAttempt, type SignInFlow } from "./types.js";

/** Long enough to read a consent page and type a password; a page left open past it ends nowhere. */
const RUN_TTL_MS = 10 * 60 * 1000;
/** The path a provider's page hands back on. OpenAI documents this one, and that only the port may vary (Q7.160). */
const CALLBACK_PATH = "/auth/callback";

export interface SignInRunView {
  id: string;
  system: SystemId;
  phase: "waiting" | "done" | "failed";
  /** The page a person opens. The only part of an attempt a client is ever shown. */
  openUrl: string;
  expiresAt: number;
  /** Why it failed, as a sentence. */
  message: string | null;
  /** Who it signed in, once done. */
  account: string | null;
}

interface Run extends SignInRunView {
  flow: SignInFlow;
  attempt: SignInAttempt;
  startedBy: string | null;
  port: number;
  listener: Server;
  timer: NodeJS.Timeout;
  abort: AbortController;
}

export interface SignInRunsDeps {
  machine(): MachineCatalogue;
  flows: Readonly<Record<string, SignInFlow>>;
  signIns: SystemSignInPort;
  transport: IdentityTransport;
  now?: () => number;
}

/** Sign-ins in flight: one per system, each with a listener on this computer where the provider's page hands back. */
export class SystemSignInRuns {
  private readonly runs = new Map<string, Run>();
  private readonly now: () => number;

  constructor(private readonly deps: SignInRunsDeps) {
    this.now = deps.now ?? Date.now;
  }

  async start(system: SystemId, startedBy: string | null): Promise<SignInRunView | { refusal: string }> {
    const spec = this.deps.machine().system(system);
    const flow = spec === null || spec.signIn === null ? undefined : this.deps.flows[spec.signIn];
    if (spec === null || flow === undefined) {
      return { refusal: spec === null ? "This provider is not on this machine." : `${spec.displayName} takes a key, not a sign-in.` };
    }
    for (const run of this.runs.values()) {
      if (run.system === system && run.phase === "waiting") this.end(run, "failed", "Another sign-in was started in its place.");
    }

    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        listener.off("error", reject);
        resolve();
      });
    });
    const port = (listener.address() as { port: number }).port;
    const attempt = flow.begin({ redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, hostId: this.deps.signIns.hostId(flow.id) });
    const id = `si_${randomBytes(8).toString("hex")}`;
    const run: Run = {
      id,
      system,
      phase: "waiting",
      openUrl: attempt.authorizeUrl,
      expiresAt: this.now() + RUN_TTL_MS,
      message: null,
      account: null,
      flow,
      attempt,
      startedBy,
      port,
      listener,
      timer: setTimeout(() => this.end(run, "failed", "The sign-in was not finished in time."), RUN_TTL_MS),
      abort: new AbortController(),
    };
    run.timer.unref();
    this.runs.set(id, run);

    listener.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      // The page arrives from a browser on this computer; a name rebound to this address sends another Host.
      if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || req.headers.host !== `127.0.0.1:${port}`) {
        res.writeHead(404).end();
        return;
      }
      void this.complete(run, url.searchParams).then(() => {
        res.writeHead(run.phase === "done" ? 200 : 400, { "content-type": "text/plain; charset=utf-8" });
        res.end(run.phase === "done" ? "Signed in. This tab can be closed." : (run.message ?? "The sign-in could not be finished."));
      });
    });
    return view(run);
  }

  view(id: string): SignInRunView | null {
    const run = this.runs.get(id);
    return run === undefined ? null : view(run);
  }

  /** The address a browser on another computer was sent to and could not load, pasted here. A value, never a destination: only what the page handed back is read from it. */
  async redirected(id: string, pasted: string): Promise<SignInRunView | { refusal: string } | null> {
    const run = this.runs.get(id);
    if (run === undefined) return null;
    let url: URL;
    try {
      url = new URL(pasted.trim());
    } catch {
      return { refusal: "That is not an address." };
    }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== String(run.port) || url.pathname !== CALLBACK_PATH) {
      return { refusal: "That is not the address this sign-in ends at." };
    }
    await this.complete(run, url.searchParams);
    return view(run);
  }

  abandon(id: string): boolean {
    const run = this.runs.get(id);
    if (run === undefined) return false;
    if (run.phase === "waiting") this.end(run, "failed", "The sign-in was given up.");
    this.runs.delete(id);
    return true;
  }

  shutdown(): void {
    for (const run of this.runs.values()) {
      if (run.phase === "waiting") this.end(run, "failed", "This daemon stopped.");
    }
    this.runs.clear();
  }

  private async complete(run: Run, handedBack: URLSearchParams): Promise<void> {
    if (run.phase !== "waiting") return;
    try {
      const tokens = await run.flow.complete(run.attempt, handedBack, this.deps.transport, this.now(), run.abort.signal);
      // Asked again: the exchange took a network call, and a second callback or a timeout may have ended the run meanwhile.
      if ((run.phase as Run["phase"]) !== "waiting") return;
      this.deps.signIns.save(run.system, run.flow.id, tokens, run.startedBy);
      run.account = tokens.account;
      this.end(run, "done", null);
    } catch (error) {
      this.end(run, "failed", error instanceof SignInError ? error.message : "The sign-in could not be finished.");
    }
  }

  private end(run: Run, phase: "done" | "failed", message: string | null): void {
    if (run.phase !== "waiting") return;
    run.phase = phase;
    run.message = message;
    clearTimeout(run.timer);
    if (phase === "failed") run.abort.abort();
    run.listener.close();
    // Not at once: the page that handed back is still owed its answer on this connection.
    setTimeout(() => run.listener.closeAllConnections(), 1_000).unref();
  }
}

function view(run: Run): SignInRunView {
  return {
    id: run.id,
    system: run.system,
    phase: run.phase,
    openUrl: run.openUrl,
    expiresAt: run.expiresAt,
    message: run.message,
    account: run.account,
  };
}
