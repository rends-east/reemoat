import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  AGENT_IDS,
  AGENT_LOGIN,
  agentEnv,
  credentialEnvNames,
  findOnPath,
  forgetPathHits,
  hasLoginFlow,
  resolveAgent,
  type AgentId,
  type AgentLaunchConfig,
} from "../src/acp/agents.js";
import { AgentLoginRuns } from "../src/agentauth.js";
import { AgentScriptGate } from "../src/agentscript.js";
import { MemoryEventStore } from "../src/events.js";
import { sameBackgroundTasks, SessionRegistry, sameCommands } from "../src/registry.js";
import type { BackgroundTask } from "../src/acp/asynctasks.js";
import {
  LocalRuntime,
  firstVersion,
  hostLoginArgs,
  loginBlockedReason,
  loginStdio,
  readLoginAnswer,
  spawnPlan,
} from "../src/runtime/local.js";
import { toCommands } from "../src/session.js";
import type { AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { check, report } from "./daemoncheck.env.js";
import { sandbox, users, now, tokenFor, verifier, credentials } from "./daemoncheck.fixtures.js";

// Login is stubbed on a LocalRuntime subclass, so a new required SessionRuntime member is a type error here.
process.stdout.write("\na login id names its own run\n");
{
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

  function fakeLogin(): {
    process_: AgentProcess;
    typed: string[];
    stdout: PassThrough;
    stopped: string[];
  } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const typed: string[] = [];
    const stopped: string[] = [];
    let exited = false;
    stdin.on("data", (chunk: Buffer) => void typed.push(chunk.toString("utf8")));
    const process_: AgentProcess = {
      stdin,
      stdout,
      stderr,
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      get hasExited(): boolean {
        return exited;
      },
      // EOF ends both flows, so anything past stdin in stopped means the graceful path did not work.
      waitForExit: async () => {
        exited = true;
        return true;
      },
      endStdin: () => void stopped.push("stdin"),
      kill: async (signal: NodeJS.Signals) => void stopped.push(signal),
    };
    return { process_, typed, stdout, stopped };
  }

  class LoginRuntime extends LocalRuntime {
    readonly spawned: ReturnType<typeof fakeLogin>[] = [];
    override async login(_agent: AgentId): Promise<AgentProcess | null> {
      const made = fakeLogin();
      this.spawned.push(made);
      return made.process_;
    }
  }

  const runtime = new LoginRuntime();
  const warnings: string[] = [];
  const logins = new AgentLoginRuns({ runtime, onWarning: (detail) => void warnings.push(detail) });

  const claude = await logins.start("claude");
  if (claude === null) throw new Error("the stub runtime declined to start a login");
  check("a login run belongs to the agent it was started for", claude.agent, "claude");
  check("and starts with an empty transcript", claude.cursor, 0);

  check("an id that names nothing reads nothing", logins.read("li_nope", 0), null);
  check("nor can it be written into", logins.write("li_nope", "123456").kind, "not_found");
  await settle();
  check("so nothing was typed into the live one", runtime.spawned[0]?.typed ?? ["?"], []);
  check("while its own id reads it", logins.read(claude.loginId, 0) !== null, true);
  logins.write(claude.loginId, "123456");
  await settle();
  check("and writes into it, with the newline supplied here", runtime.spawned[0]?.typed.join(""), "123456\n");

  check("cancelling by an id that is nobody's refuses", await logins.cancel("li_nope"), false);
  check("and the live one is untouched by that", logins.read(claude.loginId, 0) !== null, true);

  // Supersede rather than refuse: a closed tab leaves a process waiting on stdin, and a refusal would be a permanent wall.
  const again = await logins.start("claude");
  check("a second login for the same agent gets a new id", again?.loginId !== claude.loginId, true);
  check("the superseded one is stopped rather than left holding a pty", runtime.spawned[0]?.stopped, ["stdin"]);
  check("and its id no longer resolves", logins.read(claude.loginId, 0), null);

  // Runs are keyed by agent: two wizards open at once is normal, and one shared slot made them supersede each other for ever.
  const kimi = await logins.start("kimi");
  if (kimi === null) throw new Error("the stub runtime declined the second agent");
  check("a login for another agent leaves the first one alone", logins.read(again!.loginId, 0) !== null, true);
  check("and stopped nothing", runtime.spawned[1]?.stopped, []);
  check("and the two runs are on different agents", [again?.agent, kimi.agent], ["claude", "kimi"]);

  runtime.spawned[2]?.stdout.write("x".repeat(70 * 1024));
  await settle();
  const capped = logins.read(kimi.loginId, 0);
  check("a transcript past the cap keeps its tail", capped?.chunk.length, 64 * 1024);
  check("drops exactly the excess off the front", capped?.dropped, 70 * 1024 - 64 * 1024);
  check("counts everything ever produced, not what survives", capped?.cursor, 70 * 1024);
  check("and tells the client its cursor is behind the window", capped?.gap, true);

  // A write that is entirely an unterminated OSC yields no text and a full carry, and its flush must still trim the buffer.
  const carrying = await logins.start("codex");
  if (carrying === null) throw new Error("the stub runtime declined the third agent");
  const opener = `\x1b]${"c".repeat(5_000)}`;
  for (let n = 0; n < 30; n += 1) runtime.spawned[3]?.stdout.write(opener);
  await settle();
  const flushed = logins.read(carrying.loginId, 0);
  // 5000, not 5002: scrub removes the OSC opener.
  check("a transcript of nothing but unterminated escapes is still counted", flushed?.cursor, 30 * 5_000);
  check("and still bounded at the documented ceiling", flushed?.chunk.length, 64 * 1024);
  check("with the excess dropped off the front and reported", flushed?.dropped, 30 * 5_000 - 64 * 1024);
  check("and no raw escape byte reaches a transcript rendered in a <pre>", flushed?.chunk.includes("\x1b"), false);

  // The clock is moved rather than the deadline: an abandoned login makes no traffic, and LOGIN_TTL_MS is not exported.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 11 * 60_000;
    check("an abandoned login is swept once its TTL passes", logins.read(kimi.loginId, 0), null);
  } finally {
    Date.now = realNow;
  }
  await settle();
  check("and its process is stopped, not left in the container", runtime.spawned[2]?.stopped, ["stdin"]);
  check("with a warning, since nothing in src/ prints", warnings.some((w) => w.includes("expired")), true);
}

// toCommands is the only bound on the agent's command list: it rides no event, so truncateEvent never sees it.

