import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { forgetStalled } from "../src/browse.js";
import { estimateBytes, truncateEvent } from "../src/events.js";
import {
  contentDispositionFor,
  inlinesImage,
  MAX_SESSION_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  uploadRateVerdict,
  UPLOAD_RATE_BYTES,
  UPLOAD_RATE_WINDOW_MS,
  MAX_UPLOADS_PER_SESSION,
  resolveUploadRoot,
  sanitizeUploadName,
  Uploads,
  type UploadRow,
} from "../src/uploads.js";
import { probeContained, probeRequestable, safeRelPath } from "../src/changes.js";
import { atOrUnder } from "../src/paths.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { memoryUploadIndex, users, uAbcd, now, tokenFor, app, stubAgentConfig } from "./daemoncheck.fixtures.js";

/*
 * What the agent says, and what survives the daemon.
 *
 * Two things ACP sends that this daemon used to throw away, driven through a real
 * `Session` over in-memory pipes with a fake agent on the other end — the same
 * shape as the fs-capability case above, and for the same reason: both are about
 * what happens to a *notification the agent chose to send*, which no amount of
 * reading the types can settle.
 *
 *   usage_update   — fell into the `other` bucket, so the context window was on the
 *                    wire and unreachable. It must reach `Session.contextUsage` and
 *                    fire `onUsageChanged`, because it never enters the log at all
 *                    and those are its only exits.
 *   tool content   — `emitDiffs` kept `type: "diff"` blocks and dropped the rest, so
 *                    the output of every command an agent ran was discarded here.
 */
