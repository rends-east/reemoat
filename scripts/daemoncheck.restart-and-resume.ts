import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AgentUnavailableError, type AgentId, type AgentLaunchConfig } from "../src/acp/agents.js";
import { AgentLoginRuns } from "../src/agentauth.js";
import {
  EXIT_REASON_MEMBERS,
  MemoryEventStore,
  type ExitReason,
  type PersistedSession,
  type SessionExit,
  type SessionStore,
} from "../src/events.js";
import { SessionRegistry, autoResumable, revivableByPrompt, reduceAgentState, resumeBackoffMs, MAX_IDLE_RELEASE_MINUTES, SESSION_CREATE_BURST, SessionLimitError, TURN_SILENCE_MS, stoppedWithBackgroundWork, clearedWithBackgroundWork } from "../src/registry.js";
import {
  MAX_ASYNC_TASK_ID_CHARS,
  MAX_ASYNC_TASK_NAME_CHARS,
  MAX_ASYNC_TASK_TEXT_CHARS,
  MAX_TRACKED_ASYNC_TASKS,
} from "../src/acp/asynctasks.js";
import { IdleParking } from "../src/idlepark.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { check, report } from "./daemoncheck.env.js";
import {
  users,
  now,
  tokenFor,
  verifier,
  storeOf,
  rowFor,
  credentials,
  stubAgentConfig,
} from "./daemoncheck.fixtures.js";

