import type { Readable as NodeReadable } from "node:stream";
import { PassThrough, Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentHandle, AgentProcess } from "../runtime/types.js";
import type { AgentLaunchConfig } from "./agents.js";
import type { AgentRouting } from "./systems.js";
import { AIR_CLIENT_CAPABILITY, ASYNC_TASK_MARKER, ASYNC_TASK_UPDATES, agentAdvertisesAsyncTasks } from "./asynctasks.js";
import {
  XAI_ASK_USER_QUESTION,
  XAI_EXIT_PLAN_MODE,
  XAI_MCP_ELICIT,
  XAI_SESSION_NOTIFICATION,
  parseMcpElicitRequest,
  parsePlanRequest,
  parseQuestionRequest,
  readInteractionResolved,
  type XaiMcpElicitRequest,
  type XaiMcpElicitResponse,
  type XaiPlanRequest,
  type XaiPlanResponse,
  type XaiQuestionRequest,
  type XaiQuestionResponse,
} from "./xai.js";

export interface SessionHandlers {
  onUpdate(notification: acp.SessionNotification): void;
  onPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>;
  onReadTextFile(request: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  onWriteTextFile(request: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  /** Form mode, session-scoped only (the router refuses the rest); the promise holds the agent's turn open until answered. */
  onElicitation(
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse>;
  /** grok's own three requests (acp/xai.ts), held open like the two above until somebody answers. */
  onXaiQuestion(request: XaiQuestionRequest, signal: AbortSignal): Promise<XaiQuestionResponse>;
  onXaiPlan(request: XaiPlanRequest, signal: AbortSignal): Promise<XaiPlanResponse>;
  onXaiMcpElicit(request: XaiMcpElicitRequest, signal: AbortSignal): Promise<XaiMcpElicitResponse>;
  /** grok settled one of them itself: how its own timeout withdraws a question it never tells the client about. */
  onXaiInteractionResolved(toolCallId: string): void;
}

export type ElicitationRequest = acp.ElicitationFormMode &
  acp.ElicitationSessionScope & { message: string };

export type LogListener = (line: string) => void;

/** A tap on every raw session/update. Nothing in the daemon subscribes; scripts/harness.ts does, behind --raw. */
export type NotificationListener = (notification: acp.SessionNotification) => void;

export interface LaunchOptions {
  /** Required with no default, so deleting it at a call site is a type error. See SessionRuntime.clientFileIo. */
  fileIo: boolean;
  /** Required: declaring it hands claude its AskUserQuestion tool, and a question has no default answer. */
  elicitation: boolean;
  /** Decided by SessionRuntime.authMethod, the only place that sees whether the spawn environment holds a key to spend. */
  authMethod: string | null;
}

const HANDSHAKE_TIMEOUT_MS = 30_000;

/** Bounded like every other launch-path await: a hang here parks Session.start and can hold an ask slot for ever. */
const LIST_PROVIDERS_TIMEOUT_MS = 15_000;

/** Bounded because an authenticate method can block on a human in a browser. */
const AUTHENTICATE_TIMEOUT_MS = 15_000;
const EXIT_GRACE_MS = 3_000;
const STDERR_RING_SIZE = 20;

interface Router {
  sessions: Map<string, SessionHandlers>;
  logListeners: Set<LogListener>;
  notificationListeners: Set<NotificationListener>;
  recentStderr: string[];
}

export class AcpClient {
  private closing: Promise<void> | null = null;

  private constructor(
    readonly config: AgentLaunchConfig,
    private readonly child: AgentProcess,
    private readonly connection: acp.ClientConnection,
    private readonly router: Router,
    readonly initializeResult: acp.InitializeResponse,
  ) {}

  get agent(): acp.ClientContext {
    return this.connection.agent;
  }

  get closed(): Promise<void> {
    return this.connection.closed;
  }

  static async launch(
    config: AgentLaunchConfig,
    child: AgentProcess,
    options: LaunchOptions,
  ): Promise<AcpClient> {
    const fileIo = options.fileIo;
    const elicitation = options.elicitation;
    const router: Router = {
      sessions: new Map(),
      logListeners: new Set(),
      notificationListeners: new Set(),
      recentStderr: [],
    };

    pumpStderr(child.stderr, (line) => {
      router.recentStderr.push(line);
      if (router.recentStderr.length > STDERR_RING_SIZE) router.recentStderr.shift();
      for (const listener of router.logListeners) listener(line);
    });

    // Taps first, guarded and evicting; the session handler call is unguarded on purpose.
    // The SDK road swallows a throw and loses the update; the split road contains it in handOff, which closes the connection.
    const deliver = (notification: acp.SessionNotification): void => {
      for (const listener of router.notificationListeners) {
        try {
          listener(notification);
        } catch {
          router.notificationListeners.delete(listener);
        }
      }
      router.sessions.get(notification.sessionId)?.onUpdate(notification);
    };

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(splitAsyncTaskUpdates(child.stdout, deliver)) as ReadableStream<Uint8Array>,
    );

    const route = <T>(sessionId: string, pick: (handlers: SessionHandlers) => T): T => {
      const handlers = router.sessions.get(sessionId);
      if (!handlers) {
        throw acp.RequestError.invalidParams(
          { sessionId },
          `no session registered for ${sessionId}`,
        );
      }
      return pick(handlers);
    };

    const connection = acp
      .client({ name: "reemoat" })
      .onNotification(acp.methods.client.session.update, (ctx) => deliver(ctx.params))
      // Ahead of every request on purpose: each handler costs a message one await, so a later one would let the
      // question grok asks next overtake the resolution that closed grok's own step before it (Q6.113).
      .onNotification(XAI_SESSION_NOTIFICATION, readInteractionResolved, (ctx) => {
        if (ctx.params === null) return;
        router.sessions.get(ctx.params.sessionId)?.onXaiInteractionResolved(ctx.params.toolCallId);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        route(ctx.params.sessionId, (h) => h.onPermission(ctx.params, ctx.signal)),
      )
      // Gated, not merely undeclared: the capability is a statement to an untrusted agent, and these run in the daemon's process.
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => {
        if (!fileIo) throw acp.RequestError.methodNotFound(acp.methods.client.fs.readTextFile);
        return route(ctx.params.sessionId, (h) => h.onReadTextFile(ctx.params));
      })
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => {
        if (!fileIo) throw acp.RequestError.methodNotFound(acp.methods.client.fs.writeTextFile);
        return route(ctx.params.sessionId, (h) => h.onWriteTextFile(ctx.params));
      })
      // Only a session-scoped form is answerable; anything else is an invalidParams error, never a decline, since nobody declined.
      .onRequest(acp.methods.client.elicitation.create, (ctx) => {
        if (!elicitation) {
          throw acp.RequestError.methodNotFound(acp.methods.client.elicitation.create);
        }
        const params = ctx.params;
        if (!acp.CreateElicitationRequest.isForm(params)) {
          throw acp.RequestError.invalidParams(
            { mode: params.mode },
            `this client only renders form elicitations, not ${JSON.stringify(params.mode)}`,
          );
        }
        if (!("sessionId" in params)) {
          throw acp.RequestError.invalidParams(
            { scope: "request" },
            "this client only renders elicitations scoped to a session",
          );
        }
        const scoped: ElicitationRequest = params;
        return route(scoped.sessionId, (h) => h.onElicitation(scoped, ctx.signal));
      })
      // grok's own requests; any other `_` method still answers -32601, as these did (Q2.235).
      .onRequest(XAI_ASK_USER_QUESTION, parseQuestionRequest, (ctx) => {
        if (!elicitation) throw acp.RequestError.methodNotFound(XAI_ASK_USER_QUESTION);
        return route(ctx.params.sessionId, (h) => h.onXaiQuestion(ctx.params, ctx.signal));
      })
      .onRequest(XAI_EXIT_PLAN_MODE, parsePlanRequest, (ctx) =>
        route(ctx.params.sessionId, (h) => h.onXaiPlan(ctx.params, ctx.signal)),
      )
      .onRequest(XAI_MCP_ELICIT, parseMcpElicitRequest, (ctx) => {
        if (!elicitation) throw acp.RequestError.methodNotFound(XAI_MCP_ELICIT);
        return route(ctx.params.sessionId, (h) => h.onXaiMcpElicit(ctx.params, ctx.signal));
      })
      .connect(stream);

    const failed = deferred<never>();
    const onSpawnError = (error: Error) => {
      failed.reject(new Error(`failed to spawn ${config.command}: ${error.message}`));
    };
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      failed.reject(
        new Error(
          `${config.displayName} exited during the ACP handshake ` +
            `(code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    };
    const offStartError = child.onceStartError(onSpawnError);
    const offExit = child.onceExit(onEarlyExit);

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${config.displayName} did not answer initialize within ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
            ),
          ),
        HANDSHAKE_TIMEOUT_MS,
      );
    });

    try {
      const initializeResult = await Promise.race([
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          // The runtime's call: these reverse RPCs run in this process, outside whatever confines the agent.
          clientCapabilities: {
            fs: { readTextFile: fileIo, writeTextFile: fileIo },
            terminal: false,
            // Grants the agent nothing; without it an on/off option degrades to a two-entry select.
            session: { configOptions: { boolean: {} } },
            // Absence is the only way to decline: there is no form false.
            ...(elicitation ? { elicitation: { form: {} } } : {}),
            // See acp/asynctasks.ts. Declaring it also adds the backgrounded marker that readBackgroundedMarker reads.
            _meta: AIR_CLIENT_CAPABILITY,
          },
          clientInfo: { name: "reemoat", version: "0.0.0" },
        }),
        failed.promise,
        timedOut,
      ]);

      if (initializeResult.protocolVersion > acp.PROTOCOL_VERSION) {
        throw new Error(
          `${config.displayName} negotiated ACP protocol v${initializeResult.protocolVersion}, ` +
            `but this client only speaks v${acp.PROTOCOL_VERSION}`,
        );
      }

      // One door for all three launch sites, sent only when the runtime found a key to spend (Q2.215, Q6.110).
      // A failure goes to the stderr ring rather than throwing: session/new refuses by itself next.
      const authMethod = options.authMethod;
      if (authMethod !== null) {
        let authTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            connection.agent.request(acp.methods.agent.authenticate, {
              methodId: authMethod,
              _meta: { headless: true },
            }),
            new Promise<never>((_, reject) => {
              authTimer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `${config.displayName} did not answer authenticate within ` +
                        `${AUTHENTICATE_TIMEOUT_MS / 1000}s`,
                    ),
                  ),
                AUTHENTICATE_TIMEOUT_MS,
              );
            }),
          ]);
        } catch (error) {
          router.recentStderr.push(
            `authenticate(${authMethod}) failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (router.recentStderr.length > STDERR_RING_SIZE) router.recentStderr.shift();
        } finally {
          clearTimeout(authTimer);
        }
      }

      return new AcpClient(config, child, connection, router, initializeResult);
    } catch (error) {
      // SIGTERM first, so the adapter's own child is not orphaned.
      await child.kill("SIGTERM");
      if (!(await child.waitForExit(EXIT_GRACE_MS))) await child.kill("SIGKILL");
      try {
        connection.close();
      } catch {
        // already closed
      }
      throw withStderr(error, config, router.recentStderr);
    } finally {
      clearTimeout(timer);
      offStartError();
      offExit();
    }
  }

