import { readFrom, sanitize } from "../src/agentauth.js";
import { gitArgs, gitEnv } from "../src/git.js";
import { validateElicitationContent } from "../src/registry.js";
import { check } from "./daemoncheck.env.js";

process.stdout.write("\ngit runs with the user's own configuration\n");
{
  const argv = gitArgs("/repo", ["worktree", "add", "--", "/repo/wt", "abc123"]);
  check("the directory is named with -C and nothing precedes it", argv[0], "-C");
  check("no -c override is prepended", argv.includes("-c"), false);
  check("and the caller's own arguments are untouched", argv.slice(2), [
    "worktree",
    "add",
    "--",
    "/repo/wt",
    "abc123",
  ]);

  const env = gitEnv();
  // Blanking the user's global config silently turns LFS content into pointer files on checkout.
  check("the user's global config is not blanked", env["GIT_CONFIG_GLOBAL"], undefined);
  check("nor is the system config suppressed", env["GIT_CONFIG_NOSYSTEM"], undefined);

  // Still an allowlist: launched from a hook or a rebase exec, these must not retarget git at another repository.
  check(
    "no GIT_* name that retargets a command is passed through",
    ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"].filter(
      (name) => env[name] !== undefined,
    ),
    [],
  );
  check("HOME survives, so ~/.gitconfig is read", env["HOME"], process.env["HOME"]);
  check("and nothing may wait for a passphrase", env["GIT_TERMINAL_PROMPT"], "0");
}

process.stdout.write("\npty output sanitising\n");
{
  const plain = sanitize("\x1b[2K\x1b[1Gopen https://claude.ai/oauth\n");
  check("escape sequences are stripped", plain.text, "open https://claude.ai/oauth\n");
  check("and nothing is held back when the chunk ends cleanly", plain.carry, "");

  const split = sanitize("code: \x1b[3");
  check("a partial escape is carried rather than printed", split.text, "code: ");
  check("as the carry", split.carry, "\x1b[3");
  check("and completes on the next chunk", sanitize(`${split.carry}1mABCD`).text, "ABCD");

  check("a lone carriage return becomes a newline", sanitize("a\rb").text, "a\nb");
  check("and CRLF stays one newline", sanitize("a\r\nb").text, "a\nb");
}

process.stdout.write("\nwhere a login client's cursor lands\n");
{
  // Drives the daemon's own readFrom: webcheck's copy of the arithmetic would stay green with this function deleted.
  check("a fresh read returns the whole buffer", readFrom("open https://x", 0, 0).chunk, "open https://x");
  check("and reports no gap", readFrom("open https://x", 0, 0).gap, false);
  check("a read from the end returns nothing new", readFrom("open https://x", 0, 14).chunk, "");
  // Once the 64 KiB cap has trimmed the front, an old cursor is behind the window.
  check("a cursor behind the discarded prefix is a gap", readFrom("tail", 100, 40).gap, true);
  check("and is served the oldest output that survives", readFrom("tail", 100, 40).chunk, "tail");
  // since === dropped is where the gap flag flips; the (100,100) and (100,99) pairs pin the boundary itself.
  check("a cursor on the oldest surviving byte is not a gap", readFrom("tail", 100, 100).gap, false);
  check("and is served the whole of what survives", readFrom("tail", 100, 100).chunk, "tail");
  check("while one byte behind it is a gap", readFrom("tail", 100, 99).gap, true);
  check("and that cursor reads the same surviving bytes", readFrom("tail", 100, 99).chunk, "tail");
  check("a cursor inside the window is not a gap", readFrom("tail", 100, 102).gap, false);
  check("and reads only what follows it", readFrom("tail", 100, 102).chunk, "il");
}

