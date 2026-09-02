import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { type NavMove } from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * The marker an ordered list was written with
 *
 * `1)` and `1.` are both CommonMark and mdast records neither — a `list` node
 * carries `ordered`, `start` and `spread`, and the character is gone. So a message
 * saying `1)` was drawn `1.`, which is the app rewriting the one text it has no
 * business rewriting.
 *
 * Driven against hand-built trees rather than a real parse, deliberately: what the
 * plugin *is* is a rule about `position.start.offset` into the source, and feeding
 * it a tree it did not parse is what makes the offsets a claim rather than a
 * coincidence. The shape it walks is asserted against the real remark in the
 * transcript's own rendering, which no offline driver can reach.
 * ------------------------------------------------------------------ */

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

  // The offset points at the digit, never at the indentation before it — measured
  // against this repo's own remark-parse, and the pattern has no leading `\s*`
  // because of it. A tree whose offset lands elsewhere must mark nothing rather
  // than guess.
  check("an offset that is not on a marker marks nothing", classOf(run("  1) a", list(0))), undefined);
  check("and the real offset does", classOf(run("  1) a", list(2))), [PAREN_LIST]);

  // CommonMark's own ceiling is nine digits. Ten is not a list at all, and the
  // pattern must not match one anyway.
  check("nine digits is still a list marker", classOf(run("123456789) a", list(0))), [PAREN_LIST]);
  check("ten is not", classOf(run("1234567890) a", list(0))), undefined);

  // Nested lists are reached: the walk is over `children`, not over the root's
  // own arms, and a `1)` inside a bullet is the ordinary way people write one.
  {
    // 6 is where the `1` sits in `- x\n  1) a`, which is what remark records —
    // the digit, never the indentation before it.
    const nested = list(6);
    const root = { type: "root", children: [{ type: "listItem", children: [nested] }] };
    run("- x\n  1) a", root as never);
    check("a nested list is reached", classOf(nested), [PAREN_LIST]);
  }

  // A node with no position is what a synthesized tree looks like. It must be
  // skipped rather than read out of the source at offset 0.
  check("a node with no position is left alone", classOf(run("1) a", { type: "list", ordered: true })), undefined);
}

