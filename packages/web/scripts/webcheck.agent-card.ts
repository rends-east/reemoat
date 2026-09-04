import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * What one agent's card says
 *
 * ⭐ **No driver reads `AgentsPanel.tsx` at all**, so every rule this card lives
 * by was a rule nothing protected — which is how a wall of adapter-vs-CLI prose
 * shipped to a non-technical reader, and how a stored key became unremovable.
 * The sentences are data in `ui/agentCard.ts` for exactly that reason. Q3.431.
 * ------------------------------------------------------------------ */
process.stdout.write("\nwhat one agent's card says\n");
{
  const {
    agentBadge,
    agentLabel,
    agentStance,
    harnessName,
    MAX_HARNESS_NAME_CHARS,
    tokenBlockFor,
    stanceLine,
    credentialCaveat,
    credentialLabel,
    CREDENTIAL_LABELS,
    storedChip,
    signOutSentence,
    dividerWord,
    multiSlotLine,
  } = await import("../src/ui/agentCard.js");
  const { AGENT_IDS } = await import("../src/wire.js");
  const agentCardRaw = readFileSync(new URL("../src/ui/agentCard.ts", import.meta.url), "utf8");

  /*
   * ⚠ **The program, not the company and not the model.** "Claude" was wrong in a
   * way that only mattered once a harness could be pointed elsewhere: a row
   * reading "Claude" beside a model reading "Kimi K2 Thinking" says the opposite
   * of what is true. Each is what its own vendor calls the program it ships.
   */
  check(
    "a harness is named as the program it is, not its package or its model",
    AGENT_IDS.map((id) => agentLabel(id)),
    // Swept over the union rather than listed, so a fifth harness is a failure
    // here rather than a row this file forgot to name.
    //
    // ⚠ **`Opencode` is capitalised and its binary is not**, which is the split
    // this table exists to make: the vendor writes it lowercase everywhere it is a
    // name for a machine — the executable, the package, the `agentInfo.name` it
    // answers `initialize` with, every id stored and sent — and none of those is
    // touched. Here it is read as a word, at the start of sentences and in a row
    // beside three product names, and it was the only entry that looked like an
    // unformatted id.
    ["Claude Code", "Kimi Code", "Codex", "Opencode"],
  );
  /*
   * ⚠ **And none of them falls through to the id.** `AGENT_LABEL` is a
   * `Record<string, string>` with a `?? id` fallback, so a harness nobody added a
   * label for renders as its own id and reads *almost* right — `opencode` did
   * exactly that, and would have passed the check above with no entry at all,
   * because for a release the chosen label and the fallback were the same six
   * letters. Capitalising it removed that particular coincidence; this check is
   * what covers the next one, since it asks the table rather than the output.
   */
  check(
    "and every one of them was named on purpose rather than falling through",
    AGENT_IDS.filter((id) => !/\bAGENT_LABEL[\s\S]*?\}/.test(agentCardRaw) || !agentCardRaw.includes(`  ${id}: `)),
    [],
  );
  // A fourth agent from a newer daemon still renders — as its id, never blank.
  check("an unknown agent still has a name", agentLabel("newthing"), "newthing");

  /*
   * ⚠ **A harness a plugin added is named from the *listing*, and never from the
   * daemon's `displayName`** — which is the trap this pair exists to close. That
   * field is a log line and carries the program: it is literally
   * `Claude (claude-agent-acp)` and `Kimi Code CLI`, and two of the four built-ins
   * would fail this file's own rule against a label naming a package or ending in
   * `CLI`. A client that reached for it when `AGENT_LABEL` had no row would have
   * put the adapter's package name on a 96px tile the first time a harness arrived
   * it did not know.
   */
  check(
    "this product's own table wins, whatever a manifest calls a built-in",
    harnessName({ id: "claude", label: "Something Else" }),
    "Claude Code",
  );
  check("a harness it has never heard of takes the manifest's name", harnessName({ id: "acme:gemini", label: "Gemini" }), "Gemini");
  check("and one that named itself nothing is drawn as its id", harnessName({ id: "acme:gemini" }), "acme:gemini");
  /*
   * ⚠ **Bounded rather than filtered, and the distinction is the rule.**
   * `noJargon` forbids *wire vocabulary in this app's own templates*; it is not,
   * and may never become, a content filter over the nouns substituted into them,
   * which are and always were somebody else's prose — a provider legitimately
   * called "Anthropic-Compatible Gateway" is truthful, and refusing it would be
   * this app renaming somebody's product.
   *
   * What has to be bounded is the *shape*. These strings land in one-line
   * `truncate`d sublines, in an `aria-label` built by joining with commas, and in
   * headings on a phone — so a newline makes one line into two inside a row that
   * reserved one, and a bidi override reorders the sentence around it, including
   * sentences this app wrote.
   */
  check("a name longer than the row is cut", harnessName({ id: "a:b", label: "G".repeat(200) }).length, MAX_HARNESS_NAME_CHARS);
  check(
    "and control characters never reach a sentence",
    harnessName({ id: "a:b", label: "Gem\u0000ini\nCLI\u202e" }),
    "Gem ini CLI",
  );
  check("an empty name falls back rather than drawing nothing", harnessName({ id: "a:b", label: "   " }), "a:b");
  /*
   * ⚠ **And `noJargon` is deliberately *not* asserted over these**, which is the
   * comment that stops somebody "fixing" it by widening the predicate. A plugin's
   * name is not this app's template, and the honest answer to a hostile one is a
   * bound on its shape rather than a rule about its words.
   */
  check(
    "a hostile name is still one line with nothing in it that can reorder a sentence",
    (() => {
      const drawn = harnessName({ id: "a:b", label: "\u202eAnthropic\nOpenAI/\u0007" });
      return [drawn.includes("\n"), drawn.includes("\u202e"), drawn.length <= MAX_HARNESS_NAME_CHARS];
    })(),
    [false, false, true],
  );
  /*
   * ⚠ **Cut by character, not by code unit — this drew a replacement glyph.** A
   * name whose 32nd character is astral was sliced through the middle of a surrogate
   * pair, so a tile read `AAAA…\uFFFD`. `MonogramGlyph` one file over uses
   * `Array.from` for exactly this and this did not.
   */
  check(
    "a name cut at the bound is cut between characters",
    (() => {
      const drawn = harnessName({ id: "a:b", label: `${"A".repeat(31)}\u{1F680} Tools` });
      return [Array.from(drawn).length, drawn.includes("\uFFFD"), /[\uD800-\uDBFF]$/.test(drawn)];
    })(),
    [MAX_HARNESS_NAME_CHARS, false, false],
  );
  /*
   * ⚠ **And the invisible half, which `\s` does not match and `trim()` therefore
   * keeps.** `U+061C` is a bidi control outside the block anybody reaches for, and
   * `U+200B`/`U+2060`/`U+FEFF`/`U+00AD` are zero-width — so a name made only of
   * those survived as a non-empty string and drew a blank, unsearchable row rather
   * than falling back. The daemon does not strip them either: `"\u200b".trim()` has
   * length 1, and `parseManifest` has no control-character rule on a name.
   */
  check(
    "a name made of nothing visible falls back rather than drawing blank",
    [
      harnessName({ id: "a:b", label: "\u200b\u200b" }),
      harnessName({ id: "a:b", label: "\u00ad\u2060\ufeff" }),
      harnessName({ id: "a:b", label: "\u061c" }),
    ],
    ["a:b", "a:b", "a:b"],
  );
  check("while one that merely contains them keeps its words", harnessName({ id: "a:b", label: "Acme\u061cCorp" }), "Acme Corp");

  /*
   * ⚠ **An agent with nothing to sign in to says so, and says it as good news.**
   * Measured: opencode runs against an empty `XDG_DATA_HOME` with no provider
   * variables at all, so `loggedIn` is `null` and every other reading of that
   * value is wrong here — "cannot check" describes a probe that failed, "not
   * signed in" describes a gap, and there is neither. The whole point is that
   * somebody stops looking for a sign-in button that should not exist.
   *
   * Driven over both credential states, because a key changes what such an agent
   * can *reach* and never whether it runs — so the answer must not move.
   */
  check(
    "an agent with no sign-in is a state of its own, whatever it holds",
    [
      agentStance(true, null, "no_flow"),
      agentStance(true, true, "no_flow"),
      agentBadge(agentStance(true, null, "no_flow")),
    ],
    // `null`, not a quieter badge: every other one reports a state somebody may
    // have to act on, and this reports the absence of one. Under a tile in a row of
    // three agents that *are* reporting something, it read as an answer to a
    // question nobody asked. Whether the state could have been probed is
    // deliberately not distinguished — that is `unchecked`'s job and it is a real
    // gap, which this is not.
    ["no_login", "no_login", null],
  );
  /*
   * And the reading it replaces, unchanged for everyone else: `null` from an
   * agent that *does* have a sign-in is still "cannot check", which is kimi's
   * permanent and correct answer. The blocked reasons that are about the **host**
   * must not trip it — those agents would sign in if they could.
   */
  check(
    "while the three reasons that are about the host leave the state alone",
    (["no_script", "no_cli", "interactive_pty", null, undefined] as const).map((b) =>
      agentStance(true, null, b),
    ),
    ["unchecked", "unchecked", "unchecked", "unchecked", "unchecked"],
  );
  check(
    "and every state draws exactly one badge, or none where there is nothing to report",
    (["not_installed", "start_refused", "no_login", "signed_in", "signed_out", "unchecked"] as const).map(
      (one) => {
        const badge = agentBadge(one);
        return badge === null ? `${one}: none` : `${one}: ${badge.tone}/${badge.text}`;
      },
    ),
    [
      "not_installed: strong/not installed",
      /*
       * ⚠ **"would not start" and never "not signed in".** This badge reports what
       * was observed — the agent declined to open a session — and every harness that
       * can reach this state has no status to probe, so the app holds no evidence
       * about a credential at all. Naming it a sign-in would also name the wrong
       * remedy: for these harnesses the other one is to run the CLI on the machine.
       */
      "start_refused: strong/would not start",
      "no_login: none",
      "signed_in: plain/signed in",
      "signed_out: strong/not signed in",
      "unchecked: plain/cannot check",
    ],
  );
  /*
   * ⚠ **And it is the *only* one that draws none**, which is what stops "say
   * nothing" spreading to the state it is one word away from. `unchecked` is an
   * agent that has a sign-in and could not be asked about it — a real gap, and a
   * badge. `no_login` is an agent with nothing to ask about.
   */
  check(
    "and it is the only state that draws none",
    (["not_installed", "start_refused", "no_login", "signed_in", "signed_out", "unchecked"] as const).filter(
      (one) => agentBadge(one) === null,
    ),
    ["no_login"],
  );
  /*
   * ⚠ **The sentence is the other half, and it must not read as an apology.** The
   * screen's own rule is that a refusal names a remedy; here there is nothing to
   * remedy, so what it owes instead is what the control below it is *for* — the
   * key box stays drawn, and a box with no stated purpose is the furniture this
   * screen keeps deleting.
   */
  const noLoginLine = stanceLine({ id: "opencode" }, "no_login", false, "darwin");
  check(
    "and its sentence says nothing is missing, and what the box below is for",
    [
      noLoginLine !== null,
      /can't|cannot|couldn't|only way in|isn't installed/i.test(noLoginLine ?? ""),
      /key/i.test(noLoginLine ?? ""),
    ],
    [true, false, true],
  );
  /*
   * The key box stays. `no_login` is the one state where it is not a remedy —
   * nothing is broken — and hiding it would hide the only control this agent has.
   */
  check("and the key box is still offered", tokenBlockFor("no_login", 0), "editable");

  /*
   * ⭐ **A harness that refused to open a session, which is the sixth state and
   * the only one here that is a *measurement*.**
   *
   * Reported with a screenshot: the New session strip drew a tile for a harness a
   * plugin had added, Start answered "rejected session/new: authentication
   * required", and the tile was still there afterwards. `readLoginState` answers
   * `pasted ? true : null` for every harness with no status command, so the
   * credential axis could never say otherwise — and `agentStance` tested
   * `no_flow` *before* that axis anyway.
   *
   * ⚠ **It was added above `no_flow` rather than by reordering the two arms below
   * it, and the difference is three sentences.** A reorder would have let
   * `signed_out` win for such a harness, and `stanceLine`'s signed-out arm blames
   * the *host* — "macOS can't run its own sign-in, so a saved key is the only way
   * in" — which is false on every platform here and forecloses the remedy the
   * daemon's own hint offers first. `dividerWord` would have drawn "Sign in with a
   * key instead" with nothing above it (Q3.513, again), and `storedChip` would
   * have said "still isn't signed in" about a probe that never ran. None of the
   * three is driven at `agentStance(true, false, "no_flow")`, so all three would
   * have shipped silently.
   *
   * The second cell is what proves it: with no refusal, a harness with no sign-in
   * is `no_login` exactly as before, whatever the credential axis says.
   */
  check(
    "a harness that refused to start outranks having nothing to sign in to",
    [
      agentStance(true, null, "no_flow", true),
      agentStance(true, false, "no_flow", false),
      agentStance(true, null, "no_flow", false),
      // Not installed still wins: a harness that is not there cannot have refused
      // anything, and the older fact is the one worth drawing.
      agentStance(false, null, "no_flow", true),
      // And it reaches an ordinary harness too — this is not a contributed-only
      // state, it is whatever the daemon last measured.
      agentStance(true, true, null, true),
    ],
    ["start_refused", "no_login", "no_login", "not_installed", "start_refused"],
  );
  /*
   * ⚠ **Absent means nothing was observed**, which is what an older daemon sends
   * and what every other cell in this file passes. Asserted rather than assumed,
   * because the argument's whole shape is that this axis defaults to silence.
   */
  check(
    "and a daemon that never mentions it changes nothing",
    [agentStance(true, null, "no_flow", undefined), agentStance(true, false, null, undefined)],
    ["no_login", "signed_out"],
  );
  /*
   * ⚠ **The sentence blames the harness, never the host.** That is the whole
   * reason this is a member rather than a reorder: the agent was asked to open a
   * session and said no, which is true on every platform. It also names both
   * remedies where there is no button for either — a harness with no wizard is
   * fixed by running its own program on the machine, or by a key — and it carries
   * no word from the wire, since what the daemon recorded is drawn separately.
   */
  const refusedLine = stanceLine({ id: "byo:gemini", label: "Gemini" }, "start_refused", false, "darwin");
  check(
    "and its sentence blames the harness rather than the machine it is on",
    [
      refusedLine !== null,
      /macOS|Windows|Linux|this machine can't/i.test(refusedLine ?? ""),
      /session\/new|auth_required|-32000/.test(refusedLine ?? ""),
      /key/i.test(refusedLine ?? ""),
      // The label, not the namespaced id. Every sentence in this module named the
      // agent with `agentLabel`, which answers the bare id for anything this
      // product does not ship — so a harness a plugin added has been drawing
      // `byo:gemini needs no sign-in.` on its own settings card.
      (refusedLine ?? "").includes("Gemini"),
      (refusedLine ?? "").includes("byo:gemini"),
    ],
    [true, false, false, true, true, false],
  );
  /*
   * With a wizard below it the sentence stops at what happened: naming the button
   * directly underneath is the self-reference this file keeps deleting.
   */
  check(
    "and it stops there where there is a control to press",
    /key|machine itself/i.test(stanceLine({ id: "claude" }, "start_refused", true) ?? ""),
    false,
  );
  /*
   * ⚠ **The two arms that fall through, and both would have been wrong.**
   * `dividerWord` draws "Sign in with a key instead" whenever nothing sits above
   * it — Q3.513's defect — and `storedChip` would otherwise report a stored key as
   * plain "saved" beside a harness that would not start, which is the one arm
   * where "saved" alone is misleading in the direction that matters.
   */
  check(
    "the divider needs something above it here too",
    [dividerWord("start_refused", false, "editable"), dividerWord("start_refused", true, "editable")],
    [null, "or"],
  );
  check(
    "and a stored key does not read as a working one",
    storedChip({ id: "byo:gemini", label: "Gemini" }, "start_refused"),
    "saved — Gemini still wouldn't start",
  );
  // The box is the strongest remedy this card has for a harness with no wizard,
  // so it stays typeable.
  check("and the key box is offered", tokenBlockFor("start_refused", 0), "editable");

  /*
   * ⚠ **And *two* screens draw this now, off the same call, because for a release
   * they did not.** `NewSession.tsx` kept a private four-state ladder of its own —
   * `available`, then `loggedIn`, then a word this file has never seen — so an
   * agent that needs no sign-in was labelled with a probe that failed, and kimi
   * was told two different things two taps apart on the same machine. Nothing
   * caught it: `agentCard.ts` is driven exhaustively and the copy was in a `.tsx`
   * no driver read for its vocabulary.
   *
   * Asserted as source text, and there is no other way to assert it: a placement
   * is not a value, which is `plugin-ui.md`'s standing reason for reading a file
   * off disk. Three claims — that the private ladder is gone, that the shared call
   * is what replaced it, and that the daemon's own reason is what feeds it rather
   * than a boolean re-derived here.
   */
  /*
   * ⚠ **The shared call moved one module further out, and the property got
   * *stronger* rather than weaker.** It was written inline in `NewSession.tsx` as
   * long as that screen was the only one asking; the Agents screen then had to
   * answer the same question about the same harness — which row the strip lands
   * on by default — and a second transcription of a five-state ladder in a second
   * `.tsx` is exactly the failure this check was written for, one file along. So
   * the ladder lives in `agents.ts` as `offersStripTile`.
   *
   * ⚠ **And moving it took this check's only *positive* anchor off the screen it
   * is about, which is the trap this file warns about at the top.** The third
   * assertion used to read `newSessionRaw.includes(…)`; retargeted at `agentsRaw`
   * it says nothing whatever about `NewSession.tsx`, leaving three negatives — and
   * a private ladder written in *different words* satisfies every negative there
   * is. Measured: replacing the binding below with
   * `(candidate) => candidate.available && candidate.loggedIn === true` left
   * `typecheck` **and** `webcheck` green, while dropping tiles for `no_login` and
   * `unchecked` and granting opencode one — which is both halves of the defect this
   * check was written for. So the fifth assertion is the positive: this screen's
   * predicate *is* the shared one, by name.
   */
  const newSessionRaw = readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8");
  const agentsRaw = readFileSync(new URL("../src/agents.ts", import.meta.url), "utf8");
  check(
    "the New session tiles hold no vocabulary of their own",
    [
      /function agentStatusText/.test(newSessionRaw),
      /return "state unknown"/.test(newSessionRaw),
      /*
       * ⚠ **Comments off and whitespace gone, because the subject is the argument
       * list and not its formatting.** The call is four arguments over five lines
       * with a paragraph inside it now — the literal-text form of this assertion
       * broke on the reflow and said nothing about whether the fourth argument was
       * right, which is a check that fails for the one reason it must not.
       */
      stripComments(agentsRaw)
        .replace(/\s+/g, "")
        .includes(
          "agentStance(candidate.available,candidate.loggedIn,candidate.login?.blocked,candidate.lastStartRefusal!=null",
        ),
      /agentStance\(/.test(stripComments(newSessionRaw)),
      newSessionRaw.includes("const shownHere = offersStripTile;"),
    ],
    [false, false, true, false, true],
  );
  /*
   * ⚠ **And the second screen cannot grow one either**, which is the reason the
   * ladder moved in the first place. The Agents list asks `startableHere` for what
   * a session can be started on; what it may **not** do is re-derive that from a
   * stance, and `offersTile` is the one call that would mean it had. `agentStance`
   * is deliberately *not* forbidden there — that screen draws a badge off it, which
   * is a different question from membership and the whole reason its list is wider.
   */
  {
    const paneVocab = stripComments(
      readFileSync(new URL("../src/ui/settings/MachineAgentsSection.tsx", import.meta.url), "utf8"),
    );
    check(
      "and neither screen keeps a membership ladder of its own",
      [
        /import \{[^}]*\bstartableHere\b[^}]*\} from "\.\.\/agents"/.test(
          stripComments(newSessionRaw),
        ),
        /import \{[^}]*\bstartableHere\b[^}]*\} from "\.\.\/\.\.\/agents"/.test(paneVocab),
        /offersTile\(/.test(paneVocab),
      ],
      [true, true, false],
    );
  }
  /*
   * ⚠ **And the sign-in door on that screen is shut for an agent that has none.**
   * Read off `blocked` rather than off the stance, and the difference is not
   * cosmetic: `agentStance` tests `!available` *first*, so a not-installed
   * opencode is `not_installed` and never `no_login` — which is the one state that
   * reaches this button at all. Gating on the stance would have been a no-op that
   * looked like a fix.
   *
   * ⚠ **It is one named function now, and both halves are pinned.** The test was
   * written out at the button and something subtly different decided *which* agent
   * the button was about — which stopped being survivable the moment a signed-out
   * harness lost its tile, because the fallback naming the agent and the gate
   * drawing the wizard are then the only way onto that screen's sign-in at all. A
   * fallback that names an agent the gate declines to draw for is an empty row, no
   * door, and nothing saying why.
   */
  check(
    "and it offers no sign-in to an agent that has none",
    [
      /candidate\.login\?\.blocked !== "no_flow"/.test(newSessionRaw),
      newSessionRaw.includes("{harness !== null && signInOffered(harness) && machineId !== null && ("),
      newSessionRaw.includes("(agents.find(signInOffered) ?? agents[0] ?? null)"),
    ],
    [true, true, true],
  );

  /*
   * The two axes are **not** one boolean. `available` is the adapter;
   * `login.supported` is `script` plus the agent's own CLI, a different binary.
   * Reading them as one is what drew a Sign-in button that could not act.
   */
  check(
    "the stance is a total partition",
    [
      agentStance(false, true),
      agentStance(true, true),
      agentStance(true, false),
      agentStance(true, null),
    ],
    ["not_installed", "signed_in", "signed_out", "unchecked"],
  );

  /*
   * ⭐ **A stored key is never hidden, in any stance.** This is the property the
   * shipped `stored > 0` guard fixed for one state, asserted here over the whole
   * grid: a pasted `KIMI_API_KEY` is by itself enough to make kimi report signed
   * in, and the block that hid then contained the only caller of
   * `clearCredential` in this package.
   */
  /*
   * ⚠ **All five, and `no_login` was missing from this list while it was pinned
   * pointwise three lines further down.** A member added to a union and not to the
   * fixture that sweeps it is a member every one of these sweeps is silent about —
   * which is the shape of the defect that put a private four-state ladder on the
   * New session tiles in the first place.
   */
  /*
   * ⚠ **Every member, and it is a hand-written list on purpose.** These two sweeps
   * are the file's only exhaustive statement about `tokenBlockFor`, whose body is
   * two `if`s and a fallthrough — so a new stance joins it silently and the sweep
   * is what makes that a decision. The list grew for `start_refused`, which falls
   * through to `editable` correctly and by accident until it is written down here.
   */
  const stances = [
    "not_installed",
    "start_refused",
    "no_login",
    "signed_in",
    "signed_out",
    "unchecked",
  ] as const;
  check(
    "a saved key is never hidden, whatever the stance",
    stances.map((stance) => tokenBlockFor(stance, 1) === "hidden"),
    [false, false, false, false, false, false],
  );
  check(
    "and nothing is typeable where nothing could help",
    stances.map((stance) => tokenBlockFor(stance, 0)),
    // `no_login` is editable and it is the one state where the box is not a
    // remedy: nothing is broken, and a key buys *more models* rather than
    // admission. Hiding it would hide the only control that agent has.
    // `start_refused` is editable because there the box is the *strongest* remedy
    // on the card — the harnesses that reach it have no wizard to run instead.
    ["hidden", "editable", "editable", "hidden", "editable", "editable"],
  );

  /* The two commonest states say nothing at all: the badge says it and the
     control below does something about it. */
  check(
    "the card is silent where a sentence could only repeat the badge",
    [stanceLine({ id: "codex" }, "signed_in", true), stanceLine({ id: "codex" }, "signed_out", true)],
    [null, null],
  );
  check("and speaks where there is no way in", stanceLine({ id: "codex" }, "signed_out", false) !== null, true);

  /*
   * ⭐ **Codex's caveat is the one measurement that survives the cull** (Q2.200):
   * with `CODEX_API_KEY` set and no real login, the adapter still answers
   * `session/new` with -32000. It must not overclaim either — the key IS merged
   * last at spawn and does reach codex's own API calls.
   */
  const codexCaveat = credentialCaveat("codex", true) ?? "";
  check("codex warns that a key alone is not enough", codexCaveat.length > 0, true);
  check("and does not overclaim that it does nothing", /does nothing|ignored|useless/i.test(codexCaveat), false);
  check("claude needs no caveat", credentialCaveat("claude", true), null);

  /*
   * The jargon floor. Every sentence this card can produce, against the
   * vocabulary the deleted wall was made of. A reader who has never seen an env
   * var must not meet one here.
   */
  const JARGON =
    /\bPATH\b|_KEY|_TOKEN|session\/new|-32000|~\/|\.json\b|daemon|adapter|CLI\b|stdin|env\b|API key from the|npm |pnpm /;
  const sentences: string[] = [];
  /*
   * Every agent, not the three that existed when this was written: the newest
   * member of both unions is the one no pointwise assertion has yet been written
   * for, so a sweep that names its subjects by hand goes quiet exactly where it is
   * needed. `AGENT_IDS` is the union itself.
   */
  for (const id of AGENT_IDS) {
    for (const stance of stances) {
      for (const can of [true, false]) {
        const line = stanceLine({ id }, stance, can);
        if (line !== null) sentences.push(line);
      }
    }
    const caveat = credentialCaveat(id, true);
    if (caveat !== null) sentences.push(caveat);
    sentences.push(signOutSentence(id, 0), signOutSentence(id, 1));
    for (const stance of stances) sentences.push(storedChip({ id }, stance));
    const multi = multiSlotLine({ id }, 2);
    if (multi !== null) sentences.push(multi);
  }
  check(
    "nothing the card can say is written for a developer",
    sentences.filter((line) => JARGON.test(line)),
    [],
  );

  /*
   * The credential labels, cross-checked against the daemon's own `envNames` read
   * as text — a fifth credential added there must be named here or a person meets
   * a raw variable again.
   */
  const agentsSrc = readFileSync(new URL("../../../src/acp/agents.ts", import.meta.url), "utf8");
  const declared = [...agentsSrc.matchAll(/envNames: \[([^\]]*)\]/g)]
    .flatMap((match) => [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((inner) => inner[1] ?? ""));
  check("the daemon declares credentials at all", declared.length > 0, true);
  /*
   * ⚠ **Against the table, never against `credentialLabel`'s answer.** This read
   * `credentialLabel(envName).name === envName` and **could not fail**: the
   * fallback lowercases, replaces underscores and capitalises, so no
   * SCREAMING_SNAKE_CASE name is ever returned unchanged — with or without an
   * entry. Measured: `ANTHROPIC_API_KEY` → `Anthropic api key`, and the same for
   * an invented fifth. So the one thing this exists to catch, a credential added
   * to `src/acp/agents.ts` and not named here, passed loudest.
   *
   * Membership is the property the sentence above already claims. The fallback
   * stays — it is what a *newer daemon* gets, and it is deliberately not what
   * this driver accepts.
   */
  check(
    "and every one of them is named in the table rather than auto-humanised",
    declared.filter((envName) => !(envName in CREDENTIAL_LABELS)),
    [],
  );
  // And the fallback itself, pinned once — both because it is what a *newer*
  // daemon's fifth credential gets, and because it is the reason the check above
  // had to be rewritten: it never echoes its input, so equality against `envName`
  // was a filter that could only ever be empty.
  check(
    "an unknown credential is humanised rather than shown raw",
    credentialLabel("SOME_NEW_API_KEY").name,
    "Some new api key",
  );

  /* An "or" is only drawn when there is something on both sides of it. */
  check(
    "the divider says what it separates",
    [
      dividerWord("signed_out", true, "editable"),
      dividerWord("signed_out", false, "editable"),
      dividerWord("signed_out", true, "stored_only"),
      dividerWord("signed_out", true, "hidden"),
    ],
    // "or paste a key", lower-case and verb-first: a divider, not a heading.
    ["or", "or paste a key", "Saved keys", null],
  );
  /*
   * ⚠ **And "instead" needs a first option**, which one agent has none of. It
   * drew `Sign in with a key instead` over an agent with no sign-in at all, with
   * nothing above the line for the key to be instead *of* — the same defect the
   * `or` arm is guarded against, in the arm that had never needed guarding because
   * until there was a fourth agent there was always a sign-in above it.
   *
   * Swept over the whole block table rather than asserted at the one value, so
   * "there is nothing to divide" cannot come back through `stored_only`.
   */
  check(
    "and an agent with nothing to sign in to gets no divider at all",
    (["editable", "stored_only", "hidden"] as const).flatMap((block) => [
      dividerWord("no_login", true, block),
      dividerWord("no_login", false, block),
    ]),
    [null, null, null, null, null, null],
  );
  check("claude is the only agent told it has a choice", multiSlotLine({ id: "claude" }, 1), null);
  /*
   * ⚠ **And the caveat that duplicated the sentence above it is gone.** opencode's
   * said a key was not needed to get started — true, measured, and exactly what
   * `stanceLine` says one line higher on the same card. This one is drawn **per
   * slot**, so on the one agent that has two it appeared twice, under two
   * different keys, saying the same thing about neither. Asserted as an absence
   * because the string is what came back twice.
   */
  check(
    "an agent that needs no key at all carries no caveat, and the one that does still warns",
    [credentialCaveat("opencode", false), credentialCaveat("claude", true), credentialCaveat("codex", true) !== null],
    [null, null, true],
  );
}

