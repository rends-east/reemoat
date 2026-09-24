import { formatLocation, hasInput, readInput, readQuestions } from "../permission";
import type { Gap } from "../store";
import type {
  AnswerResolvedBy,
  ElicitationAnswerSummary,
  ElicitationResolvedEvent,
  FileChangeEvent,
  FileLocation,
  PermissionOptionKind,
  PermissionOptionSummary,
  SessionEvent,
  StoredEvent,
  StoredFileRef,
  ToolCallStatus,
  ToolKind,
} from "../wire";

/** Safety bound only; CSS truncates the visible row far shorter. */
export const SUMMARY_CHARS = 120;

/** Clipped in code, not CSS, so the row knows whether anything was cut. */
export const TITLE_CHARS = 80;

export const TITLE_OVERFLOW_MIN = 20;

export function clipTitle(title: string): { text: string; clipped: boolean } {
  if (title.length <= TITLE_CHARS + TITLE_OVERFLOW_MIN) return { text: title, clipped: false };
  return { text: `${title.slice(0, TITLE_CHARS)}…`, clipped: true };
}

const HEADLINE_ECHO_CHARS = 24;

/** Compares a prefix: codex's truncated copies end in ` ...`, so whole-string containment fails. */
export function headlineWorthDrawing(title: string, headline: string | null): boolean {
  if (headline === null || headline.length === 0 || headline === title) return false;
  const echo = headline.slice(0, HEADLINE_ECHO_CHARS);
  return !title.includes(echo);
}

/** Keeps the newest children (the oldest are evicted); it does not bound render cost. */
export const MAX_CHILDREN = 40;

/** An indent clamp, not a cycle bound: every walk over `parentId` carries a visited set. */
export const MAX_DEPTH = 2;

const TRUNCATED_ARGS = "(arguments too large to keep in the log)";

export interface TextNode {
  kind: "text";
  key: string;
  seq: number;
  role: string;
  thought: boolean;
  text: string;
  parentId: string | null;
}

export interface ToolNode {
  kind: "tool";
  key: string;
  seq: number;
  toolCallId: string;
  parentId: string | null;
  title: string;
  toolKind: ToolKind;
  status: ToolCallStatus;
  rawInput: unknown;
  locations: readonly FileLocation[];
  output: readonly string[] | null;
  images: readonly StoredFileRef[];
  /** Read from the `tool_call` only: claude drops it on the spawn's completing update (Q6.3). */
  subagent: boolean;
  /** Sticky-true off the updates; a later update never resets it. */
  backgrounded: boolean;
  changes: readonly FileChangeEvent[];
  children: TailNode[];
  steps: number;
  omitted: number;
  latest: string | null;
  elapsedMs: number | null;
}

export interface UpdateNode {
  kind: "update";
  key: string;
  seq: number;
  toolCallId: string;
  parentId: string | null;
  title: string | null;
}

export interface ChangeNode {
  kind: "change";
  key: string;
  seq: number;
  parentId: string | null;
  toolCallId: string | null;
  event: FileChangeEvent;
}

export interface GroupNode {
  kind: "group";
  key: string;
  seq: number;
  parentId: null;
  children: TailNode[];
  tally: RunTally;
  failed: number;
  approved: number;
  /** Only rows whose liveness the log decides may join a run; see `foldable`. */
  live: boolean;
}

export interface EventNode {
  kind: "event";
  key: string;
  seq: number;
  parentId: string | null;
  stored: StoredEvent;
  /** Permissions only: the tool call's own title when the daemon's title is just the call id. */
  heading: string | null;
  /** Questions joined from the asking call's `rawInput`, for a settled elicitation; null otherwise. */
  asked: AnsweredQuestion[] | null;
}

export interface AnsweredQuestion {
  key: string;
  question: string | null;
  label: string;
  value: string;
}

function sameAsked(
  a: readonly AnsweredQuestion[] | null,
  b: readonly AnsweredQuestion[] | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const one = a[i];
    const other = b[i];
    if (one === undefined || other === undefined) return false;
    if (one.key !== other.key || one.question !== other.question) return false;
    if (one.label !== other.label || one.value !== other.value) return false;
  }
  return true;
}

export interface GapNode {
  kind: "gap";
  key: string;
  seq: number;
  parentId: null;
  gap: Gap;
}

export type TailNode = TextNode | ToolNode | UpdateNode | ChangeNode | GroupNode | EventNode | GapNode;

