import { machineId, type MachineId } from "./ids";
import type { Me } from "./wire";

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

export type SettingsSection = "account" | "keys" | "machines" | "server" | "email" | "users";

/**
 * The band a section belongs to, or `null` for the first.
 *
 * One group today, and a *union* rather than a boolean so a second one needs no
 * change of shape. Its id is `server` and its title is "Admin" — see
 * {@link GROUP_TITLES} for why they differ. `null` for the first band rather
 * than an invented "You" heading, which is `Dropdown`'s existing grouped-list idiom — a heading above
 * the first item that carries one, and none for items without. Adopting it means
 * this nav grows no second idiom.
 */
export type SettingsGroup = "server";

/**
 * A screen one tap under a section that is a *form*, not a list.
 *
 * ⚠ **Nothing on a settings screen expands in place, and this union is what
 * that rule costs.** Changing the password, changing the address and minting a
 * key were forms that opened *inside* their row — a button that added three
 * fields under itself and moved everything below it. On a phone that is the
 * screen jumping under a thumb, and the owner's review said so in plain words.
 * So each is its own address: the row carries the verb and the verb navigates,
 * which is the shape `…/machines/:id/systems/:system` already has one section
 * over. Never together with a machine, and only under `account` and `keys` —
 * {@link parseSettingsRoute} enforces both.
 */
export type SettingsLeaf = "password" | "email" | "new-key";

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
  /** The machine whose systems or plugins are being configured, if the URL names one. */
  machineId: MachineId | null;
  /**
   * The **system** being configured, if the URL names one. Never without a machine.
   *
   * ⚠ **It was `agent`, and the rename is the whole point rather than tidying.**
   * What this segment addresses is a screen you sign in on, and what you sign in
   * to is Anthropic, OpenAI or Moonshot — not `claude`, `codex` or `kimi`. The
   * two were indistinguishable while each harness spoke only to its own vendor;
   * they came apart the moment one could be pointed at another system, and a
   * screen still called "Agents" would be asking which CLI you have an account
   * with. `…/agents/:agent` still parses, to the machine, which is this
   * function's standing "fall up to the nearest real screen".
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
  system: string | null;
  /**
   * The machine's **agent strip** — which agents its New session screen offers,
   * and in what order. Never without a machine, never together with a system.
   *
   * ⚠ **A boolean, where its two siblings are ids, because there is nothing
   * under it.** A system is a leaf you pick one of from a list drawn on the
   * machine's screen; this is a single screen holding one list, so the only
   * thing the address has to say is whether you are on it.
   *
   * ⚠ **`…/agents` used to mean something else, and this is the reuse rather
   * than an addition.** It named *one agent's sign-in* — the screen that became
   * `…/systems/:system` when a harness and the account it signs in to came
   * apart — and since then it has parsed to the machine as "fall up to the
   * nearest real screen". It names the machine's agent *list* now, which is what
   * a person reading the address would guess, and a leftover fourth segment from
   * the old shape is dropped rather than redirected: the screen it lands on is
   * one tap from what that address used to open.
   */
  agents: boolean;
  /**
   * The **harness** whose credentials are being configured, if the URL names one.
   * Never without a machine, never together with a system.
   *
   * ⚠ **A second leaf under one list, and the asymmetry is deliberate.** The
   * Sign-ins list holds two kinds of row — a provider you have an account with,
   * and a harness that reads a key of its own — and they cannot share a segment,
   * because a plugin may name the same local id in both of its contribution
   * blocks. `…/systems/:system` therefore keeps its meaning and every address
   * that ever worked goes on working; this is where the second kind lives.
   *
   * ⚠ **Only a harness *no provider speaks for* is ever addressed here.** Every
   * built-in is named by a system's `loginVia` — Anthropic signs in through
   * claude, OpenRouter through opencode — and that system's own leaf is where its
   * card is drawn. Two leaves for one credential is the "two copies and two
   * answers to *signed in?*" this whole section was built to remove.
   */
  signin: string | null;
  /**
   * The form screen under `account` or `keys`, if the URL names one. See
   * {@link SettingsLeaf}. Never with a machine.
   */
  leaf: SettingsLeaf | null;
}

