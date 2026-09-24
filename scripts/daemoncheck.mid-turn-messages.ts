import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore, type SessionEvent, type StoredEvent } from "../src/events.js";
import { MAX_QUEUED_PROMPTS, SessionRegistry, stoppedBeforeDelivery } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { users, now, tokenFor, verifier, credentials, stubAgentConfig } from "./daemoncheck.fixtures.js";

// Two stubs: steering advertises the extension and answers injected; plain advertises nothing and answers -32601.
process.stdout.write("\na message sent while the agent is working\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  /** Every `_session/steering` this daemon sent, in order, as its text. */
  const steersSeen: string[] = [];
  /** Every `session/prompt` this daemon sent, in order, as its text. */
  const promptsSeen: string[] = [];
  /** The `_meta` on every steer, so the opt-in is checked rather than assumed. */
  const steerMeta: string[] = [];
  /** The agent session each prompt was addressed to, so a prompt sent to the conversation a clear abandoned is visible. */
  const promptSessions: string[] = [];

  interface StubOptions {
    /** true advertises support, false sends no _meta, declined sends supported false: only the last reaches supportsSteering's decision. */
    readonly advertises: boolean | "declined";
    /** What the steer answers: an outcome, or null to refuse with -32601. */
    readonly answers: "injected" | "startedNewTurn" | "promptRequired" | null;
    /** End the turn as the steer arrives, so pump's finally drains an empty queue before the entry is pushed. */
    readonly endsTurnOnSteer?: boolean;
    /** Hold the steer open until released: the window where a stop, a restart or another send lands inside sendMidTurn. */
    readonly holdsSteer?: boolean;
    /** Do not end the turn on cancel, which holds cancelRequestedAt open with a turn still running. */
    readonly holdsCancel?: boolean;

  }

  /** Refuses exactly one prompt append: the only way to reach safeAppend's null and a seq of 0. */
  class RefusingStore extends MemoryEventStore {
    refuseNextPrompt = false;
    override append(sessionId: string, event: SessionEvent): StoredEvent {
      if (this.refuseNextPrompt && event.type === "prompt") {
        this.refuseNextPrompt = false;
        throw new Error("the store refused this append");
      }
      return super.append(sessionId, event);
    }
  }

  const standUp = async (options: StubOptions, warnings?: string[]) => {
    const resumeRefused = { on: false };
    let lastAgent: {
      toClient: PassThrough;
      held: () => unknown;
      clear: () => void;
      steers: () => (() => void)[];
    } | null = null;

    const spawn = (): AgentProcess => {
      // Renamed on each session/new, so a clear yields a conversation distinguishable from the one it replaced.
      let sessionId = "s_midturn_1";
      let conversations = 0;
      const toAgent = new PassThrough();
      const toClient = new PassThrough();
      const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);
      let heldPromptId: unknown = null;
      const heldSteers: (() => void)[] = [];

      let buffer = "";
      toAgent.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim().length === 0) continue;
          const message = JSON.parse(line) as Record<string, any>;
          const id = message["id"];
          const textOf = (params: any): string =>
            (params?.["prompt"] ?? [])
              .filter((block: any) => block?.type === "text")
              .map((block: any) => block.text)
              .join("");

          switch (message["method"]) {
            case acp.methods.agent.initialize:
              send({
                jsonrpc: "2.0",
                id,
                result: {
                  protocolVersion: acp.PROTOCOL_VERSION,
                  // resume, because a block below drives a real restart and Session.resume refuses without it.
                  agentCapabilities: { sessionCapabilities: { resume: {} } },
                  authMethods: [],
                  ...(options.advertises === false
                    ? {}
                    : { _meta: { steering: { supported: options.advertises === true } } }),
                },
              });
              break;
            case acp.methods.agent.session.cancel: {
              // Cancel is a notification: without this arm it is discarded and the held turn never ends.
              const ending = options.holdsCancel === true ? null : heldPromptId;
              if (ending !== null) {
                heldPromptId = null;
                send({ jsonrpc: "2.0", id: ending, result: { stopReason: "cancelled" } });
              }
              break;
            }
            case acp.methods.agent.session.new:
              conversations += 1;
              if (conversations > 1) sessionId = `s_midturn_${conversations}`;
              send({ jsonrpc: "2.0", id, result: { sessionId } });
              break;
            case acp.methods.agent.session.resume:
              // A resume the test can make fail, so a queue stranded by an unrecoverable restart is reachable.
              if (resumeRefused.on) {
                send({ jsonrpc: "2.0", id, error: { code: -32000, message: "cannot resume" } });
                break;
              }
              send({ jsonrpc: "2.0", id, result: { sessionId } });
              break;
            case acp.methods.agent.session.prompt:
              promptsSeen.push(textOf(message["params"]));
              promptSessions.push(String(message["params"]?.["sessionId"] ?? ""));
              heldPromptId = id;
              break;
            case "_session/steering": {
              steersSeen.push(textOf(message["params"]));
              // The opt-in is recorded here, the only place that can see it.
              steerMeta.push(JSON.stringify(message["params"]?.["_meta"] ?? null));
              const answerSteer = () => {
                if (options.answers === null) {
                  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
                } else {
                  send({ jsonrpc: "2.0", id, result: { outcome: options.answers } });
                }
              };
              if (options.holdsSteer === true) {
                heldSteers.push(answerSteer);
                break;
              }
              if (options.endsTurnOnSteer === true && heldPromptId !== null) {
                const ending = heldPromptId;
                heldPromptId = null;
                send({ jsonrpc: "2.0", id: ending, result: { stopReason: "end_turn" } });
                // Deferred so pump's finally runs strictly first, the ordering a slow agent produces.
                setTimeout(answerSteer, 20);
              } else {
                answerSteer();
              }
              break;
            }
            default:
              if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
          }
        }
      });

      lastAgent = {
        toClient,
        held: () => heldPromptId,
        clear: () => {
          heldPromptId = null;
        },
        steers: () => heldSteers,
      };

      return {
        stdin: toAgent,
        stdout: toClient,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent.end(),
        kill: async () => {},
      };
    };

    class MidTurnRuntime extends LocalRuntime {
      override async availability(): Promise<AgentAvailability[]> {
        return [
          { id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null },
        ];
      }
      override describe(agent: AgentId): AgentLaunchConfig {
        return stubAgentConfig(agent);
      }
      override async launch(): Promise<AgentProcess> {
        return spawn();
      }
    }

    const events = new RefusingStore();
    const registry = new SessionRegistry(
      events,
      null,
      undefined,
      new MidTurnRuntime(),
      null,
      // An adapter that ignores the steering opt-in and starts its own turn is reported here and nowhere else.
      (detail: string) => warnings?.push(detail),
    );
    const { app } = createApp({
      registry,
      verifier,
      instanceId: "i_midturn",
      startedAt: now,
      credentials,
      roots: [users],
    });
    const managed = await registry.create({ agent: "kimi", cwd: tmp("midturn-") });
    return {
      registry,
      app,
      managed,
      /** Make the next `prompt` append fail, so the next message carries `seq === 0`. */
      events,
      /** Make every later `session/resume` fail, as a broken agent's would. */
      refuseResume: () => {
        resumeRefused.on = true;
      },
      /** Answer every steer this stub is sitting on. */
      releaseSteers: () => {
        const pending = lastAgent?.steers() ?? [];
        while (pending.length > 0) pending.shift()?.();
      },
      /** Reject the held turn as an expired credential, driving the restart path after the queue has been filled. */
      failTurnAuth: () => {
        const agent = lastAgent;
        if (agent === null) return;
        const id = agent.held();
        if (id === null) return;
        agent.clear();
        agent.toClient.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: "Failed to authenticate: OAuth session expired",
              data: { errorKind: "authentication_failed" },
            },
          })}\n`,
        );
      },
      /** End the turn the stub is holding, as a real agent's `turn_end` would. */
      finishTurn: () => {
        const agent = lastAgent;
        if (agent === null) return;
        const id = agent.held();
        if (id === null) return;
        agent.clear();
        agent.toClient.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })}\n`);
      },
    };
  };

  const quiesce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

  const post = async (
    app: { fetch: (r: Request) => Promise<Response> | Response },
    id: string,
    text: string,
  ) => {
    const response = await app.fetch(
      new Request(`http://d/sessions/${id}/prompt`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }),
    );
    const raw = await response.text();
    return { status: response.status, body: raw.length === 0 ? null : (JSON.parse(raw) as any) };
  };

  const cancelTurn = async (
    app: { fetch: (r: Request) => Promise<Response> | Response },
    id: string,
  ) => {
    const response = await app.fetch(
      new Request(`http://d/sessions/${id}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    const raw = await response.text();
    return { status: response.status, body: raw.length === 0 ? null : (JSON.parse(raw) as any) };
  };

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: true, answers: "injected" });
    const eventsOf = (type: string) =>
      managed.log
        .read(0, 1000, 1 << 20)
        .map((stored) => stored.event)
        .filter((event) => event.type === type);

    check("the daemon reads the capability off `initialize`", managed.snapshot().midTurnDelivery, "steer");

    const first = await post(app, managed.id, "start the long thing");
    await quiesce();
    check("an ordinary first message is accepted", [first.status, first.body?.accepted], [202, true]);
    check("and a turn is running", managed.status, "running");

    // Both halves: a 202 with nothing on the wire swallowed the message, and a steer under a 409 sent it and said no.
    const second = await post(app, managed.id, "actually, do it the other way");
    check("a message sent mid-turn is taken rather than refused", second.status, 202);
    check("and says which way it got there", [second.body?.accepted, second.body?.steered], [true, true]);
    check("naming the turn it went into", second.body?.turn, 1);
    check("the agent really was sent it", steersSeen, ["actually, do it the other way"]);
    // Without the opt-in a steer that finds no turn starts one, with no session/prompt to resolve and no turn_end to see.
    check("carrying the opt-in that stops a steer starting a turn of its own", steerMeta, [
      JSON.stringify({ steering: { idleBehavior: "promptRequired" } }),
    ]);
    check("and it was not sent as a second prompt", promptsSeen, ["start the long thing"]);

    // An injection is not a second turn: the original session/prompt resolves exactly once.
    check("no second turn was started for it", managed.snapshot().turn, 1);
    check("and nothing is waiting, because nothing had to", managed.snapshot().queuedPrompts, []);

    // A prompt event is written when the daemon accepts a message, however it is delivered.
    check(
      "both messages are in the conversation, in the order they were sent",
      eventsOf("prompt").map((event) => (event.type === "prompt" ? event.text : null)),
      ["start the long thing", "actually, do it the other way"],
    );
    // The message's own seq, which settles the client's echo; read off the log because other rows share the sequence.
    check(
      "and the answer names the seq of the message, which is what settles the echo",
      second.body?.seq,
      managed.log
        .read(0, 1000, 1 << 20)
        .filter((stored) => stored.event.type === "prompt")
        .at(-1)?.seq,
    );

    finishTurn();
    await quiesce();
    check("the turn ends once, for the one prompt that started it", eventsOf("turn_end").length, 1);
    check("and the session is idle rather than owing anybody anything", managed.status, "idle");
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: false, answers: null });
    const eventsOf = (type: string) =>
      managed.log
        .read(0, 1000, 1 << 20)
        .map((stored) => stored.event)
        .filter((event) => event.type === type);

    check("this one says it cannot be steered", managed.snapshot().midTurnDelivery, "queue");

    await post(app, managed.id, "start the long thing");
    await quiesce();
    check("a turn is running", managed.status, "running");

    const queued = await post(app, managed.id, "and then tidy up");
    check("the message is still taken", queued.status, 202);
    check("and says it is waiting", [queued.body?.accepted, queued.body?.queued], [true, true]);
    check("with nothing ahead of it", queued.body?.position, 0);
    // An agent that never advertised the extension is not asked.
    check("the agent was not asked to steer it", steersSeen, []);
    check("nor sent it as a second prompt", promptsSeen, ["start the long thing"]);

    check("it is on the snapshot, where a client can see it", managed.snapshot().queuedPrompts.length, 1);
    check(
      "naming the seq of the message it is about",
      managed.snapshot().queuedPrompts[0]?.seq,
      queued.body?.seq,
    );
    // Asserted on the keys: the snapshot entry must carry neither the text nor the uploads.
    check(
      "and carrying nothing else — not the text, not the uploads",
      Object.keys(managed.snapshot().queuedPrompts[0] ?? {}).sort(),
      ["at", "id", "seq"],
    );
    check(
      "and it is already a row in the conversation",
      eventsOf("prompt").map((event) => (event.type === "prompt" ? event.text : null)),
      ["start the long thing", "and then tidy up"],
    );

    // Refused here on status, not on the queue clause, which is unreachable while the turn runs.
    check("a session with something waiting is not one a ceiling may take", managed.parkable(Date.now(), 0), false);

    finishTurn();
    await quiesce();

    check("the queued message reaches the agent when the turn ends", promptsSeen, [
      "start the long thing",
      "and then tidy up",
    ]);
    check("and stops waiting", managed.snapshot().queuedPrompts, []);
    // Written at accept, so delivery must add no second prompt event.
    check("with no second copy of it in the conversation", eventsOf("prompt").length, 2);
    check("and a turn of its own", managed.snapshot().turn, 2);
    // Asserted as a pair so the two causes of refusal cannot be confused.
    check(
      "which is what refuses the ceiling now, the queue having stood down",
      [managed.status, managed.snapshot().queuedPrompts.length, managed.parkable(Date.now(), 0)],
      ["running", 0, false],
    );

    finishTurn();
    await quiesce();
    check("and once that turn ends too, nothing is owed and it may be parked", managed.parkable(Date.now(), 0), true);
    // Delivered once. A drain that re-read a shifted entry would show up here as
    // a third prompt on the wire and nowhere else.
    check("the queue delivered it exactly once", promptsSeen.length, 2);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: true, answers: null });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    const answered = await post(app, managed.id, "a correction");
    // An agent may advertise steering and still answer -32601; the queue covers that without losing the message.
    check("a steer the agent refuses falls back to the queue", [answered.status, answered.body?.queued], [202, true]);
    check("having genuinely tried first", steersSeen, ["a correction"]);
    finishTurn();
    await quiesce();
    check("and it is delivered like any other queued message", promptsSeen, [
      "start the long thing",
      "a correction",
    ]);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, failTurnAuth } = await standUp({ advertises: false, answers: null });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    const queued = await post(app, managed.id, "and then tidy up");
    check("the message is taken while the agent is working", queued.body?.queued, true);

    failTurnAuth();
    await quiesce();

    // A restart is a process boundary, not the end of the session: the queue must survive a stop for config_changed.
    await managed.whenRestarted();
    await quiesce();

    check("the session came back rather than ending", managed.terminal, false);
    check(
      "and it never claimed to have stopped",
      managed.log
        .read(0, 1000, 1 << 20)
        .map((stored) => stored.event)
        .filter((event) => event.type === "error" && /session stopped/.test(event.message)).length,
      0,
    );
    check("the queued message survived the new agent", promptsSeen.includes("and then tidy up"), true);
    check("and nothing is left waiting", managed.snapshot().queuedPrompts, []);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed } = await standUp({ advertises: true, answers: null, endsTurnOnSteer: true });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    const raced = await post(app, managed.id, "a correction");
    await quiesce();

    // The turn ends inside the steer, so without the drain at the foot of sendMidTurn the entry waits for a turn nobody starts.
    check("the message is still taken", [raced.status, raced.body?.accepted], [202, true]);
    check("and it actually reaches the agent rather than stranding", promptsSeen, [
      "start the long thing",
      "a correction",
    ]);
    check("with nothing left waiting", managed.snapshot().queuedPrompts, []);
    check("and it was tried as a steer first", steersSeen, ["a correction"]);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, releaseSteers } = await standUp({
      advertises: true,
      answers: null,
      holdsSteer: true,
    });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    const pending = post(app, managed.id, "a correction");
    await quiesce();

    // A stop landing inside sendMidTurn's awaits must not answer queued for a terminal session (Q2.218).
    await managed.stop();
    releaseSteers();
    const answer = await pending;

    check("a stop that lands inside the steer is reported as one", answer.status, 409);
    check("naming the session rather than the queue", answer.body?.error?.code, "session_terminal");
    check("nothing is left riding the snapshot of a dead session", managed.snapshot().queuedPrompts, []);
    // The accepted message is already in the log, so the daemon owes a line saying it will not be delivered.
    check(
      "and the message it had already accepted says it never arrived",
      managed.log
        .read(0, 1000, 1 << 20)
        .map((stored) => stored.event)
        .filter((event) => event.type === "error" && /never reached|reached the agent/.test(event.message))
        .length,
      1,
    );
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: false, answers: null });
    void finishTurn;

    await post(app, managed.id, "start the long thing");
    await quiesce();
    await post(app, managed.id, "actually do this instead");
    await quiesce();

    // A cancel ends the turn and the queue then delivers, by decision: a queued message cannot be taken back.
    const cancelled = await cancelTurn(app, managed.id);
    check("the cancel is a 200 that names the turn it stopped", [cancelled.status, cancelled.body?.cancelled], [200, true]);
    await quiesce();
    check("and what was waiting is what the agent gets next", promptsSeen, [
      "start the long thing",
      "actually do this instead",
    ]);
    check("with nothing left waiting", managed.snapshot().queuedPrompts, []);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed } = await standUp({
      advertises: true,
      answers: "promptRequired",
      // The turn really has to be gone, or this asserts the other arm.
      endsTurnOnSteer: true,
    });
    await post(app, managed.id, "start the long thing");
    await quiesce();
    const answered = await post(app, managed.id, "a correction");
    await quiesce();
    // promptRequired after the turn ended means nothing was delivered, so the message gets an ordinary turn of its own.
    check("a steer that finds no turn is not treated as delivered", answered.status, 202);
    check("the message is sent as an ordinary prompt instead", promptsSeen, [
      "start the long thing",
      "a correction",
    ]);
    // The body, because a queued answer is a 202 too: turn against queued is what separates the two.
    check(
      "and it is armed as a turn of its own rather than queued behind one",
      [answered.body?.queued, answered.body?.turn],
      [undefined, 2],
    );
    check("and nothing is left waiting", managed.snapshot().queuedPrompts, []);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: true, answers: "promptRequired" });
    await post(app, managed.id, "start the long thing");
    await quiesce();
    const answered = await post(app, managed.id, "a correction");
    // The same answer while this daemon still holds a turn must queue: arming would start a second turn.
    check("a promptRequired against a turn we still hold is queued, not armed", answered.body?.queued, true);
    check("nothing was sent as a second prompt", promptsSeen, ["start the long thing"]);
    finishTurn();
    await quiesce();
    check("and it goes when that turn really ends", promptsSeen, ["start the long thing", "a correction"]);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const warnings: string[] = [];
    const { app, managed } = await standUp({ advertises: true, answers: "startedNewTurn" }, warnings);
    await post(app, managed.id, "start the long thing");
    await quiesce();
    const answered = await post(app, managed.id, "a correction");
    // Kept because an adapter may ignore the opt-in: the agent has the message, so re-sending would double it, and no turn_end will come.
    check("the message is treated as delivered rather than sent twice", answered.body?.steered, true);
    check("and it was not sent as a second prompt", promptsSeen, ["start the long thing"]);
    check(
      "the daemon says out loud that it cannot see that turn end",
      warnings.filter((line) => /cannot see end/.test(line)).length,
      1,
    );
    check("with nothing queued behind it", managed.snapshot().queuedPrompts, []);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, releaseSteers } = await standUp({
      advertises: true,
      answers: null,
      holdsSteer: true,
    });
    await post(app, managed.id, "start the long thing");
    await quiesce();

    // On a steerable agent the push is two awaits after the check, so concurrent sends released together must still meet the bound.
    const overshoot = MAX_QUEUED_PROMPTS + 3;
    const inFlight = Array.from({ length: overshoot }, (_unused, i) => post(app, managed.id, `concurrent ${i}`));
    await quiesce();
    releaseSteers();
    const answers = await Promise.all(inFlight);

    check("the queue is at its bound and not past it", managed.snapshot().queuedPrompts.length, MAX_QUEUED_PROMPTS);
    check(
      "and the ones that did not fit were refused rather than dropped in silence",
      answers.filter((a) => a.body?.error?.code === "prompt_queue_full").length,
      overshoot - MAX_QUEUED_PROMPTS,
    );
    // The slot is reserved before anything is written, so a refused send leaves no prompt and owes no error (Q2.218).
    const written = managed.log.read(0, 1000, 1 << 20).map((stored) => stored.event);
    check(
      "the refused ones wrote nothing into the conversation to have to explain",
      written.filter((event) => event.type === "error" && /already waiting/.test(event.message)).length,
      0,
    );
    check(
      "and left no prompt behind either, which is what makes that silence right",
      written.filter((event) => event.type === "prompt").length,
      1 + MAX_QUEUED_PROMPTS,
    );
  }

  // A plugin's sessions.prompt still answers busy mid-turn: a steered plugin message would spend the current turn's end.
  {
    const api = readFileSync(new URL("../src/plugins/api.ts", import.meta.url), "utf8");
    check(
      "a plugin's mid-turn prompt is still reported as `busy`",
      /result\.kind === "turn_in_flight" \? "busy" : result\.kind/.test(api),
      true,
    );
    check(
      "and the code is built from that, not from the raw kind",
      /`session_\$\{kind\}`/.test(api),
      true,
    );
  }

  // The queue is ordered by acceptance, never by log seq: an unrecorded message carries seq 0.
  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, events, finishTurn } = await standUp({ advertises: false, answers: null });
    await post(app, managed.id, "start the long thing");
    await quiesce();

    await post(app, managed.id, "first, and recorded");
    events.refuseNextPrompt = true;
    await post(app, managed.id, "second, and the store refuses it");
    await quiesce();

    const waiting = managed.snapshot().queuedPrompts;
    check("both messages are waiting", waiting.length, 2);
    check(
      "the one the log could not record carries the seq that says so",
      waiting.map((entry) => entry.seq > 0),
      [true, false],
    );
    check(
      "and it is behind the message taken before it, not in front of it",
      waiting.map((entry) => entry.id),
      ["q_1", "q_2"],
    );
    finishTurn();
    await quiesce();
    check(
      "so the agent is handed them in the order they were taken",
      promptsSeen.slice(1),
      ["first, and recorded"],
    );
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed } = await standUp({ advertises: false, answers: null });
    await post(app, managed.id, "start the long thing");
    await quiesce();

    for (let i = 0; i < MAX_QUEUED_PROMPTS; i += 1) await post(app, managed.id, `queued ${i}`);
    check("the queue fills to its bound", managed.snapshot().queuedPrompts.length, MAX_QUEUED_PROMPTS);

    const over = await post(app, managed.id, "one too many");
    // 429, not 409: a ceiling, checked before the append so a refused message leaves no prompt event (Q2.218).
    check("and refuses past it", [over.status, over.body?.error?.code], [429, "prompt_queue_full"]);
    check("naming the limit rather than making the caller guess", over.body?.error?.detail?.limit, MAX_QUEUED_PROMPTS);
    check(
      "with nothing written for the message it refused",
      managed.log
        .read(0, 1000, 1 << 20)
        .map((stored) => stored.event)
        .filter((event) => event.type === "prompt").length,
      MAX_QUEUED_PROMPTS + 1,
    );

    await managed.stop();
    // A stop drops the queue and writes one line saying so, not one per message (Q2.218).
    check("stopping drops what was waiting", managed.snapshot().queuedPrompts, []);
    const errors = managed.log
      .read(0, 1000, 1 << 20)
      .map((stored) => stored.event)
      .filter((event) => event.type === "error");
    check("and writes one line saying they never arrived", errors.length, 1);
    check(
      "counting them rather than naming one",
      errors[0]?.type === "error" ? errors[0].message : null,
      `the session stopped before ${MAX_QUEUED_PROMPTS} messages reached the agent`,
    );
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: "declined", answers: "injected" });

    // The stub answers injected, so a misread decline would visibly steer.
    check("an agent that declines by name is not one this daemon steers", managed.snapshot().midTurnDelivery, "queue");
    await post(app, managed.id, "start the long thing");
    await quiesce();
    const answered = await post(app, managed.id, "a correction");
    await quiesce();
    check("so the message waits instead", answered.body?.queued, true);
    check("and no steer was even attempted", steersSeen, []);
    finishTurn();
    await quiesce();
    check("it is delivered when the turn ends", promptsSeen, ["start the long thing", "a correction"]);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    promptSessions.length = 0;
    const { app, managed, finishTurn, releaseSteers } = await standUp({
      advertises: true,
      answers: "promptRequired",
      holdsSteer: true,
    });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    const pending = post(app, managed.id, "a correction");
    await quiesce();

    // The prompt_required arm must re-check clearing after the steer: a clear can start once the turn has ended.
    finishTurn();
    await quiesce();
    const clearing = managed.clearContext("/clear");
    releaseSteers();
    const answer = await pending;
    await clearing;
    await quiesce();

    check("a clear starting inside the steer does not have a turn armed under it", answer.body?.accepted, true);
    check("the message waits for the fresh conversation rather than being pumped", answer.body?.queued, true);
    check(
      "and when it is delivered it goes to the conversation that exists, never the one the clear replaced",
      promptSessions,
      ["s_midturn_1", "s_midturn_2"],
    );
    check("with the message itself intact", promptsSeen, ["start the long thing", "a correction"]);
    check("and nothing left waiting", managed.snapshot().queuedPrompts, []);
  }

  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, failTurnAuth, refuseResume } = await standUp({ advertises: false, answers: null });

    await post(app, managed.id, "start the long thing");
    await quiesce();
    await post(app, managed.id, "and then tidy up");
    await quiesce();
    check("the message is waiting", managed.snapshot().queuedPrompts.length, 1);

    // A failed restart leaves the kept queue no home, so it must be dropped with a line saying so.
    refuseResume();
    failTurnAuth();
    await quiesce();
    await quiesce();
    await quiesce();

    check("a restart that could not come back leaves nothing waiting", managed.snapshot().queuedPrompts, []);
    const stranded = managed.log
      .read(0, 1000, 1 << 20)
      .map((stored) => stored.event)
      .filter((event) => event.type === "error" && event.message === stoppedBeforeDelivery(1));
    check("and says the message never arrived, rather than going quiet", stranded.length, 1);
    check("the agent was never given it", promptsSeen, ["start the long thing"]);
  }

  // Over a pending cancel the message is queued, not steered into a turn being torn down (Q2.218).
  {
    steersSeen.length = 0;
    promptsSeen.length = 0;
    const { app, managed, finishTurn } = await standUp({ advertises: true, answers: "injected", holdsCancel: true });
    check("this agent really can be steered", managed.snapshot().midTurnDelivery, "steer");

    const first = await post(app, managed.id, "start the long thing");
    await quiesce();
    check("a turn is running", [first.status, managed.status], [202, "running"]);

    // Not awaited: `cancelTurn` resolves only once the turn has ended, and the
    // window this is about is the one *inside* it.
    const cancelling = cancelTurn(app, managed.id);
    await quiesce();

    const during = await post(app, managed.id, "actually, stop and do this instead");
    check("a message typed over a pending cancel is still taken", during.status, 202);
    check(
      "but it is queued rather than steered into a turn being torn down",
      [during.body?.queued === true, during.body?.steered === true, managed.snapshot().queuedPrompts.length],
      [true, false, 1],
    );
    check("so the agent was never asked to steer it", steersSeen, []);

    finishTurn();
    await cancelling;
    await quiesce();
    await quiesce();

    check(
      "and the message is delivered rather than dropped with the cancelled turn",
      promptsSeen,
      ["start the long thing", "actually, stop and do this instead"],
    );
    check("with nothing left waiting", managed.snapshot().queuedPrompts, []);
  }
}
