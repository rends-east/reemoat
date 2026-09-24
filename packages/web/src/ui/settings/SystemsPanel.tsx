import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { errorText, meansRouteAbsent } from "../../http";
import type { MachineId } from "../../ids";
import { MACHINE_GONE } from "../../plugins";
import { store } from "../../store";
import type { AgentAuthInfo, SystemInfo } from "../../wire";
import { anyKeySet, unspokenFor } from "../../agents";
import { boundedName, harnessName, STALE_READ } from "../agentCard";
import { Badge, Button, ChoiceRow, DangerButton, Empty, FIELD, Icon, Spinner, TwoStep } from "../bits";
import { toast } from "../Toast";
import { AgentDetail } from "./AgentsPanel";

// You sign in to a system; the device-code flow stays per harness, and SystemInfo.loginVia names which CLI drives it.

function useSystems(machineId: MachineId): {
  systems: SystemInfo[] | null;
  /** Every harness this machine offers, or null; its failure never fails the provider list. */
  agents: AgentAuthInfo[] | null;
  error: string | null;
  /** False when the daemon predates the systems route: a settled answer, not an error. */
  supported: boolean;
  loading: boolean;
  refresh: () => void;
} {
  const [systems, setSystems] = useState<SystemInfo[] | null>(null);
  const [agents, setAgents] = useState<AgentAuthInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const daemon = store.daemonFor(machineId);

  useEffect(() => {
    if (daemon === undefined) {
      // undefined only when the machine left the listing (revoked or retired), never when it is unreachable.
      setError(MACHINE_GONE);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.allSettled([daemon.systems(), daemon.agentAuth()])
      .then(([listing, auth]) => {
        if (cancelled) return;
        if (listing.status === "fulfilled") {
          setSystems(listing.value.systems);
          setSupported(true);
          setError(null);
        } else {
          // An envelope-free 404 means the daemon predates the route: settled, not a failure.
          const absent = meansRouteAbsent(listing.reason);
          setSupported(!absent);
          setError(absent ? null : errorText(listing.reason));
        }
        // Never cleared on failure: STALE_READ covers a stale harness list.
        if (auth.status === "fulfilled") setAgents(auth.value.agents);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, epoch]);

  return {
    systems,
    agents,
    error,
    supported,
    loading,
    refresh: useCallback(() => setEpoch((n) => n + 1), []),
  };
}

function Recheck({ onClick, busy }: { onClick: () => void; busy: boolean }): ReactNode {
  return (
    <Button onClick={onClick} disabled={busy}>
      {busy ? "Checking…" : "Check again"}
    </Button>
  );
}

export function SystemChooser({
  machineId,
  onPick,
  onPickHarness,
}: {
  machineId: MachineId;
  onPick: (system: string) => void;
  /** Separate from onPick: harness and system ids are different spaces and may collide. */
  onPickHarness: (agent: string) => void;
}): ReactNode {
  const { systems, agents, error, supported, loading, refresh } = useSystems(machineId);

  if (loading && systems === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Asking that machine…
      </div>
    );
  }
  if (systems === null) {
    return (
      // failed only for a read that threw; a daemon without the route gets a sentence and no retry.
      <Empty failed={supported} action={supported ? <Recheck onClick={refresh} busy={loading} /> : undefined}>
        {supported
          ? (error ?? "Could not read this machine's systems.")
          : "Update this machine's daemon to sign in here."}
      </Empty>
    );
  }

  return (
    <div className="mt-4 space-y-2">
      {error !== null && <p className="text-xs text-muted">{STALE_READ}</p>}
      {systems.map((system) => (
        <ChoiceRow
          key={system.id}
          title={system.displayName}
          subline={
            system.contributedBy === undefined
              ? system.id
              :
                // Bounded: the daemon does not strip control characters from a plugin's name.
                `from ${boundedName(system.contributedBy.pluginName, "a plugin")}`
          }
          trailing={<Badge tone={system.keySet ? "plain" : "strong"}>{stateText(system)}</Badge>}
          onClick={() => onPick(system.id)}
        />
      ))}
      {unspokenFor(agents, systems).map((agent) => (
        <ChoiceRow
          key={`harness:${agent.id}`}
          title={harnessName(agent)}
          subline={
            agent.contributedBy === undefined
              ? agent.id
              : `from ${boundedName(agent.contributedBy.pluginName, "a plugin")}`
          }
          // A key, never a sign-in: these harnesses have no wizard.
          trailing={
            <Badge tone={anyKeySet(agent) ? "plain" : "strong"}>
              {anyKeySet(agent) ? "key saved" : "no key"}
            </Badge>
          }
          onClick={() => onPickHarness(agent.id)}
        />
      ))}
      <button
        type="button"
        onClick={refresh}
        disabled={loading}
        className="tap press inline-flex min-h-11 items-center gap-1.5 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
      >
        <Icon as={RefreshCw} size={13} />
        {loading ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

/** keySet only knows about a pasted key; whether a CLI is signed in is AgentDetail's probe, so never claim it here. */
function stateText(system: SystemInfo): string {
  if (system.loginVia !== null) return system.keySet ? "key saved" : "sign in";
  return system.keySet ? "key saved" : "no key";
}

export function SystemDetail({
  machineId,
  systemId,
}: {
  machineId: MachineId;
  systemId: string;
}): ReactNode {
  const { systems, error, supported, loading, refresh } = useSystems(machineId);

  if (loading && systems === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Asking that machine…
      </div>
    );
  }
  if (systems === null) {
    return (
      <Empty failed={supported} action={supported ? <Recheck onClick={refresh} busy={loading} /> : undefined}>
        {supported
          ? (error ?? "Could not read this machine's systems.")
          : "Update this machine's daemon to sign in here."}
      </Empty>
    );
  }
  const system = systems.find((candidate) => candidate.id === systemId);
  if (system === undefined) return <Empty>This machine doesn&apos;t have that system.</Empty>;

  return (
    <div>
      {error !== null && <p className="mt-4 text-xs text-muted">{STALE_READ}</p>}

      {system.loginVia !== null ? (
        <AgentDetail
          key={`${machineId}:${system.loginVia}`}
          machineId={machineId}
          agentId={system.loginVia}
          title={system.displayName}
          keyEnv={system.keyEnv ?? null}
        />
      ) : (
        <KeyOnly machineId={machineId} system={system} onChanged={refresh} />
      )}

      {/* Both when a system has a CLI and is routable: the CLI's agent credential does not sign routed requests. */}
      {system.loginVia !== null && system.routable === true && (
        <div className="mt-6 border-t border-edge pt-5">
          <KeyOnly machineId={machineId} system={system} onChanged={refresh} routing={true} />
        </div>
      )}
    </div>
  );
}

/** The system credential box; the agent builder deliberately draws no credential control (Q3.485). */
export function KeyOnly({
  machineId,
  system,
  onChanged,
  routing = false,
}: {
  machineId: MachineId;
  system: SystemInfo;
  onChanged: () => void;
  routing?: boolean;
}): ReactNode {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const daemon = store.daemonFor(machineId);

  // One name for placeholder and accessible name, distinguishing word first: a phone clips from the right.
  const keyName = routing ? `routing key for ${system.displayName}` : `${system.displayName} key`;

  const save = (): void => {
    if (daemon === undefined || value.trim().length === 0 || busy) return;
    setBusy(true);
    void daemon
      .saveSystemKey(system.id, value.trim())
      .then(() => {
        setValue("");
        toast(
          "ok",
          routing
            ? `Routing key saved for ${system.displayName}.`
            : `${system.displayName} key saved.`,
        );
        onChanged();
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  // busy is this box's one lock and is held for the removal, so Save is refused while a removal is out.
  const remove = (): Promise<void> | undefined => {
    if (daemon === undefined) return undefined;
    setBusy(true);
    return daemon
      .removeSystemKey(system.id)
      .then(() => {
        toast(
          "ok",
          routing
            ? `Routing key removed for ${system.displayName}.`
            : `${system.displayName} key removed.`,
        );
        onChanged();
      })
      .finally(() => setBusy(false));
  };

  // Borrowed: keySet with a null keyUpdatedAt means the harness's own key covers it, so no Save or Clear over it.
  const borrowed = routing && system.keySet && system.keyUpdatedAt === null;
  const [overriding, setOverriding] = useState(false);

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {routing ? "Routing key" : system.displayName}
        </span>
        <Badge tone={system.keySet ? "plain" : "strong"}>
          {system.keySet ? "key saved" : "no key"}
        </Badge>
      </div>

      <p className="text-xs text-muted">
        {routing
          ? borrowed
            ? "Covered by the key above."
            : `For agents routed to ${system.displayName}; its CLI sign-in doesn't cover this.`
          : `Key only — ${system.displayName} has no sign-in.`}
      </p>

      {borrowed && !overriding ? (
        <button
          type="button"
          onClick={() => setOverriding(true)}
          className="tap press -my-1.5 inline-flex min-h-11 items-center rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg"
        >
          Use a different key here
        </button>
      ) : (
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          // Not a password input: password managers key on the type and ignore autocomplete off; the data attributes are their opt-outs.
          type="text"
          name="reemoat-provider-key"
          data-1p-ignore=""
          data-lpignore="true"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          placeholder={system.keySet ? `paste a new ${keyName}` : `paste the ${keyName}`}
          aria-label={keyName}
          className={`${FIELD} min-w-0 flex-1 font-mono`}
        />
        <Button type="submit" disabled={busy || value.trim().length === 0}>
          {busy ? <Spinner /> : "Save"}
        </Button>
      </form>
      )}

      {system.keySet && !borrowed && (
        <div>
          {/* Centred so a second tap lands in the gap between the answers, never on Remove; Cancel is last. */}
          <TwoStep
            armed={confirmingRemove}
            onArm={setConfirmingRemove}
            align="center"
            size="md"
            className="mt-3"
            question={<>Remove the {keyName}? New sessions pointed at {system.displayName} will refuse to start.</>}
            act={{ label: "Remove", danger: true, icon: Trash2 }}
            disabled={busy || daemon === undefined}
            onAct={remove}
            rest={
              <DangerButton icon={Trash2} disabled={busy} onClick={() => setConfirmingRemove(true)}>
                Remove the {keyName}
              </DangerButton>
            }
          />
        </div>
      )}
    </div>
  );
}
