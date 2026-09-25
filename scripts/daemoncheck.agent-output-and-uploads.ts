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
import { atOrUnder, resolveStateRoot } from "../src/paths.js";
import { resolveWorktreeRoot } from "../src/worktree.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { memoryUploadIndex, users, uAbcd, now, tokenFor, app, stubAgentConfig } from "./daemoncheck.fixtures.js";

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

  const openParams: any[] = [];

  // Notifications go out from inside the prompt handler so they land while the queue is draining.
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
          // `_meta` is a request parameter, so this is the only place it can be observed.
          openParams.push(message["params"]);
          send({ jsonrpc: "2.0", id, result: { sessionId: "s_fake" } });
          // Pushed after the response and outside any turn, as real adapters do; the delay stands in for the pipe, since an update before registration is dropped.
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
              // Dropped on purpose: a terminal is a live handle, not a value.
              { type: "terminal", terminalId: "term_1" },
            ],
          });
          // codex's shape: no content block, stdout on `rawOutput`.
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t2",
            status: "completed",
            rawOutput: { formatted_output: "hello from the shell\n", exit_code: 0 },
          });
          // claude's shape, blocks and `rawOutput` together: the blocks win and nothing is doubled.
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t3",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "the blocks" } }],
            rawOutput: { formatted_output: "the raw copy", exit_code: 0 },
          });
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t4",
            status: "completed",
            rawOutput: { stdout: "not the key we read" },
          });
          // The model streaming a tool's arguments, each block extending the last; the first `in_progress` and the final block must survive.
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
          // A diff beside an extending block: holding it would lose the `file_change`, so the guard is the raw block count.
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "w1",
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "Wrote 1 byte to a.py more" } },
              { type: "diff", path: "/w/a.py", oldText: null, newText: "x" },
            ],
          });
          notify({ sessionUpdate: "tool_call", toolCallId: "w3", title: "Read", kind: "read", status: "pending" });
          notify({ sessionUpdate: "tool_call_update", toolCallId: "w3", status: "in_progress" });
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "w3",
            status: "in_progress",
            content: [{ type: "content", content: { type: "text", text: "the only output" } }],
          });
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

  // Subclassed rather than hand-rolled, so a new required member is a type error here.
  class PipeRuntime extends LocalRuntime {
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
  // Awaited rather than slept on: a fixed delay would be a race.
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

  // By id, not type: this section sends several updates of the same type.
  const update = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t1");
  check("a tool update carries what the tool said", update?.content, ["total 4\ndrwxr-xr-x  x"]);
  check("and the arguments it was given", update?.rawInput, { command: "ls -la" });
  check("but not a terminal handle", update?.content?.length, 1);

  const rawOnly = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t2");
  const bothWays = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t3");
  const unknownShape = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t4");
  check("output that arrives only on rawOutput is carried", rawOnly?.content, ["hello from the shell"]);
  check("blocks win where an agent sends both, so nothing is doubled", bothWays?.content, ["the blocks"]);
  check("and a raw output of another shape invents nothing", unknownShape?.content, null);

  // The whole sequence, not a count: a count stays green if the wrong two survive.
  const w1 = events.filter((e) => e.type === "tool_call_update" && e.toolCallId === "w1");
  check("a streamed run reaches the log as its first block, its last, and the result", w1.map((e) => e.content), [
    ["{"],
    ['{"path": "a.py", "content": "x"}'],
    ["Wrote 1 byte to a.py"],
    ["Wrote 1 byte to a.py more"],
  ]);
  check("and the status that draws the spinner is not held back", w1[0]?.status, "in_progress");
  check("a diff beside an extending block is never held back", events.some((e) => e.type === "file_change" && e.path === "/w/a.py"), true);

  const w2 = events.filter((e) => e.type === "tool_call_update" && e.toolCallId === "w2");
  check("a run the turn ends still delivers its last block", w2.map((e) => e.content), [["a"], ["abc"]]);

  // The prefix base is null, not an empty string: every string extends the empty one.
  const w3 = events.filter((e) => e.type === "tool_call_update" && e.toolCallId === "w3");
  check("a lone output block is never mistaken for a draft", w3.map((e) => e.content), [null, ["the only output"]]);

  // Key absence, not undefined: an explicit undefined is a different message on the wire.
  check("a session that asked for nothing carries no _meta", "_meta" in (openParams[0] ?? {}), false);

  // The `tool_call` arm carries both lineage fields, the update arm only the edge: claude drops `subagent` on a spawn's completing update.
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
  const spawnDone = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "spawn");
  check("a spawn's completing update never restates the flag", "subagent" in (spawnDone ?? {}), false);
  check("and an update with no lineage at all reports none", update?.parentToolCallId, null);

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
        // Sent after the answer, as real adapters do; this exercises the announcement path, not the read-once in `onStarted`, which one process cannot race.
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
    // Both overridden so nothing probes or resolves a real `kimi` on this host.
    override async availability(): Promise<any> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }

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

  // `undefined` for the policy so the registry's own, unexported default applies.
  const registry = new SessionRegistry(new MemoryEventStore(), null, undefined, new NamingRuntime());
  const workdir = tmp("namecheck-");
  const managed = await registry.create({ agent: "kimi", cwd: workdir });

  check("a fresh session has no name", managed.title, null);
  check("the first prompt names it", managed.prompt("Rework the reconnect backoff\nand the rest").kind, "accepted");
  check("after the first meaningful line", managed.title, "Rework the reconnect backoff");

  await settle();
  check("and the registry mirrors it onto the snapshot", managed.snapshot().contextUsage, {
    used: 61_000,
    size: 200_000,
    cost: null,
  });
  // Copied, not referenced: `Object.freeze` is shallow, and a frame built now must describe now.
  check(
    "as a copy, not a reference",
    managed.snapshot().contextUsage !== managed.snapshot().contextUsage,
    true,
  );

  managed.prompt("something else entirely");
  check("and a later prompt does not rename it", managed.title, "Rework the reconnect backoff");

  managed.setMeta({ title: "Mine" });
  await settle();
  managed.prompt("and another");
  check("a manual rename survives every later prompt", managed.title, "Mine");

  managed.setMeta({ title: null });
  await settle();
  managed.prompt("Fresh start here");
  check("clearing re-arms the derivation", managed.title, "Fresh start here");

  check("the agent's commands reach the managed session", managed.agentCommands.commands.map((c) => c.name), [
    "compact",
    "status",
  ]);
  const firstRevision = managed.commandsRevision;
  check("and the revision moved exactly once to announce them", firstRevision, 1);
  check("which is what the snapshot carries", managed.snapshot().commandsRevision, firstRevision);

  // claude republishes identical lists repeatedly while discovering skills, so an identical republish must not bump the revision.
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

  // A stop a message can revive keeps the commands and the revision: the conversation comes back to the same list.
  check("stopping an agent that can come back keeps its commands", managed.agentCommands.commands.length, 3);
  check("and does not move the revision, because nothing changed", managed.commandsRevision, beforeStop);
  check("which a client sees as a list still worth fetching", managed.snapshot().commandsRevision > 0, true);

  // The other side of the gate, a stop nothing can revive, is driven in daemoncheck.restart-and-resume.
}

