import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The harnesses this repository ships, pins and measures.
 *
 * ⚠ **Still exactly four, and it stays that way — this is not the list of what a
 * machine offers.** Everything that makes a built-in a built-in is written down
 * here and nowhere else: a `resolveAgent` arm, an `AGENT_LOGIN` row, a `pincheck`
 * entry where there is an adapter to pin, and a glyph. A machine may also offer
 * harnesses a plugin added — see {@link HarnessCatalogue} — and those have none of
 * those things and cannot: `pincheck` pins an adapter version this repository
 * depends on, and a program somebody named in a manifest is not one it can pin.
 *
 * ⚠ **None of the four CLIs is vendored any more, and the adapters that are pinned
 * cannot run without one.** `deploy/agents.sh` installs and refreshes all four —
 * with each vendor's own installer, or from the npm registry where those hosts are
 * blocked — and `LocalRuntime.agentCli` picks the copy that runs. Q4.114.
 *
 * Keeping this array meaning *built-in* is what keeps every sweep written against
 * it honest. `AGENT_IDS.every((id) => AGENT_LOGIN[id] !== undefined)` is a real
 * assertion because both halves are this list; re-pointing it at what a machine
 * currently offers would make that vacuous on the day it mattered.
 */
export const AGENT_IDS = ["claude", "kimi", "codex", "opencode"] as const;

/** One of the four. Exhaustive `switch`es narrow to this and keep their `never` arms. */
export type BuiltinAgentId = (typeof AGENT_IDS)[number];

/**
 * A harness id, which is a string.
 *
 * ⚠ **It was `BuiltinAgentId` and the widening is the feature, so the two rules
 * that replaced the compiler are worth stating together.** A closed union meant
 * every door into the set was checked by `tsc`; now exactly two predicates stand
 * in, and they answer different questions on purpose:
 *
 *   - **Membership** — is this a harness this machine offers *right now* — is asked
 *     where nothing has been created yet (`POST /sessions`, `POST /custom-agents`),
 *     so a refusal costs nothing and no worktree is made for a harness that cannot
 *     run. It needs a {@link HarnessCatalogue}.
 *   - **Shape** — could this ever have been one — is asked where the row *is* the
 *     memory (`fromRow`, `readCustomAgent`). `isContributedId` in
 *     `plugins/manifest.ts` is that test, and it needs no catalogue, which is the
 *     whole point: a plugin switched off for an hour must not delete every
 *     conversation on its harness.
 */
export type AgentId = string;

/** Whether this is one of the four this repository ships. */
export function isBuiltinAgentId(value: string): value is BuiltinAgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/** Whether a machine currently offers a harness, and if not, which kind of not. */
export type CatalogueState = "enabled" | "disabled" | "unknown";

/**
 * A harness a plugin added to this machine.
 *
 * The resolved form of `HarnessContribution` in `plugins/protocol.ts`: local ids
 * namespaced, the owning plugin carried so a refusal can say whose it is.
 */
export interface ContributedHarness {
  /** Namespaced — `<pluginId>:<localId>`. */
  id: string;
  pluginId: string;
  /** What the plugin calls itself. Drawn where somebody has to be told where this came from. */
  pluginName: string;
  /** The label. Never `AgentLaunchConfig.displayName`, which is a log line. */
  name: string;
  command: string;
  args: readonly string[];
  envNames: readonly string[];
  routedModelEnv: readonly string[];
  authHint: string | null;
}

/**
 * What a machine offers, as opposed to what this repository ships.
 *
 * ⚠ **An interface rather than a module-level table, and read through rather than
 * indexed.** `tsconfig` sets `noUncheckedIndexedAccess`, so a `Record` over a
 * literal union indexes totally today and would silently become an index signature
 * the moment the union widened — turning every `SYSTEMS[id]` and `AGENT_LOGIN[id]`
 * into a `| undefined` a cast could quietly swallow. Going through a resolver makes
 * each of those a visible `null` arm with a decided answer, which is the difference
 * between a `TypeError` on the resume path and a sentence naming the plugin.
 */
export interface HarnessCatalogue {
  /** A harness a plugin added, or `null` for a built-in and for anything unknown. */
  harness(id: string): ContributedHarness | null;
  /** Every harness this machine offers: the built-ins in order, then the contributed. */
  harnessIds(): readonly string[];
  /**
   * ⚠ **Three answers, because `unknown` and `disabled` need opposite sentences.**
   * Unknown is *fix your request*; disabled is *this was correct yesterday and
   * somebody switched the plugin off* — a `503` naming the plugin and the switch,
   * never the `400` that tells an operator their own address is wrong.
   */
  harnessState(id: string): CatalogueState;
}

export interface AgentLaunchConfig {
  id: AgentId;
  displayName: string;
  /** Absolute path to the executable. Resolved eagerly so failures are specific. */
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /**
   * What to tell the user when this agent rejects a session with
   * "authentication required". Every agent authenticates out-of-band: the daemon
   * cannot drive their login flows, it can only inherit credentials from disk.
   */
  authHint: string;
}

/**
 * A harness that cannot be started on this machine, with one bit saying whether
 * `deploy/agents.sh` is the remedy.
 *
 * ⚠ **`installable` is what the auto-resume pass defers on, and it is a subset of
 * the class on purpose.** The pass used to defer every instance — a session is left
 * `waiting` with no attempt spent, and the daemon runs the agent installer for it —
 * but this class is thrown for four different absences, and the installer repairs
 * exactly one: a built-in's *CLI* missing from PATH and `MANAGED_CLI_DIRS`. A
 * missing ACP adapter is a `pnpm install` problem; an unknown or uninstalled plugin
 * harness and a contributed harness whose program is gone are somebody's decision.
 * Deferring those left the session "reconnecting" for the daemon's life with
 * nothing that could ever fix it, where spending the attempts settles it to
 * `failed` with the sentence and the Reconnect button the client already has. So
 * only the four CLI-missing refusals say `installable: true`, and everything else
 * costs attempts as it did before the installer existed.
 */
export class AgentUnavailableError extends Error {
  readonly installable: boolean;

