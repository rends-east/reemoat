/** An allowlist: SVG can carry script and is never rendered inline, so never widen this to `image/*`. */
export const PREVIEWABLE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Far below MAX_DOWNLOAD_BYTES because a preview is fetched automatically. */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

export function previewable(mime: string | null, bytes: number): boolean {
  if (mime === null) return false;
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_PREVIEW_BYTES) return false;
  // Normalized the same way the daemon normalizes it: lowercase, parameters off.
  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return PREVIEWABLE_TYPES.includes(type);
}
