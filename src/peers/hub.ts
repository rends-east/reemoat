import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { PeerOrigin } from "../events.js";
import {
  PEER_WAKE_REASONS,
  type ManagedSession,
  type MidTurnResult,
  type SessionRegistry,
  type SessionSnapshot,
} from "../registry.js";
import type { OutboxEntry, PeerLink, SqlitePeerOutboxStore } from "../store/sqlite.js";
import type { PeerAnswer } from "./channel.js";
import { address, parseAddress, peerMessage, peerName, peerNotice } from "./envelope.js";

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
export const REMOTE_LIST_TIMEOUT_MS = 3_000;
const REMOTE_LIST_CONCURRENCY = 8;
const MAX_REMOTE_NAME_CHARS = 64;
const MAX_REMOTE_HARNESS_CHARS = 64;
const MAX_REMOTE_REF_CHARS = 64;

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
  | "link_refused";

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
  noteError(link: PeerLink, message: string | null): void;
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

export type PeerOutbox = Pick<SqlitePeerOutboxStore, "add" | "due" | "retry" | "remove" | "count" | "countFor">;

export interface PeerHubOptions {
  registry: SessionRegistry;
  enabled: boolean;
  /** This machine's own id, from enrollment; how another machine names a session here. */
  machineId?: string | null;
  network?: PeerNetwork | null;
  outbox?: PeerOutbox | null;
  now?: () => number;
  onWarning?: (detail: string) => void;
}

/** Everything a machine's sessions may say to each other and to linked machines' sessions; the one door every peer message passes through. */
export class PeerHub {
  private readonly registry: SessionRegistry;
  readonly enabled: boolean;
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
  private readonly pausedNoted = new Set<string>();
  private readonly subscriptions = new Set<Subscription>();
  private readonly remoteLists = new Map<string, { at: number; answer: Promise<PeerRow[] | string> }>();
  // Notices this machine asked another for; anything else a link sends as a notice is refused.
  private readonly expectedNotices = new Map<string, number>();

  constructor(options: PeerHubOptions) {
    this.registry = options.registry;
    this.enabled = options.enabled;
    this.network = options.network ?? null;
    this.machineId = options.machineId ?? null;
    this.outbox = options.outbox ?? null;
    this.now = options.now ?? Date.now;
    this.warn = options.onWarning ?? null;
  }

  setEndpoint(url: string | null): void {
    this.endpoint = url;
  }

