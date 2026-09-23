import { Suspense, lazy, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { clearRevokedKeyNotice, peekRevokedKeyNotice } from "./account";
import { legalPublishable } from "./legal";
import { isSheet, sheetTitle, sheetUpLabel, upFrom } from "./nav";
import { navigate, parsePath, useOrigin, usePathname, useRoute, useUnder, type Route } from "./router";
import { sessionLists, store } from "./store";
import { AppShell, NothingSelected } from "./ui/AppShell";
import { ChooseServer } from "./ui/ChooseServer";
import { ForcedPasswordChange } from "./ui/ForcedPasswordChange";
import { MenuDrawer } from "./ui/MenuDrawer";
import { StartSheet } from "./ui/NewSession";
import { Sheet } from "./ui/Sheet";
import { SessionBrowser } from "./ui/SessionBrowser";
import { SignIn } from "./ui/SignIn";
import { ToastHost } from "./ui/Toast";
import { SHEET_SCROLL, Spinner } from "./ui/bits";

/**
 * The two subtrees that are not on the first-paint path.
 *
 * The bundle was one chunk, so the **sign-in screen** downloaded and parsed the
 * whole markdown pipeline — `react-markdown`, `remark-gfm`, the `highlight.js`
 * core — before it could draw two input fields. On the device this product is
 * aimed at, over LTE, that is the first thing anybody experiences.
 *
 * `SessionView` is what drags that pipeline in, and `Settings` is a large tree
 * nobody reaches on a cold load. Neither can be reached before the app is ready:
 * a `session` route needs a signed-in store, and `settings` is an overlay opened
 * from inside it. So splitting them costs a chunk fetch on a transition that
 * already fetches a transcript, and buys the whole markdown stack off the path
 * to a login form.
 *
 * Measured on this bundle: one chunk of 655.9 kB (200.2 kB gzipped) became
 * 346.8 kB (106.1 kB) on the sign-in path, with `SessionView` at 264.4 kB (81.3
 * kB) and `Settings` at 44.7 kB (12.4 kB) fetched on the transition that needs
 * them. The `highlight.js` languages were already split and are unaffected.
 *
 * `Spinner` is the fallback because it is what the loading phase already shows;
 * a second, different waiting state would be a new thing to explain.
 */
const SessionView = lazy(async () => ({ default: (await import("./ui/SessionView")).SessionView }));
const Settings = lazy(async () => ({ default: (await import("./ui/settings/Settings")).Settings }));
/*
 * Lazy for `Settings`' reason, and with a stronger case: a plugin screen carries
 * the whole declarative renderer, and the great majority of sign-ins never open
 * one. Nothing on the sign-in or session path imports it.
 */
const PluginScreen = lazy(async () => ({ default: (await import("./ui/PluginScreen")).PluginScreen }));
/*
 * The market. Lazy for `Settings`' reason and one of its own: it pulls in the
 * catalogue reader and the machine picker, and most sessions never open it.
 */
const PluginsSheet = lazy(async () => ({ default: (await import("./ui/plugins/PluginsSheet")).PluginsSheet }));
/*
 * Split for the same reason as the rest, and it is the one that would have
 * undone the measurement above: the three documents are reachable *from the
 * sign-up form*, so bundling their prose would put a few kilobytes of policy
 * back on the path to a login form for the sake of text almost nobody opens.
 */
const LegalScreen = lazy(async () => ({ default: (await import("./ui/legal/LegalScreen")).LegalScreen }));

/**
 * What the tab is called with nothing waiting, and the string every badge is
 * prefixed onto.
 *
 * The same words `index.html` ships in its own `<title>`, deliberately restated
 * rather than read back out of `document.title`: the first thing this app does to
 * that property is overwrite it, so a value recovered from it at any later moment
 * is whatever the last render put there, badge and all.
 */
const PAGE_TITLE = "Reemoat";

/**
 * Three phases, and — new here — two routes at once.
 *
 * `/settings…` and `/new/:machineId` are drawn as pop-ups **over** whatever you
 * were looking at rather than instead of it, so this renders two things: the
 * background, from the path recorded in `history.state` when the overlay opened,
 * and the overlay itself from the live route.
 *
 * They stay real URLs, and that is what buys the behaviour: a deep link works, a
 * reload keeps the pop-up, and the phone's Back button closes it with no code at
 * all, because Back pops the history entry that opened it.
 */
export function App(): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  /*
   * The one-shot line a deliberate sign-out leaves behind: revoking the key this
   * browser was holding clears the credential and reloads onto the sign-in
   * screen, and without this the gate would say nothing about an act the person
   * just chose. Read **once, by construction**: `peekRevokedKeyNotice` in a
   * state initialiser, which leaves the storage alone, and
   * `clearRevokedKeyNotice` in a mount effect, once the line is in state. Not
   * in the render body, where the first signed-out paint would read it and the
   * config patch a moment later (`bootstrap` fires `loadConfig` before it
   * settles the phase) would re-render to `null`. And not deleting inside the
   * initialiser (review D16): that was right only because React 19 keeps the
   * first initialiser's result under StrictMode's double call, and a rule that
   * holds by a version's grace is not a rule. State survives StrictMode's
   * simulated remount, so the effect firing twice deletes a value already read.
   * Storage disabled is the same as no notice.
   */
  const [revoked] = useState<string | null>(() => {
    try {
      return peekRevokedKeyNotice(window.sessionStorage);
    } catch {
      // Private browsing, or storage disabled: the sign-in screen is still right.
      return null;
    }
  });
  useEffect(() => {
    try {
      clearRevokedKeyNotice(window.sessionStorage);
    } catch {
      // Private browsing, or storage disabled: nothing was read, nothing to clear.
    }
  }, []);
  const route = useRoute();
  const under = useUnder();
  // The other pop-up this one was opened from, for the way *up*. The ✕ is
  // `under`'s and is unchanged. See `Location.origin` in `router.ts`.
  const origin = useOrigin();
  /*
   * The way *up* from a pop-up, computed once above every early return.
   *
   * ⚠ **Above the branching, and that is not style.** It sat below at first, so a
   * render that took the sign-out or the forced-password-change arm ran one hook
   * fewer than the render before it — `Minified React error #310`, an error
   * boundary, and the whole screen gone. Caught in a browser rather than by
   * `typecheck`, which cannot see it. Every hook here belongs above line one of
   * the branching, and `upFrom` is read by `LegalScreen` below.
   */
  const up = upFrom(route, under, origin);

  /*
   * The menu drawer's open state, held here and threaded down as `onMenu`.
   *
   * ⚠ **React state and not a `groups.ts`-shaped module store**, which is the
   * first thing to reach for in this package and is wrong here. Those stores
   * exist on an argument `rail.ts` states plainly — *"this is a preference about
   * the app rather than about a screen, and a component that unmounts must not
   * take it with it"* — and that argument is **inverted** for this panel: the
   * drawer should die when the screen changes, and surviving the phone's
   * list → detail → back unmount is a liability rather than the point. It is
   * also above every early return, for the reason `up` is.
   *
   * Two triggers open it — the phone's header row and the top of the desktop
   * machine column — and they live in two different subtrees, which is what the
   * prop is for.
   *
   * ⚠ **The effect is keyed on `usePathname()` and may not be keyed on `route`
   * or on `background`.** Every destination in the drawer is an overlay path, so
   * `background` does not change when a row navigates and a listener on it would
   * fire never. What this buys, beyond a belt on the rows' own `onClose`, is the
   * one thing a panel that is not a route cannot get for free: **Android's Back
   * closes the drawer.** It closes it *and* navigates, which is one press doing
   * two things — a known limitation recorded in `docs/DECISIONS.md` rather than
   * a bug, and the price of not minting a `/menu` URL that is a dead end.
   */
  const [menu, setMenu] = useState(false);
  const path = usePathname();
  useEffect(() => setMenu(false), [path]);
  const openMenu = (): void => setMenu(true);
  const closeMenu = (): void => setMenu(false);

  /*
   * **The tab says how many sessions are waiting, and it is the only thing this
   * app can say to somebody who is not looking at it.**
   *
   * Every other cross-screen signal — the bell, `WaitingElsewhere`, the count on a
   * machine tab, the count on a folder header — is drawn in the rail, which is to
   * say inside a tab that already has the reader's attention. The question this
   * product is shaped around is *does anything anywhere need me*, and a
   * backgrounded tab could not answer it at all: there was no `document.title`
   * write anywhere in this package.
   *
   * ⚠ **This is outside Q3.1's "no Electron, no service worker and no push"
   * non-goal rather than a quiet reversal of it.** A title write is none of those
   * three: it asks for no permission, installs nothing, reaches nothing once the
   * tab is closed, and is visible only where the reader has already chosen to keep
   * this app open. That is exactly the reach the non-goal declines to exceed — and
   * "with no push notification and no service worker to say otherwise" is the
   * sentence Q3.94 wrote while arguing the same property one surface down.
   *
   * **The count is `sessionLists(...).blocked`, which is the predicate every other
   * consumer already reads** — through `sessionGroups` for the folder counts,
   * directly for the bell — so there is one answer to "how many need me" and this
   * cannot become a second opinion that disagrees with the bell three inches away.
   * That is Q3.94's own rule about its own badge, applied to the one reader who
   * cannot see any of them.
   *
   * Restored to the plain name at zero *and* on unmount. The cleanup fires on every
   * change as well as on the last one, which writes `PAGE_TITLE` and then
   * immediately the new badge: harmless, one extra assignment, and it is what makes
   * "the badge never outlives the state that put it there" true by construction
   * rather than by remembering to clear it in the zero arm.
   *
   * Above every early return, for the reason the effect above it gives at length:
   * a render that takes the gate, the signed-out or the forced-password arm must
   * run the same hooks as the render before it. On those arms `state.sessions` is
   * empty and the tab is plain, which is correct — a sign-in screen claiming two
   * sessions are waiting would be claiming to know something it has not been told.
   */
  const blocked = sessionLists(state).blocked.length;
  useEffect(() => {
    document.title = blocked === 0 ? PAGE_TITLE : `(${blocked}) ${PAGE_TITLE}`;
    return () => {
      document.title = PAGE_TITLE;
    };
  }, [blocked]);

  /*
   * **Which server this is, above everything — including the mailed links below.**
   *
   * `state.host` is non-null only in the native shell, and `server === null` only
   * until somebody has said which control plane this installation talks to. So this
   * branch is **structurally unreachable in the web build**: there is no flag, no
   * env var and no route that reaches it, because in a browser the server is the
   * origin that served this page.
   *
   * **Two states, one screen.** `server === null` is first run; `pickingServer` is
   * somebody asking to change it — from the sign-in screen's own control, or from
   * Settings → Account with a live session behind it. The second is why this arm
   * had to widen rather than stay a first-run branch.
   *
   * Above the documents, because nothing on any screen below can be fetched until
   * this is answered. `App` waits on `state.config` for a document route and
   * `config` comes from `GET /v1/instance`, which needs a server — so below this,
   * `/terms` would spin for ever. ⚠ **That was a sentence about a freshly
   * installed app and is now a standing one**: with the picker reachable while
   * signed in, "there is no usable config" is every frame it is open, not just
   * the first ones after an install.
   *
   * Below every hook, which is the ⚠ two docblocks up: a render taking this arm must
   * run exactly as many hooks as one that does not.
   */
  if (state.host !== null && (state.host.server === null || state.pickingServer)) return <ChooseServer />;

  /*
   * **A document, above every phase.**
   *
   * Above `signed_out` because that is the state on the *first frame* for
   * somebody who has never signed in, so below it the documents would be
   * unreachable in exactly their normal case. Above `loading` because a stale
   * credential makes `phase` `loading` before any request has been answered, and
   * somebody who asked what the terms are would watch a spinner for the full
   * `CP_TIMEOUT_MS`. And above the wall below, because a contract is readable
   * whether or not you owe a password change.
   *
   * ⚠ **This block used to be about a mailed link, and that half has moved off
   * this bundle entirely.** `/confirm`, `/reset` and `/verify` are opened by a
   * mail client, in a browser, and land on the control plane's own gate — the
   * arm above records why there is nothing here to outrank any more.
   *
   * ⚠ **And nothing in this bundle links to a document now.** The consent line in
   * the sign-up form was the only control that did, and that form is the
   * browser's. The arm is kept because a document must still render where a
   * `legal` route is parsed — the two parsers are asserted disjoint and the web
   * build shares this file — but a reader who finds it should know it is reached
   * by no control here rather than delete the wrong one.
   */
  if (route.name === "legal") {
    /*
     * ⚠ **Three states, and the middle one is why this is not one condition.**
     * The documents ship in this bundle and name one particular party, so an
     * instance that has not claimed them has no such screen — but *whether* it
     * has claimed them arrives from the wire, so until the config lands the honest
     * answer is neither. Waiting rather than guessing: drawing optimistically
     * would put one operator's contract on a fork's screen for a frame, and
     * drawing the fall-through would flash a sign-in form at somebody who asked
     * for the terms. Q1.638.
     */
    if (state.config === null) return <Waiting />;
    /*
     * ⚠ **Two conditions, and the second is a publication gate rather than a
     * configuration.** `state.config.legal` is whether this deployment *claims*
     * the documents; `legalPublishable()` is whether they are finished. A required
     * `OPERATOR` field still holding `TODO` would otherwise render verbatim into a
     * contract — the mail provider is named as a data processor — so an unfinished
     * document is an address that names nothing here, exactly as an unclaimed one
     * is. `webcheck` reports the placeholder as a `skip`, which cannot stop a
     * release; this can.
     */
    if (state.config.legal && legalPublishable()) {
      return (
        <Suspense fallback={<Waiting />}>
          <LegalScreen doc={route.doc} up={up} signedIn={state.phase === "ready" && state.me !== null} />
        </Suspense>
      );
    }
    // Off: this address names nothing here, so it falls through to whatever `/`
    // would have drawn — the same answer every unknown path already gets.
  }
  /*
   * ⚠ **The gate arm is gone, and it took two screens with it rather than five.**
   *
   * `/register`, `/confirm`, `/forgot`, `/reset` and `/verify` are addresses the
   * *control plane* serves, from `dist-gate`, over a closed list checked **before**
   * the app's own fallback (`packages/control-plane/src/app.ts`). So no HTTP
   * request anywhere has ever rendered this bundle's copy of them, and in the
   * shell three of the five were unreachable outright — a mail client opens a
   * link in a browser, and a Tauri window has no address bar. What this arm
   * actually drew was the two screens `SignIn` itself created, client-side, with
   * `navigate("/register")` and `navigate("/forgot")`.
   *
   * Those are anchors now, at the control plane's own origin: the system browser
   * under the shell, a new tab elsewhere. So the app carries one sign-up form
   * instead of two, one consent box instead of two, and one place to fix either.
   *
   * `Route` keeps its `gate` arm and `screenOf` keeps its case — deleting those is
   * the eight-edits-and-a-case-table this file and `native-shell.md` both argue
   * against, and the parse is what keeps `parseGateScreen` and `parseLegalDoc`
   * assertably disjoint. A typed `/register` now falls through to `SignIn`, which
   * is the answer every unknown path already gets.
   */

  if (state.phase === "signed_out") {
    // An involuntary sign-out has its own sentence and wins over the revoke
    // notice — the two cannot both be true of one reload, since the revoke
    // cleared the credential before any request could 401.
    return <SignIn notice={state.authError ?? revoked} config={state.config} />;
  }

  if (state.phase === "loading") {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6">
        <Spinner />
        {state.cpError !== null && (
          <p className="max-w-xs text-center text-sm text-muted">
            Cannot reach the control plane. Retrying — sessions already running are unaffected.
          </p>
        )}
      </div>
    );
  }

  /*
   * Ready, and nonetheless not usable.
   *
   * **`=== true`, never `!== false`.** `phase: "ready"` with `me === null` is a
   * state this app really reaches — `bootstrap`'s catch keeps that phase when
   * the control plane is unreachable but machines are already known — and
   * failing closed there would trap somebody in a password form they may not
   * owe, during an outage, with a working app behind it. `visibleSections` fails
   * closed on the same null and is right to: *fail closed where the cost is a
   * missing screen, fail open where the cost is a locked-out person.*
   */
  if (state.me?.mustChangePassword === true) return <ForcedPasswordChange me={state.me} />;

  // `isSheet` rather than a third literal here: this list and `isOverlayPath` and
  // `nav.ts` all answer the same question, and three copies of it is two chances
  // for a pop-up to be drawn with no background behind it.
  const overlay = isSheet(route);
  // On a cold deep link there is no recorded underlay and `under` is `/`, so a
  // shared `/settings` link opens the sheet over the list — which is the right
  // background for a cold start rather than a blank one.
  const background = overlay ? parsePath(under) : route;

  return (
    <>
      <AppShell state={state} route={background} onMenu={openMenu}>
        <Suspense fallback={<Waiting />}>{content(state, background, openMenu)}</Suspense>
      </AppShell>
      {overlay && <OverlaySheet state={state} route={route} />}
      <MenuDrawer state={state} open={menu} onClose={closeMenu} />
      <ToastHost />
    </>
  );
}