  constructor(message: string, options: { installable?: boolean } = {}) {
    super(message);
    this.name = "AgentUnavailableError";
    this.installable = options.installable ?? false;
  }
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Session-scoped variables that must not reach a spawned agent.
 *
 * If the daemon is itself started from inside a coding agent, these leak the
 * parent's identity into the child: the child then loads the parent's skills,
 * MCP servers and session id, and reports them back over ACP. Agents get the
 * ambient environment (PATH, HOME, credentials) but never the parent's session.
 *
 * `CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH` and `CODEX_HOME` are deliberately
 * preserved — each is a real override for where an adapter finds its binary or its
 * credentials, and an operator who set one meant it. The two codex names are not
 * interchangeable: `CODEX_PATH` names the binary, `CODEX_HOME` names the
 * credentials, and only the first is `AGENT_LOGIN.codex.executableEnv`.
 *
 * The codex half was measured rather than guessed, 2026-08-07 against the CLI the
 * adapter actually spawns (`@openai/codex` 0.145.0, under codex-acp 1.1.9):
 * asking a session to print its own environment returns `CODEX_CI`,
 * `CODEX_MANAGED_BY_NPM`, `CODEX_MANAGED_PACKAGE_ROOT`, `CODEX_SANDBOX`,
 * `CODEX_SANDBOX_NETWORK_DISABLED` and `CODEX_THREAD_ID`. Two of those are worse
 * than untidy if they are inherited: `CODEX_THREAD_ID` names the *parent's*
 * conversation, and `CODEX_SANDBOX_NETWORK_DISABLED=1` would silently take the
 * network away from a fresh agent that nobody had confined.
 *
 * A list rather than a `CODEX_` prefix, for the reason the `CLAUDE_` half is also
 * a list: `CODEX_HOME` has to survive, and a prefix with an exception is a prefix
 * somebody will later "simplify".
 */
export const SESSION_SCOPED_ENV = [
  "AI_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CODEX_CI",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_MANAGED_PACKAGE_ROOT",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
];

/**
 * This daemon's own configuration, kept out of the agent's environment.
 *
 * **Hygiene, not a boundary, and the difference matters enough to write down.**
 * The agent runs as this process's own uid: on Linux it can read
 * `/proc/<daemon pid>/environ` outright, and everywhere it can read the `.env`
 * file, the unit, and `REEMOAT_DB` itself. Anything calling this confinement
 * would be claiming something false.
 *
 * What it does prevent is three things that are accidents rather than attacks,
 * and all three have a way of ending up somewhere permanent:
 *
 *   - an agent running `env` and pasting the output into a transcript, which is
 *     appended to the event log, rendered by the web UI, and quoted into a bug
 *     report;
 *   - an agent running `pnpm daemon` from inside a session, inheriting
 *     `REEMOAT_DB` and colliding on the single-row daemon lock;
 *   - `REEMOAT_TOKEN` reaching a subagent's context window.
 *
 * A prefix match rather than a list, because the failure mode of a list is the
 * variable nobody thought of — the same argument the git environment allowlist
 * in `src/git.ts` makes, one level down.
 */
export const DAEMON_ENV_PREFIX = "REEMOAT_";

/**
 * Exported because a login is a spawn too.
 *
 * `LocalRuntime.login` used to pass `{...process.env}`, so the two spawn sites in
 * one class answered the same hygiene question differently — and the login is the
 * worse one to get wrong, because its output *is* captured: 64 KiB of transcript,
 * polled over HTTP and rendered in a `<pre>` on the Settings screen. That is
 * precisely the "an agent runs `env` and it lands somewhere permanent" channel
 * the strip below exists for, with the daemon holding the pen.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SESSION_SCOPED_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith(DAEMON_ENV_PREFIX)) delete env[key];
  }
  return env;
}

/**
 * The one setting this daemon asks an agent for that ACP has no field for.
 *
 * `ultracode` is claude's own session flag — *"xhigh effort plus standing
 * dynamic-workflow orchestration"*, per `@anthropic-ai/claude-agent-sdk`'s
 * `Settings.ultracode` — and the SDK's own note says it is *"session-scoped —
 * typically provided via `--settings` or the `apply_flag_settings` control
 * request; interactive toggles never persist it"*. Neither of those is reachable
 * over ACP, so there is exactly one door: `claude-agent-acp` reads
 * `params._meta.claudeCode.options` on the session-opening request and spreads it
 * into the SDK options it builds. That is a documented extension point
 * (`_meta` is reserved by ACP for precisely this) rather than a crack.
 *
 * The consequence worth stating: because it is read when the *conversation* is
 * opened, changing it means opening one again — which for a live session means
 * restarting the agent and resuming. There is no live channel for it, and
 * inventing one by writing settings files under somebody's home is not one this
 * daemon will take.
 *
 * @see {@link ULTRACODE_VALUE} for the other half — how it is *offered*, which is
 * as an extra choice on the agent's own effort control rather than as a switch of
 * ours.
 */
export const ULTRACODE_SETTING = "ultracode";

/**
 * What to attach to `session/new` and `session/resume`, or `undefined` for
 * nothing.
 *
 * This is the **second** place a vendor's `_meta` shape is written down — the
 * first is `src/acp/subagents.ts`, which reads claude's `_meta.claudeCode` on the
 * way *in*. Both are here rather than at their call sites for the same reason:
 * the shape belongs to somebody else's release cycle, so it should be one grep
 * away when it moves.
 *
 * Returns `undefined` rather than `{}` when there is nothing to say, so the
 * request carries no `_meta` key at all. An empty object is a statement to an
 * agent that has to parse it; absence is not.
 */
export function sessionMetaFor(
  agent: string,
  flags: { ultracode: boolean },
): Record<string, unknown> | undefined {
  // Every other agent, and claude with nothing to ask for. Deliberately not a
  // table: a table with one populated row invites a second entry that nobody has
  // measured, and the measurement is the whole content of this function.
  if (agent !== "claude" || !flags.ultracode) return undefined;
  return { claudeCode: { options: { settings: { [ULTRACODE_SETTING]: true } } } };
}

/**
 * How one CLI answers "am I signed in", including **which stream it answers on**.
 *
 * The stream is here rather than assumed because assuming it was wrong on the
 * first agent that was asked. Measured 2026-08-07: `codex login status` prints
 * "Logged in using ChatGPT" on **stderr** and nothing at all on stdout, so a probe
 * reading stdout — which is the obvious stream and the one `claude auth status`
 * uses — sees an empty string and reports "cannot tell" for an agent that is
 * signed in and about to work perfectly.
 *
 * A field rather than "read stdout, fall back to stderr": the fallback is a guess
 * that happens to be right, and it would quietly start reading a warning line the
 * day a CLI printed one while still answering on stdout.
 */
export type LoginStatusProbe = {
  args: string[];
  stream: "stdout" | "stderr";
} & ({ reads: "json" } | { reads: "text"; signedIn: RegExp; signedOut: RegExp });

/**
 * How each agent logs itself in, and how to tell whether it already has.
 *
 * Fixed, and the fixity is the security property: there is no route, body field
 * or header anywhere that names a program to run, so "a caller cannot run code of
 * their choosing as the daemon" is a property of there being nothing to pass
 * rather than a validator somebody has to remember to write.
 *
 * `envNames` is the other half of the same problem: a credential can also be
 * *pasted*, and what a pasted credential is is the name of the variable the CLI
 * reads it from. Verified against the shipped binaries rather than assumed —
 * `claude` 2.1.220 reads `CLAUDE_CODE_OAUTH_TOKEN` (which is what `claude
 * setup-token` mints) and `ANTHROPIC_API_KEY`.
 *
 * Kimi's entry used to be flagged here as contradicting {@link resolveAgent}'s
 * own `authHint`, which said outright that kimi does **not** read `KIMI_API_KEY`
 * from the environment. **Measured against the installed 0.29.2 and the answer
 * is that both were right about different code paths**, which is why neither
 * side could win the argument by reading harder. Kimi's raw model client does
 * read the process environment — `options.apiKey ?? process.env["KIMI_API_KEY"]`
 * — so the slot below is real. Its *provider manager*, which is the path a
 * `managed:kimi-code` provider takes, resolves the key from `provider.env`, a
 * TOML table in `~/.kimi-code/config.toml`, and never looks at the process
 * environment at all. So a pasted key reaches one path and not the other, and
 * which path a given installation is on is a fact about its config file rather
 * than about kimi. The slot stays and the hint stopped claiming the slot is
 * useless.
 *
 * `interactiveStdin` is the same kind of fact and is what the *client* draws its
 * controls from — an input box for a flow that reads one, and none for a flow
 * that does not. Measured: `claude auth login` prints its URL and then waits on
 * a paste prompt, so it needs stdin; `kimi login` and `codex login
 * --device-auth` are device-code flows whose input box is never used. It also
 * decides the stdio the pty is spawned with (see `loginStdio`), which is what
 * makes it load-bearing rather than cosmetic.
 *
 * `status` runs non-interactively and answers the one question a PATH lookup
 * cannot: an agent can be installed and logged out, which used to report
 * `available: true` and then fail the first prompt with `502
 * agent_auth_required` — after a worktree had already been made. Two of the four
 * have such a command and they answer in **different formats**, which is why
 * {@link LoginStatusProbe} is a union rather than a pair of args: claude's
 * `auth status` prints `{"loggedIn": …}`, codex's `login status` prints a
 * sentence. Neither is read by its exit code.
 *
 * `credentialPath` is the weaker answer for an agent that has no such command,
 * and it is deliberately **one-directional**: a file that exists proves a login
 * happened, and a file that is missing proves nothing — the layout is kimi's to
 * change, and reporting "not signed in" for somebody whose agent works is worse
 * than reporting nothing. So presence gives `true` and absence gives `null`.
 * Measured 2026-07-31: an installation that has run kimi but never logged in has
 * `~/.kimi-code/{device_id,config.toml,logs}` and no `credentials/` at all.
 *
 * `command` here is **not** the same binary as {@link resolveAgent}'s. That one
 * resolves the ACP *adapter* (`claude-agent-acp`); this one names the CLI the
 * adapter drives (`claude`), which is whatever `deploy/agents.sh` installed or an
 * operator named — it used to ship inside a platform-specific package of
 * `@anthropic-ai/claude-agent-sdk` with no `bin` entry, and that package is
 * excluded now (Q4.114). Conflating the two is what made an earlier documented
 * remedy unrunnable: the adapter resolved perfectly and `claude` was not on PATH.
 */
export const AGENT_LOGIN: Record<
  BuiltinAgentId,
  {
    command: string;
    /**
     * How this CLI is signed *in*, or `null` where there is nothing to sign in to.
     *
     * ⚠ **Nullable for {@link logoutArgs}'s reason and one stronger.** That field
     * is `null` where a CLI offers no sign-out verb; this is `null` where an agent
     * needs no sign-in at all. Measured on opencode 1.18.23 against an empty
     * `XDG_DATA_HOME` with no provider variables of any kind: `session/new`
     * succeeds and `session/prompt` completes, because its own gateway has an
     * anonymous free tier. A wizard there would be a button that fixes nothing,
     * in front of an agent that already works.
     *
     * `loginBlockedReason` reads it first, so the client is told *why* rather
     * than being left to infer it from a disabled control.
     */
    args: string[] | null;
    /**
     * Whether this login flow ever reads stdin.
     *
     * Two readers and they must agree, which is why it is in the table rather
     * than either of them. `loginStdio` decides whether the pty gets a stdin
     * pipe at all, and `GET /agent-auth` reports it so the client knows whether
     * to draw an input box — a box for a flow that never reads one is an
     * invitation to type a code into nothing.
     */
    interactiveStdin: boolean;
    /**
     * How this CLI is signed *out*, or `null` where it offers no way.
     *
     * Non-interactive, so unlike {@link args} it needs no pty — it is run the
     * same way the status probe is. Measured 2026-08-08: claude has `auth
     * logout`, codex has `logout` ("Remove stored authentication credentials"),
     * and **kimi has no such verb at all**, which is why this is nullable rather
     * than a third row of arguments. A client draws the button from this, so an
     * agent that cannot be signed out never offers one.
     */
    logoutArgs: string[] | null;
    envNames: string[];
    status: LoginStatusProbe | null;
    /**
     * The variable that names this CLI's binary, where the CLI has one.
     *
     * In the table because it is read in two places that must agree — the login
     * spawn prefers it, and the "could not tell whether this is signed in" hint
     * names it as the remedy. It was a literal in the second of those, which meant
     * an agent with no such variable was told to set claude's.
     */
    executableEnv: string | null;
    /** Relative to HOME. Existence proves a login; absence proves nothing. */
    credentialPath: string | null;
  }
> = {
  claude: {
    command: "claude",
    args: ["auth", "login"],
    // Measured: the flow prints its URL wrapped in an OSC 8 hyperlink and then
    // waits on a paste prompt for the code the page gives back. It is the one of
    // the four that needs the box — and, on BSD, the one `loginStdio` therefore
    // cannot rescue.
    interactiveStdin: true,
    logoutArgs: ["auth", "logout"],
    envNames: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    status: { args: ["auth", "status"], stream: "stdout", reads: "json" },
    executableEnv: "CLAUDE_CODE_EXECUTABLE",
    credentialPath: null,
  },
  kimi: {
    command: "kimi",
    args: ["login"],
    // Device-code flow: it prints a URL and a code and waits on the network, not
    // on you. Measured, its input box was never used.
    interactiveStdin: false,
    // `kimi --help` lists no logout, sign-out or equivalent. Signing out means
    // deleting `~/.kimi-code/credentials` by hand, which is not something this
    // daemon does to somebody's disk on a button press.
    logoutArgs: null,
    envNames: ["KIMI_API_KEY"],
    status: null,
    executableEnv: null,
    credentialPath: ".kimi-code/credentials",
  },
  codex: {
    command: "codex",
    // `--device-auth` and not a bare `login`, on codex's own advice. Measured
    // 2026-08-07, and the flag is present on the 0.145.0 this repository pinned
    // then as well as the 0.146.1 on PATH: `codex login` binds a local server on port 1455,
    // opens a browser, and prints "On a remote or headless machine? Use `codex
    // login --device-auth` instead." A daemon driven from a phone is exactly that
    // machine — nobody is at its browser and nothing can reach port 1455. The
    // device-code form prints a URL and a one-time code that expires in 15
    // minutes, which is the shape kimi's login already has and the shape the
    // wizard's poll-and-display loop was written for.
    args: ["login", "--device-auth"],
    // Device-code, like kimi's — which is the whole reason `--device-auth` is on
    // the line above. Nothing is typed back.
    interactiveStdin: false,
    logoutArgs: ["logout"],
    // Measured rather than assumed, because this is the exact field the kimi entry
    // above is under suspicion for. Both plausible names were tried against
    // 0.145.0 with a bogus key and an empty `CODEX_HOME`, and the
    // distinguishing evidence is *which* rejection came back: `CODEX_API_KEY`
    // produced `invalid_api_key` / "Incorrect API key" — the server refusing the
    // key we supplied, so it was sent — while `OPENAI_API_KEY` produced "Missing
    // bearer or basic authentication in header", i.e. no credential was sent at
    // all. So the obvious name is the wrong one *for the environment*.
    //
    // Narrowly: the **adapter** does read `OPENAI_API_KEY`, in `readApiKeyFromEnv`,
    // but only from `authenticate()` under `methodId: "api-key"` — ACP's
    // `session/authenticate`, which this daemon never calls. Listing it here would
    // therefore offer a slot that stores a token nothing on our paths reads.
    //
    // **It is still the weaker of the two paths, for a reason that is codex's and
    // not ours.** Measured in the same run: with `CODEX_API_KEY` set and no
    // `auth.json`, `codex-acp` answers `session/new` with -32000 "Authentication
    // required" anyway. So a pasted key reaches the model's API calls but does not
    // by itself start a session. That is survivable rather than a trap only
    // because the login probe runs *with* the pasted credential in its environment
    // and `codex login status` still says "Not logged in" — a clean `false` the
    // probe is required to believe over a token we know we handed over.
    envNames: ["CODEX_API_KEY"],
    // Prose, not JSON, and read as prose. Measured: "Logged in using ChatGPT" (also
    // "…using an API key", "…using personal access token", "…using Amazon Bedrock
    // API key") against "Not logged in", exiting 0 and 1 respectively. The exit
    // code tracks the answer and is still not what is read, for the reason claude's
    // entry gives: it cannot tell a logged-out agent from a crash or a missing
    // binary. Two patterns rather than one, so anything matching neither is
    // "cannot tell" rather than silently logged out.
    status: {
      args: ["login", "status"],
      // stderr, measured. See {@link LoginStatusProbe} — this is the field that
      // was assumed and wrong, and its symptom was a signed-in codex reporting
      // "status unknown" with nothing anywhere saying why.
      stream: "stderr",
      reads: "text",
      // `[ \t]` and **not** `\s`, which is a stall rather than a style choice.
      // `^\s*` under `/m` is quadratic: `^` matches at every line start and `\s*`
      // eats the whole remaining run before backtracking. Measured, 100k newlines
      // takes 7.6s against 0ms for this form — and `runProbe` allows a 1 MiB
      // `maxBuffer` of output this daemon did not write, on the event loop that
      // serves every session, socket and `/health`. `\s` is what makes a newline
      // both the anchor and the fuel.
      signedIn: /^[ \t]*Logged in\b/im,
      signedOut: /^[ \t]*Not logged in\b/im,
    },
    // `CODEX_PATH` is codex's `CLAUDE_CODE_EXECUTABLE`, and this said there was no
    // such variable. Read from the adapter's own `startAcpServer()`, which is the
    // path the daemon takes: `const codexPath = process.env["CODEX_PATH"]`, falling
    // back to a platform package this repository excludes (Q4.114). So it decides
    // which binary *sessions* run, and without it here the login and the probe
    // would drive one copy while sessions drove another — the exact "a login that
    // appears to work and changes nothing" failure `LocalRuntime.agentCli` exists
    // to prevent, reintroduced through the door left open for it.
    //
    // It survives `agentEnv`'s strip for the same reason `CLAUDE_CODE_EXECUTABLE`
    // does, and `CODEX_HOME` is *not* this variable: that one names where
    // credentials live, so offering it as the remedy for "cannot find the CLI"
    // would send somebody to move their credentials.
    executableEnv: "CODEX_PATH",
    // Deliberately `null` even though `~/.codex/auth.json` exists and would answer.
    // Its directory moves with `CODEX_HOME`, so a path relative to HOME would be
    // reading the wrong file precisely for the operator who configured one — while
    // the status command above asks the CLI, which knows where its own home is.
    credentialPath: null,
  },
  opencode: {
    command: "opencode",
    /*
     * ⚠ **`null`: there is nothing to sign in to.** opencode reaches its own
     * gateway anonymously — measured — and every other provider it knows is one
     * you hand a key to, which is what `envNames` below is. `auth login` exists
     * and is an arrow-key provider picker this wizard could not drive anyway, but
     * that is not why it is absent: a wizard here would be a control that fixes
     * nothing in front of an agent that already runs.
     */
    args: null,
    // No flow, so nothing reads stdin and no pty is allocated.
    interactiveStdin: false,
    /*
     * `null`, and not for kimi's reason. `auth logout <provider>` exists and is
     * non-interactive. It is not offered because a *sign-out* button next to no
     * sign-in button is a control whose whole meaning is the pair — and what it
     * would remove is a key this daemon did not put there. The paste box has its
     * own clear, which is the one this product is entitled to offer.
     */
    logoutArgs: null,
    // Two, like claude — and they are two *providers* rather than two forms of one
    // credential. `OPENCODE_API_KEY` is opencode's own gateway, whose free tier
    // needs nothing at all; `OPENROUTER_API_KEY` is somebody else's catalogue.
    // Measured: with the second set, the published list goes from six to 362.
    envNames: ["OPENROUTER_API_KEY", "OPENCODE_API_KEY"],
    /*
     * ⚠ **`null`, and the measurement that argued for a probe is the same one
     * that rules it out.** `opencode auth list` works and its output was read in
     * full — stdout, and all four states driven: `0 credentials` with nothing
     * configured, `1 credentials` for a written `auth.json`, and a separate
     * `1 environment variable` section for a key in the environment, which is why
     * a naive `0 credentials` pattern reported a working machine as signed out.
     *
     * None of that matters, because **opencode runs with no credential at all.**
     * Measured 2026-08-27 against an empty `XDG_DATA_HOME` and no provider
     * variables of any kind: `session/new` succeeds, publishes six OpenCode Zen
     * models, and `session/prompt` completes with `stopReason: "end_turn"`. Their
     * free tier is anonymous.
     *
     * So `false` is not a fact this probe can produce honestly. `admit` refuses on
     * `loggedIn === false`, so a probe answering it would have put "not signed in"
     * in front of an agent that had just answered a prompt, and refused to read
     * its model list at all — Q7.99's mistake, arriving from the opposite side:
     * that one read `null` as "no", this one would have manufactured the "no".
     *
     * `credentialPath` below answers the half that *is* honest — somebody
     * configured a provider — and everything else falls to "cannot tell", which is
     * what `readLoginState` does with a missing file. The 389 ms this saves on
     * every `GET /agents` is a consequence rather than the reason.
     */
    status: null,
    // No adapter, so no second binary and nothing for a variable to override.
    // `resolveAgent` and `LocalRuntime.agentCli` resolve the *same* file here,
    // because both ask `findOnPath` the same name.
    executableEnv: null,
    /*
     * Presence proves a provider was configured; absence proves nothing, which is
     * kimi's shape and is the whole of what is claimed.
     *
     * ⚠ **It moves with `XDG_DATA_HOME` — measured, by redirecting it — and that
     * is survivable here where it would not be for codex.** codex has a status
     * command to prefer, so a HOME-relative path there would be the *worse* of two
     * answers; here there is nothing behind it, and a relocated directory reads as
     * a missing file and falls to `pasted ? true : null`. Never a false "signed
     * out", which is the only answer that would cost anything.
     */
    credentialPath: ".local/share/opencode/auth.json",
  },
};

/**
 * Whether this agent has a sign-in to run at all.
 *
 * ⚠ **`args === null` is the whole of the fact and this is the only place it is
 * read as one.** opencode authenticates nowhere — it runs on OpenCode Zen's free
 * models the moment it is installed, and a key only widens what it can reach — so
 * there is no wizard, no sign-out and nothing for a status probe to answer. That
 * is a property of the *program*, unlike the other three reasons a sign-in cannot
 * be run here, which are all the host's.
 *
 * Extracted because it had been written out inline in three places — the runtime,
 * the daemon's own driver and `pnpm client` — and a predicate spelled three times
 * is how one of them comes to disagree.
 */
export function hasLoginFlow(agent: BuiltinAgentId): boolean {
  return AGENT_LOGIN[agent].args !== null;
}

/** Which environment variables carry a pasted credential for this agent. */
export function credentialEnvNames(agent: BuiltinAgentId): readonly string[] {
  return AGENT_LOGIN[agent].envNames;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    // `X_OK` alone is satisfied by a directory, and the walk now reaches
    // `MANAGED_CLI_DIRS`: a stray directory named `claude` under `~/.local/bin`
    // would have been a permanent hit, written into `CLAUDE_CODE_EXECUTABLE`
    // for the adapter to fail on at every spawn.
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The first executable of this name on PATH, or `null`.
 *
 * Exported because three separate questions resolve against PATH and none of
 * them is the same binary: the adapter ({@link resolveAgent}), the CLI a login
 * drives ({@link AGENT_LOGIN}), and `script`, which is what allocates the pty a
 * login needs.
 */
const PATH_HITS = new Map<string, string>();

/**
 * How long "not on PATH" is believed before the walk is done again.
 *
 * ⚠ **The two answers do not age the same way, and caching them the same way was
 * wrong in the one direction somebody watches.** A *hit* is permanent: PATH is
 * read once by the process at exec, and an absolute path that resolved to an
 * executable does not stop being one — the same argument `LocalRuntime` already
 * makes for `scriptResolved`. The one event that moves a binary under a running
 * daemon, `deploy/agents.sh`, is followed by {@link forgetPathHits}.
 *
 * A *miss* is not, because installing the agent is the obvious next thing a
 * person does about it. `GET /agents` feeds a settings screen that says "not
 * installed"; cached for the life of the process, that screen keeps saying it
 * after `npm i -g` has fixed it, until the daemon is restarted — an answer that
 * is wrong, that the user has just disproved, and that nothing on screen explains.
 * The precedent above does not cover this case: `script` ships with the host, so
 * its absence really is permanent — and a CLI is exactly what `deploy/agents.sh`
 * puts on the machine while the daemon is running.
 *
 * Thirty seconds keeps essentially all of the win. The exposure being removed is a
 * full PATH scan **per poll per agent**, and this makes it one scan per agent per
 * half-minute however hard anything polls, while an install shows up on its own
 * within one.
 */
const PATH_MISS_TTL_MS = 30_000;

/** When each cached miss stops being believed. Separate map: a hit never expires. */
const PATH_MISSES = new Map<string, number>();

/**
 * Forget every PATH lookup, hits included.
 *
 * A hit never expires on its own — see {@link findOnPath} — which is right for the
 * life of a daemon and wrong across the one event that moves binaries under it:
 * `deploy/agents.sh` installing a CLI where none was, or an operator deleting the
 * one that was found. `LocalRuntime.forgetAvailability` calls this beside its own
 * caches, so the next launch walks PATH again rather than spawning a path that is
 * gone — which was ENOENT until a restart.
 */
export function forgetPathHits(): void {
  PATH_HITS.clear();
  PATH_MISSES.clear();
}

/**
 * Where this daemon installs the agent CLIs, searched after `PATH`.
 *
 * ⚠ **The unit's `PATH` deliberately does not name these, and adding them there was
 * the obvious fix and the wrong one.** `runtime_path` builds the unit's `PATH` from
 * the system directories plus the directories of the two tools it is handed
 * (`runtime_path "$_node" "$_git"`, `deploy/lib.sh:1135`), and changing it means
 * re-rendering the unit — which means a reload, which `deploy/install.sh` documents
 * as interrupting every live session. Searching here instead reaches every machine
 * already in the field on a plain `deploy.sh`, because `^src/` restarts the daemon
 * and nothing else has to move.
 *
 * **Appended, never prepended.** These are a *fallback* for a name the system does
 * not have, not a preference: prepending would let a stray `git` or `node` in
 * `~/.local/bin` shadow `/usr/bin/git` for every spawn this daemon makes, which is
 * the privilege-path hazard `runtime_path`'s own comment weighs one directory at a
 * time.
 *
 * The three are the vendors' own, and none of them is relocatable:
 * - `~/.local/bin` — claude and codex both install there, and claude's binary
 *   carries `.local/bin/claude` as its only bin literal.
 * - `~/.opencode/bin` — opencode's installer assigns `INSTALL_DIR` outright.
 * - `~/.reemoat/toolchain/bin` — ours. kimi goes there always, because it has no
 *   relocatable native installer and is put there as an npm global with the node
 *   the bootstrap already installed; and all four go there under
 *   `REEMOAT_AGENT_SOURCE=npm`, the arm for a machine that cannot reach the
 *   vendors' hosts (Q4.114).
 *
 * **`homedir()` rather than a bare `HOME` read, and the difference is narrower
 * than it looks.** On POSIX `os.homedir()` answers `$HOME` when that is set and the
 * account's passwd entry only when it is not — so the two agree under every service
 * manager that sets `HOME`, and diverge only for one that sets none, where a bare
 * read would build `undefined/.local/bin`. What is being located is where
 * `deploy/agents.sh` put a file, and that script roots on `$HOME` and refuses to run
 * without one; the daemon hands it the same answer this constant was built from.
 */
export const MANAGED_CLI_DIRS: readonly string[] = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".opencode", "bin"),
  join(homedir(), ".reemoat", "toolchain", "bin"),
];

