import { createContext, useContext } from "react";

/**
 * How a transcript's files are reached, and the one React context in this app.
 *
 * **Why a context here when everything else threads props.** `Markdown`'s
 * `COMPONENTS` map is hoisted to module scope on purpose: built inline it gets a
 * fresh identity every render, the memo on `MarkdownBody` never hits, and the
 * whole streaming-parse saving evaporates — that file spends a docblock saying
 * so. A `code` span that can offer a download needs per-session state, and the
 * only ways to give it any are a prop (which forces `COMPONENTS` to be rebuilt,
 * i.e. exactly the regression that docblock forbids) or a context, which the
 * memo does not see at all. So this is not a stylistic drift away from props; it
 * is the one place props cannot go.
 *
 * `null` is a legitimate value and means "nothing here can be fetched" — a
 * session whose row has not arrived, or a machine with no route. Every consumer
 * draws nothing rather than a disabled control, which is the same rule the
 * composer's paperclip and the out-of-workspace locations already follow.
 */
export interface FileAccess {
  /** A workspace-relative path, or `null` for anything outside it. */
  relFor(absPath: string): string | null;
  /**
   * What an inline code span in agent prose should offer, if anything.
   *
   * Wraps `downloadablePath` so the set of paths this session touched stays
   * behind a **stable function identity**: the set itself changes as events
   * arrive, and handing it out directly would give every consumer a new prop on
   * every streamed token.
   */
  spanTarget(span: string): string | null;
  download(rel: string, name: string): Promise<void>;
  downloadUpload(uploadId: string, name: string): Promise<void>;
  /**
   * The bytes of a stored upload, for drawing rather than saving.
   *
   * Separate from `download*` because the two do genuinely different things with
   * the result: one hands it to the browser as a save, the other keeps it in a
   * cache and points an `<img>` at it. Sharing one method would have meant a
   * flag, and a flag deciding between "save this" and "render this" is the last
   * place a mistake should be possible.
   *
   * There was a `fetchFile(rel)` beside this for workspace-relative paths. Both
   * `ImagePreview` call sites take the upload route, so it was declared,
   * implemented and never called; it comes back the day something previews a
   * file the agent wrote rather than one somebody attached.
   */
  fetchUpload(uploadId: string): Promise<Blob>;
}

export const FileAccessContext = createContext<FileAccess | null>(null);

export function useFileAccess(): FileAccess | null {
  return useContext(FileAccessContext);
}
