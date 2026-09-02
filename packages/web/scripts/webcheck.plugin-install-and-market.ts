import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nwhere a failed install or removal is said, and how much of it survives\n");
{
  /*
   * ⚠ **`MachineInstalls.tsx` was read by no driver at all**, which is how the
   * whole of a failed fan-out came to be reported inside a panel that is collapsed
   * and `inert` — with "All machines" sitting *above* the disclosure, so the one
   * gesture that reaches the fleet is the one that never opens it. Nothing typed
   * can hold a placement, so it is read off the file, the posture `InstalledList`
   * and `PluginsPanel` are already held to a few lines up.
   */
  const installsSrc = readFileSync(new URL("../src/ui/plugins/MachineInstalls.tsx", import.meta.url), "utf8");
  /*
   * Comments stripped, because this file now argues at length about the controls it
   * must not draw — a lock its own docblock satisfies would pass over the code it
   * was written to protect. `PluginView`'s `<select>` assertion records the same
   * reasoning.
   */
  const installsBody = stripComments(installsSrc);

  /*
   * ⚠ **The fold is gone, and with it the two rules that guarded it** — a failure
   * opening the panel it was written into, and nothing else moving that panel under
   * a thumb. The rows are a scroller now, so the first risk cannot exist; the
   * second becomes a scroll call, and there must be none.
   */
  report(
    "nothing moves the list under a thumb",
    !/scrollIntoView|scrollTop\s*=/.test(installsBody),
    "no scroll is driven from this component; the person's position is theirs",
  );
  /*
   * ⚠ **The bulk bar is outside the scroller, asserted by index ordering against
   * anchors that cannot move independently.** The pair is what makes it hard to
   * fool: the first says every bulk word comes after the scrolling box has closed,
   * the second says there is only one scroller to be after and that the list is
   * inside it — so a second `overflow-y-auto`, the obvious way to re-nest the bar
   * by accident, fails before the first can be gamed.
   */
  {
    const scrollerOpen = installsBody.indexOf("overflow-y-auto");
    const listEnd = installsBody.lastIndexOf("</ul>");
    const scrollerClose = installsBody.indexOf("</div>", listEnd);
    /* Anchored on each control's own enablement, which is unique to the bar — the
       words themselves wrap across lines in the JSX and `Remove` also appears on a
       row. */
    const bulk = ["!can.install", "!can.update", "!can.remove", "!can.settings"].map((word) => installsBody.indexOf(word));
    report(
      "the bulk bar is drawn outside the scroller",
      scrollerOpen > 0 && scrollerOpen < listEnd && bulk.every((at) => at > scrollerClose && at > 0),
      "every bulk control appears after the scrolling box has closed",
    );
    report(
      "and there is exactly one scrolling box, holding only the rows",
      (installsBody.match(/overflow-y-auto/g) ?? []).length === 1 && installsBody.indexOf("<ul") > scrollerOpen,
      "one scroller in the file, and the list is inside it",
    );
  }
  /*
   * ⚠ **And it does not end the scroll chain when it has nothing to scroll.**
   * `SHEET_BODY` records the measurement and `Settings.tsx` restates it: Chrome ends
   * the chain at a box carrying `overscroll-behavior: contain` even when it cannot
   * move — 400px of wheel travel against 0px on the same gesture. A fleet of one
   * puts one row in here, and with containment it would swallow every gesture aimed
   * at the page it sits in the middle of.
   */
  report(
    "the machine list does not end the scroll chain",
    !/overscroll-contain/.test(installsBody),
    "no overscroll-behavior: contain on a box that may have nothing to scroll",
  );
  /*
   * ⚠ **A row's controls are not inside its label.** The draft's row *was* a
   * `<label>` so the whole strip toggled its box — and a `<label>` may hold no
   * `<button>`. Left as one, a tap on this row's Remove icon would toggle the
   * checkbox as well.
   */
  report(
    "a row's controls are not inside its label",
    !/<label(?![^>]*htmlFor)[\s\S]{0,900}?<(IconButton|Button)\b/.test(installsBody) && /htmlFor=/.test(installsBody),
    "the checkbox is reached by htmlFor, so a tap on Remove does not also select the row",
  );
  /*
   * ⚠ **Row acts are 44px boxes rather than 24px ones with overlapping targets.**
   * An `sm` icon is 24px of ink reaching 44 through `after:-inset-2.5`, so two
   * adjacent ones overlap by 18px whatever the gap — and the later element in the
   * DOM wins the hit test, which on this row is the destructive one. A tap on the
   * right of Update's ink would remove a plugin and its `plugin_data`. This is the
   * assertion the global 44px sweep cannot make: that one only asks whether a size
   * was named at all.
   */
  {
    const icons = installsBody.match(/<IconButton[\s\S]*?\/>/g) ?? [];
    report(
      "a row's acts do not overlap each other's targets",
      icons.filter((call) => /size="lg"/.test(call)).length >= 2 && icons.every((call) => !/size="sm"/.test(call)),
      "44px boxes on the row; 24 + 20 = 44, so two `sm` targets overlap by 18px",
    );
  }
  /*
   * ⚠ **Every question on this screen is the bar's, and the row asks none.** A bin
   * on the row put an unrecoverable act 44px from a checkbox on the busiest strip
   * here, and the question that guarded it had to *replace the row* to fit — a
   * control answering for itself in the space it occupies, moving every row under
   * it. Off the row, a removal always goes through a selection: two deliberate
   * acts, one place to confirm, and a sentence that names every machine it reaches
   * rather than a truncated one naming the row it happened to sit on.
   *
   * ⚠ **There are two askers now, and this used to assert there was one — which
   * would have refused the fix rather than the defect.** The old rule weighed
   * reversibility alone, so a removal was confirmed and an install was not, and
   * that left the act which hands somebody else's code this uid, this `HOME` and
   * these repositories as the only unguarded tap here. What was measured is
   * untouched, because a second asker is not a second *place* to ask: both replace
   * the strip in place, and `Confirming` is one union rather than two booleans, so
   * the question, the verb and what it acts on cannot disagree.
   *
   * ⚠ **A fan-out asks and a single machine does not**, which is the half a bare
   * "install is confirmed" would lose: one machine is the same reach as the row's
   * own icon two inches up, and a question there would put one on the commonest
   * act in the app. `installTargets` on both sides of the ternary, so the count in
   * the question and the list the answer acts on are one walk.
   *
   * Update is still nobody's question — it replaces code somebody already
   * consented to on machines that already run it — and that is asserted as the
   * absence it is, since a control *not* asking is not a value anything holds.
   */
  {
    const rowIcons = installsBody.slice(installsBody.indexOf("function MachineRow"));
    report(
      "a row draws no removal",
      /drawnActs\(one\.acts\)/.test(rowIcons) && !/Trash2/.test(rowIcons),
      "the row's icons come from drawnActs, and no bin is drawn there",
    );
    report(
      "and every question is the bar's, asked by exactly the two acts that earn one",
      (installsBody.match(/setConfirming\("/g) ?? []).length === 2 &&
        (installsBody.match(/setConfirming\("remove"\)/g) ?? []).length === 1 &&
        (installsBody.match(/setConfirming\("install"\)/g) ?? []).length === 1 &&
        !/setConfirming/.test(rowIcons) &&
        /disabled=\{!can\.install\}[\s\S]{0,120}?installTargets\.length > 1 \? setConfirming\("install"\) : act\(installTargets, \[\]\)/.test(
          installsBody,
        ) &&
        /disabled=\{!can\.update\}[\s\S]{0,80}?act\(idsWith\("update"\), \[\]\)/.test(installsBody),
      "two askers, both in the bar; a lone install acts, and update never asks",
    );
  }
  /*
   * ⚠ **The one line that changes is *inside* the fixed-height box, and reserving
   * space for it below was not enough.** Two conditionally mounted lines — the
   * selection count and the reason Settings will not move — were two ways to push
   * the button strip under a thumb already aimed at it. Merging them into one
   * always-mounted line at `min-h-4` still stepped the bar 2px on every tick,
   * because `text-2xs` has an 18px line box and the reserve was 16: reserving the
   * *right* number fixes one instance and leaves the next caller to rediscover it.
   *
   * Bounded by a container with a **definite** height, no string it can ever hold
   * moves anything below the table. Asserted as a position rather than as a class,
   * because "inside the box" is the property and a height is only how it is kept.
   */
  {
    const box = /flex h-\[[\d.]+rem\] flex-col overflow-hidden rounded-md border/.test(installsBody);
    const line = installsBody.indexOf("id={noticeId}");
    const closes = installsBody.indexOf("</div>", line);
    const bar = Math.min(...["!can.install", "!can.update", "!can.remove", "!can.settings"].map((one) => installsBody.indexOf(one)));
    report(
      "the line that appears is inside the table, which has a definite height",
      box && line > 0 && closes > line && closes < bar,
      "it is closed inside the fixed box, so nothing it holds can move the bar",
    );
    report(
      "and nothing above the bar is mounted conditionally",
      !/\{notice\.length > 0 && \(/.test(installsBody) && !/\{chosenRows\.length > 0 && \(/.test(installsBody),
      "always mounted, only the text swaps",
    );
  }
  /*
   * ⚠ **Epochs are per machine, and act-wide was a real defect the moment rows could
   * act alone.** Row A's Install and row B's Remove a second apart are two acts; a
   * single counter would make the second discard the first's answer for a machine it
   * never touched, leaving row A on "installing" for ever.
   */
  report(
    "a slow answer is dropped per machine rather than per act",
    /epochs\.current\.get\(id\) !== epoch/.test(installsBody) && !/generation\.current !== epoch/.test(installsBody),
    "two rows acting at once must not discard each other's answers",
  );
  /*
   * The store is refreshed in that machine's own `finally` — a fleet where four
   * hosts are done and one is slow should show four hosts' worth.
   */
  report(
    "the store is refreshed per machine, in that machine's finally",
    /inFlight\.current\.delete\(id\);\s*\n\s*store\.refreshPlugins\(id\);/.test(installsBody) &&
      (installsBody.match(/refreshPlugins/g) ?? []).length === 1,
    "one call, and it is inside the per-job finally",
  );
  /*
   * ⚠ **`plugin_busy` is retried once and nothing else is.** A busy machine is a
   * queue collision and asking again a second later is right; everything else is not
   * retried because a `POST` is not replayable — a transport failure says nothing
   * about whether the daemon acted, and it may be halfway through unpacking.
   */
  report(
    "one retry, for one code, and nothing else",
    /error\.code === "plugin_busy"/.test(installsBody) &&
      /BUSY_RETRY_MS/.test(installsBody) &&
      (installsBody.match(/setTimeout/g) ?? []).length === 1 &&
      (installsBody.match(/await once\(\)/g) ?? []).length === 2,
    "a DELETE inherits its own retry from machine.ts one layer down",
  );
  /*
   * ⚠ **Every enablement is decided outside this file.** `rowActs` and `bulkEnabled`
   * are pure and swept, which is what `draftAct` was extracted for — and the bar's
   * counts come from `rowActs`, so **the bar cannot offer an act the rows do not**.
   * A bar computing its own predicates is how "Remove is live but every row's Remove
   * is grey" happens.
   */
  report(
    "the four bulk controls are decided outside this file",
    /const can = bulkEnabled\(/.test(installsBody) &&
      /rowActs\(/.test(installsBody) &&
      ["install", "update", "remove", "settings"].every((act) => installsBody.includes(`disabled={!can.${act}}`)),
    "every bulk control reads the pure answer; none is re-derived in JSX",
  );
  /*
   * ⚠ **The Cancel on a row is drawn from the controller that job actually holds**,
   * not from a fact about the screen. The old flag was set from `adding.length > 0`
   * — the jobs this screen *drafted* — so a removal-only act drew a live Cancel over
   * an act holding no controller at all.
   */
  report(
    "a row's Cancel is derived from the controller its job holds",
    /cancellable: controller !== null/.test(installsBody) && !/setCancellable/.test(installsBody),
    "the flag is the controller, so it cannot disagree with one",
  );
  /*
   * ⚠ **And the caller beside this one is told from the rows rather than around an
   * act**, which had to change once acts overlap: the old shape lowered the flag in
   * the first act's `finally`, so `ImportPlugin` would offer "Done" — the control
   * that unmounts a running fan-out — while a second act was still uploading.
   */
  report(
    "a caller beside it is told for exactly as long as anything is running",
    /const busy = \[\.\.\.local\.values\(\)\]\.some/.test(installsBody) &&
      /onBusyChange\?\.\(busy\);/.test(installsBody) &&
      !/onBusyChange\?\.\(true\)/.test(installsBody),
    "derived from the rows, not raised and lowered around one act",
  );
  report(
    "and it can be called off while it runs",
    /const controller = what === "install" && install !== null \? new AbortController\(\) : null;/.test(installsBody) &&
      /if \(controller !== null\) inFlight\.current\.set\(id, controller\);/.test(installsBody) &&
      /controller\.signal,/.test(installsBody) &&
      /onClick=\{cancelAll\}/.test(installsBody),
    "one controller per install job, registered, and its signal is what the act uses",
  );
  /*
   * ⚠ **Cancel is drawn from the act, never from the screen's capability.** It was
   * gated on `install !== null` — a fact about which screen this is — so a
   * removal-only act, which holds no controller at all, drew a live Cancel that
   * did nothing. `cancellable` is set from the drafted jobs.
   */
  report(
    "and calling it off is not drawn as a failure",
    /const calledOff = \(\): boolean => controller\?\.signal\.aborted === true;/.test(installsBody) &&
      (installsBody.match(/if \(calledOff\(\)\)/g) ?? []).length === 3 &&
      !/cancelled\.current/.test(installsBody),
    "every arm that could write a failed row asks this request's own signal",
  );
  /*
   * ⚠ **What the act did, said outside the scroller, in a region that was mounted
   * before there was anything to say.** The rows scroll, so a failure on row nine
   * of a six-row viewport is off screen and this line is the only thing that
   * speaks it — and `EventList` and `Toast` both record that a `role="status"`
   * inserted in the same paint as its content is commonly not spoken at all,
   * VoiceOver on iOS included. So the ternary has to sit on the `className` and
   * never on the mount.
   *
   * ⚠ **The string is `said` rather than `failure`, and that is a widening rather
   * than a rename.** The region carried failures only, which made the commonest
   * fan-out — one that worked — the quieter of the two: it cleared its rows and
   * said nothing anywhere, while `PluginsPanel` toasts "Installed Clock 1.0.0" for
   * a single machine. `doneSummary` and `failureDetail` share this one node
   * because two live regions beside each other interleave, so the negative below
   * has to name the joined string: pinning `failure` would have passed while the
   * node it guards was gone.
   *
   * Read off the stripped body for the reason `installsBody` states — this file
   * argues at length about the region in the comment directly above it, and the
   * unstripped source lets that argument satisfy its own lock.
   */
  report(
    "and it is a live region that is always mounted",
    /role="status" aria-live="polite"/.test(installsBody) &&
      /className=\{said\.length === 0 \? ""/.test(installsBody) &&
      !/\{said\.length > 0 &&/.test(installsBody),
    "the ternary is on the className, not on the mount",
  );
  /*
   * ⚠ **A failure is not clipped.** `pluginFailure` carries a daemon's own sentence
   * through verbatim for four codes, and `plugin_consent_broken` names every scope
   * the plugin gained — a paragraph, cut at one line, on a row with nothing to open
   * to. `PluginView` argues the same thing one file over.
   */
  report(
    "a failure keeps every character of itself",
    /row\.kind === "failed" \? "wrap-anywhere text-fg" : "truncate text-muted"/.test(installsSrc) &&
      !/block truncate text-2xs text-muted/.test(installsSrc),
    "the failed arm wraps and takes full ink; the rest still truncate",
  );
  /*
   * ⚠ **A machine nobody has asked yet is drawn as a wait, and this row drew it as
   * an outage** — `skipReasonFor` folded `reach: "unknown"` into `unreachable`, so
   * for the seconds between `bootstrap` promoting to `phase: "ready"` and the first
   * probe landing, every row here was dimmed with its box `disabled`: a whole fleet
   * drawn as switched off on every cold load. The predicate is fixed one file over
   * and asserted by call; what only a source read can hold is that this row splits
   * the two halves the *right* way. The **acts** stay away, because what is
   * installed there is genuinely not known and every icon would be drawn from a
   * guess; the **box** comes back, because ticking a row chooses a machine rather
   * than claiming anything about it. And the dimming goes with the box, since
   * `opacity-60` is what this list says about a machine that is out and this one is
   * merely late.
   */
  report(
    "a machine still being asked is drawn as late rather than as out",
    /const waiting = row\.kind === "blocked" && row\.reason === "asking";/.test(installsBody) &&
      /const out = row\.kind === "blocked" && !waiting;/.test(installsBody) &&
      /\$\{out \? "opacity-60" : ""\}/.test(installsBody) &&
      /disabled=\{out\}/.test(installsBody) &&
      !/disabled=\{row\.kind === "blocked"\}/.test(installsBody),
    "the dimming and the box both key on `out`, which excludes the wait",
  );
  /*
   * ⚠ **And the latch that decides the commonest fleet there is.** `seeded` is
   * raised as soon as the fleet is *known*, so a fleet that later becomes one
   * machine does not silently tick the survivor — but "known" is not "answered",
   * and on a cold load a one-machine fleet is `reach: "unknown"`. Raised before the
   * reason was consulted, the single machine was read as an outage, the effect
   * returned without ticking, and the latch it had already raised meant it never
   * ticked again: four dead buttons, permanently, on a fleet of one. The early
   * return has to sit **above** the latch, which is the whole of the fix and is one
   * line's ordering.
   */
  {
    const seedAt = installsBody.indexOf("if (seeded.current || state.machines.length === 0) return;");
    const seed = seedAt < 0 ? "" : installsBody.slice(seedAt, installsBody.indexOf("}, [state.machines]);", seedAt));
    report(
      "and a fleet of one that has not answered yet latches nothing",
      seedAt >= 0 &&
        /if \(reason === "asking"\) return;\s*seeded\.current = true;/.test(seed) &&
        seed.indexOf('if (reason === "asking") return;') < seed.indexOf("seeded.current = true;"),
      "the wait returns above the latch, so a later publish still decides",
    );
  }
}

process.stdout.write("\nwhich plugins screen a URL names\n");
{
  const {
    MARKET_TABS,
    marketEntryPath,
    marketPaneTitle,
    marketPath,
    marketSettingsPath,
    marketUp,
    marketUpFrom,
    marketUpLabel,
    marketUpWithinNav,
    parseMarketRoute,
  } = await import("../src/market.js");
  const { depthOf, navMove } = await import("../src/nav.js");

  const seg = (path: string): string[] => path.split("/").filter((part) => part.length > 0).slice(1);

  check("the bare path is the market", parseMarketRoute([]), { tab: "market", entry: null, settings: [] });
  check("the other tab", parseMarketRoute(["installed"]), { tab: "installed", entry: null, settings: [] });
  check("one entry", parseMarketRoute(["p", "autotitle"]), { tab: "market", entry: "autotitle", settings: [] });
  check("and its settings, on the machines the URL names", parseMarketRoute(["p", "autotitle", "settings", "m_1", "m_2"]), {
    tab: "market",
    entry: "autotitle",
    settings: ["m_1", "m_2"],
  });
  /*
   * ⚠ **A settings path naming no machine is the entry page, and never "all of
   * them".** Writing a form into a host nobody selected is the failure this shape
   * exists to prevent, and a wildcard is exactly how it would happen. The control
   * that opens this draws itself disabled instead; this is the belt under a stale
   * bookmark and a hand-typed address.
   */
  check("a settings path naming no machine is the entry", parseMarketRoute(["p", "autotitle", "settings"]), {
    tab: "market",
    entry: "autotitle",
    settings: [],
  });
  /*
   * ⚠ **`settings` is never filled without an `entry`**, which the type does not
   * express — `MarketRoute.entry` makes the same trade one field up, and for its
   * reason. Swept over every shape this parser can produce rather than over the
   * two that would break it today.
   */
  check(
    "settings never arrive without a plugin to be about",
    [["settings"], ["settings", "m_1"], ["p"], ["p", "", "settings", "m_1"], ["installed", "settings", "m_1"], []]
      .map((segments) => parseMarketRoute(segments))
      .filter((route) => route.settings.length > 0 && route.entry === null),
    [],
  );
  /*
   * ⚠ **The reason the machines are repeated segments rather than a comma-joined
   * list.** `encodeURIComponent` does not escape a comma, so `a,b` and a single id
   * holding one are the same string — and the failure is silent, and in the
   * direction that writes to machines nobody chose.
   */
  check(
    "a machine id holding a comma is still one machine",
    parseMarketRoute(seg(marketSettingsPath("x", ["a,b", "c"] as never)), decodeURIComponent).settings,
    ["a,b", "c"],
  );
  check(
    "and every segment is encoded and decoded like any other",
    parseMarketRoute(seg(marketSettingsPath("x", ["m 1", "m/2"] as never)), decodeURIComponent).settings,
    ["m 1", "m/2"],
  );
  /* One machine named twice is one machine: the fan-out is over this list. */
  check("a repeated machine is one machine", parseMarketRoute(["p", "x", "settings", "m_1", "m_1"]).settings, ["m_1"]);
  check("and an empty segment names none", parseMarketRoute(["p", "x", "settings", "", "m_1"]).settings, ["m_1"]);
  /*
   * ⚠ **Not sorted, because the builder joins in the order it is given.** Sorting
   * on the way in would make a path and its own parse disagree about the string.
   */
  check("the order the URL named them is the order that comes back", parseMarketRoute(["p", "x", "settings", "m_2", "m_1"]).settings, ["m_2", "m_1"]);
  /*
   * ⚠ **An entry's tab is always `market`, at every depth.** That is what makes
   * the ◀ land on a list with the plugin in it rather than on whichever tab
   * somebody happened to be looking at. An entry is only ever reached from the
   * market list, so there is no second answer to give.
   */
  check("and its tab is the one it was reached from", parseMarketRoute(["p", "x"]).tab, "market");

  /*
   * Three refusals, each falling *up* to the nearest real screen — the posture
   * `parseSettingsRoute` already takes, and for its reason: a stale bookmark, or a
   * plugin withdrawn from the catalogue, should land somewhere real rather than on
   * a 404 this app does not have.
   */
  check(
    "a bare /plugins/p, an unknown tab and junk all fall to the market",
    [parseMarketRoute(["p"]), parseMarketRoute(["nonsense"]), parseMarketRoute(["installed", "extra"])].map(
      (route) => route.entry,
    ),
    [null, null, null],
  );
  /*
   * And a segment under an entry that is not `settings` falls to the entry, not
   * to the market: the plugin in the URL is real and is the nearest real screen.
   */
  check(
    "an unknown leaf under a plugin is that plugin",
    parseMarketRoute(["p", "autotitle", "nonsense"]),
    { tab: "market", entry: "autotitle", settings: [] },
  );
  check("an unknown segment is the market rather than a tab nothing draws", parseMarketRoute(["nonsense"]).tab, "market");

  /*
   * ⚠ **Every tab has a row here, because the row is now the *heading*.** The
   * strip of two equal pills became a title plus one link — the tab you are on is
   * the screen's name, and the other is beside it — so a tab in the union with no
   * entry in this list is a screen whose name falls through to "Plugins" and whose
   * only way back is the browser's own.
   *
   * Read off the union in `market.ts` rather than typed out again: two lists of
   * the same members is the pair this file spends its length on.
   */
  {
    const src = readFileSync(new URL("../src/market.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const union = src.slice(src.indexOf("export type MarketTab ="));
    const members = [...union.slice(0, union.indexOf(";")).matchAll(/"([a-z]+)"/g)].map((one) => one[1] ?? "").sort();
    check("the tab union is readable at all", members.length > 0, true);
    check("and every one of its members is a drawable tab", MARKET_TABS.map((tab) => String(tab.id)).sort(), members);
    check("each with a title to draw", MARKET_TABS.filter((tab) => tab.title.trim().length === 0), []);
  }
  check("both tabs round-trip", MARKET_TABS.map((tab) => parseMarketRoute(seg(marketPath(tab.id))).tab), [
    "market",
    "installed",
  ]);
  check(
    "and an entry round-trips through its own builder",
    parseMarketRoute(seg(marketEntryPath("autotitle"))),
    { tab: "market", entry: "autotitle", settings: [] },
  );
  check(
    "and so do its settings, with the machines they are about",
    parseMarketRoute(seg(marketSettingsPath("autotitle", ["m_1", "m_2"] as never))),
    { tab: "market", entry: "autotitle", settings: ["m_1", "m_2"] },
  );
  // Built on `marketEntryPath` rather than beside it, so the two cannot disagree
  // about how an id is encoded.
  check(
    "a settings path is an entry path with the machines on it",
    marketSettingsPath("a b", ["m_1"] as never),
    `${marketEntryPath("a b")}/settings/m_1`,
  );
  /*
   * Encoded on the way out and decoded on the way in, like every other segment
   * this app builds. A catalogue id is `^[a-z0-9][a-z0-9-]{0,31}$` on the service
   * side, so nothing in practice needs it — which is exactly why it would go
   * unnoticed if it broke.
   */
  check(
    "an id is encoded and decoded like every other segment",
    parseMarketRoute(seg(marketEntryPath("a b")), decodeURIComponent).entry,
    "a b",
  );

  /*
   * ⚠ **`marketUp` and `marketPaneTitle` are non-null on exactly the same
   * depths**, asserted as a pairing rather than as two literals — `settingsUp`
   * and `settingsPaneTitle` carry the identical invariant one pop-up over, and
   * for the identical reason: a future depth must not arrive with a chevron over
   * an unnamed screen, or a name with no way back.
   */
  const shapes = [
    parseMarketRoute([]),
    parseMarketRoute(["installed"]),
    parseMarketRoute(["p"]),
    parseMarketRoute(["p", "autotitle"]),
    parseMarketRoute(["p", "autotitle", "settings", "m_1"]),
    parseMarketRoute(["p", "autotitle", "settings", "m_1", "m_2"]),
  ];
  check(
    "a way back and a name for the screen it leaves arrive together",
    shapes.filter((route) => (marketUp(route) === null) !== (marketPaneTitle(route) === null)),
    [],
  );
  check("a tab leaves the pop-up rather than moving inside it", marketUp(parseMarketRoute([])), null);
  check("an entry walks back to the list", marketUp(parseMarketRoute(["p", "x"])), "/plugins");
  /*
   * One level at a time: settings walk to the plugin, and the plugin walks to the
   * list. A settings screen that jumped straight to the market would make the ◀
   * and the ✕ the same control at that depth.
   */
  check("and settings walk back to the plugin", marketUp(parseMarketRoute(["p", "x", "settings", "m_1"])), "/plugins/p/x");

  /*
   * ⚠ **The origin, and the sweep is the point rather than the two cases somebody
   * thought of.** `marketUpFrom` overrides exactly one of `marketUp`'s three
   * answers — an entry's — because that one falls through to the market list on
   * the reasoning that "an entry is only ever reached from that list", which
   * `PluginsPanel` falsified the day it started linking here. The other two must
   * be untouched: a tab still leaves the pop-up however it was reached, and
   * settings still walk to their own plugin, which is a depth inside this pop-up
   * and has nothing to do with where the pop-up was entered from.
   *
   * Driven over every shape × both origin states rather than by naming the arm,
   * so a fourth depth cannot quietly acquire an override.
   */
  const ORIGIN = "/settings/machines/m_1/plugins";
  check(
    "an origin changes exactly one depth's answer",
    shapes.filter((route) => marketUpFrom(route, ORIGIN) !== marketUp(route)).map((route) => marketUp(route)),
    ["/plugins"],
  );
  check(
    "and with no origin it is marketUp exactly",
    shapes.filter((route) => marketUpFrom(route, null) !== marketUp(route)),
    [],
  );
  check(
    "an entry reached from the settings sheet walks back there",
    marketUpFrom(parseMarketRoute(["p", "x"]), ORIGIN),
    ORIGIN,
  );
  /*
   * ⚠ **Settings are not overridden, and this is the half that would look like a
   * tidy simplification.** Walking ◀ from a plugin's settings must reach the
   * plugin, and only then the origin — one level at a time, which is the rule
   * that stops the ◀ and the ✕ becoming the same control. Short-circuiting to the
   * origin here would skip the screen the person was on two seconds ago.
   */
  check(
    "but its settings still walk to the plugin first, whichever machines they are about",
    marketUpFrom(parseMarketRoute(["p", "x", "settings", "m_1", "m_2"]), ORIGIN),
    "/plugins/p/x",
  );
  check("and a tab still leaves the pop-up", marketUpFrom(parseMarketRoute([]), ORIGIN), null);
  /*
   * ⚠ **And a settings path naming no machine is not a settings depth at all** — it
   * is the entry page, so the origin override applies to it exactly as it does to
   * any other entry. This is the assertion that would have been quietly wrong if
   * the bare form had been left in `shapes` as a third depth.
   */
  check(
    "a settings path with no machine takes the entry's answer",
    marketUpFrom(parseMarketRoute(["p", "x", "settings"]), ORIGIN),
    ORIGIN,
  );

  /*
   * ⚠ **Whether the ◀ may be withdrawn at `sm`+, which is subtler than the settings
   * sheet's version of the same question.** There the parent is a row the rail
   * draws, so the chevron is redundant and hidden. Here `marketUpFrom` can answer
   * an **origin** — a settings path somebody crossed in from — and this rail draws
   * two tabs and nothing else, so at that depth the chevron is the only way back at
   * every width and must never be withdrawn.
   *
   * Compared against `marketUp` rather than tested as `origin !== null`, because an
   * origin is *present* at the settings depth and does not win there. Driven over
   * every shape × both origin states, so a fourth depth cannot acquire a hidden
   * chevron by accident.
   */
  check(
    "only an entry's parent is a row the rail draws",
    shapes.map((route) => marketUpWithinNav(route, null)),
    shapes.map((route) => route.entry !== null && route.settings.length === 0),
  );
  check(
    "and an origin takes exactly that one back out of the rail",
    shapes.filter((route) => marketUpWithinNav(route, ORIGIN) !== marketUpWithinNav(route, null)).map(marketUp),
    ["/plugins"],
  );
  /* Nothing may be withdrawn that has no way up at all — a tab answers `null`. */
  check(
    "nothing is withdrawn that has nowhere to go",
    shapes.filter((route) => marketUpWithinNav(route, null) && marketUp(route) === null),
    [],
  );
  /*
   * The label and the width gate are one decision, so a chevron that says "Back to
   * Market" while pointing at a settings screen is not expressible.
   */
  check(
    "the label names where it actually goes",
    [
      marketUpLabel(parseMarketRoute(["p", "x"]), null),
      marketUpLabel(parseMarketRoute(["p", "x"]), ORIGIN),
      marketUpLabel(parseMarketRoute(["p", "x", "settings", "m_1"]), null),
      marketUpLabel(parseMarketRoute(["p", "x", "settings", "m_1"]), ORIGIN),
    ],
    ["Back to Market", "Back", "Back to the plugin", "Back to the plugin"],
  );
  check(
    "and it never says Market about a screen the rail cannot draw",
    shapes
      .flatMap((route) => [null, ORIGIN].map((from) => [marketUpLabel(route, from), marketUpWithinNav(route, from)] as const))
      .filter(([label, within]) => (label === "Back to Market") !== within),
    [],
  );

  /*
   * ⚠ **`upFrom` is the other consumer, and the third argument defaults to
   * `null`** — which is right for every pre-existing caller and is exactly why a
   * caller that simply stops passing it typechecks clean. Telegram's arrow and the
   * on-screen ◀ would then disagree, which is the one thing `nav.ts`'s docblock
   * says this function exists to prevent. So both the function and its call site
   * are pinned.
   */
  {
    const { upFrom } = await import("../src/nav.js");
    const asPluginsRoute = (segments: string[]): never =>
      ({ name: "plugins", ...parseMarketRoute(segments) }) as never;
    check(
      "an entry's way up honours the origin",
      upFrom(asPluginsRoute(["p", "x"]), "/m/m_1/s/s_1", ORIGIN),
      ORIGIN,
    );
    check(
      "and falls back to the market list without one",
      upFrom(asPluginsRoute(["p", "x"]), "/m/m_1/s/s_1"),
      "/plugins",
    );
    check(
      "a tab still leaves the pop-up onto what it was drawn over",
      upFrom(asPluginsRoute([]), "/m/m_1/s/s_1", ORIGIN),
      "/m/m_1/s/s_1",
    );
    const appSrc = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
    check("and the app actually hands it the origin", /upFrom\(route, under, origin\)/.test(appSrc), true);

    /*
     * ⚠ **`originFor` is pure and lives in `nav.ts`, and that is the whole point
     * of asserting it here.** It sat in `router.ts` for one round, where nothing
     * offline can import it — the reason this module exists at all — and a
     * mutation run inverted its comparison with every check still green. Driven
     * over the cases rather than the one that was wrong.
     */
    const { originFor } = await import("../src/nav.js");
    const SETTINGS = "/settings/machines/m_1/plugins";
    const ENTRY = "/plugins/p/x";
    check("crossing from one pop-up to another records where you came from", originFor(SETTINGS, ENTRY, null), SETTINGS);
    /*
     * Walking deeper inside one pop-up keeps the origin it already had, so the ◀
     * reaches it at that pop-up's shallowest depth rather than short-circuiting.
     */
    check("walking deeper inside one pop-up keeps it", originFor(ENTRY, `${ENTRY}/settings`, SETTINGS), SETTINGS);
    check("and records nothing where there was nothing", originFor(ENTRY, `${ENTRY}/settings`, null), null);
    /* Opening a pop-up from a screen is not a crossing: there is no origin. */
    check("opening a pop-up from a screen records none", originFor("/m/m_1/s/s_1", ENTRY, null), null);
    check("and navigating to a screen records none", originFor(ENTRY, "/m/m_1/s/s_1", SETTINGS), null);
    /*
     * ⚠ **`/p/:machineId/:pluginId` and `/plugins` are two pop-ups sharing four
     * letters.** A prefix comparison calls them one, which would make a plugin's
     * own screen and the market indistinguishable to this rule.
     */
    check("a plugin's screen and the market are different pop-ups", originFor("/p/m_1/board", ENTRY, null), "/p/m_1/board");
  }

  /*
   * ⚠ **Both tabs sit at one depth and an entry one deeper.** Equal depths make
   * `navMove` answer `null`, which is right: switching tabs is the same pane with
   * different contents, and that is not a direction. Walking into an entry is a
   * `section-push` — the sheet's body slides while the panel stays put — and back
   * out is its exact reverse, which is what stops the two animations drifting.
   */
  const asRoute = (route: unknown): never => ({ name: "plugins", ...(route as object) }) as never;
  const market = asRoute(parseMarketRoute([]));
  const installed = asRoute(parseMarketRoute(["installed"]));
  const entry = asRoute(parseMarketRoute(["p", "autotitle"]));
  const settings = asRoute(parseMarketRoute(["p", "autotitle", "settings", "m_1"]));
  check(
    "the two tabs are one depth, an entry the next, its settings the next",
    [depthOf(market), depthOf(installed), depthOf(entry), depthOf(settings)],
    [1, 1, 2, 3],
  );
  check("switching tabs moves nothing", navMove(market, installed), null);
  check("walking into an entry pushes the section", navMove(market, entry), "section-push");
  check("and walking back out pops it", navMove(entry, market), "section-pop");
  // Opening settings pushes and the ◀ pops, which is the pair an agent's screen
  // already gives one pop-up over — so a plugin's settings animate like every
  // other leaf.
  check("opening settings pushes one more", navMove(entry, settings), "section-push");
  check("and the way back pops it", navMove(settings, entry), "section-pop");
  /*
   * ⚠ **Two scopes are the same depth, so narrowing one is not a direction.** The
   * same pane with different contents must not slide, which is the rule `depthOf`'s
   * own head states and the reason the machine list is not part of the depth.
   */
  check(
    "narrowing the scope moves nothing",
    navMove(settings, asRoute(parseMarketRoute(["p", "autotitle", "settings", "m_1", "m_2"]))),
    null,
  );
  /*
   * Leaving the pop-up entirely is a close, whichever depth it is left from —
   * `isSheet` decides that before any depth is compared, which is why an entry
   * (depth 2) closing onto a session (depth 1) is not a `pop`.
   */
  check(
    "and leaving it is a close from either depth",
    [navMove(market, { name: "home" } as never), navMove(entry, { name: "home" } as never)],
    ["sheet-close", "sheet-close"],
  );
}

process.stdout.write("\nwhat the catalogue says, and what this build will read of it\n");
{
  const { compareVersions, isNewer, catalogueNotice, catalogueEndpoint, previewOf, readCatalogue, readOne, readVersions } =
    await import("../src/catalogue.js");

  const PIN_REPO = "rends-east/autotitle";
  const PIN_COMMIT = "b".repeat(40);
  /*
   * ⚠ **Every address is built from the pin rather than typed out, because the
   * reader now insists they were.** They were spelled `…/tree/bbb` against a
   * forty-`b` commit — readable, and exactly the divergence `readSource` drops an
   * entry for the moment `manifestRaw` has to equal its derivation. A fixture with
   * hand-typed addresses would have taken every assertion in this block with it,
   * which is the wrong way for a driver to fail.
   *
   * `repo` and `commit` come out of the patch when it carries them, so a case that
   * moves the pin moves the addresses with it and isolates the one rule it is
   * about. `...patch` stays last so an explicit address still wins.
   */
  const source = (patch: Record<string, unknown> = {}): Record<string, unknown> => {
    const repo = typeof patch["repo"] === "string" ? patch["repo"] : PIN_REPO;
    const commit = typeof patch["commit"] === "string" ? patch["commit"] : PIN_COMMIT;
    return {
      kind: "github",
      repo,
      commit,
      browse: `https://github.com/${repo}/tree/${commit}`,
      manifest: `https://github.com/${repo}/blob/${commit}/plugin.json`,
      manifestRaw: `https://raw.githubusercontent.com/${repo}/${commit}/plugin.json`,
      archive: `https://codeload.github.com/${repo}/tar.gz/${commit}`,
      archiveName: `autotitle-${commit}.tar.gz`,
      archiveBytes: 14741,
      icon: null,
      sha256Seen: "deff37945c201",
      ...patch,
    };
  };
  const entry = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "autotitle",
    name: "Autotitle",
    description: "Names a session from what the agent did.",
    version: "0.2.1",
    api: 2,
    scopes: ["sessions.read", "sessions.write"],
    net: [],
    contributes: { screen: null, settings: true, actions: [], hooks: ["turn.ended"] },
    source: source(),
    homepage: null,
    author: "rends-east",
    license: "AGPL-3.0",
    categories: ["sessions"],
    publishedAt: "2026-08-20T10:00:00.000Z",
    ...patch,
  });

  const read = readCatalogue({ schema: 1, plugins: [entry()] });
  check("a catalogue reads", [read.kind, read.kind === "ok" ? read.entries.length : -1], ["ok", 1]);
  check(
    "and the fields somebody consents to survive it",
    read.kind === "ok" ? [read.entries[0]?.scopes, read.entries[0]?.contributes.hooks] : null,
    [["sessions.read", "sessions.write"], ["turn.ended"]],
  );

  /*
   * ⚠ **An empty catalogue is `ok`, not an error.** A service that has published
   * nothing is an ordinary state — `plugins.reemoat.com` is exactly that today —
   * and drawing "something went wrong" over it sends somebody looking for a fault
   * that is not there.
   */
  check("an empty catalogue is a state rather than a failure", readCatalogue({ schema: 1, plugins: [] }).kind, "ok");
  check(
    "and it says so in words",
    catalogueNotice(readCatalogue({ schema: 1, plugins: [] })),
    "There is nothing in the catalogue yet.",
  );

  /*
   * ⚠ **This is the one reader in the client that fails *closed*, and these two
   * cases are why.** Everything in `plugins.ts` fails open on purpose: an unknown
   * block there costs a row nobody sees. Here a half-read entry is a half-read
   * **permission list**, on the screen where somebody grants a stranger's code
   * access to their sessions — and showing four of five scopes is worse than
   * showing none, because the person cannot tell which they are looking at.
   */
  check("a schema this build does not speak is refused whole", readCatalogue({ schema: 2, plugins: [entry()] }), {
    kind: "too_new",
    schema: 2,
  });
  check(
    "and it is never partially parsed",
    (() => {
      const answer = readCatalogue({ schema: 2, plugins: [entry()] });
      return "entries" in answer;
    })(),
    false,
  );
  check("a document that is not one says so", readCatalogue({ plugins: [] }).kind, "malformed");
  check("and so does a list that is not a list", readCatalogue({ schema: 1, plugins: "no" }).kind, "malformed");

  /*
   * ⚠ **"Fails closed" means *a required field is missing or wrong-typed*, and it
   * must never come to mean *a field arrived that this build has not heard of*.**
   *
   * This is the assertion that keeps the two apart, and the failure it prevents is
   * one nobody local would ever see. The service's rule is that fields are added
   * and never repurposed, with `schema` moving only when that is not enough — so a
   * reader that refused unknown keys would go dark on every **already-deployed**
   * client the next time a field is added. Not immediately, not for whoever added
   * it: for everyone whose web client is older than that deploy. `source.icon` was
   * added exactly that way, in the service's own first commit.
   *
   * All three depths, because they are three separate readers and only one of them
   * would have to get it wrong: the document beside `schema`/`plugins`, the entry,
   * and `source`. `contributes` is in here too — a fifth contribution point is the
   * likeliest next addition, and it must not take the market down with it.
   */
  {
    const tomorrow = entry({
      downloads: 4210,
      source: source({ signature: "sig", mirrors: ["a"] }),
      contributes: { screen: null, settings: false, actions: [], hooks: ["turn.ended"], commands: [{ id: "c" }] },
    });
    const answer = readCatalogue({ schema: 1, plugins: [tomorrow], generatedAt: "2026-08-23T00:00:00.000Z" });
    check(
      "a field this build has not heard of is ignored, never a refusal",
      [answer.kind, answer.kind === "ok" ? answer.entries.length : -1],
      ["ok", 1],
    );
    check(
      "and the fields it does know survive beside it",
      answer.kind === "ok" ? [answer.entries[0]?.id, answer.entries[0]?.contributes.hooks] : null,
      ["autotitle", ["turn.ended"]],
    );
    check("the same holds for one plugin", readOne({ schema: 1, plugin: tomorrow, extra: 1 }).kind, "ok");
    check(
      "and for a version history",
      readVersions({ schema: 1, id: "autotitle", versions: [tomorrow], extra: 1 }).kind,
      "ok",
    );
  }

  /*
   * ⚠ **`too_new` is a branch with its own sentence, not the general refusal
   * path.** A schema bump is the service saying "this needs a newer client", and if
   * it drew the same words a corrupt document draws, the day somebody bumps it
   * looks to every user like the market broke. The remedy differs too — one is
   * "wait", the other is "somebody has to deploy" — so the two strings must not
   * converge, which is what this asserts rather than the wording of either.
   */
  check(
    "a schema bump reads as the app being behind, not as a broken catalogue",
    catalogueNotice({ kind: "too_new", schema: 2 }) === catalogueNotice({ kind: "malformed", reason: "x" }),
    false,
  );
  check(
    "and it names the remedy rather than the fault",
    (catalogueNotice({ kind: "too_new", schema: 2 }) ?? "").includes("updated"),
    true,
  );

  /*
   * ⚠ **A pin that is not a commit is dropped, by the daemon's own rule.** `POST
   * /plugins/source` refuses anything but a full 40-character sha — a tag moves
   * under `git tag -f`, and what is being pinned is code that runs as the machine's
   * owner with no sandbox. An entry carrying a tag is therefore one this app could
   * draw and never install, so it is not drawn.
   */
  /** How many entries a catalogue carrying exactly this one source produced. */
  const admitted = (patch: Record<string, unknown> = {}): number => {
    const answer = readCatalogue({ schema: 1, plugins: [entry({ source: source(patch) })] });
    return answer.kind === "ok" ? answer.entries.length : -1;
  };
  /** That one source, as this build read it — or `null` for an entry it dropped. */
  const sourceOf = (patch: Record<string, unknown> = {}) => {
    const answer = readCatalogue({ schema: 1, plugins: [entry({ source: source(patch) })] });
    return answer.kind === "ok" ? (answer.entries[0]?.source ?? null) : null;
  };

  check("an entry pinned to a tag rather than a commit is not offered", admitted({ commit: "v1.2.0" }), 0);

  /*
   * ⚠ **The repository is held to the daemon's own expression too, and it does a
   * second job here.** `POST /plugins/source` 400s on anything but `owner/name`,
   * so a row spelled otherwise has a button that cannot work — and every address
   * in the entry is built by interpolating this string into a URL path, so
   * `owner/name/tree` derives a `browse` of
   * `https://github.com/owner/name/tree/tree/<sha>`: a third path segment, which
   * is a different repository's file drawn under this plugin's name. Same
   * sentence as `src/plugins/source.ts`'s — no part of the address may come from
   * whoever sent it.
   */
  check("a repository that is not owner/name is not offered", admitted({ repo: "rends-east/autotitle/tree" }), 0);
  check("and neither is one that is itself a URL", admitted({ repo: "https://evil.example/x" }), 0);

  /*
   * ⚠ **The manifest a *program* reads is derived from the pin, never taken from
   * the catalogue.** `MarketEntry` fetches this address and the bytes that come
   * back become the permission list somebody agrees to, so a catalogue-chosen
   * value is a catalogue-chosen **disclosure** — and this app's own control plane
   * puts the catalogue's origin in `connect-src`, so one pointing back at the
   * service fetches perfectly and draws a hand-typed list under the words *the
   * manifest at that commit*.
   *
   * ⚠ **The consent checks downstream do not restore it, and the reason is what
   * they compare.** `consentGap` and `consentBroken` both compare *scopes, `net`
   * and hooks* and nothing else, so a forged manifest that under-declares those
   * three is refused before the plugin starts. What neither compares is the rest
   * of what this screen draws — `id`, `name`, `version`, `description`, and the
   * screens, settings pane and session actions a plugin contributes.
   * `consentBroken`'s own docblock says names and versions are deliberately not
   * compared. So the gap was never the scopes; it was everything beside them.
   */
  check(
    "the manifest a program reads is derived from the pin",
    sourceOf()?.manifestRaw,
    `https://raw.githubusercontent.com/${PIN_REPO}/${PIN_COMMIT}/plugin.json`,
  );
  check(
    "one the catalogue points somewhere else is not offered at all",
    admitted({ manifestRaw: "https://plugins.example/manifests/autotitle.json" }),
    0,
  );
  /*
   * ⚠ **The sharp one: the right host, the wrong commit.** This is what a
   * host-only check admits — it is inside `connect-src`, it is on
   * `raw.githubusercontent.com`, and it is a `plugin.json` belonging to code
   * nobody is about to install. Only comparing against the derivation catches it.
   */
  check(
    "and neither is one on the right host at a commit that is not the pin",
    admitted({ manifestRaw: `https://raw.githubusercontent.com/${PIN_REPO}/${"a".repeat(40)}/plugin.json` }),
    0,
  );

  /*
   * ⚠ **The two links a *person* reads fall back to the pin rather than dropping
   * the plugin.** They are `<a href>`s labelled with the repository's own name, on
   * the screen where somebody decides whether to trust a stranger's code, so one
   * off `github.com` says it goes to the code and goes elsewhere. The derivation
   * is already what an absent value takes and it is provably right, so the person
   * gets the true link either way and no plugin goes dark over the spelling of a
   * link.
   */
  check(
    "a browse link off github.com is replaced by the pinned tree rather than honoured",
    sourceOf({ browse: "https://evil.example/rends-east/autotitle" })?.browse,
    `https://github.com/${PIN_REPO}/tree/${PIN_COMMIT}`,
  );
  check(
    "and so is a manifest link that is merely http",
    sourceOf({ manifest: `http://github.com/${PIN_REPO}/blob/${PIN_COMMIT}/plugin.json` })?.manifest,
    `https://github.com/${PIN_REPO}/blob/${PIN_COMMIT}/plugin.json`,
  );
  /*
   * ⚠ **Parsed, never prefix-matched, and these are the two cases that decide
   * which.** `https://github.com@evil.example/…` begins with the right string and
   * its host is `evil.example`; `https://github.com.evil.example/…` contains it.
   * Both pass every hand-rolled test and neither is GitHub.
   */
  check(
    "a host that only looks like github.com is not github.com",
    [
      sourceOf({ browse: "https://github.com@evil.example/x" })?.browse,
      sourceOf({ browse: "https://github.com.evil.example/x" })?.browse,
    ],
    [`https://github.com/${PIN_REPO}/tree/${PIN_COMMIT}`, `https://github.com/${PIN_REPO}/tree/${PIN_COMMIT}`],
  );

  /*
   * ⚠ **An icon is the one address whose failure costs the icon rather than the
   * plugin.** `icon: null` is the commonest answer and the glyph beside it is the
   * ordinary case, so a plugin vanishing from the market over its picture would be
   * out of all proportion. `img-src` on this document lists exactly this host, so
   * without the check the alternative was a broken image until `onError` fired.
   */
  check(
    "an icon off the manifest host is no icon rather than no plugin",
    (() => {
      const answer = readCatalogue({
        schema: 1,
        plugins: [entry({ source: source({ icon: "https://evil.example/i.svg" }) })],
      });
      return answer.kind === "ok" ? [answer.entries.length, answer.entries[0]?.source.icon ?? null] : null;
    })(),
    [1, null],
  );
  check(
    "and one at the pin is kept exactly as it was sent",
    sourceOf({ icon: `https://raw.githubusercontent.com/${PIN_REPO}/${PIN_COMMIT}/icon.svg` })?.icon,
    `https://raw.githubusercontent.com/${PIN_REPO}/${PIN_COMMIT}/icon.svg`,
  );

  /*
   * ⚠ **Explicit `null`, and `??` rather than `||`.** Measured against the live
   * service: every key is present on every read and the value is `T | null`, never
   * absent. `archiveBytes: 0` is legitimate, and `||` would turn it into `null`.
   */
  check(
    "a zero-byte archive keeps its zero",
    (() => {
      const answer = readCatalogue({ schema: 1, plugins: [entry({ source: source({ archiveBytes: 0 }) })] });
      return answer.kind === "ok" ? answer.entries[0]?.source.archiveBytes : "missing";
    })(),
    0,
  );
  check(
    "and a missing icon is null rather than a broken address",
    (() => {
      const answer = readCatalogue({ schema: 1, plugins: [entry()] });
      return answer.kind === "ok" ? answer.entries[0]?.source.icon : "missing";
    })(),
    null,
  );

  check("one plugin answers the same union, with one entry", readOne({ schema: 1, plugin: entry() }).kind, "ok");
  check(
    "and a plugin this build cannot read is zero of them rather than an error",
    (() => {
      const answer = readOne({ schema: 1, plugin: { id: "x" } });
      return answer.kind === "ok" ? answer.entries.length : -1;
    })(),
    0,
  );
  check(
    "a version history is the same union too",
    (() => {
      const answer = readVersions({ schema: 1, id: "autotitle", versions: [entry(), entry({ version: "0.2.0" })] });
      return answer.kind === "ok" ? answer.entries.map((one) => one.version) : null;
    })(),
    ["0.2.1", "0.2.0"],
  );

  /*
   * ⚠ **Numeric, component by component.** `"0.10.0" < "0.9.0"` is true
   * lexicographically because `"1" < "9"` — so a string compare reports an update
   * available on the version already installed, for ever, from the tenth minor
   * release onwards. That is the case worth pinning, because it is the first time
   * it bites and it bites silently.
   */
  check("0.10.0 is newer than 0.9.0, which a string compare gets backwards", isNewer("0.10.0", "0.9.0"), true);
  check("and 0.9.0 is not newer than 0.10.0", isNewer("0.9.0", "0.10.0"), false);
  check("equal versions are neither", compareVersions("1.2.3", "1.2.3"), 0);
  check("a shorter version is padded rather than refused", compareVersions("1.2", "1.2.0"), 0);
  check("and something unreadable sorts as zero rather than throwing", compareVersions("what", "0.0.0"), 0);

  // `new URL` against the base, so a trailing slash on either side is the same
  // address — and so a base that is not a URL throws here rather than producing a
  // relative path the SPA fallback would answer with index.html.
  check(
    "an endpoint is built the same way whether the base ends in a slash",
    [
      catalogueEndpoint("https://plugins.example", "api/plugins/list"),
      catalogueEndpoint("https://plugins.example/", "/api/plugins/list"),
    ],
    ["https://plugins.example/api/plugins/list", "https://plugins.example/api/plugins/list"],
  );

  /*
   * The fallback disclosure, when the manifest at the pinned commit could not be
   * read. It has to carry the three fields somebody actually consents to, or the
   * screen using it would disclose less than the catalogue knows.
   */
  const only = readCatalogue({ schema: 1, plugins: [entry()] });
  const preview = previewOf((only.kind === "ok" ? only.entries[0] : null) as never);
  check(
    "the fallback preview carries what a person agrees to",
    [preview.scopes, preview.net, preview.hooks, preview.settings],
    [["sessions.read", "sessions.write"], [], ["turn.ended"], true],
  );
}
