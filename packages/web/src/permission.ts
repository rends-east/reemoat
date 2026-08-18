import type {
  FileChangeEvent,
  PendingPermissionSnapshot,
  PermissionOptionSummary,
  StoredEvent,
  ToolCallEvent,
  ToolKind,
} from "./wire";

/**
 * What is actually being approved.
 *
 * Two sources, in this order, and both are needed:
 *
 *  1. **The permission itself.** `rawInput` and `content` ride the pending
 *     permission. This is the reliable source and usually the only one — kimi,
 *     the agent that actually asks for approval, emits its `tool_call` event with
 *     `rawInput: null` and sends the command for the first time on the permission
 *     request.
 *  2. **The event log, joined on `toolCallId`.** The fallback, and it still earns
 *     its place: an agent that populates the `tool_call` and then asks with a
 *     thinner request lands here, as does any `file_change` the agent emitted
 *     alongside the call.
 *
 * When neither has anything, the card says so rather than implying there was no
 * command — an approval button above an empty box is worse than one above an
 * explicit "we cannot show you this".
 */

export interface PermissionContext {
  kind: ToolKind | null;
  /** A shell command, extracted from `rawInput` when it looks like one. */
  command: string | null;
  /** `rawInput` rendered as JSON, when it is not a recognisable command. */
  rawInput: string | null;
  /**
   * Text the agent sent with the request.
   *
   * Measured against kimi, this is where the command actually is: it sends
   * `rawInput: null` and one content block reading "Requesting approval to
   * Running: echo hello". Treating text blocks as decoration — which was the
   * first guess — left the card with an approve button and nothing above it.
   */
  text: string[];
  /**
   * The single file, URL or other subject the tool is acting on.
   *
   * A read or an edit has no `command`, so before this the card showed the
   * approve buttons above an empty box for exactly the requests where knowing
   * *which file* is the entire question being asked.
   */
  target: string | null;
  /**
   * The text a write is about to put on disk.
   *
   * The substance of a `Write`, and the card never had it. See
   * {@link ExtractedInput.body}.
   */
  body: string | null;
  /**
   * The tool's own sentence about this call, when it sent one.
   *
   * What a heading can honestly be built from — see {@link permissionHeadline}.
   */
  summary: string | null;
  /** True when the daemon replaced the payload with its truncation stand-in. */
  truncated: boolean;
  diffs: FileChangeEvent[];
  locations: string[];
  /** Nothing in the request or the log says what this is. */
  unavailable: boolean;
}

const EMPTY: PermissionContext = {
  kind: null,
  command: null,
  target: null,
  body: null,
  summary: null,
  rawInput: null,
  text: [],
  truncated: false,
  diffs: [],
  locations: [],
  unavailable: true,
};

export function permissionContext(
  pending: PendingPermissionSnapshot,
  events: readonly StoredEvent[],
): PermissionContext {
  const toolCallId = pending.toolCallId;

  let call: ToolCallEvent | null = null;
  const diffs: FileChangeEvent[] = [];
  /*
   * The newest arguments and the newest content this call has, **from the call or
   * from any of its updates**.
   *
   * The docblock above has always promised the log as a fallback and this only
   * ever read the `tool_call` event itself, which is the one event that usually
   * carries neither — "one tool call is five events and every useful field is on a
   * different one" is in the gotchas table, and this function was the counterexample
   * to it. Measured against a real kimi `Write`: the call and every update carry
   * `rawInput: null`, and the file being written appears once, on the last update
   * before the request, as a content block.
   */
  let callInput: unknown = null;
  /*
   * Already-extracted strings, not ACP blocks: the daemon flattens a tool's text
   * blocks onto the update, and only an update ever carries them.
   */
  let callText: string[] | null = null;

  if (toolCallId !== null) {
    // Backwards: the tool call is normally the most recent event with this id,
    // and a long transcript should not be walked from the beginning to find it.
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]?.event;
      if (event === undefined) continue;
      if (event.type === "file_change" && event.toolCallId === toolCallId) {
        diffs.unshift(event);
        continue;
      }
      if (event.type !== "tool_call" && event.type !== "tool_call_update") continue;
      if (event.toolCallId !== toolCallId) continue;
      if (callInput === null && event.rawInput !== null && event.rawInput !== undefined) {
        callInput = event.rawInput;
      }
      if (
        callText === null &&
        event.type === "tool_call_update" &&
        Array.isArray(event.content) &&
        event.content.length > 0
      ) {
        callText = event.content;
      }
      if (call === null && event.type === "tool_call") call = event;
    }
  }

  const blocks = readContentBlocks(pending.content);
  const fromCall = readTextBlocks(callText);

  /*
   * The request's own payload wins, then the call's, then whichever of the two
   * echoed its arguments into a text block.
   *
   * That last source is what makes a kimi `Write` legible: it sends the tool's
   * input as a JSON *string* inside a content block, so as prose it is a wall of
   * escaped newlines and as arguments it is a path and a file.
   */
  const source = pending.rawInput ?? callInput ?? blocks.args ?? fromCall.args;
  const extracted = readInput(source);
  const allDiffs = diffs.length > 0 ? diffs : blocks.diffs;
  const text = blocks.text.length > 0 ? blocks.text : fromCall.text;
  /*
   * A sentence that already contains the command says nothing beside it.
   *
   * kimi's prose is "Requesting approval to Running: <the whole command>", so the
   * card drew the command twice — once wrapped in a sentence and once on its own,
   * both in monospace, both the width of the card. Containment on two strings this
   * function already holds; nothing is being matched against agent vocabulary, and
   * a description that merely *mentions* a filename is untouched.
   */
  /*
   * ...and the same for the *target*. kimi announces a write as "Requesting
   * approval to Writing /tmp/permission_test.txt", which the heading — "Allow
   * Kimi to write permission_test.txt?" — now says in better words, with the
   * path itself in the box directly under it. Three copies of one fact, one of
   * them with a capital letter in the middle of a sentence.
   *
   * The accepted risk is the same one the command filter already takes: a
   * sentence that names the file *and* says something else loses the something
   * else. Both filters are containment on a string this function already holds,
   * and both would rather drop a boilerplate announcement than print it three
   * times.
   */
  const echoed = extracted.command ?? extracted.target;
  const prose = echoed === null ? text : text.filter((line) => !line.includes(echoed));

  /*
   * `content` is clamped by the same `clampBlob` as `rawInput`, so it can be the
   * `{truncated, bytes}` stand-in too — and it is the *diff* case, which is the
   * one most likely to exceed 8 KiB.
   *
   * Checked here as well because `readContentBlocks` only understands an array:
   * the marker is an object, so it fell through to "no blocks" and the card then
   * explained that the tool call was no longer in the log. That is a false
   * explanation for a payload that existed and was cut for size, and it points the
   * reader at the wrong thing entirely.
   */
  const contentTruncated = isTruncationMarker(pending.content);
  const truncated = extracted.truncated || contentTruncated;

  const empty =
    extracted.command === null &&
    extracted.target === null &&
    extracted.pretty === null &&
    extracted.body === null &&
    !truncated &&
    text.length === 0 &&
    allDiffs.length === 0 &&
    (call?.locations ?? []).length === 0;
  if (empty) return EMPTY;

  return {
    kind: call?.kind ?? null,
    command: extracted.command,
    target: extracted.target,
    body: extracted.body,
    summary: extracted.summary,
    rawInput: withoutEchoedFields(source, extracted.pretty, prose),
    text: prose,
    truncated,
    diffs: allDiffs,
    locations: (call?.locations ?? []).map(formatLocation),
    unavailable: false,
  };
}

