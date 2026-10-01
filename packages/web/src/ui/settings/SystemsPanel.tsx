import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { errorText, meansRouteAbsent } from "../../http";
import type { MachineId } from "../../ids";
import { MACHINE_GONE } from "../../plugins";
import { navigate } from "../../router";
import { routingKeyPath, settingsPath } from "../../settings";
import { store } from "../../store";
import type { AgentAuthInfo, SystemInfo } from "../../wire";
import { anyKeySet, unspokenFor } from "../../agents";
import { boundedName, harnessName, STALE_READ, systemBadge } from "../agentCard";
import { Badge, Button, Empty, FIELD, SkeletonRow, Spinner, TwoStep } from "../bits";
import { toast } from "../Toast";
import { Field } from "../kit/Field";
import { DangerRow, Group, LinkRow, TWO_STEP_ROW } from "../kit/List";
import { Pending, RecheckButton } from "../kit/Status";
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
      <Group>
        <SkeletonRow />
      </Group>
    );
  }
  if (systems === null) {
    return (
      <Group>
        {/* failed only for a read that threw; a daemon without the route gets a sentence and no retry. */}
        <Empty failed={supported} action={supported ? <RecheckButton onClick={refresh} busy={loading} /> : undefined}>
          {supported
            ? (error ?? "Could not read this machine's systems.")
            : "Update this machine's daemon to sign in here."}
        </Empty>
      </Group>
    );
  }

  return (
    // A failed re-read keeps the last list and says so under it.
    <Group action={<RecheckButton onClick={refresh} busy={loading} />} error={error === null ? null : STALE_READ}>
      {systems.map((system) => (
        <LinkRow
          key={system.id}
          title={system.displayName}
          subline={
            system.contributedBy === undefined
              ? undefined
              : // Bounded: the daemon does not strip control characters from a plugin's name.
                `from ${boundedName(system.contributedBy.pluginName, "a plugin")}`
          }
          badge={rowBadge(system, agents)}
          onClick={() => onPick(system.id)}
        />
      ))}
      {unspokenFor(agents, systems).map((agent) => (
        <LinkRow
          key={`harness:${agent.id}`}
          title={harnessName(agent)}
          subline={
            agent.contributedBy === undefined ? undefined : `from ${boundedName(agent.contributedBy.pluginName, "a plugin")}`
          }
          // A key, never a sign-in: these harnesses have no wizard.
          badge={
            <Badge tone={anyKeySet(agent) ? "plain" : "strong"}>
              {anyKeySet(agent) ? "key saved" : "no key"}
            </Badge>
          }
          onClick={() => onPickHarness(agent.id)}
        />
      ))}
    </Group>
  );
}

function rowBadge(system: SystemInfo, agents: AgentAuthInfo[] | null): ReactNode {
  const badge = systemBadge(system, agents?.find((one) => one.id === system.loginVia));
  return badge === null ? undefined : <Badge tone={badge.tone}>{badge.text}</Badge>;
}