// A filename is a label: containment comes from the random directory, which is why this sanitizes where `safeRelPath` refuses.

process.stdout.write("\nwhat a filename becomes\n");
{
  const named = (input: string): string =>
    sanitizeUploadName(input).ok ? (sanitizeUploadName(input) as { name: string }).name : `!${(sanitizeUploadName(input) as { reason: string }).reason}`;

  // Traversal is a rename, not a refusal: the directory it lands in is already unguessable.
  check("a traversal is reduced to its basename", named("../../etc/passwd"), "passwd");
  check("so is a windows path", named("C:\\Users\\me\\b.png"), "b.png");
  check("and an ordinary one", named("a/b/c.txt"), "c.txt");
  check("a dotfile keeps its dot", named(".gitignore"), ".gitignore");

  // The CR refusal matters: this string is echoed into a `Content-Disposition` header.
  check("a NUL is refused", named("x\u0000y"), "!nul_byte");
  check("a newline is refused", named("a\r\nb"), "!control_char");
  check("and so is a bare dot", named("."), "!reserved");
  check("or two", named(".."), "!reserved");
  check("a name of nothing but controls has nothing left", named("\u0001\u0002"), "!control_char");
  check("and an empty one is empty", named(""), "!empty");

  // Windows drops trailing dots and spaces silently, so such a name would stop matching what was stored.
  check("trailing dots and spaces go", named("name.  "), "name");
  check("a device name is prefixed rather than refused", named("CON.txt"), "_CON.txt");
  check("case-insensitively", named("com1"), "_com1");

  const long = named(`${"x".repeat(400)}.png`);
  check("a long name is shortened to the cap", Buffer.byteLength(long, "utf8") <= 200, true);
  check("and keeps its extension", long.endsWith(".png"), true);
  // No truncation marker in a name: safe only because the response echoes the original.
  check("with no truncation marker", long.includes("truncated"), false);

  // Non-ASCII on purpose: only multi-byte code points tell a byte-wise truncation from a character-wise one.
  check("unicode survives byte for byte", named("αναφορά-📊.pdf"), "αναφορά-📊.pdf");

  // `clipName` can collapse a leading-dot stem to a reserved name, so the reserved check must run on the result.
  check("a clip may not rebuild a reserved name", sanitizeUploadName("..".concat("a".repeat(300))).ok, false);
  check("nor the bare current directory", sanitizeUploadName(".".concat(".", "b".repeat(400))).ok, false);
  check("while an ordinary over-long name still clips", named("z".repeat(400).concat(".png")).endsWith(".png"), true);

  // Accepted on purpose: escaping quotes is the download header's job.
  check("a quote is not this function's problem", named('a"b.txt'), 'a"b.txt');
}

