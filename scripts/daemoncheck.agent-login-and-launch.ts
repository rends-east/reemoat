import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  AGENT_IDS,
  AGENT_LOGIN,
  agentEnv,
  credentialEnvNames,
  hasLoginFlow,
  resolveAgent,
  vendoredOpencode,
  type AgentId,
  type AgentLaunchConfig,
} from "../src/acp/agents.js";
import { AgentLoginRuns } from "../src/agentauth.js";
import { MemoryEventStore } from "../src/events.js";
import { SessionRegistry, sameCommands } from "../src/registry.js";
import {
  LocalRuntime,
  hostLoginArgs,
  loginBlockedReason,
  loginStdio,
  readLoginAnswer,
} from "../src/runtime/local.js";
import { toCommands } from "../src/session.js";
import type { AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { check } from "./daemoncheck.env.js";
import { sandbox, users, now, tokenFor, verifier, credentials } from "./daemoncheck.fixtures.js";

/**
 * A login id names its own run, and a superseded one names nothing.
 *
 * The rule used to be an ownership check across tenants; what it does now is stop
 * a **superseded** wizard — one whose client has not noticed it was replaced —
 * reading, or worse typing a one-time code into, its successor's stdin.
 *
 * The runtime is stubbed rather than the class, so everything real is exercised:
 * the identity check in `own`, the supersede rule, the `starting` serialisation,
 * the TTL sweep and the output cap. `login()` hands back three in-memory pipes
 * and a record of how it was stopped. Subclassing `LocalRuntime` rather than
 * hand-rolling the interface means a new required member of `SessionRuntime` is
 * a type error here rather than a silently untested path.
 */
process.stdout.write("\na login id names its own run\n");
{
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

  /** An `AgentProcess` that is three pipes, what was typed into it, and how it died. */
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
      // EOF is the first rung of `dispose`'s ladder and both flows end on it, so
      // this stub never reaches SIGTERM — which is what makes `stopped` readable:
      // anything past "stdin" in it means the graceful path did not work.
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

  // An id that names nothing gets nothing, on both verbs — a write is the half
  // that would otherwise type a one-time code into a flow it does not belong to.
  check("an id that names nothing reads nothing", logins.read("li_nope", 0), null);
  check("nor can it be written into", logins.write("li_nope", "123456").kind, "not_found");
  await settle();
  check("so nothing was typed into the live one", runtime.spawned[0]?.typed ?? ["?"], []);
  check("while its own id reads it", logins.read(claude.loginId, 0) !== null, true);
  logins.write(claude.loginId, "123456");
  await settle();
  // The newline is supplied here and not by the caller: these flows read a line,
  // and a client that had to remember it would be one that eventually forgot.
  check("and writes into it, with the newline supplied here", runtime.spawned[0]?.typed.join(""), "123456\n");

  check("cancelling by an id that is nobody's refuses", await logins.cancel("li_nope"), false);
  check("and the live one is untouched by that", logins.read(claude.loginId, 0) !== null, true);

  /*
   * A second login for the *same* agent supersedes rather than being refused.
   *
   * Refusing is the obvious choice and the wrong one: the commonest way one of
   * these ends is somebody closing the tab, which leaves a process waiting on
   * stdin with nobody to type into it — and "you already have a login in progress"
   * would then be a permanent wall in front of the one person who cannot get past
   * it any other way.
   */
  const again = await logins.start("claude");
  check("a second login for the same agent gets a new id", again?.loginId !== claude.loginId, true);
  check("the superseded one is stopped rather than left holding a pty", runtime.spawned[0]?.stopped, ["stdin"]);
  check("and its id no longer resolves", logins.read(claude.loginId, 0), null);

  /*
   * **A login for a different agent must not disturb it**, and leaving the agent
   * out of the key was a live defect rather than a hypothetical.
   *
   * Settings renders one wizard per agent, each with its own `sessionStorage`
   * entry, so both open at once is the normal state for somebody logging in to
   * claude *and* kimi. With one slot, starting the second superseded the first;
   * the superseded wizard's next 700ms poll answered 404 and it started over,
   * superseding the second. The two ping-ponged for ever with no backoff, each
   * cycle spawning a pty and then running the full kill ladder, and neither login
   * could ever complete.
   */
  const kimi = await logins.start("kimi");
  if (kimi === null) throw new Error("the stub runtime declined the second agent");
  check("a login for another agent leaves the first one alone", logins.read(again!.loginId, 0) !== null, true);
  check("and stopped nothing", runtime.spawned[1]?.stopped, []);
  check("and the two runs are on different agents", [again?.agent, kimi.agent], ["claude", "kimi"]);

  /*
   * The 64 KiB cap, from the front.
   *
   * A device-code flow produces a few hundred bytes, so reaching this at all means
   * something is spinning — and dropping the *newest* output would hide whatever
   * it is now saying. The gap flag is what stops a client silently stitching two
   * halves of a transcript together across the hole.
   */
  runtime.spawned[2]?.stdout.write("x".repeat(70 * 1024));
  await settle();
  const capped = logins.read(kimi.loginId, 0);
  check("a transcript past the cap keeps its tail", capped?.chunk.length, 64 * 1024);
  check("drops exactly the excess off the front", capped?.dropped, 70 * 1024 - 64 * 1024);
  check("counts everything ever produced, not what survives", capped?.cursor, 70 * 1024);
  check("and tells the client its cursor is behind the window", capped?.gap, true);

  /*
   * **The way round that cap, which is a chunk with no body at all.**
   *
   * `PARTIAL_ESCAPE`'s OSC branch matches an unterminated `\x1b]` of any length
   * anchored at the end, so a write that is *entirely* one yields `text === ""`
   * and a carry holding the whole thing — and that is precisely the shape the
   * `MAX_CARRY_BYTES` flush exists for. The flushed bytes went into the buffer
   * and then the function returned at `if (text.length === 0) return;`, which sat
   * *above* the only statement that trims the buffer. A CLI emitting one of these
   * per write grew this transcript with no ceiling at all for the run's whole
   * ten-minute TTL, while 64 KiB went on being documented as the bound, and the
   * wizard polls all of it.
   *
   * Thirty writes of a little over 4 KiB each: over `MAX_CARRY_BYTES` so every
   * one flushes, and 150 KiB in total so the cap has more than twice its own
   * width to bite on. Driven through the real pipes rather than by calling
   * `sanitize`, because `sanitize` was never the half that was wrong — it
   * returned exactly this pair all along.
   */
  const carrying = await logins.start("codex");
  if (carrying === null) throw new Error("the stub runtime declined the third agent");
  const opener = `\x1b]${"c".repeat(5_000)}`;
  for (let n = 0; n < 30; n += 1) runtime.spawned[3]?.stdout.write(opener);
  await settle();
  const flushed = logins.read(carrying.loginId, 0);
  // 5000 rather than 5002: `scrub` takes the `\x1b]` off, which is the second
  // half of the same fix and is asserted on its own two lines down.
  check("a transcript of nothing but unterminated escapes is still counted", flushed?.cursor, 30 * 5_000);
  check("and still bounded at the documented ceiling", flushed?.chunk.length, 64 * 1024);
  check("with the excess dropped off the front and reported", flushed?.dropped, 30 * 5_000 - 64 * 1024);
  /*
   * And what lands is scrubbed, which the flush used to skip. Those bytes reach
   * the buffer precisely *because* they are not an escape sequence, so they are
   * ordinary output — and raw they put ESC and the C0 range into a string the
   * client renders in a `<pre>`.
   */
  check("and no raw escape byte reaches a transcript rendered in a <pre>", flushed?.chunk.includes("\x1b"), false);

  /*
   * The TTL, on the clock rather than on traffic.
   *
   * The state it exists for produces no traffic at all: somebody closes the tab,
   * the polling stops, and nothing calls in again — so a sweep that ran only from
   * `start`/`read`/`write` could never observe the one case it was written for.
   * The clock is moved rather than the deadline, because `LOGIN_TTL_MS` is not
   * exported and a driver that reached for it would be shaping the code.
   */
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

/* ------------------------------------------------------------------ *
 * whether a login can be driven, which is two facts and not one
 *
 * `GET /agent-auth` reported `logins !== null` — that there is somewhere to
 * *record* a run — and called it `loginSupported`. The other half is whether the
 * host has a `script` to allocate a pty with, which `SessionRuntime` answers and
 * `LocalRuntime.login` refuses on by returning null. With only the first half a
 * daemon on a host without `script` said `true`, both clients drew the wizard off
 * it, and tapping it answered `503 login_unsupported` — the exact outcome the
 * field's own comment says it exists to prevent, on the one screen somebody
 * reaches when their agent has just refused a prompt.
 *
 * Driven through the route rather than by reading the property, because the bug
 * was never in the property: it was in the route not asking.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * the agent's command list, bounded at ingest
 *
 * `toCommands` is where the agent's own strings enter this process, and it is the
 * only place they are bounded: the list rides no event, so `truncateEvent` never
 * sees it, and it is served from its own route, so nothing downstream is willing
 * to shrink it. "Bounded by whatever the agent sent" is not a bound.
 *
 * Asserted directly rather than through a session, because what these are about
 * is a pathological *payload* — an MCP server publishing hundreds of prompts, a
 * description the length of a file — and standing up an agent that sends one is
 * not something a driver can do.
 * ------------------------------------------------------------------ */

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

  // Dropped whole rather than half-stored — the rule `updateUsage` follows for a
  // reading it cannot read. A nameless command could never be typed anyway.
  const nameless = toCommands([
    { name: "", description: "no name", input: null },
    { name: "   ", description: "only spaces", input: null },
    { name: "ok", description: "fine", input: null },
  ] as never);
  check("a nameless command is dropped", nameless.commands.map((c) => c.name), ["ok"]);
  check("and counted", nameless.dropped, 2);

  // The agent's order is authoritative, so a duplicate keeps the first — and a
  // menu must never offer one name twice, since the second could not be reached.
  const dupes = toCommands([
    { name: "same", description: "first", input: null },
    { name: "same", description: "second", input: null },
  ] as never);
  check("a duplicate name keeps the first", dupes.commands.map((c) => c.description), ["first"]);
  // Counted, like every other cut. Skipping silently would make `dropped` say the
  // menu is complete when a row the agent published is missing from it.
  check("and the duplicate is counted, not swallowed", dupes.dropped, 1);

  /*
   * An over-long name is **refused**, not clipped, and it is the one field that
   * is. `clip` is a display truncator — it appends `…[truncated N bytes]` — which
   * is right for prose nobody types and wrong for a name, because a command is
   * invoked by *sending* `/<name>`. Clipping produced a row that could not be
   * used and, worse, dedup ran on the unclipped name while the stored one was
   * clipped, so two long names sharing a prefix became byte-identical with
   * `dropped` reporting none.
   */
  const longName = "n".repeat(70);
  const overlong = toCommands([
    { name: longName, description: "one", input: null },
    { name: `${longName}-and-more`, description: "two", input: null },
    { name: "ok", description: "fine", input: null },
  ] as never);
  check("a name too long to type is dropped rather than clipped", overlong.commands.map((c) => c.name), ["ok"]);
  check("and both of them are counted", overlong.dropped, 2);
  // The property the two above exist to protect, stated directly: whatever comes
  // out, no two rows may share a name, because the second could never be reached.
  const namesOf = (list: { commands: { name: string }[] }) => new Set(list.commands.map((c) => c.name)).size;
  check("no two commands ever share a name", [namesOf(overlong), namesOf(dupes)], [1, 1]);
  check("and every name that survives is sendable as typed", overlong.commands.every((c) => /^\S+$/.test(c.name)), true);

  const many = toCommands(
    Array.from({ length: 300 }, (_, index) => ({ name: `c${index}`, description: "x", input: null })) as never,
  );
  check("the list is capped", many.commands.length, 256);
  // Counted rather than swallowed, for the reason `truncateEvent`'s `agent_config`
  // arm gives: a picker missing rows silently offers the agent less than it has.
  check("and what was cut is reported, not swallowed", many.dropped, 44);

  const long = toCommands([{ name: "c", description: "d".repeat(4096), input: { hint: "h".repeat(500) } }] as never);
  // `<=` and not `===`: `clip` reserves room for its own note inside the budget,
  // so the ceiling is what is asserted rather than an exact length that would
  // change with the number of digits in the byte count.
  check("a runaway description is clipped to the ceiling", (long.commands[0]?.description.length ?? 0) <= 200, true);
  check("visibly, with this repo's own note", long.commands[0]?.description.endsWith("bytes]"), true);
  check("and so is a runaway hint", (long.commands[0]?.hint?.length ?? 0) <= 100, true);

  // The real thing, measured 2026-08-03 against claude 0.63.0: the longest hint
  // published on this machine is exactly 64 characters, which is why the cap is
  // above it rather than at it. A bound set to the largest thing you have seen is
  // a bound that clips the next one.
  const realHint = toCommands([
    { name: "effort", description: "Set effort level for model usage", input: { hint: "<low|medium|high|xhigh|max|ultracode|auto>" } },
  ] as never);
  check("a real hint is not clipped", realHint.commands[0]?.hint, "<low|medium|high|xhigh|max|ultracode|auto>");

  /*
   * The shapes an adapter can send that are not a well-formed list.
   *
   * The signature accepts `null | undefined` because `available_commands_update`
   * can arrive without the array, and every fixture above is well-formed — so the
   * arms that make the signature honest were the arms nothing reached.
   */
  check("nothing at all is an empty list", [toCommands(undefined), toCommands(null)], [
    { commands: [], dropped: 0 },
    { commands: [], dropped: 0 },
  ]);
  const malformed = toCommands([
    { name: "a", description: 42, input: { hint: "" } },
    { name: "b", description: null, input: {} },
  ] as never);
  // A description that is not a string collapses to empty rather than to the
  // literal `42`, and an empty hint is `null` — the same distinction the
  // well-formed case draws between "no hint" and "a hint of no characters".
  check("a description that is not a string becomes one", malformed.commands.map((c) => c.description), ["", ""]);
  check("and an empty hint is no hint", malformed.commands.map((c) => c.hint), [null, null]);
  check("neither is treated as a reason to drop the command", malformed.dropped, 0);

  /*
   * Whether a republished list is worth announcing.
   *
   * `usageWorthAnnouncing` one field over, and here for the same reason: the
   * *agent* decides the rate. claude republishes from `commands_changed`, which
   * fires as skills are discovered while it walks a subdirectory, so a byte-
   * identical list can arrive repeatedly inside one turn — and each bump costs a
   * snapshot, a row write and a frame per client here, plus a full refetch of the
   * list at every client over the relay.
   */
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
  // `dropped` counts too: the same visible list with more cut off behind it is a
  // different answer to "is this menu complete", and a client draws that.
  check("a list that is the same but now cut is announced", sameCommands({ commands: [], dropped: 0 }, { commands: [], dropped: 3 }), false);
  check("withdrawing everything is announced", sameCommands(listOf("a"), { commands: [], dropped: 0 }), false);
  check("and an empty list republished empty is not", sameCommands({ commands: [], dropped: 0 }, { commands: [], dropped: 0 }), true);
}

/* ------------------------------------------------------------------ *
 * the login pty, on both platforms
 *
 * `hostLoginArgs` is pure for exactly this reason — the two `script`s take their
 * command differently and a machine is only ever one of them, so without an
 * assertion the other form is only ever exercised by shipping it. Getting it
 * wrong does not fail loudly either: the BSD form on Linux writes a file called
 * `claude` and records nothing, which looks like a login that simply never
 * printed anything.
 *
 * The quoting half matters for a reason the container version did not have: the
 * command is now an absolute path resolved off PATH or out of
 * `CLAUDE_CODE_EXECUTABLE`, so it can contain a space or a quote, and on the
 * util-linux side it is concatenated into one string handed to `/bin/sh -c`.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * is this agent signed in
 *
 * `available` only ever meant "the adapter is on PATH", so a logged-out agent
 * reported `true` and the person found out at `502 agent_auth_required`, after a
 * worktree had already been made. `loggedIn` is the real probe, and every branch
 * of it is about **disagreeing with the exit code**: measured 2026-07-31,
 * `claude auth status` prints `{"loggedIn": false, …}` and exits **1**, so a probe
 * that read the status could not tell a logged-out agent from a crash, a missing
 * binary, or a future version failing for its own reasons. The JSON says which.
 *
 * `boolean | null` for the same reason `Liveness` has three answers: kimi has no
 * non-interactive way to say, and rendering "cannot tell" as "logged out" puts a
 * login wizard in front of somebody whose agent works.
 *
 * Drivable at all because of `LocalRuntimeOptions.exec` and because
 * `resolveLoginBinary` reads `CLAUDE_CODE_EXECUTABLE` first — neither is a test
 * hook invented here, the second is the documented override for *which* build the
 * adapter drives.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * the reap fence
 *
 * `reap` is the only thing in this daemon that signals a process it did not
 * start, off a number read out of a database, so every arm of it is a decision
 * about whether to SIGKILL a stranger. Three of the four are assertable with no
 * process at all; the fourth uses this driver's own pid, which is alive and
 * predates nothing, and asserts the *decision* rather than delivering a signal.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe reap fence\n");
{
  const runtime = new LocalRuntime();
  const afterBoot = Date.now();

  const noHandle = runtime.reap(null, afterBoot, true);
  check("no recorded agent is confirmed dead", [noHandle.killed, noHandle.confirmedDead], [false, true]);

  // A row from the multi-tenant daemon. The number is a process group inside a
  // PID namespace that no longer exists, so it names nothing here — and guessing
  // would mean signalling whatever holds it on this host.
  const foreign = runtime.reap(
    { kind: "container", containerId: "c1", pgid: 4242, containerStartedAt: afterBoot },
    afterBoot,
    true,
  );
  check("a handle from the other runtime is not signalled", foreign.killed, false);
  check("and is not confirmed dead either, which would make the row terminal", foreign.confirmedDead, false);

  // The `os.uptime()` fence: a session created before this boot names a pid from
  // a numbering that has since been reset.
  const old = runtime.reap({ kind: "local", pid: process.pid }, 0, true);
  check("a pid predating this boot is left alone", [old.killed, old.confirmedDead], [false, false]);

  // Reaping disabled is a decision, not an absence of one: the pid is live and
  // recent, and it is still not signalled.
  const off = runtime.reap({ kind: "local", pid: process.pid }, afterBoot, false);
  check("and so is every pid when reaping is off", [off.killed, off.confirmedDead], [false, false]);

  // A pid nothing holds. `isAlive` says `dead`, which is the one answer that
  // confirms — `unknown` (EPERM, i.e. recycled to another user) must not.
  const gone = runtime.reap({ kind: "local", pid: 0x7ffffffe }, afterBoot, true);
  check("a pid nothing holds is confirmed dead without a signal", [gone.killed, gone.confirmedDead], [false, true]);
}

process.stdout.write("\nis this agent signed in\n");
{
  const previous = process.env["CLAUDE_CODE_EXECUTABLE"];
  process.env["CLAUDE_CODE_EXECUTABLE"] = join(sandbox, "claude-stub");

  let probeEnv: NodeJS.ProcessEnv = {};
  /**
   * What the probe was actually spawned as, per agent.
   *
   * The stub used to take `(_command, _args, env)` and drop everything but the
   * environment, which left the two facts that decide *which binary answers*
   * asserted nowhere: the resolved path, and the stream its answer is read from.
   * Both are table-driven now, and a table is only worth something if something
   * checks it is read — reverting `resolveLoginBinary` to `agent === "claude"`
   * kept every driver green while codex sessions ran one build and its login
   * drove another.
   */
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
  // The asymmetry the Settings screen depends on: a pasted credential is believed
  // over "cannot tell", because we are the ones who cannot tell — but a *clean*
  // false is the agent itself saying no, and that wins.
  check("a pasted credential beats not knowing", await claudeSays(null, { CLAUDE_CODE_OAUTH_TOKEN: "sk" }), true);
  // The other half, and it is the one that was wrong: the probe runs *with* the
  // pasted token, so an agent that still says no has seen it and rejected it.
  // Answering `true` there said "signed in" over a token the CLI would refuse,
  // and the first session then died on `502 agent_auth_required`.
  check(
    "but a clean `false` is believed over one",
    await claudeSays('{"loggedIn": false}', { CLAUDE_CODE_OAUTH_TOKEN: "sk" }),
    false,
  );
  check("because the probe was handed that token", probeEnv["CLAUDE_CODE_OAUTH_TOKEN"], "sk");
  // And the daemon's own configuration is not handed to it, for the same reason
  // an agent never sees it: this spawns a program and captures its output.
  check("and not this daemon's own environment", probeEnv["REEMOAT_TOKEN"], undefined);

  /*
   * **The override reaches the spawn, for every agent that has one.**
   *
   * `AGENT_LOGIN[agent].executableEnv` is asserted as data below; this is the
   * half that says it is *read*. Written as `agent === "claude"` — which is what
   * it was — codex's override chose the binary sessions ran while the login and
   * the probe went on resolving the vendored copy, and no driver noticed.
   *
   * Asserted through `availability()` rather than by calling the private method,
   * so what is pinned is the path a login and a status probe actually take.
   */
  const codexStub = join(sandbox, "codex-stub");
  const priorCodexPath = process.env["CODEX_PATH"];
  process.env["CODEX_PATH"] = codexStub;
  spawned.clear();
  check("codex reads as signed in from its own wording", await probeAs("codex", "Logged in using ChatGPT"), true);
  check("and as signed out", await probeAs("codex", "Not logged in"), false);
  // The third answer, which must never render as logged out.
  check("and anything else is cannot-tell", await probeAs("codex", "Checking…"), null);
  const codexProbe = [...spawned.values()].find((entry) => entry.command === codexStub);
  check("CODEX_PATH chose the binary the probe ran", codexProbe?.command, codexStub);
  check("with the status arguments from the table", codexProbe?.args, ["login", "status"]);
  /*
   * **And its answer is read from the stream that CLI answers on.**
   *
   * Measured: `codex login status` writes to stderr and nothing to stdout, while
   * `claude auth status` writes JSON to stdout. Reading the wrong one costs no
   * error anywhere — the probe sees an empty string, answers "cannot tell", and a
   * signed-in codex reports `status unknown` for ever. `LoginStatusProbe.stream`
   * existed and nothing asserted it was forwarded.
   */
  check("and read from stderr, where codex answers", codexProbe?.stream, "stderr");
  const claudeProbe = [...spawned.values()].find((entry) => entry.command !== codexStub);
  check("while claude's is read from stdout", claudeProbe?.stream, "stdout");
  check("and CLAUDE_CODE_EXECUTABLE chose its binary", claudeProbe?.command, join(sandbox, "claude-stub"));
  if (priorCodexPath === undefined) delete process.env["CODEX_PATH"];
  else process.env["CODEX_PATH"] = priorCodexPath;

  if (previous === undefined) delete process.env["CLAUDE_CODE_EXECUTABLE"];
  else process.env["CLAUDE_CODE_EXECUTABLE"] = previous;
}

