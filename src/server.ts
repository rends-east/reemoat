import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { IncomingMessage, Server } from "node:http";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context, type Handler, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { WSContext } from "hono/ws";
import type { WebSocket as RawWebSocket } from "ws";
import { AgentUnavailableError, type AgentId } from "./acp/agents.js";
import {
  hostable,
  routedModelNaming,
  systemSecretFor,
  type CustomAgent,
  type SystemId,
  type AgentStripEntry,
  type SystemStores,
} from "./acp/systems.js";
import { AgentAskError, type AgentCapabilityReader } from "./agentask.js";
import type { AgentLoginSupport } from "./runtime/types.js";
import { isAuthRequiredMessage, SystemRoutingError } from "./session.js";
import { type AgentCredentialStore, type AgentLoginRuns } from "./agentauth.js";
import { AUTH_LEEWAY_MS, hasScope, type Principal, type Scope, type TokenVerifier } from "./auth.js";
import {
  importArchive,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_UNPACKED_BYTES,
  PLUGIN_LIMITS,
  type ImportOutcome,
} from "./archive.js";
import { PluginApiError } from "./plugins/api.js";
import type { LivePlugin, PluginHost } from "./plugins/host.js";
import { PLUGIN_API_VERSION, type PluginResult } from "./plugins/protocol.js";
import { isSourceRefusal, readConsent, readSource } from "./plugins/source.js";
import { listDirs, makeDir, PathError, resolveCwd } from "./browse.js";
import { DESCRIBE_TIMEOUT_MS, probeExists, probeFile, probeRealpath } from "./stall.js";
import {
  cancelBody,
  contentDispositionFor,
  MAX_PROMPT_ATTACHMENTS,
  MAX_SESSION_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS_PER_SESSION,
  parseMime,
  sanitizeUploadName,
  UPLOAD_RATE_BYTES,
  UPLOAD_RATE_WINDOW_MS,
  type Uploads,
  type UploadRow,
} from "./uploads.js";
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, CORS_MAX_AGE_SECONDS } from "./cors.js";
import { RELAY_PROTOCOL_VERSION } from "./relay/protocol.js";
import { DAEMON_VERSION } from "./version.js";
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_BYTES,
  diffFile,
  listChanges,
  probeRequestable,
  safeRelPath,
} from "./changes.js";
import { estimateBytes, oldestAvailable, type StoredEvent } from "./events.js";
import { GitError } from "./git.js";
import {
  bearerToken,
  boundedInt,
  describeError,
  errorEnvelope,
  gzipResponses,
  jsonError,
  readJsonObject,
} from "./http.js";
import { containedInResolved } from "./paths.js";
import { inspectWorkspace, listWorktrees, removeWorkspace, WorktreeError, type RemoveRefusal } from "./worktree.js";
import {
  autoResumable,
  awaitingHuman,
  describeResumeFailure,
  MAX_TITLE_CHARS,
  SessionLimitError,
  StartTimeoutError,
  type ElicitationAnswerBody,
  type ElicitationContentValue,
  type ManagedSession,
  type PermissionAnswer,
  type SessionRegistry,
  type SessionSnapshot,
  type WorktreePolicy,
} from "./registry.js";

/**
 * Outbound queue bounds.
 *
 * These used to be justified as "deliberately larger than the log, so a `since=0`
 * attach to a full log can never overflow on arrival". That argument is gone with
 * the log's window — a session's log is unbounded now (see `DEFAULT_MAX_EVENTS`),
 * so there is no size to be larger than. What replaces it is `ATTACH_REPLAY_MAX`:
 * the *attach* is bounded instead of the history, which is the right way round —
 * a socket is a live channel and a transcript is a record, and it was only ever
 * the socket that could not carry an arbitrary amount at once.
 */
const MAX_QUEUE_EVENTS = 8_000;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
/**
 * How much history one attach will replay down the socket.
 *
 * Well under `MAX_QUEUE_EVENTS`, because `attach` drains its whole backlog into
 * that queue in one synchronous block and everything past the bound would
 * `collapse()` — reporting `lagged{slow_consumer}` about a client that had not
 * been given the chance to be slow. That lie is exactly what this constant exists
 * to prevent, and it used to be prevented by capping the log instead.
 *
 * Below this the socket carries everything, which is every ordinary attach: a
 * client attaches at its own cursor and is a handful of events behind. Above it,
 * the events are **still there** and the client is told to fetch them over HTTP —
 * see the `backlog` reason. Nothing is destroyed and nothing is silently skipped.
 *
 * **It bounds the count and `MAX_QUEUE_BYTES` bounds the bytes, and only one of
 * those two is this constant's to give.** 2000 events of transcript is well under
 * 8000, but at 128 KiB an event it is 250 MiB against a 16 MiB queue: a phone
 * waking 1200 tool-call bodies behind crosses the byte ceiling on the drain and
 * `collapse()` fires anyway. That is not a slow consumer — nothing has been sent
 * yet — so the collapse takes the reason from *who is enqueuing*: a replay says
 * `backlog`, which is the frame that is true, and the client refetches over HTTP
 * instead of drawing "events lost" over a conversation the daemon still holds
 * every byte of. Which is what this constant promises and could not deliver on
 * its own.
 */
const ATTACH_REPLAY_MAX = 2_000;
const BATCH_MAX_EVENTS = 200;
const BATCH_MAX_BYTES = 512 * 1024;
const SOCKET_HIGH_WATER = 1024 * 1024;
const PING_INTERVAL_MS = 20_000;
const COLLAPSE_WINDOW_MS = 30_000;
/**
 * Events a history page may carry, and it is **`EVENTS_PAGE_BYTES` that bounds a
 * page** — this only decides how many round trips a conversation costs.
 *
 * A client's window spans this many seqs (`HISTORY_PAGE`, mirrored), so at 500 a
 * 33 898-event session was 68 sequential requests, each a full relay round trip
 * before the next could be asked for. Measured on the fleet's largest conversation:
 * 4.53 MiB across 33 898 events, 140 B mean — so the byte cap was nowhere near
 * biting and the count was spending sixty-odd round trips for nothing. At 5000 the
 * same session is seven requests.
 *
 * Raising it costs no memory here: `read` fills a page through `iterate()` and
 * breaks on the byte budget, so it materialises the byte cap plus one row whatever
 * this says. A heavy conversation therefore degrades to exactly the request count
 * it costs today, because the byte cap is what governs it.
 */
export const EVENTS_PAGE_LIMIT = 5_000;
/**
 * ⚠ **Coupled to `STREAM_WINDOW_BYTES`, and smaller than it on purpose.** Never
 * raise this one alone.
 *
 * A relayed response crosses one h2 stream, whose window is credit-based — and a
 * response *larger than one window* depends on a `WINDOW_UPDATE` that Node does
 * not reliably produce for a stream being read through `http.request`'s socket
 * interface, which is what the relay does. Q6.104 has the mechanism and the
 * measurements; the short version is that a page bigger than a window can wedge,
 * and a page that fits cannot.
 *
 * This bounds the page **before** gzip and gzip cannot meaningfully expand its
 * input (deflate's stored-block worst case is ~0.01%), so `768 KiB < 1 MiB` holds
 * for the compressed bytes that actually cross the tunnel — with 256 KiB spare for
 * the response headers riding the same stream.
 *
 * It was 2 MiB, and at 2 MiB a real 2000-event page compressed to 437 390 bytes —
 * past the old 256 KiB window, which is how this was found. The cost of the change
 * is round trips and nothing else: the fleet's largest conversation (4.53 MiB) goes
 * from three requests to six, against the 68 it cost before `EVENTS_PAGE_LIMIT`
 * rose. Nothing is truncated and no history becomes unreachable — `fillWindow`
 * already treats a byte-capped page as an unknown number of requests and spends
 * its budget per request rather than per window.
 */
const EVENTS_PAGE_BYTES = 768 * 1024;
const MAX_PROMPT_CHARS = 100_000;
/**
 * Ceiling on a pasted credential or a typed login code.
 *
 * Generous — a `claude setup-token` OAuth token is a few hundred bytes — but
 * present, because both of these end up as an argv element or a stdin write and
 * neither has any business being megabytes.
 */
const MAX_CREDENTIAL_CHARS = 8_192;

/**
 * Ceiling on a model id in an assembled agent.
 *
 * Nothing validates the *content* — for a native pairing the list belongs to a
 * CLI that updates on its own schedule, for a routed one to somebody else's API
 * — so a bound on the length is the only thing this route can honestly assert.
 * Real ids are tens of characters; this is room for an ARN.
 */
const MAX_MODEL_CHARS = 256;

/** Ceiling on what somebody calls an agent they assembled. */
const MAX_AGENT_NAME_CHARS = 80;

/**
 * Ceiling on how many positions the agent strip may remember.
 *
 * Not a limit on how many agents a machine may have. It is the bound on what a
 * *body* may ask this daemon to write in one statement, which is a different
 * question and the only one a route can answer.
 *
 * ⚠ **It has to sit clear of what the client always sends, and at 200 it did
 * not.** `custom_agents` is deliberately unbounded and the strip screen writes the
 * **whole** list on every action — that is what makes the next read stable — so a
 * machine holding 198 assembled agents would have had every drag, every hide and
 * every removal answered `400`, leaving that screen permanently read-only with an
 * error line and no way out of it. A thousand is past any plausible fleet and
 * still far short of a transaction worth noticing.
 */
const MAX_STRIP_ENTRIES = 1_000;

/**
 * Ceiling on one remembered `ref`.
 *
 * The strip stores an id it never validates — that is the whole design, see
 * `AgentStripEntry` — so this is the only thing standing between an unknown id
 * and an essay in a row. Real ones are `ca_` plus eight hex, a one-word harness
 * id, or a harness a plugin added.
 *
 * ⚠ **It was 64 and that is one short of the longest legal id.** A contributed
 * harness is `<pluginId>:<localId>` and `manifest.ts` bounds each half at 32, so
 * the longest is 65 — which this route would have refused with `400 bad_request`,
 * on the one write the whole strip screen makes, leaving it permanently unable to
 * save an order. The number is not derived from the manifest's bound because that
 * bound is somebody else's subject; what this is, is comfortably past every id
 * shape that exists.
 */
const MAX_STRIP_REF_CHARS = 96;

/**
 * How long a write route may spend asking a harness what it accepts.
 *
 * ⚠ **Under the client's own budget on purpose.** `packages/web/src/machine.ts`
 * gives `POST`/`PATCH /custom-agents` `SLOW_ROUTE_TIMEOUT_MS`, 90s; `agentask.ts`
 * would let one of these run for `ASK_TIMEOUT_MS`, 120s. A handler outliving its
 * caller on a route that *creates* a row is how a retry makes a duplicate preset,
 * and `custom_agents` has no uniqueness constraint to catch one. Refusing at 60s
 * leaves room for the answer and for the refusal to get back.
 */
const CAPABILITY_READ_BUDGET_MS = 60_000;
/** A single path segment. Generous next to any filesystem's own limit. */
const MAX_DIR_NAME_CHARS = 255;
/** A whole path. `PATH_MAX` is 4096 on Linux and 1024 on macOS; this is neither
 *  filesystem's limit, it is a ceiling on what a request may hand to `realpath`. */
const MAX_PATH_CHARS = 4_096;

/**
 * The largest file this daemon will serve.
 *
 * **It happens to equal `MAX_UPLOAD_BYTES` now, and that is a coincidence rather
 * than a coupling** — the two bound different things and neither may be changed
 * by reading the other. This said "deliberately a different number", which was
 * true while uploads were 25 MiB and stopped being true when they became 100 MiB;
 * the *reasons* are what were different and they are unchanged. That one bounds
 * what a client may push onto this machine's disk, against a session budget and
 * an inode ceiling that both survive the request. This bounds a
 * bearer-token-readable read of an entire workspace, where the cost of no bound
 * is one tunnel stream held open for as long as somebody likes — and there are
 * 256 of them per machine, shared with every session's WebSocket. The client
 * refuses at the same number, from `content-length`, before it pulls a `Blob`
 * into a phone's memory.
 */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/**
 * The most any request other than an upload may carry.
 *
 * ⚠ **This daemon had no request-body bound at all**, and the control plane added
 * one for exactly the reason that applies here more strongly. Every JSON route
 * reads the whole body before it looks at it, and this process owns the agent
 * subprocesses, the event log and the relay tunnel — so an unbounded body is one
 * caller deciding how much memory the thing running their agents holds.
 *
 * `REEMOAT_AUTH` decides *who* may ask, which is a different question from *how
 * much*: a grant is full access, and the machine is reached from a phone over a
 * relay. "The caller has a credential" is not a bound.
 *
 * 1 MiB, wider than the control plane's 256 KiB because the bodies here are
 * legitimately larger — a prompt with several attachment references, a
 * permission answer carrying an agent's own option list — and small enough to
 * still be a number. The largest non-upload body any route reads today is a
 * prompt, and `MAX_PROMPT_CHARS` bounds it well under this.
 *
 * **The streaming routes are excluded and must stay excluded**, and there are
 * three: `POST /sessions/:id/uploads` streams to disk against
 * `MAX_UPLOAD_BYTES` (100 MiB) with its own counter, `POST /fs/import` does the
 * same against `MAX_IMPORT_BYTES`, and `POST /plugins` against
 * `PLUGIN_LIMITS.maxBytes`. Wrapping any of them here would refuse every
 * legitimate request at 1 MiB, or buffer the whole thing to check a limit the
 * route is already enforcing a better way. What replaces the bound for them is
 * the release below — see the middleware that grants the exemption.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The routes that read their body as a stream, and so may not be bounded above.
 *
 * A predicate rather than a condition inlined into the middleware, because there
 * are three of them now and the rule they share — *this route counts its own
 * bytes, and its body is released however it is refused* — is the kind that gets
 * half-applied when a fourth arrives. All three are POST; matching the method as
 * well keeps a GET on the same path from inheriting the exemption.
 *
 * **Adding a route here is the whole of adding a route here.** The second half of
 * the rule used to be the handler's to keep, one `refuse()` wrapper per route,
 * which is why it was kept for the three handlers and by nothing above them; it
 * now hangs off this predicate, so a fourth string in this `return` buys both
 * halves at once.
 */
function isStreamingRoute(method: string, path: string): boolean {
  if (method !== "POST") return false;
  // `POST /plugins` is the third, and it owes what the other two owe: its own
  // counter (`PLUGIN_LIMITS.maxBytes`, charged before each write) and a body
  // cancelled on every refusal. See `PluginHost.install`.
  return /^\/sessions\/[^/]+\/uploads$/.test(path) || path === "/fs/import" || path === "/plugins";
}

/**
 * Hono's per-request variables. `principal` is set by the auth gate and read by
 * every route that needs to know who is asking, so no handler ever sees a raw
 * token.
 */
type AppEnv = { Variables: { principal: Principal } };

export interface ServerOptions {
  registry: SessionRegistry;
  /**
   * Decides who is asking. The shared secret and control-plane-signed tokens
   * are both implementations of this — the server does not know which it has.
   */
  verifier: TokenVerifier;
  instanceId: string;
  startedAt: number;
  /** Both tunable so the truncation paths can be exercised without 2000 files. */
  maxChangedFiles?: number;
  maxDiffBytes?: number;
  /**
   * Where a pasted agent credential is kept.
   *
   * Optional because the offline drivers run without a database and have no
   * business growing one. Absent, the paste routes answer 503 rather than
   * pretending to save.
   */
  credentials?: AgentCredentialStore;
  /**
   * Where a system's key is kept, and where assembled agents live.
   *
   * One option rather than two because the two are one screen and one absence:
   * a daemon with no database can neither hold a key nor hold a preset, and
   * splitting them would let half the feature answer 503 while the other half
   * looked live. Absent, every route below answers `503 systems_unavailable`
   * **except `GET /systems`**, whose table is compiled in rather than stored:
   * it answers honestly with `keySet: false` everywhere rather than refusing,
   * and `daemoncheck` skips it by name in the no-store sweep for that reason.
   * A client on a store-less daemon therefore sees a 200 here beside a 503
   * from `GET /custom-agents`, which is the pair the New session strip reads.
   */
  systems?: SystemStores;
  /**
   * Where a sessionless agent question runs, or nothing.
   *
   * Needed by `GET /agents/capabilities`, which spawns an agent to read what it
   * offers. Absent — every offline driver — that route answers 503 and the
   * screen that assembles an agent says the machine cannot be asked, rather than
   * drawing an empty picker that looks like an answer.
   */
  asks?: AgentCapabilityReader;
  /**
   * Interactive agent logins in progress.
   *
   * Optional for the same reason. Note what it is not: this is only the run
   * registry. Whether a login can be *driven* is `SessionRuntime.loginSupported`,
   * because that is a question about the host having a pty to allocate rather
   * than about whether there is somewhere to record the run.
   */
  logins?: AgentLoginRuns;
  /**
   * Files staged for a prompt.
   *
   * Optional for the same reason as the two above: the offline drivers run with
   * no database and no upload root, and the routes answer 503 rather than
   * pretending to store anything. A prompt naming an attachment without one is a
   * 400, not a silently text-only turn.
   */
  uploads?: Uploads;
  /**
   * What `GET /fs/roots` offers and `GET /fs/list` will show.
   *
   * A narrowing of the browse surface, never a boundary — an agent runs as this
   * user and can reach anything they can, so `resolveCwd` is deliberately not
   * confined to these. Defaults to the daemon user's home.
   */
  roots?: string[];
  /**
   * Where plugins live, or nothing.
   *
   * Optional like `credentials`, `logins` and `uploads`, and for their reason: a
   * daemon built without one answers `503` on the plugin routes rather than
   * pretending there are none. `REEMOAT_PLUGINS=0` is what produces that on a real
   * machine, and every driver that does not care gets it by omission.
   */
  plugins?: PluginHost | null;
}

export interface AppBundle {
  app: Hono<AppEnv>;
  injectWebSocket: (server: Server) => void;
}

