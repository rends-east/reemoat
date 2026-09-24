// The composer's send slot: one live occupant, and whatever it replaced fading out beneath it (Q3.654).
// Holds no DOM and imports nothing, so webcheck drives it; SendSlot.tsx is the impure shell.

export type SlotOccupant = "send" | "stop" | "sending" | "stopping";

/** The fixed DOM order of the layers: a moved node restarts its transition, so paint order is a z-index instead. */
export const SLOT_ORDER: readonly SlotOccupant[] = ["send", "stop", "sending", "stopping"];

/** `rise`'s clock, and index.css's `.swap-in` and `.swap-out`; webcheck asserts all of them agree. */
export const SWAP_MS = 140;

export interface Leaving {
  readonly occupant: SlotOccupant;
  /** The swap that sent it out, so only its own exit can clear it. */
  readonly swap: number;
}

export interface SlotState {
  readonly shown: SlotOccupant;
  /** Inert, aria-hidden and fading; never `shown`, never twice. */
  readonly leaving: readonly Leaving[];
  readonly swap: number;
}

export function slotOccupant(state: {
  sending: boolean;
  stopping: boolean;
  sends: boolean;
  stoppable: boolean;
}): SlotOccupant {
  if (state.sending) return "sending";
  // A sendable draft outranks the stopping spinner.
  if (state.stopping && !state.sends) return "stopping";
  return state.stoppable ? "stop" : "send";
}

export function slotHolding(occupant: SlotOccupant): SlotState {
  return { shown: occupant, leaving: [], swap: 0 };
}

/** `animate` false jumps and leaves nothing fading: reduced motion, or the slot of another session. */
export function swapTo(state: SlotState, occupant: SlotOccupant, animate: boolean): SlotState {
  if (occupant === state.shown && (animate || state.leaving.length === 0)) return state;
  const swap = state.swap + 1;
  if (!animate) return { shown: occupant, leaving: [], swap };
  // Called back mid-exit, it is taken out of the leaving list rather than drawn twice.
  const leaving = [...state.leaving.filter((one) => one.occupant !== occupant), { occupant: state.shown, swap }];
  return { shown: occupant, leaving, swap };
}

export function exitEnded(state: SlotState, swap: number): SlotState {
  const leaving = state.leaving.filter((one) => one.swap !== swap);
  return leaving.length === state.leaving.length ? state : { ...state, leaving };
}

/** Taking the focused control away hands focus to the message box, on a desktop only; never to the control arriving. */
export function refocusBox(focusInSlot: boolean, pointerCoarse: boolean): boolean {
  return focusInSlot && !pointerCoarse;
}