/**
 * The one panel, for every pop-up that is a route.
 *
 * ⚠ **One `<Sheet>` element for all four, and the alternative was measured.** Each
 * pop-up used to render its own, so moving from Settings to Plugins *unmounted* a
 * panel and mounted another: `SHEET_PANEL`'s `animate-sheet` replayed — a bottom
 * sheet sliding up from off-screen — with a frame in between showing neither.
 * Reported as the pop-up disappearing for an instant and a different one
 * appearing. `navMove` made it worse by comparing depths across two stacks, where
 * a depth means nothing: settings-account (2) → plugins (1) answered `section-pop`
 * and slid one pop-up's pane rightwards into another's.
 *
 * With one element there is nothing to remount, both view-transition groups
 * already share a box, and the swap is what the default animation does anyway —
 * a cross-dissolve of the head and the contents over a panel that holds still.
 * `index.css` only has to pin the root. Q3.484.
 *
 * ⚠ **The `Suspense` boundaries are *inside* it**, which is the other half: a
 * lazy chunk still in flight used to be a `<Waiting/>` that is not a `Sheet` at
 * all, so the first time anybody opened a pop-up the transition captured a frame
 * with no panel in it.
 *
 * ⚠ **One element is also a bill, and `screen` is it.** A panel that never
 * remounts never re-runs the effects a mount used to pay for — so the flow
 * `/new` → `/agent` → `/agent/:step` focused the panel once and announced its
 * head never, while each step unmounted the control holding focus and dropped it
 * to `<body>`. `Sheet` keys both on this string; `screenOf` says what a screen is.
 *
 * `ImportCode` keeps its own `Sheet` and must: it is a sheet drawn *over* this
 * one. **`ForcedPasswordChange` is not a `Sheet` at all** — this line said it was,
 * and it never has been: a sheet carries a ✕ and registers `useDismissible`, so
 * Escape would take down a wall the control plane is still enforcing, which is the
 * argument in that file's own docblock. It is a `GateCard`, returned above
 * `<AppShell>` rather than beside it. The correction matters here rather than
 * merely being tidy: `Sheet`'s `WaitingHere` reads the fleet's blocked count for
 * every element that draws one, and this comment is the list of them.
 */
