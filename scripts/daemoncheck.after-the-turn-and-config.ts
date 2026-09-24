import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { MAX_SOCKET_MESSAGE_BYTES } from "@reemoat/protocol";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { DEFAULT_MAX_EVENT_BYTES, MemoryEventStore, endedWithDaemon, truncateEvent } from "../src/events.js";
import type { AgentConfig, AnswerResolvedBy, SessionEvent } from "../src/events.js";
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
import { check, report } from "./daemoncheck.env.js";
import { now, tokenFor, verifier, credentials, stubAgentConfig } from "./daemoncheck.fixtures.js";

// The bytes the socket writes, not what `estimateBytes` budgets: the gap between them is what the census catches.
const weighEvent = (event: SessionEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8");

// The real ingest path's output, carried across: the config caps are not exported, so a restated fixture would drift.
let ingestedWideConfig: AgentConfig | null = null;

process.stdout.write("\nwhat the agent says after its turn has ended\n");
{
  // An agent that answers the prompt at once and keeps talking after its turn has ended.
  const acp = await import("@agentclientprotocol/sdk");
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
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
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

  hook.emit(say("still working on it"));
  hook.emit(say("nearly there"));
  await settle();
  check(
    "what the agent says after the turn is recorded without a second prompt",
    texts(),
    ["still working on it", "nearly there"],
  );
  check("and the session is still idle, because the turn really did end", managed.status, "idle");

  // Larger than the session queue's own bound, so a loss rather than a delay would show.
  for (let index = 0; index < 2_500; index += 1) hook.emit(say(`burst ${index}`));
  await settle();
  const burst = texts().slice(2);
  check("a burst past the queue's own bound loses nothing", burst.length, 2_500);
  check("and arrives in the order it was sent", [burst[0], burst[2_499]], ["burst 0", "burst 2499"]);

  // `agent_log` and `other` are dropped out of turn on purpose: recording them would put an unbounded stderr stream in the log.
  const before = managed.log.read(0, 10_000, 4 * 1024 * 1024).length;
  hook.emit({ sessionUpdate: "session_info_update", info: { title: "ignored" } });
  hook.stderr("[debug] a line nothing draws");
  await settle();
  check("machinery nobody draws is not recorded out of turn", managed.log.read(0, 10_000, 4 * 1024 * 1024).length, before);

  managed.prompt("again");
  await settle();
  hook.emit(say("after the second turn"));
  await settle();
  check("a later turn takes the queue back and gives it back again", texts().at(-1), "after the second turn");

  await talkRegistry.shutdown();
}

process.stdout.write("\nwho owns a session's events\n");
{
  // The release is identity-checked: a stale release clearing the turn's hold would pin the turn for the session's life.
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
            // Held open until the test says so, so the turn is genuinely in flight.
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
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
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

  // `session_started` is pushed by `Session.adopt`, before `onStarted`, so it is logged when the session starts.
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

process.stdout.write("\nwhat the agent asks, and does, with no turn held\n");
{
  // claude's shape after background work comes back: output, questions and a plan with no session/prompt, each cycle ended by a usage_update carrying its origin.
  const acp = await import("@agentclientprotocol/sdk");
  type Rig = {
    marks: boolean;
    // Off for one prompt, so a turn's end is seen ending the work with no marker's help.
    markTurn: boolean;
    emit: (update: Record<string, unknown>) => void;
    ask: (method: string, params: Record<string, unknown>) => Promise<any>;
    methods: string[];
    heldPrompt: ((stopReason: string) => void) | null;
    holdNextPrompt: boolean;
    onCancel: () => void;
  };
  const rigs: Rig[] = [];
  const cycleEnd = (kind: string) => ({
    sessionUpdate: "usage_update",
    used: 10,
    size: 100,
    _meta: { "_claude/origin": { kind } },
  });

  const spawnUnprompted = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    const waiting = new Map<number, (result: unknown) => void>();
    let askId = 7000;
    const rig: Rig = {
      marks: rigs.length > 0,
      markTurn: true,
      emit: (update) =>
        send({ jsonrpc: "2.0", method: acp.methods.client.session.update, params: { sessionId: "conv_u", update } }),
      ask: (method, params) =>
        new Promise((resolve) => {
          askId += 1;
          waiting.set(askId, resolve);
          send({ jsonrpc: "2.0", id: askId, method, params: { sessionId: "conv_u", ...params } });
        }),
      methods: [],
      heldPrompt: null,
      holdNextPrompt: false,
      onCancel: () => {},
    };
    rigs.push(rig);
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        if (message["method"] === undefined && id !== undefined) {
          waiting.get(id)?.(message["result"] ?? message["error"]);
          waiting.delete(id);
          continue;
        }
        rig.methods.push(String(message["method"]));
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
            send({ jsonrpc: "2.0", id, result: { sessionId: "conv_u", modes: null, configOptions: [] } });
            break;
          case acp.methods.agent.session.prompt: {
            const finish = (stopReason: string): void => {
              // The adapter's order: the result's usage_update, then the answer to session/prompt.
              if (rig.marks && rig.markTurn) rig.emit(cycleEnd("human"));
              send({ jsonrpc: "2.0", id, result: { stopReason } });
            };
            if (rig.holdNextPrompt) {
              rig.holdNextPrompt = false;
              rig.heldPrompt = finish;
            } else {
              finish("end_turn");
            }
            break;
          }
          case acp.methods.agent.session.cancel:
            rig.onCancel();
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

  class UnpromptedRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnUnprompted();
    }
  }

  const registry = new SessionRegistry(new MemoryEventStore(), null, undefined, new UnpromptedRuntime());
  const silenceMs = 60_000;
  registry.setSessionLimits({ turnSilenceMs: silenceMs });
  const dir = tmp("unpromptedcheck-");
  const { app } = createApp({ registry, verifier, instanceId: "i_unprompted", startedAt: now, credentials, roots: [dir] });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));
  const say = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const post = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await app.fetch(
      new Request(`http://d${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
  };
  const permission = (rig: Rig, title: string) =>
    rig.ask(acp.methods.client.session.requestPermission, {
      toolCall: { toolCallId: `tc_${title}`, title, rawInput: { plan: "1. do it" } },
      options: [
        { optionId: "o_yes", name: "Yes", kind: "allow_once" },
        { optionId: "o_no", name: "No", kind: "reject_once" },
      ],
    });
  const question = (rig: Rig) =>
    rig.ask(acp.methods.client.elicitation.create, {
      mode: "form",
      toolCallId: "tc_ask",
      message: "Which one?",
      requestedSchema: {
        type: "object",
        properties: { question_0: { type: "string", title: "Pick", oneOf: [{ const: "a", title: "A" }] } },
      },
    });

  // An agent that has never marked where a cycle ends is not tracked at all: nothing could ever end it.
  const plain = await registry.create({ agent: "kimi", cwd: dir });
  const plainRig = rigs[0]!;
  plain.prompt("go");
  await settle();
  plainRig.emit(say("after the turn"));
  await settle();
  check("an agent that never marks a cycle's end reads idle after its turn, as before", [plain.status, plain.snapshot().unpromptedSince], ["idle", null]);

  const managed = await registry.create({ agent: "kimi", cwd: dir });
  const rig = rigs[1]!;
  const log = () => managed.log.read(0, 10_000, 4 * 1024 * 1024).map((stored) => stored.event);
  const resolutions = () =>
    log()
      .filter((event) => event.type === "permission_resolved" || event.type === "elicitation_resolved")
      .map((event) => (event as { by: string }).by);

  managed.prompt("go");
  await settle();
  check("a turn that marked its end leaves nothing running", [managed.status, managed.snapshot().unpromptedSince], ["idle", null]);

  rig.emit(say("the workflow finished, reading its report"));
  await settle();
  const lit = managed.snapshot();
  check("output with no turn held is the agent working", [lit.status, lit.turn, typeof lit.unpromptedSince], ["running", null, "number"]);
  // Q2.44's objection to widening showsWorking was Send; a daemon that says this also says it takes a message now.
  check("and a daemon that says so is one that takes a message mid-work", lit.midTurnDelivery !== null, true);
  check("so it is not released, however long ago anybody typed", managed.parkable(Date.now() + 10 * silenceMs, 0), false);
  check("nor is its agent restarted under it for a credential", managed.takesCredentialChange, false);
  check("and a /clear is refused rather than deciding the cycle's fate", (await managed.clearContext("/clear")).kind, "busy");
  rig.emit({ sessionUpdate: "usage_update", used: 11, size: 100 });
  await settle();
  check("a usage_update with no origin is a token, not an end", managed.snapshot().unpromptedSince === lit.unpromptedSince, true);
  rig.emit(cycleEnd("task-notification"));
  await settle();
  check("the cycle's own end marker ends it", [managed.status, managed.snapshot().unpromptedSince], ["idle", null]);

  rig.emit({
    sessionUpdate: "tool_call",
    toolCallId: "sub_1",
    title: "grep",
    kind: "search",
    status: "pending",
    _meta: { claudeCode: { parentToolUseId: "task_1" } },
  });
  await settle();
  check("a subagent's step is a delegation, not the agent's own cycle", managed.snapshot().unpromptedSince, null);

  // Q2.232: the defect as filed — a question raised with no turn held was cancelled on arrival.
  const asked = question(rig);
  await settle();
  check("a question raised with no turn held is parked, not refused", [managed.status, managed.snapshot().pendingElicitations.length], ["blocked", 1]);
  check("and nothing settled it on arrival", resolutions(), []);
  const elicitationId = managed.snapshot().pendingElicitations[0]?.elicitationId ?? "none";
  const replied = await post(`/sessions/${managed.id}/elicitations/${elicitationId}`, { content: { question_0: "a" } });
  check("a person answers it", [replied.status, ((await asked) as any)?.action], [200, "accept"]);
  check("and the answer is attributed to them", resolutions(), ["client"]);
  rig.emit(cycleEnd("task-notification"));
  await settle();

  const plan = permission(rig, "Approve Plan");
  await settle();
  check("so is a plan", [managed.status, managed.snapshot().pendingPermissions.length], ["blocked", 1]);
  check("and it says it was raised between turns", managed.snapshot().pendingPermissions[0]?.outOfTurn, true);
  const permissionId = managed.snapshot().pendingPermissions[0]?.permissionId ?? "none";
  const approved = await post(`/sessions/${managed.id}/permissions/${permissionId}`, { optionId: "o_yes" });
  check("and approving it reaches the agent", [approved.status, ((await plan) as any)?.outcome?.optionId], [200, "o_yes"]);
  rig.emit(cycleEnd("task-notification"));
  await settle();

  // A turn ending is not an answer.
  rig.holdNextPrompt = true;
  managed.prompt("hold on");
  await settle();
  const inTurn = permission(rig, "Terminal");
  await settle();
  check("a request raised inside a turn says so", managed.snapshot().pendingPermissions[0]?.outOfTurn, false);
  rig.heldPrompt?.("end_turn");
  await settle();
  check("a request still parked when its turn ends stays parked", [managed.snapshot().turn, managed.snapshot().pendingPermissions.length], [null, 1]);
  check("with nothing settled by the turn's end", resolutions(), ["client", "client"]);
  const late = managed.snapshot().pendingPermissions[0]?.permissionId ?? "none";
  const lateAnswer = await post(`/sessions/${managed.id}/permissions/${late}`, { optionId: "o_no" });
  check("and it can still be answered", [lateAnswer.status, ((await inTurn) as any)?.outcome?.optionId], [200, "o_no"]);

  // Stop with no turn: send, sweep, watch, as a turn's Stop does.
  rig.emit(say("working on the next part"));
  const parkedPlan = permission(rig, "Approve Plan");
  await settle();
  rig.onCancel = () => rig.emit(cycleEnd("task-notification"));
  const cancelsBefore = rig.methods.filter((method) => method === acp.methods.agent.session.cancel).length;
  const stopped = await post(`/sessions/${managed.id}/cancel`);
  check("Stop with no turn held is a cancel, not a no_turn", [stopped.status, stopped.body?.cancelled, stopped.body?.turn], [200, true, null]);
  check("the agent was told", rig.methods.filter((method) => method === acp.methods.agent.session.cancel).length - cancelsBefore, 1);
  check("and what it had parked was answered cancelled, by the person", [((await parkedPlan) as any)?.outcome?.outcome, resolutions().at(-1)], ["cancelled", "turn_cancelled"]);
  check("and it settled once the cycle said it had ended", [stopped.body?.settled, managed.status, managed.snapshot().cancelRequestedAt], [true, "idle", null]);

  // Revising a plan parked with no turn: cancel, then the message goes through as a turn of its own.
  rig.emit(say("still going"));
  await settle();
  rig.onCancel = () => {};
  const unsettled = await post(`/sessions/${managed.id}/cancel`);
  check("an agent that has not ended the cycle yet is reported honestly", [unsettled.body?.settled, typeof managed.snapshot().cancelRequestedAt], [false, "number"]);
  const promptsBefore = rig.methods.filter((method) => method === acp.methods.agent.session.prompt).length;
  rig.markTurn = false;
  const revised = await post(`/sessions/${managed.id}/prompt`, { text: "change step 2" });
  await settle();
  rig.markTurn = true;
  check("and the message sent after it is taken, never a 409", revised.status, 202);
  check(
    "and really reaches the agent rather than ending as cancelled before it is sent",
    rig.methods.filter((method) => method === acp.methods.agent.session.prompt).length - promptsBefore,
    1,
  );
  check("and a turn's end ends the unprompted work before it too", [managed.status, managed.snapshot().unpromptedSince], ["idle", null]);

  const idleCancel = await post(`/sessions/${managed.id}/cancel`);
  check("with nothing working and nothing parked, Stop is still the lost race it was", [idleCancel.body?.cancelled, idleCancel.body?.turn], [false, null]);

  // The safety net: the silent-turn clock, for an adapter that stops sending the marker.
  rig.emit(say("a cycle whose end never comes"));
  await settle();
  // Measured from the agent's own last word, the clock the sweep reads, rather than from a margin.
  const lastWord = managed.lastAgentActivityAt ?? Number.NaN;
  registry.abandonWedgedTurns(lastWord + silenceMs - 1);
  check("the silent-turn clock leaves unprompted work alone a moment before the bound", typeof managed.snapshot().unpromptedSince, "number");
  check("and does not take it for a turn to abandon", registry.abandonWedgedTurns(lastWord + silenceMs), []);
  check("but ends it at the bound", managed.snapshot().unpromptedSince, null);
  check("writing nothing, since no turn ended", log().at(-1)?.type, "text");
  const blocking = permission(rig, "Terminal");
  await settle();
  registry.abandonWedgedTurns(Date.now() + 10 * silenceMs);
  check("and never while it waits on a person", [managed.status, typeof managed.snapshot().unpromptedSince], ["blocked", "number"]);

  await managed.stop();
  check("stopping the session answers what is parked and ends the work", [((await blocking) as any)?.outcome?.outcome, managed.snapshot().unpromptedSince], ["cancelled", null]);
  check("and the old resolvers are unreachable", resolutions().filter((by) => by === "no_turn" || by === "turn_ended" || by === "pump_failed"), []);

  await registry.shutdown();
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

  check("claude is asked for it in the one shape its adapter reads", sessionMetaFor("claude", { ultracode: true, elicitation: true }), {
    claudeCode: { options: { settings: { ultracode: true } } },
  });
  check("and asked nothing at all when it is off", sessionMetaFor("claude", { ultracode: false, elicitation: true }), undefined);
  check("kimi is never asked, whatever the session says", sessionMetaFor("kimi", { ultracode: true, elicitation: true }), undefined);
  check("nor codex", sessionMetaFor("codex", { ultracode: true, elicitation: true }), undefined);

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

  // The overlay is for drawing: the config `setConfigOption` validates against must never grow this choice.
  check(
    "the live config the daemon validates against is not touched",
    claude.options[1]?.choices.map((choice) => choice.value),
    ["default", "low", "medium", "high", "xhigh", "max"],
  );

  // `_meta` is a request parameter, so the only way to observe it is to be the agent.
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
  // `applyUltracode` restarts the agent, which comes back on its own mode, so the restore must put the chosen mode back.
  const acp = await import("@agentclientprotocol/sdk");
  // The first conversation is wide and every later one narrow, or the restore's withdrawal guards can never refuse.
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
  // `effort` keeps all three choices: `ultracodeOptionId` reads `xhigh` as the capability test, so the narrowing rides on a second control.
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

  // What the daemon sent: the only thing that tells a refusing guard from a value that happened to match.
  const sent: string[] = [];

  // Fired once on the restore's first RPC: the only deterministic way into the window `restarting` closes.
  let restoreHook: (() => void) | null = null;
  const fireRestoreHook = (): void => {
    const armed = restoreHook;
    if (armed === null) return;
    restoreHook = null;
    armed();
  };

  // Fired once on a restart's conversation-opening RPC, while there is no agent; scoped by arming, not by method.
  let resumeHook: (() => void) | null = null;
  const fireResumeHook = (): void => {
    const armed = resumeHook;
    if (armed === null) return;
    resumeHook = null;
    armed();
  };

  // `current_mode_update` is the only ingest path onto `modes.current` that `toModes` does not guard.
  const modalHook: { emit: (update: Record<string, unknown>) => void } = { emit: () => {} };

  const spawnModal = (): AgentProcess => {
    // Per process: this state does not survive a restart, as a real agent's does not.
    let mode = "default";
    let level = "default";
    let verb = "terse";
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    modalHook.emit = (update) =>
      send({ jsonrpc: "2.0", method: acp.methods.client.session.update, params: { sessionId: "conv_1", update } });
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
            // Before the answer, so the sample is taken while the daemon has no agent.
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
      return [{ id: "claude", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
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

  // Both halves: an over-long mode id must be ignored, and an ordinary one must still move the mode.
  const modeSettle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
  const widestLoggedEvent = (): number =>
    managed.log
      .read(0, 10_000, 64 * 1024 * 1024)
      .reduce((most, stored) => Math.max(most, Buffer.byteLength(JSON.stringify(stored.event), "utf8")), 0);

  modalHook.emit({ sessionUpdate: "current_mode_update", currentModeId: "m".repeat(2 * 1024 * 1024) });
  await modeSettle();
  check("a mode id past the id bound is ignored rather than published", modeOf(), "default");
  report(
    "and no event it would have ridden is past the socket ceiling",
    widestLoggedEvent() <= MAX_SOCKET_MESSAGE_BYTES,
    `widest logged event ${widestLoggedEvent()} against ${MAX_SOCKET_MESSAGE_BYTES}`,
  );
  modalHook.emit({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
  await modeSettle();
  check("while an ordinary one still moves the mode", modeOf(), "plan");
  modalHook.emit({ sessionUpdate: "current_mode_update", currentModeId: "default" });
  await modeSettle();
  check("and moves it back", modeOf(), "default");

  // Asserted on `sent`: a withdrawn choice replayed would be refused and then swallowed by the restore, silently.
  await managed.setMode("bypassPermissions");
  await managed.setConfigOption("verbosity", "verbose");
  check("the wide conversation takes both", [modeOf(), optionOf("verbosity")], ["bypassPermissions", "verbose"]);
  sent.length = 0;
  await managed.setConfigOption("effort", "ultracode");
  check("a restart onto a narrower agent replays nothing it withdrew", sent, []);
  check("so the mode is the new conversation's own, not one nothing accepted", modeOf(), "default");
  check("and so is the option", optionOf("verbosity"), "terse");

  // Back to a narrow conversation where every value is still offered, so the restore has to fire.
  await managed.setConfigOption("effort", "default");
  await managed.setMode("acceptEdits");
  check("which takes what somebody chooses", modeOf(), "acceptEdits");
  await managed.setConfigOption("effort", "high");
  await managed.setConfigOption("verbosity", "normal");
  sent.length = 0;

  // Fired from inside the restore, where every other guard is quiet; an array so a hook that never fired is distinguishable.
  const raced: { kind: string }[] = [];
  // Sampled on the restore's first RPC, after `onStarted` and before the mode is put back.
  const duringRestore: string[] = [];
  restoreHook = () => {
    duringRestore.push(modeOf(), optionOf("verbosity"));
    void managed.setMode("default").then((result) => void raced.push(result));
  };
  // The opposite mistake: while there is no agent the snapshot must not offer controls a client could tap onto a 409.
  const duringStop: string[] = [];
  resumeHook = () => {
    const snap = managed.snapshot();
    duringStop.push(
      snap.agentConfig?.modes?.current ?? "<none>",
      String(snap.agentConfig?.options.length ?? -1),
      snap.status,
    );
  };
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
  // `doStop` keeps the controls for a revivable reason, so the snapshot serves them through the restart; a choice made mid-restart is refused as busy.
  check(
    "the window with no agent no longer reports none: the strip does not blink",
    duringStop.slice(0, 2),
    ["acceptEdits", "2"],
  );
  check("which is the state it is drawn over", duringStop[2] ?? "<the hook never fired>", "starting");
  // The totality form: catches a fan-out added between `onStarted` and the release that bypasses the snapshot.
  check("and no frame anywhere in the restart carries the fresh agent's own mode", frames.includes("default"), false);
  check(
    "a mode chosen while the agent is restarting is refused",
    raced[0]?.kind ?? "<the hook never fired>",
    "busy",
  );
  // Deliberately weak: a refusal and a silent revert read the same here, so the rule rests on the caller's own answer above.
  check("and the mode is the one chosen before the restart either way", modeOf(), "acceptEdits");
  // The positive path: the restore loop must actually reach `setConfigOption`.
  check("a value the new conversation still offers is put back", sent.includes("effort=high"), true);
  check("and so is one on a control that lost a *different* choice", sent.includes("verbosity=normal"), true);
  check("and so is the mode", sent.includes("mode=acceptEdits"), true);
  check("turning ultracode on is accepted", toggled.kind, "ok");
  check("and the mode somebody chose survives the restart it causes", modeOf(), "acceptEdits");
  // Read off the call's own returned snapshot: the restore is awaited inside `applyUltracode`.
  check(
    "and it is in the answer the caller already has",
    toggled.kind === "ok" ? (toggled.config?.modes?.current ?? "<none>") : "<not ok>",
    "acceptEdits",
  );
  check("with ultracode reported as the effort, which the agent cannot report itself", effortOf(), "ultracode");

  await managed.setConfigOption("effort", "default");
  check("turning it off keeps the mode too", modeOf(), "acceptEdits");

  {
    // A message during a restart waits at the route: `ManagedSession.prompt` is synchronous by contract, so the wait cannot live there.
    const { app } = createApp({
      registry: modalRegistry,
      verifier,
      instanceId: "i_modal",
      startedAt: now,
      credentials,
      roots: [modalDir],
    });
    const send = async (text: string): Promise<Response> =>
      await app.fetch(
        new Request(`http://d/sessions/${managed.id}/prompt`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }),
      );

    const sessionSaid: string[] = [];
    const inFlight: Promise<Response>[] = [];
    restoreHook = () => {
      // Must stay a refusal: waiting here would put an await before the assignment the route's 409 depends on.
      sessionSaid.push(managed.prompt("during").kind);
      inFlight.push(send("during the restart"));
    };
    await managed.setConfigOption("effort", "ultracode");
    check("the session itself still refuses a prompt mid-restart", sessionSaid[0] ?? "<the hook never fired>", "busy");
    const answered = inFlight[0] === undefined ? null : await inFlight[0];
    check("but the route waits and sends it", answered?.status ?? -1, 202);
    check("and by the time it lands the restart is over", modeOf(), "acceptEdits");
  }

  {
    // The reported path (Q2.234): ultracode back to a level restarts the agent, and the panel's finished rows came back empty.
    const listed = (): string[][] => managed.snapshot().backgroundTasks.map((task) => [task.id, task.state]);
    check("ultracode is on going in", effortOf(), "ultracode");
    modalHook.emit({ sessionUpdate: "async_task_spawned", asyncTaskId: "wf_1", name: "map", taskType: "workflow", description: "", showInTranscript: false, canStop: true });
    modalHook.emit({ sessionUpdate: "async_task_state_update", asyncTaskId: "wf_1", state: "completed" });
    await modeSettle();
    check("a workflow finished under ultracode is listed", listed(), [["wf_1", "completed"]]);
    await managed.setConfigOption("effort", "high");
    check("effort is a level again, on a fresh agent", [effortOf(), managed.status], ["high", "idle"]);
    check("and the finished workflow is still listed, since the conversation is the same", listed(), [["wf_1", "completed"]]);
  }

  await modalRegistry.shutdown();
}

