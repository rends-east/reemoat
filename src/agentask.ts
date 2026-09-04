/* ──────────────────────────────────────────────────────────────────────────
 * Asking an agent one question, and taking the text back.
 *
 * ⚠ **This is the "invisible turn" `docs/DECISIONS.md` Q7.27 recorded as not
 * existing, and the entry's own reasoning is why it is shaped like this.** That
 * question — *could the daemon just ask an agent for its usage?* — was refused
 * because asking means sending a prompt, a prompt takes the session's one turn,
 * and the reply lands in a transcript nobody asked for. Every word of that is
 * about an **existing** session. What was missing, and what this file is, is a
 * turn that belongs to no session at all.
 *
 * ⚠ **It is deliberately not a `ManagedSession`, and that single fact is what
 * makes it safe rather than a pile of exclusions.** A long design pass had this
 * living in `SessionRegistry` with a `hidden` flag, and every consumer of
 * `list()`, `get()` and `announce()` subtracting it. Three separate enumerations
 * of "who would see it" produced three different blind spots, and the last one
 * was a genuine unbounded recursion: the plugin host observes every session that
 * arrives in the registry, so a hidden session's `turn_end` fanned `turn.ended`
 * back to the very plugin that had asked for it, which asked again. Bounded only
 * by `MAX_LIVE_SESSIONS`, i.e. by a machine on which nobody can start a session.
 *
 * `Session` never depended on the registry — `harness.ts` and the offline drivers
 * already drive it standalone — so a bare one has no row, no `SessionLog`, no
 * worktree, no observers and no id anybody can address. There is nothing to
 * subtract from anything. `waitingFloor`'s argument in `web-shell.md` is the same
 * shape and points the same way: a rule enforced by subtracting from N views is a
 * rule the next view breaks by existing.
 *
 * What that costs, and it is the whole cost: **the agent process is reachable by
 * `shutdown()` here and by nothing after a crash.** `AgentLoginRuns` accepts the
 * identical exposure for the identical reason and is the precedent this file
 * follows down to the `starting` set. The exposure is bounded by two numbers
 * rather than argued away — at most {@link MAX_CONCURRENT_ASKS} at a time, each
 * for at most {@link ASK_TIMEOUT_MS} — so the worst case is two agent processes
 * outliving a daemon that was SIGKILLed inside a two-minute window.
 * ────────────────────────────────────────────────────────────────────────── */

import type { AgentId } from "./acp/agents.js";
import type { AgentRouting } from "./acp/systems.js";
import type { AgentConfigOption } from "./events.js";
import type { AgentCliChoice, SessionRuntime } from "./runtime/types.js";
import { isAuthRequiredMessage, Session } from "./session.js";

/** The most a caller may send. Their prompt, not a conversation. */
export const MAX_ASK_PROMPT_BYTES = 8 * 1024;

/**
 * The most this will read back, charged **as it arrives** rather than at the end.
 *
 * The same discipline `readBounded` and `unpackArchive` keep, and for the same
 * reason: a ceiling tested after the body is whole is not a ceiling. An agent
 * that answers a request for a title with sixteen kilobytes has misunderstood the
 * question, and a truncated answer would be a worse title than none — so this
 * refuses rather than clipping.
 */
export const MAX_ASK_OUTPUT_BYTES = 16 * 1024;

/**
 * The wall clock on the whole thing.
 *
 * ⚠ **A stopwatch on everything, because the parts are bounded and the sum is
 * not.** `Session.start` bounds its handshake (30 s) and its `session/new`
 * (60 s) separately, and `Session.prompt` has **no end-to-end bound at all** — an
 * agent that streams for ever parks the caller for ever.
 *
 * ⚠ **It is twelve times the deadline this thing's only caller has, and the gap
 * is what to remember rather than the number.** That caller is a plugin, and a
 * plugin is asked something with `PLUGIN_INVOKE_TIMEOUT_MS` — 10 s — to answer in.
 * So a plugin that *awaits* this inside its invocation is timed out by its own
 * host long before this expires, three of those stopping it altogether, and for
 * the remaining 110 seconds this held an agent subprocess and one of the two
 * slots this machine allows for a caller that had gone. That is what the `signal`
 * on {@link AgentAskRuns.ask} is for. `docs/PLUGINS.md` prints the two numbers in
 * one paragraph for the same reason.
 *
 * Two minutes covers a cold spawn plus a short turn. It is not generous; it is
 * the sum of the two starts already allowed, plus room to answer.
 */
export const ASK_TIMEOUT_MS = 120_000;

/**
 * How many of these may run at once, for the whole daemon.
 *
 * ⚠ **Two, and the number is small because each one spawns a process.** The
 * comparison worth making is `net.fetch`, which allows thirty a minute — that is
 * thirty *requests*. This is an agent: a node subprocess, an ACP handshake and a
 * model turn. A caller that mistook the two would take the host down while
 * staying inside a limit that looked similar.
 *
 * It is also the second half of the crash exposure this file's header names: the
 * most that can be orphaned by a SIGKILL is this many.
 */
export const MAX_CONCURRENT_ASKS = 2;

