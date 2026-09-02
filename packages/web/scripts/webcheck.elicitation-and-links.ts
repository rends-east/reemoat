import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { snapshot } from "./webcheck.ws.js";
import { openableHref } from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * The question an agent asked
 * ------------------------------------------------------------------ */

/**
 * The form, the answer, and the predicate that carries both into the fleet view.
 *
 * Every rule here fails *silently* in a direction nobody notices from the outside:
 * a zero sent for a field somebody left blank, an empty string that reads as an
 * answer, a Submit button enabled onto a 400, a session that is both waiting and
 * working. That is what earns them a place in this file rather than in the JSX.
 */
process.stdout.write("\nthe question an agent asked\n");
{
  const { MAX_ANSWER_CHARS } = await import("../src/wire.js");
  const { askTitle, elicitationForm, elicitationAnswer, fieldValue } = await import(
    "../src/elicitation.js"
  );
  const { humanRequests, needsHuman, waitingCount, oldestWait, showsWorking } = await import(
    "../src/wire.js"
  );
  const { elicitationOutcome } = await import("../src/ui/tail.js");
  const { answerAlreadyLanded } = await import("../src/http.js");
  const { ApiError } = await import("../src/http.js");

  const pendingOf = (message: string, fieldCount: number): any => ({
    elicitationId: "elic-1-abc",
    toolCallId: "tc_1",
    message,
    fieldCount,
    raisedAt: 1_000,
  });

  /* ---- A: the measured AskUserQuestion shape, N=1 ---- */

  const askFields: any[] = [
    {
      key: "question_0",
      kind: "string",
      title: "Framework",
      description: null,
      required: false,
      options: [
        { value: "React", label: "React", description: "Already in package.json" },
        { value: "Svelte", label: "Svelte", description: null },
      ],
      min: null,
      max: null,
      format: null,
      default: null,
    },
    {
      key: "question_0_custom",
      kind: "string",
      title: "Other",
      description: "Type your own answer instead of choosing an option above (optional).",
      required: false,
      options: null,
      min: null,
      max: null,
      format: null,
      default: null,
    },
  ];
  const ask = elicitationForm(pendingOf("Which framework should I use?", 2), askFields);

  check("the prompt is the agent's own message", ask.message, "Which framework should I use?");
  check(
    "a titled select becomes option rows and the Other box a text field",
    ask.fields.map((field) => [field.key, field.kind.k, field.label]),
    [
      ["question_0", "select", "Framework"],
      ["question_0_custom", "text", "Other"],
    ],
  );
  // The adapter's explanation of its own box is dropped once the box sits under
  // the choices it belongs to — the layout says it. A loose text field keeps it.
  check("a follow-up box loses the sentence the grouping makes redundant", ask.steps[0]?.fields[1]?.hint, null);
  check("but the flat field list is untouched", ask.fields[1]?.hint !== null, true);
  // An unbounded string is one line: the commonest one in practice is the
  // adapter's own "Other" box, and a textarea there would be three rows of
  // nothing on a phone.
  check(
    "an unbounded string field is a single line",
    ask.fields[1]?.kind.k === "text" && ask.fields[1].kind.multiline,
    false,
  );

  /*
   * **The assertion that pins the culture rule.** Rename the adapter's own field
   * keys and assert an identical form comes out. Anything that ever greps for
   * `question_` or `_custom` fails here.
   */
  const renamed = elicitationForm(
    pendingOf("Which framework should I use?", 2),
    askFields.map((field, index) => ({ ...field, key: index === 0 ? "a" : "b" })),
  );
  check(
    "nothing is keyed on the adapter's field names",
    JSON.stringify(renamed.fields.map(({ key, ...rest }) => rest)),
    JSON.stringify(ask.fields.map(({ key, ...rest }) => rest)),
  );

  /*
   * With one question the agent's `message` *is* the question, so it is drawn.
   * With several it is a preamble — "Please answer the following questions." —
   * and each question carries its own text, so drawing it costs a line of
   * boilerplate above questions that already speak for themselves.
   *
   * Decided structurally and never by matching that sentence. The two fixtures
   * below are the measured shapes for N=1 and N=2.
   */
  check("one question keeps the agent's message, because it is the question", ask.showsPrompt, true);
  /*
   * The other half of that, and the half that is silently wrong on one agent if
   * the three sources are read in the wrong order. With one question the title is
   * the *message* — reading the field's `title` first would put the short chip
   * label "Framework" at the top of the card and drop the sentence somebody has
   * to answer.
   */
  check("and the card is titled with it, not with the field's chip label", askTitle(ask, 0), "Which framework should I use?");
  {
    const twoQuestions: any[] = [
      { ...askFields[0], key: "q0", description: "Which framework?" },
      { ...askFields[1], key: "q0c" },
      { ...askFields[0], key: "q1", title: "TTL", description: "Which TTL?" },
      { ...askFields[1], key: "q1c" },
    ];
    const many = elicitationForm(pendingOf("Please answer the following questions.", 4), twoQuestions);
    check("several drop it, because each question carries its own text", many.showsPrompt, false);
    // The free-text box always has a description of its own, so it must not be
    // what answers "do the questions speak for themselves".
    check("and the Other boxes do not count as questions", many.fields.length, 4);
    check(
      "so each step is titled with its own question, not with the preamble",
      [askTitle(many, 0), askTitle(many, 1)],
      ["Which framework?", "Which TTL?"],
    );
  }
  check(
    "a form with no choices at all keeps it, since nothing else says what is wanted",
    elicitationForm(pendingOf("What should I name it?", 1), [
      { key: "name", kind: "string", title: "Name", description: null, required: true, options: null, min: null, max: null, format: null, default: null },
    ] as any).showsPrompt,
    true,
  );

  /*
   * Grouping, which is what makes stepping possible at all.
   *
   * Three questions arrive as six fields; without a notion of "one question"
   * that is six screens, half of them a bare text box with no idea what it is
   * for. The rule is presentational only — both fields keep their own key and
   * both are sent independently — which is why it was worth taking after being
   * refused once.
   */
  check("a choice and its free-text box are one question", ask.steps.length, 1);
  check("and both fields are still there, each with its own key", ask.steps[0]?.fields.map((f) => f.key), [
    "question_0",
    "question_0_custom",
  ]);
  {
    const three: any[] = [];
    for (let i = 0; i < 3; i += 1) {
      three.push({ ...askFields[0], key: `q${i}`, description: `Question ${i}?` });
      three.push({ ...askFields[1], key: `q${i}c` });
    }
    const stepped = elicitationForm(pendingOf("Please answer the following questions.", 6), three);
    check("three questions are three steps, not six", stepped.steps.length, 3);
  }
  // A required text field is a question of its own, and so is a second loose one:
  // only an *optional* box directly after a choice is a follow-up.
  check(
    "loose text fields are not swallowed by the question above them",
    elicitationForm(pendingOf("x", 3), [
      { key: "a", kind: "string", title: "A", description: null, required: false, options: [{ value: "1", label: "1", description: null }], min: null, max: null, format: null, default: null },
      { key: "b", kind: "string", title: "B", description: null, required: true, options: null, min: null, max: null, format: null, default: null },
      { key: "c", kind: "string", title: "C", description: null, required: false, options: null, min: null, max: null, format: null, default: null },
    ] as any).steps.map((step) => step.fields.map((f) => f.key)),
    [["a"], ["b"], ["c"]],
  );

  /* ---- B: a generic MCP-shaped form ---- */

  const mcpFields: any[] = [
    { key: "name", kind: "string", title: "Name", description: null, required: true, options: null, min: 3, max: 20, format: null, default: null },
    { key: "port", kind: "integer", title: "Port", description: null, required: true, options: null, min: 1024, max: 65535, format: null, default: 8080 },
    { key: "ratio", kind: "number", title: "Ratio", description: null, required: false, options: null, min: 0, max: 1, format: null, default: null },
    { key: "tls", kind: "boolean", title: "TLS", description: null, required: false, options: null, min: null, max: null, format: null, default: true },
    {
      key: "regions",
      kind: "multi_select",
      title: "Regions",
      description: null,
      required: false,
      options: [
        { value: "us", label: "us", description: null },
        { value: "eu", label: "eu", description: null },
      ],
      min: 1,
      max: 2,
      format: null,
      default: null,
    },
    { key: "notes", kind: "string", title: "Notes", description: null, required: false, options: null, min: null, max: 4000, format: null, default: null },
  ];
  const mcp = elicitationForm(pendingOf("Configure the service.", 6), mcpFields);
  check(
    "a long maxLength is what makes a field multiline",
    mcp.fields.find((f) => f.key === "notes")?.kind.k === "text" &&
      (mcp.fields.find((f) => f.key === "notes")!.kind as any).multiline,
    true,
  );

  /*
   * The third arm of `askTitle`, and it exists because a whole MCP form was
   * titled with one generic sentence five times over.
   *
   * These fields carry a `title` and no `description`, so there is no question to
   * read off the step and the message is a preamble rather than the question —
   * and `regions` is a multi-select, so its own options become the card's
   * unlabelled rows and the word "Regions" appeared nowhere on screen.
   */
  check(
    "a multi-step form with no descriptions is titled per field",
    mcp.steps.map((_, index) => askTitle(mcp, index)),
    ["Name", "Port", "Ratio", "TLS", "Regions"],
  );
  check("and its last step is the choice with its Notes box folded in", mcp.steps.at(-1)?.fields.map((f) => f.key), [
    "regions",
    "notes",
  ]);

  /*
   * The anchor case, and it pins three separate rules at once: an agent's default
   * is *sent* (the control is showing it, so it is the answer), an untouched
   * optional field is *omitted*, and a missing required one blocks Submit.
   */
  const empty = elicitationAnswer(mcp, {});
  check("an untouched form sends the defaults and omits the rest", empty.content, {
    port: 8080,
    tls: true,
  });
  check("and names the required field nobody filled in", empty.problems.map((p) => [p.key, p.code]), [
    ["name", "required"],
  ]);
  check("so it cannot be submitted", empty.canSubmit, false);

  /*
   * `Number("")` and `Number(" ")` are both `0`. A parse-first implementation
   * silently sends a zero nobody typed into a blank optional number field, which
   * is exactly the shape of bug this file exists for.
   */
  for (const blank of ["", "   "]) {
    check(
      `a blank number is not zero (${JSON.stringify(blank)})`,
      "ratio" in elicitationAnswer(mcp, { name: "ok", ratio: blank }).content,
      false,
    );
  }
  check(
    "false is an answer, not an absence",
    elicitationAnswer(mcp, { name: "ok", tls: false }).content.tls,
    false,
  );
  check(
    "a deliberately emptied multi-select is sent, not dropped",
    elicitationAnswer(mcp, { name: "okay", regions: [] }).problems.map((p) => p.code),
    ["too_few"],
  );
  check(
    "text is trimmed on the way out",
    elicitationAnswer(mcp, { name: "  okay  " }).content.name,
    "okay",
  );

  const codeFor = (draft: Record<string, any>): string[] =>
    elicitationAnswer(mcp, { name: "okay", ...draft }).problems.map((p) => p.code);
  check("a short string", elicitationAnswer(mcp, { name: "ab" }).problems.map((p) => p.code), ["too_short"]);
  /*
   * **The daemon's own ceiling, which the client did not have.** `registry.ts`
   * refuses any string answer over `MAX_ELICITATION_ANSWER_CHARS` (2048) *before*
   * it looks at the field's own `maxLength` — and the field the adapter is most
   * likely to leave unbounded is its free-text "Other" box. So `canSubmit` said
   * yes and the POST came back `400`, which is the one thing this file's docblock
   * says cannot happen because the value enabling the button is the value sent.
   */
  check(
    "an answer past the daemon's ceiling is refused here, not by the route",
    elicitationAnswer(mcp, { name: "okay", notes: "x".repeat(MAX_ANSWER_CHARS + 1) }).problems.map((p) => p.code),
    ["too_long"],
  );
  check(
    "and one exactly at it goes",
    elicitationAnswer(mcp, { name: "okay", notes: "x".repeat(MAX_ANSWER_CHARS) }).canSubmit,
    true,
  );
  check("a fractional integer", codeFor({ port: "1.5" }), ["not_an_integer"]);
  check("a number below its minimum", codeFor({ port: "80" }), ["below_min"]);
  check("a number above its maximum", codeFor({ ratio: "2" }), ["above_max"]);
  check("something that is not a number at all", codeFor({ ratio: "abc" }), ["not_a_number"]);
  // Deduping happens *before* the count is checked, so three taps on two distinct
  // options is two choices rather than one over the cap.
  check("the cap counts distinct choices, not taps", codeFor({ regions: ["us", "eu", "us"] }), []);
  check(
    "a choice the form never offered",
    codeFor({ regions: ["mars"] }),
    ["not_an_option"],
  );
  // Deduped keeping first order, so two identical taps are one choice rather than
  // a repeated label reaching the agent.
  check(
    "duplicates collapse rather than failing",
    elicitationAnswer(mcp, { name: "ok", regions: ["us", "us"] }).content.regions,
    ["us"],
  );

  check(
    "what a control shows is the draft, else the agent's default",
    [fieldValue(mcp.fields[1]!, {}), fieldValue(mcp.fields[1]!, { port: "9999" })],
    ["8080", "9999"],
  );

  /* ---- C: an empty form is answerable ---- */

  const confirm = elicitationForm(pendingOf("Proceed?", 0), []);
  const confirmed = elicitationAnswer(confirm, {});
  check("a form with no fields can still be accepted", [confirmed.canSubmit, confirmed.content], [true, {}]);

  /*
   * **The agent chooses the field names, and one of them is a landmine.**
   * `__proto__` is a legal JSON Schema property; on a plain `{}`,
   * `content[key] = value` sets the *prototype* rather than an own property, so
   * the answer vanished while `canSubmit` still said `true` — a form the card
   * called valid, an empty body on the wire, and a `400` from the daemon for a
   * form somebody filled in correctly.
   */
  {
    const proto = elicitationForm(pendingOf("Pick one", 1), [
      { key: "__proto__", kind: "string", title: "T", description: null, required: true,
        options: [{ value: "a", label: "a", description: null }],
        min: null, max: null, format: null, default: null },
    ] as any);
    // A *computed* key, because `{__proto__: "a"}` in a literal is the
    // prototype-setter syntax and creates no own property — the draft that
    // reaches this in the app is built by `setDraftField`, which assigns.
    const answered = elicitationAnswer(proto, { ["__proto__"]: "a" } as any);
    check("an answer to a __proto__ field survives to the body", JSON.stringify(answered.content), '{"__proto__":"a"}');
    check("and it is not reported answerable while being dropped", answered.canSubmit, true);
  }

  /* ---- D: the predicate set, as a partition ---- */

  const sessionOf = (over: Record<string, unknown>): any => ({
    ...snapshot,
    turn: null,
    status: "idle",
    pendingPermissions: [],
    ...over,
  });

  const permission = { permissionId: "p1", toolCallId: null, title: "Terminal", options: [], raisedAt: 10, rawInput: null, content: null };
  const question = { elicitationId: "e1", toolCallId: null, message: "Which?", fieldCount: 1, raisedAt: 5 };

  const matrix = [
    sessionOf({}),
    sessionOf({ turn: 1, status: "running" }),
    sessionOf({ status: "blocked", turn: 1, pendingPermissions: [permission] }),
    sessionOf({ status: "blocked", turn: 1, pendingElicitations: [question] }),
    sessionOf({ status: "blocked", turn: 1, pendingPermissions: [permission], pendingElicitations: [question] }),
    sessionOf({ pendingElicitations: [] }),
    sessionOf({ status: "exited", exit: { reason: "stopped", at: 0, detail: null } }),
  ];

  const broken = matrix.filter(
    (session) =>
      needsHuman(session) !== waitingCount(session) > 0 ||
      waitingCount(session) !== humanRequests(session).length ||
      // The clause that matters: a form is parked mid-turn, so `turn` stays set.
      // Without it the transcript blinks "working…" over a question nobody has
      // answered.
      (needsHuman(session) && showsWorking(session)),
  );
  check("the predicates are a partition", broken.length, 0);

  check(
    "an older daemon's missing array behaves exactly as an empty one",
    [needsHuman(sessionOf({})), needsHuman(sessionOf({ pendingElicitations: [] }))],
    [false, false],
  );
  check("nothing waiting is an infinite wait, so Math.min needs no null check", oldestWait(sessionOf({})), Infinity);
  /*
   * Oldest first, and a permission does not lead by being the older feature. The
   * question here was raised at 5 and the approval at 10.
   */
  check(
    "the longest wait leads, whatever kind it is",
    humanRequests(matrix[4]!).map((request) => request.kind),
    ["elicitation", "permission"],
  );
  check("and a row draws one string without branching on the kind", humanRequests(matrix[4]!)[0]?.title, "Which?");

  /* ---- E: the transcript ---- */

  const resolvedOf = (over: Record<string, unknown>): any => ({
    type: "elicitation_resolved",
    elicitationId: "e1",
    toolCallId: null,
    message: "Which?",
    action: "accept",
    answers: null,
    by: "client",
    ...over,
  });

  check(
    "the three verbs",
    [
      elicitationOutcome(resolvedOf({ action: "accept" })).verb,
      elicitationOutcome(resolvedOf({ action: "decline" })).verb,
      elicitationOutcome(resolvedOf({ action: "cancel" })).verb,
    ],
    // `skipped` is the adapter's own word, so the row and the model say the same
    // thing about what happened.
    ["answered", "skipped", "cancelled"],
  );
  /*
   * ⚠ **Two assertions stood here on a `summary` field nothing rendered.** It
   * joined the answers and cut them at 160 characters; `ElicitationResolvedRow`
   * draws `event.answers` itself and always did, so the only readers of that clip
   * were these two checks — which pinned it in place rather than revealing it. The
   * field is gone, and what replaces the coverage is `answeredQuestions` below,
   * which is about a string somebody actually sees.
   */
  check(
    "an outcome says what happened and nothing about the answers",
    Object.keys(elicitationOutcome(resolvedOf({ answers: [{ key: "q", label: "Framework", value: "React" }] }))).sort(),
    ["tone", "verb"],
  );

  /* ---- the questions behind a settled form's answers ---- */

  /*
   * ⚠ **The defect: a settled `AskUserQuestion` kept the answers and lost the
   * questions.** `ElicitationResolvedEvent` carries `message` plus `{key, label,
   * value}` per answer, and for a multi-question form the adapter puts a preamble
   * in `message` and each real question in its field's *description*, which the
   * resolution does not carry. Measured on this machine's own log, session
   * `s_5d26f98e`: the transcript read *"Please answer the following questions."*
   * over four bare values, and the four questions appeared nowhere at all.
   *
   * `answeredQuestions` recovers them from the one place a client can reach — the
   * arguments of the tool call the question was asked through, which `askedThrough`
   * merges away — and matches **by identity on the chosen label**, never by parsing
   * `question_0` / `<question>__other`, which are two adapters' spellings of the
   * same idea.
   */
  {
    const { answeredQuestions } = await import("../src/ui/tail.js");
    const input = {
      questions: [
        {
          question: "Which database should this use?",
          options: [
            { label: "Use SQLite", description: "One file, no server." },
            { label: "Use Postgres with a connection pool", description: null },
          ],
        },
        {
          question: "How long should a session live?",
          options: [{ label: "5m" }, { label: "An hour, so a laptop lid does not end it" }],
        },
      ],
    };
    const answers = [
      { key: "question_0", label: "Database", value: "Use Postgres with a connection pool" },
      { key: "question_1", label: "TTL", value: "5m" },
    ];
    check(
      "each answer is drawn under the question it answered",
      answeredQuestions(answers as never, input)?.map((a: { question: string | null }) => a.question),
      ["Which database should this use?", "How long should a session live?"],
    );
    /*
     * The answer nothing matched: claude gives every question its own free-text
     * box, and what somebody types into one is by definition not an option. The
     * row falls back to the field's own title, which is the only honest label a
     * typed answer has — and the questions beside it are still real, so a partial
     * match is kept rather than abandoning the whole join.
     */
    check(
      "an answer somebody typed keeps its place with no question over it",
      answeredQuestions(
        [...answers, { key: "question_1_custom", label: "Other", value: "Until I say otherwise" }] as never,
        input,
      )?.map((a: { question: string | null }) => a.question),
      ["Which database should this use?", "How long should a session live?", null],
    );
    /*
     * ⚠ **A label two questions share matches neither**, and this is the case that
     * makes the join safe rather than merely convenient. Attributing an answer to
     * the wrong question would draw a confident record of an exchange that did not
     * happen — worse than drawing no question at all, which is what a `null` here
     * falls back to.
     */
    const collides = {
      questions: [
        { question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] },
        { question: "Tag it?", options: [{ label: "Yes" }, { label: "Later" }] },
      ],
    };
    check(
      "an answer both questions offer is attributed to neither",
      answeredQuestions([{ key: "a", label: "Ship", value: "Yes" }] as never, collides),
      null,
    );
    check(
      "while an answer only one of them offers is still attributed",
      answeredQuestions([{ key: "a", label: "Tag", value: "Later" }] as never, collides)?.map(
        (a: { question: string | null }) => a.question,
      ),
      ["Tag it?"],
    );
    /*
     * The three ways this falls back to what the transcript drew before, all of
     * them reachable: a call outside the loaded window (`undefined`), the 8 KiB
     * truncation stand-in, and a question from an MCP server, which has no
     * `{questions: […]}` shape and never will. `null` means "draw what you drew
     * before", which is the direction `compatibility.md` requires an unknown value
     * to fail in.
     */
    check(
      "and nothing at all is drawn as it was before",
      [
        answeredQuestions(answers as never, undefined),
        answeredQuestions(answers as never, { truncated: true, bytes: 9000 }),
        answeredQuestions(answers as never, { schema: { type: "object" } }),
        answeredQuestions(answers as never, { questions: [{ question: "Unrelated", options: [{ label: "x" }] }] }),
      ],
      [null, null, null, null],
    );
  }

  /* ---- the tool call a question came through ---- */

  {
    const { buildTail } = await import("../src/ui/tail.js");
    const ev = (seq: number, event: unknown): any => ({ seq, ts: seq, event });
    const tail = buildTail(
      [
        ev(1, { type: "tool_call", toolCallId: "tc1", title: "Asking for your input", kind: "other", status: "completed", locations: [], rawInput: null }),
        ev(2, { type: "elicitation_request", elicitationId: "e1", toolCallId: "tc1", message: "Which?" }),
        ev(3, { type: "elicitation_resolved", elicitationId: "e1", toolCallId: "tc1", message: "Which?", action: "accept", answers: [{ key: "q", label: "Q", value: "A" }], by: "client" }),
      ],
      [],
      0,
    );
    // The card that carried the question is drawn by the question, never beside
    // it — joined on the id the agent supplied, never on the tool's name.
    check(
      "the tool call a question came through is not drawn twice",
      tail.rows.map((row: any) => row.kind),
      ["event"],
    );
    // An ordinary tool call is untouched, which is what makes the rule a join
    // rather than a filter on anything that looks like a question.
    const plain = buildTail(
      [ev(1, { type: "tool_call", toolCallId: "tc9", title: "Terminal", kind: "execute", status: "completed", locations: [], rawInput: null })],
      [],
      0,
    );
    check("and an ordinary tool call still is", plain.rows.map((row: any) => row.kind), ["tool"]);
  }

  /* ---- F: the 409 that is really a success ---- */

  const errorOf = (status: number, body: unknown, code = "http_409"): unknown =>
    new ApiError(status, code, "nope", null, body);
  check(
    "a 409 is success when it says the answer already landed",
    [
      answerAlreadyLanded(errorOf(409, { repeat: true }), "elicitation_expired"),
      answerAlreadyLanded(errorOf(409, { error: {} }, "elicitation_expired"), "elicitation_expired"),
      answerAlreadyLanded(errorOf(409, { error: {} }), "elicitation_expired"),
      answerAlreadyLanded(errorOf(500, { repeat: true }), "elicitation_expired"),
    ],
    [true, true, false, false],
  );
}