function OverlaySheet({
  state,
  route,
}: {
  state: ReturnType<typeof store.getSnapshot>;
  route: Route;
}): ReactNode {
  const under = useUnder();
  /*
   * The plugin screen is the only pop-up whose name is not a constant — it is
   * whatever the plugin called its view — so it is the only one that reports one.
   * Held here rather than read from a store because it belongs to the panel's head
   * and arrives with the body's own fetch. `sheetTitle` answers `null` for exactly
   * that route.
   */
  const [reported, setReported] = useState<string | null>(null);
  const titled = sheetTitle(route);
  /*
   * ⚠ **Both take the origin, and passing it to one of them is the failure.** The
   * ◀ is named after where it goes, so a label computed without the origin over a
   * destination computed with it is the control naming somewhere you are not
   * going — which is exactly what `sheetUpLabel`'s own docblock forbids. The
   * screen above this one already reads `useOrigin()` for its own ◀.
   */
  const origin = useOrigin();
  const upLabel = sheetUpLabel(route, origin);
  const up = upLabel === null ? null : upFrom(route, under, origin);

  /*
   * A flex item of `SHEET_BODY`'s column rather than `h-full`: the body pads
   * nothing and clips (Q3.553), so a child that wants the middle of it takes the
   * height with `flex-1` — `AgentBuilder`'s waiting screens are the same shape.
   */
  const spinner = (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <Spinner />
    </div>
  );

  return (
    <Sheet
      title={titled ?? reported ?? ""}
      screen={screenOf(route)}
      up={up === null ? undefined : () => navigate(up, true)}
      upLabel={upLabel ?? undefined}
    >
      {route.name === "settings" && (
        <Suspense fallback={spinner}>
          <Settings state={state} route={route} />
        </Suspense>
      )}
      {(route.name === "new" || route.name === "agent") && (
        <StartSheet state={state} route={route} />
      )}
      {route.name === "plugins" && (
        <Suspense fallback={spinner}>
          {/*
           * Not keyed: the pane's contents change under a panel that stays, which
           * is what makes the section slide read as one pop-up moving. What each
           * screen *inside* it owes instead is its own key — `MarketEntry` keys on
           * the plugin id, for the state that would otherwise be carried across.
           */}
          <PluginsSheet state={state} route={route} />
        </Suspense>
      )}
      {route.name === "plugin" && (
        <Suspense fallback={spinner}>
          {/*
           * Keyed on the pair, so moving from one plugin's screen to another
           * remounts rather than carrying the first one's view and form state into
           * the second's name. `AgentDetail` is keyed for the same reason.
           */}
          {/*
           * The screen's scroller, here rather than in `PluginScreen`: that file
           * answers a board, a spinner or an `Empty` and knows nothing about the
           * box it is drawn in, and `SHEET_BODY` pads nothing and never scrolls
           * (Q3.553) — so this is the box that does both, the way every other
           * pop-up's screen carries its own.
           */}
          <div className={SHEET_SCROLL}>
            <PluginScreen
              key={`${route.machineId}:${route.pluginId}`}
              machineId={route.machineId}
              pluginId={route.pluginId}
              onTitle={setReported}
            />
          </div>
        </Suspense>
      )}
    </Sheet>
  );
}

