import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nthe order and the hidden set a machine remembers for its strip\n");
{
  /* ---------------------------------------------------------------- *
   * ⭐ The merge, which is the whole of what the daemon's strip means
   *
   * The daemon stores a **partial** record — a position and a switch for what
   * somebody actually moved or hid — and separately reports what it can start
   * right now. Neither is the row. `orderStrip` is the rule that turns the two
   * into one list, and its three clauses each close a state that is only
   * reachable when the fleet changes under a stored order: an agent deleted on
   * another device, a harness signed out for a week, an agent assembled since the
   * last time anybody opened the settings screen.
   *
   * Driven rather than read off disk, unlike the placements below: this is a pure
   * function over two lists, which is the shape this file prefers wherever it can
   * get it.
   * ---------------------------------------------------------------- */
  const { orderStrip, stripEntries, stripKey, moveRow, dropIndex, defaultRow } = await import(
    "../src/agentStrip.js"
  );
  const natural = [
    { kind: "harness", id: "claude" },
    { kind: "harness", id: "kimi" },
    { kind: "custom", id: "ca_1" },
  ] as never;
  const ids = (rows: readonly { kind: string; id: string }[]): string[] =>
    rows.map((row) => stripKey(row.kind as never, row.id));

  check(
    "an untouched machine draws its natural order, all of it visible",
    [ids(orderStrip(natural, [])), orderStrip(natural, []).every((row) => !row.hidden)],
    [["harness:claude", "harness:kimi", "custom:ca_1"], true],
  );
  check(
    "a stored order wins, and the store decides which are hidden",
    orderStrip(natural, [
      { kind: "custom", ref: "ca_1", hidden: false },
      { kind: "harness", ref: "kimi", hidden: true },
      { kind: "harness", ref: "claude", hidden: false },
    ] as never).map((row) => `${stripKey(row.kind, row.id)}${row.hidden ? " (hidden)" : ""}`),
    ["custom:ca_1", "harness:kimi (hidden)", "harness:claude"],
  );
  /*
   * ⚠ **A ref that resolves to nothing is dropped, and the daemon still holds the
   * row.** That asymmetry is the design: the position survives a harness being
   * signed out or a preset being unreadable on this build, and comes back with the
   * thing. What must never happen is the other direction — a tile drawn for an
   * agent that cannot be started, which is the state `offeredHere` exists against.
   */
  check(
    "a stored entry naming something the machine no longer offers is dropped",
    ids(
      orderStrip(natural, [
        { kind: "custom", ref: "ca_gone", hidden: false },
        { kind: "harness", ref: "codex", hidden: false },
        { kind: "harness", ref: "kimi", hidden: false },
      ] as never),
    ),
    ["harness:kimi", "harness:claude", "custom:ca_1"],
  );
  /*
   * ⚠ **A new agent goes last and is *visible*, and both halves are the assertion.**
   * Last, because the stored list is a total order over what existed when it was
   * written and inventing a position inside it would be this function having an
   * opinion nobody expressed. Visible, because an agent arriving already switched
   * off is indistinguishable from the daemon having lost it — the one default here
   * that would generate a bug report.
   */
  check(
    "an agent the store has never heard of is appended, and visible",
    orderStrip(natural, [{ kind: "harness", ref: "kimi", hidden: true }] as never).map(
      (row) => `${stripKey(row.kind, row.id)}${row.hidden ? " (hidden)" : ""}`,
    ),
    ["harness:kimi (hidden)", "harness:claude", "custom:ca_1"],
  );
  /*
   * ⚠ **A harness and an assembled agent sharing an id are two rows.** Nothing can
   * produce that collision today — a preset id is `ca_` plus eight hex and a
   * harness id is one word — and the key is what keeps it from being a thing to
   * remember, on either side of a rename.
   */
  check(
    "the two kinds are keyed apart",
    ids(
      orderStrip([{ kind: "harness", id: "x" }, { kind: "custom", id: "x" }] as never, [
        { kind: "custom", ref: "x", hidden: false },
      ] as never),
    ),
    ["custom:x", "harness:x"],
  );
  /*
   * ⚠ **A duplicate is drawn once.** The `PUT` route refuses one, so this cannot
   * arrive from this daemon — but the list also comes back from that route's echo
   * and from whatever a future build stores, and one agent drawn twice is two tiles
   * that select each other.
   */
  check(
    "a repeated entry draws one row",
    ids(
      orderStrip(natural, [
        { kind: "harness", ref: "kimi", hidden: false },
        { kind: "harness", ref: "kimi", hidden: true },
      ] as never),
    ),
    ["harness:kimi", "harness:claude", "custom:ca_1"],
  );
  /*
   * ⚠ **Every row is written back, including the ones nobody has touched.** That
   * is what makes the next read stable: an agent this screen has *seen* has a
   * position, so the one assembled after it cannot be drawn in front of it by
   * carrying an earlier `created_at`.
   */
  check(
    "the write-back carries every row and renames id to ref",
    stripEntries(orderStrip(natural, [])),
    [
      { kind: "harness", ref: "claude", hidden: false },
      { kind: "harness", ref: "kimi", hidden: false },
      { kind: "custom", ref: "ca_1", hidden: false },
    ],
  );

  /* ---------------------------------------------------------------- *
   * Moving a row
   *
   * ⚠ **Splice and never swap**, which is the difference the moment a drag crosses
   * more than one row: a swap leaves the list in an order nobody asked for, and it
   * makes the pointer and the keyboard disagree about what "move down" means. Out
   * of range answers a copy rather than throwing — the drag reports a position
   * measured from a pointer, and a pointer that has left the list is not an error.
   * ---------------------------------------------------------------- */
  const rows = orderStrip(natural, []);
  check("moving down splices rather than swaps", ids(moveRow(rows, 0, 2)), [
    "harness:kimi",
    "custom:ca_1",
    "harness:claude",
  ]);
  check("and moving up does the same in reverse", ids(moveRow(rows, 2, 0)), [
    "custom:ca_1",
    "harness:claude",
    "harness:kimi",
  ]);
  check("a move to where it already is changes nothing", ids(moveRow(rows, 1, 1)), ids(rows));
  check("a target past the end lands on the end", ids(moveRow(rows, 0, 99)), ids(moveRow(rows, 0, 2)));
  check("and a source that is not a row is a no-op", ids(moveRow(rows, 7, 0)), ids(rows));

  /*
   * ⚠ **Rounded, not truncated.** The row swaps when the dragged one is more than
   * half over its neighbour, which is where the eye expects it; truncation swaps a
   * full row late and reads as the list resisting the drag.
   */
  check(
    "a drag crosses a row at the halfway point",
    [
      dropIndex(0, 20, 56, 3),
      dropIndex(0, 29, 56, 3),
      dropIndex(0, 30, 56, 3),
      dropIndex(0, 900, 56, 3),
      dropIndex(2, -900, 56, 3),
    ],
    [0, 1, 1, 2, 0],
  );
  // A list that has not been measured yet cannot say where a pointer is, and
  // guessing would move a row on the first frame of every drag.
  check("an unmeasured row height moves nothing", dropIndex(1, 300, 0, 3), 1);

  /* ---------------------------------------------------------------- *
   * ⭐ Which row is the default, which is one rule read by two screens
   *
   * New session selects it when nobody has chosen; the Agents screen draws
   * **default** on it. Those are the same call — a badge naming a row the other
   * screen would skip is a confident claim about somewhere else that the reader
   * cannot check from where they are standing — so what is driven here is the
   * rule, and the two call sites are pinned as source text one section down.
   *
   * ⚠ **"First" is two narrowings past index 0, and each was a state on screen.**
   * A hidden row is one somebody took off New session and it keeps its place here,
   * so the list's first entry is routinely one that is not drawn. An unstartable
   * row is the same failure through the other door: the Agents list is deliberately
   * wider than the strip, and a preset is listed whatever state its harness is in.
   * Either one, defaulted onto, is a screen with nothing drawn as chosen and a dead
   * `Start`.
   * ---------------------------------------------------------------- */
  const { startableHere } = await import("../src/agents.js");
  const anyRow = (): boolean => true;
  const three = orderStrip(natural, []);
  /*
   * ⚠ **Null-tolerant, and `ids` is not.** These four sites all read the *answer*
   * of the function under test, and `null` is one of its answers — so wrapping it
   * in `ids` threw `Cannot read properties of null` out of `stripKey` and killed
   * the process where a FAIL was wanted. Measured: two single-character mutations
   * of `defaultRow`'s predicate — one deleted `!`, one added one — crashed the run
   * at this line and took **175** further checks with them, including the pane's
   * own file-wide ratchets (`danger`, `opacity`, the `harness`-in-a-`className`
   * sweep) and the whole model-catalogue section. A driver that dies on the
   * regression it is meant to name disables the rest of the net at the moment it
   * is needed, which is worse than the regression.
   */
  const idOf = (row: { kind: string; id: string } | null): string | null =>
    row === null ? null : stripKey(row.kind as never, row.id);
  check(
    "the default is the first row, where nothing is in the way",
    idOf(defaultRow(three, anyRow)),
    "harness:claude",
  );
  check(
    "a hidden first row is skipped rather than selected invisibly",
    idOf(
      defaultRow(
        orderStrip(natural, [{ kind: "harness", ref: "claude", hidden: true }] as never),
        anyRow,
      ),
    ),
    "harness:kimi",
  );
  check(
    "and so is one nothing could start",
    idOf(defaultRow(three, (row: { id: string }) => row.id !== "claude")),
    "harness:kimi",
  );
  /*
   * ⚠ **Both narrowings at once, and the answer is neither of the rows they
   * skipped.** Asserted together because a `find` written with one condition and
   * not the other passes every single-cause case above.
   */
  check(
    "a hidden row and an unstartable one are both stepped over",
    idOf(
      defaultRow(
        orderStrip(natural, [{ kind: "harness", ref: "claude", hidden: true }] as never),
        (row: { id: string }) => row.id !== "kimi",
      ),
    ),
    "custom:ca_1",
  );
  /*
   * ⚠ **`null` is a real answer and pointing at row 0 anyway is the one thing this
   * must not do.** A machine whose every agent is hidden, signed out or uninstalled
   * has no default, and inventing one is the state `offeredHere` would refuse a
   * line later — leaving `Start` live over a tile that is not drawn.
   */
  check(
    "a machine with nothing to start has no default at all",
    [
      defaultRow(three, () => false),
      defaultRow([], anyRow),
      defaultRow(
        orderStrip(natural, [
          { kind: "harness", ref: "claude", hidden: true },
          { kind: "harness", ref: "kimi", hidden: true },
          { kind: "custom", ref: "ca_1", hidden: true },
        ] as never),
        anyRow,
      ),
    ],
    [null, null, null],
  );

  /* ---------------------------------------------------------------- *
   * And the predicate the two screens hand it
   *
   * ⚠ **`startableHere` is `offeredHere` without the hidden test**, and the split
   * falls exactly there because hidden is the half that is not about startability
   * at all: the daemon would run a hidden agent perfectly, it simply has no tile.
   * The Agents screen draws hidden rows on purpose — un-hiding is what takes
   * somebody there — so it asks this one, and the two cannot disagree about
   * anything else because there is only one body.
   * ---------------------------------------------------------------- */
  const info = (id: string, available: boolean, loggedIn: boolean | null): unknown => ({
    id,
    available,
    loggedIn,
    version: null,
    path: null,
  });
  const machine = [
    info("claude", true, true),
    info("codex", true, false),
    info("kimi", false, null),
    info("opencode", true, true),
  ] as never;
  const built = [
    { id: "ca_ok", name: "on claude", harness: "claude", system: "moonshot", model: "m", createdAt: 0 },
    { id: "ca_dead", name: "on kimi", harness: "kimi", system: "moonshot", model: "m", createdAt: 0 },
  ] as never;
  check(
    "a harness is startable only where it is installed, signed in and a whole answer by itself",
    [
      startableHere({ kind: "harness", id: "claude" }, machine, built),
      startableHere({ kind: "harness", id: "codex" }, machine, built),
      startableHere({ kind: "harness", id: "kimi" }, machine, built),
      startableHere({ kind: "harness", id: "opencode" }, machine, built),
      startableHere({ kind: "harness", id: "nobody" }, machine, built),
    ],
    [true, false, false, false, false],
  );
  /*
   * ⚠ **A preset is only as startable as the harness under it, and this is the arm
   * the old `.find((row) => !row.hidden)` walked straight into.** `ca_dead` has a
   * row in the daemon's table and draws a tile — a disabled one, saying its harness
   * is not installed — so first in somebody's order it was the default, and
   * `POST /sessions` answers 503 for it.
   */
  check(
    "and a preset is weighed through its harness rather than only by existing",
    [
      startableHere({ kind: "custom", id: "ca_ok" }, machine, built),
      startableHere({ kind: "custom", id: "ca_dead" }, machine, built),
      startableHere({ kind: "custom", id: "ca_gone" }, machine, built),
    ],
    [true, false, false],
  );
  /*
   * ⚠ **Installed rather than signed in, on that arm alone.** An assembled agent
   * runs on the system's saved key — a different credential in a different table
   * from the CLI sign-in the bare arm weighs — so asking for a sign-in here would
   * refuse exactly the agents that need one least. `ca_signedout` is built on codex,
   * which is installed and signed out, and it starts.
   */
  check(
    "and an assembled agent on a signed-out harness still starts",
    startableHere({ kind: "custom", id: "ca_so" }, machine, [
      { id: "ca_so", name: "on codex", harness: "codex", system: "openai", model: "m", createdAt: 0 },
    ] as never),
    true,
  );
  /* ---------------------------------------------------------------- *
   * ⭐ And a harness that refused to open a session
   *
   * The reported defect: a harness a plugin added kept its tile after the machine
   * had been told it would not start. Its `loggedIn` is permanently `null` — there
   * is no status to probe — so the two arms above could never take the tile away,
   * and every press cost a worktree and a branch before the agent declined.
   *
   * ⚠ **The refusal axis reaches the preset arm and the credential axis still does
   * not, which is the pair that has to be asserted together.** The comment above
   * `ca_so` is unchanged and still true: an assembled agent runs on the *system's*
   * saved key, so a signed-out codex still starts one. A refused *start* is a
   * different fact — the harness declined to open a session at all — but only
   * where it was measured with routing already applied, because `applySystem` runs
   * before `session/new` and a **bare** refusal has told nobody anything about a
   * start that runs on somebody else's key.
   * ---------------------------------------------------------------- */
  const refused = (id: string, routed: boolean): unknown => ({
    id,
    available: true,
    loggedIn: null,
    login: { supported: false, blocked: "no_flow", needsInput: false, canSignOut: false },
    lastStartRefusal: { at: 1, routed, message: "it said no" },
  });
  /*
   * ⚠ **The `login` object is here for the first time in this whole block.** Every
   * other fixture omits it, so `no_flow` had never travelled through
   * `offersStripTile` → `startableHere` → `offeredHere` → `defaultRow` in one
   * piece — which is exactly the path the defect was on.
   */
  const plugged = [
    refused("byo:gemini", false),
    refused("byo:routed", true),
    { id: "byo:fine", available: true, loggedIn: null, login: { supported: false, blocked: "no_flow", needsInput: false, canSignOut: false } },
    // A built-in, because the bare-tile arm needs a harness that *can* have a tile
    // and no contributed one can any more — a plugin adds a harness, not an agent.
    { id: "claude", available: true, loggedIn: true },
    { ...(refused("codex", false) as object), loggedIn: true },
  ] as never;
  const onThem = [
    { id: "ca_bare", name: "on gemini", harness: "byo:gemini", system: "anthropic", model: "m", createdAt: 0 },
    { id: "ca_routed", name: "on routed", harness: "byo:routed", system: "anthropic", model: "m", createdAt: 0 },
  ] as never;
  check(
    "a harness that refused to start has no tile, however it was configured",
    [
      startableHere({ kind: "harness", id: "claude" }, plugged, onThem),
      startableHere({ kind: "harness", id: "codex" }, plugged, onThem),
    ],
    [true, false],
  );
  /*
   * ⚠ **And no contributed harness has a tile at all now**, refusal or none —
   * `startsBare` answers `false` for every one of them, so this arm is settled
   * before the refusal is even weighed. Asserted beside the arm above so the two
   * reasons a tile is absent cannot be confused for each other: one is a
   * measurement about a moment, the other is what a plugin may contribute.
   */
  check(
    "and one a plugin added has none in any state",
    [
      startableHere({ kind: "harness", id: "byo:fine" }, plugged, onThem),
      startableHere({ kind: "harness", id: "byo:gemini" }, plugged, onThem),
    ],
    [false, false],
  );
  /*
   * ⚠ **And the preset arm splits where the harness arm does not**, which is the
   * assertion that keeps one refusal from condemning a pairing it never tested. A
   * bare tile *is* a bare start, so any refusal takes it; a preset routed onto
   * somebody else's system is only condemned by a refusal that had already
   * survived `providers/set`.
   */
  check(
    "while a preset is only condemned by a refusal that routing did not save",
    [
      startableHere({ kind: "custom", id: "ca_bare" }, plugged, onThem),
      startableHere({ kind: "custom", id: "ca_routed" }, plugged, onThem),
    ],
    [true, false],
  );

  /*
   * ⚠ **A machine that has not spoken offers nothing.** Two `null` listings are the
   * loading state, and "yes, startable" over silence is the guess that put `Start`
   * live over a default nobody had checked.
   */
  check(
    "an unread listing is not a startable one",
    [
      startableHere({ kind: "harness", id: "claude" }, null, built),
      startableHere({ kind: "custom", id: "ca_ok" }, machine, null),
      startableHere({ kind: "custom", id: "ca_ok" }, null, built),
    ],
    [false, false, false],
  );

  /* ---------------------------------------------------------------- *
   * Where the two screens are
   *
   * ⚠ **Placements, so they are read off disk** — the idiom this file already uses
   * for the strip's own controls. What is pinned is not that the screens behave but
   * that the one line whose rewriting is the whole fix is still written that way:
   * the gear goes to the machine's Agents screen, and the acts the strip gave up
   * are on it.
   * ---------------------------------------------------------------- */
  const newSession = stripComments(
    readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"),
  );
  const pane = stripComments(
    readFileSync(new URL("../src/ui/settings/MachineAgentsSection.tsx", import.meta.url), "utf8"),
  );
  /* ---------------------------------------------------------------- *
   * ⭐ And the way back from a hidden tile
   *
   * `offersStripTile` takes a harness's tile away once the machine reports it
   * refused to open a session, so this screen is the only place it appears. What
   * it owes back is a control, and the control's whole subject is off-screen —
   * somebody ran the harness's own program on the machine, which reaches the
   * daemon in no way at all.
   *
   * Placements again, read off disk, because nothing typed can hold one.
   * ---------------------------------------------------------------- */
  check(
    "a refused harness can be asked again from the list that still holds it",
    [
      // Conditional on the fact the row is already reporting one line up, never on
      // the row's *kind*, which this screen may not use for a presentation.
      /behind\?\.lastStartRefusal != null && \(\s*<RowAction\s+label="Check again"/.test(pane),
      /*
       * ⚠ **Resolved for both kinds of row, which is the half that was missing.**
       * This list excludes every harness `startsBare` is false for — opencode, and
       * every one a plugin added — so those appear here *only*
       * through the presets built on them, and keying the control on the harness
       * row alone left it unreachable for exactly the harnesses whose remedy is
       * furthest away.
       */
      /const behind = harness \? info : \(listing\.agents\.find/.test(pane),
      // The harness's id, not the row's: on a preset row those differ and the
      // record is kept against the harness.
      /onRecheck\(behind\.id\)/.test(pane),
      /*
       * ⚠ **It patches the one row rather than re-reading the listing.** `attempt`
       * is `Try again`'s counter and it refetches `GET /agent-strip` with it —
       * drawn optimistically, possibly with a `PUT` in the air — so a blanket
       * re-read would put the pre-write order back under a finger that had just
       * moved a row. That button can afford it because it is only drawn when the
       * *read* failed.
       */
      /setListing\(\(held\) =>[\s\S]{0,400}one\.id === fresh\.id \? fresh : one/.test(pane),
    ],
    [true, true, true, true],
  );
  /*
   * ⚠ **And the card that *states* the refusal carries one too**, because the list
   * above cannot reach every harness that can be in this state. `AgentDetail` is
   * where `stanceLine` draws the sentence, and a sentence naming a remedy with no
   * control beside it is the dead end this whole state was hidden into.
   */
  check(
    "and so does the card that says so",
    /stance === "start_refused" && \(\s*<Button[\s\S]{0,400}recheckAgent\(agent\.id\)/.test(
      stripComments(readFileSync(new URL("../src/ui/settings/AgentsPanel.tsx", import.meta.url), "utf8")),
    ),
    true,
  );
  check(
    "and the verb it calls is the daemon's own re-check route",
    /recheckAgent\([\s\S]{0,200}\/agent-auth\/\$\{encodeURIComponent\(agent\)\}\/recheck/.test(
      stripComments(readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8")),
    ),
    true,
  );
  check(
    "the gear opens the machine's Agents screen, built by the one function that names it",
    [
      /onConfigure=\{\(\) => \{[\s\S]{0,400}?navigate\(agentStripPath\(selected\)\);/.test(newSession),
      newSession.includes("agentStripPath"),
    ],
    [true, true],
  );
  /*
   * ⚠ **And it makes the address whole before it leaves.** `/new` with no machine
   * is a real state — the rail's **All** tab navigates to it, and a cold link
   * reaches it — and the sync effect deliberately does not rewrite it, so the way
   * *back* from another pop-up is a `/new` that has forgotten the folder somebody
   * walked to and the tile they tapped. The `replace` is what makes this door
   * affordable at all; without it this is the pop-up-replacing-a-pop-up failure
   * that put the sign-in wizard inline, reintroduced by a different control.
   */
  check(
    "and it writes the machine and the folder into the address first",
    /navigate\(newPath\(selected, cwd \?\? undefined\), true\);\s*navigate\(agentStripPath\(selected\)\);/.test(
      newSession,
    ),
    true,
  );
  /*
   * ⚠ **Both doors into the builder are here now**, which is what the New session
   * screen's control count dropping from nine to eight has to mean. A count going
   * down is only good news if the acts moved rather than disappeared — the trap
   * `PluginsPanel`'s kebab assertion was written against — so this is the other
   * half of it.
   */
  check(
    "adding and editing an agent both live on that screen",
    [pane.includes("agentPath(machineId)"), pane.includes("agentEditPath(machineId, row.id)")],
    [true, true],
  );
  /*
   * ⚠ **Two controls on every row — a handle and a menu — and what varies is
   * *inside* the menu.** That is this screen's one layout rule and the reason the
   * split falls where it does: a row that loses a control moves every control
   * beside it, and on a list you drag that is the one thing that must not happen,
   * while a menu's panel is drawn on demand and displaces nothing.
   *
   * So the kebab is live on every row — hiding is the act every row has, including
   * a built-in harness, which is what "the delete option must be available for
   * Claude Code" turned out to mean — **and nothing switches it off, not even a
   * daemon that cannot store an order.** `frozen` used to disable the whole menu,
   * which took Edit and Check again with it, two items that never touch the strip
   * route; it now disables the one item that does, inside the panel. Read off the
   * kebab's own JSX — the slice from its glyph to its `onClick` — rather than off
   * the file, because `disabled={frozen}` legitimately survives on the handle and
   * on the Remove item.
   */
  const kebabAt = pane.indexOf("icon={MoreHorizontal}");
  check("the kebab was found", kebabAt > 0, true);
  const kebab = pane.slice(kebabAt, pane.indexOf("onClick={toggle}", kebabAt));
  check(
    "the kebab is live on every row, and not even an old daemon switches it off",
    [
      /disabled=/.test(kebab),
      /disabled=\{frozen \|\| harness\}/.test(pane.replace(/\s+/g, " ")),
      /\{!harness && \(/.test(pane),
    ],
    [false, false, false],
  );
  /*
   * What an old daemon *does* take away is the one item that writes the strip —
   * on the same line as the pinned label, so the two cannot come apart. The
   * other reason that item waits is `removing` (review D8): the row's confirm
   * closes on the tap that sends the `DELETE`, so without it the kebab was the
   * door to a second one before the first had answered.
   */
  check(
    "and only the item that writes the strip is what an old daemon disables",
    /label=\{row\.hidden \? "Add back" : "Remove"\}\s*disabled=\{frozen \|\| removing\}/.test(pane),
    true,
  );
  /*
   * The in-flight id is held one level up, keyed by row id — the listing
   * repaints under the row — set before the `DELETE` and cleared in `finally`,
   * since on failure the row stays and has to be tappable again. The confirm's
   * own Remove reads it too, for a confirm reopened during the flight.
   */
  /*
   * The line under the name is where a fault displaces the vendor — `not signed
   * in`, `would not start` — and it was the faintest ink on the row (review D9).
   * `muted` on a live row; a hidden row's line goes to `faint` with its name,
   * or the row's ground and its ink disagree about whether anything happened.
   */
  check(
    "the under line is muted on a live row and faint only with a hidden name",
    /truncate text-2xs \$\{row\.hidden \? "text-faint" : "text-muted"\}`\}>\s*\{under\}/.test(pane),
    true,
  );
  check("the remove in flight is one id, held above the rows", /const \[removing, setRemoving\] = useState<string \| null>\(null\);/.test(pane), true);
  const removeBody = pane.slice(pane.indexOf("const remove = (id: string): void => {"), pane.indexOf("const remove = (id: string): void => {") + 2000);
  check("set before the DELETE goes out", removeBody.indexOf("setRemoving(id);") > 0 && removeBody.indexOf("setRemoving(id);") < removeBody.indexOf(".removeCustomAgent(id)"), true);
  check("and cleared in finally, by id", /\.finally\(\(\) => setRemoving\(\(held\) => \(held === id \? null : held\)\)\)/.test(removeBody), true);
  check("each row is told whether it is the one", /removing=\{removing === row\.id\}/.test(pane), true);
  // The confirming pair is `TwoStep`'s (E7's review, Q3.552); `twoStep` is that
  // one element, and the row's `removing` reaches it as the act's refusal.
  // Where the element closes: its own `/>` on a line of its own, since a `<>…</>` fragment inside `question` carries a `/>` too.
  const twoStep = pane.slice(pane.indexOf("<TwoStep"), pane.indexOf("<TwoStep") + pane.slice(pane.indexOf("<TwoStep")).search(/^\s*\/>/m));
  check("and the confirm's Remove waits on it", pane.indexOf("<TwoStep") >= 0 && /disabled=\{removing\}/.test(twoStep) && /onAct=\{onRemove\}/.test(twoStep), true);
  /*
   * ⚠ **And both verbs are on both kinds now, which is the whole of "they must not
   * stand out".** Edit was absent from a built-in row on the argument that a
   * harness has nothing stored to edit — true, and the wrong conclusion: this list
   * holds *agents*, and the built-in one is the one that exists by default rather
   * than a different kind of thing. A row with fewer verbs than its neighbours is
   * exactly what made it look special.
   *
   * What "edit" can mean there is *start from it*: there is no row to `PATCH`, so
   * it opens the builder already pointed at the harness. That is the one branch
   * left, and it is on the destination rather than on whether the item is drawn.
   */
  check(
    "every row can be edited, and a built-in one opens the builder pointed at its harness",
    [
      /label="Edit"/.test(pane),
      /harness\s*\? agentFromHarnessPath\(machineId, row\.id\)\s*: agentEditPath\(machineId, row\.id\)/.test(
        pane.replace(/\s+/g, " "),
      ),
    ],
    [true, true],
  );
  /*
   * ⚠ **One removal per row, named the same *and drawn the same* on both kinds.**
   * It began as an eye button beside the kebab — three controls competing for the
   * right-hand end of a phone row, on a row that is also a drag target — then as
   * "Hide from New session" *beside* an assembled agent's "Remove agent", which is
   * two removals on one row and a harness that could only be hidden while
   * everything next to it could be removed. From the picker's side both acts are
   * the same one: this stops being offered.
   *
   * ⚠ **`danger` was the last thing that gave the two apart, and it is gone.** It
   * rode the assembled arm alone, to carry that one is `DELETE /custom-agents/:id`
   * while the other is a flag — which is exactly the internal difference this
   * screen is not meant to have an opinion about, and it was reported as one. It
   * was overclaiming on its own terms too: `danger` is for an act nothing brings
   * back, and this one is rebuildable from the bar at the foot of the same screen,
   * which is also why it has no confirmation.
   *
   * The negatives are the ratchet: no `danger` anywhere on this row's actions, no
   * eye button, no second removal.
   *
   * ⚠ **The `danger` negative is read off the row and not off the file, and it was
   * read off the file.** `StripEditor`'s own status line sets `text-danger` when a
   * reorder is *refused* — the one report a write gets, on a list that has already
   * jumped back under it — and a substring sweep over the whole module counted that
   * as the row wearing red. Scoping it to `StripRowView` is what keeps the ratchet
   * about the thing it is about; it stays a bare `danger` rather than the prop
   * alone, so a hand-rolled `text-danger` on a menu item fails it too.
   */
  const rowAt = pane.indexOf("function StripRowView");
  // A slice taken from a name that is not there passes every negative below while
  // asserting nothing at all, which is this driver's one failure mode — and
  // `indexOf` answering -1 makes `slice` return the last character rather than
  // nothing, so the position is what is checked and not the length.
  check("the row component was found", rowAt > 0, true);
  const rowSrc = pane.slice(rowAt);
  check(
    "there is one removal per row, named and drawn the same on both kinds",
    [
      /label=\{row\.hidden \? "Add back" : "Remove"\}/.test(pane),
      /danger/.test(rowSrc),
      /icon=\{row\.hidden \? EyeOff : Eye\}/.test(pane),
      /label="Remove agent"/.test(pane),
    ],
    [true, false, false, false],
  );
  /*
   * ⚠ **And no branch on the row's *kind* decides how anything looks.** The kind
   * still decides where a name is read from and where Edit navigates — those are
   * lookups and destinations, invisible either way. What it may not decide is
   * presentation, which is the property that kept being broken one control at a
   * time: first the kebab was disabled on a harness, then Edit was absent from it,
   * then Remove was red on everything else. Swept as a class-string property
   * rather than pinned at the one place it last went wrong.
   */
  check(
    "and the row's kind decides no presentation",
    [/danger=\{[^}]*harness/.test(pane), /className=\{[^}]*\bharness\b/.test(pane)],
    [false, false],
  );
  /*
   * ⚠ **A harness hides on one tap; an assembled agent asks first, in place, by
   * name.** The settings-row rule confirms acts nothing brings back, and hiding is
   * undone by `Add back` one tap away — so the harness arm still confirms nothing
   * (`onToggle` is called straight from the menu). Deleting an assembled agent is
   * a `DELETE` whose undo is a walk through the builder, so its arm opens the
   * row's own confirmation rather than calling `onRemove` from the menu: the menu
   * closes on the first tap, and a menu held open to hold a question would be a
   * second dismissable layer over the sheet.
   *
   * Three things about the pair. It **names the agent** — "Remove <name>?" with
   * where to rebuild it — because a question that names nothing is answered by
   * reflex. **Cancel is last** (Q3.218: a second tap on a laggy connection lands on
   * the undo) — `TwoStep`'s guarantee now, so what is pinned here is that the
   * act reaches it as a plain `Remove` with no `danger`, and that the row draws
   * no Cancel of its own. And it **holds the row's height** by the row's own
   * arithmetic — the sum of the name line and the subline the normal column
   * draws — which is the property the old confirmation broke: a drag measures
   * one row at `pointerdown` and applies it to every neighbour, so a taller
   * confirming row put an oversized step into `dropIndex`. The `danger` negative
   * one check up still covers this pair.
   */
  check(
    "an assembled agent's removal asks in place, by name, with Cancel last",
    [
      /if \(harness\) onToggle\(\);\s*else setConfirming\(true\);/.test(pane),
      /Remove <span className="font-medium">\{name\}<\/span>\? Rebuild it from Add an agent\./.test(twoStep),
      /act=\{\{ label: "Remove" \}\}/.test(twoStep) && !/setConfirming\(false\)/.test(pane),
    ],
    [true, true, true],
  );
  /*
   * ⚠ **The `2.5` above and below the question sit on the question, not on the
   * primitive's box.** The box also holds the two answers, and a 44px
   * coarse-pointer button padded by 2.5 on each side is 64px in a 60px row —
   * the exact arithmetic error this pin exists to catch, one element over.
   * `align="end"` is what puts the question in the name column and the answers
   * in the kebab's slot: the question grows from a zero basis, so it can never
   * wrap the answers onto a second line and grow the row that way either.
   */
  check(
    "and the question is drawn at the row's own height",
    [
      /h-\[calc\(var\(--text-sm--line-height\)\+var\(--text-2xs--line-height\)\)\]/.test(pane),
      /h-\[var\(--text-sm--line-height\)\]/.test(pane),
      /min-h-\[var\(--text-2xs--line-height\)\]/.test(pane),
      /<span className="my-2\.5 flex h-\[calc\(var\(--text-sm--line-height\)\+var\(--text-2xs--line-height\)\)\] items-center overflow-hidden">/.test(twoStep),
      /\bpy-2\.5\b/.test(twoStep),
      /align="end"/.test(twoStep),
    ],
    [true, true, true, true, false, true],
  );
  /*
   * ⚠ **44px of ink on the one control that now carries every act on the row.**
   * `md` is the size that does *not* reach the platform floor — 36px with no
   * growth mechanism — and it is also the prop's default, so this is one omitted
   * argument away at all times. `lg` is what the plugin machine table settled on
   * for a row's icons, for the same reason.
   */
  check("and it is drawn at the size a row's icon is drawn at", /size="lg"/.test(pane), true);
  /*
   * ⚠ **The drag is captured on the handle rather than listened for on `window`**,
   * which is `AppShell`'s `RailHandle` rule — the gesture belongs to the control it
   * started on, and the capture survives the pointer leaving the row, which it does
   * at once because the row is what is moving. `touch-none` is the other half:
   * without it a phone claims the vertical gesture for scrolling before
   * `pointermove` is ever delivered, and the row simply does not move.
   */
  check(
    "the drag is captured, keyboard-reachable, and does not fight the phone's scroller",
    [
      pane.includes("setPointerCapture(event.pointerId)"),
      /addEventListener\("pointermove"/.test(pane),
      pane.includes("touch-none"),
      pane.includes('event.key === "ArrowUp"'),
      pane.includes('event.key === "End"'),
    ],
    [true, false, true, true, true],
  );
  /*
   * ⚠ **A refused write puts back what the daemon last confirmed**, not what was on
   * screen one edit ago. Several writes can be in flight — the keyboard emits one
   * per key — so undoing just the failed one leaves a list that is neither what
   * somebody asked for nor what is stored, and the sequence guard is what stops an
   * early failure erasing a later success.
   */
  check(
    "a failed save restores the last confirmed order under a sequence guard",
    [
      pane.includes("setRows([...saved.current]);"),
      pane.includes("if (mine !== writes.current) return;"),
    ],
    [true, true],
  );
  /*
   * ⚠ **And the guard is two-sided, which it was not.** Refusing every answer but
   * the newest issued is right for what is *drawn* and wrong for the restore
   * target: with A confirmed and B in flight, A's success advanced nothing, and
   * B's failure then repainted the list as it stood **before A** while the daemon
   * held A. Two different questions — "may this repaint?" and "is this now what is
   * stored?" — and they take two different counters.
   */
  check(
    "and a success advances the restore target even when a newer write is in flight",
    [pane.includes("if (mine <= confirmed.current) return;"), pane.includes("confirmed.current = mine;")],
    [true, true],
  );
  /*
   * ⚠ **The writes are serialized, because ordering the answers is not ordering
   * the requests.** `PUT /agent-strip` replaces rather than merges, so order is the
   * whole of its meaning — and the keyboard emits one write per key. Two in flight
   * over a relay can be applied in either order, and the loser is the one this
   * client believes was superseded, with nothing reporting a disagreement.
   */
  check("and they are sent one after another", /queue\.current = queue\.current/.test(pane), true);
  /*
   * ⚠ **An empty list is only said to be an empty *machine* when the read worked**
   * — the rule `NewSession` keeps one screen over, and one this pane reintroduced
   * on its first draft: every failure arm sets an empty listing so the spinner
   * leaves, so a 503, a dead network or a daemon too old for the route each drew
   * "this machine reports no agents", the last one *beside* the sentence saying the
   * route is missing.
   */
  check(
    "an empty machine is said only where the read succeeded",
    /rows\.length === 0 && failure === null && supported/.test(pane),
    true,
  );
  /*
   * ⚠ **The rows animate only while a drag is live.** Clearing the transform and
   * reordering the keyed children happen in one commit, and a transition takes its
   * start value from the last style recalc — so a row left with
   * `transition-transform` would interpolate `translateY(±h) → none` over a layout
   * that has already moved by ∓h, overshooting a full row and sliding back on every
   * drop. With the class gone in the same commit there is nothing to interpolate.
   */
  /*
   * ⚠ **The row under the finger is never transitioned, and that was the whole of
   * "it moves very unsmoothly".** Its transform is rewritten on every pointer
   * event; with a 150ms `transition-transform` on it, each write started a fresh
   * interpolation from wherever the last had reached, so the row crawled after the
   * finger instead of following it. Only the neighbours animate, and only while a
   * drag is live — which is also what stops the overshoot at the drop, when the
   * transform clear and the keyed reorder land in one commit.
   */
  check(
    "the neighbours animate during a drag and the dragged row never does",
    [
      /sliding && !lifted \? "transition-transform" : ""/.test(pane),
      /className=\{`border-b border-edge transition-transform/.test(pane),
    ],
    [true, false],
  );
  /*
   * ⚠ **The phone fix, which is three things and not one.** The handle was a 32px
   * strip at the left edge of a row inside a sheet that scrolls: miss it and the
   * sheet moves, which is what "impossible to drag on a phone" is. So it is 44px
   * square; `press` came off it, because that class puts
   * `transform: scale(0.97)` on a button for as long as it is `:active` — an
   * entire drag — and a control that shrinks and stays shrunk reads as broken; and
   * the glyph is `pointer-events-none`, because `touch-action` is not inherited and
   * a touch beginning on the `<svg>` is a touch the engines are free to hand to the
   * scroller before they have walked up to the button carrying `touch-none`.
   */
  check(
    "the handle is a 44px target that cannot lose a touch to the scroller",
    [
      /className="tap inline-flex size-11 shrink-0 touch-none/.test(pane),
      /className="tap press inline-flex/.test(pane),
      /<Icon as=\{GripVertical\} size=\{18\} className="pointer-events-none" \/>/.test(pane),
      pane.includes("onLostPointerCapture={end}"),
    ],
    [true, false, true, true],
  );
  /*
   * ⚠ **And the second guard, because the first was dead on arrival and nothing
   * said so.** `touch-none` is a `@layer utilities` class; `index.css` carried
   * `button { touch-action: manipulation }` **unlayered**, and an unlayered rule
   * beats a layered one regardless of specificity — so the effective value on the
   * handle stayed `manipulation`, which permits panning, and a phone took every
   * drag for a scroll. A mouse is not gated by `touch-action` at all, which is why
   * it worked on a desktop and reported as "impossible on mobile".
   *
   * Two assertions, because two separate things had to be true: the base rule is
   * layered so the utility can win, and there is a mechanism that does not depend
   * on the cascade being right. React attaches `onTouchMove` passively — the fact
   * `AgentStrip`'s wheel handler is written out of — so the second one can only be
   * an `addEventListener`.
   */
  check(
    "a phone cannot take the drag for a scroll, by two mechanisms that do not share a cause",
    [
      /handle\.addEventListener\("touchmove", hold, \{ passive: false \}\)/.test(pane),
      /if \(live\.current === null\) return;\s*event\.preventDefault\(\);/.test(
        pane.replace(/\s+/g, " "),
      ),
    ],
    [true, true],
  );
  {
    /*
     * The cascade half, read off the stylesheet. What is asserted is not that the
     * declaration exists — it always did — but that it is **inside a layer**, which
     * is the whole of the difference between a utility that can override it and one
     * that cannot. The negative beside it is the general rule: a bare-element rule
     * left unlayered silently kills the matching utility everywhere.
     */
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    const layered = /@layer base \{\s*button \{\s*touch-action: manipulation;/.test(css);
    const bare = /\n button \{\n  touch-action/.test(css.replace(/\r/g, ""));
    check(
      "the button touch-action default is layered, so a utility can still win",
      [layered, bare],
      [true, false],
    );
  }
  /*
   * ⚠ **A hidden row is dimmed in place.** It keeps its position — that is the
   * thing you came to set, and taking it out of the list would take away the only
   * way to bring it back — so what says it is switched off is the ground and the
   * ink. Not `opacity`: it composites the whole row including the line explaining
   * what the row is, and this one still has to be read and pressed.
   */
  check(
    "a hidden row says so with a ground and an ink, and never with opacity",
    [/row\.hidden\s*\?\s*"bg-raised\/60"/.test(pane), /row\.hidden \? "text-faint"/.test(pane), /opacity/.test(pane)],
    [true, true, false],
  );
  /*
   * ⚠ **The handle is switched off by one thing only: a daemon that cannot store an
   * order.** It was also switched off while the row held a removal confirmation —
   * the drag measures one row's height off the row it started on, and that pair
   * lived inside the same `<li>`, so a drag begun there carried an oversized step
   * into `dropIndex`. The confirmation is back at the row's own height (pinned
   * above), and the handle stays mounted through it — its `touchmove` listener is
   * registered once for the component's life and a handle that unmounted would
   * come back without one — so nothing about a confirming row needs the handle
   * switched off.
   */
  check("the handle answers to the daemon and to nothing else", /disabled=\{frozen\}/.test(pane), true);
  /*
   * ⚠ **The status line sits under the list, with no height reserved** (13A). It
   * carried two reserved lines *above* the rows so a refused write could not push
   * them under a finger — and those two lines were blank on every healthy
   * machine's first paint, between the lede and the list. Under the rows the
   * only thing a sentence can displace is the `Add an agent` bar, so the reserve
   * is gone: an empty `<p>` has no line box, and the margin rides the text. The
   * `sr-only` move announcer is a second `role="status"` and is exempt from the
   * height test by being `absolute`; the first one in source order is the one
   * this is about.
   */
  const listAt = pane.indexOf('<ul className="mt-1 border-y border-edge">');
  const statusAt = pane.indexOf('role="status"');
  check("the status line was found, after the list", listAt > 0 && statusAt > listAt, true);
  check(
    "and it reserves no height until it has something to say",
    [
      /min-h-\[calc\(var\(--text-2xs--line-height\)\*2\)\]/.test(pane),
      /statusText === "" \? "" : "mt-2"/.test(pane),
      /scrollIntoView\(\{ block: "nearest" \}\)/.test(pane),
    ],
    [false, true, true],
  );
  /*
   * The lede at the screen-line cap: the name, the id, and the one rule the
   * `default` badge needs a reader to know. What removing costs left it for the
   * row that decides it.
   */
  check(
    "the lede says what the list is and which row is the default, and no more",
    [
      /\)\. The first that can start is the\{" "\}\s*<em>default<\/em>\./.test(pane),
      /Removing one signs nothing out/.test(pane),
    ],
    [true, false],
  );
  /*
   * At the screen-line cap since review D10 — fourteen, the name and the id one
   * each: "What New session offers on" was a word over it. And the caveat under
   * the list, for a daemon that cannot store an order, at the ten-word caveat
   * cap with its dash counted; read off the source rather than restated.
   */
  check("and opens on what the list is rather than on a question", /New session's agents on \{machine\.name\} \(/.test(pane), true);
  const tooOld = /supported \? "" : "([^"]+)"/.exec(pane)?.[1] ?? "";
  check("the old-daemon caveat names the fact and the remedy", /^Daemon too old to reorder agents — update it\.$/.test(tooOld), true);
  check("at the ten-word caveat cap, the dash counted", tooOld.length > 0 && tooOld.trim().split(/\s+/).length <= 10, true);
  /*
   * ⚠ **Removing an agent hands the removal to the strip whatever door it came
   * through, and the builder's copy of this was gated and permanently wrong.**
   * `agentPick.ts`'s standing pick is never taken, and this hand-off is the only
   * thing that clears it — so a removal that skipped it left `heldPick` naming a
   * row the daemon had dropped for the life of the tab, which suppresses the
   * default and leaves `Start` disabled on every later visit to New session.
   */
  {
    const builderSrc = stripComments(
      readFileSync(new URL("../src/ui/AgentBuilder.tsx", import.meta.url), "utf8"),
    );
    check(
      "a removal is handed off unconditionally, from both screens that can remove",
      [
        /rememberRemoval\(machineId, going\);/.test(builderSrc),
        /overlayKind\([a-z]+\) === "new"\) rememberRemoval/.test(builderSrc),
        /rememberRemoval\(machineId, id\);/.test(pane),
      ],
      [true, false, true],
    );
    /*
     * The *pick* keeps its gate, and the asymmetry is the whole of the rule: a
     * hand-off left behind fires on some later visit, and a pick is a thing
     * somebody would then be given without asking. A removal cannot be — an id
     * that has been deleted can never be a choice made again.
     */
    check(
      "while an assembly is handed off only when the way out is the strip",
      /if \(preset === null && overlayKind\(out\) === "new"\)/.test(builderSrc),
      true,
    );
    /*
     * ⚠ **The seed is weighed against the *listing* now, and it therefore waits —
     * which is a real change to this screen and is why the assertion moved rather
     * than being deleted.** It arrives off a URL, so a harness this machine does
     * not have must open the ordinary new-agent screen rather than one holding a
     * value nothing can resolve (`compatibility.md`'s rule 2, and the direction the
     * `edit` marker already fails in). That used to be answerable at mount, against
     * a closed union; which harnesses exist is a fact about the machine now, and a
     * *shape* test — the only thing this side could answer alone — would seed the
     * screen with a harness that is not there: a selected row, a raw id where a
     * name goes, and every model refused against something absent.
     *
     * ⚠ **So the two halves are pinned together and neither is enough alone.** The
     * state must start empty, or the address is trusted before it is checked; and
     * the effect must be guarded by a ref, or a re-read puts the address's harness
     * back over one somebody cleared — which is exactly the clobber `touched`
     * exists to prevent one component over, arriving through a different door.
     */
    check(
      "the builder does not trust the address until the machine has confirmed it",
      [
        /useState<AgentId \| null>\(null\);\s*const seeded = useRef\(false\)/.test(builderSrc),
        /if \(seed === null \|\| agents === null \|\| seeded\.current\) return;/.test(builderSrc),
        /agents\.some\(\(one\) => one\.id === seed\)\) setHarness\(seed\)/.test(builderSrc),
      ],
      [true, true, true],
    );
    /*
     * ⚠ **And the row it fills still does not wait, which is the property Q3.528's
     * own assertion cannot see.** That one compares two string indices — the
     * Harness field appearing above the Model field — and it goes on passing
     * whatever either row is gated on. What made the order worth having is that the
     * cheap question is answered while the expensive read runs, so what has to be
     * pinned is that the harness *rows* fall back rather than blocking: with the
     * listing still in flight the picker draws the four this product ships.
     */
    check(
      "and the harness rows fall back rather than waiting on that listing",
      /agents \?\? AGENT_IDS\.map\(\(id\) => \(\{ id \}\)\)/.test(builderSrc),
      true,
    );
  }
}
