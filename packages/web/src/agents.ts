import { agentLabel } from "./ui/agentCard";
import { AGENT_IDS, type AgentCapabilities, type AgentId, type CustomAgent, type SystemInfo } from "./wire";

/*
 * Which harness can be pointed at which system, as pure functions.
 *
 * ⚠ **This is the client's half of a rule the daemon also holds, and it is not a
 * second copy of the answer.** `src/acp/systems.ts`'s `hostable` refuses a
 * pairing on the way in, and it has to: this daemon is reachable from the
 * internet, and a saved preset that cannot start is a row whose only button
 * answers 502 for ever. What lives here is the *courtesy* — greying a row out
 * before somebody picks it — computed from the same two facts the daemon uses,
 * both of which arrive on the wire. Neither side hardcodes a matrix, which is
 * what stops the two drifting: they read the agent's own answer.
 *
 * DOM-free on purpose, so `webcheck` drives these rather than a transcription of
 * them — `agentConfig.ts` and `install.ts` are here for the same reason.
 */

/** Why a harness cannot host a system, or `null` when it can. */
export type HostRefusal = string | null;

/**
 * Mirrors `hostable` in `src/acp/systems.ts` — every refusal but one.
 *
 * ⚠ **The daemon has a fourth refusal this side cannot express, and nothing on
 * the wire stands for it.** `ROUTED_MODEL_ENV` is a table of how each harness
 * is *told which model to run* on a foreign system, and the daemon refuses a
 * pairing it could route but could not pin — that state would start, look
 * right, and quietly run the endpoint's default model. Only the daemon holds
 * that table; `SystemInfo` and `AgentCapabilities` carry nothing derived from
 * it, so the arm cannot be written here without putting the fact on the wire.
 *
 * It is unreachable today and only by coincidence: every routed system is
 * `anthropic`-shaped and codex — the one routing-capable harness missing from
 * that table — is already refused one arm earlier by `supported`. The day an
 * `openai`-shaped routable system is added, this function offers a pairing
 * `POST /custom-agents` answers `400 incompatible_pairing` for, *after*
 * somebody has assembled it. The route is still the gate; what is lost is the
 * greying-out this file exists to do.
 *
 * ⚠ **`routing` is the agent's own answer and must never be assumed.** It
 * carries which protocols this harness accepts, and the two that support any
 * disagree — measured, claude accepts `anthropic`/`bedrock`/`vertex` and codex
 * accepts `openai` alone. `null` means the harness will not be re-pointed at all,
 * which is kimi.
 *
 * ⚠ **What comes back is a sentence somebody reads on a phone, and the first
 * version was not one.** It said "Codex accepts openai systems, and Moonshot is
 * anthropic" — every noun in it a *protocol* name, three of which look like
 * company names and none of which appears anywhere else in this app. The rule
 * these strings now keep: name the harness, name the system, say which one
 * cannot do the other, and use no word that is not already on the screen. The
 * wire vocabulary (`apiType`, `supported`, `providerId`) stays in the code, which
 * is the only place it means anything.
 *
 * Three refusals rather than one because the *remedy* differs in the first: a
 * system nothing can be routed at names the CLI that reaches it, which is a
 * harness somebody can switch to on the screen below. The other two share a
 * remedy — pick something else — and are still two strings, because a harness
 * that refuses every foreign system (kimi) and one that refuses this particular
 * one (codex at Moonshot) are different facts about the fleet.
 */
export function hostable(
  harness: AgentId,
  system: SystemInfo,
  routing: AgentCapabilities["routing"],
): HostRefusal {
  if (system.nativeHarness === harness) return null;
  /*
   * ⚠ **Read from the daemon, not inferred from the model list.** It used to be
   * `models.length === 0`, which conflates "there is no endpoint to point
   * anything at" with "nobody has written the model names down yet". `false` is
   * also the fallback for a daemon too old to send the field, which greys a
   * cross-system pairing rather than offering one that fails at the start.
   */
  if (system.routable !== true) {
    return system.nativeHarness === null
      ? `${system.displayName} cannot be reached from this machine.`
      : `Only ${agentLabel(system.nativeHarness)} can run ${system.displayName} models.`;
  }
  if (routing === null) {
    return `${agentLabel(harness)} only runs its own models.`;
  }
  if (!routing.supported.includes(system.apiType)) {
    return `${agentLabel(harness)} cannot run ${system.displayName} models.`;
  }
  return null;
}

/** One offerable pairing of a system and one of its models. */
export interface ModelChoice {
  system: SystemInfo;
  modelId: string;
  modelName: string;
  /**
   * Where this id came from, and therefore which harnesses may use it.
   *
   * ⚠ **A model *id* is not portable across harnesses even within one system, and
   * this field is what stops the picker pretending it is.** Measured live: the
   * kimi CLI publishes four ids of its own — `kimi-code/kimi-for-coding` ("K2.7
   * Coding"), `…-highspeed`, `kimi-code/k3` ("K3") and `kimi-code/k3-256k` —
   * while Moonshot's Anthropic-compatible endpoint, the one Claude Code gets
   * routed at, wants `kimi-k2-thinking` and its siblings. Offering kimi's
   * spellings under Claude Code produced a list that looked complete and would
   * have failed at the provider.
   *
   * ⚠ **It says nothing about which *models* a harness has.** The two lists
   * overlap in models and not in names — Kimi Code runs a K2 perfectly well, it
   * just calls it "K2.7 Coding" — so any sentence built from this field that reads
   * as "this harness has no K2" is wrong. What a sentence built from it *may* say
   * is that a **name** is absent, which is {@link pairFailure}'s `"name"` arm and
   * the whole of what the wire supports; `supportingHarnesses` answers the same
   * thing from the other end, as which harnesses run *that one model*.
   */
  source: "published" | "table";
}

