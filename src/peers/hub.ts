import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { PeerOrigin, PeerPolicyKey, PromptMention } from "../events.js";
import type { ManagedSession, MentionNote, MidTurnResult, SessionRegistry, SessionSnapshot } from "../registry.js";
import type { OutboxEntry, PeerLink, SqliteMachineSettingsStore, SqlitePeerOutboxStore } from "../store/sqlite.js";
import type { PeerAnswer } from "./channel.js";
import {
  address,
  isPeerName,
  MAX_PEER_ADDRESS_CHARS,
  MAX_PEER_HARNESS_CHARS,
  mentionNote,
  parseAddress,
  peerMessage,
  peerNotice,
} from "./envelope.js";

export const PEER_SERVER_NAME = "reemoat";
export const MAX_PEER_MESSAGE_CHARS = 32_000;
/** Turns other agents may cause in a session with no message from its person in between. */
export const PEER_TURN_BUDGET = 20;
export const MAX_PEER_HOPS = 8;
export const PEER_SEND_BURST = 5;
/** One send back every 3 s: twenty a minute once the burst is spent. */
export const PEER_SEND_REFILL_MS = 3_000;
/** What one link may deliver here, whatever the machine at its other end claims to enforce. */
export const PEER_LINK_BURST = 20;
export const PEER_LINK_REFILL_MS = 1_000;
export const PEER_DUPLICATE_WINDOW_MS = 60_000;
export const PEER_MESSAGE_ID_WINDOW_MS = 24 * 60 * 60_000;
export const IDLE_SUBSCRIPTION_MS = 12 * 60 * 60_000;
export const REMOTE_LIST_TTL_MS = 15_000;
/** How long a message for a machine that is off is kept trying, and how often. */
export const OUTBOX_TTL_MS = 24 * 60 * 60_000;
export const OUTBOX_RETRY_MIN_MS = 30_000;
export const OUTBOX_RETRY_MAX_MS = 10 * 60_000;
export const MAX_OUTBOX_PER_SESSION = 32;
export const MAX_OUTBOX = 512;
const OUTBOX_BATCH = 16;
/** A machine not reachable now rather than a link refused: the relay's 421, 502, 503 and 504, the daemon's own 502, and no answer at all. */
const UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([421, 502, 503, 504]);
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["unreachable", "timeout", "closed"]);
/** What a held message waits out rather than reports: its machine unreachable, or the session there not free to take it yet. */
const HELD_REFUSALS: ReadonlySet<PeerRefusal> = new Set(["offline", "rate_limited", "busy", "starting", "queue_full"]);
export const REMOTE_LIST_TIMEOUT_MS = 3_000;
const REMOTE_LIST_CONCURRENCY = 8;
const MAX_REMOTE_REF_CHARS = 64;
// A session id: no slash, so a row cannot name a machine, and nothing that can close a quote or a tag.
const REMOTE_REF = /^[\w-]+$/;
const MAX_ECHOED_ADDRESS_CHARS = 64;
/** Distinct `@name`s one message may have resolved; the rest are left as the text. */
export const MAX_MENTIONS = 8;
// After whitespace or at the start, so an email address or `@types/node` names nobody.
const MENTION = /(^|\s)@([A-Za-z][A-Za-z0-9-]{1,31})(?![A-Za-z0-9@/-])/g;

export const MACHINE_MESSAGING_OFF = "Agent messaging is off on this machine.";
export const CONVERSATION_MESSAGING_OFF = "Agent messaging is off for this conversation.";
export const RECIPIENT_MESSAGING_OFF = "That conversation does not take messages from agents.";
const REMOTE_MESSAGING_OFF = "Agent messaging is off on that machine.";
export const MACHINE_ISOLATED = "This machine's sessions are isolated: they can message only each other.";
export const REMOTE_ISOLATED = "Agent messaging on that machine is limited to its own sessions.";
const POLICY_KEY: PeerPolicyKey = "peerMessagesPolicy";

export type PeerStatus = "working" | "idle" | "waiting_for_user" | "asleep" | "starting";

export interface PeerRow {
  name: string;
  ref: string;
  address: string;
  machine: { label: string | null; isThis: boolean };
  harness: string;
  status: PeerStatus;
  title: string | null;
  folder: string;
  self: boolean;
}

export interface PeerListing {
  agents: PeerRow[];
  unreachable: { machine: string; reason: string }[];
  /** How agents on linked machines address the caller; null with no links, or before enrollment. */
  selfElsewhere: string | null;
}

/** GET /sessions/:id/mentions: what list_agents shows the session, less the session itself. */
export interface MentionListing {
  agents: PeerRow[];
  unreachable: { machine: string; reason: string }[];
}

export type PeerDelivery = "started_turn" | "injected" | "queued" | "pending";

export type PeerRefusal =
  | "messaging_off"
  | "unknown_caller"
  | "bad_request"
  | "too_large"
  | "unknown_recipient"
  | "ambiguous_recipient"
  | "self"
  | "hops_exceeded"
  | "rate_limited"
  | "duplicate"
  | "recipient_paused"
  | "queue_full"
  | "busy"
  | "starting"
  | "ended"
  | "workspace_missing"
  | "offline"
  | "peer_too_old"
  | "link_refused"
  | "conversation_messaging_off"
  | "messaging_isolated";

export type SendResult =
  | { ok: true; id: string; delivery: PeerDelivery; position: number | null; to: string; notify: boolean }
  | { ok: false; code: PeerRefusal; message: string };

export interface SendRequest {
  to: string;
  message: string;
  notify: boolean;
}

/** What another machine's daemon sends to POST /peer/messages. */
export interface RemoteMessage {
  id: string;
  from: { ref: string; name: string; harness: string; hops: number };
  to: string;
  message: string;
  notify: boolean;
}

export interface RemoteNotice {
  id: string;
  subscriber: string;
  from: { ref: string; name: string; harness: string; hops: number };
  what: "idle" | "ended";
}

export interface IncomingLink {
  id: string;
  sourceMachineId: string;
  sourceLabel: string;
}

/** The daemon's other half, handed in: links from the store, and one request over a link. */
export interface PeerNetwork {
  links(): PeerLink[];
  request(link: PeerLink, request: { method: "GET" | "POST"; path: string; body?: unknown }, timeoutMs?: number): Promise<PeerAnswer>;
}

type Subscriber = { kind: "local"; sessionId: string } | { kind: "remote"; machineId: string; sessionRef: string };

interface Subscription {
  readonly subscriber: Subscriber;
  readonly targetId: string;
  sawWork: boolean;
  unwatch: () => void;
  timer: NodeJS.Timeout;
}

type Resolved =
  | { ok: true; kind: "local"; target: ManagedSession }
  | { ok: true; kind: "remote"; link: PeerLink; sessionId: string; name: string }
  | { ok: false; code: PeerRefusal; message: string };

