import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";
import { type NavMove } from "./webcheck.modules.js";

// mdast drops the delimiter character, so the plugin reads it from the source at position.start.offset; hand-built trees make the offsets a claim.

process.stdout.write("\nwhich lists keep their delimiter\n");
{
  const { remarkListDelimiter, PAREN_LIST } = await import("../src/ui/mdlist.js");
  const classOf = (node: Record<string, unknown>): unknown =>
    (node["data"] as { hProperties?: { className?: unknown } } | undefined)?.hProperties?.className;
  const list = (offset: number, ordered = true): Record<string, unknown> => ({
    type: "list",
    ordered,
    position: { start: { offset } },
    children: [],
  });
  const run = (source: string, tree: Record<string, unknown>): Record<string, unknown> => {
    remarkListDelimiter()(tree, { value: source });
    return tree;
  };

  check("a paren list is marked", classOf(run("1) a", list(0))), [PAREN_LIST]);
  check("a dotted one is not", classOf(run("1. a", list(0))), undefined);
  check("and a bullet list is not, whatever follows it", classOf(run("- a", list(0, false))), undefined);

  // remark's offset points at the digit, never at the indentation before it.
  check("an offset that is not on a marker marks nothing", classOf(run("  1) a", list(0))), undefined);
  check("and the real offset does", classOf(run("  1) a", list(2))), [PAREN_LIST]);

  // CommonMark caps a list marker at nine digits.
  check("nine digits is still a list marker", classOf(run("123456789) a", list(0))), [PAREN_LIST]);

  // A person's message is drawn as sent and never parsed, so the plugin that gave it back its line breaks is deleted rather than idle (Q3.646 reverses Q3.639).
  const mdlist = await import("../src/ui/mdlist.js");
  check("no plugin turns a soft break into a hard one any more", "remarkHardBreaks" in mdlist, false);
  const para = (...children: unknown[]): Record<string, unknown> => ({ type: "paragraph", children });
  const text = (value: string): Record<string, unknown> => ({ type: "text", value });
  const root = (...children: unknown[]): Record<string, unknown> => ({ type: "root", children });

  const { remarkListItemBlocks } = await import("../src/ui/mdlist.js");
  const item = (...children: unknown[]): Record<string, unknown> => ({ type: "listItem", children });
  const bullets = (...children: unknown[]): Record<string, unknown> => ({ type: "list", ordered: false, children });
  const inner = item(para(text("вложенный")), bullets(item(para(text("глубже")))));
  const mixed = item(para(text("третий")), bullets(inner));
  const plain = item(para(text("первый")));
  const blocksOnly = item(bullets(item(para(text("только блок")))));
  // The blockquote satisfies both halves of the guard, so this fails the moment the listItem type check is dropped.
  const quoted: Record<string, unknown> = {
    type: "blockquote",
    children: [para(text("цитата")), bullets(item(para(text("пункт"))))],
  };
  remarkListItemBlocks()(root(bullets(plain, mixed, blocksOnly), quoted));
  check("an item holding a block under its sentence is made loose", mixed["spread"], true);
  check("and so is one nested inside it", inner["spread"], true);
  check("an item that is only a sentence is left alone", plain["spread"], undefined);
  check("and so is one that is only blocks", blocksOnly["spread"], undefined);
  check("and nothing that is not a list item is touched", quoted["spread"], undefined);
  check("ten is not", classOf(run("1234567890) a", list(0))), undefined);

  {
    // 6 is where remark records the digit in the source below.
    const nested = list(6);
    const root = { type: "root", children: [{ type: "listItem", children: [nested] }] };
    run("- x\n  1) a", root as never);
    check("a nested list is reached", classOf(nested), [PAREN_LIST]);
  }

  check("a node with no position is left alone", classOf(run("1) a", { type: "list", ordered: true })), undefined);
}

