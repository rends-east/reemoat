import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { snapshot } from "./webcheck.ws.js";
import { openableHref } from "./webcheck.modules.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nthe question an agent asked\n");
{
  const { MAX_ANSWER_CHARS } = await import("../src/wire.js");
  const { askTitle, elicitationForm, elicitationAnswer, fieldValue, stepAnswered } = await import(
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
  check("a follow-up box loses the sentence the grouping makes redundant", ask.steps[0]?.fields[1]?.hint, null);
  check("but the flat field list is untouched", ask.fields[1]?.hint !== null, true);
  // The adapter's Other box is an unformatted string, so it holds lines; it starts at one (Q3.652).
  check(
    "the Other box may hold a newline, and starts one line tall",
    ask.fields[1]?.kind.k === "text" ? [ask.fields[1].kind.multiline, ask.fields[1].kind.rows] : null,
    [true, 1],
  );

  const renamed = elicitationForm(
    pendingOf("Which framework should I use?", 2),
    askFields.map((field, index) => ({ ...field, key: index === 0 ? "a" : "b" })),
  );
  check(
    "nothing is keyed on the adapter's field names",
    JSON.stringify(renamed.fields.map(({ key, ...rest }) => rest)),
    JSON.stringify(ask.fields.map(({ key, ...rest }) => rest)),
  );

  // One question: the message is the question; several: it is a preamble. Decided structurally, never by matching the sentence.
  check("one question keeps the agent's message, because it is the question", ask.showsPrompt, true);
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

  // Grouping is presentational only: both fields keep their own key and are sent independently.
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
  // Only an optional box directly after a choice is a follow-up.
  check(
    "loose text fields are not swallowed by the question above them",
    elicitationForm(pendingOf("x", 3), [
      { key: "a", kind: "string", title: "A", description: null, required: false, options: [{ value: "1", label: "1", description: null }], min: null, max: null, format: null, default: null },
      { key: "b", kind: "string", title: "B", description: null, required: true, options: null, min: null, max: null, format: null, default: null },
      { key: "c", kind: "string", title: "C", description: null, required: false, options: null, min: null, max: null, format: null, default: null },
    ] as any).steps.map((step) => step.fields.map((f) => f.key)),
    [["a"], ["b"], ["c"]],
  );

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
  const textKind = (form: typeof mcp, key: string): unknown => {
    const kind = form.fields.find((f) => f.key === key)?.kind;
    return kind?.k === "text" ? [kind.multiline, kind.rows] : kind?.k;
  };
  check("a long maxLength is what makes a box start three lines tall", textKind(mcp, "notes"), [true, 3]);
  check("a short one still holds lines, and starts at one", textKind(mcp, "name"), [true, 1]);
  // A format names one token, so its box is one line and Enter never has a newline to make there.
  const formatted = elicitationForm(pendingOf("Where?", 2), [
    { key: "mail", kind: "string", title: "Mail", description: null, required: true, options: null, min: null, max: 4000, format: "email", default: null },
    { key: "site", kind: "string", title: "Site", description: null, required: true, options: null, min: null, max: null, format: "uri", default: null },
  ] as any);
  check("a formatted field is one line, however long it may be", [textKind(formatted, "mail"), textKind(formatted, "site")], [[false, 1], [false, 1]]);
  check("and a number is a number", textKind(mcp, "port"), "number");

  check(
    "a multi-step form with no descriptions is titled per field",
    mcp.steps.map((_, index) => askTitle(mcp, index)),
    ["Name", "Port", "Ratio", "TLS", "Regions"],
  );
  check("and its last step is the choice with its Notes box folded in", mcp.steps.at(-1)?.fields.map((f) => f.key), [
    "regions",
    "notes",
  ]);

  const empty = elicitationAnswer(mcp, {});
  check("an untouched form sends the defaults and omits the rest", empty.content, {
    port: 8080,
    tls: true,
  });
  check("and names the required field nobody filled in", empty.problems.map((p) => [p.key, p.code]), [
    ["name", "required"],
  ]);
  check("so it cannot be submitted", empty.canSubmit, false);

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
  // The daemon refuses a string answer over its own ceiling before any maxLength, so the client must refuse it too.
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
  check("the cap counts distinct choices, not taps", codeFor({ regions: ["us", "eu", "us"] }), []);
  check(
    "a choice the form never offered",
    codeFor({ regions: ["mars"] }),
    ["not_an_option"],
  );
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

  const confirm = elicitationForm(pendingOf("Proceed?", 0), []);
  const confirmed = elicitationAnswer(confirm, {});
  check("a form with no fields can still be accepted", [confirmed.canSubmit, confirmed.content], [true, {}]);
  // The adapter marks nothing required, so only a field-less form may be submitted empty; either half alone is the bug.
  // The shape claude-agent-acp sends for one AskUserQuestion: an optional single-select and an optional Other box.
  const askedFields: any[] = [
    {
      key: "question_0",
      kind: "string",
      title: "Store",
      description: null,
      required: false,
      options: [
        { value: "Postgres", label: "Postgres", description: null },
        { value: "MongoDB", label: "MongoDB", description: null },
      ],
      min: null,
      max: null,
      format: null,
      default: null,
    },
    { key: "question_0_custom", kind: "string", title: "Other", description: null, required: false, options: null, min: null, max: null, format: null, default: null },
  ];
  const asked = elicitationForm(pendingOf("Which store?", 2), askedFields);
  check(
    "a question nobody answered is not a submission, whatever it says about required",
    [asked.fields.some((f) => f.required), elicitationAnswer(asked, {}).canSubmit],
    [false, false],
  );
  check(
    "and one answer is enough — nothing here invents a required field",
    elicitationAnswer(asked, { question_0: "Postgres" }).canSubmit,
    true,
  );
  check(
    "an emptied answer takes it back",
    elicitationAnswer(asked, { question_0: "" }).canSubmit,
    false,
  );

  // canSubmit is about the form; stepAnswered is the per-step rule that gates Next.
  const threeFields: any[] = [0, 1, 2].flatMap((n) => [
    {
      key: `question_${n}`,
      kind: "string",
      title: `Q${n}`,
      description: null,
      required: false,
      options: [
        { value: "yes", label: "yes", description: null },
        { value: "no", label: "no", description: null },
      ],
      min: null,
      max: null,
      format: null,
      default: null,
    },
    { key: `question_${n}_custom`, kind: "string", title: "Other", description: null, required: false, options: null, min: null, max: null, format: null, default: null },
  ]);
  const three = elicitationForm(pendingOf("Please answer the following questions.", 6), threeFields);
  check("a question and its own Other box are one step", three.steps.length, 3);
  const answeredAt = (draft: Record<string, unknown>): boolean[] =>
    [0, 1, 2].map((i) => stepAnswered(three, i, elicitationAnswer(three, draft as never).content));
  check("nothing answered is no step answered", answeredAt({}), [false, false, false]);
  check("one answer answers one step", answeredAt({ question_1: "yes" }), [false, true, false]);
  // The whole step, not its leader: a typed Other answer answers the step.
  check("and the Other box counts as one", answeredAt({ question_0_custom: "neither" }), [true, false, false]);
  check(
    "the whole form answered is every step answered",
    answeredAt({ question_0: "yes", question_1: "no", question_2: "yes" }),
    [true, true, true],
  );
  check("a form with nothing to fill in blocks nothing", stepAnswered(confirm, 0, {}), true);
  const cardSrc = stripComments(
    readFileSync(new URL("../src/ui/ElicitationCard.tsx", import.meta.url), "utf8"),
  );
  check("Next and Submit are both gated on this step", /!stepAnswered\(form, index, answer\.content\)/.test(cardSrc), true);
  check(
    "and only the last one is gated on the whole form",
    /stepBlocked \|\| \(last && !answer\.canSubmit\)/.test(cardSrc),
    true,
  );

  // __proto__ is a legal field name; assigning it on a plain object sets the prototype and drops the answer.
  {
    const proto = elicitationForm(pendingOf("Pick one", 1), [
      { key: "__proto__", kind: "string", title: "T", description: null, required: true,
        options: [{ value: "a", label: "a", description: null }],
        min: null, max: null, format: null, default: null },
    ] as any);
    // Computed key: a literal __proto__ is the prototype setter and creates no own property.
    const answered = elicitationAnswer(proto, { ["__proto__"]: "a" } as any);
    check("an answer to a __proto__ field survives to the body", JSON.stringify(answered.content), '{"__proto__":"a"}');
    check("and it is not reported answerable while being dropped", answered.canSubmit, true);
  }

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
    // A reduced frame counts more rows than it carries, so the partition needs this fixture.
    sessionOf({
      status: "blocked",
      turn: 1,
      pendingPermissions: [permission],
      pendingElicitations: [question],
      reduced: { pendingPermissions: 9, pendingElicitations: 4, blobs: true },
    }),
  ];

  const broken = matrix.filter(
    (session) =>
      needsHuman(session) !== waitingCount(session) > 0 ||
      waitingCount(session) < humanRequests(session).length ||
      // A form is parked mid-turn, so turn stays set; without this the transcript shows working over an unanswered question.
      (needsHuman(session) && showsWorking(session)),
  );
  check("the predicates are a partition", broken.length, 0);

  // Positively too: the inequality alone passes a waitingCount that stopped reading reduced.
  check(
    "a reduced frame counts the rows it left out, and returns only the ones it has",
    [waitingCount(matrix[7]!), humanRequests(matrix[7]!).length],
    [13, 2],
  );
  check("and it is still the oldest row that leads", humanRequests(matrix[7]!)[0]?.kind, "elicitation");

  check(
    "an older daemon's missing array behaves exactly as an empty one",
    [needsHuman(sessionOf({})), needsHuman(sessionOf({ pendingElicitations: [] }))],
    [false, false],
  );
  check("nothing waiting is an infinite wait, so Math.min needs no null check", oldestWait(sessionOf({})), Infinity);
  check(
    "the longest wait leads, whatever kind it is",
    humanRequests(matrix[4]!).map((request) => request.kind),
    ["elicitation", "permission"],
  );
  check("and a row draws one string without branching on the kind", humanRequests(matrix[4]!)[0]?.title, "Which?");

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
    ["answered", "skipped", "cancelled"],
  );
  check(
    "an outcome says what happened and nothing about the answers",
    Object.keys(elicitationOutcome(resolvedOf({ answers: [{ key: "q", label: "Framework", value: "React" }] }))).sort(),
    ["tone", "verb"],
  );

  // answeredQuestions recovers the questions from the asking tool call's arguments, matched on the chosen label, never on key spellings.
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
    // A typed answer matches no option and falls back to the field's title; the other matches are kept.
    check(
      "an answer somebody typed keeps its place with no question over it",
      answeredQuestions(
        [...answers, { key: "question_1_custom", label: "Other", value: "Until I say otherwise" }] as never,
        input,
      )?.map((a: { question: string | null }) => a.question),
      ["Which database should this use?", "How long should a session live?", null],
    );
    // A label two questions share matches neither: a wrong attribution is worse than none.
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
    // null means draw what was drawn before, the direction compatibility.md requires an unknown value to fail in.
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
    // Joined on the agent's tool call id, never on the tool's name.
    check(
      "the tool call a question came through is not drawn twice",
      tail.rows.map((row: any) => row.kind),
      ["event"],
    );
    const plain = buildTail(
      [ev(1, { type: "tool_call", toolCallId: "tc9", title: "Terminal", kind: "execute", status: "completed", locations: [], rawInput: null })],
      [],
      0,
    );
    check("and an ordinary tool call still is", plain.rows.map((row: any) => row.kind), ["tool"]);
  }

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

