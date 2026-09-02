import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore, endedWithDaemon } from "../src/events.js";
import {
  SessionRegistry,
  autoResumable,
  ULTRACODE_CHOICE,
  ultracodeOptionId,
  withUltracode,
} from "../src/registry.js";
import { sessionMetaFor } from "../src/acp/agents.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { now, tokenFor, verifier, credentials, stubAgentConfig } from "./daemoncheck.fixtures.js";

/* ------------------------------------------------------------------ *
 * The one control that is not the agent's
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat the agent says after its turn has ended\n");
{
  /*
   * ⭐ **A conversation stopped dead while the agent went on working, and then a
   * message produced five minutes of dialog that had nothing to do with it.**
   *
   * `session/prompt` resolves while claude drives work it has spawned. The
   * generator in `Session.prompt` returns on `turn_end`, and everything the agent
   * emitted after that went into an `EventQueue` whose only consumer had gone —
   * held until the *next* prompt started a new generator, which drained the whole
   * backlog in one microtask cascade. Measured on a live log: `turn_end` at seq
   * 835, then 294,907 ms of silence, then a `prompt` at seq 836 followed by 57
   * events all stamped inside a **2 ms** span, whose content was the agent saying
   * "waiting on the reviewers" over and over. Past `MAX_BUFFERED_EVENTS` it was not
   * held at all — the head was shifted and replaced by an error placeholder.
   *
   * The agent below is that behaviour reduced: it answers `session/prompt` at once
   * and keeps talking afterwards, on demand.
   */
  const acp = await import("@agentclientprotocol/sdk");
  /** Pushed by the test between turns; each entry becomes one `session/update`. */
  const hook: {
    emit: (update: Record<string, unknown>) => void;
    stderr: (line: string) => void;
  } = { emit: () => {}, stderr: () => {} };

  const spawnTalkative = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const stderr = new PassThrough();
    hook.stderr = (line) => void stderr.write(`${line}\n`);
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    let sessionId = "conv_1";
    hook.emit = (update) => send({
      jsonrpc: "2.0",
      method: acp.methods.client.session.update,
      params: { sessionId, update },
    });
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        const params = (message["params"] ?? {}) as Record<string, any>;
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { resume: {} } },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new:
            sessionId = params["sessionId"] === undefined ? sessionId : String(params["sessionId"]);
            send({ jsonrpc: "2.0", id, result: { sessionId, modes: null, configOptions: [] } });
            break;
          case acp.methods.agent.session.prompt:
            // Answered at once, which is the whole premise: the turn is over and
            // the agent is not.
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr,
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class TalkativeRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnTalkative();
    }
  }

  const store = new MemoryEventStore();
  const talkRegistry = new SessionRegistry(store, null, undefined, new TalkativeRuntime());
  const talkDir = tmp("draincheck-");
  const managed = await talkRegistry.create({ agent: "kimi", cwd: talkDir });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
  const say = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const texts = (): string[] =>
    managed.log
      .read(0, 10_000, 4 * 1024 * 1024)
      .filter((stored) => stored.event.type === "text")
      .map((stored) => (stored.event as unknown as { text: string }).text);

  managed.prompt("go");
  await settle();
  check("the turn ends by itself", managed.status, "idle");

  /*
   * The bug, exactly: the agent talks with no turn in flight. Before the drain
   * these three landed nowhere until somebody sent another message.
   */
  hook.emit(say("still working on it"));
  hook.emit(say("nearly there"));
  await settle();
  check(
    "what the agent says after the turn is recorded without a second prompt",
    texts(),
    ["still working on it", "nearly there"],
  );
  check("and the session is still idle, because the turn really did end", managed.status, "idle");

  /*
   * Order is arrival order, and it is checked over a burst large enough that the
   * old code would not merely have delayed it — `MAX_BUFFERED_EVENTS` is 2000, and
   * past that the head was shifted out and replaced by an error placeholder, so
   * this is the half of the bug that lost content rather than postponing it.
   */
  for (let index = 0; index < 2_500; index += 1) hook.emit(say(`burst ${index}`));
  await settle();
  const burst = texts().slice(2);
  check("a burst past the queue's own bound loses nothing", burst.length, 2_500);
  check("and arrives in the order it was sent", [burst[0], burst[2_499]], ["burst 0", "burst 2499"]);

  /*
   * ⚠ **`agent_log` and `other` are dropped out of turn, and that is today's
   * behaviour preserved rather than a new loss.** They were exactly what the queue
   * evicted first, which is why a count over five of this fleet's database
   * snapshots — 95,618 events — holds zero `agent_log` rows. Recording them now
   * would put an unbounded stderr stream into a log that is deliberately
   * unbounded, and spend the tab's 16 MiB ceiling and `ATTACH_REPLAY_MAX`, both of
   * which evict from the oldest, on machinery nothing draws.
   */
  const before = managed.log.read(0, 10_000, 4 * 1024 * 1024).length;
  // An `other` (an update shape nothing here models) and an `agent_log` (a line on
  // the agent's stderr) — the exact two the queue evicted first.
  hook.emit({ sessionUpdate: "session_info_update", info: { title: "ignored" } });
  hook.stderr("[debug] a line nothing draws");
  await settle();
  check("machinery nobody draws is not recorded out of turn", managed.log.read(0, 10_000, 4 * 1024 * 1024).length, before);

  // And the next turn still works, which is what proves the hand-back: the drain
  // holds the queue right up to the moment `prompt` claims it.
  managed.prompt("again");
  await settle();
  hook.emit(say("after the second turn"));
  await settle();
  check("a later turn takes the queue back and gives it back again", texts().at(-1), "after the second turn");

  await talkRegistry.shutdown();
}