/** Value equality for `React.memo`: `buildTail` rebuilds every node per token; members compare by `===` since stored events are never mutated. */
export function sameNode(a: TailNode, b: TailNode): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key || a.seq !== b.seq) return false;
  switch (a.kind) {
    case "text": {
      const other = b as TextNode;
      return a.role === other.role && a.thought === other.thought && a.text === other.text;
    }
    case "tool": {
      const other = b as ToolNode;
      return (
        a.title === other.title &&
        a.toolKind === other.toolKind &&
        a.status === other.status &&
        a.rawInput === other.rawInput &&
        a.subagent === other.subagent &&
        // Compared: an update can flip it without moving any other field.
        a.backgrounded === other.backgrounded &&
        a.steps === other.steps &&
        a.omitted === other.omitted &&
        a.latest === other.latest &&
        a.elapsedMs === other.elapsedMs &&
        sameList(a.locations, other.locations) &&
        sameList(a.output, other.output) &&
        sameList(a.images, other.images) &&
        sameList(a.changes, other.changes) &&
        sameNodes(a.children, other.children)
      );
    }
    case "update":
      return a.title === (b as UpdateNode).title;
    case "change":
      return a.event === (b as ChangeNode).event;
    case "group": {
      const other = b as GroupNode;
      return (
        a.failed === other.failed &&
        a.approved === other.approved &&
        a.live === other.live &&
        sameTally(a.tally, other.tally) &&
        sameNodes(a.children, other.children)
      );
    }
    case "event": {
      const other = b as EventNode;
      return a.stored === other.stored && a.heading === other.heading && sameAsked(a.asked, other.asked);
    }
    case "gap": {
      const other = b as GapNode;
      return a.gap.from === other.gap.from && a.gap.to === other.gap.to && a.gap.reason === other.gap.reason;
    }
  }
}

