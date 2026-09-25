import { authFailure, signedOutText, type AuthFailure } from "./account";
import { LinkSync, linkCandidate, type LinkCandidate, type LinkScope, type LinkSyncStatus } from "./agentLinks";
import { forgetAttachments } from "./attach";
import { forgetAllConfig, rememberConfig, rememberedConfig } from "./configMemory";
import { claimEcho, clearEcho, landEcho, settleEcho, type PendingEcho } from "./echo";
import { forgetHiddenFinished } from "./finishedTasks";
import { forgetAsks } from "./ask";
import { forgetChoices } from "./choices";
import * as cp from "./cp";
import { DaemonClient } from "./daemon";
import { ApiError, errorText, isTransportFailure, meansLater } from "./http";
import type { InstanceConfig } from "./instance";
import { keyOf, machineId, refOf, sessionId, type MachineId, type SessionKey, type SessionRef } from "./ids";
import { describe, MachineConnection, type MachineState } from "./machine";
import {
  addNativeAccount,
  confirmNativeAccount,
  controlPlaneOrigin,
  DAEMON_CONFIG,
  DAEMON_EXIT,
  daemonState,
  forgetNativeAccount,
  hostReady,
  localDaemon,
  nativeBoot,
  nativeHydrating,
  startLocalDaemon,
  switchNativeAccount,
  type NativeBoot,
  type NativeBound,
} from "./native";
import { isTruncationMarker } from "./permission";
import { hostPlatform, localNetworkDetail } from "./platform";
import { mayAddMachine } from "./quota";
import { machineDisplayName, machineOrder, machineOrderVersion, orderMachines } from "./machineOrder";
import { mergeOptimistic } from "./sessionOrder";
import { provideSignInAuth } from "./signInAuth";
import { confirmDue } from "./slot";
import { SessionStream, type StreamSink, type StreamStatus } from "./stream";
import {
  countsAsLive,
  hasLiveAgent,
  needsHuman,
  oldestWait,
  showsAsEnded,
  type AgentCommand,
  type AgentConfig,
  type CreatedMachine,
  type LaggedFrame,
  type Me,
  type PendingElicitationSnapshot,
  type PendingPermissionSnapshot,
  type PluginSummary,
  type SessionSnapshot,
  type StoredEvent,
} from "./wire";

const POLL_INTERVAL_MS = 4_000;
const OFFLINE_RETRY_MS = 15_000;
const MAX_LIVE_STREAMS = 3;
export const MAX_HELD_TRANSCRIPTS = 12;
/** Bytes, never an event count: the only ceiling a tab has, per session. */
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
export const MAX_AUTO_HISTORY = 5_000;
/** Mirrors the daemon's `EVENTS_PAGE_LIMIT`; its byte cap still governs heavy pages. */
export const HISTORY_PAGE = 5_000;
/** Mirrors the daemon's `ATTACH_REPLAY_MAX`: asking for more silently gets less. */
export const ATTACH_REPLAY_MAX = 2_000;
const PRIME_WINDOW = 60;
const SESSION_LIST_LIMIT = 60;

export interface Gap {
  from: number;
  to: number;
  reason: "evicted" | "slow_consumer";
}

export interface SessionRow {
  key: SessionKey;
  ref: SessionRef;
  machineName: string;
  snapshot: SessionSnapshot;
  /** Daemon clock at fetch and ours at that instant; elapsed time uses both, since a slept phone's clock drifts. */
  daemonNow: number;
  fetchedAt: number;
  heldConfig?: AgentConfig;
}

export interface Transcript {
  events: StoredEvent[];
  gaps: Gap[];
  heldBytes: number;
  loadedFrom: number;
  daemonFirstSeq: number;
  /** The agent's `/clear` cut; nothing offers the conversation above it back. */
  clearedAt: number | null;
  loadingHistory: boolean;
  stream: StreamStatus | null;
}

const EVENT_SIZE = new WeakMap<StoredEvent, number>();

export function sizeOfEvent(stored: StoredEvent): number {
  const known = EVENT_SIZE.get(stored);
  if (known !== undefined) return known;
  let size: number;
  try {
    size = JSON.stringify(stored).length;
  } catch {
    size = 512;
  }
  EVENT_SIZE.set(stored, size);
  return size;
}

export function sizeOfEvents(events: readonly StoredEvent[]): number {
  let total = 0;
  for (const stored of events) total += sizeOfEvent(stored);
  return total;
}

/** Replays a lag down the socket only up to the daemon's `ATTACH_REPLAY_MAX`; beyond it, or with nothing held, drop and re-page. */
export function reattachSince(heldLast: number | null, daemonLast: number): { since: number; keepHeld: boolean } {
  if (heldLast === null) return { since: daemonLast, keepHeld: false };
  // Ahead of the poll-stale row: resume from the held tail, or the overlap is appended twice.
  if (heldLast >= daemonLast) return { since: heldLast, keepHeld: true };
  if (daemonLast - heldLast <= ATTACH_REPLAY_MAX) return { since: heldLast, keepHeld: true };
  return { since: daemonLast, keepHeld: false };
}

export type GapPlan = { kind: "restart"; loadedFrom: number } | { kind: "record"; reason: Gap["reason"] };

/** `backlog` is no loss (the daemon still holds it), so it restarts above what is held; only the others are holes. */
export function gapPlan(reason: LaggedFrame["reason"], to: number): GapPlan {
  if (reason === "backlog") return { kind: "restart", loadedFrom: to + 1 };
  return { kind: "record", reason };
}

export interface HistoryWindow {
  block: StoredEvent[];
  /** Null when no page answered, which must never read as a floor of zero. */
  firstSeq: number | null;
  closed: boolean;
  fetched: number;
}

/** A byte-capped page drops its newest events, so only a `closed` window may be prepended. */
export async function fillWindow(
  fetchPage: (since: number) => Promise<{ events: readonly StoredEvent[]; firstSeq: number }>,
  loadedFrom: number,
  budget: number,
): Promise<HistoryWindow> {
  const top = loadedFrom - 1;
  const block: StoredEvent[] = [];
  let cursor = Math.max(0, top - HISTORY_PAGE);
  let firstSeq: number | null = null;
  let fetched = 0;

  while (cursor < top && fetched < budget) {
    const page = await fetchPage(cursor);
    firstSeq = page.firstSeq;
    const got = page.events.filter((stored) => stored.seq > cursor && stored.seq <= top);
    if (got.length === 0) break;
    block.push(...got);
    fetched += got.length;
    cursor = got[got.length - 1]!.seq;
  }

  return { block, firstSeq, closed: cursor >= top, fetched };
}

export type LoadStop = "start_of_log" | "cleared" | "held_full";

export interface LoadState {
  loadedFrom: number;
  daemonFirstSeq: number;
  clearedAt: number | null;
  heldEvents: number;
  heldBytes: number;
}

/** The floor is `max(1, daemonFirstSeq)`, so a pruned log cannot loop requests. */
export function loadStop(held: LoadState): LoadStop | null {
  if (held.loadedFrom <= Math.max(1, held.daemonFirstSeq)) return "start_of_log";
  if (held.clearedAt !== null) return "cleared";
  if (held.heldBytes >= MAX_TRANSCRIPT_BYTES) return "held_full";
  return null;
}

export type TranscriptNotice =
  | { kind: "skeleton" }
  | { kind: "loading"; earlier: number }
  | { kind: "stalled"; earlier: number }
  | { kind: "ceiling"; held: number }
  | { kind: "floor"; destroyed: number }
  | { kind: "empty" }
  | null;

export interface NoticeState extends LoadState {
  loadingHistory: boolean;
  rows: number;
}

