import { readFile } from "node:fs/promises";

import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_BYTES,
  diffFile,
  listChanges,
  probeRequestable,
  safeRelPath,
} from "../changes.js";
import type { GitExec } from "../git.js";
import type { ElicitationContentValue, ManagedSession, SessionRegistry } from "../registry.js";
import { DESCRIBE_TIMEOUT_MS, probeFile } from "../stall.js";
import type { PluginManifest, PluginScope } from "./protocol.js";
import { PluginStoreError, type PluginDataStore } from "./store.js";

/**
 * Everything a plugin may ask this daemon to do, and the gate in front of it.
 *
 * **The gate is a table, and the table is the whole of the authorization story.**
 * Every method names the scope it needs; a call whose plugin did not declare that
 * scope is refused before the method is reached, and the refusal is reported
 * through `onWarning` as well as returned — a plugin exceeding what it told an
 * operator it needed is exactly the thing somebody would want to know about, and
 * it is invisible from the plugin's own screens.
 *
 * ⚠ This is the second axis of authorization and not the only one. `read`,
 * `write` and `admin` on the routes decide what the **caller** may do; this
 * decides what the **plugin** may do, and it is the only one that applies inside a
 * hook, where nobody called anything. Neither implies the other and both hold.
 *
 * ⚠ **And it is hygiene rather than a fence**, in exactly the sense `agentEnv()`
 * is: the plugin is a child process running as this uid and can `import("node:fs")`.
 * What the gate does is make the blast radius describable — shown at install,
 * refused when exceeded — which catches the mistake, not the attacker.
 * `SECURITY.md` states it in those words and this comment exists so the stronger
 * claim is not quietly restored.
 *
 * **`files.list` is deliberately absent**, and its absence is the one narrowing
 * from the plan worth stating. Listing a directory means walking a tree of paths
 * this daemon did not create, which needs the whole `stall.ts` permit-and-deadline
 * apparatus for an answer `sessions.changes` already gives better — git's own
 * list of what a session touched, bounded, containment-checked and written. A
 * plugin that wants to know what is in a workspace asks that.
 */

/** How large a file `files.read` will hand back. */
const MAX_PLUGIN_FILE_BYTES = 64 * 1024;

/** How much of an event page a plugin may take at once. */
const MAX_PLUGIN_EVENTS = 500;
const MAX_PLUGIN_EVENT_BYTES = 128 * 1024;

/**
 * How much of its own store one `store.entries` call hands back.
 *
 * **The page is bounded here rather than left to the quota, because the quota is
 * four times the channel.** `MAX_PLUGIN_DATA_BYTES` lets a plugin keep 1 MiB and
 * `MAX_PLUGIN_MESSAGE_BYTES` carries 256 KiB, so a batched read that trusted the
 * quota would be a call that answers for a small store and, for a full one,
 * produces a message the host refuses to forward — the plugin's own data, made
 * unreadable by the call that was meant to make it cheap.
 *
 * Half the channel, which is the same relationship `MAX_PLUGIN_EVENT_BYTES` has
 * to it and for the same reason: what the store charges against this is the
 * pairs, while the array's own brackets and the `{"t":"answer",…}` envelope
 * around them are outside the sum. Measured at 1000 cards of ~139 bytes, the
 * largest answer this produced was 129,150 bytes against the 262,144 the channel
 * takes. It is a **page**, not a cut: the store says whether it had more, the
 * cursor is the last key, and a plugin that ignores both is reading a prefix of
 * its own data on purpose. A silent cut is the one thing this cannot be —
 * `clampView` reports one for a screen, and data is worse than a screen.
 */
const MAX_PLUGIN_ENTRY_BYTES = 128 * 1024;

/** How much of a plugin's own `log` line is kept. The rest is its problem. */
const MAX_PLUGIN_LOG_CHARS = 500;

/** What `net.fetch` will read, and how long it will wait. */
const MAX_PLUGIN_FETCH_BYTES = 1024 * 1024;
const PLUGIN_FETCH_TIMEOUT_MS = 10_000;
/** Requests per plugin per window, and how long the window is. */
const PLUGIN_FETCH_BURST = 30;
const PLUGIN_FETCH_WINDOW_MS = 60_000;

/**
 * A refusal a plugin can read.
 *
 * Carries a code as well as a sentence for the reason every refusal in this
 * system does: the sentence is for a person and the code is for a program, and a
 * plugin deciding what to do next needs the second one.
 */
export class PluginApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginApiError";
  }
}