process.stdout.write("\nwhat a download says its filename is\n");
{
  // `safeRelPath` rejects NUL but not CR or LF, and a workspace filename is one an agent chose.
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

  // `removeWorkspace` and the upload sweep each guard their `rmSync` by containment, so the two roots must not nest either way.
  const uploadsRoot = resolveUploadRoot(undefined);
  const worktrees = join(homedir(), ".reemoat", "worktrees");
  check("the two roots do not nest", atOrUnder(uploadsRoot, worktrees), false);
  check("in either direction", atOrUnder(worktrees, uploadsRoot), false);
}

// Unset must keep meaning ~/.reemoat: every daemon not started by the desktop app reads it that way (Q7.148, Q7.149).
process.stdout.write("\nthe root those defaults sit under\n");
{
  check("unset is ~/.reemoat, as it always was", resolveStateRoot(undefined), join(homedir(), ".reemoat"));
  check("and blank is unset", resolveStateRoot("  "), join(homedir(), ".reemoat"));
  check("a tilde expands", resolveStateRoot("~/r"), join(homedir(), "r"));
  const refusal = (spec: string): string => {
    try {
      resolveStateRoot(spec);
      return "(accepted)";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  check("a relative path is refused", refusal("rel").startsWith("REEMOAT_HOME must be an absolute path"), true);
  // The home directory itself is refused: rooted at ~, the undotted defaults would be folders the picker offers as a `cwd`.
  for (const [spelling, spec] of [
    ["~", "~"],
    ["~/", "~/"],
    ["as an absolute path", homedir()],
    ["with a trailing separator", `${homedir()}/`],
    ["with a trailing /.", `${homedir()}/.`],
  ] as const) {
    check(`the home directory itself is refused, spelt ${spelling}`, refusal(spec).startsWith("REEMOAT_HOME may not be"), true);
  }

  check("uploads follow the root", resolveUploadRoot(undefined, "/srv/r"), "/srv/r/uploads");
  check("and so do worktrees", resolveWorktreeRoot(undefined, "/srv/r"), "/srv/r/worktrees");
  check("while an explicit root still wins over it", resolveUploadRoot("/elsewhere/up", "/srv/r"), "/elsewhere/up");
  check("for both of them", resolveWorktreeRoot("/elsewhere/wt", "/srv/r"), "/elsewhere/wt");
  const up = resolveUploadRoot(undefined, "/srv/r");
  const wt = resolveWorktreeRoot(undefined, "/srv/r");
  check("under a custom root the two still do not nest", [atOrUnder(up, wt), atOrUnder(wt, up)], [false, false]);
}

// `Uploads.receive`'s counter is the only bound on a request body; every refusal must also release the body, or the sender parks the tunnel.
// Only the `pulled: 0` cases pin `cancelBody`: mid-body, leaving the loop cancels the stream anyway.

process.stdout.write("\ntaking a file in\n");
{
  // Nested one level inside its own temp directory, so the traversal case asserts about a path this run owns.
  const receiveHome = tmp("reemoat-receive-");
  const root = join(receiveHome, "root");
  mkdirSync(root, { recursive: true });
  const index = memoryUploadIndex();
  const uploads = await Uploads.open({ root, index, onWarning: () => {} });

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
      check("under an id nothing else could name", /^u_[0-9a-f]{16}$/.test(result.row.uploadId), true);
      check("and it can be resolved by that id", uploads.resolve("s_take", [result.row.uploadId]).ok, true);
    }
    check("an id nobody staged resolves to nothing", uploads.resolve("s_take", ["u_nope"]), {
      ok: false,
      missing: "u_nope",
    });
  }

  {
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
    check("with nothing created outside the root", existsSync(join(receiveHome, "escape")), false);
  }

  {
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
    // More chunks than the budget needs, so the refusal happens mid-body; a drained body has nothing to release.
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
    // Drives the real `MAX_UPLOAD_BYTES`; one shared 8 MiB buffer, enqueued repeatedly, keeps the cap off the heap.
    const step = 8 * 1024 * 1024;
    const shared = chunk(step, 3);
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
    check("and the partial file is gone, not merely unreferenced", dirsFor("s_big"), []);
    check("with nothing recorded against the session", index.bytesFor("s_big"), 0);
  }

  await uploads.shutdown();
}

