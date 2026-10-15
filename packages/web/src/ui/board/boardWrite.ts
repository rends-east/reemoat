import { parseBoard } from "@reemoat/board";
import { board as boardStore } from "../../boardStore";
import { saveOutcome, savePlan, type SaveOutcome } from "../../boardSave";
import type { MachineId } from "../../ids";
import { machinesAsDrawn, store, type AppState } from "../../store";

// Its own module, with nothing of the router's behind it: the transcript's board card writes through it too.

export interface WriteResult {
  id: MachineId;
  name: string;
  outcome: SaveOutcome;
}

/** Every machine running the board, as Save weighs them: which are written and which are skipped, and why. */
export function planFor(state: AppState, read: ReadonlySet<MachineId>, configured: ReadonlyMap<MachineId, { revision: number }>) {
  return savePlan(
    machinesAsDrawn(state).map(({ machine, name }) => ({
      id: machine.id,
      name,
      reach: machine.reach,
      writable: machine.scopes.includes("session:write"),
      read: read.has(machine.id),
    })),
    configured,
  );
}

/** One machine written against the revision it was read at; its copy is taken into the board at once and read again. */
export async function writeOne(target: { id: MachineId; name: string; revision: number }, text: string): Promise<WriteResult> {
  const daemon = store.daemonFor(target.id);
  if (daemon === undefined) return { id: target.id, name: target.name, outcome: { kind: "skipped", why: "unreachable" } };
  const outcome = await daemon.putBoard(text, target.revision).then(
    (written) => {
      const read = parseBoard(written.text);
      if (read.ok) boardStore.applyBoard(target.id, { revision: written.revision, hash: written.hash, text: written.text, board: read.board });
      boardStore.refresh(target.id);
      return saveOutcome({ ok: true, written });
    },
    (cause: unknown) => saveOutcome({ ok: false, cause }),
  );
  return { id: target.id, name: target.name, outcome };
}

/** Save's whole write: every target at once, then every machine skipped, in the order they are drawn. */
export async function writeEverywhere(plan: ReturnType<typeof savePlan>, text: string): Promise<WriteResult[]> {
  const written = await Promise.all(plan.targets.map((target) => writeOne(target, text)));
  const skipped: WriteResult[] = plan.skipped.map((one) => ({ id: one.id, name: one.name, outcome: { kind: "skipped", why: one.why } }));
  return [...written, ...skipped];
}
