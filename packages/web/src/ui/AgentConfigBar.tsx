import { Bot, Check, ChevronDown, Gauge, MoreHorizontal, SlidersHorizontal, Sparkles } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { errorText, meansRestartRefused } from "../http";
import { beginChoice, choicesFor, choicesVersion, endChoice, subscribeChoices } from "../choices";
import { LAYER, useDismissible } from "./overlay";
import { keyOf, type SessionRef } from "../ids";
import { store } from "../store";
import type { AgentConfigChoice, AgentConfigOption, AgentId, SessionSnapshot, StoredEvent } from "../wire";
import {
  chipParts,
  choiceLabel,
  choiceOverride,
  drawnChoices,
  choiceRefusal,
  configBarShows,
  configProse,
  contextHint,
  contextPercent,
  labelFor,
  NESTED_HOST,
  pieLabel,
  pieTone,
  shortCount,
  slotFor,
  splitOptions,
  unavailableHint,
  withChoice,
  type ChipParts,
  type ConfigProse,
  type DrawnControls,
  type PieLevel,
  effortFollowUp,
} from "./agentConfig";
import { Icon, MENU_HEADING, MENU_PANEL, menuRow, TAP_GROW_Y } from "./bits";
import { toast } from "./Toast";

/**
 * Change one of the agent's controls, and fold in what it answers.
 *
 * Exported because there are two ways to reach these controls now — this bar and
 * the composer's `/model` menu — and the three-step shape is where the rule
 * lives: **render what comes back, never what you asked for.** Setting the model
 * rebuilds the available modes and can reset the current one, so the response is
 * the agent's own refreshed state rather than an echo, and a second copy of this
 * is a second place for that to be forgotten.
 *
 * Resolves either way. `busy` stays with the caller, because the two draw it in
 * different places.
 *
 * **The chosen value is recorded here rather than by a caller**, and that is this
 * docblock's own warning taken seriously: the optimistic override lived in the
 * bar's `useState` for one revision, so the `/effort` menu — the second door this
 * function exists to serve — drew the daemon's value for the whole round trip and
 * read "Adaptive" at somebody who had just chosen "Low". Recorded before the
 * request and released in a `finally`, after `applySnapshot` has folded the
 * answer in, so a success does not move the chip and a refusal snaps it back to
 * the truth beside the toast.
 */
export function applyConfigChange(
  sessionRef: SessionRef,
  configId: string,
  value: string | boolean,
): Promise<boolean> {
  const daemon = store.daemonFor(sessionRef.machineId);
  if (daemon === undefined) {
    toast("error", "that machine is not reachable");
    return Promise.resolve(false);
  }
  /*
   * What the session held before the change, for `effortFollowUp`: a model
   * switch that changes the effort list owes the new model its default, and
   * only the *before* list says whether it changed. Read off the store rather
   * than passed in, since the composer's `/model` menu is the second door and
   * would have to carry it too.
   */
  const before =
    store.getSnapshot().sessions.find((row) => row.key === keyOf(sessionRef))?.snapshot.agentConfig?.options ?? [];
  const held = beginChoice(keyOf(sessionRef), configId, value);
  return daemon
    .setConfig(sessionRef.sessionId, { configId, value })
    .then((result) => {
      store.applySnapshot(sessionRef, result.session);
      /*
       * The follow-up goes through this same function (recorded, sent from the
       * one `setConfig` call site, released) rather than a second request
       * written here. It cannot recurse further: the follow-up is a
       * `thought_level` change, and `effortFollowUp` answers `null` for
       * anything but a `model`.
       */
      const followUp = effortFollowUp(
        before.find((option) => option.id === configId),
        before,
        result.session.agentConfig?.options ?? [],
      );
      if (followUp !== null) return applyConfigChange(sessionRef, followUp.configId, followUp.value);
      return true;
    })
    .catch((cause: unknown) => {
      /*
       * **Said on the row before the tap, and swallowed there** — see
       * `choiceRefusal`. Both doors into this function refuse the value
       * themselves, so what still reaches here is a turn that began between the
       * frame that drew the row and the finger that hit it; the strip draws the
       * sentence one poll later, and Send is already Stop.
       *
       * ⚠ Exactly one code, and `meansRestartRefused` is where the argument for
       * it lives. Everything else on this route is a fact this client could not
       * have known — an unreachable machine, a value the agent refuses, a session
       * that ended — and still says so.
       */
      if (!meansRestartRefused(cause)) toast("error", errorText(cause));
      return false;
    })
    .finally(() => endChoice(held));
}

/**
 * The agent's own controls: mode, model, reasoning effort.
 *
 * **Everything here is drawn from `category`, never from `id`.** The ids are not
 * portable between agents — claude publishes reasoning effort as `effort` with
 * values `default|low|…|max`, kimi publishes it as `thinking` with values
 * `off|…` — so a bar keyed on ids renders one agent's controls and none of the
 * other's. ACP defines `category` for exactly this and says it is a UX hint that
 * must not be required for correctness, which is why an unknown or missing one
 * still renders, just without an icon.
 *
 * Nothing is hardcoded, including the *values*. claude drops
 * `bypassPermissions` from its mode list when it runs as root without
 * `IS_SANDBOX` — so a fixed list of modes would
 * offer a control the agent rejects.
 *
 * The state comes from the snapshot rather than from what was last requested.
 * That is not tidiness: setting the model rebuilds the available modes and can
 * reset the current one, and claude changes its own mode from a hook mid-turn.
 */

const CATEGORY_ICON: Record<string, ComponentType<{ size?: number | string; className?: string }>> = {
  mode: SlidersHorizontal,
  model: Bot,
  thought_level: Gauge,
  model_config: Sparkles,
};

/**
 * One shape for every control in this row.
 *
 * 32px tall and `rounded-md` — the same radius as the textarea six pixels above
 * it, the send button, and every attachment chip. These were `rounded-full`, so
 * the one row that is *part* of the composer was the only round thing in it.
 *
 * The tap target is grown with a pseudo-element rather than by growing the box:
 * 4px up and 8px down turns 32px of ink into 44px of target and costs no layout,
 * so the strip does not get taller on a phone, above a soft keyboard, where the
 * height is paid for out of the transcript. Vertical only, because these sit
 * `gap-1.5` apart and a symmetric inset would put each chip's target over its
 * neighbour's *face* — and the neighbour changes the model. See the growth rule
 * in `bits.tsx`'s header, which this is one half of.
 *
 * No `shrink-0`: these carry `truncate` children and a 320px screen needs them to
 * be allowed to give. Padding stays with each caller so no two conflicting `px-*`
 * utilities ever land on one element.
 */
