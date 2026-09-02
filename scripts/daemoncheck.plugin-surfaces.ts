import { check, report } from "./daemoncheck.env.js";

process.stdout.write("\nwhat a plugin returns, and what is forwarded\n");
{
  const { clampView, fitView, noteClamp, PLUGIN_BLOCK_TYPES, PLUGIN_SETTINGS_BLOCK_TYPES, PLUGIN_VIEW_LIMITS } =
    await import("../src/plugins/protocol.js");
  const { MAX_PLUGIN_MESSAGE_BYTES } = await import("../src/plugins/runtime.js");

  /*
   * The whole record, field for field, rather than a spot check — which is why
   * adding `unknownBlocks` failed here first. That is the assertion working: a new
   * field on this type is a new thing every caller of `clampView` now receives,
   * and it should not arrive without one line somewhere saying what it is on the
   * quietest possible input.
   */
  check("nothing at all is an empty view rather than a throw", clampView(null), {
    view: { title: null, refreshMs: null, blocks: [] },
    clamped: false,
    substituted: false,
    unknownBlocks: [],
  });
  check("a block this daemon does not draw is dropped", clampView({ blocks: [{ type: "canvas" }] }).view.blocks, []);
  /*
   * ⚠ **Reported as a *shape* problem, never as a size one — and this assertion
   * used to pin the wrong one of the two.**
   *
   * It read `.clamped === true`, which was written when there was a single flag
   * and never revisited when it became two. So the one check covering this line
   * asserted the same misunderstanding the code had, and the pair passed together
   * for a release.
   *
   * What it cost, measured: a real plugin returned a one-row list and a block type
   * its author had invented. Nothing exceeded any ceiling — and the screen said
   * *"some of what this plugin returned was too large to show"*, which sends
   * somebody to count rows and measure bytes when the answer is a list of five
   * type names. The invented block itself rendered as nothing and said nothing.
   *
   * Both halves are asserted, because "it is reported" is what the old line said
   * and is exactly what stayed true while being useless.
   */
  const invented = clampView({ blocks: [{ type: "canvas" }] });
  check("and dropping one is reported as a shape it does not know", invented.substituted, true);
  check("and never as something that was too large", invented.clamped, false);
  const drawn = noteClamp(invented).blocks.filter((block) => block.type === "notice");
  check(
    "so the notice a person reads names the protocol rather than the bounds",
    drawn.map((block) => (block as { text: string }).text.includes("too large")),
    [false],
  );
  /*
   * ⚠ **And it names the type, and the five that exist.** A notice that says only
   * *not a shape this machine recognises* is true and leaves an author with the
   * whole protocol to search — and an author has no copy of it, so the only way
   * left to find the cause is to obtain this repository and run `clampView` over
   * the payload by hand. That is what actually happened.
   */
  check(
    "and it names the type nobody here knows",
    drawn.map((block) => (block as { text: string }).text.includes('"canvas"')),
    [true],
  );
  check(
    "and the ones it does",
    PLUGIN_BLOCK_TYPES.every((type) => (drawn[0] as { text: string }).text.includes(type)),
    true,
  );
  /*
   * The name comes from the plugin and is repeated to a person, so it is bounded
   * on both axes: clipped for length, deduplicated, and capped in number. A
   * broken plugin can invent a different type in every one of its blocks, and
   * twenty-four names is the wall of text the notice replaced.
   */
  const many = clampView({
    blocks: [
      { type: "a".repeat(400) },
      { type: "b" },
      { type: "b" },
      { type: "c" },
      { type: "d" },
      { type: "" },
    ],
  });
  check("a long invented type is clipped before it is repeated back", (many.unknownBlocks[0] ?? "").length <= 40, true);
  check("repeats of one type are named once", many.unknownBlocks.includes("b"), true);
  check("and the list stops rather than growing with the plugin", many.unknownBlocks.length <= 3, true);
  check("every one of those blocks was still dropped", many.view.blocks, []);
  /*
   * A block with no `type` at all is the same shape problem and must not become an
   * empty pair of quotes in a sentence somebody reads.
   */
  const nameless = clampView({ blocks: [{ notype: true }] });
  check("a block with no type says so rather than naming nothing", nameless.unknownBlocks, ["(no type)"]);
  /*
   * The other direction, so the two are pinned as opposites rather than one at a
   * time: a list past its ceiling is a size clamp and says nothing about shape.
   */
  const overRows = clampView({ blocks: [{ type: "list", rows: new Array(PLUGIN_VIEW_LIMITS.rows + 1).fill({ id: "r" }) }] });
  check("a list past its ceiling is the other flag", [overRows.clamped, overRows.substituted], [true, false]);

  const rows = Array.from({ length: PLUGIN_VIEW_LIMITS.rows + 10 }, (_, index) => ({ id: String(index), title: "x" }));
  const big = clampView({ blocks: [{ type: "list", rows, empty: "" }] });
  const first = big.view.blocks[0];
  report(
    "a list past the row bound is cut rather than refused",
    first?.type === "list" && first.rows.length === PLUGIN_VIEW_LIMITS.rows,
    `${first?.type === "list" ? first.rows.length : -1} of ${rows.length} forwarded`,
  );
  check("and the cut is reported so the screen can say so", big.clamped, true);

  const long = clampView({ blocks: [{ type: "text", text: "x".repeat(PLUGIN_VIEW_LIMITS.text + 50), tone: "muted" }] });
  const text = long.view.blocks[0];
  report(
    "an oversized string is clipped",
    text?.type === "text" && text.text.length === PLUGIN_VIEW_LIMITS.text,
    `${text?.type === "text" ? text.text.length : -1} chars`,
  );
  check("and that is reported too", long.clamped, true);

  /*
   * A tone this daemon does not know falls to the ordinary one, which is the safe
   * direction: a plugin cannot make a destructive control look harmless by
   * misspelling the word, only fail to make an ordinary one look dangerous.
   */
  const toned = clampView({ blocks: [{ type: "notice", text: "hi", tone: "catastrophic" }] });
  check("an unknown tone is the ordinary one", toned.view.blocks[0], { type: "notice", text: "hi", tone: "default" });

  const field = clampView({
    blocks: [{ type: "form", submit: "Go", action: "save", fields: [{ key: "k", label: "L", kind: "quantum" }] }],
  });
  const form = field.view.blocks[0];
  check(
    "an unknown field kind becomes a text input rather than nothing",
    form?.type === "form" ? form.fields[0]?.kind : null,
    "text",
  );

  /* ---------------------------------------------------------------- *
   * ...and the bound that was enforced on the wrong side of the wire.
   *
   * ⚠ **`PLUGIN_VIEW_LIMITS` could never do its job, because `clampView` ran in
   * the host — one hop after the child had already refused to send.** The two
   * bounds sit two lines apart in the author's guide as though both applied, and
   * only `MAX_PLUGIN_MESSAGE_BYTES` ever fired: a view inside every documented
   * limit came back as "this plugin returned more than can be sent", and the
   * clamp that exists to cut it never saw it.
   *
   * Measured 2026-08-23 against a real forked child, the reference plugin and a
   * real store: its board fits at 903 cards and not at 904, while the store lets
   * a plugin keep 1000 and the session prune never removes them. `fitView` runs
   * in the child now, so the count bound applies first and a byte bound finishes
   * the job — and rows are the lever because they are the only dimension a
   * plugin's data grows without limit.
   * ---------------------------------------------------------------- */
  {
    const budget = MAX_PLUGIN_MESSAGE_BYTES - 1024;
    const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
    const rowsOf = (n: number): unknown[] =>
      Array.from({ length: n }, (_, i) => ({ id: `s_${i}`, title: "an ordinary session title", subtitle: "claude" }));

    const small = fitView({ title: "T", blocks: [{ type: "list", rows: rowsOf(10), empty: "" }] }, budget);
    check("a view that already fits is passed through untouched", small.clamped, false);

    // The board's own shape: three columns, more cards than a column may hold.
    const board = fitView(
      { title: "Board", blocks: [{ type: "columns", columns: [0, 1, 2].map(() => ({ title: "c", rows: rowsOf(400) })) }] },
      budget,
    );
    const cols = board.view.blocks[0];
    check(
      "a column past the row bound is cut to it, and says so",
      [cols?.type === "columns" ? cols.columns.map((one) => one.rows.length) : null, board.clamped],
      [[PLUGIN_VIEW_LIMITS.rows, PLUGIN_VIEW_LIMITS.rows, PLUGIN_VIEW_LIMITS.rows], true],
    );

    /*
     * A view at every documented ceiling — which the counts alone do **not** make
     * fit, and which is the half a smaller `PLUGIN_VIEW_LIMITS` could not have
     * fixed without making the honest cases smaller too.
     */
    const worst = {
      title: "W",
      blocks: Array.from({ length: PLUGIN_VIEW_LIMITS.blocks }, () => ({
        type: "columns",
        columns: Array.from({ length: PLUGIN_VIEW_LIMITS.columns }, () => ({ title: "c", rows: rowsOf(PLUGIN_VIEW_LIMITS.rows) })),
      })),
    };
    report("every count at its ceiling is still too large for the channel", bytesOf(clampView(worst).view) > budget, `${bytesOf(clampView(worst).view)} bytes clamped by counts alone`);
    const fitted = noteClamp(fitView(worst, budget));
    report("but it is cut until it fits rather than refused", bytesOf(fitted) <= budget, `${bytesOf(fitted)} bytes`);
    report(
      "and the cut is said rather than swallowed",
      JSON.stringify(fitted).includes("too large to show"),
      "the notice rides the view",
    );

    /*
     * The tail of the halving, at budgets no real channel has. It keeps the
     * largest cap that fits rather than the first that is small — one row at 200
     * bytes, none at 120 — and at a budget below even the empty block it drops the
     * block itself.
     *
     * ⚠ **This last case used to end in `post`'s refusal, and that was the bug
     * rather than the design.** `fitView` halved rows and returned whatever it had
     * when the cap reached zero, fitting or not — so "cut until it fits" held only
     * for views whose bulk was rows. A form has none: one form block at the
     * published ceilings (40 fields × 40 options × a 200-character label) is
     * 534,576 bytes with `rowsIn` reading 0, so the loop never ran and an
     * oversized view went out flagged as clamped. The reduction is total now —
     * rows, then whole blocks, then the title alone — so the post-condition is
     * real and `post`'s refusal is no longer anybody's fallback.
     */
    const tight = fitView({ blocks: [{ type: "list", rows: rowsOf(PLUGIN_VIEW_LIMITS.rows), empty: "" }] }, 200);
    const kept = tight.view.blocks[0];
    check(
      "the cut keeps as many rows as the budget allows, not as few",
      [kept?.type === "list" ? kept.rows.length : -1, bytesOf(tight.view) <= 200, tight.clamped],
      [1, true, true],
    );
    const airless = fitView({ blocks: [{ type: "list", rows: rowsOf(PLUGIN_VIEW_LIMITS.rows), empty: "" }] }, 50);
    check(
      "and a budget that not even an empty block fits drops the block and still fits",
      [airless.view.blocks.length, bytesOf(airless.view) <= 50, airless.clamped],
      [0, true, true],
    );

    /*
     * ⚠ **The shape that had no lever at all, and the reason the reduction had to
     * become total.** Every count here is at its published ceiling and `rowsIn` is
     * 0, so the halving above is a no-op — this is the case that went out
     * oversized, was refused by the child's own `post`, and left a settings pane
     * inside every documented limit permanently undrawable.
     */
    const formOnly = {
      title: "F",
      blocks: [
        {
          type: "form",
          id: "cfg",
          submit: "Save",
          fields: Array.from({ length: PLUGIN_VIEW_LIMITS.fields }, (_, f) => ({
            id: `f${f}`,
            kind: "select",
            label: "x".repeat(PLUGIN_VIEW_LIMITS.short),
            help: "h".repeat(PLUGIN_VIEW_LIMITS.text),
            options: Array.from({ length: PLUGIN_VIEW_LIMITS.options }, (_, o) => ({
              value: `v${o}`,
              label: "y".repeat(PLUGIN_VIEW_LIMITS.short),
            })),
          })),
        },
      ],
    };
    const formRaw = clampView(formOnly, "settings").view;
    report(
      "a form at every ceiling is past the channel with no row to cut",
      bytesOf(formRaw) > budget,
      `${bytesOf(formRaw)} bytes, and not one of them a row`,
    );
    const formFit = fitView(formOnly, budget, "settings");
    report("but it is cut until it fits rather than sent and refused", bytesOf(formFit.view) <= budget, `${bytesOf(formFit.view)} bytes`);

    /*
     * The other half, and the one a false `clamped` costs: a view that needed no
     * cutting must not be described as cut. `fitView` reported every view reaching
     * its second pass as clamped, including the ones the pass changed by nothing —
     * so a complete form drew a "this was shortened" line and sent its author to
     * count rows that were never touched.
     */
    check(
      "and a view that fits is not described as cut",
      fitView({ title: "S", blocks: [{ type: "text", text: "small" }] }, budget).clamped,
      false,
    );
  }

  check("a view that is already fine is not reported as clamped", clampView({ title: "T", blocks: [] }).clamped, false);

  /*
   * ⚠ **A substitution is a clamp, and used to be the one kind nobody was told
   * about.** `plugins.ts`'s fail-open rule is right and stays — an unknown field
   * kind becomes a text input and still round-trips, nothing throws. What it did
   * not do is *say so*, and that is worse for a substitution than for a
   * truncation: a cut list is visibly short, while a form whose fields all lost
   * their `key` renders perfectly, submits nothing, and looks like it works.
   *
   * Every case below is one a real plugin shipped to the market with, and it
   * survived two releases: fields sending `id` where `clampField` reads `key`,
   * `submit` sent where the action identifier belongs, and `kind: "string"` /
   * `"boolean"` — neither of which is in the enum. The plugin's own driver was
   * green throughout, because it asserted the author's misunderstanding
   * (`form.submit === "save"`) rather than the protocol.
   */
  const shipped = clampView({
    blocks: [
      {
        type: "form",
        submit: "save",
        fields: [
          { id: "apiKey", kind: "string", label: "Anthropic API key", value: "" },
          { id: "rename", kind: "boolean", label: "Rename new sessions", value: "true" },
        ],
      },
    ],
  });
  check(
    "a form that shipped broken is reported as substituted rather than silently drawn",
    [shipped.substituted, shipped.clamped],
    [true, false],
  );
  /*
   * The two halves of the flag are independent facts and are asserted apart,
   * because they send an author to two different places: "too large" means look
   * at the bounds, "not a shape this daemon knows" means look at the protocol.
   */
  const keyless = clampView({ blocks: [{ type: "form", action: "save", fields: [{ label: "A" }] }] });
  check("a field with no key cannot round-trip, and says so", keyless.substituted, true);
  const actionless = clampView({ blocks: [{ type: "form", submit: "Save", fields: [{ key: "a", label: "A" }] }] });
  check("a form with no action submits nowhere, and says so", actionless.substituted, true);
  const unknownKind = clampView({
    blocks: [{ type: "form", action: "save", fields: [{ key: "a", label: "A", kind: "string" }] }],
  });
  check("a kind this daemon does not know is a substitution", unknownKind.substituted, true);
  /*
   * ⚠ **Absence is a default, not a substitution.** Omitting `kind` means "an
   * ordinary text field" and is a perfectly good thing for a plugin to do — if
   * that raised the flag, every well-formed plugin in the world would draw a
   * notice saying it was broken, and the notice would stop meaning anything.
   */
  const plain = clampView({
    blocks: [{ type: "form", action: "save", fields: [{ key: "a", label: "A" }] }],
  });
  check("but omitting kind entirely is a default rather than a substitution", plain.substituted, false);
  /*
   * ⚠ **And `null` spelled out is the same default, which the line above does not
   * cover.** The guard is `kind !== undefined && kind !== null` — two spellings of
   * absence — and only one of them was driven. Delete the `!== null` half and this
   * file stays green while **every plugin that serialises a missing field as
   * `null`** starts drawing "not in a shape this machine recognises" on a form
   * that is perfectly fine.
   *
   * It is not the unlikely spelling, either. This crosses as JSON, which has no
   * `undefined` at all: an author writing `kind: config.kind ?? null`, or reading
   * a row out of a database, sends `null` and cannot send anything else. The half
   * that was covered is the one that only arises from leaving the key out.
   *
   * Found by the author of a plugin who had just been bitten by the mirror of it —
   * `store.get` answering `null` where they expected `undefined` — and then again
   * by their own driver, where a parameter with a default value made passing
   * `undefined` impossible and silently ran the `null` case twice. Three of one
   * shape in a day: the spelling of absence is not a detail.
   */
  const nulled = clampView({
    blocks: [{ type: "form", action: "save", fields: [{ key: "a", label: "A", kind: null }] }],
  });
  check("and neither is null spelled out", nulled.substituted, false);
  /*
   * The other half of the pair: not raising the flag is only right if the field
   * came out as a text input. A `clampField` that dropped the field entirely would
   * pass the two lines above and lose the control off the form.
   */
  const kindOf = (view: typeof plain.view): unknown => {
    const block = view.blocks[0];
    return block !== undefined && block.type === "form" ? block.fields[0]?.kind : "<not a form>";
  };
  check("both spellings still give an ordinary text field", [kindOf(plain.view), kindOf(nulled.view)], ["text", "text"]);

  /*
   * And the notice itself: two facts, two lines, both where both happened —
   * `noteClamp` is the half a person actually reads, and the half the author
   * sees by opening their own plugin.
   */
  const noticed = noteClamp(shipped);
  const lines = noticed.blocks.filter((one) => one.type === "notice").length;
  check("the substitution is said out loud rather than swallowed", lines, 1);
  check(
    "and it names the consequence rather than the size",
    noticed.blocks.some((one) => one.type === "notice" && one.text.includes("will not work")),
    true,
  );
  const both = noteClamp({ view: shipped.view, clamped: true, substituted: true, unknownBlocks: [] });
  check(
    "both facts get their own line, because they have different remedies",
    both.blocks.filter((one) => one.type === "notice").length,
    2,
  );

  /* ---------------------------------------------------------------- *
   * What v2 added.
   * ---------------------------------------------------------------- */
  const { PLUGIN_REFRESH_MIN_MS, PLUGIN_REFRESH_MAX_MS } = await import("../src/plugins/protocol.js");

  check(
    "a refresh interval is floored and capped rather than refused",
    [
      clampView({ refreshMs: 10, blocks: [] }).view.refreshMs,
      clampView({ refreshMs: 5_000, blocks: [] }).view.refreshMs,
      clampView({ refreshMs: 999_999_999, blocks: [] }).view.refreshMs,
      clampView({ refreshMs: 0, blocks: [] }).view.refreshMs,
      clampView({ refreshMs: -1, blocks: [] }).view.refreshMs,
      clampView({ refreshMs: "soon", blocks: [] }).view.refreshMs,
      clampView({ blocks: [] }).view.refreshMs,
    ],
    [PLUGIN_REFRESH_MIN_MS, 5_000, PLUGIN_REFRESH_MAX_MS, null, null, null, null],
  );
  /*
   * Clamped **silently**, unlike a cut list. The difference is what anybody could
   * do about it: a shortened list is a wrong number on screen, while an interval
   * moved from 500ms to 2000ms is invisible to everyone and actionable by nobody.
   */
  check("and moving one is not reported as a clamp", clampView({ refreshMs: 10, blocks: [] }).clamped, false);

  /*
   * ⚠ **The field a plugin would most like to put a URL in.** Anything that is
   * not one of this app's own two destinations becomes a row that does not go
   * anywhere — a URL above all, in either shape somebody would try it.
   */
  const opened = clampView({
    blocks: [
      {
        type: "list",
        empty: "",
        rows: [
          { id: "a", open: { session: "s_1" } },
          { id: "b", open: { screen: true } },
          { id: "c", open: { url: "https://evil.example" } },
          { id: "d", open: "https://evil.example" },
          { id: "e", open: { session: "" } },
          { id: "f", open: { screen: false } },
          { id: "g", open: { session: "s_2", url: "https://evil.example" } },
          { id: "h" },
        ],
      },
    ],
  });
  const openedRows = opened.view.blocks[0];
  check(
    "only a session on this machine or the plugin's own screen survives",
    openedRows?.type === "list" ? openedRows.rows.map((row) => row.open) : null,
    [{ session: "s_1" }, { screen: true }, null, null, null, null, { session: "s_2" }, null],
  );

  const rowTones = clampView({
    blocks: [{ type: "list", empty: "", rows: [{ id: "a", tone: "danger" }, { id: "b", tone: "puce" }, { id: "c" }] }],
  });
  const tonedRows = rowTones.view.blocks[0];
  check(
    "a tone this daemon knows survives, and one it does not is no tone",
    tonedRows?.type === "list" ? tonedRows.rows.map((row) => row.tone) : null,
    ["danger", null, null],
  );

  /* ---------------------------------------------------------------- *
   * A settings pane draws less than a screen does.
   *
   * ⚠ **Two vocabularies over one protocol, and the whole risk is that the
   * narrow one silently becomes the wide one again.** A settings pane is a form
   * plus the words around it — three block types, three field kinds — while a
   * plugin's own screen keeps all five of each. Nothing in the type system
   * expresses "narrower", so every assertion below is paired with its negative
   * control on the other surface: dropping a `list` is only correct if a screen
   * still draws one, and downgrading `password` is only correct if a screen
   * still masks one.
   * ---------------------------------------------------------------- */
  {
    const listBlock = { type: "list", empty: "nothing", rows: [{ id: "a", title: "A" }] };
    const onScreen = clampView({ blocks: [listBlock] }, "screen");
    const onSettings = clampView({ blocks: [listBlock] }, "settings");
    check("a screen draws a list", onScreen.view.blocks.map((one) => one.type), ["list"]);
    check("a settings pane does not", onSettings.view.blocks, []);
    /*
     * ⚠ **`substituted`, never `clamped`.** Nothing here was too large — the two
     * flags send an author to two different places, and reported as a size clamp
     * this one sends them to go and count rows in a list that was the wrong shape
     * for the surface rather than too long.
     */
    check(
      "and says so as a shape problem rather than a size one",
      [onSettings.substituted, onSettings.clamped, [...onSettings.unknownBlocks]],
      [true, false, ["list"]],
    );
    check("while the screen reports neither", [onScreen.substituted, onScreen.clamped], [false, false]);
    /*
     * ⚠ **The notice must not say "this machine does not draw a list".** It does
     * draw one, one surface over — told that, an author goes looking for a typo in
     * a block type they spelled correctly, which is the wrong-diagnosis failure
     * the naming branch exists to end. And it names what a settings pane *does*
     * draw, because the author has no copy of this protocol.
     */
    const settingsNotice = noteClamp(onSettings, "settings").blocks.filter((one) => one.type === "notice");
    const settingsText = settingsNotice[0]?.type === "notice" ? settingsNotice[0].text : "";
    check("the notice is about the surface, not about the machine", settingsText.startsWith("A settings pane"), true);
    check("and names the three block types a pane draws", /text, notice, form/.test(settingsText), true);
    check("and does not offer the two it just refused", /list|columns/.test(settingsText.split(" It draws")[1] ?? ""), false);
    check("and never says anything was too large", /too large/.test(settingsText), false);
    /*
     * ⚠ **A danger notice keeps its tone on a settings pane, and that is
     * load-bearing rather than cosmetic.** Found by the first plugin this
     * narrowing hit: it has no screen — a screen for one function is a page nobody
     * visits — and its pane carried the only record of *refusals*. A hook's
     * failure has nobody waiting on it, so nothing is owed an error and there is
     * no session left to warn through; `notice` is the entire diagnostic channel
     * for a plugin shaped like that. Drawn in the ordinary ink it is a diagnostic
     * nobody reads, so the tone is asserted and not merely the block.
     */
    const danger = clampView(
      { blocks: [{ type: "notice", text: "could not rename", tone: "danger" }] },
      "settings",
    ).view.blocks[0];
    check(
      "a settings pane keeps a danger notice, and its tone",
      danger?.type === "notice" ? [danger.tone, danger.text] : null,
      ["danger", "could not rename"],
    );

    /*
     * The field kinds. `password` and `number` are spellings of a text box rather
     * than a fourth and fifth kind of setting — see `PLUGIN_SETTINGS_FIELD_KINDS`
     * — so on a settings pane they become `text` **and are reported**, which is
     * the half that matters: a masked box that silently stops being masked is the
     * one substitution here that looks like it worked.
     */
    const form = (kind: unknown): unknown => ({
      blocks: [{ type: "form", action: "save", submit: "Save", fields: [{ key: "k", label: "L", kind }] }],
    });
    const kindOn = (surface: "screen" | "settings", kind: unknown): string | null => {
      const block = clampView(form(kind), surface).view.blocks[0];
      return block?.type === "form" ? (block.fields[0]?.kind ?? null) : null;
    };
    check(
      "a screen keeps all five field kinds",
      ["text", "password", "number", "toggle", "select"].map((kind) => kindOn("screen", kind)),
      ["text", "password", "number", "toggle", "select"],
    );
    check(
      "a settings pane keeps three and spells the other two as a text box",
      ["text", "password", "number", "toggle", "select"].map((kind) => kindOn("settings", kind)),
      ["text", "text", "text", "toggle", "select"],
    );
    check(
      "and reports the two it changed, so an author finds out",
      ["text", "password", "number", "toggle", "select"].map((kind) => clampView(form(kind), "settings").substituted),
      [false, true, true, false, false],
    );
    check(
      "while the screen reports none of them",
      ["text", "password", "number", "toggle", "select"].map((kind) => clampView(form(kind), "screen").substituted),
      [false, false, false, false, false],
    );
    /*
     * ⚠ **Absence is still a default on both surfaces.** Omitting `kind` means an
     * ordinary text box and is a perfectly good thing for a plugin to do — if it
     * raised the flag, every well-written plugin would draw the notice and it
     * would stop meaning anything. Both spellings of absence, because JSON has no
     * `undefined` and `null` is the likelier one on the wire.
     */
    check(
      "a field with no kind is a default rather than a substitution",
      [
        clampView({ blocks: [{ type: "form", action: "s", fields: [{ key: "k" }] }] }, "settings").substituted,
        clampView(form(null), "settings").substituted,
      ],
      [false, false],
    );
    /*
     * The notice for a substitution *inside* a block, where no block was refused:
     * on a settings pane the commonest cause is a kind the machine recognises and
     * declines, so "not in a shape this machine recognises" is exactly wrong and
     * the three kinds are named instead.
     */
    const inner = noteClamp(clampView(form("password"), "settings"), "settings").blocks.filter(
      (one) => one.type === "notice",
    );
    const innerText = inner[0]?.type === "notice" ? inner[0].text : "";
    check("a refused field kind names the three that are not", /text, toggle, select/.test(innerText), true);

    /*
     * ⚠ **The default is the wide surface**, and that direction is the safe one:
     * a call site nobody has told about surfaces draws a settings pane as though
     * it were a screen — today's behaviour — rather than silently deleting
     * controls off somebody's pane.
     */
    check(
      "an untold caller gets the screen's vocabulary",
      clampView({ blocks: [listBlock] }).view.blocks.map((one) => one.type),
      ["list"],
    );
    check(
      "and `fitView` carries the surface through the size pass",
      fitView({ blocks: [listBlock] }, 64_000, "settings").view.blocks,
      [],
    );
    /*
     * A settings type that is not a screen type is a value `PluginView` has no arm
     * for: it would render as nothing and say nothing about itself. Asserted as a
     * subset rather than as two lists, so adding a block type to the wide set
     * cannot quietly fail to be considered for the narrow one.
     */
    check(
      "what a pane draws is a subset of what a screen draws",
      PLUGIN_SETTINGS_BLOCK_TYPES.filter((one) => !PLUGIN_BLOCK_TYPES.some((two) => two === one)),
      [],
    );
  }
}
