import { readFrom, sanitize } from "../src/agentauth.js";
import { gitArgs, gitEnv } from "../src/git.js";
import { validateElicitationContent } from "../src/registry.js";
import { check } from "./daemoncheck.env.js";

/* ------------------------------------------------------------------ *
 * git no longer fences, and that has to fail loudly if it comes back
 * ------------------------------------------------------------------ */

/*
 * The direct successor to `dockercheck`'s "the container runner deliberately
 * does not neutralise hooks", pointed the other way because the reason inverted.
 *
 * `GIT_NO_EXEC_CONFIG` and `GIT_CONFIG_GLOBAL=/dev/null` were confinement against
 * a repository on the other side of a trust boundary. There is no such boundary
 * now, and leaving them in place had a measured, silent cost: a blanked global
 * config disables `filter.lfs.smudge`, so `worktree add` checks out LFS pointer
 * files and the agent reads a spec URL where a binary should be.
 *
 * So this asserts an **absence**, exactly as the old rule did: somebody restoring
 * "just the hooks one, for safety" breaks a user's own repository with no error
 * anywhere, and should fail here instead.
 */
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
  // The two that mattered, by name. Restoring either one silently changes what a
  // checkout produces: hooks stop running, and LFS content becomes pointer files.
  check("the user's global config is not blanked", env["GIT_CONFIG_GLOBAL"], undefined);
  check("nor is the system config suppressed", env["GIT_CONFIG_NOSYSTEM"], undefined);

  // Still an allowlist, and still for a reason — being launched from inside a
  // hook or a `rebase --exec` must not retarget us at somebody else's repository.
  check(
    "no GIT_* name that retargets a command is passed through",
    ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"].filter(
      (name) => env[name] !== undefined,
    ),
    [],
  );
  // What the user's own git legitimately needs, and what nothing may block on.
  check("HOME survives, so ~/.gitconfig is read", env["HOME"], process.env["HOME"]);
  check("and nothing may wait for a passphrase", env["GIT_TERMINAL_PROMPT"], "0");
}

/* ================================================================== *
 * Moved here from `scripts/dockercheck.ts` when the container runtime
 * was deleted. None of it was ever about Docker: it drives `sanitize`,
 * `readFrom`, a real `AcpClient` and a real `Session` over in-memory
 * pipes. Deleting that file without moving these would have removed the
 * only place any of them is asserted against itself rather than against
 * a copy of its own arithmetic.
 * ================================================================== */

process.stdout.write("\npty output sanitising\n");
{
  // What `script` hands back is a terminal recording, and a `<pre>` is not a
  // terminal. Stripping is the readable failure; the alternative is a pane full
  // of `\x1b[2K`.
  const plain = sanitize("\x1b[2K\x1b[1Gopen https://claude.ai/oauth\n");
  check("escape sequences are stripped", plain.text, "open https://claude.ai/oauth\n");
  check("and nothing is held back when the chunk ends cleanly", plain.carry, "");

  // A sequence split across a chunk boundary printed as literal text exactly
  // once per boundary, which is both ugly and unreproducible.
  const split = sanitize("code: \x1b[3");
  check("a partial escape is carried rather than printed", split.text, "code: ");
  check("as the carry", split.carry, "\x1b[3");
  check("and completes on the next chunk", sanitize(`${split.carry}1mABCD`).text, "ABCD");

  // `\r` means redraw. Honouring it properly needs a terminal emulator; dropping
  // it concatenates every spinner frame into one line.
  check("a lone carriage return becomes a newline", sanitize("a\rb").text, "a\nb");
  check("and CRLF stays one newline", sanitize("a\r\nb").text, "a\nb");
}

