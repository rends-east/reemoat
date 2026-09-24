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

  check(
    "only the models that can call tools are offered",
    readOpenRouterModels({
      data: [
        model(),
        model({ id: "a/chat-only", supported_parameters: ["temperature"] }),
        model({ id: "b/no-field" , supported_parameters: undefined }),
      ],
    }),
    // Refused rows are named so `allModels` can drop them from opencode's published list too. Q3.520.
    { kind: "ok", models: [{ id: "qwen/qwen3-coder", name: "Qwen: Qwen3 Coder" }], toolless: ["a/chat-only", "b/no-field"] },
  );
  // `:batch` is an asynchronous API no door here can reach; matched by suffix, and the third row fails a substring test.
  check(
    "and neither is the batch tier of one, which no door here can reach",
    readOpenRouterModels({
      data: [
        model(),
        model({ id: `qwen/qwen3-coder${BATCH_VARIANT}`, name: "Qwen: Qwen3 Coder (batch)" }),
        model({ id: "deepseek/batch", name: "DeepSeek: Batch" }),
      ],
    }),
    // `toolless` stays empty: a batch id can call tools, and naming it would drop a published row a stored preset may still use.
    {
      kind: "ok",
      models: [
        { id: "qwen/qwen3-coder", name: "Qwen: Qwen3 Coder" },
        { id: "deepseek/batch", name: "DeepSeek: Batch" },
      ],
      toolless: [],
    },
  );
  // The daemon is taught neither filter on purpose, so a batch id already stored keeps being sent.
  check(
    "the suffix is the browser's rule and no daemon source knows it",
    [BATCH_VARIANT, readFileSync(new URL("../../../src/acp/systems.ts", import.meta.url), "utf8").includes(BATCH_VARIANT)],
    [":batch", false],
  );
  // Fails open, unlike `catalogue.ts`: a bad entry costs one row, not the list.
  check(
    "one unreadable entry costs one row and not the list",
    readOpenRouterModels({ data: [7, null, { id: 5, name: "x" }, model({ id: "keep/me" }), { name: "no id" }] }),
    { kind: "ok", models: [{ id: "keep/me", name: "Qwen: Qwen3 Coder" }], toolless: [] },
  );
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
  check(
    "an answer that is not a model list says so, and is not an empty one",
    [readOpenRouterModels({ data: {} }).kind, readOpenRouterModels([]).kind, readOpenRouterModels(null).kind],
    ["malformed", "malformed", "malformed"],
  );
  check(
    "a name is whatever the catalogue called it, prefix or no prefix",
    (readOpenRouterModels({
      data: [model({ id: "anthropic/claude-opus-5", name: "Claude Opus 5" }), model({ id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5" })],
    }) as { models: { name: string }[] }).models.map((one) => one.name),
    ["Claude Opus 5", "Anthropic: Claude Sonnet 5"],
  );
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
  check(
    "and the sentence never carries the browser's own words for the failure",
    /Failed to fetch|TypeError|no data/.test(
      [openRouterNotice({ kind: "unreachable", reason: "Failed to fetch" }, "OpenRouter"), openRouterNotice({ kind: "malformed", reason: "no data" }, "OpenRouter")].join(" "),
    ),
    false,
  );
  // The catalogue URL is not the daemon's `baseUrl`, which omits the `/v1`; deriving either from the other is wrong.
  check(
    "the catalogue address is the versioned one, and the system id matches the daemon's",
    [OPENROUTER_MODELS_URL, OPENROUTER_SYSTEM_ID],
    ["https://openrouter.ai/api/v1/models", "openrouter"],
  );
  const openRouterRaw = readFileSync(new URL("../src/openrouter.ts", import.meta.url), "utf8");
  check(
    "and nothing on that request carries a credential",
    [/headers/i, /authorization/i, /credential/i, /\bcp\.|credentialOf|bearer/i].filter((one) =>
      one.test(openRouterRaw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")),
    ).map(String),
    [],
  );

  {
    // Only an `ok` read is cached, so a failure stays retryable by reopening the screen.
    const realFetch = globalThis.fetch;
    let calls = 0;
    let answer: () => Promise<Response> = async () => new Response("{}");
    globalThis.fetch = ((): Promise<Response> => {
      calls += 1;
      return answer();
    }) as typeof fetch;

    const body = (models: unknown[]): Response =>
      new Response(JSON.stringify({ data: models }), { headers: { "content-type": "application/json" } });

    try {
      forgetOpenRouterModels();

      answer = async () => new Response("nope", { status: 500 });
      const failed = await fetchOpenRouterModels();
      check("a list that answered 500 is unreachable", failed.kind, "unreachable");
      answer = async () => body([model()]);
      const recovered = await fetchOpenRouterModels();
      check(
        "and the very next read is allowed to succeed, because a failure is never held",
        [recovered.kind, calls],
        ["ok", 2],
      );

      forgetOpenRouterModels();
      calls = 0;
      answer = async () => body([model()]);
      const first = await fetchOpenRouterModels();
      check("a good read lands", [first.kind, calls], ["ok", 1]);
      await fetchOpenRouterModels(Date.now());
      check("a second read inside the window sends nothing", calls, 1);
      // `cached.at` comes from the module's own clock, so the far side of the TTL is reached by passing a later `now`.
      await fetchOpenRouterModels(Date.now() + OPENROUTER_TTL_MS + 1);
      check("and one past it goes back to the network", calls, 2);

      forgetOpenRouterModels();
      calls = 0;
      // Every resolver is released so a regression fails at the assertion instead of hanging the driver.
      const waiting: ((response: Response) => void)[] = [];
      answer = () => new Promise<Response>((resolve) => void waiting.push(resolve));
      const both = Promise.all([fetchOpenRouterModels(), fetchOpenRouterModels()]);
      check("two callers at once make one request", calls, 1);
      for (const resolve of waiting) resolve(body([model()]));
      const [left, right] = await both;
      check("and both are given the same answer", [left.kind, right.kind, left === right], ["ok", "ok", true]);
    } finally {
      globalThis.fetch = realFetch;
      // Later imports share this module, so the cache this block filled is cleared.
      forgetOpenRouterModels();
    }
  }
}