/**
 * How long a queued caller waits for a slot before being refused one.
 *
 * ⚠ **The daemon's own budget and never the caller's signal**, because the run a
 * waiter is about to start is shared: `capsInFlight` hands it to everyone who asks
 * for the same harness, so cancelling on one caller's abort would take an answer
 * away from callers that are still waiting for it. What a deadline can honestly do
 * is bound the *park*, and past it the answer is the refusal that was always there.
 *
 * Sized against what it queues behind: `Session.start` is bounded at 45 s and a
 * capability read disposes immediately after `session/new`, so two slots ahead of
 * you is at most ~90 s of honest work. This is longer than that on purpose — a
 * deadline that fires while the machine is genuinely making progress converts a
 * wait into the refusal it was added to remove.
 */
export const SLOT_WAIT_MS = 120_000;

/**
 * How long a model list is believed before it is read again.
 *
 * ⚠ **A ceiling on *staleness*, not a cache for speed.** Reading the list costs
 * an agent process and an ACP handshake, so it is not something to repeat per
 * settings pane — but the list changes when somebody updates a CLI, and a daemon
 * that runs for weeks would otherwise never notice. Ten minutes is short enough
 * that an update is picked up within one coffee and long enough that opening a
 * settings pane twice does not spawn twice.
 *
 * The two failures are deliberately asymmetric. A model that has *gone* is caught
 * at use: {@link AgentAskRuns.ask} validates against the agent's live answer, not
 * against this cache, so a stale choice is refused by name rather than sent. A
 * model that is *new* is invisible until this expires, which costs nothing but
 * waiting.
 */
export const MODELS_TTL_MS = 10 * 60_000;

/** How many model names a refusal lists before it stops counting. */
const MODEL_NAMES_IN_REFUSAL = 8;

/**
 * The agent's model control, or `null` where it publishes none.
 *
 * ⚠ **Found by `category`, never by `id`.** That is this fleet's standing rule
 * about every agent control and it is not a preference: claude calls reasoning
 * effort `effort` and kimi calls it `thinking`, so a client keying on ids renders
 * one agent's controls and none of the other's. The same holds for the model.
 */
function modelOptionOf(session: Session): AgentConfigOption | null {
  return session.modelOption;
}

/**
 * What a caller that has gone says, as a refusal a plugin can read.
 *
 * ⚠ **`model_cancelled` is its own code rather than `model_timeout`'s**, because
 * the two are different facts with different remedies: `model_timeout` is *the
 * agent took longer than two minutes*, and this is *whoever asked stopped
 * waiting* — which for a plugin means it awaited a model call inside a 10 s
 * invocation, or that somebody stopped, disabled, updated or removed it while one
 * was in flight. Sharing a code would send an author to look at the agent.
 *
 * The sentence is the abort's own reason, so the layer that gave up says why in
 * its own words. A bare `abort()` leaves the platform's `AbortError`, whose
 * message is true if uninformative; the fallback is for a reason that is not an
 * `Error` at all, since `abort(reason)` takes anything.
 */
function cancelled(signal: AbortSignal): AgentAskError {
  const reason: unknown = signal.reason;
  const detail =
    reason instanceof Error && reason.message.length > 0 ? reason.message : "nobody is waiting for this any more";
  return new AgentAskError("model_cancelled", detail);
}

/**
 * Give up here if the caller already has.
 *
 * ⚠ **A function rather than three copies of the test, and that is what keeps the
 * three *reads*.** `AbortSignal.aborted` is mutable and the whole point of asking
 * it more than once is that it changes between the asking — but the compiler's
 * control flow does not know that, and inlined it narrows the second test to
 * `false` off the first and refuses it. Writing it out here is both the honest
 * shape and the one that compiles.
 */
function stopIfGone(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) throw cancelled(signal);
}

/** Why an ask did not produce text. The code is what a caller branches on. */
export class AgentAskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentAskError";
  }
}

/** One model an agent says it can be asked to use. */
export interface AgentModelChoice {
  id: string;
  name: string;
  description: string | null;
  /** The heading the agent grouped this under, when it grouped them. */
  group: string | null;
}

/**
 * Everything one spawn can be asked about an agent, answered together.
 *
 * ⚠ **One trip, because the trip is the cost.** Reading either half means a node
 * subprocess plus an ACP handshake plus `session/new` — see {@link
 * AgentAskRuns.capabilities} — so splitting them into two methods would have
 * doubled the only expensive thing here to answer two questions the same screen
 * asks at the same moment.
 */
export interface AgentCapabilities {
  models: AgentModelChoice[];
  /** `null` where this agent cannot be pointed at another system at all. */
  routing: AgentRouting | null;
  /**
   * Which build of the harness's own CLI answered, or `null`.
   *
   * ⚠ **It rides this answer rather than `GET /agents` because it is a fact about
   * *this list*.** The models above are whatever that binary published, and the
   * two go stale together: a machine whose CLI stopped moving publishes a list
   * exactly that old, and the only symptom is a model somebody has read about
   * being absent. Reported off the same read, so the version on screen cannot
   * describe a different spawn than the rows under it.
   *
   * `null` for a harness with no binary to name. A daemon from before this field
   * sends no `cli` key at all, which is why the client's mirror keeps it optional:
   * `undefined` there is an older daemon, `null` is this sentence, and the two are
   * different facts about different things.
   */
  cli: AgentCliChoice | null;
}