  /** Read from providers/list, since the provider id has already moved between releases. null on every failure, never a throw. */
  async routing(): Promise<AgentRouting | null> {
    if (this.initializeResult.agentCapabilities?.providers == null) return null;
    let answer: acp.ListProvidersResponse;
    let timer: NodeJS.Timeout | undefined;
    try {
      answer = await Promise.race([
        this.agent.request(acp.methods.agent.providers.list, {}),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${this.config.displayName} did not answer providers/list ` +
                    `within ${LIST_PROVIDERS_TIMEOUT_MS / 1000}s`,
                ),
              ),
            LIST_PROVIDERS_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    // Read defensively: the SDK validates no response for providers/list.
    const providers: unknown = (answer as { providers?: unknown } | null | undefined)?.providers;
    if (!Array.isArray(providers)) return null;
    const first: unknown = providers[0];
    if (typeof first !== "object" || first === null) return null;
    const { providerId, supported } = first as { providerId?: unknown; supported?: unknown };
    if (typeof providerId !== "string" || providerId.length === 0) return null;
    // A type predicate: Array.isArray yields any[], which a bare every would not narrow.
    if (!Array.isArray(supported)) return null;
    if (!supported.every((one): one is string => typeof one === "string")) return null;
    return { providerId, supported };
  }

  async setProvider(params: acp.SetProviderRequest): Promise<void> {
    await this.agent.request(acp.methods.agent.providers.set, params);
  }

  registerSession(sessionId: string, handlers: SessionHandlers): () => void {
    this.router.sessions.set(sessionId, handlers);
    return () => this.router.sessions.delete(sessionId);
  }

  onLog(listener: LogListener): () => void {
    this.router.logListeners.add(listener);
    return () => this.router.logListeners.delete(listener);
  }

  onNotification(listener: NotificationListener): () => void {
    this.router.notificationListeners.add(listener);
    return () => this.router.notificationListeners.delete(listener);
  }

  recentLogs(): string[] {
    return [...this.router.recentStderr];
  }

  get handle(): AgentHandle | null {
    return this.child.handle;
  }

  supportsSessionClose(): boolean {
    return this.initializeResult.agentCapabilities?.sessionCapabilities?.close != null;
  }

  /** session/resume, never session/load, which would replay a transcript we already hold. */
  supportsSessionResume(): boolean {
    return this.initializeResult.agentCapabilities?.sessionCapabilities?.resume != null;
  }

  /** A declared boolean, so === true. embeddedContext is deliberately not exposed: nothing has measured resource blocks. */
  acceptsImages(): boolean {
    return this.initializeResult.agentCapabilities?.promptCapabilities?.image === true;
  }

  /** An extension read off the top-level _meta, not agentCapabilities._meta, and compared === true. */
  supportsSteering(): boolean {
    const meta = this.initializeResult._meta;
    if (meta === null || typeof meta !== "object") return false;
    const steering = (meta as Record<string, unknown>)["steering"];
    if (steering === null || typeof steering !== "object") return false;
    return (steering as Record<string, unknown>)["supported"] === true;
  }

  /** Read from the initialize answer: an agent that never reports background work must not look idle. */
  supportsAsyncTasks(): boolean {
    return agentAdvertisesAsyncTasks(this.initializeResult._meta);
  }

  async close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.child.endStdin();
    if (!(await this.child.waitForExit(EXIT_GRACE_MS))) {
      await this.child.kill("SIGTERM");
      if (!(await this.child.waitForExit(EXIT_GRACE_MS))) {
        await this.child.kill("SIGKILL");
        await this.child.waitForExit(EXIT_GRACE_MS);
      }
    }
    try {
      this.connection.close();
    } catch {
      // already closed by the transport ending
    }
  }
}

function deferred<T>(): { promise: Promise<T>; reject: (error: Error) => void } {
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((_, rej) => {
    reject = rej;
  });
  // Mark as handled so a rejection that loses the race is not "unhandled".
  promise.catch(() => {});
  return { promise, reject };
}

function withStderr(error: unknown, config: AgentLaunchConfig, lines: string[]): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  if (lines.length === 0) return base;
  base.message =
    `${base.message}\n\n--- ${config.displayName} stderr ` +
    `(last ${lines.length} lines) ---\n${lines.join("\n")}`;
  return base;
}

const MAX_STDERR_LINE_CHARS = 64 * 1024;

/** The only bound between the child's pipe and a parsed message; large because a frame may carry a whole file or image. */
const MAX_STDOUT_FRAME_CHARS = 16 * 1024 * 1024;

/**
 * Diverts the draft async-task updates the SDK rejects: zSessionUpdate is a closed union parsed by ClientApp's SessionUpdateRouter,
 * which no option or registerAppNotification parser bypasses. Everything else is forwarded byte for byte.
 */
export function splitAsyncTaskUpdates(
  stdout: NodeReadable,
  deliver: (notification: acp.SessionNotification) => void,
): NodeReadable {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  /** Set once the split gives up: at the ceiling, or when a session handler threw. */
  let over = false;
  const onward = new PassThrough();
  /** Order matters: over first, carry released, source paused, then onward destroyed. */
  const giveUp = (error: Error): void => {
    over = true;
    carry = "";
    stdout.pause();
    onward.destroy(error);
  };
  /** Contains a throwing session handler, which in a data listener would silence the stream for good; closes the connection instead. */
  const handOff = (notification: acp.SessionNotification): void => {
    try {
      deliver(notification);
    } catch (error) {
      giveUp(error instanceof Error ? error : new Error(String(error)));
    }
  };
  stdout.on("data", (chunk: Buffer) => {
    if (over) return;
    // Scan only the new piece, never the accumulation, which would be quadratic in the frame length.
    const piece = decoder.write(chunk);
    let room = true;
    let from = 0;
    for (let nl = piece.indexOf("\n"); nl >= 0; nl = piece.indexOf("\n", from)) {
      const line = carry + piece.slice(from, nl);
      carry = "";
      from = nl + 1;
      if (!diverted(line, handOff)) room = onward.write(`${line}\n`);
      if (over) return;
    }
    carry += piece.slice(from);
    if (carry.length > MAX_STDOUT_FRAME_CHARS) {
      // Destroy rather than drop: a dropped frame may be a request, leaving the turn hung with nothing saying why.
      giveUp(
        new Error(
          `agent wrote over ${MAX_STDOUT_FRAME_CHARS} UTF-16 code units with no newline; ` +
            "the ACP frame cannot be completed",
        ),
      );
      return;
    }
    // Backpressure only for ended frames; one still arriving is bounded by the ceiling, since pausing mid-frame would deadlock.
    if (!room) {
      stdout.pause();
      onward.once("drain", () => stdout.resume());
    }
  });
  stdout.on("end", () => {
    // Never flush after over: the remaining carry is the refused fragment.
    if (over) return;
    const rest = carry + decoder.end();
    if (rest.length > 0 && !diverted(rest, handOff)) onward.write(rest);
    if (!over) onward.end();
  });
  stdout.on("error", (error) => onward.destroy(error));
  return onward;
}

function diverted(line: string, deliver: (notification: acp.SessionNotification) => void): boolean {
  if (!line.includes(ASYNC_TASK_MARKER)) return false;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof message !== "object" || message === null) return false;
  const envelope = message as { id?: unknown; method?: unknown; params?: unknown };
  if (envelope.method !== acp.methods.client.session.update) return false;
  // A frame carrying an id is a request, forwarded so the SDK can answer it.
  if (envelope.id !== undefined) return false;
  const params = envelope.params as { sessionId?: unknown; update?: { sessionUpdate?: unknown } };
  if (typeof params?.sessionId !== "string") return false;
  const kind = params.update?.sessionUpdate;
  if (typeof kind !== "string" || !ASYNC_TASK_UPDATES.includes(kind)) return false;
  deliver(params as unknown as acp.SessionNotification);
  return true;
}

function pumpStderr(stderr: NodeReadable, onLine: (line: string) => void): void {
  stderr.setEncoding("utf8");
  let buffer = "";
  stderr.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) onLine(line);
      index = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_STDERR_LINE_CHARS) {
      const line = buffer.slice(0, MAX_STDERR_LINE_CHARS);
      buffer = buffer.slice(MAX_STDERR_LINE_CHARS);
      if (line.trim().length > 0) onLine(line);
    }
  });
  stderr.on("end", () => {
    if (buffer.trim().length > 0) onLine(buffer);
    buffer = "";
  });
}