export interface SectionSpec {
  id: SettingsSection;
  title: string;
  /** The line under the title in the nav, or `null` for none — see {@link SECTION_SPECS}. */
  blurb: string | null;
  adminOnly: boolean;
  group: SettingsGroup | null;
}

/**
 * The sections, in the order they are drawn.
 *
 * Settings was one flat scroll with two headings and no navigation, which is what
 * made "change my password" and "sign an agent in" the same screen. Six now,
 * three of them admin-only — and the split is by *what you came here to do*
 * rather than by which service answers. The two newest are splits of the same
 * kind: API keys left Account because minting one for `cpctl` is not "my
 * account", and Email left Server because the SMTP form was nine fields on a
 * scroll that also held registration and the machine limit. Q3.219's "own keys"
 * list is that section now.
 *
 * **The three sections everybody sees carry no blurb; the admin three do.** The
 * owner's call (2026-09-04): "Account", "API keys" and "Machines" say what they
 * are, and a second line under each was the rail explaining the obvious. The
 * admin rows keep theirs because "Server" and "Email" are not self-describing —
 * one is registration and limits, the other is SMTP. Where a blurb exists it is
 * at most five words: the rail truncates past about 28 characters. Held in review
 * rather than by a driver (9B); which rows carry one is pinned.
 *
 * **Account leads, and it leads because it is the one the pane opens on.** There
 * is no neutral state at `sm` and above any more — the rail highlights
 * {@link DEFAULT_SECTION} and the pane draws it — so the first row and the default
 * are the same screen, and a rail whose highlighted row were not the first would
 * read as a selection somebody made. Machines was first while the pane opened on
 * nothing, where the order was only a reading order.
 */
export const SECTION_SPECS: readonly SectionSpec[] = [
  {
    id: "account",
    title: "Account",
    blurb: null,
    adminOnly: false,
    group: null,
  },
  {
    id: "keys",
    title: "API keys",
    // Its own section, which is the brief in one line: a key is minted for a
    // tool on another machine, and the screen it was on was about *you*.
    blurb: null,
    adminOnly: false,
    group: null,
  },
  {
    id: "machines",
    // The Agents section used to sit above this one and open with a machine
    // picker. It is gone: an agent is signed in *on a machine*, so it is reached
    // from that machine's row rather than from a list that has to ask which one.
    title: "Machines",
    blurb: null,
    adminOnly: false,
    group: null,
  },
  {
    id: "server",
    // "Server", under a group heading that is no longer the same word — see
    // `GROUP_TITLES`. "Server settings" restated the pop-up's own name.
    title: "Server",
    blurb: "Registration, limits, provisioning.",
    adminOnly: true,
    group: "server",
  },
  {
    id: "email",
    // Split out of Server: the SMTP form is the one admin screen somebody sets
    // up once from a phone, and it was nine fields down a scroll that also held
    // registration and the machine limit.
    title: "Email",
    blurb: "SMTP and delivery.",
    adminOnly: true,
    group: "server",
  },
  {
    id: "users",
    title: "Users",
    // "reset passwords" is gone with the route: an admin can take a credential
    // away and can never issue one.
    blurb: "People and their access.",
    adminOnly: true,
    group: "server",
  },
];

/**
 * The section the pane draws at `/settings`, where there is no neutral state.
 *
 * ⚠ **A constant that is *drawn*, never a section the URL is parsed into.** The
 * index is a real screen below `sm` — it is the section list, and tapping a row
 * drills into it — so {@link parseSettingsSection} still answers `null` for a bare
 * `/settings`, and {@link settingsUp} and {@link settingsPaneTitle} stay `null`
 * with it. What changed is only what the *pane* renders at that route, which is a
 * class string away in `Settings.tsx` and no business of this parser's. Answered
 * here rather than there so `webcheck` can reach it.
 *
 * ⚠ **It may never be an `adminOnly` section.** The desktop pane draws this with
 * nobody having tapped for it, so an admin-only default would open a non-admin on
 * a screen whose every request answers 403 — the exact failure
 * {@link visibleSections} exists to prevent, arriving by the one door that does not
 * go through it. Asserted over every identity, `null` included, which is a state
 * this app really reaches (`bootstrap`'s catch keeps `phase: "ready"` and never
 * sets `me`).
 *
 * A constant rather than `visibleSections(me)[0]?.id`: which section leads the rail
 * is a draw-order decision and which one the pane falls back to is a product one,
 * and deriving the second from the first means a future reorder silently moves the
 * default. The `??` that derivation would need also puts the literal back, behind a
 * fallback arm no driver can reach.
 */
