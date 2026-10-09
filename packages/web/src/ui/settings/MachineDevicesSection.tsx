import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { deviceName, deviceRows, removable } from "../../deviceAccess";
import { errorText, meansRouteAbsent } from "../../http";
import type { MachineId } from "../../ids";
import { daemonRead } from "../../machine";
import { deviceLabel, nativeBoot } from "../../native";
import { platformName } from "../../platform";
import { MACHINE_GONE } from "../../plugins";
import { store, type AppState } from "../../store";
import type { DeviceView, DevicesAnswer } from "../../wire";
import { Badge, Button, Empty, NotReachable, SkeletonRow, Spinner, SwitchRow, TwoStep, shortDuration } from "../bits";
import { EmptyRow, Group, TABLE, TD, TWO_STEP_ROW } from "../kit/List";
import { toast } from "../Toast";
import { registryUnread } from "../Unreachable";

/** Which keys may open a channel to this machine. The list is the machine's own, read through the channel, never the server's. */
export function MachineDevicesSection({ state, machineId }: { state: AppState; machineId: MachineId }): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;
  if (machine === null) return registryUnread(state) ?? <Empty>{MACHINE_GONE}</Empty>;

  const read = daemonRead(machine.reach);
  if (read === "asking") {
    return (
      <Empty>
        <span className="inline-flex items-center gap-2">
          <Spinner /> Checking whether {machine.name} is reachable…
        </span>
      </Empty>
    );
  }
  if (read === "unreachable") {
    return (
      <Empty failed>
        <NotReachable machine={machine} />
      </Empty>
    );
  }
  return (
    <DeviceAccess
      key={machineId}
      machineId={machineId}
      machineName={machine.name}
      waiting={state.devicesWaiting.get(machineId) ?? 0}
    />
  );
}

function DeviceAccess({
  machineId,
  machineName,
  waiting,
}: {
  machineId: MachineId;
  machineName: string;
  /** As the machine's last listing said: a change is the cue to read the list again. */
  waiting: number;
}): ReactNode {
  const [answer, setAnswer] = useState<DevicesAnswer | null>(null);
  const [unread, setUnread] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [absent, setAbsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  /** The count this component last wrote to the store: coming back as `waiting`, it is no cue to read the list again. */
  const wrote = useRef<number | null>(null);
  const asking = useRef(0);

  const take = (next: DevicesAnswer): void => {
    const count = deviceRows(next).waiting.length;
    wrote.current = count;
    setAnswer(next);
    setUnread(false);
    setError(null);
    store.noteDevicesWaiting(machineId, count);
  };

  const ask = (): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return;
    const mine = (asking.current += 1);
    void daemon.devices().then(
      (next) => {
        if (asking.current === mine) take(next);
      },
      (cause: unknown) => {
        if (asking.current !== mine) return;
        // An envelope-free 404 means the daemon predates the list: settled, not a failure.
        if (meansRouteAbsent(cause)) setAbsent(true);
        else setUnread(true);
      },
    );
  };

  useEffect(() => {
    const own = wrote.current === waiting;
    wrote.current = null;
    if (!own) ask();
    return () => {
      asking.current += 1;
    };
  }, [machineId, waiting]);

  if (absent) return <Empty>{machineName} needs a newer daemon to list its devices.</Empty>;
  if (unread) {
    return (
      <Group title="Known">
        <Empty
          failed
          action={
            <Button size="sm" onClick={ask}>
              Try again
            </Button>
          }
        >
          Could not read this machine's devices.
        </Empty>
      </Group>
    );
  }

  const setLock = (on: boolean): Promise<void> => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return Promise.resolve();
    const label = deviceLabel();
    const key = nativeBoot()?.devicePublicKey ?? null;
    setBusy(true);
    return daemon
      .setDeviceLock(on, label === null || key === null ? null : { publicKey: key, ...label })
      .then(take)
      .finally(() => setBusy(false));
  };

  const rows = answer === null ? null : deviceRows(answer);

  return (
    <>
      {rows !== null && rows.waiting.length > 0 && (
        <Group title="Waiting">
          <DeviceTable machineId={machineId} rows={rows.waiting} you={answer?.you ?? null} locked onChanged={take} />
        </Group>
      )}

      <Group title="Known" error={error}>
        {rows === null && <SkeletonRow />}
        {rows !== null && rows.known.length === 0 && <EmptyRow>No device has connected through the relay yet.</EmptyRow>}
        {rows !== null && rows.known.length > 0 && (
          <DeviceTable
            machineId={machineId}
            rows={rows.known}
            you={answer?.you ?? null}
            locked={answer?.lock === true}
            onChanged={take}
          />
        )}
      </Group>

      {answer !== null && (
        <Group>
          {/* Only the widening is confirmed: locking narrows who gets in, unlocking hands that back to the server. */}
          <TwoStep
            armed={unlocking}
            onArm={setUnlocking}
            align="end"
            className={unlocking ? TWO_STEP_ROW : ""}
            rest={
              <SwitchRow
                title="Only these devices"
                subline="A new device waits here for approval."
                on={answer.lock}
                busy={busy}
                onToggle={() => {
                  if (answer.lock) setUnlocking(true);
                  else void setLock(true).catch((cause: unknown) => setError(errorText(cause)));
                }}
              />
            }
            question={`Let any signed-in device reach ${machineName}?`}
            consequence="The server alone decides again."
            act={{ label: "Unlock" }}
            onAct={() => setLock(false)}
          />
        </Group>
      )}
    </>
  );
}

