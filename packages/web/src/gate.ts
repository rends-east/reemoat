import { signupMode, type InstanceConfig, type SignupMode } from "./instance";
import { LEGAL_DOCS, type LegalDoc } from "./legal";

/** Tokens ride the URL fragment: it never reaches a server log or a mail scanner, and a dotted path segment would trip looksLikeAsset. */

export type GateScreen = "register" | "confirm" | "forgot" | "reset" | "verify";

export const GATE_SCREENS: readonly GateScreen[] = ["register", "confirm", "forgot", "reset", "verify"];

export function parseGateScreen(segments: readonly (string | undefined)[]): GateScreen | null {
  const first = segments[0];
  if (first === undefined) return null;
  return GATE_SCREENS.find((screen) => screen === first) ?? null;
}

export function isGatePath(pathname: string): boolean {
  return parseGateScreen(pathname.split("/").filter((part) => part.length > 0)) !== null;
}

export function gatePath(screen: GateScreen): string {
  return `/${screen}`;
}

export function gateNeedsToken(screen: GateScreen): boolean {
  return screen === "confirm" || screen === "reset" || screen === "verify";
}

/** Only /verify: its token names the address and the session names the account, so it needs both. */
export function gateNeedsSession(screen: GateScreen): boolean {
  return screen === "verify";
}

export function gateOutranksSession(screen: GateScreen): boolean {
  return gateNeedsToken(screen);
}

/** No dot, slash or percent, each of which breaks the link in transit; the prefixes sit outside the credential ones. */
export function isGateToken(value: string): boolean {
  return /^(et|pr)_[A-Za-z0-9_-]{16,}$/.test(value);
}

export function readGateToken(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return null;
  let value: string | null = null;
  try {
    value = new URLSearchParams(raw).get("t");
  } catch {
    return null;
  }
  if (value === null) return null;
  return isGateToken(value) ? value : null;
}

export function readPastedGateToken(pasted: string): string | null {
  const text = pasted.trim();
  if (text.length === 0) return null;
  if (isGateToken(text)) return text;
  try {
    return readGateToken(new URL(text).hash);
  } catch {
    return text.startsWith("#") || text.startsWith("t=") ? readGateToken(text) : null;
  }
}

export function gateUsable(screen: GateScreen, token: string | null): boolean {
  return !gateNeedsToken(screen) || token !== null;
}

export function incompleteLinkRemedy(screen: GateScreen): { label: string; path: string } | null {
  switch (screen) {
    case "confirm":
      return { label: "Sign up again", path: "/register" };
    case "reset":
      return { label: "Send a new link", path: "/forgot" };
    case "verify":
    case "register":
    case "forgot":
      return null;
  }
}

export type GateOffer = "link" | "closed" | "unknown";

/** A null config is unknown here; showsGateLink is where failing open happens. forgot keys on email alone. */
export function gateOffer(which: "register" | "forgot", config: InstanceConfig | null): GateOffer {
  if (config === null) return "unknown";
  if (which === "register") return config.registration === "open" ? "link" : "closed";
  return config.email ? "link" : "closed";
}

/** Only a definite no hides a door. */
export function showsGateLink(which: "register" | "forgot", config: InstanceConfig | null): boolean {
  return gateOffer(which, config) !== "closed";
}

/** null exactly when both links are drawn. */
export function gateNotice(config: InstanceConfig | null): string | null {
  const canRegister = showsGateLink("register", config);
  const canRecover = showsGateLink("forgot", config);
  if (canRegister && canRecover) return null;
  if (canRegister) return "Lost your password? Ask whoever runs this control plane.";
  if (canRecover) return "No account? Ask whoever runs this control plane.";
  return "New accounts and lost passwords are both handled by whoever runs this control plane.";
}

export type SignupScreen = SignupMode | "waiting" | "unavailable";

/** unavailable is derived rather than latched, so a config that lands later still wins. */
export function signupScreen(config: InstanceConfig | null, settled: boolean): SignupScreen {
  return signupMode(config) ?? (settled ? "unavailable" : "waiting");
}

export type GateRoute =
  | { name: "gate"; screen: GateScreen }
  | { name: "legal"; doc: LegalDoc }
  | { name: "handoff" };

export function parseGateRoute(pathname: string): GateRoute {
  const segment = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const screen = GATE_SCREENS.find((s) => s === segment);
  if (screen !== undefined) return { name: "gate", screen };
  const doc = LEGAL_DOCS.find((d) => d === segment);
  if (doc !== undefined) return { name: "legal", doc };
  // Anything else is the handoff, never a not-found. Nothing is decoded: every value compared is an ASCII literal.
  return { name: "handoff" };
}