export const DEFAULT_SECTION: SettingsSection = "account";

/**
 * What the band is called, above the first row in it.
 *
 * ⚠ **"Admin", never a word a row below it uses.** It was "Server", and the row
 * directly under it was "Server settings" — one word doing two jobs a finger's
 * width apart, so the heading read as a row and the row as a restatement. The
 * group is the *audience* (who may see these rows); the rows are the subjects.
 * The `SettingsGroup` id stays `server` so no route or pin moves with a label.
 * Decision 2A; `webcheck` pins the string.
 */
export const GROUP_TITLES: Record<SettingsGroup, string> = { server: "Admin" };

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
 *   - `…/systems/<not a system>` drops it and shows the chooser, because an
 *     unknown id is a stale link and the chooser is where you pick again;
 *   - anything between the machine and `systems` that is not the literal
 *     `systems` drops to the machine's own screen — `…/agents/:agent`, the
 *     address this replaced, is exactly that case and is deliberately **not**
 *     redirected, for the reason `/settings/agents` is not: a redirect would
 *     have to guess, and the screen it falls to is one tap from the answer.
 *
 * ⚠ **The system id is *not* validated against a list here, and that is a change
 * from the agent segment it replaces.** An agent was one of three compiled into
 * this client; systems are a table on the daemon, and a machine running a newer
 * build may know one this client does not. Validating would make that system
 * unreachable from a client that is merely older — `compatibility.md`'s rule 2,
 * where an unknown value degrades rather than throws. What refuses an id that is
 * genuinely wrong is the daemon, by name. It is still *bounded*: a segment longer
 * than any real id is dropped, so what reaches a request path cannot be an essay.
 */
export function parseSettingsRoute(
  segments: readonly (string | undefined)[],
  decode: (part: string) => string = (part) => part,
): SettingsRoute {
  const section = parseSettingsSection(segments[0]);
  /*
   * The three form screens, matched exactly: `account/password`, `account/email`
   * and `keys/new`. Anything else under those two sections falls *up* to the
   * section, which is this function's standing posture for a segment it does not
   * know — a stale link lands one tap from where it was going.
   */
  if (section === "account" || section === "keys") {
    const leaf = leafOf(section, segments[1]);
    return { section, machineId: null, system: null, signin: null, agents: false, leaf };
  }
  if (section !== "machines" || segments[1] === undefined) {
    return { section, machineId: null, system: null, signin: null, agents: false, leaf: null };
  }
  const machine = machineId(decode(segments[1]));
  /*
   * ⚠ **Before the `systems` arm, and it takes whatever follows it with it.**
   * `…/agents/claude` is the address the old one-agent screen had, and it now
   * lands on the machine's agent list — the nearest real screen, one tap from
   * what it used to open — rather than on the machine, which is where it landed
   * while `agents` named nothing. Dropping the tail rather than parsing it is the
   * same posture the rest of this function keeps: there is no leaf here, so a
   * segment claiming to be one is a stale link.
   */
  if (segments[2] === "agents") {
    return { section, machineId: machine, system: null, signin: null, agents: true, leaf: null };
  }
  /*
   * The harness leaf, beside `systems/:system` rather than inside it — see
   * `SettingsRoute.signin`. Bounded by the same number and dropped the same way: a
   * segment longer than any real id is a stale link, and this parser never decides
   * *which* ids exist.
   */
  if (segments[2] === "signin") {
    const named = segments[3] === undefined ? "" : decode(segments[3]);
    return {
      section,
      machineId: machine,
      system: null,
      signin: named.length > 0 && named.length <= MAX_SYSTEM_ID_CHARS ? named : null,
      agents: false,
      leaf: null,
    };
  }
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
  if (segments[2] !== "systems" || segments[3] === undefined) {
    return { section, machineId: machine, system: null, signin: null, agents: false, leaf: null };
  }
  const wanted = decode(segments[3]);
  return {
    section,
    machineId: machine,
    system: wanted.length > 0 && wanted.length <= MAX_SYSTEM_ID_CHARS ? wanted : null,
    signin: null,
    agents: false,
    leaf: null,
  };
}

