import type { ReactNode } from "react";

/**
 * The product's mark: three rounded bars, the middle one taller.
 *
 * **The geometry is copied rather than imported, and that is deliberate.** The
 * source lives with the landing page (`reemoat_landing/logo/`), which ships a
 * single self-contained `index.html` and inlines the mark for the same reason this
 * does: an `<img>` is a second request before the first paint on a phone, and the
 * document's CSP is `img-src 'self' blob:`, so a `data:` URI would be refused
 * outright. What is duplicated is six numbers, and the README beside those files
 * carries the same table — a redraw means editing both, which is cheaper than a
 * build step that shares them.
 *
 * The bars are **not symmetric**: the left one is `y=35.5 h=121` and the right
 * `y=36 h=120`. That is in the original export rather than introduced here, it is
 * invisible at any size this app draws, and it is written down so nobody "fixes" it
 * in one place only.
 *
 * `fill="currentColor"`, so the mark takes the ink of whatever it sits in and
 * follows the palette with no second token — the same rule every glyph in this app
 * already keeps.
 */
const BAR_WIDTH = 50;
const BAR_RADIUS = 16.43;
const VIEW_WIDTH = 170;
const VIEW_HEIGHT = 192;

const BARS = [
  { x: 0, y: 35.5, height: 121 },
  { x: 60, y: 0, height: 192 },
  { x: 120, y: 36, height: 120 },
] as const;

/**
 * The stagger, written out rather than computed.
 *
 * Tailwind reads class names as **literal strings out of the source**, so a delay
 * built by arithmetic emits no rule at all and the three bars blink in unison —
 * which is a pulse, not the three dots this is imitating. 140ms is a third of the
 * half-cycle, so the crest walks left to right and there is never a frame with all
 * three at the bottom.
 */
const DELAY = ["", "[animation-delay:140ms]", "[animation-delay:280ms]"] as const;

/** The mark, still. `size` is its height in pixels; the width follows the canvas. */
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

/**
 * "An agent is working", as the mark itself.
 *
 * The three bars blink in sequence — the typing indicator every messenger draws,
 * except that here the three dots are the product's own shape rather than three
 * dots borrowed for the occasion.
 *
 * **This replaced `WorkingDot`, and the thing it gives up is worth naming.** That
 * was `TONE_DOT.running` reused, so the foot of a transcript and the running dot on
 * a row in the rail were one object and could not drift. They are two now, on
 * purpose: at 8px in a list of rows a dot is the right mark and a three-bar glyph
 * would be mush, while the foot of a conversation has room for the thing this app
 * actually is. The rail is untouched; only this row changed.
 *
 * **Under `prefers-reduced-motion` it settles on a plain, fully-inked mark**, which
 * is the degradation `index.css`'s own animation notes ask for: the block at the
 * foot of that file collapses every animation to one 0.01ms pass with no fill mode,
 * so each bar lands back on its declared opacity of 1. The row beside it still
 * carries the *word* `working…`, which is what survives the freeze.
 *
 * **`still` is the same mark with the animation off.** Three bars breathing is
 * work happening; the same three bars at rest, beside a line whose tense has
 * changed, is the same object having stopped — and reusing the glyph rather than
 * swapping in a different one is what makes it read as a state rather than as an
 * unrelated notice.
 *
 * ⚠ **It had one caller and a rule that turned out to be a proxy for a different
 * one.** The caller was the row a cancelled turn leaves behind, and the rule read
 * *nothing that is waiting may draw this* — written to stop it becoming a second
 * spinner. `WaitingFoot` is the second caller now, drawing it while the socket is
 * down, and it is *waiting* by the old wording. It is right anyway, which is what
 * shows the wording was aimed at the wrong thing: with the stream gone that row is
 * painting the last snapshot that arrived, so the blink was asserting work is
 * happening **now** on the strength of a fact that had stopped being checked. The
 * mark at rest is the honest drawing of exactly that.
 *
 * So the boundary is about the row's own subject rather than about the word wait:
 * draw `still` where the thing this mark is *about* has stopped or can no longer
 * be stood behind. A row waiting on work that is genuinely still running is not
 * that, and stays `Dot tone="pending"` — which is the line that keeps this from
 * becoming the second spinner the old rule was guarding against.
 */
export function WorkingMark({ still = false }: { still?: boolean } = {}): ReactNode {
  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      height={11}
      width={10}
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
