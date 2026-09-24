import { Check, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./bits";
import { copyText } from "./clipboard";

/** Wraps at a space and never scrolls, so the command is readable whole before it is pasted; the copy control is a flex sibling, not overlaid. */
export function CommandLine({ command }: { command: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="mt-3 flex min-h-9 items-stretch overflow-hidden rounded-md border border-edge-strong bg-ink [@media(pointer:coarse)]:min-h-11">
      <pre className="flex min-w-0 flex-1 items-center whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-5 tracking-tight text-fg [overflow-wrap:anywhere]">
        {command}
      </pre>
      <button
        type="button"
        onClick={() => {
          void copyText(command).then((ok) => {
            if (ok) setCopied(true);
          });
        }}
        aria-label={copied ? "Copied" : `Copy ${command}`}
        className="tap press relative flex w-9 shrink-0 items-center justify-center border-l border-edge-strong bg-surface text-muted hover:bg-raised hover:text-fg [@media(pointer:coarse)]:w-11"
      >
        <Icon
          as={Copy}
          size={14}
          className={`absolute transition-opacity duration-300 ${copied ? "opacity-0" : "opacity-100"}`}
        />
        <Icon
          as={Check}
          size={14}
          className={`absolute transition-opacity duration-300 ${copied ? "opacity-100" : "opacity-0"}`}
        />
      </button>
    </div>
  );
}