/** Which leaf a segment under `account` or `keys` names, or `null` for the section. */
function leafOf(section: "account" | "keys", segment: string | undefined): SettingsLeaf | null {
  if (section === "account") {
    if (segment === "password") return "password";
    if (segment === "email") return "email";
    return null;
  }
  return segment === "new" ? "new-key" : null;
}

/**
 * The path for one of the three form screens. Positional like {@link settingsPath}:
 * the section is implied by the leaf, so a leaf under the wrong section is not
 * expressible.
 */
export function settingsLeafPath(leaf: SettingsLeaf): string {
  switch (leaf) {
    case "password":
      return `${settingsPath("account")}/password`;
    case "email":
      return `${settingsPath("account")}/email`;
    case "new-key":
      return `${settingsPath("keys")}/new`;
  }
}

/**
 * The longest a system id in a URL may be before the segment is ignored.
 *
 * Not a check on *which* systems exist — see `parseSettingsRoute` — but a bound
 * on what this client will carry into a request path at all. Real ids are one
 * short word.
 */
const MAX_SYSTEM_ID_CHARS = 64;

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
  system?: string,
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
  return system === undefined ? base : `${base}/systems/${encodeURIComponent(system)}`;
}

/**
 * The machine's agent strip.
 *
 * ⚠ **Its own function rather than a fourth positional on {@link settingsPath}.**
 * That signature is positional *and widening* — the three call shapes read as the
 * index, a section, a machine, one system, and "an agent with no machine is not
 * expressible" is a property of the signature rather than of a check. A trailing
 * boolean would break both halves: it is not a widening of `system`, and
 * `settingsPath("machines", m, undefined, true)` is exactly the skipped
 * positional that shape exists to make impossible.
 *
 * The machine is required, unlike everything in `settingsPath` after the section.
 * A strip belongs to one daemon's database, so there is no such screen without
 * one — the same rule that put the machine in the path in the first place.
 */
export function agentStripPath(machine: MachineId): string {
  return `${settingsPath("machines", machine)}/agents`;
}

/**
 * One harness's own sign-in, for a harness no provider speaks for.
 *
 * ⚠ **Its own function for `agentStripPath`'s reason** — `settingsPath`'s
 * signature is positional and widening, and this is not a widening of `system`:
 * the two are different id spaces that a plugin may populate with the same word.
 * Machine required, for the same reason a strip's is: a credential lives in one
 * daemon's database.
 */