function sameList<T>(a: readonly T[] | null, b: readonly T[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function sameNodes(a: readonly TailNode[], b: readonly TailNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((node, index) => {
    const other = b[index];
    return other !== undefined && sameNode(node, other);
  });
}

export interface Tail {
  rows: TailNode[];
  hidden: number;
  /** Seq at or below which a `pending` call is stranded (after `session_started` or an abnormal `turn_end`); 0 if none. */
  taskFloor: number;
}

export interface PendingUpdate {
  ts: number;
  status: ToolCallStatus | null;
  title: string | null;
  rawInput: unknown;
  locations: readonly FileLocation[];
  content: readonly string[] | null;
  images?: readonly StoredFileRef[] | null;
  parentToolCallId?: string | null;
  backgrounded?: boolean;
}

export interface MergedUpdate {
  status: ToolCallStatus | null;
  title: string | null;
  rawInput: unknown;
  locations: readonly FileLocation[];
  content: string[];
  images: StoredFileRef[];
  /** First non-null, never reset: claude omits lineage on its `toolResponse` updates. */
  parentToolCallId: string | null;
  backgrounded: boolean;
  /** From the update carrying the newest status: claude sends all-null updates after a terminal one. */
  statusTs: number | null;
}

/** Models stream arguments as cumulative blocks, so a strict extension replaces its draft; exact repeats stay. */
export function supersedes(block: string, previous: string): boolean {
  return block.length > previous.length && block.startsWith(previous);
}

/** The call's arguments restated as JSON; judged after the fold, since the copies precede `rawInput`. */
export function restatesInput(block: string, rawInput: unknown): boolean {
  if (!hasInput(rawInput)) return false;
  const want = JSON.stringify(rawInput);
  if (want === undefined) return false;
  const head = block.trimStart();
  if (head.length === 0 || head[0] !== want[0]) return false;
  if (head === want) return true;
  try {
    return JSON.stringify(JSON.parse(head)) === want;
  } catch {
    return false;
  }
}

/** Folds updates in document order: last non-null wins per field, content accumulates minus drafts and restated input. */
export function mergeUpdates(
  updates: readonly PendingUpdate[],
): MergedUpdate {
  const merged: MergedUpdate = {
    status: null,
    title: null,
    rawInput: null,
    locations: [],
    content: [],
    images: [],
    parentToolCallId: null,
    backgrounded: false,
    statusTs: null,
  };
  for (const update of updates) {
    if (update.status !== null) {
      merged.status = update.status;
      merged.statusTs = update.ts;
    }
    if (update.title !== null) merged.title = update.title;
    if (update.locations.length > 0) merged.locations = update.locations;
    // Arguments arrive as `{}` before they are filled in.
    if (hasInput(update.rawInput)) merged.rawInput = update.rawInput;
    if (update.content !== null && update.content !== undefined) {
      for (const block of update.content) {
        const last = merged.content.at(-1);
        if (last !== undefined && supersedes(block, last)) merged.content[merged.content.length - 1] = block;
        else merged.content.push(block);
      }
    }
    merged.images.push(...(update.images ?? []));
    merged.parentToolCallId ??= update.parentToolCallId ?? null;
    if (update.backgrounded === true) merged.backgrounded = true;
  }
  merged.content = merged.content.filter((block) => !restatesInput(block, merged.rawInput));
  return merged;
}

export function resolveTool(
  call: {
    title: string;
    kind: ToolKind;
    status: ToolCallStatus;
    rawInput: unknown;
    locations: readonly FileLocation[];
  },
  merged: MergedUpdate | null,
): Pick<ToolNode, "title" | "toolKind" | "status" | "rawInput" | "locations" | "output" | "images"> {
  return {
    title: merged?.title ?? call.title,
    toolKind: call.kind,
    status: merged?.status ?? call.status,
    // Newest non-empty wins: codex refines its call's arguments in a later update.
    rawInput: hasInput(merged?.rawInput)
      ? (merged?.rawInput ?? null)
      : hasInput(call.rawInput)
        ? call.rawInput
        : null,
    locations: call.locations.length > 0 ? call.locations : (merged?.locations ?? []),
    output: merged !== null && merged.content.length > 0 ? merged.content : null,
    images: merged?.images ?? [],
  };
}

export function toolSummary(
  rawInput: unknown,
  locations: readonly FileLocation[],
  rel: (path: string) => string | null = () => null,
): { summary: string | null; detail: string | null } {
  const input = readInput(rawInput);
  const detail = input.command ?? input.pretty ?? (input.truncated ? TRUNCATED_ARGS : null);
  const first = locations[0];
  // Paths are shortened but a command never is: that would show a command that never ran.
  const target = input.target === null ? null : (rel(input.target) ?? input.target);
  const located =
    first === undefined ? null : formatLocation({ path: rel(first.path) ?? first.path, line: first.line });
  return {
    summary: input.command ?? target ?? located,
    detail,
  };
}

/** False when the body would only repeat the row. */
export function opensToAnything(card: {
  detail: string | null;
  headline: string | null;
  outputBlocks: number;
  locations: number;
  children: number;
  changes: number;
  titleClipped: boolean;
}): boolean {
  if (card.outputBlocks > 0 || card.locations > 0 || card.children > 0 || card.changes > 0) return true;
  if (card.titleClipped) return true;
  return detailWorthDrawing(card.detail, card.headline);
}

/** Shared by `opensToAnything` and the card body so the two agree. */
export function detailWorthDrawing(detail: string | null, headline: string | null): boolean {
  if (detail === null) return false;
  return detail !== headline || detail.length > SUMMARY_CHARS;
}

export function stripFence(block: string): string {
  const lines = block.split("\n");
  if (lines.length < 2) return block;
  const first = lines[0]?.trimEnd() ?? "";
  if (!first.startsWith("```")) return block;
  const closing = lines.at(-1)?.trim() === "```" ? lines.length - 1 : -1;
  if (closing < 1) return block;
  return lines.slice(1, closing).join("\n");
}

/** Agents may send `parentId` cycles and reused ids, so every walk here is visited-set bounded and a reused id renders flat. */
export function placeNodes(collected: readonly TailNode[]): TailNode[] {
  const rows: TailNode[] = [];
  const byId = new Map<string, ToolNode>();
  const depthOf = new Map<string, number>();
  const spokenFor = new Map<string, number>();
  const credit = (path: string): void => {
    spokenFor.set(path, (spokenFor.get(path) ?? 0) + 1);
  };
  const spend = (path: string): boolean => {
    const left = spokenFor.get(path) ?? 0;
    if (left === 0) return false;
    spokenFor.set(path, left - 1);
    return true;
  };

  for (const node of collected) {
    // The `foldedInto` rule: an update whose call is in the window is drawn by that card.
    if (node.kind === "update" && byId.has(node.toolCallId)) continue;

    // kimi's `fs_write` twin of an edit is dropped 1:1 by path credit, never by text (Q6.12, Q7.29).
    if (node.kind === "change") {
      if (node.toolCallId !== null && byId.has(node.toolCallId)) continue;
      if (node.event.source === "fs_write" && spend(node.event.path)) continue;
      if (node.event.source === "diff") credit(node.event.path);
    }

    let parent = node.parentId === null ? undefined : byId.get(node.parentId);

    // `climbed` breaks cycles whose members all sit at the exit depth.
    const climbed = new Set<string>();
    while (parent !== undefined && (depthOf.get(parent.toolCallId) ?? 0) + 1 >= MAX_DEPTH) {
      if (climbed.has(parent.toolCallId)) {
        parent = undefined;
        break;
      }
      climbed.add(parent.toolCallId);
      const grandparentId = parent.parentId;
      parent = grandparentId === null ? undefined : byId.get(grandparentId);
    }

    if (node.kind === "tool") {
      for (const change of node.changes) credit(change.path);
      if (byId.has(node.toolCallId)) {
        rows.push(node);
        continue;
      }
      byId.set(node.toolCallId, node);
      depthOf.set(node.toolCallId, parent === undefined ? 0 : (depthOf.get(parent.toolCallId) ?? 0) + 1);
    }

    if (parent === undefined) {
      rows.push(node);
      continue;
    }

    // The same quantity as claude's `totalToolUseCount`: tool calls at every depth, evicted ones included.
    if (node.kind === "tool") {
      const seen = new Set<string>([node.toolCallId]);
      for (let ancestor: ToolNode | undefined = parent; ancestor !== undefined; ) {
        if (seen.has(ancestor.toolCallId)) break;
        seen.add(ancestor.toolCallId);
        ancestor.steps += 1;
        const nextId: string | null = ancestor.parentId;
        ancestor = nextId === null ? undefined : byId.get(nextId);
      }
    }

    if (parent.children.length >= MAX_CHILDREN) {
      const evicted = parent.children.shift();
      if (evicted?.kind === "tool") parent.omitted += 1;
    }
    parent.children.push(node);
  }

  for (const node of byId.values()) {
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (child !== undefined && child.kind === "tool") {
        node.latest = child.title;
        break;
      }
    }
  }

  return rows;
}

/** From the ACP kind, never a title or tool name; unknown kinds are `other`. */
export type RunClauseKind =
  | "execute"
  | "create"
  | "edit"
  | "delete"
  | "read"
  | "search"
  | "fetch"
  | "move"
  | "mode"
  | "other";

export interface RunClause {
  kind: RunClauseKind;
  count: number;
  name: string | null;
}

export interface RunTally {
  clauses: readonly RunClause[];
  changes: readonly FileChangeEvent[];
}

export function runSummary(tally: RunTally): string {
  const parts = tally.clauses.map(clausePhrase).filter((phrase) => phrase.length > 0);
  if (parts.length === 0) return "did nothing";
  const sentence = parts.join(", ");
  const capitalised = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return capitalised.length > SUMMARY_CHARS ? `${capitalised.slice(0, SUMMARY_CHARS)}…` : capitalised;
}

function clausePhrase(clause: RunClause): string {
  const { count, name } = clause;
  const one = count === 1 && name !== null;
  switch (clause.kind) {
    case "execute":
      return count === 1 ? "ran a command" : `ran ${count} commands`;
    case "create":
      return one ? `created ${name}` : count === 1 ? "created a file" : `created ${count} files`;
    case "edit":
      return one ? `edited ${name}` : count === 1 ? "edited a file" : `edited ${count} files`;
    case "delete":
      return one ? `deleted ${name}` : count === 1 ? "deleted a file" : `deleted ${count} files`;
    case "move":
      return one ? `moved ${name}` : count === 1 ? "moved a file" : `moved ${count} files`;
    case "read":
      return one ? `read ${name}` : count === 1 ? "read a file" : `read ${count} files`;
    case "search":
      return one ? `searched for “${name}”` : count === 1 ? "searched" : `ran ${count} searches`;
    case "fetch":
      return count === 1 ? "fetched a page" : `fetched ${count} pages`;
    case "mode":
      return count === 1 ? "switched mode" : `switched mode ${count} times`;
    case "other":
      return one ? `used ${name}` : count === 1 ? "used a tool" : `used ${count} tools`;
  }
}

const CLAUSE_NAME_CHARS = 40;

function tallyOf(run: readonly TailNode[]): RunTally {
  const order: RunClauseKind[] = [];
  const counts = new Map<RunClauseKind, { count: number; names: string[] }>();
  const changes: FileChangeEvent[] = [];

  const add = (kind: RunClauseKind, name: string | null): void => {
    let entry = counts.get(kind);
    if (entry === undefined) {
      entry = { count: 0, names: [] };
      counts.set(kind, entry);
      order.push(kind);
    }
    entry.count += 1;
    if (name !== null && name.length > 0) entry.names.push(name);
  };

  for (const node of run) {
    if (node.kind === "change") {
      changes.push(node.event);
      add(node.event.oldText === null ? "create" : "edit", nameOfPath(node.event.path));
      continue;
    }
    if (node.kind !== "tool") continue;

    if (node.changes.length > 0) {
      for (const change of node.changes) {
        changes.push(change);
        add(change.oldText === null ? "create" : "edit", nameOfPath(change.path));
      }
      continue;
    }
    add(clauseFor(node.toolKind), nameOfTool(node));
  }

  return {
    clauses: order.map((kind) => {
      const entry = counts.get(kind);
      const names = entry?.names ?? [];
      return {
        kind,
        count: entry?.count ?? 0,
        name: names.length === 1 ? (names[0] ?? null) : null,
      };
    }),
    changes,
  };
}

function clauseFor(kind: ToolKind): RunClauseKind {
  switch (kind) {
    case "execute":
      return "execute";
    case "edit":
      return "edit";
    case "delete":
      return "delete";
    case "move":
      return "move";
    case "read":
      return "read";
    case "search":
      return "search";
    case "fetch":
      return "fetch";
    case "switch_mode":
      return "mode";
    default:
      return "other";
  }
}

function nameOfPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.length === 0 || name.length > CLAUSE_NAME_CHARS ? null : name;
}