/* ------------------------------------------------------------------ *
 * Where a link in agent output is allowed to go
 * ------------------------------------------------------------------ */
{
  process.stdout.write("\nwhere a link in agent output is allowed to go\n");

  /*
   * The case this exists for, measured on a live session.
   *
   * codex finished with "Done: created the file about_me.txt with this text.", and
   * the filename came through as a markdown link. react-markdown passes a
   * relative href through **on purpose** — its `defaultUrlTransform` returns early
   * when there is no protocol — which is right for a document sitting beside the
   * files it links, and wrong here: this page is served by the control plane, so
   * the anchor pointed at `https://<control-plane>/about_me.txt`, the SPA fallback
   * answered it with `index.html`, and tapping a filename opened a second copy of
   * the app.
   */
  check("a bare filename is not a link", openableHref("about_me.txt"), null);
  check("nor a relative path", openableHref("./src/index.ts"), null);
  /*
   * **An absolute path is the one most likely to look safe**, because it is
   * absolute — and it is a path on the *agent's* machine, so against this origin
   * it is just another SPA route.
   */
  check("nor an absolute path, which is a path and not a URL", openableHref("/Users/u/reemoat_agents/about_me.txt"), null);
  check("nor a file:// URI, which no browser here will open", openableHref("file:///etc/passwd"), null);
  // A fragment has nothing to jump to in this transcript, and empty means "the
  // page you are on" — `href=""` navigates, which is why `null` is the answer
  // rather than a stripped attribute.
  check("nor a bare fragment", openableHref("#section"), null);
  check("nor an empty or absent one", [openableHref(""), openableHref("   "), openableHref(undefined)], [null, null, null]);

  // What is kept: the links an agent cites that a phone can actually open.
  check("but https survives", openableHref("https://example.com/a/b?c=1#d"), "https://example.com/a/b?c=1#d");
  check("and http", openableHref("http://example.com"), "http://example.com");
  check("and mailto, the one non-web scheme every device has", openableHref("mailto:x@example.com"), "mailto:x@example.com");
  // Parsed rather than prefix-matched, so case and padding cannot smuggle one
  // past — `new URL` is what decides what the browser would do.
  check("a scheme is read the way a browser reads it", openableHref("HtTpS://example.com/"), "HtTpS://example.com/");
  check("and surrounding whitespace does not hide one", openableHref("  https://example.com/  "), "https://example.com/");
  /*
   * Not an XSS fix, and saying so keeps somebody from deleting the real guard.
   * `javascript:` never reaches this function — react-markdown's own transform
   * empties it first — but this refuses it too, so the two do not have to be
   * reasoned about together.
   */
  check("a script scheme is refused here as well as upstream", [openableHref("javascript:alert(1)"), openableHref("data:text/html,<script>")], [null, null]);

  /*
   * ⚠ **`openableHref` guards the anchor and nothing guarded the image**, which
   * is the worse of the two: a link needs a tap and an `<img>` does not.
   *
   * `COMPONENTS` overrides `a` precisely because agent output is untrusted text
   * quoting an untrusted repository. It overrode no `img`, so `![](https://…)`
   * fell through to react-markdown's default `<img src>` — whose transform allows
   * `https:` — and the browser fetched a host the agent chose, on render, with no
   * interaction, from the origin holding `reemoat.credential`. Everything the
   * agent wanted to say went out in the query string. Prompt injection in a
   * README, an issue body or a fetched page is the whole delivery mechanism, and
   * there is no CSP anywhere in this app to catch it.
   *
   * Read off disk in the style of the `SessionBrowser.tsx` and `SignIn.tsx`
   * assertions, because what has to be true is a fact about the *component map*
   * — a pure function cannot be asked whether a key exists in an object literal
   * two files away, and the defect was precisely an absent key.
   */
  const markdown = readFileSync(new URL("../src/ui/Markdown.tsx", import.meta.url), "utf8");
  const componentMap = markdown.slice(markdown.indexOf("const COMPONENTS"), markdown.indexOf("\n};", markdown.indexOf("const COMPONENTS")));
  check("the markdown component map overrides img at all", /^\s{2,}img:/m.test(componentMap), true);
  /*
   * And does not hand the agent's URL back to the browser. Asserted as the
   * absence of an `src=` binding rather than the presence of a particular
   * rendering, so a future click-to-load affordance is free to arrive — what may
   * not arrive is anything the browser fetches without being asked.
   */
  const imgArm = componentMap.slice(componentMap.indexOf("img:"), componentMap.indexOf("blockquote:"));
  check("and never binds it to an src the browser would follow", /\bsrc=\{/.test(imgArm), false);
  // The anchor is still an anchor, so this cannot pass by the map having been
  // emptied — which is the failure mode a "does not contain" assertion invites.
  check("while the anchor is still drawn as one", /<a\s+href=\{target\}/.test(componentMap), true);
}