/**
 * Read the request's ACP content blocks.
 *
 * Two shapes are worth anything to a human approving from a phone:
 *
 *   - `{type: "diff", path, oldText, newText}` — an edit. Normalized into
 *     `FileChangeEvent` so the card renders one diff shape regardless of whether
 *     it arrived on the request or as a `file_change` event in the log.
 *   - `{type: "content", content: {type: "text", text}}` — prose. This is where
 *     kimi actually puts the command, so it is content and not decoration.
 *
 * `{type: "terminal"}` is ignored: it is a handle, not a description, and there
 * is nothing to show for it.
 */
function readContentBlocks(content: unknown): {
  diffs: FileChangeEvent[];
  text: string[];
  args: unknown;
} {
  if (!Array.isArray(content)) return { diffs: [], text: [], args: null };
  const diffs: FileChangeEvent[] = [];
  const text: string[] = [];
  let args: unknown = null;

  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const block = entry as Record<string, unknown>;

    if (block["type"] === "diff") {
      if (typeof block["path"] !== "string" || typeof block["newText"] !== "string") continue;
      diffs.push({
        type: "file_change",
        path: block["path"],
        oldText: typeof block["oldText"] === "string" ? block["oldText"] : null,
        newText: block["newText"],
        source: "diff",
        toolCallId: null,
      });
      continue;
    }

    if (block["type"] === "content") {
      const inner = block["content"];
      if (typeof inner !== "object" || inner === null) continue;
      const record = inner as Record<string, unknown>;
      if (record["type"] === "text" && typeof record["text"] === "string" && record["text"].length > 0) {
        const parsed = args === null ? asArguments(record["text"]) : null;
        // A block that is *entirely* a JSON object is the tool echoing its own
        // input, not something written for a person to read. Shown as prose it is
        // the file with every newline escaped; read as arguments it is a path and
        // a body. Anything that is not exactly an object stays prose, so the
        // sentence kimi sends with a command is untouched.
        if (parsed !== null) args = parsed;
        else text.push(record["text"]);
      }
    }
  }

  return { diffs, text, args };
}

/**
 * The same two questions of the plain strings a tool call carries.
 *
 * `ToolCallUpdateEvent.content` is `string[]` rather than ACP blocks — the daemon
 * flattens them on ingest — so this is `readContentBlocks` with the unwrapping
 * already done and no diff arm, since a diff never arrives this way.
 */
function readTextBlocks(content: string[] | null): { text: string[]; args: unknown } {
  if (content === null) return { text: [], args: null };
  const text: string[] = [];
  let args: unknown = null;
  for (const entry of content) {
    if (entry.length === 0) continue;
    const parsed = args === null ? asArguments(entry) : null;
    if (parsed !== null) args = parsed;
    else text.push(entry);
  }
  return { text, args };
}

