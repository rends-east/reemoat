import { check, report } from "./daemoncheck.env.js";

process.stdout.write("\nwhat a plugin returns, and what is forwarded\n");
{
  const { clampView, fitView, noteClamp, PLUGIN_BLOCK_TYPES, PLUGIN_SETTINGS_BLOCK_TYPES, PLUGIN_VIEW_LIMITS } =
    await import("../src/plugins/protocol.js");
  const { MAX_PLUGIN_MESSAGE_BYTES } = await import("../src/plugins/runtime.js");

  check("nothing at all is an empty view rather than a throw", clampView(null), {
    view: { title: null, refreshMs: null, blocks: [] },
    clamped: false,
    substituted: false,
    unknownBlocks: [],
  });
  check("a block this daemon does not draw is dropped", clampView({ blocks: [{ type: "canvas" }] }).view.blocks, []);
  // clamped and substituted are independent flags: an unknown block type is a shape problem, never a size one.
  const invented = clampView({ blocks: [{ type: "canvas" }] });
  check("and dropping one is reported as a shape it does not know", invented.substituted, true);
  check("and never as something that was too large", invented.clamped, false);
  const drawn = noteClamp(invented).blocks.filter((block) => block.type === "notice");
  check(
    "so the notice a person reads names the protocol rather than the bounds",
    drawn.map((block) => (block as { text: string }).text.includes("too large")),
    [false],
  );
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
  const nameless = clampView({ blocks: [{ notype: true }] });
  check("a block with no type says so rather than naming nothing", nameless.unknownBlocks, ["(no type)"]);
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

  // An unknown tone falls to the ordinary one, so a misspelling can never make a destructive control look harmless.
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

  // fitView runs in the child, so a view is cut before MAX_PLUGIN_MESSAGE_BYTES would refuse to send it.
  {
    const budget = MAX_PLUGIN_MESSAGE_BYTES - 1024;
    const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
    const rowsOf = (n: number): unknown[] =>
      Array.from({ length: n }, (_, i) => ({ id: `s_${i}`, title: "an ordinary session title", subtitle: "claude" }));

    const small = fitView({ title: "T", blocks: [{ type: "list", rows: rowsOf(10), empty: "" }] }, budget);
    check("a view that already fits is passed through untouched", small.clamped, false);

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

    // The reduction is total (rows, then whole blocks, then the title), so the result always fits the budget.
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

    check(
      "and a view that fits is not described as cut",
      fitView({ title: "S", blocks: [{ type: "text", text: "small" }] }, budget).clamped,
      false,
    );
  }

  check("a view that is already fine is not reported as clamped", clampView({ title: "T", blocks: [] }).clamped, false);

  // A substitution must be reported: a form whose fields lost their key renders fine and submits nothing.
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
  const keyless = clampView({ blocks: [{ type: "form", action: "save", fields: [{ label: "A" }] }] });
  check("a field with no key cannot round-trip, and says so", keyless.substituted, true);
  const actionless = clampView({ blocks: [{ type: "form", submit: "Save", fields: [{ key: "a", label: "A" }] }] });
  check("a form with no action submits nowhere, and says so", actionless.substituted, true);
  const unknownKind = clampView({
    blocks: [{ type: "form", action: "save", fields: [{ key: "a", label: "A", kind: "string" }] }],
  });
  check("a kind this daemon does not know is a substitution", unknownKind.substituted, true);
  const plain = clampView({
    blocks: [{ type: "form", action: "save", fields: [{ key: "a", label: "A" }] }],
  });
  check("but omitting kind entirely is a default rather than a substitution", plain.substituted, false);
  // An omitted kind and a null one are both the default: JSON has no undefined, so null is the likelier spelling.
  const nulled = clampView({
    blocks: [{ type: "form", action: "save", fields: [{ key: "a", label: "A", kind: null }] }],
  });
  check("and neither is null spelled out", nulled.substituted, false);
  const kindOf = (view: typeof plain.view): unknown => {
    const block = view.blocks[0];
    return block !== undefined && block.type === "form" ? block.fields[0]?.kind : "<not a form>";
  };
  check("both spellings still give an ordinary text field", [kindOf(plain.view), kindOf(nulled.view)], ["text", "text"]);

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
  // Clamped silently: a moved refresh interval is invisible and actionable by nobody.
  check("and moving one is not reported as a clamp", clampView({ refreshMs: 10, blocks: [] }).clamped, false);

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

  // A settings pane draws a narrower vocabulary; each assertion is paired with its control on the screen surface.
  {
    const listBlock = { type: "list", empty: "nothing", rows: [{ id: "a", title: "A" }] };
    const onScreen = clampView({ blocks: [listBlock] }, "screen");
    const onSettings = clampView({ blocks: [listBlock] }, "settings");
    check("a screen draws a list", onScreen.view.blocks.map((one) => one.type), ["list"]);
    check("a settings pane does not", onSettings.view.blocks, []);
    check(
      "and says so as a shape problem rather than a size one",
      [onSettings.substituted, onSettings.clamped, [...onSettings.unknownBlocks]],
      [true, false, ["list"]],
    );
    check("while the screen reports neither", [onScreen.substituted, onScreen.clamped], [false, false]);
    const settingsNotice = noteClamp(onSettings, "settings").blocks.filter((one) => one.type === "notice");
    const settingsText = settingsNotice[0]?.type === "notice" ? settingsNotice[0].text : "";
    check("the notice is about the surface, not about the machine", settingsText.startsWith("A settings pane"), true);
    check("and names the three block types a pane draws", /text, notice, form/.test(settingsText), true);
    check("and does not offer the two it just refused", /list|columns/.test(settingsText.split(" It draws")[1] ?? ""), false);
    check("and never says anything was too large", /too large/.test(settingsText), false);
    // notice is a hook-only plugin's whole diagnostic channel, so its danger tone must survive on a settings pane.
    const danger = clampView(
      { blocks: [{ type: "notice", text: "could not rename", tone: "danger" }] },
      "settings",
    ).view.blocks[0];
    check(
      "a settings pane keeps a danger notice, and its tone",
      danger?.type === "notice" ? [danger.tone, danger.text] : null,
      ["danger", "could not rename"],
    );

    // password and number become text on a pane and must be reported: an unmasked box looks like it worked.
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
    check(
      "a field with no kind is a default rather than a substitution",
      [
        clampView({ blocks: [{ type: "form", action: "s", fields: [{ key: "k" }] }] }, "settings").substituted,
        clampView(form(null), "settings").substituted,
      ],
      [false, false],
    );
    const inner = noteClamp(clampView(form("password"), "settings"), "settings").blocks.filter(
      (one) => one.type === "notice",
    );
    const innerText = inner[0]?.type === "notice" ? inner[0].text : "";
    check("a refused field kind names the three that are not", /text, toggle, select/.test(innerText), true);

    // The default surface is the wide one, so an untold caller never silently loses controls.
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
    // PluginView has no arm for a settings-only type, so the pane's set must be a subset of the screen's.
    check(
      "what a pane draws is a subset of what a screen draws",
      PLUGIN_SETTINGS_BLOCK_TYPES.filter((one) => !PLUGIN_BLOCK_TYPES.some((two) => two === one)),
      [],
    );
  }
}
