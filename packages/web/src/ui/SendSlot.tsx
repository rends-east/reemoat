import { ArrowUp, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { IconButton, Spinner } from "./bits";
import {
  exitEnded,
  refocusBox,
  SLOT_ORDER,
  slotHolding,
  SWAP_MS,
  swapTo,
  type SlotOccupant,
} from "./slotSwap";

const STOPPING = "Stopping — the agent has not finished yet";

/** Send, Stop and the two spinners in one 32px slot: a swap fades the old one out under the new one (Q3.654). */
export function SendSlot({
  occupant,
  scope,
  sendLabel,
  sendEnabled,
  onStop,
  box,
}: {
  occupant: SlotOccupant;
  /** The session: another one's slot is jumped to, never animated into. */
  scope: string;
  sendLabel: string;
  sendEnabled: boolean;
  onStop: () => void;
  box: RefObject<HTMLTextAreaElement | null>;
}): ReactNode {
  const [held, setHeld] = useState(() => ({ slot: slotHolding(occupant), scope }));
  const here = useRef<HTMLDivElement | null>(null);
  // Send leaves drawn as it last was: the draft that took it away has usually disabled it by then.
  const look = useRef({ enabled: sendEnabled, label: sendLabel });
  const leftAs = useRef(look.current);

  // Before paint, so no frame draws the old occupant live; the focus is read while the old DOM still holds it.
  useLayoutEffect(() => {
    if (occupant === held.slot.shown && scope === held.scope) return;
    const still = scope !== held.scope || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (refocusBox(here.current?.contains(document.activeElement) ?? false, window.matchMedia("(pointer: coarse)").matches)) {
      box.current?.focus({ preventScroll: true });
    }
    if (held.slot.shown === "send") leftAs.current = look.current;
    setHeld({ slot: swapTo(held.slot, occupant, !still), scope });
  });
  // After the swap above, so it read the look of the render before this one.
  useLayoutEffect(() => {
    look.current = { enabled: sendEnabled, label: sendLabel };
  });

  // The backstop for a transitionend that never arrives.
  const fading = held.slot.leaving.length > 0;
  useEffect(() => {
    if (!fading) return;
    const timer = window.setTimeout(() => setHeld((h) => ({ ...h, slot: { ...h.slot, leaving: [] } })), SWAP_MS * 2);
    return () => window.clearTimeout(timer);
  }, [fading, held.slot.swap]);

  const draw = (one: SlotOccupant, live: boolean): ReactNode => {
    switch (one) {
      case "sending":
        return (
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-fg text-ink">
            <Spinner />
          </span>
        );
      case "stopping":
        // A spinner rather than a disabled Stop, which could show no title; it yields to a sendable draft.
        return (
          <span
            role="status"
            aria-label={STOPPING}
            title={STOPPING}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-edge-strong bg-surface text-fg"
          >
            <Spinner />
          </span>
        );
      case "stop":
        return (
          <IconButton
            icon={Square}
            label="Stop the agent"
            tone="plain"
            size="chip"
            shape="round"
            type="button"
            onClick={live ? onStop : undefined}
          />
        );
      case "send": {
        const shown = live ? { enabled: sendEnabled, label: sendLabel } : leftAs.current;
        return (
          <IconButton
            icon={ArrowUp}
            label={shown.label}
            tone="primary"
            size="chip"
            shape="round"
            // A leaving Send must not stay the form's default button.
            type={live ? "submit" : "button"}
            disabled={!shown.enabled}
          />
        );
      }
    }
  };

  const { shown, leaving } = held.slot;
  return (
    <div ref={here} className="grid h-8 w-8 shrink-0 place-items-center">
      {SLOT_ORDER.map((one) => {
        if (one === shown) {
          // On top, and only its opacity moves: a tap during the swap lands here at full size.
          return (
            <div key={one} className={`z-1 col-start-1 row-start-1 ${fading ? "swap-in" : ""}`}>
              {draw(one, true)}
            </div>
          );
        }
        const out = leaving.find((l) => l.occupant === one);
        if (out === undefined) return null;
        return (
          <div
            key={one}
            inert
            aria-hidden="true"
            className="swap-out pointer-events-none col-start-1 row-start-1"
            onTransitionEnd={(event) => {
              if (event.target !== event.currentTarget || event.propertyName !== "opacity") return;
              setHeld((h) => ({ ...h, slot: exitEnded(h.slot, out.swap) }));
            }}
          >
            {draw(one, false)}
          </div>
        );
      })}
    </div>
  );
}
