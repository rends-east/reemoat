import { ChevronLeft } from "lucide-react";
import { useState, type ReactNode } from "react";
import { catalogueUrl } from "../../instance";
import {
  MARKET_TABS,
  marketPaneTitle,
  marketPath,
  marketUpLabel,
  marketUpFrom,
  marketUpWithinNav,
  type MarketRoute,
} from "../../market";
import { navigate, useOrigin } from "../../router";
import type { AppState } from "../../store";
import { Empty, IconButton, tabPill } from "../bits";
import { MarketIcon } from "./MarketList";
import { MarketNav } from "./MarketNav";
import { InstalledList } from "./InstalledList";
import { MarketEntry } from "./MarketEntry";
import { MarketList } from "./MarketList";
import { PluginSettingsScreen } from "./PluginSettings";

/** Plugins as a route-backed pop-up beside Settings, with its rail and box; below sm a tab strip, since there is no index route. */
export function PluginsSheet({ state, route }: { state: AppState; route: MarketRoute }): ReactNode {
  const base = catalogueUrl(state.config);
  const origin = useOrigin();
  const up = marketUpFrom(route, origin);
  const withinNav = marketUpWithinNav(route, origin);
  // Carried with its id so the previous plugin's name never heads the next one.
  const [named, setNamed] = useState<{ id: string; name: string; version: string; icon: string | null } | null>(null);
  const identified = route.entry !== null && named !== null && named.id === route.entry ? named : null;
  const title = identified?.name ?? marketPaneTitle(route);

  const settingsScreen = route.entry !== null && route.settings.length > 0;
  // tsc does not carry the narrowing through this alias, so the JSX restates it.
  const paneScroll = `min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain no-scrollbar ${
    settingsScreen ? "" : "px-4 py-4 sm:px-5"
  }`;

  return (
    // The body only: the panel belongs to OverlaySheet, shared by every route-backed pop-up (Q3.484).
    <>
      {/* Settings' rail and box, string for string (Q3.553). */}
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-56 shrink-0 overflow-y-auto overscroll-contain no-scrollbar border-r border-edge sm:block">
          <MarketNav active={route.tab} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {up === null ? (
        <div className="flex shrink-0 items-baseline justify-between gap-3 px-4 pt-4 pb-4 sm:hidden sm:px-5">
          <h2 className="min-w-0 truncate text-xl font-semibold">{titleOf(route.tab)}</h2>
          {MARKET_TABS.filter((tab) => tab.id !== route.tab).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => navigate(marketPath(tab.id), true)}
              className={`${tabPill(false)} shrink-0`}
            >
              {tab.title}
            </button>
          ))}
        </div>
      ) : (
        // Replace, not push: the way up is always shallower.
        <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-4 sm:px-5">
          <span className={withinNav ? "contents sm:hidden" : "contents"}>
          <IconButton
            icon={ChevronLeft}
            label={marketUpLabel(route, origin)}
            size="nav"
            className="-ml-1"
            onClick={() => navigate(up, true)}
          />
          </span>
          {route.entry !== null && <MarketIcon icon={identified?.icon ?? null} size={20} />}
          {/* The only place the plugin is named; on its settings screen the trailing word names the screen, as versions may differ per machine. */}
          {title !== null && (
            <h2 className="min-w-0 truncate text-sm font-medium">
              {title}
              {route.settings.length > 0 ? (
                <span className="ml-1.5 text-2xs font-normal text-muted">settings</span>
              ) : (
                identified !== null && <span className="ml-1.5 text-2xs font-normal text-muted">{identified.version}</span>
              )}
            </h2>
          )}
        </div>
      )}

      <div className={paneScroll}>
      {settingsScreen && route.entry !== null ? (
        // Tested before the catalogue: settings come from the daemons, so this works with no market.
        <PluginSettingsScreen
          key={route.settings.join("\u0000")}
          state={state}
          pluginId={route.entry}
          machines={route.settings}
          onIdentified={setNamed}
        />
      ) : route.entry !== null ? (
        // No null-base arm: MarketEntry handles a missing catalogue itself.
        <MarketEntry state={state} base={base} entryId={route.entry} onIdentified={setNamed} />
      ) : route.tab === "installed" ? (
        <InstalledList state={state} base={base} />
      ) : base === null ? (
        <Empty>{NO_CATALOGUE}</Empty>
      ) : (
        <MarketList state={state} base={base} />
      )}
      </div>
        </div>
      </div>
    </>
  );
}

function titleOf(tab: MarketRoute["tab"]): string {
  return MARKET_TABS.find((one) => one.id === tab)?.title ?? "Plugins";
}

const NO_CATALOGUE =
  "This server has no plugin catalogue, so there is nothing to browse. You can still install a plugin from a file under Installed.";
