import { Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import { enrollmentExpiryText, enrollmentLines } from "../../enrollment";
import { errorText } from "../../http";
import type { MachineId } from "../../ids";
import { mayLetIn, waitingText } from "../../deviceAccess";
import { daemonRead, type MachineState } from "../../machine";
import { localAnnouncedFor, localOff, setLocalOff } from "../../localRoute";
import { inNativeShell } from "../../native";
import { MACHINE_GONE } from "../../plugins";
import { registryUnread } from "../Unreachable";
import { navigate } from "../../router";
import { agentStripPath, machineLeafPath, machineListPath, settingsPath } from "../../settings";
import { store, type AppState } from "../../store";
import { enrolledByText, type MachineSettingsView } from "../../wire";
import {
  Button,
  Dropdown,
  Empty,
  FIELD,
  NotReachable,
  Spinner,
  SwitchRow,
  TwoStep,
  type DropdownItem,
} from "../bits";
import { toast } from "../Toast";
import { Field } from "../kit/Field";
import { DangerRow, Group, LinkRow, TWO_STEP_ROW, ValueRow } from "../kit/List";
import { OneTimeSecret } from "./OneTimeSecret";

interface SetupCode {
  machineId: MachineId;
  name: string;
  url: string;
  code: string;
  expiresAt: number;
}

// The minted code, handed over in module state rather than the URL; peeked in state, cleared on mount.
let handoff: SetupCode | null = null;

function peekHandoff(): SetupCode | null {
  return handoff;
}

function clearHandoff(): void {
  handoff = null;
}

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
  const [confirming, setConfirming] = useState(false);
  /** The fingerprint on offer when the question was armed: what was compared is what is trusted, or nothing is (Q1.657). */
  const [trusting, setTrusting] = useState<string | null>(null);
  const [idleError, setIdleError] = useState<string | null>(null);

  if (machine === null) {
    return registryUnread(state) ?? <Empty>{MACHINE_GONE}</Empty>;
  }

  const owned = machine.owned === true;
  const read = daemonRead(machine.reach);
  // Enrollment is a settled fact, asked before reachability, which stays unknown until the first probe.
  const setupOffered = owned && !machine.enrolled && !machine.overLimit;
  const provenance = enrolledByText(machine.enrolledBy);
  const listable = machine.enrolled && read === "readable";
  const devicesOffered = listable && mayLetIn(machine);

  const mint = (): void => {
    setMinting(true);
    void cp
      .mintEnrollment(machine.id)
      .then((minted) => {
        handoff = {
          machineId: machine.id,
          name: machine.name,
          url: minted.controlPlaneUrl,
          code: minted.code,
          expiresAt: minted.expiresAt,
        };
        navigate(machineLeafPath(machine.id, "setup-code"));
      })
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

  const trust = (): void => {
    if (trusting !== null && store.trustMachineKey(machine.id, trusting)) return;
    toast("error", "The key on offer changed. Compare it again.");
  };

  return (
    <div>
      {/* No reachability status here: the machine list one level up carries it (Q3.433). */}
      {!owned && (
        <p className="text-xs text-muted">This machine is not yours to rename or retire.</p>
      )}

      {provenance !== null && <p className="mt-1 text-xs text-muted">{provenance}.</p>}

      {(owned || listable) && (
        <Group title="General" error={listable ? idleError : null}>
          {owned && (
            <LinkRow
              title="Name"
              value={machine.name}
              onClick={() => navigate(machineLeafPath(machine.id, "machine-name"))}
            />
          )}
          {/* Offered only before enrollment, and minted on the tap, never on mount: minting burns the previous code (Q3.428). */}
          {setupOffered && (
            <LinkRow
              title="New setup code"
              value={minting ? <Spinner /> : undefined}
              disabled={minting}
              onClick={mint}
            />
          )}
          {listable && <IdleRelease machineId={machineId} onError={setIdleError} />}
        </Group>
      )}

      {listable ? (
        // Outside the ownership gate: configuring an agent acts on the daemon, reached with a grant (Q3.415).
        <Group title="Agents">
          <LinkRow title="Agents" onClick={() => navigate(agentStripPath(machineId))} />
          <LinkRow title="Sign-ins" onClick={() => navigate(machineListPath(machineId, "systems"))} />
          <LinkRow title="Plugins" onClick={() => navigate(machineListPath(machineId, "plugins"))} />
        </Group>
      ) : (
        <Group still>
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
        </Group>
      )}

      {/* Outside the listable gate: a device waiting to be let in, or holding a key the server no longer names, cannot reach the machine at all. */}
      {(machine.keyFingerprint !== null || devicesOffered) && (
        <Group title="Security">
          {machine.keyFingerprint !== null && <ValueRow title="Key fingerprint" value={machine.keyFingerprint} mono />}
          {machine.approvalCode !== null && <ValueRow title="Approval code" value={machine.approvalCode} mono />}
          {machine.offlineReason === "machine_key_changed" && machine.offeredKeyFingerprint !== null && (
            <>
              <ValueRow title="New key fingerprint" value={machine.offeredKeyFingerprint} mono />
              <TwoStep
                armed={trusting !== null}
                onArm={(next) => {
                  if (!next) setTrusting(null);
                }}
                align="end"
                className={TWO_STEP_ROW}
                question={<>Trust {machine.name}'s new key?</>}
                consequence={
                  <>
                    Only if its daemon prints this fingerprint at start, or{" "}
                    <span className="font-mono text-2xs">pnpm client devices</span> does.
                  </>
                }
                act={{ label: "Trust" }}
                onAct={trust}
                rest={
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm">New key</span>
                    <Button size="sm" onClick={() => setTrusting(machine.offeredKeyFingerprint)}>
                      Trust
                    </Button>
                  </>
                }
              />
            </>
          )}
          {devicesOffered && (
            <LinkRow
              title="Device access"
              value={waitingText(state.devicesWaiting.get(machineId) ?? 0) ?? undefined}
              onClick={() => navigate(machineListPath(machine.id, "devices"))}
            />
          )}
        </Group>
      )}

      {/* Outside the listable gate: the switch is the control plane's, and turning it off reaches the relay at once (Q1.654). */}
      {owned && machine.enrolled && machine.agentMessagingMachine !== undefined && (
        <MachineMessaging machine={machine} accountOn={state.me?.permissions?.agentMessaging} />
      )}

      {/* Outside the listable and owner gates: loopback can reach a machine the relay reports offline. */}
      <LocalPath machineId={machineId} />

      {owned && (
        <Group>
          <TwoStep
            armed={confirming}
            onArm={setConfirming}
            align="end"
            className={TWO_STEP_ROW}
            question={<>Retire {machine.name}?</>}
            consequence="Frees the name and a slot."
            act={{ label: "Retire", danger: true, icon: Trash2 }}
            onAct={revoke}
            rest={<DangerRow label={`Retire ${machine.name}`} icon={Trash2} onClick={() => setConfirming(true)} />}
          />
        </Group>
      )}
    </div>
  );
}

/** The machine's own switch; while the account's is off it is drawn off and cannot be pressed, and keeps its own answer. */
function MachineMessaging({
  machine,
  accountOn,
}: {
  machine: MachineState;
  accountOn: boolean | undefined;
}): ReactNode {
  const [busy, setBusy] = useState<"messaging" | "isolated" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const own = machine.agentMessagingMachine === true;
  const effective = machine.agentMessaging === true;
  const isolated = machine.agentMessagingIsolated === true;
  // The account's switch outranks this one, and so does the machine's own configuration: either draws it off and locked.
  const locked = accountOn === false || (own && !effective) || store.linkStatus(machine.id)?.env === false;
  const messagingOn = own && !locked;

  const save = (which: "messaging" | "isolated", patch: { agentMessaging?: boolean; isolated?: boolean }): void => {
    setBusy(which);
    setError(null);
    void store
      .saveMachinePermissions(machine.id, patch)
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(null));
  };

  return (
    <Group title="Messaging" error={error}>
      <SwitchRow
        title="Agent messaging"
        subline="Its agents can message your other sessions."
        on={messagingOn}
        busy={busy === "messaging"}
        disabled={locked || busy === "isolated"}
        onToggle={() => save("messaging", { agentMessaging: !own })}
      />
      {/* Drawn locked rather than absent: the owner asked for it to unlock under the switch above (Q3.675). */}
      {machine.agentMessagingIsolated !== undefined && (
        <SwitchRow
          title="Isolate sessions on this machine"
          subline="Its sessions message only each other."
          on={messagingOn && isolated}
          busy={busy === "isolated"}
          disabled={!messagingOn || busy === "messaging"}
          onToggle={() => save("isolated", { isolated: !isolated })}
        />
      )}
    </Group>
  );
}

function RenameMachine({ machine, onDone }: { machine: AppState["machines"][number]; onDone: () => void }): ReactNode {
  const [value, setValue] = useState(machine.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = value.trim();
  const unchanged = next.length === 0 || next === machine.name;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || unchanged) return;
    setBusy(true);
    setError(null);
    void cp
      .renameMachine(machine.id, next)
      // Awaited so busy holds until the registry answers; resume rather than machinesChanged, since a rename moves no count.
      .then(() => store.resume("machine-renamed"))
      .then(() => {
        toast("ok", `${machine.name} is now ${next}.`);
        onDone();
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
      <Field label="Machine name" error={error}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            value={value}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setValue(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className={FIELD}
          />
        )}
      </Field>
      <div className="flex items-center gap-2">
        <Button
          tone="primary"
          type="submit"
          disabled={busy || unchanged}
        >
          {busy ? <Spinner /> : "Save"}
        </Button>
        <Button disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A routing preference held in this client: drawn in a browser too, where it only refuses, and never gated on reachability. */
function LocalPath({ machineId }: { machineId: MachineId }): ReactNode {
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

  const here = native && !reading && announced !== null;
  const subline = !native
    ? "Needs the Reemoat app on this computer."
    : reading
      ? null
      : announced === null
        ? "Not found on this computer."
        : "Reaches it on this computer, skipping the relay.";

  return (
    // The footer is the cost this switch exists to disclose (Q7.137).
    <Group title="Connection" footer={here ? "Revocation lags up to six minutes." : undefined}>
      <SwitchRow
        title="Direct connection"
        subline={subline}
        on={here && !off}
        busy={reading}
        disabled={!here}
        onToggle={() => {
          const next = !off;
          setLocalOff(machineId, next);
          setOff(next);
          // Dropping the route memo applies the switch on the next request; an open socket runs until it rotates.
          store.forgetMachineRoute(machineId);
        }}
      />
    </Group>
  );
}

/** Whole minutes, as the daemon takes them: 0 to a week, 0 meaning never (Q2.225). */
const IDLE_CHOICES: readonly DropdownItem<string>[] = [
  { value: "0", label: "Never", description: "At 64 agents, new sessions are refused." },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "240", label: "4 hours" },
  { value: "480", label: "8 hours" },
  { value: "1440", label: "1 day" },
  { value: "10080", label: "1 week" },
];

/** A value set elsewhere, in the environment or by an older client, is drawn as itself rather than as the nearest choice. */
function idleText(minutes: number): string {
  const choice = IDLE_CHOICES.find((one) => one.value === String(minutes));
  if (choice !== undefined) return choice.label;
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Draws the daemon's answer and never the pick: a choice holds the row until the write comes back. */
function IdleRelease({ machineId, onError }: { machineId: MachineId; onError: (error: string | null) => void }): ReactNode {
  const [settings, setSettings] = useState<MachineSettingsView | null>(null);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    onError(null);
    setReading(true);
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setReading(false);
      return;
    }
    let cancelled = false;
    void daemon
      .machineSettings()
      .then((answer) => {
        if (!cancelled) setSettings(answer.settings);
      })
      .catch((cause: unknown) => {
        if (!cancelled) onError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setReading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [machineId]);

  const save = (next: string): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return;
    setBusy(true);
    onError(null);
    void daemon
      .saveMachineSettings({ idleReleaseMinutes: Number(next) })
      .then((answer) => setSettings(answer.settings))
      .catch((cause: unknown) => onError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <Dropdown
      variant="row"
      title="Idle agents released"
      subline="Shut down, then resumed where you left off."
      trigger={settings === null ? null : idleText(settings.idleReleaseMinutes)}
      items={IDLE_CHOICES}
      value={settings === null ? null : String(settings.idleReleaseMinutes)}
      onChange={save}
      busy={busy || reading}
      disabled={settings === null || busy}
    />
  );
}

/** The rename form, a screen of its own (Q3.549): done or cancelled, it walks back to the machine by replace. */
export function MachineNameScreen({ state, machineId }: { state: AppState; machineId: MachineId }): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;
  const gone = machine === null;
  const mine = machine?.owned === true;
  const back = (): void => navigate(settingsPath("machines", machineId), true);

  // The machine's own screen already says it is not yours, so a typed address walks back there rather than saying it twice.
  useEffect(() => {
    if (!gone && !mine) back();
  }, [gone, mine]);

  if (machine === null) return registryUnread(state) ?? <Empty>{MACHINE_GONE}</Empty>;
  if (!mine) return null;
  return <RenameMachine key={machine.id} machine={machine} onDone={back} />;
}

/** Shows the handed-off code once and never mints; with nothing in hand for this machine it walks back. */
export function SetupCodeScreen({ machineId }: { machineId: MachineId }): ReactNode {
  const [minted] = useState<SetupCode | null>(() => {
    const held = peekHandoff();
    return held !== null && held.machineId === machineId ? held : null;
  });
  const back = (): void => navigate(settingsPath("machines", machineId), true);

  useEffect(() => {
    clearHandoff();
    if (minted === null) back();
  }, [minted]);

  if (minted === null) return null;
  return (
    <OneTimeSecret
      label={`Start the daemon on ${minted.name} with`}
      value={enrollmentLines(minted.url, minted.code)}
      note={`Single-use, ${enrollmentExpiryText(minted.expiresAt, Date.now())}. Shown once. Replaces any earlier code.`}
      onDone={back}
    />
  );
}
