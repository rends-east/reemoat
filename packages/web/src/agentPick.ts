import type { MachineId } from "./ids";
import type { Picked } from "./ui/NewSession";
import type { CustomAgent } from "./wire";

/*
 * The agent somebody just assembled, held until the strip can draw it — and the
 * one they just removed, held for the same reason and taken the same way.
 *
 * ⚠ **A module variable rather than a prop or a route segment, and each of the
 * three was considered.** The builder is a *route* away from the strip, so there
 * is no parent to report to — `NewSession` is unmounted while it is open. A route
 * segment would work and was rejected: it would put a transient hand-off into
 * every New session address, where a reload or a shared link would re-select
 * something for a reason nobody could see.
 *
 * This is `echo.ts`'s shape, one step smaller — the same argument for the same
 * kind of value: something that has to survive an unmount, is read once, and has
 * no business waking the session list.
 *
 * ⚠ **Taken rather than read.** A hand-off consumed twice would re-select an
 * agent the second time somebody opened New session, long after they had chosen
 * something else.
 *
 * ⚠ **A removal travels the same way, and the argument above holds unchanged for
 * it.** `StartSheet` holds which tile is chosen across the whole of `/agent`, so
 * removing the tile that is *currently selected* left the selection naming a row
 * the daemon had just dropped: no tile drew as selected, the Edit affordance went
 * with it, `Start` stayed enabled, and pressing it answered 404 on an id that no
 * longer exists. There is still nobody to report to — same unmount — and a route
 * segment is still worse here than it is for a pick: a removal that already
 * happened, carried in the address, would clear a selection somebody had since
 * made again on the next reload. And it is **taken**, or a hand-off consumed
 * twice clears a choice long after the removal that produced it.
 *
 * Two maps rather than one union, because the two are answered by different
 * things at the other end — one replaces the listing, one only clears a
 * selection — and a machine can honestly hold both at once: remove one agent,
 * assemble another, and the strip has to hear about each.
 */
const pending = new Map<MachineId, CustomAgent>();
const removed = new Map<MachineId, string>();

export function rememberPick(machine: MachineId, agent: CustomAgent): void {
  pending.set(machine, agent);
}

/** The agent assembled since this machine's strip was last drawn, once. */
export function takePick(machine: MachineId): CustomAgent | null {
  const held = pending.get(machine) ?? null;
  pending.delete(machine);
  return held;
}

export function rememberRemoval(machine: MachineId, agentId: string): void {
  removed.set(machine, agentId);
}

/** The agent removed since this machine's strip was last drawn, once. */
export function takeRemoval(machine: MachineId): string | null {
  const held = removed.get(machine) ?? null;
  removed.delete(machine);
  return held;
}

/**
 * Which tile is chosen, per machine — and this one is **read**, not taken.
 *
 * ⚠ **The discipline is the opposite of the two maps above, and that is because
 * this is not a hand-off.** Those carry an event that happened once — an agent was
 * assembled, an agent was removed — and consuming one twice would re-apply it long
 * after the fact. This carries a *standing* choice: the tile somebody tapped, which
 * stays true until they tap another. Taking it would clear the selection the first
 * time anything read it.
 *
 * ⚠ **It exists because a pop-up can now leave for another pop-up.** `StartSheet`
 * holds the per-machine choice in React state and is mounted for `/new` and
 * `/agent` — which was the whole set, until the strip's gear started opening
 * `/settings/machines/:id/agents`. Walking there unmounts `StartSheet`, so coming
 * back re-defaulted the strip to whatever the listing suggests, which is exactly
 * the "a stale choice indistinguishable from a fresh default" failure `NewSession`
 * already records against holding one value for both. The folder survives that walk
 * because it is in the address; the tile cannot go there — `/new/:machineId/:cwd`
 * puts an `encodeURIComponent`'d path last on purpose, and a fourth segment in
 * front of it would be a second thing to disambiguate.
 *
 * It is deliberately **not** persisted: this is a tab's working state, not a
 * setting, and a choice restored from `localStorage` a week later is a claim the
 * machine may no longer honour. `offeredHere` weighs it against the live listing on
 * every render anyway, which is what makes a stale entry here cost nothing.
 */
const chosen = new Map<MachineId, Picked>();

export function keepPick(machine: MachineId, picked: Picked): void {
  chosen.set(machine, picked);
}

/** The tile chosen on this machine, as many times as anybody asks. */
export function heldPick(machine: MachineId): Picked | null {
  return chosen.get(machine) ?? null;
}

/**
 * Drop it, for the one caller that clears a choice rather than making one.
 *
 * Removing the agent a tile stood for clears the selection, and this map has to
 * hear about it or the next mount would restore a pick naming a row the daemon
 * dropped — the exact state `rememberRemoval` above exists to prevent one mount
 * earlier. `offeredHere` would refuse to draw it anyway; this keeps the two
 * answers from disagreeing.
 */
export function forgetPick(machine: MachineId): void {
  chosen.delete(machine);
}
