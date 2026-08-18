import { hasLiveAgent } from "../wire";
import type { AgentConfig, AgentConfigOption, AgentId, SessionSnapshot, StoredEvent } from "../wire";

/**
 * The rules the composer's control strip is built on, as pure functions.
 *
 * They live here rather than inside `AgentConfigBar.tsx` for one reason: `webcheck`
 * has no DOM, so anything expressed as JSX is untested by construction. Every rule
 * here can be got wrong silently — a control that quietly stops rendering, a
 * percentage drawn from a denominator nobody measured — which is exactly the class
 * of thing that has to be assertable.
 */

/**
 * Where a control sits on the strip.
 *
 * `hidden` is not rendered at all. `nested` is rendered *inside another control's
 * menu* rather than as a chip of its own — see {@link NESTED_HOST}.
 */
export type Slot = "left" | "right" | "overflow" | "hidden" | "nested";

/**
 * The category whose menu hosts every `nested` control.
 *
 * One host and not a mapping, because the argument for nesting is not "these two
 * are related" — it is that **the strip must not change shape between agents**. A
 * control only one agent publishes, given a chip or a `…` of its own, moves every
 * other button along the row the moment you switch sessions, and the row is the
 * one piece of chrome that is supposed to be the same everywhere.
 *
 * `mode` is the host because what nests in it is a mode: codex's
 * `collaboration_mode` picks Default or Plan, which is the same *kind* of decision
 * as its `mode` (read-only / agent / full access) at a different altitude. Two
 * menus, one chip.
 */
export const NESTED_HOST = "mode";

/**
 * Slot by `category`, never by `id`.
 *
 * The same rule the whole bar is built on: claude publishes reasoning effort as
 * `effort` and kimi publishes the same concept as `thinking`, so a table keyed on
 * ids renders one agent's controls and none of the other's.
 *
 * `model_config` is **hidden**, and that is a product decision rather than an
 * oversight. Its only occupant today is claude's `Fast mode`, which was asked for
 * by name to be removed — and with it gone the `…` button it was the sole content
 * of disappears too, which was the actual complaint: a permanent overflow control
 * on the composer that opened onto one toggle nobody wanted.
 *
 * **Unknown categories are still demoted, never dropped.** ACP says a category is
 * a UX hint that must not be required for correctness, so a control nobody has
 * heard of keeps a way to be reached — it goes behind `…`, not into the bin, and
 * the button reappears the moment such a control exists. Hiding a category we *do*
 * know is a decision about a known control; hiding one we do not would be deciding
 * on somebody's behalf about a control we have never seen.
 */
const CATEGORY_SLOT: Record<string, Slot> = {
  mode: "left",
  model: "right",
  thought_level: "right",
  model_config: "hidden",
  /*
   * **codex's plan switch, nested rather than demoted.** It went to `overflow`
   * first, as an unknown category correctly does — and that put a `…` button on
   * the strip for codex sessions and no other, which is the shape change the rule
   * above exists to make impossible in the *other* direction. Measured: codex
   * publishes it as Default / Plan ("Plan before making changes") and surfaces the
   * same switch as `/plan`, whose `_meta.commandAction` writes this very option.
   *
   * Naming it here is a decision about a *known* control, which is exactly what
   * the docblock above says is allowed — the demotion rule governs categories
   * nobody has looked at, and this one has now been looked at.
   */
  collaboration_mode: "nested",
};

export function slotFor(option: Pick<AgentConfigOption, "category">): Slot {
  return CATEGORY_SLOT[option.category ?? ""] ?? "overflow";
}

/**
 * What a control is called, where the agents disagree about one concept.
 *
 * Measured 2026-08-04 against the live agents: claude calls reasoning effort
 * `Effort` and kimi calls the identical control `Thinking` (`id: "thinking"`,
 * `category: "thought_level"`, choices Low/High/Max). Same slot, same category,
 * same thing — two words.
 *
 * That is not merely untidy, it is *internally* inconsistent: `buildCommands`
 * already synthesizes this control as `/effort` on every agent, keyed on the same
 * category and for the same reason, so on kimi the slash menu says `effort` and
 * the chip one tap away says `Thinking`. One of the two had to give, and the
 * command is the one with the stronger claim — a name typed by a person has to be
 * portable, which is why it is ours there rather than the agent's.
 *
 * **Only where the agents disagree.** `model` is `Model` on both, `mode` is
 * `Mode`, and an unknown category has no second opinion to reconcile — those keep
 * the agent's own word, because overriding a name we have no better version of is
 * how a client starts inventing vocabulary. Keyed on `category` like everything
 * else here, never on an id: the ids are `effort` and `thinking`, which is the
 * whole problem.
 */
