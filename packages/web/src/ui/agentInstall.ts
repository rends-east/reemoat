import type { AgentStance } from "./agentCard";
import type { InstallOutcome, InstallPhase, InstallRunView } from "../wire";

/**
 * Putting a harness on a machine, as this screen reads it.
 *
 * `ui/login.ts`'s sibling — DOM-free, one rule per export, driven by `webcheck`
 * rather than described. **Deliberately not folded into `src/install.ts`**, whose
 * subject is *one plugin across several machines*: that module imports
 * `./catalogue` and `./machine` and speaks in `SkipReason`, `TargetOutcome` and
 * `MachineState`, and folding an agent vocabulary into it would make the module
 * `MachineInstalls`, `PluginsPanel` and `MarketList` all read mean two things.
 * The precedent for splitting on *posture* rather than on subject is `pane.ts`:
 * its own module because everything around it fails open and it refuses to draw.
 *
 * ⚠ **What it deliberately does not do is guess.** `ui/login.ts` parses a
 * vendor's sentences, which is what licenses a guess there and a raw-transcript
 * fallback under it. Here the checkpoints are printed by `deploy/agents.sh`, in
 * this repository, and read by `readStep` in `src/agentinstall.ts` — so what
 * reaches this file is already a `phase`, and there is nothing left to infer.
 */

/** Where a run has got to, as one word for a person. */
export type InstallStage = "starting" | "working" | "done" | "failed";

/**
 * Four members, not `LoginPhase`'s five, and the difference is argued rather than
 * inherited.
 *
 * A login forks `acting`/`waiting` on `needsInput`, because it asks something *of
 * the person* and the two states differ in whether they are waiting on them. An
 * install asks nothing, reads no stdin, and has no third argument — so the two
 * collapse into one and {@link readInstallRun} takes two parameters where
 * `readLoginTranscript` takes three.
 */
export function installStage(run: Pick<InstallRunView, "done" | "outcome" | "phase">): InstallStage {
  if (!run.done) return run.phase === null || run.phase === "start" ? "starting" : "working";
  return run.outcome === "installed" ? "done" : "failed";
}

/**
 * What to say about a run that has ended badly, or `null` where the words are
 * this screen's rather than the machine's.
 *
 * ⚠ **One sentence per outcome and no parse of the transcript at all**, which is
 * the other half of the file docblock: the daemon decides `outcome` by asking the
 * machine, so there is a typed answer here where `ui/login.ts` has only prose.
 *
 * ⚠ **No sentence for a network failure, and that is deliberate.** `login.ts`'s
 * standing rule is that a recognised failure names something that cannot be
 * retried away, and a vendor host that timed out is exactly what an installer
 * prints twice before succeeding — the daemon reports that as `failed`, whose
 * sentence says only what is true of every way it could have failed. What it
 * costs is that the commonest real failure falls back to the raw output, which is
 * the screen this replaces and never worse than it.
 */
export function installFailure(outcome: InstallOutcome, name: string): string | null {
  switch (outcome) {
    case "failed":
      return `${name} could not be installed on this machine.`;
    case "locked":
      return "This machine was busy with its agents. Try again in a moment.";
    case "timeout":
      return `Installing ${name} took too long and was stopped.`;
    case "cancelled":
      return `Installing ${name} was stopped.`;
    case "spawn_failed":
      return "This machine could not start the installer.";
    case "running":
    case "installed":
      return null;
  }
}

/**
 * The one line under the spinner while a run is going.
 *
 * ⚠ **It names a checkpoint the installer printed, never a step this screen
 * guessed at** — which is what makes it legal at all. `MachineInstalls`' own
 * docblock refuses a stage label on exactly that ground, and it is right about
 * its own case: nothing in a plugin install is on the wire. Here the script
 * prints `step: <agent> download` and this is that word.
 *
 * `null` before the first checkpoint, where there is genuinely nothing to say
 * beyond the spinner and the clock.
 */
export function installStep(phase: InstallPhase | null): string | null {
  switch (phase) {
    case "download":
      return "Downloading…";
    case "install":
      return "Installing…";
    case "link":
      return "Finishing…";
    case "start":
    case "done":
    case "failed":
    case null:
      return null;
  }
}

/** After this long, a run says how long it has been going. `install.ts`'s number. */
export const ELAPSED_AFTER_MS = 10_000;

