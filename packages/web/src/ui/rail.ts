/**
 * How wide the rail is, and the two numbers that stop it being useless.
 *
 * **Module state seeded from `localStorage`, not `useState`** — the same rule
 * `groups.ts` states about the collapse set and the selected machine tab, for the
 * same reason: this is a preference about the app rather than about a screen, and
 * a component that unmounts must not take it with it. `AppShell` itself never
 * unmounts, but the rule is the rule, and the width is read by a driver that has
 * no React at all.
 *
 * **What is deliberately NOT here is the DOM.** This file is imported by
 * `webcheck`, which stubs `window.location` and `window.localStorage` and nothing
 * else — so a `document.documentElement` touch anywhere in the module body, or in
 * anything a check calls, throws before a single case runs. The same ⚠ `overlay.ts`
 * carries about its listener, and the reason `settings.ts` and `groups.ts` may not
 * import `router.ts`. The custom property is written by `AppShell`, which is the
 * impure shell around this.
 *
 * **The width travels as a CSS custom property rather than as a React prop**, and
 * that is a correctness fix rather than a performance one — though it is both.
 * `store` publishes on a four-second poll and on every streamed event, so
 * `AppShell` re-renders throughout a drag; with the width on `style={{ width }}`
 * every one of those renders would overwrite the pointer's own value and snap the
 * rail back to where the drag started. Writing `--rail-w` on `documentElement`
 * puts it somewhere React does not reconcile. That it also costs **no** render per
 * `pointermove` — against a transcript that draws all 5000 events it holds, with no
 * render window — is the second reason and would have been enough on its own.
 */

const STORAGE_KEY = "reemoat.railWidth";

/**
 * The bounds, and they are a usability floor rather than a guess.
 *
 * Below `RAIL_MIN` the rail stops being able to say what it is for: a session row
 * is a status dot, a title, a relative time and a kebab, and the title is the only
 * one that can give — at 240px it still shows enough of a name to tell two
 * sessions apart, and under that it is eliding at the tenth character. Above
 * `RAIL_MAX` the cost lands on the transcript instead, which is the thing being
 * read; past ~480px the list is mostly whitespace and the conversation is paying
 * for it.
 *
 * `RAIL_DEFAULT` is 312px — the width this shipped at, so an install that never
 * touches the handle is pixel-identical to the one before it. Written in px and
 * **not** as the `19.5rem` it replaced: `index.css` declares the same number and
 * `AppShell` writes px, and the two spellings agreeing only at a 16px root font is
 * a defect that file now records at length.
 *
 * All three are **device pixels and do not scale with the reader's type**, which
 * makes the sentence above about 240px a claim about a 16px root: at a larger one
 * the rows get taller and the titles wider while the floor stays 240, so the
 * elision this bound exists to prevent starts earlier. Accepted rather than
 * missed — a drag produces device pixels, and a floor is something somebody can
 * always drag away from — but it is the first thing to revisit if the rail is ever
 * reported as too tight, rather than moving the number for everybody.
 */
export const RAIL_MIN = 240;
export const RAIL_MAX = 480;
export const RAIL_DEFAULT = 312;

/**
 * The one place a width is bounded, and every path goes through it.
 *
 * Pure, and exported for that reason: the drag, the keyboard, the stored value and
 * the reset are four ways in, and a clamp applied at three of them is the fourth
 * one shipping a 12px rail. Non-finite in as well as out of range — `Number.parseInt`
 * answers `NaN` for a hand-edited storage value, and `NaN` compared against a bound
 * is `false` in both directions, so a bare `Math.min`/`Math.max` pair would pass it
 * straight through.
 */
export function clampRailWidth(px: number): number {
  if (!Number.isFinite(px)) return RAIL_DEFAULT;
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
}

function read(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return RAIL_DEFAULT;
    return clampRailWidth(Number.parseInt(raw, 10));
  } catch {
    // Private mode, a quota, or somebody's hand-edited value. A sidebar width is
    // not worth failing a render for; the default is a working app.
    return RAIL_DEFAULT;
  }
}

let width = read();
const listeners = new Set<() => void>();

/** The committed width. `useSyncExternalStore` compares it by `Object.is`. */
export function railWidth(): number {
  return width;
}

export function setRailWidth(px: number): void {
  const next = clampRailWidth(px);
  if (next === width) return;
  width = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Same reasoning as `read`: the in-memory value still works for this session.
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeRail(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
