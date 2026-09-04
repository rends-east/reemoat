import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { installCommand } from "../../enrollment";
import {
  machineAllowanceText,
  machineBadgeText,
  machineQuotaNotice,
  mayAddMachine,
} from "../../quota";
import { navigate } from "../../router";
import { settingsPath } from "../../settings";
import type { AppState } from "../../store";
import { ambiguousNames, lastSeenText } from "../../wire";
import { Badge, Dot, Empty, Icon, SETTINGS_HEADING, SETTINGS_SECTION, reachText } from "../bits";
import { CommandLine } from "../CommandLine";

/**
 * Your machines, and adding one.
 *
 * **This screen is what took the admin off the critical path.** Registering a
 * machine, granting it to somebody, and minting its enrollment code used to be
 * three separate administrative acts, none implying the others — and both install
 * wizards printed the missing third as a hint and ran neither, so a daemon could
 * enroll, dial the relay, hold a tunnel, and appear in nobody's list. It is one
 * request now, made by the one-line installer on the machine itself, on behalf of
 * the person who signed in to it.
 *
 * **No code is minted on this screen any more.** The by-name form that handed
 * back a single-use enrollment code went with the vendored CLIs' era of "a host
 * that already has a checkout": that host runs the same script. The route still
 * deliberately allows a re-mint — that is how a host is re-installed, and
 * redeeming such a code rotates the machine's tunnel credential — and everything
 * a re-mint is for is `cpctl enroll <machineId>`. Retire-then-Add is expressly
 * not the substitute: it mints a new machine id and silently drops every grant but
 * the creator's. Q3.428.
 */

export function MachinesSection({ state }: { state: AppState }): ReactNode {
  /*
   * **The shared predicate, asked once and never re-derived here.**
   *
   * `mayAddMachine` reads the control plane's own `canAddMachine`; deriving it
   * from `machineLimit`/`machineCount` at this call site is the exact defect
   * `showsGateLink` was extracted to end, and `webcheck` reads this file off
   * disk to assert neither number is mentioned in it.
   */
  const canAdd = mayAddMachine(state.me);
  /*
   * **The readout, which is a different sentence from the notice.**
   *
   * `machineQuotaNotice` is `null` **iff** the door is drawn, which is the
   * invariant `webcheck` asserts on it — so it can never carry "2 of 5" while
   * there is room. This is the second function that invariant's own docblock
   * names, and it answers the question the screen could not: how much is left,
   * asked *before* running out rather than at the moment of refusal.
   */
  const allowance = machineAllowanceText(state.me);
  /*
   * Which names are worth an id beside them, asked once for the whole list rather
   * than per row — it is a property *of the list*, and a row cannot see its
   * siblings. See `ambiguousNames`.
   */
  const ambiguous = ambiguousNames(state.machines);

  return (
    /*
     * **No padding of its own.** `Settings.tsx` already gives this column
     * `px-4 py-4 sm:px-5`, and a second `px-4 pt-4` here inset the content twice —
     * 32px on a phone against `ServerSection`'s 16px, which is one screen and two
     * different left edges.
     */
    <div>
      {/*
       * The intro is a claim about what this screen does, and in the state
       * where there is no door it would be false — "run this on it" over nothing
       * to run. The notice takes its place rather than joining it, so exactly
       * one sentence on this screen is about the limit.
       */}
      <p className="text-xs text-muted">
        {canAdd ? "A machine is a host running the daemon. To add one, run this on it:" : machineQuotaNotice(state.me)}
      </p>

      {/*
       * **The one-line installer is the only door, and the by-name form is gone.**
       * That form minted an enrollment code to carry to a host by hand — the path
       * for a machine that already had a checkout — and it sat above this command
       * with an "Or, on a machine with nothing on it yet:" between them, which put
       * two ways of doing one thing on a screen whose reader wants one. Decided
       * 2026-09-04: a machine is added by running the script, full stop; a host
       * with a checkout runs the same script, and `cpctl` still mints a code for
       * an operator who needs one. `webcheck` asserts the form's absence.
       *
       * **Removed, not disabled**, in the `!canAdd` state: a command that adds a
       * machine, printed under a sentence saying there is no way to add one, would
       * make that sentence a lie while `machineQuotaNotice` stayed literally
       * `null`-iff-`mayAddMachine`. The property that pair protects is "a door,
       * or the sentence saying why there is not one".
       *
       * Nothing under the command. The old note restated the intro ("it installs
       * the daemon, asks who you are, and adds the machine itself") and printed
       * the script's URL in full beside a command that already shows it; a
       * "Read it first" link that replaced it went the same day — the URL is in
       * the command, and anybody who wants to read the script can open it.
       */}
      {canAdd && <CommandLine command={installCommand(location.origin)} />}

      {/* `h2` under `Sheet`'s `h1` and the pane's own heading, in the app's one
          settings-section chrome — see `SETTINGS_SECTION`. */}
      <section className={SETTINGS_SECTION}>
        <div className="flex items-baseline gap-2">
          <h2 className={SETTINGS_HEADING}>Your machines</h2>
          {/* `text-faint` and beside the heading: a fact about the list, which must
              never look like the notice — the one sentence here allowed to be
              about a *problem*. */}
          {allowance !== null && <span className="text-2xs text-faint">{allowance}</span>}
        </div>

        <div className="mt-3 space-y-2">
        {state.machines.length === 0 ? (
          /*
           * **"Add one above" is false while the control plane is unreachable**,
           * and it is the one state where this list is empty for a reason that
           * has nothing to do with how many machines you have. `bootstrap` keeps
           * `phase: "ready"` with no machines and `cpError` set on a cold load
           * against a dead control plane, and the banner that says so
           * (`ControlPlaneNotice`) is rendered in `AppShell`'s *sessions* arm and
           * in `Home` — neither of which is on screen here. So an outage drew a
           * confident empty state with a remedy that could not work: `POST
           * /v1/machines` goes to the same service.
           */
          state.cpError !== null ? (
            <Empty>
              Cannot reach the control plane, so your machines cannot be listed. They are not gone — this list is read
              from it, and so is adding one.
            </Empty>
          ) : (
            // One sentence in both states: the intro above is what says how to
            // add one, or why nothing can be added, so the empty list need not.
            <Empty>No machines yet.</Empty>
          )
        ) : (
          state.machines.map((machine) => (
            <MachineRow
              key={machine.id}
              machine={machine}
              showId={ambiguous.has(machine.name.toLowerCase())}
            />
          ))
        )}
        </div>
      </section>
    </div>
  );
}

