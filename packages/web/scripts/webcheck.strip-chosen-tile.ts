import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { JARGON_WORDS } from "./webcheck.agent-card.js";
import { stripComments } from "./webcheck.source.js";
import type { AgentAvailability, AgentStripEntry, CustomAgent } from "../src/wire.js";

process.stdout.write("\nwhich tile the new-session strip may draw as chosen\n");
{
  // A stored choice is a claim about one machine, checked against the listing that answered, never a value to restore.
  const { offeredHere, stripEmpty, STRIP_EMPTY } = await import("../src/ui/NewSession.js");
  const { startsBare } = await import("../src/ui/agentCard.js");
  const { AGENT_IDS } = await import("../src/wire.js");
  const harness = (id: string, available: boolean): unknown => ({ id, available, version: null, path: null });
  const installed = [harness("claude", true), harness("codex", false)] as never;
  const presets = [{ id: "ca_1", name: "Kimi Code", harness: "claude", system: "moonshot", model: "m", createdAt: 0 }] as never;
  const pickHarness = { kind: "harness", id: "claude" } as const;
  const pickCustom = { kind: "custom", id: "ca_1" } as const;

  check("a harness the machine has installed is still offered", offeredHere(pickHarness, installed, presets), pickHarness);
  check("one it lists but has not installed is not", offeredHere({ kind: "harness", id: "codex" }, installed, presets), null);
  check("and one it has never heard of is not", offeredHere({ kind: "harness", id: "kimi" }, installed, presets), null);
  check("a preset this machine holds is still offered", offeredHere(pickCustom, installed, presets), pickCustom);
  check("one it does not hold is not", offeredHere({ kind: "custom", id: "ca_gone" }, installed, presets), null);
  const orphaned = [
    { id: "ca_2", name: "Codex thing", harness: "codex", system: "openai", model: "m", createdAt: 0 },
    { id: "ca_3", name: "Ghost", harness: "kimi", system: "moonshot", model: "m", createdAt: 0 },
  ] as never;
  check(
    "a preset whose harness is listed but not installed is not offered",
    offeredHere({ kind: "custom", id: "ca_2" }, installed, orphaned),
    null,
  );
  check(
    "nor one whose harness this machine has never heard of",
    offeredHere({ kind: "custom", id: "ca_3" }, installed, orphaned),
    null,
  );
  check("and nothing chosen offers nothing", offeredHere(null, installed, presets), null);

  const withOpencode = [harness("claude", true), harness("opencode", true)] as never;
  check(
    "exactly one harness this product ships is not a starting point on its own",
    AGENT_IDS.filter((id: string) => !startsBare({ id })),
    ["opencode"],
  );
  check(
    "and every other one is",
    AGENT_IDS.filter((id: string) => startsBare({ id })).length,
    AGENT_IDS.length - 1,
  );
  // A plugin-added harness is never a starting point, since its model cannot be known (Q3.522); driven with the stale field to prove it is unread.
  check(
    "a harness a plugin added is never a starting point on its own",
    [
      startsBare({ id: "acme:gemini" } as { id: string }),
      startsBare({ id: "acme:gemini", standalone: true } as unknown as { id: string }),
      startsBare({ id: "acme:gemini", standalone: false } as unknown as { id: string }),
    ],
    [false, false, false],
  );
  check(
    "and a built-in still answers from this product's own list",
    [startsBare({ id: "opencode" }), startsBare({ id: "claude" })],
    [false, true],
  );
  check(
    "and it consults nothing a manifest could have said",
    /standalone/.test(
      stripComments(readFileSync(new URL("../src/ui/agentCard.ts", import.meta.url), "utf8")),
    ),
    false,
  );
  check(
    "so a bare pick of it is not offered, however installed and available it is",
    offeredHere({ kind: "harness", id: "opencode" }, withOpencode, presets),
    null,
  );
  check(
    "while a preset assembled on it is offered exactly as any other is",
    offeredHere(
      { kind: "custom", id: "ca_oc" },
      withOpencode,
      [{ id: "ca_oc", name: "Big Pickle", harness: "opencode", system: "zen", model: "big-pickle", createdAt: 0 }] as never,
    ),
    { kind: "custom", id: "ca_oc" },
  );
  check(
    "and a listing that has not answered offers nothing at all",
    [offeredHere(pickHarness, null, presets), offeredHere(pickCustom, installed, null), offeredHere(pickHarness, null, null)],
    [null, null, null],
  );

  const { offersTile, agentStance: stanceOf } = await import("../src/ui/agentCard.js");
  check(
    "three states of six keep an agent out of the picker, and they are the ones that cannot start",
    (["not_installed", "start_refused", "no_login", "signed_in", "signed_out", "unchecked"] as const).map(
      (one) => [one, offersTile(one)],
    ),
    [
      ["not_installed", false],
      ["start_refused", false],
      ["no_login", true],
      ["signed_in", true],
      ["signed_out", false],
      ["unchecked", true],
    ],
  );
  // Read off source: a never arm leaves nothing at runtime to observe.
  check(
    "and it decides every state rather than defaulting to a tile",
    /export function offersTile\(stance: AgentStance\): boolean \{\s*switch \(stance\)/.test(
      readFileSync(new URL("../src/ui/agentCard.ts", import.meta.url), "utf8"),
    ),
    true,
  );
  check(
    "a harness a plugin added is an agent with nothing to sign in to, not one nobody could ask",
    [stanceOf(true, null, "no_flow"), stanceOf(true, null, undefined)],
    ["no_login", "unchecked"],
  );
  check("and it gets a tile", offersTile(stanceOf(true, null, "no_flow")), true);
  const signedIn = (id: string, loggedIn: boolean | null) => ({
    id,
    available: true,
    version: null,
    path: null,
    loggedIn,
  });
  const fleet = [signedIn("claude", true), signedIn("kimi", null), signedIn("codex", false)] as never;
  check(
    "a signed-in harness is offered, one that cannot say is offered, one that is signed out is not",
    [
      offeredHere({ kind: "harness", id: "claude" }, fleet, presets),
      offeredHere({ kind: "harness", id: "kimi" }, fleet, presets),
      offeredHere({ kind: "harness", id: "codex" }, fleet, presets),
    ],
    [{ kind: "harness", id: "claude" }, { kind: "harness", id: "kimi" }, null],
  );
  check(
    "while a preset on a signed-out harness is offered exactly as before",
    offeredHere(
      { kind: "custom", id: "ca_ok" },
      fleet,
      [{ id: "ca_ok", name: "GPT", harness: "codex", system: "openai", model: "m", createdAt: 0 }] as never,
    ),
    { kind: "custom", id: "ca_ok" },
  );
  check(
    "and the two rules do not stand in for each other",
    [
      startsBare({ id: "opencode" }) && offersTile(stanceOf(true, null, "no_flow")),
      startsBare({ id: "claude" }) && offersTile(stanceOf(true, false)),
    ],
    [false, false],
  );

  // Placement rules are read off comment-stripped source: this driver has no DOM or renderer, so it pins the line, not the behaviour.
  const newSessionSrc = stripComments(readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"));
  const builderSrc = stripComments(readFileSync(new URL("../src/ui/AgentBuilder.tsx", import.meta.url), "utf8"));
  const slice = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from);
    if (start === -1) return "";
    // A missing terminator must yield empty, or the slice runs to the end of the file and every negative assertion hits something else.
    const end = text.indexOf(to, start + from.length);
    return end === -1 ? "" : text.slice(start, end);
  };
  const sheet = slice(newSessionSrc, "export function StartSheet", "\nfunction NewSession");
  const chosenNow = slice(newSessionSrc, "const picked =", ";\n");
  const settled = slice(newSessionSrc, ".agents()", ".catch(");
  const adoption = slice(newSessionSrc, "const removed = takeRemoval(selected);", "}, [selected, agentsEpoch]);");
  const footer = slice(newSessionSrc, "<div className={SHEET_FOOT}>", "</div>\n    </div>");
  const strip = slice(newSessionSrc, "function AgentStrip(", "\nfunction MachineLine");
  const stripRow = slice(strip, 'className="flex w-max gap-2"', "</div>\n          </div>");
  // Anchored on the rail's own class string: the edge fade shares the shorter anchor.
  const stripRail = slice(strip, 'className="pointer-events-none mt-1 h-1"', "</div>");
  const stripFade = slice(strip, "ref={fade}", "/>");
  check(
    "every slice this section is about was actually found",
    [
      sheet,
      chosenNow,
      settled,
      adoption,
      footer,
      strip,
      stripRow,
      stripRail,
      stripFade,
      builderSrc,
    ].map((one) => one.length > 0),
    [true, true, true, true, true, true, true, true, true, true],
  );

  check("the trailing control is inside the row that scrolls", stripRow.includes("onConfigure"), true);
  check(
    "and the strip builds no path of its own into the builder",
    [strip.includes("agentEditPath"), strip.includes("agentPath(")],
    [false, false],
  );
  check("and it is an ordinary item you scroll to, not one painted at the edge", stripRow.includes("sticky"), false);
  // A non-passive listener, not a JSX wheel prop: React attaches that one passive and the preventDefault would be swallowed.
  check(
    "a wheel moves the row, non-passively, and hands the gesture back at the ends",
    [
      strip.includes('addEventListener("wheel"'),
      strip.includes("{ passive: false }"),
      strip.includes("if (next === box.scrollLeft) return;"),
    ],
    [true, true, true],
  );
  // The two widths the strip's arithmetic rests on (Q3.510).
  check(
    "the button is a 44px pill and the tiles are 112px, which is what the arithmetic is about",
    [stripRow.includes("min-h-16 w-11"), strip.includes("w-28")],
    [true, true],
  );
  check(
    "the strip draws the agents it filtered, and their tiles name a vendor rather than a status",
    [
      strip.includes("const shown = agents.filter(shownHere);"),
      stripRow.includes("{drawn.map((row) =>"),
      stripRow.includes("subline: harnessSubline(candidate.id, systems, candidate.contributedBy),"),
      strip.includes("agentBadge"),
    ],
    [true, true, true, false],
  );
  {
    const { harnessSubline } = await import("../src/agents.js");
    const { MAX_HARNESS_NAME_CHARS } = await import("../src/ui/agentCard.js");
    const systems = [
      { id: "anthropic", displayName: "Anthropic", nativeHarness: "claude" },
      { id: "openai", displayName: "OpenAI", nativeHarness: "codex" },
      { id: "openrouter", displayName: "OpenRouter", nativeHarness: "opencode" },
      { id: "zen", displayName: "OpenCode Zen", nativeHarness: "opencode" },
    ] as never;
    check(
      "a harness's line is the system that serves it",
      ["claude", "codex", "kimi"].map((one) => harnessSubline(one, systems)),
      ["Anthropic", "OpenAI", ""],
    );
    check(
      "and a harness with two of them takes the daemon's own order, every time",
      [harnessSubline("opencode", systems), harnessSubline("opencode", systems)],
      ["OpenRouter", "OpenRouter"],
    );
    check("and nothing is invented for a harness no system claims", harnessSubline("claude", [] as never), "");
    check(
      "while a harness a plugin added says where it came from",
      harnessSubline("acme:gemini", systems, { pluginName: "Acme Tools" }),
      "from Acme Tools",
    );
    check(
      "and a vendor still wins over that, where there is one",
      harnessSubline("claude", systems, { pluginName: "Acme Tools" }),
      "Anthropic",
    );
    check(
      "and the plugin's name is bounded the same way a harness's is",
      harnessSubline("acme:gemini", [] as never, { pluginName: "P".repeat(200) }).length,
      "from ".length + MAX_HARNESS_NAME_CHARS,
    );
  }
  check(
    "the row is one ordered map, and membership is still the filter's",
    [
      (stripRow.match(/\.map\(/g) ?? []).length,
      strip.includes("orderStrip("),
      strip.includes("const drawn = rows.filter((row) => !row.hidden);"),
    ],
    [1, true, true],
  );
  // A sibling rather than a mask: masking the scroll container would fade its scrollbar too.
  check(
    "the right-edge fade is an untouchable sibling with its transition in the stylesheet",
    [
      stripFade.includes("pointer-events-none"),
      stripFade.includes("absolute inset-y-0 right-0"),
      stripFade.includes("bg-gradient-to-l from-surface/70 to-transparent"),
      stripFade.includes("opacity"),
      strip.includes('edge.classList.toggle("is-cut"'),
    ],
    [true, true, true, false, true],
  );
  {
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    const edge = css.slice(css.indexOf(".edge-fade {"), css.indexOf(".edge-fade.is-cut"));
    const cut = css.slice(css.indexOf(".edge-fade.is-cut"));
    check(
      "the edge fade has both endpoints and comes in faster than it goes",
      [
        edge.length > 0 && edge.includes("opacity: 0;"),
        cut.slice(0, 120).includes("opacity: 1;"),
        cut.slice(0, 120).includes("transition-duration: 100ms;"),
        edge.includes("transition: opacity 500ms"),
      ],
      [true, true, true, true],
    );
  }
  // An empty row names its kind of empty and offers no install or sign-in door (Q3.640); rows are built the way NewSession builds them.
  {
    const { offersStripTile } = await import("../src/agents.js");
    const { orderStrip } = await import("../src/agentStrip.js");
    const listed = (id: string, over: Partial<AgentAvailability> = {}): AgentAvailability =>
      ({ id, available: true, loggedIn: true, version: null, path: null, ...over }) as AgentAvailability;
    const assembled = (id: string, harness: string): CustomAgent =>
      ({ id, name: id, harness, system: "moonshot", model: "m", createdAt: 0 }) as unknown as CustomAgent;
    const emptyFor = (
      agents: AgentAvailability[],
      presets: CustomAgent[] | null,
      stored: AgentStripEntry[] = [],
      over: { canConfigure?: boolean; failed?: boolean } = {},
    ): string | null =>
      stripEmpty({
        agents,
        presets,
        rows: orderStrip(
          [
            ...agents.filter(offersStripTile).map((one) => ({ kind: "harness" as const, id: one.id })),
            ...(presets ?? []).map((one) => ({ kind: "custom" as const, id: one.id })),
          ],
          stored,
        ),
        canConfigure: over.canConfigure ?? true,
        failed: over.failed ?? false,
      });
    const refused = { at: 0, routed: false, message: "no" };
    check(
      "every kind of empty is told apart, and each is the state it names",
      [
        // Nothing installed and nothing assembled: the ordinary first run.
        emptyFor([listed("claude", { available: false, installable: true }), listed("codex", { available: false })], []),
        // Installed and signed out: no row at all, weighed through `agents`.
        emptyFor([listed("claude", { loggedIn: false })], []),
        // Installed and refused to start, with nothing to probe.
        emptyFor([listed("codex", { loggedIn: null, lastStartRefusal: refused })], []),
        // Only a router, which is never a tile.
        emptyFor([listed("opencode", { loggedIn: null, login: { blocked: "no_flow" } as never })], []),
        // A preset on a harness that is gone, beside one installed and signed out.
        emptyFor(
          [listed("claude", { available: false }), listed("codex", { loggedIn: false })],
          [assembled("ca_1", "claude")],
        ),
        // Everything that could start is hidden.
        emptyFor([listed("claude")], [], [{ kind: "harness", ref: "claude", hidden: true }]),
        // The machine lists nothing.
        emptyFor([], []),
        // A daemon too old for the Agents screen, with agents that cannot start.
        emptyFor([listed("claude", { available: false })], [], [], { canConfigure: false }),
      ],
      ["not_set_up", "not_ready", "not_ready", "not_ready", "not_ready", "hidden", "none_listed", "too_old"],
    );
    check(
      "hidden means a hidden row that could start, and nothing else",
      [
        emptyFor(
          [listed("claude"), listed("codex", { available: false })],
          [assembled("ca_1", "codex")],
          [{ kind: "harness", ref: "claude", hidden: true }],
        ),
        emptyFor(
          [listed("codex", { available: false })],
          [assembled("ca_1", "codex")],
          [{ kind: "custom", ref: "ca_1", hidden: true }],
        ),
      ],
      ["hidden", "not_ready"],
    );
    const onRouter = (routed: boolean): AgentAvailability =>
      listed("opencode", {
        loggedIn: null,
        login: { blocked: "no_flow" } as never,
        lastStartRefusal: { at: 0, routed, message: "no" },
      });
    check(
      "a preset whose harness refused while routed cannot start, and one refused bare still can",
      [
        emptyFor([onRouter(true)], [assembled("ca_1", "opencode")]),
        offeredHere({ kind: "custom", id: "ca_1" }, [onRouter(true)], [assembled("ca_1", "opencode")]),
        emptyFor([onRouter(false)], [assembled("ca_1", "opencode")]),
        offeredHere({ kind: "custom", id: "ca_1" }, [onRouter(false)], [assembled("ca_1", "opencode")]),
      ],
      ["not_ready", null, null, { kind: "custom", id: "ca_1" }],
    );
    check(
      "and its tile is disabled for it, with the reason in the line and the label",
      [
        /const refused = !missing && runs\?\.lastStartRefusal\?\.routed === true;/.test(strip),
        /const why = missing \? "not installed" : refused \? "would not start" : null;/.test(strip),
        /disabled: why !== null,/.test(strip),
        /subline: why === null \? where : `\$\{ranBy\} \$\{why\}`,/.test(strip),
        /label: why === null\s*\?\s*`\$\{one\.name\}, \$\{ranBy\}, \$\{where\}`\s*:\s*`\$\{one\.name\}, \$\{ranBy\} \$\{why\}`,/.test(strip),
        /disabled: missing,/.test(strip),
      ],
      [true, true, true, true, true, false],
    );
    check(
      "and it says nothing while a read is out, after one failed, or when something can start",
      [
        emptyFor([listed("claude", { available: false })], null),
        emptyFor([listed("claude", { available: false })], [], [], { failed: true }),
        emptyFor([listed("claude")], []),
        emptyFor([listed("kimi", { loggedIn: null })], []),
        emptyFor([], [], [], { canConfigure: false }),
      ],
      [null, null, null, null, "none_listed"],
    );
    check(
      "three arms end in Agent settings, one in Check again, and an old daemon in nothing",
      Object.entries(STRIP_EMPTY).map(([key, one]) => [key, one.action]),
      [
        ["hidden", "settings"],
        ["not_set_up", "settings"],
        ["not_ready", "settings"],
        ["none_listed", "check_again"],
        ["too_old", null],
      ],
    );
    const lines = Object.values(STRIP_EMPTY).map((one) => one.line);
    check(
      "no empty sentence is written for a developer, names install or sign-in, or runs past a screen line",
      [
        lines.filter((line) => JARGON_WORDS.test(line)),
        lines.filter((line) => /install|sign[ -]?in|log[ -]?in/i.test(line)),
        lines.filter((line) => line.trim().split(/\s+/).length > 14),
      ],
      [[], [], []],
    );
  }
  check(
    "the empty state is decided once, over the default's own rows, and the strip only draws it",
    [
      /const empty =[\s\S]{0,120}stripEmpty\(/.test(newSessionSrc),
      /rows:\s*stripRows,/.test(newSessionSrc),
      /defaultRow\(stripRows,/.test(newSessionSrc),
      /failed:\s*agentsFailure !== null \|\| presetsFailure !== null/.test(newSessionSrc),
      /empty=\{empty\}/.test(newSessionSrc),
      /stripEmpty\(/.test(strip),
    ],
    [true, true, true, true, true, false],
  );
  check(
    "and under the row it is one sentence and one control, with nothing that unfolds",
    [
      /STRIP_EMPTY\[empty\]\.line/.test(strip),
      /<Button\s+onClick=\{onConfigure\}>\s*<Icon\s+as=\{Settings2\}\s+size=\{14\}\s*\/>\s*Agent settings\s*<\/Button>/.test(strip),
      /<Button\s+onClick=\{onChanged\}>\s*Check again\s*<\/Button>/.test(strip),
      (strip.match(/<Empty\b/g) ?? []).length,
      /aria-expanded/.test(strip),
    ],
    [true, true, true, 1, false],
  );
  check(
    "the row hides the browser's bar and draws one of its own",
    [
      strip.includes("no-scrollbar"),
      strip.includes("fade-scrollbar"),
      strip.includes("fade-thumb"),
      strip.includes('bar.classList.add("is-scrolling")'),
      strip.includes("SCROLLBAR_FADE_MS"),
      strip.includes("MIN_THUMB_PX"),
      strip.includes("bar.style.width"),
    ],
    [false, true, true, true, true, true, true],
  );
  check(
    "and the class comes off a moment after the last scroll, which is the fade",
    strip.includes('idle = setTimeout(() => bar.classList.remove("is-scrolling"), SCROLLBAR_FADE_MS);'),
    true,
  );
  check(
    "and it re-measures when either box changes size",
    [strip.includes("new ResizeObserver(layout)"), strip.includes("sizes.observe(row)")],
    [true, true],
  );
  check(
    "the bar is inert — no handler, no tab stop, no role",
    [/onClick|onPointer|onMouse|onKey|tabIndex|role=/.test(stripRail), stripRail.includes("ref={thumb}")],
    [false, true],
  );
  // Fades on opacity: the app-wide standard scrollbar properties override every webkit pseudo-element, and scrollbar colour does not interpolate.
  {
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    const box = css.slice(css.indexOf(".fade-scrollbar {"), css.indexOf(".fade-thumb {"));
    const bar = css.slice(css.indexOf(".fade-thumb {"), css.indexOf("}", css.indexOf(".fade-thumb.is-scrolling")));
    check(
      "the browser's bar is hidden and the app's own fades on opacity alone",
      [
        /scrollbar-width: none/.test(box),
        /::-webkit-scrollbar \{\n  display: none;/.test(box),
        /transition: opacity \d+ms/.test(bar),
        /(width|height|scrollbar-width):/.test(bar),
        /transition-duration: 0\.01ms !important/.test(css),
      ],
      [true, true, true, false, true],
    );
    check(
      "and it has two values to fade between: nothing at rest, the edge while moving",
      [/^\s*opacity: 0;$/m.test(bar), /is-scrolling \{\n  opacity: 1;/.test(css)],
      [true, true],
    );
    const held = /transition: opacity (\d+)ms/.exec(bar)?.[1] ?? "";
    const shown = /transition-duration: (\d+)ms/.exec(bar)?.[1] ?? "";
    check(
      "and it appears faster than it goes",
      [held.length > 0, shown.length > 0, Number(shown) < Number(held)],
      [true, true, true],
    );
  }
  check(
    "while the strip it was borrowed from keeps it",
    stripComments(readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8")).includes(
      "no-scrollbar",
    ),
    true,
  );

  // One pick per machine, held as a map in StartSheet because NewSession unmounts for the agent route.
  check(
    "the chosen tile is a map keyed by machine, held where the builder cannot unmount it",
    [
      /const \[picks, setPicks\] = useState<ReadonlyMap<MachineId, Picked>>\(/.test(sheet),
      /const picksRef = useRef<ReadonlyMap<MachineId, Picked>>\(/.test(sheet),
      /\btouchedOn\b/.test(newSessionSrc),
    ],
    [true, true, false],
  );
  // Ref before state: the listing's callback reads the ref at answer time.
  // Both positions are checked non-negative first, since a missing write's -1 would sort first.
  const refWrite = sheet.indexOf("picksRef.current = updated;");
  const stateWrite = sheet.indexOf("setPicks(updated);");
  check("a tap still writes the ref at all", refWrite >= 0, true);
  check("and still writes the state the render reads", stateWrite >= 0, true);
  check(
    "and the ref is written before the render that will carry it",
    refWrite >= 0 && stateWrite >= 0 && refWrite < stateWrite,
    true,
  );
  const choose = slice(newSessionSrc, "const choose = (machine", "\n  };");
  check("the tap handler was found", choose.length > 0, true);
  check(
    "and it copies the standing map rather than starting a new one",
    [
      /const updated = new Map\(picksRef\.current\);/.test(choose),
      /new Map\(\)/.test(choose),
      /\.clear\(\)/.test(choose),
    ],
    [true, false, false],
  );
  check(
    "and withdraws one machine's choice without touching the rest",
    [/updated\.delete\(machine\);/.test(choose), /updated\.set\(machine, next\);/.test(choose)],
    [true, true],
  );
  // The machine's default is a fallback, never written into the map, or it would be restored later as a tap nobody made.
  const drawn = chosenNow.replace(/\s+/g, " ");
  check(
    "what is drawn is this machine's pick, then this listing's default, each weighed against the listing",
    [
      /offeredHere\( selected === null \? null : \(picks\.get\(selected\) \?\? null\), agents, customAgents, hiddenHere, \)/.test(
        drawn,
      ),
      /\?\? offeredHere\( defaulted === null \? null : \{ kind: defaulted\.kind, id: defaulted\.id \}, agents, customAgents, hiddenHere, \)/.test(
        drawn,
      ),
    ],
    [true, true],
  );
  check(
    "including the hidden set, on both arms",
    (drawn.match(/hiddenHere/g) ?? []).length,
    2,
  );
  // The default is derived in render from the drawn row, so the listing's callback may not read picksRef again.
  check(
    "the default is derived from the drawn row rather than recorded from a listing",
    [
      /const stripRows =\s*customAgents === null/.test(newSessionSrc) &&
        /const defaulted =\s*stripRows === null/.test(newSessionSrc),
      newSessionSrc.includes("setDefaulted"),
      /picksRef\.current/.test(settled),
    ],
    [true, false, false],
  );
  const deriving = newSessionSrc.slice(newSessionSrc.indexOf("const stripRows ="), newSessionSrc.indexOf("const picked ="));
  check(
    "and it is the first row that row will draw",
    [
      deriving.length > 0,
      /orderStrip\(/.test(deriving),
      /defaultRow\(/.test(deriving),
      /\.find\(\(row\) => !row\.hidden\)/.test(deriving),
    ],
    [true, true, true, false],
  );
  // First row, not first non-hidden: a preset on a missing harness is listed and would be refused; the Agents screen shares defaultRow.
  {
    const paneSrc = stripComments(
      readFileSync(new URL("../src/ui/settings/MachineAgentsSection.tsx", import.meta.url), "utf8"),
    );
    check(
      "the marked default and the chosen default are the same call, over the same predicate",
      [
        /defaultRow\(\s*previewed,\s*\(row\) => startableHere\(row, listing\.agents, listing\.presets\),?\s*\)/.test(
          paneSrc.replace(/\s+/g, " "),
        ),
        /\(row\) => startableHere\(row, agents, customAgents\)/.test(newSessionSrc),
        /const previewed = drag === null \? rows : moveRow\(rows, drag\.from, drag\.to\);/.test(
          paneSrc,
        ),
      ],
      [true, true, true],
    );
    check(
      "and a row is told whether it is the default rather than working it out from its index",
      [
        /opensOn=\{opensOnKey === stripKey\(row\.kind, row\.id\)\}/.test(paneSrc),
        /opensOn && <Badge tone="strong">default<\/Badge>/.test(paneSrc),
        /index === 0/.test(paneSrc),
      ],
      [true, true, false],
    );
  }
  // Regex literals, never strings passed to the RegExp constructor: backslash-b in a JS string is a backspace.
  check(
    "and no value captured by that closure is consulted instead",
    [/picks\.get/, /picks\.has/, /\bpicks\b/, /touched/, /\bpicked\b/].filter((one) => one.test(settled)).map(String),
    [],
  );

  // Both hand-offs are taken in an effect: read during render, React's development double render would swallow one.
  check(
    "the strip takes both hand-offs, and it takes them in an effect",
    [/takeRemoval\(selected\)/.test(adoption), /takePick\(selected\)/.test(adoption), /useEffect\(\(\) => \{\s*if \(selected === null\) return;\s*const removed = takeRemoval/.test(newSessionSrc)],
    [true, true, true],
  );
  // Reads the ref: the pick being withdrawn may have been made in this very flush.
  check(
    "a removal withdraws only the standing pick it names",
    /const standing = picksRef\.current\.get\(selected\);\s*if \(standing\?\.kind === "custom" && standing\.id === removed\) onPick\(selected, null\);/.test(adoption),
    true,
  );
  check("and the builder is the thing that remembers one", /rememberRemoval\(machineId, going\);/.test(builderSrc), true);

  check(
    "Start is refused where nothing is chosen, in the button and again in the handler",
    [
      /disabled=\{busy \|\| selected === null \|\| cwd === null \|\| picked === null\}/.test(footer),
      /if \(picked === null\) \{\s*setError\("Choose an agent first\."\);/.test(newSessionSrc),
    ],
    [true, true],
  );
  check(
    "the footer asks for one while the listing settles, says there is none once it has, and neither after the agent read failed",
    /agents !== null && picked === null \? \(\s*agentsFailure !== null \? "" : empty !== null \? "no agent to start" : "choose an agent"/.test(footer),
    true,
  );
  check(
    "the tiles ask what was chosen, and nothing resolved on their behalf",
    [
      /picked: value\?\.kind === "harness" && candidate\.id === value\.id/.test(strip),
      /picked: value\?\.kind === "custom" && one\.id === value\.id/.test(strip),
    ],
    [true, true],
  );
}
