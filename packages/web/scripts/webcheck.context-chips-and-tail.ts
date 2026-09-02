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
  contextHint,
  contextPercent,
  detailWorthDrawing,
  elapsedSince,
  headlineWorthDrawing,
  mergeUpdates,
  opensToAnything,
  pieLabel,
  pieTone,
  resolveTool,
  restatesInput,
  shortCount,
  supersedes,
} from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * The context readout
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe context window\n");
{
  /*
   * Three answers, not two — the same discipline as `Liveness` and `loggedIn`.
   * "Cannot tell" is a distinct answer here: kimi may never send `usage_update`
   * and a restored session has no live agent to ask, so it is a common state.
   * What the readout *does* with it is a separate rule — see `pieTone` below,
   * which draws it in the quietest colour there is rather than as a hole. It used
   * to render as nothing at all, and the hole moved the chips beside it every
   * time an agent started or stopped reporting.
   */
  check("no usage at all is cannot-tell", contextPercent(null), null);
  check("and an older daemon's absent field is the same answer", contextPercent(undefined), null);
  // The one value nothing may divide by. The daemon stores 0 for "the agent
  // reported occupancy but not a window", precisely so this is checkable.
  check("a zero-size window is cannot-tell, not a division", contextPercent({ used: 0, size: 0, cost: null }), null);
  check("a real reading is a whole percent", contextPercent({ used: 190_000, size: 200_000, cost: null }), 95);
  check("rounded, since that is what is drawn", contextPercent({ used: 1234, size: 200_000, cost: null }), 1);
  // Possible across a model switch that shrinks the window. An arc past its own
  // circumference draws as garbage; reading "full" is at least true.
  check("over-full clamps rather than overrunning the arc", contextPercent({ used: 300_000, size: 200_000, cost: null }), 100);
  check("and a nonsense number is cannot-tell", contextPercent({ used: Number.NaN, size: 200_000, cost: null }), null);

  check("token counts are short enough for a chip", [shortCount(940), shortCount(124_000), shortCount(1_250_000)], ["940", "124k", "1.3M"]);
  /*
   * The boundary the unit is chosen at, which was chosen from the *raw* value
   * while the rounding happened after — so a number just under a million rounded
   * up and out of the arm that had already been picked, printing `1000k`.
   *
   * Both sides asserted, because a fix that only moves the boundary would pass
   * one of them: 999,949 must stay in `k`.
   */
  check(
    "and rounding cannot carry a number out of its own unit",
    [shortCount(999_949), shortCount(999_999), shortCount(1_000_000)],
    ["999.9k", "1M", "1M"],
  );
  // The real one, since this is what a codex window is.
  check("a codex context window reads as itself", shortCount(258_400), "258.4k");

  /*
   * The readout is a ring in the strip and a number only inside the popover it
   * opens, so nothing here is a width rule any more — a ring is one width at
   * every percentage. What is left is what the popover *says*.
   */
  check("a reading is the percent and a sign", [pieLabel(0), pieLabel(36), pieLabel(100)], ["0%", "36%", "100%"]);
  // Decided rather than fallen into: an unmeasured window reads `0%` and is told
  // apart by its tone and by the popover's own words, never by the glyph.
  check("cannot-tell reads as zero", pieLabel(null), "0%");
  check("but is not toned like a measurement", pieTone(null), "unknown");
  /*
   * And it says *why*, because the honest answer is agent-specific and the
   * generic one misleads. Measured: `usage_update` is in kimi 0.29.2's bundle
   * once, in the vendored protocol schema, with no site that sends it — so on
   * kimi the readout is empty for the life of every session and "has not said
   * yet" is a promise of a number that is never coming.
   */
  check("kimi is named, because it never reports and never will", contextHint("kimi"), "kimi does not report this — send /usage to ask it");
  // Pointed at the command kimi actually publishes, so the advice is something
  // the `/` menu already offers rather than something invented here.
  check("and pointed at a command that exists", contextHint("kimi").includes("/usage"), true);
  // Anything else gets the neutral form: claude does report, so reaching this at
  // all means a session with no live agent, where no command would help.
  check("every other agent gets the neutral answer", contextHint("claude"), "the agent has not reported this");
  /*
   * Codex belongs in that arm by measurement, not by falling off the end of a
   * ternary.
   *
   * Measured 2026-08-07 against codex-acp 1.1.9: a single prompt produced two
   * `usage_update` notifications carrying `{used: 16730, size: 258400}`. So the
   * number does arrive, "has not reported this" really does mean *yet*, and
   * naming codex the way kimi is named would be the misleading answer here.
   *
   * Asserted because the two agents that do not report and the one that does are
   * indistinguishable from this function's shape — every one of them takes the
   * `else`, and only kimi's is a decision.
   */
  check("codex is in it because it does report, not by default", contextHint("codex"), "the agent has not reported this");
  check("a comfortable window is not a warning", [pieTone(0), pieTone(74)], ["ok", "ok"]);
  check("three quarters is where it starts warning", pieTone(75), "warn");
  check(
    "ninety is where it stops warning and starts shouting",
    [pieTone(89), pieTone(90)],
    ["warn", "critical"],
  );
  check("and full is the loudest it gets", pieTone(100), "critical");
}

