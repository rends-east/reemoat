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
import { Sheet } from "../Sheet";
import { MarketIcon } from "./MarketList";
import { MarketNav } from "./MarketNav";
import { InstalledList } from "./InstalledList";
import { MarketEntry } from "./MarketEntry";
import { MarketList } from "./MarketList";
import { PluginSettingsScreen } from "./PluginSettings";

/**
 * Plugins, as a pop-up over whatever you were looking at.
 *
 * A route-backed sheet like Settings, and a sibling of it rather than a section
 * inside it: what happens here is everything that is *about a plugin* — finding
 * one, reading what it may do, deciding which of your machines has it, and setting
 * it up. What stays in the settings sheet is what is about a **machine**: which
 * plugins that host has, whether each is switched on, and handing it a file. Every
 * row there links here.
 *
 * ⚠ **Settings' rail at `sm` and above, and Settings' box string for string.**
 * This drew two tabs and no rail, on the argument that Settings earns its 224px
 * column by having four sections while two tabs in a column would be more chrome
 * than content. What that missed is that the two pop-ups are siblings a tap apart:
 * one opening as a heading with a pill beside it and the other as a rail beside a
 * pane reads as two applications, and the column is the shape somebody arrives
 * already knowing how to use. `RailRow` is shared with `SettingsNav` so the two
 * cannot measure differently.
 *
 * ⚠ **Below `sm` the strip stays, and it stays because there is no index here.**
 * Settings has one — `/settings` draws its section list and a row drills in — and
 * the market has none: a tab *is* the content, so there is no address for a list
 * to live at and inventing one would move `parseMarketRoute`'s pinned answers to
 * buy a screen whose whole content is two words. So the phone keeps the
 * heading-plus-one-link row, `sm:hidden`, and both it and the rail read
 * `MARKET_TABS`.
 *
 * Three depths: a tab, one plugin, and that plugin's settings. The head carries
 * the way up at the deeper two — withdrawn at `sm`+ exactly where the rail already
 * draws that row, which is `marketUpWithinNav` and not a class string reasoning
 * about the origin — and the **gear** at the middle one.
 */
