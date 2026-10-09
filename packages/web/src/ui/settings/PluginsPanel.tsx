import { useRef, useState, useEffect, type ReactNode } from "react";
import { Trash2, Upload } from "lucide-react";
import { consentBroken, MACHINE_GONE, pluginFailure, pluginPath, pluginStateText } from "../../plugins";
import { peekPluginArchive, type ArchivePeek, type ManifestPreview } from "../../pluginArchive";
import { PLUGIN_ARCHIVE_ACCEPT, PluginArchiveNote, PluginConsent, PluginUnreadable } from "../PluginConsent";
import type { MachineId } from "../../ids";
import { marketEntryPath } from "../../market";
import { navigate } from "../../router";
import { machineLeafPath, machineListPath } from "../../settings";
import { store } from "../../store";
import type { PluginSummary } from "../../wire";
import {
  Button,
  DangerButton,
  Empty,
  Icon,
  RowAction,
  RowMenu,
  SETTINGS_HEADING,
  SkeletonRow,
  Spinner,
  TwoStep,
} from "../bits";
import { toast } from "../Toast";
import { CopyButton } from "../kit/CopyButton";
import { ActionRow, EmptyRow, Group, LinkRow, TWO_STEP_ROW } from "../kit/List";
import { Notice, Pending, RecheckButton } from "../kit/Status";

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

interface Handoff {
  machineId: MachineId;
  file: File;
}

// The chosen archive, handed over in module state rather than the URL; peeked in state, cleared on mount.
let handoff: Handoff | null = null;

function peekHandoff(): Handoff | null {
  return handoff;
}

function clearHandoff(): void {
  handoff = null;
}

type Hold = (pluginId: string, doing: string | null) => void;