const CATEGORY_LABEL: Record<string, string> = {
  thought_level: "Effort",
};

export function labelFor(option: Pick<AgentConfigOption, "category" | "name">): string {
  return CATEGORY_LABEL[option.category ?? ""] ?? option.name;
}

/**
 * What the strip draws, and whether the agent behind it is there to be asked.
 *
 * The whole of the "controls must not blink out of existence" rule, as one
 * answer. `stale` is deliberately **not** "optimistic": every value in it is the
 * last thing the daemon *confirmed*, and what the flag buys is the refusal — a
 * chip drawn from a memory may be read and may not be tapped, because there is
 * nothing on the other end to accept the change.
 *
 * The three arms, in the order they are tested: a live agent that published
 * something is drawn; a live agent that published nothing draws nothing, because
 * an agent with no controls is a fact rather than a gap; and only when there is
 * no agent at all does the memory stand in.
 */
export interface DrawnControls {
  options: readonly AgentConfigOption[];
  stale: boolean;
  /**
   * Controls the agent has stopped offering, by id.
   *
   * **A control never leaves the strip.** An agent drops one when the model stops
   * supporting it — choose Haiku and claude deletes the effort option outright,
   * because it builds that list from the current model's own levels — and a
   * button that simply vanishes takes its neighbours' positions with it and says
   * nothing about where it went. The slot stays, drawn as unavailable, and the
   * one row in its menu says there is nothing to choose.
   *
   * Empty whenever there is no live agent: "the agent is not offering this" and
   * "there is no agent" are different sentences, and `stale` is already the
   * second one.
   */
  unavailable: ReadonlySet<string>;
}

const NOTHING: ReadonlySet<string> = new Set();

export function drawnControls(
  session: Pick<SessionSnapshot, "status" | "agentConfig">,
  held: AgentConfig | undefined,
): DrawnControls {
  const live = session.agentConfig?.options ?? [];
  if (live.length > 0) {
    /*
     * The live set, plus the slots of anything it has stopped offering.
     *
     * Built this way round — live first, memory only for what is *missing* —
     * rather than by drawing `held` and trusting it to be a superset. It is one,
     * because `holdConfig` merges; but a rule that reads correctly only while a
     * function in another file keeps its promise is the kind that survives
     * exactly until somebody edits that file. Here a value can only ever come
     * from the agent's current answer.
     */
    const liveIds = new Set(live.map((option) => option.id));
    const dropped = (held?.options ?? []).filter((option) => !liveIds.has(option.id));
    if (dropped.length === 0) return { options: live, stale: false, unavailable: NOTHING };
    return {
      options: [...live, ...dropped],
      stale: false,
      unavailable: new Set(dropped.map((option) => option.id)),
    };
  }
  if (hasLiveAgent(session.status)) return { options: [], stale: false, unavailable: NOTHING };
  return { options: held?.options ?? [], stale: held !== undefined, unavailable: NOTHING };
}

/**
 * Why a control is on the strip with nothing to choose.
 *
 * Keyed on `category` like everything else here, never on an agent id — but the
 * effort case earns a sentence of its own for `contextHint`'s reason: "why is
 * this empty" has a specific answer there and a vague one everywhere else. The
 * specific answer is measured rather than guessed: all three agents build this
 * list from the currently selected model's own levels, and all three drop the
 * control when there are none.
 */
export function unavailableHint(option: Pick<AgentConfigOption, "category">): string {
  return option.category === "thought_level"
    ? "The model in use offers no levels here. Another model may."
    : "The agent is not offering this control at the moment.";
}

/**
 * The daemon's own value for the row it appends to claude's effort control, and
 * the capability it requires before appending it.
 *
 * ⚠ **Hand-mirrored literals**, for the reason `CATEGORY_RESERVE` gives about the
 * *name* one screen down: `packages/web` cannot import from `src/`. `webcheck`
 * now reads `src/registry.ts` as text and pins both these and that name, which is
 * the guard that note said was missing.
 */
const ULTRACODE_VALUE = "ultracode";
const XHIGH_VALUE = "xhigh";

/**
 * Choosing this value restarts the agent, which is why the daemon refuses it
 * while a turn is running.
 *
 * The client half of the one turn-shaped refusal on `POST /sessions/:id/config`.
 * **Both directions**, because leaving ultracode restarts just as hard: choosing
 * an ordinary level clears the flag first and then falls through, so with
 * ultracode on, every ordinary level is refused too.
 *
 * **Written as a superset of the daemon's gate, on purpose.** The toast for this
 * code is suppressed, so a false negative here is a silent no-op — which means
 * every clause has to be one the daemon has already implied by appending the row
 * at all: it finds the control by `thought_level` and never by id, the drawn
 * choices are the agent's list plus the row, and it appends only to a list that
 * already carried `xhigh`.
 *
 * ⚠ It can still answer `true` where the daemon would not: an agent shipping its
 * *own* `ultracode` choice takes the row back, and the value then travels as an
 * ordinary selection, indistinguishable on the wire. No agent does that today,
 * and the honest retirement is a `restarts` field on the choice rather than a
 * cleverer guess here. Q3.429.
 */
