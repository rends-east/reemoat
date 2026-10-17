import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore } from "../src/events.js";
import { SessionRegistry, type ManagedSession } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { TaskDesk } from "../src/tasks/desk.js";
import { STAGED, TaskFiles } from "../src/tasks/files.js";
import { MemoryBoardConfigStore, MemoryTaskStore, taskFilesOf } from "../src/tasks/store.js";
import { Uploads } from "../src/uploads.js";
import { check } from "./daemoncheck.env.js";
import { memoryUploadIndex, stubAgentConfig, tokenFor, verifier } from "./daemoncheck.fixtures.js";
import { tmp } from "./tmp.js";

// A task's files (Q2.273): staged by an upload, taken by the create or comment that names them, carried by each run's message.
process.stdout.write("\na task's files: staged, given to a task or a comment, and sent to its agent\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  // Each prompt's words and the names of the files it links, in order; every turn is held until the driver ends it.
  interface Agent {
    prompts: { text: string; files: string[] }[];
    held: number[];
    send(message: unknown): void;
  }
  const agents = new Map<string, Agent>();
  let launched = 0;

  const spawn = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);
    let current: Agent | null = null;
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        if (message["method"] === undefined) continue;
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({ jsonrpc: "2.0", id, result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } });
            break;
          case acp.methods.agent.session.new: {
            const acpId = `c_files_${++launched}`;
            current = { prompts: [], held: [], send };
            agents.set(acpId, current);
            send({ jsonrpc: "2.0", id, result: { sessionId: acpId } });
            break;
          }
          case acp.methods.agent.session.prompt: {
            const blocks = (message["params"]?.["prompt"] ?? []) as { type: string; text?: string; name?: string }[];
            current?.prompts.push({
              text: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n\n"),
              files: blocks.filter((block) => block.type === "resource_link").map((block) => block.name ?? ""),
            });
            current?.held.push(id);
            break;
          }
          case acp.methods.agent.session.cancel:
            for (const held of current?.held.splice(0) ?? []) send({ jsonrpc: "2.0", id: held, result: { stopReason: "cancelled" } });
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
    };
  };

  class FilesRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "claude", displayName: "claude", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawn();
    }
  }

  const until = async (done: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> => {
    for (const at = Date.now(); Date.now() - at < ms; ) {
      if (await done()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return done();
  };

  const sessionUploads = await Uploads.open({ root: tmp("files-sessions-"), index: memoryUploadIndex(), onWarning: () => {} });
  const taskStore = await Uploads.open({ root: tmp("files-tasks-"), index: memoryUploadIndex(), onWarning: () => {} });
  // Never the default root: that is the real ~/.reemoat/worktrees.
  const registry = new SessionRegistry(new MemoryEventStore(), null, { worktreeRoot: tmp("files-wt-"), branchPrefix: "reemoat", defaultMode: "auto" }, new FilesRuntime(), sessionUploads);
  const store = new MemoryTaskStore();
  const desk = new TaskDesk({ registry, store, configs: new MemoryBoardConfigStore(), tickMs: 0, machineName: "mac", files: new TaskFiles(taskStore, sessionUploads) });
  const { app } = createApp({ registry, instanceId: "i_files", startedAt: Date.now(), peers: null, tasks: desk, verifier });
  const auth = { authorization: `Bearer ${tokenFor("u_alice")}` };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.fetch(
      new Request(`http://d${path}`, { method, headers: { ...auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    );
    const raw = await response.text();
    return { status: response.status, body: raw.length === 0 ? null : (JSON.parse(raw) as any) };
  };
  const upload = async (name: string, bytes: string, type = "text/plain") => {
    const response = await app.fetch(new Request(`http://d/tasks/uploads?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...auth, "content-type": type }, body: bytes }));
    return { status: response.status, body: (await response.json()) as any };
  };
  const said = (answer: { status: number; body: any }): string => `${answer.status}${answer.body?.error?.code ? ` ${answer.body.error.code}` : ""}`;
  const work = tmp("files-work-");
  const base = { brief: "Read the notes and fix it.", agent: "claude", cwd: work };

  const notes = await upload("notes.txt", "the notes");
  check("a file for a task is staged on its machine before any task names it", [notes.status, notes.body.upload.name, notes.body.upload.bytes], [201, "notes.txt", 9]);
  const stray = await call("POST", "/tasks", { ...base, key: "stray", attachments: ["u_0000000000000000"] });
  check("a create naming a file nothing staged is refused, and makes no task", [said(stray), (await call("GET", "/tasks")).body.tasks.length], ["400 unknown_attachment", 0]);
  const many = await call("POST", "/tasks", { ...base, attachments: Array.from({ length: 11 }, (_, i) => `u_${String(i).padStart(16, "0")}`) });
  check("and one naming more files than a message carries", said(many), "400 too_many_attachments");

  const made = await call("POST", "/tasks", { ...base, key: "with-notes", attachments: [notes.body.upload.uploadId] });
  const id: string = made.body.task.id;
  check("a create takes the files it names, and the task says what it was made with", [made.status, made.body.task.files.map((file: any) => [file.name, file.bytes])], [201, [["notes.txt", 9]]]);
  const again = await call("POST", "/tasks", { ...base, key: "with-notes", attachments: [notes.body.upload.uploadId] });
  check("the same create sent again answers that task, its files already taken", [again.status, again.body.existing, again.body.task.id], [200, true, id]);
  check("taken, a file is the task's and no longer waits", [taskStore.rowsOf(STAGED).length, taskStore.rowsOf(id).map((row) => row.name)], [0, ["notes.txt"]]);
  const fileId: string = made.body.task.files[0].id;
  const fetched = await app.fetch(new Request(`http://d/tasks/${id}/files/${fileId}`, { headers: auth }));
  check("a task's file is downloaded as any file the daemon serves", [fetched.status, fetched.headers.get("content-type"), await fetched.text()], [200, "application/octet-stream", "the notes"]);
  check("and one it does not keep is not found", said(await call("GET", `/tasks/${id}/files/u_0000000000000000`)), "404 upload_not_found");

  const shot = await upload("shot.png", "png bytes", "image/png");
  check("a comment with no words is refused unless files come with it", said(await call("POST", `/tasks/${id}/comments`, { text: " " })), "400 bad_request");
  const waiting = await call("POST", `/tasks/${id}/comments`, { text: "", attachments: [shot.body.upload.uploadId] });
  check(
    "a comment of files alone, with no run at work, keeps them for the next run",
    [waiting.status, waiting.body.comment.files.map((file: any) => file.name), waiting.body.comment.delivered, store.get(id)?.flow.pendingFiles?.map((file) => file.name)],
    [201, ["shot.png"], false, ["shot.png"]],
  );

  const moved = await call("POST", `/tasks/${id}/move`, { to: "running" });
  check("moved into a column that works, its run starts", moved.status, 200);
  await until(async () => store.get(id)?.flow.run?.session != null && registry.get(store.get(id)!.flow.run!.session!) !== undefined);
  const session = registry.get(store.get(id)!.flow.run!.session!) as ManagedSession;
  const agent = () => [...agents.values()].at(-1)!;
  await until(() => agent().prompts.length > 0);
  check("a new conversation gets the brief with the task's files and the comment's", [agent().prompts[0]?.text.startsWith(base.brief), agent().prompts[0]?.files], [true, ["notes.txt", "shot.png"]]);
  check("and its note says which comment they came with", agent().prompts[0]?.text.includes("Your user wrote on the task since:\n- (attached: shot.png)"), true);
  const kept = sessionUploads.rowsOf(session.id);
  check(
    "each as a file of the conversation's own, which its transcript hands back, sent",
    [kept.map((row) => row.name).sort(), kept.every((row) => row.consumedAt !== null), readFileSync(sessionUploads.pathFor(kept.find((row) => row.name === "notes.txt")!), "utf8")],
    [["notes.txt", "shot.png"], true, "the notes"],
  );
  const logged = session.log.read(0, 100, 1 << 20).map((stored) => stored.event).find((event) => event.type === "prompt") as any;
  check("and the transcript's message names them", logged?.attachments?.map((one: any) => one.name), ["notes.txt", "shot.png"]);
  check("what the run took no longer waits", store.get(id)?.flow.pendingFiles, []);

  const log = await upload("build.log", "it failed");
  const live = await call("POST", `/tasks/${id}/comments`, { text: "here is the log", attachments: [log.body.upload.uploadId] });
  check("a comment with a file while the run works goes into its conversation", [live.status, live.body.comment.delivered, live.body.comment.files.map((file: any) => file.name)], [201, true, ["build.log"]]);
  agent().send({ jsonrpc: "2.0", id: agent().held.shift(), result: { stopReason: "end_turn" } });
  await until(() => agent().prompts.length > 1);
  check("as its person's message, with the file", [agent().prompts[1]?.text, agent().prompts[1]?.files], ["here is the log", ["build.log"]]);

  const brief = await upload("spec.md", "# spec");
  const started = await call("POST", "/tasks", { ...base, brief: "Build the spec.", key: "started", start: true, attachments: [brief.body.upload.uploadId] });
  await until(() => agents.size > 1 && agent().prompts.length > 0);
  check("a create that starts its agent sends the files with the brief", [started.status, agent().prompts[0]?.text.startsWith("Build the spec."), agent().prompts[0]?.files], [201, true, ["spec.md"]]);

  check(
    "a file another daemon names is read field by field, and one not shaped as a file is left out",
    taskFilesOf([{ id: "u_0123456789abcdef", name: "a.txt", mime: null, bytes: 1 }, { id: "../../x", name: "b", mime: null, bytes: 1 }, "c", { id: "u_0123456789abcdef", name: "", mime: null, bytes: 1 }]).map((file) => file.name),
    ["a.txt"],
  );

  const removed = await call("DELETE", `/tasks/${id}`);
  await until(() => taskStore.rowsOf(id).length === 0);
  check("deleting the task removes its files; its conversation keeps its own", [removed.status, taskStore.rowsOf(id).length, sessionUploads.rowsOf(session.id).length > 0], [200, 0, true]);
  desk.engine.stop();
  await registry.shutdown();
}