process.stdout.write("\nwhat the agent says, and what survives\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const { Session } = await import("../src/session.js");
  const { LocalRuntime } = await import("../src/runtime/local.js");
  const { PassThrough } = await import("node:stream");

  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const send = (message: unknown) => toClient.write(`${JSON.stringify(message)}\n`);
  const notify = (update: unknown) =>
    send({ jsonrpc: "2.0", method: acp.methods.client.session.update, params: { sessionId: "s_fake", update } });

  /** Every `session/new` this driver's agent was asked, as it was asked. */
  const openParams: any[] = [];

  // The fake agent: answer the handshake, then say the two things under test and
  // end the turn. Notifications are sent from inside the `session/prompt` handler
  // so they land while the queue is draining — which is the only time it does.
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
          send({ jsonrpc: "2.0", id, result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] } });
          break;
        case acp.methods.agent.session.new:
          // What the daemon actually put on the wire, which is the only place the
          // `_meta` that carries `ultracode` can be observed — it is a request
          // parameter, so no notification listener ever sees it.
          openParams.push(message["params"]);
          send({ jsonrpc: "2.0", id, result: { sessionId: "s_fake" } });
          /*
           * Commands, pushed the way both real adapters push them: *after* the
           * response, so they arrive outside any turn and before the first prompt
           * exists to drain the queue. That timing is the whole bug this replaced
           * — sent from inside the prompt handler like everything else here, it
           * would pass without ever testing it.
           *
           * The delay models the pipe rather than the adapter's own `setTimeout(…,
           * 0)`. `AcpClient` drops an update for a session it has not registered
           * yet (`router.sessions.get(...)?.onUpdate`), and registration happens in
           * the microtask that follows parsing the `session/new` result — so with
           * both ends in *this* process and one PassThrough between them, a
           * zero-delay push is routed before the handler exists and is lost. That
           * is an artefact of having no kernel in the way, not a bug this driver
           * should be pinning: measured 2026-08-03 against real claude 0.63.0 over
           * a real pipe, `Session.agentCommands` is empty the instant `start`
           * resolves and holds 99 commands 1ms later. The window is real and the
           * transport closes it.
           */
          setTimeout(() => {
            notify({
              sessionUpdate: "available_commands_update",
              availableCommands: [
                { name: "compact", description: "Compact the conversation", input: { hint: "<instructions>" } },
                { name: "status", description: "Show status", input: null },
              ],
            });
          }, 10);
          break;
        case acp.methods.agent.session.prompt:
          notify({ sessionUpdate: "usage_update", used: 40_000, size: 200_000 });
          // A spawn and one step inside it, shaped as claude sends them. The
          // *projection* is asserted further up this file; what nothing could reach
          // until now is the wiring — that `_meta` actually becomes two fields on
          // the event union rather than being read and dropped.
          notify({
            sessionUpdate: "tool_call",
            toolCallId: "spawn",
            title: "Task",
            kind: "think",
            status: "pending",
            _meta: { claudeCode: { toolName: "Agent", subagent: true } },
          });
          notify({
            sessionUpdate: "tool_call",
            toolCallId: "step",
            title: "Read",
            kind: "read",
            status: "pending",
            _meta: { claudeCode: { toolName: "Read", parentToolUseId: "spawn" } },
          });
          // The completing update of the spawn, which measurably *loses*
          // `subagent` — the reason the update arm carries only the edge.
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "spawn",
            status: "completed",
            _meta: { claudeCode: { parentToolUseId: "spawn" } },
          });
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "completed",
            rawInput: { command: "ls -la" },
            content: [
              { type: "content", content: { type: "text", text: "total 4\ndrwxr-xr-x  x" } },
              // Dropped on purpose: a terminal is a live handle, not a value, and
              // showing somebody an id they cannot use is worse than showing nothing.
              { type: "terminal", terminalId: "term_1" },
            ],
          });
          /*
           * codex's shape, measured against codex-acp 1.1.9: a finished command
           * with **no content block at all** and its stdout on `rawOutput`. Every
           * one of these was dropped, so a Bash card on a codex session showed the
           * command, a tick, and nothing else.
           */
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t2",
            status: "completed",
            rawOutput: { formatted_output: "hello from the shell\n", exit_code: 0 },
          });
          /*
           * And the case that must NOT double: blocks and `rawOutput` together,
           * which is what claude sends. The blocks win, and the raw copy is not
           * appended after them.
           */
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t3",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "the blocks" } }],
            rawOutput: { formatted_output: "the raw copy", exit_code: 0 },
          });
          // A tool whose raw output is not this shape at all. Nothing is invented
          // from it: `rawOutput` is `unknown` in the schema and reading further
          // would be guessing at somebody else's result object.
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t4",
            status: "completed",
            rawOutput: { stdout: "not the key we read" },
          });
          /*
           * ⭐ The model typing a tool's **arguments** into the content channel,
           * one token at a time. Measured 2026-08-13 against this daemon's own
           * database: one `Write` produced 715 of these, every block a strict
           * extension of the last, and they are 55.8% of every byte in it.
           *
           * The shape below is that run, shortened, with the two things that must
           * survive it: the update that first says `in_progress` (a status the
           * reader has not seen, so it may not be held back — the card draws it as
           * a spinner) and the one that ends the run.
           */
          notify({ sessionUpdate: "tool_call", toolCallId: "w1", title: "Write", kind: "edit", status: "pending" });
          for (const block of ["{", '{"path"', '{"path": "a.py"', '{"path": "a.py", "content": "x"}']) {
            notify({
              sessionUpdate: "tool_call_update",
              toolCallId: "w1",
              status: "in_progress",
              content: [{ type: "content", content: { type: "text", text: block } }],
            });
          }
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "w1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "Wrote 1 byte to a.py" } }],
          });
          /*
           * A block that extends the last, with a **diff beside it**. `toolOutput`
           * drops a diff block, so the rendered content is a single string and the
           * hold's own test cannot tell this apart from a draft — held, it would
           * take the `emitDiffs` call with it and lose a `file_change` for a patch
           * that really was written. The guard is on the raw block count.
           */
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "w1",
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "Wrote 1 byte to a.py more" } },
              { type: "diff", path: "/w/a.py", oldText: null, newText: "x" },
            ],
          });
          /*
           * A status-only update, then one block of real output. There is nothing
           * for that block to be a draft *of*, so it must go out at once — with an
           * empty-string base it would look like an extension of nothing (every
           * string starts with "") and sit held until the next event.
           */
          notify({ sessionUpdate: "tool_call", toolCallId: "w3", title: "Read", kind: "read", status: "pending" });
          notify({ sessionUpdate: "tool_call_update", toolCallId: "w3", status: "in_progress" });
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "w3",
            status: "in_progress",
            content: [{ type: "content", content: { type: "text", text: "the only output" } }],
          });
          // A cumulative run that is never followed by another update for its call:
          // the turn's own end has to flush the block it is holding, or the only
          // complete copy is lost.
          notify({ sessionUpdate: "tool_call", toolCallId: "w2", title: "Write", kind: "edit", status: "pending" });
          for (const block of ["a", "ab", "abc"]) {
            notify({
              sessionUpdate: "tool_call_update",
              toolCallId: "w2",
              status: "in_progress",
              content: [{ type: "content", content: { type: "text", text: block } }],
            });
          }
          send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
          break;
        default:
          if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
      }
    }
  });

  // A runtime that is the local one in every respect except where the agent is:
  // subclassing rather than hand-rolling the interface means a new required member
  // is a type error here rather than a silently untested path.
  class PipeRuntime extends LocalRuntime {
    // The agent is these pipes, so where the agent *is* on disk is not a question
    // this runtime should be answering — see stubAgentConfig.
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

  const session = await Session.start({ agent: "kimi", cwd: process.cwd(), runtime: new PipeRuntime() });
  const announced: { used: number; size: number }[] = [];
  const off = session.onUsageChanged((usage) => announced.push({ used: usage.used, size: usage.size }));
  const commandPushes: number[] = [];
  // Awaited rather than slept on: the push is asynchronous by construction, and a
  // fixed delay here would be a race that passes on this machine. The turn below
  // finishes in well under a millisecond, so without this the session is disposed
  // before the notification is even written.
  const commandsLanded = new Promise<void>((resolve) => {
    const offFirst = session.onCommandsChanged(() => {
      offFirst();
      resolve();
    });
  });
  const offCommands = session.onCommandsChanged((c) => commandPushes.push(c.commands.length));
  await commandsLanded;

  const events: any[] = [];
  for await (const event of session.prompt("hi")) events.push(event);
  off();
  offCommands();
  await session.dispose().catch(() => {});

  /*
   * The commands arrived before any turn did, which is the point.
   *
   * This is the assertion that would have failed before: the notification landed
   * in `onUpdate`'s `default:` arm, became an `other` event on a queue that only
   * drains inside a turn, and was first in line for eviction there. Now it is held
   * out of band and announced, exactly like the config and the usage above.
   */
  check("commands reach the session, from a push outside any turn", session.agentCommands.commands.map((c) => c.name), [
    "compact",
    "status",
  ]);
  check("with the hint the agent gave", session.agentCommands.commands[0]?.hint, "<instructions>");
  check("announced out of band", commandPushes, [2]);
  check(
    "and NOT in the log, where a prefix eviction would take them",
    events.some((e) => e.type === "other" && e.sessionUpdate === "available_commands_update"),
    false,
  );

  check("context usage reaches the session", session.contextUsage, { used: 40_000, size: 200_000, cost: null });
  check("and is announced out of band, since it never enters the log", announced, [{ used: 40_000, size: 200_000 }]);
  check("and is NOT in the log", events.some((e) => e.type === "other" && e.sessionUpdate === "usage_update"), false);

  // By id, not just by type: this section now sends several updates, and a bare
  // find-by-type silently reads whichever one happens to be first.
  const update = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t1");
  check("a tool update carries what the tool said", update?.content, ["total 4\ndrwxr-xr-x  x"]);
  check("and the arguments it was given", update?.rawInput, { command: "ls -la" });
  // A terminal handle is not output. If this ever starts passing with a second
  // entry, something decided an id was worth showing a person.
  check("but not a terminal handle", update?.content?.length, 1);

  /*
   * The other place a tool's output can be, and the rule that keeps it from
   * being counted twice. See `rawToolOutput`.
   */
  const rawOnly = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t2");
  const bothWays = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t3");
  const unknownShape = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t4");
  check("output that arrives only on rawOutput is carried", rawOnly?.content, ["hello from the shell"]);
  check("blocks win where an agent sends both, so nothing is doubled", bothWays?.content, ["the blocks"]);
  check("and a raw output of another shape invents nothing", unknownShape?.content, null);

  /*
   * ⭐ **The arguments being typed, and what reaches the log instead of them.**
   *
   * Four streamed blocks went in. What comes out is the one that first said
   * `in_progress` — a status the reader has not seen, which may never be held
   * back, because `EventList` draws it as a spinning `Loader` and `pending` as a
   * static glyph — then the final, complete form of the run, then the result.
   * The two blocks in the middle are drafts of the fourth and reach nothing.
   *
   * Asserted as the whole sequence rather than as a count: a count stays green if
   * the *wrong* two survive, and which two survive is the entire rule.
   */
  const w1 = events.filter((e) => e.type === "tool_call_update" && e.toolCallId === "w1");
  check("a streamed run reaches the log as its first block, its last, and the result", w1.map((e) => e.content), [
    ["{"],
    ['{"path": "a.py", "content": "x"}'],
    ["Wrote 1 byte to a.py"],
    ["Wrote 1 byte to a.py more"],
  ]);
  check("and the status that draws the spinner is not held back", w1[0]?.status, "in_progress");
  /*
   * The last of those extends the one before it and would have been held on the
   * rendered content alone — but it arrived with a diff beside it, and holding it
   * would have taken the `file_change` with it. The guard is the raw block count;
   * this is the only thing that says so.
   */
  check("a diff beside an extending block is never held back", events.some((e) => e.type === "file_change" && e.path === "/w/a.py"), true);

  /*
   * The run nothing follows. `onUpdate` cannot flush it — there is no next update
   * — so the turn's own end must, or the only complete copy of the block is lost.
   * This is the case that makes holding safe rather than a way to drop content.
   */
  const w2 = events.filter((e) => e.type === "tool_call_update" && e.toolCallId === "w2");
  check("a run the turn ends still delivers its last block", w2.map((e) => e.content), [["a"], ["abc"]]);

  /*
   * The base for the prefix test is `null` and not `""`. Every string starts with
   * the empty one, so an empty base makes the first block after a status-only
   * update look like a draft and holds it until something else happens — on a
   * tool whose whole output is that one block, until the end of the turn.
   */
  const w3 = events.filter((e) => e.type === "tool_call_update" && e.toolCallId === "w3");
  check("a lone output block is never mistaken for a draft", w3.map((e) => e.content), [null, ["the only output"]]);

  /*
   * And what the daemon *asks* for at the door.
   *
   * `_meta` is a request parameter, so it is invisible to every listener this
   * driver has: the only way to see it is to be the agent. The unit test of
   * `sessionMetaFor` proves the shape; this proves `Session` actually spreads it
   * onto `session/new` — and that a session which asked for nothing sends no
   * `_meta` key at all rather than an explicit `undefined`, which is a different
   * message to whatever is parsing it on the far side.
   */
  check("a session that asked for nothing carries no _meta", "_meta" in (openParams[0] ?? {}), false);

  /*
   * Lineage, from an agent's `_meta` to the event union.
   *
   * The section above asserts `toolCallLineage` in isolation; this is the only place
   * that proves `session.ts` actually spreads the result onto the event. Two
   * decisions ride on it and both are silent if reversed: the `tool_call` arm
   * carries **both** fields, and the `tool_call_update` arm carries **only** the
   * edge — measured 2026-08-01, claude drops `subagent` on a spawn's own
   * completing update, so mirroring it there would say "not a subagent any more"
   * about the call that just finished being one.
   */
  const calls = events.filter((e) => e.type === "tool_call");
  check(
    "a spawn arrives declared, with no parent of its own",
    calls.find((e) => e.toolCallId === "spawn"),
    { type: "tool_call", toolCallId: "spawn", title: "Task", kind: "think", status: "pending", locations: [], rawInput: null, parentToolCallId: null, subagent: true },
  );
  check(
    "and a call inside it carries the edge, byte for byte",
    [
      calls.find((e) => e.toolCallId === "step")?.parentToolCallId,
      calls.find((e) => e.toolCallId === "step")?.subagent,
    ],
    ["spawn", false],
  );
  // Asserted as an *absence*: the update arm must never grow a `subagent` key,
  // however tempting the symmetry looks.
  const spawnDone = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "spawn");
  check("a spawn's completing update never restates the flag", "subagent" in (spawnDone ?? {}), false);
  check("and an update with no lineage at all reports none", update?.parentToolCallId, null);

  /*
   * The first prompt names the session.
   *
   * The *derivation* is pure and asserted further up this file; what is asserted here
   * is the **wiring**, which nothing else can reach. `ManagedSession.prompt`
   * refuses without a live agent, so the restored rows above — which have
   * none — can only ever prove the negative half. This drives a real registry over
   * the same in-memory pipes, so the naming actually happens.
   *
   * Placement is the part that would break silently: the assignment sits *below*
   * the terminal/busy/not-ready guards, so a prompt the daemon refused never names
   * anything. A session called "hi" that never ran would be worse than one called
   * by its path.
   */
  const { SessionRegistry } = await import("../src/registry.js");
  const { MemoryEventStore } = await import("../src/events.js");

  // A second fake agent, because the first one's pipes are spent.
  const toAgent2 = new PassThrough();
  const toClient2 = new PassThrough();
  const send2 = (m: unknown) => toClient2.write(`${JSON.stringify(m)}\n`);
  let buffer2 = "";
  toAgent2.on("data", (chunk: Buffer) => {
    buffer2 += chunk.toString("utf8");
    for (let nl = buffer2.indexOf("\n"); nl >= 0; nl = buffer2.indexOf("\n")) {
      const line = buffer2.slice(0, nl);
      buffer2 = buffer2.slice(nl + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as Record<string, any>;
      const id = message["id"];
      if (message["method"] === acp.methods.agent.initialize) {
        send2({ jsonrpc: "2.0", id, result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] } });
      } else if (message["method"] === acp.methods.agent.session.new) {
        send2({ jsonrpc: "2.0", id, result: { sessionId: "s_named" } });
        // Scheduled *after* the answer, which is what both real adapters do.
        //
        // The delay is named rather than left at 0 on purpose, and so is what it
        // does *not* cover: this lands after the registry has subscribed, so what
        // it exercises is the announcement path. `onStarted`'s read-once — the
        // guard for a notification arriving in the gap between `Session.start`
        // resolving and that subscription — is not raced here, because with both
        // ends in one process and a `PassThrough` between them there is no kernel
        // to hold the write and the gap is not reproducible on demand. Saying so
        // beats an assertion that would pass either way and read as coverage.
        setTimeout(() => {
          send2({
            jsonrpc: "2.0",
            method: acp.methods.client.session.update,
            params: {
              sessionId: "s_named",
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [
                  { name: "compact", description: "Compact", input: { hint: "<how>" } },
                  { name: "status", description: "Status", input: null },
                ],
              },
            },
          });
        }, 5);
      } else if (message["method"] === acp.methods.agent.session.prompt) {
        send2({
          jsonrpc: "2.0",
          method: acp.methods.client.session.update,
          params: { sessionId: "s_named", update: { sessionUpdate: "usage_update", used: 61_000, size: 200_000 } },
        });
        send2({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      } else if (id !== undefined) {
        send2({ jsonrpc: "2.0", id, result: {} });
      }
    }
  });

  class NamingRuntime extends LocalRuntime {
    // Overridden so this does not probe the host for a real `kimi` — the point is
    // the registry's wiring, not whether this machine has an agent installed.
    override async availability(): Promise<any> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }

    // The same intent, and it was half-applied: `availability` was overridden and
    // `describe` was not, so `registry.create` still resolved a real binary on
    // PATH by way of `Session.start`. Unreached until the section above stopped
    // throwing first.
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<any> {
      return {
        stdin: toAgent2,
        stdout: toClient2,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent2.end(),
        kill: async () => {},
      };
    }
  }

  /** Let the in-flight turn drain, since `prompt` refuses while one is running. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  // `undefined` for the policy so the registry's own default applies — it is not
  // exported, and exporting it to satisfy a driver would be the driver shaping the
  // code rather than the other way round.
  const registry = new SessionRegistry(new MemoryEventStore(), null, undefined, new NamingRuntime());
  const workdir = tmp("namecheck-");
  const managed = await registry.create({ agent: "kimi", cwd: workdir });

  check("a fresh session has no name", managed.title, null);
  check("the first prompt names it", managed.prompt("Rework the reconnect backoff\nand the rest").kind, "accepted");
  check("after the first meaningful line", managed.title, "Rework the reconnect backoff");

  // The *snapshot* is what a browser reads, and it is a different object from the
  // `Session` asserted above — the registry has to mirror it there or the context
  // readout is on the wire and unreachable, which is where it started.
  await settle();
  check("and the registry mirrors it onto the snapshot", managed.snapshot().contextUsage, {
    used: 61_000,
    size: 200_000,
    cost: null,
  });
  // Copied, not referenced: `Object.freeze` is shallow, and a frame built now must
  // describe now.
  check(
    "as a copy, not a reference",
    managed.snapshot().contextUsage !== managed.snapshot().contextUsage,
    true,
  );

  // Written once. A second prompt must not rename what the first named, or a
  // session's identity would change under somebody every time they typed.
  managed.prompt("something else entirely");
  check("and a later prompt does not rename it", managed.title, "Rework the reconnect backoff");

  // A rename wins for ever, because the derivation is guarded on `null`.
  managed.setMeta({ title: "Mine" });
  await settle();
  managed.prompt("and another");
  check("a manual rename survives every later prompt", managed.title, "Mine");

  // Clearing re-arms it — the only sensible reading of clearing a name.
  managed.setMeta({ title: null });
  await settle();
  managed.prompt("Fresh start here");
  check("clearing re-arms the derivation", managed.title, "Fresh start here");

  /*
   * The command list on a real `ManagedSession`, which is where every rule about
   * it lives and where nothing reached before.
   *
   * The route-level assertion further up drives an unknown id and a session with
   * no live agent, so it could only ever prove the empty end — it stays green for
   * an implementation whose counter is hardwired to 0. What has to be true is the
   * *movement*: the list arrives, the number moves once for it, it does not move
   * for a republish that says nothing new, and it moves again — never back to
   * zero — when the agent goes.
   */
  check("the agent's commands reach the managed session", managed.agentCommands.commands.map((c) => c.name), [
    "compact",
    "status",
  ]);
  const firstRevision = managed.commandsRevision;
  check("and the revision moved exactly once to announce them", firstRevision, 1);
  check("which is what the snapshot carries", managed.snapshot().commandsRevision, firstRevision);

  /*
   * An identical republish is not an announcement.
   *
   * claude republishes from `commands_changed` as it discovers skills while
   * walking a subdirectory, so a byte-identical list arriving repeatedly inside
   * one turn is the ordinary case rather than the pathological one. Each bump
   * costs a snapshot, a row write and a frame per attached client on the agent's
   * own emit path — and then a full refetch of the list at every client, over the
   * relay. `usageWorthAnnouncing` guards the same shape one field over.
   */
  const republish = (commands: unknown[]) => {
    send2({
      jsonrpc: "2.0",
      method: acp.methods.client.session.update,
      params: {
        sessionId: "s_named",
        update: { sessionUpdate: "available_commands_update", availableCommands: commands },
      },
    });
    return settle();
  };
  await republish([
    { name: "compact", description: "Compact", input: { hint: "<how>" } },
    { name: "status", description: "Status", input: null },
  ]);
  check("the same list published again does not move the revision", managed.commandsRevision, firstRevision);
  await republish([
    { name: "compact", description: "Compact", input: { hint: "<how>" } },
    { name: "status", description: "Status", input: null },
    { name: "usage", description: "Usage", input: null },
  ]);
  check("a list that actually changed does", managed.commandsRevision, firstRevision + 1);
  check("and the new command is there to be fetched", managed.agentCommands.commands.length, 3);

  const beforeStop = managed.commandsRevision;
  await registry.stop(managed.id).catch(() => {});

  /*
   * The agent is gone, so the commands are — and the revision is *bumped* rather
   * than reset. It is a change marker, not a count: zeroing it would leave a
   * client holding revision 1 comparing 1 to 1 and keeping a menu whose agent no
   * longer exists.
   */
  check("stopping the agent withdraws its commands", managed.agentCommands, { commands: [], dropped: 0 });
  check("and moves the revision forward rather than back to zero", managed.commandsRevision, beforeStop + 1);
  check("which a client sees as a change, not as the daemon falling behind", managed.snapshot().commandsRevision > 0, true);
}