process.stdout.write("\ntwo config changes at once\n");
{
  // `Session.updateConfig` replaces the option list wholesale, so overlapping changes must be serialized or a stale complete list wins.
  // The first answer is held, not timed, so the test decides the ordering.
  const acp = await import("@agentclientprotocol/sdk");
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
            // Applied on arrival and answered now, so a held answer is a stale complete list.
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
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
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
  check("a second change waits for the first to be answered", seen.length, 1);

  held[0]?.();
  await Promise.all([first, second]);
  check("both are then applied, in the order they were made", seen, ["a=X", "b=Y"]);
  check("and neither is lost to the other's answer", [valueOf("a"), valueOf("b")], ["X", "Y"]);

  // `configChain` swallows every outcome: a rejected tail would end that control for the session's life.
  const refused = await managed.setConfigOption("a", "nonexistent");
  check("an invalid value is refused without stopping the queue", refused.kind, "invalid_value");
  const after = await managed.setConfigOption("b", "X");
  check("so the next change still runs", after.kind, "ok");
  check("and lands", valueOf("b"), "X");

  await pairRegistry.shutdown();
}

// The poll cuts a long choice list; that is safe only because the picker is drawn from the snapshot and the single-session read answers in full.

process.stdout.write("\na long model list, cut and whole\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const MANY = 400;

  const spawnLong = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    // The selected value sits past the cut on purpose: every screen names the session from it.
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
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
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
  check(
    "the selected choice survives the cut even sitting past it",
    polled?.choices.some((one) => one.value === `m${MANY - 1}`),
    true,
  );
  check("and is still what the control is set to", String(polled?.value), `m${MANY - 1}`);

  check("the single-session read is whole", whole?.choices.length ?? -1, MANY);
  // Not flagged, or a picker drawing the whole list would still say rows are missing.
  check("and is not flagged as cut", whole?.truncated ?? false, false);
  check("both reads agree about the value", String(whole?.value), String(polled?.value));

  await longRegistry.shutdown();
}