/**
 * The arguments blob, minus whatever the prose above it already draws verbatim.
 *
 * `readInput` already refuses to show `pretty` beside a `body` — "the identical
 * bytes with the newlines escaped" — and this is the same rule for the case that
 * arm does not cover. Measured against claude's plan mode (s_f07c0791, seq 47/48,
 * claude-agent-acp 0.63.0): the request carries `rawInput: {plan, planFilePath}`
 * **and** a content block whose text is byte-for-byte `rawInput.plan`, 5175
 * characters of markdown. `plan` is not a `BODY_FIELD`, so `pretty` survived and
 * `details` drew the whole plan twice — once readable, once with every newline
 * escaped, about 16 KiB of the same document in two adjacent scrollers.
 *
 * Fields are dropped rather than the blob, so `planFilePath` — the only thing in
 * there that the prose does *not* say — survives. Equality and not containment:
 * a field that merely mentions a path is not an echo of a paragraph.
 */
function withoutEchoedFields(
  source: unknown,
  pretty: string | null,
  prose: readonly string[],
): string | null {
  if (pretty === null || prose.length === 0) return pretty;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return pretty;
  const record = source as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && prose.includes(value)) continue;
    kept[key] = value;
  }
  const keys = Object.keys(kept).length;
  if (keys === Object.keys(record).length) return pretty;
  return keys === 0 ? null : JSON.stringify(kept, null, 2);
}

/** A text block that is nothing but a JSON object, or `null`. */
function asArguments(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    // Prose that merely begins and ends with a brace. Left as prose.
    return null;
  }
}

export interface ExtractedInput {
  command: string | null;
  /** A file, URL or other single subject the tool is acting on. */
  target: string | null;
  /**
   * What is about to be put on disk.
   *
   * The thing you are actually approving when a tool writes a file, and until now
   * the one thing the card never showed. Measured against a real kimi `Write`: the
   * permission carries the sentence *"Requesting approval to Writing
   * tictactoe.py"* and nothing else, while the whole file sits on the tool call as
   * `{"path": …, "content": …}` — so the card asked you to approve a write whose
   * contents it had and did not draw.
   *
   * Separate from `pretty` because a body is prose to read, not arguments to
   * inspect: `pretty` is JSON with the newlines escaped, which is the same bytes
   * and unreadable.
   */
  body: string | null;
  /** {@link SUMMARY_FIELDS} — the tool's own sentence about this call. */
  summary: string | null;
  pretty: string | null;
  truncated: boolean;
}

const NOTHING: ExtractedInput = {
  command: null,
  target: null,
  body: null,
  summary: null,
  pretty: null,
  truncated: false,
};

/** `path`-shaped fields, in the order agents actually use them. */
const TARGET_FIELDS = ["path", "file_path", "filePath", "filename", "file", "url", "uri", "notebook_path"];
/** Fields whose value reads as the whole action. */
const COMMAND_FIELDS = ["command", "cmd", "script", "query", "pattern"];
/** Fields holding the text a tool is about to write. Longest-standing names first. */
const BODY_FIELDS = ["content", "new_string", "newText", "new_str", "text", "body"];
/**
 * The tool's own one-line account of what it is doing.
 *
 * claude's Bash tool takes a `description` beside the command and it is the
 * sentence its own approval prompt is built from — "Run analogy, odd-one-out and
 * neighbours demos". Measured on this daemon: `rawInput: {command, description}`.
 * It is the agent's words, not ours, which is the only reason a heading may be
 * built out of it.
 */
const SUMMARY_FIELDS = ["description", "summary", "explanation"];

/**
 * Pull something human-readable out of a tool's arguments.
 *
 * `rawInput` is whatever the agent sent, so this guesses at the common shapes and
 * falls back to pretty-printed JSON rather than asserting a schema that neither
 * this client nor the daemon controls.
 *
 * Exported because `EventList` needs exactly this and had its own copy —
 * `describeInput` — which was this function minus the truncation marker, minus the
 * field probing, and with the same emptiness bug. Two guesses at one undocumented
 * shape is one too many.
 *
 * **Memoised on the arguments object, and that became load-bearing rather than
 * merely tidy.** The fallback is `JSON.stringify(rawInput, null, 2)`, which is
 * reached for exactly the shapes that carry no command and no body — a `Read`'s
 * `{file_path}` among them. It was already called once per card per render; it is
 * now also called from `tallyOf`, which runs inside `buildTail`, i.e. **once per
 * streamed token**, so a run of fifty reads pretty-printed fifty objects per token.
 * A `rawInput` is a reference into a `StoredEvent` and those are never mutated, so
 * identity is a sound key — the same argument `changeCounts` makes in `diff.ts`, and
 * a `WeakMap` keeps it from being a leak. Non-objects are not cached and do not
 * need to be: they take the cheap paths above.
 */
const READ_INPUT = new WeakMap<object, ExtractedInput>();

export function readInput(rawInput: unknown): ExtractedInput {
  if (typeof rawInput !== "object" || rawInput === null) return computeInput(rawInput);
  const cached = READ_INPUT.get(rawInput);
  if (cached !== undefined) return cached;
  const computed = computeInput(rawInput);
  READ_INPUT.set(rawInput, computed);
  return computed;
}