// A declined fs capability must be refused, not merely unadvertised: the handlers run in the daemon's own process.
process.stdout.write("\nthe fs capability, enforced rather than announced\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const { AcpClient } = await import("../src/acp/client.js");
  const { PassThrough } = await import("node:stream");

  const fakeAgent = () => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    return {
      process: {
        stdin: toAgent,
        stdout: toClient,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent.end(),
        kill: async () => {},
      },
      toAgent,
      toClient,
    };
  };

  const capabilityFor = async (options: {
    fileIo: boolean;
    elicitation: boolean;
  }): Promise<{
    advertised: unknown;
    refused: boolean;
    elicitationRefused: boolean;
    caps: Record<string, unknown>;
    codeFor: (id: number) => number | undefined;
  }> => {
    const agent = fakeAgent();
    let advertised: unknown = null;
    let caps: Record<string, unknown> = {};
    let refused = false;
    let elicitationRefused = false;

    let buffer = "";
    const replies: string[] = [];
    agent.toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        if (message["method"] === acp.methods.agent.initialize) {
          advertised = message["params"]?.clientCapabilities?.fs;
          caps = (message["params"]?.clientCapabilities ?? {}) as Record<string, unknown>;
          agent.toClient.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message["id"],
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            })}\n`,
          );
          continue;
        }
        if (typeof message["id"] === "number" && message["id"] >= 9001) replies.push(line);
      }
    });

    const client = await AcpClient.launch(
      { id: "kimi", displayName: "fake", command: "fake", args: [], env: {}, authHint: "" },
      agent.process as never,
      // No auth method: a real id sends an authenticate the fake agent never answers, stalling on AUTHENTICATE_TIMEOUT_MS.
      { ...options, authMethod: null },
    );

    // Both sent regardless of what was advertised — which is the entire point.
    agent.toClient.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 9001,
        method: acp.methods.client.fs.writeTextFile,
        params: { sessionId: "s_nope", path: "/etc/reemoat-probe", content: "x" },
      })}\n`,
    );
    // 9002 is the answerable shape; 9003-9005 are the three this client refuses
    // even when the capability is granted.
    const probes: Record<number, Record<string, unknown>> = {
      9002: {
        mode: "form",
        sessionId: "s_nope",
        message: "who are you",
        requestedSchema: { type: "object", properties: {} },
      },
      9003: { mode: "url", sessionId: "s_nope", message: "sign in", elicitationId: "e1", url: "https://x/" },
      9004: { mode: "_vendorThing", sessionId: "s_nope", message: "?" },
      9005: {
        mode: "form",
        requestId: "r1",
        message: "before any session",
        requestedSchema: { type: "object", properties: {} },
      },
    };
    for (const [id, params] of Object.entries(probes)) {
      agent.toClient.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: Number(id),
          method: acp.methods.client.elicitation.create,
          params,
        })}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const answerTo = (id: number): Record<string, any> | null => {
      for (const line of replies) {
        const parsed = JSON.parse(line) as Record<string, any>;
        if (parsed["id"] === id) return parsed;
      }
      return null;
    };
    // -32601 is "method not found": indistinguishable from a client that never implemented it, by intent.
    refused = answerTo(9001)?.["error"]?.code === -32601;
    elicitationRefused = answerTo(9002)?.["error"]?.code === -32601;
    const codeFor = (id: number): number | undefined => answerTo(id)?.["error"]?.code;
    await client.close().catch(() => {});
    return { advertised, refused, elicitationRefused, caps, codeFor };
  };

  const declined = await capabilityFor({ fileIo: false, elicitation: false });
  check("a declining runtime advertises no fs capability", declined.advertised, {
    readTextFile: false,
    writeTextFile: false,
  });
  check("and refuses an fs write the agent sends anyway", declined.refused, true);

  const allowed = await capabilityFor({ fileIo: true, elicitation: true });
  check("a local runtime still advertises it", allowed.advertised, {
    readTextFile: true,
    writeTextFile: true,
  });
  // Routed to session.ts, so refused as invalid_params (no session) and never as method_not_found.
  check("and does not refuse it as unimplemented", allowed.refused, false);

  // Declining is an absence: ACP has no form false, and without elicitation.form claude's adapter strips AskUserQuestion.
  check("a declining daemon advertises no elicitation capability at all", declined.caps["elicitation"], undefined);
  check("and refuses a question the agent asks anyway", declined.elicitationRefused, true);
  check("granting it advertises form mode", allowed.caps["elicitation"], { form: {} });
  check(
    "and never url mode, which would be a second settle path no human drives",
    "url" in ((allowed.caps["elicitation"] ?? {}) as Record<string, unknown>),
    false,
  );
  check("and the question is not refused as unimplemented", allowed.elicitationRefused, false);

  // -32602, not -32601: the method exists. An error rather than a decline, because nobody declined.
  check("url mode is refused even when the capability is granted", allowed.codeFor(9003), -32602);
  check("so is a mode this client has never heard of", allowed.codeFor(9004), -32602);
  check("and so is a question scoped to a request rather than a session", allowed.codeFor(9005), -32602);

  // Without subagent-transcript the adapter runs with forwardSubagentText off: a log budget choice, so the _meta bag is asserted whole.
  check("exactly one capability extension is advertised, and it is named", allowed.caps["_meta"], {
    jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } },
  });
  check(
    "so a subagent's transcript is never forwarded",
    (allowed.caps["_meta"] as Record<string, unknown> | undefined)?.["subagent-transcript"],
    undefined,
  );

  // The adapter silently ignores an AIR declaration it refuses; nativeSubagentSessions stays out, or a subagent's permission is addressed to a child session id the client refuses.
  const air = (
    (allowed.caps["_meta"] as Record<string, unknown> | undefined)?.["jetbrains"] as
      | Record<string, unknown>
      | undefined
  )?.["air"] as { version?: unknown; capabilities?: unknown } | undefined;
  check("the extension version is an integer the adapter's gate accepts", air?.version, 1);
  check(
    "and background work is the only thing asked for",
    air?.capabilities,
    ["asyncTasks"],
  );
}