export function findOnPath(name: string): string | null {
  /*
   * ⚠ **Memoised, because this is a synchronous walk of directories the daemon
   * did not create.** `.claude/rules/files-paths-git.md` states the rule twice
   * over: a stalled network mount blocks inside the kernel, and synchronously
   * that stops the event loop — every session, every socket, not just the caller.
   * PATH is exactly the kind of place that holds one: an NFS or SMB entry, a
   * `/Volumes` mount on a laptop that has moved network.
   *
   * `GET /agents` and `GET /agent-auth` are polled surfaces, and each answer ran
   * this per agent, uncached — so the exposure was one whole PATH scan per poll
   * per agent, none of it needed twice.
   *
   * A miss is the answer that costs the *whole* scan rather than stopping at the
   * first hit, so it is cached too — but on a clock. See `PATH_MISS_TTL_MS` for
   * why the two answers do not age alike.
   */
  const hit = PATH_HITS.get(name);
  if (hit !== undefined) return hit;
  const missedAt = PATH_MISSES.get(name);
  if (missedAt !== undefined && Date.now() - missedAt < PATH_MISS_TTL_MS) return null;

  /*
   * `PATH` first and {@link MANAGED_CLI_DIRS} after it — see that constant for why
   * the second list exists and why it may not go in front.
   */
  for (const dir of [...(process.env["PATH"] ?? "").split(delimiter), ...MANAGED_CLI_DIRS]) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) {
      PATH_MISSES.delete(name);
      PATH_HITS.set(name, candidate);
      return candidate;
    }
  }
  PATH_MISSES.set(name, Date.now());
  return null;
}

