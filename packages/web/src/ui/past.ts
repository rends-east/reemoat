import { useEffect, useState } from "react";
import { monotonicNow } from "../wake";

/** Whether `since`, on the monotonic clock, is at least `afterMs` old; renders once more at the crossing. */
export function usePast(since: number | null, afterMs: number): boolean {
  // The `since` whose wait a timer has already seen out, so a timer that fires a hair early still counts.
  const [crossed, setCrossed] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    const wait = since + afterMs - monotonicNow();
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setCrossed(since), wait);
    return () => window.clearTimeout(timer);
  }, [since, afterMs]);
  return since !== null && (crossed === since || monotonicNow() - since >= afterMs);
}