export function restartsAgent(option: AgentConfigOption, value: string | boolean): boolean {
  if (option.category !== "thought_level" || option.kind !== "select") return false;
  if (!option.choices.some((choice) => choice.value === ULTRACODE_VALUE)) return false;
  if (!option.choices.some((choice) => choice.value === XHIGH_VALUE)) return false;
  return (value === ULTRACODE_VALUE) !== (option.value === ULTRACODE_VALUE);
}

/**
 * What a choice says instead of acting, while the daemon would refuse it.
 *
 * The row-level twin of {@link unavailableHint}, making the same bargain `Absent`
 * makes for a whole control: it opens, says its sentence, and sends nothing. Both
 * ways out are named, and the second is the Stop control in the same composer, so
 * the row is a destination rather than a dead end.
 *
 * `turnRunning` is `turnInFlight` — the field the daemon gates on. The sentence
 * says **"this turn is running"** and not "the agent is working", deliberately: a
 * parked permission keeps the turn open while `showsWorking` reads false, so
 * "working" would be the one false word in a change about controls being true.
 */
export function choiceRefusal(
  option: AgentConfigOption,
  value: string | boolean,
  turnRunning: boolean,
): string | null {
  return turnRunning && restartsAgent(option, value)
    ? "Restarts the agent, so not while this turn is running — wait for it, or Stop."
    : null;
}

/** What an unavailable control shows where its value would be. */
export const UNAVAILABLE_VALUE = "—";

/**
 * Everything a chip contains, from one place, so its two renderings cannot drift.
 *
 * There are two of them — the live control and the slot of one the agent has
 * stopped offering — and they must be **the same width**, because the right-hand
 * cluster is right-aligned and any difference drags every button beside it. They
 * were not: the unavailable one drew the control's name where the live one
 * deliberately does not, so choosing a model with no effort levels widened that
 * chip by a word and a gap and shoved the rest of the strip sideways.
 *
 * The property that fixes it is structural rather than remembered: **`caption`
 * and `reserve` do not depend on `available`**, so the only thing that changes
 * when a control becomes unavailable is the string inside a box whose width was
 * already reserved. `webcheck` asserts exactly that, over every category.
 */
export interface ChipParts {
  /** The control's own name, or `null` where the value names it. */
  caption: string | null;
  value: string;
  /** Every value this chip could show, for the width it reserves. */
  reserve: string[] | null;
}

export function chipParts(option: AgentConfigOption, available: boolean, prose?: ConfigProse): ChipParts {
  return {
    caption: showsCaption(option) ? labelFor(option) : null,
    value: available ? chipValue(option, prose) : UNAVAILABLE_VALUE,
    reserve: chipReserve(option),
  };
}

/**
 * Changes asked for and not yet answered, by option id.
 *
 * A map rather than one entry, because two controls can be in flight at once:
 * the strip's own lock fences it against itself and the composer's `/` menu does
 * not read it at all. Where they live is `ui/choices.ts`.
 */
export type PendingChoices = ReadonlyMap<string, string | boolean>;

/**
 * The option as the person who just tapped it expects to see it.
 *
 * A chip showed the value it was *leaving* for the whole of the round trip —
 * choose Low and it read "Adaptive" with a spinner, then Low — which is a
 * loading state about a decision that was already made. The value is the
 * person's own, so it is drawn at once and put back if the daemon refuses,
 * exactly as the composer treats a message it is still sending.
 *
 * This is not the optimism the Stop control refuses. That one would claim an
 * *agent* had been called off while it was still working, which is a statement
 * about somebody else; this is a statement about what was chosen here, and the
 * remedy for being wrong is that the daemon's own answer replaces it a moment
 * later.
 *
 * Returns the option itself when there is nothing to override, so the identity is
 * stable for everything memoised on it.
 */
export function withChoice(option: AgentConfigOption, pending: PendingChoices | null): AgentConfigOption {
  const wanted = pending?.get(option.id);
  if (wanted === undefined || wanted === option.value) return option;
  return { ...option, value: wanted };
}