process.stdout.write("\nwhich sessions the daemon brings back\n");
{
  const exitOf = (reason: ExitReason): SessionExit => ({
    reason,
    at: now,
    detail: null,
    agentHandle: null,
    agentConfirmedDead: true,
  });
  const boot = (reason: ExitReason): boolean => autoResumable(exitOf(reason), "a_1", "boot");
  const typed = (reason: ExitReason): boolean => autoResumable(exitOf(reason), "a_1", "prompt");

  // No exhaustiveness check needed: `autoResumable`'s switch has no default, so a new `ExitReason` is a compile error.
  check("a graceful restart comes back at boot", boot("daemon_shutdown"), true);
  check("and so does a crash", boot("daemon_restarted"), true);
  check("a session somebody stopped never comes back on its own", boot("stopped"), false);
  check("but typing into it starts it again", typed("stopped"), true);
  check("nor does one that never started", [boot("start_failed"), boot("start_timeout")], [false, false]);
  // `agent_kill_failed` stays out: a legacy row may be a user's Stop, and the old agent may still hold the conversation file.
  check("nor an ambiguous legacy kill", [boot("agent_kill_failed"), typed("agent_kill_failed")], [false, false]);
  // Asymmetric on purpose: the boot pass has no recency fence, so an agent that quit on its own waits for a prompt.
  check("an agent that quit on its own waits to be asked", [boot("agent_exited"), typed("agent_exited")], [false, true]);
  check("a signed-out conversation waits to be asked too", [boot("agent_signed_out"), typed("agent_signed_out")], [false, true]);
  // Parked: `false` at boot is the load-bearing half, or a boot pass hands back all the memory parking released at once.
  check("a released agent is not brought back by a boot pass", boot("parked"), false);
  check("and comes back when somebody types", typed("parked"), true);

  // `revivableByPrompt` must equal this table over the whole `EXIT_REASON_MEMBERS` union, never keep a reason set of its own.
  check(
    "and every reason a prompt revives is exactly the set that keeps its controls",
    (Object.keys(EXIT_REASON_MEMBERS) as ExitReason[]).filter((reason) => revivableByPrompt(reason, "a_1")).sort(),
    (Object.keys(EXIT_REASON_MEMBERS) as ExitReason[]).filter((reason) => typed(reason)).sort(),
  );
  check(
    "which is four of them and not the three that never had a conversation",
    (Object.keys(EXIT_REASON_MEMBERS) as ExitReason[]).filter((reason) => !revivableByPrompt(reason, "a_1")).sort(),
    ["agent_kill_failed", "start_failed", "start_timeout"],
  );
  check(
    "and none of them without an agent session id to return to",
    (Object.keys(EXIT_REASON_MEMBERS) as ExitReason[]).some((reason) => revivableByPrompt(reason, null)),
    false,
  );

  check(
    "and nothing resumes without an agent session id",
    (["daemon_shutdown", "daemon_restarted", "agent_exited"] as ExitReason[]).map((reason) =>
      autoResumable(exitOf(reason), null, "prompt"),
    ),
    [false, false, false],
  );

  const statusOf = (reason: ExitReason): string => {
    const store = storeOf([
      { ...rowFor(`s_${reason}`, join(users, "u_alice", "proj")), exit: exitOf(reason), agentSessionId: "a_1" },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store);
    own.restore({ reapOrphans: false });
    return own.get(`s_${reason}`)?.status ?? "missing";
  };

  check("a graceful shutdown reads as interrupted", statusOf("daemon_shutdown"), "interrupted");
  check("and so does a crash", statusOf("daemon_restarted"), "interrupted");
  check("a stop reads as exited", statusOf("stopped"), "exited");
  check("an agent quitting reads as exited", statusOf("agent_exited"), "exited");
  check("a failed start reads as failed", [statusOf("start_failed"), statusOf("start_timeout")], ["failed", "failed"]);
  // `parked` needs its own arm in `ManagedSession.status`: that switch defaults to `exited`, so the compiler cannot catch a miss.
  check("a released agent reads as parked", statusOf("parked"), "parked");
  check("and not as exited, which is what nobody deciding looks like", statusOf("parked") === statusOf("stopped"), false);

  // Full jitter over `[0, capped)`, not the relay's ±20% band: sessions retried together must desynchronise.
  check("no jitter means no wait at all", [1, 2, 5].map((n) => resumeBackoffMs(n, () => 0)), [0, 0, 0]);
  check(
    "and the ceiling grows then clamps",
    [1, 2, 3, 4, 5, 6, 9].map((n) => resumeBackoffMs(n, () => 0.999999)),
    [1999, 3999, 7999, 15999, 31999, 59999, 59999],
  );
}

process.stdout.write("\nputting agents back on interrupted sessions\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  interface Rig {
    runtime: LocalRuntime;
    // The silence sweep ends a turn locally and leaves the request outstanding, so an agent can still reply to it.
    answerStalled: () => boolean;
    stalledCount: () => number;
    // Every method sent, notifications included: the only observable for what was not sent.
    inbound: () => readonly string[];
    launches: () => number;
    resumes: () => { sessionId: string; cwd: string; mcpServers: unknown }[];
    fileIoAtResume: () => boolean[];
    peak: () => number;
    // Counted via `endStdin`, the first rung of `AcpClient.doClose`; an agent never disposed is an orphan.
    disposed: () => number;
    configSets: () => { id: string; value: unknown }[];
    caps: () => Record<string, unknown>;
    notify: (sessionId: string, update: Record<string, unknown>) => void;
    stops: () => { sessionId: string; asyncTaskId: string }[];
  }

  // Fresh pipes per launch: an ended `PassThrough` is spent.
  const rigWith = (options: {
    resume: boolean;
    failResume?: boolean;
    /** Answer `session/resume` with JSON-RPC -32002, as claude does for a lost conversation. */
    forgotten?: boolean;
    // Refuse `session/resume` with -32603 only while file IO is declared, as kimi 0.29.2 does for a plan-mode session.
    hatesFileIo?: boolean;
    stallMs?: number;
    stallPrompt?: boolean;
    // Publishes one `select` option and accepts `session/set_config_option` on it.
    config?: boolean;
    // `true` and `false` are ordinary answers (false: already finished); "error" is the third. Default `true`.
    stopAnswer?: boolean | "error";
    // The AIR `_meta` on `initialize`: `true` is claude-agent-acp's shape, absent/false is none, "old" a lower version, "unnamed" lacks `asyncTasks`.
    advertisesTasks?: boolean | "old" | "unnamed";
    // Fires inside `restoreConfig`'s replay, after `session` is assigned: the one window where a tap could be silently overwritten.
    onConfigSet?: () => void;
  }): Rig => {
    let launched = 0;
    let opened = 0;
    let live = 0;
    let peak = 0;
    let ended = 0;
    let declaredFileIo = false;
    const fileIoAtResume: boolean[] = [];
    const resumes: { sessionId: string; cwd: string; mcpServers: unknown }[] = [];
    const configSets: { id: string; value: unknown }[] = [];
    const stops: { sessionId: string; asyncTaskId: string }[] = [];
    const stalled: (() => void)[] = [];
    const inbound: string[] = [];
    let caps: Record<string, unknown> = {};
    // Keyed by session, not launch: each agent has its own pipes, so one captured `send` addresses whichever started last.
    const pushes = new Map<string, (message: unknown) => void>();
    // ACP's wire shape (`type`/`currentValue`/`options`), not this daemon's `kind`/`value`/`choices`: `toConfigOptions` reads the wire shape.
    const modelOption = {
      id: "model",
      name: "Model",
      description: null,
      category: "model",
      type: "select",
      currentValue: "opus",
      options: [
        { value: "opus", name: "Opus" },
        { value: "sonnet", name: "Sonnet" },
      ],
    };
    const withValue = (value: unknown) => ({ ...modelOption, currentValue: value });

    class ResumeRig extends LocalRuntime {
      override describe(agent: AgentId): AgentLaunchConfig {
        return stubAgentConfig(agent);
      }

      override async launch(): Promise<AgentProcess> {
        launched += 1;
        const toAgent = new PassThrough();
        const toClient = new PassThrough();
        const send = (message: unknown): void => {
          toClient.write(`${JSON.stringify(message)}\n`);
        };

        let buffer = "";
        toAgent.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.trim().length === 0) continue;
            const message = JSON.parse(line) as Record<string, any>;
            const id = message["id"];
            // Recorded before dispatch: a notification such as `session/cancel` leaves no other trace.
            inbound.push(String(message["method"] ?? ""));
            switch (message["method"]) {
              case acp.methods.agent.initialize:
                caps = ((message["params"] as any)?.clientCapabilities ?? {}) as Record<string, unknown>;
                declaredFileIo =
                  (message["params"] as any)?.clientCapabilities?.fs?.readTextFile === true;
                send({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    protocolVersion: acp.PROTOCOL_VERSION,
                    // A marker object, as real adapters send it: `supportsSessionResume` reads `!= null`.
                    agentCapabilities: options.resume ? { sessionCapabilities: { resume: {} } } : {},
                    authMethods: [],
                    ...(options.advertisesTasks === undefined || options.advertisesTasks === false
                      ? {}
                      : {
                          _meta: {
                            jetbrains: {
                              air: {
                                version: options.advertisesTasks === "old" ? 0 : 1,
                                capabilities:
                                  options.advertisesTasks === "unnamed" ? ["somethingElse"] : ["asyncTasks"],
                              },
                            },
                          },
                        }),
                  },
                });
                break;
              case acp.methods.agent.session.new:
                opened += 1;
                pushes.set(`conv_${opened}`, send);
                send({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    sessionId: `conv_${opened}`,
                    ...(options.config === true ? { configOptions: [modelOption] } : {}),
                  },
                });
                break;
              case acp.methods.agent.session.setConfigOption: {
                const params = message["params"] as Record<string, any>;
                configSets.push({ id: String(params["configId"]), value: params["value"] });
                options.onConfigSet?.();
                send({
                  jsonrpc: "2.0",
                  id,
                  result: { configOptions: [withValue(params["value"])] },
                });
                break;
              }
              case acp.methods.agent.session.resume: {
                const params = message["params"] as Record<string, any>;
                pushes.set(String(params["sessionId"]), send);
                fileIoAtResume.push(declaredFileIo);
                resumes.push({
                  sessionId: String(params["sessionId"]),
                  cwd: String(params["cwd"]),
                  mcpServers: params["mcpServers"],
                });
                live += 1;
                peak = Math.max(peak, live);
                // A gap per resume, or each completes before the next begins and the concurrency bound is unfalsifiable.
                setTimeout(() => {
                  live -= 1;
                  if (options.hatesFileIo === true && declaredFileIo) {
                    send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
                  } else if (options.forgotten === true) {
                    // Byte-for-byte what `RequestError.resourceNotFound` produces.
                    send({
                      jsonrpc: "2.0",
                      id,
                      error: { code: -32002, message: `Resource not found: ${String(params["sessionId"])}` },
                    });
                  } else if (options.failResume === true) {
                    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "no such conversation" } });
                  } else {
                    send({
                      jsonrpc: "2.0",
                      id,
                      result: options.config === true ? { configOptions: [modelOption] } : {},
                    });
                  }
                }, options.stallMs ?? 15);
                break;
              }
              case acp.methods.agent.session.prompt:
                if (options.stallPrompt === true) {
                  stalled.push(() => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
                  break;
                }
                send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
                break;
              // Written out, not left to `default`: its `{}` reads as `stopped: false`.
              case "_session/async_task/stop": {
                const params = message["params"] as Record<string, any>;
                stops.push({
                  sessionId: String(params["sessionId"]),
                  asyncTaskId: String(params["asyncTaskId"]),
                });
                if (options.stopAnswer === "error") {
                  send({ jsonrpc: "2.0", id, error: { code: -32603, message: "task is not stoppable" } });
                } else {
                  send({ jsonrpc: "2.0", id, result: { stopped: options.stopAnswer ?? true } });
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
          endStdin: () => {
            ended += 1;
            toAgent.end();
          },
          kill: async () => {},
        } as unknown as AgentProcess;
      }
    }

    return {
      runtime: new ResumeRig(),
      answerStalled: (): boolean => {
        const reply = stalled.shift();
        reply?.();
        return reply !== undefined;
      },
      stalledCount: () => stalled.length,
      inbound: () => inbound,
      launches: () => launched,
      resumes: () => resumes,
      fileIoAtResume: () => fileIoAtResume,
      peak: () => peak,
      disposed: () => ended,
      configSets: () => configSets,
      caps: () => caps,
      stops: () => stops,
      notify: (sessionId, update) => {
        pushes.get(sessionId)?.({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
        });
      },
    };
  };

  const interruptedRow = (id: string, reason: ExitReason, agentSessionId: string | null, create = true) => {
    const root = join(users, "u_alice", `wt_${id}`);
    const row = create
      ? rowFor(id, root)
      : { ...rowFor(id, join(users, "u_alice", "proj")), workspace: { ...rowFor(id, join(users, "u_alice", "proj")).workspace, root: join(users, "u_alice", "gone_forever"), requestedCwd: join(users, "u_alice", "gone_forever") } };
    return {
      ...row,
      agentSessionId,
      // One turn: a conversation with no turns has no transcript on disk and is opened fresh rather than resumed.
      turnCounter: 1,
      exit: { reason, at: now, detail: null, agentHandle: null, agentConfirmedDead: true },
    };
  };

  // No wall clock: `random` pins the jitter and `delay` makes the backoff free.
  const options = { random: () => 0, delay: async (): Promise<void> => {} };

  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      { ...interruptedRow("s_back", "daemon_restarted", "a_back"), turnCounter: 3 },
      interruptedRow("s_stopped", "stopped", "a_stopped"),
      interruptedRow("s_noid", "daemon_shutdown", null),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    const back = own.get("s_back");
    check("an interrupted session comes back idle", back?.status, "idle");
    check("with its exit cleared", back?.exit, null);
    check("and the agent's own id untouched", back?.agentSessionId, "a_back");
    check("a stopped one is left alone", own.get("s_stopped")?.status, "exited");
    check("and one with nothing to reattach to is not even considered", own.get("s_noid")?.status, "interrupted");
    check("the report counts what it did", [report.considered, report.resumed], [1, 0 + 1]);

    // The load-bearing check: `session/new` would also leave it idle, with an empty conversation.
    check("the agent was actually asked to resume", rig.resumes().length, 1);
    check(
      "with the id and cwd it was supposed to get",
      rig.resumes()[0],
      { sessionId: "a_back", cwd: back?.cwd, mcpServers: [] },
    );

    const promptResult = back?.prompt("hello");
    check(
      "a prompt after a resume continues the turn count",
      promptResult?.kind === "accepted" ? promptResult.turn : promptResult?.kind,
      4,
    );
    await own.shutdown();
  }

  // A missing CLI spends no attempt and is not given up on: it waits as `agent_missing` for a pass after the install (Q4.114).
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_nocli", "daemon_restarted", "a_nocli")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const describe = rig.runtime.describe.bind(rig.runtime);
    let installed = false;
    // `describe` is what `resolveAgent` reaches through, so this throws the real refusal before any spawn.
    rig.runtime.describe = (agent: AgentId): AgentLaunchConfig => {
      if (!installed) {
        throw new AgentUnavailableError("opencode not found on this daemon's PATH. deploy/agents.sh installs it (or `curl -fsSL https://opencode.ai/install | bash`).", {
          installable: true,
        });
      }
      return describe(agent);
    };
    const outcomes: string[] = [];
    const first = await own.autoResume({ ...options, concurrency: 1, onOutcome: (one) => void outcomes.push(`${one.result}:${one.attempt}`) });
    const waiting = own.get("s_nocli");
    check("a harness with no CLI is reported as missing, once, with no attempt spent", outcomes, ["agent_missing:0"]);
    check("and counted as deferred rather than failed", [first.considered, first.deferred, first.failed, first.resumed], [1, 1, 0, 0]);
    check("the session is still interrupted", waiting?.status, "interrupted");
    check("not given up on", waiting?.resumeAbandoned, null);
    check("and its snapshot says it is waiting, and why, with no attempt on it", [waiting?.snapshot().resume?.state, waiting?.snapshot().resume?.attempts, waiting?.snapshot().resume?.error?.code], ["waiting", 0, "agent_unavailable"]);
    check("without an error event in its log", waiting?.snapshot().lastSeq, own.get("s_nocli")?.snapshot().lastSeq);
    check("and nothing was spawned to find that out", rig.launches(), 0);
    installed = true;
    const second = await own.autoResume({ ...options, concurrency: 1, onOutcome: (one) => void outcomes.push(`${one.result}:${one.attempt}`) });
    check("the pass after the install brings it back", [second.considered, second.resumed, own.get("s_nocli")?.status], [1, 1, "idle"]);
    check("on its first attempt, since the deferral spent none", outcomes.at(-1), "resumed:1");
    check("and the snapshot has forgotten the wait", own.get("s_nocli")?.snapshot().resume ?? null, null);
    await own.shutdown();
  }

  // Only an `installable` absence is deferred; a plain `AgentUnavailableError` spends attempts and settles to `attempts_exhausted`.
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_noadapter", "daemon_restarted", "a_noadapter")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    rig.runtime.describe = (): AgentLaunchConfig => {
      throw new AgentUnavailableError("claude-agent-acp not found on PATH; run `pnpm install` in the project root.");
    };
    const outcomes: string[] = [];
    const report = await own.autoResume({ ...options, concurrency: 1, onOutcome: (one) => void outcomes.push(one.result) });
    check("an absence the installer cannot repair spends the attempts as before", outcomes, ["failed", "failed", "attempts_exhausted"]);
    check("and is failed rather than deferred", [report.considered, report.deferred, report.failed], [1, 0, 1]);
    check("with the verdict on the snapshot", own.get("s_noadapter")?.snapshot().resume?.state, "failed");
    check("and nothing spawned to reach it", rig.launches(), 0);
    await own.shutdown();
  }

  {
    const rig = rigWith({ resume: true, stallMs: 40 });
    const store = storeOf([interruptedRow("s_one", "daemon_restarted", "a_one"), interruptedRow("s_two", "daemon_restarted", "a_two")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const order: string[] = [];
    const a = own.autoResume({ ...options, concurrency: 1, onOutcome: (one) => void order.push(`a:${one.sessionId}`) });
    const b = own.autoResume({ ...options, concurrency: 1, onOutcome: (one) => void order.push(`b:${one.sessionId}`) });
    const [ra, rb] = await Promise.all([a, b]);
    check("the first pass resumes both", [ra.considered, ra.resumed], [2, 2]);
    check("and the second, queued behind it, finds nothing left to do", [rb.considered, rb.resumed], [0, 0]);
    check("in that order", order.every((one) => one.startsWith("a:")), true);
    check("with each agent asked to resume exactly once", rig.resumes().length, 2);
    await own.shutdown();
  }

  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_live", "daemon_restarted", "a_live")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });

    check("a restored session is not live until it is resumed", own.liveSessionCount, 0);
    await own.autoResume({ ...options, concurrency: 1 });
    check("and is live once an agent is back in front of it", own.liveSessionCount, 1);

    const refusal = async (cwd: string): Promise<string> =>
      own.create({ agent: "kimi", cwd }).then(
        () => "created",
        (error: unknown) => (error instanceof SessionLimitError ? error.reason : (error as Error).name),
      );

    // The ordering is the assertion: the ceiling must refuse before `resolveCwd` touches the filesystem.
    const gone = join(users, "u_alice", "no_such_dir_at_all");
    // `ceilingFloorMs: 0` is what lets these cases reach the eviction; the real floor is asserted below (Q2.228, Q7.113).
    own.setSessionLimits({ live: 1, ceilingFloorMs: 0 });

    check("at the ceiling, a create takes a quiet session's slot", await refusal(gone), "PathError");
    check("and takes it losslessly, without ending anything", [own.get("s_live")?.status, own.get("s_live")?.exit?.reason], ["parked", "parked"]);
    check("so the machine is still inside its ceiling", own.liveSessionCount, 0);

    // `releaseOneSlot` must respect `CEILING_PARK_FLOOR_MS`: a just-idle agent may be running unreported background work (Q2.228, Q7.113).
    await own.get("s_live")?.resume();
    check("a quiet agent is back for the floor case", own.get("s_live")?.status, "idle");
    own.setSessionLimits({ live: 1, ceilingFloorMs: 2 * 60_000 });
    check("a just-idle agent is not taken for a slot", await refusal(gone), "too_many_sessions");
    check("and it still has its agent", own.get("s_live")?.status, "idle");
    own.setSessionLimits({ live: 1, ceilingFloorMs: 0 });
    check("while with the floor faked away it is", await refusal(gone), "PathError");
    check("and that is where the slot came from", own.get("s_live")?.exit?.reason, "parked");
    own.setSessionLimits({ live: 8, ceilingFloorMs: 0 });

    const busyStore = storeOf([interruptedRow("s_busy_cap", "daemon_restarted", "a_busy_cap")]);
    const busyRig = rigWith({ resume: true, stallPrompt: true });
    const busy = new SessionRegistry(new MemoryEventStore(), busyStore, undefined, busyRig.runtime);
    busy.restore({ reapOrphans: false });
    await busy.autoResume({ ...options, concurrency: 1 });
    busy.get("s_busy_cap")?.prompt("keep working");
    busy.setSessionLimits({ live: 1, ceilingFloorMs: 0 });
    check("the one live session is working", busy.get("s_busy_cap")?.status, "running");
    const refusedBusy = await busy
      .create({ agent: "kimi", cwd: gone })
      .then(() => "created", (error: unknown) => (error instanceof SessionLimitError ? error.reason : (error as Error).name));
    check("with nothing to take, the ceiling still refuses before it touches the path", refusedBusy, "too_many_sessions");
    check("and the working session was not touched", busy.get("s_busy_cap")?.status, "running");
    await busy.shutdown();

    // The control: with room the same request reaches PathError, so the refusal above was for the reason it claims.
    own.setSessionLimits({ live: 8, ceilingFloorMs: 0 });
    check("and with room it reaches the path check as before", await refusal(gone), "PathError");

    // Idle release switched off must still let a create through when there is room.
    own.setSessionLimits({ live: 8, idleParkMs: 0, ceilingFloorMs: 0 });
    check("a machine that never releases still starts sessions", await refusal(gone), "PathError");
    check("and says so about itself", own.idleParkEnabled, false);
    check("and its sweep really does release nothing", await own.parkIdleSessions(now + 365 * 24 * 60 * 60_000), []);

    await own.get("s_live")?.resume();
    check("with a quiet agent back in front of that conversation", own.get("s_live")?.status, "idle");
    own.setSessionLimits({ live: 1, idleParkMs: 0, ceilingFloorMs: 0 });
    check("but at the ceiling it declines to take one anyway", await refusal(gone), "too_many_sessions");
    check("and the quiet session it would have taken is untouched", own.get("s_live")?.status, "idle");
    own.setSessionLimits({ live: 8, idleParkMs: 45 * 60_000, ceilingFloorMs: 0 });

    // Stopping makes a session non-live, so a create-and-stop loop walks past the ceiling; a refused create still spends a slot.
    own.setSessionLimits({ burst: 2, refillMs: 600_000 });
    check("the first creation inside the burst is only refused by the path", await refusal(gone), "PathError");
    check("and so is the second", await refusal(gone), "PathError");
    check("the third is rate limited", await refusal(gone), "session_rate_limited");

    const waited = await own.create({ agent: "kimi", cwd: gone }).then(
      () => -1,
      (error: unknown) => (error instanceof SessionLimitError ? error.retryAfterSeconds : -1),
    );
    report("and says how long to wait", waited > 0 && waited <= 600, `retryAfterSeconds: ${waited}`);

    own.setSessionLimits({ burst: 1, refillMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    check("a slot comes back on its own", await refusal(gone), "PathError");

    await own.shutdown();
  }

  // REEMOAT_SESSION_CREATE_BURST above the default is a raise at boot, and the refill is too slow to reach it.
  {
    const gone = join(users, "u_alice", "no_such_dir_at_all");
    // PathError is a creation the bucket let through; the missing cwd stops it before anything is spawned.
    const spend = async (registry: SessionRegistry, times: number): Promise<Record<string, number>> => {
      const counts: Record<string, number> = {};
      for (let i = 0; i < times; i += 1) {
        const answer = await registry.create({ agent: "kimi", cwd: gone }).then(
          () => "created",
          (error: unknown) => (error instanceof SessionLimitError ? error.reason : (error as Error).name),
        );
        counts[answer] = (counts[answer] ?? 0) + 1;
      }
      return counts;
    };

    const raised = new SessionRegistry(new MemoryEventStore());
    raised.setSessionLimits({ burst: SESSION_CREATE_BURST * 2, refillMs: 600_000 });
    check(
      "a raised burst is there at once, and the creation past it is rate limited",
      await spend(raised, SESSION_CREATE_BURST * 2 + 1),
      { PathError: SESSION_CREATE_BURST * 2, session_rate_limited: 1 },
    );
    raised.setSessionLimits({ burst: SESSION_CREATE_BURST * 2 + 2 });
    check("raising it again adds only the new headroom, refunding nothing spent", await spend(raised, 3), {
      PathError: 2,
      session_rate_limited: 1,
    });

    const lowered = new SessionRegistry(new MemoryEventStore());
    lowered.setSessionLimits({ burst: 2, refillMs: 600_000 });
    check("while a lowered one still clamps what the bucket held", await spend(lowered, 3), {
      PathError: 2,
      session_rate_limited: 1,
    });

    await raised.shutdown();
    await lowered.shutdown();
  }

  // A boot pass may not evict: it wakes most recent first and eviction takes least recent, so it would park what it just restored.
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      interruptedRow("s_boot_a", "daemon_restarted", "a_boot_a"),
      interruptedRow("s_boot_b", "daemon_restarted", "a_boot_b"),
      interruptedRow("s_boot_c", "daemon_restarted", "a_boot_c"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    // `ceilingFloorMs: 0` because these resume in the same millisecond the create below asks for a slot; the floor is asserted above.
    own.setSessionLimits({ live: 2, idleParkMs: 45 * 60_000, ceilingFloorMs: 0 });
    await own.autoResume({ ...options, concurrency: 1 });

    const reasons = ["s_boot_a", "s_boot_b", "s_boot_c"].map((id) => own.get(id)?.exit?.reason ?? "live");
    check("a restart parks nothing it just brought back", reasons, ["live", "live", "live"]);
    check("and holds every conversation, over the ceiling rather than under it", own.liveSessionCount, 3);

    const gone = join(users, "u_alice", "no_such_dir_at_all");
    const outcome = await own.create({ agent: "kimi", cwd: gone }).then(
      () => "created",
      (error: unknown) => (error instanceof SessionLimitError ? error.reason : (error as Error).name),
    );
    check("but somebody asking for a new one still frees a slot", outcome, "PathError");
    check("by taking the least recently used, which is the first one back", own.get("s_boot_a")?.exit?.reason, "parked");

    await own.shutdown();
  }

  // Driven through the real registry: `status` is derived, so a fixture that set it would assert against the thing under test (Q2.224).
  {
    const rig = rigWith({ resume: true, stallPrompt: true });
    const store = storeOf([
      interruptedRow("s_quiet", "daemon_restarted", "a_quiet"),
      interruptedRow("s_busy", "daemon_restarted", "a_busy"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });

    const quiet = own.get("s_quiet");
    const busy = own.get("s_busy");
    check("two conversations, two agents", [own.liveSessionCount, quiet?.status, busy?.status], [2, "idle", "idle"]);

    // Asserted first: a sweep that took everything regardless of age would satisfy every row below.
    check("a session that has just spoken is left alone", await own.parkIdleSessions(now), []);
    check("and it still has its agent", own.liveSessionCount, 2);

    const sent = busy?.prompt("keep working");
    check("the busy one is working", [sent?.kind, busy?.status], ["accepted", "running"]);

    const later = now + 31 * 60_000;
    const parked = await own.parkIdleSessions(later);
    check("the quiet one is released", parked, ["s_quiet"]);
    check("and the working one is not, however long the turn runs", busy?.status, "running");
    check("so the machine holds one agent for two conversations", own.liveSessionCount, 1);

    check("the conversation is still there", own.get("s_quiet") !== undefined, true);
    check("with the agent's own id kept, which is what it comes back on", quiet?.agentSessionId, "a_quiet");
    check("and it does not read as stopped", quiet?.status, "parked");
    check("nor as something the daemon is coming back for by itself", quiet?.exit?.reason, "parked");

    check("a session already released is not released again", await own.parkIdleSessions(later), []);

    // A person's Stop must still end a parked conversation, and the status must follow the reason.
    await quiet?.stop("stopped");
    check("a person can end a released conversation", quiet?.exit?.reason, "stopped");
    check("and it reads as ended, because this time somebody decided", quiet?.status, "exited");
    check("and it is not brought back at the next boot", autoResumable(quiet?.exit ?? null, quiet?.agentSessionId ?? null, "boot"), false);
    // `stopped` answers true on a prompt: a message revives a conversation somebody ended.
    check("but a message does bring it back, which is the other half of that arm", autoResumable(quiet?.exit ?? null, quiet?.agentSessionId ?? null, "prompt"), true);

    await own.shutdown();
  }

  // `session/prompt` has no deadline, so the silence sweep is the only thing that can end a turn the agent never answers.
  {
    const rig = rigWith({ resume: true, stallPrompt: true });
    const store = storeOf([
      interruptedRow("s_wedged", "daemon_restarted", "a_wedged"),
      interruptedRow("s_awake", "daemon_restarted", "a_awake"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

    const wedged = own.get("s_wedged");
    const awake = own.get("s_awake");
    const endsOf = (id: string) =>
      (own.get(id)?.log.read(0, 1000, 1 << 20) ?? [])
        .map((stored) => stored.event)
        .filter((event) => event.type === "turn_end")
        .map((event) => (event.type === "turn_end" ? event.stopReason : null));

    const sent = await wedged?.prompt("say something");
    await settle();
    // The clock is taken after the prompt, not from `now`, which is stamped when the fixtures module is first imported.
    const started = Date.now();
    check("a prompt nobody answers leaves the session running", [sent?.kind, wedged?.status], ["accepted", "running"]);
    check("and the rig really is sitting on it", rig.stalledCount(), 1);

    check("a turn that has just started is left alone", own.abandonWedgedTurns(started), []);
    check("and so is one still inside the window", own.abandonWedgedTurns(started + 179 * 60_000), []);

    const later = started + 181 * 60_000;
    check("past it the daemon stops waiting, and only on the turn", own.abandonWedgedTurns(later), ["s_wedged"]);
    check("the idle conversation beside it is untouched at the same age", [awake?.status, awake?.exit], ["idle", null]);

    // The ending goes through the queue the turn's generator waits on, so `pump`'s finally lands a tick later.
    await settle();

    check("and the session is idle rather than ended", [wedged?.status, wedged?.exit], ["idle", null]);
    check("the conversation is still there, with its agent", [own.get("s_wedged") !== undefined, wedged?.agentSessionId], [true, "a_wedged"]);
    check("the turn is closed in the transcript, once, and says why", endsOf("s_wedged"), ["abandoned"]);
    // Asserted on the methods sent: a `session/cancel` notification from `abandonTurn` would otherwise pass unseen (Q2.42).
    check(
      "and nothing was sent to the agent to make it happen",
      rig.inbound().filter((method) => method.startsWith("session/") && method !== "session/prompt"),
      ["session/resume", "session/resume"],
    );
    check("a turn already given up on is not given up on twice", own.abandonWedgedTurns(later), []);

    // `abandonTurn` must clear `turnActive` itself, or every later prompt is refused as already in flight.
    const again = await wedged?.prompt("are you there");
    await settle();
    check("and the next message really does start a turn", [again?.kind, wedged?.status], ["accepted", "running"]);
    check("rather than being refused as one already in flight", rig.stalledCount(), 2);
    const errors = (wedged?.log.read(0, 1000, 1 << 20) ?? [])
      .map((stored) => stored.event)
      .filter((event) => event.type === "error");
    check("with nothing recorded about a prompt in flight", errors.length, 0);

    // The abandoned request's late answer is fenced on its epoch, so it ends neither its closed turn nor the live one.
    check("the agent's late answer is accepted by the rig", rig.answerStalled(), true);
    await settle();
    check("but it does not end the turn it no longer belongs to", endsOf("s_wedged"), ["abandoned"]);
    check("and the live turn is still live", wedged?.status, "running");

    check("the second turn's own answer is the rig's", rig.answerStalled(), true);
    await settle();
    check("and it ends the turn it belongs to", endsOf("s_wedged"), ["abandoned", "end_turn"]);
    check("leaving the session idle and ordinary", wedged?.status, "idle");

    await own.shutdown();
  }

  // The silence clock is the agent's (`lastAgentActivityAt`): a person typing into a stuck turn must not reset it.
  {
    const rig = rigWith({ resume: true, stallPrompt: true });
    const store = storeOf([interruptedRow("s_poked", "daemon_restarted", "a_poked")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

    const poked = own.get("s_poked");
    await poked?.prompt("go and think about it");
    // 200ms either side of `started`: at millisecond resolution both clocks could otherwise land on the same number.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    check("a turn is open and nothing has answered it", [poked?.status, rig.stalledCount()], ["running", 1]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const agentClockBefore = poked?.lastAgentActivityAt ?? 0;
    const poke = await poked?.sendMidTurn("are you working?");
    await settle();
    check(
      "a message sent mid-turn is queued and written down",
      [poke?.kind, poke?.kind === "queued" && poke.seq > 0],
      ["queued", true],
    );
    check("and the agent was not sent it", rig.stalledCount(), 1);

    check(
      "the person's message moves the session's clock but not the agent's",
      [(poked?.lastActivityAt ?? 0) > (poked?.lastAgentActivityAt ?? 0), poked?.lastAgentActivityAt ?? 0],
      [true, agentClockBefore],
    );
    // At exactly the threshold: the agent's clock is 200ms past it and the session's 200ms short, so slack would not discriminate.
    check(
      "so the sweep still sees the silence it is measuring",
      own.abandonWedgedTurns(started + TURN_SILENCE_MS),
      ["s_poked"],
    );
    await settle();

    check("and the message it was holding is delivered rather than stranded", rig.stalledCount(), 2);
    check("as a turn of its own", poked?.status, "running");

    await own.shutdown();
  }

  {
    const rig = rigWith({ resume: true, stallPrompt: true });
    const store = storeOf([interruptedRow("s_forever", "daemon_restarted", "a_forever")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.setSessionLimits({ turnSilenceMs: 0 });
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const forever = own.get("s_forever");
    await forever?.prompt("say something");
    await new Promise((resolve) => setTimeout(resolve, 25));
    check("with the sweep off the switch says so", own.turnSilenceEnabled, false);
    check("and a wedged turn stays wedged, however long", own.abandonWedgedTurns(now + 365 * 24 * 60 * 60_000), []);
    check("which is the old behaviour, kept reachable on purpose", forever?.status, "running");
    await own.shutdown();
  }

  // Background work is invisible to `status`, so parking must defer on the task set fed from the wire (Q2.228).
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      interruptedRow("s_bg", "daemon_restarted", "a_bg"),
      interruptedRow("s_plain", "daemon_restarted", "a_plain"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

    // The only row with no second signal: an initialize `_meta` the adapter refuses switches task reporting off with no error.
    check("the daemon asks to hear about background work", rig.caps()["_meta"], {
      jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } },
    });

    rig.notify("a_bg", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "task_1",
      name: "sleep 600",
      taskType: "shell",
      description: "running the build",
      showInTranscript: false,
      canStop: true,
    });
    await settle();
    const bg = own.get("s_bg");
    check("the agent announced work and the session says so", bg?.snapshot().backgroundTasks.map((task) => [task.id, task.state]), [["task_1", "running"]]);
    check("and still reads as an ordinary quiet session", bg?.status, "idle");

    // The control: the two sessions are identical bar the announcement, so a clause that never parks claude fails here.
    check("the one with nothing running is still released", await own.parkIdleSessions(now + 31 * 60_000), ["s_plain"]);

    check("a session with work still running is not released", await own.parkIdleSessions(now + 24 * 60 * 60_000), []);
    check("and it still holds its agent", own.liveSessionCount, 1);

    rig.notify("a_bg", {
      sessionUpdate: "async_task_state_update",
      asyncTaskId: "task_1",
      state: "completed",
      summary: "build finished",
    });
    await settle();
    check("the work ending is on the wire", bg?.snapshot().backgroundTasks.map((task) => task.state), ["completed"]);
    check("and the same sweep now releases it", await own.parkIdleSessions(now + 24 * 60 * 60_000), ["s_bg"]);
    check("and a released session claims no running work", own.get("s_bg")?.snapshot().backgroundTasks, []);

    await own.shutdown();
  }

  // claude-agent-acp's `toAcpNotifications` numbers via `applyMessageId`, but `AsyncTaskRuntime` sends bare updates.
  // Once a connection has numbered one message, an unnumbered one gets a `~` id; an agent that numbers nothing keeps joining.
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      interruptedRow("s_num", "daemon_restarted", "a_num"),
      interruptedRow("s_bare", "daemon_restarted", "a_bare"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 2 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const say = (agent: string, text: string, messageId?: string): void =>
      rig.notify(agent, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        ...(messageId === undefined ? {} : { messageId }),
      });
    const idsOf = (id: string): unknown[] =>
      (own.get(id)?.log.read(0, 1000, 1024 * 1024) ?? [])
        .filter((stored) => stored.event.type === "text")
        .map((stored) => (stored.event as { messageId: string | null }).messageId);

    say("a_num", "he", "m1");
    say("a_num", "llo", "m1");
    say("a_num", "**Task stopped by user:** one.");
    say("a_num", "**Task stopped by user:** two.");
    say("a_num", "back to prose", "m2");
    await settle();
    check(
      "the agent's own ids are carried, and what it left unnumbered gets a number here",
      idsOf("s_num"),
      ["m1", "m1", "~1", "~2", "m2"],
    );

    say("a_bare", "he");
    say("a_bare", "llo");
    await settle();
    check("while an agent that numbers nothing keeps joining as it always did", idsOf("s_bare"), [
      null,
      null,
    ]);
    await own.shutdown();
  }

  // A terminal state is not final: claude-agent-acp sends `stopped` then `completed` for one task, and the later word wins.
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_fix", "daemon_restarted", "a_fix")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    rig.notify("a_fix", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "t",
      name: "t",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    });
    rig.notify("a_fix", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "stopped" });
    await settle();
    check("a level-derived close lands first", own.get("s_fix")?.snapshot().backgroundTasks.map((task) => task.state), ["stopped"]);
    rig.notify("a_fix", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "completed" });
    await settle();
    check("and the real edge behind it corrects the row", own.get("s_fix")?.snapshot().backgroundTasks.map((task) => task.state), ["completed"]);
    // `endedAt` is the daemon's own stamp (nothing on the wire carries one), so relabelling a terminal row must not move it.
    const stampedAt = own.get("s_fix")?.snapshot().backgroundTasks[0]?.endedAt ?? null;
    check("the end was stamped when it ended", typeof stampedAt === "number" && stampedAt > 0, true);
    rig.notify("a_fix", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "failed" });
    await settle();
    check(
      "and a second terminal word relabels the row without moving its end",
      own.get("s_fix")?.snapshot().backgroundTasks.map((task) => [task.state, task.endedAt === stampedAt]),
      [["failed", true]],
    );
    rig.notify("a_fix", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "running" });
    await settle();
    check(
      "while a row that is running again has no end at all",
      own.get("s_fix")?.snapshot().backgroundTasks.map((task) => [task.state, task.endedAt]),
      [["running", null]],
    );
    rig.notify("a_fix", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "completed" });
    await settle();
    rig.notify("a_fix", {
      sessionUpdate: "async_task_progress",
      asyncTaskId: "t",
      toolCallId: "toolu_late",
      outputFilePath: "/tmp/x/tasks/t.output",
    });
    await settle();
    check(
      "and correlation that arrives late is merged rather than dropped",
      own.get("s_fix")?.snapshot().backgroundTasks.map((task) => [task.toolCallId, task.outputFilePath]),
      [["toolu_late", "/tmp/x/tasks/t.output"]],
    );
    await own.shutdown();
  }

  // `paused` looks finished and is not: the live test is the complement of the adapter's `isTerminal`.
  {
    const words = ["completed", "failed", "stopped", "paused"] as const;
    const released: string[] = [];
    for (const word of words) {
      const rig = rigWith({ resume: true });
      const store = storeOf([interruptedRow(`s_${word}`, "daemon_restarted", `a_${word}`)]);
      const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
      own.restore({ reapOrphans: false });
      await own.autoResume({ ...options, concurrency: 1 });
      const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
      rig.notify(`a_${word}`, {
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "t",
        name: "t",
        taskType: "shell",
        description: "",
        showInTranscript: false,
        canStop: true,
      });
      rig.notify(`a_${word}`, { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: word });
      await settle();
      const parked = await own.parkIdleSessions(now + 31 * 60_000);
      if (parked.length > 0) released.push(word);
      await own.shutdown();
    }
    check("the three terminal words release and paused does not", released, ["completed", "failed", "stopped"]);
  }

  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_only", "daemon_restarted", "a_only")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    own.setSessionLimits({ live: 1, ceilingFloorMs: 0 });
    const gone = join(users, "u_alice", "no_such_dir_at_all");
    const refusal = async (cwd: string): Promise<string> =>
      own.create({ agent: "kimi", cwd }).then(
        () => "created",
        (error: unknown) => (error instanceof SessionLimitError ? error.reason : (error as Error).name),
      );

    check("with nothing running, the one idle agent is still taken for a slot", await refusal(gone), "PathError");
    check("and that is where the slot came from", own.get("s_only")?.exit?.reason, "parked");

    await own.get("s_only")?.resume();
    rig.notify("a_only", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "build",
      name: "build",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    });
    await settle();
    check("but an agent running something is not, and the create is refused", await refusal(gone), "too_many_sessions");
    check("and it still has its agent", own.get("s_only")?.status, "idle");

    // A stop clears the task set (the agent's shutdown kills those processes) and says so in one row, not one per task.
    await own.get("s_only")?.stop("stopped");
    const said = (own.get("s_only")?.log.read(0, 1000, 1024 * 1024) ?? [])
      .filter((stored) => stored.event.type === "error")
      .map((stored) => (stored.event as { message: string }).message);
    check("a stop says what it was still running, once", said, [stoppedWithBackgroundWork(1)]);
    check("and the session then claims nothing", own.get("s_only")?.snapshot().backgroundTasks, []);
    // The sentence names the agent: `doStop` also runs on `daemon_shutdown` and `config_changed`, where the session has not ended.
    check(
      "and it is the agent that was shut down, never the session that ended",
      [stoppedWithBackgroundWork(1).includes("session"), stoppedWithBackgroundWork(2)],
      [false, "the agent was still running 2 background tasks when it was shut down"],
    );

    await own.shutdown();
  }

  // Parking must be invisible (Q2.224): commands and controls stay published and nothing is written to the transcript.
  {
    const rig = rigWith({ resume: true, config: true });
    const store = storeOf([interruptedRow("s_hush", "daemon_restarted", "a_hush")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const hush = own.get("s_hush");

    rig.notify("a_hush", {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "clear", description: "start over" }],
    });
    await settle();
    const liveCommands = hush?.snapshot().agentConfig;
    check("a live session publishes its commands", hush?.agentCommands.commands.map((c) => c.name), ["clear"]);
    const revisionBefore = hush?.snapshot().commandsRevision;

    check("it is released after a quiet spell", await own.parkIdleSessions(now + 31 * 60_000), ["s_hush"]);
    check("and the menu it offers is the one it had", hush?.agentCommands.commands.map((c) => c.name), ["clear"]);
    check("with no revision bump, since nothing about the list changed", hush?.snapshot().commandsRevision, revisionBefore);
    check("its controls are still there, which is the rule this follows", hush?.snapshot().agentConfig, liveCommands);
    check(
      "and nothing at all was written into the conversation but the status",
      (own.get("s_hush")?.log.read(0, 1000, 1024 * 1024) ?? [])
        .filter((stored) => stored.event.type === "error")
        .map((stored) => (stored.event as { message: string }).message),
      [],
    );

    await own.shutdown();
  }

  // `MAX_TRACKED_ASYNC_TASKS` counts live tasks, not rows: a finished row is evicted to track a new live one.
  {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const spawn = (id: string, extra: Record<string, unknown> = {}) => ({
      sessionUpdate: "async_task_spawned",
      asyncTaskId: id,
      name: id,
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
      ...extra,
    });
    const ended = (id: string, state: string) => ({
      sessionUpdate: "async_task_state_update",
      asyncTaskId: id,
      state,
    });

    const rig = rigWith({ resume: true });
    const own = new SessionRegistry(
      new MemoryEventStore(),
      storeOf([interruptedRow("s_cap", "daemon_restarted", "a_cap")]),
      undefined,
      rig.runtime,
    );
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });

    for (let i = 0; i < MAX_TRACKED_ASYNC_TASKS; i += 1) {
      rig.notify("a_cap", spawn(`done_${i}`));
      rig.notify("a_cap", ended(`done_${i}`, "completed"));
    }
    await settle();
    const capped = own.get("s_cap");
    check(
      "a session fills to the cap with finished work",
      capped?.snapshot().backgroundTasks.length,
      MAX_TRACKED_ASYNC_TASKS,
    );
    check(
      "and none of it is still running",
      capped?.snapshot().backgroundTasks.every((task) => task.state === "completed"),
      true,
    );
    // The sweep is not run here: it would dispose the agent and every notify below would assert nothing.
    rig.notify("a_cap", spawn("the_build"));
    await settle();
    const after = capped?.snapshot().backgroundTasks ?? [];
    check(
      "the next real build is tracked rather than dropped on the floor",
      after.find((task) => task.id === "the_build")?.state,
      "running",
    );
    check("the oldest finished row was spent to make room, not a live one", after.length, MAX_TRACKED_ASYNC_TASKS);
    check("and the row given up is the one that ended first", after.some((task) => task.id === "done_0"), false);
    check(
      "so the sweep defers over it, which is the whole point of the clause",
      await own.parkIdleSessions(now + 24 * 60 * 60_000),
      [],
    );

    for (let i = 0; i < MAX_TRACKED_ASYNC_TASKS; i += 1) rig.notify("a_cap", spawn(`live_${i}`));
    await settle();
    const all = capped?.snapshot().backgroundTasks ?? [];
    check("a set that is entirely live still refuses a further id", all.length, MAX_TRACKED_ASYNC_TASKS);
    check("and none of what it holds was given up to take it", all.every((task) => task.state === "running"), true);

    await own.shutdown();
  }

  {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const rig = rigWith({ resume: true });
    const own = new SessionRegistry(
      new MemoryEventStore(),
      storeOf([interruptedRow("s_again", "daemon_restarted", "a_again")]),
      undefined,
      rig.runtime,
    );
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const base = {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "t",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    };
    rig.notify("a_again", { ...base, name: "first" });
    rig.notify("a_again", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "completed" });
    await settle();
    const endedAt = own.get("s_again")?.snapshot().backgroundTasks[0]?.endedAt ?? null;
    rig.notify("a_again", { ...base, name: "second" });
    await settle();
    const row = own.get("s_again")?.snapshot().backgroundTasks[0];
    check("a repeat spawn does not resurrect a task that ended", row?.state, "completed");
    check("and does not move the end it was stamped with", row?.endedAt, endedAt);
    check("what it describes is still taken, since that is news", row?.name, "second");
    check(
      "so the sweep is not re-armed over work that is over",
      await own.parkIdleSessions(now + 24 * 60 * 60_000),
      ["s_again"],
    );
    await own.shutdown();
  }

  // `readAsyncTaskEdge` drops an unreadable update whole, so an unknown state word leaves the task live and deferring.
  {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const rig = rigWith({ resume: true });
    const own = new SessionRegistry(
      new MemoryEventStore(),
      storeOf([interruptedRow("s_read", "daemon_restarted", "a_read")]),
      undefined,
      rig.runtime,
    );
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    rig.notify("a_read", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "t",
      name: "t",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    });
    await settle();

    rig.notify("a_read", { sessionUpdate: "async_task_state_update", asyncTaskId: "t", state: "hibernating" });
    await settle();
    check(
      "a state word from a later adapter is refused rather than coerced",
      own.get("s_read")?.snapshot().backgroundTasks.map((task) => task.state),
      ["running"],
    );
    check(
      "and the session is still deferred over, which is the direction that matters",
      await own.parkIdleSessions(now + 24 * 60 * 60_000),
      [],
    );

    const before = own.get("s_read")?.snapshot().backgroundTasks.length;
    rig.notify("a_read", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "x".repeat(MAX_ASYNC_TASK_ID_CHARS + 1),
      name: "too long",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    });
    rig.notify("a_read", { sessionUpdate: "async_task_spawned", name: "no id", taskType: "shell" });
    await settle();
    check(
      "an id past the bound and an update with none create nothing",
      own.get("s_read")?.snapshot().backgroundTasks.length,
      before,
    );

    rig.notify("a_read", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "big",
      name: "n".repeat(MAX_ASYNC_TASK_NAME_CHARS * 2),
      taskType: "shell",
      description: "d".repeat(MAX_ASYNC_TASK_TEXT_CHARS * 2),
      showInTranscript: false,
      canStop: true,
    });
    await settle();
    const big = own.get("s_read")?.snapshot().backgroundTasks.find((task) => task.id === "big");
    check(
      "prose is clipped where the record is built",
      [
        (big?.name.length ?? 0) <= MAX_ASYNC_TASK_NAME_CHARS,
        (big?.description.length ?? 0) <= MAX_ASYNC_TASK_TEXT_CHARS,
      ],
      [true, true],
    );
    // `clip` puts its loss note inside the budget, so the lengths are at or under it rather than equal to it.
    check("and the cut is counted rather than silent", big?.description.endsWith("bytes]"), true);
    rig.notify("a_read", {
      sessionUpdate: "async_task_progress",
      asyncTaskId: "big",
      summary: "s".repeat(MAX_ASYNC_TASK_TEXT_CHARS * 2),
    });
    await settle();
    const summary = own.get("s_read")?.snapshot().backgroundTasks.find((task) => task.id === "big")?.summary;
    check(
      "and again on the merge path, which clips on its own account",
      [(summary?.length ?? 0) <= MAX_ASYNC_TASK_TEXT_CHARS, summary?.endsWith("bytes]")],
      [true, true],
    );
    await own.shutdown();
  }

  // `reportsBackgroundTasks` tells nothing running from nobody asked, and is read off the agent's initialize answer.
  {
    for (const [advertises, want] of [
      [true, true],
      [false, false],
      ["old", false],
      ["unnamed", false],
    ] as const) {
      const id = String(advertises);
      const rig = rigWith({ resume: true, advertisesTasks: advertises });
      const own = new SessionRegistry(
        new MemoryEventStore(),
        storeOf([interruptedRow(`s_adv_${id}`, "daemon_restarted", `a_adv_${id}`)]),
        undefined,
        rig.runtime,
      );
      own.restore({ reapOrphans: false });
      await own.autoResume({ ...options, concurrency: 1 });
      check(
        `the agent's own answer decides whether it reports (${id})`,
        own.get(`s_adv_${id}`)?.snapshot().reportsBackgroundTasks,
        want,
      );
      await own.shutdown();
    }
  }

  // `clearContext` re-keys the ACP session, so pre-clear tasks must go with it or they read as running for ever.
  {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const rig = rigWith({ resume: true });
    const events = new MemoryEventStore();
    const own = new SessionRegistry(
      events,
      storeOf([interruptedRow("s_clr", "daemon_restarted", "a_clr")]),
      undefined,
      rig.runtime,
    );
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    rig.notify("a_clr", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "build",
      name: "build",
      taskType: "shell",
      description: "",
      showInTranscript: false,
      canStop: true,
    });
    await settle();
    check(
      "a live task defers the sweep before the clear",
      await own.parkIdleSessions(now + 24 * 60 * 60_000),
      [],
    );

    const cleared = await own.get("s_clr")?.clearContext("/clear");
    await settle();
    check("the clear went through", cleared?.kind, "cleared");
    check(
      "the tasks went with the conversation they belonged to",
      own.get("s_clr")?.snapshot().backgroundTasks,
      [],
    );
    check(
      "so the session can be released again rather than being held for ever",
      await own.parkIdleSessions(now + 24 * 60 * 60_000),
      ["s_clr"],
    );
    check(
      "and the transcript says what was still running, once",
      (own.get("s_clr")?.log.read(0, 1000, 1024 * 1024) ?? [])
        .filter((stored) => stored.event.type === "error")
        .map((stored) => (stored.event as { message: string }).message),
      [clearedWithBackgroundWork(1)],
    );
    await own.shutdown();
  }

  // `stopped: false` is a 200 (a lost race, like the no_turn of cancel); an id never announced is a 404.
  {
    for (const [answer, want] of [
      [true, { status: 200, body: { stopped: true } }],
      [false, { status: 200, body: { stopped: false } }],
      ["error", { status: 502, body: null }],
    ] as const) {
      const rig = rigWith({ resume: true, stopAnswer: answer });
      const store = storeOf([interruptedRow(`s_stop_${String(answer)}`, "daemon_restarted", `a_stop_${String(answer)}`)]);
      const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
      own.restore({ reapOrphans: false });
      await own.autoResume({ ...options, concurrency: 1 });
      const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
      rig.notify(`a_stop_${String(answer)}`, {
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "t1",
        name: "t1",
        taskType: "shell",
        description: "",
        showInTranscript: false,
        canStop: true,
      });
      await settle();

      // Over the route, so the status map and envelope are asserted and not only `stopBackgroundTask`.
      const routed = createApp({
        registry: own,
        verifier,
        instanceId: `i_stop_${String(answer)}`,
        startedAt: now,
        credentials,
        roots: [users],
        logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
      }).app;
      const stopOver = async (taskId: string): Promise<[number, any]> => {
        const response = await routed.fetch(
          new Request(
            `http://d/sessions/s_stop_${String(answer)}/async-tasks/${encodeURIComponent(taskId)}/stop`,
            { method: "POST", headers: { authorization: `Bearer ${tokenFor("u_alice")}` } },
          ),
        );
        return [response.status, await response.json()];
      };

      const [status, body] = await stopOver("t1");
      if (want.body === null) {
        check(
          `an agent that refuses is a 502 rather than a lost race (${String(answer)})`,
          [status, body.error?.code],
          [want.status, "agent_error"],
        );
      } else {
        check(
          `the agent's answer is carried through, under a 200 (${String(answer)})`,
          [status, body.stopped],
          [want.status, want.body.stopped],
        );
        check(
          `and the answer carries the session back with it (${String(answer)})`,
          typeof body.session?.id,
          "string",
        );
      }
      check(`and the id reached the agent verbatim (${String(answer)})`, rig.stops(), [
        { sessionId: `a_stop_${String(answer)}`, asyncTaskId: "t1" },
      ]);

      const [madeStatus, madeBody] = await stopOver("never-announced");
      check(
        `an id this session never announced is a 404, before the agent is asked (${String(answer)})`,
        [madeStatus, madeBody.error?.code, rig.stops().length],
        [404, "task_not_found", 1],
      );
      await own.shutdown();
    }
  }


  // Swept as near-miss pairs: a wrong namespace or a truthy string is each one edit away from passing.
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_bgm", "daemon_restarted", "a_bgm")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

    const air = (backgrounded: unknown): Record<string, unknown> => ({
      jetbrains: { air: { asyncTasks: { backgrounded } } },
    });
    const cases: readonly (readonly [string, Record<string, unknown> | undefined, boolean])[] = [
      ["the marker is read where the agent sets it", air(true), true],
      ["`false` is not backgrounded", air(false), false],
      ["and the string \"false\" is not `true`, which truthiness would have taken", air("false"), false],
      ["nor is the string \"true\"", air("true"), false],
      ["an update with no `_meta` at all", undefined, false],
      ["the marker in the wrong namespace is not this one", { claudeCode: { asyncTasks: { backgrounded: true } } }, false],
      ["nor is an `air` that is an array", { jetbrains: { air: [{ asyncTasks: { backgrounded: true } }] } }, false],
      ["nor an `air` holding no `asyncTasks`", { jetbrains: { air: { version: 1 } } }, false],
    ];

    let at = 0;
    for (const [what, meta, want] of cases) {
      at += 1;
      const toolCallId = `call_${at}`;
      // `backgrounded` rides the `tool_call_update`, not the call.
      rig.notify("a_bgm", { sessionUpdate: "tool_call", toolCallId, title: "Bash", kind: "execute", status: "in_progress" });
      rig.notify("a_bgm", {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        ...(meta === undefined ? {} : { _meta: meta }),
      });
      // A tool draft is held until the next update, so one more arrival flushes it into the log.
      rig.notify("a_bgm", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
      await settle();
      const drawn = (own.get("s_bgm")?.log.read(0, 1000, 1024 * 1024) ?? [])
        .map((stored) => stored.event)
        .filter(
          (event) =>
            event.type === "tool_call_update" && (event as { toolCallId?: string }).toolCallId === toolCallId,
        )
        .map((event) => (event as { backgrounded?: boolean }).backgrounded);
      check(what, drawn, [want]);
    }
    await own.shutdown();
  }

  // The listing nulls `outputFilePath` but keeps the key; the single-session read and the WS snapshot keep the value.
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_list", "daemon_restarted", "a_list")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
    const path = "/private/tmp/claude-501/slug/s_list/tasks/t1.output";
    rig.notify("a_list", {
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "t1",
      name: "build",
      taskType: "shell",
      description: "",
      showInTranscript: true,
      canStop: true,
      outputFilePath: path,
    });
    await settle();

    const routed = createApp({
      registry: own,
      verifier,
      instanceId: "i_list",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;
    const getJson = async (url: string): Promise<any> => {
      const response = await routed.fetch(
        new Request(`http://d${url}`, { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
      );
      return await response.json();
    };

    const listed = await getJson("/sessions");
    const listedTask = listed.sessions?.[0]?.backgroundTasks?.[0];
    check(
      "the polled listing carries the row but not its output path",
      [listedTask?.id, listedTask?.outputFilePath, "outputFilePath" in (listedTask ?? {})],
      ["t1", null, true],
    );

    const one = await getJson("/sessions/s_list");
    check(
      "the single-session read carries the path whole",
      [one.session?.backgroundTasks?.[0]?.id, one.session?.backgroundTasks?.[0]?.outputFilePath],
      ["t1", path],
    );

    check(
      "and so does the snapshot the socket's control frame is built from",
      own.get("s_list")?.snapshot().backgroundTasks.map((task) => task.outputFilePath),
      [path],
    );
    await own.shutdown();
  }

  // `markInterrupted` must not relabel a parked row, or the next boot pass would resume it.
  {
    const rig = rigWith({ resume: true });
    const rows = [interruptedRow("s_wake", "daemon_restarted", "a_wake")];
    const saved = new Map<string, PersistedSession>(rows.map((row) => [row.id, row]));
    const store: SessionStore = {
      put: (row) => void saved.set(row.id, row),
      list: () => [...saved.values()],
      remove: (id) => void saved.delete(id),
    };
    const first = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    first.restore({ reapOrphans: false });
    await first.autoResume({ ...options, concurrency: 1 });
    check("released after a quiet spell", await first.parkIdleSessions(now + 31 * 60_000), ["s_wake"]);
    check("and written down that way", saved.get("s_wake")?.exit?.reason, "parked");
    await first.shutdown();

    const second = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    second.restore({ reapOrphans: false });
    check("a restart finds it still released, not interrupted", second.get("s_wake")?.status, "parked");
    const boot = await second.autoResume({ ...options, concurrency: 1 });
    check("and the boot pass leaves it alone", [boot.resumed, second.get("s_wake")?.status], [0, "parked"]);
    check("so the machine comes up holding no agent for it", second.liveSessionCount, 0);

    const routed = createApp({
      registry: second,
      verifier,
      instanceId: "i_park",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: second.sessionRuntime, onWarning: () => {} }),
    }).app;
    // A parked session's worktree may not be removed: every later prompt would answer `workspace_missing` before it could resume.
    const held = await routed.fetch(
      new Request("http://d/sessions/s_wake/workspace", {
        method: "DELETE",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    const heldBody = (await held.json()) as { error?: { code?: string; message?: string } };
    check(
      "a parked conversation keeps its worktree",
      [held.status, heldBody.error?.code, heldBody.error?.message],
      [409, "session_live", "stop this session before removing its worktree"],
    );
    check("and it is still parked, not changed by having been asked", second.get("s_wake")?.exit?.reason, "parked");

    const woke = await routed.fetch(
      new Request("http://d/sessions/s_wake/prompt", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "carry on" }),
      }),
    );
    check("a message wakes it", woke.status, 202);
    check("on the same conversation the agent already had", rig.resumes().at(-1)?.sessionId, "a_wake");
    check("and it is live again", [second.get("s_wake")?.status, second.liveSessionCount], ["idle", 1]);

    await second.shutdown();
  }

  {
    const rig = rigWith({ resume: true, stallPrompt: true });
    const store = storeOf([
      interruptedRow("s_old", "daemon_restarted", "a_old"),
      interruptedRow("s_new", "daemon_restarted", "a_new"),
      interruptedRow("s_want", "daemon_restarted", "a_want"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    // `s_new` wakes after `s_old`, so least recently active has something to be wrong about.
    await own.parkIdleSessions(now + 31 * 60_000);
    await own.get("s_old")?.resume();
    await own.get("s_new")?.resume();
    check("two agents resident, one conversation still released", [own.liveSessionCount, own.get("s_want")?.status], [2, "parked"]);

    // `makeRoomForWake` reads the real clock, so both `idleParkMs` and the ceiling floor are lowered for this fixture (Q7.113).
    own.setSessionLimits({ live: 2, idleParkMs: 1, ceilingFloorMs: 0 });
    await own.get("s_want")?.resume();
    check("the machine stays at its ceiling", own.liveSessionCount, 2);
    check("the wake was not refused", own.get("s_want")?.status, "idle");
    check("and the slot came from the least recently used", own.get("s_old")?.status, "parked");
    check("while the one used more recently kept its agent", own.get("s_new")?.status, "idle");

    own.get("s_new")?.prompt("keep working");
    own.get("s_want")?.prompt("keep working");
    check("nothing left to take", [own.get("s_new")?.status, own.get("s_want")?.status], ["running", "running"]);
    await own.get("s_old")?.resume();
    check("the wake still happens", own.get("s_old")?.status, "idle");
    check("and the machine is knowingly one over rather than refusing somebody", own.liveSessionCount, 3);

    await own.shutdown();
  }

  {
    const armed: { delay: number; fire: () => void }[] = [];
    const reported: string[][] = [];
    let sweeps = 0;
    let allowed = true;
    let parked: string[] = [];
    const parking = IdleParking.start({
      park: async () => {
        sweeps += 1;
        return parked;
      },
      enabled: () => allowed,
      schedule: (fire, delay) => {
        const entry = { delay, fire };
        armed.push(entry);
        return {
          cancel: () => {
            const at = armed.indexOf(entry);
            if (at >= 0) armed.splice(at, 1);
          },
        };
      },
      onParked: (ids) => void reported.push([...ids]),
    });

    check("a sweep is armed at start", [armed.length, armed[0]?.delay], [1, 60_000]);
    check("and nothing has run yet", sweeps, 0);

    // A self-rescheduling timeout, not an interval, so a slow sweep never overlaps itself.
    const first = armed.shift();
    first?.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("a tick sweeps once and arms the next", [sweeps, armed.length], [1, 1]);
    check("and says nothing when nothing was released", reported, []);

    parked = ["s_a", "s_b"];
    armed.shift()?.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("what it released is reported, so a vanished agent is never silent", reported, [["s_a", "s_b"]]);

    // `enabled` is read every tick: `daemon.ts` finishes reading its environment after the registry exists.
    allowed = false;
    parked = ["s_c"];
    armed.shift()?.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("a disabled sweep does not sweep", sweeps, 2);
    check("but keeps its timer, so switching it back on needs no restart", armed.length, 1);

    allowed = true;
    armed.shift()?.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("and picks up again when it is allowed", sweeps, 3);

    await parking.shutdown();
    check("shutdown disarms it", armed.length, 0);
    await parking.shutdown();
    check("and is idempotent, like every other shutdown here", armed.length, 0);
  }

  // The two sweeps share a clock and nothing else: a throw in the park, or in its report, must not cost that tick its reap.
  {
    const armed: (() => void)[] = [];
    const ran: string[] = [];
    const abandoned: string[][] = [];
    let breaking: "park" | "report" = "park";
    const parking = IdleParking.start({
      park: async () => {
        ran.push("park");
        if (breaking === "park") throw new Error("the park sweep broke");
        return ["s_quiet"];
      },
      reap: () => {
        ran.push("reap");
        return ["s_wedged"];
      },
      schedule: (fire) => {
        armed.push(fire);
        return {
          cancel: () => {
            const at = armed.indexOf(fire);
            if (at >= 0) armed.splice(at, 1);
          },
        };
      },
      onParked: () => {
        throw new Error("the park report broke");
      },
      onAbandoned: (ids) => void abandoned.push([...ids]),
    });

    armed.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("a park that throws still lets that tick's reap run, after it", ran, ["park", "reap"]);
    check("and the reap reports what it gave up on", abandoned, [["s_wedged"]]);
    check("and the clock is armed for the next tick", armed.length, 1);

    breaking = "report";
    armed.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("a park whose report throws costs the reap nothing either", ran, ["park", "reap", "park", "reap"]);
    check("which reports in its turn", abandoned, [["s_wedged"], ["s_wedged"]]);

    await parking.shutdown();
  }

  // A tap on a parked session records the choice and wakes nothing; it takes effect at the next message.
  {
    let armConfigSet: (() => void) | null = null;
    const rig = rigWith({ resume: true, config: true, onConfigSet: () => armConfigSet?.() });
    const store = storeOf([interruptedRow("s_cfg", "daemon_restarted", "a_cfg")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const cfg = own.get("s_cfg");
    check("the agent offers a model", cfg?.snapshot().agentConfig?.options.map((o) => o.id), ["model"]);

    await own.parkIdleSessions(now + 31 * 60_000);
    check("released", cfg?.status, "parked");
    // Parking keeps the controls published; cleared, the client would refuse the tap.
    check("and its controls are still offered", cfg?.snapshot().agentConfig?.options.map((o) => o.id), ["model"]);

    const before = rig.launches();
    const set = await cfg?.setConfigOption("model", "sonnet");
    check("choosing a model is accepted rather than refused", set?.kind, "ok");
    check("the choice is on the session at once", cfg?.snapshot().agentConfig?.options[0]?.value, "sonnet");
    check("no agent was started for it", rig.launches(), before);
    check("and it is still released", cfg?.status, "parked");
    check("nothing has been sent to any agent", rig.configSets(), []);

    // Validated against the remembered options, so a bad value is refused now rather than dropped at the wake.
    const bad = await cfg?.setConfigOption("model", "no-such-model");
    check("a value the agent does not offer is still refused", bad?.kind, "invalid_value");
    const missing = await cfg?.setConfigOption("nonsense", "x");
    check("and so is an option it never had", missing?.kind, "unknown_option");

    // A tap inside the wake's config replay must answer busy (`resuming` in `replacingConfig`), not be silently overwritten.
    // Collected into an array so a hook that never fired is a distinguishable answer.
    const midWake: string[] = [];
    armConfigSet = () => {
      void cfg?.setMode("plan").then((r) => void midWake.push(r.kind));
      void cfg?.setConfigOption("model", "opus").then((r) => void midWake.push(r.kind));
    };
    await cfg?.resume();
    armConfigSet = null;
    check("the wake sends the choice to the fresh agent", rig.configSets(), [{ id: "model", value: "sonnet" }]);
    check("which is live again on the chosen model", [cfg?.status, cfg?.snapshot().agentConfig?.options[0]?.value], ["idle", "sonnet"]);
    check(
      "a tap arriving inside the wake is refused rather than silently overwritten",
      midWake.length === 0 ? ["<the hook never fired>"] : [...midWake].sort(),
      ["busy", "busy"],
    );
    check("and the wake put back what it captured", cfg?.snapshot().agentConfig?.options[0]?.value, "sonnet");

    await own.shutdown();
  }

  // `revivableByPrompt` is the one gate: a stopped session keeps its controls and defers a choice like a parked one.
  {
    const rig = rigWith({ resume: true, config: true });
    const store = storeOf([interruptedRow("s_off", "daemon_restarted", "a_off")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const off = own.get("s_off");
    await off?.stop("stopped");
    check("a stopped session keeps its controls, like a parked one", (off?.snapshot().agentConfig?.options ?? []).length > 0, true);
    const set = await off?.setConfigOption("model", "sonnet");
    check("and a choice on one is deferred, not refused", set?.kind, "ok");
    check("the chip moves at once, because the setting will be in force next run", off?.snapshot().agentConfig?.options[0]?.value, "sonnet");

    await own.shutdown();
  }

  // Parked controls are written to `agent_state_json` and adopted on restore, so this crosses two registries over one store.
  {
    const seed = interruptedRow("s_keep", "daemon_restarted", "a_keep");
    const rows = new Map<string, PersistedSession>([[seed.id, seed]]);
    const recording: SessionStore = {
      put: (row) => void rows.set(row.id, row),
      list: () => [...rows.values()],
      remove: (id) => void rows.delete(id),
    };

    const rig = rigWith({ resume: true, config: true });
    const first = new SessionRegistry(new MemoryEventStore(), recording, undefined, rig.runtime);
    first.restore({ reapOrphans: false });
    await first.autoResume({ ...options, concurrency: 1 });
    const live = first.get("s_keep");
    check("the agent is live and publishing controls", (live?.snapshot().agentConfig?.options ?? []).length > 0, true);
    await live?.stop("parked");
    await first.shutdown();

    const written = rows.get("s_keep");
    check("a parked row writes what its agent was offering", written?.agentState?.config.options[0]?.id, "model");
    check("and the row still reads as parked", written?.exit?.reason, "parked");

    const second = new SessionRegistry(new MemoryEventStore(), recording, undefined, rigWith({ resume: true, config: true }).runtime);
    second.restore({ reapOrphans: false });
    const back = second.get("s_keep");
    check("a restarted daemon brings a parked session's controls back", back?.snapshot().agentConfig?.options[0]?.id, "model");
    check("without starting anything", back?.status, "parked");
    // The restored revision must be above 0: the web client reads 0 as nothing to fetch.
    check("at a revision a client will actually fetch", (back?.commandsRevision ?? 0) > 0, true);
    const tapped = await back?.setConfigOption("model", "sonnet");
    check("and a tap on them is recorded rather than refused", tapped?.kind, "ok");
    await second.shutdown();
  }

  // Restore asks `revivableByPrompt` again over the stored exit, so a row nothing can revive adopts no controls.
  {
    const seed = interruptedRow("s_refused", "daemon_restarted", "a_refused");
    const store = storeOf([
      {
        ...seed,
        exit: { reason: "start_failed", at: now, detail: null, agentHandle: null, agentConfirmedDead: true },
        agentState: {
          config: { modes: null, options: [{ id: "model", name: "Model", description: null, category: "model", kind: "select", value: "opus", choices: [{ value: "opus", name: "Opus", description: null, group: null }] }] },
          commands: { commands: [{ name: "compact", description: "Compact", hint: null }], dropped: 0 },
        },
      },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rigWith({ resume: true }).runtime);
    own.restore({ reapOrphans: false });
    const refused = own.get("s_refused");
    check("a row nothing can revive is not adopted, whatever it stored", refused?.snapshot().agentConfig?.options ?? [], []);
    check("nor is its command list", refused?.agentCommands, { commands: [], dropped: 0 });
    await own.shutdown();
  }

  // An oversized choice list is refused whole, not clipped: a shorter list would make `setConfigOption` refuse real values.
  {
    const choice = (n: number) => ({ value: `m${n}`, name: `Model ${n}`, description: `a sentence about model ${n}`, group: null });
    const optionOf = (count: number) => ({
      id: "model",
      name: "Model",
      description: null,
      category: "model" as const,
      kind: "select" as const,
      value: "m0",
      choices: Array.from({ length: count }, (_, n) => choice(n)),
    });
    const none = { commands: [], dropped: 0 };
    const ordinary = reduceAgentState({ modes: null, options: [optionOf(362)] }, none);
    check("the largest list any agent here publishes is kept", ordinary?.config.options[0]?.choices.length, 362);
    check(
      "with the prose dropped from every choice but the selected one",
      ordinary?.config.options[0]?.choices.map((c) => c.description === null),
      [false, ...Array.from({ length: 361 }, () => true)],
    );
    check("and one past the bound is not kept at all, rather than kept short", reduceAgentState({ modes: null, options: [optionOf(4000)] }, none), null);
    // Nothing to remember is null, so an empty pair does not seed a non-zero commands revision.
    check("a pair with nothing in it is not remembered at all", reduceAgentState({ modes: null, options: [] }, none), null);
    check("nor is one with only a mode and no options", reduceAgentState({ modes: { current: "plan", available: [] }, options: [] }, none), null);
    check("but a command list with no options is", reduceAgentState({ modes: null, options: [] }, { commands: [{ name: "context", description: "", hint: null }], dropped: 0 })?.commands.commands.length, 1);
  }

  {
    const rig = rigWith({ resume: true, config: true });
    const store = storeOf([interruptedRow("s_dead", "daemon_restarted", "a_dead")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    const dead = own.get("s_dead");
    await dead?.stop("start_failed");
    check("a stop nothing can revive keeps no controls", dead?.snapshot().agentConfig?.options ?? [], []);
    const set = await dead?.setConfigOption("model", "sonnet");
    check("and a choice on one is refused, not deferred", set?.kind, "terminal");

    await own.shutdown();
  }

  // A stored value beats the env file; `REEMOAT_IDLE_PARK_MINUTES` is only the default for a machine nobody has set.
  {
    const rig = rigWith({ resume: true });
    const kept = new Map<string, string>();
    const settings = {
      read: (key: string) => kept.get(key) ?? null,
      write: (key: string, value: string) => void kept.set(key, value),
    };
    const own = new SessionRegistry(new MemoryEventStore(), storeOf([]), undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    // What an env file asked for, exactly as `daemon.ts` injects it.
    own.setSessionLimits({ idleParkMs: 45 * 60_000 });
    own.setMachineSettingsStore(settings);

    const routed = createApp({
      registry: own,
      verifier,
      instanceId: "i_settings",
      startedAt: now,
      credentials,
      roots: [users],
      machineSettings: settings,
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;
    const call = async (method: string, body?: unknown): Promise<[number, any]> => {
      const response = await routed.fetch(
        new Request("http://d/settings", {
          method,
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return [response.status, await response.json()];
    };

    const [readStatus, read] = await call("GET");
    check("with nothing stored, the configuration is what is in force", [readStatus, read.settings], [200, { idleReleaseMinutes: 45 }]);

    const [saveStatus, saved] = await call("PATCH", { idleReleaseMinutes: 5 });
    check("saving answers with what is now in force", [saveStatus, saved.settings], [200, { idleReleaseMinutes: 5 }]);
    check("and the running daemon is already using it", own.idleParkEnabled, true);
    const store2 = storeOf([interruptedRow("s_five", "daemon_restarted", "a_five")]);
    const live = new SessionRegistry(new MemoryEventStore(), store2, undefined, rig.runtime);
    live.restore({ reapOrphans: false });
    live.setSessionLimits({ idleParkMs: 45 * 60_000 });
    live.setMachineSettingsStore(settings);
    await live.autoResume({ ...options, concurrency: 1 });
    check("a session quiet past the saved five minutes is released", await live.parkIdleSessions(now + 6 * 60_000), ["s_five"]);
    check("which the configured forty-five would not have taken", live.machineSettings(), { idleReleaseMinutes: 5 });
    await live.shutdown();

    // `0` is a real answer, not unset: a falsy value read as absent is how a switch turns itself back on.
    const [, off] = await call("PATCH", { idleReleaseMinutes: 0 });
    check("zero is stored as a choice, not read as unset", off.settings, { idleReleaseMinutes: 0 });
    check("and nothing is released while it says so", own.idleParkEnabled, false);
    const [nullStatus] = await call("PATCH", { idleReleaseMinutes: null });
    check("and null is no longer a way to ask for the configuration back", nullStatus, 400);

    const [unknownStatus, unknown] = await call("PATCH", { somethingElse: 5 });
    check("a setting this daemon does not have is refused", [unknownStatus, unknown.error.code], [400, "unknown_setting"]);
    const [badStatus, bad] = await call("PATCH", { idleReleaseMinutes: -1 });
    check("and so is a value outside the bound", [badStatus, bad.error.code], [400, "invalid_setting"]);
    const [fracStatus, frac] = await call("PATCH", { idleReleaseMinutes: 1.5 });
    check("and half a minute", [fracStatus, frac.error.code], [400, "invalid_setting"]);
    const [hugeStatus] = await call("PATCH", { idleReleaseMinutes: MAX_IDLE_RELEASE_MINUTES + 1 });
    check("and more than the ceiling", hugeStatus, 400);
    check("none of which changed what is stored", [...kept.entries()], [["idleReleaseMinutes", "0"]]);

    // A multi-key body is all-or-nothing: a valid key beside a bad one must not be written.
    const [mixedStatus, mixed] = await call("PATCH", { idleReleaseMinutes: 5, anythingElse: 1 });
    check("a body with one bad key is refused", [mixedStatus, mixed.error.code], [400, "unknown_setting"]);
    check("and the good key beside it was not written", [...kept.entries()], [["idleReleaseMinutes", "0"]]);
    check("so the running daemon still holds what it held", own.idleParkEnabled, false);
    // Table and running daemon compared together: `GET /settings` answers from the registry and cannot see the drift alone.
    check(
      "and the table and the running daemon did not drift apart",
      [kept.get("idleReleaseMinutes") ?? null, String((await call("GET"))[1].settings.idleReleaseMinutes)],
      ["0", "0"],
    );

    const [firstBadStatus, firstBad] = await call("PATCH", { anythingElse: 1, idleReleaseMinutes: 5 });
    check("and the same body the other way round is refused too", [firstBadStatus, firstBad.error.code], [400, "unknown_setting"]);
    check("with the table still untouched", [...kept.entries()], [["idleReleaseMinutes", "0"]]);

    await own.shutdown();
  }

  {
    const own = new SessionRegistry(new MemoryEventStore(), storeOf([]));
    own.restore({ reapOrphans: false });
    const routed = createApp({
      registry: own,
      verifier,
      instanceId: "i_nostore",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;
    const get = await routed.fetch(
      new Request("http://d/settings", { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
    );
    const got = (await get.json()) as any;
    check("a store-less daemon still says what is in force", [get.status, got.settings.idleReleaseMinutes], [200, 30]);
    const patch = await routed.fetch(
      new Request("http://d/settings", {
        method: "PATCH",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ idleReleaseMinutes: 5 }),
      }),
    );
    const refused = (await patch.json()) as any;
    check("and refuses to change it rather than pretending", [patch.status, refused.error.code], [503, "settings_unavailable"]);
    await own.shutdown();
  }

  // A live session cannot be given up on (`onResumed` clears the verdict), so only the reachable shape is asserted.
  {
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([
      interruptedRow("s_ok", "daemon_restarted", "a_ok"),
      interruptedRow("s_lost", "daemon_restarted", "a_lost"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.autoResume({ ...options, concurrency: 1 });
    check("the agent says it has forgotten them", own.get("s_lost")?.resumeAbandoned, "forgotten");

    const later = now + 31 * 60_000;
    check("a session with no agent to release is not released", await own.parkIdleSessions(later), []);
    check("and it keeps the verdict rather than gaining an exit nobody wrote", own.get("s_lost")?.status, "interrupted");

    await own.shutdown();
  }

  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      { ...interruptedRow("s_cleared", "daemon_restarted", "a_cleared"), resumeGaveUp: "forgotten" },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    check("restored still carrying the verdict", own.get("s_cleared")?.resumeAbandoned, "forgotten");
    await own.get("s_cleared")?.resume();
    check("and a resume that works clears it", own.get("s_cleared")?.resumeAbandoned, null);
    check("which is why a live session cannot be one the daemon gave up on", own.get("s_cleared")?.status, "idle");
    await own.shutdown();
  }

  {
    // Two sessions on one agent that cannot reattach: the per-agent memo must spare the second a spawn.
    const rig = rigWith({ resume: false });
    const store = storeOf([
      interruptedRow("s_u1", "daemon_restarted", "a_u1"),
      interruptedRow("s_u2", "daemon_restarted", "a_u2"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    const one = own.get("s_u1");
    check("an agent that cannot resume leaves the session interrupted", one?.status, "interrupted");
    // `previousExit` is restored, or `start_failed` would overwrite the reason and the session could never come back.
    check("with its original reason intact", one?.exit?.reason, "daemon_restarted");
    check("and it says so on the snapshot", one?.snapshot().resume?.state, "failed");
    check("both are skipped", report.skipped, 2);
    // The resume capability is readable only after a start, so the first spawn is unavoidable.
    check("but only one agent was ever started", rig.launches(), 1);
    await own.shutdown();
  }

  {
    // An agent that starts and then refuses the resume itself.
    const rig = rigWith({ resume: true, failResume: true });
    const store = storeOf([interruptedRow("s_fail", "daemon_shutdown", "a_fail")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1, maxAttempts: 2 });

    const failed = own.get("s_fail");
    check("a refused resume leaves the reason alone", failed?.exit?.reason, "daemon_shutdown");
    check("and the status with it", failed?.status, "interrupted");
    check("the budget is spent, not looped", [rig.resumes().length, report.failed], [2, 1]);
    // One error, on the last attempt: the log evicts a prefix, so per-attempt events would cost the operator's first prompt.
    const written = failed?.log.read(0, 1000, 1024 * 1024) ?? [];
    check(
      "and says so once rather than per attempt",
      written.filter((stored) => stored.event.type === "error").length,
      1,
    );
    check(
      "and writes no status churn for attempts nobody asked for",
      written.filter((stored) => stored.event.type === "status").length,
      0,
    );
    await own.shutdown();
  }

  {
    const rig = rigWith({ resume: true, forgotten: true });
    // `storeOf` discards writes; persistence is under test here, so this store keeps them.
    const saved = new Map<string, PersistedSession>();
    const store: SessionStore = {
      put: (row) => void saved.set(row.id, row),
      list: () => [...saved.values()],
      remove: (id) => void saved.delete(id),
    };
    saved.set("s_lost", interruptedRow("s_lost", "daemon_restarted", "a_lost"));

    const first = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    first.restore({ reapOrphans: false });
    const report = await first.autoResume({ ...options, concurrency: 1, maxAttempts: 3 });

    const lost = first.get("s_lost");
    check("a forgotten conversation is not a failure to retry", rig.resumes().length, 1);
    check("so the budget is untouched", [report.skipped, report.failed], [1, 0]);
    check("the session keeps its original reason", lost?.exit?.reason, "daemon_restarted");
    check("and says why nobody is coming", lost?.snapshot().resume?.error?.code, "agent_forgot_session");
    await first.shutdown();

    // The one persisted retry verdict: it is a fact about the agent's disk, not about an attempt of ours.
    const spawnsBefore = rig.launches();
    const second = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    second.restore({ reapOrphans: false });
    const after = await second.autoResume({ ...options, concurrency: 1 });
    check("a restart does not try again", rig.launches() - spawnsBefore, 0);
    check("and does not even consider it", after.considered, 0);
    check("the verdict was on disk, not in memory", saved.get("s_lost")?.resumeGaveUp, "forgotten");
    await second.shutdown();
  }

  {
    const rig = rigWith({ resume: true, hatesFileIo: true });
    const store = storeOf([interruptedRow("s_fio", "daemon_restarted", "a_fio")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a session refused with the capability still comes back", report.resumed, 1);
    check("and is idle rather than stranded", own.get("s_fio")?.status, "idle");
    // Declared first because the daemon wants it, dropped only after the agent refuses it.
    check("having been asked twice, with then without", rig.fileIoAtResume(), [true, false]);
    // One retry, not a loop: the second failure would be a real one.
    check("and no retry budget was spent on it", own.get("s_fio")?.resumeAttemptCount, 0);
    await own.shutdown();
  }

  {
    // A cleared conversation claude never wrote down is opened fresh: claude writes the transcript with the first turn.
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([interruptedRow("s_clr", "daemon_restarted", "a_clr")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    own.get("s_clr")?.log.append({
      type: "context_cleared",
      agentSessionId: "a_clr",
      previousAgentSessionId: "a_older",
    });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a cleared-and-unused conversation is recreated", report.resumed, 1);
    check("the session is idle rather than stranded", own.get("s_clr")?.status, "idle");
    check("without asking the agent to resume what is not there", rig.resumes().length, 0);
    check("and one agent started, not two", rig.launches(), 1);
    // The id moves to the new conversation, or the next boot would fail on the dead one.
    check("on a conversation the agent gave us", own.get("s_clr")?.agentSessionId, "conv_1");

    // Only the last marker or prompt decides whether the conversation is empty; an older clear must not.
    const clr = own.get("s_clr");
    clr?.log.append({ type: "prompt", text: "we talked about it", attachments: [] });
    clr?.log.append({ type: "context_cleared", agentSessionId: "a_newer", previousAgentSessionId: "conv_1" });

    own.get("s_clr")?.markInterrupted(true, null);
    const again = await own.autoResume({ ...options, concurrency: 1 });
    check("and again on the restart after that", again.resumed, 1);
    check("on yet another fresh conversation", own.get("s_clr")?.agentSessionId, "conv_2");
    check("still without a doomed resume", rig.resumes().length, 0);
    await own.shutdown();
  }

  {
    // `turnCounter`, not an absent prompt in the log, says a conversation never had a turn.
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([
      { ...interruptedRow("s_untouched", "daemon_restarted", "a_untouched"), turnCounter: 0 },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a session nobody ever spoke to is opened fresh", report.resumed, 1);
    check("without asking the agent for a conversation that never existed", rig.resumes().length, 0);
    check("and it is usable rather than stranded", own.get("s_untouched")?.status, "idle");
    await own.shutdown();
  }

  {
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([interruptedRow("s_lost3", "daemon_restarted", "a_lost3")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a lost conversation nobody cleared is not silently replaced", report.resumed, 0);
    check("it stays interrupted", own.get("s_lost3")?.status, "interrupted");
    check("and says why", own.get("s_lost3")?.snapshot().resume?.error?.code, "agent_forgot_session");
    check("with the verdict standing", own.get("s_lost3")?.resumeAbandoned, "forgotten");
    await own.shutdown();
  }

  {
    // A missing worktree spawns nothing: claude's adapter rejects a nonexistent cwd anyway.
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_gone", "daemon_restarted", "a_gone", false)]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a missing workspace spawns nothing at all", rig.launches(), 0);
    check("and leaves the session interrupted", own.get("s_gone")?.status, "interrupted");
    check("marked as given up rather than pending", own.get("s_gone")?.snapshot().resume?.state, "failed");
    check("counted as skipped, not failed", [report.skipped, report.failed], [1, 0]);
    await own.shutdown();
  }

  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_late", "daemon_restarted", "a_late")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.shutdown();
    const report = await own.autoResume(options);
    check("a shutting-down daemon resumes nothing", [report.resumed, rig.launches()], [0, 0]);
  }

  {
    const rig = rigWith({ resume: true, stallMs: 25 });
    const store = storeOf(
      Array.from({ length: 6 }, (_unused, index) =>
        interruptedRow(`s_c${index}`, "daemon_restarted", `a_c${index}`),
      ),
    );
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 2 });
    check("every session comes back", [report.considered, report.resumed], [6, 6]);
    check("and never more than two at once", rig.peak() <= 2, true);
    await own.shutdown();
  }

  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      interruptedRow("s_typed", "daemon_shutdown", "a_typed"),
      interruptedRow("s_killed", "stopped", "a_killed"),
      // `create = false` points this row's workspace at a directory that was never made.
      interruptedRow("s_gone", "daemon_shutdown", "a_gone", false),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const routed = createApp({
      registry: own,
      verifier,
      instanceId: "i_resume",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;

    const say = async (id: string): Promise<number> => {
      const response = await routed.fetch(
        new Request(`http://d/sessions/${id}/prompt`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
          body: JSON.stringify({ text: "carry on" }),
        }),
      );
      return response.status;
    };

    // The workspace is checked on every message, not only before a resume.
    check("a message to a session whose folder is gone is refused", await say("s_gone"), 409);

    check("a message to an interrupted session is accepted", await say("s_typed"), 202);
    check("because the daemon resumed it first", rig.resumes()[0]?.sessionId, "a_typed");
    // A prompt revives a stopped session; only the boot pass leaves it stopped.
    check("a message to a stopped one starts it again", await say("s_killed"), 202);
    check("because that one was resumed as well", rig.resumes().length, 2);
    await own.shutdown();
  }

  {
    // A launch resolving after its session was re-armed must be disposed, not adopted; the rig's stall outlasts the first budget.
    const rig = rigWith({ resume: true, stallMs: 150 });
    const store = storeOf([interruptedRow("s_late", "daemon_restarted", "a_late")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const managed = own.get("s_late");

    // `doResume` restores the original exit on a timeout, which keeps the session resumable for the retry.
    const timedOut = await managed
      ?.resume(20)
      .then(() => "(resumed)", (error: unknown) => (error instanceof Error ? error.name : String(error)));
    check("a launch that misses its budget is abandoned", timedOut, "StartTimeoutError");
    check("and its session is terminal again, as it was", managed?.terminal, true);
    check("with the reason it actually ended on, not the failed revival", managed?.exit?.reason, "daemon_restarted");

    // The retry re-arms the session, clearing `startAbandoned`, while the first launch is still in flight.
    await managed?.resume(5_000);
    check("the retry brings the session back", managed?.status, "idle");
    check("and two agents really were started", rig.launches(), 2);
    check("both of which reached the agent's resume", rig.resumes().length, 2);

    // Counted before any stop, so this is the abandoned launch's own dispose rather than a teardown.
    check("the abandoned launch's agent was disposed rather than orphaned", rig.disposed(), 1);

    await own.shutdown();
    // The survivor is disposed once, by shutdown, so the count above was not the adopted agent.
    check("and the live one goes with the daemon", rig.disposed(), 2);
  }
}
