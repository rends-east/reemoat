import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { optionShortcut } from "../keys";
import { COLUMN, IconButton, Spinner } from "./bits";
import { currentLayers, decisionShortcutsEnabled, useDismissible } from "./overlay";

/**
 * The agent is waiting on you, whichever way it asked.
 *
 * **One card, one shape, for every agent.** claude asks through ACP elicitation
 * and kimi asks through `session/request_permission`; measured 2026-08-06, kimi
 * has its own `AskUserQuestion` and surfaces it as a permission titled
 * `AskUserQuestion` with each answer an `allow_once` option. Two channels, one
 * fact — so `PermissionCard` and `ElicitationCard` are two bodies inside this one
 * frame rather than two cards that resemble each other. What used to be "the same
 * class list, typed twice" is now a component, which is the only version of
 * "unified" that survives the next edit to either of them.
 *
 * Nothing here *detects* that a permission is a question — that decision is
 * `askedQuestion`'s, and it is made from ACP's own option-kind enum rather than
 * from any string an agent chose. What this file decides is only how the result
 * is drawn: an answer is a **row**, a decision about a tool call is a **button**.
 *
 * **It is a popup above the composer, and it covers nothing else.** `absolute`
 * inside the conversation region — not `fixed` over the viewport, which was tried
 * and is wrong: a parked question makes one *session* unanswerable, not the app,
 * so the session list, the header and every other agent stay live. It is out of
 * flow, so the transcript behind it does not shift by a pixel and
 * `SessionView`'s `ResizeObserver` never sees it mount.
 *
 * **No scrim and no blur, which is a reversal.** The first version dimmed the
 * conversation behind a `bg-ink/40 backdrop-blur`, on the reasoning that a
 * blocker should look like one. What that actually did was smear the text you
 * need in order to answer — the question is *about* the conversation. The card is
 * opaque, everything around it is untouched, and reading what is underneath is
 * what the collapse control is for.
 *
 * What the card does still sit on is the foot of the transcript, including the
 * *jump to latest* button. That is left alone rather than raised above it: a
 * parked agent is producing nothing, the transcript was already at its end when
 * the request landed, and one control that folds the whole card away is a better
 * answer than a second control floating over it.
 */

export interface AskOption {
  id: string;
  label: string;
  description?: string | null;
  /** The agent's own wording, when the label is ours. A tooltip, never drawn. */
  hint?: string | null;
  /** Drawn as picked. Only a multi-select and a re-tappable choice ever set it. */
  chosen?: boolean;
  busy?: boolean;
  /** In `buttons` layout: sits left of the gap. A refusal, kept away from the thumb. */
  leading?: boolean;
  /** In `buttons` layout: the filled one. At most one. */
  primary?: boolean;
  onPick: () => void;
}

/**
 * How the options are drawn, and the distinction is **answer versus decision**.
 *
 * `rows` is a list of things you could say: an elicitation's choices, and kimi's
 * `AskUserQuestion` arriving down the permission route. They are full-width rows
 * because each carries its own description and because there can be twenty-four
 * of them.
 *
 * `buttons` is a decision about one tool call — allow, allow always, deny. Three
 * at most, no descriptions, and position means something: this is the row every
 * confirmation dialog draws, with the refusal at the far left and the reversible
 * approval filled at the far right.
 */
export type AskLayout = "rows" | "buttons";

/**
 * How much of the conversation this card may take, as **whole class strings**.
 *
 * Literal, and a table rather than an interpolation, because Tailwind v4 reads
 * this file as *text*: a class assembled from fragments emits no CSS at all and
 * fails by silently having no height rule, which is the worst possible way for a
 * height to be wrong.
 *
 * ⚠ **`100%` is what actually governs, and the first number is a ceiling on it
 * rather than a target.** The frame is `absolute inset-0` inside the conversation
 * region, so `100%` *is* that region — roughly 640px of an 844px viewport on a
 * 390×844 phone, i.e. about 76dvh, and less in a short desktop window. At `tall`
 * the `min()` therefore resolves to `100%` in every realistic geometry, and the
 * honest reading of it is *"as tall as the region allows, and not one pixel over
 * the session header or the composer"*. Nobody should try to make 88 literal:
 * the only routes out of the region are a `z-index` or a portal, and the docblock
 * at the return statement records the measured regression that caused.
 *
 * `dvh` rather than `vh`: everything else in this app that measures the viewport
 * is `dvh` (`h-dvh` on the shell, `92dvh` on a sheet), and on iOS `vh` is the
 * *largest* viewport, so it over-measures whenever the URL bar is showing.
 *
 * `tall` is spent on a plan and nothing else. A `Bash` approval is one line; the
 * paragraph below measures the ordinary card at 92% of the conversation already,
 * and growing that for a one-line request buys nothing while costing the last
 * transcript row on the requests that least need it.
 */
