import { ChevronDown, LogOut, Plus, Puzzle, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { errorText } from "../http";
import { marketPath } from "../market";
import { nativeAccounts, type NativeAccountList, type NativeAccountSummary } from "../native";
import { pluginPath, screenPlugins } from "../plugins";
import { navigate } from "../router";
import { settingsPath } from "../settings";
import { serverLabel } from "../slot";
import { sessionGroups, store, type AppState } from "../store";
import { APP_VERSION } from "../version";
import { Icon, Monogram, personEmoji } from "./bits";
import { currentView, groupsVersion, subscribeGroups } from "./groups";
import { useLeaving } from "./leaving";
import { LAYER, useDismissible } from "./overlay";
import { toast } from "./Toast";

/**
 * The **longest** the panel may outlive a close, and it is one number in two files.
 *
 * `--animate-drawer-out` in `index.css` is the movement; this is the ceiling on
 * the wait before the element stops existing. They have to agree or the panel
 * either vanishes mid-slide or leaves a dead layer on screen, and neither is
 * visible from the other file — so `webcheck` reads the duration out of the
 * stylesheet and asserts it against this constant.
 *
 * ⚠ **It is a backstop rather than the clock, and that is a correction to what
 * this said.** It *was* the clock: a bare `setTimeout(DRAWER_EXIT_MS)` decided
 * when the panel stopped existing, and because the `"sheet"` layer is registered
 * for exactly the panel's lifetime — see the `useDismissible` call below — it also
 * decided how long `#root` stays `inert`. Under `prefers-reduced-motion` that is
 * the wrong number by four orders of magnitude: the block at the foot of
 * `index.css` forces `animation-duration: 0.01ms !important` on everything, so the
 * panel is off the screen within a frame while this timer holds the app inert,
 * untappable and deaf to `j`/`k` for the remaining 260ms. That is the exact mirror
 * of the defect registering the layer on `open` produced, with the sign flipped,
 * and just as invisible to anything pointing at the screen. `animationend` on the
 * panel is the clock now; this number only decides anything when that event never
 * arrives, because an `inert` `#root` that is never handed back is worse than
 * either window.
 */
const DRAWER_EXIT_MS = 260;

/**
 * A row in this panel, and the reason it is not `menuRow`.
 *
 * `menuRow` is the *popover* row — `text-xs` in a floating panel a third of this
 * width, and it has six other callers. This is a drawer: it is the width of a
 * phone, it holds three things, and at `text-xs` with `text-muted` glyphs it read
 * as a list of footnotes rather than as the way out of this screen. Every chat
 * client draws this row at something near body size with the glyph in the same ink
 * as the words, and that is what this is.
 *
 * ⚠ **A separate constant rather than a prop on `menuRow`.** Adding a size there
 * changes six surfaces to fix one, and the two are not the same object that
 * happens to be drawn twice — one floats over content and the other is a
 * destination list. The cost is one more shared string in this file, which is the
 * cheaper of the two.
 *
 * `min-h-12` rather than `min-h-11`: the 44px floor is a *minimum*, and a row this
 * wide with a 18px glyph reads as cramped at exactly the floor.
 *
 * ⚠ **No weight, by the owner's call, and the paragraphs above survive it
 * untouched.** This carried `font-medium` and the head's name `font-semibold`; what
 * they were arguing for is the *size* and the *ink* — `text-sm` rather than
 * `text-xs`, the glyph in the same colour as the words — and neither of those
 * moved. Weight was doing a third job nobody asked it to: three rows and a name in
 * a 352px panel are already the only things in it, so emphasis had nothing to
 * separate them from. `DRAWER_HEADING` keeps its `font-semibold` because that is
 * the caps idiom rather than emphasis, and `webcheck.typography.ts` runs a census
 * over every site that spends it.
 */
const DRAWER_ROW = "tap flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm";

/**
 * A band naming what the rows under it are, at **this panel's** inset.
 *
 * ⚠ **Written out rather than composed from `MENU_HEADING`, and the reason is the
 * left edge.** `bits.tsx` gives that constant its own `px-2.5` on purpose — its
 * docblock says every *popover* heading wants the same 2.5 as the rows beneath it
 * and that "a heading that did not share that left edge is the one arrangement
 * worth preventing". This is not a popover: {@link DRAWER_ROW} is `px-3`, both sit
 * inside the same `px-1.5` scroller, and `MENU_HEADING` here put the word `screens`
 * 2px inboard of the rows it heads — the precise arrangement that constant exists
 * to stop, reached by importing it.
 *
 * ⚠ **And not `` `${MENU_HEADING} px-3` `` either.** Two padding utilities of one
 * family on one element are resolved by Tailwind's emission order rather than by
 * the order in the string, which `bits.tsx` records as a silent no-op and
 * `webcheck.typography.ts` sweeps for on the colour axis. `MachineSection`'s
 * `RETIRE_HEADING` and `AgentBuilder`'s `HIDDEN_PROVIDER_HEADING` are spelled out
 * for the same mechanical reason; `.claude/rules/web-typography.md` is the rule,
 * and the type below is byte-for-byte that file's one caps idiom — only the
 * padding is this panel's.
 *
 * `text-faint` is `MENU_HEADING`'s tone and is kept: the choice between the three
 * constants is a colour decision, and a heading sitting over rows that are
 * themselves the content is quieter than the rows. Nothing about the *type*
 * changes, which is what keeps this a fifth documented spelling of the idiom
 * rather than a fourth constant.
 */
const DRAWER_HEADING = "px-3 py-1.5 text-2xs font-semibold tracking-wider text-faint uppercase";

/**
 * Who you are, where you can go, and what build this is.
 *
 * **This replaced `ProfileMenu`, and the rule that file carried is the one thing
 * worth moving intact.** That was a row at the foot of the rail which opened a
 * popover, and its docblock set the test for what could be in it: *a row must be a
 * destination, it must be reached from nowhere else, and it must be about **you**
 * rather than about what is on screen.* All three still hold, and the second one is
 * why there is no `Account` row: Account is `DEFAULT_SECTION`, so Settings already
 * opens on it, and a row here would be the same door drawn twice. The head of this
 * panel is who you are; Settings is where you change it.
 *
 * **Two kinds of row now, and the test above is the first kind's.** Destinations
 * still pass it, and go through `go`. *Acts* about you are the second kind — Sign
 * out, and in the shell the accounts under the head (`AccountPanel`, below this
 * component): each closes the panel and then calls the store, never `go` or
 * `navigate`, because switching or adding an account is not a place in this
 * window's URL. Q3.642 is the entry for the panel.
 *
 * **What has not changed.** There is no Language row and no ellipsis of extras —
 * this app has no i18n and `index.css` explicitly refuses a theme switcher. `Sign
 * out` is last and separated, above the version, and drawn even when `me === null`:
 * `bootstrap`'s catch keeps `phase: "ready"` with no `me` when the control plane is
 * unreachable, and an outage is the worst moment for the way out to disappear. One
 * tap, no two-step confirm — the confirming pattern is a *row* pattern, question
 * and answer and undo laid out left to right, and it does not fit a panel this
 * narrow.
 *
 * ⚠ **`useDismissible("sheet")`, and `TaskPanel` is the wrong precedent to copy.**
 * That panel registers `"menu"` on purpose, because at `xl` it docks *beside* the
 * conversation with no scrim and `inert` on `#root` would kill the transcript it
 * was opened to read alongside. This one is scrim-backed at every width and never
 * docks. `"menu"` here would leave `shortcutsEnabled` true, and `keyboard.ts`
 * records exactly what that costs: `inert` stops taps and focus but **not** a
 * `window` keydown, so `j` and `k` would walk the session list behind an opaque
 * panel, navigating to sessions nobody can see.
 *
 * ⚠ **The kind is half of it; the *lifetime* is the other half, and it was wrong.**
 * The layer is registered on `shown` rather than on `open`, because the panel
 * outlives `open` by `DRAWER_EXIT_MS` and a layer registered on `open` pops at the
 * start of that window instead of the end — handing the app back its shortcuts and
 * its focus underneath a drawer that is still covering it. The argument above is
 * about which `LayerKind`; this is about when it is on the stack, and the wrong
 * answer to either produces the same `j`/`k` failure.
 *
 * ⚠ **There is no ✕ in the head, and this paragraph used to say there was.** It
 * argued the control as non-redundant with the scrim, in the present tense, for as
 * long as the control was already gone — which is the one class of comment this
 * repository treats as a defect rather than a nit. ⚠ It also mis-quoted `Sheet` as
 * calling "the rows behind it" the accessible way out, and that sentence is not in
 * that file: what `Sheet` says is **the ✕** is, which is the whole reason its
 * argument cannot be borrowed here. What survives the deletion is why the gap
 * exists at all — `inert` lands on `#root`, so the rows behind this panel are
 * precisely what cannot be reached, and nothing stands in for the control that
 * used to. Escape works through `useDismissible` and the scrim takes a tap, so the
 * population left with no exit is narrow; it is named, with the whole list of exits
 * and the owner's call behind the state, at the head `<div>` below and in Q3.628 —
 * once each, not a third time here. `aria-modal="true"` sits beside
 * `role="dialog"` for a reason of its own: the rest of the document really is out
 * of play, so saying so is a description rather than a claim.
 *
 * ⚠ **Portaled to `document.body`, and that is not tidiness either.** `inert` lands
 * on `#root`; a drawer rendered inside it inerts *itself* — visible, scrimmed and
 * completely untouchable, with nothing in the console. `Sheet` is portaled for this
 * reason and for a second one it states: `position: fixed` resolves against the
 * nearest `backdrop-filter` ancestor, and this app's header, composer and rail
 * footer are each one hop from one.
 *
 * **No focus trap and no `tabIndex` on the panel.** `overlay.ts` says outright that
 * `inert` is the mechanism and a hand-rolled trap must not be added. Every
 * interactive thing in here is a `<button>`, which is in `index.css`'s one
 * `:focus-visible` selector list — so nothing here is a focusable element type the
 * ring does not reach, which is the trap a `[role="dialog"][tabindex]` would fall
 * into.
 */
export function MenuDrawer({
  state,
  open,
  onClose,
}: {
  state: AppState;
  open: boolean;
  onClose: () => void;
}): ReactNode {
  /*
   * The selected machine, read from the same module state the rail reads.
   *
   * `ProfileMenu` took this as a prop because it was mounted inside
   * `SessionBrowser`, which already had a `view`. This is mounted in `App`, which
   * has none — and the fix is not to thread one down, because `groups.ts` is
   * where "which machine am I looking at" lives and a prop would be a second
   * copy of it that can lag a tab change by a render. Subscribing is what makes
   * switching machines with the drawer open change which screens it offers.
   */
  useSyncExternalStore(subscribeGroups, groupsVersion);

  /*
   * **The panel outlives `open` by its own exit animation**, and by
   * {@link DRAWER_EXIT_MS} only where that animation never reports.
   *
   * ⚠ **The mechanism moved to `leaving.ts` and every paragraph that used to be
   * here moved with it** — the render-derived transition and the frame it was
   * measured against, the `wasOpen` ref, the backstop that may not be deleted, and
   * why `animationend` is compared by target rather than by keyframe name. It was
   * extracted when `TaskPanel` needed the same thing on a phone, which is the point
   * at which a measured mechanism with four such paragraphs stops being allowed to
   * exist twice. What stays here is the number and the class strings, because those
   * are this panel's rather than the mechanism's.
   *
   * `AgentConfigBar`'s picker keeps its panel mounted past dismissal for the same
   * reason — neither layer is a route, so neither has a view-transition snapshot to
   * leave behind — and is deliberately **not** a caller of the hook: its `open` is
   * its own `useState`, flipped from inside the exit timer, so `shown === open`
   * throughout. `leaving.ts`'s docblock carries that distinction.
   */
  const { shown, leaving, onAnimationEnd } = useLeaving(open, DRAWER_EXIT_MS);
  /*
   * ⚠ **The layer's lifetime is `shown`, never `open`, and the difference is the
   * whole of the exit animation.**
   *
   * `useDismissible` pushes on `active` and pops in the effect's cleanup, and the
   * pop runs `syncInert` — `#root` loses `inert` and `shortcutsEnabled` goes true
   * again the moment the last `sheet` leaves the stack. Passed `open`, that
   * happened `DRAWER_EXIT_MS` **before** the panel stopped existing: for the whole
   * 260ms of the slide-out the drawer still covered the app while the app behind
   * it was live again, so `j`/`k` walked the session list behind an opaque panel
   * and Tab reached controls nobody could see — verbatim the hazard this file's
   * docblock says `"sheet"` was chosen to prevent. The scrim still caught taps, so
   * nothing pointing at it ever reproduced it; it is keyboard-only, which is why
   * it survived being looked at.
   *
   * `shown` is already the panel's real lifetime — it is what the mount guard
   * below reads — so the layer and the element now begin and end together. The
   * call stays **above** that guard because it is a hook.
   *
   * ⚠ **And `shown` is only worth tying the layer to because it is no longer a
   * timer.** Holding it for a constant `DRAWER_EXIT_MS` traded this defect for its
   * mirror: under `prefers-reduced-motion` the panel is gone in a frame, so the
   * app was inert and keyboard-dead for 260ms with nothing covering it. `leaving`
   * is cleared by the panel's own `animationend` now — `leaving.ts` owns that and
   * carries the measurement — so "the layer is up" and "something is covering the
   * app" are the same statement in both motion settings rather than in one of
   * them.
   */
  useDismissible("sheet", onClose, shown);
  const machine = shown ? currentView(sessionGroups(state)).machine : null;
  if (!shown) return null;

  const me = state.me;
  // The name this computer last saw for the account where `me` has not answered —
  // an unreachable server draws the shell with no `me` (`store.bootstrap`).
  const name = me?.name ?? state.host?.name ?? null;
  /*
   * Whether this is the shell, where this window is one account of several and the
   * head becomes the account panel. `state.host` rather than `inNativeShell()` for
   * `AppState.host`'s reason: it is `null` in a browser for ever, and it is what the
   * rest of this app already reads for "the shell answered".
   */
  const native = state.host !== null;
  /*
   * The one extra fact worth a line, and only when it is true. Not `me.id` — an
   * opaque `u_…` under a name is noise. `via` earns its place because it changes
   * what this panel can do: `cp.logout` has no session to delete for a key, and
   * clears locally in its `finally`. The same line under either head.
   */
  const keyLine = me?.via === "api_key" && (
    <p className="shrink-0 px-3 pb-2 text-2xs text-faint">signed in with an API key</p>
  );
  /*
   * ⚠ **Only the selected machine's, and only the ones that draw a screen and are
   * usable.** A plugin that is switched off or has failed is not offered rather
   * than offered-and-broken: this is a launcher, and a door onto a sentence saying
   * the plugin is not running is worse than no door. That sentence belongs on the
   * plugin's row inside its machine, and is drawn there.
   */
  const launchable = machine === null ? [] : screenPlugins(state.pluginsByMachine.get(machine) ?? []);

  const go = (path: string): void => {
    /*
     * Close first, then navigate, and the order is the whole of how this panel
     * shuts. `App`'s effect on `usePathname()` is the belt — it is what makes
     * Android's Back close the drawer — but it cannot be the only strap: every
     * destination here is an overlay path, and `AppShell` is handed
     * `route={background}`, so a listener on *that* value would never fire.
     */
    onClose();
    navigate(path);
  };

  return createPortal(
    <>
      {/*
       * A `<div>`, never a `<button>`. `Sheet` argues it: a viewport-sized button
       * is a phantom tab stop. `touch-manipulation` because `index.css` grants the
       * 300ms double-tap-to-zoom removal to `button` alone.
       *
       * ⚠ **`Sheet` states that in one breath with "and the ✕ is the accessible
       * way out", and only the first half of its sentence carries over here.**
       * `Sheet` draws one; this panel does not, by the owner's call recorded in the
       * head. What is left, then, is a scrim that is a way out for a *finger* and
       * for nothing else: it is `aria-hidden`, so a screen reader's navigation
       * never stops on it, and it is not a tab stop by the paragraph above. Escape is unaffected
       * and still arrives through `useDismissible`. The whole list of exits, the
       * population left with none of them, and the call that produced that state
       * are stated once at the head of the panel rather than argued a second time
       * here. Q3.628.
       *
       * ⚠ **The exiting scrim stops taking taps the instant it starts leaving.**
       * `--animate-scrim-out` ends at `opacity: 0` while the element lives on, so
       * it was an invisible viewport-sized click-eater for the tail of every close.
       * `pointer-events-none` rather than an earlier unmount, because the fade is
       * the thing being kept.
       *
       * ⚠ **The measurement that made this urgent has since gone false, and the
       * line stays anyway.** It read "and under `prefers-reduced-motion`, where
       * `index.css` forces `animation-duration: 0.01ms !important`, for essentially
       * the whole of it" — true while the unmount was a flat `DRAWER_EXIT_MS`
       * timer, which is exactly the hole `animationend` was wired up to close: the
       * dead window under reduced motion is now about one frame rather than 260ms.
       * What is left is the ordinary case, where the scrim is still fading and
       * already transparent enough to be worth nothing as a target, plus whatever
       * the backstop has to cover when no `animationend` arrives — so this is a
       * belt now rather than the fix, and removing it would restore the click-eater
       * precisely on the path that is hardest to see.
       */}
      <div
        aria-hidden={true}
        onClick={leaving ? undefined : onClose}
        className={`${
          leaving ? "animate-scrim-out pointer-events-none" : "animate-scrim"
        } fixed inset-0 touch-manipulation bg-fg/25 ${LAYER.overlay}`}
      />
      <aside
        role="dialog"
        /*
         * `aria-modal`, and it is `Sheet`'s idiom rather than a new one. The
         * attribute is what tells a screen reader that the rest of the document is
         * out of play — which is already *true* here, because the `"sheet"` layer
         * inerts `#root`, so without it the announcement and the reality disagree.
         */
        aria-modal="true"
        aria-label="Menu"
        /*
         * ⚠ **This is what ends the exit, and {@link DRAWER_EXIT_MS} is what
         * happens if it never fires.** The panel is the element the outgoing
         * keyframe is on, so it is the only node here that knows when the movement
         * is actually over — which under `prefers-reduced-motion` is a frame rather
         * than the constant, and holding the `"sheet"` layer for the constant left
         * the app inert with nothing on screen for the difference. `leaving.ts`
         * carries the rest, including why it compares targets rather than names.
         */
        onAnimationEnd={onAnimationEnd}
        className={`pt-safe pb-safe pl-safe ${
          leaving ? "animate-drawer-out" : "animate-drawer"
        } fixed inset-y-0 left-0 flex w-88 max-w-[85vw] flex-col overflow-hidden border-r border-edge bg-surface shadow-2xl ${LAYER.overlay}`}
      >
        {/*
         * The head: who you are.
         *
         * **The identity half is not a control.** There is no Account row below it
         * for the reason the docblock gives, and making the monogram pressable
         * would put the panel's only destination on the one element that does not
         * look like one. In a browser the name beside it is not one either.
         *
         * ⚠ **In the shell the name is a disclosure, which reverses Q3.612's inert
         * head there (Q3.642).** This window is one account of several on this
         * computer, and the place every multi-account client puts the others is
         * under the name: it opens this computer's accounts in place and navigates
         * nowhere. The face stays outside any control, and grows (`lg`), because it
         * is who this window *is* above a list of who else it could be. That head is
         * `AccountPanel` and it lives **inside the scroller**, as Telegram's does —
         * with ten accounts open, a fixed head of eleven rows would starve the
         * scroller and the `overflow-hidden` aside would clip Sign out off the
         * bottom. The browser keeps this head exactly as it was.
         *
         * ⚠ **There was a ✕ here and it is gone by the owner's call. The gap it
         * covered is real, narrow, and recorded rather than smoothed over.** This
         * panel registers `"sheet"`, so `inert` lands on `#root` and the rows
         * behind it are precisely what cannot be reached; the scrim is an
         * `aria-hidden` `<div>`, which is the same reasoning that keeps it from
         * being a phantom tab stop. So the ways out are now: Escape, which
         * `useDismissible` gives the topmost layer; a tap on the scrim; the
         * hamburger that opened it; and Android's Back, through `App`'s
         * `usePathname()` effect. What that leaves without one is a screen-reader
         * user on **iOS** — an `aria-hidden` scrim is skipped by VoiceOver's
         * navigation, and iOS has no Back. It is one platform and one assistive
         * technology, which is why this is a line here rather than a refusal.
         *
         * ⚠ **The remedy, if it is ever wanted, is not a `tabIndex` on the scrim.**
         * `overlay.ts` states that `inert` is the mechanism and a hand-rolled trap
         * must not be added, `Sheet` argues that a viewport-sized button is a
         * phantom tab stop, and `webcheck` pins `tabIndex` absent from this file.
         * A ✕ is the shape that works, which is what makes putting it back a
         * one-line change rather than a redesign. Q3.628.
         */}
        {!native && (
          <div className="flex shrink-0 items-center gap-3 px-3 pt-3 pb-4">
            <Monogram name={name} glyph={personEmoji(name)} size="md" className="bg-raised" />
            <span className="min-w-0 flex-1 truncate text-base">{name ?? "Signed in"}</span>
          </div>
        )}
        {!native && keyLine}

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
          {native && (
            <AccountPanel name={name} server={state.host?.server ?? null} onClose={onClose}>
              {keyLine}
            </AccountPanel>
          )}
          {me !== null && (
            <button type="button" onClick={() => go(settingsPath())} className={`${DRAWER_ROW} text-fg hover:bg-raised`}>
              <Icon as={SettingsIcon} size={18} />
              Settings
            </button>
          )}
          {me !== null && (
            <button type="button" onClick={() => go(marketPath())} className={`${DRAWER_ROW} text-fg hover:bg-raised`}>
              <Icon as={Puzzle} size={18} />
              Plugins
            </button>
          )}
          {/*
           * The plugin screens this machine offers, under the row that manages
           * them — a heading rather than a separator, because these are not more
           * account actions: they are somebody else's screens, and the word above
           * them is what says so.
           */}
          {launchable.length > 0 && machine !== null && (
            <>
              <p className={DRAWER_HEADING}>screens</p>
              {launchable.map((plugin) => (
                <button
                  key={plugin.id}
                  type="button"
                  onClick={() => go(pluginPath(machine, plugin.id))}
                  className={`${DRAWER_ROW} text-fg hover:bg-raised`}
                >
                  <Icon as={Puzzle} size={18} />
                  <span className="min-w-0 truncate">{plugin.contributes.screen?.title ?? plugin.name}</span>
                </button>
              ))}
            </>
          )}
        </div>

        {/*
         * The way out, at the bottom and above the version — pushed there by the
         * scroller's own `flex-1` rather than by a spacer, so a fleet with a dozen
         * plugin screens scrolls past it instead of pushing it off the panel.
         */}
        <div className="shrink-0 border-t border-edge px-1.5 py-1.5">
          <button
            type="button"
            onClick={() => {
              onClose();
              void store.signOut();
            }}
            className={`${DRAWER_ROW} text-danger hover:bg-danger/10`}
          >
            <Icon as={LogOut} size={18} />
            Sign out
          </button>
        </div>

        {/*
         * What build this is, and nothing else.
         *
         * ⚠ **The product mark was here and has been taken out.** A wordmark at
         * the foot of a menu is a thing to look at rather than a thing to read,
         * and the one fact this line carries — which build you are running — was
         * the smaller half of it.
         *
         * ⚠ **`text-faint` and centred, by the owner's call, reversing the tone
         * this paragraph argued for.** It read `text-muted` "because it is the only
         * place in the app that answers *what am I running*, so it is written to be
         * read once rather than to disappear". The premise is no longer true: the
         * build is also on Settings → Account, which is one row above this line in
         * the same panel. So what is left is a footer stamp, and a footer stamp is
         * the one kind of string `faint` exists for. Centred for the same reason —
         * left-aligned it reads as a fourth row of the list above it, which is
         * exactly what it is not; nothing else in this panel is centred, and that
         * is what separates it.
         */}
        <div className="shrink-0 px-4 pb-2 text-center text-2xs text-faint">Version {APP_VERSION}</div>
      </aside>
    </>,
    document.body,
  );
}

/**
 * Who this window is, and the other accounts on this computer — the shell's head
 * for the panel above (Q3.642).
 *
 * **Below `MenuDrawer`, and the placement is asserted rather than tidy.** `webcheck`
 * reads that component's first mount guard and its first `aria-hidden` element off
 * this file by position, so a component above it would be read in their place. It
 * also keeps the drawer's own body free of hooks it did not have: this state lives
 * and dies with the panel, which unmounts on every close — so the list is asked for
 * again on every open, which is what it has to be.
 *
 * ⚠ **The fold is remembered, and it was not.** It shut again on every open —
 * `TaskPanel`'s finished band's precedent — until the owner's call on the first
 * build (2026-09-24): open stays open until somebody closes it, as Telegram's does.
 * So it is read from `localStorage` on every mount rather than held in module
 * state: every account's window is a page of its own on one data store, and a
 * module copy would answer for the window it was set in and not the one being
 * opened. Written only while open — closing removes the key — so a computer
 * where nobody has opened it still holds nothing (`docs/NATIVE.md` step 3).
 *
 * **The list is the host's, read live** (`nativeAccounts`, one IPC, no keyring):
 * accounts are added and removed from other windows while this one lives, and a
 * list kept from launch would offer a switch to one that is gone. Until it answers
 * the fold holds nothing, which is the same as a list of one.
 *
 * What it draws, top to bottom:
 *
 *   - the face, `lg`, **not a control** — who this window is;
 *   - the name and the server, as **one disclosure** — `aria-expanded` and
 *     `aria-controls` on a button that navigates nowhere, the chevron turning on
 *     its icon rather than on the button, because `.tap`'s transition shorthand on
 *     the button would swallow a `transition-transform` there (Disclosure's
 *     placement) — and a `ChevronDown` rather than Disclosure's `ChevronRight`,
 *     because a trailing right chevron on a full-width row reads as *goes to
 *     another screen*;
 *   - a rule under the head, always — Telegram's, and the owner's ask: it is what
 *     says the rows below it slid out of the head rather than being more of the
 *     menu, and it is the room between the head and the first of them;
 *   - the fold: `Disclosure`'s `0fr`/`1fr` grid with `inert` on the closed half,
 *     so a closed fold is not a tab stop and is not read out, closed by a second
 *     rule under its last row;
 *   - rows with faces at `row`, smaller than the head's, so a list reads as one;
 *   - this account's row, a `<div aria-current>` and **not a button** — a control
 *     that answers a tap with nothing is refused in this app — with its face ringed
 *     rather than outlined, because `outline` is the focus ring here and a current
 *     mark drawn with it would read as focus;
 *   - a button for every other account, "signed out" at its trailing edge where
 *     the host says so;
 *   - "Add account" while there is room for one — the host's `canAdd`, which is
 *     where the ceiling of ten lives.
 *
 * **Every act closes the panel first and then asks the store** — Sign out's shape,
 * never `go`, since a switch is not a place in this window's URL. A refusal is a
 * toast, because the panel it would have been drawn on is already leaving.
 *
 * **What it spends and does not:** no `tabIndex`, no weight on a row or a name, no
 * caps band — the typography census holds this file at one of each.
 */
function AccountPanel({
  name,
  server,
  onClose,
  children,
}: {
  name: string | null;
  server: string | null;
  onClose: () => void;
  /** The API-key line, drawn under the name as it is under the browser's head. */
  children: ReactNode;
}): ReactNode {
  const [expanded, setExpanded] = useState(readAccountsOpen);
  const [accounts, setAccounts] = useState<NativeAccountList | null>(null);
  const id = useId();
  useEffect(() => {
    let live = true;
    void nativeAccounts().then((list) => {
      if (live) setAccounts(list);
    });
    return () => {
      live = false;
    };
  }, []);
  const act = (verb: () => Promise<void>): void => {
    onClose();
    void verb().catch((cause: unknown) => toast("error", errorText(cause)));
  };

  return (
    <div className="pt-3">
      <div className="px-3 pb-1">
        <Monogram name={name} glyph={personEmoji(name)} size="lg" className="bg-raised" />
      </div>
      <button
        type="button"
        onClick={() => {
          setExpanded(!expanded);
          writeAccountsOpen(!expanded);
        }}
        aria-expanded={expanded}
        aria-controls={id}
        className={`${DRAWER_ROW} text-fg hover:bg-raised`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base">{name ?? "Signed in"}</span>
          {server !== null && <span className="block truncate font-mono text-2xs text-muted">{serverLabel(server)}</span>}
        </span>
        <Icon
          as={ChevronDown}
          size={18}
          className={`text-muted transition-transform duration-200 ease-out ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {children}
      <div className="mt-2 border-t border-edge" />
      <div
        id={id}
        inert={!expanded}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <div className="mb-1.5 border-b border-edge py-1.5">
            {(accounts?.accounts ?? []).map((account) =>
              account.current ? (
                <div key={account.key} aria-current="true" className={`${DRAWER_ROW} text-fg`}>
                  <Monogram
                    name={account.name}
                    glyph={personEmoji(account.name)}
                    size="row"
                    className="bg-raised ring-2 ring-fg ring-offset-2 ring-offset-surface"
                  />
                  <AccountLines account={account} />
                </div>
              ) : (
                <button
                  key={account.key}
                  type="button"
                  onClick={() => act(() => store.switchAccount(account.key))}
                  className={`${DRAWER_ROW} text-fg hover:bg-raised`}
                >
                  <Monogram name={account.name} glyph={personEmoji(account.name)} size="row" className="bg-raised" />
                  <AccountLines account={account} />
                </button>
              ),
            )}
            {accounts?.canAdd === true && (
              <button
                type="button"
                onClick={() => act(() => store.addAccount())}
                className={`${DRAWER_ROW} text-fg hover:bg-raised`}
              >
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center">
                  <Icon as={Plus} size={18} />
                </span>
                Add account
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One account's two lines, and its state.
 *
 * The name in the row's own sans, and the server under it in mono — a
 * machine-written string somebody may compare against the address they typed,
 * which is `web-typography.md`'s test — at the step below, as every mono run under
 * a sans line is. A kept sign-in nobody has attributed yet has no name, and draws
 * its server as its name rather than a blank.
 *
 * "signed out" is a **state word at the trailing edge, in sans**: putting it on the
 * mono line would change that line's family halfway, which is the row this app's
 * typography refuses. It is what the host last knew rather than a fresh read of
 * every keyring entry — `NativeAccountSummary` carries why.
 */
/** Where the account fold's state is kept; see `AccountPanel`. */
const ACCOUNTS_OPEN_KEY = "reemoat.accountsOpen";

function readAccountsOpen(): boolean {
  try {
    return window.localStorage.getItem(ACCOUNTS_OPEN_KEY) === "1";
  } catch {
    // A store that refuses a read (a private window, a blocked origin) remembers
    // nothing, and a fold that opens shut is the honest drawing of that.
    return false;
  }
}

function writeAccountsOpen(open: boolean): void {
  try {
    if (open) window.localStorage.setItem(ACCOUNTS_OPEN_KEY, "1");
    else window.localStorage.removeItem(ACCOUNTS_OPEN_KEY);
  } catch {
    // Not kept: the fold still opens and shuts for this sitting, which is all a
    // refused write can cost.
  }
}

function AccountLines({ account }: { account: NativeAccountSummary }): ReactNode {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{account.name ?? serverLabel(account.origin)}</span>
        {account.name !== null && (
          <span className="block truncate font-mono text-2xs text-muted">{serverLabel(account.origin)}</span>
        )}
      </span>
      {!account.signedIn && <span className="shrink-0 text-2xs text-faint">signed out</span>}
    </>
  );
}
