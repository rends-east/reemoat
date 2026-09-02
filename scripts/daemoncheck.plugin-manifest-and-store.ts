import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest } from "../src/plugins/protocol.js";
import type { PluginDataStore } from "../src/plugins/store.js";
import { openStores } from "../src/store/sqlite.js";
import { tmp } from "./tmp.js";
import { check, report } from "./daemoncheck.env.js";
import { memoryPluginData } from "./daemoncheck.fixtures.js";

/* ------------------------------------------------------------------------- *
 * Plugins
 *
 * Everything here runs against a **fake `PluginRuntime`** rather than a real
 * `fork`, which is the reason that interface exists at all: a timeout, a crash,
 * an exhausted restart budget and a child that never answers are the paths that
 * matter, and none of them is reachable in an offline driver by spawning a
 * process and hoping. One case at the end drives the real `ForkedPluginRuntime`,
 * so the path production takes is walked rather than assumed.
 * ------------------------------------------------------------------------- */

process.stdout.write("\nwhat a plugin manifest may say\n");
{
  /*
   * ⚠ **The bounds are imported rather than retyped, and that is the whole reason
   * they are exported at all.** `manifest.ts` has no caller for them — nothing
   * outside that file compares a manifest against these — so before this line each
   * number was written down three times: in the comparison, in the refusal
   * sentence, and here as `"x".repeat(201)` beside the fragment `"name must be
   * 1–64"`. A driver that copies a bound is a driver that goes on asserting the old
   * one after somebody moves it, in green, which is the failure `envNameFor` and
   * `SETTING_KEYS` are pure for.
   */
  const {
    MAX_ACTIONS,
    MAX_ACTION_TITLE_CHARS,
    MAX_DESCRIPTION_CHARS,
    MAX_NAME_CHARS,
    MAX_NET_HOSTS,
    MAX_SCREEN_TITLE_CHARS,
    MAX_HARNESS_ARGS,
    MAX_AUTH_HINT_CHARS,
    parseManifest,
  } = await import("../src/plugins/manifest.js");
  const { PLUGIN_API_VERSION, negotiatePluginApi } = await import("../src/plugins/protocol.js");

  const base = {
    id: "board",
    name: "Task board",
    version: "0.1.0",
    api: PLUGIN_API_VERSION,
    scopes: ["store"],
    contributes: { screen: { title: "Board" }, settings: true, actions: [], hooks: ["turn.ended"] },
  };
  /** A contributed harness this reader accepts, so a case can break one field. */
  const CONTRIBUTED_HARNESS = {
    id: "gemini",
    name: "Gemini",
    command: "gemini",
    args: ["acp"],
    envNames: ["GEMINI_API_KEY"],
  };
  const of = (patch: Record<string, unknown>): ReturnType<typeof parseManifest> =>
    parseManifest(JSON.stringify({ ...base, ...patch }));
  const codeOf = (patch: Record<string, unknown>): string => {
    const answer = of(patch);
    return answer.ok ? "ok" : answer.code;
  };

  check("a manifest this daemon can run", codeOf({}), "ok");
  check("and it comes back parsed rather than as text", of({}).ok ? of({}) : null, {
    ok: true,
    manifest: {
      id: "board",
      name: "Task board",
      version: "0.1.0",
      api: PLUGIN_API_VERSION,
      description: null,
      scopes: ["store"],
      net: [],
      contributes: {
        screen: { title: "Board" },
        settings: true,
        actions: [],
        hooks: ["turn.ended"],
        // Synthesised, exactly as `actions` and `hooks` already are for a manifest
        // that wrote neither — and the empty arrays are load-bearing rather than
        // noise: `SqlitePluginRecordStore` re-validates `manifest_json` through
        // `parseManifest` on **every read**, so this output is also an input, and
        // an api gate that fired on a *present* key rather than a non-empty one
        // made every installed plugin vanish at the second read.
        harnesses: [],
        systems: [],
      },
    },
  });

  /*
   * ⚠ **And that round trip is asserted rather than assumed.** `toRecord` runs this
   * function over its own output on every read of the `plugins` table, so
   * `parseManifest` has to be idempotent — a rule nothing states and one release
   * broke, silently, in the direction where every plugin on the machine disappears
   * from `GET /plugins` after a restart.
   */
  check(
    "and running it over its own output changes nothing",
    (() => {
      const first = of({});
      if (!first.ok) return first;
      return parseManifest(JSON.stringify(first.manifest));
    })(),
    of({}),
  );

  /*
   * Every refusal, because the refusals are the whole value of that file — a
   * validator whose error paths are only reachable by building a real archive is
   * a validator whose error paths are not driven. This is what `parseManifest`
   * taking *text* rather than a path buys.
   */
  // Through one narrowing rather than two calls, so the type is what proves the
  // second read is on the refusal arm rather than the caller remembering.
  const rawCode = (text: string): string => {
    const answer = parseManifest(text);
    return answer.ok ? "ok" : answer.code;
  };
  check("not JSON at all", rawCode("{"), "manifest_unreadable");
  check("JSON that is not an object", rawCode("[]"), "manifest_unreadable");
  check("an id with a capital in it", codeOf({ id: "Board" }), "manifest_invalid");
  check("an id with a slash in it", codeOf({ id: "a/b" }), "manifest_invalid");
  check("an id that is empty", codeOf({ id: "" }), "manifest_invalid");
  check("no name", codeOf({ name: "" }), "manifest_invalid");
  check("a version that is not three numbers", codeOf({ version: "1.0" }), "manifest_invalid");
  check("a version with a suffix", codeOf({ version: "1.0.0-beta" }), "manifest_invalid");
  check("an api that is not a number", codeOf({ api: "1" }), "manifest_invalid");
  check("an unknown scope", codeOf({ scopes: ["sessions.admin"] }), "manifest_invalid");
  check("a scope listed twice", codeOf({ scopes: ["store", "store"] }), "manifest_invalid");
  check("an unknown hook", codeOf({ contributes: { ...base.contributes, hooks: ["session.slept"] } }), "manifest_invalid");
  check(
    "an action with no id",
    codeOf({ contributes: { ...base.contributes, actions: [{ title: "Go", on: "session" }] } }),
    "manifest_invalid",
  );
  check(
    "an action on a surface that does not exist",
    codeOf({ contributes: { ...base.contributes, actions: [{ id: "go", title: "Go", on: "rail" }] } }),
    "manifest_invalid",
  );
  check(
    "two actions with one id",
    codeOf({
      contributes: {
        ...base.contributes,
        actions: [
          { id: "go", title: "Go", on: "session" },
          { id: "go", title: "Go again", on: "screen" },
        ],
      },
    }),
    "manifest_invalid",
  );

  /*
   * `net` and its scope have to agree in **both** directions, and neither
   * direction is the obvious one on its own: hosts with no scope is a manifest
   * that under-declares, and a scope with no hosts is one that reads, to whoever
   * is approving it, as a plugin talking to nowhere.
   */
  check("hosts listed without the scope", codeOf({ net: ["api.example.com"] }), "manifest_invalid");
  check("the scope declared with no hosts", codeOf({ scopes: ["net"] }), "manifest_invalid");
  check("the scope declared with an empty list", codeOf({ scopes: ["net"], net: [] }), "manifest_invalid");
  check("both, agreeing", codeOf({ scopes: ["net"], net: ["api.example.com"] }), "ok");
  check("a host with a scheme on it", codeOf({ scopes: ["net"], net: ["https://api.example.com"] }), "manifest_invalid");
  check("a host with a port on it", codeOf({ scopes: ["net"], net: ["api.example.com:443"] }), "manifest_invalid");
  check("an address rather than a name", codeOf({ scopes: ["net"], net: ["127.0.0.1"] }), "manifest_invalid");
  check("a name for this machine", codeOf({ scopes: ["net"], net: ["thing.localhost"] }), "manifest_invalid");

  /*
   * The two api refusals are separate codes because their remedies are opposite:
   * too old means republish the plugin, too new means update the machine. One
   * "unsupported" sends half of everybody to the wrong place.
   */
  check("an api older than this daemon accepts", codeOf({ api: 0 }), "plugin_api_too_old");
  check("an api newer than it speaks", codeOf({ api: PLUGIN_API_VERSION + 1 }), "plugin_api_too_new");
  check(
    "and the negotiation itself is a range, not an equality",
    [negotiatePluginApi(PLUGIN_API_VERSION), negotiatePluginApi(PLUGIN_API_VERSION + 1), negotiatePluginApi(-1)],
    ["ok", "too_new", "too_old"],
  );

  // Absence is the one thing repaired rather than refused, because an omitted
  // optional has an obvious meaning and a wrong value does not.
  check("no contributes at all is a plugin that contributes nothing", of({ contributes: undefined }).ok, true);
  check("and no scopes is a plugin that may do nothing", of({ scopes: undefined }).ok, true);

  /* ---------------------------------------------------------------- *
   * The other eighteen.
   *
   * `manifest.ts` refuses in **eighty-two** places: nine in `parseManifest`
   * itself and seventy-three spread over the ten readers it delegates to. The
   * cases above drive nineteen. These are the other eighteen of the original
   * thirty-seven, plus three conditions *inside* branches those already reach from
   * the opposite side — a name too long rather than empty, an api that is a number
   * and not a whole one, a screen title that is only spaces. Most of what was
   * missing is the type refusals ("must be an array", "must be a string", "must be
   * true or false"), which is the half of a hand-written validator nobody writes a
   * case for and the half a `plugin.json` written by a person hits first.
   *
   * ⚠ **It was thirty-seven and stayed thirty-seven while forty-five landed**, and
   * that is the tripwire below failing rather than a number being untidy. The
   * release that let a plugin contribute a harness and a provider added
   * `readHarnesses` (13), `readSystems` (19), `readSystemModels` (6) and
   * `readEnvNames` (6), and one more in `readContributions` — none of which existed
   * at `fcfe914` — and this sentence did not move, so nothing said the inventory had
   * stopped describing the file. The type/shape half of the new readers was undriven
   * in **both** drivers as a result; the block at the end of this list is those
   * cases, and the contributed-*value* refusals (command shape, reserved argv,
   * envNames, apiType, baseUrl, metadata-service, nativeHarness/loginVia) are driven
   * in the contributions section further down.
   *
   * **How to re-derive it**, since the paragraph below is right that a grep for the
   * messages is a check on a regular expression: count `return` statements whose
   * value is a refusal — a bare string, a template literal, an `invalid(…)` or a
   * `{ ok: false, code }` — per enclosing declaration, skipping `invalid` itself and
   * the three `*ContributedId` helpers, whose string returns are ids rather than
   * refusals. That gives 9 + 73; the three in-branch conditions above are the
   * difference between 79 statements and the 82 stated here, exactly as they were
   * the difference between 34 and 37 before.
   *
   * ⚠ **Asserted on the sentence rather than on the code**, because twenty-eight
   * of the thirty-seven answer `manifest_invalid` and a case that reads only the
   * code proves a manifest was refused rather than that it was refused for the
   * reason it was written to catch — `{ contributes: { hooks: 7 } }` and
   * `{ contributes: 7 }` are the same code and different bugs. The fragment is
   * short on purpose: it names the branch and does not pin the prose around it.
   *
   * ⚠ **Nothing derives the thirty-seven and a thirty-eighth needs a line here.**
   * Those refusals are prose returned from five different helpers — a bare string,
   * a template literal, an `invalid(…)` and a `{ ok: false, code }` are all in
   * there — so a grep for them is a check on a regular expression rather than on
   * the file, which is the failure `docscheck` avoids by holding a file to what it
   * says about *itself*. The count is stated instead, and it is the reason this
   * comment is here rather than in a commit message.
   * ---------------------------------------------------------------- */
  const says = (name: string, patch: Record<string, unknown>, fragment: string): void => {
    const answer = of(patch);
    const message = answer.ok ? "(accepted)" : answer.message;
    report(name, message.includes(fragment), message);
  };
  const contributing = (patch: Record<string, unknown>): Record<string, unknown> => ({
    contributes: { ...base.contributes, ...patch },
  });

  says(
    "a description longer than a manifest carries",
    { description: "x".repeat(MAX_DESCRIPTION_CHARS + 1) },
    `description must be a string of at most ${MAX_DESCRIPTION_CHARS} characters`,
  );
  says("a name past its ceiling rather than empty", { name: "n".repeat(MAX_NAME_CHARS + 1) }, `name must be 1–${MAX_NAME_CHARS}`);
  says("an api that is a number and not a whole one", { api: 1.5 }, "api must be a whole number");
  says("scopes that are not a list", { scopes: "store" }, "scopes must be an array");
  says("a scope that is not a string", { scopes: [7] }, "every scope must be a string");
  says("net that is not a list", { scopes: ["net"], net: "api.example.com" }, "net must be an array");
  says("a net entry that is not a string", { scopes: ["net"], net: [7] }, "every net entry must be a string");
  says(
    "more hosts than a plugin talks to",
    { scopes: ["net"], net: Array.from({ length: MAX_NET_HOSTS + 1 }, (_, index) => `h${index}.example.com`) },
    `net may name at most ${MAX_NET_HOSTS} hosts`,
  );
  says(
    "the same host twice",
    { scopes: ["net"], net: ["api.example.com", "api.example.com"] },
    "is listed twice",
  );
  says("contributes that is a list", { contributes: [] }, "contributes must be an object");
  says("a screen that is a string", contributing({ screen: "Board" }), "contributes.screen must be an object");
  says(
    "a screen title past its own ceiling",
    contributing({ screen: { title: "t".repeat(MAX_SCREEN_TITLE_CHARS + 1) } }),
    `contributes.screen.title must be 1–${MAX_SCREEN_TITLE_CHARS} characters`,
  );
  says("a screen title of nothing", contributing({ screen: { title: "   " } }), "contributes.screen.title");
  says("settings that is neither", contributing({ settings: "yes" }), "contributes.settings must be true or false");
  says("actions that are not a list", contributing({ actions: {} }), "contributes.actions must be an array");
  /*
   * Eight, and the bound is on what a plugin may put on *somebody's screen*
   * rather than on what it costs to hold: a session's kebab menu has never held
   * eight rows, and a plugin able to declare forty would be a plugin able to make
   * that menu unusable for everything else on it.
   */
  says(
    "more actions than a menu has room for",
    contributing({
      actions: Array.from({ length: MAX_ACTIONS + 1 }, (_, index) => ({ id: `a${index}`, title: "Go", on: "session" })),
    }),
    `at most ${MAX_ACTIONS} actions`,
  );
  says("an action that is a string", contributing({ actions: ["go"] }), "every action must be an object");
  says(
    "an action with no title",
    contributing({ actions: [{ id: "go", title: "", on: "session" }] }),
    `needs a title of 1–${MAX_ACTION_TITLE_CHARS}`,
  );
  says("hooks that are not a list", contributing({ hooks: "turn.ended" }), "contributes.hooks must be an array");
  says("a hook that is not a string", contributing({ hooks: [7] }), "every hook must be a string");
  says("the same hook twice", contributing({ hooks: ["turn.ended", "turn.ended"] }), "is listed twice");

  /*
   * ⚠ **The type half of the two readers this release added**, which was driven by
   * neither driver. The contributions section further down drives what a
   * contributed harness or provider may *say* — command shape, reserved argv,
   * env names, apiType, baseUrl, the metadata-service refusal, the
   * nativeHarness/loginVia pairing — and every one of those cases hands
   * `parseManifest` a well-formed array of well-formed objects. So the branches a
   * hand-written `plugin.json` hits *first* were the ones with no case at all: a
   * block that is not an array, an entry that is not an object, and the three
   * per-field type refusals inside a harness.
   *
   * The scope on each is chosen to reach the branch under test rather than to be
   * realistic: `must be an array` is tested before the scope gate in both readers,
   * so those two keep the base's `store`, while `every … must be an object` sits
   * *after* it and needs the scope declared or it refuses for the other reason.
   */
  says("harnesses that are not a list", contributing({ harnesses: "gemini" }), "contributes.harnesses must be an array");
  says("systems that are not a list", contributing({ systems: 7 }), "contributes.systems must be an array");
  says(
    "a harness that is a string",
    { scopes: ["harness"], contributes: { harnesses: ["gemini"] } },
    "every harness must be an object",
  );
  says(
    "a system that is a string",
    { scopes: ["system"], contributes: { systems: ["groq"] } },
    "every system must be an object",
  );
  says(
    "a harness whose args are a string",
    { scopes: ["harness"], contributes: { harnesses: [{ ...CONTRIBUTED_HARNESS, args: "acp" }] } },
    "args must be an array",
  );
  says(
    "a harness passing more arguments than it may",
    {
      scopes: ["harness"],
      contributes: {
        harnesses: [
          {
            ...CONTRIBUTED_HARNESS,
            args: Array.from({ length: MAX_HARNESS_ARGS + 1 }, (_, index) => `a${index}`),
          },
        ],
      },
    },
    `may pass at most ${MAX_HARNESS_ARGS} arguments`,
  );
  says(
    "a harness whose authHint is a number",
    { scopes: ["harness"], contributes: { harnesses: [{ ...CONTRIBUTED_HARNESS, authHint: 7 }] } },
    `authHint must be a string of at most ${MAX_AUTH_HINT_CHARS} characters`,
  );

  /* ---------------------------------------------------------------- *
   * And the last character each of them allows, which is the half that makes the
   * import above load-bearing.
   *
   * ⚠ **Every case above is one character *past* a ceiling, and a validator that
   * refused one character early would pass all of them.** Off by one in that
   * direction is the silent version — a plugin whose name is exactly 64 characters
   * simply cannot be installed, with a sentence saying names may be 1–64 — and it
   * is only reachable by asserting the accept beside the refusal. Derived from the
   * same constants, so the pair moves together or not at all.
   * ---------------------------------------------------------------- */
  const atTheLine: [string, Record<string, unknown>][] = [
    ["a name of exactly its ceiling", { name: "n".repeat(MAX_NAME_CHARS) }],
    ["a description of exactly its ceiling", { description: "x".repeat(MAX_DESCRIPTION_CHARS) }],
    ["a screen title of exactly its ceiling", contributing({ screen: { title: "t".repeat(MAX_SCREEN_TITLE_CHARS) } })],
    [
      "an action title of exactly its ceiling",
      contributing({ actions: [{ id: "go", title: "g".repeat(MAX_ACTION_TITLE_CHARS), on: "session" }] }),
    ],
    [
      "exactly as many actions as a menu holds",
      contributing({
        actions: Array.from({ length: MAX_ACTIONS }, (_, index) => ({ id: `a${index}`, title: "Go", on: "session" })),
      }),
    ],
    [
      "exactly as many hosts as a plugin talks to",
      { scopes: ["net"], net: Array.from({ length: MAX_NET_HOSTS }, (_, index) => `h${index}.example.com`) },
    ],
  ];
  check(
    "each bound accepts its own last character rather than stopping one short",
    Object.fromEntries(atTheLine.map(([name, patch]) => [name, codeOf(patch)])),
    Object.fromEntries(atTheLine.map(([name]) => [name, "ok"])),
  );
}