function nameOfTool(node: ToolNode): string | null {
  if (node.toolKind === "execute" || node.toolKind === "fetch" || node.toolKind === "switch_mode") {
    return null;
  }
  if (node.toolKind !== "read" && node.toolKind !== "search" && node.toolKind !== "edit") {
    const title = node.title.trim();
    return title.length === 0 || title.length > CLAUSE_NAME_CHARS ? null : title;
  }
  const { summary } = toolSummary(node.rawInput, node.locations);
  const candidate = summary ?? node.title;
  if (candidate.length === 0) return null;
  const name = node.toolKind === "search" ? candidate : nameOfPath(candidate);
  if (name === null) return null;
  return name.length > CLAUSE_NAME_CHARS ? null : name;
}

function sameTally(a: RunTally, b: RunTally): boolean {
  if (a.clauses.length !== b.clauses.length) return false;
  for (let i = 0; i < a.clauses.length; i += 1) {
    const one = a.clauses[i];
    const other = b.clauses[i];
    if (one === undefined || other === undefined) return false;
    if (one.kind !== other.kind || one.count !== other.count || one.name !== other.name) return false;
  }
  return sameList(a.changes, b.changes);
}

/** `pending` counts (a spawn may skip `in_progress`); a backgrounded call is not running here, only the snapshot knows (Q7.113). */
export function stillRunning(node: ToolNode): boolean {
  return node.status === "pending" || node.status === "in_progress";
}