process.stdout.write("\nwho owns a session's events\n");
{
  /*
   * The handover itself, driven through `Session.prompt` rather than asserted on
   * the queue — `EventQueue` is module-private, and the property that matters is
   * the one a caller can observe: two turns cannot both be consuming.
   *
   * ⚠ The release is identity-checked, and that is the load-bearing half. A stale
   * release clearing the turn's hold would route a live turn's events to a drain,
   * park its generator for ever and pin `ManagedSession.turn` — `409
   * turn_in_flight` for the rest of the session's life, with nothing running.
   */
  const acp = await import("@agentclientprotocol/sdk");
  const hook: { emit: (update: Record<string, unknown>) => void; answer: () => void } = {
    emit: () => {},
    answer: () => {},
  };

  const spawnHeld = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    hook.emit = (update) => send({
      jsonrpc: "2.0",
      method: acp.methods.client.session.update,
      params: { sessionId: "conv_1", update },
    });
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { resume: {} } },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new:
            send({ jsonrpc: "2.0", id, result: { sessionId: "conv_1", modes: null, configOptions: [] } });
            break;
          case acp.methods.agent.session.prompt:
            // Held open until the test says so, so the turn is genuinely in flight
            // while events are emitted at it.
            hook.answer = () => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
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
    } as unknown as AgentProcess;
  };

  class HeldRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnHeld();
    }
  }

  const heldRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new HeldRuntime());
  const heldDir = tmp("owncheck-");
  const managed = await heldRegistry.create({ agent: "kimi", cwd: heldDir });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
  const say = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const texts = (): string[] =>
    managed.log
      .read(0, 10_000, 4 * 1024 * 1024)
      .filter((stored) => stored.event.type === "text")
      .map((stored) => (stored.event as unknown as { text: string }).text);

  /*
   * ⚠ **`session_started` has moved, and this is where that is written down.**
   *
   * It is pushed by `Session.adopt`, i.e. before `onStarted` runs — and until there
   * was a drain, nothing read the queue until the first prompt, so it landed in the
   * log *after* that prompt's own event. Every version of this daemon's notes says
   * so, and it is why the registry appends its own `status` row at seq 1. It now
   * lands where it happens. Nothing draws it (`TRANSCRIPT_SILENT`), so this is a
   * fact about the log rather than about a screen — pinned because the old order is
   * asserted in prose in several places and somebody will check.
   */
  const kinds = (): string[] =>
    managed.log.read(0, 100, 1024 * 1024).map((stored) => stored.event.type);
  check(
    "a session's start is logged when it starts, not at the first prompt",
    kinds().slice(0, 5),
    ["workspace", "status", "agent_config", "status", "session_started"],
  );

  // A drain is running: the agent has been adopted and no turn has started.
  hook.emit(say("before any turn"));
  await settle();
  check("a drain reads before the first prompt", texts(), ["before any turn"]);

  managed.prompt("work");
  await settle();
  check("and a turn takes the queue from it", managed.status, "running");
  hook.emit(say("inside the turn"));
  await settle();
  check("what arrives inside a turn is recorded once, by the turn", texts(), ["before any turn", "inside the turn"]);

  hook.answer();
  await settle();
  check("the turn hands the queue back when it ends", managed.status, "idle");
  hook.emit(say("after the turn"));
  await settle();
  check("and the drain has it again", texts().at(-1), "after the turn");

  await heldRegistry.shutdown();
}

process.stdout.write("\nultracode, which claude offers and ACP has no field for\n");