function computeInput(rawInput: unknown): ExtractedInput {
  if (rawInput === undefined || rawInput === null) return NOTHING;

  // The daemon's stand-in for a payload it would not carry whole. On this path
  // that is the 8 KiB pending-permission cap (`MAX_PERMISSION_BLOB_BYTES` in
  // `registry.ts`), not the 128 KiB per-event cap — which matters, because a
  // reader who believes 128 KiB concludes this branch is unreachable for anything
  // a shell command could produce, and at 8 KiB it plainly is not. The log-join
  // fallback is the one that carries the per-event cap. Rendering either as an
  // empty command would be a lie about a command that exists.
  if (isTruncationMarker(rawInput)) {
    return { ...NOTHING, truncated: true };
  }

  // Trimmed: a `rawInput` of `"   "` is not a command made of spaces, and
  // rendering it produced an expandable row whose whole body was whitespace.
  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    return trimmed.length > 0 ? { ...NOTHING, command: trimmed } : NOTHING;
  }

  if (typeof rawInput !== "object") return NOTHING;

  const record = rawInput as Record<string, unknown>;

  /*
   * The emptiness gate, and the whole of the reported bug.
   *
   * `{}` is not `null`, so it fell straight through to `JSON.stringify` and every
   * argument-less tool call rendered as an expandable row containing the two
   * characters `{}`. Two render sites had it — this one, under the approve
   * buttons, and `EventList`'s own copy — which is why the fix is here and there
   * is now only one copy.
   *
   * Arrays included: `[]` stringifies just as uselessly.
   */
  if (Array.isArray(rawInput) ? rawInput.length === 0 : Object.keys(record).length === 0) {
    return NOTHING;
  }

  const pick = (fields: readonly string[]): string | null => {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return null;
  };

  const command = pick(COMMAND_FIELDS);
  const target = pick(TARGET_FIELDS);
  const body = pick(BODY_FIELDS);
  const summary = pick(SUMMARY_FIELDS);
  // A command is the whole action, so it wins and the JSON is not worth showing
  // beside it. A target alone is not — "notes.txt" does not say what is being
  // done to it — so the arguments stay available underneath.
  if (command !== null) return { ...NOTHING, command, target, summary };
  // A body is the whole action too, for the same reason: the JSON beside it is
  // the identical bytes with the newlines escaped.
  if (body !== null) return { ...NOTHING, target, body, summary };

  let pretty: string | null;
  try {
    pretty = JSON.stringify(rawInput, null, 2);
  } catch {
    // A value with a throwing `toJSON`, or a cycle. Nothing to show beats an
    // exception thrown while rendering a transcript.
    pretty = null;
  }
  return { ...NOTHING, target, summary, pretty };
}

/** `path` or `path:line`, in the one format the whole client uses. */
export function formatLocation(location: { path: string; line: number | null }): string {
  return location.line === null ? location.path : `${location.path}:${location.line}`;
}

/**
 * Whether these arguments are worth anything to a reader.
 *
 * Defined as "`readInput` found something" rather than as its own emptiness test,
 * so the question "is there anything here" has exactly one answer in this client.
 * A second rule that disagreed would show a chevron on a row with nothing behind
 * it, or hide one that had something.
 *
 * The case this exists for is measured: claude's `tool_call` arrives with
 * `rawInput: {}` and the real arguments turn up on a later `tool_call_update`, so
 * a plain null check picks the empty one and never looks again.
 */
export function hasInput(rawInput: unknown): boolean {
  const found = readInput(rawInput);
  return found.command !== null || found.target !== null || found.pretty !== null || found.truncated;
}

/**
 * The one line at the top of the card, and it has to ask what is being asked.
 *
 * `pending.title` alone does not. It is `Bash`, or `Write` — the tool's name,
 * which is a category and not a request. So the card read "Bash" over two boxes
 * of monospace, where the reference this is modelled on reads *"Allow Claude to
 * run Run analogy, odd-one-out and neighbours demos?"* and then shows the command
 * once.
 *
 * **Everything in that sentence comes from somewhere real.** The name is the
 * agent's own id. The verb is ACP's `ToolKind`, a closed enum whose whole purpose
 * is to say what class of thing a call is — rendering `execute` as "run" is the
 * same act as `labelFor` rendering a config category, and it is the only invented
 * word here. The object is the agent's own `description` when it sent one, else
 * the path it named. Nothing is guessed from a title or an id.
 *
 * When there is no verb — an unknown `kind`, or a tool call the transcript has
 * not loaded — it falls back to the tool's name plus what it is acting on, which
 * is what this function did before and is still better than the bare name.
 */

/** ACP's own `ToolKind`, as the word a sentence can be built from. */
const VERBS: Partial<Record<NonNullable<PermissionContext["kind"]>, string>> = {
  execute: "run",
  edit: "edit",
  read: "read",
  delete: "delete",
  move: "move",
  search: "search",
  fetch: "fetch",
};

/**
 * The last segment of a filesystem path, for a heading that has to fit on a line.
 *
 * `Allow Claude to write permission-test.txt?` reads; `Allow Claude to write
 * /Users/dev/projects/some long folder name/permission-test.txt?` wraps to two
 * lines and buries the verb. The whole path is not lost — it is the box directly
 * underneath, which is the reference's own arrangement and the reason the two are
 * different strings rather than one repeated.
 *
 * Only for something that looks like a path and is not a URL: taking the last
 * segment of `https://example.com/a/b` throws the host away, which is the part
 * that says where the request is going.
 */
