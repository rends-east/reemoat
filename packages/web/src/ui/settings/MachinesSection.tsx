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
import { Badge, Dot, Empty, SkeletonRow, reachText } from "../bits";
import { CommandLine } from "../CommandLine";
import { EmptyRow, Group, LinkRow } from "../kit/List";
import { AccountMessaging } from "./AccountMessaging";

/** Your machines, and the one-line installer as the only way to add one; re-minting a code is cpctl's (Q3.428). */
export function MachinesSection({ state }: { state: AppState }): ReactNode {
  // Ask the shared predicate; never re-derive it from the quota fields here.
  const canAdd = mayAddMachine(state.me);
  const allowance = machineAllowanceText(state.me);
  const ambiguous = ambiguousNames(state.machines);

  return (
    <div>
      {/* The switch for every machine heads the list of them, above the per-machine switches it locks (Q2.244). */}
      <AccountMessaging me={state.me} />

      <Group title="Your machines" count={allowance ?? undefined}>
        {state.phase === "loading" ? (
          // A guard so the empty sentence is never false; tall to match the row height (Q3.548).
          <SkeletonRow tall />
        ) : state.machines.length === 0 ? (
          // An empty list with cpError is a failed read, not none; worded within the empty-state cap (Q3.544).
          state.cpError !== null ? (
            <Empty failed>{CONTROL_PLANE_UNREACHABLE} Nothing is gone.</Empty>
          ) : (
            <EmptyRow>No machines yet.</EmptyRow>
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
      </Group>

      {/* With no room the notice replaces the command; a disabled command would make the heading a lie. */}
      {canAdd ? (
        <Group title="Add a machine" footer={`Run it on the ${AGENT_HOST_OS} machine.`} unboxed>
          <CommandLine command={installCommand(controlPlaneOrigin())} className="" />
        </Group>
      ) : (
        <Group title="Add a machine" still>
          <EmptyRow>{machineQuotaNotice(state.me)}</EmptyRow>
        </Group>
      )}
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
    <LinkRow
      glyph={<Dot tone={machine.reach === "online" ? "on" : "off"} />}
      title={machine.name}
      badge={badge === null ? undefined : <Badge tone={badge === "shared" ? "plain" : "strong"}>{badge}</Badge>}
      subline={
        showId || standing !== null ? (
          <>
            {showId && (
              <>
                <code className="text-2xs">{machine.id}</code>
                {standing !== null && " · "}
              </>
            )}
            {standing}
          </>
        ) : undefined
      }
      detail={provenance ?? undefined}
      onClick={() => navigate(settingsPath("machines", machine.id))}
    />
  );
}
