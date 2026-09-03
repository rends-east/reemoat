import type { Readable, Writable } from "node:stream";

import type { AgentId, AgentLaunchConfig } from "../acp/agents.js";
import type { SystemId } from "../acp/systems.js";
import type { AgentHandle } from "../events.js";
import type { GitExec } from "../git.js";

/**
 * Where an agent runs.
 *
 * `src/acp/client.ts` is where the seam had to go, and the reason is structural:
 * ACP is JSON-RPC over a child process's stdio, so everything below the spawn is
 * written against three pipes and a way to signal the thing on the other end.
 * That is exactly this interface, and it is why `AcpClient` needed no changes
 * below its first twenty lines.
 *
 * **There is one implementation, and the interface stays anyway.** That is a
 * decision rather than leftovers. Two things rest on it: the offline drivers
 * substitute their own runtimes — a pair of `PassThrough` pipes standing in for
 * an agent is how `daemoncheck` drives a real `Session` with no agent installed —
 * and it is the seam a *confining* runtime would fill if one is ever wanted
 * again. `clientFileIo`, `login`, `git` and `launch` are exactly the four places
 * a sandbox has to answer differently, which is why they are still members and
 * not inlined. Reserved, in the same voice as the relay's `reemoat-enc: none`.
 *
 * What is **not** kept is a `kind` discriminant. It had no reader anywhere, and
 * an unread discriminant on the one interface that survived a runtime deletion is
 * how an `if (kind === "container")` branch against nothing gets written.
 */

/**
 * Whether an agent is still running — with `"unknown"` as a first-class answer.
 *
 * This was a boolean, and `false` therefore meant both "I watched it die" and "I
 * could not ask". Those collapsed into one for a container — a missing `docker`,
 * an unreachable socket, a query timeout — and the caller wrote
 * `agentConfirmedDead: true` for an agent that was still running and holding a
 * worktree.
 *
 * Kept with the container gone, because the third answer is not a Docker fact:
 * `process.kill(pid, 0)` throws `EPERM` as readily as `ESRCH`, and they mean
 * opposite things — `ESRCH` is "gone", `EPERM` is "there, and not yours to
 * signal". Reporting the second as dead is exactly the mistake this type was
 * introduced to make unsayable, and it also makes the row terminal, so the next
 * boot's reaper skips it.
 */
export type Liveness = "alive" | "dead" | "unknown";

/**
 * Re-exported, not defined here: `AgentHandle` is persisted, so it belongs to
 * the vocabulary in `events.ts` that the store and the wire already share.
 */
export type { AgentHandle } from "../events.js";

/**
 * A running agent, in the only terms `AcpClient` needs.
 *
 * Modelled on the parts of `ChildProcess` that were actually used, and no more.
 * The listener methods return an unsubscribe rather than exposing `off`, so the
 * handshake's cleanup cannot forget which listener it added.
 */
export interface AgentProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** `null` until the runtime knows it — a container reports it after a probe. */
  readonly handle: AgentHandle | null;

  /** Failed to start at all. Returns an unsubscribe. */
  onceStartError(listener: (error: Error) => void): () => void;
  /** Exited. Returns an unsubscribe. */
  onceExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;

  readonly hasExited: boolean;
  /** Resolves true if it exited within the budget, false if it is still there. */
  waitForExit(timeoutMs: number): Promise<boolean>;

  /**
   * Closes stdin — the graceful path. Both adapters treat EOF as "connection
   * over, exit", and it is the first rung of the shutdown ladder.
   */
  endStdin(): void;

  /**
   * Signals the agent's whole **process group**, never the process alone.
   *
   * Load-bearing and verified, not theoretical: `claude-agent-acp` runs the
   * `claude` CLI as its own child and cleans up only via `process.on("exit")`,
   * which does not run under SIGKILL. Signalling the one process we know about
   * strands a grandchild holding the session's cwd.
   *
   * Never throws. Every caller is a teardown path that must not fail louder than
   * the thing it is tearing down.
   */
  kill(signal: NodeJS.Signals): Promise<void>;
}

/**
 * A login flow, which is an {@link AgentProcess} that may have no stdin.
 *
 * Narrower than widening `AgentProcess.stdin` to `Writable | null`, and the
 * asymmetry is real rather than cosmetic: a *session* always has stdin, because
 * stdin is where JSON-RPC goes and an agent without it is not an agent. A login
 * is the one spawn where "no stdin" is a correct configuration — `loginStdio`
 * hands `/dev/null` to a device-code flow on BSD, which is the whole fix for the
 * macOS pty defect — so this is the only type that has to admit it. Widening the
 * common one would make every session-side `stdin.write` a null check about a
 * case that cannot happen.
 */
