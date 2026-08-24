import { machineId, type MachineId } from "./ids";
import { isAgentId, type AgentId, type Me } from "./wire";

/**
 * Which settings screen a URL names, and who may see it.
 *
 * Here rather than in `router.ts` beside `newPath` and `sessionPath`, for a
 * mechanical reason worth stating: `router.ts` reads `window.location.pathname`
 * and installs a `popstate` listener in its module body, and `webcheck` stubs
 * `location.href` and nothing else — so importing it throws before a single case
 * runs. Same rule `groups.ts` and `keys.ts` state: a decision `webcheck` cannot
 * reach is a decision nothing asserts.
 */

export type SettingsSection = "machines" | "account" | "server" | "users";

/**
 * The band a section belongs to, or `null` for the first.
 *
 * One group today, and a *union* rather than a boolean so a second one needs no
 * change of shape. `null` for the first band rather than an invented "You"
 * heading, which is `Dropdown`'s existing grouped-list idiom — a heading above
 * the first item that carries one, and none for items without. Adopting it means
 * this nav grows no second idiom.
 */
export type SettingsGroup = "server";

/**
 * A settings URL, in full.
 *
 * Three depths rather than one segment, because agent settings moved *inside* a
 * machine. They were a top-level section that opened with a machine dropdown —
 * which is a screen asking a question its own copy answers, since credentials
 * live in one daemon's database and one host's home. The machine is in the path
 * now, for the reason it is in `/new/:machineId`: a component-state picker
 * forgets itself on back-and-forward, and there is nothing for a fixed close
 * control to close *to*.
 *
 * `machineId` and `agent` are only ever set under `section: "machines"`, and
 * that is enforced by {@link parseSettingsRoute} rather than by the type. A
 * discriminated union would express it, and would make every consumer that only
 * wants the section narrow first — for a rule with exactly one producer.
 */
export interface SettingsRoute {
  section: SettingsSection | null;
  /** The machine whose agents or plugins are being configured, if the URL names one. */
  machineId: MachineId | null;
  /**
   * The agent being configured, if the URL names one. Never without a machine.
   *
   * ⚠ **There is no `plugin` beside it any more, and its absence is the
   * decision.** A plugin used to have a leaf here — `…/plugins/:pluginId` — which
   * is where its settings were drawn, four taps into a sheet, behind a kebab, on
   * one machine at a time. Nobody found it. A plugin's settings now live on the
   * plugin's own page under `/plugins`, which is the one screen in this app that
   * is *about* a plugin and spans the machines it is on; this sheet keeps what is
   * genuinely per-machine — what is installed, whether it is switched on, and
   * taking it off — and links out for the rest.
   *
   * `…/plugins/:pluginId` still **parses**, to the machine holding the list, for
   * the same reason `…/agents` does: an address that used to work should land on
   * the nearest real screen rather than on nothing.
   */
  agent: AgentId | null;
}

export interface SectionSpec {
  id: SettingsSection;
  title: string;
  blurb: string;
  adminOnly: boolean;
  group: SettingsGroup | null;
}

/**
 * The sections, in the order they are drawn.
 *
 * Settings was one flat scroll with two headings and no navigation, which is what
 * made "change my password" and "sign an agent in" the same screen. Four now —
 * the fourth, Server settings, arrived with SMTP and is the only admin-only one
 * besides Users — and the split is by *what you came here to do* rather than by
 * which service answers.
 */