/** A code is compared character by character: mono, a step under the sans around it, and never broken at its hyphen. */
const CODE = "font-mono text-2xs whitespace-nowrap";

function approveOnly(code: string | null): ReactNode {
  if (code === null) return "Only if it shows this same code.";
  return (
    <>
      Only if it shows <span className={CODE}>{code}</span>.
    </>
  );
}

/** Fixed columns: a row that arms its TwoStep spans both, and an auto layout would reflow the others under it. */
function DeviceTable({
  machineId,
  rows,
  you,
  locked,
  onChanged,
}: {
  machineId: MachineId;
  rows: DeviceView[];
  you: string | null;
  locked: boolean;
  onChanged: (next: DevicesAnswer) => void;
}): ReactNode {
  return (
    <table className={`${TABLE} table-fixed`}>
      <colgroup>
        <col />
        <col className="w-44" />
      </colgroup>
      <tbody>
        {rows.map((row) => (
          <DeviceRow key={row.id} machineId={machineId} row={row} you={you} locked={locked} onChanged={onChanged} />
        ))}
      </tbody>
    </table>
  );
}

function DeviceRow({
  machineId,
  row,
  you,
  locked,
  onChanged,
}: {
  machineId: MachineId;
  row: DeviceView;
  you: string | null;
  locked: boolean;
  onChanged: (next: DevicesAnswer) => void;
}): ReactNode {
  const [confirming, setConfirming] = useState<"approve" | "remove" | null>(null);
  const name = deviceName(row);
  const pending = row.state === "pending";
  const own = !removable(row, you);
  const now = Date.now();

  const approve = (): Promise<void> => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return Promise.resolve();
    return daemon.approveDevice(row.id).then((next) => {
      toast("ok", `${name} is let in.`);
      onChanged(next);
    });
  };

  const remove = (): Promise<void> => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return Promise.resolve();
    return daemon.removeDevice(row.id).then(onChanged);
  };

  // One TwoStep for both acts, so arming one hides the other's button; armed, it takes the whole row.
  const decision = (
    <TwoStep
      armed={confirming !== null}
      onArm={(next) => {
        if (!next) setConfirming(null);
      }}
      align="end"
      question={
        <>
          {confirming === "approve" ? "Let " : pending ? "Deny " : "Remove "}
          <bdi>{name}</bdi>
          {confirming === "approve" ? " in?" : "?"}
        </>
      }
      consequence={
        confirming === "approve"
          ? approveOnly(row.code)
          : pending
            ? "It can ask again."
            : locked
              ? "It has to be let in again."
              : "It is listed again when it connects."
      }
      act={
        confirming === "approve"
          ? { label: "Let in", ariaLabel: `Let ${name} in` }
          : { label: pending ? "Deny" : "Remove", danger: true, icon: Trash2, ariaLabel: `${pending ? "Deny" : "Remove"} ${name}` }
      }
      onAct={confirming === "approve" ? approve : remove}
      onFailure={(cause) => toast("error", errorText(cause))}
      // Letting in is the act that widens who reaches the machine, so it stays last: a double tap lands on Cancel, never on it.
      rest={
        <span className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => setConfirming("remove")}>
            {pending ? "Deny" : "Remove"}
          </Button>
          {pending && (
            <Button size="sm" tone="primary" onClick={() => setConfirming("approve")}>
              Let in
            </Button>
          )}
        </span>
      }
    />
  );

  if (confirming !== null) {
    return (
      <tr className="border-t border-edge first:border-t-0">
        <td colSpan={2} className={TD}>
          {decision}
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-edge first:border-t-0">
      <td className={TD}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium">
            <bdi>{name}</bdi>
          </span>
          {/* One badge per row: this device, then a machine. */}
          {own ? (
            <span className="shrink-0">
              <Badge tone="strong">this device</Badge>
            </span>
          ) : (
            row.kind === "machine" && (
              <span className="shrink-0">
                <Badge>machine</Badge>
              </span>
            )
          )}
        </span>
        {/* Compared with the waiting device's own screen, so it shares a line with nothing the device chose (Q1.656). */}
        {pending && row.code !== null && (
          <span className={`block text-muted ${CODE}`}>
            <span className="sr-only">code </span>
            {row.code}
          </span>
        )}
        <span className="block truncate text-2xs text-faint">
          {row.platform !== null && row.platform.length > 0 ? `${platformName(row.platform)} · ` : ""}
          {pending
            ? `asked ${shortDuration(Math.max(0, now - row.lastSeenAt))} ago`
            : own
              ? "in use"
              : `last used ${shortDuration(Math.max(0, now - row.lastSeenAt))} ago`}
        </span>
      </td>
      <td className={`${TD} text-right`}>{!own && decision}</td>
    </tr>
  );
}
