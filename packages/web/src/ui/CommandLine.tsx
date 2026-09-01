import { Check, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./bits";
import { copyText } from "./clipboard";

/**
 * A command to run in a terminal, with a control that copies it.
 *
 * **A flex row rather than a button positioned over the field**, which is what
 * this was and what made it hang off the edge: the control was `absolute` inside
 * a `<pre>` whose height came from its own text, so any padding mismatch pushed
 * it out. Two siblings under `items-stretch` cannot disagree about height — there
 * is no second measurement to get wrong.
 *
 * Both glyphs are mounted and swapped by opacity, and the tick reverts on a
 * timer: a confirmation that never leaves is a claim about a clipboard that has
 * long since moved on.
 *
 * **It lives in `ui/` rather than `ui/settings/` because it has two callers
 * now**: the agent panel's setup token, and the one-line installer on the
 * empty-fleet screens. It was moved verbatim — the two layout defects above
 * were paid for once and a second copy would have earned them again.
 *
 * The `<pre>` scrolls **inside its own box**. That matters where the second
 * caller draws it: `.claude/rules/web-shell.md` reserves the scrollbar gutter
 * on the transcript alone and names the rail as an exception that may not take
 * it back, and a contained scroller is not the rail scrolling.
 */
export function CommandLine({ command }: { command: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    /*
      * **The border is on the wrapper, not on the `<pre>`.** That is what puts the
      * control inside the field while leaving the two as ordinary flex siblings —
      * the version before this laid the button over the box with `absolute`, took
      * its height from the field's own text, and hung off the edge as soon as the
      * two padding values disagreed. Under `items-stretch` there is no second
      * measurement to get wrong.
      */
    <div className="mt-3 flex min-h-9 items-stretch overflow-hidden rounded-md border border-edge-strong bg-ink [@media(pointer:coarse)]:min-h-11">
      <pre className="flex min-w-0 flex-1 items-center overflow-x-auto px-3 font-mono text-2xs leading-5 text-fg">
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
        className="tap press relative flex w-11 shrink-0 items-center justify-center border-l border-edge-strong bg-surface text-muted hover:bg-raised hover:text-fg"
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
