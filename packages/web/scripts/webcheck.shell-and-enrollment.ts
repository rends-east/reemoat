import { readFileSync, readdirSync } from "node:fs";
import { check, report, storage } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * What the tab says to somebody who is not looking at it
 *
 * ⚠ **Two rules that had no assertion of any kind here**, and both of them are
 * about a surface this driver cannot render: the document's own `<title>`, and the
 * `<meta name="viewport">` that decides where the layout viewport goes when a
 * software keyboard opens. Neither is reachable by calling anything — one is an
 * effect writing to `document`, the other is a string in `index.html` that no
 * TypeScript in this package ever reads — so both are read off disk, which is the
 * form every placement assertion in this file already takes.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat this app says while nobody is looking at it\n");
{
  const appSrc = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  /*
   * **The tab says how many sessions are waiting, and it is the only thing this app
   * can say to somebody who is not looking at it.** Every other cross-screen signal
   * — the bell, `WaitingElsewhere`, the count on a machine tab, the count on a
   * folder header — is drawn in the rail, i.e. inside a tab that already has the
   * reader's attention, and the question this product is shaped around is *does
   * anything anywhere need me*.
   *
   * ⚠ **The count is `sessionLists(...).blocked`, the predicate every other consumer
   * already reads**, so there is one answer to "how many need me" and this cannot
   * become a second opinion disagreeing with the bell three inches away. That is
   * the half worth pinning: a hand-rolled `state.sessions.filter(…)` here would look
   * right, typecheck, and drift the first time the predicate moves.
   */
  check(
    "the badge counts what the bell counts",
    /const blocked = sessionLists\(state\)\.blocked\.length;/.test(appSrc),
    true,
  );
  check(
    "and it is a prefix on the plain name rather than a second title",
    /document\.title = blocked === 0 \? PAGE_TITLE : `\(\$\{blocked\}\) \$\{PAGE_TITLE\}`;/.test(appSrc),
    true,
  );
  /*
   * ⚠ **Restored on unmount as well as at zero**, which is what makes "the badge
   * never outlives the state that put it there" true by construction rather than by
   * remembering to clear it in the zero arm. The cleanup fires on every change too,
   * writing `PAGE_TITLE` and then immediately the new badge: one extra assignment,
   * and no window in which a stale count survives.
   */
  check("and it never outlives the state that put it there", /return \(\) => \{\s*document\.title = PAGE_TITLE;\s*\};/.test(appSrc), true);
  /*
   * ⚠ **The name is restated rather than read back out of `document.title`**, and
   * the pair is the assertion: the first thing this app does to that property is
   * overwrite it, so a value recovered from it at any later moment is whatever the
   * last render put there, badge and all. That leaves two copies of one string —
   * this one and the document's — which is exactly the drift this file exists to
   * catch, so they are compared.
   */
  const shipped = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  const named = /const PAGE_TITLE = "([^"]*)";/.exec(appSrc)?.[1] ?? "";
  check("both copies of the name were found", [shipped.length > 0, named.length > 0], [true, true]);
  check("and the tab is called the same thing before and after this app loads", named, shipped);

  /*
   * ⚠ **`interactive-widget=resizes-content`, which nothing in this package reads
   * and nothing asserted.** The default is `resizes-visual`, which does *not* move
   * the layout viewport when the software keyboard opens: `AppShell`'s `h-dvh` and
   * the composer's sticky `bottom-0` stay where they were, so on Chrome/Android the
   * box you are typing in is behind the keyboard — and on a plan card, whose whole
   * point is typing an answer, so are Send and the approvals. Nothing repositions
   * them; `Composer` compensates for its own height cap alone.
   *
   * Asserted as the **pair**, because the key alone is a fact about a file nobody
   * opens: the layout it is compensating for has to still be the one described, and
   * `h-dvh` moving out of `AppShell` is what would make this meta line a cargo cult
   * a reader could not evaluate. Browsers that do not know the key ignore it.
   */
  const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? "";
  const shell = stripComments(readFileSync(new URL("../src/ui/AppShell.tsx", import.meta.url), "utf8"));
  check("the viewport tag was found", viewport.length > 0, true);
  check(
    "the keyboard moves the layout viewport, and the layout it moves is still there",
    [/\binteractive-widget=resizes-content\b/.test(viewport), /\bh-dvh\b/.test(shell)],
    [true, true],
  );
  /*
   * The other half of the same tag, which predates it and is load-bearing for a
   * different reason: without `viewport-fit=cover` *and* the safe-area padding in
   * `index.css`, the bottom action bar sits under the iPhone home indicator, which
   * is exactly where the approve buttons are.
   */
  check("and the safe area is still opted into", /\bviewport-fit=cover\b/.test(viewport), true);
}

