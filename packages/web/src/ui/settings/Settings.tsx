import type { ReactNode } from "react";
import {
  DEFAULT_SECTION,
  sectionAllowed,
  settingsPaneTitle,
  settingsUp,
  settingsUpLabel,
  type SettingsRoute,
  type SettingsSection,
} from "../../settings";
import type { AppState } from "../../store";
import { ChevronLeft } from "lucide-react";
import { navigate } from "../../router";
import { IconButton } from "../bits";
import { AccountSection } from "./AccountSection";
import { MachineSystemsSection } from "./MachineSystemsSection";
import { MachineSection } from "./MachineSection";
import { MachinesSection } from "./MachinesSection";
import { SettingsNav } from "./SettingsNav";
import { ServerSection } from "./ServerSection";
import { UsersSection } from "./UsersSection";

/**
 * Settings, as a pop-up over whatever you were looking at.
 *
 * **This reverses "settings is a page that takes the app over", and the property
 * that decision was protecting is better served by the reversal.** The old shape
 * put the section list into `AppShell`'s rail for as long as settings was open —
 * which is why `SettingsNav` had to carry a "N waiting" badge, since a wide screen
 * left on Settings otherwise made every blocked row in the fleet invisible. The
 * rail is never replaced now; it stays visible behind the scrim, and the badge
 * moved to `Sheet`, where it belongs to *anything* that covers the fleet view.
 *
 * The URL is untouched by all of this, which is the point: `/settings/…` still
 * deep-links, still survives a reload, and the phone's Back button still closes
 * the pop-up because the pop-up is a route. Not one assertion in `webcheck` about
 * `parseSettingsRoute`, `settingsPath`, `visibleSections` or `sectionAllowed`
 * needed changing.
 *
 * Inside: a 224px section rail beside the section at `sm` and above, the section
 * alone below that, and at index depth the section *is* the list. That is the same
 * `lg:hidden` / `hidden lg:block` pair this file already had, moved down to `sm` —
 * a sheet at `sm` is ~640px, which is wide enough for a rail and a form, whereas
 * the app's own split is measuring a 19.5rem rail against a transcript. Different
 * measurement, different breakpoint, still no breakpoint state in JavaScript.
 */