/**
 * The categories whose chip says nothing but its value.
 *
 * Two of them, and the rule behind the pair is that a caption is dropped only
 * where the chip is identified *twice over* without it: the category draws an
 * icon (`CATEGORY_ICON`), and its value is a proper noun that answers "what is
 * this" by itself — "Opus 5", "Adaptive". Spending a word on "Model" beside
 * "Opus 5" is a word that says nothing and a width that changes for nothing.
 *
 * Everything else keeps its caption, and the exclusions matter more than the
 * inclusions:
 *
 *   - `mode`'s value is not self-describing. "Manual" alone leaves nothing on
 *     screen saying what is on manual, which is a complaint this file has
 *     already answered once.
 *   - an unknown category has **no icon** — `CATEGORY_ICON` is keyed by the
 *     categories we know — so its chip without a caption is a bare value with
 *     nothing at all identifying it, in the overflow popover where there is no
 *     position to read it by either.
 */
const CAPTION_SILENT = new Set(["model", "thought_level"]);

export function showsCaption(option: Pick<AgentConfigOption, "category">): boolean {
  return !CAPTION_SILENT.has(option.category ?? "");
}

/**
 * The width each chip holds open, as the strings that size it.
 *
 * **One list per category and never per agent**, which is the whole change from
 * the first version of this: reserving the widest of *the agent's own* labels
 * made claude's effort chip wider than kimi's, so the same strip was a different
 * shape depending on which session you were looking at — and switching between
 * two sessions moved every button. A width that depends only on the category is
 * the same on all three agents, before any of them has said anything.
 *
 * Sized by *rendering the strings* rather than by counting characters: `length`
 * is a proxy that is wrong the first time a narrow-lettered word is longer than a
 * wide-lettered one.
 *
 * The strings are measured values rather than invented ones, and each is the
 * longest ordinary one for its category — the rare longer ones truncate, with the
 * full text one tap away in the menu and in the chip's own `title`:
 *
 *   - **mode** — claude's `Accept Edits`. `Bypass Permissions` is longer and is
 *     the one claude drops unless it is running as root, so sizing to it would
 *     spend a third of a phone's strip on a value almost nobody sees.
 *   - **model** — codex's `GPT-5.6-Luna`, the longest head {@link chipValue} mines
 *     across the three (claude's are `Opus 5`, `Sonnet 5`, `Haiku`). It was
 *     `GPT-5.6-Sol` for one revision, which is a *shorter* name from the same
 *     family — proof that this list is a measurement and has to be taken from the
 *     longest one actually seen rather than the first one looked at.
 *   - **thought_level** — two, and neither belongs to an agent. `Adaptive` is
 *     ours, what {@link choiceOverride} renames the default to; `Ultracode` is the
 *     daemon's, appended to claude's effort control by `withUltracode` and drawn
 *     verbatim, since it is a choice no agent publishes and `chipValue` has nothing
 *     to mine it down to. It is the longer of the two, so with only `Adaptive` here
 *     the one row this client invents a width for was the one row that ellipsised —
 *     `Ultrac…`, on the control somebody had just used.
 *     ⚠ **A hand-mirrored literal.** `packages/web` cannot import from `src/`, so
 *     this is a second copy of `name: "Ultracode"` in `src/registry.ts`. It used to
 *     be unchecked — `daemoncheck` pins `ULTRACODE_CHOICE`, which is the *value*,
 *     not the name — so renaming the choice there truncated this chip again with
 *     every driver green. `webcheck` now reads `src/registry.ts` as text and pins
 *     the name against this table and the two values against `ULTRACODE_VALUE` /
 *     `XHIGH_VALUE` above, which closes it.
 *
 * `UNAVAILABLE_VALUE` is in every one of them, so a control the agent stops
 * offering keeps exactly the width it had.
 *
 * `null` — no reservation — for everything else, and that is not an omission: an
 * unknown category is drawn in the overflow popover, a column where every chip is
 * on its own row and nothing is beside it to be moved.
 */
const CATEGORY_RESERVE: Record<string, string[]> = {
  mode: ["Accept Edits", UNAVAILABLE_VALUE],
  model: ["GPT-5.6-Luna", UNAVAILABLE_VALUE],
  thought_level: ["Adaptive", "Ultracode", UNAVAILABLE_VALUE],
};

export function chipReserve(option: Pick<AgentConfigOption, "category">): string[] | null {
  return CATEGORY_RESERVE[option.category ?? ""] ?? null;
}

/** Right-hand controls in a fixed reading order; the rest alphabetical. */
const RIGHT_ORDER: Record<string, number> = { model: 0, thought_level: 1 };

/**
 * The options split into the three slots.
 *
 * Every input option lands in exactly one of the three — asserted, because the
 * failure mode of a partition that loses a member is a control that silently
 * stops existing.
 */
