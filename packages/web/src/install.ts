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

import { isNewer } from "./catalogue";
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

/**
 * The three things one machine's row can do.
 *
 * Drawn in this order, remove last — which is not cosmetic: the row's confirming
 * pair replaces the trailing group, so the last child before the tap and Cancel
 * after it occupy the same pixels. Q3.218's measured safety property, reaching a
 * row of icons.
 */
export type RowAct = "install" | "update" | "remove";

/**
 * What one row offers.
 *
 * ⚠ **`install` and `remove` are never both present**, which is what makes a row's
 * trailing group readable at a glance rather than a state somebody has to parse.
 * **`update` never appears without `remove`**: an update is an install onto a
 * machine that already has it, so a row offering Update alone would claim an
 * install state it does not hold.
 *
 * ⚠ **A blocked row offers nothing, all four `skipReasonFor` states included.**
 * Under the draft this was a rule about `unreachable` — an unticked box on a
 * machine nobody can read would be a claim about what is installed there. Under
 * live acts it is stronger: an Install button there fires a request that cannot
 * land, and a Remove button claims there is something to remove.
 *
 * ⚠ **A busy row offers nothing either**, which is also what stops a second bulk
 * press double-sending: the counts the bar reads are derived from this, so a
 * machine with a request out is in none of them.
 *
 * `canInstall` is forced here rather than trusted from the caller — the same move
 * the draft's own decision made, and for its reason: a screen that offered Install
 * for an archive it does not hold would produce a request with nothing to send,
 * and this is the one place that can be made unreachable rather than unlikely.
 */
export function rowActs(
  row: { installed: boolean; behind: boolean; blocked: boolean; busy: boolean },
  canInstall: boolean,
): RowAct[] {
  if (row.blocked || row.busy) return [];
  const acts: RowAct[] = [];
  if (!row.installed && canInstall) acts.push("install");
  if (row.installed && row.behind && canInstall) acts.push("update");
  if (row.installed) acts.push("remove");
  return acts;
}

/**
 * The acts a **row** draws, which is {@link rowActs} minus the one that cannot be
 * undone.
 *
 * ⚠ **Removal is a bulk act only, and the row offers none.** A bin 44px from a
 * checkbox is an unrecoverable act reachable by one stray tap on the busiest strip
 * of this screen — and the question that guarded it had to *replace the row* to
 * fit, which is a control answering for itself in the space it occupies. Off the
 * row, a removal always goes through a selection: two deliberate acts, one place
 * to confirm, and one sentence naming every machine it reaches instead of a
 * truncated one naming the row it happens to sit on.
 *
 * ⚠ **`rowActs` still reports it**, because the *bar* reads that answer to decide
 * whether its own Remove may move. What is narrowed here is what is **drawn**, and
 * the two are separate for exactly that reason: a row that could not report a
 * removable machine would take the bar's Remove down with it.
 *
 * The property worth asserting is not the filter — it is that everything a row
 * draws is reversible by pressing something else on the same row.
 */
export function drawnActs(acts: readonly RowAct[]): RowAct[] {
  return acts.filter((one) => one !== "remove");
}

/**
 * What one of those icons is called.
 *
 * ⚠ **It names the machine, because `IconButton.label` is the accessible name.**
 * Seven rows each announcing "Remove" is seven controls a screen reader cannot tell
 * apart, on the one list where the difference between them is which host loses its
 * `plugin_data`.
 */
export function rowActLabel(act: RowAct, machineName: string): string {
  switch (act) {
    case "install":
      return `Install on ${machineName}`;
    case "update":
      return `Update on ${machineName}`;
    case "remove":
      return `Remove from ${machineName}`;
  }
}

/**
 * What the selection adds up to.
 *
 * ⚠ **Counts rather than machines**, which is the rule the draft's own decision
 * kept and for its reason: it is what lets `webcheck` sweep the whole space instead
 * of the cells somebody thought of.
 */
export interface Selection {
  /** How many machines are selected at all, shown or not. */
  selected: number;
  installable: number;
  updatable: number;
  removable: number;
  /** Selected machines whose settings could be written right now. */
  configurable: number;
  /** Whether this screen holds an archive at all. `false` on the Offline path. */
  canInstall: boolean;
}