function shortTarget(target: string | null): string | null {
  if (target === null || target.includes("://") || !target.includes("/")) return target;
  const last = target.slice(target.lastIndexOf("/") + 1);
  return last.length > 0 ? last : target;
}

export function permissionHeadline(
  agent: string,
  title: string,
  context: PermissionContext,
): string {
  const target = context.target;
  const named = target === null || target.length === 0 || title.includes(target) ? title : `${title} ${target}`;

  /*
   * The kind rides the `tool_call`, so it is missing exactly when the transcript
   * has not loaded. `command` and `body` are the same fact arriving another way,
   * and they are what the request itself carries — so an approval keeps its verb
   * even before its history does.
   */
  const kind = context.kind === null ? null : VERBS[context.kind];
  const verb = kind ?? (context.command !== null ? "run" : context.body !== null ? "write" : null);
  if (verb === null) return named;
  /*
   * ACP has one `edit` for both, and they are not the same act to a person:
   * replacing a whole file is *writing* it, patching part of one is *editing* it.
   * The payload already tells them apart — a `body` is the whole file, a `diff` is
   * a hunk — so the distinction costs nothing and is the word the reference uses.
   */
  const said = verb === "edit" && context.body !== null && context.diffs.length === 0 ? "write" : verb;

  const who = agent.length === 0 ? agent : agent[0]!.toUpperCase() + agent.slice(1);
  const object = context.summary ?? shortTarget(target);
  if (object !== null && object.length > 0) return `Allow ${who} to ${said} ${object}?`;
  // No object, so the noun is generic — and only where a generic one is honest.
  // "Allow Kimi to run this command?" says the whole truth; "Allow Kimi to
  // search this?" says less than the tool's own name does.
  if (said === "run") return `Allow ${who} to run this command?`;
  return named;
}


/**
 * Where each answer button goes, and which one is the default.
 *
 * **This reorders the agent's options, and that reverses a documented rule.** The
 * old one said the order is the agent's and is never touched, because deciding
 * which answer sits nearest the thumb would be this client putting an opinion in
 * front of a safety decision. That was right for a stacked list, where position
 * carries almost nothing and every row looks alike. It is wrong for a row of
 * buttons, where position is the loudest thing on the card: in the agent's own
 * order — approve, approve-always, reject — the refusal lands under the thumb and
 * the two approvals sit a thumb-width from it.
 *
 * So: **refusals to the left, approvals to the right, and the reversible approval
 * last.** Deny is separated from the primary by the width of the card, which is
 * what every confirmation dialog has converged on. The numbers follow what is
 * drawn, left to right, because a number that does not match the position it
 * labels is worse than no number.
 *
 * `allow_once` is the primary rather than `allow_always` for the reason the two
 * were separated in the first place: only one of them is reversible.
 */
export interface PermissionButtons {
  /** In display order. `optionShortcut` indexes into exactly this. */
  order: PermissionOptionSummary[];
  /** How many of `order` sit on the left, before the gap. */
  leading: number;
  /** The one filled button, or `null` when the agent offered nothing to approve. */
  primaryId: string | null;
}

/**
 * What a decision button says, when ACP's own enum says it better.
 *
 * kimi words `allow_always` as "Approve for this session" and claude words it as
 * "Always Allow Read(//tmp/x/**)". One concept, two vocabularies, neither
 * portable — which is `labelFor`'s situation exactly, one level down: the *kind*
 * is the thing ACP defines, and it is already deciding this button's position and
 * its fill, so it may as well decide its word.
 *
 * **But only when every kind in the request appears once, and that condition is
 * measured rather than cautious.** claude's plan-mode request offers *three*
 * `allow_always` options — "Yes, and bypass permissions", "Yes, and use auto
 * mode", "Yes, and auto-accept edits" — and the kind is identical for all three,
 * so the name is the only thing telling them apart. Renaming there would draw
 * three identical buttons for three different permanent grants. All-or-nothing
 * per request, so a row is never half the agent's words and half ours.
 *
 * What this costs is written down rather than waved away, and the honest version
 * is narrower than the one that stood here: claude's scoped `Always Allow
 * Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)` keeps its own wording,
 * because the containment test below sees that the name already says "Always
 * Allow" and therefore carries something extra. It is only a name that says
 * *nothing* the kind does not — kimi's "Approve for this session" — that is
 * replaced, and nothing is lost when it is. An earlier draft of this paragraph
 * claimed the globs survived "in `requestDigest` under `details`"; that function
 * was deleted and the sentence outlived it, which is precisely the failure this
 * file spends its comments guarding against.
 */
const KIND_WORDS: Partial<Record<PermissionOptionSummary["kind"], string>> = {
  allow_once: "Allow once",
  allow_always: "Always allow",
  reject_once: "Deny",
  reject_always: "Never allow",
};

export function optionLabel(
  options: readonly PermissionOptionSummary[],
  option: PermissionOptionSummary,
): string {
  const counts = new Map<string, number>();
  for (const entry of options) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  if (options.some((entry) => (counts.get(entry.kind) ?? 0) > 1)) return option.name;
  const word = KIND_WORDS[option.kind];
  if (word === undefined) return option.name;
  /*
   * **The agent's name already says what the kind says, so the rest of it is
   * extra and must be kept.** Measured: claude words a scoped grant as
   * `Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)`, and
   * replacing that with "Always allow" turns a *path-scoped* standing approval
   * into an unconditional-looking one — the globs are the only thing saying what
   * you are permanently granting. kimi's "Approve for this session" contains no
   * such thing and is a paraphrase of the kind, so it is replaced.
   *
   * Containment on our own word rather than a match against the agent's
   * vocabulary — the same shape as the prose filter that drops a sentence
   * repeating the command.
   */
  return option.name.toLowerCase().includes(word.toLowerCase()) ? option.name : word;
}

