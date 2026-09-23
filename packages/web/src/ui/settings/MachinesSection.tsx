import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { CONTROL_PLANE_UNREACHABLE } from "../../account";
import { AGENT_HOST_OS, installCommand } from "../../enrollment";
import { controlPlaneOrigin } from "../../native";
import {
  machineAllowanceText,
  machineBadgeText,
  machineQuotaNotice,
  mayAddMachine,
} from "../../quota";
import { navigate } from "../../router";
import { settingsPath } from "../../settings";
import type { AppState } from "../../store";
import { ambiguousNames, enrolledByText, lastSeenText } from "../../wire";
import {
  Badge,
  Dot,
  Empty,
  Icon,
  SETTINGS_HEADING,
  SETTINGS_SECTION,
  SkeletonRow,
  reachText,
} from "../bits";
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
 *
 * **The list first, the installer under it, and no sentence introducing either**
 * (decision 3B). The intro — "A machine is a host running the daemon. To add
 * one, run this on it:" — sat above the command, above the list, so the first
 * thing on the screen was an explanation of the second thing and the rows
 * somebody came to scan were below both. The heading ADD A MACHINE over a
 * command line *is* the instruction; when there is no door, the quota notice
 * takes the command's place under the same heading, so exactly one sentence on
 * this screen is ever about the limit.
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
      {/* First section on the screen, so `SETTINGS_HEADING` alone — a rule above
          the first thing on a page is a line under the title. */}
      <section>
        <div className="flex items-baseline gap-2">
          <h2 className={SETTINGS_HEADING}>Your machines</h2>
          {/* `text-faint` and beside the heading: a fact about the list, which must
              never look like the notice — the one sentence here allowed to be
              about a *problem*. */}
          {allowance !== null && <span className="text-2xs text-faint">{allowance}</span>}
        </div>

        <div className="mt-3 space-y-2">
          {state.phase === "loading" ? (
            /*
             * **"No machines yet." may never be a false claim**, and this is the
             * arm that keeps it true. Today it is a guard rather than a state:
             * `App.tsx` draws a spinner for the whole app while `phase` is
             * `loading`, and `bootstrap` promotes to `ready` only on the listing
             * having landed — so this screen is never mounted before the first
             * read. The arm exists because that gate is one file away and the
             * sentence below is the wrong thing to draw the day it moves. One
             * `SkeletonRow`, never more: the expected count here is 0–1. `tall`,
             * because the row it stands in for is `min-h-14` — a dot, a badge and
             * a subline — and the default 11 was a 12px jump on arrival (Q3.548).
             */
            <SkeletonRow tall />
          ) : state.machines.length === 0 ? (
            /*
             * **"No machines yet." is false while the control plane is
             * unreachable**, and it is the one state where this list is empty for
             * a reason that has nothing to do with how many machines you have.
             * `bootstrap` keeps `phase: "ready"` with no machines and `cpError`
             * set on a cold load against a dead control plane, and the banner
             * that says so (`ControlPlaneNotice`) is rendered in `AppShell`'s
             * *sessions* arm and in `Home` — neither of which is on screen here.
             * So an outage drew a confident empty state with a remedy that could
             * not work: the installer goes to the same service. `failed`, because
             * this is the absence of an answer rather than an answer of "none".
             * The first sentence is every other screen's (`CONTROL_PLANE_UNREACHABLE`);
             * the second is this list's own, because an empty list under an outage
             * is the one place the reader might think the fleet went with it. Three
             * words, so the pair sits at the eight-word empty-state cap (Q3.544):
             * "Your machines are not gone." put it at ten (E8's review).
             */
            state.cpError !== null ? (
              <Empty failed>{CONTROL_PLANE_UNREACHABLE} Nothing is gone.</Empty>
            ) : (
              // The section under this one is how to add one, or why nothing can
              // be added, so the empty list need not say either.
              <Empty>No machines yet.</Empty>
            )
          ) : (
            state.machines.map((machine) => (
              <MachineRow
                key={machine.id}
                machine={machine}
                showId={ambiguous.has(machine.name.toLowerCase())}
                isThisDevice={machine.id === state.localMachineId}
              />
            ))
          )}
        </div>
      </section>

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
       * **Replaced by the notice, never disabled**, in the `!canAdd` state: a
       * command that adds a machine, printed under a heading saying to add one,
       * would make the heading a lie while `machineQuotaNotice` stayed literally
       * `null`-iff-`mayAddMachine`. The property that pair protects is "a door,
       * or the sentence saying why there is not one", under one heading.
       *
       * Nothing under the command. The old note restated the intro ("it installs
       * the daemon, asks who you are, and adds the machine itself") and printed
       * the script's URL in full beside a command that already shows it; a
       * "Read it first" link that replaced it went the same day — the URL is in
       * the command, and anybody who wants to read the script can open it.
       */}
      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Add a machine</h2>
        {canAdd ? (
          <>
            {/* Which machines this is for, for `AGENT_HOST_OS`'s reason: the
                command is about the computer that will run agents, not about the
                one drawing this screen. */}
            <p className="mt-3 text-xs text-muted">Run this on the {AGENT_HOST_OS} machine you want to use:</p>
            <div className="mt-2">
              <CommandLine command={installCommand(controlPlaneOrigin())} />
            </div>
          </>
        ) : (
          <p className="mt-2 text-xs text-muted">{machineQuotaNotice(state.me)}</p>
        )}
      </section>
    </div>
  );
}

