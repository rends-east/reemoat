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
import { driftFor } from "../rowDrag";
import { customAgentSubline, harnessSubline, startableHere } from "../../agents";
import type { DaemonClient } from "../../daemon";
import { rememberRemoval } from "../../agentPick";
import { ApiError, errorText } from "../../http";
import type { MachineId } from "../../ids";
import { daemonRead } from "../../machine";
import { MACHINE_GONE } from "../../plugins";
import { shortPath } from "../../paths";
import { agentEditPath, agentFromHarnessPath, agentPath, navigate } from "../../router";
import { agentSetupPath, settingsPath } from "../../settings";
import { store, type AppState } from "../../store";
import type { AgentId, AgentAvailability, AgentStripEntry, CustomAgent, SystemInfo } from "../../wire";
import { agentBadge, agentStance, harnessName, startsBare } from "../agentCard";
import { installElapsed, installFailure } from "../agentInstall";
import { AgentGlyph } from "../AgentIcons";
import { Badge, Button, Empty, Icon, IconButton, Menu, NotReachable, RowAction, Spinner, TwoStep } from "../bits";
import { AgentDetail } from "./AgentsPanel";

// Stored per machine on the daemon, and lists every harness that can ever have a tile, wider than the strip draws (Q3.640).

interface Listing {
  agents: AgentAvailability[];
  presets: CustomAgent[];
  systems: SystemInfo[];
  stored: AgentStripEntry[];
}

interface Drag {
  from: number;
  to: number;
  height: number;
}

const INSTALL_POLL_MS = 1_000;

/** Walked at pointerdown because this list sits in a scroller it does not own; skips ancestors with nothing to scroll. */
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
  harness,
}: {
  state: AppState;
  machineId: MachineId;
  harness: string | null;
}): ReactNode {
  const machine = state.machines.find((one) => one.id === machineId) ?? null;

  if (machine === null) {
    // Not failed: a missing machine is a settled answer, and the way out is the machines list since the chevron leads to another dead end.
    return (
      <Empty
        action={
          <Button size="sm" onClick={() => navigate(settingsPath("machines"), true)}>
            All machines
          </Button>
        }
      >
        {MACHINE_GONE}
      </Empty>
    );
  }

  const read = daemonRead(machine.reach);

  if (read === "asking") {
    return (
      <Empty>
        <span className="inline-flex items-center gap-2">
          <Spinner /> Checking whether {machine.name} is reachable…
        </span>
      </Empty>
    );
  }

  if (read === "unreachable") {
    return (
      <Empty failed>
        <NotReachable machine={machine} />
      </Empty>
    );
  }

  // Below the guards so a gone or unreachable machine is said first; keyed so a live run never carries between harnesses (Q3.640).
  if (harness !== null) {
    return <AgentDetail key={`${machineId}:${harness}`} machineId={machineId} agentId={harness} />;
  }

  return (
    <div>
      <p className="text-xs text-muted">
        New session's agents on {machine.name} (
        <code className="text-muted/80">{machine.id}</code>). The first that can start is the{" "}
        <em>default</em>.
      </p>
      <StripEditor key={machineId} machineId={machineId} />
    </div>
  );
}