/* ------------------------------------------------------------------ *
 * Where "Default" gets its meaning back
 * ------------------------------------------------------------------ */

process.stdout.write("\nconfig prose, recovered from the transcript\n");
{
  /*
   * `snapshotConfig` in `registry.ts` nulls every description before a snapshot
   * goes out — a model list with prose is the large part of a record returned for
   * sixty sessions every four seconds. Its comment ends "The descriptions are
   * still in the transcript for anything that wants them", and this is that thing.
   *
   * It matters because both agents publish a choice named `Default`, which alone
   * says nothing. It is a real value, not a placeholder, so it must not be deleted
   * — what it needs is the description that says which model it resolves to.
   */
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

  // Several `agent_config` events accumulate as a session switches model; only the
  // newest describes what is on offer now.
  const newest = configProse([
    configEvent("default", "stale"),
    { ...configEvent("default", "current"), seq: 2 },
  ] as never);
  check("the newest event wins", newest.get("model")?.choices.get("default"), "current");

  // Paged out of the window, or truncated by the per-event cap. Degrade to no
  // description — never to a guess, and never to an exception.
  check("an empty transcript yields nothing rather than throwing", configProse([]).size, 0);
  check("and a transcript with no config event is the same", configProse([{ seq: 1, ts: 0, event: { type: "prompt", text: "hi" } }] as never).size, 0);
}

/* ------------------------------------------------------------------ *
 * What a control's chip actually says
 * ------------------------------------------------------------------ */