/* ------------------------------------------------------------------ *
 * Attachments — the pure rules
 *
 * A filename is a *label* here, not a location: the file is created inside a
 * directory named by 64 fresh random bits, so containment comes from the path
 * and not from the name. That is why this sanitizes where `safeRelPath` refuses,
 * and the two are asserted side by side so nobody later makes them agree.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a filename becomes\n");
{
  const named = (input: string): string =>
    sanitizeUploadName(input).ok ? (sanitizeUploadName(input) as { name: string }).name : `!${(sanitizeUploadName(input) as { reason: string }).reason}`;

  // Traversal is a *rename*, not a refusal: a browser's `File.name` has carried a
  // path on some platforms, and the directory it lands in is already unguessable.
  check("a traversal is reduced to its basename", named("../../etc/passwd"), "passwd");
  check("so is a windows path", named("C:\\Users\\me\\b.png"), "b.png");
  check("and an ordinary one", named("a/b/c.txt"), "c.txt");
  check("a dotfile keeps its dot", named(".gitignore"), ".gitignore");

  // These are refusals, and the CR one is the reason: this string is echoed into
  // a `Content-Disposition` header, where a CR is response splitting.
  check("a NUL is refused", named("x\u0000y"), "!nul_byte");
  check("a newline is refused", named("a\r\nb"), "!control_char");
  check("and so is a bare dot", named("."), "!reserved");
  check("or two", named(".."), "!reserved");
  check("a name of nothing but controls has nothing left", named("\u0001\u0002"), "!control_char");
  check("and an empty one is empty", named(""), "!empty");

  // Windows drops trailing dots and spaces silently, so a name that round-trips
  // differently there stops matching what was stored.
  check("trailing dots and spaces go", named("name.  "), "name");
  // Free, and this daemon will not always run on this platform.
  check("a device name is prefixed rather than refused", named("CON.txt"), "_CON.txt");
  check("case-insensitively", named("com1"), "_com1");

  const long = named(`${"x".repeat(400)}.png`);
  check("a long name is shortened to the cap", Buffer.byteLength(long, "utf8") <= 200, true);
  // Kept, because the extension is what a person and their OS both read.
  check("and keeps its extension", long.endsWith(".png"), true);
  // No `…[truncated N bytes]` marker: right for prose nobody types, wrong for a
  // name. Safe only because the response echoes the original.
  check("with no truncation marker", long.includes("truncated"), false);

  // Greek and an emoji on purpose, and the fixture stays non-ASCII: the byte
  // cap above counts UTF-8 bytes, so two- and four-byte code points are the only
  // input that tells a byte-wise truncation apart from a character-wise one.
  check("unicode survives byte for byte", named("αναφορά-📊.pdf"), "αναφορά-📊.pdf");

  /*
   * ⭐ **The clip may not reconstruct a name this function refuses.**
   *
   * `clipName` keeps the extension and cuts the stem to the **last** dot, so a
   * leading dot with the last dot at index 1 collapses the stem to `"."` while a
   * tail too long to be an extension is dropped entirely. Measured before the
   * fix: this input returned `{ok: true, name: "."}` — the value refused earlier
   * in the same function — because the reserved check ran on the input and never
   * on the result.
   */
  check("a clip may not rebuild a reserved name", sanitizeUploadName("..".concat("a".repeat(300))).ok, false);
  check("nor the bare current directory", sanitizeUploadName(".".concat(".", "b".repeat(400))).ok, false);
  // The ordinary long name still clips rather than being refused, which is the
  // property the arm above must not have cost.
  check("while an ordinary over-long name still clips", named("z".repeat(400).concat(".png")).endsWith(".png"), true);

  // **Accepted here on purpose.** Escaping quotes is the download header's job,
  // and asserting it in this direction is what stops the two being conflated.
  check("a quote is not this function's problem", named('a"b.txt'), 'a"b.txt');
}