process.stdout.write("\nwhere a login client's cursor lands\n");
{
  /*
   * `readFrom` itself, not a model of it.
   *
   * `webcheck` has a section on this that defines its own copy of the arithmetic
   * and asserts against that — useful for the *client's* rule (assign the cursor,
   * never advance by `chunk.length`) and worthless as a guard on the daemon,
   * because it would stay green with this function deleted. `packages/web` cannot
   * import from `src/` — the two halves resolve modules differently, which is the
   * same reason `wire.ts` is hand-mirrored — so the daemon half is asserted here.
   *
   * A login transcript is where a lost line is the one with the code in it, which
   * is why the gap flag matters as much as the slice.
   */
  check("a fresh read returns the whole buffer", readFrom("open https://x", 0, 0).chunk, "open https://x");
  check("and reports no gap", readFrom("open https://x", 0, 0).gap, false);
  check("a read from the end returns nothing new", readFrom("open https://x", 0, 14).chunk, "");
  // Once the 64 KiB cap has trimmed the front, an old cursor is behind the window.
  check("a cursor behind the discarded prefix is a gap", readFrom("tail", 100, 40).gap, true);
  check("and is served the oldest output that survives", readFrom("tail", 100, 40).chunk, "tail");
  check("a cursor inside the window is not a gap", readFrom("tail", 100, 102).gap, false);
  check("and reads only what follows it", readFrom("tail", 100, 102).chunk, "il");
}

/* ------------------------------------------------------------------ *
 * The fs capability, enforced rather than announced
 * ------------------------------------------------------------------ */

/**
 * The one property that makes the sandbox a sandbox.
 *
 * `session.ts` implements ACP's `fs/read_text_file` and `fs/write_text_file` by
 * calling `readFile`/`writeFile` **in the daemon's own process**, so a container
 * around the agent does not contain them. `SessionRuntime.clientFileIo` is how a
 * sandboxing runtime declines them — but declining is a *statement to a party we
 * do not trust*, and until it was enforced the handlers were registered
 * unconditionally and ran the request anyway. An agent that ignored the
 * advertised capability, or anything else in the tenant's container able to
 * write to the agent's stdout, had a write primitive running outside the sandbox.
 *
 * So this drives a real `AcpClient` over in-memory pipes with a fake agent on
 * the other end, completes the handshake, and then sends the request the agent
 * was told not to send. No Docker, no image, no network.
 */