/**
 * Whether this model needs a pasted key the machine does not have.
 *
 * **A key is needed if and only if the id came from the table.** Nothing else is
 * consulted — not which harness is chosen, not whether one has been, and not
 * whether the system has a native harness at all. The rule is {@link pairFailure}
 * read forwards, and it is total in both directions rather than a default with
 * exceptions:
 *
 * - A **table** id is what the system's own endpoint answers to when something is
 *   routed at it, and the native harness is refused it for the *name*. So the only
 *   pairing that can ever run it is a routed one, and a routed pairing signs with
 *   the pasted key and nothing else. A key is **always** needed.
 * - A **published** id is the native harness's own name for the model, and every
 *   other harness is refused it for the name. So the only pairing that can ever run
 *   it is the native one, and that signs with whatever its own CLI's login wrote.
 *   A key is **never** needed.
 *
 * ⚠ **A key is a fact about the pairing rather than about the system, and reading
 * it as the latter is what made the headline feature unusable.** Moonshot has a
 * native harness, so a system-level answer was `null` for it unconditionally — Kimi
 * Code signs with whatever `kimi login` wrote, which is true. But *routing* Claude
 * Code at Moonshot signs with the pasted key and nothing else, so with none saved
 * the whole flow was green: the model offered, the harness offered, `Add agent`
 * enabled, the preset written — and the daemon then refused `POST /sessions` with
 * "No key is saved for Moonshot on this machine", after a worktree had been made.
 *
 * ⚠ **That fix left one arm still asking the system, and the arm was the model
 * screen's.** With no harness chosen it answered: you cannot know yet whether the
 * pairing will be native or routed, so only a system *nothing* reaches natively is
 * knowably stuck. Sound for a world where both routes into a system offered the
 * same ids, and false from the moment `source` recorded that they do not. What
 * shipped was two rows of one list behaving differently for a reason nobody could
 * see: on a machine with neither key, Moonshot's `Kimi K2` was pressable — refused
 * one screen later, on the harness picker — while Z.ai's `GLM-4.6` was greyed on
 * the spot. Both were equally stuck. `nativeHarness` was standing in for "could
 * this be reached natively", which is right about a **system** and wrong about a
 * **row**: Moonshot is reached natively, just never at that spelling — Kimi Code
 * publishes "K2.7 Coding", "K2.7 Coding Highspeed", "K3" and "K3-256k", and
 * `kimi-k2-thinking` is not among them.
 *
 * ⚠ **The other half of that fix is what must not regress.** "K2.7 Coding" is
 * published by Kimi Code itself, so it stays offered on a machine with no Moonshot
 * key — which is the headline feature, and is exactly what a key check written
 * against the system rather than the model takes out.
 *
 * ⚠ **The harness parameter is gone rather than defaulted, and that is what makes
 * the two screens agree by construction.** One rule, one sentence, no arm that only
 * one caller reaches — the shape the two screens disagreed through. Both callers
 * weigh a settled failure first ({@link pairFailure}), so this is only ever *drawn*
 * for a pairing that could otherwise run; asked about one of the two it refuses, it
 * answers about the route that spelling belongs to, which no screen reaches.
 *
 * ⚠ **`routable` is deliberately not folded in, and the one corner where that
 * shows is written down rather than patched.** A table id only exists where the
 * daemon has somewhere to route: `GET /systems` answers `routable: spec.baseUrl
 * !== null` and every `SYSTEMS` row carrying models carries a `baseUrl`, so on a
 * current daemon "came from the table" already implies "there is a routed door".
 * Against a daemon too old to send the field, `routable` falls back to `false`
 * while the models still arrive — and there this greys the row with a sentence
 * whose remedy is wrong, since pasting a key will not make an old daemon route.
 * It is still the right *answer* (nothing on that machine can run that spelling)
 * and it is still an improvement on what that state used to do, which was offer
 * the row and refuse it a screen later. Reaching for `routable` here would put a
 * fact about the system back inside a rule about the model, which is the shape
 * this function was just corrected out of; {@link hostable} owns that fact and
 * says it in words that fit, one screen along.
 *
 * The sentence names the **system** on every screen that draws it, because the
 * remedy is a different one: a key is pasted under Settings → Machines → that
 * system. On the model list the system is *usually* also the group heading above
 * the row, which makes the noun a repeat there — and it stays anyway, because the
 * heading is drawn only where there is more than one group (`AgentBuilder`), and
 * because the identical string is drawn on the harness picker and beside the
 * builder's button, where nothing above it carries the name at all.
 */
export function keyMissing(choice: ModelChoice, harness: AgentId | null): HostRefusal {
  const absent = `No ${choice.system.displayName} key on this machine.`;
  /*
   * ⚠ **With a harness chosen the question is the *pairing*, and the source is no
   * longer a proxy for it.** A routed pairing is signed by the system credential
   * and by nothing else, whichever list the id came from — so a published id can
   * need a key, which the biconditional above says it never does.
   *
   * That is not a contradiction of the rule so much as its precondition
   * expiring. The published arm rested on "every *other* harness is refused this
   * id for the **name**", which was true of every system until one related its two
   * spellings: `nativeModelPrefix` makes `pairFailure` drop both name arms, so on
   * OpenRouter a published id really is runnable by a routed harness. Measured —
   * with an `OPENROUTER_API_KEY` saved for opencode and no system key, opencode
   * published all 356 rows, `keyMissing` read `published`, Claude Code was offered
   * against one of them, and `applySystem` refused the start with *"No key is
   * saved for OpenRouter on this machine, so nothing can sign these requests."*
   * Two keys, two stores, and the screen had asked for neither.
   */
  if (harness !== null && choice.system.nativeHarness !== harness) {
    return choice.system.keySet ? null : absent;
  }
  /*
   * Native, or nothing chosen yet. A **published** id is proof the native harness
   * holds whatever it signs with — the list came back — and that credential is its
   * own, never this one. A **table** id it did *not* publish means the opposite on
   * a system that relates its spellings, and on every other system this line is
   * unreachable because `pairFailure` has already refused it for the name.
   */
  if (choice.source === "published") return null;
  return choice.system.keySet ? null : absent;
}

