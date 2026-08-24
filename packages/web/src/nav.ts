import type { Route } from "./router";
import { isOverlayPath } from "./ui/overlay";
import { marketUpFrom } from "./market";
import { settingsUp } from "./settings";

/**
 * Which way a navigation goes, and what moves when it does.
 *
 * Its own module and not `router.ts` for the reason `settings.ts` and `gate.ts`
 * are: that file reads `window.location` **in its module body**, so nothing
 * offline can import it at all, and a rule left inside it is a rule with no
 * assertion under it. Everything here is pure and takes routes as values.
 *
 * `Route` crosses as a **type**, which is erased — importing it costs nothing at
 * runtime and buys exhaustiveness, so a sixth route shape is a compile error here
 * rather than a screen that silently animates the wrong way.
 */

/**
 * The five things a navigation can be, as the value `router.ts` writes onto the
 * document and `index.css` keys every rule off.
 *
 * One attribute rather than a direction plus a scope, because the pair is never
 * free: there is no "forward, sheet-close", and a shape that can express one is a
 * shape somebody has to check for. What each moves is in `index.css`.
 */
export type NavMove = "push" | "pop" | "section-push" | "section-pop" | "sheet-close";

/**
 * How deep a screen sits.
 *
 * Two stacks rather than one, because `/settings` and `/new` are **pop-ups over
 * whatever you were looking at** rather than places further along the same line:
 * `router.ts` records what they are drawn over, and `Sheet` portals them out of
 * the layout entirely. What moves when you open one is the sheet; what moves when
 * you go from the list to a conversation is the screen. Depths from the two
 * stacks are never compared — {@link navMove} tests which stack first.
 *
 * The gate screens are `0` beside home deliberately. `/register` and `/forgot`
 * are the sign-in form with different fields, reached by a link inside it and
 * left by "Back to sign in"; there is no list-and-detail relationship to draw.
 */
export function depthOf(route: Route): number {
  switch (route.name) {
    case "home":
    case "gate":
      return 0;
    case "session":
      return 1;
    /*
     * A plugin's screen is one depth inside its own stack and has nothing deeper,
     * which is what makes every navigation *within* it `null` — the same shape
     * `/new` has, and for the same reason: there is one screen.
     */
    case "plugin":
      return 1;
    /*
     * Inside a sheet, and the depths are the screens somebody walks through: the
     * section list, a section, a machine, then one of the two lists under it —
     * that machine's agents or its plugins — and one of those. `/new` has one
     * screen and therefore one depth, which is what makes every navigation within
     * it `null`.
     *
     * ⚠ **One list has a leaf and the other no longer does.** An agent is a
     * fourth depth; a plugin's settings left this sheet for the plugin's own page
     * under `/plugins`, so `…/plugins/:pluginId` parses to depth 3 — the machine
     * — rather than to a screen. That is the same answer the URL now gives, and
     * the two have to agree or the animation plays against a screen nobody is on.
     */
    case "new":
      return 1;
    case "settings":
      if (route.agent !== null) return 4;
      if (route.machineId !== null) return 3;
      return route.section !== null ? 2 : 1;
    /*
     * Three depths: a tab, one catalogue entry read in full, and that entry's
     * settings. Both tabs are the same depth deliberately — moving between Market
     * and Installed is what the rail does all day one stack over, and `navMove`
     * answers `null` for equal depths, which is right: the same pane with
     * different contents is not a direction.
     *
     * The settings leaf is a depth rather than a section on the entry, so opening it
     * pushes and the ◀ pops — the same pair the settings sheet gives an agent.
     * `parseMarketRoute` never fills `settings` without an `entry`, so the order of
     * these two tests decides nothing.
     *
     * ⚠ **Two settings routes over different machines are the same depth**, so
     * `navMove` between them is `null` — the same pane with different contents is
     * not a direction, which is the rule this function's own head states.
     */
    case "plugins":
      if (route.settings.length > 0) return 3;
      return route.entry !== null ? 2 : 1;
  }
}

/**
 * Whether a route is drawn as a pop-up over something else.
 *
 * The other half of `isOverlayPath` in `overlay.ts`, which answers the same
 * question from a path rather than from a parsed route. `webcheck` asserts the
 * two agree over every route shape, because a route in one and not the other is a
 * pop-up that either forgets what it was drawn over or records one while being a
 * screen.
 */
export function isSheet(route: Route): boolean {
  return (
    route.name === "settings" || route.name === "new" || route.name === "plugin" || route.name === "plugins"
  );
}

/**
 * What this navigation moves, or `null` for one that moves nothing.
 *
 * **The `null` arms are the load-bearing ones**, and each is a place motion would
 * be wrong rather than merely absent:
 *
 * - **Equal depth.** Session → session is what a desktop rail does all day, and
 *   there is no direction in it: the same pane has different contents. It is also
 *   what keeps the cost honest, since a snapshot is only taken when something is
 *   going to move.
 * - **Opening a sheet.** Drawn in CSS by `SHEET_PANEL`'s own `animate-sheet`,
 *   which runs on mount and needs no snapshot — and, unlike a view transition,
 *   works on an engine that has never heard of one. A transition here as well
 *   would animate the same panel twice.
 * - **Between the two stacks in any other combination**, which the URL can
 *   express and nothing can reach: a sheet is always opened over a screen and
 *   closed back onto one.
 */
