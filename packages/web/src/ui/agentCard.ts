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

/**
 * Five states, and the fifth is the only one that is good news.
 *
 * ⚠ **`no_login` is not "signed out" and not "cannot check".** It is an agent
 * that needs no sign-in at all: opencode reaches its own gateway anonymously —
 * measured, six models and a completed turn against an empty `XDG_DATA_HOME` with
 * no provider variables — so nothing here is missing and nothing needs doing. It
 * outranks the credential axis entirely, because a stored key changes what such
 * an agent can *reach* and never whether it runs.
 */
export type AgentStance = "not_installed" | "no_login" | "signed_in" | "signed_out" | "unchecked";

/**
 * Whether a harness is a complete answer on its own, with no model chosen.
 *
 * ⚠ **Three of the four *are* the model, and the fourth is a router.** Claude Code
 * runs Claude, Kimi Code runs Kimi, Codex runs GPT — tapping one of those is a
 * whole decision, and the agent that starts is the one the tile names. opencode is
 * not a model at all: it is a CLI that reaches somebody else's catalogue, and
 * started bare it picks `opencode/big-pickle` off its own anonymous free tier.
 * That is a model nobody chose, under a tile that names none.
 *
 * ⚠ **And a saved key does not fix it, which is the measurement that settles
 * this.** `pinNativeModel` returns at its first line when no model was asked for,
 * so a bare session pins nothing; and because the spawn merges saved secrets, a
 * machine with `OPENROUTER_API_KEY` on opencode's card gets a bare session that
 * publishes **362** models and still starts on `big-pickle`. The key widens the
 * catalogue and moves the default not at all. So this is not "opencode needs
 * setting up" — it is the most self-sufficient of the four — it is that the model
 * it runs is the one thing nobody on the screen decided.
 *
 * So it is not offered as a **starting point**. It is not removed: it is a harness
 * everywhere a harness is named — `POST /sessions` still accepts it, the agent
 * builder still offers it (paired with a system and a model, which is exactly what
 * it was missing), its settings card still shows its credential slots, and every
 * session already started on it resumes and draws as before.
 *
 * ⚠ **A different rule from "an unavailable harness stays, disabled, saying
 * why".** That one is about an agent this machine cannot run, where hiding the
 * tile answers "where did claude go" with silence. Here the harness runs
 * perfectly; what it has no answer for is *which model*. A disabled tile saying so
 * would be a control you have to tap to learn is not one, and the control that
 * *does* answer it — the `+` — is two tiles away in the same row.
 */
export function startsBare(agent: string): boolean {
  return agent !== "opencode";
}

/**
 * Whether an agent in this state gets a tile on the new-session strip at all.
 *
 * ⚠ **Reported from the app: "remove *signed in* from Claude Code, Kimi Code and
 * the rest — they should not be in the picker on the new session screen if they
 * are not signed in."** Two halves of one rule. The strip used to draw every
 * harness the daemon listed and explain the dead ones on a second line, so a
 * machine with one working agent showed three tiles, two of which were labels; and
 * the tile that *did* work spent its only line saying `signed in`, which is the
 * one state on that screen that needs no words — it is the state every tile in the
 * row is in now, and a fact true of everything visible identifies nothing.
 *
 * ⚠ **Two states out of five, and the three that stay are the point.**
 * `not_installed` and `signed_out` are the ones where "start a chat" is a lie.
 * `unchecked` stays, and that is the load-bearing arm: it is kimi's **permanent**
 * answer — `AGENT_LOGIN.kimi.status` is null, so `loggedIn` is never anything else
 * — and it is what claude or codex answers when a probe times out. Hiding on it
 * would delete kimi from this screen on every machine in the fleet and make a slow
 * probe look like an uninstall. `no_login` stays for the same reason one step
 * further on: opencode has nothing to sign in to, so it can never be signed in,
 * and it reaches this screen as an assembled agent rather than as a tile anyway.
 *
 * ⚠ **This hides a door, and the caller owes one back.** With every signed-out
 * harness out of the row, the sign-in wizard under the strip is no longer reached
 * by tapping the tile that says why — so `NewSession` hangs it off "this machine
 * offers no tile at all" instead, and the settings card is the other way in. That
 * is a real trade and it is the one that was asked for: a row of agents you can
 * start, rather than a row of agents with a status report under each.
 *
 * A predicate over the stance rather than over the listing, so `webcheck` sweeps
 * it across all five states and a sixth arrives as a decision rather than as a
 * silent `true`.
 */
export function offersTile(stance: AgentStance): boolean {
  return stance !== "not_installed" && stance !== "signed_out";
}
export type TokenBlock = "hidden" | "stored_only" | "editable";