/**
 * A published name with the provider's own label taken off the front of it.
 *
 * ⚠ **This is not the surgery `openrouter.ts` refuses, and the difference is the
 * key rather than the act.** That file refuses a *pattern* — `"<Vendor>: "` over
 * an unknown, inconsistent vendor half, absent on 19 of its names and spelled two
 * ways by four vendors — because it infers structure from somebody else's prose.
 * This removes **one known constant**: the system's own `displayName`, which is
 * the exact string `AgentBuilder` paints in the heading directly over the row. The
 * justification is redundancy with that heading, so the heading's own string is
 * the only correct key.
 *
 * ⚠ **`nativeModelPrefix` is the wrong key and looks like the right one.** That
 * field is the provider **key** in the *id* namespace (`opencode/`,
 * `openrouter/`); a published name carries the provider **label**
 * (`OpenCode Zen/`, `OpenRouter/`). They coincide for OpenRouter and do **not**
 * for Zen — which is the system this exists for, so keying on it would do nothing
 * at all for the one case that motivated it while appearing to work. Two strings,
 * two sources; they must not be unified.
 *
 * ⚠ **It fails open, and that is what keying on a constant buys.** Let opencode
 * rename its label — `opencode Zen/`, `Zen/`, none at all — and this simply stops
 * firing: the row reads exactly as it did before this function existed. It can
 * never produce a *wrong* name, only an untidied one. A strip that cut at the
 * first `/` instead would survive the rename and go on cutting, including a slash
 * that belonged to the model.
 *
 * ⚠ **Case is folded and nothing else is.** A label differing only in case still
 * repeats the heading, which is the whole claim being made; it asserts nothing
 * about two models being one, which is the equivalence Q3.488 forbids. No fuzzy
 * match, no normalised punctuation, and no separator but `/` — a space *before*
 * the slash is a format nobody measured. The comparison slices the original string
 * at the original marker's length, so a fold that changes length (`İ`) makes the
 * match fail rather than mis-slice. Never a `RegExp`: `Z.ai (GLM)` is a live
 * `displayName` and every character in it but one is a metacharacter.
 *
 * ⚠ **The remainder is a *stored* value and not only a label.**
 * `defaultAgentName(modelName)` seeds a new preset's name, which is written to
 * `custom_agents.name` — so it is trimmed, and an empty remainder keeps the
 * original rather than handing the builder a blank title and the daemon a name it
 * answers 400 to. Presets already saved are untouched: the edit path freezes a
 * loaded name, so one assembled before this reads `OpenCode Zen/Big Pickle` for
 * ever, which is a name somebody owns and not a migration to run.
 *
 * It does **not** make a model name safe for `noJargon`. The catalogue's names
 * still carry `anthropic` and `openai` as words, and that rule is unchanged.
 */
function withoutProviderLabel(displayName: string, name: string): string {
  // A daemon that sent no display name would make the marker a bare "/" and strip
  // any name that began with one.
  if (displayName.length === 0) return name;
  const marker = `${displayName}/`;
  if (name.slice(0, marker.length).toLowerCase() !== marker.toLowerCase()) return name;
  const rest = name.slice(marker.length).trim();
  return rest.length === 0 ? name : rest;
}

/**
 * Every model this machine can offer, across every system.
 *
 * ⚠ **The whole catalogue, not one harness's** — because the screen asks for the
 * model *first*. Narrowing to the current harness would make picking Codex
 * silently delete Kimi K2 from the list, which is the "where did it go" failure
 * this app refuses everywhere: an option that cannot be used stays, disabled and
 * labelled. {@link hostable} is what greys it.
 *
 * ⚠ **Two sources, and which one applies is the system's to say.** A system's
 * models come from its **native harness's** published list — whatever that CLI
 * decided this week, which no table could hold — or, for a system no CLI ships
 * for, from the daemon's table. Reading the wrong source produces an empty group
 * rather than an error, which is why the two are branched rather than merged.
 */