export function createApp(options: ServerOptions): AppBundle {
  const { registry, verifier, instanceId, startedAt } = options;
  const credentials = options.credentials;
  const systems = options.systems ?? null;
  const asks = options.asks ?? null;
  const logins = options.logins ?? null;
  const uploads = options.uploads ?? null;
  const roots = options.roots ?? [homedir()];
  const plugins = options.plugins ?? null;
  const maxChangedFiles = options.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES;
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const app = new Hono<AppEnv>();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  /*
   * ⚠ **The third `ws` surface in this fleet, and the last one still unbounded.**
   * `MAX_TUNNEL_MESSAGE_BYTES` caps what the relay assembles from a daemon and what
   * a daemon assembles from the relay; this socket — the browser's own
   * `/sessions/:id/stream` — terminates *here*, because the relay pipes CONNECT
   * bytes without parsing them. `@hono/node-ws` builds `new WebSocketServer({
   * noServer: true })` with no `maxPayload`, so `ws`'s 100 MiB default stood.
   *
   * What that allowed is the same shape documented on `MAX_TUNNEL_MESSAGE_BYTES`:
   * a client sending a fragmented message that never sets FIN parks up to 100 MiB
   * inside `ws`, while control frames keep the heartbeat answering. At
   * `MAX_STREAMS_PER_SUBJECT` sockets, in the process that owns the agent
   * subprocesses, the event log and the SQLite store, on a machine with no
   * container and no memory limit.
   *
   * **Any inbound message at all is already a protocol violation** — this socket is
   * read-only by design (`.claude/rules/relay.md`: "Everything that mutates state is
   * an HTTP request, because `ws.send()` into a half-open socket succeeds
   * silently"), and the handler below registers `onOpen`, `onClose` and `onError`
   * with no `onMessage`. So the bound is not a capacity question and gets no number
   * of its own: `MAX_BODY_BYTES` is what this daemon already says one request may
   * carry, and it is orders of magnitude above anything that should arrive here.
   *
   * Assigned rather than passed because the server is constructed inside the
   * adapter; `ws` reads `this.options.maxPayload` at `completeUpgrade`, so this
   * takes effect for every connection.
   */
  wss.options.maxPayload = MAX_BODY_BYTES;

  /*
   * The last resort, and **only** after every per-route mapping has declined.
   *
   * Hono's default handler answers a plain-text `Internal Server Error` with no
   * body shape at all — and `packages/web/src/http.ts` says out loud that every
   * client in this system reads a refusal by its `error.code`. So an unmapped
   * throw was not merely a 500; it was a 500 that `ApiError` cannot parse,
   * `meansMachineGone` cannot classify and `errorText` cannot render, which is
   * how "something went wrong" reaches a phone with nothing to act on. It is
   * reachable today: `gitError` rethrows anything that is neither a
   * `WorktreeError` nor a `GitError`, and both `/fs/*` routes rethrow once
   * `errnoError` returns null.
   *
   * ⚠ **This is deliberately not the thing Q1.50 refused.** That argument is
   * about the *control plane* and about an envelope renderer used
   * **instead of** per-route mapping: there, a catch-all lets the next unmapped
   * constraint violation land as a generic 500 that nobody notices, so the fix
   * was to map `users.name UNIQUE` at the route. Nothing is unmapped here as a
   * result of this: every existing mapping stays exactly where it is and runs
   * first, and this fires only where all of them have already declined. The code
   * is `internal_error` precisely so that it stays legible as "nothing mapped
   * this" — a signal that a mapping is missing, not a substitute for one.
   *
   * An `HTTPException` is returned as its own response rather than rewritten:
   * that carries a status somebody chose on purpose, and a backstop that
   * overwrites an intent is a replacement. Nothing in this daemon throws one
   * today, which is exactly why the arm is written rather than assumed.
   *
   * Silent, because nothing in `src/` writes to stderr — this replaces Hono's
   * own `console.error`, so the message travels in the envelope instead.
   */
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    // `c.json` rather than `jsonError`: 500 is deliberately not in `ErrorStatus`,
    // which is the list of statuses a route may *refuse* with. Reaching here is
    // not a refusal — it is this daemon failing to answer — and widening that
    // union would offer 500 to every route as a normal outcome.
    return c.json(errorEnvelope("internal_error", describeError(error)), 500);
  });

  /**
   * Cross-origin access, mounted **before** the auth gate.
   *
   * A preflight carries no credential — that is what a preflight is — so it has to
   * be answered before anything asks for one. Hono's `cors()` short-circuits
   * `OPTIONS` itself and returns 204 without calling `next()`, so the gate below
   * never sees one. On every other method it only sets response headers, which
   * survive onto the gate's own 401 because Hono copies headers forward when a
   * handler replaces the response — and a 401 nobody can read is a 401 nobody can
   * act on.
   *
   * See `cors.ts` for why the origin is `*`: there are no cookies here, so there
   * is no ambient authority for a wildcard to leak.
   */
  /*
   * gzip first, so it wraps everything below including the auth gate's refusals.
   *
   * The one thing it must not touch is a download, and it does not: `compressible`
   * keys on the response's content type, and those routes send
   * `application/octet-stream` — see the predicate for why the client's own
   * `content-length` guard depends on that.
   */
  app.use("*", gzipResponses());

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: [...CORS_ALLOW_METHODS],
      allowHeaders: [...CORS_ALLOW_HEADERS],
      maxAge: CORS_MAX_AGE_SECONDS,
      credentials: false,
    }),
  );

  /*
   * The body bound, registered after gzip and CORS so a refusal is compressed and
   * *labelled* like every other error, and *before* the auth gate: an
   * unauthenticated caller pushing bytes is the case this exists for, and making
   * them buy a credential first would be a bound on the wrong thing.
   *
   * ⚠ **CORS has to come first, and this sat above it for a release.** `onError`
   * answers without calling `next()`, so every middleware registered below it is
   * skipped — including the one that writes `access-control-allow-origin`. The
   * relay does not repair that: `proxy.ts` pipes the daemon's own headers through
   * untouched, by design. So the browser saw an opaque network failure instead of
   * the `payload_too_large` envelope it can read, on the one refusal whose whole
   * value is that a client can tell what happened. Nothing catches this, because a
   * driver calls `app.fetch` directly and reads a body no browser would have
   * shown it.
   *
   * The streaming routes carry their own — see `MAX_BODY_BYTES` — so they are
   * skipped by path rather than by re-registering this on every other route,
   * which would be a list that silently stops covering a route somebody adds
   * later.
   */
  const boundedBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      jsonError(c, 413, "payload_too_large", `a request body may not exceed ${MAX_BODY_BYTES} bytes`, {
        limit: MAX_BODY_BYTES,
      }),
  });
  /*
   * The exemption and the obligation it creates, in one middleware, because they
   * are one rule: **a route nothing bounds above must have its body released, by
   * whoever ends up answering.**
   *
   * ⚠ **The obligation used to live in the three handlers and therefore did not
   * hold.** Each of them wraps its refusals in a `refuse()` that cancels first,
   * and that half was complete. The gap was everything *above* a handler: the
   * auth gate and `requireScope` both answer with a bare
   * `return jsonError(...)`, having never touched the stream. So a caller with an
   * expired token, or a valid one lacking `machine:admin`, could open `POST
   * /plugins` — or `/fs/import`, or an upload — with an arbitrarily large body,
   * be refused in about a millisecond, and leave every byte of it unread. The
   * relay grants a stream's h2 window **on consumption**, so a reader that stops
   * parks the sender at one `STREAM_WINDOW_BYTES` (1 MiB); the next valve is the
   * tunnel's `MAX_TUNNEL_BUFFERED_BYTES` (8 MiB) socket check, and that closes the
   * **whole tunnel for this machine** — every other session on it goes too. One
   * caller may hold `MAX_STREAMS_PER_SUBJECT` (64) streams to spend on it.
   *
   * **Here rather than inside each middleware, and that is the point of the
   * shape.** Cancelling in the auth gate and in `requireScope` fixes today's two
   * refusals and is silently incomplete the day a third middleware refuses above
   * a handler — the same half-application `isStreamingRoute`'s docblock worries
   * about one axis over. Attached to the exemption, the two halves cannot come
   * apart: whatever earns the exemption on the way down pays for it on the way
   * up, for every answer produced by anything below this line, and a fourth
   * streaming route inherits both by adding one string to the predicate.
   *
   * `finally` rather than a line after `await next()`, because `next()` is not
   * guaranteed to return normally and the throwing path is the one where the body
   * is least likely to have been read. Stated as the property rather than as a
   * claim about how `compose` routes a particular error — the mechanism differs by
   * whether what was thrown is an `Error`, and `finally` is correct without
   * needing to know which.
   *
   * Unconditional rather than "only when the answer is a refusal", and measured
   * on this adapter (`@hono/node-server` 1.19.17) rather than assumed: cancelling
   * a body the handler already drained resolves in 0 ms and changes nothing — a
   * fully-read `IncomingMessage` is `complete`, so the `destroy()` underneath
   * never reaches the socket — and cancelling one a handler left locked rejects
   * with `TypeError: Invalid state: ReadableStream is locked`, which `cancelBody`
   * swallows. ⚠ **That last one is the state where this guard silently does not
   * release the body**, and it is harmless only because every streaming handler
   * reads with `for await`, which releases its reader at the end. A handler that
   * took a `getReader()` and abandoned it would leave a parked sender that looks
   * exactly like the defect this guard exists to prevent. A 64 MiB body refused 403 by a middleware that cancels here still
   * arrives at the client as that 403 and not as a reset connection, which is the
   * property that lets this be unconditional at all. Testing the status instead
   * would be a second copy of "which answers are refusals", and this needs none.
   *
   * The `.catch` is not superstition. This runs on the **response** path, where a
   * throw does not merely fail a request that was going to fail anyway: it
   * replaces a refusal the client can read with `internal_error`. `cancelBody` is
   * `async`, so it converts even a synchronous throw from `cancel()` into a
   * rejection, and this is where that rejection stops.
   */
  app.use("*", async (c, next) => {
    if (!isStreamingRoute(c.req.method, c.req.path)) return boundedBody(c, next);
    try {
      await next();
    } finally {
      await cancelBody(c.req.raw.body as ReadableStream<Uint8Array> | null).catch(() => {
        // Deliberately nothing: see above. A body we could not release is a
        // parked sender, which is bad, but an unreadable answer is worse and
        // there is nothing in `src/` to print it to either way.
      });
    }
  });

  /**
   * Authentication, on everything but `/health`. Authorization is per route,
   * below — this gate establishes *who*, and `requireScope` decides *whether*.
   *
   * The query parameter exists because browsers cannot set headers on a
   * WebSocket handshake. It carries the same credential either way — and it is
   * read *only* on an upgrade, which is `readCredential`'s job to enforce and
   * used to be nobody's.
   */
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();

    const result = verifier.verify(readCredential(c));
    if (!result.ok) {
      // The specific code, not a flat "unauthorized". A client that cannot tell
      // "your clock is wrong" from "you were revoked" cannot do anything useful
      // about either, and `skewMs` is the difference between a mystery and a
      // fixable problem.
      const detail =
        result.skewMs === undefined
          ? null
          : { skewMs: result.skewMs, daemonTime: Date.now(), leewayMs: AUTH_LEEWAY_MS };
      return jsonError(c, 401, result.code, result.message, detail);
    }

    c.set("principal", result.principal);
    return next();
  });

  /**
   * The session an id names, or nothing.
   *
   * **Renamed from `owned`, deliberately.** That name asserted a property this
   * daemon no longer has: while it served several people, every per-session route
   * went through a filter and "no such id" and "not yours" were the same 404. The
   * filter is gone with the tenancy — a grant on this machine is now access to
   * everything on it, which is stated in `CLAUDE.md`'s Identity section rather
   * than left to be inferred from a helper's name.
   *
   * The 404 for an unknown id stays, and never depended on tenancy.
   */
  const sessionOf = (c: Context<AppEnv>): ManagedSession | undefined =>
    registry.get(c.req.param("id") ?? "");

  /** Where git runs. One answer, so no route picks its own. */
  const git = registry.sessionRuntime.git();

  /**
   * One scope, checked after authentication.
   *
   * Registered per route rather than derived from a method-and-path table. A
   * table is one edit away from describing routes that have since moved, and
   * the failure mode of that drift is a route silently losing its check.
   */
  const requireScope =
    (scope: Scope): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      if (!hasScope(c.get("principal"), scope)) {
        return jsonError(c, 403, "insufficient_scope", `this token lacks the ${scope} scope`, {
          required: scope,
        });
      }
      return next();
    };
  const read = requireScope("session:read");
  const write = requireScope("session:write");
  const admin = requireScope("machine:admin");

  /**
   * What this machine offers, read at every request rather than captured.
   *
   * ⚠ **A thunk for `elicitationAllowed`'s reason and one of its own.** `createApp`
   * runs once, at boot, and `PluginHost` replaces the registry's catalogue on every
   * install, update, remove and enable — so a value captured here would go on
   * refusing a harness that had been installed twenty minutes ago, over a screen
   * that was already offering it. `registry.machineCatalogue` is the one copy.
   */
  const machineOf = () => registry.machineCatalogue;
  /** Whether this machine offers this harness right now. Never a shape test. */
  const offeredHarness = (id: string): boolean => machineOf().harnessState(id) === "enabled";

  /**
   * Whether an import is already unpacking. See `POST /fs/import`.
   *
   * Per app rather than per module, so two daemons in one driver process do not
   * block each other — every driver in this repository builds several.
   */
  let importing = false;

  /**
   * A handler that only runs for a session that exists.
   *
   * The `const managed = sessionOf(c); if (!managed) return notFound(c);` pair was
   * written out at seventeen routes. Collapsing it is not only tidiness: it is one
   * place where "an unknown session id is a 404" is enforced, rather than
   * seventeen places where it happens to be.
   *
   * Deliberately **not** applied to two routes that resolve the session
   * themselves: `POST /sessions/:id/uploads`, whose `refuse()` wrapper has to
   * cancel the request body *before* anything else answers, and the stream route,
   * which resolves twice on purpose.
   */
  const withSession =
    <P extends string>(
      handler: (c: Context<AppEnv, P>, managed: ManagedSession) => Response | Promise<Response>,
    ): Handler<AppEnv, P> =>
    (c) => {
      const managed = sessionOf(c);
      if (!managed) return notFound(c);
      return handler(c, managed);
    };

  /**
   * A JSON object body, or the 400 that says so.
   *
   * Returns the `Response` rather than throwing, so a caller reads
   * `if (body instanceof Response) return body;` and the refusal stays on the
   * route rather than in a catch somewhere above it.
   */
  const requireJson = async (c: Context<AppEnv>): Promise<Record<string, unknown> | Response> =>
    (await readJsonObject(c)) ?? jsonError(c, 400, "bad_request", "expected a JSON object body");

  /**
   * The workspace-relative path a caller asked for, or the refusal.
   *
   * Twelve identical lines at `changes/diff` and at `files`, `diff`-confirmed
   * identical before they were merged. Both are the same question — "name a file
   * inside this session's tree" — and the containment answer must not be able to
   * differ between them.
   *
   * **Async because the containment half is.** `safeRelPath` used to finish with
   * `realpathSync` on `<workspace.root>/<what the caller typed>`, which is a
   * synchronous filesystem call on a path this daemon did not create — the exact
   * thing `stall.ts` exists to prevent, and not one `workspaceReady` above can
   * catch, since it probes the root while the stalled mount is underneath it.
   * `probeContained` answers the same question through the same bounded probe
   * every other caller-named path here goes through, and its third answer gets
   * the same 503 shape `workspaceReady` gives.
   */
  const requestedPath = async (
    c: Context<AppEnv>,
    managed: ManagedSession,
  ): Promise<{ rel: string; full: string } | Response> => {
    const requested = c.req.query("path");
    if (requested === undefined) return jsonError(c, 400, "bad_request", "path is required");
    const safe = safeRelPath(managed.workspace.root, requested);
    if (!safe.ok) {
      return jsonError(c, 400, "invalid_path", "that path is not inside this session's tree", {
        reason: safe.reason,
      });
    }
    /*
     * `probeRequestable` rather than `probeContained`, and the extra answer is
     * the point: `safeRelPath` above refuses a `.git` *segment the caller typed*,
     * which one symlink walks past — `g -> .git` makes `?path=g/config` a request
     * with no `.git` in it, pointing at a file that really is inside the
     * workspace. Both checks passed and `.git/config` went out to any
     * `session:read` grant. The re-test happens on the resolved path, where the
     * link has already been followed.
     */
    const answer = await probeRequestable(managed.workspace.root, safe.full);
    if (answer === null) {
      return jsonError(c, 503, "path_unresponsive", "the filesystem holding that path did not answer", {
        timeoutMs: DESCRIBE_TIMEOUT_MS,
      });
    }
    if (answer !== "ok") {
      // The same status and the same code as the syntactic refusal, with the
      // reason saying which rule it met — a caller who typed `.git` and a caller
      // who followed a link into one are asking for the same thing.
      return jsonError(c, 400, "invalid_path", "that path is not inside this session's tree", {
        reason: answer,
      });
    }
    return { rel: safe.rel, full: safe.full };
  };

  /* ---------------------------------------------------------------- *
   * Introspection
   * ---------------------------------------------------------------- */

  app.get("/health", (c) => {
    // Liveness only, and deliberately less than it used to say.
    //
    // This is the one route without a token. On a single-person daemon the
    // per-status counts and the blocked-for timer were harmless; across tenants
    // they are an unauthenticated readout of how many sessions other people are
    // running and how long one of them has been waiting on an approval. That is
    // a small leak, but it is a leak to *anyone who can reach the port*, and
    // nothing consumes it — `packages/web` polls `GET /sessions` for the list and
    // `scripts/client.ts` only ever reads `ok` and `time`.
    return c.json({
      ok: true,
      instanceId,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      shuttingDown: registry.isShuttingDown,
      // Deliberately unauthenticated, like the rest of this route. A clock is
      // not a secret, and short-lived signed tokens make clock skew a real way
      // to be locked out — so the one number that diagnoses it has to be
      // readable by a client that cannot get a token yet.
      time: Date.now(),
      authMode: verifier.mode,
      /*
       * What build this is, and what it speaks.
       *
       * Unauthenticated for the same reason the clock is: a client that cannot
       * get a token yet is exactly the client that needs to know whether the
       * thing it is pointed at is older than it. `packages/web` ships inside the
       * control plane's image, so a weekly deploy hands every browser a client
       * newer than most of the daemons in the fleet — and until this field
       * existed there was **nothing anywhere** a client could read to find that
       * out. It already fetches and stores this object per machine.
       *
       * Neither number is a secret: the source URL and version of the control
       * plane are already served to anybody on `GET /v1/instance`, because the
       * AGPL requires it, and a daemon's build is less than that.
       *
       * ⚠ **Announced, not negotiated.** Nothing may branch on `version` — it is
       * a label, and a client that behaves differently for `0.1.0` than for
       * `0.2.0` re-creates the lockstep this exists to remove. `protocol` is the
       * one that carries capability, and it is the same number the tunnel
       * handshake negotiates.
       */
      version: DAEMON_VERSION,
      protocol: RELAY_PROTOCOL_VERSION,
    });
  });

  /**
   * Asked of the runtime, not of this host's filesystem.
   *
   * Through the runtime rather than calling `resolveAgent` here: what "available"
   * means is the runtime's question, and it also answers the second one nothing
   * else can — whether the agent is signed *in*, which used to be discovered at
   * the first prompt with a `502` after a worktree had already been made.
   */
  /**
   * Whether *this* agent's login can be driven here, in one place for both routes.
   *
   * ⚠ **It is on `GET /agents` as well as `GET /agent-auth`, and that is the whole
   * of what an agent needing no sign-in cost.** The screens that pick an agent read
   * the cheap route; the one that configures a credential reads the expensive one.
   * With the fact on only the second of them, the New Session tile had nothing to
   * say about opencode but "state unknown" — a sentence about a probe that failed,
   * under an agent that runs perfectly — and so it grew its own four-state
   * vocabulary and said the wrong thing in it for a release. The cost is four
   * `findOnPath` calls on a route that already spawns a CLI per agent.
   *
   * ⚠ **`supported` and `blocked` are one answer written twice and must not drift**
   * — `AgentLoginSupport.supported` is documented as `blocked === null` and nothing
   * else. The daemon-wide half (`logins === null`: there is nowhere to record a
   * run, which is a fact about this process rather than about the agent or the
   * platform) is folded in as `no_script`, the closest of the existing reasons,
   * rather than by inventing a fourth code the client would have to be taught.
   *
   * ⚠ **It is folded in *underneath* the agent's own reason, and the order is
   * load-bearing.** This read `logins === null ? "no_script" : support.blocked`,
   * which overwrote `no_flow` — the one reason that is not a limitation — with an
   * apology about the host, on a daemon with no login store. That is precisely the
   * inversion `loginBlockedReason` puts `no_flow` first to prevent, reintroduced
   * one layer up, where nothing was looking.
   */
  const loginSupportOf = (agent: AgentId): AgentLoginSupport => {
    const support = registry.sessionRuntime.loginSupport(agent);
    const blocked = support.blocked ?? (logins === null ? "no_script" : null);
    return {
      supported: blocked === null,
      blocked,
      needsInput: support.needsInput,
      canSignOut: support.canSignOut,
    };
  };

  app.get("/agents", read, async (c) =>
    c.json({
      agents: (await registry.sessionRuntime.availability()).map((agent) => ({
        ...agent,
        login: loginSupportOf(agent.id),
      })),
    }),
  );

  /* ---------------------------------------------------------------- *
   * Systems, and the agents assembled out of them
   *
   * A *system* is who serves a model and who you sign in to; a *harness* is the
   * CLI that runs the loop. They were the same thing while each of the three
   * agents spoke only to its own vendor, and `acp/systems.ts` is where they come
   * apart.
   *
   * ⚠ **Nothing here accepts a URL, a header name or a variable name.** A request
   * names a `SystemId` and a table resolves it — the same property
   * `AGENT_LOGIN` claims about the program a login runs, and for the same reason:
   * this daemon is reachable from the internet through the relay, and a caller
   * able to name an endpoint could point somebody's key at a host of its own.
   *
   * ⚠ **And the table is now assembled rather than compiled in, which is a real
   * change to that property and is stated rather than glossed.** A base URL still
   * never arrives on a *request*. It arrives in a `plugin.json`, inside an archive
   * fetched from one hardcoded host at a full 40-hex commit, after somebody read
   * the origin on a consent screen and pressed a named button about it — and it is
   * then fixed for the life of that install. Every link in that chain already
   * existed. What is no longer true is that the set of hosts this daemon can be
   * pointed at is a compile-time constant of this repository; `agent-systems.md`
   * carries the argument in full.
   * ---------------------------------------------------------------- */

  const systemIdParam = (c: Context<AppEnv>): SystemId | null => {
    const value = c.req.param("system") ?? "";
    return registry.machineCatalogue.systemState(value) === "enabled" ? value : null;
  };

  /**
   * What a path parameter naming a system this machine does not offer earns.
   *
   * {@link noSuchHarness}'s rule, one table over: a provider a plugin added and
   * somebody switched off is a `503` naming the switch, never a `400` naming the
   * caller. Reached only where `systemIdParam` already answered `null`.
   */
  const noSuchSystem = (c: Context<AppEnv>): Response =>
    registry.machineCatalogue.systemState(c.req.param("system") ?? "") === "disabled"
      ? jsonError(
          c,
          503,
          "system_unavailable",
          "this provider comes from a plugin that is switched off on this machine",
        )
      : jsonError(c, 400, "invalid_system", "unknown system");

  /**
   * Every system this daemon knows, and whether a key is saved for each.
   *
   * ⚠ **Cheap on purpose — it spawns nothing.** The picker that draws a strip of
   * agents reads this on every open, and the question "which systems are there"
   * is answered by a table. What *does* cost a process is
   * `GET /agents/capabilities` below, and keeping them apart is what stops the
   * New session sheet paying for a screen nobody opened.
   *
   * The secret is never in this answer and there is no route that returns one.
   */
  app.get("/systems", read, (c) => {
    const machine = registry.machineCatalogue;
    const saved = new Map((systems?.credentials.list() ?? []).map((one) => [one.system, one]));
    return c.json({
      /*
       * ⚠ **The built-ins in `SYSTEM_IDS` order, then whatever plugins added, and
       * a *disabled* plugin's provider is not here at all.** This array is the
       * reading order: `groupModels` groups by first appearance rather than by
       * sorting and `readyFirst` orders each of its two halves by position, so
       * contributed rows appearing *after* every built-in is a group appearing
       * rather than a group moving under somebody's thumb. `Contributions` sorts
       * by plugin id so the order does not depend on what was installed when.
       */
      systems: machine.systemIds().flatMap((id) => {
        const spec = machine.system(id);
        // Unreachable — `systemIds()` is where these ids came from — and answered
        // rather than asserted, because the alternative is a `TypeError` on a
        // polled route to satisfy a claim the type system already makes.
        if (spec === null) return [];
        const held = saved.get(id);
        return [{
          id,
          displayName: spec.displayName,
          apiType: spec.apiType,
          /*
           * Whether anything can be *pointed* at it, said outright rather than
           * inferred from the model list being non-empty — which is what the
           * client did, and which conflates "no endpoint to route to" with "no
           * models written down yet".
           */
          routable: spec.baseUrl !== null,
          nativeHarness: spec.nativeHarness,
          loginVia: spec.loginVia,
          // Empty for a natively-reached system, where the *agent* publishes the
          // list. Not a gap — see `SystemConfig.models`.
          models: spec.models,
          /*
           * The prefix the native harness puts on a model id, or `null`. Sent
           * because the client reads *two* lists for this system — the endpoint's
           * own catalogue and whatever the native harness published — and without
           * it the same model appears twice under one heading, once per spelling.
           * A prefix is not an endpoint, a header name or a variable name, so the
           * rule this section opens with is untouched.
           */
          nativeModelPrefix: spec.nativeModelPrefix,
          keyEnv: spec.keyEnv,
          /*
           * ⚠ **The *effective* answer, off the same function the start reads.**
           * A system whose native harness already holds its key needs no second
           * one — `systemSecretFor` says so, and this asking the store directly is
           * how the picker came to offer a routed pairing that `applySystem` then
           * refused, over a machine that plainly had a key saved.
           */
          keySet:
            systemSecretFor(
              id,
              systems?.credentials.get(id) ?? null,
              (agent: AgentId) => credentials?.envFor(agent) ?? {},
              /*
               * ⚠ **The catalogue, and leaving it off is the same defect Q3.485
               * records arriving through a new door.** `systemSecretFor` is one
               * function precisely so that this answer and the one `applySystem`
               * reads at the start cannot disagree — and it resolves the row
               * through whatever catalogue it is handed. Defaulted, it would answer
               * `null` for every provider a plugin added, so a machine holding the
               * key on that provider's own harness would draw "No <provider> key on
               * this machine" under models the start would run perfectly.
               */
              machine,
            ) !== null,
          /*
           * Only ever the *system* row's own timestamp, so `null` beside a
           * `keySet` of `true` is the client's way of reading "this one is
           * borrowed" — which is what stops the screen offering a Clear for a
           * secret that is not stored here.
           */
          keyUpdatedAt: held?.updatedAt ?? null,
          /*
           * Which plugin added this, or absent for a row this repository ships.
           *
           * Sent so the settings screen can say where a provider came from and so
           * a refusal can name the plugin rather than the id. It is a *label*
           * beside the row and nothing branches on it — the same standing
           * `DAEMON_VERSION` has.
           */
          ...(spec.contributedBy === undefined ? {} : { contributedBy: spec.contributedBy }),
        }];
      }),
    });
  });

  app.put("/systems/:system", write, async (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    const system = systemIdParam(c);
    if (system === null) return noSuchSystem(c);
    const body = await readJsonObject(c);
    const token = body?.["token"];
    if (typeof token !== "string" || token.trim().length === 0) {
      return jsonError(c, 400, "bad_request", "token is required and must be non-empty");
    }
    // The same bound a pasted agent credential gets, and deliberately the same
    // constant: what is being pasted is the same *kind* of thing, and two limits
    // for one act is two numbers to keep in step.
    if (token.length > MAX_CREDENTIAL_CHARS) {
      return jsonError(c, 400, "bad_request", `token exceeds ${MAX_CREDENTIAL_CHARS} characters`);
    }
    systems.credentials.save(system, token.trim());
    /*
     * ⚠ **No `forgetAvailability`, and no restart sweep — unlike the agent
     * credential routes one section down, which do both.**
     *
     * Those two exist because an agent credential is injected at *spawn*, so a
     * token saved under a running agent reaches it never and the badge would
     * turn green over a chat still failing to authenticate. A system key is not
     * in any environment: it is handed to `providers/set` during a launch, so a
     * session started after this save picks it up with nothing to invalidate,
     * and one already running was routed with the key it was given. There is no
     * stale cache here to drop.
     */
    return c.json({ saved: true, system });
  });

  app.delete("/systems/:system", write, (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    /*
     * ⚠ **Removed before it is validated, which `DELETE /custom-agents/:id` below
     * already argues at length and this route did the other way round.**
     * `SqliteSystemCredentialStore.list` drops a row naming a system this build
     * cannot resolve — a key written by a newer daemon, read after a downgrade —
     * so gating the delete on `isSystemId` made exactly those rows undeletable:
     * unlistable, unreadable, and — since Q7.124 removed the sweep — unswept for
     * ever, which is what makes the ordering here load-bearing rather than tidy. A
     * plaintext third-party key with no code path able to end it is the one
     * outcome worth bending the input rule for, and the id never reaches anything
     * but a parameterized `DELETE`.
     *
     * `removed` is what the *listing* could see, so a caller still learns that it
     * named something this build does not know — the same honest-but-narrow answer
     * the preset route gives, and the same reason: a `404` here would break the
     * replay this verb is whitelisted for.
     */
    const named = c.req.param("system") ?? "";
    const system = systemIdParam(c);
    systems.credentials.remove(named as SystemId);
    // Presets naming this system are deliberately left alone. A key can be
    // replaced in the next minute, and deleting somebody's named agents because
    // they rotated a token would be this daemon destroying their work to keep a
    // list tidy. Starting one without a key refuses by name, before a worktree.
    return c.json({ removed: system !== null, system: named });
  });

  /**
   * What each harness offers, and what each will let us point it at.
   *
   * ⚠ **This starts an agent per harness.** No prompt is sent, so no quota is
   * spent, but it is a subprocess plus an ACP handshake — which is why it is a
   * route of its own rather than a field on `GET /agents`, and why only the
   * screen that assembles an agent calls it. `AgentAskRuns` bounds and caches
   * it: ten minutes, two at a time for the whole daemon.
   *
   * Per agent failures are answered rather than thrown: one harness that is not
   * installed must not take down a picker that could still offer the other two.
   */
  app.get("/agents/capabilities", read, async (c) => {
    if (asks === null) {
      return jsonError(c, 503, "model_unavailable", "this daemon cannot read agent capabilities");
    }
    /*
     * ⚠ **Asked all at once, and the bound is kept by the queue rather than by
     * the order.**
     *
     * This was a serial loop, and a `Promise.all` before that. The `Promise.all`
     * was measured wrong: `MAX_CONCURRENT_ASKS` is 2 for the whole daemon and
     * `admit` **threw** when full, so the *third* harness always lost the race and
     * `GET /agents/capabilities` on a cold cache answered "codex: this machine is
     * already running 2 model requests" every time — codex permanently greyed out
     * in the builder with a sentence about load that had nothing to do with it.
     * Serial was the workaround, and it could not trip the bound because it never
     * approached it.
     *
     * ⚠ **What it cost was measured too, and it is not "a second or two".** Driven
     * against the real harnesses with the real saved credentials, 2026-08-28:
     * claude 1162 ms, kimi 627 ms, codex 2260 ms, opencode 1237 ms — **5286 ms**
     * serially, against **2531 ms** with all four overlapped, which is codex's own
     * start-up and nothing else. Per-harness cost is the same either way; there is
     * no contention to pay for.
     *
     * The fix is in `admit`, not here: the capability path **queues** for a slot
     * instead of being refused one, so the sweep cannot lose a race against a
     * bound it is itself holding. The cap is unchanged and still 2 — this is four
     * requests metered through it rather than four spawns at once.
     */
    /*
     * ⚠ **What this machine offers, not `AGENT_IDS`** — the four this repository
     * ships plus whatever plugins added, and a *disabled* plugin's harness is not
     * in it. The bound on how long the sweep can get is
     * `MAX_CONTRIBUTED_HARNESSES`, refused at install rather than trimmed here:
     * a partial read would need a third wire state, because an empty
     * `{models: [], routing: null, error: null}` is indistinguishable from an
     * agent that answered nothing — which `hostable` reads as a real refusal.
     */
    const machine = machineOf();
    /**
     * Whether this harness can be told which model to run on somebody else's
     * system.
     *
     * ⚠ **Sent because the client cannot work it out and had been guessing by
     * omission.** `hostable` has four arms and the browser's mirror could only
     * express three: `ROUTED_MODEL_ENV` is a table in `src/`, and the client had a
     * paragraph saying nothing on the wire stood for it. So the picker offered a
     * pairing `POST /custom-agents` then refused — harmless while the one harness
     * that could be routed was also the only one with an arm, and not harmless the
     * moment a plugin contributes a harness that names no model variable.
     *
     * On `routing` rather than beside it, so `hostable`'s signature — and every
     * fixture built on it — is untouched; and **absent means `true`** on that side,
     * which is safe for the one reason that matters: a daemon too old to send it
     * has no plugin catalogue, so it has no harness this could be false for.
     */
    const pinsModel = (id: string): boolean => routedModelNaming(id, machine) !== null;
    const entries = await Promise.all(
      machine.harnessIds().map(async (id): Promise<readonly [string, unknown]> => {
      try {
        /*
         * ⚠ **The caller's signal, and it protects less than it did — said here
         * rather than left reading as though it still did.** When this was a
         * serial loop the signal stopped the harnesses the loop had not reached
         * yet. Fanned out, all four run their one `stopIfGone` in the same tick,
         * so what it can still refuse is only a spawn that has not begun *at
         * that instant*; a sweep abandoned a moment later runs its handshakes to
         * completion.
         *
         * That is bounded and it is not a leak: no prompt is sent and no quota is
         * spent, `SLOT_WAIT_MS` bounds any queued member, and the answers land in
         * the ten-minute cache — so the `GET` the transport replays is served from
         * it rather than paying for the spawn a second time, which is strictly
         * better than the serial loop, whose abandoned tail was neither spawned
         * nor cached.
         */
        const answer = await asks.capabilities(id, c.req.raw.signal, true);
        return [
          id,
          {
            models: answer.models,
            routing: answer.routing === null ? null : { ...answer.routing, pinsModel: pinsModel(id) },
            error: null,
          },
        ] as const;
      } catch (error) {
        // Per agent, never thrown: one harness that is not installed must not
        // take down a picker that could still offer the other three.
        return [
          id,
          { models: [], routing: null, error: error instanceof Error ? error.message : String(error) },
        ] as const;
      }
      }),
    );
    return c.json({ agents: Object.fromEntries(entries) });
  });

  app.get("/custom-agents", read, (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    return c.json({ customAgents: systems.customAgents.list() });
  });

  /**
   * The four fields somebody chose, checked, or the refusal to hand straight back.
   *
   * ⚠ **One function because two routes decide the same predicate.** Creating a
   * preset and editing one differ only in what happens to the answer — one mints
   * an id, the other keeps the stored row's — and every check before that point
   * is the same question asked of the same body. Written out twice they drift the
   * first time one of the bounds moves, and the drift is silent in the direction
   * that matters: an edit that accepts what a create refuses puts the unstartable
   * row into the store by the back door. `requestedPath` above was merged out of
   * two copies for exactly this, and the copies there had already been confirmed
   * identical rather than assumed to be.
   *
   * ⚠ **All four are required on both paths: an edit is a replace, not a merge.**
   * A subset body is the friendlier-looking shape and it is the one that can be
   * wrong. The pairing is a fact about the *row*, so it would have to be weighed
   * against the merge of body and stored row — and a handler that weighs it
   * against the body alone accepts `{ "system": "moonshot" }` on a codex preset,
   * refusing at creation and saving at edit, which is the failure this daemon
   * already refuses `POST` to have. With nothing to merge there is nothing to get
   * that wrong. It costs the caller nothing either: the edit screen is the
   * assembly screen with a stored row loaded into it, so it holds all four before
   * anybody touches anything.
   *
   * `Omit<CustomAgent, "id" | "createdAt">` rather than a shape of its own: those
   * two are precisely the fields the wire may not name, and saying it in the type
   * means a sixth field added to `CustomAgent` fails to compile here instead of
   * being quietly dropped by whichever route was not updated.
   *
   * ⚠ **What this predicate weighs is the *row*, and the sessions already
   * pointing at it are not in it.** "An edit cannot put an unstartable row into
   * the store" is the claim, and it is the whole claim: `PATCH` can still move
   * `harness` out from under a live session, whose `sessions.agent` column does
   * not move with it, and that is answered by demoting the session rather than by
   * refusing the edit — see the `PATCH` docblock below and
   * `ManagedSession.assembled` for where it lands. Reading this as "no edit can
   * leave anything broken" is the reading that stopped being true.
   */
  const readAssembledAgent = async (
    c: Context<AppEnv>,
  ): Promise<Omit<CustomAgent, "id" | "createdAt"> | Response> => {
    const body = await readJsonObject(c);
    /*
     * ⚠ **The list is no longer written into the sentence, and that is a bound
     * rather than a style choice.** It was `one of ${AGENT_IDS.join(", ")}` — four
     * short words — and a machine may now offer any number of harnesses under
     * names a manifest chose, so the sentence grew without limit and landed on a
     * phone. What a caller needs is which of the two things is wrong; `offers`
     * carries the list in the error's own detail, where it is not prose.
     */
    /*
     * ⚠ **Two states, not one, and `offeredHarness` is the helper that erases the
     * difference.** `harnessState` and `systemState` are three-valued because
     * *unknown* and *disabled* need opposite sentences — the interface's own
     * docblock states it, and `POST /sessions` splits them. Collapsing both into
     * `400` here is reachable from a screen rather than theoretical:
     * `readCustomAgent` validates a stored preset by *shape*, so one naming a
     * contributed harness stays in `GET /custom-agents` after its plugin is
     * switched off — the edit screen loads it, and a pure rename came back blaming
     * the caller for a machine state one toggle fixes.
     */
    const harness = body?.["harness"];
    if (typeof harness !== "string" || machineOf().harnessState(harness) === "unknown") {
      return jsonError(c, 400, "invalid_agent", "harness must be one this machine offers", {
        offers: machineOf().harnessIds(),
      });
    }
    if (!offeredHarness(harness)) {
      return jsonError(
        c,
        503,
        "harness_unavailable",
        "this agent comes from a plugin that is switched off on this machine",
      );
    }
    const system = body?.["system"];
    if (typeof system !== "string" || machineOf().systemState(system) === "unknown") {
      return jsonError(c, 400, "invalid_system", "system must be one this machine offers", {
        offers: machineOf().systemIds(),
      });
    }
    if (machineOf().systemState(system) !== "enabled") {
      return jsonError(
        c,
        503,
        "system_unavailable",
        "this provider comes from a plugin that is switched off on this machine",
      );
    }
    const model = body?.["model"];
    if (typeof model !== "string" || model.trim().length === 0) {
      return jsonError(c, 400, "bad_request", "model is required and must be non-empty");
    }
    if (model.length > MAX_MODEL_CHARS) {
      return jsonError(c, 400, "bad_request", `model exceeds ${MAX_MODEL_CHARS} characters`);
    }
    const name = body?.["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
      return jsonError(c, 400, "bad_request", "name is required and must be non-empty");
    }
    if (name.length > MAX_AGENT_NAME_CHARS) {
      return jsonError(c, 400, "bad_request", `name exceeds ${MAX_AGENT_NAME_CHARS} characters`);
    }
    /*
     * ⚠ **The pairing is refused here, not only in the picker.**
     *
     * The client greys out an impossible combination, and that is a courtesy
     * rather than the gate: these routes are reachable from the internet and a
     * saved preset that cannot start is a row whose only button answers 502
     * every time it is pressed, days after anybody could connect the two. That
     * is as true of an edit as of a create — more so, since an edit can take a
     * row that started fine yesterday and leave it in that state.
     *
     * ⚠ **And the routing half is read from the agent rather than assumed.**
     * `hostable` needs to know which protocols this harness accepts, which only
     * the harness can say — so this spawns one, through the same cached, bounded
     * path `GET /agents/capabilities` uses. `null` from a failed read is passed
     * through as "cannot be routed", which refuses a cross-system preset and
     * leaves a native one alone.
     */
    /*
     * ⚠ **A machine that is busy is not a pairing that is impossible, and this
     * folded the two.** The rejection arm was `() => null`, so `model_busy` from
     * the two-slot bound — or a spawn timeout, or a shutdown — became
     * `routing: null`, which `hostable` turns into "This agent only runs its own
     * models." That is a false statement about `claude`, delivered as a `400` on
     * the screen the design calls the gate, with no retry offered. Two plugin
     * model calls in flight were enough to produce it.
     *
     * `null` is now reserved for a harness that *answered* and answered nothing,
     * which is the state `hostable` was written to read. Anything else is this
     * daemon's own condition and answers `503`, which is retryable and says so.
     *
     * ⚠ **Bounded below the client's budget.** `ASK_TIMEOUT_MS` is 120s and the
     * client's `SLOW_ROUTE_TIMEOUT_MS` is 90s, so a slow cold read let the phone
     * abort while this handler went on to write the row — and `POST` mints a fresh
     * id, so the obvious retry made a second preset with no uniqueness constraint
     * to catch it. Refusing first is the honest half of that pair.
     */
    let routing: Awaited<ReturnType<AgentCapabilityReader["capabilities"]>>["routing"] = null;
    if (asks !== null) {
      try {
        routing = (await asks.capabilities(harness, AbortSignal.timeout(CAPABILITY_READ_BUDGET_MS)))
          .routing;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return jsonError(
          c,
          503,
          error instanceof AgentAskError ? error.code : "model_failed",
          `${harness} could not be asked what it can be pointed at right now: ${detail}`,
        );
      }
    }
    /*
     * ⚠ **`machineOf()`, and leaving it off made every contributed pairing
     * unsaveable.** `hostable`'s fourth parameter defaults to `BUILTIN_CATALOGUE`,
     * whose `system()` answers `null` for every `<plugin>:<local>` id — so a
     * preset on a provider a plugin added was refused *"This provider is no longer
     * on this machine."* about a provider `GET /systems` was listing two lines
     * above, and one on a contributed harness was refused for a routed-model
     * variable `ROUTED_MODEL_ENV` was never going to hold. Both checks above this
     * one already read the live catalogue, and `session.ts` passes it at launch, so
     * the create-time and launch-time gates disagreed about the same pairing: what
     * would start could not be stored. This is the same defect Q3.485 records
     * arriving through a new door, which `GET /systems` warns about by name.
     */
    const refusal = hostable(harness, system, routing, machineOf());
    if (refusal !== null) {
      return jsonError(c, 400, "incompatible_pairing", refusal, { harness, system });
    }
    return { name: name.trim(), harness, system, model: model.trim() };
  };

  app.post("/custom-agents", write, async (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    const draft = await readAssembledAgent(c);
    if (draft instanceof Response) return draft;
    /*
     * ⚠ **Minted against the store rather than trusted, and this became load-bearing
     * when `save` became an upsert.** It was a bare `INSERT`, so a repeated id was a
     * `SQLITE_CONSTRAINT_PRIMARYKEY` — a loud 500 nobody ever saw. `PATCH` needs the
     * upsert, and the upsert turns the same collision silent: it would replace an
     * existing preset's name, harness, system and model, and because
     * `sessions.custom_agent` is a *reference* re-read at every launch, every session
     * on that id would come back on a triple nobody chose.
     *
     * Four bytes is `s_`'s width and is kept, because the id is read by people and by
     * `MAX_STRIP_REF_CHARS`; the birthday bound is what the loop replaces. The mint,
     * the lookup and the write are synchronous with no `await` between them, so on a
     * single-process daemon this is atomic — the awaits all happened above, in
     * `readAssembledAgent`.
     */
    let id = `ca_${randomBytes(4).toString("hex")}`;
    for (let attempt = 0; systems.customAgents.get(id) !== null; attempt += 1) {
      // Bounded so a store that answered every id — a wedged wrapper, never the real
      // one — is a refusal rather than a spin on the daemon's only thread.
      if (attempt >= 8) {
        return jsonError(c, 503, "systems_unavailable", "could not mint an id for this agent");
      }
      id = `ca_${randomBytes(4).toString("hex")}`;
    }
    const one = { id, ...draft, createdAt: Date.now() };
    systems.customAgents.save(one);
    return c.json({ customAgent: one }, 201);
  });

  /**
   * Renaming an assembled agent, or pointing it somewhere else.
   *
   * ⚠ **Without this a preset is write-once, and `sessions.custom_agent` was
   * built on the assumption that it is not.** That column holds a *reference*
   * rather than a copy, and `ManagedSession.assembled` re-reads it at every
   * launch, deliberately — so that editing a preset changes what its sessions
   * come back as, which is what anybody expects of a preset. For one release the
   * only way to change one was to delete it and create another, which the
   * reference design turns into the worst available outcome: every session on the
   * old id silently drops to the bare harness at its next resume, with no system
   * and no model pin, while a new row that looks identical sits beside it.
   *
   * ⚠ **Three of the four fields reach those sessions. `harness` does not, and
   * the demotion is deliberate.** `sessions.agent` is written when the session is
   * created and never moves — it names the CLI whose transcript this is, whose
   * resume id this is, and whose process would be spawned again — so a preset
   * re-pointed from `claude` to `codex` would otherwise resume an existing
   * conversation against a harness that has never heard of it, which is a 502 on
   * every resume rather than a changed model. `ManagedSession.assembled` weighs
   * the resolved preset's harness against the session's own column and answers
   * `{}` when they differ: the same honest demotion the deleted-preset arm
   * already takes, and for the same reason — a session whose preset no longer
   * describes it comes back as the bare harness it has always been rather than as
   * a pairing nobody chose. Nothing is refused here. A preset is somebody's to
   * re-point, and the row this writes is startable for everything started after
   * the edit; what it stops being is a description of the sessions started before.
   *
   * ⚠ **`PATCH` with every field required.** See `readAssembledAgent` for why an
   * edit is a replace. It is not a `PUT` because the body is not the whole
   * resource: `id` and `createdAt` are the daemon's and are taken from the stored
   * row below rather than from anything a caller sent, so a body that names either
   * is answered with them unchanged rather than refused — there is no field to
   * refuse, only a key nothing reads.
   *
   * The 404 comes before the body is read: a preset deleted from another phone a
   * second ago should be answered "no such agent" rather than a complaint about a
   * field, and the two answers are indistinguishable to somebody holding a stale
   * list.
   */
  app.patch("/custom-agents/:id", write, async (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    const stored = systems.customAgents.get(c.req.param("id") ?? "");
    if (stored === null) {
      return jsonError(c, 404, "custom_agent_not_found", "no such agent");
    }
    const draft = await readAssembledAgent(c);
    if (draft instanceof Response) return draft;
    // `stored.id` rather than the path parameter, which is equal to it by
    // construction: taking both immutable fields off the row is what makes "a
    // client cannot set either" a property of the shape rather than an argument
    // about the fields nothing happens to read.
    //
    // `save` is an upsert keyed on the id — `SqliteCustomAgentStore` writes
    // `ON CONFLICT(id) DO UPDATE`, and leaves `created_at` out of the SET list so
    // that the age of a preset cannot move even if a caller of this port gets it
    // wrong. It was a bare `INSERT` while nothing could edit a row, and this route
    // is what makes the difference observable.
    /*
     * ⚠ **Looked up again, because `save` is an upsert and the gap is wide.**
     * `readAssembledAgent` above awaits a capability read that can spawn an agent,
     * so seconds pass between the 404 check and this write — and
     * `ON CONFLICT(id) DO UPDATE` means an `INSERT` of a row deleted in that window
     * succeeds and puts it back, under its original `createdAt`. Two phones, one
     * deleting while the other edits, and the delete silently loses. The second
     * lookup is cheap and the window after it is one statement.
     */
    if (systems.customAgents.get(stored.id) === null) {
      return jsonError(c, 404, "custom_agent_not_found", "no such agent");
    }
    const one = { id: stored.id, ...draft, createdAt: stored.createdAt };
    systems.customAgents.save(one);
    return c.json({ customAgent: one });
  });

  /**
   * Wanting the row gone, and being able to say so twice.
   *
   * ⚠ **An id with nothing under it is `200 {removed: false}` and never a 404,
   * because this is a `DELETE` and the transport replays those.** `isReplayable`
   * in `packages/web/src/machine.ts` whitelists `GET` and `DELETE` on a stated
   * property this route is inside, and `slowRoute` deliberately leaves the verb
   * off — its own docblock calls this "a lookup plus a delete", so it runs on the
   * ordinary 15s budget, which is precisely the budget `settleTransport` names as
   * the one a phone dropping to LTE earns. The failure a 404 makes is a removal
   * that *worked* and whose answer was lost on the wire: the replay lands after
   * the row is already gone, and `AgentBuilder` draws `errorText` over an act that
   * did exactly what was asked. `removed` is what tells the two sends apart.
   *
   * ⚠ **`DELETE /plugins/:pluginId` in this same daemon already answers this way,
   * with this argument, and `daemoncheck` already pins it.** Two conventions for
   * one verb in one daemon is how one of them rots — and the one that rots is the
   * one whose failure is invisible offline, which is this one: a 404 here is
   * correct on every developer machine and wrong only over a relay.
   *
   * The cost is the same trade that route already took: a mistyped id is no
   * longer refused. A wrong id costs a person one confusing line; a 404 costs
   * whoever hit a dropped packet a delete that reads as having failed.
   *
   * ⚠ **`removed` is what the lookup said, and the `remove` runs either way.**
   * `SqliteCustomAgentStore.get` drops a row whose `harness` or `system` this
   * version cannot parse — a preset written by a newer daemon, read after a
   * downgrade — so gating the delete on the lookup would make exactly those rows
   * undeletable, which is the failure the plugin route avoids by removing rather
   * than finding. Such a row is deleted and reported `false`, the one dishonest
   * answer here and the smaller of the two: the store port returns `void`, so
   * this line has nothing better to read.
   */
  app.delete("/custom-agents/:id", write, (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    const id = c.req.param("id") ?? "";
    const removed = systems.customAgents.get(id) !== null;
    /*
     * Sessions started on it are left alone and keep resuming: `sessions.agent`
     * holds the harness, so the conversation comes back on that with no system
     * and no model pin. Ending somebody's chats because they tidied a list would
     * be the worse of the two surprises.
     *
     * ⚠ **That demotion is what the confirm on the other side has to say, and it
     * is a claim about `ManagedSession.assembled` rather than about this line.**
     * That getter resolves `sessions.custom_agent` through `customAgents` at every
     * launch and returns `{}` for an id it cannot find — so the loss lands at the
     * *next* start or resume and not here. An agent already running keeps the
     * system and model it was spawned with until something restarts it, which is
     * why the honest sentence is about what a session comes back as rather than
     * about what it is doing now.
     *
     * `PATCH` above is the *less* destructive half of the same intent rather than
     * the non-destructive one, and that sentence used to overclaim: re-pointing a
     * preset's name, system or model reaches every session on it through the same
     * getter with nothing to demote, but re-pointing its `harness` lands those
     * sessions on this same `{}` — see that route's docblock. A delete is for
     * wanting the row gone; a harness edit demotes without being asked to.
     */
    systems.customAgents.remove(id);
    /*
     * And its position in the strip goes with it.
     *
     * Not correctness — `orderStrip` in the client drops a `ref` that resolves to
     * nothing, so an orphan row is invisible either way. It is the only thing
     * standing between `agent_strip` and unbounded growth on a machine where
     * presets are assembled and thrown away and the strip screen is never opened,
     * and it is one statement.
     *
     * Unconditional on `removed`, like the remove above it and for the same
     * reason: a row this build cannot resolve is not found by `get` and must
     * still be deletable.
     */
    systems.strip.forget("custom", id);
    return c.json({ removed, id });
  });

  /* ---------------------------------------------------------------- *
   * The strip
   *
   * Which agents the New session screen offers on this machine, and in what
   * order. Two routes and no third: the screen that writes this holds the whole
   * list, so a reorder is one `PUT` rather than a verb per row.
   *
   * ⚠ **This daemon does not merge and does not resolve.** It stores
   * `(kind, ref, rank, hidden)` and hands it back; which of those refs is a
   * harness that is installed, an assembled agent that still exists, or neither,
   * is decided by the client against `GET /agents` and `GET /custom-agents` —
   * the two lists it already reads to draw the row. Deciding it here would mean
   * a third read on every strip fetch and a rule written down twice, and the
   * rule is not this daemon's: what may have a tile is `shownHere`'s answer, and
   * `shownHere` is a screen.
   * ---------------------------------------------------------------- */

  app.get("/agent-strip", read, (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    return c.json({ entries: systems.strip.list() });
  });

  /**
   * The whole strip, checked, or the refusal to hand straight back.
   *
   * ⚠ **`PUT` and not `PATCH`, because the body is the whole list.** `POST`/
   * `PATCH /custom-agents` are about one row each and their verbs carry the
   * difference between adding and editing; here there is one resource — the
   * order — and every write replaces it. That also makes the route idempotent,
   * which matters more than it looks: `isReplayable` in `packages/web/src/
   * machine.ts` whitelists GET and DELETE only, so a lost answer is *not* resent
   * — but a person tapping twice on a flaky link should not be able to produce a
   * shape a merge would have to decide about.
   *
   * ⚠ **The duplicate check is here rather than left to the primary key.** Two
   * entries naming the same `(kind, ref)` is a client bug, and SQLite would
   * report it as `SQLITE_CONSTRAINT_PRIMARYKEY` out of the middle of a
   * transaction — a `500 internal_error` on a body this route can see is wrong at
   * a glance. It is the same lesson `SqliteCustomAgentStore`'s upsert records
   * from the other direction: a constraint reaching a caller as a 500 is a
   * refusal that was never written down.
   *
   * What is *not* checked is whether a `ref` names anything. See
   * `AgentStripEntry`: the row is the memory, and forgetting a position because
   * an agent is signed out today is the one behaviour somebody would notice.
   */
  const readStripEntries = async (c: Context<AppEnv>): Promise<AgentStripEntry[] | Response> => {
    const body = await readJsonObject(c);
    if (body === null) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const raw = body["entries"];
    if (!Array.isArray(raw)) return jsonError(c, 400, "bad_request", "entries must be an array");
    if (raw.length > MAX_STRIP_ENTRIES) {
      return jsonError(c, 400, "bad_request", `entries exceeds ${MAX_STRIP_ENTRIES} items`);
    }
    const entries: AgentStripEntry[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return jsonError(c, 400, "bad_request", "each entry must be an object");
      }
      const one = item as Record<string, unknown>;
      const kind = one["kind"];
      if (kind !== "harness" && kind !== "custom") {
        return jsonError(c, 400, "bad_request", 'kind must be "harness" or "custom"');
      }
      const ref = one["ref"];
      if (typeof ref !== "string" || ref.length === 0) {
        return jsonError(c, 400, "bad_request", "ref must be a non-empty string");
      }
      if (ref.length > MAX_STRIP_REF_CHARS) {
        return jsonError(c, 400, "bad_request", `ref exceeds ${MAX_STRIP_REF_CHARS} characters`);
      }
      const hidden = one["hidden"];
      if (typeof hidden !== "boolean") {
        return jsonError(c, 400, "bad_request", "hidden must be a boolean");
      }
      const key = `${kind}:${ref}`;
      if (seen.has(key)) {
        return jsonError(c, 400, "bad_request", `entries names ${key} twice`);
      }
      seen.add(key);
      entries.push({ kind, ref, hidden });
    }
    return entries;
  };

  app.put("/agent-strip", write, async (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    const entries = await readStripEntries(c);
    if (entries instanceof Response) return entries;
    systems.strip.replace(entries);
    /*
     * The saved list is echoed rather than answered `{ saved: true }` alone, and
     * it is what the store now holds rather than what arrived: they are the same
     * today, and a caller that reads the answer instead of trusting its own copy
     * keeps being right if that ever stops being true.
     */
    return c.json({ saved: true, entries: systems.strip.list() });
  });

  /* ---------------------------------------------------------------- *
   * Logging an agent in
   *
   * Every agent authenticates out of band and reads its credentials from disk,
   * and the point of these routes is that the person putting something there is
   * holding a phone. Two paths, because neither alone is enough: a guided flow
   * that runs the agent's own login under a pty, and a paste box for a token
   * minted elsewhere (`claude setup-token`). The second always works; the first
   * is nicer when it does, and `loginSupported` says which.
   * ---------------------------------------------------------------- */

  /**
   * The harness a route names, or `null`.
   *
   * ⚠ **Membership in what this machine offers, not shape** — the opposite call
   * from `fromRow`, and both are right. Nothing has been created yet at any of
   * these call sites, so a refusal costs nothing; and a route that accepted a
   * harness this machine does not have would store a credential under a name
   * nothing will ever read.
   */
  const agentIdParam = (c: Context<AppEnv>): AgentId | null => {
    const value = c.req.param("agent") ?? "";
    return registry.machineCatalogue.harnessState(value) === "enabled" ? value : null;
  };

  /**
   * What a path parameter naming a harness this machine does not offer earns.
   *
   * ⚠ **Three answers collapsed into two is what this exists to undo.**
   * `harnessState` is three-valued on purpose — see its own docblock, which states
   * the rule: *unknown* is "fix your request", *disabled* is "this was correct
   * yesterday and somebody switched the plugin off", and the second may never be
   * answered with the `400` that tells an operator their own address is wrong.
   * `agentIdParam` answers `null` for both, so every route reading it said the
   * wrong one. `POST /sessions` has always split them; these had not.
   *
   * Reached only where `agentIdParam` already answered `null`, so the `enabled`
   * arm is unreachable and the two states left are the two this chooses between.
   */
  const noSuchHarness = (c: Context<AppEnv>): Response =>
    registry.machineCatalogue.harnessState(c.req.param("agent") ?? "") === "disabled"
      ? jsonError(
          c,
          503,
          "harness_unavailable",
          "this agent comes from a plugin that is switched off on this machine",
        )
      : jsonError(c, 400, "invalid_agent", "unknown agent");

  app.get("/agent-auth", read, async (c) => {
    const availability = await registry.sessionRuntime.availability();
    const stored = credentials?.list() ?? [];
    return c.json({
      // `loginSupported` rather than letting the client infer it from the
      // runtime kind: whether a login can be driven is the runtime's decision,
      // and a client that guessed would offer a wizard that answers 503.
      //
      // **Both halves, and it used to be only the first.** `logins !== null` says
      // there is somewhere to record a run; `runtime.loginSupported` says the
      // host has a `script` to allocate a pty with. On a host without one this
      // field answered `true` and `POST /agent-auth/:agent/login` then answered
      // `503 login_unsupported` — which is precisely the outcome the comment
      // above says the field exists to prevent, in the one place a person goes
      // when their agent has just refused a prompt.
      loginSupported: logins !== null && registry.sessionRuntime.loginSupported,
      /*
       * What this host is, so the client can name it when it has to explain a
       * refusal that is the platform's doing.
       *
       * `login.blocked === "interactive_pty"` is returned for **every** BSD, and
       * a client that hardcoded "macOS" would be telling a FreeBSD operator
       * something false about their own machine. The daemon is the only end that
       * knows, so it says; the client maps it to a name a person uses.
       *
       * Reported and never branched on — `blocked` is what decides anything, and
       * this is a label beside it. The distinction `compatibility.md` draws for
       * `DAEMON_VERSION` is the same one.
       */
      os: process.platform,
      agents: availability.map((agent) => {
        return {
          ...agent,
          credentials: registry.sessionRuntime.credentialSlots(agent.id).map((envName) => {
            const row = stored.find(
              (entry) => entry.agent === agent.id && entry.envName === envName,
            );
            // The secret is never in this response and there is no route that
            // returns it. `set` and `updatedAt` are everything a UI needs to draw
            // the difference between "not configured" and "configured, replace?".
            return { envName, set: row !== undefined, updatedAt: row?.updatedAt ?? null };
          }),
          /**
           * Whether *this* agent's login can be driven, and what its flow needs.
           *
           * Beside the daemon-wide `loginSupported` rather than instead of it, so
           * an older client still reads what it knows. What this adds is the two
           * facts that field cannot carry: an agent whose CLI does not resolve
           * used to get an enabled button and a `503` after the tap, and every
           * agent got an input box whether or not anything reads one.
           *
           * The same object `GET /agents` carries — see `loginSupportOf`, which is
           * where both of them are decided.
           */
          login: loginSupportOf(agent.id),
        };
      }),
    });
  });

  app.put("/agent-auth/:agent", write, async (c) => {
    if (credentials === undefined) {
      return jsonError(c, 503, "credentials_unavailable", "this daemon has no durable store for credentials");
    }
    const agent = agentIdParam(c);
    if (agent === null) return noSuchHarness(c);

    const body = await readJsonObject(c);
    const envName = body?.["envName"];
    const token = body?.["token"];
    if (typeof envName !== "string" || !registry.sessionRuntime.credentialSlots(agent).includes(envName)) {
      return jsonError(c, 400, "bad_request", "envName must be one this agent reads", {
        envNames: registry.sessionRuntime.credentialSlots(agent),
      });
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      return jsonError(c, 400, "bad_request", "token is required and must be non-empty");
    }
    if (token.length > MAX_CREDENTIAL_CHARS) {
      return jsonError(c, 400, "bad_request", `token exceeds ${MAX_CREDENTIAL_CHARS} characters`);
    }

    credentials.save(agent, envName, token.trim());
    // The availability cache now holds a stale `loggedIn: false` for this agent.
    // Dropping it costs one probe on the next read and is the difference between
    // the UI updating and the UI insisting you are still logged out.
    registry.sessionRuntime.forgetAvailability();
    /*
     * ⚠ **And the refused start, which is a separate record and is cleared by
     * three of the six `forgetAvailability` call sites.** A key arriving is one of
     * them, a login run *finishing* is another, and an explicit
     * `POST /agent-auth/:agent/recheck` is the third — all three are evidence about
     * a harness that would not start. The other three are sign-out-ward — a key
     * being *deleted*, a sign-out, and a login cancelled — and none of those is a
     * reason to believe a harness has started working. Deleting a key must not
     * erase the record of the refusal that key was pasted against.
     */
    registry.sessionRuntime.forgetStartRefusal(agent);
    /*
     * **And the conversations already running on this agent, which the save alone
     * does not reach.** Secrets are injected at spawn, so a token saved while an
     * agent is running reaches it never: the badge turned green and the chat in
     * front of somebody went on failing to authenticate, with nothing on the
     * screen connecting the two. Started rather than awaited — see
     * `reloadCredentials`, and `whenRestarted`, which is what makes typing into a
     * restarting session a wait rather than a refusal.
     */
    const restarting = registry.reloadCredentials(agent);
    return c.json({ saved: true, agent, envName, restarting });
  });

  app.delete("/agent-auth/:agent", write, (c) => {
    if (credentials === undefined) {
      return jsonError(c, 503, "credentials_unavailable", "this daemon has no durable store for credentials");
    }
    /*
     * ⚠ **`DELETE /systems/:system`'s shape, and taking half of it was worse than
     * taking none.** That route removes before it validates *and answers `200` with
     * what the lookup saw* — never an error — precisely so a row this build can no
     * longer place is still deletable. Removing first and then answering `400` is
     * the shape with neither property: the row is gone, the caller is told its
     * request was wrong, and the two invalidation steps below are skipped — leaving
     * a cached `loggedIn: true` over a harness whose only credential has just been
     * deleted, and a running session still holding the secret in its environment.
     *
     * A harness a plugin added stops being offered the moment somebody switches
     * that plugin off, and `GET /agent-auth` stops listing it in the same tick. So
     * the one control that can reach its saved key must not be the one that
     * disappears with it.
     *
     * The slot is still checked where the harness *does* resolve, because there a
     * name it does not read is a caller's mistake worth naming. Where it does not,
     * there is nothing to check against and nothing to be right about: the row is
     * removed and `removed` says whether there was one.
     */
    const named = c.req.param("agent") ?? "";
    const envName = c.req.query("envName") ?? "";
    if (named.length === 0 || envName.length === 0) {
      return jsonError(c, 400, "bad_request", "envName is required");
    }
    const agent = agentIdParam(c);
    if (agent !== null && !registry.sessionRuntime.credentialSlots(agent).includes(envName)) {
      return jsonError(c, 400, "bad_request", "envName must be one this agent reads", {
        envNames: registry.sessionRuntime.credentialSlots(agent),
      });
    }
    const had = credentials.list().some((one) => one.agent === named && one.envName === envName);
    credentials.remove(named, envName);
    registry.sessionRuntime.forgetAvailability();
    /*
     * Removing one is the same fact as saving one *for the sessions still
     * running*: the agents already up still hold it in their environment, and
     * only a relaunch takes it away.
     *
     * ⚠ **It is the opposite fact for the ones already ended, which is what the
     * `false` says.** Left to default, this resumed every conversation carrying
     * `agent_signed_out` — conversations this daemon ended *because the
     * credential went away* — and handed each a fresh agent with nothing to
     * authenticate with. Deleting a credential is a sign-out's second half, not
     * its reversal.
     */
    const restarting = registry.reloadCredentials(named, false);
    return c.json({ removed: had, agent: named, envName, restarting });
  });

  /**
   * Signs the agent's own CLI out, and forgets the token we were holding for it.
   *
   * **Both halves, and the second is what makes the first mean anything.** The
   * login probe deliberately runs with the pasted credential in its environment,
   * so a sign-out that ran the CLI's logout and left `agent_credentials` alone
   * would answer 200, re-probe, still find a token, and report `loggedIn: true`
   * — a button that looks broken while doing exactly what it said.
   *
   * Credentials first, so the logout itself runs without them — and if the CLI
   * then fails, the token stays cleared. That is the right way round: a partial
   * sign-out that dropped the credential we were holding is closer to what was
   * asked than one that dropped nothing, and the `502` says which half happened.
   *
   * `503 logout_unsupported` where the CLI has no such verb — measured, kimi has
   * none — using the same status and sentence shape as `login_unsupported` two
   * routes down, because it is the same kind of answer: the request is fine and
   * this daemon will not do it.
   */
  app.post("/agent-auth/:agent/logout", write, async (c) => {
    const agent = agentIdParam(c);
    if (agent === null) return noSuchHarness(c);
    if (!registry.sessionRuntime.loginSupport(agent).canSignOut) {
      return jsonError(
        c,
        503,
        "logout_unsupported",
        `${agent} has no sign-out command; remove its credentials on that machine by hand`,
      );
    }

    let cleared = 0;
    for (const envName of registry.sessionRuntime.credentialSlots(agent)) {
      if (credentials?.list().some((row) => row.agent === agent && row.envName === envName) === true) {
        credentials.remove(agent, envName);
        cleared += 1;
      }
    }

    const result = await registry.sessionRuntime.logout(agent);
    registry.sessionRuntime.forgetAvailability();
    if (result === null) {
      // `canSignOut` said otherwise a moment ago, so the table and the runtime
      // disagree. Reported rather than smoothed over.
      return jsonError(c, 503, "logout_unsupported", `${agent} has no sign-out command`);
    }
    if (!result.ok) return jsonError(c, 502, "logout_failed", result.detail ?? "the CLI refused");
    /*
     * **And every conversation running on it, which the CLI's own logout cannot
     * reach.** A credential is read at spawn, so an agent started while signed in
     * keeps answering for an account somebody has just revoked. Awaited, unlike
     * the relaunch a *saved* credential triggers: signing out is a request to
     * stop, and answering before it has stopped would be reporting a state that
     * is not true yet.
     */
    const ended = await registry.signOutSessions(agent);
    return c.json({
      signedOut: true,
      agent,
      credentialsCleared: cleared,
      sessionsEnded: ended,
      detail: result.detail,
    });
  });

  /**
   * Ask this harness again, after somebody has fixed it somewhere this daemon
   * cannot see.
   *
   * ⚠ **This is what the New session strip owes for hiding a tile.** A harness
   * that refused to open a session loses its tile — `offersTile`'s established
   * trade, argued in `agentCard.ts` — and the settings row it keeps is where the
   * badge says why. But the commonest remedy for a harness with no sign-in wizard
   * is *not* on any screen: it is running the CLI once in a terminal on the
   * machine itself, which is exactly what a contributed harness's own `authHint`
   * asks for. Nothing about that reaches this process, so without a control the
   * only way back would be waiting out `START_REFUSAL_TTL_MS`.
   *
   * ⚠ **And it may not refuse where `login` and `logout` do, which is why it is
   * not modelled on either.** Both of those answer `503` for a harness with no
   * such verb — and a harness with no such verb is precisely the one this exists
   * for. It asks nothing of the agent and takes nothing away: it drops what this
   * daemon remembered and answers the fresh row, so the next listing is a real
   * measurement rather than a recollection.
   *
   * ⚠ **Under `/agent-auth/` rather than beside `/agents`, and that placement is
   * load-bearing rather than tidy.** This route calls `availability()`, which runs
   * the login probe — a CLI spawn per harness. The browser's `slowRoute` matches
   * `/agent-auth` by **prefix** (and `/agents` only on `GET`), so a `POST` here
   * inherits the 90s budget; named anywhere else it would have taken the ordinary
   * 15s, and an abort there is a *transport* failure, which is `forgetRoute` and a
   * perfectly healthy machine drawn as unreachable everywhere at once. That is the
   * defect `GET /agents/capabilities` shipped with, recorded in `machine.ts` at
   * the predicate itself.
   */
  app.post("/agent-auth/:agent/recheck", write, async (c) => {
    const agent = agentIdParam(c);
    if (agent === null) return noSuchHarness(c);
    registry.sessionRuntime.forgetStartRefusal(agent);
    registry.sessionRuntime.forgetAvailability();
    const found = (await registry.sessionRuntime.availability()).find((one) => one.id === agent) ?? null;
    /*
     * The row rather than `{ok: true}`, and the lookup rather than an assumption:
     * this is `DELETE /systems/:system`'s shape — do the thing, then answer with
     * what the listing now says — so a screen that redraws from this response
     * cannot disagree with the one that redraws from `GET /agents`.
     *
     * ⚠ **Including `login`, which `availability()` does not carry and which is
     * therefore the field this shape drops by default.** It is built in
     * `loginSupportOf` and spread onto the two listings by hand, so a third route
     * answering an agent row has to spread it too — and the cost of not doing so
     * is measured and specific: with no `login` object, `no_flow` is gone and both
     * this client's ladder and the browser's fall to *cannot check*, which is the
     * permanent-wrong-badge failure `local.ts` returns `no_flow` to prevent. The
     * sentence above would then have been false of the very first field a reader
     * of this response looks at.
     */
    return c.json({
      agent,
      ...(found === null
        ? { rechecked: false }
        : { rechecked: true, info: { ...found, login: loginSupportOf(found.id) } }),
    });
  });

  app.post("/agent-auth/:agent/login", write, async (c) => {
    if (logins === null) {
      return jsonError(
        c,
        503,
        "login_unsupported",
        "this daemon's runtime will not drive an agent login; paste a token instead",
      );
    }
    const agent = agentIdParam(c);
    if (agent === null) return noSuchHarness(c);

    try {
      const run = await logins.start(agent);
      if (run === null) {
        return jsonError(c, 503, "login_unsupported", "this daemon's runtime will not drive an agent login");
      }
      return c.json(run, 201);
    } catch (error) {
      const message = describeError(error);
      return jsonError(c, 502, "login_failed", message);
    }
  });

  app.get("/agent-auth/login/:loginId", read, (c) => {
    if (logins === null) return jsonError(c, 404, "login_not_found", "no such login");
    const since = Number(c.req.query("since") ?? 0);
    const chunk = logins.read(c.req.param("loginId"), Number.isFinite(since) ? since : 0);
    // A superseded run's id no longer resolves, which is what stops a wizard that
    // has not noticed it was replaced from reading its successor's transcript —
    // and that transcript can contain a one-time code.
    if (chunk === null) return jsonError(c, 404, "login_not_found", "no such login");
    // The flow just ended, so whatever we last believed about "is this agent
    // signed in" is stale — and this is the exact moment the client learns it,
    // so it is the moment to make the next answer fresh. Without it the badge
    // beside a successful login kept reading "not signed in".
    if (chunk.done) {
      registry.sessionRuntime.forgetAvailability();
      /*
       * ⚠ **And the refused start, because a finished sign-in is a credential
       * arriving through the other door.** The rule this route is an exception to
       * — that only `PUT /agent-auth/:agent` clears the record — was written
       * against the four *sign-out-ward* events, and a wizard that has just run to
       * completion is not one of them. Without this the whole flow ends wrong:
       * `agentStance` puts `start_refused` above `signed_in`, so somebody who
       * signed in inside the app kept the badge *would not start*, kept no tile,
       * and lost the sign-in door itself — `signInOffered` wants
       * `loggedIn === false` — with `POST /sessions` still refusing on the stale
       * message for the rest of the budget.
       *
       * Cleared on the run *ending* rather than on it succeeding, deliberately:
       * this route has no verdict to read, and the two failure modes are not
       * symmetric. A wrongly cleared record costs one start attempt, which
       * re-records it; a wrongly kept one costs ten minutes of a screen
       * contradicting the wizard the reader just finished.
       */
      registry.sessionRuntime.forgetStartRefusal(chunk.agent);
    }
    return c.json(chunk);
  });

  app.post("/agent-auth/login/:loginId/input", write, async (c) => {
    if (logins === null) return jsonError(c, 404, "login_not_found", "no such login");
    const body = await readJsonObject(c);
    const text = body?.["text"];
    if (typeof text !== "string") {
      return jsonError(c, 400, "bad_request", "text is required");
    }
    if (text.length > MAX_CREDENTIAL_CHARS) {
      return jsonError(c, 400, "bad_request", `text exceeds ${MAX_CREDENTIAL_CHARS} characters`);
    }
    // HTTP rather than the stream, deliberately: a login code is sent once and
    // is unrecoverable if it evaporates, which is precisely what `ws.send()`
    // into a half-open socket does. The response is the confirmation.
    const result = logins.write(c.req.param("loginId"), text);
    if (result.kind === "not_found") return jsonError(c, 404, "login_not_found", "no such login");
    if (result.kind === "not_interactive") {
      // A device-code flow spawned with no stdin — see `loginStdio`. It used to
      // be a silent no-op that answered 200, so a code typed into the box went
      // nowhere and the response said it had landed.
      return jsonError(
        c,
        400,
        "login_not_interactive",
        "this login reads no input; finish it on the page it printed",
      );
    }
    return c.json(result.view);
  });

  app.delete("/agent-auth/login/:loginId", write, async (c) => {
    if (logins === null) return jsonError(c, 404, "login_not_found", "no such login");
    const cancelled = await logins.cancel(c.req.param("loginId"));
    if (!cancelled) return jsonError(c, 404, "login_not_found", "no such login");
    registry.sessionRuntime.forgetAvailability();
    return c.json({ cancelled: true });
  });

  /* ---------------------------------------------------------------- *
   * Picking a working directory
   * ---------------------------------------------------------------- */

  /**
   * Where the picker starts, from `REEMOAT_ROOTS` or the daemon user's home.
   *
   * Daemon-wide again. It was per-tenant while one daemon answered for several
   * people, because a shared root list is then a listing of other people's
   * projects; there is one person now, and these are their own directories.
   *
   * A narrowing of the *listing* and nothing more — `resolveCwd` is deliberately
   * not confined to it, so a repository kept outside these is still somewhere a
   * session can start.
   */

  app.get("/fs/roots", read, (c) =>
    c.json({
      roots,
      /*
       * Unfiltered, and that is the change rather than an oversight.
       *
       * This used to drop any recent cwd outside the caller's own tree, because a
       * row could name a directory a confined `resolveCwd` would then refuse —
       * offering a button that answers 403. Nothing is confined now, so every
       * recent directory is one a session really can start in, and filtering to
       * the browse roots would hide exactly the ones somebody keeps outside them.
       */
      recent: registry.recentCwds(),
    }),
  );

  /**
   * Makes one directory, so a session can start somewhere that does not exist yet.
   *
   * `session:write` rather than `read`: this is the only route under `/fs` that
   * changes anything.
   */
  app.post("/fs/mkdir", write, async (c) => {
    const body = await readJsonObject(c);
    const parent = body?.["parent"];
    const name = body?.["name"];
    if (typeof parent !== "string" || typeof name !== "string") {
      return jsonError(c, 400, "bad_request", "parent and name are both required");
    }
    if (name.length > MAX_DIR_NAME_CHARS) {
      return jsonError(c, 400, "bad_request", `name exceeds ${MAX_DIR_NAME_CHARS} characters`);
    }
    // `parent` was bounded by nothing at all while `name` was bounded carefully,
    // and it is the one that reaches `realpath`. A path is many segments, hence
    // the larger ceiling; having one at all is the point, since this route is
    // reachable through the relay.
    if (parent.length > MAX_PATH_CHARS) {
      return jsonError(c, 400, "bad_request", `parent exceeds ${MAX_PATH_CHARS} characters`);
    }
    try {
      return c.json({ path: await makeDir(parent, name) }, 201);
    } catch (error) {
      if (error instanceof PathError) {
        return jsonError(c, pathErrorStatus(error, 400), error.code, error.message);
      }
      const errno = errnoError(c, error, 400);
      if (errno) return errno;
      throw error;
    }
  });

  /**
   * Bring a codebase onto this machine.
   *
   * Registered here rather than under `/sessions` because it happens **before**
   * there is a session: it is how somebody gets a folder worth starting one in,
   * and `POST /fs/mkdir` above is the precedent — the other mutating, session-free
   * `/fs` route. `session:write` for the same reason it does.
   *
   * The archive's filename rides `?name=` rather than a header, for the reason
   * the upload route gives at length: `CORS_ALLOW_HEADERS` is `authorization` and
   * `content-type` only, the relay imports that same constant to answer
   * preflights from it, and a new header would need a control-plane redeploy
   * before a browser could send it at all.
   *
   * **Every refusal cancels the body**, which is why this route does its own
   * argument checking through `refuse()` instead of reading like the ones above
   * it. The relay grants a stream's window on consumption, so a handler that
   * answers 400 and walks away parks the sender at one `STREAM_WINDOW_BYTES` —
   * and the next valve is
   * the tunnel's 8 MiB socket check, which closes the whole tunnel for this
   * machine and takes every other session on it down too.
   */
  app.post("/fs/import", write, async (c) => {
    const refuse = async <T>(answer: () => T): Promise<T> => {
      await cancelBody(c.req.raw.body as ReadableStream<Uint8Array> | null);
      return answer();
    };

    if (registry.isShuttingDown) {
      return refuse(() => jsonError(c, 503, "shutting_down", "the daemon is shutting down"));
    }

    const path = c.req.query("path") ?? "";
    if (path.length === 0) return refuse(() => jsonError(c, 400, "bad_request", "path is required"));
    if (path.length > MAX_PATH_CHARS) {
      return refuse(() => jsonError(c, 400, "bad_request", `path exceeds ${MAX_PATH_CHARS} characters`));
    }

    // Sanitized with the uploads route's own function: this string is a *label*
    // here too — it only ever names the folder when the archive does not name one,
    // and `importFolderName` narrows it again to what may be a directory name.
    const requested = c.req.query("name") ?? "";
    const named = sanitizeUploadName(requested);
    if (!named.ok) {
      return refuse(() =>
        jsonError(c, 400, "invalid_name", "that filename cannot be stored", { reason: named.reason }),
      );
    }

    /*
     * Honoured to refuse, never to accept — the same rule the upload route
     * states. Refusing on a `content-length` we believe costs nothing; *trusting*
     * one would mean a body that lies walks past the counter that is actually
     * enforcing this.
     */
    const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
      return refuse(() =>
        jsonError(c, 413, "import_too_large", `an archive may not exceed ${MAX_IMPORT_BYTES} bytes`, {
          limit: MAX_IMPORT_BYTES,
          declared,
        }),
      );
    }

    /*
     * One at a time, for the whole daemon.
     *
     * The relay allows 256 concurrent streams and this route has no per-session
     * accounting to fall back on the way uploads do — nothing here is charged
     * against a budget that outlives the request. Two hundred and fifty-six
     * simultaneous imports is 12 GiB of archive and 125 GiB of unpacked tree, so
     * the bound has to be arrival rather than size. A person imports a codebase
     * about as often as they start a project, so serialising it costs nothing
     * real, and `409` with a sentence is a better answer than a machine that has
     * filled its disk.
     */
    if (importing) {
      return refuse(() =>
        jsonError(c, 409, "import_busy", "this machine is already unpacking an import"),
      );
    }

    /*
     * ⚠ **Claimed here, before the first `await`, and that placement is the whole
     * guard.** The check above and this line used to have `resolveCwd` between
     * them, which is a `realpath` — a real suspension, and one `stall.ts` records
     * as able to queue for ever against a mount that has gone away. Every request
     * that arrived while it was in flight read `importing` as `false`, so the
     * bound this is here to enforce did not hold for the case it was written for:
     * the 256 the relay allows arriving together all passed. Nothing between the
     * test and the set may suspend, so everything that can is below it, inside
     * the `finally` that releases it.
     */
    importing = true;
    try {
      let target: string;
      try {
        target = await resolveCwd(path);
      } catch (error) {
        if (error instanceof PathError) {
          return refuse(() => jsonError(c, pathErrorStatus(error, 400), error.code, error.message));
        }
        const errno = errnoError(c, error, 400);
        if (errno) return refuse(() => errno);
        await cancelBody(c.req.raw.body as ReadableStream<Uint8Array> | null);
        throw error;
      }

      const body = c.req.raw.body;
      if (body === null) return jsonError(c, 400, "bad_request", "expected a request body");

      const outcome: ImportOutcome = await importArchive({ target, name: named.name, body });

      switch (outcome.kind) {
        case "ok":
          return c.json({ import: outcome.result }, 201);
        case "too_large":
          return jsonError(c, 413, "import_too_large", `an archive may not exceed ${MAX_IMPORT_BYTES} bytes`, {
            limit: MAX_IMPORT_BYTES,
          });
        case "unsupported":
          return jsonError(c, 400, "unsupported_archive", "that is not a .zip or a .tar.gz");
        case "exists":
          return jsonError(c, 409, "import_exists", `${outcome.name} is already here`, { name: outcome.name });
        case "refused": {
          const { error } = outcome;
          if (error.code === "too_large") {
            return jsonError(c, 413, "import_unpacked_too_large", error.message, {
              limit: MAX_IMPORT_UNPACKED_BYTES,
            });
          }
          if (error.code === "too_many") {
            return jsonError(c, 413, "import_too_many_entries", error.message, { limit: MAX_IMPORT_ENTRIES });
          }
          if (error.code === "unsafe") {
            return jsonError(c, 400, "archive_unsafe", error.message, error.refusal);
          }
          if (error.code === "empty") return jsonError(c, 400, "archive_empty", error.message);
          return jsonError(c, 400, "archive_unreadable", error.message);
        }
        case "write_failed":
          return jsonError(c, 503, "import_write_failed", "could not unpack that here", {
            detail: outcome.detail,
          });
      }
    } finally {
      importing = false;
    }
  });

  app.get("/fs/list", read, async (c) => {
    const path = c.req.query("path") ?? null;
    const showHidden = c.req.query("hidden") === "1";
    try {
      // Awaited, and the `async` on the handler is not cosmetic: `c.json()` of an
      // unawaited promise serializes as `{}`, and a `try` around a promise that is
      // never awaited catches nothing.
      return c.json(await listDirs(path, { roots, showHidden }));
    } catch (error) {
      if (error instanceof PathError) {
        return jsonError(c, pathErrorStatus(error, 404), error.code, error.message);
      }
      const errno = errnoError(c, error, 404);
      if (errno) return errno;
      throw error;
    }
  });

  /* ---------------------------------------------------------------- *
   * Sessions
   * ---------------------------------------------------------------- */

  app.post("/sessions", write, async (c) => {
    if (registry.isShuttingDown) {
      return jsonError(c, 503, "shutting_down", "the daemon is shutting down");
    }
    const body = await requireJson(c);
    if (body instanceof Response) return body;

    /*
     * The harness, and where it comes from.
     *
     * ⚠ **`customAgent` and `agent` are not alternatives, and this route does not
     * make the caller keep them in step.** A preset already names its harness, so
     * when one is given that is what `agent` becomes — a body sending both and
     * disagreeing cannot produce a session running something neither field named.
     * `machineOf().harnessState(agent)` guards the other arm below, and since the
     * union widened it is the only door into what this machine offers that a
     * request can reach.
     */
    let customAgent: string | null = null;
    let agent: string | undefined;
    const namedPreset = body["customAgent"];
    if (namedPreset !== undefined && namedPreset !== null) {
      if (typeof namedPreset !== "string" || namedPreset.length === 0) {
        return jsonError(c, 400, "bad_request", "customAgent must be a non-empty string");
      }
      if (systems === null) {
        return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
      }
      const preset = systems.customAgents.get(namedPreset);
      /*
       * ⚠ **Its own code, because `not_found` already means something else on this
       * route.** A `cwd` that does not exist reaches the `PathError` arm below and
       * answers `400 not_found`; this is `404 not_found`. `docs/API.md` says read
       * the code and never the status, so two refusals sharing a code with
       * opposite remedies — "pick a different folder" against "that preset was
       * deleted on another device" — is the one thing that convention cannot
       * absorb. Every other 404 in this daemon is already `*_not_found`.
       */
      if (preset === null) {
        return jsonError(c, 404, "custom_agent_not_found", "no such agent");
      }
      customAgent = preset.id;
      agent = preset.harness;
      /*
       * ⚠ **The preset's *system* is weighed here, on the axis the fence below
       * does not cover.** `create` already refuses a harness that would not start
       * before `createWorkspace`, and the reason it gives is the one that applies
       * word for word here: an `applySystem` failure lands *after* the worktree,
       * the branch and the session row are made, so every press on a preset whose
       * provider is switched off was permanent growth inside somebody's own
       * repository followed by a `502`. Nothing upstream caught it — `startableHere`
       * in the browser weighs only the harness, so the tile draws enabled and can
       * be the machine's default, and `readCustomAgent` keeps the row by *shape*,
       * so the preset survives its plugin being switched off exactly as designed.
       *
       * Only for a preset, and only for a *contributed* system: a built-in always
       * answers `enabled`, and a bare start names no system at all. `503` rather
       * than `400` for the reason the paragraph below gives — this is the machine's
       * state and one toggle fixes it.
       */
      if (machineOf().systemState(preset.system) !== "enabled") {
        return jsonError(
          c,
          machineOf().systemState(preset.system) === "disabled" ? 503 : 400,
          machineOf().systemState(preset.system) === "disabled"
            ? "system_unavailable"
            : "invalid_system",
          machineOf().systemState(preset.system) === "disabled"
            ? "this agent is assembled on a provider that comes from a plugin switched off on this machine"
            : "this agent is assembled on a provider this machine no longer offers",
          { system: preset.system },
        );
      }
    } else {
      const named = body["agent"];
      agent = typeof named === "string" ? named : undefined;
    }
    /*
     * ⚠ **Three answers rather than two, because "switched off" and "never
     * existed" have opposite remedies.** A `400` says *fix your request*, which is
     * the truth for an id nobody has ever offered and a lie for one that worked
     * yesterday and whose plugin somebody disabled this morning — that is the
     * machine's state, not the caller's mistake, and it is the shape
     * `system_not_routable` already has.
     */
    if (typeof agent !== "string" || machineOf().harnessState(agent) === "unknown") {
      return jsonError(c, 400, "invalid_agent", "agent must be one this machine offers", {
        offers: machineOf().harnessIds(),
      });
    }
    if (machineOf().harnessState(agent) === "disabled") {
      return jsonError(
        c,
        503,
        "harness_unavailable",
        "this agent comes from a plugin that is switched off on this machine",
      );
    }
    const cwd = body["cwd"];
    if (typeof cwd !== "string" || cwd.length === 0) {
      return jsonError(c, 400, "bad_request", "cwd is required");
    }

    // `true`/`false` are the shorthands a human types; "auto" is the default and
    // "require" is for a caller that would rather fail than run without isolation.
    const raw = body["worktree"];
    let worktree: WorktreePolicy | undefined;
    if (raw === true) worktree = "require";
    else if (raw === false) worktree = "never";
    else if (raw === "auto" || raw === "require" || raw === "never") worktree = raw;
    else if (raw !== undefined) {
      return jsonError(c, 400, "bad_request", 'worktree must be true, false, "auto", "require" or "never"');
    }

    const branchRaw = body["branch"];
    if (branchRaw !== undefined && (typeof branchRaw !== "string" || branchRaw.length === 0 || branchRaw.length > 200)) {
      return jsonError(c, 400, "bad_request", "branch must be a non-empty string of at most 200 characters");
    }
    const branch = typeof branchRaw === "string" ? branchRaw : null;

    try {
      // The owner comes from the verified principal, never from the body. A
      // client able to name its own owner would make the field a decoration.
      //
      // It is now the tenant id rather than the raw subject, so it is never null
      // — the shared secret writes `local`. That matters because the owner is
      const managed = await registry.create({ agent, customAgent, cwd, worktree, branch });
      return c.json({ session: managed.snapshot() }, 201);
    } catch (error) {
      if (error instanceof PathError) {
        // `outside_roots` is a refusal, not a malformed body — the same answer
        // `/fs/list` gives for the same fact. The rest really are bad input.
        return jsonError(c, pathErrorStatus(error, 400), error.code, error.message);
      }
      if (error instanceof WorktreeError) {
        return worktreeError(c, error);
      }
      if (error instanceof SystemRoutingError) {
        /*
         * 502 and its own code, beside `agent_auth_required` rather than among
         * the 400s: the request was well formed and named a preset this daemon
         * holds — what failed is the agent, or a key that is not there. The
         * remedies are "save a key" and "pick a different pairing", and neither
         * is "fix your request".
         */
        return jsonError(c, 502, "system_not_routable", error.message);
      }
      if (error instanceof SessionLimitError) {
        /*
         * 429, and the code says which bound refused because the remedies differ:
         * `too_many_sessions` is "stop one", `session_rate_limited` is "wait".
         * `retryAfterSeconds` rides the detail rather than a header for the reason
         * the control plane's own `tooManyAttempts` gives — a parsed `ApiError`
         * carries the body and never the headers, so a number in a header is one
         * no client here can read.
         */
        return jsonError(c, 429, error.reason, error.message, {
          retryAfterSeconds: error.retryAfterSeconds,
        });
      }
      if (error instanceof AgentUnavailableError) {
        return jsonError(c, 503, "agent_unavailable", error.message);
      }
      if (error instanceof StartTimeoutError) {
        return jsonError(c, 504, "agent_start_timeout", error.message, {
          sessionId: error.sessionId,
          timeoutMs: error.timeoutMs,
        });
      }
      const message = describeError(error);
      /*
       * ⚠ **Through `isAuthRequiredMessage`, which is where that concession is
       * supposed to live and where its own docblock already claims it does.** The
       * rewrap in `session.ts` throws a plain `Error`, so reading the sentence is
       * all any caller can do — and this was the fourth hand-written copy of the
       * pattern, uncounted by the docblock that says there are two. It matters
       * more now: `registry.create` re-throws a *remembered* refusal so a second
       * press costs no worktree, and that answer has to land on this same arm with
       * the same code, or the two presses report the same failure differently.
       */
      const code = isAuthRequiredMessage(message) ? "agent_auth_required" : "agent_launch_failed";
      return jsonError(c, 502, code, message);
    }
  });

  /**
   * Every session on this daemon, or a bounded, priority-ordered page of them.
   *
   * Unbounded by default, because that is what it has always been and
   * `scripts/client.ts` prints the result in creation order. But retention is 200
   * sessions and each row is a full snapshot, so a phone polling this every four
   * seconds per machine moves on the order of a hundred megabytes an hour on LTE
   * for a list whose interesting part is a handful of rows. `?limit=` is the fix,
   * and it is opt-in so no existing caller changes behaviour.
   *
   * **Truncation is only safe because the order changes with it.** With a `limit`
   * the list is returned blocked-first, then everything else still live, then the
   * most recent terminal sessions — so dropping the tail can only ever drop the
   * rows nobody is waiting on. Returning creation order and cutting it would let a
   * limit hide the one blocked session the whole product exists to surface. The
   * reorder therefore happens exactly when a cut can happen, and not otherwise.
   *
   * `total` and `truncated` are always present. A client that prunes state for
   * sessions missing from the response has to know the difference between "gone"
   * and "outside the window", and a list that quietly stops short reads as
   * complete.
   */
  app.get("/sessions", read, (c) => {
    const all = registry.list().map((session) => session.snapshot());
    const limitParam = c.req.query("limit");
    const limit = limitParam === undefined ? null : Math.max(0, boundedInt(limitParam, 0));

    if (limit === null) {
      return c.json({ sessions: all, total: all.length, truncated: false, now: Date.now(), instanceId });
    }

    const ranked = [...all].sort((a, b) => listRank(a) - listRank(b) || b.createdAt - a.createdAt);
    const sessions = ranked.slice(0, limit);
    return c.json({
      sessions,
      total: all.length,
      truncated: sessions.length < all.length,
      now: Date.now(),
      instanceId,
    });
  });

  /*
   * ⚠ **The one read that carries the *whole* model list**, and the browser
   * depends on it. `GET /sessions` cuts the choices of every option to
   * `MAX_SNAPSHOT_CHOICES` because sixty of those records ride a four-second poll
   * to a phone; a keyed opencode publishes 362 models, so without the cut the list
   * response is dominated by menus nobody is looking at. This route is one session,
   * asked for on purpose, and is not polled — so it answers in full, and
   * `truncated` on the polled copy is what tells a picker to come here.
   */
  app.get("/sessions/:id", read, withSession((c, managed) => {
    return c.json({ session: managed.snapshot({ fullConfig: true }) });
  }));

  app.delete("/sessions/:id", write, withSession(async (c, managed) => {
    await managed.stop("stopped");
    return c.json({ session: managed.snapshot() });
  }));

  /**
   * Reattaches a fresh agent to a session that ended.
   *
   * A route rather than anything on the stream, because the WS is read-only:
   * everything that mutates state is an HTTP request. Mirrors POST /sessions in
   * both its error codes and its shape, since it is the same launch underneath.
   */
  app.post("/sessions/:id/resume", write, withSession(async (c, managed) => {
    if (registry.isShuttingDown) {
      return jsonError(c, 503, "shutting_down", "the daemon is shutting down");
    }

    // The workspace is checked here for the same reason the auto-resume pass
    // checks it: claude's adapter refuses a nonexistent `cwd` with
    // `invalidParams`, so a manual resume of a removed worktree used to surface
    // as a baffling `502 agent_launch_failed` from inside the agent instead of
    // the `409 workspace_missing` this daemon already knows how to say.
    const gate = await workspaceReady(c, managed);
    if (gate) return gate;

    try {
      await managed.resume();
      return c.json({ resumed: true, session: managed.snapshot() });
    } catch (error) {
      // One mapping, shared with the automatic path in `registry.ts`. Two would
      // mean the button and the boot pass explaining the same failure with
      // different words to the same client.
      const failure = describeResumeFailure(error);
      const detail: Record<string, unknown> =
        error instanceof StartTimeoutError
          ? { sessionId: error.sessionId, timeoutMs: error.timeoutMs }
          : failure.status === 409
            ? { status: managed.status }
            : { session: managed.snapshot() };
      return jsonError(c, failure.status, failure.code, failure.message, detail);
    }
  }));

  app.post("/sessions/:id/prompt", write, withSession(async (c, managed) => {
    if (registry.isShuttingDown) {
      return jsonError(c, 503, "shutting_down", "the daemon is shutting down");
    }

    const body = await readJsonObject(c);
    const attachments = body?.["attachments"];
    const ids: string[] = [];
    if (attachments !== undefined) {
      if (!Array.isArray(attachments)) {
        return jsonError(c, 400, "bad_request", "attachments must be an array of upload ids");
      }
      // Length checked *before* iterating. `readJson` is `c.req.json()` with no
      // bound, so an array that arrives is whatever the caller sent.
      if (attachments.length > MAX_PROMPT_ATTACHMENTS) {
        return jsonError(c, 400, "too_many_attachments", `at most ${MAX_PROMPT_ATTACHMENTS} files per message`, {
          limit: MAX_PROMPT_ATTACHMENTS,
        });
      }
      for (const id of attachments) {
        if (typeof id !== "string" || id.length === 0 || id.length > 64) {
          return jsonError(c, 400, "bad_request", "each attachment must be a non-empty upload id");
        }
        ids.push(id);
      }
    }

    let staged: UploadRow[] = [];
    if (ids.length > 0) {
      if (!uploads) return jsonError(c, 503, "uploads_unavailable", "this daemon has no upload store");
      // Resolved here, synchronously, so an unknown id is refused before any
      // state moves. Keyed on the pair, so an id belonging to another session is
      // *missing* rather than forbidden.
      const found = uploads.resolve(managed.id, ids);
      if (!found.ok) {
        return jsonError(c, 400, "unknown_attachment", "no such upload on this session", {
          uploadId: found.missing,
        });
      }
      staged = found.rows;
    }

    /*
     * Text is required **unless** files came with it.
     *
     * A message that is only a screenshot is an ordinary thing to send, and this
     * route refused it — validated before it had even looked at `attachments`,
     * which is why the order above is now attachments first. The client is
     * deliberately not allowed to paper over it by inventing "here is a file":
     * that puts words in the operator's mouth inside the model's context, and the
     * model reads them as instructions.
     *
     * Still refused when there is nothing at all: an empty prompt with no files
     * is a mis-tap, and answering it would start a turn about nothing.
     */
    const text = body?.["text"];
    if (typeof text !== "string") {
      return jsonError(c, 400, "bad_request", "text must be a string");
    }
    if (text.trim().length === 0 && staged.length === 0) {
      return jsonError(c, 400, "bad_request", "send some text, a file, or both");
    }
    if (text.length > MAX_PROMPT_CHARS) {
      return jsonError(c, 400, "bad_request", `text exceeds ${MAX_PROMPT_CHARS} characters`);
    }

    /*
     * A message to a session the daemon ended brings it back first.
     *
     * This is what makes "you wait out the deploy and go on talking" true for
     * the session the boot pass missed, gave up on, or has not reached yet — and
     * for `agent_exited`, which the boot pass deliberately leaves alone because
     * nobody asked it to. Here rather than in `ManagedSession.prompt`, which is
     * synchronous by contract: it answers a 202 carrying `{turn, seq}` and calls
     * `safeAppend`, so there is nowhere in it to put an await. The route already
     * owns every other pre-flight, and it is the only layer that can choose its
     * own latency budget — the client puts this path on the 90s slow-route
     * timeout precisely because of these lines.
     *
     * **After** body validation, so a mis-tap never spawns an agent.
     *
     * A failure falls through to the `terminal` arm below rather than answering
     * with something new. The client already knows `409 session_terminal`; a
     * transparent step that failed should not invent an error surface for a
     * request that, from the caller's side, is exactly the one they always sent.
     */
    /*
     * A restart this daemon started is waited out, not refused.
     *
     * `applyUltracode` stops the agent and puts a new one in front of the same
     * conversation, and for those seconds `ManagedSession.prompt` answers
     * `409 turn_in_flight`. From the composer that is somebody flipping a setting,
     * typing, and being told no — about work they did not ask for and cannot see,
     * now that the strip draws the restart as already done.
     *
     * Here rather than in `ManagedSession.prompt`, which is synchronous by
     * contract: it sets `turn` before any await, and that is what makes its own
     * 409 exact. This is the same shape as the resume below — a transparent step
     * in front of the request the caller actually sent — and it is deliberately
     * **first**, so everything after it reads a settled session rather than one
     * mid-restart.
     *
     * Bounded by the restart's own budget (`stop`'s teardown plus `resume`'s 45s
     * start timeout), inside this route's 90s slow-route allowance. It cannot
     * reject, so a restart that failed falls through to the arms below and is
     * reported as the state it left behind.
     */
    /*
     * **There is deliberately no "is this agent signed in" probe here.**
     *
     * An earlier version asked the agent's CLI before every message. It cost a
     * process spawn on the hot path, could only ever be as fresh as its 3s cache,
     * and — the reason it is gone — made the offline drivers depend on whether
     * the person running them happened to be signed in, because a stub runtime
     * inherits the real probe and `resolveLoginBinary` finds the adapter's own
     * vendored copy in `node_modules`. CI is signed in to nothing, so it refused
     * a prompt two assertions expected to land.
     *
     * The two real cases are covered without asking. A sign-out *through this
     * daemon* ends the conversations itself (`signOutSessions`). A credential
     * that went away some other way — revoked elsewhere, or expired — is reported
     * by the agent, at the only moment that cannot be stale: `isAuthFailure` on
     * the event pump, which puts a **fresh agent** under the same conversation and
     * leaves the error in the transcript for somebody to read and send again.
     *
     * ⚠ **This said the pump "ends the session with the same reason", and that
     * has been false since Q7.99.** It described `stop("agent_signed_out")`, which
     * was removed for being wrong about what it had measured — a token with 1.4
     * hours left on it, under a conversation that could never come back. The
     * sentence mattered because it is the argument for there being no probe here:
     * the argument survives, and it is `restartAgent` rather than a terminal
     * status that carries it. See `onAgentUnusable`.
     */
    await managed.whenRestarted();

    /*
     * **The folder has to still be there, and this is asked on every message
     * rather than only before a resume.**
     *
     * ⚠ It guarded the resume branch alone, so a session whose workspace vanished
     * *while it was open* had a live agent standing in a directory that no longer
     * existed — and the first anybody heard of it was the agent's own words in the
     * transcript: `Internal error: Path "…/worktrees/…/s_282fc818" does not
     * exist`. A raw internal error, in the conversation, with no remedy anywhere
     * on the screen and nothing saying which of the many things it could mean it
     * was. Reported from a phone, with a screenshot, after exactly that happened.
     *
     * It is not exotic: `rmworkspace` is a route, `git worktree remove` is a
     * command somebody runs, and a worktree under `~` is a directory a person can
     * delete. What makes it worth a check on the hot path is that the failure is
     * otherwise indistinguishable from the agent breaking.
     *
     * The cost is one `probeExists` — bounded, three-valued, and the reason
     * `stall.ts` exists — per message a human types, against a prompt that is
     * about to spawn or wake a process and hold a 90-second budget. `409
     * workspace_missing` and `503 workspace_unresponsive` are sentences a client
     * already draws, and telling a stalled mount from a deleted directory is the
     * whole reason that function has three answers rather than two.
     */
    const workspace = await workspaceReady(c, managed);
    if (workspace) return workspace;

    if (
      managed.terminal &&
      registry.autoResumeEnabled &&
      // The same gate the boot pass uses: an agent that has told us it no longer
      // holds this conversation will say it again, and spawning one per typed
      // message to hear it is worse than answering from what we already know.
      !managed.resumeSettled &&
      autoResumable(managed.exit, managed.agentSessionId, "prompt")
    ) {
      try {
        await managed.resume();
      } catch {
        // Swallowed on purpose — `managed.resume()` restores the original exit,
        // so the arm below still reports how the session actually ended rather
        // than how this attempt to revive it did.
      }
    }

    /*
     * `/clear` is carried out here, not forwarded.
     *
     * Measured 2026-08-05: sending it to claude's CLI makes it fork to a fresh
     * conversation *underneath* ACP — our session id does not change, the file
     * it names keeps the pre-clear history, and the live conversation gets an id
     * nobody tells us. The next boot's resume then reattached to the abandoned
     * one and handed back a codeword somebody had cleared. Opening the new
     * session ourselves removes the cause: the id is in the response.
     *
     * The menu entry was already ours — claude's adapter filters `clear` out of
     * what it advertises, and this daemon restored it — so implementing it is
     * consistent rather than an interception of somebody else's command. It also
     * makes it work on kimi, which has no `/clear` and answers "Unknown ACP
     * command".
     *
     * Exact match only, and no attachments. `/clear` takes no argument, so
     * anything after it is somebody typing something else — forwarded as text,
     * which is what an unrecognised slash command has always done.
     */
    if (text.trim() === "/clear" && staged.length === 0) {
      const cleared = await managed.clearContext(text.trim());
      switch (cleared.kind) {
        case "cleared":
          return c.json({ accepted: true, cleared: true, seq: cleared.seq, session: managed.snapshot() }, 202);
        case "busy":
          return jsonError(c, 409, "turn_in_flight", "a turn is already in flight", {
            status: cleared.status,
            pendingPermissions: managed.snapshot().pendingPermissions,
            pendingElicitations: managed.snapshot().pendingElicitations,
          });
        case "not_ready":
          return jsonError(c, 409, "session_not_ready", "the agent has not finished starting", {
            status: cleared.status,
          });
        case "terminal":
          return jsonError(c, 409, "session_terminal", "this session has ended", {
            status: cleared.status,
            exit: cleared.exit,
          });
      }
    }

    const result = managed.prompt(text, staged);
    switch (result.kind) {
      case "accepted":
        return c.json({ accepted: true, turn: result.turn, seq: result.seq, session: managed.snapshot() }, 202);
      case "busy":
        // The commonest reason a prompt is refused is a blocked session nobody
        // answered, so say so here rather than making the caller go and look.
        return jsonError(c, 409, "turn_in_flight", "a turn is already in flight", {
          status: result.status,
          pendingPermissions: managed.snapshot().pendingPermissions,
          pendingElicitations: managed.snapshot().pendingElicitations,
        });
      case "not_ready":
        return jsonError(c, 409, "session_not_ready", "the agent has not finished starting", {
          status: result.status,
        });
      case "terminal":
        return jsonError(c, 409, "session_terminal", "this session has ended", {
          status: result.status,
          exit: result.exit,
        });
    }
  }));

  /**
   * Stop the turn in flight, and leave the session running.
   *
   * `write` and not `admin`, beside `/prompt` rather than beside `DELETE
   * /sessions/:id`: this destroys nothing that outlives the request. Whoever may
   * start a turn may stop one, and a grant that could set an agent going on your
   * machine and then not call it off would be the worse of the two halves.
   *
   * **A 200 rather than a 202, and a body that says which of two things happened.**
   * A prompt answers 202 because the work it names is only beginning; a cancel is
   * a request the daemon has finished acting on by the time it answers — the
   * notification is out, anything parked on a human has been settled, and what
   * remains is the agent's own unbounded business, reported as `settled` and
   * never waited for past `CANCEL_SETTLE_MS`.
   *
   * **No body is read.** There is nothing a caller could say: the turn to stop is
   * the one that is running, and taking a turn number would mean answering
   * requests about turns that ended — a refusal somebody would have to handle for
   * no gain, since the only honest reaction to it is the one this route already
   * gives for free.
   *
   * The one shape worth reading twice is `no_turn`, which is a **200 with
   * `cancelled: false`** rather than a 409. Nothing was stopped and nothing is
   * wrong: the caller asked for an agent that is not working, and it is not
   * working. That state is reachable by losing an ordinary race — the tap and the
   * turn's own end are two events nobody orders — and a red error there would
   * make the control look broken at the exact moment it got what it wanted.
   * `terminal` and `not_ready` stay 409s, because those say something the caller
   * does not know: there is no agent at all.
   */
  app.post("/sessions/:id/cancel", write, withSession(async (c, managed) => {
    const result = await managed.cancelTurn();
    switch (result.kind) {
      case "cancelled":
        return c.json({
          cancelled: true,
          turn: result.turn,
          // Deliberately not folded into `cancelled`. One says what this daemon
          // did, which always happened; the other says whether the agent had
          // finished by the time we stopped watching, which is an observation and
          // may be `false` on a cancel that is working perfectly.
          settled: result.settled,
          session: managed.snapshot(),
        });
      case "no_turn":
        return c.json({ cancelled: false, turn: null, settled: true, session: managed.snapshot() });
      case "busy":
        // The same code and the same sentence `/config` answers in this window,
        // and for the same reason: nothing is in flight that a caller could wait
        // on, the agent's conversation is simply being replaced underneath it.
        return jsonError(c, 409, "session_busy", "this session's context is being cleared", {
          status: result.status,
        });
      case "not_ready":
        return jsonError(c, 409, "session_not_ready", "the agent has not finished starting", {
          status: result.status,
        });
      case "terminal":
        return jsonError(c, 409, "session_terminal", "this session has ended", {
          status: result.status,
          exit: result.exit,
        });
    }
  }));

  /*
   * Stage a file for a later prompt.
   *
   * Raw body, and the filename rides `?name=`. That is forced rather than
   * aesthetic: `CORS_ALLOW_HEADERS` is `authorization` and `content-type`, the
   * relay imports that same constant and answers preflights with it, and
   * `relaycheck` asserts the two agree — so a custom `x-filename` would need this
   * file, both drivers *and a control-plane redeploy* before any browser could
   * send one, and the control plane is a separate deployment from this daemon.
   * The one prefix somebody would otherwise reach for, `reemoat-*`, is exactly
   * what the relay strips. A query parameter rides the URL, which the relay
   * forwards verbatim and which `pathOf` already keeps out of its logs.
   *
   * Per session, so `sessionOf` makes an upload against an id that does not exist
   * impossible and there is no orphan namespace to reconcile. A **terminal**
   * session still accepts one, deliberately: `resume` exists, and "it stopped,
   * let me give it a screenshot and start it again" is the ordinary flow rather
   * than an edge case.
   */
  app.post("/sessions/:id/uploads", write, async (c) => {
    /*
     * **Every refusal on this route releases the body first.**
     *
     * `Uploads.receive` spends a paragraph on why, and every word of it applies
     * a layer earlier: these refusals happen with a whole `MAX_UPLOAD_BYTES` in
     * flight and used to return without ever touching the stream. A body nobody
     * reads parks the sender against the relay's per-stream window, and the valve
     * above that closes the whole tunnel for this machine — every other session
     * with it. `invalid_name` is not hypothetical: `pastedName` exists precisely
     * because a nameless paste 400s here, and `upload_too_large` is by
     * construction the path with the largest body behind it.
     */
    const refuse = async <T>(answer: () => T): Promise<T> => {
      await cancelBody(c.req.raw.body as ReadableStream<Uint8Array> | null);
      return answer();
    };

    const managed = sessionOf(c);
    if (!managed) return refuse(() => notFound(c));
    if (registry.isShuttingDown) {
      return refuse(() => jsonError(c, 503, "shutting_down", "the daemon is shutting down"));
    }
    if (!uploads) {
      return refuse(() => jsonError(c, 503, "uploads_unavailable", "this daemon has no upload store"));
    }

    const requested = c.req.query("name") ?? "";
    const named = sanitizeUploadName(requested);
    if (!named.ok) {
      return refuse(() =>
        jsonError(c, 400, "invalid_name", "that filename cannot be stored", { reason: named.reason }),
      );
    }

    const mime = parseMime(c.req.header("content-type"));
    if (mime === undefined) {
      return refuse(() => jsonError(c, 400, "invalid_mime", "content-type must be type/subtype"));
    }

    /*
     * Honoured to refuse, never to accept.
     *
     * The byte counter in `Uploads.receive` is what actually bounds the body, and
     * it is the only such bound anywhere in this system. But refusing a
     * *half-read* body means destroying the request stream, which through the
     * relay destroys the HTTP/2 CONNECT stream carrying it — and that surfaces at
     * the browser as the relay's own `502 tunnel_failed` rather than as the 413
     * written here. Reading the header first keeps the honest status for every
     * client that declares a length, and leaves the counter for chunked bodies
     * and for clients that lie.
     */
    const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return refuse(() =>
        jsonError(c, 413, "upload_too_large", `a file may not exceed ${MAX_UPLOAD_BYTES} bytes`, {
          limit: MAX_UPLOAD_BYTES,
          declared,
        }),
      );
    }

    const body = c.req.raw.body;
    if (body === null) return jsonError(c, 400, "bad_request", "expected a request body");

    const result = await uploads.receive(managed.id, {
      name: named.name,
      origName: requested,
      mime,
      body: body as ReadableStream<Uint8Array>,
    });

    switch (result.kind) {
      case "ok":
        return c.json(
          {
            upload: {
              uploadId: result.row.uploadId,
              name: result.row.name,
              // Echoed once, which is what makes shortening a long name safe
              // rather than a silent loss: the client can say "saved as …".
              originalName: result.row.origName,
              mime: result.row.mime,
              bytes: result.row.bytes,
              createdAt: result.row.createdAt,
              sessionBytes: result.sessionBytes,
              sessionLimit: MAX_SESSION_UPLOAD_BYTES,
              sessionCount: result.sessionCount,
              countLimit: MAX_UPLOADS_PER_SESSION,
            },
          },
          201,
        );
      case "too_large":
        return jsonError(c, 413, "upload_too_large", `a file may not exceed ${MAX_UPLOAD_BYTES} bytes`, {
          limit: MAX_UPLOAD_BYTES,
        });
      case "quota":
        return jsonError(c, 413, "upload_quota_exceeded", "this session has no room for that file", {
          limit: MAX_SESSION_UPLOAD_BYTES,
          used: result.used,
        });
      case "too_many":
        return jsonError(c, 409, "upload_limit", "this session already holds too many staged files", {
          limit: MAX_UPLOADS_PER_SESSION,
        });
      /*
       * The one refusal here that expires on its own, so it says when.
       *
       * `Retry-After` in whole seconds, rounded **up** and never below 1, which
       * is the rule `throttle.ts` already states one package over: a
       * `Retry-After: 0` invites the immediate retry it is refusing. The same
       * number rides the detail in milliseconds, because a client drawing "try
       * again in a moment" wants the real one and a second's resolution is not
       * enough to say a moment.
       */
      case "rate": {
        const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        c.header("Retry-After", String(seconds));
        /*
         * The wait is in the **message**, not only in the detail, because the
         * message is the whole of what a person sees: a failed chip carries
         * `errorText(cause)` and nothing else, beside a retry button. "Too much
         * lately" with no number is a control somebody presses again immediately.
         */
        return jsonError(
          c,
          429,
          "upload_rate_limited",
          `too much has been uploaded to this session lately — try again in ${seconds}s`,
          { limit: UPLOAD_RATE_BYTES, windowMs: UPLOAD_RATE_WINDOW_MS, retryAfterMs: result.retryAfterMs },
        );
      }
      case "write_failed":
        return jsonError(c, 503, "upload_write_failed", "that file could not be stored", {
          detail: result.detail,
        });
    }
  });

  /**
   * Changes one of the agent's own controls: mode, model, reasoning effort.
   *
   * One route for both because ACP's two calls answer very differently —
   * `session/set_config_option` returns the refreshed option set,
   * `session/set_mode` returns nothing at all — and a client should not have to
   * know which one its agent prefers. Either body shape lands on the same
   * response, which is always the agent's *own* view afterwards rather than an
   * echo of the request: setting model rebuilds the available modes and can
   * reset the current one, so what was asked for and what is now true differ
   * often enough to matter.
   */
  app.post("/sessions/:id/config", write, withSession(async (c, managed) => {

    const body = await requireJson(c);
    if (body instanceof Response) return body;

    const modeId = body["modeId"];
    const configId = body["configId"];
    const hasMode = modeId !== undefined;
    const hasOption = configId !== undefined;
    if (hasMode === hasOption) {
      return jsonError(c, 400, "bad_request", 'body must carry exactly one of {"modeId"} or {"configId","value"}');
    }

    let result;
    try {
      if (hasMode) {
        if (typeof modeId !== "string" || modeId.length === 0) {
          return jsonError(c, 400, "bad_request", "modeId must be a non-empty string");
        }
        result = await managed.setMode(modeId);
      } else {
        const value = body["value"];
        if (typeof configId !== "string" || configId.length === 0) {
          return jsonError(c, 400, "bad_request", "configId must be a non-empty string");
        }
        if (typeof value !== "string" && typeof value !== "boolean") {
          return jsonError(c, 400, "bad_request", "value must be a string or a boolean");
        }
        result = await managed.setConfigOption(configId, value);
      }
    } catch (error) {
      // The agent refused or went quiet. Its own message is the useful part —
      // "model X is not available on this account" is the agent's to say — so it
      // is passed through rather than replaced with a generic failure.
      const message = describeError(error);
      return jsonError(c, 502, "agent_config_failed", message, { session: managed.snapshot() });
    }

    switch (result.kind) {
      case "ok":
        return c.json({ config: result.config, session: managed.snapshot() });
      case "unknown_option":
        return jsonError(c, 400, "unknown_config_option", "this agent does not offer that option", {
          options: result.options,
        });
      case "invalid_value":
        return jsonError(c, 400, "invalid_config_value", "the agent does not offer that value for this option", {
          option: result.option,
        });
      case "unknown_mode":
        return jsonError(c, 400, "unknown_mode", "this agent does not offer that mode", {
          modes: result.modes,
        });
      case "busy":
        // Not `turn_in_flight`, which is what a *prompt* refused in this same
        // window answers: nothing is in flight — a clear burns no turn and the
        // status beside this still reads `idle` — and a caller told a turn is
        // running would wait for a `turn_end` that is never coming. What is true
        // is that the agent's conversation is being replaced and this control
        // would land on the wrong one, which is over in about the time it takes
        // to tap again.
        return jsonError(c, 409, "session_busy", "this session's context is being cleared", {
          status: result.status,
        });
      case "turn_in_flight":
        // The one control here that needs the agent restarted, and a turn is
        // what a restart would destroy. `turn_in_flight` rather than
        // `session_busy` because for once it really is a turn, and the caller can
        // act on that: wait, or stop the turn first.
        return jsonError(c, 409, "turn_in_flight", "this change restarts the agent; the turn must end first", {
          status: result.status,
        });
      case "not_ready":
        return jsonError(c, 409, "session_not_ready", "the agent has not finished starting", {
          status: result.status,
        });
      case "terminal":
        return jsonError(c, 409, "session_terminal", "this session has ended", { status: result.status });
    }
  }));

  /**
   * Names a session, or pins it to the top of the list.
   *
   * `POST` on a sub-resource rather than `PATCH` on the session, following
   * `/config` directly above, for no gain over a `POST` that already reads
   * naturally. The cost that used to be half this argument is spent: `PATCH` is
   * in `CORS_ALLOW_METHODS` now — `PATCH /custom-agents/:id` put it there — so
   * the verb no longer buys a preflight failure in every browser. What is left is
   * only that this route names a sub-resource rather than editing the session,
   * and a `PATCH` on `/sessions/:id` would have to.
   *
   * `write` and not `admin`: a rename destroys nothing. `machine:admin` guards
   * `DELETE /sessions/:id/workspace`, which deletes files.
   *
   * The tenant boundary is the first two lines, as everywhere else: `owned`
   * resolves through `registry.getFor`, so an id that is not yours and an id that
   * does not exist are the same 404.
   */
  app.post("/sessions/:id/meta", write, withSession(async (c, managed) => {

    const body = await requireJson(c);
    if (body instanceof Response) return body;

    const change: { title?: string | null; pinned?: boolean } = {};

    if ("title" in body) {
      const title = body["title"];
      if (title !== null && typeof title !== "string") {
        return jsonError(c, 400, "bad_request", "title must be a string or null");
      }
      // Measured against the *raw* string, before normalization collapses
      // whitespace and clips. A caller who sends 400 characters is told they sent
      // too many rather than being answered 200 with a silently different title.
      if (typeof title === "string" && title.length > MAX_TITLE_CHARS) {
        return jsonError(c, 400, "bad_request", `title must be at most ${MAX_TITLE_CHARS} characters`);
      }
      change.title = title;
    }

    if ("pinned" in body) {
      const pinned = body["pinned"];
      if (typeof pinned !== "boolean") return jsonError(c, 400, "bad_request", "pinned must be a boolean");
      change.pinned = pinned;
    }

    if (change.title === undefined && change.pinned === undefined) {
      return jsonError(c, 400, "bad_request", 'body must carry at least one of {"title"} or {"pinned"}');
    }

    // The whole snapshot, never an echo — same reason `/config` above answers this
    // way. A title is normalized on the way in, so what was asked for and what is
    // now true are not the same string.
    return c.json({ session: managed.setMeta(change) });
  }));

  app.post("/sessions/:id/permissions/:permissionId", write, withSession(async (c, managed) => {

    const body = await requireJson(c);
    if (body instanceof Response) return body;
    const answer = parseAnswer(body);
    if (!answer) {
      return jsonError(
        c,
        400,
        "bad_request",
        'body must carry exactly one of {"optionId"}, {"decision"} or {"cancel":true}',
      );
    }

    const result = managed.answerPermission(c.req.param("permissionId"), answer);
    switch (result.kind) {
      case "ok":
        return c.json({
          recorded: true,
          permissionId: result.permissionId,
          outcome: result.outcome,
          optionId: result.optionId,
          by: "client",
          repeat: false,
          // "recorded", not "the agent continued": once the agent's connection is
          // gone the SDK swallows the send, so delivery cannot be proven here.
          // Only a subsequent event in the log proves effect.
          delivered: result.delivered,
          seq: result.seq,
          session: managed.snapshot(),
        });
      case "already_answered":
        return c.json(
          {
            recorded: true,
            permissionId: result.permissionId,
            outcome: result.outcome,
            optionId: result.optionId,
            by: result.by,
            repeat: true,
            at: result.at,
            session: managed.snapshot(),
          },
          409,
        );
      case "expired":
        return jsonError(c, 409, "permission_expired", "that permission was settled and forgotten");
      case "invalid_option":
        return jsonError(c, 400, "invalid_option", "the agent did not offer that option", {
          options: result.options,
        });
      case "no_matching_option":
        return jsonError(c, 400, "no_matching_option", "the agent offered no option matching that decision", {
          options: result.options,
        });
      case "not_found":
        return jsonError(c, 404, "permission_not_found", "no such permission on this session");
    }
  }));

  /*
   * The form behind a pending question.
   *
   * Off the snapshot deliberately, and this is the same shape `GET
   * /sessions/:id/commands` has: `SessionSnapshot` says only *that* a question is
   * waiting, because `GET /sessions` returns sixty of those every four seconds
   * and a form is agent-shaped. The rule a pending permission passes and this one
   * does not is "a blocked session has to be answerable from the list" — you
   * cannot fill a form in from a list, so the fields are fetched when a card
   * opens.
   *
   * 404 once it is settled, which is honest rather than awkward: the form is held
   * on the pending record and there is nothing to fill in any more.
   */
  app.get("/sessions/:id/elicitations/:elicitationId", read, withSession((c, managed) => {
    const form = managed.elicitationForm(c.req.param("elicitationId"));
    if (!form) {
      return jsonError(c, 404, "elicitation_not_found", "no such question waiting on this session");
    }
    return c.json({ elicitationId: c.req.param("elicitationId"), fields: form.fields });
  }));

  app.post("/sessions/:id/elicitations/:elicitationId", write, withSession(async (c, managed) => {

    const body = await requireJson(c);
    if (body instanceof Response) return body;
    const answer = parseElicitationAnswer(body);
    if (!answer) {
      return jsonError(
        c,
        400,
        "bad_request",
        'body must carry exactly one of {"content"}, {"decline":true} or {"cancel":true}',
      );
    }

    const result = managed.answerElicitation(c.req.param("elicitationId"), answer);
    switch (result.kind) {
      case "ok":
        return c.json({
          recorded: true,
          elicitationId: result.elicitationId,
          action: result.action,
          by: "client",
          repeat: false,
          // The same honesty the permission route carries: "recorded", not "the
          // agent continued". Only a later event in the log proves effect.
          delivered: result.delivered,
          seq: result.seq,
          session: managed.snapshot(),
        });
      case "already_answered":
        // A 409 carrying a *success*-shaped body, with no `error` key — the
        // answer really did land, and a retry from a phone on a flaky connection
        // is the commonest way to get here. `action` is the one that **won**, not
        // the one just sent.
        return c.json(
          {
            recorded: true,
            elicitationId: result.elicitationId,
            action: result.action,
            by: result.by,
            repeat: true,
            at: result.at,
            session: managed.snapshot(),
          },
          409,
        );
      case "expired":
        return jsonError(c, 409, "elicitation_expired", "that question was settled and forgotten");
      case "invalid_content":
        // `fields` rides along for the reason `invalid_option` returns `options`:
        // a client that is out of date can redraw rather than guess.
        return jsonError(c, 400, "invalid_content", "that is not an answer to this form", {
          problems: result.problems,
          fields: result.fields,
        });
      case "not_found":
        return jsonError(c, 404, "elicitation_not_found", "no such question on this session");
    }
  }));

  app.get("/sessions/:id/events", read, withSession((c, managed) => {

    const since = boundedInt(c.req.query("since"), 0);
    const limit = boundedInt(c.req.query("limit"), EVENTS_PAGE_LIMIT, EVENTS_PAGE_LIMIT);
    const stats = managed.log.stats();
    return c.json({
      events: managed.log.read(since, limit, EVENTS_PAGE_BYTES),
      // The derived floor, not the raw `firstSeq`: they differ exactly when the
      // log is empty but the sequence is not, which is the one case a paging
      // client must not be told history begins at 1.
      firstSeq: oldestAvailable(stats),
      lastSeq: stats.lastSeq,
      dropped: stats.dropped,
      gap: since < oldestAvailable(stats) - 1,
    });
  }));

  /**
   * What this session's agent will answer to a leading slash.
   *
   * Its own route rather than a field on the snapshot, because `GET /sessions`
   * returns that record for up to sixty sessions every four seconds and a command
   * list is only ever wanted inside one composer — the full argument is on
   * {@link SessionSnapshot.commandsRevision}, which is what tells a client to come
   * here at all.
   *
   * No `session_not_ready` and no `terminal` refusal: nothing is asked of the
   * agent, this reads a field, and an empty list is the honest answer for a
   * session that has none. A 409 would make the composer draw an error where the
   * truth is "no commands".
   *
   * The revision is echoed in the response so a client can tell the list moved
   * while its fetch was in flight, rather than caching what it got under a
   * revision that has already been superseded.
   */
  app.get("/sessions/:id/commands", read, withSession((c, managed) => {
    const { commands, dropped } = managed.agentCommands;
    return c.json({ revision: managed.commandsRevision, commands, dropped });
  }));

  /* ---------------------------------------------------------------- *
   * What the agent changed. Shells out to git, which is fine here:
   * these are request handlers, entirely off the agent's event path.
   * ---------------------------------------------------------------- */

  app.get("/sessions/:id/changes", read, withSession(async (c, managed) => {
    const gate = await workspaceReady(c, managed);
    if (gate) return gate;

    try {
      const changes = await listChanges(managed.workspace, {
        runner: git,
        base: c.req.query("base") === "head" ? "head" : "session",
        includeIgnored: c.req.query("ignored") === "1",
        limit: boundedInt(c.req.query("limit"), maxChangedFiles, maxChangedFiles),
      });
      return c.json({ ...changes, now: Date.now() });
    } catch (error) {
      return gitError(c, error);
    }
  }));

  app.get("/sessions/:id/changes/diff", read, withSession(async (c, managed) => {
    const gate = await workspaceReady(c, managed);
    if (gate) return gate;

    const safe = await requestedPath(c, managed);
    if (safe instanceof Response) return safe;

    const base = c.req.query("base") === "head" ? "head" : "session";
    try {
      // Recomputed here rather than trusted from a previous listing. This is the
      // strongest containment rule in the API — the set of servable paths is
      // exactly the set git itself just reported — and it also closes the race
      // between listing a file and asking for its diff.
      const changes = await listChanges(managed.workspace, {
        runner: git,
        base,
        includeIgnored: true,
        limit: maxChangedFiles,
      });
      if (!changes.supported) {
        return jsonError(c, 409, "not_a_git_repository", "this session is not running in a git repository");
      }
      const change = changes.files.find((file) => file.path === safe.rel);
      if (!change) {
        return jsonError(c, 404, "path_not_changed", "this session did not change that file");
      }
      if (!change.addressable) {
        return jsonError(c, 400, "path_not_addressable", "that path is not valid UTF-8 and cannot be requested");
      }

      const diff = await diffFile(managed.workspace, change, {
        runner: git,
        base,
        contextLines: boundedInt(c.req.query("context"), 3, 32),
        maxBytes: maxDiffBytes,
      });
      return c.json(diff);
    } catch (error) {
      return gitError(c, error);
    }
  }));

  /*
   * The bytes of one file in the session's tree.
   *
   * The gap this fills is narrow and real: `changes/diff` deliberately refuses
   * binary — `git diff --no-index` would have to be trusted with a symlink, and a
   * patch of a PNG is not a thing — so a chart, a build artifact or a screenshot
   * the agent produced was visible in the transcript as a path and unreachable as
   * bytes. It is deliberately **not** restricted to the change set the way
   * `changes/diff` is: somebody asking an agent for a file often means one that
   * was already there, and this widens no real authority, because the agent can
   * `cat` anything under this root already and does so on request.
   */
  app.get("/sessions/:id/files", read, withSession(async (c, managed) => {
    // Not optional, and not a formality. For a `plain` session `workspace.root`
    // *is* the `cwd` the caller named, so skipping this is the event-loop death
    // that `stall.ts` exists for, reached by a third route.
    const gate = await workspaceReady(c, managed);
    if (gate) return gate;

    const safe = await requestedPath(c, managed);
    if (safe instanceof Response) return safe;

    return serveFile(c, safe.full, safe.rel.slice(safe.rel.lastIndexOf("/") + 1));
  }));

  /*
   * The bytes of a file somebody staged for a prompt.
   *
   * A second route rather than a case of the one above, because uploads live
   * outside `workspace.root` on purpose — a worktree can be removed and a `plain`
   * session's root is the caller's own repository. Without this the attachment
   * chip on a message a person sent themselves would be the one thing in the
   * transcript that cannot be opened.
   *
   * No `safeRelPath`: the path is built entirely from a row we wrote, so there is
   * no caller-supplied component to contain. What it shares is `serveFile`, so
   * the two cannot drift on the headers, which are the part that has to be
   * identical.
   */
  app.get("/sessions/:id/uploads/:uploadId", read, withSession(async (c, managed) => {
    if (!uploads) return jsonError(c, 503, "uploads_unavailable", "this daemon has no upload store");

    const row = uploads.find(managed.id, c.req.param("uploadId") ?? "");
    if (row === null) {
      return jsonError(c, 404, "upload_not_found", "no such upload on this session");
    }
    return serveFile(c, uploads.pathFor(row), row.name);
  }));

  app.get("/sessions/:id/workspace", read, withSession(async (c, managed) => {
    try {
      // Deliberately answers even when the directory is gone: this is what a UI
      // reads *before* offering a Remove button, so it has to be able to say
      // "there is nothing there" rather than fail.
      return c.json({ workspace: managed.workspace, status: await inspectWorkspace(managed.workspace, git) });
    } catch (error) {
      return gitError(c, error);
    }
  }));

  app.delete("/sessions/:id/workspace", admin, withSession(async (c, managed) => {
    // Checked first: removing a worktree out from under a running agent breaks it
    // in a way that is hard to diagnose from the inside.
    if (!managed.terminal) {
      return jsonError(c, 409, "session_live", "stop this session before removing its worktree", {
        status: managed.status,
      });
    }

    try {
      const result = await removeWorkspace({
        runner: git,
        workspace: managed.workspace,
        // The same root `POST /sessions` created it under, so the containment
        // check that guards the `rmSync` can agree with the creation. When the
        // two disagreed it refused every time, silently, while the route still
        // reported success — masked because `git worktree remove` usually deletes
        // the directory itself, so the guard only bit on the paths that had
        // already failed, which is exactly where it was meant to help.
        worktreeRoot: registry.workspacePolicy.worktreeRoot,
        force: c.req.query("force") === "1",
        deleteBranch: c.req.query("deleteBranch") === "1",
      });

      switch (result.kind) {
        case "not_applicable":
          // A DELETE that silently succeeds without doing anything is worse than
          // a refusal that says why.
          return jsonError(c, 409, "not_a_worktree", "this session runs in a plain directory we did not create");
        case "refused": {
          // Both halves come from the refusals themselves; see
          // {@link removalRefusalAnswer} for why one fixed sentence here was a
          // lie about the one refusal that exists to say "I could not tell".
          const answer = removalRefusalAnswer(result.refusals);
          return jsonError(c, 409, answer.code, answer.message, {
            refusals: result.refusals,
            status: result.status,
          });
        }
        case "removed": {
          /*
           * The files nobody sent go with the checkout — and **only** those.
           *
           * This used to call `forgetSession`, which drops every row including
           * consumed ones. But removing a worktree is not deleting a session:
           * the row survives, the transcript survives, and every `prompt` event
           * in it still names its attachments. So the effect was that an
           * ordinary cleanup made the transcript describe files that could no
           * longer be fetched — the one outcome `uploads.ts`'s opening docblock
           * says the disjoint roots exist to prevent ("an upload is staged input
           * that has to outlive that"), and the opposite of the lifetime
           * `schema.sql` states for a consumed row.
           *
           * A failure here is a warning rather than a failed DELETE: the
           * worktree really is gone, so reporting the request as failed would
           * invite somebody to run it again against a session that has none.
           */
          const warnings = [...result.warnings];
          if (uploads) {
            try {
              await uploads.forgetUnconsumed(managed.id);
            } catch (error) {
              warnings.push(
                `staged uploads were not removed: ${describeError(error)}`,
              );
            }
          }
          return c.json({
            removed: true,
            branchDeleted: result.branchDeleted,
            pruned: result.pruned,
            warnings,
          });
        }
      }
    } catch (error) {
      return gitError(c, error);
    }
  }));

  /**
   * Every worktree under the managed root, owned or not.
   *
   * Without this, a worktree left behind by a daemon that crashed is invisible —
   * there is no session to ask about it. With it, cleaning up is a human reading
   * a list. Read-only on purpose: no bulk delete.
   */
  app.get("/worktrees", read, async (c) => {
    const known = registry.list();
    const worktreeRoot = registry.workspacePolicy.worktreeRoot;
    /*
     * Resolved once, through the bounded probe, and outside the loop.
     *
     * `containedIn` resolved *both* sides with `realpathSync` on every iteration,
     * and one of those sides is `entry.path` — a path git reported, which by
     * construction is not one this daemon made: filtering those out is the whole
     * purpose of the call. `git worktree add ~/nas/review` on a mount whose
     * server then pauses made this route an uninterruptible event-loop stop, with
     * nothing recorded anywhere to stop the next request repeating it.
     *
     * The root itself is ours, so it may legitimately not exist yet; `missing`
     * falls back to the literal, which is what `resolved()` did.
     *
     * **`null` is the third answer and gets its own arm rather than that
     * fallback**, which is the distinction the probe exists to make and which
     * collapsing the two back together threw away here. Comparing resolved entry
     * paths against an *unresolved* root matches nothing, and every
     * `probeRealpath(entry.path)` below would then be answering `null` too and be
     * dropped — so a managed root on a paused mount answered `200 {worktrees:
     * []}`, i.e. "there are none", for a filesystem that could not be asked. That
     * is the same lie `probeExists`'s three answers stop `removeWorkspace`
     * telling, and the same 503 `workspaceReady` and `pathErrorStatus` already
     * answer for a directory that did not reply.
     */
    const rootReal = await probeRealpath(worktreeRoot);
    if (rootReal === null) {
      return jsonError(c, 503, "worktree_root_unresponsive", "the filesystem holding the worktree root did not answer", {
        timeoutMs: DESCRIBE_TIMEOUT_MS,
      });
    }
    const realRoot = rootReal.kind === "path" ? rootReal.value : worktreeRoot;

    const owners = new Map<string, { sessionId: string; status: string }>();
    for (const session of known) {
      if (session.workspace.mode === "worktree") {
        owners.set(session.workspace.root, { sessionId: session.id, status: session.status });
      }
    }

    // Only repos this tenant has actually opened. Deriving the set from every
    const repos = new Set<string>();
    for (const session of known) {
      const repoRoot = session.workspace.git?.repoRoot;
      if (repoRoot) repos.add(repoRoot);
    }

    const entries: unknown[] = [];
    for (const repoRoot of repos) {
      let listed: Awaited<ReturnType<typeof listWorktrees>>;
      try {
        listed = await listWorktrees(repoRoot, git);
      } catch {
        // One unreadable repo must not cost the whole listing.
        continue;
      }
      for (const entry of listed) {
        if (entry.path === repoRoot) continue;
        // Resolved before comparing. A textual prefix test against an unresolved
        // root silently returned an empty list on any host whose root traverses a
        // symlink, and it is the same drift `browse.ts` carried. The comparison
        // stays `containedInResolved`, so the property the old comment was about
        // survives: a sibling whose name merely starts with the root —
        // `…/worktrees-old` against `…/worktrees` — is not inside it, because the
        // comparison is segment-wise.
        //
        // A path that did not answer is dropped rather than waited on: this is a
        // listing, and one worktree on a sleeping NAS must not cost the daemon
        // its event loop. `missing` is compared as written, which is what a
        // prunable worktree whose directory is already gone looks like — and
        // those are exactly the rows this route exists to show.
        const seen = await probeRealpath(entry.path);
        if (seen === null) continue;
        if (!containedInResolved(seen.kind === "path" ? seen.value : entry.path, realRoot)) continue;
        entries.push({ ...entry, repoRoot, owner: owners.get(entry.path) ?? null });
      }
    }
    return c.json({ root: worktreeRoot, worktrees: entries });
  });

  /* ---------------------------------------------------------------- *
   * Plugins
   *
   * Seven routes, and the scope on each is written here rather than derived
   * from the manifest — a table mapping method and path to a scope is one
   * edit away from describing routes that have moved, which is the argument
   * `requireScope` already makes above.
   *
   * ⚠ **Two axes of authorization meet here and neither implies the other.**
   * These scopes decide what the *caller* may do. `manifest.scopes` decides
   * what the *plugin* may do, and it is the only one that applies inside a
   * hook, where nobody called anything. A read-only grant can look at a
   * plugin's screen and cannot press anything on it; a plugin without
   * `sessions.write` cannot send a prompt however the caller got here.
   * ---------------------------------------------------------------- */

  /**
   * A handler that only runs where there *is* a plugin host.
   *
   * `withSession`'s shape, for `withSession`'s reason, and it is now what its
   * docblock claimed: this used to be a call-site helper one of six routes went
   * through, while the other five hand-wrote the identical 503 — a "shared"
   * refusal that five copies were free to drift away from, which is the failure
   * `sessionOf` was collapsed into `withSession` to stop.
   *
   * A wrapper rather than a middleware because `plugins` is a closure variable
   * rather than a request property: a middleware would have to put the host on
   * `c.var` and every handler would read it back out untyped, which is a longer
   * way to say `(c, host)`.
   *
   * **`POST /plugins` goes through it too, with no streaming variant**, and that
   * is the exemption middleware paying for itself: the body of a request refused
   * here is released on the way back up, by the same guard that covers the auth
   * gate and `requireScope`. A cancel-first copy of this helper would be a fourth
   * place that has to be remembered, for a refusal that is already covered.
   */
  const withPlugins =
    <P extends string>(
      handler: (c: Context<AppEnv, P>, host: PluginHost) => Response | Promise<Response>,
    ): Handler<AppEnv, P> =>
    (c) => {
      if (!plugins) return jsonError(c, 503, "plugins_unavailable", "this daemon has no plugin host");
      return handler(c, plugins);
    };

  /**
   * The other refusal three of these routes share.
   *
   * It was written out four times, with the sentence retyped each time. It is one
   * answer — "no such plugin on this machine" — and a client reads the code, so
   * independently-typed copies of the message are that many chances for one of
   * them to say something slightly different about the same state. The fourth
   * copy is gone rather than collapsed: `DELETE /plugins/:pluginId` stopped
   * refusing an unknown id at all, for the replay reason stated there.
   */
  const pluginNotFound = (c: Context<AppEnv>): Response =>
    jsonError(c, 404, "plugin_not_found", "no such plugin on this machine");

  /**
   * A handler that only runs for a plugin that is loaded, by the id in the path.
   *
   * The view and action routes had this preamble written out verbatim — find,
   * 404, then their own work — which is `withSession`'s argument a second time.
   *
   * **Deliberately not applied to `DELETE /plugins/:pluginId` or to the state
   * route.** `find` answers from `live`, and `remove` deliberately reaches
   * further: it also removes a plugin whose tree is installed but unreadable,
   * which is never in `live` and which this wrapper would answer 404 for. The
   * state route is left alone for an ordering reason instead — it validates its
   * body before it looks the plugin up, so wrapping it would turn a request that
   * is wrong in both ways from a `400` into a `404`.
   */
  const withPlugin =
    <P extends string>(
      handler: (c: Context<AppEnv, P>, plugin: LivePlugin) => Response | Promise<Response>,
    ): Handler<AppEnv, P> =>
    withPlugins((c, host) => {
      const plugin = host.find(c.req.param("pluginId") ?? "");
      if (plugin === null) return pluginNotFound(c);
      return handler(c, plugin);
    });

  app.get(
    "/plugins",
    read,
    withPlugins((c, host) => c.json({ plugins: host.list(), api: PLUGIN_API_VERSION })),
  );

  /**
   * Install a plugin, or update one — one verb, because they are one act.
   *
   * A separate `PUT` would need the caller to know whether the plugin is already
   * there, which is a question the archive answers on arrival: the id is in the
   * manifest, and whether a row exists is this daemon's business rather than the
   * caller's. `replaced` on the answer is what says which of the two happened.
   *
   * Streaming, so `isStreamingRoute` exempts it from the 1 MiB body bound and
   * `PluginHost.install` carries its own counter. Every refusal below cancels the
   * body first, for the reason the upload and import routes state at length: the
   * relay grants a stream's window on consumption, so a reader that stops parks
   * the sender, and the valve after that closes the whole tunnel for this machine.
   * `refuse()` is kept where the refusals are large and local; what it never
   * covered — an answer from a middleware above this handler — is the exemption
   * middleware's `finally`, which is also what lets `withPlugins` wrap a
   * streaming route with no variant of its own.
   */
  app.post(
    "/plugins",
    admin,
    withPlugins(async (c, host) => {
      const refuse = async <T,>(answer: () => T): Promise<T> => {
        await cancelBody(c.req.raw.body as ReadableStream<Uint8Array> | null);
        return answer();
      };

      if (registry.isShuttingDown) {
        return refuse(() => jsonError(c, 503, "shutting_down", "the daemon is shutting down"));
      }

      // The same sanitizer the upload and import routes use, and for the same
      // reason: this string is a *label* — it is recorded beside the row and never
      // becomes a path — but it is echoed back, and a control character in an echoed
      // string is the response-splitting the sanitizer exists to refuse.
      const named = sanitizeUploadName(c.req.query("name") ?? "");
      if (!named.ok) {
        return refuse(() =>
          jsonError(c, 400, "invalid_name", "that filename cannot be stored", { reason: named.reason }),
        );
      }

      /*
       * Honoured to refuse, never to accept. Refusing on a `content-length` we
       * believe costs nothing; trusting one would let a body that lies walk past the
       * counter that is actually enforcing this.
       */
      const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > PLUGIN_LIMITS.maxBytes) {
        return refuse(() =>
          jsonError(c, 413, "plugin_too_large", `a plugin archive may not exceed ${PLUGIN_LIMITS.maxBytes} bytes`, {
            limit: PLUGIN_LIMITS.maxBytes,
            declared,
          }),
        );
      }

      const body = c.req.raw.body;
      if (body === null) return jsonError(c, 400, "bad_request", "expected a request body");

      const outcome = await host.install({ body, name: named.name });
      if (outcome.kind === "ok") {
        return c.json({ plugin: outcome.summary, replaced: outcome.replaced }, outcome.replaced === null ? 201 : 200);
      }
      if (outcome.kind === "busy") {
        return jsonError(c, 409, "plugin_busy", "this machine is already installing a plugin");
      }
      return jsonError(c, pluginInstallStatus(outcome.code), outcome.code, outcome.message);
    }),
  );

  /**
   * Install a plugin this daemon fetches for itself, from a commit somebody named.
   *
   * **The same act as `POST /plugins`, arriving by a different door**, which is
   * why it answers in the same shapes down to `replaced` and the 201/200 split:
   * a client that can read one answer can read the other, and `PluginHost.install`
   * is literally the same function underneath.
   *
   * ⚠ **Not a streaming route, and it must not become one.** The body is a small
   * JSON object, so it belongs under the ordinary bound like every other route
   * here — `isStreamingRoute` exempts `POST /plugins` because the archive arrives
   * *in* the request, and here the archive arrives on a socket this daemon opened.
   * The obligation that exemption creates — cancel the body on every refusal —
   * therefore does not apply, and adding this path to it would take on a duty
   * nothing here owes.
   *
   * ⚠ **The address is built by `source.ts` from `repo` and `commit` alone.**
   * Nothing here accepts a URL, and that is the fence: a caller who could name the
   * host would have a daemon that fetches arbitrary addresses as its owner.
   */
  app.post(
    "/plugins/source",
    admin,
    withPlugins(async (c, host) => {
      if (registry.isShuttingDown) return jsonError(c, 503, "shutting_down", "the daemon is shutting down");

      const body = await requireJson(c);
      if (body instanceof Response) return body;

      const source = readSource(body["source"] ?? body);
      if (isSourceRefusal(source)) return jsonError(c, 400, source.code, source.message);

      /*
       * `null` when the caller sent none, and that is a real state rather than a
       * client bug: `pnpm client` has no consent screen to have shown anybody, and
       * `PluginHost.install` skips the check for exactly that caller. What the web
       * client sends is what it drew, and the daemon refuses anything beyond it.
       */
      const consent = readConsent(body["consent"]);

      const outcome = await host.installFromSource(source, consent);
      if (outcome.kind === "ok") {
        return c.json({ plugin: outcome.summary, replaced: outcome.replaced }, outcome.replaced === null ? 201 : 200);
      }
      if (outcome.kind === "busy") {
        return jsonError(c, 409, "plugin_busy", "this machine is already installing a plugin");
      }
      return jsonError(c, pluginInstallStatus(outcome.code), outcome.code, outcome.message);
    }),
  );

  /*
   * `remove` rather than a `withPlugin` lookup, and the difference is load-bearing:
   * it also removes a plugin whose tree is on disk and unreadable, which never
   * reached `live` and which a `find` would answer 404 for while leaving the
   * directory and the row behind. "Nothing of that id anywhere" is a wider claim
   * than the wrapper's, and the only one that makes an uninstall able to finish.
   *
   * ⚠ **An id with nothing under it is `200 {removed: false}` and never a 404,
   * because this is a `DELETE` and the transport replays those.** `isReplayable`
   * in `packages/web/src/machine.ts` whitelists `GET` and `DELETE` on a stated
   * property this route is inside: "the daemon's are idempotent — stopping an
   * already-stopped session or removing an already-removed workspace answers the
   * same way twice". The failure a 404 makes is a removal that *worked* and whose
   * answer was lost on the wire — the replay lands after the row, the data and the
   * tree are already gone, and `pluginFailure` renders `plugin_not_found` as "That
   * plugin is not installed on this machine any more.", which is true, is exactly
   * what the caller asked for, and reads as the act having failed. `MachineInstalls`
   * says the same thing from the other end: a remove "inherits its retry from
   * `machine.ts` one layer down". `removed` is what tells the two sends apart, and
   * the client already typed this answer `{removed: boolean}` for it.
   *
   * The cost is that a mistyped id is no longer refused, and `pnpm client plugin
   * remove` prints "removed" over one. That is the trade a replayable verb makes:
   * a wrong id costs a person one confusing line, and a 404 costs whoever hit a
   * dropped LTE packet an uninstall that looks like it failed on every machine in
   * a fan-out.
   */
  app.delete(
    "/plugins/:pluginId",
    admin,
    withPlugins(async (c, host) => {
      const removed = await host.remove(c.req.param("pluginId") ?? "");
      // The same 409 `POST /plugins` answers, for the same fact: one mutation at a
      // time for the whole daemon. It is the one refusal left here, and it is a
      // refusal rather than a `false` because nothing was removed *and* the answer
      // would be different a moment later — which is not what `removed: false` says.
      if (removed === "busy") return jsonError(c, 409, "plugin_busy", "this machine is already installing a plugin");
      return c.json({ removed });
    }),
  );

  /**
   * Switched on or off, without losing anything.
   *
   * A route rather than two (`/enable`, `/disable`) because the body is the state
   * a caller wants rather than the transition it thinks it is making — which is
   * what makes it idempotent, and therefore what makes a client that lost the
   * answer safe to send it again.
   *
   * Not `withPlugin`, and the reason is ordering rather than reach: the body is
   * validated before the id is looked up, so a request that names an unknown
   * plugin *and* sends a body without `enabled` is a `400`. Hoisting the lookup
   * into a wrapper would quietly turn that into a `404`.
   */
  app.post(
    "/plugins/:pluginId/state",
    admin,
    withPlugins(async (c, host) => {
      const body = await requireJson(c);
      if (body instanceof Response) return body;
      const enabled = body["enabled"];
      if (typeof enabled !== "boolean") return jsonError(c, 400, "bad_request", "enabled must be true or false");
      const summary = await host.setEnabled(c.req.param("pluginId") ?? "", enabled);
      if (summary === "busy") return jsonError(c, 409, "plugin_busy", "this machine is already installing a plugin");
      if (summary === null) return pluginNotFound(c);
      return c.json({ plugin: summary });
    }),
  );

  /**
   * What one of a plugin's screens looks like right now.
   *
   * `GET`, and therefore replayable — `isReplayable` lets the transport repeat it
   * after a failure that said nothing about whether the daemon acted. So a view is
   * a **read** by contract, and a plugin that writes in one has a bug a retry will
   * find. Nothing here can enforce that; what it can do is tell the child which
   * kind of call this is, which `runner.ts` passes on.
   */
  app.get(
    "/plugins/:pluginId/views/:viewId",
    read,
    withPlugin((c, plugin) => {
      const viewId = c.req.param("viewId") ?? "";
      if (viewId !== "screen" && viewId !== "settings") {
        return jsonError(c, 404, "view_not_found", "a plugin draws a screen and a settings pane, and no other view");
      }
      /*
       * ⚠ **And it has to be one *this* plugin declared.** The pair above is the
       * vocabulary; `contributes` is which of the two this plugin said it draws,
       * and they are different questions. The action route just below makes this
       * exact argument against the same field, and it applies here unchanged: a
       * view id is a string somebody put in a URL.
       *
       * Without it, `settings` on a plugin declaring `settings: false` reaches the
       * child, `runner.ts` finds no such export and throws "this plugin exports no
       * settings", `PluginApiError` makes that `plugin_failed`, and
       * {@link pluginErrorStatus} defaults it to a `502` — whose own stated reason
       * is "something downstream of this daemon answered badly". Nothing answered
       * badly: the manifest already says that view is not there, so this is a 404
       * about the request rather than a 502 about the plugin. The web client
       * narrows both surfaces already (`screenPlugins`, `settingsBlockFor`'s
       * `no_pane`), so what arrives here is `pnpm client plugin view` or a
       * hand-typed `/p/:machineId/:pluginId` — exactly the traffic that must not be
       * told a working plugin is broken. `view_not_found` carries a second sentence
       * rather than a second code, because the code is the client's contract and
       * these are two ways of naming a view that is not there.
       */
      const contributes = plugin.record.manifest.contributes;
      const declares = viewId === "settings" ? contributes.settings : contributes.screen !== null;
      if (!declares) return jsonError(c, 404, "view_not_found", "this plugin declares no such view");
      return pluginAnswer(c, () => plugin.invoke("view", viewId, { view: viewId }));
    }),
  );

  app.post(
    "/plugins/:pluginId/actions/:actionId",
    write,
    withPlugin(async (c, plugin) => {
      const actionId = c.req.param("actionId") ?? "";
      const body = await requireJson(c);
      if (body instanceof Response) return body;
      /*
       * The action must be one the manifest declared, and that check is here rather
       * than inside the plugin: an action id reaching a plugin's `action` export is
       * a string somebody put in a URL, and a plugin author writing a `switch` over
       * their own ids should not also have to defend against ones they never
       * declared. `contributes.actions` is the list a person approved at install.
       */
      if (!plugin.record.manifest.contributes.actions.some((one) => one.id === actionId)) {
        return jsonError(c, 404, "action_not_found", "this plugin declares no such action");
      }
      /*
       * Three optional pieces of context, and the plugin gets whichever the surface
       * had: `session` when the press came from a session's menu, `row` when it came
       * from a row on the plugin's own screen, `form` when it was a form's submit.
       * All three are passed through as sent — they are the plugin's own vocabulary,
       * and this daemon validating them would be validating a shape it does not own.
       */
      return pluginAnswer(c, () =>
        plugin.invoke("action", actionId, {
          action: actionId,
          session: typeof body["session"] === "string" ? body["session"] : null,
          row: typeof body["row"] === "string" ? body["row"] : null,
          form: body["form"] ?? null,
        }),
      );
    }),
  );

  /* ---------------------------------------------------------------- *
   * The stream. Read-only: everything that mutates is an HTTP request,
   * because a send into a half-open socket succeeds silently.
   * ---------------------------------------------------------------- */

  app.get(
    "/sessions/:id/stream",
    read,
    async (c, next) => {
      if (!sessionOf(c)) return notFound(c);
      return next();
    },
    upgradeWebSocket((c) => {
      // Checked again rather than carried over from the guard: the upgrade
      // closure resolves the session itself, and a second unchecked lookup here
      // would be a way past the guard the day this route grows another branch.
      const managed = sessionOf(c);
      const sinceParam = c.req.query("since");
      const since = sinceParam === undefined ? null : boundedInt(sinceParam, 0);
      // Read here, in the handshake, where the principal still exists. The
      // socket outlives this request context.
      const expiresAt = c.get("principal").expiresAt;
      let connection: StreamConnection | null = null;

      return {
        onOpen(_event, ws) {
          // The guard above already 404'd an unknown id; this covers the session
          // being stopped and dropped between that check and the upgrade.
          if (!managed) {
            ws.close(4404, "session not found");
            return;
          }
          connection = new StreamConnection(managed, ws as WSContext<RawWebSocket>, instanceId, expiresAt);
          connection.attach(since);
        },
        onClose() {
          connection?.dispose();
          connection = null;
        },
        onError() {
          connection?.dispose();
          connection = null;
        },
      };
    }),
  );

  return { app, injectWebSocket: guardedInjectWebSocket(injectWebSocket) };
}

