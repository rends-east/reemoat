import { Split } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { defaultRow, orderStrip } from "../../agentStrip";
import { offersStripTile, startableHere } from "../../agents";
import {
  DISPATCH_NICKNAME,
  dispatchHome,
  dispatchMachine,
  dispatchSession,
  dispatchVersion,
  subscribeDispatch,
} from "../../dispatch";
import { errorText } from "../../http";
import { refOf, sessionId, type MachineId, type SessionKey, type SessionRef } from "../../ids";
import { navigate, sessionPath } from "../../router";
import { store, type AppState, type SessionRow } from "../../store";
import { needsHuman, showsAsEnded } from "../../wire";
import { Icon, Spinner, StatusDot } from "../bits";
import { toast } from "../Toast";

/** The dispatcher among the sessions this client sees, and where one would be started if there is none. */
export function useDispatch(state: AppState): { row: SessionRow | null; home: MachineId | null } {
  useSyncExternalStore(subscribeDispatch, dispatchVersion);
  const chosen = dispatchMachine();
  const row = dispatchSession(
    state.sessions.map((one) => ({
      ref: one.ref,
      nickname: one.snapshot.nickname,
      ended: showsAsEnded(one.snapshot),
      createdAt: one.snapshot.createdAt,
      row: one,
    })),
    chosen,
  );
  const startable = state.machines
    .filter((machine) => machine.reach === "online" && machine.scopes.includes("session:write"))
    .map((machine) => machine.id);
  return { row: row?.row ?? null, home: dispatchHome(chosen, state.localMachineId, startable) };
}

/**
 * Starts the dispatcher as New session would start anything: the machine's own default agent, in its first folder, under the
 * nickname that makes it one. Named, and never pinned: no list of conversations draws it (Q3.724).
 */
export async function startDispatcher(machineId: MachineId): Promise<SessionRef> {
  const daemon = store.daemonFor(machineId);
  if (daemon === undefined) throw new Error("That machine is not connected right now.");
  const [agents, presets, strip, roots] = await Promise.all([
    daemon.agents(),
    // A daemon older than assembled agents still starts a built-in one.
    daemon.customAgents().catch(() => ({ customAgents: [] })),
    daemon.agentStrip().catch(() => ({ entries: [] })),
    daemon.roots(),
  ]);
  const rows = orderStrip(
    [
      ...agents.agents.filter(offersStripTile).map((one) => ({ kind: "harness" as const, id: one.id })),
      ...presets.customAgents.map((one) => ({ kind: "custom" as const, id: one.id })),
    ],
    strip.entries,
  );
  const pick = defaultRow(rows, (row) => startableHere(row, agents.agents, presets.customAgents));
  if (pick === null) throw new Error("No agent on that machine is ready to start. Set one up in its Agents settings first.");
  const cwd = roots.roots[0];
  if (cwd === undefined) throw new Error("That machine offers no folder to start in.");
  const made = await daemon.createSession(
    pick.kind === "custom"
      ? { agent: "", customAgent: pick.id, cwd, nickname: DISPATCH_NICKNAME }
      : { agent: pick.id, cwd, nickname: DISPATCH_NICKNAME },
  );
  const ref = refOf(machineId, sessionId(made.session.id));
  store.applySnapshot(ref, made.session);
  // Named before its first message would name it after whatever was asked first.
  store.setSessionMeta(ref, { title: "Dispatch" }, (text) => toast("error", text));
  return ref;
}

/** Opens the dispatcher, starting it first where there is none; resolves either way, a refusal toasted. */
export function openDispatcher(row: SessionRow | null, home: MachineId | null): Promise<void> {
  if (row !== null) {
    navigate(sessionPath(row.ref));
    return Promise.resolve();
  }
  if (home === null) {
    toast("error", "No machine can start the dispatcher right now.");
    return Promise.resolve();
  }
  return startDispatcher(home)
    .then((ref) => navigate(sessionPath(ref)))
    .catch((cause: unknown) => toast("error", errorText(cause)));
}

/** The dispatcher's row at the head of the board's list: its conversation, or the one press that starts it. */
export function DispatchRow({ state, active }: { state: AppState; active: SessionKey | null }): ReactNode {
  const { row, home } = useDispatch(state);
  const [busy, setBusy] = useState(false);
  // Nothing to draw where no dispatcher is and none could start.
  if (row === null && home === null) return null;
  const selected = row !== null && row.key === active;
  const open = (): void => {
    if (busy) return;
    setBusy(true);
    void openDispatcher(row, home).finally(() => setBusy(false));
  };
  return (
    <div className={`flex items-center border-b border-edge ${selected ? "bg-raised" : "hover:bg-raised/50"}`}>
      <button
        type="button"
        onClick={open}
        disabled={busy}
        aria-current={selected ? "page" : undefined}
        className="tap flex min-w-0 flex-1 items-center gap-2.5 py-3 pr-3 pl-3 text-left lg:py-2.5"
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-raised text-fg">
          {busy ? <Spinner /> : <Icon as={Split} size={14} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {row !== null && <StatusDot session={row.snapshot} />}
            <span className={`min-w-0 truncate text-sm ${row !== null && needsHuman(row.snapshot) ? "font-semibold" : ""}`}>Dispatch</span>
          </span>
          <span className="mt-0.5 block truncate text-2xs text-muted">
            {busy ? "Starting…" : row === null ? "Start it to turn what you describe into tasks" : "Describe work; it proposes the tasks"}
          </span>
        </span>
      </button>
    </div>
  );
}