const BOX_MAX = {
  normal: "max-h-[min(70dvh,100%)]",
  tall: "max-h-[min(88dvh,100%)]",
} as const;

export type AskSize = keyof typeof BOX_MAX;

/**
 * The number beside an answer, which is a **keyboard** shortcut and nothing else.
 *
 * On a phone it is a digit next to every option that presses nothing, on the one
 * card in this app where every glyph is competing for a 390px row — and beside a
 * *refusal* it reads as an ordering somebody chose rather than as a key. The
 * handler is left alone: a tablet with a bluetooth keyboard still answers on `2`,
 * and hiding the label is the whole of what a touch device needs.
 *
 * **Keyed on the pointer and deliberately not on a breakpoint.** `sm:` would say
 * "a narrow window has no keyboard", which is false and would take the numbers off
 * a half-width desktop browser; `pointer: coarse` is the actual question. Same
 * medium as `shouldFocusComposer`'s own `pointerCoarse` clause, which declines to
 * raise a soft keyboard for the same class of reason.
 *
 * A whole class string in a table, for {@link BOX_MAX}'s reason: Tailwind reads
 * this file as text.
 */
const KEYS_ONLY = "pointer-coarse:hidden";

/**
 * An unpicked row, and there is exactly one look because **this card has no
 * colour on it**.
 *
 * There used to be five: `ok` fills for the two approvals, `danger` for the two
 * refusals, neutral for an answer. The measurement that killed them is what an
 * ordinary `Write` looked like — three tinted blocks stacked down the card, the
 * loudest thing on screen for the most routine event there is, and a shape that
 * had nothing in common with the question card beside it.
 *
 * What the colour was carrying is carried by **position and weight** instead: a
 * refusal is alone on the left of the button row, the reversible approval is the
 * one filled button on the right, and the labels are the agent's own words. That
 * also settles the contrast problem the old table spent a paragraph on — there is
 * no pale fill left to fade a label towards.
 *
 * Hover is here rather than inline because it was missing on the answer rows
 * entirely, so on a desktop nothing in the card looked pressable. `.tap` carries
 * the transition.
 */
/*
 * `edge-strong`, and on this card it is a correctness rule rather than a taste.
 *
 * These rows have no fill of their own — they are `bg-surface` on a panel that is
 * also `bg-surface`, so the fill is 1.00:1 and the border is the *only* thing
 * saying a control is there. `index.css` states the rule at the token: `edge` is a
 * decorative hairline, 1.45:1 here, and **may never be the sole identification of
 * a control**; `edge-strong` is held at ≥3:1 for exactly this case, which is what
 * every other unfilled control in the app (`BUTTON_TONE.plain`, `FIELD`, the
 * composer's textarea) already uses.
 *
 * It matters most here of anywhere. On a permission the filled `bg-fg` pill is the
 * approval, so with a hairline refusal beside it the only option that reads as a
 * button is the one that says yes; on a question every answer is one of these, and
 * four 44px rows drew as four lines of plain text until one was chosen.
 */
const ROW = "border-edge-strong bg-surface text-fg hover:bg-raised";

