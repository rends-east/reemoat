import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { parseGateScreen, type GateScreen } from "./gate";
import { parseLegalDoc, type LegalDoc } from "./legal";
import { parseMarketRoute, type MarketRoute } from "./market";
import { machineId, sessionId, type MachineId, type SessionRef } from "./ids";
import { parseSettingsRoute, type SettingsRoute } from "./settings";
import { isOverlayPath } from "./ui/overlay";
import {
  agentBuilderPath,
  agentEditPath as editPath,
  agentFromPath as fromPath,
  isAgentStep,
  navMove,
  newSessionPath,
  originFor,
  type AgentStep,
} from "./nav";

// The session path is parsed only here, straight into a branded SessionRef, so a bare session id never escapes the URL.

export type Route =
  | { name: "home" }
  | { name: "session"; ref: SessionRef }
  | { name: "new"; machineId: MachineId | null; cwd: string | null }
  | {
      name: "agent";
      machineId: MachineId;
      cwd: string | null;
      step: AgentStep | null;
      preset: string | null;
      harness: string | null;
    }
  /** The section rides the URL so the close has a list to return to and a phone reload keeps it, as AgentCard's reattach key does. */
  | ({ name: "settings" } & SettingsRoute)
  | { name: "plugin"; machineId: MachineId; pluginId: string }
  | ({ name: "plugins" } & MarketRoute)
  /** The token rides the URL fragment, which never reaches the server; rules live in gate.ts. */
  | { name: "gate"; screen: GateScreen }
  /** Not a GateScreen: a policy is read both before and after sign-in (Q3.598). */
  | { name: "legal"; doc: LegalDoc };

/** Keeps an undecodable segment as written: parse runs at module load, so a throw here blanks the page. */
function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function parsePath(pathname: string): Route {
  return parse(pathname);
}

function parse(pathname: string): Route {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  if (parts[0] === "new") {
    return {
      name: "new",
      machineId: parts[1] === undefined ? null : machineId(decodeSegment(parts[1])),
      cwd: parts[2] === undefined ? null : decodeSegment(parts[2]),
    };
  }
  if (parts[0] === "agent" && parts[1] !== undefined) {
    const marker = parts[2] === "edit" || parts[2] === "from" ? parts[2] : null;
    const named = marker !== null && parts[3] !== undefined ? decodeSegment(parts[3]) : null;
    const tail = parts.slice(marker === null ? 2 : 4);
    const stepped = tail[0] !== undefined && isAgentStep(tail[0]);
    const folder = stepped ? tail[1] : tail[0];
    return {
      name: "agent",
      machineId: machineId(decodeSegment(parts[1])),
      cwd: folder === undefined ? null : decodeSegment(folder),
      step: stepped ? (tail[0] as AgentStep) : null,
      preset: marker === "edit" ? named : null,
      harness: marker === "from" ? named : null,
    };
  }
  const gate = parseGateScreen(parts);
  if (gate !== null) return { name: "gate", screen: gate };
  // After the gate, and asserted disjoint: a legal document must never shadow a gate screen.
  const legal = parseLegalDoc(parts);
  if (legal !== null) return { name: "legal", doc: legal };
  if (parts[0] === "settings") {
    return { name: "settings", ...parseSettingsRoute(parts.slice(1), decodeSegment) };
  }
  if (parts[0] === "plugins") {
    return { name: "plugins", ...parseMarketRoute(parts.slice(1), decodeSegment) };
  }
  if (parts[0] === "p" && parts[1] !== undefined && parts[2] !== undefined) {
    return {
      name: "plugin",
      machineId: machineId(decodeSegment(parts[1])),
      pluginId: decodeSegment(parts[2]),
    };
  }
  if (parts[0] === "m" && parts[1] !== undefined && parts[2] === "s" && parts[3] !== undefined) {
    return {
      name: "session",
      ref: {
        machineId: machineId(decodeSegment(parts[1])),
        sessionId: sessionId(decodeSegment(parts[3])),
      },
    };
  }
  return { name: "home" };
}

/** under lives in history.state because it must be per entry to survive Back, Forward and a reload. */
interface Location {
  route: Route;
  under: string;
  origin: string | null;
}

const listeners = new Set<() => void>();

function readUnder(): string {
  const state = window.history.state as { under?: unknown } | null;
  return typeof state?.under === "string" && state.under.length > 0 ? state.under : "/";
}

function readOrigin(): string | null {
  const state = window.history.state as { origin?: unknown } | null;
  return typeof state?.origin === "string" && state.origin.length > 0 ? state.origin : null;
}

function read(): Location {
  return { route: parse(window.location.pathname), under: readUnder(), origin: readOrigin() };
}

let current: Location = read();

function tell(): void {
  for (const listener of listeners) listener();
}

let navToken = 0;

/**
 * View transition keyed on data-nav, skipped when navMove is null, unsupported or reduced motion; flushSync must land the DOM inside the callback.
 * Only the navigation that set data-nav clears it, so a second tap mid-animation keeps its own.
 */
function announce(alongside?: () => void): void {
  const previous = current.route;
  current = read();
  const move = navMove(previous, current.route);
  if (
    move === null ||
    typeof document.startViewTransition !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    tell();
    alongside?.();
    return;
  }
  const root = document.documentElement;
  const token = (navToken += 1);
  root.dataset["nav"] = move;
  const clear = (): void => {
    if (navToken !== token) return;
    delete root.dataset["nav"];
  };
  document.startViewTransition(() => {
    flushSync(() => {
      tell();
      alongside?.();
    });
  }).finished.then(clear, clear);
}

window.addEventListener("popstate", () => announce());

/** Carried forward when one overlay opens another, so a pop-up always closes onto a screen. */
function underFor(target: string): string {
  if (!isOverlayPath(target)) return "/";
  const here = window.location.pathname;
  return isOverlayPath(here) ? readUnder() : here;
}

export function navigate(path: string, replace = false, alongside?: () => void): void {
  const under = underFor(path);
  const origin = originFor(window.location.pathname, path, readOrigin());
  if (replace) window.history.replaceState({ under, origin }, "", path);
  else window.history.pushState({ under, origin }, "", path);
  announce(alongside);
}

export function newPath(machine?: MachineId, cwd?: string): string {
  return newSessionPath(machine, cwd);
}

export function agentPath(
  machine: MachineId,
  cwd?: string | null,
  step: AgentStep | null = null,
  preset: string | null = null,
): string {
  return agentBuilderPath(machine, cwd, step, preset);
}

export function agentEditPath(machine: MachineId, preset: string, cwd?: string | null): string {
  return editPath(machine, preset, cwd);
}

export function agentFromHarnessPath(
  machine: MachineId,
  harness: string,
  cwd?: string | null,
): string {
  return fromPath(machine, harness, cwd);
}

export function sessionPath(ref: SessionRef): string {
  return `/m/${encodeURIComponent(ref.machineId)}/s/${encodeURIComponent(ref.sessionId)}`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current.route);
}

/** For the gate bundle, which may not use Route but must still re-render when the address changes. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** A fixed destination, never history.back: a cold deep link has only one entry. */
export function useUnder(): string {
  return useSyncExternalStore(subscribe, () => current.under);
}

export function useOrigin(): string | null {
  return useSyncExternalStore(subscribe, () => current.origin);
}