export function PluginList({ machineId }: { machineId: MachineId }): ReactNode {
  const { plugins, error, loading, refresh } = usePlugins(machineId);
  // Per plugin, so a row's acts and its failure's restart hold one lock, and the row's subline says what is under way.
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(new Map());
  const input = useRef<HTMLInputElement | null>(null);

  const hold: Hold = (pluginId, doing) =>
    setPending((was) => {
      const next = new Map(was);
      if (doing === null) next.delete(pluginId);
      else next.set(pluginId, doing);
      return next;
    });

  // Nothing is read or sent from here: the leaf reads the manifest before anything goes to the daemon.
  const choose = (file: File): void => {
    handoff = { machineId, file };
    navigate(machineLeafPath(machineId, "plugin-install"));
  };

  const again = <RecheckButton onClick={refresh} busy={loading} />;

  if (plugins === null) {
    return (
      <Group title="Installed">
        {error === null ? (
          <SkeletonRow />
        ) : (
          <Empty failed action={again}>
            {error}
          </Empty>
        )}
      </Group>
    );
  }

  const failed = plugins.filter((plugin) => plugin.failure !== null);
  return (
    <div>
      {/* A failed re-read is said under the last list rather than replacing it. */}
      <Group title="Installed" action={error === null ? undefined : again} error={error}>
        {plugins.length === 0 ? (
          <EmptyRow>Nothing installed.</EmptyRow>
        ) : (
          plugins.map((plugin) => (
            <PluginRow
              key={plugin.id}
              machineId={machineId}
              plugin={plugin}
              pending={pending.get(plugin.id) ?? null}
              hold={hold}
              onChanged={refresh}
            />
          ))
        )}
      </Group>
      {failed.length > 0 && (
        <div className="mt-2 space-y-2">
          {failed.map((plugin) => (
            <PluginFailure
              key={plugin.id}
              machineId={machineId}
              plugin={plugin}
              pending={pending.get(plugin.id) ?? null}
              hold={hold}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
      <Group title="Install">
        <ActionRow title="Install from a file" glyph={Upload} onClick={() => input.current?.click()} />
      </Group>
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
    </div>
  );
}

function PluginRow({
  machineId,
  plugin,
  pending,
  hold,
  onChanged,
}: {
  machineId: MachineId;
  plugin: PluginSummary;
  pending: string | null;
  hold: Hold;
  onChanged: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const busy = pending !== null;

  const run = (work: Promise<unknown>, doing: string, done: string): void => {
    hold(plugin.id, doing);
    void work
      .then(() => {
        toast("ok", done);
        onChanged();
      })
      .catch((cause: unknown) => toast("error", pluginFailure(cause)))
      .finally(() => hold(plugin.id, null));
  };

  const daemon = store.daemonFor(machineId);

  return confirming ? (
    <TwoStep
      armed
      onArm={setConfirming}
      align="end"
      className={TWO_STEP_ROW}
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
    // The link is not the box's own child, so the last row hands it the bottom corners its hover fill would square off.
    <div className="flex min-w-0 items-center pr-1 last:[&>button]:rounded-b-lg">
      <LinkRow
        title={plugin.name}
        value={plugin.version}
        subline={
          pending === null ? (
            pluginStateText(plugin)
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Spinner />
              {pending}
            </span>
          )
        }
        onClick={() => navigate(marketEntryPath(plugin.id))}
      />
      <RowMenu label={`Actions for ${plugin.name}`}>
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
              disabled={busy}
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
              disabled={busy}
              onClick={() => {
                close();
                setConfirming(true);
              }}
            />
          </>
        )}
      </RowMenu>
    </div>
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
  machineId,
  plugin,
  pending,
  hold,
  onChanged,
}: {
  machineId: MachineId;
  plugin: PluginSummary;
  pending: string | null;
  hold: Hold;
  onChanged: () => void;
}): ReactNode {
  const { said, log } = failureParts(plugin.failure ?? "");
  const busy = pending !== null;
  const daemon = store.daemonFor(machineId);

  // Sending true resets the start budget, so this revives a plugin that gave up; the answer decides the toast.
  const restart = (): void => {
    if (daemon === undefined || busy) return;
    hold(plugin.id, "Starting…");
    void daemon
      .setPluginEnabled(plugin.id, true)
      .then((answer) => {
        const up = answer.plugin.state === "running";
        toast(up ? "ok" : "error", up ? `${plugin.name} is running again.` : `${plugin.name} did not start.`);
        onChanged();
      })
      .catch((cause: unknown) => toast("error", pluginFailure(cause)))
      .finally(() => hold(plugin.id, null));
  };

  return (
    // Under the list rather than inside its box, so it names the plugin it is about.
    <Notice tone="warn">
      <span className="block">
        <span className="font-medium">{plugin.name}</span>: {said}
      </span>
      {log !== null && (
        <>
          <span className="mt-2 flex items-center gap-2">
            <span className={SETTINGS_HEADING}>What it printed</span>
            <span className="ml-auto flex items-center">
              <CopyButton value={log} label="what it printed" />
            </span>
          </span>
          <pre className="font-mono text-2xs leading-snug whitespace-pre-wrap wrap-anywhere text-muted">
            {log}
          </pre>
        </>
      )}
      {/* A switched-off plugin's failure is history; Switch on resets the same budget. */}
      {plugin.enabled && (
        <span className="mt-2 block">
          <Button size="sm" tone="ghost" className="[@media(pointer:coarse)]:min-h-11" disabled={busy} onClick={restart}>
            {busy ? <Spinner /> : "Start it again"}
          </Button>
        </span>
      )}
    </Notice>
  );
}

/** The install leaf: shows the handed-off file's consent and reads nothing of its own first; with nothing in hand it walks back. */
export function PluginInstall({ machineId }: { machineId: MachineId }): ReactNode {
  const [file] = useState<File | null>(() => {
    const held = peekHandoff();
    return held !== null && held.machineId === machineId ? held.file : null;
  });
  const back = (): void => navigate(machineListPath(machineId, "plugins"), true);

  useEffect(() => {
    clearHandoff();
    if (file === null) back();
  }, [file]);

  if (file === null) return null;
  return <InstallPlugin machineId={machineId} file={file} onDone={back} />;
}

function InstallPlugin({
  machineId,
  file: handed,
  onDone,
}: {
  machineId: MachineId;
  file: File;
  onDone: () => void;
}): ReactNode {
  const input = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState(handed);
  const [peek, setPeek] = useState<ArchivePeek | null>(null);
  const [phase, setPhase] = useState<
    { kind: "idle" } | { kind: "sending"; fraction: number } | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const stop = useRef<AbortController | null>(null);

  // The manifest is read before anything is sent, again for every file chosen here.
  useEffect(() => {
    let live = true;
    setPeek(null);
    setPhase({ kind: "idle" });
    void peekPluginArchive(file).then((answer) => {
      if (live) setPeek(answer);
    });
    return () => {
      live = false;
    };
  }, [file]);

  // shown is the manifest the consent screen described, or null when nothing was shown.
  const send = (shown: ManifestPreview | null): void => {
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
        onDone();
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

  const sending = phase.kind === "sending";
  const progress = phase.kind === "sending" ? `${Math.round(phase.fraction * 100)}%` : null;

  return (
    <div className="max-w-xl">
      <PluginArchiveNote />
      {peek === null ? (
        <Pending>Reading…</Pending>
      ) : peek.kind === "ok" ? (
        <PluginConsent manifest={peek.manifest} />
      ) : (
        <PluginUnreadable reason={peek.reason} checker="This machine" />
      )}
      {phase.kind === "failed" && (
        <div className="mt-3">
          <Notice tone="warn">
            <span className="block max-h-56 overflow-auto whitespace-pre-wrap wrap-anywhere">{phase.message}</span>
          </Notice>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept={PLUGIN_ARCHIVE_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const next = event.target.files?.[0];
          event.target.value = "";
          if (next !== undefined) setFile(next);
        }}
      />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {peek !== null && peek.kind === "unreadable" ? (
          <>
            {/* The first press reopens the picker, so the unsafe install is never the only way on from here. */}
            <Button disabled={sending} onClick={() => input.current?.click()}>
              <Icon as={Upload} size={14} />
              Choose another file
            </Button>
            <DangerButton icon={Upload} disabled={sending} onClick={() => send(null)}>
              {progress ?? "Install without reading it"}
            </DangerButton>
          </>
        ) : (
          <Button
            tone="primary"
            disabled={peek === null || sending}
            onClick={() => {
              if (peek !== null && peek.kind === "ok") send(peek.manifest);
            }}
          >
            {progress === null ? (
              "Install it"
            ) : (
              <>
                <Spinner />
                {progress}
              </>
            )}
          </Button>
        )}
        {/* Mid-upload it aborts too, through the signal the upload was handed, so nothing is left sending. */}
        <Button
          onClick={() => {
            stop.current?.abort();
            onDone();
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
