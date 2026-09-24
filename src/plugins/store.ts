import type { PluginManifest } from "./protocol.js";

// Plugin data is keyed on the plugin id, never its version, so an update keeps it; implemented in store/sqlite.ts.

export const MAX_PLUGIN_DATA_BYTES = 1024 * 1024;
export const MAX_PLUGIN_VALUE_BYTES = 64 * 1024;
/** Bytes cannot see this: many tiny values are many rows. */
export const MAX_PLUGIN_KEYS = 1_000;
export const MAX_PLUGIN_KEY_CHARS = 200;

export class PluginStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginStoreError";
  }
}

export interface InstalledPlugin {
  id: string;
  version: string;
  manifest: PluginManifest;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  /** Where it came from (archive name or GitHub label), for the record; never read for a decision. */
  source: string | null;
}

export interface PluginRecordStore {
  list(): InstalledPlugin[];
  get(id: string): InstalledPlugin | null;
  /** Also sees a row this build cannot parse, which get and list skip; remove needs that difference. */
  has(id: string): boolean;
  put(record: InstalledPlugin): void;
  setEnabled(id: string, enabled: boolean, now: number): void;
  remove(id: string): void;
}

export interface PluginEntry {
  key: string;
  value: unknown;
}

/** A page, because one plugin's quota exceeds one IPC message; more says the reader saw only a prefix. */
export interface PluginEntryPage {
  entries: PluginEntry[];
  more: boolean;
}

export interface PluginDataStore {
  get(pluginId: string, key: string): unknown;
  set(pluginId: string, key: string, value: string): void;
  delete(pluginId: string, key: string): void;
  keys(pluginId: string, prefix: string): string[];
  /** A keyset page after the cursor, ascending, bounded by maxBytes. */
  entries(pluginId: string, prefix: string, after: string, maxBytes: number): PluginEntryPage;
  /** Everything this plugin put here. Called when it is uninstalled, never on an update. */
  dropPlugin(pluginId: string): void;
}

/** Shared so daemoncheck's memory store refuses exactly what the SQLite one does. */
export function checkPluginWrite(
  key: string,
  value: string,
  current: { keys: number; bytes: number; existing: number | null },
): void {
  if (key.length === 0 || key.length > MAX_PLUGIN_KEY_CHARS) {
    throw new PluginStoreError("bad_request", `a key must be 1–${MAX_PLUGIN_KEY_CHARS} characters`);
  }
  if (/[\x00-\x1f\x7f]/.test(key)) {
    throw new PluginStoreError("bad_request", "a key may not hold control characters");
  }
  // UTF-8 bytes, the size that lands in the row; UTF-16 length undercounts CJK and emoji.
  const size = Buffer.byteLength(value, "utf8");
  if (size > MAX_PLUGIN_VALUE_BYTES) {
    throw new PluginStoreError("value_too_large", `a value may be at most ${MAX_PLUGIN_VALUE_BYTES} bytes`);
  }
  // Credit the replaced value first, or rewriting one key climbs to the ceiling and stays there.
  const after = current.bytes - (current.existing ?? 0) + size;
  if (after > MAX_PLUGIN_DATA_BYTES) {
    throw new PluginStoreError("store_full", `a plugin may keep at most ${MAX_PLUGIN_DATA_BYTES} bytes`);
  }
  if (current.existing === null && current.keys >= MAX_PLUGIN_KEYS) {
    throw new PluginStoreError("store_full", `a plugin may keep at most ${MAX_PLUGIN_KEYS} keys`);
  }
}
