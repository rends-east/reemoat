// Where a scroller stood when the screen holding it went away, by a name of its own, so a task opened from the board or the
// list and closed again finds them where it left them rather than at the top (the owner's call, 2026-10-23; Q3.747).

const kept = new Map<string, { top: number; left: number }>();
const refs = new Map<string, (node: HTMLElement | null) => void>();
const heard = new WeakSet<HTMLElement>();

/** The list a back swipe draws under a conversation is a picture cut to one screen: it neither takes nor writes a place. */
function picture(node: HTMLElement): boolean {
  return node.closest("[data-back-under]") !== null;
}

/** A ref for the scroller called `name`: put back where it last stood when it mounts, and followed while it scrolls. Stable per name. */
export function keptScroll(name: string): (node: HTMLElement | null) => void {
  const known = refs.get(name);
  if (known !== undefined) return known;
  const ref = (node: HTMLElement | null): void => {
    if (node === null || heard.has(node)) return;
    heard.add(node);
    const at = kept.get(name);
    // Called once its children are in the document, so the height it is put back against is the drawn one.
    if (at !== undefined && !picture(node)) {
      node.scrollTop = at.top;
      node.scrollLeft = at.left;
    }
    node.addEventListener(
      "scroll",
      () => {
        if (!picture(node)) kept.set(name, { top: node.scrollTop, left: node.scrollLeft });
      },
      { passive: true },
    );
  };
  refs.set(name, ref);
  return ref;
}
