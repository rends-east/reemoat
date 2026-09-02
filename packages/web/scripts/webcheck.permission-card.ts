import { check } from "./webcheck.env.js";
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
  withheldDetail,
} from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * What is actually being approved
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe permission card's context\n");
{
  const base = { permissionId: "p1", toolCallId: null, title: "Running", options: [], raisedAt: 0 };

  // Measured against kimi: the command arrives as an ACP *text* content block and
  // `rawInput` is null. Treating text blocks as decoration produced an approve
  // button above an empty box every single time for the one agent that asks.
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

  /*
   * `content` is clamped by the same `clampBlob` as `rawInput`, so it can be the
   * stand-in too — and it is the diff case, the one most likely to exceed 8 KiB.
   * Only `rawInput` was checked, so this fell through to "the tool call is no
   * longer in the log", which is a false explanation for a payload that existed.
   */
  const truncatedContent = permissionContext(
    { ...base, rawInput: null, content: { truncated: true, bytes: 9000 } } as never,
    [],
  );
  check("a truncated content is too", truncatedContent.truncated, true);
  check("and does not claim the tool call is missing", truncatedContent.unavailable, false);

  // Truncation must not hide the rest: the text block is where the command lives.
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

  /* ---- what a Write is actually about to do ---- */

  /*
   * **Verbatim from this daemon's database**, session `s_435ad130` seqs 1988–1989.
   * The permission carries one sentence and nothing else; the file being written
   * is on the tool call's *update*, as a JSON string inside a text block. So the
   * card drew "Write" over "Requesting approval to Writing tictactoe.py" and the
   * thing being approved appeared nowhere at all.
   */
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
  /*
   * **A sentence that names the target says nothing the heading does not.** kimi
   * announces a write as "Requesting approval to Writing tictactoe.py"; the
   * heading is "Allow Kimi to write tictactoe.py?" and the path is in the box
   * under it. The same filter that drops a sentence repeating the *command*, one
   * field over.
   */
  check("the sentence repeating the target is dropped", write.text, []);
  check("and the target itself is still there to be drawn", write.target, "tictactoe.py");

  /*
   * **A sentence that already contains the command says nothing beside it.**
   * kimi's prose is "Requesting approval to Running: <the whole command>", so the
   * card drew the command twice — wrapped in a sentence and again on its own, both
   * monospace, both the width of the card.
   */
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

  /*
   * The headline. `pending.title` on that request is the bare word `Write`, so the
   * card said the tool's name twice and named the file only in the small print.
   */
  /*
   * **The heading asks what is being asked**, which `pending.title` — `Bash`,
   * `Write` — is a category rather than a request. Every part of the sentence
   * comes from somewhere real: the agent's own id, ACP's `ToolKind`, and the
   * agent's own `description` or the path it named.
   */
  check(
    "a write with a path reads as a request",
    permissionHeadline("kimi", "Write", write),
    // **`write` from an `edit` kind.** ACP has one word for both and they are not
    // the same act: this payload carries a whole `body` and no diff, so the file
    // is being written rather than patched.
    "Allow Kimi to write tictactoe.py?",
  );
  /*
   * **The heading is the last segment; the box below it is the whole path.** Two
   * different strings rather than one repeated — a heading has to fit on a line
   * and the thing being approved has to be exact.
   */
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

  /*
   * **A codex approval, exactly as one arrived**, and the third measured shape of
   * the same request.
   *
   * Taken 2026-08-07 from a real session through the daemon: codex sends the
   * command on `rawInput` (where kimi sends it as a text block), sends **no
   * `title`**, and sends no `kind` the snapshot keeps — so `title` falls back to
   * `toolCall.toolCallId` and the card is handed a bare uuid as its heading.
   *
   * That is the assertion. Every other agent's title is a word (`Bash`, `Write`,
   * `Terminal`), so nothing before this exercised a title that is *not* fit to
   * show anybody, and the two rules that rescue it — a verb inferred from
   * `command` when `kind` is null, and the generic object when there is no target
   * — are precisely the ones that would look redundant to a later reader.
   */
  const codexExec = permissionContext(
    {
      ...base,
      title: "exec-b34af4d4-869e-478f-9762-9255ac71f84b",
      // Quoted twice on purpose: codex runs `/bin/zsh -lc "<this>"` and puts the
      // inner string here, quotes included. Reported as sent — trimming them would
      // be this client editing a command before somebody approves it.
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
  /*
   * **The uuid must not reach the heading**, which is the whole point of the case.
   * A card headed `exec-b34af4d4-…` asks somebody to approve a command while
   * showing them an identifier for it.
   */
  check("and the tool call id never surfaces as a heading", permissionHeadline("codex", "exec-b34af4d4-869e-478f-9762-9255ac71f84b", codexExec).includes("exec-b34af4d4"), false);
  /*
   * Four options, and **two of them are `allow_always`** — codex offers "Allow for
   * Session" beside "Allow Commands Starting With `curl …`", an execpolicy
   * amendment. Nothing before this had a duplicate kind, and the button layout
   * keys on kind: the count is what proves neither is dropped and that the
   * primary is still the narrowest grant on offer.
   */
  const codexOptions = [
    { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
    { optionId: "accept_execpolicy_amendment", name: "Allow Commands Starting With `curl -sS`", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  ];
  const codexButtons = permissionButtons(codexOptions as never);
  check("and the narrowest grant is still the default", codexButtons.primaryId, "allow_once");
  check("with the refusal leading", codexButtons.order[0]?.optionId, "reject_once");
  /*
   * **A duplicate kind is why every label here is the agent's own.** `optionLabel`
   * replaces a name with our word only when the kind identifies the option; two
   * `allow_always` options would both become "Always allow", which is the one
   * rendering that must never happen — the scope is the whole difference between
   * them.
   *
   * Asked against the **full** set, which is what the card passes — and it is now
   * also what the card *draws*: the sentence that used to sit here said "one of the
   * two is no longer drawn, but it was still sent, so the kind is still ambiguous",
   * which was the old filter's excuse for the ambiguity surviving its own removal.
   * Both are on the card, both keep the scope that separates them, and the row
   * became `rows` to fit them.
   */
  check(
    "with two of a kind, no label is replaced by our word for it",
    codexButtons.order.map((o: { optionId: string }) => optionLabel(codexOptions as never, o as never)),
    ["Reject", "Allow for Session", "Allow Commands Starting With `curl -sS`", "Allow Once"],
  );

  /*
   * ⚠ **The option that broke the row, and the reversal: the row gives way now,
   * not the option.**
   *
   * This block used to assert `drawableOptions` — four narrowings on *deleting* an
   * approval whose rendered label exceeded `BUTTON_LABEL_MAX`. The button row does
   * carry its meaning by position (refusal alone on the left, reversible approval
   * filled on the right) because the colour those buttons had was removed, and
   * `OptionButton` draws its label as a bare text child inside a `flex-wrap` group,
   * so a long label really does wrap the row into an arrangement where the rule
   * says nothing while still looking deliberate. Measured: codex's scoped grant
   * embeds a command path and is unbounded by construction.
   *
   * What was wrong was the remedy. A layout is this app's problem and an option is
   * the agent's, and the old rule removed a choice the agent offered so that this
   * app could keep a layout — on the one channel where an option is a **model
   * written answer**, deleting two of four with nothing said. `permissionLayout`
   * switches to `rows` instead, which is the arrangement the card already draws for
   * a question: full width, wrapping labels, descriptions.
   *
   * So every assertion here is now of one of two kinds: **nothing is ever removed**,
   * and **the layout is `rows` exactly when a button row would not hold.** The
   * fixtures are the same measured ones, because they are the shapes that found the
   * problem in the first place.
   */
  const layoutOf = (options: unknown): string => permissionLayout(options as never);
  const orderOf = (options: unknown): string[] =>
    permissionButtons(options as never).order.map((o: { optionId: string }) => o.optionId);

  check("every option codex offered is drawn", orderOf(codexOptions), ["reject_once", "allow_always", "accept_execpolicy_amendment", "allow_once"]);
  check("and the card lays them out as rows rather than dropping one", layoutOf(codexOptions), "rows");
  check("the refusal still leads", permissionButtons(codexOptions as never).leading, 1);
  check("and the reversible approval is still primary", permissionButtons(codexOptions as never).primaryId, "allow_once");
  /*
   * **A refusal never decides the layout.** It is one option in a group of one and
   * has no sibling to line up against, so a long one is a wide button and nothing
   * worse — and it was never droppable either, being the option whose absence reads
   * as "there was no way to say no".
   */
  const longRefusal = [
    { optionId: "a", name: "Yes", kind: "allow_once" },
    { optionId: "b", name: "No, and stop asking me about this particular command for ever", kind: "reject_always" },
  ];
  check("a long refusal is kept and does not force rows", [orderOf(longRefusal), layoutOf(longRefusal)], [["b", "a"], "buttons"]);
  /*
   * Two refusals of one kind: the shape that used to need the `startsWith("reject")`
   * guard, because with only one refusal on a card the "never a scope's only
   * representative" rule kept it anyway. No agent has been measured sending it,
   * which is the point — the guard is what says a refusal is never traded away,
   * rather than happening not to be. It survives as the same clause in
   * `permissionLayout`.
   */
  const twoRefusals = [
    { optionId: "a", name: "Yes", kind: "allow_once" },
    { optionId: "b", name: "No", kind: "reject_once" },
    { optionId: "c", name: "No, and never ask about /Users/u/reemoat/src again", kind: "reject_once" },
  ];
  check("two refusals, one of them long, are both kept as buttons", [orderOf(twoRefusals), layoutOf(twoRefusals)], [["b", "c", "a"], "buttons"]);
  /*
   * **The only way to approve.** Under the old rule this was the case that had to
   * be special-cased, because dropping it left a card that could not be answered.
   * Under this one it needs no rule at all: it is kept because nothing is dropped,
   * and it is drawn legibly because the card became rows.
   */
  const onlyLong = [
    { optionId: "a", name: "Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)", kind: "allow_always" },
    { optionId: "b", name: "No", kind: "reject_once" },
  ];
  check("the only way to approve is kept, and gets a row it fits in", [orderOf(onlyLong), layoutOf(onlyLong)], [["b", "a"], "rows"]);
  // The shapes every other agent sends are untouched, and stay buttons.
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
  /*
   * **claude's scoped grant, the shape a length-only filter took.**
   *
   * This is the fixture 200 lines below at `scoped`, where it pins `optionLabel`
   * keeping the globs — and it was never passed to the old filter, so the driver
   * asserted a label for a button the card had stopped drawing. Written as "drop
   * everything that does not fit", the 64-character `allow_always` went and the
   * card offered Deny and Allow once: a standing grant unreachable from a phone, on
   * the one request where the scope *is* the decision.
   */
  const claudeScoped = [
    { optionId: "s1", name: "Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)", kind: "allow_always" },
    { optionId: "s2", name: "Allow", kind: "allow_once" },
    { optionId: "s3", name: "Reject", kind: "reject_once" },
  ];
  check("a scope is kept, and the card takes rows to show it", [orderOf(claudeScoped), layoutOf(claudeScoped)], [["s3", "s1", "s2"], "rows"]);
  /*
   * **The mirror, and the one that decides what the filled control means.**
   *
   * Length alone is symmetrical, so an agent wording `allow_once` past the ceiling
   * used to lose the *narrow* grant — and `primaryId` is the last approval in the
   * row, so the filled control became the permanent one. `AskCard`'s rule is "the
   * reversible approval is the filled one", and that must hold in either layout;
   * `OptionRow` draws `primary` filled for exactly this case.
   */
  const longAllowOnce = [
    { optionId: "r", name: "Deny", kind: "reject_once" },
    { optionId: "once", name: "Allow once for /Users/u/reemoat/src", kind: "allow_once" },
    { optionId: "always", name: "Approve", kind: "allow_always" },
  ];
  check("the narrow grant is kept, in rows", [orderOf(longAllowOnce), layoutOf(longAllowOnce)], [["r", "always", "once"], "rows"]);
  check("and the filled control is still the reversible approval", permissionButtons(longAllowOnce as never).primaryId, "once");
  /*
   * **Answers are not scopes, and they reach this path.**
   *
   * kimi's `AskUserQuestion` arrives as a `session/request_permission` whose answers
   * are `allow_once` options named by the model. `askedQuestion` returns null when
   * `rawInput` was truncated at the 8 KiB pending-permission cap or the transcript
   * has not paged in — the window `PermissionCard`'s `loadAll` exists to close — and
   * the card then falls back to this. Filtering deleted two of the four answers,
   * each a sentence and none of them a narrower version of another. Now they are all
   * kept, and because two of them are over the ceiling the fallback is rows — which
   * is what the card would have drawn had `askedQuestion` succeeded.
   */
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
  /*
   * The fallback, and it is the old behaviour: with no verb to be had — an
   * unknown `kind`, nothing executable, no body — the sentence would be invented
   * rather than derived, so the tool's name plus its target stands instead.
   */
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

  /* ---- where each decision button goes ---- */

  /*
   * **This reverses a documented rule and the reversal is the assertion.** The
   * agent's own order was kept untouched on the grounds that choosing which answer
   * sits nearest the thumb is an opinion in front of a safety decision. True of a
   * stacked list where every row looks alike; false of a row of buttons, where
   * kimi's order — approve, approve-always, reject — puts the refusal under the
   * thumb and the two approvals a thumb-width away from it.
   */
  const kimiOrder = [
    { optionId: "a", name: "Approve once", kind: "allow_once" },
    { optionId: "b", name: "Approve for this session", kind: "allow_always" },
    { optionId: "c", name: "Reject", kind: "reject_once" },
  ];
  const laid = permissionButtons(kimiOrder as never);
  check("a refusal goes first and the reversible approval last", laid.order.map((o) => o.optionId), ["c", "b", "a"]);
  check("with the refusal alone on the left of the gap", laid.leading, 1);
  check("and allow-once filled, because it is the one that can be taken back", laid.primaryId, "a");

  /*
   * claude's plan-mode request: three `allow_always`, one `allow_once`, one
   * refusal. Only `allow_once` is deliberately moved, so the three keep the order
   * the agent gave them.
   */
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

  /* ---- what a decision button says ---- */

  /*
   * **The kind's word, but only when the kind is unambiguous.** kimi words
   * `allow_always` as "Approve for this session"; claude words it as "Always
   * Allow Read(//tmp/x/**)". One concept, two vocabularies, and the kind is
   * already deciding this button's position and its fill.
   */
  check(
    "kimi's three become the words the kind already carries",
    kimiOrder.map((o) => optionLabel(kimiOrder as never, o as never)),
    ["Allow once", "Always allow", "Deny"],
  );

  /*
   * **And claude's plan-mode request is why it is conditional.** Three
   * `allow_always` options, identical in kind, told apart only by their names —
   * renaming would draw three identical buttons for three different permanent
   * grants. All-or-nothing per request, so a row is never half the agent's words
   * and half ours.
   */
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

  /*
   * **A name that already says what the kind says is carrying something extra.**
   * claude words a scoped grant as `Always Allow Read(//tmp/svgout/**)`, and
   * replacing that with "Always allow" turns a path-scoped standing approval into
   * an unconditional-looking one — the globs are the only thing saying what is
   * being permanently granted.
   */
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

  /*
   * Collapsed, the file outranks the sentence announcing it — they were the only
   * two things on the card and one of them was the headline again.
   */
  const writeEssential = essentialContext(write);
  /*
   * **A file is behind `details`; a command is not.** Both are "what the tool is
   * about to do" and they are not the same kind of thing: a command is one line
   * and *is* the decision, so hiding it would mean approving a shell line you have
   * to press something to read. A file is two hundred lines whose first twelve are
   * a docstring, and shown collapsed it pushes the buttons off a phone to say
   * nothing.
   */
  check("collapsed, the file is not shown at all", writeEssential.body, null);
  check("and expanding is what reveals the file", write.body, "line1\nline2\nline3");
  const shortBash = permissionContext({ ...base, rawInput: { command: "echo hi" }, content: null } as never, []);
  check("a command is the other way round — collapsed keeps it", essentialContext(shortBash).command, "echo hi");

  /*
   * **`details` is offered only where something was withheld**, and this gate has
   * now been wrong in both directions: first a general "is anything clipped",
   * which hid the control for a request the card could not explain at all; then
   * unconditional, which put a disclosure under every one-line `Bash` promising
   * bookkeeping. A file and a diff are what somebody may not be ready to read. A
   * command is one line, it is the decision, and it is already on screen.
   */
  check("a one-line command withholds nothing, so there is no disclosure", withheldDetail(shortBash), false);

  /*
   * **The two halves are a partition**, which is what lets the button sit between
   * them instead of underneath what it reveals. Nothing is clipped and then
   * un-clipped, so nothing is drawn twice.
   */
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

  /*
   * With the digest gone, `unavailable` is no longer a reason to offer the
   * disclosure — there would be nothing behind it. The four things
   * `detailContext` carries are the only reasons left.
   */
  check(
    "a request nothing can explain has nothing to disclose either",
    withheldDetail(permissionContext({ ...base, rawInput: null, content: null } as never, [])),
    false,
  );

  /*
   * The parse is a *shape* and not a name: prose that merely begins with a brace
   * stays prose, and a text block that is a JSON object is arguments.
   */
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

  /*
   * **claude's plan mode sends the plan twice**, and the card drew it twice.
   * Measured against s_f07c0791 seq 47/48: `rawInput` is `{plan, planFilePath}`
   * and the content block's text is byte-for-byte `rawInput.plan` — 5175
   * characters of markdown. `plan` is in no `BODY_FIELD`, so `pretty` survived
   * and `details` held the whole document twice, the second copy with every
   * newline escaped.
   *
   * Fields are dropped rather than the blob, so `planFilePath` — the only thing
   * in there the prose does *not* say — survives.
   */
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
  /*
   * **The plan is its own field now, and that is what lets it be *rendered*.**
   *
   * It used to sit in `text`, which the card draws verbatim in a 160px monospace
   * `<pre>` — the right treatment for a text block, because for kimi that block
   * *is* the shell command and a markdown renderer eats the characters somebody
   * is approving. A `plan` is the opposite kind of thing: a document, named by
   * the tool's own schema, on a request that authorizes nothing. So it moves out
   * of `text` (which is why this now asserts `[]`) and into `plan`, and the
   * `<pre>` rule is left governing every other request untouched.
   */
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

  /* ---- plan mode: what makes a plan a plan, and what it costs to be wrong ---- */

  /*
   * **Everything here is verbatim from this daemon's own database** — seqs 46-48
   * of a real claude session, `claude-agent-acp` on a `switch_mode` tool call
   * titled "Ready to code?". Only the plan's *wording* is a stand-in; every id,
   * every kind and the shape of both events are what was measured.
   */
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

    /*
     * **The card opens before the transcript pages in**, which is why
     * `PermissionCard` calls `loadAll` at all — so a plan whose `tool_call` has
     * not arrived must still render as a document. Requiring the kind here would
     * mean a plan drawn as monospace on a cold open and as markdown a moment
     * later, which is a worse rendering than either.
     */
    check("a plan with no tool call loaded is still a plan", permissionContext(planPending(), []).plan, planned2);

    /*
     * **The gate, and the only reason rendering markdown here is safe.** A
     * request that authorizes a concrete action is not a document — the same test
     * `askedQuestion` makes, and the case that would otherwise hand a shell
     * command to a renderer that is free to eat its asterisks.
     */
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

    /*
     * **The partition, and for a plan it moves the *source* rather than hiding
     * it.** Above the disclosure the plan is a rendered document; below it are the
     * characters it was written with, in the same verbatim `<pre>` every other
     * payload on this card gets. Nothing is drawn twice, which is what the
     * `essential`/`detail` pair means everywhere else in this file.
     */
    const essential = essentialContext(withKind);
    check("a plan is what the card always shows", essential.plan, planned2);
    check("and its source is not inline beside it", essential.text, []);
    const detail = detailContext(withKind);
    check("the disclosure never repeats the rendered plan", detail.plan, null);
    check("it holds the source instead", detail.text, [planned2]);
    check("and it is drawn at all", withheldDetail(withKind), true);
    /*
     * A plan with no `planFilePath` has a `null` arguments blob, so without its
     * own clause the disclosure would not be drawn — hiding the one thing it
     * exists to reveal.
     */
    const bare = permissionContext(planPending({ rawInput: { plan: planned2 } }), [planCall("switch_mode")]);
    check("a plan carrying nothing else still gets a disclosure", withheldDetail(bare), true);
    check("and its blob really is empty", bare.rawInput, null);

    /*
     * ⚠ **The document ends with a newline, and `pick` trims what it extracts.**
     * Measured against a real 11 KiB plan: the field came out 6818 characters and
     * the content block that echoed it was 6819, so strict equality said
     * "different" and the card drew the rendered plan with its own source
     * underneath it. Both halves of the echo test are trimmed now, and this is
     * the shape that proves it — the fixture above has no trailing newline and
     * passed throughout.
     */
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
    // The second half, which fails only once the first is fixed: with the echo
    // gone from `prose`, nothing else would drop the field from the blob.
    check("and the escaped copy does not come back in the arguments", withNewline.rawInput, '{\n  "planFilePath": "/p.md"\n}');
  }

  /* ---- the plan-mode decision, curated ---- */

  /*
   * The measured option set. Three `allow_always`, which is the whole reason this
   * has to read ids: ACP's own enum separates none of them.
   */
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
    check("a measured plan request draws three controls", controls?.length, 3);
    check("in this order", controls?.map((c) => c.option.optionId), ["plan", "acceptEdits", "auto"]);
    check("the refusal alone on the left", controls?.map((c) => c.leading), [true, false, false]);
    check(
      "and auto mode is the one filled button",
      controls?.filter((c) => c.primary).map((c) => c.option.optionId),
      ["auto"],
    );
    /*
     * **Every control here is one of the agent's own options**, and nothing
     * synthetic sits among them. A fourth button that opened a text field was
     * built and taken back out: saying what to change is the message box, which
     * takes over while a plan is on screen. Q3.454.
     */
    check(
      "and every one of them is an option the agent sent",
      controls?.every((c) => PLAN_OPTIONS.some((o) => o.optionId === c.option.optionId)),
      true,
    );

    /*
     * **`null` is today's card, and that fallback is the whole safety story.**
     * Driven as a sweep over one-field deviations rather than as four hand-written
     * cases, because what is being asserted is the *property*: anything that is
     * not exactly the shape that was measured is drawn the way it always was.
     */
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

    /*
     * The structural gates, asked separately. The kind is demanded *here* and not
     * for the rendering because this is where the consequence is: drawing a
     * document cannot approve anything, removing two of five options can.
     */
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

    // And the path it falls back *to* is untouched: five buttons, the agent's own
    // words, the reversible `allow_once` filled. This is what proves the carve-out
    // lives beside `permissionButtons` rather than inside it.
    check("the fallback still draws all five", permissionButtons(PLAN_OPTIONS as never).order.length, 5);
    check("with the reversible one primary", permissionButtons(PLAN_OPTIONS as never).primaryId, "default");
    /*
     * ⚠ **And it stays a button row, which is the interesting half.** All five of
     * claude's own words fit — the longest, "Yes, and manually approve edits", is
     * 31 characters against a ceiling of 32 — so the fallback is genuinely five
     * buttons rather than five rows. One more word in any of them and the card
     * would wrap instead, which is the behaviour that replaced *deleting* the
     * option that did not fit.
     */
    check("and the fallback is still a button row, by one character", permissionLayout(PLAN_OPTIONS as never), "buttons");
  }

  /* ---- a payload the snapshot was too small to carry ---- */

  /*
   * **8 KiB is the snapshot's cap, and 128 KiB is the log's** — so a plan too big
   * for `PendingPermissionSnapshot` is sitting whole on the `tool_call_update`.
   * The stand-in used to win the `??` chain anyway, and the card apologised for a
   * request whose arguments it could have had for free.
   */
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

  /* ---- a permission that is really a question ---- */

  /*
   * **The shape is verbatim from this daemon's own database**, session
   * `s_435ad130`, seqs 733–929: the `tool_call` and 195 of its updates carry
   * `rawInput: null`, the arguments appear once on the last update before the
   * request, and the request itself carries no `rawInput` at all. So the join has
   * to reach the updates or there is nothing to read — which is how this returned
   * nothing on the first attempt. Only the *wording* is stand-in: one header, one
   * question and four options each carrying a label and a description, which is
   * every field the join and the identity match below read.
   *
   * What it is asserting is that kimi's `AskUserQuestion` renders as the same
   * card claude's does: the question as the title, the answers as neutral rows
   * carrying their own descriptions, and Skip as a footer action.
   */
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

  /*
   * Through the real `permissionContext`, because the gate this now carries reads
   * it: a request that authorizes a concrete action — a command, a file body, a
   * diff, a set of locations — is never a question, whatever its payload says
   * about itself.
   */
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

  /*
   * The gate is the enum, not the title. Every real approval this daemon has
   * recorded offers exactly one `allow_once`; both questions offer four. Two
   * options that both say `allow_once` are indistinguishable *as permissions*, so
   * the name is carrying the meaning and it is a choice.
   */
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

  // Nothing keys on the title, so a differently-worded agent works identically.
  check(
    "the title is never read — renaming the tool changes nothing",
    asking({ ...askPending, title: "let us talk" }, askEvents)?.question,
    "Which house rule should we add to our tic-tac-toe?",
  );

  /*
   * Every failure falls back to the approval rendering rather than to a partial
   * question, because an answer we could not match is an answer whose description
   * would land on the wrong row.
   */
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

  /*
   * **The hole this gate closes, driven with the payload that opens it.**
   *
   * Four innocuous `allow_once` options and a tool input carrying a `questions`
   * array — but the request is also authorizing `rm -rf /`. Without the gate the
   * card titled itself "Which colour?", drew the four as neutral answers and
   * *hid the command*, so tapping an answer sent an approval for a destructive
   * call the person never saw. The card's whole reason to exist is that they do.
   */
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

  /*
   * The reported bug, at this — the *other* — of its two render sites.
   *
   * `{}` is not `null`, so it fell through to `JSON.stringify` and the card drew
   * the two characters `{}` above the approve buttons. `EventList` had its own
   * copy of the same function with the same hole, which is why the fix went into
   * `readInput` and there is now only one copy.
   */
  const emptyObject = permissionContext({ ...base, rawInput: {}, content: null } as never, []);
  check("an empty rawInput object is nothing, not `{}`", emptyObject.unavailable, true);

  // What a read or an edit actually carries. Before this the card showed approve
  // buttons above an empty box for exactly the requests where "which file" *is*
  // the question being asked.
  const edit = permissionContext({ ...base, rawInput: { file_path: "/home/proj/notes.txt" }, content: null } as never, []);
  check("a file-shaped argument is surfaced as the target", edit.target, "/home/proj/notes.txt");
  check("and the card is not empty", edit.unavailable, false);
}