/**
 * The one thing `server.ts` asks of this file.
 *
 * ⚠ **A port rather than the class, for `AgentCredentialStore`'s reason one
 * directory over.** `GET /agents/capabilities` and the compatibility check on
 * `POST /custom-agents` both need an agent spawned and read; nothing else about
 * `AgentAskRuns` — its prompt budget, its two-slot ceiling, its shutdown — is
 * theirs to know. Narrowing it is also what makes both routes drivable with no
 * agent on the machine running the driver: a stub satisfies this in four lines,
 * where standing in for the class would mean a subprocess.
 */
export interface AgentCapabilityReader {
  /**
   * `queue` asks to **wait** for a slot rather than be refused one.
   *
   * Opt-in per call rather than per method, because both kinds of caller reach
   * this: the capability sweep, which is one operation over every harness and has
   * no per-harness meaning to refuse, and a plugin's `model.list`, for which
   * `model_busy` is a published refusal it can report and a park would be a
   * timeout. See `admit`.
   */
  capabilities(agent: AgentId, signal?: AbortSignal, queue?: boolean): Promise<AgentCapabilities>;
}

export interface AgentAskAnswer {
  text: string;
  agent: AgentId;
}

export interface AgentAskOptions {
  runtime: SessionRuntime;
  /**
   * Where the agent is told it is working.
   *
   * ⚠ **An empty directory this daemon owns, and never a session's workspace.**
   * `session/new` requires a `cwd` and there is no such thing as "no directory",
   * so whatever goes here is where the agent may look. Handing it the initiating
   * session's tree would give a caller holding only the `model` scope an agent
   * reading somebody's working copy — a capability the consent screen for that
   * scope says nothing about, and could not honestly say anything about.
   */
  cwd: string;
  /** Overridable only by a driver; there is no environment variable. */
  timeoutMs?: number;
}

export class AgentAskRuns {
  private readonly live = new Set<Session>();
  /**
   * Asks that have been accepted but have not yet produced a `Session`.
   *
   * ⚠ **`AgentLoginRuns` records the same set for the same measured reason.** An
   * ask accepted moments before SIGTERM is still inside `Session.start` — which
   * resolves a binary off PATH, spawns a subprocess and completes an ACP
   * handshake — when `shutdown` drains `live`. Without waiting on these, it would
   * spawn *after* the drain and survive `process.exit(0)` with no successor
   * daemon aware of it: exactly the orphan this whole file is bounded to avoid.
   */
  private readonly starting = new Set<Promise<unknown>>();
  /**
   * What each agent last said its models were, and when.
   *
   * In memory and per daemon, like every other thing this file holds: it is a
   * fact about a CLI on this disk right now, and a stale row read off a restart
   * would be worse than the spawn it saved. See {@link MODELS_TTL_MS}.
   */
  private readonly models_ = new Map<AgentId, { at: number; answer: AgentCapabilities }>();
  /**
   * Bumped by {@link forget}, captured before the read, compared before the write.
   *
   * ⚠ **Without it `forget()` is undone by a read that was already in flight.**
   * The map is cleared synchronously, but `readCapabilities` awaits a real
   * handshake and a real `providers/list` and only then does `models_.set` — so a
   * sweep started before a plugin update completes after it and writes the
   * *pre-update* binary's answer back, freshly stamped, for the whole of
   * {@link MODELS_TTL_MS}. `probeContributed` runs immediately after
   * `syncContributions()` and joins `capsInFlight`, so the very probe meant to
   * exercise the new binary could be answered by the old one's cached reply.
   *
   * `LocalRuntime.probeGeneration` is the same counter for the same reason, and
   * its comment is the shorter version of this one.
   */
  private capsGeneration = 0;
  /**
   * The read already running for this harness, so N callers cost one spawn.
   *
   * ⚠ **A TTL cache without this collapses nothing on a cold start**, which is
   * the moment it matters: two clients opening the builder together, or one whose
   * `GET /agents/capabilities` was replayed by the transport, each spawn their own
   * agent for the same harness — and against `MAX_CONCURRENT_ASKS` of two, the
   * loser is refused `model_busy` and draws as a permanently disabled row.
   * `LocalRuntime.loginState` keeps exactly this map beside exactly this TTL, for
   * exactly this reason.
   */
  private readonly capsInFlight = new Map<AgentId, Promise<AgentCapabilities>>();
  private stopped = false;

  constructor(private readonly options: AgentAskOptions) {}

  /**
   * Slots taken by a caller that has passed the cap and has not yet reached
   * {@link starting}.
   *
   * ⚠ **The cap was a check-then-act across an `await` and therefore not a cap
   * at all.** {@link admit} tests `inFlight` *after* awaiting
   * `runtime.availability()` — a real probe that resolves a binary and asks each
   * agent whether it is signed in — and the run was not counted anywhere until
   * the caller reached `this.starting.add(started)` afterwards. So callers
   * arriving together all parked in `availability()`, all resumed, and all read
   * `inFlight` at the value it had before any of them had reserved anything.
   * Measured against the numbers that make it reachable: a plugin may hold 16
   * host calls at once and spend 6 model requests a minute, and `PluginApi.complete`
   * spends its token synchronously and then awaits — so six agent subprocesses
   * where this file documents two, which is both of the properties its header
   * rests on.
   *
   * Incremented inside `admit` with no `await` between the test and the
   * increment, and handed over to `starting` in the same tick by {@link claim},
   * which is `admit`'s only caller and the only place that hand-over is written
   * down. It double-counts for no turns of the loop at all, which is why the
   * handover is in a `finally` with nothing awaited inside the `try`.
   */
  private reserved = 0;

