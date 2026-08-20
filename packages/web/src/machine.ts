import { mintToken } from "./cp";
import {
  ApiError,
  contentTypeFor,
  isTransportFailure,
  meansMachineGone,
  parseBody,
  withTimeout,
} from "./http";
import type { MachineId } from "./ids";
import type { DaemonHealth, MachineRecord, Scope } from "./wire";

/**
 * One machine, and everything the client knows about reaching it.
 *
 * Three things live here together because they are one thing: the token, the
 * route, and the request helper. Minting a token is also how the client learns
 * where the machine is — `POST /v1/tokens` answers with `relayUrl` and
 * `relayOnline` — so splitting them would create two facts that can disagree
 * about the same machine.
 *
 * Nothing in here is global. Every machine has its own token, its own route memo
 * and its own reachability, because partial availability is the normal case: one
 * laptop is shut, one is on a LAN, one is behind NAT on the far side of a relay,
 * and none of those states may affect the others.
 */

/** Renew this far ahead of expiry. Larger than the daemon's 60s clock leeway. */
export const TOKEN_RENEW_MARGIN_MS = 90_000;

/**
 * Rotate a live socket this far ahead of expiry.
 *
 * Smaller than the renew margin, so the token is already fresh when the rotation
 * fires: the sequence is "refresh at exp−90s, rotate at exp−60s", never "rotate
 * onto a token that is itself about to die".
 */
export const SOCKET_ROTATE_MARGIN_MS = 60_000;