export type PeerOutbox = Pick<SqlitePeerOutboxStore, "add" | "due" | "retry" | "remove" | "count" | "countFor" | "take">;

/** What the owner's Authority last said about this machine, as its app delivered it; `at` orders two deliveries (Q1.654). */
export interface PeerPolicy {
  on: boolean;
  /** Its sessions message each other and nothing on another machine (Q2.244). */
  isolated: boolean;
  at: number;
}

/** One delivery: a flag it leaves out is left as it is, which is how an older app says nothing about it. */
export interface PeerPolicyDelivery {
  on?: boolean;
  isolated?: boolean;
  at: number;
}

export interface PeerMessagingState {
  policy: boolean;
  isolated: boolean;
  env: boolean;
  policyAt: number;
}

export type PeerPolicyStore = Pick<SqliteMachineSettingsStore, "readPolicy" | "writePolicy">;

export interface PeerHubOptions {
  registry: SessionRegistry;
  enabled: boolean;
  /** This machine's own id, from enrollment; how another machine names a session here. */
  machineId?: string | null;
  network?: PeerNetwork | null;
  outbox?: PeerOutbox | null;
  policy?: PeerPolicyStore | null;
  now?: () => number;
  onWarning?: (detail: string) => void;
}

/** Everything a machine's sessions may say to each other and to linked machines' sessions; the one door every peer message passes through. */
export class PeerHub {
  private readonly registry: SessionRegistry;
  /** REEMOAT_PEER_MESSAGES: a ceiling no policy lifts. */
  readonly enabled: boolean;
  private readonly policyStore: PeerPolicyStore | null;
  private policy: PeerPolicy;
  private readonly network: PeerNetwork | null;
  private readonly machineId: string | null;
  private readonly outbox: PeerOutbox | null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private pumping: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly warn: ((detail: string) => void) | null;
  private endpoint: string | null = null;
  // Minted at every launch: an older process's bearer stops naming the session the moment a new one is handed out.
  private readonly tokenBySession = new Map<string, string>();
  private readonly sessionByToken = new Map<string, string>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly recent = new Map<string, number>();
  private readonly seenMessageIds = new Map<string, number>();
  private readonly receiving = new Map<string, Promise<SendResult>>();
  private readonly pausedNoted = new Set<string>();
  private readonly subscriptions = new Set<Subscription>();
  private readonly remoteLists = new Map<string, { at: number; answer: Promise<PeerRow[] | string> }>();
  // Each link's last listing that succeeded, keyed by link id: what a mention resolves against, so a prompt never waits on a machine.
  private readonly remoteSettled = new Map<string, PeerRow[]>();
  // Notices this machine asked another for; anything else a link sends as a notice is refused.
  private readonly expectedNotices = new Map<string, number>();

  constructor(options: PeerHubOptions) {
    this.registry = options.registry;
    this.enabled = options.enabled;
    this.network = options.network ?? null;
    this.machineId = options.machineId ?? null;
    this.outbox = options.outbox ?? null;
    this.policyStore = options.policy ?? null;
    this.policy = storedPolicy(this.policyStore?.readPolicy(POLICY_KEY) ?? null);
    this.now = options.now ?? Date.now;
    this.warn = options.onWarning ?? null;
  }

  /** Read at every gate, never captured: the policy moves at runtime (Q2.244). */
  get allowed(): boolean {
    return this.enabled && this.policy.on;
  }

  /** Whether anything may cross to or from another machine; an isolated machine's sessions still message each other. */
  get reachesOthers(): boolean {
    return this.allowed && !this.policy.isolated;
  }

  messagingState(): PeerMessagingState {
    return { policy: this.policy.on, isolated: this.policy.isolated, env: this.enabled, policyAt: this.policy.at };
  }

  /** A delivery older than the one applied changes nothing; answers whether this one did (Q1.654). */
  setPolicy(next: PeerPolicyDelivery): boolean {
    if (next.at < this.policy.at) return false;
    const was = this.policy;
    this.policy = { on: next.on ?? was.on, isolated: next.isolated ?? was.isolated, at: next.at };
    this.policyStore?.writePolicy(POLICY_KEY, JSON.stringify(this.policy));
    if (was.on && !this.policy.on) this.switchedOff();
    else if (this.policy.on && !was.isolated && this.policy.isolated) this.isolatedFromOthers();
    return true;
  }

  /** A conversation's own switch going off; its queue is the session's to drop (Q2.244). */
  conversationSwitchedOff(sessionId: string): void {
    for (const subscription of this.subscriptions) {
      const subscriber = subscription.subscriber;
      if (subscription.targetId === sessionId || (subscriber.kind === "local" && subscriber.sessionId === sessionId)) {
        this.cancel(subscription);
      }
    }
    for (const key of this.expectedNotices.keys()) {
      if (key.endsWith(`\0${sessionId}`)) this.expectedNotices.delete(key);
    }
    this.noteUnsent(this.outbox?.take(sessionId) ?? []);
  }

  private switchedOff(): void {
    for (const subscription of this.subscriptions) this.cancel(subscription);
    this.expectedNotices.clear();
    this.remoteLists.clear();
    this.registry.dropQueuedPeer();
    this.noteUnsent(this.outbox?.take() ?? []);
  }

  /** Only what crosses machines goes: local queues, local subscriptions and local sessions are left as they are. */
  private isolatedFromOthers(): void {
    for (const subscription of this.subscriptions) {
      if (subscription.subscriber.kind === "remote") this.cancel(subscription);
    }
    this.expectedNotices.clear();
    this.remoteLists.clear();
    this.noteUnsent(this.outbox?.take() ?? [], "isolated");
  }

  private noteUnsent(entries: readonly OutboxEntry[], why: "off" | "isolated" = "off"): void {
    const bySender = new Map<string, number>();
    for (const entry of entries) bySender.set(entry.senderSession, (bySender.get(entry.senderSession) ?? 0) + 1);
    for (const [sessionId, unsent] of bySender) this.registry.get(sessionId)?.notePeerMessagesOff(unsent, why);
  }

  setEndpoint(url: string | null): void {
    this.endpoint = url;
  }

  /** Asked at every launch, so the process being replaced loses its bearer even when the new one gets none. */
  mcpServersFor(sessionId: string, capabilities: acp.McpCapabilities): acp.McpServer[] {
    const previous = this.tokenBySession.get(sessionId);
    if (previous !== undefined) {
      this.sessionByToken.delete(previous);
      this.tokenBySession.delete(sessionId);
    }
    if (!this.allowed || this.endpoint === null || capabilities.http !== true) return [];
    if (this.registry.get(sessionId)?.peerMessages === false) return [];
    const token = randomBytes(32).toString("base64url");
    this.tokenBySession.set(sessionId, token);
    this.sessionByToken.set(token, sessionId);
    return [
      {
        type: "http",
        name: PEER_SERVER_NAME,
        url: this.endpoint,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      },
    ];
  }

