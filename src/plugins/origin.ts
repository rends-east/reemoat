// Who started a turn, so a plugin is not told the echo of its own act; stamped on the act, never on the session.
// Single-shot and in memory only; session.created's origin travels through SessionRegistry.create instead.

export class PluginOrigins {
  /** Keyed on the session alone: an accepted prompt means no turn was running, so the next turn_end is this one. */
  private readonly turns = new Map<string, string>();

  /** Claimed before the call, since pump can record turn_end synchronously; the undo restores the prior claim on refusal. */
  claimTurn(sessionId: string, pluginId: string): () => void {
    const prior = this.turns.get(sessionId);
    this.turns.set(sessionId, pluginId);
    return () => {
      if (prior === undefined) this.turns.delete(sessionId);
      else this.turns.set(sessionId, prior);
    };
  }

  takeTurn(sessionId: string): string | null {
    const held = this.turns.get(sessionId);
    if (held === undefined) return null;
    this.turns.delete(sessionId);
    return held;
  }

  /** Drops a claim whose turn never ended, or it would suppress a resumed session's first turn. */
  forget(sessionId: string): void {
    this.turns.delete(sessionId);
  }

  get held(): number {
    return this.turns.size;
  }
}
