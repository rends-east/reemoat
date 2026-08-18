/**
 * The transcript's *shape*, as pure functions.
 *
 * These live here rather than inside `EventList.tsx` for the reason
 * `agentConfig.ts` and `groups.ts` state about their own screens: `webcheck` has
 * no DOM, so anything expressed as JSX is untested by construction. `buildTail`
 * had been exactly that since it was written — and it holds the most
 * consequential rules in the client, the five-events-per-tool-call merge and the
 * ordering of a coalesced run. Neither had an assertion under it.
 *
 * Nothing in this file imports React. `EventList.tsx` switches over `TailNode`
 * and draws; every decision about *what* a row is happens here.
 */

import { formatLocation, hasInput, readInput } from "../permission";
import type { Gap } from "../store";
import type {
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

/**
 * The longest summary a collapsed row will carry. Beyond this it is a wall, not a
 * hint.
 *
 * **This is a safety bound and not a display one, and the difference is worth
 * knowing before anybody tunes it.** CSS clips the same string a second time and
 * far harder: the summary is the `flex-1 truncate` element on `GroupRow`'s button,
 * so on a 390px phone it gets whatever the trailing counts and badges leave — about
 * 20 characters with the row fully loaded, against the 120 here. The two clips do
 * not know about each other and only one of them is visible to the code.
 *
 * So raising this number changes nothing a phone can see, and lowering it toward
 * what a phone *can* see would clip a desktop row that has the width for more.
 * What this bound is actually for is the case CSS handles badly rather than
 * invisibly — an unbounded string reaching a `truncate` that has to lay it out
 * first. Leave it well above the visible budget; that is the point of it.
 */
export const SUMMARY_CHARS = 120;

/**
 * The longest title a collapsed row will carry, and it is a **code** clip rather than
 * a CSS one on purpose.
 *
 * `truncate` fits the title to the row and throws away the question this file cares
 * about — *was anything cut off* — which is the same reason `SUMMARY_CHARS` lives here
 * and not in a stylesheet. Without an answer to it, a card whose title is the whole of
 * what it has to say cannot be opened: measured, codex's web search arrives titled
 * `Web search: <every query it ran>`, ~100 characters of it, while `rawInput.query` is
 * codex's own truncated copy of the *first* query — so `opensToAnything` correctly
 * refused, and the full list of queries was reachable nowhere.
 *
 * **And a flat threshold was wrong, which the log said and a guess did not.** Every
 * drawn title in the database: median **41**, max **161**, and the tail is 82, 82, 87,
 * 148, 161. Clipping at 60 or 80 therefore cut three titles by 2 to 7 characters — a
 * whole extra line spent to reveal a word — while the two that are genuinely a payload
 * hide 68 and 81. So clipping has to be worth the line it costs: the cut happens only
 * when what it hides exceeds `TITLE_OVERFLOW_MIN`, which on this database is exactly
 * the two long ones and none of the near misses.
 */
export const TITLE_CHARS = 80;

/** The least a clip may hide before it is worth a line of its own to reveal. */
export const TITLE_OVERFLOW_MIN = 20;

/** A row's title, cut only where cutting pays for itself, and whether it was cut. */
export function clipTitle(title: string): { text: string; clipped: boolean } {
  if (title.length <= TITLE_CHARS + TITLE_OVERFLOW_MIN) return { text: title, clipped: false };
  return { text: `${title.slice(0, TITLE_CHARS)}…`, clipped: true };
}

/**
 * The most of a headline that has to reappear in the title before it is a copy.
 *
 * Long enough that two unrelated strings do not collide, short enough to still match
 * when the agent sent a *truncated* copy — which is the case that forced it.
 */
const HEADLINE_ECHO_CHARS = 24;

/**
 * Whether the value beside the title says anything the title has not.
 *
 * The rule was exact equality, on the measured ground that codex names a `Bash` call
 * after the command it runs, so the row drew the same 82 characters twice. That is the
 * *identical* case, and the log has two more where the second copy is worth nothing and
 * the strings are not equal:
 *
 *   `Read file '/Users/…/SKILL.md'` beside `/Users/…/SKILL.md` — the title quotes the
 *     path and the headline *is* the path, so the row spent its width on two truncated
 *     copies of one path.
 *   `Web search: <query>, <query>, <query>` beside `<first query> ...` — codex's
 *     `rawInput.query` is its own truncated copy of the first query, **with a literal
 *     ` ...` appended**, which is why a containment test on the whole string fails and
 *     why this compares a prefix instead.
 *
 * So: a headline whose opening `HEADLINE_ECHO_CHARS` already appear in the title is an
 * echo of it. Measured against every drawn pair in the database, that suppresses those
 * three and keeps every genuine one — `Bash` beside `npm test`, `Edit` beside a path —
 * because an unrelated headline's first 24 characters are not in its title.
 */
export function headlineWorthDrawing(title: string, headline: string | null): boolean {
  if (headline === null || headline.length === 0 || headline === title) return false;
  const echo = headline.slice(0, HEADLINE_ECHO_CHARS);
  return !title.includes(echo);
}

/**
 * The most steps kept under one subagent.
 *
 * The ones kept are the *newest*, which is the right end: a card you open while
 * a delegate is working is being opened to see where it has got to. That takes
 * an eviction rather than a refusal — `placeNodes` runs **forwards**, so the
 * first children it meets are the oldest, and the obvious `if (full) skip` keeps
 * exactly the wrong forty. It did, and `latest` froze at step 40 for the rest of
 * every long subagent because it reads whatever survived here.
 *
 * What this does *not* do is protect the render budget, which an earlier comment
 * claimed: the cap runs in phase two, after `buildTail` has already spent a node
 * on every child it collected. Measured — 500 steps against a 400 render limit
 * still yields 400 flat rows with the naming card outside the window. Bounding
 * that needs the cap applied during collection, which needs the parent known
 * before its children, which the backwards walk is precisely what prevents.
 */
export const MAX_CHILDREN = 40;

/**
 * How deep the indent may go.
 *
 * Measured 2026-08-01 against claude 2.1.220: a subagent *can* spawn a further
 * subagent, but attribution is one level deep — every tool call comes back
 * parented to the outermost spawn, so no third level is reachable today. This is
 * therefore defensive, and it is four lines rather than a discovery that unbounded
 * indent is unreadable on a 390px screen.
 *
 * **It is not the cycle bound, and reading it as one was a hang.** This says when
 * a walk may stop *climbing*; it says nothing about how many hops a walk may
 * take, and both walks in `placeNodes` follow raw `parentId` rather than the
 * clamped chain. Two mutually-parented calls — which an agent can emit, since
 * the daemon normalizes only self-reference — made both loops run forever, inside
 * a `useMemo`, i.e. an unrecoverable tab. Every traversal here carries a visited
 * set for that reason; see `placeNodes`.
 */
export const MAX_DEPTH = 2;

const TRUNCATED_ARGS = "(arguments too large to keep in the log)";

/** One coalesced run of agent or user text, keyed and ordered by its first event. */
export interface TextNode {
  kind: "text";
  key: string;
  seq: number;
  role: string;
  thought: boolean;
  text: string;
  parentId: string | null;
}

/** A tool call with every field its updates resolved, and its steps placed. */
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
  /** Pictures the tool returned, drawn inside the card. */
  images: readonly StoredFileRef[];
  /**
   * The agent said this call was a subagent spawn.
   *
   * Carried so a spawn *looks* like a spawn from its first event, and only for
   * that: `children` is still what nesting, the step count and the running
   * headline are built from, so an agent that says nothing degrades exactly as it
   * did. See `EventList`'s `ToolCall` for why the icon takes both.
   *
   * Read from the `tool_call` and never merged from an update. Measured
   * 2026-08-01, claude drops the flag on the spawn's own *completing* update, so
   * a value folded last-wins would go false at the end of every subagent — and
   * `session.ts` deliberately copies only the parent edge onto an update for the
   * same reason, so there is nothing on that side to merge.
   */
  subagent: boolean;
  /**
   * The files this call changed, claimed from the log by `toolCallId`.
   *
   * Claimed the same way `updates` are and for the same reason: a `file_change`
   * names the call it belongs to, so a card can draw the edit it made instead of a
   * separate path-and-download row sitting underneath it saying the same thing less
   * well. One call can carry several — a `MultiEdit` is one call and several
   * changes.
   */
  changes: readonly FileChangeEvent[];
  /** Placed in document order. Empty for every call that started nothing. */
  children: TailNode[];
  /** Tool descendants at every depth, including ones dropped for the cap. */
  steps: number;
  /**
   * How many of those the cap evicted from `children`. `0` draws no marker.
   *
   * Counted on the *evicted* node's kind, not the arriving one's, and only for a
   * tool — otherwise a failed orphan update parented here bumped this without
   * ever having bumped `steps`, and the card said "40 steps" beside "1 step not
   * shown". Measured: `children 40, steps 40, omitted 1`.
   */
  omitted: number;
  /** The newest descendant's one-line summary, for a running header. */
  latest: string | null;
  /** Call to the update that ended it, or `null` while it is still running. */
  elapsedMs: number | null;
}

/** A `tool_call_update` whose own `tool_call` is outside the window. Failed ones only. */
export interface UpdateNode {
  kind: "update";
  key: string;
  seq: number;
  toolCallId: string;
  parentId: string | null;
  title: string | null;
}

