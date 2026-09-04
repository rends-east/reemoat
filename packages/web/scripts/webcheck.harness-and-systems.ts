import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";
import { type SystemInfo } from "./webcheck.modules.js";

process.stdout.write("\nwhich harness can be pointed at which system\n");
{
  const { allModels, choiceRefusal, defaultAgentName, customAgentSubline, groupModels, harnessRowRefusal, hostable, keyMissing, listedByBuild, readyFirst, searchModels, supportingHarnesses } =
    await import("../src/agents.js");

  const system = (over: Partial<SystemInfo> = {}): SystemInfo => ({
    id: "moonshot",
    displayName: "Moonshot",
    apiType: "anthropic",
    routable: true,
    nativeHarness: "kimi",
    loginVia: "kimi",
    models: [{ id: "kimi-k2-thinking", name: "Kimi K2 Thinking" }],
    keySet: true,
    keyUpdatedAt: 1,
    ...over,
  });

  // The three answers the pinned adapters gave, measured 2026-08-25 — the same
  // fixtures `daemoncheck` uses, because a client that disagreed with the daemon
  // about these would grey out a pairing the machine would happily start.
  const claude = { providerId: "main", supported: ["anthropic", "bedrock", "vertex"] };
  const codex = { providerId: "custom-gateway", supported: ["openai"] };

  check("a native pairing needs no routing at all", hostable("kimi", system(), null), null);
  check("a routable one is allowed", hostable("claude", system(), claude), null);
  /*
   * ⚠ **These are sentences somebody reads on a phone, and the first set was
   * not.** A refusal said "Codex accepts openai systems, and Moonshot is
   * anthropic" — every noun a protocol name, three of which look like companies,
   * none of which appears anywhere else in the app. So the assertions are on the
   * *words* rather than on "a string came back": the harness by the name the
   * screen calls it, the system by its display name, and no wire vocabulary at
   * all. `apiType` and `supported` stay in the code, which is the only place they
   * mean anything.
   */
  /*
   * ⚠ **The second half is the vocabulary the *name* refusals added.** Splitting a
   * spelling failure out of a protocol failure put `ModelChoice`'s own fields one
   * substitution away from the screen: `modelName` is "K2", `modelId` is
   * `kimi-k2-thinking`, and `source` is the literal `"published"` or `"table"` —
   * three values that read as English in a template and are wire words to the
   * person holding the phone. A refusal that named one would look entirely
   * plausible in review. The `/` catches the other spelling of the same mistake:
   * a published id is always `<cli>/<model>`, and no sentence in this app has a
   * slash in it.
   */
  const noJargon = (why: string | null): boolean =>
    why !== null &&
    !/\banthropic\b|\bopenai\b|\bapiType\b|\bprovider(Id)?\b|\bsupported\b/i.test(why) &&
    !/\bmodelId\b|\bmodelName\b|\bnativeHarness\b|\bpublished\b|\btable\b|\bsource\b|\//i.test(why);
  /*
   * ⚠ **The predicate's own negative controls, before anything is weighed against
   * it.** Every consumer below hands it a sentence that already passes, so both
   * character classes and the `null` guard were only ever exercised in the
   * direction that succeeds: replacing both with patterns matching nothing —
   * making `noJargon` answer `true` for every non-null string — left this whole
   * section green, the seven-arm sweep at the bottom included. An assertion that
   * cannot fail is not one. The daemon-side twin in `scripts/daemoncheck.ts`
   * asserts its own negative for exactly this reason, and says at length why the
   * two rules differ rather than being shared.
   *
   * The first is the string `agents.ts`'s own docblock records as having shipped,
   * so the control is the real failure rather than an invented one.
   */
  check("the vocabulary rule catches the sentence that really shipped", noJargon("Codex accepts openai systems, and Moonshot is anthropic."), false);
  /*
   * And the second arm, which is the half the name split added: `modelId` is what
   * the daemon is handed, a published id is always `<cli>/<model>`, and no
   * sentence in this app has a slash in it. This one is jargon-free by the first
   * arm's list, so it reaches the second or nothing does.
   */
  check("and an id where a name goes, which no arm above it would see", noJargon("Kimi Code cannot run kimi-code/k3."), false);
  // `null` is not a sentence, which is what the leading conjunct is for — a
  // refusal that never came must not read as a well-written one.
  check("and a refusal that never came is not a well-written refusal", noJargon(null), false);
  check(
    "a protocol mismatch names the harness and the system, in words",
    [hostable("codex", system(), codex), noJargon(hostable("codex", system(), codex))],
    ["Codex cannot run Moonshot models.", true],
  );
  /*
   * A harness that will not be re-pointed at all is kimi, and it gets its own
   * sentence rather than the mismatch above: "cannot run Moonshot models" would be
   * false of it in the one case that matters, since Moonshot is the system it
   * natively reaches. What is true of it is that it runs nothing else.
   */
  check(
    "a harness that answers nothing says what it does instead",
    [
      hostable("kimi", system({ nativeHarness: "claude" }), null),
      noJargon(hostable("kimi", system({ nativeHarness: "claude" }), null)),
    ],
    ["Kimi Code only runs its own models.", true],
  );
  /*
   * ⚠ **Routability is the daemon's answer, not a guess from the model list.** It
   * was `models.length === 0`, which conflates "no endpoint to point anything at"
   * with "nobody has written the names down yet" — and `undefined`, what an older
   * daemon sends, has to read as *not* routable so a stale client greys a pairing
   * rather than offering one that fails at the start.
   */
  /*
   * ⚠ **This one names the harness to switch *to*, and that is why it is its own
   * sentence rather than the shared one above.** The other two share a remedy —
   * pick something else — while this has a remedy on the screen below it: the CLI
   * that reaches this system natively is one of the three rows in the harness
   * picker.
   */
  check(
    "a system nothing can be pointed at names the CLI that reaches it",
    hostable("claude", system({ routable: false }), claude),
    "Only Kimi Code can run Moonshot models.",
  );
  check(
    "and a daemon too old to say is read the same way",
    hostable("claude", system({ routable: undefined }), claude),
    "Only Kimi Code can run Moonshot models.",
  );
  check(
    "with no CLI either, it says so rather than naming nobody",
    hostable("claude", system({ routable: false, nativeHarness: null }), claude),
    "Moonshot cannot be reached from this machine.",
  );

  /*
   * ⚠ **The fourth arm, which this file could not express and had a paragraph
   * admitting it.** The daemon folds `ROUTED_MODEL_ENV` into its own refusal so
   * that a pairing it can *route* but cannot *pin* never reaches a session — that
   * state starts, looks right, and quietly runs the endpoint's default model. Only
   * one boolean crosses, on `routing`, so this side asks the question without
   * holding the table.
   *
   * It was unreachable and only by coincidence: every routed provider this product
   * ships is `anthropic`-shaped, and codex — the one routing-capable harness with
   * no arm — is refused one arm earlier. A plugin adding an `openai`-shaped
   * provider ends that coincidence, and a plugin adding a harness that names no
   * model variable is the other half of it.
   */
  check(
    "a harness that cannot be told which model to run is refused",
    hostable("claude", system(), { ...claude, pinsModel: false }),
    "Claude Code cannot run Moonshot models.",
  );
  /*
   * ⚠ **And it shares a sentence with the protocol arm, deliberately.** This file
   * earns a second string only where the *remedy* differs — a system nothing can
   * be routed at names the CLI that reaches it, which is a row on the screen
   * below. "Does not speak the protocol" and "cannot be told which model to run"
   * share a remedy exactly: pick something else.
   */
  check(
    "and it is the same sentence the protocol arm draws, because the remedy is",
    // The same harness on both sides, or the comparison is about whose name is in
    // the sentence rather than about which arm produced it.
    hostable("claude", system(), { ...claude, pinsModel: false }) ===
      hostable("claude", system({ apiType: "openai" }), claude),
    true,
  );
  /*
   * ⚠ **Absent means yes, which is the opposite fallback from `routable` above and
   * is airtight rather than optimistic.** A daemon too old to send this is one with
   * no plugin catalogue, so the only harness it can route is the one that has
   * always had an arm — there is no version of an older daemon for which `false`
   * is the safe answer, and answering `false` would grey Claude Code out on every
   * un-updated machine in the fleet.
   */
  check("while a daemon too old to say is read as yes", hostable("claude", system(), claude), null);
  check("and so is one that says yes", hostable("claude", system(), { ...claude, pinsModel: true }), null);

  /*
   * ⚠ **A missing key and an impossible pairing are two different sentences, and
   * they stay two functions for that reason.** One sends somebody to a sign-in
   * screen and the other to a different choice; folding them would send half the
   * readers to the wrong place. `hostable` is the pairing half and is what the
   * checks above drive.
   *
   * ⚠ **The key half has moved down this file, and *why* it had to is the whole
   * of this run's correction.** Three checks stood here, driving a predicate that
   * took a bare system — drivable this early precisely because its subject was a
   * provider. It is `keyMissing(choice)` now and cannot be asked anything until
   * the two spellings exist as fixtures, which is exactly the point: **a key is a
   * fact about a row, never about a provider.** The old predicate was deleted
   * rather than corrected, because a corrected one would answer a question no
   * screen in this app asks; its three properties are re-expressed below, where
   * `published` and `tabled` are in scope.
   *
   * The deleted name is deliberately not written out here. `docscheck` resolves
   * every symbol `docs/DECISIONS.md` cites against this repository's sources, and
   * this file is one of them — so a driver that kept the identifier alive in prose
   * would quietly satisfy the citations that are supposed to fail now.
   */

  /*
   * The catalogue is the whole fleet's models, never one harness's — because the
   * screen asks for the model first, and narrowing would make picking a harness
   * silently delete choices rather than grey them.
   */
  const anthropic = system({
    id: "anthropic",
    displayName: "Anthropic",
    nativeHarness: "claude",
    loginVia: "claude",
    models: [],
  });
  const caps = {
    claude: {
      models: [
        { id: "default", name: "Default", description: null, group: null },
        { id: "opus", name: "Opus 5", description: null, group: null },
      ],
      routing: claude,
      error: null,
    },
    kimi: { models: [], routing: null, error: null },
  };
  const listed = allModels([anthropic, system()], caps as never);
  /*
   * ⚠ **A model id is not portable across harnesses even inside one system, and
   * only a live render found it.** The kimi CLI publishes `kimi-code/k3` — its
   * own name for a Moonshot model — while Moonshot's Anthropic endpoint, which is
   * what Claude Code gets routed at, wants `kimi-k2-thinking`. Offering kimi's
   * spellings under Claude Code produced a list that looked complete and would
   * have failed at the provider. `source` is what tells the two apart, and
   * `choiceRefusal` is what reads it.
   *
   * ⚠ It is about **names**, never about models. The two lists overlap in models
   * and not in spellings — kimi's `kimi-code/kimi-for-coding` is named "K2.7
   * Coding" — so nothing here may be read as "that harness has no K2".
   */
  const moonshot = system();
  const published = { system: moonshot, modelId: "kimi-code/k3", modelName: "K3", source: "published" } as const;
  const tabled = { system: moonshot, modelId: "kimi-k2-thinking", modelName: "K2", source: "table" } as const;
  check("a routed harness may not use the CLI's own spelling", choiceRefusal("claude", published, claude) !== null, true);
  check("but may use the endpoint's", choiceRefusal("claude", tabled, claude), null);
  check("and the native harness is the exact mirror", [
    choiceRefusal("kimi", published, null),
    choiceRefusal("kimi", tabled, null) !== null,
  ], [null, true]);
  /*
   * ⚠ **This says what the sentence is, and it never said anything about the
   * order.** The comment it carried claimed one — "a missing key is the only one
   * of the three a person can act on from this screen, so it is what a row says"
   * — and the fixture below has no competing failure in it at all: a routable
   * system, the spelling its endpoint answers to, so `pairFailure` is silent and
   * the key is the only thing left to speak. The check passed under key-first and
   * passes under settled-first, which makes it an assertion that cannot fail
   * about the property it was named for.
   *
   * The claim has also stopped being true. It rested on the `KeyOnly` box being
   * mounted under the pair on the builder — the key really was the one blocker
   * clearable without leaving the screen — and there is no authorization on that
   * screen any more, so every remedy is off it and the two kinds part on cost
   * instead: a settled failure is permanent, a missing key is a trip to Settings.
   * The ordering is asserted below, on pairs that carry **both**, where it can
   * actually fail.
   */
  check(
    "a pairing refused for nothing but a key says so",
    choiceRefusal("claude", { ...tabled, system: system({ nativeHarness: null, keySet: false }) }, claude),
    "No Moonshot key on this machine.",
  );
  /*
   * ⚠ **A key belongs to the *row*, and both earlier readings of it shipped.**
   * The first read it as a fact about the **system**: Moonshot has a native
   * harness, so a system-level answer was `null` for it unconditionally — true of
   * Kimi Code, which signs with whatever `kimi login` wrote, and false of Claude
   * Code routed at it, which signs with the pasted key and nothing else. With none
   * saved the whole flow was green: model offered, harness offered, `Add agent`
   * enabled, the preset written — and `POST /sessions` then refused with "No key
   * is saved for Moonshot on this machine", after a worktree had been made.
   * Reported as not being able to use Kimi's models with Claude Code at all.
   * Q3.485.
   *
   * ⚠ **That fix left one arm still asking the system, and it was the model
   * screen's — the arm this driver pinned as correct.** With no harness chosen it
   * answered: which kind of pairing this will be is undecided, so only a system
   * *nothing* reaches natively is knowably stuck. Sound while both routes into a
   * system offered the same ids, and false from the moment `source` recorded that
   * they do not. Reported off a screenshot of one list, on a machine with neither
   * key: `Kimi K2` and `Kimi K2 Turbo` pressable — refused a screen later, on the
   * harness picker — while `GLM-4.6` and `GLM-4.5 Air` were greyed on the spot.
   * Both were equally stuck. Moonshot *is* reached natively, just never at that
   * spelling: Kimi Code publishes "K2.7 Coding", "K2.7 Coding Highspeed", "K3" and
   * "K3-256k", and `kimi-k2-thinking` is not among them.
   *
   * ⚠ **The rule that replaced it is total, and it is asserted below as an
   * equivalence rather than as examples for exactly that reason.** `pairFailure`
   * refuses a native harness a table id and refuses every non-native harness a
   * published one, so a table-spelled model can only ever run **routed** — a key,
   * always — and a published one can only ever run **natively** — a key, never.
   * So: **a model needs a key iff its id came from the table**, and `nativeHarness`
   * is not consulted at all. What made the old arm wrong was that `nativeHarness`
   * stood in for "could this be reached natively", which is right about a *system*
   * and wrong about a *row*.
   */
  const unkeyed = system({ keySet: false });
  check(
    "a routed pairing needs the key, which is every table-spelled model there is",
    keyMissing({ ...tabled, system: unkeyed }, null),
    "No Moonshot key on this machine.",
  );
  check(
    "a native one does not, which is every published one",
    keyMissing({ ...published, system: unkeyed }, null),
    null,
  );
  /*
   * ⚠ **And this is the half that must not regress**, driven on the screen the
   * regression would show on. "K2.7 Coding" is published by Kimi Code itself, so
   * a machine with no Moonshot key still offers it — the native harness signs with
   * its own login and needs nothing pasted. A key check written against the system
   * greys it, which hides a working option; that is a worse failure than the bug
   * being fixed here, because a greyed row that would have run is invisible.
   */
  check(
    "a published model of a keyless system is offered on the model screen too",
    choiceRefusal(null, { ...published, system: unkeyed }, null),
    null,
  );
  /*
   * ⚠ **The three checks the deleted system-level predicate carried, re-expressed
   * against the rule that replaced it.** Two of them survive with the same outcome
   * — a system no CLI reaches offers table ids and nothing else, so asking the row
   * and asking the provider happen to agree there — and they are kept because that
   * agreement is a coincidence of that system's shape rather than a property of
   * the rule. The third read "a native system is never blocked by a missing key",
   * and was argued from `GET /agent-auth` being the real sign-in answer while
   * `keySet` knows only about a pasted key. That argument is still true and its
   * conclusion is now only half true: it is the pair two checks up, split in two,
   * and only the published half survives.
   */
  const keyOnly = (keySet: boolean): SystemInfo => system({ nativeHarness: null, keySet });
  check("a system with no CLI and no key is blocked", keyMissing({ ...tabled, system: keyOnly(false) }, null) !== null, true);
  check("with a key it is not", keyMissing({ ...tabled, system: keyOnly(true) }, null), null);
  /*
   * ⚠ **THE RULE ITSELF, as a biconditional over a generated matrix.** Two
   * hand-picked examples are what shipped the defect: this section already
   * asserted a native system's answer and a key-only system's answer, both
   * passing, and the row that was wrong was a third shape nobody had typed out. So
   * the whole space is generated — `source` × has-a-native-harness × key-saved,
   * with **no harness chosen**, which is the model screen's own state — and each
   * cell is compared against the rule rather than against a literal: a row is
   * greyed for a key **iff** its id came from the table and its system has no key.
   *
   * `nativeHarness` is one of the three axes on purpose. It is the field the old
   * arm consulted, so a rule that starts reading it again disagrees with the
   * biconditional in some cell whichever direction it leans, and this fails.
   *
   * Driven through `choiceRefusal(null, …)` rather than through `keyMissing`
   * directly, because that is the call the model screen makes. A rule that is
   * right in the predicate and lost on the way to the screen is the same defect
   * with a different address.
   */
  const keyCells = (["published", "table"] as const).flatMap((source) =>
    ([true, false] as const).flatMap((native) =>
      ([true, false] as const).map((keySet) => {
        const host = system({ nativeHarness: native ? "kimi" : null, keySet });
        const choice = { ...(source === "published" ? published : tabled), system: host };
        return {
          label: `${source}/${native ? "native" : "no CLI"}/${keySet ? "key" : "no key"}`,
          greyed: choiceRefusal(null, choice, null) !== null,
          rule: source === "table" && !keySet,
        };
      }),
    ),
  );
  check(
    "a model is greyed for a key iff its id came from the table and no key is saved",
    keyCells.filter((cell) => cell.greyed !== cell.rule).map((cell) => cell.label),
    [],
  );
  /*
   * ⚠ **The sweep's own control, because an equivalence over a matrix where
   * neither side moves is satisfied by a rule that answers the same thing
   * everywhere.** Naming the greyed cells rather than counting them is what makes
   * it one: `table/native/no key` is the row in the screenshot, and its presence
   * beside `table/no CLI/no key` — with nothing else on the list — is the whole
   * defect and the whole fix in one expectation.
   */
  check(
    "and both sides of it move, over all eight cells",
    [keyCells.filter((cell) => cell.greyed).map((cell) => cell.label), keyCells.length],
    [["table/native/no key", "table/no CLI/no key"], 8],
  );
  /*
   * ⚠ **And once a harness *is* chosen the biconditional above stops being the
   * rule — the pairing is — which is a precondition expiring rather than a rule
   * being broken.** The published arm rested on "every other harness is refused
   * this id for the **name**", true of every system until one related its two
   * spellings. `nativeModelPrefix` makes `pairFailure` drop both name arms, so on
   * OpenRouter a *published* id really is runnable routed, and a routed pairing is
   * signed by the system credential and by nothing else.
   *
   * Measured, and this is the report: an `OPENROUTER_API_KEY` saved for opencode
   * and **no** system key. opencode published all 356 rows, so they arrived
   * `published`, `keyMissing` answered `null`, Claude Code was offered against one
   * of them, `POST /custom-agents` took it — and `applySystem` refused the start
   * with *"No key is saved for OpenRouter on this machine, so nothing can sign
   * these requests."* Two credentials, two stores, and neither screen had asked
   * for the one that signs.
   *
   * Driven over the pairing rather than at the one cell: what must hold is that
   * *routed* answers the key question from `keySet` whatever the source, and that
   * *native* still never does.
   */
  const orPrefixed = system({
    id: "openrouter",
    displayName: "OpenRouter",
    nativeHarness: "opencode",
    nativeModelPrefix: "openrouter/",
    keySet: false,
  });
  const orPub = { system: orPrefixed, modelId: "qwen/q3", modelName: "Qwen: Q3", source: "published" as const };
  check(
    "a routed pairing needs the key even where the id came from the native harness",
    [
      keyMissing(orPub, "claude"),
      keyMissing(orPub, "opencode"),
      keyMissing(orPub, null),
      keyMissing({ ...orPub, system: { ...orPrefixed, keySet: true } }, "claude"),
    ],
    ["No OpenRouter key on this machine.", null, null, null],
  );
  /*
   * And the row says so, on the screen where the pairing is chosen — which is the
   * one that offered it. `harnessRowRefusal` reaches `keyMissing` only after
   * `pairFailure` has cleared, which on this system it does precisely because the
   * two spellings relate.
   */
  check(
    "so the harness row greys rather than the start failing",
    harnessRowRefusal("claude", orPub, { providerId: "main", supported: ["anthropic"] }),
    "No OpenRouter key on this machine.",
  );
  /*
   * ⚠ **The property that was actually reported, which is consistency rather than
   * any particular value.** One list, one machine, neither key saved: `Kimi K2`
   * pressable and `GLM-4.6` greyed. Two rows in the same situation reading
   * differently is what this app forbids everywhere, and it is worth an assertion
   * in exactly that shape — the two real systems, not two variations of one
   * fixture. Moonshot is reached natively by Kimi Code and is routable; Z.ai is a
   * system no CLI ships for. Both are asked for their **table** spelling, which is
   * the only spelling either can offer a routed harness, and which is what the
   * model screen draws.
   */
  const zai = system({
    id: "zai",
    displayName: "Z.ai (GLM)",
    nativeHarness: null,
    loginVia: null,
    keySet: false,
    models: [{ id: "glm-4.6", name: "GLM-4.6" }],
  });
  const moonshotRow = choiceRefusal(null, { system: unkeyed, modelId: "kimi-k2-thinking", modelName: "Kimi K2", source: "table" }, null);
  const zaiRow = choiceRefusal(null, { system: zai, modelId: "glm-4.6", modelName: "GLM-4.6", source: "table" }, null);
  check(
    "two keyless systems' table rows are refused alike, native harness or not",
    [moonshotRow, zaiRow],
    ["No Moonshot key on this machine.", "No Z.ai (GLM) key on this machine."],
  );
  /*
   * And the same pair as an *identity*, so a reworded sentence keeps being asserted
   * rather than silently dropping this check to two updated literals: it is one
   * sentence with the provider substituted, never two sentences that agree today.
   */
  check(
    "and it is one sentence with the provider substituted, not two that agree",
    moonshotRow?.replace("Moonshot", "«") === zaiRow?.replace("Z.ai (GLM)", "«"),
    true,
  );
  check(
    "and the whole pair is refused, so the button is still the gate",
    choiceRefusal("claude", { ...tabled, system: unkeyed }, claude),
    "No Moonshot key on this machine.",
  );
  /*
   * ⚠ **The harness row is greyed for it now, and the carve-out that used to be
   * asserted here fell with its own premise.** The paragraph this replaces read:
   * "a missing key is the one blocker somebody can clear without changing either
   * choice, and the box that clears it is on the builder — so greying the row that
   * leads there would hide the only screen that can unblock it". Every clause of
   * that was a fact about the inline `KeyOnly` box mounted under the pair, and it
   * held for exactly as long as the box did. **The box is gone**: nobody ever
   * signed in on that screen, and there is no authorization on it at all now — the
   * section above this one is what holds that. Greying the row therefore hides
   * nothing, and an option with no way in has to read as unavailable rather than
   * as available-and-then-refused.
   *
   * ⚠ **This is not the bug the box was added for coming back**, and the direction
   * is what says so. That one went green the whole way — model offered, harness
   * offered, `Add agent` enabled, the preset written — and `POST /sessions`
   * refused *after* a git worktree had been made, with the remedy four taps away
   * and the trip there unmounting the builder and losing the half-assembled agent.
   * The refusal now lands **two screens earlier**, in the picker, before anything
   * is created: the row is greyed, the button is off, the sentence names what is
   * missing, and there is no draft to lose because there is no draft yet. The
   * cost, whole and stated where it is paid: the first routed pairing to a system
   * needs its key pasted under Settings → Machines → that system, once per system
   * per machine.
   */
  check(
    "a missing key greys the harness row, because nothing on this screen can clear it",
    harnessRowRefusal("claude", { ...tabled, system: unkeyed }, claude),
    "No Moonshot key on this machine.",
  );
  /*
   * ⚠ **And this is the ordering assertion, which is what it was all along.** The
   * fixture is codex over an **unkeyed** system, so both facts are true of it at
   * once — a protocol codex will never speak, and a key nobody has pasted — and a
   * key-first row would answer "No Moonshot key on this machine." here, selling a
   * trip to Settings that ends at the same greyed row. It was named for a
   * fixable/unfixable split that no longer describes the two: both are refusals
   * now, and what separates them is that one is permanent and the other is a trip.
   */
  check(
    "while a settled failure outranks it, on a row a key could not rescue",
    harnessRowRefusal("codex", { ...tabled, system: unkeyed }, codex),
    "Cannot run K2.",
  );
  /*
   * ⚠ **The same order on the builder, as a pair with the row**, so a re-order
   * fails on both screens rather than on whichever one somebody remembered. These
   * two are one pairing seen from two places — the greyed row in the picker, and
   * the sentence beside the disabled button one screen later — and `choiceRefusal`
   * used to weigh the key first while `harnessRowRefusal` weighed it last. One
   * pair would then have carried two different reasons depending on which screen
   * was looking at it, and {@link harnessRowRefusal}'s own docblock line — "the
   * same refusals, in the same order, on a row already titled with the harness" —
   * would have been false.
   */
  check(
    "one pair, one reason, on the row and on the button under it",
    [
      harnessRowRefusal("codex", { ...tabled, system: unkeyed }, codex),
      choiceRefusal("codex", { ...tabled, system: unkeyed }, codex),
    ],
    ["Cannot run K2.", "Codex cannot run K2."],
  );
  // The name half of the same ordering: a spelling no key can add to a list.
  check(
    "and a spelling outranks it too",
    choiceRefusal("claude", { ...published, system: unkeyed }, claude),
    "Claude Code has no model called K3.",
  );
  /*
   * ⚠ **One string, three call sites**, which is what stops somebody "improving"
   * the row's wording into a second sentence for one fact. The other two sublines
   * drop the harness because it titles the row they are drawn on; this one never
   * named the harness, so there is nothing to drop — it names the **system**,
   * because its remedy is a different screen and the system is what somebody goes
   * looking for there. Asserted as an identity rather than as three copies of the
   * literal, so a reworded sentence has to be reworded in one place or fail here.
   */
  check(
    "the row, the button and the rule itself all say the same sentence",
    [
      harnessRowRefusal("claude", { ...tabled, system: unkeyed }, claude) === keyMissing({ ...tabled, system: unkeyed }, "claude"),
      choiceRefusal("claude", { ...tabled, system: unkeyed }, claude) === keyMissing({ ...tabled, system: unkeyed }, "claude"),
    ],
    [true, true],
  );
  /*
   * ⚠ **A fact, and not the way there** — this app's standing rule for a refusal,
   * and the one place it is under real pressure, because the state below is a
   * harness screen with **every** row greyed and therefore no ungreyed row
   * carrying the remedy. Three things decide it anyway, and they are why the
   * pattern below forbids the instruction rather than merely not requiring it. A
   * subline is one `truncate`d line (`ChoiceRow`, in `bits.tsx`), so a second
   * sentence is the half that gets clipped — the half that would have been the
   * reason for adding it. The place is four levels deep, and "in Settings" points
   * at a screen with several sections and no indication which, which is a
   * plausible wrong instruction rather than no instruction. And the identical
   * string is drawn on the builder's status line, which does **not** truncate, so
   * an instruction inside it would read two different ways in two places.
   */
  check(
    "and it tells nobody where to go, on a screen where every row can be greyed",
    /Settings|Machines|Add|Paste|Go to/.test(keyMissing({ ...tabled, system: unkeyed }, "claude") ?? ""),
    false,
  );
  /*
   * ⚠ **The arm a key check written before the native test would break.** A native
   * pairing signs with whatever its own CLI's login wrote and needs nothing
   * pasted, however unkeyed the system is — Kimi Code at Moonshot is the whole
   * headline — so the row that reaches it stays live in exactly the state where
   * the two beside it do not.
   */
  check(
    "a native pairing is still not greyed, however unkeyed the system",
    harnessRowRefusal("kimi", { ...published, system: unkeyed }, null),
    null,
  );
  /*
   * ⚠ **Every row greyed at once, which is a state this screen did not have
   * before and now reaches through the ordinary flow**: a table-spelled model on a
   * system nobody has pasted a key for. It is the honest answer — with no key
   * nothing on this machine can run that spelling — and each row's reason is
   * different and each is true: the routable one is waiting on the key, the one
   * that cannot be pointed there says so, and the native one has never heard of
   * that name. The actionable sentence is on the row it belongs to rather than
   * spread over three.
   */
  check(
    "all three rows can be greyed, each for its own true reason",
    (["claude", "codex", "kimi"] as const).map((harness) =>
      harnessRowRefusal(harness, { ...tabled, system: unkeyed }, { claude, codex, kimi: null }[harness]),
    ),
    ["No Moonshot key on this machine.", "Cannot run K2.", "No model called K2."],
  );
  /*
   * ⚠ **The whole table rather than the cell that changed**, which is this file's
   * standing rule for exactly this shape: three harness states (none chosen, the
   * native one, a routed one) against a system that is either reachable natively
   * or key-only, against a key that is either saved or not — and both functions
   * asked at every cell. Driving only the interesting cells is how the two
   * orderings came apart in the first place, and how "a native system with no key
   * is still offered" — the invariant the headline feature *is* — would have been
   * lost to a key check written one line too early.
   *
   * Each harness is handed the spelling that pairs with it, so the key is the only
   * thing varying down a column: the native CLI gets its own published id and a
   * routed one gets the id the endpoint answers to.
   *
   * ⚠ **`nobody` is drawn twice, and it had to be.** The column used to hand the
   * no-harness state the table id alone, which is *a* thing the model screen draws
   * and not the only one — so the grid could not tell a key rule that reads the
   * row from one that greys every unkeyed provider outright, and the published
   * column is precisely where those two differ. `nobody · published` is the
   * headline feature as a cell: "K2.7 Coding" on a machine with no Moonshot key.
   */
  const grid = (): string[] =>
    ([
      ["reachable natively, key saved", system()],
      ["reachable natively, no key", system({ keySet: false })],
      ["key-only, key saved", system({ nativeHarness: null })],
      ["key-only, no key", system({ nativeHarness: null, keySet: false })],
    ] as const).flatMap(([where, host]) =>
      ([
        ["nobody", null, tabled],
        ["nobody · published", null, published],
        ["kimi", "kimi", published],
        ["claude", "claude", tabled],
      ] as const).map(([column, harness, spelling]) => {
        const choice = { ...spelling, system: host };
        const routing = harness === "claude" ? claude : null;
        const row = harness === null ? "—" : harnessRowRefusal(harness, choice, routing);
        return `${where} / ${column}: ${choiceRefusal(harness, choice, routing) ?? "—"} | ${row ?? "—"}`;
      }),
    );
  check("every cell of the pairing table, on the model screen and on the harness screen", grid(), [
    // Everything saved and everything native: nothing to say anywhere.
    "reachable natively, key saved / nobody: — | —",
    "reachable natively, key saved / nobody · published: — | —",
    "reachable natively, key saved / kimi: — | —",
    "reachable natively, key saved / claude: — | —",
    // ⚠ The cell in the screenshot, and the pair of cells that is the whole rule.
    // A table spelling can only ever be run routed, so with no key it is refused
    // on the model screen however native the *provider* is — while the published
    // spelling on that same provider stays offered, because its only route is the
    // native CLI's own login. Reading `nativeHarness` here answers both cells the
    // same way, and either answer is wrong about one of them.
    "reachable natively, no key / nobody: No Moonshot key on this machine. | —",
    "reachable natively, no key / nobody · published: — | —",
    "reachable natively, no key / kimi: — | —",
    "reachable natively, no key / claude: No Moonshot key on this machine. | No Moonshot key on this machine.",
    // Nothing reaches it natively, so the native CLI is refused for the protocol
    // and the key — which is saved — buys the routed one everything.
    "key-only, key saved / nobody: — | —",
    "key-only, key saved / nobody · published: — | —",
    "key-only, key saved / kimi: Kimi Code cannot run K3. | Cannot run K3.",
    "key-only, key saved / claude: — | —",
    // And with the key gone the model screen speaks too, because now nothing on
    // the machine reaches this system at all.
    "key-only, no key / nobody: No Moonshot key on this machine. | —",
    // ⚠ The one cell in this table that `allModels` cannot produce, kept and
    // labelled rather than dropped: a published spelling only exists where
    // `nativeHarness !== null`, since the published list is read off
    // `capabilities[native].models`. It is a fixture-only state, it was one before
    // this run too, and it is the single cell where the model screen says nothing
    // while every harness row refuses. Deleting it would leave the grid unable to
    // say which of its cells are reachable.
    "key-only, no key / nobody · published: — | —",
    "key-only, no key / kimi: Kimi Code cannot run K3. | Cannot run K3.",
    "key-only, no key / claude: No Moonshot key on this machine. | No Moonshot key on this machine.",
  ]);
  /*
   * ⚠ **A `null` harness refuses no *pairing*, and that is what un-deadlocked the
   * two pickers.** Both screens greyed rows against the other's value: with Claude
   * Sonnet chosen, every OpenAI row was disabled on the model screen *and* Codex
   * was disabled on the harness screen, so neither half of the pair could be
   * changed and the only way out was to abandon the draft. The model screen weighs
   * with `null` now — a fact about the **row** still greys it, because its remedy
   * is a different screen — and the harness screen is where a pairing is decided.
   * Q3.479. The noun in that sentence used to be "the system", and correcting it
   * to "the row" is this run's whole change: a key is asked of the spelling, which
   * decides by itself which route the pairing will have to take.
   */
  /*
   * ⚠ **And this is the line the key refusal still stops at, restated because the
   * old statement of it was the defect.** It used to read that a key check must
   * not reach the model screen at all, on the grounds that with no harness chosen
   * there is no pairing to weigh — which greyed Z.ai and offered Moonshot for a
   * difference nobody could see. What the key must never do is grey a **published**
   * model, on either screen: that spelling runs only under the CLI that published
   * it, which signs with its own login. The three that hold that line are the
   * published arm of the biconditional above, the `nobody · published` column of
   * the grid, and the glyph sweep below.
   */
  check(
    "with no harness chosen, a pairing refuses nothing",
    [choiceRefusal(null, published, null), choiceRefusal(null, tabled, null)],
    [null, null],
  );
  check(
    "but a system with no key still says so",
    choiceRefusal(null, { ...tabled, system: system({ nativeHarness: null, keySet: false }) }, null),
    "No Moonshot key on this machine.",
  );
  /*
   * ⚠ **One heading per provider, and which harnesses a model is for is on the
   * row.** The heading split on the *route* for a release — `Moonshot · Kimi Code
   * only` beside `Moonshot · other harnesses` — because one system is reachable
   * two ways with a different set of names on each, and seven undifferentiated
   * rows of "Moonshot" hid that no harness could run more than four of them. Right
   * problem, wrong place: a heading is where somebody looks for *whose model this
   * is*, and a route pushed into it invents a category nobody asked about while
   * leaving each row still silent about itself. Q3.486.
   */
  check(
    "a provider is one heading however many ways it is reached",
    groupModels([published, tabled]).map((group) => group.system.displayName),
    ["Moonshot"],
  );
  check("with every row under it", groupModels([published, tabled])[0]?.choices.length, 2);

  /*
   * **Which build published a group's models, and the three ways it declines.**
   *
   * The line exists because a model list is only ever as fresh as the binary that
   * published it, and a binary is only as fresh as whoever last refreshed it —
   * `deploy/agents.sh` daily, or nobody for an operator's own copy on PATH — with
   * no error and nothing on screen when a model released last week is simply
   * absent.
   *
   * ⚠ **The mixed-source case is the one that matters and it is why this is not
   * simply "name the native harness".** OpenRouter's rows are mostly a catalogue
   * the browser fetched, with a handful published by a keyed opencode; a sentence
   * naming opencode over that list is wrong about almost every row in it.
   */
  const buildCaps = (over: Record<string, unknown> = {}) =>
    ({ kimi: { models: [], routing: null, error: null, cli: { version: "0.29.2", source: "path" } }, ...over }) as never;
  const groupOf = (...rows: unknown[]) => groupModels(rows as never)[0] as never;

  check(
    "a group whose rows all came from one harness names the build that published them",
    listedByBuild(groupOf(published), buildCaps(), (id) => (id === "kimi" ? "Kimi Code" : id)),
    "Listed by Kimi Code 0.29.2.",
  );
  check(
    "an override reads like any other chosen build, because the operator chose it",
    listedByBuild(groupOf(published), buildCaps({ kimi: { models: [], routing: null, error: null, cli: { version: "9.9.9", source: "override" } } }), () => "Kimi Code"),
    "Listed by Kimi Code 9.9.9.",
  );
  check(
    "a binary that will not say which build it is still names the program",
    listedByBuild(groupOf(published), buildCaps({ kimi: { models: [], routing: null, error: null, cli: { version: null, source: "path" } } }), () => "Kimi Code"),
    "Listed by Kimi Code.",
  );
  /*
   * The three refusals, and they are different facts rather than one absence: a
   * mixed group has no single answer, a daemon too old to send the field is about
   * the *machine*, and a `null` is a read that failed. None of them may be drawn
   * as "unknown version" — that sends a reader looking in the wrong place.
   */
  check(
    "a group holding one table row says nothing at all, because no build published that row",
    listedByBuild(groupOf(published, tabled), buildCaps(), () => "Kimi Code"),
    null,
  );
  check(
    "nor does a daemon too old to have sent the field",
    listedByBuild(groupOf(published), { kimi: { models: [], routing: null, error: null } } as never, () => "Kimi Code"),
    null,
  );
  check(
    "nor one whose read found no binary to name",
    listedByBuild(groupOf(published), buildCaps({ kimi: { models: [], routing: null, error: null, cli: null } }), () => "Kimi Code"),
    null,
  );
  check(
    "and a provider no harness is native to has nobody to name",
    listedByBuild(
      groupModels([{ ...published, system: system({ nativeHarness: null }) }] as never)[0] as never,
      buildCaps(),
      () => "Kimi Code",
    ),
    null,
  );
  // A newer daemon's third `source` still names the build: the plain line, never
  // a refusal. There used to be a second sentence to fall into — the vendored
  // arm's "the copy installed with this app", the one line that claimed something
  // about where the copy came from — and it went with the vendored copies
  // (Q4.114), so there is one sentence left for a known source and an unknown one
  // alike.
  check(
    "and a source this build has never heard of draws the plain line",
    listedByBuild(groupOf(published), buildCaps({ kimi: { models: [], routing: null, error: null, cli: { version: "1.0.0", source: "future" } } }), () => "Kimi Code"),
    "Listed by Kimi Code 1.0.0.",
  );
  /*
   * ⚠ **And it stays one heading however many rows arrive — which is the *second*
   * thing taken out of this slot, and the reason it is driven at the size that
   * motivated it.** A vendor sub-heading shipped here for a day: OpenRouter's ids
   * carry a `vendor/` half, so a provider past a dozen prefixed rows drew
   * `OpenRouter · qwen`, `OpenRouter · google`, 38 of them. It answers *whose model
   * is this* honestly enough that the objection above does not catch it, and it was
   * still wrong on the screen — one list to scroll became 38 to scroll past, a
   * model's variants read as different products under a heading that separated
   * them, and the search this picker is actually used through already cuts the list
   * far below the size that argued for the split. Q3.503.
   *
   * The fixture is OpenRouter's real shape rather than Moonshot's, because
   * Moonshot could never have split: it is mixed, and the old rule needed *every*
   * id prefixed. A reintroduction has to fail on the provider it would be built
   * for, so that is the one asserted.
   */
  const or = (id: string, name: string) => ({
    system: system({ id: "openrouter", displayName: "OpenRouter", nativeHarness: "opencode", nativeModelPrefix: "openrouter/" }),
    modelId: id,
    modelName: name,
    source: "table" as const,
  });
  const many = (n: number, vendor: string) =>
    Array.from({ length: n }, (_, i) => or(`${vendor}/m${i}`, `M${i}`));
  check(
    "a provider past a dozen rows, every one of them prefixed, is still one heading",
    groupModels([...many(8, "qwen"), ...many(5, "google")]).map(
      (group) => `${group.system.displayName}: ${group.choices.length}`,
    ),
    ["OpenRouter: 13"],
  );
  check(
    "and so is one carrying the whole live catalogue",
    [groupModels(many(289, "qwen")).length, groupModels(many(289, "qwen"))[0]?.choices.length],
    [1, 289],
  );
  check(
    "a bare id among them changes nothing either way",
    groupModels([...many(12, "qwen"), or("plain", "Plain")]).map((group) => group.system.displayName),
    ["OpenRouter"],
  );

  /* ---------------------------------------------------------------- *
   * ⭐ Which provider is at the top, which is one bit per provider
   *
   * The daemon's `SYSTEM_IDS` is the **default** reading order and the client
   * floats over it: every provider this machine can actually run goes above every
   * provider it cannot, each half keeping the daemon's order. Driven rather than
   * read off disk — it is a pure function over one list, which is the shape this
   * file prefers wherever it can get it.
   *
   * ⚠ **Applied inside `allModels`, and the last check here is why.** The picker
   * draws headings off `groupModels` *and* a provider filter menu off the flat
   * catalogue in first-appearance order. Sorting the groups alone leaves that menu
   * naming providers in an order the list beside it no longer uses — two lists of
   * the same seven things, disagreeing, with nothing on screen to explain it.
   * ---------------------------------------------------------------- */
  const provider = (id: string, keySet: boolean, source: "published" | "table", model = "m") => ({
    system: system({ id, displayName: id, keySet, nativeHarness: null }),
    modelId: `${id}/${model}`,
    modelName: model,
    source,
  });
  const seen = (rows: readonly { system: { id: string } }[]): string[] => {
    const out: string[] = [];
    for (const one of rows) if (!out.includes(one.system.id)) out.push(one.system.id);
    return out;
  };
  check(
    "providers that are equally ready keep the order the daemon sent them in",
    seen(readyFirst([provider("a", true, "table"), provider("b", true, "table")])),
    ["a", "b"],
  );
  check(
    "and one this machine has a key for goes above one it does not",
    seen(readyFirst([provider("a", false, "table"), provider("b", true, "table")])),
    ["b", "a"],
  );
  /*
   * ⚠ **The Anthropic case, and it is why the predicate is `keyMissing` rather
   * than `keySet`.** A *published* id proves the native harness holds its own
   * credential, so a machine running Claude Code every day has Anthropic models it
   * can start and no `ANTHROPIC_API_KEY` saved anywhere. Floating on `keySet`
   * alone would sink the provider that machine actually uses beneath whichever
   * key-only endpoint somebody once pasted a key for.
   */
  check(
    "a provider with no key but a published model is ready, and floats",
    seen(readyFirst([provider("keyless-table", false, "table"), provider("published", false, "published")])),
    ["published", "keyless-table"],
  );
  /*
   * ⚠ **And what is at the top is what is not struck through — which stopped being
   * true when a harness could be chosen first.**
   *
   * The rule above is stated over `keyMissing`, because a missing key was the only
   * thing that struck a row through when it was written. `ModelPicker` later grew a
   * stronger refusal: with a harness chosen, `hostable` replaces a whole provider
   * with one sentence and a count. The sort did not know, so the two disagreed in
   * the ordinary case — reported from the screen, not found here.
   *
   * `anthropic` and `openai` are `routable !== true`, so no other harness may ever
   * be pointed at them, and both pass the key test because a published id proves
   * the native harness holds its own credential. With `opencode` chosen they took
   * rank 0 and 1 and were then collapsed to *"Only Claude Code can run Anthropic
   * models. 4 models hidden."* — two dead sections above the only provider with
   * rows in it.
   *
   * Driven with a harness rather than pinned off the picker's JSX: the collapse and
   * the sort must answer the *same* call, and only one of the two is reachable from
   * a source scan.
   */
  const native = (id: string, nativeHarness: NonNullable<SystemInfo["nativeHarness"]>, model = "m") => ({
    system: system({ id, displayName: id, keySet: false, nativeHarness, routable: false }),
    modelId: `${id}/${model}`,
    modelName: model,
    source: "published" as const,
  });
  const routable = (id: string, model = "m") => ({
    system: system({ id, displayName: id, keySet: true, nativeHarness: null, routable: true }),
    modelId: `${id}/${model}`,
    modelName: model,
    source: "table" as const,
  });
  const OPEN_ROUTING = { supported: [system().apiType] } as never;
  check(
    "with no harness chosen the order is exactly what it always was",
    seen(readyFirst([native("anthropic", "claude"), routable("openrouter")])),
    ["anthropic", "openrouter"],
  );
  check(
    "and a provider the chosen harness will collapse sinks under one it can run",
    seen(readyFirst([native("anthropic", "claude"), routable("openrouter")], "opencode", OPEN_ROUTING)),
    ["openrouter", "anthropic"],
  );
  check(
    "the native harness still floats its own provider, which is the case this must not break",
    seen(readyFirst([routable("openrouter"), native("anthropic", "claude")], "claude", null)),
    ["anthropic", "openrouter"],
  );
  /*
   * It sinks rather than vanishing. This app draws what it cannot offer and labels
   * it — filtering would answer "where did Anthropic go" with silence, which is the
   * rule `agent-strip.md` states for the row this picker sits two taps from.
   */
  check(
    "and a collapsed provider keeps its rows rather than being filtered out",
    readyFirst([native("anthropic", "claude"), routable("openrouter")], "opencode", OPEN_ROUTING).length,
    2,
  );
  /*
   * The order the sort is applied at, restated as a driven fact: `allModels` takes
   * the harness so the flat catalogue and the provider filter menu built from it
   * cannot end up in two different orders — the trap the block heading names.
   */
  check(
    "and `allModels` is where the harness reaches it, so the menu and the list agree",
    /readyFirst\(out, harness,/.test(
      stripComments(readFileSync(new URL("../src/agents.ts", import.meta.url), "utf8")),
    ),
    true,
  );
  /*
   * ⚠ **`some`, not `every`.** OpenRouter with no key of its own but a keyed
   * opencode publishing its rows is ready; demoting it for the catalogue-only rows
   * that would still ask for a key would put the list at odds with hundreds of its
   * own ungreyed lines.
   */
  /*
   * ⚠ **The ready provider is deliberately *second* in the input, and the first
   * draft of this check had it first — which asserted nothing.** With `plain`
   * ready and already at the front, `some` and `every` produce the same list, so
   * an `every` fold passed it, and so did the identity function. Measured: with
   * the ready one leading, replacing the set with an `every` fold left the whole
   * driver green. The mixed provider has to *overtake* an unready one for the
   * distinction to be visible at all.
   */
  check(
    "one runnable model is enough to float a provider",
    readyFirst([
      provider("dead", false, "table", "m1"),
      provider("mixed", false, "table", "m1"),
      provider("mixed", false, "published", "m2"),
    ]).map((one) => one.modelId),
    ["mixed/m1", "mixed/m2", "dead/m1"],
  );
  check(
    "and a provider with none of them stays below one that has",
    seen(
      readyFirst([
        provider("dead", false, "table", "m1"),
        provider("dead", false, "table", "m2"),
        provider("live", true, "table"),
      ]),
    ),
    ["live", "dead"],
  );
  /*
   * ⚠ **Stable, and a provider's own rows may not move.** `allModels` builds each
   * provider's list out of the published half and the table half with a dedupe
   * between them — an order this function has no opinion about and must not
   * disturb. Two rows of one provider compare equal and `Array.prototype.sort` has
   * been stable by specification since ES2019.
   */
  check(
    "the models inside a provider keep their own order",
    readyFirst([
      provider("late", false, "table", "m1"),
      provider("late", false, "table", "m2"),
      provider("late", false, "table", "m3"),
      provider("early", true, "table", "x"),
    ]).map((one) => one.modelId),
    ["early/x", "late/m1", "late/m2", "late/m3"],
  );
  /*
   * ⚠ **Three providers, because two cannot show the offset is wrong.** The sink
   * is `total` — the provider count — and at two providers a hardcoded `2` is
   * indistinguishable from it: every other fixture here passed with the literal in
   * place, measured. It is only past two that a wrong offset interleaves the
   * halves, and seven is the only size that ever runs in production. This also
   * pins the other half of the claim — that the unready half keeps the daemon's
   * order — which no two-provider case can say anything about.
   */
  check(
    "the unready half sinks whole, below a ready provider that came after both",
    seen(
      readyFirst([
        provider("p1", false, "table"),
        provider("p2", false, "table"),
        provider("p3", true, "table"),
      ]),
    ),
    ["p3", "p1", "p2"],
  );
  check("an empty catalogue answers an empty one", readyFirst([]), []);
  /*
   * ⚠ **And the catalogue itself is what carries it**, so the headings and the
   * provider filter menu are one list rather than two that must agree. Driven
   * through `allModels` rather than pinned as a call, because what matters is that
   * the array everything downstream reads is already in that order.
   */
  {
    const sunk = system({ id: "sunk", displayName: "Sunk", nativeHarness: null, keySet: false });
    const risen = system({ id: "risen", displayName: "Risen", nativeHarness: null, keySet: true });
    check(
      "the catalogue is handed out floated, so both lists drawn from it agree",
      [
        seen(allModels([sunk, risen], {} as never)),
        groupModels(allModels([sunk, risen], {} as never)).map((group) => group.system.id),
      ],
      [
        ["risen", "sunk"],
        ["risen", "sunk"],
      ],
    );
  }
  /*
   * ⚠ **And this is the shape the model picker refuses a pairing in: one heading,
   * never N rows.** The arithmetic is the whole argument, so it is driven.
   *
   * Measured against the live catalogue and the four real harnesses, 463 rows:
   * greying row by row greys **461 of 463** with codex chosen and 462 with kimi —
   * a picker somebody scrolls 463 disabled lines through to reach two. Asking
   * `hostable` about the *provider* instead collapses six headings and leaves
   * those two rows drawn. The fixture below is that shape in miniature, and it
   * asserts the ratio rather than the wording: what must hold is that the count of
   * things drawn as refused does not scale with the size of the provider.
   */
  const openRouterRows = many(40, "qwen");
  const orGroup = groupModels(openRouterRows)[0];
  const codexRouting = { providerId: "custom-gateway", supported: ["openai"] } as never;
  check(
    "a whole provider refuses in one line, however many rows it has",
    [
      hostable("codex", orGroup?.system as never, codexRouting),
      openRouterRows.filter((one) => choiceRefusal("codex", one, codexRouting) !== null).length,
      openRouterRows.length,
    ],
    ["Codex cannot run OpenRouter models.", 40, 40],
  );
  /*
   * ⚠ **And the harness that *can* be pointed there collapses nothing**, which is
   * the other half: the collapse must be a fact about a pairing that cannot work,
   * never a filter that hides a provider from whoever is looking.
   */
  check(
    "while the harness it is native to hides none of it",
    hostable("opencode", orGroup?.system as never, null),
    null,
  );
  /*
   * ⚠ **One system relates its two spellings, and there a name is never the
   * reason a pairing fails.** Everything `ModelChoice.source` says about kimi and
   * Moonshot holds — two lists, overlapping in models and not in names, nothing
   * carrying one to the other. OpenRouter is the case that *does* carry: opencode
   * publishes `openrouter/qwen/qwen3-coder` for exactly what the endpoint claude
   * is routed at calls `qwen/qwen3-coder`, one catalogue behind one account.
   * Without this, a table row would be refused for the native harness and a
   * published one for every other — which is every row of the largest provider
   * greyed for whichever harness did not happen to supply it.
   *
   * The Moonshot half is the control: same shape, no prefix, still refused.
   */
  const orTable = or("qwen/qwen3-coder", "Qwen3 Coder");
  const orPublished = { ...orTable, source: "published" as const };
  check(
    "a system that relates its spellings refuses neither harness for the name",
    [
      choiceRefusal("opencode", orTable, null),
      choiceRefusal("claude", { ...orTable, system: { ...orTable.system, routable: true } }, claude),
      choiceRefusal("opencode", orPublished, null),
    ],
    [null, null, null],
  );
  check(
    "while a system that does not still refuses, on the same shape",
    [choiceRefusal("kimi", tabled, null), choiceRefusal("claude", published, claude)],
    ["Kimi Code has no model called K2.", "Claude Code has no model called K3."],
  );
  /*
   * ⚠ **Published wins the row and the table wins the name**, which is the
   * opposite way round and is not a contradiction. `source` answers "which
   * harnesses may use this id" and the published row answers it correctly; the
   * name is a label, and where one model is spelled twice the endpoint's own name
   * for it beats a harness's rendering of it.
   *
   * Measured against a live opencode: it publishes `OpenRouter/Claude Opus 5` for
   * what the catalogue calls `Claude Opus 5`, so without this every row under a
   * heading already reading `OpenRouter · anthropic` said the provider twice and
   * carried a `/` into every refusal built from it.
   */
  const orSystem = system({ id: "openrouter", displayName: "OpenRouter", nativeHarness: "opencode", nativeModelPrefix: "openrouter/", models: [{ id: "qwen/q3", name: "Qwen: Q3" }] });
  const merged = allModels([orSystem], {
    opencode: { models: [{ id: "openrouter/qwen/q3", name: "OpenRouter/Q3", description: null, group: null }], routing: null, error: null },
  } as never);
  check(
    "one model published and tabled is one row, keyed the published way and named the table's",
    merged.map((one) => `${one.modelId} | ${one.modelName} | ${one.source}`),
    ["qwen/q3 | Qwen: Q3 | published"],
  );

  /* ---------------------------------------------------------------- *
   * ⭐ A catalogue's refusal outranks a harness's list
   *
   * The tools filter existed and only ONE of the two lists went through it.
   * `readOpenRouterModels` drops a model that cannot call a tool; opencode
   * publishes all 362 of OpenRouter's, image models included, and this function
   * merged them in as `published` rows — so a model already refused came back
   * through the other door. Reported: an agent assembled on
   * `nousresearch/hermes-3-llama-3.1-405b`, whose `supported_parameters` carries
   * no `tools` at all, failed on its first turn with OpenRouter's own accurate
   * sentence — "No endpoints found that support tool use. Try disabling `bash`",
   * `bash` being opencode's own shell tool. Q3.520.
   * ---------------------------------------------------------------- */
  {
    const published = {
      opencode: {
        models: [
          { id: "openrouter/qwen/q3", name: "OpenRouter/Q3", description: null, group: null },
          { id: "openrouter/nous/hermes", name: "OpenRouter/Hermes", description: null, group: null },
        ],
        routing: null,
        error: null,
      },
    } as never;
    check(
      "a published model the catalogue refused for having no tools is not offered",
      allModels([{ ...orSystem, models: [] }], published, ["nous/hermes"]).map((one) => one.modelId),
      ["qwen/q3"],
    );
    /*
     * ⚠ **Fails open**, which is why the argument is a list of the *refused*
     * rather than a list of the allowed: a catalogue that could not be read
     * refuses nothing, and every published row is offered exactly as it was before
     * this existed. The default is what an old caller passes.
     */
    check(
      "and with no catalogue read at all, nothing is dropped",
      allModels([{ ...orSystem, models: [] }], published).map((one) => one.modelId),
      ["qwen/q3", "nous/hermes"],
    );
    /*
     * The refusal is keyed on the **endpoint's** spelling, which is what is stored
     * and what the catalogue publishes — not on the harness's prefixed one. Keyed
     * the other way this would match nothing and go quietly back to offering it.
     */
    check(
      "keyed on the id the catalogue uses, not the one the harness prefixes",
      allModels([{ ...orSystem, models: [] }], published, ["openrouter/nous/hermes"]).map((one) => one.modelId),
      ["qwen/q3", "nous/hermes"],
    );
  }
  /*
   * ⚠ **…and where the table has never heard of the model, the provider's own
   * label comes off the front of the harness's name.** That is a *third* rule
   * rather than an exception to either, and the reason the two can live in one
   * function is that they never both apply: the dedupe branch has a better name in
   * hand and cuts nothing, and this branch has none.
   *
   * ⚠ **It is not the surgery `openrouter.ts` refuses, and the difference is the
   * key.** That file refuses a *pattern* — `"<Vendor>: "` over a vendor half that
   * is unknown, absent on 19 names and spelled two ways by four vendors — because
   * it infers structure from somebody else's prose. This removes **one known
   * constant**, the system's own `displayName`, which is the exact string
   * `AgentBuilder` paints in the heading directly over the row: the justification
   * is redundancy with that heading, so the heading's own string is the only
   * correct key.
   *
   * Zen is the system it exists for and the one no other rule reaches: its table
   * list is empty, so "the table wins the name" has nothing to win with, and
   * opencode renders every row as `OpenCode Zen/<name>` under a heading that
   * already says `OpenCode Zen`. Ninety-three of them once a key is pasted.
   */
  const zenSystem = system({ id: "zen", displayName: "OpenCode Zen", routable: false, nativeHarness: "opencode", nativeModelPrefix: "opencode/", models: [] });
  const zenNamed = (displayName: string, name: string) =>
    allModels([{ ...zenSystem, displayName }], {
      opencode: { models: [{ id: "opencode/big-pickle", name, description: null, group: null }], routing: null, error: null },
    } as never).map((one) => `${one.modelId} | ${one.modelName}`);
  check(
    "a published model the table has never heard of loses the provider's label",
    zenNamed("OpenCode Zen", "OpenCode Zen/Big Pickle"),
    // Stored unprefixed, like every other id — `pinNativeModel` puts `opencode/`
    // back at the one moment the agent is asked.
    ["big-pickle | Big Pickle"],
  );
  check(
    "and so does an OpenRouter row the tools filter dropped",
    allModels([system({ id: "openrouter", displayName: "OpenRouter", nativeHarness: "opencode", nativeModelPrefix: "openrouter/", models: [] })], {
      opencode: { models: [{ id: "openrouter/qwen/q3", name: "OpenRouter/Q3", description: null, group: null }], routing: null, error: null },
    } as never).map((one) => `${one.modelId} | ${one.modelName}`),
    ["qwen/q3 | Q3"],
  );
  /*
   * ⚠ **Keying on the constant is what buys the fail-open, and every way it can
   * miss leaves the row exactly as it was before the rule existed.** A strip that
   * cut at the first `/` instead would *survive* a rename and go on cutting,
   * including a slash that belonged to the model. Case is folded because a label
   * differing only in case still repeats the heading — and nothing else is: no
   * fuzzy match, no normalised punctuation, and no separator but `/`, since a
   * space before it is a format nobody measured.
   */
  check(
    "it fails open on every rename, and folds case and nothing else",
    [
      zenNamed("Zen", "OpenCode Zen/Big Pickle"),
      zenNamed("OpenCode Zen", "opencode zen/Big Pickle"),
      zenNamed("OpenCode Zen", "OpenCode Zen /Big Pickle"),
      zenNamed("OpenCode Zen", "Big Pickle"),
      zenNamed("", "/Big Pickle"),
    ],
    [
      ["big-pickle | OpenCode Zen/Big Pickle"],
      ["big-pickle | Big Pickle"],
      ["big-pickle | OpenCode Zen /Big Pickle"],
      ["big-pickle | Big Pickle"],
      ["big-pickle | /Big Pickle"],
    ],
  );
  /*
   * ⚠ **An empty remainder keeps the original, because a name here is a *stored*
   * value.** `defaultAgentName(modelName)` seeds a new preset's name, which is
   * written to `custom_agents.name`; the save button does not weigh the name, so a
   * blank one reaches the daemon and comes back `400`. Trimmed for the same
   * reason, and only in the branch that fired.
   */
  check(
    "an empty remainder keeps the name, and a live one is trimmed",
    [zenNamed("OpenCode Zen", "OpenCode Zen/"), zenNamed("OpenCode Zen", "OpenCode Zen/   "), zenNamed("OpenCode Zen", "OpenCode Zen/  Big Pickle ")],
    [
      ["big-pickle | OpenCode Zen/"],
      ["big-pickle | OpenCode Zen/   "],
      ["big-pickle | Big Pickle"],
    ],
  );
  /*
   * The regression arm, and the one that would have caught a strip written as a
   * pattern: no other system's harness prefixes its names at all, so every one of
   * them must come through untouched. kimi's are the measured case — `K2.7
   * Coding` under a system called `Moonshot`.
   */
  check(
    "a harness that does not prefix its names is untouched",
    allModels([system({ displayName: "Moonshot", nativeHarness: "kimi", models: [] })], {
      kimi: { models: [{ id: "kimi-code/k3", name: "K3", description: null, group: null }], routing: null, error: null },
    } as never).map((one) => `${one.modelId} | ${one.modelName}`),
    ["kimi-code/k3 | K3"],
  );
  /*
   * And the name a *new preset* defaults to is the stripped one, which is the half
   * of this that is not a label: it is what gets written down.
   */
  check(
    "and the preset a stripped row would be called is the short name",
    defaultAgentName(zenNamed("OpenCode Zen", "OpenCode Zen/Big Pickle")[0]?.split(" | ")[1] ?? ""),
    defaultAgentName("Big Pickle"),
  );
  /*
   * ⚠ **One harness, two systems, one published list — and the prefix is what
   * divides it.** opencode is the native side of both OpenRouter and OpenCode Zen
   * and publishes them together. Without the division each system takes the whole
   * list: 362 rows under OpenRouter including six that are not its models, and 362
   * under Zen including 356 that are not, every one unrunnable and none saying so.
   *
   * Driven over both systems at once, because either one alone passes by luck.
   */
  const bothPublished = {
    opencode: {
      models: [
        { id: "openrouter/qwen/q3", name: "OpenRouter/Q3", description: null, group: null },
        { id: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle", description: null, group: null },
      ],
      routing: null,
      error: null,
    },
  } as never;
  check(
    "a published list is divided between the systems that share its harness",
    allModels([{ ...orSystem, models: [] }, zenSystem], bothPublished).map(
      (one) => `${one.system.id}: ${one.modelId}`,
    ),
    ["openrouter: qwen/q3", "zen: big-pickle"],
  );
  /*
   * And a system with no prefix still takes everything, which is every other row
   * in the daemon's table and is exactly what they did before the division
   * existed — those harnesses serve one system each, so there is nothing to
   * divide and nothing may be dropped.
   */
  check(
    "while a system that claims no prefix still takes the whole list",
    allModels([system({ models: [] })], {
      kimi: { models: [{ id: "kimi-code/k3", name: "K3", description: null, group: null }, { id: "plain", name: "P", description: null, group: null }], routing: null, error: null },
    } as never).map((one) => one.modelId),
    ["kimi-code/k3", "plain"],
  );
  /*
   * ⚠ **And the answer is per row: which harnesses can run *this* model.** More
   * precise than a group, needs no vocabulary, and reads at a glance. Measured
   * against the installed kimi 0.29.x — printing the **names** this time, which is
   * what an earlier pass never did: `kimi-code/kimi-for-coding` is "K2.7 Coding"
   * and `kimi-code/k3` is "K3", so Kimi Code runs a K2 perfectly well. What it will
   * not take is the *string* `kimi-k2-thinking`, Moonshot's API name for a
   * different build. The refusal is about a name and never about a model.
   */
  const caps3 = { claude: { models: [], routing: claude, error: null }, codex: { models: [], routing: codex, error: null }, kimi: { models: [], routing: null, error: null } };
  check(
    "a model published by a CLI is that CLI's alone",
    supportingHarnesses(published, caps3 as never),
    ["kimi"],
  );
  check(
    "and one the endpoint answers to belongs to whatever can be routed there",
    supportingHarnesses(tabled, caps3 as never),
    ["claude"],
  );
  /*
   * ⚠ **The key is not weighed here**, deliberately, and one of the two reasons
   * that used to be given has expired. It said "a key is a box away unlike a
   * protocol", which was true while the `KeyOnly` box sat under the pair on the
   * builder and is not true of anything now. The reason that survives is
   * structural and was always the stronger half: these glyphs are drawn where **no
   * harness has been chosen**, so which kind of pairing this will be is undecided
   * and whether a key is needed at all is unknowable. What they say is what a
   * model is *for*.
   *
   * ⚠ **The glyphs and the greying now disagree on one kind of row, deliberately,
   * and the reasoning here had to be rewritten rather than the assertion.** It
   * used to say that folding the key in would make a row's glyphs and its greying
   * disagree — an argument that expired the moment the key reached the model
   * screen. A table-spelled model on an unkeyed system is greyed *and* still draws
   * Claude Code's glyph, because the two answer different questions: the glyph
   * says what a spelling is **for**, a settled fact about the name, and the greying
   * says what is **missing**. Weighing the key here would delete the answer to the
   * first question in the one state where somebody most needs it — "so which
   * harness would this have run under, if I pasted the key?"
   */
  check(
    "and a missing key changes none of it",
    supportingHarnesses({ ...tabled, system: system({ keySet: false }) }, caps3 as never),
    ["claude"],
  );
  /*
   * ⚠ **The harnesses come from the *listing*, and reading `AGENT_IDS` here was
   * the clearest way a harness a plugin added could have been made a second-class
   * row.** That constant is the four this product ships — so a contributed harness
   * would have drawn no glyph on any model row, and a model only *it* can run would
   * have drawn **none at all**, silently, on the row whose whole job is to say what
   * will run it. `supportingHarnesses`' own claim that it is "never empty in
   * practice" would have become false in exactly the case somebody most needed it
   * to be true.
   *
   * Both halves are driven: the contributed harness appears where it can run the
   * model, and the row is not empty where it is the only thing that can.
   */
  const withPlugin = {
    ...caps3,
    "acme:gemini": { models: [], routing: { providerId: "g", supported: ["anthropic"], pinsModel: true }, error: null },
  };
  const offeredHarnesses = ["claude", "kimi", "codex", "opencode", "acme:gemini"];
  check(
    "a harness a plugin added draws its glyph on the rows it can run",
    supportingHarnesses(tabled, withPlugin as never, offeredHarnesses),
    ["claude", "acme:gemini"],
  );
  check(
    "and a model only it can run is not a row that says nothing",
    // A model that harness *published*, on a provider nothing else can reach: the
    // one shape where the answer is a single contributed row, and the shape that
    // drew an empty glyph strip before the list was a parameter.
    supportingHarnesses(
      { ...published, system: system({ nativeHarness: "acme:gemini", routable: false }) },
      withPlugin as never,
      offeredHarnesses,
    ),
    ["acme:gemini"],
  );
  check(
    "while the default is still the four this product ships, in their own order",
    supportingHarnesses(tabled, withPlugin as never),
    ["claude"],
  );
  /*
   * The search box reads the *system's* name too. The ids people know are half
   * the answer — "moonshot" matches nothing in `kimi-k2-thinking` — so a search
   * over the model alone would answer "nothing here is called moonshot" over a
   * screen with four of them on it.
   */
  check(
    "a search reaches the provider's name as well as the model's",
    searchModels([published, tabled], "moonshot", null).length,
    2,
  );
  check("and narrows to one system", searchModels([published, tabled], "", "anthropic"), []);
  check("with whitespace meaning no query at all", searchModels([published, tabled], "   ", null).length, 2);

  /*
   * ⚠ **Two sentences for a pairing failure now, and the split is a correction
   * this driver was actively holding shut.** One string covered both for a
   * release: "Kimi Code cannot run K2." — which this file's own comment eleven
   * lines up already calls false, since Kimi Code runs a K2 perfectly well and
   * `"K2.7 Coding"` is in the list its config option publishes. What it will not
   * take is the *string* `kimi-k2-thinking`, Moonshot's API name for a different
   * build. So the two failures a settled pairing can hit are two different facts:
   * a protocol a harness does not speak, which `cannotRun` keeps its older
   * sentence for, and a **name** that is not in a harness's own list, which is
   * `noModelCalled`. Q3.483.
   *
   * ⚠ **The old expectation here drove two *name* collisions and called them
   * pairings**, and the check immediately below it forbade every word the correct
   * sentence needed. Both are rewritten rather than dropped: the properties they
   * were protecting are unchanged and are asserted below and in the sweep — both
   * nouns are ones the reader has already seen (the harness titles the row it is
   * drawn on, the model was chosen one screen back), no word comes off the wire,
   * and rows in the same situation read identically.
   */
  check(
    "a name collision says which name is missing, in both directions",
    [choiceRefusal("kimi", tabled, null), choiceRefusal("claude", published, claude)],
    ["Kimi Code has no model called K2.", "Claude Code has no model called K3."],
  );
  /*
   * ⚠ **And a genuine protocol refusal is a different string, which nothing pinned
   * at all.** With both operands above being name collisions, `cannotRun`'s arm
   * was reachable from `choiceRefusal` and covered by nothing — so a re-merge of
   * the two kinds passed every assertion in this section.
   */
  check(
    "while a protocol nothing can change keeps the older sentence",
    choiceRefusal("codex", tabled, codex),
    "Codex cannot run K2.",
  );
  /*
   * ⚠ **Kept verbatim, and `another name` is the live guard rather than the
   * obstacle.** Q3.488: Kimi Code talks to `api.kimi.com/coding/v1` and Moonshot
   * routes at `api.moonshot.ai/anthropic` — different host, different API,
   * different billing — and **nothing on any wire carries an equivalence between
   * their two name lists**. Which name is *absent* is knowable from the lists;
   * which name to use *instead* is not, so "Kimi Code calls this K2.7 Coding" is a
   * sentence this app is not entitled to write however much it would help. The
   * corrected wording clears all four alternates, which is the point: it names the
   * missing name and stops.
   */
  check(
    "and it mentions neither the system nor a row it did not look for",
    /Moonshot|another name|this model|only/i.test(choiceRefusal("kimi", tabled, null) ?? ""),
    false,
  );
  /*
   * ⚠ **On a row already titled with the harness, the harness comes off.** The
   * picker draws "Claude Code" as the title, so a subline repeating it spends two
   * thirds of the line on the word directly above it.
   *
   * ⚠ **This expected `["Cannot run K2.", "Cannot run K2."]` and called the
   * identity the point, which is exactly what pinned the wrong sentence in
   * place.** Rows in the *same* situation reading identically was always the rule
   * and still is — asserted two checks down, where it is actually true. These two
   * are not in the same situation: one is a protocol Codex will never speak, the
   * other a name that is simply not in Kimi Code's own list. Same words, two
   * unrelated facts, and the second of them false.
   */
  check(
    "a harness row drops the harness, and the two failures do not share a subline",
    [harnessRowRefusal("kimi", tabled, null), harnessRowRefusal("codex", tabled, codex)],
    ["No model called K2.", "Cannot run K2."],
  );
  /*
   * The split itself rather than only its two outputs, so a re-merge fails here
   * even if somebody rewrites both strings to agree with each other.
   */
  check(
    "and a spelling and a protocol never read alike on the same screen",
    harnessRowRefusal("kimi", tabled, null) === harnessRowRefusal("codex", tabled, codex),
    false,
  );
  /*
   * ⚠ **And the property the deleted expectation really carried, restated where it
   * holds.** A codex that speaks the same protocol exists only in this fixture —
   * the installed one answers `openai` alone — and it is here so that two rows can
   * be in the same situation at once: both non-native, both handed the native
   * CLI's own spelling. Two rows in one situation still get one sentence, which is
   * what makes a pair of greyed rows read as a rule rather than as an opinion.
   */
  const codexToo = { providerId: "custom-gateway", supported: ["anthropic", "openai"] };
  check(
    "while two rows that *are* in the same situation still read identically",
    [harnessRowRefusal("claude", published, claude), harnessRowRefusal("codex", published, codexToo)],
    ["No model called K3.", "No model called K3."],
  );
  check("and says nothing at all where it can", harnessRowRefusal("claude", tabled, claude), null);
  check("nor before a model has been chosen", harnessRowRefusal("claude", null, claude), null);
  /*
   * ⚠ **Every sentence this module can put on a row, against one vocabulary and
   * one shape.** Two of these seven arms were driven before and the rest were
   * covered by nothing, which is how a wire word reaches a phone with the drivers
   * green — and splitting one refusal into two is precisely the change that adds
   * arms nobody sweeps. `noJargon` above carries the forbidden list, including the
   * three fields this split put one substitution away from the screen.
   */
  const everyRefusal: (string | null)[] = [
    hostable("codex", system(), codex),
    hostable("kimi", system({ nativeHarness: "claude" }), null),
    hostable("claude", system({ routable: false }), claude),
    hostable("claude", system({ routable: false, nativeHarness: null }), claude),
    choiceRefusal("kimi", tabled, null),
    choiceRefusal("claude", published, claude),
    choiceRefusal("codex", tabled, codex),
    choiceRefusal("claude", { ...tabled, system: unkeyed }, claude),
    choiceRefusal(null, { ...tabled, system: system({ nativeHarness: null, keySet: false }) }, null),
    harnessRowRefusal("kimi", tabled, null),
    harnessRowRefusal("codex", tabled, codex),
    // ⚠ The eighth arm, added with the sentence itself. The sweep's own comment
    // claims every sentence this module can put on a row, and the key one reached
    // a row this run while being covered here only through `keyMissing` — a
    // different call site with the same string today and no rule saying so
    // tomorrow. This is what holds it to `noJargon`, to the full stop, and to
    // never printing an id where a name goes.
    harnessRowRefusal("claude", { ...tabled, system: unkeyed }, claude),
    keyMissing({ ...tabled, system: unkeyed }, "claude"),
  ];
  // Each arm answers something, and the sweep below is worth nothing if one of
  // them quietly became `null` — a greyed row with no reason is the state this
  // whole section exists to prevent.
  check("every refusal this screen can draw is a sentence", everyRefusal.filter((why) => why === null || !why.endsWith(".")), []);
  check("and none of them is written for a developer", everyRefusal.filter((why) => !noJargon(why)), []);
  /*
   * ⚠ **The specific leak the split created.** `modelName` is what a refusal may
   * name and `modelId` is what the daemon is handed; they differ in exactly the
   * two fixtures above, so a sentence built from the wrong field reads perfectly
   * in review and says `kimi-code/k3` on a phone.
   */
  check(
    "and none of them prints an id where a name goes",
    everyRefusal.filter((why) => (why ?? "").includes(published.modelId) || (why ?? "").includes(tabled.modelId)),
    [],
  );
  /*
   * The search box reads the *system's* name too. The ids people know are half
   * the answer — "moonshot" matches nothing in `kimi-k2-thinking` — so a search
   * over the model alone would answer "nothing here is called moonshot" over a
   * screen with four of them on it. Nothing is dropped for being unusable, here
   * or anywhere: the filter takes what was asked for and the refusal is drawn on
   * what is left.
   */
  check(
    "a search reaches the provider's name as well as the model's",
    searchModels([published, tabled], "moonshot", null).length,
    2,
  );
  check("and narrows to one system", searchModels([published, tabled], "", "anthropic"), []);
  check("with whitespace meaning no query at all", searchModels([published, tabled], "   ", null).length, 2);
  check(
    "a native system's models come from its own harness",
    listed.filter((one) => one.system.id === "anthropic").map((one) => `${one.modelId}:${one.source}`),
    ["opus:published"],
  );
  check(
    "and a routed one's from the table",
    listed.filter((one) => one.system.id === "moonshot").map((one) => `${one.modelId}:${one.source}`),
    ["kimi-k2-thinking:table"],
  );
  /*
   * ⚠ **Moonshot is both native and routable, so its model can arrive twice.**
   * Deduplicated on the id rather than the name, which is what is stored.
   */
  const both = allModels(
    [system()],
    { kimi: { models: [{ id: "kimi-k2-thinking", name: "K2", description: null, group: null }], routing: null, error: null } } as never,
  );
  check("a system that is both does not list its model twice", both.length, 1);

  /*
   * ⚠ **A tile shows three things and none may say the same thing twice.** The
   * glyph is the harness, the title is the model, the subline is the system. The
   * default name read `Claude · Kimi K2 Thinking` for one release and truncated to
   * `Claude · Ki…` on a 96px tile — the whole line spent on what the glyph beside
   * it already said, cutting the one it did not. Found by rendering it.
   */
  check("a default name does not repeat the glyph", defaultAgentName("Kimi K2 Thinking"), "Kimi K2 Thinking");
  check(
    "a tile's subline is the system",
    customAgentSubline(
      { id: "ca_1", name: "n", harness: "claude", system: "moonshot", model: "kimi-k2-thinking", createdAt: 0 },
      [system()],
    ),
    "Moonshot",
  );
  /*
   * A system the daemon no longer lists falls back to its id rather than to
   * nothing: a tile with a blank second line says less than one showing the raw
   * string, and the raw string is what a person would search for.
   */
  check(
    "and falls back to the id when the daemon has forgotten it",
    customAgentSubline(
      { id: "ca_1", name: "n", harness: "claude", system: "gone", model: "m", createdAt: 0 },
      [system()],
    ),
    "gone",
  );
}

process.stdout.write("\na model id typed rather than listed\n");
{
  const { adoptModels, allModels, choiceRefusal, groupModels, supportingHarnesses } = await import("../src/agents.js");

  const system = (over: Partial<SystemInfo> = {}): SystemInfo => ({
    id: "moonshot",
    displayName: "Moonshot",
    apiType: "anthropic",
    routable: true,
    nativeHarness: "kimi",
    loginVia: "kimi",
    models: [],
    keySet: true,
    keyUpdatedAt: 1,
    ...over,
  });
  const claude = { providerId: "main", supported: ["anthropic", "bedrock", "vertex"] };
  const kimiPublishes = (id: string, name: string) =>
    ({ kimi: { models: [{ id, name, description: null, group: null }], routing: null, error: null } }) as never;
  const none = {} as never;

  /*
   * ⚠ **Q3.501's mechanism and not a third `source`.** The typed id is
   * substituted into the *listing* and `allModels` is never told; what comes out
   * is one table row whose name is the id, because nothing else names it. The
   * table is a starting set — all three Moonshot ids it shipped with were retired
   * on 2026-05-25 and the daemon validates a routed id against nothing but a
   * length — so this is the door for every id it does not hold.
   */
  const typed = allModels(adoptModels([system()], [{ system: "moonshot", model: "kimi-k2.7-code-highspeed" }]), none);
  check(
    "a typed id under a routable system is exactly one table row, named by its id",
    typed.map((one) => [one.system.id, one.modelId, one.modelName, one.source]),
    [["moonshot", "kimi-k2.7-code-highspeed", "kimi-k2.7-code-highspeed", "table"]],
  );
  check(
    "trimmed, and an empty one is not a row",
    allModels(adoptModels([system()], [{ system: "moonshot", model: "  kimi-k3 " }, { system: "moonshot", model: "   " }]), none).map((one) => one.modelId),
    ["kimi-k3"],
  );
  check(
    "one the table already names is not carried twice, and the table's name stands",
    allModels(adoptModels([system({ models: [{ id: "kimi-k3", name: "Kimi K3" }] })], [{ system: "moonshot", model: "kimi-k3" }]), none).map((one) => `${one.modelId}:${one.modelName}`),
    ["kimi-k3:Kimi K3"],
  );
  check(
    "and nor is the same id typed twice",
    adoptModels([system()], [{ system: "moonshot", model: "x" }, { system: "moonshot", model: "x" }])[0]?.models.length,
    1,
  );
  check(
    "a system it was not typed under is the same object it was",
    adoptModels([system(), system({ id: "zhipu", displayName: "Z.ai (GLM)", nativeHarness: null, loginVia: null })], [{ system: "moonshot", model: "kimi-k3" }])[1] ===
      undefined
      ? "lost"
      : "kept",
    "kept",
  );
  /*
   * ⚠ **Published wins the row, the table wins the name — the existing dedupe,
   * with no new arm.** Its presence proves the native harness is keyed, so the
   * row asks for no key; and the typed spelling is what the person will look for,
   * so it is what the row says.
   */
  const dedupe = allModels(adoptModels([system()], [{ system: "moonshot", model: "kimi-k3" }]), kimiPublishes("kimi-k3", "K3"));
  check(
    "one a harness also publishes dedupes to one row: published wins the row, the typed id the name",
    dedupe.map((one) => [one.modelId, one.modelName, one.source]),
    [["kimi-k3", "kimi-k3", "published"]],
  );
  check("and that row needs no key", choiceRefusal(null, dedupe[0]!, null), null);
  /*
   * `keyMissing`'s biconditional, true of the typed row word for word: a table id
   * runs only routed, routed signs with the pasted key.
   */
  const unkeyed = allModels(adoptModels([system({ keySet: false })], [{ system: "moonshot", model: "kimi-k3" }]), none)[0]!;
  check("with no key saved it is greyed by the no-key sentence", choiceRefusal(null, unkeyed, null), "No Moonshot key on this machine.");
  check("and with one it is not", choiceRefusal(null, typed[0]!, null), null);
  /*
   * `pairFailure`'s two arms: the native harness is refused a table spelling for
   * the *name*, and a routed one may use it.
   */
  check("the native harness is refused it for the name", choiceRefusal("kimi", typed[0]!, null), "Kimi Code has no model called kimi-k2.7-code-highspeed.");
  check("and a routed harness may use it", choiceRefusal("claude", typed[0]!, claude), null);
  check(
    "which is what the row's own glyphs say",
    supportingHarnesses(typed[0]!, { claude: { models: [], routing: claude, error: null } } as never, ["claude", "kimi"]),
    ["claude"],
  );
  check("and it sits in its provider's group like any other row", groupModels(typed).map((one) => [one.system.id, one.choices.length]), [["moonshot", 1]]);
  /*
   * ⚠ **The negative control, and it is the load-bearing half.** A native system's
   * ids are whatever its CLI publishes; a typed one there is refused at start with
   * the CLI's own sentence — a box producing only refusals. `routable` absent is an
   * older daemon with no routed door.
   */
  check(
    "no row where the system is not routable, and none where an older daemon never said",
    [
      adoptModels([system({ id: "anthropic", displayName: "Anthropic", routable: false, nativeHarness: "claude", loginVia: "claude" })], [{ system: "anthropic", model: "claude-opus-5" }])[0]?.models,
      adoptModels([system({ routable: undefined })], [{ system: "moonshot", model: "kimi-k3" }])[0]?.models,
    ],
    [[], []],
  );

  /*
   * ⚠ **The same substitution is what keeps Save alive over a stored preset whose
   * model has left every list.** `current` is a lookup in the catalogue and Save is
   * `disabled` on `current === null`, so such a preset drew `Choose` under a filled
   * field and could not be renamed. The pure half: the adopted pick is a row the
   * lookup finds. The wiring half is read off the builder below.
   */
  const stored = { system: "moonshot", model: "kimi-k2-thinking" };
  const before = allModels([system({ models: [{ id: "kimi-k3", name: "Kimi K3" }] })], none);
  const after = allModels(adoptModels([system({ models: [{ id: "kimi-k3", name: "Kimi K3" }] })], [stored]), none);
  check(
    "a stored model no list holds is absent from the catalogue as listed, and present once adopted",
    [
      before.some((one) => one.system.id === stored.system && one.modelId === stored.model),
      after.filter((one) => one.system.id === stored.system && one.modelId === stored.model).map((one) => `${one.modelName}:${one.source}`),
    ],
    [false, ["kimi-k2-thinking:table"]],
  );

  const builder = stripComments(readFileSync(new URL("../src/ui/AgentBuilder.tsx", import.meta.url), "utf8"));
  const between = (from: string, to: string): string => {
    const start = builder.indexOf(from);
    if (start === -1) return "";
    const end = builder.indexOf(to, start + from.length);
    return end === -1 ? "" : builder.slice(start, end);
  };
  const listed = between("const listed = useMemo(", "const catalogueAsListed");
  const orphan = between("const catalogue = useMemo(", "const openRouterLine");
  const field = between("<TypedModel", "/>");
  check("the three regions were found", [listed.length > 0, orphan.length > 0, field.length > 0], [true, true, true]);
  /*
   * At the same site as the OpenRouter substitution and before `allModels` — the
   * whole of Q3.501's mechanism is *where* the row goes in.
   */
  check(
    "a typed id is substituted into the listing at the OpenRouter site, and `allModels` is not told",
    [/adoptModels\(read, typed\)/.test(listed), /OPENROUTER_SYSTEM_ID/.test(listed), /allModels/.test(listed)],
    [true, true, false],
  );
  /*
   * ⚠ **Only a pick the catalogue does not hold is adopted, and the test is
   * against the catalogue.** Adopting every pick would hand `allModels` a table
   * row for a *published* one — opencode's spelling of an OpenRouter model — and
   * the dedupe would rename it to its slug.
   */
  check(
    "and a stored pick is adopted only when the catalogue as listed does not hold it",
    [/catalogueAsListed\.some\(/.test(orphan), /adoptModels\(listed, \[picked\]\)/.test(orphan), /return catalogueAsListed;[\s\S]*adoptModels/.test(orphan)],
    [true, true, true],
  );
  check(
    "Save is still gated on `current`, which is a lookup in that catalogue",
    [/disabled=\{busy \|\| current === null/.test(builder), /catalogue\.find\(/.test(builder)],
    [true, true],
  );
  /*
   * The control itself: under the group, behind the same gate `adoptModels`
   * applies — `=== true`, so an older daemon's absent field draws nothing — and
   * bounded on the field by the daemon's own number, read off the daemon so the
   * two cannot drift.
   */
  check(
    "the field is drawn only where the daemon said `routable`, and the id is bounded on the field",
    [
      /group\.system\.routable === true && \(\s*<TypedModel/.test(builder),
      (builder.match(/<TypedModel/g) ?? []).length,
      /maxLength=\{MAX_MODEL_CHARS\}/.test(builder),
    ],
    [true, 1, true],
  );
  const daemon = readFileSync(new URL("../../../src/server.ts", import.meta.url), "utf8");
  check(
    "and the bound is the daemon's",
    [builder.match(/const MAX_MODEL_CHARS = (\d+);/)?.[1] ?? null, daemon.match(/const MAX_MODEL_CHARS = (\d+);/)?.[1] ?? null],
    ["256", "256"],
  );
  /*
   * The row is picked by a tap like any other, so the id seeds the name through
   * the one door a pick has — `defaultAgentName(choice.modelName)`, and the typed
   * row's name is its id. No second `setPicked` for a typed id exists.
   */
  check(
    "typing reports the id and nothing else: no pick, no name, no navigation",
    [/onType=\{\(system, model\) =>\s*setTyped\(/.test(builder), (builder.match(/setPicked\(/g) ?? []).length],
    [true, 3],
  );
}
