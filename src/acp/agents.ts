import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeText } from "../stall.js";

/** The built-in harnesses only, never what a machine offers (see HarnessCatalogue); sweeps against AGENT_LOGIN rely on that. Q6.106, Q4.114. */
export const AGENT_IDS = ["claude", "kimi", "codex", "opencode", "grok"] as const;

export type BuiltinAgentId = (typeof AGENT_IDS)[number];

/** Membership (HarnessCatalogue) is checked only where nothing exists yet; a stored row is checked for shape (isContributedId), so a disabled plugin deletes nothing. */
export type AgentId = string;

export function isBuiltinAgentId(value: string): value is BuiltinAgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export type CatalogueState = "enabled" | "disabled" | "unknown";

export interface ContributedHarness {
  /** Namespaced — `<pluginId>:<localId>`. */
  id: string;
  pluginId: string;
  pluginName: string;
  /** The label. Never `AgentLaunchConfig.displayName`, which is a log line. */
  name: string;
  command: string;
  args: readonly string[];
  envNames: readonly string[];
  routedModelEnv: readonly string[];
  authHint: string | null;
}

export interface HarnessCatalogue {
  /** A harness a plugin added, or `null` for a built-in and for anything unknown. */
  harness(id: string): ContributedHarness | null;
  /** Every harness this machine offers: the built-ins in order, then the contributed. */
  harnessIds(): readonly string[];
  /** unknown is a bad request; disabled means the plugin was switched off, answered as a 503 naming it. */
  harnessState(id: string): CatalogueState;
}

export interface AgentLaunchConfig {
  id: AgentId;
  displayName: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  authHint: string;
}

/** installable is true only for a built-in's missing CLI, the one absence deploy/agents.sh repairs; auto-resume defers on nothing else. */
export class AgentUnavailableError extends Error {
  readonly installable: boolean;

  constructor(message: string, options: { installable?: boolean } = {}) {
    super(message);
    this.name = "AgentUnavailableError";
    this.installable = options.installable ?? false;
  }
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Parent-session variables stripped from a spawned agent; CLAUDE_CODE_EXECUTABLE, CODEX_PATH and CODEX_HOME are real overrides and must stay off this list. */
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

/** Stripped from agent spawns as hygiene, not confinement: the agent runs as this uid. */
export const DAEMON_ENV_PREFIX = "REEMOAT_";

export function agentEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SESSION_SCOPED_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith(DAEMON_ENV_PREFIX)) delete env[key];
  }
  return env;
}

/** claude's session flag, reachable only through _meta.claudeCode.options on session open, so changing it means reopening the session. */
export const ULTRACODE_SETTING = "ultracode";

/** Claude Code's own way to find other sessions, withdrawn from every claude session: it never lists what this daemon runs (Q2.242). */
export const CLAUDE_WITHDRAWN_PEER_TOOLS: readonly string[] = ["ListAgents"];

/** undefined rather than an empty object, so the request carries no _meta key at all. */
export function sessionMetaFor(
  agent: string,
  flags: { ultracode: boolean; elicitation: boolean },
): Record<string, unknown> | undefined {
  // grok keeps its question tool whatever the client declares, so withdrawing it is this key, measured (Q6.113).
  if (agent === "grok") return flags.elicitation ? undefined : { askUserQuestion: false };
  if (agent !== "claude") return undefined;
  // Never settings for the withdrawal: the adapter drops its CLAUDE_MODEL_CONFIG settings whenever any are passed.
  return {
    claudeCode: {
      options: {
        ...(flags.ultracode ? { settings: { [ULTRACODE_SETTING]: true } } : {}),
        disallowedTools: [...CLAUDE_WITHDRAWN_PEER_TOOLS],
      },
    },
  };
}

/** The stream is explicit because codex answers its status on stderr. */
export type LoginStatusProbe = {
  args: string[];
  stream: "stdout" | "stderr";
} & ({ reads: "json" } | { reads: "text"; signedIn: RegExp; signedOut: RegExp });

