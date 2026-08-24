import type { CatalogueEntry } from "./catalogue";
import { machineId, type MachineId } from "./ids";

/**
 * Which plugins screen a URL names.
 *
 * Its own module rather than lines inside `router.ts`, for the reason
 * `settings.ts` and `gate.ts` each give at their head: `router.ts` reads
 * `window.location.pathname` and installs a `popstate` listener **in its module
 * body**, and `webcheck` stubs `location.href` and nothing else — so importing it
 * throws before a single case runs. A decision `webcheck` cannot reach is a
 * decision nothing asserts, and every rule here decides where a control on screen
 * takes somebody.
 *
 * Four addresses:
 *
 *   /plugins                      the market
 *   /plugins/installed            what is on your machines
 *   /plugins/p/:id                one plugin in the market, in full
 *   /plugins/p/:id/settings/:m…   that plugin's settings, on those machines
 *
 * **`/p/:machineId/:pluginId` is a different screen and stays where it is.** That
 * one is a plugin *drawing something* on a machine — a board somebody opens
 * several times a day. This is the market. They share a word and nothing else,
 * and `router.ts` parses `p` and `plugins` as different first segments.
 */

/** The two things this pop-up is: a place to find plugins, and a list of yours. */
export type MarketTab = "market" | "installed";

export interface MarketRoute {
  tab: MarketTab;
  /**
   * The catalogue entry being read in full, if the URL names one.
   *
   * **Never set under `installed`**, and that is enforced by
   * {@link parseMarketRoute} rather than by the type — `SettingsRoute` makes
   * exactly this trade one file over, and for its reason: a discriminated union
   * would express it and would make every consumer that only wants the tab narrow
   * first, for a rule with one producer.
   *
   * Not validated against anything. The set of ids is whatever the catalogue
   * holds, which this client cannot know before it asks — the same posture the
   * plugin id in `parseSettingsRoute` takes, and the opposite of the agent id
   * beside it, which is handed straight to a route that refuses an unknown one.
   */
  entry: string | null;
  /**
   * The machines whose settings are on show, in the order the URL named them.
   * **Empty means this is not the settings screen.**
   *
   * ⚠ **A screen of its own rather than a section on the entry page.** The entry
   * page is what a plugin *is* — what it does, what it may do, where it is — and
   * is read once; its settings are what somebody came back for. As a section they
   * sat below a fold of permissions and above an install control, on a page that
   * also carries a version history, which is a form buried in a brochure.
   *
   * ⚠ **A list rather than a flag, and the list is the point.** Settings are an
   * act on *the machines somebody selected* on the plugin's page, so the screen
   * has to carry which — and the URL is the only place that survives a reload,
   * Back, Forward and being shared. `plugin_data` is a table in one daemon's
   * SQLite; a screen that could not say which daemons it was about would be the
   * one lie this subsystem refuses.
   *
   * ⚠ **Empty is the entry page, and never "all machines".** Writing a form into
   * a host nobody selected is the failure this shape exists to prevent, and "all"
   * is the guess that produces it. The absence of a machine is the absence of the
   * screen.
   *
   * Never non-empty without an `entry`, enforced by {@link parseMarketRoute}
   * rather than by the type — `MarketRoute.entry`'s own note gives the reason, and
   * it is the same one.
   */
  settings: readonly MachineId[];
}

/**
 * The whole plugins URL, from the segments after `/plugins`.
 *
 * Three refusals, each falling *up* to the nearest real screen rather than to a
 * 404 — `parseSettingsRoute`'s posture, for its reason: a stale bookmark or a
 * plugin withdrawn from the catalogue should land somewhere real.
 *
 *   - a bare `/plugins/p` names no entry and is the market list;
 *   - any first segment but `installed` and `p` is the market list too, rather
 *     than a tab nothing draws;
 *   - anything after an entry id that is not `settings` is that entry's own page.
 *
 * Matched exactly, so the case a URL happens to arrive in never decides what is
 * rendered.
 */
