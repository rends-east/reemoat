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

import { isBuiltinAgentId } from "../wire";

/**
 * Six states, and only one of them is good news.
 *
 * ⚠ **`no_login` is not "signed out" and not "cannot check".** It is an agent
 * that needs no sign-in at all: opencode reaches its own gateway anonymously —
 * measured, six models and a completed turn against an empty `XDG_DATA_HOME` with
 * no provider variables — so nothing here is missing and nothing needs doing. It
 * outranks the credential axis entirely, because a stored key changes what such
 * an agent can *reach* and never whether it runs.
 *
 * ⚠ **`start_refused` is not "signed out" either, and it is the only member here
 * that is a *measurement* rather than a reading of two flags.** The daemon tried
 * to open a session and the agent declined with ACP's `auth_required`. That is
 * why it sits above `no_login`: an agent with nothing to sign in to still has
 * something to report once it has refused, and "needs no sign-in" drawn over a
 * harness that just would not start is the sentence this member exists to stop.
 * It is *below* `not_installed`, because a harness that is not there cannot have
 * refused anything and the older fact is the more useful one.
 *
 * ⚠ **And it is not `signed_out`, though it draws a similar badge.** A harness
 * with no status probe can never be known signed out — see
 * `AgentInfo.lastStartRefusal` — so collapsing the two would put this app's
 * "not signed in" over a state it has no evidence for, and `stanceLine`'s
 * signed-out arm would then blame the host's missing `script` for something that
 * has nothing to do with the host.
 */