/** Which scope each method needs. The absence of a method here is a refusal. */
const SCOPE_OF: Record<string, PluginScope | null> = {
  log: null,
  "sessions.list": "sessions.read",
  "sessions.get": "sessions.read",
  "sessions.events": "sessions.read",
  "sessions.changes": "sessions.read",
  "sessions.diff": "sessions.read",
  "sessions.workspace": "sessions.read",
  "sessions.create": "sessions.write",
  "sessions.prompt": "sessions.write",
  "sessions.cancel": "sessions.write",
  "sessions.stop": "sessions.write",
  "sessions.setMeta": "sessions.write",
  "sessions.answerPermission": "sessions.write",
  "sessions.answerElicitation": "sessions.write",
  /*
   * `sessions.read` rather than a scope of its own. It is a fact about the
   * machine rather than about a session — but it is the fact a plugin needs
   * *before* `sessions.create`, and inventing a scope of its own so that a plugin
   * can ask "which agents could I start" would be a scope somebody has to explain
   * in the install list for one method.
   */
  "agents.list": "sessions.read",
  "files.read": "files.read",
  "store.get": "store",
  "store.set": "store",
  "store.delete": "store",
  "store.keys": "store",
  "store.entries": "store",
  "net.fetch": "net",
};

export interface PluginApiOptions {
  registry: SessionRegistry;
  data: PluginDataStore;
  git: GitExec;
  /** Both default to `changes.ts`'s own numbers, so a plugin and the route agree. */
  maxChangedFiles?: number | undefined;
  maxDiffBytes?: number | undefined;
  onWarning?: (detail: string) => void;
  /** Injected so `daemoncheck` can drive the allowlist without a network. */
  fetchImpl?: typeof fetch;
}

/**
 * The dispatcher, and the one place a plugin's authority is decided.
 *
 * A class rather than a closure because it holds the per-plugin fetch window,
 * which has to survive between calls and must not be shared between plugins — one
 * plugin's polling loop spending another's budget is a bug whose symptom appears
 * in the wrong place entirely.
 */
export class PluginApi {
  /** `pluginId -> timestamps of recent fetches`. Bounded by the window itself. */
  private readonly fetches = new Map<string, number[]>();

  constructor(private readonly options: PluginApiOptions) {}

  async call(manifest: PluginManifest, method: string, args: unknown): Promise<unknown> {
    if (!Object.hasOwn(SCOPE_OF, method)) {
      throw new PluginApiError("unknown_method", `there is no ${method}`);
    }
    const needed = SCOPE_OF[method] ?? null;
    if (needed !== null && !manifest.scopes.includes(needed)) {
      this.options.onWarning?.(
        `plugin ${manifest.id} called ${method} without the ${needed} scope`,
      );
      throw new PluginApiError(
        "plugin_scope_denied",
        `${method} needs the "${needed}" scope, which this plugin does not declare`,
      );
    }
    const input = (args ?? {}) as Record<string, unknown>;
    return this.run(manifest, method, input);
  }

