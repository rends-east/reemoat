import { check, report } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";

process.stdout.write("\nwhat a released drag does to a sheet\n");
{
  const { DISMISS_PX, FLING, VELOCITY_MS, claimDrag, detentAfter, dismissAt, releaseVelocity, sheetRelease } =
    await import("../src/ui/sheetMotion.js");

  // Measured in Chromium with touch emulation against the old picker: 60px in 60ms snapped back (Q3.650).
  check("a flick dismisses although it travelled less than the distance", sheetRelease(60, 1, 257), "dismiss");
  check("and the same distance dragged slowly does not", sheetRelease(60, 0.1, 257), "stay");
  check("a slow drag past the distance dismisses", sheetRelease(DISMISS_PX, 0, 800), "dismiss");
  check("and one pixel short of it does not", sheetRelease(DISMISS_PX - 1, 0, 800), "stay");
  check("a short panel needs a third of itself, not the whole distance", [dismissAt(150), sheetRelease(50, 0, 150)], [50, "dismiss"]);
  check("flung back toward open, no distance dismisses", sheetRelease(400, -FLING, 800), "stay");
  check("and a fling from above its resting edge is no dismissal either", sheetRelease(-10, 3, 800), "stay");
  check("the fling threshold is its own boundary", [sheetRelease(1, FLING, 800), sheetRelease(1, FLING - 0.01, 800)], ["dismiss", "stay"]);

  const steady = Array.from({ length: 8 }, (_, index) => ({ t: 1000 + index * 16, at: index * 16 }));
  check("a steady finger's speed is its speed", releaseVelocity(steady, 1112), 1);
  check("a finger that stopped before lifting has none", releaseVelocity(steady, 1112 + VELOCITY_MS + 1), 0);
  check("half a window of stillness halves it", releaseVelocity(steady, 1112 + VELOCITY_MS / 2) < 1, true);
  check("and a release with no moves has none", releaseVelocity([], 5), 0);

  const top = { atStart: true, atEnd: false };
  const middle = { atStart: false, atEnd: false };
  const bottom = { atStart: false, atEnd: true };
  // The expanded list claimed every touch before this, so a full picker could not be swiped at all.
  check("a scroller at its top hands a downward drag to the panel", claimDrag(20, 0, top, true), true);
  check("one scrolled down keeps it, to scroll back", claimDrag(20, 0, middle, true), false);
  check("and an upward drag stays the scroller's while it has more", [claimDrag(-20, 0, top, true), claimDrag(-20, 0, bottom, true)], [false, true]);
  check("outside any scroller, the panel's either way", [claimDrag(20, 0, null, true), claimDrag(-20, 0, null, true)], [true, true]);
  check("a move mostly across the axis is never the panel's", claimDrag(20, 20, null, true), false);
  check("and an engine already panning is not argued with", claimDrag(40, 0, null, false), false);

  check(
    "the picker's detents: a fling picks by direction, otherwise the nearer",
    [detentAfter(300, -1, 257, 791), detentAfter(700, 1, 257, 791), detentAfter(600, 0, 257, 791), detentAfter(400, 0, 257, 791)],
    ["full", "rest", "full", "rest"],
  );
}