/**
 * `injectWebSocket`, with the request targets the URL parser rejects answered
 * rather than thrown.
 *
 * ⚠ **`@hono/node-ws`'s upgrade handler opens with an unguarded `new
 * URL(request.url ?? "/", "http://localhost")`**, and llhttp and the WHATWG
 * parser do not agree about what a request target is: `GET //% HTTP/1.1` reaches
 * a `node:http` handler with `req.url === "//%"`, and `new URL("//%", …)` throws.
 * So do `/\` and `//[`. The throw leaves the socket with nothing written to it
 * and nothing destroying it — `requestTimeout` is already cleared and
 * `keepAliveTimeout` only arms once a response is sent — so it is one leaked fd
 * per line, against the listener the relay forwards the internet to.
 *
 * **This is the guard `relay/proxy.ts` already carries** at `readToken` and
 * `pathOf`, with a comment describing this exact failure, and it did not protect
 * this end: that function reads the `Authorization` header *without touching the
 * URL*, so a request carrying a valid bearer never reaches the relay's own `new
 * URL` and `path: req.url` is forwarded verbatim. Any token for this machine —
 * `session:read` is enough — plus one malformed target.
 *
 * **Here rather than in `scripts/daemon.ts`**, for two reasons that point the
 * same way: a caller cannot forget it, and `daemoncheck` drives a real listener
 * through this same function, so the rule is assertable rather than a copy of one
 * living in an entry point no driver runs.
 *
 * **Wrapped rather than prepended.** Every `upgrade` listener runs, so a guard
 * registered first would answer the socket and then watch the unguarded handler
 * throw on the same request anyway. Taking the listener off and putting it back
 * behind the check is the only arrangement where the bad target never reaches it.
 */
