import { Suspense, lazy, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { upFrom } from "./nav";
import { navigate, parsePath, useRoute, useUnder, type Route } from "./router";
import { setTelegramBack } from "./telegram";
import { store } from "./store";
import { AppShell, NothingSelected } from "./ui/AppShell";
import { ForcedPasswordChange } from "./ui/ForcedPasswordChange";
import { Gate } from "./ui/gate/Gate";
import { NewSession } from "./ui/NewSession";
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
  const up = upFrom(route, under);
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

  const overlay = route.name === "settings" || route.name === "new";
  // On a cold deep link there is no recorded underlay and `under` is `/`, so a
  // shared `/settings` link opens the sheet over the list — which is the right
  // background for a cold start rather than a blank one.
  const background = overlay ? parsePath(under) : route;

  return (
    <>
      <AppShell state={state} route={background}>
        <Suspense fallback={<Waiting />}>{content(state, background)}</Suspense>
      </AppShell>
      {route.name === "settings" && (
        <Suspense fallback={<Waiting />}>
          <Settings state={state} route={route} />
        </Suspense>
      )}
      {route.name === "new" && (
        <NewSession state={state} machineId={route.machineId} cwd={route.cwd} />
      )}
      <ToastHost />
    </>
  );
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
