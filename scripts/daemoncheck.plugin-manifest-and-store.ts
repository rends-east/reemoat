import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest } from "../src/plugins/protocol.js";
import type { PluginDataStore } from "../src/plugins/store.js";
import { openStores } from "../src/store/sqlite.js";
import { tmp } from "./tmp.js";
import { check, report } from "./daemoncheck.env.js";
import { memoryPluginData } from "./daemoncheck.fixtures.js";

process.stdout.write("\nwhat a plugin manifest may say\n");
{
  // Imported rather than retyped, so a moved bound cannot leave this driver asserting the old one.
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
        // Synthesised empty: toRecord re-parses this output on every read, so an api gate must fire on a non-empty block, not a present key.
        harnesses: [],
        systems: [],
      },
    },
  });

  // parseManifest must be idempotent: toRecord runs it over its own output on every read of the plugins table.
  check(
    "and running it over its own output changes nothing",
    (() => {
      const first = of({});
      if (!first.ok) return first;
      return parseManifest(JSON.stringify(first.manifest));
    })(),
    of({}),
  );

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

  // net and its scope must agree in both directions.
  check("hosts listed without the scope", codeOf({ net: ["api.example.com"] }), "manifest_invalid");
  check("the scope declared with no hosts", codeOf({ scopes: ["net"] }), "manifest_invalid");
  check("the scope declared with an empty list", codeOf({ scopes: ["net"], net: [] }), "manifest_invalid");
  check("both, agreeing", codeOf({ scopes: ["net"], net: ["api.example.com"] }), "ok");
  check("a host with a scheme on it", codeOf({ scopes: ["net"], net: ["https://api.example.com"] }), "manifest_invalid");
  check("a host with a port on it", codeOf({ scopes: ["net"], net: ["api.example.com:443"] }), "manifest_invalid");
  check("an address rather than a name", codeOf({ scopes: ["net"], net: ["127.0.0.1"] }), "manifest_invalid");
  check("a name for this machine", codeOf({ scopes: ["net"], net: ["thing.localhost"] }), "manifest_invalid");

  // Two api codes because the remedies are opposite: republish the plugin, or update the machine.
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

  // Asserted on the refusal sentence, not the code: most refusals share manifest_invalid for different bugs.
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
  // The bound is what a session's menu can show, not what it costs to hold.
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

  // The array check runs before the scope gate and the object check after it, so only the latter cases declare the scope.
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

  says(
    "an env slot that decides which binary runs rather than which service answers",
    { scopes: ["harness"], contributes: { harnesses: [{ ...CONTRIBUTED_HARNESS, envNames: ["LD_PRELOAD"] }] } },
    "decides which code runs",
  );
  says(
    "one name used as both a credential slot and a routed-model variable",
    {
      scopes: ["harness"],
      contributes: { harnesses: [{ ...CONTRIBUTED_HARNESS, envNames: ["ACME_KEY"], routedModelEnv: ["ACME_KEY"] }] },
    },
    "the model id would overwrite the key",
  );

  // A trailing root label defeated the name arm of isMetadataHost, and two clouds answer metadata on routable addresses.
  const withBaseUrl = (baseUrl: string): Record<string, unknown> => ({
    scopes: ["system"],
    contributes: {
      systems: [{ id: "acme", name: "Acme", apiType: "openai", baseUrl, models: [{ id: "m", name: "M" }] }],
    },
  });
  says("the link-local metadata address", withBaseUrl("http://169.254.169.254/latest"), "metadata service");
  says("Alibaba's, which is routable", withBaseUrl("http://100.100.100.200/latest"), "metadata service");
  says("Oracle's, which is routable too", withBaseUrl("http://192.0.0.192/opc/v1"), "metadata service");
  says(
    "and the name arm with a root label on the end of it",
    withBaseUrl("https://metadata.google.internal./computeMetadata/v1"),
    "metadata service",
  );
  says(
    "a single label, which resolves through whatever search domain this host carries",
    withBaseUrl("https://inference/v1"),
    "a host with a dot in it",
  );
  says(
    "an auth header that frames the request rather than naming who is asking",
    {
      scopes: ["system"],
      contributes: {
        systems: [
          {
            id: "acme",
            name: "Acme",
            apiType: "openai",
            baseUrl: "https://api.example.com",
            authHeader: { name: "transfer-encoding" },
            models: [{ id: "m", name: "M" }],
          },
        ],
      },
    },
    "frames the request rather than naming who is asking",
  );

  // Strict when presenting, loose when loading a stored row: toRecord re-parses on every read, so a card guard must not unload an installed plugin.
  {
    const loose = (patch: Record<string, unknown>): ReturnType<typeof parseManifest> =>
      parseManifest(JSON.stringify({ ...base, ...patch }), { presenting: false });
    const zwj = "\u{1F468}\u200D\u{1F4BB} Dev Helper";
    const override = "Claude\u202Ecode";

    says("a plugin name carrying a right-to-left override", { name: override }, "control or formatting characters");
    says("a description carrying one", { description: override }, "control or formatting characters");
    says(
      "and a harness name carrying an emoji joiner, which is the same category",
      { scopes: ["harness"], contributes: { harnesses: [{ ...CONTRIBUTED_HARNESS, name: zwj }] } },
      "control or formatting characters",
    );

    check(
      "but a row already installed still loads, because no card is being drawn",
      [loose({ name: override }).ok, loose({ description: override }).ok, loose({ name: zwj }).ok],
      [true, true, true],
    );
    check(
      "while what bounds the plugin holds in both modes",
      [
        loose({ scopes: ["harness"], contributes: { harnesses: [{ ...CONTRIBUTED_HARNESS, envNames: ["LD_PRELOAD"] }] } }).ok,
        loose(withBaseUrl("http://100.100.100.200/latest")).ok,
        loose(withBaseUrl("https://metadata.google.internal./computeMetadata/v1")).ok,
      ],
      [false, false, false],
    );
  }

  // Every case above is one past a ceiling; the accepts at the ceiling catch a validator that refuses one early.
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
  // Counted in UTF-16 units deliberately: it bounds a label somebody reads.
  check("a key of exactly the length a key may be", refusal("k".repeat(MAX_PLUGIN_KEY_CHARS), "1", empty), "ok");
  check("and one character past it", refusal("k".repeat(MAX_PLUGIN_KEY_CHARS + 1), "1", empty), "bad_request");
  check("a value over the per-value cap", refusal("a", "x".repeat(MAX_PLUGIN_VALUE_BYTES + 1), empty), "value_too_large");
  check(
    "a write that would take the plugin over its total",
    refusal("a", "x".repeat(1000), { keys: 1, bytes: MAX_PLUGIN_DATA_BYTES, existing: null }),
    "store_full",
  );
  // The replaced value is credited back before the new one is charged.
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

  // The bounds table in docs/PLUGINS.md is the only place an author sees these ceilings, so it is held to the constants.
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

  /** One script run against both stores and compared, real store first: the fake is held to SQLite. */
  const script = (store: PluginDataStore): Record<string, unknown> => {
    const refusal = (run: () => void): string => {
      try {
        run();
        return "ok";
      } catch (error) {
        return error instanceof PluginStoreError ? error.code : "threw";
      }
    };

    const sameKey = [
      refusal(() => store.set("one", "shared", JSON.stringify("first"))),
      refusal(() => store.set("two", "shared", JSON.stringify("second"))),
      store.get("one", "shared"),
      store.get("two", "shared"),
    ];

    // % and _ are LIKE wildcards; the fake cannot reproduce that bug, so only the real store proves the escape.
    for (const key of ["a%b", "axb", "a_b", "ab"]) refusal(() => store.set("one", key, JSON.stringify(key)));

    // Mixed case, because LIKE folds ASCII and this column does not; a third plugin id so nothing above moves.
    for (const key of ["CARD:3", "Card:2", "card:1"]) {
      refusal(() => store.set("three", key, JSON.stringify(key)));
    }

    const bounds = [
      refusal(() => store.set("one", "big", JSON.stringify("x".repeat(MAX_PLUGIN_VALUE_BYTES)))),
      refusal(() => store.set("one", "", JSON.stringify("x"))),
      refusal(() => store.set("one", `a${String.fromCharCode(10)}b`, JSON.stringify("x"))),
    ];

    // Coarse rows on purpose: SQLite charges per-pair scaffolding the fake does not, so small rows would cut pages in different places.
    for (let index = 0; index < 6; index += 1) {
      refusal(() => store.set("two", `card:${index}`, JSON.stringify("y".repeat(4_000))));
    }
    refusal(() => store.set("two", "note", JSON.stringify("not a card")));
    const first = store.entries("two", "card:", "", 10_000);
    // The cursor is the last key of the page, echoed back rather than computed.
    const second = store.entries("two", "card:", String(first.entries.at(-1)?.key ?? ""), 10_000);
    const rest = store.entries("two", "card:", String(second.entries.at(-1)?.key ?? ""), 10_000);

    const answer = {
      sameKey,
      percentPrefix: store.keys("one", "a%"),
      // A regression to LIKE takes all three on SQLite and one on the fake, failing the literal and the parity line.
      casedPrefix: store.keys("three", "card:"),
      casedEntries: store.entries("three", "card:", "", 1_000_000).entries.map((one) => one.key),
      underscorePrefix: store.keys("one", "a_"),
      everyKey: store.keys("one", "a"),
      bounds,
      page: [first.entries.map((one) => one.key), first.more],
      nextPage: [second.entries.map((one) => one.key), second.more],
      lastPage: [rest.entries.map((one) => one.key), rest.more],
      unprefixed: store.entries("two", "", "", 1_000_000).entries.map((one) => one.key),
      firstValue: first.entries[0]?.value === "y".repeat(4_000),
    };

    // Uninstalling is the only thing that drops data, and it drops one plugin's.
    store.dropPlugin("one");
    return { ...answer, afterDrop: [store.keys("one", ""), store.keys("two", "").length] };
  };

  const stores = openStores({ path: join(tmp("plugin-data-"), "d.db"), instanceId: "i_plugin_data" });
  const real = script(stores.pluginData);

  // A key nobody set reads as null, never undefined, on both stores; a stored null is indistinguishable from it.
  {
    const fake = memoryPluginData();
    for (const [name, store] of [["sqlite", stores.pluginData], ["the driver's own", memoryPluginData()]] as const) {
      check(`a key nobody set reads as null on ${name}, never undefined`, store.get("p", "no_such_key"), null);
    }
    fake.set("p", "held", JSON.stringify(null));
    stores.pluginData.set("p", "held", JSON.stringify(null));
    check("a stored null is the same answer as a missing key, on both", [fake.get("p", "held"), stores.pluginData.get("p", "held")], [null, null]);
    // The control: a non-null value round-trips, so the lines above are not green about a store answering null to everything.
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

  check("and the memory store the rest of this file uses answers all of it", script(memoryPluginData()), real);

  // The range's upper bound must step over the surrogate block: node:sqlite binds a lone surrogate as U+FFFD.
  {
    const edge = ["\uD7FFa", "\uD7FFb", "\uE000private", "\uF8FFapple", "\uFFFCobj"];
    const fake = memoryPluginData();
    for (const key of edge) {
      stores.pluginData.set("edge", key, JSON.stringify(key));
      fake.set("edge", key, JSON.stringify(key));
    }
    // All BMP and none a surrogate, so UTF-8 byte order and UTF-16 unit order agree and the sort is not under test.
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

    // SQLite only: the bind turns a lone surrogate into U+FFFD, so the fake and the column disagree about the key itself.
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

  // Asserts where the running usage pair refuses, across set, delete, dropPlugin and a second store object over the same database.
  {
    const refusal = (run: () => void): string => {
      try {
        run();
        return "ok";
      } catch (error) {
        return error instanceof PluginStoreError ? error.code : "threw";
      }
    };
    // Derived from the constants, so a moved ceiling moves the fixture with it.
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
    check(
      "while rewriting a key it already holds is not a new charge",
      refusal(() => stores.pluginData.set("quota", "k0", value)),
      "ok",
    );

    // A delete as a fresh store object's first call: usage must be seeded before the statement, or a restart widens the quota.
    const restarted = new SqlitePluginDataStore(stores.db);
    restarted.delete("quota", "k0");
    check("a store that has just come up credits a delete exactly once", refusal(() => restarted.set("quota", "k0", value)), "ok");
    check("and not twice", refusal(() => restarted.set("quota", "spare", value)), "store_full");

    // dropPlugin forgets the usage entry rather than zeroing it, so this also drives the reseed.
    restarted.dropPlugin("quota");
    const again = new Set(
      Array.from({ length: fits }, (_, index) => refusal(() => restarted.set("quota", `k${index}`, value))),
    );
    check("an uninstall gives the whole budget back", [...again], ["ok"]);
    check("up to the same ceiling and no further", refusal(() => restarted.set("quota", "over", value)), "store_full");

    // The key ceiling, which a byte count cannot see.
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
  // plugin_data rows stranded by a half-finished uninstall are swept by prune inside openStores, before any PluginHost exists.
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
    // The sweep asks the table, not the record listing: a row this build cannot read is not an uninstalled plugin.
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

  // A downgrade: a manifest a newer daemon wrote, which toRecord re-validates on every read.
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
  // has exists because list and get both answer null for an unreadable row; it parses nothing.
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

  // remove falls through to the store for a row no live plugin holds, and must take its row and data with it.
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