/**
 * The CLI under an adapter, as an existence test.
 *
 * ⚠ **Neither adapter falls back to PATH, and this repository no longer vendors a
 * CLI for either — so an adapter that resolves is not yet a harness that can
 * start.** `claude-agent-acp`'s `claudeCliPath()` is two branches,
 * `CLAUDE_CODE_EXECUTABLE` else a `require` bound to its SDK's platform package,
 * and it throws with neither. `codex-acp`'s `startAcpServer()` has the same two
 * branches one variable over, and its second does not throw: it spawns the
 * `@openai/codex` shim `pnpm install` still brings, under this node, and the shim
 * exits complaining about the platform package it cannot find. The platform
 * packages are excluded in `pnpm-workspace.yaml` (Q4.114), so on every machine the
 * variable is the only door that leads to a running CLI — `LocalRuntime.launch`
 * writes it on every spawn from whichever copy this finds. Asked here, synchronously, so that `describe` fails fast with a
 * sentence naming the remedy rather than an adapter dying at spawn with a stack
 * trace about a package that is deliberately absent, and so that `GET /agents`
 * draws the tile as unavailable rather than as a harness refusing every start.
 *
 * An override is believed as named and not tested for existence — an operator who
 * set one meant it, `chooseCli` makes the same choice, and the failure a wrong one
 * produces is the adapter's own, about a file the operator chose.
 */