/** Fixed on purpose: no route can name a program to run. command is the CLI, not the ACP adapter resolveAgent resolves (Q4.114). */
export const AGENT_LOGIN: Record<
  BuiltinAgentId,
  {
    command: string;
    /** null where the agent needs no sign-in at all. */
    args: string[] | null;
    interactiveStdin: boolean;
    logoutArgs: string[] | null;
    envNames: string[];
    status: LoginStatusProbe | null;
    executableEnv: string | null;
    /** Relative to HOME. Existence proves a login; absence proves nothing. */
    credentialPath: string | null;
  }
> = {
  claude: {
    command: "claude",
    args: ["auth", "login"],
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
    interactiveStdin: false,
    logoutArgs: null,
    envNames: ["KIMI_API_KEY"],
    status: null,
    executableEnv: null,
    credentialPath: ".kimi-code/credentials",
  },
  codex: {
    command: "codex",
    // Device-code: plain login needs a local browser on port 1455, which a headless daemon cannot offer.
    args: ["login", "--device-auth"],
    interactiveStdin: false,
    logoutArgs: ["logout"],
    // CODEX_API_KEY, not OPENAI_API_KEY: only the former is sent by the CLI from the environment.
    envNames: ["CODEX_API_KEY"],
    status: {
      args: ["login", "status"],
      stream: "stderr",
      reads: "text",
      // [ \t] and not \s: ^\s* under /m is quadratic on output this daemon did not write.
      signedIn: /^[ \t]*Logged in\b/im,
      signedOut: /^[ \t]*Not logged in\b/im,
    },
    // Also decides which binary sessions run, so login, probe and session drive one copy (Q4.114).
    executableEnv: "CODEX_PATH",
    credentialPath: null,
  },
  opencode: {
    command: "opencode",
    args: null,
    interactiveStdin: false,
    logoutArgs: null,
    envNames: ["OPENROUTER_API_KEY", "OPENCODE_API_KEY"],
    // null: opencode works with no credential, so a probe could only manufacture a false signed-out (Q7.99).
    status: null,
    executableEnv: null,
    credentialPath: ".local/share/opencode/auth.json",
  },
  grok: {
    command: "grok",
    // --no-auto-update leads every grok argv, or its updater replaces the build under a live session.
    args: ["--no-auto-update", "login", "--device-auth"],
    interactiveStdin: false,
    logoutArgs: ["--no-auto-update", "logout"],
    // Spent only through the ACP authenticate call; see ACP_AUTH_METHOD.
    envNames: ["XAI_API_KEY"],
    // Proves a credential is present, not that it works: a bogus XAI_API_KEY also reads as signed in.
    status: {
      args: ["--no-auto-update", "models"],
      stream: "stdout",
      reads: "text",
      signedIn: /^[ \t]*You are (?:logged in|using )/im,
      signedOut: /^[ \t]*You are not authenticated\b/im,
    },
    executableEnv: null,
    credentialPath: ".grok/auth.json",
  },
};

/** grok's own question timeout answers "declined" and tells the client nothing; the environment outranks the user's config (Q6.113). */
export const GROK_SPAWN_ENV: Readonly<Record<string, string>> = Object.freeze({
  GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED: "false",
});

/** The authenticate method id that spends a pasted key, sent only when that key is in the spawn environment: sent to a CLI-signed-in grok it breaks the session. Q6.20, Q6.110. */
export const ACP_AUTH_METHOD: Partial<Record<AgentId, string>> = {
  grok: "xai.api_key",
};

export function hasLoginFlow(agent: BuiltinAgentId): boolean {
  return AGENT_LOGIN[agent].args !== null;
}

export function credentialEnvNames(agent: BuiltinAgentId): readonly string[] {
  return AGENT_LOGIN[agent].envNames;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    // X_OK alone is satisfied by a directory.
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const PATH_HITS = new Map<string, string>();

/** A miss expires so an install shows up without a restart; a hit lasts until forgetPathHits. */
const PATH_MISS_TTL_MS = 30_000;

const PATH_MISSES = new Map<string, number>();

export function forgetPathHits(): void {
  PATH_HITS.clear();
  PATH_MISSES.clear();
}

/** Where deploy/agents.sh installs agent CLIs; appended after PATH, never before, so they cannot shadow system tools. */
export const MANAGED_CLI_DIRS: readonly string[] = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".opencode", "bin"),
  // ~/.grok/bin is deliberately absent: deploycheck requires every searched directory to be one deploy/agents.sh installs into.
  join(homedir(), ".reemoat", "toolchain", "bin"),
];

