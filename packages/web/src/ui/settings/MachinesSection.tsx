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

/** Your machines, and the one-line installer as the only way to add one; re-minting a code is cpctl's (Q3.428). */

export function MachinesSection({ state }: { state: AppState }): ReactNode {
  // Ask the shared predicate; never re-derive it from the quota fields here.
  const canAdd = mayAddMachine(state.me);
  const allowance = machineAllowanceText(state.me);
  const ambiguous = ambiguousNames(state.machines);

  return (
    <div>
      <section>
        <div className="flex items-baseline gap-2">
          <h2 className={SETTINGS_HEADING}>Your machines</h2>
          {allowance !== null && <span className="text-2xs text-faint">{allowance}</span>}
        </div>

        <div className="mt-3 space-y-2">
          {state.phase === "loading" ? (
            // A guard so the empty sentence is never false; tall to match the row height (Q3.548).
            <SkeletonRow tall />
          ) : state.machines.length === 0 ? (
            // An empty list with cpError is a failed read, not none; worded within the empty-state cap (Q3.544).
            state.cpError !== null ? (
              <Empty failed>{CONTROL_PLANE_UNREACHABLE} Nothing is gone.</Empty>
            ) : (
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

      {/* With no room the notice replaces the command; a disabled command would make the heading a lie. */}
      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Add a machine</h2>
        {canAdd ? (
          <>
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
  showId: boolean;
  /** The computer this app runs on: marked with a badge here, while the home screen renames it local. */
  isThisDevice: boolean;
}): ReactNode {
  // At most one badge per row: a limit or enrolment state, then this device, then shared.
  const stateBadge = machineBadgeText(machine);
  const badge = stateBadge ?? (isThisDevice ? "this device" : machine.owned === true ? null : "shared");

  const standing =
    machine.ownerDisabled || machine.overLimit
      ?
        lastSeenText(machine.lastSeenAt)
      : machine.reach === "online"
        ? "online"
        : machine.enrolled
          ?
            [reachText(machine.reach, machine.offlineReason), lastSeenText(machine.lastSeenAt)]
              .filter((part) => part !== null)
              .join(" · ")
          : "waiting for the daemon to dial in";

  // Provenance gets its own line: not a badge, and not joined to standing, where it would truncate away.
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
        {provenance !== null && <span className="block truncate text-2xs text-muted">{provenance}</span>}
      </span>
      <Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />
    </button>
  );
}