/**
 * Which screen inside a pop-up is on, as a string an effect can compare.
 *
 * `Sheet` re-focuses its panel and re-speaks its head on this changing and on
 * nothing else, so what this has to express is *the screen* — and deliberately
 * **not the whole route**, because several screens in this app keep their own
 * state in the address. `NewSession`'s folder effect replaces
 * `/new/:machineId/:cwd` on every step into a directory; `PluginSettings`
 * rewrites the machine list in its own URL from a control on the screen. Keyed on
 * the route, the panel would take focus off the picker somebody is walking
 * through, once per tap — a worse defect than the one being fixed.
 *
 * The title is the mirror failure, and is why this is not `sheetTitle`: that
 * answers "Settings" for every screen under `/settings` and "Plugins" for every
 * screen under `/plugins`, because a head spanning a section rail names the
 * pop-up while the pane names the screen (Q3.427). The two pop-ups with the most
 * screens would then fire on none of them.
 *
 * Here rather than in `nav.ts` because it is a rule about *this* panel's effects
 * rather than about navigation, and nothing offline imports `App.tsx`. If it ever
 * needs asserting rather than reading, it moves there whole — it takes a `Route`
 * and touches nothing, which is the only property that migration needs.
 *
 * The three screen-shaped routes have arms for exhaustiveness alone — this is
 * called under `isSheet` and nowhere else — and answer their own name rather than
 * a shared constant, so nothing can quietly make two of them one screen. No
 * `default`, so a seventh route shape fails to build here.
 */
