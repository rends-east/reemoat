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
import { daemonRead } from "../../machine";
import { agentEditPath, agentFromHarnessPath, agentPath, navigate } from "../../router";
import { settingsPath } from "../../settings";
import { store, type AppState } from "../../store";
import type { AgentId, AgentInfo, AgentStripEntry, CustomAgent, SystemInfo } from "../../wire";
import { agentBadge, agentStance, harnessName, startsBare } from "../agentCard";
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

/**
 * How close to a scroller's edge the pointer has to get before the list follows
 * it.
 *
 * ⚠ **Without this the drag was a control a phone could not finish.** `dropIndex`
 * clamps the target to the rows that exist and `move()` writes a transform —
 * nothing scrolled the pane the list is inside. Rows are 61px and the sheet's body
 * is 92dvh less a head, this screen's prose and its status line, so with ten
 * agents on a 390px phone the bottom row's journey to the top is a drag into a
 * region the finger cannot reach: the row travels, the list does not. The keyboard
 * path worked and was the only one that did, which is backwards for an app whose
 * whole shape is a phone.
 *
 * 60px is roughly a finger's width inside the edge, so the zone is reachable
 * without being somewhere a normal drag lands by accident: the rows are 61px, so
 * it is about one row deep at each end.
 */
const SCROLL_EDGE = 60;

/**
 * The fastest the list travels under a held finger, in pixels per frame.
 *
 * 14 is ~840px/s at 60Hz — a little over one phone screen per second, which is
 * fast enough to cross a twenty-row list without being a scroll nobody can stop
 * inside. It is a *ceiling*: {@link driftFor} ramps from nothing at the edge of the
 * zone to this at the boundary itself, so how fast the list moves is how far in
 * the finger has pushed, which is the only control there is over it.
 */
const SCROLL_MAX = 14;

/**
 * How fast the list should travel, given where the pointer is over it.
 *
 * Signed: negative walks the list towards its start. Zero everywhere but the two
 * bands, so a drag in the middle of the pane costs nothing at all.
 *
 * ⚠ **Clamped at the boundary rather than falling off it.** A finger dragged
 * *past* the top of the scroller reports a negative depth, which without the
 * `Math.max` would accelerate without limit — and past the pane's edge is exactly
 * where somebody puts their thumb when the row will not go any further.
 */
function driftFor(box: DOMRect, y: number): number {
  const above = y - box.top;
  const below = box.bottom - y;
  if (above < SCROLL_EDGE) return -Math.ceil(((SCROLL_EDGE - Math.max(above, 0)) / SCROLL_EDGE) * SCROLL_MAX);
  if (below < SCROLL_EDGE) return Math.ceil(((SCROLL_EDGE - Math.max(below, 0)) / SCROLL_EDGE) * SCROLL_MAX);
  return 0;
}

/**
 * The box this list actually scrolls inside, or `null` if nothing does.
 *
 * ⚠ **Walked at `pointerdown` rather than named**, because this component is drawn
 * in two places that scroll differently: the settings sheet's own body
 * (`overflow-y-auto overscroll-contain`) and, at `sm` and above, the same body
 * beside a rail. A selector or a ref threaded down from `Settings.tsx` would be
 * this file knowing the shape of a screen two components up, and it would be wrong
 * the first time this list is drawn anywhere else.
 *
 * The `scrollHeight > clientHeight` test is what stops it settling on an ancestor
 * that is *declared* scrollable and has nothing to scroll — which is every one of
 * `SHEET_BODY`'s wrappers on a list short enough to fit.
 */
