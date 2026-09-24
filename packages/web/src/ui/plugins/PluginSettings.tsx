import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MachineId } from "../../ids";
import { scopeSummary } from "../../install";
import type { MachineState } from "../../machine";
import { marketEntryPath, marketSettingsPath } from "../../market";
import { paneAgreement, type PaneAgreement, type PaneReading } from "../../pane";
import { MACHINE_GONE, machineGone, pluginFailure, readView } from "../../plugins";
import { navigate } from "../../router";
import { store, type AppState } from "../../store";
import { ambiguousNames } from "../../wire";
import { Button, Empty, LINK, Spinner } from "../bits";
import { PluginBlockView } from "../PluginView";

// Settings for the machines named in the URL, per machine because plugin data lives in each daemon's database.
/** Padding drawn here: the market's scroller leaves this screen flush so the sticky bar reaches its edges (Q3.553). */
const PANE_PAD = "px-4 py-4 sm:px-5";

export function PluginSettingsScreen({
  state,
  pluginId,
  machines,
  onIdentified,
}: {
  state: AppState;
  pluginId: string;
  /** The scope, straight off the route. Never component state. */
  machines: readonly MachineId[];
  onIdentified: (identity: { id: string; name: string; version: string; icon: string | null }) => void;
}): ReactNode {
  // Walked from state.machines so a URL cannot add a host that is not in the person's list.
  const named = new Set(machines);
  const here = state.machines.filter((one) => named.has(one.id));
  const gone = machines.filter((id) => !state.machines.some((one) => one.id === id));

  const rows = here.map((machine) => state.pluginsByMachine.get(machine.id)?.find((one) => one.id === pluginId) ?? null);
  const name = rows.find((one) => one !== null)?.name ?? pluginId;
  const version = [...new Set(rows.flatMap((one) => (one === null ? [] : [one.version])))].join(", ");

  useEffect(() => {
    onIdentified({ id: pluginId, name, version, icon: null });
  }, [onIdentified, pluginId, name, version]);

  if (here.length === 0) {
    // A settled answer, not a failure; replace so Back does not walk into the dead scope.
    return (
      <div className={PANE_PAD}>
        <Empty
          action={
            <Button size="sm" onClick={() => navigate(marketEntryPath(pluginId), true)}>
              Back to the plugin
            </Button>
          }
        >
          None of those machines is in your list any more, so there is nothing to configure.
        </Empty>
      </div>
    );
  }
  return (
    <Pane
      key={here.map((one) => one.id).join(" ")}
      state={state}
      pluginId={pluginId}
      here={here}
      gone={gone}
      name={name}
    />
  );
}

type SaveOutcome = { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string };