process.stdout.write("\nwhat a download says its filename is\n");
{
  // The other door onto the same hazard: `safeRelPath` rejects NUL but **not**
  // CR or LF, and a workspace filename is a path component an *agent* chose.
  const injected = contentDispositionFor("a\r\nX-Evil: 1");
  check("no header value can contain a newline", /^[^\r\n]*$/.test(injected), true);
  check("a quote cannot end the quoted string", contentDispositionFor('a"b.txt').includes('filename="ab.txt"'), true);
  check("nor can a backslash", contentDispositionFor("a\\b.txt").includes('filename="ab.txt"'), true);
  check("always attachment, never inline", contentDispositionFor("a.txt").startsWith("attachment;"), true);
  check("unicode rides the RFC 5987 half", contentDispositionFor("αναφορά.pdf").includes("filename*=UTF-8''"), true);
  check(
    "and is percent-encoded there",
    contentDispositionFor("αναφορά.pdf").endsWith("%CE%B1%CE%BD%CE%B1%CF%86%CE%BF%CF%81%CE%AC.pdf"),
    true,
  );
  // A name that survives neither half still has to produce a usable header.
  check("a name with nothing ASCII left still gets one", contentDispositionFor("📊").includes('filename="_"'), true);
}

process.stdout.write("\nwhere uploads live\n");
{
  check("the default sits beside the database", resolveUploadRoot(undefined), join(homedir(), ".reemoat", "uploads"));
  check("a tilde expands", resolveUploadRoot("~/staged"), join(homedir(), "staged"));
  check(
    "a relative path is refused",
    (() => {
      try {
        resolveUploadRoot("staged");
        return "(accepted)";
      } catch {
        return "refused";
      }
    })(),
    "refused",
  );

  /*
   * The check that actually protects the second `rm` site in this codebase.
   *
   * `removeWorkspace` guards its `rmSync` with `containedIn(root, worktreeRoot)`
   * and the upload sweep guards its own with the mirror. If either root nested in
   * the other, one remover could reach into the other's tree and neither guard
   * would mean what it says. `daemon.ts` refuses to start on this; here it is
   * asserted in **both** directions, because nesting either way is the failure.
   */
  const uploadsRoot = resolveUploadRoot(undefined);
  const worktrees = join(homedir(), ".reemoat", "worktrees");
  check("the two roots do not nest", atOrUnder(uploadsRoot, worktrees), false);
  check("in either direction", atOrUnder(worktrees, uploadsRoot), false);
}

/* ------------------------------------------------------------------ *
 * Taking a file in, and letting the sender go on every refusal
 *
 * `Uploads.receive`'s running byte counter is the **only bound on a request
 * body anywhere in this system** — nothing in `src/`, the relay or the control
 * plane configures one, and the relay pipes bodies straight through. So this is
 * the path, and until now nothing drove it.
 *
 * The cancelling is the part worth the machinery. Refusing a half-read body and
 * simply stopping parks the sender against the relay's per-stream window, which
 * is granted on consumption; the next valve above that is the tunnel's 8 MiB
 * socket-buffer check, and it closes the **whole tunnel for this machine** —
 * every other session on it goes too. Every refusal below therefore asserts two
 * things: the answer, and that the body was released.
 *
 * **Which of those assertions pins `cancelBody` itself is worth writing down,
 * because it is only half of them.** Measured, by deleting each call in turn:
 * removing the one on the *post-loop* path — `too_large`, `quota` — changes
 * nothing here, because breaking out of a `for await` calls the async iterator's
 * `return()`, which cancels the stream anyway. Removing the one on a refusal
 * that happens **before the loop** — `too_many`, an unusable session id — fails
 * two cases immediately, and those are the paths where nothing else would ever
 * release the sender. So the `pulled: 0` assertions below are the load-bearing
 * ones, and the mid-body pair assert the property rather than the call.
 * ------------------------------------------------------------------ */