{
  process.stdout.write("\nwhere a link in agent output is allowed to go\n");

  // react-markdown's defaultUrlTransform passes relative hrefs through; here they resolve against the control plane and open the app again.
  check("a bare filename is not a link", openableHref("about_me.txt"), null);
  check("nor a relative path", openableHref("./src/index.ts"), null);
  check("nor an absolute path, which is a path and not a URL", openableHref("/Users/u/reemoat_agents/about_me.txt"), null);
  check("nor a file:// URI, which no browser here will open", openableHref("file:///etc/passwd"), null);
  // Empty means the current page and a fragment has nothing to jump to, so both answer null rather than an empty href.
  check("nor a bare fragment", openableHref("#section"), null);
  check("nor an empty or absent one", [openableHref(""), openableHref("   "), openableHref(undefined)], [null, null, null]);

  check("but https survives", openableHref("https://example.com/a/b?c=1#d"), "https://example.com/a/b?c=1#d");
  check("and http", openableHref("http://example.com"), "http://example.com");
  check("and mailto, the one non-web scheme every device has", openableHref("mailto:x@example.com"), "mailto:x@example.com");
  // Parsed as a URL rather than prefix-matched, so case and padding cannot smuggle a scheme past.
  check("a scheme is read the way a browser reads it", openableHref("HtTpS://example.com/"), "HtTpS://example.com/");
  check("and surrounding whitespace does not hide one", openableHref("  https://example.com/  "), "https://example.com/");
  // Not the XSS guard: react-markdown already empties javascript URLs; refused here too so the two need not be reasoned about together.
  check("a script scheme is refused here as well as upstream", [openableHref("javascript:alert(1)"), openableHref("data:text/html,<script>")], [null, null]);

  // Agent output must not make the browser fetch a host on render, so COMPONENTS must override img.
  const markdown = readFileSync(new URL("../src/ui/Markdown.tsx", import.meta.url), "utf8");
  const componentMap = markdown.slice(markdown.indexOf("const COMPONENTS"), markdown.indexOf("\n};", markdown.indexOf("const COMPONENTS")));
  check("the markdown component map overrides img at all", /^\s{2,}img:/m.test(componentMap), true);
  // Asserted as the absence of an src binding, so a click-to-load affordance stays possible.
  const imgArm = componentMap.slice(componentMap.indexOf("img:"), componentMap.indexOf("blockquote:"));
  check("and never binds it to an src the browser would follow", /\bsrc=\{/.test(imgArm), false);
  check("while the anchor is still drawn as one", /<a\s+href=\{target\}/.test(componentMap), true);
}

process.stdout.write("\na question says how many of its answers you may pick\n");
{
  // Comment-stripped for absence checks: both files argue in prose about the role they do not claim.
  const askCard = readFileSync(new URL("../src/ui/AskCard.tsx", import.meta.url), "utf8");
  const askCode = stripComments(askCard);
  const elicitation = readFileSync(new URL("../src/ui/ElicitationCard.tsx", import.meta.url), "utf8");
  const elicitationCode = stripComments(elicitation);

  check("the card knows how many an answer may be", /mark\?: "one" \| "many" \| null;/.test(askCard), true);
  // A square box: any radius makes it read as the circle.
  check(
    "a box for several and a circle for one",
    /mark === "many" \? "rounded-none" : "rounded-full"/.test(askCard),
    true,
  );
  // Scoped to the indicator: rounded-sm is right elsewhere on this card.
  const markBody = askCode.slice(askCode.indexOf("export function ChoiceMark"));
  check("the scan found the indicator", markBody.length > 200, true);
  check("and no radius creeps back onto the box", /rounded-sm/.test(markBody), false);
  check(
    "filled, one is a tick and the other a dot",
    [/<Icon as=\{Check\}/.test(askCard), /h-1\.5 w-1\.5 rounded-full bg-ink/.test(askCard)],
    [true, true],
  );
  check("and it is a ring rather than a border, so nothing reflows", /ring-1 ring-inset \$\{chosen/.test(askCard), true);
  // checkbox only where a button keeps its keys; radio would promise arrow-key roving this card lacks, so a select row uses aria-pressed.
  check(
    "a multi-select row claims checkbox, a select row claims nothing it cannot keep",
    [/role=\{option\.mark === "many" \? "checkbox" : undefined\}/.test(askCode), /role="radio"/.test(askCode)],
    [true, false],
  );
  check(
    "and says the state either way",
    [/aria-checked=\{option\.mark === "many"/.test(askCard), /aria-pressed=\{option\.mark === "one"/.test(askCard)],
    [true, true],
  );
  const permissionCard = readFileSync(new URL("../src/ui/PermissionCard.tsx", import.meta.url), "utf8");
  check("a permission's options carry no mark at all", /\bmark:/.test(permissionCard), false);
  check("the leader's rows say which kind they are", /mark: multi \? "many" : "one",/.test(elicitation), true);
  // The typed answer is painted by askRowTone, the option rows' own function, not by a matching class list.
  check("the typed answer is painted by the rows' own function", /askRowTone\(counted\)/.test(elicitationCode), true);
  check("and the option rows go through it too", /askRowTone\(option\.chosen === true\)/.test(askCode), true);
  check("it carries the step's own mark", /<ChoiceMark mark=\{mark\} chosen=\{counted\} className=\{MARK_RING\} \/>/.test(elicitationCode), true);
  // Picked means counted in the body, not text in the box.
  check("and it reads the body rather than the box", /chosen=\{typeof value === "string"/.test(elicitationCode), false);
  check("the mark comes from one rule", /mark=\{answerMark\(form, field\)\}/.test(elicitationCode), true);
  check("and a field on a form still draws as a field", /min-h-11 w-full rounded-md border border-edge bg-raised/.test(elicitationCode), true);
  // The mark says there is an answer, not which one wins: applyAskElicitationResponse prefers the custom answer, but nothing may key on its name.
  check("nothing keys on the custom field's name", /_custom|__other/.test(elicitationCode), false);
  // The mark is a button, so the row must not be a label: a label forwards activation to its field.
  check("the mark is a button", /<button\n\s+type="button"\n\s+onClick=\{\(\) => onToggle\(!counted\)\}/.test(elicitationCode), true);
  check("and the row is no longer a label", /<label className=\{`tap flex min-h-11/.test(elicitationCode), false);
  check("it keeps the roles the option rows use", [
    /role=\{mark === "many" \? "checkbox" : undefined\}/.test(elicitationCode),
    /aria-pressed=\{mark === "one" \? counted : undefined\}/.test(elicitationCode),
  ], [true, true]);

  const { elicitationForm, elicitationAnswer, displacedBy, answerMark } = await import("../src/elicitation.js");
  const pendingOf = (message: string, fieldCount: number): any => ({
    elicitationId: "elic-1-abc",
    toolCallId: "tc_1",
    message,
    fieldCount,
    raisedAt: 1_000,
  });

  const pairFields: any[] = [
    {
      key: "question_0",
      kind: "string",
      title: "Store",
      description: null,
      required: false,
      options: [
        { value: "Postgres", label: "Postgres", description: null },
        { value: "MongoDB", label: "MongoDB", description: null },
      ],
      min: null,
      max: null,
      format: null,
      default: null,
      alternativeTo: null,
    },
    { key: "question_0_custom", kind: "string", title: "Other", description: null, required: false, options: null, min: null, max: null, format: null, default: null, alternativeTo: "question_0" },
  ];
  const pair = elicitationForm(pendingOf("Which store?", 2), pairFields);
  // One direction: typing your own answer clears the selection; picking clears nothing, and elicitationAnswer stops sending the alternative.
  check("typing your own answer displaces the selection", displacedBy(pair, "question_0_custom"), ["question_0"]);
  check("and picking one displaces nothing", displacedBy(pair, "question_0"), []);
  check("it is one hop, never a walk", displacedBy(pair, "question_0_custom").flatMap((k) => displacedBy(pair, k)), []);
  const kept: Record<string, unknown> = {};
  kept["question_0_custom"] = "мой ответ";
  kept["question_0"] = "Postgres";
  check("a pick takes the answer without taking the text", [
    kept["question_0_custom"],
    Object.keys(elicitationAnswer(pair, kept as never).content).sort(),
  ], ["мой ответ", ["question_0"]]);
  check("and releasing the pick gives the answer back", [
    kept["question_0_custom"],
    Object.keys(elicitationAnswer(pair, { ...kept, question_0: "" } as never).content).sort(),
  ], ["мой ответ", ["question_0_custom"]]);
  // excluded is passed in: a DraftValue cannot spell present but not an answer.
  check("switching it off keeps the text and drops the answer", [
    Object.keys(elicitationAnswer(pair, { question_0_custom: "мой ответ" } as never, new Set(["question_0_custom"])).content),
    Object.keys(elicitationAnswer(pair, { question_0_custom: "мой ответ" } as never).content),
  ], [[], ["question_0_custom"]]);
  // An undeclared pair behaves the same: the step already knows the pairing; alternativeTo only makes it exact.
  const undeclared = elicitationForm(pendingOf("Which store?", 2), [
    { ...pairFields[0] },
    { ...pairFields[1], key: "question_0__other", alternativeTo: null },
  ] as never);
  check("an undeclared pair displaces the same way", [
    displacedBy(undeclared, "question_0"),
    displacedBy(undeclared, "question_0__other"),
  ], [[], ["question_0"]]);
  check(
    "the box wears the question's own mark, declared or not",
    [
      answerMark(pair, pair.fields[1]!),
      answerMark(undeclared, undeclared.fields[1]!),
      answerMark(pair, pair.fields[0]!),
    ],
    ["one", "one", null],
  );
  // A multi-select displaces nothing: a typed answer is one more choice.
  const multiPair = elicitationForm(pendingOf("Which stores?", 2), [
    { ...pairFields[0], kind: "multi_select" },
    { ...pairFields[1] },
  ] as never);
  check("a multi-select's box is a box", answerMark(multiPair, multiPair.fields[1]!), "many");
  check("and nothing displaces anything on one", [
    displacedBy(multiPair, "question_0"),
    displacedBy(multiPair, "question_0_custom"),
  ], [[], []]);
  const both = { question_0: ["Postgres"], question_0_custom: "мой ответ" };
  check("ticks and a typed answer are all sent", Object.keys(elicitationAnswer(multiPair, both as never).content).sort(), ["question_0", "question_0_custom"]);
  check("until the square switches one off", Object.keys(elicitationAnswer(multiPair, both as never, new Set(["question_0_custom"])).content), ["question_0"]);
  // Only a value displaces; clearing must not cascade.
  check("the card writes through the rule", /for \(const other of displacedBy\(form, field\)\) set\(other, ""\);/.test(elicitationCode), true);
  check("and a cleared value displaces nothing", /if \(empty\) return;/.test(elicitationCode), true);
  check("and the hand-rolled rows draw the same component", /<ChoiceMark mark=\{multi \? "many" : "one"\}/.test(elicitation), true);
  check(
    "with the same roles on the same terms",
    [/role=\{multi \? "checkbox" : undefined\}/.test(elicitationCode), /role="radio"/.test(elicitationCode)],
    [true, false],
  );
}

process.stdout.write("\na typed answer on the ask card draws no ring, and nothing on its row draws one outside it\n");
{
  const code = stripComments(readFileSync(new URL("../src/ui/ElicitationCard.tsx", import.meta.url), "utf8"));
  const askCode = stripComments(readFileSync(new URL("../src/ui/AskCard.tsx", import.meta.url), "utf8"));
  const css = stripComments(readFileSync(new URL("../src/index.css", import.meta.url), "utf8"));

  // The premise: an unlayered rule beats every utility, so outline-none alone drew the ring anyway (Q3.645).
  const ring = /\):not\(:where\(\.no-focus-ring\)\):focus-visible \{\s*outline: (\d+)px solid var\(--color-(\w+)\);\s*outline-offset: (\d+)px;/.exec(css);
  check("the app's ring still declares the opt-out the card spends", ring !== null, true);
  const noRing = /const NO_RING = "([^"]*)";/.exec(code)?.[1] ?? "";
  // Measured in WebKit: no-focus-ring alone brings back its own blue ring, outline-none alone the app's.
  check("the opt-out is both halves", noRing.split(" ").sort(), ["no-focus-ring", "outline-none"]);
  const classesOf = (tag: string): string[] =>
    (/className=\{?[`"]([^`"]*)[`"]\}?/.exec(tag)?.[1] ?? "").replace("${NO_RING}", noRing).split(/\s+/);
  const boxes = [...code.matchAll(/<(?:input|textarea)\b[\s\S]*?\/>/g)].map((match) => match[0]);
  check("the sweep found every element a typed box is drawn with", boxes.length >= 3, true);
  check(
    "and every one of them spends both halves",
    boxes
      .map(classesOf)
      .filter((classes) => !["no-focus-ring", "outline-none"].every((name) => classes.includes(name)))
      .map((classes) => classes.join(" ")),
    [],
  );
  // The box you type your own answer in shrinks at 390px and the mark beside it does not.
  const row = code.slice(code.indexOf("askRowTone(counted)"), code.indexOf("onToggle(!counted)"));
  const typed = (/<TypedAnswer[\s\S]*?className="([^"]*)"/.exec(row)?.[1] ?? "").split(" ");
  check("the typed answer is the row's shrinking half", ["min-w-0", "flex-1"].every((name) => typed.includes(name)), true);
  check(
    "the box looks the same focused and not, on the card and on the frame",
    [/\bfocus(?:-within|-visible)?:/.test(code), /\bfocus(?:-within|-visible)?:/.test(askCode)],
    [false, false],
  );

  // The mark's target is invisible and flush with the row, so the app's ring around it straddled the row's edge.
  const markButton = /<button\n\s+type="button"\n\s+onClick=\{\(\) => onToggle\(!counted\)\}[\s\S]*?>/.exec(code)?.[0] ?? "";
  check("the mark's target opts out of the ring", ["no-focus-ring", "outline-none"].every((name) => classesOf(markButton).includes(name)), true);
  const markRing = (/const MARK_RING =\s*"([^"]*)";/.exec(code)?.[1] ?? "").split(" ").sort();
  const [, width, colour, offset] = ring ?? [];
  check(
    "and the glyph draws the app's own ring, read off index.css",
    markRing,
    [`outline-${width}`, `outline-offset-${offset}`, `outline-${colour}`].map((name) => `[button:focus-visible_&]:${name}`).sort(),
  );
}

process.stdout.write("\nyour own answer takes a line break, and Enter still moves the card on\n");
{
  const { answerKey } = await import("../src/keys.js");
  const { elicitationForm, elicitationAnswer } = await import("../src/elicitation.js");
  const code = stripComments(readFileSync(new URL("../src/ui/ElicitationCard.tsx", import.meta.url), "utf8"));

  // The composer's rule, asked with a menu that is never open (Q3.652).
  const enter = { key: "Enter" };
  check(
    "on a keyboard Enter moves the card on, and Shift+Enter is the newline",
    [answerKey(enter, true), answerKey({ ...enter, shiftKey: true }, true)],
    ["advance", null],
  );
  check("on a soft keyboard Enter is the newline, since there is no Shift", answerKey(enter, false), null);
  check("an IME commit never moves the card on", answerKey({ ...enter, isComposing: true }, true), null);
  check(
    "nor does a chord, or any other key",
    [answerKey({ ...enter, metaKey: true }, true), answerKey({ ...enter, ctrlKey: true }, true), answerKey({ key: "a" }, true)],
    [null, null, null],
  );

  // Every box reads the pointer at the keystroke, as the composer does, and nothing else on the card reads Enter.
  check(
    "the card asks the rule with the pointer read at the keystroke",
    /answerKey\(\s*\{ \.\.\.event, isComposing: event\.nativeEvent\.isComposing \},\s*!window\.matchMedia\("\(pointer: coarse\)"\)\.matches,?\s*\)/.test(code),
    true,
  );
  check("and reads no Enter of its own", /"Enter"/.test(code), false);
  const keyed = [...code.matchAll(/<(?:input|textarea)\b[\s\S]*?\/>/g)].filter((match) => /onKeyDown=\{\(event\) => advanceOnEnter\(event, onAdvance\)\}/.test(match[0]));
  check("every box a person types into takes it", keyed.length, [...code.matchAll(/<(?:input|textarea)\b/g)].length);
  // Enter and the button are one action behind one gate, so Enter can never do what the button would refuse.
  check(
    "Enter and Next/Submit share the action and its gate",
    [/<AskAction tone="primary" onClick=\{advance\} disabled=\{advanceBlocked\}/.test(code), /onAdvance=\{advance\}/.test(code), /if \(advanceBlocked\) return;/.test(code)],
    [true, true, true],
  );

  // Grown by the composer's own measure, which holds the row's height while it collapses to measure (Q3.649).
  check(
    "the box grows through fitToContent, before paint and on a resize",
    [/useLayoutEffect\(\(\) => \{\s*if \(areaRef\.current !== null\) fitToContent\(areaRef\.current\);/.test(code), /window\.visualViewport\?\.addEventListener\("resize", refit\)/.test(code)],
    [true, true],
  );
  check("and there is no second autosize", /scrollHeight|style\.height/.test(code), false);
  // fitToContent writes scrollHeight, which leaves a border out: a bordered box would lose 2px of its last line.
  const calls = [...code.matchAll(/<TypedAnswer[\s\S]*?className="([^"]*)"/g)].map((match) => match[1] ?? "");
  check("the sweep found both places a box is drawn", calls.length, 2);
  check("and neither draws a border of its own", calls.filter((classes) => !classes.split(" ").includes("border-none")), []);
  check("the one under a question is a line level with its mark", /flex min-h-11 w-full items-start rounded-md border \$\{askRowTone\(counted\)\}/.test(code), true);

  // What is sent keeps every line: only the blank lines before it and the whitespace after it go, as a message's do.
  const pendingOf = (message: string, fieldCount: number): any => ({ elicitationId: "e", toolCallId: null, message, fieldCount, raisedAt: 1 });
  const form = elicitationForm(pendingOf("Which picture?", 3), [
    { key: "q", kind: "string", title: "Q", description: null, required: false, options: [{ value: "a", label: "a", description: null }], min: null, max: null, format: null, default: null, alternativeTo: null },
    { key: "q_custom", kind: "string", title: "Other", description: null, required: false, options: null, min: null, max: null, format: null, default: null, alternativeTo: "q" },
    { key: "mail", kind: "string", title: "Mail", description: null, required: false, options: null, min: null, max: null, format: "email", default: null },
  ] as any);
  const typed = "\n  моя картинка:\n\n  - вторая строка  \n";
  check(
    "a typed answer is sent with its lines and its first line's indentation",
    elicitationAnswer(form, { q_custom: typed } as never).content["q_custom"],
    "  моя картинка:\n\n  - вторая строка",
  );
  check("and a one-line value's ends still go", elicitationAnswer(form, { mail: "  a@b.c  " } as never).content["mail"], "a@b.c");
  check("whitespace and newlines alone are still no answer", Object.keys(elicitationAnswer(form, { q_custom: " \n\n " } as never).content), []);
}