export function parseMarketRoute(
  segments: readonly (string | undefined)[],
  decode: (part: string) => string = (part) => part,
): MarketRoute {
  if (segments[0] === "installed") return { tab: "installed", entry: null, settings: [] };
  if (segments[0] === "p") {
    const wanted = segments[1];
    // An entry always belongs to the market, so the tab behind it is `market` at
    // every depth. That is what makes the ◀ land on a list with the plugin in it.
    if (wanted === undefined) return { tab: "market", entry: null, settings: [] };
    /*
     * Anything after the id that is not the literal `settings` drops to the
     * plugin's own page — the "fall up to the nearest real screen" posture this
     * function already takes twice, and the one `parseSettingsRoute` takes for the
     * segment after a machine.
     */
    if (segments[2] !== "settings") return { tab: "market", entry: decode(wanted), settings: [] };
    /*
     * ⚠ **Deduplicated, and empty segments dropped, because the fan-out is over
     * this list.** `…/settings/m_1/m_1` would send the same form to one daemon
     * twice — harmless for an idempotent plugin and a double write for any other —
     * and the line whose whole job is to say which machines would name one of them
     * twice. `//` names nothing.
     *
     * ⚠ **Not sorted.** {@link marketSettingsPath} joins in the order it is given,
     * so sorting here would make a path and its own parse disagree about the
     * string, which is the one thing a round trip must not do.
     *
     * ⚠ **And not bounded.** A ceiling that silently dropped machines would be the
     * inverse of the failure this shape prevents — it would skip a host somebody
     * *did* select, and skipping is exactly as quiet as writing. A fleet of two
     * hundred is a four-kilobyte path, under every limit in the way.
     */
    const named = segments
      .slice(3)
      .filter((one): one is string => one !== undefined && one.length > 0)
      .map((one) => machineId(decode(one)));
    return { tab: "market", entry: decode(wanted), settings: [...new Set(named)] };
  }
  return { tab: "market", entry: null, settings: [] };
}

/**
 * The path for a tab.
 *
 * Positional and widening, `settingsPath`'s shape — and like it, the deeper leaf
 * has its own builder rather than a second positional, because an entry under
 * `installed` is not expressible and must not be.
 */
export function marketPath(tab: MarketTab = "market"): string {
  return tab === "installed" ? "/plugins/installed" : "/plugins";
}

/**
 * The path for one catalogue entry.
 *
 * A separate builder for {@link pluginSettingsPath}'s reason: the two leaves are
 * mutually exclusive, and a signature able to take both would be a signature able
 * to express a URL nothing parses.
 */
export function marketEntryPath(entry: string): string {
  return `/plugins/p/${encodeURIComponent(entry)}`;
}

/**
 * The path for one plugin's settings, on a given set of machines.
 *
 * ⚠ **The machines are required rather than a widening positional.**
 * `settingsPath`'s idiom does not apply here: an entry with no machines is not a
 * settings screen at all, so a signature able to omit them would be a signature
 * able to express a URL that falls up to a different page. The one caller that
 * could produce an empty list draws its control disabled instead, and
 * {@link parseMarketRoute}'s fall-up is the belt under a stale bookmark.
 *
 * ⚠ **Each id is its own segment, and that is not a formatting choice.**
 * `encodeURIComponent` does **not** escape a comma, so a comma-joined list and a
 * single id holding one are the same string — and the failure is silent and in the
 * direction that writes to machines nobody chose.
 *
 * Built on {@link marketEntryPath} rather than beside it, so the two cannot
 * disagree about how an id is encoded — a plugin id is a URL segment and may hold
 * anything a manifest wrote.
 */
export function marketSettingsPath(entry: string, machines: readonly MachineId[]): string {
  const base = `${marketEntryPath(entry)}/settings`;
  return machines.length === 0 ? base : `${base}/${machines.map((one) => encodeURIComponent(one)).join("/")}`;
}

/**
 * One level up from a plugins screen, or `null` at a tab.
 *
 * `null` means *leave the pop-up*, which is what the ✕ already does — the same
 * shape `settingsUp` uses at its index, so `upFrom` can treat the two pop-ups
 * identically. An entry goes back to the market list rather than to whichever tab
 * somebody was on, because an entry is only ever reached from that list.
 */
