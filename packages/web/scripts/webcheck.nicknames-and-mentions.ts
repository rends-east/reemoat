import { check, report, sleep } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";
import * as daemon from "../../../src/nickname.js";

const web = await import("../src/nickname.js");
const { nicknameLine, sessionLabel } = await import("../src/ui/bits.js");
const { matchesQuery } = await import("../src/ui/groups.js");
const {
  ensureMentions,
  filterMentions,
  mentionCompletion,
  mentionListingFor,
  mentionStateFor,
  mentionQuery,
  mentionsVersion,
  subscribeMentions,
  MENTIONS_TTL_MS,
} = await import("../src/mentions.js");
const { ApiError } = await import("../src/http.js");
const { keyOf } = await import("../src/ids.js");
const { AGENT_IDS } = await import("../src/wire.js");

// packages/web may not import src/, so the list and the verdicts are a hand mirror, compared here against the daemon's own (Q3.677).
process.stdout.write("\na session's nickname, the same on both sides of the wire\n");
{
  check("the list is the daemon's, name for name and in order", web.NICKNAMES, daemon.NICKNAMES);
  check(
    "and so are the bounds and the shape",
    [web.MIN_NICKNAME_CHARS, web.MAX_NICKNAME_CHARS, web.NICKNAME.source],
    [daemon.MIN_NICKNAME_CHARS, daemon.MAX_NICKNAME_CHARS, daemon.NICKNAME.source],
  );
  report("the list is long enough to roll from", web.NICKNAMES.length >= 100, `${web.NICKNAMES.length} names`);
  check(
    "every name on it is one, once, and none is a harness",
    [
      web.NICKNAMES.filter((name) => !web.isNickname(name)),
      web.NICKNAMES.length - new Set(web.NICKNAMES).size,
      web.NICKNAMES.filter((name) => (AGENT_IDS as readonly string[]).includes(name)),
    ],
    [[], 0, []],
  );

  const inputs: unknown[] = [
    "mira", "MIRA", "  Mira ", "a", "ab", "x".repeat(32), "x".repeat(33), "s_x", "mi ra", "-mi", "mi-", "mi--ra",
    "mi-ra-2", "m1", "1m", "", "   ", "ёлка", "@mira", "mira.dev", 7, null, undefined, { name: "mira" },
  ];
  const verdicts = inputs.map((raw) => web.normalizeNickname(raw));
  check("every verdict is the daemon's", verdicts, inputs.map((raw) => daemon.normalizeNickname(raw)));
  // A floor on both sides, so a mirror that refused or accepted everything cannot match a daemon that did the same.
  check(
    "and the table holds names it takes and names it refuses",
    [verdicts.filter((one) => one !== null).length >= 5, verdicts.filter((one) => one === null).length >= 10],
    [true, true],
  );
  check(
    "including the ones the daemon's route refuses by name",
    ["a", "x".repeat(33), "s_x", "mi ra", "-mi", null, 7].map((raw) => web.normalizeNickname(raw)),
    [null, null, null, null, null, null, null],
  );
  check("a name is stored lowercase and trimmed", web.normalizeNickname("  OTTO "), "otto");

  // A seeded generator, so both sides are asked the same questions.
  const seeded = (seed: number): (() => number) => {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  };
  const tables: ReadonlySet<string>[] = [
    new Set(),
    new Set(["mira", "otto", "ada"]),
    new Set(web.NICKNAMES.slice(0, 100)),
    new Set(web.NICKNAMES),
    new Set([...web.NICKNAMES, ...web.NICKNAMES.map((name) => `${name}-2`)]),
  ];
  const draws = tables.flatMap((taken, table) =>
    [1, 2, 3, 4, 5].map((seed) => [web.randomNickname(taken, seeded(seed * 7 + table)), daemon.pickNickname(taken, seeded(seed * 7 + table))]),
  );
  check("the roll draws what the daemon's own pick would", draws.filter(([ours, theirs]) => ours !== theirs), []);
  check("and never a name it was told is taken", draws.filter(([ours], index) => tables[Math.floor(index / 5)]?.has(ours ?? "")), []);
  check(
    "one name left is the name rolled",
    web.randomNickname(new Set(web.NICKNAMES.filter((name) => name !== "zola"))),
    "zola",
  );
  check("with every name taken it rolls a suffix", web.randomNickname(new Set(web.NICKNAMES), () => 0), "ada-2");
  check("and the first free one", web.randomNickname(new Set([...web.NICKNAMES, "ada-2", "ada-3"]), () => 0), "ada-4");
  check(
    "a roll with nothing taken is on the list",
    web.NICKNAMES.includes(web.randomNickname(new Set())),
    true,
  );
  check(
    "the names seen are every row's that has one",
    [...web.nicknamesIn([{ snapshot: { nickname: "mira" } }, { snapshot: {} }, { snapshot: { nickname: null } }, { snapshot: { nickname: "otto" } }])],
    ["mira", "otto"],
  );

  // The field sends exactly what it does not refuse, and a leading `@` is how the name is drawn everywhere.
  const typed = ["mira", "@mira", " Mira ", "@", "", "mi ra", "1mira", "m", "x".repeat(40), "mi--ra", "mi-", "s_x", "ёлка", "@@mira"];
  check(
    "the field sends a name exactly when it has nothing to say against it",
    typed.filter((raw) => (web.typedNickname(raw) === null) !== (web.nicknameProblem(raw) !== null)),
    [],
  );
  check("a leading @ is taken off", web.typedNickname("@Mira"), "mira");
  check(
    "and each refusal says what is wrong with it",
    ["", "x".repeat(40), "mi ra", "1mira", "m", "mi--ra"].map((raw) => web.nicknameProblem(raw)),
    [
      "A session needs a nickname — type one, or roll the dice.",
      "At most 32 characters.",
      "Only latin letters, digits and hyphens.",
      "Start with a letter.",
      "At least 2 characters.",
      "A hyphen goes between two letters or digits.",
    ],
  );
}

