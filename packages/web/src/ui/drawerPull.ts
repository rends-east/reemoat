// The menu drawer pulled out by a finger from the list's first page, as Telegram's is (Q3.657). It is mounted for the gesture
// and becomes the drawer only if it opens, through the state the menu button sets, so the layer, inert and Back follow from that.

import { flushSync } from "react-dom";
import { fade, hold, holdFade, settleTransition, slide } from "./sheetDrag";
import { SHEET_MS } from "./sheetMotion";

interface Pulled {
  readonly panel: HTMLElement;
  readonly scrim: HTMLElement;
  readonly width: number;
}

let pulled = false;
const listeners = new Set<() => void>();
let nodes: Pulled | null = null;
let timer: number | null = null;
let opening = false;

export function subscribePull(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** True for the length of a pull: the drawer is mounted and drawn, and is not yet a layer. */
export function isPulled(): boolean {
  return pulled;
}

function announce(next: boolean): void {
  pulled = next;
  for (const listener of listeners) listener();
}

function finish(opened: boolean): void {
  timer = null;
  const now = nodes;
  nodes = null;
  if (opened && now !== null) {
    // Held, never cleared: reduced motion gives every property a 0.01ms transition whose first frame is the old value.
    for (const node of [now.panel, now.scrim]) {
      node.style.transition = "none";
      node.style.willChange = "";
    }
    now.panel.style.transform = "";
    now.scrim.style.opacity = "";
  }
  // Given back, it unmounts where it stands, closed.
  flushSync(() => announce(false));
}

/** A new pull lands the one still settling rather than grabbing it mid-flight. */
function land(): void {
  if (timer === null) return;
  window.clearTimeout(timer);
  finish(opening);
}

/** A drag on the opened drawer takes it mid-settle from where it is drawn, and the pull writes nothing more (Q3.660). */
export function yieldPull(): void {
  if (timer === null) return;
  window.clearTimeout(timer);
  timer = null;
  nodes = null;
  announce(false);
}

/** Mounts the drawer closed, under the finger, and answers its width; 0 where there is no drawer to pull. */
export function beginPull(): number {
  land();
  flushSync(() => announce(true));
  const panel = document.querySelector<HTMLElement>("[data-drawer-panel]");
  const scrim = document.querySelector<HTMLElement>("[data-drawer-scrim]");
  if (panel === null || scrim === null) {
    flushSync(() => announce(false));
    return 0;
  }
  // One read per gesture; `hold` also stops the arrival the mount started, so the finger decides where it is.
  const width = panel.offsetWidth;
  hold(panel, "left");
  slide(panel, "left", width);
  holdFade(scrim);
  fade(scrim, 0);
  nodes = { panel, scrim, width };
  return width;
}

/** Once a frame: the panel out by `progress` of its width, the scrim darkening with it. */
export function pullTo(progress: number): void {
  const now = nodes;
  if (now === null) return;
  const p = Math.min(1, Math.max(0, progress));
  slide(now.panel, "left", (1 - p) * now.width);
  fade(now.scrim, p);
}

/** Opens through `open`, the menu button's own path, or gives the drawer back; either way from where the finger let go. */
export function releasePull(opens: boolean, open: () => void): void {
  const now = nodes;
  if (now === null) return;
  now.panel.style.transition = settleTransition(["transform"]);
  now.scrim.style.transition = settleTransition(["opacity"]);
  pullTo(opens ? 1 : 0);
  opening = opens;
  if (opens) open();
  timer = window.setTimeout(() => finish(opens), SHEET_MS);
}
