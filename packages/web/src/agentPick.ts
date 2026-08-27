import type { MachineId } from "./ids";
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