/**
 * The elapsed clock, in the shape the row and the card both draw.
 *
 * ⚠ **Ten seconds, restated rather than imported from `src/install.ts`.** Same
 * number, two different judgements: there it is a four-machine plugin fan-out
 * under a 90-second route budget, here it is one `npm i -g` on one host. The
 * opposite call from `NAMES_BEFORE_COUNT`, which is one symbol precisely because
 * three summaries share one judgement. Somebody will want to merge them; the
 * argument has to be at the code or it will be tidied.
 *
 * ⚠ **`now` is passed in rather than read**, so this is pure and so the caller's
 * one shared interval is what decides the tick — and so a phone that slept
 * through half an install comes back with the true elapsed time rather than the
 * number of ticks the tab was awake for.
 */
export function installElapsed(since: number, now: number): string | null {
  const elapsed = now - since;
  if (!Number.isFinite(elapsed) || elapsed < ELAPSED_AFTER_MS) return null;
  return `${Math.round(elapsed / 1000)}s`;
}

/**
 * Which control the one slot under an agent's card draws.
 *
 * Its scope is exactly the slot that today holds `wizard | SignOutButton | Sign
 * in | null`, and nothing else on that card: `Check again` stays the separate
 * block below it, deliberately, because folding the two would delete the one
 * control this app has for *"I did that, look again"*.
 */
export type PrimaryControl = "installing" | "wizard" | "install" | "sign_out" | "sign_in" | "none";

export function primaryControl(input: {
  stance: AgentStance;
  installRunning: boolean;
  wizardOpen: boolean;
  installable: boolean;
  canSignIn: boolean;
  canSignOut: boolean;
}): PrimaryControl {
  /*
   * ⚠ **Above `wizardOpen`, because a run attached in this tab is something that
   * happened** and the listing that says the harness is absent is what put it
   * there. `agentStance`'s own reason for ranking `refused` above its two absence
   * arms, one layer up.
   *
   * Every stance, `signed_in` included: re-installing a working harness is a
   * legitimate thing to be doing, and it must not be hijacked by Sign out.
   */
  if (input.installRunning) return "installing";
  if (input.wizardOpen) return "wizard";
  switch (input.stance) {
    /*
     * ⚠ **Above the credential axis, and this is the whole repair.** `canSignIn`
     * is `login.supported && agent.available`, so it is already `false` for a
     * harness that is not there — which is why the card drew *nothing at all* and
     * the door `NewSession` had then opened onto one true sentence and no control.
     * That door is gone (Q3.640); this card is what the Agents list's **Set up**
     * opens, and a missing harness is the commonest state it is opened in.
     */
    case "not_installed":
      return input.installable ? "install" : "none";
    case "signed_in":
      return input.canSignOut ? "sign_out" : "none";
    case "start_refused":
    case "no_login":
    case "signed_out":
    case "unchecked":
      return input.canSignIn ? "sign_in" : "none";
    default: {
      /*
       * ⚠ **A `never` arm, because `offersTile` already paid for this lesson**: a
       * pair of `!==` tests answered a silent `true` for a member it had not
       * heard of, and a seventh stance would otherwise get a control nobody chose
       * for it.
       */
      const exhaustive: never = input.stance;
      return exhaustive;
    }
  }
}

/*
 * ⚠ **`agentDoor` and `doorLabel` stood here, and both are deleted rather than
 * left unused** (Q3.640). They decided which disclosure New session unfolded on a
 * machine with nothing to start — *Install X* or *Sign in to X* — and what its
 * button said. New session draws no door now: it names the machine's Agents list,
 * a row there offers **Set up**, and the card that opens decides its one control
 * through `primaryControl` above, which already tested `available` before the
 * credential axis for the reason `agentDoor` was written.
 */

/**
 * What the machine said about the harness after a run, once it has been re-read.
 *
 * `loginOutcome`'s shape, with **no `cannotTell` member**, and the asymmetry is
 * worth a sentence: `loggedIn` is three-valued because some CLIs have no status
 * probe to ask, while `available` is a plain boolean on the wire. The re-read
 * gives a definite answer here, and inventing a third state would be this screen
 * hedging about something it was told.
 */
export type InstallResult = "checking" | "installed" | "notInstalled" | "unreachable";

export function installResult(checking: boolean, checkFailed: boolean, available: boolean): InstallResult {
  if (checking) return "checking";
  if (checkFailed) return "unreachable";
  return available ? "installed" : "notInstalled";
}

