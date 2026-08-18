import type { Readable as NodeReadable } from "node:stream";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentHandle, AgentProcess } from "../runtime/types.js";
import type { AgentLaunchConfig } from "./agents.js";

/** Callbacks a session registers to receive everything addressed to it. */
export interface SessionHandlers {
  onUpdate(notification: acp.SessionNotification): void;
  onPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>;
  onReadTextFile(request: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  onWriteTextFile(request: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  /**
   * The agent wants to ask the person on the other end of this daemon something.
   *
   * Form mode only, and already narrowed to the session-scoped arm — the router
   * below refuses everything else before a handler sees it, so this never has to
   * ask which shape it was handed.
   *
   * Parked exactly like {@link onPermission}: the returned promise is the agent's
   * turn held open, and it may be held for as long as somebody takes to answer.
   */
  onElicitation(
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse>;
}

/**
 * A form elicitation, scoped to a session.
 *
 * The SDK's `CreateElicitationRequest` is a three-way union over `mode` crossed
 * with a two-way union over scope, and exactly one of those six shapes is one
 * this daemon can do anything with. Narrowing it here rather than at every reader
 * is what lets `session.ts` treat `sessionId` and `requestedSchema` as present.
 */
export type ElicitationRequest = acp.ElicitationFormMode &
  acp.ElicitationSessionScope & { message: string };

export type LogListener = (line: string) => void;

/**
 * A tap on every `session/update` notification, before anything normalizes it.
 *
 * This exists because the daemon's own vocabulary is lossy by design — `_meta`
 * is an agent-shaped blob and `session.ts` deliberately projects a few fields
 * out of it rather than carrying it — and "what does the agent actually send"
 * has now been a question three times over (`usage_update._meta`, the
 * `terminal_info` blocks, subagent lineage). Inspecting an adapter's `dist/` is
 * not an answer: the relay note already records that inspection was not enough.
 *
 * Nothing in the daemon subscribes. `scripts/harness.ts` does, behind `--raw`,
 * which is what makes a measurement re-runnable instead of a patch somebody
 * applied once and threw away.
 */
export type NotificationListener = (notification: acp.SessionNotification) => void;

export interface LaunchOptions {
  /**
   * Whether this daemon will perform file IO on the agent's behalf.
   *
   * **Required, with no default, on purpose.** It used to be optional and
   * default to `true`, so deleting the argument at either call site silently
   * handed every tenant a read/write primitive executing in the daemon's
   * process, outside their container — and both offline drivers stayed green,
   * because they assert `SessionRuntime.clientFileIo` is `false` rather than
   * asserting anything reads it. Making it required turns that deletion into a
   * type error. See `SessionRuntime.clientFileIo`.
   */
  fileIo: boolean;
  /**
   * Whether a human on the other side of this daemon can be shown a form.
   *
   * **Required, with no default, for the same reason `fileIo` is** — and with a
   * consequence `fileIo` does not have. Declaring this changes what the *model*
   * does rather than what the client renders: measured against claude-agent-acp
   * 0.63.0, `disallowedTools = elicitationSupport.form ? [] : ["AskUserQuestion"]`,
   * so an undeclared capability strips claude's own ask-the-user tool out of the
   * toolset before the CLI starts. Turning it on hands the model a tool back.
   *
   * Derived from whether anybody is there to answer — see `SessionOptions.
   * elicitations`. Unlike `fs`, where this daemon can always perform the write
   * and so "able" and "advertised" are separable values, a question has no
   * defensible default answer: `onPermission` can fall back to allow-once, and
   * nothing can fall back to a person's opinion.
   */
  elicitation: boolean;
}

const HANDSHAKE_TIMEOUT_MS = 30_000;
const EXIT_GRACE_MS = 3_000;
const STDERR_RING_SIZE = 20;

/**
 * Shared mutable state between the JSON-RPC handlers and the client instance.
 *
 * The handlers have to be registered before `connect()`, which is before the
 * `AcpClient` exists, so both sides point at this instead.
 */
interface Router {
  sessions: Map<string, SessionHandlers>;
  logListeners: Set<LogListener>;
  notificationListeners: Set<NotificationListener>;
  recentStderr: string[];
}

/**
 * One ACP agent subprocess plus the JSON-RPC connection running over its stdio.
 *
 * The connection outlives any single prompt — that is the shape the daemon
 * needs — so sessions register themselves here and get routed the notifications
 * and reverse-RPC requests that carry their `sessionId`.
 */
export class AcpClient {
  private closing: Promise<void> | null = null;

  private constructor(
    readonly config: AgentLaunchConfig,
    private readonly child: AgentProcess,
    private readonly connection: acp.ClientConnection,
    private readonly router: Router,
    readonly initializeResult: acp.InitializeResponse,
  ) {}

  /** Agent-side method caller (`session/new`, `session/prompt`, `session/cancel`, …). */
  get agent(): acp.ClientContext {
    return this.connection.agent;
  }

  /** Resolves when the ACP connection closes, for any reason. */
  get closed(): Promise<void> {
    return this.connection.closed;
  }

  /**
   * Completes the ACP handshake over an agent the runtime has already started.
   *
   * Fails loudly: a missing binary, a process that dies during the handshake, or
   * an agent that never answers `initialize` all produce an error carrying the
   * agent's last stderr lines. There is no stub fallback.
   *
   * The process arrives rather than being spawned here, which is the whole of
   * the container change as far as this file is concerned: everything below is
   * written against three pipes and a way to signal what is on the other end,
   * and `docker exec -i` supplies exactly that. Measured before it was relied on
   * — an unprompted first frame, a client frame echoed back, UTF-8 intact, a
   * 200 KB frame intact, and stdin EOF terminating the agent with its exit code
   * propagating.
   */
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

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
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
      .onNotification(acp.methods.client.session.update, (ctx) => {
        // Taps first, and deliberately: the line below drops an update for an
        // unregistered session on the floor (optional chaining, no throw), and a
        // measurement that cannot see those is measuring the wrong thing. It
        // also means a session handler that throws does not cost the tap its
        // copy.
        //
        // Guarded and evicting, exactly as `SessionLog.append` fans out and for
        // the identical reason: this runs inside the agent's own RPC handler, so
        // an unguarded loop would let one broken listener abort routing for the
        // notification that was about to be delivered.
        for (const listener of router.notificationListeners) {
          try {
            listener(ctx.params);
          } catch {
            router.notificationListeners.delete(listener);
          }
        }
        router.sessions.get(ctx.params.sessionId)?.onUpdate(ctx.params);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        route(ctx.params.sessionId, (h) => h.onPermission(ctx.params, ctx.signal)),
      )
      // Gated, not merely undeclared.
      //
      // `clientCapabilities.fs` below tells the agent whether we do file IO for
      // it. That is a *statement to a party we do not trust*: an agent — or
      // anything else inside the tenant's container that can write to the
      // agent's stdout — is free to send the request regardless, and until this
      // gate existed the handler ran it, because the capability flag only ever
      // changed what was advertised. `session.ts` implements these two by
      // calling `readFile`/`writeFile` in the *daemon's* process, so a container
      // around the agent does not contain them.
      //
      // `methodNotFound` is exactly what an unregistered method answers, so a
      // declining runtime is indistinguishable on the wire from one that never
      // implemented these at all.
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => {
        if (!fileIo) throw acp.RequestError.methodNotFound(acp.methods.client.fs.readTextFile);
        return route(ctx.params.sessionId, (h) => h.onReadTextFile(ctx.params));
      })
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => {
        if (!fileIo) throw acp.RequestError.methodNotFound(acp.methods.client.fs.writeTextFile);
        return route(ctx.params.sessionId, (h) => h.onWriteTextFile(ctx.params));
      })
      /*
       * Gated for the same reason `fs` is, and refusing the shapes we cannot
       * render rather than answering them.
       *
       * Three things arrive here and only one is answerable.
       *
       * **`url` mode and any unknown mode** are `invalidParams`. We declare no
       * `url` capability, and claude's adapter declines url-mode itself when the
       * client did not — so one arriving means something ignored the declaration,
       * which is the whole of "a statement is not a gate". A URL is also a URL on
       * *this* host, most often an OAuth callback on loopback, and this daemon is
       * driven from a phone somewhere else; opening it would mean launching a
       * program named by an agent-chosen string, one door along from what the
       * "login command is a table lookup, never a request field" rule forbids.
       *
       * **Request scope** (`requestId`, no `sessionId`) is `invalidParams` too.
       * It exists for auth phases before any session, and this daemon has none —
       * it never calls `session/authenticate`, and every surface it has is
       * per-session. There is nowhere to put such a question: no session to
       * block, no transcript to write it into, no row for a client to find it on.
       * Refusing is the truthful answer rather than a gap. Verified: all three of
       * claude's producers set `sessionId`.
       *
       * All of them are a JSON-RPC **error** and never `{action: "decline"}`,
       * which would be a lie — nobody declined. Measured, the error is also the
       * kindest of the three: `handleAskUserQuestion` turns it into
       * `{behavior: "deny", message: "Could not present the question to the
       * user."}`, so the model is told why and carries on, where a decline tells
       * it a person chose to skip.
       *
       * `isForm` rather than `params.mode === "form"` because the SDK's guards
       * validate the payload as well as the tag, so a form with no
       * `requestedSchema` is refused here instead of reaching the projection with
       * a hole in it.
       */
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
      .connect(stream);

    // Rejects if the process dies or fails to spawn. Pre-handled so a late
    // rejection (after the handshake won the race) is never "unhandled".
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
          // Whether we take responsibility for file IO is the *runtime's* call,
          // not a constant. Locally we do, and Kimi then routes its writes back
          // through the client, which is where the `source: "fs_write"` half of
          // the file-change pair comes from. When the agent is sandboxed we must
          // not: those reverse-RPCs execute in this process, outside whatever
          // confines the agent. Measured on claude and kimi — both edit files
          // perfectly well without the capability, doing the IO themselves.
          clientCapabilities: {
            fs: { readTextFile: fileIo, writeTextFile: fileIo },
            terminal: false,
            // Unrelated to the trust argument above: this one is safe to grant
            // unconditionally because it grants the *agent* nothing. It says we
            // can render an on/off control, and without it an agent that has one
            // degrades it into a two-entry dropdown — measured on claude, whose
            // Fast-mode toggle arrives as `type: "select"` with options
            // `on`/`off` when this is absent. `{}` is how ACP spells "yes".
            session: { configOptions: { boolean: {} } },
            /*
             * Whether the agent may ask the person a question.
             *
             * **Absence is the only way to say no**, and this is a third
             * capability shape read a third way. `promptCapabilities.image` is a
             * declared boolean, so `acceptsImages` compares `=== true`;
             * `sessionCapabilities.resume` is an empty-object marker, so
             * `supportsSessionResume` compares `!= null`. `ElicitationCapabilities.
             * form` is a marker too and there is no `form: false` in the type —
             * so `fs`'s honest `{readTextFile: false}` decline has no analogue
             * here and the key has to be omitted entirely. Reaching for
             * `{form: false}` is the obvious mistake and it would typecheck
             * against the open `_meta`.
             *
             * `url` is deliberately never declared. See the handler above.
             */
            ...(elicitation ? { elicitation: { form: {} } } : {}),
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

      return new AcpClient(config, child, connection, router, initializeResult);
    } catch (error) {
      // A handshake can time out 30s in, by which point the adapter has long
      // since spawned its own child. Going straight to SIGKILL here is exactly
      // how that grandchild gets orphaned, so give the group a chance to unwind.
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

  registerSession(sessionId: string, handlers: SessionHandlers): () => void {
    this.router.sessions.set(sessionId, handlers);
    return () => this.router.sessions.delete(sessionId);
  }

  onLog(listener: LogListener): () => void {
    this.router.logListeners.add(listener);
    return () => this.router.logListeners.delete(listener);
  }

  /** Every `session/update`, unnormalized. See `NotificationListener`. */
  onNotification(listener: NotificationListener): () => void {
    this.router.notificationListeners.add(listener);
    return () => this.router.notificationListeners.delete(listener);
  }

  /** The agent's last stderr lines — the useful half of most failures. */
  recentLogs(): string[] {
    return [...this.router.recentStderr];
  }

  /**
   * How to signal this agent, and how to recognise it after a restart.
   *
   * A handle rather than a pid: a container's process group lives in a different
   * number space from this host's, and the two must not be stored in one column
   * as if they meant the same thing.
   */
  get handle(): AgentHandle | null {
    return this.child.handle;
  }

  supportsSessionClose(): boolean {
    return this.initializeResult.agentCapabilities?.sessionCapabilities?.close != null;
  }

  /**
   * Whether the agent can pick up one of its own earlier sessions.
   *
   * Deliberately `session/resume` and not `session/load`: load replays the whole
   * message history back as `session/update` notifications, and we already hold
   * that transcript on disk — taking it again would duplicate every event we have.
   * Resume restores the context and says nothing.
   *
   * All three agents advertise this today (kimi 0.29.2, claude-agent-acp 0.63.0
   * and codex-acp 1.1.9), but the capability is checked rather than assumed,
   * because answering a resume request by silently doubling the transcript would
   * be worse than refusing it.
   *
   * **Advertising it and doing it are different claims, and codex was measured on
   * the second one** — a grep for `session/resume` in a bundle proves nothing, as
   * kimi's `usage_update` demonstrates by appearing exactly once, in a schema it
   * parses and never sends. Measured 2026-08-07 through the daemon: a codex
   * session was auto-resumed across a restart and then answered a question about a
   * command it had run in the previous process.
   */
  supportsSessionResume(): boolean {
    return this.initializeResult.agentCapabilities?.sessionCapabilities?.resume != null;
  }

  /**
   * Whether this agent will take an `image` content block in a prompt.
   *
   * **`=== true`, not `!= null`, and getting that backwards is silent.** The two
   * capability shapes sit in the same payload and are read two different ways on
   * purpose: `sessionCapabilities.resume` above is an empty-object *marker* whose
   * presence is the whole answer, while `promptCapabilities.image` is a declared
   * `boolean` — so `!= null` here would read `{image: false}` as yes and send an
   * agent bytes it said it cannot take.
   *
   * Only `image` is exposed. `embeddedContext` would allow `resource` blocks and
   * nothing here has measured what either agent does with one; an accessor
   * handing back the raw object is how that gets tried on a hunch. Everything
   * else about attachments needs no capability at all — ACP requires every agent
   * to support `resource_link`, which is what lets the composer offer a paperclip
   * unconditionally.
   */
  acceptsImages(): boolean {
    return this.initializeResult.agentCapabilities?.promptCapabilities?.image === true;
  }

  /**
   * Shuts the agent down without leaving an orphan.
   *
   * Closing stdin is the graceful path — both adapters treat EOF as "connection
   * over, exit". SIGTERM then SIGKILL are the fallbacks.
   */
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

/**
 * The longest run of bytes an agent may write to stderr without a newline.
 *
 * ⚠ **The accumulator below had no ceiling.** `buffer += chunk` grew until a
 * `\n` arrived, and an agent that writes megabytes on one line — a stack trace
 * with no breaks, a progress bar redrawing with `\r`, a JSON blob — grew a
 * string inside this daemon with nothing to stop it. Every bound downstream is
 * on the *event*: `agent_log` is charged and truncated properly, and none of
 * that runs until a line exists to make an event out of.
 *
 * 64 KiB is generous for a real log line by three orders of magnitude, and the
 * flush keeps what arrived rather than discarding it — a line this long is
 * usually the interesting one.
 */
const MAX_STDERR_LINE_CHARS = 64 * 1024;

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
    // No newline in sight and the buffer is past the ceiling: emit what there is
    // as a line of its own and start again. Bounded here rather than left to the
    // event layer, which never sees a byte until a line is complete.
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
