import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { ArchiveError, PLUGIN_LIMITS, unpackArchive } from "../archive.js";
import { containedIn, resolved } from "../paths.js";
import type { ManagedSession, SessionRegistry } from "../registry.js";
import { probeExists } from "../stall.js";
import { PluginApi, PluginApiError, type PluginApiOptions } from "./api.js";
import { parseManifest } from "./manifest.js";
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

/**
 * Plugins: what is installed, what is running, and what happens when one of them
 * is neither.
 *
 * The shape is `Session.start`'s — a private constructor behind a static async
 * factory — for its reason: opening this needs a directory to exist and rows to
 * be read, and a constructor that cannot await hands back a half-built object
 * somebody has to remember to finish.
 *
 * Three things this deliberately does **not** do, each of which reads as an
 * omission without a sentence:
 *
 *   - **It discovers nothing, and it polls nothing.** `src/` holds three `fetch`
 *     calls now and all three are named — `enroll.ts`, `net.fetch` made on a
 *     plugin's own behalf, and {@link fetchArchive} in `source.ts`, reached only
 *     by {@link PluginHost.installFromSource}. What Q7.104 refused was a
 *     *registry to poll*, which would make somebody else's outage able to stop an
 *     install on your own machine; the catalogue this daemon installs *from* lives
 *     entirely in the browser's world, and what arrives here is a repository and a
 *     commit that a person read the permissions of. `source.ts`'s header is the
 *     argument, and `.claude/rules/plugins.md` carries the count.
 *   - **It never updates a plugin by itself.** Updating is an act, exactly as
 *     updating the daemon is; nothing here is a step toward fleet rollout (Q7.42).
 *   - **It keeps no pid and reaps no orphans.** `runner.ts` exits when its IPC
 *     channel closes, so a daemon that dies takes its plugins with it. See
 *     `ForkedPluginRuntime`'s docblock for the contrast with agents, which need
 *     all three.
 */

/**
 * How many times a plugin may be **launched** before it is left alone — the first
 * one included, so it buys two restarts rather than three.
 *
 * Said as launches because that is what `starts` counts, and the message on the
 * row says the same ("failed to start 3 times"). `resetBudget` returns it, which
 * is deliberate and is not a way around this: being stopped so somebody else's
 * update could be tried is not one of this plugin's own failures.
 */
const MAX_PLUGIN_STARTS = 3;
/** Backoff between restarts. Full jitter, the shape `autoResume` uses. */
const RESTART_BASE_MS = 2_000;
const RESTART_MAX_MS = 60_000;
/** How many timeouts in a row before a plugin is stopped rather than asked again. */
const MAX_CONSECUTIVE_TIMEOUTS = 3;
/** How many hook deliveries may be waiting for one plugin. */
const MAX_HOOK_QUEUE = 256;
/** How much of a failure is kept on the row. */
const MAX_FAILURE_CHARS = 500;

/**
 * How long {@link PluginHost.shutdown} waits for a mutation in flight before it
 * goes ahead anyway.
 *
 * A few seconds because what it is buying is the ordinary case — an install
 * between its `rename` and its `ensureStarted`, which is milliseconds — and what
 * it is refusing to pay for is the pathological one, an archive arriving a byte at
 * a time. Well under `scripts/daemon.ts`'s 25 s hard exit on purpose: everything
 * after this method in that function still needs its own budget, and the two acts
 * this delays are the two that write things down.
 */
const SHUTDOWN_MUTATION_WAIT_MS = 3_000;

/**
 * A staging directory {@link PluginHost.install} left behind, by the only name it
 * ever gives one.
 *
 * Exact rather than a prefix test, and this is `archive.ts`'s own constant with
 * one word changed — `randomBytes(8).toString("hex")` is sixteen hex characters
 * and nothing else here is. A plugin id cannot collide with it at any price:
 * `manifest.ts`'s `ID` is `/^[a-z0-9][a-z0-9-]{0,31}$/`, so no id this daemon will
 * make a directory of can begin with a dot.
 */
const STAGING_NAME = /^\.reemoat-plugin-[0-9a-f]{16}$/;
/**
 * The incumbent tree, moved out of the way and never moved back.
 *
 * Matched as a **suffix** because the name is `<version>.replaced-<8 hex>` and the
 * version half is somebody's. It is still unambiguous: `manifest.ts`'s `VERSION`
 * is `/^\d+\.\d+\.\d+$/`, so no directory this daemon publishes can end this way,
 * and the only writer of the name is the one `rename` in `install`.
 */
const REPLACED_NAME = /\.replaced-[0-9a-f]{8}$/;
/**
 * How long one of those may sit before it is litter rather than an install.
 *
 * `archive.ts`'s number, for `archive.ts`'s reason and with one narrowing it does
 * not have: this sweep runs inside {@link PluginHost.open}, before a single
 * `install` on this daemon can have started, so the only writer it could race is
 * a *second* daemon pointed at the same `REEMOAT_PLUGIN_ROOT`. Generous on
 * purpose all the same — the cost of waiting too long is a directory nobody looks
 * at until the next boot an hour later, and the cost of not waiting long enough is
 * deleting a live install's staging out from under it.
 */
const STALE_STAGING_MS = 60 * 60 * 1000;

/**
 * How one invocation ended, as the things that are not each other.
 *
 * A union rather than a synthesized `done` message with an invented error string:
 * the timeout and the stop are facts about *this daemon*, not answers from the
 * plugin, and dressing them as answers is how they came to share a code with the
 * plugin's own failures.
 */
type InvokeAnswer =
  | { kind: "done"; message: Extract<ChildMessage, { t: "done" }> }
  | { kind: "timeout" }
  /**
   * Nobody is going to answer this, because the child it was written to is gone.
   *
   * **A crash lands here as well as a deliberate stop**, and `detail` is which.
   * From the caller's side the two are one fact — the child this request was
   * written to will not be answering it — so they share an arm rather than a code;
   * what they must not share is the sentence, because "this plugin was stopped"
   * over a plugin that died of a `SyntaxError` is an afternoon somebody spends
   * looking in the wrong place.
   */
  | { kind: "stopped"; detail: string }
  /** Never written to the channel. Distinct from `timeout`, because the remedy is "send less". */
  | { kind: "oversize" };

export type InstallOutcome =
  | { kind: "ok"; summary: PluginSummary; replaced: string | null }
  | { kind: "busy" }
  | { kind: "refused"; code: string; message: string };

/**
 * Where the restart backoff's wait and its jitter come from.
 *
 * ⚠ **A seam nothing can reach is worse than no seam at all**, and this exists
 * because there was one. `now` carried the comment "injected so a driver can age
 * a backoff without sleeping" and could never do it: `scheduleRestart` reached
 * straight for `setTimeout` and `Math.random`, `clock()` was read only by
 * `install` and `setEnabled`, and no driver passed `now` at all. So the only way
 * to drive a restart was to wait out a real full-jitter interval — up to a minute
 * — which is precisely the cost {@link PluginHostOptions.timeouts} exists to
 * refuse one field down. `now` is a real seam for something else, and its comment
 * now says which.
 *
 * Two methods rather than one, because full jitter is two decisions: how large
 * the ceiling has grown, and how much of it this attempt takes. A driver that can
 * only skip the sleep still cannot assert the ceiling it was asked to sleep for,
 * and the ceiling is the half that encodes `MAX_PLUGIN_STARTS`.
 */
export interface PluginScheduler {
  /**
   * Run `fn` after `ms`. The returned function cancels it, run or not.
   *
   * A cancel handed back rather than a timer handle, which is this codebase's
   * shape for teardown everywhere else and is what lets `LivePlugin` hold one
   * field it can call rather than a `NodeJS.Timeout` it has to know how to clear.
   */
  wait(ms: number, fn: () => void): () => void;
  /** Full jitter's source, in `[0, 1)`. `Math.random` in production. */
  jitter(): number;
}

export interface PluginHostOptions {
  root: string;
  records: PluginRecordStore;
  data: PluginDataStore;
  registry: SessionRegistry;
  api: Omit<PluginApiOptions, "registry" | "data" | "onWarning" | "origins">;
  onWarning?: (detail: string) => void;
  /** The one seam a sandbox would be written at, and what drivers substitute. */
  runtime?: PluginRuntime;
  /**
   * This daemon's clock.
   *
   * What it decides is the `installedAt`/`updatedAt` a row is stamped with, and
   * nothing else — it used to claim it was how a driver ages a restart backoff,
   * which it never was. See {@link PluginScheduler}, which is.
   */
  now?: () => number;
  /** How a restart backoff is waited out. See {@link PluginScheduler}. */
  scheduler?: PluginScheduler;
  /**
   * How the archive is fetched by {@link PluginHost.installFromSource}.
   *
   * The third seam in this file, and here for the reason the other two are:
   * `daemoncheck` has no network, and every refusal on that path — a 404, a
   * redirect, a body larger than a plugin may be, a commit whose manifest asks
   * for more than was consented to — has to be reachable without one.
   */
  fetchArchive?: ArchiveFetcher;
  /**
   * Where a plugin's own writes are stamped, so its own echo is not sent back.
   *
   * A seam for the same reason `runtime` and `scheduler` are: producing a claim
   * needs `ManagedSession.prompt` to answer `accepted`, which needs a live agent
   * — and the section of `daemoncheck` that drives hooks deliberately has none,
   * because it is driving the *announcement* rather than the agent. Handed one it
   * can write to, that driver reaches the suppression end to end. Production
   * passes nothing and gets its own.
   */
  origins?: PluginOrigins;
  /**
   * The two deadlines, overridable.
   *
   * Injected for one reason: a start that never happens and an invocation that is
   * never answered are the paths most worth driving, and at ten seconds each a
   * driver that walked them honestly would add most of a minute to `pnpm check`.
   * The production numbers are the defaults and nothing but a driver passes
   * anything else — this is not configuration, and there is no environment
   * variable for it.
   */
  timeouts?: { start?: number; invoke?: number };
}

export class PluginHost {
  /**
   * The plugin root, **realpath'd once at open**.
   *
   * ⚠ Not a tidying. `containedIn` resolves both sides and falls back to
   * comparing as written when `realpath` throws — which it does for every path
   * about to be *created*. So an unresolved root and a not-yet-existing target
   * land in two different namespaces and the guard refuses its own directory:
   * measured on macOS, where `/var` is a symlink to `/private/var`, `discard`
   * declined to remove `…/plugins/board/0.1.0` on every reinstall and the
   * following `rename` then failed `ENOTEMPTY`. This is the same fix
   * `createWorkspace` records for `outside_worktree_root`, and the rule is the one
   * `files-paths-git.md` states: the two sides must be in the same namespace.
   *
   * Safe to resolve synchronously because it is a directory this daemon has just
   * created — the rule about bounding filesystem calls is about paths somebody
   * else named.
   */
  private root: string;
  private readonly live = new Map<string, LivePlugin>();
  private readonly api: PluginApi;
  /**
   * Who caused what, so that {@link PluginHost.fan} can leave one plugin out.
   *
   * See `origin.ts`: this holds the *turn* claims only. A session's origin is an
   * argument to `SessionRegistry.create` and is spent by the announcement.
   */
  private readonly origins: PluginOrigins;
  private readonly watching = new Map<string, () => void>();
  private unwatch: (() => void) | null = null;
  /**
   * One mutation at a time, for the whole daemon.
   *
   * Q7.97's argument for `POST /fs/import`, unchanged: this is a route with **no
   * accounting that outlives the request**. An installed plugin is charged against
   * nothing once it has landed, and the relay allows 256 concurrent streams — so a
   * per-request size cap cannot see what a hundred of them do to a disk. The bound
   * has to be on arrival, and a person installs a plugin about as often as they
   * install anything.
   *
   * ⚠ **Held by every mutation, not only by `install`, and the name says so
   * now.** It was `installing`, and it guarded installs against each other while
   * leaving `remove` and `setEnabled` free to run straight through one: measured,
   * a `DELETE` landing while a `POST /plugins` for the same id was still reading
   * its body dropped the row and every `plugin_data` key, and the install then
   * re-created the row and left the plugin installed and running with its data
   * gone for good — the operator holding a "Removed" toast for a plugin that is
   * still there, and a `201 Installed` for what was an update, because `existing`
   * had been captured before the removal. Both routes are `machine:admin`, so two
   * tabs is the whole of the setup, and the window is however long an archive
   * takes over the relay. The old name is what made `this.installing` inside
   * `setEnabled` twenty lines of comment away from being readable at all.
   */
  private mutating = false;
  /**
   * The shutdown, once one has been asked for. See {@link shutdown}.
   *
   * A promise rather than a flag because the two facts a caller needs are "has one
   * been asked for" and "is it finished", and a boolean only ever carried the
   * first. {@link shuttingDown} is the first; awaiting this is the second.
   */
  private stopped: Promise<void> | null = null;