process.stdout.write("\nwhat a plugin may keep\n");
{
  const {
    checkPluginWrite,
    MAX_PLUGIN_KEYS,
    MAX_PLUGIN_DATA_BYTES,
    MAX_PLUGIN_KEY_CHARS,
    MAX_PLUGIN_VALUE_BYTES,
    PluginStoreError,
  } = await import("../src/plugins/store.js");

  const refusal = (
    key: string,
    value: string,
    current: { keys: number; bytes: number; existing: number | null },
  ): string => {
    try {
      checkPluginWrite(key, value, current);
      return "ok";
    } catch (error) {
      return error instanceof PluginStoreError ? error.code : "threw";
    }
  };
  const empty = { keys: 0, bytes: 0, existing: null };

  check("an ordinary write", refusal("a", "1", empty), "ok");
  check("an empty key", refusal("", "1", empty), "bad_request");
  check("a key with a newline in it", refusal("a\nb", "1", empty), "bad_request");
  check("a key with a NUL in it", refusal("a\u0000b", "1", empty), "bad_request");
  /*
   * ⚠ **The one bound in that file no case reached, and the only one a plugin
   * author trips over by accident.** Three of the four here are imported and this
   * one was written nowhere — so `MAX_PLUGIN_KEY_CHARS` could have moved in either
   * direction and every line in this section would have gone on passing. The pair
   * is what makes it a bound rather than a number: one short of it refuses a key
   * the sentence promises, one long of it is a ceiling nobody enforces.
   *
   * ⚠ **And it is `key.length`, i.e. UTF-16 code units, against a constant named
   * `CHARS`** — deliberately, and unlike the byte accounting one field over: what
   * this bounds is a label somebody reads, and `plugins.md` prints it as "200
   * chars per key". The astral case therefore costs two of the two hundred, which
   * is the same thing every editor's column count would say.
   */
  check("a key of exactly the length a key may be", refusal("k".repeat(MAX_PLUGIN_KEY_CHARS), "1", empty), "ok");
  check("and one character past it", refusal("k".repeat(MAX_PLUGIN_KEY_CHARS + 1), "1", empty), "bad_request");
  check("a value over the per-value cap", refusal("a", "x".repeat(MAX_PLUGIN_VALUE_BYTES + 1), empty), "value_too_large");
  check(
    "a write that would take the plugin over its total",
    refusal("a", "x".repeat(1000), { keys: 1, bytes: MAX_PLUGIN_DATA_BYTES, existing: null }),
    "store_full",
  );
  /*
   * The replaced value is credited back before the new one is charged. Without
   * that, a plugin rewriting one key climbs to its own ceiling and stays there —
   * which is the shape of every settings pane written against this API.
   */
  check(
    "but rewriting a key charges only the difference",
    refusal("a", "x".repeat(1000), { keys: 1, bytes: MAX_PLUGIN_DATA_BYTES, existing: 1000 }),
    "ok",
  );
  check(
    "a new key past the key ceiling",
    refusal("new", "1", { keys: MAX_PLUGIN_KEYS, bytes: 0, existing: null }),
    "store_full",
  );
  check(
    "and rewriting an existing one is still allowed there",
    refusal("held", "1", { keys: MAX_PLUGIN_KEYS, bytes: 0, existing: 1 }),
    "ok",
  );

  /*
   * ⚠ **And the row a plugin author actually reads, held to the four constants
   * that produce it.** `docs/PLUGINS.md`'s bounds table is the only place any of
   * these appears to the person writing against them — nothing on a screen, in a
   * header or in a refusal says what the ceilings are before one is met — so a
   * bound that moved without that table moving is a published contract this daemon
   * has quietly stopped keeping. `MAX_PLUGIN_KEY_CHARS` is the reason this line
   * exists: it had no reader outside `store.ts` at all, in source or in a driver.
   *
   * Here rather than in `docscheck` for the reason the ask bounds give at greater
   * length: that driver's subject is prose held to what it says about *itself*,
   * and this is prose held to a number in `src/`, which is a fact about the daemon
   * and belongs beside the assertions that drive it.
   */
  const authored = readFileSync(new URL("../docs/PLUGINS.md", import.meta.url), "utf8");
  const stated =
    `${MAX_PLUGIN_DATA_BYTES / 1024 / 1024} MiB per plugin, ${MAX_PLUGIN_VALUE_BYTES / 1024} KiB per value, ` +
    `${MAX_PLUGIN_KEYS} keys, ${MAX_PLUGIN_KEY_CHARS} characters per key`;
  report("what PLUGINS.md tells an author a store holds is what it holds", authored.includes(stated), stated);
}

