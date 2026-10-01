import { inNativeShell, saveNative } from "../native";

/** Saves without rendering: the octet-stream re-type stops an agent-written html/svg from running as this origin, which holds the credential. */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  // A webview under a custom scheme need not honour anchor download, so the shell shows the save panel; its refusal is the caller's to show (Q3.690).
  if (inNativeShell()) {
    await saveNative(blob, filename);
    return;
  }
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  // Revoked on the next tick: Safari cancels the save if the URL is revoked in the same task as the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
