import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MachineId } from "../../ids";
import { scopeSummary } from "../../install";
import type { MachineState } from "../../machine";
import { marketSettingsPath } from "../../market";
import { paneAgreement, type PaneAgreement, type PaneReading } from "../../pane";
import { pluginFailure, readView } from "../../plugins";
import { navigate } from "../../router";
import { store, type AppState } from "../../store";
import { ambiguousNames } from "../../wire";
import { Empty, LINK, Spinner } from "../bits";
import { PluginBlockView } from "../PluginView";

/**
 * A plugin's settings, on the machines somebody selected.
 *
 * ⚠ **It used to be a leaf of the settings sheet and nobody found it** — Settings →
 * Machines → *a* machine → Plugins → a kebab → Settings, six taps behind a control
 * that looks like a row's overflow menu. ⚠ **And then it was a section on the
 * plugin's page, which was still wrong**: that page is what a plugin *is* and is
 * read once, while its settings are what somebody comes back for. A screen of its
 * own, one push deep, is what both of those arrived at and it has not moved.
 *
 * ⚠ **What moved is the scope, and it is no longer a question this screen asks.**
 * It drew a machine picker over the installs that report a pane — a set that is not
 * the set the plugin is on — and where that came to one it drew nothing at all, so
 * the commonest state named no machine anywhere on screen. The machines are chosen
 * on the plugin's page now and carried in the URL, so this screen **states** the
 * scope instead of asking for it. A picker here would be a second scope control
 * able to disagree with the address.
 *
 * ⚠ **Per machine because the data is.** `plugin_data` is a table in one daemon's
 * SQLite, so two machines running the same plugin are two configurations — and
 * writing one form to several is only honest where they agree about its shape,
 * which is `paneAgreement`'s whole job.
 */
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
  /**
   * What this plugin turned out to be called, handed to the sheet's head.
   *
   * ⚠ **From the machines rather than from the catalogue.** This screen makes no
   * catalogue request — it has no use for one — and a plugin that arrived as a file
   * is not in the catalogue at all while being exactly as configurable.
   */
  onIdentified: (identity: { id: string; name: string; version: string; icon: string | null }) => void;
}): ReactNode {
  /*
   * ⚠ **The URL is the scope and the fleet is the truth, and they can disagree.** A
   * machine named in the path may have been revoked in another tab between the
   * press and this render, and a cold deep link was never pressed at all. Walked
   * from `state.machines` rather than from the path, so the order is the order the
   * fleet is drawn in everywhere else and a name in a URL cannot put a host on this
   * screen that is not in the person's list.
   */
  const named = new Set(machines);
  const here = state.machines.filter((one) => named.has(one.id));
  const gone = machines.filter((id) => !state.machines.some((one) => one.id === id));

  const rows = here.map((machine) => state.pluginsByMachine.get(machine.id)?.find((one) => one.id === pluginId) ?? null);
  const name = rows.find((one) => one !== null)?.name ?? pluginId;
  const version = [...new Set(rows.flatMap((one) => (one === null ? [] : [one.version])))].join(", ");

  useEffect(() => {
    // This screen reads no catalogue, so it has no icon to offer.
    onIdentified({ id: pluginId, name, version, icon: null });
  }, [onIdentified, pluginId, name, version]);

  if (here.length === 0) {
    return <Empty>None of those machines is in your list any more, so there is nothing to configure.</Empty>;
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

/** What happened to one machine's save. */
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
  /**
   * Every selected machine's pane, or `null` while none has been read.
   *
   * ⚠ **No refresh timer, deliberately, and the reason is the form.** A settings
   * pane is a thing somebody is typing into, and re-reading it under them would
   * either discard what they typed or keep it over a value the plugin has since
   * changed. `refreshMs` is honoured on the plugin's *screen*, which is a thing you
   * look at; a form is a thing you fill in. The only re-read is the one a save
   * causes.
   */
  const [readings, setReadings] = useState<PaneReading[] | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<MachineId, SaveOutcome>>(new Map());
  const [saves, setSaves] = useState(0);
  /**
   * Which round the answers landing now belong to.
   *
   * Two saves in a row are ordinary, and a slow first answer must not overwrite
   * what the second has since written. `MachineInstalls`' `epochs` and
   * `PluginScreen`'s `liveRoute` keep the same gate — but that one keys **per
   * machine**, because two rows pressed a second apart are two acts and an
   * act-wide counter would discard the first's answer for a machine the second
   * never touched. One counter is right here: a save on this screen is one act
   * across every machine in scope, sent from one press.
   */
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
          /*
           * ⚠ **A machine that could not be read takes no part and is never written
           * to.** Writing a setting whose current value was never seen is the same
           * class of failure as writing to a machine nobody selected — `install.ts`'s
           * `unreachable` arm makes the argument: a value drawn for a host nobody
           * can read would be a claim.
           */
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
    // The scope is the component's key, so this runs once per scope; `ids` is
    // derived from it and `readAll` closes over nothing that outlives the round.
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
          return [id, { kind: "failed", message: "That machine is not in your list any more." }];
        }
        try {
          /*
           * ⚠ **Nothing is retried.** `MachineInstalls` retries `plugin_busy` and
           * only that, because installs are serialised for a whole daemon; an action
           * is not and has no such refusal. Everything else is not retried because a
           * `POST` is not replayable — a transport failure says nothing about
           * whether the plugin's handler ran, and a settings write run twice is a
           * write nobody asked for.
           */
          await daemon.pluginAction(pluginId, actionId, context);
          return [id, { kind: "saved" }];
        } catch (cause: unknown) {
          return [id, { kind: "failed", message: pluginFailure(cause) }];
        }
      }),
    ).then((all) => {
      if (round.current !== epoch) return;
      setOutcomes(new Map(all));
      /*
       * ⚠ **Re-read every target and run the agreement again**, rather than using
       * each action's answer where it returned a view. An action's answer is one
       * machine's redraw and may legitimately differ from a fresh read; only a fresh
       * read can honestly answer *are they in agreement now?* That is what closes
       * the mixed loop, and it is a stronger confirmation than any toast: after a
       * save that reached everything the warning goes and the form comes back
       * seeded, and if two machines failed it is still there, which is correct.
       */
      readAll(epoch, agreement.targets);
      setSaves((held) => held + 1);
    });
  };

  const saving = [...outcomes.values()].some((one) => one.kind === "saving");
  const scope = here.map((one) => (ambiguous.has(one.name.toLowerCase()) ? `${one.name} (${one.id})` : one.name));

  return (
    <div>
      {/*
       * ⚠ **Always drawn, at every count, and it does not scroll away.** The picker
       * this replaces appeared only where more than one machine offered a pane, so
       * the commonest state — one — named no machine anywhere. `sticky` because a
       * long form scrolls the line off while the question it answers, *which
       * machines is this going to*, is asked while typing.
       *
       * ⚠ `bg-surface` explicitly, `AppShell`'s rule that every surface paints its
       * own ground: a transparent sticky bar has the form legible straight through
       * it. `z-10` sits under `LAYER.menu`'s `z-40`, so a `select` field's dropdown
       * panel paints over this bar rather than under it.
       */}
      <div className="sticky top-0 z-10 -mx-4 -mt-4 mb-4 border-b border-edge bg-surface px-4 py-2 text-xs sm:-mx-5 sm:px-5">
        <span className="text-muted">Writing to </span>
        <span className="text-fg" title={scope.join(", ")}>
          {scopeSummary(scope)}
        </span>
      </div>

      <Excluded agreement={agreement} gone={gone} nameOf={nameOf} />

      {agreement.form.kind === "divergent" ? (
        <div className="text-sm">
          <p className="text-fg">
            These machines are on versions whose settings are not the same form, so they cannot be set together.
          </p>
          {/*
           * ⚠ **Grouped rather than merely refused, and that is what the scope being
           * an address buys.** Each group is a link to its own settings screen, so
           * "these hosts disagree" is two taps from a coherent set rather than a
           * dead end.
           */}
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
        <Empty>{name} has no settings on those machines.</Empty>
      ) : (
        <>
          {agreement.form.kind === "mixed" && (
            /*
             * ⚠ **The client's own line, drawn outside the block renderer and never
             * as a synthesized `notice`.** `notice` is the *plugin's* diagnostic
             * channel — for a plugin with no screen it is the only one it has — so a
             * sentence this app wrote, drawn in that box, would be indistinguishable
             * from the plugin's own words.
             */
            <p className="mb-4 rounded-md border border-edge-strong px-3 py-2 text-sm text-fg">
              These machines had different settings for {agreement.form.differing.join(", ")}, so nothing is filled in.
              Set them again and save to make them the same everywhere.
            </p>
          )}
          {/*
           * ⚠ **Seeded blank by handing the fields down with no values**, which needs
           * no prop and no second component: `Form` seeds once per mount from
           * `seedForm`, and `seedForm` maps a missing value to the empty string — or
           * `"false"` for a toggle, since every field is a string on the wire.
           *
           * Keyed on the round *and* the agreement, so a save that flips `mixed` to
           * `agreed` re-seeds the form with what the machines now hold.
           */}
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

      {/* Whatever else the machines said, deduplicated and attributed. Nothing is
          dropped: a plugin with no screen of its own has no other channel for a
          failure nobody is waiting on. */}
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
  );
}

/**
 * The machines this screen will not write to, and why.
 *
 * ⚠ **Named rather than dropped.** A machine somebody selected and never heard
 * about again is the failure `planTargets`' partition exists to prevent, at the
 * other end of the same screen.
 */
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
    ...gone.map((id) => `${nameOf(id)} is not in your list any more`),
    ...agreement.excluded.flatMap((one) => {
      if (one.reason === "unreadable") return [`${nameOf(one.machineId)} could not be read`];
      if (one.reason === "no_form") return [`${nameOf(one.machineId)} has no settings pane`];
      return [];
    }),
  ];
  if (said.length === 0) return null;
  return <p className="mb-4 text-2xs text-muted">Not included: {said.join(", ")}.</p>;
}

/**
 * What the save did, per machine.
 *
 * ⚠ **On screen rather than in a toast, on every path.** Over a fan-out a toast
 * lies in both directions: "Saved" while two of five failed, or one error toast for
 * three different failures. `MachineInstalls` takes the same posture, and this
 * stands until the next act rather than expiring.
 */
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
      {/* Always mounted, the ternary on the className rather than on the mount —
          `EventList` and `Toast` both record that a live region inserted in the same
          paint as its content is commonly not spoken at all, VoiceOver included. */}
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