function screenOf(route: Route): string {
  switch (route.name) {
    // Every depth of this sheet is a screen: the index, a section, a machine, and
    // one of that machine's systems. Nothing under them rides this URL as state.
    case "settings":
      // The strip flag is part of the identity, not screen state: it is a
      // different screen from the machine it hangs under, so arriving on it has
      // to move focus the way every other depth in this sheet does.
      //
      // ⚠ **So is the harness a leaf names**, and without it two leaves shared a
      // screen with their parent. `signin` carries both the Agents list's card
      // (`…/agents/:harness`) and the Sign-ins list's harness row
      // (`…/signin/:agent`), and neither was in this string — so the card had the
      // list's identity, and the Sign-ins leaf the machine screen's, and arriving
      // on either left focus where the previous screen had put it. Q3.640.
      return `settings/${route.section ?? ""}/${route.machineId ?? ""}/${route.system ?? ""}/${
        route.agents ? "agents" : ""
      }/${route.signin ?? ""}`;
    // One screen, whichever machine and folder it happens to be pointed at.
    case "new":
      return "new";
    /*
     * The step is the screen, and `preset` sits beside it because editing an
     * assembled agent is a different screen from configuring a new one — the same
     * depth, a different head. The folder is neither: it rides the address so
     * that leaving the builder and coming back can restore it.
     */
    case "agent":
      /*
       * The seed is part of the identity beside the preset, and for its reason:
       * the builder holds it in `useState`, seeded at mount, so two addresses that
       * differ only in which harness they start from are two screens. Left out,
       * moving between them would keep the panel's focus where the first one put
       * it and the second would mount with the first's state still on screen for a
       * frame.
       */
      return `agent/${route.step ?? ""}/${route.preset ?? ""}/${route.harness ?? ""}`;
    /*
     * *That* there is a settings screen, never which machines it names — the
     * screen rewrites that list from a control inside itself, so folding it in
     * here would re-focus the panel on every tick of a checkbox.
     */
    case "plugins":
      return `plugins/${route.tab}/${route.entry ?? ""}/${route.settings.length > 0 ? "settings" : ""}`;
    case "plugin":
      return `plugin/${route.machineId}/${route.pluginId}`;
    case "home":
    case "gate":
    case "session":
      return route.name;
    // Each document is its own screen, so arriving on one from another moves
    // focus the way every other screen change does.
    case "legal":
      return `legal/${route.doc}`;
  }
}