process.stdout.write("\nthe login pty, on both platforms\n");
{
  // BSD keeps argv boundaries, so a space in the path needs no quoting and must
  // not acquire any: the path arrives as one element either way.
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
  // The one that would be a command injection if the escape were wrong: a single
  // quote must close, escape and reopen, so there is no way back out of the
  // string. `'` becomes `'\''`.
  check(
    "and a path with a quote cannot reopen the string",
    hostLoginArgs("linux", "/Apps/it's/claude", [], "script").args[1],
    String.raw`'/Apps/it'\''s/claude'`,
  );
  // The resolved `script` is used, not the bare name: a login is a child of the
  // daemon that runs your agents, and PATH order is not this module's to trust.
  check("the resolved script path is what is spawned", hostLoginArgs("linux", "/usr/bin/claude", [], "/usr/bin/script").command, "/usr/bin/script");

  /*
   * Whether the pty gets a stdin pipe, which is the fix for the defect above it.
   *
   * **The login wizard did not run on macOS at all, for any agent, and it was the
   * pipe.** BSD `script` reads its *own* stdin's termios to copy onto the pty it
   * is allocating, so a pipe makes it exit 1 with `script: tcgetattr/ioctl:
   * Operation not supported on socket` before the agent is reached. `/dev/null`
   * succeeds — so the fix is available exactly where the flow never reads input,
   * which `AGENT_LOGIN[agent].interactiveStdin` is what says.
   *
   * Both platforms from a machine that is only one of them, which is why this is
   * pure. All four combinations, because three of them are the ones that must
   * *not* change: claude keeps its pipe everywhere (its flow waits on a paste
   * prompt), and Linux keeps its pipe for everyone — util-linux `script` works
   * with one today, an immediate stdin EOF is a plausible way for it to decide
   * the session is over, and Linux is where this deploys.
   */
  check("a device-code flow on BSD gets no stdin", loginStdio("darwin", false), "ignore");
  check("an interactive flow on BSD keeps its pipe", loginStdio("darwin", true), "pipe");
  check("and Linux keeps its pipe either way", [loginStdio("linux", false), loginStdio("linux", true)], [
    "pipe",
    "pipe",
  ]);
  check(
    "which agents that leaves without an input box, per platform",
    AGENT_IDS.filter((id) => loginStdio("darwin", AGENT_LOGIN[id].interactiveStdin) === "ignore"),
    // opencode joins them by having no sign-in flow at all rather than a
    // non-interactive one — a different reason for the same absence of a box.
    ["kimi", "codex", "opencode"],
  );
  check(
    "claude is the one it cannot rescue, because its flow reads a code back",
    AGENT_LOGIN.claude.interactiveStdin,
    true,
  );

  /*
   * Which agents can be signed *out*, which is not the same set as signed in.
   *
   * Measured 2026-08-08 from each CLI's own `--help`: claude has `auth logout`,
   * codex has `logout` ("Remove stored authentication credentials"), kimi has no
   * such verb at all. Nullable rather than a third row of arguments precisely so
   * the client draws no button for the one that cannot, instead of one that
   * always errors — and pinned by name rather than by count, because the count
   * is the part that looks right.
   */
  check(
    "the agents with a sign-out command",
    AGENT_IDS.filter((id) => AGENT_LOGIN[id].logoutArgs !== null).map((id) => [
      id,
      AGENT_LOGIN[id].logoutArgs,
    ]),
    [
      ["claude", ["auth", "logout"]],
      ["codex", ["logout"]],
    ],
  );
  /*
   * Two without, and for different reasons: kimi's CLI has no such verb, while
   * opencode's has one and is not offered it — a sign-out button beside no
   * sign-in button is a control whose whole meaning is the pair, and what it
   * would remove is a key this daemon did not put there.
   */
  check(
    "and the two without one",
    AGENT_IDS.filter((id) => AGENT_LOGIN[id].logoutArgs === null),
    ["kimi", "opencode"],
  );

  /*
   * ⚠ **How each agent answers "are you signed in", as a table — because one of
   * them may not answer at all and that is a decision rather than a gap.**
   *
   * opencode has a working status command: `auth list`, on stdout, with all four
   * of its states measured. It is deliberately **not used**. Measured
   * 2026-08-27 against an empty `XDG_DATA_HOME` and no provider variables of any
   * kind, opencode runs anyway — `session/new` publishes six OpenCode Zen models
   * and `session/prompt` completes with `end_turn`, because their free tier is
   * anonymous. So a probe reporting `false` would be manufacturing a "no" about
   * an agent that had just answered a prompt, and `AgentAskRuns.admit` refuses on
   * exactly that value: the model list would have been unreadable on any machine
   * without a key. Q7.99's mistake from the other side.
   *
   * Pinned as a table so that adding the probe back is a failure that arrives
   * next to the reason, rather than a plausible-looking improvement.
   */
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
      // Both halves deliberate: no command because `false` would be a lie, and a
      // file because presence still proves somebody configured a provider.
      "opencode: no command / .local/share/opencode/auth.json",
    ],
  );
  /*
   * And the property that made the choice: `admit` refuses on `=== false`, so an
   * agent that runs without credentials must never be able to produce one. With
   * no status command and no file, `readLoginState` can only answer `true` (a
   * pasted credential) or `null` (cannot tell) — never `false`.
   */
  check(
    "and the one that runs without credentials cannot report itself signed out",
    AGENT_LOGIN.opencode.status,
    null,
  );
}

