import type { ReactNode } from "react";
import { daemonReadable } from "../../machine";
import type { MachineId } from "../../ids";
import { navigate } from "../../router";
import { settingsPath } from "../../settings";
import type { AppState } from "../../store";
import { Empty, reachText } from "../bits";
import { SystemChooser, SystemDetail } from "./SystemsPanel";

/**
 * Systems, inside the machine you sign in to them on.
 *
 * This replaces a fleet-wide **Agents** section whose first control was a
 * machine dropdown — a screen asking a question its own copy answered, since
 * credentials live in one daemon's database and one host's home. The machine is
 * in the URL now, which is what `/new/:machineId` already does and for the same
 * two reasons: a component-state picker forgets itself on back-and-forward, and
 * a fixed close control needs somewhere real to close *to*.
 *
 * ⚠ **It also replaces the *word*.** These rows used to be `claude`, `kimi` and
 * `codex`, and what a person has an account with is Anthropic, OpenAI or
 * Moonshot. The distinction had no consequence while each harness spoke only to
 * its own vendor; it has one now, because a single Moonshot key serves `kimi`
 * natively and Claude Code routed, and filing it under an agent would mean two
 * copies and two answers to "signed in?".
 *
 * Two depths, both handled here: no system named is the chooser, a system named
 * is that system's whole configuration.
 */
export function MachineSystemsSection({
  state,
  machineId,
  system,
}: {
  state: AppState;
  machineId: MachineId;
  system: string | null;
}): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;

  if (machine === null) {
    // A stale link, or a machine revoked in another tab. Not an error screen: the
    // list two levels up is the answer, and the pane's chevron walks there one step
    // at a time. (Not the ✕ — that is `useUnder` and leaves settings entirely,
    // which is a different destination. Q3.415.)
    return <Empty>That machine is not in your list any more.</Empty>;
  }

  return (
    <div>
      <p className="text-xs text-muted">
        {/* The name is gone from this sentence because the pane's heading is
            directly above it now, at every width — it was the machine named twice
            within 40px. The id stays: it is the half a heading cannot carry, this
            screen is reached from a row that may have a twin, and everything below
            writes to one daemon's database. */}
        Credentials and settings live on <code className="text-muted/80">{machine.id}</code>, in
        that daemon's database and that host's home. Nothing here is shared with your other
        machines.
      </p>

      {!daemonReadable(machine.reach) ? (
        /*
         * Not filtered out and not silently empty. An unreachable machine is the
         * commonest reason somebody is on this screen — they came to sign in
         * because a session failed — so the honest thing is to name the machine
         * and say why nothing is listed.
         */
        <Empty>
          {machine.name} is not reachable right now — {reachText(machine.reach, machine.offlineReason)}
          {/*
           * **The system is named here because this branch *replaces*
           * `SystemDetail`**, which is the only other thing on the screen that
           * says which one you drilled into — and the head no longer says it
           * either, now that the pane's heading names the machine rather than the
           * URL segment. Without this, a phone deep-linked to
           * `/settings/machines/:id/systems/anthropic` against an offline daemon
           * named it nowhere on screen, on the screen this component's own comment
           * above calls the commonest reason anybody is here.
           */}
          {system === null ? "." : `, so nothing about ${system} can be read or changed.`}
        </Empty>
      ) : system === null ? (
        <SystemChooser
          machineId={machineId}
          onPick={(picked) => navigate(settingsPath("machines", machineId, picked))}
        />
      ) : (
        /*
         * Keyed on both, so switching system or machine remounts rather than
         * carrying the previous one's wizard state — `LoginWizard` holds a live
         * run id and a transcript, and adopting one across a switch would show
         * one system's login under another's name.
         */
        <SystemDetail key={`${machineId}:${system}`} machineId={machineId} systemId={system} />
      )}
    </div>
  );
}