/* ------------------------------------------------------------------ *
 * The sign-in screens after the 2026-09-04 cut
 *
 * Four source facts the redesign (settings plan, T7) left behind, each of which
 * `typecheck` cannot see: a deleted component, a constant that must exist once,
 * an input that must live in a form, and a prop that must stay gone.
 * ------------------------------------------------------------------ */
process.stdout.write("\nthe sign-in screens, cut\n");
{
  const settings = (name: string): string =>
    stripComments(readFileSync(new URL(`../src/ui/settings/${name}`, import.meta.url), "utf8"));
  const agentsPanel = settings("AgentsPanel.tsx");
  const systemsPanel = settings("SystemsPanel.tsx");
  const machineSystems = settings("MachineSystemsSection.tsx");
  const card = stripComments(readFileSync(new URL("../src/ui/agentCard.ts", import.meta.url), "utf8"));
  check("all four files were found", [agentsPanel, systemsPanel, machineSystems, card].map((one) => one.length > 0), [true, true, true, true]);

  /*
   * `AgentChooser` had no call site for three releases — the rows became systems
   * — and an exported component nobody mounts is a second copy of a list that
   * drifts. Absent by name, and its private hook stays, since `AgentDetail` reads
   * it.
   */
  check("AgentChooser is gone", /AgentChooser/.test(agentsPanel), false);
  check("and the hook it shared with AgentDetail stays", /function useAgentAuth\(/.test(agentsPanel), true);

  /*
   * One spelling of "what is below may be stale", defined once in the pure module
   * both screens import from and drawn from there in both. Two definitions is the
   * defect: `SystemDetail` mounts `AgentDetail` directly under its own line.
   */
  const { STALE_READ } = await import("../src/ui/agentCard.js");
  check("STALE_READ is defined exactly once, in agentCard", (card.match(/export const STALE_READ\b/g) ?? []).length, 1);
  check("and neither panel spells its own", [/const STALE_READ\b/.test(systemsPanel), /const STALE_READ\b/.test(agentsPanel)], [false, false]);
  check("and both draw the shared one", [/\{STALE_READ\}/.test(systemsPanel), /\{STALE_READ\}/.test(agentsPanel)], [true, true]);
  check("which is seven words and names the subject", [STALE_READ.split(/\s+/).length, /^Machine status/.test(STALE_READ)], [7, true]);

  /*
   * The key box is a form: Enter submits through `onSubmit` and there is no
   * hand-wired Enter handler standing in for one.
   */
  const keyForm = systemsPanel.slice(systemsPanel.indexOf("export function KeyOnly("));
  check("the key input sits in a form that submits", [/<form[^>]*onSubmit=/.test(keyForm), /<Button type="submit"/.test(keyForm)], [true, true]);
  check("and no Enter handler is wired by hand", /onKeyDown/.test(keyForm), false);
  /*
   * The removal names the key, and the consequence lives in the question rather
   * than at rest (decision 10A): nothing above the resting button says what a
   * removal costs.
   */
  check("the removal question names the key and its cost", /Remove the \{keyName\}\? New sessions pointed at/.test(keyForm), true);
  check("and no paragraph at rest restates it", /Sessions pointed at \{system\.displayName\} sign with this key/.test(keyForm), false);

  /* The lede is gone from the systems screen, and the prop that gated it. */
  check("MachineSystemsSection takes no lede", /\blede\b/.test(machineSystems), false);
  check("and says nothing about where credentials are stored", /Stored on/.test(machineSystems), false);
  check("while the unreachable sentence keeps its pinned half", /is not reachable right now/.test(machineSystems), true);
  check("without the trailing clause about the system", /can be read or changed/.test(machineSystems), false);
}
