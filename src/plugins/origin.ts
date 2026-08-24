/* ──────────────────────────────────────────────────────────────────────────
 * Who caused a hook, so that the plugin which caused it is not told about it.
 *
 * ⚠ **`src/agentask.ts`'s header records this exact recursion**, and this file is
 * the other half of that argument — the half about the sessions a plugin *is*
 * given to address:
 *
 *   > the plugin host observes every session that arrives in the registry, so a
 *   > hidden session's `turn_end` fanned `turn.ended` back to the very plugin
 *   > that had asked for it, which asked again. Bounded only by
 *   > `MAX_LIVE_SESSIONS`, i.e. by a machine on which nobody can start a session.
 *
 * That file closed the hole by making its session unaddressable — no row, no
 * `SessionLog`, no observers, nothing to subtract from anything. Nothing closed
 * it for the sessions `PluginApi` hands out on purpose: a `turn.ended` handler
 * calling `ctx.sessions.prompt` starts a turn that fires `turn.ended` at the same
 * plugin, and every turn of that loop is a real model turn. `session.created`
 * calling `ctx.sessions.create` is the same shape and costs a worktree and an
 * agent process each time round. The hook queue does not end it: `drain`'s
 * `draining` flag flattens the recursion into a loop, and drop-oldest at 256
 * bounds the *memory* rather than the work.
 *
 * ⚠ **The stamp is on the act, never on the session, and the difference is a
 * plugin going blind.** A session a plugin created is not that plugin's for ever:
 * a person opens it and prompts it like any other, and a plugin that stopped
 * being told `turn.ended` about a session it opened a week ago would be wrong
 * about the machine with nothing on any screen saying so. What is suppressed is
 * the echo of *this* write — one hook per act, the one the caller already knows
 * about because the call it made returned.
 *
 * ⚠ **Single-shot, and taken whether or not anybody is subscribed.** A claim
 * names one turn. Leaving it standing would suppress somebody else's turn later,
 * which is the blind spot above arriving by the back door.
 *
 * ⚠ **In memory, per daemon life, and deliberately not persisted.** A restart
 * interrupts every turn in flight, so the act a claim describes did not survive
 * either — and a claim read off disk would suppress the first turn of a session
 * after a restart for a reason nobody could find. Restored sessions announce as
 * `restored` and fan no `session.created` at all, so there is nothing on that
 * path to attribute.
 *
 * Only the *turn* is held here. `session.created`'s origin travels as an argument
 * to `SessionRegistry.create` instead, because that fan happens **inside** the
 * call: `announce(managed, "created")` runs before `create` resolves, so there is
 * no moment after the `await` at which a caller could stamp it.
 * ────────────────────────────────────────────────────────────────────────── */

export class PluginOrigins {
  /**
   * `sessionId -> the plugin whose prompt started the turn now running`.
   *
   * ⚠ **Keyed on the session alone, and that is exact rather than approximate.**
   * `ManagedSession.prompt` answers `busy` while `this.turn !== null`, so a prompt
   * that came back `accepted` is a session that had no turn — and the next
   * `turn_end` on it is therefore the end of *this* turn. The turn number is on
   * the snapshot and could have been compared, but reading it means building a
   * snapshot on a path whose whole point is that it builds one only when somebody
   * subscribed.
   *
   * Bounded by the registry rather than by a number here: at most one entry per
   * session, overwritten rather than appended, and a terminal session cannot take
   * a prompt at all. {@link forget} collects the ordinary case.
   */
  private readonly turns = new Map<string, string>();

  /**
   * This plugin is about to start a turn on this session — and how to take it back.
   *
   * ⚠ **Claimed *before* the call, and put back where the call was refused,
   * because `pump` can record a `turn_end` synchronously.** The tempting shape is
   * to claim after `prompt()` has answered `accepted`, on the reasoning that
   * `pump` suspends at its `for await` before anything can be recorded. That is
   * not true: `prompt` fires `pump` with `void`, and with no attachments — which
   * is every prompt a plugin makes — the `await` in `pump`'s first statement is
   * never evaluated, so it runs straight into an explicit synchronous `turn_end`
   * append on the cancelled path. A claim written after the call returned would
   * land after that hook had already fanned.
   *
   * The undo is what makes claiming early safe: a prompt refused as `busy` would
   * otherwise have overwritten the claim of the turn that is actually running,
   * and suppressed *its* `turn.ended` instead.
   */
  claimTurn(sessionId: string, pluginId: string): () => void {
    const prior = this.turns.get(sessionId);
    this.turns.set(sessionId, pluginId);
    return () => {
      if (prior === undefined) this.turns.delete(sessionId);
      else this.turns.set(sessionId, prior);
    };
  }

  /** Who started the turn that has just ended, and never twice. */
  takeTurn(sessionId: string): string | null {
    const held = this.turns.get(sessionId);
    if (held === undefined) return null;
    this.turns.delete(sessionId);
    return held;
  }

  /**
   * This session is over, so whatever it was holding names nothing.
   *
   * A turn that never produced a `turn_end` — the agent died with it, the daemon
   * was interrupted — would otherwise leave a claim that suppresses the first
   * turn of a session somebody resumes.
   */
  forget(sessionId: string): void {
    this.turns.delete(sessionId);
  }

  /** How many claims are outstanding. For `daemoncheck`; nothing branches on it. */
  get held(): number {
    return this.turns.size;
  }
}