  private constructor(readonly options: PluginHostOptions) {
    this.root = options.root;
    // Before the API is built, because the API is what writes into it.
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
    // Before a single record is read, so nothing below is deciding anything about
    // a tree that was already garbage. See {@link sweepStaleStaging}.
    await host.sweepStaleStaging();
    for (const record of options.records.list()) {
      host.live.set(record.id, new LivePlugin(record, host));
    }
    /*
     * Watched before anything is started, so a plugin coming up during the boot
     * pass cannot miss the sessions that pass is resuming.
     */
    host.unwatch = options.registry.watchSessions((managed, arrival, origin) => host.observe(managed, arrival, origin));
    // `null`: the boot pass is not an act anybody performed, and `restored` fans
    // no `session.created` anyway.
    for (const managed of options.registry.list()) host.observe(managed, "restored", null);
    for (const plugin of host.live.values()) {
      /*
       * ⚠ **Seeded, for `install`'s reason and in `install`'s words.** The boot
       * pass above calls `observe(managed, "restored")`, and `observe` only fans
       * `session.created` for `arrival === "created"` — so a plugin that was
       * already installed when the daemon came up was told about none of the
       * sessions the registry had just restored, while the same plugin installed
       * a second later got every one of them through `seed`. "A board installed
       * on a working machine is empty until somebody starts something" is exactly
       * the boot case, and this was the path that did not pay it. `daemoncheck`
       * could not see it because it installs *after* restore, which is the seed
       * path rather than this one.
       */
      plugin.seed(options.registry.list());
      // Not awaited: a plugin that will not start must not hold up the daemon's
      // own start, which `deploy.sh` is polling `/health` for.
      if (plugin.record.enabled) void plugin.ensureStarted("supervised");
    }
    return host;
  }

  get pluginRoot(): string {
    return this.root;
  }