/**
 * The longest label that still reads as a *button*.
 *
 * Set from the real ones rather than picked: the longest any agent sends for an
 * ordinary decision is claude's "Yes, and don't ask again" and kimi's "Approve for
 * this session", both 24. What blows past it is a scoped grant, whose label
 * contains the thing being scoped — codex's "Allow Commands Starting With `node
 * /Users/…/fetch-codex-manual.mjs`" is 90-odd characters and unbounded, because it
 * embeds a path.
 */
const BUTTON_LABEL_MAX = 32;

/**
 * The options the card will actually draw.
 *
 * **This removes a choice the agent offered, which is why the rule is narrow in
 * three separate directions.**
 *
 * The card draws decisions as a row of buttons, and that row carries its meaning
 * by *position* — the refusal alone on the left, the reversible approval filled on
 * the right — because the colour these buttons used to have was removed. A label
 * that cannot fit a button breaks the row, and a broken row does not merely look
 * untidy: it puts the buttons in an arrangement where the left/right rule says
 * nothing while still looking deliberate. Measured against codex, which words a
 * scoped grant as "Allow Commands Starting With `node /Users/…/fetch-codex-manual
 * .mjs`" — a label containing a path, and therefore unbounded by construction.
 *
 * The four narrowings:
 *
 *   - **By length, never by id.** Nothing here knows `accept_execpolicy_amendment`
 *     or any other agent's vocabulary. Recognising an option by its id or its
 *     wording is the guessing this codebase refuses everywhere, and it would break
 *     on the next agent to word one differently. What is measured is the property
 *     that actually breaks the layout.
 *   - **Approvals only.** A refusal is never dropped, whatever it is called. That
 *     is the one option whose absence could be read as "there was no way to say
 *     no".
 *   - **Decisions only.** More than one `allow_once` means these are *answers to a
 *     question*, not scopes of one approval — the same structural test
 *     `askedQuestion` makes, reused rather than invented. That matters because a
 *     question reaches this function at all: kimi's `AskUserQuestion` arrives down
 *     the permission channel, and when its `rawInput` is truncated or the
 *     transcript has not paged in yet, `askedQuestion` answers null and the card
 *     falls back to buttons. Filtering there deletes the *model's own answers* —
 *     measured, two of four, each one a sentence and none of them a scope of
 *     another. There is also nothing to preserve by dropping: answers carry no
 *     left/right meaning, which is the whole thing this function protects.
 *   - **Never a scope's only representative.** An over-long approval is dropped
 *     only when another option of the *same kind* survives it. That is the case
 *     this exists for — codex sends two `allow_always` and the wide one goes —
 *     and it is the only case where dropping loses nothing a person can still
 *     reach. Written as "drop everything that does not fit", it also took
 *     claude's path-scoped `Always Allow Read(//tmp/svgout/**), …`, which is 64
 *     characters and the *only* `allow_always` on that card: a standing grant
 *     that became unreachable from a phone, on the one request where the scope is
 *     the thing being decided. Symmetrically, an agent wording `allow_once` long
 *     enough would have left the permanent grant as the filled primary button,
 *     which is the opposite of what that button promises.
 *
 * What is lost when it fires: the *broadest* grant on offer — a standing policy
 * rule written to the agent's disk, outliving the session — and only ever while a
 * narrower grant of the same kind is still on the card. The wide one remains
 * available where it is legible, in the agent's own terminal.
 */
export function drawableOptions(
  options: readonly PermissionOptionSummary[],
): readonly PermissionOptionSummary[] {
  // Answers, not scopes. See the third narrowing above.
  if (options.filter((option) => option.kind === "allow_once").length > 1) return options;
  const fits = (option: PermissionOptionSummary): boolean =>
    optionLabel(options, option).length <= BUTTON_LABEL_MAX;
  const kept = new Set(options.map((option) => option.optionId));
  for (const option of options) {
    if (option.kind.startsWith("reject") || fits(option)) continue;
    // Dropped only if somebody can still choose this scope. `kept` rather than
    // `options` so two over-long siblings cannot each justify the other's
    // removal and take the kind with them.
    const survivor = options.some(
      (other) => other.kind === option.kind && other.optionId !== option.optionId && fits(other) && kept.has(other.optionId),
    );
    if (survivor) kept.delete(option.optionId);
  }
  return kept.size === options.length ? options : options.filter((option) => kept.has(option.optionId));
}

export function permissionButtons(options: readonly PermissionOptionSummary[]): PermissionButtons {
  const drawable = drawableOptions(options);
  const refusals = drawable.filter((option) => option.kind.startsWith("reject"));
  const rest = drawable.filter((option) => !option.kind.startsWith("reject"));
  // Stable inside each group, so an unknown kind keeps the place the agent gave
  // it — only `allow_once` is deliberately moved, and only to the end.
  const approvals = [
    ...rest.filter((option) => option.kind !== "allow_once"),
    ...rest.filter((option) => option.kind === "allow_once"),
  ];
  return {
    order: [...refusals, ...approvals],
    leading: refusals.length,
    primaryId: approvals.at(-1)?.optionId ?? null,
  };
}