process.stdout.write("\nthe nickname is drawn under what the session is about, never instead of it\n");
{
  check("a nickname is drawn with its @", nicknameLine({ nickname: "mira" }), "@mira");
  check(
    "and an older daemon's row, which has none, draws nothing",
    [nicknameLine({}), nicknameLine({ nickname: null }), nicknameLine({ nickname: "" })],
    [null, null, null],
  );
  const row = (title: string | null, nickname?: string) =>
    ({
      snapshot: {
        title,
        agent: "claude",
        workspace: { requestedCwd: "/Users/rends/api", git: null },
        ...(nickname === undefined ? {} : { nickname }),
      },
    }) as never;
  check("a titled session is still called by its title", sessionLabel(row("fix the build", "mira")), "fix the build");
  check("and an untitled one by its folder, not its nickname", sessionLabel(row(null, "mira"), ["/Users/rends"]), "api");
  check(
    "the search finds a session by its nickname, with or without the @",
    [matchesQuery(row("fix the build", "mira"), "mira"), matchesQuery(row("fix the build", "mira"), "@mira"), matchesQuery(row("fix the build", "mira"), "@MI")],
    [true, true, true],
  );
  check(
    "and not by one it does not have",
    [matchesQuery(row("fix the build", "mira"), "@otto"), matchesQuery(row("fix the build"), "@mira")],
    [false, false],
  );

  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  const subline = /<div className="mt-0\.5 flex min-w-0 items-center gap-3 text-2xs text-muted">([\s\S]*?)<\/div>/.exec(browser)?.[1] ?? "";
  report("the rail row's subline was found", subline.length > 0, `${subline.length} chars`);
  check("the row derives the nickname from the snapshot", /const nickname = nicknameLine\(row\.snapshot\);/.test(browser), true);
  check(
    "and the line is the nickname, the harness's mark and the machine, one even gap apart (Q3.681)",
    /^\s*\{nickname !== null && <span className="shrink-0">\{nickname\}<\/span>\}\s*<AgentMark agent=\{row\.snapshot\.agent\} \/>\s*<MachineLabel name=\{machine\} \/>\s*$/.test(subline),
    true,
  );
  check("the harness is never its name spelled out there", />\s*\{row\.snapshot\.agent\}/.test(subline), false);
  const icons = stripComments(srcFile("ui/AgentIcons.tsx"));
  const marks = ["ClaudeGlyph", "CodexGlyph", "KimiGlyph", "OpencodeGlyph", "GrokGlyph"].map((name) => {
    const body = icons.slice(icons.indexOf(`function ${name}(`), icons.indexOf("\n}\n", icons.indexOf(`function ${name}(`)));
    return /<Mark size=\{size\}>/.test(body) && /<path\b/.test(body);
  });
  check("each shipped harness is its vendor's mark, filled, rather than a stroke of ours (Q3.680)", marks, [true, true, true, true, true]);
  check(
    "in one colour, the text's: currentColor and no fixed fill or stroke",
    [/fill="currentColor"/.test(icons), /(?:fill|stroke)="#/.test(icons)],
    [true, false],
  );
  const lines = [...browser.matchAll(/<SessionLine\b[\s\S]*?\/>/g)].map((one) => one[0]);
  report("every row the list draws was found", lines.length >= 3, `${lines.length} rows`);
  check("so no row is told whether to name its machine: every one does", lines.filter((one) => /\bshowMachine\b/.test(one)).length, 0);
  check(
    "and a machine is drawn with the server mark wherever a session line names one",
    [
      /export function MachineLabel\([\s\S]*?<Icon as=\{Server\} size=\{12\} \/>/.test(stripComments(srcFile("ui/bits.tsx"))),
      /<MachineLabel name=\{machineName\} className="shrink-0" \/>/.test(stripComments(srcFile("ui/SessionView.tsx"))),
      /<MachineLabel name=\{row\.machine\.label \?\? "another machine"\}/.test(stripComments(srcFile("ui/MentionMenu.tsx"))),
      /on <MachineLabel name=\{current\.name\}/.test(stripComments(srcFile("ui/NewSession.tsx"))),
    ],
    [true, true, true, true],
  );
  const peerRow = stripComments(srcFile("ui/PeerMessage.tsx"));
  check(
    "a message from another agent is headed by its sender's @name, a link to that very session, and no harness mark",
    [/\{lead\} <MentionLink name=\{name\} exact=\{sender\} \/>/.test(peerRow), /AgentMark/.test(peerRow)],
    [true, false],
  );
  check("while the title line is still the label", /\{label\}\s*<\/span>/.test(browser), true);

  const view = stripComments(srcFile("ui/SessionView.tsx"));
  check("the header hands its line the nickname", /<WorkspaceLine\s+nickname=\{nicknameLine\(session\)\}/.test(view), true);
  const line = view.slice(view.indexOf("function WorkspaceLine("), view.indexOf("\nfunction ", view.indexOf("function WorkspaceLine(") + 1));
  const own = line.indexOf('<span className="shrink-0">{nickname}</span>');
  report("the header's line was isolated", line.length > 0, `${line.length} chars`);
  check(
    "which leads with it, in the machine name's own style, before the machine",
    own >= 0 && own < line.indexOf('<MachineLabel name={machineName} className="shrink-0" />'),
    true,
  );
  check("and draws nothing without one", /\{nickname !== null && \(/.test(line), true);
}

process.stdout.write("\n`@` in the composer: the question, the list and the answer\n");
{
  const q = (text: string, caret = text.length) => mentionQuery(text, caret);
  check(
    "an @ opens it at the start or after whitespace, with what follows as the question",
    [q("@"), q("@mi"), q("hi @mi"), q("hi @mi there", 6), q("hi @mira", 5), q("a\n@mi")],
    [
      { start: 0, query: "" },
      { start: 0, query: "mi" },
      { start: 3, query: "mi" },
      { start: 3, query: "mi" },
      { start: 3, query: "m" },
      { start: 2, query: "mi" },
    ],
  );
  check(
    "and nowhere else",
    [q("me@x"), q("/compact @x"), q("@types/node"), q("hi @mi", 2), q("@mira "), q(`@${"a".repeat(33)}`), q("@@"), q(""), q("@mi", 7)],
    [null, null, null, null, null, null, null, null, null],
  );

  const peer = (name: string, over: Record<string, unknown> = {}) =>
    ({
      name,
      ref: `s_${name}`,
      address: `${name} [s_${name}]`,
      machine: { label: null, isThis: true },
      harness: "claude",
      status: "idle",
      title: null,
      folder: "api",
      self: false,
      ...over,
    }) as never;
  const rows = [
    peer("remira"),
    peer("ada-mira"),
    peer("milo", { folder: "web", machine: { label: "studio", isThis: false } }),
    peer("mira", { title: "fix the build" }),
    peer("otto", { self: true }),
    peer("x_y"),
    peer("review-the-login-flow"),
  ];
  const names = (query: string) => filterMentions(rows, query).map((row: { name: string }) => row.name);
  check(
    "an empty question offers every reachable name, never itself nor one that is not a nickname",
    names(""),
    ["remira", "ada-mira", "milo", "mira", "review-the-login-flow"],
  );
  check("prefix first, then a segment, then anywhere", names("mi"), ["milo", "mira", "ada-mira", "remira"]);
  check("whatever the case", names("MI"), names("mi"));
  check("an exact name leads", names("mira")[0], "mira");
  check("the title matches from two characters", [names("bu"), names("b")], [["mira"], []]);
  check("and so does the folder", names("web"), ["milo"]);
  check("never fuzzily", names("mra"), []);

  const complete = (text: string, caret: number, name: string) => {
    const query = mentionQuery(text, caret);
    return query === null ? null : mentionCompletion(text, query, name);
  };
  check(
    "choosing keeps the text before the token and puts the caret after a space",
    [complete("@mi", 3, "mira"), complete("please ask @mi", 14, "mira")],
    [
      { text: "@mira ", caret: 6 },
      { text: "please ask @mira ", caret: 17 },
    ],
  );
  check(
    "and replaces the whole token, even from inside it",
    [complete("hi @mi there", 6, "mira"), complete("hi @mira there", 5, "milo")],
    [
      { text: "hi @mira there", caret: 9 },
      { text: "hi @milo there", caret: 9 },
    ],
  );
  check("a bare @ becomes the name", complete("@", 1, "ada"), { text: "@ada ", caret: 5 });
  check("and a line break after the token stays", complete("a\n@mi\nb", 5, "mira"), { text: "a\n@mira \nb", caret: 8 });
}

process.stdout.write("\nthe `@` list is asked for once, held per session, and an older daemon is not asked twice, until it is updated\n");
{
  const ref = (session: string) => ({ machineId: "m_mentions", sessionId: session }) as never;
  const listing = { agents: [{ name: "mira" }], unreachable: [{ machine: "studio", reason: "timeout" }] } as never;
  let calls = 0;
  const pending: { resolve: (value: unknown) => void; reject: (cause: unknown) => void }[] = [];
  const source = {
    mentions: () => {
      calls += 1;
      return new Promise<never>((resolve, reject) => pending.push({ resolve: resolve as (value: unknown) => void, reject }));
    },
  };
  const one = keyOf(ref("s_one"));

  ensureMentions(ref("s_one"), undefined, "i_one", 1_000);
  check("with no daemon to ask, nothing is asked", calls, 0);
  ensureMentions(ref("s_one"), source, "i_one", 1_000);
  ensureMentions(ref("s_one"), source, "i_one", 1_000);
  check("two asks while one is out are one request", calls, 1);
  check("and nothing is offered before it lands", mentionListingFor(one), null);

  let heard = 0;
  const unsubscribe = subscribeMentions(() => {
    heard += 1;
  });
  const before = mentionsVersion();
  pending.shift()?.resolve(listing);
  await sleep(0);
  check(
    "a landed listing is held and announced",
    [mentionListingFor(one)?.agents.length, mentionListingFor(one)?.unreachable.length, heard, mentionsVersion() > before],
    [1, 1, 1, true],
  );
  ensureMentions(ref("s_one"), source, "i_one", 1_000 + MENTIONS_TTL_MS - 1);
  check("and not asked for again inside its lifetime", calls, 1);
  ensureMentions(ref("s_two"), source, "i_one", 1_000);
  check("while another session's is its own", [calls, mentionListingFor(keyOf(ref("s_two")))], [2, null]);
  pending.shift()?.resolve({ agents: [], unreachable: [] });
  await sleep(0);

  ensureMentions(ref("s_one"), source, "i_one", 1_000 + MENTIONS_TTL_MS);
  check("once stale it is asked again", calls, 3);
  check("with the old one still offered meanwhile", mentionListingFor(one)?.agents.length, 1);
  pending.shift()?.reject(new ApiError(503, "peers_unavailable", "messaging is off", null, { error: { code: "peers_unavailable" } }));
  await sleep(0);
  check("a refusal offers nothing", mentionListingFor(one), null);
  ensureMentions(ref("s_one"), source, "i_one", 1_000 + MENTIONS_TTL_MS + 1);
  check("and is not asked again at once", calls, 3);
  ensureMentions(ref("s_one"), source, "i_one", 1_000 + 2 * MENTIONS_TTL_MS);
  check("but is once its lifetime is over", calls, 4);
  pending.shift()?.reject(new ApiError(404, "http_404", "Not Found", null, null));
  await sleep(0);
  check("an older daemon's bare 404 offers nothing", mentionListingFor(one), null);
  ensureMentions(ref("s_one"), source, "i_one", 1_000 + 10 * MENTIONS_TTL_MS);
  check("and is remembered, so that daemon is not asked again", calls, 4);
  check("which the menu can tell from a listing and a failure", mentionStateFor(one), "absent");
  ensureMentions(ref("s_one"), source, "i_two", 1_000 + 10 * MENTIONS_TTL_MS);
  check("but a restarted daemon is a new instance, and is asked", calls, 5);
  pending.shift()?.resolve(listing);
  await sleep(0);
  check("so an update is seen without a reload", mentionListingFor(one)?.agents.length, 1);

  ensureMentions(ref("s_four"), source, null, 1_000);
  pending.shift()?.reject(new ApiError(404, "http_404", "Not Found", null, null));
  await sleep(0);
  ensureMentions(ref("s_four"), source, null, 1_000 + MENTIONS_TTL_MS - 1);
  check("with no instance to compare, a 404 holds for a lifetime", calls, 6);
  ensureMentions(ref("s_four"), source, null, 1_000 + MENTIONS_TTL_MS);
  check("and is asked again after it", calls, 7);
  pending.shift()?.resolve({ agents: [], unreachable: [] });
  await sleep(0);

  ensureMentions(ref("s_three"), source, "i_one", 1_000);
  pending.shift()?.reject(new ApiError(404, "session_not_found", "no such session", null, { error: { code: "session_not_found" } }));
  await sleep(0);
  ensureMentions(ref("s_three"), source, "i_one", 1_000 + MENTIONS_TTL_MS);
  check("while a 404 with an envelope is a refusal, asked again later", calls, 9);
  pending.shift()?.resolve({ agents: [], unreachable: [] });
  await sleep(0);
  unsubscribe();
}

process.stdout.write("\nevery @name drawn is a link to its session, where this client can open one (Q3.682)\n");
{
  const { splitMentions, mentionTarget, refTarget, remarkMentions } = await import("../src/mentionLinks.js");
  const { lineSpans } = await import("../src/ui/hug.js");
  check(
    "a name counts at the start or after a space, and only where a name ends, as the daemon reads it",
    ["@mira hi", "ask @mira, then", "mail me@mira", "see @mira/notes", "@mira@x", "/compact @mira"].map((text) =>
      splitMentions(text).filter((part) => part.kind === "mention").map((part) => (part as { name: string }).name),
    ),
    [["mira"], ["mira"], [], [], [], ["mira"]],
  );
  check(
    "and the rest of the text is kept exactly, spaces and breaks included",
    splitMentions("  ask @mira\n  and @otto.").map((part) => (part.kind === "text" ? part.text : `<${part.name}>`)).join(""),
    "  ask <mira>\n  and <otto>.",
  );

  const rows = [
    { ref: { machineId: "m_here", sessionId: "s_1" }, snapshot: { nickname: "mira" } },
    { ref: { machineId: "m_far", sessionId: "s_2" }, snapshot: { nickname: "mira" } },
    { ref: { machineId: "m_far", sessionId: "s_3" }, snapshot: { nickname: "otto" } },
    { ref: { machineId: "m_a", sessionId: "s_4" }, snapshot: { nickname: "twin" } },
    { ref: { machineId: "m_b", sessionId: "s_5" }, snapshot: { nickname: "twin" } },
  ];
  check("a name held here leads here, whatever another machine calls a session", mentionTarget("Mira", { here: "m_here" }, rows), { machineId: "m_here", sessionId: "s_1" });
  check("one held by a single session elsewhere leads there", mentionTarget("otto", { here: "m_here" }, rows), { machineId: "m_far", sessionId: "s_3" });
  check("two elsewhere and none here is no link, rather than a guess", mentionTarget("twin", { here: "m_here" }, rows), null);
  check("and a name nobody holds is none either", mentionTarget("nobody", { here: "m_here" }, rows), null);
  check(
    "what the daemon resolved for the message wins over the nickname here",
    mentionTarget("mira", { here: "m_here", mentions: [{ name: "mira", ref: "m_far/s_2" }] }, rows),
    { machineId: "m_far", sessionId: "s_2" },
  );
  check(
    "and so does a peer's own ref, but only to a session this client can open",
    [mentionTarget("otto", { here: "m_here", exact: { machineId: "m_far", sessionId: "s_3" } }, rows), mentionTarget("otto", { here: "m_here", exact: { machineId: "m_gone", sessionId: "s_9" } }, rows)],
    [{ machineId: "m_far", sessionId: "s_3" }, null],
  );
  check("a daemon's ref names another machine by a slash, and this one by none", [refTarget("m_x/s_1", "m_here"), refTarget("s_1", "m_here")], [{ machineId: "m_x", sessionId: "s_1" }, { machineId: "m_here", sessionId: "s_1" }]);

  const tree = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "text", value: "ask @mira now" }, { type: "inlineCode", value: "@otto" }] },
      { type: "paragraph", children: [{ type: "link", url: "x", children: [{ type: "text", value: "@otto" }] }] },
    ],
  };
  remarkMentions()(tree);
  const para = tree.children[0]?.children as { type: string; value?: string; data?: { hName?: string; hProperties?: { name?: string } } }[];
  check(
    "markdown prose gets a mention element for each name, and code and links keep their text",
    [para.map((node) => node.type), para[1]?.data?.hName, para[1]?.data?.hProperties?.name, (tree.children[1]?.children[0] as { children: { type: string }[] }).children[0]?.type],
    [["text", "mention", "text", "inlineCode"], "mention", "mira", "text"],
  );

  check(
    "a bubble's line is measured whole, however many text nodes a link cuts it into",
    lineSpans([
      { left: 10, right: 60, top: 0, bottom: 20 },
      { left: 60, right: 100, top: 0, bottom: 20 },
      { left: 100, right: 180, top: 0, bottom: 20 },
      { left: 10, right: 90, top: 20, bottom: 40 },
    ]),
    [170, 80],
  );

  const markdown = stripComments(srcFile("ui/Markdown.tsx"));
  check(
    "every markdown body runs the plugin and draws the element as the link",
    [/remarkListItemBlocks,\s*remarkMentions,\s*\]/.test(markdown), /mention: \(\{ name \}/.test(markdown) && /<MentionLink name=\{name\} \/>/.test(markdown)],
    [true, true],
  );
  const link = stripComments(srcFile("ui/MentionLink.tsx"));
  check(
    "the link is a button that loads the router only on a tap, and the store is read through a key",
    [/<button\s+type="button"\s+onClick=\{\(\) => void openSession\(ref\)\}/.test(link), /await import\("\.\.\/router"\)/.test(link), /from "\.\.\/router"/.test(link), /useSyncExternalStore\(store\.subscribe, \(\) => \{/.test(link)],
    [true, true, false, true],
  );
  const view = stripComments(srcFile("ui/SessionView.tsx"));
  check(
    "under the pointer the whole @name sits in a pill, on a token that shows inside a person's own bubble",
    [/rounded-full px-1 py-0\.5/.test(link), /hover:bg-edge"/.test(link), /hover:bg-raised/.test(link), />\s*@\{name\}\s*<\/button>/.test(link)],
    [true, true, false, true],
  );
  check("a conversation scopes its names to its own machine", /<MentionScope\.Provider value=\{mentionScope\}>/.test(view), true);
  check("and a person's message hands its bubble what the daemon resolved", /mentions=\{event\.mentions\}/.test(stripComments(srcFile("ui/EventList.tsx"))), true);
}

process.stdout.write("\nwhere the `@` menu and the Nickname field are drawn\n");
{
  const composer = stripComments(srcFile("ui/Composer.tsx"));
  check(
    "the @ question is never asked beside the / menu",
    /const mention = dismissed \|\| query !== null \|\| stage !== null \? null : mentionQuery\(text, caret\);/.test(composer),
    true,
  );
  check(
    "the keys and the textarea's claims follow whichever menu is open",
    [
      /composerKey\(\s*\{[^}]*\},\s*menuOpen \|\| mentionOpen,/.test(composer),
      /aria-expanded=\{menuOpen \|\| mentionOpen\}/.test(composer),
      /aria-controls=\{menuOpen \? "composer-command-menu" : mentionOpen \? "composer-mention-menu" : undefined\}/.test(composer),
      /menuOpen \? `composer-command-\$\{active\}` : mentionOpen \? `composer-mention-\$\{active\}` : undefined/.test(composer),
    ],
    [true, true, true, true],
  );
  check(
    "the highlight is reset by the question and clamped by the open list's length",
    [
      /\}, \[query\?\.query, stage, mention\?\.start, mention\?\.query\]\);/.test(composer),
      /setActive\(\(at\) => \(at < listLength \? at : 0\)\);\s*\}, \[listLength\]\);/.test(composer),
      /\(at \+ 1\) % listLength/.test(composer),
    ],
    [true, true, true],
  );
  check(
    "the list is asked for when the question opens, per session, and again when that machine's daemon is a new instance",
    [/\}, \[key, mentionAsked, mentionDaemon\]\);/.test(composer), /ensureMentions\(sessionRef, store\.daemonFor\(sessionRef\.machineId\), mentionDaemon\)/.test(composer)],
    [true, true],
  );
  check(
    "a bare @ that offers nobody says so rather than drawing nothing, and a typed name that matches nobody closes",
    [
      /mention === null \|\| mention\.query !== "" \|\| mentionOpen\s*\?\s*null/.test(composer),
      /\{\(mentionOpen \|\| mentionNotice !== null\) && \(/.test(composer),
      /notice !== null && rows\.length === 0/.test(stripComments(srcFile("ui/MentionMenu.tsx"))),
    ],
    [true, true, true],
  );
  // The late-write driver slices on this anchor, so a second one would move what it reads.
  check("choosing a name is a function of its own, and `choose` is still declared once", (composer.match(/const choose = /g) ?? []).length, 1);
  check("which the menu is handed", /<MentionMenu[\s\S]*?onChoose=\{chooseMention\}/.test(composer), true);

  const menu = stripComments(srcFile("ui/MentionMenu.tsx"));
  check(
    "the menu is the listbox the textarea names, and each row the option it points at",
    [
      /id="composer-mention-menu" role="listbox"/.test(menu),
      /id=\{`composer-mention-\$\{index\}`\}/.test(menu),
      /role="option"/.test(menu),
      /tabIndex=\{-1\}/.test(menu),
      /aria-selected=\{index === active\}/.test(menu),
    ],
    [true, true, true, true, true],
  );
  check(
    "and a row keeps the caret in the box and closes on a press outside, as the / menu does",
    [/onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/.test(menu), /window\.addEventListener\("pointerdown", close\)/.test(menu)],
    [true, true],
  );
  check(
    "a row reads what the session is about, then @name, then the machine when it is another",
    [/<AgentGlyph agent=\{row\.harness\}/.test(menu), /@\{row\.name\}/.test(menu), /!row\.machine\.isThis &&/.test(menu)],
    [true, true, true],
  );

  const start = stripComments(srcFile("ui/NewSession.tsx"));
  const labels = ["<FieldLabel>Agent</FieldLabel>", "<FieldLabel>Nickname</FieldLabel>", "<FieldLabel>Directory</FieldLabel>"].map((one) =>
    start.indexOf(one),
  );
  check("New session asks for a nickname between the agent and the folder", labels.every((at, i) => at >= 0 && (i === 0 || at > (labels[i - 1] ?? 0))), true);
  const block = start.slice(labels[1] ?? 0, labels[2] ?? 0);
  check(
    "in a field that never rewrites a keystroke, with a dice beside it",
    [
      /\{\.\.\.VERBATIM_FIELD\}/.test(block),
      /aria-label="Nickname"/.test(block),
      /autoCapitalize="off"/.test(block),
      /<Icon as=\{AtSign\} size=\{16\} className="text-muted" \/>\s*<input/.test(block),
      /className=\{`w-40 min-w-0 \$\{FIELD\}`\}/.test(block),
      /icon=\{Dices\}\s+label="Random nickname"\s+size="nav"/.test(block),
      /text-danger/.test(block),
    ],
    [true, true, true, true, true, true, true],
  );
  check(
    "seeded from every row's nickname on every machine, and outliving the builder's round trip",
    [/nicknamesIn\(state\.rowsByKey\.values\(\)\)/.test(start), /^let nicknameDraft/m.test(start), /nicknameDraft = null;/.test(start)],
    [true, true, true],
  );
  check(
    "a rolled name somebody else has since taken is rolled again, and a typed one is left alone",
    /if \(nicknameDraft\?\.rolled !== true\) return;[\s\S]{0,160}editNickname\(randomNickname\(seen\), true\);\s*\}, \[state\.rowsByKey\]\);/.test(start),
    true,
  );
  check(
    "sent with the session, and an older daemon ignoring it is said out loud",
    [
      /\{ agent: "", customAgent: picked\.id, cwd, nickname \}/.test(start),
      /\{ agent: picked\.id, cwd, nickname \}/.test(start),
      /typeof result\.session\.nickname !== "string"/.test(start),
    ],
    [true, true, true],
  );

  const client = stripComments(srcFile("daemon.ts"));
  check(
    "the client names the route and the field",
    [
      /mentions\(id: SessionId\): Promise<MentionListing> \{\s*return this\.machine\.request<MentionListing>\(`\/sessions\/\$\{encodeURIComponent\(id\)\}\/mentions`\);/.test(client),
      /branch\?: string;\s*nickname\?: string;/.test(client),
    ],
    [true, true],
  );
}