export function marketUp(route: MarketRoute): string | null {
  if (route.entry === null) return null;
  // Settings walk to the plugin, and the plugin walks to the list — one level at a
  // time, which is what stops the ◀ and the ✕ becoming the same control.
  return route.settings.length > 0 ? marketEntryPath(route.entry) : marketPath("market");
}

/**
 * One level up, honouring the pop-up this one was opened from.
 *
 * ⚠ **Exactly one of {@link marketUp}'s three answers is overridable, and it is
 * the one that was wrong.** A *tab* answers `null` — leave the pop-up — and that
 * is right however you arrived. *Settings* walk to their own plugin, which is a
 * depth inside this pop-up and has nothing to do with where you came from. Only
 * an **entry** falls through to the market list, on `marketUp`'s stated reasoning
 * that "an entry is only ever reached from that list" — which stopped being true
 * when `PluginsPanel` started linking here, and produced a ◀ labelled *Back to
 * Market* pointing at a list the person had never been on, while the machine they
 * were configuring became unreachable without leaving the pop-up entirely.
 *
 * So the origin is consulted at that one depth and nowhere else. `marketUp` keeps
 * its own answer and its own assertions; this is a second, narrower question with
 * the first inside it, rather than an edit to it.
 *
 * Pure, and the origin arrives as a value for `market.ts`'s standing reason: this
 * module may not import `router.ts`, which reads `window.location` in its module
 * body, so a rule left in there is a rule `webcheck` cannot reach.
 */
export function marketUpFrom(route: MarketRoute, origin: string | null): string | null {
  if (route.entry !== null && route.settings.length === 0 && origin !== null) return origin;
  return marketUp(route);
}

/**
 * Whether the screen this ◀ points at is a row the rail already draws.
 *
 * `settingsUp`'s second field, as a function of its own — because {@link
 * marketUpFrom} answers a **string** whose values are pinned, and widening its
 * return type would move every one of them. Q3.432 made exactly this split once
 * already, for `settingsUpLabel`, and for the identical reason.
 *
 * ⚠ **It is subtler than `settingsUp`'s field, and the first line is why.**
 * `marketUpFrom` can answer an **origin** — a settings-sheet path somebody crossed
 * in from — and the rail draws this pop-up's own two tabs and nothing else. So a
 * chevron leaving here is the only way back **at every width** and must never be
 * withdrawn.
 *
 * ⚠ **The first line and a plain `origin !== null` agree on every shape this
 * parser can produce today, and that is said out loud rather than left to be
 * discovered.** They can only differ at a depth where the origin is *offered* and
 * does not win, and the settings depth — the one that fits that description — is
 * already excluded by the second line. So no driver can tell the two spellings
 * apart, and injecting the proxy fails nothing. The comparison is kept anyway
 * because it derives from the question actually being asked — *did the override
 * fire* — rather than from a condition that currently implies it: a fourth depth
 * that consulted the origin would be carried by this and silently mishandled by
 * the proxy. That is a reason to prefer it, not a property to claim, which is why
 * the sweep beside it runs over every shape × both origin states rather than over
 * this arm.
 */
export function marketUpWithinNav(route: MarketRoute, origin: string | null): boolean {
  if (marketUpFrom(route, origin) !== marketUp(route)) return false;
  // A tab has no parent inside the pop-up at all — `marketUp` is `null` exactly
  // when `entry` is — and settings walk to their own plugin, which is a depth
  // rather than a rail row.
  return route.entry !== null && route.settings.length === 0;
}

/**
 * What the ◀ says it goes to. `settingsUpLabel`'s counterpart.
 *
 * ⚠ **Named for where it actually goes.** With an origin the chevron leaves this
 * pop-up, so "Back to Market" would name a list the person has never opened —
 * which is precisely the complaint the origin work exists to answer, and saying it
 * in the accessible name is the worst version of it.
 *
 * Derived from the same comparison {@link marketUpWithinNav} makes, so a label and
 * a width gate that disagree are not expressible.
 */
