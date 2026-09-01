import type { Route } from "./router";
import { isOverlayPath } from "./ui/overlay";
import { marketUpFrom } from "./market";
import { parseSettingsRoute, settingsPaneTitle, settingsUp } from "./settings";

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
 * The six things a navigation can be, as the value `router.ts` writes onto the
 * document and `index.css` keys every rule off.
 *
 * One attribute rather than a direction plus a scope, because the pair is never
 * free: there is no "forward, sheet-close", and a shape that can express one is a
 * shape somebody has to check for. What each moves is in `index.css`.
 */
export type NavMove =
  | "push"
  | "pop"
  | "section-push"
  | "section-pop"
  | "sheet-close"
  | "sheet-swap";

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
    /*
     * Deeper than `new`, because that is where it is opened from and where its ◀
     * goes back to — and one deeper again for a choice being made, which is the
     * same list-then-leaf shape a machine and its systems have inside settings.
     *
     * ⚠ **A picker is a depth rather than a menu, and the reason is the phone.**
     * `Dropdown` is right for a handful of options anchored to their control;
     * these two lists are unbounded (every model of every system this daemon can
     * reach) and carry a search box and a filter, which is a *screen*. Making it a
     * route is what gives it the horizontal slide, Android's Back, and a ◀ that
     * cannot disagree with either.
     *
     * **Editing an assembled agent is the same depth as assembling one**, and the
     * `edit` segment does not move it: it is the same screen with its rows already
     * filled in, reached from the same place and left to the same place. A preset
     * changes what the screen is *about*, never where it sits — and a depth that
     * disagreed would slide a push into something no deeper than what opened it.
     */
    case "agent":
      return route.step === null ? 2 : 3;
    case "settings":
      /*
       * The strip is a leaf under the machine, at the same depth one system sits
       * at — reached from a row on that screen and left to it. Tested **before**
       * the machine, since a strip route carries one.
       *
       * ⚠ It is also reached from New session's gear, and that is a *crossing*
       * between two pop-ups rather than a push: the two stacks' depths are never
       * compared, so `navMove` answers on the sheet stack and `origin` is what
       * points the ◀ back at `/new`. Nothing here has to know about that door.
       */
      if (route.agents) return 4;
      if (route.system !== null) return 4;
      // The third leaf under a machine, and it shares their depth for their reason.
      // Missing, it read as depth 3 — the machine screen it is pushed *from* — so
      // `navMove` saw `here === there`, answered `null`, and the section slide every
      // other leaf gets was silently absent in both directions.
      if (route.signin !== null) return 4;
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
/**
 * **Which** pop-up a route belongs to, or `null` for a screen.
 *
 * The route-shaped member of the `isSheet`/`isOverlayPath`/`overlayKind` family:
 * those answer *whether*, this answers *which*, from a parsed route rather than
 * from a string.
 *
 * ⚠ **`new` and `agent` are one pop-up**, which is the whole of why moving between
 * them slides a pane rather than replacing a panel — see `StartSheet`. `plugin`
 * and `plugins` are two, sharing four letters and nothing else.
 */
export function sheetKind(route: Route): string | null {
  switch (route.name) {
    case "settings":
      return "settings";
    case "new":
    case "agent":
      return "new";
    case "plugins":
      return "plugins";
    case "plugin":
      return "plugin";
    case "home":
    case "gate":
    case "session":
      return null;
  }
}