process.stdout.write("\nchip labels\n");
{
  /*
   * The literal payloads claude 0.63.0 publishes, copied from a live session.
   *
   * The complaint this answers is "the model says Default and that tells me
   * nothing" — and it is correct: on a session that has never picked a model, the
   * choice's *name* is `Default (recommended)` and only its description says which
   * model that is. The daemon keeps the selected choice's description on the
   * snapshot for exactly this, and the head of it is the concrete answer.
   */
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
  // The context length is dropped: it is a property of the *choice*, spelled out
  // in the menu row and its description, and on a chip it is three words competing
  // with the one that matters.
  check("a default model names the model, not the word Default", chipValue(modelDefault), "Opus 5");

  const modelPicked = opt({
    category: "model",
    value: "sonnet",
    choices: [{ value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", group: null }],
  });
  check("and a picked one names it too", chipValue(modelPicked), "Sonnet 5");

  /*
   * ⭐ The chip reads the **drawn** list, so it says what its own menu row says.
   * opencode writes the provider into every one of 362 model names; the chip has
   * room for about eleven characters, and it spent all of them on `OpenRouter…`
   * while the row one tap below said which model it was.
   */
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
  /*
   * ⚠ **And the shortening is off where two providers are in one list**, which the
   * chip is the loudest place to see: with nothing to put the removed word back
   * into, a chip reading `Big Pickle` beside 356 OpenRouter models would name a row
   * from a catalogue nobody chose. `narrowToSystem` keeps a session out of this
   * state; the chip does not rely on it having.
   */
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

  // Narrowed to `model` deliberately: for mode the name is the good label and the
  // description is a sentence. Applying the rule everywhere makes every other chip
  // worse in order to fix one.
  const mode = opt({
    category: "mode",
    value: "acceptEdits",
    choices: [{ value: "acceptEdits", name: "Accept Edits", description: "Edits apply without asking", group: null }],
  });
  check("mode keeps its short name over its long sentence", chipValue(mode), "Accept Edits");

  /*
   * A mode named `Default` keeps that name, which is the opposite of what happens
   * to effort's `Default` two checks down — and the difference is whether the
   * agent said anything else about it.
   *
   * Effort has nothing underneath: claude publishes `description: null` for every
   * level, so the name is the only thing there is and it conveys nothing. kimi's
   * mode carries a whole sentence ("Manual approvals; tools execute normally."),
   * so the fix for "Default says nothing" is to show that sentence, not to decide
   * the agent is wrong about the name of its own mode. The caption half is
   * asserted beside `configChoices` in the commands section.
   */
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

  // Claude's effort choices carry no descriptions at all, so nothing can be
  // resolved and nothing is invented — the agent's own name is used.
  const effort = opt({
    category: "thought_level",
    value: "default",
    choices: [{ value: "default", name: "Default", description: null, group: null }],
  });
  /*
   * Not "Default" — established from claude's own CLI rather than guessed, because
   * the ACP payload carries nothing: `/effort`'s parser maps the unset case to
   * `{value: void 0}` (no effort parameter is sent at all) and the model's
   * behaviour with none sent is "Adaptive thinking on by default (omitting
   * `thinking` runs adaptive)". So the value is the model choosing per turn.
   */
  check("claude's default effort is named for what it is", chipValue(effort), "Adaptive");
  // Narrow on purpose. Kimi's equivalent is `off`, which means something else
  // entirely, and a level that was explicitly picked is already concrete.
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

  // Degradation, in the two ways it can happen: an older daemon that strips every
  // description, and a description with no separator that is a whole sentence.
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
  /*
   * **A description with no separator is not mined at all**, however short.
   *
   * The length guard alone let this through and the chip was wrong on a live
   * agent: codex publishes `gpt-5.6-sol` as name "GPT-5.6-Sol" with description
   * "Latest frontier agentic coding model." — 37 characters, under any ceiling
   * anybody would pick — so the chip read "Latest frontier agentic cod…" while the
   * model's actual name sat unused one field away.
   *
   * The rule this restores is the one the function was written for: mining a
   * description is a *rescue* for claude's "Default (recommended)", and an agent
   * whose name is already the model has nothing to rescue. The head before a `·`
   * is a model name because something follows it; with no separator there is no
   * head, only a sentence.
   */
  const codexModel = opt({
    category: "model",
    value: "gpt-5.6-sol",
    choices: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol", description: "Latest frontier agentic coding model.", group: null }],
  });
  check("a short sentence is still a sentence, not a model name", chipValue(codexModel), "GPT-5.6-Sol");
  // And the claude shape it exists for is untouched: separator present, head kept.
  check("while a description that does separate still names the model", chipValue(modelDefault), "Opus 5");
}

/* ------------------------------------------------------------------ *
 * How long a row has been waiting
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe age of a row, across two clocks\n");
{
  /*
   * The timestamps on a snapshot are the *daemon's* clock, and the phone's is a
   * different one — a device that has slept, or has simply never been right, can
   * be minutes out either way. So the age of a row is anchored to the daemon's own
   * clock at fetch time and extended by our own elapsed time since, which is wrong
   * by at most the age of the row rather than by the whole drift.
   *
   * This is asserted rather than looked at because both wrong answers are
   * plausible on screen: a naive `Date.now() - at` reads "waiting for 0s" on a
   * phone that is behind, and a *negative* duration on one that is ahead — under
   * "blocked", which is the row somebody is deciding whether to walk over to.
   */
  const row = { daemonNow: 11_000, fetchedAt: 1_000 } as never;
  // The daemon said 11_000 when our own clock said 1_000, so it is 10s ahead. The
  // permission was raised at daemon-time 9_000, i.e. 2s before the fetch, and we
  // are asking 3s after it.
  check("an age is measured in the daemon's clock and extended in ours", elapsedSince(row, 9_000, 4_000), 5_000);
  check("and does not drift when only our own clock moves on", elapsedSince(row, 9_000, 64_000), 65_000);
  // The failure this shape exists to prevent, stated as the arithmetic somebody
  // would otherwise write.
  report(
    "while subtracting from our own clock would report a negative age",
    4_000 - 9_000 < 0,
    "daemon 10s ahead → -5s waiting",
  );
  check("a row fetched and read at the same instant is as old as the daemon said", elapsedSince(row, 11_000, 1_000), 0);

  /*
   * ⚠ **The other half of that pair — the code that *writes* it — which nothing
   * asserted at all, and that is exactly why the arithmetic above stayed right
   * while three screens drew it wrong.**
   *
   * `onSnapshot` wrote `daemonNow: Date.now(), fetchedAt: Date.now()` under the
   * comment *"a snapshot frame carries no clock, so anchor to ours — it is correct
   * at this instant by construction"*. The first half is true and the conclusion
   * never was: substitute `daemonNow === fetchedAt === T` into `elapsedSince` and
   * `(T - at) + (now - T)` is `now - at`, which is precisely the browser-clock
   * subtraction the two-term form exists to avoid — and `at` is always a *daemon*
   * timestamp (`turnStartedAt`, `raisedAt`). It runs on every socket open, on every
   * rotation, and on every action that folds a returned snapshot in, `/prompt`
   * included, so a drifted phone drew the drift on the one row somebody was
   * watching while the polled rows beside it were right.
   *
   * The pair records an **offset between two clocks, not a moment**, which is what
   * makes carrying it forward correct rather than a stale-data compromise: only a
   * new reading of the daemon's clock — the next poll — can better it.
   *
   * Driven rather than grepped: the row is seeded through the same `internals` cast
   * the socket fixture below uses, because the only other writer of that pair is
   * behind a real daemon and a real `GET /sessions`.
   */
  {
    const { store } = await import("../src/store.js");
    const { keyOf, machineId, sessionId } = await import("../src/ids.js");
    const ref = { machineId: machineId("m_clock"), sessionId: sessionId("s_clock") };
    const key = keyOf(ref);
    const internals = store as unknown as { rows: Map<string, unknown>; transcripts: Map<string, unknown> };
    const arriving = { ...snapshot, id: "s_clock" } as never;

    // The pair a poll left behind: the daemon said 11_000 while this clock said
    // 1_000, i.e. it is 10s ahead — the same two numbers the pure half above uses.
    internals.rows.set(key, { key, ref, machineName: "alpha", snapshot: arriving, daemonNow: 11_000, fetchedAt: 1_000 });
    store.onSnapshot(ref, arriving);
    const after = store.getSnapshot().rowsByKey.get(key);
    check(
      "a snapshot arriving keeps the offset the poll measured, byte for byte",
      [after?.daemonNow, after?.fetchedAt],
      [11_000, 1_000],
    );
    // The consequence, stated as the arithmetic rather than as the fields: re-read
    // to one instant `T`, the offset collapses and this answers `4_000 - 9_000`,
    // i.e. −5_000 — the negative duration the section above exists to prevent, on
    // the row somebody is deciding whether to walk over to.
    check(
      "so the age it produces is still measured in the daemon's clock",
      after === undefined ? null : elapsedSince(after, 9_000, 4_000),
      5_000,
    );
    check("and the snapshot itself is what was folded in", after?.snapshot.id, "s_clock");

    /*
     * ⚠ **And the honest bound, which is the arm that *is* allowed to read our
     * clock.** A session created from this tab reaches here from `POST /sessions`
     * before any list has come back, so there is no reading to keep — both halves
     * fall back to ours, which is the old arithmetic and is wrong by the whole
     * offset, for at most one visible poll. What is asserted is that it is **one**
     * `Date.now()` feeding both: two reads a millisecond apart invent an offset of
     * their own, out of nothing, that no poll is coming to correct.
     */
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
    /*
     * The source half, and it is here because equality above cannot distinguish one
     * `Date.now()` from two taken inside the same millisecond — which is the
     * overwhelmingly likely outcome of the regression, so the call-driven check
     * would pass through it almost every run. This is the weaker form used
     * deliberately, beside the stronger one rather than instead of it.
     */
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

    // The store is a singleton shared with every other block in this file, so the
    // fixture is taken back out: left behind, this is a session on a machine
    // nothing else here has ever heard of, published into every later `getSnapshot`.
    internals.rows.delete(key);
    internals.transcripts.delete(key);
  }
}

/* ------------------------------------------------------------------ *
 * The login poll cursor
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe login transcript cursor\n");
{
  /*
   * The wizard polls `GET /agent-auth/login/:id?since=<cursor>` and appends
   * whatever comes back, so the arithmetic has to hold across a buffer that
   * drops its front. `dropped` is bytes discarded; `cursor` is the total ever
   * produced. A client that appended `chunk` while advancing by `chunk.length`
   * instead of assigning `page.cursor` would silently desynchronize the moment
   * anything was dropped, and a login transcript is exactly where a lost line is
   * the one with the code in it.
   */
  /*
   * A **model** of the daemon's arithmetic, and labelled as one.
   *
   * This used to read as though it guarded the server, which it never could: it
   * is a transcription of `readFrom` in `src/agentauth.ts`, and a transcription
   * stays green when the original is deleted. The daemon side is asserted against
   * the real function in `pnpm daemoncheck`, which can import it — this package
   * cannot, for the same module-resolution reason `wire.ts` is hand-mirrored.
   *
   * What *this* section is for is the client's own rule, which is genuinely
   * client-side: a client must assign `page.cursor` rather than advance by
   * `chunk.length`, or it desynchronizes the moment anything is dropped. The model
   * exists to generate the pages that rule is exercised against.
   */
  const read = (buffer: string, dropped: number, since: number) => {
    const from = Math.max(since, dropped);
    return { chunk: buffer.slice(from - dropped), cursor: dropped + buffer.length, gap: since < dropped };
  };

  check("a fresh read returns everything", read("open https://x", 0, 0).chunk, "open https://x");
  check("and reports the cursor as the total produced", read("open https://x", 0, 0).cursor, 14);
  check("a second read from that cursor returns nothing new", read("open https://x", 0, 14).chunk, "");
  // After the cap trims the front, an old cursor is behind the window.
  check("a cursor behind the discarded prefix is a gap", read("tail", 100, 40).gap, true);
  check("and reads from the start of what is left", read("tail", 100, 40).chunk, "tail");
  check("a cursor inside the window is not a gap", read("tail", 100, 102).gap, false);
  check("and reads only what follows it", read("tail", 100, 102).chunk, "il");
}