export interface LoginProcess extends Omit<AgentProcess, "stdin"> {
  /** `null` when this flow never reads input; see `loginStdio`. */
  readonly stdin: Writable | null;
}

/** Whether this host can drive one agent's own login, and what that flow needs. */
export interface AgentLoginSupport {
  /**
   * Whether tapping the button would work.
   *
   * **Per agent, and the daemon-wide answer was not enough.**
   * `SessionRuntime.loginSupported` asks only whether `script` is on PATH, so an
   * agent whose *CLI* does not resolve — a perfectly ordinary state, since the
   * adapter and the CLI are different binaries and claude's ships inside an SDK
   * package with no `bin` entry — got an enabled button and a `503
   * login_unsupported` after it was tapped, with the reason only in the daemon's
   * own log.
   */
  supported: boolean;
  /**
   * Why not, when not — so the client can say something other than "unavailable".
   *
   * `supported` is `blocked === null` and nothing else, so the two cannot come to
   * disagree. The reason is on the wire because each one has a *different remedy*
   * and the client is where a remedy is offered: `no_script` is about the host,
   * `no_cli` is about installing the agent, and `interactive_pty` is the one with
   * a way forward on the same screen — paste a token instead. See
   * `loginBlockedReason`.
   */
  blocked: "no_flow" | "no_script" | "no_cli" | "interactive_pty" | null;
  /** Whether to draw an input box. See `AGENT_LOGIN[agent].interactiveStdin`. */
  needsInput: boolean;
  /** Whether this agent's CLI has a sign-out verb at all. kimi does not. */
  canSignOut: boolean;
}

/**
 * The last time this harness refused to open a session, and what it said.
 *
 * ⚠ **An observation, never a verdict — and deliberately not {@link
 * AgentAvailability.loggedIn}.** ACP's `auth_required` is a JSON-RPC
 * implementation-defined code answered by the *adapter*, and this repository has
 * already measured the two disagreeing: a pasted `CODEX_API_KEY` that the model's
 * API accepted while `codex-acp` went on refusing `session/new` (`AGENT_LOGIN.codex`,
 * Q7.65). So this says "it would not start, at this time, configured this way" and
 * claims nothing about a credential. Absent means nothing has been observed — never
 * that a start would succeed.
 *
 * ⚠ **`routed` is what stops one refusal condemning a pairing it never tested.**
 * A harness reached through `providers/set` runs on a *system's* saved key, so a
 * bare start refusing says nothing about a routed one — a signed-out Claude Code
 * paired with OpenRouter is the case this repository documents as working, and a
 * fence that read a bare refusal as a fact about every start would have broken it.
 * `applySystem` answers this, because it is the one place that knows a pairing is
 * routed rather than native.
 */
export interface StartRefusal {
  /** `Date.now()` at the refusal. */
  at: number;
  /** Whether the refused start had been routed onto somebody else's system. */
  routed: boolean;
  /** What the agent's own refusal said, bounded. See `MAX_START_REFUSAL_CHARS`. */
  message: string;
}

