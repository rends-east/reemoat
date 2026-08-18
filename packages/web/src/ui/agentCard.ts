/**
 * What one agent's card says, as data rather than as JSX.
 *
 * The card used to render `agent.hint` verbatim: five lines of adapter-vs-CLI,
 * `claude setup-token`, `~/.codex/auth.json` and `session/new … -32000`, written
 * for whoever runs the daemon and read by whoever is holding the phone. The
 * daemon still sends it and still needs it — the same string is the body of the
 * session-start failure at `src/session.ts` — so the wall is removed here, in
 * words derived from the three facts the client already holds.
 *
 * Pure and exported one rule at a time, because `webcheck` asserts these and
 * reads no `.tsx` file in this package.
 */

export type AgentStance = "not_installed" | "signed_in" | "signed_out" | "unchecked";
export type TokenBlock = "hidden" | "stored_only" | "editable";

const AGENT_LABEL: Record<string, string> = { claude: "Claude", kimi: "Kimi", codex: "Codex" };

/** "Codex", never "Codex (codex-acp)" — the package name is the wall in miniature. */
export function agentLabel(id: string): string {
  return AGENT_LABEL[id] ?? id;
}

/**
 * The two axes, read as one state. They are **not** independent and reading them
 * as one boolean is what produced the disabled button: `available` is the
 * adapter, `login.supported` is `script` plus the agent's own CLI — a different
 * binary — so (adapter missing + wizard runnable) is a real state.
 */
export function agentStance(available: boolean, loggedIn: boolean | null | undefined): AgentStance {
  if (!available) return "not_installed";
  if (loggedIn === true) return "signed_in";
  if (loggedIn === false) return "signed_out";
  return "unchecked";
}

/**
 * Whether the key rows are drawn, and whether anything may be typed into them.
 *
 * **A stored key is never hidden, in any stance**, and that is the whole reason
 * this is a function: the previous shape hid the block whenever the agent was
 * signed in, and a pasted `KIMI_API_KEY` is by itself enough to make kimi report
 * signed in — so the token could not be removed from the UI at all, under a
 * sentence sending the reader to a file on the host when it was a row in the
 * daemon's own SQLite. `webcheck` asserts it over the whole grid.
 *
 * Nothing is typeable where nothing can help: with the adapter missing,
 * `resolveAgent` throws before any spawn, so an input that saves successfully
 * and changes nothing is a control that is not true in the state it is drawn in.
 */
export function tokenBlockFor(stance: AgentStance, stored: number): TokenBlock {
  if (stance === "not_installed" || stance === "signed_in") return stored > 0 ? "stored_only" : "hidden";
  return "editable";
}

/** At most one sentence, and empty in the two commonest states. */
export function stanceLine(id: string, stance: AgentStance, canSignIn: boolean): string | null {
  const name = agentLabel(id);
  if (stance === "not_installed") {
    return `${name} isn't installed on this machine. Nothing on this screen can change that — it has to be installed on the machine itself.`;
  }
  // Signed in, and signed out with a way in: the badge says it and the control
  // below does something about it. A sentence here can only be self-reference,
  // which is what the deleted paragraph's second clause was.
  if (stance === "signed_in") return null;
  if (stance === "signed_out") {
    return canSignIn
      ? null
      : `This machine can't run ${name}'s own sign-in, so a saved key is the only way in.`;
  }
  // "cannot tell" is kimi's permanent, correct answer and claude's or codex's
  // accident. The load-bearing half of `cannotAskHint` is the same either way:
  // do not panic, sessions may still work.
  const why =
    id === "kimi"
      ? `${name} doesn't report whether it's signed in. That's normal.`
      : `This machine couldn't check whether ${name} is signed in.`;
  const cannotRun = canSignIn
    ? ""
    : ` This machine can't run ${name}'s own sign-in either, so a saved key is the only way in.`;
  return `${why} ${name} may well be working — start a chat to find out.${cannotRun}`;
}

