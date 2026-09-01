import type { WireError } from "./wire";

/**
 * One error type for three services.
 *
 * The daemon, the relay and the control plane all answer
 * `{error: {code, message, detail}}`, and the client's decisions turn on `code`
 * far more than on `status` — `token_expired` and `no_tunnel` call for completely
 * different behaviour and are both "the request failed" to anything coarser.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  /**
   * The parsed body, whatever shape it had.
   *
   * Kept because not every non-2xx in this system is an error *envelope*. The
   * daemon answers a repeated permission answer with `409` carrying a
   * success-shaped body — `{recorded: true, repeat: true, outcome, session}`, no
   * `error` key — because the answer really did land and the caller really should
   * treat it as success. Reading only `error.code`/`error.detail` threw that away,
   * turned the code into `http_409` and the detail into `null`, and left the
   * caller unable to tell "already approved" from "approval failed" — which is
   * exactly what a retry from a phone on a flaky connection produces.
   *
   * `scripts/client.ts` has always kept the body for the same reason. This is the
   * browser client catching up rather than a new idea.
   */
  readonly body: unknown;

  constructor(status: number, code: string, message: string, detail: unknown = null, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
  }

  /**
   * True when the request reached something that answered.
   *
   * This is the distinction the route memo turns on: an `ApiError` means the
   * route *worked*, so it must never trigger a re-probe. A thrown `TypeError`
   * from `fetch` means it did not.
   */
  static isApiError(error: unknown): error is ApiError {
    return error instanceof ApiError;
  }
}

/**
 * What a dead link says, once, in words rather than in a constructor's name.
 *
 * **Two clauses, and the second one is the whole reason this is not "try
 * again".** A transport failure says *nothing* about whether the daemon acted —
 * `machine.ts`'s `settleTransport` argues it at length and acts on it, refusing
 * to replay anything but a `GET` or a `DELETE`, because the timeout that most
 * often lands here is this client's own `AbortSignal.timeout` firing long after
 * the daemon accepted the request, appended the event and started the turn. So a
 * sentence advising a retry would be advising something the code one layer down
 * has already decided not to do, on a request that may well have landed.
 *
 * Neutral about *what* was being reached, because this is also what a control
 * plane call says: `AccountSection` and `MachineSection` pass the same failures
 * through here, and "the machine" would be wrong on half of them.
 *
 * Lower case and unpunctuated, which is the register of the `ApiError` messages
 * it sits beside — `you already have a machine called that`, `${name} is not
 * reachable` — because a caller cannot tell which arm it got.
 */
const TRANSPORT_TEXT = "the connection failed, and whether the request arrived is not known";

/**
 * What to put on screen when a call failed.
 *
 * `ApiError.isApiError(cause) ? cause.message : String(cause)` was written out
 * **23 times** across `packages/web/src` — every toast, every inline form error,
 * every settings panel. One expression that many times is one expression nobody
 * can change: the `ApiError` half exists because a control plane's sentence is
 * better than "[object Object]", and a call site that forgets it prints the
 * object.
 *
 * ⚠ **This is the edit the de-duplication deferred, and the old note said so.**
 * It read: `String(cause)` "yields `TypeError: Failed to fetch` for a dead
 * network, as every one of those 23 sites already did. Changing that is a change
 * to what people read on 23 screens and belongs in its own edit." This is that
 * edit. What reached those screens verbatim was a constructor name and a Chrome
 * string — `TypeError: Failed to fetch`, and from `sendWithProgress`'s own
 * budgets `TypeError: upload stalled` — printed at somebody who is looking at a
 * settings pane to find out what went wrong. {@link TRANSPORT_TEXT} is the
 * sentence instead.
 *
 * ⚠ **`instanceof Error` is the narrowing, and {@link isTransportFailure} alone
 * would have been too wide.** That predicate is a *negation* — "not an
 * `ApiError`" — because the browser deliberately withholds why a `fetch`
 * rejected, so there is nothing finer to key on. But `errorText` is also handed
 * things nobody threw as an error at all: `webcheck` pins that a thrown string
 * renders as itself, that a thrown object renders `[object Object]`, and that
 * `null` and `undefined` still say something. Those are this client mis-throwing
 * rather than a link dying, and reporting them as a network failure would hide a
 * bug behind a sentence about the weather.
 *
 * What the narrowing does **not** buy is precision about the rest: a genuine
 * `TypeError` from a bug in this client is an `Error`, is not an `ApiError`, and
 * lands on the transport sentence. That is the honest cost of a predicate the
 * browser will not let anyone write properly, and it is the same trade
 * `isTransportFailure` already makes for the route memo — where guessing wrong
 * costs one re-probe. Here it costs one wrong sentence, on a path where the old
 * sentence was `TypeError: x is not a function`.
 *
 * Deliberately **not** `describe` in `machine.ts`, which prefixes the code
 * (`no_tunnel: …`). That is right for the machine banner, where the code is the
 * thing an operator looks up, and wrong beside a form field, where it is jargon
 * in front of the sentence that answers the question.
 */