export function isDelegation(node: ToolNode): boolean {
  return node.subagent || node.steps > 0;
}

export interface OutstandingTask {
  key: string;
  seq: number;
  title: string;
  latest: string | null;
  steps: number;
}

/** Running delegations above `floor`, read from the log, not the snapshot; blind to work behind an already-completed call (Q7.113, Q2.228). */
export function outstandingTasks(rows: readonly TailNode[], floor = 0): OutstandingTask[] {
  const out: OutstandingTask[] = [];
  const seen = new Set<string>();
  const walk = (nodes: readonly TailNode[]): void => {
    for (const node of nodes) {
      if (seen.has(node.key)) continue;
      seen.add(node.key);
      if (node.kind === "group") {
        walk(node.children);
        continue;
      }
      if (node.kind !== "tool") continue;
      if (node.seq <= floor) {
        continue;
      }
      if (isDelegation(node) && stillRunning(node)) {
        out.push({
          key: node.key,
          seq: node.seq,
          title: node.title,
          latest: node.latest,
          steps: node.steps,
        });
        continue;
      }
      walk(node.children);
    }
  };
  walk(rows);
  return out;
}

/** Only changes, non-delegation foreground tool calls and known approvals fold; a backgrounded call stays out because run membership must depend on the log alone. */
function foldable(node: TailNode, decisions: ReadonlyMap<string, PermissionOptionKind>): boolean {
  if (node.kind === "change") return true;
  if (node.kind === "tool") return !isDelegation(node) && !node.backgrounded;
  if (node.kind !== "event") return false;
  const event = node.stored.event;
  if (event.type !== "permission_resolved" || event.outcome !== "selected") return false;
  const kind = decisions.get(event.permissionId);
  return kind !== undefined && !refused(kind);
}