export function allModels(
  systems: readonly SystemInfo[],
  capabilities: Readonly<Record<string, AgentCapabilities>>,
  /**
   * Model ids a catalogue this browser read has refused for having no tool
   * support — see `OpenRouterRead.toolless`.
   *
   * ⚠ **The filter existed and only one of the two lists went through it.** The
   * table half of a system's models is the catalogue, already filtered; the
   * published half is whatever the native harness says, and opencode says all 362
   * of OpenRouter's — image models included. So a model the catalogue had already
   * refused came back through the published door, was offered, was assembled, and
   * failed on its first turn with OpenRouter's own accurate sentence: *"No
   * endpoints found that support tool use. Try disabling `bash`."* — `bash` being
   * opencode's own shell tool. Measured on the report:
   * `nousresearch/hermes-3-llama-3.1-405b`, whose `supported_parameters` carries
   * no `tools` at all.
   *
   * **Fails open**, which is why it is a list of the *refused* rather than a list
   * of the allowed: a catalogue that could not be read refuses nothing and every
   * published row is offered exactly as before. Optional for the same reason —
   * a caller with no catalogue in hand passes nothing and loses nothing.
   */
  toolless: Iterable<string> = [],
): ModelChoice[] {
  const refused = new Set(toolless);
  const out: ModelChoice[] = [];
  for (const system of systems) {
    const native = system.nativeHarness;
    const published = native === null ? [] : (capabilities[native]?.models ?? []);
    /*
     * ⚠ **What the native harness prefixes its ids with, stripped here so the two
     * lists can meet.** Everything stored, sent and pinned is the endpoint's own
     * spelling — see `SystemConfig.nativeModelPrefix` — so a published id is
     * carried back to it here rather than at save time, which is what lets a
     * preset be re-pointed at another harness without rewriting its model.
     *
     * `""` for every system that has no prefix, which makes the two lines below
     * identity and leaves those systems exactly as they were.
     */
    const prefix = system.nativeModelPrefix ?? "";
    for (const model of published) {
      // `default` is the agent's own "whatever it picks", which is what a session
      // with no preset already does. Offering it as an assembled agent would be a
      // named preset that promises nothing.
      if (model.id === "default") continue;
      /*
       * ⚠ **One harness can be the native side of more than one system, and the
       * prefix is what says which model belongs to which.** opencode is native to
       * both OpenRouter and OpenCode Zen and publishes a single list holding both
       * — `openrouter/qwen/qwen3-coder` beside `opencode/big-pickle`. Without this
       * test each of those systems takes the whole list: 362 rows under OpenRouter
       * including six that are not its models, and 362 under Zen including 356
       * that are not, every one of them unrunnable and none of them saying so.
       *
       * A system with no prefix takes everything, which is every other row here
       * and is exactly what they did before this line existed — those harnesses
       * serve one system each, so there is nothing to divide.
       */
      if (prefix !== "" && !model.id.startsWith(prefix)) continue;
      const id = prefix === "" ? model.id : model.id.slice(prefix.length);
      // The catalogue's answer outranks the harness's list. An agent is tools, so
      // a model that cannot call one is not a row that should be greyed — it is a
      // row with nothing to say.
      if (refused.has(id)) continue;
      out.push({
        system,
        modelId: id,
        modelName: withoutProviderLabel(system.displayName, model.name),
        source: "published",
      });
    }
    for (const model of system.models) {
      // A system can be both native and routable — Moonshot is, and OpenRouter is
      // — so an id may already have arrived from the published list above.
      // Deduplicated on the id, which is what is stored; the two lists spell the
      // *names* differently. For a system with a prefix this is the load-bearing
      // line rather than a tidy-up: without it OpenRouter draws every model twice,
      // once per spelling, each greyed for the harness that did not supply it.
      //
      // Published wins the **row**, and that is the right way round: its presence
      // *proves* the native harness is keyed, so `keyMissing` reads `published`
      // and asks for no key — while the same model arriving only from the table
      // means nothing here can run it without one.
      const already = out.find((one) => one.system.id === system.id && one.modelId === model.id);
      if (already !== undefined) {
        /*
         * ⚠ **…and the table wins the *name*, which is the opposite way round and
         * is not a contradiction.** `source` answers "which harnesses may use this
         * id", and the published row is the one that answers it correctly. The
         * name is a label, and where the same model is spelled twice the
         * endpoint's own name for it beats a harness's rendering of it: opencode
         * publishes `OpenRouter/Claude Opus 5` for what OpenRouter itself calls
         * `Anthropic: Claude Sonnet 5`, so under a heading that already reads
         * `OpenRouter · anthropic` the published form says the provider twice and
         * carries a `/` into every refusal built from it.
         *
         * Taking the name rather than stripping the prefix off it is the whole
         * point: `openrouter.ts` refuses to do surgery on somebody else's label
         * for reasons that apply here word for word, and this needs none — the
         * better name is already in hand.
         */
        already.modelName = model.name;
        continue;
      }
      out.push({ system, modelId: model.id, modelName: model.name, source: "table" });
    }
  }
  return out;
}

/** One provider's models, together, for a list that is read down rather than across. */
export interface ModelGroup {
  system: SystemInfo;
  choices: ModelChoice[];
}

/**
 * The catalogue narrowed by what somebody typed and which provider they ticked.
 *
 * ⚠ **The system's own name is searchable, and that is not a convenience.** The
 * ids people know are half the answer — "moonshot" matches nothing in
 * `kimi-k2-thinking` — so a search that read only the model's name and id would
 * answer "nothing here is called moonshot" over a screen with four of them on it.
 *
 * ⚠ **Nothing is dropped for being unusable.** A refusal greys a row and never
 * removes it, here as everywhere else in this app; the filter takes what somebody
 * asked for and the refusal is drawn on what is left.
 */
export function searchModels(
  choices: readonly ModelChoice[],
  query: string,
  system: string | null,
): ModelChoice[] {
  const needle = query.trim().toLowerCase();
  return choices.filter((one) => {
    if (system !== null && one.system.id !== system) return false;
    if (needle.length === 0) return true;
    return (
      one.modelName.toLowerCase().includes(needle) ||
      one.modelId.toLowerCase().includes(needle) ||
      one.system.displayName.toLowerCase().includes(needle)
    );
  });
}

