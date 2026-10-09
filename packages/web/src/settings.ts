import { machineId, type MachineId } from "./ids";
import type { Me } from "./wire";

// Not in `router.ts`: webcheck cannot import that module, whose body touches `window`.

export type SettingsSection =
  | "account"
  | "devices"
  | "keys"
  | "machines"
  | "logs"
  | "server"
  | "email"
  | "users";

export type SettingsGroup = "server";

/** Forms and one-time secrets get their own address: nothing on a settings screen expands in place. */
export type SettingsLeaf =
  | "password"
  | "email"
  | "new-key"
  | "machine-name"
  | "setup-code"
  | "plugin-install"
  | "domains"
  | "machine-limit"
  | "provisioning-key"
  | "smtp"
  | "test-mail"
  | "new-user"
  | "user-limit"
  | "routing-key";

/** The leaves that hang off one machine; `machineLeafPath` builds them. A system's leaf needs the system too: `routingKeyPath`. */
export type MachineLeaf = Extract<SettingsLeaf, "machine-name" | "setup-code" | "plugin-install">;

/** A machine's own lists, each a screen between the machine and the card it opens. */
export type SettingsList = "systems" | "plugins" | "devices";

/** Machine-level fields are set only under `machines`; `parseSettingsRoute` enforces that, not the type. */
export interface SettingsRoute {
  section: SettingsSection | null;
  machineId: MachineId | null;
  system: string | null;
  /** The machine's agent strip; `signin` then names one harness's card under it (Q3.640). */
  agents: boolean;
  /** Under `…/signin/` only a harness no provider speaks for (Q3.540); under `…/agents/` any harness (Q3.640). */
  signin: string | null;
  leaf: SettingsLeaf | null;
  /** Present only on a machine's list, so a route written out by hand needs no new key. */
  list?: SettingsList;
  /** Present only on a Users leaf about one person. */
  userId?: string;
}

export interface SectionSpec {
  id: SettingsSection;
  title: string;
  adminOnly: boolean;
  /** Listed only where this app can run a daemon; a browser or a phone has none to read. */
  hostOnly: boolean;
  group: SettingsGroup | null;
}

export const SECTION_SPECS: readonly SectionSpec[] = [
  { id: "account", title: "Account", adminOnly: false, hostOnly: false, group: null },
  { id: "devices", title: "Devices", adminOnly: false, hostOnly: false, group: null },
  { id: "keys", title: "API keys", adminOnly: false, hostOnly: false, group: null },
  { id: "machines", title: "Machines", adminOnly: false, hostOnly: false, group: null },
  { id: "logs", title: "Logs", adminOnly: false, hostOnly: true, group: null },
  { id: "server", title: "Server", adminOnly: true, hostOnly: false, group: "server" },
  { id: "email", title: "Email", adminOnly: true, hostOnly: false, group: "server" },
  { id: "users", title: "Users", adminOnly: true, hostOnly: false, group: "server" },
];

/** Drawn by the pane at a bare `/settings`, never parsed into. Must never be an `adminOnly` section. */
export const DEFAULT_SECTION: SettingsSection = "account";

/** Must not repeat any row's title; the group id stays `server` so no route moves with the label. */
export const GROUP_TITLES: Record<SettingsGroup, string> = { server: "Admin" };

export function parseSettingsSection(segment: string | undefined): SettingsSection | null {
  if (segment === undefined) return null;
  const found = SECTION_SPECS.find((spec) => spec.id === segment);
  return found === undefined ? null : found.id;
}

/** Unknown segments fall up to the nearest real screen, never redirected. System ids are length-bounded, not validated: a newer daemon may know more. */
export function parseSettingsRoute(
  segments: readonly (string | undefined)[],
  decode: (part: string) => string = (part) => part,
): SettingsRoute {
  const section = parseSettingsSection(segments[0]);
  const bare: SettingsRoute = { section, machineId: null, system: null, signin: null, agents: false, leaf: null };
  if (section === "users") {
    if (segments[1] === "new") return { ...bare, leaf: "new-user" };
    const user = segments[1] === undefined ? "" : decode(segments[1]);
    const named = user.length > 0 && user.length <= MAX_USER_ID_CHARS;
    return segments[2] === "limit" && named ? { ...bare, leaf: "user-limit", userId: user } : bare;
  }
  if (section !== "machines") return { ...bare, leaf: leafOf(section, segments[1]) };
  if (segments[1] === undefined) return bare;
  const at: SettingsRoute = { ...bare, machineId: machineId(decode(segments[1])) };
  const named = segments[3] === undefined ? "" : decode(segments[3]);
  switch (segments[2]) {
    case "agents":
      return { ...at, signin: named.length > 0 && named.length <= MAX_HARNESS_ID_CHARS ? named : null, agents: true };
    case "signin":
      return { ...at, signin: named.length > 0 && named.length <= MAX_HARNESS_ID_CHARS ? named : null };
    case "name":
      return { ...at, leaf: "machine-name" };
    case "setup-code":
      return { ...at, leaf: "setup-code" };
    case "devices":
      return { ...at, list: "devices" };
    // A plugin's own settings live under /plugins (Q3.459), so a stale `…/plugins/:id` falls to the machine's list.
    case "plugins":
      return segments[3] === "install" ? { ...at, leaf: "plugin-install" } : { ...at, list: "plugins" };
    case "systems":
      if (named.length === 0 || named.length > MAX_SYSTEM_ID_CHARS) return { ...at, list: "systems" };
      return segments[4] === "routing-key" ? { ...at, system: named, leaf: "routing-key" } : { ...at, system: named };
    default:
      return at;
  }
}

