import { Download, File as FileGlyph } from "lucide-react";
import type { ReactNode } from "react";
import { formatBytes } from "../paths";
import { previewable } from "../preview";
import type { StoredFileRef } from "../wire";
import type { FileAccess } from "./files";
import { ImagePreview } from "./ImagePreview";
import { Icon } from "./bits";

/** A file the agent sent on purpose, left-aligned as its own output: an image is shown, anything else is one press to save (Q2.252). */
export function SentFileRow({ file, files }: { file: StoredFileRef; files: FileAccess | null }): ReactNode {
  const label = (
    <>
      <Icon as={FileGlyph} size={13} className="shrink-0 text-faint" />
      <span className="min-w-0 truncate font-mono">{file.name}</span>
      <span className="shrink-0 text-faint">{formatBytes(file.bytes)}</span>
    </>
  );
  const box = "flex w-fit max-w-full items-center gap-2 rounded-md border border-edge px-2.5 py-1.5 text-2xs";
  return (
    <div className="my-2 space-y-1.5 select-text">
      {files !== null && previewable(file.mime, file.bytes) && (
        <ImagePreview cacheKey={`u:${file.uploadId}`} fetcher={() => files.fetchUpload(file.uploadId)} alt={file.name} />
      )}
      {files === null ? (
        <div className={box}>{label}</div>
      ) : (
        <button
          type="button"
          aria-label={`Download ${file.name}`}
          title={`Download ${file.name}`}
          onClick={() => void files.downloadUpload(file.uploadId, file.name)}
          className={`tap ${box} hover:border-edge-strong`}
        >
          {label}
          <Icon as={Download} size={13} className="shrink-0 text-faint" />
        </button>
      )}
    </div>
  );
}