/**
 * The same list, gathered under the provider each model belongs to.
 *
 * ⚠ **One heading per provider, and nothing else is ever in it.** It split on
 * `(system, source)` for a release — `Moonshot · Kimi Code only` beside
 * `Moonshot · other harnesses` — because one system can be reached two ways with
 * a different set of names on each, and seven undifferentiated rows of "Moonshot"
 * hid that no harness could run more than four of them. That was the right
 * problem and the wrong place to answer it: a heading is where somebody looks for
 * *whose model this is*, and a route pushed into it invents a category nobody
 * asked about while still leaving each row silent about itself.
 *
 * ⚠ **A vendor sub-heading was the second thing tried in that slot, and it is out
 * for the same reason the route was.** OpenRouter's ids carry a `vendor/` half, so
 * a provider past a dozen prefixed rows drew `OpenRouter · qwen`, `OpenRouter ·
 * google`, 38 of them. It answers "whose model is this" honestly enough — the
 * objection above does not catch it — and it was still wrong on the screen: the
 * one list somebody scrolls became 38 lists to scroll past, the same model's
 * variants sat under a heading that made them look like different products, and
 * the search this picker is actually used through already cuts the list far below
 * the size that motivated the split. Q3.503 is the reversal.
 *
 * {@link supportingHarnesses} answers "what will run this" per row instead, as
 * the glyphs of the harnesses that can run that one model — more precise (a row,
 * not a group), no vocabulary, read at a glance.
 *
 * In first-appearance order rather than sorted, so the groups follow `GET
 * /systems` — the daemon's table order, which puts the natively-reachable ones
 * first. Sorting by name would put a key-only provider nobody has a key for at
 * the top of the first screen somebody sees.
 */
export function groupModels(choices: readonly ModelChoice[]): ModelGroup[] {
  const out: ModelGroup[] = [];
  for (const choice of choices) {
    const found = out.find((group) => group.system.id === choice.system.id);
    if (found === undefined) out.push({ system: choice.system, choices: [choice] });
    else found.choices.push(choice);
  }
  return out;
}

/**
 * Which harnesses can run this one model, in `AGENT_IDS` order.
 *
 * ⚠ **The key is deliberately not weighed, and the reason has outlived the fact it
 * used to rest on.** It used to be that {@link keyMissing} answered `null` here
 * anyway — drawn where no harness is chosen, so which kind of pairing this would be
 * was undecided and the question did not arise. It answers by the model's own route
 * now, so the question does arise, and the answer is still no: these say what a
 * model is *for*, which is a settled fact about a spelling and is what somebody
 * scanning a list of names needs. Whether a harness is **ready** is the row's own
 * subline. So a table-spelled model on an unkeyed system draws the routed harness's
 * glyph on a greyed row, and the two do not contradict each other — one says what
 * would run it, the other says what is missing. Folding the key in would delete the
 * glyph instead, leaving a greyed row that names a system and no longer says which
 * harness the key would be *for*. (It used to be put that a key was "a box away,
 * unlike a protocol". The box is gone; this reason never depended on it.)
 *
 * ⚠ **Never empty in practice, and the reason is worth stating**: every offered
 * model arrives either from a harness's own published list — so that harness runs
 * it — or from a routable endpoint, so at least one harness can be pointed there.
 * An empty answer would mean the daemon offered something nothing can run, which
 * is a bug in the table rather than a state to draw.
 */
export function supportingHarnesses(
  choice: ModelChoice,
  capabilities: Readonly<Record<string, AgentCapabilities>>,
): AgentId[] {
  return AGENT_IDS.filter((id) => pairable(id, choice, capabilities[id]?.routing ?? null));
}

/**
 * Why this harness cannot run this model, or `null`.
 *
 * ⚠ **Every earlier version explained the *mechanism* and none of them could be
 * read.** "Only Kimi Code can run this model", "Codex cannot run Moonshot models" —
 * both drawn on the harness screen, where neither "this model" nor "Moonshot" is
 * anywhere to be seen. The model was picked on the previous screen and the system
 * was never on screen at all, so each sentence pointed at something invisible, and
 * two rows in the same situation got two different explanations, which made the
 * pair look arbitrary rather than informative. So a refusal says the *fact*, in
 * the words that are on the screen: this harness, that model. What is lost is
 * *why*, which was never actionable here — the row that is **not** greyed is the
 * answer, and on the builder the harness row is directly above the sentence.
 *
 * ⚠ **"The row that is not greyed" is a claim about *pairing* refusals, and it
 * stopped being universal when a missing key began greying a row too.** For a
 * pairing it still holds: every pickable model comes from some harness's own
 * published list or from a routable endpoint, so one row always clears
 * {@link pairFailure}. The row that clears it can be the one waiting on a key, and
 * then every row on the harness screen is greyed at once. The **picker** no longer
 * walks into that state — {@link keyMissing} greys such a model one screen earlier
 * now — but an edit still reaches it, which is why the arm stays; see
 * {@link harnessRowRefusal}. There the answer is that row's own sentence, which
 * names the system, rather than a row beside it.
 *
 * ⚠ **Three sentences now, and the third is a correction this file's own comments
 * had been demanding since `source` was added.** Two unrelated failures were drawn
 * as one, because the settled half was one boolean: a harness that cannot be
 * pointed at the system at all, and a harness that can but has never seen this
 * *spelling*. Both said `<harness> cannot run <model>.`, so choosing Kimi K2
 * Thinking and opening the harness list read **"Kimi Code cannot run K2"** — about
 * the one CLI that reaches Kimi's models natively, and the exact sentence
 * `ModelChoice.source` and `agent-systems.md` both already said was wrong.
 *
 * The replacement is a sentence about the **name list** — `<harness> has no model
 * called <name>.` — and it is the shape that survives all three bounds these
 * strings are held to, where every shorter one fails at least one:
 *
 * - **It may not read as *this harness has no such model*.** "has no model
 *   **called**" is a claim about a spelling; "cannot run" is a claim about a
 *   capability, and the capability half was the false one.
 * - **It may use no word that is not already on the screen, and none from the
 *   wire.** Both nouns are the reader's own — the harness titles the row it is
 *   drawn on, the model was chosen one screen back and is the builder's first
 *   field — and "model" is the word `hostable`'s own refusals already use.
 * - **It may not claim that two names are one model.** Q3.488: Kimi Code talks to
 *   `api.kimi.com/coding/v1` and `SYSTEMS.moonshot` routes at
 *   `api.moonshot.ai/anthropic` — different host, different API, different
 *   billing — and **nothing on any wire carries an equivalence between their
 *   names**. So "Kimi Code calls this K2.7 Coding" is not a sentence this app is
 *   entitled to write, however much it would help. Which name is *absent* is
 *   knowable from the two lists; which name to use *instead* is not.
 *
 * What is kept from before is the one refusal that is not about a pairing at all: a
 * model only a routed pairing can reach, on a system with no key. Its remedy is a
 * different screen, so it names the system rather than the model — and it is the
 * only one of the three that survives a `null` harness, because it is the only one
 * that does not need a pairing in order to be true.
 *
 * ⚠ **That one is weighed last, and it used to be weighed first.** Key-first was
 * right while the `KeyOnly` box was mounted under the pair on the builder: a missing
 * key was then the only one of these somebody could clear without leaving the
 * screen, so it was what the screen said. The box is gone — there is no
 * authorization on this screen at all — so every remedy is now off it, and the two
 * kinds part on cost instead. A settled failure is permanent; a missing key is a
 * trip to Settings. Naming the key on a pair that is **also** refused for a protocol
 * sells that trip and ends at the same disabled button with a different sentence on
 * it. So the settled fact goes first and the key is what is left when nothing else
 * is wrong. {@link harnessRowRefusal} orders the same two the same way, which is
 * what keeps a greyed row and the button under it from giving one pair two reasons.
 */