/** Long enough for a LAN round trip, short enough not to hold up a render. */
const PROBE_TIMEOUT_MS = 1_500;

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Calls that spawn a process before they can answer.
 *
 * Creating a session waits for the agent to start — the daemon's own budget is
 * 45s, and `git worktree add` in front of it is allowed 120s because it runs a
 * real checkout with the repository's own hooks and LFS filters. `POST
 * /sessions/:id/resume` is the same launch and needs the same room, and so is
 * `POST /sessions/:id/prompt` since the daemon began resuming an interrupted
 * session before delivering the message — see the note at that entry for why it
 * is unconditional rather than only for the sessions that need it.
 *
 * Everything under `/agent-auth` is here too, matched by prefix so a route added
 * under it cannot reintroduce the gap: `GET /agent-auth` runs the login probe
 * (which spawns `claude auth status`), and starting a login spawns a CLI under a
 * pty. Both went out at 15s once, and the failure was not a slow screen — a
 * timeout is a *transport* failure, so `forgetRoute` drops the memo and
 * `markUnreachable` follows, and Settings then renders "not reachable right now"
 * over the one screen a logged-out person came for.
 *
 * **The rule this constant exists for, and it is the one worth keeping:** the
 * daemon's own deadline for a `set_config_option` is 15s, which is *exactly* what
 * this client used to allow — so the client's abort always won the race and the
 * daemon's carefully built `502 agent_config_failed`, carrying the agent's own
 * explanation, could never be seen by anyone. A client deadline that equals the
 * server's does not merely risk a false negative; it makes the server's error
 * path dead code.
 *
 * Left at 90s rather than retuned when the container start went away, and that is
 * deliberate: `worktree add` plus an agent start is still 165s of daemon budget
 * stacked in front of one request, and those are facts about `src/` rather than
 * about Docker. Lowering it should follow a measurement, because the failure of
 * guessing low is a healthy machine reported unreachable.
 */
const SLOW_ROUTE_TIMEOUT_MS = 90_000;

/**
 * How long a download is given.
 *
 * A `GET` that streams a file, so it is bounded by bytes rather than by a
 * daemon-side budget the way `SLOW_ROUTE_TIMEOUT_MS` is. Two minutes covers the
 * 100 MiB ceiling below on anything better than a bad LTE cell; past that the
 * honest answer is that the link cannot carry it.
 */
const TRANSFER_TIMEOUT_MS = 120_000;

/**
 * The largest file this client will pull into memory.
 *
 * A download becomes a `Blob`, so the whole thing is resident — and the route
 * serves any regular file under the workspace, which includes the 2 GiB binary
 * the agent just built. Without a gate that is a dead tab with nothing to read.
 *
 * Checkable *before* the body is consumed because `content-length` is one of the
 * CORS-safelisted response headers, so it survives the cross-origin hop even
 * though `src/cors.ts` sends no `access-control-expose-headers`. That same
 * absence is why the filename comes from the requested path rather than from
 * `content-disposition`, which is **not** safelisted and therefore not readable.
 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** No progress at all for this long means the link is dead, whatever the size. */
const UPLOAD_STALL_MS = 30_000;

/** The floor an upload is assumed to sustain, for the hard cap: ~50 KiB/s. */
const UPLOAD_FLOOR_BYTES_PER_MS = 50;

/**
 * The two deadlines an upload runs under.
 *
 * A wall clock alone is the wrong instrument here: a slow-but-progressing upload
 * is not a failure, and 25 MiB over a phone uplink is minutes rather than the
 * 15s an ordinary request gets. So the primary budget is a **stall** — reset by
 * every progress event — and the wall clock is only a backstop against a
 * connection that trickles for ever.
 *
 * `hardMs` is capped at 300s deliberately: that is the token lifetime, so the
 * number cannot quietly become load-bearing on something else. A request already
 * in flight does not die at `exp` — the daemon verifies the bearer once at the
 * start and the relay authorizes at CONNECT — but a cap above it would be
 * claiming a property nothing checks.
 *
 * Floored at `REQUEST_TIMEOUT_MS` so a one-byte upload is never *more* fragile
 * than an ordinary request.
 */
export function uploadDeadlines(bytes: number): { stallMs: number; hardMs: number } {
  const scaled = 20_000 + Math.ceil(Math.max(bytes, 0) / UPLOAD_FLOOR_BYTES_PER_MS);
  return {
    stallMs: UPLOAD_STALL_MS,
    hardMs: Math.min(300_000, Math.max(scaled, REQUEST_TIMEOUT_MS)),
  };
}

/**
 * Where a machine is reached, and there is one answer.
 *
 * This used to be a *choice* — `direct | relay`, probed in that order, memoised,
 * and dropped again by `forgetRoute` on any transport failure. All of it is gone
 * with the direct path: every request to every machine goes down the tunnel its
 * daemon dialled out to the control plane, which is what makes a grant something
 * that can be revoked and take effect on the next request rather than within a
 * token lifetime.
 *
 * Kept as a named type rather than inlined as a string, because it is what a
 * request is built against and the shape is mirrored on the daemon's side.
 */
export interface Route {
  base: string;
}

export type Reach = "unknown" | "probing" | "online" | "offline";

export type OfflineReason =
  | "no_route"
  | "no_token"
  | "not_enrolled"
  | "cp_unreachable"
  | "over_limit"
  | "owner_disabled"
  | null;

/** Why a session URL has no row behind it. See {@link missingRowReason}. */
export type MissingRow = "loading" | "no_machine" | "not_here" | "unreachable";

/**
 * What to say about a session the store holds no row for.
 *
 * **`loading` is the answer that was missing, and its absence was a lie on the
 * ordinary path.** `SessionView` read `rowsByKey`, found nothing, and drew either
 * *"That session is not on this daemon."* or *"<name> is not reachable right
 * now."* — but on a cold reload straight onto a session URL, neither is known
 * yet. `bootstrap` promotes to `phase: "ready"` on the *machine* list, so the
 * view mounts three round trips before the session list exists (mint a token,
 * `forgetRoute()` and re-probe the route — itself bounded at 1.5s — then
 * `GET /sessions`), and `resumeMachine` drops the route memo first, so `reach` is
 * `unknown` or `probing` for most of that. On a phone over the relay this is
 * seconds of a screen confidently denying that a live session exists.
 *
 * `listed` is the store's own record of having had a session list back from this
 * machine at least once, and it is what separates the last two: a machine that is
 * plainly online but has never been asked cannot yet say a session is not there.
 *
 * Pure, and here rather than in the component, so `webcheck` can walk the whole
 * `Reach` × `listed` matrix — the `online` + not-listed cell is the bug, and it is
 * one cell of six.
 */
export function missingRowReason(reach: Reach | null, listed: boolean): MissingRow {
  if (reach === null) return "no_machine";
  if (reach === "unknown" || reach === "probing") return "loading";
  if (reach === "offline") return "unreachable";
  return listed ? "not_here" : "loading";
}

/**
 * Whether a screen may draw this machine's daemon-backed content.
 *
 * **`probing` keeps the previous answer, and that is the whole of it.** A re-probe
 * is this client re-checking a route it deliberately forgot — `resumeMachine`
 * calls `forgetRoute()` on every wake, because what it believed about
 * reachability was true of a network the phone may have left. It is a
 * measurement in progress, not the host going away, and it publishes twice:
 * `probing` before any I/O, then `online` up to 1.5s later.
 *
 * Read as "not online", those two publishes **unmount and remount** whatever the
 * screen was showing. On Settings → Machines → an agent that meant: the panel
 * replaced by "not reachable right now", then `useAgentAuth` restarting from
 * `listing: null` on the way back — a spinner, a second `GET /agent-auth` (which
 * shells out to every agent's CLI, on the 90s budget), and anything typed into a
 * credential box or any sign-in wizard in progress thrown away. Once per tab
 * switch, which is exactly what somebody does on this screen: go and copy a
 * token, come back.
 *
 * `.claude/rules/web-shell.md` already states the rule this restores, about the
 * rail: reachability flickers, so a row may not change because of it. These two
 * screens are the ones that legitimately *show* reachability — and showing it is
 * still not a reason to take the content away while asking.
 *
 * Pure, and beside {@link missingRowReason} rather than inside a component, so
 * `webcheck` walks all four values instead of asserting JSX.
 */
export function daemonReadable(reach: Reach): boolean {
  return reach === "online" || reach === "probing";
}

export interface MachineState {
  id: MachineId;
  name: string;
  relayUrl: string | null;
  relayOnline: boolean;
  enrolled: boolean;
  /**
   * When the control plane last saw a tunnel for it. See `MachineRecord`.
   *
   * `undefined` is a control plane that predates the field and `null` is one that
   * has never recorded a tunnel; collapsing them would tell somebody their
   * working fleet has never been seen.
   */
  lastSeenAt: number | null | undefined;
  /**
   * Whether this user owns it, and may therefore rename, re-enroll and retire it.
   *
   * `false` for a machine somebody else registered and shared, and for one an
   * admin created before ownership existed. Carried so the settings screen can
   * draw the controls only where they would work — the control plane answers 404
   * to the rest, deliberately, so a client that guessed would produce a button
   * that fails with "no such machine" on a machine plainly on screen.
   */
  owned: boolean;
  /**
   * Past its **owner's** machine limit, so switched off at the relay.
   *
   * **Carried beside `reach` rather than folded into it**, and the pair is not
   * redundant. `reach` is a measurement *this client made* — `probeRoute` says
   * so: "`relayOnline` is what the control plane last saw; the probe is what
   * this client can see". Over-limit is asserted by the control plane before any
   * probe and is true of a machine whose daemon is running and whose host is
   * fine. Carried only as a `reach` value it would be a state `settleRoute`
   * never measured. The shape being copied is `tokenDegraded`: a fact that is
   * not reachability, beside one that is.
   *
   * What follows from it *is* reachability — the tunnel is refused at dial — and
   * that half is `offlineReason: "over_limit"`, exactly as `enrolled` on this
   * interface pairs with `"not_enrolled"` there.
   */
  overLimit: boolean;
  /**
   * Its owner is banned, so it is switched off until an admin lifts that.
   *
   * Beside `overLimit` rather than merged with it, for the reason the wire type
   * gives: both switch a machine off and the *remedies* differ, so a row that
   * could not tell them apart would name the wrong one.
   */
  ownerDisabled: boolean;
  scopes: Scope[];
  route: Route | null;
  reach: Reach;
  offlineReason: OfflineReason;
  /** The control plane is unreachable and we are running on a token it already gave us. */
  tokenDegraded: boolean;
  tokenExpiresAt: number | null;
  health: DaemonHealth | null;
  lastError: string | null;
}

/**
 * May this request be sent a second time after a transport failure?
 *
 * `GET` and `DELETE` only, and by whitelist rather than by excluding `POST`: an
 * absent method is `GET`, and a method nobody has thought about yet should be
 * treated as unsafe rather than inherit a retry by default. `DELETE` is here
 * because the daemon's are idempotent — stopping an already-stopped session or
 * removing an already-removed workspace answers the same way twice.
 *
 * The mutating routes in this client are `POST` and `PUT`: creating a session,
 * sending a prompt, answering a permission, making a directory, and `PUT
 * /agent-auth/:agent` to store a credential. Answering a permission happens to be
 * safe on its own (the registry's compare-and-swap plus the `repeat` 409 absorb
 * it), and so does the `PUT`, which is an upsert — but both are properties of the
 * daemon rather than of the retry, and creating a session and sending a prompt
 * are not safe at all. The whitelist is what makes that distinction unnecessary
 * to get right per route.
 */
function isReplayable(method: string | undefined): boolean {
  const verb = (method ?? "GET").toUpperCase();
  return verb === "GET" || verb === "DELETE";
}

export class MachineConnection {
  readonly id: MachineId;
  private name: string;
  private relayUrl: string | null;
  private relayOnline: boolean;
  private enrolled: boolean;
  private lastSeenAt: number | null | undefined;
  private owned: boolean;
  private overLimit: boolean;
  private ownerDisabled: boolean;
  private scopes: Scope[];

  private token: { value: string; expiresAt: number } | null = null;
  private minting: Promise<string> | null = null;
  private chosen: Route | null = null;
  private resolving: Promise<Route | null> | null = null;

  private reach: Reach = "unknown";
  private offlineReason: OfflineReason = null;
  private tokenDegraded = false;
  private health: DaemonHealth | null = null;
  private lastError: string | null = null;

  private readonly onChange: () => void;

  constructor(record: MachineRecord, onChange: () => void) {
    this.id = record.id as MachineId;
    this.name = record.name;
    this.relayUrl = record.relayUrl;
    this.relayOnline = record.relayOnline;
    this.enrolled = record.enrolled;
    this.lastSeenAt = record.lastSeenAt;
    // Absent from an older control plane, which means nothing is owned — the
    // honest degradation, since the routes that act on ownership would 404 there.
    this.owned = record.owned === true;
    // Same degradation, opposite polarity, same reason: absent means "not
    // suspended", which is true of a control plane that has no such concept.
    this.overLimit = record.overLimit === true;
    this.ownerDisabled = record.ownerDisabled === true;
    this.scopes = record.scopes;
    this.onChange = onChange;
  }

  /** Fold in a fresh registry row without discarding the token or the route memo. */
  update(record: MachineRecord): void {
    this.name = record.name;
    this.relayUrl = record.relayUrl;
    this.relayOnline = record.relayOnline;
    this.enrolled = record.enrolled;
    this.lastSeenAt = record.lastSeenAt;
    this.owned = record.owned === true;
    /*
     * **The transition, which is the part that is easy to miss.**
     *
     * Going over: a token already in hand is worthless, because it is the
     * *relay* that refuses — so keeping it would leave this machine reading
     * `online` on a memoised route until the token expired, minutes after it
     * stopped working. The route memo goes with it, since the tunnel is refused
     * at dial and the daemon is no longer there to reach.
     *
     * Coming back under: `reach` has to go back to `unknown` or the next resume
     * reports "over the machine limit" about a machine the admin has already
     * fixed, until something else happens to re-probe it.
     */
    const was = this.switchedOff();
    this.overLimit = record.overLimit === true;
    this.ownerDisabled = record.ownerDisabled === true;
    const now = this.switchedOff();
    if (now && !was) {
      this.token = null;
      this.chosen = null;
    }
    if (!now && was) {
      this.reach = "unknown";
      this.offlineReason = null;
      this.lastError = null;
    }
    this.scopes = record.scopes;
    this.onChange();
  }

  state(): MachineState {
    return {
      id: this.id,
      name: this.name,
      relayUrl: this.relayUrl,
      relayOnline: this.relayOnline,
      enrolled: this.enrolled,
      lastSeenAt: this.lastSeenAt,
      owned: this.owned,
      overLimit: this.overLimit,
      ownerDisabled: this.ownerDisabled,
      scopes: this.scopes,
      route: this.chosen,
      reach: this.reach,
      offlineReason: this.offlineReason,
      tokenDegraded: this.tokenDegraded,
      tokenExpiresAt: this.token?.expiresAt ?? null,
      health: this.health,
      lastError: this.lastError,
    };
  }

  /* ---------------------------------------------------------------- *
   * Tokens
   * ---------------------------------------------------------------- */

  /**
   * The current token, minting or renewing if it is close to expiry.
   *
   * Concurrent callers share one in-flight mint. Without that, waking with three
   * streams on this machine fires three `POST /v1/tokens` in the same tick and
   * two of the resulting tokens are discarded — which is wasteful on a phone and,
   * worse, makes `expiresAt` briefly disagree with the token the sockets are
   * actually holding.
   */
  async ensureToken(force = false): Promise<string> {
    /*
     * **One guard covers both the mint and the probe.**
     *
     * `POST /v1/tokens` answers 403 for a machine over its owner's limit, and
     * the relay refuses it again, so every round trip below is one that cannot
     * succeed — per machine, per wake, for as long as the state lasts.
     * `probeRoute` calls this and its catch already returns null with "the mint
     * has recorded why", and `prepare()` throws `503 unreachable` before any
     * fetch, so short-circuiting here is the whole of not spending them.
     *
     * The reason is set here rather than left to the caller because this is the
     * only place that knows the difference between "could not reach it" and "may
     * not have it".
     */
    if (this.switchedOff()) {
      this.token = null;
      this.reach = "offline";
      this.offlineReason = this.ownerDisabled ? "owner_disabled" : "over_limit";
      this.onChange();
      throw this.ownerDisabled
        ? new ApiError(403, "owner_disabled", `${this.name} belongs to a disabled user`)
        : new ApiError(403, "machine_over_limit", `${this.name} is over the machine limit`);
    }
    const held = this.token;
    if (!force && held !== null && Date.now() < held.expiresAt - TOKEN_RENEW_MARGIN_MS) {
      return held.value;
    }
    this.minting ??= this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  tokenExpiresAt(): number | null {
    return this.token?.expiresAt ?? null;
  }

  /**
   * The control plane has switched this machine off, for either of its reasons.
   *
   * One predicate because every *mechanical* consequence is identical — no
   * token, no probe, no route memo — while the two are kept apart everywhere a
   * person reads them, because the remedies differ.
   */
  private switchedOff(): boolean {
    return this.overLimit || this.ownerDisabled;
  }

  private async mint(): Promise<string> {
    let issued;
    try {
      issued = await mintToken(this.id);
    } catch (error) {
      /*
       * The one outage that must not stop anything.
       *
       * A control plane that cannot be reached has not revoked anybody — it is
       * simply down, and the daemon, the agent and the session are all fine. If
       * a token we already hold is still valid, the correct behaviour is to keep
       * working and say so, not to fail a UI that has everything it needs.
       *
       * Only a *transport* failure qualifies. A 403 or a 404 is the control
       * plane answering, and an answer is not an outage.
       */
      const held = this.token;
      if (isTransportFailure(error) && held !== null && Date.now() < held.expiresAt) {
        this.tokenDegraded = true;
        this.onChange();
        return held.value;
      }
      this.token = null;
      this.reach = "offline";
      this.offlineReason = isTransportFailure(error) ? "cp_unreachable" : "no_token";
      this.lastError = describe(error);
      this.onChange();
      throw error;
    }

    /*
     * The deadline, translated onto *this* device's clock.
     *
     * `issued.expiresAt` is an absolute instant on the control plane's clock, and
     * every comparison in this file is against `Date.now()` on a phone. A phone's
     * clock drifts, and the failure is silent in both directions: fast by more
     * than the margin and every `ensureToken` mints a fresh token because the held
     * one always looks stale; fast by more than the whole lifetime and
     * `cachedToken()` returns `null` for a token the daemon would happily accept.
     * Slow, and rotation is scheduled after the daemon has already closed the
     * socket at `exp + leeway`, so the stream flaps instead of rotating.
     *
     * `serverTime` is on the response for exactly this reason — the same reason
     * `/health` carries `time` unauthenticated and the daemon returns `skewMs` in
     * a 401. It was the one part of that machinery nothing read. Subtracting it
     * converts the server's absolute deadline into a *duration*, which is the only
     * part both clocks agree on, and adds it to local now.
     *
     * Falls back to the raw value if an older control plane omits `serverTime`;
     * that is the previous behaviour, not a new risk.
     */
    const lifetimeMs =
      typeof issued.serverTime === "number" ? issued.expiresAt - issued.serverTime : issued.expiresAt - Date.now();
    this.token = { value: issued.token, expiresAt: Date.now() + lifetimeMs };
    this.tokenDegraded = false;
    this.lastError = null;

    // The registry telling us where the machine is, on the same call that proves
    // we may reach it. Kept in step by construction rather than by a second fetch.
    this.relayUrl = issued.machine.relayUrl;
    this.relayOnline = issued.machine.relayOnline;

    this.onChange();
    return issued.token;
  }

  /* ---------------------------------------------------------------- *
   * Routing
   * ---------------------------------------------------------------- */

  /**
   * Forget what we last believed about reachability, so the next resolve re-asks.
   *
   * This used to drop a memoised *route* and re-probe two candidates. There is
   * one route, so what it drops is the belief that the machine is up — which is
   * still worth having, because the relay reports a machine with no tunnel as a
   * `503` and it comes back on its own the moment the daemon re-dials.
   *
   * **Never called on an HTTP status other than that one.** A 401, a 404 or a 403
   * means the request arrived and the daemon answered; treating those as
   * unreachable would flap the whole screen on an ordinary application error.
   */
  forgetRoute(): void {
    if (this.chosen === null) return;
    this.chosen = null;
    this.onChange();
  }

  /**
   * Re-ask the control plane *where* this machine is, not just whether it is up.
   *
   * `forgetRoute` drops the belief that the machine is reachable and nothing
   * else — in particular it keeps the token, and `relayUrl` only ever moves
   * inside `mint()`. With one relay that is complete, because the answer cannot
   * change. With two it is not: a daemon that redials lands on whichever relay
   * the shared name fronts, `relayUrlFor` starts answering with the *other*
   * relay's URL, and the copy held here is stale until the token happens to need
   * renewing.
   *
   * What that cost, measured against the constants: `ensureToken()` returns the
   * held token while it is more than `TOKEN_RENEW_MARGIN_MS` from expiry, so with
   * a 300s lifetime the refresh is up to 210s away. `probeRoute` reads
   * `this.relayUrl` and therefore re-probes the relay that has already said it
   * does not hold this machine, and `store.ts`'s offline retry re-runs that same
   * losing probe every 15s. So the documented recovery — "the client drops its
   * route belief on that code and re-probes" — is true of an *unmapped* fleet,
   * where every probe is a fresh coin flip through the load balancer, and false
   * of a correctly mapped one, where the client is pinned to the wrong relay.
   * A wake repairs it (`GET /v1/machines` in `runResume` assigns `relayUrl`), so
   * a phone recovers on tab focus and a desktop left alone does not.
   *
   * `POST /v1/tokens` answers with the token *and* the machine's current route,
   * which is what `mint` already relies on — "kept in step by construction rather
   * than by a second fetch". Forcing one is therefore the whole repair.
   *
   * Deliberately **not** inside `forgetRoute`, which is also called on every
   * transport failure: a phone on flaky LTE would then mint a token per dropped
   * request, against the one service whose outage this client is built to
   * survive. This fires only where the relay has *answered* `no_tunnel`, i.e.
   * where "somewhere else, or nowhere" is exactly the question.
   *
   * Fire-and-forget, and it must be: the caller is a `catch` about to rethrow the
   * error the request actually failed with, and awaiting here would either delay
   * that throw or replace it with a mint failure. The refusal paths already
   * record themselves — `mint` sets `offlineReason` and `lastError`, and
   * `ensureToken` throws outright for a machine switched off — so there is
   * nothing to report from here that is not already on the state.
   */
  private refetchRoute(): void {
    void this.ensureToken(true).catch(() => {
      // Recorded by `mint`/`ensureToken` on the way past; this is the next
      // probe's problem, not this request's.
    });
  }

  currentRoute(): Route | null {
    return this.chosen;
  }

  async resolveRoute(): Promise<Route | null> {
    if (this.chosen !== null) return this.chosen;
    this.resolving ??= this.probeRoute().finally(() => {
      this.resolving = null;
    });
    return this.resolving;
  }

  /**
   * Confirm the machine is up, which is now one question with one answer.
   *
   * The probe is authenticated, and always was on this path: the relay checks
   * every request including `/health`, and an unauthenticated one would be a free
   * oracle for which machines in the fleet are online.
   */
  private async probeRoute(): Promise<Route | null> {
    if (!this.enrolled) {
      this.reach = "offline";
      this.offlineReason = "not_enrolled";
      this.onChange();
      return null;
    }

    /*
     * **A re-probe of a machine already believed reachable does not erase that
     * belief**, and this line used to.
     *
     * `probing` means "no answer yet". `resumeMachine` calls `forgetRoute()` on
     * every wake — correctly, because a route learned on one network says nothing
     * on another — so a healthy machine came through here on every tab switch and
     * published `online → probing → online`, up to 1.5s apart. Everything keyed on
     * `reach` changed twice for a question whose answer never changed: the dot on
     * every machine row went hollow and back, and the agents panel unmounted and
     * remounted, restarting `useAgentAuth` from nothing and throwing away whatever
     * was half-typed into it.
     *
     * The knowledge is still there while it is being re-checked, so it is kept.
     * `unknown` remains the value for never having asked, and a probe that fails
     * still lands on `offline` below — the only thing given up is announcing the
     * question, which nothing on screen was better for.
     */
    if (this.reach !== "online") this.reach = "probing";
    this.offlineReason = null;
    this.onChange();

    let token: string;
    try {
      token = await this.ensureToken();
    } catch {
      // `mint` has already recorded why and notified.
      return null;
    }

    // `relayOnline` comes from the registry row and is what the control plane
    // last saw; the probe is what this client can see. Both have to hold.
    const relay = this.relayOnline ? this.relayUrl : null;
    if (relay === null) return this.settleRoute(null, "no_route");

    const health = await this.probe(relay, token);
    if (health === null) return this.settleRoute(null, "no_route");
    this.health = health;
    return this.settleRoute({ base: relay }, null);
  }

  private settleRoute(route: Route | null, reason: OfflineReason): Route | null {
    this.chosen = route;
    this.reach = route === null ? "offline" : "online";
    this.offlineReason = route === null ? reason : null;
    if (route !== null) this.lastError = null;
    this.onChange();
    return route;
  }

  private async probe(base: string, token: string | null): Promise<DaemonHealth | null> {
    try {
      const response = await fetch(new URL("/health", base), {
        signal: withTimeout(PROBE_TIMEOUT_MS),
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      return (await response.json()) as DaemonHealth;
    } catch {
      // Unreachable, refused, blocked or too slow. All the same answer here.
      return null;
    }
  }

  /* ---------------------------------------------------------------- *
   * Requests
   * ---------------------------------------------------------------- */

  /**
   * An authenticated request to this daemon, on whichever path is live.
   *
   * Two retries are possible and they share one guard, because "have we already
   * retried" is one fact rather than two: a route that failed and a token that
   * expired are different causes with the same budget.
   */
  async request<T>(path: string, init: RequestInit = {}, firstAttempt = true): Promise<T> {
    const { route, token } = await this.prepare();
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const contentType = contentTypeFor(init.body);
    if (contentType !== null) headers["content-type"] = contentType;

    const timeout = slowRoute(init.method, path) ? SLOW_ROUTE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const retry = (): Promise<T> => this.request<T>(path, init, false);

    let response: Response;
    try {
      response = await fetch(new URL(path, route.base), {
        ...init,
        headers,
        signal: withTimeout(timeout, init.signal ?? undefined),
      });
    } catch (error) {
      return this.settleTransport(error, isReplayable(init.method), firstAttempt, retry);
    }

    return this.settleAnswer<T>(
      response.status,
      response.statusText,
      await response.text(),
      firstAttempt,
      retry,
    );
  }

  /**
   * Everything a request needs before it can be sent, or a refusal.
   *
   * Extracted so `upload` and `download` cannot grow their own version of it —
   * see `settleAnswer` for why sharing these three matters more than it looks.
   */
  private async prepare(): Promise<{ route: Route; token: string }> {
    const route = await this.resolveRoute();
    if (route === null) {
      throw new ApiError(503, "unreachable", `${this.name} is not reachable`, {
        reason: this.offlineReason,
      });
    }
    return { route, token: await this.ensureToken() };
  }

  /**
   * What a *transport* failure means, and whether to try once more.
   *
   * Always either retries or throws, so a caller's `catch` arm ends here.
   */
  private async settleTransport<T>(
    error: unknown,
    replayable: boolean,
    firstAttempt: boolean,
    retry: () => Promise<T>,
  ): Promise<T> {
    /*
     * The route stopped answering. Forget it and try once more, which turns
     * "my network changed" into one slow request rather than a dead screen:
     * the re-probe re-establishes whether the tunnel is up, so a phone that
     * comes back onto a working network recovers on the next request rather
     * than on the next poll.
     */
    /*
     * Only for a request it is safe to send twice.
     *
     * A transport failure says nothing about whether the daemon *acted*. The
     * timeout that most often lands here is our own `AbortSignal.timeout`, and
     * the ordinary way to earn it is a phone dropping to LTE — long after the
     * daemon accepted the request, appended the event and started the turn.
     * Replaying the identical body then runs the prompt a second time, or, on
     * `POST /sessions`, creates a second session with a second worktree and a
     * second agent subprocess for one tap.
     *
     * An upload lands on the same rule by the same whitelist, and it is worth
     * knowing that the arithmetic there is different: a replay is a second
     * 25 MiB copy under a second `uploadId`, referenced by no prompt, spending
     * the session's storage budget twice with the first copy orphaned until the
     * daemon's sweep finds it. Same verdict, different reason — which is why
     * this is not the place to add an idempotency key.
     *
     * So the route-change retry is gated on the methods that can be repeated
     * without consequence. A mutating request reports the failure instead and
     * lets a person decide — the route memo is still dropped either way, so the
     * *next* request lands on the path that works.
     *
     * The `token_expired` retry in `settleAnswer` is different and stays
     * unconditional: a parsed `ApiError` is proof the daemon refused the request
     * rather than performed it.
     */
    if (firstAttempt && replayable) {
      this.forgetRoute();
      const next = await this.resolveRoute();
      if (next !== null) return retry();
    } else if (firstAttempt) {
      this.forgetRoute();
    }
    this.markUnreachable("no_route", describe(error));
    throw error;
  }

  /**
   * What an *answered* request means.
   *
   * Takes a status and a body string rather than a `Response`, because an upload
   * runs on `XMLHttpRequest` — `fetch` reports no upload progress — and there is
   * no `Response` there to hand over. This is the single place three rules live:
   * the `409`-carrying-a-success-body parse (in `parseBody`), the reach flip back
   * to online, and `meansMachineGone`. A second copy of the last one renders a
   * machine as up while every request under it fails, which is the exact defect
   * the comment below records.
   */
  private async settleAnswer<T>(
    status: number,
    statusText: string,
    text: string,
    firstAttempt: boolean,
    retry: () => Promise<T>,
  ): Promise<T> {
    try {
      const body = parseBody<T>(status, statusText, text);
      if (this.reach !== "online") {
        this.reach = "online";
        this.offlineReason = null;
        this.onChange();
      }
      return body;
    } catch (error) {
      if (firstAttempt && ApiError.isApiError(error) && error.code === "token_expired") {
        await this.ensureToken(true);
        return retry();
      }
      /*
       * **`no_tunnel` is the one HTTP answer that means the machine is gone, and
       * nothing was reading it.** `forgetRoute`'s own doc says it is called on
       * exactly this status and on no other; that call site did not exist. A
       * daemon that stops, or loses its tunnel, answers every request through the
       * relay with this — and since a parsed `ApiError` never reached the
       * transport `catch`, `chosen` stayed memoised and `reach` stayed
       * `"online"`. `store.ts`'s poll then re-probes only machines already marked
       * offline, so the row rendered as up, indefinitely, while every request
       * under it failed. The socket close path recovered it, but only for a
       * session actually being streamed.
       *
       * **Keyed on the code, never on the status.** The daemon answers its own
       * `503 unresponsive` when a browse path sits on a stalled mount, and that
       * is the daemon talking — reading it as "machine unreachable" would black
       * out a healthy machine because one directory did not answer.
       */
      if (meansMachineGone(error)) {
        this.forgetRoute();
        this.markUnreachable("no_route", (error as ApiError).message);
        this.refetchRoute();
      }
      throw error;
    }
  }

  /**
   * Send a file, reporting progress.
   *
   * `XMLHttpRequest` rather than `fetch`, and not by preference: `fetch` exposes
   * no upload progress at all, and a `ReadableStream` request body — which would
   * let the bytes be counted as they go — is Chromium-only, so it does not exist
   * on the phone this client is shaped around. What it is *not* is a second
   * transport: route resolution, token minting, `meansMachineGone` and the
   * unreachable bookkeeping all run through the same three helpers above.
   *
   * Only the caller's own abort is a cancel. It must not be reported as a
   * transport failure and must not mark the machine unreachable — somebody
   * removing a chip is not a network event.
   */
  async upload<T>(
    path: string,
    file: Blob,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
    firstAttempt = true,
  ): Promise<T> {
    const { route, token } = await this.prepare();
    const { stallMs, hardMs } = uploadDeadlines(file.size);
    const retry = (): Promise<T> => this.upload<T>(path, file, onProgress, signal, false);

    let answer: { status: number; statusText: string; text: string };
    try {
      answer = await sendWithProgress(new URL(path, route.base), file, token, onProgress, {
        stallMs,
        hardMs,
        signal,
      });
    } catch (error) {
      // The caller asked for this. Not a network fact, so nothing is recorded.
      if (signal.aborted) throw error;
      return this.settleTransport(error, isReplayable("POST"), firstAttempt, retry);
    }

    return this.settleAnswer<T>(answer.status, answer.statusText, answer.text, firstAttempt, retry);
  }

  /**
   * Fetch bytes rather than JSON.
   *
   * `request` cannot serve this as `request<Blob>`: it consumes the body as text
   * and would hand 25 MiB of PNG to `JSON.parse`, then report a perfectly good
   * file as a malformed answer. The asymmetry is the point — **the error path is
   * text and the success path is bytes** — so the failure branch goes through
   * `settleAnswer` (which always throws for a non-2xx) and the success branch
   * never touches it.
   *
   * A `GET`, so `isReplayable` says yes and the route-change retry applies for
   * free. Nothing special was needed for that and nothing should be added.
   */
  async download(path: string, firstAttempt = true): Promise<Blob> {
    const { route, token } = await this.prepare();
    const retry = (): Promise<Blob> => this.download(path, false);

    let response: Response;
    try {
      response = await fetch(new URL(path, route.base), {
        headers: { authorization: `Bearer ${token}` },
        signal: withTimeout(TRANSFER_TIMEOUT_MS),
      });
    } catch (error) {
      return this.settleTransport(error, isReplayable("GET"), firstAttempt, retry);
    }

    if (!response.ok) {
      // Always throws — `parseBody` refuses every non-2xx. Typed as `Blob` only
      // so the two branches agree; nothing downstream sees this value.
      return this.settleAnswer<Blob>(
        response.status,
        response.statusText,
        await response.text(),
        firstAttempt,
        retry,
      );
    }

    // Read the length *before* the body, so an oversized file is refused rather
    // than resident. Safelisted cross-origin; `content-disposition` is not.
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new ApiError(413, "file_too_large", "that file is too large to download here", {
        bytes: declared,
        limit: MAX_DOWNLOAD_BYTES,
      });
    }

    if (this.reach !== "online") {
      this.reach = "online";
      this.offlineReason = null;
      this.onChange();
    }
    return response.blob();
  }

  /**
   * The WebSocket URL for a session's stream.
   *
   * The token rides as a query parameter because a browser cannot set headers on
   * a WebSocket handshake. Both the daemon's `readCredential` and the relay's
   * `readToken` accept it there, and the relay forwards the query string verbatim
   * down the tunnel — so the same URL shape works on both paths, which is why
   * nothing about relaying needed a special case.
   *
   * **This is the whole of the exception and it must not grow.** A download is
   * the obvious next candidate and it is refused: `download()` above sends the
   * credential in a header, because there a browser *can*. A `?token=` URL sitting
   * in transcript DOM also goes stale inside the 300s token lifetime, and lands
   * in history and in any log that records a URL rather than a path.
   */
  streamUrl(session: string, since: number, token: string, route: Route): string {
    const url = new URL(`/sessions/${encodeURIComponent(session)}/stream`, route.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("since", String(since));
    url.searchParams.set("token", token);
    return url.toString();
  }

  markUnreachable(reason: OfflineReason, detail: string | null = null): void {
    this.reach = "offline";
    this.offlineReason = reason;
    if (detail !== null) this.lastError = detail;
    this.onChange();
  }
}

/**
 * One `XMLHttpRequest`, wrapped into a promise, with a stall budget.
 *
 * Free of `MachineConnection` on purpose: everything policy-shaped — what a
 * failure means, whether to retry, whether the machine is gone — belongs to the
 * three helpers above, and this is only the part of an upload that `fetch`
 * cannot do.
 */
function sendWithProgress(
  url: URL,
  body: Blob,
  token: string,
  onProgress: (fraction: number) => void,
  bounds: { stallMs: number; hardMs: number; signal: AbortSignal },
): Promise<{ status: number; statusText: string; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stall: ReturnType<typeof setTimeout> | undefined;

    const fail = (reason: string): void => {
      clear();
      xhr.abort();
      reject(new TypeError(reason));
    };
    const hard = setTimeout(() => fail("upload timed out"), bounds.hardMs);
    const touch = (): void => {
      clearTimeout(stall);
      stall = setTimeout(() => fail("upload stalled"), bounds.stallMs);
    };
    const onAbort = (): void => {
      clear();
      xhr.abort();
      reject(new DOMException("upload cancelled", "AbortError"));
    };
    function clear(): void {
      clearTimeout(hard);
      clearTimeout(stall);
      bounds.signal.removeEventListener("abort", onAbort);
    }

    if (bounds.signal.aborted) {
      clearTimeout(hard);
      reject(new DOMException("upload cancelled", "AbortError"));
      return;
    }
    bounds.signal.addEventListener("abort", onAbort);

    xhr.open("POST", url.toString(), true);
    xhr.setRequestHeader("authorization", `Bearer ${token}`);
    // Deliberately explicit rather than left to the browser: a `Blob` with a
    // type would otherwise set the header itself, and the daemon reads the mime
    // from exactly here.
    xhr.setRequestHeader("content-type", body.type || "application/octet-stream");

    xhr.upload.addEventListener("progress", (event) => {
      touch();
      onProgress(event.lengthComputable && event.total > 0 ? event.loaded / event.total : 0);
    });
    // A request that has been sent and is awaiting an answer is not stalled — the
    // daemon may be writing 25 MiB to disk. The stall budget covers the upload.
    xhr.upload.addEventListener("load", () => clearTimeout(stall));
    xhr.addEventListener("load", () => {
      clear();
      resolve({ status: xhr.status, statusText: xhr.statusText, text: xhr.responseText });
    });
    // Indistinguishable from each other and from a `fetch` rejection, which is
    // exactly what `isTransportFailure` assumes: not an `ApiError`.
    xhr.addEventListener("error", () => fail("upload failed"));
    xhr.addEventListener("timeout", () => fail("upload timed out"));

    touch();
    xhr.send(body);
  });
}

/**
 * Calls whose deadline has to sit above a daemon-side budget.
 *
 * Was called `spawnsAnAgent`, and the rename stands — but not for the reason
 * this docblock used to give. It said "a download spawns nothing and still
 * belongs here", and no download path is in the predicate below: `download()`
 * never calls `request()` at all, and carries `TRANSFER_TIMEOUT_MS` itself. So
 * the sentence justifying the rename was the exact thing its last line warns
 * against, which is why it is corrected here rather than left to be discovered.
 *
 * What is true: every entry below does spawn a process on the daemon, and the
 * name is now about the *deadline* rather than the cause, because transfers are
 * bounded separately — `TRANSFER_TIMEOUT_MS` for a download, `uploadDeadlines`
 * for an upload — and this table only governs routes reached through `request`.
 *
 * A helper whose name claims a property nobody enforces is how the property gets
 * restored by somebody who believes it is still true.
 */
export function slowRoute(method: string | undefined, path: string): boolean {
  const verb = (method ?? "GET").toUpperCase();
  return (
    (verb === "POST" && path === "/sessions") ||
    /*
     * A prompt, because sending one to a session the daemon interrupted resumes
     * it first — the whole point of "you just go on talking after a deploy".
     *
     * **Unconditionally**, for every prompt, and that is not laziness. `request`
     * is handed a method and a path and nothing else, deliberately: a deadline
     * that depended on session state would be state leaking into the transport,
     * and the transport is the one layer that must not need to know which
     * sessions are alive. The asymmetry pays for it — a deadline that is too
     * long costs a spinner nobody was watching, while one that is too short is a
     * transport failure, and a transport failure here drops the route memo and
     * renders a healthy machine "not reachable" over the message somebody just
     * typed.
     *
     * Safe against the other failure this table guards: `isReplayable` is
     * GET/DELETE only, so a prompt that times out is never resent and cannot
     * start two turns.
     */
    (verb === "POST" && /^\/sessions\/[^/]+\/prompt$/.test(path)) ||
    // Resume is the same launch underneath, and `server.ts` says so — the
    // daemon gives it the full 45s start budget, and this asked for it at 15s.
    // The abort is a *transport* failure, so it dropped the route memo and
    // marked a perfectly healthy machine unreachable for the crime of resuming.
    (verb === "POST" && /^\/sessions\/[^/]+\/resume$/.test(path)) ||
    // Changing model rebuilds the agent's available modes, and the daemon
    // allows itself 15s for that — the *same* number this client used, so the
    // client's own abort always fired first and the daemon's
    // `502 agent_config_failed` was unreachable by construction. A client
    // deadline has to sit above the server's, or the server's error is dead code.
    (verb === "POST" && /^\/sessions\/[^/]+\/config$/.test(path)) ||
    // Both spawn a CLI: `/agents` runs the login probe, and `/agent-auth`
    // drives a login under a pty.
    (verb === "GET" && path === "/agents") ||
    path.startsWith("/agent-auth")
  );
}

export function describe(error: unknown): string {
  if (ApiError.isApiError(error)) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
