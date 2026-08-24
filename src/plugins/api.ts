import { readFile } from "node:fs/promises";

import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_BYTES,
  diffFile,
  listChanges,
  probeRequestable,
  safeRelPath,
} from "../changes.js";
import { isAgentId } from "../acp/agents.js";
import { AgentAskError, type AgentAskRuns } from "../agentask.js";
import type { GitExec } from "../git.js";
import type { ElicitationContentValue, ManagedSession, SessionRegistry } from "../registry.js";
import { DESCRIBE_TIMEOUT_MS, probeFile } from "../stall.js";
import type { PluginOrigins } from "./origin.js";
import type { PluginManifest, PluginScope } from "./protocol.js";
import { MAX_PLUGIN_MESSAGE_BYTES } from "./runtime.js";
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

/**
 * What `net.fetch` will read.
 *
 * ⚠ **A quarter of the channel, because what a plugin is handed is the body
 * re-escaped as a JSON string with the whole headers object beside it.** This
 * said `1024 * 1024`, and that number was not generous but undeliverable:
 * `ForkedPlugin.send` refuses any message past {@link MAX_PLUGIN_MESSAGE_BYTES},
 * so a response between roughly 250 KiB and 1 MiB was fetched in full, spent one
 * of this plugin's thirty requests a minute, was read chunk by chunk into this
 * daemon's heap by {@link readBounded} — and was then dropped at delivery, with
 * `onChildMessage` telling the plugin its answer was "larger than the 262144
 * bytes this channel carries" for a call the published bound said was fine.
 * Measured inside the real `{"t":"answer",…}` envelope: 1 MiB of plain ASCII
 * serialises to 1,048,686 bytes against a 262,144-byte channel, so **no plugin
 * has ever been handed the megabyte this promised, in any encoding**.
 *
 * The arithmetic behind the quarter, measured rather than reasoned. The envelope
 * is 77 bytes. A body's worst *realistic* escape is 2x — a string that is all
 * `"`, which is the shape a JSON API answers in.
 * `Object.fromEntries(response.headers)` is bounded by undici charging the raw
 * header block against `http.maxHeaderSize`: 16 KiB by default, and raised only
 * by a `--max-http-header-size` that nothing in `deploy/` passes. At 64 KiB that
 * is 131,182 bytes with an ordinary `content-type`, and 213,113 for the other bad
 * case — a body of invalid UTF-8 carrying that same 16 KiB of headers, where
 * every bad byte lands as U+FFFD and costs three. Both fit.
 *
 * **Half the channel was tried first, since that is the relationship
 * {@link MAX_PLUGIN_ENTRY_BYTES} already has to it — but that one is charged
 * against data this daemon serialised itself, and this is charged against bytes
 * somebody else's server chose.** 128 KiB of `"` measures 262,254: over by 110.
 * Derived from the channel rather than written as `64 * 1024`, because a
 * relationship that has to hold is worse as two numbers that happen to agree.
 *
 * The one shape that still would not fit is a body of C0 control bytes, each of
 * which `JSON.stringify` writes as a six-character `\u00XX` escape — 393,326 at
 * this bound. That is refused **here**, against the assembled answer, rather than
 * left to `onChildMessage`: see the check at the end of {@link fetch}.
 */
export const MAX_PLUGIN_FETCH_BYTES = MAX_PLUGIN_MESSAGE_BYTES / 4;

/** How long `net.fetch` will wait for one. */
const PLUGIN_FETCH_TIMEOUT_MS = 10_000;
/** Requests per plugin per window, and how long the window is. */
const PLUGIN_FETCH_BURST = 30;
const PLUGIN_FETCH_WINDOW_MS = 60_000;

/**
 * Model asks per plugin per window.
 *
 * ⚠ **Six, against `net.fetch`'s thirty, and the gap is the point.** Thirty is a
 * budget for *requests*. Each of these spawns an agent — a node subprocess, an
 * ACP handshake and a model turn — so a plugin that mistook one limit for the
 * other would take the host down while staying inside a number that looked
 * similar. Six a minute is generous for the shape this exists for: one ask when a
 * session's first turn ends.
 *
 * This is the **per-plugin** half. `AgentAskRuns` holds the daemon-wide
 * concurrency cap, because that one is about the host rather than about who is
 * asking, and a budget spent by one plugin must not be a budget denied to the
 * machine.
 */