export function choiceRefusal(
  /**
   * The harness weighed against this model, or `null` while nobody has chosen
   * one.
   *
   * ⚠ **`null` is a real state and not a missing argument.** The builder starts
   * with no harness — picking one *for* somebody is what made the harness row
   * unpressable — so the model list is first drawn with nothing to weigh against.
   * Only a fact about the *model* can refuse a row there: which of the two routes
   * into its system that id belongs to, and whether that route is authorized. Every
   * other refusal is about a pairing that does not exist yet.
   *
   * ⚠ **It used to be "a fact about the *system*", and one level up is one level
   * too far.** A system is reachable natively or it is not; a **row** is a spelling,
   * and Moonshot is reachable natively at four of them and at none of the others.
   * {@link keyMissing} carries the correction and the bug report it came from.
   */
  harness: AgentId | null,
  choice: ModelChoice,
  routing: AgentCapabilities["routing"],
): HostRefusal {
  // With no harness there is no pairing to weigh, so the model's own route into its
  // system is the whole of what this can say — and that is also what the pairing arm
  // ends on, which is why both fall through to the *same* call rather than to two
  // arms of one function. Two arms is the shape the two screens disagreed through:
  // one row, pressable here and refused one screen later.
  if (harness !== null) {
    const failure = pairFailure(harness, choice, routing);
    if (failure !== null) {
      return failure === "name" ? noModelCalled(harness, choice) : cannotRun(harness, choice);
    }
  }
  return keyMissing(choice, harness);
}

/** Which of the two settled failures a pairing hits. See {@link pairFailure}. */
type PairFailure = "host" | "name";

/**
 * Which of the two settled failures this pairing hits, or `null`.
 *
 * ⚠ **Two questions, and this answers the settled one.** A protocol a harness
 * does not speak, or a model id that belongs to the other route into a system, is
 * settled — nothing anybody does on this machine changes it. A missing key is the
 * other kind: it stays true only until somebody pastes one, on a screen that is not
 * in this flow.
 *
 * The two are still kept apart, and the reason has changed with the screen. It used
 * to be that folding them into one predicate made "add the key" unreachable, because
 * the row that led to the box was greyed — and there is no box now, so that reason
 * has expired with it. What is left is two that have not. The kinds are **ordered**
 * against each other, here and in `choiceRefusal`: a settled failure is drawn ahead
 * of a missing key wherever both are true, since a key cannot rescue a pairing
 * refused for another reason. And `pairable` feeds the model list's glyphs, which
 * are drawn before any harness is chosen and must weigh no key at all — folding it
 * in here is how it would arrive there.
 *
 * ⚠ **And the settled half is itself two facts, which is the correction here.** It
 * was one boolean for a release, so both arms were drawn with `cannotRun` and
 * the screen said "Kimi Code cannot run K2" — false about the product, and the
 * sentence this file's own comments and `agent-systems.md` both already forbade.
 *
 * - `"host"` is `hostable`'s answer folded to a kind: this harness cannot be
 *   *pointed at* this system at all. Codex accepts `openai` and Moonshot answers
 *   `anthropic`, and no model list anywhere changes that.
 * - `"name"` is a fact about a *spelling*, and only a live render found it. A
 *   published id is the **native** harness's own name for the model and reaches
 *   the system through that CLI, so a routed harness has never heard of it; a
 *   table id is what the system's endpoint answers to when something else is
 *   routed at it, so the native CLI has never heard of *that*.
 *
 * ⚠ **The two lists overlap in *models* and not in *names*, and reading the ids
 * alone gets that backwards.** Measured against the installed kimi 0.29.x, printing
 * the names as well this time: it publishes `kimi-code/kimi-for-coding` →
 * **"K2.7 Coding"**, `…-highspeed` → "K2.7 Coding Highspeed", `kimi-code/k3` → "K3"
 * and `kimi-code/k3-256k` → "K3-256k". So Kimi Code runs a K2 perfectly well — what
 * it will not take is the *string* `kimi-k2-thinking`, which is Moonshot's API name
 * for a different build and is not among the four values its config option
 * publishes. The refusal is about a name, never about a model, and any sentence
 * that reads as the latter is wrong.
 *
 * ⚠ **One kind covers both directions of the name collision, deliberately.** They
 * are one fact seen from either end, and the *remedy* is the same from either end:
 * the harness whose own list holds that spelling is the row on this very screen
 * that is not greyed. A second string is what `hostable` gives its "Only <X> can
 * run <Y> models.", and it earns it by having a remedy the other two do not — a
 * harness to switch **to**, rather than a choice to change. Here the two directions
 * differ in nothing a reader can act on, so two strings would be two ways of saying
 * one thing on rows that are in the same situation, which is exactly what made an
 * earlier pair of refusals read as arbitrary.
 */