  /** Which session a bearer names; this is hygiene, not a fence, since every agent here runs as the same user. */
  callerOf(authorization: string | undefined): string | null {
    if (authorization === undefined || !authorization.startsWith("Bearer ")) return null;
    const sessionId = this.sessionByToken.get(authorization.slice("Bearer ".length)) ?? null;
    if (sessionId === null || this.registry.get(sessionId) === undefined) return null;
    return sessionId;
  }

  /** Why a caller holding a valid bearer may not use the tools now; a tool error, never a 401, which an MCP client reads as a sign-in. */
  callRefusal(callerId: string): string | null {
    if (!this.allowed) return MACHINE_MESSAGING_OFF;
    if (this.registry.get(callerId)?.peerMessages === false) return CONVERSATION_MESSAGING_OFF;
    return null;
  }

  /** This machine's reachable sessions, as another machine's daemon is shown them. */
  localRows(callerId: string | null = null): PeerRow[] {
    const rows: PeerRow[] = [];
    if (!this.allowed) return rows;
    for (const managed of this.registry.list()) {
      if (!managed.peerMessages) continue;
      const status = this.peerStatus(managed);
      if (status === null) continue;
      rows.push(this.rowOf(managed, status, managed.id === callerId));
    }
    return rows;
  }

  async list(callerId: string): Promise<PeerListing> {
    if (this.callRefusal(callerId) !== null) return { agents: [], unreachable: [], selfElsewhere: null };
    const agents = this.localRows(callerId);
    const unreachable: PeerListing["unreachable"] = [];
    const listings = await this.remoteListings();
    for (const [link, rows] of listings) {
      if (typeof rows === "string") unreachable.push({ machine: link.targetName, reason: rows });
      else agents.push(...rows);
    }
    const self = agents.find((row) => row.self) ?? null;
    // A session hands its own address to agents elsewhere, and the short one names nothing on their machine.
    const selfElsewhere =
      self === null || this.machineId === null || listings.length === 0 ? null : address(self.name, `${this.machineId}/${self.ref}`);
    return { agents, unreachable, selfElsewhere };
  }

  async mentionListing(callerId: string): Promise<MentionListing> {
    const { agents, unreachable } = await this.list(callerId);
    return { agents: agents.filter((row) => !row.self), unreachable };
  }

  /** Synchronous: resolved against this machine's rows and the listings already settled, never a fetch (Q2.246). */
  mentionNote(callerId: string, text: string): MentionNote | null {
    // An agent reads a command at index 0, and a block beside one is unmeasured.
    if (text.startsWith("/")) return null;
    // The same switches list_agents answers to: nothing is named where nothing could be reached (Q2.244).
    if (this.callRefusal(callerId) !== null) return null;
    const names: string[] = [];
    for (const match of text.matchAll(MENTION)) {
      const name = match[2]!.toLowerCase();
      if (!names.includes(name)) names.push(name);
      if (names.length === MAX_MENTIONS) break;
    }
    if (names.length === 0) return null;

    const rows = this.localRows(callerId).filter((row) => !row.self);
    if (this.network !== null && this.reachesOthers) {
      const at = this.now();
      for (const link of this.network.links()) {
        if (link.expiresAt > at) rows.push(...(this.remoteSettled.get(link.id) ?? []));
      }
    }
    const targets = names.flatMap((name) => rows.filter((row) => row.name.toLowerCase() === name));
    if (targets.length === 0) return null;
    const mentions: PromptMention[] = targets.map((row) => ({ name: row.name, ref: row.ref }));
    return { text: mentionNote(targets, this.tokenBySession.has(callerId)), mentions };
  }

  async send(callerId: string, request: SendRequest): Promise<SendResult> {
    if (!this.allowed) return refuse("messaging_off", MACHINE_MESSAGING_OFF);
    const sender = this.registry.get(callerId);
    if (sender === undefined) return refuse("unknown_caller", "this session no longer exists");
    const closed = this.senderRefusal(sender);
    if (closed !== null) return closed;
    const invalid = invalidMessage(request.message);
    if (invalid !== null) return invalid;

    const resolved = await this.resolve(callerId, request.to);
    if (!resolved.ok) return resolved;
    // resolve may have waited on another machine's listing.
    const since = this.senderRefusal(sender);
    if (since !== null) return since;
    if (resolved.kind === "remote" && !this.reachesOthers) return refuse("messaging_isolated", MACHINE_ISOLATED);

    const hops = sender.peerDepth + 1;
    if (hops > MAX_PEER_HOPS) {
      return refuse(
        "hops_exceeded",
        `this would be the ${hops}th agent in a row to pass work on without a person in between (limit ${MAX_PEER_HOPS}); ask your user`,
      );
    }
    const wait = this.takeToken(`session:${callerId}`, PEER_SEND_BURST, PEER_SEND_REFILL_MS);
    if (wait > 0) {
      return refuse("rate_limited", `too many messages too fast; wait ${Math.ceil(wait / 1000)}s, or put the rest in one message`);
    }
    const targetKey = resolved.kind === "local" ? resolved.target.id : `${resolved.link.targetMachineId}/${resolved.sessionId}`;
    const key = createHash("sha256").update(`${callerId}\0${targetKey}\0${request.message}`).digest("hex");
    const at = this.now();
    this.forgetStale(at);
    if (this.recent.has(key)) return refuse("duplicate", "you sent this exact message to this session less than a minute ago");

    const messageId = `pm_${randomBytes(8).toString("hex")}`;
    const result =
      resolved.kind === "local"
        ? await this.deliverLocal(
            resolved.target,
            this.localOrigin(sender, messageId, hops),
            request.message,
            true,
            request.notify ? { kind: "local", sessionId: callerId } : null,
            callerId,
          )
        : await this.sendRemote(sender, resolved, request, messageId, hops);
    if (!result.ok) return result;
    this.recent.set(key, at);
    // Writing back is the answer an idle notice stood in for, so the recipient is not woken a second time for it.
    this.answered(
      callerId,
      resolved.kind === "local"
        ? { kind: "local", sessionId: resolved.target.id }
        : { kind: "remote", machineId: resolved.link.targetMachineId, sessionRef: resolved.sessionId },
    );
    return result;
  }

