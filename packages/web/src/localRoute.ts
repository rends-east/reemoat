import { localDaemon } from "./native";

// Whether to reach this computer's daemon without the relay: a per-computer preference, not a MachineRecord field, storing only ids switched off.
// Never composes a URL: the base arrives from the host, which enforces loopback.
const STORAGE_KEY = "reemoat.localDaemons";

// Seeded lazily so webcheck, which stubs storage after import, can reach the read path.
let off: Set<string> | null = null;

function held(): Set<string> {
  off ??= new Set(readStored());
  return off;
}

function readStored(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || !("off" in parsed)) return [];
    const list = (parsed as { off: unknown }).off;
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // Private mode, quota or a hand-edited value: default to nothing switched off.
    return [];
  }
}

function write(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ off: [...held()] }));
  } catch {
    // The in-memory set still governs this session.
  }
}

export function localOff(machineId: string): boolean {
  return held().has(machineId);
}

export function setLocalOff(machineId: string, value: boolean): void {
  if (value) held().add(machineId);
  else held().delete(machineId);
  write();
}

/** null in a browser; not memoised, so a daemon started after the app is still found. */
export async function localBaseFor(machineId: string): Promise<string | null> {
  if (localOff(machineId)) return null;
  return await localAnnouncedFor(machineId);
}

/** Ignores the switch, so settings can tell no daemon here from one switched off. */
export async function localAnnouncedFor(machineId: string): Promise<string | null> {
  const found = await localDaemon();
  if (found === null) return null;
  // A hint only: the aud check on the next authenticated request is what establishes the machine.
  return found.machineId === machineId ? found.base : null;
}