export function marketUpLabel(route: MarketRoute, origin: string | null): string {
  if (route.settings.length > 0) return "Back to the plugin";
  return marketUpWithinNav(route, origin) ? "Back to Market" : "Back";
}

/**
 * The name of the screen the *pane* is showing, or `null` at a tab.
 *
 * `settingsPaneTitle`'s counterpart, and non-null on exactly the depths
 * {@link marketUp} is — a pairing `webcheck` asserts rather than a coincidence,
 * so a future depth cannot arrive with a chevron over an unnamed screen or a name
 * with no way back.
 *
 * ⚠ **The id, and it is the *placeholder* rather than the answer.** The name
 * lives on the entry, which this pure function has not fetched and must not wait
 * for: a heading that is empty until a network read lands is a heading that
 * flickers on every open. So this is what the head draws until the catalogue
 * answers, and `PluginsSheet` swaps in the real name the moment it has one —
 * which it must, because the body no longer draws a name at all. It used to, and
 * an id above a name (`autotitle` over `Auto title`) read as two objects about
 * two different plugins rather than as one screen.
 */
export function marketPaneTitle(route: MarketRoute): string | null {
  return route.entry;
}

/** What the tabs are called, in the order they are drawn. */
export const MARKET_TABS: readonly { id: MarketTab; title: string }[] = [
  { id: "market", title: "Market" },
  { id: "installed", title: "Installed" },
];

/**
 * One heading's worth of the catalogue.
 *
 * A `name` and its entries, rather than a map, because the order of the headings
 * is part of the answer and a map does not carry one.
 */
export interface CatalogueGroup {
  name: string;
  entries: CatalogueEntry[];
}

/** The heading for a plugin that names no category of its own. */
export const UNGROUPED = "Other";

/**
 * Whether this plugin is one somebody is looking for.
 *
 * ⚠ **Names only — the plugin's own name and its id — and not the description.**
 * A catalogue is a handful of entries, and a needle matched against prose hits
 * most of them for most words: "session" is in three descriptions and one name,
 * so searching it would return almost everything and the box would read as
 * broken. The id is included because it is what a link carries and what an author
 * writes down, so it is a name people do type.
 *
 * Case-insensitive and trimmed. An empty needle matches everything, which is what
 * makes an empty box mean "no search" rather than "no results".
 */
export function matchesQuery(entry: CatalogueEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return entry.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle);
}

/**
 * The catalogue under the needle, in the order it is drawn.
 *
 * ⚠ **Grouped by the *first* category and by nothing else.** A plugin may list
 * several, and drawing it under each would put one row on screen two or three
 * times in a list whose whole job is to be countable — the same objection that
 * stopped a pinned session being drawn twice in the rail. The first is the one its
 * author put first.
 *
 * ⚠ **One group comes back as one group named after itself, and the caller draws
 * no heading for it.** A heading over the whole list labels "everything", and a
 * catalogue of one plugin under a category name reads as a section somebody forgot
 * to fill. Deciding that here rather than in the JSX keeps the rule in one place
 * and lets `webcheck` assert it.
 *
 * Groups by name, entries by name, both case-insensitively: an order that depends
 * on what the service happened to return is an order that changes under somebody
 * on the next publish.
 */
export function groupCatalogue(entries: readonly CatalogueEntry[], query: string): CatalogueGroup[] {
  const byName = new Map<string, CatalogueEntry[]>();
  for (const entry of entries) {
    if (!matchesQuery(entry, query)) continue;
    const name = entry.categories[0] ?? UNGROUPED;
    const held = byName.get(name);
    if (held === undefined) byName.set(name, [entry]);
    else held.push(entry);
  }
  const compare = (a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase());
  return [...byName.entries()]
    .sort((a, b) => {
      // `Other` last wherever it appears, because it is the absence of an answer
      // rather than one of them — alphabetically it would land in the middle and
      // read as a category somebody chose.
      if (a[0] === UNGROUPED) return 1;
      if (b[0] === UNGROUPED) return -1;
      return compare(a[0], b[0]);
    })
    .map(([name, found]) => ({ name, entries: [...found].sort((a, b) => compare(a.name, b.name)) }));
}