  private async run(manifest: PluginManifest, method: string, input: Record<string, unknown>): Promise<unknown> {
    const { registry } = this.options;

    switch (method) {
      case "log": {
        this.options.onWarning?.(`plugin ${manifest.id}: ${clip(String(input["message"] ?? ""), MAX_PLUGIN_LOG_CHARS)}`);
        return null;
      }

      case "sessions.list":
        return registry.list().map((session) => summarize(session));

      case "sessions.get":
        return summarize(this.session(input));

      case "sessions.events": {
        const managed = this.session(input);
        const since = whole(input["since"], 0);
        const limit = Math.min(whole(input["limit"], 100), MAX_PLUGIN_EVENTS);
        return managed.log.read(since, limit, MAX_PLUGIN_EVENT_BYTES);
      }

      case "sessions.changes": {
        const managed = this.session(input);
        const changes = await listChanges(managed.workspace, {
          runner: this.options.git,
          base: input["base"] === "head" ? "head" : "session",
          includeIgnored: false,
          limit: this.options.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES,
        });
        return changes;
      }

      case "sessions.diff": {
        const managed = this.session(input);
        const path = text(input["path"], "path");
        /*
         * Recomputed rather than trusted, exactly as `GET /sessions/:id/changes/diff`
         * does — the set of servable paths is the set git itself just reported, which
         * is the strongest containment rule in the daemon's API and closes the race
         * between listing a file and asking for its diff. A plugin gets the same rule
         * or it gets a weaker one, and there is no reason for it to get a weaker one.
         */
        const changes = await listChanges(managed.workspace, {
          runner: this.options.git,
          base: input["base"] === "head" ? "head" : "session",
          includeIgnored: true,
          limit: this.options.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES,
        });
        if (!changes.supported) throw new PluginApiError("not_a_git_repository", "that session is not in a git repository");
        const change = changes.files.find((file) => file.path === path);
        if (change === undefined) throw new PluginApiError("path_not_changed", "that session did not change that file");
        if (!change.addressable) {
          throw new PluginApiError("path_not_addressable", "that path is not valid UTF-8 and cannot be requested");
        }
        return diffFile(managed.workspace, change, {
          runner: this.options.git,
          base: input["base"] === "head" ? "head" : "session",
          contextLines: 3,
          maxBytes: this.options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
        });
      }

      case "sessions.workspace":
        return this.session(input).workspace;

      case "sessions.create": {
        const agent = text(input["agent"], "agent");
        const cwd = text(input["cwd"], "cwd");
        const raw = input["worktree"];
        const worktree =
          raw === true ? "require" : raw === false ? "never" : raw === "auto" || raw === "require" || raw === "never" ? raw : undefined;
        const branchRaw = input["branch"];
        const branch = typeof branchRaw === "string" && branchRaw.length > 0 ? branchRaw : null;
        try {
          // `isAgentId` is not re-implemented here: `registry.create` refuses an
          // unknown agent itself, and a second copy of that list is a second copy
          // to forget when a fourth agent arrives.
          const managed = await registry.create({ agent: agent as never, cwd, worktree, branch });
          return summarize(managed);
        } catch (error) {
          throw new PluginApiError("session_create_failed", error instanceof Error ? error.message : String(error));
        }
      }

      case "sessions.prompt": {
        const managed = this.session(input);
        const result = managed.prompt(text(input["text"], "text"));
        if (result.kind !== "accepted") {
          throw new PluginApiError(`session_${result.kind}`, `that session would not take a prompt: ${result.kind}`);
        }
        return result;
      }

      case "sessions.cancel":
        return this.session(input).cancelTurn();

      case "sessions.stop": {
        const managed = this.session(input);
        await managed.stop("stopped");
        return summarize(managed);
      }

      case "sessions.setMeta": {
        const managed = this.session(input);
        const change: { title?: string | null; pinned?: boolean } = {};
        if (Object.hasOwn(input, "title")) {
          const title = input["title"];
          change.title = title === null ? null : text(title, "title");
        }
        if (Object.hasOwn(input, "pinned")) change.pinned = input["pinned"] === true;
        return managed.setMeta(change);
      }

      case "agents.list":
        // Asked of the runtime rather than of this host's filesystem, exactly as
        // `GET /agents` does — what "available" means is the runtime's question,
        // and it is the only thing that also knows whether the agent is signed in.
        return registry.sessionRuntime.availability();

      case "sessions.answerElicitation": {
        const managed = this.session(input);
        const elicitationId = text(input["elicitationId"], "elicitationId");
        /*
         * Three answers, because ACP has three and a plugin that can only fill a
         * form cannot get an agent past a question it has nothing to say about.
         * `decline` lets the turn carry on; `cancel` abandons the call that asked.
         */
        const body =
          input["decline"] === true
            ? ({ decline: true } as const)
            : input["cancel"] === true
              ? ({ cancel: true } as const)
              : { content: (input["content"] ?? {}) as Record<string, ElicitationContentValue> };
        const result = managed.answerElicitation(elicitationId, body);
        if (result.kind === "invalid_content") {
          // The problems come back rather than a sentence: `validateElicitationContent`
          // reports *every* field it refused, not the first, and a plugin fixing
          // its form wants all of them.
          throw new PluginApiError("elicitation_invalid", JSON.stringify(result.problems));
        }
        return result;
      }

      case "sessions.answerPermission": {
        const managed = this.session(input);
        const optionId = text(input["optionId"], "optionId");
        const result = managed.answerPermission(text(input["permissionId"], "permissionId"), { optionId });
        if (result.kind === "not_found") throw new PluginApiError("permission_not_found", "no such question on that session");
        return result;
      }

      case "files.read": {
        const managed = this.sessionBy(text(input["sessionId"], "sessionId"));
        const requested = text(input["path"], "path");
        const safe = safeRelPath(managed.workspace.root, requested);
        if (!safe.ok) throw new PluginApiError("invalid_path", `that path is not inside the session's tree: ${safe.reason}`);
        /*
         * The resolved re-test, not only the syntactic one. `safeRelPath` refuses a
         * `.git` segment somebody typed, and one `g -> .git` symlink walks past it —
         * so the question is asked again on the path after the link has been
         * followed. This is the same pair `requestedPath` keeps in `server.ts`, and
         * having a second caller is why the rule lives in `changes.ts` rather than
         * in either of them.
         */
        const answer = await probeRequestable(managed.workspace.root, safe.full);
        if (answer === null) {
          throw new PluginApiError("path_unresponsive", `the filesystem holding that path did not answer in ${DESCRIBE_TIMEOUT_MS}ms`);
        }
        if (answer !== "ok") throw new PluginApiError("invalid_path", `that path is not inside the session's tree: ${answer}`);

        const probe = await probeFile(safe.full);
        if (probe === null) throw new PluginApiError("path_unresponsive", "the filesystem holding that path did not answer");
        if (probe.kind !== "file") throw new PluginApiError("not_a_file", "that path is not a regular file");
        if (probe.size > MAX_PLUGIN_FILE_BYTES) {
          throw new PluginApiError("file_too_large", `a plugin may read at most ${MAX_PLUGIN_FILE_BYTES} bytes of a file`);
        }
        // Behind the probe that just answered, which is the rule: a synchronous or
        // unbounded call is allowed on a path either we made or that has just been
        // probed. Handed back as text because the transport is JSON; a plugin that
        // needs bytes is asking for something this API does not offer.
        return readFile(safe.full, "utf8");
      }

      case "store.get":
        return this.options.data.get(manifest.id, text(input["key"], "key"));

      case "store.set": {
        const value = input["value"];
        try {
          // Serialised here rather than in the child, so the byte the quota counts is
          // the byte that lands in the row. A plugin storing its own JSON string and a
          // plugin storing an object must be charged the same way.
          this.options.data.set(manifest.id, text(input["key"], "key"), JSON.stringify(value ?? null));
        } catch (error) {
          // Translated rather than re-thrown, so the plugin reads one kind of error
          // from this API. `store.ts` owns the bound and this owns the vocabulary.
          if (error instanceof PluginStoreError) throw new PluginApiError(error.code, error.message);
          throw error;
        }
        return null;
      }

      case "store.delete":
        this.options.data.delete(manifest.id, text(input["key"], "key"));
        return null;

      case "store.keys": {
        const prefix = input["prefix"];
        return this.options.data.keys(manifest.id, typeof prefix === "string" ? prefix : "");
      }

      case "store.entries": {
        /*
         * One page of pairs. Without it the only shape available was `keys` and
         * then a `get` per key — 2002 messages for the 1000 keys the store
         * allows, every one of them parsed on this daemon's event loop, for a
         * screen that asks to be re-read every few seconds. This is one query.
         *
         * `after` is a cursor and not an offset, so it is echoed back rather than
         * computed: the order is the store's own, and a caller that derives the
         * next cursor itself is a caller guessing at a collation.
         */
        const prefix = input["prefix"];
        const after = input["after"];
        return this.options.data.entries(
          manifest.id,
          typeof prefix === "string" ? prefix : "",
          typeof after === "string" ? after : "",
          MAX_PLUGIN_ENTRY_BYTES,
        );
      }

      case "net.fetch":
        return this.fetch(manifest, input);

      default:
        // Unreachable: `SCOPE_OF` is the gate and every key in it has an arm above.
        // A `default` that threw a different error here would be a second refusal
        // path for the same fact.
        throw new PluginApiError("unknown_method", `there is no ${method}`);
    }
  }

