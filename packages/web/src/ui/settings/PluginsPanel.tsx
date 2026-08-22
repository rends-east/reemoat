import { useEffect, useRef, useState, type ReactNode } from "react";
import { Puzzle, Trash2, Upload } from "lucide-react";
import { pluginFailure, pluginPath, pluginStateText, readView } from "../../plugins";
import { peekPluginArchive, type ManifestPreview } from "../../pluginArchive";
import type { MachineId } from "../../ids";
import { navigate } from "../../router";
import { pluginSettingsPath, settingsPath } from "../../settings";
import { store } from "../../store";
import { PLUGIN_SCOPE_TEXT, type PluginSummary, type PluginView as PluginViewShape } from "../../wire";
import { Button, DangerButton, Empty, LINK, SETTINGS_HEADING, SETTINGS_SECTION, Spinner } from "../bits";
import { PluginView } from "../PluginView";
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
    <li className="border-b border-edge py-3 last:border-b-0">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium">{plugin.name}</span>
            <span className="text-xs text-muted">{plugin.version}</span>
            <span className="text-xs text-muted">· {pluginStateText(plugin)}</span>
          </div>
          {plugin.description !== null && <p className="mt-0.5 text-xs text-muted">{plugin.description}</p>}
          {/*
           * The scopes, as sentences, on every row rather than behind a disclosure.
           * This is the list somebody consented to, and a capability nobody re-reads
           * is a capability nobody withdraws.
           */}
          {plugin.scopes.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {plugin.scopes.map((scope) => (
                <li key={scope} className="text-xs text-muted">
                  {/* An unknown scope falls through to its own identifier — legible,
                      and never a guess about what a newer daemon means by it. */}
                  {PLUGIN_SCOPE_TEXT[scope] ?? scope}
                </li>
              ))}
            </ul>
          )}
          {plugin.net.length > 0 && (
            <p className="mt-0.5 text-xs text-muted">Reaches {plugin.net.join(", ")}</p>
          )}
          {plugin.failure !== null && (
            <p className="mt-1.5 max-h-56 overflow-auto text-xs whitespace-pre-wrap wrap-anywhere text-fg">{plugin.failure}</p>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {plugin.contributes.screen !== null && (
          <Button size="sm" disabled={!plugin.enabled} onClick={() => navigate(pluginPath(machineId, plugin.id))}>
            Open
          </Button>
        )}
        {plugin.contributes.settings && (
          <Button size="sm" onClick={() => navigate(pluginSettingsPath(machineId, plugin.id))}>
            Settings
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy || daemon === undefined}
          onClick={() => {
            if (daemon === undefined) return;
            run(daemon.setPluginEnabled(plugin.id, !plugin.enabled), plugin.enabled ? "Switched off" : "Switched on");
          }}
        >
          {plugin.enabled ? "Switch off" : "Switch on"}
        </Button>
        {/*
         * Two-step, and the confirming row ends with Cancel — the settings-row rule,
         * kept for its measured reason: both groups lay out in the same box, so a
         * second tap aimed at a button that looked inert lands on the undo. This one
         * earns it more than most, because uninstalling takes the plugin's data with
         * it and nothing brings that back.
         */}
        {confirming ? (
          <>
            <span className="text-xs text-muted">Remove it and everything it kept?</span>
            <Button
              tone="destructive"
              size="sm"
              disabled={busy || daemon === undefined}
              onClick={() => {
                setConfirming(false);
                if (daemon !== undefined) run(daemon.removePlugin(plugin.id), "Removed");
              }}
            >
              Remove
            </Button>
            <Button tone="primary" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <DangerButton icon={Trash2} size="sm" disabled={busy} onClick={() => setConfirming(true)}>
            Remove
          </DangerButton>
        )}
      </div>
    </li>
  );
}

/**
 * What a plugin says about itself, drawn before anything is sent.
 *
 * ⚠ **This is the consent step, and it is the whole reason the manifest is read
 * in the browser.** `SECURITY.md` says a plugin's blast radius is "named before
 * somebody consents to it"; it was not. The old flow POSTed the file straight
 * from the picker, and the daemon unpacked it, wrote the row and *started the
 * plugin* before a single scope reached a person — who then read the scopes on
 * the row of something already running. This screen is the sentence that claim
 * needs to be true.
 *
 * `hooks` is drawn beside the scopes rather than under "contributes", because it
 * is disclosure rather than decoration: a plugin that declares only hooks asks for
 * no scopes at all and still gets sent every session's title, agent, workspace and
 * every permission an agent raises. Listing it under contributions would put the
 * most surprising thing on the screen in the least surprising place.
 */
function ManifestConsent({ manifest }: { manifest: ManifestPreview }): ReactNode {
  const rows: { title: string; items: string[] }[] = [
    {
      title: "It may",
      // Read through `Record<string, string>` deliberately: the table is exhaustive
      // over `PluginScope` so that adding a scope is a compile error, but what
      // arrives here is whatever a manifest wrote. A scope this client has not
      // heard of falls through to its raw identifier — an undisclosed capability
      // is the one thing this screen exists to prevent.
      items: manifest.scopes.map((scope) => (PLUGIN_SCOPE_TEXT as Record<string, string>)[scope] ?? scope),
    },
    {
      title: "It is told when",
      items: manifest.hooks.map(
        (hook) =>
          ({
            "session.created": "a session starts",
            "turn.ended": "an agent finishes a turn",
            "session.ended": "a session ends",
            "permission.requested": "an agent asks for permission",
            "permission.resolved": "a permission is answered",
            // A hook this client has not heard of falls through to its identifier
            // rather than being dropped: an undisclosed hook is the one thing this
            // screen exists to prevent.
          })[hook] ?? hook,
      ),
    },
    { title: "It reaches", items: manifest.net },
    {
      title: "It adds",
      items: [
        ...(manifest.screen === null ? [] : [`a screen called ${manifest.screen}`]),
        ...(manifest.settings ? ["a settings pane"] : []),
        ...manifest.actions.map((action) =>
          action.on === "session" ? `"${action.title}" on a session's menu` : `"${action.title}" on its own screen`,
        ),
      ],
    },
  ];

  return (
    <div className="mt-3 rounded-lg border border-edge p-3">
      <p className="text-sm text-fg">
        {manifest.name || manifest.id || "This plugin"}{" "}
        <span className="text-muted">{manifest.version}</span>
      </p>
      {manifest.description !== null && <p className="mt-0.5 text-xs text-muted">{manifest.description}</p>}
      {rows
        .filter((row) => row.items.length > 0)
        .map((row) => (
          <div key={row.title} className="mt-2.5">
            <p className="text-xs text-muted">{row.title}</p>
            <ul className="mt-1 space-y-0.5">
              {row.items.map((item, index) => (
                <li key={`${row.title}-${index}`} className="text-xs text-fg">
                  · {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {manifest.scopes.length === 0 && manifest.hooks.length === 0 && (
        <p className="mt-2.5 text-xs text-muted">It asks for nothing and is told nothing.</p>
      )}
      <p className="mt-3 text-xs text-muted">
        Whatever it declares, a plugin runs on this machine as you, with your files — the same as an agent does. What is
        listed here is what it said it needs, not a fence around what it can do.
      </p>
    </div>
  );
}

function InstallPlugin({ machineId, onInstalled }: { machineId: MachineId; onInstalled: () => void }): ReactNode {
  const input = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<
    | { kind: "idle" }
    | { kind: "reading" }
    | { kind: "confirming"; file: File; peek: Awaited<ReturnType<typeof peekPluginArchive>> }
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

  const send = (file: File): void => {
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
        // The verb the daemon decided, not the one this screen guessed: `replaced`
        // is how a client learns whether it installed or updated, and guessing from
        // the list it fetched before sending would be wrong for a concurrent tab.
        toast(
          "ok",
          answer.replaced === null
            ? `Installed ${answer.plugin.name} ${answer.plugin.version}`
            : `Updated ${answer.plugin.name} to ${answer.plugin.version}`,
        );
        onInstalled();
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

      {phase.kind === "confirming" && phase.peek.kind === "ok" && <ManifestConsent manifest={phase.peek.manifest} />}
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
              send(phase.file);
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
          <DangerButton icon={Upload} onClick={() => send(phase.file)}>
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

/**
 * One plugin's own settings, drawn by the same renderer its screen uses.
 *
 * There is no second vocabulary for settings: a settings pane *is* a view, and a
 * plugin that wants a form returns one. That is what stops this subsystem growing
 * a config schema beside the drawing schema, which would be two ways to describe a
 * text field.
 */
export function PluginSettings({ machineId, pluginId }: { machineId: MachineId; pluginId: string }): ReactNode {
  /*
   * **No refresh timer here, deliberately, and the reason is the form.** A
   * settings pane is a thing somebody is typing into, and re-reading it under
   * them would either discard what they typed or keep it over a value the plugin
   * has since changed. `refreshMs` is honoured on the plugin's *screen*, which is
   * a thing you look at; a form is a thing you fill in.
   */
  const [view, setView] = useState<PluginViewShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setError("That machine is not reachable right now.");
      return;
    }
    setError(null);
    void daemon
      .pluginView(pluginId, "settings")
      .then((answer) => {
        if (!live) return;
        setView(answer.result.kind === "view" ? readView(answer.result.view) : { title: null, refreshMs: null, blocks: [] });
      })
      .catch((cause: unknown) => {
        if (live) setError(pluginFailure(cause));
      });
    return () => {
      live = false;
    };
  }, [machineId, pluginId]);

  const act = (actionId: string, context: { row?: string; form?: Record<string, string> }): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return;
    setBusy(true);
    void daemon
      .pluginAction(pluginId, actionId, context)
      .then((answer) => {
        if (answer.result.kind === "view") {
          setView(readView(answer.result.view));
          return;
        }
        toast(answer.result.tone === "danger" ? "error" : "ok", answer.result.text);
      })
      .catch((cause: unknown) => toast("error", pluginFailure(cause)))
      .finally(() => setBusy(false));
  };

  if (error !== null) return <Empty>{error}</Empty>;
  if (view === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }
  return (
    <div>
      <p className="mb-4 text-xs text-muted">
        <Puzzle size={12} className="mr-1 inline align-[-1px]" />
        Drawn by <code className="text-muted/80">{pluginId}</code> on this machine.{" "}
        <button type="button" className={`${LINK} tap`} onClick={() => navigate(settingsPath("machines", machineId))}>
          All plugins
        </button>
      </p>
      <PluginView view={view} busy={busy} onAction={act} />
    </div>
  );
}