process.stdout.write("\nwhat a form is allowed to be\n");
{
  const { toElicitationForm, ElicitationRefusedError } = await import("../src/session.js");

  const refusalFrom = (schema: unknown): string | null => {
    try {
      toElicitationForm(schema as never);
      return null;
    } catch (error) {
      return error instanceof ElicitationRefusedError ? error.message : `unexpected: ${String(error)}`;
    }
  };

  // claude's AskUserQuestion shape: a titled single-select plus the adapter's own free-text "Other" box.
  const ask = toElicitationForm({
    type: "object",
    properties: {
      question_0: {
        type: "string",
        title: "Framework",
        oneOf: [
          { const: "React", title: "React", description: "Already in package.json" },
          { const: "Svelte", title: "Svelte" },
        ],
      },
      question_0_custom: {
        type: "string",
        title: "Other",
        description: "Type your own answer instead of choosing an option above (optional).",
        _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } },
      },
    },
  } as never);
  check(
    "a claude AskUserQuestion projects to a select and a free-text box",
    ask.fields.map((field) => [field.key, field.kind, field.title, field.required]),
    [
      ["question_0", "string", "Framework", false],
      ["question_0_custom", "string", "Other", false],
    ],
  );
  check(
    "an option keeps its own description, which is what makes rows worth drawing",
    ask.fields[0]?.options,
    [
      { value: "React", label: "React", description: "Already in package.json" },
      { value: "Svelte", label: "Svelte", description: null },
    ],
  );

  // codex-acp's shape for the same question: different key names and _meta, same projection, since nothing here reads a field name.
  const codexAsk = toElicitationForm({
    type: "object",
    required: [],
    properties: {
      license_choice: {
        type: "string",
        title: "License",
        description: "Which license should I add to this repository?",
        _meta: { codex: { isOther: true, isSecret: false } },
        oneOf: [
          { const: "MIT (Recommended)", title: "MIT (Recommended)", description: "A short, permissive license." },
          { const: "GPL-3.0", title: "GPL-3.0" },
        ],
      },
      license_choice__other: {
        type: "string",
        title: "Other",
        description: "Type your own answer instead of choosing an option above.",
        _meta: { codex: { questionId: "license_choice", isOtherAnswer: true, isSecret: false } },
      },
    },
  } as never);
  check(
    "a codex question projects to the same select and free-text box",
    codexAsk.fields.map((field) => [field.key, field.kind, field.title, field.required]),
    [
      ["license_choice", "string", "License", false],
      ["license_choice__other", "string", "Other", false],
    ],
  );
  check(
    "its options survive with their prose, and the rest of the agent's _meta does not",
    codexAsk.fields[0]?.options,
    [
      { value: "MIT (Recommended)", label: "MIT (Recommended)", description: "A short, permissive license." },
      { value: "GPL-3.0", label: "GPL-3.0", description: null },
    ],
  );

  // Both agents keep the free-text answer over the selection (claude's applyAskElicitationResponse, codex's convertUserInputResponse).
  check(
    "both agents' free-text boxes say which question they answer",
    [
      ask.fields.map((field) => field.alternativeTo),
      codexAsk.fields.map((field) => field.alternativeTo),
    ],
    [
      [null, "question_0"],
      [null, "license_choice"],
    ],
  );
  const dangling = toElicitationForm({
    type: "object",
    properties: {
      loose: {
        type: "string",
        title: "Other",
        _meta: { _askUserQuestionCustomAnswer: { questionId: "no_such_field", isCustomAnswer: true } },
      },
      itself: {
        type: "string",
        title: "Other",
        _meta: { codex: { questionId: "itself", isOtherAnswer: true } },
      },
    },
  } as never);
  check("a pointer to nothing is dropped, and so is one to itself", dangling.fields.map((f) => f.alternativeTo), [null, null]);
  const looseMarkers = toElicitationForm({
    type: "object",
    properties: {
      q: { type: "string", title: "Q" },
      a: { type: "string", title: "A", _meta: { codex: { questionId: "q", isOtherAnswer: "yes" } } },
      b: { type: "string", title: "B", _meta: { _askUserQuestionCustomAnswer: { questionId: 7, isCustomAnswer: true } } },
      c: { type: "string", title: "C", _meta: { _askUserQuestionCustomAnswer: { questionId: "  ", isCustomAnswer: true } } },
    },
  } as never);
  check("a marker that is not exactly true, or names nothing, says nothing", looseMarkers.fields.map((f) => f.alternativeTo), [null, null, null, null]);

  const bare = toElicitationForm({
    type: "object",
    required: ["pick"],
    properties: { pick: { type: "string", enum: ["a", "b"] } },
  } as never);
  check("a bare enum normalizes to the same option shape", bare.fields[0]?.options, [
    { value: "a", label: "a", description: null },
    { value: "b", label: "b", description: null },
  ]);
  check("and `required` is carried per field", bare.fields[0]?.required, true);

  const multi = toElicitationForm({
    type: "object",
    properties: {
      regions: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "eu", title: "Europe" }] } },
    },
  } as never);
  check("a titled multi-select is a multi_select with bounds", [
    multi.fields[0]?.kind,
    multi.fields[0]?.min,
    multi.fields[0]?.max,
    multi.fields[0]?.options,
  ], ["multi_select", 1, 2, [{ value: "eu", label: "Europe", description: null }]]);

  const coerced = toElicitationForm({
    type: "object",
    properties: { n: { type: "string", oneOf: [{ const: 42, title: "forty-two" }, { const: "ok", title: "ok" }] } },
  } as never);
  check("an option whose value is not a string is dropped, never stringified", coerced.fields[0]?.options, [
    { value: "ok", label: "ok", description: null },
  ]);

  check("prose arrives whole rather than clipped", (() => {
    const long = toElicitationForm({
      type: "object",
      properties: {
        a: {
          type: "string",
          title: "T".repeat(400),
          description: "x".repeat(5_000),
          oneOf: [{ const: "v", title: "L".repeat(400), description: "d".repeat(1_000) }],
        },
      },
    } as never);
    const field = long.fields[0];
    return (
      field?.description === "x".repeat(5_000) &&
      field?.title === "T".repeat(400) &&
      field?.options?.[0]?.label === "L".repeat(400) &&
      field?.options?.[0]?.description === "d".repeat(1_000)
    );
  })(), true);
  // An empty string projects to null: the web client's askTitle falls through to its next source only on null.
  check("but an empty string is still an absence", (() => {
    const blank = toElicitationForm({
      type: "object",
      properties: { a: { type: "string", title: "", description: "" } },
    } as never);
    return [blank.fields[0]?.title, blank.fields[0]?.description];
  })(), [null, null]);

  check("an empty form is a form, not an error", toElicitationForm({ type: "object", properties: {} } as never), {
    fields: [],
  });
  check("and so is a schema with nothing in it at all", toElicitationForm(null).fields.length, 0);

  // Every refusal names its cap: handleAskUserQuestion turns the error into a deny the model reads.
  const wideField: Record<string, unknown> = {};
  for (let i = 0; i < 40; i += 1) wideField[`f${i}`] = { type: "string" };
  check(
    "too many fields refuses the whole form",
    refusalFrom({ type: "object", properties: wideField })?.includes("24"),
    true,
  );
  check(
    "too many choices refuses it too",
    refusalFrom({
      type: "object",
      properties: { a: { type: "string", enum: Array.from({ length: 40 }, (_, i) => `o${i}`) } },
    })?.includes("24"),
    true,
  );
  check(
    "an option value too long to round-trip refuses it rather than being clipped",
    refusalFrom({
      type: "object",
      properties: { a: { type: "string", enum: ["x".repeat(600)] } },
    })?.includes("512"),
    true,
  );
  check(
    "a property type this client cannot draw refuses it, rather than leaving a hole",
    refusalFrom({ type: "object", properties: { c: { type: "color" } } })?.includes("color"),
    true,
  );
  check(
    "a vendor-reserved type earns no special case",
    refusalFrom({ type: "object", properties: { c: { type: "_claudeThing" } } })?.includes("_claudeThing"),
    true,
  );
  check(
    "a list with no choices is refused rather than drawn as an empty picker",
    refusalFrom({ type: "object", properties: { a: { type: "array", items: { type: "string" } } } })?.includes(
      "no choices",
    ),
    true,
  );

  // Empty options must project to null: the client draws free text on an empty list while validateElicitationContent refuses every value.
  check(
    "an empty enum on a string is free text, not a choice of nothing",
    toElicitationForm({ type: "object", properties: { a: { type: "string", enum: [] } } } as never).fields[0]?.options,
    null,
  );
  check(
    "and so is a oneOf whose every const was dropped",
    toElicitationForm({
      type: "object",
      properties: { a: { type: "string", oneOf: [{ const: 42 }, { const: true }] } },
    } as never).fields[0]?.options,
    null,
  );
  {
    const kinds = {
      fields: [
        { key: "n", kind: "integer", title: null, description: null, required: false, options: null, min: 10, max: 20, format: null, default: null },
        { key: "b", kind: "boolean", title: null, description: null, required: false, options: null, min: null, max: null, format: null, default: null },
        { key: "m", kind: "multi_select", title: null, description: null, required: false,
          options: [
            { value: "us", label: "us", description: null },
            { value: "eu", label: "eu", description: null },
          ], min: 2, max: 2, format: null, default: null },
      ],
    } as never;
    const codes = (content: Record<string, unknown>): string[] =>
      validateElicitationContent(kinds, content).map((problem) => problem.code);

    check("an unknown field is refused rather than stripped", codes({ nope: 1 }), ["unknown_field"]);
    check("a string for an integer is not coerced", codes({ n: "15" }), ["wrong_type"]);
    check("nor is a fraction accepted as one", codes({ n: 1.5 }), ["wrong_type"]);
    check("below the minimum", codes({ n: 1 }), ["too_small"]);
    check("above the maximum", codes({ n: 99 }), ["too_large"]);
    check("a string for a boolean is not coerced either", codes({ b: "true" }), ["wrong_type"]);
    check("false is a value, not an absence", codes({ b: false }), []);
    check("too few choices", codes({ m: ["us"] }), ["too_few"]);
    check("a choice the form never offered", codes({ m: ["us", "nz"] }), ["not_an_option"]);
    // Inverse of the client's elicitationAnswer, which dedupes; webcheck pins that half.
    check("a repeated choice is refused here, where the client collapses it", codes({ m: ["us", "us"] }), ["duplicate"]);
    check("and a well-formed answer to every kind is accepted", codes({ n: 15, b: true, m: ["us", "eu"] }), []);
  }

  check(
    "a surviving choice is still a choice",
    toElicitationForm({
      type: "object",
      properties: { a: { type: "string", oneOf: [{ const: 42 }, { const: "ok" }] } },
    } as never).fields[0]?.options?.map((option) => option.value),
    ["ok"],
  );
  const heavy: Record<string, unknown> = {};
  for (let i = 0; i < 20; i += 1) {
    heavy[`f${i}`] = {
      type: "string",
      description: "y".repeat(300),
      enum: Array.from({ length: 20 }, (_, j) => `${"z".repeat(190)}${j}`),
    };
  }
  check(
    "and a form that is only large in total is refused by the byte backstop",
    refusalFrom({ type: "object", properties: heavy })?.includes("bytes"),
    true,
  );
  // With MAX_ELICITATION_DESCRIPTION_CHARS gone, the byte backstop is the only bound on one long string.
  check(
    "and one enormous string meets the same backstop the thousand small ones do",
    refusalFrom({
      type: "object",
      properties: { a: { type: "string", description: "q".repeat(40_000) } },
    })?.includes("bytes"),
    true,
  );
}

