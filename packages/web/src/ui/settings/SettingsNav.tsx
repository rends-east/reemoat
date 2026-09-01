import type { ReactNode } from "react";
import { navigate } from "../../router";
import { GROUP_TITLES, navRows, settingsPath, type SettingsSection } from "../../settings";
import type { AppState } from "../../store";
import { RailRow, SETTINGS_HEADING } from "../bits";

/**
 * The list of settings sections, and nothing else.
 *
 * It used to be a rail in the app's own aside, carrying a `Header` with the only
 * way out of settings and a "N waiting" badge. Both are gone, and the badge is the
 * one worth explaining: it was here because at `lg` this component *replaced*
 * `SessionBrowser`, so leaving settings open on a wide screen made every blocked
 * row in the fleet invisible — the one property this whole app is shaped around.
 *
 * Settings is a pop-up now, so the rail is never replaced; it is *covered*, by a
 * scrim on a desktop and by 92dvh of sheet on a phone. The obligation is unchanged
 * and only its reason moved, so the badge moved with it — into `Sheet`, which
 * reads the count itself rather than taking a prop, because a prop is a convention
 * the third caller forgets. `/new/:machineId` gains one it never had as a result.
 *
 * Still one component in two places: the 224px column beside the section at `sm`,
 * and the whole body below it. That is what stops the two drifting into different
 * orders or different labels.
 *
 * ⚠ **It is a landmark and a list, and it was a stack of bare `<div><button>`.**
 * There was no `<nav>`, so a screen reader had no way to skip to or from the
 * navigation of a pop-up whose other half is a whole screen; there was no list, so
 * nothing said how many sections there are or which of them you are on; and the
 * group heading ("Server") was a `<div>` wearing heading type, which is the one
 * thing a heading is *for* — being in the heading tree — thrown away to keep the
 * markup flat. All three are free: the row primitive is untouched.
 */
