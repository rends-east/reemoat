import { useEffect, useRef, useState } from "react";
import { BOARD_WATCH_MS } from "../../board";
import { boardAgentOf, supersededAgents, type AgentCopy, type BoardAgentFound } from "../../boardAgent";
import { meansRouteAbsent } from "../../http";
import { refOf, sessionId, type MachineId, type SessionRef } from "../../ids";
import { machinesAsDrawn, store, type AppState } from "../../store";
import type { SessionSnapshot } from "../../wire";
import type { Assigned } from "./Pickers";
import { useBoard } from "./useBoard";

const REMEMBERED_KEY = "reemoat.boardAgent";

interface Remembered {
  machineId: MachineId;
  createdAt: number;
}

export function recallBoardAgent(): Remembered | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(REMEMBERED_KEY) ?? "null") as Partial<Remembered> | null;
    return typeof raw?.machineId === "string" && typeof raw.createdAt === "number" ? { machineId: raw.machineId as MachineId, createdAt: raw.createdAt } : null;
  } catch {
    // Private mode, or a value this build cannot read: an offline config agent then reads as none.
    return null;
  }
}

function remember(found: BoardAgentFound): void {
  try {
    window.localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ machineId: found.machineId, createdAt: found.session.createdAt }));
  } catch {
    // Same: only the offline line is lost.
  }
}

export interface BoardAgentWatch {
  copies: AgentCopy[];
  found: BoardAgentFound | null;
  /** Every machine asked has answered once: before that a send could start a second agent that retires the real one. */
  settled: boolean;
  reload: () => void;
}

/** Every machine running the board asked for its config agent while Edit board is open, at the board's own pace; one replaced while it was away is retired once it answers. */
export function useBoardAgent(state: AppState): BoardAgentWatch {
  const { configured } = useBoard();
  const asked = machinesAsDrawn(state)
    .filter(({ machine }) => configured.has(machine.id) && machine.reach === "online")
    .map(({ machine }) => machine.id);
  const key = asked.join(",");
  const [copies, setCopies] = useState<AgentCopy[]>([]);
  const [answered, setAnswered] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const retired = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const read = (id: MachineId): Promise<AgentCopy> => {
      const daemon = store.daemonFor(id);
      if (daemon === undefined) return Promise.resolve({ machineId: id, kind: "unread" });
      return daemon.boardAgent().then(
        (answer): AgentCopy => ({ machineId: id, kind: "known", session: answer.session }),
        (cause: unknown): AgentCopy => ({ machineId: id, kind: meansRouteAbsent(cause) ? "absent" : "unread" }),
      );
    };
    const ask = (): void => {
      if (typeof document !== "undefined" && document.hidden) {
        timer = window.setTimeout(ask, BOARD_WATCH_MS);
        return;
      }
      void Promise.all(asked.map(read))
        .then((read) => {
          if (cancelled) return;
          setCopies(read);
          setAnswered(key);
          const found = boardAgentOf(read);
          if (found !== null) remember(found);
          for (const id of supersededAgents(read, found)) {
            const stale = read.find((one) => one.machineId === id);
            const mark = stale?.kind === "known" && stale.session !== null ? `${id}\u0000${stale.session.id}` : id;
            if (retired.current.has(mark)) continue;
            retired.current.add(mark);
            void store.daemonFor(id)?.retireBoardAgent().catch(() => retired.current.delete(mark));
          }
        })
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(ask, BOARD_WATCH_MS);
        });
    };
    ask();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [key, nonce]);
  return { copies, found: boardAgentOf(copies), settled: answered === key, reload: () => setNonce((n) => n + 1) };
}

export function refOfAgent(found: BoardAgentFound): SessionRef {
  return refOf(found.machineId, sessionId(found.session.id));
}

export function assignedOf(machineId: MachineId, session: SessionSnapshot): Assigned {
  return session.customAgent != null
    ? { machineId, kind: "custom", id: session.customAgent }
    : { machineId, kind: "harness", id: session.agent };
}

/**
 * Starts the config agent on the machine picked, `replace` retiring the one there (Q2.270); the one it replaces on another
 * machine goes now where it can, and one away is retired once its machine answers. Its row is in the store when this resolves.
 */
export async function startConfigAgent(who: Assigned, replace: boolean, found: BoardAgentFound | null): Promise<SessionRef> {
  const daemon = store.daemonFor(who.machineId);
  if (daemon === undefined) throw new Error("That machine is not connected right now.");
  const made = await daemon.startBoardAgent(
    who.kind === "custom" ? { agent: "", customAgent: who.id, replace } : { agent: who.id, replace },
  );
  if (found !== null && found.machineId !== who.machineId) void store.daemonFor(found.machineId)?.retireBoardAgent().catch(() => undefined);
  const ref = refOf(who.machineId, sessionId(made.session.id));
  store.applySnapshot(ref, made.session);
  return ref;
}