export function errorText(cause: unknown): string {
  if (cause instanceof Error && isTransportFailure(cause)) return TRANSPORT_TEXT;
  return ApiError.isApiError(cause) ? cause.message : String(cause);
}

/**
 * Whether an answered request means the *machine* is gone.
 *
 * **One code, and it has to be the code rather than the status.** The relay
 * answers `503 no_tunnel` when no daemon holds a tunnel for the machine, which
 * is the only way a client learns a machine is offline now that there is no
 * direct path to probe. The daemon answers `503 unresponsive` from `/fs/list`,
 * `/fs/mkdir` and `POST /sessions` when the path in question sits on a network
 * mount that has stopped answering — and that is the daemon *talking*, on a
 * machine that is plainly reachable. Keying on `503` would black out a healthy
 * machine because one directory did not answer, so the two are told apart here,
 * once, rather than at each call site.
 *
 * A pure function so `webcheck` can assert it: `MachineConnection` cannot be
 * constructed in the driver without pulling in the control-plane client, and
 * this rule is far too easy to get subtly right in a way that regresses.
 */
export function meansMachineGone(error: unknown): boolean {
  if (!ApiError.isApiError(error)) return false;
  /*
   * **Two codes, and the second one had to be added here or the machine reads
   * online for ever.** The relay answers `403 machine_over_limit` for a machine
   * past its owner's limit, and `machine.ts` calls `forgetRoute()` on exactly
   * what this function admits — so a code missing from this list is a machine
   * whose route memo is never dropped, drawn as reachable while every single
   * request against it fails.
   *
   * They mean different things and license the same act: stop believing this
   * route. `no_tunnel` is "no daemon is holding one"; the other two are "there
   * is one and you may not have it" — over its owner's limit, or owned by
   * somebody who has been banned. None is a reason to keep a memo.
   *
   * `owner_disabled` is **not** `user_disabled`, and the difference is the whole
   * reason it has its own string: `authFailure` ends a session on the latter,
   * and a grantee touching a banned person's machine must not be signed out of
   * the app for it.
   */
  return (
    error.code === "no_tunnel" || error.code === "machine_over_limit" || error.code === "owner_disabled"
  );
}

/**
 * Whether a refused config change is the one the control already answered.
 *
 * **One code, and it has to be the code rather than the status** — the rule
 * `meansMachineGone` states one function up. `POST /sessions/:id/config` answers
 * `409 turn_in_flight` from exactly one guard, the ultracode restart in
 * `setConfigOption`; `setMode` has no such arm, and the daemon records the reason
 * as an invariant: exactly one control needs the agent restarted to take effect,
 * so exactly one refusal on this route is honestly "wait for the turn to end"
 * while every other option is applied live. The prompt route's own
 * `turn_in_flight` is a different route and never reaches this caller.
 *
 * **It is suppressed because the row said it first.** `choiceRefusal` draws the
 * sentence on the choice and swallows the tap, so what still reaches the catch is
 * a turn that began between the frame that drew the row and the finger that hit
 * it. ⚠ A second code must never be added here without a sentence on the control
 * to match, or this degenerates into a `catch {}` that eats a refusal nobody was
 * told about.
 *
 * Fails open: rename the code on the daemon and the toast comes back, rather than
 * the refusal going silent. Q3.429.
 */
