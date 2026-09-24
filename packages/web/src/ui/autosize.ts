/** Of the visible viewport, not `vh`: a soft keyboard covers the layout viewport without shrinking it (Q3.422). */
export const COMPOSER_MAX_SHARE = 0.22;

/**
 * `height = auto` first, so `scrollHeight` measures the content rather than the box. The parent holds its height meanwhile, or the
 * collapse grows the transcript beside it and clamps its scroll, which stays clamped once the height comes back (Q3.649).
 */
export function fitToContent(area: HTMLTextAreaElement): void {
  const holder = area.parentElement;
  if (holder !== null) holder.style.minHeight = `${holder.offsetHeight}px`;
  area.style.height = "auto";
  const visible = window.visualViewport?.height ?? window.innerHeight;
  const max = Math.round(visible * COMPOSER_MAX_SHARE);
  const wanted = area.scrollHeight;
  area.style.height = `${Math.min(wanted, max)}px`;
  area.style.overflowY = wanted > max ? "auto" : "hidden";
  if (holder !== null) holder.style.minHeight = "";
}
