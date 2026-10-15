import { Component, type ReactNode } from "react";

export const SETTLE_MS = 180;
export const SETTLE_EASE = "cubic-bezier(0.2, 0, 0, 1)";

export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Slides every `[data-flip]` inside it from where it was drawn to where the next render puts it, across columns included: a
 * card a drag, a press or a read moves glides there rather than jumping (Q3.728). A class, for the one hook that measures
 * before the DOM changes; it measures only when `order` does, since the board redraws on every event of every conversation.
 */
export class FlipBoundary extends Component<{ order: string; className?: string; children: ReactNode }> {
  private node: HTMLDivElement | null = null;

  override getSnapshotBeforeUpdate(previous: Readonly<{ order: string }>): Map<string, DOMRect> | null {
    if (previous.order === this.props.order || this.node === null) return null;
    const rects = new Map<string, DOMRect>();
    // As drawn now, a slide still under way included, so a second move starts from where the eye is.
    for (const one of this.node.querySelectorAll<HTMLElement>("[data-flip]")) rects.set(one.dataset["flip"] ?? "", one.getBoundingClientRect());
    return rects;
  }

  override componentDidUpdate(_previous: unknown, _state: unknown, before: Map<string, DOMRect> | null): void {
    if (before === null || this.node === null || reducedMotion()) return;
    for (const one of this.node.querySelectorAll<HTMLElement>("[data-flip]")) {
      const was = before.get(one.dataset["flip"] ?? "");
      if (was === undefined) continue;
      for (const running of one.getAnimations()) if (running.id === "flip") running.cancel();
      const now = one.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      // From another column it would slide out of sight behind this column's scroller: it appears in place instead.
      const lane = one.closest("[data-lane-scroll]")?.getBoundingClientRect();
      const across = lane !== undefined && (was.left + was.width / 2 < lane.left || was.left + was.width / 2 > lane.right);
      // Up to its own opacity, which a faded slot keeps after the animation lets go.
      const shown = getComputedStyle(one).opacity;
      const move = across
        ? one.animate([{ opacity: 0, transform: "scale(0.97)" }, { opacity: shown, transform: "none" }], { duration: SETTLE_MS, easing: SETTLE_EASE })
        : one.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: SETTLE_MS + 40, easing: SETTLE_EASE });
      move.id = "flip";
    }
  }

  override render(): ReactNode {
    return (
      <div ref={(node) => void (this.node = node)} className={this.props.className}>
        {this.props.children}
      </div>
    );
  }
}