export function navMove(from: Route, to: Route): NavMove | null {
  const leaving = isSheet(from);
  const arriving = isSheet(to);

  // Closing: the sheet goes back down the way it came, and the screen behind it
  // was never involved.
  if (leaving && !arriving) return "sheet-close";
  // Opening is CSS's, per the docblock above.
  if (!leaving && arriving) return null;

  const here = depthOf(from);
  const there = depthOf(to);
  if (here === there) return null;
  if (leaving && arriving) return there > here ? "section-push" : "section-pop";
  return there > here ? "push" : "pop";
}

/**
 * Where "up" goes from here, or `null` at the root.
 *
 * **One rule for two controls**, which is the whole reason it is a function
 * rather than a `switch` inside a component. The app already draws its own
 * leading control on every screen — `Header`'s chevron, a sheet's ✕, a section's
 * ◀ — and Telegram draws a *second* one over the top of it when this runs as a
 * mini app. Two back affordances that disagree is worse than one, so both read
 * this.
 *
 * `null` is what makes Telegram show **Close** rather than Back: the client has
 * one control and hiding the back button is how the other appears. So the root
 * having no "up" is not an absence handled somewhere else, it is the answer.
 *
 * `under` is the path a pop-up was opened over, which `router.ts` keeps in
 * `history.state` — passed in rather than read, so this stays pure and
 * `webcheck` can walk it.
 *
 * Deliberately **not** `history.back()`, for the reason `Header.tsx` gives at
 * length: on a cold deep link there is one history entry and Back leaves the app
 * altogether — which in Telegram means closing the mini app from a conversation,
 * i.e. exactly the thing this exists to stop.
 */
export function upFrom(route: Route, under: string, origin: string | null = null): string | null {
  switch (route.name) {
    case "home":
    case "gate":
      return null;
    case "session":
      return "/";
    case "new":
    case "plugin":
      // Nothing deeper inside either, so up is out — onto whatever it was opened
      // over, which is what the sheet's own ✕ does.
      return under;
    case "settings": {
      // A section walks one level up inside the sheet; the index leaves it. Both
      // are `settingsUp`'s answer, which is what the ◀ and the ✕ already draw.
      const parent = settingsUp(route);
      return parent === null ? under : parent.path;
    }
    case "plugins": {
      /*
       * The same shape one pop-up over: an entry walks back to the list it was
       * reached from, and a tab leaves the pop-up. `marketUpFrom` answers `null`
       * at a tab for exactly this reason.
       *
       * ⚠ **`origin` is why this takes a third argument.** An entry reached from
       * the settings sheet walks back *there* rather than to the market list — the
       * list it fell through to was one the person had never opened. It defaults
       * to `null`, which is `marketUp`'s own answer, so every existing caller and
       * every history entry written before the field existed keeps today's
       * behaviour.
       */
      const parent = marketUpFrom(route, origin);
      return parent === null ? under : parent;
    }
  }
}

/**
 * The pop-up a path belongs to — its first segment, which is what
 * {@link isOverlayPath} tests.
 *
 * A third member of the `isSheet`/`isOverlayPath` family: those two answer
 * *whether* a path is an overlay, from a route and from a string; this answers
 * **which** overlay. Compared as a segment rather than by prefix, because
 * `/p/:machineId/:pluginId` (a plugin's own screen) and `/plugins` (the market)
 * share four letters and are two different pop-ups — a `startsWith` calls them
 * the same one.
 */
export function overlayKind(pathname: string): string {
  return pathname.split("/")[1] ?? "";
}

/**
 * Which overlay a navigation to `target` is being made *from*, or `null`.
 *
 * ⚠ **Here rather than in `router.ts`, and the move is this module's whole
 * reason.** The docblock at the head of this file states it: `router.ts` reads
 * `window.location` in its module body, so nothing offline can import it, and a
 * rule left in there is a rule with no assertion under it. This one was left in
 * there — and it was the single decision in the origin work that no driver could
 * reach, which a mutation run proved by inverting its comparison and watching
 * every check stay green.
 *
 * Set only when one overlay opens a **different** one. Walking deeper inside one
 * pop-up keeps the origin it already had, so the ◀ walks that pop-up's own depths
 * first and reaches the origin at its shallowest one rather than short-circuiting
 * to it.
 *
 * `held` is the origin already recorded on the current history entry, passed in
 * rather than read, so this stays pure.
 */
export function originFor(here: string, target: string, held: string | null): string | null {
  if (!isOverlayPath(target)) return null;
  if (!isOverlayPath(here)) return null;
  return overlayKind(here) === overlayKind(target) ? held : here;
}
