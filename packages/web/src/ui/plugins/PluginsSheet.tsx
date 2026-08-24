import { ChevronLeft, Settings2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { catalogueUrl } from "../../instance";
import {
  MARKET_TABS,
  marketPaneTitle,
  marketPath,
  marketSettingsPath,
  marketUpFrom,
  type MarketRoute,
} from "../../market";
import { navigate, useOrigin } from "../../router";
import type { AppState } from "../../store";
import { Empty, IconButton, tabPill } from "../bits";
import { Sheet } from "../Sheet";
import { InstalledList } from "./InstalledList";
import { MarketEntry } from "./MarketEntry";
import { MarketList } from "./MarketList";
import { PluginSettingsScreen } from "./PluginSettings";
import { offersSettings } from "../../plugins";

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
 * ⚠ **Two tabs and no nav rail, unlike Settings.** Settings earns its 224px
 * column because it has four sections with sub-depths under two of them; two tabs
 * in a column would be a rail with more chrome than content. The strip is the
 * machine bar's own pill, through `tabPill`, so this pop-up does not grow a second
 * idiom for "you are looking at this one".
 *
 * Three depths: a tab, one plugin, and that plugin's settings. The head carries
 * the way up at the deeper two and the **gear** at the middle one, which is the
 * only way into the third.
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
   * What the entry below turned out to be, once the catalogue answered.
   *
   * ⚠ **Carried with the id it belongs to, and used only when the two agree.**
   * Walking from one plugin to another remounts the body but not this, so a plain
   * `string` would leave the previous plugin's name in the head until the next
   * read lands — a header naming a different thing from the screen under it.
   */
  const [named, setNamed] = useState<{ id: string; name: string; version: string } | null>(null);
  /*
   * Every plugin row every machine reports, flattened once. Read by the gear —
   * `offersSettings` is a pure decision over this list, so the head can ask
   * whether there is anything to configure without a request of its own.
   */
  const installed = [...state.pluginsByMachine.values()].flat();
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
        <div className="flex shrink-0 items-baseline justify-between gap-3 pb-4">
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
        <div className="flex shrink-0 items-center gap-2 pb-4">
          <IconButton
            icon={ChevronLeft}
            /*
             * ⚠ **Named for where it actually goes.** With an origin the ◀ leaves
             * this pop-up for the screen that linked here, so "Back to Market"
             * would name a list the person has never opened — which is precisely
             * the complaint this whole change is about, and saying it out loud in
             * the accessible name is the worst version of it.
             */
            label={route.settings ? "Back to the plugin" : origin === null ? "Back to Market" : "Back"}
            size="sm"
            className="-ml-1"
            onClick={() => navigate(up, true)}
          />
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
            <h2 className="min-w-0 truncate text-base font-semibold">
              {title}
              {route.settings ? (
                <span className="ml-1.5 font-normal text-muted">settings</span>
              ) : (
                identified !== null && <span className="ml-1.5 font-normal text-muted">{identified.version}</span>
              )}
            </h2>
          )}
          {/*
           * ⚠ **The gear, and it is the whole of how settings are reached.** They
           * were a section on the page below — under a permissions fold, above an
           * install control, on a page that also carries a version history — which
           * is a form buried in a brochure. A screen of its own needs a way in, and
           * a gear top-right is the one control every operating system has trained
           * everybody to look for.
           *
           * Drawn only where a machine actually reports a settings pane, from
           * `offersSettings`: a gear over a plugin that has none opens a screen
           * whose whole content is a sentence saying so.
           */}
          {!route.settings && route.entry !== null && offersSettings(installed, route.entry) && (
            <IconButton
              icon={Settings2}
              label={`Settings for ${title ?? route.entry}`}
              size="sm"
              className="ml-auto shrink-0"
              onClick={() => navigate(marketSettingsPath(route.entry ?? ""))}
            />
          )}
        </div>
      )}

      {route.entry !== null && route.settings ? (
        /*
         * ⚠ **No catalogue is consulted here and none is needed.** A plugin's
         * settings are drawn by the daemon holding it, so this screen works on an
         * instance with no market at all and on a plugin that arrived as a file —
         * which is why it is tested before `base === null` rather than inside it.
         */
        <PluginSettingsScreen state={state} pluginId={route.entry} onIdentified={setNamed} />
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
    </Sheet>
  );
}

/** The heading, which is the tab somebody is on. See the head of this file. */
function titleOf(tab: MarketRoute["tab"]): string {
  return MARKET_TABS.find((one) => one.id === tab)?.title ?? "Plugins";
}

const NO_CATALOGUE =
  "This server has no plugin catalogue, so there is nothing to browse. You can still install a plugin from a file under Installed.";