function cliFor(agent: "claude" | "codex"): string | null {
  const login = AGENT_LOGIN[agent];
  const override = login.executableEnv === null ? "" : (process.env[login.executableEnv] ?? "").trim();
  if (override.length > 0) return override;
  return findOnPath(login.command);
}

/** What to do about a CLI that is not on this machine, said the same way for both. */
function noCli(agent: "claude" | "codex"): string {
  const login = AGENT_LOGIN[agent];
  return (
    `${login.command} is not on this daemon's PATH or in the directories deploy/agents.sh installs into, ` +
    `and its adapter cannot run without it. Run deploy/agents.sh on this machine — behind a firewall, ` +
    `deploy/agents.sh --source npm — or name a copy in ${login.executableEnv ?? "the vendor's own variable"}.`
  );
}

/**
 * How each agent is started in ACP mode.
 *
 * Claude: `claude-agent-acp` with no arguments — it speaks ACP on stdio
 * immediately and exits on stdin EOF. It does not implement authentication
 * itself; it spawns the `claude` binary named in `CLAUDE_CODE_EXECUTABLE` and
 * inherits whatever that binary is logged in as. ⚠ It never looks on PATH, and
 * this repository no longer vendors a `claude` for it to find — {@link cliFor} is
 * the consequence.
 *
 * Kimi: `kimi acp` — a multi-session ACP server on stdio. It answers
 * `initialize` while logged out but rejects `session/new` with -32000.
 *
 * Codex: `codex-acp`, structurally claude's case rather than kimi's: an adapter
 * this repository pins, driving a `codex` it is told about in `CODEX_PATH`.
 * Measured 2026-08-07 against adapter 1.1.9 / codex 0.146.1: logged out it answers
 * `initialize` and rejects `session/new` with -32000 — kimi's shape, and the one
 * `502 agent_auth_required` already knows how to report.
 *
 * **Two version numbers, and they are different programs.** The adapter is
 * pinned — 1.8.0 now, 1.1.9 when the measurement above was taken; the CLI it
 * spawns is whatever `deploy/agents.sh` installed or an
 * operator named, and it moves daily. A measurement in this file names the pair it
 * was taken against, and `AgentCapabilities.cli` names the build a running daemon
 * actually used — that, rather than a pin, is what records it now (Q6.106).
 *
 * ⚠ **Which CLI runs is not decided here.** This function resolves the **adapter**
 * and refuses when there is no CLI for it to drive; `LocalRuntime.agentCli`
 * decides which copy goes under it — an operator's override outright, else the
 * first on PATH and then in {@link MANAGED_CLI_DIRS}. The copy this repository used
 * to vendor was the floor under that choice, exactly as old as the release and
 * never the one that ran once a vendor's copy was on the machine; Q4.114 is why it
 * is gone and what a machine behind a firewall does instead.
 */
