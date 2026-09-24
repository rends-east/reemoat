// One question to an agent on a bare Session that belongs to no session list, so no view has anything to subtract (Q7.27).
// Its agent is reachable only by shutdown here; the exposure is bounded by MAX_CONCURRENT_ASKS and ASK_TIMEOUT_MS.

import type { AgentId } from "./acp/agents.js";
import type { AgentRouting } from "./acp/systems.js";
import type { AgentConfigOption } from "./events.js";
import type { AgentCliChoice, SessionRuntime } from "./runtime/types.js";
import { isAuthRequiredMessage, Session } from "./session.js";

export const MAX_ASK_PROMPT_BYTES = 8 * 1024;

/** Charged as it arrives; past it the ask is refused rather than clipped. */
export const MAX_ASK_OUTPUT_BYTES = 16 * 1024;

/** Wall clock on the whole ask, since Session.prompt has no end-to-end bound; far above a plugin's invoke deadline, hence the abort signal. */
export const ASK_TIMEOUT_MS = 120_000;

/** Daemon-wide, and small because each ask spawns an agent process. */
export const MAX_CONCURRENT_ASKS = 2;

/** The daemon's own budget, never a caller's signal: a queued run is shared by every caller for that harness. */
export const SLOT_WAIT_MS = 120_000;

/** A ceiling on staleness; a held list is also dropped when agentCli reports a different build (Q6.112). */
export const MODELS_TTL_MS = 10 * 60_000;

const MODEL_NAMES_IN_REFUSAL = 8;

function modelOptionOf(session: Session): AgentConfigOption | null {
  return session.modelOption;
}

function cancelled(signal: AbortSignal): AgentAskError {
  const reason: unknown = signal.reason;
  const detail =
    reason instanceof Error && reason.message.length > 0 ? reason.message : "nobody is waiting for this any more";
  return new AgentAskError("model_cancelled", detail);
}

function stopIfGone(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) throw cancelled(signal);
}

export class AgentAskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentAskError";
  }
}

export interface AgentModelChoice {
  id: string;
  name: string;
  description: string | null;
  group: string | null;
}

export interface AgentCapabilities {
  models: AgentModelChoice[];
  /** `null` where this agent cannot be pointed at another system at all. */
  routing: AgentRouting | null;
  /** Which CLI build published these models, or null; read off the same spawn so the two cannot disagree. */
  cli: AgentCliChoice | null;
}

export function sameCli(a: AgentCliChoice | null, b: AgentCliChoice | null): boolean {
  if (a === null || b === null) return a === b;
  return a.path === b.path && a.version === b.version && a.source === b.source;
}

export interface AgentCapabilityReader {
  /** queue waits for a slot instead of being refused one; the capability sweep opts in, a plugin's model.list does not. */
  capabilities(agent: AgentId, signal?: AbortSignal, queue?: boolean): Promise<AgentCapabilities>;
}

export interface AgentAskAnswer {
  text: string;
  agent: AgentId;
}

export interface AgentAskOptions {
  runtime: SessionRuntime;
  /** An empty directory this daemon owns, never a session's workspace: the model scope grants no file access. */
  cwd: string;
  timeoutMs?: number;
}

export class AgentAskRuns {
  private readonly live = new Set<Session>();
  /** Accepted asks still inside Session.start; shutdown waits on them so none spawns after the drain. */
  private readonly starting = new Set<Promise<unknown>>();
  private readonly models_ = new Map<AgentId, { at: number; answer: AgentCapabilities }>();
  /** Bumped by forget, captured before a read and compared before its write, so an in-flight read cannot restore a forgotten answer. */
  private capsGeneration = 0;
  private readonly capsInFlight = new Map<AgentId, Promise<AgentCapabilities>>();
  private stopped = false;

  constructor(private readonly options: AgentAskOptions) {}

  /** Slots reserved in admit with no await after the cap test, handed to starting in the same tick by claim. */
  private reserved = 0;

  get inFlight(): number {
    return this.live.size + this.starting.size + this.reserved;
  }

  /** Callers parked on a slot; woken by freed, and a woken waiter re-tests the cap. */
  private readonly waiting = new Set<() => void>();

  /** Must be called wherever inFlight shrinks, or a parked queue never drains. */
  private freed(): void {
    if (this.waiting.size === 0) return;
    const woken = [...this.waiting];
    this.waiting.clear();
    for (const wake of woken) wake();
  }

  /**
   * Throws AgentAskError for everything a caller can act on.
   * signal ends the wait when the caller leaves; it does not undo a spawn already under way.
   */
  async ask(agent: AgentId, prompt: string, model?: string, signal?: AbortSignal): Promise<AgentAskAnswer> {
    if (Buffer.byteLength(prompt, "utf8") > MAX_ASK_PROMPT_BYTES) {
      throw new AgentAskError("model_prompt_too_large", `a prompt may be at most ${MAX_ASK_PROMPT_BYTES} bytes`);
    }
    if (prompt.trim().length === 0) {
      throw new AgentAskError("model_prompt_empty", "there is nothing to ask");
    }
    const chosen = (model ?? "").trim();

    stopIfGone(signal);

    const session = await this.claim(agent);
    try {
      // Re-checked inside the try: a caller that left during Session.start must still reach the finally that disposes it.
      stopIfGone(signal);
      if (chosen.length > 0) await this.choose(session, agent, chosen);
      return { text: await this.collect(session, prompt, signal), agent };
    } finally {
      await this.release(session);
    }
  }