// Driven as the pure decision: reaching `UPLOAD_RATE_BYTES` end-to-end would write 300 MiB per run.

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

  check("spending precisely the budget is already too much", uploadRateVerdict(full, now).waitMs > 0, true);
  check("and the wait is when the oldest spend ages out", uploadRateVerdict(full, now).waitMs, UPLOAD_RATE_WINDOW_MS - 1_000);

  // `at > floor` is strict, so an entry exactly a window old is already out.
  const stale = [{ at: now - UPLOAD_RATE_WINDOW_MS, bytes: UPLOAD_RATE_BYTES * 4 }];
  check("bytes older than the window are not spent at all", uploadRateVerdict(stale, now).waitMs, 0);
  check("and are dropped rather than carried", uploadRateVerdict(stale, now).kept, []);

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

  // ACP requires every agent to support `resource_link`, which is why the paperclip needs no capability gate.
  const linksOnly = await uploads.blocksFor([small, text, unknown], { image: false });
  check("with no image capability, every file is a link", linksOnly.map((b) => b.type), [
    "resource_link",
    "resource_link",
    "resource_link",
  ]);
  check("carrying the stored name", (linksOnly[0] as { name: string }).name, "shot.png");
  check("its size", (linksOnly[0] as { size: number }).size, png.length);
  // `file://`: the agent runs as this user on this machine; an HTTP URL would need a token it does not have.
  check("and a file URL", (linksOnly[0] as { uri: string }).uri.startsWith("file://"), true);

  const withImage = await uploads.blocksFor([small], { image: true });
  check("an image agent gets the link and the bytes", withImage.map((b) => b.type), ["resource_link", "image"]);
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

  // The same decision the recorded `inlined` flag is built from, so the event and the blocks cannot disagree.
  check("and `inlinesImage` agrees with all four", [
    inlinesImage(small.mime, small.bytes, { image: true }),
    inlinesImage(text.mime, text.bytes, { image: true }),
    inlinesImage(unknown.mime, unknown.bytes, { image: true }),
    inlinesImage(huge.mime, huge.bytes, { image: true }),
  ], [true, false, false, false]);
  check("and says no when the agent cannot take one", inlinesImage(small.mime, small.bytes, { image: false }), false);

  const returned = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
  const kept = uploads.keepAgentImage("s_agent", "image/png", returned.toString("base64"));
  // Checked, not asserted with a non-null `!`, so a dropped row fails one check instead of the whole driver.
  check("an agent image gets a row", kept !== null, true);
  if (kept) {
    check("carrying the bytes it was handed", kept.bytes, returned.length);
    check("named from its declared type", kept.name.endsWith(".png"), true);
    // Two halves: an optional-chained `consumedAt` comparison is true when the index returns nothing.
    const indexed = index.get("s_agent", kept.uploadId);
    check("the index really holds it", indexed !== null, true);
    check("and is consumed immediately, so no TTL reaches it", indexed !== null && indexed.consumedAt !== null, true);
    // The write is deferred: the caller is the emit path, which never awaits.
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("the bytes land on disk shortly after", existsSync(join(uploadRoot, "s_agent", kept.uploadId, kept.name)), true);
    check("and round-trip", readFileSync(join(uploadRoot, "s_agent", kept.uploadId, kept.name)).equals(returned), true);
  }
  check("an unusable session id is refused", uploads.keepAgentImage("../escape", "image/png", returned.toString("base64")), null);
  check("and so is an empty payload", uploads.keepAgentImage("s_agent", "image/png", ""), null);

  const sentinel = join(uploadRoot, "..", "sentinel-must-survive");
  writeFileSync(sentinel, "keep", "utf8");
  await uploads.forgetSession("../escape");
  check("an unusable session id removes nothing outside the root", existsSync(sentinel), true);

  await uploads.forgetSession("s_one");
  check("forgetting a session takes its directory", existsSync(join(uploadRoot, "s_one")), false);
  check("and its rows", index.countFor("s_one"), 0);
  await uploads.shutdown();
}