process.stdout.write("\nthe fs capability, enforced rather than announced\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const { AcpClient } = await import("../src/acp/client.js");
  const { PassThrough } = await import("node:stream");

  /** An `AgentProcess` that is two pipes and nothing else. */
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

    // The agent side: answer `initialize`, then send the forbidden request.
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
        // The client's answers to every probe we send below.
        if (typeof message["id"] === "number" && message["id"] >= 9001) replies.push(line);
      }
    });

    const client = await AcpClient.launch(
      { id: "kimi", displayName: "fake", command: "fake", args: [], env: {}, authHint: "" },
      agent.process as never,
      options,
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
    // -32601 is JSON-RPC's "method not found": indistinguishable from a client
    // that never implemented it, which is exactly the intent.
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
  // Routed, so it reaches `session.ts` — this one has no session registered, so
  // the refusal is `invalid_params` rather than `method_not_found`. What matters
  // is that it is NOT the same refusal as above.
  check("and does not refuse it as unimplemented", allowed.refused, false);

  /*
   * The elicitation capability, enforced the same way and for a sharper reason.
   *
   * Declaring `elicitation.form` is the one thing in this handshake that changes
   * what the *model* does rather than what the client renders: measured against
   * claude-agent-acp 0.63.0, `disallowedTools = elicitationSupport.form ? [] :
   * ["AskUserQuestion"]`, so leaving it out strips claude's own ask-the-user tool
   * before the CLI starts. That makes the gate worth having twice over — an
   * operator can withdraw a tool, and an agent that ignores the answer gets the
   * same `-32601` a client that never implemented it would send.
   *
   * The declined case is asserted as an **absence**, like the `_meta` pair below,
   * because ACP has no `form: false`: `ElicitationCapabilities.form` is an
   * empty-object marker, so omitting the key is the only way to say no and
   * `{form: false}` would typecheck against the open `_meta` while meaning
   * nothing.
   */
  check("a declining daemon advertises no elicitation capability at all", declined.caps["elicitation"], undefined);
  check("and refuses a question the agent asks anyway", declined.elicitationRefused, true);
  check("granting it advertises form mode", allowed.caps["elicitation"], { form: {} });
  check(
    "and never url mode, which would be a second settle path no human drives",
    "url" in ((allowed.caps["elicitation"] ?? {}) as Record<string, unknown>),
    false,
  );
  check("and the question is not refused as unimplemented", allowed.elicitationRefused, false);

  /*
   * The three shapes that are refused even though the capability was granted.
   *
   * `-32602` is `invalid_params` and deliberately not `-32601`: the method *is*
   * implemented, and answering "method not found" would tell the agent the whole
   * capability is absent — a statement the next form request immediately
   * contradicts.
   *
   * They are also errors rather than `{action: "decline"}`, which would be a lie:
   * nobody declined. Measured against claude's adapter, the error is the kindest
   * of the three anyway — it becomes `{behavior: "deny", message: "Could not
   * present the question to the user."}` and the model carries on knowing why,
   * where a decline tells it a person chose to skip.
   */
  check("url mode is refused even when the capability is granted", allowed.codeFor(9003), -32602);
  check("so is a mode this client has never heard of", allowed.codeFor(9004), -32602);
  check("and so is a question scoped to a request rather than a session", allowed.codeFor(9005), -32602);

  /*
   * The subagent transcript, refused by not asking for it.
   *
   * `claude-agent-acp` gates a subagent's own text and thinking on
   * `clientCapabilities._meta["subagent-transcript"] === true`; without it the
   * SDK is passed `forwardSubagentText: false` and never emits them at all. So
   * this daemon sees what a subagent *did* and what it *concluded*, and not what
   * it said.
   *
   * That is a budget decision, not a trust one — saying so plainly, because
   * reaching for the `fs` argument here would be dishonest: this grants the
   * agent permission to talk more, not a write primitive in our process. The log
   * is 5000 events / 8 MiB and eviction removes a *prefix*, so a second full
   * conversation per delegate, three to five at a time, does not degrade into
   * "less detail" — it evicts the operator's own prompt and the main agent's
   * reply to make room for a delegate's monologue.
   *
   * Asserted as an *absence*, so switching it on has to be deliberate and fails
   * loudly here rather than quietly doubling what a delegate costs.
   */
  check("no capability metadata is advertised at all", allowed.caps["_meta"], undefined);
  check(
    "so a subagent's transcript is never forwarded",
    (allowed.caps["_meta"] as Record<string, unknown> | undefined)?.["subagent-transcript"],
    undefined,
  );
}

/* ------------------------------------------------------------------ *
 * What a form is allowed to be
 * ------------------------------------------------------------------ */