  private async admit(agent: AgentId, queue: boolean): Promise<void> {
    const until = Date.now() + SLOT_WAIT_MS;
    if (this.stopped) {
      throw new AgentAskError("model_unavailable", "this daemon is shutting down");
    }
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
    // Strictly false: null means the agent cannot answer non-interactively (kimi), so the ask is attempted (Q7.99).
    if (found.loggedIn === false) {
      throw new AgentAskError(
        "model_agent_signed_out",
        `${found.displayName} is installed but not signed in on this machine`,
      );
    }

    // No await between the cap test and the reservation; a woken waiter re-tests rather than holding a place.
    for (;;) {
      if (this.inFlight < MAX_CONCURRENT_ASKS) {
        this.reserved += 1;
        return;
      }
      if (!queue || Date.now() >= until) {
        throw new AgentAskError(
          "model_busy",
          `this machine is already running ${MAX_CONCURRENT_ASKS} model requests`,
        );
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.waiting.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, Math.max(0, until - Date.now()));
        timer.unref?.();
        this.waiting.add(wake);
      });
      if (this.stopped) {
        throw new AgentAskError("model_unavailable", "this daemon is shutting down");
      }
    }
  }

  /**
   * A slot and a started session, or a refusal that cost nothing.
   * reserved, starting and live hand over with no await, so a run is always counted exactly once.
   */
  private async claim(agent: AgentId, queue = false): Promise<Session> {
    await this.admit(agent, queue);

    let started: Promise<Session>;
    try {
      started = this.start(agent);
      this.starting.add(started);
    } finally {
      this.reserved -= 1;
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

  /** The slot is held and the session stays in live until dispose settles, so the cap counts processes and shutdown still finds this one. */
  private async release(session: Session): Promise<void> {
    await session.dispose().catch(() => {
      // Nothing left to release, or the child died with the turn; nobody is waiting to hear.
    });
    this.live.delete(session);
    this.freed();
  }

  /**
   * The agent's published models, which cost a spawn to read; cached for MODELS_TTL_MS.
   * A live session's list is not reused, because its model value is rewritten (Q2.45).
   */
  async models(agent: AgentId, signal?: AbortSignal): Promise<AgentModelChoice[]> {
    return (await this.capabilities(agent, signal)).models;
  }

  async capabilities(agent: AgentId, signal?: AbortSignal, queue = false): Promise<AgentCapabilities> {
    const held = this.models_.get(agent);
    if (held !== undefined && Date.now() - held.at < MODELS_TTL_MS) {
      // Believed only while the same CLI build would run (Q6.112); fenced on the entry, so a forget during the await discards it.
      if (signal?.aborted === true) return held.answer;
      const cli = await this.options.runtime.agentCli(agent);
      const still = this.models_.get(agent) === held;
      if (still && sameCli(held.answer.cli, cli)) return held.answer;
      if (still) this.models_.delete(agent);
    }

    const running = this.capsInFlight.get(agent);
    if (running !== undefined) return running;

    stopIfGone(signal);

    const run = this.readCapabilities(agent, queue);
    this.capsInFlight.set(agent, run);
    try {
      return await run;
    } finally {
      this.capsInFlight.delete(agent);
    }
  }

  /** Forget what an agent last said, so the next ask really asks; capsInFlight is left to settle on its own. */
  forget(agent?: AgentId): void {
    this.capsGeneration += 1;
    if (agent === undefined) this.models_.clear();
    else this.models_.delete(agent);
  }

  private async readCapabilities(agent: AgentId, queue: boolean): Promise<AgentCapabilities> {
    const generation = this.capsGeneration;
    const session = await this.claim(agent, queue);
    try {
      const option = modelOptionOf(session);
      const models =
        option === null
          ? []
          : option.choices.map((one) => ({
              id: one.value,
              name: one.name,
              description: one.description,
              group: one.group,
            }));
      // After the spawn, so a build swapped during Session.start labels the old list until the TTL runs out (Q6.112).
      const answer: AgentCapabilities = {
        models,
        routing: await session.routing(),
        cli: await this.options.runtime.agentCli(agent),
      };
      if (generation === this.capsGeneration) this.models_.set(agent, { at: Date.now(), answer });
      return answer;
    } finally {
      // Not awaited: the caller already has its answer, and codex takes seconds to tear down.
      void this.release(session);
    }
  }

  private async choose(session: Session, agent: AgentId, model: string): Promise<void> {
    const option = modelOptionOf(session);
    if (option === null) {
      throw new AgentAskError("model_not_selectable", `${agent} does not offer a choice of model on this machine`);
    }
    if (!option.choices.some((one) => one.value === model)) {
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
        // Passed explicitly as a refusal: the default allow-once policy would let an unseen agent approve its own tools.
        // elicitations is omitted so that capability is withdrawn.
        permissions: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAuthRequiredMessage(message)) {
        throw new AgentAskError("model_agent_signed_out", message);
      }
      throw new AgentAskError("model_failed", message);
    }
  }

  private async collect(session: Session, prompt: string, signal?: AbortSignal): Promise<string> {
    const budget = this.options.timeoutMs ?? ASK_TIMEOUT_MS;
    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new AgentAskError("model_timeout", `no answer within ${Math.round(budget / 1000)}s`)),
        budget,
      );
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

    const abandoned = new Promise<never>((_, reject) => {
      if (signal === undefined) return;
      if (signal.aborted) {
        reject(cancelled(signal));
        return;
      }
      signal.addEventListener("abort", () => reject(cancelled(signal)), { once: true });
    });

    return await Promise.race([read(), deadline, abandoned]);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.freed();
    await Promise.allSettled([...this.starting]);
    const running = [...this.live];
    this.live.clear();
    await Promise.allSettled(running.map((session) => session.dispose()));
  }
}