export function SystemDetail({
  machineId,
  systemId,
}: {
  machineId: MachineId;
  systemId: string;
}): ReactNode {
  const { systems, error, supported, loading, refresh } = useSystems(machineId);

  if (loading && systems === null) return <Pending>Asking that machine…</Pending>;
  if (systems === null) {
    return (
      <Empty failed={supported} action={supported ? <RecheckButton onClick={refresh} busy={loading} /> : undefined}>
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
        <KeyOnly machineId={machineId} system={system} onChanged={refresh} routing={true} />
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

  const keyName = keyNameOf(system, routing);

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

  return (
    <>
      {/* The card's head where this box is the whole card; under a harness's card it is a group of its own. */}
      {!routing && (
        <div className="flex items-center gap-2 px-4">
          <span className="min-w-0 flex-1 truncate text-base font-semibold">{system.displayName}</span>
          <Badge tone={system.keySet ? "plain" : "strong"}>{system.keySet ? "key saved" : "no key"}</Badge>
        </div>
      )}

      {borrowed ? (
        <Group title="Routing key" footer="Covered by the key above.">
          <LinkRow title="Use a different key here" onClick={() => navigate(routingKeyPath(machineId, system.id))} />
        </Group>
      ) : (
        <Group title={routing ? "Routing key" : undefined} unboxed>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <Field
              label={routing ? routingLabel(system) : keyName}
              hint={routing ? routingHint(system) : undefined}
            >
              {({ id, describedBy }) => (
                <div className="flex gap-2">
                  <KeyInput
                    id={id}
                    describedBy={describedBy}
                    value={value}
                    onChange={setValue}
                    placeholder={system.keySet ? `paste a new ${keyName}` : `paste the ${keyName}`}
                    className="min-w-0 flex-1"
                  />
                  <Button type="submit" size="sm" disabled={busy || value.trim().length === 0}>
                    {busy ? <Spinner /> : "Save"}
                  </Button>
                </div>
              )}
            </Field>
          </form>
        </Group>
      )}

      {system.keySet && !borrowed && (
        <Group>
          <TwoStep
            armed={confirmingRemove}
            onArm={setConfirmingRemove}
            align="end"
            className={TWO_STEP_ROW}
            question={<>Remove the {keyName}? New sessions pointed at {system.displayName} will refuse to start.</>}
            act={{ label: "Remove", danger: true, icon: Trash2 }}
            disabled={busy || daemon === undefined}
            onAct={remove}
            rest={
              <DangerRow label={`Remove the ${keyName}`} icon={Trash2} disabled={busy} onClick={() => setConfirmingRemove(true)} />
            }
          />
        </Group>
      )}
    </>
  );
}

/** One name for the placeholder, the question and the Remove, distinguishing word first: a phone clips from the right. */
function keyNameOf(system: SystemInfo, routing: boolean): string {
  return routing ? `routing key for ${system.displayName}` : `${system.displayName} key`;
}

function routingLabel(system: SystemInfo): string {
  return `Key for ${system.displayName}`;
}

function routingHint(system: SystemInfo): string {
  return `For agents routed to ${system.displayName}; its CLI sign-in doesn't cover this.`;
}

/** Not a password input: password managers key on the type and ignore autocomplete off; the data attributes are their opt-outs. */
function KeyInput({
  id,
  describedBy,
  value,
  onChange,
  placeholder,
  autoFocus = false,
  className = "",
}: {
  id: string;
  describedBy: string | undefined;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  className?: string;
}): ReactNode {
  return (
    <input
      id={id}
      aria-describedby={describedBy}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      type="text"
      name="reemoat-provider-key"
      data-1p-ignore=""
      data-lpignore="true"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      autoComplete="off"
      autoFocus={autoFocus}
      placeholder={placeholder}
      className={`${FIELD} font-mono ${className}`}
    />
  );
}

/** A borrowed routing key's override, a leaf under the system's card that walks back to it by replace (Q3.549). */
export function RoutingKeyScreen({ machineId, systemId }: { machineId: MachineId; systemId: string }): ReactNode {
  const { systems, error, supported, loading, refresh } = useSystems(machineId);
  const back = (): void => navigate(settingsPath("machines", machineId, systemId), true);
  const system = systems?.find((candidate) => candidate.id === systemId);
  // Only a system with a CLI and a route has a routing key; the card says what any other one has.
  const routes = system !== undefined && system.loginVia !== null && system.routable === true;

  useEffect(() => {
    if (systems !== null && !routes) back();
  }, [systems, routes]);

  if (loading && systems === null) return <Pending>Asking that machine…</Pending>;
  if (systems === null) {
    return (
      <Empty failed={supported} action={supported ? <RecheckButton onClick={refresh} busy={loading} /> : undefined}>
        {supported
          ? (error ?? "Could not read this machine's systems.")
          : "Update this machine's daemon to sign in here."}
      </Empty>
    );
  }
  if (system === undefined || !routes) return null;
  return <RoutingKeyForm machineId={machineId} system={system} onDone={back} />;
}

function RoutingKeyForm({
  machineId,
  system,
  onDone,
}: {
  machineId: MachineId;
  system: SystemInfo;
  onDone: () => void;
}): ReactNode {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const daemon = store.daemonFor(machineId);
  const keyName = keyNameOf(system, true);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (daemon === undefined || value.trim().length === 0 || busy) return;
    setBusy(true);
    void daemon
      .saveSystemKey(system.id, value.trim())
      .then(() => {
        toast("ok", `Routing key saved for ${system.displayName}.`);
        onDone();
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
      <Field label={routingLabel(system)} hint={routingHint(system)}>
        {({ id, describedBy }) => (
          <KeyInput
            id={id}
            describedBy={describedBy}
            value={value}
            onChange={setValue}
            placeholder={system.keySet ? `paste a new ${keyName}` : `paste the ${keyName}`}
            autoFocus
          />
        )}
      </Field>
      <div className="flex items-center gap-2">
        <Button tone="primary" type="submit" disabled={busy || value.trim().length === 0}>
          {busy ? <Spinner /> : "Save"}
        </Button>
        <Button disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