process.stdout.write("\none clock, one curve, every sliding panel\n");
{
  const { SHEET_EASE, SHEET_MS } = await import("../src/ui/sheetMotion.js");
  const css = stripComments(srcFile("index.css"));
  check("the stylesheet's clock is the scripts'", /--sheet-ms:\s*(\d+)ms;/.exec(css)?.[1], String(SHEET_MS));
  check("and so is its curve", /--sheet-ease:\s*([^;]+);/.exec(css)?.[1], SHEET_EASE);
  const tokens = ["sheet", "sheet-out", "scrim", "scrim-out", "drawer", "drawer-out"].map((name) => [
    name,
    new RegExp(`--animate-${name}:\\s*${name} var\\(--sheet-ms\\) var\\(--sheet-ease\\)`).test(css),
  ]);
  check("every arrival and exit runs on both", tokens.filter(([, ok]) => ok !== true).map(([name]) => name), []);
  // The mirrored curve moved 8% of the way in 60% of the time: a flung sheet stopped dead under the finger.
  check("and no exit curve starts at rest", /cubic-bezier\(1, 0, 0\.68, 0\.28\)/.test(css), false);
  check(
    "an exit has no `from`, so a dragged panel leaves from where it was let go",
    [/@keyframes sheet-out \{\s*to \{/.test(css), /@keyframes drawer-out \{\s*to \{/.test(css), /@keyframes (?:sheet|drawer)-out \{\s*from/.test(css)],
    [true, true, false],
  );
  check(
    "and a routed sheet's close is the same exit, not the arrival reversed",
    [
      /:root\[data-nav="sheet-close"\]::view-transition-old\(sheet\) \{\s*animation: var\(--animate-sheet-out\);/.test(css),
      /:root\[data-nav="sheet-close"\]::view-transition-old\(scrim\) \{\s*animation: var\(--animate-scrim-out\);/.test(css),
      /view-transition-old\((?:sheet|scrim)\) \{\s*animation: (?:sheet|scrim) [^;]*reverse/.test(css),
    ],
    [true, true, false],
  );
}

process.stdout.write("\none drag, and every surface uses it\n");
{
  const drag = stripComments(srcFile("ui/sheetDrag.ts"));
  const motion = stripComments(srcFile("ui/sheetMotion.ts"));
  report("both halves were read", drag.length > 0 && motion.length > 0, `${drag.length} + ${motion.length} chars`);
  check("the decisions import nothing, so this driver reaches them", /\bimport\b/.test(motion), false);
  check("a finger goes through the one touch plumbing", /useTouchGesture<T>\(/.test(drag), true);
  check(
    "and its slop and the mouse's are rowDrag's, never re-typed",
    /import \{ MOUSE_SLOP, PRESS_MS, PRESS_SLOP, useTouchGesture, type TouchOps \} from "\.\/rowDrag";/.test(drag),
    true,
  );
  check(
    "the list's gestures share the axis rule, through the one arbiter",
    [/going\.mode = listGesture\(dx, dy, \{/.test(stripComments(srcFile("ui/machineSwipe.ts"))), /Math\.abs\(dx\) > Math\.abs\(dy\) \* DOMINANCE/.test(motion)],
    [true, true],
  );
  // Pointer events for a finger were the defect: the engine's pan fired pointercancel and the sheet never moved.
  check("a finger never takes the pointer path", /if \(event\.pointerType === "touch"\) \{/.test(drag), true);
  check(
    "the scroll is refused only once the drag is the panel's",
    /if \(mine && event\.cancelable\) event\.preventDefault\(\);/.test(drag),
    true,
  );
  check("a touchcancel is a cancel, never a release", /finish\(going, event\.timeStamp, event\.type === "touchcancel"\)/.test(drag), true);
  check(
    "a mouse is captured at engage and never at the press",
    [/if \(mine && !was\) event\.currentTarget\.setPointerCapture\(event\.pointerId\);/.test(drag), /onPointerDown[\s\S]{0,400}?setPointerCapture/.test(drag)],
    [true, false],
  );
  check(
    "the click a drag leaves behind is swallowed, and only that one",
    [/onClickCapture: \(event\) => \{\s*if \(event\.timeStamp - ended\.current > CLICK_AFTER_DRAG_MS\) return;/.test(drag), /ended\.current = Number\.NEGATIVE_INFINITY;\s*const now = latest\.current;/.test(drag)],
    [true, true],
  );
  check("the layout gate is asked per gesture, never cached", /now\.gate\.current\?\.offsetParent/.test(drag), true);
  check("and no breakpoint is read in JavaScript", /matchMedia|innerWidth|clientWidth/.test(drag), false);
  check(
    "a drag that begins mid-arrival or mid-settle starts where the panel is drawn",
    [/new DOMMatrixReadOnly\(getComputedStyle\(node\)\.transform\)/.test(drag), /if \("animationName" in running\) running\.finish\(\);/.test(drag)],
    [true, true],
  );
  check(
    "a dismissal leaves the offset where it is",
    /if \(sheetRelease\(state\.current\.from \+ travel, velocity, state\.current\.extent\) === "dismiss"\) \{\s*state\.current\.left = node;\s*dismiss\.current\(\);\s*\} else settle\(node\);/.test(drag),
    true,
  );
  check("and a settle is the sheet's own curve", /`\$\{name\} \$\{String\(SHEET_MS\)\}ms \$\{SHEET_EASE\}`/.test(drag), true);

  const surfaces = {
    "ui/AgentConfigBar.tsx": /useSheetGesture<HTMLDivElement>\(\{ axis: "down"/,
    "ui/TaskPanel.tsx": /useSheetGesture<HTMLElement>\(\{ axis: "down", enabled: open, geometry, gate: grabber, held: panelRef, scrim: scrimRef \}\)/,
    "ui/MenuDrawer.tsx": /useSheetGesture<HTMLElement>\(\{ axis: "left", enabled: open, geometry, held: panelRef, scrim: scrimRef \}\)/,
    "ui/Sheet.tsx": /useSheetGesture<HTMLDivElement>\(\{ axis: "down", enabled: true, geometry, gate: grabber, held: panelRef, scrim: scrimRef \}\)/,
  };
  const bodies = Object.entries(surfaces).map(([rel, re]) => [rel, stripComments(srcFile(rel)), re] as const);
  check("every sliding panel drags through the one hook", bodies.filter(([, body, re]) => !re.test(body)).map(([rel]) => rel), []);
  check(
    "and spreads both of its halves on the panel",
    bodies.filter(([, body]) => !/ref=\{drag\.ref\}\n\s+\{\.\.\.drag\.bind\}/.test(body)).map(([rel]) => rel),
    [],
  );
  check(
    "and none of them keeps a gesture of its own",
    bodies.filter(([, body]) => /setPointerCapture|onPointerMove=|addEventListener\("touch/.test(body)).map(([rel]) => rel),
    [],
  );
  // Named whole: each is a retired per-surface copy of a number sheetMotion.ts now holds once (Q3.566-Q3.568, Q3.650).
  const RETIRED = /\b(?:DRAWER_EXIT_MS|SHEET_EXIT_MS|TASK_PANEL_EXIT_MS|SHEET_SETTLE_MS|SHEET_DISMISS_PX|SHEET_DRAG_STEP)\b/;
  check("nor a clock or a threshold of its own", bodies.filter(([, body]) => RETIRED.test(body)).map(([rel]) => rel), []);
  // The picker's settle once put its transition back a frame later; the hand-off is now written with nothing animating.
  check("and no settle hands off a frame later", /\bpaintNow\b|requestAnimationFrame/.test(bodies[0]?.[1] ?? ""), false);
  check(
    "the panels that change shape at a width are gated on a grabber that CSS hides there",
    [
      /GRABBER_BELOW_MD = "[^"]*\bmd:hidden"/.test(stripComments(srcFile("ui/TaskPanel.tsx"))),
      /<span ref=\{grabber\} aria-hidden className="[^"]*\bsm:hidden" \/>/.test(stripComments(srcFile("ui/Sheet.tsx"))),
    ],
    [true, true],
  );
  // The head was the routed sheet's only grip, and the owner asked for it to drag like the pickers (Q3.651).
  check("a routed sheet drags from anywhere on it, as every other panel does", /\bgrip\b|headRef/.test(drag + (bodies[3]?.[1] ?? "")), false);
  check(
    "a scroller is found by what it is, at the first move past the slop, and marked by nobody",
    [
      /const overflow = getComputedStyle\(node\)\.overflowY;\s+if \(overflow === "auto" \|\| overflow === "scroll"\) return node;/.test(drag),
      /going\.decided = true;\s+if \(now\.axis === "down"\) going\.scroller = scrollerOf\(going\.target, going\.panel\);/.test(drag),
      [drag, ...bodies.map(([, body]) => body)].some((body) => /data-sheet-scroll/.test(body)),
    ],
    [true, true, false],
  );
  check(
    "a finger held past a long press is selecting text or arming a row, and is left alone",
    /if \(!going\.decided && event\.timeStamp - going\.t > PRESS_MS\) \{/.test(drag),
    true,
  );
  check("and a move an inner gesture already refused is not argued with", /const free = event\.cancelable && !event\.defaultPrevented;/.test(drag), true);
  check(
    "a mouse on a field is editing or selecting, never moving the panel",
    [/const EDITABLE = "input, textarea, select, \[contenteditable\]";/.test(drag), /going\.target\?\.closest\(EDITABLE\) != null/.test(drag)],
    [true, true],
  );
  // What a drag writes per move is the finger's own position; every movement it adds is CSS, which reduced motion zeroes.
  check(
    "reduced motion zeroes every settle and exit, inline ones included",
    /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{\s*animation-duration: 0\.01ms !important;[^}]*transition-duration: 0\.01ms !important;/.test(
      stripComments(srcFile("index.css")),
    ),
    true,
  );
  check(
    "and nothing here animates through a door that block cannot reach",
    [drag, ...bodies.map(([, body]) => body)].filter((body) => /\.animate\(/.test(body)).length,
    0,
  );
  // Reduced motion gives every property a 0.01ms transition whose first frame is the old value; `none` keeps it off the geometry.
  check(
    "no inline transition is ever cleared, only set to none or to a settle",
    [drag, ...bodies.map(([, body]) => body)].filter((body) => /style\.transition = ""/.test(body)).length,
    0,
  );
  check("the drawer leaves a vertical pan to its rows and a sideways one to itself", /\btouch-pan-y\b/.test(stripComments(srcFile("ui/MenuDrawer.tsx"))), true);

}

process.stdout.write("\nwhat a moving panel costs a frame\n");
{
  const drag = stripComments(srcFile("ui/sheetDrag.ts"));
  // Measured before (Q3.651): 55 main-thread paints of the whole viewport per 30 moves, and a bar whose edge pixels changed by 94 of 255.
  check(
    "the panel is its own layer for the gesture, and gives it back once still",
    [/node\.style\.transition = "none";\s+node\.style\.willChange = "transform";/.test(drag), /export function letGo\(node: HTMLElement\): void \{\s+node\.style\.transition = "none";\s+node\.style\.willChange = "";/.test(drag)],
    [true, true],
  );
  check(
    "and its offset is whole device pixels",
    [/export function snap\(css: number\): number \{\s+const ratio = window\.devicePixelRatio \|\| 1;\s+return Math\.round\(css \* ratio\) \/ ratio;/.test(drag), /const by = snap\(Math\.max\(0, at\)\);/.test(drag)],
    [true, true],
  );
  check(
    "moves are written once per frame, and the last one before a release",
    [/frame\.current \?\?= window\.requestAnimationFrame\(flush\);/.test(drag), /if \(!going\.engaged\) return;\s+flush\(\);/.test(drag)],
    [true, true],
  );
  check("and only there does a frame get asked for", (drag.match(/requestAnimationFrame\(/g) ?? []).length, 1);
  // Past open was a height per move: 25 layouts of New session per 30 moves upward.
  check("nothing a plain panel writes lays it out", /style\.(?:height|width|maxHeight|maxWidth)|style\[/.test(drag), false);
  check(
    "and the rubber band that did is retired, name and bound",
    /\bRUBBER_PX\b|\bresisted\(/.test(drag + stripComments(srcFile("ui/sheetMotion.ts")) + stripComments(srcFile("ui/AgentConfigBar.tsx"))),
    false,
  );
  check(
    "and a settle ends by handing the layer back",
    /state\.current\.timer = null;\s+letGo\(node\);/.test(drag),
    true,
  );
}

process.stdout.write("\nturning a machine's page\n");
{
  const { DISMISS_PX, FLING, pageOffset, pageTurn } = await import("../src/ui/sheetMotion.js");
  const { takeRows } = await import("../src/ui/groups.js");

  // Q3.655: the owner's words were "it slides where I want, then returns to the initial state and teleports to the new folder".
  check("the list follows the finger past the old 96px cap, up to a whole page", [pageOffset(-200, 412, true, true), pageOffset(-600, 412, true, true)], [-200, -412]);
  check(
    "and toward a side with no neighbour it does not move at all",
    [pageOffset(150, 412, false, true), pageOffset(-150, 412, true, false), pageOffset(-150, 412, false, false)],
    [0, 0, 0],
  );
  check("a slow drag past the sheets' distance turns the page it reveals", [pageTurn(-DISMISS_PX, 0, 412), pageTurn(DISMISS_PX, 0, 412)], [1, -1]);
  check("and one short of it gives the page back", pageTurn(-(DISMISS_PX - 1), 0, 412), 0);
  check("a flick turns it at any distance", [pageTurn(-30, -FLING, 412), pageTurn(30, FLING, 412)], [1, -1]);
  check("flung back the other way, no distance turns it", pageTurn(-300, FLING, 412), 0);
  check("and a drag that never left its page turns nothing", pageTurn(0, -3, 412), 0);

  const left = { rows: 5 };
  check(
    "the neighbour draws a screen's rows, a heading costing one, and nothing past them",
    [takeRows([1, 2, 3], left), takeRows([4, 5, 6], left, 1), takeRows([7], left), left.rows <= 0],
    [[1, 2, 3], [4], [], true],
  );
  check("and the list itself, with no budget, loses nothing", takeRows([1, 2, 3], { rows: Number.POSITIVE_INFINITY }), [1, 2, 3]);

  const swipe = stripComments(srcFile("ui/machineSwipe.ts"));
  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  check(
    "the release is the sheets' rule on its side, and a touchcancel gives the page back",
    /const turn = cancelled \? 0 : pageTurn\(going\.offset, releaseVelocity\(going\.samples, at\), going\.width\);/.test(swipe) && /finish\(going, event\.type === "touchcancel", event\.timeStamp\);/.test(swipe),
    true,
  );
  // Settling to 0 before the swap was the defect: the old list sprang back and the new one appeared where it had been.
  check(
    "a turn carries every page on from where the finger let go, and a give-back carries them home",
    [
      /now\.ref = target;\s+now\.offset = 0;\s+for \(const node of \[page\.current, \.\.\.panes\.current\.values\(\)\]\) if \(node !== null\) node\.style\.transition = settleTransition\(\["transform"\]\);\s+draw\(now\);/.test(swipe),
      /settle\(going\.at \+ turn, turn\);/.test(swipe),
    ],
    [true, true],
  );
  check(
    "every page moves once a frame, snapped, as one composited transform each",
    [
      /frame\.current \?\?= window\.requestAnimationFrame\(write\);/.test(swipe),
      /place\(page\.current, pageX\(now\.offset, now\.ref, committed\(\), now\.width\)\);\s+for \(const \[index, node\] of panes\.current\) place\(node, pageX\(now\.offset, now\.ref, index, now\.width\)\);/.test(swipe),
      /const by = snap\(x\);/.test(swipe),
      /node\.style\.willChange = "transform";/.test(swipe),
    ],
    [true, true, true, true],
  );
  check(
    "a neighbour not already there mounts once per direction, before the frame that first shows it",
    [
      /if \(side !== 0 && tabsNow\[going\.at \+ side\] !== undefined && going\.side !== side\) \{\s+going\.side = side;\s+ensure\(\[going\.at, going\.at \+ side\], going\.rows, true\);/.test(swipe),
      /if \(sync\) flushSync\(\(\) => mount\(next\)\);/.test(swipe),
    ],
    [true, true],
  );
  // As state in SessionBrowser it re-rendered the whole current list at engage: 28.8ms at 40 rows, 50.6ms at 300.
  check(
    "and it is a store the pane alone reads, so mounting it renders nothing beside it",
    [/useState/.test(swipe), /const besides = useSyncExternalStore\(swipe\.subscribe, swipe\.beside\);/.test(browser)],
    [false, true],
  );
  check(
    "it is cut to a screen's rows, measured once per gesture",
    [/going\.rows = away\.current\?\.rows \?\? Math\.ceil\(\(node\?\.clientHeight \?\? 0\) \/ ROW_FLOOR_PX\) \+ 1;/.test(swipe), /rows=\{beside\.rows\}/.test(browser), /rows = null,[\s\S]*drag=\{drag\} rows=\{rows\} \/>/.test(browser)],
    [true, true, true],
  );
  check(
    "and it is a picture: inert, unread, untouchable",
    /aria-hidden="true"\s+inert\s+className="pointer-events-none absolute inset-0 overflow-hidden"/.test(browser),
    true,
  );
  check(
    "the page that moves is the scroller, inside a window that clips it and hears the finger",
    [/<div ref=\{swipe\.windowRef\} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">/.test(browser), /wrapRef/.test(browser + swipe)],
    [true, false],
  );
  check(
    "the nudge's own numbers are retired",
    /\bconst (?:CAP|RUBBER|COMMIT|SETTLE_MS|SETTLE_CLEAR_MS)\b/.test(swipe),
    false,
  );
  check(
    "the strip's pill travels on the page's own progress and settle, toward All too, and hands over after the commit",
    [
      /const progress = legProgress\(at, trip\.from, trip\.to\);\s+pillNow\.current\.at\(progress\);/.test(swipe),
      /pillNow\.current\.settle\(1\);/.test(swipe),
      /mount\(NONE\);\s+\}\);\s+if \(page\.current !== null\) page\.current\.scrollTop = 0;\s+\} else \{\s+mount\(NONE\);\s+\}\s+pillNow\.current\.finish\(\);/.test(swipe),
      /ALL_MACHINES/.test(swipe),
    ],
    [true, true, true, false],
  );
  check(
    "under reduced motion nothing follows and nothing mounts, and the page still turns",
    [/if \(going\.still \|\| now === null\) return;\s+now\.offset = going\.offset;/.test(swipe), /if \(turn === 0 \|\| to === undefined\) return;\s+selectMachine\(to\.id\);/.test(swipe)],
    [true, true],
  );
}

process.stdout.write("\nthe pill that marks a machine, and how it travels\n");
{
  const { SHEET_EASE, clipSpan, easeAt, pillBetween, pillPieces, scrollToShow } = await import("../src/ui/sheetMotion.js");

  // Q3.656: "the element that marks the selected folder moves together with the page ... so the selection never teleports".
  const alpha = { x: 68, width: 60 };
  const beta = { x: 160, width: 52 };
  check("at no progress it is the tab it leaves, at the whole of it the tab it reaches", [pillBetween(alpha, beta, 0), pillBetween(alpha, beta, 1)], [alpha, beta]);
  check("halfway it is halfway, and as wide as halfway between the two", pillBetween(alpha, beta, 0.5), { x: 114, width: 56 });
  check("and a drag past either end holds it at that end", [pillBetween(alpha, beta, -0.4), pillBetween(alpha, beta, 1.7)], [alpha, beta]);
  check(
    "a tab half out of the strip shows half its pill, and one wholly out shows none",
    [clipSpan({ x: 230, width: 60 }, 60, 250), clipSpan({ x: 260, width: 60 }, 60, 250)],
    [{ x: 230, width: 20 }, { x: 260, width: 0 }],
  );
  const drawn = pillPieces({ x: 100, width: 80 }, 32, 64);
  check(
    "it is drawn from transforms alone: caps at either end that only move, and a middle that stretches between their centres",
    [drawn.left, drawn.right, drawn.middle, drawn.scale],
    [100, 148, 116, 0.75],
  );
  check("so a pill as narrow as its caps has no middle to stretch", pillPieces({ x: 0, width: 32 }, 32, 64).scale, 0);
  check(
    "the strip scrolls only as far as it must to show the tab whole",
    [scrollToShow(0, 200, 400, { x: 50, width: 80 }), scrollToShow(0, 200, 400, { x: 180, width: 80 }), scrollToShow(100, 200, 400, { x: 40, width: 80 }), scrollToShow(0, 200, 30, { x: 180, width: 80 })],
    [0, 60, 40, 30],
  );
  check("the scroll's curve is the sheets', from 0 to 1", [easeAt(0), easeAt(1), /cubic-bezier\(0\.32, 0\.72, 0, 1\)/.test(SHEET_EASE)], [0, 1, true]);
  const samples = Array.from({ length: 21 }, (_, at) => easeAt(at / 20));
  check("and it only moves forward, fast at first as the pages do", [samples.every((v, at) => at === 0 || v >= (samples[at - 1] ?? 0)), easeAt(0.25) > 0.5], [true, true]);

  const pill = stripComments(srcFile("ui/tabPill.ts"));
  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  const css = stripComments(srcFile("index.css"));
  check(
    "at rest the pill is the selected tab's own, so a scroll, a reorder, a resize or a first render moves it with the tab",
    [/className=\{`inline-flex h-8 items-center gap-1\.5 rounded-full px-3 \$\{tab\.selected \? "bg-raised" : ""\}`\}/.test(browser), /<TabLabel tab=\{all\} \/>/.test(browser), /<TabLabel tab=\{tab\} \/>/.test(browser)],
    [true, true, true],
  );
  check(
    "while one travels the tabs' own stand down, by a rule that beats the utility",
    [/\[data-pill-travel\] \[data-tab-pill\] \{\s*background-color: transparent;/.test(css), /box\.setAttribute\("data-pill-travel", ""\);/.test(pill), /strip\.current\?\.removeAttribute\("data-pill-travel"\);/.test(pill)],
    [true, true, true],
  );
  check(
    "the traveller is three pieces the tab's own height, under every label, and hidden until a trip",
    [
      /<span ref=\{pill\.travellerRef\} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 hidden">\s*<span className="absolute top-0 left-0 h-8 w-8 rounded-full bg-raised" \/>\s*<span className="absolute top-0 left-0 h-8 w-16 origin-left bg-raised" \/>\s*<span className="absolute top-0 left-0 h-8 w-8 rounded-full bg-raised" \/>/.test(browser),
      /const MIDDLE_PX = 64;/.test(pill),
      /className="relative flex shrink-0 items-center border-b border-edge px-1\.5"/.test(browser),
    ],
    [true, true, true],
  );
  check(
    "it moves by transforms only, snapped, promoted for the trip and let go after",
    [
      /style\.(?:width|left|height)\b/.test(pill),
      /translate3d\(\$\{String\(snap\(where\.middle\)\)\}px, 0, 0\) scaleX\(\$\{String\(where\.scale\)\}\)/.test(pill),
      /piece\.style\.willChange = "transform";/.test(pill),
      /piece\.style\.willChange = "";/.test(pill),
      /style\.transition = ""/.test(pill),
      /useState/.test(pill),
    ],
    [false, true, true, true, false, false],
  );
  check(
    "both tabs and the strip are read once, when a trip begins",
    [(pill.match(/getBoundingClientRect\(\)/g) ?? []).length, /const at = \(progress: number\): void => \{[^}]*getBoundingClientRect/.test(pill)],
    [8, false],
  );
  check(
    "it settles on the sheets' clock, and the strip's scroll follows on the same curve and lands before the hand-off",
    [
      /piece\.style\.transition = settleTransition\(\["transform"\]\)/.test(pill),
      /rail\.scrollLeft = from \+ \(target - from\) \* easeAt\(t\);/.test(pill),
      /const landing = trip\.current\?\.scrollTo \?\? null;\s+if \(landing !== null && scroller\.current !== null\) scroller\.current\.scrollLeft = landing;/.test(pill),
      /timer\.current = window\.setTimeout\(finish, SHEET_MS\);/.test(pill),
    ],
    [true, true, true, true],
  );
  check(
    "a tap travels too, before the new tab's own pill can paint, and not while a page turn already carries it",
    [
      /useLayoutEffect\(\(\) => \{\s+const previous = shown\.current;\s+shown\.current = current;\s+if \(previous === null \|\| current === null \|\| previous === current \|\| pill\.turning\(\)\) return;\s+pill\.moveTo\(previous, current\);/.test(browser),
      /if \(lone \|\| selected === null \|\| pill\.travelling\(\)\) return;/.test(browser),
    ],
    [true, true],
  );
  // A second tap mid-trip, or a swipe after a tap, used to finish the first trip at its end: a jump the length of what was left.
  check(
    "a trip that overtakes another starts where the pill is drawn, not where it was going",
    [
      /const overtaken = box === null \? null : drawnNow\(box\.getBoundingClientRect\(\)\);\s+finish\(\);/.test(pill),
      /const start = overtaken === null \? tabStart : \{ \.\.\.tabStart, span: overtaken, scrolls: false \};/.test(pill),
    ],
    [true, true],
  );
  check(
    "the strip heads for the whole tab it is going to, so the selection's own scroll finds nothing left to do",
    /const tab = last\.closest\("button"\)\?\.getBoundingClientRect\(\) \?\? null;/.test(pill),
    true,
  );
  check("under reduced motion a tap moves nothing and the tab's own pill simply changes", /if \(window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches\) return;\s+if \(!begin\(from, to, "tap"\)\) return;/.test(pill), true);
}

process.stdout.write("\nthe list's other two gestures: the drawer and the refresh\n");
{
  const { FLING, PULL_HOLD_PX, listGesture, pullOffset, pullRefreshes, sheetRelease } = await import("../src/ui/sheetMotion.js");
  const at = (over: Partial<{ cancelable: boolean; firstPage: boolean; atTop: boolean; refreshing: boolean; turning: boolean }> = {}) => ({
    cancelable: true,
    firstPage: false,
    atTop: true,
    refreshing: false,
    turning: false,
    ...over,
  });

  // Q3.657: "after a swipe on the first folder the side menu opens".
  check(
    "rightward on the first page pulls the drawer, and anywhere else it pages",
    [listGesture(40, 2, at({ firstPage: true })), listGesture(-40, 2, at({ firstPage: true })), listGesture(40, 2, at())],
    ["drawer", "page", "page"],
  );
  // Q3.658: a pull down from the top refreshes.
  check(
    "downward from the top pulls, and scrolled down it is the list's own scroll",
    [listGesture(2, 40, at()), listGesture(2, 40, at({ atTop: false })), listGesture(2, -40, at())],
    ["pull", "none", "none"],
  );
  check(
    "a diagonal is nobody's, an engine already panning is not argued with, and a gap already open takes no second pull",
    [listGesture(30, 30, at({ firstPage: true })), listGesture(40, 2, at({ cancelable: false, firstPage: true })), listGesture(2, 40, at({ refreshing: true }))],
    ["none", "none", "none"],
  );
  check("opening the drawer is the sheets' release, sideways: a flick or a distance", [sheetRelease(40, FLING, 350), sheetRelease(96, 0, 350), sheetRelease(95, 0, 350)], ["dismiss", "dismiss", "stay"]);

  check("a pull moves the list one for one at first", pullOffset(1) > 0.99, true);
  check("then less and less, never past twice the hold", [pullOffset(112), pullOffset(1e6) < PULL_HOLD_PX * 2, pullOffset(-5)], [PULL_HOLD_PX, true, 0]);
  check("let go at the hold it refreshes, and one short of it the gap closes", [pullRefreshes(PULL_HOLD_PX), pullRefreshes(PULL_HOLD_PX - 1)], [true, false]);

  const swipe = stripComments(srcFile("ui/machineSwipe.ts"));
  const pull = stripComments(srcFile("ui/drawerPull.ts"));
  const drawer = stripComments(srcFile("ui/MenuDrawer.tsx"));
  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  check(
    "the drawer is mounted for the gesture, closed, under the finger, and found by what it is",
    [
      /flushSync\(\(\) => announce\(true\)\);/.test(pull),
      /document\.querySelector<HTMLElement>\("\[data-drawer-panel\]"\)/.test(pull),
      /hold\(panel, "left"\);\s+slide\(panel, "left", width\);/.test(pull),
      /data-drawer-panel=""/.test(drawer),
      /data-drawer-scrim=""/.test(drawer),
    ],
    [true, true, true, true, true],
  );
  check(
    "it follows once a frame, the scrim darkening with it, and nothing else is written",
    [/slide\(now\.panel, "left", \(1 - p\) \* now\.width\);\s+fade\(now\.scrim, p\);/.test(pull), /if \(going\.mode === "drawer"\) \{\s+pullTo\(going\.offset \/ going\.width\);/.test(swipe)],
    [true, true],
  );
  check(
    "it opens only through the menu button's own path, so the layer, inert and Back are the button's",
    [/if \(opens\) open\(\);/.test(pull), /releasePull\(opens, actions\.current\.openMenu\);/.test(swipe), /openMenu: onMenu,/.test(browser)],
    [true, true, true],
  );
  check(
    "a second finger ends the gesture it lands on as a cancel before refusing, or a pull's gap never closes",
    [
      /const onStart = \(event: TouchEvent\): void => \{\s*const going = live\.current;\s*live\.current = null;\s*if \(going !== null\) finish\(going, true, event\.timeStamp\);\s*if \(event\.touches\.length !== 1/.test(swipe),
      /if \(going !== null\) finish\(going, event\.type === "touchcancel", event\.timeStamp\);/.test(swipe),
    ],
    [true, true],
  );
  check(
    "and it is decided by the sheets' release, from where the finger let go",
    /const opens = !cancelled && sheetRelease\(going\.offset, releaseVelocity\(going\.samples, at\), going\.width\) === "dismiss";/.test(swipe),
    true,
  );
  check("given back, it unmounts where it stands, closed", /flushSync\(\(\) => announce\(false\)\);\s*\}/.test(pull), true);
  check("the edge bands stay the platform's Back, where a drawer's pull would start", /finger\.clientX < EDGE_DEAD_ZONE \|\| window\.innerWidth - finger\.clientX < EDGE_DEAD_ZONE/.test(swipe), true);

  check(
    "a pull that refreshes holds the gap for exactly as long as the refresh, a machine that never answers included",
    [/void actions\.current\.refresh\(\)\.finally\(\(\) => \{\s+if \(mounted\.current\) closeGap\(\);/.test(swipe), /refresh: \(\) => store\.resume\("pull"\),/.test(browser)],
    [true, true],
  );
  check(
    "and the refresh is the app's own wake path, not a timer",
    /refresh: \(\) => store\.resume\(/.test(browser) && !/setTimeout\([^)]*refresh/.test(swipe),
    true,
  );
  check(
    "the gap is the hold's height, its mark is the app's own working mark, and it is drawn only while there is a gap",
    [
      /className="pointer-events-none absolute inset-x-0 top-0 hidden h-14 items-center justify-center text-muted"\s*>\s*<WorkingMark size=\{20\} \/>/.test(browser),
      PULL_HOLD_PX === 56,
    ],
    [true, true],
  );
  check(
    "the list moves by a transform, and the mark shows closed before the first write",
    [/node\.style\.transform = y <= 0 \? "" : `translate3d\(0, \$\{String\(snap\(y\)\)\}px, 0\)`;/.test(swipe), /drawn\.style\.opacity = "0";[\s\S]{0,120}drawn\.style\.display = "flex";/.test(swipe)],
    [true, true],
  );
  check("while the gap is open no page, drawer or second pull starts", /if \(gap\.current !== null\) return;/.test(swipe), true);
  check("under reduced motion the gap opens and closes with no transition at all", /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches \? "none" : settleTransition\(\["transform", "opacity"\]\)/.test(swipe), true);
  check("and neither gesture keeps React state of its own, so no move renders", [/useState/.test(swipe), /useState/.test(pull)], [false, false]);
}

process.stdout.write("\nthe scrim is a grip too\n");
{
  const drag = stripComments(srcFile("ui/sheetDrag.ts"));
  const pull = stripComments(srcFile("ui/drawerPull.ts"));
  const surfaces = ["ui/MenuDrawer.tsx", "ui/TaskPanel.tsx", "ui/AgentConfigBar.tsx", "ui/Sheet.tsx"].map((rel) => [rel, stripComments(srcFile(rel))] as const);
  const code = Object.fromEntries(surfaces);
  // The owner, from Android: a drag begun beside the open drawer did nothing, and the pickers closed on the press itself (Q3.660).
  check(
    "every panel with a scrim spreads the scrim half of the one hook on it",
    surfaces.filter(([, body]) => !/ref=\{drag\.scrim\.ref\}\n\s+\{\.\.\.drag\.scrim\.bind\}/.test(body)).map(([rel]) => rel),
    [],
  );
  check(
    "one gesture record serves both grips, so a second finger anywhere is a pinch",
    [/useTouchGesture<T>\(touchOps\(false\), held\)/.test(drag), /useTouchGesture<HTMLElement>\(touchOps\(true\), scrim\)/.test(drag), /bind: pointerBind<HTMLElement>\(true\)/.test(drag)],
    [true, true, true],
  );
  // The routed sheet's scrim is its panel's parent: without these, every drag on the panel was a second drag on the scrim.
  check(
    "a scrim begins only what lands on its bare surface, and answers only for that",
    [
      /if \(onScrim && event\.target !== event\.currentTarget\) return;/.test(drag),
      /if \(event\.button !== 0 \|\| \(onScrim && event\.target !== event\.currentTarget\)\) return;/.test(drag),
      (drag.match(/going\.scrim !== onScrim/g) ?? []).length,
    ],
    [true, true, 5],
  );
  check(
    "a tap on it still closes, since a tap is not a drag",
    [
      /onClick=\{leaving \? undefined : onClose\}/.test(code["ui/MenuDrawer.tsx"] ?? ""),
      /onClick=\{leaving \? undefined : onClose\}/.test(code["ui/TaskPanel.tsx"] ?? ""),
      /onClick=\{leaving \? undefined : dismiss\}/.test(code["ui/AgentConfigBar.tsx"] ?? ""),
      /if \(event\.target === event\.currentTarget\) close\(\);/.test(code["ui/Sheet.tsx"] ?? ""),
    ],
    [true, true, true, true],
  );
  check(
    "a scrim beside its panel fades with it through the one geometry, and the routed sheet's, its parent, does not",
    [
      /useSlideSheet\(panelRef, "left", onClose, \{ scrim: scrimRef, open \}\)/.test(code["ui/MenuDrawer.tsx"] ?? ""),
      /useSlideSheet\(panelRef, "down", onClose, \{ scrim: scrimRef, open \}\)/.test(code["ui/TaskPanel.tsx"] ?? ""),
      /useSlideSheet\(panelRef, "down", close\);/.test(code["ui/Sheet.tsx"] ?? ""),
    ],
    [true, true, true],
  );
  check(
    "it shows as much as the panel does, written with the panel's own move",
    [
      /const shown = \(at: number\): number => 1 - at \/ Math\.max\(1, state\.current\.extent\);/.test(drag),
      /if \(panel\.current !== null\) slide\(panel\.current, axis, at\);\s+const scrim = shade\(\);\s+if \(scrim !== null\) fade\(scrim, shown\(at\)\);/.test(drag),
      /fade\(scrimRef\.current, live\.current \/ restHeight\(\)\);/.test(code["ui/AgentConfigBar.tsx"] ?? ""),
      /holdFade\(scrim\);\s+fade\(scrim, 0\);/.test(pull),
    ],
    [true, true, true, true],
  );
  check(
    "settled back, it returns on the sheet clock and keeps nothing inline",
    [
      (drag + (code["ui/AgentConfigBar.tsx"] ?? "")).match(/scrim\.style\.transition = settleTransition\(\["opacity"\]\);\s+scrim\.style\.opacity = "";/g)?.length ?? 0,
      (drag + (code["ui/AgentConfigBar.tsx"] ?? "")).match(/if \(scrim !== null\) letGo\(scrim\);/g)?.length ?? 0,
    ],
    [2, 2],
  );
  check(
    "reopened mid-exit, the nodes a drag dismissed are put back rather than arriving to where it let go",
    [
      /state\.current\.left = node;/.test(drag),
      /if \(!open\) return;\s+const node = state\.current\.left;\s+state\.current\.left = null;\s+if \(node === null \|\| node !== panel\.current\) return;/.test(drag),
      /letGo\(scrimRef\.current\);\s+scrimRef\.current\.style\.opacity = "";/.test(code["ui/AgentConfigBar.tsx"] ?? ""),
    ],
    [true, true, true],
  );
  // Measured: a drag begun inside a pulled drawer's settle flashed it fully open for a frame when the pull's timer landed.
  check(
    "a drag begun while a pull still settles takes the drawer from where it is drawn, and the pull writes nothing after",
    [
      /begin: \(\) => \{\s+yieldPull\(\);\s+slid\.begin\(\);/.test(code["ui/MenuDrawer.tsx"] ?? ""),
      /export function yieldPull\(\): void \{\s+if \(timer === null\) return;\s+window\.clearTimeout\(timer\);\s+timer = null;\s+nodes = null;\s+announce\(false\);\s+\}/.test(pull),
    ],
    [true, true],
  );
  check(
    "a scrim beside its panel has nothing to pan or zoom, so the engine never takes the drag; the routed sheet's holds the panel",
    [
      ...["ui/MenuDrawer.tsx", "ui/TaskPanel.tsx", "ui/AgentConfigBar.tsx"].map((rel) => /fixed inset-0 (?:\$\{LAYER\.overlay\} )?touch-none bg-scrim/.test(code[rel] ?? "")),
      /data-sheet-scrim=""\s+className=\{`animate-scrim fixed inset-0 \$\{LAYER\.overlay\} flex touch-manipulation/.test(code["ui/Sheet.tsx"] ?? ""),
    ],
    [true, true, true, true],
  );
}

process.stdout.write("\na conversation dragged back to the list\n");
{
  const { BACK_UNDER_OPACITY, BACK_UNDER_SHIFT, DISMISS_PX, DOMINANCE, EDGE_DEAD_ZONE, backClaim, sheetRelease, underAt } = await import(
    "../src/ui/sheetMotion.js"
  );
  const open = { cancelable: true, scrollsBack: false };
  // The owner, from a phone: a swipe from a conversation goes back to the list, and smoothly rather than by teleport (Q3.663).
  check("a rightward move mostly across the screen goes back", backClaim(40, 5, open), true);
  check("and the axis is DOMINANCE's, at its own boundary", [backClaim(DOMINANCE * 10 + 0.1, 10, open), backClaim(DOMINANCE * 10, 10, open)], [true, false]);
  check("leftward, up or down it never does", [backClaim(-40, 5, open), backClaim(5, 40, open), backClaim(5, -40, open)], [false, false, false]);
  check("an engine already panning is not argued with", backClaim(40, 0, { cancelable: false, scrollsBack: false }), false);
  check("and a code block that can still scroll back keeps the drag", backClaim(40, 0, { cancelable: true, scrollsBack: true }), false);
  check(
    "it goes back on the sheets' release, sideways: a flick, or DISMISS_PX, never while flung back",
    [sheetRelease(60, 1, 412), sheetRelease(60, 0.1, 412), sheetRelease(DISMISS_PX, 0, 412), sheetRelease(300, -1, 412)],
    ["dismiss", "stay", "dismiss", "stay"],
  );
  check(
    "the list starts as far left and as faint as the chevron's own pop draws it, and arrives whole",
    [underAt(0, 400), underAt(400, 400), underAt(200, 400), underAt(-50, 400), underAt(900, 400)],
    [
      { shift: -BACK_UNDER_SHIFT * 400, opacity: BACK_UNDER_OPACITY },
      { shift: -0, opacity: 1 },
      { shift: -BACK_UNDER_SHIFT * 200, opacity: BACK_UNDER_OPACITY + (1 - BACK_UNDER_OPACITY) / 2 },
      { shift: -BACK_UNDER_SHIFT * 400, opacity: BACK_UNDER_OPACITY },
      { shift: -0, opacity: 1 },
    ],
  );
  const css = stripComments(srcFile("index.css"));
  check(
    "and those two numbers are nav-under's, read off the stylesheet",
    [/@keyframes nav-under \{\s*to \{\s*transform: translateX\(-(\d+)%\);/.exec(css)?.[1], /@keyframes nav-under \{[^}]*opacity: ([\d.]+);/.exec(css)?.[1]],
    [String(Math.round(BACK_UNDER_SHIFT * 100)), String(BACK_UNDER_OPACITY)],
  );

  const back = stripComments(srcFile("ui/backSwipe.ts"));
  const view = stripComments(srcFile("ui/SessionView.tsx"));
  const header = stripComments(srcFile("ui/Header.tsx"));
  const bits = stripComments(srcFile("ui/bits.tsx"));
  const app = stripComments(srcFile("App.tsx"));
  const shell = stripComments(srcFile("ui/AppShell.tsx"));
  const router = stripComments(srcFile("router.ts"));
  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  const swipe = stripComments(srcFile("ui/machineSwipe.ts"));
  check(
    "both edge bands are one number, the platform's Back, shared rather than re-typed",
    [EDGE_DEAD_ZONE, /const EDGE_DEAD_ZONE/.test(swipe + back), /EDGE_DEAD_ZONE,/.test(back), /EDGE_DEAD_ZONE,/.test(swipe), /finger\.clientX < EDGE_DEAD_ZONE \|\| window\.innerWidth - finger\.clientX < EDGE_DEAD_ZONE/.test(back)],
    [24, false, true, true, true],
  );
  check(
    "the conversation carries the gesture on both of its roots, opaque, with the press read before a menu can close",
    [
      (view.match(/ref=\{back\.ref\}/g) ?? []).length,
      (view.match(/onPointerDownCapture=\{back\.press\}/g) ?? []).length,
      (view.match(/backRef=\{back\.gate\}/g) ?? []).length,
      (view.match(/flex min-h-0 flex-1 flex-col bg-surface/g) ?? []).length,
    ],
    [2, 2, 2, 2],
  );
  check(
    "it runs only while the back chevron is laid out, so the breakpoint stays in CSS",
    [/ref=\{backRef\}\s+icon=\{ChevronLeft\}/.test(header), /<button\s+ref=\{ref\}/.test(bits), /gate\.current === null \|\| gate\.current\.offsetParent === null/.test(back), /matchMedia\("\(min-width|innerWidth >/.test(back)],
    [true, true, true, false],
  );
  check(
    "a field, a selection, a long press, an open menu or sheet, and the press that closes one: none of them goes back",
    [
      /const EDITABLE = "input, textarea, select, \[contenteditable\]";/.test(back),
      /target\?\.closest\(EDITABLE\) != null \|\| window\.getSelection\(\)\?\.isCollapsed === false/.test(back),
      /if \(event\.timeStamp - going\.t > PRESS_MS\) \{/.test(back),
      /return currentLayers\(\)\.some\(\(layer\) => layer\.kind !== "ask"\);/.test(back),
      /if \(pressedCovered\.current \|\| covered\(\)\) return;/.test(back),
      /pressedCovered\.current = covered\(\);/.test(back),
    ],
    [true, true, true, true, true, true],
  );
  check(
    "a horizontal scroller keeps the drag while it can still scroll back, found by what it is",
    [
      /node\.scrollLeft <= 0\) continue;\s+const overflow = getComputedStyle\(node\)\.overflowX;\s+if \(\(overflow === "auto" \|\| overflow === "scroll"\) && node\.scrollWidth > node\.clientWidth\) return true;/.test(back),
      /backClaim\(dx, dy, \{ cancelable: free, scrollsBack: scrollsBack\(going\.target, node\) \}\)/.test(back),
    ],
    [true, true],
  );
  check(
    "the list under it is the list's own element on both routes, so landing remounts nothing",
    [
      /<PhoneList key="list" state=\{state\} onMenu=\{onMenu\} beneath \/>\s*<SessionView key="session"/.test(app),
      /<PhoneList key="list" state=\{state\} onMenu=\{onMenu\} beneath=\{false\} \/>/.test(app),
      /if \(beneath && rows === null\) return null;/.test(app),
      /data-back-under=\{beneath \? "" : undefined\}/.test(app),
      /inert=\{beneath\}/.test(app),
      /\$\{beneath \? "pointer-events-none absolute inset-0" : "h-full"\} bg-ink lg:hidden/.test(app),
    ],
    [true, true, true, true, true, true],
  );
  check(
    "drawn for the gesture, cut to one screen of rows, and whole again when it lands",
    [
      /flushSync\(\(\) => announce\(Math\.ceil\(node\.offsetHeight \/ ROW_FLOOR_PX\)\)\);/.test(back),
      /rows=\{beneath \? rows : null\}/.test(app),
      /flushSync\(\(\) => \{\s+navigateDrawn\("\/"\);\s+announce\(null\);\s+\}\);\s+if \(beneath !== null\) restore\(beneath\);/.test(back),
    ],
    [true, true, true],
  );
  check(
    "it lands through the chevron's own entry, with no view transition to play the move a second time",
    [
      /export function navigateDrawn\(path: string\): void \{\s+go\(path, false, undefined, true\);/.test(router),
      /export function navigate\(path: string, replace = false, alongside\?: \(\) => void\): void \{\s+go\(path, replace, alongside, false\);/.test(router),
      /if \(\s*drawn \|\|\s+move === null \|\|/.test(router),
      /onClick=\{\(\) => navigate\("\/"\)\}/.test(header),
    ],
    [true, true, true, true],
  );
  // Measured: the conversation translated past main's edge grew its scroll width, and main, the document and the transcript repainted every frame.
  check("main is clipped while the list is drawn under it", /overflow-y-auto bg-surface has-\[>\[data-back-under\]\]:overflow-hidden/.test(shell), true);
  check(
    "a move is one transform on each, once a frame, promoted only for the gesture",
    [
      /node\.style\.transform = `translate3d\(\$\{String\(snap\(offset\)\)\}px, 0, 0\)`;/.test(back),
      /beneath\.style\.transform = `translate3d\(\$\{String\(snap\(shift\)\)\}px, 0, 0\)`;\s+beneath\.style\.opacity = String\(opacity\);/.test(back),
      /frame\.current \?\?= window\.requestAnimationFrame\(flush\);/.test(back),
      /node\.style\.willChange = "transform";\s+beneath\.style\.willChange = "transform, opacity";/.test(back),
      /useState/.test(back),
    ],
    [true, true, true, true, false],
  );
  check(
    "it settles on the sheet clock, and one begun inside another route's arrival gives back rather than leaving it",
    [
      /settling\.current = \{ timer: window\.setTimeout\(done, SHEET_MS\), done, home \};/.test(back),
      /if \(home && window\.location\.pathname === going\.path\) arrive\(\);\s+else giveBack\(\);/.test(back),
    ],
    [true, true],
  );
  check(
    "under reduced motion nothing follows, and a release that goes back goes by the chevron's path at once",
    [/if \(going\.still\) return;\s+pending\.current/.test(back), /if \(going\.still\) \{[\s\S]{0,160}if \(home\) navigate\("\/"\);/.test(back)],
    [true, true],
  );
  check(
    "left by another door, it takes its styles off the list that route draws",
    /if \(list\.current !== null\) restore\(list\.current\);\s+list\.current = null;\s+announce\(null\);/.test(back),
    true,
  );
  check("and the list takes the cut rows through its own prop, not a second copy", /rows\?: number \| null;/.test(browser), true);
}

process.stdout.write("\na flick that follows a flick\n");
{
  const { FLING, legProgress, listGesture, nextPage, offsetFrom, pageOffset, pageTurn, pageX, pagesFor, stripAt } = await import(
    "../src/ui/sheetMotion.js"
  );
  const W = 412;
  // The owner, from a phone: flicking through the folders quickly stalled, because a folder needed time to settle (Q3.667).
  check(
    "the pages are one strip: each is a page-width from the next, wherever the strip is measured from",
    [pageX(0, 2, 2, W), pageX(0, 2, 0, W), pageX(-100, 1, 2, W), offsetFrom(pageX(37, 2, 0, W), 0, 2, W)],
    [0, -2 * W, W - 100, 37],
  );
  check("where it is, in pages", [stripAt(0, 2, W), stripAt(-W / 2, 2, W), stripAt(W / 4, 1, W)], [2, 2.5, 0.75]);
  // The model of two quick flicks from All, measured in Chromium: caught at -330px, 140px in 72ms, then released.
  const first = pageTurn(-140, -1.9, W);
  const caught = offsetFrom(-330, 0, 0 + first, W);
  const second = pageOffset(caught - 140, W, true, true);
  const landed = 1 + pageTurn(second, -1.9, W);
  check(
    "two quick flicks from All: the second catches the first where it is drawn and carries the strip on to the second page",
    [first, caught, second, landed, pageX(0, landed, 0, W)],
    [1, 82, -58, 2, -2 * W],
  );
  check(
    "and the same second touch let go without a flick carries the first turn on to where it was going",
    1 + pageTurn(pageOffset(caught - 20, W, true, true), 0, W),
    1,
  );
  check("a flick caught at the last page goes no further", pageOffset(offsetFrom(-2400, 0, 6, W) - 200, W, true, false), 0);
  check(
    "a caught turn is the pager's sideways, and nothing else starts from it: no drawer on the first page, no pull at the top",
    [
      listGesture(40, 4, { cancelable: true, firstPage: true, atTop: true, refreshing: false, turning: true }),
      listGesture(4, 40, { cancelable: true, firstPage: false, atTop: true, refreshing: false, turning: true }),
      listGesture(40, 4, { cancelable: false, firstPage: false, atTop: true, refreshing: false, turning: true }),
    ],
    ["page", "none", "none"],
  );
  check(
    "while a turn settles its page and both neighbours are there, so the page beyond is ready for the flick that follows",
    [pagesFor(1, 1, 0, 7), pagesFor(2, 1, 0, 7), pagesFor(2, -1, 3, 7), pagesFor(6, 1, 5, 7), pagesFor(4, 0, 4, 7)],
    [[1, 2], [1, 2, 3], [1, 2], [6], []],
  );
  check(
    "the pill heads for the next page the way the strip is travelling, and stops at the ends",
    [nextPage(0.3, 0, 7), nextPage(1, 0.8, 7), nextPage(1.7, 2, 7), nextPage(1, 1.2, 7), nextPage(6.2, 5.9, 7), nextPage(0, 0.1, 7)],
    [1, 2, 1, 0, 6, 0],
  );
  check(
    "and its progress along a leg is the strip's, either way, held at both ends",
    [legProgress(1.5, 1, 2), legProgress(1.25, 1.5, 1), legProgress(3, 1, 2), legProgress(0.2, 1, 2), legProgress(2, 2, 2)],
    [0.5, 0.5, 1, 0, 1],
  );
  check("a caught flick is judged by the sheets' own rule, from the page it is heading for", [pageTurn(-40, -FLING, W), pageTurn(-40, -FLING + 0.01, W)], [1, 0]);

  const swipe = stripComments(srcFile("ui/machineSwipe.ts"));
  const pill = stripComments(srcFile("ui/tabPill.ts"));
  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  // Measured before: a touch mid-turn hit a neighbour that takes none, or landed the turn and lost the rest of itself.
  check(
    "the finger is heard on the window, which never moves, and the page is only drawn",
    [
      /const windowRef = useTouchGesture<HTMLElement>\(\{ start: onStart, move: onMove, stop: onEnd \}\);/.test(swipe),
      /const scrollerRef = useCallback\(\(node: HTMLElement \| null\): void => \{\s+page\.current = node;\s+\}, \[\]\);/.test(swipe),
      /ref=\{swipe\.windowRef\}/.test(browser),
    ],
    [true, true, true],
  );
  check(
    "a touch catches a turn still settling where it is drawn: no commit, no jump, and the pill stopped where it is",
    [
      /const caught = hold\(\);/.test(swipe),
      /const drawn = node === null \? 0 : new DOMMatrixReadOnly\(getComputedStyle\(node\)\.transform\)\.m41;\s+now\.offset = offsetFrom\(drawn, committed\(\), now\.ref, now\.width\);/.test(swipe),
      /draw\(now\);\s+pillNow\.current\.hold\(\);/.test(swipe),
      /\bland\(|pending\.done\(\)/.test(swipe),
    ],
    [true, true, true, false],
  );
  check(
    "the machine is selected only when the strip rests, on the page it rests on, and not at all where it came back",
    [
      (swipe.match(/selectMachine\(/g) ?? []).length,
      /const rest = \(\): void => \{[\s\S]{0,600}?if \(now !== null && now\.ref !== base && target !== undefined\) \{\s+flushSync\(\(\) => \{\s+selectMachine\(target\.id\);/.test(swipe),
      /settling\.current = \{ timer: window\.setTimeout\(rest, SHEET_MS\), from, pillFrom \};/.test(swipe),
    ],
    [2, true, true],
  );
  check(
    "the page beyond mounts after the frame that starts a settle, so it never holds the settle back",
    [
      /const beyond = pagesFor\(target, turn, committed\(\), tabsNow\.length\);\s+if \(beyond\.length > 0\) afterFrame\(\(\) => ensure\(beyond, now\.rows, false, true\)\);/.test(swipe),
      /later\.current\.frame = window\.requestAnimationFrame\(\(\) => \{\s+later\.current\.frame = null;\s+later\.current\.timer = window\.setTimeout\(/.test(swipe),
    ],
    [true, true],
  );
  check(
    "a tap or a vertical move that caught a turn lets it carry on to where it was going",
    [
      /const resume = \(going: Going\): void => \{\s+if \(going\.caught && away\.current !== null\) settle\(away\.current\.ref, 0\);/.test(swipe),
      /if \(going\.mode === null \|\| going\.mode === "none"\) \{\s+resume\(going\);\s+return;\s+\}/.test(swipe),
      /if \(going\.mode === "none"\) \{\s+live\.current = null;\s+resume\(going\);/.test(swipe),
    ],
    [true, true, true],
  );
  check(
    "the pill's legs follow the strip, each measured before the pages move in its frame",
    [/steer\(at\);\s+draw\(now\);/.test(swipe), /const to = nextPage\(at, from, tabsNow\.length\);/.test(swipe)],
    [true, true],
  );
  check(
    "a held trip keeps the strip's scroll where it is, and stops each piece where it is drawn",
    [/stop\(\);\s+now\.scrollTo = null;/.test(pill), /piece\.style\.transform = getComputedStyle\(piece\)\.transform;\s+piece\.style\.transition = "none";/.test(pill)],
    [true, true],
  );
  check(
    "every neighbour carries its place, is placed as it mounts, and lets go of its place when it unmounts",
    [/data-beside=\{beside\.index\}/.test(browser), /const index = Number\(node\.dataset\["beside"\]\);/.test(swipe), /return \(\) => \{\s+if \(panes\.current\.get\(index\) === node\) panes\.current\.delete\(index\);/.test(swipe)],
    [true, true, true],
  );
}
