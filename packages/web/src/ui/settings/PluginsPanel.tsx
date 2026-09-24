import { useRef, useState, useEffect, type ReactNode } from "react";
import { AlertTriangle, ChevronRight, MoreHorizontal, Trash2, Upload } from "lucide-react";
import { consentBroken, MACHINE_GONE, pluginFailure, pluginPath, pluginStateText } from "../../plugins";
import { peekPluginArchive, type ArchivePeek, type ManifestPreview } from "../../pluginArchive";
import { PLUGIN_ARCHIVE_ACCEPT, PluginArchiveNote, PluginConsent, PluginUnreadable } from "../PluginConsent";
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
  Spinner,
  TwoStep,
} from "../bits";
import { toast } from "../Toast";

function usePlugins(machineId: MachineId): {
  plugins: PluginSummary[] | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = (): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      // undefined means the machine left the listing (revoked or retired), not that it is unreachable.
      setError(MACHINE_GONE);
      // Nothing was sent, so clear loading or the retry control stays disabled.
      setLoading(false);
      return;
    }
    setLoading(true);
    void daemon
      .plugins()
      .then((listing) => {
        setPlugins(listing.plugins);
        setError(null);
        // The rail launcher and session menus read the store's copy, so refresh it too.
        store.refreshPlugins(machineId);
      })
      .catch((cause: unknown) => setError(pluginFailure(cause)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, [machineId]);
  return { plugins, error, loading, refresh };
}