/**
 * What a picked answer looks like: border, fill and edge *thickness* together.
 *
 * Three signals for one state, which is what the accent was carrying alone — and a
 * *state* rather than a kind, which is why it is not the filled `bg-fg` treatment
 * the primary button gets. That fill means "the reversible option" everywhere in
 * this app, and a chosen answer is not making that claim.
 *
 * **The border stepped up to `fg` when `ROW` took `edge-strong`, and it had to.**
 * This was `border-edge-strong` while an unpicked row was `border-edge`, so the
 * three signals were real; the moment an unpicked row needed `edge-strong` to be
 * identifiable as a control at all, the two shared a border and this was quietly
 * down to two. `fg` is the next step and the only one — it is the value the focus
 * ring uses, i.e. "the app is pointing at this" — and it stays a border rather
 * than becoming a fill, so the one thing `bg-fg` means here is untouched.
 *
 * ⚠ **The third signal used to be `font-medium`, and it moved the card.** Tapping
 * an answer grew that row by a line and pushed every row under it down, reported
 * from a phone with the picked row visibly one line taller than the same row
 * unpicked. The weight never reached the label — that span carries its own
 * `font-medium` and is 500 in both states — so the only thing it ever changed was
 * the `text-2xs` *description*, which is the one thing on the row that wraps. A
 * 500 cut of the UI face runs about 2.4% wider than the 400 cut (measured in a
 * headless browser: 553.27px against 540.17px for one line of a real answer), and
 * over five real descriptions at every row width from 320 to 760px, 27% of those
 * widths gain a line from the weight alone — 18px of `text-2xs` line-height,
 * charged to every row below it. A signal that reflows the text it is applied to
 * is not a third signal.
 *
 * `ring-1 ring-inset` is a `box-shadow`, so it cannot move anything at any width.
 * It thickens the same `fg` line the border already draws, which is the *shape*
 * axis this palette spends on the blocked dot rather than a fourth tone; `inset`
 * and flush against the border rather than the focus ring's `outline-offset: 2px`,
 * because a focused row and a picked row must stay two different marks even though
 * `fg` is deliberately one value. `Composer.tsx`'s drop target is the same idiom
 * for the same reason: a state that may not move what it is drawn on. Q3.421.
 */
const CHOSEN = "border-fg bg-raised text-fg ring-1 ring-fg ring-inset hover:bg-edge";

