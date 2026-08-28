import { Check, ChevronDown, ChevronRight, ListFilter, Pencil, Search, Trash2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { rememberPick, rememberRemoval } from "../agentPick";
import { agentPath, navigate, newPath } from "../router";
import type { AgentStep } from "../nav";
import {
  allModels,
  choiceRefusal,
  defaultAgentName,
  groupModels,
  harnessRowRefusal,
  hostable,
  searchModels,
  supportingHarnesses,
  type ModelChoice,
} from "../agents";
import { errorText } from "../http";
import {
  OPENROUTER_SYSTEM_ID,
  fetchOpenRouterModels,
  openRouterNotice,
  type OpenRouterRead,
} from "../openrouter";
import type { MachineId } from "../ids";
import { daemonReadable } from "../machine";
import { store } from "../store";
import type { AgentCapabilities, AgentId, CustomAgent, SystemInfo } from "../wire";
import { AgentGlyph } from "./AgentIcons";
import { agentLabel } from "./agentCard";
import {
  Button,
  ChoiceRow,
  DangerButton,
  Empty,
  Icon,
  IconButton,
  Menu,
  MENU_HEADING,
  reachText,
  SEARCH_FIELD,
  SETTINGS_HEADING,
  SHEET_FOOT,
  SHEET_SCREEN,
  SHEET_SCROLL,
  Spinner,
  menuRow,
} from "./bits";
import { AGENT_IDS } from "../wire";

/**
 * Assembling an agent: a model, a harness, a name. And editing one already saved.
 *
 * ⚠ **Three screens in one pop-up, and the flow is what owns the draft.** The
 * builder and its two choosing screens are separate routes — `/agent/:machineId`,
 * `…/llm/:cwd`, `…/harness/:cwd` — so each one arrives with the horizontal slide,
 * Android's Back and a ◀ that cannot disagree with either. A route change unmounts
 * the screen, though, so nothing a screen holds may be the answer: the harness,
 * the model and the name live here, one level above all three, and a picker
 * reports through `onPick` rather than keeping anything.
 *
 * ⚠ **The two expensive reads happen here, once.** `GET /agents/capabilities`
 * starts an agent per harness on the daemon's host; doing it inside a picker would
 * pay for it again every time somebody walked in and out of one.
 *
 * ⚠ **A choice is greyed, never removed, and no *picker* ever clears the other's
 * value.** Picking Codex greys out Kimi K2; it does not silently drop it. A
 * conflicting pair stays on screen, says why on the row it is about and again
 * beside the button, and the button is what refuses — because a choice somebody
 * made being deleted by a later one is the failure this app avoids everywhere
 * else, and there it would look like the form forgetting.
 *
 * ⚠ **A field can be emptied, and that is the opposite of the rule above rather
 * than an exception to it.** Each row carries a `Clear` beside its label, which
 * empties that field and no other. What the rule forbids is *implicit* deletion —
 * a tap aimed at picking one thing silently dropping another — and a labelled
 * control on the row whose value it empties is the ordinary form affordance. It is
 * also the precondition for the model list refusing a pairing at all: with both
 * screens weighing the other's value, taking the pair apart a field at a time is
 * the only way out of a pair no picker chose. Never inside a picker, which would
 * be a control that exists only to undo a constraint that screen invented.
 *
 * ⚠ **Editing is this same screen with a stored row loaded into it**, which is why
 * `preset` is one more prop rather than a component of its own: the three fields,
 * the two pickers and the pairing rules are the same objects answering the same
 * questions, and a second copy of them would be a second place for `hostable` to
 * be applied slightly differently. What an edit adds is a third
 * read (`GET /custom-agents`, cheap — it is a table), a verb on the button that
 * says which act is about to happen, and Remove. The **head** is `sheetTitle`'s
 * and says "Edit agent"; nothing in here repeats it, for the reason the name line
 * below already gives.
 */
export function AgentBuilder({
  machineId,
  cwd,
  step,
  preset,
}: {
  machineId: MachineId;
  /** Carried only so the way back can restore it. See the route. */
  cwd: string | null;
  /** Which screen of the flow the address names, or `null` for the builder. */
  step: AgentStep | null;
  /**
   * The agent being edited, or `null` for a new one.
   *
   * An id off the address rather than a row handed down, because this component
   * is a *route*: `StartSheet` is mounted for `/new` and `/agent` alike but
   * `NewSession` — which holds the listing — is not, so there is nothing above
   * here to hand a row down. See `agentBuilderPath`'s `edit` marker for why the
   * address says which act it is rather than being read back off the id's shape.
   */
  preset: string | null;
}): ReactNode {
  /*
   * Subscribed here rather than taken as a prop, and it costs nothing that was
   * not already being paid: `App` re-renders on every publish and `StartSheet`
   * takes `state`, so this component already re-rendered with the whole store
   * behind it. What a prop would buy is one more argument threaded through a
   * component that is a *route* — and what it is read for is one machine row,
   * for the reachability branch below.
   */
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [systems, setSystems] = useState<SystemInfo[] | null>(null);
  const [capabilities, setCapabilities] = useState<Record<string, AgentCapabilities> | null>(null);
  /**
   * The harness, or `null` until somebody picks one.
   *
   * ⚠ **No default, and that is what makes the row pressable.** It opened on
   * `claude`, which reads as an answer already given: the row said "Claude", the
   * screen behind it offered nothing to change, and picking the harness you were
   * already on is not a choice anybody makes. Starting empty also puts the two
   * rows in the order the screen states them — model first, then what runs it —
   * instead of quietly weighing every model against a harness nobody named.
   */
  const [harness, setHarness] = useState<AgentId | null>(null);
  const [picked, setPicked] = useState<{ system: string; model: string } | null>(null);
  const [name, setName] = useState("");
  /** Frozen the moment somebody types, so their name is not overwritten by a pick. */
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Whether Remove has been pressed once. See the two-step below. */
  const [confirming, setConfirming] = useState(false);
  /**
   * The stored row this screen is editing, once it has been read.
   *
   * Held whole rather than only seeded from, because two things ask it questions
   * after the fields have been touched: the button, which must not offer to save
   * an edit whose row was never found, and Remove's sentence, which names the
   * harness **as stored** — the person may have changed the harness row on their
   * way to deleting the thing, and what happens to their chats is decided by what
   * is on the machine, not by what is on screen.
   */
  const [stored, setStored] = useState<CustomAgent | null>(null);
  /**
   * The three ways an edit can fail to open, kept apart.
   *
   * A stale link and a dead network are the same silence to whoever is holding
   * the phone, and this app's rule about that is written down one file over: a
   * failed read is not an empty machine. `presetGone` is a read that **worked**
   * and found no such row — deleted on another device, or an address somebody
   * kept — and it earns its own sentence; `presetFailure` is the read itself
   * failing and says what the daemon said, which is the only honest thing to say
   * about a request that never landed.
   */
  const [presetGone, setPresetGone] = useState(false);
  const [presetFailure, setPresetFailure] = useState<string | null>(null);

  const daemon = store.daemonFor(machineId);

  /**
   * The write in flight, and whether this screen is still the one that asked.
   *
   * ⚠ **Both halves, because the failure was a navigation being *undone*.** The
   * save used to run `rememberPick` and then `navigate` with no guard, so pressing
   * ◀ or the ✕ while `POST /custom-agents` was in the air — a route that starts
   * the harness on its host to re-weigh the pairing, so seconds rather than
   * milliseconds — dragged somebody back to New session from wherever they had
   * gone, and re-selected a tile they had walked away from. The abort is the other
   * half: `request` composes a caller's signal with its own deadline, so a screen
   * that has been left stops holding a socket open.
   *
   * `alive` is set **on the way in** as well as cleared on the way out, and that
   * is StrictMode rather than tidiness: development mounts, unmounts and remounts
   * every component, and a flag only ever cleared would leave the second mount
   * unable to navigate at all — `main.tsx` records the same hazard about the
   * bootstrap it deliberately keeps outside React.
   */
  const alive = useRef(true);
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      inflight.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (daemon === undefined) return;
    let cancelled = false;
    /*
     * Two reads, and only the second one is expensive.
     *
     * `GET /systems` is a table. `GET /agents/capabilities` starts an agent per
     * harness on the daemon's host to read what each publishes and what each
     * accepts — which is why it is here, on a screen somebody opened on purpose,
     * and not on the New session sheet that draws the strip.
     *
     * ⚠ **They were one `Promise.all`, and that made the *third* read arrive
     * last, always.** The OpenRouter effect below is gated on `openRouterListed`,
     * which is derived from `systems` — and with both legs awaited together,
     * `systems` was not set until the expensive one landed. So a 672 KiB read of
     * somebody else's catalogue did not begin until the render in which the
     * spinner left: it was queued behind four cold agent spawns on a route whose
     * own budget is `SLOW_ROUTE_TIMEOUT_MS`, and was then necessarily the last
     * thing on screen. What somebody saw was the model list filling in under
     * them, twice — once by the notice's height and once by 289 inserted rows.
     *
     * Split, the table read lands in milliseconds, the third read runs
     * *concurrently* with the agent spawns, and in every realistic case its rows
     * are in `catalogue` before this screen draws at all. No new request — the
     * fetch already dedupes on a module-level promise — and no new state.
     *
     * ⚠ **Waiting for it instead was the other candidate and it is refused**, for
     * the rule written on the effect below: a host neither this daemon nor this
     * control plane owns may not hold up the two reads that they do. Gating the
     * render on it buys a 15-second spinner wherever `openrouter.ai` is
     * blackholed — every open, since a failed read is deliberately not cached —
     * over a screen whose harness, name and buttons have nothing to do with that
     * provider. And `openRouterListed` is false on a daemon too old to list the
     * system *and* on the failure path below, where nothing ever sets the read:
     * gating on it there is a spinner that never stops, three lines under a
     * comment that exists to prevent one.
     *
     * ⚠ **Both catches still set both values.** Either read failing leaves an
     * empty picker beside a stated reason, which is what keeps the spinner from
     * outliving the failure — the property the single `catch` used to hold.
     */
    const failed = (cause: unknown): void => {
      if (cancelled) return;
      setError(errorText(cause));
      setSystems([]);
      setCapabilities({});
    };
    void daemon
      .systems()
      .then((listing) => {
        if (cancelled) return;
        setSystems(listing.systems);
      })
      .catch(failed);
    void daemon
      .agentCapabilities()
      .then((caps) => {
        if (cancelled) return;
        setCapabilities(caps.agents);
      })
      .catch(failed);
    return () => {
      cancelled = true;
    };
  }, [daemon]);

  useEffect(() => {
    if (daemon === undefined || preset === null) return;
    let cancelled = false;
    /*
     * ⚠ **A third request, and deliberately not a third leg of the `Promise.all`
     * above.** `GET /custom-agents` is a table read — the daemon's own docblock
     * says so beside the capabilities route that is not — so the cost is not the
     * reason it is separate. Two other things are. A daemon too old to have the
     * route answers 404, and folded into the pair above that 404 would take the
     * whole screen down, including the new-agent flow this build's daemon can run
     * perfectly well; and a failure *here* refuses a different act — this address
     * names a row that could not be opened, where a failure there means the
     * catalogue is empty. Two refusals, two sentences. It is also skipped
     * entirely for a new agent, which is the commoner open.
     *
     * ⚠ **The seed happens here, in the answer, rather than in an effect watching
     * it.** Anything that re-applied a stored row after the first paint would
     * fight the person: they change the harness, the row arrives a beat later, and
     * the screen puts the old one back with nothing on it saying why.
     */
    void daemon
      .customAgents()
      .then(({ customAgents }) => {
        if (cancelled) return;
        const row = customAgents.find((one) => one.id === preset) ?? null;
        if (row === null) {
          setPresetGone(true);
          return;
        }
        setStored(row);
        setHarness(row.harness);
        setPicked({ system: row.system, model: row.model });
        setName(row.name);
        // Frozen, or the first change of model would rename somebody's agent
        // under them — `NameLine`'s own rule, arriving by the other door.
        setNamed(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setPresetFailure(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, preset]);

  /*
   * A third read, and deliberately not a leg of the `Promise.all` above — the
   * same argument the stored preset makes one effect down, one step stronger:
   * this one reaches a host neither this daemon nor this control plane owns, so
   * its latency and its failure must not be able to hold up the two that do.
   *
   * ⚠ **Gated on the daemon having listed the system, which is the whole reason
   * `SystemInfo.id` is `string`.** A daemon too old to know this row means five
   * providers on screen and **no request to a third party at all** — this client
   * degrades by asking nobody, rather than by asking anyway.
   */
  const openRouterListed = systems?.some((one) => one.id === OPENROUTER_SYSTEM_ID) === true;
  const [orModels, setOrModels] = useState<OpenRouterRead | null>(null);
  useEffect(() => {
    if (!openRouterListed) return;
    let cancelled = false;
    void fetchOpenRouterModels().then((read) => {
      if (!cancelled) setOrModels(read);
    });
    return () => {
      cancelled = true;
    };
  }, [openRouterListed]);

  /*
   * ⚠ **The fetched list is substituted into the *listing*, before `allModels`
   * sees it — not carried beside the choices and not given a `source` of its
   * own.** A fetched row is a **table** spelling in every sense that matters: it
   * is what the endpoint answers to when a harness is routed at it, which is
   * exactly what the daemon's own `models` holds for every other routed system.
   * So the key rule in `agents.ts` stays true of it word for word, and that
   * module learns nothing about where this app got the names.
   */
  const listed = useMemo(() => {
    if (systems === null) return null;
    if (orModels === null || orModels.kind !== "ok") return systems;
    return systems.map((one) =>
      one.id === OPENROUTER_SYSTEM_ID ? { ...one, models: orModels.models } : one,
    );
  }, [systems, orModels]);

  const catalogue = useMemo(
    () =>
      listed === null || capabilities === null
        ? []
        : // The third argument is the *other* half of the same filter the
          // substitution above applies: `listed` carries the catalogue's accepted
          // rows, and this carries the ids it refused, so a published row cannot
          // walk past a judgement already made about it. See `allModels`.
          allModels(listed, capabilities, orModels?.kind === "ok" ? orModels.toolless : []),
    [listed, capabilities, orModels],
  );

  /**
   * What to say where the OpenRouter rows would have been, or `null`.
   *
   * Drawn only while that provider is listed at all, so an older daemon's five
   * providers carry no sentence about a sixth.
   */
  const openRouterLine =
    !openRouterListed
      ? null
      : openRouterNotice(
          orModels,
          systems?.find((one) => one.id === OPENROUTER_SYSTEM_ID)?.displayName ?? "OpenRouter",
        );
  const current: ModelChoice | null =
    picked === null
      ? null
      : (catalogue.find(
          (one) => one.system.id === picked.system && one.modelId === picked.model,
        ) ?? null);

  const routingOf = (id: AgentId | null): AgentCapabilities["routing"] =>
    id === null ? null : (capabilities?.[id]?.routing ?? null);

  /**
   * The expensive read has not landed yet.
   *
   * Distinct from "it landed and this machine offers nothing", which is `{}` and
   * draws a refusal. `caps` is the empty answer for the two readers that are typed
   * against a non-null map; every sentence either of them can build from it is
   * unreachable while the catalogue is empty, which is the argument at the gate.
   */
  const reading = capabilities === null;
  const caps = capabilities ?? {};

  /** Why the chosen pair cannot be saved, or `null`. */
  const conflict = current === null ? null : choiceRefusal(harness, current, routingOf(harness));
  /** What the agent is called: theirs if they typed one, the model's otherwise. */
  const shown = name.trim().length > 0 ? name.trim() : (current?.modelName ?? "");
  /** The machine this is all happening on, for the reachability branch below. */
  const machine = state.machines.find((one) => one.id === machineId) ?? null;

  /*
   * ⚠ **A machine this client holds no daemon for is a stated reason, never a
   * spinner.** `store.daemons` carries one client per machine for that machine's
   * life, so `undefined` means the machine is not in this account's list — a
   * stale link, or a grant revoked while the sheet was open. The effect above
   * returns before its request in that state, and nothing re-runs it, so the
   * spinner was permanent and the ◀ was the only way out.
   *
   * The listing is read for the same fact through the other table, and the two
   * are one condition rather than two branches: a machine with no row has no
   * client either, and the sentence somebody needs is the same one.
   */
  if (daemon === undefined || machine === null) {
    return (
      <div className={SHEET_SCREEN}>
        <div className={SHEET_SCROLL}>
          <Empty>That machine is not in your list any more.</Empty>
        </div>
      </div>
    );
  }

  /*
   * ⚠ **An unreachable machine is named, exactly as `MachineSystemsSection` names
   * it, and for the same reason: it is the commonest reason somebody is looking at
   * a screen that has nothing on it.** A deep link to `/agent/:machineId` against
   * a daemon that is not dialling in drew a bare spinner until the request gave up
   * — 90 seconds on `slowRoute`'s budget — and then an empty picker.
   *
   * ⚠ **But only while there is nothing to lose.** `daemonReadable`'s own docblock
   * is about precisely this: reachability flickers, `probing` publishes twice on
   * every wake, and a screen that takes its content away to report a probe throws
   * away whatever was typed into it. This screen holds a draft, so the branch is
   * gated on the catalogue being empty — which is the deep-link case and the
   * failed-read case, and is never a screen somebody has assembled anything on.
   * Once the models are in hand a machine going quiet is the *button's* to refuse,
   * with the draft still on screen behind the sentence.
   */
  if (!daemonReadable(machine.reach) && catalogue.length === 0) {
    return (
      <div className={SHEET_SCREEN}>
        <div className={SHEET_SCROLL}>
          <Empty>
            {machine.name} is not reachable right now —{" "}
            {reachText(machine.reach, machine.offlineReason)}
            {preset === null
              ? ", so nothing can be assembled on it."
              : ", so this agent cannot be changed."}
          </Empty>
        </div>
      </div>
    );
  }

  /*
   * ⚠ **An address naming an agent that is not there is a state, not an error.**
   * A link kept from yesterday, or the preset removed on another phone while this
   * one was asleep. It is the `daemon === undefined` branch's shape one level in:
   * a sentence about the thing that is missing, and the ◀ in the head as the way
   * out. The read *failing* says what failed instead — the two are told apart
   * where they are set, not here.
   */
  if (preset !== null && (presetGone || presetFailure !== null)) {
    return (
      <div className={SHEET_SCREEN}>
        <div className={SHEET_SCROLL}>
          <Empty>{presetFailure ?? "That agent is not on this machine any more."}</Empty>
        </div>
      </div>
    );
  }

  /*
   * ⚠ **The expensive read is no longer one of the things this screen waits for,
   * and that is worth more than making it faster.** `GET /agents/capabilities`
   * starts an agent per harness and took **5.3 seconds** measured on a real
   * machine — and the harness picker, the name field, the buttons and the whole
   * layout were behind it although not one of them needs the answer. `GET
   * /systems` is a table and lands in milliseconds; that is what a screen may
   * wait for.
   *
   * **What makes it safe is that nothing on the half-read screen can lie.** The
   * catalogue is empty until the answer lands, so `current` is `null`; with no
   * model chosen `harnessRowRefusal` returns `null` for every row, `choiceRefusal`
   * is never asked, and Save is already disabled on `current === null`. There is
   * no state in which this draws a pairing as possible, or as refused, on evidence
   * it does not have.
   *
   * The one control that does need it says so and cannot be opened onto nothing —
   * see `reading` below.
   */
  if (systems === null || (preset !== null && stored === null)) {
    return (
      <div className={SHEET_SCREEN}>
        {/* Not `SHEET_SCROLL` with a `flex` bolted on: that string decides
            `display`, and a call site appending its own is the shape `bits.tsx`
            refuses. There is nothing to scroll here anyway. */}
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner />
        </div>
      </div>
    );
  }

  /*
   * Every address built here carries the preset, and dropping it is how an edit
   * silently becomes a second agent: a pick that returned to `/agent/:machineId`
   * would land on the *new* agent screen with all three fields filled in and a
   * button that adds rather than saves. The ◀ carries it for the same reason and
   * by the same argument — that half is `upFrom`'s, in `nav.ts`.
   */
  const back = (): void => navigate(agentPath(machineId, cwd, null, preset), true);

  /*
   * ⚠ **The one sub-screen that genuinely has nothing to draw yet.** Reached by
   * address as well as by a tap, so the row's `disabled` below is not the whole
   * guard: an empty picker beside no reason reads as "this machine offers no
   * models", which is the sentence `ModelPicker` reserves for a machine that
   * really does.
   */
  if (step === "llm" && reading) {
    return (
      <div className={SHEET_SCREEN}>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner />
        </div>
      </div>
    );
  }

  if (step === "llm") {
    return (
      <ModelPicker
        choices={catalogue}
        capabilities={caps}
        harness={harness}
        routing={routingOf(harness)}
        failure={error}
        notice={openRouterLine}
        value={picked}
        onPick={(choice) => {
          setPicked({ system: choice.system.id, model: choice.modelId });
          if (!named) setName(defaultAgentName(choice.modelName));
          back();
        }}
      />
    );
  }

  if (step === "harness") {
    return (
      <HarnessPicker
        capabilities={caps}
        current={current}
        value={harness}
        onPick={(next) => {
          setHarness(next);
          back();
        }}
      />
    );
  }

  /**
   * The one act, under whichever verb this address names.
   *
   * ⚠ **All four fields on both paths, because an edit is a replace.** The daemon
   * requires that and says why: the pairing is a fact about the *row*, so a subset
   * body would have `hostable` weighed against the merge of body and stored row,
   * and a handler weighing it against the body alone accepts a system on a harness
   * that cannot be pointed at it. This screen holds all four anyway — it is the
   * assembly screen with a stored row loaded into it — so there is nothing to
   * merge and nothing to get wrong.
   */
  const save = (): void => {
    if (current === null || harness === null || busy) return;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    inflight.current = controller;
    const body = {
      // `shown` already falls back to `current.modelName`, and `current` is
      // non-null past the guard above, so the two arms of the ternary that used
      // to be here evaluated to the same string — a guard that guarded nothing.
      name: shown,
      harness,
      system: current.system.id,
      model: current.modelId,
    };
    void (preset === null
      ? daemon.addCustomAgent(body, controller.signal)
      : daemon.updateCustomAgent(preset, body, controller.signal)
    )
      .then((result) => {
        if (!alive.current) return;
        /*
         * ⚠ **Handed off only when the row is *new*.** Remembered rather than
         * passed up because the strip is a route away and is not mounted right
         * now, so there is no parent to report to — but an edit has nothing to
         * hand over: the row is already on the machine, `NewSession` re-reads the
         * whole listing when it mounts, and the hand-off is *adopted* by replacing
         * the list with the one row it carries. On an edit that would blank the
         * strip down to a single tile for the beat before the listing answers, to
         * report a row that was already in it. Editing is also not choosing: the
         * tile that was selected before is the one that should still be.
         */
        if (preset === null) rememberPick(machineId, result.customAgent);
        navigate(newPath(machineId, cwd ?? undefined), true);
      })
      .catch((cause: unknown) => {
        if (alive.current) setError(errorText(cause));
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  };

  /**
   * Delete the stored row, after the second tap.
   *
   * No `signal`: `DELETE` is the one write here that is safe to have landed after
   * this screen is gone — the row is meant to be gone either way — and
   * `isReplayable` in `machine.ts` already covers the verb, so a retry cannot
   * remove a second thing.
   */
  const remove = (): void => {
    if (preset === null || busy) return;
    // Held as a `const` because the hand-off below happens in a callback, and a
    // narrowing on a parameter does not survive into one.
    const going = preset;
    setBusy(true);
    setError(null);
    void daemon
      .removeCustomAgent(going)
      .then(() => {
        if (!alive.current) return;
        /*
         * ⚠ **The strip is told, through the channel a pick already uses.**
         * `StartSheet` holds which tile is chosen across the whole of `/agent`, so
         * a removal of the tile that is *currently selected* left it naming a row
         * the daemon had just dropped: nothing drew as selected, the Edit
         * affordance went with it, `Start` stayed enabled, and the session request
         * refused on an id that no longer exists. `rememberRemoval` is
         * `rememberPick`'s twin and is remembered for the same reason — the strip
         * is a route away and is not mounted right now, so there is no parent to
         * report to. Taken once at the other end, for the reason `agentPick.ts`
         * gives about a hand-off consumed twice.
         *
         * Remembered on **any** answer rather than only on one that removed
         * something: `DELETE` is idempotent now, so a replay of a delete that
         * already landed answers `removed: false`, and the tile is just as gone.
         */
        rememberRemoval(machineId, going);
        navigate(newPath(machineId, cwd ?? undefined), true);
      })
      .catch((cause: unknown) => {
        if (!alive.current) return;
        setError(errorText(cause));
        // Back to one control: a confirmation still open under a refusal invites a
        // second tap at the same pixels, which is the pair `DangerButton` orders
        // its buttons to prevent.
        setConfirming(false);
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  };

  return (
    <div className={SHEET_SCREEN}>
      <div className={SHEET_SCROLL}>
        <NameLine
          value={shown}
          onChange={(next) => {
            /*
             * An emptied field hands the name *back* to the model rather than
             * saving a blank one. Clearing a field somebody once typed into is the
             * only way to undo having typed into it, and a preset called nothing at
             * all is a tile with a blank first line.
             */
            setNamed(next.trim().length > 0);
            setName(next.trim());
          }}
        />

        <div className="mt-6 space-y-4">
          {/*
           * ⚠ **Both rows reserve the glyph slot, and only one of them can ever
           * fill it.** The harness row drew its mark conditionally, so answering it
           * moved its own text 28px to the right — 18px of glyph plus the row's
           * `gap-2.5` — and left the two rows' labels on two different left edges
           * for good, which is the same defect `ChoiceRow` reserves its check slot
           * to prevent. The slot is reserved for the *pair* rather than per row:
           * these two are one group of two, stacked 16px apart, and a model row
           * whose label starts 28px left of the harness row's reads as a
           * misalignment rather than as a row with no icon.
           */}
          {/*
            * ⚠ **Harness first, and the order is the answer to a wait rather than
            * a preference.** The model row is the one control on this screen that
            * waits — `GET /agents/capabilities` starts an agent per harness, 2.2
            * seconds measured after Q3.524 — and with it on top the first thing
            * anybody met was a row saying *Reading models…* that could not be
            * opened. The harness list is `AGENT_IDS` and needs no read at all, so
            * answering it is free and it is what the wait now runs under: by the
            * time the picker has been opened, tapped and left, the catalogue is in.
            *
            * ⚠ **And it is the order the model list is built for.** With a harness
            * chosen, `ModelPicker` collapses every provider that harness cannot be
            * pointed at into one greyed line, so the refusals arrive *before* the
            * choice they are about rather than after it. The other order works and
            * always did — neither field is required first, both can be emptied, and
            * `harnessRowRefusal` answers `null` for every row while no model is
            * chosen — but it spends the wait and then explains the pairing
            * backwards. Q3.528.
            */}
          <Field label="Harness" clear={harness === null || busy ? null : () => setHarness(null)}>
            <ChoiceRow
              glyph={harness === null ? emptyGlyph : <AgentGlyph agent={harness} size={18} />}
              title={harness === null ? "Choose" : agentLabel(harness)}
              placeholder={harness === null}
              /*
               * ⚠ **The refusal, on the row it is about.** It was only at the foot
               * of the screen, which is where a reason for a *failed request*
               * belongs and not where a reason for a pair belongs — this app's own
               * rule is that it sits beside the control it refuses. It is the
               * harness row because every sentence `choiceRefusal` can produce here
               * names the harness or the system, and the model row's one line is
               * already spent saying which provider the model is from.
               *
               * ⚠ **It is still drawn at the foot as well, and that is not a
               * duplicate.** This slot is `truncate` — one clipped line — and the
               * bar's is `wrap-anywhere`. Q3.497 already required both renderings
               * for exactly that, and the pickers cannot reach most of the states
               * that produce one: a stored preset opened for edit, a key revoked on
               * another device since this screen was read, a harness uninstalled
               * under it.
               */
              subline={conflict}
              trailing={<Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />}
              disabled={busy}
              onClick={() => navigate(agentPath(machineId, cwd, "harness", preset))}
            />
          </Field>

          {/*
            * ⚠ **Clearing the model clears a name it derived, and only that.** The
            * heading falls back to `current.modelName` until somebody types one,
            * so a derived name following its source out is the value behaving as
            * it is defined rather than the form forgetting. A name that was typed
            * has `named`, and it stays.
            */}
          {/*
            * ⚠ **The one control that waits, saying what it is waiting for.**
            * Everything else on this screen drew behind the same read for no
            * reason — see the gate above. A model list is what
            * `GET /agents/capabilities` is *for*, so this row is honestly pending
            * rather than a door onto an empty picker; and it is a sentence rather
            * than a spinner because the wait is seconds, and a spinner on one row
            * of a form reads as that row having failed.
            */}
          <Field
            label="Model"
            clear={current === null || busy ? null : () => setPicked(null)}
          >
            <ChoiceRow
              glyph={emptyGlyph}
              /*
               * ⚠ **"Choose" is a claim, and while the catalogue is out it is a
               * false one on the edit path.** `current` is looked up *in* the
               * catalogue, so a stored preset's model is absent until the read
               * lands — and a filled field drawn as empty invites somebody to
               * pick again, on the one screen where doing so silently rewrites
               * what they came to edit.
               */
              title={reading ? "Reading models…" : (current?.modelName ?? "Choose")}
              placeholder={current === null}
              subline={reading ? "Reading this machine's models…" : (current?.system.displayName ?? null)}
              trailing={<Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />}
              disabled={busy || reading}
              onClick={() => navigate(agentPath(machineId, cwd, "llm", preset))}
            />
          </Field>
        </div>

        {/*
         * ⚠ **Nothing that takes a credential is drawn on this screen, and that is
         * the rule rather than an omission.** A box for a system's pasted key was
         * mounted right here for a release, under the pair it was about, and it is
         * gone: nobody signed in to a routed pairing on this screen, and a screen
         * whose whole subject is which model runs under which harness is not where
         * a credential is handed over. There is no authorization here at all.
         *
         * ⚠ **What refuses instead lands two screens earlier, and is stronger than
         * either arrangement before it.** A routed pairing — one harness pointed at
         * another vendor's endpoint — is signed by a pasted key and nothing else,
         * and before the box a keyless one went green the whole way to `POST
         * /sessions`, which refused only *after* a worktree had been made, with the
         * remedy four taps away and the trip there unmounting this component and
         * losing the draft. The box answered that by moving the remedy in; this
         * answers it by moving the **refusal** out. The harness row is greyed in the
         * picker with the missing key as its reason, so nothing gets assembled and
         * nothing gets created — there is no draft to lose because there is no draft
         * yet. `choiceRefusal` still folds the key in for anything that reaches this
         * screen anyway, which is what keeps the button the gate below.
         *
         * ⚠ **The cost, said where it is paid.** Using a routed pairing for the
         * first time means pasting the key under Settings → Machines → <system> and
         * coming back. Once per system per machine.
         */}

        {/*
         * ⚠ **Removing is destructive and irreversible, so it takes the two-step
         * this app already draws** — `MachineSection`'s "Retire this machine" down
         * to the ordering: the consequence as prose *above* the control rather than
         * crammed into the confirmation, the answer that undoes the question
         * **last** so a second tap aimed at a control that looked like it did
         * nothing lands on Cancel, and `md`/44px at both steps because
         * `BUTTON_SIZE` reserves `sm` for a confirmation that has replaced a row's
         * controls, which is the opposite of a section on a screen.
         *
         * Cancel is `plain` rather than the filled tone `BUTTON_TONE`'s rule names,
         * and that is this screen rather than a divergence: `bg-fg` is the one
         * affirmative action per view and this view spends it on nothing at all —
         * see the button below — so a filled Cancel here would be the only filled
         * control on the screen, sitting on the answer that does nothing.
         */}
        {stored !== null && (
          /* No heading over it. `Field`'s labels are the two above and a third one
             in the same type would read as a third thing to fill in; what this
             section is, the button says in the two words it is labelled with. */
          <div className="mt-8 border-t border-edge pt-5">
            <p className="text-xs text-muted">
              {/*
               * ⚠ **What happens to the chats, before the tap rather than after
               * it.** A session holds its harness in its own column and this preset
               * only as a reference, resolved at every launch — so removing it
               * takes the model away and leaves the conversation. That was written
               * down in a daemon comment and nowhere a person could read it, which
               * makes it a consequence nobody was told about. It lands at the
               * **next** start: an agent running right now keeps the model it was
               * spawned with.
               */}
              Chats you started with it are not deleted — the next time one comes back it runs on{" "}
              {agentLabel(stored.harness)} with its own model rather than this one.
            </p>
            {confirming ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {/* "it", the way `MachineSection` asks the same question, and not
                    the agent's own name: a name is 80 characters at the bound and
                    this row has no `truncate` to give it — an unwrapped one would
                    reach past the scroller, which computes `overflow-x` to `auto`
                    the moment it sets `overflow-y`. What "it" refers to is the
                    first line of this screen. */}
                <span className="text-xs text-muted">Remove it?</span>
                <DangerButton icon={Trash2} disabled={busy} onClick={remove}>
                  {busy ? <Spinner /> : "Remove"}
                </DangerButton>
                <Button disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <DangerButton
                icon={Trash2}
                className="mt-3"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Remove agent
              </DangerButton>
            )}
          </div>
        )}
      </div>

      {/* The reason sits beside the button rather than inside it, which is
          `MachinePicker`'s rule and the sheet footer's own shape one screen over:
          a status that lengthens a control makes the control jump. */}
      <div className={SHEET_FOOT}>
        {/*
         * One line, and it carries news or nothing.
         *
         * ⚠ **It used to nudge — "pick a model", "pick a harness" — and that was
         * the wrong half of a real rule.** The rule is that a disabled button with
         * nothing beside it leaves somebody stuck, and it holds wherever the reason
         * is not already on screen. Here it is on screen twice and larger: the two
         * rows above say "Choose", with a chevron, in the order this screen asks
         * them. So the line restated at 12px what the screen had just said at 14,
         * on the one screen where the missing half is the most visible thing there
         * is. Reported as a caption that says nothing, which is exactly what it
         * was.
         *
         * What is left is the two things that are *news*: a pairing this screen
         * refuses, and a failure the daemon answered with. Neither is legible from
         * the rows, and both are the reason this slot exists at all.
         *
         * ⚠ **The failure is here too, beside the control it is about.** It used to
         * be the last paragraph of the scroller, and what moved it was a
         * measurement taken with a key box mounted under the two rows: on a 390×667
         * phone the panel is 92dvh and the head and this bar take ~112px of it, so
         * that block pushed the sentence below the fold, where nothing scrolled it
         * into view and nothing announced it — pressing the button and having the
         * daemon refuse looked exactly like pressing it and having nothing happen.
         * That block is gone and what is left clears the fold, so the measurement
         * has expired; the placement stands on its own argument, which is the one
         * the comment above this bar already makes — a reason belongs beside the
         * control it refuses, not at the end of the thing being refused. It
         * outranks the refusal because a request that was made and failed is
         * newer than a pair that was never sendable.
         *
         * ⚠ **Mounted unconditionally with only its text swapping**, which is what
         * `Sheet`'s own region records as the one arrangement that reliably
         * announces: a `role="status"` inserted in the same paint as its content is
         * commonly not spoken at all, VoiceOver on iOS included.
         */}
        <span
          role="status"
          aria-live="polite"
          className={`min-w-0 flex-1 text-2xs wrap-anywhere ${error === null ? "text-muted" : "text-danger"}`}
        >
          {error ?? conflict}
        </span>
        {/*
         * Not `primary`. `bg-fg` is the affirmative action inside a decision, one
         * per view — and `Start`, on the screen this one returns to, is that.
         *
         * ⚠ **The word is the act.** The head says "Edit agent" and a button under
         * it reading "Add agent" is the screen disagreeing with itself about what
         * the press does — on the one press that overwrites a row every tile and
         * every sleeping session naming this preset already points at.
         */}
        <Button
          onClick={save}
          disabled={busy || current === null || harness === null || conflict !== null}
        >
          {busy
            ? preset === null
              ? "Adding…"
              : "Saving…"
            : preset === null
              ? "Add agent"
              : "Save agent"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The 18px hole a harness's mark goes in, on a row that has not got one.
 *
 * A module constant rather than a `<span>` written out twice, because the two rows
 * it reserves have to be the *same* width or they are back to two left edges —
 * which is the defect it exists to remove. See the pair of rows above.
 */
const emptyGlyph = <span aria-hidden="true" className="block h-[18px] w-[18px]" />;

/**
 * The agent's name, as a name rather than as a form field.
 *
 * ⚠ **Text with a pencil beside it, and the input only once it is asked for.** A
 * bordered box at the top of a screen reads as the first thing to fill in, and
 * this is the one thing on the screen that already has an answer — the model's own
 * name, which is what almost everybody keeps. Drawn as a value, it says "this is
 * what it will be called"; drawn as a field, it asks a question nobody had.
 *
 * The placeholder is the pop-up's own name because that is what an unnamed one is
 * called, and it is muted so the difference between a default and a decision is
 * visible without a word of explanation.
 */
function NameLine({ value, onChange }: { value: string; onChange: (next: string) => void }): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const field = useRef<HTMLInputElement | null>(null);
  /*
   * ⚠ **Escape has to be able to out-race the blur, and a ref is the only thing
   * that can.** Unmounting a focused input is a `focusout`, so `onBlur` may run
   * on the way out of an Escape — with `draft` still holding what was typed,
   * which would make the cancel a save. State cannot carry the answer either:
   * `commit` closes over the `draft` of the render it was created in, so a
   * `setDraft(value)` beside `setEditing(false)` is not visible to it. Cleared on
   * the way *in* rather than on the way out, because the browser is free not to
   * fire the blur at all and a flag left set would poison the next edit.
   */
  const abandoned = useRef(false);

  const open = (): void => {
    abandoned.current = false;
    setDraft(value);
    setEditing(true);
  };
  const commit = (): void => {
    setEditing(false);
    if (abandoned.current) return;
    /*
     * ⚠ **Nothing typed is not a rename, and reporting it anyway *pins* the
     * name.** `open()` seeds the draft from what is on screen, so opening the
     * pencil and tapping away reported the model's own name straight back — which
     * the builder reads as "somebody named this" and freezes. Pick a different
     * model afterwards and the agent keeps the previous model's name, silently,
     * and is saved under it. Compared trimmed, because trimmed is what is stored.
     */
    if (draft.trim() === value.trim()) return;
    onChange(draft);
  };

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={field}
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          // Escape is the field's while it has focus — `isTypingInto` in
          // `overlay.ts` is what keeps it from reaching the sheet and closing it.
          if (event.key === "Escape") {
            abandoned.current = true;
            setEditing(false);
          }
        }}
        aria-label="Agent name"
        placeholder="New agent"
        /*
         * ⚠ **No box: the name stays the same text in the same place, and only a
         * caret appears.** It was `FIELD`'s bordered, filled box — which is what
         * every *form* field in this app looks like, and drawing one here made the
         * heading jump into a control the moment somebody pressed the pencil. That
         * reads as a different thing having opened rather than as this thing
         * becoming editable, which is the whole difference between editing in
         * place and filling in a form. What says it is live is the caret and the
         * selection, which is what an edit-in-place control has instead of a
         * border.
         *
         * ⚠ **`FIELD` cannot be composed to get here**, and not only for the
         * padding trap its own docblock records: it decides the border, the fill
         * *and* `text-sm`, so this would be three utilities arguing with it at
         * equal specificity, the winner chosen by the generated stylesheet's order
         * rather than by this attribute. Every value here matches the `<h2>` it
         * replaces, which is the whole requirement.
         */
        className="min-h-11 w-full border-0 bg-transparent p-0 text-center text-base font-semibold outline-none"
      />
    );
  }

  return (
    <div className="flex min-h-11 items-center justify-center gap-1">
      {/* `pl-6` balances the 24px control on the right, so the name is centred on
          the screen rather than on the space left over beside it. It followed the
          control down from 32px: the ink is what takes the space, and the grown
          target is a positioned pseudo-element that costs no layout. */}
      <h2
        className={`min-w-0 truncate pl-6 text-base font-semibold ${value.length === 0 ? "text-muted" : ""}`}
      >
        {value.length === 0 ? "New agent" : value}
      </h2>
      {/*
       * ⚠ **`sm`, not `chip`, and the difference is 32px of target.** `chip` grows
       * a 32px box to 44px **vertically only**, which its own docblock justifies
       * for the composer's control strip: those sit `gap-1.5` apart, so a symmetric
       * inset would put one control's target over its neighbour's face. There is no
       * neighbour here — the only thing beside this pencil is an `<h2>` nothing can
       * press — so the asymmetry bought nothing and cost a 32px-wide target on the
       * one control this screen's first line has. `sm` is 24px of ink reaching
       * 44×44 through `-inset-2.5`, which is what the panel head draws its own ◀
       * at, one row above this.
       *
       * ⚠ **Still the pencil rather than the whole row**, which was the alternative
       * and would remove the small target entirely. It also removes what the row
       * *is*: this line is drawn as a value and not as a field on purpose — a
       * bordered box at the top of a screen reads as the first thing to fill in,
       * and this is the one thing here that already has an answer. A full-width
       * button brings the press state, the hover fill and the pointer back to the
       * heading, which is the control-shaped thing the value shape was chosen over;
       * and a tap target spanning the sheet with no boundary at all is the failure
       * `--color-edge-strong` exists for, one size larger.
       */}
      <IconButton icon={Pencil} label="Rename this agent" size="sm" onClick={open} />
    </div>
  );
}

/** A label over the control it names — the New session sheet's own field shape. */
function Field({
  label,
  clear,
  children,
}: {
  label: string;
  /**
   * What empties this field, or `null` where it is already empty.
   *
   * ⚠ **Beside the row and never inside it.** `ChoiceRow` renders a `<button>` and
   * draws `trailing` within it, so a control there would be a button inside a
   * button — invalid, and resolved by browsers by breaking the outer one, which is
   * the measurement `SessionBrowser`, `MachinesSection` and this file's own
   * `Supports` have each recorded separately. `SessionRow` is the one shape in
   * this app that puts two targets on one line and it pays for it with a wrapper,
   * a reduced inner target and a measured margin; a field's heading line is
   * already outside the row and costs none of that.
   *
   * ⚠ **The slot is reserved on both fields whether or not either is filled.**
   * These two rows are one group of two and the last time their geometry differed
   * it left their labels on two different left edges for good — the defect
   * `ChoiceRow` reserves its own check slot to prevent, one level out.
   */
  clear: (() => void) | null;
  children: ReactNode;
}): ReactNode {
  return (
    <div>
      <div className="flex min-h-6 items-center justify-between gap-2 pb-1.5">
        <h3 className={SETTINGS_HEADING}>{label}</h3>
        {clear !== null && (
          <button
            type="button"
            onClick={clear}
            /* Words rather than a glyph, and the field's own name in them: two
               clears twelve pixels apart, both drawn as an ✕, are two controls a
               reader has to tell apart by position. `SystemsPanel` draws a bare
               text button under a stack of these same rows in this exact idiom. */
            className="tap press -my-1.5 shrink-0 rounded-sm px-1.5 py-1.5 text-2xs text-muted hover:bg-raised hover:text-fg"
          >
            Clear
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/*
 * `ChooseRow` and `PickRow` were here — the two rows this file drew for itself.
 *
 * Both are `ChoiceRow` in `bits.tsx` now, with the system row in `SystemsPanel`
 * that was byte-identical to them. What the merge landed is written down there
 * rather than restated here: the boundary at `edge-strong` in every state (these
 * sit on `SHEET_BODY`, which is `bg-surface`, so an unselected row was a white
 * control on a white ground identified by a 1.31:1 hairline, under a hover that
 * moved that hairline instead of a fill), and a disabled row that dims its title
 * upward to `muted` and leaves the **subline** exactly where it was — because on
 * these rows the subline is the refusal, and `disabled:opacity-40` composited it to
 * 1.83:1 against a token whose floor exists because every use of it is 12px.
 */

/**
 * Every model this machine can reach, as a screen.
 *
 * ⚠ **Search *and* a filter, because they answer different questions.** The box
 * finds a model somebody can already name; the filter answers "what does Moonshot
 * have", which is a question with no spelling. The filter is an icon rather than a
 * second bordered pill — `MachineInstalls`'s rule, and this strip already holds one
 * box — and it carries its state the three ways that row does: `bg-raised` when
 * narrowed, the system on the label, and the group heading below.
 *
 * ⚠ **A refused model keeps its row and takes the refusal as its subline.** That
 * is the one place on this screen where the pairing rules are visible at all, and
 * hiding the rows would answer "where did Kimi K2 go" with silence.
 */
function ModelPicker({
  choices,
  capabilities,
  harness,
  routing,
  failure,
  notice,
  value,
  onPick,
}: {
  choices: readonly ModelChoice[];
  /** Read only to say which harnesses each row is for. See {@link Supports}. */
  capabilities: Readonly<Record<string, AgentCapabilities>>;
  /**
   * The harness already chosen, if one is — and it weighs **providers**, never
   * rows. See the section render for the whole of what it may do.
   */
  harness: AgentId | null;
  /** That harness's own answer about what it can be pointed at. */
  routing: AgentCapabilities["routing"];
  /** Why the catalogue is empty, when it is empty because something failed. */
  failure: string | null;
  /**
   * What is missing from an otherwise working list, or `null`.
   *
   * Separate from `failure`, which is why the whole screen is empty. This one is
   * drawn *above* a list that has rows: one provider's names are read from that
   * provider's own host, and it being unreachable subtracts a section from a
   * screen the other five still fill.
   */
  notice: string | null;
  value: { system: string; model: string } | null;
  onPick: (choice: ModelChoice) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [system, setSystem] = useState<string | null>(null);
  const groups = useMemo(() => groupModels(searchModels(choices, query, system)), [choices, query, system]);
  /*
   * The providers, distinct, off the **whole** catalogue rather than off what is
   * shown — a filter narrowed into a menu with one entry has no way back.
   *
   * ⚠ **Deduplicated, because `choices` holds one entry per (system, model).** A
   * system with three models is three choices, and mapping them straight to
   * systems listed Moonshot three times in the filter menu with every entry doing
   * exactly the same thing.
   *
   * ⚠ **Not because `groupModels` splits on the route — it stopped doing that.**
   * It groups on `system.id` alone now, and the heading draws the provider and
   * nothing else; `agents.ts` argues that change where it was made. This sentence
   * described the old grouping for a release after it was gone.
   */
  const systems = useMemo(() => {
    const out: SystemInfo[] = [];
    for (const choice of choices) {
      if (!out.some((one) => one.id === choice.system.id)) out.push(choice.system);
    }
    return out;
  }, [choices]);
  const narrowed = systems.find((one) => one.id === system) ?? null;

  return (
    <div className={SHEET_SCREEN}>
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2 sm:px-5">
        <SearchBox value={query} onChange={setQuery} label="Search models" />
        <Menu
          align="right"
          panelClassName="w-48"
          className="shrink-0"
          trigger={(open, toggle) => (
            <IconButton
              icon={ListFilter}
              label={`Showing ${narrowed?.displayName ?? "every provider"}`}
              /* `chip` and never the `md` default: `md` is the one size in
                 `ICON_BUTTON_SIZE` that never reaches 44px, and `chip` grows
                 vertically only, so its target cannot cover the search box. */
              size="chip"
              expanded={open}
              onClick={toggle}
              /*
               * ⚠ **`bg-raised` alone: the `text-fg` beside it was a no-op.**
               * `ICON_BUTTON_TONE.ghost` already sets `text-muted`, and Tailwind
               * emits both at equal specificity — so which wins is decided by the
               * generated stylesheet's order rather than by this attribute, and it
               * is not this one. `bg-raised` *is* what this app spends on state,
               * which is what a narrowed filter is.
               */
              className={system === null && !open ? "" : "bg-raised"}
            />
          )}
        >
          {(close) => (
            <>
              <p className={MENU_HEADING}>Provider</p>
              {[null, ...systems.map((one) => one.id)].map((id) => {
                const label = id === null ? "All" : (systems.find((one) => one.id === id)?.displayName ?? id);
                return (
                  <button
                    key={id ?? "all"}
                    role="menuitem"
                    onClick={() => {
                      setSystem(id);
                      close();
                    }}
                    className={`${menuRow("center")} hover:bg-raised ${
                      id === system ? "font-medium text-fg" : "text-muted"
                    }`}
                  >
                    {/* A reserved slot, so choosing does not shift the labels. */}
                    <span className="inline-flex w-3 shrink-0 justify-center">
                      {id === system && <Icon as={Check} size={12} />}
                    </span>
                    {label}
                  </button>
                );
              })}
            </>
          )}
        </Menu>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5 sm:px-5">
        {/* Where the missing rows would have been, and in the faint size a
            subline uses: it is a fact about the list, not a failure of it. */}
        {notice !== null && <p className="mt-2 text-2xs text-faint">{notice}</p>}
        {groups.length === 0 ? (
          // Says what was looked for rather than "no results": over a list this
          // short, the useful answer is that this word matched none of them.
          // ⚠ **And a failed read is not an empty machine.** "This machine reports
          // no models" was drawn over a 503 with the real reason only on the screen
          // behind — the one state where somebody most needs it and cannot see it.
          <Empty>
            {query.trim().length > 0
              ? `Nothing here is called ${JSON.stringify(query.trim())}.`
              : (failure ?? "This machine reports no models.")}
          </Empty>
        ) : (
          groups.map((group) => {
            /*
             * ⚠ **A provider the chosen harness cannot be pointed at is one greyed
             * line, and its rows are not drawn at all.** This screen refused
             * nothing about a pairing for three releases (Q3.479) and the reason
             * was a deadlock: grey the rows here as well as on the harness screen
             * and neither half of a bad pair can be changed. Two things make it
             * safe now — the pair can be emptied a field at a time on the screen
             * above, and the refusal lands on the **provider** rather than on the
             * row.
             *
             * That second half is not a detail, it is the whole difference, and it
             * is arithmetic. Greying row by row was measured against the live
             * catalogue: with codex chosen it greys **461 of 463 rows**, and with
             * kimi 462 — a picker you scroll through 463 disabled lines to find
             * two. Collapsing the provider instead draws six greyed headings and
             * leaves the two that work, which is a shorter and more honest screen
             * than the one this replaces.
             *
             * ⚠ **`hostable` and never `choiceRefusal`, and the sentence is
             * `hostable`'s own.** This is the one question that is genuinely about
             * the provider — *can this harness be pointed at it at all* — so its
             * prose ("Codex cannot run OpenRouter models.") is right over a
             * heading, where `choiceRefusal` deliberately drops those words
             * because they are wrong over a row. Nothing here re-derives the
             * matrix; `agents.ts` holds it, once, for both screens.
             *
             * ⚠ **With no harness chosen it does not fire at all**, so the screen
             * is exactly what it always was until somebody has answered the other
             * half. Picking the model first — the order this flow is built in — is
             * untouched.
             */
            const wholeProvider = harness === null ? null : hostable(harness, group.system, routing);
            if (wholeProvider !== null) {
              return (
                <section key={group.system.id} className="mt-4 first:mt-2">
                  {groups.length > 1 && (
                    <h3 className={`${SETTINGS_HEADING} mb-1.5 text-faint`}>{group.system.displayName}</h3>
                  )}
                  {/* The count, because the rows are gone and their absence would
                      otherwise read as a provider with nothing in it — which is the
                      same distinction `Empty` above draws between a failed read and
                      an empty machine. */}
                  <p className="text-2xs text-faint">
                    {wholeProvider}{" "}
                    {group.choices.length === 1 ? "1 model" : `${group.choices.length} models`} hidden.
                  </p>
                </section>
              );
            }
            /*
             * ⚠ **One sentence for the group where every row would say the same
             * one.** `choiceRefusal(null, …)` here can only be the no-key refusal,
             * which is a fact about the *provider* — so on OpenRouter's 356 rows it
             * drew 356 identical sublines, a screen of one sentence repeated. Above
             * a handful the row keeps it, so Z.ai and MiniMax are untouched.
             *
             * ⚠ **Still `null` for the harness, and that is not an oversight now
             * that one is in scope.** Everything the harness settles has already
             * been settled one level up, on the heading; what is left to a row is
             * the two facts that are about the row — a spelling that belongs to the
             * other route in, and a system with no key — and both of those are the
             * same whoever is chosen. Folding the harness in here is what produced
             * the 461-of-463 measurement above, and it would take the hoist with
             * it: `cannotRun` names the *model*, so a large group's sublines would
             * all differ and 356 of them would draw individually.
             */
            const sublines = group.choices.map((one) => choiceRefusal(null, one, null));
            const first = sublines[0] ?? null;
            const shared =
              first !== null && group.choices.length > 3 && sublines.every((one) => one === first)
                ? first
                : null;
            return (
            <section key={group.system.id} className="mt-4 first:mt-2">
              {/* Drawn only where there is more than one — a heading over the whole
                  list names nothing, which is `MarketList`'s rule verbatim. It says
                  the **provider** and nothing else; which harnesses a model is for
                  is the row's own business, drawn as glyphs on the right of it, and
                  a vendor sub-heading was tried in this slot and taken out — see
                  `groupModels`. */}
              {groups.length > 1 && (
                <h3 className={`${SETTINGS_HEADING} mb-1.5`}>{group.system.displayName}</h3>
              )}
              {shared !== null && <p className="mb-1.5 text-2xs text-faint">{shared}</p>}
              <ul className="flex flex-col gap-2">
                {group.choices.map((choice) => {
                  /*
                   * ⚠ **Weighed against the *system* only, never against the
                   * harness — `choiceRefusal(null, …)`.** Greying models the
                   * current harness cannot run reads as helpful and is a trap:
                   * with Claude Sonnet chosen, every OpenAI row here was disabled
                   * *and* Codex was disabled on the other screen, so neither half
                   * of the pair could be changed and the only way out was to
                   * abandon the draft. This screen's subject is the model, so
                   * picking one always works; the harness screen is where the
                   * pairing is decided, and the button is the gate the builder's
                   * own docblock already says it is. What survives here is the one
                   * refusal that is *not* about a pairing — a system with no key,
                   * whose remedy is another screen entirely.
                   */
                  const why = choiceRefusal(null, choice, null);
                  return (
                    <li key={`${choice.system.id}:${choice.modelId}`}>
                      <ChoiceRow
                        title={choice.modelName}
                        /*
                         * ⚠ **Which harnesses can run *this* model, on the row
                         * itself.** It was a heading — `Moonshot · Kimi Code only`
                         * beside `Moonshot · other harnesses` — which invented a
                         * category to answer a question about rows, and still left
                         * every row silent about itself. A provider heading says
                         * whose model it is; these say what will run it.
                         *
                         * `trailing`, so the primitive draws it *before* the check
                         * slot and becoming the answer never displaces it.
                         */
                        trailing={<Supports choice={choice} capabilities={capabilities} />}
                        subline={
                          shared !== null
                            ? null
                            : (why ?? (groups.length > 1 ? null : group.system.displayName))
                        }
                        /* Passed on every row of this list including the false
                           ones, which is what reserves the check slot: omitting it
                           is `ChoiceRow`'s way of saying a list has no selection at
                           all, and this one plainly has. */
                        selected={
                          value !== null &&
                          value.system === choice.system.id &&
                          value.model === choice.modelId
                        }
                        disabled={why !== null}
                        onClick={() => onPick(choice)}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * The harnesses, as a screen.
 *
 * ⚠ **It has a search box over three rows, and that is deliberate rather than an
 * oversight in the other direction.** `bits.tsx` puts the picker threshold at
 * "about five", so the argument against one here is real — but the two choosing
 * screens of one flow differing in their *chrome* is worse: somebody who has just
 * typed into one arrives at the other, finds nothing to type into, and has to work
 * out whether the screen is different or broken. The box costs one row and answers
 * that before it is asked. It also stops being decorative the day `AgentId` grows,
 * which is Q7.31's whole subject.
 *
 * There is no **filter** beside it, though, and that absence is not an oversight
 * either: the model screen filters by provider, and a harness has none to filter
 * on.
 *
 * What each row says is why it cannot be used *with the model already chosen*,
 * which is the only question this screen is asked. With no model chosen yet
 * nothing is refused — see `choiceRefusal`.
 */
function HarnessPicker({
  capabilities,
  current,
  value,
  onPick,
}: {
  capabilities: Readonly<Record<string, AgentCapabilities>>;
  /** The model already chosen, against which each harness is weighed. */
  current: ModelChoice | null;
  /** `null` until somebody picks one, which is how this screen opens. */
  value: AgentId | null;
  onPick: (next: AgentId) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = AGENT_IDS.filter(
    (id) =>
      needle.length === 0 ||
      agentLabel(id).toLowerCase().includes(needle) ||
      id.includes(needle),
  );
  /**
   * What each harness that could not be asked actually said, for the disclosure.
   *
   * Off the rows on screen rather than off `AGENT_IDS`, so a narrowed list does
   * not explain a row that is not in it.
   */
  const reported = shown
    .map((id) => ({ id, said: capabilities[id]?.error ?? null }))
    .filter((one): one is { id: AgentId; said: string } => one.said !== null);

  return (
    <div className={SHEET_SCREEN}>
      <div className="flex shrink-0 items-center px-4 pt-4 pb-2 sm:px-5">
        <SearchBox value={query} onChange={setQuery} label="Search harnesses" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2 pb-5 sm:px-5">
        {shown.length === 0 ? (
          <Empty>Nothing here is called {JSON.stringify(query.trim())}.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((id) => {
              /*
               * ⚠ **A harness that could not be *asked* is not a harness that
               * refuses.** `routing: null` means both — "declares no provider
               * methods", which is Kimi Code, and "we never got an answer", which
               * is a spawn that failed — so weighing the pairing first drew
               * "Kimi Code only runs its own models" over a missing binary. The
               * daemon already separates them: `error` is set only in the second
               * case, and it is checked first. What that arm **draws** is this
               * app's own sentence and never the daemon's string — see
               * {@link COULD_NOT_ASK}, which is where that ends up instead.
               */
              const failed = capabilities[id]?.error ?? null;
              /*
               * ⚠ **Named for the row it is on: `Cannot run K3.`, or `No model
               * called K3.`** The sentences `choiceRefusal` builds name the harness
               * too, which is the title directly above this line — and there are
               * two of them, because a protocol this harness will never speak and a
               * spelling that belongs to the other route into the system are
               * different facts. See `harnessRowRefusal`.
               */
              const why =
                failed !== null
                  ? COULD_NOT_ASK
                  : harnessRowRefusal(id, current, capabilities[id]?.routing ?? null);
              return (
                <li key={id}>
                  <ChoiceRow
                    glyph={<AgentGlyph agent={id} size={18} />}
                    title={agentLabel(id)}
                    subline={why}
                    selected={id === value}
                    disabled={why !== null}
                    onClick={() => onPick(id)}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {reported.length > 0 && <Reported entries={reported} />}
      </div>
    </div>
  );
}

/**
 * A harness this machine could not ask, in this app's own words.
 *
 * ⚠ **The daemon's `error` used to be the subline, verbatim, and it is the one
 * place in this whole flow where the wire reached the screen.** `GET
 * /agents/capabilities` catches per harness and fills that field with
 * `error instanceof Error ? error.message : String(error)`, so what a row said was
 * `spawn kimi ENOENT`, a JSON-RPC `-32601`, or `model_timeout: no answer within
 * 120s` — drawn at 12px with `truncate`, one clipped line, with nothing anywhere
 * to read the rest of. The rule it broke is the one every other refusal on these
 * two screens is held to: a sentence, no word from the wire, both of its nouns on
 * the screen it is drawn on. It could not be fixed by a predicate either —
 * `webcheck`'s `noJargon` sweeps the strings `hostable` *returns*, and it can never
 * sweep a string somebody else's process supplies — so the fix is structural: this
 * client does not draw that string in that slot, and there is exactly one sentence
 * here for it to draw instead.
 *
 * ⚠ **One sentence for every way the ask can fail, because the client cannot tell
 * them apart and must not guess.** The adapter missing, the binary missing, a
 * handshake refused, a harness that answered nothing inside its budget, and two
 * asks already running — all five are one string on the wire and there is no field
 * that separates them. Reading which it was out of the message means this client
 * parsing the daemon's prose, which is a copy of the daemon's wording that goes
 * stale silently. What is true of all five is that the machine could not find out
 * what this harness runs, and that is what this says.
 *
 * The words are `agentCard.ts`'s rather than new ones: that module already turns a
 * harness's state into sentences and already says "This machine couldn't check
 * whether Claude Code is signed in" for the state where a probe did not answer.
 * Same subject, same verb, same claim — and with the harness dropped, because the
 * row is titled with it, which is `harnessRowRefusal`'s rule.
 */
const COULD_NOT_ASK = "This machine couldn't check what it can run.";

/**
 * What the machine actually said, once and at the foot of the list.
 *
 * ⚠ **Kept rather than deleted, because the person reading it owns the machine.**
 * `spawn kimi ENOENT` is the whole answer to somebody's own PATH and there is no
 * other screen in this app that carries it. What it may not be is a **refusal**:
 * one clipped 12px line in the slot where the reason goes, at 1.83:1 once the row
 * was disabled. So it moves out of the row entirely — full width, wrapped, at the
 * bottom, behind a press whose label says whose words these are and which harness
 * said them, so nobody meets a `-32601` without being told who is talking.
 *
 * ⚠ **Not a `<details>`**, though it is exactly that shape: this app has none, and
 * `<summary>` arrives as a `list-item` with a marker and no tap target, which is
 * three overrides before it matches anything else here. A `<button>` with
 * `aria-expanded` is what a disclosure is; `Button` has no prop for that attribute,
 * and a disclosure that does not tell a screen reader it is one is worse than a
 * hand-written class string.
 *
 * ⚠ **The chevron is the only thing on this control that says it is one, and on a
 * phone it was missing.** It was a borderless, fill-less, glyph-less row whose
 * entire pre-touch affordance was `hover:text-fg` — a state a touch screen does
 * not have — drawn at `text-2xs text-muted`, a step from the `text-2xs text-faint`
 * sublines above it and from the rows it discloses. So a finger had nothing at all
 * to tell it from the prose around it, on the one control in this whole client that
 * reaches the daemon's own words. `press` only answers a touch that has already
 * happened and the focus ring only serves a keyboard, so neither is the pre-touch
 * signal. Contrast, 44px and `aria-expanded` were already right; this is the shape.
 *
 * ⚠ **The glyph *swaps* rather than rotating, which is this app's majority idiom
 * and the two do disagree.** `EventList`'s run row rotates one `ChevronRight` under
 * `transition-transform`; its subagent row, its diff row and `PermissionCard`'s
 * `details` all swap `ChevronRight`/`ChevronDown`. The swap wins on the nearest
 * neighbour rather than on the count: `PermissionCard`'s is a `text-2xs text-muted`
 * disclosure with the label *after* the glyph and no fill and no border — this
 * control, on another screen — and copying its shape is what keeps this from
 * becoming a fourth variant.
 *
 * ⚠ **And it stopped being `w-full`.** A press spanning the sheet with no boundary
 * is what `NameLine` refuses one size smaller: with a glyph and 44px the control is
 * as wide as the thing it draws, so the pressable area and the ink are the same
 * object.
 */
function Reported({ entries }: { entries: readonly { id: AgentId; said: string }[] }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 border-t border-edge pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="tap press flex min-h-11 items-center gap-1 text-2xs text-muted hover:text-fg"
      >
        {/* Uncoloured, so it inherits `text-muted` and brightens with the label on
            hover — `PermissionCard`'s shape exactly. The `text-faint` wrapper the
            transcript's diff row puts around its chevron is for a row whose glyph
            sits *beside* other glyphs; here it is the one affordance on the
            control, and the dimmest token in the palette is the wrong place for
            it. */}
        <Icon as={open ? ChevronDown : ChevronRight} size={11} />
        What this machine reported
      </button>
      {open && (
        <div className="space-y-2 pb-1">
          {entries.map((one) => (
            <p key={one.id} className="text-2xs text-faint wrap-anywhere">
              <span className="text-muted">{agentLabel(one.id)}</span> — {one.said}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The one search box these two screens share.
 *
 * A function rather than the same eight lines twice: the two are one tap apart,
 * and a copy is a second chance to be wrong the next time `SEARCH_FIELD`'s padding
 * rule is applied — which is what `MarketList` already says about its own.
 */
function SearchBox({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
}): ReactNode {
  return (
    <div className="relative min-w-0 flex-1">
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-faint">
        <Icon as={Search} size={13} />
      </span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        placeholder={label}
        className={SEARCH_FIELD}
      />
    </div>
  );
}

/**
 * The harnesses that can run one model, as their own glyphs.
 *
 * ⚠ **The label is the whole point of the glyph being a glyph, and it has to
 * arrive at once.** Three marks on the right of a row are unreadable to anybody
 * who has not learned them. It was the `title` attribute, which is the *browser's*
 * tooltip: about a second of delay, unstyleable, and reported as simply not
 * appearing — a second is long enough that nobody waits, so the label may as well
 * not exist. This is a plain `group-hover` reveal instead, so it is on screen the
 * frame the pointer arrives. **No `transition`**, deliberately: a fade is another
 * way of being late.
 *
 * ⚠ **It opens to the *left*, inside the row's own box**, which is what keeps it
 * out of the scroller's clip. The list is `overflow-y-auto`, and setting one axis
 * makes the other compute to `auto` too — so anything reaching past the row would
 * be cut at the top and bottom of the list. Left of the glyph and vertically
 * centred, it can only ever overlap its own row's label, which is what an opaque
 * plate is for. Nothing needs a `z-index`: rows are siblings and this never leaves
 * its own.
 *
 * The group carries the sentence once as an `aria-label` — a `title` on a `<span>`
 * is announced by nothing, and neither is a hover-revealed one — with the glyphs
 * `aria-hidden` inside it, or the name is read twice.
 *
 * ⚠ **On a coarse pointer the marks are the *words*, because a hover reveal on a
 * phone is nothing at all.** This used to say that a pointer was the only way to
 * the label and move on, which left the phone — the device this app is shaped
 * around — with three 13px shapes on the right of every row and no way to find out
 * what any of them meant, on the one screen whose whole subject is what will run
 * this model. A screen reader was served and a person looking at the screen was
 * not. The swap is CSS rather than `matchMedia`: both are in the DOM and
 * `[@media(pointer:coarse)]` decides which is drawn, so nothing is measured in
 * JavaScript and nothing re-renders when a mouse is plugged in.
 *
 * ⚠ **Words instead of the glyphs, never beside them.** The row is `min-w-0` with
 * a truncating title, so a second copy of the same fact would eat the model's name
 * on a 390px screen. This is at most two harnesses in practice — the matrix is
 * "which of these can be pointed at that", and no model in it is offered by all
 * three — so `Claude Code · Codex` is what the widest of them costs.
 *
 * ⚠ **The tap target that is not here.** Making the cluster press to reveal was the
 * other option and it cannot be built: this is drawn inside `ChoiceRow`'s
 * `<button>`, so a nested control is invalid and its press would pick the row
 * anyway. The label has to be *already on screen* for a finger, which is what the
 * words are.
 *
 * Weighed with {@link supportingHarnesses}, which ignores the key deliberately:
 * this is what a model is *for*. Whether a harness is *ready* to run it is the
 * harness row's answer one screen later, and clearing that one is a trip to
 * Settings → Machines — the only place in this app a system key is pasted.
 */
function Supports({
  choice,
  capabilities,
}: {
  choice: ModelChoice;
  capabilities: Readonly<Record<string, AgentCapabilities>>;
}): ReactNode {
  const able = supportingHarnesses(choice, capabilities);
  if (able.length === 0) return null;
  return (
    <span
      role="img"
      aria-label={`Supports ${able.map((id) => agentLabel(id)).join(", ")}`}
      className="flex shrink-0 items-center gap-1 text-faint"
    >
      {/* `max-w-32` is what makes the truncation land *here* rather than on the
          model's name: the group is `shrink-0`, exactly as it was when it held only
          glyphs, so without a ceiling of its own a long list would take the row and
          leave the title with nothing. 128px holds the two-harness case whole,
          which is the widest one the matrix actually produces. */}
      <span
        aria-hidden="true"
        className="hidden max-w-32 truncate text-2xs [@media(pointer:coarse)]:block"
      >
        {able.map((id) => agentLabel(id)).join(" · ")}
      </span>
      {able.map((id) => (
        <span
          key={id}
          aria-hidden="true"
          className="group/mark relative inline-flex [@media(pointer:coarse)]:hidden"
        >
          <AgentGlyph agent={id} size={13} />
          <span className="pointer-events-none absolute top-1/2 right-full mr-2 hidden -translate-y-1/2 rounded-md border border-edge bg-surface px-2 py-1 text-2xs whitespace-nowrap text-fg shadow-lg group-hover/mark:block">
            Supports {agentLabel(id)}
          </span>
        </span>
      ))}
    </span>
  );
}