export function foldRuns(
  rows: readonly TailNode[],
  decisions: ReadonlyMap<string, PermissionOptionKind> = new Map(),
): TailNode[] {
  const out: TailNode[] = [];
  let run: TailNode[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      const only = run[0];
      if (only !== undefined) out.push(only);
      run = [];
      return;
    }
    const first = run[0];
    if (first === undefined) {
      run = [];
      return;
    }
    if (!run.some((node) => node.kind === "tool" || node.kind === "change")) {
      out.push(...run);
      run = [];
      return;
    }
    let failed = 0;
    let approved = 0;
    let live = false;
    for (const node of run) {
      if (node.kind === "event") {
        approved += 1;
        continue;
      }
      if (node.kind !== "tool") continue;
      if (node.status === "failed") failed += 1;
      if (stillRunning(node)) live = true;
    }
    out.push({
      kind: "group",
      key: `r${first.seq}`,
      seq: first.seq,
      parentId: null,
      children: run,
      tally: tallyOf(run),
      failed,
      approved,
      live,
    });
    run = [];
  };

  for (const node of rows) {
    if (foldable(node, decisions)) {
      run.push(node);
      continue;
    }
    flushRun();
    out.push(node);
  }
  flushRun();
  return out;
}

export function buildTail(
  events: readonly StoredEvent[],
  gaps: readonly Gap[],
  cut = 0,
  decisions: ReadonlyMap<string, PermissionOptionKind> = new Map(),
): Tail {
  const collected: TailNode[] = [];
  let taskFloor = 0;
  // Collapses consecutive plan events to the newest; -1 so a leading plan is kept.
  let planFloor = -1;
  let run: {
    seq: number;
    role: string;
    thought: boolean;
    messageId: string | null;
    parts: string[];
  } | null = null;

  const updates = new Map<
    string,
    PendingUpdate[]
  >();

  const titleByCall = new Map<string, string>();

  // Kept because `nodeFor` drops asked-through calls, and their `rawInput` is the only copy of the questions.
  const inputByCall = new Map<string, unknown>();

  const changesByCall = new Map<string, FileChangeEvent[]>();

  const resolvedPermissions = new Set<string>();
  const resolvedElicitations = new Set<string>();
  const askedThrough = new Set<string>();

  const flush = (): void => {
    if (run === null) return;
    const current = run;
    collected.push({
      kind: "text",
      key: `t${current.seq}`,
      seq: current.seq,
      role: current.role,
      thought: current.thought,
      text: current.parts.reverse().join(""),
      parentId: null,
    });
    run = null;
  };

  let index = events.length - 1;
  for (; index >= 0; index -= 1) {
    const stored = events[index];
    if (stored === undefined) continue;
    if (stored.seq < cut) {
      flush();
      break;
    }
    const event = stored.event;

    if (
      taskFloor === 0 &&
      (event.type === "session_started" ||
        (event.type === "turn_end" && event.stopReason !== "end_turn"))
    ) {
      taskFloor = stored.seq;
    }

    if (event.type === "text") {
      // Flushed, not skipped: parts join with no separator.
      if (!showsInTranscript(event)) {
        flush();
        continue;
      }
      // A new `messageId` starts a new run (Q3.604).
      const sameMessage = (run?.messageId ?? null) === (event.messageId ?? null);
      if (run !== null && sameMessage && run.role === event.role && run.thought === event.thought) {
        run.parts.push(event.text);
        run.seq = stored.seq;
        continue;
      }
      flush();
      run = {
        seq: stored.seq,
        role: event.role,
        thought: event.thought,
        messageId: event.messageId ?? null,
        parts: [event.text],
      };
      continue;
    }

    if (event.type === "tool_call_update") {
      let list = updates.get(event.toolCallId);
      if (list === undefined) {
        list = [];
        updates.set(event.toolCallId, list);
      }
      list.unshift({
        ts: stored.ts,
        status: event.status,
        title: event.title,
        rawInput: event.rawInput,
        locations: event.locations,
        content: event.content ?? null,
        // Rebuilt field by field: a new `PendingUpdate` member must be named here too.
        images: event.images ?? null,
        parentToolCallId: event.parentToolCallId ?? null,
        backgrounded: event.backgrounded,
      });
    }

    if (
      (event.type === "tool_call" || event.type === "tool_call_update") &&
      event.title !== null &&
      event.title !== event.toolCallId &&
      !titleByCall.has(event.toolCallId)
    ) {
      titleByCall.set(event.toolCallId, event.title);
    }

    if (
      (event.type === "tool_call" || event.type === "tool_call_update") &&
      !inputByCall.has(event.toolCallId) &&
      hasInput(event.rawInput)
    ) {
      inputByCall.set(event.toolCallId, event.rawInput);
    }

    if (event.type === "file_change" && event.toolCallId !== null) {
      let list = changesByCall.get(event.toolCallId);
      if (list === undefined) {
        list = [];
        changesByCall.set(event.toolCallId, list);
      }
      list.unshift(event);
    }

    if (event.type === "permission_resolved") resolvedPermissions.add(event.permissionId);
    if (event.type === "elicitation_resolved") resolvedElicitations.add(event.elicitationId);
    if (
      (event.type === "elicitation_request" || event.type === "elicitation_resolved") &&
      event.toolCallId !== null
    ) {
      askedThrough.add(event.toolCallId);
    }

    // Silent events must not split a text run into two Markdown blocks; `turn_end` still does.
    if (!TRANSCRIPT_SILENT.has(event.type)) flush();

    const node = nodeFor(
      stored,
      updates,
      changesByCall,
      resolvedPermissions,
      resolvedElicitations,
      askedThrough,
    );
    if (node !== null) {
      if (stored.event.type === "plan" && collected.length === planFloor) continue;
      collected.push(node);
      if (stored.event.type === "plan") planFloor = collected.length;
    }
  }
  flush();

  for (const node of collected) {
    if (node.kind !== "event") continue;
    const event = node.stored.event;
    if (event.type !== "permission_request" && event.type !== "permission_resolved") continue;
    if (event.toolCallId === null || event.title !== event.toolCallId) continue;
    node.heading = titleByCall.get(event.toolCallId) ?? null;
  }

  for (const node of collected) {
    if (node.kind !== "event") continue;
    const event = node.stored.event;
    if (event.type !== "elicitation_resolved" || event.toolCallId === null) continue;
    const answers = event.answers ?? [];
    if (answers.length === 0) continue;
    node.asked = answeredQuestions(answers, inputByCall.get(event.toolCallId));
  }

  const rows = placeNodes(collected.reverse());

  const oldestRendered = events[index + 1]?.seq ?? 0;
  for (const gap of gaps) {
    if (gap.from - 0.5 >= oldestRendered) {
      rows.push({ kind: "gap", key: `g${gap.from}`, seq: gap.from - 0.5, parentId: null, gap });
    }
  }

  rows.sort((a, b) => a.seq - b.seq);
  return { rows: foldRuns(rows, decisions), hidden: index + 1, taskFloor };
}

