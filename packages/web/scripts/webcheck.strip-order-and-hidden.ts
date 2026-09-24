import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nthe order and the hidden set a machine remembers for its strip\n");
{
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
  check(
    "an agent the store has never heard of is appended, and visible",
    orderStrip(natural, [{ kind: "harness", ref: "kimi", hidden: true }] as never).map(
      (row) => `${stripKey(row.kind, row.id)}${row.hidden ? " (hidden)" : ""}`,
    ),
    ["harness:kimi (hidden)", "harness:claude", "custom:ca_1"],
  );
  check(
    "the two kinds are keyed apart",
    ids(
      orderStrip([{ kind: "harness", id: "x" }, { kind: "custom", id: "x" }] as never, [
        { kind: "custom", ref: "x", hidden: false },
      ] as never),
    ),
    ["custom:x", "harness:x"],
  );
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
  check(
    "the write-back carries every row and renames id to ref",
    stripEntries(orderStrip(natural, [])),
    [
      { kind: "harness", ref: "claude", hidden: false },
      { kind: "harness", ref: "kimi", hidden: false },
      { kind: "custom", ref: "ca_1", hidden: false },
    ],
  );

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
  check("an unmeasured row height moves nothing", dropIndex(1, 300, 0, 3), 1);

  const { startableHere } = await import("../src/agents.js");
  const anyRow = (): boolean => true;
  const three = orderStrip(natural, []);
  // Null-tolerant, unlike ids: defaultRow may answer null, and a throw here would abort every later check.
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
  check(
    "and a preset is weighed through its harness rather than only by existing",
    [
      startableHere({ kind: "custom", id: "ca_ok" }, machine, built),
      startableHere({ kind: "custom", id: "ca_dead" }, machine, built),
      startableHere({ kind: "custom", id: "ca_gone" }, machine, built),
    ],
    [true, false, false],
  );
  check(
    "and an assembled agent on a signed-out harness still starts",
    startableHere({ kind: "custom", id: "ca_so" }, machine, [
      { id: "ca_so", name: "on codex", harness: "codex", system: "openai", model: "m", createdAt: 0 },
    ] as never),
    true,
  );
  const refused = (id: string, routed: boolean): unknown => ({
    id,
    available: true,
    loggedIn: null,
    login: { supported: false, blocked: "no_flow", needsInput: false, canSignOut: false },
    lastStartRefusal: { at: 1, routed, message: "it said no" },
  });
  const plugged = [
    refused("byo:gemini", false),
    refused("byo:routed", true),
    { id: "byo:fine", available: true, loggedIn: null, login: { supported: false, blocked: "no_flow", needsInput: false, canSignOut: false } },
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
  check(
    "and one a plugin added has none in any state",
    [
      startableHere({ kind: "harness", id: "byo:fine" }, plugged, onThem),
      startableHere({ kind: "harness", id: "byo:gemini" }, plugged, onThem),
    ],
    [false, false],
  );
  check(
    "while a preset is only condemned by a refusal that routing did not save",
    [
      startableHere({ kind: "custom", id: "ca_bare" }, plugged, onThem),
      startableHere({ kind: "custom", id: "ca_routed" }, plugged, onThem),
    ],
    [true, false],
  );

  check(
    "an unread listing is not a startable one",
    [
      startableHere({ kind: "harness", id: "claude" }, null, built),
      startableHere({ kind: "custom", id: "ca_ok" }, machine, null),
      startableHere({ kind: "custom", id: "ca_ok" }, null, built),
    ],
    [false, false, false],
  );

  const newSession = stripComments(
    readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"),
  );
  const pane = stripComments(
    readFileSync(new URL("../src/ui/settings/MachineAgentsSection.tsx", import.meta.url), "utf8"),
  );
  check(
    "a refused harness can be asked again from the list that still holds it",
    [
      /behind\?\.lastStartRefusal != null && \(\s*<RowAction\s+label="Check again"/.test(pane),
      /const behind = harness \? info : \(listing\.agents\.find/.test(pane),
      /onRecheck\(behind\.id\)/.test(pane),
      /setListing\(\(held\) =>[\s\S]{0,400}one\.id === fresh\.id \? fresh : one/.test(pane),
    ],
    [true, true, true, true],
  );
  // A faulty row leads to its harness's card from inside the menu (Q3.640); tokens are matched with whitespace classes so a reflow cannot break it.
  check(
    "a row whose agent cannot start opens that agent's card, from inside the menu",
    [
      /behind\s+!==\s+null\s+&&\s+\(badge\?\.tone\s+===\s+"strong"\s+\|\|\s+!behind\.available\s+\|\|\s+presetRefused\)\s+&&\s+\(\s*<RowAction\s+label=\{`Set up \$\{harnessName\(behind\)\}`\}/.test(
        pane,
      ),
      /navigate\(\s*agentSetupPath\(\s*machineId,\s+behind\.id\s*\)\s*\)/.test(pane),
      pane.indexOf("<Menu") > 0 &&
        pane.indexOf("agentSetupPath(machineId, behind.id)") > pane.indexOf("<Menu"),
      /onInstall/.test(pane),
      /\.startInstall\(/.test(pane),
    ],
    [true, true, true, false, false],
  );
  check(
    "and the card is a leaf of this screen, mounted untitled",
    [
      /<AgentDetail\s+key=\{`\$\{machineId\}:\$\{harness\}`\}\s+machineId=\{machineId\}\s+agentId=\{harness\}\s*\/>/.test(
        pane,
      ),
      /import\s+\{\s*AgentDetail\s*\}\s+from\s+"\.\/AgentsPanel"/.test(pane),
    ],
    [true, true],
  );
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
  check(
    "and it writes the machine and the folder into the address first",
    /navigate\(newPath\(selected, cwd \?\? undefined\), true\);\s*navigate\(agentStripPath\(selected\)\);/.test(
      newSession,
    ),
    true,
  );
  check(
    "adding and editing an agent both live on that screen",
    [pane.includes("agentPath(machineId)"), pane.includes("agentEditPath(machineId, row.id)")],
    [true, true],
  );
  // Read off the kebab's own JSX, because the handle and the Remove item legitimately carry a frozen disable.
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
  check(
    "and only the item that writes the strip is what an old daemon disables",
    /label=\{row\.hidden \? "Add back" : "Remove"\}\s*disabled=\{frozen \|\| removing\}/.test(pane),
    true,
  );
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
  // The TwoStep element ends at a self-closing tag on its own line; a fragment inside question carries one too.
  const twoStep = pane.slice(pane.indexOf("<TwoStep"), pane.indexOf("<TwoStep") + pane.slice(pane.indexOf("<TwoStep")).search(/^\s*\/>/m));
  check("and the confirm's Remove waits on it", pane.indexOf("<TwoStep") >= 0 && /disabled=\{removing\}/.test(twoStep) && /onAct=\{onRemove\}/.test(twoStep), true);
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
  // The danger negative is scoped to StripRowView: StripEditor's refused-reorder status line legitimately uses the danger tone.
  const rowAt = pane.indexOf("function StripRowView");
  // The position is what is checked: a slice from an indexOf of -1 passes every negative below while asserting nothing.
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
  check(
    "and the row's kind decides no presentation",
    [/danger=\{[^}]*harness/.test(pane), /className=\{[^}]*\bharness\b/.test(pane)],
    [false, false],
  );
  check(
    "an assembled agent's removal asks in place, by name, with Cancel last",
    [
      /if \(harness\) onToggle\(\);\s*else setConfirming\(true\);/.test(pane),
      /Remove <span className="font-medium">\{name\}<\/span>\? Rebuild it from Add an agent\./.test(twoStep),
      /act=\{\{ label: "Remove" \}\}/.test(twoStep) && !/setConfirming\(false\)/.test(pane),
    ],
    [true, true, true],
  );
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
  check("and it is drawn at the size a row's icon is drawn at", /size="lg"/.test(pane), true);
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
  check(
    "a failed save restores the last confirmed order under a sequence guard",
    [
      pane.includes("setRows([...saved.current]);"),
      pane.includes("if (mine !== writes.current) return;"),
    ],
    [true, true],
  );
  check(
    "and a success advances the restore target even when a newer write is in flight",
    [pane.includes("if (mine <= confirmed.current) return;"), pane.includes("confirmed.current = mine;")],
    [true, true],
  );
  check("and they are sent one after another", /queue\.current = queue\.current/.test(pane), true);
  check(
    "an empty machine is said only where the read succeeded",
    /rows\.length === 0 && failure === null && supported/.test(pane),
    true,
  );
  check(
    "a list with no rows says whether the machine has no agents or only ones that need a model",
    /listing\.agents\.length === 0\s*\?\s*"This machine reports no agents\."\s*:\s*"Every agent on this machine needs a model\. Add an agent to pick one\."/.test(
      pane,
    ),
    true,
  );
  {
    const missingAt = pane.search(/const presetMissing = preset !== null && \(behind === null \|\| !behind\.available\);/);
    const refusedAt = pane.search(
      /const presetRefused =\s*preset !== null && behind !== null && behind\.available && behind\.lastStartRefusal\?\.routed === true;/,
    );
    const underAt = pane.indexOf("const under = since !== null");
    const under = underAt < 0 ? "" : pane.slice(underAt, pane.indexOf(";", underAt));
    const missingArm = under.search(/presetMissing\s*\?\s*`\$\{harnessName\(behind \?\? \{ id: preset\.harness \}\)\} not installed`/);
    const refusedArm = under.search(/presetRefused\s*\?\s*`\$\{harnessName\(behind \?\? \{ id: preset\.harness \}\)\} would not start`/);
    const systemArm = under.indexOf("customAgentSubline(preset, listing.systems)");
    check(
      "a preset row says its harness is not installed or would not start, ahead of its system",
      [
        missingAt >= 0,
        refusedAt >= 0,
        under.length > 0,
        missingArm >= 0 && missingArm < refusedArm,
        refusedArm >= 0 && refusedArm < systemArm,
      ],
      [true, true, true, true, true],
    );
  }
  const watchAt = pane.indexOf("const watch = (");
  const watchBody = watchAt < 0 ? "" : pane.slice(watchAt, pane.indexOf("poll(cursor);", watchAt));
  check(
    "the install poll stops when the list is gone, at every step it can be on",
    [
      /const alive = useRef\(true\);/.test(pane),
      /useEffect\(\(\) => \{\s*alive\.current = true;\s*return \(\) => \{\s*alive\.current = false;\s*\};\s*\}, \[\]\);/.test(pane),
      watchBody.length > 0,
      (watchBody.match(/if \(!alive\.current\) return;/g) ?? []).length,
    ],
    [true, true, true, 3],
  );
  check(
    "the neighbours animate during a drag and the dragged row never does",
    [
      /sliding && !lifted \? "transition-transform" : ""/.test(pane),
      /className=\{`border-b border-edge transition-transform/.test(pane),
    ],
    [true, false],
  );
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
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    const layered = /@layer base \{\s*button \{\s*touch-action: manipulation;/.test(css);
    const bare = /\n button \{\n  touch-action/.test(css.replace(/\r/g, ""));
    check(
      "the button touch-action default is layered, so a utility can still win",
      [layered, bare],
      [true, false],
    );
  }
  check(
    "a hidden row says so with a ground and an ink, and never with opacity",
    [/row\.hidden\s*\?\s*"bg-raised\/60"/.test(pane), /row\.hidden \? "text-faint"/.test(pane), /opacity/.test(pane)],
    [true, true, false],
  );
  check("the handle answers to the daemon and to nothing else", /disabled=\{frozen\}/.test(pane), true);
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
  check(
    "the lede says what the list is and which row is the default, and no more",
    [
      /\)\. The first that can start is the\{" "\}\s*<em>default<\/em>\./.test(pane),
      /Removing one signs nothing out/.test(pane),
    ],
    [true, false],
  );
  check("and opens on what the list is rather than on a question", /New session's agents on \{machine\.name\} \(/.test(pane), true);
  const tooOld = /supported \? "" : "([^"]+)"/.exec(pane)?.[1] ?? "";
  check("the old-daemon caveat names the fact and the remedy", /^Daemon too old to reorder agents — update it\.$/.test(tooOld), true);
  check("at the ten-word caveat cap, the dash counted", tooOld.length > 0 && tooOld.trim().split(/\s+/).length <= 10, true);
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
    check(
      "while an assembly is handed off only when the way out is the strip",
      /if \(preset === null && overlayKind\(out\) === "new"\)/.test(builderSrc),
      true,
    );
    check(
      "the builder does not trust the address until the machine has confirmed it",
      [
        /useState<AgentId \| null>\(null\);\s*const seeded = useRef\(false\)/.test(builderSrc),
        /if \(seed === null \|\| agents === null \|\| seeded\.current\) return;/.test(builderSrc),
        /agents\.some\(\(one\) => one\.id === seed\)\) setHarness\(seed\)/.test(builderSrc),
      ],
      [true, true, true],
    );
    check(
      "and the harness rows fall back rather than waiting on that listing",
      /agents \?\? AGENT_IDS\.map\(\(id\) => \(\{ id \}\)\)/.test(builderSrc),
      true,
    );
  }
}

process.stdout.write("\nwhere the opening mode is explained\n");
{
  const pane = stripComments(
    readFileSync(new URL("../src/ui/settings/MachineAgentsSection.tsx", import.meta.url), "utf8"),
  );
  check(
    "the agents screen reads the provenance off the listing rather than fetching it",
    /listing\?\.agents\.find\(\(one\) => one\.id === "claude"\)\?\.settingsMode \?\? null/.test(pane),
    true,
  );
  check(
    "and draws it only when something is actually set",
    /settingsMode !== null && \(/.test(pane),
    true,
  );
  check("naming the setting and the file it came from", /permissions\.defaultMode/.test(pane) && /settingsMode\.file/.test(pane), true);
  const rowStart = pane.indexOf("function StripRowView(");
  check("the row's own component is where this is asserted", rowStart >= 0, true);
  const next = pane.indexOf("\nfunction ", rowStart + 1);
  const rowEnd = next === -1 ? pane.length : next;
  const rowRender = pane.slice(rowStart, rowEnd);
  // A floor, so a region that collapsed to nothing cannot satisfy an absence.
  check("which is a region big enough to be a component", rowRender.length > 2000, true);
  check("and it really is the row that draws the one-line subline", rowRender.includes("min-h-[var(--text-2xs--line-height)] truncate"), true);
  check("and never inside a row's one-line subline", rowRender.includes("settingsMode"), false);
}
