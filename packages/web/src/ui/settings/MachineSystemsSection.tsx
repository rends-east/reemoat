import type { ReactNode } from "react";
import { daemonRead } from "../../machine";
import type { MachineId } from "../../ids";
import { navigate } from "../../router";
import { harnessSigninPath, settingsPath } from "../../settings";
import type { AppState } from "../../store";
import { Button, Empty, reachText, Spinner } from "../bits";
import { AgentDetail } from "./AgentsPanel";
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
  signin,
}: {
  state: AppState;
  machineId: MachineId;
  system: string | null;
  /**
   * The harness whose own card this screen is, if the URL names one.
   *
   * ⚠ **Never together with `system`** — they are two leaves of one list, and the
   * parser produces at most one of them. Handled here rather than in a section of
   * its own because the screen above them is the same list and the reachability
   * arms above are the same three.
   */
  signin: string | null;
}): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;

  if (machine === null) {
    /*
     * A stale link, or a machine revoked in another tab.
     *
     * ⚠ **The chevron does not walk you out of this, and the comment here used to
     * claim it did.** `settingsUp` sends a system's ◀ to `/settings/machines/<id>`
     * — the machine's own screen — which for a machine that is gone draws this
     * exact sentence again: two identical dead ends in a row, the second of them
     * reached by taking the only visible way back. So the way out is drawn here,
     * and it is the list, which is the first address on this path that still
     * resolves. (Still not the ✕ — that is `useUnder` and leaves settings
     * entirely, which is a different destination. Q3.415.)
     *
     * ⚠ **Not `failed`.** This is a settled answer rather than an absent one:
     * nothing was asked and nothing failed to come back. `Empty`'s partition
     * reserves the triangle and the live region for a read that did not return.
     *
     * `replace`, because the list is shallower — `web-shell.md`'s rule for
     * anything that moves you up inside an overlay — and because the address it
     * replaces names a machine that no longer exists, so Back must not return to
     * it.
     */
    return (
      <Empty
        action={
          <Button size="sm" onClick={() => navigate(settingsPath("machines"), true)}>
            All machines
          </Button>
        }
      >
        That machine is not in your list any more.
      </Empty>
    );
  }

  /*
   * ⚠ **Three answers, not two, and the missing one was the ordinary path.**
   * `daemonReadable` answers `false` for `unknown` — a machine nobody has asked
   * yet — so a cold load or a deep link drew *"laptop is not reachable right now
   * — …."* for the two or three seconds before the first probe landed, with
   * `reachText`'s `unknown` arm supplying the bare ellipsis. `daemonRead` is the
   * partition `missingRowReason` already proved out for `SessionView`: the
   * never-asked state is a wait, and only `offline` has earned the sentence.
   */
  const read = daemonRead(machine.reach);

  /*
   * ⚠ **No lede, at either depth, and the `lede` prop went with it.** The
   * sentence said where the credentials live ("Stored on <id> only — not shared
   * with your other machines"), and `MachineSection` passed `lede={false}` so as
   * not to say it twice on the one screen that already had. The leaf never
   * needed it either: the machine is named by the chevron pointing back at it,
   * and everything on this screen writes to that machine's daemon by
   * construction. A fact with no decision hanging off it is a heading's job, and
   * the heading is there.
   */
  return (
    <div>
      {read === "asking" ? (
        /*
         * ⚠ **No failure claim, because nothing has been measured.** No `failed`,
         * no `role="status"`: this is a wait rather than an event, and announcing
         * it would put "not reachable" in the live region of a machine that turns
         * out to be online a second later. The ellipsis is the truthful
         * trailing-off of a question in flight, which is the one place `reachText`
         * keeps one too.
         *
         * The spinner is `SystemChooser`'s own "Asking that machine…" shape one
         * component down, so a wait for the *route* and a wait for the *systems*
         * look like the same wait rather than two unrelated blanks.
         */
        <Empty>
          <span className="inline-flex items-center gap-2">
            <Spinner /> Checking whether {machine.name} is reachable…
          </span>
        </Empty>
      ) : read === "unreachable" ? (
        /*
         * Not filtered out and not silently empty. An unreachable machine is the
         * commonest reason somebody is on this screen — they came to sign in
         * because a session failed — so the honest thing is to name the machine
         * and say why nothing is listed. `failed`, because this one *is* the
         * absence of an answer: the probe was made and did not come back.
         */
        <Empty failed>
          {/*
           * The trailing clause — ", so nothing about <system> can be read or
           * changed" — is cut. It named the system because this branch replaces
           * `SystemDetail`, the only other thing that said which one you drilled
           * into; but a phone deep-linked here against an offline daemon still
           * cannot act on that name, and the machine's own sentence is what the
           * reader can act on. `webcheck` pins the sentence's first half.
           */}
          {machine.name} is not reachable right now — {reachText(machine.reach, machine.offlineReason)}.
        </Empty>
      ) : signin !== null ? (
        /*
         * The other leaf, and it is the same component the provider leaf reaches
         * one layer down — `SystemDetail` mounts `AgentDetail` too. What differs is
         * that there is no system standing over it, so nothing scopes the card to
         * one variable: a harness nobody speaks for draws its own name and every
         * slot its manifest declared.
         *
         * Keyed for `SystemDetail`'s reason, which is a live login run rather than
         * anything about this screen.
         */
        <AgentDetail key={`${machineId}:${signin}`} machineId={machineId} agentId={signin} />
      ) : system === null ? (
        /* "readable" — and `probing` lands here deliberately. A re-probe is this
           client re-checking a route it forgot on waking, on a machine it already
           believed in; taking the panel away for it is the regression
           `daemonReadable`'s docblock is entirely about. */
        <SystemChooser
          machineId={machineId}
          onPick={(picked) => navigate(settingsPath("machines", machineId, picked))}
          onPickHarness={(agent) => navigate(harnessSigninPath(machineId, agent))}
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
