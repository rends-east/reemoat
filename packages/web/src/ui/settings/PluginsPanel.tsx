import { useRef, useState, useEffect, type ReactNode } from "react";
import { ChevronRight, MoreHorizontal, Upload } from "lucide-react";
import { consentBroken, pluginFailure, pluginPath, pluginStateText } from "../../plugins";
import { peekPluginArchive, type ArchivePeek, type ManifestPreview } from "../../pluginArchive";
import { PluginConsent } from "../PluginConsent";
import type { MachineId } from "../../ids";
import { marketEntryPath } from "../../market";
import { navigate } from "../../router";
import { store } from "../../store";
import type { PluginSummary } from "../../wire";
import {
  Button,
  DangerButton,
  Empty,
  Icon,
  IconButton,
  Menu,
  RowAction,
  SETTINGS_HEADING,
  SETTINGS_SECTION,
  Spinner,
} from "../bits";
import { toast } from "../Toast";

/**
 * What is installed on one machine, and what each of them may reach.
 *
 * Two depths, like `AgentsPanel` beside it: no plugin named is the list, one named
 * is that plugin's own settings. And for the same reason those live inside a
 * machine at all — a plugin's code is on one host's disk and its data is in one
 * daemon's database, so a fleet-wide screen would open with a machine dropdown,
 * which is a screen asking a question its own copy answers.
 */

function usePlugins(machineId: MachineId): {
  plugins: PluginSummary[] | null;
  error: string | null;
  refresh: () => void;
} {
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setError("That machine is not reachable right now.");
      return;
    }
    void daemon
      .plugins()
      .then((listing) => {
        setPlugins(listing.plugins);
        setError(null);
        // The launcher in the rail and a session's menu read the store's copy, so
        // installing something here has to move all three. Not the other way round
        // — this screen keeps its own so that a failure is drawn *on it* rather
        // than becoming a machine that silently has no plugins.
        store.refreshPlugins(machineId);
      })
      .catch((cause: unknown) => setError(pluginFailure(cause)));
  };

  useEffect(refresh, [machineId]);
  return { plugins, error, refresh };
}

export function PluginList({ machineId }: { machineId: MachineId }): ReactNode {
  const { plugins, error, refresh } = usePlugins(machineId);

  if (error !== null) return <Empty>{error}</Empty>;
  if (plugins === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      {plugins.length === 0 ? (
        <Empty>Nothing installed on this machine.</Empty>
      ) : (
        <ul className="flex flex-col">
          {plugins.map((plugin) => (
            <PluginRow key={plugin.id} machineId={machineId} plugin={plugin} onChanged={refresh} />
          ))}
        </ul>
      )}
      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Install</h2>
        <InstallPlugin machineId={machineId} onInstalled={refresh} />
      </section>
    </div>
  );
}