/*
 * **Every chip is the colour of the bar it sits in, and `edge-strong` is what
 * says it is a control.**
 *
 * They were `border-edge bg-raised` — a grey pill on a `bg-surface/95` bar — so
 * the strip under the composer read as a row of filled tags rather than as part
 * of the composer. The rule they follow now is the app-wide one: a control takes
 * its ground's colour and is bounded rather than filled, which is why the border
 * has to be `edge-strong` (≥3:1) and not `edge` (1.31:1 here) — with no fill of
 * its own, the border is the whole of the control's identification.
 *
 * The fill is freed up by that, and it is spent on **state**: `bg-raised` now
 * means a toggle that is *on* and a menu row that is *chosen*, where before it
 * meant nothing at all because everything had it.
 */
/*
 * The size is on `CHIP` and never on either span inside `chipInner`, which is what
 * keeps a reservation an honest measurement: the invisible sizers and the visible
 * value inherit the *same* font, so the column is exactly as wide as the string it
 * was sized from. Set on one of the two and the other reserves for a font nothing
 * is drawn in.
 *
 * `text-2xs` (12px) rather than `text-xs` (13px): one step down a scale that
 * already exists, taken so the strip is a little more compact and so `Ultracode` —
 * the longest value any control here draws — costs less of the row. Line height
 * goes 20px → 18px, still far under `min-h-8`, so no box gets shorter.
 *
 * ⚠ **Height is deliberately not reduced.** `min-h-8` plus `TAP_GROW_Y` is the
 * 44px target above, and both square buttons are `${CHIP} w-8` — they stop being
 * square the moment height moves without width, and the paperclip is a fixed
 * `h-8 w-8` chosen to match these. The chips get smaller horizontally and in type
 * only.
 */
const CHIP = `tap press relative inline-flex min-h-8 items-center gap-1.5 rounded-md border text-2xs ${TAP_GROW_Y}`;

