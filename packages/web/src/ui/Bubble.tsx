import { Download, Paperclip } from "lucide-react";
import type { ReactNode } from "react";
import { formatBytes } from "../paths";
import { previewable } from "../preview";
import type { PromptAttachmentRef } from "../wire";
import type { FileAccess } from "./files";
import { ImagePreview } from "./ImagePreview";
import { Markdown } from "./Markdown";
import { Icon, Spinner } from "./bits";

/**
 * What the person said, drawn the way a messenger draws it.
 *
 * There were three of these and they looked like three different things: the
 * `prompt` event was a full-width bordered card, an agent-echoed `role: "user"`
 * text run was bare accent-coloured markdown with no container at all, and the
 * composer's optimistic echo was a third card with its own border and opacity. The
 * same sentence therefore rendered differently depending on which path it arrived
 * by — and none of the three was distinguishable at a glance from the agent's own
 * output, which on a phone is the entire reading problem.
 *
 * One component, three call sites, so they cannot drift again.
 *
 * **Agent text stays full-bleed and left**, deliberately. The asymmetry is what
 * makes a conversation readable; bubbling the agent's side too would halve the
 * width of the thing people are actually here to read.
 */
export function UserBubble({
  text,
  pending = false,
  attachments = [],
  files = null,
}: {
  text: string;
  pending?: boolean;
  attachments?: readonly PromptAttachmentRef[];
  files?: FileAccess | null;
}): ReactNode {
  if (text.trim().length === 0 && !pending && attachments.length === 0) return null;
  return (
    /*
     * **Room above and below, and it belongs here rather than on the run.**
     *
     * The transcript's rhythm is `space-y-1.5` — 6px, which is right between two
     * steps of one turn and far too tight around a turn *boundary*. Your message
     * and the reply to it were 6px apart, so a conversation read as one column of
     * text with the sides alternating rather than as an exchange.
     *
     * `my-4` on the bubble's own row, symmetric, because the boundary is on both
     * sides of it: what comes before is the end of the agent's last turn and what
     * comes after is the beginning of the next. Margins collapse with nothing here
     * (`space-y-*` is a margin on the sibling, and adjacent margins in a
     * block-level run take the larger), so consecutive messages do not accumulate
     * gaps. It is on the *wrapper* rather than on the filled box so the bubble's
     * own shape is untouched — which matters because all three call sites share
     * that box and only this one is a turn boundary.
     */
    <div className="my-4 flex justify-end">
      <div
        /*
         * `w-fit` + `ml-auto` is what makes it hug its content instead of spanning
         * the column; `max-w-*` is what stops a paragraph running the full width of
         * a desktop pane. Both in CSS, with no breakpoint state in JavaScript —
         * `AppShell` is explicit that a resized window must not be able to render a
         * layout that is not there.
         *
         * `min-w-0` is load-bearing rather than defensive. `Markdown`'s table
         * wrapper and its code blocks scroll with `overflow-x-auto`, and an
         * overflow container can only scroll if its flex ancestor is allowed to
         * shrink below its content. Without this a long line inside a user bubble
         * widens the transcript column and pushes the rail off the screen — the
         * exact failure `AppShell` documents `min-w-0` for.
         *
         * **`36rem` and not `46rem`, and the old number was a cap that never
         * capped.** `COLUMN` is `max-w-3xl` — 48rem — so 46 was 96% of the
         * measure: a paragraph you sent still ran the full width of the reading
         * column and the bubble was legible only as a fill, never as a shape.
         * Three quarters of the column is what makes "you said this" readable at
         * a glance from the *outline*, before any colour is involved, which is
         * the whole job of the asymmetry this component exists for.
         *
         * A `rem` cap rather than the `%` it sits beside, for a reason the
         * percentage half still has: the three call sites are inset differently
         * (`px-4` in the transcript, `px-3` for the composer's echo), so a
         * percentage renders the same sentence at two widths as it moves from
         * echo to committed prompt. The `85%` survives only below `lg`, where
         * there is one inset and hugging the screen edge is what is wanted.
         */
        className="ml-auto w-fit min-w-0 max-w-[85%] rounded-xl rounded-br-md bg-raised px-3.5 py-2.5 lg:max-w-[36rem]"
      >
        {/*
         * The event's own string, passed through untouched.
         *
         * `Markdown` is memoised on `text`, and a run in flight is reparsed on
         * every arriving chunk — so building the string here (interpolating a
         * status, appending a space, joining anything) would defeat that memo on
         * every render. Whatever this needs to show *about* the message goes
         * outside the memoised child, as `pending` does below.
         */}
        <Markdown text={text} tone="user" />
        {/*
         * Chips, and they go **here** rather than into `text`.
         *
         * The docblock above is not decorative: appending a filename or a
         * `![](blob:…)` to the string would defeat `Markdown`'s memo on every
         * render *and* route a URL through the markdown renderer, which is the
         * one place this client deliberately keeps untrusted input away from.
         *
         * A preview goes above the chip rather than instead of it, so a picture
         * that will not load still leaves a name and a download button. The
         * decision is `previewable` and the drawing is `ImagePreview`; the rules
         * both of them keep — the four-type allowlist excluding `image/svg+xml`,
         * bytes via `fetch` with the header and never a URL in the DOM, `<img>`
         * and nothing else — live in those two modules rather than here.
         */}
        {attachments.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {attachments.map((ref) => (
              <li key={ref.uploadId} className="space-y-1">
                {/* Drawn only for the four raster types under the preview cap —
                    and the size is known here without fetching anything, because
                    the daemon put `mime` and `bytes` on the event. That is what
                    makes a preview of somebody's own attachment free of the
                    "fetch it to find out how big it is" problem. */}
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
        {pending && (
          <p className="mt-1 flex items-center gap-1.5 text-2xs text-muted">
            <Spinner /> sending
          </p>
        )}
      </div>
    </div>
  );
}