function guardedInjectWebSocket(inject: (server: Server) => void): (server: Server) => void {
  return (server) => {
    inject(server);
    const injected = server.listeners("upgrade") as ((
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => void)[];
    server.removeAllListeners("upgrade");
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      try {
        new URL(request.url ?? "/", "http://localhost");
      } catch {
        /*
         * Before the write, for `relay/proxy.ts`'s reason: Node removes its own
         * socket error handler *before* emitting `upgrade`, so this socket
         * starts with zero listeners and an `'error'` with none is an uncaught
         * exception. The refusal path writes to it, so it needs one too.
         */
        socket.on("error", () => socket.destroy());
        try {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        } catch {
          // Peer already gone; the destroy below is all that is left to do.
        }
        socket.destroy();
        return;
      }
      for (const listener of injected) listener(request, socket, head);
    });
  };
}

type QueueItem =
  | { kind: "event"; stored: StoredEvent; bytes: number }
  | { kind: "control"; frame: unknown; bytes: number };

/**
 * One attached client.
 *
 * The contract with the agent is that nothing here can ever slow it down: the
 * listener is a synchronous array push, so the emit path from the agent's RPC
 * handler is O(1) and never waits on a socket. A client that cannot keep up gets
 * degraded — told exactly what it lost — but never at anyone else's expense.
 */
