// Every sheet, drawer, scrim, page, tab pill, pull and back swipe moves on one clock and one curve, and every drag ends on one decision (Q3.650, Q3.655).
// Holds no DOM and imports nothing, so webcheck drives it directly; sheetDrag.ts is the impure shell.

/** index.css's --sheet-ms; webcheck asserts they agree. */
export const SHEET_MS = 260;

/** index.css's --sheet-ease, for arriving and leaving alike: an exit that starts at rest stalls under a finger that flung it. */
export const SHEET_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/** px/ms toward the exit: a release this fast dismisses at any distance. */
export const FLING = 0.5;

/** A slow release dismisses past this, or a third of a short panel. */
export const DISMISS_PX = 96;

/** Only the last stretch of a gesture is its speed. */
export const VELOCITY_MS = 100;

/** How much more along its axis than across it a first move must be; shared with machineSwipe. */
export const DOMINANCE = 1.5;

/** Px from either side of the screen left to the platform: Android's own Back is a swipe in from an edge. */
export const EDGE_DEAD_ZONE = 24;

export function dismissAt(extent: number): number {
  return Math.min(DISMISS_PX, extent / 3);
}

/** `travel` and `velocity` are measured toward the exit; `extent` is the panel's size along that axis. */
export function sheetRelease(travel: number, velocity: number, extent: number): "dismiss" | "stay" {
  if (travel <= 0 || velocity <= -FLING) return "stay";
  if (velocity >= FLING) return "dismiss";
  return travel >= dismissAt(extent) ? "dismiss" : "stay";
}

export interface Sample {
  readonly t: number;
  readonly at: number;
}

/** px/ms over the last VELOCITY_MS before `now`; a finger that stopped before lifting has none. */
export function releaseVelocity(samples: readonly Sample[], now: number): number {
  const last = samples.at(-1);
  if (last === undefined) return 0;
  const recent = [...samples.filter((one) => now - one.t <= VELOCITY_MS), { t: now, at: last.at }];
  const first = recent[0];
  if (first === undefined || now <= first.t) return 0;
  return (last.at - first.at) / (now - first.t);
}