/**
 * A file the agent changed, whose own tool call is outside the window.
 *
 * Its own node kind rather than a generic `EventNode` for the reason `UpdateNode`
 * is one: the fold has to be decided in `placeNodes`, which needs the
 * `toolCallId` on the node. A change whose call *is* in the window is drawn by
 * that call's card and this node is dropped.
 *
 * `toolCallId` is `null` for the whole `fs_write` channel — kimi's
 * `fs/write_text_file` — which is also the copy that arrives *twice* for one edit.
 * See `placeNodes`.
 */
export interface ChangeNode {
  kind: "change";
  key: string;
  seq: number;
  parentId: string | null;
  toolCallId: string | null;
  event: FileChangeEvent;
}

/**
 * A run of consecutive tool calls, as one row.
 *
 * The transcript's job is answering *does anything anywhere need me*, and a turn's
 * worth of machinery is not that. So a run of calls between two things somebody
 * wrote collapses to one line that says what the run did, and opens to the same
 * rows it replaced.
 *
 * **A run of one is never wrapped.** Measured across every session on the
 * development machine, 9 of 16 runs hold a single call, and a wrapper there would
 * add a disclosure whose body is one row — the same "worse than no disclosure"
 * that `opensToAnything` exists for one level down. It is also what keeps a lone
 * `tool_call` splitting a text run into `before`/`[tool]`/`after`, unchanged.
 */
export interface GroupNode {
  kind: "group";
  key: string;
  seq: number;
  parentId: null;
  /** The rows this stands for, in document order. */
  children: TailNode[];
  tally: RunTally;
  /** Calls in the run that failed. Counted on the collapsed row, never opened. */
  failed: number;
  /**
   * Approvals folded into this run.
   *
   * A resolved permission is not a tool call, so it earns no clause in the sentence —
   * it is a **count on the collapsed row**, which is how "an approval cannot be
   * hidden" is kept while the row it used to occupy goes away. Same idiom as
   * `failed`, a folder's waiting count and a card's step badge: the number survives
   * the collapse. A refusal is never in here; it stays a row of its own.
   */
  approved: number;
  /** Something in the run has not finished, so the run is what is happening now. */
  live: boolean;
}

/*
 * A group is keyed on its **first child's** seq, so a run that gains an *earlier*
 * member gets a new key and React remounts it — losing whatever was expanded inside.
 * Reachable only through `loadAll`, which pages history backwards: streaming appends
 * at the end, so the first seq is stable for every run being built live. Left as it
 * is because the alternative is a key that does not identify the run.
 */

/** Everything drawn one-for-one from a single event, with no cross-event rule. */
export interface EventNode {
  kind: "event";
  key: string;
  seq: number;
  parentId: string | null;
  stored: StoredEvent;
  /**
   * A better heading than the event carries, and set for **permissions only**.
   *
   * Measured 2026-08-13 in the log: codex sends a permission with no title, and the
   * daemon's `title = toolCall.title ?? toolCall.toolCallId` therefore falls through
   * to the call's id — so an approval drew as the bare line
   * `✓ exec-55382d16-8647-4b5e-a87c-32c95b8ed2e8`, which is the transcript's record
   * of a decision somebody made, saying nothing about what was decided.
   * `permissionHeadline` already rescues the *card*; the row was never rescued.
   *
   * The fix is a join the walk can do for free — the tool call names itself, and its
   * own title is what a person recognises. `null` whenever the daemon's title is
   * worth keeping, which is every claude and kimi permission.
   *
   * This is the one field on this node that is not "the event as it arrived", and it
   * is here rather than as a node kind of its own because a permission row is still
   * one event drawn one-for-one; what it needed was a name.
   */
  heading: string | null;
}

export interface GapNode {
  kind: "gap";
  key: string;
  seq: number;
  parentId: null;
  gap: Gap;
}

export type TailNode = TextNode | ToolNode | UpdateNode | ChangeNode | GroupNode | EventNode | GapNode;

/**
 * Whether two nodes for the same row would draw the same thing.
 *
 * `buildTail` constructs fresh node objects on every call, and it is called on
 * every streamed token — so `React.memo`'s own shallow compare, which asks whether
 * the `node` prop is the same object, answers "no" for every row every time and
 * memoising achieves exactly nothing. This is the comparator that makes it work,
 * and it is the whole reason drawing an unbounded transcript is affordable: an
 * appended event should re-render the row it appended and the run it extended, not
 * the fifteen hundred above them.
 *
 * A comparator rather than a signature *string*: a sig would allocate one string
 * per node per rebuild, which is the cost being avoided, and it would have to
 * encode every field anyway.
 *
 * The array members compare with `===` on purpose. `locations`, `output`,
 * `images` and `rawInput` are all references *into* the stored events — the
 * arrays around them are rebuilt, the things inside them are not, because a
 * `StoredEvent` is never mutated. `text` is the one genuine string comparison,
 * and it is a rebuilt string: worth it, since the alternative (comparing lengths)
 * would silently miss a run whose content changed without changing size.
 *
 * Exported so `webcheck` can assert it — a comparator that wrongly answers `true`
 * shows a stale row and nothing anywhere would say so.
 */
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
      // `StoredEvent`s are never mutated, so the event that produced this settles
      // it — and the diff drawn from it is memoised on that same identity.
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
      // `StoredEvent` objects are never mutated, so identity settles the event
      // itself. `heading` is derived and can arrive later — a codex permission is
      // named by a `tool_call_update` that follows it — so it is compared too.
      const other = b as EventNode;
      return a.stored === other.stored && a.heading === other.heading;
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
  /**
   * Events below the cut, which is what the one remaining control offers to
   * reveal. Zero whenever there is no cut, which is most sessions.
   */
  hidden: number;
  /**
   * The seq at or below which a `pending` tool call is **stranded rather than
   * running**, and nothing will ever complete it. `0` for most sessions.
   *
   * ⚠ **This is the correction to `mayStillReport`, and it has to live here
   * rather than on the snapshot.** That predicate excludes the terminal statuses
   * on the stated ground that "the interrupted turn is deliberately not re-sent,
   * so every call it left `pending` stays that way" — which is true, and closes
   * only the arm that already resolves itself. Auto-resume takes the session
   * *out* of terminal: it comes back `idle`, holding the same conversation, and
   * the stranded rows come with it. So the foot drew `waiting for 1 task` with a
   * pulsing dot for the rest of that session's life, on every session that was
   * mid-delegation when `deploy.sh` ran, surviving reloads because it is derived
   * from a log that persists. No fact about `status` can see it — by the time
   * anybody reads one, the status is the honest `idle`.
   *
   * Two markers raise it, and the walk is backwards so the **first** of either is
   * the newest:
   *
   *   `session_started` — a different agent process is now in front of this
   *     conversation. Whatever the last one was running died with it. This is the
   *     restart, the auto-resume, the manual `client resume`, and the agent
   *     restart `applyUltracode` causes.
   *   `turn_end` with any `stopReason` but `end_turn` — the turn was abandoned
   *     rather than finished, so its calls were abandoned too. `end_turn` is
   *     deliberately **not** a marker: a turn ending normally while the work it
   *     delegated carries on is the entire state this feature exists to draw.
   *
   * Keyed on the stop reason rather than on a list of the bad ones, so a reason
   * this client has never heard of is treated as an abandoned turn — the safe
   * direction, since the cost of a wrong cut is a line nobody sees and the cost of
   * a wrong keep is the permanent false one above.
   *
   * ⚠ **It is only as good as the window that is loaded**, which is the one
   * direction this errs wrongly. A cold tab attaches at the tail and pages
   * backwards, so for as long as the marker is below the loaded window there is no
   * floor and a stranded delegation is counted — the same false line, for the
   * seconds it takes `loadAll` to reach it rather than for ever. Self-correcting
   * because that loop does not stop until the start of the log, and deliberately
   * not papered over here: a floor guessed from an incomplete window would cut a
   * live delegation, which is the direction with no correction at all. Below a
   * `/clear` cut the question does not arise — the walk stops there and those rows
   * are not drawn.
   */
  taskFloor: number;
}

/** Everything a tool call's updates said, resolved field by field. */
/**
 * One `tool_call_update`, as the tail collects it before merging.
 *
 * Named rather than written inline in three places, which is how it came to be
 * missing a field in one of them: the shape was duplicated at each use and a new
 * member had to be added three times to be added at all.
 */
export interface PendingUpdate {
  ts: number;
  status: ToolCallStatus | null;
  title: string | null;
  rawInput: unknown;
  locations: readonly FileLocation[];
  content: readonly string[] | null;
  images?: readonly StoredFileRef[] | null;
  parentToolCallId?: string | null;
}

