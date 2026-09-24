import { createContext, useContext } from "react";

/** A context because `Markdown`'s hoisted `COMPONENTS` cannot take props; `null` means nothing can be fetched, and consumers draw nothing. */
export interface FileAccess {
  /** A workspace-relative path, or `null` for anything outside it. */
  relFor(absPath: string): string | null;
  /** Keeps the touched-path set behind a stable function identity, so streaming does not re-render consumers. */
  spanTarget(span: string): string | null;
  download(rel: string, name: string): Promise<void>;
  downloadUpload(uploadId: string, name: string): Promise<void>;
  fetchUpload(uploadId: string): Promise<Blob>;
}

export const FileAccessContext = createContext<FileAccess | null>(null);

export function useFileAccess(): FileAccess | null {
  return useContext(FileAccessContext);
}