function Pane({
  state,
  pluginId,
  here,
  gone,
  name,
}: {
  state: AppState;
  pluginId: string;
  here: readonly MachineState[];
  gone: readonly MachineId[];
  name: string;
}): ReactNode {
  /** Every selected machine's pane, or null until read; no refresh timer, which would clobber a form being typed into. */
  const [readings, setReadings] = useState<PaneReading[] | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<MachineId, SaveOutcome>>(new Map());
  const [saves, setSaves] = useState(0);
  /** Save round: a slower earlier answer must not overwrite a later one; one counter because a save is one act. */
  const round = useRef(0);

  const readAll = (epoch: number, ids: readonly MachineId[]): void => {
    void Promise.all(
      ids.map(async (id): Promise<PaneReading> => {
        const daemon = store.daemonFor(id);
        if (daemon === undefined) return { machineId: id, view: null };
        try {
          const answer = await daemon.pluginView(pluginId, "settings");
          return { machineId: id, view: answer.result.kind === "view" ? readView(answer.result.view, "settings") : null };
        } catch {
          // An unreadable machine takes no part and is never written to.
          return { machineId: id, view: null };
        }
      }),
    ).then((all) => {
      if (round.current === epoch) setReadings(all);
    });
  };

  const ids = here.map((one) => one.id);
  useEffect(() => {
    const epoch = (round.current += 1);
    setReadings(null);
    readAll(epoch, ids);
    // ids change only with a remount, being the component's key, and readAll reads nothing that goes stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId]);

  if (readings === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  const agreement = paneAgreement(readings);
  const ambiguous = ambiguousNames(state.machines);
  const nameOf = (id: MachineId): string => {
    const machine = here.find((one) => one.id === id);
    if (machine === undefined) return id;
    return ambiguous.has(machine.name.toLowerCase()) ? `${machine.name} (${machine.id})` : machine.name;
  };

  const save = (actionId: string, context: { row?: string; form?: Record<string, string> }): void => {
    const epoch = (round.current += 1);
    setOutcomes(new Map(agreement.targets.map((id) => [id, { kind: "saving" } as SaveOutcome])));
    void Promise.all(
      agreement.targets.map(async (id): Promise<readonly [MachineId, SaveOutcome]> => {
        const daemon = store.daemonFor(id);
        if (daemon === undefined) {
          return [id, { kind: "failed", message: MACHINE_GONE }];
        }
        try {
          // Nothing is retried: a POST is not replayable, and a settings write run twice is unasked for.
          await daemon.pluginAction(pluginId, actionId, context);
          return [id, { kind: "saved" }];
        } catch (cause: unknown) {
          return [id, { kind: "failed", message: pluginFailure(cause) }];
        }
      }),
    ).then((all) => {
      if (round.current !== epoch) return;
      setOutcomes(new Map(all));
      // Re-read every target and re-run the agreement; only a fresh read shows whether they now agree.
      readAll(epoch, agreement.targets);
      setSaves((held) => held + 1);
    });
  };

  const saving = [...outcomes.values()].some((one) => one.kind === "saving");
  const scope = here.map((one) => (ambiguous.has(one.name.toLowerCase()) ? `${one.name} (${one.id})` : one.name));

  return (
    <div>
      {/* Always drawn and sticky, and needs no negative margin: the scroller pads nothing for this screen. */}
      <div className="sticky top-0 z-10 border-b border-edge bg-surface px-4 py-2 text-xs sm:px-5">
        <span className="text-muted">Writing to </span>
        <span className="text-fg" title={scope.join(", ")}>
          {scopeSummary(scope)}
        </span>
      </div>
      <div className={PANE_PAD}>

      <Excluded agreement={agreement} gone={gone} nameOf={nameOf} />

      {agreement.form.kind === "divergent" ? (
        <div className="text-sm">
          <p className="text-fg">
            These machines are on versions whose settings are not the same form, so they cannot be set together.
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {agreement.form.groups.map((group) => (
              <li key={group.machines.join(",")}>
                <button
                  type="button"
                  className={`tap min-h-11 text-left text-xs ${LINK}`}
                  onClick={() => navigate(marketSettingsPath(pluginId, group.machines), true)}
                >
                  {group.machines.map(nameOf).join(", ")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : agreement.form.kind === "none" ? (
        <Empty
          action={
            <Button size="sm" onClick={() => navigate(marketEntryPath(pluginId), true)}>
              Back to the plugin
            </Button>
          }
        >
          {name} has no settings on those machines.
        </Empty>
      ) : (
        <>
          {agreement.form.kind === "mixed" && (
            // The client's own line, never a synthesized notice, which is the plugin's own channel.
            <p className="mb-4 rounded-md border border-edge-strong px-3 py-2 text-sm text-fg">
              These machines had different settings for {agreement.form.differing.join(", ")}, so nothing is filled in.
              Set them again and save to make them the same everywhere.
            </p>
          )}
          {/* Mixed forms are seeded blank; keyed on the round and the agreement so a save re-seeds. */}
          <PluginBlockView
            key={`${saves}:${agreement.form.kind}`}
            block={
              agreement.form.kind === "mixed"
                ? { ...agreement.form.block, fields: agreement.form.block.fields.map((one) => ({ ...one, value: null })) }
                : agreement.form.block
            }
            busy={saving}
            onAction={save}
          />
        </>
      )}

      {agreement.said.map((one, index) => (
        <div key={index} className="mt-4">
          {one.machines.length < here.length && (
            <p className="mb-1 text-2xs text-muted">{one.machines.map(nameOf).join(", ")}</p>
          )}
          <PluginBlockView block={one.block} busy={saving} onAction={save} />
        </div>
      ))}

      <Outcomes outcomes={outcomes} nameOf={nameOf} />
      </div>
    </div>
  );
}

function Excluded({
  agreement,
  gone,
  nameOf,
}: {
  agreement: PaneAgreement;
  gone: readonly MachineId[];
  nameOf: (id: MachineId) => string;
}): ReactNode {
  const said = [
    ...gone.map((id) => machineGone(nameOf(id))),
    ...agreement.excluded.flatMap((one) => {
      if (one.reason === "unreadable") return [`${nameOf(one.machineId)} could not be read`];
      if (one.reason === "no_form") return [`${nameOf(one.machineId)} has no settings pane`];
      return [];
    }),
  ];
  if (said.length === 0) return null;
  return <p className="mb-4 text-2xs text-muted">Not included: {said.join(", ")}.</p>;
}

/** Per machine and on screen rather than a toast, which lies over a fan-out. */
function Outcomes({
  outcomes,
  nameOf,
}: {
  outcomes: ReadonlyMap<MachineId, SaveOutcome>;
  nameOf: (id: MachineId) => string;
}): ReactNode {
  const failed = [...outcomes.entries()].flatMap(([id, one]) =>
    one.kind === "failed" ? [{ id, message: one.message }] : [],
  );
  const saved = [...outcomes.values()].filter((one) => one.kind === "saved").length;
  const line = failed.length > 0 || saved === 0 ? "" : `Saved on ${saved === 1 ? "1 machine" : `${saved} machines`}.`;
  return (
    <div className="mt-4">
      {/* Always mounted: a live region inserted with its content is often not announced. */}
      <p role="status" aria-live="polite" className={line.length === 0 ? "" : "text-xs text-muted"}>
        {line}
      </p>
      {failed.map((one) => (
        <p key={one.id} className="mt-1 text-2xs wrap-anywhere text-fg">
          {nameOf(one.id)}: {one.message}
        </p>
      ))}
    </div>
  );
}