{
  const effort = (choices: string[], value = "default") => ({
    modes: null,
    options: [
      {
        id: "mode",
        name: "Mode",
        description: null,
        category: "mode",
        kind: "select" as const,
        value: "default",
        choices: [{ value: "default", name: "Default", description: null, group: null }],
      },
      {
        id: "effort",
        name: "Effort",
        description: null,
        category: "thought_level",
        kind: "select" as const,
        value,
        choices: choices.map((choice) => ({ value: choice, name: choice, description: null, group: null })),
      },
    ],
  });
  const claude = effort(["default", "low", "medium", "high", "xhigh", "max"]);

  // What goes on the wire, which is the only thing the agent ever sees of this.
  check("claude is asked for it in the one shape its adapter reads", sessionMetaFor("claude", { ultracode: true }), {
    claudeCode: { options: { settings: { ultracode: true } } },
  });
  check("and asked nothing at all when it is off", sessionMetaFor("claude", { ultracode: false }), undefined);
  check("kimi is never asked, whatever the session says", sessionMetaFor("kimi", { ultracode: true }), undefined);
  check("nor codex", sessionMetaFor("codex", { ultracode: true }), undefined);

  // Which control the extra row belongs on — by category, never by id.
  check("the row goes on claude's effort control", ultracodeOptionId(claude, "claude"), "effort");
  check(
    "and not on a model that cannot carry it, which is the agent's own answer",
    ultracodeOptionId(effort(["default", "low", "medium", "high"]), "claude"),
    null,
  );
  check("kimi gets no row", ultracodeOptionId(effort(["low", "xhigh"]), "kimi"), null);
  check("nor codex", ultracodeOptionId(effort(["low", "xhigh"]), "codex"), null);
  check(
    "an agent with no effort control at all gets none either",
    ultracodeOptionId({ modes: null, options: [] }, "claude"),
    null,
  );
  check(
    "and an agent that ships its own ultracode takes the row back",
    ultracodeOptionId(effort(["low", "xhigh", ULTRACODE_CHOICE]), "claude"),
    null,
  );

  const off = withUltracode(claude, "claude", false);
  const on = withUltracode(claude, "claude", true);
  const effortOf = (config: { options: { id: string }[] }) =>
    config.options.find((option) => option.id === "effort") as never as {
      value: string;
      choices: { value: string }[];
    };
  check(
    "the row is drawn whether or not it is chosen",
    [effortOf(off).choices.map((choice) => choice.value), effortOf(on).choices.at(-1)?.value],
    [["default", "low", "medium", "high", "xhigh", "max", ULTRACODE_CHOICE], ULTRACODE_CHOICE],
  );
  check("and it is the selection while it is on", effortOf(on).value, ULTRACODE_CHOICE);
  check("while off leaves the agent's own value alone", effortOf(off).value, "default");
  check("nothing else on the strip moves", off.options[0], claude.options[0]);
  check(
    "and a session on an agent with no row is untouched, object for object",
    withUltracode(claude, "kimi", true) === claude,
    true,
  );

  /*
   * The property the whole split rests on: the overlay is for drawing, and the
   * state `setConfigOption` validates against never grows this choice. Mutating
   * the input here is the one mistake that would let `"ultracode"` through
   * validation and out to the agent as an ordinary value — which is precisely
   * what it must never be, since the agent has never heard of it.
   */
  check(
    "the live config the daemon validates against is not touched",
    claude.options[1]?.choices.map((choice) => choice.value),
    ["default", "low", "medium", "high", "xhigh", "max"],
  );

  /*
   * And the exit reason the restart writes. `config_changed` is a *daemon* exit:
   * nobody asked for the session to end, so if the resume that follows never
   * lands, the boot pass owes it another try.
   */
  /*
   * And what actually goes on the wire, which no listener can see.
   *
   * `_meta` is a *request* parameter, so the only way to observe it is to be the
   * agent. The checks above prove the shape; this proves `Session` spreads it onto
   * `session/new` at all — the wiring between them, which is where a boolean that
   * never reaches `sessionMetaFor` would hide with every unit test still green.
   */
  const acp = await import("@agentclientprotocol/sdk");
  const { Session } = await import("../src/session.js");
  const { PassThrough } = await import("node:stream");
  const opened: any[] = [];
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  let line = "";
  toAgent.on("data", (chunk: Buffer) => {
    line += chunk.toString("utf8");
    for (let nl = line.indexOf("\n"); nl >= 0; nl = line.indexOf("\n")) {
      const message = JSON.parse(line.slice(0, nl)) as Record<string, any>;
      line = line.slice(nl + 1);
      const reply = (result: unknown) =>
        toClient.write(`${JSON.stringify({ jsonrpc: "2.0", id: message["id"], result })}\n`);
      if (message["method"] === acp.methods.agent.initialize) {
        reply({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] });
      } else if (message["method"] === acp.methods.agent.session.new) {
        opened.push(message["params"]);
        reply({ sessionId: "s_meta" });
      } else if (message["id"] !== undefined) {
        reply({});
      }
    }
  });
  class MetaRuntime extends LocalRuntime {
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<any> {
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
    }
  }
  const asking = await Session.start({
    agent: "claude",
    cwd: process.cwd(),
    runtime: new MetaRuntime(),
    ultracode: true,
  });
  await asking.dispose().catch(() => {});
  check("the flag reaches session/new in the shape claude's adapter reads", opened[0]?._meta, {
    claudeCode: { options: { settings: { ultracode: true } } },
  });
  check("beside the parameters that were always there", [opened[0]?.cwd === process.cwd(), opened[0]?.mcpServers], [
    true,
    [],
  ]);

  const changed = { reason: "config_changed" as const, at: now, detail: null, agentHandle: null, agentConfirmedDead: true };
  check("a restart for a setting is resumed at the next boot", autoResumable(changed, "conv_1", "boot"), true);
  check("and on the next prompt", autoResumable(changed, "conv_1", "prompt"), true);
  check("and reads as interrupted rather than ended", endedWithDaemon(changed), true);
}

