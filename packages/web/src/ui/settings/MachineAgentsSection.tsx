import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { GripVertical, MoreHorizontal, Plus } from "lucide-react";
import {
  defaultRow,
  dropIndex,
  moveRow,
  orderStrip,
  stripEntries,
  stripKey,
  type StripRow,
} from "../../agentStrip";
import { customAgentSubline, harnessSubline, startableHere } from "../../agents";
import { rememberRemoval } from "../../agentPick";
import { ApiError, errorText } from "../../http";
import type { MachineId } from "../../ids";
import { daemonReadable } from "../../machine";
import { agentEditPath, agentFromHarnessPath, agentPath, navigate } from "../../router";
import { store, type AppState } from "../../store";
import type { AgentId, AgentInfo, AgentStripEntry, CustomAgent, SystemInfo } from "../../wire";
import { agentBadge, agentLabel, agentStance, startsBare } from "../agentCard";
import { AgentGlyph } from "../AgentIcons";
import { Badge, Button, Empty, Icon, IconButton, Menu, reachText, RowAction, Spinner } from "../bits";

/**
 * Which agents this machine's New session strip offers, and in what order.
 *
 * ⚠ **The screen exists because the strip could not answer two questions about
 * itself.** It drew every harness that could be started and every agent somebody
 * had assembled, in the daemon's order — `AGENT_IDS`, then `ORDER BY created_at`
 * — so there was no way to move the one you always start to the front and no way
 * to take out one you never use. On a phone that puts the answer off the right
 * edge of a row you have to drag. Both are preferences about a *list*, and a list
 * is a screen rather than a gesture on a 112px tile.
 *
 * ⚠ **Per machine, and on the daemon.** The strip is about what one host can
 * start — `custom_agents` beside it is already shared the same way — and a phone
 * discards this page on its own, so a preference held in this tab would be one
 * that vanishes the first time somebody locks their screen.
 *
 * ⚠ **What is listed here is wider than what the strip draws, and the gap is the
 * point.** The strip filters by `shownHere`: a harness nobody is signed in to has
 * no tile. A screen that filtered the same way would answer "show Codex" with a
 * row that changes nothing visible, so every harness that can *ever* have a tile
 * is listed and its badge says why it has not got one. `startsBare` is the single
 * exclusion and it is not a status — opencode is a router and has no tile in any
 * state, so a row you could order that can never appear is a lie rather than a
 * warning.
 */

/** Everything the screen reads, so "still loading" is one flag rather than four. */
interface Listing {
  agents: AgentInfo[];
  presets: CustomAgent[];
  systems: SystemInfo[];
  stored: AgentStripEntry[];
}

/** The drag, as the list has to see it: which row left, and where it is going. */
interface Drag {
  from: number;
  to: number;
  /** One row's height in pixels, measured at `pointerdown` off the row itself. */
  height: number;
}

export function MachineAgentsSection({
  state,
  machineId,
}: {
  state: AppState;
  machineId: MachineId;
}): ReactNode {
  const machine = state.machines.find((one) => one.id === machineId) ?? null;

  if (machine === null) {
    // A stale link, or a machine revoked in another tab. Not an error screen: the
    // list two levels up is the answer and the pane's chevron walks there one step
    // at a time — `MachineSystemsSection`'s rule, and not the ✕, which leaves
    // settings entirely.
    return <Empty>That machine is not in your list any more.</Empty>;
  }

  if (!daemonReadable(machine.reach)) {
    // Named rather than silently empty, for `MachineSystemsSection`'s reason: an
    // unreachable machine is one of the commonest reasons to be on a settings
    // screen, so the honest thing is to say which machine and why it is blank.
    return (
      <Empty>
        {machine.name} is not reachable right now —{" "}
        {reachText(machine.reach, machine.offlineReason)}, so what it offers cannot be read or
        reordered.
      </Empty>
    );
  }

  return <StripEditor key={machineId} machineId={machineId} />;
}

/**
 * The list itself, keyed on the machine.
 *
 * Split from the guards above because a hook may not sit under an early return —
 * and the key earns its place twice: a drag in flight on one machine can never
 * land on another's list, and neither can a write.
 */