export function resolveAgent(id: string, machine?: HarnessCatalogue): AgentLaunchConfig {
  /*
   * ⚠ **Contributed first, and the order is not arbitrary.** A contributed id
   * carries a colon and a built-in never does, so the two sets cannot overlap and
   * either order would resolve the same thing — but asking the catalogue first is
   * what makes the *refusals* right. A plugin whose harness is gone falls out of
   * this branch into the throw below, which says so; reaching the `switch` first
   * would put an unknown id through four arms it can never match on the way to the
   * same place, and would tempt somebody to add a `default` that reports it as a
   * missing binary.
   */
  const contributed = machine?.harness(id) ?? null;
  if (contributed !== null) return contributedLaunchConfig(contributed);
  if (!isBuiltinAgentId(id)) throw new AgentUnavailableError(unknownHarness(id, machine ?? null));

  switch (id) {
    case "claude": {
      const vendored = join(PACKAGE_ROOT, "node_modules", ".bin", "claude-agent-acp");
      const command = isExecutable(vendored) ? vendored : findOnPath("claude-agent-acp");
      if (!command) {
        throw new AgentUnavailableError(
          "claude-agent-acp not found. It is a dependency of this repo — run `pnpm install` " +
            "in the project root (or install it globally with " +
            "`npm i -g @agentclientprotocol/claude-agent-acp`).",
        );
      }
      if (cliFor("claude") === null) throw new AgentUnavailableError(noCli("claude"), { installable: true });
      return {
        id,
        displayName: "Claude (claude-agent-acp)",
        command,
        args: [],
        env: agentEnv(),
        /*
         * **Two stores really do exist, and neither is worth claiming here.**
         * The CLI keeps a `Claude Code-credentials` item in `login.keychain-db`
         * *and* a copy in `~/.claude/.credentials.json`, and measured on
         * 2026-08-19 they disagreed by two days. The sentence that used to sit
         * here named the JSON as *the* location, and a later one blamed the
         * Keychain for a daemon reporting signed-out — **both were guesses, and
         * the second was measured wrong the next day** (Q7.99). So this says
         * neither. What it names is the remedy that does not depend on which
         * store won: a token pasted here is injected into the agent's
         * environment, and nothing has to be read or unlocked to find it.
         */
        authHint:
          "The Claude adapter uses the credentials of the `claude` CLI, and it is not signed in. " +
          "Run `claude setup-token` in a terminal on this machine and paste the token below — " +
          "a token saved here is handed to the agent directly, so it does not depend on which " +
          "of the CLI's own credential stores this daemon can read. `claude auth login` in a " +
          "terminal signs the CLI in, which is often enough on its own.",
      };
    }
    case "kimi": {
      const command = findOnPath("kimi");
      if (!command) {
        throw new AgentUnavailableError(
          "kimi not found on PATH. Install it with `npm i -g @moonshot-ai/kimi-code` " +
            "(or `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`).",
          { installable: true },
        );
      }
      return {
        id,
        displayName: "Kimi Code CLI",
        command,
        args: ["acp"],
        env: agentEnv(),
        authHint:
          "Kimi is not logged in. Settings → Machines → Configure agent will run its device-code " +
          "login here, or `kimi login` in a terminal on this machine does the same thing; " +
          "credentials are stored under ~/.kimi-code/. A pasted KIMI_API_KEY is read by Kimi's " +
          "model client but not by its provider manager, which takes the key from " +
          "~/.kimi-code/config.toml under [providers.…env] instead — so on an installation using " +
          "a managed provider the paste box is the weaker of the two paths.",
      };
    }
    case "codex": {
      const vendored = join(PACKAGE_ROOT, "node_modules", ".bin", "codex-acp");
      const command = isExecutable(vendored) ? vendored : findOnPath("codex-acp");
      if (!command) {
        throw new AgentUnavailableError(
          "codex-acp not found. It is a dependency of this repo — run `pnpm install` " +
            "in the project root (or install it globally with " +
            "`npm i -g @agentclientprotocol/codex-acp`).",
        );
      }
      if (cliFor("codex") === null) throw new AgentUnavailableError(noCli("codex"), { installable: true });
      return {
        id,
        displayName: "Codex (codex-acp)",
        command,
        args: [],
        env: agentEnv(),
        authHint:
          "The Codex adapter uses the credentials of the `codex` CLI, and it is not signed in. " +
          "Settings → Machines → Configure agent will run its device-code login here; " +
          "`codex login --device-auth` in " +
          "a terminal on this machine does the same thing. Credentials are stored in " +
          "~/.codex/auth.json (or under CODEX_HOME). Note that a pasted CODEX_API_KEY is read by " +
          "codex for its API calls but does NOT on its own satisfy the adapter, which still " +
          "refuses session/new with -32000 until a real login has been written to disk.",
      };
    }
    case "opencode": {
      // No adapter package: `opencode acp` is a subcommand of the same binary a
      // login drives, so there is one file here where claude and codex have two —
      // and `LocalRuntime.agentCli` asks `findOnPath` the same name, so a login and
      // a session cannot pick differently.
      const command = findOnPath("opencode");
      if (!command) {
        throw new AgentUnavailableError(
          "opencode not found on this daemon's PATH. deploy/agents.sh installs it " +
            "(or `curl -fsSL https://opencode.ai/install | bash`).",
          { installable: true },
        );
      }
      return {
        id,
        // Capitalised, like `Kimi Code CLI` beside it: this string is drawn as a
        // row title in the settings agent list, so it is a word rather than the
        // name of a binary. The binary, the package and the id stay lowercase.
        displayName: "Opencode CLI",
        command,
        args: ["acp"],
        env: agentEnv(),
        // ⚠ **This one may not offer a sign-in, because there is none.** opencode
        // runs with no credential at all — its own gateway has an anonymous free
        // tier — so a refusal here is never "you are signed out"; it is a model
        // whose provider wants a key. The remedy is the key box, and naming a
        // wizard the screen does not draw would send somebody looking for it.
        authHint:
          "opencode refused this session. It needs no signing in — with nothing configured it " +
          "runs on OpenCode Zen's free models — so this is a model whose provider wants a key. " +
          "Add one under Settings → Machines → this machine (OPENROUTER_API_KEY for OpenRouter's " +
          "catalogue, OPENCODE_API_KEY for the rest of Zen's), or pick one of the free models.",
      };
    }
  }
}