process.stdout.write("\ntaking a file in\n");
{
  /*
   * **The upload root is nested one level inside its own temp directory**, so the
   * traversal case below can assert about a path this run owns.
   *
   * Flat, `root` was the `mkdtemp` directory itself and `join(root, "..",
   * "escape")` normalized to `<tmpdir>/escape` — `/tmp/escape` on CI, which this
   * driver neither creates nor removes. Two failure modes, both silent: a single
   * run in which the refusal genuinely regressed leaves the file behind and the
   * case stays red on that machine for ever, and any unrelated `/tmp/escape` from
   * anything else on the host is a red that no other assertion explains.
   */
  const receiveHome = tmp("reemoat-receive-");
  const root = join(receiveHome, "root");
  mkdirSync(root, { recursive: true });
  const index = memoryUploadIndex();
  const uploads = await Uploads.open({ root, index, onWarning: () => {} });

  /** A body that records whether anybody read it and whether it was released. */
  const bodyOf = (chunks: Uint8Array[]) => {
    const state = { cancelled: false, pulled: 0 };
    let next = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next >= chunks.length) {
          controller.close();
          return;
        }
        state.pulled += 1;
        controller.enqueue(chunks[next]!);
        next += 1;
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  };
  const chunk = (bytes: number, fill = 7): Uint8Array => new Uint8Array(bytes).fill(fill);
  /** Directories under a session, which is what a leaked refusal would leave. */
  const dirsFor = (sessionId: string): string[] =>
    existsSync(join(root, sessionId)) ? readdirSync(join(root, sessionId)) : [];

  {
    const body = bodyOf([chunk(4), chunk(6)]);
    const result = await uploads.receive("s_take", {
      name: "notes.txt",
      origName: "notes.txt",
      mime: "text/plain",
      body: body.stream,
    });
    check("an ordinary upload is accepted", result.kind, "ok");
    if (result.kind === "ok") {
      check("counting every byte that arrived", result.row.bytes, 10);
      check("and telling the client what the session has spent", [result.sessionBytes, result.sessionCount], [10, 1]);
      check(
        "the bytes really are on disk",
        readFileSync(join(root, "s_take", result.row.uploadId, "notes.txt")).length,
        10,
      );
      // Named by 64 fresh random bits, which is where containment comes from —
      // the filename is a label and never a location.
      check("under an id nothing else could name", /^u_[0-9a-f]{16}$/.test(result.row.uploadId), true);
      check("and it can be resolved by that id", uploads.resolve("s_take", [result.row.uploadId]).ok, true);
    }
    check("an id nobody staged resolves to nothing", uploads.resolve("s_take", ["u_nope"]), {
      ok: false,
      missing: "u_nope",
    });
  }

  {
    /*
     * The refusals that happen **before a byte is read**, which is where
     * forgetting to cancel would be completely silent: the answer is correct, the
     * disk is untouched, and the sender is left parked. `pulled: 0` is what makes
     * this assertion about `cancelBody` rather than about the `for await` loop's
     * own cleanup.
     */
    for (let n = 0; n < MAX_UPLOADS_PER_SESSION; n += 1) {
      index.insert({
        sessionId: "s_many",
        uploadId: `u_pad${n}`,
        name: "pad",
        origName: "pad",
        mime: null,
        bytes: 1,
        createdAt: now,
        consumedAt: null,
      });
    }
    const body = bodyOf([chunk(4)]);
    const result = await uploads.receive("s_many", {
      name: "one-too-many.txt",
      origName: "one-too-many.txt",
      mime: null,
      body: body.stream,
    });
    check("the hundred-and-first file is refused", result.kind, "too_many");
    check("without reading a byte of it", body.state.pulled, 0);
    check("and the sender is released rather than parked", body.state.cancelled, true);
    check("with nothing left on disk", dirsFor("s_many"), []);
  }

  {
    // A session id that cannot be a path segment is refused the same way, and it
    // is the one refusal that protects the root itself rather than a budget.
    const body = bodyOf([chunk(4)]);
    const result = await uploads.receive("../escape", {
      name: "x.txt",
      origName: "x.txt",
      mime: null,
      body: body.stream,
    });
    check("an unusable session id is refused", result.kind, "write_failed");
    check("before anything is read", body.state.pulled, 0);
    check("and the body is still released", body.state.cancelled, true);
    // `receiveHome`, not `<tmpdir>` — the negative space being asserted about has
    // to be owned by this run, or an unrelated file on the host decides the case.
    check("with nothing created outside the root", existsSync(join(receiveHome, "escape")), false);
  }

  {
    /*
     * The per-session budget, reached without writing 100 MiB: the index is the
     * accounting and `receive` reads `bytesFor` before it opens anything. That is
     * also why the index is SQLite in production rather than a map — a restart
     * would otherwise reset every total to zero, and a restart is the ordinary
     * outcome of a deploy.
     */
    index.insert({
      sessionId: "s_full",
      uploadId: "u_prior",
      name: "prior",
      origName: "prior",
      mime: null,
      bytes: MAX_SESSION_UPLOAD_BYTES,
      createdAt: now,
      consumedAt: null,
    });
    /*
     * More chunks than it takes to trip the budget, so the refusal genuinely
     * happens mid-body. A body that has already been drained to its end has
     * nothing left to release — cancelling it is a no-op — so a single-chunk
     * fixture would assert nothing about the path that matters.
     */
    const body = bodyOf(Array.from({ length: 8 }, () => chunk(64)));
    const result = await uploads.receive("s_full", {
      name: "over.txt",
      origName: "over.txt",
      mime: null,
      body: body.stream,
    });
    check("a session already at its budget refuses the next file", result.kind, "quota");
    check("saying how much of it is already spent", result.kind === "quota" && result.used, MAX_SESSION_UPLOAD_BYTES);
    check("the refusal is immediate rather than after the whole body", body.state.pulled < 8, true);
    check("the body is released", body.state.cancelled, true);
    check("and the directory it had started is removed again", dirsFor("s_full"), []);
  }

  {
    /*
     * The running counter itself — the backstop for a chunked body and for a
     * client that lies about `content-length`, which is the only reason the route
     * can trust a declared length at all.
     *
     * Streamed rather than allocated whole: the check runs *before* each write,
     * so at most one chunk past the limit is ever in memory and none of it
     * reaches the disk.
     *
     * ⚠ **This drives the real constant, so it costs a real `MAX_UPLOAD_BYTES` of
     * writes**, and that quadrupled when the cap did. Two things keep it honest
     * rather than merely slow. The chunk is **one buffer, enqueued repeatedly** —
     * nothing here mutates it, and building an array of a hundred separate
     * mebibytes put the whole cap on the heap to test a bound that exists so it
     * never is. And the chunk is 8 MiB rather than 1, which is the same journey
     * in an eighth of the pulls; the assertion below is `pulled < chunks.length`,
     * a claim about stopping early rather than about a particular count, so the
     * granularity is free to be coarse.
     *
     * Driving a smaller injected cap was the alternative and was declined: the
     * number this asserts is the number the daemon actually enforces, and a
     * driver that agrees with a parameter it passed in has asserted nothing.
     */
    const step = 8 * 1024 * 1024;
    const shared = chunk(step, 3);
    // Deliberately more than it takes to cross the line, so "it stopped early"
    // is a claim with something to be wrong about.
    const chunks = Array.from({ length: Math.ceil(MAX_UPLOAD_BYTES / step) + 3 }, () => shared);
    const body = bodyOf(chunks);
    const result = await uploads.receive("s_big", {
      name: "huge.bin",
      origName: "huge.bin",
      mime: null,
      body: body.stream,
    });
    check("a file over the per-file cap is refused", result.kind, "too_large");
    check("part-way through rather than after taking all of it", body.state.pulled < chunks.length, true);
    check("the body is released", body.state.cancelled, true);
    // Unlink, then rmdir, then cancel — a refusal that left the partial file
    // would be a bound on the *answer* and not on the disk.
    check("and the partial file is gone, not merely unreferenced", dirsFor("s_big"), []);
    check("with nothing recorded against the session", index.bytesFor("s_big"), 0);
  }

  await uploads.shutdown();
}

