import { copyNative, inNativeShell } from "../native";

/** The one place the clipboard API is named (webcheck enforces it): native first, then the async API, then `execCommand` for insecure origins where the API is absent. */
export async function copyText(text: string): Promise<boolean> {
  if (inNativeShell()) return await copyNative(text);
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Present but refused, by policy or focus; the fallback passes a different gate.
  }
  return legacyCopy(text);
}

/** For iOS: `readOnly` rather than disabled, an explicit selection range, and 16px to avoid zoom. The caret is put back. */
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