/** The one waiting state, shared by the loading phase and by a split chunk in flight. */
function Waiting(): ReactNode {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Spinner />
    </div>
  );
}

function content(
  state: ReturnType<typeof store.getSnapshot>,
  route: Route,
  onMenu: () => void,
): ReactNode {
  switch (route.name) {
    case "session":
      return <SessionView state={state} sessionRef={route.ref} />;
    default:
      // The rail is already showing this list at `lg`, so the pane beside it
      // says what to do instead of repeating it. Below `lg` the rail is hidden
      // and the list *is* the screen — the same component, mounted twice, with
      // the breakpoint answered in these two class strings and nowhere else.
      return (
        <>
          {/*
           * `bg-ink`, because at this width the rail is *inside* `main` and
           * `main` is `bg-surface`.
           *
           * The desktop rail is `AppShell`'s `<aside>`, which paints `bg-ink`
           * itself; the phone's copy is this mount, and it had no ground of its
           * own — so the moment the content pane stopped being transparent, the
           * same component drew on `ink` at `lg` and on `surface` below it. Every
           * `bg-surface` control in the rail then had no fill step at all on a
           * phone: the chat search box would have been identified by
           * `--color-edge` alone, which `index.css` says may never be the sole
           * identification of a control, sitting beside a filter menu whose
           * boundary follows a different rule.
           */}
          <div className="h-full bg-ink lg:hidden">
            <SessionBrowser state={state} onMenu={onMenu} />
          </div>
          <div className="hidden flex-1 lg:block">
            <NothingSelected state={state} />
          </div>
        </>
      );
  }
}