export const SECTION_SPECS: readonly SectionSpec[] = [
  {
    id: "machines",
    // The Agents section used to sit above this one and open with a machine
    // picker. It is gone: an agent is signed in *on a machine*, so it is reached
    // from that machine's row rather than from a list that has to ask which one.
    title: "Machines",
    // Not "Add a machine, …": adding one is not always on offer, and a nav blurb
    // promising it on an instance that hands out none is the same false claim
    // the intro on that screen had to stop making.
    blurb: "Your machines, their agents, and which are reachable.",
    adminOnly: false,
    group: null,
  },
  {
    id: "account",
    title: "Account",
    // Sign out is on that screen and is not what anybody came for, and this
    // string truncates in the nav — so it names the four things you go looking
    // for. Email and keys are new there and are the reason it changed.
    blurb: "Your password, your email, your keys and your devices.",
    adminOnly: false,
    group: null,
  },
  {
    id: "server",
    title: "Server settings",
    blurb: "Registration, email, and how people get accounts.",
    adminOnly: true,
    group: "server",
  },
  {
    id: "users",
    title: "Users",
    // "reset passwords" is gone with the route: an admin can take a credential
    // away and can never issue one.
    blurb: "Create people, disable accounts, see their keys.",
    adminOnly: true,
    group: "server",
  },
];

export const GROUP_TITLES: Record<SettingsGroup, string> = { server: "Server" };

/**
 * The section a path segment names, or `null` for the index.
 *
 * An unknown segment is the index rather than a 404: a stale bookmark or a
 * renamed section should land somewhere real. Matched exactly, so the case a URL
 * happens to arrive in never decides what is rendered.
 *
 * `/settings/agents` is now such a bookmark — the section was deleted — and it
 * lands on the index, which is one tap from Machines. Deliberately not
 * redirected to Machines: a redirect would have to guess which machine, and the
 * index is the screen that lists the way there.
 */
export function parseSettingsSection(segment: string | undefined): SettingsSection | null {
  if (segment === undefined) return null;
  const found = SECTION_SPECS.find((spec) => spec.id === segment);
  return found === undefined ? null : found.id;
}

/**
 * The whole settings URL, from the path segments after `/settings`.
 *
 * Every rule about the deeper forms is here, so `router.ts` stays four lines and
 * `webcheck` can assert all of it with no DOM.
 *
 * Three refusals, each falling *up* to the nearest real screen rather than to a
 * 404, which is `parseSettingsSection`'s posture applied one level down:
 *
 *   - a machine id under any section but `machines` is ignored;
 *   - `…/agents/<not an agent>` drops the agent and shows the chooser, because
 *     an unknown id is a stale link and the chooser is where you pick again;
 *   - anything between the machine and `agents` that is not the literal
 *     `agents` drops to the machine's own screen.
 *
 * The agent id is validated against `AGENT_IDS`, not merely decoded, because it
 * is handed straight to `PUT /agent-auth/:agent` — the daemon refuses an unknown
 * one, so an unvalidated id would draw a screen whose every control 400s.
 */
export function parseSettingsRoute(
  segments: readonly (string | undefined)[],
  decode: (part: string) => string = (part) => part,
): SettingsRoute {
  const section = parseSettingsSection(segments[0]);
  if (section !== "machines" || segments[1] === undefined) {
    return { section, machineId: null, agent: null };
  }
  const machine = machineId(decode(segments[1]));
  /*
   * ⚠ **`…/plugins` and `…/plugins/:pluginId` both fall to the machine**, which
   * is the "fall up to the nearest real screen" posture this function already
   * had, applied to a leaf that has been taken away. The plugin list is drawn on
   * the machine's own screen, so `…/plugins` was always the machine; the id below
   * it used to open that plugin's settings and now opens nothing here, because
   * those live on the plugin's page under `/plugins`.
   *
   * Landing on the machine rather than redirecting to the new address: this
   * function is pure and a redirect is a navigation, and the machine's screen is
   * one tap from the plugin anyway — every row on it is a link to exactly that
   * page.
   */
  if (segments[2] !== "agents" || segments[3] === undefined) {
    return { section, machineId: machine, agent: null };
  }
  const wanted = decode(segments[3]);
  return { section, machineId: machine, agent: isAgentId(wanted) ? wanted : null };
}

/**
 * The path for a settings screen.
 *
 * Positional and widening rather than an options object, so the three call
 * shapes read as what they are: the index, a section, a machine's agents, one
 * agent. An `agent` with no `machine` is not expressible — you cannot skip a
 * positional — which is the same rule `parseSettingsRoute` enforces on the way
 * in, expressed by the signature instead of by a check.
 */
