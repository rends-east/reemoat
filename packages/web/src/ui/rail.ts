import { createPaneWidth } from "./paneWidth";

// The rail's instance of `paneWidth.ts`; webcheck drives the four exported names directly.

/** Each bound is the machine column plus the list's own width, which webcheck asserts by subtraction. Device pixels, not rem. */
export const MACHINE_COLUMN_PX = 72;
export const RAIL_MIN = MACHINE_COLUMN_PX + 240;
export const RAIL_MAX = MACHINE_COLUMN_PX + 480;
export const RAIL_DEFAULT = MACHINE_COLUMN_PX + 312;

// The rail has one width at every size, so unset and default coincide and `railWidth` never answers null.
const rail = createPaneWidth({
  key: "reemoat.railWidth",
  min: RAIL_MIN,
  max: RAIL_MAX,
  unset: RAIL_DEFAULT,
  fallback: RAIL_DEFAULT,
  prop: "--rail-w",
});

export { rail };

export const clampRailWidth = rail.clamp;

export function railWidth(): number {
  return rail.width() ?? RAIL_DEFAULT;
}

export const setRailWidth = rail.setWidth;
export const subscribeRail = rail.subscribe;
