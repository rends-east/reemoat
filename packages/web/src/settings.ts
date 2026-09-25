import { machineId, type MachineId } from "./ids";
import type { Me } from "./wire";

// Not in `router.ts`: webcheck cannot import that module, whose body touches `window`.

export type SettingsSection = "account" | "devices" | "keys" | "machines" | "logs" | "server" | "email" | "users";

export type SettingsGroup = "server";

/** Forms get their own address: nothing on a settings screen expands in place. */
export type SettingsLeaf = "password" | "email" | "new-key";

/** Machine-level fields are set only under `machines`; `parseSettingsRoute` enforces that, not the type. */
export interface SettingsRoute {
  section: SettingsSection | null;
  machineId: MachineId | null;
  system: string | null;
  /** The machine's agent strip; `signin` then names one harness's card under it (Q3.640). */
  agents: boolean;
  /** Under `…/signin/` only a harness no provider speaks for (Q3.540); under `…/agents/` any harness (Q3.640). */
  signin: string | null;
  /** `…/links`: which of your other machines this one's agents can message. */
  links: boolean;
  leaf: SettingsLeaf | null;
}

export interface SectionSpec {
  id: SettingsSection;
  title: string;
  blurb: string | null;
  adminOnly: boolean;
  group: SettingsGroup | null;
}

export const SECTION_SPECS: readonly SectionSpec[] = [
  {
    id: "account",
    title: "Account",
    blurb: null,
    adminOnly: false,
    group: null,
  },
  {
    id: "devices",
    title: "Devices",
    blurb: null,
    adminOnly: false,
    group: null,
  },
  {
    id: "keys",
    title: "API keys",
    blurb: null,
    adminOnly: false,
    group: null,
  },
  {
    id: "machines",
    title: "Machines",
    blurb: null,
    adminOnly: false,
    group: null,
  },
  {
    id: "logs",
    title: "Logs",
    blurb: null,
    adminOnly: false,
    group: null,
  },
  {
    id: "server",
    title: "Server",
    blurb: "Registration, limits, provisioning.",
    adminOnly: true,
    group: "server",
  },
  {
    id: "email",
    title: "Email",
    blurb: "SMTP and delivery.",
    adminOnly: true,
    group: "server",
  },
  {
    id: "users",
    title: "Users",
    blurb: "People and their access.",
    adminOnly: true,
    group: "server",
  },
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
  if (section === "account" || section === "keys") {
    const leaf = leafOf(section, segments[1]);
    return { section, machineId: null, system: null, signin: null, agents: false, links: false, leaf };
  }
  if (section !== "machines" || segments[1] === undefined) {
    return { section, machineId: null, system: null, signin: null, agents: false, links: false, leaf: null };
  }
  const machine = machineId(decode(segments[1]));
  if (segments[2] === "links") {
    return { section, machineId: machine, system: null, signin: null, agents: false, links: true, leaf: null };
  }
  if (segments[2] === "agents") {
    const named = segments[3] === undefined ? "" : decode(segments[3]);
    return {
      section,
      machineId: machine,
      system: null,
      signin: named.length > 0 && named.length <= MAX_HARNESS_ID_CHARS ? named : null,
      agents: true,
      links: false,
      leaf: null,
    };
  }
  if (segments[2] === "signin") {
    const named = segments[3] === undefined ? "" : decode(segments[3]);
    return {
      section,
      machineId: machine,
      system: null,
      signin: named.length > 0 && named.length <= MAX_HARNESS_ID_CHARS ? named : null,
      agents: false,
      links: false,
      leaf: null,
    };
  }
  if (segments[2] !== "systems" || segments[3] === undefined) {
    return { section, machineId: machine, system: null, signin: null, agents: false, links: false, leaf: null };
  }
  const wanted = decode(segments[3]);
  return {
    section,
    machineId: machine,
    system: wanted.length > 0 && wanted.length <= MAX_SYSTEM_ID_CHARS ? wanted : null,
    signin: null,
    agents: false,
    links: false,
    leaf: null,
  };
}

function leafOf(section: "account" | "keys", segment: string | undefined): SettingsLeaf | null {
  if (section === "account") {
    if (segment === "password") return "password";
    if (segment === "email") return "email";
    return null;
  }
  return segment === "new" ? "new-key" : null;
}

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

export function agentLinksPath(machine: MachineId): string {
  return `${settingsPath("machines", machine)}/links`;
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
  // `typeof`, not `!== null`: the drivers build partial routes by hand.
  if (typeof route.leaf === "string") {
    return { path: settingsPath(route.section), withinNav: false };
  }
  if (
    route.agents &&
    typeof route.signin !== "string" &&
    origin !== null &&
    origin.split("/").filter((part) => part.length > 0)[0] === "new"
  ) {
    return { path: origin, withinNav: false };
  }
  if (route.section === "machines" && route.machineId !== null) {
    if (route.agents && typeof route.signin === "string") {
      return { path: agentStripPath(route.machineId), withinNav: false };
    }
    if (route.system !== null || route.signin !== null || route.agents || route.links) {
      return { path: settingsPath("machines", route.machineId), withinNav: false };
    }
    return { path: settingsPath("machines"), withinNav: false };
  }
  return { path: settingsPath(), withinNav: true };
}

/** Non-null exactly when `settingsUp` is, and never equal to its parent's title: `settingsUpLabel` depends on that (Q3.427, Q3.433). */
export function settingsPaneTitle(route: SettingsRoute): string | null {
  if (route.section === null) return null;
  if (route.leaf === "password") return "Password";
  if (route.leaf === "email") return "Your email";
  if (route.leaf === "new-key") return "New key";
  if (route.section === "machines" && route.machineId !== null && route.agents) {
    return typeof route.signin === "string" ? "Setup" : "Agents";
  }
  if (route.section === "machines" && route.machineId !== null && route.links) return "Agent links";
  if (route.section === "machines" && route.machineId !== null && route.system !== null) {
    return "Sign-in";
  }
  if (route.section === "machines" && route.machineId !== null && route.signin !== null) {
    return "Sign-in";
  }
  if (route.section === "machines" && route.machineId !== null) {
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

export function visibleSections(me: Me | null): readonly SectionSpec[] {
  return SECTION_SPECS.filter((spec) => !spec.adminOnly || me?.isAdmin === true);
}

/** This only hides; the control plane's `requireAdmin` is the guard. */
export function sectionAllowed(section: SettingsSection, me: Me | null): boolean {
  return visibleSections(me).some((spec) => spec.id === section);
}

/** Leaves the address alone. Says "admins" because `visibleSections` filters on `adminOnly` alone. */
export function refusedSectionText(section: SettingsSection | null, me: Me | null): string | null {
  if (section === null || sectionAllowed(section, me)) return null;
  const title = SECTION_SPECS.find((spec) => spec.id === section)?.title ?? null;
  return title === null ? null : `${title} is for admins, and this account is not one.`;
}

export function navRows(me: Me | null): readonly { spec: SectionSpec; heading: SettingsGroup | null }[] {
  const seen = new Set<SettingsGroup>();
  return visibleSections(me).map((spec) => {
    if (spec.group === null || seen.has(spec.group)) return { spec, heading: null };
    seen.add(spec.group);
    return { spec, heading: spec.group };
  });
}
