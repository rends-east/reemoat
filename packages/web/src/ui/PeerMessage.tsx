import { useContext, useState, type ReactNode } from "react";
import { refTarget } from "../mentionLinks";
import { peerBody, peerHeadlineParts } from "../peer";
import type { PeerOrigin } from "../wire";
import { Markdown } from "./Markdown";
import { MentionLink, MentionScope } from "./MentionLink";

const PREVIEW_LINES = 6;

/** Another agent wrote this, so it is never a person's bubble: left-aligned, headed by who sent it. */
export function PeerMessageRow({
  from,
  text,
  waiting,
  onResized,
}: {
  from: PeerOrigin;
  text: string;
  waiting: boolean;
  onResized: () => void;
}): ReactNode {
  const body = peerBody(text);
  const lines = body.split("\n");
  const long = lines.length > PREVIEW_LINES;
  const [open, setOpen] = useState(false);
  const here = useContext(MentionScope).here;
  const { lead, name, where } = peerHeadlineParts(from);
  // The daemon's own record of the sender, so the link is to that session and never to another holding the name.
  const sender = here === null ? null : refTarget(from.ref, from.machineId ?? here);

  if (from.kind === "notice") {
    return <p className="my-3 px-1 text-2xs text-faint">{body}</p>;
  }
  return (
    <div className="my-6 rounded-lg border border-edge bg-surface/60 px-3.5 py-2.5">
      <p className="text-2xs font-medium text-muted">
        {lead} <MentionLink name={name} exact={sender} />
        {where}
      </p>
      <div className="mt-1.5 min-w-0 select-text">
        {/* Keyed so a toggle mounts a fresh Markdown: a changed text waits out the stream throttle, and the label would move first. */}
        <Markdown key={open ? "all" : "preview"} text={long && !open ? lines.slice(0, PREVIEW_LINES).join("\n") : body} />
      </div>
      {long && (
        <button
          onClick={() => {
            setOpen(!open);
            onResized();
          }}
          aria-expanded={open}
          className="tap mt-1 rounded-sm py-1 text-2xs text-faint hover:text-fg"
        >
          {open ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
      {waiting && <p className="mt-1 text-2xs text-faint">Waiting for the agent to finish</p>}
    </div>
  );
}