/**
 * The projection, driven as a pure function.
 *
 * `toElicitationForm` is where an agent-chosen JSON Schema becomes the fixed
 * shape this system carries, and it is the only place the two rules that make
 * that safe are written: **structure is refused and prose is clipped**. Both
 * halves need driving, because each is silently wrong in a different direction —
 * a cap that clipped structure would deliver a form whose answer means something
 * else, and one that refused prose would refuse real forms over a long sentence.
 */
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

  // The measured AskUserQuestion shape, N=1: a titled single-select followed by
  // the adapter's own free-text "Other" box.
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

  /*
   * The same question from the other agent that asks one, N=1, measured
   * 2026-08-07 against codex-acp 1.1.9.
   *
   * It arrives on `elicitation/create` like claude's — the adapters agree on the
   * method and disagree on everything nameable. The keys are the model's
   * (`license_choice`, not `question_0`), the free-text box is suffixed `__other`
   * rather than `_custom`, and each property carries a `_meta.codex` block naming
   * the question it belongs to.
   *
   * **Which is exactly why nothing here reads a field name.** Both projections
   * come out identical in shape — a titled single-select and a free-text box —
   * and a client that had keyed on `_custom`, or on `_meta`, would render one
   * agent's question and refuse the other's. `_meta` is dropped on the floor and
   * the suffix is never parsed; the second field is a field like any other, and
   * codex's own `isOtherAnswer` marker is left where it was sent.
   */
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
    "its options survive with their prose, and the agent's _meta does not",
    codexAsk.fields[0]?.options,
    [
      { value: "MIT (Recommended)", label: "MIT (Recommended)", description: "A short, permissive license." },
      { value: "GPL-3.0", label: "GPL-3.0", description: null },
    ],
  );

  // `enum` and `oneOf` are one shape by the time anything reads them, so a client
  // has one answer to "what is an option" and the daemon validates the reply
  // against the same list it sent.
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

  // Never coerced: a non-string wire value is one the agent will not recognise
  // coming back, so it is not an option at all rather than `String(42)`.
  const coerced = toElicitationForm({
    type: "object",
    properties: { n: { type: "string", oneOf: [{ const: 42, title: "forty-two" }, { const: "ok", title: "ok" }] } },
  } as never);
  check("an option whose value is not a string is dropped, never stringified", coerced.fields[0]?.options, [
    { value: "ok", label: "ok", description: null },
  ]);

  /*
   * ⚠ **This asserted the opposite until 0.3.0: "prose is clipped rather than
   * refused", at 512 / 100 / 300 characters for `message`, a title and a
   * description.**
   *
   * What made those wrong is *where the question lives*. With several questions on
   * one form the adapter puts each question in its field's `description` and leaves
   * `message` as a preamble — so 300 was a cap on the sentence somebody is being
   * asked to answer, and an option's `description` is the sentence explaining what
   * one answer means. Measured against this machine's own log, one real option
   * description was **318** characters and was being cut on screen. A question read
   * half is a question answered wrongly, which is precisely the harm "structure is
   * refused" exists to prevent, one field along.
   *
   * So the split runs between *structure* and *prose* rather than between refusing
   * and clipping, and the byte backstop below is what bounds prose now — one
   * whole-object number instead of three per-string ones.
   */
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
  // An empty string and `null` are one absence to every reader, and `askTitle` in
  // the web client falls through to its next source on `null` — so the half of
  // `clipOrNull` that survived its budget is the half that had to.
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

  /*
   * Every refusal names its cap in the message, because the agent is the only
   * party that can act on it — `handleAskUserQuestion` turns the error into a
   * `deny` the model reads.
   */
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
  // Refused rather than clipped, for the reason a command's name is: this string
  // goes back to the agent and has to round-trip exactly.
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

  /*
   * **The string arm's twin, and the two must not disagree about what `[]` is.**
   *
   * A `string` field whose choices all get dropped — `enum: []`, or a `oneOf`
   * whose every `const` is non-string — used to project `options: []`. The array
   * arm refuses that shape; the string arm let it through, and then the two ends
   * read it oppositely: the client draws a free-text box because `[].length > 0`
   * is false, and `validateElicitationContent` refuses every value because
   * `[] !== null` is true. Submit lit up and the route answered `400
   * not_an_option` for anything the person could type.
   */
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
  /*
   * **The daemon's only check on what reaches an agent, driven directly.**
   *
   * Its docblock says it is module-scope and pure "so `daemoncheck` can drive
   * every rule with no session", and no driver imported it — so it was reached
   * only through the HTTP fixture, whose form is two `string` fields. Every
   * number, boolean and multi-select arm was unreachable by any assertion.
   *
   * The `duplicate` rule is the sharpest of them, because it is deliberately the
   * *inverse* of the client's: `elicitationAnswer` dedupes and `webcheck` pins
   * that it does, while the daemon refuses. Somebody unifying the two would have
   * changed only the half nothing watched.
   */
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
    // The inverse of the client's rule, and the reason this block exists.
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
  // The backstop the per-item caps cannot be: they bound one string, this bounds
  // a thousand of them.
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
  /*
   * ⚠ **The case the per-string caps used to catch, and the backstop is now the
   * only thing that catches it.** With `MAX_ELICITATION_DESCRIPTION_CHARS` gone,
   * one field can carry an arbitrarily long sentence — which is the point — so the
   * assertion that matters is that *one* enormous string still meets the same 32
   * KiB number a thousand small ones do. Without this, "prose arrives whole" above
   * would be the only statement about prose in the file and the form would be
   * unbounded in the direction nobody drives.
   */
  check(
    "and one enormous string meets the same backstop the thousand small ones do",
    refusalFrom({
      type: "object",
      properties: { a: { type: "string", description: "q".repeat(40_000) } },
    })?.includes("bytes"),
    true,
  );
}
