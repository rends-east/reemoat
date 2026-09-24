import { Download, Paperclip } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { formatBytes } from "../paths";
import { previewable } from "../preview";
import type { PromptAttachmentRef } from "../wire";
import type { FileAccess } from "./files";
import { ImagePreview } from "./ImagePreview";
import { Markdown } from "./Markdown";
import { Icon } from "./bits";
import { hugBubble } from "./hug";

/** The person's message as a right-aligned bubble, one component for every call site; agent text stays full-bleed. */
export function UserBubble({
  text,
  attachments = [],
  files = null,
}: {
  text: string;
  attachments?: readonly PromptAttachmentRef[];
  files?: FileAccess | null;
}): ReactNode {
  const box = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    return el === null ? undefined : hugBubble(el);
  });
  if (text.trim().length === 0 && attachments.length === 0) return null;
  return (
    // The row is `select-none` so a selection cannot fill the empty column; the wrapper inside restores `select-text` (`webcheck` asserts the pair).
    <div className="my-4 flex justify-end select-none">
      <div
        ref={box}
        // `min-w-0` lets `Markdown`'s overflow boxes scroll; keep the `lg` cap below `85%` so crossing `lg` never widens the bubble.
        className="sel-root ml-auto w-fit min-w-0 max-w-[85%] select-none rounded-xl rounded-br-md bg-raised px-3.5 py-2.5 lg:max-w-[26rem]"
      >
        {/* `sel-root` on the box is what stops WebKit's gap fill (Q3.638). */}
        <div className="select-text">
          <Markdown text={text} tone="user" />
        </div>
        {/* Chips stay out of `text`, so the `Markdown` memo holds and no URL goes through the renderer. */}
        {attachments.length > 0 && (
          <ul className="mt-1.5 space-y-1 select-text">
            {attachments.map((ref) => (
              <li key={ref.uploadId} className="space-y-1">
                {files !== null && previewable(ref.mime, ref.bytes) && (
                  <ImagePreview
                    cacheKey={`u:${ref.uploadId}`}
                    fetcher={() => files.fetchUpload(ref.uploadId)}
                    alt={ref.name}
                  />
                )}
              <div
                className="flex items-center gap-1.5 rounded-md border border-edge/60 bg-surface/60 px-2 py-1 text-2xs"
              >
                <Icon as={Paperclip} size={11} className="shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate font-mono">{ref.name}</span>
                <span className="shrink-0 text-faint">{formatBytes(ref.bytes)}</span>
                {files !== null && (
                  <button
                    type="button"
                    aria-label={`Download ${ref.name}`}
                    title={`Download ${ref.name}`}
                    onClick={() => void files.downloadUpload(ref.uploadId, ref.name)}
                    className="tap shrink-0 rounded p-0.5 text-faint hover:text-fg"
                  >
                    <Icon as={Download} size={11} />
                  </button>
                )}
              </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
