import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nwhich tile the new-session strip may draw as chosen\n");
{
  /*
   * ⚠ **A choice on this screen is about a *machine*, and none of it is
   * portable.** A harness is installed per machine and a preset is a row in that
   * machine's database, so a stored choice is a *claim* to be checked against the
   * listing that has actually answered rather than a value to restore. Every
   * state `offeredHere` rejects below was on screen at some point: a tile drawn
   * `aria-pressed` **and** `disabled` saying "not installed", beside a `Start`
   * that posted it anyway for a `503 agent_unavailable` or a `404`.
   *
   * Swept over the combinations rather than asserted at the one cell that was
   * wrong, because the rule is one function and three separate bugs were closed
   * by it: a harness chosen on a machine that has it and restored on one that
   * does not, a preset deleted in the builder, and a preset deleted on another
   * device where no hand-off exists to be told about it.
   */
  const { offeredHere } = await import("../src/ui/NewSession.js");
  const { startsBare } = await import("../src/ui/agentCard.js");
  const { AGENT_IDS } = await import("../src/wire.js");
  const harness = (id: string, available: boolean): unknown => ({ id, available, version: null, path: null });
  const installed = [harness("claude", true), harness("codex", false)] as never;
  const presets = [{ id: "ca_1", name: "Kimi Code", harness: "claude", system: "moonshot", model: "m", createdAt: 0 }] as never;
  const pickHarness = { kind: "harness", id: "claude" } as const;
  const pickCustom = { kind: "custom", id: "ca_1" } as const;

  check("a harness the machine has installed is still offered", offeredHere(pickHarness, installed, presets), pickHarness);
  /*
   * ⚠ **Available, not merely listed.** An uninstalled harness is drawn and
   * labelled on purpose — filtering it out answers "where did claude go" with
   * silence — and the tile's own `disabled` is what refuses it. A choice restored
   * onto one is the state that drew a tile pressed and disabled at once.
   */
  check("one it lists but has not installed is not", offeredHere({ kind: "harness", id: "codex" }, installed, presets), null);
  check("and one it has never heard of is not", offeredHere({ kind: "harness", id: "kimi" }, installed, presets), null);
  check("a preset this machine holds is still offered", offeredHere(pickCustom, installed, presets), pickCustom);
  check("one it does not hold is not", offeredHere({ kind: "custom", id: "ca_gone" }, installed, presets), null);
  /*
   * ⚠ **And one whose harness is gone is not either, which this arm did not ask.**
   * It weighed existence alone, so a preset assembled on a harness since
   * uninstalled stayed chosen with `Start` live and posted for a `503`. A preset
   * is a harness plus two more facts; it cannot be exempt from the rule two checks
   * up that decides whether anything can run at all. The second case is the
   * stronger one: a harness the listing has never heard of, which is what a
   * preset written on another machine's build looks like here.
   */
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

  /* ---------------------------------------------------------------- *
   * ⭐ A harness that is not a whole answer on its own
   *
   * Reported: "remove opencode from the defaults — it is not a standalone agent,
   * you have to pick a model for it." Three of the four harnesses *are* the model
   * — Claude Code runs Claude, Kimi Code runs Kimi, Codex runs GPT — and tapping
   * one is a complete decision. opencode is a router: started bare it picks
   * `opencode/big-pickle` off its own free tier, which is a model nobody chose
   * under a tile that names none.
   *
   * ⚠ This is **not** the "an unavailable harness stays, disabled, saying why"
   * rule two checks up. That one is about an agent the machine cannot run. This
   * one runs perfectly and has no answer for *which model* — and the control that
   * does is the `+` in the same row.
   * ---------------------------------------------------------------- */
  const withOpencode = [harness("claude", true), harness("opencode", true)] as never;
  /*
   * ⚠ **Swept over the union rather than listed**, for the reason this file gives
   * everywhere else it sweeps: a fifth harness has to arrive as a decision here
   * rather than as a silent `true`. What is pinned is the *count* and the member,
   * so adding one that is also a router is a green sweep and a red member check.
   */
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
  /*
   * ⭐ **And a harness a plugin added is never one — a plugin adds a harness, not
   * an agent.**
   *
   * It answered `standalone === true` off the manifest for a release, and that
   * field is gone. Spelling the default as "no tile" made the wrong answer rarer
   * without making it unsayable: the claim is the one thing in that manifest
   * nothing on either side can check, and an author writes `true` because their
   * harness feels like a whole answer to them. This predicate's subject is the
   * **model**, and a harness this product has never run cannot be known to be its
   * own — which is Q3.522's failure with somebody else's binary: a session billed
   * to the operator, on a model nobody chose, under a tile that names none, and
   * unlike opencode nothing here could find out afterwards what it ran.
   *
   * Driven with the field still present, because a manifest that carries it must
   * install unchanged and simply not be read — and because a reader that starts
   * consulting it again would otherwise pass.
   */
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
  /*
   * ⚠ **Read off the source as well, because a flat `false` is the shape that can
   * be re-derived by accident.** The daemon no longer sends the field and the wire
   * type no longer carries it, so a reader reaching for `agent.standalone` would
   * be reading `undefined` — falsy, therefore green, therefore silent — right up
   * until somebody restored the field on either side.
   */
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
  /*
   * ⚠ **Paired with a model it is offered like anything else**, which is the whole
   * distinction: what is refused is the *bare* harness, never the harness. A
   * preset assembled on it is a complete answer and this must not touch it.
   */
  check(
    "while a preset assembled on it is offered exactly as any other is",
    offeredHere(
      { kind: "custom", id: "ca_oc" },
      withOpencode,
      [{ id: "ca_oc", name: "Big Pickle", harness: "opencode", system: "zen", model: "big-pickle", createdAt: 0 }] as never,
    ),
    { kind: "custom", id: "ca_oc" },
  );
  /*
   * ⚠ **An unread listing offers nothing, and that is the deliberate half.**
   * `null` is the loading state, and answering "yes, still offered" over it would
   * be a guess about a machine that has not spoken — the guess that made `Start`
   * live over a default nobody had checked. The cost is that `Start` is disabled
   * for the beat before `GET /agents` answers, which is the beat the strip is a
   * spinner for.
   */
  check(
    "and a listing that has not answered offers nothing at all",
    [offeredHere(pickHarness, null, presets), offeredHere(pickCustom, installed, null), offeredHere(pickHarness, null, null)],
    [null, null, null],
  );

  /* ---------------------------------------------------------------- *
   * ⭐ A row of agents you can start, rather than a row of status reports
   *
   * Reported: "take *signed in* off Claude Code, Kimi Code and the rest — and they
   * should not be in the picker on the new session screen at all if they are not
   * signed in." Two halves of one rule, and the second is what makes the first
   * obvious: with every tile in the row startable, `signed in` is a fact true of
   * everything visible, and a fact true of everything identifies nothing.
   *
   * ⚠ This is **not** the "an unavailable harness stays, disabled, saying why"
   * rule, which this replaces on this screen and nowhere else: the settings card
   * still draws all five states with all five badges, because that screen is *about*
   * the states. What moved is which of them belongs in a picker.
   * ---------------------------------------------------------------- */
  const { offersTile, agentStance: stanceOf } = await import("../src/ui/agentCard.js");
  /*
   * ⚠ **Swept over all six states, and the three that stay are the point.**
   * `unchecked` is the load-bearing one: it is kimi's **permanent** answer —
   * `AGENT_LOGIN.kimi.status` is null, so `loggedIn` is never anything else — and
   * it is what claude answers when a probe times out. Hiding on it would delete
   * kimi from this screen on every machine in the fleet and make a slow probe look
   * like an uninstall. A sixth state has to arrive here as a decision.
   *
   * ⚠ **The sixth arrived, and it arrived as a decision only because `offersTile`
   * stopped being a negative allowlist.** It was
   * `stance !== "not_installed" && stance !== "signed_out"`, which answers a silent
   * `true` for anything it has not heard of — so `start_refused` would have kept
   * its tile, quietly, while the paragraph above claimed it could not. It is a
   * `switch` with a `never` arm now, which is `AgentGlyph`'s lesson in another
   * file: a default that reads as safe is not the same as a default that was
   * taken.
   */
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
  /*
   * ⚠ **And the predicate is exhaustive rather than an allowlist**, read off the
   * source because a `never` arm leaves nothing at runtime to observe. This is the
   * assertion that makes the paragraph above true of the *seventh* state as well.
   */
  check(
    "and it decides every state rather than defaulting to a tile",
    /export function offersTile\(stance: AgentStance\): boolean \{\s*switch \(stance\)/.test(
      readFileSync(new URL("../src/ui/agentCard.ts", import.meta.url), "utf8"),
    ),
    true,
  );
  /*
   * ⚠ **A harness a plugin added has to land on `no_login` and never on
   * `unchecked`, and the difference is a badge every machine in the fleet would
   * have carried.** It has no sign-in and no status probe — deliberately, per
   * `HarnessContribution` — so the daemon sends
   * `login: {blocked: "no_flow", …}` for it. With no `login` object at all,
   * `agentStance(true, null, undefined)` answers `unchecked`, whose badge reads
   * *cannot check*: a sentence about a probe that failed, drawn permanently over an
   * agent that runs perfectly. `no_flow` is the one reason in that vocabulary which
   * is a fact about the **agent** rather than about the host, which is exactly what
   * this is.
   */
  check(
    "a harness a plugin added is an agent with nothing to sign in to, not one nobody could ask",
    [stanceOf(true, null, "no_flow"), stanceOf(true, null, undefined)],
    ["no_login", "unchecked"],
  );
  check("and it gets a tile", offersTile(stanceOf(true, null, "no_flow")), true);
  /*
   * ⚠ **And a stored pick is weighed the same way**, which is the half that has
   * gone wrong every time this screen has changed what it draws: a pick of a
   * harness the row no longer draws leaves `Start` live over a row with nothing
   * selected in it. Signing out on the machine is a new way into exactly that
   * state, and it needs no second device to reach — the agent goes stale under a
   * tab that is already open.
   */
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
  /*
   * ⚠ **A preset is exempt, and deliberately.** An assembled agent is a harness
   * plus a system plus a model, and it starts on the *system's* saved key — a
   * different credential in a different table, and the one the daemon actually
   * checks. Hiding it because its CLI is signed out would hide the agents that
   * need a CLI sign-in least.
   */
  check(
    "while a preset on a signed-out harness is offered exactly as before",
    offeredHere(
      { kind: "custom", id: "ca_ok" },
      fleet,
      [{ id: "ca_ok", name: "GPT", harness: "codex", system: "openai", model: "m", createdAt: 0 }] as never,
    ),
    { kind: "custom", id: "ca_ok" },
  );
  /*
   * The two rules are independent and both are needed: opencode is perfectly
   * signed in and still has no tile, claude is a whole answer and still has none
   * while it is signed out. Neither implies the other, which is why the row asks
   * both through one function.
   */
  check(
    "and the two rules do not stand in for each other",
    [
      startsBare({ id: "opencode" }) && offersTile(stanceOf(true, null, "no_flow")),
      startsBare({ id: "claude" }) && offersTile(stanceOf(true, false)),
    ],
    [false, false],
  );

  /*
   * ⚠ **The rest of this rule is a *placement*, and nothing typed can hold one**,
   * so it is read off disk the way the plugin-settings and import-flow assertions
   * already are — comments off first, since the file argues against the shapes it
   * used to have by quoting them.
   *
   * ⚠ **What this proves and what it does not.** These are assertions about
   * *where a value is read from*, not about a value, and that is forced rather
   * than chosen: the defect below is a closure capture, which needs two renders
   * and a promise resolving between them to observe, and this driver has no DOM
   * and no React renderer. A source assertion cannot prove the screen behaves; it
   * proves the one line whose rewriting is the whole fix is still written that
   * way. `offeredHere` above is the half that *is* driven.
   */
  const newSessionSrc = stripComments(readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"));
  const builderSrc = stripComments(readFileSync(new URL("../src/ui/AgentBuilder.tsx", import.meta.url), "utf8"));
  const slice = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from);
    if (start === -1) return "";
    /*
     * ⚠ **A missing *terminator* is the failure this line exists for.** Without
     * it `indexOf` answers `-1`, `slice(start, -1)` returns the whole rest of the
     * file bar one character, and the found-guard below — which tests `length > 0`
     * — goes green over a slice that has quietly stopped being about anything.
     * Every negative assertion made over it then reports a hit from somewhere else
     * entirely. Measured: renaming the anchor this section ends at swallowed
     * `DirectoryPicker`'s two `disabled:opacity-40` buttons, 300 lines below, and
     * the failure named the agent strip.
     */
    const end = text.indexOf(to, start + from.length);
    return end === -1 ? "" : text.slice(start, end);
  };
  const sheet = slice(newSessionSrc, "export function StartSheet", "\nfunction NewSession");
  const chosenNow = slice(newSessionSrc, "const picked =", ";\n");
  const settled = slice(newSessionSrc, ".agents()", ".catch(");
  const adoption = slice(newSessionSrc, "const removed = takeRemoval(selected);", "}, [selected, agentsEpoch]);");
  const footer = slice(newSessionSrc, "<div className={SHEET_FOOT}>", "</div>\n    </div>");
  const strip = slice(newSessionSrc, "function AgentStrip(", "\nfunction MachineLine");
  // The same guard the section above states: a slice that came back empty is a
  // rename, and every assertion over it would pass while asserting nothing.
  const stripRow = slice(strip, 'className="flex w-max gap-2"', "</div>\n          </div>");
  /*
   * ⚠ **Anchored on the rail's own class string rather than on `<div aria-hidden
   * className="pointer-events-none`.** There are two such elements in this
   * component now — the bar, and the gradient at the row's cut edge — and the
   * shorter anchor found whichever came first in the file. The fade writes
   * `aria-hidden="true"` in full, which does not match the old anchor at all, so
   * this is belt and braces rather than the fix; the fix is that the anchor now
   * names something only one of the two carries.
   */
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

  /* ---------------------------------------------------------------- *
   * ⭐ The trailing control is the row's last item, not a thing pinned beside it
   *
   * Reported twice. It sat outside the scroller and overlapped the last tile;
   * asked for as an item in the row, refused once on arithmetic, and asked for
   * again — so it is inside now, and the docblock carries the cost rather than
   * the refusal. A source assertion because a placement has no type.
   *
   * ⚠ **What it opens changed and where it sits did not.** It was a `+` into the
   * builder; it is a gear into the machine's Agents screen, where adding is one of
   * four things on offer. The placement is the assertion either way — that is what
   * was reported twice — so this pins the control's slot and never its glyph.
   * ---------------------------------------------------------------- */
  check("the trailing control is inside the row that scrolls", stripRow.includes("onConfigure"), true);
  /*
   * ⚠ **And it is the *only* door out of this row**, which is what the `+`'s
   * removal has to mean rather than "the `+` was deleted". The Edit control that
   * hung under the strip went with it, so a grep for the builder's own path
   * builders answering nothing is the assertion that the screen kept exactly one
   * way to reach an agent's configuration — and that it is this one.
   */
  check(
    "and the strip builds no path of its own into the builder",
    [strip.includes("agentEditPath"), strip.includes("agentPath(")],
    [false, false],
  );
  /*
   * ⚠ **Not sticky, and that is an assertion rather than an omission.** It was
   * `sticky right-0` for one revision — inside the track, and painted at the
   * scrollport's right edge at every scroll position, so it still *looked* pinned.
   * That was the complaint, stated a third time. The row's last item is a row's
   * last item: you scroll to it.
   */
  check("and it is an ordinary item you scroll to, not one painted at the edge", stripRow.includes("sticky"), false);
  /*
   * ⚠ **The wheel handler is the half that makes any of this reachable with a
   * mouse**, and both details in it are the kind that fail silently. `passive:
   * false` is why it cannot be a JSX `onWheel` — React attaches that one passive,
   * so `preventDefault` is swallowed and the page scrolls instead — and the
   * non-trapping guard is what keeps a cursor resting over a 64px strip from
   * eating the page's own scroll at either end of the row.
   */
  check(
    "a wheel moves the row, non-passively, and hands the gesture back at the ends",
    [
      strip.includes('addEventListener("wheel"'),
      strip.includes("{ passive: false }"),
      strip.includes("if (next === box.scrollLeft) return;"),
    ],
    [true, true, true],
  );
  /*
   * ⚠ **The two widths the docblock's whole arithmetic rests on, and neither was
   * pinned.** `w-11` is where every recovered pixel of the third tile comes from
   * (Q3.510 took the `+` from 112px to 44), and `w-28` is the tile the row is
   * measured in. Both are load-bearing numbers written in a class string, which is
   * the one place a compiler cannot reach them.
   */
  check(
    "the button is a 44px pill and the tiles are 112px, which is what the arithmetic is about",
    [stripRow.includes("min-h-16 w-11"), strip.includes("w-28")],
    [true, true],
  );
  /*
   * ⚠ **The row is built from the filtered list, and the tile prints no status.**
   * Both halves read off disk for this section's stated reason — a placement and an
   * empty string are not values a driver can be handed — and both are the shape of
   * the report rather than its wording: one list, filtered once, and a line that is
   * blank rather than a line that is conditional. `agentBadge` is gone from this
   * file entirely, which is the assertion that says the words were removed rather
   * than hidden behind a flag.
   */
  check(
    "the strip draws the agents it filtered, and their tiles name a vendor rather than a status",
    [
      strip.includes("const shown = agents.filter(shownHere);"),
      stripRow.includes("{drawn.map((row) =>"),
      /*
       * ⚠ **And the *third* argument is pinned with it, because it is what keeps a
       * contributed harness from drawing a blank line.** A harness that is native
       * to no provider — the common case for one a plugin added, paired only with
       * built-in providers — answers `""` here, which is a tile with a title and
       * nothing under it beside tiles that have one. `contributedBy` is the honest
       * second answer, and passing it is the whole of the fix.
       */
      stripRow.includes("subline: harnessSubline(candidate.id, systems, candidate.contributedBy),"),
      strip.includes("agentBadge"),
    ],
    [true, true, true, false],
  );
  /*
   * ⚠ **The line under a harness tile has been three things and only the third
   * says anything.** It was `agentCard`'s badge, which on this row could only ever
   * print `signed in` — `shownHere` draws a tile solely for an agent something can
   * be started on — and a fact true of every tile tells the reader nothing. It was
   * then the empty string, which is a reserved slot saying nothing at all. Both
   * were reported.
   *
   * It is the vendor now, which is the fact the preset tiles beside it already
   * carry, and `agentBadge` staying absent from this file is what says a *status*
   * did not come back with it.
   */
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
    /*
     * ⚠ **One harness really is native to two systems**, and the answer has to be
     * the same on every render or the tile's subline flickers between them. It
     * never reaches a tile — `startsBare` is false for opencode, so it has neither
     * a tile on the strip nor a row in the settings list — but the determinism is
     * the property, not the value.
     */
    check(
      "and a harness with two of them takes the daemon's own order, every time",
      [harnessSubline("opencode", systems), harnessSubline("opencode", systems)],
      ["OpenRouter", "OpenRouter"],
    );
    // Empty rather than a placeholder: the slot is reserved at both call sites, and
    // a vendor this client cannot place is not one it should be naming.
    check("and nothing is invented for a harness no system claims", harnessSubline("claude", [] as never), "");
    /*
     * ⚠ **Except where there *is* something honest to say, which is a harness a
     * plugin added.** Empty was right while every harness with a row had a vendor;
     * for a contributed one paired only with built-in providers, native to none,
     * the blank line is the **common** case — a tile with a title and nothing under
     * it beside tiles that have one, which is what a second-class row looks like.
     * "from <plugin>" is not a vendor and is not pretending to be: it answers the
     * question somebody actually has about a row they do not recognise.
     */
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
    // Somebody else's prose, bounded on the way in like every other name here.
    check(
      "and the plugin's name is bounded the same way a harness's is",
      harnessSubline("acme:gemini", [] as never, { pluginName: "P".repeat(200) }).length,
      "from ".length + MAX_HARNESS_NAME_CHARS,
    );
  }
  /*
   * ⚠ **One `.map` over an ordered list, where it was two in sequence — and the
   * count is the assertion.** "Harnesses come first" used to be a fact about the
   * order of two JSX children, which is an order nobody could change and nothing
   * could state. `orderStrip` decides it now, and what this pins is that the
   * markup went back to being markup: two `.map`s over the row would be the old
   * sequencing quietly reinstated *inside* a component that claims to be ordered
   * by the daemon, and every assertion about the order would still pass.
   *
   * `shownHere` still decides membership, which is the half that must not move:
   * the merge orders and hides, and a tile for something that cannot be started is
   * a state `offeredHere` exists to make unreachable.
   */
  check(
    "the row is one ordered map, and membership is still the filter's",
    [
      (stripRow.match(/\.map\(/g) ?? []).length,
      strip.includes("orderStrip("),
      strip.includes("const drawn = rows.filter((row) => !row.hidden);"),
    ],
    [1, true, true],
  );
  /*
   * ⚠ **The fade is a sibling of the scroller, not a mask on it**, which is the
   * transcript's rule at the top of a conversation and the same reason: a
   * `mask-image` on a scroll container applies to that container's scrollbar —
   * here, the app's own bar one sibling down. And it is untouchable, because it
   * covers the right 40px of the row, which is where the trailing control sits at
   * every scroll position but the last.
   *
   * The `opacity` lives in `index.css` rather than here, which the negative below
   * is what holds — see the tile's own `opacity` rule further down this file, and
   * `.edge-fade` in the stylesheet for why that is a placement rather than a
   * preference.
   */
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
    /*
     * And the two states it transitions between exist, in the file that owns them.
     * Read here rather than beside the `.fade-thumb` block below, because what is
     * being asserted is the *pair* — a class with one endpoint fades to nothing
     * and back to nothing, which is a gradient that never appears.
     */
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
  /*
   * ⚠ **And an empty row says which kind of empty it is.** It had one sentence,
   * because it had one cause: the daemon listed nothing. A machine can now list
   * three agents and draw none of them, and "this machine reports no agents" over a
   * machine that reported three is the false line that sends somebody to the wrong
   * screen. What is deliberately *not* here is which agent or why — the sign-in
   * door below is drawn in exactly this state and says both.
   */
  check(
    "an empty row distinguishes a machine with no agents from one with none ready",
    [
      strip.includes('"This machine reports no agents."'),
      strip.includes('"No agent on this machine is ready to start."'),
      strip.includes("const nothingAtAll = shown.length === 0"),
    ],
    [true, true, true],
  );
  /*
   * ⚠ **The second sentence now has two endings, and the assertion above cannot
   * tell them apart.** It matches a literal that appears twice, so it went from
   * distinguishing the arms to being satisfied by either — the failure this file
   * warns about generally and had here specifically.
   *
   * The second ending exists because the first overclaimed: the gear opens a
   * screen that lists harnesses `startsBare` answers true for and nothing else, so
   * on a machine holding only opencode, or only a contributed harness without
   * one a plugin added, "the gear above lists them all" pointed at a screen that would
   * draw *This machine reports no agents* — two screens answering one question,
   * one of them wrong. What is true in that state is the bar at its foot, which is
   * always drawn.
   */
  check(
    "and the gear is only named for what it will actually show",
    [
      strip.includes("agents.some(startsBare)"),
      strip.includes('"The gear above lists them all, with what each one said."'),
      strip.includes('"The gear above is where to add one."'),
    ],
    [true, true, true],
  );
  /*
   * ⚠ **Four answers to one question, and this pins the fourth.** `.no-scrollbar`
   * hid the bar outright — a phone idiom that left a desktop with no cue and no
   * gesture. Taking it off gave the permanent classic bar the app draws on a fine
   * pointer, a dark rule under a row of tiles, reported the moment it shipped. The
   * third reserved that bar's thickness and animated the thumb's colour — and it
   * did **not** fade, which was the next report and is the measurement below.
   *
   * So the strip hides the browser's bar and draws its own: a `div` under the row,
   * sized and moved from the scrollport's own metrics, shown while the row is
   * moving and faded when it is not. `is-scrolling` decides when, and it is put on
   * by the element rather than by a render, because this fires on every frame of a
   * flick.
   */
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
  /*
   * ⚠ **And it is taken off again, which is the whole of the report.** The check
   * above pins that the class goes *on*; turning the timeout's `remove` into an
   * `add` left it green while the bar never faded — the exact behaviour this rule
   * replaced. The three states this feature exists to distinguish are always-on,
   * never-on and on-then-fading, so all three have to be reachable by a failing
   * assertion. The whole statement is pinned rather than the call, because it is
   * the pairing of *this* timeout with *this* removal that is the fade.
   */
  check(
    "and the class comes off a moment after the last scroll, which is the fade",
    strip.includes('idle = setTimeout(() => bar.classList.remove("is-scrolling"), SCROLLBAR_FADE_MS);'),
    true,
  );
  /*
   * ⚠ **Both boxes are observed, and the row is the one that is easy to forget.**
   * The scrollport's width is the window's; the row's is however many agents the
   * machine reported, which lands a round trip after the effect runs. Observing
   * only the scrollport leaves a thumb sized for an empty row with nothing to
   * re-measure it — a bar that is permanently full width over a row that scrolls.
   */
  check(
    "and it re-measures when either box changes size",
    [strip.includes("new ResizeObserver(layout)"), strip.includes("sizes.observe(row)")],
    [true, true],
  );
  /*
   * ⚠ **It reports a position and does not offer one.** A native scrollbar can be
   * dragged and this cannot, so it must not take a press: `pointer-events-none` is
   * what keeps a tap from landing on a control that would do nothing, and
   * `aria-hidden` keeps it out of a reading of the row it is about.
   *
   * ⚠ **Those two attributes are the slice's own anchor**, so what asserts them is
   * the found-check above and nothing here. Said out loud because a check that
   * tests its own anchor reads as proving something and proves nothing — it is the
   * shape this file already warns about one section up, arriving from the other
   * side. What is asserted here is the half an anchor cannot reach: that the thing
   * inside it takes no input of any kind.
   */
  check(
    "the bar is inert — no handler, no tab stop, no role",
    [/onClick|onPointer|onMouse|onKey|tabIndex|role=/.test(stripRail), stripRail.includes("ref={thumb}")],
    [false, true],
  );
  /*
   * ⚠ **And the fade is an opacity, which is the whole reason it fades at all.**
   * Since Chrome 121 the standard properties override the pseudo-elements:
   * `scrollbar-width` or `scrollbar-color` at anything but `auto` and every
   * `::-webkit-scrollbar-*` rule on that element is ignored — and this app's
   * `@media (pointer: fine)` rule sets **both, on `*`**, so the
   * `transition: background-color` written on a thumb pseudo-element was dead on
   * arrival everywhere, and what was left switching was `scrollbar-color`, which no
   * engine interpolates. The bar vanished between two frames, which is what was
   * reported.
   *
   * The three claims: the browser's bar is hidden rather than styled, the app's own
   * transitions `opacity` and nothing that takes layout, and the global reduced-
   * motion rule still reaches it — a fade is motion, and this file's own block at
   * the foot zeroes every transition rather than naming them.
   */
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
    /*
     * ⚠ **The two endpoints, because a transition between one value and itself is
     * not a fade and this block could not tell.** Proved by mutation against a copy
     * of the tree: delete `opacity: 0` and the bar is the permanent dark rule the
     * third answer was reported for; delete `opacity: 1` and it never appears at
     * all, which is the first answer, a strip with no cue. Both left this driver
     * green. A rule that animates a property is not the same claim as a rule that
     * has two values to animate it between.
     */
    check(
      "and it has two values to fade between: nothing at rest, the edge while moving",
      [/^\s*opacity: 0;$/m.test(bar), /is-scrolling \{\n  opacity: 1;/.test(css)],
      [true, true],
    );
    /*
     * Out slowly, in at once, and one declaration does both — `is-scrolling` brings
     * the shorter duration with it. A single duration in both directions reads as
     * lag on the way in: the bar arriving after the row has already moved.
     */
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

  /*
   * ⚠ **A choice *per machine*, held as a map, and neither the state nor the ref
   * is a substitute for the other.** This was one `touchedOn: MachineId | null` —
   * a flag saying "somebody has tapped, and it was over there" — which suppresses
   * a re-default on the machine it names and restores nothing. Two machines is
   * all it took: tap on A, switch to B (the listing re-defaults, deliberately
   * leaving the flag alone), come back to A — the flag still says A, so A's
   * re-default is skipped while the single chosen value is still whatever B
   * defaulted to. A then drew B's harness selected *and* disabled and `Start`
   * posted it. The map restores A's own tap instead of merely silencing A's
   * default.
   *
   * Both live in `StartSheet` rather than in `NewSession`, because `NewSession`
   * unmounts for the whole of the `/agent` route: a ref created there is empty in
   * exactly the flush the capture defect is about.
   */
  check(
    "the chosen tile is a map keyed by machine, held where the builder cannot unmount it",
    [
      /const \[picks, setPicks\] = useState<ReadonlyMap<MachineId, Picked>>\(/.test(sheet),
      /const picksRef = useRef<ReadonlyMap<MachineId, Picked>>\(/.test(sheet),
      /\btouchedOn\b/.test(newSessionSrc),
    ],
    [true, true, false],
  );
  /*
   * ⚠ **Written to the ref *before* the state, and the order is the assertion.**
   * The listing's `.then` reads the ref at answer time, so a tap has to be true in
   * it the moment it happens rather than one render later. A ref assigned after
   * `setPicks` typechecks, looks identical in review, and reintroduces the defect
   * for every tap that races an answer already in flight.
   *
   * ⚠ **Both operands are checked against `>= 0` first**, the same shape as the
   * `App.tsx` ordering pins. This was a bare `indexOf(…) < indexOf(…)`, and
   * deleting the ref write outright — the one edit that costs the most — made the
   * left side `-1`, which is *less than* every real position: the assertion
   * printed `ok`, `typecheck` was clean, and `picksRef` held its initial empty map
   * for the component's whole life with the guard above silently disabled.
   */
  const refWrite = sheet.indexOf("picksRef.current = updated;");
  const stateWrite = sheet.indexOf("setPicks(updated);");
  check("a tap still writes the ref at all", refWrite >= 0, true);
  check("and still writes the state the render reads", stateWrite >= 0, true);
  check(
    "and the ref is written before the render that will carry it",
    refWrite >= 0 && stateWrite >= 0 && refWrite < stateWrite,
    true,
  );
  /*
   * ⚠ **And a tap keeps every *other* machine's choice, which is the whole reason
   * this is a map and which nothing above it can see.** The declared shape, the
   * write order and the single read site are all pinned, and every one of them
   * survives a `choose` that starts from an empty map — the map is still typed
   * `ReadonlyMap<MachineId, Picked>`, the ref is still written before the state,
   * and `picksRef.current.get(selected)` still answers correctly for the machine
   * that was just tapped. What it stops answering for is every other machine, and
   * that is the single-value bug this map replaced, rebuilt inside it: tap on A,
   * switch to B and tap there, come back to A, and A's own tap is gone.
   *
   * ⚠ **A source assertion because there is nothing to call.** `choose` is a
   * closure inside `StartSheet` with no export and no seam, and the property needs
   * two machines and a render between them, which this driver has no renderer for.
   * So it asserts the one line whose rewriting is the whole defect: the new map is
   * seeded from the standing one, and neither of the two ways of emptying it
   * appears anywhere in the function.
   */
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
  // And it withdraws by *deleting* the one machine's entry rather than by
  // replacing the map, which is the same property said at the other end.
  check(
    "and withdraws one machine's choice without touching the rest",
    [/updated\.delete\(machine\);/.test(choose), /updated\.set\(machine, next\);/.test(choose)],
    [true, true],
  );
  /*
   * ⚠ **The drawn selection is derived, and the machine's own default is the
   * fallback rather than an entry in the map.** Writing a default into the map
   * would record a choice nobody made and restore it on the next visit as though
   * it had been tapped — the same class of lie the single value told. So: this
   * machine's pick first, this listing's default second, and **both** weighed by
   * `offeredHere` against the listing that answered.
   */
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
  /*
   * ⚠ **And the hidden set is passed to *both*, which is the newest member of this
   * family.** Hiding an agent takes its tile away without making it unstartable —
   * the daemon would run it perfectly — so nothing downstream refuses it: the tile
   * is simply not drawn. A pick or a default that survived this call would be
   * `Start` live over a row with nothing shown as chosen, which is exactly the
   * shape of the three bugs `offeredHere` already closes. One argument, both call
   * sites, asserted together because passing it to one of them is the failure.
   */
  check(
    "including the hidden set, on both arms",
    (drawn.match(/hiddenHere/g) ?? []).length,
    2,
  );
  /*
   * ⚠ **The default is *derived*, and it is derived from the row that gets drawn.**
   * Two defects closed at once, and only the first is about the strip.
   *
   * It was `agents.find(shownHere)` — the first harness in `AGENT_IDS` order —
   * which stopped being the first thing on screen the moment the row gained an
   * order and a hidden set: hiding `claude` left the default naming it,
   * `offeredHere` refused it as hidden, and the screen drew no chosen tile at all
   * with `Start` disabled until somebody tapped one.
   *
   * And it was state set inside `GET /agents`'s own `.then`, which is why it
   * needed `picksRef` — THE CLOSURE CAPTURE this section was built around. The
   * effect's deps are the daemon client and the sign-in epoch, and
   * `store.daemonFor` answers the same object for a machine's whole life, so
   * nothing re-ran it when a tile was tapped and the `.then` created a round trip
   * ago still held the props of the render that made it. Derived, there is no
   * capture: the choice outranks the default because `??` says so, one line down,
   * in the render that draws both.
   *
   * ⚠ **So the ref is gone from this arm and must not come back**, which is what
   * the negative below is for: a `.then` that reads `picksRef` again is a `.then`
   * that has started deciding what is chosen.
   */
  check(
    "the default is derived from the drawn row rather than recorded from a listing",
    [
      /const defaulted =\s*customAgents === null/.test(newSessionSrc),
      newSessionSrc.includes("setDefaulted"),
      /picksRef\.current/.test(settled),
    ],
    [true, false, false],
  );
  /*
   * And it is the **first row the strip draws**, in the order somebody arranged —
   * the same `orderStrip` merge the row itself makes, over the same two listings,
   * filtered by the same hidden flag. Asserted as the call rather than as a
   * behaviour because the behaviour is `orderStrip`'s and is swept in full one
   * section over; what this pins is that this screen asks it rather than
   * re-deriving an order of its own.
   */
  check(
    "and it is the first row that row will draw",
    [
      /orderStrip\(/.test(newSessionSrc.slice(newSessionSrc.indexOf("const defaulted ="), newSessionSrc.indexOf("const picked ="))),
      /defaultRow\(/.test(newSessionSrc.slice(newSessionSrc.indexOf("const defaulted ="), newSessionSrc.indexOf("const picked ="))),
      /\.find\(\(row\) => !row\.hidden\)/.test(newSessionSrc.slice(newSessionSrc.indexOf("const defaulted ="), newSessionSrc.indexOf("const picked ="))),
    ],
    [true, true, false],
  );
  /*
   * ⚠ **And "first" is stricter than "first not hidden", which is what that
   * negative above is a ratchet against.** `.find((row) => !row.hidden)` was this
   * line until `defaultRow` replaced it, and it is wrong in one state that reaches
   * it: the harness
   * half of the row is filtered by `shownHere` on the way in, but a **preset** is
   * listed whatever state its harness is in and draws a disabled tile saying so.
   * First in somebody's order, that was the default — refused by `offeredHere` one
   * line down, leaving the screen with nothing drawn as chosen and `Start` dead,
   * which is the same failure the hidden case produced through the other door.
   *
   * ⚠ **And it is asserted as *one call shared with the Agents screen* rather than
   * as two matching predicates.** That screen draws a `default` badge on a row, and
   * a badge naming a row this line would skip is a confident claim about another
   * screen that the reader cannot check from where they are standing. Both ask
   * `defaultRow`; the sweep below is what stops either growing a rule of its own.
   */
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
    /*
     * ⚠ **And the badge is decided by the list, never by the row.** `index === 0`
     * is the answer a row can reach on its own and it is wrong in both of the
     * states this screen exists to show — a hidden first row, and a first harness
     * that is signed out — so the flag is computed one level up and handed down.
     * The negative is the ratchet: nothing in that file may derive it from a
     * position.
     */
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
  /*
   * ⚠ **Regex *literals*, never strings handed to `new RegExp`.** Three of these
   * five were dead: in a double-quoted JS string `\b` is the backspace escape
   * (U+0008) rather than a word boundary, so `new RegExp("\bpicks\b")` asked for a
   * literal control character that no source slice can hold — and the two
   * forbidden identifiers that matter most, the bare `picks` and `picked` a
   * closure would capture, were unwatched. A literal is one escape layer closer to
   * what it means, which is the whole class of bug.
   */
  check(
    "and no value captured by that closure is consulted instead",
    [/picks\.get/, /picks\.has/, /\bpicks\b/, /touched/, /\bpicked\b/].filter((one) => one.test(settled)).map(String),
    [],
  );

  /*
   * ⚠ **Both hand-offs are taken, from an effect, and neither is skipped because
   * the other answered.** `agentPick.ts` holds them as two maps for exactly that
   * reason — one machine can be carrying a removal *and* an assembly — and a
   * hand-off read during render would be swallowed by React's second render in
   * development and left behind to fire on some later visit. A producer with no
   * consumer and a consumer with no producer both typecheck perfectly, which is
   * why the far end is asserted here too.
   */
  check(
    "the strip takes both hand-offs, and it takes them in an effect",
    [/takeRemoval\(selected\)/.test(adoption), /takePick\(selected\)/.test(adoption), /useEffect\(\(\) => \{\s*if \(selected === null\) return;\s*const removed = takeRemoval/.test(newSessionSrc)],
    [true, true, true],
  );
  // The removal only withdraws the pick it names, and it reads the ref for
  // `StartSheet`'s own reason: the pick being withdrawn may have been made in this
  // very flush.
  check(
    "a removal withdraws only the standing pick it names",
    /const standing = picksRef\.current\.get\(selected\);\s*if \(standing\?\.kind === "custom" && standing\.id === removed\) onPick\(selected, null\);/.test(adoption),
    true,
  );
  check("and the builder is the thing that remembers one", /rememberRemoval\(machineId, going\);/.test(builderSrc), true);

  /*
   * ⚠ **`Picked | null` is a real state, so the control that can be reached has to
   * speak.** Nothing chosen is now reachable three ways — a machine with every
   * harness uninstalled, a preset deleted in the builder, a preset deleted on
   * another device — and each of them used to end at a request somebody waited on
   * for a `503 agent_unavailable` or a `404`. `Start` is gated, `create()` keeps
   * its own arm anyway (this file's standing rule), and the footer says which of
   * the two things it is still waiting for.
   */
  check(
    "Start is refused where nothing is chosen, in the button and again in the handler",
    [
      /disabled=\{busy \|\| selected === null \|\| cwd === null \|\| picked === null\}/.test(footer),
      /if \(picked === null\) \{\s*setError\("Choose an agent first\."\);/.test(newSessionSrc),
    ],
    [true, true],
  );
  // Asked only once the listing has settled, or it asks for an agent over a row
  // that is still loading — and asked *before* the folder, because the folder
  // answers itself and this one needs a tap.
  check("and the footer asks for one, once the listing has answered", /agents !== null && picked === null \? \(\s*"choose an agent"/.test(footer), true);
  /*
   * ⚠ **Nothing draws a tile as chosen from the *resolved* harness.** That
   * resolution carries the sign-in door's fallback — on a machine with every
   * harness uninstalled it is the only way to a login, since every tile in the row
   * is disabled and none can be tapped — and drawing against it is what put a
   * first tile on screen `aria-pressed` and `disabled` at once.
   */
  check(
    "the tiles ask what was chosen, never what the sign-in door resolved to",
    [
      /picked: value\?\.kind === "harness" && candidate\.id === value\.id/.test(strip),
      /picked: value\?\.kind === "custom" && one\.id === value\.id/.test(strip),
    ],
    [true, true],
  );
}