function leafOf(section: SettingsSection | null, segment: string | undefined): SettingsLeaf | null {
  switch (section) {
    case "account":
      return segment === "password" ? "password" : segment === "email" ? "email" : null;
    case "keys":
      return segment === "new" ? "new-key" : null;
    case "server":
      return segment === "domains" || segment === "machine-limit" || segment === "provisioning-key" ? segment : null;
    case "email":
      return segment === "smtp" ? "smtp" : segment === "test" ? "test-mail" : null;
    default:
      return null;
  }
}

/** The leaves a section holds directly; the machine, system and user ones need an id and have builders of their own. */
export type SectionLeaf = Exclude<SettingsLeaf, MachineLeaf | "user-limit" | "routing-key">;

export function settingsLeafPath(leaf: SectionLeaf): string {
  switch (leaf) {
    case "password":
      return `${settingsPath("account")}/password`;
    case "email":
      return `${settingsPath("account")}/email`;
    case "new-key":
      return `${settingsPath("keys")}/new`;
    case "domains":
    case "machine-limit":
    case "provisioning-key":
      return `${settingsPath("server")}/${leaf}`;
    case "smtp":
      return `${settingsPath("email")}/smtp`;
    case "test-mail":
      return `${settingsPath("email")}/test`;
    case "new-user":
      return `${settingsPath("users")}/new`;
  }
}

export function machineLeafPath(machine: MachineId, leaf: MachineLeaf): string {
  switch (leaf) {
    case "machine-name":
      return `${settingsPath("machines", machine)}/name`;
    case "setup-code":
      return `${settingsPath("machines", machine)}/setup-code`;
    case "plugin-install":
      return `${machineListPath(machine, "plugins")}/install`;
  }
}

/** Under the system's card, so the chevron and a finished form both walk back to it. */
export function routingKeyPath(machine: MachineId, system: string): string {
  return `${settingsPath("machines", machine, system)}/routing-key`;
}

export function machineListPath(machine: MachineId, list: SettingsList): string {
  return `${settingsPath("machines", machine)}/${list}`;
}

export function userLimitPath(user: string): string {
  return `${settingsPath("users")}/${encodeURIComponent(user)}/limit`;
}

/** Control-plane user ids are at most 64 characters (`accounts::is_user_id`). */
const MAX_USER_ID_CHARS = 64;

const MAX_SYSTEM_ID_CHARS = 64;

/** A plugin harness id `<pluginId>:<localId>` reaches 65 chars; matches the daemon's MAX_STRIP_REF_CHARS. */
const MAX_HARNESS_ID_CHARS = 96;

export function settingsPath(
  section?: SettingsSection,
  machine?: MachineId,
  system?: string,
): string {
  if (section === undefined) return "/settings";
  if (machine === undefined) return `/settings/${section}`;
  const base = `/settings/${section}/${encodeURIComponent(machine)}`;
  return system === undefined ? base : `${base}/systems/${encodeURIComponent(system)}`;
}

export function agentStripPath(machine: MachineId): string {
  return `${settingsPath("machines", machine)}/agents`;
}

/** Under `…/agents`, never beside it, so the chevron walks back to the list that opened it (Q3.640). */
export function agentSetupPath(machine: MachineId, agent: string): string {
  return `${agentStripPath(machine)}/${encodeURIComponent(agent)}`;
}

export function harnessSigninPath(machine: MachineId, agent: string): string {
  return `${settingsPath("machines", machine)}/signin/${encodeURIComponent(agent)}`;
}