export function meansRestartRefused(error: unknown): boolean {
  return ApiError.isApiError(error) && error.code === "turn_in_flight";
}

/**
 * A daemon that has never heard of this route, as opposed to one that refused.
 *
 * ⚠ **Known by the shape of the refusal rather than by a version, which is the
 * whole reason it can be asked at all.** Nothing sends a version *to* a daemon and
 * nothing here reads one, so a route added in this release has exactly one
 * signature on an older host: Hono's own bare 404, with no error envelope, which
 * `parseBody` turns into `code: "http_404"`. A daemon that *has* the route and
 * refuses it answers the envelope, so its `code` is a name somebody chose.
 *
 * The two need opposite screens. An absent route is a settled answer — the daemon
 * replied, and what it replied is that it is older — so it takes a sentence naming
 * the remedy and **no** retry, because pressing one asks the same daemon the same
 * question. A refusal is an event and takes the triangle and a way to ask again.
 *
 * Written out inline at five sites before this existed; `SystemsPanel` is the
 * first caller and the other four still transcribe it.
 */
export function meansRouteAbsent(error: unknown): boolean {
  return ApiError.isApiError(error) && error.status === 404 && error.code === `http_${error.status}`;
}

/**
 * A transport failure — DNS, refused, timed out, blocked, TLS.
 *
 * `fetch` rejects with a bare `TypeError` for all of them and the browser
 * deliberately withholds the reason, so there is nothing finer to key on. What
 * matters is only that it is *not* an `ApiError`.
 *
 * ⚠ **It is a negation, so it is true of anything that is not an `ApiError`** —
 * including a thrown string, a thrown object literal, and a bug in this client.
 * That is harmless where the answer is "drop the route memo and re-probe", which
 * is what both callers in `machine.ts` do with it. It is not harmless where the
 * answer is a sentence somebody reads, so {@link errorText} pairs it with
 * `instanceof Error` rather than taking it neat; see the note there.
 */
export function isTransportFailure(error: unknown): boolean {
  return !ApiError.isApiError(error);
}

/**
 * Whether an answered refusal means **later** rather than **no**.
 *
 * Three codes, and every one of them describes a route to a machine that is
 * expected to come back on its own, with nobody acting:
 *
 *   - `unreachable` is this client's own (`MachineConnection.prepare`), raised
 *     when `resolveRoute()` answers null — i.e. one `/health` probe missed
 *     inside `PROBE_TIMEOUT_MS`, which is **1.5 s** against the 15 s budget of
 *     the request it gates.
 *   - `no_tunnel` is the relay's, for a machine whose daemon is not holding a
 *     tunnel *right now*. Recreating the relay container produces exactly this
 *     for as long as the daemon takes to redial, which is its own 1 s→30 s
 *     full-jitter backoff.
 *   - `tunnel_failed` is the relay's for a tunnel that died mid-request. A
 *     retry lands on the replacement.
 *
 * **`no_tunnel` is in this set *and* in `meansMachineGone`, and both are
 * right.** They are different questions about one answer: stop believing this
 * route, *and* ask again in a moment. The other two codes `meansMachineGone`
 * admits — `machine_over_limit` and `owner_disabled` — are deliberately absent
 * here, because those need an **admin** to act and retrying them is a request
 * loop against a state that will not move.
 *
 * The code and never the status, for `meansMachineGone`'s reason: the daemon's
 * own `503 unresponsive` is a reachable machine saying one path sits on a mount
 * that stopped answering. It never arrives on the history path (`/fs/list`,
 * `/fs/mkdir` and `POST /sessions` are its callers) and a directory listing is
 * not something to retry behind the reader's back.
 */
