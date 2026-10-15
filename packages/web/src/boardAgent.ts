/** The board's config agent as this client finds it: one session per account, drawn from Edit board alone (Q2.270, Q3.743). No DOM in the module body: webcheck imports it. */

import type { MachineId } from "./ids";
import type { SessionSnapshot } from "./wire";

/** Every list of conversations leaves it out, the replaced ones too; a purpose this build does not know is drawn as any session is. */
export function drawnInNoList(snapshot: Pick<SessionSnapshot, "purpose">): boolean {
  return snapshot.purpose === "board" || snapshot.purpose === "board_retired";
}

/** What one machine answered for GET /board/agent; `absent` is a daemon too old for the route. */
export type AgentCopy =
  | { machineId: MachineId; kind: "known"; session: SessionSnapshot | null }
  | { machineId: MachineId; kind: "absent" | "unread" };

export interface BoardAgentFound {
  machineId: MachineId;
  session: SessionSnapshot;
}

/** The newest config agent any machine answered with: a phone and a desktop find the same one with nothing stored between them. */
export function boardAgentOf(copies: readonly AgentCopy[]): BoardAgentFound | null {
  let best: BoardAgentFound | null = null;
  for (const copy of copies) {
    if (copy.kind !== "known" || copy.session === null || copy.session.purpose !== "board") continue;
    if (best === null || copy.session.createdAt > best.session.createdAt) best = { machineId: copy.machineId, session: copy.session };
  }
  return best;
}

/** Config agents older than the one found, each on its own machine: replaced while that machine was away, retired once it is back. */
export function supersededAgents(copies: readonly AgentCopy[], found: BoardAgentFound | null): MachineId[] {
  if (found === null) return [];
  return copies
    .filter((copy) => copy.kind === "known" && copy.session !== null && copy.machineId !== found.machineId && copy.session.purpose === "board")
    .map((copy) => copy.machineId);
}

/** Where a new one starts: this computer's machine, else the first that can, in the order the machines are drawn. */
export function boardAgentHome(local: MachineId | null, startable: readonly MachineId[]): MachineId | null {
  if (local !== null && startable.includes(local)) return local;
  return startable[0] ?? null;
}
