import type { Route } from "./router";
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
     * Inside a sheet, and the four depths are the four screens somebody walks
     * through: the section list, a section, a machine's agents, one agent.
     * `/new` has one screen and therefore one depth, which is what makes every
     * navigation within it `null`.
     */
    case "new":
      return 1;
    case "settings":
      if (route.agent !== null) return 4;
      if (route.machineId !== null) return 3;
      return route.section !== null ? 2 : 1;
  }
}

/** Whether a route is drawn as a pop-up over something else. */
export function isSheet(route: Route): boolean {
  return route.name === "settings" || route.name === "new";
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
export function upFrom(route: Route, under: string): string | null {
  switch (route.name) {
    case "home":
    case "gate":
      return null;
    case "session":
      return "/";
    case "new":
      return under;
    case "settings": {
      // A section walks one level up inside the sheet; the index leaves it. Both
      // are `settingsUp`'s answer, which is what the ◀ and the ✕ already draw.
      const parent = settingsUp(route);
      return parent === null ? under : parent.path;
    }
  }
}