/* ------------------------------------------------------------------ *
 * Which way a navigation goes
 *
 * The rule behind the slide, and it lives outside `router.ts` because that file
 * reads `window.location` in its module body and cannot be imported here at all.
 * ------------------------------------------------------------------ */

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
  /*
   * ⚠ **The deepest fixture carries the field the depth is decided by.** This was
   * `agent: "claude"`, left behind when the route's leaf became a system, and `as
   * never` let it stand: with no `system` key at all `depthOf`'s `route.system !==
   * null` is satisfied by `undefined`, so the depth-4 arm was entered for the
   * wrong reason and `{name:"settings",section:"machines",machineId:"m",zzz:1}`
   * answered 4 just as readily. The literal is the only thing standing in for the
   * type here, which is exactly why it has to name the real field.
   */
  const oneSystem = { name: "settings", section: "machines", machineId: "m", system: "moonshot", signin: null } as never;
  /*
   * ⚠ **The third leaf under a machine, which no fixture named.** `signin` shipped
   * with a shape, a parse, a title and a path builder and was in neither `depthOf`
   * nor `settingsUp`, so its ◀ walked past the machine to the machines list and it
   * got no slide in either direction. Nothing here could see it: a `grep` for
   * `signin:` across this driver returned nothing at all, and every fixture above
   * omitting the key meant `route.signin !== null` was satisfied by `undefined` the
   * moment the arm was added — the exact trap the paragraph above this one records.
   * So all six carry it now, and this one carries a value.
   */
  const oneSignin = { name: "settings", section: "machines", machineId: "m", system: null, signin: "acme:gemini" } as never;

  check("opening a conversation pushes a screen", navMove(home, session), "push");
  check("and leaving it pops one", navMove(session, home), "pop");

  /*
   * **Inside a sheet the sheet moves, not the screen behind it.** Tapping a
   * section used to replace the panel's contents where they stood, which is the
   * teleport the horizontal slide exists to remove — one layer in from the one it
   * was first written for.
   */
  check("tapping a section pushes inside the sheet", navMove(index, account), "section-push");
  check("and Back pops inside it", navMove(account, index), "section-pop");
  check("a machine's agents are deeper still", navMove(machines, oneMachine), "section-push");
  check("and one system deeper again", navMove(oneMachine, oneSystem), "section-push");
  check("walking back up pops each time", navMove(oneSystem, oneMachine), "section-pop");
  check("a machine's sign-in is a leaf like the other two", depthOf(oneSignin), depthOf(oneSystem));
  check("so opening one from the machine slides", navMove(oneMachine, oneSignin), "section-push");
  check("and walking back up from it pops", navMove(oneSignin, oneMachine), "section-pop");
  /*
   * ⚠ **A plugin is no longer a depth in this sheet, and the URL that used to be
   * one has to agree.** Its settings moved to the plugin's own page under
   * `/plugins`, so `…/plugins/:pluginId` parses to the machine — and `depthOf`
   * has to answer the machine's depth for it, or a stale link animates against a
   * screen nobody is on. Driven through the parser rather than through a
   * hand-written literal, because the literal is what would keep agreeing with a
   * shape that no longer exists.
   */
  {
    const { parseSettingsRoute } = await import("../src/settings.js");
    const stale = { name: "settings", ...parseSettingsRoute(["machines", "m", "plugins", "board"]) } as never;
    check("a stale plugin address is the machine's depth", navMove(oneMachine, stale), null);
    check("and walking to it from Machines is one push, like the machine itself", navMove(machines, stale), "section-push");
  }

  /*
   * **Closing goes down, opening does not go anywhere.** The enter is
   * `SHEET_PANEL`'s own `animate-sheet` — CSS, on mount, on every engine — so a
   * transition here as well would animate one panel twice.
   */
  check("closing a sheet takes it down", navMove(account, session), "sheet-close");
  check("from any depth", navMove(oneSystem, home), "sheet-close");
  check("but opening one is CSS's job", navMove(session, index), null);
  check("from a session or from home", navMove(home, account), null);

  /*
   * The `null` arms are the load-bearing ones: each is a place motion would be
   * wrong rather than merely absent. Session → session is what a desktop rail
   * does all day and has no direction in it.
   */
  check("moving between two conversations moves nothing", navMove(session, other), null);
  check("nor does the same one twice", navMove(session, session), null);
  check("nor two sections at the same depth", navMove(account, users), null);
  check("a gate screen is beside the sign-in form, not past it", navMove(home, gate), null);

  // The two stacks are never compared, which is what `isSheet` is asked first for.
  check("a sheet is a sheet whatever its depth", [isSheet(index), isSheet(oneSystem)], [true, true]);
  check("and a screen is not", [isSheet(home), isSheet(session)], [false, false]);
  check("the four sheet depths are the four screens", [depthOf(index), depthOf(account), depthOf(oneMachine), depthOf(oneSystem)], [1, 2, 3, 4]);
  /*
   * ⚠ **And the same four through the parser, which is the only reading of them a
   * stale literal cannot fake.** `as never` above suppresses exactly the check
   * that would have caught the missing `system` key, and `depthOf`'s test is
   * `!== null` — satisfied by `undefined`, which a hand-written object supplies
   * for free and `parseSettingsRoute` can never produce. Driven from segments, a
   * field renamed in the union takes both ends with it. Same idiom the stale
   * plugin address above uses, and for the same reason.
   */
  {
    const { parseSettingsRoute } = await import("../src/settings.js");
    const parsed = (segments: readonly string[]) => ({ name: "settings", ...parseSettingsRoute(segments) }) as never;
    check(
      "and the same four read off real URLs rather than hand-written objects",
      [parsed([]), parsed(["account"]), parsed(["machines", "m"]), parsed(["machines", "m", "systems", "moonshot"])].map(depthOf),
      [1, 2, 3, 4],
    );
  }
  // `/new` has one screen, so nothing inside it can move.
  check("and a picker has one", depthOf({ name: "new", machineId: null, cwd: null } as never), 1);
  /*
   * ⚠ **The agent builder is a pop-up one depth *below* the picker**, which is
   * what makes leaving it a `section-pop` back onto New session rather than a
   * `sheet-close` out of the stack — and what `upFrom` has to agree with.
   */
  const builder = { name: "agent", machineId: "m_1", cwd: "/home/me", step: null } as never;
  const picker = { name: "new", machineId: "m_1", cwd: "/home/me" } as never;
  check("the builder sits under the picker", [depthOf(picker), depthOf(builder)], [1, 2]);
  check("and is a sheet like everything else in that stack", isSheet(builder), true);
  check("so opening it pushes", navMove(picker, builder), "section-push");
  check("and leaving it pops rather than closing the stack", navMove(builder, picker), "section-pop");
  /*
   * ⚠ **A choice is a third depth, not a menu.** `Dropdown` is right for a handful
   * of options anchored to their control; the model list is every model of every
   * system this daemon can reach, with a search box and a provider filter over it,
   * which is a screen. Being a route is what gives it the same slide, the same ◀
   * and the phone's Back — and what makes the pair below expressible at all.
   */
  const choosing = { name: "agent", machineId: "m_1", cwd: "/home/me", step: "llm" } as never;
  check("and a choice sits under the builder", depthOf(choosing), 3);
  check("so opening one pushes too", navMove(builder, choosing), "section-push");
  check("and answering it pops back", navMove(choosing, builder), "section-pop");
  /*
   * The two choosing screens are the *same* depth, so moving between them moves
   * nothing — `depthOf`'s own rule that the same pane with different contents is
   * not a direction. Nothing navigates between them today; this is the property
   * rather than the path.
   */
  check(
    "and the two choices are one depth, not two",
    navMove(choosing, { name: "agent", machineId: "m_1", cwd: "/home/me", step: "harness" } as never),
    null,
  );
  /*
   * ⚠ **Two different pop-ups swap, and the depths must not be compared at all.**
   * A depth is a position inside one stack: Settings → a section is 1 → 2 and a
   * Plugins tab is 1, so settings-account → plugins compared 2 against 1 and
   * answered `section-pop` — sliding one pop-up's pane rightwards into another's,
   * on top of a panel that was being unmounted and replaced anyway. Reported as
   * the pop-up vanishing for a frame. The swap arm has to come *before* the depth
   * test, which is what these two assert together. Q3.484.
   */
  const plugins = { name: "plugins", tab: "market", entry: null, settings: [] } as never;
  check("two pop-ups swap rather than sliding", navMove(account, plugins), "sheet-swap");
  check("in both directions", navMove(plugins, account), "sheet-swap");
  check("and a depth is never compared across them", navMove(index, plugins), "sheet-swap");
  check("while one pop-up's own depths still slide", navMove(index, account), "section-push");
  /*
   * `sheetKind` is what tells them apart, and `new`/`agent` are deliberately one:
   * that is why walking into the builder slides a pane instead of swapping.
   */
  check(
    "the agent flow is the same pop-up as the session it starts",
    [sheetKind(picker), sheetKind(builder), sheetKind(account), sheetKind(plugins)],
    ["new", "new", "settings", "plugins"],
  );
  check("and a screen belongs to no pop-up", sheetKind({ name: "home" } as never), null);

  /*
   * **The half of the slide that is not a function, and all three of its defects
   * were invisible to every driver here.**
   *
   * `navMove` decides *which* movement; `index.css` decides what a movement does,
   * and each of these was reported by somebody looking at a phone rather than
   * caught by anything in this process.
   *
   * **A width gate has to out-specify what it gates.** `@media` adds no
   * specificity, so `@media (min-width: 64rem) { ::view-transition-old(root) }` —
   * one pseudo-element, `(0,0,1)` — silently lost to
   * `:root[data-nav="push"]::view-transition-old(root)` at `(0,2,1)`, and the
   * desktop kept every animation it was written to be exempt from. Measured at
   * 1280px with `document.getAnimations()`: `nav-enter` and `nav-under` running
   * on the root pair. `prefers-reduced-motion` at the foot of the file had the
   * identical hole. So the invariant is the one that makes the class of bug
   * impossible rather than the two instances of it: **every view-transition rule
   * that sets an animation is keyed on `data-nav`**, which puts them all at one
   * specificity where source order — the thing a reader can actually see —
   * decides. A rule that sets anything else (`mix-blend-mode`, `z-index`) is not
   * scanned, because nothing overrules those by width.
   */
  const transitionCss = readFileSync(new URL("../src/index.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const animatingSelectors = [...transitionCss.matchAll(/([^{}]*::view-transition-[^{}]*)\{([^}]*)\}/g)]
    .filter((rule) => /animation\s*:/.test(rule[2] ?? ""))
    .flatMap((rule) => (rule[1] ?? "").split(",").map((one) => one.trim()))
    .filter((one) => one.length > 0);
  check("there are view-transition animations to check at all", animatingSelectors.length > 8, true);
  /*
   * ⚠ **And every movement the router can name has a rule saying what it does.**
   * This is the half with **no symptom at all** and it is the reason it is written
   * here: `navMove` returning a value `index.css` says nothing about is not an
   * error anywhere — the attribute is written onto the document, no rule matches,
   * and the browser plays its *default* cross-fade on the root pair, which looks
   * like a movement rather than like a bug. `sheet-swap` is the case that made
   * that concrete: its whole declaration is an `animation: none` that suppresses
   * the default, so losing the rule loses the fix and every assertion above stays
   * green — the animating-selector sweep asserts a property of the rules that
   * exist and says nothing about one that stopped existing.
   *
   * A `Record<NavMove, true>` rather than an array, and that is the whole reason
   * for the shape: a seventh member added to the union is a **compile** error
   * here, so the sweep cannot quietly stop covering the thing it was widened for.
   * An array typed `NavMove[]` accepts no wrong member and notices no missing one.
   */
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
  // The two that were dead. Named as well as covered by the rule above, because
  // the rule would also pass on a file that had deleted them.
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

  /*
   * **A closing sheet is one object, and the body giving up its name is the whole
   * of it.** A `view-transition-name` does not nest — a named descendant is lifted
   * out of its ancestor's snapshot into a *sibling* group — so with the body named
   * during a close the panel's frame travelled and its contents stood still.
   * Measured at 390px two fifths in: the head and the rounded top had moved and
   * every row inside was where it started. `router.ts` writes `data-nav` before
   * `startViewTransition`, so which elements are their own snapshot is a decision
   * each navigation gets to make.
   */
  check(
    "a closing sheet takes its contents with it",
    /:root\[data-nav="sheet-close"\] \[data-sheet-body\] \{\s*view-transition-name: none;/.test(transitionCss),
    true,
  );
  // …and the section slide still needs the name it gives back, or there is
  // nothing for `nav-enter` to move.
  check(
    "while a section still has a pane of its own to move",
    /\[data-sheet-body\] \{\s*view-transition-name: sheet-body;/.test(transitionCss),
    true,
  );
}

/* ------------------------------------------------------------------ *
 * A message that has been sent and has not come back
 *
 * Drawn in the conversation now rather than under it by the composer, which is
 * what makes it the transcript's business — and keyed by session, which is what
 * makes leaving the conversation mid-send and coming back show it still there.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe message on its way out\n");
{
  const { clearEcho, echoFor, echoVersion, landEcho, setEcho, settleEcho } = await import("../src/echo.js");
  const a = "m/a" as never;
  const b = "m/b" as never;

  check("a session with nothing outstanding has no echo", echoFor(a), null);
  setEcho(a, { text: "hello", seq: Number.MAX_SAFE_INTEGER, attachments: [] });
  check("one that sent something does", echoFor(a)?.text, "hello");
  check("and it is that session's alone", echoFor(b), null);

  /*
   * **The sentinel is what makes the ordinary case work.** Until the daemon names
   * a seq, nothing in the log can be newer — so an unrelated event arriving while
   * `POST /prompt` is still in flight must not clear a message that has not
   * landed yet.
   */
  settleEcho(a, 9_000);
  check("an unrelated event does not settle an unlanded message", echoFor(a)?.text, "hello");

  landEcho(a, 12);
  check("the daemon naming a seq lowers it", echoFor(a)?.seq, 12);
  settleEcho(a, 11);
  check("an earlier event still does not settle it", echoFor(a) !== null, true);
  settleEcho(a, 12);
  check("its own event does", echoFor(a), null);

  /*
   * ⚠ **The race that made this a store method rather than a call from the
   * composer.** `prompt` is on the 90-second slow-route budget and resumes a
   * terminal session first, while the `prompt` event comes down a socket waiting
   * for nothing — so the event routinely wins. `settleEcho` has already compared
   * it against the sentinel and quite correctly kept the echo, and `landEcho`
   * must not then resurrect a message the transcript is already drawing.
   */
  setEcho(b, { text: "again", seq: Number.MAX_SAFE_INTEGER, attachments: [] });
  clearEcho(b);
  landEcho(b, 40);
  check("a seq arriving after the log caught up resurrects nothing", echoFor(b), null);

  // The snapshot has to move, or `useSyncExternalStore` never re-reads.
  {
    const before = echoVersion();
    setEcho(b, { text: "x", seq: 1, attachments: [] });
    check("writing one is a change subscribers can see", echoVersion() > before, true);
    const written = echoVersion();
    clearEcho(b);
    check("and so is clearing it", echoVersion() > written, true);
    const cleared = echoVersion();
    clearEcho(b);
    check("but clearing nothing is not", echoVersion(), cleared);
  }
}

/* ------------------------------------------------------------------ *
 * The words a turn ends in
 *
 * Three places drew a wire identifier with its underscores taken out — `turn
 * cancelled`, `pump failed`, `ended: agent_exited` — at somebody reading their own
 * conversation to find out what happened to it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a turn says when it stops\n");
{
  const { resolvedByText, stopReasonText } = await import("../src/ui/tail.js");
  /*
   * Every member of `AnswerResolvedBy` except `client`, which never reaches the
   * caller — the answer beside it already says who. Written out rather than
   * derived, because a union cannot be enumerated at runtime and the point of the
   * assertion is that **none of them falls through to the identifier**.
   */
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
  // Legible, and never a guess: a daemon newer than this client sends a member
  // that is not in the table, and the honest answer is what the whole thing used
  // to be.
  check("an unknown one keeps the old rendering", resolvedByText("some_new_reason" as never), "some new reason");

  /*
   * `end_turn` is filtered by `showsInTranscript` and never reaches this, so the
   * three that do are all turns that did not get where they were going — plus
   * `cancelled`, which is the only one somebody *did* and the only one drawn red.
   */
  check("a cancelled turn says one word", stopReasonText("cancelled"), "cancelled");
  const others = ["max_tokens", "max_turn_requests", "refusal"] as const;
  check(
    "and the rest say what happened rather than naming a constant",
    others.filter((reason) => stopReasonText(reason).includes(reason)),
    [],
  );
  check("an unknown stop reason is drawn as itself", stopReasonText("weather"), "turn ended: weather");

  /*
   * ⚠ The tint and the shape are `EventList`'s, and the pair is the whole point:
   * a cancelled turn's `turn_end` is its last event, so it lands in the row
   * `WaitingFoot` occupied an instant earlier. Read off disk, because a JSX
   * branch is untestable here by construction.
   */
  const src = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8");
  check("a cancel is drawn in the working line's own shape", /stopReason === "cancelled" \?[\s\S]{0,300}WorkingMark still/.test(src), true);
  check("in danger, and it is the only stop reason that is", /stopReason === "cancelled" \?[\s\S]{0,200}text-danger/.test(src), true);
  check("while every other reason stays a centred line", /text-center text-2xs font-medium text-fg[\s\S]{0,120}stopReasonText/.test(src), true);
}

/* ------------------------------------------------------------------ *
 * Which chips ride a message that has not landed
 * ------------------------------------------------------------------ */

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

  // The same rule `sendableAttachments` applies, and it has to be: what the bubble
  // draws and what the prompt names are one list, or a chip is shown on a message
  // that did not carry it.
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

/* ------------------------------------------------------------------ *
 * What a row calls the folder it works in
 *
 * ⚠ Reported from a phone against a pinned row: the title read
 * `…/rends/2026-07-tare-r…` and the line under it `claude · …/rends/2026-07-ta…`
 * — the same absolute path, truncated twice, both of them mostly `/Users/rends`.
 * `folderNames` had already written down why two segments is wrong ("a wall of
 * `Users/rends`") and avoided it for folder *headers* while the rows went on
 * doing it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhere a row says it works\n");
{
  const { displayCwd, shortPath } = await import("../src/paths.js");
  const home = ["/Users/rends"];

  check("a directory under a root loses the root", displayCwd("/Users/rends/2026-07-tare-reemoat", home), "~/2026-07-tare-reemoat");
  check("however deep it is", displayCwd("/Users/rends/a/b/c", home), "~/a/b/c");
  check("and the root itself is the root", displayCwd("/Users/rends", home), "~");
  check("a trailing slash on the root changes nothing", displayCwd("/Users/rends/x", ["/Users/rends/"]), "~/x");

  /*
   * **The longest match wins**, because roots nest. `~/work` says more than `~`
   * about a path under both, and picking the first would make the answer depend
   * on the order a daemon happened to list them in.
   */
  check(
    "the most specific root is the one that is cut",
    displayCwd("/Users/rends/work/api", ["/Users/rends", "/Users/rends/work"]),
    "~/api",
  );
  check("whichever order they arrive in", displayCwd("/Users/rends/work/api", ["/Users/rends/work", "/Users/rends"]), "~/api");

  /*
   * **Two degradations, and both are exactly the old rendering.** `cwd` is not
   * confined, so a session outside every root is ordinary; and an empty list is
   * what an older daemon, an unreachable one and a listing that has not landed
   * yet all look like. Neither may invent a prefix.
   */
  check("a path under no root keeps the old rendering", displayCwd("/opt/thing/api", home), shortPath("/opt/thing/api"));
  check("and so does one with no roots at all", displayCwd("/Users/rends/x", []), shortPath("/Users/rends/x"));
  check("which is still two segments", displayCwd("/Users/rends/x", []), "…/rends/x");
  // A root that is empty or "/" must not turn every path into `~/…`.
  check("an empty root is not a prefix", displayCwd("/Users/rends/x", [""]), "…/rends/x");

  const { sessionLabel } = await import("../src/ui/bits.js");
  const row = (title: string | null, cwd: string) =>
    ({ snapshot: { title, workspace: { requestedCwd: cwd } } }) as never;
  check("an unnamed session is called by where it works", sessionLabel(row(null, "/Users/rends/api"), home), "~/api");
  check("a named one is called by its name", sessionLabel(row("fix the build", "/Users/rends/api"), home), "fix the build");
  /*
   * Defaulted rather than required, and the default is the honest one: every
   * caller that has no roots to hand gets the label this drew before roots
   * existed, rather than a guess about where home is.
   */
  check("and with no roots it is what it always was", sessionLabel(row(null, "/Users/rends/api")), "…/rends/api");

  /*
   * **The row draws the location once.** An unnamed session's *title* already is
   * its directory, so repeating it underneath is one fact twice in a row 40
   * characters wide — which is what the screenshot showed. Read off disk, because
   * the comparison is in JSX.
   */
  const browser = readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8");
  check("the row compares its location against its own label", /const subpath = located === label \? null : located;/.test(browser), true);
  check("and the label is built from the same roots", /sessionLabel\(row, roots\)/.test(browser), true);
}