/**
 * Whether `details` has anything to reveal, and therefore whether to draw it.
 *
 * **The rule has been wrong in three directions and this is the fourth answer.**
 * It began as `hasMoreDetail`, a general "is anything clipped", which hid the
 * control for a request the card could not explain at all. Then it was
 * unconditional, which put a disclosure under every one-line `Bash` promising
 * bookkeeping. Then it kept an `unavailable` arm so that expanding could at least
 * print the request's own ids — and that content is gone, because it was the
 * kind of thing only the person who wrote it wants to read.
 *
 * What is left is the reason a disclosure exists here at all: **something
 * substantial is being withheld**, and it is exactly the four things
 * {@link detailContext} carries. A file about to be written and a diff about to
 * be applied are what somebody may not be ready to read. A command is one line,
 * it is the decision, and it is on screen.
 */
export function withheldDetail(context: PermissionContext): boolean {
  if (context.unavailable) return false;
  return (
    context.body !== null ||
    context.diffs.length > 0 ||
    context.rawInput !== null ||
    context.locations.length > 0
  );
}

/**
 * What the card shows before anybody presses anything.
 *
 * **Nothing is clipped here any more.** It used to trim prose and a command to
 * three lines, which then had to be un-trimmed on expand — so the same text lived
 * in both halves of the disclosure and the button had to sit *underneath* what it
 * revealed. Every box these land in is already a `max-h-40 overflow-auto` `<pre>`,
 * so the height was bounded by CSS the whole time and the clip only bought a
 * duplicate.
 *
 * With no overlap the two halves are a partition: this is what is always on
 * screen, {@link detailContext} is what expanding adds, and the control can sit
 * between them where a disclosure belongs.
 */
export function essentialContext(context: PermissionContext): PermissionContext {
  if (context.unavailable) return context;
  return {
    ...context,
    /*
     * **The file, the diff and the arguments go behind `details`; a command does
     * not.** They are not the same kind of thing even though both are "what the
     * tool is about to do". A command is one line and *is* the decision — hiding
     * it would mean approving a shell line you have to press something to read. A
     * file is two hundred lines whose first twelve are a docstring and a blank.
     */
    body: null,
    diffs: [],
    rawInput: null,
    locations: [],
  };
}

/**
 * What pressing `details` adds, and nothing that was already on screen.
 *
 * The complement of {@link essentialContext}, so the two never draw the same
 * thing twice and the button can be rendered between them.
 */
export function detailContext(context: PermissionContext): PermissionContext {
  return { ...context, text: [], command: null, summary: null, target: null };
}


export function isTruncationMarker(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record["truncated"] === true && typeof record["bytes"] === "number";
}

/*
 * `lineDiff` and its `DiffHunk` were here, and are now `diffLines` in `diff.ts`.
 *
 * They were a common prefix/suffix trim with one hunk — exact for a fragment,
 * which is what claude and kimi send, and wrong for codex, which sends whole files
 * on both sides: any edit with two changed regions shares its beginning and end
 * with the original, so trimming alone reported "the whole middle was replaced".
 * The replacement keeps the trim and puts a bounded LCS behind it.
 *
 * It moved rather than being copied because the transcript needed the same answer,
 * and two functions for "what changed" is a second place for the next rule about
 * it to be forgotten. This file keeps `readContentBlocks`, which is what turns an
 * ACP `diff` block into a `FileChangeEvent` in the first place, and everything else
 * about *reading* a permission; drawing one is `ui/DiffView.tsx`.
 */

/**
 * A permission whose options are answers, and the question they answer.
 *
 * **One question, two channels, and which channel is per agent.** claude and codex
 * declare `elicitation.form`, so their `AskUserQuestion` arrives as an ACP
 * elicitation with a schema. kimi does not, so its `AskUserQuestion` arrives as a
 * `session/request_permission` — measured, and the whole question is in there:
 * the tool call's `rawInput` carries the wording and every option's description,
 * and the permission's options carry the same labels back as `optionId`s.
 *
 * Without this the client threw all of it away: the card was titled with the
 * *tool name*, the question was rendered as a wall of JSON in a `<pre>`, and four
 * answers were drawn as four identical green Approve buttons. Same question, two
 * completely different screens, which is the thing this whole surface is supposed
 * not to do.
 *
 * **The gate is the protocol, not a string.** `PermissionOptionKind` is a closed
 * four-value enum and every member is a decision *about one tool call* — allow it
 * once, allow it always, reject it once, reject it always. Two options that both
 * say `allow_once` are therefore indistinguishable *as permissions*: the kind is
 * carrying no information that separates them, so the **name** must be, and a set
 * of alternatives distinguished only by name is a choice rather than an approval.
 * Measured against every permission this daemon has ever recorded: each real
 * approval offers exactly one `allow_once`, and each question offers four.
 *
 * That is emphatically **not** matching the title `AskUserQuestion`, nor the
 * `q0_opt_*` ids, nor "all `allow_once` bar one" — those are agent-chosen strings
 * and the first agent that words them differently breaks. This reads the enum.
 *
 * The second gate is a **shape**, and it is the tool's own rather than one
 * vendor's: `{questions: [{question, options: [{label, description}]}]}` is what
 * `AskUserQuestion` takes on claude and kimi. Nothing is assumed about where in that
 * array the question is — the one whose labels match the offered options *by
 * identity* is the one, which is also what validates the match.
 *
 * Every failure falls back to `null`, and `null` renders exactly what this card
 * rendered before: a title, a `<pre>` and coloured buttons. A truncated
 * `rawInput` fails the shape check and lands there, which is correct — an 8 KiB
 * stand-in is not a question.
 */