function PluginRow({
  machineId,
  plugin,
  onChanged,
}: {
  machineId: MachineId;
  plugin: PluginSummary;
  onChanged: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const run = (work: Promise<unknown>, done: string): void => {
    setBusy(true);
    void work
      .then(() => {
        toast("ok", done);
        onChanged();
      })
      .catch((cause: unknown) => toast("error", pluginFailure(cause)))
      .finally(() => setBusy(false));
  };

  const daemon = store.daemonFor(machineId);

  return (
    <li className="border-b border-edge last:border-b-0">
      <div className="flex min-w-0 items-center gap-1">
        {/*
         * ⚠ **The row is a link to the plugin, and the wall of text it used to be
         * is on the page it links to.** It drew the plugin's description and then
         * every scope as a sentence — *"Read your sessions, their transcripts and
         * what they changed"*, four of those — on the argument that a capability
         * nobody re-reads is a capability nobody withdraws. What that produced was
         * a machine screen where three installed plugins filled a phone twice
         * over with prose that is identical on every machine, and the *settings*
         * of the plugin were a kebab entry underneath it that nobody found.
         *
         * The scopes are one tap away, in the permissions fold on the plugin's own
         * page, which is also where its settings now are. What stays on this row
         * is what is true of *this host* and cannot be read anywhere else: the
         * version installed here, whether it is running, and what it said if it
         * failed.
         */}
        <button
          type="button"
          onClick={() => navigate(marketEntryPath(plugin.id))}
          className="tap press flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-2.5 text-left hover:bg-raised"
        >
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-x-2">
              <span className="truncate text-sm font-medium">{plugin.name}</span>
              <span className="shrink-0 text-xs text-muted">{plugin.version}</span>
            </span>
            <span className="block truncate text-2xs text-muted">{pluginStateText(plugin)}</span>
          </span>
          <Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />
        </button>
        <Menu
          align="right"
          panelClassName="w-56"
          trigger={(open, toggle) => (
            <IconButton
              icon={MoreHorizontal}
              label={`Actions for ${plugin.name}`}
              size="sm"
              active={open}
              disabled={busy}
              onClick={toggle}
            />
          )}
        >
          {(close) => (
            <>
              {/* Disabled rather than absent while the plugin is switched off: the
                  row above says why, and a control that vanishes is one somebody
                  goes looking for. `focusableRows` skips a disabled button, so it
                  is not a stop on the way to one either. */}
              {plugin.contributes.screen !== null && plugin.enabled && (
                <RowAction
                  label="Open"
                  onClick={() => {
                    close();
                    navigate(pluginPath(machineId, plugin.id));
                  }}
                />
              )}
              {/*
               * ⚠ **No `Settings` row here any more, and that is the point of the
               * link above rather than an omission.** A plugin's settings are on
               * the plugin's page, drawn for the machines it is actually on. Two
               * doors to one pane is how the one nobody uses drifts.
               */}
              <RowAction
                label={plugin.enabled ? "Switch off" : "Switch on"}
                onClick={() => {
                  close();
                  if (daemon === undefined) return;
                  run(
                    daemon.setPluginEnabled(plugin.id, !plugin.enabled),
                    plugin.enabled ? "Switched off" : "Switched on",
                  );
                }}
              />
              <RowAction
                label="Remove"
                danger
                onClick={() => {
                  close();
                  setConfirming(true);
                }}
              />
            </>
          )}
        </Menu>
      </div>

      {plugin.failure !== null && (
        <p className="mb-2 max-h-56 overflow-auto px-1 text-xs whitespace-pre-wrap wrap-anywhere text-fg">
          {plugin.failure}
        </p>
      )}

      {/*
       * **The confirmation still leaves the menu and lands on the row.** A menu
       * held open to hold a two-step confirm would be a second dismissable layer
       * over the sheet, for one tap — `UsersSection` settled that, and the
       * confirming pair below is its shape, down to Cancel being last and filled.
       */}
      {confirming ? (
        /*
         * Two-step, and the confirming row ends with Cancel — the settings-row
         * rule, kept for its measured reason: both groups lay out in the same box,
         * so a second tap aimed at a button that looked inert lands on the undo.
         * This one earns it more than most, because uninstalling takes the
         * plugin's data with it and nothing brings that back.
         */
        <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
          <span className="text-xs text-muted">Remove it and everything it kept?</span>
          <Button
            tone="destructive"
            size="sm"
            className="[@media(pointer:coarse)]:min-h-11"
            disabled={busy || daemon === undefined}
            onClick={() => {
              setConfirming(false);
              if (daemon !== undefined) run(daemon.removePlugin(plugin.id), "Removed");
            }}
          >
            Remove
          </Button>
          <Button
            tone="primary"
            size="sm"
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function InstallPlugin({ machineId, onInstalled }: { machineId: MachineId; onInstalled: () => void }): ReactNode {
  const input = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<
    | { kind: "idle" }
    | { kind: "reading" }
    | { kind: "confirming"; file: File; peek: ArchivePeek }
    | { kind: "sending"; fraction: number }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });
  /**
   * Aborts the upload in flight. Held in a ref rather than state because nothing
   * on screen reads it — it exists so a hung send can be called off, which the
   * old flow could not do at all: it created an `AbortController`, never wired
   * `abort` to anything, and disabled the only button for the duration.
   */
  const stop = useRef<AbortController | null>(null);

  const choose = (file: File): void => {
    setPhase({ kind: "reading" });
    void peekPluginArchive(file).then((peek) => setPhase({ kind: "confirming", file, peek }));
  };

  /*
   * `shown` is what the consent screen described, carried through the send so the
   * answer can be checked against it. `null` when nobody was shown anything — the
   * "Install without reading it" path, where there is no claim to break.
   */
  const send = (file: File, shown: ManifestPreview | null): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setPhase({ kind: "failed", message: "That machine is not reachable right now." });
      return;
    }
    setPhase({ kind: "sending", fraction: 0 });
    const controller = new AbortController();
    stop.current = controller;
    void daemon
      .installPlugin(file, (fraction) => setPhase({ kind: "sending", fraction }), controller.signal)
      .then((answer) => {
        setPhase({ kind: "idle" });
        onInstalled();
        /*
         * ⚠ **Checked after the fact, because the reader can be wrong.** The
         * daemon returns the manifest it really parsed; if it holds authority the
         * screen did not show, that is said here rather than nowhere. `error`
         * rather than `ok`, and it replaces the success line: "Installed Clock
         * 1.0.0" beside a plugin that can answer every permission on the machine
         * is the same lie one step later. See {@link consentBroken}.
         */
        const broken = shown === null ? null : consentBroken(shown, answer.plugin);
        if (broken !== null) {
          toast("error", broken);
          return;
        }
        // The verb the daemon decided, not the one this screen guessed: `replaced`
        // is how a client learns whether it installed or updated, and guessing from
        // the list it fetched before sending would be wrong for a concurrent tab.
        toast(
          "ok",
          answer.replaced === null
            ? `Installed ${answer.plugin.name} ${answer.plugin.version}`
            : `Updated ${answer.plugin.name} to ${answer.plugin.version}`,
        );
      })
      .catch((cause: unknown) => {
        // An abort is somebody pressing Cancel, and `pluginFailure` has no arm for
        // one — it fell through to "That did not work. Try again." for an act they
        // took on purpose. `ImportCode` guards the same way for the same reason.
        // `controller`, not `stop.current`: a second install started in the
        // meantime would have replaced the ref, and this answer is about this one.
        if (controller.signal.aborted) return;
        setPhase({ kind: "failed", message: pluginFailure(cause) });
      })
      .finally(() => {
        stop.current = null;
      });
  };

  return (
    <div className="mt-2">
      <p className="text-xs text-muted">
        A <code className="text-muted/80">.tar.gz</code> or <code className="text-muted/80">.zip</code> holding{" "}
        <code className="text-muted/80">plugin.json</code> and <code className="text-muted/80">server.js</code>. Installing
        the same id again updates it and keeps what it has stored.
      </p>
      <p className="mt-1 text-xs text-muted">
        Nothing is sent until you have read what it asks for.
      </p>
      <input
        ref={input}
        type="file"
        accept=".tgz,.gz,.zip,application/gzip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared before the read, so choosing the same file twice in a row after
          // a failure fires `change` again — the input holds the previous value
          // otherwise and the second attempt silently does nothing.
          event.target.value = "";
          if (file !== undefined) choose(file);
        }}
      />

      {phase.kind === "confirming" && phase.peek.kind === "ok" && <PluginConsent manifest={phase.peek.manifest} />}
      {phase.kind === "confirming" && phase.peek.kind === "unreadable" && (
        <div className="mt-3 rounded-lg border border-edge p-3">
          <p className="text-sm text-fg">This file cannot be read here</p>
          {/*
            * ⚠ **Not a refusal.** The daemon is what decides whether an archive is a
            * plugin, and it accepts shapes this reader may not — so refusing here
            * would make the browser a second, stricter gate that turns away plugins
            * the machine would have taken. What it may not do is pretend: the whole
            * point of this screen is that somebody knows what they are agreeing to,
            * so when it cannot say, it says that, and the way through is a separate
            * press that names what is being given up.
            */}
          <p className="mt-1 text-xs text-muted">
            {phase.peek.reason}. Nothing has been sent. This machine will still check it properly — but until it does,
            nobody can tell you what this plugin asks for.
          </p>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button
          disabled={phase.kind === "sending" || phase.kind === "reading"}
          onClick={() => {
            // ⚠ The label is "Choose another file" when the archive could not be
            // read, and it has to open the picker or it is a dead control on the
            // one screen where the only other press is "Install without reading
            // it". Returning here left the safe way out inert and the unsafe one
            // working, which is the opposite of what this screen is for.
            if (phase.kind === "confirming" && phase.peek.kind === "ok") {
              send(phase.file, phase.peek.kind === "ok" ? phase.peek.manifest : null);
              return;
            }
            input.current?.click();
          }}
        >
          {phase.kind === "sending" ? <Spinner /> : <Upload size={14} />}
          {phase.kind === "sending"
            ? `${Math.round(phase.fraction * 100)}%`
            : phase.kind === "reading"
              ? "Reading…"
              : phase.kind === "confirming"
                ? phase.peek.kind === "ok"
                  ? "Install it"
                  : "Choose another file"
                : "Choose a file"}
        </Button>
        {phase.kind === "confirming" && phase.peek.kind === "unreadable" && (
          <DangerButton icon={Upload} onClick={() => send(phase.file, null)}>
            Install without reading it
          </DangerButton>
        )}
        {phase.kind === "confirming" && <Button onClick={() => setPhase({ kind: "idle" })}>Cancel</Button>}
        {phase.kind === "sending" && (
          <Button
            onClick={() => {
              stop.current?.abort();
              setPhase({ kind: "idle" });
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      {phase.kind === "failed" && <p className="mt-2 max-h-56 overflow-auto text-xs whitespace-pre-wrap wrap-anywhere text-fg">{phase.message}</p>}
    </div>
  );
}
