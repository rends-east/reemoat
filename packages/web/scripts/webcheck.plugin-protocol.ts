import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";

process.stdout.write("\nwhat a plugin may make this client draw\n");
{
  // wire.ts hand-mirrors src/plugins/protocol.ts (packages/web may not import src/), so the types are compared here as text.
  {
    const daemonSrc = readFileSync(new URL("../../../src/plugins/protocol.ts", import.meta.url), "utf8");
    const clientSrc = readFileSync(new URL("../src/wire.ts", import.meta.url), "utf8");
    // Ended at the blank line, never at the first semicolon: PluginBlock's object members contain semicolons.
    const declaration = (src: string, head: string): string | null => {
      const at = src.indexOf(head);
      if (at < 0) return null;
      const body = src.slice(at + head.length);
      const end = body.search(/\n\s*\n/);
      return end === -1 ? body : body.slice(0, end);
    };
    const membersOf = (src: string, name: string): string[] => {
      const body = declaration(src, `export type ${name} =`);
      if (body === null) return [`<no ${name}>`];
      return [...body.matchAll(/"([a-z_.]+)"/g)].map((one) => one[1] ?? "").sort();
    };
    // `PluginBlock`'s members are objects, so its discriminant is what identifies
    // them — every other string in that declaration is a tone or a field name.
    const tagsOf = (src: string): string[] => {
      const body = declaration(src, "export type PluginBlock =");
      if (body === null) return ["<no PluginBlock>"];
      return [...body.matchAll(/\btype: "([a-z_]+)"/g)].map((one) => one[1] ?? "").sort();
    };

    for (const name of ["PluginScope", "PluginHook", "PluginState", "PluginFieldKind"]) {
      const theirs = membersOf(daemonSrc, name);
      // A pattern that matches nothing passes silently, which is the failure mode
      // of every source-text assertion in this file.
      check(`${name} is readable on the daemon's side at all`, theirs.length > 0 && theirs[0]?.startsWith("<") !== true, true);
      check(`and the client's ${name} holds exactly the same members`, membersOf(clientSrc, name), theirs);
    }
    // Daemon within client, never equality: fields added after the first release are optional here because an older daemon does not send them.
    /** Interfaces whose `extends` names something this reader could not find. */
    const unresolvedParents: string[] = [];
    const fieldsOf = (src: string, name: string, seen = new Set<string>()): string[] | null => {
      if (seen.has(name)) return [];
      seen.add(name);
      const clean = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const head = new RegExp(`export interface ${name}\\s*(extends\\s+([\\w, ]+))?\\s*\\{`).exec(clean);
      if (head === null) return null;
      const out: string[] = [];
      for (const parent of (head[2] ?? "").split(",").map((one) => one.trim()).filter(Boolean)) {
        const inherited = fieldsOf(src, parent, seen);
        // Recorded, never treated as empty: an unread parent makes the interface look smaller and hides drift.
        if (inherited === null) unresolvedParents.push(`${name} extends ${parent}`);
        else out.push(...inherited);
      }
      let depth = 0;
      // Braces stay out of the bracket counter because they also delimit the interface body.
      let inner = 0;
      let token = "";
      for (let i = clean.indexOf("{", head.index); i < clean.length; i += 1) {
        const c = clean[i] ?? "";
        if (c === "{") {
          depth += 1;
          token = "";
          continue;
        }
        if (c === "}") {
          depth -= 1;
          token = "";
          if (depth === 0) break;
          continue;
        }
        if (c === "(" || c === "[") {
          inner += 1;
          token = "";
          continue;
        }
        if (c === ")" || c === "]") {
          inner -= 1;
          token = "";
          continue;
        }
        // Nothing inside a parameter list or a tuple is a field of this interface.
        if (inner > 0) continue;
        // Depth 1 only: a nested object type's own members belong to it, not here.
        if (depth !== 1) continue;
        if (c === ":") {
          const field = token.trim().replace(/\?$/, "");
          if (/^[A-Za-z_]\w*$/.test(field)) out.push(field);
          token = "";
        } else if (c === ";" || c === "\n" || c === ",") token = "";
        else token += c;
      }
      return [...new Set(out)].sort();
    };

    const registrySrc = readFileSync(new URL("../../../src/registry.ts", import.meta.url), "utf8");
    const eventsSrc = readFileSync(new URL("../../../src/events.ts", import.meta.url), "utf8");
    // Every file declaring a type wire.ts mirrors must be read here, or the continue below skips that pair silently.
    const systemsSrc = readFileSync(new URL("../../../src/acp/systems.ts", import.meta.url), "utf8");
    const askSrc = readFileSync(new URL("../../../src/agentask.ts", import.meta.url), "utf8");
    const asyncTasksSrc = readFileSync(
      new URL("../../../src/acp/asynctasks.ts", import.meta.url),
      "utf8",
    );
    const agentsSrc = readFileSync(new URL("../../../src/acp/agents.ts", import.meta.url), "utf8");
    const authSrc = readFileSync(new URL("../../../src/agentauth.ts", import.meta.url), "utf8");
    const installSrc = readFileSync(new URL("../../../src/agentinstall.ts", import.meta.url), "utf8");
    const runtimeTypesSrc = readFileSync(new URL("../../../src/runtime/types.ts", import.meta.url), "utf8");
    const browseSrc = readFileSync(new URL("../../../src/browse.ts", import.meta.url), "utf8");
    const mirrored = [...new Set([...clientSrc.matchAll(/export interface (\w+)/g)].map((one) => one[1] ?? ""))];
    const behind: string[] = [];
    let compared = 0;
    for (const name of mirrored) {
      const theirs = [
        registrySrc,
        eventsSrc,
        daemonSrc,
        systemsSrc,
        askSrc,
        asyncTasksSrc,
        agentsSrc,
        authSrc,
        installSrc,
        runtimeTypesSrc,
        browseSrc,
      ]
        .map((src) => fieldsOf(src, name))
        .find((one) => one !== null);
      if (theirs === undefined || theirs === null) continue;
      compared += 1;
      const ours = fieldsOf(clientSrc, name) ?? [];
      const missing = theirs.filter((field) => !ours.includes(field));
      if (missing.length > 0) behind.push(`${name} lacks ${missing.join(", ")}`);
    }
    // Negative control: Session is a prefix of real interfaces and declared nowhere, so an unanchored reader fails this.
    check("a name that is only a prefix of real ones matches nothing", fieldsOf(registrySrc, "Session"), null);
    check("while the real one it is a prefix of still reads", (fieldsOf(registrySrc, "SessionSnapshot") ?? []).length > 20, true);
    // Only the depth guard keeps contextUsage's inline members out, and a break makes the list larger, which the subset check passes.
    const clientSnapshot = fieldsOf(clientSrc, "SessionSnapshot") ?? [];
    check(
      "a nested object's members are not counted as the interface's own",
      ["used", "size", "amount", "currency"].filter((field) => clientSnapshot.includes(field)),
      [],
    );
    check("while the field that holds them is", clientSnapshot.includes("contextUsage"), true);
    // Fixtures rather than real files: these are claims about the reader, each shape held by a different defence.
    const NESTED = "export interface Fixture {\n  one: string;\n  nest: {\n    inner: string;\n  } | null;\n}";
    const PARAMS = "export interface Fixture {\n  one: string;\n  handler: (\n    id: string,\n    at: number,\n  ) => void;\n}";
    const TUPLE = "export interface Fixture {\n  one: string;\n  pair: [\n    label: string,\n    other: number,\n  ];\n}";
    const FLAT = "export interface Fixture {\n  one: string;\n  pair: [label: string, other: number];\n}";
    check("it reads the fields of a plain interface", fieldsOf(NESTED, "Fixture"), ["nest", "one"]);
    check(
      "and does not count a nested object's members, when the nesting spans lines",
      fieldsOf(NESTED, "Fixture")?.includes("inner"),
      false,
    );
    check("and does not count a function-typed field's parameters", fieldsOf(PARAMS, "Fixture"), ["handler", "one"]);
    check("nor a labelled tuple's, across lines", fieldsOf(TUPLE, "Fixture"), ["one", "pair"]);
    check("and not on one line either, where the comma used to let the second through", fieldsOf(FLAT, "Fixture"), ["one", "pair"]);
    check("an index signature contributes no field", fieldsOf("export interface Fixture {\n  one: string;\n  [key: string]: unknown;\n}", "Fixture"), ["one"]);
    check("no interface inherits from something this reader cannot find", unresolvedParents, []);
    const before = unresolvedParents.length;
    const ALIAS = "type Base = { a: string };\nexport interface Child extends Base {\n  b: string;\n}";
    check("an interface whose parent is not an interface still reads its own fields", fieldsOf(ALIAS, "Child"), ["b"]);
    check("and the parent it could not follow is named rather than passed over", unresolvedParents.slice(before), [
      "Child extends Base",
    ]);
    // A floor, because finding nothing to compare reports no drift; it moves with the list of sources above.
    report("there are mirrored interfaces to compare at all", compared >= 64, `${compared} interfaces`);
    check("and the session snapshot is one of them", fieldsOf(registrySrc, "SessionSnapshot") !== null, true);
    check("no interface this client mirrors knows less than the daemon's own", behind, []);

    const daemonTags = tagsOf(daemonSrc);
    // Against the daemon's own constant rather than a list typed out here.
    const { PLUGIN_BLOCK_TYPES } = await import("../../../src/plugins/protocol.js");
    check("the block union is readable on the daemon's side at all", daemonTags, [...PLUGIN_BLOCK_TYPES].sort());
    check("and the client draws exactly the blocks the daemon can send", tagsOf(clientSrc), daemonTags);
  }

  const {
    readBlock,
    readView,
    seedForm,
    pluginFailure,
    ConsentBrokenError,
    pluginPath,
    pluginDestination,
    pluginStateText,
    pluginUsable,
    screenPlugins,
    sessionActions,
    MIN_REFRESH_MS,
  } = await import("../src/plugins.js");
  const { ApiError } = await import("../src/http.js");

  // Everything here fails open: plugins ship on their own schedule, so unknown output narrows rather than throws.

  check("a block type this client has never heard of is dropped", readBlock({ type: "canvas", data: 1 }), null);
  check("and so is something that is not a block at all", [readBlock(null), readBlock("text"), readBlock(7)], [null, null, null]);
  check(
    "a view whose blocks are all unknown is an empty view rather than a throw",
    readView({ title: "T", blocks: [{ type: "canvas" }, { type: "webgl" }] }),
    { title: "T", refreshMs: null, blocks: [] },
  );
  check("a view that is not an object at all", readView(null), { title: null, refreshMs: null, blocks: [] });
  check("a view whose blocks are not an array", readView({ blocks: "nope" }), { title: null, refreshMs: null, blocks: [] });

  check(
    "a text block with nothing in it still draws",
    readBlock({ type: "text" }),
    { type: "text", text: "", tone: "default" },
  );
  // An unknown tone falls to the ordinary one, so a plugin can never make a destructive control look harmless.
  check("an unknown tone is the ordinary one", readBlock({ type: "notice", text: "x", tone: "nuclear" }), {
    type: "notice",
    text: "x",
    tone: "default",
  });
  check("and a known one survives", readBlock({ type: "notice", text: "x", tone: "danger" })?.type === "notice", true);

  const list = readBlock({ type: "list", rows: [{ id: "a" }, null, "x"], empty: "" });
  check(
    "rows that are not rows become empty rows rather than holes",
    list?.type === "list" ? list.rows.map((row) => [row.id, row.title, row.subtitle]) : null,
    [
      ["a", "", null],
      ["", "", null],
      ["", "", null],
    ],
  );
  check(
    "a row action's tone is the safe one unless it says otherwise",
    (() => {
      const one = readBlock({ type: "list", rows: [{ id: "a", actions: [{ id: "x" }, { id: "y", tone: "destructive" }] }], empty: "" });
      return one?.type === "list" ? one.rows[0]?.actions.map((action) => action.tone) : null;
    })(),
    ["plain", "destructive"],
  );

  const columns = readBlock({
    type: "columns",
    columns: [{ title: "Todo", rows: [{ id: "a", tone: "puce" }] }, null, { rows: [{ id: "b" }] }],
  });
  check(
    "a column that is not a column becomes an empty one rather than a hole",
    columns?.type === "columns" ? columns.columns.map((one) => [one.title, one.rows.length]) : null,
    [
      ["Todo", 1],
      ["", 0],
      ["", 1],
    ],
  );
  check(
    "and a column's rows are narrowed exactly as a list's are",
    columns?.type === "columns" ? columns.columns[0]?.rows[0]?.tone : "unset",
    null,
  );

  const form = readBlock({
    type: "form",
    action: "save",
    fields: [{ key: "a", label: "A", kind: "quantum" }, { key: "b", label: "B", kind: "toggle", value: "true" }],
  });
  check(
    "a field kind this client cannot draw becomes a text input",
    form?.type === "form" ? form.fields.map((field) => field.kind) : null,
    ["text", "toggle"],
  );
  check("and its value survives", form?.type === "form" ? form.fields[0]?.value : null, null);
  check("a form with no submit label still has one", form?.type === "form" ? form.submit : null, "Save");

  // The daemon cannot clamp an action's answer (it never learns which pane was pressed), so this side enforces the settings bound.
  {
    const listy = { type: "list", rows: [{ id: "a" }], empty: "" };
    check("a screen draws a list", readBlock(listy, "screen")?.type ?? null, "list");
    check("a settings pane does not", readBlock(listy, "settings"), null);
    check("nor a two-column board", readBlock({ type: "columns", columns: [] }, "settings"), null);
    check(
      "but the words around a form survive",
      [readBlock({ type: "text", text: "x" }, "settings")?.type ?? null, readBlock({ type: "notice", text: "x" }, "settings")?.type ?? null],
      ["text", "notice"],
    );
    const danger = readBlock({ type: "notice", text: "could not rename", tone: "danger" }, "settings");
    check(
      "and a danger notice keeps being one",
      danger?.type === "notice" ? [danger.tone, danger.text] : null,
      ["danger", "could not rename"],
    );
    const kinds = (surface: "screen" | "settings"): (string | null)[] => {
      const one = readBlock(
        {
          type: "form",
          action: "save",
          fields: ["text", "password", "number", "toggle", "select"].map((kind) => ({ key: kind, label: kind, kind })),
        },
        surface,
      );
      return one?.type === "form" ? one.fields.map((field) => field.kind) : [];
    };
    check("a screen keeps all five field kinds", kinds("screen"), ["text", "password", "number", "toggle", "select"]);
    // password narrows to a visible box on purpose: plugin_data is plaintext SQLite, so a mask would be a false assurance.
    check("a settings pane keeps three, and the other two are a text box", kinds("settings"), [
      "text",
      "text",
      "text",
      "toggle",
      "select",
    ]);
    check(
      "and every field still round-trips",
      (() => {
        const one = readBlock(
          { type: "form", action: "save", fields: [{ key: "k", label: "L", kind: "password", value: "v" }] },
          "settings",
        );
        return one?.type === "form" ? [one.fields.length, one.fields[0]?.key ?? null, one.fields[0]?.value ?? null] : null;
      })(),
      [1, "k", "v"],
    );
    check("an untold caller gets the screen's vocabulary", readBlock(listy)?.type ?? null, "list");
    check(
      "and `readView` carries the surface down to every block",
      readView({ blocks: [{ type: "text", text: "x" }, listy] }, "settings").blocks.map((one) => one.type),
      ["text"],
    );
  }

  check(
    "a form seeds from what the plugin sent",
    seedForm([
      { key: "a", label: "", kind: "text", value: "x", options: [], placeholder: null, help: null },
      { key: "b", label: "", kind: "toggle", value: null, options: [], placeholder: null, help: null },
      { key: "c", label: "", kind: "text", value: null, options: [], placeholder: null, help: null },
    ]),
    { a: "x", b: "false", c: "" },
  );

  const failed = (status: number, code: string, message = "m", detail: unknown = null): string =>
    pluginFailure(new ApiError(status, code, message, detail));

  // An old daemon is recognised by the shape of its refusal, never by its version.
  check("an old daemon is told apart from a missing plugin", failed(404, "http_404"), "This machine's daemon is too old for plugins. Update it and try again.");
  check("while a real 404 is about the plugin", failed(404, "plugin_not_found"), "That plugin is not installed on this machine any more.");
  check(
    "a grant that cannot install is told it needs admin, not that it is read-only",
    failed(403, "insufficient_scope", "m", { required: "machine:admin" }),
    "Installing and removing plugins needs admin access to this machine.",
  );
  check(
    "and any other scope is named rather than guessed at",
    failed(403, "insufficient_scope", "m", { required: "session:write" }),
    "That needs the session:write scope, which this access does not carry.",
  );
  check(
    "a refusal that names no scope says the true thing and nothing more",
    failed(403, "insufficient_scope"),
    "You do not have access to do that on this machine.",
  );
  report(
    "a failed install says the machine was not changed",
    failed(409, "plugin_start_failed", "SyntaxError").includes("nothing was changed"),
    failed(409, "plugin_start_failed", "SyntaxError"),
  );
  check("a bad manifest keeps the daemon's words", failed(400, "manifest_invalid", "id must be…"), "id must be…");
  check("a code this client has never seen falls through to the message", failed(400, "brand_new_code", "the daemon's words"), "the daemon's words");
  // A transport failure says nothing about whether the daemon acted, so this must not invite a retry.
  check(
    "and something that is not an ApiError at all",
    pluginFailure(new Error("x")),
    "That machine did not answer, and whether it acted is not known. Check before trying again.",
  );
  check(
    "a broken consent keeps its words rather than a diagnosis of the transport",
    pluginFailure(new ConsentBrokenError("That plugin asked for more than this screen showed: net.")),
    "That plugin asked for more than this screen showed: net.",
  );

  const plugin = (patch: Record<string, unknown>): never =>
    ({
      id: "p",
      name: "P",
      version: "1.0.0",
      description: null,
      scopes: [],
      net: [],
      contributes: { screen: null, settings: false, actions: [], hooks: [] },
      enabled: true,
      state: "running",
      failure: null,
      installedAt: 0,
      updatedAt: 0,
      ...patch,
    }) as never;

  const withScreen = plugin({ id: "a", contributes: { screen: { title: "A" }, settings: false, actions: [], hooks: [] } });
  const noScreen = plugin({ id: "b" });
  const off = plugin({ id: "c", enabled: false, contributes: { screen: { title: "C" }, settings: false, actions: [], hooks: [] } });
  const failing = plugin({ id: "d", state: "failed", contributes: { screen: { title: "D" }, settings: false, actions: [], hooks: [] } });

  check(
    "only plugins that draw a screen and are usable are launchable",
    screenPlugins([withScreen, noScreen, off, failing]).map((one) => one.id),
    ["a"],
  );
  check("and both halves of usable are asked", [pluginUsable(off), pluginUsable(failing), pluginUsable(withScreen)], [false, false, true]);

  const acting = plugin({
    id: "e",
    name: "E",
    contributes: {
      screen: null,
      settings: false,
      actions: [
        { id: "one", title: "One", on: "session" },
        { id: "two", title: "Two", on: "screen" },
      ],
      hooks: [],
    },
  });
  check(
    "only session-surface actions reach a session's menu",
    sessionActions([acting, off]).map((offer) => [offer.plugin.id, offer.actionId]),
    [["e", "one"]],
  );

  check(
    "a plugin's state is words rather than a colour",
    [
      pluginStateText(plugin({ state: "running" })),
      pluginStateText(plugin({ state: "starting" })),
      pluginStateText(plugin({ state: "failed" })),
      pluginStateText(plugin({ state: "stopped" })),
      pluginStateText(plugin({ enabled: false, state: "running" })),
    ],
    ["Running", "Starting", "Failed", "Idle", "Switched off"],
  );

  check(
    "every tone this client knows survives, and one it does not is no tone",
    (() => {
      const one = readBlock({
        type: "list",
        empty: "",
        rows: [
          { id: "a", tone: "ok" },
          { id: "b", tone: "warn" },
          { id: "c", tone: "danger" },
          { id: "d", tone: "chartreuse" },
          { id: "e" },
        ],
      });
      return one?.type === "list" ? one.rows.map((row) => row.tone) : null;
    })(),
    ["ok", "warn", "danger", null, null],
  );

  check(
    "only the two destinations this app has survive",
    (() => {
      const one = readBlock({
        type: "list",
        empty: "",
        rows: [
          { id: "a", open: { session: "s_1" } },
          { id: "b", open: { screen: true } },
          { id: "c", open: { url: "https://evil.example" } },
          { id: "d", open: "https://evil.example" },
          { id: "e", open: { session: "" } },
          { id: "f", open: { screen: false } },
          { id: "g" },
        ],
      });
      return one?.type === "list" ? one.rows.map((row) => row.open) : null;
    })(),
    [{ session: "s_1" }, { screen: true }, null, null, null, null, null],
  );

  check(
    "a destination resolves against the machine it was read on",
    [
      pluginDestination({ session: "s_9" }),
      pluginDestination({ screen: true }),
      pluginDestination(null),
    ],
    [{ kind: "session", sessionId: "s_9" }, { kind: "screen" }, null],
  );

  // Floored here too: the daemon's clamp is its own constant and an older daemon may lack it.
  check(
    "a refresh interval is floored here as well as there",
    [
      readView({ refreshMs: 100, blocks: [] }).refreshMs,
      readView({ refreshMs: 9_000, blocks: [] }).refreshMs,
      readView({ refreshMs: 0, blocks: [] }).refreshMs,
      readView({ refreshMs: -5, blocks: [] }).refreshMs,
      readView({ refreshMs: "fast", blocks: [] }).refreshMs,
      readView({ blocks: [] }).refreshMs,
    ],
    [MIN_REFRESH_MS, 9_000, null, null, null, null],
  );

  check("a plugin's screen is a short, shared path", pluginPath("m_1" as never, "board"), "/p/m_1/board");
  check("and every segment is encoded", pluginPath("m 1" as never, "a/b"), "/p/m%201/a%2Fb");
}
