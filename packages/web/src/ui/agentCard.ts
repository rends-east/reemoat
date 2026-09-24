import { isBuiltinAgentId } from "../wire";

/** `start_refused` is a measured refusal (`auth_required`) and never means signed out. */
export type AgentStance =
  | "not_installed"
  | "start_refused"
  | "no_login"
  | "signed_in"
  | "signed_out"
  | "unchecked";

/** False for opencode: started bare it runs a model nobody chose. */
export function startsBare(agent: { id: string }): boolean {
  // A contributed harness is never a starting point (Q3.522).
  return isBuiltinAgentId(agent.id) ? agent.id !== "opencode" : false;
}

/** `unchecked` keeps the tile: it is kimi's permanent answer. */
export function offersTile(stance: AgentStance): boolean {
  switch (stance) {
    case "not_installed":
    case "signed_out":
    case "start_refused":
      return false;
    case "no_login":
    case "signed_in":
    case "unchecked":
      return true;
  }
}
export type TokenBlock = "hidden" | "stored_only" | "editable";

// The program's name, never the model or the package; none may end in "CLI".
const AGENT_LABEL: Record<string, string> = {
  claude: "Claude Code",
  kimi: "Kimi Code",
  codex: "Codex",
  opencode: "Opencode",
  grok: "Grok",
};

export function agentLabel(id: string): string {
  return AGENT_LABEL[id] ?? id;
}

/** Mirrors the daemon's `MAX_CONTRIBUTED_NAME_CHARS`; a drawn ceiling, not a filter. */
export const MAX_HARNESS_NAME_CHARS = 32;

export function boundedName(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const clean = raw.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  if (clean.length === 0) return fallback;
  // By character, so a surrogate pair is never split.
  const runes = Array.from(clean);
  return runes.length > MAX_HARNESS_NAME_CHARS ? runes.slice(0, MAX_HARNESS_NAME_CHARS).join("") : clean;
}

// Includes zero-width characters the whitespace class misses.
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Never the daemon's `displayName`, which names the package. */
export function harnessName(agent: { id: string; label?: string }): string {
  return AGENT_LABEL[agent.id] ?? boundedName(agent.label, agent.id);
}

export function agentStance(
  available: boolean,
  loggedIn: boolean | null | undefined,
  blocked?: string | null,
  refused?: boolean,
): AgentStance {
  if (!available) return "not_installed";
  if (refused === true) return "start_refused";
  if (blocked === "no_flow") return "no_login";
  if (loggedIn === true) return "signed_in";
  if (loggedIn === false) return "signed_out";
  return "unchecked";
}

export function agentBadge(stance: AgentStance): { tone: "plain" | "strong"; text: string } | null {
  switch (stance) {
    case "not_installed":
      return { tone: "strong", text: "not installed" };
    case "no_login":
      return null;
    case "signed_in":
      return { tone: "plain", text: "signed in" };
    case "signed_out":
      return { tone: "strong", text: "not signed in" };
    case "start_refused":
      return { tone: "strong", text: "would not start" };
    case "unchecked":
      return { tone: "plain", text: "cannot check" };
  }
}

/** A stored key is never hidden, in any stance. */
export function tokenBlockFor(stance: AgentStance, stored: number): TokenBlock {
  if (stance === "not_installed" || stance === "signed_in") return stored > 0 ? "stored_only" : "hidden";
  return "editable";
}

export function stanceLine(
  agent: { id: string; label?: string },
  stance: AgentStance,
  canSignIn: boolean,
  os?: string,
  installable?: boolean,
): string | null {
  const name = harnessName(agent);
  const host = osName(os);
  if (stance === "no_login") {
    return "No sign-in needed. A key adds more models.";
  }
  if (stance === "not_installed") {
    return installable === true
      ? `${name} isn't installed on this machine.`
      : `${name} isn't installed. Install it on the machine itself.`;
  }
  if (stance === "start_refused") {
    return canSignIn
      ? `${name} refused to start.`
      : `${name} refused to start. Sign in on the machine, or paste a key.`;
  }
  if (stance === "signed_in") return null;
  if (stance === "signed_out") {
    // Pinned verbatim by `webcheck`.
    return canSignIn
      ? null
      : `${host} can't run ${name}'s own sign-in, so a saved key is the only way in.`;
  }
  const why =
    agent.id === "kimi"
      ? `${name} doesn't report sign-in state.`
      : `${name}'s sign-in state is unknown.`;
  return canSignIn
    ? `${why} Start a chat to find out.`
    : `${why} ${host} can't run sign-in; paste a key.`;
}

export const CREDENTIAL_LABELS: Record<string, { name: string; note: string }> = {
  CLAUDE_CODE_OAUTH_TOKEN: { name: "Claude subscription token", note: "From the machine, not a website." },
  ANTHROPIC_API_KEY: { name: "Anthropic API key", note: "From your Anthropic account." },
  KIMI_API_KEY: { name: "Kimi API key", note: "From your Kimi account." },
  CODEX_API_KEY: { name: "OpenAI API key", note: "From your OpenAI account." },
  OPENROUTER_API_KEY: { name: "OpenRouter API key", note: "From your OpenRouter account." },
  OPENCODE_API_KEY: { name: "OpenCode Zen key", note: "Optional; the free models need none." },
  XAI_API_KEY: { name: "xAI API key", note: "From your xAI account." },
};

export function credentialLabel(envName: string): { name: string; note: string } {
  const known = CREDENTIAL_LABELS[envName];
  if (known !== undefined) return known;
  const words = envName.toLowerCase().replace(/_/g, " ");
  return { name: words.charAt(0).toUpperCase() + words.slice(1), note: "A key this agent reads." };
}

/** Measured caveats only (Q2.200, Q2.201). */
export function credentialCaveat(id: string, canSignIn: boolean): string | null {
  if (id === "codex") {
    return canSignIn
      ? "A key won't sign Codex in; use Sign in above."
      : "A key won't sign Codex in; use the host's sign-in.";
  }
  if (id === "kimi") {
    return "Kimi may prefer the key on the machine.";
  }
  return null;
}

export function multiSlotLine(agent: { id: string; label?: string }, slots: number): string | null {
  // Unused; kept in the signature for both callers.
  void agent;
  return slots > 1 ? "Either one is enough." : null;
}

export function storedChip(agent: { id: string; label?: string }, stance: AgentStance): string {
  const name = harnessName(agent);
  if (stance === "signed_out") return `saved — ${name} still isn't signed in`;
  if (stance === "not_installed") return `saved — ${name} isn't installed, so nothing is reading it`;
  if (stance === "start_refused") return `saved — ${name} still wouldn't start`;
  return "saved";
}

export function signOutSentence(id: string, stored: number): string {
  const name = agentLabel(id);
  return stored > 0
    ? `${name} can't be signed out from here. Remove the key below.`
    : `${name} can't be signed out from here. Clear it on the machine itself.`;
}

export function dividerWord(
  stance: AgentStance,
  signInAbove: boolean,
  block: TokenBlock,
): string | null {
  if (block === "hidden") return null;
  if (stance === "no_login") return null;
  if (block === "stored_only") return "Saved keys";
  if (stance === "start_refused" && !signInAbove) return null;
  return signInAbove ? "or" : "or paste a key";
}

export const STALE_READ = "Machine status may be out of date.";

/** Named by the daemon, never guessed. */
export function osName(os: string | undefined): string {
  switch (os) {
    case "darwin":
      return "macOS";
    case "freebsd":
      return "FreeBSD";
    case "openbsd":
      return "OpenBSD";
    case "netbsd":
      return "NetBSD";
    default:
      return "This machine";
  }
}