export function transcriptNotice(held: NoticeState): TranscriptNotice {
  if (held.clearedAt !== null) return null;
  const destroyed = held.daemonFirstSeq > 1 ? held.daemonFirstSeq - 1 : 0;
  const unfetched = Math.max(0, held.loadedFrom - Math.max(1, held.daemonFirstSeq));
  if (unfetched === 0) {
    if (destroyed > 0) return { kind: "floor", destroyed };
    return held.rows === 0 ? { kind: "empty" } : null;
  }
  if (loadStop(held) === "held_full") return { kind: "ceiling", held: held.heldEvents };
  if (held.rows === 0) return { kind: "skeleton" };
  return held.loadingHistory ? { kind: "loading", earlier: unfetched } : { kind: "stalled", earlier: unfetched };
}

/** Outlasts the daemon's own redial, up to 30 s; a fixed table so webcheck can assert it. */
export const HISTORY_RETRY_MS: readonly number[] = [500, 2_000, 5_000, 10_000, 20_000];

export function historyRetry(attempt: number, error: unknown): number | null {
  if (!isTransportFailure(error) && !meansLater(error)) return null;
  return HISTORY_RETRY_MS[attempt] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopFor(held: Transcript | undefined): LoadStop | null {
  if (held === undefined) return null;
  return loadStop({
    loadedFrom: held.loadedFrom,
    daemonFirstSeq: held.daemonFirstSeq,
    clearedAt: held.clearedAt,
    heldEvents: held.events.length,
    heldBytes: held.heldBytes,
  });
}

export function nextCut(clearedAt: number | null, batch: readonly StoredEvent[]): number | null {
  let cut = clearedAt;
  for (const stored of batch) {
    if (stored.event.type !== "context_cleared") continue;
    cut = stored.seq;
  }
  return cut;
}

export type CommandsPlan = "fetch" | "drop" | "defer" | "current";

/** Storage is a fallback where holdConfig answers undefined, never an override. */
function rememberHeld(key: SessionKey, held: AgentConfig | undefined): AgentConfig | undefined {
  if (held === undefined || held.options.length === 0) return rememberedConfig(key);
  rememberConfig(key, held);
  return held;
}

/** The live agent always wins, even publishing nothing; the held set shows only while no agent is live. */
export function holdConfig(
  held: AgentConfig | undefined,
  session: Pick<SessionSnapshot, "status" | "agentConfig">,
): AgentConfig | undefined {
  const live = session.agentConfig;
  if ((live?.options.length ?? 0) > 0) {
    // Merged by id: a control the model dropped (claude's effort list follows `supportedEffortLevels`) is kept and drawn unavailable.
    const byId = new Map((live?.options ?? []).map((option) => [option.id, option]));
    const dropped = (held?.options ?? []).filter((option) => !byId.has(option.id));
    if (dropped.length === 0) return live;
    return { modes: live?.modes ?? null, options: [...(live?.options ?? []), ...dropped] };
  }
  if (hasLiveAgent(session.status)) return live;
  return held;
}

function onRecordPermissions(held: SessionSnapshot): Set<string> {
  if (held.reduced === undefined) return new Set(held.pendingPermissions.map((row) => row.permissionId));
  return new Set(held.reduced.onRecord ?? []);
}

/** Never shrinks a parked list or lets a stand-in replace a held payload; tops up only rows newer than the frame's last. */
export function unreduceSnapshot(next: SessionSnapshot, held: SessionSnapshot | undefined): SessionSnapshot {
  const reduced = next.reduced;
  if (reduced === undefined) return next;
  if (held === undefined || held.id !== next.id) return next;

  const heldPermissions = new Map(held.pendingPermissions.map((row) => [row.permissionId, row]));
  const onFrame = new Set(next.pendingPermissions.map((row) => row.permissionId));
  const onRecord = onRecordPermissions(held);

  const whole = (value: unknown): boolean => value !== null && value !== undefined && !isTruncationMarker(value);

  const repaired: PendingPermissionSnapshot[] = next.pendingPermissions.map((pending) => {
    const before = heldPermissions.get(pending.permissionId);
    if (before === undefined) return pending;
    return {
      ...pending,
      rawInput: isTruncationMarker(pending.rawInput) && whole(before.rawInput) ? before.rawInput : pending.rawInput,
      content: isTruncationMarker(pending.content) && whole(before.content) ? before.content : pending.content,
    };
  });

  const permissionCutoff = next.pendingPermissions.at(-1)?.raisedAt;
  const permissions = [
    ...repaired,
    ...held.pendingPermissions.filter(
      (row) => !onFrame.has(row.permissionId) && (permissionCutoff === undefined || row.raisedAt > permissionCutoff),
    ),
  ].slice(0, Math.max(reduced.pendingPermissions, repaired.length));

  const frameQuestions = next.pendingElicitations ?? [];
  const questionsOnFrame = new Set(frameQuestions.map((row) => row.elicitationId));
  const questionCutoff = frameQuestions.at(-1)?.raisedAt;
  const questions: PendingElicitationSnapshot[] = [
    ...frameQuestions,
    ...(held.pendingElicitations ?? []).filter(
      (row) => !questionsOnFrame.has(row.elicitationId) && (questionCutoff === undefined || row.raisedAt > questionCutoff),
    ),
  ].slice(0, Math.max(reduced.pendingElicitations, frameQuestions.length));

  return {
    ...next,
    pendingPermissions: permissions,
    pendingElicitations: questions,
    reduced: {
      ...reduced,
      onRecord: permissions.map((row) => row.permissionId).filter((id) => onRecord.has(id)),
      blobs:
        reduced.blobs &&
        permissions.some(
          (row) =>
            !onRecord.has(row.permissionId) &&
            (isTruncationMarker(row.rawInput) || isTruncationMarker(row.content)),
        ),
    },
  };
}

export function commandsPlan(
  held: number | undefined,
  revision: number | undefined,
  inFlight: boolean,
): CommandsPlan {
  if (revision === undefined || revision === 0) return "drop";
  if (held === revision) return "current";
  if (inFlight) return "defer";
  return "fetch";
}

export interface AgentCommandList {
  commands: readonly AgentCommand[];
  dropped: number;
}

const SETUP_POLL_MS = 1_000;

const SETUP_SETTLE_MS = 30_000;

const SETUP_SLOW_POLL_MS = 5_000;

const SETUP_GIVE_UP_MS = 5 * 60_000;

const FOREIGN_ENV_DETAIL =
  "The daemon settings Reemoat keeps on this computer for this server name a different server, or could not be read, " +
  "so they were left alone. Moving this server's folder in ~/.reemoat/servers aside lets Reemoat set this computer up here again.";

/** Never for a `stranger`; the first sentence is quoted in docs/NATIVE.md (Q7.149). */
const FOREIGN_DAEMON_DETAIL =
  "A Reemoat daemon for this server is already running on this computer, as a machine this account cannot see, " +
  "so Reemoat left it alone. The account that set it up can use it — switch to it, or add it, from the menu — " +
  "or its owner can share it with you.";

const ANOTHER_DAEMON_DETAIL =
  "Another Reemoat daemon for this server is already running on this computer, so the one Reemoat started could not. " +
  "It is reachable, but it belongs to a different machine — stop it, or use that machine instead.";

const SLOW_START_DETAIL = "The daemon on this computer has not finished starting yet.";

const LOGS_POINTER = "Settings → Logs has what it printed.";

const DAEMON_STOPPED_DETAIL = `The daemon Reemoat started on this computer stopped. ${LOGS_POINTER}`;

const STRANGER_DAEMON_DETAIL =
  `${DAEMON_STOPPED_DETAIL} ` +
  "A Reemoat daemon for a different server is running here too, and stopping it may let this one start.";

const GAVE_UP_DETAIL = `The daemon on this computer did not finish starting. ${LOGS_POINTER}`;

/** Shapes toward the control plane's `MACHINE_LABEL` and lets it refuse; slices to 64 last. */
export function machineLabelFor(hostName: string | null): string {
  const shaped = (hostName ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/[-._]+$/, "")
    .slice(0, 64);
  return shaped.length > 0 ? shaped : "computer";
}

/** Identity is not reachability (Q7.139): a missed probe never clears it, and an unheld machine never displaces one. */
export function localMachineAfter(
  known: MachineId | null,
  answer: MachineId | null,
  held: (id: MachineId) => boolean,
): MachineId | null {
  if (answer === null || answer === known) return known;
  if (known === null || held(answer)) return answer;
  return known;
}

export interface SetupState {
  step: "creating" | "starting" | "failed";
  said: string | null;
}

export interface AppState {
  phase: "signed_out" | "loading" | "ready";
  host: NativeBoot | null;
  pickingServer: boolean;
  /** Drawn, never stored: seeded from `NativeBoot.claimed`, then sticky. Null in a browser. */
  localMachineId: MachineId | null;
  me: Me | null;
  machines: MachineState[];
  rootsByMachine: ReadonlyMap<MachineId, readonly string[]>;
  pluginsByMachine: ReadonlyMap<MachineId, readonly PluginSummary[]>;
  sessions: SessionRow[];
  rowsByKey: ReadonlyMap<SessionKey, SessionRow>;
  /** Tells not-on-that-daemon from not-asked-yet. */
  listed: ReadonlySet<MachineId>;
  transcripts: ReadonlyMap<SessionKey, Transcript>;
  commands: ReadonlyMap<SessionKey, AgentCommandList>;
  /** Never written to `cpError`, which would take over the whole app. */
  setup: SetupState | null;
  cpError: string | null;
  config: InstanceConfig | null;
  authError: string | null;
  resuming: boolean;
  lastResumeAt: number | null;
}

const EMPTY_TRANSCRIPT: Transcript = {
  events: [],
  gaps: [],
  heldBytes: 0,
  loadedFrom: 0,
  daemonFirstSeq: 0,
  clearedAt: null,
  loadingHistory: false,
  stream: null,
};

class AppStore implements StreamSink {
  private listeners = new Set<() => void>();
  private snapshot: AppState = {
    // The keyring answer is async, so a native launch starts loading instead of flashing sign-in.
    phase: cp.currentCredential() === null && !nativeHydrating() ? "signed_out" : "loading",
    setup: null,
    host: null,
    pickingServer: false,
    localMachineId: null,
    me: null,
    machines: [],
    rootsByMachine: new Map(),
    pluginsByMachine: new Map(),
    sessions: [],
    rowsByKey: new Map(),
    listed: new Set(),
    transcripts: new Map(),
    commands: new Map(),
    cpError: null,
    config: null,
    authError: null,
    resuming: false,
    lastResumeAt: null,
  };

  private connections = new Map<MachineId, MachineConnection>();
  private daemons = new Map<MachineId, DaemonClient>();
  private listed = new Set<MachineId>();
  private rows = new Map<SessionKey, SessionRow>();
  private transcripts = new Map<SessionKey, Transcript>();
  /** Bumped when a transcript is replaced; a history run whose generation moved discards its fetch. */
  private transcriptGen = new Map<SessionKey, number>();
  private streams = new Map<SessionKey, SessionStream>();
  private streamOrder: SessionKey[] = [];
  private nextProbeAt = new Map<MachineId, number>();
  private primed = new Set<SessionKey>();
  private commandLists = new Map<SessionKey, { revision: number; commands: AgentCommand[]; dropped: number }>();
  private commandsInFlight = new Set<SessionKey>();
  private commandsWanted = new Map<SessionKey, number>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly links = new LinkSync({
    link: (id) => cp.linkMachine(id),
    push: async (id, links) => {
      const daemon = this.daemons.get(machineId(id));
      if (daemon === undefined) throw new Error("that machine is no longer in the list");
      await daemon.putPeerLinks(links);
    },
    now: () => Date.now(),
  });
  private resumeInFlight: Promise<void> | null = null;
  private resumeQueued = false;
  private epoch = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppState => this.snapshot;

  private readonly rootsByMachine = new Map<MachineId, readonly string[]>();

  // Chained per session, because meta assigns rather than merges.
  private readonly metaWrites = new Map<
    SessionKey,
    { patch: { pinned?: boolean; rank?: number | null }; inFlight: number; queue: Promise<unknown> }
  >();
  private readonly pluginsByMachine = new Map<MachineId, readonly PluginSummary[]>();
  private machinesCache: MachineState[] | null = null;
  private sessionsCache: SessionRow[] | null = null;
  private rowsByKeyCache: ReadonlyMap<SessionKey, SessionRow> | null = null;
  private listedCache: ReadonlySet<MachineId> | null = null;
  private transcriptsCache: ReadonlyMap<SessionKey, Transcript> | null = null;
  private commandsCache: ReadonlyMap<SessionKey, AgentCommandList> | null = null;

  private emit(): void {
    this.machinesCache = null;
    this.sessionsCache = null;
    this.rowsByKeyCache = null;
    this.listedCache = null;
    this.transcriptsCache = null;
    this.commandsCache = null;
    this.publish();
  }

  private emitTranscripts(): void {
    this.transcriptsCache = null;
    this.publish();
  }

  private publish(): void {
    this.machinesCache ??= [...this.connections.values()].map((c) => c.state());
    this.sessionsCache ??= [...this.rows.values()];
    this.rowsByKeyCache ??= new Map(this.rows);
    this.listedCache ??= new Set(this.listed);
    this.transcriptsCache ??= new Map(this.transcripts);
    this.commandsCache ??= new Map(
      [...this.commandLists].map(([key, entry]) => [key, { commands: entry.commands, dropped: entry.dropped }] as const),
    );
    this.snapshot = {
      ...this.snapshot,
      machines: this.machinesCache,
      rootsByMachine: this.rootsByMachine,
      pluginsByMachine: this.pluginsByMachine,
      sessions: this.sessionsCache,
      rowsByKey: this.rowsByKeyCache,
      listed: this.listedCache,
      transcripts: this.transcriptsCache,
      commands: this.commandsCache,
    };
    for (const listener of this.listeners) listener();
  }

  private patch(fields: Partial<AppState>): void {
    this.snapshot = { ...this.snapshot, ...fields };
    this.emit();
  }

  async bootstrap(): Promise<void> {
    // Above the credential check: the signed-out screen needs config for its links.
    void this.loadConfig();

    const boot = await hostReady;
    if (boot !== null) {
      cp.adoptHydratedCredential(boot.credential);
      this.patch({ host: nativeBoot() ?? boot });
      this.seedLocalMachine(boot.claimed);
    }

    if (cp.currentCredential() === null) {
      this.patch({ phase: "signed_out" });
      return;
    }
    this.patch({ phase: "loading", cpError: null });

    try {
      const [me, machines] = await Promise.all([
        cp.me(),
        // Only the password wall is tolerated, keyed on the code, so the screen that fixes it can draw.
        cp.machines().catch((error: unknown) => {
          if (ApiError.isApiError(error) && error.code === "password_change_required") return [];
          throw error;
        }),
        this.refreshLocalMachine(),
      ]);
      for (const record of machines) {
        const id = machineId(record.id);
        const existing = this.connections.get(id);
        if (existing) {
          existing.update(record);
        } else {
          this.connections.set(id, new MachineConnection(record, () => this.emit()));
        }
      }
      for (const id of [...this.connections.keys()]) {
        if (!machines.some((m) => m.id === id)) this.dropMachine(id);
      }
      for (const [id, connection] of this.connections) {
        if (!this.daemons.has(id)) this.daemons.set(id, new DaemonClient(connection));
      }
      this.registryKnown = true;
      this.weighLocalMachine();
      this.patch({ phase: "ready", me, cpError: null, authError: null });
    } catch (error) {
      // `authFailure` keys on the code: a non-admin's 403 is not a sign-out.
      if (authFailure(error) !== null) return;
      // An outage still draws the app, so the menu reaches other accounts.
      this.patch({ phase: "ready", cpError: describe(error) });
    }

    // Host order: confirm the account, register the device, then set up. True means this document is leaving.
    if (await this.confirmAccount()) return;
    await this.ensureDevice();

    await this.beginSetUp();

    this.startPolling();
    await this.resume("bootstrap");
  }

  private async ensureDevice(): Promise<void> {
    if (cp.currentDevice() !== null && cp.deviceBound()) return;
    try {
      await cp.registerDevice();
    } catch {
      // Bookkeeping: nothing depends on having a device.
    }
  }

  /** The host proves the account (Q1.651); on `existing` it has already kept or revoked the token, so the page only drops its copy. */
  private async confirmAccount(): Promise<boolean> {
    if (!confirmDue(nativeBoot(), this.snapshot.me)) return false;
    let answer: NativeBound;
    try {
      answer = await confirmNativeAccount();
    } catch {
      return false;
    }
    if (answer.outcome === "existing") {
      // Never logout(): an adopted token is now that account's session, and a revoked one answers 401, which sweeps forgetAllConfig.
      cp.detachSession();
      const moved = await forgetNativeAccount().catch(() => ({ reload: true }));
      if (moved.reload) window.location.replace("/");
      return true;
    }
    this.patch({ host: nativeBoot() });
    return false;
  }

  /** Released on settle, so Retry can run setup again. */
  private settingUp: Promise<void> | null = null;

  private registryKnown = false;

  private beginSetUp(): Promise<void> {
    this.settingUp ??= this.setUpThisComputer().finally(() => {
      this.settingUp = null;
    });
    return this.settingUp;
  }

  /** Never throws and never writes `cpError`: every failure lands in `setup`. */
  private async setUpThisComputer(): Promise<void> {
    const boot = this.snapshot.host;
    if (boot === null) return;

    try {
      const state = await daemonState();
      if (state === null || state.status === "unsupported") return;
      // A stranger is silent, our own machine is adopted, anything else is a sentence (Q7.148, Q7.149).
      // Only with the machine list in hand, or our own daemon would read as one we cannot see.
      if (state.status === "foreign" || state.status === "running") {
        if (state.stranger) return;
        if (this.snapshot.phase !== "ready") return;
        if (!this.registryKnown) return;
        if (state.machineId !== null && this.connections.has(machineId(state.machineId))) return;
        this.patch({ setup: { step: "failed", said: FOREIGN_DAEMON_DETAIL } });
        return;
      }
      if (state.status !== "absent" && state.status !== "exited") return;

      if (state.config === DAEMON_CONFIG.elsewhere) {
        this.patch({ setup: { step: "failed", said: FOREIGN_ENV_DETAIL } });
        return;
      }

      if (state.config === DAEMON_CONFIG.here) {
        this.patch({ setup: { step: "starting", said: null } });
        await startLocalDaemon("", "");
        await this.settleDaemon(state.claimed);
        return;
      }

      // A daemon already running for this server: adopt it, never buy or re-mint (Q7.148).
      const here = await localDaemon();
      if (here !== null && this.connections.has(machineId(here.machineId))) return;

      if (state.claimed !== null) {
        if ((await this.remintFor(state.claimed)) !== "dead") return;
      }

      if (!mayAddMachine(this.snapshot.me)) return;

      this.patch({ setup: { step: "creating", said: null } });
      const created = await this.createForThisComputer(boot);
      if (created === null) return;

      this.patch({ setup: { step: "starting", said: null } });
      await startLocalDaemon(created.enrollment.code, created.machine.id);
      await this.machinesChanged("machine-added");
      this.weighLocalMachine(machineId(created.machine.id));
      await this.settleDaemon(created.machine.id);
    } catch (error) {
      this.patch({ setup: { step: "failed", said: describe(error) } });
    }
  }

  /** Retries once on a refused code, never by reading the daemon's log. */
  private async settleDaemon(claim: string | null, retried = false): Promise<void> {
    const slowFrom = Date.now() + SETUP_SETTLE_MS;
    const giveUpAt = Date.now() + SETUP_GIVE_UP_MS;
    let slowed = false;
    for (;;) {
      await sleep(Date.now() < slowFrom ? SETUP_POLL_MS : SETUP_SLOW_POLL_MS);
      const state = await daemonState();
      if (state === null) return;
      if (state.status === "running") {
        this.patch({ setup: null });
        await this.machinesChanged("machine-added");
        return;
      }
      // Here `foreign` means our child lost to another daemon and never enrolled.
      if (state.status === "foreign") {
        const said = state.stranger ? STRANGER_DAEMON_DETAIL : ANOTHER_DAEMON_DETAIL;
        this.patch({ setup: { step: "failed", said } });
        return;
      }
      if (state.status === "exited") {
        // Only a refused-code exit is something a fresh code can fix.
        if (state.exitCode === DAEMON_EXIT.localNetworkBlocked) {
          const said = `${localNetworkDetail(hostPlatform(this.snapshot.host?.platform))} ${LOGS_POINTER}`;
          this.patch({ setup: { step: "failed", said } });
          return;
        }
        if (!retried && state.exitCode === DAEMON_EXIT.codeRefused) {
          const machine = claim ?? state.claimed;
          if (machine !== null) {
            const again = await this.remintFor(machine);
            if (again !== "dead") return;
          }
          if (await this.provisionOver()) return;
        }
        this.patch({ setup: { step: "failed", said: DAEMON_STOPPED_DETAIL } });
        return;
      }
      if (Date.now() >= giveUpAt) {
        this.patch({ setup: { step: "failed", said: GAVE_UP_DETAIL } });
        return;
      }
      if (!slowed && Date.now() >= slowFrom) {
        slowed = true;
        this.patch({ setup: { step: "starting", said: SLOW_START_DETAIL } });
      }
    }
  }

  private async provisionOver(): Promise<boolean> {
    const boot = this.snapshot.host;
    if (boot === null || !mayAddMachine(this.snapshot.me)) return false;
    this.patch({ setup: { step: "creating", said: null } });
    const created = await this.createForThisComputer(boot);
    if (created === null) return false;
    this.patch({ setup: { step: "starting", said: null } });
    await startLocalDaemon(created.enrollment.code, created.machine.id);
    await this.machinesChanged("machine-added");
    this.weighLocalMachine(machineId(created.machine.id));
    await this.settleDaemon(created.machine.id, true);
    return true;
  }

  /** `dead` only on a named refusal; `later` after reporting any other failure. */
  private async remintFor(machineId: string): Promise<"used" | "dead" | "later"> {
    let again;
    try {
      again = await cp.mintEnrollment(machineId);
    } catch (error) {
      // Anything but a named refusal would spend a permanent machine slot on a live machine.
      const gone =
        ApiError.isApiError(error) && (error.code === "machine_not_found" || error.code === "machine_revoked");
      if (gone) return "dead";
      this.patch({ setup: { step: "failed", said: errorText(error) } });
      return "later";
    }
    this.patch({ setup: { step: "starting", said: null } });
    await startLocalDaemon(again.code, machineId);
    await this.machinesChanged("machine-added");
    await this.settleDaemon(machineId, true);
    return "used";
  }

  private async createForThisComputer(boot: NativeBoot): Promise<CreatedMachine | null> {
    // The host name, never `local`: every client reads this label.
    const base = machineLabelFor(boot.hostName);
    try {
      return await cp.createMachine(base);
    } catch (error) {
      if (!ApiError.isApiError(error) || error.code !== "machine_exists") throw error;
      // Sliced first because machineLabelFor truncates last (webcheck pins it).
      const named = machineLabelFor(`${base.slice(0, 61)}-2`);
      if (named === base) throw error;
      return await cp.createMachine(named);
    }
  }

  private dropMachine(id: MachineId): void {
    for (const [key, row] of this.rows) {
      if (row.ref.machineId === id) {
        this.forgetSession(key);
      }
    }
    this.connections.delete(id);
    this.daemons.delete(id);
    this.listed.delete(id);
    this.nextProbeAt.delete(id);
  }

  /** Bare catch: an old control plane's 404 is not an outage. */
  private async loadConfig(): Promise<void> {
    try {
      this.patch({ config: await cp.instanceConfig() });
    } catch {
      // See above. An older control plane is not a failure to report.
    }
  }

  async refreshConfig(): Promise<void> {
    await this.loadConfig();
  }

  async login(name: string, password: string): Promise<void> {
    let me: Me;
    try {
      me = await cp.login(name, password);
    } catch (cause) {
      if (!(cause instanceof cp.AccountAlreadyOpen)) throw cause;
      await this.switchAccount(cause.account);
      return;
    }
    this.patch({ me, authError: null });
    await this.bootstrap();
  }

  /** No `detachSession`: the host either shows another window, and this page stays live, or rebinds this one, whose rotated generation refuses late calls (Q5.120). */
  async switchAccount(account: string | null): Promise<void> {
    const moved = await switchNativeAccount(account);
    if (moved.reload) window.location.replace("/");
  }

  switchBack(): Promise<void> {
    return this.switchAccount(null);
  }

  async addAccount(): Promise<void> {
    const moved = await addNativeAccount();
    if (moved.reload) window.location.replace("/");
  }

  /** One tap, no confirmation: the device id, key and daemon root are kept, so signing in again restores everything (Q7.149). */
  async forgetAccount(): Promise<void> {
    const moved = await forgetNativeAccount();
    if (moved.reload) window.location.replace("/");
  }

  // The browser has no API-key sign-in (no `useApiKey`), yet `pickStored` and `readStoredCredential` must still adopt a stored `rk_` so a deploy does not sign old tabs out.

  async refreshMe(): Promise<void> {
    try {
      const me = await cp.me();
      this.patch({ me });
    } catch {
      // Deliberately empty: a finished credential has already signed this tab out inside `cpFetch`.
    }
  }

  private seedLocalMachine(claimed: string | null): void {
    if (!claimed || this.snapshot.localMachineId !== null) return;
    this.patch({ localMachineId: machineId(claimed) });
  }

  /** Merged through `localMachineAfter`, never assigned, so a missed probe cannot undo a known answer. */
  private async refreshLocalMachine(): Promise<void> {
    const found = await localDaemon();
    this.announcedMachine = found === null ? null : machineId(found.machineId);
    this.weighLocalMachine();
  }

  private announcedMachine: MachineId | null = null;

  private weighLocalMachine(answer: MachineId | null = this.announcedMachine): void {
    const known = this.snapshot.localMachineId;
    const id = localMachineAfter(known, answer, (one) => this.connections.has(one));
    if (id !== known) this.patch({ localMachineId: id });
  }

  /** Also refreshes `me`: the machine limit is counted there, and `resume` alone does not re-read it. */
  async machinesChanged(reason: string): Promise<void> {
    await Promise.all([this.resume(reason), this.refreshMe()]);
  }

  forgetMachine(id: MachineId): void {
    this.dropMachine(id);
    this.emit();
  }

  forgetMachineRoute(id: MachineId): void {
    this.connections.get(id)?.forgetRoute();
  }

  handleSignedOut(failure: AuthFailure): void {
    this.stopPolling();
    for (const id of [...this.connections.keys()]) this.dropMachine(id);
    // Only `device_revoked` gives up the device id; any other sign-out keeps it.
    if (failure === "device_revoked") cp.forgetDevice();
    // Both sign-out paths sweep remembered controls.
    forgetAllConfig();
    this.patch({ phase: "signed_out", me: null, cpError: null, authError: signedOutText(failure) });
  }

  /** Revokes server-side before reloading; the shell keeps the device and daemon root (Q7.149). */
  async signOut(): Promise<void> {
    await cp.logout();
    forgetAllConfig();
    if (this.snapshot.host === null) {
      window.location.href = "/";
      return;
    }
    const moved = await forgetNativeAccount().catch(() => ({ reload: true }));
    if (moved.reload) window.location.replace("/");
  }

  pickServer(): void {
    this.patch({ pickingServer: true });
  }

  cancelServerPick(): void {
    this.patch({ pickingServer: false });
  }

  /** Machines run independently: an unreachable one never delays the rest. */
  async resume(reason: string): Promise<void> {
    if (this.resumeInFlight !== null) {
      // Coalesce: one unlock fires several wake events.
      this.resumeQueued = true;
      return this.resumeInFlight;
    }

    const run = this.runResume(reason).finally(() => {
      this.resumeInFlight = null;
      if (this.resumeQueued) {
        this.resumeQueued = false;
        void this.resume("coalesced");
      }
    });
    this.resumeInFlight = run;
    return run;
  }

  private async runResume(reason: string): Promise<void> {
    const epoch = ++this.epoch;
    this.patch({ resuming: true });

    await this.refreshLocalMachine();

    if (cp.currentCredential() !== null && reason !== "bootstrap") {
      try {
        const machines = await cp.machines();
        if (epoch === this.epoch) {
          for (const record of machines) {
            const id = machineId(record.id);
            const existing = this.connections.get(id);
            if (existing) existing.update(record);
            else {
              const created = new MachineConnection(record, () => this.emit());
              this.connections.set(id, created);
              this.daemons.set(id, new DaemonClient(created));
            }
          }
          for (const id of [...this.connections.keys()]) {
            if (!machines.some((m) => m.id === id)) this.dropMachine(id);
          }
          this.weighLocalMachine();
          // A successful listing leaves loading even with no machines; only ever upwards.
          const promote = this.snapshot.phase === "loading";
          const firstListing = !this.registryKnown;
          this.registryKnown = true;
          this.patch(promote ? { cpError: null, phase: "ready" } : { cpError: null });
          if (promote || this.snapshot.me === null) void this.refreshMe();
          if (firstListing) void this.beginSetUp();
          // Only while unknown: settings screens re-read it through refreshConfig.
          if (this.snapshot.config === null) void this.loadConfig();
        }
      } catch (error) {
        this.patch({ cpError: describe(error) });
      }
    }

    await Promise.allSettled(
      [...this.connections.values()].map((connection) => this.resumeMachine(connection, epoch)),
    );

    if (epoch === this.epoch) {
      this.patch({ resuming: false, lastResumeAt: Date.now() });
      // After the listing and the probes, so each machine's reach and daemon are this wake's answer.
      const scope = this.linkScope();
      if (scope !== null) void this.links.syncAll(scope, this.linkCandidates());
    }
  }

  private linkScope(): LinkScope | null {
    const me = this.snapshot.me;
    return me === null ? null : { origin: controlPlaneOrigin(), account: me.id };
  }

  private linkCandidates(): LinkCandidate[] {
    return [...this.connections.values()].map((connection) => linkCandidate(connection.state()));
  }

  /** A person's act: past the timing rules, never past a machine that cannot be reached. */
  async resyncLinks(id: MachineId): Promise<void> {
    const scope = this.linkScope();
    if (scope === null) return;
    await this.links.syncOne(scope, this.linkCandidates(), id, true);
  }

  linkStatus(id: MachineId): LinkSyncStatus | null {
    const connection = this.connections.get(id);
    return connection === undefined ? null : this.links.status(linkCandidate(connection.state()));
  }

  private async resumeMachine(connection: MachineConnection, epoch: number): Promise<void> {
    const id = connection.id;

    try {
      await connection.ensureToken();
    } catch {
      return;
    }
    if (epoch !== this.epoch) return;

    connection.forgetRoute();
    const route = await connection.resolveRoute();
    if (epoch !== this.epoch) return;
    if (route === null) {
      this.nextProbeAt.set(id, Date.now() + OFFLINE_RETRY_MS);
      return;
    }

    await this.refreshMachineSessions(connection, epoch);
    if (epoch !== this.epoch) return;

    for (const stream of this.streams.values()) {
      if (stream.ref.machineId === id) stream.reconnect();
    }
  }

  /** The cheap half of resume: re-lists sessions on reachable machines and nothing else. */
  poll(): Promise<void> {
    return this.tick();
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async tick(): Promise<void> {
    const epoch = this.epoch;

    // With no machine known, re-list the registry: startup outage, or a first machine added by its installer.
    if (this.connections.size === 0) {
      // Through `resume`, so it coalesces with a wake instead of minting twice.
      await this.resume(this.snapshot.phase === "loading" ? "cp-retry" : "awaiting-first-machine");
      if (this.connections.size > 0 && epoch === this.epoch) await this.refreshMe();
      return;
    }

    await Promise.allSettled(
      [...this.connections.values()].map(async (connection) => {
        const state = connection.state();
        if (state.reach === "offline") {
          const due = this.nextProbeAt.get(connection.id) ?? 0;
          if (Date.now() < due) return;
          this.nextProbeAt.set(connection.id, Date.now() + OFFLINE_RETRY_MS);
          connection.forgetRoute();
          const route = await connection.resolveRoute();
          if (route === null) return;
          for (const stream of this.streams.values()) {
            if (stream.ref.machineId === connection.id) stream.reconnect();
          }
        }
        await this.refreshMachineSessions(connection, epoch);
      }),
    );
  }

  private async fetchRoots(id: MachineId): Promise<void> {
    const daemon = this.daemons.get(id);
    if (daemon === undefined) return;
    this.rootsByMachine.set(id, []);
    try {
      const listing = await daemon.roots();
      this.rootsByMachine.set(id, listing.roots);
      this.emit();
    } catch {
      // Left empty: rows draw absolute paths.
    }
  }

  private async fetchPlugins(id: MachineId): Promise<void> {
    const daemon = this.daemons.get(id);
    if (daemon === undefined) return;
    this.pluginsByMachine.set(id, []);
    try {
      const listing = await daemon.plugins();
      this.pluginsByMachine.set(id, listing.plugins);
      this.emit();
    } catch {
      // Left empty: same as a daemon with nothing installed.
    }
  }

  refreshPlugins(id: MachineId): void {
    this.pluginsByMachine.delete(id);
    void this.fetchPlugins(id);
  }

  private async refreshMachineSessions(connection: MachineConnection, epoch: number): Promise<void> {
    const daemon = this.daemons.get(connection.id);
    if (daemon === undefined) return;

    let listed;
    try {
      listed = await daemon.listSessions(SESSION_LIST_LIMIT);
    } catch (error) {
      if (!ApiError.isApiError(error)) {
        this.emit();
      }
      return;
    }
    if (epoch !== this.epoch) return;
    this.listed.add(connection.id);
    if (!this.rootsByMachine.has(connection.id)) void this.fetchRoots(connection.id);
    if (!this.pluginsByMachine.has(connection.id)) void this.fetchPlugins(connection.id);

    const name = connection.state().name;
    const fetchedAt = Date.now();
    const seen = new Set<SessionKey>();

    for (const snapshot of listed.sessions) {
      const ref = refOf(connection.id, sessionId(snapshot.id));
      const key = keyOf(ref);
      seen.add(key);
      this.rows.set(key, {
        key,
        ref,
        machineName: name,
        snapshot: mergeOptimistic(snapshot, this.metaWrites.get(key)?.patch),
        daemonNow: listed.now,
        fetchedAt,
        heldConfig: rememberHeld(key, holdConfig(this.rows.get(key)?.heldConfig, snapshot)),
        });
    }

    // Prune only a whole list: under `truncated` an absent row was not asked for.
    if (listed.truncated !== true) {
      for (const key of this.rows.keys()) {
        const row = this.rows.get(key);
        if (row !== undefined && row.ref.machineId === connection.id && !seen.has(key)) {
          this.forgetSession(key);
        }
      }
    }

    this.emit();

    this.attachWanted(connection.id);

    for (const snapshot of listed.sessions) {
      if (needsHuman(snapshot)) {
        void this.primeBlocked(refOf(connection.id, sessionId(snapshot.id)), snapshot);
      }
    }
  }

  /** Opens sockets asked for before their list landed, and re-drives loadAll so a short transcript heals. */
  private attachWanted(id: MachineId): void {
    for (const key of [...this.streamOrder]) {
      const row = this.rows.get(key);
      if (row === undefined || row.ref.machineId !== id) continue;
      if (this.streams.has(key)) void this.loadAll(row.ref);
      else this.openSession(row.ref);
    }
  }

  private async primeBlocked(ref: SessionRef, snapshot: SessionSnapshot): Promise<void> {
    const key = keyOf(ref);
    if (this.transcripts.has(key) || this.primed.has(key)) return;
    const daemon = this.daemons.get(ref.machineId);
    if (daemon === undefined) return;
    this.primed.add(key);

    const since = Math.max(0, snapshot.lastSeq - PRIME_WINDOW);
    try {
      const page = await daemon.events(ref.sessionId, since, PRIME_WINDOW);
      if (this.transcripts.has(key)) return;
      // Through replaceTranscript, so MAX_HELD_TRANSCRIPTS applies here too.
      this.replaceTranscript(key, {
        ...EMPTY_TRANSCRIPT,
        events: page.events,
        heldBytes: sizeOfEvents(page.events),
        loadedFrom: page.events[0]?.seq ?? since + 1,
        daemonFirstSeq: page.firstSeq,
      });
      this.emit();
    } catch {
      this.primed.delete(key);
    }
  }

  /** Revisions compare by inequality: a daemon restart resets them to 0. */
  ensureCommands(ref: SessionRef, revision: number | undefined): void {
    const key = keyOf(ref);
    const plan = commandsPlan(this.commandLists.get(key)?.revision, revision, this.commandsInFlight.has(key));
    if (plan === "current") return;
    if (plan === "drop") {
      if (this.commandLists.delete(key)) this.emit();
      this.commandsWanted.delete(key);
      return;
    }
    if (plan === "defer") {
      if (revision !== undefined) this.commandsWanted.set(key, revision);
      return;
    }
    const daemon = this.daemons.get(ref.machineId);
    if (daemon === undefined) return;
    this.commandsInFlight.add(key);
    this.commandsWanted.delete(key);

    void daemon
      .commands(ref.sessionId)
      .then((page) => {
        // A late answer must not resurrect a forgotten session.
        if (!this.rows.has(key)) return;
        // The daemon's revision, which may have moved in flight.
        this.commandLists.set(key, { revision: page.revision, commands: page.commands, dropped: page.dropped });
        this.emit();
      })
      .catch(() => {
        // Not fatal; allow a later attempt.
      })
      .finally(() => {
        this.commandsInFlight.delete(key);
        const wanted = this.commandsWanted.get(key);
        if (wanted === undefined) return;
        this.commandsWanted.delete(key);
        if (this.commandLists.get(key)?.revision !== wanted) this.ensureCommands(ref, wanted);
      });
  }

  /** Never attaches without the row's `lastSeq`; attachWanted opens it once the list lands. */
  openSession(ref: SessionRef): void {
    const key = keyOf(ref);
    this.streamOrder = [...this.streamOrder.filter((k) => k !== key), key];

    if (!this.streams.has(key)) {
      const connection = this.connections.get(ref.machineId);
      if (connection === undefined) return;
      const row = this.rows.get(key);
      if (row === undefined) return;
      const { since, keepHeld } = reattachSince(
        this.transcripts.get(key)?.events.at(-1)?.seq ?? null,
        row.snapshot.lastSeq,
      );
      if (!keepHeld) this.replaceTranscript(key, { ...EMPTY_TRANSCRIPT, loadedFrom: since + 1, gaps: [] });

      const stream = new SessionStream(ref, connection, this, since);
      this.streams.set(key, stream);
      stream.start();
    }

    // Outside the branch, so history resumes on every open.
    void this.loadAll(ref);

    while (this.streamOrder.length > MAX_LIVE_STREAMS) {
      const evict = this.streamOrder.shift();
      if (evict !== undefined && evict !== key) this.closeStream(evict);
    }
    this.emit();
  }

  private closeStream(key: SessionKey): void {
    const stream = this.streams.get(key);
    if (stream === undefined) return;
    stream.stop();
    this.streams.delete(key);
    this.streamOrder = this.streamOrder.filter((k) => k !== key);
  }

  onEvents(ref: SessionRef, events: StoredEvent[]): void {
    const key = keyOf(ref);
    const current = this.transcripts.get(key) ?? EMPTY_TRANSCRIPT;
    let merged = [...current.events, ...events];
    let loadedFrom = current.loadedFrom;
    let heldBytes = current.heldBytes + sizeOfEvents(events);
    if (heldBytes > MAX_TRANSCRIPT_BYTES) {
      // By bytes from the oldest, subtracting what left rather than re-measuring.
      let keep = 0;
      while (keep < merged.length && heldBytes > MAX_TRANSCRIPT_BYTES) {
        heldBytes -= sizeOfEvent(merged[keep]!);
        keep += 1;
      }
      merged = merged.slice(keep);
      loadedFrom = merged[0]?.seq ?? loadedFrom;
    }
    if (current.events.length === 0 && merged.length > 0) {
      loadedFrom = Math.min(loadedFrom, merged[0]?.seq ?? loadedFrom);
    }

    const clearedAt = nextCut(current.clearedAt, events);

    this.transcripts.set(key, { ...current, events: merged, heldBytes, loadedFrom, clearedAt });
    claimEcho(key, events);
    settleEcho(key, merged.at(-1)?.seq ?? 0);
    this.emitTranscripts();
  }

  onSnapshot(ref: SessionRef, session: SessionSnapshot): void {
    const key = keyOf(ref);
    const existing = this.rows.get(key);
    // Keep the poll's clock pair: it records an offset, and anchoring to ours would draw the drift.
    const unanchored = Date.now();
    this.rows.set(key, {
      key,
      ref,
      machineName: existing?.machineName ?? this.connections.get(ref.machineId)?.state().name ?? "",
      // Through unreduceSnapshot, so a cut frame never clobbers the poll's fuller lists.
      snapshot: mergeOptimistic(unreduceSnapshot(session, existing?.snapshot), this.metaWrites.get(key)?.patch),
      heldConfig: rememberHeld(key, holdConfig(existing?.heldConfig, session)),
      daemonNow: existing?.daemonNow ?? unanchored,
      fetchedAt: existing?.fetchedAt ?? unanchored,
    });
    const transcript = this.transcripts.get(key);
    if (transcript !== undefined) {
      this.transcripts.set(key, { ...transcript, daemonFirstSeq: session.firstSeq });
    }
    this.emit();
  }

  onGap(ref: SessionRef, from: number, to: number, reason: LaggedFrame["reason"]): void {
    if (to < from) return;
    const key = keyOf(ref);
    const current = this.transcripts.get(key) ?? EMPTY_TRANSCRIPT;

    const plan = gapPlan(reason, to);
    if (plan.kind === "restart") {
      this.replaceTranscript(key, { ...EMPTY_TRANSCRIPT, loadedFrom: plan.loadedFrom });
      this.emitTranscripts();
      void this.loadAll(ref);
      return;
    }

    if (current.gaps.some((gap) => gap.from === from && gap.to === to)) return;
    this.transcripts.set(key, { ...current, gaps: [...current.gaps, { from, to, reason: plan.reason }] });
    this.emitTranscripts();
  }

  onStatus(ref: SessionRef, status: StreamStatus): void {
    const key = keyOf(ref);
    const current = this.transcripts.get(key) ?? EMPTY_TRANSCRIPT;
    this.transcripts.set(key, { ...current, stream: status });
    this.emitTranscripts();
  }

  onVanished(ref: SessionRef): void {
    this.forgetSession(keyOf(ref));
    this.emit();
  }

  /** Anything else added per session belongs here too. */
  private forgetSession(key: SessionKey): void {
    this.closeStream(key);
    this.rows.delete(key);
    this.replaceTranscript(key, null);
    this.primed.delete(key);
    // transcriptGen is kept: it must stay monotonic per key, or a stale page passes the guard.
    this.commandLists.delete(key);
    this.commandsInFlight.delete(key);
    this.commandsWanted.delete(key);
    // Also aborts uploads still in flight.
    forgetAttachments(key);
    clearEcho(key);
    forgetHiddenFinished(key);
    forgetAsks(key);
    forgetChoices(key);
  }

  async loadAll(ref: SessionRef): Promise<void> {
    const key = keyOf(ref);
    if (this.transcripts.get(key)?.loadingHistory === true) return;
    const daemon = this.daemons.get(ref.machineId);
    if (daemon === undefined) return;
    // Before the latch, so the per-poll re-drive costs one map read and no emit.
    if (stopFor(this.transcripts.get(key)) !== null) return;
    const gen = this.transcriptGen.get(key) ?? 0;

    this.setTranscript(key, (held) => ({ ...held, loadingHistory: true }));
    this.emitTranscripts();

    let fetched = 0;
    let lastYield = 0;
    try {
      for (;;) {
        const current = this.transcripts.get(key);
        if (current === undefined) return;
        if (stopFor(current) !== null) break;

        // `HISTORY_PAGE` never binds inside a window. Named `filled`: `window` is a global.
        const filled = await fillWindow(
          async (since) => {
            for (let attempt = 0; ; attempt += 1) {
              try {
                const page = await daemon.events(ref.sessionId, since, HISTORY_PAGE);
                if (this.transcripts.get(key) === undefined) return { events: [], firstSeq: page.firstSeq };
                return page;
              } catch (error) {
                // Retried per request to keep the window's progress; rethrows, since an empty page would fake a floor.
                const wait = historyRetry(attempt, error);
                if (wait === null) throw error;
                await sleep(wait);
                if ((this.transcriptGen.get(key) ?? 0) !== gen) throw error;
              }
            }
          },
          current.loadedFrom,
          HISTORY_PAGE,
        );
        fetched += filled.fetched;

        const latest = this.transcripts.get(key);
        if (latest === undefined) return;
        // Replaced mid-window: the block belongs to the previous life.
        if ((this.transcriptGen.get(key) ?? 0) !== gen) return;
        // Unclosed means the daemon's floor is above this window: record it and prepend nothing.
        if (!filled.closed) {
          this.setTranscript(key, (held) => ({ ...held, daemonFirstSeq: filled.firstSeq ?? held.daemonFirstSeq }));
          this.emitTranscripts();
          break;
        }
        const block = filled.block;

        let cleared = latest.clearedAt;
        for (let i = block.length - 1; i >= 0; i -= 1) {
          const stored = block[i];
          if (stored?.event.type === "context_cleared") {
            cleared = stored.seq;
            break;
          }
        }

        this.transcripts.set(key, {
          ...latest,
          events: [...block, ...latest.events],
          heldBytes: latest.heldBytes + sizeOfEvents(block),
          loadedFrom: block[0]!.seq,
          daemonFirstSeq: filled.firstSeq ?? latest.daemonFirstSeq,
          clearedAt: cleared,
        });
        this.emitTranscripts();

        // setTimeout: requestIdleCallback is absent under node and before Safari 17.4.
        if (fetched - lastYield >= MAX_AUTO_HISTORY) {
          lastYield = fetched;
          await sleep(0);
        }
      }
    } catch {
      // Keep what landed; attachWanted re-drives this on the next poll.
    } finally {
      // In `finally`, or an early return leaves the latch on; guarded so a replacement keeps its own latch.
      if ((this.transcriptGen.get(key) ?? 0) === gen) {
        this.setTranscript(key, (held) => ({ ...held, loadingHistory: false }));
        this.emitTranscripts();
      }
    }
  }

  private setTranscript(key: SessionKey, update: (held: Transcript) => Transcript): void {
    const held = this.transcripts.get(key);
    if (held === undefined) return;
    this.transcripts.set(key, update(held));
  }

  /** Every discard goes through here, so an in-flight loadAll cannot prepend into the new life. */
  private replaceTranscript(key: SessionKey, next: Transcript | null): void {
    this.transcriptGen.set(key, (this.transcriptGen.get(key) ?? 0) + 1);
    if (next === null) this.transcripts.delete(key);
    else {
      this.transcripts.set(key, next);
      this.trimTranscripts(key);
    }
  }

  /** Never evicts a streamed conversation; insertion order. */
  private trimTranscripts(just: SessionKey): void {
    if (this.transcripts.size <= MAX_HELD_TRANSCRIPTS) return;
    const live = new Set(this.streamOrder);
    for (const key of [...this.transcripts.keys()]) {
      if (this.transcripts.size <= MAX_HELD_TRANSCRIPTS) return;
      if (key === just || live.has(key) || this.streams.has(key)) continue;
      this.transcriptGen.set(key, (this.transcriptGen.get(key) ?? 0) + 1);
      this.transcripts.delete(key);
      // `primed` goes with it, or this row can never be primed again.
      this.primed.delete(key);
    }
  }

  daemonFor(id: MachineId): DaemonClient | undefined {
    return this.daemons.get(id);
  }

  applySnapshot(ref: SessionRef, session: SessionSnapshot): void {
    this.onSnapshot(ref, session);
  }

  /** Drawn now, errors through `report`; returns whether the write was issued. */
  setSessionMeta(
    ref: SessionRef,
    patch: { title?: string | null; pinned?: boolean; rank?: number | null },
    report: (message: string) => void,
  ): boolean {
    const daemon = this.daemonFor(ref.machineId);
    if (daemon === undefined) return false;
    const key = keyOf(ref);
    const held = this.metaWrites.get(key);
    // Position only: an optimistic title would claim what the daemon has not said.
    const entry = held ?? { patch: {}, inFlight: 0, queue: Promise.resolve() };
    if (patch.pinned !== undefined) entry.patch.pinned = patch.pinned;
    if (patch.rank !== undefined) entry.patch.rank = patch.rank;
    entry.inFlight += 1;
    this.metaWrites.set(key, entry);
    const current = this.rows.get(key);
    if (current !== undefined) this.onSnapshot(ref, current.snapshot);

    const settle = (): void => {
      entry.inFlight -= 1;
      // Nothing outstanding: the daemon's answer is the truth, after a refusal too.
      if (entry.inFlight <= 0) this.metaWrites.delete(key);
    };
    entry.queue = entry.queue.then(async () => {
      try {
        const result = await daemon.setSessionMeta(ref.sessionId, patch);
        settle();
        this.applySnapshot(ref, result.session);
      } catch (cause: unknown) {
        settle();
        report(errorText(cause));
        void this.resume("action-failed");
      }
    });
    return true;
  }

  /** Settles against the log now, since the prompt event often wins the race. */
  promptLanded(ref: SessionRef, sent: PendingEcho, seq: number): void {
    const key = keyOf(ref);
    landEcho(key, sent, seq);
    settleEcho(key, this.transcripts.get(key)?.events.at(-1)?.seq ?? 0);
  }

}

export const store = new AppStore();

cp.onSignedOut((failure) => store.handleSignedOut(failure));

provideSignInAuth(store);

export interface SessionLists {
  blocked: SessionRow[];
  active: SessionRow[];
  ended: SessionRow[];
  /** `countsAsLive`: a restarting session counts, a stalled one does not. */
  countByMachine: ReadonlyMap<MachineId, number>;
}

let listsFor: SessionRow[] | null = null;
let listsCache: SessionLists | null = null;

export function sessionLists(state: AppState): SessionLists {
  if (listsFor === state.sessions && listsCache !== null) return listsCache;

  const blocked: { row: SessionRow; oldest: number }[] = [];
  const active: SessionRow[] = [];
  const ended: SessionRow[] = [];
  const countByMachine = new Map<MachineId, number>();

  for (const row of state.sessions) {
    if (countsAsLive(row.snapshot)) {
      countByMachine.set(row.ref.machineId, (countByMachine.get(row.ref.machineId) ?? 0) + 1);
    }

    if (needsHuman(row.snapshot)) {
      blocked.push({ row, oldest: oldestWait(row.snapshot) });
    } else if (showsAsEnded(row.snapshot)) {
      // `showsAsEnded`: Ended means somebody decided it was over.
      ended.push(row);
    } else {
      active.push(row);
    }
  }

  // Only `blocked` is sorted; the rest are memberships ordered by `orderSessions`.
  blocked.sort((a, b) => a.oldest - b.oldest);

  listsCache = { blocked: blocked.map((entry) => entry.row), active, ended, countByMachine };
  listsFor = state.sessions;
  return listsCache;
}

export interface MachineGroup {
  id: MachineId;
  /** A display name, never a label to write back. */
  name: string;
  reach: MachineState["reach"];
  offlineReason: MachineState["offlineReason"];
  route: MachineState["route"];
  tokenDegraded: boolean;
  overLimit: boolean;
  /** Separate from overLimit: the remedies differ. */
  ownerDisabled: boolean;
  /** A membership, not an order (Q3.12); pinned rows are not here (Q3.11). */
  active: SessionRow[];
  ended: SessionRow[];
  liveCount: number;
  /** So a collapsed section can never hide an approval. */
  blockedCount: number;
}

export interface SessionGroups {
  /** Moved here, not copied: not also in `groups` or `orphans`. */
  pinned: SessionRow[];
  groups: MachineGroup[];
  orphans: SessionRow[];
}

let groupsForSessions: SessionRow[] | null = null;
let groupsForMachines: MachineState[] | null = null;
let groupsForOrder = -1;
let groupsForLocal: MachineId | null = null;
let groupsCache: SessionGroups | null = null;

/** Memoised on sessions, machines, order version and localMachineId; never ordered by reachability. */
export function sessionGroups(state: AppState): SessionGroups {
  if (
    groupsForSessions === state.sessions &&
    groupsForMachines === state.machines &&
    groupsForOrder === machineOrderVersion() &&
    groupsForLocal === state.localMachineId &&
    groupsCache !== null
  ) {
    return groupsCache;
  }

  const lists = sessionLists(state);
  const byId = new Map<MachineId, MachineGroup>();

  for (const machine of state.machines) {
    byId.set(machine.id, {
      id: machine.id,
      name: machineDisplayName(machine, state.localMachineId),
      reach: machine.reach,
      offlineReason: machine.offlineReason,
      route: machine.route,
      tokenDegraded: machine.tokenDegraded,
      overLimit: machine.overLimit,
      ownerDisabled: machine.ownerDisabled,
      active: [],
      ended: [],
      liveCount: lists.countByMachine.get(machine.id) ?? 0,
      blockedCount: 0,
    });
  }

  const pinned: SessionRow[] = [];
  const orphans: SessionRow[] = [];
  // Pinning moves rather than copies.
  const place = (row: SessionRow, into: "active" | "ended"): MachineGroup | null => {
    if (row.snapshot.pinned === true) {
      pinned.push(row);
      return null;
    }
    const group = byId.get(row.ref.machineId);
    if (group === undefined) {
      orphans.push(row);
      return null;
    }
    group[into].push(row);
    return group;
  };

  for (const row of lists.blocked) {
    // Counted off what `place` filed, never a row the header does not draw.
    const filed = place(row, "active");
    if (filed !== null) filed.blockedCount += 1;
  }
  for (const row of lists.active) place(row, "active");
  for (const row of lists.ended) place(row, "ended");

  const groups = orderMachines(
    [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
    machineOrder(),
    state.localMachineId,
  );

  groupsCache = { pinned, groups, orphans };
  groupsForSessions = state.sessions;
  groupsForMachines = state.machines;
  groupsForOrder = machineOrderVersion();
  groupsForLocal = state.localMachineId;
  return groupsCache;
}

export interface DrawnMachine {
  machine: MachineState;
  name: string;
}

export function machinesAsDrawn(state: AppState): DrawnMachine[] {
  const byId = new Map(state.machines.map((machine) => [machine.id, machine] as const));
  return sessionGroups(state).groups.flatMap((group) => {
    const machine = byId.get(group.id);
    return machine === undefined ? [] : [{ machine, name: group.name }];
  });
}

/** Wrong by the row's age, not the clock drift; `now` is injectable for webcheck. */
export function elapsedSince(row: SessionRow, at: number, now: number = Date.now()): number {
  return row.daemonNow - at + (now - row.fetchedAt);
}
