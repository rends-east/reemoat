import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";

process.stdout.write("\nwhat a plugin may make this client draw\n");
{
  /*
   * ⚠ **The hand mirror against the thing it mirrors, read off disk.**
   *
   * `wire.ts` copies `src/plugins/protocol.ts` by hand — `packages/web` may not
   * import from `src/`, which is the standing reason its header gives — and a copy
   * is only worth having while it *is* the copy. `ExitReason` is the precedent and
   * the post-mortem: a member was added on the daemon's side and not the client's,
   * every assertion in that section passed throughout because they all read the
   * same wrong copy, and a session the daemon was deliberately restarting lost its
   * composer.
   *
   * Five unions crossed the package boundary with this feature and `pincheck`
   * pins none of them — its own docblock explains, correctly, that
   * `PLUGIN_API_VERSION` has no second copy to drift, and then checks nothing
   * between the two files at all. These are the five that would drift silently:
   * a scope missing here is a permission the install list cannot name, a hook is
   * a row nothing draws, a state is a plugin whose row says the wrong thing, and
   * a block or field member is a narrowing that quietly discards content.
   */
  {
    const daemonSrc = readFileSync(new URL("../../../src/plugins/protocol.ts", import.meta.url), "utf8");
    const clientSrc = readFileSync(new URL("../src/wire.ts", import.meta.url), "utf8");
    // The members of one exported union, by name. Read as text on both sides
    // because these are types: there is nothing to import and enumerate.
    /*
     * ⚠ **Ended at the blank line, never at the first `;`.** A `;` terminates the
     * plain string unions, but `PluginBlock`'s members are object literals with
     * `;` *inside* them — so a `;` bound read one member and stopped. Both files
     * were then truncated identically, the comparison of the two truncations
     * passed, and only the "readable at all" assertion below noticed. That is the
     * precedent's own post-mortem happening inside its own replacement.
     */
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
    /*
     * ⚠ **Every interface mirrored on both sides, field for field — and until this
     * existed, nothing compared a single one of them.**
     *
     * The four unions above were checked because a union member is a value that
     * shows up in a `switch`. An *interface* field is not: a field added to
     * `SessionSnapshot` on the daemon and not copied here compiles on both sides,
     * ships, and is `undefined` at runtime on the one screen that reads it. This
     * file's own header admits the hazard — *"this file can drift"* — and then
     * nothing was watching the largest thing that can.
     *
     * ⚠ **`daemon ⊆ client`, never equality**, and the direction is the whole
     * design: every field added after the first release is *optional* here on
     * purpose, because an older daemon does not send it. Requiring the two sets to
     * match would fail on that deliberate asymmetry and be turned off within a
     * week. What is not allowed is the client knowing *less* than the daemon says.
     *
     * ⚠ **Two things this got wrong on its first run, and both were the check
     * rather than the code.** `indexOf("export interface Me")` matched
     * `MemoryEventStore`, so an unrelated type was compared against a
     * control-plane one; and following `extends` was not implemented, so
     * `AgentConfigEvent extends AgentConfig` read as a mirror missing two fields.
     * Both reported drift that was not there. A checker that cries wolf is worse
     * than none, so it resolves `extends` and anchors the name — and the fact that
     * it currently finds **nothing** is the assertion, not a shrug.
     */
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
        /*
         * ⚠ **A parent this cannot find is recorded, never treated as empty.**
         * Silently contributing nothing makes an interface look *smaller* than it
         * is — and on the daemon's side that means the sweep compares fewer
         * fields and reports no drift about the half it could not read. That is
         * the failure mode this whole sweep exists to prevent, reappearing inside
         * it: the check goes quiet exactly where it stopped working.
         */
        if (inherited === null) unresolvedParents.push(`${name} extends ${parent}`);
        else out.push(...inherited);
      }
      let depth = 0;
      /*
       * ⚠ **One rule with one name: what is inside a bracket belongs to the
       * bracket, whichever bracket it is.**
       *
       * This began as a counter for parentheses alone, to stop a function-typed
       * field's parameters being read as fields — a real hole, since `handler: (id:
       * string) => void` is only refused on one line by the accident that the token
       * reads `(id`, and across lines `id` arrives clean.
       *
       * Then the same shape turned up in square brackets. A labelled tuple —
       * `pair: [label: string, other: number]` — leaks on **both** forms here:
       * `{one, pair, other}` on one line, `{one, pair, label, other}` across
       * several. A second private counter would have made three overlapping
       * guards, so it is one instead. Nothing in either mirrored file uses either
       * shape today; the one match in `registry.ts` is inside a docblock and is
       * stripped before this reads.
       *
       * Braces stay separate because they are not only nesting: they also delimit
       * the interface body, which is why knocking *them* out breaks the reader
       * outright rather than isolating a property. See the fixtures.
       *
       * An index signature — `[key: string]: T` — yields nothing under this, and
       * that is **correct by accident of the rule rather than by decision**: its
       * name simply sits inside brackets. Written down so it is not read later as
       * something anybody chose.
       */
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
    /*
     * ⚠ **The two files the assembled-agent work put on the wire, and the sweep
     * did not read either.** `CustomAgent` and `AgentRouting` are declared in
     * `src/acp/systems.ts` and `AgentCapabilities` in `src/agentask.ts`; all three
     * are hand-mirrored in `wire.ts`, and all three fell straight through the
     * `continue` below because no source in this list declared them. The guard
     * built to catch exactly this drift silently covered none of the feature.
     */
    const systemsSrc = readFileSync(new URL("../../../src/acp/systems.ts", import.meta.url), "utf8");
    const askSrc = readFileSync(new URL("../../../src/agentask.ts", import.meta.url), "utf8");
    const mirrored = [...new Set([...clientSrc.matchAll(/export interface (\w+)/g)].map((one) => one[1] ?? ""))];
    const behind: string[] = [];
    let compared = 0;
    for (const name of mirrored) {
      const theirs = [registrySrc, eventsSrc, daemonSrc, systemsSrc, askSrc]
        .map((src) => fieldsOf(src, name))
        .find((one) => one !== null);
      if (theirs === undefined || theirs === null) continue;
      compared += 1;
      const ours = fieldsOf(clientSrc, name) ?? [];
      const missing = theirs.filter((field) => !ours.includes(field));
      if (missing.length > 0) behind.push(`${name} lacks ${missing.join(", ")}`);
    }
    /*
     * A floor on the count, because the sweep's failure mode is finding nothing to
     * compare — a renamed file, a changed declaration spelling — and reporting
     * "no drift" about zero interfaces. `SessionSnapshot` is named outright for
     * the same reason: it is the one that matters most and the one whose absence
     * from the sweep would be least visible.
     */
    /*
     * ⚠ **The negative control, and without it "the anchor works" is a belief.**
     *
     * This reader matched with `indexOf` at first, so `"export interface Me"`
     * found `MemoryEventStore` and compared two unrelated types. Anchoring the
     * name fixed it — but a fix nothing exercises is indistinguishable from a fix
     * that does nothing, and every assertion below would pass either way.
     *
     * So: a name that is a strict *prefix* of real declarations and is itself
     * declared nowhere must resolve to **nothing**. `Session` is a prefix of
     * `SessionSnapshot`, `SessionExit`, `SessionWorkspace` and more, and there is
     * no `interface Session`. Unanchored, this returns `SessionSnapshot`'s fields.
     *
     * The second half is what stops the first from passing for the wrong reason:
     * if the reader were simply broken, everything would return `null` and the
     * prefix assertion would be green about a tool that reads nothing at all.
     *
     * ⚠ **Knocked out one defence at a time, because "will it fall" and "from
     * what" are different questions and only the second is worth knowing.** There
     * is exactly one thing separating `Session` from `SessionResumeState` here:
     * the pattern requires the name to be followed immediately by whitespace, an
     * `extends`, or the brace. There is no word boundary beside it doing the work
     * in parallel. Measured both ways — replacing the whole pattern with an
     * `indexOf`, and the narrower, likelier edit of allowing anything between the
     * name and the brace (`[^{]*\{`) — and both fail this line, returning
     * `SessionResumeState`'s four fields.
     *
     * So this is a fact about the reader as it stands, not a tripwire waiting for
     * a future edit. That distinction is worth stating because the alternative is
     * real: a control can survive its own defence being removed because some
     * *other* strictness happens to hold, and then it reads for ever as proof of
     * something it never tested.
     */
    check("a name that is only a prefix of real ones matches nothing", fieldsOf(registrySrc, "Session"), null);
    check("while the real one it is a prefix of still reads", (fieldsOf(registrySrc, "SessionSnapshot") ?? []).length > 20, true);
    /*
     * An `extends` naming something unfindable is a refusal rather than a quiet
     * shortfall — see `fieldsOf`. Empty today; the day it is not, the sweep says
     * which interface it stopped being able to read instead of going quiet.
     */
    /*
     * ⚠ **The second property of this reader, and the one whose failure is
     * silent.** Depth-1 only: a nested object type's members belong to it, not to
     * the interface around it. `contextUsage` on the client's snapshot is written
     * inline — `{ used; size; cost: { amount; currency } }` — so the only thing
     * keeping `used` and `amount` out of the field list is the depth guard.
     *
     * And a break there would go **unreported by everything else here**, which is
     * why it earns a line of its own: the comparison asks whether the client is
     * missing a field the daemon has, and a depth break makes the client's list
     * *larger*. Bigger passes. The sweep would run, stay green, and be comparing
     * a shape neither file declares.
     *
     * `used` and `amount` are named rather than a count, on the same grounds as
     * the prefix control next door: a count survives the field list changing for
     * any other reason, and these two names exist in exactly one place.
     */
    const clientSnapshot = fieldsOf(clientSrc, "SessionSnapshot") ?? [];
    check(
      "a nested object's members are not counted as the interface's own",
      ["used", "size", "amount", "currency"].filter((field) => clientSnapshot.includes(field)),
      [],
    );
    check("while the field that holds them is", clientSnapshot.includes("contextUsage"), true);
    /*
     * ⚠ **Three properties, three fixtures, each written in the form where a
     * *different* defence is the only thing holding.**
     *
     * Two defences and one assertion is either redundancy or two properties under
     * one name, and nothing but knocking them out one at a time tells you which.
     * Here it is the second: single-line nesting is held by the depth counter, and
     * a parameter list by the paren counter, and neither covers the other. Written
     * only in the shapes the mirrored files happen to use today, one of the two
     * could be deleted with every line below staying green — which is how a
     * control comes to be named after a property it never touches.
     *
     * On fixtures rather than on the real files on purpose: these are claims about
     * the *reader*, and a reader is not allowed to be correct only for the input
     * it has been shown. None of these forms exists in `wire.ts` today.
     *
     * ⚠ **Measured, and one of the two cannot be isolated.** Removing the bracket
     * rule fails exactly its own four — parameters, the tuple twice, the index
     * signature — and nothing else. Removing the *brace* rule fails four as well,
     * but they include the plain positive: braces are not only nesting here, they
     * also delimit the interface body, so knocking them out stops the reader
     * reading at all. That is loud, but it is weaker evidence than the other, and
     * saying "each falls on its own" would overstate it.
     */
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
    /*
     * ⚠ **The one-line form of the tuple is asserted too, unlike the one-line
     * forms above, and the difference is measured rather than assumed.** A
     * one-line parameter list is refused anyway — the token reads `(id`, which is
     * not an identifier — so a fixture in that shape would assert nothing. A
     * one-line tuple is *not*: the comma resets the token and `other` arrives
     * clean, so this shape leaked `{one, pair, other}` and this line is the only
     * thing that says it no longer does.
     */
    check("and not on one line either, where the comma used to let the second through", fieldsOf(FLAT, "Fixture"), ["one", "pair"]);
    /*
     * An index signature reads as nothing. Asserted so the behaviour is pinned,
     * not because it was chosen — see `fieldsOf`, where it is called out as
     * correct by accident of the bracket rule.
     */
    check("an index signature contributes no field", fieldsOf("export interface Fixture {\n  one: string;\n  [key: string]: unknown;\n}", "Fixture"), ["one"]);
    check("no interface inherits from something this reader cannot find", unresolvedParents, []);
    /*
     * ⚠ **A lock on a named limit, not a control on a defence — and the two have
     * different shelf lives.** A control asks whether a guard still works and
     * breaks when the code breaks. This asks whether the behaviour is still the one
     * anybody agreed to, and breaks when the *intent* changes.
     *
     * The limit: this reader follows `extends` to another **interface** and no
     * further. `extends` naming a type alias — `type X = Omit<Y, "z">` — cannot be
     * expanded, and the answer is a refusal carrying the name rather than an
     * interface that silently reads short.
     *
     * ⚠ **That was written down in prose and pinned by nothing.** The line above
     * asserts the list is *empty*, which stays true if the recording never
     * happens at all — so the half that mattered, that an unfollowable parent is
     * loud, was a sentence. Every place either of us got this wrong today was a
     * property described in words and not asserted; prose about a tool is debt,
     * because prose does not run.
     */
    const before = unresolvedParents.length;
    const ALIAS = "type Base = { a: string };\nexport interface Child extends Base {\n  b: string;\n}";
    check("an interface whose parent is not an interface still reads its own fields", fieldsOf(ALIAS, "Child"), ["b"]);
    check("and the parent it could not follow is named rather than passed over", unresolvedParents.slice(before), [
      "Child extends Base",
    ]);
    /*
     * ⚠ **48, raised from 45 when `HarnessContribution` and `SystemContribution`
     * joined the mirror.** Measured: 44 interfaces before `systems.ts` and
     * `agentask.ts` were sources at all, 47 with them, **50** with the two a
     * contributed harness and provider put on the wire. The floor is the count
     * less the slack the last raise chose, and it moves *with* the corpus — a floor
     * left where it was is one that goes on passing over a whole group deleted,
     * which is the exact silence this number exists to break.
     *
     * ⚠ **The number and the sentence above it move together or neither means
     * anything.** This is the second time a raise has been owed and the first time
     * one was nearly missed: a corpus that grows while its floor stands still looks
     * healthier every release. The sibling driver in the catalogue service hit the
     * sharper version of it in the same week — its corpus tripled against an
     * unmoved floor, which would have passed with an entire check group removed.
     */
    report("there are mirrored interfaces to compare at all", compared >= 48, `${compared} interfaces`);
    check("and the session snapshot is one of them", fieldsOf(registrySrc, "SessionSnapshot") !== null, true);
    check("no interface this client mirrors knows less than the daemon's own", behind, []);

    const daemonTags = tagsOf(daemonSrc);
    /*
     * ⚠ **Compared against the daemon's own constant rather than a list typed out
     * here.** It used to be a hand-written `["columns", "form", "list", "notice",
     * "text"]`, which was a second copy of the union in the one file whose whole
     * job is to catch second copies drifting.
     *
     * The constant exists because the five are now *printed to a person*: a view
     * carrying a `type` nobody knows is answered with a notice naming it and
     * naming these. A sentence that listed them separately would be a third copy,
     * and the one that goes in front of somebody who is already confused.
     */
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

  /* ---------------------------------------------------------------- *
   * Everything here fails open.
   *
   * A plugin is a **third** release schedule: the web client ships with the
   * control plane weekly, a daemon ships when its owner runs `deploy.sh`, and a
   * plugin ships when its author feels like it — coordinated with neither. So
   * meeting output this client does not recognise is not an edge case, and a
   * narrowing that threw would take a whole screen away for one unknown field.
   * The failure that taught this is `endedWithDaemon`, which answered *no* for a
   * reason it had never heard of and took the composer off screen for a live
   * conversation.
   * ---------------------------------------------------------------- */

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
  /*
   * A tone this client does not know falls to the ordinary one, and the direction
   * is chosen: a plugin can fail to make a control *look* dangerous and cannot
   * make a destructive one look harmless.
   */
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

  /*
   * ⚠ **`columns` — one of the five block members, and the only one nothing
   * asked about on either side.** The board plugin in this repository is three
   * columns, so this is the shape the reference plugin actually draws, and the
   * client's arm and the daemon's `clampView` arm were both undriven: a change
   * that dropped `columns` entirely, or that forwarded an unbounded column list
   * to a phone, passed both drivers.
   *
   * Same narrowing rule as `list`, one level deeper — a column that is not a
   * column becomes an empty one rather than a hole, and its rows go through the
   * same reader, so `tone` is narrowed inside them too.
   */
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
  // It still round-trips, which is the whole of failing open: a field too new to
  // draw properly is still one somebody can read and submit.
  check("and its value survives", form?.type === "form" ? form.fields[0]?.value : null, null);
  check("a form with no submit label still has one", form?.type === "form" ? form.submit : null, "Save");

  /* ---------------------------------------------------------------- *
   * The settings surface, narrowed on this side as well as on the daemon's.
   *
   * ⚠ **Both halves are needed and they cover different moments.** The daemon
   * clamps the view it answers a *read* with, which is what produces the notice a
   * plugin author sees. It cannot clamp an **action's** answer, because an action
   * reaches it as an action id that says which action and never which pane was
   * pressed — the same submit comes from a form on a screen and from a form on a
   * settings pane. The component drawing the pane is the only thing that knows,
   * so this side is what makes the bound hold at all times rather than only on a
   * reload.
   *
   * Every assertion is paired with its screen control: dropping a `list` is only
   * right if a screen still draws one.
   * ---------------------------------------------------------------- */
  {
    const listy = { type: "list", rows: [{ id: "a" }], empty: "" };
    check("a screen draws a list", readBlock(listy, "screen")?.type ?? null, "list");
    check("a settings pane does not", readBlock(listy, "settings"), null);
    check("nor a two-column board", readBlock({ type: "columns", columns: [] }, "settings"), null);
    /*
     * `text` and `notice` are not settings — they are the sentence above a control
     * and the warning beside it, and a form with no way to say anything about
     * itself is a worse pane rather than a stricter one.
     */
    check(
      "but the words around a form survive",
      [readBlock({ type: "text", text: "x" }, "settings")?.type ?? null, readBlock({ type: "notice", text: "x" }, "settings")?.type ?? null],
      ["text", "notice"],
    );
    /*
     * ⚠ **With its tone, because for a plugin with no screen this is the whole
     * diagnostic channel.** A hook's failure has nobody waiting on it — nothing
     * asked, so nothing is owed an error, and there is no session left to warn
     * through. The first plugin this narrowing hit kept its record of refusals in
     * a `list` on its settings pane for exactly that reason. Drawn in the ordinary
     * ink a danger notice is a diagnostic nobody reads, so the tone is asserted
     * and not merely the block surviving.
     */
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
    /*
     * ⚠ **`password` narrowing to a visible box is the one that looks like a
     * regression and is not.** The value is kept in `plugin_data`, a column in a
     * plaintext SQLite file every process running as this uid can read, so the
     * mask was an assurance nothing here can keep — offered on the screen where a
     * false one costs most.
     */
    check("a settings pane keeps three, and the other two are a text box", kinds("settings"), [
      "text",
      "text",
      "text",
      "toggle",
      "select",
    ]);
    // Fail-open on both surfaces: an unsupported kind is still a control somebody
    // can read and submit, never a dropped one.
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
    /*
     * ⚠ **The default is the wide surface.** A call site that has not been told
     * which pane it is drawing keeps today's behaviour rather than silently
     * deleting somebody's controls — the same direction the daemon's default
     * takes, for the same reason.
     */
    check("an untold caller gets the screen's vocabulary", readBlock(listy)?.type ?? null, "list");
    check(
      "and `readView` carries the surface down to every block",
      readView({ blocks: [{ type: "text", text: "x" }, listy] }, "settings").blocks.map((one) => one.type),
      ["text"],
    );
  }

  /*
   * Every field is a string on the wire, including a toggle, so there is one
   * narrowing rather than five — and an unset toggle is off rather than empty.
   */
  check(
    "a form seeds from what the plugin sent",
    seedForm([
      { key: "a", label: "", kind: "text", value: "x", options: [], placeholder: null, help: null },
      { key: "b", label: "", kind: "toggle", value: null, options: [], placeholder: null, help: null },
      { key: "c", label: "", kind: "text", value: null, options: [], placeholder: null, help: null },
    ]),
    { a: "x", b: "false", c: "" },
  );

  /* ---------------------------------------------------------------- *
   * What a refusal says, and the one that is not about plugins at all.
   * ---------------------------------------------------------------- */
  const failed = (status: number, code: string, message = "m", detail: unknown = null): string =>
    pluginFailure(new ApiError(status, code, message, detail));

  /*
   * ⚠ **A daemon that predates plugins is recognised by the shape of its refusal,
   * never by its version.** `parseBody` turns Hono's bare 404 — no envelope, so no
   * code of this system's own — into `http_404`, and that is the whole test.
   * Branching on `DAEMON_VERSION` is what compatibility rule 1 forbids, and this
   * assertion is what stops somebody "simplifying" it into one.
   */
  check("an old daemon is told apart from a missing plugin", failed(404, "http_404"), "This machine's daemon is too old for plugins. Update it and try again.");
  check("while a real 404 is about the plugin", failed(404, "plugin_not_found"), "That plugin is not installed on this machine any more.");
  /*
   * ⚠ **Three arms, because three of the six plugin routes want `machine:admin`
   * and three want a session scope.** One sentence for all of them told a grant
   * that really did hold `session:write` it was read-only, and pointed at a
   * remedy that would not have worked. `requireScope` puts the scope it wanted in
   * the envelope's detail; this is the assertion that it is still read.
   */
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
  // The daemon's own sentence names the field, which is the only useful thing to
  // say to whoever is holding the manifest.
  check("a bad manifest keeps the daemon's words", failed(400, "manifest_invalid", "id must be…"), "id must be…");
  check("a code this client has never seen falls through to the message", failed(400, "brand_new_code", "the daemon's words"), "the daemon's words");
  /*
   * ⚠ **Nothing came back at all, which is not a refusal and must not read like
   * one.** This pinned "That did not work. Try again." — an invitation to make
   * exactly the retry `MachineInstalls` refuses to make, since a `POST` is not
   * replayable, a transport failure says nothing about whether the daemon acted,
   * and it may be halfway through unpacking. A second install onto a machine that
   * is still unpacking the first is how a `plugin_busy` and a half-written plugin
   * directory arrive together. A read pays for a caution it does not need, and
   * that is the trade: over-warning a refresh costs one sentence, under-warning a
   * write costs a duplicate install.
   */
  check(
    "and something that is not an ApiError at all",
    pluginFailure(new Error("x")),
    "That machine did not answer, and whether it acted is not known. Check before trying again.",
  );
  /*
   * ⚠ **The one sentence on the consent screen that may not be replaced.** The
   * fan-out paths raise a broken consent by *throwing*, so the row lands on
   * `failed` with its box unticked — and a plain `Error` fell through the arm
   * above, deleting the naming of which scope was gained. That arm has since been
   * rewritten — it said "That did not work. Try again." and now describes a
   * machine that did not answer — and this one is unaffected either way, which is
   * the point: whatever the generic sentence is, it is a diagnosis of the wrong
   * failure here, because the daemon answered and its answer is what broke the
   * consent. The generic arm is asserted on the lines above so that this is the
   * exception rather than a widening of it.
   */
  check(
    "a broken consent keeps its words rather than a diagnosis of the transport",
    pluginFailure(new ConsentBrokenError("That plugin asked for more than this screen showed: net.")),
    "That plugin asked for more than this screen showed: net.",
  );

  /* ---------------------------------------------------------------- *
   * Which plugins are offered where.
   * ---------------------------------------------------------------- */
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

  /*
   * A launcher is a door. A door onto a sentence saying the plugin is not running
   * is worse than no door, and that sentence belongs on the plugin's row in
   * settings — where it is drawn.
   */
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

  /* ---------------------------------------------------------------- *
   * What v2 added: a tone, a destination, and a refresh.
   * ---------------------------------------------------------------- */

  /*
   * ⚠ **All three, not one and a stranger.** This asserted only `danger` plus an
   * unknown word, so a typo in either narrowing list — `["ok", "warning",
   * "danger"]` — would have dropped every warn row's ink and left both drivers
   * green. The whole point of `ok|warn|danger` is that a plugin names meaning and
   * the host picks the ink; a member that silently stops surviving is the ink
   * going missing for a state nobody can see is missing.
   */
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

  /*
   * ⚠ **The field a plugin would most like to put a URL in.** Both known shapes
   * survive and everything else — a URL above all — becomes a row that is simply
   * not tappable. The daemon narrows this too; this is the second of the two,
   * because `wire.ts` is a hand mirror and trusting the daemon's narrowing would
   * be trusting a copy.
   */
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

  /*
   * The floor is re-applied on the side that owns the timer. The daemon clamps
   * too, but that constant belongs to the *daemon* — an older one with a lower
   * floor, or a field arriving from a build that predates the clamp, would
   * otherwise set an interval this tab has to honour.
   */
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
