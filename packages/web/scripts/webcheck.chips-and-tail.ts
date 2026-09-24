import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { snapshot } from "./webcheck.ws.js";
import { stripComments } from "./webcheck.source.js";
import { drawn } from "./webcheck.rows.js";
import {
  SUMMARY_CHARS,
  TITLE_CHARS,
  TITLE_OVERFLOW_MIN,
  buildTail,
  chipValue,
  clipTitle,
  configProse,
  detailWorthDrawing,
  elapsedSince,
  headlineWorthDrawing,
  mergeUpdates,
  opensToAnything,
  resolveTool,
  restatesInput,
  supersedes,
} from "./webcheck.modules.js";

process.stdout.write("\nconfig prose, recovered from the transcript\n");
{
  const configEvent = (value: string, description: string) => ({
    seq: 1,
    ts: 0,
    event: {
      type: "agent_config",
      modes: null,
      options: [
        {
          id: "model",
          name: "Model",
          description: "AI model to use",
          category: "model",
          kind: "select",
          value,
          choices: [{ value: "default", name: "Default", description, group: null }],
        },
      ],
    },
  });

  const prose = configProse([configEvent("default", "Opus 5 for most of your limit, then Sonnet 5")] as never);
  check("the choice's description survives in the log", prose.get("model")?.choices.get("default"), "Opus 5 for most of your limit, then Sonnet 5");
  check("and the option's own prose too", prose.get("model")?.description, "AI model to use");

  const newest = configProse([
    configEvent("default", "stale"),
    { ...configEvent("default", "current"), seq: 2 },
  ] as never);
  check("the newest event wins", newest.get("model")?.choices.get("default"), "current");

  check("an empty transcript yields nothing rather than throwing", configProse([]).size, 0);
  check("and a transcript with no config event is the same", configProse([{ seq: 1, ts: 0, event: { type: "prompt", text: "hi" } }] as never).size, 0);
}