export function meansLater(error: unknown): boolean {
  if (!ApiError.isApiError(error)) return false;
  return error.code === "unreachable" || error.code === "no_tunnel" || error.code === "tunnel_failed";
}

/**
 * Whether a rejected answer actually landed.
 *
 * A `409` from either answer route is the one response in this system that is
 * deliberately **not** an error envelope: the answer really did arrive, and this
 * is precisely what a retry from a phone on a flaky connection produces. Treating
 * it as a failure tells somebody their approval did not work while the agent is
 * already running on it.
 *
 * All three disjuncts are load-bearing, and that is why this is a function rather
 * than a line at a call site. `repeat` is at the **top level** of the body, not
 * in `detail` — the first version of this read `detail` alone, so both halves
 * were always false and every retried approval showed the user a raw JSON blob as
 * its error message. `expiredCode` is the third case: settled and forgotten is
 * also "it landed", just too long ago to describe.
 *
 * Extracted rather than copied to a second card for the reason `parseBody` was: a
 * second copy is a second chance to make the mistake that already shipped once.
 */
export function answerAlreadyLanded(error: unknown, expiredCode: string): boolean {
  if (!ApiError.isApiError(error) || error.status !== 409) return false;
  const body = error.body as { repeat?: boolean } | null;
  const detail = error.detail as { repeat?: boolean } | null;
  return body?.repeat === true || detail?.repeat === true || error.code === expiredCode;
}

/**
 * Turn a status and a body *string* into a value or an `ApiError`.
 *
 * A body that is not the expected envelope still produces an `ApiError` — an
 * intercepting proxy or a captive portal answers HTML, and "unexpected end of
 * JSON input" as the user-visible reason for a failed approval is useless.
 *
 * Split out of `readJson` rather than living inside it because an upload needs
 * `XMLHttpRequest` — `fetch` reports no upload progress, and a streamed request
 * body is Chromium-only, so on the phone this app is built for there is no
 * alternative. XHR hands back a status and a `responseText` and never a
 * `Response`, so a rule that lived inside `readJson` would have been *copied*
 * there. The rule worth protecting is the one `ApiError.body` exists for: the
 * daemon's `409` carrying a success-shaped body. A second copy of it would drift,
 * and the drift would read as "the approval failed" for an approval that landed.
 *
 * Pure, so `webcheck` asserts the rule itself rather than a transcription of it.
 */
export function parseBody<T>(status: number, statusText: string, text: string): T {
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  // The same test `Response.ok` applies. Written out because XHR has no `ok`.
  if (status < 200 || status >= 300) {
    const envelope = parsed as WireError | null;
    const wire = envelope?.error;
    throw new ApiError(
      status,
      wire?.code ?? `http_${status}`,
      wire?.message ?? (text.slice(0, 200) || statusText || "request failed"),
      wire?.detail ?? null,
      parsed,
    );
  }

  return parsed as T;
}

/** Read a response, turning a non-2xx into an `ApiError`. See `parseBody`. */
export async function readJson<T>(response: Response): Promise<T> {
  return parseBody<T>(response.status, response.statusText, await response.text());
}

/**
 * What `content-type` a request body implies.
 *
 * `MachineConnection.request` used to write `application/json` for any body at
 * all, which was true of every caller and would have silently corrupted the first
 * one that was not. The rule is keyed on what the body *is* rather than on a
 * header argument nobody can pass: `request` spreads `init` over its own
 * `headers`, so a caller-supplied header object is discarded today — and that is
 * a good property (there is nothing to pass, so nothing can be passed wrong)
 * worth keeping rather than opening up for one route.
 *
 * `undefined` means write no header at all, which is what a `GET` must send.
 */
export function contentTypeFor(body: BodyInit | null | undefined): string | null {
  if (body === undefined || body === null) return null;
  // Every JSON caller in `daemon.ts` passes `JSON.stringify(...)`.
  if (typeof body === "string") return "application/json";
  return "application/octet-stream";
}

/** `AbortSignal.timeout`, but also honouring a caller's own signal. */
export function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return outer === undefined ? timeout : AbortSignal.any([timeout, outer]);
}
