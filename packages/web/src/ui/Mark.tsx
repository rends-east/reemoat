import type { ReactNode } from "react";

/** Copied from `reemoat_landing/logo/` (the CSP refuses `data:`); the asymmetric bars are in the original. */
const BAR_WIDTH = 50;
const BAR_RADIUS = 16.43;
const VIEW_WIDTH = 170;
const VIEW_HEIGHT = 192;

const BARS = [
  { x: 0, y: 35.5, height: 121 },
  { x: 60, y: 0, height: 192 },
  { x: 120, y: 36, height: 120 },
] as const;

/** Written out: Tailwind emits only class names it finds literally in the source. */
const DELAY = ["", "[animation-delay:140ms]", "[animation-delay:280ms]"] as const;

export function Mark({ size = 20, className = "" }: { size?: number; className?: string }): ReactNode {
  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      height={size}
      width={Math.round((size * VIEW_WIDTH) / VIEW_HEIGHT)}
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      {BARS.map((bar) => (
        <rect key={bar.x} x={bar.x} y={bar.y} width={BAR_WIDTH} height={bar.height} rx={BAR_RADIUS} />
      ))}
    </svg>
  );
}

/** `still` draws the mark at rest where what it is about has stopped or can no longer be vouched for. */
export function WorkingMark({ still = false, size = 11 }: { still?: boolean; size?: number } = {}): ReactNode {
  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      height={size}
      width={Math.round((size * VIEW_WIDTH) / VIEW_HEIGHT)}
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      {BARS.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width={BAR_WIDTH}
          height={bar.height}
          rx={BAR_RADIUS}
          className={still ? undefined : `animate-bar ${DELAY[index] ?? ""}`}
        />
      ))}
    </svg>
  );
}