function nearestScroller(from: HTMLElement): HTMLElement | null {
  for (let box = from.parentElement; box !== null; box = box.parentElement) {
    const flow = getComputedStyle(box).overflowY;
    if ((flow === "auto" || flow === "scroll") && box.scrollHeight > box.clientHeight) return box;
  }
  return null;
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
    /*
     * A stale link, or a machine revoked in another tab.
     *
     * ⚠ **The chevron does not walk you out of this, and the comment here used to
     * say it did.** `settingsUp` sends this screen's ◀ to
     * `/settings/machines/<id>` — the machine's own screen — which for a machine
     * that is gone draws this same sentence again: two identical dead ends in a
     * row, the second reached by taking the only visible way back. So the way out
     * is here, and it is the list, the first address on this path that still
     * resolves. `replace`, because it is shallower and because the address it
     * leaves names nothing. (Still not the ✕ — that is `useUnder` and leaves
     * settings entirely.)
     *
     * ⚠ **Not `failed`.** A machine that is not in your list is a settled answer,
     * not a read that did not come back; `Empty` reserves the triangle and the
     * live region for the second.
     */
    return (
      <Empty
        action={
          <Button size="sm" onClick={() => navigate(settingsPath("machines"), true)}>
            All machines
          </Button>
        }
      >
        That machine is not in your list any more.
      </Empty>
    );
  }

  /*
   * ⚠ **Three answers rather than two, and the one that was missing is the one
   * this screen is usually drawn in.** `daemonReadable` answers `false` for
   * `unknown` — never asked — so a cold load or a deep link to
   * `/settings/machines/:id/agents` claimed the host had failed to answer for the
   * two or three seconds before the first probe returned, and `reachText`'s
   * `unknown` arm put a bare ellipsis where the reason goes. `daemonRead` is the
   * partition; `probing` stays readable, for the reason `daemonReadable`'s own
   * docblock gives.
   */
  const read = daemonRead(machine.reach);

  if (read === "asking") {
    /*
     * A wait, drawn as one: no `failed`, no `role="status"`, no remedy. Nothing has
     * been measured yet, so there is nothing to claim and nothing to retry — and
     * announcing "not reachable" here would be a live region contradicted by the
     * list a second later. The spinner is `SystemChooser`'s "Asking that machine…"
     * shape, so the two reads of one daemon look like the same wait.
     */
    return (
      <Empty>
        <span className="inline-flex items-center gap-2">
          <Spinner /> Checking whether {machine.name} is reachable…
        </span>
      </Empty>
    );
  }

  if (read === "unreachable") {
    // Named rather than silently empty, for `MachineSystemsSection`'s reason: an
    // unreachable machine is one of the commonest reasons to be on a settings
    // screen, so the honest thing is to say which machine and why it is blank.
    // `failed`, because this arm really is the absence of an answer — the probe
    // was made and nothing came back. The trailing "so what it offers cannot be
    // read or reordered" was cut on 2026-09-04 for fewer words; the machine's
    // name and `reachText`'s reason are what was kept.
    return (
      <Empty failed>
        {machine.name} is not reachable right now —{" "}
        {reachText(machine.reach, machine.offlineReason)}.
      </Empty>
    );
  }

  return (
    <div>
      {/*
       * ⚠ **The machine is named here, and it was named nowhere on this screen
       * that was not a failure.** The pane's heading is the constant "Agents" and
       * the chevron says "Back to Machine settings" — both deliberately, since a
       * heading restating the row you came through is the chrome saying what the
       * body says — so the only place the host appeared was inside the two guard
       * branches above, which is to say only when something was wrong. This app
       * supports two machines with the same name on purpose (`ambiguousNames`) and
       * `web-shell.md` requires a row to carry its id for exactly that reason, so
       * the sentence carries both: the name is what somebody recognises and the id
       * is what tells two of them apart.
       *
       * Drawn here rather than inside `StripEditor` because this is the component
       * that has the machine — and because the guards above it are the states in
       * which it would be a promise about a list that is not there. Cut to the
       * screen-line cap (13 words, the id not counted): the name, the id, and the
       * one rule the `default` badge below needs a reader to know. What removing
       * costs is said where it is decided — on the row's own confirmation for an
       * assembled agent, and by `Add back` staying on a hidden harness.
       */}
      <p className="text-xs text-muted">
        What New session offers on {machine.name} (
        <code className="text-muted/80">{machine.id}</code>). The first that can start is the{" "}
        <em>default</em>.
      </p>
      <StripEditor key={machineId} machineId={machineId} />
    </div>
  );
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
  /**
   * What a write on this screen answered, or `null`.
   *
   * ⚠ **Kept apart from {@link readFailure}, because only one of the two has a
   * remedy that is not already on screen** — `AgentBuilder`'s split, for its
   * reason. A refused reorder is re-run by doing it again, and the list is right
   * there; a refused *read* is re-run by nothing at all, since the effect's only
   * dependency is the machine, so a `GET /agents` that timed out stayed timed out
   * until the pop-up was closed. Folded into one slot the two are
   * indistinguishable, and a `Try again` under a failed `PUT` would offer to
   * re-read the listing about something that has nothing to do with it. They meet
   * again in `failure` below, which is the one line that draws either.
   */
  const [writeFailure, setWriteFailure] = useState<string | null>(null);
  /** What the listing read answered, or `null` while it is pending and once it has landed. */
  const [readFailure, setReadFailure] = useState<string | null>(null);
  /**
   * Bumped by `Try again`, and in the read effect's dependency list so that it
   * re-runs it.
   *
   * A counter rather than a function that re-requests, which is `AgentBuilder`'s
   * argument verbatim: the request is written once, in the effect, together with
   * the `cancelled` flag that belongs to it, and a second copy on a button is a
   * second place to forget it and let a stale answer overwrite a newer one.
   */
  const [attempt, setAttempt] = useState(0);
  /**
   * The row a write is in flight about, as a {@link stripKey}, or `null`.
   *
   * ⚠ **A drag used to settle and then silently jump back.** `write` repaints
   * optimistically and restores `saved` when the daemon refuses, and the refusal
   * landed in the reserved line below in `text-2xs text-muted` — the same ink and
   * the same size as the informational "this daemon is older than this screen"
   * notice sharing that element (reworded 2026-09-04 to "too old to reorder
   * agents — update it"; still the same element). So on a phone over a relay the row moved, and
   * 800ms later it moved back, with the only account of why sitting in the
   * quietest type on the screen. This is the other half of that fix: the row that
   * is not settled yet says so while the `PUT` is out.
   *
   * One key rather than a set: several writes can be in flight — the keyboard
   * emits one per key — and the one worth marking is the newest, which is the only
   * one that still describes what somebody just did.
   */
  const [pending, setPending] = useState<string | null>(null);
  /**
   * What a keyboard move just did, for a reader who cannot see the list.
   *
   * ⚠ **Its own region, and not the visible line below.** That one is reserved
   * for failures and for the old-daemon notice, and a position announcement is
   * neither: it is true for a moment, it is already on screen for anybody who can
   * see the rows, and putting it there would leave "moved to position 3 of 7"
   * sitting under the list until the next event. A pointer drag needs none of
   * this — the row is under the finger — so only the keyboard path writes here.
   */
  const [moved, setMoved] = useState("");
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
      setReadFailure("That machine is not reachable right now.");
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
        setReadFailure(null);
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
        setReadFailure(absent ? null : errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, attempt]);

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
        .filter((one) => startsBare(one))
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
  const write = (
    next: readonly StripRow[],
    /**
     * The row this write is *about*, as a {@link stripKey}, or `null` where no one
     * row is — a removal takes its row with it, so there is nothing left to mark.
     */
    about: string | null = null,
  ): void => {
    const daemon = store.daemonFor(machineId);
    setRows([...next]);
    if (daemon === undefined) {
      setWriteFailure("That machine is not reachable right now.");
      setRows([...saved.current]);
      return;
    }
    setPending(about);
    writes.current += 1;
    const mine = writes.current;
    queue.current = queue.current
      .catch(() => undefined)
      .then(() => daemon.saveAgentStrip(stripEntries(next)))
      .then(() => {
        // The mark comes off on the newest *issued* write settling, which is the
        // same question `setRows` below asks and a different one from the
        // `confirmed` guard under it: an older answer landing must not un-mark a
        // row a newer write is still out for. Before the guard, because that one
        // returns early.
        if (mine === writes.current) setPending(null);
        // Any answer that is newer than the newest *confirmed* one advances the
        // restore target, even where a newer write is already in flight: the
        // daemon really does hold this list, and a later failure has to fall back
        // to what is stored rather than to what is on screen.
        if (mine <= confirmed.current) return;
        confirmed.current = mine;
        saved.current = [...next];
        /*
         * ⚠ **The merge effect keys on the whole `listing`, so `stored` has to move
         * with the write or any later `setListing` reverts the screen.**
         * `listing.stored` was written once at load and never again: `recheck` mints
         * a fresh `listing` object to patch one agent's status, the `[listing]`
         * effect re-ran `orderStrip` against the *mount-time* order, and every
         * reorder and hide made since load was silently undone — with no write
         * issued, so the daemon kept the arranged order and the New session strip
         * went on drawing it. `saved.current` was overwritten with the stale order
         * too, so the next refused write restored to it as well.
         *
         * Advanced here rather than in the effect, and only past the `confirmed`
         * guard above: this is the point at which the daemon is known to hold
         * exactly `next`, which is what `stored` is supposed to mean. The round trip
         * is stable — `orderStrip(natural, stripEntries(next))` is `next` — so the
         * effect this re-runs repaints the same rows rather than moving anything.
         */
        setListing((held) => (held === null ? held : { ...held, stored: stripEntries(next) }));
        setWriteFailure(null);
      })
      .catch((cause: unknown) => {
        // Only the newest issued write may repaint, so an early refusal cannot
        // undo a later success that is already drawn.
        if (mine !== writes.current) return;
        setPending(null);
        setWriteFailure(errorText(cause));
        setRows([...saved.current]);
      });
  };

  /** Ask the daemon for the listing again. See {@link attempt}. */
  const retryReads = (): void => setAttempt((one) => one + 1);

  /**
   * Ask a harness again, after somebody has fixed it off-screen.
   *
   * ⚠ **This is what the New session strip owes for taking a tile away.** A
   * harness that refused to start has no tile — `offersStripTile` — and this list
   * is deliberately wider, so the row is here and the badge says *would not
   * start*. But the commonest remedy for a harness with no sign-in wizard is to
   * run its own program once on the machine itself, and nothing about that
   * reaches the daemon: without this control the only way back is to wait for the
   * refusal to age out.
   *
   * ⚠ **The row the route answers is what lands, and re-reading the whole listing
   * instead would silently undo a drag.** `attempt` is `Try again`'s counter and
   * it re-fetches `GET /agent-strip` with it — which is drawn optimistically and
   * may have a `PUT` in the air, so the merge effect below would put the
   * pre-write order back under a finger that had just moved a row. That button
   * can afford it because it is only drawn when the *read* failed, where nothing
   * is in flight. This is not, so it patches the one agent it asked about and
   * leaves the order alone. It is also what makes the route's `info` load-bearing
   * rather than decorative.
   *
   * The fallback is the counter, for the one answer that carries no row: a
   * harness the machine no longer offers at all, where a full re-read is exactly
   * the right thing.
   */
  const recheck = (id: string): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setWriteFailure("That machine is not reachable right now.");
      return;
    }
    void daemon
      .recheckAgent(id)
      .then((answer) => {
        setWriteFailure(null);
        const fresh = answer.info ?? null;
        if (fresh === null) {
          setAttempt((one) => one + 1);
          return;
        }
        setListing((held) =>
          held === null
            ? held
            : { ...held, agents: held.agents.map((one) => (one.id === fresh.id ? fresh : one)) },
        );
      })
      .catch((cause: unknown) => setWriteFailure(errorText(cause)));
  };

  const remove = (id: string): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setWriteFailure("That machine is not reachable right now.");
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
        /*
         * ⚠ **And out of the listing, or one `Check again` brings it back.** The
         * merge effect rebuilds `natural` from `listing.presets`, so a preset left
         * there after its `DELETE` succeeded reappears the next time anything mints
         * a fresh `listing` — with a live Edit kebab on an id that answers 404,
         * which is the row the comment above this block says must never be drawn.
         */
        setListing((held) =>
          held === null ? held : { ...held, presets: held.presets.filter((one) => one.id !== id) },
        );
        // The ref and not the closure's `rows`: see its docblock. A reorder that
        // landed while the DELETE was in flight is somebody's work.
        write(latest.current.filter((row) => !(row.kind === "custom" && row.id === id)));
      })
      .catch((cause: unknown) => setWriteFailure(errorText(cause)));
  };

  /**
   * The one sentence the status line draws, whichever half produced it.
   *
   * ⚠ **The write outranks the read**, `AgentBuilder`'s rule for the same pair: a
   * request that was made and failed is newer than one this screen has stopped
   * trying. Spelled as one value so the `rows.length === 0` arm below keeps asking
   * a single question — "did anything fail?" — rather than growing a second
   * operand somebody has to remember to add to.
   */
  const failure = writeFailure ?? readFailure;
  const statusText =
    failure ?? (supported ? "" : "This machine's daemon is too old to reorder agents — update it.");
  /**
   * The status line's node, for the one scroll it is allowed — see its JSX.
   *
   * ⚠ **Above the `listing === null` return**, like every hook in this function:
   * a hook under an early return is a different hook count per render, and the
   * spinner arm is the render this screen opens on.
   */
  const statusLine = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    /*
     * Only a *failure* earns the scroll. The old-daemon notice is text on the
     * first paint, and scrolling to it would open the strip on an old daemon at
     * the foot of the list before anybody has touched it; a write failure is
     * what somebody needs to see under a long list after a drag.
     */
    if (failure === null) return;
    statusLine.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);

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
              pending={pending === stripKey(row.kind, row.id)}
              frozen={!supported}
              lifted={drag?.from === index}
              sliding={drag !== null}
              shift={shiftFor(index)}
              onDrag={setDrag}
              onMove={(from, to) => write(moveRow(rows, from, to), stripKey(row.kind, row.id))}
              onToggle={() =>
                write(
                  rows.map((one, at) => (at === index ? { ...one, hidden: !one.hidden } : one)),
                  stripKey(row.kind, row.id),
                )
              }
              onAnnounce={setMoved}
              onRecheck={(agent) => recheck(agent)}
              onRemove={() => remove(row.id)}
            />
          ))}
        </ul>
      )}

      {/*
       * ⚠ **Under the list, and zero height until it has something to say** (13A).
       * It carries a read that failed, a write that was refused, or the old-daemon
       * notice. It sat *above* the list with two lines reserved, so that a refused
       * save could not push the rows down under a finger — and the reserve was
       * two blank lines on every healthy machine, on the screen's first paint,
       * between the lede and the list it introduces. Both halves of that trade are
       * kept by moving it: below the rows, a sentence appearing moves only the
       * `Add an agent` bar, which nobody is mid-gesture on; and an empty `<p>` has
       * no line box, so it costs nothing until it speaks. The `mt-2` rides the
       * text rather than the element for the same reason — a margin on an empty
       * block is still a margin.
       *
       * ⚠ **Mounted always, text swapping.** A `role="status"` inserted in the
       * same paint as its content is commonly not spoken at all (`Sheet`'s
       * measurement, VoiceOver on iOS included), so the region is here on every
       * render and only its text changes.
       *
       * ⚠ **Scrolled into view once, when it gains text.** On a long list the foot
       * of the screen is below the fold, which is exactly where a refused write's
       * only account would now sit. `block: "nearest"` moves the pane the least
       * amount that shows the line — never the rows a finger is over, which are
       * already on screen by definition.
       *
       * ⚠ **`text-danger` when it is a failure, and it used to be `text-muted`
       * either way.** A refused save and an informational notice about an old
       * daemon shared one element, one size and one colour — so a drag that
       * settled and then jumped back 800ms later was accounted for in the quietest
       * ink on the screen, indistinguishable from a caption. `index.css` allows a
       * non-control use of this token where a second look does not repair the
       * thing, and this is the narrower case that has always been allowed: it is
       * the only report a write gets, and the list has already moved back under it.
       */}
      <p
        ref={statusLine}
        role="status"
        aria-live="polite"
        className={`text-2xs wrap-anywhere ${statusText === "" ? "" : "mt-2"} ${
          failure === null ? "text-muted" : "text-danger"
        }`}
      >
        {statusText}
      </p>
      {/*
       * ⚠ **The one remedy that is not already on screen** — `AgentBuilder`'s
       * argument, one pop-up over. A refused write is re-run by doing the thing
       * again, and the list it was about is right there; a refused *read* is re-run
       * by nothing, because the effect's dependencies are the machine and this
       * counter. Drawn only while the sentence above it **is** that read: `failure`
       * prefers the write, so a `Try again` under a refused reorder would offer to
       * re-list the agents about something else entirely.
       *
       * Every arm that sets `readFailure` also sets an empty listing, so the only
       * thing this button can displace is the `Add an agent` bar below it.
       */}
      {writeFailure === null && readFailure !== null && (
        <Button size="sm" className="mt-1" onClick={retryReads}>
          Try again
        </Button>
      )}
      {/*
       * ⚠ **What a keyboard move did, and it was announced nowhere.** The handle
       * answers `ArrowUp`/`ArrowDown`/`Home`/`End` precisely so a reorder is not a
       * gesture only a pointer can make — and the reordering then happened in
       * total silence, since the only live region on this screen reports failures.
       * A pointer drag needs nothing here: the row is under the finger.
       *
       * Mounted with the screen and only its text swapping, which is the one
       * arrangement that reliably announces — `Sheet`, `EventList` and the
       * builder's search box all record the same measurement. `sr-only` is
       * `absolute`, so it takes no layout.
       */}
      <p role="status" aria-live="polite" className="sr-only">
        {moved}
      </p>

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
  pending,
  frozen,
  lifted,
  sliding,
  shift,
  onDrag,
  onMove,
  onToggle,
  onAnnounce,
  onRecheck,
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
  /**
   * A write about this row is out and the daemon has not answered.
   *
   * ⚠ **The list is drawn optimistically and has to say so.** `write` repaints
   * before the `PUT` and puts the last confirmed order back if it is refused, so
   * without this a drag settles and then jumps back a round trip later with
   * nothing on the row that moved having ever looked unsettled.
   */
  pending: boolean;
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
  /**
   * Say out loud what a keyboard move just did.
   *
   * ⚠ **Its own prop rather than a flag on {@link onMove}, because it is not about
   * the same thing.** `onMove` is a write; this is a report of where the row
   * landed, and only the keyboard needs one — a finger is already on the row it
   * moved. A boolean parameter on the write would name the *input device* inside a
   * function about the list.
   */
  onAnnounce: (line: string) => void;
  /**
   * Drop what the daemon remembers about this harness refusing to start.
   *
   * Takes the **harness** id rather than the row's, because on a preset row those
   * are two different things and the record is kept against the harness.
   */
  onRecheck: (agent: string) => void;
  onRemove: () => void;
}): ReactNode {
  const node = useRef<HTMLLIElement | null>(null);
  /**
   * Whether this row is asking "Remove <name>?" — an assembled agent only.
   *
   * ⚠ **Per row, and it replaces the row's *controls* rather than adding a line.**
   * The confirmation used to live inside this `<li>` as an extra row of buttons,
   * which changed the row's height — and a drag measures **one** row at
   * `pointerdown` and applies that number to every neighbour's shift, so a drag
   * begun on a confirming row carried an oversized step into `dropIndex`. It is
   * back, on the plan's decision that deleting an assembled agent is not the
   * one-tap act hiding a harness is (rebuilding one is a walk through the builder,
   * not `Add back`), and it is back **at the row's own height**: the question
   * takes the name column's box, the pair takes the kebab's slot, and the handle
   * and glyph stay mounted. See the confirming arm below for the arithmetic.
   *
   * State here rather than in the menu, which closes on the first tap: a menu
   * held open to hold a confirmation would be a second dismissable layer over the
   * sheet, for one tap (`web-shell.md`).
   */
  const [confirming, setConfirming] = useState(false);
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
  /**
   * The box this list scrolls inside, found once at `pointerdown`.
   *
   * A ref rather than a lookup per frame: `getComputedStyle` walks the ancestors
   * and this is read on every animation frame of a drag that can last seconds.
   * Cleared at the end of the gesture, so a list re-parented between drags is
   * measured again.
   */
  const scroller = useRef<HTMLElement | null>(null);
  /** Pixels per frame the scroller should travel, signed. `0` is "not at an edge". */
  const drift = useRef(0);
  /** The live auto-scroll frame, or `null` when nothing is scrolling. */
  const rolling = useRef<number | null>(null);
  /**
   * The pointer's last viewport y.
   *
   * ⚠ **Held rather than passed, because the auto-scroll runs on frames the
   * pointer does not.** A finger parked in the hot zone emits no `pointermove` at
   * all, and that is exactly the state the list has to keep travelling in — so the
   * frame needs the last known position to re-derive the row's offset from.
   */
  const at = useRef(0);

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

  /*
   * ⚠ **A drag can end by this row ceasing to exist**, which no pointer event
   * reports. `StripEditor` is keyed on the machine and the `<li>`s are keyed on
   * the agent, so a removal, a machine switch or the sheet closing mid-gesture
   * unmounts this while an animation frame is queued — and a callback holding refs
   * on a dead component would go on scrolling a pane that is no longer under it.
   * Separate from the listener effect above because that one returns early when
   * the handle is absent, and this obligation is not conditional.
   */
  useEffect(
    () => () => {
      if (rolling.current !== null) cancelAnimationFrame(rolling.current);
    },
    [],
  );

  const harness = row.kind === "harness";
  const preset = harness ? null : (listing.presets.find((one) => one.id === row.id) ?? null);
  const info = harness ? (listing.agents.find((one) => one.id === row.id) ?? null) : null;
  const badge =
    info === null
      ? null
      : agentBadge(
          agentStance(info.available, info.loggedIn, info.login?.blocked, info.lastStartRefusal != null),
        );
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
  /**
   * The listing row for the harness *behind* this row, whichever kind it is.
   *
   * ⚠ **`info` is null on a preset row, and keying the re-check on it left the
   * control unreachable for exactly the harnesses that need it.** This screen
   * lists harnesses `startsBare` answers true for and nothing else — that
   * exclusion is deliberate and defended in this file's own header — so opencode,
   * and every harness a plugin added, appear here **only**
   * through the presets built on them. Those are the harnesses whose refusals are
   * routed ones, whose remedy is somewhere this app cannot see, and which had no
   * control anywhere.
   */
  const behind = harness ? info : (listing.agents.find((one) => one.id === preset?.harness) ?? null);
  /*
   * ⚠ **`harnessName` over the listing row, not `agentLabel` over its id.** That
   * function answers only for the four this product ships and falls through to the
   * raw id for anything else — right, and pinned — so a harness a plugin added
   * would have drawn `acme:gemini` here beside `Kimi Code`. The label rides
   * `AgentInfo`, and the `?? {id}` arm is the impossible case `glyph` above already
   * refuses to cast away.
   */
  const name = harness ? harnessName(info ?? { id: row.id }) : (preset?.name ?? row.id);
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
      : harnessSubline(row.id, listing.systems, info?.contributedBy)
    : preset === null
      ? ""
      : customAgentSubline(preset, listing.systems);

  /**
   * Put the row where the pointer is, and work out which slot it is over.
   *
   * ⚠ **Shared by the pointer handler and the auto-scroll frame**, because the two
   * change the same two numbers and a second copy is two answers to "where is this
   * row". A frame that scrolls the pane moves the row *under* a finger that has
   * not moved, so the offset and the target index are as much its business as the
   * pointer's.
   *
   * Reads {@link at} rather than an event, for that reason: the frame has no event.
   */
  const place = (): void => {
    const going = live.current;
    const box = node.current;
    if (going === null || box === null) return;
    const offset = at.current - going.startY;
    box.style.transform = `translateY(${offset}px)`;
    const next = dropIndex(index, offset, going.height, count);
    if (next === going.to) return;
    going.to = next;
    onDrag({ from: index, to: next, height: going.height });
  };

  /**
   * One frame of the list travelling under a held finger.
   *
   * ⚠ **The gesture's origin moves with the scroll, and that is the whole of the
   * arithmetic.** `offset` is a displacement *within the list*, which is what
   * `dropIndex` is written against — but `clientY` is a viewport number and the
   * row's own layout position slides by whatever the pane scrolled. Subtracting
   * the travel from `startY` keeps the difference measuring the same thing, so the
   * row stays under the finger and the target index goes on counting rows rather
   * than pixels of scroll.
   *
   * ⚠ **It stops itself at the end of the scroller** rather than queueing a frame
   * per frame for the rest of the drag: `scrollTop` clamps silently, so "asked to
   * move and did not" is the only signal there is that there is nothing left.
   */
  const roll = (): void => {
    const box = scroller.current;
    const going = live.current;
    if (box === null || going === null || drift.current === 0) {
      rolling.current = null;
      return;
    }
    const before = box.scrollTop;
    box.scrollTop = before + drift.current;
    const travelled = box.scrollTop - before;
    if (travelled === 0) {
      rolling.current = null;
      drift.current = 0;
      return;
    }
    going.startY -= travelled;
    place();
    rolling.current = requestAnimationFrame(roll);
  };

  /** Start, keep or stop the list travelling, from where the pointer now is. */
  const chase = (y: number): void => {
    const box = scroller.current;
    drift.current = box === null ? 0 : driftFor(box.getBoundingClientRect(), y);
    if (drift.current !== 0 && rolling.current === null) rolling.current = requestAnimationFrame(roll);
  };

  const start = (event: PointerEvent<HTMLButtonElement>): void => {
    const box = node.current;
    if (box === null || frozen) return;
    // `setPointerCapture` on the handle rather than listeners on `window`, which is
    // `RailHandle`'s rule: the gesture belongs to the control it started on, and
    // the capture survives the pointer leaving the row — which it does at once,
    // since the row is what is moving.
    event.currentTarget.setPointerCapture(event.pointerId);
    at.current = event.clientY;
    scroller.current = nearestScroller(box);
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
    if (going === null || going.pointerId !== event.pointerId) return;
    at.current = event.clientY;
    place();
    chase(event.clientY);
  };

  const end = (event: PointerEvent<HTMLButtonElement>): void => {
    const going = live.current;
    if (going === null || going.pointerId !== event.pointerId) return;
    live.current = null;
    if (rolling.current !== null) cancelAnimationFrame(rolling.current);
    rolling.current = null;
    drift.current = 0;
    scroller.current = null;
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
            if (to === index || to < 0 || to >= count) return;
            onMove(index, to);
            /*
             * ⚠ **Said out loud, because nothing else on this path is.** The
             * pointer drag has the row under the finger; a key press moves a row
             * that may be off screen, on a screen whose only live region reports
             * failures — so the reorder happened in silence. Positions are
             * one-based here and zero-based everywhere else in this file, because
             * this is the one number a person reads rather than indexes with.
             *
             * The whole sentence changes whenever the position does, which is what
             * makes a region re-announce: two presses in a row can only produce two
             * different positions, since a move to where the row already is was
             * refused one line up.
             */
            onAnnounce(`${name} moved to position ${to + 1} of ${count}.`);
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

        {confirming ? (
          /*
           * ⚠ **The row's own height, by the row's own arithmetic.** The name
           * column below is `py-2.5` around a line box of `--text-sm--line-height`
           * plus a subline of `--text-2xs--line-height`; this box is the sum of
           * those two, so a row that is asking is exactly as tall as one that is
           * not, and a drag past it measures what it measured before. The
           * question wraps inside that box and is clipped rather than growing
           * it. `items-center` keeps a 44px coarse-pointer button inside the same
           * 60px content box the kebab already sat in.
           *
           * ⚠ **Cancel last, and no `danger`.** Q3.218's ordering: both arms lay
           * out in the same slot, so a second tap on a laggy connection lands on
           * the undo. No `DangerButton` because `danger` is for an act nothing
           * brings back, and this one is rebuildable — the question says where.
           */
          <>
            <span className="min-w-0 flex-1 py-2.5 pl-1">
              <span className="flex h-[calc(var(--text-sm--line-height)+var(--text-2xs--line-height))] items-center overflow-hidden text-xs text-fg">
                <span>
                  Remove <span className="font-medium">{name}</span>? Rebuild it from Add an agent.
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2 pr-1">
              <Button
                size="sm"
                onClick={() => {
                  setConfirming(false);
                  onRemove();
                }}
              >
                Remove
              </Button>
              <Button size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </span>
          </>
        ) : (
        <>
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
         * ⚠ **A reserved slot, not a spinner that appears.** `web-shell.md`'s rule
         * for a row is that nothing mounts sideways into another control — the
         * remedies being delete it, reserve its slot, or move it off the row — and
         * this is the second: 16px is always here, so a write in flight never
         * shortens the name beside it or shifts the kebab under a thumb that is
         * already on its way to it.
         *
         * ⚠ **Outside the name's flex line rather than in it**, which is the other
         * half of the same rule. That line is height-pinned to the name's own line
         * box so the `default` badge cannot grow the row — a drag measures **one**
         * row and applies that number to every neighbour's shift — and a third
         * thing sharing it would be a third thing to keep inside 22px. Here it is a
         * fixed column between the name and the menu, like the glyph's on the other
         * side, and `items-center` on the row means a 12px mark cannot reach the
         * 60px content box.
         *
         * The spinner is `aria-hidden` on its own; what a reader gets instead is
         * the position announcement, which is the half a keyboard move needs.
         */}
        <span className="inline-flex w-4 shrink-0 justify-center">
          {pending && <Spinner />}
        </span>

        {/*
         * ⚠ **One menu, and it holds everything this row can do.** The visibility
         * toggle was a second icon button beside this one, which is two targets
         * 4px apart at the end of a row you also drag — and it made the row three
         * controls wide on a phone. `web-shell.md`'s rule is already that
         * "everything else a settings row can do sits behind one kebab"; the
         * toggle is *else*.
         *
         * ⚠ **And it is never disabled — not even by an old daemon.** It held
         * only Edit and Remove, so a built-in harness had nothing behind it and
         * was drawn switched off. Hiding is something every row can do — that is
         * the whole point of hiding a *harness* — so the menu always has at least
         * one item. `frozen` (a daemon that cannot store an order at all) used to
         * switch the whole menu off, and that took Edit and Check again with it,
         * two items that never touch the strip route; it now disables the one
         * item that does, inside the panel. `webcheck` pins the kebab as ungated.
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
               * ⚠ **A harness hides on one tap; an assembled agent asks first.**
               * The settings-row rule confirms acts nothing brings back, and
               * hiding is undone by `Add back` one tap away — a confirmation there
               * is a tax on the act somebody performs most. Deleting an assembled
               * agent is `DELETE /custom-agents/:id`, and what brings it back is a
               * walk through the builder, so the row asks "Remove <name>?" in
               * place (see `confirming`) and names where to rebuild it. The branch
               * is on what the act *does* — a flag or a delete — which this screen
               * may decide on; what it draws for either is the same item.
               */}
              {/*
               * ⚠ **Only where there is something to drop, and that is the one
               * conditional row in this menu.** The screen's standing rule is that
               * a row's *kind* may decide a lookup or a destination and never a
               * presentation — this is not keyed on kind. It is keyed on a fact
               * the row is already reporting one line up, in the badge that
               * displaced the vendor: this harness would not start. Offered on
               * every row it would be a control that does nothing on all but one
               * of them, which is what "Edit" was before it meant *start from
               * this*.
               *
               * ⚠ **And it is what the strip owes.** `offersStripTile` has taken
               * this harness's tile away, so this list is the only place it
               * appears — and for a harness with no sign-in wizard the remedy is
               * off-screen entirely: run its own program once on the machine. This
               * is the only control in the app that says "I did that, look again".
               */}
              {behind?.lastStartRefusal != null && (
                <RowAction
                  label="Check again"
                  onClick={() => {
                    close();
                    onRecheck(behind.id);
                  }}
                />
              )}
              <RowAction
                label={row.hidden ? "Add back" : "Remove"}
                /*
                 * ⚠ **This item, not the kebab, is what an old daemon takes away.**
                 * Hiding writes the strip and removing an assembled agent writes it
                 * after the `DELETE`, so both need the route; Edit and Check again
                 * do not. Disabling the whole menu for one item's sake left a row
                 * with nothing behind its only control.
                 */
                disabled={frozen}
                onClick={() => {
                  close();
                  if (harness) onToggle();
                  else setConfirming(true);
                }}
              />
            </>
          )}
        </Menu>
        </>
        )}
      </div>
    </li>
  );
}