export function settingsPath(
  section?: SettingsSection,
  machine?: MachineId,
  agent?: AgentId,
): string {
  if (section === undefined) return "/settings";
  if (machine === undefined) return `/settings/${section}`;
  /*
   * **The `/agents` segment belongs to the agent, not to the machine.** It used to
   * ride the base, so this function could not express a machine's own screen at
   * all — while `parseSettingsRoute` had always accepted that path and answered
   * exactly what `…/agents` answers. The address existed and nothing could emit
   * it; this one line is what opens the machine screen. Q3.432.
   */
  const base = `/settings/${section}/${encodeURIComponent(machine)}`;
  return agent === undefined ? base : `${base}/agents/${encodeURIComponent(agent)}`;
}

/**
 * One level up from a settings screen, or `null` at the index.
 *
 * This is `Settings.tsx`'s `closeTo` expression, lifted out of the component —
 * for the reason this file's own header gives: a decision `webcheck` cannot reach
 * is a decision nothing asserts, and this one decides where a control on screen
 * takes you.
 *
 * **`withinNav` is the second answer, and it is what stops a redundant control.**
 * Inside the settings sheet, the section list is drawn beside the section at `sm`
 * and above — so at `/settings/account` the parent is already a row you can see
 * and tap, and an extra ◀ pointing at it is one more thing on a 56px header
 * saying what the list beside it already says. It is `true` exactly when the
 * parent is a row the nav draws, which is the same shape of answer `Header`'s
 * `close` prop encodes as `lg:hidden`.
 *
 * The agent depths are `false`: `…/agents` and `…/agents/:agent` are *inside*
 * Machines, and the nav has no row for either, so the chevron is the only way back
 * at every width.
 *
 * Never `history.back()`. This is a destination derived from the URL, which is
 * what makes it stable — see `useUnder` in `router.ts` for the other half of that
 * argument, and `Header.tsx` for where it was first made.
 */
export function settingsUp(route: SettingsRoute): { path: string; withinNav: boolean } | null {
  if (route.section === null) return null;
  if (route.section === "machines" && route.machineId !== null) {
    // One agent goes up to its machine — the list is drawn on that screen, so
    // there is no list depth in between. `false` because it is not a row the nav
    // draws, which makes the chevron the only way back at every width.
    if (route.agent !== null) {
      return { path: settingsPath("machines", route.machineId), withinNav: false };
    }
    return { path: settingsPath("machines"), withinNav: false };
  }
  return { path: settingsPath(), withinNav: true };
}

/**
 * The name of the screen the *pane* is showing, or `null` at the index.
 *
 * **The other half of {@link settingsUp}, and here for the same reason.** A
 * sheet's head is a child of its panel, so at `sm` and above it spans the 224px
 * section rail *as well as* the pane beside it — and the only string true of
 * everything under it is the pop-up's own name. Measured at 1280px: the head's
 * text box starts 40px in, so `mac · agents` was drawn across a rail whose rows
 * read Machines / Account / Server settings / Users. The screen's name belongs to
 * the box that is the screen.
 *
 * Non-null exactly when `settingsUp` is, which `webcheck` asserts as a pairing
 * over every reachable shape rather than over the six literals — so a seventh
 * depth cannot arrive with a chevron over an unnamed screen, or a name with no
 * way back. *Where* it is drawn is `withinNav`'s job and stays a class string in
 * the caller, because that is the half no pure function can see.
 *
 * **Both agent depths answer with the machine, on purpose.** The agent is named
 * one rank below by `AgentDetail`, which has its display name; the head used to
 * draw the raw URL segment, so `claude` sat in `text-lg font-semibold` directly
 * above a row reading `Claude (claude-agent-acp)`. Q3.427.
 */