process.stdout.write("\nwhere a plugin's data actually lives\n");
{
  const { MAX_PLUGIN_DATA_BYTES, MAX_PLUGIN_KEYS, MAX_PLUGIN_VALUE_BYTES, PluginStoreError } = await import(
    "../src/plugins/store.js"
  );
  const { SqlitePluginDataStore, openStores } = await import("../src/store/sqlite.js");

  /**
   * One script, run against both implementations and compared line for line.
   *
   * ⚠ **The comparison is the point, and it is why this is a function rather than
   * a run of assertions.** Everything above this in the plugin sections drives the
   * host, the API and the quota against `memoryPluginData`, so the whole of what
   * `daemoncheck` knows about a plugin's storage is what a Map does — while what
   * the fleet runs is `LIKE … ESCAPE`, a keyset cursor and a byte budget charged
   * per row. Two of those cannot be reproduced by a Map on purpose, which is
   * exactly why the script is run against the real store *first*: the fake is
   * being held to SQLite rather than the other way round.
   *
   * A labelled record rather than an array, so a mismatch names the property
   * instead of an index and so the readouts below can be asserted one at a time.
   */
  const script = (store: PluginDataStore): Record<string, unknown> => {
    const refusal = (run: () => void): string => {
      try {
        run();
        return "ok";
      } catch (error) {
        return error instanceof PluginStoreError ? error.code : "threw";
      }
    };

    // Two plugins, one key name. Neither may see the other's, and nothing in the
    // API namespaces this — `manifest.id` is passed down and the store is what
    // keeps them apart.
    const sameKey = [
      refusal(() => store.set("one", "shared", JSON.stringify("first"))),
      refusal(() => store.set("two", "shared", JSON.stringify("second"))),
      store.get("one", "shared"),
      store.get("two", "shared"),
    ];

    /*
     * ⚠ **A key holding `%` or `_` is a key somebody wrote.** Those are `LIKE`'s
     * two wildcards, so a prefix built without the escape matches every row the
     * plugin has — `a%` would answer for `axb` and `ab` as readily as for the one
     * key it names. The fake filters with `startsWith` and *cannot* reproduce the
     * bug, which is what makes this the one property in this file that had to be
     * driven against the real store or not at all.
     */
    for (const key of ["a%b", "axb", "a_b", "ab"]) refusal(() => store.set("one", key, JSON.stringify(key)));

    /*
     * ⚠ **Mixed case, because `LIKE` folds ASCII and this column does not** — and
     * because the comment in `store/sqlite.ts` that records this defect also
     * records why the assertion above did not catch it: the fake filters with
     * `startsWith`, which is case sensitive, so **the parity line at the bottom of
     * this block passed only while every fixture key was lower case**. That is a
     * gap described in prose and left open, which is the one shape of gap this
     * file exists to close.
     *
     * These are the three keys the defect was measured with, in the order it
     * answered them: against this exact DDL `LIKE 'card:%'` gave
     * `['CARD:3', 'Card:2', 'card:1']` where the plugin had named one namespace
     * and `card:1` was the only key in it. A third plugin id so that nothing above
     * moves — `everyKey` and `unprefixed` are asserted as literals.
     */
    for (const key of ["CARD:3", "Card:2", "card:1"]) {
      refusal(() => store.set("three", key, JSON.stringify(key)));
    }

    const bounds = [
      // The shared bound, met from the far side: a value one byte past the cap,
      // an empty key, a key holding a control character.
      refusal(() => store.set("one", "big", JSON.stringify("x".repeat(MAX_PLUGIN_VALUE_BYTES)))),
      refusal(() => store.set("one", "", JSON.stringify("x"))),
      refusal(() => store.set("one", `a${String.fromCharCode(10)}b`, JSON.stringify("x"))),
    ];

    /*
     * Six rows of four thousand bytes against a ten-thousand-byte budget, which
     * puts the cut two rows in and leaves the third to the next page. Coarse on
     * purpose: SQLite charges twenty bytes of scaffolding a pair that the fake
     * does not, so a fixture whose rows were a few bytes each would have the two
     * implementations cutting in different places for a reason that says nothing
     * about either of them.
     */
    for (let index = 0; index < 6; index += 1) {
      refusal(() => store.set("two", `card:${index}`, JSON.stringify("y".repeat(4_000))));
    }
    refusal(() => store.set("two", "note", JSON.stringify("not a card")));
    const first = store.entries("two", "card:", "", 10_000);
    // The cursor is the last key of the page, echoed back rather than computed —
    // a caller deriving the next one itself is a caller guessing at a collation.
    const second = store.entries("two", "card:", String(first.entries.at(-1)?.key ?? ""), 10_000);
    const rest = store.entries("two", "card:", String(second.entries.at(-1)?.key ?? ""), 10_000);

    const answer = {
      sameKey,
      percentPrefix: store.keys("one", "a%"),
      // The half-open binary range against the same prefix, read both ways: a
      // regression to `LIKE` takes all three on SQLite and one on the fake, so it
      // fails the literal below *and* the parity line.
      casedPrefix: store.keys("three", "card:"),
      casedEntries: store.entries("three", "card:", "", 1_000_000).entries.map((one) => one.key),
      underscorePrefix: store.keys("one", "a_"),
      everyKey: store.keys("one", "a"),
      bounds,
      page: [first.entries.map((one) => one.key), first.more],
      nextPage: [second.entries.map((one) => one.key), second.more],
      lastPage: [rest.entries.map((one) => one.key), rest.more],
      // The prefix is a filter on the page as well as on the listing, or a board
      // reading its cards would get whatever else that plugin keeps. Asked with a
      // budget nothing can cut, so what this shows is the two rows the three
      // `card:` pages above never saw rather than a page that ended early.
      unprefixed: store.entries("two", "", "", 1_000_000).entries.map((one) => one.key),
      // What one card actually is, so this is a page of *pairs* rather than of
      // keys with a shape asserted about them.
      firstValue: first.entries[0]?.value === "y".repeat(4_000),
    };

    // Uninstalling is the only thing that drops data, and it drops one plugin's.
    store.dropPlugin("one");
    return { ...answer, afterDrop: [store.keys("one", ""), store.keys("two", "").length] };
  };

  const stores = openStores({ path: join(tmp("plugin-data-"), "d.db"), instanceId: "i_plugin_data" });
  const real = script(stores.pluginData);

  /*
   * ⚠ **What a key nobody set reads as, pinned on both implementations at once.**
   *
   * `PluginDataStore.get` is typed `unknown`, so the type promises nothing and a
   * plugin author has to guess. One guessed `undefined`, wrote `held !== undefined`
   * as an idempotency check, and every session took the "already done" branch —
   * for weeks, silently, because a hook that returns early leaves no key, no log
   * and no history to distinguish it from a hook that was never called. The whole
   * plugin looked dead while every part of the daemon was working.
   *
   * The two implementations already agreed — SQLite answers `null`, and
   * `memoryPluginData` answers `null` — and **nothing said so**. Two stores behind
   * one interface, agreeing by coincidence, is the pair this file exists to stop
   * drifting, and it was the one pair with no assertion on it.
   *
   * ⚠ **A stored `null` is indistinguishable from a key nobody set**, which is
   * asserted rather than left to be discovered: a plugin that needs the difference
   * has to store a wrapper, and this is the line that tells its author so before
   * they find out from a bug.
   */
  {
    const fake = memoryPluginData();
    for (const [name, store] of [["sqlite", stores.pluginData], ["the driver's own", memoryPluginData()]] as const) {
      check(`a key nobody set reads as null on ${name}, never undefined`, store.get("p", "no_such_key"), null);
    }
    fake.set("p", "held", JSON.stringify(null));
    stores.pluginData.set("p", "held", JSON.stringify(null));
    check("a stored null is the same answer as a missing key, on both", [fake.get("p", "held"), stores.pluginData.get("p", "held")], [null, null]);
    // And the value that is *not* null round-trips, so the two lines above are not
    // green about a store that answers null to everything.
    fake.set("p", "real", JSON.stringify({ a: 1 }));
    stores.pluginData.set("p", "real", JSON.stringify({ a: 1 }));
    check("while an ordinary value comes back as itself", [fake.get("p", "real"), stores.pluginData.get("p", "real")], [{ a: 1 }, { a: 1 }]);
  }

  check("one plugin's key and another's of the same name", real["sameKey"], ["ok", "ok", "first", "second"]);
  check("a prefix holding a % names one key rather than every key", real["percentPrefix"], ["a%b"]);
  check("a prefix is case sensitive, because the column is", real["casedPrefix"], ["card:1"]);
  check("and the paged read agrees with the listing about that", real["casedEntries"], ["card:1"]);
  check("and one holding an _ likewise", real["underscorePrefix"], ["a_b"]);
  check("while a prefix holding neither takes them all", real["everyKey"], ["a%b", "a_b", "ab", "axb"]);
  check("the bounds are the shared ones", real["bounds"], ["value_too_large", "bad_request", "bad_request"]);
  check("a page cut by the byte budget says so", real["page"], [["card:0", "card:1"], true]);
  check("and asking again with the last key continues rather than repeats", real["nextPage"], [["card:2", "card:3"], true]);
  check("until there is nothing left to say more about", real["lastPage"], [["card:4", "card:5"], false]);
  check("the prefix filters the page as well as the listing", real["unprefixed"], [
    "card:0",
    "card:1",
    "card:2",
    "card:3",
    "card:4",
    "card:5",
    "note",
    "shared",
  ]);
  check("and a page is pairs rather than keys", real["firstValue"], true);
  check("dropping one plugin takes its rows and only its rows", real["afterDrop"], [[], 8]);

  /*
   * ⚠ **And the fake this driver runs everything else against answers the same.**
   * `checkPluginWrite` is shared for exactly this — a quota that holds only where
   * there is a file is a quota nothing drives — and `entries` makes the same claim
   * about paging. Without this line the fake could drift into refusing less or
   * paging differently, and every plugin assertion in this file would go on
   * passing while describing a store nobody runs.
   */
  check("and the memory store the rest of this file uses answers all of it", script(memoryPluginData()), real);

  /* ---------------------------------------------------------------- *
   * Where a prefix stops, at the one code point that is not one more than itself.
   *
   * ⚠ **The range's upper bound was `at + 1` and that is wrong at exactly one
   * place: U+D7FF, the code point below the surrogate block.** A JS string holds
   * UTF-16 code units and this column holds UTF-8, and the two disagree about
   * D800–DFFF — `node:sqlite` binds a *lone* surrogate as U+FFFD rather than as
   * its own three bytes. So the successor of a prefix ending U+D7FF was computed
   * as U+D800, arrived at SQLite as U+FFFD, and the half-open range swallowed the
   * whole of E000–FFFC on the way: a plugin asking for one namespace was handed
   * every private-use key it holds as well.
   *
   * ⚠ **The parity line above cannot see any of this, and that is why this block
   * is separate rather than five more fixtures inside `script`.** Every key in
   * that script is ASCII, and the fake filters with `startsWith` — so the range
   * arithmetic is never asked a question whose answer depends on the encoding, and
   * the two implementations agreed by never being made to differ. Held to
   * `startsWith` directly here, which is the definition of a prefix and is what
   * the caller believes it asked for.
   * ---------------------------------------------------------------- */
  {
    const edge = ["\uD7FFa", "\uD7FFb", "\uE000private", "\uF8FFapple", "\uFFFCobj"];
    const fake = memoryPluginData();
    for (const key of edge) {
      stores.pluginData.set("edge", key, JSON.stringify(key));
      fake.set("edge", key, JSON.stringify(key));
    }
    /*
     * Named, so a mismatch says which prefix rather than which array index. All
     * five are BMP and none is a surrogate, which keeps SQLite's UTF-8 byte order
     * and JS's UTF-16 code-unit order agreeing — an astral key here would make the
     * `.sort()` below the thing under test instead of the range.
     *
     * Written as `\uXXXX` throughout rather than as the characters themselves:
     * two of these five are unprintable and one is private use, so pasted
     * literally they are a blank space a reader cannot check and an editor is free
     * to normalise.
     */
    const around: [string, string][] = [
      ["one below the surrogates", "\uD7FF"],
      ["the first code point above them", "\uE000"],
      ["inside the private use area", "\uF8FF"],
      ["in specials, below the replacement character", "\uFFFC"],
      ["and no prefix at all", ""],
    ];
    const walk = (store: PluginDataStore): Record<string, string[]> =>
      Object.fromEntries(around.map(([name, prefix]) => [name, store.keys("edge", prefix)]));
    const byHand = Object.fromEntries(
      around.map(([name, prefix]) => [name, edge.filter((key) => key.startsWith(prefix)).sort()]),
    );
    check("a prefix around the surrogate block names what startsWith names", walk(stores.pluginData), byHand);
    check("and the memory store this file runs on answers the same", walk(fake), byHand);

    /*
     * ⚠ **The other arm, and the only one the fake genuinely cannot reproduce:
     * the prefix's own last code point being a lone surrogate.** `[...prefix]`
     * yields one, `JSON.parse` carries `"\ud800"` through intact and nothing on
     * the way here refuses it — and the bind has already turned it into U+FFFD by
     * the time the comparison happens, which is why the successor is U+FFFE
     * rather than one past a code point that never arrived. With `at + 1` both
     * ends of the range bound as U+FFFD's bytes and the answer was **empty for a
     * row sitting right there**.
     *
     * Against SQLite alone, deliberately: the fake keeps the lone surrogate the
     * caller wrote, so the two stores disagree about what the *key* is before
     * anything asks what a prefix names. That is a property of the bind rather
     * than of the range, it is measured here rather than asserted as parity, and
     * the round-trip below is what says so out loud.
     */
    stores.pluginData.set("edge", "\uD800zz", JSON.stringify("lone"));
    check(
      "a lone surrogate in a key reaches the column as the replacement character",
      stores.pluginData.keys("edge", "\uFFFD"),
      ["\uFFFDzz"],
    );
    check("and the prefix that wrote it still finds it", stores.pluginData.keys("edge", "\uD800"), ["\uFFFDzz"]);
    check(
      "under either spelling",
      [stores.pluginData.get("edge", "\uD800zz"), stores.pluginData.get("edge", "\uFFFDzz")],
      ["lone", "lone"],
    );
  }

  /* ---------------------------------------------------------------- *
   * The quota, against a running pair rather than a fresh count.
   *
   * ⚠ **`set` used to answer `COUNT(*), SUM(LENGTH(...))` on every single write,
   * and the pair it carries instead is what makes filling a store linear** —
   * measured at `MAX_PLUGIN_KEYS`, 42.9 ms → 2.3 ms, with the shape rather than
   * the ratio as the evidence: doubling the rows used to roughly quadruple the
   * time. What that buys in speed it owes in truth, and the debt is the subject
   * here: the refusal now rests on a number this class is *keeping* rather than on
   * one the table has just answered, and a running pair that drifts is a ceiling
   * that has moved without anybody saying so.
   *
   * So none of this asserts the arithmetic — `checkPluginWrite` has its own
   * section for that, against both implementations. What is asserted is **where it
   * refuses**, walked over the three mutations that move the pair (`set`, `delete`
   * and `dropPlugin`) and then asked again through a second store object built
   * over the same open database, which is what a daemon restart is.
   * ---------------------------------------------------------------- */
  {
    const refusal = (run: () => void): string => {
      try {
        run();
        return "ok";
      } catch (error) {
        return error instanceof PluginStoreError ? error.code : "threw";
      }
    };
    // Derived from the two constants rather than written down, so a ceiling that
    // moves moves the fixture with it: a value whose JSON is exactly the per-value
    // cap, and however many of those the per-plugin total holds.
    const value = JSON.stringify("x".repeat(MAX_PLUGIN_VALUE_BYTES - 2));
    const fits = Math.floor(MAX_PLUGIN_DATA_BYTES / MAX_PLUGIN_VALUE_BYTES);
    report(
      "the fixture meets the ceiling exactly rather than near it",
      Buffer.byteLength(value, "utf8") === MAX_PLUGIN_VALUE_BYTES && fits * MAX_PLUGIN_VALUE_BYTES === MAX_PLUGIN_DATA_BYTES,
      `${fits} values of ${Buffer.byteLength(value, "utf8")} bytes against ${MAX_PLUGIN_DATA_BYTES}`,
    );

    const filled = new Set(
      Array.from({ length: fits }, (_, index) => refusal(() => stores.pluginData.set("quota", `k${index}`, value))),
    );
    check("a plugin fills its store to the byte", [...filled], ["ok"]);
    check("and the write after that is refused", refusal(() => stores.pluginData.set("quota", "over", value)), "store_full");
    // The credit-back, through the pair rather than through a fresh sum: a `set`
    // that charged without crediting climbs 64 KiB a write while the table never
    // moves, which is every settings pane written against this API.
    check(
      "while rewriting a key it already holds is not a new charge",
      refusal(() => stores.pluginData.set("quota", "k0", value)),
      "ok",
    );

    /*
     * ⚠ **A `delete` as the first thing a store object ever does to this plugin,
     * because that is the ordering the pair can get wrong and nothing else
     * reaches it.** A restarted daemon whose plugin clears a key it wrote in a
     * previous life seeds `usage` on that call — and seeding it *after* the
     * statement seeds it from a table the delete has already changed, then
     * subtracts the same row a second time. Measured at exactly this fixture:
     * the store then took **two** more values where one fits and sat at
     * 1,114,112 bytes under a 1,048,576-byte ceiling. A quota a restart widens is
     * not a quota, which is why the second line is here rather than only the
     * first: "one write came back" passes against both.
     */
    const restarted = new SqlitePluginDataStore(stores.db);
    restarted.delete("quota", "k0");
    check("a store that has just come up credits a delete exactly once", refusal(() => restarted.set("quota", "k0", value)), "ok");
    check("and not twice", refusal(() => restarted.set("quota", "spare", value)), "store_full");

    // Uninstalling gives the whole budget back, and `dropPlugin` forgets the entry
    // rather than zeroing it — so this also drives the reseed, over a row set the
    // drop really did empty.
    restarted.dropPlugin("quota");
    const again = new Set(
      Array.from({ length: fits }, (_, index) => refusal(() => restarted.set("quota", `k${index}`, value))),
    );
    check("an uninstall gives the whole budget back", [...again], ["ok"]);
    check("up to the same ceiling and no further", refusal(() => restarted.set("quota", "over", value)), "store_full");

    /*
     * The other ceiling on the same pair, and it is the half a byte count cannot
     * see: a thousand one-byte values is nothing in bytes and is a thousand rows.
     * Cheap enough to drive at the real bound only because of the change this
     * block is about — `MAX_PLUGIN_KEYS` writes against the old full re-scan is
     * the 42.9 ms case, per write.
     */
    const counted = new SqlitePluginDataStore(stores.db);
    const rows = new Set(
      Array.from({ length: MAX_PLUGIN_KEYS }, (_, index) => refusal(() => counted.set("count", `k${index}`, "1"))),
    );
    check("a plugin may hold exactly as many keys as it is allowed", [...rows], ["ok"]);
    check("and the next key is refused", refusal(() => counted.set("count", "one-more", "1")), "store_full");
    check("while rewriting one of them is not", refusal(() => counted.set("count", "k0", "2")), "ok");
  }

  stores.close();
}