export interface MergedUpdate {
  status: ToolCallStatus | null;
  title: string | null;
  rawInput: unknown;
  locations: readonly FileLocation[];
  content: string[];
  /** Every image the tool returned, in arrival order, across all its updates. */
  images: StoredFileRef[];
  /**
   * The lineage the updates agreed on.
   *
   * Measured 2026-08-01 against claude-agent-acp 0.63.0: **4 of 10 and 5 of 14**
   * of a child's updates omit `parentToolUseId` even though its `tool_call`
   * carried one — those are the `toolResponse`-bearing updates, whose `_meta` is
   * rebuilt from the tool *result* and does not re-derive lineage. `subagent` is
   * lost the same way on a spawn's completing update.
   *
   * So this is first-non-null and a later `null` never resets it. Reading an
   * absent link as "top level" would scatter half of every subagent's steps back
   * into the transcript, intermittently.
   */
  parentToolCallId: string | null;
  /**
   * `ts` of the update that carried the newest *status*, which is where elapsed
   * comes from.
   *
   * Deliberately not the newest update's `ts`. The five-events table below has
   * two updates whose every field is null, and claude keeps sending them after a
   * terminal status — so timing from the last update read the clock of an event
   * that said nothing, and the reported duration grew with traffic rather than
   * with the call. Worse, it was bounded by the *window*: "show more" changed a
   * finished call's duration. The status test and the timestamp test have to
   * read the same event.
   */
  statusTs: number | null;
}

/**
 * Whether this block says everything the one before it said, and more.
 *
 * **The model streams a tool's arguments as content, one token at a time, and
 * every block is a strict extension of the last.** Measured against the daemon's
 * own database on 2026-08-13: one `Write` call produced a `tool_call`, then **715
 * `tool_call_update`s** whose only content block grew from `{` to the complete
 * input JSON, then the real output — the single line `Wrote 2347 bytes to
 * tictactoe.py`. Concatenated, that is what the card drew: 716 stacked copies of
 * the same arguments, then one useful sentence at the bottom. Across the whole
 * database those superseded blocks are 15.4% of all events and **55.8% of all
 * bytes**, and the longest run is 715.
 *
 * A **strict** extension, deliberately. An exactly repeated block is left alone:
 * a tool that prints the same line twice has printed it twice, and collapsing
 * that would be this client editing output rather than declining to draw a draft
 * of it. The test reads no field, no id and no vendor name — only whether the
 * previous block is a prefix of this one — so a tool whose blocks are
 * *incremental* chunks rather than cumulative ones matches nothing and is
 * untouched.
 */
export function supersedes(block: string, previous: string): boolean {
  return block.length > previous.length && block.startsWith(previous);
}

/**
 * Whether this block is the call's own arguments, restated as output.
 *
 * A streamed call ends by saying its input **twice more**: the last streamed
 * block is the complete arguments pretty-printed (`{"path": "x"`), and the update
 * that finally carries `rawInput` carries the same object again as content,
 * compact (`{"path":"x"`). Neither is a result, and `supersedes` catches neither
 * — the compact one is not an extension of the pretty one. Without this the 716
 * blocks collapse to *three*, of which two are the arguments the card is already
 * drawing above.
 *
 * **Structural, not byte equality, and the difference was measured rather than
 * assumed.** Byte equality against `JSON.stringify` catches only the compact one:
 * 26 blocks. Comparing the *parsed* block against the call's final `rawInput`
 * catches 26 more — the pretty-printed ones — and leaves 63 blocks that are not
 * JSON at all, which are the real outputs. An intermediate version of this
 * comment claimed parsing "matched nothing further", which was true only of pairs
 * sharing one event: the pretty-printed copy arrives *before* the `rawInput` it
 * restates, so it can only be judged once the whole call has been folded. That is
 * why this runs as a pass over the finished list rather than inside the loop.
 *
 * The first-character guard is what keeps `JSON.parse` off every tool result a
 * session ever produced: `buildTail` re-folds every call on every streamed event,
 * and a block that does not begin the way the serialization begins cannot be a
 * formatting variant of it.
 */
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
    // Not JSON, so not a restatement of anything. This is the ordinary path for
    // real output and is why the guard above exists.
    return false;
  }
}

/**
 * Fold a tool call's updates, oldest first, into one record.
 *
 * Measured 2026-07-31 against claude 0.63.0, one `echo` produces a `tool_call`
 * plus *four* updates, and what a person wants to read is scattered across all
 * five:
 *
 *   tool_call        title "Terminal"   rawInput {}          content null
 *   update           title "echo hi"    rawInput {command}   content null
 *   update           title "echo hi"    rawInput {command…}  content ["Echo hi-there"]
 *   update           title null         rawInput null        content null
 *   update completed title null         rawInput null        content ["```console\nhi-there```"]
 *
 * Keeping only the last loses the command *and* the description; keeping only the
 * first loses the output. The call's own `rawInput` is `{}` — genuinely empty, so
 * it cannot be preferred either.
 *
 * **Document order in, last-non-null wins.** The `??=` this replaces was an
 * artefact of the backwards walk rather than a rule: "first seen is newest" is
 * only true if you already know the caller is reversed, which is one more thing
 * to be wrong about.
 *
 * **`content` is accumulated, but not blindly** — see {@link supersedes} and
 * {@link restatesInput}. "Every content block concatenated" was the rule, and
 * measured against the live database it drew a single `Write` as **716 stacked
 * copies of its own arguments**, growing one token at a time.
 */
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
    statusTs: null,
  };
  for (const update of updates) {
    // Together, so that "when did it stop" cannot drift from "did it stop".
    if (update.status !== null) {
      merged.status = update.status;
      merged.statusTs = update.ts;
    }
    if (update.title !== null) merged.title = update.title;
    if (update.locations.length > 0) merged.locations = update.locations;
    // Not a null check: the arguments arrive as `{}` before they arrive filled
    // in, and an empty object is not null. `hasInput` is the same emptiness rule
    // the rendering uses, so "worth showing" means one thing in both places.
    if (hasInput(update.rawInput)) merged.rawInput = update.rawInput;
    if (update.content !== null && update.content !== undefined) {
      for (const block of update.content) {
        // A draft of the block that follows it, so the one that follows is the
        // one to keep. Against the last block *kept*, not the last one seen, so a
        // run of any length collapses to its final form.
        const last = merged.content.at(-1);
        if (last !== undefined && supersedes(block, last)) merged.content[merged.content.length - 1] = block;
        else merged.content.push(block);
      }
    }
    // Accumulated like `content` rather than replaced like `title`: a tool that
    // returns several pictures does so across several updates, and keeping only
    // the last would show one of them. `?? []` because an older daemon dropped
    // the bytes and sent no such field.
    merged.images.push(...(update.images ?? []));
    // First non-null only — see `MergedUpdate.parentToolCallId`.
    merged.parentToolCallId ??= update.parentToolCallId ?? null;
  }
  /*
   * Last, because the arguments this drops against arrive **after** the copies of
   * them — see `restatesInput`. Inside the loop it could only ever catch the one
   * that shares an event with its own `rawInput`, and would leave the
   * pretty-printed copy that precedes it standing.
   */
  merged.content = merged.content.filter((block) => !restatesInput(block, merged.rawInput));
  return merged;
}

/**
 * What a card draws, from the call and everything its updates said.
 *
 * This is the rule that used to live inside `renderEvent`'s JSX, which is to say
 * the rule nothing could assert.
 */
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
    // The update's title is the better one: claude's call says "Terminal" and its
    // update says "echo hi-there". Measured again 2026-08-01 on a subagent spawn,
    // where the call's title is the literal string "Task" and the model's own
    // description arrives only on the next event.
    title: merged?.title ?? call.title,
    toolKind: call.kind,
    status: merged?.status ?? call.status,
    /*
     * **Newest non-empty wins, and the call is simply the oldest of them.**
     *
     * `hasInput` and not `??`, for the reason this has always given: the call's
     * own arguments are `{}` for every claude tool call, and an empty object is
     * not null, so a null check picks the empty one and the command never appears.
     *
     * What that rule got wrong is the *order*. It preferred the call whenever the
     * call had anything at all, which is only ever right when an agent fills its
     * arguments in once and never refines them. codex's web search does refine
     * them: the `tool_call` arrives with
     * `{type, id, query: "", action: null}` — four keys, so `hasInput` is true and
     * the call won — and the update that follows carries the same object with the
     * query actually in it. The card therefore drew `"query": ""` under a title
     * reading `Web search: red mullet…` — the agent's own title, translated from
     * the original — because `title` is newest-wins one line up and this was not.
     * Nothing else on this record prefers the older answer.
     */
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

/**
 * What a collapsed row says beyond its title, and what expanding it shows.
 *
 * Built on `permission.ts`'s `readInput` rather than a second guess at the same
 * undocumented shape.
 */