function pairFailure(
  harness: AgentId,
  choice: ModelChoice,
  routing: AgentCapabilities["routing"],
): PairFailure | null {
  /*
   * `hostable` is called for its *answer*, and its prose is deliberately dropped.
   * The two answer different questions: that one is "can this harness be pointed
   * at this system", whose words are the daemon's own for a start it refuses, and
   * this is "can this harness run this model". Forwarding the first as the second
   * is how "Codex cannot run Moonshot models" ended up under a model called K3.
   */
  if (hostable(harness, choice.system, routing) !== null) return "host";
  /*
   * ⚠ **One system relates its two spellings, and there the name arms below are
   * simply false.** Everything this field's docblock says about kimi and Moonshot
   * holds — two lists, overlapping in models and not in names, with nothing
   * carrying one to the other. OpenRouter is the case that does carry: opencode
   * publishes `openrouter/qwen/qwen3-coder` for exactly what the endpoint claude
   * gets routed at calls `qwen/qwen3-coder`, one catalogue behind one account, and
   * the relation is a constant prefix rather than a guess. Where the daemon says
   * so — `SystemConfig.nativeModelPrefix`, which `pinNativeModel` reads to put the
   * prefix back — a name is never the reason a pairing fails, and claiming
   * otherwise would grey every row of the larger provider in the picker for
   * whichever harness did not happen to supply it.
   *
   * Absent or empty on every other system, so this reads as it always did.
   */
  const relates = (choice.system.nativeModelPrefix ?? "") !== "";
  const native = choice.system.nativeHarness === harness;
  if (!relates && native && choice.source === "table") return "name";
  if (!relates && !native && choice.source === "published") return "name";
  return null;
}

/**
 * The same answer as a yes/no, for the caller that has nowhere to put a reason.
 *
 * {@link supportingHarnesses} draws glyphs on a row that already carries a title,
 * a subline and a check — there is no room for a kind and no line to print one on,
 * so it asks the only question it can render. Kept as its own name rather than
 * inlined because that is the question, and a call site reading
 * `pairFailure(…) === null` inside a `filter` describes the mechanism instead.
 */
function pairable(
  harness: AgentId,
  choice: ModelChoice,
  routing: AgentCapabilities["routing"],
): boolean {
  return pairFailure(harness, choice, routing) === null;
}

/** The sentence a `"host"` failure gets. See {@link choiceRefusal}. */
function cannotRun(harness: AgentId, choice: ModelChoice): string {
  return `${agentLabel(harness)} cannot run ${choice.modelName}.`;
}

/**
 * The sentence a `"name"` failure gets — about the list of names, and nothing else.
 *
 * ⚠ **"has no model *called*" is the whole of it.** Drop the word and it becomes
 * "has no model", which is the false half; replace it with what the harness calls
 * the model instead and it asserts an equivalence Q3.488 says nothing carries. See
 * {@link choiceRefusal} for the three bounds this had to clear.
 */
function noModelCalled(harness: AgentId, choice: ModelChoice): string {
  return `${agentLabel(harness)} has no model called ${choice.modelName}.`;
}