process.stdout.write("\nthe mode a person chose, across the restart a setting causes\n");
{
  /*
   * ⭐ **Choosing `ultracode` on the effort control put the *mode* back to Manual.**
   *
   * Two controls that have nothing to do with each other, and the coupling is the
   * restart: `applyUltracode` is `stop("config_changed")` then `resume()`, `doStop`
   * clears `agentConfigState`, and `onStarted` assigns whatever the fresh
   * conversation published — which for claude is the mode it calls `Manual`.
   * `/clear` has had `Session.restoreConfig` for exactly this since it was written;
   * this path did the structurally identical thing with the capture missing.
   *
   * The agent below is the measured shape of all three: it answers `session/set_mode`
   * and remembers the answer for as long as this *process* lives, so a fresh one
   * starts back at `default` — which is what makes the assertion about a restart
   * rather than about a variable.
   */
  const acp = await import("@agentclientprotocol/sdk");
  /*
   * ⚠ **The vocabulary narrows across the restart, and it has to.**
   *
   * `restoreConfig`'s two withdrawal guards ask whether the conversation that came
   * up still *offers* what is being put back — and with one fixture handing every
   * conversation the identical lists, neither guard can ever refuse and the option
   * loop never even reaches `setConfigOption`, because `now.value === option.value`
   * skips it a line earlier. Measured by mutation: reverting the option guard to
   * `option.choices` (the predicate the docblock calls true by construction) and
   * deleting the mode guard outright left this driver **all green**.
   *
   * So the first conversation is wide and every one after it is narrow, which is
   * the real shape the guards name: claude drops `bypassPermissions` from its modes
   * under root, and an agent restart can land on a new binary with fewer choices.
   */
  let conversations = 0;
  const wide = (): boolean => conversations <= 1;
  const modes = () =>
    wide()
      ? [
          { id: "default", name: "Manual", description: null },
          { id: "acceptEdits", name: "Accept Edits", description: null },
          { id: "bypassPermissions", name: "Bypass Permissions", description: null },
        ]
      : [
          { id: "default", name: "Manual", description: null },
          { id: "acceptEdits", name: "Accept Edits", description: null },
        ];
  /*
   * ⚠ `effort` keeps **all three** choices on every conversation, and `xhigh` is
   * the reason: `ultracodeOptionId` reads it as a capability test off the agent's
   * own answer, so narrowing it away takes the ultracode row off the control and
   * every toggle below answers `invalid_value`. The narrowing that tests the option
   * guard is therefore carried by a second control, and effort carries the restart
   * and the positive path.
   */
  const effort = (value: string) => ({
    id: "effort",
    name: "Effort",
    description: null,
    category: "thought_level",
    type: "select",
    currentValue: value,
    options: [
      { value: "default", name: "default", description: null },
      { value: "high", name: "high", description: null },
      { value: "xhigh", name: "xhigh", description: null },
    ],
  });
  /** The control that loses a choice across the restart. */
  const verbosity = (value: string) => ({
    id: "verbosity",
    name: "Verbosity",
    description: null,
    category: "output_style",
    type: "select",
    currentValue: value,
    options: wide()
      ? [
          { value: "terse", name: "terse", description: null },
          { value: "normal", name: "normal", description: null },
          { value: "verbose", name: "verbose", description: null },
        ]
      : [
          { value: "terse", name: "terse", description: null },
          { value: "normal", name: "normal", description: null },
        ],
  });

  /**
   * What the daemon actually sent, which is the only thing that can tell a guard
   * that refused from a value that happened to match.
   *
   * Outside `spawnModal` so it survives the restart the whole block is about.
   */
  const sent: string[] = [];

  /**
   * Fired once, from inside the fixture, on the first RPC `restoreConfig` makes.
   *
   * The only deterministic way into the window `restarting` closes. Racing it from
   * the test lands in the *stop* phase, where `stopRequested` refuses with
   * `terminal` all by itself — the honest answer there, and not the one this is
   * about. The window that needs a marker is strictly later: after `onStarted` has
   * assigned the new agent and while the restore is still putting values back, at
   * which point the fixture receiving a restore call *is* that moment.
   */
  let restoreHook: (() => void) | null = null;
  const fireRestoreHook = (): void => {
    const armed = restoreHook;
    if (armed === null) return;
    restoreHook = null;
    armed();
  };

  /**
   * Fired once, on the conversation-opening RPC of a restart — i.e. inside the
   * window with **no agent at all**, before `onStarted` has published anything.
   *
   * Deliberately not keyed on `session/resume`: nothing in this block ever sends a
   * prompt, so `turnCounter === 0` makes `conversationKnownEmpty` true and the
   * restart **opens** a conversation rather than resuming one. Keyed on the method
   * it never fired at all, and the assertion passed vacuously on `<the hook never
   * fired>` being compared to nothing. What scopes it is the arming, not the method.
   *
   * The other half of {@link restoreHook}, and it guards the opposite mistake. The
   * hold that stops the mode flashing must not extend backwards over this window:
   * an empty config is how a client is told there is nobody to ask, and
   * `packages/web`'s `drawnControls` reads it as `stale` and draws its own memory
   * dimmed and untappable. Serve the held config here and those chips become
   * enabled, onto a certain 409.
   *
   * Armed only when a test wants it, so the very first `session/new` — which
   * happens inside `registry.create`, before `managed` is even assigned — fires
   * nothing.
   */
  let resumeHook: (() => void) | null = null;
  const fireResumeHook = (): void => {
    const armed = resumeHook;
    if (armed === null) return;
    resumeHook = null;
    armed();
  };

  const spawnModal = (): AgentProcess => {
    // Per *process*, which is the whole point: this is the state that does not
    // survive, exactly as a real agent's does not.
    let mode = "default";
    let level = "default";
    let verb = "terse";
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        const params = (message["params"] ?? {}) as Record<string, any>;
        const state = () => ({
          sessionId: String(params["sessionId"] ?? "conv_1"),
          modes: { currentModeId: mode, availableModes: modes() },
          configOptions: [effort(level), verbosity(verb)],
        });
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { resume: {} } },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new:
          case acp.methods.agent.session.resume:
            // Before the answer, so the snapshot it samples is the one taken while
            // this daemon genuinely has no agent — `onStarted` runs off this reply.
            fireResumeHook();
            // Counted before `state()` reads it, so the conversation this answer
            // describes is the one the count names.
            conversations += 1;
            send({ jsonrpc: "2.0", id, result: state() });
            break;
          case acp.methods.agent.session.setMode:
            fireRestoreHook();
            sent.push(`mode=${String(params["modeId"])}`);
            mode = String(params["modeId"]);
            send({ jsonrpc: "2.0", id, result: {} });
            break;
          case acp.methods.agent.session.setConfigOption:
            fireRestoreHook();
            sent.push(`${String(params["configId"])}=${String(params["value"])}`);
            if (String(params["configId"]) === "effort") level = String(params["value"]);
            if (String(params["configId"]) === "verbosity") verb = String(params["value"]);
            send({ jsonrpc: "2.0", id, result: { configOptions: [effort(level), verbosity(verb)] } });
            break;
          case acp.methods.agent.session.prompt:
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
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
    } as unknown as AgentProcess;
  };

  class ModalRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "claude", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnModal();
    }
  }

  const modalRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new ModalRuntime());
  const modalDir = tmp("modecheck-");
  const managed = await modalRegistry.create({ agent: "claude", cwd: modalDir });
  const modeOf = (): string => managed.snapshot().agentConfig?.modes?.current ?? "<none>";
  const optionOf = (id: string): string =>
    String(managed.snapshot().agentConfig?.options.find((option) => option.id === id)?.value ?? "<none>");
  const effortOf = (): string => optionOf("effort");

  check("a fresh conversation starts on the agent's own mode", modeOf(), "default");
  check("and its own effort", effortOf(), "default");

  /*
   * ⭐ **What the restore may *not* put back, which is the half no driver reached.**
   *
   * Both choices below exist only on the wide first conversation. The restart lands
   * on a narrow one, so replaying either would send the agent a value it does not
   * offer — refused over the wire, and then swallowed at `restoreConfig`'s own
   * `.catch(() => {})`, so the failure is silent in both directions. Asserted on
   * `sent` rather than on the snapshot, because a guard that refused and a value
   * that happened to match read identically from outside.
   */
  await managed.setMode("bypassPermissions");
  await managed.setConfigOption("verbosity", "verbose");
  check("the wide conversation takes both", [modeOf(), optionOf("verbosity")], ["bypassPermissions", "verbose"]);
  sent.length = 0;
  await managed.setConfigOption("effort", "ultracode");
  check("a restart onto a narrower agent replays nothing it withdrew", sent, []);
  check("so the mode is the new conversation's own, not one nothing accepted", modeOf(), "default");
  check("and so is the option", optionOf("verbosity"), "terse");

  // And back off, to land on a narrow conversation for the positive round below —
  // where every value *is* still offered and the restore has to fire.
  await managed.setConfigOption("effort", "default");
  await managed.setMode("acceptEdits");
  check("which takes what somebody chooses", modeOf(), "acceptEdits");
  await managed.setConfigOption("effort", "high");
  await managed.setConfigOption("verbosity", "normal");
  sent.length = 0;

  // The reported bug, exactly. `ultracode` is intercepted before it reaches the
  // agent and restarts it; the mode is a different control and must not move.
  /*
   * ⭐ **The window `restarting` closes, driven rather than described.**
   *
   * Fired from inside the restore, which is the only moment it means anything:
   * every other guard has gone quiet by then — `stopRequested` is cleared,
   * `terminal` is false, `session` is non-null and `clearing` was never set — so
   * without the marker this `setMode` **succeeds and answers 200**, and the restore
   * still in flight puts the pre-restart mode back over it with nothing recorded
   * anywhere. That is `clearing`'s own documented `/clear` defect, reproduced on
   * the one path `clearing` does not cover.
   *
   * Collected into an array rather than a variable so "the hook never fired" is a
   * distinguishable answer: an assertion that passes because nothing ran is the
   * shape this whole block was added to remove.
   */
  const raced: { kind: string }[] = [];
  /*
   * ⭐ **The mode chip flashed `Manual` for the whole restart, and this is where it
   * was visible.**
   *
   * `onStarted` assigns the *fresh* conversation's own config, and `restoreConfig`
   * does not run until several fan-outs later — so between them the snapshot said
   * the mode was the agent's own default. Not one bad frame: every touch in that
   * window composes from the same field, so a client had no frame to hold against
   * and drew `Manual` until the mode's own round trip landed.
   *
   * Sampled from `restoreHook`, which fires on the restore's **first** RPC —
   * strictly after `onStarted` and strictly before the mode is put back, i.e.
   * inside the flash. Reads `default` without the fix, which is the report verbatim.
   */
  const duringRestore: string[] = [];
  restoreHook = () => {
    duringRestore.push(modeOf(), optionOf("verbosity"));
    void managed.setMode("default").then((result) => void raced.push(result));
  };
  // The opposite mistake, sampled in the same restart: while there is no agent the
  // snapshot must still report none, or a client draws enabled chips onto a 409.
  const duringStop: string[] = [];
  resumeHook = () => {
    const snap = managed.snapshot();
    duringStop.push(
      snap.agentConfig?.modes?.current ?? "<none>",
      String(snap.agentConfig?.options.length ?? -1),
      snap.status,
    );
  };
  // Every frame fanned out across the whole restart, for the totality check below.
  const frames: string[] = [];
  const unwatch = managed.watch((snap) => void frames.push(snap.agentConfig?.modes?.current ?? "<none>"));
  const toggled = await managed.setConfigOption("effort", "ultracode");
  unwatch();
  check(
    "the mode does not flash to the fresh agent's own while the restore runs",
    duringRestore[0] ?? "<the hook never fired>",
    "acceptEdits",
  );
  check(
    "and the controls held are the ones the restore is putting back",
    duringRestore[1] ?? "<the hook never fired>",
    "normal",
  );
  check(
    "the window with no agent still reports none, so a client draws its own memory",
    duringStop.slice(0, 2),
    ["<none>", "0"],
  );
  check("which is the state it is drawn over", duringStop[2] ?? "<the hook never fired>", "starting");
  /*
   * The totality form, and the one that catches the next fan-out somebody adds
   * between `onStarted` and the release without routing it through `snapshot()`.
   * `<none>` is expected and correct — that is the empty window above.
   */
  check("and no frame anywhere in the restart carries the fresh agent's own mode", frames.includes("default"), false);
  check(
    "a mode chosen while the agent is restarting is refused",
    raced[0]?.kind ?? "<the hook never fired>",
    "busy",
  );
  // Deliberately weaker than it looks, and paired rather than standalone: this
  // reads `acceptEdits` whether the refusal above happened or the change landed and
  // was overwritten. That is the point — the silent revert is *indistinguishable*
  // from the outside, which is why the assertion that carries the rule is the one
  // on the caller's own answer.
  check("and the mode is the one chosen before the restart either way", modeOf(), "acceptEdits");
  /*
   * The positive path, which the withdrawal assertions above cannot stand for: the
   * loop has to *reach* `setConfigOption`, and with one vocabulary it never did —
   * `now.value === option.value` skipped it a line earlier on every conversation.
   */
  check("a value the new conversation still offers is put back", sent.includes("effort=high"), true);
  check("and so is one on a control that lost a *different* choice", sent.includes("verbosity=normal"), true);
  check("and so is the mode", sent.includes("mode=acceptEdits"), true);
  check("turning ultracode on is accepted", toggled.kind, "ok");
  check("and the mode somebody chose survives the restart it causes", modeOf(), "acceptEdits");
  /*
   * Read off the snapshot the call itself returned, not off a later poll: the
   * restore is awaited *inside* `applyUltracode`, so a client folding this response
   * never sees the agent's default. Without that, the fix would still be right and
   * the screen would still flash "Manual".
   */
  check(
    "and it is in the answer the caller already has",
    toggled.kind === "ok" ? (toggled.config?.modes?.current ?? "<none>") : "<not ok>",
    "acceptEdits",
  );
  check("with ultracode reported as the effort, which the agent cannot report itself", effortOf(), "ultracode");

  // And back off again, which is the same restart in the other direction.
  await managed.setConfigOption("effort", "default");
  check("turning it off keeps the mode too", modeOf(), "acceptEdits");

  {
    /*
     * ⭐ **Sending a message during a restart waits it out; it is not refused.**
     *
     * Somebody flips ultracode and then types. They did not ask for a restart, and
     * with the spinner gone and the strip drawing the change as already done, they
     * cannot see one either — so `409 turn_in_flight` was the daemon refusing a
     * message on account of work it had started itself.
     *
     * Driven through the **real route** rather than `ManagedSession`, because that
     * is where the wait lives and the placement is the rule: `ManagedSession.prompt`
     * is synchronous by contract — it sets `turn` before any await — so the route is
     * the only place a transparent step can go. Asserted both ways below.
     */
    const { app } = createApp({
      registry: modalRegistry,
      verifier,
      instanceId: "i_modal",
      startedAt: now,
      credentials,
      roots: [modalDir],
    });
    // `Promise.resolve` because `app.fetch` is typed `Response | Promise<Response>`.
    const send = async (text: string): Promise<Response> =>
      await app.fetch(
        new Request(`http://d/sessions/${managed.id}/prompt`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }),
      );

    // Fired from inside the restore, the one window that is unambiguously mid-restart.
    const sessionSaid: string[] = [];
    const inFlight: Promise<Response>[] = [];
    restoreHook = () => {
      // The session's own answer, which must stay a refusal: it is what makes the
      // route's 409 exact for a real turn, and waiting there would put an await in
      // front of the assignment that guard depends on.
      sessionSaid.push(managed.prompt("during").kind);
      inFlight.push(send("during the restart"));
    };
    await managed.setConfigOption("effort", "ultracode");
    check("the session itself still refuses a prompt mid-restart", sessionSaid[0] ?? "<the hook never fired>", "busy");
    const answered = inFlight[0] === undefined ? null : await inFlight[0];
    check("but the route waits and sends it", answered?.status ?? -1, 202);
    check("and by the time it lands the restart is over", modeOf(), "acceptEdits");
  }

  await modalRegistry.shutdown();
}

