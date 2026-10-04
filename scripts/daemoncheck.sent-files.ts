import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore, type SessionEvent } from "../src/events.js";
import { PeerHub } from "../src/peers/hub.js";
import { PeerMcpEndpoint } from "../src/peers/mcp.js";
import {
  MAX_SEND_FILE_PATH_BYTES,
  SEND_FILE_TOOL_NAME,
  sendFileRefusal,
  sendFileSource,
  sentFileText,
} from "../src/peers/files.js";
import { ASK_TOOL_NAME } from "../src/peers/ask.js";
import { SessionRegistry, type ManagedSession } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { MAX_DOWNLOAD_BYTES } from "../src/server.js";
import {
  isAgentImage,
  isSentFile,
  MAX_SENT_FILE_BYTES,
  MAX_SENT_FILES_PER_SESSION,
  sentFileName,
  Uploads,
} from "../src/uploads.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { memoryUploadIndex, stubAgentConfig } from "./daemoncheck.fixtures.js";

// Q3.690 left it unbuilt: a file reached its person only if a tool happened to touch it inside the workspace (Q2.252).
process.stdout.write("\nsend_file: a file an agent hands its person on purpose\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04, 0x05]);

  process.stdout.write("  the path, the name and the words\n");
  check(
    "a path is absolute, from the home directory, or from the agent's working folder",
    [sendFileSource({ path: "/tmp/a.txt" }, "/w"), sendFileSource({ path: "~/a.txt" }, "/w"), sendFileSource({ path: "out/a.txt" }, "/w")],
    [{ path: "/tmp/a.txt" }, { path: join(homedir(), "a.txt") }, { path: "/w/out/a.txt" }],
  );
  check(
    "and anything else is refused in words, before the filesystem is asked",
    [
      sendFileSource({}, "/w"),
      sendFileSource({ path: "  " }, "/w"),
      sendFileSource({ path: 7 }, "/w"),
      sendFileSource({ path: "a\0b" }, "/w"),
      sendFileSource({ path: "x".repeat(MAX_SEND_FILE_PATH_BYTES + 1) }, "/w"),
    ],
    [
      "path must be the file to send",
      "path must be the file to send",
      "path must be the file to send",
      "path may not hold a NUL byte",
      `path may be at most ${MAX_SEND_FILE_PATH_BYTES} bytes`,
    ],
  );
  // The agent chooses this name, which no upload's ever was: a reversed extension reads as another type in a save panel.
  check(
    "a name loses what could disguise it or end a header, and is never refused",
    [
      sentFileName("/a/b/report.pdf"),
      sentFileName("/a/evil‮fdp.exe"),
      sentFileName("/a/zero​width﻿.txt"),
      sentFileName("/a/line\r\nbreak.txt"),
      sentFileName("/a/‮"),
      sentFileName("/a/b/"),
    ],
    ["report.pdf", "evilfdp.exe", "zerowidth.txt", "linebreak.txt", "file", "b"],
  );
  // A cut through a surrogate pair kept half an emoji: SQLite stored U+FFFD for it, the transcript the half (review of Q2.252).
  check(
    "a long name is cut between characters, never inside one, and half a pair the agent sent is dropped",
    [sentFileName(`/a/${"x".repeat(193)}😀.txt`), sentFileName("/a/odd\ud800.txt"), sentFileName("/a/ok😀.txt")],
    [`${"x".repeat(193)}.txt`, "odd.txt", "ok😀.txt"],
  );
  check(
    "every refusal is a sentence that says nothing was sent or why",
    [
      sendFileRefusal({ kind: "missing" }, "/w/a.txt"),
      sendFileRefusal({ kind: "denied" }, "/w/locked/a.txt"),
      sendFileRefusal({ kind: "not_a_file" }, "/w/dir"),
      sendFileRefusal({ kind: "process_file" }, "/proc/42/environ"),
      sendFileRefusal({ kind: "too_large", limit: MAX_SENT_FILE_BYTES }, "/w/big.bin"),
      sendFileRefusal({ kind: "rate", retryAfterMs: 1_500 }, "/w/a.txt"),
      sendFileRefusal({ kind: "withdrawn" }, "/w/a.txt"),
    ],
    [
      "there is no file at /w/a.txt",
      "this machine would not let the daemon read /w/locked/a.txt; nothing was sent",
      "/w/dir is not a regular file; to send a folder, archive it and send the archive",
      "/proc/42/environ is a view of a running process, not a file; nothing was sent",
      "/w/big.bin is larger than the 100 MB a sent file may be; nothing was sent",
      "too much has been sent from this session in the last few minutes; try again in 2 seconds",
      "the session stopped before the file was kept; nothing was sent",
    ],
  );
  check(
    "and a sent one is told as the path it was read from, its name and its size",
    sentFileText({ uploadId: "f_1", name: "a.txt", mime: null, bytes: 2_048 }, "/w/sub/a.txt").startsWith(
      "Sent /w/sub/a.txt to your user as a.txt (2.0 KB)",
    ),
    true,
  );
  check(
    "only ASCII whitespace is trimmed off the ends: a no-break space can be part of a real name",
    [sendFileSource({ path: " a.txt\n" }, "/w"), sendFileSource({ path: "\u00a0a.txt" }, "/w")],
    [{ path: "/w/a.txt" }, { path: "/w/\u00a0a.txt" }],
  );
  check("a sent file is never larger than the download route will serve", MAX_SENT_FILE_BYTES <= MAX_DOWNLOAD_BYTES, true);

  process.stdout.write("  keeping the copy\n");
  const home = tmp("reemoat-sent-");
  const root = join(home, "root");
  const work = join(home, "work");
  mkdirSync(root, { recursive: true });
  mkdirSync(work, { recursive: true });
  const index = memoryUploadIndex();
  const uploads = await Uploads.open({ root, index, onWarning: () => {} });
  const dirsFor = (sessionId: string): string[] => (existsSync(join(root, sessionId)) ? readdirSync(join(root, sessionId)) : []);

  writeFileSync(join(work, "notes.txt"), "hello");
  const kept = await uploads.keepAgentFile("s_keep", join(work, "notes.txt"));
  check("a file is kept under an id of its own kind", kept.kind === "ok" ? [kept.row.uploadId.startsWith("f_"), kept.row.name, kept.row.bytes, kept.row.mime] : kept.kind, [
    true,
    "notes.txt",
    5,
    null,
  ]);
  if (kept.kind === "ok") {
    check("as the bytes it held when it was sent", readFileSync(uploads.pathFor(kept.row), "utf8"), "hello");
    writeFileSync(join(work, "notes.txt"), "changed since");
    check("which a later change to the original does not reach", readFileSync(uploads.pathFor(kept.row), "utf8"), "hello");
    // Two halves: an optional-chained comparison is true when the index returns nothing.
    const indexed = index.get("s_keep", kept.row.uploadId);
    check("the index really holds it", indexed !== null, true);
    check("already sent, so no sweep takes it for a stale draft", indexed !== null && indexed.consumedAt !== null, true);
    check("and it is neither a person's file nor an agent's image", [isSentFile(kept.row), isAgentImage(kept.row)], [true, false]);
  }
  writeFileSync(join(work, "shot.bin"), PNG);
  const shot = await uploads.keepAgentFile("s_keep", join(work, "shot.bin"));
  check("an image is known by its first bytes, whatever it is called", shot.kind === "ok" ? shot.row.mime : shot.kind, "image/png");
  writeFileSync(join(work, "empty"), "");
  const empty = await uploads.keepAgentFile("s_keep", join(work, "empty"));
  check("an empty file is a file", empty.kind === "ok" ? empty.row.bytes : empty.kind, 0);
  symlinkSync(join(work, "notes.txt"), join(work, "link.txt"));
  const linked = await uploads.keepAgentFile("s_keep", join(work, "link.txt"));
  check(
    "a link is followed, as the agent's own read would be, and keeps the name it was sent under",
    linked.kind === "ok" ? [linked.row.name, readFileSync(uploads.pathFor(linked.row), "utf8")] : linked.kind,
    ["link.txt", "changed since"],
  );

  const before = dirsFor("s_refuse").length;
  mkdirSync(join(work, "folder"));
  execFileSync("mkfifo", [join(work, "pipe")]);
  truncateSync(join(work, "notes.txt"), 5);
  writeFileSync(join(work, "huge.bin"), "");
  truncateSync(join(work, "huge.bin"), MAX_SENT_FILE_BYTES + 1);
  const gone = new AbortController();
  gone.abort();
  check(
    "a missing path, a folder, a pipe, an oversized file and a call already given up on are each refused by name",
    [
      (await uploads.keepAgentFile("s_refuse", join(work, "nope"))).kind,
      (await uploads.keepAgentFile("s_refuse", join(work, "folder"))).kind,
      (await uploads.keepAgentFile("s_refuse", join(work, "pipe"))).kind,
      (await uploads.keepAgentFile("s_refuse", join(work, "huge.bin"))).kind,
      (await uploads.keepAgentFile("s_refuse", join(work, "notes.txt"), { signal: gone.signal })).kind,
      (await uploads.keepAgentFile("../escape", join(work, "notes.txt"))).kind,
    ],
    ["missing", "not_a_file", "not_a_file", "too_large", "cancelled", "failed"],
  );
  check("and a refusal leaves nothing on disk and no row", [dirsFor("s_refuse").length, index.listFor("s_refuse").length], [before, 0]);

  // Given up on once its directory exists, which is past every probe: the copy itself is what is cut, and has something to remove.
  writeFileSync(join(work, "slow.bin"), "");
  truncateSync(join(work, "slow.bin"), 96 * 1024 * 1024);
  const leaving = new AbortController();
  const cut = uploads.keepAgentFile("s_cut", join(work, "slow.bin"), { signal: leaving.signal });
  let begun = false;
  for (let waited = 0; waited < 2_000 && !begun; waited += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    begun = dirsFor("s_cut").length > 0;
  }
  leaving.abort();
  check("a call given up on once its copy has begun is cancelled", [begun, (await cut).kind], [true, "cancelled"]);
  check("and what it had written is removed", [dirsFor("s_cut").length, index.listFor("s_cut").length], [0, 0]);
  const early = new AbortController();
  const probing = uploads.keepAgentFile("s_cut", join(work, "slow.bin"), { signal: early.signal });
  early.abort();
  const stopwatch = Date.now();
  check("one given up on while the path is still being probed copies nothing at all", [(await probing).kind, dirsFor("s_cut").length], ["cancelled", 0]);
  process.stdout.write(`        answered ${Date.now() - stopwatch} ms after the abort\n`);
  check("and a call whose time ran out behind another is refused before it reads a byte", (await uploads.keepAgentFile("s_cut", join(work, "notes.txt"), { deadlineMs: 0 })).kind, "timed_out");

  // The large one first: unqueued, the small one would finish while the large is still copying.
  const order: string[] = [];
  writeFileSync(join(work, "small.txt"), "small");
  const both = await Promise.all(
    ["slow.bin", "small.txt"].map(async (name) => {
      const result = await uploads.keepAgentFile("s_queue", join(work, name));
      order.push(name);
      return result.kind;
    }),
  );
  check("two calls from one session run one after the other, in the order they came", [both, order], [["ok", "ok"], ["slow.bin", "small.txt"]]);

  // The wait in line is the call's own: given up on there, it answered only once the copy ahead had finished (review of Q2.252).
  const line: string[] = [];
  const ahead = uploads.keepAgentFile("s_line", join(work, "slow.bin")).then((result) => {
    line.push("ahead");
    return result.kind;
  });
  const leaver = new AbortController();
  const behind = uploads.keepAgentFile("s_line", join(work, "small.txt"), { signal: leaver.signal }).then((result) => {
    line.push("behind");
    return result.kind;
  });
  const after = uploads.keepAgentFile("s_line", join(work, "small.txt")).then((result) => {
    line.push("after");
    return result.kind;
  });
  await new Promise((resolve) => setImmediate(resolve));
  leaver.abort();
  check(
    "a call given up on while it waits in line is answered at once, and the one behind it still waits for the copy ahead",
    [await Promise.all([ahead, behind, after]), line],
    [["ok", "cancelled", "ok"], ["behind", "ahead", "after"]],
  );

  // The last in line giving up emptied the queue while the copy ahead still ran, so the next call started beside it.
  const tailLine: string[] = [];
  const first = uploads.keepAgentFile("s_tail", join(work, "slow.bin")).then((result) => {
    tailLine.push("first");
    return result.kind;
  });
  const quitter = new AbortController();
  const quit = uploads.keepAgentFile("s_tail", join(work, "small.txt"), { signal: quitter.signal });
  await new Promise((resolve) => setImmediate(resolve));
  quitter.abort();
  const quitKind = (await quit).kind;
  const later = uploads.keepAgentFile("s_tail", join(work, "small.txt")).then((result) => {
    tailLine.push("later");
    return result.kind;
  });
  check(
    "a call arriving after the last one in line gave up still waits for the copy ahead",
    [quitKind, await Promise.all([first, later]), tailLine],
    ["cancelled", ["ok", "ok"], ["first", "later"]],
  );

  // EACCES under a closed folder came back as "there is no file" (review of Q2.252).
  const locked = join(work, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "secret.txt"), "x");
  chmodSync(locked, 0o000);
  const shut = (await uploads.keepAgentFile("s_refuse", join(locked, "secret.txt"))).kind;
  chmodSync(locked, 0o700);
  check("a file behind a folder this machine will not open is refused as that, never as missing", shut, process.getuid?.() === 0 ? "ok" : "denied");
  if (process.platform === "linux") {
    // A thread's directory is reachable by name though never listed, and its environ is the daemon's (review of Q2.253).
    const thread = readdirSync(`/proc/${process.pid}/task`).find((tid) => tid !== String(process.pid)) ?? String(process.pid);
    check(
      "and no process view is a file of the agent's: the daemon's own, a thread's, its parent's",
      await Promise.all(
        ["/proc/self/environ", `/proc/${thread}/environ`, `/proc/${process.ppid}/environ`].map(
          async (path) => (await uploads.keepAgentFile("s_refuse", path)).kind,
        ),
      ),
      ["process_file", "process_file", "process_file"],
    );
  }

  // Three budgets, none of which can be spent by another: a person's files, an agent's images, and what it sent.
  const stamp = Date.now() - 10_000;
  for (let n = 0; n < MAX_SENT_FILES_PER_SESSION; n += 1) {
    const id = `f_old${String(n).padStart(3, "0")}`;
    index.insert({ sessionId: "s_roll", uploadId: id, name: "old.txt", origName: "old.txt", mime: null, bytes: 1, createdAt: stamp + n, consumedAt: stamp + n });
    mkdirSync(join(root, "s_roll", id), { recursive: true });
  }
  index.insert({ sessionId: "s_roll", uploadId: "u_mine", name: "mine.txt", origName: "mine.txt", mime: null, bytes: 1, createdAt: stamp - 2, consumedAt: stamp - 2 });
  index.insert({ sessionId: "s_roll", uploadId: "a_shot", name: "shot.png", origName: "shot.png", mime: "image/png", bytes: 1, createdAt: stamp - 1, consumedAt: stamp - 1 });
  const rolled = await uploads.keepAgentFile("s_roll", join(work, "notes.txt"));
  check("past its budget the newest sent file is still kept", rolled.kind, "ok");
  check("by dropping the oldest it sent, row and directory", [index.get("s_roll", "f_old000"), existsSync(join(root, "s_roll", "f_old000"))], [null, false]);
  check(
    "never a file somebody sent it, nor one of its own images, though both are older",
    [index.get("s_roll", "u_mine") !== null, index.get("s_roll", "a_shot") !== null],
    [true, true],
  );
  check("so what it sent stays at the budget", index.listFor("s_roll").filter(isSentFile).length, MAX_SENT_FILES_PER_SESSION);
  // Asked in the insert's own synchronous block, after the insert and before the eviction (review of Q2.252).
  const full = index.listFor("s_roll").filter(isSentFile).map((row) => row.uploadId);
  const rollDirs = dirsFor("s_roll").length;
  const unwanted = await uploads.keepAgentFile("s_roll", join(work, "notes.txt"), { kept: () => false });
  check("a copy its caller no longer wants is withdrawn", unwanted.kind, "withdrawn");
  check(
    "and at the budget it drops nothing to make room for the file it did not keep, nor leaves its directory",
    [index.listFor("s_roll").filter(isSentFile).map((row) => row.uploadId), dirsFor("s_roll").length],
    [full, rollDirs],
  );
  let seen: [boolean, number] | null = null;
  const wanted = await uploads.keepAgentFile("s_roll", join(work, "notes.txt"), {
    kept: (row) => {
      seen = [index.get("s_roll", row.uploadId) !== null, index.listFor("s_roll").filter(isSentFile).length];
      return true;
    },
  });
  check(
    "what the caller records names a row that exists, with nothing evicted yet",
    [wanted.kind, seen],
    ["ok", [true, MAX_SENT_FILES_PER_SESSION + 1]],
  );
  const mine = await uploads.receive("s_roll", {
    name: "next.txt",
    origName: "next.txt",
    mime: "text/plain",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.close();
      },
    }),
  });
  check(
    "and a person's upload counts only a person's files: a hundred sent ones neither fill their budget nor are dropped for it",
    [mine.kind === "ok" ? mine.sessionCount : mine.kind, index.listFor("s_roll").filter(isSentFile).length],
    [2, MAX_SENT_FILES_PER_SESSION],
  );

  process.stdout.write("  the tool, and who is offered it\n");
  interface Agent {
    mcpServers: any[];
    meta: any;
    readonly permissionAnswers: unknown[];
    readonly toolResults: { text: string; isError: boolean }[];
  }
  const agents = new Map<string, Agent>();
  let launched = 0;

  /** What each measured harness puts on the call it announces before an MCP call (Q6.114). */
  const announce = (agent: string, path: string): Record<string, unknown> => {
    switch (agent) {
      case "cursor":
        return { rawInput: { providerIdentifier: "reemoat", toolName: SEND_FILE_TOOL_NAME, args: { path } } };
      case "codex":
        return { rawInput: { server: "reemoat", tool: SEND_FILE_TOOL_NAME, arguments: { path } } };
      case "claude":
        return { rawInput: { path }, _meta: { claudeCode: { toolName: `mcp__reemoat__${SEND_FILE_TOOL_NAME}` } } };
      // grok's use_tool, whose arguments the model types; a path starting `extra` adds a key no use_tool call carries.
      case "grok":
        return { rawInput: { tool_name: `reemoat__${SEND_FILE_TOOL_NAME}`, tool_input: { path }, ...(path.startsWith("extra") ? { command: "x" } : {}) } };
      default:
        return { rawInput: { path } };
    }
  };

  const spawn = (agent: string, http: boolean): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);
    let current: Agent | null = null;
    let sessionId = "";
    let outbound = 1000;
    let calls = 0;
    const awaiting = new Map<number, (result: unknown) => void>();
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        if (message["method"] === undefined && typeof id === "number") {
          awaiting.get(id)?.(message["result"] ?? message["error"]);
          awaiting.delete(id);
          continue;
        }
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: http ? { http: true } : {} },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new:
          case acp.methods.agent.session.resume: {
            sessionId = message["params"]?.["sessionId"] ?? `c_file_${++launched}`;
            const state: Agent = agents.get(sessionId) ?? { mcpServers: [], meta: null, permissionAnswers: [], toolResults: [] };
            state.mcpServers = message["params"]?.["mcpServers"] ?? [];
            state.meta = message["params"]?.["_meta"] ?? null;
            agents.set(sessionId, state);
            current = state;
            send({ jsonrpc: "2.0", id, result: { sessionId } });
            break;
          }
          case acp.methods.agent.session.prompt: {
            const text = (message["params"]?.["prompt"] ?? [])
              .filter((block: any) => block?.type === "text")
              .map((block: any) => block.text)
              .join("");
            // `SEND <path>` calls send_file as this harness would; `ASKSEND` asks permission first, as cursor and grok do;
            // `ALWAYS` offers no allow-once; `BARE` is grok's request without the tag it adds; `FAKE` wears cursor's shape;
            // `TYPED` is grok's tag typed by the model into the announcement, with a bare request after it; `LATE` asks only once
            // the call has completed; `TWICE` announces two calls on one path before running either; `GHOST` never runs its call.
            const sends = /^(SEND|ASKSEND|ALWAYS|BARE|FAKE|TYPED|LATE|TWICE|GHOST) (.+)$/.exec(text);
            if (sends === null) {
              send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
              break;
            }
            const path = sends[2]!;
            const callId = `call-file-${++calls}`;
            const caller = current;
            const update = (payload: Record<string, unknown>) =>
              send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } });
            const shaped = announce(sends[1] === "FAKE" ? "cursor" : agent, path);
            const announced =
              sends[1] === "TYPED" ? { ...shaped, rawInput: { ...(shaped["rawInput"] as Record<string, unknown>), variant: "UseTool" } } : shaped;
            update({ sessionUpdate: "tool_call", toolCallId: callId, title: "send_file", kind: "other", status: "pending", ...announced });
            if (sends[1] === "GHOST") {
              send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
              break;
            }
            const finish = () => {
              update({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed" });
              send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            };
            const mcpCall = (): Promise<void> => {
              const server = caller?.mcpServers[0];
              if (server === undefined) return Promise.resolve();
              return fetch(server.url, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...Object.fromEntries(server.headers.map((h: any) => [h.name.toLowerCase(), h.value])),
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: SEND_FILE_TOOL_NAME, arguments: { path } } }),
              })
                .then((response) => response.json())
                .then((reply: any) => {
                  caller?.toolResults.push({ text: reply?.result?.content?.[0]?.text ?? "", isError: reply?.result?.isError === true });
                });
            };
            const call = (): void => void mcpCall().finally(finish);
            if (sends[1] === "SEND") {
              call();
              break;
            }
            if (sends[1] === "TWICE") {
              const second = `call-file-${++calls}`;
              update({ sessionUpdate: "tool_call", toolCallId: second, title: "send_file", kind: "other", status: "pending", ...announced });
              void mcpCall()
                .then(() => update({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed" }))
                .then(mcpCall)
                .then(() => update({ sessionUpdate: "tool_call_update", toolCallId: second, status: "completed" }))
                .finally(() => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
              break;
            }
            if (sends[1] === "LATE") update({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed" });
            const ask = ++outbound;
            awaiting.set(ask, (result) => {
              caller?.permissionAnswers.push(result);
              if ((result as any)?.outcome?.outcome === "selected") call();
              else finish();
            });
            send({
              jsonrpc: "2.0",
              id: ask,
              method: "session/request_permission",
              params: {
                sessionId,
                toolCall: {
                  toolCallId: callId,
                  title: "reemoat: send_file",
                  kind: "other",
                  status: "pending",
                  // grok repeats use_tool's arguments on the request, tagged with the variant it parsed them as (measured, 1.0.40).
                  ...(agent === "grok" && sends[1] !== "BARE" && sends[1] !== "TYPED"
                    ? { rawInput: { variant: "UseTool", ...(shaped["rawInput"] as Record<string, unknown>) } }
                    : {}),
                },
                options:
                  sends[1] === "ALWAYS"
                    ? [
                        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
                        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
                      ]
                    : [
                        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
                        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
                      ],
              },
            });
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
    };
  };

  const HARNESSES = ["claude", "cursor", "codex", "grok", "opencode", "kimi"] as const;
  class FileRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return HARNESSES.map((id) => ({
        id,
        displayName: id,
        available: true,
        installable: false,
        loggedIn: true,
        hint: null,
        lastStartRefusal: null,
      }));
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    // kimi stands in for a harness that declares no http MCP client.
    override async launch(agent: AgentId): Promise<AgentProcess> {
      return spawn(agent, agent !== "kimi");
    }
  }

  const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /** Waits for what a prompt sets in motion rather than for a fixed time, so a slow machine fails on the assertion, not before it. */
  const until = async (done: () => boolean, ms = 5_000): Promise<void> => {
    for (const started = Date.now(); !done() && Date.now() - started < ms; ) await settle(10);
  };
  /** One prompt to the stub, awaited until it has either sent its call's result back or parked a permission. */
  const drive = async (managed: ManagedSession, text: string): Promise<void> => {
    const results = agentOf(managed).toolResults.length;
    const parked = managed.snapshot().pendingPermissions.length;
    managed.prompt(text);
    await until(() => agentOf(managed).toolResults.length > results || managed.snapshot().pendingPermissions.length > parked);
    await settle(20);
  };
  const agentOf = (managed: ManagedSession): Agent => agents.get(managed.agentSessionId ?? "")!;
  const eventsOf = (managed: ManagedSession): SessionEvent[] => managed.log.read(0, 10_000, 1 << 24).map((stored) => stored.event);
  const sentOf = (managed: ManagedSession) => eventsOf(managed).filter((event) => event.type === "file_sent");
  const kindsOf = (managed: ManagedSession): string[] =>
    eventsOf(managed)
      .filter((event) => event.type === "tool_call" || event.type === "file_sent" || event.type === "tool_call_update")
      .map((event) => event.type);

  const open = async (enabled: boolean, withStore = true) => {
    const registry = new SessionRegistry(new MemoryEventStore(), null, undefined, new FileRuntime(), withStore ? uploads : null);
    const hub = new PeerHub({ registry, enabled });
    const endpoint = await PeerMcpEndpoint.listen(hub);
    hub.setEndpoint(endpoint.url);
    registry.setPeerMcpServers((id, caps) => hub.mcpServersFor(id, caps));
    let rpcId = 0;
    const rpc = async (managed: ManagedSession, method: string, params: unknown = {}) => {
      const authorization = agentOf(managed).mcpServers[0]?.headers?.find((h: any) => h.name === "Authorization")?.value ?? "";
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      return (await response.json()) as any;
    };
    const names = async (managed: ManagedSession): Promise<string[]> =>
      ((await rpc(managed, "tools/list")).result?.tools ?? []).map((tool: any) => tool.name);
    return { registry, hub, endpoint, rpc, names };
  };

  const on = await open(true);
  const cla = await on.registry.create({ agent: "claude", cwd: tmp("file-claude-"), nickname: "file-claude" });
  const cur = await on.registry.create({ agent: "cursor", cwd: tmp("file-cursor-"), nickname: "file-cursor" });
  const cdx = await on.registry.create({ agent: "codex", cwd: tmp("file-codex-"), nickname: "file-codex" });
  const grk = await on.registry.create({ agent: "grok", cwd: tmp("file-grok-"), nickname: "file-grok" });
  const opc = await on.registry.create({ agent: "opencode", cwd: tmp("file-opencode-"), nickname: "file-opencode" });
  const kim = await on.registry.create({ agent: "kimi", cwd: tmp("file-kimi-"), nickname: "file-kimi" });
  check("a claude session is served it after the messaging tools", await on.names(cla), ["list_agents", "send_message", SEND_FILE_TOOL_NAME]);
  check("and a cursor session after its question tool", await on.names(cur), ["list_agents", "send_message", ASK_TOOL_NAME, SEND_FILE_TOOL_NAME]);
  const listed = ((await on.rpc(cla, "tools/list")).result?.tools ?? []).find((tool: any) => tool.name === SEND_FILE_TOOL_NAME);
  check(
    "loaded at once, or claude defers it behind its tool search, and asking for one path",
    [listed?._meta?.["anthropic/alwaysLoad"], listed?.inputSchema?.required],
    [true, ["path"]],
  );
  check(
    "and the server's instructions say what it is for",
    /send_file puts a file from this machine in front of your user/.test((await on.rpc(cla, "initialize", {})).result?.instructions ?? ""),
    true,
  );
  check("an agent with no http MCP client is handed no server, so no tool", agentOf(kim).mcpServers, []);

  const off = await open(false);
  const claOff = await off.registry.create({ agent: "claude", cwd: tmp("file-off-"), nickname: "file-off" });
  check("with messaging off a claude session still gets the server", agentOf(claOff).mcpServers.map((server) => server.name), ["reemoat"]);
  check(
    "holding send_file alone, with instructions that say nothing of messaging",
    [await off.names(claOff), /list_agents/.test((await off.rpc(claOff, "initialize", {})).result?.instructions ?? "")],
    [[SEND_FILE_TOOL_NAME], false],
  );
  writeFileSync(join(claOff.cwd, "quiet.txt"), "q");
  const quiet = (await off.rpc(claOff, "tools/call", { name: SEND_FILE_TOOL_NAME, arguments: { path: "quiet.txt" } })).result;
  check("no messaging switch refuses a file to the session's own person", [quiet?.isError ?? false, sentOf(claOff).length], [false, 1]);
  const stillOff = (await off.rpc(claOff, "tools/call", { name: "send_message", arguments: { to: "x", message: "y" } })).result;
  check("while a message is still refused, in words", [stillOff?.isError, stillOff?.structuredContent?.code], [true, "messaging_off"]);
  await off.registry.shutdown();
  await off.endpoint.close();

  const bare = await open(false, false);
  const claBare = await bare.registry.create({ agent: "claude", cwd: tmp("file-bare-"), nickname: "file-bare" });
  check("a daemon with nowhere to keep a copy offers nothing with messaging off", agentOf(claBare).mcpServers, []);
  await bare.registry.shutdown();
  await bare.endpoint.close();

  process.stdout.write("  sending one\n");
  writeFileSync(join(cla.cwd, "report.txt"), "the report");
  const sent = (await on.rpc(cla, "tools/call", { name: SEND_FILE_TOOL_NAME, arguments: { path: "report.txt" } })).result;
  check(
    "a path relative to the working folder is sent, and the call says which file it read",
    [sent?.isError ?? false, sent?.content?.[0]?.text?.startsWith(`Sent ${join(cla.cwd, "report.txt")} to your user as report.txt (10 bytes)`), sent?.structuredContent],
    [false, true, { status: "sent", name: "report.txt", bytes: 10, path: join(cla.cwd, "report.txt") }],
  );
  const event = sentOf(cla)[0];
  check(
    "the transcript holds one event: a ref and nothing else, since the log outlives the disk",
    event?.type === "file_sent" ? [Object.keys(event.file).sort(), event.file.name, event.file.bytes, event.file.mime, event.toolCallId] : null,
    [["bytes", "mime", "name", "uploadId"], "report.txt", 10, null, null],
  );
  if (event?.type === "file_sent") {
    const row = uploads.find(cla.id, event.file.uploadId);
    check("naming a row the upload route serves", row !== null && readFileSync(uploads.pathFor(row), "utf8"), "the report");
  }
  const outside = join(home, "outside.txt");
  writeFileSync(outside, "elsewhere");
  const far = (await on.rpc(cla, "tools/call", { name: SEND_FILE_TOOL_NAME, arguments: { path: outside } })).result;
  check("a file outside the working folder is sent too: the agent could read it anyway", far?.isError ?? false, false);
  const none = (await on.rpc(cla, "tools/call", { name: SEND_FILE_TOOL_NAME, arguments: { path: "nope.txt" } })).result;
  const wrong = (await on.rpc(cla, "tools/call", { name: SEND_FILE_TOOL_NAME, arguments: {} })).result;
  check(
    "a refusal is a tool error in words, never an HTTP one, and writes nothing",
    [none?.isError, none?.content?.[0]?.text, wrong?.isError, wrong?.content?.[0]?.text, sentOf(cla).length],
    [true, `there is no file at ${join(cla.cwd, "nope.txt")}`, true, "path must be the file to send", 2],
  );

  process.stdout.write("  the call it stands for\n");
  for (const [managed, label] of [[cla, "claude"], [cdx, "codex"], [grk, "grok"]] as const) {
    writeFileSync(join(managed.cwd, "own.txt"), label);
    await drive(managed, "SEND own.txt");
    const mineSent = sentOf(managed).at(-1);
    check(
      `${label} names the tool on the call it announces, so the file carries that call's id`,
      [mineSent?.type === "file_sent" ? mineSent.toolCallId : null, agentOf(managed).toolResults.at(-1)?.isError],
      ["call-file-1", false],
    );
    check(`and the file lands after its own call and before that call completes (${label})`, kindsOf(managed).slice(-3), [
      "tool_call",
      "file_sent",
      "tool_call_update",
    ]);
  }
  writeFileSync(join(opc.cwd, "own.txt"), "opencode");
  await drive(opc, "SEND own.txt");
  const unmeasured = sentOf(opc).at(-1);
  check(
    "a harness whose shape nobody measured still sends, tied to no call",
    [unmeasured?.type === "file_sent" ? unmeasured.toolCallId : "none", agentOf(opc).toolResults.at(-1)?.isError],
    [null, false],
  );
  check("claude's is the one asked to run it without a permission request", agentOf(cla).meta?.claudeCode?.options?.allowedTools, [
    `mcp__reemoat__${SEND_FILE_TOOL_NAME}`,
  ]);
  // Review of Q2.252: the newest call naming the path was claimed, so with two in flight the first file stood for the second call.
  writeFileSync(join(cdx.cwd, "twice.txt"), "twice");
  const beforeTwice = sentOf(cdx).length;
  await drive(cdx, "TWICE twice.txt");
  check(
    "two calls naming one path, announced before either runs, each carry their own id, in the order they came",
    sentOf(cdx)
      .slice(beforeTwice)
      .map((one) => (one.type === "file_sent" ? one.toolCallId : null)),
    ["call-file-2", "call-file-3"],
  );
  await drive(cdx, "GHOST ghost.txt");
  const sessionOf = (managed: ManagedSession) =>
    (managed as unknown as { session: { claimSentFileCall(path: string): string | null } | null }).session;
  check("a call announced and never run is dropped when its turn ends, so no later file takes its id", sessionOf(cdx)?.claimSentFileCall("ghost.txt"), null);

  process.stdout.write("  the permission in front of it\n");
  writeFileSync(join(cur.cwd, "asked.txt"), "cursor");
  await drive(cur, "ASKSEND asked.txt");
  check(
    "cursor's permission for send_file is answered by the daemon, once, and never drawn",
    [agentOf(cur).permissionAnswers.at(-1), cur.snapshot().pendingPermissions.length],
    [{ outcome: { outcome: "selected", optionId: "allow-once" } }, 0],
  );
  const curSent = sentOf(cur).at(-1);
  check("so the file is in the chat, carrying the call's id", curSent?.type === "file_sent" ? curSent.toolCallId : null, "call-file-1");
  check(
    "and the answer is logged as a decision on that same call, which the card then stands for",
    eventsOf(cur)
      .filter((one) => one.type === "permission_request")
      .map((one) => (one.type === "permission_request" ? [one.permissionId, one.toolCallId, one.decision] : null)),
    [[null, "call-file-1", "allow-once"]],
  );
  // Allow always would write `Mcp(reemoat:send_file)` into the person's own cli-config.json (Q6.114).
  await drive(cur, "ALWAYS asked.txt");
  const parked = cur.snapshot().pendingPermissions;
  check("a request offering no allow-once is left to its person rather than allowed for good", parked.map((one) => one.toolCallId), ["call-file-2"]);
  if (parked[0] !== undefined) cur.answerPermission(parked[0].permissionId, { cancel: true });
  await settle();
  writeFileSync(join(grk.cwd, "asked.txt"), "grok");
  await drive(grk, "ASKSEND asked.txt");
  check(
    "grok's is answered the same way, once the request carries the tag grok itself adds",
    [agentOf(grk).permissionAnswers.at(-1), grk.snapshot().pendingPermissions.length],
    [{ outcome: { outcome: "selected", optionId: "allow-once" } }, 0],
  );
  // The model types use_tool's arguments, so a call carrying any other key is some other tool's and asks its person.
  writeFileSync(join(grk.cwd, "extra.txt"), "grok");
  await drive(grk, "ASKSEND extra.txt");
  const disguised = grk.snapshot().pendingPermissions;
  check("but a call that only looks like one, carrying a key use_tool never has, asks its person", disguised.length, 1);
  if (disguised[0] !== undefined) grk.answerPermission(disguised[0].permissionId, { cancel: true });
  await settle();
  // Everything on the announcement is the model's typing; without grok's own tag nothing vouches for it.
  await drive(grk, "BARE asked.txt");
  const unvouched = grk.snapshot().pendingPermissions;
  check("and so does one that names the tool in the model's words alone, with no tag from grok", unvouched.length, 1);
  if (unvouched[0] !== undefined) grk.answerPermission(unvouched[0].permissionId, { cancel: true });
  await settle();
  // Review of Q2.252: the model typed grok's tag into use_tool's arguments, and a bare request on that id was answered yes.
  writeFileSync(join(grk.cwd, "typed.txt"), "grok");
  await drive(grk, "TYPED typed.txt");
  const typed = grk.snapshot().pendingPermissions;
  check("a tag the model typed into the announcement vouches for nothing: only the request's own does", typed.length, 1);
  if (typed[0] !== undefined) grk.answerPermission(typed[0].permissionId, { cancel: true });
  await settle();
  await drive(cur, "LATE asked.txt");
  const lateAsk = cur.snapshot().pendingPermissions;
  check("a permission asked about a call that has already ended is its person's", lateAsk.length, 1);
  if (lateAsk[0] !== undefined) cur.answerPermission(lateAsk[0].permissionId, { cancel: true });
  await settle();
  writeFileSync(join(cla.cwd, "asked.txt"), "claude");
  await drive(cla, "ASKSEND asked.txt");
  const claudeAsks = cla.snapshot().pendingPermissions;
  check("and claude's is too: claude asks for it only past allowedTools, where its person's own rule says ask", claudeAsks.length, 1);
  if (claudeAsks[0] !== undefined) cla.answerPermission(claudeAsks[0].permissionId, { cancel: true });
  await settle();
  writeFileSync(join(opc.cwd, "asked.txt"), "opencode");
  await drive(opc, "ASKSEND asked.txt");
  const unknownAsks = opc.snapshot().pendingPermissions;
  check("and on a harness whose call the daemon cannot recognise, the same request asks its person", unknownAsks.length, 1);
  if (unknownAsks[0] !== undefined) opc.answerPermission(unknownAsks[0].permissionId, { cancel: true });
  await settle();
  // Each shape is read for its own harness alone: on another, the same keys are whatever a model typed.
  for (const [managed, label] of [[opc, "opencode"], [grk, "grok"], [cla, "claude"]] as const) {
    writeFileSync(join(managed.cwd, "asked.txt"), label);
    await drive(managed, "FAKE asked.txt");
    const borrowed = managed.snapshot().pendingPermissions;
    check(`cursor's shape on a ${label} session is nobody's own call, and asks its person`, borrowed.length, 1);
    if (borrowed[0] !== undefined) managed.answerPermission(borrowed[0].permissionId, { cancel: true });
    await settle();
  }

  process.stdout.write("  a session that is going\n");
  // A Stop during the copy kept the row and dropped an older file the transcript still showed (review of Q2.252).
  writeFileSync(join(cdx.cwd, "late.bin"), "");
  truncateSync(join(cdx.cwd, "late.bin"), 64 * 1024 * 1024);
  const rowsBefore = index.listFor(cdx.id).filter(isSentFile).map((row) => row.uploadId);
  const sentBefore = sentOf(cdx).length;
  const dirsBefore = new Set(dirsFor(cdx.id));
  const copying = cdx.sendFile({ path: "late.bin" });
  // Stopped once the copy's own directory exists, which is past every probe and before the commit.
  for (let waited = 0; waited < 2_000 && dirsFor(cdx.id).every((dir) => dirsBefore.has(dir)); waited += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const stopping = cdx.stop();
  const late = await copying;
  await stopping;
  check("a Stop during the copy keeps nothing, and says the session went", late, { ok: false, message: "the session stopped before the file was kept; nothing was sent" });
  check(
    "no row, no event, and every file the transcript already shows is still kept",
    [index.listFor(cdx.id).filter(isSentFile).map((row) => row.uploadId), sentOf(cdx).length],
    [rowsBefore, sentBefore],
  );
  const stopped = await cdx.sendFile({ path: "own.txt" });
  check("a stopped session sends nothing", stopped, { ok: false, message: "this session is not running" });

  await on.registry.shutdown();
  await on.endpoint.close();
  await uploads.shutdown();
}