  /** How many are in flight, counting those reserved and those still starting. Feeds the cap. */
  get inFlight(): number {
    return this.live.size + this.starting.size + this.reserved;
  }

  /**
   * Callers parked on a slot rather than refused one — see {@link admit}.
   *
   * Woken by {@link freed}, which every path that lets {@link inFlight} fall must
   * call. A waiter that is woken **re-tests** the cap rather than assuming it, so
   * two of them waking on one release cannot both take the same slot.
   */
  private readonly waiting = new Set<() => void>();

  /**
   * A slot may have come free. Wakes everyone; the cap is what sorts them out.
   *
   * Called from the three places {@link inFlight} shrinks, and it has to be all
   * three: `reserved` falling in {@link claim}'s first `finally`, `starting`
   * losing a promise in its second, and `live` losing a session in
   * {@link release}. A missed one is a queue that never drains.
   */
  private freed(): void {
    if (this.waiting.size === 0) return;
    const woken = [...this.waiting];
    this.waiting.clear();
    for (const wake of woken) wake();
  }

  /**
   * One question, one answer, and nothing left behind.
   *
   * Throws {@link AgentAskError} for everything a caller can act on, because the
   * caller is a plugin whose own screen is the **only** place a refusal can
   * appear: the turn is fire-and-forget, so no invocation is waiting to fail; the
   * session is unaddressable, so no screen can be opened on it; and nothing is
   * written to any transcript. A refusal with no code is a refusal nobody can
   * report.
   *
   * ⚠ **`signal` is the caller saying it has gone, and it is not an
   * optimisation.** The caller is a plugin invocation with 10 s to answer against
   * the two minutes below; without this, a plugin that awaited this call was timed
   * out and then stopped by its own host while the agent it started ran on — up to
   * 110 seconds more, holding one of the two slots this whole machine allows, for
   * a plugin whose row, data and tree `remove` may since have deleted. Honoured at
   * three points, because there are three places this parks: before anything is
   * reserved, after the agent has started, and inside {@link collect}.
   *
   * ⚠ **It ends the *turn*, and it does not make a spawn free.** An abort landing
   * inside `admit`'s `runtime.availability()` or inside `Session.start` is not
   * interrupted — those are bounded by their own 30 s and 60 s — so the agent is
   * started and then disposed. What the signal buys is that nothing waits on it
   * afterwards, which is the exposure; it is not a claim that no process is ever
   * spawned for a caller who left.
   */
  async ask(agent: AgentId, prompt: string, model?: string, signal?: AbortSignal): Promise<AgentAskAnswer> {
    if (Buffer.byteLength(prompt, "utf8") > MAX_ASK_PROMPT_BYTES) {
      throw new AgentAskError("model_prompt_too_large", `a prompt may be at most ${MAX_ASK_PROMPT_BYTES} bytes`);
    }
    if (prompt.trim().length === 0) {
      throw new AgentAskError("model_prompt_empty", "there is nothing to ask");
    }
    /*
     * ⚠ **Three spellings of "I did not choose one", and they all mean the same
     * thing: the agent's own default.** Absent, `null` and `""` all arrive here
     * from shapes nobody controls — a field left out of a JSON body, a
     * `ctx.store.get` that has never been written, and a form submitting an
     * untouched control — and picking one of them as *the* spelling would make
     * the other two an error somebody has to discover. This is the same rule the
     * store contract had to learn the hard way, decided here before the first
     * plugin reads it rather than after.
     *
     * `trim` for the same reason: a value that is only whitespace is not a model
     * anybody named.
     */
    const chosen = (model ?? "").trim();

    /*
     * ⚠ **Before `admit`, so a caller that has already gone costs nothing.**
     * Nothing is reserved and nothing is spawned above this line, so this arm
     * touches none of the accounting {@link reserved} exists for.
     */
    stopIfGone(signal);

    const session = await this.claim(agent);
    try {
      /*
       * ⚠ **Asked again here, because `Session.start` is the long part and nothing
       * can interrupt it.** A caller that left while a subprocess was being
       * spawned and handshaked has an agent it never wanted; the `finally` below
       * is what gets rid of it, and this throw is what reaches that `finally`.
       * Inside the `try` rather than above it for exactly that reason.
       */
      stopIfGone(signal);
      if (chosen.length > 0) await this.choose(session, agent, chosen);
      return { text: await this.collect(session, prompt, signal), agent };
    } finally {
      await this.release(session);
    }
  }

