/**
 * Putting one plugin on several machines, and taking it off again.
 *
 * ⚠ **A plugin is installed on a machine, and this module exists to make that
 * legible rather than to hide it.** The code is on one host's disk and its data
 * is in one daemon's database; there is no fleet-side staging, no account-wide
 * plugin, and nothing here remembers a choice past the act. What "install on all
 * machines" means is *the machines in your list at the moment you pressed it* —
 * a snapshot, expanded here, and never a standing policy. A policy that also
 * caught machines enrolled later would be code arriving on a host nobody named
 * it on, which is Q7.42's argument about fleet rollout wearing different
 * clothes.
 *
 * The decision half is pure so `webcheck` can assert it as a partition; the
 * execution half is a `Promise.allSettled` over `store.daemonFor`, which is the
 * shape `store.ts` already uses internally for every per-machine fan-out it does.
 *
 * DOM-free, so `webcheck` can import it.
 */

import type { MachineId } from "./ids";
import { daemonReadable, type MachineState } from "./machine";

/**
 * Why a chosen machine was not even attempted.
 *
 * A closed union rather than free text, so `webcheck` can assert the partition
 * over every machine state and the sentences live in one table.
 */
export type SkipReason = "over_limit" | "owner_disabled" | "not_admin" | "unreachable";

export interface SkippedTarget {
  id: MachineId;
  name: string;
  reason: SkipReason;
}

/**
 * What happened on one machine.
 *
 * `updated` carries both versions because that is the sentence somebody wants —
 * "0.2.0 → 0.2.1" answers "did anything change" in a way "updated" does not.
 * `installed` and `updated` are separate arms rather than one with a nullable
 * `from`, because the daemon distinguishes them (`replaced`) and a client that
 * collapsed them would be guessing at the thing the daemon took care to say.
 */
export type TargetOutcome =
  | { kind: "pending" }
  | { kind: "sending"; fraction: number }
  | { kind: "installed"; version: string; enabled: boolean }
  | { kind: "updated"; from: string; to: string; enabled: boolean }
  | { kind: "removed" }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "failed"; message: string };

/**
 * Which of the chosen machines can be attempted, and which cannot.
 *
 * ⚠ **The two lists are a partition of `chosen` — every id is in exactly one —
 * and that is the property `webcheck` asserts** rather than the four reasons. A
 * machine that fell out of both would be one somebody selected and never heard
 * about again, which is the failure this whole screen is shaped to prevent.
 *
 * The order of the tests is the order of the *remedies*, `machineBadgeText`'s
 * rule: a banned owner needs an admin, an over-limit machine needs one retired,
 * a missing grant needs its owner, and only then is "it is asleep" worth saying.
 * A machine in more than one of those states names the one that has to be fixed
 * first.
 *
 * ⚠ **All four disable the row, and `unreachable` earns that for a reason the
 * other three do not share.** The checkbox on the screen means *this plugin is
 * installed here* — so for a machine nobody can reach, there is no honest box to
 * draw: the client cannot read what is installed there (`fetchPlugins` leaves the
 * list empty on failure, which is indistinguishable from "none"), and it could not
 * install anything if you ticked it. Drawing it unticked would be a claim. The
 * other three are controls that could only ever be *refused*: `ensureToken` throws
 * for the first two locally with no network at all, and a daemon answers the third
 * `403 insufficient_scope`.
 */
export function planTargets(
  machines: readonly MachineState[],
  chosen: ReadonlySet<MachineId>,
): { eligible: MachineId[]; skipped: SkippedTarget[] } {
  const eligible: MachineId[] = [];
  const skipped: SkippedTarget[] = [];
  for (const machine of machines) {
    if (!chosen.has(machine.id)) continue;
    const reason = skipReasonFor(machine);
    if (reason === null) eligible.push(machine.id);
    else skipped.push({ id: machine.id, name: machine.name, reason });
  }
  return { eligible, skipped };
}

/** Why this machine cannot be installed to, or `null`. Ordered by remedy. */
export function skipReasonFor(machine: MachineState): SkipReason | null {
  if (machine.ownerDisabled) return "owner_disabled";
  if (machine.overLimit) return "over_limit";
  /*
   * ⚠ **`machine:admin`, not `session:write`.** A route's scope is the caller's
   * and installing is an act on the machine rather than on a session — so a grant
   * that can drive every session on somebody's host all day may not put code on
   * it. Checked here so the row says why, rather than in the daemon's 403, which
   * arrives after somebody has waited for an upload.
   */
  if (!machine.scopes.includes("machine:admin")) return "not_admin";
  if (!daemonReadable(machine.reach)) return "unreachable";
  return null;
}