/**
 * The sentence under a finished run, or `null` while there is nothing settled.
 *
 * ⚠ **The `installed` arm names the *next* step, and without it the flow reads as
 * broken.** `offersTile` keeps both `not_installed` **and** `signed_out` off the
 * New session strip, so a harness that has just been installed still has no tile:
 * somebody installs, looks at the strip, sees nothing, and concludes the install
 * failed. The honest sequence is Install → still no tile → Sign in → tile, and
 * this is the only place that can say so.
 */
export function installResultLine(result: InstallResult, name: string): string | null {
  switch (result) {
    case "checking":
      return null;
    case "installed":
      return `${name} is installed. Sign in to start a chat with it.`;
    case "notInstalled":
      return `That didn't install ${name}.`;
    case "unreachable":
      return `This machine stopped answering about ${name}.`;
  }
}

/**
 * How much of the installer's own output this screen keeps, newest first.
 *
 * ⚠ **The daemon's own ceiling, restated rather than imported, and it has to
 * be** — `MAX_OUTPUT_BYTES` in `src/agentinstall.ts` is the same 64 KiB and
 * nothing in `packages/web` may import from `src/`. The number is not arbitrary
 * on either side: it is the most the daemon will ever hand out, so a client that
 * keeps this much keeps everything a `GET` can still serve and not a byte more.
 * `webcheck` reads the daemon's constant as text and compares them, because two
 * numbers that are meant to be one are exactly what drifts.
 *
 * ⚠ **Chars here against bytes there, deliberately.** The daemon front-drops a
 * `Buffer`; this is a JS string, so on multi-byte output the client holds a
 * little less than the daemon would send. That is a display bound rather than a
 * protocol one, and `TextEncoder` arithmetic on every poll would cost more than
 * the difference is worth.
 */
export const MAX_INSTALL_OUTPUT_CHARS = 64 * 1024;

/**
 * The transcript this screen may hold, given everything it has been handed.
 *
 * ⚠ **Bounded on the daemon and unbounded on the client is what this fixes,
 * and the cost was quadratic rather than linear.** The poll appended every chunk
 * to one React state string and handed it to a `<pre>` child on each tick, so
 * the accumulated text node was rebuilt from the whole history every poll:
 * O(total) per poll, O(n²) over a run. What kept that survivable is an accident
 * — `deploy/agents.sh` sends the vendor installers' own output to `/dev/null`
 * — and a chatty installer, or `REEMOAT_AGENT_SOURCE=npm` on a slow link,
 * removes the bound while nothing on this side notices.
 *
 * ⚠ **The tail, never the head**, which is the daemon's own choice for the same
 * reason: what went wrong is the last thing an installer says.
 *
 * ⚠ **A caller that drops something owes the `gap` notice.** The raw pane's
 * whole licence is that it is the complete record, so when it is not it has to
 * say so — and that sentence already exists, for the daemon's half of the same
 * drop. Pure, and the shortening is visible as a shorter answer, so the caller
 * can decide that outside a state updater rather than inside one.
 */
export function keepInstallTail(held: string): string {
  if (held.length <= MAX_INSTALL_OUTPUT_CHARS) return held;
  return held.slice(held.length - MAX_INSTALL_OUTPUT_CHARS);
}

/**
 * Whether the installer's own output is worth opening by itself.
 *
 * `rawTranscriptIsOpen`'s partition, narrowed by the fact that this flow has a
 * typed outcome: never over a run that worked, and never where
 * {@link installFailure} has said something this screen could not have guessed.
 *
 * ⚠ **`failed` is the one arm, and it is named rather than derived.** This read
 * `installFailure(outcome, "") === null` — "the arm with no sentence of its own"
 * — and that arm has **no members**: the only outcomes without a sentence are
 * `running` and `installed`, and `settle()` rewrites `running` to
 * `installed`/`failed` before ending a run, so no daemon can produce the pair it
 * asked for. The predicate was a constant `false` for its whole life and the
 * `<details>` it feeds never once opened. `failed` is the arm the fallback was
 * always for: its sentence is the deliberately generic one
 * ({@link installFailure} says so), so the installer's own bytes are the only
 * thing that carries what went wrong. The other four each say something
 * specific — busy, too long, stopped, could not start — and adding a wall of
 * vendor output under those is worse than the screen this replaces.
 */
export function rawInstallIsOpen(run: Pick<InstallRunView, "done" | "outcome"> | null): boolean {
  if (run === null || !run.done) return false;
  return run.outcome === "failed";
}