/**
 * What each harness is called, in its own vendor's words.
 *
 * ⚠ **The *program*, not the company and not the model.** It read "Claude", "Kimi"
 * and "Codex" for several releases and the first of those was simply wrong:
 * Anthropic ships a program called **Claude Code**, and "Claude" is the model
 * family it happens to run — which is exactly the confusion this screen exists to
 * remove, since Claude Code can be pointed at Kimi K2 and a row reading "Claude"
 * beside a model reading "Kimi K2 Thinking" says the opposite of what is true.
 *
 * ⚠ **None of them may end in "CLI", and the check that catches it is this file's
 * own.** `webcheck` sweeps every sentence this module can produce against the
 * vocabulary the deleted wall was made of, and `CLI` is in it — a reader who has
 * never seen an environment variable must not meet an acronym either. Which is
 * lucky, because each vendor's own product name is the shorter one anyway:
 * **Claude Code**, **Kimi Code** (`~/.kimi-code`, and the `kimi-code/…` model ids
 * it publishes), **Codex**.
 *
 * Still never the package: "Codex", not "Codex (codex-acp)". The adapter is an
 * implementation detail of how this daemon speaks to the program, and the
 * daemon's own `displayName` carries it for whoever is reading a log.
 */
const AGENT_LABEL: Record<string, string> = {
  claude: "Claude Code",
  kimi: "Kimi Code",
  codex: "Codex",
  // ⚠ **Capitalised here and lowercase everywhere else, and the split is the
  // point of this table.** The vendor writes it lowercase in every place that is
  // a *name for a machine* — the binary, the package, the `agentInfo.name` it
  // answers `initialize` with, the ids this app stores and sends — and none of
  // those is changed by this line. What is changed is the one place it is read as
  // a **word**: it starts sentences here (`stanceLine`, `choiceRefusal`,
  // `hostable`), where a lowercase first letter reads as a typo rather than as a
  // brand, and it sits in a row beside Claude Code, Kimi Code and Codex, where it
  // was the only entry that looked like an unformatted id.
  //
  // It also gives the row below something to catch: with `?? id` producing
  // `opencode`, an entry that agrees with the fallback by luck is indistinguishable
  // from one that was chosen, and this one no longer does.
  opencode: "Opencode",
};

/** The program's own name. An id this build has never heard of is drawn as itself. */
export function agentLabel(id: string): string {
  return AGENT_LABEL[id] ?? id;
}

/**
 * The two axes, read as one state. They are **not** independent and reading them
 * as one boolean is what produced the disabled button: `available` is the
 * adapter, `login.supported` is `script` plus the agent's own CLI — a different
 * binary — so (adapter missing + wizard runnable) is a real state.
 */
export function agentStance(
  available: boolean,
  loggedIn: boolean | null | undefined,
  /**
   * Why the daemon says a sign-in cannot be run, when it says so.
   *
   * Only `"no_flow"` is read, and only that one is a *property of the agent*: the
   * other three are the host's — a missing `script`, a missing CLI, a pty this OS
   * will not hand a background service — and each of those still leaves an agent
   * that would sign in if it could. Optional because an older daemon sends no
   * `login` object at all, and its absence must read as "an ordinary agent".
   */
  blocked?: string | null,
): AgentStance {
  if (!available) return "not_installed";
  // Before the credential axis, deliberately. An agent with nothing to sign in to
  // is not "signed out" when it holds no key and not "cannot check" when its
  // status is unreadable — both of those describe a gap, and there is none.
  if (blocked === "no_flow") return "no_login";
  if (loggedIn === true) return "signed_in";
  if (loggedIn === false) return "signed_out";
  return "unchecked";
}