process.stdout.write("\nthe agent's command list is bounded where it arrives\n");
{
  const plain = toCommands([
    { name: "compact", description: "Compact the conversation", input: { hint: "<instructions>" } },
    { name: "status", description: "Show status", input: null },
  ] as never);
  check("a well-formed list survives whole", plain.commands.length, 2);
  check("with its hint", plain.commands[0]?.hint, "<instructions>");
  check("and no hint is null rather than empty", plain.commands[1]?.hint, null);
  check("and nothing is reported dropped", plain.dropped, 0);

  const nameless = toCommands([
    { name: "", description: "no name", input: null },
    { name: "   ", description: "only spaces", input: null },
    { name: "ok", description: "fine", input: null },
  ] as never);
  check("a nameless command is dropped", nameless.commands.map((c) => c.name), ["ok"]);
  check("and counted", nameless.dropped, 2);

  const dupes = toCommands([
    { name: "same", description: "first", input: null },
    { name: "same", description: "second", input: null },
  ] as never);
  check("a duplicate name keeps the first", dupes.commands.map((c) => c.description), ["first"]);
  check("and the duplicate is counted, not swallowed", dupes.dropped, 1);

  // A name is refused, not clipped: a command is invoked by sending its name, so a clipped one could not be used.
  const longName = "n".repeat(70);
  const overlong = toCommands([
    { name: longName, description: "one", input: null },
    { name: `${longName}-and-more`, description: "two", input: null },
    { name: "ok", description: "fine", input: null },
  ] as never);
  check("a name too long to type is dropped rather than clipped", overlong.commands.map((c) => c.name), ["ok"]);
  check("and both of them are counted", overlong.dropped, 2);
  const namesOf = (list: { commands: { name: string }[] }) => new Set(list.commands.map((c) => c.name)).size;
  check("no two commands ever share a name", [namesOf(overlong), namesOf(dupes)], [1, 1]);
  check("and every name that survives is sendable as typed", overlong.commands.every((c) => /^\S+$/.test(c.name)), true);

  const many = toCommands(
    Array.from({ length: 300 }, (_, index) => ({ name: `c${index}`, description: "x", input: null })) as never,
  );
  check("the list is capped", many.commands.length, 256);
  check("and what was cut is reported, not swallowed", many.dropped, 44);

  const long = toCommands([{ name: "c", description: "d".repeat(4096), input: { hint: "h".repeat(500) } }] as never);
  // At most, not exact: clip reserves room for its own note inside the budget.
  check("a runaway description is clipped to the ceiling", (long.commands[0]?.description.length ?? 0) <= 200, true);
  check("visibly, with this repo's own note", long.commands[0]?.description.endsWith("bytes]"), true);
  check("and so is a runaway hint", (long.commands[0]?.hint?.length ?? 0) <= 100, true);

  // The longest real hint is 64 characters, which is why the cap sits above it.
  const realHint = toCommands([
    { name: "effort", description: "Set effort level for model usage", input: { hint: "<low|medium|high|xhigh|max|ultracode|auto>" } },
  ] as never);
  check("a real hint is not clipped", realHint.commands[0]?.hint, "<low|medium|high|xhigh|max|ultracode|auto>");

  check("nothing at all is an empty list", [toCommands(undefined), toCommands(null)], [
    { commands: [], dropped: 0 },
    { commands: [], dropped: 0 },
  ]);
  const malformed = toCommands([
    { name: "a", description: 42, input: { hint: "" } },
    { name: "b", description: null, input: {} },
  ] as never);
  check("a description that is not a string becomes one", malformed.commands.map((c) => c.description), ["", ""]);
  check("and an empty hint is no hint", malformed.commands.map((c) => c.hint), [null, null]);
  check("neither is treated as a reason to drop the command", malformed.dropped, 0);

  // The agent decides the rate: claude republishes identical lists while discovering skills, and each announce costs a snapshot, a row and a frame per client.
  const listOf = (...names: string[]) => toCommands(names.map((name) => ({ name, description: "d", input: null })) as never);
  check("an identical republish is not announced", sameCommands(listOf("a", "b"), listOf("a", "b")), true);
  check("a new command is", sameCommands(listOf("a", "b"), listOf("a", "b", "c")), false);
  check("and so is a reorder, since the agent's order is what a menu shows", sameCommands(listOf("a", "b"), listOf("b", "a")), false);
  check(
    "a description that changed under the same name is announced",
    sameCommands(listOf("a"), toCommands([{ name: "a", description: "different", input: null }] as never)),
    false,
  );
  check(
    "and so is a hint",
    sameCommands(listOf("a"), toCommands([{ name: "a", description: "d", input: { hint: "h" } }] as never)),
    false,
  );
  check("a list that is the same but now cut is announced", sameCommands({ commands: [], dropped: 0 }, { commands: [], dropped: 3 }), false);
  check("withdrawing everything is announced", sameCommands(listOf("a"), { commands: [], dropped: 0 }), false);
  check("and an empty list republished empty is not", sameCommands({ commands: [], dropped: 0 }, { commands: [], dropped: 0 }), true);

  // usage.durationMs is excluded on purpose: a progress frame carrying only it would fan a snapshot to every client for a number nobody reads.
  const bgTask = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
    id: "t1",
    name: "build",
    taskType: "shell",
    description: "",
    state: "running",
    summary: null,
    lastToolName: null,
    usage: null,
    canStop: true,
    showInTranscript: true,
    outputFilePath: null,
    toolCallId: null,
    startedAt: 1_000,
    endedAt: null,
    ...over,
  });
  const usage = (durationMs: number) => ({ totalTokens: 10, toolUses: 2, durationMs });

  check("an identical list is not announced", sameBackgroundTasks([bgTask()], [bgTask()]), true);
  check("an empty list republished empty is not", sameBackgroundTasks([], []), true);
  check("a new task is", sameBackgroundTasks([bgTask()], [bgTask(), bgTask({ id: "t2" })]), false);
  check("a withdrawn one is", sameBackgroundTasks([bgTask()], []), false);
  check(
    "a reorder is, since the order is the one the panel shows",
    sameBackgroundTasks([bgTask(), bgTask({ id: "t2" })], [bgTask({ id: "t2" }), bgTask()]),
    false,
  );
  check("a state change is", sameBackgroundTasks([bgTask()], [bgTask({ state: "completed" })]), false);
  check("and an end time is", sameBackgroundTasks([bgTask()], [bgTask({ endedAt: 2_000 })]), false);
  check("a summary nothing draws yet is still announced", sameBackgroundTasks([bgTask()], [bgTask({ summary: "done" })]), false);
  check("and a lastToolName", sameBackgroundTasks([bgTask()], [bgTask({ lastToolName: "Bash" })]), false);
  check("and an outputFilePath", sameBackgroundTasks([bgTask()], [bgTask({ outputFilePath: "/tmp/x" })]), false);
  check(
    "a frame whose only delta is `usage.durationMs` is NOT announced",
    sameBackgroundTasks([bgTask({ usage: usage(1_000) })], [bgTask({ usage: usage(9_999) })]),
    true,
  );
  check(
    "but a token count moving is",
    sameBackgroundTasks([bgTask({ usage: usage(1_000) })], [bgTask({ usage: { totalTokens: 99, toolUses: 2, durationMs: 1_000 } })]),
    false,
  );
  check(
    "and usage appearing where there was none is",
    sameBackgroundTasks([bgTask()], [bgTask({ usage: usage(1_000) })]),
    false,
  );
}

// reap is the only thing that signals a process it did not start, off a pid read from a database.

process.stdout.write("\nthe reap fence\n");
{
  const runtime = new LocalRuntime();
  const afterBoot = Date.now();

  const noHandle = runtime.reap(null, afterBoot, true);
  check("no recorded agent is confirmed dead", [noHandle.killed, noHandle.confirmedDead], [false, true]);

  // A container handle's pgid names a vanished PID namespace, so signalling it would hit whatever holds that number here.
  const foreign = runtime.reap(
    { kind: "container", containerId: "c1", pgid: 4242, containerStartedAt: afterBoot },
    afterBoot,
    true,
  );
  check("a handle from the other runtime is not signalled", foreign.killed, false);
  check("and is not confirmed dead either, which would make the row terminal", foreign.confirmedDead, false);

  // The os.uptime fence: a session from before this boot names a pid from a reset numbering.
  const old = runtime.reap({ kind: "local", pid: process.pid }, 0, true);
  check("a pid predating this boot is left alone", [old.killed, old.confirmedDead], [false, false]);

  const off = runtime.reap({ kind: "local", pid: process.pid }, afterBoot, false);
  check("and so is every pid when reaping is off", [off.killed, off.confirmedDead], [false, false]);

  // Only dead confirms; unknown (EPERM, a pid recycled to another user) must not.
  const gone = runtime.reap({ kind: "local", pid: 0x7ffffffe }, afterBoot, true);
  check("a pid nothing holds is confirmed dead without a signal", [gone.killed, gone.confirmedDead], [false, true]);
}

process.stdout.write("\nis this agent signed in\n");
{
  const previous = process.env["CLAUDE_CODE_EXECUTABLE"];
  process.env["CLAUDE_CODE_EXECUTABLE"] = join(sandbox, "claude-stub");

  let probeEnv: NodeJS.ProcessEnv = {};
  const spawned = new Map<string, { command: string; args: readonly string[]; stream: string }>();
  const probeAs = async (
    agent: AgentId,
    answer: string | null,
    secrets: Record<string, string> = {},
  ): Promise<boolean | null | undefined> => {
    const runtime = new LocalRuntime({
      exec: async (command, args, env, stream) => {
        probeEnv = env;
        spawned.set(`${command} ${args.join(" ")}`, { command, args, stream });
        return answer;
      },
      secrets: () => secrets,
    });
    const found = (await runtime.availability()).find((entry) => entry.id === agent);
    return found?.loggedIn;
  };
  const claudeSays = async (answer: string | null, secrets: Record<string, string> = {}) =>
    probeAs("claude", answer, secrets);

  check("logged in is what the JSON says", await claudeSays('{"loggedIn": true}'), true);
  // Exit 1 accompanies this in real life; the probe never sees the status.
  check("and so is logged out", await claudeSays('{"loggedIn": false}'), false);
  // The three ways of not knowing, which must never render as "logged out".
  check("output that is not JSON is `cannot tell`", await claudeSays("Error: something went wrong"), null);
  check("JSON without the field is too", await claudeSays('{"account": "someone"}'), null);
  check("and no output at all is too", await claudeSays(null), null);
  // A pasted credential beats cannot-tell, but a clean false is the agent itself saying no, and wins.
  check("a pasted credential beats not knowing", await claudeSays(null, { CLAUDE_CODE_OAUTH_TOKEN: "sk" }), true);
  check(
    "but a clean `false` is believed over one",
    await claudeSays('{"loggedIn": false}', { CLAUDE_CODE_OAUTH_TOKEN: "sk" }),
    false,
  );
  check("because the probe was handed that token", probeEnv["CLAUDE_CODE_OAUTH_TOKEN"], "sk");
  check("and not this daemon's own environment", probeEnv["REEMOAT_TOKEN"], undefined);

  // Whatever the executable variable names is what every spawn drives (Q4.114).
  const codexStub = join(sandbox, "codex-stub");
  const priorCodexPath = process.env["CODEX_PATH"];
  process.env["CODEX_PATH"] = codexStub;
  spawned.clear();
  check("codex reads as signed in from its own wording", await probeAs("codex", "Logged in using ChatGPT"), true);
  check("and as signed out", await probeAs("codex", "Not logged in"), false);
  check("and anything else is cannot-tell", await probeAs("codex", "Checking…"), null);
  // By arguments, not command: the same binary is spawned for the status probe and for the version read.
  const statusOf = (command: string) =>
    [...spawned.values()].find((entry) => entry.command === command && entry.args[0] !== "--version");
  const codexProbe = statusOf(codexStub);
  check("CODEX_PATH chose the binary the probe ran", codexProbe?.command, codexStub);
  check("with the status arguments from the table", codexProbe?.args, ["login", "status"]);
  // The version read must hit the same file as the status probe, or the daemon reports one build while running another.
  const versionOf = (command: string) =>
    [...spawned.values()].find((entry) => entry.command === command && entry.args[0] === "--version");
  check("and the version read asked the same binary", versionOf(codexStub)?.args, ["--version"]);
  // codex answers its status on stderr and claude on stdout; reading the wrong stream silently yields cannot-tell.
  check("and read from stderr, where codex answers", codexProbe?.stream, "stderr");
  const claudeStub = join(sandbox, "claude-stub");
  const claudeProbe = statusOf(claudeStub);
  check("while claude's is read from stdout", claudeProbe?.stream, "stdout");
  check("and CLAUDE_CODE_EXECUTABLE chose its binary", claudeProbe?.command, claudeStub);
  check("and its version was read off that binary too", versionOf(claudeStub)?.args, ["--version"]);
  // An override is never compared: chooseCli returns on it before walking PATH (Q4.114).
  check(
    "and no other binary was consulted while an override named one",
    [...spawned.values()]
      .filter((entry) => entry.command !== codexStub && entry.command !== claudeStub)
      // Narrowed to claude and codex: other harnesses legitimately spawn their own status probes.
      .filter((entry) => /(^|[/\\])(claude|codex)$/.test(entry.command)).length,
    0,
  );
  if (priorCodexPath === undefined) delete process.env["CODEX_PATH"];
  else process.env["CODEX_PATH"] = priorCodexPath;

  if (previous === undefined) delete process.env["CLAUDE_CODE_EXECUTABLE"];
  else process.env["CLAUDE_CODE_EXECUTABLE"] = previous;
}