export function toolSummary(
  rawInput: unknown,
  locations: readonly FileLocation[],
  /**
   * `files.relFor` — a path made relative to the session's workspace, or `null` for
   * anything outside it. Optional, and the default answers `null` for everything, so
   * a caller with no `FileAccess` gets exactly what this returned before.
   *
   * **It reaches the path arms and never the command**, which is the whole of the
   * rule below.
   */
  rel: (path: string) => string | null = () => null,
): { summary: string | null; detail: string | null } {
  const input = readInput(rawInput);
  const detail = input.command ?? input.pretty ?? (input.truncated ? TRUNCATED_ARGS : null);
  const first = locations[0];
  /*
   * **A path is shortened and a command is not, and that asymmetry is the point.**
   *
   * Every session works inside one directory, so the row drew that directory again
   * on every line and then ran out of width: reported off a phone, a `Read` row read
   * `/Users/rends/remoslop_agent…` and nothing else — the prefix is shared by every
   * row on the screen and the part that identifies the file is at the end, which is
   * the end `truncate` throws away.
   *
   * `input.command` is untouched, and that is a refusal rather than an omission.
   * `COMMAND_FIELDS` is `command`, `cmd`, `script`, `query`, `pattern` — the string
   * the agent actually ran. Rewriting `ls -la /Users/me/proj/src` to `ls -la src`
   * would show a command that was never executed, which is the same judgement
   * `PermissionCard` makes when it draws a command through a raw `<pre>` rather than
   * through Markdown. Shortening what a file is *called* is a display decision;
   * editing what ran is a lie.
   *
   * `TARGET_FIELDS` holds `url` and `uri` beside the path names, and they need no
   * special case: `relativeTo` answers `null` for anything that does not sit under
   * the workspace root, so a URL falls through the `??` unchanged.
   */
  const target = input.target === null ? null : (rel(input.target) ?? input.target);
  const located =
    first === undefined ? null : formatLocation({ path: rel(first.path) ?? first.path, line: first.line });
  return {
    summary: input.command ?? target ?? located,
    detail,
  };
}

/**
 * Whether opening this card shows anything the row is not already showing.
 *
 * **A disclosure that reveals the string above it is worse than no disclosure.**
 * Measured 2026-08-13 against the daemon's log — codex's web search arrives with
 * `rawInput.query`, `query` is in `COMMAND_FIELDS`, so `toolSummary` answers the
 * *same string* as both `summary` and `detail`. It carries no content block at all
 * (codex's Bash gotcha again), no locations and no children, so `detail !== null`
 * was the only thing making it openable — and what it opened to was 66 characters
 * the row had already drawn in full. Worse than nothing, in fact: the agent's own
 * `title` lists all three of its queries, while `rawInput.query` is codex's
 * truncated version of the first, so the body was strictly less than the heading.
 *
 * The rule is not about web search and names nothing: whenever a tool's arguments
 * yield a command, `summary` and `detail` are that same command by construction,
 * so this is every such call. What keeps the *useful* case is the clip — the row
 * cuts at `SUMMARY_CHARS`, in this file rather than in CSS, so it is knowable
 * whether anything was cut off. A 4000-character `Bash` command is still openable
 * while it runs and has produced nothing; a 66-character one is not.
 *
 * Here rather than in the JSX because that is where it was, and a rule inside a
 * `const` in a component is one `webcheck` cannot reach.
 */
export function opensToAnything(card: {
  /** What the body would draw. */
  detail: string | null;
  /** What the row already draws beside the title, before clipping. */
  headline: string | null;
  outputBlocks: number;
  locations: number;
  children: number;
  /**
   * Files the call changed, each of which draws a diff inside.
   *
   * The term that had to be added rather than inferred: a `Write` reaches here with
   * `detail === null`, because `readInput` suppresses the pretty-printed arguments
   * as soon as it finds a body field — so a card whose whole content is the file it
   * wrote answered `false` on everything and had nowhere to put a diff.
   */
  changes: number;
  /**
   * The row had to cut its own title, so the body has the rest of it.
   *
   * The term that brings web search back. Its title is the list of queries it ran and
   * `rawInput.query` is a truncated copy of the first, so every other term here is
   * zero and the card correctly refused to open — onto a body that would have said
   * *less* than the row. What it opens to now is the title itself, whole.
   */
  titleClipped: boolean;
}): boolean {
  if (card.outputBlocks > 0 || card.locations > 0 || card.children > 0 || card.changes > 0) return true;
  if (card.titleClipped) return true;
  return detailWorthDrawing(card.detail, card.headline);
}

/**
 * Whether the arguments say anything the row has not already said.
 *
 * Extracted because it has two callers and they must agree: `opensToAnything` asks it
 * to decide whether a chevron exists at all, and the body asks it to decide whether
 * to draw the block. They were one expression and a separate `detail !== null`, so a
 * card openable for its **output** still drew the arguments underneath a row already
 * showing them — the same command twice, one line apart, which is the thing this
 * rule exists to prevent and which the frames used to hide.
 *
 * "Not the same text — or the same text, cut short on the row."
 */
export function detailWorthDrawing(detail: string | null, headline: string | null): boolean {
  if (detail === null) return false;
  return detail !== headline || detail.length > SUMMARY_CHARS;
}

/**
 * Unwrap the markdown fence an agent puts around a tool's output.
 *
 * Measured against claude: the console output of a Bash tool arrives as the single
 * string ```` ```console\nhi-there\n``` ````. It is rendered in a `<pre>`, not
 * through the markdown renderer — deliberately, since tool output is untrusted
 * text from a repository — so the fence would otherwise be shown as three literal
 * backticks and a language name.
 *
 * Only a fence wrapping the *whole* block is removed. A fence in the middle is
 * part of what the tool actually printed and stays.
 */
export function stripFence(block: string): string {
  const lines = block.split("\n");
  if (lines.length < 2) return block;
  const first = lines[0]?.trimEnd() ?? "";
  if (!first.startsWith("```")) return block;
  const closing = lines.at(-1)?.trim() === "```" ? lines.length - 1 : -1;
  if (closing < 1) return block;
  return lines.slice(1, closing).join("\n");
}

/**
 * Place collected nodes into a tree, forwards.
 *
 * The input is in **document order**. A parent's `tool_call` always precedes its
 * children there, so the lookup below is populated by the time it is needed —
 * asserted rather than defended with a sort.
 *
 * A node whose `parentId` names a call that is *not* in this window falls through
 * to the top level at its own seq, which is exactly the flat rendering that
 * shipped before nesting existed. That is the scrolled-past case, and widening
 * the window with "show more" re-collects it on the next render.
 *
 * **Every walk over `parentId` here carries a visited set, and that is not
 * defensive.** `parentToolCallId` arrives verbatim from an agent's `_meta`, the
 * agent runs in a tenant's container, and the daemon normalizes only
 * self-reference — so a two-element cycle is something an agent may simply send.
 * Both loops below followed the raw chain unbounded and both ran forever on one:
 * measured, two `tool_call` events were enough, and this runs inside `EventList`'s
 * `useMemo`, so the tab never comes back. Reloading does not help either, because
 * the events are on disk and replay on every attach. `MAX_DEPTH` is not the
 * bound — see its own note.
 *
 * A repeated `toolCallId` is refused for the same family of reasons: `byId.set`
 * rebinding an id mid-pass is what let two entries point at each other while both
 * sat at the clamp's exit depth, and it silently re-points every later child at a
 * different call than the one their parent id was resolved against. It renders
 * flat instead. (The *other* half of a reused id — two calls merging one update
 * list — is settled in `nodeFor`, which claims and deletes.)
 */
export function placeNodes(collected: readonly TailNode[]): TailNode[] {
  const rows: TailNode[] = [];
  const byId = new Map<string, ToolNode>();
  const depthOf = new Map<string, number>();
  /**
   * Edits already spoken for, by path, one credit each. See the `change` arm below.
   */
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
    // The `foldedInto` rule, now a membership test instead of a reverse splice
    // over key strings. Going forwards, a call always precedes its own updates,
    // so by here we know whether it is in the window: if it is, the card draws
    // this update's contents and a standalone row would be the same failure
    // twice. If it is not, this is the orphan the old code deliberately kept.
    if (node.kind === "update" && byId.has(node.toolCallId)) continue;

    /*
     * A change whose call is in the window is drawn *inside* that call's card, so a
     * standalone row here would be the same edit twice — which is exactly what the
     * transcript did before cards could draw one at all.
     *
     * **And the duplicate that has no call to fold into.** Measured against kimi
     * (Q6.12): one edit produces two `file_change` events, `source: "diff"` carrying
     * the tool call's id and then `source: "fs_write"` with `toolCallId: null`. The
     * first is absorbed above and the second would stand alone underneath it.
     *
     * **Matched on the path and nothing else, and comparing the text was a bug
     * rather than a stricter rule.** The two halves do not carry the same text: the
     * `diff` copy is the *fragment* the model typed (`oldText: "two"` → `newText:
     * "TWO CHANGED"`, Q7.29), while `onWriteTextFile` reads the file and sends the
     * **whole** of it either side. So a content signature could never match, and
     * with a diff now drawn from each the result was worse than the two bare paths
     * this replaced: one edit reported twice, with two different `+N −M`.
     *
     * One **credit** per absorbed edit rather than a set, so the suppression is
     * 1:1 rather than "this path is dealt with for ever". A second, unrelated write
     * to a path edited earlier has no credit left and keeps its row — which matters
     * because that row would otherwise be the only trace of it.
     *
     * Still one-directional: an `fs_write` change is dropped when a `diff` change
     * spoke for the same file, never the reverse. What is lost is the better data —
     * the whole-file copy would diff more legibly than the fragment — and it is lost
     * deliberately, because the card is where an edit belongs and the fragment is
     * what the card's own call produced.
     */
    if (node.kind === "change") {
      if (node.toolCallId !== null && byId.has(node.toolCallId)) continue;
      if (node.event.source === "fs_write" && spend(node.event.path)) continue;
      // An orphan `diff` change speaks for its edit too, so its twin is still
      // suppressed when the call that made it fell outside the window.
      if (node.event.source === "diff") credit(node.event.path);
    }

    let parent = node.parentId === null ? undefined : byId.get(node.parentId);

    // Clamp the indent by walking up to the deepest permitted ancestor. A node
    // placed here would sit at its parent's depth plus one, so a parent already
    // at `MAX_DEPTH - 1` is refused and the search continues upwards — which
    // makes a grandchild a *sibling* of its own parent rather than a third
    // indent. Today's claude cannot reach this; see `MAX_DEPTH`.
    //
    // `climbed` is what makes it terminate: the exit condition is about depth,
    // and a cycle whose members all sit at the exit depth never satisfies it.
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
      // Whatever this card draws is spoken for — credited before the repeated-id
      // branch below, because that branch draws the card too.
      for (const change of node.changes) credit(change.path);
      // A repeated id is refused rather than rebound. Rebinding is what let the
      // clamp above cycle, and it would re-point later children at a call their
      // parent id was never resolved against.
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

    // `steps` counts tool calls at every depth, including what the cap drops —
    // the header says "steps", and a chatty subagent must not report its text
    // runs as though they were work. Deliberately the same quantity claude's own
    // `totalToolUseCount` reports, so the two can be compared rather than
    // silently disagreeing.
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

    // Evict the oldest rather than refuse the newest — see `MAX_CHILDREN`. The
    // shift is over an array already at its cap, so it is forty moves however
    // long the subagent runs.
    if (parent.children.length >= MAX_CHILDREN) {
      const evicted = parent.children.shift();
      if (evicted?.kind === "tool") parent.omitted += 1;
    }
    parent.children.push(node);
  }

  // The newest step, for a header that is still running. Done after placement so
  // it reflects what was actually kept.
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