export function SettingsNav({
  state,
  active,
  paneName,
  variant,
}: {
  state: AppState;
  active: SettingsSection | null;
  /**
   * The name of the screen the pane beside this rail is drawing, for the live
   * region below. `null` only where `settingsPaneTitle` is — a route naming no
   * section — and the caller substitutes `DEFAULT_SECTION` before asking,
   * because that is what the pane draws there. So the `null` does not arrive:
   * the type is that function's signature rather than a state.
   *
   * ⚠ **Handed down rather than derived here, and that is a repair.** It was
   * `rows.find(({ spec }) => spec.id === active)?.spec.title` — "read off the
   * same `active` the highlight is, so the wash and the sentence can never name
   * different rows". That property was real and it was about the *rows*; the
   * sentence is about the *pane*, and the two part company one level in.
   * `Settings.tsx` branches on `drilled` **before** `SectionBody`, so at
   * `/settings/machines/:id`, `…/systems` and `…/agents` the pane draws a
   * machine's own screen while this said "Machines" — and on a desktop it said it
   * beside a visible `<h2>Machine settings</h2>`, the two halves of one chrome
   * disagreeing in the same paint. Derived from a value that cannot see the depth
   * it is naming, it could not have been right.
   *
   * It is the caller's `settingsPaneTitle` over the route the *body* reads, so
   * the announcement and the heading are one string rather than two derivations
   * of it — the discipline `Settings.tsx` already keeps for `up` and `upLabel`.
   *
   * Required rather than optional even though only `rail` reads it. Optional, a
   * third mount omits it and gets a live region that is still in the DOM and has
   * nothing to say — a failure with no symptom, which is exactly why
   * `IconButton`'s `size` is required and not defaulted.
   */
  paneName: string | null;
  /** `rail` is the 224px column beside the section at `sm`; `page` is the sheet body below it. */
  variant: "rail" | "page";
}): ReactNode {
  /*
   * `navRows` rather than `visibleSections` plus a `group` read here, and the bug
   * it prevents is invisible to the only people who could report it: a heading
   * computed from the static table draws "Server" above **nothing** for a
   * non-admin, whose visible list has no rows in that group — and only an admin
   * ever sees this nav in a correct state.
   *
   * It also keeps `previous`-row bookkeeping out of JSX, which is the other way
   * a grouped list goes wrong.
   */
  const rows = navRows(state.me);

  return (
    /*
     * ⚠ **Both variants get the landmark, and only one of them is ever in the
     * accessibility tree.** `Settings.tsx` mounts this twice and hides one with
     * `hidden sm:block` / `sm:hidden` — `display: none`, which removes the whole
     * subtree — so two `<nav aria-label="Settings">` in the DOM are never two
     * landmarks with one name at any width. That is `AppShell`'s standing rule
     * paying for itself again: the breakpoint is a class string, so this file does
     * not have to know which one is showing.
     */
    <nav aria-label="Settings" className="py-1">
      <ul>
        {rows.map(({ spec, heading }) => (
          /*
           * ⚠ **`aria-current` rides the item, not the button, and that is a
           * limitation rather than a preference.** `RailRow` is shared with the
           * market's rail precisely so two rails one tap apart cannot measure
           * differently, and it forwards no attributes — so the alternatives were a
           * second hand-rolled copy of the row (the drift `webcheck` pins against)
           * or setting the attribute on the DOM node behind React's back. On the
           * item it is still in the accessibility tree and still read before the
           * row it labels; it is simply not on the focused element.
           *
           * ⚠ **`undefined` rather than `"false"`.** React omits the attribute
           * entirely, so an inactive row is an ordinary list item — the same
           * discipline `Empty`'s `role` and `IconButton`'s `active` already keep.
           */
          <li
            key={spec.id}
            aria-current={variant === "rail" && spec.id === active ? "page" : undefined}
          >
            {heading !== null && (
              /*
               * The app's one settings-heading typography, at the nav's own `px-4`
               * so heading and rows share a left edge. Deliberately **not**
               * `MENU_HEADING`: that is the same type at `text-faint` with popover
               * padding, and it would sit misaligned against these rows.
               *
               * ⚠ **Inside the item it precedes rather than beside it**, because a
               * `<ul>` may hold nothing but `<li>` and the alternative is the
               * `previous`-row bookkeeping in JSX that `navRows` exists to remove.
               * The cost is that the group's first row is announced as one item
               * carrying a heading, which is what it looks like on screen anyway.
               */
              <h2 className={`px-4 pt-4 pb-1 ${SETTINGS_HEADING}`}>{GROUP_TITLES[heading]}</h2>
            )}
            {/* The row is `bits.tsx`'s, shared with the market's rail: two rails one
                tap apart inside sheets that look the same must not measure
                differently. What is *not* shared is this list, which is `navRows`
                for the reason above. */}
            <RailRow
              title={spec.title}
              blurb={spec.blurb}
              active={variant === "rail" && spec.id === active}
              onClick={() => navigate(settingsPath(spec.id))}
            />
          </li>
        ))}
      </ul>
      {variant === "rail" && (
        /*
         * ⚠ **What a tap on this rail actually did, said out loud.** At `sm` and
         * above the rail stays put and the *pane beside it* is replaced, with no
         * focus move and nothing announced — so a screen reader user pressed a row
         * and the app appeared to do nothing at all. Below `sm` there is no rail
         * and the row is an ordinary list → detail navigation, which announces
         * itself by changing the screen; hence the `rail` gate, which is also the
         * only place `variant` decides anything besides the highlight.
         *
         * ⚠ **Announced rather than focused.** Moving focus into the pane on every
         * tap takes the rail away from somebody who is stepping through it to see
         * what is there, and there is no control in a pane that is reliably the
         * thing they wanted.
         *
         * ⚠ **Mounted with the pop-up and only its text swapping**, which `Sheet`,
         * `EventList` and the builder's search box all record as the one
         * arrangement that reliably announces — a `role="status"` inserted in the
         * same paint as its content is commonly not spoken at all, VoiceOver on iOS
         * included. It says nothing at mount for the same reason: a live region
         * announces changes, and the first render is not one.
         *
         * `sr-only` is `absolute`, so it takes no layout and the rail's own
         * geometry is untouched. Silent for a sighted reader, who can see which
         * pane is drawn.
         */
        <p role="status" aria-live="polite" className="sr-only">
          {paneName}
        </p>
      )}
    </nav>
  );
}