/**
 * The badge, as words and weight.
 *
 * ⚠ **Moved here from the panel, where nothing could reach it.** It decided four
 * states inline and `webcheck` drives only what this file exports, so the one
 * rule it carries — that "cannot check" is *not* an alarm — was held by a comment
 * and by nothing else. The fifth state is what forced the move: an agent needing
 * no sign-in would otherwise have been drawn as "cannot check", which is the
 * sentence this panel exists to avoid putting under a working agent.
 *
 * ⚠ **And the fifth state answers `null` — no badge at all, not a quieter one.**
 * It said `no sign-in needed`, which is a true sentence and still the wrong thing
 * to print: every other badge here reports a **state somebody may have to act on**,
 * and this one reported the absence of one. Under a tile it read as an answer to a
 * question nobody had asked, in a row of three agents that were all reporting
 * something. The status of an agent with nothing to report is nothing. Whether its
 * state *could* have been probed is not the reader's problem and is deliberately
 * not distinguished here — `unchecked` is a badge because an agent that has a
 * sign-in and cannot be asked about it is a real gap; `no_login` is not.
 *
 * The explanation did not go with it: {@link stanceLine} still says, in the one
 * place with room for a sentence, that nothing is missing and what the key box
 * below is for. A badge is not where that belonged.
 */
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
    // "cannot check" and not "status unknown": for kimi this is the permanent,
    // correct answer — `AGENT_LOGIN.kimi.status` is null — and naming it a fault
    // would put a warning on every kimi in the fleet.
    case "unchecked":
      return { tone: "plain", text: "cannot check" };
  }
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
  // `no_login` falls through to editable on purpose, and it is the one state where
  // the box is not a remedy: nothing is broken, and a key here buys *more models*
  // rather than admission. Hiding it would hide the only control this agent has.
  return "editable";
}

/** At most one sentence, and empty in the two commonest states. */
export function stanceLine(
  id: string,
  stance: AgentStance,
  canSignIn: boolean,
  /**
   * The daemon's platform, when it is the reason. See `osName`.
   *
   * The sentence is the *only* place this is explained, so it is the place that
   * has to name the culprit: "this machine can't" reads as something misconfigured
   * on your box, when the truth is that the OS cannot give a background service the
   * terminal this login needs. Absent on an older daemon, which falls back to the
   * wording that names nothing.
   */
  os?: string,
): string | null {
  const name = agentLabel(id);
  const host = osName(os);
  /*
   * ⚠ **First, and it is the only sentence here that is not an apology.** Every
   * other branch explains something missing; this one explains that nothing is.
   * Ordered above `not_installed` would be wrong — an agent that is not there
   * cannot run anything — but above the three credential states is exactly right,
   * because none of them is true of an agent with nothing to sign in to.
   *
   * It names what a key *does* buy, because the box is still drawn below it and a
   * control with no stated purpose is the thing this screen keeps deleting.
   */
  if (stance === "no_login") {
    // Two short sentences and no third: this is the only line on the card now, and
    // the second half is the only thing that says what the box below it is for.
    return `${name} needs no sign-in. A key below adds the models it can reach.`;
  }
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
      : `${host} can't run ${name}'s own sign-in, so a saved key is the only way in.`;
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
    : ` ${host} can't run ${name}'s own sign-in either, so a saved key is the only way in.`;
  return `${why} ${name} may well be working — start a chat to find out.${cannotRun}`;
}

/**
 * The six credentials the daemon can send, by what they are rather than by the
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
  OPENROUTER_API_KEY: {
    name: "OpenRouter API key",
    note: "A key from your OpenRouter account. It adds OpenRouter's whole catalogue to Opencode's model list.",
  },
  OPENCODE_API_KEY: {
    name: "OpenCode Zen key",
    note: "A key from your OpenCode Zen account. The free models work without one.",
  },
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
  /*
   * ⚠ **opencode had one and it is deleted rather than reworded.** It said a key
   * was not needed to get started, which is true, measured, and exactly what
   * {@link stanceLine} says one line higher on the same card — and this one is
   * drawn *per slot*, so on the agent that happens to have two it appeared twice,
   * under two different keys, saying the same thing about neither of them. A
   * caveat is for what somebody must read **before typing**, and "you may not need
   * to type anything" is a fact about the agent, which is where it now lives
   * alone.
   */
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
export function dividerWord(
  stance: AgentStance,
  signInAbove: boolean,
  block: TokenBlock,
): string | null {
  if (block === "hidden") return null;
  /*
   * ⚠ **"instead" needs a first option, and one agent has none.** It read
   * `Sign in with a key instead` over an agent with no sign-in at all, under a
   * heading, under a rule, with nothing above the line for the key to be instead
   * *of*. The other arm of that ternary is `or`, which is drawn *between* two
   * things and is guarded for exactly this reason two lines down; this one was
   * not, because until there was a fourth agent there was always a sign-in above.
   * There is nothing to divide here, so there is no divider.
   */
  if (stance === "no_login") return null;
  if (block === "stored_only") return "Saved keys";
  return signInAbove ? "or" : "Sign in with a key instead";
}

/**
 * What to call the host in a sentence that blames it.
 *
 * **Named by the daemon, never guessed.** The refusal this explains is returned
 * for every BSD, so a hardcoded "macOS" would tell a FreeBSD operator something
 * false about their own machine — in the one sentence whose whole job is to say
 * the fault is not theirs. An older daemon reports no platform, and the fallback
 * names nothing rather than the wrong thing.
 */
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
