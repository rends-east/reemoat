import { ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import { enrollmentExpiryText, enrollmentLines } from "../../enrollment";
import { errorText } from "../../http";
import type { MachineId } from "../../ids";
import { daemonRead } from "../../machine";
import { localAnnouncedFor, localOff, setLocalOff } from "../../localRoute";
import { inNativeShell } from "../../native";
import { MACHINE_GONE } from "../../plugins";
import { navigate } from "../../router";
import { agentStripPath, settingsPath } from "../../settings";
import { store, type AppState } from "../../store";
import { enrolledByText, type MachineSettingsView } from "../../wire";
import {
  Badge,
  Button,
  ChoiceRow,
  DangerButton,
  Empty,
  FIELD,
  Icon,
  NotReachable,
  SETTINGS_HEADING,
  SETTINGS_SECTION,
  Spinner,
  TwoStep,
} from "../bits";
import { toast } from "../Toast";
import { MachineSystemsSection } from "./MachineSystemsSection";
import { MachinePluginsSection } from "./MachinePluginsSection";
import { OneTimeSecret } from "./OneTimeSecret";

/** Written out, not appended to SETTINGS_HEADING: Tailwind emits text-danger before text-muted, so appending loses. */
const RETIRE_HEADING = "text-2xs font-semibold tracking-wider text-danger uppercase";

/** Owner-only blocks are absent, never disabled: the control plane answers 404 rather than 403 for a machine not yours. */
export function MachineSection({
  state,
  machineId,
}: {
  state: AppState;
  machineId: MachineId;
}): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;
  // Minting holds its own flag and the retire's wait is TwoStep's, so the two never share a lock.
  const [minting, setMinting] = useState(false);
  const [code, setCode] = useState<{ url: string; code: string; expiresAt: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (machine === null) {
    return <Empty>{MACHINE_GONE}</Empty>;
  }

  const owned = machine.owned === true;
  const read = daemonRead(machine.reach);
  // Enrollment is a settled fact, asked before reachability, which stays unknown until the first probe.
  const setupOffered = owned && !machine.enrolled && !machine.overLimit;
  const provenance = enrolledByText(machine.enrolledBy);
  const listable = machine.enrolled && read === "readable";

  const mint = (): void => {
    setMinting(true);
    void cp
      .mintEnrollment(machine.id)
      .then((minted) =>
        setCode({ url: minted.controlPlaneUrl, code: minted.code, expiresAt: minted.expiresAt }),
      )
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setMinting(false));
  };

  // Handed to `TwoStep`: it owns the wait, and a failure leaves the question
  // standing beside the toast.
  const revoke = (): Promise<void> =>
    cp
      .revokeMachine(machine.id)
      .then(() => {
        // Navigate away before the machine leaves the list, or this screen would call the machine gone.
        navigate(settingsPath("machines"), true, () => store.forgetMachine(machine.id));
        toast("ok", `${machine.name} is retired.`);
        void store.machinesChanged("machine-revoked");
      });

  return (
    <div>
      {/* No reachability status here: the machine list one level up carries it (Q3.433). */}
      {!owned && (
        <p className="text-xs text-muted">This machine is not yours to rename or retire.</p>
      )}

      <p className="text-xs text-muted">
        Belongs to <code className="text-muted/80">{machine.id}</code> only. Plugins run there as you.
      </p>

      {provenance !== null && <p className="mt-1 text-xs text-muted">{provenance}.</p>}

      {owned && (
        <section className={SETTINGS_SECTION}>
          <h2 className={SETTINGS_HEADING}>Name</h2>
          <RenameMachine machine={machine} />
        </section>
      )}

      {/* Offered only before enrollment, and never minted on mount: minting burns the previous code (Q3.428). */}
      {setupOffered && (
        <section className={SETTINGS_SECTION}>
          <h2 className={SETTINGS_HEADING}>Setup code</h2>
          <Button className="mt-3" disabled={minting} onClick={mint}>
            {minting ? <Spinner /> : "Generate"}
          </Button>
          {code !== null && (
            <div className="mt-2">
              <OneTimeSecret
                label={`Start the daemon on ${machine.name} with`}
                value={enrollmentLines(code.url, code.code)}
                note={`Single-use, ${enrollmentExpiryText(code.expiresAt, Date.now())}. Shown once. Replaces any earlier code.`}
                onDone={() => setCode(null)}
              />
            </div>
          )}
        </section>
      )}

      {listable ? (
        <>
          {/* Outside the ownership gate: configuring an agent acts on the daemon, reached with a grant (Q3.415). */}
          <section className={SETTINGS_SECTION}>
            <h2 className={SETTINGS_HEADING}>Sign-ins</h2>
            <MachineSystemsSection
              state={state}
              machineId={machineId}
              system={null}
              signin={null}
            />
          </section>

          <section className={SETTINGS_SECTION}>
            <ChoiceRow
              title="Agents"
              subline="Reorder, hide, add."
              trailing={<Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />}
              onClick={() => navigate(agentStripPath(machineId))}
            />
          </section>

          <section className={SETTINGS_SECTION}>
            <h2 className={SETTINGS_HEADING}>Plugins</h2>
            <MachinePluginsSection state={state} machineId={machineId} />
          </section>

          <section className={SETTINGS_SECTION}>
            <h2 className={SETTINGS_HEADING}>Idle sessions</h2>
            <IdleRelease machineId={machineId} />
          </section>
        </>
      ) : (
        <section className={SETTINGS_SECTION}>
          {!machine.enrolled ? (
            <Empty>
              Not enrolled yet.
              {setupOffered ? " Use the setup code above." : ""}
            </Empty>
          ) : read === "asking" ? (
            <Empty>
              <span className="inline-flex items-center gap-2">
                <Spinner /> Checking whether {machine.name} is reachable…
              </span>
            </Empty>
          ) : (
            <Empty failed>
              <NotReachable machine={machine} />
            </Empty>
          )}
        </section>
      )}

      {/* Outside the listable and owner gates: loopback can reach a machine the relay reports offline. */}
      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>This device</h2>
        <LocalPath machineId={machineId} name={machine.name} />
      </section>

      {owned && (
        <section className="mt-12 border-t border-edge pt-5">
          <h2 className={RETIRE_HEADING}>Retire this machine</h2>
          <TwoStep
            armed={confirming}
            onArm={setConfirming}
            className="mt-3"
            size="md"
            question={<>Retire {machine.name}?</>}
            consequence="Frees the name and a slot. Re-adding gives a new id; shares are lost."
            act={{ label: "Retire", danger: true, icon: Trash2 }}
            onAct={revoke}
            rest={
              <DangerButton icon={Trash2} onClick={() => setConfirming(true)}>
                Retire {machine.name}
              </DangerButton>
            }
          />
        </section>
      )}
    </div>
  );
}