process.stdout.write("\nthe login pty, on both platforms\n");
{
  check("BSD takes the command as argv after the typescript file", hostLoginArgs("darwin", "/usr/bin/claude", ["auth", "login"], "script"), {
    command: "script",
    args: ["-q", "/dev/null", "/usr/bin/claude", "auth", "login"],
  });
  check("a path with a space survives BSD as one argument", hostLoginArgs("darwin", "/Apps/My Tools/claude", ["auth"], "script").args, [
    "-q",
    "/dev/null",
    "/Apps/My Tools/claude",
    "auth",
  ]);

  // util-linux runs one string through `/bin/sh -c`, so every word is quoted.
  check("util-linux takes one shell string after -qec", hostLoginArgs("linux", "/usr/bin/claude", ["auth", "login"], "script"), {
    command: "script",
    args: ["-qec", "'/usr/bin/claude' 'auth' 'login'", "/dev/null"],
  });
  check(
    "and an unknown platform takes the util-linux form",
    hostLoginArgs("sunos" as NodeJS.Platform, "/usr/bin/kimi", ["login"], "script").args[0],
    "-qec",
  );
  check("a path with a space is one word to the shell", hostLoginArgs("linux", "/Apps/My Tools/claude", [], "script").args[1], "'/Apps/My Tools/claude'");
  // The escape that prevents command injection: a single quote closes, escapes and reopens the string.
  check(
    "and a path with a quote cannot reopen the string",
    hostLoginArgs("linux", "/Apps/it's/claude", [], "script").args[1],
    String.raw`'/Apps/it'\''s/claude'`,
  );
  // The resolved script is spawned, not the bare name: PATH order is not trusted.
  check("the resolved script path is what is spawned", hostLoginArgs("linux", "/usr/bin/claude", [], "/usr/bin/script").command, "/usr/bin/script");

  // BSD script copies its own stdin's termios onto the pty, so a pipe makes it exit 1; claude and Linux keep their pipe.
  check("a device-code flow on BSD gets no stdin", loginStdio("darwin", false), "ignore");
  check("an interactive flow on BSD keeps its pipe", loginStdio("darwin", true), "pipe");
  check("and Linux keeps its pipe either way", [loginStdio("linux", false), loginStdio("linux", true)], [
    "pipe",
    "pipe",
  ]);
  check(
    "which agents that leaves without an input box, per platform",
    AGENT_IDS.filter((id) => loginStdio("darwin", AGENT_LOGIN[id].interactiveStdin) === "ignore"),
    ["kimi", "codex", "opencode", "grok"],
  );
  check(
    "claude is the one it cannot rescue, because its flow reads a code back",
    AGENT_LOGIN.claude.interactiveStdin,
    true,
  );

  // Nullable so the client draws no sign-out button for an agent that cannot sign out.
  check(
    "the agents with a sign-out command",
    AGENT_IDS.filter((id) => AGENT_LOGIN[id].logoutArgs !== null).map((id) => [
      id,
      AGENT_LOGIN[id].logoutArgs,
    ]),
    [
      ["claude", ["auth", "logout"]],
      ["codex", ["logout"]],
      // grok's no-auto-update flag leads every argv: status runs on the probe TTL, and its updater could replace a live session's binary.
      ["grok", ["--no-auto-update", "logout"]],
    ],
  );
  // kimi has no such verb; opencode's would remove a key this daemon never put there.
  check(
    "and the two without one",
    AGENT_IDS.filter((id) => AGENT_LOGIN[id].logoutArgs === null),
    ["kimi", "opencode"],
  );

  // This daemon deliberately does not probe opencode's working status command: its free tier runs anonymously, so false would be a lie (Q7.99).
  check(
    "how each agent answers whether it is signed in",
    AGENT_IDS.map((id) => {
      const spec = AGENT_LOGIN[id];
      return `${id}: ${spec.status === null ? "no command" : `${spec.status.args.join(" ")} on ${spec.status.stream}`}` +
        ` / ${spec.credentialPath ?? "no file"}`;
    }),
    [
      "claude: auth status on stdout / no file",
      "kimi: no command / .kimi-code/credentials",
      "codex: login status on stderr / no file",
      "opencode: no command / .local/share/opencode/auth.json",
      // grok's file is grok login's and its command also covers a pasted key: two credentials, not one twice.
      "grok: --no-auto-update models on stdout / .grok/auth.json",
    ],
  );
  // grok's text probe must stay a partition: one command answers three ways.
  {
    const probe = AGENT_LOGIN.grok.status;
    const reads = probe !== null && probe.reads === "text" ? probe : null;
    const against = (line: string): string =>
      reads === null
        ? "no text probe"
        : reads.signedIn.test(line)
          ? reads.signedOut.test(line)
            ? "BOTH"
            : "in"
          : reads.signedOut.test(line)
            ? "out"
            : "cannot tell";
    check(
      "grok's status strings are a partition, not an overlap",
      [
        against("You are logged in with grok.com."),
        against("You are using XAI_API_KEY."),
        against("You are not authenticated."),
        against("Default model: grok-4.7"),
      ],
      ["in", "in", "out", "cannot tell"],
    );
  }
  // admit refuses on false, so an agent that runs without credentials must never be able to produce one.
  check(
    "and the one that runs without credentials cannot report itself signed out",
    AGENT_LOGIN.opencode.status,
    null,
  );
}

process.stdout.write("\neach agent's login, as it is written down\n");
{
  check("every agent in the union has a login entry", AGENT_IDS.every((id) => AGENT_LOGIN[id] !== undefined), true);

  // A bare codex login waits for a browser on port 1455, which a headless daemon never finishes.
  check("codex logs in by device code, not by browser", AGENT_LOGIN.codex.args, ["login", "--device-auth"]);
  // null means no flow, which makes loginBlockedReason answer no_flow instead of apologising for a wizard.
  check(
    "which agents have a sign-in to run at all",
    AGENT_IDS.filter(hasLoginFlow),
    ["claude", "kimi", "codex", "grok"],
  );
  check(
    "and the one that does not is refused before anything is spawned",
    loginBlockedReason("linux", false, true, true, false),
    "no_flow",
  );
  check(
    "and it outranks every reason that is about the host",
    loginBlockedReason("darwin", true, false, false, false),
    "no_flow",
  );
  check(
    "and its pty spawn carries that flag through",
    hostLoginArgs("darwin", "/usr/bin/codex", AGENT_LOGIN.codex.args ?? [], "script").args,
    ["-q", "/dev/null", "/usr/bin/codex", "login", "--device-auth"],
  );

  check("codex's pasted credential is CODEX_API_KEY", credentialEnvNames("codex"), ["CODEX_API_KEY"]);
  check("and OPENAI_API_KEY is not offered, because codex does not read it", credentialEnvNames("codex").includes("OPENAI_API_KEY"), false);

  // CODEX_PATH chooses the CLI a codex session runs, so login, logout, probe and session must all resolve through it.
  check(
    "the agents whose binary an env var names",
    AGENT_IDS.filter((id) => AGENT_LOGIN[id].executableEnv !== null).map((id) => [id, AGENT_LOGIN[id].executableEnv]),
    [
      ["claude", "CLAUDE_CODE_EXECUTABLE"],
      ["codex", "CODEX_PATH"],
    ],
  );
}