export interface AgentAvailability {
  id: AgentId;
  displayName: string;
  available: boolean;
  /** What to do about it when `available` is false. */
  hint: string | null;
  /**
   * Whether the agent is authenticated — with `null` for "could not tell".
   *
   * Three answers rather than two, for the same reason {@link Liveness} has
   * three. `available` only ever meant "the binary is on PATH", so an installed
   * but logged-out agent reported `true` and the person found out at
   * `502 agent_auth_required`, after a container start and a worktree. Only some
   * agents have a non-interactive way to answer this (claude and codex do, kimi
   * does not), and reporting an unanswerable question as `false` would put a "log
   * in" prompt in front of somebody who already had.
   *
   * ⚠ **The negative this field refuses to manufacture lives next door.** A
   * harness with no status probe — every one a plugin added, and opencode —
   * can never answer `false` here however often it refuses to start, because
   * that would be this daemon inventing a credential fact out of an adapter's
   * error code. What it can carry is {@link AgentAvailability.lastStartRefusal},
   * which is a different question with a different reader: `admit` weighs this
   * one and never that one, so a harness that will not start is still spawned
   * for a capability read and can still clear its own record by working.
   */
  loggedIn: boolean | null;
  /**
   * The last refusal to open a session, or `null` where none is remembered.
   *
   * Held in memory for `START_REFUSAL_TTL_MS` and expired on read, so an entry
   * on the wire is always live and no client ever learns the budget.
   */
  lastStartRefusal: StartRefusal | null;
  /**
   * What a *screen* calls this harness, or absent for one this repository ships.
   *
   * ⚠ **Deliberately not {@link displayName}, and collapsing the two would ship
   * the defect the client's own rule is written against.** That field is the log
   * line and the settings-list row title, where naming the program is the point —
   * it is literally `Claude (claude-agent-acp)` and `Kimi Code CLI` — while
   * `agentCard.ts` requires a label that names neither a package nor a CLI,
   * because it is drawn on a 96px tile. A built-in leaves this absent and the
   * client uses its own table; a contributed harness carries the manifest's name.
   */
  label?: string;
  /*
   * `standalone` used to ride here and it is gone: a plugin adds a harness, never
   * an agent. A contributed harness is opencode's shape — offered everywhere a
   * harness is named, and needing a model before it is a whole answer. See
   * `HarnessContribution` for the argument.
   */
  /**
   * The plugin that added this harness, or absent for one this repository ships.
   *
   * Answers three questions at once, which is why it is one field rather than a
   * boolean: the subline under a tile that is native to no system, the sentence
   * saying where to go to remove it, and what a refusal names when the plugin is
   * switched off.
   */
  contributedBy?: { pluginId: string; pluginName: string };
}

/**
 * The decision to reap an orphan, taken synchronously.
 *
 * `SessionRegistry.restore()` is synchronous and has to stay that way, so this
 * returns the *decision* now and lets the runtime perform the kill afterwards
 * without being awaited. That is not a new compromise: the existing reaper
 * already reports `confirmedDead: false` and says outright that it asked without
 * watching it die.
 */
export interface ReapDecision {
  killed: boolean;
  confirmedDead: boolean;
  detail: string | null;
}

/** Which build of an agent's CLI a launch resolved to, and where it came from. */
export interface AgentCliChoice {
  path: string;
  /** `null` where the binary runs but would not say which build it is. */
  version: string | null;
  /**
   * ⚠ **Two members and not a boolean, and it was three.** A reader has to be able
   * to tell a machine running the copy `deploy/agents.sh` keeps current — or one of
   * its own, on PATH — from one an operator pointed by hand, because only the
   * second explains why a daily refresh changed nothing there. `vendored` was the
   * third, the copy this repository used to ship under `node_modules`; it went with
   * the copies (Q4.114), and a client that still knows the word draws the plain
   * line for it.
   */
  source: "override" | "path";
}

export interface SessionRuntime {
  /**
   * Whether the daemon will perform file IO on the agent's behalf.
   *
   * Declared to the agent at `initialize` as ACP's `fs.readTextFile` /
   * `fs.writeTextFile` client capabilities. It is a *capability of the daemon*,
   * not a preference: `session.ts` implements those two reverse-RPCs by calling
   * `readFile`/`writeFile` in this process, so wherever the agent is confined,
   * they are not. A runtime that sandboxes the agent must decline them or it has
   * handed out a write primitive that runs outside the sandbox.
   *
   * `LocalRuntime` grants them, and that costs nothing here because there is no
   * sandbox to run outside of — the agent could open the file itself. The gate
   * stays because it is the seam a confining runtime would use, and because
   * `LaunchOptions.fileIo` being **required** is what makes deleting the argument
   * a type error rather than a silent grant.
   */
  readonly clientFileIo: boolean;

  /**
   * Whether this runtime can drive an agent's own interactive login.
   *
   * Reported so a client never draws a wizard that answers 503 when it is tapped.
   * It is not a policy: {@link login} needs a pty, a pty needs `script`, and
   * `script` is not on every host. Answering the question before the button is
   * drawn is the difference between "log in from your phone" and "this button
   * does nothing".
   *
   * {@link login} still returns `null` for the race where `script` goes away
   * after startup, which is what keeps returning `null` a decision rather than a
   * gap somebody forgot to check.
   */
  readonly loginSupported: boolean;

  /**
   * How this agent would be launched, without launching it.
   *
   * Synchronous, because `registry.create` uses it to fail fast: a missing agent
   * should be a clean 4xx before a worktree exists, not a baffling error from
   * inside a half-started session.
   */
  describe(agent: AgentId): AgentLaunchConfig;