/**
 * What one clause of a run's summary is about.
 *
 * Derived from ACP's `kind` and, for an edit, from whether the change had an old
 * side — **never from a title, an id or a tool's name**, which is the rule the rest
 * of this client follows for every control it draws. An agent that invents a kind
 * lands in `other` and is counted rather than guessed at.
 */
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
  /**
   * The one thing it happened to, when naming it is better than counting it.
   *
   * `null` as soon as there are two: "edited README.md" is worth more than
   * "edited 1 file", and "edited README.md, bot.py, …" is worth less than "edited
   * 2 files" on a phone.
   */
  name: string | null;
}

export interface RunTally {
  /** In the order each kind first appeared in the run. */
  clauses: readonly RunClause[];
  /**
   * The run's file changes, for the `+N −M` beside the sentence.
   *
   * The events themselves rather than two numbers, deliberately: `changeCounts`
   * memoises per event, so the counts are free wherever they are asked for, and a
   * second copy of them on this record would be a second thing to keep in step.
   */
  changes: readonly FileChangeEvent[];
}

/**
 * What a folded run says.
 *
 * Mechanical, and that is a decision with a measurement behind it: the words a
 * model writes about its own work reach us only as `rawInput.description`, which is
 * on 13 of 1132 updates in the log — practically every claude `Bash` call and not a
 * single edit. Half a transcript in the model's voice and half in ours, differing by
 * agent, is worse than one grammar that is always the same. The model's own words
 * are still on the rows inside, which is where they were written.
 *
 * Returns the sentence and **not** the counts: those are drawn in colour beside it
 * from `tally.changes`, so there is one source for them and it is the same one the
 * card rows use.
 */
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
    /*
     * Each of these has three arms, not two, and the third is the one that keeps
     * getting forgotten: **one of something it could not name**. With `count === 1`
     * and `name === null` a two-armed clause falls to the plural and says "created 1
     * files" — the same defect as the "used 1 tools" the log already caught, and for
     * `search` it is the *ordinary* case rather than an edge one, since a query long
     * enough to be worth running is usually past `CLAUSE_NAME_CHARS`.
     */
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
      // The singular arm is not symmetry. Measured against the log, `used 1 tools`
      // is what a nameless single call produced — `ToolSearch` with a title too long
      // to name — and a sentence that cannot count to one reads as a bug in the
      // product rather than in this line.
      return one ? `used ${name}` : count === 1 ? "used a tool" : `used ${count} tools`;
  }
}

/** The longest thing a clause will name before counting instead. */
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
      // Counted per **file**, not per call: the clause names a file and the number
      // beside it is a number of files, so a `MultiEdit` touching three of them is
      // three rather than one.
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

/**
 * An ACP kind as a clause.
 *
 * `edit` reaches here only for a call that produced **no** `file_change` — an edit
 * that failed, or one whose change fell outside the window — so it is still an
 * edit, just one with nothing to diff. Everything unrecognised is `other`, which is
 * the arm that keeps this from being a `Record<ToolKind, …>` that stops compiling
 * the day an agent invents a kind.
 */
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

/**
 * What to call the one thing a call was about.
 *
 * Through `toolSummary`, so the run's sentence and the row's own headline are built
 * from the same reading of an agent's arguments rather than from two guesses at it.
 * A command is deliberately not named — it is the one value that is routinely
 * thousands of characters, and "ran a command" is what the reference reads too.
 */
function nameOfTool(node: ToolNode): string | null {
  if (node.toolKind === "execute" || node.toolKind === "fetch" || node.toolKind === "switch_mode") {
    return null;
  }
  /*
   * An unrecognised kind is named by its **title**, and every other by its target.
   *
   * Measured against the log: `ToolSearch` is `kind: "other"` with
   * `rawInput.query = "select:AskUserQuestion"`, and reading the summary there put
   * that string into a sentence — "Ran 2 commands, select:AskUserQuestion". An
   * argument is not a name. For a kind nobody here knows, the only thing that reads
   * as one is what the agent called the tool.
   */
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

/**
 * Still going, as far as the newest update said.
 *
 * `pending` counts, and that is the whole of the predicate rather than a widening
 * for safety. Measured against a live log: a Task spawn arrives `pending` and goes
 * straight to `completed` 13–14 seconds later, receiving **no** `in_progress`
 * update in between — only title-only ones. Keyed on `in_progress` alone this
 * answers `false` for the entire life of every delegation there is.
 */
export function stillRunning(node: ToolNode): boolean {
  return node.status === "pending" || node.status === "in_progress";
}

/**
 * A call the transcript draws as a delegation: the agent said so, or it started work.
 *
 * The same boolean `foldable` has always used, given a name because a second reader
 * arrived — `!node.subagent && node.steps === 0` is `!(node.subagent || node.steps >
 * 0)`, so this is a rewrite of the expression and not of the rule. Naming it is what
 * makes the two live marks in this transcript structurally disjoint: a delegation
 * never folds into a `GroupNode`, so the group's pulse and the waiting count can
 * never be about the same row.
 */
export function isDelegation(node: ToolNode): boolean {
  return node.subagent || node.steps > 0;
}

/** One outstanding delegation, as the line at the foot of the transcript draws it. */
export interface OutstandingTask {
  /** The node's own key, so the list and the row it names agree. */
  key: string;
  seq: number;
  title: string;
  /** The newest step it took, or `null` where nothing has been attributed to it. */
  latest: string | null;
  steps: number;
}

/**
 * The delegations that have started and not reported finishing, in document order.
 *
 * **Derived from the transcript and never from the snapshot, which is the point.**
 * `showsWorking` reads `session.turn`, and `turn` is cleared the moment the turn
 * ends — while the delegations somebody is waiting on are events in the log and
 * outlive it. That gap is exactly where a conversation reads as finished.
 *
 * Four rules, each load-bearing:
 *
 *   a node that counts is **not descended into** — nested delegation is measured to
 *     be flat (every call comes back parented to the outermost spawn), so "a task
 *     inside a task" is one thing you are waiting on, and `2 tasks` has to mean two.
 *   a *finished* delegation still is, because a child can arrive after its parent's
 *     completing update.
 *   a visited set on `key`, per this file's own cycle rule: `parentToolCallId`
 *     arrives verbatim from an agent's `_meta`, two mutually-parented calls are
 *     something an agent may simply send, and this runs inside a `useMemo`, so a
 *     loop is a tab that reloading does not fix.
 *   no elapsed time anywhere — `elapsedMs` is `null` while running by design, and a
 *     ticking number would re-render the whole transcript once a second.
 *
 * ⚠ **What it cannot see**, and none of it is fixable from here:
 *
 *   work behind a call that already reported `completed` — the measured production
 *     case, and the most common one. Re-checked against the log that produced the
 *     report: at the moment that conversation went silent for ~295 s and looked
 *     finished, the number of open calls of any kind was **zero**. What it was
 *     waiting on was background shell work behind a call that had said it was done,
 *     and nothing in the ACP stream mentions it.
 *   anything the agent never announced as a tool call. There is no ACP message for
 *     "I am waiting", so silence and completion are one shape on the wire.
 *   the daemon's own backlog, if one ever forms again: a task's *completing* update
 *     would be in it, so this would read stale-**high** — a claim about the last
 *     thing the agent said, never about what is running.
 *   absence is not evidence. `0` is what a loading window, a window the tab's
 *     ceiling truncated, a conversation below a `/clear` cut, and a genuinely
 *     finished turn all answer.
 *
 * `floor` is {@link Tail.taskFloor} and is the fifth rule, kept out of the list
 * above because it is the only one that is not about the shape of the tree. A
 * `pending` call below it belongs to an agent process or a turn that is gone, and
 * nothing will ever complete it — see that field.
 */
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
        /*
         * Stranded, not running. Skipped rather than descended into, because a
         * child of an abandoned spawn is abandoned with it — and because
         * `MAX_DEPTH` re-points a grandchild onto the outermost call, so a child
         * of a stranded parent is below the floor anyway and the walk would only
         * re-decide the same thing one level down.
         */
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
        // Counted, so not descended into: see the nesting rule above.
        continue;
      }
      walk(node.children);
    }
  };
  walk(rows);
  return out;
}