/**
 * How a contributed harness is launched.
 *
 * The four built-in arms above each resolve a *different* file — an adapter this
 * repository vendors, a CLI on PATH, a subcommand of one binary — because each was
 * a measurement. There is exactly one shape here, and that is the honest
 * difference: what a manifest names is a program on PATH and nothing else, so
 * `findOnPath` is the whole of the resolution and `pincheck` has nothing to pin.
 *
 * ⚠ **`displayName` carries the program and the label does not.** This string is
 * the log line and the settings-list row title, where naming the binary is the
 * point; `ContributedHarness.name` is what a tile draws, and the client's own rule
 * forbids a label naming a package. Collapsing the two is how `Kimi Code CLI`
 * would end up on a 96px tile.
 */
function contributedLaunchConfig(harness: ContributedHarness): AgentLaunchConfig {
  const command = findOnPath(harness.command);
  if (command === null) {
    throw new AgentUnavailableError(
      `${harness.name} needs ${harness.command} on this machine's PATH, and it is not there. ` +
        `It was added by the ${harness.pluginName} plugin, which does not install it.`,
    );
  }
  return {
    id: harness.id,
    displayName: `${harness.name} (${harness.command})`,
    command,
    args: [...harness.args],
    env: agentEnv(),
    authHint:
      harness.authHint ??
      `${harness.name} refused this session. It was added by the ${harness.pluginName} plugin, ` +
        `which did not say what it needs — a key pasted under Settings → Machines → this machine ` +
        `is the control this daemon has.`,
  };
}

/**
 * What to say about a harness id that resolves to nothing.
 *
 * ⚠ **Three sentences, because "not installed" is the wrong one twice.** A row
 * naming a plugin's harness after the plugin was removed is not a missing `npm i
 * -g`, and sending somebody to install a package that does not exist is worse than
 * saying nothing. `harnessState` is what tells the three apart, and it is the only
 * caller that needs it here.
 */
function unknownHarness(id: string, machine: HarnessCatalogue | null): string {
  const plugin = id.indexOf(":") > 0 ? id.slice(0, id.indexOf(":")) : null;
  if (plugin === null) return `${id} is not an agent this machine knows about.`;
  switch (machine?.harnessState(id) ?? "unknown") {
    case "disabled":
      return `This agent comes from the ${plugin} plugin, which is switched off on this machine.`;
    default:
      return `This agent came from the ${plugin} plugin, which is no longer installed on this machine.`;
  }
}