/* ------------------------------------------------------------------ *
 * How fast one session may spend this machine's disk
 *
 * The soft bound beside the hard ones. `MAX_SESSION_UPLOAD_BYTES` and
 * `MAX_UPLOADS_PER_SESSION` are totals that never refill; this is a window, and
 * it exists because the per-file cap went up 4× in the same change that added it.
 *
 * Driven as the pure decision rather than through `receive`, and that is the only
 * way it *can* be driven: reaching `UPLOAD_RATE_BYTES` end-to-end means writing
 * 300 MiB to a temp directory, per run, offline — which is not a cost this repo
 * pays, so the alternative to asserting the function is asserting nothing. The
 * class around it holds a `Map` and calls this; there is no second decision in it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nhow fast one session may upload\n");
{
  const now = 1_700_000_000_000;
  const full = [{ at: now - 1_000, bytes: UPLOAD_RATE_BYTES }];

  check("a session that has uploaded nothing goes ahead", uploadRateVerdict([], now).waitMs, 0);
  check(
    "and one still under the budget does too",
    uploadRateVerdict([{ at: now - 1_000, bytes: UPLOAD_RATE_BYTES - 1 }], now).waitMs,
    0,
  );

  // Exactly the budget is refused rather than allowed one more, which is the
  // boundary `uploadRateVerdict` states explicitly so it cannot drift by a `<=`.
  check("spending precisely the budget is already too much", uploadRateVerdict(full, now).waitMs > 0, true);
  /*
   * The wait is *when the oldest entry falls out*, to the millisecond — an
   * arbitrary backoff would be a number nobody can check, and one that is too
   * short is a client retrying into the same refusal.
   */
  check("and the wait is when the oldest spend ages out", uploadRateVerdict(full, now).waitMs, UPLOAD_RATE_WINDOW_MS - 1_000);

  /*
   * The window really is a window: the same bytes, older, decide nothing.
   * `at > floor` is strict, so an entry exactly `UPLOAD_RATE_WINDOW_MS` old is
   * already out — the boundary again, and stated in the same direction.
   */
  const stale = [{ at: now - UPLOAD_RATE_WINDOW_MS, bytes: UPLOAD_RATE_BYTES * 4 }];
  check("bytes older than the window are not spent at all", uploadRateVerdict(stale, now).waitMs, 0);
  check("and are dropped rather than carried", uploadRateVerdict(stale, now).kept, []);

  // Half in and half out: only what is still inside counts, so a session cannot
  // be held down by what it did an hour ago.
  const straddling = [
    { at: now - UPLOAD_RATE_WINDOW_MS - 1, bytes: UPLOAD_RATE_BYTES },
    { at: now - 10, bytes: 1 },
  ];
  check("a mixed window counts only what is inside it", uploadRateVerdict(straddling, now).waitMs, 0);
  check("keeping exactly those entries", uploadRateVerdict(straddling, now).kept.length, 1);

  // Never zero while refusing: `Retry-After: 0` invites the retry it refuses.
  const onTheEdge = [{ at: now - UPLOAD_RATE_WINDOW_MS + 1, bytes: UPLOAD_RATE_BYTES }];
  check("a refusal never says to retry immediately", uploadRateVerdict(onTheEdge, now).waitMs >= 1, true);
}

/* ------------------------------------------------------------------ *
 * What an attachment becomes on the wire to the agent
 *
 * One function holds every block rule, so a driver can assert the exact array
 * against a fake capability set rather than against a live agent.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat an attachment becomes\n");
{
  const uploadRoot = tmp("reemoat-uploads-");
  const index = memoryUploadIndex();
  const uploads = await Uploads.open({ root: uploadRoot, index, onWarning: () => {} });

  const stage = (name: string, mime: string | null, bytes: Buffer): UploadRow => {
    const row: UploadRow = {
      sessionId: "s_one",
      uploadId: `u_${name}`,
      name,
      origName: name,
      mime,
      bytes: bytes.length,
      createdAt: now,
      consumedAt: null,
    };
    mkdirSync(join(uploadRoot, row.sessionId, row.uploadId), { recursive: true });
    writeFileSync(join(uploadRoot, row.sessionId, row.uploadId, name), bytes);
    index.insert(row);
    return row;
  };

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const small = stage("shot.png", "image/png", png);
  const text = stage("log.txt", "text/plain", Buffer.from("hello\n"));
  const unknown = stage("blob.bin", null, Buffer.from("x"));
  const huge = stage("big.png", "image/png", Buffer.alloc(6 * 1024 * 1024, 1));

  // Every attachment gets one of these and it is the block that is never wrong —
  // ACP requires every agent to support `resource_link`. That is the whole reason
  // the composer's paperclip needs no capability gate.
  const linksOnly = await uploads.blocksFor([small, text, unknown], { image: false });
  check("with no image capability, every file is a link", linksOnly.map((b) => b.type), [
    "resource_link",
    "resource_link",
    "resource_link",
  ]);
  check("carrying the stored name", (linksOnly[0] as { name: string }).name, "shot.png");
  check("its size", (linksOnly[0] as { size: number }).size, png.length);
  // `file://`, because the agent runs as this user on this machine and can open
  // it. An HTTP URL would need a token it does not have.
  check("and a file URL", (linksOnly[0] as { uri: string }).uri.startsWith("file://"), true);

  const withImage = await uploads.blocksFor([small], { image: true });
  check("an image agent gets the link and the bytes", withImage.map((b) => b.type), ["resource_link", "image"]);
  // Round-tripped rather than merely present: base64 of the wrong file would look
  // identical to this assertion's neighbours.
  check(
    "and the bytes are the file's",
    Buffer.from((withImage[1] as { data: string }).data, "base64").equals(png),
    true,
  );

  check("a text file is never inlined", (await uploads.blocksFor([text], { image: true })).map((b) => b.type), [
    "resource_link",
  ]);
  check("nor is one with no declared type", (await uploads.blocksFor([unknown], { image: true })).map((b) => b.type), [
    "resource_link",
  ]);
  // 6 MiB raw is ~8 MiB of base64 in one JSON-RPC write to the agent's stdin.
  check("nor an image over the inline cap", (await uploads.blocksFor([huge], { image: true })).map((b) => b.type), [
    "resource_link",
  ]);

  // The same decision the recorded `inlined` flag is built from, which is what
  // stops the event and the blocks disagreeing.
  check("and `inlinesImage` agrees with all four", [
    inlinesImage(small.mime, small.bytes, { image: true }),
    inlinesImage(text.mime, text.bytes, { image: true }),
    inlinesImage(unknown.mime, unknown.bytes, { image: true }),
    inlinesImage(huge.mime, huge.bytes, { image: true }),
  ], [true, false, false, false]);
  check("and says no when the agent cannot take one", inlinesImage(small.mime, small.bytes, { image: false }), false);

  /*
   * An image the agent handed back is kept rather than dropped.
   *
   * Measured before this existed: `renderContentBlock` hit its `default:` arm and
   * returned the literal string `[image]`, three times in one real database, all
   * from `Read` on a picture — so asking an agent about a screenshot produced a
   * transcript that could not show the screenshot.
   */
  const returned = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
  const kept = uploads.keepAgentImage("s_agent", "image/png", returned.toString("base64"));
  // Its own line, above the guard, for the two reasons this file keeps making:
  // `kept!` was a non-null assertion over precisely the failure these lines catch,
  // so a dropped row threw a TypeError out of the driver instead of failing one
  // check and letting the rest of the file run; and a check that reads through
  // `kept?.` still has to say what it wants when there is no row.
  check("an agent image gets a row", kept !== null, true);
  if (kept) {
    check("carrying the bytes it was handed", kept.bytes, returned.length);
    check("named from its declared type", kept.name.endsWith(".png"), true);
    /*
     * Already consumed: it is referenced by an event the instant it exists, so
     * the unconsumed TTL must never reach it. Read into a local and asserted in
     * two halves, because `index.get(...)?.consumedAt !== null` is *true* when
     * `get` returns nothing — the row having never reached the index is the
     * failure, and it used to pass.
     */
    const indexed = index.get("s_agent", kept.uploadId);
    check("the index really holds it", indexed !== null, true);
    check("and is consumed immediately, so no TTL reaches it", indexed !== null && indexed.consumedAt !== null, true);
    // The write is deferred because the caller is the emit path, which never
    // awaits — so the bytes land a tick later, not before this returns.
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("the bytes land on disk shortly after", existsSync(join(uploadRoot, "s_agent", kept.uploadId, kept.name)), true);
    check("and round-trip", readFileSync(join(uploadRoot, "s_agent", kept.uploadId, kept.name)).equals(returned), true);
  }
  // The same per-session ceiling user uploads have. An agent returning a
  // thousand screenshots spends the budget and then stops, rather than filling
  // the disk silently.
  check("an unusable session id is refused", uploads.keepAgentImage("../escape", "image/png", returned.toString("base64")), null);
  check("and so is an empty payload", uploads.keepAgentImage("s_agent", "image/png", ""), null);

  /*
   * A session id shaped like a traversal removes nothing.
   *
   * Ids come from the registry and never from a request, so this is
   * self-protection in exactly the sense `worktree.ts` means it: what it guards
   * is the second `rm` in this codebase.
   */
  const sentinel = join(uploadRoot, "..", "sentinel-must-survive");
  writeFileSync(sentinel, "keep", "utf8");
  await uploads.forgetSession("../escape");
  check("an unusable session id removes nothing outside the root", existsSync(sentinel), true);

  await uploads.forgetSession("s_one");
  check("forgetting a session takes its directory", existsSync(join(uploadRoot, "s_one")), false);
  check("and its rows", index.countFor("s_one"), 0);
  await uploads.shutdown();
}

