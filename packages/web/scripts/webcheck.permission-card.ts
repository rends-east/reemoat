import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";
import {
  askedQuestion,
  detailContext,
  essentialContext,
  optionLabel,
  permissionButtons,
  permissionContext,
  permissionHeadline,
  permissionLayout,
  planControls,
  truncationNotice,
  unreduceSnapshot,
  withheldDetail,
} from "./webcheck.modules.js";

process.stdout.write("\nthe permission card's context\n");
{
  const base = { permissionId: "p1", toolCallId: null, title: "Running", options: [], raisedAt: 0 };

  // kimi sends the command as an ACP text block with a null rawInput, so text blocks are content, not decoration.
  const fromText = permissionContext(
    { ...base, rawInput: null, content: [{ type: "content", content: { type: "text", text: "echo hello" } }] } as never,
    [],
  );
  check("a command in a text block is found", fromText.text, ["echo hello"]);
  check("and the card is not reported empty", fromText.unavailable, false);

  const truncatedInput = permissionContext(
    { ...base, rawInput: { truncated: true, bytes: 9000 }, content: null } as never,
    [],
  );
  check("a truncated rawInput is reported as truncated", truncatedInput.truncated, true);

  const truncatedContent = permissionContext(
    { ...base, rawInput: null, content: { truncated: true, bytes: 9000 } } as never,
    [],
  );
  check("a truncated content is too", truncatedContent.truncated, true);
  check("and does not claim the tool call is missing", truncatedContent.unavailable, false);

  const both = permissionContext(
    {
      ...base,
      rawInput: { truncated: true, bytes: 9000 },
      content: [{ type: "content", content: { type: "text", text: "rm -rf /tmp/x" } }],
    } as never,
    [],
  );
  check("a truncated rawInput still surfaces the command text", both.text, ["rm -rf /tmp/x"]);

  const nothing = permissionContext({ ...base, rawInput: null, content: null } as never, []);
  check("genuinely nothing is reported as unavailable", nothing.unavailable, true);

  const writeEvents = [
    { seq: 1, at: 0, event: { type: "tool_call", toolCallId: "tc_w", title: "Write", kind: "edit", status: "pending", rawInput: null, locations: [] } },
    {
      seq: 2,
      at: 0,
      event: {
        type: "tool_call_update",
        toolCallId: "tc_w",
        title: null,
        status: "in_progress",
        rawInput: null,
        locations: [],
        content: [JSON.stringify({ path: "tictactoe.py", content: "line1\nline2\nline3" })],
      },
    },
  ];
  const write = permissionContext(
    {
      ...base,
      toolCallId: "tc_w",
      title: "Write",
      rawInput: null,
      content: [{ type: "content", content: { type: "text", text: "Requesting approval to Writing tictactoe.py" } }],
    } as never,
    writeEvents as never,
  );
  check("the file being written is recovered from the call's update", write.body, "line1\nline2\nline3");
  check("and so is the path it is going to", write.target, "tictactoe.py");
  check("the sentence repeating the target is dropped", write.text, []);
  check("and the target itself is still there to be drawn", write.target, "tictactoe.py");

  const kimiBash = permissionContext(
    {
      ...base,
      title: "Bash",
      rawInput: { command: "printf '1\\n5\\n' | python3 tictactoe.py" },
      content: [
        {
          type: "content",
          content: { type: "text", text: "Requesting approval to Running: printf '1\\n5\\n' | python3 tictactoe.py" },
        },
      ],
    } as never,
    [],
  );
  check("the command survives", kimiBash.command, "printf '1\\n5\\n' | python3 tictactoe.py");
  check("and the sentence repeating it does not", kimiBash.text, []);
  check(
    "a description that mentions neither is untouched",
    permissionContext(
      {
        ...base,
        rawInput: { command: "rm x" },
        content: [{ type: "content", content: { type: "text", text: "tidying up x" } }],
      } as never,
      [],
    ).text,
    ["tidying up x"],
  );
  check("and it is not mistaken for arguments", write.rawInput, null);

  check(
    "a write with a path reads as a request",
    permissionHeadline("kimi", "Write", write),
    // write rather than edit: this payload carries a whole body and no diff.
    "Allow Kimi to write tictactoe.py?",
  );
  check(
    "a long path is the file's name in the heading",
    permissionHeadline("claude", "Write", {
      ...write,
      kind: "edit",
      target: "/Users/dev/projects/some long folder name/permission-test.txt",
    }),
    "Allow Claude to write permission-test.txt?",
  );
  check(
    "and the whole of it survives on the card",
    essentialContext({ ...write, target: "/Users/dev/projects/some long folder name/permission-test.txt" }).target,
    "/Users/dev/projects/some long folder name/permission-test.txt",
  );
  check(
    "a URL keeps its host, because the last segment is not the point there",
    permissionHeadline("claude", "Fetch", { ...write, kind: "fetch", target: "https://example.com/a/b" }),
    "Allow Claude to fetch https://example.com/a/b?",
  );

  // codex sends no title (the call id stands in) and no kind, so the verb comes from the command and the object is generic.
  const codexExec = permissionContext(
    {
      ...base,
      title: "exec-b34af4d4-869e-478f-9762-9255ac71f84b",
      // Quoted as codex sent it: trimming the quotes would edit a command before it is approved.
      rawInput: { command: `"curl -sS -o /dev/null -w '%{http_code}' https://example.com"`, cwd: "/w/s_x" },
      content: null,
    } as never,
    [],
  );
  check("codex puts the command on rawInput, where it is found", codexExec.command, `"curl -sS -o /dev/null -w '%{http_code}' https://example.com"`);
  check("and sends no kind with the request", codexExec.kind, null);
  check(
    "so the verb comes from there being a command at all",
    permissionHeadline("codex", "exec-b34af4d4-869e-478f-9762-9255ac71f84b", codexExec),
    "Allow Codex to run this command?",
  );
  check("and the tool call id never surfaces as a heading", permissionHeadline("codex", "exec-b34af4d4-869e-478f-9762-9255ac71f84b", codexExec).includes("exec-b34af4d4"), false);
  const codexOptions = [
    { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
    { optionId: "accept_execpolicy_amendment", name: "Allow Commands Starting With `curl -sS`", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  ];
  const codexButtons = permissionButtons(codexOptions as never);
  check("and the narrowest grant is still the default", codexButtons.primaryId, "allow_once");
  check("with the refusal leading", codexButtons.order[0]?.optionId, "reject_once");
  // With a duplicate kind optionLabel keeps the agent's own labels: the scope is the whole difference between them.
  check(
    "with two of a kind, no label is replaced by our word for it",
    codexButtons.order.map((o: { optionId: string }) => optionLabel(codexOptions as never, o as never)),
    ["Reject", "Allow for Session", "Allow Commands Starting With `curl -sS`", "Allow Once"],
  );

  // Nothing is ever removed (drawableOptions is gone); the layout is rows exactly when a button row would not hold.
  const layoutOf = (options: unknown): string => permissionLayout(options as never);
  const orderOf = (options: unknown): string[] =>
    permissionButtons(options as never).order.map((o: { optionId: string }) => o.optionId);

  check("every option codex offered is drawn", orderOf(codexOptions), ["reject_once", "allow_always", "accept_execpolicy_amendment", "allow_once"]);
  check("and the card lays them out as rows rather than dropping one", layoutOf(codexOptions), "rows");
  check("the refusal still leads", permissionButtons(codexOptions as never).leading, 1);
  check("and the reversible approval is still primary", permissionButtons(codexOptions as never).primaryId, "allow_once");
  const longRefusal = [
    { optionId: "a", name: "Yes", kind: "allow_once" },
    { optionId: "b", name: "No, and stop asking me about this particular command for ever", kind: "reject_always" },
  ];
  check("a long refusal is kept and does not force rows", [orderOf(longRefusal), layoutOf(longRefusal)], [["b", "a"], "buttons"]);
  const twoRefusals = [
    { optionId: "a", name: "Yes", kind: "allow_once" },
    { optionId: "b", name: "No", kind: "reject_once" },
    { optionId: "c", name: "No, and never ask about /Users/u/reemoat/src again", kind: "reject_once" },
  ];
  check("two refusals, one of them long, are both kept as buttons", [orderOf(twoRefusals), layoutOf(twoRefusals)], [["b", "c", "a"], "buttons"]);
  const onlyLong = [
    { optionId: "a", name: "Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)", kind: "allow_always" },
    { optionId: "b", name: "No", kind: "reject_once" },
  ];
  check("the only way to approve is kept, and gets a row it fits in", [orderOf(onlyLong), layoutOf(onlyLong)], [["b", "a"], "rows"]);
  const claudeThree = [
    { optionId: "a", name: "Yes", kind: "allow_once" },
    { optionId: "b", name: "Yes, and don't ask again", kind: "allow_always" },
    { optionId: "c", name: "No", kind: "reject_once" },
  ];
  check("claude's three are three buttons", [orderOf(claudeThree).length, layoutOf(claudeThree)], [3, "buttons"]);
  const kimiThree = [
    { optionId: "a", name: "Approve", kind: "allow_once" },
    { optionId: "b", name: "Approve for this session", kind: "allow_always" },
    { optionId: "c", name: "Reject", kind: "reject_once" },
  ];
  check("and kimi's three, whose longest is 24 characters", [orderOf(kimiThree).length, layoutOf(kimiThree)], [3, "buttons"]);
  const claudeScoped = [
    { optionId: "s1", name: "Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)", kind: "allow_always" },
    { optionId: "s2", name: "Allow", kind: "allow_once" },
    { optionId: "s3", name: "Reject", kind: "reject_once" },
  ];
  check("a scope is kept, and the card takes rows to show it", [orderOf(claudeScoped), layoutOf(claudeScoped)], [["s3", "s1", "s2"], "rows"]);
  const longAllowOnce = [
    { optionId: "r", name: "Deny", kind: "reject_once" },
    { optionId: "once", name: "Allow once for /Users/u/reemoat/src", kind: "allow_once" },
    { optionId: "always", name: "Approve", kind: "allow_always" },
  ];
  check("the narrow grant is kept, in rows", [orderOf(longAllowOnce), layoutOf(longAllowOnce)], [["r", "always", "once"], "rows"]);
  check("and the filled control is still the reversible approval", permissionButtons(longAllowOnce as never).primaryId, "once");
  // askedQuestion can fail on a truncated rawInput or an unpaged transcript, so kimi's answers can reach this fallback.
  const kimiAnswers = [
    { optionId: "a1", name: "Use SQLite", kind: "allow_once" },
    { optionId: "a2", name: "Use Postgres with a connection pool", kind: "allow_once" },
    { optionId: "a3", name: "Keep everything in memory for now", kind: "allow_once" },
    { optionId: "a4", name: "Let me describe something else", kind: "allow_once" },
    { optionId: "skip", name: "Skip", kind: "reject_once" },
  ];
  check(
    "a question that fell back from a question keeps every answer the model wrote",
    orderOf(kimiAnswers),
    ["skip", "a1", "a2", "a3", "a4"],
  );
  check("and is drawn as the rows it should have had", layoutOf(kimiAnswers), "rows");
  check(
    "and with no kind at all, a body is still enough to say what happens",
    permissionHeadline("kimi", "Write", { ...write, kind: null }),
    "Allow Kimi to write tictactoe.py?",
  );
  check(
    "a hunk is an edit, though — the same kind, the other act",
    permissionHeadline("kimi", "Edit", {
      ...write,
      body: null,
      diffs: [{ type: "file_change", path: "a.ts", oldText: "a", newText: "b", source: "diff", toolCallId: null }],
    } as never),
    "Allow Kimi to edit tictactoe.py?",
  );
  check(
    "and the tool's own description wins over the path",
    permissionHeadline("claude", "Bash", {
      ...write,
      kind: "execute",
      command: "./words.py birthday",
      summary: "Run analogy, odd-one-out and neighbours demos",
    }),
    "Allow Claude to run Run analogy, odd-one-out and neighbours demos?",
  );
  check(
    "a command with neither still says the whole truth",
    permissionHeadline("kimi", "Bash", { ...write, kind: "execute", target: null, body: null, command: "printf x" }),
    "Allow Kimi to run this command?",
  );
  check(
    "an unknown kind falls back to the tool and what it touches",
    permissionHeadline("kimi", "Read", { ...write, kind: null, body: null, target: "/tmp/x.png" }),
    "Read /tmp/x.png",
  );
  check(
    "and a title that already names the target does not say it twice",
    permissionHeadline("kimi", "Read /tmp/x.png", { ...write, kind: null, body: null, target: "/tmp/x.png" }),
    "Read /tmp/x.png",
  );

  const kimiOrder = [
    { optionId: "a", name: "Approve once", kind: "allow_once" },
    { optionId: "b", name: "Approve for this session", kind: "allow_always" },
    { optionId: "c", name: "Reject", kind: "reject_once" },
  ];
  const laid = permissionButtons(kimiOrder as never);
  check("a refusal goes first and the reversible approval last", laid.order.map((o) => o.optionId), ["c", "b", "a"]);
  check("with the refusal alone on the left of the gap", laid.leading, 1);
  check("and allow-once filled, because it is the one that can be taken back", laid.primaryId, "a");

  const planOrder = [
    { optionId: "p1", name: "Yes, and bypass permissions", kind: "allow_always" },
    { optionId: "p2", name: 'Yes, and use "auto" mode', kind: "allow_always" },
    { optionId: "p3", name: "Yes, and auto-accept edits", kind: "allow_always" },
    { optionId: "p4", name: "Yes, and manually approve edits", kind: "allow_once" },
    { optionId: "p5", name: "No, keep planning", kind: "reject_once" },
  ];
  check(
    "everything else keeps the place the agent gave it",
    permissionButtons(planOrder as never).order.map((o) => o.optionId),
    ["p5", "p1", "p2", "p3", "p4"],
  );

  check(
    "an unknown kind is an approval rather than a guess",
    permissionButtons([{ optionId: "x", name: "?", kind: "something_new" }] as never),
    { order: [{ optionId: "x", name: "?", kind: "something_new" }], leading: 0, primaryId: "x" },
  );
  check(
    "and a request with nothing to approve has no primary",
    permissionButtons([{ optionId: "n", name: "No", kind: "reject_once" }] as never).primaryId,
    null,
  );
  check("no options at all is not a crash", permissionButtons([]), { order: [], leading: 0, primaryId: null });

  check(
    "kimi's three become the words the kind already carries",
    kimiOrder.map((o) => optionLabel(kimiOrder as never, o as never)),
    ["Allow once", "Always allow", "Deny"],
  );

  check(
    "a repeated kind keeps every name in the request, not just its own",
    planOrder.map((o) => optionLabel(planOrder as never, o as never)),
    [
      "Yes, and bypass permissions",
      'Yes, and use "auto" mode',
      "Yes, and auto-accept edits",
      "Yes, and manually approve edits",
      "No, keep planning",
    ],
  );

  const scoped = [
    { optionId: "s1", name: "Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)", kind: "allow_always" },
    { optionId: "s2", name: "Allow", kind: "allow_once" },
    { optionId: "s3", name: "Reject", kind: "reject_once" },
  ];
  check(
    "a scoped grant keeps its scope",
    scoped.map((o) => optionLabel(scoped as never, o as never)),
    ["Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)", "Allow once", "Deny"],
  );

  check(
    "an unknown kind is left alone, because there is no better version of it",
    optionLabel(
      [{ optionId: "x", name: "Do the thing", kind: "something_new" }] as never,
      { optionId: "x", name: "Do the thing", kind: "something_new" } as never,
    ),
    "Do the thing",
  );

  const writeEssential = essentialContext(write);
  check("collapsed, the file is not shown at all", writeEssential.body, null);
  check("and expanding is what reveals the file", write.body, "line1\nline2\nline3");
  const shortBash = permissionContext({ ...base, rawInput: { command: "echo hi" }, content: null } as never, []);
  check("a command is the other way round — collapsed keeps it", essentialContext(shortBash).command, "echo hi");

  check("a one-line command withholds nothing, so there is no disclosure", withheldDetail(shortBash), false);

  check(
    "what is always shown, and what expanding adds, do not overlap",
    [essentialContext(write).body, essentialContext(write).text, detailContext(write).text, detailContext(write).body],
    [null, [], [], "line1\nline2\nline3"],
  );
  check(
    "and a long command is no longer clipped, because the box already bounds it",
    essentialContext(permissionContext({ ...base, rawInput: { command: "a\nb\nc\nd\ne" }, content: null } as never, [])).command,
    "a\nb\nc\nd\ne",
  );
  check("a file about to be written is withheld", withheldDetail(write), true);
  check(
    "and so is a diff about to be applied",
    withheldDetail(
      permissionContext(
        { ...base, rawInput: null, content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }] } as never,
        [],
      ),
    ),
    true,
  );
  check("collapsed, that diff is not drawn either", essentialContext(
    permissionContext(
      { ...base, rawInput: null, content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }] } as never,
      [],
    ),
  ).diffs.length, 0);
  check(
    "a long command withholds nothing either — it is shown whole",
    withheldDetail(
      permissionContext({ ...base, rawInput: { command: "a\nb\nc\nd\ne" }, content: null } as never, []),
    ),
    false,
  );

  check(
    "a request nothing can explain has nothing to disclose either",
    withheldDetail(permissionContext({ ...base, rawInput: null, content: null } as never, [])),
    false,
  );

  const braceProse = permissionContext(
    { ...base, rawInput: null, content: [{ type: "content", content: { type: "text", text: "{this is not json" } }] } as never,
    [],
  );
  check("prose that starts with a brace is still prose", braceProse.text, ["{this is not json"]);
  const jsonProse = permissionContext(
    { ...base, rawInput: null, content: [{ type: "content", content: { type: "text", text: JSON.stringify({ command: "echo hi" }) } }] } as never,
    [],
  );
  check("a JSON text block is read as the tool's arguments", jsonProse.command, "echo hi");

  // claude's plan mode sends the plan in rawInput and again as text; echoed fields are dropped, not the blob, so planFilePath survives.
  const plan = "# Plan\n\nDo the thing.";
  const planned = permissionContext(
    {
      ...base,
      title: "Ready to code?",
      rawInput: { plan, planFilePath: "/Users/x/.claude/plans/p.md" },
      content: [{ type: "content", content: { type: "text", text: plan } }],
    } as never,
    [],
  );
  // The plan is its own field so it can render as markdown; text stays verbatim because for kimi it is the command.
  check("the plan is read as a document", planned.plan, plan);
  check("and is not also drawn as a block of prose", planned.text, []);
  check("the escaped copy of it does not survive either", planned.rawInput?.includes("# Plan"), false);
  check("and the one field the prose never said survives", planned.rawInput, '{\n  "planFilePath": "/Users/x/.claude/plans/p.md"\n}');
  check(
    "a blob whose every field is echoed becomes nothing at all",
    permissionContext(
      { ...base, rawInput: { plan }, content: [{ type: "content", content: { type: "text", text: plan } }] } as never,
      [],
    ).rawInput,
    null,
  );
  check(
    "and a blob that echoes nothing is untouched",
    permissionContext({ ...base, rawInput: { abc: "x" }, content: null } as never, []).rawInput,
    '{\n  "abc": "x"\n}',
  );
  check("and is not also shown as prose", jsonProse.text, []);

  // Verbatim shapes from a real claude-agent-acp session; only the plan's wording is a stand-in.
  const planned2 = "# Plan\n\n1. Do the thing\n2. Then the other";
  const planCall = (kind: string, extra: Record<string, unknown> = {}): never =>
    ({
      seq: 1,
      ts: 1000,
      event: {
        type: "tool_call",
        toolCallId: "t1",
        title: "Ready to code?",
        kind,
        status: "pending",
        locations: [],
        rawInput: {},
        parentToolCallId: null,
        subagent: false,
        ...extra,
      },
    }) as never;
  const planUpdate = (rawInput: unknown): never =>
    ({
      seq: 2,
      ts: 2000,
      event: {
        type: "tool_call_update",
        toolCallId: "t1",
        title: "Ready to code?",
        status: null,
        locations: [],
        rawInput,
        content: null,
      },
    }) as never;
  const planPending = (over: Record<string, unknown> = {}): never =>
    ({
      ...base,
      toolCallId: "t1",
      title: "Ready to code?",
      rawInput: { plan: planned2, planFilePath: "/p.md" },
      content: [{ type: "content", content: { type: "text", text: planned2 } }],
      ...over,
    }) as never;

  {
    const withKind = permissionContext(planPending(), [planCall("switch_mode")]);
    check("a plan on a switch_mode call is a plan", withKind.plan, planned2);
    check("and the kind rides the tool call", withKind.kind, "switch_mode");

    check("a plan with no tool call loaded is still a plan", permissionContext(planPending(), []).plan, planned2);

    const coldOptions = [
      { optionId: "exit-plan-clear-auto", name: "Yes, clear context (10% used) and use auto mode", kind: "allow_always" },
      { optionId: "exit-plan-auto", name: "Yes, and use auto mode", kind: "allow_always" },
      { optionId: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
      { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
    ];
    const cold = permissionContext(planPending({ options: coldOptions }), []);
    check("but the kind has not arrived with it", cold.kind, null);
    check("so the curation declines the request entirely", planControls(cold, coldOptions as never), null);
    check("and the fallback draws every option, refusal included", permissionButtons(coldOptions as never).order.length, 4);
    check("as rows, in the agent's own words", permissionLayout(coldOptions as never), "rows");
    check(
      "and the same request with its tool call is two of ours",
      planControls(permissionContext(planPending({ options: coldOptions }), [planCall("switch_mode")]), coldOptions as never)?.map((c) => c.label),
      ["Auto mode", "Clear + auto"],
    );

    // Rendering markdown is safe only because a request authorizing a concrete action is never a plan.
    check(
      "a plan field beside a command is not a plan",
      permissionContext(planPending({ rawInput: { plan: planned2, command: "rm -rf /tmp/x" }, content: null }), []).plan,
      null,
    );
    check(
      "nor beside a body about to be written",
      permissionContext(planPending({ rawInput: { plan: planned2, content: "hello" }, content: null }), []).plan,
      null,
    );
    check(
      "nor beside a diff",
      permissionContext(
        planPending({
          content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }],
        }),
        [],
      ).plan,
      null,
    );
    check(
      "nor beside a location the tool named",
      permissionContext(planPending(), [planCall("switch_mode", { locations: [{ path: "/a.ts", line: null }] })]).plan,
      null,
    );

    const essential = essentialContext(withKind);
    check("a plan is what the card always shows", essential.plan, planned2);
    check("and its source is not inline beside it", essential.text, []);
    const detail = detailContext(withKind);
    check("the disclosure never repeats the rendered plan", detail.plan, null);
    check("it holds the source instead", detail.text, [planned2]);
    check("and it is drawn at all", withheldDetail(withKind), true);
    const bare = permissionContext(planPending({ rawInput: { plan: planned2 } }), [planCall("switch_mode")]);
    check("a plan carrying nothing else still gets a disclosure", withheldDetail(bare), true);
    check("and its blob really is empty", bare.rawInput, null);

    const ends = "# Plan\n\n1. Do the thing\n";
    const withNewline = permissionContext(
      planPending({
        rawInput: { plan: ends, planFilePath: "/p.md" },
        content: [{ type: "content", content: { type: "text", text: ends } }],
      }),
      [planCall("switch_mode")],
    );
    check("a plan ending in a newline is read without it", withNewline.plan, ends.trim());
    check("and the block that echoed it is still recognised", withNewline.text, []);
    check("and the escaped copy does not come back in the arguments", withNewline.rawInput, '{\n  "planFilePath": "/p.md"\n}');
  }

  // The claude-agent-acp 0.63.0 option set, kept because a machine can lag the pin; the 0.73.0 shapes follow.
  const PLAN_OPTIONS = [
    { optionId: "bypassPermissions", name: "Yes, and bypass permissions", kind: "allow_always" },
    { optionId: "auto", name: 'Yes, and use "auto" mode', kind: "allow_always" },
    { optionId: "acceptEdits", name: "Yes, and auto-accept edits", kind: "allow_always" },
    { optionId: "default", name: "Yes, and manually approve edits", kind: "allow_once" },
    { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
  ];

  {
    const context = permissionContext(planPending({ options: PLAN_OPTIONS }), [planCall("switch_mode")]);
    const controls = planControls(context, PLAN_OPTIONS as never);
    check("a measured plan request draws two controls", controls?.length, 2);
    check("in this order", controls?.map((c) => c.option.optionId), ["acceptEdits", "auto"]);
    check("and none of them is a refusal", controls?.map((c) => c.leading), [false, false]);
    check(
      "and auto mode is the one filled button",
      controls?.filter((c) => c.primary).map((c) => c.option.optionId),
      ["auto"],
    );
    check(
      "the refusal the agent sent is not among them",
      controls?.some((c) => c.option.optionId === "plan"),
      false,
    );
    // Every control is one of the agent's own options; saying what to change is the message box (Q3.454).
    check(
      "and every one of them is an option the agent sent",
      controls?.every((c) => PLAN_OPTIONS.some((o) => o.optionId === c.option.optionId)),
      true,
    );

    const deviations: [string, unknown[]][] = [
      ["an id renamed", PLAN_OPTIONS.map((o) => (o.optionId === "auto" ? { ...o, optionId: "autoMode" } : o))],
      ["a kind changed", PLAN_OPTIONS.map((o) => (o.optionId === "auto" ? { ...o, kind: "allow_once" } : o))],
      ["an option removed", PLAN_OPTIONS.filter((o) => o.optionId !== "bypassPermissions")],
      ["an option added", [...PLAN_OPTIONS, { optionId: "extra", name: "Something else", kind: "allow_once" }]],
    ];
    for (const [what, options] of deviations) {
      const ctx = permissionContext(planPending({ options }), [planCall("switch_mode")]);
      check(`${what} falls back to the agent's own buttons`, planControls(ctx, options as never), null);
    }

    // The kind gates the curation, not the rendering: drawing a document approves nothing, dropping options can.
    check(
      "an option set this shape on a tool call that is not switch_mode is not curated",
      planControls(
        permissionContext(planPending({ options: PLAN_OPTIONS }), [planCall("edit")]),
        PLAN_OPTIONS as never,
      ),
      null,
    );
    check(
      "and neither is one carrying no plan",
      planControls(
        permissionContext(planPending({ options: PLAN_OPTIONS, rawInput: null, content: null }), [
          planCall("switch_mode"),
        ]),
        PLAN_OPTIONS as never,
      ),
      null,
    );

    check("the fallback still draws all five", permissionButtons(PLAN_OPTIONS as never).order.length, 5);
    check("with the reversible one primary", permissionButtons(PLAN_OPTIONS as never).primaryId, "default");
    // The longest of claude's five labels is 31 characters against a 32 ceiling, so this fallback stays a button row.
    check("and the fallback is still a button row, by one character", permissionLayout(PLAN_OPTIONS as never), "buttons");
  }

  // claude's ExitPlanMode under claude-agent-acp 0.73.0: buildExitPlanModePermissionOptions picks one elevated mode from availableModes and builds four options around it.
  {
    const variants: [string, string, string, string][] = [
      // elevated mode, the clear id, the elevate id, what the elevate button says
      ["auto", "exit-plan-clear-auto", "exit-plan-auto", "Auto mode"],
      ["bypassPermissions", "exit-plan-clear-bypass", "exit-plan-bypass", "Bypass permissions"],
      ["acceptEdits", "exit-plan-clear-accept-edits", "exit-plan-accept-edits", "Auto-accept edits"],
    ];
    for (const [mode, clearId, elevateId, elevateLabel] of variants) {
      const options = [
        { optionId: clearId, name: "Yes, clear context (10% used) and use auto mode", kind: "allow_always" },
        { optionId: elevateId, name: "Yes, and use auto mode", kind: "allow_always" },
        { optionId: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
        { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
      ];
      const ctx = permissionContext(planPending({ options }), [planCall("switch_mode")]);
      const controls = planControls(ctx, options as never);
      check(`the ${mode} plan request draws two`, controls?.length, 2);
      check(
        `${mode}: the elevation, then the same elevation clearing the context`,
        controls?.map((c) => c.option.optionId),
        [elevateId, clearId],
      );
      check(`${mode}: our own short words`, controls?.map((c) => c.label), [
        elevateLabel,
        `Clear + ${clearId === "exit-plan-clear-auto" ? "auto" : clearId === "exit-plan-clear-bypass" ? "bypass" : "accept"}`,
      ]);
      check(`${mode}: neither of them is a refusal`, controls?.map((c) => c.leading), [false, false]);
      check(
        `${mode}: clearing the context is the filled one`,
        controls?.filter((c) => c.primary).map((c) => c.option.optionId),
        [clearId],
      );
      // Asserted by name, so dropping a third option cannot pass as still two buttons.
      check(
        `${mode}: the refusal and the per-edit grant are the two left out`,
        options
          .map((o) => o.optionId)
          .filter((id) => controls?.every((c) => c.option.optionId !== id) === true)
          .sort(),
        ["exit-plan-default", "reject"],
      );
      check(`${mode}: the agent's own words would not have been buttons`, permissionLayout(options as never), "rows");
      check(`${mode}: and the agent's wording is kept as the tooltip`, controls?.map((c) => c.option.name).length, 2);

      const renamed = options.map((o) => (o.optionId === clearId ? { ...o, optionId: `${clearId}x` } : o));
      check(
        `${mode}: one renamed id falls back to the agent's own buttons`,
        planControls(permissionContext(planPending({ options: renamed }), [planCall("switch_mode")]), renamed as never),
        null,
      );
    }

    const mixed = [
      { optionId: "exit-plan-clear-auto", name: "Yes, clear context and use auto mode", kind: "allow_always" },
      { optionId: "exit-plan-bypass", name: "Yes, and bypass permissions", kind: "allow_always" },
      { optionId: "exit-plan-default", name: "Yes, manually approve edits", kind: "allow_once" },
      { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
    ];
    check(
      "a request mixing two variants matches none of them",
      planControls(permissionContext(planPending({ options: mixed }), [planCall("switch_mode")]), mixed as never),
      null,
    );
  }

  {
    const clamped = { truncated: true, bytes: 9000 };
    const recovered = permissionContext(planPending({ rawInput: clamped, content: clamped }), [
      planCall("switch_mode"),
      planUpdate({ plan: planned2, planFilePath: "/p.md" }),
    ]);
    check("a clamped plan is recovered from the log", recovered.plan, planned2);
    check("and the card stops apologising for it", recovered.truncated, false);

    const lost = permissionContext(planPending({ rawInput: clamped, content: clamped }), []);
    check("with nothing in the log it is still reported as clipped", lost.truncated, true);
    check("and there is no plan to draw", lost.plan, null);
  }

  // Verbatim shape: the arguments appear only on a tool_call_update, so the join must reach the updates.
  const askInput = {
    questions: [
      {
        header: "Rules",
        question: "Which house rule should we add to our tic-tac-toe?",
        options: [
          { label: "Battlefield", description: "You may move into any square" },
          { label: "On the clock", description: "Five seconds per move" },
          { label: "Knockout", description: "The winner takes the square" },
          { label: "No rules", description: "Classic" },
        ],
      },
    ],
  };
  const askPending = {
    permissionId: "perm-1-f50",
    toolCallId: "5:tool_rk3",
    title: "AskUserQuestion",
    raisedAt: 0,
    rawInput: null,
    content: null,
    options: [
      { optionId: "q0_opt_0", name: "Battlefield", kind: "allow_once" },
      { optionId: "q0_opt_1", name: "On the clock", kind: "allow_once" },
      { optionId: "q0_opt_2", name: "Knockout", kind: "allow_once" },
      { optionId: "q0_opt_3", name: "No rules", kind: "allow_once" },
      { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
    ],
  };
  const askEvents = [
    { seq: 1, at: 0, event: { type: "tool_call", toolCallId: "5:tool_rk3", title: "Asking user questions", kind: "other", status: "pending", rawInput: null, locations: [], content: [] } },
    { seq: 2, at: 0, event: { type: "tool_call_update", toolCallId: "5:tool_rk3", title: null, status: "in_progress", rawInput: askInput, locations: [], content: [] } },
  ];

  const asking = (pending: unknown, events: unknown): ReturnType<typeof askedQuestion> =>
    askedQuestion(pending as never, events as never, permissionContext(pending as never, events as never));

  const asked = asking(askPending, askEvents);
  check("a question's wording is recovered from the tool call's updates", asked?.question, "Which house rule should we add to our tic-tac-toe?");
  check(
    "and every answer keeps its own description, joined by identity",
    asked?.answers.map((a) => [a.optionId, a.label, a.description]),
    [
      ["q0_opt_0", "Battlefield", "You may move into any square"],
      ["q0_opt_1", "On the clock", "Five seconds per move"],
      ["q0_opt_2", "Knockout", "The winner takes the square"],
      ["q0_opt_3", "No rules", "Classic"],
    ],
  );
  check("the reject option is the skip, by kind and not by its name", asked?.skip, { optionId: "q0_skip", name: "Skip" });

  // The gate is the enum, not the title: more than one allow_once means the names carry the meaning.
  const oneAllow = {
    ...askPending,
    title: "AskUserQuestion",
    options: [
      { optionId: "a", name: "Battlefield", kind: "allow_once" },
      { optionId: "b", name: "On the clock", kind: "allow_always" },
      { optionId: "c", name: "no", kind: "reject_once" },
    ],
  };
  check("one allow_once is an approval however it is titled", asking(oneAllow, askEvents), null);
  check(
    "and a real approval with a command is untouched",
    asking(
      { ...base, rawInput: { command: "rm -rf /tmp/x" }, options: [{ optionId: "y", name: "Yes", kind: "allow_once" }, { optionId: "n", name: "No", kind: "reject_once" }] },
      [],
    ),
    null,
  );

  check(
    "the title is never read — renaming the tool changes nothing",
    asking({ ...askPending, title: "let us talk" }, askEvents)?.question,
    "Which house rule should we add to our tic-tac-toe?",
  );

  check(
    "an option that matches no label abandons the whole question",
    asking(
      { ...askPending, options: [...askPending.options.slice(0, 3), { optionId: "q0_opt_3", name: "Something else", kind: "allow_once" }, askPending.options[4]] },
      askEvents,
    ),
    null,
  );
  check(
    "an 8 KiB stand-in is not a question",
    asking({ ...askPending, rawInput: { truncated: true, bytes: 9000 } }, []),
    null,
  );
  check("and neither is a tool input of some other shape", asking(askPending, [
    { seq: 1, at: 0, event: { type: "tool_call", toolCallId: "5:tool_rk3", title: "x", kind: "other", status: "pending", rawInput: { command: "ls" }, locations: [], content: [] } },
  ]), null);
  check("two reject options is a shape nobody has measured", asking(
    { ...askPending, options: [...askPending.options, { optionId: "q0_skip2", name: "Never", kind: "reject_always" }] },
    askEvents,
  ), null);

  const twoQuestions = {
    questions: [
      { question: "Should I add a caching layer?", options: [{ label: "Yes", description: "adds redis" }, { label: "No", description: "leave it" }] },
      { question: "Should I drop the old table?", options: [{ label: "Yes", description: "irreversible" }, { label: "No", description: "keep it" }] },
    ],
  };
  const sharedLabels = {
    ...askPending,
    options: [
      { optionId: "q1_opt_0", name: "Yes", kind: "allow_once" },
      { optionId: "q1_opt_1", name: "No", kind: "allow_once" },
      { optionId: "q1_skip", name: "Skip", kind: "reject_once" },
    ],
  };
  check(
    "a label two questions share resolves to neither",
    asking(sharedLabels, [
      { seq: 1, at: 0, event: { type: "tool_call", toolCallId: "5:tool_rk3", title: "Asking user questions", kind: "other", status: "pending", rawInput: null, locations: [], content: [] } },
      { seq: 2, at: 0, event: { type: "tool_call_update", toolCallId: "5:tool_rk3", title: null, status: "in_progress", rawInput: twoQuestions, locations: [], content: [] } },
    ]),
    null,
  );
  check(
    "and a label repeated inside one question is refused too, with no second question in sight",
    asking(
      { ...askPending, options: [{ optionId: "a", name: "Same", kind: "allow_once" }, { optionId: "b", name: "Other", kind: "allow_once" }, { optionId: "s", name: "Skip", kind: "reject_once" }] },
      [
        { seq: 1, at: 0, event: { type: "tool_call", toolCallId: "5:tool_rk3", title: "Asking user questions", kind: "other", status: "pending", rawInput: null, locations: [], content: [] } },
        { seq: 2, at: 0, event: { type: "tool_call_update", toolCallId: "5:tool_rk3", title: null, status: "in_progress", rawInput: { questions: [{ question: "Which?", options: [{ label: "Same", description: "A" }, { label: "Same", description: "B" }, { label: "Other", description: "C" }] }] }, locations: [], content: [] } },
      ],
    ),
    null,
  );
  check(
    "distinct labels across two questions still join to the right one",
    asking(
      { ...askPending, options: [{ optionId: "q1_opt_0", name: "Drop it", kind: "allow_once" }, { optionId: "q1_opt_1", name: "Keep it", kind: "allow_once" }, { optionId: "q1_skip", name: "Skip", kind: "reject_once" }] },
      [
        { seq: 1, at: 0, event: { type: "tool_call", toolCallId: "5:tool_rk3", title: "Asking user questions", kind: "other", status: "pending", rawInput: null, locations: [], content: [] } },
        { seq: 2, at: 0, event: { type: "tool_call_update", toolCallId: "5:tool_rk3", title: null, status: "in_progress", rawInput: { questions: [
          { question: "Should I add a caching layer?", options: [{ label: "Add it", description: "adds redis" }, { label: "Skip caching", description: "leave it" }] },
          { question: "Should I drop the old table?", options: [{ label: "Drop it", description: "irreversible" }, { label: "Keep it", description: "keep it" }] },
        ] }, locations: [], content: [] } },
      ],
    )?.question,
    "Should I drop the old table?",
  );

  // A request that also authorizes a command is never a question, or the command hides behind neutral answers.
  const disguised = {
    ...askPending,
    title: "Bash",
    rawInput: {
      command: "rm -rf /",
      questions: [
        {
          question: "Which colour?",
          options: [
            { label: "Battlefield", description: null },
            { label: "On the clock", description: null },
            { label: "Knockout", description: null },
            { label: "No rules", description: null },
          ],
        },
      ],
    },
  };
  check("a request that authorizes a command is never a question", asking(disguised, []), null);
  check(
    "and the command it authorizes is on the card, not hidden behind one",
    permissionContext(disguised as never, []).command,
    "rm -rf /",
  );

  const emptyObject = permissionContext({ ...base, rawInput: {}, content: null } as never, []);
  check("an empty rawInput object is nothing, not `{}`", emptyObject.unavailable, true);

  const edit = permissionContext({ ...base, rawInput: { file_path: "/home/proj/notes.txt" }, content: null } as never, []);
  check("a file-shaped argument is surfaced as the target", edit.target, "/home/proj/notes.txt");
  check("and the card is not empty", edit.unavailable, false);
}

process.stdout.write("\na reduced snapshot frame\n");
{
  const perm = (permissionId: string, raisedAt: number, rawInput: unknown): unknown => ({
    permissionId,
    toolCallId: null,
    title: "Running",
    options: [],
    raisedAt,
    rawInput,
    content: null,
  });
  const ask = (elicitationId: string, raisedAt: number): unknown => ({
    elicitationId,
    toolCallId: null,
    message: "Which?",
    fieldCount: 1,
    raisedAt,
  });
  const clamped = { truncated: true, bytes: 9000 };

  // The 4s poll serves the whole record, never the ladder's projection of it.
  const held = {
    id: "s1",
    pendingPermissions: [perm("p1", 1, { command: "ls" }), perm("p2", 2, { command: "rm -rf /" }), perm("p3", 3, { command: "mv" })],
    pendingElicitations: [ask("e1", 1), ask("e2", 2)],
  };

  // A hello past CONTROL_MAX_BYTES keeps the oldest row of each list, clamps its payload and names the real lengths in reduced.
  const frame = {
    id: "s1",
    pendingPermissions: [perm("p1", 1, clamped)],
    pendingElicitations: [ask("e1", 1)],
    reduced: { pendingPermissions: 3, pendingElicitations: 2, blobs: true },
  };

  const merged = unreduceSnapshot(frame as never, held as never);
  check(
    "a frame carrying `reduced` may not shrink the parked list",
    merged.pendingPermissions.map((row) => row.permissionId),
    ["p1", "p2", "p3"],
  );
  check(
    "and the questions go back with the approvals",
    (merged.pendingElicitations ?? []).map((row) => row.elicitationId),
    ["e1", "e2"],
  );
  check("and a stand-in never overwrites a payload this client already holds", merged.pendingPermissions[0]?.rawInput, {
    command: "ls",
  });
  check("so nothing is left marked as still missing", merged.reduced?.blobs, false);
  check("and the daemon's own counts survive the merge", merged.reduced?.pendingPermissions, 3);

  // The ladder cuts a raisedAt prefix, so a held row inside the frame's range but absent from it was answered and must not return.
  const afterAnswer = unreduceSnapshot(
    {
      ...frame,
      pendingPermissions: [perm("p2", 2, clamped)],
      reduced: { pendingPermissions: 2, pendingElicitations: 2, blobs: true },
    } as never,
    held as never,
  );
  check(
    "a row the frame's prefix left out was answered, not cut",
    afterAnswer.pendingPermissions.map((row) => row.permissionId),
    ["p2", "p3"],
  );

  // A fresh request's stand-in may be the ladder or the 8 KiB ingest clamp, byte-identical, so blobs stays true.
  const fresh = unreduceSnapshot(
    {
      id: "s1",
      pendingPermissions: [perm("p9", 9, clamped)],
      pendingElicitations: [],
      reduced: { pendingPermissions: 1, pendingElicitations: 0, blobs: true },
    } as never,
    held as never,
  );
  check("a payload this client has never held stays marked as still on the machine", fresh.reduced?.blobs, true);

  const whole = unreduceSnapshot({ id: "s1", pendingPermissions: [], pendingElicitations: [] } as never, held as never);
  check("absent means whole, so an unmarked frame still takes the list away", whole.pendingPermissions.length, 0);
  check("and it is returned untouched rather than rebuilt", whole.reduced, undefined);

  const crossed = unreduceSnapshot({ ...frame, id: "s2" } as never, held as never);
  check("and a row for another session is never merged into this one", crossed.pendingPermissions.length, 1);

  // Two reduced frames in a row: the second's held row is the first merge's output, so blobs must not flip to false.
  const raised = {
    id: "s1",
    pendingPermissions: [perm("p1", 1, clamped), perm("p9", 9, clamped)],
    pendingElicitations: [],
    reduced: { pendingPermissions: 2, pendingElicitations: 0, blobs: true },
  };
  const frameOnce = unreduceSnapshot(raised as never, held as never);
  check("a row this client has no record copy of is marked as still on the machine", frameOnce.reduced?.blobs, true);
  const frameTwice = unreduceSnapshot(raised as never, frameOnce as never);
  check("and a second identical frame does not talk this client out of it", frameTwice.reduced?.blobs, true);
  check(
    "because the record copies ride the row rather than being re-derived from it",
    frameTwice.reduced?.onRecord,
    ["p1"],
  );
  check("and the row the record did cover keeps its payload across both", frameTwice.pendingPermissions[0]?.rawInput, {
    command: "ls",
  });

  // setSessionMeta re-folds a row through onSnapshot on pin or drag, so merging a row with itself must be a no-op.
  const refolded = unreduceSnapshot(frameOnce as never, frameOnce as never);
  check("pinning a session re-folds its own snapshot and changes no sentence", refolded.reduced?.blobs, true);
  check(
    "and takes no row off the parked list",
    refolded.pendingPermissions.map((row) => row.permissionId),
    ["p1", "p9"],
  );

  const clampedRecord = { id: "s1", pendingPermissions: [perm("pc", 1, clamped)], pendingElicitations: [] };
  const overClamped = {
    ...clampedRecord,
    reduced: { pendingPermissions: 1, pendingElicitations: 0, blobs: true },
  };
  const ingestOnce = unreduceSnapshot(overClamped as never, clampedRecord as never);
  check("a stand-in the record itself carries is permanent, and is not marked as pending", ingestOnce.reduced?.blobs, false);
  const ingestTwice = unreduceSnapshot(overClamped as never, ingestOnce as never);
  check("and that answer holds across a second frame as well", ingestTwice.reduced?.blobs, false);
}

process.stdout.write("\nthe two truncation sentences\n");
{
  const base = { permissionId: "p1", toolCallId: null, title: "Running", options: [], raisedAt: 0 };
  const clipped = permissionContext({ ...base, rawInput: { truncated: true, bytes: 9000 }, content: null } as never, []);
  const intact = permissionContext({ ...base, rawInput: { command: "ls" }, content: null } as never, []);

  check(
    "the daemon's ingest clamp is permanent, and the sentence claims it",
    truncationNotice(clipped, false),
    "Part of this request was too large to keep and is not shown below.",
  );
  check(
    "a frame's ladder is not, and the record still has it",
    truncationNotice(clipped, true),
    "Part of this request is too large for the live connection and has not been fetched yet.",
  );
  check("and the two do not read alike", truncationNotice(clipped, true) === truncationNotice(clipped, false), false);
  check("an intact request says nothing at all", truncationNotice(intact, true), null);

  const cardSrc = stripComments(readFileSync(new URL("../src/ui/PermissionCard.tsx", import.meta.url), "utf8"));
  check("and the card draws that rather than a sentence of its own", /truncationNotice\(context, awaitingRecord\)/.test(cardSrc), true);
  check(
    "with the flag read off the session row the merge wrote",
    /awaitingRecord = row\?\.snapshot\.reduced\?\.blobs === true/.test(cardSrc),
    true,
  );
  // Asserted as an absence over comment-stripped source, so prose quoting the old sentence cannot match.
  check("and the fixed one it replaced is gone from the card's markup", cardSrc.includes("too large to keep"), false);
}
