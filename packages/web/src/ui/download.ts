/**
 * Handing a downloaded file to the person who asked for it.
 *
 * Eight lines, and one of them is load-bearing enough to justify its own module
 * rather than being inlined into a click handler where it can be "simplified".
 */

/**
 * Save a blob under a name, without ever letting the browser render it.
 *
 * **The re-type to `application/octet-stream` is the line that must not
 * change.** A `blob:` URL inherits the origin that created it, and this origin's
 * `localStorage` holds `reemoat.credential` — the credential this whole session
 * runs on, and the one that mints every daemon token. So if an `.html` or `.svg`
 * the agent wrote were ever opened as a **top-level document** from a blob URL,
 * its script would run as this page and read that key.
 *
 * ⚠ **The document's CSP does not cover this, which is why the re-type is still
 * the guard.** This comment used to say there was no CSP anywhere in the
 * repository; there is one now (`packages/control-plane/src/app.ts`), and it is
 * set on the *document* only. A blob opened as a top-level document is a
 * navigation to a new browsing context, not a fetch this page's policy governs —
 * so nothing about that header makes the paragraph above less true.
 *
 * The daemon already sends `application/octet-stream` and `nosniff`, but a `Blob`
 * carries whatever type the *client* gave it, so the client has to say it too.
 * Three rules follow, and they are the reason this is not a one-liner at a call
 * site:
 *
 * - never `window.open(url)`,
 * - never `<a target="_blank">` without `download`,
 * - never `<iframe src={url}>`.
 *
 * The `download` attribute is what forces a save instead of a navigation, and it
 * works here — unlike on a cross-origin `href`, where it is ignored — precisely
 * because a blob URL is same-origin.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  // Revoked on the next tick rather than synchronously: Safari cancels the save
  // if the URL is revoked in the same task as the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