  /** POST /peer/messages: a linked machine's agent writing to one of this machine's sessions. */
  async receive(link: IncomingLink, body: unknown): Promise<SendResult> {
    if (!this.allowed) return refuse("messaging_off", REMOTE_MESSAGING_OFF);
    if (!this.reachesOthers) return refuse("messaging_isolated", REMOTE_ISOLATED);
    const message = remoteMessageOf(body);
    if (message === null) return refuse("bad_request", "unreadable message");
    const invalid = invalidMessage(message.message);
    if (invalid !== null) return invalid;
    if (message.from.hops > MAX_PEER_HOPS) return refuse("hops_exceeded", "too many agents in a row with no person in between");
    const wait = this.takeToken(`link:${link.id}`, PEER_LINK_BURST, PEER_LINK_REFILL_MS);
    if (wait > 0) return refuse("rate_limited", `that machine is taking messages too fast; wait ${Math.ceil(wait / 1000)}s`);
    const at = this.now();
    this.forgetStale(at);
    // Keyed on the machine, not the link: a Replace between two tries mints a new link id for the same sender.
    const seen = `${link.sourceMachineId}\0${message.id}`;
    if (this.seenMessageIds.has(seen)) return refuse("duplicate", "that message was already delivered");
    // A retry landing while the first try is still being delivered gets that try's answer, never a second delivery (Q2.240).
    const inFlight = this.receiving.get(seen);
    if (inFlight !== undefined) return await inFlight;
    const delivery = this.deliverReceived(link, message, seen, at);
    this.receiving.set(seen, delivery);
    try {
      return await delivery;
    } finally {
      this.receiving.delete(seen);
    }
  }

  private async deliverReceived(link: IncomingLink, message: RemoteMessage, seen: string, at: number): Promise<SendResult> {
    const target = this.registry.get(message.to);
    if (target === undefined) return refuse("unknown_recipient", "no such session on that machine");
    if (!target.peerMessages) return refuse("conversation_messaging_off", RECIPIENT_MESSAGING_OFF);
    if (this.peerStatus(target) === null) {
      return refuse("ended", `${address(this.nameOf(target), target.id)} has ended or was stopped by its person`);
    }
    const back = this.linkTo(link.sourceMachineId);
    const from: PeerOrigin = {
      kind: "message",
      name: message.from.name,
      ref: `${link.sourceMachineId}/${message.from.ref}`,
      machineId: link.sourceMachineId,
      machineLabel: link.sourceLabel,
      harness: message.from.harness,
      messageId: message.id,
      hops: message.from.hops,
    };
    const subscriber: Subscriber | null =
      message.notify && back !== null ? { kind: "remote", machineId: link.sourceMachineId, sessionRef: message.from.ref } : null;
    const result = await this.deliverLocal(target, from, message.message, back !== null, subscriber, null);
    if (!result.ok) return result;
    this.seenMessageIds.set(seen, at);
    // Its sender answered: the notice this machine was waiting on for that pair is no longer coming.
    this.expectedNotices.delete(expectationKey(link.sourceMachineId, message.from.ref, target.id));
    return result;
  }

  /** POST /peer/notices: only the one this machine asked for, once. */
  async receiveNotice(link: IncomingLink, body: unknown): Promise<boolean> {
    if (!this.reachesOthers) return false;
    const notice = remoteNoticeOf(body);
    if (notice === null) return false;
    const expected = expectationKey(link.sourceMachineId, notice.from.ref, notice.subscriber);
    const until = this.expectedNotices.get(expected);
    if (until === undefined || until < this.now()) return false;
    this.expectedNotices.delete(expected);
    const from: PeerOrigin = {
      kind: "notice",
      name: notice.from.name,
      ref: `${link.sourceMachineId}/${notice.from.ref}`,
      machineId: link.sourceMachineId,
      machineLabel: link.sourceLabel,
      harness: notice.from.harness,
      messageId: notice.id,
      hops: notice.from.hops,
    };
    await this.notifyLocal(notice.subscriber, from, notice.what);
    return true;
  }

  close(): void {
    for (const subscription of this.subscriptions) this.cancel(subscription);
    if (this.outboxTimer !== null) clearInterval(this.outboxTimer);
    this.outboxTimer = null;
  }

  startOutbox(intervalMs = OUTBOX_RETRY_MIN_MS): void {
    if (!this.enabled || this.outbox === null || this.outboxTimer !== null) return;
    this.outboxTimer = setInterval(() => void this.pumpOutbox(), intervalMs);
    this.outboxTimer.unref();
  }

