import { Check, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { AgentConfigOption } from "../wire";
import { labelFor } from "./agentConfig";
import type { ChoiceRow, CommandEntry } from "./commands";
import { Icon, MENU_HEADING, MENU_PANEL, menuRow, Spinner } from "./bits";

/**
 * The composer's command menu.
 *
 * A sibling of `Dropdown` rather than an instance of it, and the difference is
 * not cosmetic: `Dropdown` owns its own open state and renders a trigger button,
 * while this one's openness is derived from the *text* and it must never take
 * focus — the caret has to stay in the textarea or an input method has nothing to
 * compose into. What it borrows is the chrome, by importing the same constants
 * rather than by copying a class list.
 *
 * **`bottom-full`, always, and never measured.** `Dropdown` says why: choosing a
 * direction by asking the window is breakpoint-state-in-JavaScript wearing a
 * different hat. A caret-following popup would break the same rule twice over —
 * it needs a mirror element and text metrics — and on a phone it would put the
 * panel under the thumb that is typing. Anchored to the composer's full width
 * instead, above the box, where the soft keyboard cannot cover it.
 *
 * Both lists are drawn here and neither is computed here: `active` is an index
 * into whichever one is showing, and the arrow keys that move it live in the
 * textarea's own handler. Deriving the rows in two places is how the row the
 * keyboard is on stops being the row the eye is on.
 */
export function CommandMenu({
  entries,
  choices,
  active,
  stage,
  busy,
  dropped,
  anchorRef,
  onHover,
  onChoose,
  onChooseValue,
  onDismiss,
}: {
  entries: readonly CommandEntry[];
  /** Non-null exactly when a control was picked and is being valued. */
  choices: readonly ChoiceRow[] | null;
  active: number;
  stage: AgentConfigOption | null;
  /** The value being applied, so the row that was pressed can say so. */
  busy: string | null;
  /** How many commands the daemon had to cut. Drawn, never silently swallowed. */
  dropped: number;
  /** The textarea this menu belongs to, which a pointer-down must not treat as outside. */
  anchorRef: RefObject<HTMLTextAreaElement | null>;
  onHover: (index: number) => void;
  onChoose: (index: number) => void;
  onChooseValue: (index: number) => void;
  onDismiss: () => void;
}): ReactNode {
  const boxRef = useRef<HTMLDivElement | null>(null);

  /*
   * Outside-pointerdown dismissal, the same as every other menu here and for the
   * same reason: the panel is made of buttons, and closing on blur would fire
   * before the click that chose one landed.
   *
   * **The textarea is not outside.** It was, and that made repositioning the
   * caret dismiss the menu — and while a control's choice list is up, `onDismiss`
   * also drops the stage, after `completion` had already cleared the box. Tapping
   * into your own draft threw the `/model` gesture away with nothing on screen to
   * say so. Moving the caret out of the token already closes the menu on its own,
   * through the query going null, which is the honest way for it to happen.
   *
   * No Escape listener, which is the one deliberate difference from `Dropdown`.
   * Escape is handled on the textarea's own `onKeyDown` — it has to be, because
   * that is also where the keystroke is stopped from reaching `useKeyboard`'s
   * global blur, and two handlers racing for one key is how one of them wins on
   * a platform nobody tested.
   */
  useEffect(() => {
    const close = (event: Event): void => {
      const target = event.target as Node;
      if (boxRef.current?.contains(target) === true) return;
      if (anchorRef.current?.contains(target) === true) return;
      onDismiss();
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onDismiss, anchorRef]);

  /*
   * Keep the highlighted row on screen.
   *
   * The panel scrolls and the highlight is an index, not focus — so nothing moves
   * the viewport on its own. Measured against the list this actually gets: the
   * panel holds about five rows and claude publishes a hundred, so arrowing past
   * the fifth moved a highlight nobody could see, and the wrap from last back to
   * first left the scroll parked at the bottom.
   *
   * `block: "nearest"` because it is the one that does nothing when the row is
   * already visible; anything else jerks the list on every keystroke.
   */
  useEffect(() => {
    boxRef.current?.querySelectorAll("[role=option]")[active]?.scrollIntoView({ block: "nearest" });
  }, [active, choices, entries]);

  return (
    // The heading sits outside the listbox: a `listbox` may only contain options
    // and groups, so a `<p>` in there is a stray node in the accessibility tree —
    // and `aria-label` already carries the same words.
    <div
      ref={boxRef}
      className={`absolute right-3 bottom-full left-3 mb-1 ${MENU_PANEL} max-h-[min(18rem,50dvh)]`}
    >
      {/* Through `labelFor`, not `stage.name`: this heading is one tap from the
          `/effort` row that opened it, and on kimi the agent's own word for that
          control is "Thinking". Two names for one thing, that close together, is
          the inconsistency `labelFor` exists to close. */}
      {stage !== null && <p className={MENU_HEADING}>{labelFor(stage)}</p>}
      <div id="composer-command-menu" role="listbox" aria-label={stage === null ? "Commands" : labelFor(stage)}>
      {stage !== null && choices !== null ? (
        <>
          {choices.map((choice, index) => {
            const selected = stage.value === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                role="option"
                // Both branches carry ids now, and they share one namespace
                // because only one branch is ever mounted. Without one here the
                // textarea's `aria-activedescendant` had nothing to point at in
                // the stage that changes the agent's model.
                id={`composer-command-${index}`}
                // Not a tab stop. The composite widget is the textarea; these are
                // reached with the arrows and `aria-activedescendant`. Left
                // focusable, Shift+Tab out of the box landed on the last row —
                // where the arrow keys do nothing (that handler is on the
                // textarea), Escape does nothing, and the only handler is
                // `onMouseDown`, so Enter and Space do nothing either.
                tabIndex={-1}
                aria-selected={index === active}
                // The value actually in force, which `aria-selected` cannot say
                // while it is carrying the highlight, and which the tick says
                // only to people who can see it.
                aria-current={selected}
                // `preventDefault` on mousedown and the work on click — not the
                // work on mousedown. The `preventDefault` is what stops focus
                // leaving the textarea (the caret has to stay put or an input
                // method has nothing to compose into); it does *not* cancel the
                // click that follows. Acting on mousedown instead left `onClick`
                // unbound, so activation that dispatches only a click — a screen
                // reader's double-tap, `element.click()` — reached a dead row.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChooseValue(index)}
                onMouseEnter={() => onHover(index)}
                className={`${menuRow("start")} ${index === active ? "bg-raised" : ""} ${
                  selected ? "font-medium" : ""
                }`}
              >
                <span className="mt-0.5 w-3 shrink-0">
                  {busy === choice.value ? <Spinner /> : selected && <Icon as={Check} size={11} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {choice.label}
                    {selected && <span className="sr-only"> (current)</span>}
                  </span>
                  {choice.description !== null && (
                    <span className="block text-2xs text-faint">{choice.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </>
      ) : (
        entries.map((entry, index) => (
          <button
            key={`${entry.kind}:${entry.name}`}
            type="button"
            role="option"
            id={`composer-command-${index}`}
            tabIndex={-1}
            aria-selected={index === active}
            aria-current={entry.value !== null && entry.option?.value === entry.value}
            // Same pair, same reason as the choices branch above.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(index)}
            onMouseEnter={() => onHover(index)}
            // Highlighted by the keyboard's index rather than by `:hover`, so the
            // row the arrows are on and the row Enter will take are the same one.
            // `aria-selected` alone is invisible.
            className={`${menuRow("start")} text-fg ${index === active ? "bg-raised" : ""}`}
          >
            <span className="mt-0.5 w-3 shrink-0">
              {/* Three states in one column, because there are three kinds of row.
                  A tick means "this is what the control is set to already" — `/plan`
                  when you are in plan mode — and without it that entry looks inert
                  when it is in fact the answer. The sliders mark a control that is
                  not a message; a published command gets nothing, because it is the
                  ordinary case and an icon on every row is noise. */}
              {busy === entry.value && entry.value !== null ? (
                <Spinner />
              ) : entry.value !== null && entry.option?.value === entry.value ? (
                <Icon as={Check} size={11} className="text-fg" />
              ) : (
                entry.kind === "config" && <Icon as={SlidersHorizontal} size={11} className="text-faint" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="min-w-0 truncate font-medium">/{entry.name}</span>
                {/* ACP's hint is prose and is shown as prose. It is never inserted
                    — see `completion` in `commands.ts` for why. */}
                {entry.hint !== null && (
                  <span className="min-w-0 truncate text-2xs text-faint">{entry.hint}</span>
                )}
              </span>
              {/* Truncated in CSS, and that is what makes the byte cap in
                  `toCommands` a bound on the *payload* rather than on the row.
                  Measured, a skill's description can be a whole trigger paragraph
                  — 1135 characters on this machine — and three wrapped lines per
                  entry turns a hundred-command menu into a document. */}
              {entry.description.length > 0 && (
                <span className="block truncate text-2xs text-faint">{entry.description}</span>
              )}
            </span>
          </button>
        ))
      )}
      </div>
      {/* What the daemon had to cut, said out loud.
          `toCommands` counts rather than silently trims for exactly this reason —
          "a picker missing a row silently offers the agent less than it supports"
          — and a client that reads only `commands` makes that counter prove
          nothing. Quiet, one line, above nothing: the same treatment `placeNodes`
          gives `omitted`. Only in the command list; a control's choices are never
          cut. */}
      {stage === null && dropped > 0 && (
        <p className="px-2 py-1 text-2xs text-faint">
          {dropped} more the agent published are not shown
        </p>
      )}
    </div>
  );
}