/* ------------------------------------------------------------------ *
 * Who owns Escape, and what paints above what
 *
 * `overlay.ts` is importable here — and has to stay that way — because its
 * `window.addEventListener` lives inside `push()` rather than in the module body.
 * That is the same constraint `settings.ts` states about itself: a decision this
 * file cannot reach is a decision nothing asserts, and the first maintenance edit
 * that hoists that listener would silently un-assert everything below.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwho owns Escape, and what paints above what\n");
{
  const { LAYER, decisionShortcutsEnabled, escapeAction, isOverlayPath, layerRank, shortcutsEnabled } = await import(
    "../src/ui/overlay.js"
  );
  const { SECTION_SPECS, settingsPath } = await import("../src/settings.js");

  const ask = { id: 1, kind: "ask" } as const;
  const menu = { id: 2, kind: "menu" } as const;
  const sheet = { id: 3, kind: "sheet" } as const;

  check("nothing open, nothing claimed", escapeAction([], false), { dismiss: null, stop: false });
  /*
   * Typing beats every layer, and this one rule is what four components used to
   * each defend with their own comment: Escape in the composer belongs to the
   * command menu, in `AskCard`'s "Other" box to the box, in `RenameField` to the
   * rename, in `DirectoryPicker`'s new-folder field to that form.
   */
  check("typing beats an open card", escapeAction([ask], true), { dismiss: null, stop: false });
  check("and beats an open sheet", escapeAction([sheet, menu], true), { dismiss: null, stop: false });

  check("one layer owns it", escapeAction([ask], false).dismiss, ask.id);
  check("a menu over a card takes it first", escapeAction([ask, menu], false).dismiss, menu.id);
  check("a menu inside a sheet, likewise", escapeAction([sheet, menu], false).dismiss, menu.id);
  /*
   * The case the old arrangement got wrong: a sheet opens over a session that has
   * an expanded question parked on it. Escape must close the sheet and leave the
   * card alone — before this, it folded a card nobody could see.
   */
  check("a sheet over a card takes it", escapeAction([ask, sheet], false).dismiss, sheet.id);

  /*
   * The contract, over every stack rather than the six above, because the failure
   * being replaced was exactly a component that stopped propagation *before*
   * deciding whether it would act — which ended the dispatch for everybody and
   * cancelled an agent's tool call while leaving the menu wide open.
   */
  const stacks = [[], [ask], [menu], [sheet], [ask, menu], [sheet, menu], [ask, sheet], [ask, menu, sheet]];
  check(
    "it stops the keystroke exactly when it acts on it",
    stacks.every((stack) =>
      [true, false].every((typing) => {
        const action = escapeAction(stack, typing);
        return action.stop === (action.dismiss !== null);
      }),
    ),
    true,
  );

  /*
   * `inert` does not block a `window` keydown, so without this guard `j`/`k`
   * navigate the list *behind* an open sheet — changing what is underneath while
   * it cannot be seen.
   *
   * Only a sheet blocks. A menu deliberately does not, which is a documented
   * non-change: a bare `j` with a `Dropdown` open navigates today and this layer
   * is not the place to decide otherwise.
   */
  check(
    "bare letters survive a menu and a card, and not a sheet",
    [[], [ask], [menu], [ask, menu], [sheet], [ask, sheet], [sheet, menu]].map(shortcutsEnabled),
    [true, true, true, true, false, false, false],
  );

  /*
   * **Deciding is not navigating, which is why there are two predicates.**
   *
   * `j` under an open `Dropdown` moves a caret and the worst case is looking at
   * the wrong row — a documented non-change. `2` under an open `Dropdown`
   * *approves a command*. `AskCard` gated its numbered answers on the rule above,
   * so with a session menu or the config bar's `…` popover open over a parked
   * question, a keystroke aimed at the menu resolved the permission underneath
   * it.
   *
   * `[ask]` answering `true` is the case that matters and the one an obvious
   * implementation gets backwards: the card registers itself with
   * `useDismissible("ask", …)` whenever it is open, so `layers.length === 0` —
   * which reads as the stricter, safer rule — is exactly the state in which there
   * is no card to answer, and would have disabled the shortcuts permanently while
   * passing every reading of the code.
   */
  check(
    "a numbered answer survives only the card's own layer",
    [[], [ask], [menu], [ask, menu], [sheet], [ask, sheet], [ask, menu, sheet]].map(decisionShortcutsEnabled),
    [true, true, false, false, false, false, false],
  );

  /*
   * **And every listener that could act on one actually asks.**
   *
   * The case above is the rule; this is obedience to it, and the two were apart
   * long enough for the gap to be a live defect. `shortcutsEnabled([ask, sheet])`
   * has always answered `false` — the exact stack this names — while `AskCard`
   * registered its own capture-phase `window` keydown for the digit shortcuts and
   * never asked. `keyboard.ts` asked, so the harmless listener was covered and the
   * one that *resolves a permission* was not: with a session parked on an approval
   * behind an open settings sheet, a bare `1` reached `option.onPick()`. `inert` on
   * `#root` does not stop a `window` keydown — the predicate's own docblock says
   * so — and `Sheet` focuses a `tabIndex={-1}` div, which `isTypingInto` answers
   * false for, so nothing else in the chain refused it either.
   *
   * Source text rather than a call, in the style of the `SessionBrowser.tsx` and
   * `Composer.tsx` pins above: there is no DOM here to dispatch a key into, and
   * what has to hold is a property of *every* such listener rather than of the two
   * that exist today. `overlay.ts` is the one exemption, because it is the arbiter
   * being consulted rather than a caller of it.
   */
  const uiRoot = new URL("../src/", import.meta.url);
  const keyListeners: string[] = [];
  const sweep = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) sweep(child);
      else if (/\.tsx?$/.test(entry.name) && entry.name !== "overlay.ts") {
        const text = readFileSync(child, "utf8");
        if (text.includes('window.addEventListener("keydown"')) {
          /*
           * **Either predicate counts, and there are two on purpose.**
           * `shortcutsEnabled` is about *navigating* and blocks only a sheet;
           * `decisionShortcutsEnabled` is about *deciding* and blocks a menu as
           * well. What this sweep is for is that a `window` keydown asks the
           * arbiter at all — which one it asks is the caller's judgement, and
           * `AskCard` is the reason the second exists.
           */
          const guarded =
            text.includes("shortcutsEnabled(currentLayers())") ||
            text.includes("decisionShortcutsEnabled(currentLayers())");
          keyListeners.push(`${entry.name}${guarded ? "" : " (UNGUARDED)"}`);
        }
      }
    }
  };
  sweep(uiRoot);
  check(
    "every window keydown listener outside the arbiter consults it",
    keyListeners.filter((name) => name.includes("UNGUARDED")),
    [],
  );
  check("and there are listeners to have checked", keyListeners.length > 0, true);

  /*
   * The ordering, in the one place that holds it. This is why `LAYER` is full
   * class strings rather than numbers in five files — Tailwind cannot see a
   * computed `z-${n}`, and an order spread across the things it orders is one
   * nothing can assert.
   */
  const names = ["header", "menu", "overlay", "toast"] as const;
  const ranks = names.map(layerRank);
  check("the layers are named in ascending order", ranks, [30, 40, 50, 60]);
  check(
    "and each is strictly above the last",
    ranks.every((rank, index) => index === 0 || rank > (ranks[index - 1] ?? 0)),
    true,
  );
  check("a toast outranks the sheet it reports a failure from", layerRank("toast") > layerRank("overlay"), true);
  check("every layer is a class Tailwind can see", names.map((name) => /^z-\d+$/.test(LAYER[name])), [
    true,
    true,
    true,
    true,
  ]);

  /*
   * **The sheet's box, as two class strings, because both defects it had were
   * invisible to every driver here.**
   *
   * A pop-up that scrolls and a pop-up that holds still are the two things every
   * sheet in this app must do, and neither is expressible in a type. They were
   * both broken at once and nothing failed: `typecheck` sees strings, `web:build`
   * emits whatever Tailwind recognises, and there is no DOM in this process to
   * measure a panel in. So they are pinned the same way the retired colour tokens
   * are — by reading the source of truth, which for these is the constant itself.
   *
   * `SHEET_BODY` must be a **flex column**. Both callers write `min-h-0 flex-1`
   * on their top child, and in a block container those two properties do nothing:
   * every inner scroller sized to its own content, got no scroll range, and then
   * its `overscroll-contain` stopped the wheel from chaining to the one box that
   * could move. The measured symptom was that no pop-up in the app scrolled at
   * all. `min-h-0` on the body itself is the other half — without it the body
   * refuses to shrink below its content and the panel's own height stops bounding
   * anything.
   *
   * `SHEET_PANEL` must carry a **definite** height and no `max-h-`. With a
   * ceiling alone the panel was content-sized: measured at 155px, 475px and 492px
   * for two, twelve and eighty lines of body, so walking the settings list
   * resized the dialog under a pointer already aimed at the next row.
   */
  const { SHEET_BODY, SHEET_PANEL } = await import("../src/ui/bits.js");
  const bodyClasses = SHEET_BODY.split(/\s+/);
  check(
    "a sheet's body is a flex column, so its children's flex-1 means something",
    ["flex", "flex-col", "min-h-0", "flex-1"].map((name) => bodyClasses.includes(name)),
    [true, true, true, true],
  );
  check("and it is the fallback scroller", bodyClasses.includes("overflow-y-auto"), true);
  /*
   * **And it paints its own ground, because it is the thing that slides.**
   *
   * This box carries the `view-transition-name` a section change moves, and being
   * named lifts it out of the panel's snapshot — so with the fill left to the
   * panel, both of its snapshots were transparent images of nothing but glyphs.
   * Measured mid-slide at 390px: the leaving list's rows and the arriving
   * section's fields were both fully legible, one drawn over the other. The
   * animation was correct throughout; a pane that arrives has to *cover* the one
   * it replaces, and that is a property of the element rather than of a keyframe.
   * Same colour as the panel behind it, so nothing at rest changes.
   */
  check("and it paints its own ground, so a slide covers what it replaces", bodyClasses.includes("bg-surface"), true);
  check("a sheet's height is definite at both widths", /(^|\s)h-\[/.test(SHEET_PANEL) && /\ssm:h-\[/.test(SHEET_PANEL), true);

  /*
   * **The ask card's two ceilings are whole strings, and that has to be asserted
   * as *text*.** Tailwind v4 scans source files rather than evaluating them, so a
   * class assembled from fragments — `max-h-[min(${n}dvh,100%)]` — emits no CSS at
   * all, and the failure is a card with no height rule rather than an error
   * anybody sees. Same class of hazard as a utility naming a token that does not
   * exist, and the same remedy.
   *
   * `tall` is spent on a plan and nothing else, which is a decision about
   * `PermissionCard` rather than about this table — so the pin below reads that
   * file for the *reason* the size is chosen: `context.plan`, never the title
   * "Ready to code?", which is what a later tidy-up would quietly reach for.
   */
  const askCardSrc = readFileSync(new URL("../src/ui/AskCard.tsx", import.meta.url), "utf8");
  check(
    "the ask card's height ceilings are literal classes",
    ["max-h-[min(70dvh,100%)]", "max-h-[min(88dvh,100%)]"].map((cls) => askCardSrc.includes(`"${cls}"`)),
    [true, true],
  );
  check("and neither is built out of an interpolation", /max-h-\[min\(\$\{/.test(askCardSrc), false);
  /*
   * The digit beside an answer is a **keyboard** shortcut, so it is hidden on a
   * touch device — on the pointer and never on a breakpoint, since a half-width
   * desktop window still has a keyboard. The handler is deliberately untouched.
   */
  check("the answer numbers are hidden on a coarse pointer", askCardSrc.includes('"pointer-coarse:hidden"'), true);
  check("and that is asked of the pointer, not of the width", /sm:hidden[^"]*\{index \+ 1\}/.test(askCardSrc), false);
  /*
   * ⚠ **Nothing an agent asked reaches a person shortened, and the collapsed bar was
   * the last place in this app that did it.** The daemon stopped clipping a
   * question's prose and a permission's title in this release; a CSS ellipsis over
   * the result would have moved the same loss one layer out, where it is worse
   * because nothing can even say it happened. The bar is one line by intent and has
   * a control that opens it, which is exactly why it looked defensible.
   *
   * Read off disk because `webcheck` has no DOM and this is a class string, and
   * pinned as an *absence* — `truncate` anywhere on this file is the regression,
   * since every other string on the card already wraps.
   */
  // Class attributes only, both spellings — the word survives in this file's own
  // prose, twice, and it is *meant* to: both places argue why the thing it names is
  // not there.
  const askCardClasses = [...askCardSrc.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`)/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
  check("the scan found the card's class strings", askCardClasses.length >= 10, true);
  check("and none of them clips text", askCardClasses.filter((cls) => /\btruncate\b/.test(cls)), []);
  check("the collapsed bar wraps instead", askCardSrc.includes('text-xs font-medium wrap-anywhere">{title}'), true);
  /*
   * **The transcript's record of a settled question draws the question**, which it
   * did not until 0.3.0 — see `answeredQuestions`. Source text, because the join is
   * a prop and a component that simply stopped reading it would leave every pure
   * assertion above green while the screen went back to "Please answer the following
   * questions." over four bare values.
   */
  const eventListSrc = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8");
  check(
    "a settled question's row is handed the questions rather than fetching them",
    /<ElicitationResolvedRow event=\{event\} asked=\{node\.asked\} \/>/.test(eventListSrc),
    true,
  );
  check("and draws each one over its answer", /answer\.question \?\? answer\.label/.test(eventListSrc), true);
  const permissionCardSrc = readFileSync(new URL("../src/ui/PermissionCard.tsx", import.meta.url), "utf8");
  check(
    "a plan gets the room because it is a plan, not because of what it is titled",
    /size=\{context\.plan !== null \? "tall" : "normal"\}/.test(permissionCardSrc),
    true,
  );
  check("and nothing on that card matches a plan by its title", permissionCardSrc.includes("Ready to code?"), false);
  check("and never a ceiling it can shrink under", /(^|\s)(sm:)?max-h-/.test(SHEET_PANEL), false);

  check(
    "the overlay paths",
    [
      "/settings",
      "/settings/account",
      "/settings/machines/m_1/systems/anthropic",
      "/new",
      "/new/m_1",
      "/agent/m_1",
      "/agent/m_1/%2Fhome%2Fme",
    ].map(isOverlayPath),
    [true, true, true, true, true, true, true],
  );
  check(
    "and the screens that are not overlays",
    ["/", "/m/m_1/s/s_1"].map(isOverlayPath),
    [false, false],
  );
  // Whole segments, not a prefix: a future `/settingsomething` is not settings.
  check("a longer first segment is not one of them", isOverlayPath("/settingsomething"), false);

  /*
   * The cross-file pin. Adding a settings section must not be able to create a
   * route the shell does not know to draw as an overlay — which would render it as
   * a bare screen with no ✕ and nothing behind it.
   *
   * `newPath` cannot be reached the same way (it lives in `router.ts`, which this
   * file cannot import), so the `/new` forms above are literals. Said out loud
   * rather than left looking symmetric.
   */
  check(
    "every settings section is an overlay path",
    SECTION_SPECS.every((spec) => isOverlayPath(settingsPath(spec.id))),
    true,
  );
}

/* ------------------------------------------------------------------ *
 * Nothing names a colour that no longer exists
 *
 * **Tailwind v4 does not error on an unknown token.** `bg-warn` with no
 * `--color-warn` in `@theme` emits no rule whatsoever — no background, no build
 * warning, no type error — which was measured on the commit that introduced this
 * palette by building a deliberate `bg-nonexistent` and watching it pass.
 *
 * So the seven names retired when the palette went monochrome cannot be caught by
 * `typecheck` or by `web:build`; a missed call site just loses its fill and looks
 * like a rendering bug months later. This is the gate, in the same source-text
 * style as the two assertions that read `SessionBrowser.tsx` and `Composer.tsx`.
 * ------------------------------------------------------------------ */

process.stdout.write("\nnothing names a colour that no longer exists\n");
{
  /*
   * `add` and `del` were on this list and have come off it.
   *
   * They were retired with the other four when the palette went monochrome, and
   * they are back with real values because a diff is the one thing here that is
   * *content* rather than a control: `danger`'s "never a fill, never more than one
   * in a view" is a rule about identifying a control, and a changed line is neither.
   * What keeps that from being a licence is measured at the tokens themselves — the
   * fill is tinted and the text is not — and enforced below, where their presence is
   * now asserted exactly as the others' absence is.
   */
  const RETIRED = ["accent", "accent-ink", "warn", "ok"];
  const LIVE = ["add", "add-ink", "del", "del-ink"];
  const root = new URL("../src/", import.meta.url);
  const files: string[] = [];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) walk(child);
      else if (/\.(tsx?|css)$/.test(entry.name)) files.push(child.pathname);
    }
  };
  walk(root);

  /*
   * The property side, not the whole word: `bg-added` and `text-okay` are not
   * these tokens, and `--color-danger` survives and must not be caught.
   */
  const pattern = new RegExp(
    `\\b(?:text|bg|border|ring|from|to|fill|stroke|decoration|outline|shadow|divide|accent)-(?:${RETIRED.join("|")})\\b`,
  );
  /*
   * Comments are stripped, and that is the opposite decision from the
   * `groups.orphans` assertion two sections up — deliberately, because the two
   * are asking different questions.
   *
   * That one bans a *name* outright: reaching past the helper is wrong however it
   * is spelled, and a comment naming the field is a reader one step from writing
   * it. This one is about a class the browser will try to apply, and this
   * codebase keeps its history in its docblocks — `bits.tsx` explains why
   * `focus:border-accent` was deleted, `Markdown.tsx` says what a link used to
   * be, and `index.css` names `bg-warn` in the very paragraph explaining the
   * hazard this check exists for. Failing on those would mean deleting the record
   * of why the check is here.
   */
  const stripped = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const offenders = files
    .filter((file) => pattern.test(stripped(readFileSync(file, "utf8"))))
    .map((file) => file.slice(file.indexOf("/packages/web/") + "/packages/web/".length));

  report(
    "no utility class names a retired colour",
    offenders.length === 0,
    offenders.length === 0 ? `${files.length} files` : offenders.join(", "),
  );
  // And the tokens really are gone, so the gate above is asserting something.
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  check(
    "and the tokens themselves are gone from @theme",
    RETIRED.filter((name) => new RegExp(`^\\s*--color-${name}:`, "m").test(css)),
    [],
  );
  /*
   * The same property from the other side, and it is the half this gate was missing.
   *
   * The hazard is a utility whose token does not exist — the background silently
   * never paints — so banning dead names only covers the case where the *name*
   * arrives last. Deleting `--color-add` while `bg-add` stayed in `DiffView` is the
   * same failure with the two halves swapped, and nothing would have caught it:
   * `typecheck` sees a string, `web:build` emits no rule, and a diff quietly loses
   * the only thing that says which lines were removed.
   */
  check(
    "and the live ones are really declared",
    LIVE.filter((name) => !new RegExp(`^\\s*--color-${name}:`, "m").test(css)),
    [],
  );
  // The one non-neutral value that stayed, and the reason it is the only one.
  check("the one exception survives", /--color-danger:\s*#7e362b/.test(css), true);

  /*
   * **A pointer over anything pressable, and the rule is layered.**
   *
   * Tailwind v3's preflight set it and v4 dropped it, so every button in this
   * app drew the ordinary arrow — invisible on a phone, and on a desktop the
   * only cue an unfilled button has left, since with the accent gone a control
   * is drawn in the colour of what it sits on.
   *
   * Both halves are asserted because each fails silently on its own: without
   * `:disabled` the arrow stops distinguishing a control that will not act, and
   * **unlayered it would beat every utility regardless of specificity** — the
   * trap the focus-ring docblock in this same file was written for — making
   * `cursor-default` a dead class wherever somebody needs one.
   */
  const cursorRule = /@layer base \{[\s\S]*?cursor: pointer;[\s\S]*?\}/.exec(css)?.[0] ?? "";
  check("a pressable thing shows a pointer", cursorRule.length > 0, true);
  check("and a disabled one does not", /button:not\(:disabled\)/.test(cursorRule), true);

  /*
   * ⭐ **One way to copy, because the browser API is missing on the deployment
   * this is read from.**
   *
   * `navigator.clipboard` is defined **only in a secure context**, and the control
   * plane is routinely served over plain http on a LAN address — measured on the
   * running stack: `isSecureContext` false, `navigator.clipboard` undefined,
   * `document.execCommand("copy")` true. So a direct call is not a call that
   * sometimes fails; it is a control that never works there, and the three that
   * existed each carried their own `catch` explaining the silence away.
   *
   * The remedy is one module with a fallback, and the thing that keeps it one is
   * this: the API may be named in `ui/clipboard.ts` and nowhere else under
   * `packages/web/src`. Comments are stripped for the reason the palette gate one
   * paragraph up gives — the docblocks here explain what was wrong, and failing on
   * the record of it would delete the record.
   *
   * The reverse half matters as much and is asserted with it: the fallback must
   * still be in that file. A `copyText` that quietly became a bare
   * `navigator.clipboard` call again passes the first check and fails this one.
   */
  const clipboardFile = "src/ui/clipboard.ts";
  const usesClipboardApi = files
    .filter((file) => /navigator\.clipboard/.test(stripped(readFileSync(file, "utf8"))))
    .map((file) => file.slice(file.indexOf("/packages/web/") + "/packages/web/".length));
  check("the clipboard API is named in one file", usesClipboardApi, [clipboardFile]);
  const clipboardSrc = readFileSync(new URL("../src/ui/clipboard.ts", import.meta.url), "utf8");
  check(
    "and that file still carries the insecure-origin fallback",
    /execCommand\("copy"\)/.test(clipboardSrc),
    true,
  );
}

/* ------------------------------------------------------------------ *
 * A URL that will not decode
 *
 * `parse` runs in `router.ts`'s **module body** — `let current =
 * parse(window.location.pathname)` — so a segment `decodeURIComponent` refuses
 * threw during module evaluation and took the whole ES module graph with it. The
 * control plane's SPA fallback served `index.html` correctly, the bundle loaded,
 * and `#root` stayed empty: a blank white page, no error, no console, on a phone,
 * that a reload cannot fix. One truncated link pasted out of a chat app, or a
 * stray `%` typed into the bar, is the whole input.
 *
 * **The import *is* the assertion**, which is why this section is shaped unlike
 * every other one here. There is nothing to hand a fixture to: `parse` is module
 * -private and `useRoute` is a hook, so the parsed *value* cannot be read from a
 * driver with no React — and it does not need to be, because the failure was
 * never a wrong route, it was no application at all. So `window.location.pathname`
 * is set to the malformed path **before** the dynamic import, and the module
 * either evaluates or it does not. Reverting `decodeSegment` to a bare
 * `decodeURIComponent` fails the first check here with the `URIError` itself.
 *
 * The second half is the same claim on the path a tap takes rather than a load:
 * `navigate` re-parses synchronously through `announce`, so a link carrying a
 * malformed id throws out of the click handler with the app already mounted.
 * ------------------------------------------------------------------ */

process.stdout.write("\na URL that will not decode\n");
{
  /*
   * Three more members on the stub, added here rather than at the top: this is
   * the only module that reads any of them, and `pathname` in particular has to
   * carry a *specific* value at import time, which is a property of this section
   * rather than of the fixture every other one shares.
   *
   * `pushState` writes the path back onto the stub, because that is the part of
   * the browser `navigate` relies on: it pushes and then re-parses whatever
   * `window.location.pathname` now says.
   */
  const stub = (globalThis as Record<string, unknown>)["window"] as Record<string, unknown>;
  const loc = stub["location"] as Record<string, unknown>;
  const go = (path: string): void => void (loc["pathname"] = path);
  stub["addEventListener"] = (): void => {};
  stub["history"] = {
    pushState: (_state: unknown, _title: string, path: string): void => go(path),
    replaceState: (_state: unknown, _title: string, path: string): void => go(path),
  };

  // A lone trailing `%` — `decodeURIComponent("s_1%")` is "URI malformed" — in the
  // session half of a real session URL, which is the shape a truncated paste has.
  go("/m/m_1/s/s_1%");

  let router: typeof import("../src/router.js") | null = null;
  let loadError: string | null = null;
  try {
    router = await import("../src/router.js");
  } catch (cause) {
    loadError = String(cause);
  }
  // Reported rather than checked so the rest of the section is reachable when it
  // fails — a throw here would take the enrollment section below with it, which is
  // the crash-truncation failure this file avoids elsewhere by the same means.
  report(
    "the app still evaluates under a path that will not decode",
    loadError === null,
    loadError ?? "imported with window.location.pathname = /m/m_1/s/s_1%",
  );

  if (router !== null) {
    const { navigate, newPath, parsePath, sessionPath } = router;
    const threw = (path: string): string | null => {
      try {
        navigate(path);
        return null;
      } catch (cause) {
        return String(cause);
      }
    };

    check("and a tap on one does not throw out of the handler", threw("/m/m_1/s/s_1%"), null);
    // The machine half, the `/new` route and a bare segment, because each is a
    // separate `decodeSegment` call site and one left bare is one blank page.
    check("nor does a machine id that will not decode", threw("/m/m_1%/s/s_1"), null);
    check("nor does /new with one", threw("/new/m_1%"), null);
    /*
     * The shape a truncated paste really has, as opposed to a lone `%`: an escape
     * that begins and does not finish. `decodeURIComponent("%E0%A4%A")` throws for
     * the same reason and looks nothing like a typo, which is why it is here — a
     * fixture chosen only from the "obvious" `%` would let a half-fixed decode
     * through. (A lone `%` in a segment nothing decodes — `/%`, which is home —
     * never reached the failure at all, so it is not a fixture.)
     */
    check("nor does an escape that begins and does not finish", threw("/m/%E0%A4%A/s/x"), null);

    /*
     * And nothing a link in this app produces goes near any of that: both path
     * builders encode, so the decode is always the inverse of an encode. Asserted
     * with a `%` in the id itself — the value that would round-trip *wrongly* if
     * either side were dropped, rather than merely throw.
     */
    check("what this app builds is encoded", sessionPath({ machineId: "m_1%", sessionId: "s_1%" } as never), "/m/m_1%25/s/s_1%25");
    check("and so is a new-session link", newPath("m_1%" as never), "/new/m_1%25");
  /*
   * The folder rides the path as **one** segment, so a POSIX path cannot split
   * into several however deep it is — which is the whole reason it is not a query
   * string: `parse` reads `pathname` and nothing else.
   */
  check(
    "a folder rides the new-session link as one segment",
    newPath("m_1" as never, "/home/u/api"),
    "/new/m_1/%2Fhome%2Fu%2Fapi",
  );
  check("and comes back whole", (parsePath("/new/m_1/%2Fhome%2Fu%2Fapi") as { cwd: string | null }).cwd, "/home/u/api");
  check("with no folder it is null rather than empty", (parsePath("/new/m_1") as { cwd: string | null }).cwd, null);
  check("and a folder needs a machine to belong to", newPath(undefined, "/home/u/api"), "/new");
    check("which parses without incident", threw(sessionPath({ machineId: "m_1%", sessionId: "s_1%" } as never)), null);
  }
}

/* ------------------------------------------------------------------ *
 * The three lines a daemon is started with
 *
 * Pinned as a literal, because this is text somebody pastes into a shell on
 * another machine and the code inside it is single-use: a wrong variable name
 * fails at daemon startup talking about enrollment rather than about a typo here,
 * and the code is spent either way.
 *
 * **Both values are single-quoted, and that is a hazard rather than a tidy-up.**
 * `controlPlaneUrl` is `publicUrl(c)` on the control plane —
 * `new URL(c.req.url).origin` — so it comes from the request's own `Host` header,
 * which anybody who can reach the service writes. Measured 2026-08-08 through a
 * real `node:http` server: a `Host` of ``a`id`b``, `a$(id)b`, `a'b` and `a;id`
 * all reach `URL.origin` intact, and sourcing the unquoted line then *executes*
 * it — measured, ``export REEMOAT_CONTROL_PLANE=http://a`touch PWNED`b`` created
 * the file and left the variable reading `http://ab`, so the person pasting sees
 * a plausible URL and nothing else. `deploy/lib.sh`'s `sq` has applied this rule
 * to the env file since the `REEMOAT_ENROLL_CODE=xy$(touch PWNED)` incident; the
 * paste is the same text arriving by hand into the same shell.
 *
 * `packages/control-plane/scripts/cpctl.ts` prints the same three lines from its
 * own copy. Two ways to start a machine that print different things is how one of
 * them quietly stops working — and both docblocks used to claim they were kept
 * byte-identical while **nothing anywhere compared them**. That is what the second
 * half of this section is: cpctl's own body, run.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe three lines a daemon is started with\n");
{
  const { enrollmentLines, enrollmentExpiryText } = await import("../src/enrollment.js");

  check(
    "exactly what cpctl prints",
    enrollmentLines("https://cp.example", "ec_abc"),
    "export REEMOAT_AUTH=signed\nexport REEMOAT_CONTROL_PLANE='https://cp.example'\nexport REEMOAT_ENROLL_CODE='ec_abc'",
  );
  // `REEMOAT_AUTH=signed` is ours and constant, so it is the one line with
  // nothing to quote. Quoting it too would be harmless and is not done, which is
  // worth pinning so nobody "fixes" the asymmetry into a rule about all three.
  check("the constant line carries no quotes", enrollmentLines("https://cp", "ec").split("\n")[0], "export REEMOAT_AUTH=signed");

  /*
   * The four `Host` shapes measured through `URL.origin`, each of which is shell
   * *source* when unquoted. Nothing here asserts the shell's behaviour — that was
   * measured outside this driver — only that every one of them comes out as data.
   */
  const urlLine = (url: string): string | undefined => enrollmentLines(url, "ec_x").split("\n")[1];
  check("a backtick is data", urlLine("http://a`id`b"), "export REEMOAT_CONTROL_PLANE='http://a`id`b'");
  check("so is a command substitution", urlLine("http://a$(id)b"), "export REEMOAT_CONTROL_PLANE='http://a$(id)b'");
  check("so is a semicolon", urlLine("http://a;id"), "export REEMOAT_CONTROL_PLANE='http://a;id'");
  check("and so is an ampersand", urlLine("http://a&id"), "export REEMOAT_CONTROL_PLANE='http://a&id'");
  /*
   * The arm that could be mistaken for defensive, and is not: an apostrophe
   * survives `URL.origin` as measured, so without `'\''` the quoting could be
   * closed and stepped straight out of — which is the whole attack rather than a
   * corner of it.
   */
  check(
    "an apostrophe cannot close the quoting",
    urlLine("http://a'b"),
    "export REEMOAT_CONTROL_PLANE='http://a'\\''b'",
  );
  // The code is minted by the control plane and is not caller-influenced, so this
  // half is belt rather than braces — and it is applied anyway, because a rule
  // that holds for one of two adjacent values is a rule somebody deletes.
  check(
    "the code is quoted by the same rule",
    enrollmentLines("https://cp", "ec_a'b").split("\n")[2],
    "export REEMOAT_ENROLL_CODE='ec_a'\\''b'",
  );

  /**
   * `cpctl`'s own `enrollmentLines`, made callable.
   *
   * It cannot be imported: that file is a CLI whose module body reads
   * `process.argv` and dispatches, it lives in another package, and the function
   * is not exported. So its **source** is read and its **body** is run, which is
   * the only form of this check that compares behaviour rather than a
   * transcription of it.
   *
   * One transformation, and it is narrow on purpose: `: string` is the entire
   * TypeScript content of that body (a local arrow's parameter and return type).
   * If the function grows an annotation this does not know about, the result
   * fails to parse and this driver throws — loudly, which is the failure mode to
   * want, rather than silently comparing something else.
   *
   * `BASE_URL` is a free variable there (`controlPlaneUrl || BASE_URL`), so it is
   * passed in as a third parameter. That fallback is the only permitted
   * difference between the two copies and is asserted below rather than assumed.
   */
  /*
   * ⚠ **Named, because there are two functions extracted this way now.** The
   * second is `shellQuote`, which `packages/control-plane/src/app.ts` has a third
   * copy of for `GET /install.sh` — where the value substituted in comes from the
   * caller's `Host` header, so a copy that drifts is remote code execution in a
   * script people pipe into `sh`. Generalising the name rather than writing a
   * second extractor is what keeps the four refusals below covering both.
   */
  const extract = (
    source: string,
    name: string,
    params: readonly string[],
  ): ((...args: string[]) => string) => {
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`function ${name}(`));
    if (start < 0) throw new Error(`no top-level ${name} to extract`);
    // A top-level declaration in these files ends at a bare `}` in column 0,
    // which is why this does not have to count braces through template literals.
    const end = lines.indexOf("}", start);
    if (end < 0) throw new Error(`${name} has no closing brace in column 0`);
    const body = lines.slice(start + 1, end).join("\n").replaceAll(": string", "");
    return new Function(...params, body) as (...args: string[]) => string;
  };

  const callable = (source: string): ((url: string, code: string, baseUrl: string) => string) =>
    extract(source, "enrollmentLines", ["controlPlaneUrl", "code", "BASE_URL"]) as (
      url: string,
      code: string,
      baseUrl: string,
    ) => string;

  const cpctl = callable(
    readFileSync(new URL("../../control-plane/scripts/cpctl.ts", import.meta.url), "utf8"),
  );
  for (const [url, code] of [
    ["https://cp.example", "ec_abc"],
    ["http://a`id`b", "ec_x"],
    ["http://a$(id)b", "ec_x"],
    ["http://a'b", "ec_a'b"],
    ["http://a;id", "ec_$(id)"],
  ] as const) {
    check(`cpctl agrees on ${JSON.stringify(url)}`, cpctl(url, code, "https://unused"), enrollmentLines(url, code));
  }
  /*
   * The one divergence, asserted so that it stays the only one. `cpctl` falls back
   * to its own `REEMOAT_CP_URL` when the response carried no URL; the browser
   * copy has no equivalent and needs none, because the page is served by the
   * control plane it is talking to.
   */
  check(
    "cpctl's only divergence is its BASE_URL fallback",
    cpctl("", "ec_x", "https://fallback"),
    enrollmentLines("https://fallback", "ec_x"),
  );

  /*
   * The extraction's **failure mode**, which is the one thing about this check
   * that a reader of `enrollment.ts` is now told to rely on.
   *
   * That docblock used to claim nothing anywhere compared the two copies, which
   * was false in the direction that costs the guard: a contributor tightening the
   * shell quoting would have concluded there was no cross-file check and either
   * edited one copy or deleted this whole block as dead scaffolding. It now says
   * what is actually enforced *and* what the coupling rests on — a top-level
   * `function enrollmentLines(` read to the next bare `}` in column 0 — and
   * promises that renaming or nesting it makes this driver **throw** rather than
   * quietly skip the comparison.
   *
   * A comment cannot be asserted, and this is not an attempt to assert one: it is
   * the property the corrected comment now promises, driven against `callable`
   * itself. A rewrite of the extractor that silently skipped instead — the
   * plausible "improvement", since a throw in a driver looks like a bug — would
   * leave the two copies free to diverge with this section still printing `ok`,
   * and fails here instead.
   */
  const extractionFails = (source: string): boolean => {
    try {
      callable(source);
      return false;
    } catch {
      // The throw is the answer; its message is `callable`'s own and is not pinned
      // here, because what matters is loud rather than which words.
      return true;
    }
  };
  check("a renamed function is not silently skipped", extractionFails("function enrollLines(a, b) {\n  return a;\n}\n"), true);
  check("nor is a nested one", extractionFails("const x = {\n  function enrollmentLines(a, b) {\n    return a;\n  }\n}\n"), true);
  check(
    "nor is one whose closing brace never reaches column 0",
    extractionFails("function enrollmentLines(a, b) {\n  return a;\n  }\n"),
    true,
  );
  /*
   * An annotation *inside* the body that the strip does not know about is a
   * `SyntaxError` out of `new Function` — the same loudness by another route, and
   * the reason the docblock names the one transformation (`: string`, the local
   * arrow's parameter and return type) rather than leaving it to be discovered.
   * The signature line itself is discarded with the braces, which is why this
   * fixture puts the annotation on a local.
   */
  check(
    "and neither is an annotation this cannot strip",
    extractionFails("function enrollmentLines(a, b) {\n  const q = (v: URL) => String(v);\n  return q(a);\n}\n"),
    true,
  );
  // And the shape it does accept, so the three above are refusals rather than a
  // helper that refuses everything.
  check(
    "while the shape cpctl actually has is extracted",
    extractionFails("function enrollmentLines(controlPlaneUrl: string, code: string): string {\n  return controlPlaneUrl;\n}\n"),
    false,
  );

  /*
   * **The third `shellQuote`, compared rather than trusted.**
   *
   * `packages/control-plane/src/app.ts` has its own copy because `GET
   * /install.sh` substitutes an origin into a shell script and cannot import
   * either of the other two — `packages/web` is a Vite bundle that service only
   * serves, and the image's runtime stage carries no web `src` at all. So the
   * agreement is asserted the only way it can be: both bodies read off disk, made
   * callable, and run over the same hostile table.
   *
   * The table is the measured one. A `Host` of ``a`id`b``, `a$(id)b`, `a'b` and
   * `a;id` all reach `URL.origin` intact, and the apostrophe arm is the one that
   * matters most: without `'\''` the quoting can be closed and stepped out of,
   * which is the whole attack rather than a corner of it.
   */
  {
    const quoteOf = (source: string): ((value: string) => string) =>
      extract(source, "shellQuote", ["value"]) as (value: string) => string;
    const webQuote = quoteOf(readFileSync(new URL("../src/enrollment.ts", import.meta.url), "utf8"));
    const appQuote = quoteOf(
      readFileSync(new URL("../../control-plane/src/app.ts", import.meta.url), "utf8"),
    );
    for (const hostile of [
      "https://cp.example",
      "http://a`id`b",
      "http://a$(id)b",
      "http://a'b",
      "http://a;id",
      "http://a$&b",
      "http://a''b",
    ]) {
      check(`app.ts quotes ${JSON.stringify(hostile)} as web does`, appQuote(hostile), webQuote(hostile));
    }
    // And that the shared body is the one that actually defends: a bare
    // `'${value}'` would pass every line above except this one.
    check("an apostrophe is closed, escaped and reopened", appQuote("a'b"), "'a'\\''b'");
  }

  /*
   * `installCommand` — the third place shell text is rendered in this repository,
   * and the first that is *printed on a screen for somebody to paste*.
   */
  {
    const { installCommand } = await import("../src/enrollment.js");
    check(
      "the installer command is the literal both READMEs carry",
      installCommand("https://app.reemoat.com"),
      "curl -fsSL 'https://app.reemoat.com/install.sh' | sh",
    );
    // One trailing slash, removed once — `https://cp//install.sh` is a 404 with
    // nothing in it that says why.
    check("a trailing slash does not double", installCommand("https://cp/"), installCommand("https://cp"));
    // The URL is data here too. It cannot be attacker-chosen on a same-origin
    // page, which is exactly why an unquoted version would have looked fine.
    check(
      "and the origin is data, not source",
      installCommand("http://a`id`b"),
      "curl -fsSL 'http://a`id`b/install.sh' | sh",
    );
  }

  /*
   * **Which screens print it, and which deliberately do not.**
   *
   * The composer strip's `MachineLine` has the same three-arm empty state and is
   * the obvious place to copy this to; it is a field label on a 390px phone
   * beside a door that already leads to the screen that has the command, and
   * `.claude/rules/web-composer.md`'s rule is that a control never leaves the
   * strip. Asserted rather than left to a comment, because "put it in all three"
   * is what a reader of the other two would reasonably do.
   */
  {
    const reads = (path: string): string =>
      stripComments(readFileSync(new URL(`../src/ui/${path}`, import.meta.url), "utf8"));
    const browser = reads("SessionBrowser.tsx");
    const machines = reads("settings/MachinesSection.tsx");
    const newSession = reads("NewSession.tsx");
    check(
      "the two screens with room for it call the one renderer",
      [/installCommand\(/.test(browser), /installCommand\(/.test(machines)],
      [true, true],
    );
    // Never a hand-typed second copy: `docscheck` pins the READMEs against the
    // same function, and a literal here would be a third thing to keep in step.
    check(
      "and neither writes the command out by hand",
      [/curl -fsSL/.test(browser), /curl -fsSL/.test(machines)],
      [false, false],
    );
    check("the composer strip does not draw it", /installCommand/.test(newSession), false);
    /*
     * And the door-or-the-sentence property is untouched: the command sits inside
     * the `mayAddMachine` arm on both, so the state that says there is no way to
     * add a machine still shows no way to add one.
     */
    check(
      "the command is inside the door arm, not beside the notice",
      [
        /mayAddMachine\(state\.me\) \? \([\s\S]{0,1200}installCommand\(/.test(browser),
        // The door is one arm of a ternary now — the other arm is the notice
        // under the same heading (decision 3B) — so the window is a few tags of
        // wrapper, never long enough to reach across into the notice arm.
        /canAdd \? \([\s\S]{0,200}<CommandLine command=\{installCommand\(/.test(machines),
      ],
      [true, true],
    );
  }

  const now = 1_700_000_000_000;
  check("time left is said in minutes", enrollmentExpiryText(now + 58 * 60_000, now), "expires in 58m");
  check("and in hours when there are some", enrollmentExpiryText(now + 61 * 60_000, now), "expires in 1h 1m");
  check("a spent code says so", enrollmentExpiryText(now - 1, now), "expired");
}

/* ------------------------------------------------------------------ *
 * How wide the rail is
 *
 * `clampRailWidth` is the only place a width is bounded and there are four ways
 * in — the drag, the two keyboard steps, the stored value and the reset — so the
 * interesting cases are the ones no pointer produces: a hand-edited
 * `localStorage` entry, and the `NaN` that `Number.parseInt` answers for it.
 *
 * The shell is asserted the way the retired colours and the `orphansFor` coupling
 * are, by reading source text: what has to hold is that the width reaches the DOM
 * as a **custom property** rather than as a React `style` prop. That is not a
 * preference — `store` publishes on a four-second poll and on every streamed
 * event, so a width React owns is a width that snaps back to the start of the drag
 * every time one lands, and the bug would only ever appear on a session that was
 * talking.
 * ------------------------------------------------------------------ */

process.stdout.write("\nhow wide the rail is\n");
{
  const { RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, clampRailWidth } = await import("../src/ui/rail.js");

  check("the bounds leave a usable range and the default is inside it", [RAIL_MIN < RAIL_DEFAULT, RAIL_DEFAULT < RAIL_MAX], [
    true,
    true,
  ]);
  check("the default is the width this shipped at", RAIL_DEFAULT, 312);

  check("a width inside the bounds is kept", clampRailWidth(360), 360);
  check("too narrow is refused rather than allowed", clampRailWidth(10), RAIL_MIN);
  check("and so is too wide", clampRailWidth(4000), RAIL_MAX);
  check("the bounds are inclusive", [clampRailWidth(RAIL_MIN), clampRailWidth(RAIL_MAX)], [RAIL_MIN, RAIL_MAX]);
  check("a fractional pointer position is rounded", clampRailWidth(360.6), 361);

  /*
   * The three a pointer cannot produce. `Number.parseInt("wide", 10)` is `NaN`,
   * and `NaN` compared against a bound is `false` in *both* directions — so a bare
   * `Math.min`/`Math.max` pair passes it through untouched and the rail mounts at
   * `NaN` pixels, which computes to zero width and no visible rail at all.
   */
  check("a hand-edited storage value cannot produce a rail of NaN", clampRailWidth(Number.NaN), RAIL_DEFAULT);
  check("nor can an infinity", [clampRailWidth(Infinity), clampRailWidth(-Infinity)], [RAIL_DEFAULT, RAIL_DEFAULT]);

  /*
   * **The two halves a source-text pin cannot see, and both are load-bearing.**
   *
   * Everything above asserts the clamp and the wiring, and every one of them stays
   * green with the body of `setRailWidth` reduced to `width = next`. That is not a
   * hypothetical: it leaves a rail that still *drags* — the handle writes the
   * custom property itself — while the width silently stops surviving a reload and
   * the keyboard and the double-click reset stop doing anything at all, because
   * both of those reach the DOM only through the subscriber that re-runs
   * `AppShell`'s effect. A feature broken in three places with seven drivers green
   * is the shape this repo calls a property the code appears to have and nothing
   * enforces, so it is asserted behaviourally rather than by reading the file.
   */
  const { railWidth, setRailWidth, subscribeRail } = await import("../src/ui/rail.js");

  let notified = 0;
  const unsubscribe = subscribeRail(() => void (notified += 1));

  setRailWidth(RAIL_DEFAULT + 40);
  check("a committed width is readable back", railWidth(), RAIL_DEFAULT + 40);
  check("and every subscriber is told", notified, 1);
  check(
    "and it is written where a reload will find it",
    storage.get("reemoat.railWidth"),
    String(RAIL_DEFAULT + 40),
  );

  // Idempotent: the drag commits on every `pointerup`, including the ones that
  // moved nothing, and a fan-out per no-op would re-render the shell for nothing.
  setRailWidth(RAIL_DEFAULT + 40);
  check("committing the same width again tells nobody", notified, 1);

  // Out of range still commits — clamped — rather than being dropped, which is
  // what makes a drag that runs off the edge settle at the bound instead of
  // snapping back to where it started.
  setRailWidth(9999);
  check("a width past the bound commits the bound", railWidth(), RAIL_MAX);
  check("and that is a change, so it is announced", notified, 2);

  unsubscribe();
  setRailWidth(RAIL_DEFAULT);
  check("and an unsubscribed listener stops hearing", notified, 2);
  check("while the value still moved", railWidth(), RAIL_DEFAULT);

  const shell = readFileSync(new URL("../src/ui/AppShell.tsx", import.meta.url), "utf8");
  check(
    "the width reaches the rail as a custom property, not a React style prop",
    /lg:w-\[var\(--rail-w\)\]/.test(shell),
    true,
  );
  check("and nothing sets an inline width on the aside", /<aside[^>]*style=/.test(shell), false);
  check("the drag writes that property directly", /setProperty\("--rail-w"/.test(shell), true);
  check(
    "the handle is bounded by the same helper the store is",
    /clampRailWidth\(origin\.width \+ event\.clientX - origin\.x\)/.test(shell),
    true,
  );
  /*
   * Capture rather than `window` listeners, and this is the half that is invisible
   * to every other check here: released outside the browser window, an uncaptured
   * pointer delivers no `pointerup` to the document at all, so the strip stays
   * armed and the next click anywhere resizes the rail.
   */
  check("the drag captures its pointer", /setPointerCapture\(event\.pointerId\)/.test(shell), true);
  check("and adds no window listener to leak", /window\.addEventListener\("pointer/.test(shell), false);

  /*
   * **The handle paints above the two sticky bars, and both halves of that are
   * reversible by an edit that looks like tidying.**
   *
   * `Header` is `sticky` at `LAYER.header` and `Composer` is `sticky` in the same
   * pane. A positioned element with `z-auto` loses to one with `z-30`, so the grab
   * strip has to carry `LAYER.header` *and* come after `<main>` — equal z-index,
   * later sibling. Move `<RailHandle />` back between the panes, or drop the layer
   * class, and the top and bottom of a full-height divider go dead while every
   * driver here stays green and the app looks entirely normal.
   */
  check("the handle is on the z-order table rather than a literal", /\$\{LAYER\.header\}/.test(shell), true);
  /*
   * Both operands are checked against `>= 0` first: rename either and `indexOf`
   * answers -1, and `n > -1` is *true* for every real position, so an unguarded
   * comparison passes with the ordering it pins no longer expressible.
   */
  const railHandle = shell.indexOf("<RailHandle />");
  const contentPane = shell.indexOf("<main ");
  check("the handle is still rendered by the shell", railHandle >= 0, true);
  check("and there is still a content pane for it to follow", contentPane >= 0, true);
  check(
    "and comes after the content pane, which is what breaks the tie",
    railHandle >= 0 && contentPane >= 0 && railHandle > contentPane,
    true,
  );
  check("it is anchored on the rail's own width", /left: "var\(--rail-w\)"/.test(shell), true);

  /*
   * `index.css` has to carry the default too. The effect that syncs the stored
   * width runs *after* first paint, so without a declared value the rail mounts at
   * whatever `w-[var(--rail-w)]` falls back to — which is nothing — and jumps a
   * frame later on every reload.
   */
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  /*
   * **Derived from `RAIL_DEFAULT`, not a second literal**, which is the whole point
   * of the check rather than a nicety. It was written `/--rail-w:\s*19\.5rem/` and
   * passed beside `check(RAIL_DEFAULT, 312)` — two numbers pinned independently,
   * with nothing asserting they are the same number, and they were not: `19.5rem`
   * is 312px only at a 16px root, nothing in this app sets one, and `AppShell`
   * writes px unconditionally. So a reader on Chrome's "Large" got a 78px snap on
   * every load, of exactly the kind the CSS declaration exists to prevent, with
   * both assertions green. Same move `pincheck` makes for an agent version written
   * down in two files.
   */
  check(
    "and CSS declares the same number in the same unit, so the first paint is not a jump",
    new RegExp(`--rail-w:\\s*${RAIL_DEFAULT}px`).test(css),
    true,
  );
  check("and nothing declares it in a unit that depends on the reader's font size", /--rail-w:\s*[\d.]+r?em/.test(css), false);
  check(
    "the handle is in the one focus rule rather than styling its own",
    /\[role="separator"\]\[tabindex\]/.test(css),
    true,
  );
}