  /** One pass over what is due; overlapping passes join, so a slow relay cannot stack them. */
  pumpOutbox(): Promise<void> {
    this.pumping ??= this.pumpOnce().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async pumpOnce(): Promise<void> {
    // Switched off, held entries are left as they are: nothing is sent, and nobody is woken about them.
    if (!this.enabled || this.outbox === null || this.network === null) return;
    const at = this.now();
    for (const entry of this.outbox.due(at, OUTBOX_BATCH)) {
      // Before every entry: switching off or isolating takes the outbox whole, and a pass already running must stop sending.
      if (!this.reachesOthers) return;
      // The batch was read before the await: a conversation switched off since has had its rows taken already.
      if (this.registry.get(entry.senderSession)?.peerMessages === false) continue;
      const link = this.linkTo(entry.targetMachineId);
      if (link === null) {
        this.outbox.remove(entry.id);
        this.undelivered(entry, "this machine no longer has a link to that one");
        continue;
      }
      let body: RemoteMessage;
      try {
        body = JSON.parse(entry.body) as RemoteMessage;
      } catch {
        this.outbox.remove(entry.id);
        continue;
      }
      const answer = await this.network.request(link, { method: "POST", path: "/peer/messages", body });
      const result = this.remoteResult(link, answer, entry.targetName);
      const expected = expectationKey(entry.targetMachineId, body.to, entry.senderSession);
      if (result.ok) {
        this.outbox.remove(entry.id);
        if (body.notify && result.notify) this.expectedNotices.set(expected, this.now() + IDLE_SUBSCRIPTION_MS);
        else this.expectedNotices.delete(expected);
        continue;
      }
      // An earlier try got there after this daemon stopped waiting: delivered. Re-armed, since the hold may outlast the first arming.
      if (result.code === "duplicate") {
        this.outbox.remove(entry.id);
        if (body.notify) this.expectedNotices.set(expected, this.now() + IDLE_SUBSCRIPTION_MS);
        continue;
      }
      if (HELD_REFUSALS.has(result.code) && at - entry.createdAt < OUTBOX_TTL_MS) {
        this.outbox.retry(entry.id, at + outboxBackoff(entry.attempts + 1), result.message);
        continue;
      }
      this.outbox.remove(entry.id);
      this.expectedNotices.delete(expected);
      this.undelivered(entry, result.code === "offline" ? "its machine stayed unreachable for 24 hours" : result.message);
    }
  }

  private undelivered(entry: OutboxEntry, reason: string): void {
    const parsed = parseAddress(entry.targetName);
    const from: PeerOrigin = {
      kind: "notice",
      name: parsed.name ?? entry.targetName,
      ref: parsed.ref ?? entry.targetMachineId,
      machineId: entry.targetMachineId,
      machineLabel: null,
      harness: "reemoat",
      messageId: entry.id,
      hops: 0,
    };
    void this.wake(entry.senderSession, from, peerNotice(from, "undelivered", reason)).catch((error: unknown) => {
      this.warn?.(`an undelivered notice failed: ${String(error)}`);
    });
  }

  private async deliverLocal(
    target: ManagedSession,
    from: PeerOrigin,
    body: string,
    replyable: boolean,
    subscriber: Subscriber | null,
    senderId: string | null,
  ): Promise<SendResult> {
    const to = address(this.nameOf(target), target.id);
    if (target.peerTurnsSinceHuman < PEER_TURN_BUDGET) {
      this.pausedNoted.delete(target.id);
    } else {
      if (!this.pausedNoted.has(target.id)) {
        this.pausedNoted.add(target.id);
        target.notePeersPaused(PEER_TURN_BUDGET);
      }
      return refuse(
        "recipient_paused",
        `${to} has taken ${PEER_TURN_BUDGET} turns from other agents with no message from its user; ask your user`,
      );
    }
    const text = peerMessage(from, body, replyable);
    const ready = await this.registry.readyForMessage(target, "peer");
    if (ready !== "ready") return refuse("workspace_missing", `${to} cannot take work: its folder is gone or not answering`);
    const closed = this.deliveryRefusal(target, senderId);
    if (closed !== null) return closed;
    // Subscribed before delivery, or a turn that ends inside submit would never be seen to start.
    const subscription = subscriber === null ? null : this.subscribe(subscriber, target);
    const result = await target.submit(text, from);
    const delivered = deliveryOf(result);
    if (!delivered.ok) {
      if (subscription !== null) this.cancel(subscription);
      return refuse(delivered.code, delivered.describe(to));
    }
    return {
      ok: true,
      id: from.messageId,
      delivery: delivered.delivery,
      position: delivered.position,
      to,
      notify: subscription !== null,
    };
  }

  private async sendRemote(
    sender: ManagedSession,
    resolved: { link: PeerLink; sessionId: string; name: string },
    request: SendRequest,
    messageId: string,
    hops: number,
  ): Promise<SendResult> {
    const { link } = resolved;
    const to = address(resolved.name, `${link.targetMachineId}/${resolved.sessionId}`);
    const notify = request.notify;
    const body: RemoteMessage = {
      id: messageId,
      from: { ref: sender.id, name: this.nameOf(sender), harness: sender.agent, hops },
      to: resolved.sessionId,
      message: request.message,
      notify,
    };
    // Expected before the send: the notice can beat the answer back.
    const expected = expectationKey(link.targetMachineId, resolved.sessionId, sender.id);
    if (notify) this.expectedNotices.set(expected, this.now() + IDLE_SUBSCRIPTION_MS);
    const answer = await this.network!.request(link, { method: "POST", path: "/peer/messages", body });
    const result = this.remoteResult(link, answer, to);
    if (!result.ok && result.code === "offline" && this.outbox !== null) {
      const closed = this.senderRefusal(sender) ?? (this.reachesOthers ? null : refuse("messaging_isolated", MACHINE_ISOLATED));
      if (closed !== null) {
        this.expectedNotices.delete(expected);
        return closed;
      }
      if (this.outbox.countFor(sender.id) >= MAX_OUTBOX_PER_SESSION || this.outbox.count() >= MAX_OUTBOX) {
        this.expectedNotices.delete(expected);
        return refuse("offline", `${link.targetName} is offline and too many messages are already waiting for machines that are; try later`);
      }
      const at = this.now();
      this.outbox.add({
        id: messageId,
        senderSession: sender.id,
        linkId: link.id,
        targetMachineId: link.targetMachineId,
        targetName: to,
        body: JSON.stringify(body),
        createdAt: at,
        nextAt: at + outboxBackoff(0),
        attempts: 0,
        lastError: result.message,
      });
      // Armed, not promised: whether the target holds a link back is only known once it answers.
      return { ok: true, id: messageId, delivery: "pending", position: null, to, notify: false };
    }
    if (notify && !(result.ok && result.notify)) this.expectedNotices.delete(expected);
    return result;
  }

  private remoteResult(link: PeerLink, answer: PeerAnswer, to: string): SendResult {
    // No link records its failures: nothing reads them since the links screen went (Q3.676).
    const offline = (why: string): SendResult =>
      refuse("offline", `${link.targetName} is not reachable right now (${why}); try again later`);
    if (!answer.ok) {
      if (UNREACHABLE_STATUSES.has(answer.status) || UNREACHABLE_CODES.has(answer.code)) return offline(answer.code);
      if (answer.status === 429) return refuse("rate_limited", `${link.targetName}'s relay is refusing messages this fast; wait and retry`);
      return refuse(
        "link_refused",
        `${link.targetName} refused this machine's link (${answer.code}); its owner's app renews links when it next opens`,
      );
    }
    if (answer.status === 404) {
      return refuse("peer_too_old", `${link.targetName}'s daemon is too old to take messages from agents; it needs updating`);
    }
    // Its daemon's own 503 (shutting_down, peers_unavailable) is a machine going away, not a refusal of the link.
    if (answer.status === 503) return offline(envelopeCode(answer.body) ?? "503");
    const body = answer.body as Partial<SendResult> | null;
    if (answer.status !== 200 || body === null || typeof body !== "object" || typeof body.ok !== "boolean") {
      return refuse("link_refused", `${link.targetName} answered ${answer.status}`);
    }
    if (!body.ok) {
      const refusal = body as { code?: unknown; message?: unknown };
      return refuse(
        typeof refusal.code === "string" ? (refusal.code as PeerRefusal) : "link_refused",
        typeof refusal.message === "string" ? refusal.message : `${link.targetName} refused it`,
      );
    }
    const accepted = body as { id?: unknown; delivery?: unknown; position?: unknown; notify?: unknown };
    const delivery = accepted.delivery;
    return {
      ok: true,
      id: typeof accepted.id === "string" ? accepted.id : "",
      delivery:
        delivery === "started_turn" || delivery === "injected" || delivery === "queued" ? delivery : "queued",
      position: typeof accepted.position === "number" ? accepted.position : null,
      to,
      notify: accepted.notify === true,
    };
  }

  private async resolve(callerId: string, to: string): Promise<Resolved> {
    if (to.length > MAX_PEER_ADDRESS_CHARS) {
      return refuse("bad_request", `an address is at most ${MAX_PEER_ADDRESS_CHARS} characters; use one as list_agents printed it`);
    }
    const { name, ref } = parseAddress(to);

    if (ref !== null && ref.includes("/")) {
      if (!this.reachesOthers) return refuse("messaging_isolated", MACHINE_ISOLATED);
      const slash = ref.indexOf("/");
      const machineId = ref.slice(0, slash);
      const sessionId = ref.slice(slash + 1);
      // The address agents elsewhere are handed for a session here.
      if (machineId === this.machineId) return this.resolveLocal(callerId, to, sessionId);
      const link = this.linkTo(machineId);
      if (link === null) return refuse("unknown_recipient", `this machine has no link to ${machineId}`);
      // The name as the address gives it: a label the ref settles, never worth a listing to look up.
      return { ok: true, kind: "remote", link, sessionId, name: name !== null && isPeerName(name) ? name : sessionId };
    }
    if (ref !== null) return this.resolveLocal(callerId, to, ref);
    const bare = name ?? "";
    // A bare word that is a session's id is its ref: no name holds an underscore.
    if (this.registry.get(bare) !== undefined) return this.resolveLocal(callerId, to, bare);

    const wanted = bare.toLowerCase();
    // What list_agents shows the caller, and nothing else.
    const localMatches = this.localRows(callerId).filter((row) => !row.self && row.name.toLowerCase() === wanted);
    const remoteMatches: PeerRow[] = [];
    // A bare name must be one session's across every machine list_agents shows, so it waits on their listings.
    if (this.network !== null) {
      for (const [, rows] of await this.remoteListings()) {
        if (typeof rows !== "string") remoteMatches.push(...rows.filter((row) => row.name.toLowerCase() === wanted));
      }
    }
    const total = localMatches.length + remoteMatches.length;
    if (total === 0) {
      const caller = this.registry.get(callerId);
      if (caller !== undefined && this.nameOf(caller).toLowerCase() === wanted) return refuse("self", "that is this session");
      return this.unknownRecipient(callerId, to);
    }
    if (total > 1) {
      const candidates = [...localMatches, ...remoteMatches].map((row) => row.address);
      return refuse("ambiguous_recipient", `more than one session is called that; use one of: ${candidates.join(", ")}`);
    }
    if (remoteMatches.length === 1) {
      if (!this.reachesOthers) return refuse("messaging_isolated", MACHINE_ISOLATED);
      const row = remoteMatches[0]!;
      const slash = row.ref.indexOf("/");
      // The owner's app may have replaced the links while the listings were in flight.
      const link = this.linkTo(row.ref.slice(0, slash));
      if (link === null) return refuse("unknown_recipient", `this machine no longer has a link to ${row.machine.label ?? "that machine"}`);
      return { ok: true, kind: "remote", link, sessionId: row.ref.slice(slash + 1), name: row.name };
    }
    return this.resolveLocal(callerId, to, localMatches[0]!.ref);
  }

  private resolveLocal(callerId: string, to: string, sessionId: string): Resolved {
    // Any session, so one that ended is named as ended rather than as unknown.
    const target = this.registry.get(sessionId);
    if (target === undefined) return this.unknownRecipient(callerId, to);
    if (target.id === callerId) return refuse("self", "that is this session");
    if (!target.peerMessages) return refuse("conversation_messaging_off", RECIPIENT_MESSAGING_OFF);
    if (this.peerStatus(target) === null) {
      return refuse(
        "ended",
        `${address(this.nameOf(target), target.id)} has ended or was stopped by its person; it takes messages again once someone starts it`,
      );
    }
    return { ok: true, kind: "local", target };
  }

  private unknownRecipient(callerId: string, to: string): Resolved {
    const names = this.localRows(callerId)
      .filter((row) => !row.self)
      .map((row) => row.address);
    const asked = JSON.stringify(to.length > MAX_ECHOED_ADDRESS_CHARS ? `${to.slice(0, MAX_ECHOED_ADDRESS_CHARS)}…` : to);
    return refuse(
      "unknown_recipient",
      names.length === 0
        ? `no session is called ${asked}; run list_agents to see what there is`
        : `no session is called ${asked}; on this machine there are: ${names.slice(0, 12).join(", ")}`,
    );
  }

  private linkTo(machineId: string): PeerLink | null {
    if (this.network === null) return null;
    const at = this.now();
    return this.network.links().find((link) => link.targetMachineId === machineId && link.expiresAt > at) ?? null;
  }

  private async remoteListings(): Promise<[PeerLink, PeerRow[] | string][]> {
    if (this.network === null || !this.reachesOthers) return [];
    const at = this.now();
    const links = this.network.links().filter((link) => link.expiresAt > at);
    for (const id of this.remoteSettled.keys()) if (!links.some((link) => link.id === id)) this.remoteSettled.delete(id);
    const out: [PeerLink, PeerRow[] | string][] = [];
    for (let i = 0; i < links.length; i += REMOTE_LIST_CONCURRENCY) {
      const batch = links.slice(i, i + REMOTE_LIST_CONCURRENCY);
      const answers = await Promise.all(batch.map((link) => this.remoteRows(link)));
      batch.forEach((link, j) => out.push([link, answers[j]!]));
    }
    return out;
  }

  /** Cached briefly: one list_agents fans out to every linked machine, and a name lookup reads the same answer. */
  private remoteRows(link: PeerLink): Promise<PeerRow[] | string> {
    const at = this.now();
    const cached = this.remoteLists.get(link.id);
    if (cached !== undefined && at - cached.at < REMOTE_LIST_TTL_MS) return cached.answer;
    const answer = this.network!.request(link, { method: "GET", path: "/peer/agents" }, REMOTE_LIST_TIMEOUT_MS).then(
      (reply): PeerRow[] | string => {
        if (!reply.ok) return reply.status === 503 ? "offline" : reply.code;
        if (reply.status === 404) return "its daemon is too old for messages from agents";
        if (reply.status === 403 && errorCodeOf(reply.body) === "messaging_off") return "agent messaging is off there";
        if (reply.status === 403 && errorCodeOf(reply.body) === "messaging_isolated") return "its sessions are isolated";
        const rows = (reply.body as { agents?: unknown } | null)?.agents;
        if (reply.status !== 200 || !Array.isArray(rows)) return `answered ${reply.status}`;
        return rows.flatMap((row) => {
          const remote = remoteRowOf(row);
          if (remote === null) return [];
          const ref = `${link.targetMachineId}/${remote.ref}`;
          return [{ ...remote, ref, address: address(remote.name, ref), machine: { label: link.targetName, isThis: false }, self: false }];
        });
      },
    ).then((rows) => {
      // A failed listing forgets the last good one, as list_agents does.
      if (typeof rows === "string") this.remoteSettled.delete(link.id);
      else this.remoteSettled.set(link.id, rows);
      return rows;
    });
    this.remoteLists.set(link.id, { at, answer });
    return answer;
  }

  private peerStatus(managed: ManagedSession): PeerStatus | null {
    switch (managed.status) {
      case "running":
        return "working";
      case "idle":
        return "idle";
      case "blocked":
        return "waiting_for_user";
      case "starting":
        return "starting";
      case "stopping":
        return null;
      case "parked":
      case "interrupted":
      case "exited":
      case "failed":
        return this.registry.wakesOnPrompt(managed, "peer") ? "asleep" : null;
    }
  }

  private senderRefusal(sender: ManagedSession): SendResult | null {
    if (!this.allowed) return refuse("messaging_off", MACHINE_MESSAGING_OFF);
    if (!sender.peerMessages) return refuse("messaging_off", CONVERSATION_MESSAGING_OFF);
    return null;
  }

  /** After delivery's awaits: any of the three switches may have gone off during them. */
  private deliveryRefusal(target: ManagedSession, senderId: string | null): SendResult | null {
    if (!this.allowed) return refuse("messaging_off", senderId === null ? REMOTE_MESSAGING_OFF : MACHINE_MESSAGING_OFF);
    if (senderId === null && !this.reachesOthers) return refuse("messaging_isolated", REMOTE_ISOLATED);
    if (!target.peerMessages) return refuse("conversation_messaging_off", RECIPIENT_MESSAGING_OFF);
    const sender = senderId === null ? undefined : this.registry.get(senderId);
    if (sender !== undefined && !sender.peerMessages) return refuse("messaging_off", CONVERSATION_MESSAGING_OFF);
    return null;
  }

  private rowOf(managed: ManagedSession, status: PeerStatus, self: boolean): PeerRow {
    const name = this.nameOf(managed);
    return {
      name,
      ref: managed.id,
      address: address(name, managed.id),
      machine: { label: null, isThis: true },
      harness: managed.agent,
      status,
      title: managed.title,
      folder: basename(managed.workspace.requestedCwd),
      self,
    };
  }

  /** The nickname is the address; a title is only what the session is about (Q2.245). */
  private nameOf(managed: ManagedSession): string {
    return managed.nickname;
  }

  private localOrigin(sender: ManagedSession, messageId: string, hops: number): PeerOrigin {
    return {
      kind: "message",
      name: this.nameOf(sender),
      ref: sender.id,
      machineId: null,
      machineLabel: null,
      harness: sender.agent,
      messageId,
      hops,
    };
  }

  /** Answers how long to wait, or 0 having spent a token. */
  private takeToken(key: string, burst: number, refillMs: number): number {
    const at = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: burst, at };
    const refilled = Math.min(burst, bucket.tokens + (at - bucket.at) / refillMs);
    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, at });
      return (1 - refilled) * refillMs;
    }
    this.buckets.set(key, { tokens: refilled - 1, at });
    return 0;
  }

  private forgetStale(at: number): void {
    for (const [key, sentAt] of this.recent) {
      if (at - sentAt >= PEER_DUPLICATE_WINDOW_MS) this.recent.delete(key);
    }
    for (const [key, seenAt] of this.seenMessageIds) {
      if (at - seenAt >= PEER_MESSAGE_ID_WINDOW_MS) this.seenMessageIds.delete(key);
    }
    for (const [key, until] of this.expectedNotices) {
      if (until < at) this.expectedNotices.delete(key);
    }
  }

  private subscribe(subscriber: Subscriber, target: ManagedSession): Subscription {
    const subscription: Subscription = {
      subscriber,
      targetId: target.id,
      sawWork: false,
      unwatch: () => {},
      // Lapses silently: nobody asked to be woken for a subscription running out.
      timer: setTimeout(() => this.cancel(subscription), IDLE_SUBSCRIPTION_MS),
    };
    subscription.timer.unref();
    subscription.unwatch = target.watch((snapshot) => this.onSnapshot(subscription, target, snapshot));
    this.subscriptions.add(subscription);
    return subscription;
  }

  private cancel(subscription: Subscription): void {
    if (!this.subscriptions.delete(subscription)) return;
    clearTimeout(subscription.timer);
    subscription.unwatch();
  }

  private answered(writerId: string, reader: Subscriber): void {
    for (const subscription of this.subscriptions) {
      const subscriber = subscription.subscriber;
      const same =
        subscriber.kind === "local"
          ? reader.kind === "local" && reader.sessionId === subscriber.sessionId
          : reader.kind === "remote" && reader.machineId === subscriber.machineId && reader.sessionRef === subscriber.sessionRef;
      if (same && subscription.targetId === writerId) this.cancel(subscription);
    }
  }

  private onSnapshot(subscription: Subscription, target: ManagedSession, snapshot: SessionSnapshot): void {
    // A restart hands the same conversation back and its end announces what is left; a shutdown ends nobody's work.
    if (target.restarting || this.registry.isShuttingDown) return;
    if (snapshot.exit !== null) {
      this.fire(subscription, target, this.peerStatus(target) === null ? "ended" : "idle");
      return;
    }
    if (snapshot.turn !== null || snapshot.status !== "idle") {
      subscription.sawWork = true;
      return;
    }
    if (subscription.sawWork && snapshot.queuedPrompts.length === 0) this.fire(subscription, target, "idle");
  }

  private fire(subscription: Subscription, target: ManagedSession, what: "idle" | "ended"): void {
    if (!this.subscriptions.has(subscription)) return;
    this.cancel(subscription);
    if (!this.allowed || !target.peerMessages) return;
    const subscriber = subscription.subscriber;
    const done =
      subscriber.kind === "local"
        ? this.notifyLocal(subscriber.sessionId, this.noticeFrom(target), what)
        : this.notifyRemote(subscriber, target, what);
    void done.catch((error: unknown) => {
      this.warn?.(`an idle notice failed: ${String(error)}`);
    });
  }

  private async notifyLocal(subscriberId: string, from: PeerOrigin, what: "idle" | "ended"): Promise<void> {
    await this.wake(subscriberId, from, peerNotice(from, what));
  }

  /** A notice from this daemon: it wakes like a message, and is dropped rather than refused past the budget. */
  private async wake(sessionId: string, from: PeerOrigin, text: string): Promise<void> {
    if (!this.allowed) return;
    const session = this.registry.get(sessionId);
    if (session === undefined || !session.peerMessages || this.peerStatus(session) === null) return;
    // The budget holds for notices too, or two agents handing each other work would never stop.
    if (session.peerTurnsSinceHuman >= PEER_TURN_BUDGET) return;
    if ((await this.registry.readyForMessage(session, "peer")) !== "ready") return;
    if (!this.allowed || !session.peerMessages) return;
    await session.submit(text, from);
  }

  private async notifyRemote(
    subscriber: { machineId: string; sessionRef: string },
    target: ManagedSession,
    what: "idle" | "ended",
  ): Promise<void> {
    if (!this.reachesOthers) return;
    const link = this.linkTo(subscriber.machineId);
    if (link === null) return;
    const notice: RemoteNotice = {
      id: `pn_${randomBytes(8).toString("hex")}`,
      subscriber: subscriber.sessionRef,
      from: { ref: target.id, name: this.nameOf(target), harness: target.agent, hops: target.peerDepth },
      what,
    };
    await this.network!.request(link, { method: "POST", path: "/peer/notices", body: notice });
  }

  private noticeFrom(target: ManagedSession): PeerOrigin {
    return {
      kind: "notice",
      name: this.nameOf(target),
      ref: target.id,
      machineId: null,
      machineLabel: null,
      harness: target.agent,
      messageId: `pn_${randomBytes(8).toString("hex")}`,
      hops: target.peerDepth,
    };
  }
}