/** Event types that never draw a row; `workspace` warnings are deliberately drawn nowhere. */
export const TRANSCRIPT_SILENT: ReadonlySet<string> = new Set([
  "agent_config",
  "session_started",
  "agent_log",
  "other",
  "status",
  "workspace",
]);

export function showsInTranscript(event: SessionEvent): boolean {
  if (TRANSCRIPT_SILENT.has(event.type)) return false;
  if (event.type === "turn_end") return event.stopReason !== "end_turn" && event.stopReason !== "agent_error";
  if (event.type === "text") return !event.thought;
  return true;
}

/** Joined by `optionId` against the request's options: `outcome: "selected"` includes rejections. */
export function permissionDecisions(
  events: readonly StoredEvent[],
): ReadonlyMap<string, PermissionOptionKind> {
  const options = new Map<string, readonly PermissionOptionSummary[]>();
  const decided = new Map<string, PermissionOptionKind>();
  for (const stored of events) {
    const event = stored.event;
    if (event.type === "permission_request" && event.permissionId !== null) {
      options.set(event.permissionId, event.options);
      continue;
    }
    if (event.type !== "permission_resolved" || event.optionId === null) continue;
    const chosen = options.get(event.permissionId)?.find((o) => o.optionId === event.optionId);
    if (chosen !== undefined) decided.set(event.permissionId, chosen.kind);
  }
  return decided;
}

export function refused(kind: PermissionOptionKind | undefined): boolean {
  return kind === "reject_once" || kind === "reject_always";
}

const RESOLVED_BY_TEXT: Partial<Record<AnswerResolvedBy, string>> = {
  agent_withdrew: "the agent withdrew it",
  agent_gone: "the agent went away",
  session_stopped: "the session was stopped",
  turn_ended: "the turn ended first",
  pump_failed: "lost the agent",
  no_turn: "no turn to answer into",
  turn_cancelled: "you stopped the turn",
};

export function resolvedByText(by: AnswerResolvedBy): string {
  return RESOLVED_BY_TEXT[by] ?? by.replace(/_/g, " ");
}