export type AgentStance =
  | "not_installed"
  | "start_refused"
  | "no_login"
  | "signed_in"
  | "signed_out"
  | "unchecked";

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
export function startsBare(agent: { id: string }): boolean {
  /*
   * ⚠ **Two arms, and the contributed one is a flat `false`.** For the four this
   * product ships the answer is a literal and stays one: this is the list
   * `webcheck` sweeps to assert that exactly one of them is not a starting point,
   * and deriving it from the wire would make that assertion a statement about
   * whatever the daemon happened to say.
   *
   * ⚠ **For a harness a plugin added it was `standalone === true` off the manifest,
   * and that field is gone — a plugin adds a harness, never an agent.** Spelling
   * the default as "no tile" made the wrong answer rarer without making it
   * unsayable: an author writes `true`, and the claim it makes is the one thing in
   * that manifest nothing here can check. This function's subject is the **model**,
   * and a harness this product has never run cannot be known to be its own; the
   * cost of guessing wrong is Q3.522's, with somebody else's binary — a session
   * billed to the operator, on a model no tile names, and unlike opencode a client
   * cannot even find out afterwards what it ran.
   *
   * It is not a demotion, which is the whole of what this file argues about
   * opencode: the harness is offered everywhere a harness is named — the builder,
   * `POST /sessions`, its own settings card — and what it needs first is a model.
   * An agent built on it is something a person assembled and named, which is the
   * only way an agent has ever been made here.
   */
  return isBuiltinAgentId(agent.id) ? agent.id !== "opencode" : false;
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
 * ⚠ **Three states out of six, and the three that stay are the point.**
 * `not_installed`, `signed_out` and `start_refused` are the ones where "start a
 * chat" is a lie — the third by measurement rather than by inference, which is
 * what makes it the only one of the three that can be true of a harness whose
 * `loggedIn` is permanently `null`.
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
 * it across all six states and a seventh arrives as a decision rather than as a
 * silent `true`.
 *
 * ⚠ **A `switch` with a `never` arm, and it was a pair of `!==` tests.** That
 * spelling answered `true` for anything it had not heard of — so the sixth member
 * would have kept its tile, silently, which is the exact outcome the paragraph
 * above claims cannot happen. It is `AgentGlyph`'s lesson in another file: a
 * default that reads as safe is not the same thing as a default that was decided.
 */
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
 * How long a name somebody else wrote may be before it is cut.
 *
 * ⚠ **A bound rather than a filter, and the difference is the whole rule.**
 * `noJargon` forbids *wire vocabulary in this app's own templates* — it is a
 * predicate over the sentences here, never a content filter over the nouns
 * substituted into them, which are and always were somebody else's prose. A
 * provider legitimately called "Anthropic-Compatible Gateway" is truthful, and
 * refusing it would be this app renaming somebody's product.
 *
 * What has to be bounded is the *shape*: these strings land in one-line
 * `truncate`d sublines (`No <provider> key on this machine.`), in an `aria-label`
 * built by joining with commas, and in headings on a phone. 32 is
 * `MAX_CONTRIBUTED_NAME_CHARS` on the daemon, restated rather than imported —
 * `packages/web` may not import from `src/` — and it is a ceiling on what is
 * *drawn* rather than a second validator: a daemon older or newer than this tab is
 * the case this has to survive.
 */
export const MAX_HARNESS_NAME_CHARS = 32;

/**
 * A name a plugin wrote, made safe to put in a sentence.
 *
 * Trimmed, whitespace collapsed, C0/C1 and bidi controls removed, then cut. The
 * control characters are the half that is not about width: a newline makes one
 * line into two inside a row that reserved one, and an override reorders the
 * sentence around it — including sentences this app wrote.
 */
export function boundedName(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const clean = raw.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  if (clean.length === 0) return fallback;
  /*
   * ⚠ **Cut by *character* and not by code unit.** `slice` counts UTF-16 units, so
   * a name whose 32nd character is astral was cut through the middle of a surrogate
   * pair and rendered as `U+FFFD` — a name ending in a replacement glyph, on a tile.
   * `MonogramGlyph` one file over uses `Array.from` for exactly this reason and
   * this did not.
   */
  const runes = Array.from(clean);
  return runes.length > MAX_HARNESS_NAME_CHARS ? runes.slice(0, MAX_HARNESS_NAME_CHARS).join("") : clean;
}

/**
 * Characters that are not a name.
 *
 * ⚠ **Two classes, and the second is the one a shorter list misses.** C0/C1 and
 * the well-known bidi controls are the obvious half — a newline makes one line into
 * two inside a row that reserved one, and an override reorders the sentence around
 * it, including sentences this app wrote. The other half is *zero-width*:
 * `U+061C` is a bidi control too and is not in the `U+202A–E` block anybody reaches
 * for; `U+200B`, `U+2060`, `U+FEFF` and `U+00AD` are invisible and are **not**
 * matched by JavaScript's `\s`, so a name of nothing but those survived `trim()`
 * as a non-empty string and drew a blank, unsearchable row. Replaced with a space
 * rather than deleted, so the collapse-and-trim below turns that case into the
 * fallback instead of into nothing.
 */
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * What a screen calls this harness.
 *
 * ⚠ **Never the daemon's `displayName`, which is the trap this exists to close.**
 * That field is a log line and carries the program: `Claude (claude-agent-acp)`,
 * `Kimi Code CLI`. Two of the four built-ins would fail this file's own rule
 * against a label naming a package or ending in `CLI`, and `webcheck` sweeps for
 * exactly those words — so a client that reached for `displayName` when
 * `AGENT_LABEL` had no row would have put the adapter's package name on a 96px
 * tile the first time a harness arrived it did not know.
 *
 * The order is: this product's own table, then the manifest's `label` bounded,
 * then the id. The last is unchanged and is what `webcheck` already pins.
 */
export function harnessName(agent: { id: string; label?: string }): string {
  return AGENT_LABEL[agent.id] ?? boundedName(agent.label, agent.id);
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
  /**
   * Whether the daemon is still holding a refused start for this harness.
   *
   * ⚠ **Added rather than folded into `loggedIn`, and tested above `blocked`
   * rather than below it.** It is the only input here that is a measurement — the
   * daemon opened a session and the agent declined — so it outranks the two
   * arms below, which describe an *absence*: no wizard, no readable status.
   * Absent means nothing has been observed, which is what an older daemon says
   * and what every one of this function's existing cells asserts.
   */
  refused?: boolean,
): AgentStance {
  if (!available) return "not_installed";
  // Above the two arms below, because those describe an absence and this is
  // something that happened. See the type's own note.
  if (refused === true) return "start_refused";
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
    /*
     * ⚠ **"would not start", and never "not signed in".** This badge reports what
     * was *observed* — the agent declined to open a session — and the app has no
     * evidence about a credential: for every harness that can reach this state
     * there is no status to probe, which is why `loggedIn` is `null` under it.
     * "not signed in" would be this screen diagnosing, and the remedy it implies
     * (paste a key) is only one of the two, the other being to run the CLI once on
     * the machine itself. `stanceLine` has the room to say both; a badge does not.
     */
    case "start_refused":
      return { tone: "strong", text: "would not start" };
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
  //
  // `start_refused` falls through too, and there it is the strongest remedy the
  // screen has: the harnesses that can reach that state are the ones with no
  // sign-in to run, so the box below is the only thing on this card that can
  // change the answer. Weighed rather than inherited.
  return "editable";
}

/** At most one sentence, and empty in the two commonest states. */
export function stanceLine(
  /**
   * The row, not the id — and that is a correction rather than a widening.
   *
   * ⚠ **Every sentence below named the agent with `agentLabel`, which answers the
   * bare id for anything this product does not ship.** So a harness a plugin added
   * has been drawing `byo:gemini needs no sign-in.` on its settings card since
   * contributed harnesses landed: a namespaced identifier in the subject position
   * of a sentence written for somebody holding a phone. `harnessName` is where the
   * two sources of a name meet, and it needs the `label` the daemon sends.
   */
  agent: { id: string; label?: string },
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
  const name = harnessName(agent);
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
    // No name in it: the card's heading is the name, 20px above.
    return "No sign-in needed. A key adds more models.";
  }
  if (stance === "not_installed") {
    return `${name} isn't installed. Install it on the machine itself.`;
  }
  /*
   * ⚠ **It blames the harness, and it must never blame the host.** The
   * signed-out arm below names the platform, because there the fault genuinely is
   * the host's — this OS will not give a background service a terminal. Here the
   * agent was asked to open a session and said no, which is true on every
   * platform, and `${host} can't run …` would send somebody to look at their own
   * machine for a refusal that came from somewhere else.
   *
   * ⚠ **And it reports rather than diagnoses.** This app does not know *why* the
   * agent refused — the harnesses that reach this state have no status to probe —
   * so the sentence says what happened and names both remedies where there is no
   * button for either. Where there is a wizard the button is directly below and
   * naming it here would be the self-reference this file keeps deleting.
   */
  if (stance === "start_refused") {
    return canSignIn
      ? `${name} refused to start last time.`
      : `${name} refused to start last time. Sign in on the machine, or paste a key.`;
  }
  // Signed in, and signed out with a way in: the badge says it and the control
  // below does something about it. A sentence here can only be self-reference,
  // which is what the deleted paragraph's second clause was.
  if (stance === "signed_in") return null;
  if (stance === "signed_out") {
    // ⚠ Pinned verbatim for `darwin`/claude in `webcheck` — the one sentence
    // whose whole job is to say the fault is the host's and not the reader's,
    // and it is the only arm of this function that survived the 2026-09-04 cut
    // unshortened, because every shorter form dropped the "own" that makes it
    // true: the wizard is the CLI's, and the OS refuses it a terminal.
    return canSignIn
      ? null
      : `${host} can't run ${name}'s own sign-in, so a saved key is the only way in.`;
  }
  // "cannot tell" is kimi's permanent, correct answer and claude's or codex's
  // accident. The load-bearing half of `cannotAskHint` is the same either way:
  // sessions may still work, and a chat is how to find out. "That's normal" is
  // gone — reassurance about a state the sentence already declines to alarm
  // over is a second sentence saying the first one (decision 11A).
  const why =
    agent.id === "kimi"
      ? `${name} doesn't report sign-in state.`
      : `This machine couldn't check whether ${name} is signed in.`;
  const cannotRun = canSignIn ? "" : ` ${host} can't run ${name}'s sign-in — paste a key.`;
  return `${why} Start a chat to find out.${cannotRun}`;
}