/**
 * The four credentials the daemon can send, by what they are rather than by the
 * variable a CLI reads them from. The raw name was the visible label *and* the
 * `aria-label`, so a screen reader spelled out
 * "C L A U D E underscore C O D E underscore O A U T H underscore T O K E N".
 * It survives as a `title` and as the wire key, and nowhere else.
 */
export const CREDENTIAL_LABELS: Record<string, { name: string; note: string }> = {
  CLAUDE_CODE_OAUTH_TOKEN: {
    name: "Claude subscription token",
    note: "A sign-in token made on the machine itself — not a key from a website.",
  },
  ANTHROPIC_API_KEY: { name: "Anthropic API key", note: "A key from your Anthropic account." },
  KIMI_API_KEY: { name: "Kimi API key", note: "A key from your Kimi account." },
  CODEX_API_KEY: { name: "OpenAI API key", note: "A key from your OpenAI account." },
};

export function credentialLabel(envName: string): { name: string; note: string } {
  const known = CREDENTIAL_LABELS[envName];
  if (known !== undefined) return known;
  // A newer daemon with a fifth credential. Humanised rather than raw, and
  // `webcheck` fails on the daemon's own list before anybody meets this.
  const words = envName.toLowerCase().replace(/_/g, " ");
  return { name: words.charAt(0).toUpperCase() + words.slice(1), note: "A key this agent reads." };
}

/**
 * The one caveat per agent that a person must read **before** typing, and the
 * only place a measurement survives the cull.
 *
 * Codex's is the load-bearing sentence on the whole screen (Q2.200): with
 * `CODEX_API_KEY` set and no real login, `codex-acp` still answers `session/new`
 * with -32000. It does not overclaim — the key IS merged last at spawn and does
 * reach codex's own API calls, so "won't start a chat on its own" is true where
 * "does nothing" would be false.
 */
export function credentialCaveat(id: string, canSignIn: boolean): string | null {
  if (id === "codex") {
    return canSignIn
      ? "A key on its own does not sign Codex in — it will still refuse to start a chat. Use Sign in to Codex above and finish it on the page that opens."
      : "A key on its own does not sign Codex in — it will still refuse to start a chat. Codex has to be signed in on the machine itself.";
  }
  if (id === "kimi") {
    return "Some Kimi setups ignore a key saved here and use the one kept on the machine instead. If signing in works, prefer that.";
  }
  return null;
}

/** Claude is the only agent with two, and they are not interchangeable. */
export function multiSlotLine(id: string, slots: number): string | null {
  return slots > 1 ? `${agentLabel(id)} takes either one — you only need one of them.` : null;
}

/**
 * What a saved key is worth, rather than that it was saved.
 *
 * The chip reported storage and never effect, so `✓ set` sat beside a badge
 * reading "not signed in" with nothing reconciling them. The `signed_out` arm is
 * a measured claim: `probe` merges the pasted secret into the child's
 * environment, so a clean `false` is the CLI having seen that key and refused it.
 */
export function storedChip(id: string, stance: AgentStance): string {
  const name = agentLabel(id);
  if (stance === "signed_out") return `saved — ${name} still isn't signed in`;
  if (stance === "not_installed") return `saved — ${name} isn't installed, so nothing is reading it`;
  // `unchecked` is unreachable with a key stored: every `null` arm of
  // `readLoginState` ends `return pasted ? true : null`. Kept so this is total.
  return "saved";
}

/** kimi only. `POST /agent-auth/:agent/logout` answers 503 for it, so no button may be drawn. */
export function signOutSentence(id: string, stored: number): string {
  const name = agentLabel(id);
  return stored > 0
    ? `${name} has no way to sign out. You can remove the saved key below — anything ${name} saved on the machine itself stays until somebody clears it there.`
    : `${name} has no way to sign out. Once it's signed in on a machine it stays signed in until somebody clears it on the machine itself.`;
}

/** An "or" is only drawn when there is something on both sides of it. */
export function dividerWord(signInAbove: boolean, block: TokenBlock): string | null {
  if (block === "hidden") return null;
  if (block === "stored_only") return "Saved keys";
  return signInAbove ? "or" : "Sign in with a key instead";
}