class StreamConnection {
  private readonly queue: QueueItem[] = [];
  private queuedBytes = 0;
  private cursor = 0;
  private lastSentSeq = 0;
  private sending = false;
  private closed = false;
  private alive = true;
  private collapses: number[] = [];
  private unsubLog: (() => void) | null = null;
  private unsubWatch: (() => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly managed: ManagedSession,
    private readonly ws: WSContext<RawWebSocket>,
    private readonly instanceId: string,
    /**
     * When the credential that opened this stream stops being valid, or `null`
     * for one that never expires. Checked on the heartbeat, not at attach —
     * the point is to catch the moment it passes while the socket is open.
     */
    private readonly expiresAt: number | null = null,
  ) {}

  private get raw(): RawWebSocket | undefined {
    return this.ws.raw;
  }

  /**
   * Seeds the client and goes live, in one synchronous block.
   *
   * There is no `await` between reading the backlog and registering the listener,
   * so there is no window in which an appended event could land in neither. That
   * is the whole of "no gaps, no duplicates" — the `seq <= cursor` filter in
   * `emit` makes it idempotent even if the two ever did overlap.
   */
  attach(sinceParam: number | null): void {
    const stats = this.managed.log.stats();
    const asked = sinceParam === null ? stats.lastSeq : Math.min(sinceParam, stats.lastSeq);

    /*
     * The socket replays at most `ATTACH_REPLAY_MAX`, and skips rather than drops.
     *
     * A session's log is no longer bounded, so "attach at 0" can now mean fifty
     * thousand events — and `attach` drains its whole backlog into the outbound
     * queue in one synchronous block, which past `MAX_QUEUE_EVENTS` collapses and
     * reports `slow_consumer` about a client that never got to be slow.
     *
     * So the *attach* is bounded where the *history* used to be. The cursor moves
     * forward to the newest `ATTACH_REPLAY_MAX`, and the client is told what it
     * skipped and where to get it: `reason: "backlog"`, which is the one lagged
     * reason that is not a loss. Those events are on disk and
     * `GET /sessions/:id/events` serves them.
     */
    const floor = Math.max(asked, stats.lastSeq - ATTACH_REPLAY_MAX);
    const since = Math.max(asked, Math.min(floor, stats.lastSeq));
    this.cursor = since;
    this.lastSentSeq = since;

    const oldest = oldestAvailable(stats);
    const gap = asked < oldest - 1;
    // Always the first frame, and it carries pendingPermissions — which is how a
    // client attaching ten minutes after the fact learns the session is blocked
    // without replaying anything.
    this.control({
      type: "hello",
      instanceId: this.instanceId,
      session: this.managed.snapshot(),
      // The derived floor, so `hello` and the snapshot inside it agree.
      firstSeq: oldest,
      lastSeq: stats.lastSeq,
      since,
      gap,
    });
    /*
     * `evicted` first, because it is the one that is a loss.
     *
     * With no retention window this can only be a session whose prefix an *older*
     * daemon destroyed before the bound was removed — the floors are on the
     * session row and survive, so those sessions go on reporting it honestly for
     * ever rather than pretending they are whole.
     */
    if (gap) {
      this.control({
        type: "lagged",
        from: asked + 1,
        to: oldest - 1,
        dropped: oldest - 1 - asked,
        reason: "evicted",
      });
    }
    // And then what this attach declined to replay, which is not a loss at all:
    // it is on disk and the route serves it. `Math.max(asked, oldest - 1)` so the
    // two frames describe adjacent ranges rather than overlapping ones.
    const skippedFrom = Math.max(asked, oldest - 1) + 1;
    if (since >= skippedFrom) {
      this.control({
        type: "lagged",
        from: skippedFrom,
        to: since,
        dropped: since - skippedFrom + 1,
        reason: "backlog",
      });
    }

    for (;;) {
      const slice = this.managed.log.read(this.cursor, BATCH_MAX_EVENTS, BATCH_MAX_BYTES);
      if (slice.length === 0) break;
      // `replaying`, so an overflow here is reported as what it is. This block is
      // synchronous and the first `send` callback has not run, so nothing has
      // drained: a collapse on the byte ceiling is the daemon deciding not to
      // replay this much down a socket, not a client failing to keep up.
      for (const stored of slice) this.emit(stored, true);
    }

    this.unsubLog = this.managed.log.subscribe((stored) => this.emit(stored));
    this.unsubWatch = this.managed.watch((snapshot) => this.control({ type: "snapshot", session: snapshot }));
    this.control({ type: "caught_up", seq: this.cursor });

    const raw = this.raw;
    if (raw) {
      raw.on("pong", () => {
        this.alive = true;
      });
      // A closed laptop lid leaves a half-open socket that TCP alone will not
      // notice. Nothing else here would ever free that connection's resources.
      this.heartbeat = setInterval(() => {
        // Re-authorization, on the timer that already exists.
        //
        // A stream is authenticated once, at the upgrade, and then lives for as
        // long as the client keeps it open. Without this a five-minute token
        // would buy an unbounded-lifetime connection, and revocation — which is
        // bounded by the token lifetime and nothing else, because the daemon
        // never asks the control plane anything — would never reach an attached
        // client at all. `expiresAt` is null under the shared secret, so that
        // path is untouched.
        if (this.expiresAt !== null && Date.now() > this.expiresAt + AUTH_LEEWAY_MS) {
          this.close(4401, "token expired");
          return;
        }
        if (!this.alive) {
          raw.terminate();
          return;
        }
        this.alive = false;
        try {
          raw.ping();
        } catch {
          raw.terminate();
        }
      }, PING_INTERVAL_MS);
    }

    this.flush();
  }