/* ------------------------------------------------------------------ *
 * A prompt event that carries files
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat an attachment costs an event\n");
{
  const refs = Array.from({ length: 10 }, (_, i) => ({
    uploadId: `u_${"x".repeat(60)}${i}`,
    name: "n".repeat(200),
    mime: "m".repeat(128),
    bytes: 1234,
    inlined: false,
  }));
  const bare = { type: "prompt", text: "hi", attachments: null } as const;
  const laden = { type: "prompt" as const, text: "hi", attachments: refs };

  check("an attachment is accounted rather than ignored", estimateBytes(laden) > estimateBytes(bare), true);
  // The arithmetic written into the comment on `attachmentBytes`, asserted: the
  // worst legal case has to sit well under the per-event cap.
  check("and ten maximal ones stay far under the per-event cap", estimateBytes(laden) < 128 * 1024, true);

  const long = { type: "prompt" as const, text: "y".repeat(200 * 1024), attachments: refs };
  const cut = truncateEvent(long, 128 * 1024) as typeof long;
  // Untouched, for the reason `parentToolCallId` is: a clipped attachment is not
  // a smaller attachment, it is a reference to a file that cannot be found.
  check("every attachment survives truncation byte for byte", cut.attachments, refs);
  check("the text is what gets clipped", cut.text.length < long.text.length, true);
  /*
   * The assertion that catches the boundary bug rather than the obvious one.
   *
   * Clipping the text to the *full* budget leaves an event whose attachments push
   * it back over, and comparing only the text length passes with that bug present.
   */
  check("and the result really is under the cap", estimateBytes(cut) <= 128 * 1024, true);
}

/* ------------------------------------------------------------------ *
 * Serving a file, and refusing to
 * ------------------------------------------------------------------ */