/** Where a scroller under the finger is: `null` when the gesture did not start in one. */
export interface ScrollerEdge {
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

/**
 * Whether the first move past the slop is the panel's. `along` is toward the exit.
 * Decided once: an engine already panning (`cancelable === false`) or a scroller that can still move that way keeps it.
 */
export function claimDrag(along: number, across: number, scroller: ScrollerEdge | null, cancelable: boolean): boolean {
  if (!cancelable) return false;
  if (Math.abs(along) <= Math.abs(across) * DOMINANCE) return false;
  if (scroller === null) return true;
  return along > 0 ? scroller.atStart : scroller.atEnd;
}

/** The picker's two detents: a fling picks by direction, otherwise the nearer one. */
export function detentAfter(height: number, velocity: number, rest: number, full: number): "rest" | "full" {
  if (velocity <= -FLING) return "full";
  if (velocity >= FLING) return "rest";
  return height > (rest + full) / 2 ? "full" : "rest";
}

/** Where a sideways drag may put the list: never past a neighbour, and not at all toward a side that has none (Q3.655). */
export function pageOffset(dx: number, width: number, hasPrevious: boolean, hasNext: boolean): number {
  return Math.min(Math.max(dx, hasNext ? -width : 0), hasPrevious ? width : 0);
}

/**
 * The page a released drag lands on: 1 the next, -1 the previous, 0 back where it was.
 * `offset` and `velocity` are the list's, rightward positive; the rule is the sheets', turned on its side.
 */
export function pageTurn(offset: number, velocity: number, width: number): -1 | 0 | 1 {
  if (offset === 0) return 0;
  const side = offset < 0 ? 1 : -1;
  return sheetRelease(Math.abs(offset), -side * velocity, width) === "dismiss" ? side : 0;
}

/** A tab's pill along the strip, in the strip's own coordinates. */
export interface Span {
  readonly x: number;
  readonly width: number;
}

/** The moving pill at `progress` between two tabs, both measured once: where it is and how wide, never a jump (Q3.656). */
export function pillBetween(from: Span, to: Span, progress: number): Span {
  const p = Math.min(1, Math.max(0, progress));
  return { x: from.x + (to.x - from.x) * p, width: from.width + (to.width - from.width) * p };
}

/** What of a tab's pill the strip shows: a tab scrolled half out shows half its pill, as the tab's own would. */
export function clipSpan(span: Span, lo: number, hi: number): Span {
  const x = Math.max(span.x, lo);
  return { x, width: Math.max(0, Math.min(span.x + span.width, hi) - x) };
}

/** Round ends at any width from transforms alone: two caps that only move and a middle, `base` wide, that only stretches. */
export function pillPieces(span: Span, height: number, base: number): { left: number; middle: number; right: number; scale: number } {
  return {
    left: span.x,
    middle: span.x + height / 2,
    right: span.x + span.width - height,
    scale: Math.max(0, span.width - height) / base,
  };
}

/** The strip scroll that shows `span`, in the scroller's own coordinates, whole, moving as little as possible. */
export function scrollToShow(scroll: number, view: number, max: number, span: Span): number {
  const wanted = span.x < scroll ? span.x : span.x + span.width > scroll + view ? span.x + span.width - view : scroll;
  return Math.min(Math.max(0, wanted), Math.max(0, max));
}

const CURVE = SHEET_EASE.slice(SHEET_EASE.indexOf("(") + 1, -1)
  .split(",")
  .map(Number);

/** SHEET_EASE at `t`, for the one movement CSS cannot transition: a scroll position. */
export function easeAt(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = CURVE;
  const along = (a: number, b: number, u: number): number => 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let step = 0; step < 32; step += 1) {
    if (along(x1, x2, u) < t) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return along(y1, y2, u);
}

/** Which of the list's gestures a first move past the slop is (Q3.657, Q3.658): decided once, by axis, never argued with. */
export type ListGesture = "page" | "drawer" | "pull" | "none";

export function listGesture(
  dx: number,
  dy: number,
  where: {
    readonly cancelable: boolean;
    readonly firstPage: boolean;
    readonly atTop: boolean;
    readonly refreshing: boolean;
    /** The touch caught a page turn still settling: sideways it is the pager's, and nothing else starts (Q3.667). */
    readonly turning: boolean;
  },
): ListGesture {
  if (!where.cancelable) return "none";
  if (where.turning) return Math.abs(dx) > Math.abs(dy) * DOMINANCE ? "page" : "none";
  // Rightward on the first page has no page to reveal, so it pulls the drawer, as Telegram's first folder does.
  if (Math.abs(dx) > Math.abs(dy) * DOMINANCE) return where.firstPage && dx > 0 ? "drawer" : "page";
  // Only downward, only from the top, and never over a refresh already holding the gap.
  return !where.refreshing && claimDrag(dy, dx, { atStart: where.atTop, atEnd: false }, true) ? "pull" : "none";
}

/** The gap a refresh holds open above the list; `h-14` in SessionBrowser, and webcheck asserts they agree. */
export const PULL_HOLD_PX = 56;

/** How far the list follows a pull: one for one at first, then giving less and less, never past twice the hold. */
export function pullOffset(dy: number): number {
  if (dy <= 0) return 0;
  const limit = PULL_HOLD_PX * 2;
  return (limit * dy) / (limit + dy);
}

/** Let go with the gap open as far as the hold, the list refreshes; short of it the gap closes and nothing is asked. */
export function pullRefreshes(offset: number): boolean {
  return offset >= PULL_HOLD_PX;
}

/**
 * Whether a first move past the slop takes a conversation back to the list (Q3.663): rightward, sideways by DOMINANCE, and
 * never while an engine is already panning or a horizontal scroller under the finger can still scroll back.
 */
export function backClaim(dx: number, dy: number, where: { readonly cancelable: boolean; readonly scrollsBack: boolean }): boolean {
  if (!where.cancelable || where.scrollsBack || dx <= 0) return false;
  return Math.abs(dx) > Math.abs(dy) * DOMINANCE;
}

/** index.css's `nav-under`, which the chevron's own pop plays: the list starts this far left and this faint. */
export const BACK_UNDER_SHIFT = 0.22;
export const BACK_UNDER_OPACITY = 0.55;

/** The list under a conversation dragged `offset` px along a `width` px screen: where it is and how faint, 0 to 1 of the way home. */
export function underAt(offset: number, width: number): { shift: number; opacity: number } {
  const p = width <= 0 ? 1 : Math.min(1, Math.max(0, offset / width));
  return { shift: -BACK_UNDER_SHIFT * width * (1 - p), opacity: BACK_UNDER_OPACITY + (1 - BACK_UNDER_OPACITY) * p };
}

/**
 * The pager's pages are one strip (Q3.667): the page at `index` is drawn at the strip's `offset`, measured from the page `ref`
 * it is relative to, plus a page-width for every page between them. A turn commits only when the strip comes to rest.
 */
export function pageX(offset: number, ref: number, index: number, width: number): number {
  return offset + (index - ref) * width;
}

/** The strip's offset from `ref`, read back from where the page at `index` is drawn: a touch catches a turn from here. */
export function offsetFrom(drawn: number, index: number, ref: number, width: number): number {
  return drawn - (index - ref) * width;
}

/** Where the strip is, in pages: 2.5 is halfway between the third page and the fourth. */
export function stripAt(offset: number, ref: number, width: number): number {
  return width <= 0 ? ref : ref - offset / width;
}

/** The page a pill drawn at `from` heads for with the strip at `at`: the next one the way the strip is travelling. */
export function nextPage(at: number, from: number, count: number): number {
  const to = at > from ? Math.floor(at) + 1 : Math.ceil(at) - 1;
  return Math.min(count - 1, Math.max(0, to));
}

/** How far a pill's trip from `from` to `to`, both in pages, has come with the strip at `at`. */
export function legProgress(at: number, from: number, to: number): number {
  if (to === from) return 1;
  return Math.min(1, Math.max(0, (at - from) / (to - from)));
}

/**
 * The pages to have drawn while a turn to `target` settles: it and both its neighbours, so a flick that follows finds the page
 * beyond already there. None for a turn given back, which rests where the list already is; never the list's own page.
 */
export function pagesFor(target: number, turn: -1 | 0 | 1, base: number, count: number): number[] {
  if (turn === 0) return [];
  return [target - 1, target, target + 1].filter((index) => index >= 0 && index < count && index !== base);
}
