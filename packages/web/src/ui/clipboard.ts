/**
 * Copying text, in the one place that knows this origin is not always secure.
 *
 * **`navigator.clipboard` exists only in a secure context, and this app is
 * routinely served from one that is not.** The control plane answers on a plain
 * `http://` LAN address — that is how it is read on the machine the agents run on,
 * and over a tailnet from a phone — and there `navigator.clipboard` is not refused,
 * it is **absent**. Measured on the deployed stack at `http://192.0.2.10:7888`:
 * `window.isSecureContext === false`, `typeof navigator.clipboard === "undefined"`,
 * and `document.execCommand("copy")` returns `true`. So the modern API is not a
 * progressive enhancement here; it is missing on the deployment somebody reviews
 * on, and every call site that reached for it directly wrote its own `catch`
 * admitting the button did nothing — three of them, each with a different
 * consolation.
 *
 * The fallback is `document.execCommand`, which is the only other thing a browser
 * offers. It is deprecated and no engine has announced its removal; the honest
 * trade is a deprecated call against a copy button that works in production and
 * not on the machine it was written on.
 *
 * **One function, so a fourth copy cannot be written.** `webcheck` asserts that
 * `navigator.clipboard` appears in this file and nowhere else under
 * `packages/web/src` — the same shape of rule `Markdown.tsx`'s `img` override and
 * `links.ts` get, and for the same reason: the interesting behaviour is in the
 * *absence* of a call anywhere else.
 *
 * Nothing here runs at import: `webcheck` imports this file's consumers under a
 * `window` stub with no `document` and no `navigator` at all.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    // Both optional: a browser can carry the object without the method, and on the
    // insecure origin above the whole object is undefined.
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Present and refused, which is a different failure from absent — a permission
    // policy, or a document that did not have focus. The fallback goes through a
    // different gate, so this is not the end of the attempt.
  }
  return legacyCopy(text);
}

/**
 * The pre-`navigator.clipboard` way, written for the browser that still needs it.
 *
 * Three details are iOS and not superstition. **`readOnly` rather than
 * `disabled`**, because a disabled field cannot be selected and a copy with no
 * selection copies nothing — and because a read-only field does not raise the
 * software keyboard for the frame it is focused. **`setSelectionRange` after
 * `select()`**, because `select()` alone does not reliably set a range on a
 * read-only field there. **16px**, because iOS zooms the page for any smaller font
 * in a focused field, and this one is focused for one turn of the event loop.
 *
 * The caret goes back to whatever had it, which is the composer nearly every time.
 */
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.setAttribute("aria-hidden", "true");
  area.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;opacity:0;font-size:16px";
  const active = document.activeElement;
  document.body.append(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    // A browser that has neither. Nothing left to try, and the caller says so.
    return false;
  } finally {
    area.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  }
}