  /**
   * `replaying` is the attach's own drain saying so, and it decides nothing but
   * the honesty of a collapse. See {@link ATTACH_REPLAY_MAX}.
   */
  private emit(stored: StoredEvent, replaying = false): void {
    if (this.closed || stored.seq <= this.cursor) return;
    this.cursor = stored.seq;
    this.enqueue({ kind: "event", stored, bytes: estimateBytes(stored.event) + 64 }, replaying);
  }

  private control(frame: unknown): void {
    if (this.closed) return;
    this.enqueue({ kind: "control", frame, bytes: 512 });
  }

  private enqueue(item: QueueItem, replaying = false): void {
    this.queue.push(item);
    this.queuedBytes += item.bytes;
    if (this.queue.length > MAX_QUEUE_EVENTS || this.queuedBytes > MAX_QUEUE_BYTES) {
      this.collapse(replaying ? "backlog" : "slow_consumer");
      return;
    }
    this.flush();
  }

  /**
   * Drops everything queued and jumps to the head of the log.
   *
   * The client is told the exact seq range it lost and handed a fresh snapshot,
   * so it is degraded rather than confused — and the agent never noticed.
   *
   * **The reason is an argument because the two callers are different events.**
   * A live socket that fell behind is `slow_consumer`, which the client draws as
   * a hole because it is one. An attach that overflowed its own drain is
   * `backlog` — every byte is still on disk and `GET /sessions/:id/events` serves
   * it, so the client restarts its history there instead. Handing the second one
   * the first one's word is the lie `ATTACH_REPLAY_MAX` exists to prevent, and it
   * was reachable through the byte ceiling that constant does not bound.
   */
  private collapse(reason: "slow_consumer" | "backlog"): void {
    const head = this.managed.log.stats().lastSeq;
    const from = this.lastSentSeq + 1;
    this.queue.length = 0;
    this.queuedBytes = 0;

    if (head >= from) {
      this.enqueue({
        kind: "control",
        bytes: 512,
        frame: { type: "lagged", from, to: head, dropped: head - from + 1, reason },
      });
    }
    this.cursor = head;
    this.lastSentSeq = head;
    this.enqueue({ kind: "control", bytes: 512, frame: { type: "snapshot", session: this.managed.snapshot() } });

    // Only a real slow consumer is counted towards the disconnect. A backlog is a
    // statement about how much history was asked for, so recording it here would
    // let a big enough attach close the socket for a client that has not yet been
    // given a single frame to be slow about.
    if (reason !== "slow_consumer") return;
    const now = Date.now();
    this.collapses = this.collapses.filter((at) => now - at < COLLAPSE_WINDOW_MS);
    this.collapses.push(now);
    if (this.collapses.length >= 2) this.close(4003, "slow consumer");
  }

