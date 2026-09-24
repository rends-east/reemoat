import { useEffect, useRef } from "react";
import { isBareKey, isTypingInto } from "../keys";

// Keep the window listener inside `push`: webcheck imports this file with only a stubbed `window`.

export type LayerKind = "ask" | "menu" | "sheet";

export interface Layer {
  readonly id: number;
  readonly kind: LayerKind;
}

export function escapeAction(
  layers: readonly Layer[],
  typing: boolean,
): { dismiss: number | null; stop: boolean } {
  if (typing) return { dismiss: null, stop: false };
  const top = layers.at(-1);
  if (top === undefined) return { dismiss: null, stop: false };
  return { dismiss: top.id, stop: true };
}

/** Only a `sheet` blocks: `inert` does not stop a window keydown, and `j`/`k` stay live under a menu or ask. */
export function shortcutsEnabled(layers: readonly Layer[]): boolean {
  return !layers.some((layer) => layer.kind === "sheet");
}

/** Blocks on anything but the card's own `ask`; not an empty stack, since an open card is itself a layer. */
export function decisionShortcutsEnabled(layers: readonly Layer[]): boolean {
  return !layers.some((layer) => layer.kind !== "ask");
}

/** Whole-segment match; must list every route `isSheet` in `nav.ts` holds. */
export function isOverlayPath(pathname: string): boolean {
  const first = pathname.split("/")[1] ?? "";
  return (
    first === "settings" ||
    first === "new" ||
    first === "agent" ||
    first === "p" ||
    first === "plugins"
  );
}

/** Full class strings because Tailwind cannot see built ones. `AskCard` stays out of this table and has no z-index. */
export const LAYER = {
  header: "z-30",
  menu: "z-40",
  overlay: "z-50",
  // Must outrank the sheet: settings report failures through toasts.
  toast: "z-60",
} as const;

export function layerRank(name: keyof typeof LAYER): number {
  return Number(LAYER[name].slice("z-".length));
}

interface Entry {
  readonly layer: Layer;
  readonly onDismiss: () => void;
}

let entries: Entry[] = [];
let published: readonly Layer[] = [];
let nextId = 1;
let listening = false;

export function currentLayers(): readonly Layer[] {
  return published;
}

function republish(): void {
  published = entries.map((entry) => entry.layer);
}

// Refcounted over sheets only, so an inner sheet closing does not clear it; `inert` is also the focus trap.
function syncInert(): void {
  const root = document.getElementById("root");
  if (root === null) return;
  const covering = entries.some((entry) => entry.layer.kind === "sheet");
  if (covering) root.setAttribute("inert", "");
  else root.removeAttribute("inert");
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !isBareKey(event)) return;
  const action = escapeAction(published, isTypingInto(event.target));
  if (action.dismiss === null) return;
  const entry = entries.find((candidate) => candidate.layer.id === action.dismiss);
  if (action.stop) {
    event.stopPropagation();
    event.preventDefault();
  }
  entry?.onDismiss();
}

function push(kind: LayerKind, onDismiss: () => void): number {
  const id = nextId++;
  entries = [...entries, { layer: { id, kind }, onDismiss }];
  republish();
  if (!listening) {
    window.addEventListener("keydown", onKeyDown, true);
    listening = true;
  }
  syncInert();
  return id;
}

function pop(id: number): void {
  entries = entries.filter((entry) => entry.layer.id !== id);
  republish();
  if (entries.length === 0 && listening) {
    window.removeEventListener("keydown", onKeyDown, true);
    listening = false;
  }
  syncInert();
}

/** The callback is held in a ref, so a handler rebuilt every render does not re-push to the top of the stack. */
export function useDismissible(kind: LayerKind, onDismiss: () => void, active: boolean): void {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const id = push(kind, () => latest.current());
    return () => pop(id);
  }, [kind, active]);
}
