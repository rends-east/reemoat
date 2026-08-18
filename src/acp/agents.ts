import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_IDS = ["claude", "kimi", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
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

export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailableError";
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
 * adapter actually spawns (`@openai/codex` 0.145.0, vendored under codex-acp
 * 1.1.9): asking a session to print its own environment returns `CODEX_CI`,
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
const SESSION_SCOPED_ENV = [
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
const DAEMON_ENV_PREFIX = "REEMOAT_";

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
  agent: AgentId,
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
 * agent_auth_required` — after a worktree had already been made. Two of the three
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
 * resolves the ACP *adapter* (`claude-agent-acp`); this one resolves the CLI the
 * adapter drives (`claude`), which ships inside a platform-specific package of
 * `@anthropic-ai/claude-agent-sdk` with no `bin` entry. Conflating the two is
 * what made an earlier documented remedy unrunnable: the adapter resolved
 * perfectly and `claude` was not on PATH.
 */
export const AGENT_LOGIN: Record<
  AgentId,
  {
    command: string;
    args: string[];
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
    // the three that needs the box — and, on BSD, the one `loginStdio` therefore
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
    // 2026-08-07, and the flag is present on the vendored 0.145.0 as well as the
    // 0.146.1 on PATH: `codex login` binds a local server on port 1455,
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
    // above is under suspicion for. Both plausible names were tried against the
    // vendored 0.145.0 with a bogus key and an empty `CODEX_HOME`, and the
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
    // back to the copy it vendors. So it decides which binary *sessions* run, and
    // without it here the login and the probe would drive the vendored copy while
    // sessions drove somebody else's — the exact "a login that appears to work and
    // changes nothing" failure `resolveLoginBinary` prefers the vendored copy to
    // avoid, reintroduced through the door left open for it.
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
};

/** Which environment variables carry a pasted credential for this agent. */
export function credentialEnvNames(agent: AgentId): readonly string[] {
  return AGENT_LOGIN[agent].envNames;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
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
 * makes for `scriptResolved` and `vendored`.
 *
 * A *miss* is not, because installing the agent is the obvious next thing a
 * person does about it. `GET /agents` feeds a settings screen that says "not
 * installed"; cached for the life of the process, that screen keeps saying it
 * after `npm i -g` has fixed it, until the daemon is restarted — an answer that
 * is wrong, that the user has just disproved, and that nothing on screen explains.
 * The precedent above does not cover this case: `script` and the vendored CLI ship
 * with the daemon, so their absence really is permanent.
 *
 * Thirty seconds keeps essentially all of the win. The exposure being removed is a
 * full PATH scan **per poll per agent**, and this makes it one scan per agent per
 * half-minute however hard anything polls, while an install shows up on its own
 * within one.
 */
const PATH_MISS_TTL_MS = 30_000;

/** When each cached miss stops being believed. Separate map: a hit never expires. */
const PATH_MISSES = new Map<string, number>();

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

  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
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
 * How each agent is started in ACP mode.
 *
 * Claude: `claude-agent-acp` with no arguments — it speaks ACP on stdio
 * immediately and exits on stdin EOF. It does not implement authentication
 * itself; it spawns a `claude` binary (from `CLAUDE_CODE_EXECUTABLE`, else the
 * one vendored by @anthropic-ai/claude-agent-sdk) and inherits whatever that
 * binary is logged in as.
 *
 * Kimi: `kimi acp` — a multi-session ACP server on stdio. It answers
 * `initialize` while logged out but rejects `session/new` with -32000.
 *
 * Codex: `codex-acp`, structurally claude's case rather than kimi's. It is a
 * dependency of this repo with a `bin` entry, so the vendored copy is preferred
 * and PATH is the fallback; and like claude's adapter it drives a CLI it brings
 * with it (`@openai/codex`, which unlike the claude SDK *does* declare a `bin`).
 * Measured 2026-08-07 against adapter 1.1.9 / codex 0.146.1: logged out it answers
 * `initialize` and rejects `session/new` with -32000 — kimi's shape, and the one
 * `502 agent_auth_required` already knows how to report.
 *
 * **Two version numbers, and they are different programs.** The adapter is 1.1.9
 * and the CLI it spawns is `@openai/codex` 0.145.0, vendored beneath it. A `codex`
 * on PATH may be neither — 0.146.1 here — and `CODEX_PATH` is what chooses. Every
 * measurement in this file that decides daemon behaviour was taken against the
 * vendored pair, because that is what runs.
 */
export function resolveAgent(id: AgentId): AgentLaunchConfig {
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
      return {
        id,
        displayName: "Claude (claude-agent-acp)",
        command,
        args: [],
        env: agentEnv(),
        authHint:
          "The Claude adapter uses the credentials of the `claude` CLI, and it is not signed in. " +
          "Settings → Machines → Configure agent will run its login here, or take a token from " +
          "`claude setup-token`; " +
          "`claude auth login` in a terminal on this machine does the same thing. The tokens live " +
          "in ~/.claude/.credentials.json, not the macOS Keychain.",
      };
    }
    case "kimi": {
      const command = findOnPath("kimi");
      if (!command) {
        throw new AgentUnavailableError(
          "kimi not found on PATH. Install it with `npm i -g @moonshot-ai/kimi-code` " +
            "(or `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`).",
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
  }
}