export function PluginList({ machineId }: { machineId: MachineId }): ReactNode {
  const { plugins, error, loading, refresh } = usePlugins(machineId);

  const again = (
    <Button onClick={refresh} disabled={loading}>
      {loading ? "Checking…" : "Check again"}
    </Button>
  );

  if (plugins === null) {
    if (error !== null) {
      return (
        <Empty failed action={again}>
          {error}
        </Empty>
      );
    }
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      {/* A failed re-read sits above the last list rather than replacing it. */}
      {error !== null && (
        <div role="status" className="mb-3 flex flex-wrap items-center gap-2 px-1">
          <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs text-fg">
            <Icon as={AlertTriangle} size={14} className="mt-0.5 shrink-0 text-muted" />
            <span>{error}</span>
          </p>
          {again}
        </div>
      )}
      {plugins.length === 0 ? (
        <Empty>Nothing installed.</Empty>
      ) : (
        <ul className="flex flex-col">
          {plugins.map((plugin) => (
            <PluginRow key={plugin.id} machineId={machineId} plugin={plugin} onChanged={refresh} />
          ))}
        </ul>
      )}
      <div className="mt-6">
        <h3 className={SETTINGS_HEADING}>Install</h3>
        <InstallPlugin machineId={machineId} onInstalled={refresh} />
      </div>
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
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const busy = pending !== null;

  const run = (work: Promise<unknown>, doing: string, done: string): void => {
    setPending(doing);
    void work
      .then(() => {
        toast("ok", done);
        onChanged();
      })
      .catch((cause: unknown) => toast("error", pluginFailure(cause)))
      .finally(() => setPending(null));
  };

  const daemon = store.daemonFor(machineId);

  // Sending true resets the start budget, so this revives a plugin that gave up; the answer decides the toast.
  const restart = (): void => {
    if (daemon === undefined || busy) return;
    setPending("Starting…");
    void daemon
      .setPluginEnabled(plugin.id, true)
      .then((answer) => {
        const up = answer.plugin.state === "running";
        toast(
          up ? "ok" : "error",
          up ? `${plugin.name} is running again.` : `${plugin.name} did not start — see its row.`,
        );
        onChanged();
      })
      .catch((cause: unknown) => toast("error", pluginFailure(cause)))
      .finally(() => setPending(null));
  };

  return (
    <li className="border-b border-edge last:border-b-0">
      {confirming ? (
        <TwoStep
          armed
          onArm={setConfirming}
          align="end"
          className="min-h-14 min-w-0 px-1 py-2.5"
          question={
            <>
              Remove <span className="font-medium">{plugin.name}</span> and its data?
            </>
          }
          act={{ label: "Remove", danger: true, icon: Trash2 }}
          disabled={busy || daemon === undefined}
          onAct={() => {
            if (daemon !== undefined) run(daemon.removePlugin(plugin.id), "Removing…", "Removed");
          }}
        />
      ) : (
      <div className="flex min-w-0 items-center gap-1">
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
            <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
              {pending !== null && <Spinner />}
              <span className="truncate">{pending ?? pluginStateText(plugin)}</span>
            </span>
          </span>
          <Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />
        </button>
        <Menu
          align="right"
          panelClassName="w-56"
          trigger={(open, toggle) => (
            // lg, not sm: sm's grown hit target overlaps the row button and steals its taps.
            <IconButton
              icon={MoreHorizontal}
              label={`Actions for ${plugin.name}`}
              size="lg"
              active={open}
              disabled={busy}
              onClick={toggle}
            />
          )}
        >
          {(close) => (
            <>
              {plugin.contributes.screen !== null && (
                <RowAction
                  label="Open"
                  disabled={!plugin.enabled}
                  onClick={() => {
                    close();
                    navigate(pluginPath(machineId, plugin.id));
                  }}
                />
              )}
              <RowAction
                label={plugin.enabled ? "Switch off" : "Switch on"}
                onClick={() => {
                  close();
                  if (daemon === undefined) return;
                  run(
                    daemon.setPluginEnabled(plugin.id, !plugin.enabled),
                    plugin.enabled ? "Switching off…" : "Switching on…",
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
      )}

      {plugin.failure !== null && (
        <PluginFailure
          failure={plugin.failure}
          // A switched-off plugin's failure is history; Switch on resets the same budget.
          restartable={plugin.enabled}
          onRestart={restart}
          busy={busy}
        />
      )}

    </li>
  );
}

/** The daemon joins its own sentence and the child's output with a newline: first line is the claim. */
function failureParts(failure: string): { said: string; log: string | null } {
  const cut = failure.indexOf("\n");
  return cut === -1
    ? { said: failure, log: null }
    : { said: failure.slice(0, cut), log: failure.slice(cut + 1) };
}

/** No scroller: the daemon clips the failure to MAX_FAILURE_CHARS, and a nested scroller traps touch drags. */
function PluginFailure({
  failure,
  restartable,
  onRestart,
  busy,
}: {
  failure: string;
  restartable: boolean;
  onRestart: () => void;
  busy: boolean;
}): ReactNode {
  const { said, log } = failureParts(failure);
  return (
    <div className="mb-2 rounded-md bg-raised/50 px-2.5 py-2">
      <p className="text-xs text-fg">{said}</p>
      {log !== null && (
        <>
          <p className={`${SETTINGS_HEADING} mt-2`}>What it printed</p>
          <pre className="mt-1 font-mono text-2xs leading-snug whitespace-pre-wrap wrap-anywhere text-muted">
            {log}
          </pre>
        </>
      )}
      {restartable && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button size="sm" className="[@media(pointer:coarse)]:min-h-11" disabled={busy} onClick={onRestart}>
            {busy ? <Spinner /> : "Start it again"}
          </Button>
        </div>
      )}
    </div>
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
  const stop = useRef<AbortController | null>(null);

  const choose = (file: File): void => {
    setPhase({ kind: "reading" });
    void peekPluginArchive(file).then((peek) => setPhase({ kind: "confirming", file, peek }));
  };

  // shown is the manifest the consent screen described, or null when nothing was shown.
  const send = (file: File, shown: ManifestPreview | null): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setPhase({ kind: "failed", message: MACHINE_GONE });
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
        // The daemon's parsed manifest may claim more than the consent screen showed; report that instead of success.
        const broken = shown === null ? null : consentBroken(shown, answer.plugin);
        if (broken !== null) {
          toast("error", broken);
          return;
        }
        // The daemon's replaced field, not a guess from the listing, decides installed versus updated.
        toast(
          "ok",
          answer.replaced === null
            ? `Installed ${answer.plugin.name} ${answer.plugin.version}`
            : `Updated ${answer.plugin.name} to ${answer.plugin.version}`,
        );
      })
      .catch((cause: unknown) => {
        // An abort is a deliberate Cancel; test this controller, since a newer install may have replaced the ref.
        if (controller.signal.aborted) return;
        setPhase({ kind: "failed", message: pluginFailure(cause) });
      })
      .finally(() => {
        stop.current = null;
      });
  };

  return (
    <div className="mt-2">
      <PluginArchiveNote />
      <input
        ref={input}
        type="file"
        accept={PLUGIN_ARCHIVE_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file again still fires change.
          event.target.value = "";
          if (file !== undefined) choose(file);
        }}
      />

      {phase.kind === "confirming" && phase.peek.kind === "ok" && <PluginConsent manifest={phase.peek.manifest} />}
      {phase.kind === "confirming" && phase.peek.kind === "unreadable" && (
        <PluginUnreadable reason={phase.peek.reason} checker="This machine" />
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button
          disabled={phase.kind === "sending" || phase.kind === "reading"}
          onClick={() => {
            // With an unreadable archive this press must reopen the picker, or the only live control is the unsafe install.
            if (phase.kind === "confirming" && phase.peek.kind === "ok") {
              send(phase.file, phase.peek.manifest);
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
