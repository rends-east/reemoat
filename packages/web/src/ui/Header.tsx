import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { navigate } from "../router";
import { LAYER } from "./overlay";
import { IconButton } from "./bits";

/**
 * The sticky top bar of a screen.
 *
 * There were three copies of it — one per screen — and they had already drifted in
 * padding. The safe-area padding is the part that actually matters: without
 * `pt-safe` the title sits under the notch, and it is exactly the sort of thing
 * that gets left off the fourth copy.
 *
 * **There is still no back button, and the arrow is not one.** This control used to
 * call `history.back()`, which meant it went wherever you happened to have been — a
 * session you had already left, the settings screen, or out of the app entirely on a
 * fresh load. An app with one list and one detail view does not have a history worth
 * replaying; it has a place to return *to*. So it is a `close`: it always goes to
 * that one place, and it is hidden at `lg` where the rail is already showing the
 * list and the button would send you somewhere you can see you already are.
 *
 * **What changed is the glyph and nothing else.** A ✕ on a full-screen phone view
 * reads as "discard this", and what the control actually does is go up one level to
 * the list — which is what a phone user reaches for and what `ChevronLeft` is the
 * platform's word for. The destination is still fixed and still `/`; the docblock
 * above is the rule and it is untouched. **Do not make this `history.back()` on the
 * strength of the arrow** — that is the defect this comment has been carrying a
 * warning about since before the icon matched it.
 *
 * **`closeTo` and `close="always"` are gone, and the rule they carried is not.**
 * Both existed for Settings, which had two levels and no row in the list to close
 * back to. Settings is a pop-up now, so `Sheet` owns that problem: its ✕ goes to
 * the path recorded in `history.state` (`useUnder`) and its ◀ to `settingsUp` —
 * both fixed destinations derived from the URL, which is this docblock's rule
 * unchanged, now expressed by two functions a driver can assert rather than by a
 * prop nothing could. This bar is one screen's bar again, and its one destination
 * is the list.
 */
export function Header({
  title,
  subtitle,
  close = false,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Show the leading close. Hidden at `lg`, where the rail makes it redundant. */
  close?: boolean;
  children?: ReactNode;
}): ReactNode {
  return (
    <header
      className={`pt-safe sticky top-0 ${LAYER.header} flex items-center gap-2 border-b border-edge bg-surface/85 px-3 pb-3 backdrop-blur`}
    >
      {close && (
        // "Back to sessions" and not "Back": the label has to name the fixed
        // destination, because that is the whole difference between this and the
        // history button it must never become.
        <IconButton
          icon={ChevronLeft}
          label="Back to sessions"
          onClick={() => navigate("/")}
          className="-ml-1 lg:hidden"
        />
      )}
      {/*
       * **Centred below `lg`, left-aligned from `lg` up, and the split is about what
       * is beside it rather than about taste.**
       *
       * Below `lg` this bar has a control on each side — the back chevron and the
       * session's kebab — and both are `IconButton size="md"`, i.e. 36px, so the
       * middle column is genuinely centred on the screen and the title reads as a
       * phone navigation bar. Left-aligned there it sat against neither edge: pushed
       * off the left by the chevron and stopping short of the right, so it reads
       * as having drifted rather than as having been placed.
       *
       * At `lg` the chevron is `lg:hidden` and so is the kebab, so there is nothing
       * on either side and centring would put the title in the middle of a wide pane
       * for no reason, away from the rail it belongs beside. Left is right there.
       *
       * The subtitle follows the title rather than being centred on its own: they
       * are one block, and a centred name over a left-aligned path reads as a
       * mistake. It is a flex row rather than a `truncate` block because its one
       * caller passes `WorkspaceLine`, which is itself a flex and truncates its own
       * parts — `text-center` cannot move a block-level flex child, and this is the
       * arrangement that centres it without touching what it renders.
       */}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center justify-center gap-1.5 lg:justify-start">{title}</div>
        {subtitle !== undefined && (
          <div className="flex min-w-0 justify-center text-2xs text-muted lg:justify-start">{subtitle}</div>
        )}
      </div>
      {children}
    </header>
  );
}