export function AskCard({
  title,
  detail,
  collapsed,
  onToggle,
  onDismiss,
  dismissLabel,
  dismissDisabled = false,
  more,
  options,
  layout = "rows",
  busy,
  context,
  extra,
  actions,
  size = "normal",
}: {
  /** One line at the top: the question, or the tool being asked about. */
  title: string;
  /** Under it, when there is something to say — "Question 2 of 3". */
  detail?: ReactNode;
  collapsed: boolean;
  onToggle: (next: boolean) => void;
  /** The ✕, and Escape. Always the destructive read of "I am not answering this". */
  onDismiss: () => void;
  dismissLabel: string;
  dismissDisabled?: boolean;
  /** Other requests parked behind this one. */
  more: number;
  /** The numbered answers. May be empty — a form of text fields has none. */
  options: AskOption[];
  layout?: AskLayout;
  busy: boolean;
  /** What is being asked about, *above* the answers. This is the part that scrolls. */
  context?: ReactNode;
  /** Anything under the answers — the agent's own "Other" box lands here. */
  extra?: ReactNode;
  /** The footer row: Back, Skip, Submit. Never scrolls. */
  actions?: ReactNode;
  /** How much room the card may take. See {@link BOX_MAX}. */
  size?: AskSize;
}): ReactNode {
  /*
   * The number beside each row, wired.
   *
   * Bound on `window` in the capture phase for the same reason Escape is: the
   * composer is directly underneath and takes the caret on its own, and
   * `optionShortcut` refuses while anything is being typed into — which is what
   * makes a bare digit safe on a card that can approve `rm -rf`.
   *
   * Off entirely while collapsed: the card is one line then, no number is on
   * screen, and a shortcut you cannot see is a shortcut you press by accident.
   *
   * **And off entirely under a sheet, which is the same sentence one layer out.**
   * `inert` on `#root` stops taps and focus and explicitly does not stop a
   * `window` keydown — `overlay.ts` says so at the predicate — so without this the
   * card is reachable by digit while it is covered: `App.tsx` keeps the session
   * mounted behind a pop-up, and `Sheet` focuses a `tabIndex={-1}` div, which
   * `isTypingInto` answers false for. A bare `1` then resolved a parked permission
   * on a card nobody could see, an `allow_always` scope among the options. That is
   * the failure `keyboard.ts` already tests for on `j`/`k`; this listener is the
   * one that *decides* rather than navigates, and it went without.
   *
   * Asked inside the handler rather than in the effect body: the layer stack moves
   * without re-rendering this card, so a value read at subscribe time would be the
   * stack as it was when the question was asked.
   *
   * No dependency array, like the Escape handler below. `options` is rebuilt on
   * every render — each `onPick` closes over this render's draft — so a list of
   * dependencies would either be `[options]`, which re-subscribes just as often,
   * or a stale set of closures answering with yesterday's answer.
   */
  useEffect(() => {
    if (collapsed || busy) return;
    const onKey = (event: KeyboardEvent): void => {
      // `decisionShortcutsEnabled`, not `shortcutsEnabled`: that one blocks only a
      // sheet, so a session menu or the config bar popover open over a parked
      // question left a keystroke aimed at the menu resolving the permission
      // underneath it. Navigating under a menu is fine; deciding is not.
      if (!decisionShortcutsEnabled(currentLayers())) return;
      const index = optionShortcut(event, event.target, options.length);
      if (index === null) return;
      const option = options[index];
      if (option === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      option.onPick();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  /*
   * **Escape folds the card away. It does not cancel, and that is a correction.**
   *
   * It used to abandon the tool call, capture-phase on `window`, with an
   * unconditional `stopPropagation` before it had decided whether to act. Two
   * things were wrong with that and the second is the serious one.
   *
   * A capture-phase `stopPropagation` at `window` ends the dispatch there — the
   * rest of the capture walk, the target phase and the whole bubble walk never
   * happen. So with a card on screen, Escape stopped reaching `Composer`'s menu
   * dismiss, `useKeyboard`'s blur, and every popover in `bits.tsx`: typing `/`,
   * changing your mind and pressing Escape left the menu open **and cancelled the
   * agent's request**. And with the card collapsed to one line, the same key
   * abandoned a tool call with nothing on screen explaining what had happened —
   * the very reason the digit shortcuts above switch themselves off while
   * collapsed.
   *
   * Escape means "put this overlay away", which is what it means everywhere else
   * and is the one reading that is not destructive. Cancelling stays on the ✕,
   * where it is deliberate and where a keyboard reaches it by tabbing.
   *
   * **The rule survived; the listener did not.** All of the above is now
   * `overlay.ts`'s `escapeAction`, and this card is one registered participant in
   * it rather than the loudest of five components each binding `window` and hoping.
   * Two things fall out that this could not do on its own: with a sheet open over
   * the session, Escape closes the *sheet* and leaves this card exactly as it was —
   * where before it would have folded a card nobody could see — and the
   * "typing wins" clause is now one rule the composer's menu and the "Other" box
   * are consequences of, rather than three components agreeing by hand.
   */
  useDismissible("ask", () => onToggle(true), !collapsed);

  /*
   * ⚠ **These two were 26px squares two pixels apart, on the one card in this app
   * that can approve `rm -rf`.**
   *
   * `p-1.5` around a 14px glyph is 26px of box, and `gap-0.5` is 2px between them —
   * so the control that folds the card away to read the conversation underneath sat
   * directly against the control that abandons the agent's request. Both are named
   * in this file's own prose as load-bearing: the docblock at the top says "reading
   * what is underneath is what the collapse control is for", and `onDismiss` is
   * documented as "Always the destructive read of 'I am not answering this'".
   *
   * The standard was already argued 300 lines below, at {@link AskAction}: *"44px —
   * like every other target in this app… It was `min-h-9`, i.e. 36px, on the one row
   * in this UI where a mis-tap approves something."* `OptionRow` and `OptionButton`
   * are both `min-h-11`. These two were missed, and they are the two a thumb reaches
   * for first on a card that can cover 92% of the conversation.
   *
   * `IconButton size="lg"` is 44px of real box, and it is deliberately **not**
   * `size="sm"`'s symmetric `after:-inset-2.5`: at this spacing a grown target would
   * put each control 10px onto its neighbour's *face*, which is precisely what
   * `TAP_GROW_Y`'s note warns about at a wider gap than this one. `gap-1` separates
   * the benign control from the destructive one. It costs the title ~60px of a
   * 358px header, which it absorbs by wrapping — `wrap-anywhere`, not `truncate`.
   *
   * It also retires the fifth hand-rolled copy of the class string `IconButton`
   * exists to eliminate; `label` there is required, so neither can ship nameless.
   */
  const toggle = (
    <IconButton
      icon={collapsed ? ChevronRight : ChevronDown}
      size="lg"
      onClick={() => onToggle(!collapsed)}
      title={collapsed ? "Show the question" : "Fold it away and read the conversation"}
      label={collapsed ? "Expand this request" : "Collapse this request"}
      expanded={!collapsed}
    />
  );

  const dismiss = (
    <IconButton
      icon={X}
      size="lg"
      onClick={onDismiss}
      disabled={dismissDisabled}
      title={dismissLabel}
      label={dismissLabel}
    />
  );

  const controls = (
    <div className="flex shrink-0 items-center gap-1">
      {more > 0 && <MoreWaiting count={more} />}
      {toggle}
      {dismiss}
    </div>
  );

  /*
   * `inset-0` with `justify-end`, and both halves of that are load-bearing.
   *
   * **`justify-end`** is what puts the card at the foot of the conversation
   * without it having to know how tall the composer is — the composer is outside
   * this region entirely, so `bottom` here *is* the top of the composer.
   *
   * **`inset-0` rather than `bottom-0`** is what bounds it. A card anchored to the
   * bottom grows upwards, and `absolute` is not clipped by an ancestor with no
   * `overflow` — so on a short screen a long form would have painted straight over
   * the session header. As a flex item in a container the height of the region,
   * `max-h-full` cannot.
   *
   * `pointer-events-none` on the frame, `auto` on the card: the frame now covers
   * the whole conversation, and without it every tap and every wheel event meant
   * for the transcript would land on an empty box instead.
   *
   * **There is no `z-index` here and its absence is deliberate — a bare
   * `absolute` is exactly what a later reader "fixes" by adding one back.** It
   * carried `z-30` for one revision and that was a regression, measured in a
   * headless browser rather than argued: the composer's root is `backdrop-blur`,
   * which creates a stacking context while itself being `z-index: auto`, so the
   * `z-40` on `CommandMenu` and on every `MENU_PANEL` in `AgentConfigBar` is
   * *trapped inside it*. A positive z on this frame therefore outranks all of
   * them from the outside: typing `/` with a card up drew 267 of the menu's 280
   * pixels behind the card, and `elementFromPoint` over a menu row returned an
   * answer button — so a tap aimed at a command answered the agent's question
   * instead, on a card that can approve `rm -rf`. At `auto` the paint order is
   * tree order, which is already right: after the transcript (so the card covers
   * it, jump-to-latest button included) and before the composer (so its menus
   * open over the card, which is what opening a menu means).
   *
   * **`overlay.ts` now has a `LAYER` table with a `z-50` in it, and that is not
   * available here.** Said explicitly because the arrival of a working overlay
   * layer makes "and give the ask frame a z-index so it matches the rest" look
   * like tidying, and it is the regression above. `Sheet` gets away with a
   * positive z because it is a `createPortal` child of `document.body` — outside
   * `#root` entirely, competing with nothing in this subtree. This card is
   * `absolute` inside one session's conversation region on purpose (see the note
   * at the top of this file: a parked question makes one *session* unanswerable,
   * not the app), so it has no such escape and does not want one.
   */
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-end px-3 pb-2">
      {collapsed ? (
        /*
         * One line, and it keeps both controls.
         *
         * Collapsing must not become a way to lose the request: the bar still
         * says what is being asked, still expands, and still cancels. It is the
         * same frame at one row high rather than a different component, so the
         * card cannot come back looking like something else.
         */
        <div
          className={`${COLUMN} animate-rise pointer-events-auto flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-edge-strong bg-surface py-1.5 pr-1 pl-3 shadow-2xl`}
        >
          {/*
           * ⚠ **`wrap-anywhere`, not `truncate`, and this is the one place on this
           * card where that was ever in question.**
           *
           * A collapsed bar is one line by intent and it has a control that opens
           * it, so clipping looked defensible — and it is exactly what the rule
           * this release is built on forbids: *nothing an agent asked may reach a
           * person shortened.* The daemon stopped clipping a question's prose and a
           * permission's title in the same commit; leaving a CSS ellipsis over the
           * result would move the same loss one layer out, where it is worse
           * because nothing can even say it happened.
           *
           * `min-h-11` stays the floor rather than the height, so a short title
           * still draws the same 44px bar it always did and a long one grows the
           * bar instead of hiding its own end. `py-1.5` is what makes the grown
           * case sit off the edges; the controls are `shrink-0` and unaffected.
           */}
          <span className="min-w-0 flex-1 text-xs font-medium wrap-anywhere">{title}</span>
          {controls}
        </div>
      ) : (
        /*
         * Four regions, and which of them may give up height is a safety decision
         * rather than a layout one.
         *
         * The title and the footer are `shrink-0` and everything else bends around
         * them, because the one thing this card must never do is clip the controls
         * — `bits.tsx` carves out its whole "every option visible at once"
         * exception for exactly that.
         *
         * The two boxes in between each scroll and each has a floor. That is what
         * makes a landscape phone survive: region 227px, a `max-h-[45vh]` answer
         * box wanting 169 and a header and footer wanting 99 comes to 268, and with
         * the answers pinned `shrink-0` the footer went out of the bottom under
         * `overflow-hidden` with nothing to say so. Shrinkable, flexbox's own
         * min/max resolution settles it: the answers give up the difference and
         * scroll inside themselves, and `min-h-12` on the context is what stops the
         * diff you are approving collapsing to nothing to pay for it.
         *
         * **The portrait budget, which the paragraph above works through landscape
         * in detail and never states: this card can take 92% of the conversation.**
         * On a 390×844 phone the region is roughly 640px and `min(70dvh,100%)`
         * resolves to 590 of them, leaving about one transcript row visible behind
         * it. That is intended — a parked question is meant to be the loudest thing
         * in the app — but it is *why* the collapse control has to be a real 44px
         * target rather than the 26px one it was, and somebody asked to "make the
         * card smaller" should know which of the four numbers they are reaching for
         * before they start.
         *
         * At `size="tall"` — a plan, which is a document rather than a line — the
         * ceiling rises to the region itself and the card takes all of it. That
         * changes a `max-height` and nothing structural, which is the whole reason
         * it is safe: raising a max can only ever give flexbox more room to resolve
         * in. Re-run the landscape arithmetic above at its minimums — header ~44 +
         * the context floor 48 + a shrinkable answer box + footer ~60 — and 227px
         * of region still resolves without pushing the footer out, which is the
         * failure that paragraph exists to prevent. See {@link BOX_MAX}.
         *
         * `max-h-[45vh]` on the answers is deliberately left in `vh` here: it
         * governs every question card, its floor was measured in `vh`, and mixing
         * a units change into a size change on the one region this does not need
         * would make a regression there unattributable. It is the file's remaining
         * outlier and is named so nobody thinks it was missed.
         */
        <div
          className={`${COLUMN} animate-rise pointer-events-auto flex ${BOX_MAX[size]} min-h-0 flex-col overflow-hidden rounded-lg border border-edge-strong bg-surface shadow-2xl`}
        >
          <div className="flex shrink-0 items-start gap-1 px-3 pt-2.5 pb-2">
            <div className="mt-1 min-w-0 flex-1">
              <p className="text-sm font-medium wrap-anywhere">{title}</p>
              {detail !== undefined && detail !== null && (
                <div className="mt-0.5 text-2xs text-faint">{detail}</div>
              )}
            </div>
            {controls}
          </div>

          {context !== undefined && context !== null && (
            <div className="min-h-12 flex-1 overflow-y-auto border-t border-edge/60 px-3 py-2.5">
              {context}
            </div>
          )}

          {((layout === "rows" && options.length > 0) || (extra !== undefined && extra !== null)) && (
            <div className="max-h-[45vh] min-h-0 space-y-1.5 overflow-y-auto border-t border-edge/60 px-3 py-2.5">
              {layout === "rows" &&
                options.map((option, index) => (
                  <OptionRow key={option.id} option={option} index={index} disabled={busy} />
                ))}
              {extra}
            </div>
          )}

          {(layout === "buttons" ? options.length > 0 : actions !== undefined && actions !== null) && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-edge/60 px-3 py-2.5">
              {/*
               * Two groups rather than one row with a `flex-1` spacer between the
               * halves, which is what this was.
               *
               * **A spacer only spaces the line it is on.** As long as everything
               * fits, `[refusal] <spacer> [approvals]` reads as the left/right rule
               * that replaced the colour on these buttons. The moment the row wraps
               * — a narrow phone, or an agent sending more than three — the spacer
               * eats the first line and the rest land wherever they land, so the
               * rule silently stops holding while still looking deliberate.
               *
               * Nesting makes it structural: refusals left, approvals right, each
               * group wrapping inside itself — so the rule holds at any width and a
               * wrap costs alignment rather than meaning.
               *
               * ⚠ **`permissionLayout` exists now, and this comment is the record of
               * how long it did not.** It was named here for a release as "the other
               * half — past a certain size these stop being buttons at all", then
               * corrected to say there was no such function and there never had
               * been: `layout` was chosen in `PermissionCard.tsx` by
               * `asked !== null` with no size input at all. That mattered because
               * the missing fallback was load-bearing in somebody else's argument —
               * `drawableOptions` was justified partly by it, and in its absence
               * grew wide enough to delete a model's own answers.
               *
               * It is built. `permissionLayout` reads the rendered labels and
               * answers `rows` when a button row will not hold them, so an option
               * is never removed for want of room. The correction stays written
               * down rather than replaced with a clean sentence, because what it
               * records is the shape of the mistake: a comment promising a safety
               * net is worse than no comment, and the way that ends is somebody
               * building the net.
               */}
              {layout === "buttons" && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    {options.map((option, index) =>
                      option.leading === true ? (
                        <OptionButton key={option.id} option={option} index={index} disabled={busy} />
                      ) : null,
                    )}
                  </div>
                  <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
                    {options.map((option, index) =>
                      option.leading === true ? null : (
                        <OptionButton key={option.id} option={option} index={index} disabled={busy} />
                      ),
                    )}
                  </div>
                </>
              )}
              {actions}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * How many more are parked behind this one.
 *
 * It used to be a full-width strip under the card — `N more waiting after this
 * one` — which was another thing mounting and unmounting between the transcript
 * and the composer. As a chip in the card's own header it moves nothing, and it
 * survives the collapse, which the strip did not.
 */
function MoreWaiting({ count }: { count: number }): ReactNode {
  return (
    <span
      title={`${count} more request${count === 1 ? "" : "s"} waiting after this one`}
      className="shrink-0 rounded-sm bg-raised px-1.5 py-0.5 text-2xs text-muted tabular-nums"
    >
      +{count}
    </span>
  );
}

/**
 * One answer, in the one shape every agent's answers get.
 *
 * Left-aligned with its own description, rather than a centred label in a
 * coloured pill. The centred version was written for two or three approve/reject
 * buttons and fell apart the moment the same channel started carrying questions:
 * kimi's four-answer `AskUserQuestion` drew as four identical green buttons with
 * nowhere to put what each one meant.
 *
 * The number on the right is what {@link optionShortcut} presses.
 */
function OptionRow({
  option,
  index,
  disabled,
}: {
  option: AskOption;
  index: number;
  disabled: boolean;
}): ReactNode {
  return (
    <button
      onClick={option.onPick}
      disabled={disabled}
      title={option.hint !== undefined && option.hint !== null && option.hint !== option.label ? option.hint : undefined}
      /*
       * ⚠ **`primary` reaches this layout now, and it has to.** A decision whose
       * labels will not fit a button row is drawn here instead of having an option
       * deleted (see `permissionLayout`), and the whole reason a button row is
       * legible without colour is *position plus the one filled control*. Carrying
       * the order over and dropping the fill would land the reader on a column of
       * identical rows where one of them writes a standing policy rule to the
       * agent's disk. `bg-fg` is licensed here by the same clause it is licensed on
       * the button — the affirmative action inside a decision, and nothing else.
       *
       * Inert for every other caller: an elicitation's answers and a kimi question
       * set no `primary`, because none of their options is the reversible one.
       */
      className={`tap press relative flex min-h-11 w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left disabled:opacity-40 ${
        option.primary === true
          ? "border-fg bg-fg text-ink hover:bg-fg/90"
          : option.chosen === true
            ? CHOSEN
            : ROW
      }`}
    >
      {/*
       * The label always renders and the spinner is positioned over the row
       * rather than replacing it. Swapping the text out changed the button's
       * content and moved it, at the exact moment of the tap.
       */}
      {option.busy === true && (
        <span className="absolute top-1/2 left-1 -translate-y-1/2">
          <Spinner />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium wrap-anywhere">{option.label}</span>
        {option.description !== null && option.description !== undefined && (
          <span
            className={`mt-0.5 block text-2xs wrap-anywhere ${option.primary === true ? "text-ink/70" : "text-muted"}`}
          >
            {option.description}
          </span>
        )}
      </span>
      {index < 9 && (
        <span
          className={`mt-0.5 shrink-0 text-2xs tabular-nums ${KEYS_ONLY} ${
            option.primary === true ? "text-ink/50" : "text-faint"
          }`}
        >
          {index + 1}
        </span>
      )}
    </button>
  );
}

/**
 * One decision, as a button.
 *
 * **No colour at all**, which is a deliberate removal rather than an omission. The
 * options carried `ok`/`danger` fills, and three tinted blocks stacked down the
 * card made an ordinary `Write` read as an incident — the loudest thing on screen
 * for the most routine event there is. What the colour was carrying is carried
 * better by *position and weight*: the refusal is alone on the left, the
 * reversible approval is the one filled button on the right, and the labels are
 * the agent's own words.
 *
 * The number is what {@link optionShortcut} presses, and it is drawn after the
 * label rather than before it so the labels line up with each other.
 */
function OptionButton({
  option,
  index,
  disabled,
}: {
  option: AskOption;
  index: number;
  disabled: boolean;
}): ReactNode {
  return (
    <button
      onClick={option.onPick}
      disabled={disabled}
      title={option.hint !== undefined && option.hint !== null && option.hint !== option.label ? option.hint : undefined}
      className={`tap press relative flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs font-medium disabled:opacity-40 ${
        option.primary === true
          ? "bg-fg text-ink hover:bg-fg/90"
          : // `edge-strong` at rest for `ROW`'s reason — this is the *refusal*
            // on a permission card, the one option that must never read as
            // "there was no way to say no" — and the hover therefore moves the
            // fill rather than the border, which it could not do while the border
            // was carrying the identification.
            "border border-edge-strong bg-surface text-fg hover:bg-raised"
      }`}
    >
      {option.busy === true && (
        <span className="absolute left-1.5 flex items-center">
          <Spinner />
        </span>
      )}
      {option.label}
      {index < 9 && (
        <span className={`tabular-nums ${KEYS_ONLY} ${option.primary === true ? "text-ink/50" : "text-faint"}`}>
          {index + 1}
        </span>
      )}
    </button>
  );
}

/**
 * A footer button. One height and one radius, so Back, Skip and Submit line up.
 *
 * `min-h-11` — 44px — like every other target in this app and like the answer
 * rows above. It was `min-h-9`, i.e. 36px, on the one row in this UI where a
 * mis-tap approves something.
 */
export function AskAction({
  onClick,
  disabled = false,
  busy = false,
  tone = "plain",
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: "plain" | "quiet" | "primary";
  title?: string;
  children: ReactNode;
}): ReactNode {
  const look =
    tone === "primary"
      ? // The same filled button an approval gets, and neutral for the same
        // reason: this card carries no colour, so weight is what says "this is
        // the one you probably want".
        "bg-fg text-ink hover:bg-fg/90"
      : tone === "quiet"
        ? "text-muted hover:bg-raised hover:text-fg"
        : // `edge-strong` for `ROW`'s reason — this arm is Back and Skip, and it
          // has no fill of its own on a panel that is `bg-surface`, so the border
          // is its only identification and `edge` is 1.45:1 there. The hover then
          // moves the fill only: with the base already at `edge-strong`, a
          // `hover:border-edge-strong` would have been a no-op announcing itself
          // as a state change.
          "border border-edge-strong text-muted hover:bg-raised hover:text-fg";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`tap press relative flex min-h-11 items-center gap-1 rounded-md px-3 text-xs font-medium disabled:opacity-40 ${look}`}
    >
      {busy && (
        <span className="absolute left-2 flex items-center">
          <Spinner />
        </span>
      )}
      {children}
    </button>
  );
}
