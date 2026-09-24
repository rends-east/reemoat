import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { snapshot } from "./webcheck.ws.js";
import { stripComments } from "./webcheck.source.js";
import {
  changeCounts,
  chipParts,
  chipValue,
  choiceLabel,
  diffLines,
  drawnChoices,
  effortFollowUp,
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

process.stdout.write("\nthe diff, before and after the fact\n");
{
  // `diffLines` replaced `lineDiff`: claude sends a fragment, codex whole files on both sides, kimi a fragment then the whole file.
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

  const same = diffLines("a\nb", "a\nb");
  check("identical text has nothing to draw", [same.hunks.length, same.added, same.removed], [0, 0, 0]);

  const replaced = diffLines("a\nb", "x\ny");
  check("nothing lining up is a whole-file replacement", replaced.wholeFile, true);
  check("and every line is shown on both sides", shape(replaced), [["-a", "-b", "+x", "+y"]]);

  const deleted = diffLines("a\nb\nc", "");
  check("a deleted file adds nothing", [deleted.added, deleted.removed], [0, 3]);

  const appended = diffLines("a\n", "a\nb\n");
  check("a trailing newline is not a line", [appended.added, appended.removed], [1, 0]);

  const long = diffLines(null, Array.from({ length: 70 }, (_, i) => `line ${i}`).join("\n"));
  check("an over-long diff is clipped", long.hunks[0]?.lines.length, 60);
  check("and says how much it is not showing", long.omitted, 10);
  check("while the count stays the true one", [long.added, long.removed], [70, 0]);

  // A claude Edit's first location line is the hunk's `newStart`; the fragment carries nothing else.
  const placed = diffLines("c", "X", 24);
  check("a fragment is numbered from where it sits", placed.hunks[0]?.lines.map((l) => l.newNo ?? l.oldNo), [24, 24]);

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

  // 700 lines a side is 490 000 cells, past the 250 000 cell budget.
  const wall = (salt: string): string => Array.from({ length: 700 }, (_, i) => `${salt} ${i}`).join("\n");
  const huge = diffLines(wall("a"), wall("b"));
  check("past the cell budget it is one replacement", [huge.wholeFile, huge.added, huge.removed], [true, 700, 700]);
  const nearly = diffLines(wall("a"), wall("a").replace("a 400", "CHANGED"));
  check("while one changed line in a large file is still one hunk", [nearly.hunks.length, nearly.added], [1, 1]);

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
  check("a location with no line is just the path", formatLocation({ path: "a.ts", line: null }), "a.ts");
  check("and one with a line carries it", formatLocation({ path: "a.ts", line: 12 }), "a.ts:12");
}

process.stdout.write("\ntool arguments\n");
{
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

  check("a command is lifted out of the JSON", readInput({ command: "ls -la" }).command, "ls -la");
  check("and the JSON is not shown beside it", readInput({ command: "ls -la" }).pretty, null);
  check("a bare string is a command", readInput("git status").command, "git status");
  check("trimmed", readInput("  git status  ").command, "git status");

  const cut = readInput({ truncated: true, bytes: 9000 });
  check("the truncation stand-in is reported as truncated", [cut.truncated, cut.command], [true, null]);

  check("an unrecognised shape falls back to JSON", readInput({ depth: 3 }).pretty, '{\n  "depth": 3\n}');

  const cyclic: Record<string, unknown> = { name: "x" };
  cyclic["self"] = cyclic;
  check("a cyclic value is no detail rather than an exception", readInput(cyclic).pretty, null);
  check("and a throwing toJSON is too", readInput({ toJSON() { throw new Error("no"); } }).pretty, null);

  check("an empty object has no input", hasInput({}), false);
  check("nor does null", hasInput(null), false);
  check("nor whitespace", hasInput("  "), false);
  check("a command does", hasInput({ command: "ls" }), true);
  check("a path does", hasInput({ file_path: "/a" }), true);
  check("and so does the truncation stand-in", hasInput({ truncated: true, bytes: 9000 }), true);
  check("and so does a body alone", [hasInput({ content: "hi" }), hasInput({ new_string: "b" }), hasInput({ text: "t" })], [true, true, true]);
  const found = (value: unknown): boolean => Object.values(readInput(value)).some((field) => field !== null && field !== false);
  const shapes: unknown[] = [
    {}, [], "", "  ", null, undefined, "ls",
    { command: "ls" }, { file_path: "/a" }, { content: "hi" }, { newText: "b" }, { content: "  " },
    { truncated: true, bytes: 9000 }, { depth: 3 }, { description: "d" }, { plan: "p" },
  ];
  check("hasInput is readInput finding anything, for every shape", shapes.map(hasInput), shapes.map(found));
  report(
    "so a later update's arguments win over an empty call",
    !hasInput({}) && hasInput({ command: "echo hi" }),
    "tool_call {} → tool_call_update {command}",
  );
}

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
    // `f` shares `b`'s status and only the exit reason separates them; a graceful restart writes `daemon_shutdown`.
    row("f", {
      status: "exited",
      exit: { reason: "daemon_shutdown" },
      agentSessionId: "a_f",
      lastEventAt: 25,
    }),
    row("g", {
      status: "interrupted",
      exit: { reason: "daemon_restarted" },
      agentSessionId: "a_g",
      resume: { state: "failed", attempts: 3, error: { code: "agent_auth_required", message: "no" }, at: 0 },
      lastEventAt: 5,
    }),
    row("h", {
      status: "parked",
      exit: { reason: "parked" },
      agentSessionId: "a_h",
      lastEventAt: 15,
    }),
  ];
  const state = { sessions, machines: [] } as never;
  const lists = sessionLists(state);

  check("blocked sessions sort by their oldest pending permission", lists.blocked.map((r) => r.snapshot.id), ["d", "c"]);
  check("the live buckets are memberships rather than orders", lists.active.map((r) => r.snapshot.id).sort(), ["a", "e", "f", "g", "h"]);
  check("only a session somebody ended is filed as ended", lists.ended.map((r) => r.snapshot.id), ["b"]);
  check("a released agent leaves its conversation in Active", lists.active.some((r) => r.snapshot.id === "h"), true);
  check("and a blocked session is never also counted active", lists.active.length + lists.blocked.length, 7);
  // Five: the four live plus `f`; not `b` (ended) and not `g` (the daemon gave up).
  check("the machine count is live sessions, not every session", lists.countByMachine.get("m" as never), 5);
  check("and a released agent is in the list without being counted", lists.active.length, 5);
  check("and ended rows are still in the list, just not counted", lists.ended.length, 1);

  report("the derivation is memoised by identity", sessionLists(state) === lists, "same object returned");

  check("isTerminal agrees with the split", [isTerminal("running"), isTerminal("exited")], [false, true]);
}

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

  check("Enter while an IME is composing does not send", shouldSend({ key: "Enter", isComposing: true }), false);

  check("a textarea counts as typing", isTypingInto({ tagName: "TEXTAREA" }), true);
  check("as does an input", isTypingInto({ tagName: "INPUT" }), true);
  check("and a contenteditable", isTypingInto({ tagName: "DIV", isContentEditable: true }), true);
  check("a plain div does not", isTypingInto({ tagName: "DIV" }), false);
  check("and neither does nothing at all", isTypingInto(null), false);
  check("a modifier disqualifies a bare shortcut", isBareKey({ key: "j", metaKey: true }), false);

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

  check("Enter while an IME is composing chooses nothing", completionKey({ key: "Enter", isComposing: true }), null);
  check("and a shifted Enter or Tab is left alone", [
    completionKey({ key: "Enter", shiftKey: true }),
    completionKey({ key: "Tab", shiftKey: true }),
  ], [null, null]);

  check("Enter is the one key both claim", [shouldSend({ key: "Enter" }), completionKey({ key: "Enter" })], [true, "choose"]);
  check("and the menu's other keys never send", [
    shouldSend({ key: "ArrowDown" }),
    shouldSend({ key: "ArrowUp" }),
    shouldSend({ key: "Tab" }),
    shouldSend({ key: "Escape" }),
  ], [false, false, false, false]);

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
  check("an IME candidate neither completes nor sends", [
    composerKey({ key: "Enter", isComposing: true }, true, true),
    composerKey({ key: "Enter", isComposing: true }, false, true),
  ], [null, null]);
  check("a shifted Enter is left to the textarea, menu or no menu", [
    composerKey({ key: "Enter", shiftKey: true }, true, true),
    composerKey({ key: "Enter", shiftKey: true }, false, true),
  ], [null, null]);

  check("on a soft keyboard Enter is a newline rather than a send", composerKey({ key: "Enter" }, false, false), null);
  check("but the menu still takes it there", composerKey({ key: "Enter" }, true, false), "choose");
  check("and so do the keys the menu owns", [
    composerKey({ key: "ArrowDown" }, true, false),
    composerKey({ key: "Escape" }, true, false),
  ], ["next", "dismiss"]);

  {
    const composer = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
    check("the newline button is gone", /CornerDownLeft/.test(composer), false);
    check("and the soft Return key is drawn as one", /enterKeyHint="enter"/.test(composer), true);
    check(
      "the pointer is read at the keystroke and negated into `enterSends`",
      /!window\.matchMedia\("\(pointer: coarse\)"\)\.matches/.test(composer),
      true,
    );
  }

  {
    const composer = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
    const bar = readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8");
    // Stripped: the bar's docblocks name `ContextPie`, the form and the submit type in prose.
    const barCode = stripComments(bar);

    check(
      "the composer's box is the bounded control",
      /className=\{`relative rounded-xl border border-edge-strong/.test(composer),
      true,
    );
    check(
      "and it is the form, so nothing under it may default to submit",
      /<form\n\s+onSubmit=\{submit\}\n\s+className=\{`relative rounded-xl/.test(composer),
      true,
    );
    check(
      "and the textarea inside it draws neither a border nor a fill",
      /className="no-focus-ring block min-h-11 w-full resize-none overflow-hidden bg-transparent/.test(composer),
      true,
    );
    check("the box looks the same focused and not", /focus-within:/.test(composer), false);

    // The paperclip is the composer's and the strip has no `leading` slot, which retired `configBarShows`.
    check("the composer draws its own paperclip", /icon={Paperclip}\n\s+label="Attach a file"/.test(composer), true);
    check("beside the strip rather than inside it", /<AgentConfigBar/.test(composer), true);
    check("and hands it no `leading` node", /leading=/.test(composer), false);

    check("no context readout is drawn", /ContextPie/.test(barCode), false);

    {
      const typeless = [...barCode.matchAll(/<button\b/g)]
        .map((match) => barCode.slice(match.index, barCode.indexOf(">", match.index)))
        .filter((tag) => !/\btype=/.test(tag));
      check("no button in the strip can submit a form by default", typeless, []);
      check("and the scan found the buttons", [...barCode.matchAll(/<button\b/g)].length >= 4, true);
      const composerCode = stripComments(composer);
      const composerTypeless = [...composerCode.matchAll(/<button\b/g)]
        .map((match) => composerCode.slice(match.index, composerCode.indexOf(">", match.index)))
        .filter((tag) => !/\btype=/.test(tag));
      check("nor anything hand-rolled in the composer itself", composerTypeless, []);
    }

    check(
      "the model chip is folded by a class rather than by a measurement",
      /foldedBelowSm\.length > 0 \? "hidden sm:contents" : "contents"/.test(barCode),
      true,
    );
    check(
      "and only where a live mode control exists to fold into",
      /category === NESTED_HOST && one\.kind !== "boolean" && !unavailable\.has\(one\.id\)/.test(barCode),
      true,
    );
    check(
      "and nothing in the strip asks the window how wide it is",
      /matchMedia|innerWidth|ResizeObserver/.test(barCode),
      false,
    );
    check("the anchored panel is the wide one", /hidden w-60 max-w-\[calc\(100vw-1\.5rem\)\] sm:block/.test(barCode), true);
    check(
      "and the sheet is the narrow one",
      /fixed inset-x-0 bottom-0 \$\{LAYER\.overlay\} flex w-full flex-col[^`]*sm:hidden`/.test(barCode),
      true,
    );
    // Not `Sheet`: it inerts #root on mount, which a display class cannot gate.
    check("the picker registers as a menu and never as a sheet", /useDismissible\("sheet"/.test(barCode), false);
    check("so nothing here can make the app inert", /inert/.test(barCode), false);
    check("an id says which presentation it is in", /\$\{where\}-\$\{option\.id\}-refusal/.test(barCode), true);
    check(
      "the outside-press test covers the portalled sheet as well as the panel",
      /boxRef\.current\?\.contains\(target\) === true \|\|\s+sheetRef\.current\?\.contains\(target\) === true/.test(barCode),
      true,
    );
    // A press on the scrim once closed the picker, so it could not be dragged and its tap clicked what lay under it (Q3.660).
    check(
      "and so is the scrim, which closes on its own click instead",
      [/scrimRef\.current\?\.contains\(target\) === true;/.test(barCode), /onClick=\{leaving \? undefined : dismiss\}/.test(barCode)],
      [true, true],
    );
    check("and the ref is on the panel rather than on the scrim", /<div\n\s+ref=\{drag\.ref\}\n\s+\{\.\.\.drag\.bind\}/.test(barCode), true);
    // Its parent once, so scrim-out faded the panel as it slid (Q3.650).
    check(
      "and the scrim is the panel's sibling rather than its parent",
      /bg-scrim sm:hidden`\}\n\s+\/>\n\s+<div\n\s+ref=\{drag\.ref\}/.test(barCode),
      true,
    );
    check(
      "and it stops taking taps the instant it starts to leave",
      /leaving \? "animate-scrim-out pointer-events-none" : "animate-scrim"/.test(barCode),
      true,
    );

    {
      const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
      check(
        "the sheet keeps its layer and its element for exactly its exit",
        [
          /useLeaving\(open, SHEET_MS\)/.test(barCode),
          /useDismissible\("menu", dismiss, shown\)/.test(barCode),
          /\{shown &&\n\s+createPortal/.test(barCode),
          /onAnimationEnd=\{onAnimationEnd\}/.test(barCode),
        ],
        [true, true, true, true],
      );
      check("and no timer of its own stands in for that exit", /SHEET_EXIT_MS|exit\.current/.test(barCode), false);
      // Each exit needs keyframes of its own: swapping the class on one node never restarts a finished animation.
      check(
        "the sheet's exit has keyframes of its own",
        [/--animate-sheet-out: sheet-out /.test(css), /@keyframes sheet-out \{/.test(css)],
        [true, true],
      );
      check(
        "and so does the scrim's",
        [/--animate-scrim-out: scrim-out /.test(css), /@keyframes scrim-out \{/.test(css)],
        [true, true],
      );
      check(
        "neither exit is the arrival's own name replayed",
        /--animate-(?:sheet|scrim)-out: (?:sheet|scrim) /.test(css),
        false,
      );
      check("the anchored panel does not linger", /\{open && \(\n\s+<div\n\s+role="listbox"/.test(barCode), true);
    }

    check(
      "the grab bar is a button rather than a decoration",
      /aria-expanded=\{expanded\}\n\s+className=\{`tap relative flex min-h-8 shrink-0 touch-none/.test(barCode),
      true,
    );
    check("and it reaches 44px by growing rather than by padding", /justify-center \$\{TAP_GROW_Y\}`\}/.test(barCode), true);
    check("and a tap on it takes the same way to a detent a drag does", /onClick=\{\(\) => settleTo\(expanded \? "rest" : "full"\)\}/.test(barCode), true);
    check(
      "and the panel clips rather than scrolls",
      /flex w-full flex-col overflow-hidden overscroll-contain rounded-t-2xl/.test(barCode),
      true,
    );
    check(
      "the rows scroll only once the sheet is full",
      /expanded \? "flex-1 overflow-y-auto" : "touch-none overflow-hidden"/.test(barCode),
      true,
    );
    // Found by what it is (Q3.651): a hand-written mark was one more thing a new scroller could forget.
    check("and the list carries no mark for the drag to find it by", /data-sheet-scroll/.test(barCode), false);
    {
      const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
      const rule = /\.config-sheet \{([^}]*)\}/.exec(css)?.[1] ?? "";
      check(
        "rest is a default in the stylesheet rather than a class on the panel",
        [/--sheet-max, 60dvh/.test(css), /--sheet-min, 0/.test(css), /--sheet-h, auto/.test(css)],
        [true, true, true],
      );
      // A class transition animated every write, including the one that says the panel is already where it is.
      check("and the stylesheet animates none of that geometry", [rule.length > 0, /transition|transform/.test(rule)], [true, false]);
      check("and the full detent is the routed sheets' phone height", /const SHEET_FULL = "92dvh";/.test(barCode), true);
      check(
        "a short picker can be pulled open too",
        /"--sheet-min": SHEET_FULL, "--sheet-max": SHEET_FULL/.test(barCode),
        true,
      );
      check("the geometry has exactly one writer", /ref=\{drag\.ref\}[\s\S]{0,2000}?style=/.test(barCode), false);
      check("and the panel wears the class that declares it", /className=\{`config-sheet pb-safe/.test(barCode), true);
    }
    {
      const share = /const SHEET_FULL_SHARE = ([\d.]+);/.exec(barCode)?.[1];
      const dvh = /const SHEET_FULL = "(\d+)dvh";/.exec(barCode)?.[1];
      check("both spellings of the full detent were found", [share !== undefined, dvh !== undefined], [true, true]);
      check("and they are the same height", share, dvh === undefined ? undefined : String(Number(dvh) / 100));
    }
    check("the drag is the shared one", /useSheetGesture<HTMLDivElement>\(\{ axis: "down", enabled: open, geometry, held: sheetRef, scrim: scrimRef \}\)/.test(barCode), true);
    check(
      "and nothing here listens to a pointer, captures one or swallows a click itself",
      /onPointer(?:Down|Move|Up|Cancel)=|setPointerCapture|onClickCapture/.test(barCode),
      false,
    );
    check(
      "the drag reads where the panel is drawn when it starts, mid-settle included",
      [/const height = panel\.getBoundingClientRect\(\)\.height;/.test(barCode), /top\.current = height - hold\(panel, "down"\);/.test(barCode)],
      [true, true],
    );
    {
      const move = /move: \(travel\) => \{([\s\S]*?)\n    \},/.exec(barCode)?.[1] ?? "";
      report("the move was found", move.length > 0, `${move.length} chars`);
      // A height per move laid out every row and re-rasterised the bar at a new phase each frame (Q3.651).
      check(
        "every move is one translate of a panel already laid out at full, and nothing moves it past full",
        [/live\.current = Math\.min\(top\.current - travel, fullHeight\(\)\);\s+slide\(panel, "down", fullHeight\(\) - live\.current\);/.test(move), /paint\(|resisted/.test(move)],
        [true, false],
      );
    }
    check(
      "the panel is laid out at full once, when a drag engages",
      [
        /const stretch = \(panel: HTMLDivElement\): void => \{\s+const full = `\$\{String\(fullHeight\(\)\)\}px`;\s+paint\(\{ "--sheet-h": full, "--sheet-min": full, "--sheet-max": full \}\);/.test(barCode),
        /top\.current = height - hold\(panel, "down"\);\s+stretch\(panel\);/.test(barCode),
      ],
      [true, true],
    );
    check(
      "a release below rest is the shared decision, above it a detent a fling can choose",
      [/sheetRelease\(rest - shows, velocity, rest\)/.test(barCode), /detentAfter\(shows, velocity, rest, fullHeight\(\)\)/.test(barCode)],
      [true, true],
    );
    check(
      "a settle moves only the transform",
      [/settleTransition\(\["transform"\]\)/.test(barCode), /settleTransition\(\["height"/.test(barCode)],
      [true, false],
    );
    check(
      "a settle from a tap commits the stretched start before any transition exists",
      /stretch\(panel\);\s+panel\.getBoundingClientRect\(\);\s+\}\s+panel\.style\.transition = settleTransition\(/.test(barCode),
      true,
    );
    check(
      "and hands the height back to the defaults in one write, with nothing animating",
      /letGo\(panel\);\s+slide\(panel, "down", 0\);\s+paint\(detent === "full" \? FULL_DEFAULTS : REST_DEFAULTS\);/.test(barCode),
      true,
    );
    check("and the only render it costs is the list's detent", barCode.match(/setExpanded\(/g)?.length, 2);
    check(
      "a reopened picker is back at rest, with nothing carried over",
      /paint\(REST_DEFAULTS\);\n\s+restH\.current = null;\n\s+setExpanded\(false\);\n\s+setOpen\(true\);/.test(barCode),
      true,
    );
    check(
      "and rest is written as nothing rather than as numbers",
      /const REST_DEFAULTS = \{ "--sheet-h": null, "--sheet-min": null, "--sheet-max": null \};/.test(barCode),
      true,
    );
    check(
      "a section heading is drawn with the same glyph its chip is",
      barCode.match(/<p className=\{`\$\{MENU_HEADING\} flex items-center gap-1\.5`\}>\n\s+\{label\(option\)\}/g)?.length,
      2,
    );
  }
}

process.stdout.write("\nthe agent config bar reads categories, not ids\n");
{
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
  check(
    "and the reconciliation is by category, not by recognising the words",
    labelFor({ category: "unheard_of", name: "Session Mode" }),
    "Session Mode",
  );

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
  check(
    "a value this client does rename is renamed, not merely capitalised",
    [
      choiceLabel({ category: "thought_level" }, modeChoice("default", "Default")),
      choiceLabel({ category: "mode" }, modeChoice("default", "default")),
    ],
    ["Adaptive", "Default"],
  );

  const choice = (value: string, name: string, group: string | null = null) => ({
    value,
    name,
    description: null,
    group,
  });
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
  check(
    "and no heading is derived from it",
    drawnChoices({ choices: openrouterModels } as never).map((one: { group: string | null }) => one.group),
    [null, null, null],
  );
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
  check(
    "the first separator is the provider and everything after it is the model",
    drawnChoices({
      choices: [choice("openrouter/qwen/qwen3-coder", "OpenRouter/qwen/Qwen3 Coder")],
    } as never).map((one: { group: string | null; name: string }) => [one.group, one.name]),
    [[null, "qwen/Qwen3 Coder"]],
  );

  // Neither the per-vendor split (Q3.503) nor a cut at the first slash by name (Q3.507): only routed lists whose every row shares the prefix.
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
  check(
    "a value that is all namespace and no model does not count as routed",
    [
      drawnChoices({ choices: [choice("openrouter/", "OpenRouter/One")] } as never)[0]?.name,
      drawnChoices({ choices: [choice("/gpt-5", "OpenRouter/Two")] } as never)[0]?.name,
    ],
    ["OpenRouter/One", "OpenRouter/Two"],
  );


  // A caption is drawn exactly where `CATEGORY_ICON` has no entry (Q3.559).
  check(
    "a chip with a glyph says only its value",
    ["mode", "model", "thought_level", "model_config"].map((category) => showsCaption({ category })),
    [false, false, false, false],
  );
  check(
    "and only a category we draw no icon for keeps its name",
    [showsCaption({ category: "unheard_of" }), showsCaption({ category: null })],
    [true, true],
  );
  {
    const bar = stripComments(readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8"));
    const iconed = [...bar.slice(bar.indexOf("const CATEGORY_ICON"), bar.indexOf("};", bar.indexOf("const CATEGORY_ICON")))
      .matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1] ?? "");
    check("the icon table was found", iconed.length >= 4, true);
    check(
      "and nothing with a glyph draws its name",
      iconed.filter((category) => showsCaption({ category })),
      [],
    );
  }

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
  // The chip draws the name `withUltracode` gives the row it appends; `CATEGORY_RESERVE` is gone (Q3.564).
  {
    const ultracode = {
      ...effortOption,
      value: "ultracode",
      choices: [
        ...effortOption.choices,
        { value: "ultracode", name: "Ultracode", description: null, group: null },
      ],
    } as never;
    // The second argument is `available`; omitting it asserts the placeholder instead.
    check("the effort chip draws the daemon's own name for the row it adds", chipParts(ultracode, true).value, "Ultracode");
  }

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

  {
    const strip = readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const composerSrc = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const count = (text: string, needle: string) => text.split(needle).length - 1;

    // `applyConfigChange` is declared above the component, so the slice before it is the dispatcher.
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
    check("while still being a second caller", count(composerSrc, "applyConfigChange(") >= 1, true);
    check("and a model change asks the effort rule before returning", /effortFollowUp\(/.test(dispatcher), true);
    check("sending the follow-up through the dispatcher itself", /return applyConfigChange\(sessionRef, followUp\.configId, followUp\.value\)/.test(dispatcher), true);
    check(
      "and the daemon is still asked in exactly one place",
      count(strip, "setConfig(") + count(composerSrc, "setConfig("),
      1,
    );
  }

  {
    const model = { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "k3", choices: [] };
    const kimiOld = { ...effortOption, id: "thinking", value: "max", choices: [
      { value: "low", name: "Thinking Low", description: null, group: null },
      { value: "high", name: "Thinking High", description: null, group: null },
      { value: "max", name: "Thinking Max", description: null, group: null },
    ] };
    const kimiNew = { ...kimiOld, choices: [
      { value: "on", name: "Thinking on", description: null, group: null },
      ...kimiOld.choices,
    ] };
    const before = [model, kimiOld] as never;
    check("a model change onto a different effort list sets the first choice", effortFollowUp(model, before, [model, kimiNew] as never), { configId: "thinking", value: "on" });
    check("and the `default` choice where the list has one", effortFollowUp(model, before, [model, { ...effortOption, value: "max" }] as never), { configId: "effort", value: "default" });
    check("the same list means nothing to do", effortFollowUp(model, before, [model, kimiOld] as never), null);
    check("nor a model with no effort control", effortFollowUp(model, before, [model] as never), null);
    check("nor one whose old model had none, since the agent's own default applies", effortFollowUp(model, [model] as never, [model, kimiNew] as never), null);
    check("nor when the default is already the value", effortFollowUp(model, before, [model, { ...kimiNew, value: "on" }] as never), null);
    check("and only a model change asks", effortFollowUp(kimiOld, before, [model, kimiNew] as never), null);
    check("an unknown option asks nothing", effortFollowUp(undefined, before, [model, kimiNew] as never), null);
  }

  check(
    "a control with nothing left to choose still draws a chip rather than a hole",
    [
      chipParts({ ...effortOption, choices: [] } as never, false),
      chipParts({ ...effortOption, kind: "boolean", value: true, choices: [] } as never, false),
    ],
    [
      { caption: null, value: "—" },
      { caption: null, value: "—" },
    ],
  );

  const fast = { id: "fast", name: "Fast mode", description: null, category: "model_config", kind: "boolean", value: true, choices: [] };
  const odd = { id: "x", name: "Odd", description: null, category: "something_new", kind: "select", value: "a", choices: [] };
  const uncategorised = { id: "y", name: "Uncategorised", description: null, category: null, kind: "select", value: "b", choices: [] };

  const slots = splitOptions([...claude, fast, odd, uncategorised] as never);
  check("mode goes left", slots.left.map((o: { id: string }) => o.id), ["mode"]);
  check("model and effort go right, in reading order", slots.right.map((o: { id: string }) => o.id), ["model", "effort"]);
  check("model_config is hidden outright", slots.hidden.map((o: { id: string }) => o.id), ["fast"]);
  check("but an unknown category is still reachable", slots.overflow.map((o: { id: string }) => o.id).sort(), ["x", "y"]);

  check("the slot comes from the category", slotFor({ category: "mode" }), "left");
  check("model and effort share the right-hand slot", [slotFor({ category: "model" }), slotFor({ category: "thought_level" })], ["right", "right"]);
  check("a known category we hide is hidden", slotFor({ category: "model_config" }), "hidden");
  check("an unknown one is demoted, not dropped", slotFor({ category: "something_new" }), "overflow");
  check("and so is a control with no category at all", slotFor({ category: null }), "overflow");

  // `nested` must be in this sum, or its options vanish from the check that nothing is lost.
  const total =
    slots.left.length + slots.right.length + slots.overflow.length + slots.hidden.length + slots.nested.length;
  check("every option lands in exactly one slot, and none is lost", total, 6);
  check("kimi's controls split the same way", splitOptions(kimi as never).right.map((o: { id: string }) => o.id), ["model", "thinking"]);

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
  check("and the strip carries no overflow button for codex", codexSlots.overflow, []);
  check("while the visible chips are the ones every agent has", [
    codexSlots.left.map((o: { id: string }) => o.id),
    codexSlots.right.map((o: { id: string }) => o.id),
  ], [["mode"], ["model", "reasoning_effort"]]);

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
  // A boolean has no choices to nest and `toEntries` skips booleans, so it must fall back to overflow.
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

process.stdout.write("\narrow keys inside a menu that claims to be one\n");
{
  const { listNavKey, nextOptionIndex } = await import("../src/keys.js");

  check("the list walks on the arrows", [listNavKey({ key: "ArrowDown" }), listNavKey({ key: "ArrowUp" })], [
    "next",
    "prev",
  ]);
  check("and jumps on Home and End", [listNavKey({ key: "Home" }), listNavKey({ key: "End" })], ["first", "last"]);

  check("Escape belongs to the overlay arbiter and is not claimed here", listNavKey({ key: "Escape" }), null);
  check("Enter and Space are left to the button", [listNavKey({ key: "Enter" }), listNavKey({ key: " " })], [null, null]);
  check("an ordinary letter means nothing to a list", listNavKey({ key: "j" }), null);
  check("and an arrow while an IME is composing is the IME's", listNavKey({ key: "ArrowDown", isComposing: true }), null);
  check("as is any chord", [
    listNavKey({ key: "ArrowDown", metaKey: true }),
    listNavKey({ key: "ArrowUp", ctrlKey: true }),
    listNavKey({ key: "Home", altKey: true }),
  ], [null, null, null]);

  check("from nowhere, Down takes the first row", nextOptionIndex("next", -1, 4), 0);
  check("and Up takes the last", nextOptionIndex("prev", -1, 4), 3);
  check("otherwise it steps", [nextOptionIndex("next", 1, 4), nextOptionIndex("prev", 2, 4)], [2, 1]);

  check("the end wraps to the start", nextOptionIndex("next", 3, 4), 0);
  check("and the start wraps to the end", nextOptionIndex("prev", 0, 4), 3);
  check("Home and End ignore where focus was", [nextOptionIndex("first", 2, 4), nextOptionIndex("last", 2, 4)], [0, 3]);

  check("an empty list has nowhere to go", [
    nextOptionIndex("next", -1, 0),
    nextOptionIndex("first", -1, 0),
  ], [null, null]);
  check("and no key at all goes nowhere", nextOptionIndex(null, 1, 4), null);

  const bitsRaw = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
  // Comments stripped first: bits.tsx's docblocks quote the very strings counted here.
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const bitsSrc = strip(bitsRaw);
  check("both panels take the keys", (bitsSrc.match(/onKeyDown=\{onKeyDown\}/g) ?? []).length, 2);
  check("and neither reaches for a global listener", /window\.addEventListener\("keydown"/.test(bitsSrc), false);

  check("and both can hold focus themselves", (bitsSrc.match(/tabIndex=\{-1\}/g) ?? []).length, 2);

  const listCode = strip(bitsRaw.slice(bitsRaw.indexOf("function focusableRows"), bitsRaw.indexOf("A panel anchored to")));
  check("the list's focus calls never scroll the page", [
    // Three that move focus for the reader: opening, restoring, and each arrow.
    (listCode.match(/\.focus\(\{ preventScroll: true \}\)/g) ?? []).length,
    // And one that does not: the body fallback, with nothing to reveal.
    (listCode.match(/\.focus\(\)/g) ?? []).length,
    (listCode.match(/document\.body\.focus\(\)/g) ?? []).length,
  ], [3, 1, 1]);
  check("and a trigger that did not survive falls back like Sheet's", /back\.isConnected/.test(listCode), true);
}
