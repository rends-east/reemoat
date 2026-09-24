import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MACHINE_GONE, pluginDestination, pluginFailure, pluginPath, readView } from "../plugins";
import { refOf, sessionId, type MachineId } from "../ids";
import { navigate, sessionPath } from "../router";
import { store } from "../store";
import type { PluginOpen, PluginView as PluginViewShape } from "../wire";
import { Button, Empty, Spinner } from "./bits";
import { PluginView } from "./PluginView";
import { toast } from "./Toast";

/** A plugin's route-backed screen; nothing is drawn before the plugin answers, and no action is applied locally. */
export function PluginScreen({
  machineId,
  pluginId,
  onTitle,
}: {
  machineId: MachineId;
  pluginId: string;
  onTitle: (title: string) => void;
}): ReactNode {
  const [view, setView] = useState<PluginViewShape | null>(null);
  const [error, setError] = useState<{ text: string; failed: boolean } | null>(null);
  const [spoke, setSpoke] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  // A read a person asked for, kept apart from round: round === 0 means nothing is on screen yet, and the clock moves round.
  const [attempt, setAttempt] = useState(0);
  const refreshMs = view?.refreshMs ?? null;
  const liveRoute = useRef(pluginPath(machineId, pluginId));
  const reading = useRef(0);
  const askedFor = useRef(0);

  useEffect(() => {
    if (refreshMs === null) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      // Drop, never queue, a tick while a read is out: a slow plugin would pile up reads until plugin_overloaded.
      if (reading.current > 0) return;
      setRound((held) => held + 1);
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  useEffect(() => {
    let live = true;
    const asked = attempt !== askedFor.current;
    askedFor.current = attempt;
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setView(null);
      setError({ text: MACHINE_GONE, failed: false });
      return;
    }
    // Cleared on a switch, never on a refresh or a press, so a refreshing board does not flash.
    if (round === 0) setView(null);
    setError(null);
    reading.current += 1;
    void daemon
      .pluginView(pluginId, "screen")
      .then((answer) => {
        if (!live) return;
        if (answer.result.kind === "view") {
          setSpoke(null);
          setView(readView(answer.result.view));
          return;
        }
        // The blocks go but refreshMs and the title stay: nulling refreshMs stopped the poll for the rest of the mount.
        setSpoke(answer.result.text);
        setView((held) => ({ title: held?.title ?? null, refreshMs: held?.refreshMs ?? null, blocks: [] }));
      })
      .catch((cause: unknown) => {
        if (live && (round === 0 || asked)) setError({ text: pluginFailure(cause), failed: true });
      })
      .finally(() => {
        // Counted, not a flag: a plugin switch has two reads in flight at once.
        reading.current -= 1;
      });
    return () => {
      live = false;
    };
  }, [machineId, pluginId, round, attempt]);

  useEffect(() => {
    liveRoute.current = pluginPath(machineId, pluginId);
    setRound(0);
    setBusy(false);
    setSpoke(null);
  }, [machineId, pluginId]);

  // Hoisted: PluginView's memos compare these callbacks by identity, so the deps must stay exactly the route.
  const act = useCallback((actionId: string, context: { row?: string; form?: Record<string, string> }): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      toast("error", MACHINE_GONE);
      return;
    }
    // Captured before the await: action ids overlap across plugins, so a late answer must not reach another plugin's board.
    const issuedFor = pluginPath(machineId, pluginId);
    setBusy(true);
    void daemon
      .pluginAction(pluginId, actionId, context)
      .then((answer) => {
        if (liveRoute.current !== issuedFor) return;
        if (answer.result.kind === "view") {
          setView(readView(answer.result.view));
          return;
        }
        toast(answer.result.tone === "danger" ? "error" : "ok", answer.result.text);
      })
      .catch((cause: unknown) => {
        if (liveRoute.current === issuedFor) toast("error", pluginFailure(cause));
      })
      .finally(() => {
        if (liveRoute.current === issuedFor) setBusy(false);
      });
  }, [machineId, pluginId]);

  // Resolved against this machine only: a plugin names a session id, never a URL or a machine.
  const go = useCallback(
    (where: PluginOpen): void => {
      const target = pluginDestination(where);
      if (target === null) return;
      if (target.kind === "screen") {
        navigate(pluginPath(machineId, pluginId), true);
        return;
      }
      navigate(sessionPath(refOf(machineId, sessionId(target.sessionId))));
    },
    [machineId, pluginId],
  );

  // Reported up: OverlaySheet owns the head, and this is the one pop-up whose name is not a constant (Q3.484).
  useEffect(() => {
    onTitle(view?.title ?? pluginId);
  }, [onTitle, view?.title, pluginId]);

  return error !== null ? (
    <Empty
      failed={error.failed}
      action={
        <Button size="sm" onClick={() => setAttempt((held) => held + 1)}>
          Try again
        </Button>
      }
    >
      {error.text}
    </Empty>
  ) : view === null ? (
    <div className="flex justify-center py-8">
      <Spinner />
    </div>
  ) : spoke !== null ? (
    <Empty
      action={
        <Button size="sm" onClick={() => setAttempt((held) => held + 1)}>
          Try again
        </Button>
      }
    >
      {spoke.length === 0
        ? "That plugin answered with a message rather than a screen."
        : `That plugin answered with a message rather than a screen — ${spoke}`}
    </Empty>
  ) : (
    <PluginView view={view} busy={busy} onAction={act} onOpen={go} />
  );
}
