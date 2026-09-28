import type { Route } from "./router";
import { isOverlayPath } from "./ui/overlay";
import { marketUpFrom } from "./market";
import { parseSettingsRoute, settingsPaneTitle, settingsUp } from "./settings";

// Pure navigation rules: router.ts reads window.location at import, so it cannot be loaded offline.

export type NavMove =
  | "push"
  | "pop"
  | "section-push"
  | "section-pop"
  | "sheet-close"
  | "sheet-swap";

/** How deep a screen sits; pop-ups are a second stack, and depths from the two stacks are never compared. */
export function depthOf(route: Route): number {
  switch (route.name) {
    case "home":
    case "gate":
      return 0;
    case "session":
      return 1;
    case "legal":
      return 1;
    case "plugin":
      return 1;
    case "new":
      return 1;
    case "agent":
      return route.step === null ? 2 : 3;
    case "settings":
      if (route.agents) return typeof route.signin === "string" ? 5 : 4;
      if (route.system !== null) return 4;
      if (route.signin !== null) return 4;
      if (route.machineId !== null) return 3;
      return route.section !== null ? 2 : 1;
    case "plugins":
      if (route.settings.length > 0) return 3;
      return route.entry !== null ? 2 : 1;
  }
}

/** Which pop-up a route belongs to, or null for a screen; new and agent are one pop-up. */
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
    case "legal":
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

/** Null where motion would be wrong: equal depth, and opening a sheet, which CSS animates on mount. */
export function navMove(from: Route, to: Route): NavMove | null {
  const leaving = isSheet(from);
  const arriving = isSheet(to);

  if (leaving && !arriving) return "sheet-close";
  if (!leaving && arriving) return null;

  // Two different pop-ups swap before depths are compared: a depth means nothing across two stacks.
  if (leaving && arriving && sheetKind(from) !== sheetKind(to)) return "sheet-swap";

  const here = depthOf(from);
  const there = depthOf(to);
  if (here === there) return null;
  if (leaving && arriving) return there > here ? "section-push" : "section-pop";
  return there > here ? "push" : "pop";
}

export function newSessionPath(machine?: string, cwd?: string): string {
  if (machine === undefined) return "/new";
  const base = `/new/${encodeURIComponent(machine)}`;
  return cwd === undefined ? base : `${base}/${encodeURIComponent(cwd)}`;
}

/** The segment is an address kept for old links; sheetTitle carries the readable name. */
export type AgentStep = "llm" | "harness";

const AGENT_STEPS: readonly AgentStep[] = ["llm", "harness"];

export function isAgentStep(value: string): value is AgentStep {
  return (AGENT_STEPS as readonly string[]).includes(value);
}

/** Rail pop-ups name themselves, single-column ones name the screen; null only for a plugin view (Q3.427, Q3.432, Q3.473, Q3.484). */
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
          return "Choose model";
        case "harness":
          return "Choose harness";
        case null:
          return route.preset === null ? "Configure agent" : "Edit agent";
      }
    // eslint-disable-next-line no-fallthrough
    case "home":
    case "gate":
    case "session":
    case "legal":
      return null;
  }
}

export function sheetUpLabel(route: Route, origin: string | null = null): string | null {
  if (route.name !== "agent") return null;
  if (route.step === null) return origin === null ? "New session" : originLabel(origin);
  return route.preset === null ? "Configure agent" : "Edit agent";
}

function originLabel(origin: string): string {
  const parts = origin.split("/").filter((part) => part.length > 0);
  if (parts[0] !== "settings") return "New session";
  return settingsPaneTitle(parseSettingsRoute(parts.slice(1), decodeURIComponent)) ?? "Settings";
}

/** The step precedes the folder; a folder always arrives as %2F, so it never decodes to a step or a marker. */
export function agentBuilderPath(
  machine: string,
  cwd?: string | null,
  step: AgentStep | null = null,
  preset: string | null = null,
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

export function agentFromPath(machine: string, harness: string, cwd?: string | null): string {
  return agentBuilderPath(machine, cwd, null, null, harness);
}

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
    case "legal":
      return "/";
    case "new":
    case "plugin":
      return under;
    // Not under, which would close the whole stack; origin wins only when another pop-up opened the builder.
    case "agent":
      return route.step === null
        ? (origin ?? newSessionPath(route.machineId, route.cwd ?? undefined))
        :
          agentBuilderPath(route.machineId, route.cwd, null, route.preset, route.harness);
    case "settings": {
      const parent = settingsUp(route);
      return parent === null ? under : parent.path;
    }
    case "plugins": {
      const parent = marketUpFrom(route, origin);
      return parent === null ? under : parent;
    }
  }
}

export function overlayKind(pathname: string): string {
  return pathname.split("/")[1] ?? "";
}

/** Set only when one overlay opens a different one; walking deeper inside one keeps held. */
export function originFor(here: string, target: string, held: string | null): string | null {
  if (!isOverlayPath(target)) return null;
  if (!isOverlayPath(here)) return null;
  return overlayKind(here) === overlayKind(target) ? held : here;
}