process.stdout.write("\na config list nothing bounded\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const HUGE = 2_000_000;
  const CHOICES = 20_000;

  const published: { options: () => unknown[]; modes: unknown } = { options: () => [], modes: null };

  const hostileOptions = (): unknown[] => [
    // Dropped whole: the id round-trips, so a clipped one names no control.
    {
      id: "i".repeat(HUGE),
      name: "Unreachable",
      description: null,
      category: "model",
      type: "select",
      currentValue: "a",
      options: [{ value: "a", name: "A", description: null }],
    },
    // Kept, with the 2 MB choice dropped and the rest cut; the selected value sits past the cut on purpose.
    {
      id: "model",
      name: "N".repeat(HUGE),
      description: "D".repeat(HUGE),
      category: "C".repeat(HUGE),
      type: "select",
      currentValue: `m${CHOICES - 1}`,
      options: [
        { value: "v".repeat(HUGE), name: "Enormous", description: null },
        ...Array.from({ length: CHOICES }, (_, index) => ({
          value: `m${index}`,
          name: `Model ${index}`,
          description: "p".repeat(400),
        })),
      ],
    },
  ];

  // The largest real list, 362 models with prose: the `MAX_CONFIG_BYTES` backstop must pass it whole and unflagged.
  const realOptions = (): unknown[] => [
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: "provider/model-361-2026-09-19",
      options: Array.from({ length: 362 }, (_, index) => ({
        value: `provider/model-${index}-2026-09-19`,
        name: `Provider Model ${index} (latest)`,
        description: "d".repeat(400),
      })),
    },
  ];

  const spawnWide = (): AgentProcess => {
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
            send({
              jsonrpc: "2.0",
              id,
              result: { sessionId: "conv_wide", configOptions: published.options(), modes: published.modes },
            });
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
      pid: 4322,
      onceExit: () => () => {},
      onceStartError: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class WideRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnWide();
    }
  }

  published.options = hostileOptions;
  // Refused whole: a mode state with nothing selected draws blank.
  published.modes = {
    currentModeId: "c".repeat(HUGE),
    availableModes: [{ id: "default", name: "Default", description: null }],
  };
  const wideRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new WideRuntime());
  const wide = await wideRegistry.create({ agent: "kimi", cwd: tmp("widecheck-") });
  const config = wide.snapshot({ fullConfig: true }).agentConfig ?? { modes: null, options: [] };
  ingestedWideConfig = config;
  const model = config.options.find((option) => option.id === "model");

  check("the option whose id round-trips and is 2 MB is dropped whole", config.options.length, 1);
  check("the option beside it survives", model?.id, "model");
  check("its name is clipped rather than dropped — it is a label, not an id", (model?.name.length ?? 0) <= 256, true);
  check("so is its category", (model?.category?.length ?? 0) <= 256, true);
  // A dropped choice and a cut list both set `truncated`, so a picker never silently offers less than the agent supports.
  check("the 2 MB choice value is gone", model?.choices.some((one) => one.value.length > 256) ?? true, false);
  check("and the list is cut", (model?.choices.length ?? 0) < CHOICES, true);
  check("and says so", model?.truncated, true);
  check(
    "the selected choice survives even sitting past the cut",
    model?.choices.some((one) => one.value === `m${CHOICES - 1}`),
    true,
  );
  check("and is still what the control is set to", String(model?.value), `m${CHOICES - 1}`);
  check("the mode state whose current id names nothing is refused whole", config.modes, null);

  const asEvent: SessionEvent = { type: "agent_config", modes: config.modes, options: config.options };
  const cut = weighEvent(truncateEvent(asEvent, DEFAULT_MAX_EVENT_BYTES));
  report(
    "and the event this produces no longer reaches the socket ceiling",
    cut <= MAX_SOCKET_MESSAGE_BYTES,
    `${cut} bytes after truncation against ${MAX_SOCKET_MESSAGE_BYTES}`,
  );

  await wideRegistry.shutdown();

  published.options = realOptions;
  published.modes = null;
  const realRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new WideRuntime());
  const real = await realRegistry.create({ agent: "kimi", cwd: tmp("realcheck-") });
  const realModel = real.snapshot({ fullConfig: true }).agentConfig?.options[0];
  check("the largest real model list comes through whole", realModel?.choices.length ?? -1, 362);
  check("and is not flagged as cut", realModel?.truncated ?? false, false);
  // Weighed as published: the fixture must be past 128 KiB, or the checks above would pass over a list the old bound also carried.
  const realBytes = Buffer.byteLength(JSON.stringify(realOptions()), "utf8");
  report(
    "and the list it came through is past the 128 KiB the first draft used",
    realBytes > 128 * 1024,
    `${realBytes} bytes as the agent published them`,
  );
  await realRegistry.shutdown();
}

