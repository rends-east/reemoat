import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";

process.stdout.write("\nthe one model list this app reads for itself\n");
{
  const {
    readOpenRouterModels,
    openRouterNotice,
    fetchOpenRouterModels,
    forgetOpenRouterModels,
    BATCH_VARIANT,
    OPENROUTER_MODELS_URL,
    OPENROUTER_SYSTEM_ID,
    OPENROUTER_TTL_MS,
  } = await import("../src/openrouter.js");

  const model = (over: Record<string, unknown> = {}) => ({
    id: "qwen/qwen3-coder",
    name: "Qwen: Qwen3 Coder",
    supported_parameters: ["tools", "temperature"],
    ...over,
  });

  /*
   * ⚠ **Two filters, and they are one rule stated twice.** Each drops a row whose
   * only possible outcome is a confusing failure at somebody else's endpoint, so
   * neither is a preference. Measured 2026-08-27, and the catalogue moves — it
   * grew by one model between two reads an hour apart, so nothing here pins a
   * count: of 417 models 348 can call tools, 59 of those carry `:batch`, 289 are
   * kept.
   */
  check(
    "only the models that can call tools are offered",
    readOpenRouterModels({
      data: [
        model(),
        model({ id: "a/chat-only", supported_parameters: ["temperature"] }),
        model({ id: "b/no-field" , supported_parameters: undefined }),
      ],
    }),
    /*
     * ⚠ **And the two it refused are *named*, which is the half that was missing.**
     * This filter was only ever applied to the list this browser fetches — and the
     * catalogue is not the only list. opencode publishes its own 362 unfiltered,
     * `allModels` merged them in as `published` rows, and a model refused here came
     * straight back through the other door: `nousresearch/hermes-3-llama-3.1-405b`
     * was offered, assembled and failed on its first turn with OpenRouter's own
     * accurate sentence. Q3.520.
     */
    { kind: "ok", models: [{ id: "qwen/qwen3-coder", name: "Qwen: Qwen3 Coder" }], toolless: ["a/chat-only", "b/no-field"] },
  );
  /*
   * ⚠ **`:batch` is not a routing variant, which is why it is dropped rather than
   * greyed.** OpenRouter documents seven of those — `:free`, `:extended`,
   * `:exacto`, `:thinking`, `:online`, `:nitro`, `:floor` — and publishes no page
   * for this one, because it belongs to a different API: `POST /api/beta/batches`,
   * whose only supported completion window is **24 hours** and whose submission
   * answers `202 Accepted` with `status: "validating"`. Both doors this app has
   * are synchronous, nothing here can poll a batch, and a turn ending in a day has
   * no representation in the event union at all. The row is priced at half, which
   * makes `anthropic/claude-opus-5:batch` the most attractive-looking line in the
   * picker and the one that cannot complete a turn.
   *
   * ⚠ **`endsWith` and not an allow-list of understood variants.** Measured over
   * the whole live list: an id carries at most one colon and never one before the
   * `/`, and `batch` and `free` are the only two suffixes in existence — so a
   * model genuinely *called* batch survives, having no colon at all. An allow-list
   * would drop `:free` unless enumerated and would go dark on the next
   * *synchronous* variant; this goes dark only on the next asynchronous one, which
   * is the rarer event and is accepted.
   *
   * Driven through the exported constant rather than a second copy of the string,
   * and the third row is the guard: it is what fails if this is ever loosened to a
   * substring test.
   */
  check(
    "and neither is the batch tier of one, which no door here can reach",
    readOpenRouterModels({
      data: [
        model(),
        model({ id: `qwen/qwen3-coder${BATCH_VARIANT}`, name: "Qwen: Qwen3 Coder (batch)" }),
        model({ id: "deepseek/batch", name: "DeepSeek: Batch" }),
      ],
    }),
    /*
     * ⚠ **`toolless` stays empty here, and that is the point of it being one
     * statement rather than "everything left out".** A `:batch` id is refused for a
     * reason that says nothing about tool support — it can call them perfectly, in
     * a day — so naming it would make `allModels` drop a published row over a
     * pricing tier that a stored preset is deliberately still allowed to use.
     */
    {
      kind: "ok",
      models: [
        { id: "qwen/qwen3-coder", name: "Qwen: Qwen3 Coder" },
        { id: "deepseek/batch", name: "DeepSeek: Batch" },
      ],
      toolless: [],
    },
  );
  /*
   * ⚠ **The daemon is taught neither filter, and that is deliberate.**
   * `MAX_MODEL_CHARS` stays its only model validation, so a `:batch` id already
   * stored in an assembled agent goes on being sent rather than being retroactively
   * broken — the tolerance the tools filter has always granted, asserted here so
   * that a later "tidy-up" into `src/` has to argue with something.
   */
  check(
    "the suffix is the browser's rule and no daemon source knows it",
    [BATCH_VARIANT, readFileSync(new URL("../../../src/acp/systems.ts", import.meta.url), "utf8").includes(BATCH_VARIANT)],
    [":batch", false],
  );
  /*
   * ⚠ **Fails *open*, which is the opposite of `catalogue.ts` and the difference
   * is what is being read.** A half-read entry there is a half-read *permission*
   * list — somebody granting a plugin access to their sessions — and that one may
   * not guess. This is a list of names: a bad entry costs one row nobody can see
   * is missing, and refusing the other 355 over it is the failure this app avoids
   * everywhere else.
   */
  check(
    "one unreadable entry costs one row and not the list",
    readOpenRouterModels({ data: [7, null, { id: 5, name: "x" }, model({ id: "keep/me" }), { name: "no id" }] }),
    // Nor is an unreadable row named: "the catalogue refused this for having no
    // tools" is a claim, and a row that could not be read supports no claim at all.
    { kind: "ok", models: [{ id: "keep/me", name: "Qwen: Qwen3 Coder" }], toolless: [] },
  );
  /*
   * ⚠ **Unknown fields are ignored and always will be.** The live object carries
   * eighteen keys — `pricing`, `architecture`, `top_provider` and more — none of
   * which this app has a screen for, and a reader that refused a key it had not
   * heard of would go dark on the next thing OpenRouter adds.
   */
  check(
    "and a field this app has never heard of is not a reason to refuse a row",
    readOpenRouterModels({ data: [model({ pricing: { prompt: "0.1" }, architecture: { modality: "text" } })] }).kind,
    "ok",
  );
  check("a duplicate id is carried once", readOpenRouterModels({ data: [model(), model()] }), {
    kind: "ok",
    models: [{ id: "qwen/qwen3-coder", name: "Qwen: Qwen3 Coder" }],
    toolless: [],
  });
  /*
   * The two shapes that are not a list of models at all. Separate from `ok` with
   * nothing in it, which is a provider that really has nothing — see the notice.
   */
  check(
    "an answer that is not a model list says so, and is not an empty one",
    [readOpenRouterModels({ data: {} }).kind, readOpenRouterModels([]).kind, readOpenRouterModels(null).kind],
    ["malformed", "malformed", "malformed"],
  );
  /*
   * ⚠ **The name is carried verbatim and never rebuilt from the id.** Stripping a
   * `"<Vendor>: "` prefix looks tidy and is a rule with a hole: measured, 19 of
   * the 348 carry no prefix at all and four vendors disagree with themselves —
   * `anthropic/claude-opus-5` is `Claude Opus 5` while `anthropic/claude-sonnet-5`
   * is `Anthropic: Claude Sonnet 5`. Stripping would draw those two as products of
   * two different companies under one heading.
   */
  check(
    "a name is whatever the catalogue called it, prefix or no prefix",
    (readOpenRouterModels({
      data: [model({ id: "anthropic/claude-opus-5", name: "Claude Opus 5" }), model({ id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5" })],
    }) as { models: { name: string }[] }).models.map((one) => one.name),
    ["Claude Opus 5", "Anthropic: Claude Sonnet 5"],
  );
  /*
   * ⚠ **An unread list and an empty one are different facts.** The arms are
   * separate for that reason alone: a provider that genuinely lists nothing usable
   * and a provider this device could not reach are two different things to be
   * told, and one sentence for both would make the second read as the first.
   *
   * None of them names a remedy, which is this app's standing rule for a refusal
   * and is not a slip here: nobody in this product configures that address.
   */
  check(
    "each state of the read draws its own sentence, and none of them a remedy",
    [
      openRouterNotice(null, "OpenRouter"),
      openRouterNotice({ kind: "ok", models: [], toolless: [] }, "OpenRouter"),
      openRouterNotice({ kind: "ok", models: [{ id: "a/b", name: "n" }], toolless: [] }, "OpenRouter"),
      openRouterNotice({ kind: "unreachable", reason: "Failed to fetch" }, "OpenRouter"),
      openRouterNotice({ kind: "malformed", reason: "no data" }, "OpenRouter"),
    ],
    [
      "Reading OpenRouter's model list…",
      "OpenRouter lists no models that can use tools.",
      null,
      "OpenRouter's model list could not be read on this device.",
      "OpenRouter's model list could not be read on this device.",
    ],
  );
  /*
   * ⚠ **The reason is deliberately not in the sentence.** A refused `connect-src`
   * arrives as a bare `TypeError` with no status, so the text a browser happens to
   * put on it is not something a person can act on — and this one has no remedy to
   * offer anyway.
   */
  check(
    "and the sentence never carries the browser's own words for the failure",
    /Failed to fetch|TypeError|no data/.test(
      [openRouterNotice({ kind: "unreachable", reason: "Failed to fetch" }, "OpenRouter"), openRouterNotice({ kind: "malformed", reason: "no data" }, "OpenRouter")].join(" "),
    ),
    false,
  );
  /*
   * ⚠ **The address is this app's, and the daemon's `baseUrl` is not it.** Two
   * different things that share a host: the daemon's is where a *routed session's*
   * traffic goes and is deliberately spelled without the `/v1` the SDK appends,
   * while this one is a catalogue read by the browser. Pinned because deriving one
   * from the other is the obvious tidy-up and it is wrong in both directions.
   */
  check(
    "the catalogue address is the versioned one, and the system id matches the daemon's",
    [OPENROUTER_MODELS_URL, OPENROUTER_SYSTEM_ID],
    ["https://openrouter.ai/api/v1/models", "openrouter"],
  );
  /*
   * ⚠ **And it is reached with no credential, ever.** This app has none to offer a
   * third party — `cp.ts`'s standing "only ever to this origin" rule — and the
   * endpoint wants none. Read off the module rather than asserted about a call,
   * because what must not exist is a header, and a call that never happens in a
   * driver would prove nothing about one that does.
   */
  const openRouterRaw = readFileSync(new URL("../src/openrouter.ts", import.meta.url), "utf8");
  check(
    "and nothing on that request carries a credential",
    [/headers/i, /authorization/i, /credential/i, /\bcp\.|credentialOf|bearer/i].filter((one) =>
      one.test(openRouterRaw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")),
    ).map(String),
    [],
  );

  /* ── the read this app holds on to, and the one it must not ──────────── */
  {
    /*
     * ⚠ **The stateful half of this module was driven nowhere.** Everything above
     * is pure and was asserted; the cache around it — a module-level `cached`, a
     * module-level `inflight` and a TTL — had no assertion at all, and the rule it
     * exists to keep is the one with a symptom: *a failure is never cached*. A read
     * that did not land has to be retryable by reopening the screen, so only `ok`
     * is held. Dropping the `read.kind === "ok"` guard leaves a tab drawing "the
     * model list could not be read on this device" for ten minutes after a single
     * blip, with nothing anybody can press.
     */
    const realFetch = globalThis.fetch;
    let calls = 0;
    /** What the next request answers. Swung per case; every call is counted. */
    let answer: () => Promise<Response> = async () => new Response("{}");
    globalThis.fetch = ((): Promise<Response> => {
      calls += 1;
      return answer();
    }) as typeof fetch;

    const body = (models: unknown[]): Response =>
      new Response(JSON.stringify({ data: models }), { headers: { "content-type": "application/json" } });

    try {
      // Or this block inherits whatever an earlier one left in the module, which
      // is the accident `forgetOpenRouterModels` exists for.
      forgetOpenRouterModels();

      /* (a) A failure, then a success — the assertion the guard is. */
      answer = async () => new Response("nope", { status: 500 });
      const failed = await fetchOpenRouterModels();
      check("a list that answered 500 is unreachable", failed.kind, "unreachable");
      answer = async () => body([model()]);
      const recovered = await fetchOpenRouterModels();
      check(
        "and the very next read is allowed to succeed, because a failure is never held",
        [recovered.kind, calls],
        // Two calls: the failure was not cached, so the second read really went out.
        ["ok", 2],
      );

      /* (b) The TTL, both sides of it. */
      forgetOpenRouterModels();
      calls = 0;
      answer = async () => body([model()]);
      const first = await fetchOpenRouterModels();
      check("a good read lands", [first.kind, calls], ["ok", 1]);
      await fetchOpenRouterModels(Date.now());
      check("a second read inside the window sends nothing", calls, 1);
      /*
       * ⚠ **`now` is injected but `cached.at` is written from the module's own
       * `Date.now()` — two clocks, deliberately not worked around here.** So the
       * far side of the window is reached by asking about a moment past it rather
       * than by moving the stored one, which is the only half a caller controls.
       */
      await fetchOpenRouterModels(Date.now() + OPENROUTER_TTL_MS + 1);
      check("and one past it goes back to the network", calls, 2);

      /* (c) One request in the air, however many callers are waiting. */
      forgetOpenRouterModels();
      calls = 0;
      /*
       * ⚠ **Every resolver is kept, not just the last.** Holding one and releasing
       * it leaves the *other* request unanswered when the sharing is gone, so a
       * regression here would hang this driver for its whole timeout instead of
       * printing a red line. Releasing all of them makes the failure arrive at the
       * assertion rather than at the clock.
       */
      const waiting: ((response: Response) => void)[] = [];
      answer = () => new Promise<Response>((resolve) => void waiting.push(resolve));
      const both = Promise.all([fetchOpenRouterModels(), fetchOpenRouterModels()]);
      check("two callers at once make one request", calls, 1);
      for (const resolve of waiting) resolve(body([model()]));
      const [left, right] = await both;
      check("and both are given the same answer", [left.kind, right.kind, left === right], ["ok", "ok", true]);
    } finally {
      globalThis.fetch = realFetch;
      // The module outlives this block — every later import shares it — so the
      // cache this block filled must not be what anything downstream reads.
      forgetOpenRouterModels();
    }
  }
}