function StripEditor({ machineId }: { machineId: MachineId }): ReactNode {
  const [listing, setListing] = useState<Listing | null>(null);
  const [rows, setRows] = useState<StripRow[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * Whether this daemon has the routes at all.
   *
   * ⚠ **An envelope-free 404 and nothing else** — the test `NewSession`,
   * `importSupported` and `pluginFailure` already share, for a route a build never
   * registered. Everything else answered *about* the route: a 503, a relay
   * `no_tunnel`, a dead network. Collapsing the two is how a transient failure
   * becomes "your machine will never have this", with every control switched off
   * and nothing on screen saying it was temporary.
   */
  const [supported, setSupported] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** The last list the daemon confirmed, so a refused write has somewhere to land. */
  const saved = useRef<StripRow[]>([]);
  /**
   * The list as it stands, for the one caller that reads it from a `.then`.
   *
   * ⚠ **A closure holds the value as it was when the request was sent**, which is
   * `NewSession`'s standing note about its own listing effect. `remove` computes
   * the next strip *after* a `DELETE` comes back, and a drag that landed while that
   * request was in flight is a reorder this would otherwise undo — silently, and on
   * the screen whose whole subject is the order. Written on every render rather
   * than in an effect, so it is true within the render that produced it.
   */
  const latest = useRef<readonly StripRow[]>(rows);
  latest.current = rows;
  /** Bumped per write, so a stale answer cannot overwrite a newer one's result. */
  const writes = useRef(0);
  /**
   * The newest write the daemon has confirmed, which is **not** the newest issued.
   *
   * ⚠ **The guard was one-sided and the missing half was the destructive one.**
   * Refusing every answer but the newest issued is right for what is *drawn*; it
   * was also applied to `saved`, so with A confirmed and B in flight, A's success
   * advanced nothing — and B's failure then restored the list as it stood *before
   * A*, while the daemon held A. The screen and the store disagreed with no error
   * saying so, and a reload jumped.
   */
  const confirmed = useRef(0);
  /**
   * The writes, one after another.
   *
   * ⚠ **Ordering the *answers* is not ordering the *requests*.** The keyboard emits
   * one write per key and nothing else queued them, so two `PUT`s could reach the
   * daemon out of order — over a relay, on a phone, routinely — and the last one
   * applied would be the one this client believes was superseded, with nothing
   * anywhere reporting a disagreement. `PUT /agent-strip` replaces rather than
   * merges, which makes order the whole of its meaning.
   *
   * A promise chain rather than a lock: each write waits for the one before it to
   * settle, so a refusal does not strand the queue.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setFailure("That machine is not reachable right now.");
      setListing({ agents: [], presets: [], systems: [], stored: [] });
      return;
    }
    let cancelled = false;
    /*
     * All four together, unlike the New session strip, which reads `GET /agents`
     * on its own so the harness tiles can be drawn before the rest arrives. There
     * is nothing to draw early here: the order is a *merge* of two of these reads,
     * so a list rendered from one of them would be an order that rearranges itself
     * a moment later, on the screen whose whole subject is the order.
     */
    void Promise.all([
      daemon.agents(),
      daemon.customAgents(),
      daemon.systems(),
      daemon.agentStrip(),
    ])
      .then(([agents, presets, systems, strip]) => {
        if (cancelled) return;
        setListing({
          agents: agents.agents,
          presets: presets.customAgents,
          systems: systems.systems,
          stored: strip.entries,
        });
        setFailure(null);
        setSupported(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const absent =
          ApiError.isApiError(cause) &&
          cause.status === 404 &&
          cause.code === `http_${cause.status}`;
        setSupported(!absent);
        setListing({ agents: [], presets: [], systems: [], stored: [] });
        setFailure(absent ? null : errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [machineId]);

  /*
   * The merge, once per listing.
   *
   * ⚠ **Into state rather than derived on every render, because this list is
   * edited.** A drag writes an order the daemon has not confirmed yet, and a value
   * recomputed from `listing` would put it straight back. `saved` holds what the
   * daemon did confirm, which is where a refused write returns to.
   */
  useEffect(() => {
    if (listing === null) return;
    const natural = [
      ...listing.agents
        .filter((one) => startsBare(one.id))
        .map((one) => ({ kind: "harness" as const, id: one.id })),
      ...listing.presets.map((one) => ({ kind: "custom" as const, id: one.id })),
    ];
    const next = orderStrip(natural, listing.stored);
    setRows(next);
    saved.current = next;
  }, [listing]);

  /**
   * Write the strip, and put it back if the daemon refuses.
   *
   * ⚠ **The restore target is `saved`, never the list as it was one edit ago.**
   * Several writes can be in flight — the keyboard emits one per key — so undoing
   * just the failed one would leave a list that is neither what somebody asked for
   * nor what is stored. The last confirmed list is the only state both ends agree
   * about, and the sequence guard is what stops an early failure erasing a later
   * success.
   */
  const write = (next: readonly StripRow[]): void => {
    const daemon = store.daemonFor(machineId);
    setRows([...next]);
    if (daemon === undefined) {
      setFailure("That machine is not reachable right now.");
      setRows([...saved.current]);
      return;
    }
    writes.current += 1;
    const mine = writes.current;
    queue.current = queue.current
      .catch(() => undefined)
      .then(() => daemon.saveAgentStrip(stripEntries(next)))
      .then(() => {
        // Any answer that is newer than the newest *confirmed* one advances the
        // restore target, even where a newer write is already in flight: the
        // daemon really does hold this list, and a later failure has to fall back
        // to what is stored rather than to what is on screen.
        if (mine <= confirmed.current) return;
        confirmed.current = mine;
        saved.current = [...next];
        setFailure(null);
      })
      .catch((cause: unknown) => {
        // Only the newest issued write may repaint, so an early refusal cannot
        // undo a later success that is already drawn.
        if (mine !== writes.current) return;
        setFailure(errorText(cause));
        setRows([...saved.current]);
      });
  };

  const remove = (id: string): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setFailure("That machine is not reachable right now.");
      return;
    }
    /*
     * The agent goes first and the strip follows, in that order and never the
     * other way. A strip written without it and then a delete that fails leaves a
     * preset nothing lists and nothing can start; this way round the worst case is
     * an orphan position, which `orderStrip` drops on sight and which the daemon's
     * own `DELETE` has already forgotten.
     */
    void daemon
      .removeCustomAgent(id)
      .then(() => {
        /*
         * ⚠ **And the New session strip is told, through the same channel the
         * builder's own Remove uses.** `StartSheet` holds which tile is chosen
         * across a walk to this screen and back, so removing the tile that is
         * *currently selected* would otherwise leave the selection naming a row
         * the daemon has just dropped. `offeredHere` refuses to draw it, which is
         * the backstop; this is the half that clears it, and the two must not
         * disagree about a row that is gone.
         */
        rememberRemoval(machineId, id);
        /*
         * ⚠ **The restore target loses it too, and that is the half a `write`
         * alone gets wrong.** The `DELETE` has already landed, so an agent removed
         * from the machine is gone whatever the strip write does next — and
         * `write`'s own failure arm repaints from `saved`, which would put the row
         * back with a kebab offering Edit on an id that answers 404.
         */
        saved.current = saved.current.filter((row) => !(row.kind === "custom" && row.id === id));
        // The ref and not the closure's `rows`: see its docblock. A reorder that
        // landed while the DELETE was in flight is somebody's work.
        write(latest.current.filter((row) => !(row.kind === "custom" && row.id === id)));
      })
      .catch((cause: unknown) => setFailure(errorText(cause)));
  };

  if (listing === null) return <Spinner />;

  /**
   * Where a row sits while another one is being dragged over it.
   *
   * The dragged row carries its own transform, written straight to its node. Every
   * row between where it left and where it is going shifts by exactly one row, in
   * the direction that opens the gap under the pointer — which is the whole of
   * what tells "dragged down" from "dragged up" without moving anything else.
   */
  const shiftFor = (index: number): number => {
    if (drag === null || index === drag.from) return 0;
    if (drag.to > drag.from && index > drag.from && index <= drag.to) return -drag.height;
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return drag.height;
    return 0;
  };

  /**
   * Which row a new session opens on, as a key rather than an index.
   *
   * ⚠ **The same call the New session screen makes, and that is the whole reason
   * this is worth marking at all.** A badge naming a different row from the one
   * that actually gets selected is worse than no badge: it is a claim about
   * another screen, made confidently, that the reader has no way to check without
   * going there. So it is {@link defaultRow} over the same merge with the same
   * predicate, and the two can only disagree by somebody editing one of them.
   *
   * ⚠ **This list is wider than that screen's, which is exactly why `startable`
   * is not optional.** Every harness that can *ever* have a tile has a row here —
   * that is the point of the screen — so a signed-out one is routinely first, and
   * so is an assembled agent whose harness was uninstalled. Neither is what a new
   * session opens on. Marking the top row regardless would put **default** on a row
   * whose own subline says `not signed in` two lines under it.
   *
   * A key rather than an index because the row compares itself: an index would be
   * a second thing to keep in step with the `.map` below, and the two going out of
   * step is a badge one row off.
   */
  /*
   * ⚠ **Against the order a drag is *previewing*, not the one that is stored.**
   * Dragging to the top is the gesture this whole screen exists for, and `rows`
   * does not change until the drop — only the transforms move. Read off `rows`, the
   * badge sat on whatever had been pushed down to second place for the length of
   * every such gesture, contradicting a list that was already showing the new order.
   * It is also the only moment this screen gets to *teach* the rule: cross the top
   * row and the badge comes to meet you.
   */
  const previewed = drag === null ? rows : moveRow(rows, drag.from, drag.to);
  const opensOn = defaultRow(previewed, (row) => startableHere(row, listing.agents, listing.presets));
  const opensOnKey = opensOn === null ? null : stripKey(opensOn.kind, opensOn.id);

  return (
    <div>
      <p className="text-xs text-muted">
        What the New session screen offers on this machine, in the order it draws them — the first
        one that can start is the <em>default</em> a new session opens on. Removing one takes its
        tile off that screen and signs nothing out — a built-in agent can be added back here, and
        one you assembled is built again from <em>Add an agent</em>.
      </p>

      {/*
       * ⚠ **One line, always in the layout, never a row that appears.** It carries
       * a read that failed, a write that was refused, or nothing — and reserving
       * the space is what stops the list jumping down the screen the first time a
       * save is refused, at the moment somebody is least able to afford the thing
       * they were aiming at moving.
       */}
      <p role="status" aria-live="polite" className="mt-2 min-h-4 text-2xs text-muted wrap-anywhere">
        {failure ??
          (supported
            ? ""
            : "This machine's daemon is older than this screen. Update it to reorder its agents.")}
      </p>

      {/*
       * ⚠ **Said only when the read succeeded, which is the rule `NewSession`
       * already keeps one screen over: a failed read is not an empty machine.**
       * Every failure arm above sets an empty listing so the spinner leaves, so
       * without this guard a 503, a dead network or a daemon too old to have the
       * route all drew "this machine reports no agents" — and the old-daemon case
       * drew it *beside* the sentence saying the route is missing, which is two
       * answers to one question and only one of them true.
       */}
      {rows.length === 0 && failure === null && supported ? (
        <Empty>This machine reports no agents.</Empty>
      ) : rows.length === 0 ? null : (
        <ul className="mt-1 border-y border-edge">
          {rows.map((row, index) => (
            <StripRowView
              key={stripKey(row.kind, row.id)}
              row={row}
              index={index}
              count={rows.length}
              listing={listing}
              machineId={machineId}
              opensOn={opensOnKey === stripKey(row.kind, row.id)}
              frozen={!supported}
              lifted={drag?.from === index}
              sliding={drag !== null}
              shift={shiftFor(index)}
              onDrag={setDrag}
              onMove={(from, to) => write(moveRow(rows, from, to))}
              onToggle={() =>
                write(rows.map((one, at) => (at === index ? { ...one, hidden: !one.hidden } : one)))
              }
              onRemove={() => remove(row.id)}
            />
          ))}
        </ul>
      )}

      {/*
       * ⚠ **The bar sits outside the list**, which is the shape the plugin machine
       * table settled: always on screen, never scrolled away under a long fleet,
       * and it is the one control here that is not about a row.
       *
       * This is the `+` the New session strip gave up. It was the row's last tile
       * there — a dashed box you scrolled to — and it belongs here for the same
       * reason the ordering does: adding an agent is something you do to the list,
       * not something you do on the way to starting a session.
       *
       * `disabled` rather than absent, with the reserved line above saying why. A
       * control that disappears is one somebody goes looking for.
       */}
      <div className="mt-4">
        <Button disabled={!supported} onClick={() => navigate(agentPath(machineId))}>
          <Icon as={Plus} size={14} />
          Add an agent
        </Button>
      </div>
    </div>
  );
}

/**
 * One row, and the whole of what a row can do.
 *
 * ⚠ **Two controls, both drawn on every row: a handle and a menu.** What varies is
 * inside the menu, and that is the point rather than a compromise — a *row* that
 * loses a control moves every control beside it, and on a list you are dragging
 * that is the one thing that must not happen, while a menu's panel is drawn on
 * demand and displaces nothing. So the harness rows keep a live kebab (they can
 * be hidden, which is the act somebody comes here for) and simply have no Edit or
 * Remove inside it.
 *
 * ⚠ **One removal per row, and it is called the same thing on both kinds.** From
 * the picker's side "hide this harness" and "delete this assembled agent" are one
 * act — *this stops being offered* — and a harness is only an agent whose vendor
 * picked the model. What differs is the cost of undoing it, and the row says so
 * without a dialog: a harness keeps its row, dimmed, offering to put it back, and
 * an assembled agent is deleted, with `danger` on the item carrying that.
 *
 * ⚠ **A removed harness is dimmed in place rather than taken out of this list.**
 * Its position is the thing somebody came here to set, and removing the row would
 * take away the only way to bring it back. What says so is the ground and the ink —
 * `bg-raised/60` under `text-faint` — and not `opacity`, for `index.css`'s reason:
 * opacity composites the whole row including the one line explaining what it is,
 * and this one still has to be read and pressed.
 */
function StripRowView({
  row,
  index,
  count,
  listing,
  machineId,
  opensOn,
  frozen,
  lifted,
  sliding,
  shift,
  onDrag,
  onMove,
  onToggle,
  onRemove,
}: {
  row: StripRow;
  index: number;
  count: number;
  listing: Listing;
  machineId: MachineId;
  /**
   * A new session on this machine opens on this row.
   *
   * ⚠ **Decided one level up and handed down as a boolean, rather than computed
   * from `index === 0` here.** The rule is a property of the *list* — the first
   * row that is neither hidden nor unstartable — and a row cannot see the rows
   * above it. Reading `index === 0` would have been the obvious local answer and it
   * is wrong in both of the states this screen exists to show: a hidden first row
   * and a signed-out first harness.
   */
  opensOn: boolean;
  /** The daemon cannot store an order, so nothing here may pretend to change one. */
  frozen: boolean;
  /** This is the row under the pointer. */
  lifted: boolean;
  /** Some row is being dragged, so the shifts below are worth animating. */
  sliding: boolean;
  /** How far this row moves to open the gap, in pixels. */
  shift: number;
  onDrag: (drag: Drag | null) => void;
  onMove: (from: number, to: number) => void;
  onToggle: () => void;
  onRemove: () => void;
}): ReactNode {
  const node = useRef<HTMLLIElement | null>(null);
  /**
   * The half of the drag that changes every frame.
   *
   * ⚠ **Per-frame work goes to the DOM and per-row work goes to React**, which is
   * `AppShell`'s `RailHandle` rule applied to a list. The offset changes on every
   * pointer event and is written straight onto this node; the *target index*
   * changes once per row crossed and is state one level up, because every other
   * row's shift is a function of it. Offset in state would be a render per frame;
   * target in a ref would leave the neighbours standing still.
   */
  const live = useRef<{ startY: number; height: number; pointerId: number; to: number } | null>(
    null,
  );
  const grip = useRef<HTMLButtonElement | null>(null);

  /*
   * ⚠ **A second, independent reason the browser may not take this gesture for a
   * scroll — and the first one was silently dead for a release.** `touch-none` on
   * the handle is the primary mechanism, and it did nothing at all: `index.css`
   * carried `button { touch-action: manipulation }` *unlayered*, and an unlayered
   * rule beats every `@layer utilities` class regardless of specificity, so the
   * effective value stayed `manipulation` — which still permits panning. The base
   * rule is layered now and the utility wins, but a cascade fault that shipped
   * once can ship again, and this is the guard that does not depend on the
   * cascade at all.
   *
   * ⚠ **`addEventListener` with `{ passive: false }`, because React cannot express
   * it.** React attaches `onTouchMove` passively — the same fact `AgentStrip`'s
   * wheel handler is written out of, one file over — so `preventDefault` from a
   * JSX handler is swallowed and the page scrolls anyway.
   *
   * ⚠ **Registered for the component's life rather than for the gesture's.** Some
   * engines decide whether a touch belongs to the scroller at `touchstart`, from
   * whether a non-passive `touchmove` listener *exists*; one added at
   * `pointerdown` is added after that decision. So it is always there and does
   * nothing unless a drag is live.
   */
  useEffect(() => {
    const handle = grip.current;
    if (handle === null) return;
    const hold = (event: TouchEvent): void => {
      if (live.current === null) return;
      event.preventDefault();
    };
    handle.addEventListener("touchmove", hold, { passive: false });
    return () => handle.removeEventListener("touchmove", hold);
  }, []);

  const harness = row.kind === "harness";
  const preset = harness ? null : (listing.presets.find((one) => one.id === row.id) ?? null);
  const info = harness ? (listing.agents.find((one) => one.id === row.id) ?? null) : null;
  const badge =
    info === null
      ? null
      : agentBadge(agentStance(info.available, info.loggedIn, info.login?.blocked));
  /*
   * Which harness the glyph draws, and it is read off the *listing* rather than
   * cast from the row's id. `orderStrip` only emits rows `natural` holds and every
   * harness entry in `natural` came out of `listing.agents`, so this is never null
   * in practice — but a cast would be this file promising that on behalf of a
   * function two modules away, which is the shape `readCustomAgent` on the daemon
   * exists to refuse. The slot below is a fixed width, so the impossible case
   * costs a gap rather than a row that is narrower than its neighbours.
   */
  const glyph: AgentId | null = harness ? (info?.id ?? null) : (preset?.harness ?? null);
  const name = harness ? agentLabel(row.id) : (preset?.name ?? row.id);
  /*
   * ⚠ **The vendor, and a status only when there is a fault to report.**
   *
   * It was `agentBadge`'s word unconditionally, which on a machine where
   * everything is signed in printed `signed in` under every built-in row — a fact
   * true of all of them, which is the same noise the strip's own tiles were
   * reported for. What belongs here is the fact the assembled rows already carry:
   * which system serves the model.
   *
   * The badge is **not** dropped, because this list is deliberately wider than the
   * strip: a harness that is not installed or not signed in has no tile and does
   * have a row, and that is the whole reason it is listed. So a fault displaces
   * the vendor — `agentBadge` answers `null` for `no_login` and a plain tone for
   * the two states that are not faults, and only a `strong` one is worth the line.
   */
  const under = harness
    ? badge?.tone === "strong"
      ? badge.text
      : harnessSubline(row.id, listing.systems)
    : preset === null
      ? ""
      : customAgentSubline(preset, listing.systems);

  const start = (event: PointerEvent<HTMLButtonElement>): void => {
    const box = node.current;
    if (box === null || frozen) return;
    // `setPointerCapture` on the handle rather than listeners on `window`, which is
    // `RailHandle`'s rule: the gesture belongs to the control it started on, and
    // the capture survives the pointer leaving the row — which it does at once,
    // since the row is what is moving.
    event.currentTarget.setPointerCapture(event.pointerId);
    live.current = {
      startY: event.clientY,
      height: box.offsetHeight,
      pointerId: event.pointerId,
      to: index,
    };
    onDrag({ from: index, to: index, height: box.offsetHeight });
  };

  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const going = live.current;
    const box = node.current;
    if (going === null || box === null || going.pointerId !== event.pointerId) return;
    const offset = event.clientY - going.startY;
    box.style.transform = `translateY(${offset}px)`;
    const next = dropIndex(index, offset, going.height, count);
    if (next === going.to) return;
    going.to = next;
    onDrag({ from: index, to: next, height: going.height });
  };

  const end = (event: PointerEvent<HTMLButtonElement>): void => {
    const going = live.current;
    if (going === null || going.pointerId !== event.pointerId) return;
    live.current = null;
    if (node.current !== null) node.current.style.transform = "";
    onDrag(null);
    if (going.to !== index) onMove(index, going.to);
  };

  return (
    <li
      ref={node}
      /*
       * The neighbours' shift is a style rather than a class because it is a
       * measured pixel count rather than one of a set of positions — and it is the
       * only inline style here, since the dragged row's own offset never goes
       * through React at all.
       */
      style={shift === 0 ? undefined : { transform: `translateY(${shift}px)` }}
      /*
       * ⚠ **The transition is on only while a drag is live, and taking it off at
       * the drop is the point.** Clearing the transform and reordering the keyed
       * children happen in one commit, and a transition takes its start value from
       * the last style recalc — so the row would animate `translateY(±h) → none`
       * over a layout that has *already* moved by ∓h, overshooting by a full row
       * and sliding back on every drop. With the class gone in that same commit
       * there is nothing to interpolate.
       */
      /*
       * ⚠ **The row being dragged is never transitioned, and that was the whole of
       * "it moves very unsmoothly".** Its transform is written on every pointer
       * event; with a 150ms `transition-transform` on it, each write started a new
       * interpolation from wherever the last one had got to, so the row crawled
       * after the finger instead of following it. Only the *neighbours* are
       * animated, and only while a drag is live.
       *
       * ⚠ **And it comes off at the drop for a second reason.** Clearing the
       * transform and reordering the keyed children happen in one commit, and a
       * transition takes its start value from the last style recalc — so a row left
       * with the class would animate `translateY(±h) → none` over a layout that has
       * *already* moved by ∓h, overshooting a full row and sliding back.
       *
       * ⚠ **`bg-surface` on the lifted row rather than `bg-raised`.** These rows
       * have no ground of their own; a lifted one has to have one or the rows it
       * passes over show through it. `raised` reads as *switched off* here, which
       * is what a hidden row uses it for.
       *
       * ⚠ **`will-change-transform` only while lifted.** This is the node written
       * to on every pointer event, and promoting it for the length of the gesture
       * is the difference between compositing a layer and re-painting a row of
       * text per frame — most of what is left of "it moves very unsmoothly" on a
       * phone. It is deliberately not permanent: `will-change` on every row of
       * every list is a layer per row, held for as long as the screen is open.
       *
       * `select-none` while any drag is live, so dragging past a neighbour does
       * not paint a text selection across the list on the way.
       */
      className={`border-b border-edge last:border-b-0 ${sliding ? "select-none" : ""} ${
        sliding && !lifted ? "transition-transform" : ""
      } ${
        lifted
          ? "relative z-10 bg-surface shadow-lg will-change-transform"
          : row.hidden
            ? "bg-raised/60"
            : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-1">
        {/*
         * ⚠ **The handle is the drag target *and* the keyboard one**, rather than a
         * drag with a menu bolted beside it for people who cannot drag. A pointer
         * gesture that is the only way to reorder is a control a keyboard cannot
         * reach at all, and this app has no other reordering anywhere to borrow an
         * answer from.
         *
         * `touch-none` is load-bearing on a phone. Without it the browser claims
         * the vertical gesture for scrolling before `pointermove` is ever
         * delivered, and the row simply does not move.
         */}
        <button
          ref={grip}
          type="button"
          aria-label={`Move ${name}`}
          disabled={frozen}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          /*
           * ⚠ **A capture can be lost without a `pointerup`** — a phone taking the
           * gesture back, a window losing focus mid-drag — and without this the row
           * stays lifted with a transform on it and no way to put it down. Ending
           * on the same handler is right: `end` reads the target index the moves
           * have already agreed on, which is where the row was last drawn.
           */
          onLostPointerCapture={end}
          onKeyDown={(event) => {
            const to =
              event.key === "ArrowUp"
                ? index - 1
                : event.key === "ArrowDown"
                  ? index + 1
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? count - 1
                      : null;
            if (to === null) return;
            // Before the bounds test, so the page never scrolls under an arrow key
            // aimed at a row that is already at the end of the list.
            event.preventDefault();
            if (to !== index && to >= 0 && to < count) onMove(index, to);
          }}
          /*
           * ⚠ **44px square, and `press` is gone from it.** At `w-8` this was a
           * 32px strip at the left edge of a row inside a sheet that scrolls: miss
           * it on a phone and the sheet moves instead, which is what "impossible to
           * drag" is. `.press` went with the width — it puts
           * `transform: scale(0.97)` on the button for as long as it is `:active`,
           * which on a drag is the entire gesture, and a control that shrinks under
           * the finger and stays shrunk reads as broken.
           *
           * `touch-none` is the other half of the phone fix and it is not enough on
           * its own — see the icon below.
           */
          className="tap inline-flex size-11 shrink-0 touch-none items-center justify-center rounded-md text-faint select-none hover:bg-raised hover:text-fg disabled:pointer-events-none"
        >
          {/*
           * ⚠ **Inert, so the pointer always lands on the button.** `touch-action`
           * is not inherited: a touch that starts on this `<svg>` is decided by the
           * svg's own value first, and the engines differ on how far up they walk
           * before they have committed the gesture to a scroll. `pointer-events:
           * none` removes the question — the hit target is the button, which is the
           * element carrying `touch-none`.
           */}
          <Icon as={GripVertical} size={18} className="pointer-events-none" />
        </button>

        <span
          className={`inline-flex w-5 shrink-0 justify-center ${
            row.hidden ? "text-faint" : "text-muted"
          }`}
        >
          {glyph === null ? null : <AgentGlyph agent={glyph} size={18} />}
        </span>

        <span className="min-w-0 flex-1 py-2.5 pl-1">
          {/*
           * ⚠ **The line's height is pinned to the name's own line box, so nothing
           * put on it can change the row's.** `Badge` is `leading-tight`, a
           * *ratio*, while every other line here is a fixed `rem` off the type
           * scale — so a browser with a minimum font size (Chrome's font settings,
           * Safari's "never use font sizes smaller than") floors the badge's font
           * and its line box grows with it while the name's does not. Measured at
           * `minimumFontSize=16`: the badge goes to 24px against a name still in a
           * 22px box, and only the row carrying it grows. On a list where a drag
           * measures **one** row and applies that number to every neighbour, a
           * single taller row is an arithmetic error per row crossed rather than a
           * cosmetic one. Pinned here rather than fixed in `Badge`, because the
           * invariant belongs to this row: fifteen other call sites want a badge
           * that grows with the text.
           */}
          <span className="flex h-[var(--text-sm--line-height)] items-center gap-1.5">
            {/* ⚠ **Down to `faint`, where this went only as far as `muted`.** A row
                whose ground has also gone to `raised/60` needs its ink to move with
                it or the two disagree about whether anything happened — and the
                report was that a hidden agent did not *look* hidden. `faint` is
                6.23:1 on surface, so it is still a name somebody reads and presses;
                this is a row that is switched off, not one that refuses. */}
            {/* ⚠ **`font-medium`, and it arrived with the badge.** `Badge`'s `strong`
                tone is `font-semibold`, so a name at the default 400 put the loudest
                ink in the row on the *annotation* rather than on the thing being
                annotated. It is also what ten of the eleven list rows under
                `ui/settings` already use — `MachinesSection` and `UsersSection`, the
                two that draw a badge beside a name, both do. Costs no layout: the
                line-height is a fixed rem whatever the weight, and the name
                truncates. */}
            <span
              className={`min-w-0 truncate text-sm font-medium ${row.hidden ? "text-faint" : "text-fg"}`}
            >
              {name}
            </span>
            {/*
             * ⚠ **It costs no height, which on this list is a correctness property
             * rather than a nicety.** The drag measures **one** row at `pointerdown`
             * and applies that single number to every neighbour's shift, so a row
             * that is taller than the rest makes every step of a drag past it wrong.
             * `Badge` is `text-2xs leading-tight` with `py-0.5` — 15 + 2 + 2 = 19px
             * against the name's 22px line box — so the flex line is the name's
             * either way and the row's content box stays 60px whether this is drawn
             * or not. (`offsetHeight`, the number the drag actually reads, is 61 on
             * every row but the last, because the `<li>` carries `border-b`.) That
             * is also the standing rule for this screen: nothing appears that moves
             * anything else.
             *
             * ⚠ **`strong`, which is `Badge`'s own word for "this one is not like
             * the others".** Exactly one row in the list can carry it, which is the
             * condition that tone exists for — and it is deliberately not a border
             * or a fill, because a third box inside a row already bounded reads as
             * something to press, and this is a statement rather than a control.
             *
             * ⚠ **The word is the one the sentence above the list uses.** A badge
             * reading `starts by default` beside prose saying `default` is two names
             * for one thing, and the reader has to work out that they are the same.
             */}
            {opensOn && <Badge tone="strong">default</Badge>}
          </span>
          {/* Reserved rather than conditional, for the reason the tiles' own
              subline is: two kinds of row side by side with a different number of
              lines is a list whose rows are different heights, and a drag measures
              one row and applies it to all of them. */}
          <span className="block min-h-[var(--text-2xs--line-height)] truncate text-2xs text-faint">
            {under}
          </span>
        </span>

        {/*
         * ⚠ **One menu, and it holds everything this row can do.** The visibility
         * toggle was a second icon button beside this one, which is two targets
         * 4px apart at the end of a row you also drag — and it made the row three
         * controls wide on a phone. `web-shell.md`'s rule is already that
         * "everything else a settings row can do sits behind one kebab"; the
         * toggle is *else*.
         *
         * ⚠ **And it is never disabled, which is the other half of that move.** It
         * held only Edit and Remove, so a built-in harness had nothing behind it
         * and was drawn switched off. Hiding is something every row can do — that
         * is the whole point of hiding a *harness* — so the menu always has at
         * least one item, and `frozen` (a daemon that cannot store an order at
         * all) is the only thing that takes it away.
         */}
        <Menu
          align="right"
          panelClassName="w-56"
          trigger={(open, toggle) => (
            <IconButton
              icon={MoreHorizontal}
              label={`More for ${name}`}
              // `lg` where this was `sm`: 44px of ink against 24, on the one control
              // that now carries every act on the row. `sm`'s own docblock says it
              // exists to keep a kebab from outweighing the row it sits on — that is
              // an argument about a row you *navigate*, and this is a row you drag,
              // hide and delete from. It is also the size the plugin machine table
              // already settled on for a row's icons, and the only one of the four
              // that reaches the 44px floor without a pseudo-element: `md` is 36px
              // with no growth mechanism at all, which `webcheck` ratchets against.
              size="lg"
              active={open}
              disabled={frozen}
              onClick={toggle}
            />
          )}
        >
          {(close) => (
            <>
              {/*
               * ⚠ **On every row, and it was absent on the built-in ones.** The
               * argument for leaving it off was that a harness has nothing stored
               * to edit — true, and the wrong conclusion. What this list holds is
               * *agents*, and a built-in one is not a different kind of thing; it
               * is the one that exists by default. Leaving it a row with fewer
               * verbs than its neighbours is precisely what made it look special.
               *
               * ⚠ **So "edit" means what it can mean here: start from it.** There
               * is no row to `PATCH`, so this opens the builder already pointed at
               * the harness — `…/from/:harness` — and saving assembles an agent.
               * The default row stays where it is; somebody who wanted theirs
               * *instead* has Remove one item down, in the same menu.
               */}
              <RowAction
                label="Edit"
                onClick={() => {
                  close();
                  navigate(
                    harness
                      ? agentFromHarnessPath(machineId, row.id)
                      : agentEditPath(machineId, row.id),
                  );
                }}
              />
              {/*
               * ⚠ **One removal per row, called the same thing and *drawn* the same
               * way on both kinds.** A built-in row had "Hide from New session" and
               * an assembled one had that plus "Remove agent" — two removals on one
               * row, and a harness that could only be hidden while everything beside
               * it could be removed. The distinction was the app's rather than
               * anybody else's: from the picker's side both acts are "this stops
               * being offered", and a built-in agent is just the one that is there
               * by default.
               *
               * ⚠ **No `danger`, and dropping it was the last thing that gave the
               * two kinds away.** It was on the assembled arm alone, to carry that
               * one is `DELETE /custom-agents/:id` while the other is a flag — and
               * that is exactly the internal difference this screen is not supposed
               * to have an opinion about. It was also overclaiming on its own
               * terms: `danger` is for an act nothing brings back, and this one is
               * rebuildable from the bar at the foot of this very screen, which is
               * the same reason it has no confirmation.
               *
               * What still differs is what the row *does* afterwards, and that is
               * unavoidable rather than a signal: a built-in stays, dimmed, with
               * `Add back`, because a flag is all there is to undo; an assembled one
               * has no row left to dim.
               *
               * ⚠ **No two-tap confirmation, which reverses the settings-row rule
               * on purpose.** That rule exists for acts nothing brings back —
               * retiring a machine, deleting a person, uninstalling a plugin with
               * its data. A confirmation on a reversible act is a tax on the act
               * somebody performs most.
               */}
              <RowAction
                label={row.hidden ? "Add back" : "Remove"}
                onClick={() => {
                  close();
                  if (harness) onToggle();
                  else onRemove();
                }}
              />
            </>
          )}
        </Menu>
      </div>
    </li>
  );
}