export function AgentConfigBar({
  sessionRef,
  agent,
  controls,
  usage,
  events,
  disabled,
  turnRunning,
  leading,
}: {
  sessionRef: SessionRef;
  /**
   * Which agent this is, for the context readout alone.
   *
   * The one place in this file that is allowed to know an agent's *name*:
   * everything else is keyed on ACP's `category` precisely so it is not. It is
   * here because "why is this empty" has an agent-specific answer and no generic
   * one — see `contextHint`.
   */
  agent: AgentId;
  /**
   * What to draw, and whether there is an agent behind it — see `drawnControls`.
   *
   * A pair rather than the snapshot's `agentConfig`, because a restart empties
   * that: the daemon drops the controls with the agent, so the strip went blank
   * for the length of every deploy and every auto-resume. The memory that fills
   * the gap lives in the store, and `stale` is what stops it being tapped.
   */
  controls: DrawnControls;
  usage: SessionSnapshot["contextUsage"];
  /** The loaded transcript, for the prose the snapshot strips. See `configProse`. */
  events: readonly StoredEvent[];
  /** This tab is busy elsewhere — a prompt in flight. Terminal sessions arrive as `stale`. */
  disabled: boolean;
  /**
   * A turn is running, so a change that restarts the agent would be refused —
   * `turnInFlight`, the same field the daemon gates on.
   *
   * **Deliberately not `disabled`**, which is this tab's *own* prompt in flight:
   * it is false for most of a running turn, and false outright for a turn somebody
   * started in another tab. And not `controls.stale`, which is "no live agent" and
   * blind to the turn by construction, `running` being a live status.
   */
  turnRunning: boolean;
  /**
   * Rendered first in the left cluster — today, the paperclip.
   *
   * A node rather than attachment props, so this component stays about the
   * agent's own controls and `slotFor`/`splitOptions` keep their vocabulary.
   */
  leading?: ReactNode;
}): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Read from module state rather than held here, because the other door into
  // `applyConfigChange` is a sibling component — see `choices.ts`.
  useSyncExternalStore(subscribeChoices, choicesVersion);
  const pending = choicesFor(keyOf(sessionRef));

  const { options: polledOptions, stale, unavailable } = controls;

  /*
   * ⚠ **The polled snapshot carries a *head* of a long model list, and this is
   * where the rest is fetched.** `GET /sessions` bounds every option's choices —
   * sixty records on a four-second poll, over a relay, to a phone, and a keyed
   * opencode publishes 362 models in one control — and flags what it cut with
   * `truncated`. `GET /sessions/:id` is not polled and answers complete, so the
   * moment this bar is asked to draw a cut control it reads the whole thing once
   * and keeps it.
   *
   * Keyed on the session, not on the option: the read is one request for all of
   * them and re-fetching per control would spend the saving it exists to make. It
   * runs once per session per mount — a cut list is a property of which agent is
   * running, and the poll cannot change it without changing the agent.
   *
   * **The polled copy is still what draws until this lands**, which is the point:
   * the head is correct, merely short, and the selected choice is always in it. So
   * the picker is usable immediately and simply grows, rather than showing a
   * spinner over a list that is already good enough to read.
   */
  const [fullOptions, setFullOptions] = useState<readonly AgentConfigOption[] | null>(null);
  const sessionKey = keyOf(sessionRef);
  const anyTruncated = polledOptions.some((one) => one.truncated === true);
  useEffect(() => {
    setFullOptions(null);
  }, [sessionKey]);
  useEffect(() => {
    if (!anyTruncated || fullOptions !== null) return;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) return;
    let live = true;
    void daemon
      .session(sessionRef.sessionId)
      .then((answer) => {
        // Nothing is drawn on failure and nothing is said: the head is already on
        // screen and correct, so the honest cost of not reaching the daemon is a
        // shorter menu rather than an error over a control that works.
        if (live) setFullOptions(answer.session.agentConfig?.options ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [anyTruncated, fullOptions, sessionKey, sessionRef.machineId, sessionRef.sessionId]);

  /*
   * Merged by id, and only for the controls that were actually cut. Everything
   * else keeps the polled object by identity — `drawnChoices` memoises on the
   * `choices` array's identity, so replacing an option that did not change would
   * throw away that cache on every poll.
   */
  const options = useMemo(
    () =>
      fullOptions === null
        ? polledOptions
        : polledOptions.map((one) => {
            if (one.truncated !== true) return one;
            const whole = fullOptions.find((candidate) => candidate.id === one.id);
            if (whole === undefined) return one;
            // `value` from the polled copy, never the fetched one: the poll is
            // newer, and a model changed since this read must not be drawn as
            // still selected.
            return { ...whole, value: one.value, truncated: false };
          }),
    [polledOptions, fullOptions],
  );
  const percent = contextPercent(usage);
  // Above the early return because the registration below reads it, and a hook
  // cannot sit under one. Pure, and the same call it was two lines lower.
  const slots = splitOptions(options);

  /*
   * The `…` panel is a layer like every other menu, and registering it fixes two
   * things at once.
   *
   * **A keystroke aimed at this panel was answering the agent.**
   * `decisionShortcutsEnabled` blocks the ask card's digits on any layer that is
   * not the card's own — and a panel that pushes nothing leaves that stack empty,
   * so with this open over a parked permission a bare `1` approved the command
   * underneath it. `overlay.ts` names the config bar's popover in that docblock;
   * it was the one popover in the app not registered.
   *
   * **And nothing could close it.** Escape belonged to nobody here and the only
   * other dismissal was a second tap on the trigger — which is `disabled` while a
   * config change is in flight, i.e. exactly the window in which the panel was
   * left open with no way out of it.
   *
   * The condition is the panel's own, not the flag's: this state outlives the
   * agent that filled the panel, so a control set that stops overflowing while
   * the panel is open would otherwise leave a layer nothing is drawing.
   */
  useDismissible("menu", () => setOverflowOpen(false), overflowOpen && slots.overflow.length > 0);

  // Memoised on the events array identity, which the store replaces only when the
  // transcript actually changes — this walks the whole window backwards, and the
  // composer re-renders on every keystroke.
  const prose = useMemo(() => configProse(events), [events]);

  if (!configBarShows(options.length, percent, leading !== undefined)) return null;

  const apply = (option: AgentConfigOption, value: string | boolean): void => {
    setBusy(option.id);
    // The chosen value is recorded inside `applyConfigChange`, so this call site
    // has nothing to remember and the `/` menu gets the same behaviour without
    // knowing about it.
    void applyConfigChange(sessionRef, option.id, value).finally(() => setBusy(null));
  };

  const control = (option: AgentConfigOption): ReactNode => {
    const nested = option.category === NESTED_HOST ? slots.nested : [];
    /*
     * Two flags, and the split is what stops the row flickering.
     *
     * `disabled` is semantic — there is no agent to ask, or this tab is mid-prompt
     * — and it is drawn, at `opacity-40`. `locked` is the transient exclusion
     * while another control in this row is in flight, and it is **not** drawn:
     * one tap used to dim every chip beside it, and since `opacity` is
     * deliberately absent from `.tap`'s transition list, the whole strip snapped
     * to 40% and snapped back around a round trip that is often under a second.
     * The lock itself is kept — setting a model rebuilds the mode list, so two
     * changes at once really do race — it just stopped announcing itself as
     * damage.
     */
    /*
     * A control the agent has stopped offering keeps its slot and says so.
     *
     * Drawn rather than dropped because a button that vanishes moves everything
     * beside it and explains nothing — and the agent dropping it is ordinary:
     * choose Haiku and claude deletes the effort control outright, since it
     * builds those levels from the model. It is a `Select` with one row instead
     * of a shape of its own, so the chip, its width reserve and the menu's
     * dismissal are the same objects as everywhere else on this strip.
     */
    if (unavailable.has(option.id)) {
      return <Absent key={option.id} option={option} />;
    }
    // The chosen value, drawn at once — on the host *and* on anything nested in
    // its menu, since one of those is what a tap on the host's rows changes.
    return option.kind === "boolean" ? (
      <Toggle
        key={option.id}
        option={withChoice(option, pending)}
        prose={prose.get(option.id)}
        disabled={disabled || stale}
        locked={busy !== null}
        onChange={(value) => apply(option, value)}
      />
    ) : (
      <Select
        key={option.id}
        option={withChoice(option, pending)}
        nested={nested.map((sub) => withChoice(sub, pending))}
        proseOf={(sub) => prose.get(sub.id)}
        disabled={disabled || stale}
        locked={busy !== null}
        // Only `Select`. `Toggle` and `Absent` are untouched: no boolean control
        // restarts the agent, and an absent one already says its own sentence.
        refuses={(sub, value) => choiceRefusal(sub, value, turnRunning)}
        onChange={apply}
      />
    );
  };

  return (
    <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-0.5">
      {/* Mode on the left, where a permission decision belongs — it is the control
          you reach for when the agent is asking, not one you browse. The attach
          slot before it was reserved and empty for as long as no layer of this
          system accepted an attachment; every layer does now, so it holds the
          paperclip. It is ungated on purpose: ACP requires every agent to support
          `resource_link`, so there is no agent for which attaching does nothing.
          Only whether the *bytes* of an image go inline depends on a capability,
          and that is the daemon's decision, recorded on the event afterwards. */}
      <div className="flex min-w-0 items-center gap-1.5">
        {leading}
        {slots.left.map(control)}
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        {slots.right.map(control)}

        {slots.overflow.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setOverflowOpen(!overflowOpen)}
              // The same pair as the chips: inert while anything is in flight,
              // dimmed only where there is no agent to reach.
              disabled={disabled || stale || busy !== null}
              aria-label="More controls"
              aria-expanded={overflowOpen}
              // A 32px square, the twin of the paperclip at the other end of the
              // strip. Kept hand-rolled rather than swapped for `IconButton`
              // because `aria-expanded` is load-bearing on a disclosure and that
              // primitive exposes `active` → `aria-pressed`, a different promise.
              className={`${CHIP} w-8 justify-center border-edge-strong bg-surface text-muted hover:bg-raised hover:text-fg ${
                disabled || stale ? "opacity-40" : ""
              }`}
            >
              <Icon as={MoreHorizontal} size={13} />
            </button>
            {overflowOpen && (
              <div
                className={`absolute right-0 bottom-full ${LAYER.menu} mb-1 flex w-max max-w-[min(20rem,calc(100vw-2rem))] flex-col gap-1.5 rounded-lg border border-edge bg-surface p-2 shadow-xl`}
              >
                {slots.overflow.map(control)}
              </div>
            )}
          </div>
        )}

        {/*
         * **Off the strip below `sm`, and this is the one control that loses
         * nothing by going.**
         *
         * Every other thing in this row *sets* something. This one reports: it is a
         * readout of how full the context window is, and its popover explains the
         * number and names `/usage` for the agent that cannot report one at all. On
         * a 390px strip it is competing for width against controls that change what
         * the next turn does — and the reader who wants this number is at a desk
         * looking at a long conversation, not answering a question one-handed.
         *
         * Hidden rather than moved into `…`: the overflow popover is built from
         * `slots`, which is a partition over the agent's *own* controls with an
         * assertion counting every member, and the context ring is not one of them.
         * Putting it there would mean either lying to that partition or teaching it
         * about a control no agent publishes.
         */}
        <div className="hidden shrink-0 items-center sm:flex">
          <ContextPie percent={percent} usage={usage} agent={agent} />
        </div>
      </div>
    </div>
  );
}