process.stdout.write("\nwhat a login status command said\n");
{
  const claude = AGENT_LOGIN.claude.status;
  const codex = AGENT_LOGIN.codex.status;
  if (claude === null || claude.reads !== "json") throw new Error("claude's status probe is supposed to read JSON");
  if (codex === null || codex.reads !== "text") throw new Error("codex's status probe is supposed to read prose");

  check("claude's JSON says signed in", readLoginAnswer(claude, `{"loggedIn": true}`), true);
  check("and says signed out", readLoginAnswer(claude, `{"loggedIn": false}`), false);
  check("and anything that is not JSON is cannot-tell", readLoginAnswer(claude, "command not found"), null);
  check("including JSON without the field", readLoginAnswer(claude, `{"account": "x"}`), null);

  // Not logged in is the only negative the codex binary prints.
  for (const line of [
    "Logged in using ChatGPT",
    "Logged in using an API key - sk-…",
    "Logged in using personal access token",
    "Logged in using Amazon Bedrock API key",
  ]) {
    check(`codex's "${line.slice(0, 24)}…" reads as signed in`, readLoginAnswer(codex, line), true);
  }
  check("codex's Not logged in reads as signed out", readLoginAnswer(codex, "Not logged in"), false);
  check("codex answers on stderr and claude on stdout", [codex.stream, claude.stream], ["stderr", "stdout"]);
  // signedOut is tested first: Logged in is a substring of Not logged in.
  check("and is not read as signed in by the substring", codex.signedIn.test("Not logged in"), false);
  // A CLI that grew a banner still has its answer read: the patterns are per-line.
  check("a preamble above the answer does not hide it", readLoginAnswer(codex, "codex 0.146.1\nNot logged in"), false);
  check("anything else is cannot-tell", readLoginAnswer(codex, "Checking…"), null);
}

process.stdout.write("\nthe environment an agent is spawned with\n");
{
  const saved = { ...process.env };
  process.env["CODEX_THREAD_ID"] = "parent-thread";
  process.env["CODEX_SANDBOX_NETWORK_DISABLED"] = "1";
  process.env["CODEX_HOME"] = "/somewhere/else";
  process.env["CODEX_PATH"] = "/opt/codex";
  process.env["CLAUDE_CODE_SESSION_ID"] = "parent-session";
  process.env["CLAUDE_CODE_EXECUTABLE"] = "/opt/claude";
  process.env["REEMOAT_TOKEN"] = "secret";

  const env = agentEnv();
  check("a parent codex session's thread does not reach the child", env["CODEX_THREAD_ID"], undefined);
  check("nor does its sandbox, which would confine an agent nobody confined", env["CODEX_SANDBOX_NETWORK_DISABLED"], undefined);
  check("nor a parent claude session", env["CLAUDE_CODE_SESSION_ID"], undefined);
  check("nor this daemon's own configuration", env["REEMOAT_TOKEN"], undefined);
  // These are deliberate overrides, so no prefix sweep: CODEX_PATH names the binary, CODEX_HOME the credentials.
  check("but CODEX_HOME survives, because it is an override and not a session", env["CODEX_HOME"], "/somewhere/else");
  check("and CODEX_PATH survives, which is the binary rather than the credentials", env["CODEX_PATH"], "/opt/codex");
  // claude derives its macOS Keychain account from USER, so USER must stay off SESSION_SCOPED_ENV.
  process.env["USER"] = "ada";
  process.env["LOGNAME"] = "ada";
  const identified = agentEnv();
  check("USER reaches the agent, because a credential store is keyed on it", identified["USER"], "ada");
  check("and LOGNAME with it, since POSIX has two spellings and tools read either", identified["LOGNAME"], "ada");
  check("and so does CLAUDE_CODE_EXECUTABLE", env["CLAUDE_CODE_EXECUTABLE"], "/opt/claude");

  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
}