/* ------------------------------------------------------------------ *
 * Telegram, whose chrome sits over this app's own
 *
 * The mini app draws ✕ Close until the page asks for a back button and ‹ Back
 * once it has — so "Close on the list, Back inside" is one function answering
 * `null` at the root. Everything asserted here is pure; the transport is not
 * reachable offline and is a no-op without it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat Telegram's own control does\n");
{
  const { upFrom } = await import("../src/nav.js");
  const { versionAtLeast, inTelegram } = await import("../src/telegram.js");

  const home = { name: "home" } as never;
  const gate = { name: "gate", screen: "register" } as never;
  const session = { name: "session", ref: { machineId: "m", sessionId: "s" } } as never;
  const index = { name: "settings", section: null, machineId: null, system: null, signin: null } as never;
  const account = { name: "settings", section: "account", machineId: null, system: null, signin: null } as never;
  const machines = { name: "settings", section: "machines", machineId: null, system: null, signin: null } as never;
  const oneMachine = { name: "settings", section: "machines", machineId: "m", system: null, signin: null } as never;
  const oneSystem = { name: "settings", section: "machines", machineId: "m", system: "moonshot", signin: null } as never;

  /*
   * **`null` is the answer, not the absence of one.** Telegram has one control:
   * hiding the back button is precisely how ✕ Close appears. So the session list
   * closing the app is this returning `null`.
   */
  check("the session list has nowhere up, which is what draws Close", upFrom(home, "/"), null);
  check("and so does a signed-out screen", upFrom(gate, "/"), null);

  check("a conversation goes back to the list", upFrom(session, "/"), "/");
  // Never `history.back()`: on a cold deep link there is one entry, and in a mini
  // app leaving the app *is* closing it — from a conversation, which is the thing
  // this exists to stop.
  check("from a deep link too, not into history", upFrom(session, "/m/m_1/s/s_1"), "/");

  /*
   * Inside the sheet it walks the same levels the ◀ already walks, and leaves by
   * the same door the ✕ uses — one rule, so the two controls cannot disagree.
   */
  check("a section goes up to the section list", upFrom(account, "/m/m_1/s/s_1"), "/settings");
  check("a system goes up to its machine", upFrom(oneSystem, "/"), "/settings/machines/m");
  /*
   * ⚠ **A plugin has no depth of its own here any more**, so the address that
   * used to have one goes up wherever the machine goes — not to the machine.
   * Driven through the parser rather than a literal: the literal is what would
   * keep asserting a walk out of a screen that no longer exists.
   */
  {
    const { parseSettingsRoute } = await import("../src/settings.js");
    const stale = { name: "settings", ...parseSettingsRoute(["machines", "m", "plugins", "board"]) } as never;
    check("a stale plugin address goes up wherever its machine does", upFrom(stale, "/"), "/settings/machines");
  }
  check("a machine goes up to Machines", upFrom(oneMachine, "/"), "/settings/machines");
  check("and Machines goes up to the list", upFrom(machines, "/"), "/settings");
  // At the index there is no level left inside the sheet, so up leaves it — for
  // whatever it was drawn over, which is what `Sheet`'s own ✕ does.
  check("the settings index leaves the sheet", upFrom(index, "/m/m_1/s/s_1"), "/m/m_1/s/s_1");
  check("onto home when it was opened cold", upFrom(index, "/"), "/");
  check("and so does the new-session sheet", upFrom({ name: "new", machineId: null, cwd: null } as never, "/m/m_1/s/s_1"), "/m/m_1/s/s_1");

  /*
   * **Segment-wise on integers**, which a string compare gets backwards at
   * exactly the version that matters: `6.10` is above `6.9`, and the back
   * button's gate is `6.1`.
   */
  check("6.1 is the gate and meets itself", versionAtLeast("6.1", "6.1"), true);
  check("6.0 is too old", versionAtLeast("6.0", "6.1"), false);
  check("6.10 is newer than 6.9, which a string compare denies", versionAtLeast("6.10", "6.9"), true);
  check("7 clears a 6.x gate on one segment", versionAtLeast("7", "6.1"), true);
  check("and 6 does not clear 6.1", versionAtLeast("6", "6.1"), false);
  /*
   * **Unparseable counts as too old**, and the direction is deliberate: refusing
   * the control leaves the client drawing Close, while asking an old client for a
   * back button is a request it answers by doing nothing — a page that believes
   * it has a control nobody can see.
   */
  check("a version that will not parse is too old", versionAtLeast("banana", "6.1"), false);
  check("and so is no version at all", versionAtLeast(null, "6.1"), false);

  // Nothing runs outside Telegram: the test is the injected transport, not a
  // pasted hash, and the driver has no such thing.
  check("none of this is live in an ordinary browser", inTelegram(), false);

  /*
   * **The bridge itself, driven.** Telegram's transport is a function it injects,
   * so a stub of it is the real contract rather than a mock of one — what goes
   * over it is a string this module built, and it is asserted verbatim.
   *
   * The stub is installed and removed inside this block: the `window` up top is
   * shared by every other check in this file, and a page that stays "in Telegram"
   * after this would change what modules imported later believe.
   */
  {
    const { setTelegramBack, telegramVersion } = await import("../src/telegram.js");
    const w = (globalThis as Record<string, unknown>)["window"] as Record<string, unknown>;
    const sent: string[] = [];
    w["TelegramWebviewProxy"] = { postEvent: (t: string, d: string) => void sent.push(`${t} ${d}`) };
    (w["location"] as Record<string, unknown>)["hash"] = "#tgWebAppVersion=6.9&tgWebAppPlatform=ios";

    check("the launch hash carries the version", telegramVersion(), "6.9");

    let pressed = 0;
    setTelegramBack(() => void (pressed += 1));
    check("asking for a back button posts one event", sent, ['web_app_setup_back_button {"is_visible":true}']);

    // The half that draws ✕ Close: one control, and hiding it is how the other
    // appears.
    sent.length = 0;
    setTelegramBack(null);
    check("and dropping it hides the same one", sent, ['web_app_setup_back_button {"is_visible":false}']);

    /*
     * Telegram delivers by **calling into the page**, so something has to define
     * the function it calls. Under `script-src 'self'` their SDK can never load,
     * which is what makes owning this global safe — see the module's docblock.
     */
    const view = (w["Telegram"] as { WebView: { receiveEvent: (t: string) => void } }).WebView;
    setTelegramBack(() => void (pressed += 1));
    view.receiveEvent("back_button_pressed");
    check("a press reaches the handler", pressed, 1);
    // An event we do not know must pass through untouched rather than count.
    view.receiveEvent("theme_changed");
    check("and nothing else does", pressed, 1);

    /*
     * **One screen, one handler.** Replaced rather than accumulated: a stack of
     * stale closures is how a press navigates to where you were three screens
     * ago.
     */
    let second = 0;
    setTelegramBack(() => void (second += 1));
    view.receiveEvent("back_button_pressed");
    check("the newest screen owns the press", [pressed, second], [1, 1]);

    // A client too old for the feature is asked for nothing at all, rather than
    // asked and silently ignored.
    sent.length = 0;
    (w["location"] as Record<string, unknown>)["hash"] = "#tgWebAppVersion=6.0";
    setTelegramBack(() => {});
    check("an old client is asked for nothing", sent, []);

    delete w["TelegramWebviewProxy"];
    delete w["Telegram"];
    (w["location"] as Record<string, unknown>)["hash"] = "";
    check("and the stub leaves nothing behind", inTelegram(), false);
  }

  /*
   * The two halves that are not pure, read off disk. The inset is a **floor**
   * rather than an addition — on a notched device `env()` and Telegram's pill
   * describe the same strip, and adding them double-counts.
   */
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  check("the Telegram header inset is a floor, not an addition", /:root\[data-telegram\] \.pt-safe \{\s*padding-top: max\(/.test(css), true);
  check("and it is scoped to Telegram", /\.pt-safe \{\s*padding-top: max\(0\.5rem/.test(css), true);
  const entry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  // `dataset["telegram"]` is the DOM spelling of the `[data-telegram]` the CSS
  // selects on; asserting the attribute string would pass on the comment.
  check("the marker is only written when the bridge is there", /if \(inTelegram\(\)\) \{[\s\S]{0,200}dataset\["telegram"\]/.test(entry), true);
  const bridge = readFileSync(new URL("../src/telegram.ts", import.meta.url), "utf8");
  /*
   * ⚠ The iframe transport is deliberately absent: the control plane sends
   * `frame-ancestors 'none'`, so Telegram Desktop and Web cannot load this page
   * and the arm would be unreachable. Adding it is the second half of letting
   * Telegram frame a document whose purpose is approving shell commands.
   */
  // Comments stripped, because the docblock *names* the absent transport and the
  // reason for it — which is the point of writing it down, and would otherwise
  // make this assertion fail on its own explanation.
  const bridgeCode = bridge.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no iframe transport, per the CSP", /window\.parent\.postMessage/.test(bridgeCode), false);
  check("and no script from anywhere else", /telegram\.org|<script/.test(bridgeCode), false);
  // The transport it *does* use is the one Telegram injects into its own webview.
  check("only the injected proxy", /TelegramWebviewProxy/.test(bridgeCode), true);
}