  /**
   * Which build of this agent's CLI a launch would run, or `null`.
   *
   * ⚠ **A different question from {@link describe}, and the two answer about
   * different programs.** For claude and codex `describe` names the *adapter*;
   * what publishes the model list is a CLI underneath it, chosen separately. So a
   * daemon reporting only the launch config says nothing about the thing whose
   * list is on screen.
   *
   * Reported rather than acted on. The model list a picker draws is exactly as
   * fresh as this build — a fact with no symptom except a model somebody has read
   * about being absent, which is why the build is named beside the list. `null`
   * for a harness with no binary to name.
   *
   * Asynchronous because deciding it may cost a `--version`; every caller that
   * needs the *path* is already async for the same reason.
   */
  agentCli(agent: AgentId): Promise<AgentCliChoice | null>;

  /** What `GET /agents` reports. May do real work, unlike `describe`. */
  availability(): Promise<AgentAvailability[]>;

  /**
   * Drop any cached availability, because something that would change it has
   * happened — a credential saved, a login finished.
   *
   * **Required, not optional.** While two runtimes existed the `?` encoded a real
   * decision — one of them did not cache and had nothing to forget. With one it
   * encodes nothing, and every call site was `?.()`, which reads as "this might
   * not do anything" at exactly the places where it must.
   *
   * Load-bearing rather than tidy: the login probe is cached with a short TTL, so
   * without this somebody who has just finished signing in keeps being told they
   * are signed out until it expires — which is the bug this method exists to have
   * already fixed once.
   */
  forgetAvailability(): void;

  /**
   * Remember that this harness refused to open a session, and what it said.
   *
   * ⚠ **Written from exactly two places — `Session.start` and
   * `Session.openResumed`, on ACP's typed `auth_required` — and from nowhere
   * else.** The event pump's `errorKind: "authentication_failed"` is *not* one of
   * them, and that is a measurement rather than an oversight: Q7.99 found a
   * session idle 5h36m reporting it on its first prompt while the token on disk
   * was valid for another 1.4 hours, and a fresh agent worked four minutes later.
   * What had gone stale there was the process. `onAgentUnusable` says so at the
   * one site that could have written this and does not.
   *
   * **Required rather than optional**, for the reason {@link forgetAvailability}
   * gives about its own missing `?`: an `?.()` at these call sites would read as
   * "this might not do anything" at exactly the places where it must.
   */
  noteStartRefusal(agent: AgentId, message: string, routed: boolean): void;

  /**
   * Drop what {@link noteStartRefusal} remembered — for one harness, or for all.
   *
   * **Separate from {@link forgetAvailability}, and the two must not be folded
   * together.** Three of that method's five call sites are sign-out-ward — a
   * credential deleted, a sign-out, a login cancelled — and none of them is
   * evidence that a harness which would not start now would. Deleting a key must
   * not erase the record of the refusal that key was pasted against.
   */
  forgetStartRefusal(agent?: AgentId): void;

  /**
   * Start one.
   *
   * `extra` is merged over the agent's environment last, after the pasted
   * credentials, and carries **only what this daemon's own tables produced** —
   * today that is the model a routed system is pinned to
   * (`routedModelEnv` in `acp/systems.ts`). No caller may pass a variable of its
   * own choosing and no route accepts one: a request names a system id, and the
   * table is what turns that into names and values. That is the same property
   * `AGENT_LOGIN` claims about the program it runs.
   *
   * ⚠ **Never a secret.** An agent runs as this uid and can print its own
   * environment into a transcript that is written to the log and rendered in a
   * browser — the accident `agentEnv`'s strip exists for. A system's credential
   * travels over stdio in `providers/set`'s headers instead; only non-secret
   * routing comes through here.
   *
   * ⚠ **That buys one hop rather than secrecy, and the difference is measured.**
   * `claude-agent-acp` 0.63.0 turns those headers back into
   * `ANTHROPIC_CUSTOM_HEADERS` on the CLI it spawns, so the key reaches an
   * environment one process down where nothing here can strip it. The rule this
   * parameter keeps is still worth keeping — nothing *this daemon* spawns carries
   * a secret it chose to put there — but see `acp/systems.ts` before writing the
   * stronger claim anywhere.
   */
  /**
   * @param routed Whether this session is about to be pointed at another system's
   * endpoint. When `true` the harness's *own* pasted credentials are left out of
   * the spawn environment — see `LocalRuntime.launch`, which is where the argument
   * is spent, and `routedPairing`, which is the one place the question is answered.
   */
  launch(agent: AgentId, extra?: NodeJS.ProcessEnv, routed?: boolean): Promise<AgentProcess>;