export type BulkAct = "install" | "update" | "remove" | "settings";

/**
 * Which of the four bulk controls will move.
 *
 * ⚠ **Install, Update and Remove are "any"; Settings is "every", and the asymmetry
 * is the decision rather than an oversight.** The first three are fan-outs: a
 * machine the act cannot reach falls out and says so on its own row, which is the
 * partition {@link planTargets} is built around. Settings is a **navigation** —
 * there is one screen and nothing to skip — so a selection of seven that opened a
 * screen about a subset would be the "selected and never heard about again" failure
 * wearing different clothes.
 *
 * ⚠ **`configurable` is clamped to `selected` rather than trusted.** The caller
 * derives both from the same walk, so agreeing is the expected case — but a count
 * larger than the selection would enable Settings over a selection holding a
 * machine that cannot take it, which is the one state this control exists to
 * refuse. `draftAct` made the identical move with `canInstall`, and for the
 * identical reason.
 */
export function bulkEnabled(counts: Selection): Record<BulkAct, boolean> {
  const selected = Math.max(0, counts.selected);
  const at = (n: number): number => Math.min(Math.max(0, n), selected);
  return {
    install: counts.canInstall && at(counts.installable) > 0,
    update: counts.canInstall && at(counts.updatable) > 0,
    remove: at(counts.removable) > 0,
    settings: selected > 0 && at(counts.configurable) === selected,
  };
}

/**
 * Whether an installed machine is behind what this screen can offer.
 *
 * One export rather than the expression inline in two places — the row's Update
 * icon and {@link installedSubline}'s middle arm — because with the rule written
 * twice they can disagree, and a row drawing Update beside a line saying nothing is
 * available is the shape that produces a bug report nobody can reproduce.
 */
export function isBehind(version: string, available: string | null): boolean {
  return available !== null && isNewer(available, version);
}

/**
 * Why a selected machine cannot be configured, or `null`. Ordered by remedy.
 *
 * ⚠ **Not {@link skipReasonFor}, and the scope is why.** Installing is an act on
 * the *machine* and takes `machine:admin`; a settings pane is read behind
 * `session:read` and written behind `session:write`. So a grant that can drive
 * every session on somebody's host all day may not put code on it and *may*
 * configure what is already there — and reusing the install predicate here would
 * grey out the one control that grant is entitled to.
 *
 * ⚠ **`not_installed` and `no_pane` sit BELOW `no_scope` and `unreachable`, and
 * the obvious order is a bug.** `store.fetchPlugins` swallows every failure into an
 * empty list, so a 403 for a missing scope and a daemon nobody can reach both
 * produce `installed === null` — and answering *"that machine does not have this
 * plugin"* about either is a claim this client cannot make. That is
 * `skipReasonFor`'s own argument about `unreachable`, one field over and one extra
 * time. It also happens to be the remedy order: two bans, then two things that
 * cannot be known, then two facts.
 *
 * ⚠ **`enabled` is not consulted**, `offersSettings`' standing rule: a plugin
 * somebody switched off is the commonest reason to open its settings.
 *
 * Takes a structural subset rather than `PluginSummary`, `machineBadgeText`'s
 * posture, so a driver can sweep it without building a whole wire object.
 */
export type SettingsBlock =
  | "owner_disabled"
  | "over_limit"
  | "no_scope"
  | "unreachable"
  | "not_installed"
  | "no_pane";

export function settingsBlockFor(
  machine: MachineState,
  /** What the daemon last said about this plugin there, or `null`. */
  installed: { version: string; contributes: { settings: boolean } } | null,
): SettingsBlock | null {
  if (machine.ownerDisabled) return "owner_disabled";
  if (machine.overLimit) return "over_limit";
  if (!machine.scopes.includes("session:read")) return "no_scope";
  if (!daemonReadable(machine.reach)) return "unreachable";
  if (installed === null) return "not_installed";
  if (!installed.contributes.settings) return "no_pane";
  return null;
}