process.stdout.write("\nserving one file out of a session\n");
{
  const raw = async (path: string): Promise<Response> =>
    app.fetch(new Request(`http://d${path}`, { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }));

  // The pair the loop above could not carry, and the positive control is the half
  // that matters: a "404 for an unknown id" assertion alone stays green for a
  // route that 404s for everybody, which is exactly how `stream` once did.
  check("an unknown id is 404 here too", (await raw("/sessions/s_nope/files?path=notes.txt")).status, 404);

  const ok = await raw("/sessions/s_one/files?path=notes.txt");
  check("a real file is served", ok.status, 200);
  check("and its bytes are its bytes", await ok.text(), "hi\n");
  /*
   * The four headers, and they are the security of this route rather than
   * decoration.
   *
   * The reason used to be the credential in the URL — `readCredential` took
   * `?token=` anywhere, so a download opened in a tab carried a live daemon token
   * in `location.search` for script in a rendered response to read. That door is
   * shut (see "`?token=` is the handshake's exception" above, which asserts it),
   * and these headers are not one bit less load-bearing for it: this route serves
   * **any regular file under a session's workspace**, so a rendered HTML or SVG
   * response executes on the daemon's own origin, where it reaches every route
   * with whatever credential the page embedding it holds — and a `blob:` made
   * from it inherits that origin.
   */
  check("never a type a browser will render", ok.headers.get("content-type"), "application/octet-stream");
  check("always a save", ok.headers.get("content-disposition")?.startsWith("attachment;"), true);
  // Not redundant beside `attachment`: it also stops a proxy or a CDN in front of
  // this daemon re-typing the body into something renderable.
  check("nothing may re-sniff it", ok.headers.get("x-content-type-options"), "nosniff");
  // A private file, fetched under a bearer credential: a cacheable response is
  // that file sitting in a shared cache.
  check("and nothing may cache it", ok.headers.get("cache-control"), "no-store");

  /*
   * ⭐ **And it is never gzipped, which is a fifth header with the same standing.**
   *
   * `gzipResponses` runs on every route in this app, and the client refuses an
   * oversized file by reading `content-length` **before** the body is resident —
   * `Content-Length` being the one size header CORS exposes without
   * `Access-Control-Expose-Headers`. Compressed, that number would describe the
   * packed size, so the 100 MiB guard would silently measure the wrong quantity and
   * a file that does not fit would walk through it.
   *
   * What excludes it is `compressible`, keyed on the **content type** asserted three
   * lines up rather than on this path — a path test does the same job today and
   * fails open the day somebody adds a route that streams bytes. Driven on a 40 KiB
   * file, because a 3-byte one is under the threshold and would pass either way.
   */
  const big = await app.fetch(
    new Request("http://d/sessions/s_one/files?path=big.txt", {
      headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "accept-encoding": "gzip" },
    }),
  );
  check("a download a client would take gzipped is not gzipped", big.headers.get("content-encoding"), null);
  check("and its length is the file's own", big.headers.get("content-length"), String(40 * 1024));
  check("which is the number the client's own cap reads", (await big.arrayBuffer()).byteLength, 40 * 1024);

  const refusal = async (path: string): Promise<string> => {
    const answer = await raw(path);
    const body = (await answer.json()) as { error?: { code?: string; detail?: { reason?: string } } };
    return `${answer.status} ${body.error?.detail?.reason ?? body.error?.code ?? ""}`.trim();
  };

  // These prove the *route* uses `safeRelPath`, which is the only place it can be
  // proved: each `reason` is one of its own rejections.
  check("a path is required", (await raw("/sessions/s_one/files")).status, 400);
  check("climbing out is refused", await refusal("/sessions/s_one/files?path=../../etc/passwd"), "400 dot_segment");
  check("an absolute path is refused", await refusal("/sessions/s_one/files?path=/etc/passwd"), "400 absolute");
  // Serving `.git/config` would leak remote URLs and the credential helper.
  check("and so is the git directory", await refusal("/sessions/s_one/files?path=.git/config"), "400 git_dir");

  const root = join(users, "u_alice", "proj");
  mkdirSync(join(root, "sub"), { recursive: true });
  symlinkSync("/etc/passwd", join(root, "escape.txt"));
  // Refused by *shape*, never by where it points — the general form of the
  // `ln -s ~/.ssh/id_rsa x` measurement `changes.ts` records for the diff route.
  check("a symlink is not a regular file", await refusal("/sessions/s_one/files?path=escape.txt"), "404 not_a_regular_file");
  check("nor is a directory", await refusal("/sessions/s_one/files?path=sub"), "404 not_a_regular_file");
  check("nor is something that is not there", await refusal("/sessions/s_one/files?path=absent.txt"), "404 not_a_regular_file");

  /* ---- containment, in the two halves it is now answered in ---- */

  /*
   * **`safeRelPath` used to finish with two `realpathSync` calls, on
   * `<workspace.root>/<whatever the caller typed>`.**
   *
   * That is the one thing `stall.ts` exists to prevent, reached by a route nobody
   * had counted: for a `plain` session — which `s_one` is, and which every
   * session created without a worktree is — `workspace.root` *is* the `cwd` the
   * caller named, so a hard NFS mount underneath it took every session, every
   * socket and `/health` down at 0% CPU. `workspaceReady` could not save it: it
   * probes the root, which answers instantly, while the stall is one directory
   * further down. An agent reaches the same call with one `ln -s /mnt/nas nas`
   * inside its own worktree.
   *
   * So the string rules stayed synchronous and the filesystem question became
   * `probeContained`, bounded and remembered like every other caller-named path
   * here. The pair below is what says the move was a move: the syntactic half
   * **accepts** a symlink out of the tree, and the route still refuses it.
   */
  // Pointing at a real directory outside this session's tree, which is what makes
  // the parent resolve somewhere the containment rule has to reject.
  symlinkSync(uAbcd, join(root, "out"));
  /*
   * **The half-revert catcher, and the security property.** `safeRelPath` no
   * longer answers this, so a `requestedPath` that forgot to await
   * `probeContained` would serve the bytes of a file outside the workspace to
   * anyone holding a `session:read` token — with every other assertion in this
   * section still green.
   */
  check("a symlinked parent still cannot leave the tree", await refusal("/sessions/s_one/files?path=out/notes.txt"), "400 escapes_tree");
  // And the same input, syntactically. This one is the direct revert catcher: put
  // the `realpathSync` pair back and it answers `escapes_tree` here instead.
  check("while the string rules alone accept it, having stopped asking the disk", safeRelPath(root, "out/notes.txt").ok, true);
  check(
    "and still refuse everything that is genuinely about the string",
    ["../x", "/x", ".git/x", "a\u0000b", "a\\b", ""].map((input) => safeRelPath(root, input).ok),
    [false, false, false, false, false, false],
  );

  /*
   * The filesystem half on its own, with **"could not tell" as a real third
   * answer** — the same shape `probeExists` and `Liveness` already carry, and for
   * the same reason: a file on a sleeping mount is not a file outside the tree.
   *
   * Two of these are deliberately *not* refusals. The **parent** is resolved and
   * never the leaf, because a symlink whose target is outside the tree is a
   * legitimate changed file that git tracks as a link; and a path that resolves
   * to nothing at all is `true`, because "not there" is not a traversal and the
   * caller has a better word for it — `path_not_changed` for the diff route,
   * `not_a_regular_file` for this one, both asserted above.
   */
  forgetStalled();
  const under = (rel: string): string => join(root, rel);
  check("a path inside the tree is contained", await probeContained(root, under("notes.txt")), true);
  check("one whose parent resolves out of it is not", await probeContained(root, under("out/notes.txt")), false);
  check("one that is simply not there is, because that is not a traversal", await probeContained(root, under("nowhere/x.txt")), true);
  /*
   * The third answer, forced with a deadline that has already passed — the same
   * seam every other probe in this file uses, because a genuinely stalled mount
   * is the one thing a driver cannot synthesize. `requestedPath` turns this into
   * `503 path_unresponsive`; that route arm is *not* reachable offline, because
   * `workspaceReady` probes the root first and answers its own 503, so producing
   * it needs a root that answers with a stall underneath it — and the memory that
   * makes a stall observable here clears itself the moment the abandoned probe
   * settles, which happens during `workspaceReady`'s own `stat`.
   */
  check("and a deadline that has passed is neither", await probeContained(root, under("notes.txt"), { probeTimeoutMs: 0 }), null);
  forgetStalled();

  /*
   * ⚠ **The `.git` refusal was purely syntactic, and one symlink walked past
   * it.** `safeRelPath` reads the segments the caller *typed*, and its own
   * comment gives the reason as a security rule — `.git/config` carries remote
   * URLs and the credential helper configuration. With `g -> .git` inside the
   * tree, `?path=g/config` contains no `.git` segment to refuse, and containment
   * genuinely holds, because `.git` really is inside the workspace. Both checks
   * passed and the bytes went out to a read-only grant.
   *
   * The link is the shape that actually occurs: git's hardening covers writing
   * *through* such a link, not its existence, so one survives a clone — and an
   * agent makes one with a single `ln -s`.
   *
   * Asserted on the resolved answer rather than on the route alone, so the rule
   * is pinned where it is decided.
   */
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[remote]\n  url = git@github.com:someone/private.git\n");
  symlinkSync(join(root, ".git"), join(root, "g"));
  forgetStalled();
  check("a path the caller spells with .git is refused syntactically", safeRelPath(root, ".git/config").ok, false);
  check(
    "and one that reaches the same directory through a link is refused too",
    await probeRequestable(root, under("g/config")),
    "git_dir",
  );
  check("while an ordinary file beside it still resolves", await probeRequestable(root, under("notes.txt")), "ok");
  /*
   * The root's *own* absolute path is not the caller's doing, so a workspace that
   * legitimately lives under a directory called `.git` — a backup tree, a
   * fixture — must not be unservable in its entirety. Only the part below the
   * root is examined, and this is what says so.
   */
  {
    const oddRoot = tmp("gitnamed-");
    const nested = join(oddRoot, ".git", "workspace");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "notes.txt"), "ordinary\n");
    check(
      "a workspace whose own path contains .git is still servable",
      await probeRequestable(nested, join(nested, "notes.txt")),
      "ok",
    );
  }
  forgetStalled();

  /*
   * Text is required only when nothing came with it.
   *
   * The route used to validate `text` *before* it had looked at `attachments`,
   * which made a message that is only a screenshot impossible — an ordinary thing
   * to send. Both refusals are asserted, because relaxing one is how the other
   * gets relaxed by accident.
   */
  const prompted = async (body: unknown): Promise<string> => {
    const answer = await app.fetch(
      new Request("http://d/sessions/s_one/prompt", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const parsed = (await answer.json()) as { error?: { code?: string; message?: string } };
    return `${answer.status} ${parsed.error?.code ?? "ok"}`;
  };
  // Still refused: an empty prompt with nothing attached is a mis-tap, and
  // answering it would start a turn about nothing.
  check("an empty prompt with no files is refused", await prompted({ text: "   " }), "400 bad_request");
  check("and a missing text is still a type error", await prompted({ attachments: [] }), "400 bad_request");
  /*
   * Empty text *with* an attachment gets past the text guard and is refused
   * later, by the upload store this driver does not have. That is the assertion:
   * `503 uploads_unavailable` proves the text check no longer fires, which a
   * `400` would not distinguish from the old behaviour.
   */
  check("but an empty prompt carrying a file gets past it", await prompted({ text: "", attachments: ["u_x"] }), "503 uploads_unavailable");

  // This driver builds the app with no upload store, so the routes that need one
  // say so rather than pretending. Same shape as `credentials` and `logins`.
  check("with no upload store, staged files are unavailable", await refusal("/sessions/s_one/uploads/u_x"), "503 uploads_unavailable");
  const staged = await app.fetch(
    new Request("http://d/sessions/s_one/uploads?name=a.txt", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "text/plain" },
      body: "hello",
    }),
  );
  check("and staging one is too", staged.status, 503);
}