export function Settings({ state, route }: { state: AppState; route: SettingsRoute }): ReactNode {
  const section = route.section;
  /*
   * A typed URL is not a tap: a non-admin who types `/settings/users`, or an admin
   * whose flag was removed while the tab was open, falls back to the list rather
   * than to a screen whose every request would answer 403. `requireAdmin` on the
   * control plane is the guard; this only decides what is offered.
   */
  const active = section !== null && sectionAllowed(section, state.me) ? section : null;

  const drilled = active === "machines" && route.machineId !== null;
  /*
   * **Computed once, from the *collapsed* section, and fed to both functions.**
   *
   * `active` is `section` after `sectionAllowed` has had it, and that narrowing is
   * load-bearing here rather than incidental: a non-admin who types
   * `/settings/users` — or an admin whose flag was removed while the tab was open
   * — falls back to the index, so passing the raw `route` would draw a "Users"
   * heading over the list, with no chevron beside it because `settingsUp` (which
   * has always been given the collapsed object) correctly answers `null`. That is
   * a defect the pure-function assertions cannot see, because it lives at the call
   * site, which is why the two now read from one value.
   */
  const here = { ...route, section: active };
  /*
   * ⚠ **What the pane draws, which is not what the chrome computes.** `here`, `up`,
   * `paneTitle` and `upLabel` all keep reading `active` — the section the *URL*
   * names — and only the body below reads this. Fed to `settingsUp`, the default
   * answers `{path: "/settings", withinNav: true}`: a chevron, `sm:hidden`, on a
   * phone, pointing at the screen it is already on. The two must not be merged.
   */
  const shown = active ?? DEFAULT_SECTION;
  const up = settingsUp(here);
  const paneTitle = settingsPaneTitle(here);
  const upLabel = settingsUpLabel(here);

  return (
    /*
     * ⚠ **No `<Sheet>` here.** The panel is one element for every route-backed
     * pop-up, owned by `OverlaySheet` in `App.tsx`, so that moving between two of
     * them dissolves the contents instead of unmounting a panel and sliding a new
     * one up from the edge. This component is the *body*. Q3.484.
     *
     * The head still names the pop-up and nothing else — `Sheet`'s `<h1>` spans
     * the rail as well as the pane. The screen's name is `paneTitle`, drawn below
     * in the box it is about. Q3.427.
     */
    <div className="-mx-4 -my-5 flex min-h-0 flex-1 sm:-mx-5">
        {/*
         * The section list, beside the section. Hidden below `sm`, where the
         * section takes the whole body and the index renders the list into it —
         * the same list → detail the rest of the app uses, in the same direction.
         */}
        <div className="hidden w-56 shrink-0 overflow-y-auto overscroll-contain border-r border-edge sm:block">
          <SettingsNav state={state} active={shown} variant="rail" />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
           * **The way up, and the name of the screen it leaves, in one row.**
           *
           * The ◀ used to sit in `Sheet`'s head, 40px from the panel's left edge
           * and a whole 56px bar away from the thing it was a chevron *for* — with
           * `withinNav` re-derived independently in two files that could drift. It
           * is one element now and reads the field once. Q3.427 declined this move
           * because it would leave `Sheet` declaring an `up` it no longer read; the
           * prop is deleted rather than half-emptied. Q3.432.
           *
           * ⚠ Gated on `up !== null` **alone**, with `paneTitle` narrowing only the
           * `<h2>` inside. They are null together and `webcheck` asserts the
           * pairing, so this changes nothing today — but fused, a future depth with
           * no title would silently delete the only way back rather than merely go
           * unnamed.
           *
           * ⚠ `px-4 pt-4 sm:px-5` rides THIS row and the scroller below keeps its
           * own `px-4 py-4 sm:px-5` untouched, for the reason the old `mb-4` had to
           * ride the heading: at the four section depths this row is
           * `display: none` at `sm`+ and must take its top padding with it. It is
           * also why the padding may not be hoisted onto this column — the index
           * arm's `-mx-4 -my-4` cancels the scroller's, **on the scroller**.
           *
           * ⚠ No `overflow-y-auto` and no `overscroll-contain` on this column.
           * `SHEET_BODY` records the measurement: Chrome ends the scroll chain at a
           * container carrying `overscroll-behavior: contain` even when it has
           * nothing to scroll.
           */}
          {up !== null && (
            <div
              className={`flex shrink-0 items-center gap-2 px-4 pt-4 sm:px-5 ${
                up.withinNav ? "sm:hidden" : ""
              }`}
            >
              {/*
               * `size="sm"` is 24px of ink reaching 44px through `after:-inset-2.5`,
               * a positioned pseudo-element that costs no layout — so this row is
               * about the height the heading already was and the move buys no
               * vertical chrome. The label names the destination rather than saying
               * "Back", which is `Header`'s rule and the whole difference between
               * this control and the history button it must never become.
               *
               * `navigate(up.path, true)` — replace, because the chevron is
               * shallower by construction and `webcheck`'s composition invariant
               * proves it can never be otherwise. With `push`, Android's Back would
               * walk the sheet backwards instead of popping out of it.
               */}
              <IconButton
                icon={ChevronLeft}
                label={`Back to ${upLabel ?? "Settings"}`}
                size="sm"
                className="-ml-1"
                onClick={() => navigate(up.path, true)}
              />
              {/* No `truncate`: a machine name is what tells two hosts apart, and
                  this pane is 448px at 1280px and full width on a phone. */}
              {paneTitle !== null && <h2 className="min-w-0 text-base font-semibold">{paneTitle}</h2>}
            </div>
          )}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {active === null ? (
            <>
              <div className="-mx-4 -my-4 sm:hidden">
                <SettingsNav state={state} active={null} variant="page" />
              </div>
              {/*
               * ⚠ **No neutral state at `sm` and above.** "Pick a setting from the
               * list." was a pane whose only content was an instruction to use the
               * rail beside it — half of a 672px sheet spent saying nothing, on the
               * depth this pop-up opens at. The rail highlights `DEFAULT_SECTION`
               * and this draws it, both from the one constant, so they cannot point
               * at different rows.
               *
               * ⚠ `hidden sm:block` rather than a width read in JavaScript, which is
               * `AppShell`'s standing rule. The phone arm above keeps its `-mx-4
               * -my-4` cancelling the scroller's padding; at `sm` that child is
               * `display: none`, so its negative margins take nothing with them and
               * this one sits in the scroller's ordinary padding.
               */}
              <div className="hidden sm:block">
                <SectionBody state={state} section={DEFAULT_SECTION} />
              </div>
            </>
          ) : drilled && route.machineId !== null ? (
            /* The machine's own screen, and one level in, its systems. Both
               parse to the same `machineId`; the segment after it is what tells
               them apart. There is no plugin leaf here any more — a plugin's
               settings are on the plugin's page under `/plugins`, and the list on
               the machine screen links to it. */
            route.system === null ? (
              <MachineSection state={state} machineId={route.machineId} />
            ) : (
              <MachineSystemsSection
                state={state}
                machineId={route.machineId}
                system={route.system}
              />
            )
          ) : (
            <SectionBody state={state} section={active} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One section, and the whole of the mapping from a section id to a screen.
 *
 * ⚠ **A `switch` over the union rather than four `&&`s in the pane, because there
 * are two call sites now** — the section a URL names, and `DEFAULT_SECTION` where
 * it names none. A fifth member of `SettingsSection` has to be a compile error here
 * rather than a pane that silently renders nothing at one of the two.
 *
 * `config` is passed to two of them for the reason `UsersSection` states: what this
 * instance can do is not on `Me`, and the Email block promises a password reset an
 * instance with no SMTP can never perform. Passed rather than read from the store,
 * so a section stays a function of its arguments — which is what lets `webcheck`
 * reason about it at all.
 */
function SectionBody({ state, section }: { state: AppState; section: SettingsSection }): ReactNode {
  switch (section) {
    case "machines":
      return <MachinesSection state={state} />;
    case "account":
      return <AccountSection me={state.me} config={state.config} />;
    case "server":
      return <ServerSection />;
    case "users":
      return <UsersSection me={state.me} config={state.config} />;
  }
}