/*
 * The login table, which is data and is therefore assertable without a binary.
 *
 * Every agent added since has widened `Record<AgentId, …>` and been caught by the
 * compiler, so nothing here is guarding against a *missing* entry. What it guards
 * is the entries whose value is a measurement — a flag that turns a headless login
 * into one nobody can complete, a variable name the CLI does not actually read —
 * because those are wrong silently and only on the machine that has no browser.
 */
process.stdout.write("\neach agent's login, as it is written down\n");
{
  check("every agent in the union has a login entry", AGENT_IDS.every((id) => AGENT_LOGIN[id] !== undefined), true);

  /*
   * **Codex's login must stay `--device-auth`.**
   *
   * Measured 2026-08-07, and the flag is present on the vendored 0.145.0 the
   * adapter actually spawns as well as the 0.146.1 on PATH: a bare `codex login`
   * binds a local
   * server on port 1455 and waits for a browser to come back to it, which on this
   * daemon is a wizard that can never finish — nobody is at that machine's browser
   * and the relay does not carry 1455. The CLI says so itself, printing "On a
   * remote or headless machine? Use `codex login --device-auth` instead."
   *
   * Asserted rather than trusted because dropping the flag leaves a login that
   * still *starts*, prints a URL nobody can open, and times out — indistinguishable
   * from a network problem.
   */
  check("codex logs in by device code, not by browser", AGENT_LOGIN.codex.args, ["login", "--device-auth"]);
  /*
   * ⚠ **And one agent has no flow at all, which is a fourth state rather than an
   * empty argument list.** Measured on opencode 1.18.23 against an empty
   * `XDG_DATA_HOME` with no provider variables: `session/new` succeeds and
   * `session/prompt` completes, because its own gateway has an anonymous free
   * tier. `null` is what makes `loginBlockedReason` answer `no_flow` — the one
   * reason that is not a limitation — instead of the screen apologising for a
   * wizard that should not exist.
   */
  check(
    "which agents have a sign-in to run at all",
    AGENT_IDS.filter(hasLoginFlow),
    ["claude", "kimi", "codex"],
  );
  check(
    "and the one that does not is refused before anything is spawned",
    loginBlockedReason("linux", false, true, true, false),
    "no_flow",
  );
  /*
   * Ordered first on purpose: a host with no `script` and an agent with no flow
   * must hear the second, not the first. Otherwise a machine that cannot run a
   * wizard is told so about an agent that never needed one.
   */
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

  /*
   * The name of the variable a pasted credential is stored under, which is the one
   * field on this table that has been wrong before — kimi's entry and its own
   * `authHint` still disagree, in writing, at `resolveAgent`.
   *
   * Measured for codex rather than inferred: `CODEX_API_KEY` is sent (the API
   * answers `invalid_api_key`, i.e. it saw a key and refused it) while
   * `OPENAI_API_KEY` is not (the API answers "Missing bearer", i.e. nothing was
   * sent). The obvious name is the wrong one, which is exactly why this is pinned.
   */
  check("codex's pasted credential is CODEX_API_KEY", credentialEnvNames("codex"), ["CODEX_API_KEY"]);
  check("and OPENAI_API_KEY is not offered, because codex does not read it", credentialEnvNames("codex").includes("OPENAI_API_KEY"), false);

  /*
   * Which agents have a variable naming their binary, and it is **two**.
   *
   * This asserted "only claude" and was wrong: `CODEX_PATH` is read by codex-acp's
   * own `startAcpServer()` and chooses the CLI a *session* runs. Missing it meant
   * the login and the signed-in probe resolved the vendored copy while sessions ran
   * whatever `CODEX_PATH` named — a login that appears to work and changes nothing,
   * which is the failure the vendored-copy preference exists to prevent.
   *
   * Pinned by name rather than by count, because the count was the part that
   * looked right.
   */
  check(
    "the agents whose binary an env var names",
    AGENT_IDS.filter((id) => AGENT_LOGIN[id].executableEnv !== null).map((id) => [id, AGENT_LOGIN[id].executableEnv]),
    [
      ["claude", "CLAUDE_CODE_EXECUTABLE"],
      ["codex", "CODEX_PATH"],
    ],
  );
  // That neither survives only by accident is asserted where `agentEnv` is, below.
}

