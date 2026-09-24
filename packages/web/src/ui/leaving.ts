import { useEffect, useRef, useState, type AnimationEvent } from "react";

// Keeps a closed layer mounted until its exit animation ends. Callers pass `shown`, never `open`, to the mount guard and
// `useDismissible`, and every visible variant owes its own outgoing keyframe, or the exit falls to the backstop.

/** Derived during render, never in an effect, which would paint a frame with no panel; `backstopMs` is a ceiling, not the wait. */
export function useLeaving(
  open: boolean,
  backstopMs: number,
): {
  /** The element's real lifetime: `open`, plus the exit. Mount guard and layer. */
  shown: boolean;
  leaving: boolean;
  onAnimationEnd: (event: AnimationEvent<HTMLElement>) => void;
} {
  const [leaving, setLeaving] = useState(false);
  const wasOpen = useRef(false);
  if (open !== wasOpen.current) {
    wasOpen.current = open;
    // Only a close begins an exit; an open cancels one that is in flight.
    setLeaving(!open);
  }
  // The backstop for an `animationend` that never arrives, which would otherwise leave the layer up for ever.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(false), backstopMs);
    return () => window.clearTimeout(timer);
  }, [leaving, backstopMs]);

  // Target check rather than a keyframe name: the event bubbles up from animating children.
  const onAnimationEnd = (event: AnimationEvent<HTMLElement>): void => {
    if (!leaving || event.target !== event.currentTarget) return;
    setLeaving(false);
  };

  return { shown: open || leaving, leaving, onAnimationEnd };
}
