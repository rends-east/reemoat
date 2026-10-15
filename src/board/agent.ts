import { mkdirSync } from "node:fs";
import type { AgentId } from "../acp/agents.js";
import { BOARD_AGENT_NICKNAME } from "../nickname.js";
import type { ManagedSession, SessionRegistry } from "../registry.js";

/** Set at its create, or its first message would name it after whatever was asked first. */
export const BOARD_AGENT_TITLE = "Board config";

export interface BoardAgentSpec {
  agent: AgentId;
  customAgent: string | null;
}

/**
 * The board's config agent on this machine: one session with purpose `board` and the nickname config, in a folder this daemon
 * owns, found again rather than made twice. A replaced one is retired, never deleted, and the inactive-row prune takes it (Q2.270).
 */
export class BoardAgents {
  private readonly registry: SessionRegistry;
  private readonly root: string;
  // One start at a time: two presses would otherwise race for the nickname, and the loser would answer nickname_taken.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { registry: SessionRegistry; root: string }) {
    this.registry = options.registry;
    this.root = options.root;
  }

  /** The newest session with the purpose: after settle, the one holding the nickname. */
  current(): ManagedSession | null {
    let newest: ManagedSession | null = null;
    for (const one of this.registry.list()) {
      if (one.purpose === "board" && (newest === null || one.createdAt > newest.createdAt)) newest = one;
    }
    return newest;
  }

  /** Once after restore: a crash between a retire and its create can leave two, and the older goes. */
  async settle(): Promise<void> {
    const kept = this.current();
    for (const one of this.registry.list()) {
      if (one.purpose === "board" && one !== kept) await this.registry.retireBoardAgent(one);
    }
  }

  /** The one there is, or a new one; `replace` retires the one there is first, and puts it back if the new one is refused. */
  start(spec: BoardAgentSpec, replace: boolean): Promise<{ session: ManagedSession; created: boolean }> {
    const run = this.queue.then(() => this.startNow(spec, replace));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async startNow(spec: BoardAgentSpec, replace: boolean): Promise<{ session: ManagedSession; created: boolean }> {
    const held = this.current();
    if (held !== null && !replace) return { session: held, created: false };
    if (held !== null) await this.registry.retireBoardAgent(held);
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const made = await this.registry.create({
        agent: spec.agent,
        customAgent: spec.customAgent,
        cwd: this.root,
        worktree: "never",
        nickname: BOARD_AGENT_NICKNAME,
        purpose: "board",
      });
      this.registry.setMeta(made, { title: BOARD_AGENT_TITLE });
      return { session: made, created: true };
    } catch (error) {
      if (held !== null) this.registry.reinstateBoardAgent(held);
      throw error;
    }
  }

  /** Another machine's config agent replaced this one: stopped here, and drawn nowhere. */
  retire(): Promise<boolean> {
    const run = this.queue.then(async () => {
      const held = this.current();
      if (held === null) return false;
      await this.registry.retireBoardAgent(held);
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
