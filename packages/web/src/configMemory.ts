import type { AgentConfig, AgentConfigOption } from "./wire";
import type { SessionKey } from "./ids";

/** The controls a running agent last published, kept across a reload so chips survive; drawn stale and never sent back to an agent. */
const STORAGE_KEY = "reemoat.configMemory";

const MAX_REMEMBERED = 120;

interface RememberedOption {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly kind: AgentConfigOption["kind"];
  readonly value: string | boolean;
  /** The selected one, or empty where the value matches nothing published. */
  readonly choices: AgentConfigOption["choices"];
}

interface Remembered {
  readonly at: number;
  readonly modes: AgentConfig["modes"];
  readonly options: readonly RememberedOption[];
}

/** Keeps only the current mode and each option's selected choice. */
export function reduceConfig(config: AgentConfig): Remembered {
  return {
    at: Date.now(),
    modes:
      config.modes === null
        ? null
        : {
            current: config.modes.current,
            available: config.modes.available.filter((one) => one.id === config.modes?.current),
          },
    options: config.options.map((option) => ({
      id: option.id,
      name: option.name,
      category: option.category ?? null,
      kind: option.kind,
      value: option.value,
      choices: option.choices.filter((choice) => choice.value === option.value),
    })),
  };
}

export function expandConfig(held: Remembered): AgentConfig {
  return {
    modes: held.modes,
    options: held.options.map((option) => ({
      id: option.id,
      name: option.name,
      description: null,
      category: option.category,
      kind: option.kind,
      value: option.value,
      choices: option.choices,
    })) as AgentConfig["options"],
  };
}

type Stored = Record<string, Remembered>;

const AT_REFRESH_MS = 60_000;

// Checked per entry: a malformed one would throw inside the store's poll loop and freeze that machine's session list.
function isRemembered(value: unknown): value is Remembered {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry["at"] !== "number") return false;
  const modes = entry["modes"];
  if (modes !== null) {
    if (typeof modes !== "object" || modes === null) return false;
    if (!Array.isArray((modes as Record<string, unknown>)["available"])) return false;
  }
  const options = entry["options"];
  if (!Array.isArray(options)) return false;
  return options.every((option) => {
    if (typeof option !== "object" || option === null) return false;
    const one = option as Record<string, unknown>;
    return typeof one["id"] === "string" && typeof one["kind"] === "string" && Array.isArray(one["choices"]);
  });
}

// Cached because this runs per session row on every poll; loaded lazily so importing the module has no side effect.
let cache: Stored | null = null;
let dirty = false;
let backstopped = false;

function read(): Stored {
  if (cache !== null) return cache;
  cache = load();
  return cache;
}

function load(): Stored {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isRemembered(value)) out[key] = value;
    }
    return out;
  } catch {
    // Private mode, quota or a foreign shape: a forgotten chip is not worth failing a render.
    return {};
  }
}

// One write per event-loop turn; pagehide flushes what a pending microtask could miss.
function markDirty(): void {
  if (dirty) return;
  dirty = true;
  queueMicrotask(flush);
  if (!backstopped && typeof window.addEventListener === "function") {
    backstopped = true;
    window.addEventListener("pagehide", flush);
  }
}

function flush(): void {
  if (!dirty || cache === null) return;
  dirty = false;
  cache = prune(cache);
  write(cache);
}

function write(next: Stored): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the in-memory copy still serves this tab.
  }
}

function signatureOf(config: AgentConfig): string {
  const modes = config.modes === null ? "" : config.modes.current;
  return `${modes}\u0000${config.options.map((option) => `${option.id}=${String(option.value)}`).join("\u0001")}`;
}

const signatures = new Map<string, string>();

export function prune(entries: Stored, keep: number = MAX_REMEMBERED): Stored {
  const keys = Object.keys(entries);
  if (keys.length <= keep) return entries;
  const newest = keys
    .sort((a, b) => (entries[b]?.at ?? 0) - (entries[a]?.at ?? 0))
    .slice(0, keep);
  const out: Stored = {};
  for (const key of newest) {
    const entry = entries[key];
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

export function rememberedConfig(key: SessionKey): AgentConfig | undefined {
  const entry = read()[key];
  return entry === undefined ? undefined : expandConfig(entry);
}

/** Records only a non-empty set: the daemon empties agentConfig while an agent is away, which must not erase the memory. */
export function rememberConfig(key: SessionKey, config: AgentConfig | undefined): void {
  if (config === undefined || config.options.length === 0) return;
  const entries = read();
  const now = Date.now();
  const signature = signatureOf(config);
  const held = entries[key];
  if (held !== undefined && signatures.get(key) === signature && now - held.at < AT_REFRESH_MS) {
    return;
  }
  signatures.set(key, signature);
  entries[key] = { ...reduceConfig(config), at: now };
  markDirty();
}

export function forgetAllConfig(): void {
  // Reset the cache and the dirty flag first, or a pending flush writes the file straight back.
  cache = {};
  dirty = false;
  signatures.clear();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was read and nothing can be.
  }
}