function refuse(code: PeerRefusal, message: string): { ok: false; code: PeerRefusal; message: string } {
  return { ok: false, code, message };
}

/**
 * Anything unreadable is the default, on and not isolated at 0: the state before this feature, and what a machine nobody
 * has set is. A value written before isolation existed has no `isolated`, and reads as not isolated.
 */
function storedPolicy(raw: string | null): PeerPolicy {
  const unset: PeerPolicy = { on: true, isolated: false, at: 0 };
  if (raw === null) return unset;
  try {
    const parsed = JSON.parse(raw) as { on?: unknown; isolated?: unknown; at?: unknown };
    const isolated = parsed.isolated ?? false;
    if (
      typeof parsed.on === "boolean" &&
      typeof isolated === "boolean" &&
      typeof parsed.at === "number" &&
      Number.isFinite(parsed.at) &&
      parsed.at >= 0
    ) {
      return { on: parsed.on, isolated, at: parsed.at };
    }
  } catch {
    // Unreadable is unset.
  }
  return unset;
}

function errorCodeOf(body: unknown): string | null {
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === "string" ? error.code : null;
}

function invalidMessage(message: string): { ok: false; code: PeerRefusal; message: string } | null {
  if (message.trim().length === 0) return refuse("bad_request", "message is empty");
  if (message.length > MAX_PEER_MESSAGE_CHARS) {
    return refuse(
      "too_large",
      `message is over ${MAX_PEER_MESSAGE_CHARS} characters; write it to a file in a shared folder and send the path instead`,
    );
  }
  return null;
}