/*
 * Reading a CLI's own answer to "am I signed in", in both formats.
 *
 * Unreachable from a machine with neither CLI installed, which is what makes it
 * worth extracting and asserting: every branch is a way to be wrong quietly, and
 * the one that matters most is the third answer — anything unrecognised has to be
 * "cannot tell", never "logged out", or somebody whose agent works perfectly is
 * shown a wizard.
 */
process.stdout.write("\nwhat a login status command said\n");
{
  const claude = AGENT_LOGIN.claude.status;
  const codex = AGENT_LOGIN.codex.status;
  // Narrowed rather than cast, which also states the shapes: the two CLIs that can
  // answer answer in different formats, and reading one as the other is silent.
  if (claude === null || claude.reads !== "json") throw new Error("claude's status probe is supposed to read JSON");
  if (codex === null || codex.reads !== "text") throw new Error("codex's status probe is supposed to read prose");

  check("claude's JSON says signed in", readLoginAnswer(claude, `{"loggedIn": true}`), true);
  check("and says signed out", readLoginAnswer(claude, `{"loggedIn": false}`), false);
  // Output that is not JSON is a future version or an error on stdout. Neither is
  // "logged out", and reading it as one is what puts a login wizard in the way.
  check("and anything that is not JSON is cannot-tell", readLoginAnswer(claude, "command not found"), null);
  check("including JSON without the field", readLoginAnswer(claude, `{"account": "x"}`), null);

  // Every wording the codex binary carries, so a login by any of the four methods
  // reads as signed in. `Not logged in` is the only negative it prints.
  for (const line of [
    "Logged in using ChatGPT",
    "Logged in using an API key - sk-…",
    "Logged in using personal access token",
    "Logged in using Amazon Bedrock API key",
  ]) {
    check(`codex's "${line.slice(0, 24)}…" reads as signed in`, readLoginAnswer(codex, line), true);
  }
  check("codex's Not logged in reads as signed out", readLoginAnswer(codex, "Not logged in"), false);
  /*
   * **Which stream the answer is on**, which was assumed and was wrong.
   *
   * Measured: `codex login status` prints its answer on stderr and writes nothing
   * to stdout, while `claude auth status` prints JSON on stdout. Reading the wrong
   * one costs no error anywhere — the probe simply sees an empty string, answers
   * "cannot tell", and a signed-in codex reports `status unknown` in `GET /agents`
   * for ever. Pinned here because that is invisible until somebody looks at the
   * Settings screen and disbelieves it.
   */
  check("codex answers on stderr and claude on stdout", [codex.stream, claude.stream], ["stderr", "stdout"]);
  /*
   * The substring trap, which is why `signedOut` is tested first.
   *
   * "Logged in" is a substring of "Not logged in", so a pattern pair applied in the
   * other order — or either one loosened to drop its anchor — reports a logged-out
   * agent as signed in. That failure is invisible until somebody's first session
   * answers `502 agent_auth_required`.
   */
  check("and is not read as signed in by the substring", codex.signedIn.test("Not logged in"), false);
  // A CLI that grew a banner still has its answer read: the patterns are per-line.
  check("a preamble above the answer does not hide it", readLoginAnswer(codex, "codex 0.146.1\nNot logged in"), false);
  check("anything else is cannot-tell", readLoginAnswer(codex, "Checking…"), null);
}