  /**
   * Whether this machine will run anything for this agent at all, right now.
   *
   * ⚠ **Lifted out of {@link ask} rather than copied into {@link models}**, and
   * the reason is the third check rather than the first two. `inFlight` counts
   * `starting` as well as `live`, and the two entry points both spawn a real
   * agent process — a second copy of this preamble is how one of them comes to be
   * missing the cap, and the symptom of that is a machine with an unbounded
   * number of node subprocesses on it.
   *
   * ⚠ **It has exactly one caller, and that is a correction rather than a
   * detail.** The lifting stopped at the test: the {@link reserved} increment
   * this leaves behind was handed to {@link starting} by ten lines transcribed
   * into both entry points, so the cap was one function while the bookkeeping
   * that makes its number true was two hand-kept copies — the very shape the
   * paragraph above refuses. {@link claim} is where both halves live now.
   */
  private async admit(agent: AgentId, queue: boolean): Promise<void> {
    const until = Date.now() + SLOT_WAIT_MS;
    if (this.stopped) {
      throw new AgentAskError("model_unavailable", "this daemon is shutting down");
    }
    /*
     * Asked of the runtime rather than of this host's filesystem, exactly as
     * `GET /agents` and `agents.list` do — what "available" means is the
     * runtime's question, and it is the only thing that also knows whether the
     * agent is signed in.
     */
    const availability = await this.options.runtime.availability();
    const found = availability.find((one) => one.id === agent);
    if (found === undefined) {
      throw new AgentAskError("model_agent_unknown", `this machine has no agent called ${agent}`);
    }
    if (!found.available) {
      throw new AgentAskError(
        "model_agent_unavailable",
        found.hint ?? `${found.displayName} is not installed on this machine`,
      );
    }
    /*
     * ⚠ **`=== false`, never falsy, and this is Q7.99's recorded mistake.**
     * `loggedIn` is three-valued: `null` means *this agent has no non-interactive
     * way to answer*, which is permanently true of kimi. Reading that as "not
     * signed in" puts a "log in" refusal in front of somebody who already has —
     * and there is no screen here on which they could discover otherwise. So an
     * unanswerable question is attempted, and a real refusal arrives below, from
     * the agent itself.
     */
    if (found.loggedIn === false) {
      throw new AgentAskError(
        "model_agent_signed_out",
        `${found.displayName} is installed but not signed in on this machine`,
      );
    }

    /*
     * ⚠ **The test and the reservation are one tick, and nothing may be awaited
     * between them.** Everything above this point may park; from here to the
     * caller's `finally` nothing does, which is the whole of what makes this a
     * cap rather than a reading of one. See {@link reserved}.
     *
     * ⚠ **A queued caller keeps that invariant by *re-testing*, not by holding a
     * place.** The `await` below is outside the pair: control returns to the top
     * of the loop and the test happens again in the same tick as the increment it
     * guards, so a release that wakes three waiters admits one of them and parks
     * the other two again. A queue that reserved on being woken would be the
     * over-admission this whole comment exists to prevent.
     */
    for (;;) {
      if (this.inFlight < MAX_CONCURRENT_ASKS) {
        this.reserved += 1;
        return;
      }
      /*
       * ⚠ **`queue` is opt-in, and `ask` deliberately does not take it.** That
       * one is a plugin's question with a screen behind it, and `model_busy` is a
       * refusal it can report; parking it would turn a load message into a hang.
       * The capability sweep is the opposite: it is one operation over every
       * harness, it has no per-harness meaning, and a `model_busy` there greyed
       * out a whole harness in the builder with a sentence about load — see the
       * route.
       */
      if (!queue || Date.now() >= until) {
        throw new AgentAskError(
          "model_busy",
          `this machine is already running ${MAX_CONCURRENT_ASKS} model requests`,
        );
      }
      /*
       * Woken by a release or by {@link SLOT_WAIT_MS}, whichever comes first. The
       * timer is cleared on the wake so a parked caller cannot hold the event loop
       * open past its own answer.
       */
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.waiting.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, Math.max(0, until - Date.now()));
        // The daemon must not be held alive by somebody waiting for a slot.
        timer.unref?.();
        this.waiting.add(wake);
      });
      if (this.stopped) {
        throw new AgentAskError("model_unavailable", "this daemon is shutting down");
      }
    }
  }

  /**
   * A slot, a spawned agent, and a session nobody but the caller can reach — or
   * a refusal that has cost the machine nothing.
   *
   * ⚠ **{@link admit} counts, and this is what makes its number mean anything.**
   * The cap is not the test: it is the test plus the `reserved` → `starting` →
   * `live` chain below, which has no `await` at either join and no path on which
   * a run is counted in neither set. That chain was **copied** into both entry
   * points, one screen under a docblock that exists to refuse exactly that for
   * the test above — so the shared half was the half the compiler could not get
   * wrong anyway, and the transcribed half was the accounting. A third caller
   * would have transcribed it a third time.
   *
   * ⚠ **The handover is in a `finally` with nothing awaited inside the `try`**,
   * so `reserved` and `starting` double-count for no turns of the loop and go
   * absent together for none either. A `start` that rejects before this returns
   * leaves both empty and `live` untouched, which is why a caller only owes
   * {@link release} for a session this actually handed back.
   *
   * ⚠ **`live` is joined before this returns**, so a `shutdown` landing in the
   * microtask between the two finds the session rather than an empty set and a
   * process nobody holds. `starting` covers the window before the start
   * resolves; `live` covers the window after; the two must not have a gap
   * between them, and here they cannot.
   */
  private async claim(agent: AgentId, queue = false): Promise<Session> {
    await this.admit(agent, queue);

    // The slot `admit` reserved, handed to `starting` without an `await` in
    // between — the two count the same run and must never both be absent.
    let started: Promise<Session>;
    try {
      started = this.start(agent);
      this.starting.add(started);
    } finally {
      this.reserved -= 1;
      // `starting` took the slot in the same tick, so this frees nothing on the
      // success path — but a `start` that threw synchronously does, and a waiter
      // parked behind it would otherwise never be woken.
      this.freed();
    }
    let session: Session;
    try {
      session = await started;
    } finally {
      this.starting.delete(started);
      this.freed();
    }
    this.live.add(session);
    return session;
  }

  /**
   * The other half of {@link claim}, owed on every path out of the `try` that
   * follows it — the deadline and the abandonment included.
   *
   * `dispose()` is memoised, so a second call from {@link shutdown} racing this
   * one settles rather than killing a child twice.
   */
  private async release(session: Session): Promise<void> {
    this.live.delete(session);
    this.freed();
    await session.dispose().catch(() => {
      // Nothing left to release, or the child died with the turn. Either way
      // there is no second way to say it from here and nobody waiting to hear.
    });
  }

  /**
   * Which models this agent says it can be asked to use.
   *
   * ⚠ **This daemon has no model list of its own and could not have one.** There
   * is no field anywhere in this codebase called `model`: model selection travels
   * over ACP's `session/set_config_option`, where "model" is one value of the
   * option's `category`, and what an agent offers is whatever that agent's CLI
   * decided this week. So the only honest way to answer *which models are there*
   * is to start the agent and read what it publishes.
   *
   * ⚠ **Which costs a process, and that is the whole design problem.** A node
   * subprocess plus an ACP handshake plus `session/new`, to draw a dropdown. It
   * is cached for {@link MODELS_TTL_MS} and it takes a slot out of
   * {@link MAX_CONCURRENT_ASKS} while it runs, so a settings pane opened twice
   * spawns once and a machine cannot be made to spawn without bound.
   *
   * ⚠ **No prompt is sent, so no quota is spent.** This is the one thing in this
   * file that starts an agent without asking it anything — the session exists
   * only long enough for the handshake to have happened.
   *
   * ⚠ **Reading a *live* session's config instead was considered and refused.**
   * The registry does hold sessions carrying exactly this list, so on a machine
   * with a chat open the answer is already in memory and free. Two reasons
   * against. The snapshot's copy is **not** the agent's: `dedupeAliasChoices`
   * rewrites the model value off claude's `default` placeholder onto a concrete
   * model, which Q2.45 records as the reason a snapshot must never be replayed —
   * and reaching the untouched copy means a new accessor across a dependency edge
   * that points the other way. And a list whose contents depend on whether
   * somebody happens to have a chat open is a list that changes for reasons
   * nobody on the screen can see.
   */
  async models(agent: AgentId, signal?: AbortSignal): Promise<AgentModelChoice[]> {
    return (await this.capabilities(agent, signal)).models;
  }

  /**
   * {@link models}, plus what this agent will let us do about *which system* it
   * talks to — off the same spawn, under the same cache and the same slot.
   */
  async capabilities(agent: AgentId, signal?: AbortSignal, queue = false): Promise<AgentCapabilities> {
    const held = this.models_.get(agent);
    if (held !== undefined && Date.now() - held.at < MODELS_TTL_MS) return held.answer;

    /*
     * Joined rather than raced. The signal is deliberately *not* consulted before
     * this: a caller that has gone must not leave a spawn behind, which is what
     * `stopIfGone` below is for — but it also must not cancel the answer somebody
     * else is waiting on, and a run in flight belongs to whoever started it.
     */
    const running = this.capsInFlight.get(agent);
    if (running !== undefined) return running;

    /*
     * ⚠ **Checked once here, where {@link ask} checks three times, and the
     * asymmetry is the point.** What this holds is a handshake, which
     * `Session.start` already bounds at 30 s + 60 s, and there is no turn to
     * interrupt: once the agent has answered `session/new` the list is in hand and
     * the session is disposed a few lines later. So the only thing worth refusing
     * is the *spawn*, and after the cache read is where that decision is. A caller
     * that has gone may still have the cached list; it must not be able to leave a
     * subprocess behind.
     */
    stopIfGone(signal);

    const run = this.readCapabilities(agent, queue);
    this.capsInFlight.set(agent, run);
    try {
      return await run;
    } finally {
      this.capsInFlight.delete(agent);
    }
  }

  /**
   * Forget what an agent last said, so the next ask really asks.
   *
   * ⚠ **The TTL was the *only* thing that ever emptied this map, and a
   * contribution changing under it is not a passage of time.** `PluginHost`
   * already calls `forgetStartRefusal()` and `forgetAvailability()` on the runtime
   * after every install, update, remove and enable — but neither can reach here,
   * so an install followed by an update inside {@link MODELS_TTL_MS}, or a disable
   * followed by an enable, cleared the refusal record and then hit this cache:
   * nothing spawned, and `GET /agents/capabilities` served the *previous* binary's
   * model list and routing for the rest of the ten minutes. `readAssembledAgent`
   * feeds exactly that `routing` to `hostable`, so a preset could be weighed
   * against a harness that is no longer installed.
   *
   * Whole-map with no argument, because that is what a plugin write means: the
   * ids that changed are the plugin's, and a caller holding only "something was
   * installed" cannot name them. `capsInFlight` is deliberately **not** touched —
   * a run already in flight belongs to whoever started it and will settle on its
   * own; dropping it here would leave that caller waiting on a promise nothing
   * completes.
   */
  forget(agent?: AgentId): void {
    // Before the delete rather than after: a read that settles between the two
    // would otherwise pass the comparison and write itself back into a map this
    // call had already emptied.
    this.capsGeneration += 1;
    if (agent === undefined) this.models_.clear();
    else this.models_.delete(agent);
  }

  /** {@link capabilities} with the cache and the in-flight collapse taken off. */
  private async readCapabilities(agent: AgentId, queue: boolean): Promise<AgentCapabilities> {
    /*
     * ⚠ **Queued only where the *caller* asked for it, and a plugin does not.**
     * `model.list` reaches this method too, and `MAX_CONCURRENT_ASKS` is a bound
     * `docs/PLUGINS.md` publishes to plugin authors: parking one inside its own
     * ten-second invocation would make a documented refusal unobservable and turn
     * a load message into a timeout. The capability *sweep* opts in, because it is
     * one operation over every harness with no per-harness meaning to refuse.
     *
     * A plugin call that *joins* a sweep already in flight does wait — but that is
     * `capsInFlight` handing it an answer somebody else is fetching, which is the
     * behaviour it always had.
     */
    // Captured before anything is awaited, so every `forget()` from here on is
    // visible at the write below.
    const generation = this.capsGeneration;
    const session = await this.claim(agent, queue);
    try {
      const option = modelOptionOf(session);
      /*
       * An agent that publishes no model control is not an error, and an empty
       * list is the honest answer. The refusal belongs at the point somebody tries
       * to *use* a model, where there is a value to name.
       *
       * ⚠ **This used to say "kimi does not", and that was measured wrong.**
       * Re-measured 2026-08-26 against the installed kimi 0.29.x: it publishes
       * four — `kimi-code/kimi-for-coding`, `…-highspeed`, `kimi-code/k3` and
       * `kimi-code/k3-256k` — and answers `null` to `providers/list`, which is the
       * half that was right. The two are independent questions and the stale
       * sentence folded them, which cost a client-side refusal that told people
       * kimi "lists this model under another name" while claiming it listed none.
       */
      const models =
        option === null
          ? []
          : option.choices.map((one) => ({
              id: one.value,
              name: one.name,
              description: one.description,
              group: one.group,
            }));
      // `routing` answers `null` on every failure rather than throwing — an
      // agent that cannot be re-pointed is two of the three, not a broken one —
      // so the model list is never lost to a question about providers.
      /*
       * Asked of the runtime rather than of the session, because it is a question
       * about which *file* was spawned and the session only knows it is talking to
       * something. Cheap and cached there; this read is already behind a spawn.
       */
      const answer: AgentCapabilities = {
        models,
        routing: await session.routing(),
        cli: await this.options.runtime.agentCli(agent),
      };
      // Returned either way — the caller asked and this is the answer it got — but
      // only cached when nothing cleared the map while we were asking. See
      // {@link capsGeneration}.
      if (generation === this.capsGeneration) this.models_.set(agent, { at: Date.now(), answer });
      return answer;
    } finally {
      /*
       * ⚠ **Not awaited, and this is where the time was going.** Measured
       * 2026-08-28, per harness, from `Session.start` to the answer being in hand
       * and then to this returning:
       *
       *   claude    start  916 ms · dispose   18 ms
       *   kimi      start  549 ms · dispose   28 ms
       *   codex     start  383 ms · dispose **2011 ms**
       *   opencode  start 1001 ms · dispose   24 ms
       *
       * codex's list is complete at 383 ms and the caller was made to wait 2394 —
       * 84% of it spent tearing down a process whose answer was already read. It
       * is the `session/close` deadline almost exactly: codex does not answer that
       * call, so the close waits its full budget before the kill. The other three
       * disappear in tens of milliseconds, which is what makes this one harness
       * the critical path of the whole sweep.
       *
       * ⚠ **The slot is still held until the teardown finishes**, because that is
       * the number the cap is about — `release` deletes from `live` and calls
       * `freed` when the child is actually gone, so nothing here can put more
       * processes on the machine than `MAX_CONCURRENT_ASKS` allows. What changed
       * is only who waits: the caller has its answer, and the daemon keeps its own
       * obligation not to leave a subprocess behind.
       *
       * ⚠ **`shutdown` is unaffected.** The session is in `live` until this
       * settles, so a drain arriving mid-teardown finds it and calls `dispose`
       * again — which is memoised, and settles rather than killing a child twice.
       *
       * `ask` still waits for its own teardown, deliberately: its caller is a
       * plugin holding a budget, and returning early there would hand back a slot
       * that is still occupied to a caller that measures its own concurrency.
       */
      void this.release(session);
    }
  }

  /**
   * Point this session at one model before anything is asked of it.
   *
   * ⚠ **Validated against what *this* session just published, never against the
   * cache.** The list somebody chose from may be up to {@link MODELS_TTL_MS} old
   * and a CLI update can retire a model in between — so the check that matters is
   * the one made against the agent standing in front of us, and its refusal names
   * what is really there.
   */
  private async choose(session: Session, agent: AgentId, model: string): Promise<void> {
    const option = modelOptionOf(session);
    if (option === null) {
      throw new AgentAskError("model_not_selectable", `${agent} does not offer a choice of model on this machine`);
    }
    if (!option.choices.some((one) => one.value === model)) {
      /*
       * Named rather than counted, and clipped: a refusal that says "unknown
       * model" and stops sends somebody to guess, and claude advertises every
       * model it can reach — which is a wall of text in an error string nobody
       * chose to open.
       */
      const names = option.choices.map((one) => one.value);
      const shown = names.slice(0, MODEL_NAMES_IN_REFUSAL).join(", ");
      const rest = names.length > MODEL_NAMES_IN_REFUSAL ? `, and ${names.length - MODEL_NAMES_IN_REFUSAL} more` : "";
      throw new AgentAskError(
        "model_unknown",
        `${agent} has no model called ${JSON.stringify(model)}${names.length === 0 ? "" : ` — it offers ${shown}${rest}`}`,
      );
    }
    await session.setConfigOption(option.id, model);
  }

  private async start(agent: AgentId): Promise<Session> {
    try {
      return await Session.start({
        agent,
        cwd: this.options.cwd,
        runtime: this.options.runtime,
        /*
         * ⚠ **Passed explicitly, and refusing, because the default is the
         * dangerous one.** `SessionOptions.permissions` is optional and its
         * absence does **not** mean "no permissions" — it means the session
         * answers for itself with an allow-once policy and never blocks. On an
         * unaddressable session that would be an agent silently approving its own
         * tools with nobody able to see it, which is the single outcome this
         * whole design exists to prevent. Blocking would be merely useless: there
         * is no screen on which anybody could answer.
         *
         * `elicitations` is left off rather than set: its *absence* is what
         * withdraws the capability, so the agent is never handed `AskUserQuestion`
         * at all rather than being handed it and refused.
         */
        permissions: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The one concession this subsystem makes about launch failures, made in
      // one place — see `isAuthRequiredMessage`. A signed-out agent is the
      // refusal a person can act on; everything else is the machine's problem.
      if (isAuthRequiredMessage(message)) {
        throw new AgentAskError("model_agent_signed_out", message);
      }
      throw new AgentAskError("model_failed", message);
    }
  }

  /**
   * The agent's answer, as one string.
   *
   * Only `role: "agent"` text that is not a thought: a plugin asked a question
   * and wants what was said back, not the reasoning that got there. Thoughts are
   * a different event and folding them in would put a model's scratchpad into
   * whatever the plugin does with this.
   */
  private async collect(session: Session, prompt: string, signal?: AbortSignal): Promise<string> {
    const budget = this.options.timeoutMs ?? ASK_TIMEOUT_MS;
    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new AgentAskError("model_timeout", `no answer within ${Math.round(budget / 1000)}s`)),
        budget,
      );
      // Unref'd so a run in flight cannot hold the process open past everything
      // else being done — the `finally` in `ask` is what actually collects it.
      timer.unref?.();
    });

    const read = async (): Promise<string> => {
      let text = "";
      let bytes = 0;
      for await (const event of session.prompt(prompt)) {
        if (event.type === "error") throw new AgentAskError("model_failed", event.message);
        if (event.type !== "text" || event.role !== "agent" || event.thought) continue;
        bytes += Buffer.byteLength(event.text, "utf8");
        if (bytes > MAX_ASK_OUTPUT_BYTES) {
          throw new AgentAskError(
            "model_too_large",
            `that agent answered with more than ${MAX_ASK_OUTPUT_BYTES} bytes`,
          );
        }
        text += event.text;
      }
      return text;
    };

    /*
     * ⚠ **A third arm rather than a second deadline.** "The agent took too long"
     * and "nobody is waiting" are different facts and carry different codes, and
     * folding them together would send a plugin author to look at the agent for a
     * timeout their own invocation caused. The `aborted` test comes first, because
     * a signal that fired before this line never fires again.
     *
     * A promise that never settles where there is no signal is deliberate: `race`
     * drops it with everything else when another arm wins, and an `if` around the
     * whole race would be two copies of the race.
     */
    const abandoned = new Promise<never>((_, reject) => {
      if (signal === undefined) return;
      if (signal.aborted) {
        reject(cancelled(signal));
        return;
      }
      signal.addEventListener("abort", () => reject(cancelled(signal)), { once: true });
    });

    /*
     * `read()` keeps iterating after any of these wins, exactly as it already did
     * for the deadline: `race` holds a handler on it, so its eventual rejection is
     * observed rather than unhandled, and `ask`'s `finally` is what actually ends
     * the agent.
     */
    return await Promise.race([read(), deadline, abandoned]);
  }

  /**
   * Stop everything, and wait for what was still being born.
   *
   * `starting` first, for the reason its own docblock gives: draining `live`
   * while a `Session.start` is in flight leaves the process that start is about
   * to produce with nobody holding it.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    // Parked callers re-test after being woken and find `stopped`, so this is
    // what turns a queue into a refusal rather than into a wait for a slot that
    // will never be handed out.
    this.freed();
    await Promise.allSettled([...this.starting]);
    const running = [...this.live];
    this.live.clear();
    await Promise.allSettled(running.map((session) => session.dispose()));
  }
}