process.stdout.write("\ntwo config changes at once\n");
{
  /*
   * ⭐ **Two changes in flight corrupted the config, and nothing on the daemon
   * stopped them.**
   *
   * `Session.updateConfig` replaces the option list *wholesale* with whatever the
   * response carried — correctly, since ACP defines `configOptions` as the complete
   * list. So with A and B overlapping, whichever response landed last won, and it
   * had been computed by the agent before the other change existed: the session
   * then reported a configuration that never was, and kept reporting it.
   *
   * The only thing holding it off was `locked` in `AgentConfigBar`, which is half a
   * guard — the composer's `/model` and `/effort` menus call `applyConfigChange`
   * directly and never see it, and `pnpm client config` knows of no such thing. So
   * this was reachable in a browser by choosing on the strip and then in the menu.
   *
   * The agent below is that race reduced: it applies each change on arrival and
   * answers with both options, and the first answer can be held so the second
   * overtakes it. Held rather than delayed by a timer, so the ordering is decided
   * by the test rather than by a race the test would also have.
   */
  const acp = await import("@agentclientprotocol/sdk");
  /** Requests the agent has actually received, which is what serialization is about. */
  const seen: string[] = [];
  const held: (() => void)[] = [];
  let holdNext = false;

  const spawnPair = (): AgentProcess => {
    const state: Record<string, string> = { a: "a0", b: "b0" };
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    const options = () =>
      ["a", "b"].map((id) => ({
        id,
        name: id.toUpperCase(),
        description: null,
        category: id === "a" ? "model" : "thought_level",
        type: "select",
        currentValue: state[id],
        options: [`${id}0`, "X", "Y"].map((value) => ({ value, name: value, description: null })),
      }));
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        const params = (message["params"] ?? {}) as Record<string, any>;
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            send({ jsonrpc: "2.0", id, result: { sessionId: "conv_1", modes: null, configOptions: options() } });
            break;
          case acp.methods.agent.session.setConfigOption: {
            const configId = String(params["configId"]);
            seen.push(`${configId}=${String(params["value"])}`);
            // Applied on arrival, and the answer built now — so a held answer is a
            // *stale complete list*, which is exactly the shape that corrupts.
            state[configId] = String(params["value"]);
            const reply = { jsonrpc: "2.0", id, result: { configOptions: options() } };
            if (holdNext) {
              holdNext = false;
              held.push(() => send(reply));
            } else {
              send(reply);
            }
            break;
          }
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
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
    } as unknown as AgentProcess;
  };

  class PairRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnPair();
    }
  }

  const pairRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new PairRuntime());
  const pairDir = tmp("paircheck-");
  const managed = await pairRegistry.create({ agent: "kimi", cwd: pairDir });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
  const valueOf = (id: string): string =>
    String(managed.snapshot().agentConfig?.options.find((option) => option.id === id)?.value ?? "<none>");

  check("both controls start where the agent put them", [valueOf("a"), valueOf("b")], ["a0", "b0"]);

  holdNext = true;
  const first = managed.setConfigOption("a", "X");
  const second = managed.setConfigOption("b", "Y");
  await settle();
  /*
   * The property itself, and the one that reads as the fix rather than as its
   * consequence: the second change has not reached the agent, because the first
   * has not been answered. Unserialized this is 2 — both are in flight, and the
   * corruption below is already inevitable.
   */
  check("a second change waits for the first to be answered", seen.length, 1);

  held[0]?.();
  await Promise.all([first, second]);
  check("both are then applied, in the order they were made", seen, ["a=X", "b=Y"]);
  /*
   * The damage, stated as the outcome somebody would report. Unserialized the
   * stale complete list lands last and `b` reads `b0` — a value nobody chose,
   * on a snapshot that keeps saying so.
   */
  check("and neither is lost to the other's answer", [valueOf("a"), valueOf("b")], ["X", "Y"]);

  /*
   * A refused change must not take the queue with it. `configChain` swallows every
   * outcome for this reason: a rejected tail would make one bad value the end of
   * that control for the life of the session.
   */
  const refused = await managed.setConfigOption("a", "nonexistent");
  check("an invalid value is refused without stopping the queue", refused.kind, "invalid_value");
  const after = await managed.setConfigOption("b", "X");
  check("so the next change still runs", after.kind, "ok");
  check("and lands", valueOf("b"), "X");

  await pairRegistry.shutdown();
}

