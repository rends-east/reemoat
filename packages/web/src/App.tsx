import { Suspense, lazy, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { isSheet, sheetTitle, sheetUpLabel, upFrom } from "./nav";
import { navigate, parsePath, useOrigin, useRoute, useUnder, type Route } from "./router";
import { setTelegramBack } from "./telegram";
import { store } from "./store";
import { AppShell, NothingSelected } from "./ui/AppShell";
import { ForcedPasswordChange } from "./ui/ForcedPasswordChange";
import { Gate } from "./ui/gate/Gate";
import { StartSheet } from "./ui/NewSession";
import { Sheet } from "./ui/Sheet";
import { SessionBrowser } from "./ui/SessionBrowser";
import { SignIn } from "./ui/SignIn";
import { ToastHost } from "./ui/Toast";
import { Spinner } from "./ui/bits";

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
  const route = useRoute();
  const under = useUnder();
  // The other pop-up this one was opened from, for the way *up*. The ✕ is
  // `under`'s and is unchanged. See `Location.origin` in `router.ts`.
  const origin = useOrigin();
  /*
   * Telegram's own control, kept in step with the screen.
   *
   * It draws **✕ Close** until a mini app asks for a back button and **‹ Back**
   * once it has — so "Close on the list, Back inside a conversation" is
   * `upFrom(...)` answering `null` at the root and a destination everywhere else.
   * The same function the app's own leading control could be built from, because
   * two back affordances that disagree is worse than one.
   *
   * An effect rather than a render-time call: this posts a message to another
   * process, which is not something a render React may discard is allowed to do.
   * Keyed on the destination string, so it fires when the *answer* changes rather
   * than on every re-render — and `navigate` is stable.
   *
   * ⚠ **Above every early return in this component, and that is not style.** It
   * sat below them at first, so a render that took the gate, the sign-out or the
   * forced-password-change arm ran one hook fewer than the render before it —
   * `Minified React error #310`, an error boundary, and the whole screen gone.
   * Caught in a browser rather than by `typecheck`, which cannot see it. Every
   * hook here belongs above line one of the branching.
   */
  const up = upFrom(route, under, origin);
  useEffect(() => {
    setTelegramBack(up === null ? null : () => navigate(up, true));
    // Deliberately no teardown. There is one back button and one page; hiding it
    // on unmount would be hiding it when the app is going away anyway, and a
    // cleanup racing the next screen's effect is how it ends up hidden on a
    // screen that wanted it.
  }, [up]);


  /*
   * **A URL somebody was mailed, above every phase.**
   *
   * Above `signed_out` because that is the state on the *first frame* for the
   * overwhelmingly common case — a reset link opened in a browser that has never
   * signed in — so below it the reset screen would be unreachable in exactly its
   * normal case. Above `loading` because a stale credential in `localStorage`
   * makes `phase` `loading` before any request has been answered, and somebody
   * clicking a link on the device whose session expired would watch a spinner
   * for the full `CP_TIMEOUT_MS` while holding a short-lived token. And above
   * the wall below, because somebody who cannot remember the temporary password
   * cannot type it into a "current password" box — the link is their way out and
   * it has to beat the wall.
   *
   * One branch and no predicate: `gateOutranksSession` lives inside `Gate`,
   * where `webcheck` can import it. A predicate here would be a decision nothing
   * asserts, which is what `settings.ts`'s own header forbids.
   */
  if (route.name === "gate") return <Gate screen={route.screen} state={state} />;

  if (state.phase === "signed_out") return <SignIn notice={state.authError} config={state.config} />;

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
      <AppShell state={state} route={background}>
        <Suspense fallback={<Waiting />}>{content(state, background)}</Suspense>
      </AppShell>
      {overlay && <OverlaySheet state={state} route={route} />}
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
 * `ImportCode` and `ForcedPasswordChange` keep their own `Sheet` and must: one is
 * a sheet drawn *over* this one, the other is not a route.
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

  const spinner = (
    <div className="flex h-full items-center justify-center">
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
          <PluginScreen
            key={`${route.machineId}:${route.pluginId}`}
            machineId={route.machineId}
            pluginId={route.pluginId}
            onTitle={setReported}
          />
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
      return `settings/${route.section ?? ""}/${route.machineId ?? ""}/${route.system ?? ""}/${
        route.agents ? "agents" : ""
      }`;
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

function content(state: ReturnType<typeof store.getSnapshot>, route: Route): ReactNode {
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
            <SessionBrowser state={state} />
          </div>
          <div className="hidden flex-1 lg:block">
            <NothingSelected />
          </div>
        </>
      );
  }
}