/* ------------------------------------------------------------------ *
 * One tool call is five events
 * ------------------------------------------------------------------ */

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
    // Keyed by the last, a streaming message remounts on every arriving token —
    // which shuts any card the reader had opened inside it.
    check("and keyed by its first event, not its last", tail.rows[0]?.key, "t1");
  }

  {
    seq = 0;
    const tail = buildTail([txt("mine", "user"), txt("theirs", "agent")], []);
    check("a change of role starts a new run", tail.rows.map((r) => r.key), ["t1", "t2"]);
  }

  /*
   * An image the tool returned reaches the card — driven from a real event
   * through `buildTail`, not handed straight to `mergeUpdates`.
   *
   * That distinction is the whole point of this case. `mergeUpdates` was asserted
   * and passed while nothing rendered, because `buildTail` **rebuilds** each
   * update field by field and simply did not name `images` — so the merge was
   * correct about a record that never carried the data. A test that starts below
   * the construction site cannot see a construction site that drops a field.
   */
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
    // An older daemon sends no such field and dropped the bytes entirely. It must
    // read as "no images", never as undefined reaching the renderer.
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
    /*
     * A thought is dropped outright — see `showsInTranscript`. It used to draw a
     * collapsed `thinking …` card, several per turn, between the messages
     * somebody is actually reading; what it was there to say is the one
     * `working…` row at the foot of the transcript.
     */
    seq = 0;
    const tail = buildTail([txt("thinking", "agent", true), txt("saying", "agent", false)], []);
    check("a thought draws nothing at all", tail.rows.map((r) => r.key), ["t2"]);
    // Optional, unlike most of the `rows[0]` reads in this file, because the
    // regression the line above exists to catch is exactly the one that empties
    // `rows` — and a throw here would take the four new sections below it with
    // it, which is the crash-truncation failure CLAUDE.md records at length.
    check("and the speech beside it is untouched", (tail.rows[0] as { text?: string } | undefined)?.text, "saying");
  }

  {
    /*
     * The reason a dropped thought still *flushes* the run. Parts are joined with
     * no separator, so merging the speech either side of it would produce
     * "before.after" — a sentence run into the next one, which is worse than the
     * card that was removed.
     */
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
    /*
     * The order *inside* a run, which is a `push` and one `reverse()` in `flush`
     * rather than an `unshift` per chunk.
     *
     * That is a performance change with a correctness edge: the walk is
     * backwards, so deleting the `reverse()` renders every agent message
     * backwards — silently, and looking exactly like something the agent said.
     * Nothing about the row count or the keys moves, so the assertions above
     * would all stay green.
     *
     * Four chunks rather than two, because a two-chunk run reversed is still a
     * two-chunk run and only the text tells them apart; and then the same claim
     * on *each side of a dropped thought*, because that is the one path where a
     * run is flushed mid-walk and the surviving fixture had a single chunk on
     * either side — which cannot see an ordering at all.
     */
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
    // And a dropped thought draws nothing at all, which is the same claim the
    // suppressed events make one section down.
    seq = 0;
    const tail = buildTail([txt("t1", "agent", true), txt("t2", "agent", true), txt("a"), txt("b", "user")], []);
    check("a thought draws no row", tail.rows.map((r) => r.key), ["t3", "t4"]);
  }

  /*
   * The cut, which is what a render budget used to be.
   *
   * `buildTail`'s third argument was "how many nodes to draw" and is now "the
   * lowest seq to draw" — the seq of the newest `context_cleared`, because the
   * only boundary in a transcript that means anything to a reader is the one the
   * agent was told to make. Everything at or above it is drawn, however much
   * there is.
   *
   * These cases carry over from the budget with the numbers reinterpreted, and
   * they are worth keeping *because* they carry over: `hidden` counting events
   * rather than rows is the same claim under either rule, and it is the one that
   * decides whether the button's number matches what a tap reveals.
   */
  {
    seq = 0;
    const tail = buildTail([txt("a"), txt("b"), txt("c")], [], 2);
    // A run is built from the events at or above the cut and no others. It cannot
    // straddle the boundary in practice — the `context_cleared` marker sitting on
    // it is not text, so it flushes the run — but a cut landing mid-run must still
    // produce a whole run from what survives rather than an empty one.
    check("a run is built from everything at or above the cut", (tail.rows[0] as { text: string }).text, "bc");
    check("and what is below it is counted", tail.hidden, 1);
  }

  {
    seq = 0;
    const tail = buildTail([call("a"), call("b"), call("c")], [], 2);
    check("only what is at or above the cut is drawn", drawn(tail.rows), ["e2", "e3"]);

    // Three text events below the cut would coalesce to *one* row, so this is the
    // fixture that can tell the two definitions apart — the tool-call one above
    // cannot, since there one excluded event is also exactly one row.
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
    // One below the cut belongs to the conversation that was cleared; reporting a
    // hole in a transcript nobody is being shown is noise about something that is
    // not on screen.
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
  // The table in CLAUDE.md's gotchas, which nothing asserted until `tail.ts`
  // existed to be asserted. Measured 2026-07-31 against claude 0.63.0: a single
  // `echo` produces a call plus four updates, and every field a person wants is
  // on a different one of them.
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

  // Keeping only the newest update loses the command *and* the description.
  check("the update's title beats the call's", drawn.title, "echo hi-there");
  // Preferring the call's own arguments gets `{}` for ever, because an empty
  // object is not null.
  check("and a later update's arguments beat an empty call's", drawn.rawInput, {
    command: "echo hi-there",
    description: "Echo",
  });
  // Keeping only the first update loses the output. "Every content block" is no
  // longer the rule — a block that is a draft of the next, or the arguments
  // restated, is dropped; see the streaming case below. What survives is every
  // block that says something of its own, in document order.
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

  /*
   * ⭐ **An agent that refines its arguments rather than filling them in once.**
   *
   * Measured 2026-08-13, from the daemon's own log — codex's web search, verbatim.
   * The `tool_call` arrives with the shape below: four keys, so `hasInput` is
   * true, so the old rule ("the call wins whenever it has anything") kept it and
   * threw away the update that put the query *in* it. The card drew `"query": ""`
   * under a title reading `Web search: red mullet…` — because `title` is
   * newest-wins one line above and the arguments were not.
   *
   * The empty-call case above still has to hold at the same time: claude sends
   * `{}` there, so a plain `??` picks the empty object and no command ever
   * appears. Both directions, or this is a fix that swaps which agent is broken.
   */
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
  // The pair that was visibly inconsistent on screen: same record, same rule.
  check("so the arguments and the title agree", refined.title, "Web search: red mullet");

  /*
   * ⭐ **And then it opened to the string it was already showing.**
   *
   * `query` is in `COMMAND_FIELDS`, so `toolSummary` answers the *same string* as
   * both `summary` and `detail` — which is true of every tool whose arguments
   * yield a command, not of web search in particular. That call carries no content
   * block at all, no locations and no children, so `detail !== null` was the only
   * thing making it openable, and what it opened to was the 66 characters the row
   * had already drawn in full. Worse than nothing: the agent's `title` lists all
   * three of its queries, while `rawInput.query` is codex's own truncated copy of
   * the first, so the body said strictly less than the heading.
   *
   * The clip is what keeps the useful case, and it is a number this file owns
   * rather than a CSS ellipsis nothing can ask about.
   */
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
  // The same shape, past the clip: the row shows 120 characters and the body has
  // more to give, so the disclosure is worth having.
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
    // Output, locations and children are each a reason on their own, whatever the
    // arguments say — this is the arm that keeps a finished `Bash` openable.
    opensToAnything({ detail: shortQuery, headline: shortQuery, outputBlocks: 1, locations: 0, children: 0, changes: 0, titleClipped: false }),
    opensToAnything({ detail: shortQuery, headline: shortQuery, outputBlocks: 0, locations: 1, children: 0, changes: 0, titleClipped: false }),
    opensToAnything({ detail: shortQuery, headline: shortQuery, outputBlocks: 0, locations: 0, children: 1, changes: 0, titleClipped: false }),
  ], [true, true, true, true]);
  /*
   * ⭐ **And a `Write` opens on its change alone, which is the term that had to be
   * added rather than inferred.**
   *
   * `readInput` suppresses the pretty-printed arguments the moment it finds a body
   * field — `content`, `new_string`, `text` — so for the two tools that actually
   * change a file, `detail` is `null`. With no locations either, every other term
   * here is zero, so the card whose whole point is the file it just wrote was the
   * one card in the transcript that could not be opened, and the diff had nowhere
   * to go.
   */
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
  /*
   * ⭐ **The same rule the body has to ask, which is why it is a function.**
   *
   * A card openable for its *output* still drew the arguments underneath a row that
   * was already showing them — one command, twice, one line apart. Invisible while a
   * card had a frame around both; obvious the moment it did not. So the chevron and
   * the block ask one predicate rather than two expressions that agreed by accident.
   */
  /*
   * ⭐ **Web search opens again, and the term that brings it back is the title.**
   *
   * Its title is the list of queries codex ran — measured at ~100 characters — while
   * `rawInput.query` is codex's truncated copy of the *first* one. So every other term
   * was zero and the card correctly refused to open, onto a body that would have said
   * less than the row. Clipping the title in **code** rather than in CSS is what makes
   * "was anything cut off" answerable at all, which is the same reason `SUMMARY_CHARS`
   * lives in `tail.ts`; the body then opens to the whole of it.
   */
  const queries =
    "Web search: red mullet fish Mullus barbatus description distribution feeding, Mullus barbatus FAO species fact sheet, red mullet Black Sea official source";
  check("a title too long for its row is clipped, and says so", [
    clipTitle(queries).clipped,
    clipTitle(queries).text.length,
    clipTitle("Bash").clipped,
    clipTitle("Bash").text,
  ], [true, TITLE_CHARS + 1, false, "Bash"]);
  /*
   * **A flat threshold was wrong and the log is what said so.** Every drawn title in
   * the database: median 41, max 161, tail 82 · 82 · 87 · 148 · 161. Clipping at 80
   * alone cut three of them by 2 to 7 characters — a whole extra line to reveal a word
   * — so the cut has to be worth the line, and `TITLE_OVERFLOW_MIN` is what makes it
   * fire on the two real payloads and none of the near misses.
   */
  check("a near miss is left whole rather than costing a line", [
    clipTitle("x".repeat(TITLE_CHARS + 1)).clipped,
    clipTitle("x".repeat(TITLE_CHARS + TITLE_OVERFLOW_MIN)).clipped,
    clipTitle("x".repeat(TITLE_CHARS + TITLE_OVERFLOW_MIN + 1)).clipped,
  ], [false, false, true]);

  /*
   * ⭐ **The value beside the title, and the three shapes in which it is an echo.**
   *
   * Exact equality was the rule, from codex naming a `Bash` call after its command. The
   * log has two more where the strings differ and the second copy is still worth
   * nothing: a `Read file '<path>'` beside the bare path, and a web search beside
   * codex's **truncated** copy of its first query — which carries a literal ` ...`, so a
   * containment test on the whole string fails. Hence a prefix.
   *
   * The strings below keep the shape of the ones measured in `~/.reemoat/reemoat.db`,
   * with the home directory genericised: what matters is that the title wraps the
   * path in `Read file '…'` rather than which path it was.
   */
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

  // Measured 2026-08-01: 4/10 and 5/14 of a child's updates omit the parent even
  // though its call carried one. Read as "top level", half of every subagent's
  // steps scatter back into the transcript, intermittently.
  check(
    "an update that omits the parent does not erase one that named it",
    mergeUpdates([
      upd({ ts: 1, parentToolCallId: "toolu_parent" }),
      upd({ ts: 2, parentToolCallId: null }),
    ]).parentToolCallId,
    "toolu_parent",
  );

  /*
   * ⭐ **The model types its arguments into the output channel, one token at a
   * time, and "every content block concatenated" drew all of them.**
   *
   * Measured against the daemon's own database on 2026-08-13. One `Write` call:
   * a `tool_call`, then **715 updates** whose single content block grew from `{`
   * to the finished input JSON, then the same JSON once more beside the
   * `rawInput` it belongs to, then the one line that is actually a result. The
   * card drew 717 blocks. Across every session on that machine those superseded
   * blocks are 15.4% of all events and **55.8% of all bytes**, and folding every
   * call in the database through this function takes 2332 content blocks to 68.
   *
   * The shape below is that call, shortened. Both rules are needed and they catch
   * different things: `supersedes` cannot see the compact restatement (it is not
   * an extension of the pretty-printed one), and `restatesInput` cannot run
   * inside the fold (the pretty-printed copy arrives *before* the `rawInput` it
   * restates).
   */
  const streamed = mergeUpdates([
    upd({ ts: 1, content: ["{"] }),
    upd({ ts: 2, content: ['{"path": "a.py"'] }),
    upd({ ts: 3, content: ['{"path": "a.py", "content": "x"}'] }),
    upd({ ts: 4, title: "Writing a.py", rawInput: { path: "a.py", content: "x" }, content: ['{"path":"a.py","content":"x"}'] }),
    upd({ ts: 5, status: "completed", content: ["Wrote 1 byte to a.py"] }),
  ]);
  check("a streamed call draws its result and nothing else", streamed.content, ["Wrote 1 byte to a.py"]);
  check("and still knows what it was called with", streamed.rawInput, { path: "a.py", content: "x" });

  /*
   * The two rules, each on its own, because the failure of either is invisible in
   * the composite above — it would simply draw one extra copy of the arguments.
   */
  check("a block that extends the last supersedes it", supersedes('{"a": 1', "{"), true);
  check("one that merely repeats it does not", supersedes("{", "{"), false);
  check("nor does an unrelated one", supersedes("Wrote 1 byte", "{"), false);
  /*
   * A **strict** extension only. A tool that prints the same line twice has
   * printed it twice, and collapsing that would be this client editing output
   * rather than declining to draw a draft of it.
   */
  check("so an exact repeat is left standing", mergeUpdates([
    upd({ ts: 1, content: ["same"] }),
    upd({ ts: 2, content: ["same"] }),
  ]).content, ["same", "same"]);

  check("the arguments, compact, are not a result", restatesInput('{"a":1}', { a: 1 }), true);
  // The one the byte test misses, and the reason this parses rather than compares.
  check("nor are they pretty-printed", restatesInput('{"a": 1}', { a: 1 }), true);
  check("a different object is a result", restatesInput('{"a":2}', { a: 1 }), false);
  check("and so is anything that is not JSON", restatesInput("Wrote 1 byte to a.py", { a: 1 }), false);
  /*
   * The guard that keeps `JSON.parse` off every tool result ever produced:
   * `buildTail` re-folds every call on every streamed event, so a block that does
   * not even begin the way the serialization begins must cost nothing.
   */
  check("a call with no arguments restates nothing", restatesInput("{}", null), false);
}
