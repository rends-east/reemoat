import type { AgentStance } from "./agentCard";
import type { InstallOutcome, InstallPhase, InstallRunView } from "../wire";

export type InstallStage = "starting" | "working" | "done" | "failed";

export function installStage(run: Pick<InstallRunView, "done" | "outcome" | "phase">): InstallStage {
  if (!run.done) return run.phase === null || run.phase === "start" ? "starting" : "working";
  return run.outcome === "installed" ? "done" : "failed";
}

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

/** Restated rather than imported from install.ts: the same number for a different judgement. */
export const ELAPSED_AFTER_MS = 10_000;

export function installElapsed(since: number, now: number): string | null {
  const elapsed = now - since;
  if (!Number.isFinite(elapsed) || elapsed < ELAPSED_AFTER_MS) return null;
  return `${Math.round(elapsed / 1000)}s`;
}

export type PrimaryControl = "installing" | "wizard" | "install" | "sign_out" | "sign_in" | "none";

export function primaryControl(input: {
  stance: AgentStance;
  installRunning: boolean;
  wizardOpen: boolean;
  installable: boolean;
  canSignIn: boolean;
  canSignOut: boolean;
}): PrimaryControl {
  if (input.installRunning) return "installing";
  if (input.wizardOpen) return "wizard";
  switch (input.stance) {
    // Before the credential axis: canSignIn is already false for a missing harness (Q3.640).
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
      const exhaustive: never = input.stance;
      return exhaustive;
    }
  }
}

export type InstallResult = "checking" | "installed" | "notInstalled" | "unreachable";

export function installResult(checking: boolean, checkFailed: boolean, available: boolean): InstallResult {
  if (checking) return "checking";
  if (checkFailed) return "unreachable";
  return available ? "installed" : "notInstalled";
}

/** The installed arm names the next step: a new harness has no tile until it is signed in. */
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

/** Mirrors the daemon's MAX_OUTPUT_BYTES, which web cannot import; chars here against bytes there is deliberate. */
export const MAX_INSTALL_OUTPUT_CHARS = 64 * 1024;

/** Keeps the tail within the daemon's bound; a caller that drops output owes the gap notice. */
export function keepInstallTail(held: string): string {
  if (held.length <= MAX_INSTALL_OUTPUT_CHARS) return held;
  return held.slice(held.length - MAX_INSTALL_OUTPUT_CHARS);
}

/** Opens only for failed, the one outcome whose sentence is generic. */
export function rawInstallIsOpen(run: Pick<InstallRunView, "done" | "outcome"> | null): boolean {
  if (run === null || !run.done) return false;
  return run.outcome === "failed";
}