  /**
   * The one outbound door a plugin has, and the tap on it.
   *
   * ⚠ **This makes `src/` hold two `fetch` calls where it held one**, and that
   * count was a stated property — `enroll.ts` was the only one, which is what
   * makes a control-plane outage cost reachability rather than work in flight.
   * The property is unchanged in substance: this one is never called by the daemon
   * on its own behalf, never on a start path, never on a session path, and only
   * ever with a host somebody wrote into a manifest and approved at install. But
   * the *number* is now two and both are named, because a count nobody restates is
   * a count that becomes three.
   *
   * The allowlist is `manifest.net`, which `manifest.ts` has already checked is a
   * list of host names rather than addresses. What it does not do is stop a name
   * that resolves somewhere private — see `LOCAL_HOST` there for why that would be
   * a claim rather than a defence.
   */
  private async fetch(manifest: PluginManifest, input: Record<string, unknown>): Promise<unknown> {
    const raw = text(input["url"], "url");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new PluginApiError("invalid_url", "that is not a URL");
    }
    if (url.protocol !== "https:") throw new PluginApiError("insecure_url", "net.fetch speaks https only");
    if (!manifest.net.includes(url.hostname.toLowerCase())) {
      this.options.onWarning?.(`plugin ${manifest.id} tried to reach ${url.hostname}, which its manifest does not list`);
      throw new PluginApiError("host_not_allowed", `${url.hostname} is not in this plugin's net list`);
    }