export function splitOptions(options: readonly AgentConfigOption[]): Record<Slot, AgentConfigOption[]> {
  const out: Record<Slot, AgentConfigOption[]> = { left: [], right: [], overflow: [], hidden: [], nested: [] };
  for (const option of options) out[slotFor(option)].push(option);
  /*
   * **A nested control with no host is not dropped, it is demoted.**
   *
   * `nested` names a place inside another control's menu, and that place only
   * exists if the host is on the strip. An agent that publishes
   * `collaboration_mode` and no `mode` is not one anybody has seen — but "not seen"
   * is how a control silently stops existing, which is the failure the whole slot
   * partition is asserted against. Overflow is the honest fallback: it is where an
   * unfamiliar control already goes, and it is reachable.
   */
  /*
   * **A boolean is demoted on both sides of the nesting, and for one reason read
   * twice: what nests is a *menu of choices*, and a boolean has none.**
   *
   * As a **host** it is a toggle, so there is no menu to nest into. As the
   * **nested** control it carries no `choices` at all — `wire.ts` says the array
   * is empty for a boolean — so `ChoiceSection` would draw a divider and a
   * heading with nothing under them, and `commands.ts` skips booleans as well, so
   * there would be no second way to reach it. That is a control silently ceasing
   * to exist, which is exactly what the partition below is asserted against; the
   * shape it was in before `nested` existed — `overflow`, drawn as a working
   * Toggle — is still available and is where it goes.
   *
   * Decided here rather than in the renderer, because "which slot is this in" is
   * the question this module answers and `webcheck` asserts.
   */
  const nestable = out.nested.filter((option) => option.kind !== "boolean");
  if (nestable.length !== out.nested.length) {
    out.overflow.push(...out.nested.filter((option) => option.kind === "boolean"));
    out.nested = nestable;
  }
  const host = out.left.find((option) => option.category === NESTED_HOST && option.kind !== "boolean");
  if (out.nested.length > 0 && host === undefined) {
    out.overflow.push(...out.nested);
    out.nested = [];
  }
  out.right.sort(
    (a, b) =>
      (RIGHT_ORDER[a.category ?? ""] ?? 9) - (RIGHT_ORDER[b.category ?? ""] ?? 9) ||
      a.name.localeCompare(b.name),
  );
  out.overflow.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * How full the context window is, as a whole percent, or `null` for "cannot tell".
 *
 * Three answers and not two. `null`/`undefined` is an agent that never said (kimi
 * may never say) or a session with no live agent; `size <= 0` is an agent that
 * reported occupancy without a window. Neither may render as a *hole*: this used
 * to unmount the readout entirely, on the grounds that a grey ring reads as "0%
 * used" and an empty one as "plenty left". That was right about the ring and
 * wrong about the remedy — unmounting slid the model and effort chips sideways
 * every time an agent started or stopped reporting. `pieTone` answers `"unknown"`
 * here, which is what keeps the slot quiet without keeping it empty.
 *
 * Clamped rather than trusted: `used > size` is possible across a model switch
 * that shrinks the window, and an arc drawn past its own circumference is worse
 * than one that reads full.
 */
export function contextPercent(
  usage: SessionSnapshot["contextUsage"] | undefined,
): number | null {
  if (usage === null || usage === undefined) return null;
  const { used, size } = usage;
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / size) * 100)));
}

/**
 * What the context readout says, where it says it in words.
 *
 * Not in the control strip: the number used to sit beside the ring there and was
 * the widest thing in that cluster, for a reading nobody needs continuously. It
 * is in the popover the ring opens — and in the trigger's `aria-label`, so this
 * still runs on every render, which is the part worth being accurate about. What
 * changed is not how often it is *called* but that its result is no longer a
 * laid-out element whose width can move a neighbour, which is why there is no
 * longer a widest-label constant to size a slot with. A ring is one width at
 * every percentage.
 *
 * `null` reads `0%` by decision rather than by accident: it is not a measurement
 * and the tone says so — {@link pieTone} answers `"unknown"`, which the caller
 * draws in the quietest colour it has, and the popover says the agent has not
 * reported rather than quoting the zero back as though it had.
 */
export function pieLabel(percent: number | null): string {
  return `${percent ?? 0}%`;
}