export function harnessSigninPath(machine: MachineId, agent: string): string {
  return `${settingsPath("machines", machine)}/signin/${encodeURIComponent(agent)}`;
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
export function settingsUp(
  route: SettingsRoute,
  /**
   * The pop-up this one was opened from, when it was opened from a different one.
   *
   * ⚠ **Read at exactly one screen, and only when it is New session.** The strip's
   * gear is a *crossing* between two pop-ups, so the parent in the URL — the
   * machine — is not where anybody came from, and a ◀ walking there strands them
   * in settings with the sheet they were filling in gone. That was reported.
   *
   * It is deliberately not general. Applied at every depth it would break walking
   * *up* inside this sheet: `originFor` keeps an origin across a move within one
   * pop-up, so a settings sheet opened from New session would answer `/new` for
   * its sections and its machines too. And it is narrowed to the New session
   * pop-up rather than to "any origin" so that the label beside it can never be
   * wrong — {@link settingsUpLabel} has one name to give, and this is the one
   * screen that can produce it. Any other crossing falls back to the URL, which is
   * what makes every other answer here derived rather than remembered.
   */
  origin: string | null = null,
): { path: string; withinNav: boolean } | null {
  if (route.section === null) return null;
  // A form screen goes up to its section. `false`: the nav draws the section's
  // row, not the form's, so the chevron is the only way back at every width.
  // `typeof`, not `!== null`: the drivers build partial routes by hand (cast
  // `as never`) and every other field here already tolerates that shape.
  if (typeof route.leaf === "string") {
    return { path: settingsPath(route.section), withinNav: false };
  }
  if (
    route.agents &&
    origin !== null &&
    origin.split("/").filter((part) => part.length > 0)[0] === "new"
  ) {
    return { path: origin, withinNav: false };
  }
  if (route.section === "machines" && route.machineId !== null) {
    // One system goes up to its machine — the list is drawn on that screen, so
    // there is no list depth in between. `false` because it is not a row the nav
    // draws, which makes the chevron the only way back at every width.
    //
    /*
     * The strip is the same shape and the same answer: it is reached from a row on
     * the machine's screen, and it walks back to that machine at every width.
     *
     * ⚠ **The gear on New session is a *crossing*, and nothing in this sheet
     * answers it — that is the standing rule rather than a gap.** This function is
     * derived from the URL, which is what makes its answer stable, and `Header.tsx`
     * argues at length against the alternative. So arriving here from the gear, the
     * ◀ walks to the machine and the phone's Back button is what returns to New
     * session — the same deal every crossing into this sheet has always had. The
     * builder is the one screen that reads `origin` for its ◀, because there the
     * label and the destination are one control naming where it goes.
     */
    /*
     * ⚠ **All three leaves under a machine, and `signin` was the one that got
     * missed.** It has a shape, a parse, a path builder and a title arm, and
     * `MachineSystemsSection` navigates to it — but it was absent here, so its ◀
     * walked past the machine it was opened from, to the machines *list*, under a
     * label reading "Back to Machines" beside a pane this file titles "Sign-in".
     * That is the exact defect the paragraph above records closing for `system`,
     * reintroduced one leaf over by an `if` that enumerates rather than derives.
     */
    if (route.system !== null || route.signin !== null || route.agents) {
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
 * **Every depth under a machine is titled by what its screen *is*, and no two of
 * them may share a string.** The second half was missing and it cost the chrome
 * both of its facts at once. A system had no arm here, so
 * `…/machines/:id/systems/anthropic` fell through to the machine's own "Machine
 * settings" — while {@link settingsUpLabel} answers with the *parent's* title,
 * which is also "Machine settings". The pane therefore drew "◀ Back to Machine
 * settings" immediately beside `<h2>Machine settings</h2>`: one string claiming
 * to be both where you are and where you are going, with the system you had
 * drilled into named nowhere in the chrome. Non-injective across a parent and its
 * child is the general form of that defect, and the system arm below is what
 * closes it.
 *
 * ⚠ **"System settings" rather than the system, and the URL segment is exactly
 * what it may not be.** `SystemInfo.displayName` is read off the daemon, per
 * machine; this function is pure and holds a route, so the only string within
 * reach is the id — lower case, because that is what an id is. Drawing it is the
 * defect Q3.427 reverted, verbatim: `claude` in `font-semibold` directly above a
 * row reading `Claude (claude-agent-acp)`, which is precisely what `SystemDetail`
 * draws one rank below as `title={system.displayName}`. Casing it here would be a
 * guess, and `openai` guesses to `Openai` above a card reading `OpenAI`. So the
 * chrome says which *kind* of screen this is and the body says which system —
 * the division the strip's "Agents" already keeps, and the one
 * `MachineSystemsSection` falls back on when the daemon cannot be read and there
 * is no card left to say it. Q3.427, Q3.433.
 */
export function settingsPaneTitle(route: SettingsRoute): string | null {
  if (route.section === null) return null;
  /*
   * The form screens, titled by what the screen *is* — and none may share a
   * string with its parent (the injectivity this docblock argues): "Email" is
   * the admin section's title, so the account's own address is "Your email".
   */
  if (route.leaf === "password") return "Password";
  if (route.leaf === "email") return "Your email";
  if (route.leaf === "new-key") return "New key";
  /*
   * **"Agents", and it is what the screen is rather than what it is about** — the
   * same rule the machine title below states at length. It is not the machine's
   * name and not "Agents on <machine>": the machine is named by the row you came
   * through and by the chevron pointing back at it, and a heading restating it
   * would be the chrome saying what the body already says.
   *
   * Above the machine arm, since a strip route carries a machine too.
   */
  if (route.section === "machines" && route.machineId !== null && route.agents) {
    return "Agents";
  }
  /*
   * **The system's own depth, and above the machine arm for the strip's reason:
   * a system route carries a machine too.** What it may never be is the segment
   * — see the ⚠ in this function's docblock, which also records what a title
   * shared with its own parent cost.
   */
  if (route.section === "machines" && route.machineId !== null && route.system !== null) {
    return "Sign-in";
  }
  // The other kind of row in the same list, and it says the same word: what the
  // reader opened is a sign-in either way, and the two leaves differ only in which
  // of the machine's two catalogues resolved the name.
  if (route.section === "machines" && route.machineId !== null && route.signin !== null) {
    return "Sign-in";
  }
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
 *
 * ⚠ **It is only as good as {@link settingsPaneTitle} being injective**, and it
 * was not: a system depth with no arm of its own answered "Machine settings",
 * which is its parent's answer too, so this drew "Back to Machine settings"
 * beside a heading reading "Machine settings". Nothing here can detect that —
 * the label is *correct*, it is the pair that is useless — which is why the rule
 * is stated and kept over there rather than guarded here.
 */
export function settingsUpLabel(route: SettingsRoute, origin: string | null = null): string | null {
  const parent = settingsUp(route, origin);
  if (parent === null) return null;
  /*
   * ⚠ **The one destination outside this sheet, named rather than parsed.** The
   * strip's ◀ walks back to New session when that is where it was opened from, and
   * everything below parses the parent as a *settings* address — which answers
   * `null` for `/new/...` and would draw a chevron labelled "Settings" pointing at
   * a screen that is not it. `settingsUp` only ever returns a `new` path, which is
   * what keeps this to one arm instead of a table.
   */
  if (parent.path.split("/").filter((part) => part.length > 0)[0] === "new") return "New session";
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
 * Why the pane is not the section the address bar names, or `null` when it is.
 *
 * ⚠ **The fallback was silent, and silence is what made it a defect rather than
 * a policy.** `Settings.tsx` collapses a section {@link sectionAllowed} refuses
 * to `null` — which at `sm` and above draws {@link DEFAULT_SECTION} and
 * highlights that same row in the rail, with the URL still reading
 * `/settings/users`. So an admin whose flag was taken away in another tab
 * reloads and lands on Account with nothing on screen saying why, and a
 * bookmarked address is a different screen depending on who is signed in. This
 * is the sentence that stops that being a guess.
 *
 * **The address is left alone rather than corrected, which is this sheet's
 * standing posture for one it cannot honour.** {@link parseSettingsSection}
 * lands an unknown segment on the index and {@link parseSettingsRoute} falls
 * *up* at three depths, neither redirecting, for the reason written there: a
 * redirect has to guess. Rewriting it here would also make the bookmark
 * unrecoverable — regain the flag, reload, and the address it was saved at is
 * already gone — and it would put a `navigate` inside a render, which is the one
 * place `router.ts` may not be called from.
 *
 * ⚠ **It names admins because {@link visibleSections} filters on nothing else.**
 * A refusal here is an `adminOnly` refusal by construction, so the word is
 * derived rather than assumed; a second criterion added to that filter owes this
 * function a second arm, or it will explain a refusal by naming the wrong one.
 *
 * ⚠ **It says nothing about what is drawn instead, because that is a
 * breakpoint.** The pane draws {@link DEFAULT_SECTION} at `sm` and above and the
 * section *list* below it, and `AppShell`'s standing rule is that no width is
 * answered in JavaScript — so a sentence ending "…so this is Account" would be
 * false on the phone it was read on.
 */
export function refusedSectionText(section: SettingsSection | null, me: Me | null): string | null {
  if (section === null || sectionAllowed(section, me)) return null;
  /*
   * `?.title ?? null` is {@link settingsPaneTitle}'s own idiom for this lookup,
   * and the `null` arm is `find`'s return type rather than a state anything
   * reaches: `section` is a member of the union {@link SECTION_SPECS} enumerates.
   */
  const title = SECTION_SPECS.find((spec) => spec.id === section)?.title ?? null;
  return title === null ? null : `${title} is for admins, and this account is not one.`;
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