process.stdout.write("\nwhat a navigation moves\n");
{
  const { depthOf, isSheet, navMove, sheetKind } = await import("../src/nav.js");
  const home = { name: "home" } as never;
  const session = { name: "session", ref: { machineId: "m", sessionId: "s" } } as never;
  const other = { name: "session", ref: { machineId: "m", sessionId: "t" } } as never;
  const gate = { name: "gate", screen: "register" } as never;
  const index = { name: "settings", section: null, machineId: null, system: null, signin: null } as never;
  const account = { name: "settings", section: "account", machineId: null, system: null, signin: null } as never;
  const users = { name: "settings", section: "users", machineId: null, system: null, signin: null } as never;
  const machines = { name: "settings", section: "machines", machineId: null, system: null, signin: null } as never;
  const oneMachine = { name: "settings", section: "machines", machineId: "m", system: null, signin: null } as never;
  // Every settings fixture carries system and signin: depthOf tests them against null, which a missing key satisfies as undefined.
  const oneSystem = { name: "settings", section: "machines", machineId: "m", system: "moonshot", signin: null } as never;
  const oneSignin = { name: "settings", section: "machines", machineId: "m", system: null, signin: "acme:gemini" } as never;

  check("opening a conversation pushes a screen", navMove(home, session), "push");
  check("and leaving it pops one", navMove(session, home), "pop");

  check("tapping a section pushes inside the sheet", navMove(index, account), "section-push");
  check("and Back pops inside it", navMove(account, index), "section-pop");
  check("a machine's agents are deeper still", navMove(machines, oneMachine), "section-push");
  check("and one system deeper again", navMove(oneMachine, oneSystem), "section-push");
  check("walking back up pops each time", navMove(oneSystem, oneMachine), "section-pop");
  check("a machine's sign-in is a leaf like the other two", depthOf(oneSignin), depthOf(oneSystem));
  check("so opening one from the machine slides", navMove(oneMachine, oneSignin), "section-push");
  check("and walking back up from it pops", navMove(oneSignin, oneMachine), "section-pop");
  {
    const { parseSettingsRoute } = await import("../src/settings.js");
    const stale = { name: "settings", ...parseSettingsRoute(["machines", "m", "plugins", "board"]) } as never;
    check("a stale plugin address is the machine's depth", navMove(oneMachine, stale), null);
    check("and walking to it from Machines is one push, like the machine itself", navMove(machines, stale), "section-push");
    const list = { name: "settings", ...parseSettingsRoute(["machines", "m", "agents"]) } as never;
    const card = { name: "settings", ...parseSettingsRoute(["machines", "m", "agents", "claude"]) } as never;
    check("the Agents list is a fourth depth and its card a fifth", [depthOf(list), depthOf(card)], [4, 5]);
    check(
      "so Set up slides in, and its chevron slides back",
      [navMove(list, card), navMove(card, list)],
      ["section-push", "section-pop"],
    );
  }

  check("closing a sheet takes it down", navMove(account, session), "sheet-close");
  check("from any depth", navMove(oneSystem, home), "sheet-close");
  check("but opening one is CSS's job", navMove(session, index), null);
  check("from a session or from home", navMove(home, account), null);

  check("moving between two conversations moves nothing", navMove(session, other), null);
  check("nor does the same one twice", navMove(session, session), null);
  check("nor two sections at the same depth", navMove(account, users), null);
  check("a gate screen is beside the sign-in form, not past it", navMove(home, gate), null);

  check("a sheet is a sheet whatever its depth", [isSheet(index), isSheet(oneSystem)], [true, true]);
  check("and a screen is not", [isSheet(home), isSheet(session)], [false, false]);
  check("the four sheet depths are the four screens", [depthOf(index), depthOf(account), depthOf(oneMachine), depthOf(oneSystem)], [1, 2, 3, 4]);
  {
    const { parseSettingsRoute } = await import("../src/settings.js");
    const parsed = (segments: readonly string[]) => ({ name: "settings", ...parseSettingsRoute(segments) }) as never;
    check(
      "and the same four read off real URLs rather than hand-written objects",
      [parsed([]), parsed(["account"]), parsed(["machines", "m"]), parsed(["machines", "m", "systems", "moonshot"])].map(depthOf),
      [1, 2, 3, 4],
    );
  }
  check("and a picker has one", depthOf({ name: "new", machineId: null, cwd: null } as never), 1);
  const builder = { name: "agent", machineId: "m_1", cwd: "/home/me", step: null } as never;
  const picker = { name: "new", machineId: "m_1", cwd: "/home/me" } as never;
  check("the builder sits under the picker", [depthOf(picker), depthOf(builder)], [1, 2]);
  check("and is a sheet like everything else in that stack", isSheet(builder), true);
  check("so opening it pushes", navMove(picker, builder), "section-push");
  check("and leaving it pops rather than closing the stack", navMove(builder, picker), "section-pop");
  const choosing = { name: "agent", machineId: "m_1", cwd: "/home/me", step: "llm" } as never;
  check("and a choice sits under the builder", depthOf(choosing), 3);
  check("so opening one pushes too", navMove(builder, choosing), "section-push");
  check("and answering it pops back", navMove(choosing, builder), "section-pop");
  check(
    "and the two choices are one depth, not two",
    navMove(choosing, { name: "agent", machineId: "m_1", cwd: "/home/me", step: "harness" } as never),
    null,
  );
  // The swap arm must come before the depth test: a depth is a position inside one stack (Q3.484).
  const plugins = { name: "plugins", tab: "market", entry: null, settings: [] } as never;
  check("two pop-ups swap rather than sliding", navMove(account, plugins), "sheet-swap");
  check("in both directions", navMove(plugins, account), "sheet-swap");
  check("and a depth is never compared across them", navMove(index, plugins), "sheet-swap");
  check("while one pop-up's own depths still slide", navMove(index, account), "section-push");
  check(
    "the agent flow is the same pop-up as the session it starts",
    [sheetKind(picker), sheetKind(builder), sheetKind(account), sheetKind(plugins)],
    ["new", "new", "settings", "plugins"],
  );
  check("and a screen belongs to no pop-up", sheetKind({ name: "home" } as never), null);

  // Every animating view-transition rule is keyed on data-nav, so a width gate at equal specificity overrules it by source order.
  const transitionCss = readFileSync(new URL("../src/index.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const animatingSelectors = [...transitionCss.matchAll(/([^{}]*::view-transition-[^{}]*)\{([^}]*)\}/g)]
    .filter((rule) => /animation\s*:/.test(rule[2] ?? ""))
    .flatMap((rule) => (rule[1] ?? "").split(",").map((one) => one.trim()))
    .filter((one) => one.length > 0);
  check("there are view-transition animations to check at all", animatingSelectors.length > 8, true);
  // A Record rather than an array, so a new NavMove member is a compile error here.
  const movements: Record<NavMove, true> = {
    push: true,
    pop: true,
    "section-push": true,
    "section-pop": true,
    "sheet-close": true,
    "sheet-swap": true,
  };
  check(
    "and every movement the router can name is a movement this stylesheet declares",
    Object.keys(movements).filter((one) => !transitionCss.includes(`:root[data-nav="${one}"]`)),
    [],
  );
  check(
    "and every one is keyed on data-nav, so a width gate can overrule it",
    animatingSelectors.filter((one) => !one.startsWith(":root[data-nav")),
    [],
  );
  // Named as well, because the rule above also passes on a file that deleted them.
  check(
    "the desktop is exempt from the screen slide",
    /@media \(min-width: 64rem\) \{\s*:root\[data-nav\]::view-transition-old\(root\)/.test(transitionCss),
    true,
  );
  check(
    "and reduced motion from all four",
    /@media \(prefers-reduced-motion: reduce\) \{\s*:root\[data-nav\]::view-transition-old\(root\)/.test(transitionCss),
    true,
  );

  check(
    "a closing sheet takes its contents with it",
    /:root\[data-nav="sheet-close"\] \[data-sheet-body\] \{\s*view-transition-name: none;/.test(transitionCss),
    true,
  );
  check(
    "while a section still has a pane of its own to move",
    /\[data-sheet-body\] \{\s*view-transition-name: sheet-body;/.test(transitionCss),
    true,
  );
}

process.stdout.write("\nthe message on its way out\n");
{
  const { clearEcho, echoFor, echoVersion, landEcho, setEcho, settleEcho } = await import("../src/echo.js");
  const a = "m/a" as never;
  const b = "m/b" as never;

  const sending = (text: string) => ({ text, seq: Number.MAX_SAFE_INTEGER, after: 0, attachments: [] });

  check("a session with nothing outstanding has no echo", echoFor(a), null);
  const hello = sending("hello");
  setEcho(a, hello);
  check("one that sent something does", echoFor(a)?.text, "hello");
  check("and it is that session's alone", echoFor(b), null);

  // The MAX_SAFE_INTEGER seq is the sentinel: until the daemon names a seq, no event can settle the message.
  settleEcho(a, 9_000);
  check("an unrelated event does not settle an unlanded message", echoFor(a)?.text, "hello");

  landEcho(a, hello, 12);
  check("the daemon naming a seq lowers it", echoFor(a)?.seq, 12);
  landEcho(a, hello, 13);
  check("and only once", echoFor(a)?.seq, 12);
  settleEcho(a, 11);
  check("an earlier event still does not settle it", echoFor(a) !== null, true);
  settleEcho(a, 12);
  check("its own event does", echoFor(a), null);

  // The prompt event routinely beats the POST's answer, so landEcho must not resurrect a cleared echo.
  const again = sending("again");
  setEcho(b, again);
  clearEcho(b);
  landEcho(b, again, 40);
  check("a seq arriving after the log caught up resurrects nothing", echoFor(b), null);

  // Send A, leave and come back, send B while A's POST is out: Composer is not remounted, so both answers reach this key.
  {
    const c = "m/c" as never;
    const first = sending("first");
    const second = sending("second");
    setEcho(c, first);
    setEcho(c, second);
    landEcho(c, first, 30);
    check("the earlier send's late answer leaves the later echo unlanded", echoFor(c)?.seq, Number.MAX_SAFE_INTEGER);
    settleEcho(c, 30);
    check("so the earlier send's own event does not settle the later one", echoFor(c)?.text, "second");
    clearEcho(c, first);
    check("nor does the earlier send's refusal clear it", echoFor(c)?.text, "second");
    landEcho(c, second, 31);
    check("the later send's own answer lands it", echoFor(c)?.seq, 31);
    landEcho(c, first, 30);
    check("and an earlier answer arriving after that does not lower it", echoFor(c)?.seq, 31);
    settleEcho(c, 31);
    check("its own event settles it", echoFor(c), null);
  }

  // The snapshot has to move, or `useSyncExternalStore` never re-reads.
  {
    const before = echoVersion();
    setEcho(b, { text: "x", seq: 1, after: 0, attachments: [] });
    check("writing one is a change subscribers can see", echoVersion() > before, true);
    const written = echoVersion();
    clearEcho(b);
    check("and so is clearing it", echoVersion() > written, true);
    const cleared = echoVersion();
    clearEcho(b);
    check("but clearing nothing is not", echoVersion(), cleared);
  }
}

process.stdout.write("\nwhat a turn says when it stops\n");
{
  const { resolvedByText, stopReasonText } = await import("../src/ui/tail.js");
  // Every AnswerResolvedBy member but client, written out because a union cannot be enumerated at runtime.
  const every = [
    "agent_withdrew",
    "agent_gone",
    "session_stopped",
    "turn_ended",
    "pump_failed",
    "no_turn",
    "turn_cancelled",
  ] as const;
  check(
    "no reason a question was taken away is drawn as its identifier",
    every.filter((by) => resolvedByText(by) === by.replace(/_/g, " ")),
    [],
  );
  check("and the one somebody did says who did it", resolvedByText("turn_cancelled"), "you stopped the turn");
  check("an unknown one keeps the old rendering", resolvedByText("some_new_reason" as never), "some new reason");

  // abandoned is this daemon's own (Q2.231), listed so it never falls through to the raw enum.
  check("a cancelled turn says one word", stopReasonText("cancelled"), "cancelled");
  const others = ["max_tokens", "max_turn_requests", "refusal", "abandoned"] as const;
  check(
    "and the rest say what happened rather than naming a constant",
    others.filter((reason) => stopReasonText(reason).includes(reason)),
    [],
  );
  check("an unknown stop reason is drawn as itself", stopReasonText("weather"), "turn ended: weather");

  const src = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8");
  check("a cancel is drawn in the working line's own shape", /stopReason === "cancelled" \?[\s\S]{0,300}WorkingMark still/.test(src), true);
  check("in danger, and it is the only stop reason that is", /stopReason === "cancelled" \?[\s\S]{0,200}text-danger/.test(src), true);
  check("while every other reason stays a centred line", /text-center text-2xs font-medium text-fg[\s\S]{0,120}stopReasonText/.test(src), true);
}

process.stdout.write("\nwhat an unsent message carries\n");
{
  const { echoAttachments } = await import("../src/attach.js");
  const chip = (state: string, uploadId: string | null) =>
    ({
      localId: `l_${uploadId ?? "x"}`,
      file: null,
      name: `${uploadId ?? "pending"}.png`,
      size: 11,
      mimeType: "image/png",
      state,
      progress: 1,
      uploadId,
      error: null,
      cancel: null,
    }) as never;

  // The rule sendableAttachments applies: the bubble and the prompt must carry one list.
  check(
    "only what the daemon has answered for",
    echoAttachments([chip("ready", "u_1"), chip("uploading", null), chip("failed", null)]).map((ref) => ref.uploadId),
    ["u_1"],
  );
  check("carrying what the bubble needs to draw it", echoAttachments([chip("ready", "u_1")])[0], {
    uploadId: "u_1",
    name: "u_1.png",
    mime: "image/png",
    bytes: 11,
    inlined: false,
  });
}

process.stdout.write("\nwhere a row says it works\n");
{
  const { displayCwd, pathCrumbs, shortPath } = await import("../src/paths.js");
  const home = ["/Users/rends"];

  check("a directory under a root loses the root", displayCwd("/Users/rends/2026-07-tare-reemoat", home), "~/2026-07-tare-reemoat");
  check("however deep it is", displayCwd("/Users/rends/a/b/c", home), "~/a/b/c");
  check("and the root itself is the root", displayCwd("/Users/rends", home), "~");
  check("a trailing slash on the root changes nothing", displayCwd("/Users/rends/x", ["/Users/rends/"]), "~/x");

  check(
    "the most specific root is the one that is cut",
    displayCwd("/Users/rends/work/api", ["/Users/rends", "/Users/rends/work"]),
    "~/api",
  );
  check("whichever order they arrive in", displayCwd("/Users/rends/work/api", ["/Users/rends/work", "/Users/rends"]), "~/api");

  check("a path under no root keeps the old rendering", displayCwd("/opt/thing/api", home), shortPath("/opt/thing/api"));
  check("and so does one with no roots at all", displayCwd("/Users/rends/x", []), shortPath("/Users/rends/x"));
  check("which is still two segments", displayCwd("/Users/rends/x", []), "…/rends/x");
  check("an empty root is not a prefix", displayCwd("/Users/rends/x", [""]), "…/rends/x");

  const labels = (path: string, roots: readonly string[]): string[] =>
    pathCrumbs(path, roots).map((crumb) => crumb.label);

  check("the crumb bar cuts the prefix a row cuts", labels("/Users/rends/a/b", home), ["~", "a", "b"]);
  check("and the root itself is one crumb", labels("/Users/rends", home), ["~"]);
  check("the most specific root wins here too", labels("/Users/rends/work/api", ["/Users/rends", "/Users/rends/work"]), ["~", "api"]);
  check("whichever order they arrive in", labels("/Users/rends/work/api", ["/Users/rends/work", "/Users/rends"]), ["~", "api"]);
  check("a prefix that is not a segment boundary is not a root", labels("/Users/rends/x", ["/Users/re"]), []);
  check("and a path under no root draws no crumbs at all", labels("/opt/thing", home), []);
  check("nor does an empty root list", labels("/Users/rends/x", []), []);

  const walked = pathCrumbs("/Users/rends/a/b", home);
  check(
    "and every crumb addresses a directory on the way",
    walked.map((crumb) => "/Users/rends/a/b".startsWith(crumb.path) && (crumb.path === "/Users/rends/a/b" || "/Users/rends/a/b"[crumb.path.length] === "/")),
    [true, true, true],
  );
  check("with the last one being the folder itself", walked[walked.length - 1]?.path, "/Users/rends/a/b");

  for (const [path, roots] of [
    ["/Users/rends/2026-07-tare-reemoat", home],
    ["/Users/rends/a/b/c", home],
    ["/Users/rends", home],
    ["/Users/rends/work/api", ["/Users/rends", "/Users/rends/work"]],
  ] as const) {
    check(
      `the crumbs join to the sentence for ${path}`,
      labels(path, roots).join("/"),
      displayCwd(path, roots),
    );
  }

  const { sessionLabel } = await import("../src/ui/bits.js");
  const row = (title: string | null, cwd: string) =>
    ({ snapshot: { title, workspace: { requestedCwd: cwd } } }) as never;
  const picker = readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8");
  check("the picker draws its path against the roots rather than raw", /\bpathCrumbs\(/.test(picker), true);
  check("and the inline copy that got it wrong is gone", /crumbs\.push\(\{ label: root/.test(picker), false);
  check("and it holds every root, not the first one", /setRoots\(result\.roots\)/.test(picker), true);
  check("and the footer does not repeat the folder the bar is drawing", /in <span className="font-mono/.test(picker), false);
  // Comment-stripped: this bans a class the browser receives, and a docblock may quote the old one.
  const pickerCode = stripComments(picker);
  const barAt = pickerCode.indexOf("const crumbs = pathCrumbs");
  const bar = pickerCode.slice(barAt, pickerCode.indexOf("{error !== null", barAt));
  // Crumb buttons only: Up one folder shares the row and legitimately has horizontal padding.
  const crumbButton = bar.slice(bar.indexOf("crumbs.map"), bar.indexOf("</button>", bar.indexOf("crumbs.map")));
  check("the crumbs are one continuous string", [/gap-x-/.test(bar), /px-/.test(crumbButton)], [false, false]);
  check("and each still answers to a finger", /-my-2 inline-flex min-h-11/.test(crumbButton), true);
  check("the picker offers a way up its own tree", /aria-label="Up one folder"/.test(picker), true);
  check("drawn always and disabled at the top, never conditionally rendered", /disabled=\{parent === null\}/.test(pickerCode), true);
  check("and it is not this app's back control wearing a folder's job", /icon=\{ChevronLeft\}/.test(picker), false);

  const header = readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8");
  check("and so does the session header's own line", /displayCwd\(where, roots\)/.test(header), true);

  // A name rather than a path, so no home marker (Q3.581).
  check("an unnamed session is called by where it works", sessionLabel(row(null, "/Users/rends/api"), home), "api");
  check("a named one is called by its name", sessionLabel(row("fix the build", "/Users/rends/api"), home), "fix the build");
  check("and with no roots it is what it always was", sessionLabel(row(null, "/Users/rends/api")), "…/rends/api");

  const browser = readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8");
  check("the row compares its location against its own label", /const subpath = located === label \? null : located;/.test(browser), true);
  check("and the label is built from the same roots", /sessionLabel\(row, roots\)/.test(browser), true);
}

process.stdout.write("\nthe way up, out of a pop-up\n");
{
  const { upFrom } = await import("../src/nav.js");

  const home = { name: "home" } as never;
  const gate = { name: "gate", screen: "register" } as never;
  const session = { name: "session", ref: { machineId: "m", sessionId: "s" } } as never;
  const index = { name: "settings", section: null, machineId: null, system: null, signin: null } as never;
  const account = { name: "settings", section: "account", machineId: null, system: null, signin: null } as never;
  const machines = { name: "settings", section: "machines", machineId: null, system: null, signin: null } as never;
  const oneMachine = { name: "settings", section: "machines", machineId: "m", system: null, signin: null } as never;
  const oneSystem = { name: "settings", section: "machines", machineId: "m", system: "moonshot", signin: null } as never;

  check("the session list has nowhere up, so no way out is drawn", upFrom(home, "/"), null);
  check("and so does a signed-out screen", upFrom(gate, "/"), null);

  check("a conversation goes back to the list", upFrom(session, "/"), "/");
  // Never history.back(): on a cold deep link there is one entry and Back would leave the app.
  check("from a deep link too, not into history", upFrom(session, "/m/m_1/s/s_1"), "/");

  check("a section goes up to the section list", upFrom(account, "/m/m_1/s/s_1"), "/settings");
  check("a system goes up to its machine", upFrom(oneSystem, "/"), "/settings/machines/m");
  {
    const { parseSettingsRoute } = await import("../src/settings.js");
    const stale = { name: "settings", ...parseSettingsRoute(["machines", "m", "plugins", "board"]) } as never;
    check("a stale plugin address goes up wherever its machine does", upFrom(stale, "/"), "/settings/machines");
  }
  check("a machine goes up to Machines", upFrom(oneMachine, "/"), "/settings/machines");
  check("and Machines goes up to the list", upFrom(machines, "/"), "/settings");
  check("the settings index leaves the sheet", upFrom(index, "/m/m_1/s/s_1"), "/m/m_1/s/s_1");
  check("onto home when it was opened cold", upFrom(index, "/"), "/");
  check("and so does the new-session sheet", upFrom({ name: "new", machineId: null, cwd: null } as never, "/m/m_1/s/s_1"), "/m/m_1/s/s_1");
}
