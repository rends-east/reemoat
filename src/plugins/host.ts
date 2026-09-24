import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { ArchiveError, PLUGIN_LIMITS, unpackArchive } from "../archive.js";
import { containedIn, resolved } from "../paths.js";
import type { ManagedSession, SessionRegistry } from "../registry.js";
import { probeExists } from "../stall.js";
import { PluginApi, PluginApiError, type PluginApiOptions } from "./api.js";
import { contributedId, parseManifest } from "./manifest.js";
import { PluginOrigins } from "./origin.js";
import {
  consentGap,
  fetchArchive,
  isSourceRefusal,
  REAL_ARCHIVE_FETCHER,
  sourceLabel,
  type ArchiveFetcher,
  type PluginConsent,
  type PluginSource,
} from "./source.js";
import {
  clampView,
  noteClamp,
  type PluginHook,
  type PluginManifest,
  type PluginResult,
  type PluginState,
  type PluginSummary,
  type PluginSurface,
  PLUGIN_VIEW_LIMITS,
} from "./protocol.js";
import {
  ForkedPluginRuntime,
  MAX_INFLIGHT_HOST_CALLS,
  MAX_INFLIGHT_INVOCATIONS,
  MAX_PLUGIN_MESSAGE_BYTES,
  PLUGIN_INVOKE_TIMEOUT_MS,
  PLUGIN_START_TIMEOUT_MS,
  type ChildMessage,
  type PluginInvokeKind,
  type PluginProcess,
  type PluginRuntime,
} from "./runtime.js";
import type { InstalledPlugin, PluginDataStore, PluginRecordStore } from "./store.js";

// Installed and running plugins. Discovers nothing, polls nothing, and never updates a plugin by itself (Q7.104, Q7.42).

const MAX_PLUGIN_STARTS = 3;
const RESTART_BASE_MS = 2_000;
const RESTART_MAX_MS = 60_000;
const MAX_CONSECUTIVE_TIMEOUTS = 3;
const MAX_HOOK_QUEUE = 256;
const MAX_FAILURE_CHARS = 500;

const SHUTDOWN_MUTATION_WAIT_MS = 3_000;

const STAGING_NAME = /^\.reemoat-plugin-[0-9a-f]{16}$/;
const REPLACED_NAME = /\.replaced-[0-9a-f]{8}$/;
/** Age past which a leftover staging or replaced tree is litter; generous so a second daemon's live install is not swept. */
const STALE_STAGING_MS = 60 * 60 * 1000;

type InvokeAnswer =
  | { kind: "done"; message: Extract<ChildMessage, { t: "done" }> }
  | { kind: "timeout" }
  | { kind: "stopped"; detail: string }
  | { kind: "oversize" };

export type InstallOutcome =
  | { kind: "ok"; summary: PluginSummary; replaced: string | null }
  | { kind: "busy" }
  | { kind: "refused"; code: string; message: string };

export interface PluginScheduler {
  wait(ms: number, fn: () => void): () => void;
  jitter(): number;
}

export interface PluginHostOptions {
  root: string;
  records: PluginRecordStore;
  data: PluginDataStore;
  registry: SessionRegistry;
  api: Omit<PluginApiOptions, "registry" | "data" | "onWarning" | "origins">;
  onWarning?: (detail: string) => void;
  runtime?: PluginRuntime;
  now?: () => number;
  scheduler?: PluginScheduler;
  fetchArchive?: ArchiveFetcher;
  origins?: PluginOrigins;
  timeouts?: { start?: number; invoke?: number };
  contributions?: { refresh(installed: readonly InstalledPlugin[]): void };
  /** Sweeps a removed plugin's saved credentials, on remove only; `prune()` never touches those tables (Q7.124). */
  secrets?: {
    /** By prefix, not by the manifest's ids: an unreadable row's keys must still be swept. */
    forgetPrefix(prefix: string): void;
  };
}

export class PluginHost {
  // Realpath'd at open: `containedIn` compares a not-yet-created target unresolved, so the root must be in the same namespace.
  private root: string;
  private readonly live = new Map<string, LivePlugin>();
  private readonly api: PluginApi;
  private readonly origins: PluginOrigins;
  private readonly watching = new Map<string, () => void>();
  private unwatch: (() => void) | null = null;
  // One mutation at a time daemon-wide, held by install, remove and setEnabled alike (Q7.97).
  private mutating = false;
  private stopped: Promise<void> | null = null;

  private constructor(readonly options: PluginHostOptions) {
    this.root = options.root;
    this.origins = options.origins ?? new PluginOrigins();
    this.api = new PluginApi({
      ...options.api,
      registry: options.registry,
      data: options.data,
      onWarning: options.onWarning,
      origins: this.origins,
    });
  }

