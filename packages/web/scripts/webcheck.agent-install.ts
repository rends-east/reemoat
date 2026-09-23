import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { JARGON_WORDS } from "./webcheck.agent-card.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * Installing a harness, because somebody asked for it
 *
 * The daemon side is `daemoncheck.agent-install.ts`; the script's own end of the
 * step grammar is `deploycheck`. What is here is the client's rule for which
 * control a card draws, and the placements that keep the card the one surface a
 * run is started from. The strip owed a machine a door once — `agentDoor` — and
 * owes it none now (Q3.640); what is left of that is an absence, below.
 * ------------------------------------------------------------------ */
process.stdout.write("\ninstalling a harness, from this side\n");
{
  const {
    installElapsed,
    installFailure,
    installResult,
    installResultLine,
    installStage,
    installStep,
    keepInstallTail,
    primaryControl,
    rawInstallIsOpen,
    ELAPSED_AFTER_MS,
    MAX_INSTALL_OUTPUT_CHARS,
  } = await import("../src/ui/agentInstall.js");
  const { stanceLine } = await import("../src/ui/agentCard.js");

  const STANCES = [
    "not_installed",
    "start_refused",
    "no_login",
    "signed_in",
    "signed_out",
    "unchecked",
  ] as const;
  const FLAGS = ["installRunning", "wizardOpen", "installable", "canSignIn", "canSignOut"] as const;

  /* ---------------------------------------------------------------- *
   * The sweep's own two axes, against the source that declares them
   *
   * ⚠ **A hand-typed union shadow goes silently partial, and this one would
   * have.** `STANCES` is six members of `AgentStance` and `FLAGS` is five fields
   * of `primaryControl`'s input — and a *seventh* stance is a compile error
   * inside that function's `never` arm and **nowhere here**, because a subset is
   * assignable: `tsc` stays clean while the sweep below runs over 6 of 7 and
   * still prints green. What the count said was `cells.length === 192`, a
   * hand-typed number compared against the product of the loops around it, which
   * reads nothing from `src/` at all — so it could only ever restate the sweep's
   * own size back to itself.
   *
   * Both axes are differenced against their declarations instead, over a
   * **comment-stripped** copy: this repository restates its own rules in prose,
   * so a regex over raw source matches the docblock explaining the rule rather
   * than the rule.
   * ---------------------------------------------------------------- */
  const cardSrc = stripComments(srcFile("ui/agentCard.ts"));
  const declaredStances = [
    ...(/export type AgentStance =([^;]*);/.exec(cardSrc)?.[1] ?? "").matchAll(/"([^"]+)"/g),
  ].map((one) => one[1] ?? "");
  report(
    "the stance union was read off its own declaration",
    declaredStances.length > 0,
    `${declaredStances.length} members`,
  );
  check(
    "and the sweep's stance list is that union, neither short nor long",
    [
      declaredStances.filter((one) => !STANCES.includes(one as (typeof STANCES)[number])),
      STANCES.filter((one) => !declaredStances.includes(one)),
    ],
    [[], []],
  );
  const installSrc = stripComments(srcFile("ui/agentInstall.ts"));
  const declaredFlags = [
    ...(/export function primaryControl\(input: \{([^}]*)\}/.exec(installSrc)?.[1] ?? "").matchAll(
      /(\w+): boolean/g,
    ),
  ].map((one) => one[1] ?? "");
  report(
    "and the flag axis off the input it is a product of",
    declaredFlags.length > 0,
    `${declaredFlags.length} flags`,
  );
  check(
    "which the sweep's flag list is too, neither short nor long",
    [
      declaredFlags.filter((one) => !FLAGS.includes(one as (typeof FLAGS)[number])),
      FLAGS.filter((one) => !declaredFlags.includes(one)),
    ],
    [[], []],
  );

  /* ---------------------------------------------------------------- *
   * `primaryControl` is a total partition
   *
   * ⚠ **Swept over every declared stance × every flag combination, and printed
   * as a census** rather than counted: a `length === N` passes over the one cell
   * that moved. What is asserted below is the handful whose being wrong is a
   * control nobody can press or one nobody chose.
   *
   * ⚠ **A stance the function has not heard of comes back as *itself*.** The
   * `never` arm is `const exhaustive: never = input.stance; return exhaustive;`
   * — which at runtime returns the stance string — so the cell is populated, the
   * count is right, and the only thing that can see it is the *set* of answers
   * one check down. Measured by adding a seventh member: that check and the
   * census above it go red together, and nothing else does.
   * ---------------------------------------------------------------- */
  const cells: { stance: string; flags: number; answer: string }[] = [];
  const bools = [false, true];
  // The bit order is this list's; which bit is which does not matter to a sweep
  // over every combination, and membership is what the census above pins. The
  // literal call is kept so a *sixth* required flag is a compile error here.
  for (const stance of declaredStances) {
    for (let mask = 0; mask < 2 ** FLAGS.length; mask += 1) {
      const set = (bit: number): boolean => (mask & (1 << bit)) !== 0;
      cells.push({
        stance,
        flags: mask,
        answer: primaryControl({
          stance: stance as (typeof STANCES)[number],
          installRunning: set(0),
          wizardOpen: set(1),
          installable: set(2),
          canSignIn: set(3),
          canSignOut: set(4),
        }),
      });
    }
  }
  /*
   * ⚠ **Each axis is pinned by the thing that can see it, and neither by a
   * product.** This was `cells.length === 2 ** FLAGS.length` — a value against a
   * re-derivation of itself, green over any list including `[]`. Rewriting it as
   * `declaredStances.length * 2 ** declaredFlags.length` fixed only half: the loop
   * is `for (const stance of declaredStances)`, so that multiplicand is the loop
   * bound and the stance half still could not fail — demonstrated with a
   * seven-member union, which printed `ok … 224 cells` while the difference above
   * went red. So the stance axis is pinned by that difference, and the flag axis
   * is pinned here, directly: the sweep must iterate exactly as many bits as
   * `primaryControl` declares fields. The cell count is printed beside it as a
   * number to read, not as a claim.
   */
  check("the sweep iterates as many flag bits as the card's own input declares", FLAGS.length, declaredFlags.length);
  report(
    "every stance and flag combination has an answer",
    cells.length > 0,
    `${declaredStances.length} stances × ${2 ** FLAGS.length} flag combinations = ${cells.length} cells`,
  );
  check(
    "and every answer is one this card can draw",
    [...new Set(cells.map((one) => one.answer))].sort(),
    ["install", "installing", "none", "sign_in", "sign_out", "wizard"],
  );

  /*
   * ⚠ **The old-daemon property, and the one that must be impossible to lose.**
   * `installable` absent reads as `false`, and a `not_installed` row without it
   * must answer `none` for *every other flag combination* — an Install button on
   * a daemon with no install route is a control that answers a bare 404 with no
   * error envelope, which is nothing to render.
   */
  check(
    "a harness this machine cannot install offers no install, whatever else is true",
    [
      // Of the 32 `not_installed` cells, 16 set `installable`; a live run
      // outranks half of those and an open wizard half of what is left, so 4
      // answer "install". Written as the derivation rather than the number,
      // because a bare 4 is a figure somebody adjusts until the check passes.
      cells.filter((one) => one.stance === "not_installed" && one.answer === "install").length,
      cells.filter((one) => one.stance === "not_installed").length,
    ],
    [2 ** FLAGS.length / 2 / 2 / 2, 2 ** FLAGS.length],
  );
  check(
    "and with no install store at all it is never offered",
    STANCES.flatMap((stance) =>
      bools.flatMap((canSignIn) =>
        bools.map((canSignOut) =>
          primaryControl({ stance, installRunning: false, wizardOpen: false, installable: false, canSignIn, canSignOut }),
        ),
      ),
    ).includes("install"),
    false,
  );
  /*
   * ⚠ **`not_installed` outranks the credential axis, and that is the repair.**
   * `canSignIn` is `login.supported && agent.available`, so it is already false
   * for a harness that is not there — which is why the slot reached its final
   * `: null` and the card drew nothing under a sentence saying it was missing.
   * The cell with `canSignIn: true` is in here on purpose: `agentStance`'s own
   * docblock says (adapter missing + wizard runnable) is a real state.
   */
  check(
    "a harness that is not installed offers the install, even where a sign-in could run",
    primaryControl({ stance: "not_installed", installRunning: false, wizardOpen: false, installable: true, canSignIn: true, canSignOut: true }),
    "install",
  );
  /*
   * ⚠ **A live run outranks every stance, `signed_in` included.** Re-installing a
   * working harness is a legitimate thing to be doing, and it must not be
   * hijacked by Sign out — nor by a wizard, since the listing that put the run
   * there is what says the harness is absent.
   */
  check(
    "a run in flight is what the slot shows, in every stance",
    STANCES.map((stance) =>
      primaryControl({ stance, installRunning: true, wizardOpen: true, installable: true, canSignIn: true, canSignOut: true }),
    ),
    STANCES.map(() => "installing"),
  );
  check(
    "and nothing but not_installed ever answers install",
    [...new Set(cells.filter((one) => one.answer === "install").map((one) => one.stance))],
    ["not_installed"],
  );
  check(
    "while only signed_in signs out, and only under a sign-out command",
    [
      [...new Set(cells.filter((one) => one.answer === "sign_out").map((one) => one.stance))],
      primaryControl({ stance: "signed_in", installRunning: false, wizardOpen: false, installable: false, canSignIn: true, canSignOut: false }),
    ],
    [["signed_in"], "none"],
  );

  /* ---------------------------------------------------------------- *
   * `agentDoor`, and why it is gone
   * ---------------------------------------------------------------- */
  /*
   * ⚠ **It chose which disclosure New session unfolded — Install or Sign in — and
   * that screen unfolds none now** (Q3.640). The reported bug it fixed was real
   * and its repair survives where it belongs: `primaryControl` tests `available`
   * before the credential axis, pinned above, and that is the card the Agents
   * list's Set up opens. Asserted as an absence on the module that held both
   * helpers, so neither can come back as a door with no screen to be drawn on.
   */
  {
    const mod: Record<string, unknown> = await import("../src/ui/agentInstall.js");
    check(
      "the strip's door is gone from the module that held it",
      ["agentDoor", "doorLabel"].filter((name) => name in mod),
      [],
    );
  }

  /* ---------------------------------------------------------------- *
   * The transcript reducer and the clock
   * ---------------------------------------------------------------- */
  const run = (over: Record<string, unknown> = {}) =>
    ({ done: false, outcome: "running", phase: null, ...over }) as never;
  check(
    "a run with no checkpoint yet is starting, and one with a real step is working",
    [installStage(run()), installStage(run({ phase: "start" })), installStage(run({ phase: "download" }))],
    ["starting", "starting", "working"],
  );
  check(
    "and a finished one is read off the outcome, never the exit code",
    [
      installStage(run({ done: true, outcome: "installed" })),
      installStage(run({ done: true, outcome: "failed" })),
      installStage(run({ done: true, outcome: "locked" })),
    ],
    ["done", "failed", "failed"],
  );
  /*
   * ⚠ **The step line names a checkpoint the installer printed**, which is the
   * only reason it is legal at all: `MachineInstalls` refuses a stage label on
   * the ground that nothing in *its* flow is on the wire, and it is right about
   * its own case. `start` says nothing, because "start" is not news to somebody
   * who just pressed the button.
   */
  check(
    "the step line is a word for a checkpoint, and silent where there is none",
    [installStep(null), installStep("start"), installStep("download"), installStep("install"), installStep("link"), installStep("done")],
    [null, null, "Downloading…", "Installing…", "Finishing…", null],
  );
  check(
    "the clock says nothing until it is worth saying, and then says seconds",
    [installElapsed(0, ELAPSED_AFTER_MS - 1), installElapsed(0, ELAPSED_AFTER_MS), installElapsed(0, 0), installElapsed(0, 42_000)],
    [null, "10s", null, "42s"],
  );

  /* ---------------------------------------------------------------- *
   * What it says, and what it refuses to invent
   * ---------------------------------------------------------------- */
  /*
   * ⚠ **No sentence for a network failure**, which is `ui/login.ts`'s standing
   * rule — a recognised failure names something that cannot be retried away, and
   * a vendor host that timed out is what an installer prints twice before
   * succeeding. The cost is that the commonest real failure falls through to the
   * raw output, which is the screen this replaces and never worse than it.
   */
  check(
    "a running or installed run has nothing to apologise for",
    [installFailure("running", "Kimi"), installFailure("installed", "Kimi")],
    [null, null],
  );
  check(
    "and every other outcome has exactly one sentence",
    (["failed", "locked", "timeout", "cancelled", "spawn_failed"] as const).map((one) => installFailure(one, "Kimi") !== null),
    [true, true, true, true, true],
  );
  /*
   * ⚠ **The `installed` line names the *next* step, and without it the flow reads
   * as broken.** `offersTile` keeps both `not_installed` and `signed_out` off the
   * New session strip, so a freshly installed harness still has no tile:
   * somebody installs, looks at the strip, sees nothing, and concludes it failed.
   * This is the only place that can say so.
   */
  check(
    "the success line points at the sign-in, because the tile is not back yet",
    installResultLine("installed", "Claude Code"),
    "Claude Code is installed. Sign in to start a chat with it.",
  );
  check(
    "and the re-read has a definite answer either way — there is no cannot-tell here",
    [
      installResult(true, false, false),
      installResult(false, true, false),
      installResult(false, false, true),
      installResult(false, false, false),
    ],
    ["checking", "unreachable", "installed", "notInstalled"],
  );
  /*
   * `rawTranscriptIsOpen`'s partition, narrowed: never over a run that worked,
   * and never where a sentence already says what happened in this app's words.
   */
  /*
   * ⚠ **The `true` cell is the whole point, and its absence is why this passed
   * over a constant.** Every expected answer here was `false`, so
   * `return false;` at the top of the predicate satisfied the check — measured.
   * A partition asserted only on its negative side is not a partition.
   */
  check(
    "the installer's own output opens by itself, and only where the sentence is the generic one",
    [
      rawInstallIsOpen(null),
      rawInstallIsOpen({ done: false, outcome: "running" } as never),
      rawInstallIsOpen({ done: false, outcome: "failed" } as never),
      rawInstallIsOpen({ done: true, outcome: "installed" } as never),
      rawInstallIsOpen({ done: true, outcome: "failed" } as never),
    ],
    [false, false, false, false, true],
  );
  /*
   * And that the arm is reachable from a *settled* run: these are every outcome
   * `settle()` can end on, so the one `true` above is not a state no daemon
   * produces — which is exactly what the old predicate asked for.
   */
  check(
    "every other settled outcome keeps its own sentence instead",
    (["installed", "locked", "timeout", "cancelled", "spawn_failed"] as const).map((one) =>
      rawInstallIsOpen({ done: true, outcome: one } as never),
    ),
    [false, false, false, false, false],
  );

  /* ---------------------------------------------------------------- *
   * The client's own mirror of the daemon's transcript ceiling
   * ---------------------------------------------------------------- */
  /*
   * ⚠ **Bounded on the daemon and unbounded on the client is what this is
   * about.** The card's poll appended every chunk to one React state string and
   * handed it to a `<pre>` child each tick, so the text node was rebuilt from the
   * whole history every 700ms — O(total) per poll, O(n²) over a run — and what
   * kept that survivable is an accident: `deploy/agents.sh` sends the vendor
   * installers' output to `/dev/null`. A chatty installer removes the bound.
   */
  check(
    "the client keeps the tail of a long transcript and the whole of a short one",
    [
      keepInstallTail("abc"),
      keepInstallTail("x".repeat(MAX_INSTALL_OUTPUT_CHARS)).length,
      keepInstallTail(`head${"x".repeat(MAX_INSTALL_OUTPUT_CHARS)}`).length,
      // The head is what goes, and this is the assertion that says which end:
      // a `slice(0, MAX)` satisfies every length above and keeps the wrong half.
      keepInstallTail(`head${"x".repeat(MAX_INSTALL_OUTPUT_CHARS)}`).startsWith("head"),
      keepInstallTail(`head${"x".repeat(MAX_INSTALL_OUTPUT_CHARS)}`).endsWith("x"),
    ],
    ["abc", MAX_INSTALL_OUTPUT_CHARS, MAX_INSTALL_OUTPUT_CHARS, false, true],
  );
  /*
   * ⚠ **Against the daemon's own constant, read as text.** The two numbers are
   * meant to be one — this is the most `GET /agent-install/runs/:id` will ever
   * hand out — and `packages/web` may not import from `src/`, so a restated
   * number with nothing comparing them is exactly what drifts. Parsed as a
   * product rather than string-matched, so `65536` and `64 * 1024` are the same
   * answer.
   */
  const daemonInstall = stripComments(
    readFileSync(new URL("../../../src/agentinstall.ts", import.meta.url), "utf8"),
  );
  const ceiling = /MAX_OUTPUT_BYTES = ([^;]+);/.exec(daemonInstall)?.[1] ?? "";
  const factors = ceiling.split("*").map((part) => Number(part.trim()));
  report(
    "the daemon's own ceiling was found to compare against",
    ceiling.length > 0 && factors.every((one) => Number.isFinite(one)),
    `MAX_OUTPUT_BYTES = ${ceiling.trim()}`,
  );
  check(
    "and the client keeps exactly what the daemon will ever hand out",
    factors.reduce((product, one) => product * one, 1),
    MAX_INSTALL_OUTPUT_CHARS,
  );

  /* ---------------------------------------------------------------- *
   * The route with no caller
   * ---------------------------------------------------------------- */
  /*
   * ⚠ **A served, documented, counted route that nothing called, for a
   * release.** `GET /agent-install` is the only thing that can tell a tab about
   * the run this machine is already holding — there is one daemon-wide, and both
   * Install surfaces tracked their own: `AgentsPanel` in `sessionStorage` keyed
   * per machine *and* agent, `MachineAgentsSection` in component state a remount
   * threw away. `DaemonClient.liveInstall` was declared, docblocked and listed in
   * `docs/API.md`, and `grep` found nothing but the declaration.
   *
   * **The assertion is the callers, not the declaration**, so the declaring file
   * is excluded: a method nothing calls is the defect, and a census of *files
   * that call it* is the only shape that can see it. Named rather than counted —
   * a floor of two is satisfied by two calls in one screen.
   */
  const callers = srcFiles().filter(
    (rel) => rel !== "daemon.ts" && /liveInstall\(/.test(stripComments(srcFile(rel))),
  );
  check(
    "both screens that draw a run ask the machine what it is already running",
    callers.sort(),
    ["ui/settings/AgentsPanel.tsx", "ui/settings/MachineAgentsSection.tsx"],
  );

  /* ---------------------------------------------------------------- *
   * The jargon floor, through `agentCard`'s own regex
   * ---------------------------------------------------------------- */
  const sentences: string[] = [];
  for (const outcome of ["running", "installed", "failed", "locked", "timeout", "cancelled", "spawn_failed"] as const) {
    const line = installFailure(outcome, "Claude Code");
    if (line !== null) sentences.push(line);
  }
  for (const result of ["checking", "installed", "notInstalled", "unreachable"] as const) {
    const line = installResultLine(result, "Claude Code");
    if (line !== null) sentences.push(line);
  }
  for (const phase of ["download", "install", "link"] as const) {
    const line = installStep(phase);
    if (line !== null) sentences.push(line);
  }
  sentences.push(stanceLine({ id: "claude" }, "not_installed", false, "darwin", true) ?? "");
  report("there are sentences to sweep", sentences.length > 10, `${sentences.length} sentences`);
  check(
    "nothing this flow can say is written for a developer",
    sentences.filter((line) => JARGON_WORDS.test(line)),
    [],
  );
  /*
   * The screen-line cap, the same fourteen words `agentCard`'s sentences are held
   * to. A person reading this is holding a phone.
   */
  const words = (text: string): number => text.trim().split(/\s+/).length;
  check("and none of it runs past a screen line", sentences.filter((line) => words(line) > 14), []);

  /* ---------------------------------------------------------------- *
   * Placements, which no value can hold
   * ---------------------------------------------------------------- */
  const panel = stripComments(
    readFileSync(new URL("../src/ui/settings/AgentsPanel.tsx", import.meta.url), "utf8"),
  );
  /*
   * ⚠ **One call decides the slot, and the negative is on the file it is about.**
   * A private ladder written in different words satisfies every negative there
   * is, which is the lesson `webcheck.agent-card.ts` already records — so the
   * positive has to be here too.
   */
  check(
    "one call decides which control the card draws",
    [
      panel.includes("primaryControl({"),
      /*
       * The *chain* is what had to go, not every mention of a stance: the slot
       * used to be `wizard ? … : stance === "signed_in" ? … : canSignIn ? … :
       * null`, and its final arm is where a harness that is not installed landed
       * with nothing drawn. One arm of the switch still reads `stance` — the
       * sentence a signed-in harness with no sign-out command owes — so the
       * negative is anchored on the chain's own middle, which cannot survive the
       * rewrite.
       */
      /\) : canSignIn \? \(/.test(panel),
      // And nothing decides a control from `available` inline any more: that
      // test is inside `primaryControl`, via the stance, where it can be swept.
      /agent\.available \?/.test(panel),
    ],
    [true, false, false],
  );
  /*
   * ⚠ **`=== true`, never `!== false`, and the counter-example is twelve lines
   * from it.** `login.canSignOut !== false` is deliberate: that control's refusal
   * is a `503` carrying the route's own sentence, so offering it costs a clean
   * error. `installable`'s refusal on an older daemon is a bare `404` with no
   * envelope — nothing to render. Somebody will try to make the two match, and
   * this is the only place that fact exists.
   */
  // `srcFiles()` answers paths relative to `src/`; `srcFile` is the reader that
  // resolves them, and reaching for `readFileSync` directly is how this crashed
  // on `App.tsx` the first time.
  const loose = srcFiles().filter((rel) => /installable\s*!==\s*false/.test(stripComments(srcFile(rel))));
  check("and installable is never read the way canSignOut is", loose, []);
  report(
    "the sweep looked at both authored trees",
    srcFiles().length > 100,
    `${srcFiles().length} files`,
  );

  /* ---------------------------------------------------------------- *
   * One slot, several writers: the clear that has to compare
   * ---------------------------------------------------------------- */
  /*
   * ⚠ **`sessionStorage` holds one install id per (machine, agent) and three
   * call sites in this one component write it**, so the id a pane is polling is
   * not always the id stored. Three *sites*, not three surfaces: the sweep 120
   * lines up has it right — `MachineAgentsSection` keeps its run in component
   * state and names no key at all (zero `storage` occurrences in the file). It
   * used to be able to start a run this key never learned about, which was the
   * hazard rather than a fourth writer; it starts none now and only adopts one
   * (Q3.640), so every run is started by the card that writes this key. A pane seeded from a stale key — Hide while a run was going, then the
   * daemon's ten-minute sweep — polls an id that `404`s, and by then the card's
   * live-run adoption may have written down a *newer* run's id; a clear by
   * (machine, agent) at that moment deletes the live run's only reattachment
   * point, and the next press meets `409 install_busy` about a run nothing is
   * watching. `forgetInstallIf` is the comparison, and the census is on its
   * **callers**: a bare clear re-added inside a component is the defect, and
   * nothing typed can see it.
   */
  const declaredAt = (source: string): { at: number; name: string }[] =>
    [...source.matchAll(/^(?:export )?function (\w+)/gm)].map((one) => ({
      at: one.index ?? 0,
      name: one[1] ?? "",
    }));
  const panelFns = declaredAt(panel);
  const inside = (at: number): string => panelFns.filter((one) => one.at <= at).at(-1)?.name ?? "";
  const clears = [...panel.matchAll(/\bforgetInstall\(/g)].map((one) => inside(one.index ?? 0));
  report("the install slot is cleared somewhere", clears.length > 0, `${clears.length} sites`);
  check(
    "and nothing clears it without comparing the id first",
    [...new Set(clears)].sort(),
    ["forgetInstall", "forgetInstallIf"],
  );
  /*
   * ⚠ **And the key reaches storage in three functions, which is the whole of
   * why the `try` is written once.** A fourth place naming `installKey` is a
   * fourth place that has to survive a private window. The docblock there used to
   * count its readers and writers and was wrong about both halves one release
   * later, so what stands in for the number is this census.
   */
  const keyed = [...panel.matchAll(/\binstallKey\(/g)].map((one) => inside(one.index ?? 0));
  report("the install key is built somewhere", keyed.length > 0, `${keyed.length} sites`);
  check(
    "and only the three storage helpers and the in-flight map name it",
    [...new Set(keyed)].sort(),
    ["forgetInstall", "heldInstall", "installKey", "rememberInstall", "startInstall"],
  );

  /*
   * ⚠ **The list starts no run, and its way to the card is inside the kebab.**
   * It had an Install of its own that ran with no output behind a row that could
   * say one word about it; that went when the card became this screen's leaf
   * (Q3.640), so the card is the one surface that starts a run and this list only
   * adopts one. What replaced it is a navigation, and it is inside the menu for
   * the reason the Install was: a row that grows a control moves every row beside
   * it, and a drag measures one row at `pointerdown` and applies that number to
   * all of them — which is why `agent-strip.md` makes this a correctness claim
   * rather than a preference.
   */
  const section = stripComments(
    readFileSync(new URL("../src/ui/settings/MachineAgentsSection.tsx", import.meta.url), "utf8"),
  );
  const menuAt = section.indexOf("<Menu");
  check(
    "the list starts no run of its own, and its way to the card is inside the row's one menu",
    [
      menuAt >= 0,
      section.indexOf("agentSetupPath(machineId, behind.id)") > menuAt,
      /\.startInstall\(/.test(section),
    ],
    [true, true, false],
  );
  check(
    "and the row's reserved widths did not move",
    [section.includes('className="inline-flex w-4 shrink-0 justify-center"'), section.includes("w-5")],
    [true, true],
  );
  /*
   * ⚠ **The cursor contract, on the surface that draws no transcript.** This
   * screen polled `readInstall(installId, 0)` on a 1s interval and dropped
   * `chunk.chunk` — re-fetching the whole transcript every tick, up to the
   * daemon's 64 KiB ceiling per second through the E2EE tunnel, for a row that
   * renders one word and a clock. `InstallRunView.cursor` is documented on both
   * sides as "Total output produced so far. Poll with this as the next `since`",
   * and the card has always honoured it.
   *
   * The `report` is what keeps the negative honest: a regex that matches nothing
   * because the call was renamed would otherwise read as the property holding.
   */
  const reads = [...section.matchAll(/readInstall\(/g)].length;
  report("the strip screen still polls a run at all", reads > 0, `${reads} reads`);
  check(
    "and it threads the cursor rather than re-reading from zero",
    [/readInstall\([^)]*,\s*0\s*\)/.test(section), section.includes("chunk.cursor")],
    [false, true],
  );
  /*
   * And the strip's tiles did not get it: `offersTile` keeps `not_installed` off
   * the New session row, and an Install control inside a 112px tile in a strip
   * you drag sideways is the `Edit`-on-a-tile control that row already deleted.
   * Nor does anything under them any more: the disclosure that unfolded the card
   * there is gone (Q3.640), so the second half of this pair used to read `true`
   * for the door and reads `false` for the card now.
   */
  const newSession = stripComments(
    readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"),
  );
  /*
   * ⚠ **Sliced, not windowed — and the old anchor did not exist.** This was
   * `/AgentTile[^]{0,400}installable/` expecting `false`, and there is no
   * `AgentTile` anywhere in `packages/web/src`: the regex could not match, so the
   * `false` was green because its anchor was absent rather than because the tiles
   * were clean. The window was the second fault — the strip's body runs past
   * 50,000 characters, more than 130× the 400 it allowed, so even a correct
   * anchor would have asserted the distance rather than the property. The `report`
   * is what keeps the slice honest: an empty slice can no longer read as a pass.
   */
  const stripAt = newSession.indexOf("function AgentStrip(");
  const stripBody = stripAt < 0 ? "" : newSession.slice(stripAt, newSession.indexOf("\nfunction ", stripAt + 1));
  report("the strip's own body was isolated", stripBody.length > 0, `${String(stripBody.length)} chars`);
  check(
    "the tiles carry no install control, and nothing under them opens one",
    [/installable/.test(stripBody), /doorLabel\(|AgentDetail/.test(newSession)],
    [false, false],
  );
}