/**
 * Whether this row is something a run may stand for.
 *
 * Everything else **breaks** the run, and the exclusions are the whole safety
 * argument:
 *
 *   a refusal, or an answer nothing can classify — the only record that somebody
 *     said no, and `tail.ts` has already merged the request away, so this row is it.
 *   an unanswered request, and any question — the first is the only trace that the
 *     agent ever asked (a restart took the parked promise with it), and a question
 *     and its answer *are* the conversation rather than machinery about it.
 *   a subagent — its card is already a summary of N steps with its own tree, so
 *     folding it would hide a delegation behind a sentence about it.
 *   an orphaned failed update — already the minimal row for "something broke up
 *     there", and it is the only trace of it.
 *   text, a plan, a prompt, a gap, a turn end, an error, a cleared marker — none of
 *     them is a tool call.
 *
 * **An approval folds, and that reverses the first version of this rule.** It was
 * "no permission ever folds", on the ground that a decision somebody made is not the
 * agent's machinery — true, and it cost more than it bought: measured on a real codex
 * session, one approval in the middle of four calls split them into a group, a row and
 * a lone card, because a run of one is never wrapped. What replaces it is the
 * arrangement `failed` already uses: the approval goes inside, in document order, and
 * the collapsed row **counts** it. Nothing is hidden that was not already counted.
 *
 * Only a *positively known* approval, which is why `decisions` is asked rather than
 * `outcome`: `outcome: "selected"` includes every `reject_*` option, an unmatched
 * `optionId` classifies as neither, and a missing map means a caller that has not
 * done the join. All three fall through to "not foldable", so the failure mode is a
 * visible row rather than a hidden refusal.
 */
function foldable(node: TailNode, decisions: ReadonlyMap<string, PermissionOptionKind>): boolean {
  if (node.kind === "change") return true;
  if (node.kind === "tool") return !isDelegation(node);
  if (node.kind !== "event") return false;
  const event = node.stored.event;
  if (event.type !== "permission_resolved" || event.outcome !== "selected") return false;
  const kind = decisions.get(event.permissionId);
  return kind !== undefined && !refused(kind);
}

/**
 * Fold each run of consecutive tool rows into one.
 *
 * A pass over the finished, sorted rows rather than something woven into the walk:
 * every rule about *what* a row is has already run, so this only has to decide
 * which rows stand together. It also means `buildTail`'s `flush()` boundaries are
 * untouched — the text runs either side of a group were already separated by the
 * `tool_call` that is now inside it.
 *
 * Nothing here is bounded. A folded run holds exactly the nodes that used to be
 * rows, so collapsed it draws one of them and expanded it draws what the transcript
 * drew before — there is no budget to spend.
 */
