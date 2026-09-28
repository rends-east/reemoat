// Trims a bubble to its longest line, which CSS cannot; the one sanctioned JS layout write, and it degrades to the `max-w-*` width (Q3.636, Q3.637).

/** `chrome` is border box minus content box, measured; `null` means leave the box alone. */
export function hugWidth(lineWidths: readonly number[], chrome: number): number | null {
  let widest = 0;
  for (const width of lineWidths) if (width > widest) widest = width;
  if (widest <= 0) return null;
  if (!Number.isFinite(chrome) || chrome < 0) return null;
  // Rounded up: a floor re-wraps the text and the box shrinks on every pass.
  return Math.ceil(widest) + chrome;
}

export interface LineRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** One width per drawn line, however many text nodes share it: an `@name` link splits a line into three (Q3.682). */
export function lineSpans(rects: readonly LineRect[]): number[] {
  const lines: LineRect[] = [];
  for (const rect of rects) {
    const middle = (rect.top + rect.bottom) / 2;
    const line = lines.find((one) => middle >= one.top && middle <= one.bottom);
    if (line === undefined) {
      lines.push({ ...rect });
    } else {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
    }
  }
  return lines.map((line) => line.right - line.left);
}

/** False when a child is laid out to the box, since hugging would clip it: the attachment chips and an image. */
export function huggable(bubble: Element): boolean {
  return bubble.querySelector("ul, img") === null;
}

// One observer on each bubble's full-width row, so a column resize reaches every bubble.
const registered = new Set<HTMLElement>();
let observer: ResizeObserver | null = null;
let scheduled = 0;

/** Reset, read, then write in separate passes: interleaving thrashes layout, and measuring at the old width walks the box down. */
function reflow(): void {
  scheduled = 0;
  const boxes: { bubble: HTMLElement; inner: HTMLElement }[] = [];
  for (const bubble of registered) {
    const inner = bubble.firstElementChild;
    if (!(inner instanceof HTMLElement)) continue;
    if (!huggable(bubble)) continue;
    bubble.style.width = "";
    boxes.push({ bubble, inner });
  }
  const widths = boxes.map(({ bubble, inner }) => hugWidth(lineWidths(inner), bubble.offsetWidth - inner.offsetWidth));
  boxes.forEach(({ bubble }, i) => {
    const width = widths[i];
    if (width !== null && width !== undefined) bubble.style.width = `${width}px`;
  });
}

/** Per text node, never one range over the wrapper, whose own border box would come back as a line; then joined per line. */
function lineWidths(inner: Element): number[] {
  const rects: LineRect[] = [];
  const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) rects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
  }
  return lineSpans(rects);
}

function schedule(): void {
  if (scheduled !== 0) return;
  scheduled = requestAnimationFrame(reflow);
}

/** Call from a layout effect so the first pass runs before paint. */
export function hugBubble(bubble: HTMLElement): () => void {
  const row = bubble.parentElement;
  registered.add(bubble);
  if (typeof ResizeObserver !== "undefined") {
    observer ??= new ResizeObserver(schedule);
    if (row !== null) observer.observe(row);
  }
  reflow();
  return () => {
    registered.delete(bubble);
    if (row !== null) observer?.unobserve(row);
    bubble.style.width = "";
  };
}