  private flush(): void {
    if (this.closed || this.sending) return;
    const raw = this.raw;
    if (!raw || raw.readyState !== 1 /* OPEN */) return;
    // Let the kernel buffer drain before handing it more; the send callback
    // below brings us straight back here.
    if (raw.bufferedAmount > SOCKET_HIGH_WATER) return;

    const head = this.queue[0];
    if (!head) return;

    let payload: string;
    if (head.kind === "control") {
      this.queue.shift();
      this.queuedBytes -= head.bytes;
      payload = safeStringify(head.frame);
    } else {
      const events: StoredEvent[] = [];
      let bytes = 0;
      while (this.queue.length > 0 && events.length < BATCH_MAX_EVENTS) {
        const next = this.queue[0]!;
        if (next.kind !== "event") break;
        if (events.length > 0 && bytes + next.bytes > BATCH_MAX_BYTES) break;
        this.queue.shift();
        this.queuedBytes -= next.bytes;
        events.push(next.stored);
        bytes += next.bytes;
      }
      const last = events[events.length - 1];
      if (last) this.lastSentSeq = last.seq;
      payload = safeStringify({ type: "events", events });
    }

    this.sending = true;
    raw.send(payload, (error) => {
      this.sending = false;
      if (error) {
        this.close(1011, "send failed");
        return;
      }
      if (this.queue.length > 0) this.flush();
    });
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.dispose();
    try {
      this.ws.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.unsubLog?.();
    this.unsubWatch?.();
    this.unsubLog = null;
    this.unsubWatch = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * The credential, from the header or the query string.
 *
 * A *present* `Authorization` header is authoritative even when it is malformed:
 * this used to fall through to `?token=` whenever the header did not start with
 * exactly `Bearer `, so `authorization: bearer x` — lowercase, which some HTTP
 * clients produce — took the no-header path and was reported as a missing
 * token. Returning `""` instead makes a broken header a failed authentication
 * rather than an ignored one.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is
 * case-insensitive; the credential after it is not touched.
 *
 * **`?token=` is read only on a handshake that cannot carry a header**, which is
 * the justification the parameter has always been given and was not the rule the
 * code held. This function is called from one place — the `app.use("*")` gate —
 * so the query credential authenticated *every* route: `GET
 * /sessions/:id/files?path=chart.png&token=<jws>` returned the bytes, and that
 * URL then sits in browser history, in the `Referer` of anything the page loads
 * next, and in every intermediary's log, while the origin that minted it holds
 * `reemoat.credential` in `localStorage`. The download rules in `CLAUDE.md`
 * refuse an `<a href="…&token=">` partly on the grounds that it "would widen the
 * `?token=` exception" — nothing widened it because nothing had narrowed it,
 * which is the `sessionOf` shape again: a property the code appears to have and
 * nothing enforces.
 *
 * The `upgrade` header rather than the stream route's path, because the reason is
 * about the *handshake* and not about one URL: a route reader would have to be
 * kept in step with the routes, and the day it fell behind it would fail open.
 * A caller who deliberately sets `Upgrade: websocket` on an ordinary GET gains
 * nothing — it is holding the token either way — and the leak this closes is the
 * URL a browser follows, which never carries that header.
 */
function readCredential(c: Context): string | null {
  // `=== null` rather than falsiness: `bearerToken` answers `""` for a header
  // that is present and malformed, and that must *not* fall through to the query
  // — see its docblock for the `authorization: bearer x` case this protects.
  const fromHeader = bearerToken(c.req.header("authorization"));
  if (fromHeader !== null) return fromHeader;
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return null;
  return c.req.query("token") ?? null;
}

const DECISION_WORDS = ["allow", "allow_always", "reject", "reject_always"] as const;

function parseAnswer(body: Record<string, unknown>): PermissionAnswer | null {
  const forms = [
    typeof body["optionId"] === "string",
    typeof body["decision"] === "string",
    body["cancel"] === true,
  ].filter(Boolean).length;
  // Exactly one, so an ambiguous body is never silently resolved one way.
  if (forms !== 1) return null;

  if (typeof body["optionId"] === "string") return { optionId: body["optionId"] };
  if (body["cancel"] === true) return { cancel: true };
  const decision = body["decision"];
  if (typeof decision === "string" && (DECISION_WORDS as readonly string[]).includes(decision)) {
    return { decision: decision as (typeof DECISION_WORDS)[number] };
  }
  return null;
}

/**
 * The three things a client may say about a question.
 *
 * Exactly one form, like {@link parseAnswer}, so an ambiguous body is never
 * silently resolved one way.
 *
 * `decline` and `cancel` are both here because they are genuinely different acts
 * rather than a symmetry: measured against claude's adapter, `decline` runs the
 * tool with empty answers and the turn *carries on* — the model is told the
 * person skipped — while `cancel` aborts the tool call. Collapsing them would
 * take one of the two away from whoever is holding the phone.
 *
 * `content` gets its own object guard. `readJson` already refuses a non-object
 * *body*, and that says nothing about this field: `null` and `[]` are both
 * `typeof "object"`.
 */
function parseElicitationAnswer(body: Record<string, unknown>): ElicitationAnswerBody | null {
  const content = body["content"];
  const isObject = typeof content === "object" && content !== null && !Array.isArray(content);
  const forms = [isObject, body["decline"] === true, body["cancel"] === true].filter(Boolean).length;
  if (forms !== 1) return null;

  if (isObject) return { content: content as Record<string, ElicitationContentValue> };
  if (body["decline"] === true) return { decline: true };
  return { cancel: true };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return JSON.stringify({ type: "error", code: "unserializable", message: "frame could not be encoded" });
  }
}

function notFound(c: Context): Response {
  return jsonError(c, 404, "session_not_found", "no such session on this daemon");
}

/**
 * The status a {@link PathError} deserves, in the one place all three fs routes
 * read it from.
 *
 * They disagreed on the fallback and that is legitimate — a bad `name` on
 * `mkdir` is a 400 and a missing `path` on a listing is a 404 — but they must
 * not disagree on the two codes that are about something other than the request
 * being wrong. `unresponsive` is a 503 rather than a 404: the directory is
 * there, it is a stalled mount, and a client that reads it as "gone" will prune
 * a perfectly good recent-directory row for it.
 */
/**
 * What a refused worktree removal is called, and what it says it refused for.
 *
 * The status and the remedy are the same for every refusal — a 409, cured by
 * `?force=1`, which is what `RemoveRefusal`'s own docblock promises — so those
 * are fixed here. **The sentence is not, and it used to be.** This arm answered
 * every refusal `workspace_dirty` / "this worktree still holds work", and one of
 * the refusals says the opposite of that: `counts_unknown` exists precisely to
 * record that the daemon **could not tell** whether there is work there, because
 * `git status` timed out or answered 128 off a stale gitfile. Removing
 * `removeWorkspace`'s `?? 0` one level down was the whole point — a count nobody
 * could take is not a count of zero — and restating it as a claim at the boundary
 * put the defect back at the only place anybody reads it: `scripts/client.ts`
 * prints `error.message` and walks nothing else, so an operator was told a
 * worktree definitely holds work and invited to force-delete it on that evidence.
 *
 * `locked` gets its own words for the same reason in miniature: a locked worktree
 * is a fact about a lock rather than about work.
 *
 * **Both definite shapes keep the `workspace_dirty` code deliberately**, because
 * that string is what `scripts/client.ts` keys its "pass --force to remove it
 * anyway" hint on, and force really is the remedy for a lock as much as for a
 * dirty tree. The uncertain arm has to be a new code — a client that reads
 * `workspace_dirty` as "there is work here" would be reading a lie — so it
 * carries the remedy in its own sentence instead, rather than losing the remedy
 * along with the falsehood.
 */
function removalRefusalAnswer(refusals: readonly RemoveRefusal[]): { code: string; message: string } {
  const definite = refusals.filter((refusal) => refusal.code !== "counts_unknown");
  if (definite.length === 0) {
    return {
      code: "workspace_uncertain",
      message: "could not tell whether removing this worktree would lose work; force removes it anyway",
    };
  }
  // A lock is only the answer when it is the *only* definite refusal: a tree that
  // is both dirty and locked is a tree that holds work, and that is the sentence
  // worth reading.
  const holdsWork = definite.some((refusal) => refusal.code !== "locked");
  return {
    code: "workspace_dirty",
    message: holdsWork ? "this worktree still holds work" : "this worktree is locked",
  };
}

function pathErrorStatus(error: PathError, fallback: 400 | 404): 400 | 403 | 404 | 503 {
  if (error.code === "outside_roots") return 403;
  if (error.code === "unresponsive") return 503;
  return fallback;
}

/**
 * An errno from a filesystem call, as this system's one error envelope.
 *
 * The `/fs` routes rethrow anything that is not a `PathError`, which was fine
 * while every call they made was funnelled through one that converted. They make
 * more calls than that now — a `stat` and a `readdir` on the directory itself —
 * and an `EACCES` or an `ENOTDIR` out of those left the handler as a raw throw,
 * i.e. a 500 with no `error.code`. Every client in this system parses `code`
 * (`packages/web/src/http.ts` says so out loud), so an uncoded 500 is the one
 * shape none of them can say anything useful about.
 */
function errnoError(c: Context, error: unknown, fallback: 400 | 404): Response | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code !== "string") return null;
  const message = describeError(error);
  if (code === "ENOENT") return jsonError(c, 404, "not_found", message);
  if (code === "ENOTDIR") return jsonError(c, 400, "not_a_directory", message);
  if (code === "EACCES" || code === "EPERM") return jsonError(c, 403, "invalid_path", message);
  if (code === "ELOOP" || code === "ENAMETOOLONG") return jsonError(c, 400, "invalid_path", message);
  return jsonError(c, fallback, "invalid_path", message);
}