export function foldRuns(
  rows: readonly TailNode[],
  /**
   * `permissionDecisions(events)`, so an approval can be told from a refusal.
   *
   * Defaulted to empty rather than made required, and the default is the **safe**
   * answer: with no verdicts, no permission folds and every one keeps its row. A
   * driver calling this with one argument therefore gets the old behaviour rather
   * than a hidden refusal.
   */
  decisions: ReadonlyMap<string, PermissionOptionKind> = new Map(),
): TailNode[] {
  const out: TailNode[] = [];
  let run: TailNode[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      // A run of one is the row itself. See `GroupNode`.
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
    /*
     * A run of approvals and nothing else is not a run — it has no clause to build a
     * sentence from, so a group there would draw an empty one. The approvals are
     * emitted as the rows they were, which is also the only honest rendering: there
     * is no work for them to be folded *into*.
     */
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
        // Only an approval reaches a run at all — `foldable` is what decided that.
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

/**
 * Every node from `cut` upwards, and how many events were left below it.
 *
 * `cut` is the lowest seq to draw, and **the only thing that ever stops this
 * walk**. It was a node budget — the newest 400, with a button growing it by 400
 * more — and that is gone, because a conversation is not a feed. Opening one
 * started three or four taps from its own beginning, and the number those taps
 * revealed had nothing to do with anything the reader could see.
 *
 * What replaces it is the cut the *agent* made. After a `/clear` the conversation
 * above is one the agent has been told to forget, which is the only boundary in a
 * transcript that means something, and `store.ts` does not even fetch below it
 * until somebody asks. `cut` defaults to 0 — no cut, draw everything.
 *
 * The run-completeness rule the budget needed is simply not a question any more:
 * every event at or above `cut` is included, and a text run cannot straddle the
 * boundary because the `context_cleared` marker sitting on it is not text and
 * flushes the run.
 *
 * Still walks backwards, which is now about node *identity* rather than cost —
 * a `tool_call_update` has to be collected before the `tool_call` it belongs to
 * is reached, and a `permission_resolved` before its request.
 *
 * `hidden` counts *events* below the cut, which is what the control offers to
 * reveal. Nodes are fewer than events by however much coalescing merged, so
 * reporting nodes there would promise a number that never arrives.
 *
 * Takes the fields it reads rather than a `Transcript`, so `webcheck` can call it
 * with a literal.
 */
export function buildTail(
  events: readonly StoredEvent[],
  gaps: readonly Gap[],
  cut = 0,
  /**
   * `permissionDecisions(events)`, threaded in rather than recomputed.
   *
   * `EventList` already memoises it on the same `events` array this takes, so passing
   * it costs nothing and computing it here would be a second full walk per streamed
   * token. Absent means no permission folds — see `foldRuns`.
   */
  decisions: ReadonlyMap<string, PermissionOptionKind> = new Map(),
): Tail {
  /** Collected newest-first, and deliberately placed by nobody until phase two. */
  const collected: TailNode[] = [];
  /** See {@link Tail.taskFloor}. Raised once, by the newest marker the walk meets. */
  let taskFloor = 0;
  let run: { seq: number; role: string; thought: boolean; parts: string[] } | null = null;

  const updates = new Map<
    string,
    PendingUpdate[]
  >();

  /**
   * What each tool call calls itself, for a permission that has no title of its own.
   *
   * The walk is backwards, so the **first** title seen for an id is the newest one —
   * which is the one to keep, for `resolveTool`'s reason: claude's call says
   * `Terminal` and its update says `echo hi-there`. Costs one map write per titled
   * event and no walk of its own; see `EventNode.heading`.
   */
  const titleByCall = new Map<string, string>();

  /**
   * Changes waiting for the call that made them, by `toolCallId`.
   *
   * Collected exactly like `updates` and claimed at the same place, because the
   * problem is the same one: the walk is backwards, so a `file_change` is met
   * *before* the `tool_call` it names, and the call is the only defensible owner.
   */
  const changesByCall = new Map<string, FileChangeEvent[]>();

  /** Permission ids that a `permission_resolved` row already speaks for. */
  const resolvedPermissions = new Set<string>();
  /**
   * The same, for questions — and deliberately a **second set** rather than a
   * shared one.
   *
   * The two id spaces come from one counter on the daemon with different
   * prefixes, so a collision is not possible today. That is not the reason: one
   * set would mean a permission could suppress a question's row, or the reverse,
   * and the failure would be a row silently missing from a transcript with
   * nothing anywhere to say so. Two sets make it unsayable instead of unlikely.
   */
  const resolvedElicitations = new Set<string>();
  /**
   * Tool calls that exist only because a question was asked through them.
   *
   * `canUseTool` runs `ensureToolCallEmitted` *before* the elicitation, so an
   * `AskUserQuestion` surfaces as an ordinary `tool_call` — an "Asking for your
   * input" card sitting directly above the question card, saying the same thing
   * twice and offering a download button for a tool that produced no file.
   *
   * Dropped by **identity**: an elicitation event names its `toolCallId`, so this
   * is a join on an id the agent itself supplied, exactly as `permissionDecisions`
   * joins on `optionId`. It never matches on the tool's *name* — `AskUserQuestion`
   * is what one adapter happens to call it, and an MCP server's question would
   * come through a tool called something else entirely.
   */
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
      /*
       * Collected newest-first and reversed once here, rather than `unshift`ed
       * into document order on the way in.
       *
       * `unshift` is O(n) — it moves every part already held — so a run of k
       * chunks cost O(k²) to build, and `buildTail` re-runs on every arriving
       * token, which made one streamed reply O(k³). The old node budget hid it
       * by capping k; with the budget gone k is the whole length of an agent
       * message. Measured before this change: 0.061ms to build a 1000-chunk run
       * and 2.48ms for 8000 — 40x for 8x the length — and 942ms of main thread
       * to *receive* a 4000-chunk reply on a desktop, spent in its last third.
       *
       * `reverse()` mutates, which is safe because `run` is cleared on the next
       * line and these parts are never read again.
       */
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
      // Below the cut is a conversation the agent no longer has. Flushed first so
      // the oldest surviving run is written out rather than abandoned in `run`.
      flush();
      break;
    }
    const event = stored.event;

    /*
     * The floor, taken from the walk that is already happening rather than from a
     * pass of its own — and taken **first**, before any `continue` below can skip
     * the event that raised it. `session_started` draws nothing
     * (`TRANSCRIPT_SILENT`) and `turn_end: end_turn` is refused by
     * `showsInTranscript`, so both markers are events this loop is otherwise
     * walking past. Backwards, so the first is the newest; `taskFloor` is
     * therefore written once and never lowered. See {@link Tail.taskFloor}.
     */
    if (
      taskFloor === 0 &&
      (event.type === "session_started" ||
        (event.type === "turn_end" && event.stopReason !== "end_turn"))
    ) {
      taskFloor = stored.seq;
    }

    if (event.type === "text") {
      /*
       * A thought draws nothing — see `showsInTranscript`.
       *
       * Flushed rather than simply skipped, and that is the whole subtlety: the
       * parts of a run are joined with no separator, so letting the speech either
       * side of a reasoning block merge into one run would run the last sentence
       * of the first into the first word of the second. Flushing keeps them two
       * runs, which is the paragraph break that was there anyway.
       *
       * It also costs no `budget`, so the window fills with speech.
       */
      if (!showsInTranscript(event)) {
        flush();
        continue;
      }
      if (run !== null && run.role === event.role && run.thought === event.thought) {
        // `push`, not `unshift` — see `flush`, which reverses once. The walk is
        // backwards, so this arrives newest-first and is put back in order there.
        run.parts.push(event.text);
        // A run is keyed and ordered by its *first* event, which going backwards
        // is the one most recently seen.
        run.seq = stored.seq;
        continue;
      }
      flush();
      run = { seq: stored.seq, role: event.role, thought: event.thought, parts: [event.text] };
      continue;
    }

    // Collected before the node decision below, so the `tool_call` this belongs
    // to — which is *older*, and therefore reached later — can consume the set.
    if (event.type === "tool_call_update") {
      let list = updates.get(event.toolCallId);
      if (list === undefined) {
        list = [];
        updates.set(event.toolCallId, list);
      }
      // Unshifted: the walk is backwards and `mergeUpdates` wants document order.
      list.unshift({
        ts: stored.ts,
        status: event.status,
        title: event.title,
        rawInput: event.rawInput,
        locations: event.locations,
        content: event.content ?? null,
        // Copied field by field, which is why this was silently lost once: the
        // record is *rebuilt* here rather than spread, so a new member of
        // `PendingUpdate` reaches `mergeUpdates` only if it is named on this
        // line too. Extracting the type stopped the three copies drifting; it
        // does not make a missing field a type error, because the member is
        // optional — and it has to be, since an older daemon sends none.
        images: event.images ?? null,
        parentToolCallId: event.parentToolCallId ?? null,
      });
    }

    if (
      (event.type === "tool_call" || event.type === "tool_call_update") &&
      event.title !== null &&
      event.title !== event.toolCallId &&
      !titleByCall.has(event.toolCallId)
    ) {
      // `!== toolCallId` so a call the agent also failed to name cannot lend its own
      // id to a permission as though it were a name.
      titleByCall.set(event.toolCallId, event.title);
    }

    if (event.type === "file_change" && event.toolCallId !== null) {
      let list = changesByCall.get(event.toolCallId);
      if (list === undefined) {
        list = [];
        changesByCall.set(event.toolCallId, list);
      }
      // Unshifted for `updates`' reason: the walk is backwards and a card draws its
      // changes in the order they happened.
      list.unshift(event);
    }

    // Collected the same way and for the same reason as `updates` above: the walk
    // is backwards, so a resolution is met *before* the request it answers, and by
    // the time that request is reached we know whether anything ever came back. A
    // request inside the window always has its resolution inside it too — the
    // resolution is newer and the window is a suffix.
    if (event.type === "permission_resolved") resolvedPermissions.add(event.permissionId);
    if (event.type === "elicitation_resolved") resolvedElicitations.add(event.elicitationId);
    // Either event names the call, and the backwards walk meets both before the
    // `tool_call` they belong to — the same ordering `resolvedPermissions` above relies on.
    if (
      (event.type === "elicitation_request" || event.type === "elicitation_resolved") &&
      event.toolCallId !== null
    ) {
      askedThrough.add(event.toolCallId);
    }

    /*
     * An event that draws nothing does not break the run either.
     *
     * The flush is what puts a boundary between two agent messages, and for
     * `tool_call`, `turn_end` and a `context_cleared` marker that boundary is
     * real — something is drawn between them. For `TRANSCRIPT_SILENT` it is not:
     * the row costs no slot and appears nowhere, so cutting the run there splits
     * one streamed message into two independently parsed `<Markdown>` blocks,
     * with nothing on screen to explain the break. Both types this really happens
     * with interleave with `text` inside a single turn: an `agent_log` is a line
     * the agent wrote to stderr, and codex emits `session_info_update` — an
     * `other` — about five times a turn. The visible cost is worst on a fenced
     * code block whose chunks straddle one of them — an unterminated fence
     * followed by a stray paragraph — and the ordinary form is a word split in
     * two, `"here is the pl"` and `"an:"` as separate paragraphs.
     *
     * Keyed on the set rather than on `showsInTranscript`, deliberately: a
     * `turn_end: end_turn` also draws no row, and it *is* a boundary — the
     * message after it is a different turn's.
     */
    if (!TRANSCRIPT_SILENT.has(event.type)) flush();

    const node = nodeFor(
      stored,
      updates,
      changesByCall,
      resolvedPermissions,
      resolvedElicitations,
      askedThrough,
    );
    if (node !== null) collected.push(node);
  }
  flush();

  /*
   * Name the permissions codex left unnamed — a pass of its own, because the walk
   * cannot do it inline.
   *
   * A permission is met *before* the `tool_call` that names it (the call is older, so
   * the backwards walk reaches it later), which is the same ordering that makes
   * `updates` and `changesByCall` collections rather than lookups. Here the map is
   * complete once the walk is, so this reads it afterwards instead of deferring the
   * node.
   */
  for (const node of collected) {
    if (node.kind !== "event") continue;
    const event = node.stored.event;
    if (event.type !== "permission_request" && event.type !== "permission_resolved") continue;
    // The exact equality is the whole test: it is what the daemon's
    // `title ?? toolCallId` fallback leaves behind, and it names no vendor.
    if (event.toolCallId === null || event.title !== event.toolCallId) continue;
    node.heading = titleByCall.get(event.toolCallId) ?? null;
  }

  const rows = placeNodes(collected.reverse());

  // Where the walk stopped — an O(1) read of what the loop already knows, rather
  // than a spread over every row for a number that is sitting right here.
  const oldestRendered = events[index + 1]?.seq ?? 0;
  for (const gap of gaps) {
    // Only gaps above the cut. One below it belongs to the conversation that was
    // cleared, and reporting a hole in a transcript nobody is being shown is
    // noise about something that is not on screen.
    if (gap.from - 0.5 >= oldestRendered) {
      rows.push({ kind: "gap", key: `g${gap.from}`, seq: gap.from - 0.5, parentId: null, gap });
    }
  }

  rows.sort((a, b) => a.seq - b.seq);
  /*
   * Folded last, on the sorted rows, so a run is decided by what a reader would
   * actually see in order — the gaps are in place by here, and one of them breaks a
   * run exactly as a message does.
   */
  return { rows: foldRuns(rows, decisions), hidden: index + 1, taskFloor };
}

/**
 * Event types the transcript never draws a row for.
 *
 * The first four never had a rendering: `agent_config` is read by
 * `AgentConfigBar` off the event window, and the other three are daemon plumbing.
 * The last two are the correction, and both are drawn **twice** — with the second
 * copy being the one that is always on screen:
 *
 *   `status`    — `— exited (daemon_restarted) —` sat two rows above `ExitNotice`
 *                 saying the same thing in a sentence with a Reconnect button
 *                 beside it, and every live state it can report is the header's
 *                 `StatusDot`, which never leaves the screen.
 *   `workspace` — the header carries mode and branch, which is the part of this
 *                 event anybody looks for. **The warnings are now drawn nowhere**,
 *                 and that is a deliberate removal rather than the old
 *                 arrangement: this used to say the `WorkspaceWarnings` banner
 *                 carried them, and that banner was deleted on request. Said out
 *                 loud because a suppression whose stated reason has evaporated is
 *                 the shape that gets "restored" by the next reader — the events
 *                 are still in the log and `git.ts` still records them, so putting
 *                 them back is deleting one line from this set, not rebuilding
 *                 anything. What is lost is `dirty_source`: uncommitted work in
 *                 the source checkout is not in the session, and nothing on screen
 *                 says so any more.
 *
 * Suppressed **here** rather than in `EventList`, and that is the load-bearing
 * half: a node refused by `nodeFor` never spends `budget`, so the render window
 * fills with things somebody wants to read. Refusing it in the JSX would draw
 * exactly the same nothing and cost exactly the same slot.
 *
 * The events themselves are untouched. `WorkspaceWarnings`, `permissionContext`
 * and `configProse` all walk `transcript.events` directly, so nothing that reads
 * the log loses anything by a row not being drawn.
 */