process.stdout.write("\nwhat an attachment costs an event\n");
{
  const refs = Array.from({ length: 10 }, (_, i) => ({
    uploadId: `u_${"x".repeat(60)}${i}`,
    name: "n".repeat(200),
    mime: "m".repeat(128),
    bytes: 1234,
    inlined: false,
  }));
  const bare = { type: "prompt", text: "hi", attachments: null, from: null } as const;
  const laden = { type: "prompt" as const, text: "hi", attachments: refs, from: null };

  check("an attachment is accounted rather than ignored", estimateBytes(laden) > estimateBytes(bare), true);
  check("and ten maximal ones stay far under the per-event cap", estimateBytes(laden) < 128 * 1024, true);

  const long = { type: "prompt" as const, text: "y".repeat(200 * 1024), attachments: refs, from: null };
  const cut = truncateEvent(long, 128 * 1024) as typeof long;
  // Untouched: a clipped attachment is a reference to a file that cannot be found.
  check("every attachment survives truncation byte for byte", cut.attachments, refs);
  check("the text is what gets clipped", cut.text.length < long.text.length, true);
  // Clipping the text to the full budget leaves the attachments pushing the event back over the cap.
  check("and the result really is under the cap", estimateBytes(cut) <= 128 * 1024, true);
}

process.stdout.write("\nserving one file out of a session\n");
{
  const raw = async (path: string): Promise<Response> =>
    app.fetch(new Request(`http://d${path}`, { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }));

  // The positive control: a 404 alone stays green for a route that 404s for everybody.
  check("an unknown id is 404 here too", (await raw("/sessions/s_nope/files?path=notes.txt")).status, 404);

  const ok = await raw("/sessions/s_one/files?path=notes.txt");
  check("a real file is served", ok.status, 200);
  check("and its bytes are its bytes", await ok.text(), "hi\n");
  // These headers are the route's security: it serves any workspace file, and rendered HTML or SVG would run on the daemon's origin.
  check("never a type a browser will render", ok.headers.get("content-type"), "application/octet-stream");
  check("always a save", ok.headers.get("content-disposition")?.startsWith("attachment;"), true);
  // Not redundant beside `attachment`: it stops a proxy or CDN re-typing the body into something renderable.
  check("nothing may re-sniff it", ok.headers.get("x-content-type-options"), "nosniff");
  check("and nothing may cache it", ok.headers.get("cache-control"), "no-store");

  // Never gzipped: the client's size guard reads `content-length`, which compression would falsify.
  // Excluded by content type through `compressible`; 40 KiB so the file clears the compression threshold.
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

  // Each `reason` is one of `safeRelPath`'s own rejections, which proves the route uses it.
  check("a path is required", (await raw("/sessions/s_one/files")).status, 400);
  check("climbing out is refused", await refusal("/sessions/s_one/files?path=../../etc/passwd"), "400 dot_segment");
  check("an absolute path is refused", await refusal("/sessions/s_one/files?path=/etc/passwd"), "400 absolute");
  // Serving `.git/config` would leak remote URLs and the credential helper.
  check("and so is the git directory", await refusal("/sessions/s_one/files?path=.git/config"), "400 git_dir");

  const root = join(users, "u_alice", "proj");
  mkdirSync(join(root, "sub"), { recursive: true });
  symlinkSync("/etc/passwd", join(root, "escape.txt"));
  // Refused by shape, never by where it points.
  check("a symlink is not a regular file", await refusal("/sessions/s_one/files?path=escape.txt"), "404 not_a_regular_file");
  check("nor is a directory", await refusal("/sessions/s_one/files?path=sub"), "404 not_a_regular_file");
  check("nor is something that is not there", await refusal("/sessions/s_one/files?path=absent.txt"), "404 not_a_regular_file");

  // The string rules stay synchronous and the filesystem question is `probeContained`, bounded, so a stalled mount under a cwd cannot hang the daemon.
  symlinkSync(uAbcd, join(root, "out"));
  // The security property: a `requestedPath` that did not await `probeContained` would serve a file outside the workspace.
  check("a symlinked parent still cannot leave the tree", await refusal("/sessions/s_one/files?path=out/notes.txt"), "400 escapes_tree");
  check("while the string rules alone accept it, having stopped asking the disk", safeRelPath(root, "out/notes.txt").ok, true);
  check(
    "and still refuse everything that is genuinely about the string",
    ["../x", "/x", ".git/x", "a\u0000b", "a\\b", ""].map((input) => safeRelPath(root, input).ok),
    [false, false, false, false, false, false],
  );

  // Could-not-tell is a real third answer; the parent is resolved, not the leaf, and a path that is not there is contained.
  forgetStalled();
  const under = (rel: string): string => join(root, rel);
  check("a path inside the tree is contained", await probeContained(root, under("notes.txt")), true);
  check("one whose parent resolves out of it is not", await probeContained(root, under("out/notes.txt")), false);
  check("one that is simply not there is, because that is not a traversal", await probeContained(root, under("nowhere/x.txt")), true);
  // Forced with a passed deadline; the route's 503 path_unresponsive arm is not reachable offline.
  check("and a deadline that has passed is neither", await probeContained(root, under("notes.txt"), { probeTimeoutMs: 0 }), null);
  forgetStalled();

  // A `.git` reached through a symlink is refused on the resolved path; the syntactic check alone let it through.
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

  // Text is required only when nothing came with it; both refusals are asserted because relaxing one relaxes the other.
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
  check("an empty prompt with no files is refused", await prompted({ text: "   " }), "400 bad_request");
  check("and a missing text is still a type error", await prompted({ attachments: [] }), "400 bad_request");
  // A 503 proves the text check no longer fires; a 400 would not tell the two apart.
  check("but an empty prompt carrying a file gets past it", await prompted({ text: "", attachments: ["u_x"] }), "503 uploads_unavailable");

  // This driver builds the app with no upload store, so those routes answer 503.
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
