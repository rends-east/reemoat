import { controlPlaneOrigin } from "./native";

// The key each machine was first reached with, kept on this device. The control plane names a key on every mint and is believed
// once: a different one later is never used until somebody here says so (Q1.657). Not synced, so a new device starts again.
const STORAGE_KEY = "reemoat.machinePins";

type Stored = Record<string, Record<string, string>>;

export interface MachinePins {
  get(machineId: string): string | null;
  set(machineId: string, key: string): void;
}

/** A machine key as every end spells it: 32 bytes, unpadded URL-safe base64. Anything else is no key. */
export function readMachineKey(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export type OfferedKey =
  /** Nothing to connect with: the machine never announced a key and this device holds none for it. */
  | { kind: "none" }
  | { kind: "use"; key: string; pin: boolean }
  /** The server now names another key. The held one is still the one to dial with, and `offered` waits on a person. */
  | { kind: "changed"; key: string; offered: string };

/** What to dial with, given what this device holds and what the server just named. Pure, so every pair of the two is driven. */
export function weighOfferedKey(pinned: string | null, offered: string | null): OfferedKey {
  if (pinned === null) return offered === null ? { kind: "none" } : { kind: "use", key: offered, pin: true };
  if (offered === null || offered === pinned) return { kind: "use", key: pinned, pin: false };
  return { kind: "changed", key: pinned, offered };
}

// Seeded lazily, as localRoute.ts is, so webcheck can stub storage after import.
let held: Stored | null = null;
/** Set here and refused by storage: laid over whatever storage says, so it still governs this session. */
let unsaved: Stored = {};
let watching = false;

function stored(): Stored {
  const out: Stored = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
    for (const [server, machines] of Object.entries(parsed)) {
      if (typeof machines !== "object" || machines === null || Array.isArray(machines)) continue;
      const kept: Record<string, string> = {};
      for (const [id, key] of Object.entries(machines)) {
        const usable = readMachineKey(key);
        if (usable !== null) kept[id] = usable;
      }
      out[server] = kept;
    }
  } catch {
    // Private mode or a hand-edited value: nothing held, so each machine is a first use again.
  }
  return out;
}

/** Storage laid over what is held: every account's webview on this computer writes the one value. */
function reread(): Stored {
  const next: Stored = { ...held };
  for (const layer of [stored(), unsaved]) {
    for (const [server, machines] of Object.entries(layer)) next[server] = { ...next[server], ...machines };
  }
  held = next;
  watch();
  return next;
}

function watch(): void {
  if (watching || typeof window.addEventListener !== "function") return;
  watching = true;
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === STORAGE_KEY) held = null;
  });
}

/** Scoped by server: a machine id is only a name within the control plane that minted it. */
export function storedPins(server: () => string = controlPlaneOrigin): MachinePins {
  return {
    get(machineId) {
      const origin = server();
      // A miss asks storage before it is one: another document may have pinned since this one last read.
      return held?.[origin]?.[machineId] ?? reread()[origin]?.[machineId] ?? null;
    },
    set(machineId, key) {
      const origin = server();
      const all = reread();
      all[origin] = { ...all[origin], [machineId]: key };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
        unsaved = {};
      } catch {
        unsaved[origin] = { ...unsaved[origin], [machineId]: key };
      }
    },
  };
}