/** Why that machine is blocking the control, as the sentence beside it. */
export function settingsBlockText(block: SettingsBlock, machineName: string, version: string | null): string {
  switch (block) {
    case "owner_disabled":
      return `${machineName}'s owner is disabled, so it is switched off until an admin lifts that`;
    case "over_limit":
      return `${machineName} is over the machine limit — retire another to bring it back`;
    case "no_scope":
      return `you have access to ${machineName}'s sessions but not to what is installed on it`;
    case "unreachable":
      return `${machineName} is not reachable right now, so its settings cannot be read`;
    case "not_installed":
      return `${machineName} does not have this plugin`;
    case "no_pane":
      return version === null
        ? `${machineName} has no settings pane`
        : `${machineName} has no settings pane for ${version}`;
  }
}

/**
 * Why the Settings control will not move, and the empty string where it will.
 *
 * One blocker is said in full and several are counted — {@link installedSummary}'s
 * rule and its reason: a name answers "which one", and a list of six is a paragraph
 * in a strip meant to hold a sentence and four buttons.
 *
 * ⚠ **The empty string rather than `null`**, so one value feeds the visible line
 * and the `aria-describedby` pointing at it. `EventList` records what the other
 * arrangement costs: a notice gated on a second condition read empty in exactly the
 * state it had been added for.
 *
 * The caller passes these in **fleet order**, so the machine named is the first one
 * on screen rather than whichever the poll happened to return first.
 */
export function settingsNotice(
  blocked: readonly { name: string; block: SettingsBlock; version: string | null }[],
): string {
  const first = blocked[0];
  if (first === undefined) return "";
  const one = settingsBlockText(first.block, first.name, first.version);
  return blocked.length === 1 ? `${one}.` : `${one}, and ${blocked.length - 1} more.`;
}

/** Which machines the header leaves on screen. */
export type InstallFilter = "all" | "installed" | "absent";

/**
 * Whether one machine survives the search box and the filter beside it.
 *
 * The id is matched as well as the name, unlike `matchesQuery`'s reasoning one
 * module over but for its conclusion: a machine's id is drawn on the row exactly
 * where `ambiguousNames` says the name cannot tell two hosts apart, and a needle
 * that could not reach it would be unable to separate the one pair search is most
 * needed for.
 */
export function rowShown(
  row: { id: string; name: string; installed: boolean },
  needle: string,
  filter: InstallFilter,
): boolean {
  const wanted = needle.trim().toLowerCase();
  if (wanted.length > 0 && !row.name.toLowerCase().includes(wanted) && !row.id.toLowerCase().includes(wanted)) {
    return false;
  }
  if (filter === "installed") return row.installed;
  if (filter === "absent") return !row.installed;
  return true;
}

/**
 * The machines the header leaves on screen, in fleet order.
 *
 * ⚠ **It exists so that there is exactly one call.** The select-all box's meaning
 * and the scroller's contents are the same list, and two calls is how the box comes
 * to select rows the list is not drawing — which is the failure `groups.ts` states
 * as its own standing rule about a filter and the keyboard.
 *
 * Generic, so the caller hands in its richer row and gets it back typed.
 */
export function shownRows<T extends { id: string; name: string; installed: boolean }>(
  rows: readonly T[],
  needle: string,
  filter: InstallFilter,
): T[] {
  return rows.filter((row) => rowShown(row, needle, filter));
}

/**
 * What the line under the machine list says about the selection.
 *
 * ⚠ **It closes a hazard the filter opens.** Select four machines, then narrow the
 * filter so two of them disappear: the bulk bar still acts on four. That has to be
 * the behaviour — hiding a row is not unselecting it, and a bar that silently
 * dropped two would be the "selected and never heard about again" failure
 * {@link planTargets}' partition exists to prevent — but it has to be **said**, or
 * one press removes a plugin from two machines that are not on screen.
 */
export function selectionLine(selected: number, hidden: number): string {
  if (selected <= 0) return "nothing selected";
  if (hidden <= 0) return selected === 1 ? "1 machine selected" : `${selected} machines selected`;
  return `${selected} selected, ${hidden} of them not shown`;
}

