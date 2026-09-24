/** In-process first-come gate on deploy/agents.sh; the script's own lock only catches orphans. */

export interface ScriptHolder {
  kind: "update" | "install";
  /** The harness an install is for, or `null` for a run over all of them. */
  agent: string | null;
  since: number;
}

export class AgentScriptGate {
  private held: ScriptHolder | null = null;

  tryHold(kind: "update" | "install", agent: string | null = null, now = Date.now()): boolean {
    if (this.held !== null) return false;
    this.held = { kind, agent, since: now };
    return true;
  }

  /** Releases only if `kind` holds it; that cannot tell one install from the next, so a caller must never release twice. */
  release(kind: "update" | "install"): void {
    if (this.held?.kind === kind) this.held = null;
  }

  get holder(): ScriptHolder | null {
    return this.held;
  }
}
