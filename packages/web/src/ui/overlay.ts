import { useEffect, useRef } from "react";
import { isBareKey, isTypingInto } from "../keys";

/**
 * Who owns Escape, and what paints above what.
 *
 * Two questions that were previously answered in six files by six components each
 * believing it was the only one listening. There were five `window` bindings for
 * Escape — `AskCard` in the capture phase, `Dropdown` and `SessionMenu` in the
 * bubble phase, `keyboard.ts` on `window`, `Composer`'s menu on the textarea —
 * with no arbitration between them beyond the order they happened to be mounted
 * in. That worked while nothing overlapped. It stops working the moment a sheet
 * can open over a session that has a parked question under it.
 *
 * **The pure half is the point.** `escapeAction`, `shortcutsEnabled`,
 * `isOverlayPath` and `layerRank` decide everything and touch nothing, so
 * `webcheck` — which has no DOM — asserts the rules rather than a transcription of
 * them. `useDismissible` is the impure shell around them.
 *
 * ⚠ **`window.addEventListener` lives inside `push()` and must never move to the
 * module body.** `webcheck` imports this file, and it stubs `window.location` and
 * `window.localStorage` and nothing else — so a listener installed at import time
 * throws before a single case runs, and the whole file silently stops being
 * asserted. `settings.ts` says the same thing about itself and for the same
 * reason; that is why neither of them may import `router.ts`.
 */

export type LayerKind = "ask" | "menu" | "sheet";

export interface Layer {
  readonly id: number;
  readonly kind: LayerKind;
}

/**
 * What Escape means right now.
 *
 * Two rules, and that is the whole arbitration:
 *
 * 1. **Typing beats everything.** Escape inside the composer belongs to the
 *    command menu, inside `AskCard`'s "Other" box to the box, inside
 *    `RenameField` to the rename, inside `DirectoryPicker`'s new-folder input to
 *    that form. All four already behaved this way, each defended by its own
 *    comment; here it is one rule they are consequences of.
 * 2. **Otherwise the most recently opened layer owns it**, and stops propagation
 *    so nothing below acts on the same keystroke.
 *
 * `stop === (dismiss !== null)` always, and `webcheck` asserts that over every
 * generated stack — because the failure this replaces was precisely a component
 * that stopped propagation *before* deciding whether it was going to act, which
 * ended the dispatch for everybody and cancelled an agent's tool call while
 * leaving the menu the reader was actually trying to close wide open.
 */
export function escapeAction(
  layers: readonly Layer[],
  typing: boolean,
): { dismiss: number | null; stop: boolean } {
  if (typing) return { dismiss: null, stop: false };
  const top = layers.at(-1);
  if (top === undefined) return { dismiss: null, stop: false };
  return { dismiss: top.id, stop: true };
}

/**
 * Whether `keyboard.ts`'s bare-letter shortcuts may fire.
 *
 * `inert` on `#root` stops taps and focus reaching the app behind a sheet, and it
 * does **not** stop a `window` keydown — so without this, `j` and `k` navigate the
 * session list behind an open settings sheet, changing what is underneath while
 * you cannot see it.
 *
 * Only `sheet` blocks. A `menu` deliberately does not, which is a documented
 * non-change rather than an oversight: a bare `j` while a `Dropdown` is open
 * navigates today, that has never been reported as wrong, and this layer is not
 * the place to decide it. An `ask` does not block either — a parked question is
 * exactly when moving between sessions is most useful.
 */
export function shortcutsEnabled(layers: readonly Layer[]): boolean {
  return !layers.some((layer) => layer.kind === "sheet");
}

/**
 * Whether the ask card's numbered answers may fire.
 *
 * **A second predicate rather than a widening of the one above, because the two
 * questions are different**: that one is about *navigating*, this one is about
 * *deciding*. `j` under an open `Dropdown` moves a caret and the worst case is
 * that you look at the wrong row; `2` under an open `Dropdown` approves a
 * command. The card was gating its digits on `shortcutsEnabled`, which blocks
 * only `sheet` — deliberately, and for reasons that are entirely about the
 * navigation case — so with a session menu or the config bar's `…` popover open
 * over a parked question, a keystroke aimed at the menu resolved the permission
 * underneath it.
 *
 * So this blocks on a `menu` as well as a `sheet` — everything except the card's
 * own `ask`. **Not `layers.length === 0`**, which reads like the stricter and
 * more obviously-correct rule and is in fact the broken one: the card registers
 * itself with `useDismissible("ask", …)` whenever it is open, so an empty stack
 * is precisely the state in which there is no card to answer. A predicate that
 * disabled the shortcuts exactly when the card is on screen would have passed
 * every "is it safe" reading and never fired once.
 *
 * Widening `shortcutsEnabled` instead would have made `j`/`k` stop working under
 * a menu, which the docblock above records as a considered non-change.
 */
export function decisionShortcutsEnabled(layers: readonly Layer[]): boolean {
  return !layers.some((layer) => layer.kind !== "ask");
}