// The claude and codex adapters refuse to resolve without a CLI, so a stub is named in each variable for the loop (Q4.114).
process.stdout.write("\nhow each agent is launched\n");
{
  const prior = { claude: process.env["CLAUDE_CODE_EXECUTABLE"], codex: process.env["CODEX_PATH"] };
  process.env["CLAUDE_CODE_EXECUTABLE"] = join(sandbox, "claude-stub");
  process.env["CODEX_PATH"] = join(sandbox, "codex-stub");
  for (const id of AGENT_IDS) {
    let config: AgentLaunchConfig | null = null;
    try {
      config = resolveAgent(id);
    } catch {
      // Not installed here: the CLIs resolved from PATH may be legitimately absent.
    }
    if (id === "kimi") {
      // A skip, never a fallback: a default would pass by construction wherever kimi is absent.
      if (config === null) {
        process.stdout.write("  skip  kimi is not installed here, so its launch shape is unasserted\n");
      } else {
        check("kimi is launched as an ACP subcommand of the CLI itself", config.args, ["acp"]);
      }
      continue;
    }
    if (id === "opencode") {
      if (config === null) {
        process.stdout.write("  skip  opencode is not installed here, so its launch shape is unasserted\n");
        continue;
      }
      check("opencode is launched as an ACP subcommand of the CLI itself", config.args, ["acp"]);
      check("and opencode says which binary it is", config.displayName.length > 0, true);
      check("and the binary a session runs is the one a login drives", config.command, findOnPath("opencode"));
      continue;
    }
    if (id === "grok") {
      // grok's no-auto-update flag keeps build moves in agentupdate.ts, and its always-approve flag would silence every permission card.
      if (config === null) {
        process.stdout.write("  skip  grok is not installed here, so its launch shape is unasserted\n");
        continue;
      }
      check("grok is launched as an ACP subcommand of the CLI itself", config.args, [
        "--no-auto-update",
        "agent",
        "stdio",
      ]);
      check(
        "and it is never spawned with the flag that would silence every permission card",
        config.args.some((arg) => arg === "--always-approve" || arg === "--yolo"),
        false,
      );
      check("and the binary a session runs is the one a login drives", config.command, findOnPath("grok"));
      continue;
    }
    check(`${id}'s adapter is resolvable and takes no arguments`, config?.args, []);
    check(`and ${id} says which binary it is`, (config?.displayName ?? "").length > 0, true);
  }

  // Reachable only where MANAGED_CLI_DIRS holds no copy either; PATH points at an empty directory rather than being unset (Q4.114).
  const priorPath = process.env["PATH"];
  const bare = join(sandbox, "no-cli-bin");
  mkdirSync(bare, { recursive: true });
  process.env["PATH"] = bare;
  const withAdapter = AGENT_IDS.flatMap((id) => {
    const variable = AGENT_LOGIN[id].executableEnv;
    return variable === null ? [] : [{ id, variable, command: AGENT_LOGIN[id].command }];
  });
  report("some harness has an adapter, so the refusal below is asked of somebody", withAdapter.length > 0, withAdapter.map((one) => one.id).join(", "));
  for (const { id, variable, command } of withAdapter) {
    delete process.env[variable];
    forgetPathHits();
    const name = `without a CLI the ${id} adapter is refused, naming deploy/agents.sh, --source npm and ${variable}`;
    const elsewhere = findOnPath(command);
    if (elsewhere !== null) {
      report(name, true, `skipped: this machine has a ${command} at ${elsewhere}, which is searched after PATH`);
      continue;
    }
    let refusal: string | null = null;
    try {
      resolveAgent(id);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    report(
      name,
      refusal !== null &&
        refusal.includes("deploy/agents.sh") &&
        refusal.includes("--source npm") &&
        refusal.includes(variable),
      refusal ?? `resolved with no ${command} anywhere`,
    );
  }
  if (priorPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = priorPath;
  // Misses are cached for thirty seconds and would be believed by every later section.
  forgetPathHits();

  if (prior.claude === undefined) delete process.env["CLAUDE_CODE_EXECUTABLE"];
  else process.env["CLAUDE_CODE_EXECUTABLE"] = prior.claude;
  if (prior.codex === undefined) delete process.env["CODEX_PATH"];
  else process.env["CODEX_PATH"] = prior.codex;
}

process.stdout.write("\nwhether a login can be driven\n");
{
  const appFor = (loginSupported: boolean) => {
    class PtyRuntime extends LocalRuntime {
      override get loginSupported(): boolean {
        return loginSupported;
      }
      override async login(): Promise<AgentProcess | null> {
        return null;
      }
    }
    const own = new SessionRegistry(new MemoryEventStore(), null, undefined, new PtyRuntime());
    return createApp({
      registry: own,
      verifier,
      instanceId: "i_pty",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;
  };

  const listing = async (loginSupported: boolean): Promise<boolean> => {
    const response = await appFor(loginSupported).fetch(
      new Request("http://d/agent-auth", { headers: { authorization: `Bearer ${tokenFor("u_a")}` } }),
    );
    return (JSON.parse(await response.text()) as { loginSupported: boolean }).loginSupported;
  };

  check("a host with a pty to allocate says so", await listing(true), true);
  // A run registry exists in both cases, so this is false only if the route asks the runtime.
  check("a host without one says so too, rather than 503ing on tap", await listing(false), false);

  // Both routes build login support in loginSupportOf, so they are compared to each other rather than to a literal.
  const loginRows = async (path: string): Promise<Record<string, string | null>> => {
    const response = await appFor(true).fetch(
      new Request(`http://d${path}`, { headers: { authorization: `Bearer ${tokenFor("u_a")}` } }),
    );
    const body = JSON.parse(await response.text()) as {
      agents: { id: AgentId; login?: { blocked?: string | null } }[];
    };
    return Object.fromEntries(body.agents.map((one) => [one.id, one.login?.blocked ?? null]));
  };
  const cheap = await loginRows("/agents");
  check("every agent carries its blocked reason on the cheap route as well", [
    AGENT_IDS.every((id) => id in cheap),
    cheap["opencode"],
  ], [true, "no_flow"]);
  check("and the two routes cannot disagree about it", cheap, await loginRows("/agent-auth"));

  // no_flow has teeth: with no login object the client draws a cannot-check badge over an agent that runs.
  {
    const { Contributions } = await import("../src/plugins/contributions.js");
    const { parseManifest } = await import("../src/plugins/manifest.js");
    const { PLUGIN_API_VERSION } = await import("../src/plugins/protocol.js");
    const { SYSTEM_IDS } = await import("../src/acp/systems.js");
    const read = parseManifest(
      JSON.stringify({
        id: "acme",
        name: "Acme Tools",
        version: "1.0.0",
        api: PLUGIN_API_VERSION,
        scopes: ["harness", "system"],
        contributes: {
          harnesses: [
            // standalone stays in this fixture: a removed key must still install unchanged and simply not be read.
            // node, not gemini: an unresolvable command falls back to the label, so the fixture names a program that is always present.
            { id: "gemini", name: "Gemini", command: "node", args: ["acp"], envNames: ["GEMINI_API_KEY"], standalone: true },
          ],
          systems: [
            {
              id: "groq",
              name: "Groq",
              apiType: "anthropic",
              baseUrl: "https://api.groq.com/anthropic",
              authHeader: { name: "authorization", prefix: "Bearer " },
              models: [{ id: "llama-4", name: "Llama 4" }],
            },
          ],
        },
      }),
    );
    if (!read.ok) throw new Error(read.message);
    const machine = new Contributions([
      { id: "acme", version: "1.0.0", manifest: read.manifest, enabled: true, installedAt: 1, updatedAt: 1, source: null },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), null, undefined, new LocalRuntime({ machine }));
    own.setMachineCatalogue(machine);
    const withPlugin = createApp({
      registry: own,
      verifier,
      instanceId: "i_contrib",
      startedAt: now,
      credentials,
      roots: [users],
      systems: {
        credentials: { list: () => [], get: () => null, save: () => {}, remove: () => {} },
        customAgents: { list: () => [], get: () => null, save: () => {}, remove: () => {} },
        strip: { list: () => [], replace: () => {}, forget: () => {} },
      },
    }).app;
    const get = async (path: string): Promise<Record<string, unknown>> =>
      JSON.parse(
        await (
          await withPlugin.fetch(new Request(`http://d${path}`, { headers: { authorization: `Bearer ${tokenFor("u_a")}` } }))
        ).text(),
      ) as Record<string, unknown>;

    const agents = (await get("/agents"))["agents"] as {
      id: string;
      label?: string;
      displayName: string;
      contributedBy?: { pluginId: string; pluginName: string };
      login?: { blocked?: string | null };
    }[];
    const added = agents.find((one) => one.id === "acme:gemini") ?? null;
    check(
      "a harness a plugin added is on GET /agents, named, placed and with nothing to sign in to",
      added === null
        ? "absent"
        : [added.label ?? null, added.contributedBy ?? null, added.login?.blocked ?? null],
      ["Gemini", { pluginId: "acme", pluginName: "Acme Tools" }, "no_flow"],
    );
    check(
      "and says nothing about being one on its own",
      added === null ? "absent" : "standalone" in added,
      false,
    );
    // displayName is the log line carrying the program; label is what a tile draws.
    check(
      "and its log line is not its label",
      added === null ? "absent" : [added.displayName, added.label ?? null],
      ["Gemini (node)", "Gemini"],
    );
    // The unresolvable arm, pinned on its own: here displayName collapses onto the label, the opposite of the arm above.
    const unbuilt = parseManifest(
      JSON.stringify({
        id: "acme",
        name: "Acme Tools",
        version: "1.0.0",
        api: PLUGIN_API_VERSION,
        scopes: ["harness"],
        contributes: {
          harnesses: [{ id: "gemini", name: "Gemini", command: "definitely-not-installed-anywhere", args: [] }],
        },
      }),
    );
    if (!unbuilt.ok) throw new Error(unbuilt.message);
    const absent = await new LocalRuntime({
      machine: new Contributions([
        {
          id: "acme",
          version: "1.0.0",
          manifest: unbuilt.manifest,
          enabled: true,
          installedAt: 1,
          updatedAt: 1,
          source: null,
        },
      ]),
    }).availability();
    const missing = absent.find((one) => one.id === "acme:gemini") ?? null;
    check(
      "a harness whose program is not on this machine is named, not available, and not a bare id",
      missing === null
        ? "absent"
        : [missing.displayName, missing.label ?? null, missing.available],
      ["Gemini", "Gemini", false],
    );
    check(
      "and its hint names the program it wanted and the plugin that added it",
      missing === null
        ? "absent"
        : [
            (missing.hint ?? "").includes("definitely-not-installed-anywhere"),
            (missing.hint ?? "").includes("Acme Tools"),
          ],
      [true, true],
    );
    const slots = ((await get("/agent-auth"))["agents"] as { id: string; credentials: { envName: string }[] }[]).find(
      (one) => one.id === "acme:gemini",
    );
    check(
      "and the paste box it offers is the one its manifest named",
      slots?.credentials.map((one) => one.envName) ?? "absent",
      ["GEMINI_API_KEY"],
    );

    const systems = (await get("/systems"))["systems"] as { id: string; displayName: string; contributedBy?: unknown }[];
    check(
      "a provider a plugin added is on GET /systems, after every built-in",
      [systems.length, systems[systems.length - 1]?.id, systems[systems.length - 1]?.displayName],
      [SYSTEM_IDS.length + 1, "acme:groq", "Groq"],
    );
    check(
      "and it says which plugin it came from",
      systems[systems.length - 1]?.contributedBy ?? null,
      { pluginId: "acme", pluginName: "Acme Tools" },
    );
    const off = new Contributions([
      { id: "acme", version: "1.0.0", manifest: read.manifest, enabled: false, installedAt: 1, updatedAt: 1, source: null },
    ]);
    const ownOff = new SessionRegistry(new MemoryEventStore(), null, undefined, new LocalRuntime({ machine: off }));
    ownOff.setMachineCatalogue(off);
    const offApp = createApp({
      registry: ownOff,
      verifier,
      instanceId: "i_contrib_off",
      startedAt: now,
      credentials,
      roots: [users],
    }).app;
    const offAgents = JSON.parse(
      await (
        await offApp.fetch(new Request("http://d/agents", { headers: { authorization: `Bearer ${tokenFor("u_a")}` } }))
      ).text(),
    ) as { agents: { id: string }[] };
    check("a switched-off plugin's harness is not listed at all", offAgents.agents.map((one) => one.id), [...AGENT_IDS]);
    const refused = await offApp.fetch(
      new Request("http://d/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_a")}`, "content-type": "application/json" },
        body: JSON.stringify({ agent: "acme:gemini", cwd: users }),
      }),
    );
    const body = JSON.parse(await refused.text()) as { error?: { code?: string } };
    check(
      "and starting a session on it is refused as a machine's state rather than a caller's mistake",
      [refused.status, body.error?.code ?? null],
      [503, "harness_unavailable"],
    );
    const never = await offApp.fetch(
      new Request("http://d/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_a")}`, "content-type": "application/json" },
        body: JSON.stringify({ agent: "nobody:here", cwd: users }),
      }),
    );
    check("while one nobody ever offered is the caller's", never.status, 400);
  }
  const noStore = createApp({
    registry: new SessionRegistry(new MemoryEventStore(), null, undefined, new LocalRuntime()),
    verifier,
    instanceId: "i_nostore",
    startedAt: now,
    credentials,
    roots: [users],
  }).app;
  const bare = JSON.parse(
    await (
      await noStore.fetch(
        new Request("http://d/agents", { headers: { authorization: `Bearer ${tokenFor("u_a")}` } }),
      )
    ).text(),
  ) as { agents: { id: AgentId; login?: { blocked?: string | null; supported?: boolean } }[] };
  const opencode = bare.agents.find((one) => one.id === "opencode");
  check(
    "with no login store at all, the agent's own reason still wins over the host's",
    [
      opencode?.login?.blocked,
      // With no store nobody may sign in, and supported means no blocked reason, so every row must carry one.
      bare.agents.every((one) => one.login?.supported === false),
      bare.agents.every((one) => (one.login?.blocked ?? null) !== null),
    ],
    ["no_flow", true, true],
  );
}

process.stdout.write("\ntwo tabs, and the shutdown that follows\n");
{
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

  class CountingRuntime extends LocalRuntime {
    readonly stopped: string[][] = [];
    override async login(): Promise<AgentProcess | null> {
      const record: string[] = [];
      this.stopped.push(record);
      const stdin = new PassThrough();
      let exited = false;
      return {
        stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        get hasExited(): boolean {
          return exited;
        },
        waitForExit: async () => {
          exited = true;
          return true;
        },
        endStdin: () => void record.push("stdin"),
        kill: async (signal: NodeJS.Signals) => void record.push(signal),
      };
    }
  }

  const runtime = new CountingRuntime();
  const logins = new AgentLoginRuns({ runtime });

  // Two tabs or React's double-mount start concurrently; start awaits twice before recording, so it serialises rather than refuses.
  const [first, second] = await Promise.all([logins.start("claude"), logins.start("claude")]);
  await settle();
  check("two concurrent starts leave exactly one run reachable", [
    logins.read(first?.loginId ?? "", 0) !== null,
    logins.read(second?.loginId ?? "", 0) !== null,
  ], [false, true]);
  check("and the loser was disposed rather than orphaned", runtime.stopped[0], ["stdin"]);
  check("while the survivor is untouched", runtime.stopped[1], []);

  // Shutdown needs both the flag and the await on in-flight starts, or a start landing a microsecond later outlives the exit.
  await logins.shutdown();
  check("shutdown stops the live run", runtime.stopped[1], ["stdin"]);
  check("and a start afterwards refuses", await logins.start("claude"), null);
  check("without spawning anything to leave behind", runtime.stopped.length, 2);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve() };
}

