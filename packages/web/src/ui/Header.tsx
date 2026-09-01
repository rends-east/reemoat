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
          /*
           * `lg`, and it must stay whatever the kebab opposite it is — the block
           * below is where that argument lives, because it is a fact about the
           * *pair* rather than about this control.
           */
          size="lg"
          className="-ml-1 lg:hidden"
        />
      )}
      {/*
       * **Centred below `lg`, left-aligned from `lg` up, and the split is about what
       * is beside it rather than about taste.**
       *
       * Below `lg` this bar has a control on each side — the back chevron and the
       * session's kebab — and both are `IconButton size="lg"`, i.e. 44px, so the
       * middle column is genuinely centred on the screen and the title reads as a
       * phone navigation bar. Left-aligned there it sat against neither edge: pushed
       * off the left by the chevron and stopping short of the right, so it reads
       * as having drifted rather than as having been placed.
       *
       * ⚠ **They were 36px, and what this paragraph asserts is that they are
       * *equal* rather than that they are any particular number.** `md` was the
       * default and has been deleted from `ICON_BUTTON_SIZE` for being the one
       * entry that never reached the platform's 44px tap minimum, so both of these
       * had to be named again — and they had to be named the same thing, or the
       * middle column stops being centred and the sentence above stops being true.
       *
       * `lg` rather than `sm`, on three measurements. **The glyph does not move**:
       * the primitive derives 16px for `lg` exactly as it did for `md`, while `sm`
       * would draw the phone's only way back at 12px. **Nothing is taken from the
       * title**: `sm` reaches 44px with an `after:-inset-2.5`, which is 10px into
       * an 8px `gap-2` and therefore 2px onto the face of whatever the middle
       * column starts with — and what it starts with, on the one screen this bar
       * serves, is `SessionTitle`, a `<button>` that renames the session. `lg`
       * reaches 44px with the box and reaches onto nothing. **And the bar stops
       * jumping**: this row is `items-center`, so its height is the taller of the
       * controls and the block beside them, and that block is 40px on a loaded
       * session (`SessionTitle` is `text-sm`, a 22px line box, over an 18px
       * `text-2xs` subtitle) against 25px on `SessionView`'s skeleton header, which
       * is this same bar with a `text-base` word and no subtitle. At 36px those
       * came out 40px and 36px, so landing on a session moved the transcript under
       * it by 4px; at 44px both are 44px and it moves by none. The loaded bar is
       * four pixels taller than it was, which is the whole cost, and it buys a
       * shift nobody had written down. (Renaming already governs either way: the
       * inline `<input>` is 28px, so that bar is 46px whichever of these two sizes
       * the controls take.)
       *
       * Neither control exists above `lg` (`lg:hidden` on both), so this pair is
       * touch-only and there is no pointer for a 44px hover ground to look heavy
       * to. Every *other* kebab in this app is `sm`, and correctly: those sit on
       * list rows, where the box has to stay smaller than the row it is on. This
       * one is one of three things in a navigation bar.
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
        {/*
         * **`<h1>`, and it is the only heading on this app's primary screen.**
         *
         * This was a plain `<div>`, so a screen reader's heading list was *empty*
         * on the conversation — the screen everything else in this product exists
         * to get you to. The rail has `<h1>Reemoat</h1>` and its folders are
         * `<h2>`; `Sheet` argues its own head up to `<h1>` because `inert` takes
         * the app's out of the tree behind it. Only this bar, the one screen that
         * below `lg` *replaces* the list outright, arrived with nothing spoken at
         * all.
         *
         * Two `<h1>`s at `lg` is not a collision: the rail is `AppShell`'s
         * `<aside>` and this is inside its `<main>`, both sectioning content, and
         * they name two different things — the app, and the screen you are on.
         *
         * **The caller's `<button>` stays inside it**, exactly as the rail's folder
         * toggles sit inside their own `<h2>` — that is the app's existing shape for
         * a heading whose words are the thing you press.
         *
         * ⚠ **`SessionMenu`'s docblock says rename on the title "made a heading
         * double as a control", and this element makes that literally true where it
         * used to be a figure of speech.** It is still not the defect that sentence
         * names. The complaint was that rename and pin had *nowhere else to go*, so
         * the only way to act on a session was to press its name; the kebab is what
         * answered it, and `.claude/rules/web-shell.md` keeps rename on the title
         * deliberately on top of that — the title is the discoverable path and the
         * menu is the one a thumb finds without knowing the title is a button. What
         * changes here is only that the name is now announced as the screen's name,
         * which is the half that was missing.
         *
         * Nothing in `index.css` styles a heading element and Tailwind's preflight
         * resets the size, weight and margin, so the swap is visually inert — the
         * class string is the one this `<div>` already carried.
         */}
        <h1 className="flex min-w-0 items-center justify-center gap-1.5 lg:justify-start">{title}</h1>
        {subtitle !== undefined && (
          <div className="flex min-w-0 justify-center text-2xs text-muted lg:justify-start">{subtitle}</div>
        )}
      </div>
      {children}
    </header>
  );
}