function MachineRow({
  machine,
  showId,
}: {
  machine: AppState["machines"][number];
  /** Another machine in this list answers to the same name. See `ambiguousNames`. */
  showId: boolean;
}): ReactNode {
  const badge = machineBadgeText(machine);

  const standing = machine.ownerDisabled
    ? // Only ever a machine somebody else owns — a banned owner cannot reach
      // this screen — so the remedy named is the admin's, not theirs.
      "its owner has been disabled, so it is switched off until that is lifted"
    : machine.overLimit
      ? machine.owned === true
        ? "over your machine limit — retire another to bring it back"
        : "over its owner's machine limit"
      : machine.reach === "online"
        ? "online"
        : machine.enrolled
          ? /*
             * The reach, and **how long it has been that way** where that adds
             * anything. "Offline" alone was the same word for a lid that closed a
             * minute ago and a host that died last week, which is the one thing
             * somebody looking at this row wants to know. `lastSeenText` returns
             * `null` for the three cases where the number would be noise or a
             * claim — see it for which.
             */
            [reachText(machine.reach, machine.offlineReason), lastSeenText(machine.lastSeenAt)]
              .filter((part) => part !== null)
              .join(" · ")
          : "waiting for the daemon to dial in";

  return (
    <button
      onClick={() => navigate(settingsPath("machines", machine.id))}
      className="tap press flex w-full min-h-14 items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2.5 text-left hover:border-edge-strong"
    >
      <Dot tone={machine.reach === "online" ? "on" : "off"} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium">{machine.name}</span>
          {badge !== null && <Badge tone="strong">{badge}</Badge>}
        </span>
        <span className="block truncate text-2xs text-muted">
          {showId && (
            <>
              <code className="text-2xs text-muted/80">{machine.id}</code>
              {" · "}
            </>
          )}
          {standing}
          {machine.owned === true ? "" : " · not yours to rename or retire"}
        </span>
      </span>
      {/* `AgentChooser` needs no such glyph — its whole content is three tappable
          rows, so the block itself establishes that rows open. This list
          interleaves rows with prose, a form, a one-time secret and three empty
          states, and one of its rows may be a machine you do not own, which is
          exactly where a reader would otherwise assume it is inert. */}
      <Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />
    </button>
  );
}