process.stdout.write("\nkeeping the agent CLIs current\n");
{
  const { AgentUpdates, FIRST_RUN_DELAY_MS, UPDATE_INTERVAL_MS, UPDATE_JITTER, agentChannelFrom, agentSourceFrom } = await import(
    "../src/agentupdate.js"
  );

  type Fired = { delay: number; fire: () => void };
  const armed: Fired[] = [];
  const fake = (fn: () => void, ms: number) => {
    const entry = { delay: ms, fire: fn };
    armed.push(entry);
    return { cancel: () => { entry.fire = () => {}; } };
  };

  const ran: string[][] = [];
  const warnings: string[] = [];
  const updated: Array<string | null> = [];
  const make = (over: Partial<Parameters<typeof AgentUpdates.start>[0]> = {}) =>
    AgentUpdates.start({
      busy: () => [],
      onWarning: (detail) => warnings.push(detail),
      onUpdated: (report) => updated.push(report),
      schedule: fake,
      jitter: () => 0.5,
      run: async (_script, args) => {
        ran.push([...args]);
        return { ok: true, detail: "  claude        refresh 2.1.259" };
      },
      ...over,
    });

  const runs = make();
  check("the first run is armed, and not at boot", armed[0]?.delay, FIRST_RUN_DELAY_MS);
  // Not at boot: restore and autoResume are already starting agents then.
  check("which is minutes rather than seconds", FIRST_RUN_DELAY_MS >= 60_000, true);

  armed[0]?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check("firing it runs the script once", ran.length, 1);
  check("with the channel spelled out and nothing skipped when nothing is live", ran[0], ["--channel", "latest", "--refresh-only"]);
  // refresh-only is asserted on every run below, since presence in the default case is what a conditional would also satisfy.
  check("and the cached CLI choice is dropped afterwards", updated.length, 1);
  check("handing over what the script printed", updated[0], "  claude        refresh 2.1.259");
  check("then the next run is armed", armed.length, 2);
  check("a day away, jittered either side of it", armed[1]?.delay, UPDATE_INTERVAL_MS);
  check(
    "and the jitter really does reach both directions",
    [
      Math.round(UPDATE_INTERVAL_MS * (1 + (0 * 2 - 1) * UPDATE_JITTER)) < UPDATE_INTERVAL_MS,
      Math.round(UPDATE_INTERVAL_MS * (1 + (1 * 2 - 1) * UPDATE_JITTER)) > UPDATE_INTERVAL_MS,
    ],
    [true, true],
  );

  // A live harness is named as a skip, which withholds only pruning its previous build; the script decides by provenance (Q4.114).
  ran.length = 0;
  armed.length = 0;
  const busy = make({ busy: () => ["kimi", "claude"] });
  armed[0]?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check("a live harness is passed through as a skip, after the channel", ran[0], ["--channel", "latest", "--refresh-only", "--skip", "kimi", "--skip", "claude"]);
  await busy.shutdown();

  // The source is a flag because updateEnv strips every REEMOAT_ name (Q4.114).
  ran.length = 0;
  armed.length = 0;
  const fromNpm = make({ source: "npm", busy: () => ["kimi"] });
  armed[0]?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check("the npm source is named to the script, ahead of the channel and the skips", ran[0], ["--source", "npm", "--channel", "latest", "--refresh-only", "--skip", "kimi"]);
  await fromNpm.shutdown();

  // vendor is the script's default and never spelled out, so a rename there cannot break every daemon in the field.
  ran.length = 0;
  armed.length = 0;
  const fromVendor = make({ source: "vendor", busy: () => ["kimi"] });
  armed[0]?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check("the vendor source is the script's own default, and is not spelled out to it", ran[0], ["--channel", "latest", "--refresh-only", "--skip", "kimi"]);
  await fromVendor.shutdown();

  // The channel is spelled out on every run: claude install rewrites claude's own setting, so the env file must decide (Q4.115).
  ran.length = 0;
  armed.length = 0;
  const onStable = make({ channel: "stable", busy: () => ["kimi"] });
  armed[0]?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check("a chosen stable channel is named to the script, ahead of the skips", ran[0], ["--channel", "stable", "--refresh-only", "--skip", "kimi"]);
  await onStable.shutdown();

  // agents.sh answers a contended lock with exit 0, so the gate keeps an install and a refresh from meeting.
  ran.length = 0;
  armed.length = 0;
  warnings.length = 0;
  updated.length = 0;
  const gate = new AgentScriptGate();
  check("an install can take the gate", gate.tryHold("install", "kimi"), true);
  const yielding = make({ gate });
  armed[0]?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check(
    "a tick refused by the gate spawns nothing, warns nothing and reports nothing",
    [ran.length, warnings.length, updated.length],
    [0, 0, 0],
  );
  check("and comes back soon rather than tomorrow", armed.at(-1)?.delay, FIRST_RUN_DELAY_MS);
  // runOnce marks the nudge spent on its first line, so the gate test must sit outside it.
  yielding.nudge();
  await new Promise((r) => setTimeout(r, 0));
  check("and a nudge is still available afterwards", armed.at(-1)?.delay, FIRST_RUN_DELAY_MS);
  gate.release("install");
  armed.at(-1)?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check("and once the install is done the refresh runs", ran.length, 1);
  check("and the gate is released afterwards", gate.tryHold("update"), true);
  gate.release("update");
  await yielding.shutdown();

  // An unknown channel is reported and read as the default: the script would exit 2 on it daily.
  {
    const said: string[] = [];
    const read = (value: string | undefined) => agentChannelFrom(value, (detail) => void said.push(detail));
    check("stable is stable, however it is cased or padded", [read("stable"), read(" STABLE ")], ["stable", "stable"]);
    check("and nothing is said about it", said, []);
    check(
      "unset, empty and latest are all the default",
      [read(undefined), read(""), read("latest"), read(" LATEST ")],
      ["latest", "latest", "latest", "latest"],
    );
    check("in silence", said, []);
    check("a spelling the daemon does not know is read as the default rather than obeyed or refused", read("bogus"), "latest");
    check(
      "with exactly one line, naming the spelling it saw and the two it knows",
      [said.length, said[0]?.includes("REEMOAT_AGENT_CHANNEL=bogus") ?? false, said[0]?.includes("stable or latest") ?? false],
      [1, true, true],
    );
  }

  // An unknown source is reported and read as the default: obeying makes the script exit 2 daily, refusing stops the daemon starting.
  {
    const said: string[] = [];
    const read = (value: string | undefined) => agentSourceFrom(value, (detail) => void said.push(detail));
    check("npm is npm, however it is cased or padded", [read("npm"), read(" NPM ")], ["npm", "npm"]);
    check("and nothing is said about it", said, []);
    check(
      "unset, empty and vendor are all the default",
      [read(undefined), read(""), read("vendor"), read(" Vendor ")],
      ["vendor", "vendor", "vendor", "vendor"],
    );
    check("in silence", said, []);
    check("a spelling the daemon does not know is read as the default rather than obeyed or refused", read("bogus"), "vendor");
    check(
      "with exactly one line, naming the spelling it saw and the two it knows",
      [said.length, said[0]?.includes("bogus") ?? false, said[0]?.includes("vendor or npm") ?? false],
      [1, true, true],
    );
  }

  ran.length = 0;
  armed.length = 0;
  const nudged = make();
  check("before the nudge the first run is still minutes away", [armed.length, armed[0]?.delay], [1, FIRST_RUN_DELAY_MS]);
  nudged.nudge();
  await new Promise((r) => setTimeout(r, 0));
  check("a nudge runs it now", ran.length, 1);
  check("and the next run is armed a day away as usual", [armed.length, armed[1]?.delay], [2, UPDATE_INTERVAL_MS]);
  // A second nudge runs nothing: the daemon nudges after every run, so the two would feed each other.
  nudged.nudge();
  await new Promise((r) => setTimeout(r, 0));
  check("a second nudge runs nothing: the day's timer stands", [ran.length, armed.length, armed[1]?.delay], [1, 2, UPDATE_INTERVAL_MS]);
  await nudged.shutdown();
  nudged.nudge();
  await new Promise((r) => setTimeout(r, 0));
  check("after shutdown a nudge runs nothing", ran.length, 1);
  {
    // The daemon's own loop: the pass is a macrotask and the timer is re-armed before it ends, so it must settle at one run.
    ran.length = 0;
    armed.length = 0;
    let passes = 0;
    const loop = make({
      onUpdated: () => {
        passes += 1;
        setTimeout(() => loop.nudge(), 0);
      },
    });
    loop.nudge();
    await new Promise((r) => setTimeout(r, 20));
    check("a pass that still finds no CLI does not run the installer again", [ran.length, passes], [1, 1]);
    check("and the next run is the day's", [armed.length, armed[1]?.delay], [2, UPDATE_INTERVAL_MS]);
    await loop.shutdown();
  }
  {
    ran.length = 0;
    armed.length = 0;
    const gate = deferred();
    const slow = make({ run: async (_script, args) => { ran.push([...args]); await gate.promise; return { ok: true, detail: null }; } });
    armed[0]?.fire();
    await new Promise((r) => setTimeout(r, 0));
    slow.nudge();
    await new Promise((r) => setTimeout(r, 0));
    check("a nudge during a run starts no second run beside it", ran.length, 1);
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await slow.shutdown();
  }
  {
    ran.length = 0;
    armed.length = 0;
    const off = make({ mode: "off" });
    off.nudge();
    await new Promise((r) => setTimeout(r, 0));
    check("and with updates off a nudge runs nothing at all", [armed.length, ran.length], [0, 0]);
    await off.shutdown();
  }

  // A failure is a warning and the schedule survives it; nothing may throw out of a timer.
  ran.length = 0;
  armed.length = 0;
  updated.length = 0;
  const failing = make({ run: async () => ({ ok: false, detail: "curl: (6) could not resolve host" }) });
  armed[0]?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check("a failed run warns", warnings.at(-1)?.includes("could not resolve host"), true);
  // The cache is not dropped on failure, or later readers believe a build moved.
  check("and does not claim anything was updated", updated.length, 0);
  check("while still arming the next one", armed.length, 2);
  await failing.shutdown();

  ran.length = 0;
  armed.length = 0;
  const throwing = make({ run: async () => { throw new Error("ENOENT agents.sh"); } });
  armed[0]?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check("a run that throws is reported rather than lost", warnings.at(-1)?.includes("ENOENT"), true);
  await throwing.shutdown();

  armed.length = 0;
  const off = make({ mode: "off" });
  check("switched off, nothing is armed", armed.length, 0);
  await off.shutdown();

  armed.length = 0;
  ran.length = 0;
  const stopping = make();
  const pending = armed[0];
  await stopping.shutdown();
  pending?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check("shutdown disarms the schedule", ran.length, 0);
  check("and nothing re-arms after it", armed.length, 1);
  check("shutting down twice is the same as once", await stopping.shutdown(), undefined);

  // The script exits 0 whatever the vendors answered, so its stderr summary must reach onWarning whole.
  ran.length = 0;
  armed.length = 0;
  updated.length = 0;
  warnings.length = 0;
  const partial = make({
    run: async () => ({
      ok: true,
      detail: null,
      warnings: "  codex         update failed; keeping codex-cli 0.146.1\n  1 of 4 agents were not installed or refreshed; the lines above say why",
    }),
  });
  armed[0]?.fire();
  await new Promise((r) => setTimeout(r, 0));
  check("a vendor the run could not reach is a warning", warnings.at(-1)?.includes("were not installed or refreshed"), true);
  check("and the cache is still dropped, because three of four may have moved", updated.length, 1);
  await partial.shutdown();

  armed.length = 0;
  ran.length = 0;
  const settle = deferred();
  const during = make({ run: () => settle.promise.then(() => ({ ok: true, detail: null })) });
  armed[0]?.fire();
  await new Promise((r) => setTimeout(r, 0));
  await during.shutdown();
  settle.resolve();
  await new Promise((r) => setTimeout(r, 0));
  check("a shutdown during a run does not re-arm when the run settles", armed.length, 1);

  // The real runner, because an injected run cannot show the script's environment or whether the deadline reaches its children.
  const { runScript, updateEnv } = await import("../src/agentupdate.js");
  const priorToken = process.env["REEMOAT_TOKEN"];
  process.env["REEMOAT_TOKEN"] = "not-for-vendors";
  const env = updateEnv();
  check("the script never sees this daemon's own configuration", Object.keys(env).filter((key) => key.startsWith("REEMOAT_")), []);
  check("and is rooted where MANAGED_CLI_DIRS is", env["HOME"], homedir());
  const echo = join(sandbox, "agents-echo.sh");
  writeFileSync(echo, "#!/bin/sh\nprintf '%s|%s' \"${REEMOAT_TOKEN:-}\" \"$HOME\"\nprintf 'vendor down\\n' >&2\n");
  chmodSync(echo, 0o755);
  const echoed = await runScript(echo, [], 5000);
  check("the real runner hands it that environment", echoed.detail?.startsWith(`|${homedir()}`), true);
  check("and hands stderr back on its own", echoed.warnings, "vendor down");
  check("with the run counted as complete", echoed.ok, true);
  if (priorToken === undefined) delete process.env["REEMOAT_TOKEN"];
  else process.env["REEMOAT_TOKEN"] = priorToken;

  // spawn emits error then close; only the real runner drives the settled guard.
  const gone = await runScript(join(sandbox, "no-such-agents.sh"), [], 1000);
  check("a script that is not there is a failed run naming why", [gone.ok, gone.detail?.includes("ENOENT")], [false, true]);
  const inert = join(sandbox, "agents-inert.sh");
  writeFileSync(inert, "#!/bin/sh\necho never\n");
  chmodSync(inert, 0o644);
  const refused = await runScript(inert, [], 1000);
  check("and so is one that cannot be executed", [refused.ok, refused.detail?.includes("EACCES")], [false, true]);

  // The deadline must kill the backgrounded grandchild, or the next run starts a second installer over this one.
  const stall = join(sandbox, "agents-stall.sh");
  // The pid goes to a file: stdout may be undrained at the kill, and a pid of 0 would read as alive.
  const pidFile = join(sandbox, "grandchild.pid");
  writeFileSync(stall, `#!/bin/sh\nsleep 30 &\nprintf %s "$!" > ${pidFile}\nsleep 30\n`);
  chmodSync(stall, 0o755);
  const before = Date.now();
  // 1500 ms so the script reaches its printf before the deadline, while staying well under the 5000 ms bound below.
  const cut = await runScript(stall, [], 1500);
  const grandchild = Number.parseInt(existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "0", 10);
  check("the deadline ends the run", [cut.ok, cut.detail?.includes("timed out")], [false, true]);
  check("within the deadline rather than the installer's own patience", Date.now() - before < 5000, true);
  await new Promise((r) => setTimeout(r, 50));
  // Guarded: signalling pid 0 addresses this process's own group and always succeeds.
  const alive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  check("the script's grandchild was recorded at all", grandchild > 0, true);
  check("and the deadline reaches it", alive(grandchild), false);

  await runs.shutdown();
}