function MachineRow({
  machine,
  showId,
  isThisDevice,
}: {
  machine: AppState["machines"][number];
  /** Another machine in this list answers to the same name. See `ambiguousNames`. */
  showId: boolean;
  /**
   * This row is the computer the app is running on.
   *
   * ⚠ **Settings' half of "local" after 2026-09-15.** The machine's label is
   * the ordinary host name, because that row is read by a phone and by every
   * other client of the account; which row you are *sitting at* is true of one
   * client only, so it is drawn and stored nowhere. The home screen draws it as
   * the name `local`, first in the list (`machineDisplayName`, `orderMachines`);
   * this screen is where the real label is *managed* — renamed, compared, told
   * apart from a colliding one — so it keeps that label and says `this device`
   * beside it instead. `AppState.localMachineId` is the read for both, and it
   * comes from the machine this app created here and the daemon's announce file
   * rather than from the route — a routing preference can be switched off, and
   * neither half may go with it.
   *
   * ⚠ **Not the same claim as the `This device` *heading* one screen along.**
   * That heading (`MachineSection.tsx`) is on every machine's page and is about
   * *this client's* preference for reaching that host. This is about which host
   * the client is on. Same two words, two facts, and they are never on screen
   * together.
   */
  isThisDevice: boolean;
}): ReactNode {
  /*
   * **At most one badge per row.** A limit or enrolment badge is the fact that
   * has to be fixed first; `this device` is what makes one row findable in a list
   * where every name is now an ordinary host name; `shared` is a fact about who
   * may act, and it gives way to both. Two boxes beside a truncating name on a
   * 390px phone is the collapse the kebab exists to prevent, and it is the *name*
   * that truncates — every badge is `shrink-0`, because the badge is what makes
   * the row recognisable.
   *
   * ⚠ **`this device` outranks `shared` rather than the other way round**, even
   * though a shared machine you are sitting at is possible: of the two, the one
   * that tells you *where you are* is the one you scan the list for, and the one
   * about who may act is answered on the row's own screen the moment you open it.
   */
  const stateBadge = machineBadgeText(machine);
  const badge = stateBadge ?? (isThisDevice ? "this device" : machine.owned === true ? null : "shared");

  const standing =
    machine.ownerDisabled || machine.overLimit
      ? /*
         * The badge names the state, so the subline does not say it again —
         * "over the limit" was drawn twice on one row, once in a box and once as
         * a clause. What survives is the age, the one fact the badge cannot
         * carry; `lastSeenText` is `null` where it would be noise.
         */
        lastSeenText(machine.lastSeenAt)
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

  /*
   * **Who brought this machine online, on a line of its own — not a clause on
   * `standing`, and not a badge.**
   *
   * Not a badge because the row already spends its one badge on the fact that
   * has to be *fixed* first, and this is not a fault: most rows that carry it
   * are ordinary wizard installs naming the admin who ran the installer. A
   * second box beside a truncating name is also the collapse the one-badge rule
   * exists to prevent.
   *
   * ⚠ **And not joined into `standing` with a ` · `, which is where the same
   * mistake was made once already.** " · not yours to rename or retire" rode
   * that line, and on a 390px phone the one fact telling you a row was inert was
   * the part that got cut; it is a badge now for exactly that reason. The line
   * below truncates too, but it truncates in the *name* — "Enrolled by " is
   * still there to be read, and the name is what the reader is being asked to
   * recognise or not.
   *
   * They are also two different kinds of fact, which is why one line cannot hold
   * both honestly: `standing` is about *now* and changes on the four-second
   * poll, while this is provenance and changes only when somebody re-enrolls the
   * machine. `enrolledByText` answers `null` wherever there is nothing to say —
   * a machine you enrolled yourself, one that predates the column, and a control
   * plane that has never heard of the question — so the row grows a line only in
   * the case the disclosure is about.
   */
  const provenance = enrolledByText(machine.enrolledBy);

  return (
    <button
      onClick={() => navigate(settingsPath("machines", machine.id))}
      className="tap press flex w-full min-h-14 items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2.5 text-left hover:border-edge-strong"
    >
      <Dot tone={machine.reach === "online" ? "on" : "off"} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium">{machine.name}</span>
          {badge !== null && (
            <span className="shrink-0">
              {/* `strong` for a state that needs fixing and for `this device`,
                  plain for `shared`, which is a fact and not a problem. `bits.tsx`
                  enumerates `this device` among the app's non-plain uses by name,
                  and `AccountSection` already draws it that way for the sign-in
                  row — the same two words, weighted the same, one screen apart. */}
              <Badge tone={badge === "shared" ? "plain" : "strong"}>{badge}</Badge>
            </span>
          )}
        </span>
        {(showId || standing !== null) && (
          <span className="block truncate text-2xs text-muted">
            {showId && (
              <>
                <code className="text-2xs text-muted/80">{machine.id}</code>
                {standing !== null && " · "}
              </>
            )}
            {standing}
          </span>
        )}
        {/* Under the standing line, because standing is what the dot beside it
            is already about and this is a fact of a different kind. Same
            `text-2xs text-muted` as the line above: it is a subline, not a
            warning, and there is no tone here that would be honest for "an
            ordinary install, or the one row you should look at twice". */}
        {provenance !== null && <span className="block truncate text-2xs text-muted">{provenance}</span>}
      </span>
      {/* The glyph says rows open. This list interleaves rows with headings, a
          command line and two empty states, and one of its rows may be a machine
          you do not own, which is exactly where a reader would otherwise assume
          it is inert. */}
      <Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />
    </button>
  );
}