/** The bar's fill, which cannot use `currentColor` — the row around it is toned. */
const PIE_BAR: Record<PieLevel, string> = {
  unknown: "bg-faint",
  ok: "bg-fg",
  warn: "bg-fg",
  critical: "bg-danger",
};

const PIE_TONE: Record<PieLevel, string> = {
  // Not beside `text-faint` by accident: "cannot tell" has to be quieter than a
  // healthy reading, or an unmeasured window looks like a comfortable one.
  unknown: "text-faint",
  ok: "text-fg",
  warn: "text-fg",
  // Weight, not hue: the figure inside the popover is what says how close it is.
  critical: "text-fg font-semibold",
};

/**
 * How full the context window is, as a ring you can press.
 *
 * Hand-written SVG rather than a chart library: this package has four runtime
 * dependencies and a donut is `stroke-dasharray` on one circle.
 *
 * **The number is in the popover, not in the strip.** It used to sit beside the
 * ring, and it was the widest thing in the right-hand cluster for a reading
 * nobody needs continuously — "roughly how full" is what the ring already says at
 * a glance, and the exact figure is a thing you go and look at. Removing it also
 * removes the last moving part in this row: a ring is one width at every
 * percentage, where `9% → 10%` and `99% → 100%` each pushed the chips beside it,
 * because `tabular-nums` fixes the width of a digit and not how many there are.
 *
 * **`null` keeps its slot.** This used to render nothing at all, on the grounds
 * that an empty ring reads as "0% used". That was right about the ring and wrong
 * about the remedy: unmounting moved the model and effort chips sideways every
 * time an agent started or stopped reporting. What defuses the misreading is the
 * tone and the popover rather than the absence — an unmeasured window is drawn in
 * the quietest colour there is and says so in words when opened. "Cannot tell" is
 * common: kimi may never report, and a restored session has no agent to ask.
 *
 * **What the popover cannot show, and Claude Code's can:** plan usage limits —
 * the five-hour and weekly bars. That is not a layout decision. The agent sends
 * it as `usage_update._meta._claude/rateLimit`, and the daemon drops `_meta`
 * entirely rather than putting an unbounded agent-shaped blob on a snapshot that
 * `GET /sessions` returns sixty at a time. Carrying it is a daemon change — see
 * the note in CLAUDE.md. So this shows the context window and nothing else: the
 * cost `contextUsage` also carries is deliberately left out, because this answers
 * "how much room is left" and a currency figure answers a different question.
 */