process.stdout.write("\nwhat a restart collects that a half-finished uninstall left\n");
{
  /*
   * ⚠ **`plugin_data` was the one child table in `store/sqlite.ts` with no orphan
   * sweep**, and the two deletes that should keep it consistent are written in
   * another file: `host.ts` runs `records.remove(id)` and then `data.dropPlugin(id)`
   * as two implicit transactions with no BEGIN around them, in `doRemove` and again
   * in the install rollback. A throw from either, a SIGKILL between them, or a
   * backup taken between them strands up to `MAX_PLUGIN_KEYS` rows under an id with
   * no plugin.
   *
   * **Stranded there means stranded for ever**, which is what makes this worse than
   * the `uploads` case beside it: afterwards `installed()` is false on both halves —
   * no row, and no directory under the plugin root — so `DELETE /plugins/:id` can
   * never reach `dropPlugin` again. And the rows are not inert: `plugin_data` is
   * keyed on the id and never on the version, deliberately, so that an update keeps
   * it — which means the next install of that id inherits somebody else's keys
   * against its own quota.
   *
   * Driven as the restart it is: the rows are stranded against a live database, the
   * stores are closed, and the file is opened again. `prune()` runs inside
   * `openStores` before `SqlitePluginDataStore` is constructed and long before any
   * `PluginHost` exists, so there is nothing running for it to race — which is what
   * lets it be a blunt `DELETE` rather than a reconciliation.
   */
  const orphanPath = join(tmp("plugin-orphan-"), "d.db");
  const manifestOf = (id: string, api = 1): unknown => ({
    id,
    name: id,
    version: "1.0.0",
    api,
    scopes: [],
    contributes: {},
  });

  {
    const { parseManifest } = await import("../src/plugins/manifest.js");
    const first = openStores({ path: orphanPath, instanceId: "i_orphan_a" });
    for (const id of ["board", "ghost", "veiled"]) {
      const parsed = parseManifest(JSON.stringify(manifestOf(id)));
      if (!parsed.ok) throw new Error(parsed.message);
      first.plugins.put({
        id,
        version: "1.0.0",
        manifest: parsed.manifest,
        enabled: false,
        installedAt: 1,
        updatedAt: 1,
        source: null,
      });
      for (let index = 0; index < 5; index += 1) first.pluginData.set(id, `k${index}`, JSON.stringify(index));
    }
    /*
     * ⚠ **A row this build cannot validate is not an uninstalled plugin, and the
     * sweep asks the *table* rather than `records.list()` for exactly this.**
     * `list` reports such a row through `onDegraded` and skips it, `get` answers
     * `null`, and `has` is the method that exists because neither of those can
     * tell "never installed" from "installed and unreadable here". A sweep built
     * on `list` would make a daemon downgrade a data loss — silently, on the boot
     * that rolled back.
     */
    first.db
      .prepare("UPDATE plugins SET manifest_json = ? WHERE id = ?")
      .run(JSON.stringify(manifestOf("veiled", 9_999)), "veiled");
    // The half-completed uninstall itself: the row goes, the data does not.
    first.db.prepare("DELETE FROM plugins WHERE id = ?").run("ghost");
    check(
      "before the restart the machine holds keys under an id with no plugin",
      [first.pluginData.keys("board", "").length, first.pluginData.keys("ghost", "").length],
      [5, 5],
    );
    first.close();
  }

  const degraded: string[] = [];
  const after = openStores({ path: orphanPath, instanceId: "i_orphan_b", onDegraded: (detail) => degraded.push(detail) });
  check("the stranded rows are collected", after.pluginData.keys("ghost", ""), []);
  check("and every other plugin's are untouched", after.pluginData.keys("board", ""), ["k0", "k1", "k2", "k3", "k4"]);
  /*
   * The downgrade half, and it is the assertion that keeps the sweep from being
   * written the obvious way: `veiled` is absent from `list()` and present in the
   * table, so a sweep reading the record store would have destroyed it here.
   */
  check("a plugin this build cannot read is not a plugin that was uninstalled", after.plugins.list().map((one) => one.id), ["board"]);
  check("its row is still a row", [after.plugins.has("veiled"), after.plugins.has("ghost")], [true, false]);
  check("and everything it kept is still there", after.pluginData.keys("veiled", ""), ["k0", "k1", "k2", "k3", "k4"]);
  report(
    "with somebody told why it vanished from the listing",
    degraded.some((one) => one.includes("plugin veiled") && one.includes("cannot read")),
    degraded[0] ?? "nothing reported",
  );
  after.close();
}

