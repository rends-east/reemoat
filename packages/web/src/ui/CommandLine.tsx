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
 * **The command fits on one line where the box is wide enough, and wraps at a
 * space where it is not; it never scrolls.** It used to be an `overflow-x-auto`
 * `<pre>`, and in the rail — 280px wide by default — the one-line installer
 * showed `curl -fsSL 'https://app.reemoat.test,` with a scrollbar under it and
 * the rest of the command, including the `| sh` that makes it one, off the
 * right edge. A command somebody is about to paste into a terminal has to be
 * readable whole before they do. No scroller at all is also the stronger reading
 * of `.claude/rules/web-shell.md`'s rule that the rail may not take back the
 * scrollbar gutter the transcript alone reserves.
 *
 * ⚠ **Sized to the narrowest box that draws it, measured.** Settings → Machines
 * is a `max-w-2xl` sheet with a 224px nav beside the pane: 408px of column, and
 * the installer is 52 characters. At `text-2xs` (12px, ~7.2px a character in
 * this mono) that is 375px against a 340px field, and the first draft wrapped
 * `install.s` / `h'` across two lines — `break-all` split the URL mid-word, which
 * read as broken rather than long. Three things put it on one line: 11px with
 * `tracking-tight` (~330px), `px-2.5` on the field, and a 36px copy control that
 * widens to the 44px touch floor only under a coarse pointer. `overflow-wrap:
 * anywhere` rather than `break-all`: a box that still cannot fit it — a 390px
 * phone is 306px inside — breaks at the space before `| sh`, and breaks inside
 * the URL only when the URL alone is wider than the box.
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