export const TRANSCRIPT_SILENT: ReadonlySet<string> = new Set([
  "agent_config",
  "session_started",
  "agent_log",
  "other",
  "status",
  "workspace",
]);

/**
 * Whether one event earns a row, from the event alone.
 *
 * A predicate rather than a bare set because two rules read the payload:
 *
 *   `turn_end` — `end_turn` is the reason **every** ordinary reply ends, so
 *                `— turn ended: end_turn —` landed after every single agent
 *                message and said only that the paragraph you had just finished
 *                reading had finished. Every other stop reason is a turn that
 *                did *not* complete — `max_tokens`, `refusal`, `cancelled` — and
 *                each of those is worth a line, because without it the agent
 *                simply stops mid-thought.
 *   `text`     — a **thought is not drawn at all.** It arrived as a collapsed
 *                `thinking …` card, which is a box you have to open to find out
 *                whether it was worth opening, and several of them accumulate
 *                per turn between the messages somebody is actually reading.
 *                What it was there to say — the agent is working — is now the
 *                one `working…` row at the foot of the transcript, which says it
 *                once rather than once per reasoning block.
 *
 * `tool_call` and `tool_call_update` answer `true` and never reach here: `nodeFor`
 * has already turned them into their own node kinds. They are in the answer
 * anyway, so this reads as a statement about the whole union rather than about
 * whatever happens to be left over.
 */
export function showsInTranscript(event: SessionEvent): boolean {
  if (TRANSCRIPT_SILENT.has(event.type)) return false;
  if (event.type === "turn_end") return event.stopReason !== "end_turn";
  if (event.type === "text") return !event.thought;
  return true;
}

/**
 * What each answered permission was actually answered *with*.
 *
 * `PermissionResolvedEvent.outcome` is `"selected" | "cancelled"`, and `selected`
 * means **an option was chosen** — not that permission was granted. ACP's option
 * kinds are `allow_once | allow_always | reject_once | reject_always`, so tapping
 * Deny produces `outcome: "selected"` with `optionId` naming a `reject_*` option.
 * A renderer keyed on `outcome` therefore drew a check mark against a refused
 * command, which is the transcript asserting the opposite of what happened on the
 * one row where being wrong has consequences.
 *
 * The kind is not on the resolution — it is on the *request*, whose `options`
 * carry `{optionId, name, kind}` — so answering needs both events, which is why
 * this is a walk over the window rather than a field read. `optionId` is chosen
 * by the agent and is not a vocabulary we may pattern-match on: `"reject_once"`
 * is what claude happens to send and nothing promises it, so the join is by
 * identity against the option list and an id that matches nothing answers `null`.
 *
 * Forwards, because a request precedes its resolution and this is the one place
 * in this file that wants them in that order. Over the whole loaded window rather
 * than the render window: a request can sit above the fold while its answer is on
 * screen, and the answer is the row that needs the verdict.
 */
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

/** Whether a decided permission was a refusal. `null`/unknown is never a refusal. */
export function refused(kind: PermissionOptionKind | undefined): boolean {
  return kind === "reject_once" || kind === "reject_always";
}

/** How long a rendered answer may run in one transcript row. */
const ANSWER_SUMMARY_CHARS = 160;

/**
 * What a settled question says in the transcript.
 *
 * **No join, and that is the difference from a permission.** `permissionDecisions`
 * exists because `PermissionResolvedEvent` carries only an `optionId`, so a
 * renderer has to walk back to the request's `options` to learn whether the
 * answer was an approval or a refusal — and while that walk was missing, a
 * refused command was drawn with a check mark. The daemon renders an
 * elicitation's answer into `label`/`value` pairs on the resolution itself,
 * precisely so the same defect cannot recur here.
 *
 * `skipped` is the adapter's own word for `decline`: the tool runs with empty
 * answers and the model is told the person skipped, so the row and the model say
 * the same thing.
 */
export function elicitationOutcome(event: ElicitationResolvedEvent): {
  tone: "ok" | "quiet" | "warn";
  verb: "answered" | "skipped" | "cancelled";
  summary: string | null;
} {
  if (event.action === "decline") return { tone: "quiet", verb: "skipped", summary: null };
  if (event.action !== "accept") return { tone: "warn", verb: "cancelled", summary: null };

  const answers = event.answers ?? [];
  if (answers.length === 0) return { tone: "ok", verb: "answered", summary: null };
  // One pair needs no label — the question is already the row above it. Several
  // do, and ` · ` is this app's existing separator.
  const text =
    answers.length === 1
      ? (answers[0]?.value ?? "")
      : answers.map((answer) => `${answer.label}: ${answer.value}`).join(" · ");
  return {
    tone: "ok",
    verb: "answered",
    summary:
      text.length > ANSWER_SUMMARY_CHARS ? `${text.slice(0, ANSWER_SUMMARY_CHARS)}…` : text,
  };
}

/** One event as a node, or `null` when it draws nothing on its own. */
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
    // A call that only exists to carry a question is drawn by the question, not
    // beside it. Its updates are claimed first so they cannot be re-merged onto
    // some later call reusing the id.
    if (askedThrough.has(event.toolCallId)) {
      updates.delete(event.toolCallId);
      changesByCall.delete(event.toolCallId);
      return null;
    }
    const list = updates.get(event.toolCallId);
    // Claimed, not merely read. Ids are agent-chosen and nothing validates them,
    // so a reused one would otherwise let *every* call answering to it merge the
    // same list — two cards drawing one call's title, status and output. The walk
    // is backwards, so the claimant is the nearest call preceding the update,
    // which is the only defensible owner.
    updates.delete(event.toolCallId);
    // Claimed on the same terms, and deleted whether or not anything was there: a
    // reused id must not let a second card draw the first one's edits.
    const claimedChanges = changesByCall.get(event.toolCallId);
    changesByCall.delete(event.toolCallId);
    const merged = list === undefined ? null : mergeUpdates(list);
    // The call's own link wins, and an update's fills in only when it has none —
    // the same first-non-null rule, from the other side.
    const parentId = event.parentToolCallId ?? merged?.parentToolCallId ?? null;
    return {
      kind: "tool",
      key: `e${stored.seq}`,
      seq: stored.seq,
      toolCallId: event.toolCallId,
      parentId: parentId === event.toolCallId ? null : parentId,
      ...resolveTool(event, merged),
      // `=== true` and not `??`: the field is optional in this mirror because an
      // older daemon does not send it, and absent means "did not say".
      subagent: event.subagent === true,
      changes: claimedChanges ?? [],
      children: [],
      steps: 0,
      omitted: 0,
      latest: null,
      // Only once it has stopped: a ticking number would re-render the whole
      // transcript once a second, which is what this file's bounds exist against.
      elapsedMs:
        merged !== null &&
        merged.statusTs !== null &&
        (merged.status === "completed" || merged.status === "failed")
          ? merged.statusTs - stored.ts
          : null,
    };
  }

  if (event.type === "tool_call_update") {
    // Folded into its `tool_call` when that call is in the window — `placeNodes`
    // is what discovers this, and it is why the reverse splice pass is gone. A
    // failure whose call fell outside still shows: on a long transcript scrolled
    // to the bottom, it is the only thing saying something broke up there.
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
    /*
     * A node even when its call is in the window, and dropped there rather than
     * here — the same arrangement as an update, for the same reason: the walk is
     * backwards, so at this point the `tool_call` has not been reached and whether
     * it is inside the window is not yet knowable. `placeNodes` decides.
     */
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

  /*
   * A request and its answer are one fact, and the answer is the better line: it
   * carries the same title plus what was decided and, when it was not a human,
   * who decided it. While the request is still outstanding it is not lost — it is
   * the `PermissionCard` under the transcript, at full size with its buttons.
   *
   * `resolvedPermissions.has(...)` and **not** "it has a decision on it": measured against
   * the daemon, a request parked for a remote client carries `decision: null` for
   * its whole life and is settled by a separate `permission_resolved`
   * (`registry.ts`), while only a bare `Session` with nobody attached fills
   * `decision` in and emits no resolution at all (`session.ts`). A rule reading
   * `decision` would therefore have suppressed exactly the rows it meant to keep
   * and kept exactly the ones it meant to suppress.
   *
   * The one request that keeps its row is the one nothing ever answered — a
   * daemon restart with an approval in flight, for which no resolution is
   * synthesized on purpose. That row is the only trace of it.
   */
  if (
    event.type === "permission_request" &&
    event.permissionId !== null &&
    resolvedPermissions.has(event.permissionId)
  ) {
    return null;
  }

  // The same rule for a question, through its own set. Identical shape and
  // identical exception: an unanswered request keeps its row, because after a
  // restart it is the only trace that the agent ever asked.
  if (event.type === "elicitation_request" && resolvedElicitations.has(event.elicitationId)) {
    return null;
  }

  return {
    kind: "event",
    key: `e${stored.seq}`,
    seq: stored.seq,
    parentId: null,
    stored,
    // Filled in by `buildTail`'s naming pass, which needs the whole window.
    heading: null,
  };
}