function ContextPie({
  percent,
  usage,
  agent,
}: {
  percent: number | null;
  usage: SessionSnapshot["contextUsage"];
  agent: AgentId;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  /*
   * Escape belongs to `overlay.ts`, which is the only thing that knows what has
   * opened over this popover since — the same registration `SessionMenu` makes.
   *
   * It was resolved on the element below instead, on the argument that
   * `keyboard.ts`'s `window` listener would otherwise blur the trigger. The
   * arbiter answers that properly: its listener is in the **capture** phase and
   * stops propagation once it has decided to act, so `keyboard.ts` never sees the
   * key, and the caret is put back here rather than left on `document.body`.
   * What the element handler could not do is push a layer — so while this was
   * open over a parked question, the card's digit shortcuts stayed live and a
   * keystroke aimed at this panel approved the command underneath it.
   */
  useDismissible(
    "menu",
    () => {
      setOpen(false);
      triggerRef.current?.focus();
    },
    open,
  );

  // Outside-press, and only that.
  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
    };
  }, [open]);

  const level = pieTone(percent);
  // r=5 → circumference 2πr ≈ 31.42. The arc is drawn from 12 o'clock by rotating
  // the whole circle, which is cheaper than computing an arc path.
  const circumference = 31.42;
  const filled = percent === null ? 0 : (percent / 100) * circumference;
  const known = percent !== null && usage !== null && usage !== undefined;
  const label = known
    ? `Context window — ${shortCount(usage.used)} / ${shortCount(usage.size)} tokens, ${pieLabel(percent)}`
    : `Context window — ${contextHint(agent)}`;

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={label}
        title={label}
        /*
         * A control, drawn like every other control in this strip — the same
         * box, not merely the same 32px of space.
         *
         * It was `border-transparent` with no background until hovered, on the
         * argument that it is "a readout first". That argument does not survive
         * contact with the strip: it is the one thing here that opens something
         * when pressed while looking like it does not, and hover is not a state a
         * phone has at all. The `…` button beside it is the same size, the same
         * radius and the same job — one tap, a panel — so it is the same string.
         *
         * It matters most in the state where the ring says least. `unknown` is
         * every kimi session for its whole life (kimi never sends `usage_update`),
         * and a dashed 14px arc floating in nothing does not read as pressable.
         * `PIE_TONE` still carries the tone; the box carries the affordance.
         */
        className={`${CHIP} w-8 justify-center border-edge-strong bg-surface hover:bg-raised ${PIE_TONE[level]}`}
      >
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden={true} className="shrink-0">
          {/*
           * The track is `--color-edge-strong` at full opacity, not `currentColor`
           * at 0.22. Measured: faint at 22% over the composer's surface is about
           * 1.3:1, far under the 3:1 floor for a non-text control.
           */}
          <circle cx="7" cy="7" r="5" fill="none" stroke="var(--color-edge-strong)" strokeWidth="2" />
          {percent === null ? (
            /*
             * A dash in an empty track, not a dashed ring.
             *
             * It used to draw the ring itself dashed, so that "no measurement" was
             * a positive mark rather than an absence and could not be misread as a
             * measured zero. The reasoning was sound and the result was not: kimi
             * never sends `usage_update`, so that is a circle of loose dots sitting
             * in the composer for the whole life of every kimi session, reading as
             * damage rather than as a statement.
             *
             * The dash keeps what the dashes were for and drops what they looked
             * like: it is still a positive mark, so an empty track is not left to be
             * read as nought percent, and it is the ordinary glyph for "no reading".
             * Deliberately not an icon from the set — `Gauge` is already the effort
             * chip two controls to the left in this same strip.
             */
            <line x1="4.5" y1="7" x2="9.5" y2="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          ) : (
            <circle
              cx="7"
              cy="7"
              r="5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={`${filled} ${circumference - filled}`}
              transform="rotate(-90 7 7)"
            />
          )}
        </svg>
      </button>

      {open && (
        <div className={`absolute right-0 bottom-full mb-1 w-64 max-w-[calc(100vw-1.5rem)] ${MENU_PANEL}`}>
          <div className="px-2 py-1.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-fg">Context window</span>
              <span className="shrink-0 tabular-nums text-muted">
                {known ? `${shortCount(usage.used)} / ${shortCount(usage.size)}` : "not reported"}
              </span>
            </div>
            {/* A bar as well as the ring, because the ring is 14px and this is the
                screen somebody opened to actually read the number. Drawn only when
                there is something to draw: an empty track under "not reported"
                reads as a measured zero, which is the exact misreading the whole
                `unknown` tone exists against. `aria-hidden`: the button's own
                label already says all of it in words. */}
            {known && (
              <div aria-hidden={true} className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-edge">
                <div
                  className={`h-full rounded-full ${PIE_BAR[level]}`}
                  style={{ width: `${percent ?? 0}%` }}
                />
              </div>
            )}
            {/* The occupancy in words, and nothing else on this line. `contextUsage`
                also carries a `cost`, and it is deliberately not drawn: this
                readout answers "how much room is left", which is a question about
                the *window*, and a currency figure beside it answers a different
                one nobody asked here. It also could not be trusted to be
                comparable — kimi's own usage report has no cost field at all. */}
            <p className="mt-1 text-2xs text-faint">
              {known ? `${pieLabel(percent)} used` : contextHint(agent)}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function label(option: AgentConfigOption): ReactNode {
  const icon = CATEGORY_ICON[option.category ?? ""];
  return icon === undefined ? null : (
    <span className="text-faint">
      <Icon as={icon} size={11} />
    </span>
  );
}

/**
 * Everything inside a chip, drawn once for both of the things that are one.
 *
 * A live control and the slot of one the agent has stopped offering are the same
 * button in two states, and the rule they exist to keep is that **the strip does
 * not move**. Written twice they drifted immediately — the unavailable one drew
 * the control's name where the live one deliberately does not, so switching to a
 * model with no effort levels widened that chip by a word and pushed everything
 * beside it along. One function, so there is nothing to keep in step.
 *
 * The reserve spans are stacked in the same grid cell as the value and are
 * `aria-hidden`: the column is then as wide as the widest thing this chip can
 * ever say, in the real font, and the value changing inside it moves nothing.
 */
function chipInner(option: AgentConfigOption, parts: ChipParts): ReactNode {
  /*
   * Whether a glyph already says which control this is — see {@link label}, which
   * is the same lookup and answers `null` for a category `CATEGORY_ICON` has never
   * heard of.
   */
  const named = CATEGORY_ICON[option.category ?? ""] !== undefined;
  return (
    <>
      {label(option)}
      {/*
       * **The caption leaves the layout below `sm`, and only where an icon can
       * stand in for it.**
       *
       * `showsCaption` decides whether a control *has* a name to draw and that is
       * still a question about the category alone — `model` and `thought_level` are
       * identified by their own values, `mode` is not. What this adds is a second,
       * narrower question: on a 390px strip the name and the value compete, and the
       * value is the half that says what the control is currently set to. Reported
       * from a phone: `mode` drew its caption and truncated its own value, so the
       * chip said which control it was and not what it was doing.
       *
       * `hidden sm:inline` rather than a shorter string, for `chipReserve`'s reason
       * one block down: below `sm` the sizers already leave the layout, so a chip
       * there is content-sized and truncates under pressure. Taking the caption out
       * of flow is the same mechanism applied to the same problem.
       *
       * ⚠ **An unnamed category keeps its caption at every width**, which is the
       * whole reason this is conditional. `CATEGORY_ICON` has no entry for a
       * category nobody here has seen, so `label` draws nothing — and a chip with
       * neither an icon nor a name is a value with no indication of what it sets.
       */}
      {parts.caption !== null && (
        <span className={`max-w-24 truncate text-faint ${named ? "hidden sm:inline" : ""}`}>
          {parts.caption}
        </span>
      )}
      {parts.reserve === null ? (
        <span className="max-w-40 truncate">{parts.value}</span>
      ) : (
        <span className="relative grid max-w-40">
          {parts.reserve.map((candidate) => (
            <span
              key={candidate}
              aria-hidden
              /*
               * `hidden sm:block`, and the breakpoint is about space rather than
               * about taste — the one thing a breakpoint is honestly for.
               * Reserving all three at once is ~500px of strip against a 390px
               * phone, so below `sm` the sizers leave the layout entirely and the
               * chips size to their content and truncate under pressure, exactly
               * as they did before any of this. Above it there is room, and the
               * width stops depending on what anything says.
               */
              className="invisible hidden col-start-1 row-start-1 whitespace-pre sm:block"
            >
              {candidate}
            </span>
          ))}
          {/*
           * **`sm:absolute` is what makes the reserve a width rather than a
           * floor.** A grid column is as wide as the widest thing in it, so
           * while the value was in flow beside the sizers, a value longer than
           * any of them widened the column — `GPT-5.6-Luna` is one character
           * more than the string this list was measured from, and that was
           * enough for two codex sessions to draw two different chips. Out of
           * flow it cannot size anything, so the column is exactly the reserve
           * and a long value truncates inside it. Static below `sm`, where the
           * sizers are gone and there would be nothing left to give the box a
           * height.
           */}
          <span className="col-start-1 row-start-1 truncate sm:absolute sm:inset-0">{parts.value}</span>
        </span>
      )}
    </>
  );
}

/**
 * One of the agent's select controls.
 *
 * Still hand-rolled rather than built on `bits.tsx`'s `Dropdown` — which was
 * extracted from this component — because this one needs the trigger to render
 * *inside* the pill (icon, then value, then chevron) and the generic version puts
 * its chevron at the end of a full-width row. The mechanics that matter are shared;
 * the shape is not.
 */
/*
 * ⭐ **There is no spinner on this strip, and that is the whole of "optimistic".**
 *
 * There was one, behind a 250ms delay, on the argument that an ordinary
 * `set_config_option` answers in tens of milliseconds while a change that restarts
 * the agent runs into seconds and should still report itself. Both halves were
 * true and the conclusion is withdrawn, because the thing it reported is now the
 * one thing this row is not: **the value somebody chose is already on the chip.**
 * `withChoice` puts it there before the request leaves, and the daemon no longer
 * publishes the fresh agent's own controls mid-restart — so from the outside a
 * restart looks like the change simply happening, which is what it is.
 *
 * What is *not* dropped is the correction: a refusal snaps the chip back to the
 * truth beside a toast, out of `applyConfigChange`'s `finally`. Optimism here is
 * bounded by a retraction, which is the same bar the transcript's own optimism
 * rules set — and it is not the optimism `Composer`'s Stop control refuses, since
 * nothing is being claimed about what the *agent* is doing.
 *
 * `locked` survives and is still not drawn: two changes at once really do race
 * (setting a model rebuilds the mode list), and the daemon refuses a config change
 * mid-restart on purpose — otherwise the restore overwrites it silently. So the
 * cost of no spinner is a second or two in which a tap on another chip does
 * nothing at all, and that is the trade being made deliberately.
 */

/**
 * A control the agent has stopped offering, still on the strip.
 *
 * The whole of the rule "a button never disappears": the slot is kept, the chip
 * says the control's name where its value would be self-describing, and the one
 * row in its menu says there is nothing to choose and why. It is deliberately
 * **not** disabled — a dimmed, inert chip answers "why is this greyed out?" with
 * silence on a phone, where there is no tooltip — so it opens, says its sentence,
 * and sends nothing.
 *
 * ⚠ **The name is *not* drawn here for `model` and `thought_level`, and this
 * docblock said the opposite for four releases.** It was written when the absent
 * chip drew the control's name where the live one deliberately does not — which
 * made the chip a word and a gap wider than the one it replaced and shoved the
 * whole right-hand cluster sideways every time a model dropped the effort levels.
 * Q3.417 took it out; `chipParts` is called with the same `showsCaption` rule the
 * live chip uses, and this comment simply never moved. What identifies the chip is
 * its icon, its position, and its `title`/`aria-label`, which do carry the name;
 * what opens is a menu headed with it.
 */
function Absent({ option }: { option: AgentConfigOption }): ReactNode {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const hint = unavailableHint(option);

  // A layer like every other menu, for `Select`'s reason: an unregistered
  // popover leaves the ask card's digit shortcuts live underneath it.
  useDismissible("menu", () => setOpen(false), open);

  // The same pointer-down dismissal `Select` uses, for the same reason.
  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={`${labelFor(option)}: ${hint}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${labelFor(option)}: ${hint}`}
        className={`${CHIP} border-edge-strong bg-surface px-2 text-muted hover:bg-raised`}
      >
        {/* The same contents the live chip draws, from the same function — which
            is what makes "this chip does not change width when the agent stops
            offering it" a property rather than a promise. */}
        {chipInner(option, chipParts(option, false))}
        <Icon as={ChevronDown} size={12} className="text-faint" />
      </button>

      {open && (
        <div
          className={`absolute bottom-full ${
            slotFor(option) === "left" ? "left-0" : "right-0"
          } mb-1 w-60 max-w-[calc(100vw-1.5rem)] ${MENU_PANEL}`}
        >
          <p className={MENU_HEADING}>{labelFor(option)}</p>
          <p className="px-2.5 pt-1 pb-2 text-xs text-muted">{hint}</p>
        </div>
      )}
    </div>
  );
}

function Select({
  option,
  nested = [],
  proseOf,
  disabled,
  locked,
  refuses,
  onChange,
}: {
  option: AgentConfigOption;
  /**
   * Controls drawn as further sections of *this* control's menu.
   *
   * Only the host's value reaches the chip; the strip's shape is therefore the
   * same whether an agent publishes these or not, which is the entire point — see
   * `NESTED_HOST` in `agentConfig.ts`.
   */
  nested?: readonly AgentConfigOption[];
  /** Descriptions recovered from the transcript, since the snapshot strips them. */
  proseOf: (option: AgentConfigOption) => ConfigProse | undefined;
  /** No agent to ask. Inert **and** dimmed, because it is a state of the world. */
  disabled: boolean;
  /** Another control in this row is in flight. Inert and **not** dimmed. */
  locked: boolean;
  /** What a choice says instead of acting, per row — see `choiceRefusal`. */
  refuses: (option: AgentConfigOption, value: string | boolean) => string | null;
  onChange: (option: AgentConfigOption, value: string) => void;
}): ReactNode {
  const prose = proseOf(option);
  /*
   * Which edge the menu hangs from.
   *
   * A fixed `left-0` put a 15rem panel off the right of the screen for every
   * control in the right cluster — model, effort — which on a phone gave the whole
   * page a horizontal scrollbar and let you swipe the interface sideways. The chip
   * already knows which side it is on, so the menu follows its slot: left chips
   * open leftward, right chips open rightward, and neither can leave the viewport.
   *
   * Read from `slotFor`, so this cannot drift from the layout it is aligning to.
   */
  const align = slotFor(option) === "left" ? "left-0" : "right-0";
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const current = drawnChoices(option).find((choice) => choice.value === option.value);
  const currentProse =
    prose?.choices.get(String(option.value)) ?? current?.description ?? null;
  /*
   * ⚠ **What the tooltip says when the agent explains nothing**, which used to be
   * the control's own name and is now the value's.
   *
   * `CATEGORY_RESERVE`'s docblock promises that a value too long for the chip
   * "truncates, with the full text one tap away in the menu **and in the chip's
   * own `title`**". That was true while a truncated value was rare. opencode
   * publishes `description: null` on all 362 of its models, so the fallback chain
   * ran to `labelFor(option)` and the tooltip over a chip reading `Claude Opus 4…`
   * said, in full, "Model" — the promise inverted exactly where it was needed.
   *
   * The control's name is not lost: it is on `aria-label` unconditionally, one
   * line below, for the reason written there.
   */
  const currentName = current === undefined ? null : choiceLabel(option, current);

  /*
   * What the chip says its value is.
   *
   * Measured 2026-07-31 against claude 0.63.0, the three controls publish:
   *
   *   mode    value "default"   → name "Manual"
   *   model   value "default"   → name "Default (recommended)", description
   *                                "Opus 5 with 1M context · Best for everyday…"
   *   effort  value "default"   → name "Default", description null
   *
   * Two chips reading a bare "Default" answered nothing, and the two are not the
   * same problem — `chipValue` and `adaptiveLabel` in `agentConfig.ts` are where
   * each is worked out, and both are resolved rather than papered over. The model
   * is named by the head of its own description, so the chip reads `Opus 5`.
   * Effort has no description anywhere in the payload, so what `default` means was
   * read out of the CLI — it sends no effort parameter at all, and the documented
   * behaviour with none sent is adaptive thinking — so the chip reads `Adaptive`.
   *
   * Deleting either placeholder choice is not the fix and was never on the table:
   * the effort one is the only way back to the agent's own default. (The *model*
   * placeholder does get dropped, but on the daemon and for a different reason —
   * `dedupeAliasChoices` removes it because it duplicates a concrete choice's
   * description, which is the agent saying they are the same thing.)
   *
   * The option's own name is still shown beside the value, because a value is only
   * self-describing when it happens to be a proper noun — see the span below for
   * which widths that holds at.
   */
  const parts = chipParts(option, true, prose);

  /*
   * Escape belongs to `overlay.ts`, and this is a `menu` like any other.
   *
   * Not merely a missing dismissal: `decisionShortcutsEnabled` blocks the ask
   * card's numbered answers on every layer but the card's own, so a menu that
   * pushes none leaves them live — and this menu opens directly over a parked
   * question, where `2` aimed at the model list resolved the permission
   * underneath it.
   */
  useDismissible("menu", () => setOpen(false), open);

  // A pointer-down listener rather than blur: the menu contains buttons, and
  // closing on blur would fire before the click that chose one landed.
  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        // Inert for both, dimmed for one: the fade keys on `disabled` rather than
        // on the attribute, which is what keeps a lock from reading as damage.
        disabled={disabled || locked}
        // The description in the tooltip, so "Default" answers "default what?" on
        // hover as well as in the open menu.
        title={
          currentProse === null
            ? (currentName ?? prose?.description ?? option.description ?? labelFor(option))
            : `${labelFor(option)}: ${currentProse}`
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        // Unconditional, because for `model` and `effort` the name is no longer
        // anywhere in the accessible tree: the caption is not rendered and the
        // reserve spans are `aria-hidden`. A screen reader would otherwise
        // announce "Opus 5, menu" with nothing saying what Opus 5 *is* here.
        aria-label={labelFor(option)}
        className={`${CHIP} border-edge-strong bg-surface px-2 text-fg hover:bg-raised ${disabled ? "opacity-40" : ""}`}
      >
        {/*
         * Contents from `chipParts`, drawn by `chipInner` — the same two calls the
         * unavailable slot makes. What each of them decides is documented there;
         * what matters here is that neither is decided *here*, because a chip
         * written out twice is a chip that changes width the day the two copies
         * disagree.
         */}
        {chipInner(option, parts)}
        <Icon as={ChevronDown} size={12} className="text-faint" />
      </button>

      {open && (
        <div
          role="listbox"
          // `max-w` as well as the alignment: on a narrow phone even a
          // correctly-anchored 15rem panel is wider than the screen. Width and
          // placement stay here; the chrome comes from `bits.tsx`, which is the
          // third of the three consumers its comment names.
          className={`absolute bottom-full ${align} mb-1 w-60 max-w-[calc(100vw-1.5rem)] ${MENU_PANEL}`}
        >
          {[option, ...nested].map((section, sectionIndex) => (
            <ChoiceSection
              key={section.id}
              option={section}
              prose={proseOf(section)}
              // A rule above every section but the first, so a nested control
              // reads as its own menu rather than as more rows of the host's.
              divided={sectionIndex > 0}
              refuses={refuses}
              onChoose={(value) => {
                setOpen(false);
                if (value !== section.value) onChange(section, value);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One control's heading, its prose, and its rows — the body of a menu panel.
 *
 * Extracted when `collaboration_mode` began sharing the mode control's menu, so
 * that a nested control is drawn by the same code as its host rather than by a
 * copy of it. The alternative was duplicating the row markup, which is how the
 * chip and the menu row came to disagree about what a value is called — the defect
 * `rowLabel`'s docblock records.
 */
function ChoiceSection({
  option,
  prose,
  divided,
  refuses,
  onChoose,
}: {
  option: AgentConfigOption;
  prose: ConfigProse | undefined;
  divided: boolean;
  /**
   * Required rather than optional: a section drawn without it is a row that
   * dispatches into a refusal whose toast is now suppressed, i.e. a control that
   * does nothing and says nothing.
   */
  refuses: (option: AgentConfigOption, value: string | boolean) => string | null;
  onChoose: (value: string) => void;
}): ReactNode {
  /*
   * ⚠ **Read once, and everything below reads it** — the refusals, the heading
   * test and the rows. `drawnChoices` takes a provider prefix every row repeats
   * out of the names, so opencode's one 362-row control does not spend its width
   * printing `OpenRouter` 356 times; taking the refusals off `option.choices` and
   * the rows off this would index one list with the other's positions.
   *
   * The heading test below is still here and reads `choice.group` alone: that is
   * the **agent's** grouping, off the ACP config, and this client no longer
   * derives one of its own.
   */
  const choices = drawnChoices(option);
  const refusals = choices.map((choice) => refuses(option, choice.value));
  /*
   * **One sentence for the control when it is true of more than one row.**
   *
   * Leaving ultracode restarts too, so with it on, every ordinary level is
   * refused at once and the row copy would be printed six times in one panel.
   * Said once above them instead — and *beside* the control's own description
   * rather than in place of it, because claude's "Available effort levels for
   * this model" is the only prose this control has and it is not ours to spend.
   *
   * `every` and not `[0]`: hoisting the first of several different sentences
   * would let the panel speak for a row it is not about.
   */
  const refused = refusals.filter((text): text is string => text !== null);
  const shared =
    refused.length > 1 && refused.every((text) => text === refused[0]) ? (refused[0] ?? null) : null;
  const sharedId = `${option.id}-refusal`;
  return (
    <div className={divided ? "mt-1 border-t border-edge pt-1" : undefined}>
      <p className={MENU_HEADING}>{labelFor(option)}</p>
      {/*
       * The control's own description, when the agent gives one.
       *
       * This is where a control that cannot explain its *values* can at least
       * explain itself: claude's effort choices carry no descriptions at all —
       * `Default`, `Low`, `High` and nothing else — while the option itself is
       * described as "Available effort levels for this model". Showing that is
       * the difference between a menu of bare words and a menu that says what
       * it is for.
       */}
      {(prose?.description ?? option.description) !== null && (
        <p className="px-2 pb-1 text-2xs text-faint">{prose?.description ?? option.description}</p>
      )}
      {/* `text-muted` rather than the description's `text-faint`: this one is
          about what will happen if you tap, and it has to outrank prose. */}
      {shared !== null && (
        <p id={sharedId} className="px-2 pb-1 text-2xs text-muted">
          {shared}
        </p>
      )}
      {/*
        ⚠ **Only reachable when the whole list did not arrive**, which is why it
        states a fact and names no remedy — this app's standing rule for a refusal,
        and here there genuinely is none anybody can act on from this panel.
        `AgentConfigBar` reads the complete control from `GET /sessions/:id` the
        moment it is handed a cut one, and merges it in with `truncated` cleared;
        so this line draws in the window before that lands and afterwards only if
        the machine could not be reached. Saying nothing there would be a menu
        quietly missing rows — the failure the whole `truncated` flag exists to
        prevent — and a spinner would be worse, because the rows that *are* here
        are correct and include the one that is selected.
      */}
      {option.truncated === true && (
        <p className="px-2 pb-1 text-2xs text-muted">
          Showing the first {choices.length}. The rest of this list has not loaded.
        </p>
      )}
      {choices.map((choice, index) => {
            const heading = choice.group !== null && choice.group !== choices[index - 1]?.group;
            // The transcript's copy first: the snapshot's is always null for a
            // choice that is not the selected one, because `snapshotConfig` strips
            // prose to keep a sixty-row poll cheap. This is where "Default" says
            // which model. Resolved once — it was the same three-term chain
            // written twice, once to test it and once to draw it.
            const description = rowDescription(
              option,
              choice.value,
              prose?.choices.get(String(choice.value)) ?? choice.description,
            );
            const refusal = refusals[index] ?? null;
            return (
              <div key={`${choice.group ?? ""}:${choice.value}`}>
                {heading && (
                  <p className="mt-1 px-2 py-0.5 text-2xs text-faint">{choice.group}</p>
                )}
                <button
                  role="option"
                  aria-selected={choice.value === option.value}
                  /*
                   * **Not `disabled`, and not dimmed.** A greyed inert row answers
                   * "why can I not tap this?" with silence on a phone, where there
                   * is no tooltip — which is the bargain `Absent` already makes for
                   * a whole control, moved one level down to a row: it opens, says
                   * its sentence, and sends nothing.
                   *
                   * `onChoose` is not called, so `Select`'s own `setOpen(false)`
                   * inside it never runs either — the menu stays open with the
                   * sentence under the thumb rather than closing on a tap that did
                   * nothing.
                   */
                  aria-disabled={refusal !== null || undefined}
                  aria-describedby={refusal !== null && shared !== null ? sharedId : undefined}
                  onClick={() => {
                    if (refusal !== null) return;
                    onChoose(String(choice.value));
                  }}
                  className={`${menuRow("start")} hover:bg-raised ${
                    choice.value === option.value ? "font-medium" : ""
                  }`}
                >
                  <span className="mt-0.5 w-3 shrink-0">
                    {choice.value === option.value && <Icon as={Check} size={11} />}
                  </span>
                  <span className="min-w-0">
                    {/* The same relabelling the chip does, so the menu row and the
                        chip cannot say two different things about one value. */}
                    <span className={`block truncate ${refusal !== null ? "text-muted" : ""}`}>
                      {rowLabel(option, choice)}
                    </span>
                    {/* The refusal takes the second line where there is one to
                        take: what happens if you tap outranks what the value is. */}
                    {refusal !== null && shared === null ? (
                      <span className="block text-2xs text-muted">{refusal}</span>
                    ) : (
                      description !== null && (
                        <span className="block text-2xs text-faint">{description}</span>
                      )
                    )}
                  </span>
                </button>
              </div>
            );
          })}
    </div>
  );
}

/**
 * The label a menu row gets when the agent's own is unhelpful.
 *
 * Two values qualify — claude's `default` effort and claude's and kimi's `default`
 * mode —
 * and each because what it means was established by measurement rather than
 * guessed. That is written down exactly once, in `agentConfig.ts`'s
 * {@link choiceOverride}, and this calls it. The rule used to be copied here
 * verbatim, under a comment claiming the two were kept beside each other so they
 * could not diverge — they were in different files, and only the chip's copy was
 * reachable by `webcheck`, so a correction to one would have been invisible in
 * the other.
 *
 * Calling it directly rather than going through `chipValue` is what removes the
 * old `model` special case: `chipValue` deliberately rewrites a model to the head
 * of its description, which is right for a chip showing one value and wrong for a
 * menu listing every value with that description printed underneath it. Asking
 * the narrow question narrowly means there is no wrong answer to exclude.
 *
 * **It answers a string now rather than `null` plus a fallback the caller wrote.**
 * The fallback was `?? choice.name`, and there were three of it — here, in
 * `chipValue` and in `configChoices` — which is the rule this docblock says lives
 * in one place, written out in three. `choiceLabel` is that place and it holds the
 * second rule too: opencode publishes its modes as `build` and `plan` where the
 * other three agents publish `Build`-shaped names.
 */
function rowLabel(option: AgentConfigOption, choice: AgentConfigChoice): string {
  return choiceLabel(option, choice);
}

/**
 * The sentence under that row — **ours only where the agent offered none.**
 *
 * kimi describes its `default` mode better than we could ("Manual approvals; tools
 * execute normally.") and keeps that sentence; claude sends `description: null`
 * for the same mode and for every effort choice, and gets ours. Preferring the
 * override unconditionally would have thrown away the one real description in the
 * set to print a shorter one we wrote.
 */
function rowDescription(
  option: AgentConfigOption,
  value: string | boolean,
  own: string | null,
): string | null {
  return own ?? choiceOverride(option, value)?.description ?? null;
}

function Toggle({
  option,
  prose,
  disabled,
  locked,
  onChange,
}: {
  option: AgentConfigOption;
  prose: ConfigProse | undefined;
  /** No agent to ask. Inert **and** dimmed — see `Select`'s pair. */
  disabled: boolean;
  /** Another control in this row is in flight. Inert and **not** dimmed. */
  locked: boolean;
  onChange: (value: boolean) => void;
}): ReactNode {
  const on = option.value === true;
  return (
    <button
      onClick={() => onChange(!on)}
      disabled={disabled || locked}
      title={prose?.description ?? option.description ?? labelFor(option)}
      aria-pressed={on}
      className={`${CHIP} px-2 font-medium ${disabled ? "opacity-40" : ""} ${
        on
          ? "border-edge-strong bg-raised font-medium text-fg hover:bg-edge"
          : "border-edge-strong bg-surface text-muted hover:bg-raised hover:text-fg"
      }`}
    >
      {label(option)}
      <span className="max-w-32 truncate">{labelFor(option)}</span>
    </button>
  );
}