process.stdout.write("\nwhich events can still be too big for one WebSocket message\n");
{
  // Labels come from a comment-stripped copy of the `SessionEvent` union and are differenced against the fixtures both ways.
  // Each fixture is the largest event this driver knows how to build, not a proof that no larger one exists.
  const source = await readFile(new URL("../src/events.ts", import.meta.url), "utf8");
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const unionAt = bare.indexOf("export type SessionEvent =");
  const unionEnd = unionAt < 0 ? -1 : bare.indexOf(";", unionAt);
  // Both ends guarded: a negative `indexOf` makes `slice` widen the window instead of emptying it.
  if (unionAt < 0 || unionEnd < 0) throw new Error("could not find the SessionEvent union in src/events.ts");
  const members = bare
    .slice(unionAt, unionEnd)
    .split("|")
    .slice(1)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const labelOf = (member: string): string => {
    const at = bare.indexOf(`export interface ${member} {`);
    const end = at < 0 ? -1 : bare.indexOf("\n}", at);
    if (at < 0 || end < 0) throw new Error(`could not find interface ${member}`);
    const match = /\n\s*type:\s*"([^"]+)";/.exec(bare.slice(at, end));
    if (match?.[1] === undefined) throw new Error(`no type literal on ${member}`);
    return match[1];
  };
  const declared = new Set(members.map(labelOf));

  if (ingestedWideConfig === null) throw new Error("the wide-config section did not run");
  const wideConfig = ingestedWideConfig;
  const BIG = "x".repeat(2_000_000);
  const by: AnswerResolvedBy = "client";
  const fixtures: Record<string, SessionEvent> = {
    // Clipped to `maxBytes`, so the size of the field cannot matter.
    text: { type: "text", role: "agent", thought: false, text: BIG, messageId: null },
    prompt: { type: "prompt", text: BIG, attachments: null },
    agent_log: { type: "agent_log", line: BIG },
    error: { type: "error", message: BIG, data: { blob: BIG } },
    other: { type: "other", sessionUpdate: "unknown", raw: { blob: BIG } },
    file_change: { type: "file_change", path: "/p", oldText: BIG, newText: BIG, source: "diff", toolCallId: null },
    tool_call: {
      type: "tool_call",
      toolCallId: "t",
      title: BIG,
      kind: "other",
      status: "pending",
      // `cutLocations` slices to 32 and clips each path, so the count is bounded
      // here rather than at ingest.
      locations: Array.from({ length: 5_000 }, () => ({ path: BIG, line: 1 })),
      rawInput: { blob: BIG },
      parentToolCallId: null,
      subagent: false,
    },
    // Built at what `toolOutput` can emit: one budget spans the array, so this is the thinnest array it can produce.
    tool_call_update: {
      type: "tool_call_update",
      toolCallId: "t",
      title: null,
      status: null,
      locations: [],
      rawInput: { blob: BIG },
      images: null,
      content: Array.from({ length: 32 * 1024 }, () => "y"),
      parentToolCallId: null,
      backgrounded: false,
    },
    // `MAX_ELICITATION_MESSAGE_CHARS` and the form caps, at their ceilings.
    elicitation_request: { type: "elicitation_request", elicitationId: "e", toolCallId: null, message: "q".repeat(4 * 1024) },
    elicitation_resolved: {
      type: "elicitation_resolved",
      elicitationId: "e",
      toolCallId: null,
      message: "q".repeat(4 * 1024),
      action: "accept",
      answers: Array.from({ length: 24 }, () => ({ key: "k", label: "l", value: "v".repeat(512) })),
      by,
    },
    // `MAX_PERMISSION_SNAPSHOT_BYTES` and `MAX_PERMISSION_OPTIONS` at ingest; the
    // title is clipped by the arm on top of that.
    permission_request: {
      type: "permission_request",
      permissionId: "p",
      toolCallId: null,
      title: BIG,
      options: Array.from({ length: 24 }, (_, i) => ({ optionId: `o${i}`, name: "n", kind: "allow_once" as const })),
      decision: null,
    },
    permission_resolved: {
      type: "permission_resolved",
      permissionId: "p",
      toolCallId: null,
      title: BIG,
      outcome: "selected",
      optionId: "o",
      by,
    },
    // Daemon-minted from fixed push sites in `worktree.ts`, so the count is bounded by this repository's own code.
    workspace: {
      type: "workspace",
      mode: "worktree",
      root: "/r",
      requestedCwd: "/c",
      branch: null,
      baseCommit: null,
      plainReason: null,
      warnings: Array.from({ length: 5_000 }, () => ({ code: "c", message: "m".repeat(100) })),
    },
    agent_config: { type: "agent_config", ...wideConfig },
    status: { type: "status", status: "idle", exit: null },
    turn_end: { type: "turn_end", stopReason: "end_turn", usage: null },
    // Agent session ids are bounded nowhere: they are the routing key in `AcpClient`, and a clipped one names no conversation.
    context_cleared: { type: "context_cleared", agentSessionId: "a".repeat(600_000), previousAgentSessionId: "b".repeat(600_000) },
    session_started: { type: "session_started", agent: "claude", sessionId: BIG, agentInfo: null, modes: null },
    // The per-item budget floors at 64 bytes, so the arm bounds an entry and never the count.
    plan: {
      type: "plan",
      entries: Array.from({ length: 10_000 }, () => ({ content: "z".repeat(200), priority: "medium" as const, status: "pending" as const })),
    },
  };

  const fixtured = new Set(Object.keys(fixtures));
  const missing = [...declared].filter((label) => !fixtured.has(label));
  const extra = [...fixtured].filter((label) => !declared.has(label));
  check("every label on the SessionEvent union has a fixture", missing, []);
  check("and every fixture names a label that exists", extra, []);

  // A claim about this repository's own unbounded fields: bounding one of them moves this list.
  const expectedOver = ["context_cleared", "plan", "session_started"];
  const over: string[] = [];
  for (const label of [...declared].sort()) {
    const fixture = fixtures[label];
    if (fixture === undefined) continue;
    const bytes = weighEvent(truncateEvent(fixture, DEFAULT_MAX_EVENT_BYTES));
    process.stdout.write(`        ${label.padEnd(22)} ${String(bytes).padStart(9)} bytes after truncation\n`);
    if (bytes > MAX_SOCKET_MESSAGE_BYTES) over.push(label);
  }
  check("exactly these labels can still exceed one WebSocket message", over.sort(), expectedOver);
  report(
    "and agent_config is no longer one of them",
    !over.includes("agent_config"),
    `ceiling ${MAX_SOCKET_MESSAGE_BYTES}; over: ${over.join(", ")}`,
  );
}
