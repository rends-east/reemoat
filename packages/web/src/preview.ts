/**
 * What may be shown inline, and what may only be downloaded.
 *
 * The rules are here, pure and asserted, rather than inside the component that
 * draws them — because two of the three are security decisions and the third is a
 * budget, and none of them should be re-derived at a call site.
 */

/**
 * The only types rendered inline. An **allowlist**, and the omission is the point.
 *
 * `image/svg+xml` is deliberately absent. SVG is a document format: it can carry
 * `<script>`, and the only thing standing between that and this origin is that
 * `<img>` disables scripting for it — which every current engine does, and which
 * is a promise about engine behaviour rather than about our code. An allowlist of
 * four raster formats costs nothing and does not depend on that promise holding.
 * SVG still downloads perfectly well; it is only never rendered.
 *
 * `image/*` is not used for the same reason: it would admit `svg+xml` and
 * whatever else the registry grows next.
 */
export const PREVIEWABLE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * The largest image fetched for an inline preview.
 *
 * Far below `MAX_DOWNLOAD_BYTES` (100 MiB) because the two answer different
 * questions: that one bounds a file somebody explicitly asked for, this one
 * bounds bytes pulled **automatically**, through the relay, onto a phone, for
 * something they may only be scrolling past. Anything larger keeps its download
 * button and draws no picture.
 */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/**
 * May this be drawn inline?
 *
 * `bytes` is required rather than optional: a preview whose size is unknown is
 * exactly the one that must not be fetched automatically, and defaulting an
 * unknown size to zero would invert that.
 */
export function previewable(mime: string | null, bytes: number): boolean {
  if (mime === null) return false;
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_PREVIEW_BYTES) return false;
  // Normalized the same way the daemon normalizes it: lowercase, parameters off.
  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return PREVIEWABLE_TYPES.includes(type);
}