/**
 * The sentence a skipped machine carries.
 *
 * Named for the *remedy* rather than for the state, which is what the machines
 * screen already does one file over: "over the machine limit" tells somebody
 * nothing they can act on, and "retire another" does.
 */
export function skipText(reason: SkipReason): string {
  switch (reason) {
    case "owner_disabled":
      return "its owner is disabled, so it is switched off until an admin lifts that";
    case "over_limit":
      return "over the machine limit — retire another to bring it back";
    case "not_admin":
      return "you have access to its sessions but not to the machine itself";
    case "unreachable":
      // Says what is unknown rather than what failed: nothing was attempted, and
      // what is installed there cannot be read either.
      return "not reachable right now, so what is installed there cannot be read";
  }
}

/**
 * One machine's result, as a line under its name.
 *
 * ⚠ **The `enabled` half is the most common question this feature will
 * generate.** Installing does not switch a plugin on, and an update **inherits
 * the switch position** — `host.ts` is explicit that re-enabling somebody's
 * disabled plugin because they updated it would be the daemon deciding something
 * on their behalf. So a plugin somebody switched off is still off after an
 * update, and if this line does not say so, *"I updated it and it does not
 * work"* is what arrives instead.
 */
export function outcomeText(outcome: TargetOutcome): string {
  switch (outcome.kind) {
    case "pending":
      return "waiting";
    case "sending":
      return `${Math.round(outcome.fraction * 100)}%`;
    case "installed":
      return outcome.enabled ? `installed ${outcome.version}` : `installed ${outcome.version}, switched off`;
    case "updated":
      return outcome.enabled
        ? `updated ${outcome.from} → ${outcome.to}`
        : `updated ${outcome.from} → ${outcome.to}, still switched off`;
    case "removed":
      return "removed";
    case "skipped":
      return skipText(outcome.reason);
    case "failed":
      return outcome.message;
  }
}

/** Whether this outcome is one the person asked for and got. */
export function landed(outcome: TargetOutcome): boolean {
  return outcome.kind === "installed" || outcome.kind === "updated" || outcome.kind === "removed";
}

/** Whether anything is still in flight. */
export function running(outcomes: readonly TargetOutcome[]): boolean {
  return outcomes.some((one) => one.kind === "pending" || one.kind === "sending");
}

/**
 * What the boxes on the install screen add up to.
 *
 * ⚠ **Counts rather than machines, because the decision does not depend on
 * which.** Keeping it that way is what lets `webcheck` sweep the whole space —
 * three sizes in each of three directions, both flags — instead of asserting the
 * four cases somebody happened to think of.
 */
export interface InstallDraft {
  /** Machines that would get the plugin for the first time. */
  adding: number;
  /**
   * Machines that have it, are still ticked, and are behind the version this
   * screen is showing. They ride along with whatever else the act does.
   */
  updating: number;
  /** Machines the plugin would come off. */
  removing: number;
  /**
   * Whether this screen can install at all.
   *
   * `false` for a plugin that arrived as a file: there is no `{repo, commit}` to
   * hand a second daemon, so the only act left is removal. Forced through here
   * rather than trusted from the caller — see {@link draftAct}.
   */
  canInstall: boolean;
  /** Whether the plugin is on any machine at this moment. */
  anywhere: boolean;
}

/** The four things the one button at the foot can be. */
export type DraftAct = "install" | "reinstall" | "reconfigure" | "remove";

/**
 * What the button at the foot of the install screen says, and whether it moves.
 *
 * ⚠ **`ready` is exactly "the draft differs from what is installed", and nothing
 * else.** A live button over an unchanged draft would re-send an archive to
 * machines already holding that exact commit — a request nobody asked for, which
 * a daemon has to unpack before it can find out is a no-op. So the disabled state
 * is not a guard against a mistake, it is the absence of anything to do.
 *
 * ⚠ **The act is named for what will happen, never for what the screen is
 * about**, and the arms are ordered most specific first. `reconfigure` — taking a
 * plugin off one machine and putting it on another in one press — is the case the
 * whole staged draft exists for, so it has to be distinguishable at a glance from
 * either half of it. A screen that called it "Install" would name the reversible
 * half of an act whose other half is not.
 *
 * ⚠ **With nothing drafted the button still carries a name**, because a control
 * with no label is one nobody can tell is disabled *for now* rather than broken.
 * What it names then is what it is *for*: `remove` where that is all it could ever
 * do, `reinstall` where the plugin is already somewhere, `install` where it is
 * nowhere.
 *
 * ⚠ **`canInstall: false` forces both install counts to zero rather than
 * trusting them.** The caller derives them from the same flag, so agreeing is the
 * expected case — but a screen that offered "Install" for an archive it does not
 * hold would produce a request with nothing to send, and this is the one place
 * that can be made unreachable rather than merely unlikely.
 */
