/**
 * Installs are per machine: "all machines" means the machines listed at the moment of the press, never a standing policy (Q7.42).
 * DOM-free so webcheck can import it.
 */

import { isNewer } from "./catalogue";
import type { MachineId } from "./ids";
import { daemonRead, type MachineState } from "./machine";

export type SkipReason = "over_limit" | "owner_disabled" | "not_admin" | "unreachable" | "asking";

export interface SkippedTarget {
  id: MachineId;
  name: string;
  reason: SkipReason;
}

export type TargetOutcome =
  | { kind: "pending" }
  | { kind: "sending"; fraction: number }
  | { kind: "installed"; version: string; enabled: boolean }
  | { kind: "updated"; from: string; to: string; enabled: boolean }
  | { kind: "removed" }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "failed"; message: string };

/** eligible and skipped partition chosen: every chosen id lands in exactly one, in remedy order. */
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

export function skipReasonFor(machine: MachineState): SkipReason | null {
  if (machine.ownerDisabled) return "owner_disabled";
  if (machine.overLimit) return "over_limit";
  // machine:admin rather than session:write: installing puts code on the machine, not on a session.
  if (!machine.scopes.includes("machine:admin")) return "not_admin";
  // Attempted though daemonRead says asking: the act's request joins the probe in flight, so it waits for the answer.
  if (machine.reach === "probing") return null;
  // daemonRead rather than daemonReadable: a machine nobody has probed yet is asking, not unreachable.
  const read = daemonRead(machine.reach);
  if (read === "asking") return "asking";
  if (read === "unreachable") return "unreachable";
  return null;
}

export function skipText(reason: SkipReason): string {
  switch (reason) {
    case "owner_disabled":
      return "its owner is disabled, so it is switched off until an admin lifts that";
    case "over_limit":
      return "over the machine limit — retire another to bring it back";
    case "not_admin":
      return "you have access to its sessions but not to the machine itself";
    case "unreachable":
      return "not reachable right now, so what is installed there cannot be read";
    case "asking":
      return "not checked yet, so what is installed there is not known";
  }
}

/** Says when the plugin is switched off: an install never enables it and an update inherits the switch. */
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

export type RowAct = "install" | "update" | "remove";

/** A blocked or busy row offers nothing, which also keeps a second bulk press from double-sending. */
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

/** Removal is a bulk act only; rowActs still reports it so the bar's Remove can move (Q3.469). */
export function drawnActs(acts: readonly RowAct[]): RowAct[] {
  return acts.filter((one) => one !== "remove");
}

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

export interface Selection {
  /** How many machines are selected at all, shown or not. */
  selected: number;
  installable: number;
  updatable: number;
  removable: number;
  configurable: number;
  /** Whether this screen holds an archive at all. `false` on the Offline path. */
  canInstall: boolean;
}

export type BulkAct = "install" | "update" | "remove" | "settings";

/** Install, Update and Remove need any capable machine; Settings needs every selected one. Counts are clamped to selected. */
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

export function isBehind(version: string, available: string | null): boolean {
  return available !== null && isNewer(available, version);
}

/** Not skipReasonFor: settings need session scopes, not machine:admin. The unknowable states outrank not_installed, since a failed fetch also reads as null. */
export type SettingsBlock =
  | "owner_disabled"
  | "over_limit"
  | "no_scope"
  | "asking"
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
  const read = daemonRead(machine.reach);
  if (read === "asking") return "asking";
  if (read === "unreachable") return "unreachable";
  if (installed === null) return "not_installed";
  if (!installed.contributes.settings) return "no_pane";
  return null;
}

export function settingsBlockText(block: SettingsBlock, machineName: string, version: string | null): string {
  switch (block) {
    case "owner_disabled":
      return `${machineName}'s owner is disabled, so it is switched off until an admin lifts that`;
    case "over_limit":
      return `${machineName} is over the machine limit — retire another to bring it back`;
    case "no_scope":
      return `you have access to ${machineName}'s sessions but not to what is installed on it`;
    case "asking":
      return `${machineName} has not been checked yet, so its settings have not been read`;
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

/** The empty string rather than null, so one value feeds the line and its aria-describedby. Callers pass fleet order. */
export function settingsNotice(
  blocked: readonly { name: string; block: SettingsBlock; version: string | null }[],
): string {
  const first = blocked[0];
  if (first === undefined) return "";
  const one = settingsBlockText(first.block, first.name, first.version);
  return blocked.length === 1 ? `${one}.` : `${one}, and ${blocked.length - 1} more.`;
}

export type InstallFilter = "all" | "installed" | "absent";

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

/** One call feeds both the select-all box and the scroller, so they cannot disagree. */
export function shownRows<T extends { id: string; name: string; installed: boolean }>(
  rows: readonly T[],
  needle: string,
  filter: InstallFilter,
): T[] {
  return rows.filter((row) => rowShown(row, needle, filter));
}

/** Hidden rows stay selected, so the line has to say so. */
export function selectionLine(selected: number, hidden: number): string {
  if (selected <= 0) return "nothing selected";
  if (hidden <= 0) return selected === 1 ? "1 machine selected" : `${selected} machines selected`;
  return `${selected} selected, ${hidden} of them not shown`;
}

/** Real quotation marks, never JSON.stringify, which would show the query escaped. */
export function noRowsText(total: number, needle: string, filter: InstallFilter): string {
  if (total === 0) return "You have no machines yet, so there is nowhere to put a plugin.";
  const wanted = needle.trim();
  if (wanted.length > 0) return `No machine here is called \u201c${wanted}\u201d.`;
  if (filter === "installed") return "It is not on any of your machines.";
  if (filter === "absent") return "It is on every machine you have.";
  return "You have no machines yet, so there is nowhere to put a plugin.";
}

export function removalQuestion(names: readonly string[]): string {
  if (names.length === 1) return `Remove it from ${names[0]} and everything it kept there?`;
  return `Remove it from ${names.length} machines and everything it kept on them?`;
}

export const NAMES_BEFORE_COUNT = 3;

export function installedSummary(total: number, names: readonly string[]): string {
  if (total === 0) return "no machines";
  if (names.length === 0) return "not installed anywhere";
  if (names.length === total) return total === 1 ? "installed" : `on all ${total} machines`;
  if (names.length <= NAMES_BEFORE_COUNT) return `on ${names.join(", ")}`;
  return `on ${names.length} of ${total} machines`;
}

/** Never says "all": this is a chosen snapshot, not a standing policy (Q7.42). */
export function scopeSummary(names: readonly string[]): string {
  if (names.length === 0) return "no machines";
  if (names.length <= NAMES_BEFORE_COUNT) return names.join(", ");
  return `${names.length} machines`;
}

/** Switched off outranks the version comparison: an update inherits the switch position. */
export function installedSubline(version: string, available: string | null, enabled: boolean): string {
  if (!enabled) return `${version} · switched off`;
  if (available === null) return version;
  if (isBehind(version, available)) return `${version} · ${available} available`;
  if (isNewer(version, available)) return `${version} · newer than the ${available} offered here`;
  return version;
}

/** Names the machines an act failed on, never what happened there. The empty string feeds both the line and its live region. */
export function failureSummary(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `Failed on ${names[0]} — the row says why.`;
  if (names.length <= NAMES_BEFORE_COUNT) return `Failed on ${names.join(", ")} — each row says why.`;
  return `Failed on ${names.length} machines — each row says why.`;
}