/** `withinNav` is true when the parent is a row the nav already draws. Derived from the URL, never `history.back()`. */
export function settingsUp(
  route: SettingsRoute,
  origin: string | null = null,
): { path: string; withinNav: boolean } | null {
  if (route.section === null) return null;
  const machine = route.section === "machines" ? route.machineId : null;
  // `typeof`, not `!== null`: the drivers build partial routes by hand.
  if (typeof route.leaf === "string") {
    if (machine === null) return { path: settingsPath(route.section), withinNav: false };
    if (route.leaf === "routing-key" && typeof route.system === "string") {
      return { path: settingsPath("machines", machine, route.system), withinNav: false };
    }
    return route.leaf === "plugin-install"
      ? { path: machineListPath(machine, "plugins"), withinNav: false }
      : { path: settingsPath("machines", machine), withinNav: false };
  }
  if (
    route.agents &&
    typeof route.signin !== "string" &&
    origin !== null &&
    origin.split("/").filter((part) => part.length > 0)[0] === "new"
  ) {
    return { path: origin, withinNav: false };
  }
  if (machine !== null) {
    if (route.agents && typeof route.signin === "string") {
      return { path: agentStripPath(machine), withinNav: false };
    }
    // A system's card and a harness's sign-in hang off the Sign-ins list, one level up rather than two (Q3.415).
    if (route.system !== null || route.signin !== null) {
      return { path: machineListPath(machine, "systems"), withinNav: false };
    }
    if (route.agents || typeof route.list === "string") {
      return { path: settingsPath("machines", machine), withinNav: false };
    }
    return { path: settingsPath("machines"), withinNav: false };
  }
  return { path: settingsPath(), withinNav: true };
}

const LEAF_TITLES: Record<SettingsLeaf, string> = {
  password: "Password",
  email: "Your email",
  "new-key": "New key",
  "machine-name": "Name",
  "setup-code": "Setup code",
  "plugin-install": "Install a plugin",
  domains: "Allowed domains",
  "machine-limit": "Machine limit",
  "provisioning-key": "Provisioning key",
  smtp: "SMTP",
  "test-mail": "Send a test",
  "new-user": "Add a person",
  "user-limit": "Machine limit",
  "routing-key": "Routing key",
};

/** Non-null exactly when `settingsUp` is, and never equal to its parent's title: `settingsUpLabel` depends on that (Q3.427, Q3.433). */
export function settingsPaneTitle(route: SettingsRoute): string | null {
  if (route.section === null) return null;
  if (typeof route.leaf === "string") return LEAF_TITLES[route.leaf];
  if (route.section === "machines" && route.machineId !== null) {
    if (route.agents) return typeof route.signin === "string" ? "Setup" : "Agents";
    if (route.system !== null || route.signin !== null) return "Sign-in";
    if (route.list === "systems") return "Sign-ins";
    if (route.list === "plugins") return "Plugins";
    // Not "Devices": that is the account's own screen, one level up, and the two list different things.
    if (route.list === "devices") return "Device access";
    return "Machine settings";
  }
  return SECTION_SPECS.find((spec) => spec.id === route.section)?.title ?? null;
}

export function settingsUpLabel(route: SettingsRoute, origin: string | null = null): string | null {
  const parent = settingsUp(route, origin);
  if (parent === null) return null;
  if (parent.path.split("/").filter((part) => part.length > 0)[0] === "new") return "New session";
  const parts = parent.path.split("/").filter((part) => part.length > 0);
  return (
    settingsPaneTitle(parseSettingsRoute(parts.slice(1), decodeURIComponent)) ?? "Settings"
  );
}

/** `canHostDaemon` is the shell's (`state.host`); absent, as in a browser, it is false. */
export function visibleSections(me: Me | null, canHostDaemon = false): readonly SectionSpec[] {
  return SECTION_SPECS.filter(
    (spec) => (!spec.adminOnly || me?.isAdmin === true) && (!spec.hostOnly || canHostDaemon),
  );
}

/** This only hides; the control plane's `requireAdmin` is the guard. */
export function sectionAllowed(section: SettingsSection, me: Me | null, canHostDaemon = false): boolean {
  return visibleSections(me, canHostDaemon).some((spec) => spec.id === section);
}

/** Leaves the address alone, and speaks only for an admin section: a hidden Logs falls to the index without a sentence. */
export function refusedSectionText(section: SettingsSection | null, me: Me | null): string | null {
  const spec = SECTION_SPECS.find((one) => one.id === section);
  // An account not read yet has not been found wanting.
  if (spec === undefined || !spec.adminOnly || me === null || me.isAdmin === true) return null;
  return `${spec.title} is for admins, and this account is not one.`;
}

export function navRows(
  me: Me | null,
  canHostDaemon = false,
): readonly { spec: SectionSpec; heading: SettingsGroup | null }[] {
  const seen = new Set<SettingsGroup>();
  return visibleSections(me, canHostDaemon).map((spec) => {
    if (spec.group === null || seen.has(spec.group)) return { spec, heading: null };
    seen.add(spec.group);
    return { spec, heading: spec.group };
  });
}
