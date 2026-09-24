import type { Readable, Writable } from "node:stream";

import type { AgentId, AgentLaunchConfig } from "../acp/agents.js";
import type { SystemId } from "../acp/systems.js";
import type { AgentHandle } from "../events.js";
import type { GitExec } from "../git.js";

export type Liveness = "alive" | "dead" | "unknown";

export type { AgentHandle } from "../events.js";

export interface AgentProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly handle: AgentHandle | null;

  onceStartError(listener: (error: Error) => void): () => void;
  onceExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;

  readonly hasExited: boolean;
  waitForExit(timeoutMs: number): Promise<boolean>;

  endStdin(): void;

  /** Signals the whole process group, or the adapter's CLI child is stranded; never throws. */
  kill(signal: NodeJS.Signals): Promise<void>;
}

export interface LoginProcess extends Omit<AgentProcess, "stdin"> {
  readonly stdin: Writable | null;
}

export interface AgentLoginSupport {
  supported: boolean;
  blocked: "no_flow" | "no_script" | "no_cli" | "interactive_pty" | null;
  needsInput: boolean;
  canSignOut: boolean;
}

export interface StartRefusal {
  at: number;
  routed: boolean;
  message: string;
}

export interface AgentAvailability {
  id: AgentId;
  displayName: string;
  available: boolean;
  hint: string | null;
  /** Only a built-in's missing CLI, which the installer can fix. */
  installable: boolean;
  loggedIn: boolean | null;
  lastStartRefusal: StartRefusal | null;
  label?: string;
  contributedBy?: { pluginId: string; pluginName: string };
}

export interface ReapDecision {
  killed: boolean;
  confirmedDead: boolean;
  detail: string | null;
}

export interface AgentCliChoice {
  path: string;
  version: string | null;
  source: "override" | "path";
}

export interface SessionRuntime {
  readonly clientFileIo: boolean;

  readonly loginSupported: boolean;

  describe(agent: AgentId): AgentLaunchConfig;

  agentCli(agent: AgentId): Promise<AgentCliChoice | null>;

  availability(): Promise<AgentAvailability[]>;

  forgetAvailability(): void;

  /** Only on ACP auth_required at start, never on a mid-session authentication_failed (Q7.99). */
  noteStartRefusal(agent: AgentId, message: string, routed: boolean): void;

  forgetStartRefusal(agent?: AgentId): void;

  /** extra is daemon-table routing, never a secret; routed omits the harness's own credentials. */
  launch(agent: AgentId, extra?: NodeJS.ProcessEnv, routed?: boolean): Promise<AgentProcess>;

  /** Null when no key is present: an id selects API-key auth and breaks a CLI login (Q6.110). */
  authMethod(agent: AgentId, routed?: boolean): string | null;

  systemSecret(system: SystemId): string | null;

  login(agent: AgentId): Promise<LoginProcess | null>;

  loginSupport(agent: AgentId): AgentLoginSupport;

  credentialSlots(agent: AgentId): readonly string[];

  logout(agent: AgentId): Promise<{ ok: boolean; detail: string | null } | null>;

  git(): GitExec;

  kill(handle: AgentHandle | null, signal: NodeJS.Signals): Promise<void>;

  alive(handle: AgentHandle | null): Promise<Liveness>;

  reap(handle: AgentHandle | null, createdAt: number, enabled: boolean): ReapDecision;
}