export function findOnPath(name: string): string | null {
  // Memoised: a synchronous PATH walk can block the event loop on a stalled network mount.
  const hit = PATH_HITS.get(name);
  if (hit !== undefined) return hit;
  const missedAt = PATH_MISSES.get(name);
  if (missedAt !== undefined && Date.now() - missedAt < PATH_MISS_TTL_MS) return null;

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

/** Neither adapter falls back to PATH, so a missing CLI is refused here rather than at spawn; an override is believed unchecked (Q4.114). */
function cliFor(agent: "claude" | "codex"): string | null {
  const login = AGENT_LOGIN[agent];
  const override = login.executableEnv === null ? "" : (process.env[login.executableEnv] ?? "").trim();
  if (override.length > 0) return override;
  return findOnPath(login.command);
}

function noCli(agent: "claude" | "codex"): string {
  const login = AGENT_LOGIN[agent];
  return (
    `${login.command} is not on this daemon's PATH or in the directories deploy/agents.sh installs into, ` +
    `and its adapter cannot run without it. Run deploy/agents.sh on this machine — behind a firewall, ` +
    `deploy/agents.sh --source npm — or name a copy in ${login.executableEnv ?? "the vendor's own variable"}.`
  );
}

/** Resolves the ACP adapter and refuses when its CLI is missing; which CLI copy runs is LocalRuntime.agentCli's decision. */
export function resolveAgent(id: string, machine?: HarnessCatalogue): AgentLaunchConfig {
  // Catalogue first, so a removed plugin's harness gets its own refusal rather than a missing-binary one.
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
        displayName: "Opencode CLI",
        command,
        args: ["acp"],
        env: agentEnv(),
        authHint:
          "opencode refused this session. It needs no signing in — with nothing configured it " +
          "runs on OpenCode Zen's free models — so this is a model whose provider wants a key. " +
          "Add one under Settings → Machines → this machine (OPENROUTER_API_KEY for OpenRouter's " +
          "catalogue, OPENCODE_API_KEY for the rest of Zen's), or pick one of the free models.",
      };
    }
    case "grok": {
      const command = findOnPath("grok");
      if (!command) {
        throw new AgentUnavailableError(
          "grok not found on this daemon's PATH. deploy/agents.sh installs it " +
            "(or `npm i -g @xai-official/grok`).",
          { installable: true },
        );
      }
      return {
        id,
        displayName: "Grok Build CLI",
        command,
        // --no-auto-update: src/agentupdate.ts decides when a build moves.
        // Never add --always-approve: it suppresses every permission request.
        args: ["--no-auto-update", "agent", "stdio"],
        env: { ...agentEnv(), ...GROK_SPAWN_ENV },
        authHint:
          "Grok refused this session. Sign in with the wizard on this machine, or paste an xAI " +
          "API key under Settings → Machines → this machine. A key from console.x.ai is what " +
          "works where no browser can be opened.",
      };
    }
  }
}

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

/** The user-level defaultMode exactly as written, never merged or normalised; null when absent, unreadable or unset. */
export async function claudeSettingsMode(options: { homeDir?: string } = {}): Promise<ClaudeSettingsMode | null> {
  const file = join(options.homeDir ?? homedir(), ".claude", "settings.json");
  const text = await probeText(file, MAX_CLAUDE_SETTINGS_BYTES);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Somebody's hand-edited file mid-save. Nothing to report is the honest answer.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const permissions = (parsed as { permissions?: unknown }).permissions;
  if (typeof permissions !== "object" || permissions === null) return null;
  const mode = (permissions as { defaultMode?: unknown }).defaultMode;
  if (typeof mode !== "string" || mode.trim().length === 0) return null;
  return { value: clipSettingsValue(mode.trim()), file };
}

export interface ClaudeSettingsMode {
  value: string;
  file: string;
}

const MAX_CLAUDE_SETTINGS_BYTES = 256 * 1024;

function clipSettingsValue(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 64)}…`;
}