/**
 * What stands where the machine list would be, when nothing is in it.
 *
 * ⚠ **Real quotation marks, and never `JSON.stringify`.** `MarketList` quotes a
 * needle through a serialiser one screen over, which is right by accident for every
 * ordinary query and shows somebody their own input escaped for one holding a quote
 * or a backslash. Copying that into its second call site is how it becomes a
 * convention.
 *
 * Total over every combination rather than a chain with a fall-through, because an
 * empty box where a list should be is the one state with nothing else on screen to
 * explain it.
 */
export function noRowsText(total: number, needle: string, filter: InstallFilter): string {
  if (total === 0) return "You have no machines yet, so there is nowhere to put a plugin.";
  const wanted = needle.trim();
  if (wanted.length > 0) return `No machine here is called \u201c${wanted}\u201d.`;
  if (filter === "installed") return "It is not on any of your machines.";
  if (filter === "absent") return "It is on every machine you have.";
  return "You have no machines yet, so there is nowhere to put a plugin.";
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
 * Which machines a settings form is about to be written to, as the line above it.
 *
 * {@link installedSummary}'s rule and its reason: one name answers "which", three
 * is where the line stops being readable at a phone's width and starts being a
 * paragraph, and past that the count is the more useful of the two. The full list
 * rides a `title`, so nothing is unreachable.
 *
 * ⚠ **It never says "all machines", and that is the difference from
 * {@link installedSummary}.** That one reports a *fact* — where the plugin is —
 * while this reports a **scope somebody chose**, and "all" is the word most likely
 * to be read as a standing policy rather than as a snapshot. Q7.42's own hazard,
 * on the one line whose whole job is to say what the choice was.
 */
export function scopeSummary(names: readonly string[]): string {
  if (names.length === 0) return "no machines";
  if (names.length <= 3) return names.join(", ");
  return `${names.length} machines`;
}

/**
 * What one installed machine's row says under its name.
 *
 * ⚠ **The third argument changed meaning when the draft went, and it kept its
 * slot.** It was `ticked` — "this box is about to remove it" — and there is no
 * draft any more, so it is `enabled`, read straight off the daemon's row. Every
 * surviving call passes `true` and means something different by it, which is
 * precisely the change a diff cannot show; the parameter was renamed so the
 * declaration moves, and the sentence below appears nowhere in the old body so the
 * repurposed assertions fail against it rather than passing by accident.
 *
 * ⚠ **Switched off outranks both comparisons, and it is the whole of the surviving
 * sentence about an update.** An install never switches a plugin on and an update
 * **inherits** the switch — `host.ts` is explicit that re-enabling somebody's
 * disabled plugin because they updated it would be the daemon deciding on their
 * behalf. Under the draft that fact lived in `outcomeText`, which this screen never
 * actually rendered: it wrote `null` on success and let the store answer. So *"I
 * updated it and it does not work"* had nothing preventing it. Here it is a
 * standing fact on the row rather than a notice after an act.
 *
 * ⚠ **And it replaces the version comparison rather than joining it**, because the
 * Update icon beside this line is drawn *only* when the machine is behind — so a
 * second copy of that fact costs a clause of a truncated 10px line at 390px, while
 * "switched off" has no other representation on the row at all.
 *
 * `available` is what *this screen* can install — the catalogue's version on a
 * market entry, the chosen archive's on an import — so the wording names the offer
 * rather than the market, and stays true on both.
 */
export function installedSubline(version: string, available: string | null, enabled: boolean): string {
  if (!enabled) return `${version} · switched off`;
  if (available === null) return version;
  /*
   * The same string `InstalledList`'s badge already draws for this fact one screen
   * over. It read "will be updated to 0.4.0" while the boxes were a draft; with
   * live acts there is nothing drafted, and two phrasings for one fact is how they
   * come to disagree.
   */
  if (isBehind(version, available)) return `${version} · ${available} available`;
  /*
   * ⚠ **Ahead of the offer, which is an ordinary state rather than a fault.** It is
   * what a machine looks like while somebody is iterating on a plugin locally, and
   * what a whole fleet looks like between a build and its publication. Said
   * plainly, and *not* as an error: nothing here is broken and there is nothing to
   * fix — the row simply draws no Update.
   */
  if (isNewer(version, available)) return `${version} · newer than the ${available} offered here`;
  return version;
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
