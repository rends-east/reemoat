import { Suspense, lazy, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { clearRevokedKeyNotice, peekRevokedKeyNotice } from "./account";
import { legalPublishable } from "./legal";
import { isSheet, sheetTitle, sheetUpLabel, upFrom } from "./nav";
import { navigate, parsePath, useOrigin, usePathname, useRoute, useUnder, type Route } from "./router";
import { sessionLists, store } from "./store";
import { AppShell, NothingSelected } from "./ui/AppShell";
import { backRows, subscribeBack } from "./ui/backSwipe";
import { ChooseServer } from "./ui/ChooseServer";
import { ForcedPasswordChange } from "./ui/ForcedPasswordChange";
import { MenuDrawer } from "./ui/MenuDrawer";
import { StartSheet } from "./ui/NewSession";
import { Sheet } from "./ui/Sheet";
import { SessionBrowser } from "./ui/SessionBrowser";
import { SignIn } from "./ui/SignIn";
import { ToastHost } from "./ui/Toast";
import { SHEET_SCROLL, Spinner } from "./ui/bits";

// Lazy, to keep the markdown pipeline and Settings off the sign-in path.
const SessionView = lazy(async () => ({ default: (await import("./ui/SessionView")).SessionView }));
const Settings = lazy(async () => ({ default: (await import("./ui/settings/Settings")).Settings }));
const PluginScreen = lazy(async () => ({ default: (await import("./ui/PluginScreen")).PluginScreen }));
const PluginsSheet = lazy(async () => ({ default: (await import("./ui/plugins/PluginsSheet")).PluginsSheet }));
const LegalScreen = lazy(async () => ({ default: (await import("./ui/legal/LegalScreen")).LegalScreen }));

const PAGE_TITLE = "Reemoat";

export function App(): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // Peek in the initialiser and clear in an effect, so the notice survives StrictMode and later re-renders.
  const [revoked] = useState<string | null>(() => {
    try {
      return peekRevokedKeyNotice(window.sessionStorage);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      clearRevokedKeyNotice(window.sessionStorage);
    } catch {
      // Storage unavailable: nothing to clear.
    }
  }, []);
  const route = useRoute();
  const under = useUnder();
  const origin = useOrigin();
  // Every hook stays above the early returns: a branch that skips one crashes React.
  const up = upFrom(route, under, origin);

  // React state, not a module store: the drawer must close when the path changes, which is also how Back closes it.
  const [menu, setMenu] = useState(false);
  const path = usePathname();
  useEffect(() => setMenu(false), [path]);
  const openMenu = (): void => setMenu(true);
  const closeMenu = (): void => setMenu(false);

  const blocked = sessionLists(state).blocked.length;
  useEffect(() => {
    document.title = blocked === 0 ? PAGE_TITLE : `(${blocked}) ${PAGE_TITLE}`;
    return () => {
      document.title = PAGE_TITLE;
    };
  }, [blocked]);

  // Native only: no server chosen yet, or somebody asked to change it. Unreachable in a browser.
  if (state.host !== null && (state.host.server === null || state.pickingServer)) return <ChooseServer />;

  // Documents rank above every phase, so they are readable signed out and while loading.
  if (route.name === "legal") {
    // Wait for config: either answer drawn early would show the wrong screen (Q1.638).
    if (state.config === null) return <Waiting />;
    // Claimed and finished: an unfinished document must not render.
    if (state.config.legal && legalPublishable()) {
      return (
        <Suspense fallback={<Waiting />}>
          <LegalScreen doc={route.doc} up={up} signedIn={state.phase === "ready" && state.me !== null} />
        </Suspense>
      );
    }
  }

  if (state.phase === "signed_out") {
    return <SignIn notice={state.authError ?? revoked} config={state.config} />;
  }

  if (state.phase === "loading") {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6">
        <Spinner />
      </div>
    );
  }

  // Strictly true: ready with no me happens during an outage, and must not lock anybody into this form.
  if (state.me?.mustChangePassword === true) return <ForcedPasswordChange me={state.me} />;

  const overlay = isSheet(route);
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


/** One Sheet for every overlay route, so moving between them never remounts the panel (Q3.484). */
function OverlaySheet({
  state,
  route,
}: {
  state: ReturnType<typeof store.getSnapshot>;
  route: Route;
}): ReactNode {
  const under = useUnder();
  const [reported, setReported] = useState<string | null>(null);
  const titled = sheetTitle(route);
  // Both take the origin, or the label names somewhere the up button does not go.
  const origin = useOrigin();
  const upLabel = sheetUpLabel(route, origin);
  const up = upLabel === null ? null : upFrom(route, under, origin);

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
          <PluginsSheet state={state} route={route} />
        </Suspense>
      )}
      {route.name === "plugin" && (
        <Suspense fallback={spinner}>
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

/** Changes only when the screen does, not with state kept in the URL; Sheet re-focuses on it. */
function screenOf(route: Route): string {
  switch (route.name) {
    case "settings":
      // The strip flag, the links flag and the sign-in harness each make a separate screen (Q3.640).
      return `settings/${route.section ?? ""}/${route.machineId ?? ""}/${route.system ?? ""}/${
        route.agents ? "agents" : route.links ? "links" : ""
      }/${route.signin ?? ""}`;
    case "new":
      return "new";
    case "agent":
      return `agent/${route.step ?? ""}/${route.preset ?? ""}/${route.harness ?? ""}`;
    case "plugins":
      return `plugins/${route.tab}/${route.entry ?? ""}/${route.settings.length > 0 ? "settings" : ""}`;
    case "plugin":
      return `plugin/${route.machineId}/${route.pluginId}`;
    case "home":
    case "gate":
    case "session":
      return route.name;
    case "legal":
      return `legal/${route.doc}`;
  }
}

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
      return (
        <>
          <PhoneList key="list" state={state} onMenu={onMenu} beneath />
          <SessionView key="session" state={state} sessionRef={route.ref} />
        </>
      );
    default:
      return (
        <>
          <PhoneList key="list" state={state} onMenu={onMenu} beneath={false} />
          <div key="nothing" className="hidden flex-1 lg:block">
            <NothingSelected state={state} />
          </div>
        </>
      );
  }
}

/**
 * The phone's list, one element on both routes: under a conversation only while a back swipe draws it, inert and unread, so
 * landing on it remounts nothing (Q3.663).
 */
function PhoneList({
  state,
  onMenu,
  beneath,
}: {
  state: ReturnType<typeof store.getSnapshot>;
  onMenu: () => void;
  beneath: boolean;
}): ReactNode {
  const rows = useSyncExternalStore(subscribeBack, backRows);
  if (beneath && rows === null) return null;
  return (
    <div
      data-back-under={beneath ? "" : undefined}
      aria-hidden={beneath || undefined}
      inert={beneath}
      className={`${beneath ? "pointer-events-none absolute inset-0" : "h-full"} bg-ink lg:hidden`}
    >
      <SessionBrowser state={state} onMenu={onMenu} rows={beneath ? rows : null} />
    </div>
  );
}