/**
 * Sort key for a bounded `GET /sessions`: lower is kept.
 *
 * Blocked first because a pending permission is the only thing on this list that
 * is waiting on a human. Then anything pinned. Then everything else that is still
 * live. Terminal sessions last, because they will never change again and a client
 * that wants their transcript asks for them by id.
 *
 * Blocked still outranks pinned, and that ordering is the point rather than an
 * accident: a pin is a preference somebody expressed once, and a pending
 * permission is somebody being waited on right now. A pinned *terminal* session
 * outranking an unpinned live one is likewise intended — the person said to keep
 * it, and a `?limit=` cut that dropped it would make the pin a lie.
 *
 * This is the daemon's *truncation* order, which is a different question from the
 * client's *display* order (`sessionLists` in `packages/web`). They are allowed to
 * differ: this decides what survives a cut, that decides what a person reads first.
 *
 * Derived from the pending arrays rather than from `status === "blocked"` so it
 * stays right if the derived status ever gains a state that also has something
 * outstanding — and through `awaitingHuman`, so an approval and a question count
 * the same here without this line having to know there are two kinds.
 */
function listRank(session: SessionSnapshot): number {
  if (awaitingHuman(session)) return 0;
  if (session.pinned) return 1;
  return session.exit === null ? 2 : 3;
}

/**
 * Refuses a changes request when the session's directory is not there.
 *
 * An empty file list would be a lie: "nothing changed" and "I cannot see the tree
 * any more" are different answers and only one of them is safe to render.
 */
/**
 * Serve one file's bytes, and never anything a browser will render.
 *
 * Containment happened before this: `/files` ran `safeRelPath`, and the upload
 * route built its path entirely out of a row we wrote. What this owns is the two
 * things both routes must answer identically — what may be served, and under
 * which headers.
 *
 * **The headers are the security of this route, and they are not decoration.**
 * The reason used to be stated as `readCredential` accepting `?token=` on any
 * route, so that a download opened in a tab carried a live daemon token in
 * `location.search` for script in a rendered response to read. That door is shut
 * — the query credential is now read only on a WebSocket handshake, see
 * `readCredential` — and the headers are not one bit less load-bearing for it,
 * because the credential is not the only thing worth stealing here. This route
 * serves **any regular file under a session's workspace**: a rendered HTML or SVG
 * response executes on the daemon's own origin, where it can read every other
 * route with whatever credential the page it is embedded in holds, and where a
 * `blob:` URL made from it would inherit the creating origin. So:
 *
 * - `application/octet-stream` **always**, never sniffed, never the mime the
 *   uploader declared (a claim about a different surface), and never derived from
 *   an extension — a table would be wrong often and right often enough that
 *   somebody later "improves" it into emitting `text/html`.
 * - `attachment`, which is what actually makes a browser save rather than render.
 * - `nosniff`, which is not redundant beside it: it also stops anything *in front*
 *   of this daemon — a proxy, or a CDN somebody later puts on the relay —
 *   re-typing the body into something renderable.
 * - `no-store`, because the response is a private file fetched under a bearer
 *   credential, and a cacheable one is that file sitting in a shared cache.
 */
async function serveFile(c: Context, full: string, name: string): Promise<Response> {
  // `lstat` under a bounded probe, so a symlink is refused by *shape* rather than
  // by where it points, and a file on a sleeping mount is a 503 rather than a
  // confident 404 about somebody's work. See `probeFile`.
  const probe = await probeFile(full);
  if (probe === null) {
    return jsonError(c, 503, "file_unresponsive", "the filesystem holding that file did not answer", {
      timeoutMs: DESCRIBE_TIMEOUT_MS,
    });
  }
  // Symlinks, directories, fifos, sockets and devices in one refusal, because the
  // answer to all of them is the same. A 404 rather than a 403 for the reason
  // `sessionOf` 404s: the refusal should not confirm what is there.
  if (probe.kind !== "file") {
    return jsonError(c, 404, "not_a_regular_file", "that path is not a regular file");
  }
  if (probe.size > MAX_DOWNLOAD_BYTES) {
    return jsonError(c, 413, "file_too_large", "that file is too large to download", {
      bytes: probe.size,
      limit: MAX_DOWNLOAD_BYTES,
    });
  }

  /*
   * **Opened once, with `O_NOFOLLOW`, and everything else read off that handle.**
   *
   * The probe above is a bounded `lstat`, and it is still what answers 503 on a
   * stalled mount and 404 on a path that is not a regular file. What it cannot
   * do is decide anything about the bytes: it resolves a *path*, and re-opening
   * that path resolves it a second time. Between the two, anything running as
   * this uid — which is every agent, by design — can replace the leaf with a
   * symlink, and `createReadStream` follows it.
   *
   * `changes.ts` records the measurement this repeats: `ln -s ~/.ssh/id_rsa x`
   * inside a workspace, served to anyone holding the bearer token. The rule
   * written there is "`lstat` first, always", and a route that serves raw bytes
   * for any path under the workspace is the general case of it — so "always" has
   * to mean the handle the bytes come from, not a path checked a moment earlier.
   * `O_NOFOLLOW` refuses at `open`, which is the only place the answer cannot go
   * stale; `ELOOP` is a symlink and reads as the same 404 the probe gives.
   *
   * `fstat` on the handle then answers kind and size about **this** file
   * description. That also closes the framing bug the probe's size had: a file
   * that grew between the two would have emitted more bytes than the declared
   * `content-length`, which the relay forwards as opaque bytes and cannot fix.
   */
  let handle: Awaited<ReturnType<typeof openFile>>;
  try {
    handle = await openFile(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    // ELOOP (a symlink), EISDIR, ENOENT, EACCES — the answer to all of them is
    // the one the probe already gives, and saying which would confirm what is
    // there. Same reasoning as `sessionOf`'s 404.
    return jsonError(c, 404, "not_a_regular_file", "that path is not a regular file");
  }

  let size: number;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close().catch(() => {
        // Nothing to do; the descriptor dies with the process at worst.
      });
      return jsonError(c, 404, "not_a_regular_file", "that path is not a regular file");
    }
    size = info.size;
  } catch (error) {
    await handle.close().catch(() => {
      // As above.
    });
    return jsonError(c, 503, "file_unresponsive", "the filesystem holding that file did not answer", {
      detail: describeError(error),
    });
  }

  if (size > MAX_DOWNLOAD_BYTES) {
    await handle.close().catch(() => {
      // As above.
    });
    return jsonError(c, 413, "file_too_large", "that file is too large to download", {
      bytes: size,
      limit: MAX_DOWNLOAD_BYTES,
    });
  }

  const stream = handle.createReadStream();
  // **First, before the stream is handed anywhere.** A `Readable` that emits
  // `'error'` with no listener is an uncaught exception, and an EACCES or a stale
  // handle mid-read is exactly that event — the same fact the relay's
  // `handleUpgrade` invariant records, one layer down. Destroying it is enough:
  // the response is already streaming, so the transfer fails visibly rather than
  // completing short. Destroying the stream closes the handle with it.
  stream.on("error", () => stream.destroy());

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": contentDispositionFor(name),
      // From the handle's own `fstat`, so it describes the bytes being sent
      // rather than a path that was checked earlier: a file that shrinks fails
      // the transfer instead of arriving silently short, and one that grows
      // cannot overrun the length that was declared for it.
      "content-length": String(size),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

async function workspaceReady(c: Context, managed: ManagedSession): Promise<Response | null> {
  /*
   * **`existsSync`, and it was the whole daemon.**
   *
   * For a `plain` session `workspace.root` *is* the `cwd` the caller named, so
   * this was a synchronous filesystem call on a path somebody else chose, sitting
   * in front of `GET /sessions/:id/changes` and reachable with `session:read`. On
   * a hard network mount whose server has paused it blocks inside the kernel and
   * cannot be interrupted — which stops the event loop, which is every session,
   * every socket and `/health` with it. That is the exact death `browse.ts` was
   * rewritten to eliminate, still reachable through a different route; the rule
   * that module established is not about browsing, so it lives in `stall.ts` now
   * and this is one of its callers.
   *
   * And three answers rather than two, because they are genuinely different
   * things to tell somebody: gone is a 409 about their workspace, not answering
   * is a 503 about the filesystem under it — and calling the second one "no
   * longer exists" is a confident lie about work that is very probably fine.
   */
  const present = await probeExists(managed.workspace.root);
  if (present === true) return null;
  if (present === null) {
    return jsonError(
      c,
      503,
      "workspace_unresponsive",
      `${managed.workspace.root} did not answer; the filesystem it is on may have stalled`,
      { workspace: managed.workspace },
    );
  }
  return jsonError(c, 409, "workspace_missing", `${managed.workspace.root} no longer exists`, {
    workspace: managed.workspace,
  });
}

/** Maps a git failure onto the same status codes the agent failures already use. */
function gitError(c: Context, error: unknown): Response {
  if (error instanceof WorktreeError) return worktreeError(c, error);
  if (error instanceof GitError) {
    if (error.code === "git_missing") {
      return jsonError(c, 503, "git_missing", error.message);
    }
    if (error.code === "git_timeout") {
      return jsonError(c, 504, "git_timeout", error.message);
    }
    // `error.code`, not a hardcoded "git_failed": `git_output_too_large` is a
    // different problem and the caller should be able to tell them apart.
    return jsonError(c, 502, error.code, error.message, { stderr: error.stderr.trim() });
  }
  throw error;
}

function worktreeError(c: Context, error: WorktreeError): Response {
  switch (error.code) {
    // Environment problems, matching how `agent_unavailable` already uses 503.
    case "git_missing":
    case "worktree_root_unwritable":
      return jsonError(c, 503, error.code, error.message, error.detail);
    case "git_timeout":
      return jsonError(c, 504, error.code, error.message, error.detail);
    case "git_failed":
    case "git_output_too_large":
      return jsonError(c, 502, error.code, error.message, error.detail);
    // `outside_worktree_root` deliberately has no arm and falls to the 409 below.
    // It was a 403 when it meant "the repository git resolved is not yours to
    // open"; what it means now is that the managed worktree root refuses a path,
    // which is a conflict rather than a refusal of permission.
    default:
      return jsonError(c, 409, error.code, error.message, error.detail);
  }
}

export type { SessionSnapshot };

/**
 * A plugin's answer, or the refusal it turned into.
 *
 * One place, because there are two routes and the interesting part is identical:
 * a plugin can be missing, stopped, broken, slow, or simply wrong about what it
 * returns, and every one of those has to become an error envelope somebody can
 * read rather than a 500 with a stack in it. `PluginApiError` carries the code;
 * anything else is this daemon's own fault and reaches `app.onError`.
 */
async function pluginAnswer(c: Context, run: () => Promise<PluginResult>): Promise<Response> {
  try {
    const result = await run();
    return c.json({ result });
  } catch (error) {
    if (error instanceof PluginApiError) {
      return jsonError(c, pluginErrorStatus(error.code), error.code, error.message);
    }
    throw error;
  }
}

/**
 * Which status a plugin's refusal is.
 *
 * ⚠ Read the **code**, never the status — this function exists so the statuses
 * are at least not misleading, not so anybody branches on them. The split is by
 * *whose problem it is*: a plugin that is off or broken is `503`, because the
 * remedy is on this machine and the request itself was fine; everything else is a
 * `502`, because something downstream of this daemon answered badly.
 */
function pluginErrorStatus(code: string): 403 | 413 | 502 | 503 | 504 {
  if (code === "plugin_unavailable") return 503;
  if (code === "plugin_timeout") return 504;
  // Busy rather than broken, and the remedy is to ask again — which is what 503
  // says and 502 does not.
  if (code === "plugin_overloaded") return 503;
  if (code === "plugin_scope_denied") return 403;
  /*
   * ⚠ **The one code the split above has no arm for, and it fell to the wrong
   * half.** With no entry here it took the `502` default, whose stated reason is
   * "something downstream of this daemon answered badly" — and nothing downstream
   * answered at all: the message never reached the child, because it does not fit
   * one IPC frame. It is neither this machine's fault nor the plugin's; the
   * remedy is on the caller's side, which is what `413` says and is already this
   * daemon's word for it at `payload_too_large`, `import_too_large` and
   * `import_unpacked_too_large`. `docs/API.md` said `503`, which was a third
   * answer agreeing with neither.
   */
  if (code === "plugin_request_too_large") return 413;
  return 502;
}

/**
 * Which status an install refusal is.
 *
 * `413` for the bounds, so a client can tell "too big" from "wrong", `409` for a
 * plugin that will not start — the tree is unchanged and the old version is still
 * running, which is a conflict rather than a failure — and `400` for everything
 * about the archive or the manifest, all of which are things the person who built
 * it can fix.
 */
function pluginInstallStatus(code: string): 400 | 409 | 413 | 502 | 503 {
  switch (code) {
    case "plugin_too_large":
    case "plugin_unpacked_too_large":
    case "plugin_too_many_entries":
      return 413;
    case "plugin_start_failed":
    /*
     * A conflict for `plugin_start_failed`'s own reason: nothing was changed.
     * The commit asks for authority nobody granted, so this daemon refused it
     * before the plugin ran — whatever was installed before is still installed
     * and still running, and the remedy is a person looking at what changed.
     */
    case "plugin_consent_broken":
      return 409;
    case "plugin_write_failed":
      return 503;
    /*
     * ⚠ **`502`, because nothing about the request was wrong.** GitHub was
     * unreachable, or answered something other than a tarball. A `400` here would
     * send somebody hunting for a typo in a commit that is perfectly good, and a
     * `503` would claim this daemon is the thing that is unwell. `404` from the
     * far end keeps its own code, because "that commit is not there, or the
     * repository is private" is the one refusal on this path a person can act on.
     */
    case "plugin_source_unavailable":
    case "plugin_source_not_found":
      return 502;
    default:
      return 400;
  }
}