function RenameMachine({ machine }: { machine: AppState["machines"][number] }): ReactNode {
  const [value, setValue] = useState(machine.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = value.trim();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || next.length === 0 || next === machine.name) return;
    setBusy(true);
    setError(null);
    void cp
      .renameMachine(machine.id, next)
      // Awaited so busy holds until the registry answers; resume rather than machinesChanged, since a rename moves no count.
      .then(() => store.resume("machine-renamed"))
      .then(() => toast("ok", `${machine.name} is now ${next}.`))
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit} className="mt-3">
      <div className="flex max-w-sm gap-2">
        <input
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={`Rename ${machine.name}`}
          className={`min-w-0 flex-1 ${FIELD}`}
        />
        <Button type="submit" tone="primary" disabled={busy || next.length === 0 || next === machine.name}>
          {busy ? <Spinner /> : "Save"}
        </Button>
      </div>
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
    </form>
  );
}

/** A routing preference held in this client: drawn in a browser too, where it only refuses, and never gated on reachability. */
function LocalPath({ machineId, name }: { machineId: MachineId; name: string }): ReactNode {
  const native = inNativeShell();
  const [announced, setAnnounced] = useState<string | null>(null);
  const [reading, setReading] = useState(native);
  const [off, setOff] = useState(() => localOff(machineId));

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    setReading(true);
    void localAnnouncedFor(machineId)
      .then((base) => {
        if (!cancelled) setAnnounced(base);
      })
      .finally(() => {
        if (!cancelled) setReading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, native]);

  if (!native) {
    return (
      <p className="mt-3 text-sm text-muted">
        The Reemoat app can reach a daemon running on the same computer without going out to the
        relay and back. A browser cannot, so there is nothing to set here.
      </p>
    );
  }

  if (reading) return <Empty>Looking for a daemon on this computer…</Empty>;

  if (announced === null) {
    return (
      <p className="mt-3 text-sm text-muted">
        No daemon on this computer has announced itself as {name}, so this app reaches it through
        the relay. A daemon announces itself when it starts, and only once it has been enrolled.
      </p>
    );
  }

  const on = !off;
  return (
    <>
      <div className="mt-2 flex min-h-11 flex-wrap items-center gap-2">
        <Badge tone="strong">{on ? "Direct" : "Through the relay"}</Badge>
        <Button
          size="sm"
          onClick={() => {
            const next = on;
            setLocalOff(machineId, next);
            setOff(next);
            // Dropping the route memo applies the switch on the next request; an open socket runs until it rotates.
            store.forgetMachineRoute(machineId);
          }}
        >
          {on ? "Use the relay" : "Connect directly"}
        </Button>
      </div>
      {/* The second sentence is the cost this switch exists to disclose (Q7.137). */}
      <p className="mt-2 text-sm text-muted">
        {name} is running on this computer, so this app can reach it over a loopback connection
        instead of out to the relay and back.
      </p>
      <p className="mt-2 text-sm text-muted">
        While it does, the relay is not checking each request — so if the owner takes your access
        away, or switches the machine off, this app can keep reaching it from here for up to about
        six minutes. Retiring this device has the same delay, here and everywhere else.
      </p>
    </>
  );
}