process.stdout.write("\na plugin row this build cannot read\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");
  const { openStores } = await import("../src/store/sqlite.js");

  const manifestFor = (id: string): PluginManifest => {
    const parsed = parseManifest(
      JSON.stringify({ id, name: id, version: "1.0.0", api: 1, scopes: [], contributes: {} }),
    );
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.manifest;
  };

  const degraded: string[] = [];
  const stores = openStores({
    path: join(tmp("plugin-degraded-"), "d.db"),
    instanceId: "i_degraded",
    onDegraded: (detail) => degraded.push(detail),
  });
  for (const id of ["p", "q"]) {
    stores.plugins.put({
      id,
      version: "1.0.0",
      manifest: manifestFor(id),
      // Off, so opening the host below launches nothing: what is being driven is
      // a row rather than a process.
      enabled: false,
      installedAt: 1,
      updatedAt: 1,
      source: null,
    });
  }
  check("two rows, both readable", stores.plugins.list().map((one) => one.id), ["p", "q"]);
  check("and nothing to report about either", degraded.length, 0);

  /*
   * ⚠ **A downgrade, and nothing more exotic than that.** Install a plugin
   * declaring `api: 2`, roll the daemon back to a build whose
   * `PLUGIN_API_VERSION` is 1, and `negotiatePluginApi` answers `too_new` for a
   * row that was perfectly good yesterday. Written straight into the column here
   * because this build has no future api to declare — the manifest is what a
   * newer daemon would have written, and `toRecord` re-validates on **every**
   * read, which is the whole reason that column holds the manifest whole rather
   * than a field per column.
   */
  stores.db
    .prepare("UPDATE plugins SET manifest_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...manifestFor("p"), api: 9_999 }), "p");
  stores.pluginData.set("p", "card:1", JSON.stringify("kept"));

  check("the listing skips it", stores.plugins.list().map((one) => one.id), ["q"]);
  check("and so does get", stores.plugins.get("p"), null);
  report(
    "but somebody is told, once per read rather than never",
    degraded.some((one) => one.includes("plugin p") && one.includes("cannot read")),
    degraded[0] ?? "nothing reported",
  );
  /*
   * ⚠ **`has` is the method that exists because `get` cannot answer this.** Both
   * `list` and `get` report `null` for a row they cannot parse, so neither can
   * tell "nobody ever installed this" from "installed here, and unreadable by
   * this build" — and that difference is the whole of what `remove` is asking.
   * `SELECT 1`, so it parses nothing.
   */
  check("the row is still a row", [stores.plugins.has("p"), stores.plugins.has("nobody")], [true, false]);

  const registry = new SessionRegistry(stores.events, stores.sessions);
  const host = await PluginHost.open({
    root: join(tmp("plugin-degraded-root-"), "plugins"),
    records: stores.plugins,
    data: stores.pluginData,
    registry,
    api: { git: hostGit },
  });
  check("the host builds nothing for it", host.list().map((one) => one.id), ["q"]);
  check("and cannot find it", host.find("p"), null);

  /*
   * ⚠ **The one kind of plugin somebody most wants gone used to be the one kind
   * that needed a shell.** `remove` consulted `this.live`, which never held this
   * row, so `DELETE /plugins/:id` answered 404 and the row, its `plugin_data` and
   * its directory stayed on the machine for good. Falling through to the store is
   * what closes it, and the assertions after it are the closing half: a 404 that
   * turned into a 200 while leaving the row behind would be worse than the 404.
   */
  check("removing it is still possible", await host.remove("p"), true);
  check("the row goes", stores.plugins.has("p"), false);
  check("what it kept goes with it", stores.pluginData.keys("p", ""), []);
  check("its readable neighbour does not", host.list().map((one) => one.id), ["q"]);
  // The other half of the fall-through, and the reason it is not simply `true`:
  // an id nobody ever installed has no row and no directory either.
  check("and an id nobody ever installed is still a no", await host.remove("nothing"), false);

  await host.shutdown();
  await registry.shutdown();
  stores.close();
}