/*
 * What a spawned agent inherits, which is hygiene rather than a fence — the agent
 * runs as this uid and can read the env file — but three of the four things it
 * prevents end up somewhere permanent.
 */
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
  /*
   * Both halves matter and they are opposite mistakes.
   *
   * A daemon started from inside a codex session inherits that session's
   * variables, and two of them are worse than untidy on the way down:
   * `CODEX_THREAD_ID` names the parent's conversation, and
   * `CODEX_SANDBOX_NETWORK_DISABLED=1` silently takes the network away from a
   * fresh agent nobody confined — which reads as "the model cannot fetch anything
   * today" rather than as configuration.
   */
  check("a parent codex session's thread does not reach the child", env["CODEX_THREAD_ID"], undefined);
  check("nor does its sandbox, which would confine an agent nobody confined", env["CODEX_SANDBOX_NETWORK_DISABLED"], undefined);
  check("nor a parent claude session", env["CLAUDE_CODE_SESSION_ID"], undefined);
  check("nor this daemon's own configuration", env["REEMOAT_TOKEN"], undefined);
  /*
   * The other direction: these three are deliberate overrides, and an operator who
   * set one meant it. Stripping them by a `CODEX_`/`CLAUDE_` prefix sweep would
   * point codex at the wrong credentials, codex at the wrong binary, and claude at
   * the wrong binary — the last two silently, since the wrong binary still runs.
   *
   * `CODEX_PATH` and `CODEX_HOME` are the pair most easily confused: one names the
   * binary and one names the credentials, and only the first is
   * `AGENT_LOGIN.codex.executableEnv`.
   */
  check("but CODEX_HOME survives, because it is an override and not a session", env["CODEX_HOME"], "/somewhere/else");
  check("and CODEX_PATH survives, which is the binary rather than the credentials", env["CODEX_PATH"], "/opt/codex");
  check("and so does CLAUDE_CODE_EXECUTABLE", env["CLAUDE_CODE_EXECUTABLE"], "/opt/claude");

  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
}