/**
 * Why the context readout is empty, in words, when it is.
 *
 * There is an agent-specific answer and no generic one, which is the whole reason
 * this exists and the reason `AgentConfigBar` is allowed to know one agent's name
 * here and nowhere else. Measured: `usage_update` appears in kimi 0.29.2's bundle
 * exactly once, inside the vendored zod schema for the protocol — it is a shape
 * kimi can parse and never one it sends. claude's adapter constructs it in three
 * places and emits it on essentially every output token.
 *
 * So on kimi the readout is empty for the life of every session, and "the agent
 * has not said" reads as *yet* — as though the number were coming. It is not, and
 * somebody watching a long conversation stay at zero reasonably concludes the
 * client is broken. This says so, and points at the one thing that does work:
 * kimi publishes `usage` as a builtin command, so a person can ask it themselves.
 *
 * **Codex takes the neutral arm because it reports, not because it is not kimi.**
 * Worth stating, since every agent but one falls into the `else` and the shape
 * cannot tell a measured silence from an unconsidered one. Measured 2026-08-07
 * against codex-acp 1.1.9: one prompt produced two `usage_update` notifications
 * carrying `{used, size}`, so on codex the readout fills in and "the agent has not
 * reported this" means *yet* — which is what it says.
 *
 * **We deliberately do not send that command for them.** ACP has no request for
 * usage — twenty methods and not one of them asks — so "asking" means sending a
 * prompt, and a prompt takes the session's one turn. A background poll would hold
 * that turn and answer somebody's real message with `409 turn_in_flight`, and its
 * reply would land in the transcript as an agent message nobody asked for. Free
 * in tokens is not free.
 */
export function contextHint(agent: AgentId): string {
  return agent === "kimi"
    ? "kimi does not report this — send /usage to ask it"
    : "the agent has not reported this";
}

/** How alarmed the context readout is. A level, so the thresholds are assertable. */
export type PieLevel = "unknown" | "ok" | "warn" | "critical";

/**
 * The thresholds, as a level rather than a colour.
 *
 * They were a ternary in a JSX prop, which `webcheck` cannot reach. The class
 * strings stay beside every other `Record<…, string>` in the `.tsx`: a colour is
 * not a rule, and a pure module full of Tailwind is a pure module with nothing
 * worth asserting in it.
 */
export function pieTone(percent: number | null): PieLevel {
  if (percent === null) return "unknown";
  if (percent >= 90) return "critical";
  if (percent >= 75) return "warn";
  return "ok";
}

/**
 * What a control's chip says its value is.
 *
 * The question this answers is "which model am I on", and the honest answer is
 * often not the choice's *name*. Measured 2026-07-31 against claude 0.63.0 the
 * model list is:
 *
 *   value "default"    name "Default (recommended)"  desc "Opus 5 with 1M context · Best for everyday…"
 *   value "opus[1m]"   name "Opus (1M context)"      desc "Opus 5 with 1M context · Best for everyday…"
 *   value "sonnet"     name "Sonnet"                 desc "Sonnet 5 · Efficient for routine tasks"
 *
 * So on a session that has never picked a model — the common case — the name is
 * `Default (recommended)`, which tells nobody anything, while the description says
 * exactly which model it is. The head of the description, up to the `·` that
 * separates the model from its blurb, is the concrete answer.
 *
 * **Narrowed to `category === "model"` on purpose.** For `mode` the descriptions
 * are sentences about behaviour — kimi's `default` reads "Manual approvals; tools
 * execute normally." — so the head of one is a fragment, not a label, and the name
 * is plainly the better answer. Applying this everywhere would make every chip
 * worse to fix one. Category and never id, as everywhere else here.
 *
 * `mode` has its own answer where it needs one, in {@link choiceOverride}, which
 * runs first — so a chip reading "Default" is fixed by naming the value rather
 * than by mining a sentence for a noun.
 *
 * Falls back to the name whenever there is no description, which is what kimi and
 * claude's effort control both give — so nothing here can invent a value.
 */
export function chipValue(option: AgentConfigOption, prose?: ConfigProse): string {
  const choice = option.choices.find((candidate) => candidate.value === option.value);
  const name = choice?.name ?? String(option.value);

  const override = choiceOverride(option, option.value)?.label ?? null;
  if (override !== null) return override;
  if (option.category !== "model") return name;

  const description = choice?.description ?? prose?.choices.get(String(option.value)) ?? null;
  if (description === null) return name;
  /*
   * **The separator is required, not merely used when present.**
   *
   * `·` is claude's separator between the model and its blurb, an en/em dash the
   * plausible variant, and the head before it is a model name *because* something
   * follows it. Without one the description is a whole sentence and mining it
   * produces a sentence, which is what a length guard alone let through: codex
   * publishes `gpt-5.6-sol` as name "GPT-5.6-Sol" with description "Latest
   * frontier agentic coding model." — 37 characters, under any reasonable ceiling
   * — so the chip read "Latest frontier agentic cod…" while the actual model name
   * sat unused in `name`.
   *
   * That is the whole reason this function exists, inverted. It mines a
   * description only because claude's *name* is "Default (recommended)" and says
   * nothing; an agent whose name is already the model has nothing to rescue.
   */
  const parts = description.split(/\s[·—–]\s/);
  if (parts.length === 1) return name;
  const head = parts[0]?.trim() ?? "";
  // The length guard survives, for a head that has a separator after it and is
  // still a sentence. Judged *before* the qualifier is split off, not after:
  // splitting on " with " would rescue "a description that runs on…" into
  // "a description" — a plausible-looking string that is not a model name.
  if (head.length === 0 || head.length > 40) return name;
  // "Opus 5 with 1M context" → "Opus 5". The context length is a property of the
  // *choice*, already spelled out in the menu row and in the description under it;
  // on a chip it is three extra words competing with the one that matters. Split
  // on the qualifier rather than trimming a fixed suffix, so "Sonnet 5" and
  // "Haiku 4.5" — which carry none — are untouched.
  const model = head.split(/\s+with\s+/i)[0]?.trim() ?? head;
  return model.length === 0 ? name : model;
}