function outboxBackoff(attempt: number): number {
  return Math.min(OUTBOX_RETRY_MAX_MS, OUTBOX_RETRY_MIN_MS * 2 ** attempt);
}

function expectationKey(machineId: string, targetRef: string, subscriberRef: string): string {
  return `${machineId}\0${targetRef}\0${subscriberRef}`;
}

function envelopeCode(body: unknown): string | null {
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

function refString(value: unknown): value is string {
  return shortString(value, MAX_REMOTE_REF_CHARS) && REMOTE_REF.test(value);
}

/** What reaches the prompt as the sender's name, so only what peerName could have made (Q2.241). */
function nameString(value: unknown): value is string {
  return typeof value === "string" && isPeerName(value);
}

function peerOf(value: unknown): { ref: string; name: string; harness: string; hops: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const from = value as Record<string, unknown>;
  const hops = from["hops"];
  if (
    !refString(from["ref"]) ||
    !nameString(from["name"]) ||
    !shortString(from["harness"], MAX_PEER_HARNESS_CHARS) ||
    typeof hops !== "number" ||
    !Number.isInteger(hops) ||
    hops < 0
  ) {
    return null;
  }
  return { ref: from["ref"], name: from["name"], harness: from["harness"], hops };
}

function remoteMessageOf(value: unknown): RemoteMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const from = peerOf(body["from"]);
  const message = body["message"];
  if (
    from === null ||
    !shortString(body["id"], MAX_REMOTE_REF_CHARS) ||
    !shortString(body["to"], MAX_REMOTE_REF_CHARS) ||
    typeof message !== "string" ||
    typeof body["notify"] !== "boolean"
  ) {
    return null;
  }
  return { id: body["id"], from, to: body["to"], message, notify: body["notify"] };
}