const PLUGIN_ASK_BURST = 6;
const PLUGIN_ASK_WINDOW_MS = 60_000;

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
  /*
   * The only method that spends the operator's quota rather than the machine's
   * access. See `PLUGIN_SCOPE_TEXT` in `packages/web/src/wire.ts` for the
   * sentence somebody reads before agreeing to it, which has to say so.
   */
  "model.complete": "model",
  /*
   * Under the same scope, and it earns it: reading an agent's model list starts
   * that agent — a subprocess and an ACP handshake — even though no prompt is
   * sent and no quota is spent. A method that can make a machine spawn is not one
   * a plugin holding nothing should reach.
   */
  "model.list": "model",
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
  /**
   * Where a write this plugin makes is stamped, so its own echo is not fanned
   * back to it.
   *
   * Absent is a real state rather than a misconfiguration, in the shape `ask`
   * already uses one line down: `harness.ts` and the drivers build an API with no
   * host behind it, and an unstamped write is exactly what those had before this
   * existed. A daemon that *has* a plugin host always passes one — `PluginHost`
   * omits this from the options it takes so that nobody can pass a second.
   */
  origins?: PluginOrigins;
  /**
   * Where a one-shot model request runs, or absent on a daemon that has none.
   *
   * Absent is a real state rather than a misconfiguration — `harness.ts` and the
   * offline drivers build an API with no asker — and it refuses rather than
   * throwing, in the shape `withPlugins` already uses for a daemon with no plugin
   * host at all.
   */
  ask?: AgentAskRuns;
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
  /** The same, for model asks. Separate map because they are separate budgets. */
  private readonly asks = new Map<string, number[]>();

  constructor(private readonly options: PluginApiOptions) {}

  async call(manifest: PluginManifest, method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
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
    return this.run(manifest, method, input, signal);
  }

  /**
   * ⚠ **`signal` is carried only as far as the two methods that spawn something.**
   * Every other arm here is a read, a write to this daemon's own SQLite, or one
   * bounded `fetch` — all of which finish in their own time and leave nothing
   * behind if nobody reads the answer. `model.complete` and `model.list` start an
   * agent subprocess, which is the one thing worth withdrawing when the plugin
   * that asked has been stopped. See `LivePlugin.hostCallsAbort`.
   */
  private async run(
    manifest: PluginManifest,
    method: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
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
          /*
           * ⚠ **`origin` is what stops this from being an unbounded loop.** A
           * `session.created` handler calling this fires `session.created` at the
           * same plugin, which calls this again — every turn of it a worktree and
           * an agent process, bounded only by `MAX_LIVE_SESSIONS`. It is an
           * argument rather than something stamped afterwards because
           * `registry.create` announces the session *before* it returns: by the
           * time this `await` resolves the hook has already been fanned.
           */
          const managed = await registry.create({
            agent: agent as never,
            cwd,
            worktree,
            branch,
            origin: manifest.id,
          });
          return summarize(managed);
        } catch (error) {
          throw new PluginApiError("session_create_failed", error instanceof Error ? error.message : String(error));
        }
      }

      case "sessions.prompt": {
        const managed = this.session(input);
        // Read before the claim below, so a malformed body throws without having
        // stamped anything.
        const prompt = text(input["text"], "text");
        /*
         * ⚠ **The turn is stamped *before* the call and put back if the call was
         * refused, and the ordering is load-bearing.** `src/agentask.ts`'s header
         * records this same recursion against a session nobody can address; this
         * is the one a plugin is handed on purpose, and without the stamp a
         * `turn.ended` handler calling this does it for ever, every lap a real
         * model turn.
         *
         * The tempting shape is to claim *after* `accepted`, reasoning that
         * `pump` suspends at its `for await` before anything can be recorded. That
         * is not true: `prompt` fires `pump` with `void`, and with no attachments
         * — which is every prompt made from here — the `await` in `pump`'s first
         * statement is never evaluated, so it runs straight into a synchronous
         * `turn_end` append on the cancelled path. A claim written after this
         * returned would land after that hook had already fanned.
         *
         * The undo is what makes claiming early safe: a prompt refused as `busy`
         * would otherwise overwrite the claim of the turn that really is running,
         * and suppress *its* `turn.ended` instead.
         *
         * `cancel` and `stop` are deliberately not stamped: each ends its own
         * loop, and a plugin that stopped hearing them would lose the only
         * confirmation it has that its act landed.
         */
        const undo = this.options.origins?.claimTurn(managed.id, manifest.id);
        const result = managed.prompt(prompt);
        if (result.kind !== "accepted") {
          undo?.();
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
      case "model.complete":
        return this.complete(manifest, input, signal);

      case "model.list":
        return this.listModels(manifest, input, signal);

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
   * the *number* is now three and all three are named — `enroll.ts`, this one, and
   * `fetchArchive` in `plugins/source.ts` — because a count nobody restates is a
   * count that grows. It said two, and it became three exactly as written.
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
      /*
       * ⚠ **The one gate that runs before a byte of the body is read**, which is
       * why the number it compares against has to be the *deliverable* size
       * rather than the readable one. While {@link MAX_PLUGIN_FETCH_BYTES} said
       * 1 MiB, a 300 KiB response that honestly declared its length walked past
       * here, was read whole, and was refused by `ForkedPlugin.send` at delivery
       * instead — the plugin paid for the request, the daemon paid for the heap,
       * and the sentence it got back named a channel it had never been told
       * about. `daemoncheck` pins that this arm never pulls the stream at all.
       */
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
    const answer = { status: response.status, headers: Object.fromEntries(response.headers), body };
    /*
     * ⚠ **The bound above is on bytes off the wire; this one is on bytes into the
     * channel, and they are not the same number.** A body of C0 control bytes is
     * a six-character `\u00XX` escape each — 393,326 at
     * {@link MAX_PLUGIN_FETCH_BYTES} against a 262,144-byte channel — so without
     * this the answer is assembled, charged and buffered and then dropped by
     * `ForkedPlugin.send`, and the plugin is told about a limit it was never given
     * a number for. Refused here instead, with the code `docs/PLUGINS.md`
     * publishes, so "refused, never truncated" needs no caveat.
     *
     * The slack is for the `{"t":"answer","id":N,…}` the runtime wraps this in,
     * which is 77 bytes at one digit of id and grows with it.
     */
    if (Buffer.byteLength(JSON.stringify(answer), "utf8") > MAX_PLUGIN_MESSAGE_BYTES - 128) {
      throw new PluginApiError(
        "response_too_large",
        `that response does not fit the ${MAX_PLUGIN_MESSAGE_BYTES} bytes a plugin is answered in`,
      );
    }
    return answer;
  }

  /**
   * One question to an agent this machine is signed in to, and the text back.
   *
   * ⚠ **Two fields, and the two a caller asked for and did not get are the
   * interesting part.** `system` and `maxOutputTokens` were both requested and
   * both refused, because ACP can express neither: `session/new` takes `cwd`,
   * `mcpServers` and `_meta`, and `session/prompt` takes content blocks and no
   * token ceiling. Accepting either would have meant a field that renders,
   * validates and does nothing — which is precisely the class of defect
   * `ClampedView.substituted` exists to stop a plugin author shipping. A preamble
   * is the first paragraph of `prompt`, and the output bound is on **bytes**,
   * which this daemon can actually enforce.
   *
   * The refusal codes are the contract, not a courtesy. This call is made
   * fire-and-forget — the plugin's hook returns before it answers, or the 10 s
   * invocation deadline kills it — so nothing downstream is waiting to report a
   * failure, the session it runs on is unaddressable, and it writes to no
   * transcript. The calling plugin's own screen is the **only** place a refusal
   * can ever appear, and it can only get there through a code and a sentence.
   */
  private async complete(
    manifest: PluginManifest,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const ask = this.options.ask;
    if (ask === undefined) {
      throw new PluginApiError("model_unavailable", "this daemon cannot run model requests");
    }
    const agent = text(input["agent"], "agent");
    if (!isAgentId(agent)) {
      // Refused here rather than passed through, so an id this build has never
      // heard of is named as such instead of arriving as "no such agent on this
      // machine" — which reads as *not installed* and sends somebody to install
      // something that does not exist.
      throw new PluginApiError("model_agent_unknown", `${JSON.stringify(agent)} is not an agent this daemon knows`);
    }
    const prompt = text(input["prompt"], "prompt");
    /*
     * ⚠ **Optional, and its absence has three spellings that all mean the same
     * thing.** Left out, `null`, or `""` — a field omitted from a JSON body, a
     * `ctx.store.get` for a key nobody has written, and a form submitting an
     * untouched control — all mean *the agent's own default*. Choosing one of
     * them as the spelling would make the other two an error a plugin author
     * discovers in production, which is exactly what the store contract cost
     * somebody a day of. `AgentAskRuns.ask` trims and applies the same rule; this
     * only has to avoid turning absence into a `bad_request` on the way past.
     */
    const model = typeof input["model"] === "string" ? input["model"] : "";

    /*
     * The window, in `net.fetch`'s shape and for its reason: per plugin, so one
     * plugin's loop cannot spend another's budget — a bug whose symptom would
     * otherwise appear in the wrong place entirely. Spent *before* the call, and
     * the timestamp is recorded whatever the outcome: a refusal that cost an
     * agent spawn has cost the machine the same either way.
     */
    this.spend(manifest);

    try {
      return await ask.ask(agent, prompt, model, signal);
    } catch (error) {
      /*
       * The code travels, verbatim. `AgentAskRuns` is what knows whether the
       * agent was signed out, the deadline expired or the answer was too large,
       * and re-deciding that here would be a second opinion formed with less
       * information. Same shape `pluginInstallStatus` keeps one layer up.
       */
      if (error instanceof AgentAskError) throw new PluginApiError(error.code, error.message);
      throw new PluginApiError("model_failed", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Which models an agent on this machine offers.
   *
   * ⚠ **This spawns an agent, which is why it is behind the `model` scope and
   * inside the same burst window as an ask.** No prompt is sent and no quota is
   * spent — the session exists only long enough for the handshake — but a node
   * subprocess is a node subprocess, and a method that can make a machine spawn
   * without a budget is a method somebody loops. `AgentAskRuns` caches the answer
   * for ten minutes and holds the daemon-wide concurrency cap; this is the
   * per-plugin half of the same bound.
   *
   * ⚠ **An empty list is an answer, not a failure.** kimi publishes no model
   * control at all, and a plugin drawing a picker has to be able to say *this
   * agent does not offer one* rather than showing an error where a dropdown was.
   * The refusal belongs where a model is actually *used*, which is the one place
   * there is a value to name.
   */
  private async listModels(
    manifest: PluginManifest,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const ask = this.options.ask;
    if (ask === undefined) {
      throw new PluginApiError("model_unavailable", "this daemon cannot run model requests");
    }
    const agent = text(input["agent"], "agent");
    if (!isAgentId(agent)) {
      // Refused here rather than passed through, so an id this build has never
      // heard of is named as such instead of arriving as "no such agent on this
      // machine" — which reads as *not installed*.
      throw new PluginApiError("model_agent_unknown", `${JSON.stringify(agent)} is not an agent this daemon knows`);
    }
    this.spend(manifest);
    try {
      return { models: await ask.models(agent, signal) };
    } catch (error) {
      // The code travels verbatim, exactly as it does for an ask: `AgentAskRuns`
      // is what knows whether the agent was signed out or the machine was busy.
      if (error instanceof AgentAskError) throw new PluginApiError(error.code, error.message);
      throw new PluginApiError("model_failed", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * One unit of this plugin's model budget, spent before the call rather than
   * after it.
   *
   * ⚠ **Before, and the timestamp is recorded whatever the outcome**: a refusal
   * that cost an agent spawn has cost the machine the same as a success. Shared
   * by both model methods rather than copied, because two windows keyed on the
   * same map with two different sets of arithmetic is how one of them comes to be
   * counting a different thing.
   */
  private spend(manifest: PluginManifest): void {
    const now = Date.now();
    const seen = (this.asks.get(manifest.id) ?? []).filter((at) => now - at < PLUGIN_ASK_WINDOW_MS);
    if (seen.length >= PLUGIN_ASK_BURST) {
      this.asks.set(manifest.id, seen);
      throw new PluginApiError(
        "model_rate_limited",
        `a plugin may make ${PLUGIN_ASK_BURST} model requests a minute`,
      );
    }
    seen.push(now);
    this.asks.set(manifest.id, seen);
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