/** Split from the guards because hooks may not sit under an early return; keyed so a drag or write never lands on another machine's list. */
function StripEditor({ machineId }: { machineId: MachineId }): ReactNode {
  const [listing, setListing] = useState<Listing | null>(null);
  const [rows, setRows] = useState<StripRow[]>([]);
  const [writeFailure, setWriteFailure] = useState<string | null>(null);
  /** Adopted runs only, valued by the daemon's own startedAt so the clock never restarts (Q3.640). */
  const [installing, setInstalling] = useState<ReadonlyMap<string, number>>(new Map());
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (installing.size === 0) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(clock);
  }, [installing.size]);
  /** The assembled agent whose DELETE is unanswered, so its kebab cannot send it twice. */
  const [removing, setRemoving] = useState<string | null>(null);
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [moved, setMoved] = useState("");
  /** False only on an envelope-free 404; any other failure is transient and must not switch the controls off. */
  const [supported, setSupported] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  const saved = useRef<StripRow[]>([]);
  /** The current rows for a promise callback, since a closure would undo a drag that landed meanwhile. */
  const latest = useRef<readonly StripRow[]>(rows);
  latest.current = rows;
  const writes = useRef(0);
  /** The newest confirmed write, not the newest issued; a refusal restores to this. */
  const confirmed = useRef(0);
  /** Writes run one after another: the strip PUT replaces, so request order is its meaning. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setReadFailure("That machine is not reachable right now.");
      setListing({ agents: [], presets: [], systems: [], stored: [] });
      return;
    }
    let cancelled = false;
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

  // Merged into state, not derived per render, because a drag holds an order the daemon has not confirmed.
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

  /** Repaints optimistically and restores to saved, the last confirmed list, never to the previous edit. */
  const write = (
    next: readonly StripRow[],
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
        // Un-mark on the newest issued write settling, before the confirmed guard returns early.
        if (mine === writes.current) setPending(null);
        // Any answer newer than the newest confirmed advances the restore target, since the daemon holds this list.
        if (mine <= confirmed.current) return;
        confirmed.current = mine;
        saved.current = [...next];
        // Move stored with the write, or the next setListing re-runs the merge against the load-time order.
        setListing((held) => (held === null ? held : { ...held, stored: stripEntries(next) }));
        setWriteFailure(null);
      })
      .catch((cause: unknown) => {
        if (mine !== writes.current) return;
        setPending(null);
        setWriteFailure(errorText(cause));
        setRows([...saved.current]);
      });
  };

  const retryReads = (): void => setAttempt((one) => one + 1);

  /** Patches the one agent it asked about rather than re-reading, which would undo an in-flight drag. */
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

  const forget = (id: string): void => {
    setInstalling((was) => {
      const next = new Map(was);
      next.delete(id);
      return next;
    });
  };

  const followed = useRef<Set<string>>(new Set());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Polls with the threaded cursor so output already sent is never re-sent; gap is not read since no transcript is drawn here. */
  const watch = (daemon: DaemonClient, id: string, installId: string, cursor: number): void => {
    if (followed.current.has(installId)) return;
    followed.current.add(installId);
    const poll = (since: number): void => {
      if (!alive.current) return;
      void daemon
        .readInstall(installId, since)
        .then((chunk) => {
          if (!alive.current) return;
          if (!chunk.done) {
            setTimeout(() => poll(chunk.cursor), INSTALL_POLL_MS);
            return;
          }
          forget(id);
          if (chunk.outcome !== "installed") {
            setWriteFailure(installFailure(chunk.outcome, harnessName({ id })) ?? `That didn't install ${harnessName({ id })}.`);
          }
          setAttempt((one) => one + 1);
        })
        .catch((cause: unknown) => {
          if (!alive.current) return;
          forget(id);
          setWriteFailure(errorText(cause));
        });
    };
    poll(cursor);
  };

  // Adopt the run the daemon already holds; keyed on the machine only, because attempt bumps whenever a run ends (Q3.640).
  useEffect(() => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return;
    let cancelled = false;
    void daemon
      .liveInstall()
      .then((live) => {
        if (cancelled) return;
        const running = live.run;
        if (running === null || running.done) return;
        setInstalling((was) =>
          was.has(running.agent) ? was : new Map(was).set(running.agent, running.startedAt),
        );
        watch(daemon, running.agent, running.installId, running.cursor);
      })
      .catch(() => {
        // An older daemon's 404 and a dropped request are no evidence of a run.
      });
    return () => {
      cancelled = true;
    };
    // watch and forget are new every render but read only refs and setters; listing them would re-ask the daemon each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);

  const remove = (id: string): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setWriteFailure("That machine is not reachable right now.");
      return;
    }
    // Delete the agent first, then the strip: the reverse order can orphan a preset nothing lists.
    setRemoving(id);
    void daemon
      .removeCustomAgent(id)
      .then(() => {
        rememberRemoval(machineId, id);
        // Drop it from the restore target too, or a failed write repaints a deleted row.
        saved.current = saved.current.filter((row) => !(row.kind === "custom" && row.id === id));
        // And from the listing, or the next merge brings the deleted preset back.
        setListing((held) =>
          held === null ? held : { ...held, presets: held.presets.filter((one) => one.id !== id) },
        );
        write(latest.current.filter((row) => !(row.kind === "custom" && row.id === id)));
      })
      .catch((cause: unknown) => setWriteFailure(errorText(cause)))
      .finally(() => setRemoving((held) => (held === id ? null : held)));
  };

  const failure = writeFailure ?? readFailure;
  const settingsMode = listing?.agents.find((one) => one.id === "claude")?.settingsMode ?? null;
  const statusText =
    failure ?? (supported ? "" : "Daemon too old to reorder agents — update it.");
  const statusLine = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (failure === null) return;
    statusLine.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);

  if (listing === null) return <Spinner />;

  const shiftFor = (index: number): number => {
    if (drag === null || index === drag.from) return 0;
    if (drag.to > drag.from && index > drag.from && index <= drag.to) return -drag.height;
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return drag.height;
    return 0;
  };

  // The same defaultRow call and predicate New session uses, so the default badge never names a different row.
  const previewed = drag === null ? rows : moveRow(rows, drag.from, drag.to);
  const opensOn = defaultRow(previewed, (row) => startableHere(row, listing.agents, listing.presets));
  const opensOnKey = opensOn === null ? null : stripKey(opensOn.kind, opensOn.id);

  return (
    <div>
      {/* Said only when the read succeeded: a failed read is not an empty machine. */}
      {rows.length === 0 && failure === null && supported ? (
        <Empty>
          {listing.agents.length === 0
            ? "This machine reports no agents."
            : "Every agent on this machine needs a model. Add an agent to pick one."}
        </Empty>
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
              removing={removing === row.id}
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
              installing={installing}
              now={now}
              onRemove={() => remove(row.id)}
            />
          ))}
        </ul>
      )}

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
      {settingsMode !== null && (
        <p className="mt-2 text-2xs text-muted wrap-anywhere" title={settingsMode.file}>
          New claude sessions follow <span className="font-mono">permissions.defaultMode</span> —{" "}
          <span className="font-mono">{settingsMode.value}</span> — from{" "}
          <span className="font-mono">{shortPath(settingsMode.file)}</span>.
        </p>
      )}
      {writeFailure === null && readFailure !== null && (
        <Button size="sm" className="mt-1" onClick={retryReads}>
          Try again
        </Button>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {moved}
      </p>

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
 * Every row keeps both controls, handle and menu, so no row changes shape mid-drag;
 * a removed harness stays listed and dimmed, without opacity.
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
  removing,
  lifted,
  sliding,
  shift,
  onDrag,
  onMove,
  onToggle,
  onAnnounce,
  onRecheck,
  installing,
  now,
  onRemove,
}: {
  row: StripRow;
  index: number;
  count: number;
  listing: Listing;
  machineId: MachineId;
  opensOn: boolean;
  pending: boolean;
  frozen: boolean;
  removing: boolean;
  lifted: boolean;
  sliding: boolean;
  shift: number;
  onDrag: (drag: Drag | null) => void;
  onMove: (from: number, to: number) => void;
  onToggle: () => void;
  onAnnounce: (line: string) => void;
  onRecheck: (agent: string) => void;
  installing: ReadonlyMap<string, number>;
  now: number;
  onRemove: () => void;
}): ReactNode {
  const node = useRef<HTMLLIElement | null>(null);
  /** Per row, and it replaces the row's controls at the same height, since a drag measures one row for all. */
  const [confirming, setConfirming] = useState(false);
  /** The per-frame half of the drag, written to the DOM; the target index lives in React state. */
  const live = useRef<{ startY: number; height: number; pointerId: number; to: number } | null>(
    null,
  );
  const grip = useRef<HTMLButtonElement | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const drift = useRef(0);
  const rolling = useRef<number | null>(null);
  const at = useRef(0);

  // Non-passive touchmove for the component's life: React attaches it passively, and engines decide at touchstart.
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

  // Cancel a queued frame on unmount: a drag can end by the row ceasing to exist.
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
  const glyph: AgentId | null = harness ? (info?.id ?? null) : (preset?.harness ?? null);
  /** The harness behind this row of either kind; harnesses that startsBare excludes appear only through their presets. */
  const behind = harness ? info : (listing.agents.find((one) => one.id === preset?.harness) ?? null);
  const name = harness ? harnessName(info ?? { id: row.id }) : (preset?.name ?? row.id);
  const since = installing.get(row.id) ?? null;
  const elapsed = since === null ? null : installElapsed(since, now);
  const presetMissing = preset !== null && (behind === null || !behind.available);
  const presetRefused =
    preset !== null && behind !== null && behind.available && behind.lastStartRefusal?.routed === true;
  const under = since !== null
    ? `Installing…${elapsed === null ? "" : ` · ${elapsed}`}`
    : harness
      ? badge?.tone === "strong"
        ? badge.text
        : harnessSubline(row.id, listing.systems, info?.contributedBy)
      : preset === null
        ? ""
        : presetMissing
          ? `${harnessName(behind ?? { id: preset.harness })} not installed`
          : presetRefused
            ? `${harnessName(behind ?? { id: preset.harness })} would not start`
            : customAgentSubline(preset, listing.systems);

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

  /** Moves the gesture origin with the scroll so the row stays under the finger; stops when the scroller cannot move. */
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

  const chase = (y: number): void => {
    const box = scroller.current;
    const seen = box === null ? null : box.getBoundingClientRect();
    drift.current = seen === null ? 0 : driftFor(seen.top, seen.bottom, y);
    if (drift.current !== 0 && rolling.current === null) rolling.current = requestAnimationFrame(roll);
  };

  const start = (event: PointerEvent<HTMLButtonElement>): void => {
    const box = node.current;
    if (box === null || frozen) return;
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
      style={shift === 0 ? undefined : { transform: `translateY(${shift}px)` }}
      // Only neighbours transition, and only during a drag: the lifted row must track the pointer, and dropping the class at the drop avoids an overshoot.
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
        <button
          ref={grip}
          type="button"
          aria-label={`Move ${name}`}
          disabled={frozen}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          // A capture can be lost without a pointerup; end the drag there too.
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
            event.preventDefault();
            if (to === index || to < 0 || to >= count) return;
            onMove(index, to);
            onAnnounce(`${name} moved to position ${to + 1} of ${count}.`);
          }}
          className="tap inline-flex size-11 shrink-0 touch-none items-center justify-center rounded-md text-faint select-none hover:bg-raised hover:text-fg disabled:pointer-events-none"
        >
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
          // Sized to the row's own height so a drag past a confirming row measures the same.
          <TwoStep
            armed
            onArm={setConfirming}
            align="end"
            className="min-w-0 flex-1 pl-1 pr-1"
            question={
              <span className="my-2.5 flex h-[calc(var(--text-sm--line-height)+var(--text-2xs--line-height))] items-center overflow-hidden">
                <span>
                  Remove <span className="font-medium">{name}</span>? Rebuild it from Add an agent.
                </span>
              </span>
            }
            act={{ label: "Remove" }}
            disabled={removing}
            onAct={onRemove}
          />
        ) : (
        <>
        <span className="min-w-0 flex-1 py-2.5 pl-1">
          {/* Height pinned to the name's line box: a badge floored by a minimum font size must not grow this row. */}
          <span className="flex h-[var(--text-sm--line-height)] items-center gap-1.5">
            <span
              className={`min-w-0 truncate text-sm font-medium ${row.hidden ? "text-faint" : "text-fg"}`}
            >
              {name}
            </span>
            {opensOn && <Badge tone="strong">default</Badge>}
          </span>
          <span className={`block min-h-[var(--text-2xs--line-height)] truncate text-2xs ${row.hidden ? "text-faint" : "text-muted"}`}>
            {under}
          </span>
        </span>

        <span className="inline-flex w-4 shrink-0 justify-center">
          {(pending || since !== null) && <Spinner />}
        </span>

        {/* One kebab holds every act and is never disabled; frozen disables only the item that writes the strip. */}
        <Menu
          align="right"
          panelClassName="w-56"
          trigger={(open, toggle) => (
            <IconButton
              icon={MoreHorizontal}
              label={`More for ${name}`}
              size="lg"
              active={open}
              onClick={toggle}
            />
          )}
        >
          {(close) => (
            <>
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
              {/* Set up only where the row reports a fault, inside the kebab so the row never gains a control (Q3.640). */}
              {behind !== null && (badge?.tone === "strong" || !behind.available || presetRefused) && (
                <RowAction
                  label={`Set up ${harnessName(behind)}`}
                  onClick={() => {
                    close();
                    navigate(agentSetupPath(machineId, behind.id));
                  }}
                />
              )}
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
                disabled={frozen || removing}
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