/**
 * Whether a path is drawn as an overlay over something else rather than as the
 * screen itself.
 *
 * This is what makes the phone's Back button close a pop-up for free: the pop-up
 * is a real route, so Back pops the entry that opened it and the sheet unmounts
 * with no code at all. It is also what `router.ts` reads to decide whether to
 * record what is *underneath*.
 *
 * Whole-segment matching, not `startsWith` alone: a future `/settingsomething`
 * must not be mistaken for a settings route — which is also why `/p` is a whole
 * segment here rather than a prefix, `/pinned` being a plausible future route.
 *
 * **The list must hold every route `isSheet` in `nav.ts` holds.** They answer the
 * same question from two directions — this one from a path, that one from a
 * parsed route — and a route in one and not the other is a pop-up that either
 * forgets what it was drawn over (so its ✕ goes home) or records one while being
 * a screen (so Back leaves the app). Both were reachable when this list was two
 * literals and `isSheet` was three.
 */
export function isOverlayPath(pathname: string): boolean {
  const first = pathname.split("/")[1] ?? "";
  // ⚠ `plugins` and `p` are two entries because they are two screens: the market
  // pop-up and one plugin's own screen on one machine. See `Route` in `router.ts`.
  return (
    first === "settings" ||
    first === "new" ||
    first === "agent" ||
    first === "p" ||
    first === "plugins"
  );
}

/**
 * What paints above what, in one ordered table, as **full class strings**.
 *
 * Full strings rather than numbers because Tailwind v4 scans source text and
 * cannot see `` `z-${n}` `` — the same reason `MENU_PANEL` is a whole class list.
 * One table rather than a number in each file, because an ordering that exists
 * only as five literals spread across the five things it orders is one nothing can
 * assert and everybody is free to reverse; `keys.ts` makes exactly this move for
 * the Enter collision.
 *
 * **`AskCard` is deliberately not in this table.** It has no `z-index` at all and
 * must not acquire one — see the measured regression recorded in its own docblock.
 * The overlay's answer is *not available* to it: it is `absolute` inside one
 * session's conversation region on purpose, because a parked question makes that
 * session unanswerable rather than the app.
 */
export const LAYER = {
  /** The sticky session/list header. */
  header: "z-30",
  /** Every anchored panel: `MENU_PANEL`, `SessionMenu`, `AgentConfigBar`. */
  menu: "z-40",
  /** `Sheet`'s positioner. Portaled to `document.body`, so this is a root-context z. */
  overlay: "z-50",
  /**
   * Toasts, and they must outrank the sheet.
   *
   * Every action inside the settings sheet reports failure through `toast()` —
   * `AgentsPanel` alone does it six times — so a toast rendered *under* the sheet
   * that raised it is an error message nobody can read.
   */
  toast: "z-60",
} as const;

/** The numeric order behind {@link LAYER}, so a driver can assert it is ascending. */
export function layerRank(name: keyof typeof LAYER): number {
  return Number(LAYER[name].slice("z-".length));
}

interface Entry {
  readonly layer: Layer;
  readonly onDismiss: () => void;
}

let entries: Entry[] = [];
/** `useSyncExternalStore` is not involved, but the array identity is still shared. */
let published: readonly Layer[] = [];
let nextId = 1;
let listening = false;

/** The live stack, for `keyboard.ts`'s guard. */
export function currentLayers(): readonly Layer[] {
  return published;
}

function republish(): void {
  published = entries.map((entry) => entry.layer);
}

/**
 * `inert` on `#root`, refcounted.
 *
 * One attribute gives `aria-hidden`, focus containment and `pointer-events: none`
 * together, in every browser this app targets — which is why there is no
 * hand-rolled focus trap here, and that absence is worth having: a hand-rolled
 * trap is where the unlayered global `:focus-visible` rule in `index.css` and its
 * single sanctioned `.no-focus-ring` opt-out would start arguing with a component.
 *
 * Refcounted rather than set and cleared, so two stacked sheets do not clear it
 * when the inner one closes. Only `sheet` counts: a menu and an ask card are
 * inside the app and must leave it reachable.
 */
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
    // Conditional, and issued by the one thing that knows what is open. A
    // capture-phase `stopPropagation` at `window` ends the entire dispatch, which
    // is exactly the hazard `AskCard`'s docblock records — the difference is that
    // this one has already decided it is acting.
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

/**
 * Register something Escape can put away.
 *
 * The callback is held in a ref rather than in the dependency list on purpose: a
 * component that rebuilds its handler every render — which `AskCard` does, since
 * each option's `onPick` closes over the current draft — would otherwise pop and
 * re-push on every render and go to the **top** of the stack each time, silently
 * reordering the LIFO that is the whole point of this file.
 */
export function useDismissible(kind: LayerKind, onDismiss: () => void, active: boolean): void {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const id = push(kind, () => latest.current());
    return () => pop(id);
  }, [kind, active]);
}