/*
 * Where each adapter is spawned from.
 *
 * Reads disk, so it is conditional on the adapter being installed — but it is the
 * one assertion that catches an adapter renamed, moved, or dropped from
 * `package.json`, which otherwise surfaces as `AgentUnavailableError` on somebody's
 * first session.
 */
process.stdout.write("\nhow each agent is launched\n");
{
  for (const id of AGENT_IDS) {
    let config: AgentLaunchConfig | null = null;
    try {
      config = resolveAgent(id);
    } catch {
      // Not installed here. kimi is resolved from PATH and is legitimately absent
      // on a machine that has never had it; the two vendored adapters are not.
    }
    if (id === "kimi") {
      /*
       * **A skip, never a fallback.** This read `config?.args ?? ["acp"]`, which
       * supplied the expected value whenever kimi was absent — so on CI and on any
       * machine without it, the check passed by construction and asserted nothing.
       * That is the outcome `pincheck`'s header calls the only one worse than no
       * check at all, reintroduced one file over.
       */
      if (config === null) {
        process.stdout.write("  skip  kimi is not installed here, so its launch shape is unasserted\n");
      } else {
        check("kimi is launched as an ACP subcommand of the CLI itself", config.args, ["acp"]);
      }
      continue;
    }
    if (id === "opencode") {
      /*
       * **Vendored, so no skip** — `opencode-ai` is a dependency of this repo and
       * an absent one is a real failure, unlike kimi above. What it does not have
       * is an adapter: `opencode acp` is a subcommand of the same binary a login
       * drives, which is why the argument list is kimi's shape and the resolution
       * is claude's.
       */
      check("opencode is launched as an ACP subcommand of the CLI itself", config?.args, ["acp"]);
      check("and opencode says which binary it is", (config?.displayName ?? "").length > 0, true);
      /*
       * ⚠ **The property vendoring buys, and the one this agent alone can be held
       * to.** For claude and codex the program a session runs and the program a
       * login drives are honestly different files — an adapter and the CLI under
       * it — so nothing can compare them. Here they are one file, and resolving
       * them apart is exactly the "a login that appears to work and changes
       * nothing" failure `vendoredCli` exists to prevent.
       */
      check(
        "and the binary a session runs is the one a login drives",
        config?.command ?? "(unresolved)",
        vendoredOpencode() ?? "(unresolved)",
      );
      continue;
    }
    // Both vendored adapters speak ACP on stdio with no arguments at all. An
    // argument appearing here would mean the adapter changed how it is started.
    check(`${id}'s adapter is resolvable and takes no arguments`, config?.args, []);
    check(`and ${id} says which binary it is`, (config?.displayName ?? "").length > 0, true);
  }
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
  // The half that was missing. A run registry exists in both cases, so this is
  // false only if the route asks the runtime.
  check("a host without one says so too, rather than 503ing on tap", await listing(false), false);

  /*
   * ⚠ **And the per-agent half rides `GET /agents` too, which is the cheap route
   * every screen that *picks* an agent reads.** It did not, and the cost was a
   * tile that could only say `available` and `loggedIn` — so an agent with no
   * sign-in, whose `loggedIn` is permanently `null` because there is nothing to
   * probe, was drawn as a probe that failed. Nothing in this file had ever fetched
   * this route, so the field's arrival on the wire is asserted here rather than
   * inferred from the handler.
   *
   * Both routes are compared to each other rather than to a literal: they are one
   * object built in one place (`loginSupportOf`), and what must hold is that they
   * cannot come to disagree.
   */
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

  /*
   * ⚠ **And a harness a plugin added rides both of them, which is the whole of
   * what "as though this product had shipped it" means on the wire.** Driven end
   * to end rather than inferred from `Contributions`, because everything between
   * the registry and the response is where a field is quietly dropped: the runtime
   * has to be handed the catalogue, `availability()` has to iterate it,
   * `loginSupportOf` has to answer for a harness with no `AGENT_LOGIN` row, and
   * `credentialSlots` has to find the manifest's `envNames`.
   *
   * ⚠ **`no_flow` is the assertion with teeth.** With no `login` object at all,
   * `agentStance(true, null, undefined)` answers `unchecked`, whose badge reads
   * *cannot check* — a sentence about a probe that failed, drawn permanently over
   * an agent that runs perfectly, on every machine in the fleet.
   */
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
            /*
             * ⚠ **`standalone` is declared here on purpose and must not be
             * removed.** The field is gone from `HarnessContribution`, and what
             * "gone" has to mean for a plugin somebody already published is that a
             * manifest still carrying it installs unchanged and the key is simply
             * not read. Take it out of this fixture and the assertion below stops
             * saying anything.
             */
            /*
             * ⚠ **`node` rather than `gemini`, and the command is the hermetic part
             * of this fixture.** `contributedLaunchConfig` resolves a manifest's
             * command with `findOnPath` and *throws* when it is not there, and
             * `availability()` answers that throw with `displayName: contributed.name`
             * — the label. So a fixture naming a real third-party program asserts one
             * thing on a machine that happens to have it installed and the opposite on
             * one that does not: this block was green on a laptop with the Gemini CLI
             * on PATH and red on `ubuntu-latest`, on "and its log line is not its
             * label", for two runs. `node` is the one program this driver cannot be
             * running without, so the resolved arm is reachable everywhere. The
             * unresolvable arm is pinned on its own, below, against a command nothing
             * can have.
             */
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
    /*
     * ⚠ **And it carries no claim about being a whole agent, because a plugin adds
     * a harness and never an agent.** `standalone` rode this row for a release and
     * is gone from the manifest, the catalogue and the wire together: the fixture's
     * own manifest still declares it, so what is asserted is that a manifest
     * carrying the key installs unchanged and the key is simply not read — which is
     * the whole of what "removed" has to mean for a plugin already published.
     */
    check(
      "and says nothing about being one on its own",
      added === null ? "absent" : "standalone" in added,
      false,
    );
    /*
     * ⚠ **The label and the display name are two different strings, and this is
     * the assertion that keeps them apart.** `displayName` is the log line and
     * carries the program; a client that drew it on a tile would put the binary's
     * name there, which is the rule `agentCard.ts` sweeps its own four for.
     */
    check(
      "and its log line is not its label",
      added === null ? "absent" : [added.displayName, added.label ?? null],
      ["Gemini (node)", "Gemini"],
    );
    /*
     * ⚠ **The other arm, and it is the one that used to be reached by accident.**
     * A manifest names a program on PATH and nothing installs it, so "the plugin is
     * here and its binary is not" is the ordinary state, not the exotic one — and
     * `availability()` has a deliberate answer for it: still call the harness what
     * its manifest calls it, because falling back to the bare id would put
     * `acme:gemini` in the settings list beside `Kimi Code CLI`.
     *
     * Asserted here rather than left to whichever machine happens to lack the
     * binary. `displayName` collapsing onto the label is *correct* in this arm —
     * there is no program to name — which is exactly why the assertion above cannot
     * be allowed to reach it: the two arms want opposite answers, so a fixture that
     * does not decide which one it is in asserts nothing on either.
     */
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
    /*
     * ⚠ **And switching the plugin off takes both off the wire in the same tick.**
     * A tile drawn for a harness `POST /sessions` would refuse is the state this
     * has to make unreachable; what a switched-off plugin keeps is its *position*,
     * in `agent_strip`, which is never validated against anything.
     */
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
    /*
     * ⚠ **And the refusal for it is a `503` naming the switch, never the `400`
     * that tells an operator their own request is wrong** — it was correct
     * yesterday, and sending its author looking for a bug in their own code is the
     * failure a two-valued answer produces here.
     */
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
  /*
   * ⚠ **`no_flow` outranks the daemon's own missing login store, and it did not.**
   * The handler read `logins === null ? "no_script" : support.blocked`, which
   * replaced the one reason that is not a limitation with an apology about the
   * host — `loginBlockedReason`'s ordering, inverted one layer up. Driven against
   * an app built without `logins` at all, which is the state that triggered it.
   */
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
      // Nobody may sign in — there is nowhere to record a run — and `supported` is
      // `blocked === null` and nothing else, so every row must carry a reason.
      bare.agents.every((one) => one.login?.supported === false),
      bare.agents.every((one) => (one.login?.blocked ?? null) !== null),
    ],
    ["no_flow", true, true],
  );
  /*
   * The *other* three reasons are the host's and this machine is one host, so
   * which of them a given agent gets is not assertable here — a BSD answers
   * `interactive_pty` for claude where Linux answers `no_script`. The ordering
   * itself is pinned on the pure function instead, over every platform, beside
   * `AGENT_LOGIN`.
   */
}