/** What this client knows about one choice that the agent did not say. */
export interface ChoiceOverride {
  /**
   * Shown instead of `choice.name`, or `null` to keep the agent's own word.
   *
   * `null` is the ordinary answer and renaming is the exception. A client that
   * renames what an agent calls something is a client inventing vocabulary, and
   * the bar for it is that the agent's name conveys *nothing* — which is true of
   * claude's effort `Default`, whose meaning is not in the ACP payload at all,
   * and is not true of a mode the agent went on to describe in a sentence.
   */
  label: string | null;
  /** Shown underneath **only where the agent said nothing** of its own. */
  description: string;
}

/**
 * The two choices whose own name is the word `Default`, and what this client can
 * say about them that the agent did not.
 *
 * Both are the same complaint — "Default" answers nothing — and they get *different
 * answers*, which is the point of the shape. Written down once, here, because three
 * surfaces name a choice (the chip, the control's menu row, the `/` menu's second
 * stage) and a rule copied into any of them is a rule that will disagree with the
 * other two.
 *
 * Keyed on `category` and the literal value `default`, never on an id — the same
 * rule the rest of this module and `commands.ts` are built on, and the reason each
 * of these is narrow rather than a blanket "rename every `default`".
 *
 * **`thought_level` → renamed to `Adaptive`.** Here the agent's name is all there
 * is: every effort choice claude publishes carries `description: null`, so there
 * is nothing underneath to explain it with. The answer is not in the ACP payload
 * at all and was read out of the CLI itself, 2026-07-31:
 *
 *   - `/effort`'s own parser maps the unset case to *nothing*:
 *     `if (r === "auto" || r === "unset") return { value: void 0 }` — no effort
 *     parameter is sent to the API.
 *   - and the model's documented behaviour with none sent is
 *     *"Adaptive thinking on by default (omitting `thinking` runs adaptive)"*.
 *
 * So `default` is not a hidden fixed level that could be named; it is the model
 * deciding how much to think, per turn. Kimi's equivalent value is `off`, which
 * means something else entirely and keeps its own name.
 *
 * **`mode` → explained, not renamed**, and that asymmetry was argued and then
 * decided the other way. Measured 2026-08-06, the two agents name one identical
 * mode id differently:
 *
 *   claude  value "default"  name "Manual"   description null
 *   kimi    value "default"  name "Default"  description "Manual approvals; tools
 *                                             execute normally."
 *
 * The first attempt reconciled them to `Manual` — claude's own word, and the word
 * kimi's own sentence opens with. That is defensible and it is not what this does,
 * because the premise is weaker here than at `thought_level`: kimi *did* say what
 * its mode means, in a sentence, so the name is not the only thing there is. The
 * fix for "Default says nothing" is then the caption rather than a rename, and the
 * agent goes on being called what it calls itself — which is the rule `labelFor`
 * states for controls, applied to choices.
 *
 * So `label` is `null` and only the description is supplied. It is a **fallback**:
 * kimi's sentence is better than ours and wins; claude, which sends none, gets
 * ours, so the row says what the mode is on both. For effort the distinction is
 * invisible, since there is never one to prefer.
 */
export function choiceOverride(option: AgentConfigOption, selected: string | boolean): ChoiceOverride | null {
  if (selected !== "default") return null;
  if (option.category === "thought_level") {
    return { label: "Adaptive", description: "The model decides how much to think, per turn" };
  }
  if (option.category === "mode") {
    return { label: null, description: "The agent asks before running each tool" };
  }
  return null;
}

/**
 * `124k`, `1.2M` — a token count at the width a chip has for one.
 *
 * **The unit is chosen from the rounded number, not the raw one**, which is the
 * only interesting line here. Deciding on the raw value and rounding afterwards
 * lets the rounding carry the number *out* of the unit that was just picked:
 * 999,999 is under a million, so it took the `k` arm, and `Math.round(999999/100)
 * / 10` is 1000 — printing `1000k`, which is four characters wider than the `1M`
 * this exists to produce and reads as a different order of magnitude.
 *
 * Only the `k`/`M` boundary is guarded. Above `M` there is no larger unit to be
 * carried into, so a number big enough to round to `1000M` is honestly `1000M`.
 */