process.stdout.write("\nwhich build of a CLI runs\n");
{
  check("a v prefix is not a word boundary", firstVersion("v2.1.259"), "2.1.259");
  check("claude puts the number first", firstVersion("2.1.259 (Claude Code)"), "2.1.259");
  check("codex puts it last", firstVersion("codex-cli 0.146.1"), "0.146.1");
  check("a pre-release suffix is noise", firstVersion("1.0.0-beta.1"), "1.0.0");
  check("and so is a build stamp after it", firstVersion("codex-cli 0.146.1 (build 20260903)"), "0.146.1");
  check("nothing is nothing", [firstVersion(""), firstVersion("garbage"), firstVersion("2")], [null, null, null]);

  check(
    "an override names the vendor's variable and leaves the command alone",
    spawnPlan("/adapter", { path: "/mine/claude", version: "9.9.9", source: "override" }, "CLAUDE_CODE_EXECUTABLE"),
    { command: "/adapter", env: { CLAUDE_CODE_EXECUTABLE: "/mine/claude" } },
  );
  check(
    "so does a copy found on PATH, under a harness that has a variable",
    spawnPlan("/adapter", { path: "/usr/local/bin/codex", version: "1.0.0", source: "path" }, "CODEX_PATH"),
    { command: "/adapter", env: { CODEX_PATH: "/usr/local/bin/codex" } },
  );
  check(
    "a harness with no variable has its command replaced",
    spawnPlan("/usr/bin/kimi", { path: "/toolchain/bin/kimi", version: "0.40.1", source: "path" }, null),
    { command: "/toolchain/bin/kimi", env: {} },
  );
  check(
    "a built-in with no CLI leaves the launch untouched, because describe has already refused it",
    spawnPlan("/adapter", null, "CLAUDE_CODE_EXECUTABLE"),
    { command: "/adapter", env: {} },
  );
  check("and no choice at all leaves the launch untouched", spawnPlan("/somewhere/acme", null, null), { command: "/somewhere/acme", env: {} });

  // Two sources and no third: an override outright, else the first copy on PATH, then MANAGED_CLI_DIRS (Q4.114).
  const bin = join(sandbox, "cli-bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["claude", "codex", "kimi"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  const prior = {
    path: process.env["PATH"],
    claude: process.env["CLAUDE_CODE_EXECUTABLE"],
    codex: process.env["CODEX_PATH"],
  };
  process.env["PATH"] = `${bin}:${prior.path ?? ""}`;
  delete process.env["CLAUDE_CODE_EXECUTABLE"];
  delete process.env["CODEX_PATH"];
  const answers = new Map<string, string | null>();
  const spawns: string[] = [];
  const warnings: string[] = [];
  const runtime = new LocalRuntime({
    exec: async (command, args) => {
      spawns.push(command);
      return args[0] === "--version" ? (answers.get(command) ?? null) : null;
    },
    secrets: () => ({}),
    onWarning: (detail) => warnings.push(detail),
  });
  const fresh = (): void => {
    runtime.forgetAvailability();
    spawns.length = 0;
  };
  const stubClaude = join(bin, "claude");
  const stubKimi = join(bin, "kimi");

  fresh();
  answers.set(stubClaude, "9.9.9 (Claude Code)");
  const onPath = await runtime.agentCli("claude");
  check("a copy on PATH is chosen, and says which build", [onPath?.source, onPath?.path, onPath?.version], ["path", stubClaude, "9.9.9"]);

  fresh();
  answers.set(stubClaude, null);
  const mute = await runtime.agentCli("claude");
  check("one that will not say which build it is still runs, with no version", [mute?.source, mute?.path, mute?.version], ["path", stubClaude, null]);
  check("and nothing is warned about it", warnings.length, 0);

  fresh();
  answers.set(stubClaude, "9.9.9 (Claude Code)");
  answers.set("/mine/claude", "8.8.8 (Claude Code)");
  process.env["CLAUDE_CODE_EXECUTABLE"] = "/mine/claude";
  const overridden = await runtime.agentCli("claude");
  check("an override is chosen whatever PATH holds", [overridden?.source, overridden?.path, overridden?.version], ["override", "/mine/claude", "8.8.8"]);
  check("and its version is read from that file alone", spawns, ["/mine/claude"]);
  delete process.env["CLAUDE_CODE_EXECUTABLE"];

  fresh();
  answers.set(stubKimi, "0.40.1");
  const kimiOnly = await runtime.agentCli("kimi");
  check("a harness that is the program runs the one on PATH, and says which build", [kimiOnly?.source, kimiOnly?.path, kimiOnly?.version], ["path", stubKimi, "0.40.1"]);
  fresh();
  const ownOpencode = findOnPath("opencode");
  const opencode = await runtime.agentCli("opencode");
  report(
    "a harness with no adapter runs the file a login would drive",
    ownOpencode === null ? true : opencode?.source === "path" && opencode.path === ownOpencode,
    ownOpencode === null
      ? "skipped: no opencode on this machine, so there is nothing to choose"
      : `source ${String(opencode?.source)}, ${String(opencode?.path)}`,
  );

  fresh();
  answers.set(stubClaude, "9.9.9 (Claude Code)");
  await runtime.agentCli("claude");
  await runtime.agentCli("claude");
  check("a choice is held rather than re-asked", spawns.length, 1);
  runtime.forgetAvailability();
  await runtime.agentCli("claude");
  check("and forgetAvailability makes the next call ask again", spawns.length, 2);

  // A held choice remembers which file its path named and re-chooses when it moves (Q6.112).
  // forgetAvailability is not called between the calls, or every check here would pass regardless.
  const builds = join(sandbox, "cli-builds");
  const linkBin = join(sandbox, "cli-link-bin");
  mkdirSync(builds, { recursive: true });
  mkdirSync(linkBin, { recursive: true });
  for (const version of ["2.1.278", "2.1.280"]) {
    writeFileSync(join(builds, version), `#!/bin/sh\necho ${version}\n`);
    chmodSync(join(builds, version), 0o755);
  }
  const link = join(linkBin, "claude");
  symlinkSync(join(builds, "2.1.278"), link);
  process.env["PATH"] = `${linkBin}:${bin}:${prior.path ?? ""}`;
  fresh();
  answers.set(link, "2.1.278 (Claude Code)");
  await runtime.agentCli("kimi");
  await runtime.agentCli("claude");
  const unmoved = await runtime.agentCli("claude");
  check(
    "a build that has not moved is not asked again",
    [unmoved?.version, spawns.filter((one) => one === link).length],
    ["2.1.278", 1],
  );

  symlinkSync(join(builds, "2.1.280"), `${link}.next`);
  renameSync(`${link}.next`, link);
  answers.set(link, "2.1.280 (Claude Code)");
  const repointed = await runtime.agentCli("claude");
  check(
    "one that moved under the held choice is chosen again at its next use, with no forgetAvailability",
    [repointed?.path, repointed?.version, spawns.filter((one) => one === link).length],
    [link, "2.1.280", 2],
  );
  await runtime.agentCli("claude");
  check("and the new build is held in its turn", spawns.filter((one) => one === link).length, 2);
  await runtime.agentCli("kimi");
  check("and only the harness whose file moved is asked again", spawns.filter((one) => one === stubKimi).length, 1);

  // An npm update replaces the file in place, so only inode, size and change time say it moved.
  writeFileSync(join(builds, "2.1.281.tmp"), "#!/bin/sh\necho 2.1.281 replaced where it stands\n");
  chmodSync(join(builds, "2.1.281.tmp"), 0o755);
  renameSync(join(builds, "2.1.281.tmp"), join(builds, "2.1.280"));
  answers.set(link, "2.1.281 (Claude Code)");
  const replaced = await runtime.agentCli("claude");
  check(
    "and so is a file replaced where it stands, which is how an npm update lands",
    [replaced?.version, spawns.filter((one) => one === link).length],
    ["2.1.281", 3],
  );

  // A vanished build is a change too; the link stays on PATH, so the count is what shows it was asked.
  unlinkSync(join(builds, "2.1.280"));
  await runtime.agentCli("claude");
  check("and so is one whose file has vanished", spawns.filter((one) => one === link).length, 4);
  process.env["PATH"] = `${bin}:${prior.path ?? ""}`;
  forgetPathHits();

  // Could-not-tell is not a new build, or a stalled mount would respawn the version read on every use; identify is the only seam for it.
  let seen: string | null = "a";
  const blindSpawns: string[] = [];
  const blind = new LocalRuntime({
    exec: async (command) => {
      blindSpawns.push(command);
      return "9.9.9 (Claude Code)";
    },
    identify: async () => seen,
    secrets: () => ({}),
  });
  await blind.agentCli("claude");
  seen = null;
  await blind.agentCli("claude");
  check("a file that does not answer is not a new build, so the held choice stands", blindSpawns.length, 1);
  seen = "b";
  await blind.agentCli("claude");
  check("and one that answers as a different file is chosen again", blindSpawns.length, 2);

  // The hit awaits the probe, so forgetAvailability can land inside it; the extra spawn is the negative control.
  let straddleGate: Promise<string> | null = null;
  const straddleSpawns: string[] = [];
  const straddle = new LocalRuntime({
    exec: async (command) => {
      straddleSpawns.push(command);
      return "9.9.9 (Claude Code)";
    },
    identify: () => straddleGate ?? Promise.resolve("same"),
    secrets: () => ({}),
  });
  await straddle.agentCli("claude");
  const hold = deferred();
  straddleGate = hold.promise.then(() => "same");
  const straddled = straddle.agentCli("claude");
  await new Promise((r) => setTimeout(r, 0));
  straddle.forgetAvailability();
  straddleGate = null;
  hold.resolve();
  await straddled;
  check("a hit that straddles forgetAvailability is not handed back after it", straddleSpawns.length, 2);

  // A miss is never held by cliChosen. forgetPathHits stands in for the 30 s memo; forgetAvailability is not called, since it clears cliChosen too.
  const missBin = join(sandbox, "cli-bin-miss");
  mkdirSync(missBin, { recursive: true });
  for (const name of ["claude", "kimi"]) {
    writeFileSync(join(missBin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(missBin, name), 0o755);
  }
  process.env["PATH"] = missBin;
  fresh();
  const codexElsewhere = findOnPath("codex");
  if (codexElsewhere !== null) {
    report(
      "a miss is not held by the runtime, so the first call after an install finds the file",
      true,
      `skipped: this machine has a codex at ${codexElsewhere}, which is searched after PATH`,
    );
  } else {
    const missed = await runtime.agentCli("codex");
    const stubCodex = join(missBin, "codex");
    writeFileSync(stubCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(stubCodex, 0o755);
    answers.set(stubCodex, "codex-cli 0.153.0");
    forgetPathHits();
    const found = await runtime.agentCli("codex");
    report(
      "a miss is not held by the runtime, so the first call after an install finds the file",
      missed === null && found?.source === "path" && found.path === stubCodex && found.version === "0.153.0",
      `before ${JSON.stringify(missed)}, after ${JSON.stringify(found)}`,
    );
  }
  process.env["PATH"] = `${bin}:${prior.path ?? ""}`;
  forgetPathHits();

  // Two askers on a cold cache cost one version read, and an answer started before forgetAvailability is not written back.
  // identify is stubbed so filesystem callbacks do not skew the count.
  const gate = deferred();
  const slowSpawns: string[] = [];
  const slow = new LocalRuntime({
    exec: async (command) => {
      slowSpawns.push(command);
      await gate.promise;
      return "9.9.9 (Claude Code)";
    },
    identify: async () => "stub",
    secrets: () => ({}),
  });
  forgetPathHits();
  const first = slow.agentCli("claude");
  const second = slow.agentCli("claude");
  await new Promise((r) => setTimeout(r, 0));
  check("two askers arriving together cost one --version", slowSpawns.length, 1);
  gate.resolve();
  check("and get the same answer", (await first)?.path === (await second)?.path, true);

  const lateGate = deferred();
  const fencedSpawns: string[] = [];
  const fenced = new LocalRuntime({
    exec: async (command) => {
      fencedSpawns.push(command);
      await lateGate.promise;
      return "9.9.9 (Claude Code)";
    },
    identify: async () => "stub",
    secrets: () => ({}),
  });
  forgetPathHits();
  const inFlight = fenced.agentCli("claude");
  await new Promise((r) => setTimeout(r, 0));
  fenced.forgetAvailability();
  lateGate.resolve();
  await inFlight;
  fencedSpawns.length = 0;
  await fenced.agentCli("claude");
  check("an answer that started before forgetAvailability is not written back over it", fencedSpawns.length, 1);

  if (prior.path === undefined) delete process.env["PATH"];
  else process.env["PATH"] = prior.path;
  if (prior.claude !== undefined) process.env["CLAUDE_CODE_EXECUTABLE"] = prior.claude;
  if (prior.codex !== undefined) process.env["CODEX_PATH"] = prior.codex;
  forgetPathHits();
}