const STOP_REASON_TEXT: Record<string, string> = {
  cancelled: "cancelled",
  max_tokens: "the agent ran out of room",
  max_turn_requests: "the agent hit its step limit",
  refusal: "the agent declined",
  // Drawn because no row above accounts for the silence (Q2.231).
  abandoned: "the agent stopped answering",
};

export function stopReasonText(stopReason: string): string {
  return STOP_REASON_TEXT[stopReason] ?? `turn ended: ${stopReason}`;
}

/** Matched by option label, never field key; a label shared by two questions matches neither. */
const AMBIGUOUS = Symbol("two questions offer this answer");

export function answeredQuestions(
  answers: readonly ElicitationAnswerSummary[],
  input: unknown,
): AnsweredQuestion[] | null {
  const questions = readQuestions(input);
  if (questions === null) return null;
  const byLabel = new Map<string, string | typeof AMBIGUOUS>();
  for (const question of questions) {
    for (const option of question.options) {
      const seen = byLabel.get(option.label);
      byLabel.set(option.label, seen === undefined || seen === question.question ? question.question : AMBIGUOUS);
    }
  }
  let matched = 0;
  const out = answers.map((answer) => {
    const found = byLabel.get(answer.value);
    const question = found === undefined || found === AMBIGUOUS ? null : found;
    if (question !== null) matched += 1;
    return { key: answer.key, question, label: answer.label, value: answer.value };
  });
  return matched === 0 ? null : out;
}

export function elicitationOutcome(event: ElicitationResolvedEvent): {
  tone: "ok" | "quiet" | "warn";
  verb: "answered" | "skipped" | "cancelled";
} {
  if (event.action === "decline") return { tone: "quiet", verb: "skipped" };
  if (event.action !== "accept") return { tone: "warn", verb: "cancelled" };
  return { tone: "ok", verb: "answered" };
}

function nodeFor(
  stored: StoredEvent,
  updates: Map<
    string,
    PendingUpdate[]
  >,
  changesByCall: Map<string, FileChangeEvent[]>,
  resolvedPermissions: ReadonlySet<string>,
  resolvedElicitations: ReadonlySet<string>,
  askedThrough: ReadonlySet<string>,
): TailNode | null {
  const event = stored.event;

  if (event.type === "tool_call") {
    if (askedThrough.has(event.toolCallId)) {
      updates.delete(event.toolCallId);
      changesByCall.delete(event.toolCallId);
      return null;
    }
    const list = updates.get(event.toolCallId);
    // Claimed, not read: a reused agent-chosen id must not merge one list into two cards.
    updates.delete(event.toolCallId);
    const claimedChanges = changesByCall.get(event.toolCallId);
    changesByCall.delete(event.toolCallId);
    const merged = list === undefined ? null : mergeUpdates(list);
    const parentId = event.parentToolCallId ?? merged?.parentToolCallId ?? null;
    return {
      kind: "tool",
      key: `e${stored.seq}`,
      seq: stored.seq,
      toolCallId: event.toolCallId,
      parentId: parentId === event.toolCallId ? null : parentId,
      ...resolveTool(event, merged),
      subagent: event.subagent === true,
      backgrounded: merged?.backgrounded === true,
      changes: claimedChanges ?? [],
      children: [],
      steps: 0,
      omitted: 0,
      latest: null,
      elapsedMs:
        merged !== null &&
        merged.statusTs !== null &&
        (merged.status === "completed" || merged.status === "failed")
          ? merged.statusTs - stored.ts
          : null,
    };
  }

  if (event.type === "tool_call_update") {
    if (event.status !== "failed") return null;
    return {
      kind: "update",
      key: `u${event.toolCallId}:${stored.seq}`,
      seq: stored.seq,
      toolCallId: event.toolCallId,
      parentId: event.parentToolCallId ?? null,
      title: event.title,
    };
  }

  if (event.type === "file_change") {
    return {
      kind: "change",
      key: `c${stored.seq}`,
      seq: stored.seq,
      parentId: null,
      toolCallId: event.toolCallId,
      event,
    };
  }

  if (!showsInTranscript(event)) return null;

  // Keyed on `resolvedPermissions`, not `decision` (null for a parked request); an unanswered request keeps its row.
  if (
    event.type === "permission_request" &&
    event.permissionId !== null &&
    resolvedPermissions.has(event.permissionId)
  ) {
    return null;
  }

  if (event.type === "elicitation_request" && resolvedElicitations.has(event.elicitationId)) {
    return null;
  }

  return {
    kind: "event",
    key: `e${stored.seq}`,
    seq: stored.seq,
    parentId: null,
    stored,
    heading: null,
    asked: null,
  };
}