// message rides beside the form, so the form's byte backstop never weighs it: bounded by its own clip, asserted here and at the call site.
process.stdout.write("\nwhat an agent's question is allowed to say\n");
{
  const { clipElicitationMessage } = await import("../src/session.js");
  const { readFileSync } = await import("node:fs");

  const preamble = "Please answer the following questions.";
  check("the preamble a real adapter sends arrives identically", clipElicitationMessage(preamble), preamble);
  const longest = "p".repeat(318);
  check("and so does the longest prose this machine's log has ever carried", clipElicitationMessage(longest), longest);
  check("a question right at the cap is untouched", clipElicitationMessage("q".repeat(4_096)).length, 4_096);

  // clip counts UTF-16 units while the frame ceiling is UTF-8 bytes, so weigh the all-astral worst case.
  const cut = clipElicitationMessage("z".repeat(1_000_000));
  check("one over it is cut rather than carried", cut.length <= 4_096, true);
  check("and says so where somebody reading it can see", cut.endsWith("]"), true);
  check("the marker names the truncation", cut.includes("truncated"), true);
  const astral = clipElicitationMessage("\u{1F600}".repeat(500_000));
  check(
    "even all-astral prose stays far under the frame ceiling",
    Buffer.byteLength(astral, "utf8") < 32 * 1024,
    true,
  );
  // Typed as a string, but agent-supplied JSON at runtime.
  check("an agent that sends no message at all leaves no hole", clipElicitationMessage(undefined as never), "");

  // Comment-stripped, so a docblock quoting the call cannot keep this green over a deleted call site.
  const sessionSrc = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  check(
    "the ingest call site is really there, with the comments taken out",
    sessionSrc.includes("message: clipElicitationMessage(request.message)"),
    true,
  );
  check(
    "and nothing hands the raw field on as a message beside it",
    /message:\s*request\.message\b/.test(sessionSrc),
    false,
  );
}
