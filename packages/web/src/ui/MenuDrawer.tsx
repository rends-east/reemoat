import { ChevronDown, LogOut, Plus, Puzzle, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { isPulled, subscribePull, yieldPull } from "./drawerPull";
import { currentView, groupsVersion, subscribeGroups } from "./groups";
import { useLeaving } from "./leaving";
import { LAYER, useDismissible } from "./overlay";
import { useSheetGesture, useSlideSheet } from "./sheetDrag";
import { SHEET_MS } from "./sheetMotion";
import { toast } from "./Toast";

const DRAWER_ROW = "tap flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm";

/** Written out, not composed from MENU_HEADING: its px-2.5 would sit 2px inboard of this panel's px-3 rows. */
const DRAWER_HEADING = "px-3 py-1.5 text-2xs font-semibold tracking-wider text-faint uppercase";

/** A sheet layer, never menu, so j/k cannot walk the list behind it; portaled to document.body because inert lands on #root (Q3.642). */
export function MenuDrawer({
  state,
  open,
  onClose,
}: {
  state: AppState;
  open: boolean;
  onClose: () => void;
}): ReactNode {
  // Subscribed so a machine switch with the drawer open changes the screens it offers.
  useSyncExternalStore(subscribeGroups, groupsVersion);

  const { shown, leaving, onAnimationEnd } = useLeaving(open, SHEET_MS);
  // The layer lives for shown, never open: on open it popped before the panel left and the app behind went live mid-exit.
  useDismissible("sheet", onClose, shown);
  const panelRef = useRef<HTMLElement | null>(null);
  const scrimRef = useRef<HTMLElement | null>(null);
  const slid = useSlideSheet(panelRef, "left", onClose, { scrim: scrimRef, open });
  const geometry = {
    ...slid,
    begin: () => {
      yieldPull();
      slid.begin();
    },
  };
  const drag = useSheetGesture<HTMLElement>({ axis: "left", enabled: open, geometry, held: panelRef, scrim: scrimRef });
  // Pulled from the list, it is drawn and not yet a layer: nothing goes inert under a finger that may still give it back (Q3.657).
  const pulled = useSyncExternalStore(subscribePull, isPulled);
  const machine = shown || pulled ? currentView(sessionGroups(state)).machine : null;
  if (!shown && !pulled) return null;

  const me = state.me;
  const name = me?.name ?? state.host?.name ?? null;
  const native = state.host !== null;
  const keyLine = me?.via === "api_key" && (
    <p className="shrink-0 px-3 pb-2 text-2xs text-faint">signed in with an API key</p>
  );
  const launchable = machine === null ? [] : screenPlugins(state.pluginsByMachine.get(machine) ?? []);

  const go = (path: string): void => {
    // Close first: every destination is an overlay path, so App's pathname effect alone would never close the drawer.
    onClose();
    navigate(path);
  };

  return createPortal(
    <>
      {/* A div, never a button (no phantom tab stop); pointer-events-none while leaving so the fading scrim eats no taps. */}
      <div
        ref={drag.scrim.ref}
        {...drag.scrim.bind}
        data-drawer-scrim=""
        aria-hidden={true}
        onClick={leaving ? undefined : onClose}
        // touch-none: nothing here pans or zooms, so a drag toward the edge is always the drawer's (Q3.660).
        className={`${
          leaving ? "animate-scrim-out pointer-events-none" : "animate-scrim"
        } fixed inset-0 touch-none bg-fg/25 ${LAYER.overlay}`}
      />
      <aside
        ref={drag.ref}
        {...drag.bind}
        data-drawer-panel=""
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onAnimationEnd={onAnimationEnd}
        // pan-y: the rows still scroll, and a sideways move is never the engine's to take.
        className={`pt-safe pb-safe pl-safe ${
          leaving ? "animate-drawer-out" : "animate-drawer"
        } fixed inset-y-0 left-0 flex w-88 max-w-[85vw] touch-pan-y flex-col overflow-hidden border-r border-edge bg-surface shadow-2xl ${LAYER.overlay}`}
      >
        {/* There was a ✕ here and it is gone by the owner's call; the ways out are now: Escape, a scrim tap, a swipe, the hamburger and Android's Back. What that leaves without one is a screen-reader user on **iOS**, where VoiceOver skips the aria-hidden scrim (Q3.628). */}
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

        <div className="shrink-0 px-4 pb-2 text-center text-2xs text-faint">Version {APP_VERSION}</div>
      </aside>
    </>,
    document.body,
  );
}

/**
 * Below MenuDrawer on purpose: webcheck reads the drawer's first mount guard off this file by position.
 * The fold is read from localStorage on every mount, since each account's window is its own page.
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

const ACCOUNTS_OPEN_KEY = "reemoat.accountsOpen";

function readAccountsOpen(): boolean {
  try {
    return window.localStorage.getItem(ACCOUNTS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeAccountsOpen(open: boolean): void {
  try {
    if (open) window.localStorage.setItem(ACCOUNTS_OPEN_KEY, "1");
    else window.localStorage.removeItem(ACCOUNTS_OPEN_KEY);
  } catch {
    // A refused write only costs remembering the fold past this sitting.
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