process.stdout.write("\ntwo tabs, and the shutdown that follows\n");
{
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

  /** As above, but counted: what matters here is how many were ever spawned. */
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

  /*
   * Two concurrent starts, which is not a rare race: two tabs on Settings does
   * it, and React's development double-mount does it every time.
   *
   * `start` has two awaits before it records anything, so without the `starting`
   * map both callers got past the cancel (the map is still empty), both spawned,
   * and the second `set` won. The loser was then unreachable — not in `byAgent`,
   * so `sweep`, `cancel` and `shutdown` all iterate straight past it — and its
   * pty sat there until the daemon exited. Serialising is the
   * answer rather than refusing the second call, because the supersede above is
   * deliberate and has to keep working.
   */
  const [first, second] = await Promise.all([logins.start("claude"), logins.start("claude")]);
  await settle();
  check("two concurrent starts leave exactly one run reachable", [
    logins.read(first?.loginId ?? "", 0) !== null,
    logins.read(second?.loginId ?? "", 0) !== null,
  ], [false, true]);
  check("and the loser was disposed rather than orphaned", runtime.stopped[0], ["stdin"]);
  check("while the survivor is untouched", runtime.stopped[1], []);

  /*
   * Shutdown drains twice around the in-flight starts, and both halves are needed.
   * The flag makes a start that has not spawned yet refuse; awaiting `starting`
   * catches one that already has, because `doStart` re-checks the flag after its
   * awaits and disposes rather than recording. Draining the map alone left
   * whichever of those landed a microsecond later running past `process.exit(0)`.
   */
  await logins.shutdown();
  check("shutdown stops the live run", runtime.stopped[1], ["stdin"]);
  check("and a start afterwards refuses", await logins.start("claude"), null);
  check("without spawning anything to leave behind", runtime.stopped.length, 2);
}