/* -------------------------------------------------------------------------- *
 * ⭐ A long model list is cut on the poll and whole on the one read that is not
 *
 * `GET /sessions` returns sixty of these records every four seconds, over a
 * relay, to a phone — and a keyed opencode publishes **362** models in a single
 * control. `snapshotConfig` bounded each choice's *description* for exactly that
 * reason and never bounded the count, so the menu was the largest thing in the
 * response by an order of magnitude.
 *
 * ⚠ **The cut is only safe because there is somewhere to read the rest**, and
 * that is what these cases are really about. The browser draws its model picker
 * out of the snapshot — `store.ts`: *state comes from the snapshot, only prose
 * comes from the log* — so a cut with no complete read behind it is a picker
 * silently missing rows, which is worse than the payload it saves.
 * `GET /sessions/:id` is one session, asked for on purpose, never polled, and
 * answers in full.
 * -------------------------------------------------------------------------- */

process.stdout.write("\na long model list, cut and whole\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const MANY = 400;

  const spawnLong = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    /*
     * The selected value sits **past** the cut on purpose. It is the one choice a
     * client cannot do without — the chip, the strip tile and `configProse` all
     * name the session from it — so a head that simply took the first N would make
     * a running session report a model it is not on.
     */
    const options = () => [
      {
        id: "model",
        name: "Model",
        description: null,
        category: "model",
        type: "select",
        currentValue: `m${MANY - 1}`,
        options: Array.from({ length: MANY }, (_, index) => ({
          value: `m${index}`,
          name: `Model ${index}`,
          description: null,
        })),
      },
    ];
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { resume: {} } },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new:
          case acp.methods.agent.session.resume:
            send({ jsonrpc: "2.0", id, result: { sessionId: "conv_long", configOptions: options() } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      pid: 4321,
      onceExit: () => () => {},
      onceStartError: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class LongRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnLong();
    }
  }

  const longRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new LongRuntime());
  const managed = await longRegistry.create({ agent: "kimi", cwd: tmp("longcheck-") });
  const polled = managed.snapshot().agentConfig?.options[0];
  const whole = managed.snapshot({ fullConfig: true }).agentConfig?.options[0];

  check("the agent really published a list worth bounding", MANY, 400);
  check("the polled snapshot cuts it", polled?.choices.length ?? -1, 40);
  check("and says so, which is what sends a picker to the other route", polled?.truncated, true);
  /*
   * The assertion the cut exists to survive. Taking the first forty would drop the
   * selected model, and every screen that names the session reads it from here.
   */
  check(
    "the selected choice survives the cut even sitting past it",
    polled?.choices.some((one) => one.value === `m${MANY - 1}`),
    true,
  );
  check("and is still what the control is set to", String(polled?.value), `m${MANY - 1}`);

  check("the single-session read is whole", whole?.choices.length ?? -1, MANY);
  /*
   * ⚠ **And is not flagged**, or a picker drawing the complete list would still
   * print the line that says rows are missing — the failure `clamped` had in
   * `fitView`, which reported a shortening that had not happened.
   */
  check("and is not flagged as cut", whole?.truncated ?? false, false);
  check("both reads agree about the value", String(whole?.value), String(polled?.value));

  await longRegistry.shutdown();
}