export interface AskedQuestion {
  question: string;
  answers: { optionId: string; label: string; description: string | null }[];
  /**
   * The one option that is not an answer. kimi calls it `Skip`, and the word is
   * the agent's own — this only says which option it is.
   */
  skip: { optionId: string; name: string } | null;
}

export function askedQuestion(
  pending: PendingPermissionSnapshot,
  events: readonly StoredEvent[],
  context: PermissionContext,
): AskedQuestion | null {
  /*
   * **A request that authorizes a concrete action is not a question, whatever it
   * says about itself — and this gate is the difference between a nicer card and
   * a way to lie with one.**
   *
   * Without it: an agent sends a `session/request_permission` whose options are
   * four innocuous `allow_once` names and whose tool input happens to carry a
   * `questions` array, and the card titles itself "Which colour?", draws the four
   * as neutral answers, and — because a question needs no context — **hides the
   * command it is authorizing**. Tapping an answer sends that option's id, which
   * is an approval, and the tool runs. The card's entire reason for existing is
   * that the person sees what they are agreeing to.
   *
   * The half of the gate above reads ACP's own option-kind enum, which the agent
   * cannot lie about usefully. The half here reads what the request is *doing*:
   * a command, a file body, a diff or a set of locations means there is something
   * to authorize, and something to authorize is never a question. Both halves are
   * structural; neither matches a string the agent chose.
   *
   * The card no longer blanket-suppresses its context either — that is the second
   * half of the same fix, and it is what makes a mis-classification survivable
   * rather than silent.
   */
  if (
    context.command !== null ||
    context.body !== null ||
    context.diffs.length > 0 ||
    context.locations.length > 0
  ) {
    return null;
  }

  const offered = pending.options.filter((option) => option.kind === "allow_once");
  if (offered.length < 2) return null;

  // Anything else the agent offered. Exactly one is the skip; more than one and
  // this is a shape nobody has measured, so it goes back to being an approval.
  const rest = pending.options.filter((option) => option.kind !== "allow_once");
  if (rest.length > 1) return null;

  const questions = readQuestions(pending.rawInput ?? inputFor(pending.toolCallId, events));
  if (questions === null) return null;

  for (const question of questions) {
    const byLabel = new Map(question.options.map((option) => [option.label, option]));
    const answers: AskedQuestion["answers"] = [];
    for (const option of offered) {
      const match = byLabel.get(option.name);
      // By identity, and one miss abandons the whole question rather than
      // drawing a partial one: an answer we could not match is an answer whose
      // description would go on the wrong row.
      if (match === undefined) break;
      answers.push({ optionId: option.optionId, label: match.label, description: match.description });
    }
    if (answers.length !== offered.length) continue;
    const skip = rest[0];
    return {
      question: question.question,
      answers,
      skip: skip === undefined ? null : { optionId: skip.optionId, name: skip.name },
    };
  }
  return null;
}

/** The `AskUserQuestion` tool's input, validated as a shape and never by key name. */
function readQuestions(
  input: unknown,
): { question: string; options: { label: string; description: string | null }[] }[] | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const raw = (input as Record<string, unknown>)["questions"];
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const out: { question: string; options: { label: string; description: string | null }[] }[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const question = record["question"];
    const options = record["options"];
    if (typeof question !== "string" || question.length === 0) return null;
    if (!Array.isArray(options) || options.length === 0) return null;
    const parsed: { label: string; description: string | null }[] = [];
    for (const option of options) {
      if (typeof option !== "object" || option === null) return null;
      const shape = option as Record<string, unknown>;
      const label = shape["label"];
      if (typeof label !== "string") return null;
      const description = shape["description"];
      parsed.push({ label, description: typeof description === "string" ? description : null });
    }
    out.push({ question, options: parsed });
  }
  return out;
}

/**
 * The newest arguments this tool call has, from the call **or any of its updates**.
 *
 * The update arm is the whole of it, and skipping it is how this quietly returned
 * nothing. Measured against a real kimi question: the `tool_call` at seq 733 and
 * every one of the 195 updates after it carry `rawInput: null`, and the arguments
 * appear for the first and only time on the last update before the permission —
 * which is exactly the "one tool call is five events and every useful field is on
 * a different one" shape the gotchas table already describes. `permissionContext`
 * reads the call alone and is the same gap one function over; nothing depended on
 * it there because the request's own `rawInput` usually covers it, and here the
 * request's is `null`.
 */
function inputFor(toolCallId: string | null, events: readonly StoredEvent[]): unknown {
  if (toolCallId === null) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]?.event;
    if (event === undefined) continue;
    if (event.type !== "tool_call" && event.type !== "tool_call_update") continue;
    if (event.toolCallId !== toolCallId) continue;
    if (event.rawInput !== null && event.rawInput !== undefined) return event.rawInput;
  }
  return null;
}