    const now = Date.now();
    const seen = (this.fetches.get(manifest.id) ?? []).filter((at) => now - at < PLUGIN_FETCH_WINDOW_MS);
    if (seen.length >= PLUGIN_FETCH_BURST) {
      this.fetches.set(manifest.id, seen);
      throw new PluginApiError("fetch_rate_limited", `a plugin may make ${PLUGIN_FETCH_BURST} requests a minute`);
    }
    seen.push(now);
    this.fetches.set(manifest.id, seen);

    const init = (input["init"] ?? {}) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    const rawHeaders = init["headers"];
    if (rawHeaders !== null && typeof rawHeaders === "object") {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
        // Control characters refused rather than sent: a header value is spliced
        // into a request, and a CR there is request splitting. Same rule the upload
        // name sanitizer keeps for `Content-Disposition`.
        if (/[\x00-\x1f\x7f]/.test(String(value))) continue;
        headers[key] = String(value);
      }
    }

    const doFetch = this.options.fetchImpl ?? fetch;
    const stop = AbortSignal.timeout(PLUGIN_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: typeof init["method"] === "string" ? (init["method"] as string) : "GET",
        headers,
        body: typeof init["body"] === "string" ? (init["body"] as string) : undefined,
        // No redirect following: a redirect is a second host, chosen by the first
        // one, and the allowlist somebody approved names hosts rather than chains.
        redirect: "manual",
        signal: stop,
      });
    } catch (error) {
      throw new PluginApiError("fetch_failed", error instanceof Error ? error.message : String(error));
    }

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_PLUGIN_FETCH_BYTES) {
      // Cancelled before the throw, which is {@link readBounded}'s own rule one
      // refusal further on: a body nobody releases sits on its socket until the
      // 10s `AbortSignal.timeout` collects it, and a plugin may spend
      // `PLUGIN_FETCH_BURST` of them a minute.
      await response.body?.cancel().catch(() => {
        // Already ended or already errored; there is nothing left to release.
      });
      throw new PluginApiError("response_too_large", `a plugin may read at most ${MAX_PLUGIN_FETCH_BYTES} bytes`);
    }
    /*
     * ⚠ **Charged before each chunk is kept, never after the body is whole.**
     * `response.text()` was the measurement and it arrived too late to be one: a
     * server sending no `content-length` — the ordinary case for a chunked
     * response, and the case the header check above therefore cannot see, since
     * `Number(null ?? "0")` is `0` — could spend the whole 10s window growing
     * this daemon's heap before anybody refused it. `unpackArchive` already
     * charges a stream this way, for this reason.
     */
    const body = await readBounded(response, MAX_PLUGIN_FETCH_BYTES);
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  }

  private session(input: Record<string, unknown>): ManagedSession {
    return this.sessionBy(text(input["id"], "id"));
  }

  private sessionBy(id: string): ManagedSession {
    const managed = this.options.registry.get(id);
    if (managed === undefined) throw new PluginApiError("session_not_found", "no such session on this machine");
    return managed;
  }
}

/**
 * What a plugin is told about a session.
 *
 * The snapshot, minus nothing — a plugin holding `sessions.read` can already page
 * the transcript, so withholding fields from the summary would be theatre. It is a
 * function rather than a pass-through so that there is one place to change if that
 * ever stops being true.
 */
function summarize(managed: ManagedSession): unknown {
  return managed.snapshot();
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginApiError("bad_request", `${field} must be a non-empty string`);
  }
  return value;
}

function whole(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * A response body, refused the moment it passes `max` rather than once it is whole.
 *
 * The reader is cancelled on refusal so the socket is released instead of being
 * left for the timeout to collect.
 */
async function readBounded(response: Response, max: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let held = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      held += value.byteLength;
      if (held > max) {
        throw new PluginApiError("response_too_large", `a plugin may read at most ${max} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    // Both paths: a refusal must not leave the body draining, and a clean read
    // has nothing left to release.
    await reader.cancel().catch(() => {
      // The stream was already done or already errored. Either way there is
      // nothing to release and nothing anybody could do about it.
    });
  }
  return Buffer.concat(chunks).toString("utf8");
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