process.stdout.write("\nchip labels\n");
{
  // The literal payloads claude 0.63.0 publishes, copied from a live session.
  const opt = (over: Record<string, unknown>) =>
    ({ id: "x", name: "X", description: null, kind: "select", ...over }) as never;

  const modelDefault = opt({
    category: "model",
    value: "default",
    choices: [
      { value: "default", name: "Default (recommended)", description: "Opus 5 with 1M context · Best for everyday, complex tasks", group: null },
      { value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", group: null },
    ],
  });
  check("a default model names the model, not the word Default", chipValue(modelDefault), "Opus 5");

  const modelPicked = opt({
    category: "model",
    value: "sonnet",
    choices: [{ value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", group: null }],
  });
  check("and a picked one names it too", chipValue(modelPicked), "Sonnet 5");

  const opencodeChip = opt({
    category: "model",
    value: "openrouter/anthropic/claude-opus-4.7-fast",
    choices: [
      { value: "openrouter/aion-labs/aion-2.0", name: "OpenRouter/Aion-2.0", description: null, group: null },
      {
        value: "openrouter/anthropic/claude-opus-4.7-fast",
        name: "OpenRouter/Claude Opus 4.7 Fast",
        description: null,
        group: null,
      },
      { value: "openrouter/qwen/qwen3-coder", name: "OpenRouter/Qwen3 Coder", description: null, group: null },
    ],
  });
  check("a chip names the model rather than the provider it came from", chipValue(opencodeChip), "Claude Opus 4.7 Fast");
  check(
    "and it carries the whole name where the list holds two of them",
    chipValue(
      opt({
        category: "model",
        value: "openrouter/anthropic/claude-opus-4.7-fast",
        choices: [
          {
            value: "openrouter/anthropic/claude-opus-4.7-fast",
            name: "OpenRouter/Claude Opus 4.7 Fast",
            description: null,
            group: null,
          },
          { value: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle", description: null, group: null },
        ],
      }),
    ),
    "OpenRouter/Claude Opus 4.7 Fast",
  );
  check(
    "a qualifier like \"with 1M context\" is left to the menu",
    chipValue(opt({
      category: "model",
      value: "o",
      choices: [{ value: "o", name: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday", group: null }],
    })),
    "Opus 5",
  );

  const mode = opt({
    category: "mode",
    value: "acceptEdits",
    choices: [{ value: "acceptEdits", name: "Accept Edits", description: "Edits apply without asking", group: null }],
  });
  check("mode keeps its short name over its long sentence", chipValue(mode), "Accept Edits");

  check(
    "a mode named Default keeps the name the agent gave it",
    chipValue(opt({
      category: "mode",
      value: "default",
      choices: [
        { value: "default", name: "Default", description: "Manual approvals; tools execute normally.", group: null },
      ],
    })),
    "Default",
  );
  check(
    "and one the other agent named differently keeps that",
    chipValue(opt({
      category: "mode",
      value: "default",
      choices: [{ value: "default", name: "Manual", description: null, group: null }],
    })),
    "Manual",
  );

  const effort = opt({
    category: "thought_level",
    value: "default",
    choices: [{ value: "default", name: "Default", description: null, group: null }],
  });
  // `Adaptive`: with effort unset claude sends no effort parameter, and the model then thinks adaptively.
  check("claude's default effort is named for what it is", chipValue(effort), "Adaptive");
  const kimiThinking = opt({
    category: "thought_level",
    value: "off",
    choices: [{ value: "off", name: "Off", description: null, group: null }],
  });
  check("but kimi's own value keeps its own name", chipValue(kimiThinking), "Off");
  const picked = opt({
    category: "thought_level",
    value: "high",
    choices: [{ value: "high", name: "High", description: null, group: null }],
  });
  check("and an explicitly picked level is untouched", chipValue(picked), "High");

  const stripped = opt({
    category: "model",
    value: "default",
    choices: [{ value: "default", name: "Default (recommended)", description: null, group: null }],
  });
  check("a stripped description degrades to the name", chipValue(stripped), "Default (recommended)");
  const wordy = opt({
    category: "model",
    value: "d",
    choices: [{ value: "d", name: "D", description: "a description with no separator that runs on far too long to be a label", group: null }],
  });
  check("and so does prose too long to be a label", chipValue(wordy), "D");
  const codexModel = opt({
    category: "model",
    value: "gpt-5.6-sol",
    choices: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol", description: "Latest frontier agentic coding model.", group: null }],
  });
  check("a short sentence is still a sentence, not a model name", chipValue(codexModel), "GPT-5.6-Sol");
  check("while a description that does separate still names the model", chipValue(modelDefault), "Opus 5");

  // claude 2.1.280's rows verbatim: a fresh list, and one resumed after the `opus` alias moved to Opus 5.5.
  const row = (value: string, name: string, description: string | null) => ({ value, name, description, group: null });
  const fresh280 = [
    row("default", "Default (recommended)", "Sonnet"),
    row("sonnet", "Sonnet", "Sonnet 5 · Efficient for routine tasks"),
    row("claude-fable-5-1[1m]", "Fable", "Fable 5.1 · Most capable for your hardest and longest-running tasks"),
    row("opus", "Opus", "Opus 5.5 · Best for everyday, complex tasks"),
    row("haiku", "Haiku", "Haiku 4.5 · Fastest for quick answers"),
    row("opus[1m]", "Opus (1M context)", "Opus 5.5 with 1M context · Best for everyday, complex tasks"),
  ];
  const resumed280 = [
    ...fresh280.slice(0, 5),
    row("claude-opus-5[1m]", "Opus 5 (1M context)", "Newer version available · select Opus for Opus 5.5"),
  ];
  const chipOn = (choices: typeof fresh280, value: string) => chipValue(opt({ category: "model", value, choices }));
  check(
    "a description whose head is a notice rather than a model is drawn by the row's name",
    chipOn(resumed280, "claude-opus-5[1m]"),
    "Opus 5",
  );
  check(
    "every row of a fresh 2.1.280 list names its model",
    fresh280.map((one) => chipOn(fresh280, one.value)),
    ["Default (recommended)", "Sonnet 5", "Fable 5.1", "Opus 5.5", "Haiku 4.5", "Opus 5.5"],
  );
  check(
    "and so does the resumed list, bar the one row that names none",
    resumed280.map((one) => chipOn(resumed280, one.value)),
    ["Default (recommended)", "Sonnet 5", "Fable 5.1", "Opus 5.5", "Haiku 4.5", "Opus 5"],
  );
  // The placeholder's description has no separator, so it keeps its name (Q3.410).
  check(
    "the placeholder whose description has no separator keeps its name",
    chipOn(fresh280, "default"),
    "Default (recommended)",
  );
  const proseOf = (value: string, description: string) =>
    configProse([
      {
        seq: 1,
        ts: 0,
        event: {
          type: "agent_config",
          modes: null,
          options: [{ id: "x", name: "X", description: null, category: "model", kind: "select", value, choices: [row(value, value, description)] }],
        },
      },
    ] as never).get("x");
  check(
    "the rule holds on the transcript's prose as well as the snapshot's",
    chipValue(
      opt({ category: "model", value: "claude-opus-5[1m]", choices: [row("claude-opus-5[1m]", "Opus 5 (1M context)", null)] }),
      proseOf("claude-opus-5[1m]", "Newer version available · select Opus for Opus 5.5"),
    ),
    "Opus 5",
  );
  // `[` is a word boundary, so `opus[1m]` tests as `opus`.
  check(
    "and a value with no choice to name it still takes the prose's model",
    chipValue(
      opt({ category: "model", value: "opus[1m]", choices: [row("sonnet", "Sonnet", "Sonnet 5 · Efficient for routine tasks")] }),
      proseOf("opus[1m]", "Opus 5 with 1M context · Best"),
    ),
    "Opus 5",
  );
}

process.stdout.write("\nthe age of a row, across two clocks\n");
{
  // An age is anchored to the daemon's clock at fetch time and extended by ours, so phone drift cannot make it negative.
  const row = { daemonNow: 11_000, fetchedAt: 1_000 } as never;
  // The daemon is 10s ahead; the permission was raised 2s before the fetch, and we ask 3s after it.
  check("an age is measured in the daemon's clock and extended in ours", elapsedSince(row, 9_000, 4_000), 5_000);
  check("and does not drift when only our own clock moves on", elapsedSince(row, 9_000, 64_000), 65_000);
  report(
    "while subtracting from our own clock would report a negative age",
    4_000 - 9_000 < 0,
    "daemon 10s ahead → -5s waiting",
  );
  check("a row fetched and read at the same instant is as old as the daemon said", elapsedSince(row, 11_000, 1_000), 0);

  {
    const { store } = await import("../src/store.js");
    const { keyOf, machineId, sessionId } = await import("../src/ids.js");
    const ref = { machineId: machineId("m_clock"), sessionId: sessionId("s_clock") };
    const key = keyOf(ref);
    const internals = store as unknown as { rows: Map<string, unknown>; transcripts: Map<string, unknown> };
    const arriving = { ...snapshot, id: "s_clock" } as never;

    internals.rows.set(key, { key, ref, machineName: "alpha", snapshot: arriving, daemonNow: 11_000, fetchedAt: 1_000 });
    store.onSnapshot(ref, arriving);
    const after = store.getSnapshot().rowsByKey.get(key);
    check(
      "a snapshot arriving keeps the offset the poll measured, byte for byte",
      [after?.daemonNow, after?.fetchedAt],
      [11_000, 1_000],
    );
    check(
      "so the age it produces is still measured in the daemon's clock",
      after === undefined ? null : elapsedSince(after, 9_000, 4_000),
      5_000,
    );
    check("and the snapshot itself is what was folded in", after?.snapshot.id, "s_clock");

    internals.rows.delete(key);
    internals.transcripts.delete(key);
    store.onSnapshot(ref, arriving);
    const cold = store.getSnapshot().rowsByKey.get(key);
    check("with no reading to keep, the two halves are one reading rather than two", cold?.daemonNow === cold?.fetchedAt, true);
    check(
      "which is an offset of zero — the browser's own subtraction, until the next poll",
      cold === undefined ? null : elapsedSince(cold, cold.daemonNow - 5_000, cold.fetchedAt),
      5_000,
    );
    // Source half too: equality cannot tell one clock read from two in the same millisecond.
    const storeSrc = stripComments(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
    const writerAt = storeSrc.indexOf("onSnapshot(ref: SessionRef, session: SessionSnapshot): void {");
    const writer = writerAt < 0 ? "" : storeSrc.slice(writerAt, storeSrc.indexOf("\n  }\n", writerAt));
    check("the writer was found", writerAt >= 0, true);
    check("and it reads this clock exactly once", (writer.match(/Date\.now\(\)/g) ?? []).length, 1);
    check(
      "and neither half of the pair is re-read where a row already has one",
      [/daemonNow: existing\?\.daemonNow \?\? unanchored,/.test(writer), /fetchedAt: existing\?\.fetchedAt \?\? unanchored,/.test(writer)],
      [true, true],
    );

    // The store is a singleton shared with this whole file, so the fixture is taken back out.
    internals.rows.delete(key);
    internals.transcripts.delete(key);
  }
}

process.stdout.write("\nthe login transcript cursor\n");
{
  // A model of the daemon's `readFrom` (daemoncheck drives the real one); the client must assign the cursor, not advance by chunk length.
  const read = (buffer: string, dropped: number, since: number) => {
    const from = Math.max(since, dropped);
    return { chunk: buffer.slice(from - dropped), cursor: dropped + buffer.length, gap: since < dropped };
  };

  check("a fresh read returns everything", read("open https://x", 0, 0).chunk, "open https://x");
  check("and reports the cursor as the total produced", read("open https://x", 0, 0).cursor, 14);
  check("a second read from that cursor returns nothing new", read("open https://x", 0, 14).chunk, "");
  check("a cursor behind the discarded prefix is a gap", read("tail", 100, 40).gap, true);
  check("and reads from the start of what is left", read("tail", 100, 40).chunk, "tail");
  check("a cursor inside the window is not a gap", read("tail", 100, 102).gap, false);
  check("and reads only what follows it", read("tail", 100, 102).chunk, "il");
}

process.stdout.write("\nthe tail is built backwards\n");
{
  let seq = 0;
  const txt = (text: string, role = "agent", thought = false): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event: { type: "text", role, thought, text } }) as never;
  const call = (id: string): never =>
    ({
      seq: (seq += 1),
      ts: seq * 1000,
      event: { type: "tool_call", toolCallId: id, title: id, kind: "other", status: "pending", locations: [], rawInput: null, parentToolCallId: null },
    }) as never;

  {
    seq = 0;
    const tail = buildTail([txt("he"), txt("llo"), txt(" there")], []);
    check("consecutive chunks with the same role are one run", tail.rows.length, 1);
    check("joined in document order", (tail.rows[0] as { text: string }).text, "hello there");
    // Keyed by the last, a streaming message would remount on every token and shut any card opened inside it.
    check("and keyed by its first event, not its last", tail.rows[0]?.key, "t1");
  }

  {
    seq = 0;
    const tail = buildTail([txt("mine", "user"), txt("theirs", "agent")], []);
    check("a change of role starts a new run", tail.rows.map((r) => r.key), ["t1", "t2"]);
  }

  // A change of `messageId` starts a new run (ACP); a daemon that sends no ids must join as before.
  {
    const idTxt = (text: string, messageId: string | null | undefined): never =>
      ({ seq: (seq += 1), ts: seq * 1000, event: { type: "text", role: "agent", thought: false, text, messageId } }) as never;
    seq = 0;
    check(
      "chunks of one message are one run",
      buildTail([idTxt("he", "m1"), idTxt("llo", "m1")], []).rows.map((r) => r.key),
      ["t1"],
    );
    seq = 0;
    check(
      "and two messages are two, however they run together",
      buildTail([idTxt("**Stopped:** a.", "m1"), idTxt("**Stopped:** b.", "m2")], []).rows.map((r) => r.key),
      ["t1", "t2"],
    );
    seq = 0;
    check(
      "a daemon too old to say joins exactly as it always did",
      buildTail([idTxt("he", undefined), idTxt("llo", undefined)], []).rows.map((r) => r.key),
      ["t1"],
    );
    seq = 0;
    check(
      "and an absent id is the same silence as a null one",
      buildTail([idTxt("he", undefined), idTxt("llo", null)], []).rows.map((r) => r.key),
      ["t1"],
    );
    seq = 0;
    check(
      "an id the daemon assigned separates two messages like any other",
      buildTail([idTxt("a.", "~1"), idTxt("b.", "~2")], []).rows.map((r) => r.key),
      ["t1", "t2"],
    );
  }

  // Driven through `buildTail` rather than `mergeUpdates`: the construction site is what can drop a field.
  {
    seq = 0;
    const shot = { uploadId: "a_1", name: "image-a1.png", mime: "image/png", bytes: 4096 };
    const withImage = (id: string): never =>
      ({
        seq: (seq += 1),
        ts: seq * 1000,
        event: {
          type: "tool_call_update",
          toolCallId: id,
          title: null,
          status: "completed",
          locations: [],
          rawInput: null,
          content: null,
          images: [shot],
          parentToolCallId: null,
        },
      }) as never;
    const tail = buildTail([call("c1"), withImage("c1")], []);
    const node = tail.rows[0] as { kind: string; images: readonly unknown[] };
    check("a tool card is what comes out", node.kind, "tool");
    check("and it carries the image the tool returned", node.images, [shot]);
  }

  {
    seq = 0;
    const bare = (id: string): never =>
      ({
        seq: (seq += 1),
        ts: seq * 1000,
        event: { type: "tool_call_update", toolCallId: id, title: null, status: "completed", locations: [], rawInput: null, content: ["done"], parentToolCallId: null },
      }) as never;
    const tail = buildTail([call("c2"), bare("c2")], []);
    check("a daemon that sends none yields an empty list", (tail.rows[0] as { images: readonly unknown[] }).images, []);
  }

  {
    seq = 0;
    const tail = buildTail([txt("thinking", "agent", true), txt("saying", "agent", false)], []);
    check("a thought draws nothing at all", tail.rows.map((r) => r.key), ["t2"]);
    // Optional: the regression above empties `rows`, and a throw would take the sections below with it.
    check("and the speech beside it is untouched", (tail.rows[0] as { text?: string } | undefined)?.text, "saying");
  }

  {
    seq = 0;
    const tail = buildTail(
      [txt("before.", "agent", false), txt("reasoning", "agent", true), txt("after.", "agent", false)],
      [],
    );
    check("speech either side of a thought stays two runs", tail.rows.map((r) => r.key), ["t1", "t3"]);
    check(
      "rather than being run together",
      tail.rows.map((r) => (r as { text: string }).text),
      ["before.", "after."],
    );
  }

  {
    // Four chunks, because only the text shows a run joined backwards.
    seq = 0;
    check(
      "a four-chunk run joins in document order",
      (buildTail([txt("one "), txt("two "), txt("three "), txt("four")], []).rows[0] as { text: string }).text,
      "one two three four",
    );

    seq = 0;
    const split = buildTail(
      [txt("a1 "), txt("a2 "), txt("mm", "agent", true), txt("b1 "), txt("b2")],
      [],
    );
    check(
      "and so does each side of a thought that flushed it",
      split.rows.map((r) => (r as { text: string }).text),
      ["a1 a2 ", "b1 b2"],
    );
  }

  {
    seq = 0;
    const tail = buildTail([txt("t1", "agent", true), txt("t2", "agent", true), txt("a"), txt("b", "user")], []);
    check("a thought draws no row", tail.rows.map((r) => r.key), ["t3", "t4"]);
  }

  // The third argument is the lowest seq drawn: that of the newest `context_cleared`.
  {
    seq = 0;
    const tail = buildTail([txt("a"), txt("b"), txt("c")], [], 2);
    check("a run is built from everything at or above the cut", (tail.rows[0] as { text: string }).text, "bc");
    check("and what is below it is counted", tail.hidden, 1);
  }

  {
    seq = 0;
    const tail = buildTail([call("a"), call("b"), call("c")], [], 2);
    check("only what is at or above the cut is drawn", drawn(tail.rows), ["e2", "e3"]);

    // Three text events below the cut coalesce to one row, so only this fixture tells events from rows.
    seq = 0;
    check(
      "and `hidden` counts events, not rows",
      buildTail([txt("a"), txt("b"), txt("c"), call("d")], [], 4).hidden,
      3,
    );
  }

  {
    seq = 0;
    check("with no cut nothing is hidden at all", buildTail([call("a"), call("b")], []).hidden, 0);
  }

  {
    seq = 0;
    const events = [call("a"), call("b"), call("c")];
    const tail = buildTail(events, [{ from: 3, to: 4, reason: "evicted" } as never]);
    check(
      "a gap inside the window sorts just before the event it precedes",
      drawn(tail.rows),
      ["e1", "e2", "g3", "e3"],
    );
  }

  {
    seq = 0;
    const tail = buildTail(
      [call("a"), call("b"), call("c"), call("d")],
      [{ from: 2, to: 2, reason: "evicted" } as never],
      3,
    );
    check("and one below it is not drawn", drawn(tail.rows), ["e3", "e4"]);
  }
}

process.stdout.write("\none tool call is five events\n");
{
  // A single claude `echo`: a call plus four updates, with each field a person wants on a different one.
  const upd = (
    over: Partial<Parameters<typeof mergeUpdates>[0][number]>,
  ): Parameters<typeof mergeUpdates>[0][number] => ({
    ts: 0,
    status: null,
    title: null,
    rawInput: null,
    locations: [],
    content: null,
    ...over,
  });

  const merged = mergeUpdates([
    upd({ ts: 1, title: "echo hi-there", rawInput: { command: "echo hi-there" } }),
    upd({ ts: 2, title: "echo hi-there", rawInput: { command: "echo hi-there", description: "Echo" }, content: ["Echo hi-there"] }),
    upd({ ts: 3 }),
    upd({ ts: 4, status: "completed", content: ["```console\nhi-there\n```"] }),
  ]);

  const call = { title: "Terminal", kind: "execute" as const, status: "pending" as const, rawInput: {}, locations: [] };
  const drawn = resolveTool(call, merged);

  check("the update's title beats the call's", drawn.title, "echo hi-there");
  check("and a later update's arguments beat an empty call's", drawn.rawInput, {
    command: "echo hi-there",
    description: "Echo",
  });
  check("each content block that says something of its own is kept, in order", drawn.output, [
    "Echo hi-there",
    "```console\nhi-there\n```",
  ]);
  check("the newest status wins", drawn.status, "completed");
  check(
    "a call with no updates at all is drawn from itself",
    resolveTool({ ...call, title: "Terminal", rawInput: { command: "x" } }, null).title,
    "Terminal",
  );

  const refined = resolveTool(
    { ...call, title: "Web search", rawInput: { type: "webSearch", id: "exec-2810", query: "", action: null } },
    mergeUpdates([
      upd({ ts: 1, status: "completed", title: "Web search: red mullet", rawInput: { type: "webSearch", id: "exec-2810", query: "red mullet", action: null } }),
    ]),
  );
  check("a refined set of arguments beats the call's own placeholders", refined.rawInput, {
    type: "webSearch",
    id: "exec-2810",
    query: "red mullet",
    action: null,
  });
  check("so the arguments and the title agree", refined.title, "Web search: red mullet");

  const bodyOnly = resolveTool({ ...call, title: "Write" }, mergeUpdates([upd({ ts: 1, rawInput: { content: "hello" } })]));
  check("arguments that are only a body are kept rather than dropped as empty", bodyOnly.rawInput, { content: "hello" });

  const shortQuery = "red mullet fish Mullus barbatus description distribution feeding ...";
  check("a card that would open to the row's own text does not open", opensToAnything({
    detail: shortQuery,
    headline: shortQuery,
    outputBlocks: 0,
    locations: 0,
    children: 0,
    titleClipped: false,
    changes: 0,
  }), false);
  const longCommand = "x".repeat(SUMMARY_CHARS + 1);
  check("but one the row had to cut short does", opensToAnything({
    detail: longCommand,
    headline: longCommand,
    outputBlocks: 0,
    locations: 0,
    children: 0,
    titleClipped: false,
    changes: 0,
  }), true);
  check("and so does anything the row is not showing at all", [
    // A subagent's row carries a duration where the detail is the command.
    opensToAnything({ detail: "npm test", headline: "1.2s", outputBlocks: 0, locations: 0, children: 0, changes: 0, titleClipped: false }),
    opensToAnything({ detail: shortQuery, headline: shortQuery, outputBlocks: 1, locations: 0, children: 0, changes: 0, titleClipped: false }),
    opensToAnything({ detail: shortQuery, headline: shortQuery, outputBlocks: 0, locations: 1, children: 0, changes: 0, titleClipped: false }),
    opensToAnything({ detail: shortQuery, headline: shortQuery, outputBlocks: 0, locations: 0, children: 1, changes: 0, titleClipped: false }),
  ], [true, true, true, true]);
  check("a call that changed a file opens on that alone", opensToAnything({
    detail: null,
    headline: null,
    outputBlocks: 0,
    locations: 0,
    children: 0,
    titleClipped: false,
    changes: 1,
  }), true);
  check("a call with nothing at all stays shut", opensToAnything({
    detail: null,
    headline: null,
    outputBlocks: 0,
    locations: 0,
    children: 0,
    titleClipped: false,
    changes: 0,
  }), false);
  const queries =
    "Web search: red mullet fish Mullus barbatus description distribution feeding, Mullus barbatus FAO species fact sheet, red mullet Black Sea official source";
  check("a title too long for its row is clipped, and says so", [
    clipTitle(queries).clipped,
    clipTitle(queries).text.length,
    clipTitle("Bash").clipped,
    clipTitle("Bash").text,
  ], [true, TITLE_CHARS + 1, false, "Bash"]);
  check("a near miss is left whole rather than costing a line", [
    clipTitle("x".repeat(TITLE_CHARS + 1)).clipped,
    clipTitle("x".repeat(TITLE_CHARS + TITLE_OVERFLOW_MIN)).clipped,
    clipTitle("x".repeat(TITLE_CHARS + TITLE_OVERFLOW_MIN + 1)).clipped,
  ], [false, false, true]);

  const readTitle = "Read file '/Users/u/.codex/skills/.system/openai-docs/SKILL.md'";
  const readPath = "/Users/u/.codex/skills/.system/openai-docs/SKILL.md";
  const truncatedQuery = "red mullet fish Mullus barbatus description distribution feeding ...";
  check("an echo of the title is not drawn beside it", [
    headlineWorthDrawing(readTitle, readPath),
    headlineWorthDrawing(queries, truncatedQuery),
    headlineWorthDrawing("node /a/b/c.mjs", "node /a/b/c.mjs"),
    headlineWorthDrawing("Bash", null),
  ], [false, false, false, false]);
  check("and a headline that says something new is", [
    headlineWorthDrawing("Bash", "npm test"),
    headlineWorthDrawing("Edit", "/w/a.ts"),
    headlineWorthDrawing("Task", "1.2s"),
  ], [true, true, true]);
  check("and that alone makes the card open", opensToAnything({
    detail: null,
    headline: null,
    outputBlocks: 0,
    locations: 0,
    children: 0,
    changes: 0,
    titleClipped: true,
  }), true);

  check("the arguments are not drawn when the row has already said them", [
    detailWorthDrawing(shortQuery, shortQuery),
    detailWorthDrawing(longCommand, longCommand),
    detailWorthDrawing("npm test", "1.2s"),
    detailWorthDrawing(null, null),
  ], [false, true, true, false]);

  check(
    "an update that omits the parent does not erase one that named it",
    mergeUpdates([
      upd({ ts: 1, parentToolCallId: "toolu_parent" }),
      upd({ ts: 2, parentToolCallId: null }),
    ]).parentToolCallId,
    "toolu_parent",
  );

  // `supersedes` cannot see the compact restatement and `restatesInput` cannot run inside the fold, so both are needed.
  const streamed = mergeUpdates([
    upd({ ts: 1, content: ["{"] }),
    upd({ ts: 2, content: ['{"path": "a.py"'] }),
    upd({ ts: 3, content: ['{"path": "a.py", "content": "x"}'] }),
    upd({ ts: 4, title: "Writing a.py", rawInput: { path: "a.py", content: "x" }, content: ['{"path":"a.py","content":"x"}'] }),
    upd({ ts: 5, status: "completed", content: ["Wrote 1 byte to a.py"] }),
  ]);
  check("a streamed call draws its result and nothing else", streamed.content, ["Wrote 1 byte to a.py"]);
  check("and still knows what it was called with", streamed.rawInput, { path: "a.py", content: "x" });

  check("a block that extends the last supersedes it", supersedes('{"a": 1', "{"), true);
  check("one that merely repeats it does not", supersedes("{", "{"), false);
  check("nor does an unrelated one", supersedes("Wrote 1 byte", "{"), false);
  check("so an exact repeat is left standing", mergeUpdates([
    upd({ ts: 1, content: ["same"] }),
    upd({ ts: 2, content: ["same"] }),
  ]).content, ["same", "same"]);

  check("the arguments, compact, are not a result", restatesInput('{"a":1}', { a: 1 }), true);
  // The one the byte test misses, and the reason this parses rather than compares.
  check("nor are they pretty-printed", restatesInput('{"a": 1}', { a: 1 }), true);
  check("a different object is a result", restatesInput('{"a":2}', { a: 1 }), false);
  check("and so is anything that is not JSON", restatesInput("Wrote 1 byte to a.py", { a: 1 }), false);
  check("a call with no arguments restates nothing", restatesInput("{}", null), false);
}