export function settingsPaneTitle(route: SettingsRoute): string | null {
  if (route.section === null) return null;
  if (route.section === "machines" && route.machineId !== null) {
    /*
     * **Titled by what the screen is, not by which machine it is about.**
     *
     * It drew the machine's name, which put the same word in three places within
     * one scroll — the heading, the rename field beneath it, and the Retire
     * button — and made the chrome restate the body. The name is on the screen
     * where it is editable and where it is destroyed; the heading says what kind
     * of screen this is. Q3.433.
     *
     * It is therefore a constant, and that is why this function no longer takes a
     * machine name at all: nothing in the pop-up's chrome is a function of which
     * machine you opened.
     */
    return "Machine settings";
  }
  return SECTION_SPECS.find((spec) => spec.id === route.section)?.title ?? null;
}

/**
 * The sections this person may see.
 *
 * **This is not the guard.** `requireAdmin` on the control plane is, on every
 * route the Users section calls. This is what stops the app *offering* a screen
 * whose every request would answer 403 — a different job, and one the server
 * cannot do. Said out loud because "the client hides it" is the sentence that
 * precedes somebody deleting the server check as redundant.
 *
 * `me` is `null` in a state this app really reaches: `bootstrap`'s catch keeps
 * `phase: "ready"` when the control plane is unreachable but machines are already
 * known, and never sets `me`. So this fails closed rather than optimistically.
 */
/**
 * What the pane's chevron says it goes to, or `null` at the index.
 *
 * **Derived from the parent's own name rather than from a second table**, which is
 * what makes it undriftable: a label naming a screen the path does not resolve to
 * is not expressible. It satisfies the rule `Header` already states — the label
 * has to name the fixed destination, because that is the whole difference between
 * this control and the history button it must never become. `Sheet`'s old bare
 * `label="Back"` was in violation of it, and a bare "Back" sitting immediately
 * before a heading naming a *different* screen would have been worse than neutral.
 *
 * A sibling function rather than a field on {@link settingsUp}'s return, so the
 * six pinned answers that assert where a chevron goes stay pinned. Q3.432.
 */
export function settingsUpLabel(route: SettingsRoute): string | null {
  const parent = settingsUp(route);
  if (parent === null) return null;
  const parts = parent.path.split("/").filter((part) => part.length > 0);
  /*
   * Every segment here came out of `settingsPath`, so it is `encodeURIComponent`
   * output and this cannot throw the `URIError` `router.ts` wraps its decoder
   * against. `[]` is the index, whose name is not a section's.
   */
  return (
    settingsPaneTitle(parseSettingsRoute(parts.slice(1), decodeURIComponent)) ?? "Settings"
  );
}

export function visibleSections(me: Me | null): readonly SectionSpec[] {
  return SECTION_SPECS.filter((spec) => !spec.adminOnly || me?.isAdmin === true);
}

/** Whether a typed URL may render this section. Separate from the list: a URL is not a tap. */
export function sectionAllowed(section: SettingsSection, me: Me | null): boolean {
  return visibleSections(me).some((spec) => spec.id === section);
}

/**
 * The rows to draw, each carrying the heading that precedes it — or `null`.
 *
 * **A function rather than a `group` field the JSX reads, because the bug it
 * prevents is invisible to the people who could report it.** A heading computed
 * from the static table renders "Server" above *nothing* for a non-admin, whose
 * visible list has no rows in that group at all. Only an admin ever sees that
 * nav in a correct state, so nobody who could notice is looking.
 *
 * Pairing the heading to the row it precedes also keeps `SettingsNav` free of
 * `previous`-row bookkeeping in JSX, which is the other way this goes wrong.
 *
 * The property worth asserting is not the two rows: it is that a heading appears
 * **at most once per group, and only on the first visible row of that group**,
 * for every `me`.
 */
export function navRows(me: Me | null): readonly { spec: SectionSpec; heading: SettingsGroup | null }[] {
  const seen = new Set<SettingsGroup>();
  return visibleSections(me).map((spec) => {
    if (spec.group === null || seen.has(spec.group)) return { spec, heading: null };
    seen.add(spec.group);
    return { spec, heading: spec.group };
  });
}