export function isSheet(route: Route): boolean {
  return (
    route.name === "settings" ||
    route.name === "new" ||
    route.name === "agent" ||
    route.name === "plugin" ||
    route.name === "plugins"
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

  /*
   * ⚠ **Two *different* pop-ups, and this arm has to come before the depths.**
   * A depth is a position inside one stack and means nothing across two: Settings
   * → a section is 1 → 2, Plugins → a tab is 1, so settings-account → plugins
   * compared 2 against 1 and answered `section-pop` — sliding one pop-up's pane
   * rightwards into another's, on top of a panel that was being replaced anyway.
   * Reported as the pop-up vanishing for a frame and a different one appearing.
   *
   * What it is instead is a **swap**: the panel holds still and its contents
   * dissolve. That works because the panel is now one element for every
   * route-backed pop-up — see `OverlaySheet` — so there is nothing to remount and
   * the two groups already share a box. `index.css` only has to pin the root.
   */
  if (leaving && arriving && sheetKind(from) !== sheetKind(to)) return "sheet-swap";

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
/**
 * `/new`, `/new/:machineId`, `/new/:machineId/:cwd`.
 *
 * ⚠ **Defined here rather than in `router.ts`, which is where its caller lives.**
 * `upFrom` needs it — the way back out of the agent builder is the New session
 * sheet it was opened from — and `nav.ts` may not import `router.ts`, which reads
 * `window.location` in its module body. `router.ts` re-exports this as `newPath`,
 * so there is one encoding of the rule rather than two that drift.
 *
 * A folder without a machine is not expressible and should not be: the picker it
 * seeds is a listing of *that daemon's* filesystem.
 */
export function newSessionPath(machine?: string, cwd?: string): string {
  if (machine === undefined) return "/new";
  const base = `/new/${encodeURIComponent(machine)}`;
  return cwd === undefined ? base : `${base}/${encodeURIComponent(cwd)}`;
}

/**
 * Which of the assembly flow's screens is on, or `null` for the builder itself.
 *
 * Two, and they are the two questions the builder asks — which model, which
 * harness. Named rather than numbered so the address says what it is showing.
 *
 * ⚠ **`llm` is an address, and it is no longer a word anybody reads.** The head
 * over that screen says "Choose model" — {@link sheetTitle} carries the argument
 * — while the segment stays exactly as it was: it is what every link already
 * written down is made of, and the rule above is about what the address *shows*,
 * which "llm" still says truthfully. Only one of the two is read by a person, so
 * only one of them had to move.
 */
export type AgentStep = "llm" | "harness";

const AGENT_STEPS: readonly AgentStep[] = ["llm", "harness"];

export function isAgentStep(value: string): value is AgentStep {
  return (AGENT_STEPS as readonly string[]).includes(value);
}

/**
 * What the one panel's head says, or `null` where only the body knows.
 *
 * ⚠ **Two different conventions, and which applies is a fact about the pop-up's
 * *shape* rather than a preference.** A head that spans a section rail can only
 * honestly carry the pop-up's own name — `SHEET_HEAD` is a child of the panel, so
 * above `sm` it sits over Settings' 224px list *and* the pane beside it — and
 * those pop-ups draw the screen's name, with their ◀, inside the pane (Q3.427,
 * Q3.432). A pop-up that is one column at every width has no such problem, so its
 * head names the **screen** and the ◀ goes in the head beside it (Q3.473).
 *
 * `null` is the plugin screen, and only that: its name is whatever the plugin
 * called its view, which arrives with the view. It reports it up. Q3.484.
 */
export function sheetTitle(route: Route): string | null {
  switch (route.name) {
    case "settings":
      return "Settings";
    case "plugins":
      return "Plugins";
    case "plugin":
      return null;
    case "new":
      return "New session";
    case "agent":
      switch (route.step) {
        case "llm":
          /*
           * ⚠ **"Choose model", over a route segment that still reads `llm`.**
           * This was the one string in the flow that used an acronym for the
           * thing beside it: every refusal on the same screen already says
           * *model* — `choiceRefusal` and `keyMissing` both do — and
           * `defaultAgentName` names a preset after the model it runs.
           * `agentCard.ts` states the standing rule and why it is swept at all:
           * a reader who has never seen an environment variable must not meet an
           * acronym either. The sweep could not have caught this one, because it
           * is a closure over `hostable`'s return values and reads no `.tsx` and
           * not this file — which is the argument for the rule being written
           * down here rather than trusted to the driver.
           *
           * The **segment** is deliberately untouched. It is an address: a link
           * written down last week has to keep opening this screen, and
           * `AgentStep` carries the rule that keeps the two allowed to differ.
           */
          return "Choose model";
        case "harness":
          return "Choose harness";
        case null:
          /*
           * Not "New agent": the screen's first line *is* the agent's name and an
           * unnamed one is called "New agent", so the head said the same two words
           * 40px above the thing they were naming — and editing the name left the
           * head claiming the old one. Q3.476.
           *
           * The same screen over a preset says **"Edit agent"**, which is the one
           * thing on it that says an existing agent is about to be overwritten
           * rather than a second one added — the fields are identical either way,
           * the button is identical either way, and the name in the first line is
           * somebody's own and reads exactly like a name they just typed.
           */
          return route.preset === null ? "Configure agent" : "Edit agent";
      }
    // eslint-disable-next-line no-fallthrough
    case "home":
    case "gate":
    case "session":
      return null;
  }
}

/**
 * Whether the panel's **head** draws the ◀, and what it is named by.
 *
 * `null` where it must not: the pop-ups with a section rail draw their own in the
 * pane, and a second chevron in the head would be two controls for one act. So
 * this answers for exactly one screen today — a choice being made inside the New
 * session pop-up — and says so by *shape* (`sheetTitle` names the screen there)
 * rather than by listing route names twice.
 *
 * The label is never painted; it is what the control is *named* by, and it names
 * the destination rather than saying "Back" — `Header`'s standing rule for this
 * control and the whole difference between it and the history button it must
 * never become.
 */
export function sheetUpLabel(route: Route, origin: string | null = null): string | null {
  if (route.name !== "agent") return null;
  /*
   * ⚠ **The builder has two ways in now, and the ◀ names whichever it was.** It
   * was opened only from New session, so this was a constant; the machine's
   * Agents screen opens it too, and a chevron reading "New session" over a
   * `upFrom` that returns to settings is precisely the control-naming-somewhere-
   * you-are-not-going that the note below is about. `origin` is what `upFrom`
   * reads, so it has to be what this reads — the two are one property split
   * across two functions, which is why `webcheck` sweeps them together.
   */
  if (route.step === null) return origin === null ? "New session" : originLabel(origin);
  // Both strings are the destination's own head, read off `sheetTitle` above
  // rather than restated: a ◀ named "Configure agent" pointing at a screen
  // titled "Edit agent" is the control naming somewhere you are not going.
  return route.preset === null ? "Configure agent" : "Edit agent";
}

/**
 * The head of the pop-up an address names, for a ◀ that points back into it.
 *
 * ⚠ **Only the two pop-ups that can cross *into* the builder, and the default is
 * the one that always could.** `originFor` sets an origin when one overlay opens
 * a different one, and exactly two open `/agent`: New session, whose head is a
 * constant, and the machine's Agents screen, whose head is `settingsPaneTitle`'s
 * answer. Anything else falls back rather than returning `null` — a ◀ with no name
 * is worse than one naming the screen it would have gone to before, and this is
 * reached only from a history entry a future release wrote.
 *
 * The settings arm is `settingsUpLabel`'s body, and it is a copy of three lines
 * rather than a call because that function answers about a route's **parent**
 * while this one answers about the address itself.
 */
function originLabel(origin: string): string {
  const parts = origin.split("/").filter((part) => part.length > 0);
  if (parts[0] !== "settings") return "New session";
  return settingsPaneTitle(parseSettingsRoute(parts.slice(1), decodeURIComponent)) ?? "Settings";
}

/**
 * `/agent/:machineId`, `/agent/:machineId/:step`,
 * `/agent/:machineId/edit/:presetId`, and any of those with the folder on the
 * end.
 *
 * ⚠ **The step goes *before* the folder, and a folder can never be mistaken for
 * one.** A `cwd` is an absolute POSIX path from the daemon's own listing — it
 * always begins with `/`, which `encodeURIComponent` writes as `%2F` — so no
 * folder segment can ever decode to `llm` or `harness`. That is what lets both
 * be optional in one path without a placeholder segment standing in for the one
 * that is absent.
 *
 * ⚠ **Editing an assembled agent is a literal `edit` marker, and deliberately
 * not the shape of the id that follows it.** A preset's id is `ca_` and eight hex
 * characters, minted by `randomBytes(4)` inside the daemon's own `POST
 * /custom-agents` — so a client that recognised it by *shape* would be a second,
 * silent copy of the daemon's id generator, and the day that generator changes
 * width every address already written down stops naming an edit and starts
 * naming a folder. The marker joins the argument above rather than weakening it:
 * `edit` is not a step and is read at a position no step is read at, and it can
 * never be a folder, because a folder always arrives as `%2F…`.
 *
 * And what it does when it cannot be read is the direction `compatibility.md`'s
 * rule 2 asks for: an address this build cannot make sense of parses to
 * `preset: null`, which is the screen that assembles a *new* agent — the arm with
 * none of somebody else's work on it to overwrite. Every address written before
 * the marker existed lands there too, unchanged.
 *
 * Here rather than in `router.ts` for {@link newSessionPath}'s reason: `upFrom`
 * needs it, and `nav.ts` may not import a module that reads `window.location`.
 */
export function agentBuilderPath(
  machine: string,
  cwd?: string | null,
  step: AgentStep | null = null,
  preset: string | null = null,
  /**
   * A harness to open already pointed at — `…/from/:harness`, for a built-in agent
   * being edited, which means starting from it.
   *
   * ⚠ **The same slot as `edit`, and never both.** Two markers at one position is
   * what makes the pair unexpressible rather than merely unused, and it keeps every
   * rule this docblock already states — a marker is read where no step is read, and
   * it can never be a folder, because a folder always arrives as `%2F…`. `preset`
   * wins if a caller passes both, which no caller does; the parser cannot produce
   * the state at all.
   */
  harness: string | null = null,
): string {
  const forMachine = `/agent/${encodeURIComponent(machine)}`;
  const base =
    preset !== null
      ? `${forMachine}/edit/${encodeURIComponent(preset)}`
      : harness !== null
        ? `${forMachine}/from/${encodeURIComponent(harness)}`
        : forMachine;
  const stepped = step === null ? base : `${base}/${step}`;
  return cwd === undefined || cwd === null ? stepped : `${stepped}/${encodeURIComponent(cwd)}`;
}

/**
 * The builder, opened at a harness that has nothing stored — `…/from/:harness`.
 *
 * `agentEditPath`'s twin, and a second name for the same reason: this is opened at
 * the builder and never at a step, so every call site would otherwise be writing
 * two `null`s through the middle of a five-argument call.
 */
export function agentFromPath(machine: string, harness: string, cwd?: string | null): string {
  return agentBuilderPath(machine, cwd, null, null, harness);
}

/**
 * The same address with the preset named — `/agent/:machineId/edit/:presetId`.
 *
 * A second name rather than a fourth argument at every call site: an edit is
 * opened at the builder and never at a step, so every caller would be writing
 * `agentBuilderPath(m, cwd, null, id)` and passing `null` through the middle of
 * it. One encoding of the rule, two ways of asking for it — {@link upFrom} keeps
 * the four-argument form, because it is rebuilding an address it was handed and
 * is the one place a step and a preset are both in hand.
 */
export function agentEditPath(machine: string, preset: string, cwd?: string | null): string {
  return agentBuilderPath(machine, cwd, null, preset);
}

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
    /*
     * One level up is the New session sheet it was opened from, rebuilt from the
     * route's own segments.
     *
     * ⚠ **Not `under`, and that is the whole reason this arm exists.** `under`
     * carries forward what the *first* pop-up was drawn over, so it would close
     * the whole stack and lose the folder — the same trap `marketUpFrom` needed
     * `origin` for. Here the address holds every half — the machine, the folder
     * and, since editing became an address, the preset — so nothing extra has to
     * be recorded in `history.state`.
     */
    case "agent":
      /*
       * ⚠ **`origin` at the shallowest depth, which is the market's shape and
       * arrived for the same reason.** The note above still holds for the way in
       * from New session: the address carries the machine, the folder and the
       * preset, so `newSessionPath` rebuilds it with nothing recorded. What it
       * cannot rebuild is a *different* pop-up — the machine's Agents screen opens
       * this one too, and walking back to New session from there drops somebody
       * out of settings onto a screen they never asked for. `originFor` records
       * only a crossing, so the New-session case still answers the address this
       * arm would have built anyway.
       */
      return route.step === null
        ? (origin ?? newSessionPath(route.machineId, route.cwd ?? undefined))
        : // ⚠ The preset travels back with it, for the reason the folder does:
          // dropped here, the ◀ out of a picker would land on the *new agent*
          // screen and the agent being edited would be gone from the address —
          // the same loss the `cwd` segment exists to prevent one field over. The
          // harness seed rides along for the identical reason, one marker over.
          agentBuilderPath(route.machineId, route.cwd, null, route.preset, route.harness);
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