/**
 * The same refusals, in the same order, on a row already titled with the harness.
 *
 * ⚠ **Without this the row said its own name back to itself.** The harness picker
 * draws `Claude Code` as the title, so a subline reading "Claude Code cannot run
 * K3" spends two thirds of the line on the word directly above it. What a greyed
 * row owes is the fact, and the fact is the model.
 *
 * ⚠ **Two sublines for a *pairing* rather than one, and the pair is informative
 * rather than arbitrary.** This shortened a single sentence while the settled half
 * was one boolean, so with Kimi K2 Thinking chosen the Codex row and the Kimi Code
 * row both read "Cannot run K2" — a protocol Codex will never speak and, for Kimi
 * Code, a name that is simply not in its own list. Same words, two unrelated facts,
 * and the second of them false. Rows in the **same** situation still read
 * identically, which was always the rule; what changed is that these two are not in
 * the same situation. See {@link choiceRefusal} for why "No model called …" is the
 * one wording that is true.
 *
 * ⚠ **A missing key refuses here now, and the paragraph this replaces was right
 * about the world it was written for.** It said: a missing key is the one blocker
 * somebody can clear without changing either choice, the box that clears it is on
 * the builder under the pair it is about, and greying this row would hide the only
 * screen that leads there — which is how "I cannot use Kimi's models with Claude
 * Code" became true with nothing on screen saying why. Every clause of that was a
 * fact about the inline `KeyOnly` box, and it held for as long as the box did.
 * **The box is gone**: there is no authorization on the Configure agent screen at
 * all. Greying this row therefore hides nothing, and an option with no way in has
 * to read as unavailable rather than as available-and-then-refused.
 *
 * ⚠ **This is not the bug the box was added for coming back.** That one went green
 * the whole way — model offered, harness offered, `Add agent` enabled, the preset
 * written — and `POST /sessions` refused after a git worktree had been made, with
 * the remedy four taps away in settings and the trip there unmounting the builder
 * and losing the half-assembled agent. The refusal lands in the picker instead,
 * before anything is created: the row is greyed, the button is off, and the sentence
 * names what is missing. Nothing has been built, so nothing is lost, which is
 * stronger than either state before it. The cost, whole: the first routed pairing to
 * a system needs a key pasted under Settings → Machines → that system, once per
 * system per machine.
 *
 * ⚠ **Its key arm is a guard now rather than a step of the flow, and saying so is
 * the point of this paragraph — the prose above it would otherwise imply a live
 * path.** {@link keyMissing} asks the **model**, so a table-spelled model on a
 * system with no key is greyed and unpressable on the model picker
 * (`disabled={why !== null}`, in `AgentBuilder`), and a walk through the two
 * pickers against a fresh listing can no longer arrive here holding one. Two things
 * still can. An **edit** loads a stored preset's harness and model straight out of
 * `GET /custom-agents` and draws this picker over a pair no picker chose — including
 * a pair that was legal when it was saved. And the listing goes stale: `GET
 * /systems` is read once when the builder mounts, so a key revoked on another device
 * — or in the settings sheet on this one — leaves a model that really was pressable
 * when it was pressed. **So the arm stays.** A refusal the happy path can no longer
 * reach is exactly the thing that stops a stale screen acting, and this one guards
 * the write as well as the row: `choiceRefusal` puts the same sentence beside the
 * button, so a preset whose key has gone cannot be saved from the edit screen
 * either.
 *
 * ⚠ **It takes `keyMissing`'s sentence verbatim, which is the exception to the rule
 * two paragraphs up.** The other two are shortened because the harness is the row's
 * title; this one never named the harness, so there is nothing to drop. It names the
 * **system** instead, because its remedy is a different screen and the system is
 * what somebody will go looking for there — the same reason `choiceRefusal` keeps it
 * whole, and the same string at both call sites, so a pair refused on the row and
 * the same pair refused beside the button do not read as two findings.
 *
 * ⚠ **It states the fact and not the way there**, this app's standing rule for a
 * refusal, and it survives the one real argument against it: this is a screen where
 * *every* row can be greyed at once — a table-spelled model with no key is refused
 * by the native harness for the name, by an unroutable one for the protocol and by
 * the routable one for the key — so there is no ungreyed row carrying the remedy.
 * (Reached by an edit or a stale listing rather than by the picker, per the
 * paragraph above; the sentence still has to be right there, which is the whole
 * reason that arm was not deleted along with the path to it.) Three things decide
 * it anyway. A subline is one `truncate`d line
 * (`ChoiceRow`, in `bits.tsx`), so a second sentence is the half that gets clipped,
 * which is the half that would have been the reason for adding it. The place is four
 * levels deep, and "in Settings" points at a screen with several sections and no
 * indication which — a plausible wrong instruction rather than no instruction. And
 * neither "Settings" nor "Machines" is a word on this screen, which is the bound
 * every sentence in this file is held to.
 *
 * ⚠ **A settled failure still outranks it**, so a Codex row under a Moonshot model
 * says the protocol rather than the key: pasting one would not move that row, and a
 * sentence implying it would sell a trip to Settings that ends at the same greyed
 * row. {@link pairFailure} carries the ordering, and `choiceRefusal` shares it.
 */
export function harnessRowRefusal(
  harness: AgentId,
  choice: ModelChoice | null,
  routing: AgentCapabilities["routing"],
): HostRefusal {
  if (choice === null) return null;
  const failure = pairFailure(harness, choice, routing);
  if (failure !== null) {
    return failure === "name"
      ? `No model called ${choice.modelName}.`
      : `Cannot run ${choice.modelName}.`;
  }
  return keyMissing(choice, harness);
}

/**
 * What to call an agent nobody has named.
 *
 * ⚠ **The model, and *not* the harness beside it.** It read
 * `Claude · Kimi K2 Thinking` for one release, which on a 96px tile truncated to
 * `Claude · Ki…` — spending the whole line on the fact the glyph above it was
 * already carrying, and cutting the one it was not. A tile shows three things and
 * none of them may say the same thing twice: the glyph is the harness, the title
 * is this, and the subline is the system.
 *
 * Recomputed while the name field is untouched and frozen the moment it is typed
 * into — see `AgentBuilder`.
 */
export function defaultAgentName(modelName: string): string {
  return modelName;
}

/**
 * The line under an assembled agent's tile.
 *
 * ⚠ **The system, because the other two lines are taken.** The glyph is the
 * harness and the title is the model, so this is the only place the third fact
 * fits — and it is the one somebody needs when two presets share a model name
 * across different endpoints. Falls back to the raw id, which is the honest
 * answer for a system the daemon no longer lists.
 */
export function customAgentSubline(one: CustomAgent, systems: readonly SystemInfo[]): string {
  return systems.find((candidate) => candidate.id === one.system)?.displayName ?? one.system;
}