  mcpServersFor(sessionId: string, capabilities: acp.McpCapabilities): acp.McpServer[] {
    if (!this.enabled || this.endpoint === null || capabilities.http !== true) return [];
    const token = randomBytes(32).toString("base64url");
    const previous = this.tokenBySession.get(sessionId);
    if (previous !== undefined) this.sessionByToken.delete(previous);
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

  /** This machine's reachable sessions, as another machine's daemon is shown them. */
  localRows(callerId: string | null = null): PeerRow[] {
    const rows: PeerRow[] = [];
    for (const managed of this.registry.list()) {
      const status = this.peerStatus(managed);
      if (status === null) continue;
      rows.push(this.rowOf(managed, status, managed.id === callerId));
    }
    return rows;
  }

  async list(callerId: string): Promise<PeerListing> {
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

  async send(callerId: string, request: SendRequest): Promise<SendResult> {
    if (!this.enabled) return refuse("messaging_off", "messages between agents are switched off on this machine");
    const sender = this.registry.get(callerId);
    if (sender === undefined) return refuse("unknown_caller", "this session no longer exists");
    const invalid = invalidMessage(request.message);
    if (invalid !== null) return invalid;

    const resolved = await this.resolve(callerId, request.to);
    if (!resolved.ok) return resolved;

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
    if (!this.enabled) return refuse("messaging_off", "messages between agents are switched off on that machine");
    const message = remoteMessageOf(body);
    if (message === null) return refuse("bad_request", "unreadable message");
    const invalid = invalidMessage(message.message);
    if (invalid !== null) return invalid;
    if (message.from.hops > MAX_PEER_HOPS) return refuse("hops_exceeded", "too many agents in a row with no person in between");
    const wait = this.takeToken(`link:${link.id}`, PEER_LINK_BURST, PEER_LINK_REFILL_MS);
    if (wait > 0) return refuse("rate_limited", `that machine is taking messages too fast; wait ${Math.ceil(wait / 1000)}s`);
    const at = this.now();
    this.forgetStale(at);
    const seen = `${link.id}\0${message.id}`;
    if (this.seenMessageIds.has(seen)) return refuse("duplicate", "that message was already delivered");

    const target = this.registry.get(message.to);
    if (target === undefined) return refuse("unknown_recipient", "no such session on that machine");
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
    const result = await this.deliverLocal(target, from, message.message, back !== null, subscriber);
    if (!result.ok) return result;
    this.seenMessageIds.set(seen, at);
    // Its sender answered: the notice this machine was waiting on for that pair is no longer coming.
    this.expectedNotices.delete(expectationKey(link.sourceMachineId, message.from.ref, target.id));
    return result;
  }

  /** POST /peer/notices: only the one this machine asked for, once. */
  async receiveNotice(link: IncomingLink, body: unknown): Promise<boolean> {
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
    if (this.outbox === null || this.outboxTimer !== null) return;
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
    if (this.outbox === null || this.network === null) return;
    const at = this.now();
    for (const entry of this.outbox.due(at, OUTBOX_BATCH)) {
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
      if (result.code === "offline" && at - entry.createdAt < OUTBOX_TTL_MS) {
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
    const ready = await this.registry.readyForMessage(target);
    if (ready !== "ready") return refuse("workspace_missing", `${to} cannot take work: its folder is gone or not answering`);
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
      return { ok: true, id: messageId, delivery: "pending", position: null, to, notify };
    }
    if (notify && !(result.ok && result.notify)) this.expectedNotices.delete(expected);
    return result;
  }

  private remoteResult(link: PeerLink, answer: PeerAnswer, to: string): SendResult {
    const failed = (code: PeerRefusal, message: string): SendResult => {
      this.network?.noteError(link, message);
      return refuse(code, message);
    };
    if (!answer.ok) {
      if (answer.status === 503 || answer.code === "unreachable" || answer.code === "timeout") {
        return failed("offline", `${link.targetName} is not reachable right now (${answer.code}); try again later`);
      }
      if (answer.status === 429) return refuse("rate_limited", `${link.targetName}'s relay is refusing messages this fast; wait and retry`);
      return failed(
        "link_refused",
        `${link.targetName} refused this machine's link (${answer.code}); its owner's app renews links when it next opens`,
      );
    }
    if (answer.status === 404) {
      return failed("peer_too_old", `${link.targetName}'s daemon is too old to take messages from agents; it needs updating`);
    }
    const body = answer.body as Partial<SendResult> | null;
    if (answer.status !== 200 || body === null || typeof body !== "object" || typeof body.ok !== "boolean") {
      return failed("link_refused", `${link.targetName} answered ${answer.status}`);
    }
    this.network?.noteError(link, null);
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
    const { name, ref } = parseAddress(to);
    // Every session, so one that ended is named as ended rather than as unknown.
    const local = this.registry.list();
    const wanted = (name ?? "").toLowerCase();

    if (ref !== null && ref.includes("/")) {
      const slash = ref.indexOf("/");
      const machineId = ref.slice(0, slash);
      const sessionId = ref.slice(slash + 1);
      const link = this.linkTo(machineId);
      if (link === null) return refuse("unknown_recipient", `this machine has no link to ${machineId}`);
      const rows = await this.remoteRows(link);
      const row = typeof rows === "string" ? null : rows.find((one) => one.ref === ref) ?? null;
      return { ok: true, kind: "remote", link, sessionId, name: row?.name ?? name ?? sessionId };
    }

    const localMatches =
      ref !== null
        ? local.filter((managed) => managed.id === ref)
        : local.filter((managed) => managed.id === name || this.nameOf(managed).toLowerCase() === wanted);
    const remoteMatches: PeerRow[] = [];
    if (ref === null && this.network !== null) {
      for (const [, rows] of await this.remoteListings()) {
        if (typeof rows !== "string") remoteMatches.push(...rows.filter((row) => row.name.toLowerCase() === wanted));
      }
    }
    const total = localMatches.length + remoteMatches.length;
    if (total === 0) {
      const names = this.localRows(callerId)
        .filter((row) => !row.self)
        .map((row) => row.address);
      return refuse(
        "unknown_recipient",
        names.length === 0
          ? `no session is called ${JSON.stringify(to)}; run list_agents to see what there is`
          : `no session is called ${JSON.stringify(to)}; on this machine there are: ${names.slice(0, 12).join(", ")}`,
      );
    }
    if (total > 1) {
      const candidates = [
        ...localMatches.map((managed) => address(this.nameOf(managed), managed.id)),
        ...remoteMatches.map((row) => row.address),
      ];
      return refuse("ambiguous_recipient", `more than one session is called that; use one of: ${candidates.join(", ")}`);
    }
    if (remoteMatches.length === 1) {
      const row = remoteMatches[0]!;
      const slash = row.ref.indexOf("/");
      const link = this.linkTo(row.ref.slice(0, slash))!;
      return { ok: true, kind: "remote", link, sessionId: row.ref.slice(slash + 1), name: row.name };
    }
    const target = localMatches[0]!;
    if (target.id === callerId) return refuse("self", "that is this session");
    if (this.peerStatus(target) === null) {
      return refuse(
        "ended",
        `${address(this.nameOf(target), target.id)} has ended or was stopped by its person; it takes messages again once someone starts it`,
      );
    }
    return { ok: true, kind: "local", target };
  }

  private linkTo(machineId: string): PeerLink | null {
    if (this.network === null) return null;
    const at = this.now();
    return this.network.links().find((link) => link.targetMachineId === machineId && link.expiresAt > at) ?? null;
  }

  private async remoteListings(): Promise<[PeerLink, PeerRow[] | string][]> {
    if (this.network === null || !this.enabled) return [];
    const at = this.now();
    const links = this.network.links().filter((link) => link.expiresAt > at);
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
        if (!reply.ok) {
          const reason = reply.status === 503 ? "offline" : reply.code;
          this.network?.noteError(link, `listing failed: ${reason}`);
          return reason;
        }
        if (reply.status === 404) return "its daemon is too old for messages from agents";
        const rows = (reply.body as { agents?: unknown } | null)?.agents;
        if (reply.status !== 200 || !Array.isArray(rows)) return `answered ${reply.status}`;
        this.network?.noteError(link, null);
        return rows.flatMap((row) => {
          const remote = remoteRowOf(row);
          if (remote === null) return [];
          const ref = `${link.targetMachineId}/${remote.ref}`;
          return [{ ...remote, ref, address: address(remote.name, ref), machine: { label: link.targetName, isThis: false }, self: false }];
        });
      },
    );
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
      case "failed": {
        const reason = managed.exit?.reason;
        return reason !== undefined && PEER_WAKE_REASONS.includes(reason) && this.registry.wakesOnPrompt(managed)
          ? "asleep"
          : null;
      }
    }
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

  private nameOf(managed: ManagedSession): string {
    return peerName(managed.title, basename(managed.workspace.requestedCwd), managed.agent);
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
    const session = this.registry.get(sessionId);
    if (session === undefined || this.peerStatus(session) === null) return;
    // The budget holds for notices too, or two agents handing each other work would never stop.
    if (session.peerTurnsSinceHuman >= PEER_TURN_BUDGET) return;
    if ((await this.registry.readyForMessage(session)) !== "ready") return;
    await session.submit(text, from);
  }

  private async notifyRemote(
    subscriber: { machineId: string; sessionRef: string },
    target: ManagedSession,
    what: "idle" | "ended",
  ): Promise<void> {
    const link = this.linkTo(subscriber.machineId);
    if (link === null) return;
    const notice: RemoteNotice = {
      id: `pn_${randomBytes(8).toString("hex")}`,
      subscriber: subscriber.sessionRef,
      from: { ref: target.id, name: this.nameOf(target), harness: target.agent, hops: target.peerDepth },
      what,
    };
    const answer = await this.network!.request(link, { method: "POST", path: "/peer/notices", body: notice });
    if (!answer.ok) this.network?.noteError(link, `an idle notice was not delivered: ${answer.code}`);
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

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

function peerOf(value: unknown): { ref: string; name: string; harness: string; hops: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const from = value as Record<string, unknown>;
  const hops = from["hops"];
  if (
    !shortString(from["ref"], MAX_REMOTE_REF_CHARS) ||
    !shortString(from["name"], MAX_REMOTE_NAME_CHARS) ||
    !shortString(from["harness"], MAX_REMOTE_HARNESS_CHARS) ||
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
    !shortString(row["name"], MAX_REMOTE_NAME_CHARS) ||
    !shortString(row["ref"], MAX_REMOTE_REF_CHARS) ||
    row["ref"].includes("/") ||
    !shortString(row["harness"], MAX_REMOTE_HARNESS_CHARS) ||
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