  /**
   * The credential for one system, or `null` where none is stored.
   *
   * Beside `secrets(agent)` rather than folded into it: a pasted agent
   * credential is *the name of the variable a CLI reads it from* and is merged
   * into an environment, while a system credential is a bearer value handed to
   * `providers/set` over stdio and never merged into one *here*. Two different
   * lifetimes and two different destinations, so two accessors — but not two
   * different exposures at the far end: see the note on {@link SessionRuntime.launch}.
   */
  systemSecret(system: SystemId): string | null;

  /**
   * Start that agent's own interactive login, for somebody to drive from a UI.
   *
   * `null` means this runtime will not do it — see {@link loginSupported}, which
   * is how a client knows before it draws the button. Returning `null` rather
   * than omitting the method keeps the refusal a decision: a future confining
   * runtime has to answer this on purpose.
   *
   * The returned process is a {@link LoginProcess}: two output pipes, a kill
   * path, and a stdin that may be `null`. The command it runs comes from a fixed
   * table and is never supplied by a caller — there is no route, body field or
   * header anywhere that names a program, so "a caller cannot run code of their
   * choosing as the daemon" is a property of there being nothing to pass.
   */
  login(agent: AgentId): Promise<LoginProcess | null>;

  /**
   * Whether *this* agent's login can be driven here, and what its flow needs.
   *
   * Beside {@link loginSupported} rather than instead of it: that one is a fact
   * about the host (`script`), this one folds in a fact about the agent (its CLI
   * resolves) and a fact about its flow (whether anything is typed back). A
   * client draws its controls from this; the daemon-wide field stays because an
   * older client still reads it.
   */
  loginSupport(agent: AgentId): AgentLoginSupport;

  /**
   * Which environment variables a pasted credential for this harness is written to.
   *
   * ⚠ **On the runtime rather than read from a table, because it has to agree with
   * {@link SessionRuntime.launch}'s own `secrets` merge.** For the four this
   * repository ships it is `credentialEnvNames`; for a harness a plugin added it is
   * that manifest's `envNames`; and for one this machine does not offer it is
   * empty, which is what makes `PUT /agent-auth/:agent` refuse a slot rather than
   * store a secret under a name nothing will ever read.
   */
  credentialSlots(agent: AgentId): readonly string[];

  /**
   * Signs that agent's own CLI out, where it offers a way.
   *
   * `null` means the agent has no such verb — measured, kimi has none — which is
   * a different answer from "it failed", so a client draws no button rather than
   * one that always errors. Otherwise `{ok, detail}` where `detail` is whatever
   * the CLI said.
   *
   * Non-interactive, so no pty: this runs the same way the status probe does.
   * Like {@link login}, the command comes from a fixed table and is never a
   * request field.
   */
  logout(agent: AgentId): Promise<{ ok: boolean; detail: string | null } | null>;

  /**
   * Where git runs.
   *
   * A member rather than a bare import of `hostGit`, because this is the second
   * of the four seams a confining runtime would have to fill: git is a program
   * launcher — hooks, smudge filters, `diff.external` — so a runtime that
   * confines the agent has to say where git runs too, or it has left the largest
   * hole open. Measured 2026-07-30, before the answer was a member: a
   * `post-checkout` hook executed with the daemon's environment during
   * `git worktree add`.
   */
  git(): GitExec;

  /**
   * Signal an agent known only by its handle — one whose `AgentProcess` is gone
   * or was never held, as in the belt-and-braces kill after `dispose()`.
   *
   * Never throws, for the same reason `AgentProcess.kill` does not: every caller
   * is a teardown path.
   */
  kill(handle: AgentHandle | null, signal: NodeJS.Signals): Promise<void>;

  /**
   * Whether that agent is still there.
   *
   * Asynchronous even though the one implementation answers from
   * `process.kill(pid, 0)` and resolves immediately: a runtime that has to *ask*
   * something else cannot answer synchronously, and widening this later would
   * mean touching every caller at once.
   */
  alive(handle: AgentHandle | null): Promise<Liveness>;

  /**
   * Kill an agent that only exists as a persisted row, after a restart.
   *
   * The *decision* is synchronous because `SessionRegistry.restore()` is and has
   * to stay so; the kill it implies may finish afterwards. The fence lives here
   * rather than in the registry because only the runtime knows what would make
   * the recorded handle stale — a host reboot, for this one.
   */
  reap(handle: AgentHandle | null, createdAt: number, enabled: boolean): ReapDecision;
}
