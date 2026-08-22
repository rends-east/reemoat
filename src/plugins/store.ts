import type { PluginManifest } from "./protocol.js";

/**
 * What this daemon remembers about plugins, in two tables that are two subjects.
 *
 * `PluginRecordStore` is what is installed — one row per plugin, replaced whole
 * on an update. `PluginDataStore` is what a plugin has *put there*, and it is
 * keyed on the plugin's id and never on its version. That is the whole of what
 * makes an update an update rather than a reinstall: a board keeps its cards
 * across `0.1.0` → `0.2.0` because nothing about the version reaches this key.
 *
 * Declared here and implemented in `src/store/sqlite.ts`, which is the shape
 * `UploadIndex` already uses one directory up: the module that owns the subject
 * declares what it needs, and the module that owns the database decides how it is
 * kept. It also means `daemoncheck` can drive the host against a memory
 * implementation without a file.
 *
 * **Synchronous, like every other store here.** Node's SQLite bindings are
 * synchronous, so an async interface would buy nothing and cost the ability to
 * call these from anywhere.
 */

/** How much one plugin may keep, in the JSON that lands in the row. */
export const MAX_PLUGIN_DATA_BYTES = 1024 * 1024;
/** How large one value may be. */
export const MAX_PLUGIN_VALUE_BYTES = 64 * 1024;
/**
 * How many keys one plugin may hold.
 *
 * Bytes cannot see this — a hundred thousand one-byte values is nothing in bytes
 * and is a hundred thousand rows — which is the argument `MAX_UPLOADS_PER_SESSION`
 * already makes for the same pair of bounds one subject over.
 */
export const MAX_PLUGIN_KEYS = 1_000;
/** How long one key may be. A label, not a path. */
export const MAX_PLUGIN_KEY_CHARS = 200;

/** A refusal from the store, carrying the code the API turns into a plugin's error. */
export class PluginStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginStoreError";
  }
}

/** One installed plugin, as it sits on disk and in the database. */
export interface InstalledPlugin {
  id: string;
  version: string;
  manifest: PluginManifest;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  /** The archive's own filename, for the forensic trail. Never read for a decision. */
  source: string | null;
}

export interface PluginRecordStore {
  list(): InstalledPlugin[];
  get(id: string): InstalledPlugin | null;
  /**
   * Whether there is a row under this id at all, whatever this build makes of it.
   *
   * ⚠ **Deliberately not `get(id) !== null`, and that is the whole reason it
   * exists.** A row whose `manifest_json` this build cannot validate is reported
   * through `onDegraded` and skipped — `list` omits it and `get` answers `null` —
   * so neither of those can tell "nobody ever installed this" from "installed
   * here, and unreadable by this build". That difference is what `remove` is
   * answering, and without it the only way to ask was a filesystem probe standing
   * in for the database: the directory says a plugin *was* unpacked, which is a
   * different fact and one that outlives a row.
   */
  has(id: string): boolean;
  /** Insert or replace. An update is a replace, which is why there is no `update`. */
  put(record: InstalledPlugin): void;
  setEnabled(id: string, enabled: boolean, now: number): void;
  remove(id: string): void;
}

/** One key and the value kept under it, parsed exactly as {@link PluginDataStore.get} parses it. */
export interface PluginEntry {
  key: string;
  value: unknown;
}

/**
 * A page of them, and whether the store had more to give.
 *
 * **A page rather than the lot, because the lot does not fit.** A plugin may keep
 * {@link MAX_PLUGIN_DATA_BYTES} — 1 MiB — and the channel a call is answered over
 * carries 256 KiB a message, so "the quota already bounds this" is four times
 * wrong. `more` is how the reader learns it saw a prefix of its own data instead
 * of all of it; a truncation nobody is told about is a board quietly showing the
 * wrong number of cards.
 */
export interface PluginEntryPage {
  entries: PluginEntry[];
  /** True when the byte budget cut this page short. Ask again with `after` set to the last key. */
  more: boolean;
}

export interface PluginDataStore {
  get(pluginId: string, key: string): unknown;
  /** Throws {@link PluginStoreError} when a bound refuses. */
  set(pluginId: string, key: string, value: string): void;
  delete(pluginId: string, key: string): void;
  keys(pluginId: string, prefix: string): string[];
  /**
   * Key/value pairs under `prefix`, ascending by key, for keys strictly after
   * `after` — `""` for the first page.
   *
   * ⚠ **Batched because the shape without it was a round trip per key**, and the
   * API offering only `get`/`keys` is what forced it: the reference plugin read
   * its board with `keys()` and then one awaited `get()` per key, which for the
   * 1000 keys `MAX_PLUGIN_KEYS` allows is 2002 IPC messages and 1000 sequential
   * event-loop turns for one screen — re-run every `refreshMs` while somebody is
   * looking, out of the same 8-invocations-in-flight budget the hooks use.
   * Measured on this machine (Node 26, `fork` + JSON over IPC, `node:sqlite`
   * prepared statements, 1000 cards of ~139 bytes): 20.9ms and 2002 messages for
   * `keys` + 1000 `get`s, against 0.30ms and 2 messages for one `entries` call.
   * It was never the ten-second deadline it looked like — it is seventy times the
   * work, on the daemon's own event loop, for an answer one query already has.
   *
   * `maxBytes` bounds the page the way `EventStore.read`'s does, and for the same
   * reason: the caller cannot know how large the rows it is asking for are, so the
   * store is what stops. Ascending order plus a keyset cursor rather than an
   * offset, because a page is served from a table a plugin may be writing to
   * between calls and `key > ?` cannot skip a row or serve one twice.
   */
  entries(pluginId: string, prefix: string, after: string, maxBytes: number): PluginEntryPage;
  /** Everything this plugin put here. Called when it is uninstalled, never on an update. */
  dropPlugin(pluginId: string): void;
}

/**
 * The bounds, applied identically wherever the data lives.
 *
 * A function rather than four checks written into the SQLite implementation,
 * because `daemoncheck`'s memory implementation must refuse exactly what the real
 * one refuses — a quota that holds only in production is a quota nothing drives.
 */
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
  /*
   * ⚠ **Bytes, and the same bytes the row will hold.** `value.length` counts
   * UTF-16 code units, which is neither what SQLite's `LENGTH` returns
   * (characters) nor what lands on disk (UTF-8) — measured on one value, the
   * three answers were 22, 12 and 42. A plugin keeping CJK or emoji JSON could
   * therefore store roughly three times the ceiling, and the two halves of the
   * sum below disagreed with each other for astral characters, so the
   * credit-back drifted over repeated writes. `schema.sql` already claims this
   * is the byte that lands there; now it is.
   */
  const size = Buffer.byteLength(value, "utf8");
  if (size > MAX_PLUGIN_VALUE_BYTES) {
    throw new PluginStoreError("value_too_large", `a value may be at most ${MAX_PLUGIN_VALUE_BYTES} bytes`);
  }
  // The replaced value is credited back before the new one is charged, or a
  // plugin rewriting one key would climb to its own ceiling and stay there.
  const after = current.bytes - (current.existing ?? 0) + size;
  if (after > MAX_PLUGIN_DATA_BYTES) {
    throw new PluginStoreError("store_full", `a plugin may keep at most ${MAX_PLUGIN_DATA_BYTES} bytes`);
  }
  if (current.existing === null && current.keys >= MAX_PLUGIN_KEYS) {
    throw new PluginStoreError("store_full", `a plugin may keep at most ${MAX_PLUGIN_KEYS} keys`);
  }
}