  /**
   * Something an operator would want to know, and nothing this can fail on.
   *
   * ⚠ **The sink is guarded because this is the reporter of last resort.** In
   * production `onWarning` is `scripts/daemon.ts` writing to stderr, and a write
   * to a stderr some supervisor has closed throws EPIPE. Every interesting caller
   * here is already inside a `catch` — the hook guards in {@link observe}, the
   * drop counter in `deliver`, `discard`'s two refusals — so a throw out of the
   * reporting would come straight back out of the guard that called it and undo
   * the thing the guard exists to guarantee. A report that is lost is worse than
   * nothing exactly once; a reporter that can take down its caller is worse than
   * nothing every time.
   */
  warn(detail: string): void {
    try {
      this.options.onWarning?.(detail);
    } catch {
      // There is no second way to say anything from here, which is the whole
      // reason this is empty rather than escalating.
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

  /**
   * Take an archive off the wire and make it a plugin.
   *
   * The ordering is the safety, and each step exists because the one before it can
   * fail:
   *
   *   1. A staging directory **inside the plugin root**, so the final `rename` is
   *      within one filesystem by construction. Everything below it is a path this
   *      daemon created, which is what allows ordinary filesystem calls here at all.
   *   2. Unpacked by the same reader `POST /fs/import` uses, under `PLUGIN_LIMITS`.
   *      One unpacker, one containment rule, two bound sets.
   *   3. The manifest is read and validated **before anything is moved**.
   *   4. The old process is stopped, the new directory published by one `rename`,
   *      the row written, the new process started.
   *   5. **If the new one will not start, everything goes back**: the new directory
   *      is removed, the row is left untouched, the old version starts again, and
   *      the refusal carries what the child said. An update that breaks a plugin
   *      must not also uninstall it.
   */
  async install(request: {
    body: ReadableStream<Uint8Array>;
    name: string;
    /** Where the bytes came from, when they were fetched rather than uploaded. */
    source?: PluginSource;
    /**
     * What the person installing was shown, when anybody was shown anything.
     *
     * `undefined` on the upload path, where the browser read the archive itself
     * and `consentBroken` checks the answer afterwards. Set on the source path,
     * where nothing local ever opened the archive — see the check below.
     */
    consent?: PluginConsent;
  }): Promise<InstallOutcome> {
    // See {@link shuttingDown}: refused before the body is read, and the body is
    // cancelled on the way out like every other refusal this route makes.
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
    /** The tree that was there, moved out of the way until the new one is proven. */
    let aside: string | null = null;
    /**
     * The plugin this call put into `live`, so the catch can take it out again.
     *
     * Hoisted because `record` and `plugin` are `const`s inside the `try` and the
     * catch cannot see either — which is exactly how the catch came to have only
     * the update arm of a restore that needs two.
     */
    let planted: LivePlugin | null = null;
    /** Where the new tree lands. Hoisted so the catch can put `aside` back at it. */
    let target: string | null = null;
    let existing: LivePlugin | null = null;
    /** Whether the row was written, so the catch knows whether it owes one back. */
    let wrote = false;
    /**
     * Whether a row for this id existed before this install wrote one.
     *
     * ⚠ **Hoisted for the catch, and asked of the record store rather than of
     * `live`.** The rollback uses it to tell a *first* install from an update, and
     * it used `existing` — which comes from `this.live`, which `open()` fills only
     * from the rows `records.list()` could turn back into records. A row this build
     * cannot validate is skipped, so `existing` reads `null` over a plugin that is
     * very much installed, and the rollback then deleted its data as though there
     * had never been any. `installed()` — what `remove` consults before it destroys
     * anything — asks `records.has` first, and this is the destructive path, so it
     * gets the same authority rather than the weaker one.
     */
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

      /*
       * ⚠ **Before anything is moved and before anything is started, which is the
       * whole of what makes it consent rather than a notification.**
       *
       * On the upload path the browser opened the archive itself and
       * `consentBroken` compares the answer afterwards — a check the person is
       * shown *after* a plugin has already run once, and `PluginsPanel` says so
       * out loud. That is tolerable there because the reader they are relying on
       * read the very bytes that were sent.
       *
       * Here nothing local ever opened the archive: the browser read a
       * `plugin.json` from `raw.githubusercontent.com` at this commit and this
       * daemon fetched a tarball of the same commit, and while those are the same
       * object by construction, "by construction" is not a check. So this one
       * refuses rather than reports, and it refuses early enough that the plugin
       * has not been started.
       *
       * See {@link consentGap} for why it compares three fields and not the
       * manifest — the short version is that `parseManifest` normalises, so a
       * field-by-field check would fire on healthy plugins and teach everybody to
       * click through it.
       */
      if (request.consent !== undefined) {
        const gap = consentGap(request.consent, manifest);
        if (gap !== null) return refuse("plugin_consent_broken", gap);
      }

      existing = this.live.get(manifest.id) ?? null;
      const replaced = existing?.record.version ?? null;
      const wanted = existing?.record.enabled ?? true;
      // Stopped before the directory it runs out of is replaced. Swapping code
      // under a live child is not a correctness problem on POSIX, but a plugin
      // whose files changed mid-run is one nobody can reason about.
      if (existing !== null) await existing.stop();

      target = join(this.root, manifest.id, manifest.version);
      await mkdir(join(this.root, manifest.id), { mode: 0o700, recursive: true });
      /*
       * ⚠ **What is there is moved aside, never discarded, until the new build is
       * proven.** Reinstalling the same version is how somebody iterates on a
       * plugin they are writing — and there `target` *is* the directory the
       * running plugin came out of, so clearing it first meant a broken build
       * destroyed the working one: the rollback below then restarted `existing`
       * against a path that no longer existed, and the row went on naming a
       * version whose directory was gone. `.replaced-` rather than a swap through
       * a third name because the only reader of either is this function.
       */
      const there = await probeExists(target);
      if (there === null) {
        /*
         * Thrown rather than returned, because `existing` has already been
         * stopped by this point and only the catch below puts it back. A plain
         * `refuse` here left the machine with the incumbent stopped and — since a
         * `view` and an `action` are both passive — nothing an HTTP caller could
         * do to start it again. The catch answers `plugin_write_failed` with this
         * same message, so what reaches the client is unchanged.
         */
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
        /*
         * `true` for the length of the proof below, and put back immediately
         * after — `ensureStarted` answers "this plugin is switched off" rather
         * than starting, and a build nobody started is a build nobody checked.
         * `wanted` is what somebody actually left the switch at: an update
         * inherits it, a fresh install is on. Re-enabling somebody's disabled
         * plugin because they updated it would be this daemon deciding something
         * on their behalf.
         */
        enabled: true,
        installedAt: existing?.record.installedAt ?? now,
        updatedAt: now,
        /*
         * Where it came from, written and never read for a decision — the
         * filename on the upload path, and the pinned commit on the source path,
         * which is the one somebody would actually want to look up later.
         */
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
      /*
       * ⚠ **Proven whatever `enabled` says.** A disabled plugin used to skip this
       * block outright, so an update to one was committed without the new build
       * ever having run: the row was rewritten, the previous version's directory
       * removed, and re-enabling it was the first anybody heard that it was
       * broken — with nothing left to go back to. Starting it for the length of
       * an install somebody is sitting in front of is the smaller surprise, and
       * it is put back the way they left it two lines down.
       */
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
          // The budget is returned before it is started again: being stopped so
          // that somebody else's update could be tried is not one of this
          // plugin's three failures, and spending one here would mean a person
          // pushing three broken updates ends up with a working plugin that will
          // no longer start.
          existing.resetBudget();
          void existing.ensureStarted("supervised");
        } else {
          this.live.delete(record.id);
          // A fresh install that failed leaves nothing, including the directory
          // `mkdir` made to hold the version. Left behind, it is what {@link
          // installed}'s second half reads as a plugin to be got rid of — so
          // `remove` of an id nobody had ever installed answered `true`.
          await this.discard(join(this.root, manifest.id));
        }
        return refuse("plugin_start_failed", failure);
      }
      if (!wanted) {
        // Proven, then put back the way they left it — before the row is written,
        // so nothing can observe the switch in the position it was only borrowed in.
        await plugin.stop();
        record.enabled = false;
      }

      // Before the write that makes the question unanswerable. See its declaration.
      hadRow = this.options.records.has(manifest.id);
      this.options.records.put(record);
      wrote = true;
      if (replaced !== null && replaced !== record.version) {
        await this.discard(join(this.root, manifest.id, replaced));
      }
      // Every session this daemon already knows about, offered to a plugin that
      // has only just arrived. Without it a board installed on a working machine
      // is empty until somebody starts something.
      plugin.seed(this.options.registry.list());
      /*
       * ⚠ **Stopped a second time, because the first stop is a window the
       * incumbent can come back through.** `existing` left `this.live` well above,
       * but between the stop at the top of this function and that swap it was
       * still being handed hooks — and `deliver`'s drain starts a plugin it finds
       * not running. So the plugin this update replaces could be on its feet again
       * with a fresh child, running out of a directory this function has since
       * renamed, while nothing holds a reference to it any more: `shutdown()`
       * iterates `live`, and `existing` is not in it. `stop()` is memoised **per
       * launch** — it compares `stopGeneration` against `generation`, and nothing
       * clears `stopping` — so this is the already-settled promise when nothing
       * restarted, and a real stop when something did.
       */
      if (existing !== null) await existing.stop();
      /*
       * ⚠ **The way back, destroyed last — after every statement that can throw
       * and after the incumbent is certainly down.** It used to run immediately
       * after `records.put`, with three fallible statements behind it, and both
       * halves of that were wrong.
       *
       * **The rollback half.** `target` carries the version, so `aside` is
       * non-null on exactly one path: reinstalling the version already there,
       * which is the documented way somebody iterates on a plugin they are
       * writing. On that path `aside` *is* the running plugin's directory and
       * `published` is the same path — so a throw from `discard`, from `seed`
       * (which the catch's own docblock names as a real source) or from the stop
       * above ran a catch that discarded the new tree and then found `aside`
       * already gone. Both trees lost, the row naming a directory that is not
       * there, and the plugin permanently failed. The catch's order —
       * `discard(published)` and *then* `rename(aside, target)` — was always
       * right; it just had nothing left to put back.
       *
       * **The live-process half, which is independent of any throw.** The
       * docblock above this line is about the incumbent coming back through
       * `deliver`'s drain between the first stop and the swap. If it did, it is
       * running out of the tree `rename` moved to `aside` — and deleting that
       * while a child is executing from it is its own defect, whether or not
       * anything fails afterwards. Hence *after* `existing.stop()` specifically,
       * rather than merely later.
       *
       * The cost is the whole of it: the old tree occupies disk for a few
       * milliseconds more. Nothing reads it in that window, and on POSIX the
       * rename never disturbed the descriptors the child already holds.
       */
      if (aside !== null) {
        await this.discard(aside);
        aside = null;
      }
      return { kind: "ok", summary: plugin.summary(), replaced };
    } catch (error) {
      /*
       * ⚠ **The same restore the `plugin_start_failed` path makes — and it needs
       * *both* of that path's arms.** A throw after the row was written
       * (`records.put` on a busy database, `seed` over a registry being torn down)
       * used to delete the published tree and leave the new `LivePlugin` running
       * out of it, in `live`, with the row naming whichever version won the race.
       *
       * The update arm was written first and the fresh-install arm was missing,
       * which is worse rather than milder: measured, a *first* install that threw
       * answered `503 plugin_write_failed` while `host.list()` reported the plugin
       * `running` and `records.has` reported no row at all — so `GET /plugins`
       * lied until the next restart, at which point the plugin silently vanished.
       *
       * Stopped before anything is removed, because the child is running out of
       * the tree the next line deletes.
       */
      if (planted !== null) await planted.stop();
      /*
       * ⚠ **The row, restored on the same two arms as `live`.** `records.put`
       * happens above and three statements that can throw follow it — `discard`
       * on a busy filesystem, twice, and `seed` over a registry being torn down.
       * Everything below restored the *filesystem* and the *running set* and left
       * the durable row naming whatever the failed attempt had written, which is
       * the same divergence this block's own docblock says it was added to fix,
       * one layer down: on an update the row named a version whose tree the lines
       * above had already discarded, so the next boot resolved a `server.js` that
       * was not there and the plugin was permanently failed; on a fresh install
       * the row survived a `503`, and a plugin nobody could see appeared out of
       * nowhere at the next restart. `remove` and `put` are both synchronous, so
       * neither can throw a second time from here.
       */
      if (wrote) {
        if (existing !== null) this.options.records.put(existing.record);
        else if (planted !== null) {
          this.options.records.remove(planted.record.id);
          /*
           * ⚠ **Paired with the row, which is what `remove` does and this did
           * not.** `doRemove` writes these two together and says why: "Its data
           * goes with it, and only here." This arm was the second `records.remove`
           * in the file and the only unpaired one — and unpaired here is
           * permanent, because afterwards `installed()` is false on both halves
           * (no row, and the directory below is gone), so `DELETE /plugins/:id`
           * answers 404 and nothing can ever reach `dropPlugin` again. The keys
           * then reappear under the next install of the same id, since
           * `plugin_data` is keyed by id rather than by version — deliberately, so
           * that an update keeps them.
           *
           * Safe for the reason that same comment gives from the other side: "an
           * update keeps the data — that is what makes it an update." A **first**
           * install that failed is not an update; before it there was no data of
           * this id to keep. Deliberately not added to the `existing !== null`
           * arm, where the plugin really is being updated.
           *
           * ⚠ **And "first" is `hadRow` rather than `existing === null`.** See
           * where it is captured, above `records.put`: the two disagree exactly
           * when a row exists that this build cannot read back — a plugin
           * declaring a newer `api` after a daemon downgrade, which is the state
           * `remove`'s own docblock names as reachable. On that path `existing`
           * reads `null` over a plugin that is installed, this arm ran, and an
           * install that **failed** destroyed the incumbent's data. `installed()`
           * asks `records.has` before it destroys anything; so does this now.
           */
          if (!hadRow) this.options.data.dropPlugin(planted.record.id);
        }
      }
      if (published !== null) await this.discard(published);
      /*
       * ⚠ **A rollback that could not roll back used to be a `warn` and nothing
       * else, and the two statements after it then made the machine lie.** The
       * row was restored, naming `<id>/<version>`; the tree was still sitting at
       * `<version>.replaced-…`; and `ensureStarted` forked a child against an
       * entry point that is not there — so `GET /plugins` showed a plugin
       * `running` for as long as the fork took, then `failed` with `Cannot find
       * module`, a sentence about Node's resolver rather than about what this
       * daemon did. Nothing anywhere named the tree that was left, and the person
       * reading the row had no way to reach the one that would have said so.
       *
       * Captured as a pair rather than as a flag because the sentence below needs
       * both paths, and `aside`/`target` are the hoisted `let`s the rest of this
       * catch is still narrowing. Where there is no `existing` to tell, the tree is
       * removed with the id directory two arms down — and where there is neither,
       * it is what {@link sweepStaleStaging} collects at the next boot.
       */
      const putBack = aside !== null && target !== null ? { from: aside, to: target } : null;
      /** `null` once the incumbent's tree is back where its row says it is. */
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
          /*
           * ⚠ **The row is kept and made honest rather than dropped, and it is
           * not started.** Both halves are the choice.
           *
           * *Kept*, because the row is the only thing on this machine that can
           * say any of this. Removing it would leave a plugin whose files are
           * demonstrably still under the root with nothing in `GET /plugins`
           * naming it — the state {@link installed}'s second half exists to mop up
           * — and the whole of what somebody would be told is one `onWarning` line
           * in a log they are not reading. `remove` still works either way, so
           * keeping it costs nothing and buys the sentence.
           *
           * *Failed rather than started*, because `entryFor` resolves
           * `<id>/<version>/server.js` and that is exactly the path the `rename`
           * just failed to produce. `fail()` is what this file already uses to
           * say "this plugin is not runnable, and here is why"; the sentence names
           * both paths, so the tree is findable from the row rather than only from
           * a shell. `drain` holds a `failed` plugin rather than restarting it,
           * and `setEnabled(true)` is still the way to ask for another attempt
           * once somebody has moved the directory back by hand.
           *
           * The budget is deliberately **not** returned here, unlike the arm
           * below: there is nothing to spend it on.
           */
          existing.markFailed(
            `this plugin's files could not be put back at ${unrestored.to} after a failed update, and are at ${unrestored.from}`,
          );
        } else {
          existing.resetBudget();
          void existing.ensureStarted("supervised");
        }
      } else if (planted !== null) {
        // Nothing was here before this call, so nothing is what it leaves —
        // symmetric with the `plugin_start_failed` path's own `else`, down to
        // removing the directory `mkdir` made to hold the version.
        if (this.live.get(planted.record.id) === planted) this.live.delete(planted.record.id);
        await this.discard(join(this.root, planted.record.id));
      }
      if (error instanceof ArchiveError) return refuse(archiveCode(error), error.message);
      return refuse("plugin_write_failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.mutating = false;
      // Both on every path, and the body first. A refusal that stops reading parks
      // the sender against the relay's window, and the valve after that closes the
      // whole tunnel for this machine rather than this one request.
      await cancel(request.body);
      await this.discard(staging);
    }
  }

  /**
   * Install a plugin this daemon fetches for itself, from a pinned commit.
   *
   * **A thin front on {@link install} and deliberately nothing more.** The
   * staging directory, the unpacker, the manifest root rule, the `rename`
   * publish and the whole rollback are the same code — a second implementation
   * of that sequence is how one of them comes to be missing the step that puts
   * the old tree back, which is a defect this file has already had once and
   * records at length. What is new here is exactly two things: where the bytes
   * come from, and the consent check {@link install} performs on their behalf.
   *
   * The {@link mutating} mutex is asked **twice on purpose**, which is also why
   * neither of these two goes through {@link exclusive}. Once here, before a
   * fetch, so a machine already installing something refuses in a millisecond
   * instead of downloading two megabytes to be told; and once inside `install`,
   * which is the authoritative one and is where the claim is actually made. The
   * gap between them is a race that costs a wasted download and nothing else — the
   * second check is what keeps installs serialised. A helper that checks and
   * claims in one act cannot express a check that deliberately claims nothing.
   */
  async installFromSource(source: PluginSource, consent: PluginConsent | null): Promise<InstallOutcome> {
    // Refused before the fetch as well as before the install, for the reason the
    // {@link mutating} check below is asked twice. See {@link shuttingDown}.
    if (this.shuttingDown) return refuse("shutting_down", "the daemon is shutting down");
    if (this.mutating) return { kind: "busy" };

    const fetched = await fetchArchive(source, this.options.fetchArchive ?? REAL_ARCHIVE_FETCHER);
    if (isSourceRefusal(fetched)) return refuse(fetched.code, fetched.message);
    try {
      return await this.install({
        body: fetched.body,
        // The name is a label on the row and this path has a better one, so it is
        // left empty rather than invented — `sourceLabel` is what gets written.
        name: "",
        source,
        ...(consent === null ? {} : { consent }),
      });
    } finally {
      // The deadline, released on every path. `install`'s own `finally` cancels
      // the body; this is the timer that would otherwise hold the process's event
      // loop open for the rest of its window after a fast install.
      fetched.done();
    }
  }

  /**
   * Uninstall, whether or not this build can read what it is uninstalling.
   *
   * ⚠ **The fall-through to the store is the whole of this, and it closes a row
   * that could not be got rid of by any means this daemon offered.**
   * `SqlitePluginRecordStore.toRecord` skips a row whose `manifest_json` this
   * build cannot validate — reported through `onDegraded`, and reachable by
   * nothing more exotic than a downgrade: install a plugin declaring `api: 2`,
   * roll the daemon back to a build whose `PLUGIN_API_VERSION` is 1, and
   * `negotiatePluginApi` answers `too_new`. `list()` then omits it, `open` never
   * builds a `LivePlugin` for it, and a `remove` that consulted only `this.live`
   * answered `false` — so `DELETE /plugins/:id` returned 404 and the row, its
   * `plugin_data` and its directory stayed on the machine for good. The one kind
   * of plugin somebody most wants gone was the one kind that required opening the
   * database by hand.
   *
   * **What answers that question is the row itself**, through
   * `PluginRecordStore.has` — a `SELECT 1` that parses nothing, so an unreadable
   * row is still a row. It used to be the *directory*, and that was a stand-in
   * rather than an answer: `list` and `get` both report `null` for a row they
   * cannot parse, so neither could tell "nobody ever installed this" from
   * "installed here, and unreadable by this build", and a directory is a different
   * fact that outlives a row. See {@link installed} for what the directory is
   * still worth.
   */
  async remove(id: string): Promise<boolean | "busy"> {
    /*
     * Held rather than merely read, and for this route the difference is the whole
     * fix: reading it would still leave a `remove` that started first free to
     * finish *underneath* an install that started second — this method's first act
     * drops the plugin from `live`, so that install captures `existing` as `null`,
     * lands a fresh row and tree, and then this method resumes past its await and
     * deletes both. Holding it for the length of the removal is what makes the two
     * orderings the same one. See {@link exclusive}.
     */
    return this.exclusive(() => this.doRemove(id));
  }

  /**
   * Run one mutation, or say the machine is busy with another.
   *
   * ⚠ **The two checks and the `try`/`finally` were written out twice, verbatim,
   * and a claim that exists in two copies is a claim one of them will be missing.**
   * That is not hypothetical for this particular one: {@link mutating} had exactly
   * one copy when it was called `installing`, `remove` and `setEnabled` had none,
   * and the measured cost is on that field's own docblock. What is left out of the
   * helper deliberately is {@link install} and {@link installFromSource}, whose
   * two-stage check is a *check that claims nothing* — see the second's docblock.
   *
   * Refused rather than queued: the caller is a person who can press it again, and
   * holding a `DELETE` open behind a 2 MiB upload is a worse answer than telling
   * them what the machine is doing. `"busy"` covers a shutdown as well as a rival
   * mutation, because at the moment a machine is going away "try again" is exactly
   * as true as it is for the other one — see {@link shuttingDown} for why the
   * refusal is owed at all.
   */
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

  private async doRemove(id: string): Promise<boolean> {
    const plugin = this.live.get(id);
    if (plugin !== undefined) {
      /*
       * ⚠ **Both of these happen *before* the await, and that is the whole of
       * it.** `stop()` is not instantaneous — a child that traps SIGTERM holds it
       * for `PLUGIN_STOP_DEADLINE_MS` — and for the length of that await the
       * plugin was still in `live` and still `enabled`, so `fan` reached it,
       * `wants` said yes, and `drain` found it not running and called
       * `ensureStarted`. One `turn.ended` in that window forked a child that this
       * function then walked away from: `live` no longer holds it, `shutdown`
       * iterates `live`, and the row, the data and the tree are all gone — while
       * the child keeps its declared scopes and its IPC channel to `callApi`, and
       * its `store.set` re-creates the very `plugin_data` rows `dropPlugin` is
       * about to delete. A second `remove` cannot reach it either, because there
       * is nothing left for `installed` to find.
       *
       * `install` defends against this same window with a trailing second stop
       * and twelve lines saying why, and `setEnabled` defends against it by
       * writing `enabled` before it awaits. This was the one of the three with
       * neither.
       */
      plugin.record.enabled = false;
      this.live.delete(id);
      await plugin.stop();
    } else if (!(await this.installed(id))) {
      return false;
    }
    this.options.records.remove(id);
    // Its data goes with it, and only here. An update keeps the data — that is
    // what makes it an update — while an uninstall is somebody saying they are
    // finished, and a board whose cards outlive the board is litter nothing will
    // ever collect.
    this.options.data.dropPlugin(id);
    /*
     * ⚠ **The one caller that may not carry on past a failed `rm`.** The row and
     * the data are gone by this line, so answering `true` over a tree that is
     * still there is not a small inaccuracy: `installed()`'s directory half then
     * reads it as installed for ever, and every later `DELETE /plugins/:id`
     * answers `removed: true` while removing nothing — and `<root>/<id>` matches
     * neither staging pattern, so no sweep will collect it. Thrown rather than
     * answered `false`, because `false` is this method's word for *there was
     * nothing here*, which is the opposite of what happened. The caller gets the
     * 500 it used to get before {@link discard} stopped throwing; what changed is
     * that the rollback paths no longer get one.
     */
    if (!(await this.discard(join(this.root, id)))) {
      throw new Error(`${id} was removed from this daemon's records, but its files at ${join(this.root, id)} could not be`);
    }
    return true;
  }

  /**
   * Whether anything under this id is this daemon's to get rid of.
   *
   * **The row is the authority and the directory is the mop**, and the second half
   * is not belt-and-braces. A tree with no row is what an interrupted install or
   * an older build leaves behind, and it is reachable by no other route this
   * daemon offers — `list` never showed it, so nothing can be enabled, viewed or
   * updated to reach it. Making the row the only authority would therefore have
   * reproduced the defect {@link remove} exists to close, one layer down: a thing
   * on the machine that only a shell can remove. `has` is asked first because it
   * costs nothing, which is also what keeps the ordinary "no such plugin" answer
   * free of a `stat` on a path somebody put in a URL.
   *
   * ⚠ `id` is a path segment out of a URL, so it is contained **before** it is
   * probed rather than after — `discard` would refuse it anyway, but a refusal
   * reached through a `probeExists` on `<root>/../../etc` is a filesystem call
   * this daemon made on a path somebody else named, which is the one thing
   * `files-paths-git.md` says not to do. `containedIn` also rejects the root
   * itself, which is what an empty id resolves to. A `null` from `probeExists` —
   * the filesystem did not answer — is read as "no", which is `discard`'s own
   * rule: a remover that treats "I do not know" as "it is not there" is a remover
   * acting on a path it knows nothing about.
   */
  private async installed(id: string): Promise<boolean> {
    if (this.options.records.has(id)) return true;
    const directory = join(this.root, id);
    if (!containedIn(directory, this.root)) return false;
    return (await probeExists(directory)) === true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginSummary | null | "busy"> {
    // Held for this route's own reason: an update stops and restarts the plugin,
    // so a switch thrown across one lands on whichever `LivePlugin` happens to be
    // current. See {@link exclusive}.
    return this.exclusive(() => this.doSetEnabled(id, enabled));
  }

  private async doSetEnabled(id: string, enabled: boolean): Promise<PluginSummary | null> {
    const plugin = this.live.get(id);
    if (plugin === undefined) return null;
    plugin.record.enabled = enabled;
    this.options.records.setEnabled(id, enabled, this.clock());
    if (enabled) {
      // Switching it back on is new information, exactly as a restart is for
      // auto-resume, so the budget it exhausted is returned.
      plugin.resetBudget();
      await plugin.ensureStarted("supervised");
    } else {
      await plugin.stop();
    }
    return plugin.summary();
  }

  /**
   * Directories a previous install did not live to clean up, removed at boot.
   *
   * ⚠ **`install`'s `finally` is exactly what an OOM and a `SIGKILL` do not
   * reach**, and this file took `importArchive`'s staging pattern without taking
   * the sweeper that answers it — `archive.ts` states the argument at its own
   * `sweepStaleStaging` and had it first, for the same reason. Every daemon
   * killed mid-install left a `.reemoat-plugin-…` holding up to
   * `PLUGIN_LIMITS.maxBytes` of `archive.bin` plus up to eight megabytes of
   * unpacked tree, and **nothing on this side collected it**: {@link open} builds
   * `live` from the record store rather than by walking the root, {@link list}
   * never sees it, and {@link installed} probes `join(root, id)` for an id
   * `manifest.ts` will not let begin with a dot. A `<version>.replaced-…` has the
   * same standing, and now has a second producer as well as a crash — see the
   * failed-rollback arm of {@link install}, which leaves one deliberately rather
   * than lying about where the tree is.
   *
   * **On the way in rather than on a timer, and that is available here where it
   * was not there.** `importArchive` stages inside the *target*, an arbitrary
   * folder this daemon learns about only when somebody names it, so there is no
   * set of places a timer could walk and the next import is the one moment the
   * path is known again. The plugin root is a directory this daemon owns and
   * created; boot is both a moment it knows the path and the one moment nothing
   * is running and no install is in flight.
   *
   * Three narrowings, `archive.ts`'s three, because this removes without a record
   * telling it to: the name must be exactly what this file generates, `lstat`
   * must say directory — so a symlink wearing the name is neither followed nor
   * removed — and it must be old enough that no live install could own it.
   * Failure is silent throughout; litter must never be the reason a machine comes
   * up without its plugins.
   */
  private async sweepStaleStaging(): Promise<void> {
    const cutoff = Date.now() - STALE_STAGING_MS;
    /**
     * One candidate, weighed and removed.
     *
     * `lstat` rather than {@link probeExists}, which is what `discard` asks: the
     * question here is not "is something there" but "is this a *directory* rather
     * than a link wearing its name", and only `lstat` answers the second without
     * following it first. `containedIn` resolves both sides, so a name reached
     * through a link out of the root is refused by that line even when this one
     * is walked into.
     */
    const collect = async (full: string): Promise<void> => {
      try {
        const info = await lstat(full);
        if (!info.isDirectory()) return;
        if (info.mtimeMs > cutoff) return;
        if (!containedIn(full, this.root)) return;
        await rm(full, { recursive: true, force: true });
        this.warn(`removed ${full}, left behind by an install that did not finish`);
      } catch {
        // Removed by something else between the listing and the removal, or never
        // ours to touch. Neither is worth failing an open over.
      }
    };

    let top: string[];
    try {
      top = await readdir(this.root);
    } catch {
      // Unreadable, or gone between the `mkdir` above and here. Everything the
      // caller does next is about to fail on the same directory and say so.
      return;
    }
    for (const name of top) {
      if (STAGING_NAME.test(name)) {
        await collect(join(this.root, name));
        continue;
      }
      /*
       * ⚠ **The other one is two levels down, which is why this descends at
       * all.** Staging is `<root>/.reemoat-plugin-…`, but the tree a rollback
       * moves aside is `<root>/<id>/<version>.replaced-…` — so a sweep of the root
       * alone collects the larger of the two and leaves the one that holds a whole
       * working plugin. One level, and only into something `lstat` calls a
       * directory: a plugin's own files are below that, and none of this daemon's
       * names are written there.
       */
      const directory = join(this.root, name);
      let versions: string[];
      try {
        const info = await lstat(directory);
        if (!info.isDirectory()) continue;
        versions = await readdir(directory);
      } catch {
        // Gone, or not something this daemon can list. `installed` is what decides
        // whether anything under this root is a plugin; this only removes.
        continue;
      }
      for (const version of versions) {
        if (!REPLACED_NAME.test(version)) continue;
        await collect(join(directory, version));
      }
    }
  }

  /**
   * A directory under the plugin root, removed.
   *
   * Guarded by `containedIn` against that root, and refused outright when the path
   * could not be probed — which is `removeWorkspace`'s rule for the one `rmSync`
   * in this codebase, and this is the second remover. `null` from `probeExists` is
   * not "it is not there": it is "the filesystem did not answer", and a remover
   * that treats those as the same runs against a path it knows nothing about.
   */
  /**
   * Remove a tree this daemon put there, and say whether it is gone.
   *
   * ⚠ **The answer is load-bearing for exactly one of the eight callers.** The
   * rollback callers want warn-and-carry-on; `doRemove` may not, because it has
   * already dropped the row and the data by the time it gets here, and answering
   * `removed: true` over a tree still on disk is a claim the next call disproves:
   * `installed()` reads that directory and says the plugin is installed for ever,
   * while every `DELETE` answers `true` and removes nothing. The leftover is at
   * `<root>/<id>`, which matches neither {@link STAGING_NAME} nor
   * {@link REPLACED_NAME}, so no sweep collects it either.
   */
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
      /*
       * ⚠ **Reported rather than thrown, because four of this method's eight
       * callers are inside the `install` rollback and a throw there abandons the
       * rest of it.** `force: true` already swallows ENOENT, so what is left is
       * EPERM, EBUSY and EIO: a file somebody else has open, a mount going away
       * underneath, a disk answering badly.
       *
       * ⚠ **Measured, because the first version of this comment named the wrong
       * casualty.** It said the row restoration was what a throw here skipped. It
       * is not — `records.put(existing.record)` runs thirty lines *above*
       * `discard(published)`, and with a bare `rm` the row was still there. What a
       * throw actually skipped is everything *after*: the `rename(aside, target)`
       * that puts the incumbent's tree back, the `live.set(existing…)` that makes
       * it reachable again, and the `refuse(...)` that tells the caller which
       * failure it was. So the row named a version whose tree had been moved aside
       * and never moved back, and the caller got the filesystem's error instead of
       * the install's.
       *
       * This is what the two refusals above already do — a path outside the root
       * and a filesystem that will not answer are both warned and returned from.
       * The third was the odd one out and the only one reachable *during* a
       * rollback.
       */
      this.warn(`could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * One session, watched for the three things a hook is derived from.
   *
   * ⚠ **Derived, never forwarded.** A plugin is told `turn.ended`, not a
   * `StoredEvent` — the event union is the wire three agents move, and coupling a
   * plugin to it would make every ACP change somebody else's breaking change. What
   * crosses is a summary this daemon is willing to keep sending.
   *
   * ⚠ **Nothing here awaits.** `SessionLog.append` is synchronous by contract and
   * runs inside the agent's own RPC handler; a hook that blocked there would put a
   * plugin between an agent and its transcript. Deliveries are queued and drained
   * on their own.
   */
  private observe(managed: ManagedSession, arrival: "created" | "restored", origin: string | null): void {
    if (this.shuttingDown || this.watching.has(managed.id)) return;
    let ended = false;
    /**
     * A throw in either subscriber, reported and the subscription kept.
     *
     * ⚠ **This is `SessionRegistry.watchSessions`'s own argument, applied one
     * level below where it was actually needed.** That docblock says a throwing
     * observer must never be evicted, because the observer is a whole subsystem
     * rather than one WebSocket — and then guards only `announce`, which carries
     * `session.created` and nothing else. Everything that actually happens on a
     * machine arrives through the two subscriptions below, and both sit on
     * mechanisms that punish a throw: `SessionLog.append` **deletes** a listener
     * that throws, and `ManagedSession.touchSafe` deletes a watcher that does,
     * silently in the second case. There is exactly one such listener per session
     * and its unsub is recorded in `watching`, which `observe` reads as "already
     * handled" — so one throw out of `managed.snapshot()`, or out of a `warn`
     * whose stderr a supervisor has closed, permanently ended every plugin hook
     * for that session with nothing anywhere saying so, and no path back short of
     * restarting the daemon. Reported here instead, and the subscription lives.
     */
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
          /*
           * ⚠ **Taken here, before the fan, and whether or not anybody is
           * subscribed.** The claim names *this* turn: a plugin whose prompt
           * started it does not get the echo, and nothing later may inherit the
           * claim. Reading it inside the lazy payload builder would mean it was
           * spent only when somebody happened to be listening, which is how a
           * stale claim comes to suppress somebody else's turn an hour later.
           */
          const started = this.origins.takeTurn(managed.id);
          this.fan("turn.ended", () => ({ session: managed.snapshot(), stopReason: event.stopReason }), started);
        } else if (event.type === "permission_request") {
          /*
           * Unattributed on purpose. Nothing a plugin may call produces one of
           * these — an agent asks — so there is no write of its own to echo.
           */
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
          /*
           * `outcome` and `by` both cross, and neither is redundant. `outcome:
           * "selected"` means an option was chosen — **not** that permission was
           * granted — so a plugin counting approvals has to read `optionId`, which
           * is the same trap `permissionDecisions` exists to keep the transcript out
           * of. And `by` is what separates a person deciding from the daemon
           * sweeping a cancelled turn, which is the difference a plugin measuring
           * "how often do I approve this" is actually asking about.
           */
          /*
           * ⚠ **Deliberately not attributed, though `sessions.answerPermission`
           * does cause one.** The loop it makes ends by itself: a second answer to
           * the same question is refused as `already_answered` and nothing is
           * fanned for it. What suppression would cost is the one confirmation a
           * plugin has that its answer landed — and `by` cannot stand in for it,
           * because a plugin's answer is written as `"client"`, the same as a
           * person's.
           */
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
        /*
         * The terminal transition, reported once *per ending*. `exit` is what
         * makes a session over — `status` reads `interrupted` for one the daemon
         * is bringing back, and a plugin told that had ended would close a card
         * that is still open.
         *
         * ⚠ **Cleared on the way back, which is the half that was missing.**
         * `armForStart` sets `exitRecord = null` on every resume, so a session
         * that ends, is resumed, and ends again passes here three times — and a
         * latch that was only ever set reported the first of those and nothing
         * after it, for the life of the daemon. A plugin has no other terminal
         * signal (it is not told about the resume either), so from the second
         * ending onward it was simply wrong about that session. The latch is
         * still what stops one ending being reported twice; it is now a latch on
         * the *state* rather than on the session.
         */
        if (snapshot.exit === null) {
          ended = false;
          return;
        }
        if (ended) return;
        ended = true;
        /*
         * ⚠ **A claim on a session that is over names nothing.** A turn the agent
         * died inside never produces a `turn_end`, so nothing would spend it —
         * and it would then suppress the first turn of a session somebody
         * resumes, which is the blind spot this whole design exists to avoid.
         */
        this.origins.forget(snapshot.id);
        /*
         * Unattributed. `sessions.stop`'s loop ends by itself — `ended` latches
         * until the session is resumed, and stopping a terminal session fans
         * nothing — and a session ending is the last thing a plugin should be
         * made to miss.
         *
         * ⚠ **`sessions.create` is the case this does not close.** A create whose
         * `start()` throws is an exit, so the plugin that asked is told
         * `session.ended` about the session it just made; a handler answering that
         * by creating another loops. `MAX_LIVE_SESSIONS` does not bound it —
         * `liveSessionCount` skips terminal sessions — so what is left is
         * `SESSION_CREATE_BURST` throttling it, and a worktree left behind each
         * time round, since `create` deliberately leaves one on a failed start.
         * Bounding that needs a per-plugin create budget, which this is not.
         */
        this.fan("session.ended", () => ({ session: snapshot, exit: snapshot.exit }), null);
      }),
    );
    this.watching.set(managed.id, () => {
      unsubLog();
      unsubWatch();
    });
    if (arrival === "created") {
      /*
       * ⚠ **The origin came with the announcement rather than from a ledger**,
       * because this fan runs *inside* `SessionRegistry.create`: the plugin that
       * asked is still parked on its own `await` and could not have stamped
       * anything. Without this, a `session.created` handler calling
       * `ctx.sessions.create` makes sessions until `MAX_LIVE_SESSIONS`, each one a
       * worktree and an agent process.
       */
      this.fan("session.created", () => ({ session: managed.snapshot() }), origin);
    }
  }

  /**
   * A hook, to every plugin that asked for it.
   *
   * The payload is built lazily and **once per hook rather than once per plugin**,
   * because `snapshot()` copies arrays and the ordinary case is that nobody
   * subscribed at all. With no subscriber it is never built.
   */
  private fan(hook: PluginHook, payload: () => Record<string, unknown>, origin: string | null): void {
    let built: Record<string, unknown> | null = null;
    for (const plugin of this.live.values()) {
      /*
       * ⚠ **The one plugin not told is the one that caused it.**
       *
       * Compared against the id rather than against the object, which is what
       * makes this survive an update: `install` replaces the `LivePlugin` while
       * the id stays the same, so a claim made by the incumbent is still honoured
       * against the successor — the same plugin, by the only name this subsystem
       * has for one.
       */
      if (origin !== null && plugin.record.id === origin) continue;
      if (!plugin.wants(hook)) continue;
      built ??= payload();
      plugin.deliver(hook, { hook, ...built });
    }
  }

  /**
   * Whether this host has been shut down, as a refusal every mutator owes.
   *
   * ⚠ **`stopped` was written by {@link shutdown} and read by nothing but
   * `observe` and shutdown's own latch, so shutdown was not a barrier.** An
   * install accepted a moment earlier and still streaming its archive walked
   * straight through the drain below, renamed its tree, wrote its row and called
   * `ensureStarted` — forking a child *after* the drain, held by nothing, and
   * unreachable from a `shutdown` that has already latched itself idempotent.
   *
   * The route's own guard cannot cover that window: `registry.isShuttingDown` is
   * set inside `registry.shutdown()`, and `scripts/daemon.ts` runs this method
   * *first* — so it is false for the whole of it.
   *
   * `AgentAskRuns` reaches the same conclusion one file over and states it in
   * `admit`; this is that rule, applied to the subsystem that spawns the longer
   * lived process.
   */
  private get shuttingDown(): boolean {
    return this.stopped !== null;
  }

  /**
   * Every plugin on this machine, down — and the caller told once they are.
   *
   * ⚠ **`this.x ??= this.doX()`, this codebase's idiom, and the deviation it
   * replaces was behavioural rather than cosmetic.** This was an early-return
   * latch (`if (this.stopped) return; this.stopped = true;`), so a second
   * `await host.shutdown()` resolved *immediately* while the first was still
   * inside `plugin.stop()` on live children — a caller that awaited it had no
   * guarantee any child was down, which is the one guarantee this method exists to
   * make. `LivePlugin.stop` writes twelve lines about the same trap one class
   * down, and `runtime.ts` spells the idiom `this.stopping ??= this.doStop()`.
   *
   * ⚠ **The claim and `doShutdown`'s synchronous prefix are one job, which is what
   * makes {@link shuttingDown} a barrier despite `??=` assigning last.** `??=`
   * evaluates the right-hand side before it writes, so between the call and the
   * assignment `this.stopped` is still `null` — and nothing observes it there,
   * because everything `doShutdown` does before its first `await` is
   * synchronous and this runtime is one thread. A mutator can only ask after that
   * `await`, by which point the field is written.
   */
  shutdown(): Promise<void> {
    return (this.stopped ??= this.doShutdown());
  }

  private async doShutdown(): Promise<void> {
    this.unwatch?.();
    this.unwatch = null;
    for (const stop of this.watching.values()) stop();
    this.watching.clear();
    /*
     * ⚠ **A mutation in flight is waited out rather than raced, but only so far.**
     * {@link mutating} is held for the whole of an install, an update, a remove and
     * a switch, so waiting on it is the same barrier those four already agree on —
     * and draining `live` while one is between its `rename` and its `ensureStarted`
     * is exactly how a child outlives this call. The mutators refuse the moment
     * {@link shuttingDown} is true, so nothing new can be admitted while this
     * waits.
     *
     * ⚠ **What it may not do is wait forever, and the old loop had no bound at
     * all.** The act it is waiting on has no deadline of its own: `install` holds
     * the mutex across `unpackArchive`, whose `for await (const chunk of
     * request.body)` charges **bytes** and never charges **time**, so a client
     * trickling a two-megabyte archive one byte at a time holds this open for as
     * long as it likes. `scripts/daemon.ts` runs this method *before*
     * `registry.shutdown()` and `stores.close()`, under one 25 s hard exit — so an
     * unbounded wait here does not merely delay a shutdown, it spends somebody
     * else's budget and the process leaves with no session exit records written and
     * no WAL checkpoint.
     *
     * ⚠ **What the bound gives back is a narrow version of the thing the drain
     * exists to prevent, and it is the smaller of the two by a distance.** An
     * install that outlasts the deadline and then completes forks a child after
     * `live` has been drained, which no `stop()` here will reach — exactly what
     * {@link shuttingDown} describes. But that child is not `detached` and there is
     * no reaper: `runner.ts` exits when its IPC channel closes, and
     * `scripts/daemon.ts`'s `process.exit(0)` two lines later closes it. So the
     * escaped child dies with this process either way, while the sessions whose
     * exit records were never written stay wrong on disk until somebody reads a
     * transcript that ends in the middle. One stalled upload must not be able to
     * buy the second to avoid the first.
     */
    const deadline = Date.now() + SHUTDOWN_MUTATION_WAIT_MS;
    // `Date.now` rather than {@link PluginHostOptions.now}, whose docblock says it
    // decides `installedAt`/`updatedAt` and nothing else — a driver holding that
    // clock still would otherwise turn this bound back into the unbounded loop.
    while (this.mutating && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        // Unref'd like every other backstop timer here. A process whose last work
        // is waiting out a mutation must not be held open by the waiting itself.
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

/**
 * The production scheduler: real time, real jitter.
 *
 * Written out as the default rather than as `?? setTimeout` at the call site so
 * that the behaviour a driver replaces and the behaviour the fleet runs are the
 * same three lines, and nobody has to read `scheduleRestart` to find out what a
 * substituted scheduler is standing in for.
 */
const REAL_SCHEDULER: PluginScheduler = {
  wait(ms, fn) {
    const timer = setTimeout(fn, ms);
    // Unref'd like the other backstop timers here: a plugin waiting out a minute
    // of backoff must not be the thing keeping this process alive.
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  jitter: () => Math.random(),
};

/**
 * Why somebody wants this plugin running, and whether that is worth a start.
 *
 * ⚠ **A read may not spend the restart budget.** `GET /plugins/:id/views/:viewId`
 * is `read`-scoped — a grant that can look at a plugin's screen and press nothing
 * on it — and it reached `ensureStarted` like every other caller, so three
 * read-only GETs against a plugin that crashes on startup left it marked "failed
 * to start 3 times and will not be tried again", **permanently**: only
 * `machine:admin` puts the budget back, through `setEnabled`. `PluginScreen`
 * re-reads on a `refreshMs` interval, so the three arrive on their own within a
 * minute of somebody leaving the sheet open, and the plugin is then off until an
 * admin toggles it. The three failures the budget is counting are meant to be the
 * *plugin's*.
 *
 * So a `passive` caller joins a start already in flight and otherwise reports
 * whatever the row already says. It never originates one, and it never needs to:
 * `enabled` is true only where a supervised path — the boot pass, an install, the
 * switch, {@link LivePlugin.scheduleRestart} — has already decided this plugin
 * should be up, and bringing a crashed one back is that last one's job on its own
 * jittered schedule. What a passive caller gets during a backoff window is the
 * plugin's real failure sentence, which is what its row is showing anyway.
 */
type StartIntent = "supervised" | "passive";

/**
 * One plugin, and everything that can go wrong with it.
 *
 * Its whole job is that a plugin which is slow, broken, absent or hostile to its
 * own contract is a plugin whose *row says so* — never one that makes a screen
 * hang or the daemon quiet.
 */
class LivePlugin {
  state: PluginState = "stopped";
  failure: string | null = null;
  private process: PluginProcess | null = null;
  /**
   * Which launch this plugin is on. Counted from one, never reused.
   *
   * ⚠ **A callback has no other way to ask which child it came from, and without
   * that it acts on whichever child is current when it happens to fire.**
   * `onExit` and `onMessage` are closures made when one specific child was
   * forked; they fire arbitrarily later — a SIGTERM'd child has
   * `PLUGIN_STOP_GRACE_MS` before it is killed and the deadline beyond that, and
   * the window is at its widest exactly when the plugin is the kind that stops
   * answering — and everything here is free to have started a replacement in the
   * meantime. Three separate failures followed, each of them measured against
   * this file with a scripted runtime before this field existed:
   *
   *   - A stale `onExit` nulled `this.process` **over a live successor**, then
   *     `fail()`d a row whose plugin was answering and scheduled another restart
   *     on top. One `stop()`, one queued hook draining into `ensureStarted` and
   *     one late exit left **three** children alive, of which `shutdown()` could
   *     reach one: the other two hold an IPC channel, are sent nothing, and
   *     outlive every handle to them.
   *   - An answer to a *stale* child's API call was written to whichever child
   *     was current. The host echoes the child's own id and a child's id space
   *     restarts at 1 on every launch (`runner.ts`'s `nextCallId`), so the id was
   *     all that decided who got it: child A's `net.fetch` as id 5 crashed
   *     mid-flight, A came back as B, and B's own id 5 — a different method
   *     entirely — was settled with A's HTTP response body. Silent wrong data
   *     inside somebody's plugin, with nothing on any row saying so.
   *   - The crashed child's `pending` timers were left armed and fired against
   *     the successor, stopping it. Not a narrow race: the restart backoff starts
   *     at {@link RESTART_BASE_MS} and the deadline they are counting down is
   *     {@link PLUGIN_INVOKE_TIMEOUT_MS}, five times longer, so the replacement is
   *     normally up and answering before the old timers go off at all.
   *
   * Bumped once per launch in {@link doStart}, and every callback a launch makes
   * compares against it before touching anything this object shares.
   */
  private generation = 0;
  /**
   * What tells this launch's outstanding **host** calls that nobody is waiting.
   *
   * ⚠ **`settlePending` answers the calls going the other way, and there was no
   * equivalent for these.** A child that is stopped, disabled, updated or removed
   * has its inbound invocations settled and its timers disarmed — but a call *it*
   * made outward, which is the direction where a method spawns an agent, ran on
   * with nothing left to hand the answer to. `model.complete` allows two minutes
   * against the ten seconds an invocation gets, so the measured shape is a plugin
   * timed out at 10 s, stopped at the third of those, its row and tree deleted by
   * `remove` — and an agent subprocess still holding one of the two slots this
   * machine allows, for another 110 seconds.
   *
   * One per launch, replaced in {@link doStart} and aborted in {@link doStop}, so
   * a call carries the signal of the child that made it and a superseded
   * generation's abort cannot reach its successor's work. Captured at the call
   * site rather than re-read after an await, which is this class's standing rule
   * about `this.process`.
   */
  private hostCallsAbort = new AbortController();
  /**
   * The newest launch a stop has been **asked for**, which is not the same fact as
   * a stop having finished.
   *
   * ⚠ **The invariant is that a child of generation `g` must never run once this
   * has reached `g`**, and it is what `this.stopping !== null` could not express.
   * A stop is a promise that settles, so "is one outstanding" answers *no* the
   * moment the old child is gone — and a launch that was waiting for exactly that
   * then publishes a child into a teardown somebody has already asked for.
   * Measured against this file: an update whose incumbent got one queued hook
   * during the stop it was being given came back with a fresh child, out of a
   * directory `install` had since renamed, after `install` had already dropped it
   * from `live` — so nothing held it and `shutdown()` iterated past it.
   *
   * A stop asked for an *older* generation deliberately does not block a new
   * start: that is `setEnabled(true)` and the install rollback, both of which are
   * somebody saying this plugin should be running again.
   */
  private stopGeneration = 0;
  private starting: Promise<string | null> | null = null;
  private stopping: Promise<void> | null = null;
  /**
   * Requests written to a child and not yet answered, each stamped with the launch
   * it was written to. See {@link settlePending} for why the stamp is load-bearing.
   */
  /**
   * How many host-API calls this plugin has out right now. See
   * {@link MAX_INFLIGHT_HOST_CALLS}.
   *
   * A count rather than a `Map` because nothing here needs to find one again: the
   * child's own id is what settles it, and the only question this answers is
   * whether to take another.
   */
  private hostCalls = 0;
  private readonly pending = new Map<
    number,
    { settle: (answer: InvokeAnswer) => void; timer: NodeJS.Timeout; generation: number }
  >();
  private nextInvokeId = 1;
  private starts = 0;
  private timeouts = 0;
  /** Cancels a restart that has been scheduled and not yet run. See {@link PluginScheduler.wait}. */
  private restart: (() => void) | null = null;
  /** Which scheduled restart is the current one, so a stale firing is ignored. */
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

  /**
   * This plugin is not runnable, and its row is to say so.
   *
   * ⚠ **The one caller is {@link PluginHost.install}'s failed-rollback arm**, and
   * it is the one failure the *host* knows about that the plugin cannot: its files
   * are not where its row says they are, so no launch could report this as
   * anything but a missing module. Everything else that reaches {@link fail}
   * — a start that did not, a child that died, a plugin that stopped answering —
   * is inside this class, which is why `fail` is private and this is one line.
   */
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
      // Derived on every read, never stored: `ManagedSession.status`'s rule, and
      // the same reason — a stored state drifts from the thing it describes.
      state: this.state,
      failure: this.failure,
      installedAt: this.record.installedAt,
      updatedAt: this.record.updatedAt,
    };
  }

  /** `null` when it is running; otherwise the sentence saying why it is not. */
  ensureStarted(intent: StartIntent): Promise<string | null> {
    if (this.state === "running") return Promise.resolve(null);
    if (!this.record.enabled) return Promise.resolve("this plugin is switched off");
    // Memoised, so two invocations arriving together join one launch rather than
    // the second losing to a half-started child. `this.x ??= this.doX()`, written
    // out because the passive gate has to sit between the join and the launch:
    // joining a start somebody else is paying for is free, starting one is not.
    if (this.starting !== null) return this.starting;
    // See {@link StartIntent}. What is reported is what the row already says.
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
    /**
     * Which launch this is. Every callback below is closed over it.
     *
     * Claimed **before** the wait below rather than after it, so that a `stop()`
     * arriving while this launch is queued is a stop asked for *this* generation
     * and the guard past the fork can see it. See {@link stopGeneration}.
     */
    const generation = ++this.generation;
    // A launch of its own gets a signal of its own; see {@link hostCallsAbort}.
    const hostCalls = new AbortController();
    /*
     * ⚠ **Held as a local as well as on `this`, because the field is reassigned by
     * the next launch and `onExit` fires arbitrarily late.** A crash that has
     * already been followed by a restart finds `this.hostCallsAbort` pointing at
     * its *successor's* controller — aborting that would cancel the live child's
     * work, and reading it to abort "the crashed one" is not possible at all once
     * the field has moved. The closure below owns the controller of the launch it
     * belongs to, which is the same rule every other callback here follows about
     * `this.process`.
     */
    this.hostCallsAbort = hostCalls;
    /*
     * ⚠ **A stop already under way is waited out rather than raced.** `doStop`
     * nulls `process` and writes "stopped" on the row in its first three lines and
     * then waits for the child to actually go — up to `PLUGIN_STOP_DEADLINE_MS`,
     * and widest exactly when the plugin is the kind that ignores a SIGTERM.
     * Launching into that window gives this plugin two live children, which is a
     * state nothing here can describe: there is one `process` field, so whichever
     * child is not in it can never be stopped and `PluginHost.shutdown` cannot
     * reach it. Measured against this file with a scripted runtime — a `stop()`,
     * one queued hook draining into `ensureStarted`, then the first child's late
     * exit — three children were alive and `shutdown()` stopped one of them.
     *
     * Almost nobody at an HTTP request pays this wait: a `view` and an `action`
     * are both passive and never reach `doStart` at all (see {@link StartIntent}).
     * The exception is `setEnabled(true)`, which is a route and is supervised — so
     * switching a plugin on inside its own stop window blocks for up to the
     * runtime's stop deadline. That is the right trade for the one caller that is
     * explicitly asking for the plugin to be running.
     * And `stopping` is deliberately **not** cleared here — {@link stop} decides
     * by generation now, so the field is a record of the last stop rather than a
     * flag, and clearing it is how a stop asked for during this wait got erased.
     */
    const previous = this.stopping;
    if (previous !== null) await previous;

    let ready: (value: string | null) => void;
    const settled = new Promise<string | null>((resolve) => {
      ready = resolve;
    });

    const entry = this.host.entryFor(this.record);
    /**
     * This launch's own child, as its callbacks see it.
     *
     * Assigned once `launch` has resolved, which is before anything can arrive on
     * the channel: nothing is written to the child until the `init` below, and
     * `runner.ts` says nothing before it is spoken to. A message that beats it
     * anyway came from a child there is no handle on, so it cannot be answered —
     * and answering it to `this.process` instead is the whole of the second
     * failure {@link LivePlugin.generation} lists.
     */
    let mine: PluginProcess | null = null;
    let child: PluginProcess;
    try {
      child = await this.host.pluginRuntime().launch({
        manifest: this.record.manifest,
        entry,
        onMessage: (message) => {
          /*
           * From a child this plugin has already replaced: dropped whole. A
           * `ready` from one would put "running" on a row whose current launch
           * failed and then drain the hook queue into a child nothing holds, and a
           * `done` would settle a request the *live* child is still working on.
           * See {@link LivePlugin.generation}.
           */
          if (generation !== this.generation) return;
          /*
           * ⚠ **And a stop asked for *this* launch, which the check above cannot
           * see.** `generation` is still current while `doStop` is running — it
           * has already nulled `this.process` and written "stopped" — so a `ready`
           * landing there put `running` on a row with no child and then called
           * `drain`, which spun the whole queue against `this.process === null`,
           * consuming up to `MAX_HOOK_QUEUE` deliveries and discarding them
           * without touching `this.dropped`. That counter is the entire reason the
           * drop-oldest bound is honest, and `summary()` reported `running` for a
           * stopped plugin until the real exit arrived. The post-fork guard makes
           * exactly this check; this is the other side of the same launch.
           */
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
          // See `mine` above: unreachable in practice, and the alternative to
          // dropping it is answering somebody else's child.
          if (target === null) return;
          this.onChildMessage(message, target, generation);
        },
        onExit: (detail) => {
          /*
           * Whoever was waiting on *this* child, told now rather than at the far
           * end of an invoke deadline — and their timers disarmed, which is the
           * half that matters. See {@link settlePending}. Done before the gate
           * below and not after it, because a superseded child's requests are
           * precisely the ones nobody is ever going to answer.
           */
          this.settlePending(generation, `the plugin process ${detail}`);
          /*
           * ⚠ **And the calls going the *other* way, which only `doStop` withdrew.**
           * {@link hostCallsAbort}'s docblock names the exposure — an agent
           * subprocess holding one of this machine's two `model.complete` slots for
           * 110 seconds after the plugin that asked for it is gone — and answers it
           * for the deliberate paths. A **crash** reaches none of them: the child
           * dies, `settlePending` tells the inbound side, and the outbound call ran
           * on. Worse, `scheduleRestart` two lines down replaces the field within
           * two seconds, after which the crashed generation's controller is
           * unreachable from every field on this object and no later `stop()`,
           * `setEnabled(false)`, `remove()` or `shutdown()` can ever abort it.
           *
           * Above the generation gate for `settlePending`'s reason: a superseded
           * child's outbound calls are exactly the ones whose answers nobody wants.
           */
          hostCalls.abort(new Error(`the plugin process ${detail}`));
          if (generation !== this.generation) {
            /*
             * ⚠ **A child this plugin has already moved on from — and every line
             * below would land on its successor.** `this.process = null` would
             * drop a live child on the floor, leaving a process with an IPC
             * channel that no `stop()` and no `shutdown()` can reach; `fail()`
             * would write "failed" on a row whose plugin is answering; and
             * `scheduleRestart` would fork a third child on top of the two already
             * running. Nothing is owed here — the launch that replaced this child
             * has already reported whatever it found.
             */
            return;
          }
          this.process = null;
          // A stop this host asked for is not a failure, and {@link
          // stopGeneration} is what tells them apart — without it every deliberate
          // stop would burn a restart and mark the plugin failed. Asked *for this
          // child*: a stop of the one before it says nothing about this one.
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
      /*
       * ⚠ **A stop was asked for this child while it was being forked, and
       * publishing it now would publish a child nothing can reach.** `doStop` has
       * already read `this.process` — still null, because the assignment below had
       * not happened — nulled it and written "stopped" on the row, so a child
       * published now is one no later `stop()` and no `shutdown()` will ever see.
       * Reachable on the ordinary path rather than in a race: measured against
       * this file, `PluginHost.open` starts every enabled plugin with an un-awaited
       * `ensureStarted`, so a daemon told to shut down inside its own start window
       * left one live child per plugin behind with the row saying "running".
       *
       * ⚠ **The update case is not this guard's**, though it looks like it should
       * be. An incumbent restarted by one queued hook has a *newer* generation, so
       * the condition above is false for it and it publishes normally; what
       * catches it is `install`'s second `existing.stop()` on the way out. This
       * guard only sees that case in the narrow window where the restart is still
       * inside its own fork.
       */
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
      /*
       * ⚠ `this.stop()` rather than `child.stop()`, and the difference is a real
       * defect rather than a style: `stop()` is what sets `stopping`, which is the
       * only thing `onExit` has to tell a kill *we* asked for from a crash. Killing
       * the child directly made a failed start look like one, so the plugin was
       * marked failed a second time and — worse — a **restart was scheduled for a
       * plugin the caller was in the middle of rolling back**, which would have
       * brought a broken update back to life minutes after it was refused.
       */
      await this.stop();
      return this.fail(withLogs(answer, child));
    }
    return null;
  }

  private scheduleRestart(): void {
    if (this.restart !== null || !this.record.enabled || this.starts >= MAX_PLUGIN_STARTS) return;
    const scheduler = this.host.scheduler();
    // Full jitter, `autoResume`'s shape: a plugin that crashes on a schedule must
    // not come back on the same schedule as every other plugin doing it. Both
    // halves go through the scheduler for the reason its docblock gives — the
    // default is `Math.random` and `setTimeout`, so nothing about this moved.
    const ceiling = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (this.starts - 1));
    const wait = Math.floor(scheduler.jitter() * ceiling);
    /*
     * ⚠ **The callback may run before `wait` returns.** A scheduler that fires
     * synchronously is not a hypothetical — it is the shape a driver substitutes
     * to walk a backoff without sleeping, which is the entire reason
     * {@link PluginScheduler} exists. Assigning the canceller after the fact would
     * then store a canceller for a callback that has already run, and
     * `this.restart !== null` above would refuse every later restart for the life
     * of the plugin: the seam would break for exactly the case it was added for.
     * `attempt` is the second half — a scheduler whose canceller does not really
     * cancel must not let a stale firing restart a plugin somebody has stopped.
     */
    const attempt = ++this.restartSeq;
    let fired = false;
    const cancel = scheduler.wait(wait, () => {
      fired = true;
      if (this.restartSeq !== attempt) return;
      this.restart = null;
      // Supervised: this is the daemon deciding a plugin it is responsible for
      // should be running again, and it is the only caller that should be paying
      // out of the restart budget. See {@link StartIntent}.
      void this.ensureStarted("supervised");
    });
    this.restart = fired ? null : cancel;
  }

  /**
   * A message from a child, answered to **that** child.
   *
   * ⚠ **`target` is captured at receipt and never re-read from `this.process`
   * after the await, and the difference is silent wrong data rather than a style
   * point.** The host echoes the child's *own* call id back, and a child's id
   * space restarts at 1 on every launch (`runner.ts`'s `nextCallId`), so with
   * `this.process` re-read after `callApi` resolves the id was the only thing
   * deciding who got the answer. Measured against this file: child A issued
   * `net.fetch` as id 5, crashed while the request was in flight, came back as B,
   * and B's own id 5 was settled with A's HTTP response body — inside a plugin
   * that had asked for something else entirely, with nothing on its row saying so.
   * `runtime.ts` says a child's message is "never trusted for shape"; the shape
   * was checked and the **addressee** was not.
   *
   * The generation is checked as well as the object, so an answer is never written
   * to a child this plugin has already given up on.
   */
  private onChildMessage(message: ChildMessage, target: PluginProcess, generation: number): void {
    if (message.t === "call") {
      const { id } = message;
      /*
       * ⚠ **Refused rather than queued, and counted here rather than inside
       * `callApi`.** Here is where the fan-out is: `callApi` is a dispatcher that
       * does not know which plugin's budget it is spending, and by the time a call
       * reaches `sessions.changes` the git process is the next statement. Refusing
       * is also the honest answer to the child, which asked for something now — a
       * queue would only move the cost to the invoke deadline the caller is
       * already waiting on.
       */
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
      /*
       * Released on both arms and before the generation check, because the count is
       * about *this* process's load rather than about who deserves an answer: a
       * superseded child's call still finished, and leaving its slot spent would
       * bleed the successor's budget one call per replaced generation.
       */
      const release = (): void => {
        this.hostCalls = Math.max(0, this.hostCalls - 1);
      };
      /*
       * Read here rather than inside the `.then`, so what travels is the signal of
       * the launch that was current when the child asked — the same discipline the
       * captured `target` above keeps, and for the same reason.
       */
      const gone = this.hostCallsAbort.signal;
      void this.host
        .callApi(this.record.manifest, message.method, message.args, gone)
        .then((value) => {
          release();
          if (generation !== this.generation) return;
          if (target.send({ t: "answer", id, ok: true, value }) === false) {
            // The value fits what the API allows and not what the channel
            // carries. Saying so beats leaving the child's promise pending: a
            // plugin can retry for less, and cannot act on silence.
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
      // Only the child a request was written to may answer it. These ids are this
      // host's own and do not restart, so a collision needs a child inventing one
      // — which is a plugin running arbitrary code as this uid, and the honest
      // description of every plugin.
      if (waiter.generation !== generation) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      this.timeouts = 0;
      waiter.settle({ kind: "done", message });
    }
  }

  /**
   * Ask the plugin something, and answer within the deadline whatever it does.
   *
   * The deadline is the point: a plugin holding a request open is a person looking
   * at a spinner, and the only thing that can end that is this side giving up. Three
   * of those in a row and the plugin is stopped rather than asked a fourth time —
   * a child that has stopped answering will not start again because it was asked
   * more politely, and a stopped plugin at least says so on its row.
   */
  async invoke(kind: PluginInvokeKind, name: string, input: unknown): Promise<PluginResult> {
    /*
     * ⚠ **`kind` decides who pays for a start, and it is the only thing that
     * can.** A `view` and an `action` are both somebody at the other end of an
     * HTTP request, and neither may spend a budget only `machine:admin` can
     * restore — the `view` half is the reachable one, since it is `read`-scoped
     * and `PluginScreen` re-reads it on a timer. A `hook` is this daemon's own
     * traffic reaching a plugin that asked to be sent it, which is the same claim
     * the boot pass makes. See {@link StartIntent}. Reading `kind` rather than
     * taking a parameter keeps `invoke` the signature the two routes already
     * call.
     */
    const failure = await this.ensureStarted(kind === "hook" ? "supervised" : "passive");
    if (failure !== null) throw new PluginApiError("plugin_unavailable", failure);
    /*
     * ⚠ **The child and the launch it belongs to, read as a pair.** `ensureStarted`
     * above is what makes the pair meaningful — it either joins the launch in
     * flight or reports that there is none, so by here these two describe the same
     * child. Everything downstream is stamped with it: the pending entry, its
     * timer and the answer that settles it, which is how each finds the request it
     * belongs to rather than the one that happens to hold the same id. See
     * {@link LivePlugin.generation}.
     */
    const generation = this.generation;
    const child = this.process;
    if (child === null) throw new PluginApiError("plugin_unavailable", this.failure ?? "this plugin is not running");

    if (this.pending.size >= MAX_INFLIGHT_INVOCATIONS) {
      // Refused rather than queued: the caller is an HTTP request somebody is
      // waiting on, and holding it behind seven others only moves the timeout.
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
        // Answered before any of the bookkeeping below, which is this daemon's own
        // and not the caller's: what is waiting on this is an HTTP request.
        resolve({ kind: "timeout" });
        /*
         * ⚠ **Only the child this was written to may be charged for its silence.**
         * `timeouts` is a counter three of which stop the plugin, and `stop()` acts
         * on whatever is current — so a timer left behind by a child that crashed
         * used to stop its healthy replacement. An exit settles and disarms its own
         * generation's entries, so reaching here at all means that child is still
         * notionally alive; if it has been superseded anyway — a stop that hit
         * `PLUGIN_STOP_DEADLINE_MS` without the kernel ever agreeing — then the
         * silence belongs to a child nobody is waiting on any more.
         */
        if (generation !== this.generation) return;
        this.timeouts += 1;
        if (this.timeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          void this.stop().then(() => {
            this.fail(`this plugin stopped answering after ${MAX_CONSECUTIVE_TIMEOUTS} requests`);
            /*
             * ⚠ **Recovered under supervision, because this is a stop *this
             * daemon* chose rather than a start the plugin failed.** No start
             * budget was spent getting here, and since a `view` and an `action`
             * are both passive (see {@link StartIntent}) nothing an HTTP caller
             * does would bring it back — a plugin that went quiet for three
             * requests would sit dead until an admin toggled it, where before the
             * passive gate the next read revived it. `scheduleRestart` still
             * honours `MAX_PLUGIN_STARTS`, so this cannot resurrect a plugin that
             * genuinely will not start; the counter is cleared because the three
             * that got us here are answered by the restart rather than carried
             * into the next child's tally.
             */
            this.timeouts = 0;
            this.scheduleRestart();
          });
        }
      }, wait);
      timer.unref?.();
      this.pending.set(id, { settle: resolve, timer, generation });
      /*
       * ⚠ **Re-checked after the entry is in the map, and that ordering is the
       * whole of it.** `ensureStarted` resolving and this `set` are two turns
       * apart, and a child dying in that gap has already run `settlePending` —
       * over a map this entry was not in yet. It would then have waited out the
       * full invoke deadline and answered `plugin_timeout`, which sends somebody
       * to look at a busy machine for a plugin that was already gone. The map is
       * the rendezvous, so the liveness question has to be asked from inside it.
       */
      if (this.process !== child || this.generation !== generation) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ kind: "stopped", detail: this.failure ?? "this plugin stopped before it could be asked" });
        return;
      }
      if (!child.send({ t: "invoke", id, kind, name, input })) {
        // Too large for the channel, or the child went away between the check
        // above and here. Either way nobody is going to answer, so this settles
        // now rather than spending the invoke deadline looking like a hang —
        // which is what let three oversized forms exhaust the timeout budget.
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ kind: "oversize" });
      }
    });

    // A timeout is its own code and its own status, because the remedy differs:
    // `plugin_failed` is the plugin's author's problem and `plugin_timeout` is
    // "ask again, or look at whether this machine is busy".
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

  /**
   * Whatever the plugin returned, in the one shape a client is ever sent.
   *
   * A view is clamped rather than refused — a board with three hundred cards is
   * somebody's real board — and the clamp is reported as a notice rather than
   * hidden, because a list silently cut is a list that shows a wrong number.
   */
  private shape(kind: PluginInvokeKind, name: string, value: unknown): PluginResult {
    /*
     * ⚠ **Which surface, taken from the name this invocation already carried.**
     * A `view` is invoked by its id — `server.ts` refuses any id but `screen` and
     * `settings` — so the surface was on the wire the whole time and neither side
     * read it.
     *
     * ⚠ **An `action` is `screen`, and that is a limit worth stating rather than
     * hiding.** An action id says which action, never which pane it was pressed
     * on: the same submit reaches here from a form on a screen and from a form on
     * a settings pane. So the *browser* narrows what a settings pane draws — it
     * is the side that knows for certain — and this clamp is what produces the
     * author-facing notice on the read. Guessing the surface from the presence of
     * a `form` context was considered and is worse than not knowing: a screen's
     * form would then be told it may not draw a list.
     */
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

  /** Every session this daemon already knows about, for a plugin that has just arrived. */
  seed(sessions: readonly ManagedSession[]): void {
    if (!this.wants("session.created")) return;
    for (const managed of sessions) {
      this.deliver("session.created", { hook: "session.created", session: managed.snapshot() });
    }
  }

  /**
   * A hook, queued.
   *
   * **Drop-oldest past the bound, with a count.** A plugin that has stopped
   * answering must not grow a queue for the life of the daemon, and the newest
   * events are the ones still worth acting on — a board catching up cares about
   * the turn that just ended, not the one from an hour ago. The count is what
   * keeps that honest: it is reported through `onWarning` rather than swallowed,
   * because a plugin quietly missing half its events looks exactly like a plugin
   * with a bug in it.
   */
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
      /*
       * ⚠ **Not for a plugin whose budget is gone, and that arm is not an
       * optimisation.** `doStart`'s first statement is the budget check and it
       * runs *synchronously* — an async function body does, up to its first await
       * — so `ensureStarted` here reached `fail()`, which reaches `onWarning`,
       * which is `console.error` in `scripts/daemon.ts`. Under launchd
       * `StandardErrorPath` is a regular file and Node's stderr is blocking for a
       * file descriptor, so this was a synchronous `write(2)` on the hook path:
       * inside `SessionLog.append`, inside the agent's own RPC handler. One
       * enabled plugin whose `server.js` throws on import spends its three starts
       * and then charges every `turn.ended`, `permission.requested` and
       * `permission.resolved` on the machine a blocking write and an allocated
       * promise, for the life of the daemon, with the log growing without bound.
       * `.claude/rules/plugins.md` says nothing on this path may *await* into the
       * emit path; blocking it is worse.
       *
       * Nothing is lost by holding: the queue is bounded drop-oldest and reports
       * its drops, and the switch is what returns the budget.
       */
      if (this.state !== "failed" && this.starts < MAX_PLUGIN_STARTS) {
        // Held rather than dropped: a plugin still starting will get these, and a
        // stopped one is bounded by the queue above. Supervised, and for the reason
        // a `hook` invocation is: what is waiting here is this daemon's own traffic
        // to a plugin that asked to be sent it, not somebody looking at a screen.
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
            // Sequential on purpose. A plugin's hook handler almost always writes
            // to its own store, and delivering two at once means a read-modify-write
            // race inside somebody's twenty lines of JavaScript.
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

  /**
   * Idempotent **per launch**, which is one word more than `this.x ??= this.doX()`
   * and is the whole of the difference.
   *
   * ⚠ A plain `??=` hands the caller the promise of a stop that finished two
   * children ago, and answers "stopped" for a plugin that has been restarted since
   * — which is exactly what a caller stopping a plugin it is about to replace is
   * asking about. `install` stops the incumbent, does its filesystem work, and
   * stops it a second time on the way out precisely because the first stop is a
   * window a queued hook can restart the plugin through; with `??=` that second
   * call was the first call's settled promise and did nothing at all.
   */
  stop(): Promise<void> {
    /*
     * ⚠ **Cancelled here rather than inside `doStop`, because `doStop` is the half
     * that gets memoised away.** A stop for a launch already stopped returns the
     * settled promise below without entering `doStop` at all — and the one path
     * that arms a restart *after* a stop is the timeout escalation, which stops
     * the plugin, fails it and then schedules one. So `remove` on such a plugin
     * took the memoised branch, cancelled nothing, dropped the row from `live`,
     * and the timer fired into `ensureStarted` a moment later: a child forked for
     * a plugin that no longer exists, held by nothing, and unreachable from
     * `shutdown`, which iterates `live`. Unconditional, because "is there a timer
     * armed" is not a question the memoisation is answering.
     */
    if (this.restart !== null) {
      this.restart();
      this.restart = null;
    }
    if (this.stopping === null || this.stopGeneration < this.generation) {
      /*
       * Latched before `doStop` is even entered, so a launch waiting past its fork
       * sees it without having to observe a promise. See {@link stopGeneration}.
       */
      const previous = this.stopping;
      this.stopGeneration = this.generation;
      const next = this.doStop(this.generation);
      /*
       * ⚠ **Chained rather than replaced.** A stop that supersedes one still in
       * flight is a stop for a *newer* launch, and `doStop` for that launch may
       * have nothing to await — the older child is the one still being killed.
       * Handing the caller only the new promise let `shutdown()` resolve while a
       * process was alive, which is the one thing `shutdown` is for. Both, so the
       * answer means what its callers read it as.
       */
      this.stopping = previous === null ? next : Promise.all([previous, next]).then(() => undefined);
    }
    return this.stopping;
  }

  /**
   * `generation` is the launch this stop was asked for, and every decision here is
   * about that child rather than whichever one is current when this finishes — the
   * wait below is where the next child gets started.
   */
  private async doStop(generation: number): Promise<void> {
    this.settlePending(generation, "this plugin was stopped");
    /*
     * The other direction, and the reason it is here rather than left to a
     * deadline: `settlePending` above answers what was asked *of* this child, and
     * this withdraws what this child asked *of the daemon* — the calls that spawn
     * things. See {@link hostCallsAbort}.
     */
    this.hostCallsAbort.abort(new Error(`plugin ${this.record.id} was stopped`));
    const child = this.process;
    this.process = null;
    this.state = "stopped";
    if (child !== null) await child.stop();
  }

  /**
   * Everything still waiting on this launch or an older one, answered and disarmed.
   *
   * ⚠ **Clearing the timers is the half that matters, and leaving them armed was a
   * defect rather than untidiness.** A pending entry is two things: a promise an
   * HTTP request is awaiting, and a `setTimeout` that charges the plugin a
   * consecutive timeout and, at {@link MAX_CONSECUTIVE_TIMEOUTS}, stops it — and
   * `stop()` stops whatever is current. So a child that died with requests
   * outstanding left timers that fired against its replacement. Not a narrow
   * race: {@link RESTART_BASE_MS} is 2 s and {@link PLUGIN_INVOKE_TIMEOUT_MS} is
   * 10 s, so the replacement is normally up and answering well before the old
   * timers go off. Measured against this file with a scripted runtime — three
   * requests outstanding when child A crashed — A's timers stopped B and started a
   * third child.
   *
   * The caller also gets a real answer at the moment the child died rather than a
   * `plugin_timeout` at the far end of a deadline nobody was ever going to meet.
   *
   * `through` rather than an exact generation, because a launch older than the one
   * ending is older still: nothing is coming back for those either.
   */
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
    // Reported when it changes, rather than on every arrival at the same state.
    // Re-saying an identical sentence adds no information and is the half of the
    // hook-path defect above that a caller reaching here by another route would
    // still have paid. The row keeps the sentence either way.
    if (said !== this.failure) this.host.warn(`plugin ${this.record.id}: ${this.failure}`);
    return this.failure;
  }
}

/**
 * A failure, with what the child actually printed underneath it.
 *
 * The sentence alone is almost never enough — "did not start within 10000ms" says
 * nothing a person can act on, while the `SyntaxError` their `server.js` threw
 * says everything. This is why stdout is captured beside stderr.
 */
function withLogs(detail: string, child: PluginProcess): string {
  const logs = child.recentLogs();
  return logs.length === 0 ? detail : `${detail}\n${logs.join("\n")}`;
}

function refuse(code: string, message: string): InstallOutcome {
  return { kind: "refused", code, message };
}

/** An `ArchiveError`'s own vocabulary, in this route's namespace. */
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

/**
 * Where the manifest is, given what came out of the archive.
 *
 * The tree itself, or a single directory inside it — nothing deeper. Somebody who
 * compresses a folder and somebody who compresses its contents both get a working
 * plugin, and an archive holding a whole home directory does not get searched.
 */
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
    // Already ended, errored, or cancelled. None of those is a reason to fail an
    // install that has otherwise finished.
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export type { LivePlugin };
