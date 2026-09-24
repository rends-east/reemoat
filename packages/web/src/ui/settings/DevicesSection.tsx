import { useEffect, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { CONTROL_PLANE_UNREACHABLE } from "../../account";
import * as cp from "../../cp";
import { errorText } from "../../http";
import { hostDeviceKeyReset, inNativeShell } from "../../native";
import { platformName } from "../../platform";
import type { DeviceRecord } from "../../wire";
import { Badge, Button, Empty, SETTINGS_HEADING, SETTINGS_SECTION, SkeletonRow, TwoStep, shortDuration } from "../bits";
import { toast } from "../Toast";

/** Retires computers rather than sign-ins; a device with hasKey false cannot reach any machine and offers a re-key. */
export function DevicesSection(): ReactNode {
  const [rows, setRows] = useState<DeviceRecord[] | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  /** Re-reads the list and returns the rows, or null when the read failed. */
  const refresh = (): Promise<DeviceRecord[] | null> =>
    cp
      .devices()
      .then((next) => {
        setRows(next.devices);
        setLimit(next.limit);
        setFailed(false);
        return next.devices;
      })
      .catch(() => {
        setFailed(true);
        return null;
      });

  useEffect(() => {
    void refresh();
  }, []);

  const live = rows === null ? [] : rows.filter((row) => row.revokedAt === null);
  const retired = rows === null ? [] : rows.filter((row) => row.revokedAt !== null);

  return (
    <>
      <section>
        <h2 className={SETTINGS_HEADING}>Devices</h2>
        {rows === null && !failed && <SkeletonRow />}
        {failed && (
          <Empty
            failed
            action={
              <Button size="sm" onClick={() => void refresh()}>
                Try again
              </Button>
            }
          >
            {CONTROL_PLANE_UNREACHABLE}
          </Empty>
        )}
        {!failed && rows !== null && live.length === 0 && (
          <p className="mt-1.5 text-xs text-muted">
            No devices registered. The Reemoat app registers one when you sign in; a browser and an API key do not.
          </p>
        )}
        {!failed && live.length > 0 && (
          <div className="mt-2">
            {live.map((row) => (
              <DeviceRow key={row.id} row={row} onChanged={refresh} />
            ))}
          </div>
        )}
        {!failed && rows !== null && limit !== null && live.length > 0 && (
          <p className="mt-2 text-2xs text-muted">
            {`${String(live.length)} of ${String(limit)} allowed. Retiring one makes room straight away.`}
          </p>
        )}
        {/* Keyed on === false: an older control plane omits hasKey, and absent is not refused. */}
        {!failed && live.some((row) => row.hasKey === false) && (
          <p className="mt-1.5 text-2xs text-muted">
            A device with no key cannot reach your machines, and signing in again on it does not register one. Re-key it
            from its own row, on that computer.
          </p>
        )}
      </section>

      {!failed && retired.length > 0 && (
        <section className={SETTINGS_SECTION}>
          <h2 className={SETTINGS_HEADING}>Recently retired</h2>
          <div className="mt-2">
            {retired.map((row) => (
              <DeviceRow key={row.id} row={row} onChanged={refresh} />
            ))}
          </div>
        </section>
      )}

      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>What this covers</h2>
        <p className="mt-1.5 text-xs text-muted">
          An API key is not a sign-in, so nothing holding one appears here. Retire a key under API keys.
        </p>
        <p className="mt-1.5 text-xs text-muted">
          Retiring a device ends its sign-ins at once. Work already open on one of your machines can carry on for a few
          minutes before it stops.
        </p>
      </section>
    </>
  );
}

function DeviceRow({
  row,
  onChanged,
}: {
  row: DeviceRecord;
  onChanged: () => Promise<DeviceRecord[] | null>;
}): ReactNode {
  const [confirming, setConfirming] = useState<"retire" | "rekey" | null>(null);
  const now = Date.now();
  const retired = row.revokedAt !== null;
  // Own row in the shell only: both re-key calls act on this installation, never on the pressed row.
  const rekeyable = !retired && row.current && row.hasKey === false && inNativeShell();

  const retire = (): Promise<void> =>
    cp.revokeDevice(row.id).then((answer) => {
      // No toast on your own row: the app is about to sign out.
      if (row.current) return;
      toast(
        "ok",
        answer.sessionsRevoked === 1
          ? `${row.name} retired. 1 sign-in ended.`
          : `${row.name} retired. ${String(answer.sessionsRevoked)} sign-ins ended.`,
      );
      void onChanged();
    });

  /** Resets the key in the shell, then registers it; the reset erases the old key, so later failures report themselves. */
  const rekey = async (): Promise<void> => {
    await hostDeviceKeyReset();
    let id: string | null;
    try {
      id = await cp.registerDevice();
    } catch (cause) {
      toast("error", `${rekeyToast(row.name, "unsent")} (${errorText(cause)})`);
      return;
    }
    // Unreachable under rekeyable, and reported as unsent rather than refused.
    if (id === null) {
      toast("error", rekeyToast(row.name, "unsent"));
      return;
    }
    const listed = (await onChanged())?.find((one) => one.id === id) ?? null;
    if (listed === null) return;
    const refused = listed.hasKey === false;
    toast(refused ? "error" : "ok", rekeyToast(row.name, refused ? "refused" : "registered"));
  };

  return (
    <div className="flex min-h-11 items-center gap-3 border-b border-edge/60 py-2 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={`min-w-0 truncate text-sm font-medium ${retired ? "text-muted" : ""}`}>{row.name}</span>
          {/* One badge per row: retired, then no key, then this device. */}
          {retired ? (
            <span className="shrink-0">
              <Badge>retired</Badge>
            </span>
          ) : row.hasKey === false ? (
            <span className="shrink-0">
              <Badge tone="strong">no key</Badge>
            </span>
          ) : (
            row.current && (
              <span className="shrink-0">
                <Badge tone="strong">this device</Badge>
              </span>
            )
          )}
        </span>
        <span className="mt-0.5 block text-2xs text-muted">
          {platformName(row.platform)}
          {" · "}
          {retired
            ? `retired ${shortDuration(Math.max(0, now - (row.revokedAt ?? now)))} ago`
            : row.current
              ? "in use"
              : row.lastSeenAt === null
                ? "never signed in"
                : `last used ${shortDuration(Math.max(0, now - row.lastSeenAt))} ago`}
        </span>
      </span>

      {/* Both acts share one TwoStep so arming one hides the other's button. */}
      {!retired && (
        <span className="shrink-0">
          <TwoStep
            armed={confirming !== null}
            onArm={(next) => {
              if (!next) setConfirming(null);
            }}
            align="end"
            question={confirming === "rekey" ? `Give ${row.name} a new key?` : `Retire ${row.name}?`}
            consequence={
              confirming === "rekey"
                ? "The old key is given up first. This device keeps its place in the list."
                : row.current
                  ? "This signs you out here. Sign in again to use this device."
                  : "Its sign-ins end. No other device is affected."
            }
            act={
              confirming === "rekey"
                ? { label: "Re-key", ariaLabel: `Re-key ${row.name}` }
                : { label: "Retire", danger: true, icon: Trash2, ariaLabel: `Retire ${row.name}` }
            }
            onAct={confirming === "rekey" ? rekey : retire}
            onFailure={(cause) => toast("error", errorText(cause))}
            // Retire stays last so a double tap lands on Cancel rather than the act.
            rest={
              <>
                {rekeyable && (
                  <Button size="sm" onClick={() => setConfirming("rekey")}>
                    Re-key
                  </Button>
                )}
                <Button size="sm" onClick={() => setConfirming("retire")}>
                  Retire
                </Button>
              </>
            }
          />
        </span>
      )}
    </div>
  );
}

/** Toast text per re-key outcome; unsent is neither done nor undone, so it asks for another press. */
export function rekeyToast(name: string, outcome: "registered" | "unsent" | "refused"): string {
  switch (outcome) {
    case "registered":
      return `${name} has a new key.`;
    case "unsent":
      return `${name} has a new key, but the server was not told. Press Re-key again.`;
    case "refused":
      return `${name} still has no key: the server would not take the one this computer made.`;
    default: {
      const unreached: never = outcome;
      return unreached;
    }
  }
}
