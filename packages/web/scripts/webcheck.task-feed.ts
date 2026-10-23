import type { PendingElicitationSnapshot, PendingPermissionSnapshot, TaskCommentView, TaskEventView } from "../src/wire.js";
import { check, report } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";

const { authorName, deliveredText, feedOrder, historyOrder, openStop, questionShown } = await import("../src/feed.js");

// The task's page: its feed, where the agent asks and its person answers, and its history (the board's spec, stage 3).
process.stdout.write("\na task's page: the feed, the history, and what may be pressed\n");
{
  const comment = (id: string, patch: Partial<TaskCommentView> = {}): TaskCommentView => ({
    id,
    at: 1_000,
    kind: "comment",
    author: "you",
    text: id,
    sessionId: null,
    request: null,
    entry: 1,
    delivered: false,
    state: null,
    pending: null,
    ...patch,
  });
  const permission = (id: string): PendingPermissionSnapshot => ({
    permissionId: id,
    toolCallId: null,
    title: "Run tests",
    options: [],
    raisedAt: 5,
    rawInput: null,
    content: null,
  });
  const elicitation = (id: string): PendingElicitationSnapshot => ({ elicitationId: id, toolCallId: null, message: "Which?", fieldCount: 1, raisedAt: 5 });
  const asking = comment("q", {
    kind: "question",
    author: "s_1",
    sessionId: "s_1",
    request: { kind: "permission", id: "perm-1" },
    state: "open",
    pending: permission("perm-1"),
  });
  const kinds = (shown: ReturnType<typeof questionShown>): string => (shown.kind === "closed" ? "closed" : `${shown.kind}:${"permissionId" in shown.pending ? shown.pending.permissionId : shown.pending.elicitationId}`);
  check(
    "a question is a window on the request its session holds, read off the session row this client holds first, so an answer in the chat closes it here",
    [
      kinds(questionShown(asking, { pendingPermissions: [permission("perm-1")] })),
      kinds(questionShown(asking, { pendingPermissions: [] })),
      kinds(questionShown(asking, { pendingPermissions: [permission("perm-2")] })),
    ],
    ["permission:perm-1", "closed", "closed"],
  );
  check(
    "and only where no row is held does the feed's own reading stand, believed only for the request it names",
    [
      kinds(questionShown(asking, undefined)),
      kinds(questionShown({ ...asking, state: "closed" }, undefined)),
      kinds(questionShown({ ...asking, pending: permission("perm-9") }, undefined)),
      kinds(questionShown({ ...asking, pending: { not: "a request" } }, undefined)),
    ],
    ["permission:perm-1", "closed", "closed", "closed"],
  );
  const form = comment("f", { kind: "question", author: "s_1", sessionId: "s_1", request: { kind: "elicitation", id: "elic-1" }, state: "open", pending: elicitation("elic-1") });
  check(
    "a form is the same window, and anything that is not a question shows nothing to answer",
    [
      kinds(questionShown(form, { pendingPermissions: [], pendingElicitations: [elicitation("elic-1")] })),
      kinds(questionShown(form, { pendingPermissions: [] })),
      kinds(questionShown(form, undefined)),
      kinds(questionShown(comment("c"), { pendingPermissions: [permission("perm-1")] })),
    ],
    ["elicitation:elic-1", "closed", "elicitation:elic-1", "closed"],
  );

  const feed = [comment("b", { at: 3 }), comment("a", { at: 1 }), comment("c", { at: 3 })];
  check("the feed reads as a conversation, oldest first, a tie in the daemon's order", feedOrder(feed).map((one) => one.id), ["a", "b", "c"]);
  const event = (seq: number, at: number): TaskEventView => ({
    seq,
    at,
    kind: "moved",
    entry: 1,
    revision: 0,
    text: `e${seq}`,
    column: null,
    to: null,
    exit: null,
    by: null,
    confidence: null,
    executor: null,
    session: null,
  });
  check("the history newest first, as the page's activity always read", historyOrder([event(1, 1), event(3, 5), event(2, 5)]).map((one) => one.seq), [3, 2, 1]);

  const stop = comment("s", { kind: "stop", author: "s_1", at: 5 });
  check(
    "a stop takes a reply while the task needs its person and nobody has written since; the reply is an ordinary comment",
    [
      openStop([comment("a", { at: 1 }), stop], "needs_you")?.id ?? null,
      openStop([stop, comment("r", { at: 6 })], "needs_you"),
      openStop([stop], "working"),
      openStop([stop, comment("rep", { kind: "report", author: "s_1", at: 7 })], "needs_you")?.id ?? null,
      openStop([comment("a")], "needs_you"),
    ],
    ["s", null, null, "s", null],
  );
  const sessions = [{ id: "s_1", nickname: "mira" }];
  check(
    "an entry names its person, a conversation of the task by its nickname, and one it no longer holds as such",
    [authorName("you", sessions), authorName("s_1", sessions), authorName("s_gone", sessions)],
    ["You", "@mira", "An earlier conversation"],
  );
  check(
    "a person's comment says where it went: into the conversation at work, or the next run's note",
    [deliveredText(comment("a", { delivered: true })), deliveredText(comment("a")), deliveredText(stop), deliveredText(comment("r", { kind: "report" }))],
    ["sent to the agent", "for the next run", null, null],
  );

  const feedSrc = stripComments(srcFile("ui/board/Feed.tsx"));
  check(
    "the question is the conversation's own card, in flow, on the same request and routes, and its record is the live session row's",
    [
      /<PermissionCard\s+inline\s+sessionRef=\{ref\}\s+pending=\{shown\.pending\}/.test(feedSrc),
      /<ElicitationCard inline sessionRef=\{ref\} pending=\{shown\.pending\}/.test(feedSrc),
      /const shown = questionShown\(comment, row\?\.snapshot\);/.test(feedSrc),
      /events=\{state\.transcripts\.get\(keyOf\(ref\)\)\?\.events \?\? \[\]\}/.test(feedSrc),
    ],
    [true, true, true, true],
  );
  check(
    "it is read while the page is open, at the board's watching pace and never while hidden, again on each change of the task, and an older daemon's 404 draws nothing",
    [
      /timer = window\.setTimeout\(ask, BOARD_WATCH_MS\);/.test(feedSrc),
      /document\.hidden/.test(feedSrc),
      /\[entry\.machineId, entry\.task\.id, entry\.task\.updatedAt, nonce\]/.test(feedSrc),
      /if \(meansRouteAbsent\(cause\)\) \{\s*setRead\(\{ kind: "absent" \}\);/.test(feedSrc),
      /if \(read\.kind === "absent"\) return null;/.test(feedSrc),
    ],
    [true, true, true, true, true],
  );
  check(
    "a reply and a comment are one route, sent as typed, and only an agent's stop is drawn as an agent's words are",
    [
      /void uploadPicked\(entry\.machineId, attached\.files, attached\.progress\)\s*\.then\(\(ids\) => addComment\(entry, body, ids\)\)/.test(feedSrc),
      /\{\.\.\.VERBATIM_FIELD\}/.test(feedSrc),
      /comment\.kind === "stop" \? \(\s*<div className="text-sm select-text">\s*<Markdown text=\{comment\.text\} \/>/.test(feedSrc),
      (feedSrc.match(/<Markdown /g) ?? []).length,
    ],
    [true, true, true, 1],
  );
  check(
    "a comment may be files alone, and every comment draws the files it carries (Q3.744)",
    [
      /\(sentText\(text\)\.trim\(\)\.length > 0 \|\| attached\.files\.length > 0\) && !busy/.test(feedSrc),
      /<TaskFileList machineId=\{entry\.machineId\} taskId=\{entry\.task\.id\} files=\{files\} \/>/.test(feedSrc),
    ],
    [true, true],
  );

  const pageSrc = stripComments(srcFile("ui/board/TaskScreen.tsx"));
  check(
    "the comments come last on the page, out of any box, every one of them newest first under the one box; history and activity fold, closed (the owner, 2026-10-15)",
    [
      /const comments = read\.kind === "known" \? feedOrder\(read\.feed\.comments\)\.reverse\(\) : \[\];/.test(feedSrc),
      /COMMENTS_SHOWN|earlier comment/.test(feedSrc),
      feedSrc.indexOf("<CommentBox") < feedSrc.indexOf("{comments.map("),
      /<TaskBlock title="History" count=\{history\.length\}>/.test(feedSrc),
      /<TaskBlock title="Activity" count=\{sessions\.length \+ 1\}>/.test(pageSrc),
      /const \[open, setOpen\] = useState\(false\);/.test(feedSrc),
      /<FeedHistory read=\{feed\.read\} \/>\s*<Activity entry=\{entry\} state=\{state\} \/>\s*<FeedComments /.test(pageSrc),
    ],
    [true, false, true, true, true, true, true],
  );
  check(
    "no Mark done; Delete is the lone destructive row under the properties, its box as wide as its button (Q3.738)",
    [/Mark done/.test(pageSrc), /<Group fit>\s*<TwoStep[\s\S]{0,700}?rest=\{<DangerRow label="Delete task" icon=\{Trash2\} whole/.test(pageSrc)],
    [false, true],
  );
  check("the latest report is no block of its own: the feed carries every report", /function Report\b|<Report /.test(stripComments(srcFile("ui/board/TaskScreen.tsx"))), false);

  process.stdout.write("  the page around it\n");
  const screen = stripComments(srcFile("ui/board/TaskScreen.tsx"));
  report("the task's page was found", screen.length > 1000, `${screen.length} chars`);
  check(
    "a task opens as its own page, laid out as a tracker's ticket: column, assignee and project beside what was asked (Q3.725)",
    [
      /variant="row"\s*title="Column"/.test(screen),
      /shape=\{\{ variant: "row", title: "Assignee",/.test(screen),
      /shape=\{\{ variant: "row", title: "Project" \}\}/.test(screen),
      /<FeedComments read=\{feed\.read\} reload=\{feed\.reload\} entry=\{entry\} state=\{state\} \/>/.test(screen),
    ],
    [true, true, true, true],
  );
  check(
    "its columns are the drawn board's, and a configured task is moved by its daemon, from the column it was seen in",
    [
      /items=\{flowColumns\(drawn\)\.map\(/.test(screen),
      /if \(entry\.configured\) move\("column", \{ to: column \}\);\s*else moveLegacy\(column\);/.test(screen),
      /await moveTo\(entry, target, stop\);/.test(screen),
    ],
    [true, true, true],
  );
  check(
    "a move refused while the agent works is offered again as Stop and move, and one that moved meanwhile says so",
    [
      /if \(refusedWhileWorking\(cause\)\) \{\s*setRefused\(/.test(screen),
      /act=\{\{ label: "Stop and move" \}\}/.test(screen),
      /move\("exit" in target \? "exit" : "column", target, true\);/.test(screen),
      /if \(movedMeanwhile\(cause\)\) \{\s*toast\(/.test(screen),
    ],
    [true, true, true, true],
  );
  check(
    "the exits are buttons, a failed run is retried by entering its column again, and the phase and the daemon's reason are said in place",
    [
      /exits\.map\(\(exit\) => \(\s*<Button key=\{exit\.name\}[^>]*onClick=\{\(\) => move\("exit", \{ exit: exit\.name, to: exit\.to \}\)\}/.test(screen),
      /onClick=\{\(\) => move\("column", \{ to: entry\.column \}\)\}>\s*Retry/.test(screen),
      /\{PHASE_LABEL\[entry\.phase\]\}/.test(screen),
      /task\.reason/.test(screen),
    ],
    [true, true, true, true],
  );
  check(
    "an older daemon's task keeps its old path: its status, and a start of the agent it holds into a column that works",
    /status === "running" \? openStarted\(await startHere\(entry, column\), where\) : setTaskStatus\(entry, status\)/.test(screen),
    true,
  );
  check(
    "who does it is nobody, its person, or a machine and an agent in one choice, and a task with a conversation stays on its machine",
    [/only=\{started \? entry\.machineId : null\}/.test(screen), /onChange=\{reassign\}\s*nobody\s*you/.test(screen)],
    [true, true],
  );
  check(
    "in the intake Start is its own, and while an agent works no control hands the task to anybody else (Q3.732, Q3.736)",
    [/const landed = await assignTask\(entry, next, cwd\);/.test(screen), /disabled=\{still \|\| working\}/.test(screen), /\{intake && holder\.kind === "agent" && !working && \(/.test(screen)],
    [true, true, true],
  );
  check(
    "a start pressed on the page opens the conversation it made, unless its person went elsewhere meanwhile (Q3.737)",
    /if \(landed\.session !== null\) openStarted\(landed\.session, where\);/.test(screen),
    true,
  );
  check(
    "every task's page leads back to the board from its top left, and to the conversation it was opened from instead, at every width (Q3.734, Q3.736)",
    [
      /<Header title=\{<span className="sr-only">Task<\/span>\} close board back=\{back\} \/>/.test(screen),
      /const back = origin !== null && screenAt\(origin\) === "session" \? \{ to: origin, label: "Back to the conversation" \} : null;/.test(screen),
      /function Crumbs/.test(screen),
    ],
    [true, true, false],
  );
  check(
    "a task its machine gave to another opens there, in this page's place",
    [/const movedTo = entry === null \? followTombstone\(held, machineId, taskId\) : null;/.test(screen), /navigate\(taskPath\(movedTo, taskId\), true\);/.test(screen)],
    [true, true],
  );
}