  static async open(options: PluginHostOptions): Promise<PluginHost> {
    const host = new PluginHost(options);
    await mkdir(options.root, { mode: 0o700, recursive: true });
    host.root = resolved(options.root);
    await host.sweepStaleStaging();
    for (const record of options.records.list()) {
      host.live.set(record.id, new LivePlugin(record, host));
    }
    host.syncContributions();
    // Watched before anything starts, so a plugin starting during boot misses no resumed session.
    host.unwatch = options.registry.watchSessions((managed, arrival, origin) => host.observe(managed, arrival, origin));
    for (const managed of options.registry.list()) host.observe(managed, "restored", null);
    for (const plugin of host.live.values()) {
      // Seeded: `observe` fans session.created only for created arrivals, so restored sessions reach a plugin only this way.
      plugin.seed(options.registry.list());
      // Not awaited: a plugin that will not start must not delay the daemon's own start.
      if (plugin.record.enabled) void plugin.ensureStarted("supervised");
    }
    return host;
  }

  get pluginRoot(): string {
    return this.root;
  }

  warn(detail: string): void {
    try {
      this.options.onWarning?.(detail);
    } catch {
      // There is no other way to report from here.
    }
  }

  callApi(manifest: PluginManifest, method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.api.call(manifest, method, args, signal);
  }

  pluginRuntime(): PluginRuntime {
    return this.options.runtime ?? SHARED_RUNTIME;
  }

  private clock(): number {
    return this.options.now?.() ?? Date.now();
  }

  scheduler(): PluginScheduler {
    return this.options.scheduler ?? REAL_SCHEDULER;
  }

  startTimeout(): number {
    return this.options.timeouts?.start ?? PLUGIN_START_TIMEOUT_MS;
  }

  invokeTimeout(): number {
    return this.options.timeouts?.invoke ?? PLUGIN_INVOKE_TIMEOUT_MS;
  }

  entryFor(record: InstalledPlugin): string {
    return join(this.root, record.id, record.version, "server.js");
  }

  list(): PluginSummary[] {
    return [...this.live.values()].map((plugin) => plugin.summary()).sort((a, b) => a.name.localeCompare(b.name));
  }

  find(id: string): LivePlugin | null {
    return this.live.get(id) ?? null;
  }