export function draftAct(draft: InstallDraft): { act: DraftAct; ready: boolean } {
  const adding = draft.canInstall ? Math.max(0, draft.adding) : 0;
  const updating = draft.canInstall ? Math.max(0, draft.updating) : 0;
  const removing = Math.max(0, draft.removing);
  const installing = adding + updating;

  if (installing > 0 && removing > 0) return { act: "reconfigure", ready: true };
  if (removing > 0) return { act: "remove", ready: true };
  if (adding > 0) return { act: "install", ready: true };
  if (installing > 0) return { act: "reinstall", ready: true };
  if (!draft.canInstall) return { act: "remove", ready: false };
  return { act: draft.anywhere ? "reinstall" : "install", ready: false };
}

/** The act, as the word on the button. */
export function draftLabel(act: DraftAct): string {
  switch (act) {
    case "install":
      return "Install";
    case "reinstall":
      return "Reinstall";
    case "reconfigure":
      return "Reconfigure";
    case "remove":
      return "Remove";
  }
}

/**
 * What the foot asks before it takes a plugin off machines.
 *
 * ⚠ **Only the removals are named.** A `reconfigure` installs too, and that half
 * is undone by unticking and pressing again — putting it in the question would
 * spend the person's attention on the reversible part of an act whose whole
 * reason for asking is `plugin_data` that nothing brings back.
 *
 * One machine is named and several are counted, `installedSummary`'s rule and its
 * reason: a name answers "which one" and a list of six is a paragraph in a strip
 * meant to hold a sentence and two buttons.
 */
export function removalQuestion(names: readonly string[]): string {
  if (names.length === 1) return `Remove it from ${names[0]} and everything it kept there?`;
  return `Remove it from ${names.length} machines and everything it kept on them?`;
}

/**
 * What the collapsed row says about where a plugin is.
 *
 * ⚠ **This replaced a summary drawn *after* an act, and the difference is the
 * whole point.** The screen used to answer "did that work" with a panel and a
 * Clear button — a notification about something that had already happened, which
 * somebody then had to dismiss. This is the same answer given *before* anybody
 * presses anything and given again after, on the closed row beside the word
 * Machines. The boxes inside are a draft of where the plugin should go; this line
 * is where it actually is, and it is what makes opening the list optional.
 *
 * Names rather than a bare count while there are few enough to read, because
 * "on laptop" answers the question somebody actually has and "on 1 of 3" makes
 * them open the list to find out which.
 */
export function installedSummary(total: number, names: readonly string[]): string {
  if (total === 0) return "no machines";
  if (names.length === 0) return "not installed anywhere";
  if (names.length === total) return total === 1 ? "installed" : `on all ${total} machines`;
  // Three is where the line stops being readable at a phone's width and starts
  // being a paragraph; past it the count is the more useful of the two.
  if (names.length <= 3) return `on ${names.join(", ")}`;
  return `on ${names.length} of ${total} machines`;
}

/**
 * What the foot of the install screen says about the machines an act did not
 * reach, and the empty string where it reached all of them.
 *
 * ⚠ **A failure has to be said outside the collapsed list, because the closed row
 * cannot say one.** {@link installedSummary} is that row's whole answer and it is
 * derived from what is *installed* — a machine that failed has no row in
 * `pluginsByMachine`, so it is left out of "on laptop, mini" rather than named,
 * and a fan-out where three of five hosts refused reads as a smaller fleet. The
 * panel holding the per-machine reasons is collapsed and `inert`, and the tick
 * that reaches every machine sits *above* the disclosure — so the commonest path
 * on this screen is also the one that never opens it.
 *
 * ⚠ **It names which machines and never what happened on them.** A `POST` that
 * failed in transit says nothing about whether the daemon acted — `MachineInstalls`
 * declines to retry anything but `plugin_busy` for exactly that reason, because the
 * daemon may be halfway through unpacking — so "nothing was installed" is a claim
 * this line is not entitled to make. The reason is the row's own, and the row is
 * open by the time this is read.
 *
 * One name, up to three names, then a count: `installedSummary`'s rule and its
 * reason — three is where the line stops being readable at a phone's width and
 * starts being a paragraph.
 *
 * ⚠ **The empty string rather than `null`, so one string feeds both the visible
 * line and the live region beside it.** `EventList` records what the other
 * arrangement costs: a notice gated on a second condition read empty in exactly
 * the state it had been added for, and the truncation was inaudible as well as
 * invisible.
 */
export function failureSummary(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `Failed on ${names[0]} — the row says why.`;
  if (names.length <= 3) return `Failed on ${names.join(", ")} — each row says why.`;
  return `Failed on ${names.length} machines — each row says why.`;
}