export function PluginsSheet({ state, route }: { state: AppState; route: MarketRoute }): ReactNode {
  const base = catalogueUrl(state.config);
  /*
   * The other pop-up this one was opened from, when there is one — a plugin row in
   * the settings sheet is the crossing that exists today. `marketUpFrom` consults
   * it at exactly one depth; see its docblock.
   */
  const origin = useOrigin();
  const up = marketUpFrom(route, origin);
  /*
   * Whether that way up is a row the rail draws, which decides only whether the
   * chevron is withdrawn at `sm`+. A pure decision in `market.ts` rather than a
   * class string reasoning about the origin here — see its docblock: an origin
   * points at a settings screen this rail cannot draw, so the chevron stays.
   */
  const withinNav = marketUpWithinNav(route, origin);
  /*
   * What the entry below turned out to be, once the catalogue answered.
   *
   * ⚠ **Carried with the id it belongs to, and used only when the two agree.**
   * Walking from one plugin to another remounts the body but not this, so a plain
   * `string` would leave the previous plugin's name in the head until the next
   * read lands — a header naming a different thing from the screen under it.
   */
  const [named, setNamed] = useState<{ id: string; name: string; version: string; icon: string | null } | null>(null);
  /*
   * ⚠ **The id is the placeholder, never the answer.** It is what the route
   * carries and therefore all this head can know before a fetch; the moment the
   * catalogue answers, the *name* replaces it — because the body no longer draws
   * one, and two spellings of the same plugin one above the other (`autotitle`
   * over `Auto title`) read as two objects rather than as one screen.
   */
  const identified = route.entry !== null && named !== null && named.id === route.entry ? named : null;
  const title = identified?.name ?? marketPaneTitle(route);

  return (
    /*
     * The head names the pop-up and nothing else, `Sheet`'s standing rule: it is a
     * child of the panel, so above `sm` it spans everything under it, and the only
     * honest string there is the pop-up's own name.
     */
    <Sheet title="Plugins">
      {/*
       * ⚠ **The settings sheet's box, string for string.** Two rails one tap apart
       * inside sheets that look the same must not measure differently, and the
       * negative margins cancel `SHEET_BODY`'s own `px-4 py-5 sm:px-5` for the
       * reason `Settings.tsx` records: the body stops being the scroller and the
       * pane's own box takes over, which is the structure `SHEET_BODY` was given a
       * flex context to support.
       *
       * ⚠ No `overflow-y-auto` on this row or on the pane column — only on the rail
       * and on the scroller inside the pane. Chrome ends the scroll chain at a box
       * carrying `overscroll-behavior: contain` even when it has nothing to scroll.
       */}
      <div className="-mx-4 -my-5 flex min-h-0 flex-1 sm:-mx-5">
        <div className="hidden w-56 shrink-0 overflow-y-auto overscroll-contain border-r border-edge sm:block">
          <MarketNav active={route.tab} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {up === null ? (
        /*
         * ⚠ **The tab you are on is the heading; the other one is a link beside
         * it.** Two equal pills said "these are two of a kind, pick one" — but they
         * are not two of a kind: the market is a place you browse and Installed is
         * a short list of what you already have. Making the current one a title
         * gives the screen a name at the size a screen's name is, and leaves the
         * other as what it is, one step away.
         *
         * With two tabs there is always exactly one link, so this needs no strip,
         * no scroller and no selected state — the heading *is* the selected state.
         * A third tab would have to go back to pills, and that is the right moment
         * to reconsider rather than to grow this into a bar.
         */
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
        /*
         * The way up, and the name of the screen it leaves, in one row — the shape
         * `Settings.tsx` settled on, and here for its reason: a chevron in the
         * sheet's head sits 40px from the panel's left edge and a whole bar away
         * from the thing it is a chevron *for*.
         *
         * `navigate(up, true)` — **replace**, because this is shallower by
         * construction. With `push`, Android's Back would walk the sheet backwards
         * instead of popping out of it, which is the standing rule for anything
         * inside an overlay that moves you up.
         */
        <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-4 sm:px-5">
          {/*
           * ⚠ **The chevron is withdrawn at `sm`+, and the name beside it is not.**
           * This gate rode the whole row for one release, which took the plugin's
           * identity off the desktop with it: the head says "Plugins", the rail says
           * "Market", and the pane opened on a description with nothing anywhere
           * naming what it was a description *of*. The rail makes the way back
           * redundant; it says nothing about which plugin.
           */}
          <span className={withinNav ? "contents sm:hidden" : "contents"}>
          <IconButton
            icon={ChevronLeft}
            /*
             * ⚠ **Named for where it actually goes.** With an origin the ◀ leaves
             * this pop-up for the screen that linked here, so "Back to Market"
             * would name a list the person has never opened — which is precisely
             * the complaint this whole change is about, and saying it out loud in
             * the accessible name is the worst version of it.
             */
            label={marketUpLabel(route, origin)}
            size="sm"
            className="-ml-1"
            onClick={() => navigate(up, true)}
          />
          </span>
          {/* The icon, at the size a title takes rather than a row's 32px: this is
              identification for a screen somebody is standing on, not a thing to
              pick out of a list. */}
          {route.entry !== null && <MarketIcon icon={identified?.icon ?? null} size={20} />}
          {/* ⚠ **The one place this plugin is named, and the one place its
              version is.** The body used to repeat both immediately under this
              bar; it no longer draws either, so `truncate` matters here in a way
              it did not when this held a short slug — a plugin may call itself
              anything.
              ⚠ **On the settings screen the trailing word names the screen rather
              than the version.** That screen has no heading of its own — a
              section called Settings under a bar you reached by pressing a gear
              says the same thing twice — so this is the only place it is named,
              and a version there would be the wrong fact: settings are per
              machine and the machines may be on different versions. */}
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

      {/* The pane's own scroller, `Settings.tsx`'s string — and the only box in this
          column carrying `overscroll-contain`, because it is the only one that can
          always scroll. */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
      {route.entry !== null && route.settings.length > 0 ? (
        /*
         * ⚠ **No catalogue is consulted here and none is needed.** A plugin's
         * settings are drawn by the daemon holding it, so this screen works on an
         * instance with no market at all and on a plugin that arrived as a file —
         * which is why it is tested before `base === null` rather than inside it.
         */
        <PluginSettingsScreen
          key={route.settings.join("\u0000")}
          state={state}
          pluginId={route.entry}
          machines={route.settings}
          onIdentified={setNamed}
        />
      ) : route.entry !== null ? (
        /*
         * ⚠ **No `base === null` arm here, and removing it is the fix.** This
         * tested it first and answered with the *market's* sentence — "this server
         * has no plugin catalogue, so there is nothing to browse" — about a plugin
         * the person reached from their own machine's settings. `MarketEntry`
         * takes a nullable base now and routes it to `Offline`, which is the page
         * written for exactly this: a plugin the catalogue cannot describe, drawn
         * from what the machines report, with removal still on it.
         *
         * `NO_CATALOGUE` belongs to the Market *tab*, which is the only place
         * where having no catalogue is the whole answer.
         */
        <MarketEntry state={state} base={base} entryId={route.entry} onIdentified={setNamed} />
      ) : route.tab === "installed" ? (
        <InstalledList state={state} base={base} />
      ) : base === null ? (
        /*
         * ⚠ **An instance with no market says so and points at what still works.**
         * `REEMOAT_CP_PLUGIN_CATALOGUE_URL` unset is an ordinary deployment rather
         * than a fault — the catalogue is a separate service somebody has to run —
         * and installing a plugin from a file has never involved it. A blank tab
         * would send somebody looking for a network problem that is not there.
         */
        <Empty>{NO_CATALOGUE}</Empty>
      ) : (
        <MarketList state={state} base={base} />
      )}
      </div>
        </div>
      </div>
    </Sheet>
  );
}

/** The heading, which is the tab somebody is on. See the head of this file. */
function titleOf(tab: MarketRoute["tab"]): string {
  return MARKET_TABS.find((one) => one.id === tab)?.title ?? "Plugins";
}

const NO_CATALOGUE =
  "This server has no plugin catalogue, so there is nothing to browse. You can still install a plugin from a file under Installed.";