  /** Stage inside the root, unpack, validate the manifest, then publish by one rename; a failed start restores the old version. */
  async install(request: {
    body: ReadableStream<Uint8Array>;
    name: string;
    source?: PluginSource;
    consent?: PluginConsent;
  }): Promise<InstallOutcome> {
    if (this.shuttingDown) {
      await cancel(request.body);
      return refuse("shutting_down", "the daemon is shutting down");
    }
    if (this.mutating) {
      await cancel(request.body);
      return { kind: "busy" };
    }
    this.mutating = true;
    const staging = join(this.root, `.reemoat-plugin-${randomBytes(8).toString("hex")}`);
    let published: string | null = null;
    let aside: string | null = null;
    let planted: LivePlugin | null = null;
    let target: string | null = null;
    let existing: LivePlugin | null = null;
    let wrote = false;
    // Asked of the record store, not `live`: an unreadable row is absent from `live`, and the rollback must not drop its data.
    let hadRow = false;
    try {
      await mkdir(staging, { mode: 0o700, recursive: true });
      const unpacked = await unpackArchive({ staging, body: request.body, limits: PLUGIN_LIMITS });
      if (unpacked.kind === "too_large") return refuse("plugin_too_large", "that archive is larger than a plugin may be");
      if (unpacked.kind === "unsupported") return refuse("unsupported_archive", "a plugin must be a .tar.gz or a .zip");
      if (unpacked.kind === "empty") return refuse("archive_empty", "there is nothing in that archive");
      if (unpacked.kind === "refused") return refuse(archiveCode(unpacked.error), unpacked.error.message);
      if (unpacked.kind !== "ok") return refuse("plugin_write_failed", unpacked.detail);

      const root = await findManifestRoot(unpacked.tree);
      if (root === null) return refuse("manifest_missing", "that archive has no plugin.json at its top level");

      const parsed = parseManifest(await readFile(join(root, "plugin.json"), "utf8"));
      if (!parsed.ok) return refuse(parsed.code, parsed.message);
      const manifest = parsed.manifest;

      if ((await probeExists(join(root, "server.js"))) !== true) {
        return refuse("entry_missing", "that plugin has no server.js beside its plugin.json");
      }

      if (request.consent !== undefined) {
        const gap = consentGap(request.consent, manifest);
        if (gap !== null) return refuse("plugin_consent_broken", gap);
      }

      const over = this.contributionsOver(manifest);
      if (over !== null) return refuse("plugin_too_many_contributions", over);

      existing = this.live.get(manifest.id) ?? null;
      const replaced = existing?.record.version ?? null;
      const wanted = existing?.record.enabled ?? true;
      if (existing !== null) await existing.stop();

      target = join(this.root, manifest.id, manifest.version);
      await mkdir(join(this.root, manifest.id), { mode: 0o700, recursive: true });
      // Moved aside, never deleted, until the new build is proven: a same-version reinstall shares `target` with the running plugin.
      const there = await probeExists(target);
      if (there === null) {
        // Thrown, not refused: `existing` is already stopped and only the catch restarts it.
        throw new Error(`the filesystem holding ${target} did not answer`);
      }
      if (there) {
        aside = `${target}.replaced-${randomBytes(4).toString("hex")}`;
        await rename(target, aside);
      }
      await rename(root, target);
      published = target;

      const now = this.clock();
      const record: InstalledPlugin = {
        id: manifest.id,
        version: manifest.version,
        manifest,
        enabled: true,
        installedAt: existing?.record.installedAt ?? now,
        updatedAt: now,
        source:
          request.source !== undefined
            ? sourceLabel(request.source)
            : request.name.length > 0
              ? request.name
              : null,
      };

      const plugin = new LivePlugin(record, this);
      this.live.set(record.id, plugin);
      planted = plugin;
      // Proven even when disabled: an update must run once before its predecessor is discarded.
      const failure = await plugin.ensureStarted("supervised");
      if (failure !== null) {
        await plugin.stop();
        await this.discard(target);
        published = null;
        if (aside !== null) {
          await rename(aside, target);
          aside = null;
        }
        if (existing !== null) {
          this.live.set(existing.record.id, existing);
          existing.resetBudget();
          void existing.ensureStarted("supervised");
        } else {
          this.live.delete(record.id);
          // A failed fresh install removes the id directory too, or `installed` reads it as a plugin.
          await this.discard(join(this.root, manifest.id));
        }
        return refuse("plugin_start_failed", failure);
      }
      if (!wanted) {
        // Put back before the row is written, so the borrowed `enabled` is never observable.
        await plugin.stop();
        record.enabled = false;
      }

      hadRow = this.options.records.has(manifest.id);
      if (existing !== null) {
        const before = new Set(contributedIdsOf(existing.record));
        for (const id of contributedIdsOf(record)) before.delete(id);
        if (before.size > 0) {
          this.options.onWarning?.(
            `${manifest.id} ${record.version} no longer provides ${[...before].join(", ")}; ` +
              `anything on this machine that named one will stop resolving`,
          );
        }
      }
      this.options.records.put(record);
      wrote = true;
      this.syncContributions();
      this.probeContributed(this.contributedHarnesses(manifest.id));
      if (replaced !== null && replaced !== record.version) {
        await this.discard(join(this.root, manifest.id, replaced));
      }
      plugin.seed(this.options.registry.list());
      // Stopped again: `deliver`'s drain can restart the incumbent after the first stop; `stop()` is memoised per launch.
      if (existing !== null) await existing.stop();
      // Discarded last, after everything that can throw and after the incumbent is down: the catch needs it, and a restarted incumbent runs from it.
      if (aside !== null) {
        await this.discard(aside);
        aside = null;
      }
      return { kind: "ok", summary: plugin.summary(), replaced };
    } catch (error) {
      // Stopped first: the child runs out of the tree about to be discarded.
      if (planted !== null) await planted.stop();
      // The row is restored on the same two arms as `live`: statements after `records.put` can throw.
      if (wrote) {
        if (existing !== null) this.options.records.put(existing.record);
        else if (planted !== null) {
          this.options.records.remove(planted.record.id);
          // Data is dropped only when no row existed before (`hadRow`, not `existing`), so an unreadable incumbent keeps its data.
          if (!hadRow) this.options.data.dropPlugin(planted.record.id);
        }
        this.syncContributions();
      }
      if (published !== null) await this.discard(published);
      const putBack = aside !== null && target !== null ? { from: aside, to: target } : null;
      const unrestored =
        putBack === null
          ? null
          : await rename(putBack.from, putBack.to).then(
              () => null,
              () => putBack,
            );
      if (existing !== null) {
        this.live.set(existing.record.id, existing);
        if (unrestored !== null) {
          // Kept and failed rather than dropped or started: the row is the only place that names the stranded tree, and `entryFor` cannot resolve.
          existing.markFailed(
            `this plugin's files could not be put back at ${unrestored.to} after a failed update, and are at ${unrestored.from}`,
          );
        } else {
          existing.resetBudget();
          void existing.ensureStarted("supervised");
        }
      } else if (planted !== null) {
        if (this.live.get(planted.record.id) === planted) this.live.delete(planted.record.id);
        await this.discard(join(this.root, planted.record.id));
      }
      if (error instanceof ArchiveError) return refuse(archiveCode(error), error.message);
      return refuse("plugin_write_failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.mutating = false;
      // Body cancelled first on every path: an unread body stalls the relay window for the whole tunnel.
      await cancel(request.body);
      await this.discard(staging);
    }
  }

  async installFromSource(source: PluginSource, consent: PluginConsent | null): Promise<InstallOutcome> {
    if (this.shuttingDown) return refuse("shutting_down", "the daemon is shutting down");
    if (this.mutating) return { kind: "busy" };

    const fetched = await fetchArchive(source, this.options.fetchArchive ?? REAL_ARCHIVE_FETCHER);
    if (isSourceRefusal(fetched)) return refuse(fetched.code, fetched.message);
    try {
      return await this.install({
        body: fetched.body,
        name: "",
        source,
        ...(consent === null ? {} : { consent }),
      });
    } finally {
      fetched.done();
    }
  }

  async remove(id: string): Promise<boolean | "busy"> {
    return this.exclusive(() => this.doRemove(id));
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T | "busy"> {
    if (this.shuttingDown) return "busy";
    if (this.mutating) return "busy";
    this.mutating = true;
    try {
      return await fn();
    } finally {
      this.mutating = false;
    }
  }

  /**
   * Detached capability read of each newly added harness, so a start refusal shows on GET /agents before anybody presses Start.
   * On install, update and enable only.
   */
  private probeContributed(ids: readonly string[]): void {
    const ask = this.options.api.ask;
    if (ask === undefined || ids.length === 0) return;
    for (const id of ids) {
      if (this.shuttingDown) return;
      // Swallowed: nobody is waiting, and a refusal is already recorded against the harness.
      void ask.capabilities(id).catch(() => undefined);
    }
  }

  private contributedHarnesses(id: string): readonly string[] {
    const record = this.options.records.get(id);
    return record === null ? [] : record.manifest.contributes.harnesses.map((one) => `${id}:${one.id}`);
  }

  private syncContributions(): void {
    this.options.contributions?.refresh(this.options.records.list());
    this.options.registry.sessionRuntime.forgetStartRefusal();
    this.options.registry.sessionRuntime.forgetAvailability();
    // Every harness cache goes too (start refusals, availability, the ask runner's answers): each describes the previous binaries.
    this.options.api.ask?.forget?.();
  }

  private contributionsOver(manifest: PluginManifest): string | null {
    let harnesses = manifest.contributes.harnesses.length;
    let systems = manifest.contributes.systems.length;
    for (const row of this.options.records.list()) {
      if (row.id === manifest.id) continue;
      harnesses += row.manifest.contributes.harnesses.length;
      systems += row.manifest.contributes.systems.length;
    }
    if (harnesses > MAX_CONTRIBUTED_HARNESSES) {
      return `this machine already has ${MAX_CONTRIBUTED_HARNESSES} agents added by plugins, which is as many as it will run`;
    }
    if (systems > MAX_CONTRIBUTED_SYSTEMS) {
      return `this machine already has ${MAX_CONTRIBUTED_SYSTEMS} providers added by plugins`;
    }
    return null;
  }

  private async doRemove(id: string): Promise<boolean> {
    const plugin = this.live.get(id);
    if (plugin !== undefined) {
      // Disabled and dropped from `live` before awaiting stop, or `drain` restarts a child nothing tracks.
      plugin.record.enabled = false;
      this.live.delete(id);
      await plugin.stop();
    } else if (!(await this.installed(id))) {
      return false;
    }
    this.options.records.remove(id);
    this.options.data.dropPlugin(id);
    this.options.secrets?.forgetPrefix(`${id}:`);
    this.syncContributions();
    // Thrown on a failed rm: row and data are gone, and a leftover tree would read as installed forever.
    if (!(await this.discard(join(this.root, id)))) {
      throw new Error(`${id} was removed from this daemon's records, but its files at ${join(this.root, id)} could not be`);
    }
    return true;
  }

  private async installed(id: string): Promise<boolean> {
    if (this.options.records.has(id)) return true;
    const directory = join(this.root, id);
    if (!containedIn(directory, this.root)) return false;
    return (await probeExists(directory)) === true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginSummary | null | "busy"> {
    return this.exclusive(() => this.doSetEnabled(id, enabled));
  }

  private async doSetEnabled(id: string, enabled: boolean): Promise<PluginSummary | null> {
    const plugin = this.live.get(id);
    if (plugin === undefined) return null;
    plugin.record.enabled = enabled;
    this.options.records.setEnabled(id, enabled, this.clock());
    // Before start and stop: GET /agents must change in the same tick.
    this.syncContributions();
    if (enabled) {
      plugin.resetBudget();
      this.probeContributed(this.contributedHarnesses(id));
      await plugin.ensureStarted("supervised");
    } else {
      await plugin.stop();
    }
    return plugin.summary();
  }

  /**
   * Removes staging and `.replaced-` trees an interrupted install left, at boot only.
   * Name, lstat-directory and age must all match; failures are silent.
   */
  private async sweepStaleStaging(): Promise<void> {
    const cutoff = Date.now() - STALE_STAGING_MS;
    // `lstat`, not `probeExists`: a symlink wearing the name must be neither followed nor removed.
    const collect = async (full: string): Promise<void> => {
      try {
        const info = await lstat(full);
        if (!info.isDirectory()) return;
        if (info.mtimeMs > cutoff) return;
        if (!containedIn(full, this.root)) return;
        await rm(full, { recursive: true, force: true });
        this.warn(`removed ${full}, left behind by an install that did not finish`);
      } catch {
        // Gone already, or not ours; not worth failing open over.
      }
    };

    let top: string[];
    try {
      top = await readdir(this.root);
    } catch {
      return;
    }
    for (const name of top) {
      if (STAGING_NAME.test(name)) {
        await collect(join(this.root, name));
        continue;
      }
      const directory = join(this.root, name);
      let versions: string[];
      try {
        const info = await lstat(directory);
        if (!info.isDirectory()) continue;
        versions = await readdir(directory);
      } catch {
        continue;
      }
      for (const version of versions) {
        if (!REPLACED_NAME.test(version)) continue;
        await collect(join(directory, version));
      }
    }
  }

  private async discard(path: string): Promise<boolean> {
    if (!containedIn(path, this.root)) {
      this.warn(`refused to remove ${path}, which is not under the plugin root`);
      return false;
    }
    const there = await probeExists(path);
    if (there === null) {
      this.warn(`the filesystem holding ${path} did not answer; nothing was removed`);
      return false;
    }
    if (!there) return true;
    try {
      await rm(path, { recursive: true, force: true });
      return true;
    } catch (error) {
      // Warned, not thrown: half the callers are inside the install rollback, and a throw abandons the rest of it.
      this.warn(`could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private observe(managed: ManagedSession, arrival: "created" | "restored", origin: string | null): void {
    if (this.shuttingDown || this.watching.has(managed.id)) return;
    let ended = false;
    // A throw is reported and the subscription kept: both the log and `watch` evict a listener that throws.
    const guarded = (run: () => void): void => {
      try {
        run();
      } catch (error) {
        this.warn(
          `plugin hooks for session ${managed.id} threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const unsubLog = managed.log.subscribe((stored) =>
      guarded(() => {
        const event = stored.event;
        if (event.type === "turn_end") {
          // Taken before the fan whether or not anyone listens, so a stale claim cannot suppress a later turn.
          const started = this.origins.takeTurn(managed.id);
          this.fan("turn.ended", () => ({ session: managed.snapshot(), stopReason: event.stopReason }), started);
        } else if (event.type === "permission_request") {
          this.fan(
            "permission.requested",
            () => ({
              session: managed.snapshot(),
              permissionId: event.permissionId,
              title: event.title,
              options: event.options,
            }),
            null,
          );
        } else if (event.type === "permission_resolved") {
          this.fan(
            "permission.resolved",
            () => ({
              session: managed.snapshot(),
              permissionId: event.permissionId,
              title: event.title,
              outcome: event.outcome,
              optionId: event.optionId,
              by: event.by,
            }),
            null,
          );
        }
      }),
    );
    const unsubWatch = managed.watch((snapshot) =>
      guarded(() => {
        if (snapshot.exit === null) {
          ended = false;
          return;
        }
        // A parked session has not ended; without this every idle period fans session.ended.
        if (snapshot.exit.reason === "parked") return;
        if (ended) return;
        ended = true;
        // A claim left on an ended session would suppress a resumed session's first turn.
        this.origins.forget(snapshot.id);
        // Unattributed. A create whose start throws loops through this hook, bounded only by SESSION_CREATE_BURST.
        this.fan("session.ended", () => ({ session: snapshot, exit: snapshot.exit }), null);
      }),
    );
    this.watching.set(managed.id, () => {
      unsubLog();
      unsubWatch();
    });
    if (arrival === "created") {
      this.fan("session.created", () => ({ session: managed.snapshot() }), origin);
    }
  }

  private fan(hook: PluginHook, payload: () => Record<string, unknown>, origin: string | null): void {
    let built: Record<string, unknown> | null = null;
    for (const plugin of this.live.values()) {
      if (origin !== null && plugin.record.id === origin) continue;
      if (!plugin.wants(hook)) continue;
      built ??= payload();
      plugin.deliver(hook, { hook, ...built });
    }
  }

  private get shuttingDown(): boolean {
    return this.stopped !== null;
  }

  shutdown(): Promise<void> {
    return (this.stopped ??= this.doShutdown());
  }

  private async doShutdown(): Promise<void> {
    this.unwatch?.();
    this.unwatch = null;
    for (const stop of this.watching.values()) stop();
    this.watching.clear();
    // A mutation in flight is waited out, but bounded: a trickled upload must not spend daemon.ts's 25 s exit budget.
    const deadline = Date.now() + SHUTDOWN_MUTATION_WAIT_MS;
    while (this.mutating && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10).unref?.();
      });
    }
    if (this.mutating) {
      this.warn(
        `a change to this machine's plugins was still running after ${SHUTDOWN_MUTATION_WAIT_MS}ms; shutting down without waiting for it`,
      );
    }
    await Promise.all([...this.live.values()].map((plugin) => plugin.stop()));
  }
}

const SHARED_RUNTIME: PluginRuntime = new ForkedPluginRuntime();

const REAL_SCHEDULER: PluginScheduler = {
  wait(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  jitter: () => Math.random(),
};

/** A passive (read-scoped) caller joins a start in flight but never originates one, so reads cannot spend the restart budget. */
type StartIntent = "supervised" | "passive";

class LivePlugin {
  state: PluginState = "stopped";
  failure: string | null = null;
  private process: PluginProcess | null = null;
  /** Which launch this is, from one. Every callback compares it before touching shared state: callbacks fire after a successor started. */
  private generation = 0;
  private hostCallsAbort = new AbortController();
  /** Newest launch a stop was asked for: a child of generation `g` must never run once this reaches `g`. */
  private stopGeneration = 0;
  private starting: Promise<string | null> | null = null;
  private stopping: Promise<void> | null = null;
  private hostCalls = 0;
  private readonly pending = new Map<
    number,
    { settle: (answer: InvokeAnswer) => void; timer: NodeJS.Timeout; generation: number }
  >();
  private nextInvokeId = 1;
  private starts = 0;
  private timeouts = 0;
  private restart: (() => void) | null = null;
  private restartSeq = 0;
  private readonly queue: { hook: PluginHook; payload: unknown }[] = [];
  private dropped = 0;
  private draining = false;

  constructor(
    readonly record: InstalledPlugin,
    private readonly host: PluginHost,
  ) {}

  wants(hook: PluginHook): boolean {
    return this.record.enabled && this.record.manifest.contributes.hooks.includes(hook);
  }

  resetBudget(): void {
    this.starts = 0;
    this.timeouts = 0;
    this.failure = null;
  }

  markFailed(detail: string): void {
    this.fail(detail);
  }

  summary(): PluginSummary {
    const { manifest } = this.record;
    return {
      id: manifest.id,
      name: manifest.name,
      version: this.record.version,
      description: manifest.description,
      scopes: manifest.scopes,
      net: manifest.net,
      contributes: manifest.contributes,
      enabled: this.record.enabled,
      state: this.state,
      failure: this.failure,
      installedAt: this.record.installedAt,
      updatedAt: this.record.updatedAt,
    };
  }

  ensureStarted(intent: StartIntent): Promise<string | null> {
    if (this.state === "running") return Promise.resolve(null);
    if (!this.record.enabled) return Promise.resolve("this plugin is switched off");
    if (this.starting !== null) return this.starting;
    if (intent === "passive") return Promise.resolve(this.failure ?? "this plugin is not running");
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<string | null> {
    if (this.starts >= MAX_PLUGIN_STARTS) {
      return this.fail(`this plugin failed to start ${MAX_PLUGIN_STARTS} times and will not be tried again`);
    }
    this.starts += 1;
    this.state = "starting";
    // Claimed before the wait, so a stop queued meanwhile targets this generation.
    const generation = ++this.generation;
    const hostCalls = new AbortController();
    // Held locally too: the field moves to the next launch, and a late `onExit` must abort its own controller.
    this.hostCallsAbort = hostCalls;
    // A stop in progress is awaited, not raced: a second live child could never be stopped.
    // `stopping` is deliberately not cleared here.
    const previous = this.stopping;
    if (previous !== null) await previous;

    let ready: (value: string | null) => void;
    const settled = new Promise<string | null>((resolve) => {
      ready = resolve;
    });

    const entry = this.host.entryFor(this.record);
    let mine: PluginProcess | null = null;
    let child: PluginProcess;
    try {
      child = await this.host.pluginRuntime().launch({
        manifest: this.record.manifest,
        entry,
        onMessage: (message) => {
          if (generation !== this.generation) return;
          // And a stop asked for this launch, which the generation check cannot see.
          if (this.stopGeneration >= generation) return;
          if (message.t === "ready") {
            this.state = "running";
            this.failure = null;
            ready(null);
            this.drain();
            return;
          }
          if (message.t === "fail") {
            ready(clip(message.error, MAX_FAILURE_CHARS));
            return;
          }
          const target = mine;
          if (target === null) return;
          this.onChildMessage(message, target, generation);
        },
        onExit: (detail) => {
          // This child's waiters are answered and their timers disarmed, before the gate: nobody else will answer them.
          this.settlePending(generation, `the plugin process ${detail}`);
          // Outbound calls aborted on a crash too, before the gate: once restarted, this controller is unreachable.
          hostCalls.abort(new Error(`the plugin process ${detail}`));
          if (generation !== this.generation) {
            return;
          }
          this.process = null;
          // A stop asked for this child is not a failure; `stopGeneration` tells them apart.
          if (this.stopGeneration >= generation || !this.record.enabled) {
            this.state = "stopped";
            return;
          }
          this.fail(`the plugin process ${detail}`);
          ready(this.failure);
          this.scheduleRestart();
        },
      });
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }

    if (this.stopGeneration >= generation) {
      // A stop was asked for during the fork: publishing now would leave a child nothing can stop.
      await child.stop();
      return "this plugin was stopped while it was starting";
    }
    mine = child;
    this.process = child;
    child.send({ t: "init", manifest: this.record.manifest, entry });

    const wait = this.host.startTimeout();
    const deadline = new Promise<string | null>((resolve) => {
      setTimeout(() => resolve(`this plugin did not start within ${wait}ms`), wait).unref?.();
    });
    const answer = await Promise.race([settled, deadline]);
    if (answer !== null) {
      // `this.stop()`, not `child.stop()`: a kill this host asked for must not read as a crash and schedule a restart.
      await this.stop();
      return this.fail(withLogs(answer, child));
    }
    return null;
  }

  private scheduleRestart(): void {
    if (this.restart !== null || !this.record.enabled || this.starts >= MAX_PLUGIN_STARTS) return;
    const scheduler = this.host.scheduler();
    const ceiling = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (this.starts - 1));
    const wait = Math.floor(scheduler.jitter() * ceiling);
    // The callback may run before `wait` returns; `attempt` ignores a stale firing.
    const attempt = ++this.restartSeq;
    let fired = false;
    const cancel = scheduler.wait(wait, () => {
      fired = true;
      if (this.restartSeq !== attempt) return;
      this.restart = null;
      void this.ensureStarted("supervised");
    });
    this.restart = fired ? null : cancel;
  }

  private onChildMessage(message: ChildMessage, target: PluginProcess, generation: number): void {
    if (message.t === "call") {
      const { id } = message;
      if (this.hostCalls >= MAX_INFLIGHT_HOST_CALLS) {
        target.send({
          t: "answer",
          id,
          ok: false,
          error: `this plugin already has ${MAX_INFLIGHT_HOST_CALLS} calls out; wait for one before making another`,
        });
        this.host.warn(
          `plugin ${this.record.id} asked for more than ${MAX_INFLIGHT_HOST_CALLS} host calls at once`,
        );
        return;
      }
      this.hostCalls += 1;
      // Released on both arms, before the generation check: the slot is about this process's load.
      const release = (): void => {
        this.hostCalls = Math.max(0, this.hostCalls - 1);
      };
      const gone = this.hostCallsAbort.signal;
      void this.host
        .callApi(this.record.manifest, message.method, message.args, gone)
        .then((value) => {
          release();
          if (generation !== this.generation) return;
          if (target.send({ t: "answer", id, ok: true, value }) === false) {
            target.send({
              t: "answer",
              id,
              ok: false,
              error: `that answer is larger than the ${MAX_PLUGIN_MESSAGE_BYTES} bytes this channel carries`,
            });
          }
        })
        .catch((error: unknown) => {
          release();
          if (generation !== this.generation) return;
          const detail =
            error instanceof PluginApiError
              ? `${error.code}: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error);
          target.send({ t: "answer", id, ok: false, error: detail });
        });
      return;
    }
    if (message.t === "done") {
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      if (waiter.generation !== generation) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      this.timeouts = 0;
      waiter.settle({ kind: "done", message });
    }
  }

  async invoke(kind: PluginInvokeKind, name: string, input: unknown): Promise<PluginResult> {
    const failure = await this.ensureStarted(kind === "hook" ? "supervised" : "passive");
    if (failure !== null) throw new PluginApiError("plugin_unavailable", failure);
    const generation = this.generation;
    const child = this.process;
    if (child === null) throw new PluginApiError("plugin_unavailable", this.failure ?? "this plugin is not running");

    if (this.pending.size >= MAX_INFLIGHT_INVOCATIONS) {
      throw new PluginApiError(
        "plugin_overloaded",
        `this plugin is already answering ${MAX_INFLIGHT_INVOCATIONS} requests`,
      );
    }
    const id = this.nextInvokeId++;
    const wait = this.host.invokeTimeout();
    const answer = await new Promise<InvokeAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ kind: "timeout" });
        // Only the child this was written to may be charged for its silence.
        if (generation !== this.generation) return;
        this.timeouts += 1;
        if (this.timeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          void this.stop().then(() => {
            this.fail(`this plugin stopped answering after ${MAX_CONSECUTIVE_TIMEOUTS} requests`);
            // Restarted under supervision: this stop was the daemon's choice, and no HTTP caller could revive it.
            this.timeouts = 0;
            this.scheduleRestart();
          });
        }
      }, wait);
      timer.unref?.();
      this.pending.set(id, { settle: resolve, timer, generation });
      // Re-checked after the entry is in the map: a child dying in the gap has already run `settlePending`.
      if (this.process !== child || this.generation !== generation) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ kind: "stopped", detail: this.failure ?? "this plugin stopped before it could be asked" });
        return;
      }
      if (!child.send({ t: "invoke", id, kind, name, input })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ kind: "oversize" });
      }
    });

    if (answer.kind === "timeout") {
      throw new PluginApiError("plugin_timeout", `this plugin did not answer within ${wait}ms`);
    }
    if (answer.kind === "stopped") throw new PluginApiError("plugin_unavailable", answer.detail);
    if (answer.kind === "oversize") {
      throw new PluginApiError("plugin_request_too_large", `a plugin is sent at most ${MAX_PLUGIN_MESSAGE_BYTES} bytes in one message`);
    }
    if (!answer.message.ok) throw new PluginApiError("plugin_failed", clip(answer.message.error, MAX_FAILURE_CHARS));
    return this.shape(kind, name, answer.message.value);
  }

  private shape(kind: PluginInvokeKind, name: string, value: unknown): PluginResult {
    const surface: PluginSurface = kind === "view" && name === "settings" ? "settings" : "screen";
    if (kind === "action") {
      const result = (value ?? null) as { kind?: unknown; text?: unknown; tone?: unknown; view?: unknown } | null;
      if (result === null) return { kind: "toast", text: "Done", tone: "default" };
      if (result.kind === "toast") {
        return {
          kind: "toast",
          text: clip(String(result.text ?? "Done"), PLUGIN_VIEW_LIMITS.short),
          tone: result.tone === "danger" ? "danger" : "default",
        };
      }
      const clamped = clampView(result.kind === "view" ? result.view : result, surface);
      return { kind: "view", view: noteClamp(clamped, surface) };
    }
    return { kind: "view", view: noteClamp(clampView(value, surface), surface) };
  }

  seed(sessions: readonly ManagedSession[]): void {
    if (!this.wants("session.created")) return;
    for (const managed of sessions) {
      this.deliver("session.created", { hook: "session.created", session: managed.snapshot() });
    }
  }

  deliver(hook: PluginHook, payload: unknown): void {
    if (!this.wants(hook)) return;
    if (this.queue.length >= MAX_HOOK_QUEUE) {
      this.queue.shift();
      this.dropped += 1;
      if (this.dropped % MAX_HOOK_QUEUE === 1) {
        this.host.warn(`plugin ${this.record.id} is behind: ${this.dropped} hook deliveries dropped`);
      }
    }
    this.queue.push({ hook, payload });
    this.drain();
  }

  private drain(): void {
    if (this.draining || this.queue.length === 0) return;
    if (this.state !== "running") {
      // Not for a plugin whose budget is gone: `fail()` would block the emit path on a synchronous stderr write every hook.
      if (this.state !== "failed" && this.starts < MAX_PLUGIN_STARTS) {
        void this.ensureStarted("supervised");
      }
      return;
    }
    this.draining = true;
    void (async () => {
      try {
        while (this.queue.length > 0 && this.state === "running") {
          const next = this.queue.shift();
          if (next === undefined) break;
          try {
            // Sequential, so a plugin's hook handlers never race on its own store.
            await this.invoke("hook", next.hook, next.payload);
          } catch (error) {
            this.host.warn(
              `plugin ${this.record.id} failed on ${next.hook}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } finally {
        this.draining = false;
      }
    })();
  }

  /** Idempotent per launch: a stop after a restart really stops the new child. */
  stop(): Promise<void> {
    if (this.restart !== null) {
      this.restart();
      this.restart = null;
    }
    if (this.stopping === null || this.stopGeneration < this.generation) {
      const previous = this.stopping;
      this.stopGeneration = this.generation;
      const next = this.doStop(this.generation);
      // Chained, not replaced: an older child may still be dying.
      this.stopping = previous === null ? next : Promise.all([previous, next]).then(() => undefined);
    }
    return this.stopping;
  }

  private async doStop(generation: number): Promise<void> {
    this.settlePending(generation, "this plugin was stopped");
    this.hostCallsAbort.abort(new Error(`plugin ${this.record.id} was stopped`));
    const child = this.process;
    this.process = null;
    this.state = "stopped";
    if (child !== null) await child.stop();
  }

  /** Answer and disarm everything waiting on this launch or an older one, so stale timers cannot stop a replacement. */
  private settlePending(through: number, detail: string): void {
    for (const [id, waiter] of this.pending) {
      if (waiter.generation > through) continue;
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.settle({ kind: "stopped", detail });
    }
  }

  private fail(detail: string): string {
    const said = this.failure;
    this.state = "failed";
    this.failure = clip(detail, MAX_FAILURE_CHARS);
    if (said !== this.failure) this.host.warn(`plugin ${this.record.id}: ${this.failure}`);
    return this.failure;
  }
}

function withLogs(detail: string, child: PluginProcess): string {
  const logs = child.recentLogs();
  return logs.length === 0 ? detail : `${detail}\n${logs.join("\n")}`;
}

function refuse(code: string, message: string): InstallOutcome {
  return { kind: "refused", code, message };
}

function archiveCode(error: ArchiveError): string {
  switch (error.code) {
    case "too_large":
      return "plugin_unpacked_too_large";
    case "too_many":
      return "plugin_too_many_entries";
    case "empty":
      return "archive_empty";
    case "unsafe":
      return "archive_unsafe";
    default:
      return "archive_unreadable";
  }
}

async function findManifestRoot(tree: string): Promise<string | null> {
  if ((await probeExists(join(tree, "plugin.json"))) === true) return tree;
  const top = await readdir(tree, { withFileTypes: true });
  const only = top.length === 1 && top[0]?.isDirectory() === true ? top[0].name : null;
  if (only === null) return null;
  const nested = join(tree, only);
  return (await probeExists(join(nested, "plugin.json"))) === true ? nested : null;
}

async function cancel(body: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await body.cancel();
  } catch {
    // Already ended, errored or cancelled; not a reason to fail an install.
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export type { LivePlugin };


/**
 * How many harnesses and providers one machine takes from plugins, summed across plugins.
 * Each harness costs a process in every capabilities sweep, which holds both MAX_CONCURRENT_ASKS slots.
 */
export const MAX_CONTRIBUTED_HARNESSES = 8;
export const MAX_CONTRIBUTED_SYSTEMS = 24;

function contributedIdsOf(record: InstalledPlugin): string[] {
  return [
    ...record.manifest.contributes.harnesses.map((one) => contributedId(record.id, one.id)),
    ...record.manifest.contributes.systems.map((one) => contributedId(record.id, one.id)),
  ];
}