/**
 * The six credentials the daemon can send, by what they are rather than by the
 * variable a CLI reads them from. The raw name was the visible label *and* the
 * `aria-label`, so a screen reader spelled out
 * "C L A U D E underscore C O D E underscore O A U T H underscore T O K E N".
 * It survives as a `title` and as the wire key, and nowhere else.
 */
export const CREDENTIAL_LABELS: Record<string, { name: string; note: string }> = {
  // Every note at six words or fewer: it sits under a field that already has a
  // name, so what is left to say is *where the value comes from* and, for the
  // one slot that is not a website key, that it is not one.
  CLAUDE_CODE_OAUTH_TOKEN: { name: "Claude subscription token", note: "Made on the machine, not a website." },
  ANTHROPIC_API_KEY: { name: "Anthropic API key", note: "From your Anthropic account." },
  KIMI_API_KEY: { name: "Kimi API key", note: "From your Kimi account." },
  CODEX_API_KEY: { name: "OpenAI API key", note: "From your OpenAI account." },
  OPENROUTER_API_KEY: { name: "OpenRouter API key", note: "From your OpenRouter account." },
  OPENCODE_API_KEY: { name: "OpenCode Zen key", note: "Optional — the free models need none." },
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
 * reach codex's own API calls, so "won't sign Codex in" is true where "does
 * nothing" would be false.
 *
 * ⚠ **A caveat about another product survives only when it is measured and at
 * most ten words** (decision 11A). Both of these are measurements — Q2.200 for
 * codex, Q2.201 for kimi, whose `KIMI_API_KEY` applies according to the
 * installation's own `config.toml` rather than to this daemon — and each was
 * twice this length, spending its second sentence on advice ("finish it on the
 * page that opens", "if signing in works, prefer that") that the control beside
 * it already gives. What is kept is the fact a person must hold before typing.
 */
export function credentialCaveat(id: string, canSignIn: boolean): string | null {
  if (id === "codex") {
    return canSignIn
      ? "A key won't sign Codex in — use Sign in above."
      : "A key won't sign Codex in — sign in on the host.";
  }
  if (id === "kimi") {
    return "Kimi may prefer the key on the machine.";
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
export function multiSlotLine(agent: { id: string; label?: string }, slots: number): string | null {
  // The row, for `stanceLine`'s reason: this is the last sentence on the card that
  // was still naming a contributed harness by its namespaced id.
  // The name is dropped rather than kept: the sentence is drawn between the two
  // slots it is about, under a card headed by the harness, so "either one" has
  // its subject on screen twice already. The row stays in the signature — the
  // two callers hand it over, and a sentence that names the harness again is
  // one edit away — so it is consumed rather than renamed.
  void agent;
  return slots > 1 ? "Either one is enough." : null;
}

/**
 * What a saved key is worth, rather than that it was saved.
 *
 * The chip reported storage and never effect, so `✓ set` sat beside a badge
 * reading "not signed in" with nothing reconciling them. The `signed_out` arm is
 * a measured claim: `probe` merges the pasted secret into the child's
 * environment, so a clean `false` is the CLI having seen that key and refused it.
 */
export function storedChip(agent: { id: string; label?: string }, stance: AgentStance): string {
  const name = harnessName(agent);
  if (stance === "signed_out") return `saved — ${name} still isn't signed in`;
  if (stance === "not_installed") return `saved — ${name} isn't installed, so nothing is reading it`;
  // The chip's whole job is to stop a green tick reading as "and it works". A key
  // is stored, the agent has seen it — the spawn merges it — and it still would
  // not start, which is the one arm where "saved" alone would be misleading in
  // the direction that matters.
  if (stance === "start_refused") return `saved — ${name} still wouldn't start`;
  // `unchecked` is unreachable with a key stored: every `null` arm of
  // `readLoginState` ends `return pasted ? true : null`. Kept so this is total.
  return "saved";
}

/** kimi only. `POST /agent-auth/:agent/logout` answers 503 for it, so no button may be drawn. */
export function signOutSentence(id: string, stored: number): string {
  const name = agentLabel(id);
  // "from here", because it is not that the harness cannot be signed out — it is
  // that nothing on this screen can do it; the machine itself still can.
  return stored > 0
    ? `${name} can't be signed out from here. Remove the key below.`
    : `${name} can't be signed out from here. Clear it on the machine itself.`;
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
  /*
   * ⚠ **And the same guard for the sixth state, which reaches this the same way.**
   * A harness that refused to start is very often one with no wizard at all — that
   * is the whole population `no_login` describes — so `signInAbove` is false and
   * the line below would draw `Sign in with a key instead` with nothing above it
   * for the key to be instead *of*. Written as its own arm rather than folded into
   * the `no_login` test, because the two states differ where there **is** a
   * wizard: then there is something above, and `or` is right.
   */
  if (stance === "start_refused" && !signInAbove) return null;
  // Lower-case and verb-first, because it is a divider and not a heading: it
  // sits between a wizard above and a box below, and "Sign in with a key
  // instead" read as a second heading over the same box.
  return signInAbove ? "or" : "or paste a key";
}

/**
 * What a screen says when a **re**-read failed and the previous answer is still
 * drawn under it.
 *
 * ⚠ **One constant for both screens that draw it, and it is here rather than in
 * either because both import from this module and neither may import the
 * other.** `SystemsPanel` had its own spelling ("Couldn't re-check this
 * machine's systems — what's below may be out of date.") and `AgentsPanel`
 * another ("Couldn't reach that machine — what's below may be out of date."),
 * and `SystemDetail` mounts `AgentDetail` directly under its own copy — so the
 * ordinary case where both reads fail together, because they share a transport,
 * drew two near-identical sentences about one machine, one above the other.
 * Two sentences that differ by a noun read as a bug rather than as two failed
 * reads. One string, drawn wherever a stale answer is on screen; the caller
 * keeps the margin, for the reason `FIELD` gives about layout.
 *
 * A subject rather than a verb ("Machine status", not "Couldn't re-check"),
 * because what the reader needs is which part of the screen to distrust. Seven
 * words; the cap for a screen line is fourteen.
 */
export const STALE_READ = "Machine status may be out of date.";

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
