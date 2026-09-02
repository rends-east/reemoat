import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { snapshot } from "./webcheck.ws.js";
import {
  changeCounts,
  chipParts,
  chipReserve,
  chipValue,
  choiceLabel,
  diffLines,
  drawnChoices,
  formatLocation,
  hasInput,
  isTerminal,
  labelFor,
  readInput,
  sessionLists,
  showsCaption,
  slotFor,
  splitOptions,
  withChoice,
} from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * The diff a person is about to approve
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe diff, before and after the fact\n");
{
  /*
   * `diffLines` is drawn twice over: above the Allow button when a permission
   * carries an edit, and inside a transcript row once the edit has happened. It
   * replaced `lineDiff`, which served only the first — and the reason it had to is
   * in the third case below.
   *
   * Getting it wrong does not throw and does not look broken: it draws a plausible
   * diff of the wrong lines, under a button that then executes the real edit.
   *
   * What the input *is* differs per agent, which is why these cases look unrelated.
   * claude's `Edit` sends the model's `old_string`/`new_string`, a fragment with no
   * context. codex sends whole files on both sides, for add, update and delete
   * alike. kimi sends a fragment and then the whole file again through a second
   * channel.
   */
  const shape = (diff: { hunks: readonly { lines: readonly { kind: string; text: string }[] }[] }): string[][] =>
    diff.hunks.map((hunk) =>
      hunk.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`),
    );

  const created = diffLines(null, "first\nsecond");
  check("a created file is all additions", [created.added, created.removed], [2, 0]);
  check("drawn as one hunk", shape(created), [["+first", "+second"]]);
  check("numbered on the new side alone", created.hunks[0]?.lines.map((l) => [l.oldNo, l.newNo]), [
    [null, 1],
    [null, 2],
  ]);
  // `wholeFile` is a claim about a *replacement*, and there was no old file here —
  // drawing "the whole file changed" over a file that did not exist would be a
  // warning about something that cannot happen.
  check("and is not a whole-file replacement", created.wholeFile, false);

  const edited = diffLines("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
  check("a one-line edit is one line either side", [edited.added, edited.removed], [1, 1]);
  check("with the lines either side of it for context", shape(edited), [
    [" a", " b", "-c", "+X", " d", " e"],
  ]);
  check("numbered in both files", edited.hunks[0]?.lines.map((l) => [l.oldNo, l.newNo]), [
    [1, 1],
    [2, 2],
    [3, null],
    [null, 3],
    [4, 4],
    [5, 5],
  ]);
  check("and it is not a whole-file replacement either", edited.wholeFile, false);

  /*
   * **The case the trim-only version could not answer, and the reason it was
   * replaced.** codex reports an edit as the whole file on both sides, so two
   * changed regions share the file's beginning, its end *and* everything between
   * them — a common prefix and suffix alone therefore report the entire middle as
   * rewritten, which for a two-character change in a 200-line file is a diff nobody
   * can read. The LCS behind the trim is what splits it into two hunks with the
   * untouched lines dropped.
   */
  const twice = diffLines(
    "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14",
    "1\n2\nX\n4\n5\n6\n7\n8\n9\n10\n11\nY\n13\n14",
  );
  check("two changed regions are two hunks", shape(twice), [
    [" 1", " 2", "-3", "+X", " 4", " 5"],
    [" 10", " 11", "-12", "+Y", " 13", " 14"],
  ]);
  check("counted across both", [twice.added, twice.removed], [2, 2]);
  check("and the eight untouched lines between them are not drawn", twice.wholeFile, false);

  // Reachable: `file_change` arrives twice for one kimi edit, and a re-write of
  // identical content is a real thing an agent does. No hunk at all is the honest
  // rendering; inventing one line of each would be a lie about what was approved.
  const same = diffLines("a\nb", "a\nb");
  check("identical text has nothing to draw", [same.hunks.length, same.added, same.removed], [0, 0, 0]);

  const replaced = diffLines("a\nb", "x\ny");
  check("nothing lining up is a whole-file replacement", replaced.wholeFile, true);
  check("and every line is shown on both sides", shape(replaced), [["-a", "-b", "+x", "+y"]]);

  /*
   * A deleted file is `newText: ""` — measured, that is what codex sends — and `""`
   * has to be **no lines** rather than one empty one, or a delete reads as "N lines
   * replaced by one blank line": `+1` for an act that added nothing.
   */
  const deleted = diffLines("a\nb\nc", "");
  check("a deleted file adds nothing", [deleted.added, deleted.removed], [0, 3]);

  // A trailing newline terminates the last line rather than starting an empty one,
  // so appending a line is `+1 −0` and not `+2 −1`.
  const appended = diffLines("a\n", "a\nb\n");
  check("a trailing newline is not a line", [appended.added, appended.removed], [1, 0]);

  /*
   * The clip, which is the one thing here that must not silently shorten.
   *
   * A card on a phone cannot draw an 800-line hunk, and a body that just *stops* at
   * 60 lines reads as the whole change — which is the number a person is approving.
   * So the count above it stays true and `omitted` is what says the body is short.
   */
  const long = diffLines(null, Array.from({ length: 70 }, (_, i) => `line ${i}`).join("\n"));
  check("an over-long diff is clipped", long.hunks[0]?.lines.length, 60);
  check("and says how much it is not showing", long.omitted, 10);
  check("while the count stays the true one", [long.added, long.removed], [70, 0]);

  /*
   * The line numbers a fragment gets, which are the only ones available at all:
   * measured in the log, a claude `Edit`'s own `locations[0].line` is the hunk's
   * `newStart`, and the fragment carries nothing else.
   */
  const placed = diffLines("c", "X", 24);
  check("a fragment is numbered from where it sits", placed.hunks[0]?.lines.map((l) => l.newNo ?? l.oldNo), [24, 24]);

  /*
   * **The refusal, and it is the one that matters most.** A `file_change` over the
   * 128 KiB per-event cap has each side clipped to half of it, so both are cut at
   * the same offset and the common suffix is destroyed — a diff over them reports the
   * untouched tail of the file as rewritten. `unavailable` is how "cannot say" stops
   * being drawn as "nothing changed", and `changeCounts` answers `null` rather than
   * zero for the reason the worktree counts do: a caller writing `?? 0` would report
   * the largest edit in the log as an empty one.
   */
  const cut = diffLines("old…[truncated 40 bytes]", "new…[truncated 12 bytes]");
  check("a truncated event has no diff", [cut.unavailable, cut.hunks.length, cut.added], ["truncated", 0, 0]);
  check(
    "and no counts either",
    changeCounts({
      type: "file_change",
      path: "/w/a.ts",
      oldText: "old…[truncated 40 bytes]",
      newText: "new…[truncated 12 bytes]",
      source: "diff",
      toolCallId: null,
    } as never),
    null,
  );

  /*
   * The word-level marks, drawn only where a removal is **paired** with an addition.
   * An inserted line is not a modified one, so it carries no marks at all — marking
   * the whole of it would say the opposite of what happened.
   */
  const word = diffLines("const timeout = 30;", "const timeout = 90;");
  check(
    "a rewritten line marks only what changed inside it",
    word.hunks[0]?.lines.map((l) => l.marks),
    [
      [[16, 17]],
      [[16, 17]],
    ],
  );
  check("an inserted line is marked nowhere", created.hunks[0]?.lines.map((l) => l.marks), [null, null]);

  /*
   * The bound, and that crossing it **degrades rather than hangs** — which is the
   * failure mode that matters, since this runs inside a `useMemo` on a transcript
   * that rebuilds on every streamed token. 700 lines a side is 490 000 cells against
   * a budget of 250 000.
   */
  const wall = (salt: string): string => Array.from({ length: 700 }, (_, i) => `${salt} ${i}`).join("\n");
  const huge = diffLines(wall("a"), wall("b"));
  check("past the cell budget it is one replacement", [huge.wholeFile, huge.added, huge.removed], [true, 700, 700]);
  // And the ordinary large case stays cheap, because the trim runs first: two 2000
  // line files differing by one line never reach the table at all.
  const nearly = diffLines(wall("a"), wall("a").replace("a 400", "CHANGED"));
  check("while one changed line in a large file is still one hunk", [nearly.hunks.length, nearly.added], [1, 1]);

  /*
   * Memoised on the event, which is what makes it safe for `buildTail` to ask on
   * every token. The same object back is the observable form of that.
   */
  const event = {
    type: "file_change",
    path: "/w/a.ts",
    oldText: "a\nb",
    newText: "a\nB",
    source: "diff",
    toolCallId: null,
  } as never;
  check("counts are computed once per event", changeCounts(event) === changeCounts(event), true);
  check("and they are the right ones", changeCounts(event), { added: 1, removed: 1 });
}

process.stdout.write("\nwhere a tool call happened\n");
{
  // Two branches, one format, and neither was reached even indirectly: this driver
  // contained no occurrence of `locations` at all. A line number of `null` is the
  // common case (a tool naming a file, not a position in it), and rendering it as
  // `a.ts:null` is exactly the sort of thing that ships.
  check("a location with no line is just the path", formatLocation({ path: "a.ts", line: null }), "a.ts");
  check("and one with a line carries it", formatLocation({ path: "a.ts", line: 12 }), "a.ts:12");
}

/* ------------------------------------------------------------------ *
 * What a tool row says without being opened
 * ------------------------------------------------------------------ */

process.stdout.write("\ntool arguments\n");
{
  /*
   * `readInput` is the single guess at an undocumented shape, shared by the
   * permission card and the transcript. The reported symptom — "clicking a tool
   * shows just {}" — was this function's emptiness hole seen through the second
   * of those two.
   */
  for (const [name, value] of [
    ["an empty object", {}],
    ["an empty array", []],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["null", null],
    ["undefined", undefined],
  ] as const) {
    const got = readInput(value);
    check(`${name} yields no detail at all`, [got.command, got.target, got.pretty, got.truncated], [null, null, null, false]);
  }

  // A command reads as a command. Rendering `{"command": "ls -la"}` and calling it
  // an explanation is most of what made the old row useless.
  check("a command is lifted out of the JSON", readInput({ command: "ls -la" }).command, "ls -la");
  check("and the JSON is not shown beside it", readInput({ command: "ls -la" }).pretty, null);
  check("a bare string is a command", readInput("git status").command, "git status");
  check("trimmed", readInput("  git status  ").command, "git status");

  // The daemon's stand-in. Reporting this as "no arguments" would be a lie about a
  // command that exists and was cut for size.
  const cut = readInput({ truncated: true, bytes: 9000 });
  check("the truncation stand-in is reported as truncated", [cut.truncated, cut.command], [true, null]);

  // A non-empty object with nothing recognisable still shows its arguments.
  check("an unrecognised shape falls back to JSON", readInput({ depth: 3 }).pretty, '{\n  "depth": 3\n}');

  // Rendering a transcript must not be able to throw. A cycle is the easy way to
  // make `JSON.stringify` fail; a throwing `toJSON` is the other.
  const cyclic: Record<string, unknown> = { name: "x" };
  cyclic["self"] = cyclic;
  check("a cyclic value is no detail rather than an exception", readInput(cyclic).pretty, null);
  check("and a throwing toJSON is too", readInput({ toJSON() { throw new Error("no"); } }).pretty, null);

  /*
   * `hasInput` is what decides whether a *later* update's arguments replace the
   * call's own, and it is the reason the tool cards went blank.
   *
   * Measured 2026-07-31 against claude 0.63.0: a `tool_call` arrives with
   * `rawInput: {}` and the command turns up on a `tool_call_update` afterwards. An
   * empty object is not null, so `event.rawInput ?? update.rawInput` keeps the
   * empty one and the command is never shown at all. The rule has to be "is there
   * anything here", and it has to be the same rule the rendering uses — hence one
   * function rather than a second emptiness test.
   */
  check("an empty object has no input", hasInput({}), false);
  check("nor does null", hasInput(null), false);
  check("nor whitespace", hasInput("  "), false);
  check("a command does", hasInput({ command: "ls" }), true);
  check("a path does", hasInput({ file_path: "/a" }), true);
  check("and so does the truncation stand-in", hasInput({ truncated: true, bytes: 9000 }), true);
  // The whole point, stated as the comparison the render makes.
  report(
    "so a later update's arguments win over an empty call",
    !hasInput({}) && hasInput({ command: "echo hi" }),
    "tool_call {} → tool_call_update {command}",
  );
}

/* ------------------------------------------------------------------ *
 * The home screen's ordering
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe session lists\n");
{
  const row = (id: string, over: Record<string, unknown>) => ({
    key: `m/${id}`,
    ref: { machineId: "m", sessionId: id },
    machineName: "m",
    snapshot: { ...snapshot, id, ...over },
    daemonNow: 0,
    fetchedAt: 0,
  });

  const sessions = [
    row("a", { status: "running", lastEventAt: 10 }),
    row("b", { status: "exited", exit: { reason: "stopped" }, lastEventAt: 20 }),
    row("c", { status: "blocked", pendingPermissions: [{ raisedAt: 500 }, { raisedAt: 100 }] }),
    row("d", { status: "blocked", pendingPermissions: [{ raisedAt: 50 }] }),
    row("e", { status: "running", lastEventAt: 30 }),
    /*
     * Placed here, immediately beside `b`, so the two are read together: same
     * `status: "exited"`, opposite outcome, and the *reason* is the only thing
     * separating them. This is the row a `status`-keyed implementation gets
     * wrong, and it is the one an ordinary deploy actually produces — a graceful
     * restart writes `daemon_shutdown`, not `daemon_restarted`.
     */
    row("f", {
      status: "exited",
      exit: { reason: "daemon_shutdown" },
      agentSessionId: "a_f",
      lastEventAt: 25,
    }),
    // The daemon tried and gave up. Active, because somebody has to act — but
    // not counted, because nothing is running.
    row("g", {
      status: "interrupted",
      exit: { reason: "daemon_restarted" },
      agentSessionId: "a_g",
      resume: { state: "failed", attempts: 3, error: { code: "agent_auth_required", message: "no" }, at: 0 },
      lastEventAt: 5,
    }),
  ];
  const state = { sessions, machines: [] } as never;
  const lists = sessionLists(state);

  // Blocked first, oldest wait first: the point of the whole screen.
  check("blocked sessions sort by their oldest pending permission", lists.blocked.map((r) => r.snapshot.id), ["d", "c"]);
  check("active sessions sort most-recent first", lists.active.map((r) => r.snapshot.id), ["e", "f", "a", "g"]);
  // `b` alone. `f` ended in exactly the same *status* and is not here, which is
  // the whole point: nobody ended it, so calling it ended would be answering a
  // question the reader did not ask.
  check("only a session somebody ended is filed as ended", lists.ended.map((r) => r.snapshot.id), ["b"]);
  check("and a blocked session is never also counted active", lists.active.length + lists.blocked.length, 6);
  /*
   * Five: the four that were live plus `f`, which is a live conversation a few
   * seconds from having an agent again. Not `b` (somebody ended it) and not `g`
   * (the daemon gave up, so nothing is running) — that second exclusion is why
   * `countsAsLive` is a separate question from which list a row lands in.
   */
  check("the machine count is live sessions, not every session", lists.countByMachine.get("m" as never), 5);
  check("and ended rows are still in the list, just not counted", lists.ended.length, 1);

  // Memoised on the array's identity, which is what makes a streamed event free.
  report("the derivation is memoised by identity", sessionLists(state) === lists, "same object returned");

  check("isTerminal agrees with the split", [isTerminal("running"), isTerminal("exited")], [false, true]);
}

/* ------------------------------------------------------------------ *
 * Enter-to-send
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe composer's send key\n");
{
  const { shouldSend, isTypingInto, isBareKey } = await import("../src/keys.js");

  check("a bare Enter sends", shouldSend({ key: "Enter" }), true);
  check("Shift+Enter is a new line", shouldSend({ key: "Enter", shiftKey: true }), false);
  check("and so is any other modifier", [
    shouldSend({ key: "Enter", metaKey: true }),
    shouldSend({ key: "Enter", ctrlKey: true }),
    shouldSend({ key: "Enter", altKey: true }),
  ], [false, false, false]);
  check("an ordinary letter does nothing", shouldSend({ key: "a" }), false);

  /*
   * The one that is not obvious, and the reason this is a pure function at all.
   *
   * With a Russian, Chinese, Japanese or Korean input method, Enter *commits the
   * candidate being typed* — the text is not in the box yet. A naive
   * `key === "Enter"` sends a half-finished word and swallows the keystroke that
   * was meant to finish it, on every message, for everyone using one of those
   * layouts. There is no way to notice this from a Latin keyboard, which is
   * exactly why it needs an assertion rather than a look.
   */
  check("Enter while an IME is composing does not send", shouldSend({ key: "Enter", isComposing: true }), false);

  // The guard that makes bare-letter shortcuts possible: without it, `j` typed
  // into the composer navigates to another session mid-sentence.
  check("a textarea counts as typing", isTypingInto({ tagName: "TEXTAREA" }), true);
  check("as does an input", isTypingInto({ tagName: "INPUT" }), true);
  check("and a contenteditable", isTypingInto({ tagName: "DIV", isContentEditable: true }), true);
  check("a plain div does not", isTypingInto({ tagName: "DIV" }), false);
  check("and neither does nothing at all", isTypingInto(null), false);
  check("a modifier disqualifies a bare shortcut", isBareKey({ key: "j", metaKey: true }), false);

  /*
   * The digits on the ask card.
   *
   * The number beside each answer used to be decoration under a comment calling
   * it "the number a keyboard would reach for". Wiring it makes the guards
   * load-bearing rather than tidy: the composer sits directly under that card and
   * takes the caret on its own, so a digit that ignored `isTypingInto` would
   * approve whatever the agent was asking with the first character of a message.
   */
  const { optionShortcut } = await import("../src/keys.js");

  check("a digit picks the answer with that number", optionShortcut({ key: "3" }, null, 4), 2);
  check("counting from one, so 1 is the first", optionShortcut({ key: "1" }, null, 4), 0);
  check("past the end it picks nothing", optionShortcut({ key: "5" }, null, 4), null);
  check("and there is no option zero", optionShortcut({ key: "0" }, null, 4), null);
  check("a digit typed into the composer is a digit", optionShortcut({ key: "3" }, { tagName: "TEXTAREA" }, 4), null);
  check("as is one typed into a form field on the card itself", optionShortcut({ key: "3" }, { tagName: "INPUT" }, 4), null);
  check(
    "and every chord is left alone — Shift+1 is a character somebody typed",
    [
      optionShortcut({ key: "3", metaKey: true }, null, 4),
      optionShortcut({ key: "3", ctrlKey: true }, null, 4),
      optionShortcut({ key: "3", altKey: true }, null, 4),
      optionShortcut({ key: "1", shiftKey: true }, null, 4),
      optionShortcut({ key: "3", isComposing: true }, null, 4),
    ],
    [null, null, null, null, null],
  );
  check("a card with no answers has no shortcuts", optionShortcut({ key: "1" }, null, 0), null);
  check("a letter is not a shortcut here", optionShortcut({ key: "j" }, null, 4), null);

  const { completionKey } = await import("../src/keys.js");

  check("the menu walks on the arrows", [completionKey({ key: "ArrowDown" }), completionKey({ key: "ArrowUp" })], ["next", "prev"]);
  check("Enter and Tab both choose", [completionKey({ key: "Enter" }), completionKey({ key: "Tab" })], ["choose", "choose"]);
  check("Escape dismisses", completionKey({ key: "Escape" }), "dismiss");
  check("an ordinary letter is left to the textarea", completionKey({ key: "a" }), null);

  /*
   * The same IME defect, arriving through a new door.
   *
   * Enter commits an input-method candidate, so a menu that read it as a
   * selection would insert a command instead of finishing a word — identical in
   * shape and invisibility to the send bug above, and not prevented by that one:
   * this function runs *first*, so it has to carry its own guard.
   */
  check("Enter while an IME is composing chooses nothing", completionKey({ key: "Enter", isComposing: true }), null);
  // Shift+Enter stays a newline and Shift+Tab stays focus-backwards, whether or
  // not a suggestion list happens to be on screen.
  check("and a shifted Enter or Tab is left alone", [
    completionKey({ key: "Enter", shiftKey: true }),
    completionKey({ key: "Tab", shiftKey: true }),
  ], [null, null]);

  /*
   * The collision, asserted *as* a collision.
   *
   * Enter is the one key both functions claim, which is why the order inside
   * `Composer`'s handler is load-bearing rather than incidental — and it is
   * load-bearing for exactly one key, which is the half that keeps it safe.
   */
  check("Enter is the one key both claim", [shouldSend({ key: "Enter" }), completionKey({ key: "Enter" })], [true, "choose"]);
  check("and the menu's other keys never send", [
    shouldSend({ key: "ArrowDown" }),
    shouldSend({ key: "ArrowUp" }),
    shouldSend({ key: "Tab" }),
    shouldSend({ key: "Escape" }),
  ], [false, false, false, false]);

  /*
   * And the *resolution*, which is the half that was claimed and not asserted.
   *
   * The two checks above establish that a collision exists; they stay green with
   * the composer's two blocks in either order, and reversing them sends a
   * half-typed message instead of completing a command. `composerKey` is that
   * ordering moved somewhere it can be pinned.
   */
  const { composerKey } = await import("../src/keys.js");

  check("with the menu open, Enter completes", composerKey({ key: "Enter" }, true, true), "choose");
  check("with it closed, Enter sends", composerKey({ key: "Enter" }, false, true), "send");
  check("the arrows only mean anything to the menu", [
    composerKey({ key: "ArrowDown" }, true, true),
    composerKey({ key: "ArrowDown" }, false, true),
  ], ["next", null]);
  check("and Escape likewise", [
    composerKey({ key: "Escape" }, true, true),
    composerKey({ key: "Escape" }, false, true),
  ], ["dismiss", null]);
  // The IME guard survives the merge in both directions, which is the thing that
  // would otherwise quietly move house rather than be fixed.
  check("an IME candidate neither completes nor sends", [
    composerKey({ key: "Enter", isComposing: true }, true, true),
    composerKey({ key: "Enter", isComposing: true }, false, true),
  ], [null, null]);
  // Shift+Enter is a newline whether or not a suggestion list happens to be up.
  check("a shifted Enter is left to the textarea, menu or no menu", [
    composerKey({ key: "Enter", shiftKey: true }, true, true),
    composerKey({ key: "Enter", shiftKey: true }, false, true),
  ], [null, null]);

  /*
   * ⭐ **The soft keyboard, which is the whole of the mobile rule.**
   *
   * A phone has no Shift+Enter, so with Enter sending there was no way to type a
   * newline at all and the composer grew a `↵` button beside the box to do it —
   * one that appended to the *end* of the draft whatever the caret was doing.
   * `enterSends` replaces the button: false hands the keystroke back to the
   * textarea, which breaks the line at the caret like any other character.
   *
   * The menu is asserted **against** the pointer rather than beside it, because
   * that is the pair that can be got wrong in a way nothing else notices: typing
   * `/model` on a phone and pressing Return has to choose the command, and a
   * naive `if (!enterSends) return null` at the top of the function would insert a
   * line break into the draft instead and leave the menu open over it.
   */
  check("on a soft keyboard Enter is a newline rather than a send", composerKey({ key: "Enter" }, false, false), null);
  check("but the menu still takes it there", composerKey({ key: "Enter" }, true, false), "choose");
  check("and so do the keys the menu owns", [
    composerKey({ key: "ArrowDown" }, true, false),
    composerKey({ key: "Escape" }, true, false),
  ], ["next", "dismiss"]);

  /*
   * Both halves of that rule live in `Composer.tsx` and neither is reachable from
   * a pure function: the pointer read is a `matchMedia` at the keystroke, and the
   * hint is an attribute. Read off disk, in the `gateOffer`/`showsGateLink` style
   * — the button being deleted is the *point*, so its absence is the assertion.
   */
  {
    const composer = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
    check("the newline button is gone", /CornerDownLeft/.test(composer), false);
    // Unconditional, because a virtual keyboard is the only thing that reads it —
    // so there is no pointer question here and nothing that can go stale.
    check("and the soft Return key is drawn as one", /enterKeyHint="enter"/.test(composer), true);
    // The leading `!` is what distinguishes this from `shouldFocusComposer`'s own
    // read one screenful up, which passes the same query the other way round.
    check(
      "the pointer is read at the keystroke and negated into `enterSends`",
      /!window\.matchMedia\("\(pointer: coarse\)"\)\.matches/.test(composer),
      true,
    );
  }
}

/* ------------------------------------------------------------------ *
 * The agent's controls
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe agent config bar reads categories, not ids\n");
{
  /*
   * Not a render test — there is no DOM here — but the thing that would actually
   * break is not the markup, it is the assumption that a control can be found by
   * its id. Claude publishes reasoning effort as `effort` with values
   * `default|low|…|max`; kimi publishes the same concept as `thinking` with
   * values `off|…`. The two share nothing but `category`, so this asserts that a
   * lookup by category finds both and a lookup by id finds one.
   */
  const claude = [
    { id: "mode", name: "Mode", description: null, category: "mode", kind: "select", value: "default", choices: [] },
    { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "opus", choices: [] },
    { id: "effort", name: "Effort", description: null, category: "thought_level", kind: "select", value: "high", choices: [] },
  ];
  const kimi = [
    { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "k2", choices: [] },
    { id: "thinking", name: "Thinking", description: null, category: "thought_level", kind: "select", value: "off", choices: [] },
    { id: "mode", name: "Mode", description: null, category: "mode", kind: "select", value: "yolo", choices: [] },
  ];

  const byCategory = (options: typeof claude, category: string) =>
    options.find((option) => option.category === category)?.value ?? null;

  check("effort is found on claude by category", byCategory(claude, "thought_level"), "high");
  check("and on kimi, whose id is different", byCategory(kimi, "thought_level"), "off");
  check(
    "a lookup by claude's id finds nothing on kimi",
    kimi.find((option) => option.id === "effort") ?? null,
    null,
  );
  check("mode is found on both", [byCategory(claude, "mode"), byCategory(kimi, "mode")], ["default", "yolo"]);

  /*
   * And the *label*, which is the same disagreement one layer further out.
   *
   * Finding the control by category was never enough on its own: measured
   * 2026-08-04 against the live agents, claude calls it `Effort` and kimi calls
   * the identical control `Thinking` (`category: "thought_level"`, choices
   * Low/High/Max). So the strip said one word and the `/` menu — which already
   * synthesizes this control as `/effort` on both agents, off the same category —
   * said another, one tap apart.
   *
   * Narrow on purpose, and the table has exactly the entries a measurement put
   * there. `model` is `Model` on all four agents, so there is nothing to reconcile
   * and the agent's own name stands; an unknown category has no second opinion at
   * all. Overriding a name we have no better version of is how a client starts
   * inventing vocabulary.
   *
   * `mode` is the second entry and it arrived with the fourth agent. Measured
   * 2026-08-27: claude and kimi publish `Mode` and opencode publishes
   * `Session Mode` for the identical control — a second word on the one chip that
   * spends width on its name *and* its value, on a phone, for a control reached
   * for several times an hour.
   */
  const effortOf = (options: typeof claude) =>
    labelFor(options.find((o) => o.category === "thought_level") as never);
  check("the effort control is called the same thing on both agents", [effortOf(claude), effortOf(kimi)], [
    "Effort",
    "Effort",
  ]);
  check(
    "a control every agent already agrees about keeps its own name",
    labelFor(claude[1] as never),
    "Model",
  );
  check("and the mode control is one word on all four", [
    labelFor(claude[0] as never),
    labelFor(kimi[2] as never),
    labelFor({ category: "mode", name: "Session Mode" }),
  ], ["Mode", "Mode", "Mode"]);
  check(
    "and so does one nobody has a second word for",
    labelFor({ category: "unheard_of", name: "Whatever" }),
    "Whatever",
  );
  /*
   * The negative control that makes the one above mean something: this table is
   * keyed on the *category* and never on the string, so the same words under a
   * category nobody has reconciled are left exactly as the agent said them.
   */
  check(
    "and the reconciliation is by category, not by recognising the words",
    labelFor({ category: "unheard_of", name: "Session Mode" }),
    "Session Mode",
  );

  /* ---------------------------------------------------------------- *
   * What one choice is called
   *
   * ⭐ Three surfaces name a choice — the chip, the control's menu row and the
   * `/` menu's second stage — and each held its own copy of
   * `override?.label ?? choice.name`. `choiceLabel` is the one place now, and it
   * carries the second half too: measured 2026-08-27, claude publishes `Auto`,
   * `Manual`, `Accept Edits`; kimi publishes `Default`, `Plan`, `Auto`, `YOLO`;
   * opencode publishes `build` and `plan`. One list, Title Case on three agents
   * and lower case on the fourth.
   * ---------------------------------------------------------------- */
  const modeChoice = (value: string, name: string) => ({ value, name, description: null, group: null });
  check(
    "a mode an agent published in lower case is drawn with a capital",
    [
      choiceLabel({ category: "mode" }, modeChoice("build", "build")),
      choiceLabel({ category: "mode" }, modeChoice("plan", "plan")),
    ],
    ["Build", "Plan"],
  );
  check(
    "and one that already has one is untouched, letter for letter",
    [
      choiceLabel({ category: "mode" }, modeChoice("yolo", "YOLO")),
      choiceLabel({ category: "mode" }, modeChoice("acceptEdits", "Accept Edits")),
      choiceLabel({ category: "mode" }, modeChoice("plan", "Plan Mode")),
    ],
    ["YOLO", "Accept Edits", "Plan Mode"],
  );
  /*
   * The cases where there is no upper case to reach for. All one branch, because
   * the test is against the character itself rather than a category of character:
   * "there is no upper case of this" and "this is already upper case" are the same
   * answer, so a digit, a bracket and an emoji need no arm of their own.
   */
  check(
    "and a name with no capital to give is returned as it came",
    [
      choiceLabel({ category: "mode" }, modeChoice("a", "")),
      choiceLabel({ category: "mode" }, modeChoice("b", "3.5-turbo")),
      choiceLabel({ category: "mode" }, modeChoice("c", "(default)")),
      choiceLabel({ category: "mode" }, modeChoice("d", "\u{1f680} launch")),
    ],
    ["", "3.5-turbo", "(default)", "\u{1f680} launch"],
  );
  /*
   * ⚠ **Only `mode`.** A model's name is a proper noun somebody else owns —
   * `gpt-5.6-sol` is not improved by a capital — and every agent that publishes an
   * effort control, opencode included, already capitalises its levels. Narrowing
   * this the way `chipValue` narrows its own rule to `model` is what keeps one
   * measured disagreement from becoming a client that cases everything it is told.
   */
  check(
    "and no other category is cased at all",
    [
      choiceLabel({ category: "model" }, modeChoice("gpt-5.6-sol", "gpt-5.6-sol")),
      choiceLabel({ category: "thought_level" }, modeChoice("low", "low")),
      choiceLabel({ category: "unheard_of" }, modeChoice("x", "whatever")),
      choiceLabel({ category: null }, modeChoice("y", "whatever")),
    ],
    ["gpt-5.6-sol", "low", "whatever", "whatever"],
  );
  /*
   * And the one rename outranks the casing, so `default` keeps the answer
   * `choiceOverride` measured for it rather than being capitalised into a word
   * that still says nothing.
   */
  check(
    "a value this client does rename is renamed, not merely capitalised",
    [
      choiceLabel({ category: "thought_level" }, modeChoice("default", "Default")),
      choiceLabel({ category: "mode" }, modeChoice("default", "default")),
    ],
    ["Adaptive", "Default"],
  );

  /* ---------------------------------------------------------------- *
   * A prefix every row repeats is no prefix at all
   *
   * ⭐ Reported from the app: "opencode models are added to the openrouter models
   * at the bottom". Measured 2026-08-27 off the live log — opencode publishes ONE
   * model control with 362 choices, `group: null` on every one: 356 named
   * `OpenRouter/<model>` and then six named `OpenCode Zen/<model>`. Two accounts,
   * two keys, one undivided list, and the word `OpenRouter` printed 356 times in
   * front of the only part of each row that differs.
   *
   * ⭐ Reported next, of the menu that produced: "take out the *OpenCode Zen* line
   * and the others". The heading is gone and the shortening stayed — and the
   * condition had to tighten with it, which is what most of this section is about.
   * With a heading, a prefix agreed across one namespace could be cut because the
   * heading put it back; with nowhere to put it back, only a prefix **every row of
   * the control** carries may be removed, since that is the only text whose removal
   * cannot make two rows read alike.
   *
   * ⚠ This is NOT the per-vendor split that was built and removed by name
   * (Q3.507). That divided one provider's catalogue into 38 groups by parsing
   * vendors out of ids; this removes a word the agent itself repeated on every row.
   * ---------------------------------------------------------------- */
  const choice = (value: string, name: string, group: string | null = null) => ({
    value,
    name,
    description: null,
    group,
  });
  /*
   * One provider's catalogue, which is what a session's model control actually
   * holds: `narrowToSystem` on the daemon cuts the list down to the system that
   * session routes through before it is ever published.
   */
  const openrouterModels = [
    choice("openrouter/aion-labs/aion-2.0", "OpenRouter/Aion-2.0"),
    choice("openrouter/anthropic/claude-opus-4.7-fast", "OpenRouter/Claude Opus 4.7 Fast"),
    choice("openrouter/qwen/qwen3-coder", "OpenRouter/Qwen3 Coder"),
  ];
  check(
    "a provider every row repeats comes out of every row",
    drawnChoices({ choices: openrouterModels } as never).map((one: { name: string }) => one.name),
    ["Aion-2.0", "Claude Opus 4.7 Fast", "Qwen3 Coder"],
  );
  check(
    "and the value — what is stored, sent and pinned — is untouched",
    drawnChoices({ choices: openrouterModels } as never).map((one: { value: string }) => one.value),
    openrouterModels.map((one) => one.value),
  );
  /*
   * ⚠ **Nothing here derives a heading, and this is the assertion that says so.**
   * The provider was lifted into `group` for one release. It is not any more: what
   * this function may do to a control is make its names shorter, and a `group` that
   * did not arrive from the agent is a heading this client invented.
   */
  check(
    "and no heading is derived from it",
    drawnChoices({ choices: openrouterModels } as never).map((one: { group: string | null }) => one.group),
    [null, null, null],
  );
  /*
   * ⭐ The tightening, and the reason the heading could not simply be dropped from
   * the old rule. opencode's raw 362 hold two providers; cutting each of them
   * against its own namespace and drawing no heading would run `Big Pickle` in with
   * 356 OpenRouter models under nothing at all — which is the report this whole
   * section started from, arriving back by the other door.
   */
  const bothProviders = [...openrouterModels, choice("opencode/big-pickle", "OpenCode Zen/Big Pickle")];
  check(
    "two providers in one control leave every name exactly as the agent wrote it",
    drawnChoices({ choices: bothProviders } as never).map((one: { group: string | null; name: string }) => [
      one.group,
      one.name,
    ]),
    [
      [null, "OpenRouter/Aion-2.0"],
      [null, "OpenRouter/Claude Opus 4.7 Fast"],
      [null, "OpenRouter/Qwen3 Coder"],
      [null, "OpenCode Zen/Big Pickle"],
    ],
  );
  /*
   * The `every` guard, which is the whole of the safety: one row that does not
   * split turns the rule off for the control, so a list can never divide into
   * "the prefixed ones and the rest".
   */
  check(
    "one row without a provider turns the rule off for the whole control",
    drawnChoices({ choices: [...openrouterModels, choice("other/bare", "Bare")] } as never).map(
      (one: { name: string }) => one.name,
    ),
    ["OpenRouter/Aion-2.0", "OpenRouter/Claude Opus 4.7 Fast", "OpenRouter/Qwen3 Coder", "Bare"],
  );
  check(
    "and an agent that grouped its own list keeps its grouping, and its names",
    drawnChoices({
      choices: [choice("a", "OpenRouter/A", "Theirs"), choice("b", "OpenRouter/B", "Theirs")],
    } as never).map((one: { group: string | null; name: string }) => [one.group, one.name]),
    [
      ["Theirs", "OpenRouter/A"],
      ["Theirs", "OpenRouter/B"],
    ],
  );
  /*
   * Measured against the live agents: no model, mode or effort name on claude,
   * kimi or codex carries a separator, so none of their lists is touched. Asserted
   * by **identity**, which is also what makes the memo on the array sound — a rule
   * that is off must hand back the array it was given.
   */
  {
    const ordinary = [
      choice("opus[1m]", "Opus (1M context)"),
      choice("sonnet", "Sonnet"),
      choice("gpt-5.6-sol", "GPT-5.6-Sol"),
    ];
    check("no other agent's list is touched, by identity", drawnChoices({ choices: ordinary } as never) === ordinary, true);
    check(
      "and neither is a list with nothing in it",
      drawnChoices({ choices: [] } as never).length,
      0,
    );
  }
  /*
   * The separator's edges. A head or a tail that is empty after trimming is not a
   * provider and a name, it is a name with a slash in it.
   */
  check(
    "a name that only looks split is left whole",
    [
      drawnChoices({ choices: [choice("p/a", "/leading")] } as never)[0]?.name,
      drawnChoices({ choices: [choice("p/b", "trailing/")] } as never)[0]?.name,
      drawnChoices({ choices: [choice("p/c", "/")] } as never)[0]?.name,
      drawnChoices({ choices: [choice("p/d", " / ")] } as never)[0]?.name,
    ],
    ["/leading", "trailing/", "/", " / "],
  );
  check(
    "spaces around the separator are the writer's, not the reader's",
    drawnChoices({ choices: [choice("opencode/big-pickle", "OpenCode Zen / Big Pickle")] } as never).map(
      (one: { group: string | null; name: string }) => [one.group, one.name],
    ),
    [[null, "Big Pickle"]],
  );
  /*
   * The **first** separator, so a provider that writes one into its own model
   * names keeps it. Nothing in opencode's 362 does — checked — but splitting on
   * the last would make that a silent difference rather than a decision.
   */
  check(
    "the first separator is the provider and everything after it is the model",
    drawnChoices({
      choices: [choice("openrouter/qwen/qwen3-coder", "OpenRouter/qwen/Qwen3 Coder")],
    } as never).map((one: { group: string | null; name: string }) => [one.group, one.name]),
    [[null, "qwen/Qwen3 Coder"]],
  );

  /* ---------------------------------------------------------------- *
   * ⭐ The two things this must not become
   *
   * Q3.503 built a per-vendor split of one provider's catalogue and took it back
   * out; Q3.507 rejected cutting at the first `/` by name, because such a cut
   * "would survive the rename and go on cutting, including a slash that belonged
   * to the model". Both are prevented by the same pair of tests rather than by a
   * threshold: only a list the agent *routes* on is touched at all, and then only
   * where every row of it agrees on the prefix.
   * ---------------------------------------------------------------- */
  check(
    "a vendor-shaped list inside ONE provider is one provider, not thirty-eight groups",
    drawnChoices({
      choices: [
        choice("openrouter/qwen/qwen3-coder", "qwen/Qwen3 Coder"),
        choice("openrouter/openai/gpt-5", "openai/GPT-5"),
        choice("openrouter/anthropic/claude-opus-5", "anthropic/Claude Opus 5"),
      ],
    } as never).map((one: { group: string | null; name: string }) => [one.group, one.name]),
    [
      [null, "qwen/Qwen3 Coder"],
      [null, "openai/GPT-5"],
      [null, "anthropic/Claude Opus 5"],
    ],
  );
  check(
    "and one row of a provider spelling its label differently leaves the whole control alone",
    drawnChoices({
      choices: [
        choice("openrouter/a/one", "OpenRouter/One"),
        choice("openrouter/b/two", "Open Router/Two"),
      ],
    } as never).map((one: { group: string | null; name: string }) => [one.group, one.name]),
    [
      [null, "OpenRouter/One"],
      [null, "Open Router/Two"],
    ],
  );
  check(
    "a value with no namespace to route on is left alone however its name reads",
    drawnChoices({ choices: [choice("big-pickle", "OpenCode Zen/Big Pickle")] } as never).map(
      (one: { group: string | null; name: string }) => [one.group, one.name],
    ),
    [[null, "OpenCode Zen/Big Pickle"]],
  );
  /*
   * ⚠ **A value that is a namespace and nothing else is not one.** `openrouter/`
   * and `/model` are the two ends of `namespaced`, and both are the shape a value
   * takes when something upstream has half-written it.
   */
  check(
    "a value that is all namespace and no model does not count as routed",
    [
      drawnChoices({ choices: [choice("openrouter/", "OpenRouter/One")] } as never)[0]?.name,
      drawnChoices({ choices: [choice("/gpt-5", "OpenRouter/Two")] } as never)[0]?.name,
    ],
    ["OpenRouter/One", "OpenRouter/Two"],
  );


  /*
   * Which chips say their own name, and which are identified without it.
   *
   * This replaced a `hidden sm:inline`, i.e. a width question answered with a
   * breakpoint: the caption vanished on a phone for the controls that needed it
   * and came back on a desktop for the ones that did not. The two silent ones are
   * silent because they are identified twice over — an icon, and a value that is
   * a proper noun. An unknown category is the case that decides the rule's shape:
   * it has no icon, so a chip with no caption would be a bare value with nothing
   * saying what it is, in the popover where there is no position to read it by.
   */
  check(
    "model and effort say only their value",
    [showsCaption({ category: "model" }), showsCaption({ category: "thought_level" })],
    [false, false],
  );
  check("mode keeps its name, because Manual answers nothing on its own", showsCaption({ category: "mode" }), true);
  check(
    "and so does a category we draw no icon for",
    [showsCaption({ category: "unheard_of" }), showsCaption({ category: null })],
    [true, true],
  );

  /*
   * And the width that stops moving.
   *
   * The right-hand cluster is right-aligned, so a chip that grows drags
   * everything left of it: picking `Max` after `Adaptive` moved the model chip by
   * five characters, every time. The reserve is every label the chip could show,
   * rendered invisibly in one grid cell — so the column is sized by the real font
   * rather than by a `length` guess, and `Adaptive` is in the list because that is
   * what `choiceOverride` renames `default` to.
   */
  const effortOption = {
    id: "effort",
    name: "Effort",
    description: null,
    category: "thought_level",
    kind: "select",
    value: "default",
    choices: [
      { value: "default", name: "Default", description: null, group: null },
      { value: "low", name: "Low", description: null, group: null },
      { value: "max", name: "Max", description: null, group: null },
    ],
  };
  /*
   * **The reserved width depends on the category and on nothing else.**
   *
   * It was the widest of *the agent's own* labels, which made claude's effort
   * chip wider than kimi's: the same strip was a different shape depending on
   * which session was open, so moving between two sessions moved every button.
   * Asserted as an independence property rather than by listing the values —
   * the same option shape under two agents' choice lists, and the same answer.
   */
  const asChoices = (values: string[]) =>
    values.map((value) => ({ value, name: value, description: null, group: null }));
  check(
    "the three controls on the strip hold a width open",
    ["mode", "model", "thought_level"].map((category) =>
      chipReserve({ category } as never),
    ),
    [
      ["Accept Edits", "—"],
      ["GPT-5.6-Luna", "—"],
      ["Adaptive", "Ultracode", "—"],
    ],
  );
  check(
    "and it is the same width whatever the agent offers, which is the point",
    [
      chipReserve({ ...effortOption, choices: asChoices(["default", "low", "max"]) } as never),
      chipReserve({ ...effortOption, id: "thinking", choices: asChoices(["off", "high"]) } as never),
      chipReserve({ ...effortOption, id: "reasoning_effort", choices: [] } as never),
    ],
    [
      ["Adaptive", "Ultracode", "—"],
      ["Adaptive", "Ultracode", "—"],
      ["Adaptive", "Ultracode", "—"],
    ],
  );
  {
    /*
     * ⭐ **The reserved string and the drawn string are the same bytes, which is the
     * whole of "Ultracode fits".**
     *
     * A reservation is honest only because the browser renders it: the sizer and the
     * value are one grid cell in the same font, so the column is exactly as wide as
     * whichever candidate is widest — and the value, being `sm:absolute sm:inset-0`,
     * can only ellipsise inside it. So a reserve that is *nearly* the drawn string
     * buys nothing: `Ultracode` was cut to `Ultrac…` while `Adaptive` sat in the
     * list, on the one control this client invents a row for.
     *
     * ⚠ Asserted by **identity against `chipValue`**, never against a literal here.
     * The name lives at `src/registry.ts`'s `withUltracode` and `packages/web`
     * cannot import from `src/`, so `CATEGORY_RESERVE` holds a hand-mirrored copy
     * and nothing across that boundary checks the two agree — `daemoncheck` pins
     * `ULTRACODE_CHOICE`, which is the *value*. This is the near half of that guard:
     * it cannot see the daemon rename the choice, but it does catch the reserve
     * drifting from whatever this client actually draws.
     */
    const ultracode = {
      ...effortOption,
      value: "ultracode",
      choices: [
        ...effortOption.choices,
        { value: "ultracode", name: "Ultracode", description: null, group: null },
      ],
    } as never;
    // `true` is `available`: the second argument is what decides between the real
    // value and `UNAVAILABLE_VALUE`, and omitting it silently asserts the placeholder.
    const drawn = chipParts(ultracode, true).value;
    check("the effort chip draws the daemon's own name for the row it adds", drawn, "Ultracode");
    check(
      "and the width it holds open is reserved for that exact string",
      (chipReserve(ultracode) ?? []).includes(drawn),
      true,
    );
    // The other half of the pair: the reserve is per *category*, so an agent that
    // never sees this row holds the same width. Otherwise the strip would be a
    // different shape on claude than on kimi, and every button beside it would move
    // when somebody switched session.
    check(
      "on every agent, including the two that can never draw it",
      chipReserve({ ...effortOption, id: "thinking" } as never),
      chipReserve(ultracode),
    );
  }

  check(
    "a category drawn in the overflow column holds nothing open, having nothing beside it",
    [chipReserve({ category: "unheard_of" } as never), chipReserve({ category: null } as never)],
    [null, null],
  );
  /*
   * The value somebody just chose is the value they see.
   *
   * A chip drew the value it was *leaving* for the whole round trip — pick Low and
   * it read "Adaptive" with a spinner, then Low — which is a loading state about a
   * decision already made. Drawn at once and put back if the daemon refuses, the
   * same trade the composer makes with a message it is still sending.
   */
  const asked = (entries: [string, string | boolean][]) => new Map(entries);
  check(
    "the chosen value replaces the one being left",
    withChoice(effortOption as never, asked([["effort", "low"]])).value,
    "low",
  );
  check(
    "and the chip reads it immediately",
    chipValue(withChoice(effortOption as never, asked([["effort", "low"]]))),
    "Low",
  );
  check(
    "a change to another control leaves this one alone, object for object",
    withChoice(effortOption as never, asked([["model", "opus"]])) === effortOption,
    true,
  );
  check("and so does nothing in flight", withChoice(effortOption as never, null) === effortOption, true);
  check(
    "choosing the value it already has changes nothing either",
    withChoice(effortOption as never, asked([["effort", "default"]])) === effortOption,
    true,
  );
  check(
    "a toggle takes its boolean the same way",
    withChoice({ ...effortOption, kind: "boolean", value: false, choices: [] } as never, asked([["effort", true]]))
      .value,
    true,
  );
  check(
    "two controls can be in flight at once, because the two doors do not fence each other",
    [
      withChoice(effortOption as never, asked([["effort", "max"], ["mode", "plan"]])).value,
      withChoice({ ...effortOption, id: "mode", value: "default" } as never, asked([["effort", "max"], ["mode", "plan"]]))
        .value,
    ],
    ["max", "plan"],
  );

  /*
   * The mechanism under it, and the ordering rule that keeps two taps honest.
   */
  {
    const { beginChoice, endChoice, choicesFor, forgetChoices } = await import("../src/choices.js");
    const key = "m_1/s_1" as never;
    const first = beginChoice(key, "effort", "low");
    check("a recorded choice is what the session is holding", [...(choicesFor(key) ?? new Map())], [["effort", "low"]]);
    const second = beginChoice(key, "effort", "max");
    endChoice(first);
    check(
      "an earlier answer does not release a later choice",
      [...(choicesFor(key) ?? new Map())],
      [["effort", "max"]],
    );
    endChoice(second);
    check("and the last one releases it", choicesFor(key), null);

    beginChoice(key, "effort", "low");
    beginChoice("m_1/s_2" as never, "effort", "high");
    forgetChoices(key);
    check("a session going away takes only its own", [
      choicesFor(key),
      [...(choicesFor("m_1/s_2" as never) ?? new Map())],
    ], [null, [["effort", "high"]]]);
    forgetChoices("m_1/s_2" as never);
  }

  /*
   * **The assertion that would have caught the defect**, and it has to be a
   * call-site one: every pure check above passed while the bug was live on
   * screen. There are two doors into `applyConfigChange` — the chip and the
   * composer's `/effort` menu — and the optimistic override lived in the bar's
   * own `useState`, so the second door drew the daemon's value for the whole
   * round trip. The rule is that recording belongs to the *dispatcher*: the map
   * is written in exactly one place, and no component may write it.
   */
  {
    const strip = readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const composerSrc = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const count = (text: string, needle: string) => text.split(needle).length - 1;

    // Once each, and both before the component: `applyConfigChange` is declared
    // above `export function AgentConfigBar`, so this pins them inside the
    // dispatcher rather than merely inside the file.
    const dispatcher = strip.slice(0, strip.indexOf("export function AgentConfigBar"));
    check(
      "the choice is recorded and released in the dispatcher, once each",
      [count(strip, "beginChoice("), count(strip, "endChoice("), count(dispatcher, "beginChoice("), count(dispatcher, "endChoice(")],
      [1, 1, 1, 1],
    );
    check(
      "and the other door records nothing of its own",
      [count(composerSrc, "beginChoice"), count(composerSrc, "endChoice")],
      [0, 0],
    );
    // Not trivially true: the property is only worth anything while a second
    // caller exists to be covered by it.
    check("while still being a second caller", count(composerSrc, "applyConfigChange(") >= 1, true);
    check(
      "and the daemon is still asked in exactly one place",
      count(strip, "setConfig(") + count(composerSrc, "setConfig("),
      1,
    );
  }

  /*
   * A control whose choices have gone still holds its width. That is the same
   * sentence as the one about a category, read at the moment it matters most:
   * an agent that has stopped offering a control is exactly when the chip must
   * not resize.
   */
  check(
    "a control with nothing left to choose still holds its width",
    [
      chipReserve({ ...effortOption, choices: [] } as never),
      chipReserve({ ...effortOption, kind: "boolean", value: true, choices: [] } as never),
    ],
    [
      ["Adaptive", "Ultracode", "—"],
      ["Adaptive", "Ultracode", "—"],
    ],
  );

  /*
   * Slot assignment, which is the same rule one layer up.
   *
   * `Fast mode` leaves the visible strip because it is `category: "model_config"`
   * and that category is not in the table — not because anybody matched the string
   * "fast". The distinction is the whole invariant: an id-keyed rule would hide
   * one agent's controls and show the other's.
   */
  const fast = { id: "fast", name: "Fast mode", description: null, category: "model_config", kind: "boolean", value: true, choices: [] };
  const odd = { id: "x", name: "Odd", description: null, category: "something_new", kind: "select", value: "a", choices: [] };
  const uncategorised = { id: "y", name: "Uncategorised", description: null, category: null, kind: "select", value: "b", choices: [] };

  const slots = splitOptions([...claude, fast, odd, uncategorised] as never);
  check("mode goes left", slots.left.map((o: { id: string }) => o.id), ["mode"]);
  check("model and effort go right, in reading order", slots.right.map((o: { id: string }) => o.id), ["model", "effort"]);
  // `Fast mode` is not demoted, it is *hidden* — a product decision about a known
  // category, asked for by name. With it gone the `…` button it was the sole
  // content of disappears too, which was the actual complaint.
  check("model_config is hidden outright", slots.hidden.map((o: { id: string }) => o.id), ["fast"]);
  // Unknown categories are still demoted rather than dropped: ACP says a category
  // must not be required for correctness, so a control nobody has heard of keeps a
  // way to be reached, and the `…` button reappears the moment one exists.
  check("but an unknown category is still reachable", slots.overflow.map((o: { id: string }) => o.id).sort(), ["x", "y"]);

  // `slotFor` directly, because `splitOptions` can only show where a control
  // *landed* and the rule is about `category` alone. Keyed on the category and
  // never on the id: claude calls reasoning effort `effort` and kimi calls it
  // `thinking`, so an id-keyed table draws one agent's controls and none of the
  // other's.
  check("the slot comes from the category", slotFor({ category: "mode" }), "left");
  check("model and effort share the right-hand slot", [slotFor({ category: "model" }), slotFor({ category: "thought_level" })], ["right", "right"]);
  // Hidden is a decision about a control we know; overflow is what we do with one
  // we do not. They must not collapse into each other.
  check("a known category we hide is hidden", slotFor({ category: "model_config" }), "hidden");
  check("an unknown one is demoted, not dropped", slotFor({ category: "something_new" }), "overflow");
  check("and so is a control with no category at all", slotFor({ category: null }), "overflow");

  // Demoted, never dropped: ACP says a category must not be required for
  // correctness, so an agent using one nobody has heard of stays fully operable.
  //
  // **`nested` is in this sum, and leaving it out is the failure the sum exists to
  // catch.** A slot missing from the count makes every option in it invisible to
  // the one assertion that says nothing is lost — which is how a control silently
  // stops existing while the check stays green.
  const total =
    slots.left.length + slots.right.length + slots.overflow.length + slots.hidden.length + slots.nested.length;
  check("every option lands in exactly one slot, and none is lost", total, 6);
  check("kimi's controls split the same way", splitOptions(kimi as never).right.map((o: { id: string }) => o.id), ["model", "thinking"]);

  /*
   * Codex, and the rule that the strip must not change shape between agents.
   *
   * Measured 2026-08-07, codex publishes five controls, and one of them —
   * `collaboration_mode`, its Default/Plan switch — is a category no other agent
   * has. Demoted as an unknown it would put a `…` button on the strip for codex
   * sessions and no other, so every other button moves along the row the moment
   * you switch session. It is `nested` instead: drawn as a second menu inside the
   * mode control, which already exists on every agent.
   */
  const codex = [
    { id: "mode", name: "Mode", description: null, category: "mode", kind: "select", value: "agent", choices: [] },
    { id: "collaboration_mode", name: "Collaboration mode", description: null, category: "collaboration_mode", kind: "select", value: "default", choices: [] },
    { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "gpt-5.6-sol", choices: [] },
    { id: "reasoning_effort", name: "Reasoning effort", description: null, category: "thought_level", kind: "select", value: "low", choices: [] },
    { id: "fast-mode", name: "Fast mode", description: null, category: "model_config", kind: "boolean", value: false, choices: [] },
  ];
  const codexSlots = splitOptions(codex as never);
  check("codex's plan switch nests rather than demoting", slotFor({ category: "collaboration_mode" }), "nested");
  check("so it is drawn inside the mode menu", codexSlots.nested.map((o: { id: string }) => o.id), ["collaboration_mode"]);
  /*
   * **The assertion the whole change is for.** Codex must leave the strip the
   * same shape claude leaves it: mode on the left, model and effort on the right,
   * and *nothing* behind a `…` — because the `…` is the button that appears for
   * one agent and not another.
   */
  check("and the strip carries no overflow button for codex", codexSlots.overflow, []);
  check("while the visible chips are the ones every agent has", [
    codexSlots.left.map((o: { id: string }) => o.id),
    codexSlots.right.map((o: { id: string }) => o.id),
  ], [["mode"], ["model", "reasoning_effort"]]);

  /*
   * A nested control with no host is demoted, never dropped.
   *
   * `nested` names a place *inside* another control's menu, so it only exists if
   * that control is on the strip. Both ways of not having one are the same
   * outcome: no mode control at all, and a mode control that is a toggle and
   * therefore has no menu to nest into.
   */
  check(
    "with no mode control, the nested one falls back to overflow",
    splitOptions([codex[1]] as never).overflow.map((o: { id: string }) => o.id),
    ["collaboration_mode"],
  );
  const toggleHost = { id: "mode", name: "Mode", description: null, category: "mode", kind: "boolean", value: true, choices: [] };
  check(
    "and a toggle is not a host, because a toggle has no menu",
    splitOptions([toggleHost, codex[1]] as never).overflow.map((o: { id: string }) => o.id),
    ["collaboration_mode"],
  );
  /*
   * **And the mirror, which the host test does not cover.**
   *
   * A boolean *host* is refused because a toggle has no menu to nest into. A
   * boolean in the *nested* slot is the same fact read from the other end: it
   * carries no `choices`, so `ChoiceSection` would draw a divider and a heading
   * with no rows under them, and `toEntries` skips booleans as well — so the
   * control would have no second way to be reached and would silently cease to
   * exist. Overflow is where it went before `nested` existed, drawn as a working
   * Toggle, and it is where it goes again.
   *
   * Asserted with a real host present, so nothing else could be doing the
   * demotion: `mode` is a select here and `collaboration_mode` still leaves the
   * nested slot.
   */
  const booleanNested = [
    codex[0],
    { id: "collaboration_mode", name: "Plan", description: null, category: "collaboration_mode", kind: "boolean", value: false, choices: [] },
  ];
  const booleanSlots = splitOptions(booleanNested as never);
  check(
    "a boolean cannot be nested either, because it has no choices to draw",
    [
      booleanSlots.nested.map((o: { id: string }) => o.id),
      booleanSlots.overflow.map((o: { id: string }) => o.id),
    ],
    [[], ["collaboration_mode"]],
  );
  check(
    "and its host is still on the strip, so nothing else demoted it",
    booleanSlots.left.map((o: { id: string }) => o.id),
    ["mode"],
  );
  // The partition still holds with a member moved between slots.
  check(
    "and nothing is lost moving it",
    booleanSlots.left.length +
      booleanSlots.right.length +
      booleanSlots.overflow.length +
      booleanSlots.hidden.length +
      booleanSlots.nested.length,
    2,
  );
}

/* ------------------------------------------------------------------ *
 * Widget roles, kept rather than merely drawn
 * ------------------------------------------------------------------ */

process.stdout.write("\narrow keys inside a menu that claims to be one\n");
{
  /*
   * ⚠ **The roles were drawn and never implemented, and nothing here noticed.**
   *
   * `bits.tsx` renders `role="menu"`, and `role="listbox"` with `role="option"`
   * plus `aria-selected` on every row. A grep for `ArrowDown` across the whole of
   * `packages/web` returned exactly one hit, in the composer's own slash menu — so
   * a screen reader announced "listbox, 8 options" and then not one arrow key
   * moved anything. That is the same class of defect as an unmeasured contrast
   * ratio, and this file was already asserting those.
   *
   * Split in two on purpose: reading the key is one question and where focus lands
   * is another, and only the second has a wrap in it.
   */
  const { listNavKey, nextOptionIndex } = await import("../src/keys.js");

  check("the list walks on the arrows", [listNavKey({ key: "ArrowDown" }), listNavKey({ key: "ArrowUp" })], [
    "next",
    "prev",
  ]);
  check("and jumps on Home and End", [listNavKey({ key: "Home" }), listNavKey({ key: "End" })], ["first", "last"]);

  /*
   * **Escape is the omission that matters.** `overlay.ts` is the single arbiter —
   * it holds the LIFO layer stack and the one capture-phase listener, and
   * `decisionShortcutsEnabled` reads that stack to decide whether a bare digit may
   * resolve a permission. A second component answering Escape is the exact shape
   * that arbiter replaced, so this must keep returning `null` and let the key
   * travel to where it is owned.
   */
  check("Escape belongs to the overlay arbiter and is not claimed here", listNavKey({ key: "Escape" }), null);
  // Every row in both widgets is a real `<button>`, which activates on both
  // without help. Claiming them would re-implement the platform, slightly wrong.
  check("Enter and Space are left to the button", [listNavKey({ key: "Enter" }), listNavKey({ key: " " })], [null, null]);
  check("an ordinary letter means nothing to a list", listNavKey({ key: "j" }), null);
  // An arrow mid-composition is how an IME walks its own candidate list.
  check("and an arrow while an IME is composing is the IME's", listNavKey({ key: "ArrowDown", isComposing: true }), null);
  check("as is any chord", [
    listNavKey({ key: "ArrowDown", metaKey: true }),
    listNavKey({ key: "ArrowUp", ctrlKey: true }),
    listNavKey({ key: "Home", altKey: true }),
  ], [null, null, null]);

  /*
   * **-1 is "nothing has focus yet"**, which is the state every panel opens in
   * before its effect runs. From nowhere, Down takes the first row and Up the last,
   * so a keyboard arriving at a fresh menu gets the near end either way rather than
   * landing on row two.
   */
  check("from nowhere, Down takes the first row", nextOptionIndex("next", -1, 4), 0);
  check("and Up takes the last", nextOptionIndex("prev", -1, 4), 3);
  check("otherwise it steps", [nextOptionIndex("next", 1, 4), nextOptionIndex("prev", 2, 4)], [2, 1]);

  /*
   * The wrap, which is the whole reason this is a function rather than `+1`. It is
   * the convention for a popup of bounded length, and it removes the dead key: on a
   * four-row menu with focus on the last row, an unwrapped Down does nothing and
   * tells the reader nothing about why.
   */
  check("the end wraps to the start", nextOptionIndex("next", 3, 4), 0);
  check("and the start wraps to the end", nextOptionIndex("prev", 0, 4), 3);
  check("Home and End ignore where focus was", [nextOptionIndex("first", 2, 4), nextOptionIndex("last", 2, 4)], [0, 3]);

  // So a caller cannot focus index 0 of nothing.
  check("an empty list has nowhere to go", [
    nextOptionIndex("next", -1, 0),
    nextOptionIndex("first", -1, 0),
  ], [null, null]);
  check("and no key at all goes nowhere", nextOptionIndex(null, 1, 4), null);

  /*
   * The wiring, as source text, because `webcheck` has no DOM and a handler that
   * is never attached is indistinguishable from one that is.
   *
   * **On the panel and never on `window`** is the property worth pinning. This app
   * has exactly two global keydown listeners on purpose — `overlay.ts`'s Escape
   * arbiter and `AskCard`'s digit shortcuts — and each had to reason about the
   * other. A third would have had to reason about both.
   */
  const bitsRaw = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
  /*
   * Comments out first, and that is not tidiness — it is the failure this block
   * hit on its first run. Both counts below were written against the raw file and
   * both came back one too high, because the docblocks explaining these very rules
   * quote the strings being counted: the prose says `tabIndex={-1}` and it says
   * `.focus()`. Every source-text assertion in this file that reads code rather
   * than copy has to do this, and the ones further down already do.
   */
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const bitsSrc = strip(bitsRaw);
  check("both panels take the keys", (bitsSrc.match(/onKeyDown=\{onKeyDown\}/g) ?? []).length, 2);
  check("and neither reaches for a global listener", /window\.addEventListener\("keydown"/.test(bitsSrc), false);

  /*
   * **The panel holds focus itself, and that is what keeps the widget alive.**
   *
   * The handler is element-scoped, so focus leaving the rows is the same thing as
   * the widget going dead: a focused row can unmount under the 4s poll
   * (`NewSession`'s machine list, a conditional row in `UsersSection`), the browser
   * drops focus to `<body>`, and from there no arrow key can reach the handler to
   * get back in. It is also the only way a panel whose rows are a caller's prose —
   * `ProfileMenu`'s `HelpButton` — takes focus at all, rather than announcing
   * `role="menu"` and answering nothing.
   *
   * Pinned as source text because it is a JSX attribute and this driver has no DOM.
   */
  check("and both can hold focus themselves", (bitsSrc.match(/tabIndex=\{-1\}/g) ?? []).length, 2);

  /*
   * **Neither `focus()` may scroll an ancestor.** Both popups are `absolute`
   * children of a box routinely inside `SHEET_BODY`, and the outside-`pointerdown`
   * that closes a panel is also what the start of a touch scroll looks like — so an
   * unguarded restore scrolls the sheet back to the trigger, fighting the scroll the
   * reader just began. Every `focus()` in this file's list code carries
   * `preventScroll`, and revealing a row is `revealWithin`, which moves the panel
   * and nothing above it.
   */
  const listCode = strip(bitsRaw.slice(bitsRaw.indexOf("function focusableRows"), bitsRaw.indexOf("A panel anchored to")));
  check("the list's focus calls never scroll the page", [
    // Three that move focus for the reader: opening, restoring, and each arrow.
    (listCode.match(/\.focus\(\{ preventScroll: true \}\)/g) ?? []).length,
    // …and exactly one that does not, which is the body fallback `Sheet` also
    // makes: there is nothing to reveal and nowhere to scroll to.
    (listCode.match(/\.focus\(\)/g) ?? []).length,
    (listCode.match(/document\.body\.focus\(\)/g) ?? []).length,
  ], [3, 1, 1]);
  // `Sheet` solved the disappearing trigger first; this mirrors it rather than
  // inventing a second answer.
  check("and a trigger that did not survive falls back like Sheet's", /back\.isConnected/.test(listCode), true);
}