function remoteNoticeOf(value: unknown): RemoteNotice | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const from = peerOf(body["from"]);
  const what = body["what"];
  if (
    from === null ||
    !shortString(body["id"], MAX_REMOTE_REF_CHARS) ||
    !shortString(body["subscriber"], MAX_REMOTE_REF_CHARS) ||
    (what !== "idle" && what !== "ended")
  ) {
    return null;
  }
  return { id: body["id"], subscriber: body["subscriber"], from, what };
}

const STATUSES: ReadonlySet<string> = new Set(["working", "idle", "waiting_for_user", "asleep", "starting"]);

/** A row another daemon listed, re-read field by field: nothing of it is drawn or resolved on that daemon's say-so alone. */
function remoteRowOf(value: unknown): Omit<PeerRow, "address" | "machine" | "self"> | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const title = row["title"];
  const folder = row["folder"];
  if (
    !nameString(row["name"]) ||
    !refString(row["ref"]) ||
    !shortString(row["harness"], MAX_PEER_HARNESS_CHARS) ||
    typeof row["status"] !== "string" ||
    !STATUSES.has(row["status"]) ||
    (title !== null && typeof title !== "string") ||
    typeof folder !== "string"
  ) {
    return null;
  }
  return {
    name: row["name"],
    ref: row["ref"],
    harness: row["harness"],
    status: row["status"] as PeerStatus,
    title: title === null ? null : (title as string).slice(0, 200),
    folder: folder.slice(0, 200),
  };
}

function deliveryOf(
  result: MidTurnResult,
):
  | { ok: true; delivery: PeerDelivery; position: number | null }
  | { ok: false; code: PeerRefusal; describe: (to: string) => string } {
  switch (result.kind) {
    case "accepted":
      return { ok: true, delivery: "started_turn", position: null };
    case "steered":
      return { ok: true, delivery: "injected", position: null };
    case "queued":
      return { ok: true, delivery: "queued", position: result.position };
    case "queue_full":
      return {
        ok: false,
        code: "queue_full",
        describe: (to) => `${to} already has ${result.limit} messages from other agents waiting; try again after its turn`,
      };
    case "busy":
      return { ok: false, code: "busy", describe: (to) => `${to} is being cleared or restarted; try again shortly` };
    case "not_ready":
      return { ok: false, code: "starting", describe: (to) => `${to} is still starting; try again shortly` };
    case "terminal":
      return { ok: false, code: "ended", describe: (to) => `${to} has ended` };
  }
}