function IdleRelease({ machineId }: { machineId: MachineId }): ReactNode {
  const [settings, setSettings] = useState<MachineSettingsView | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setUnreachable(true);
      return;
    }
    let cancelled = false;
    void daemon
      .machineSettings()
      .then((answer) => {
        if (cancelled) return;
        setSettings(answer.settings);
        setValue(String(answer.settings.idleReleaseMinutes));
      })
      .catch(() => {
        if (!cancelled) setUnreachable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [machineId]);

  const save = (next: number): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return;
    setBusy(true);
    setError(null);
    void daemon
      .saveMachineSettings({ idleReleaseMinutes: next })
      .then((answer) => {
        setSettings(answer.settings);
        setValue(String(answer.settings.idleReleaseMinutes));
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  if (unreachable) return <Empty>That machine is not reachable right now.</Empty>;
  if (settings === null) return <Empty>Reading this machine’s settings…</Empty>;

  const typed = Number.parseInt(value, 10);
  const valid = Number.isInteger(typed) && typed >= 0;
  const changed = valid && typed !== settings.idleReleaseMinutes;

  return (
    <>
      <form
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) save(typed);
        }}
      >
        <div className="flex max-w-sm items-center gap-2">
          <input
            value={value}
            inputMode="numeric"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Minutes of quiet before an agent is shut down"
            className={`w-24 shrink-0 ${FIELD}`}
          />
          <span className="shrink-0 text-sm text-muted">minutes</span>
          <Button type="submit" tone="primary" disabled={busy || !changed}>
            {busy ? <Spinner /> : "Save"}
          </Button>
        </div>
      </form>
      <p className="mt-2 text-sm text-muted">
        A conversation left untouched this long has its agent shut down to free memory, and your next
        message starts it again exactly where you left off.
      </p>
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
    </>
  );
}