export function shortCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value < 1000) return String(Math.round(value));
  const thousands = Math.round(value / 100) / 10;
  if (thousands < 1000) return `${thousands}k`;
  return `${Math.round(value / 100_000) / 10}M`;
}

/** Descriptions for one option and its choices, recovered from the transcript. */
export interface ConfigProse {
  description: string | null;
  choices: Map<string, string>;
}

/**
 * The prose the snapshot deliberately does not carry.
 *
 * `registry.ts`'s `snapshotConfig` nulls every `description` before a snapshot
 * goes out, because the snapshot rides `GET /sessions` for up to sixty sessions
 * every four seconds and a model list with prose is the large part. Its own
 * comment ends "The descriptions are still in the transcript for anything that
 * wants them" — this is that thing.
 *
 * It matters for one visible reason. Both agents publish a model and an effort
 * choice literally named `Default`, which on its own tells a person nothing, and
 * the concrete answer — which model that actually resolves to — is in the
 * description. Deleting the choice would remove a working option; showing its
 * description is what makes it mean something.
 *
 * **State still comes from the snapshot; only prose comes from the log.** That
 * ordering is the invariant — a control's current value must never be read from a
 * transcript that may have been paged out. When the `agent_config` event is gone
 * the description is simply absent and the label is what it always was: degrade,
 * never guess.
 */
/**
 * Memoised on the events array's identity, for the reason `changeCounts` gives.
 *
 * **Two components ask this, not one** — `AgentConfigBar` and `Composer` — each
 * through a `useMemo` keyed on `events`, whose identity moves on every append. So
 * the scan below ran twice per streamed token, and its early `break` does not
 * help the case that costs most: when no `agent_config` is in the held window at
 * all — an older daemon, an agent that publishes no controls, or one paged out —
 * there is nothing to break on and both scans walk the whole transcript.
 *
 * The array is replaced rather than mutated on every append (`onEvents` builds a
 * new one), so its identity is a sound key and a `WeakMap` keeps the cache from
 * being a leak. One scan per append, shared by both callers, and the second
 * asker pays a map read.
 */
const PROSE = new WeakMap<readonly StoredEvent[], Map<string, ConfigProse>>();

/*
 * `ReadonlyMap`, because the memo makes this a **shared** instance: both
 * `AgentConfigBar` and `Composer` are handed the same object for a given events
 * array, where each used to get its own. Both only read it today, and the type is
 * what keeps a later `.set()` in one of them from silently corrupting the other's
 * view for the life of that array.
 */
export function configProse(events: readonly StoredEvent[]): ReadonlyMap<string, ConfigProse> {
  const cached = PROSE.get(events);
  if (cached !== undefined) return cached;
  const computed = scanConfigProse(events);
  PROSE.set(events, computed);
  return computed;
}

function scanConfigProse(events: readonly StoredEvent[]): Map<string, ConfigProse> {
  const out = new Map<string, ConfigProse>();
  // Backwards to the newest one: a session that has switched model has several,
  // and only the last describes the choices on offer now.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type !== "agent_config") continue;
    for (const option of event.options) {
      const choices = new Map<string, string>();
      for (const choice of option.choices) {
        if (choice.description !== null && choice.description.length > 0) {
          choices.set(String(choice.value), choice.description);
        }
      }
      out.set(option.id, { description: option.description, choices });
    }
    break;
  }
  return out;
}

/**
 * Whether the composer's control strip has anything to draw at all.
 *
 * Extracted from an inline condition because the third clause is the half that
 * would fail silently on exactly one agent, and a rule that is only *described*
 * is the thing this repository is against.
 *
 * An older daemon sends no `agentConfig`, and an agent may genuinely offer no
 * controls — but either way there may still be a context readout, so the test
 * cannot be options alone. **And the paperclip lives in this row**, which is the
 * clause with a history: without it a kimi session that reports no context
 * usage, or *any* session waiting on a daemon restart — which has no live agent
 * to publish controls — would render no bar and therefore no way to attach a
 * file, while claude was fine. Correct on the agent you tested, wrong on the
 * other, invisible from either one alone.
 *
 * That case stopped being rare when the composer began surviving a restart, so
 * it is asserted now rather than reasoned about.
 */
export function configBarShows(
  optionCount: number,
  contextPercent: number | null,
  hasLeading: boolean,
): boolean {
  return optionCount > 0 || contextPercent !== null || hasLeading;
}
