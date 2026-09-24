import {
  ChevronRight,
  CornerLeftUp,
  FileArchive,
  Folder,
  FolderPlus,
  GitBranch,
  Settings2,
} from "lucide-react";
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ApiError, errorText } from "../http";
import { forgetPick, heldPick, keepPick, takePick, takeRemoval } from "../agentPick";
import { refOf, sessionId, type MachineId } from "../ids";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import { displayCwd, pathCrumbs } from "../paths";
import { nativeBoot, pickFolderNative } from "../native";
import { agentStripPath, settingsPath } from "../settings";
import { navigate, newPath, sessionPath, type Route } from "../router";
import { machinesAsDrawn, store, type AppState, type DrawnMachine } from "../store";
import type { AgentAvailability, AgentStripEntry, CustomAgent, DirEntry, Me, SystemInfo } from "../wire";
import { customAgentSubline, harnessSubline, offersStripTile, startableHere } from "../agents";
import { defaultRow, orderStrip, stripKey, type StripRow } from "../agentStrip";
import { AgentGlyph } from "./AgentIcons";
import { ImportCode } from "./ImportCode";
import { harnessName } from "./agentCard";
import {
  Button,
  Dot,
  Dropdown,
  Empty,
  Icon,
  SHEET_FOOT,
  SETTINGS_HEADING,
  SHEET_SCREEN,
  Spinner,
  reachText,
} from "./bits";
import { toast } from "./Toast";
import type { MachineState } from "../machine";

function canStartOn(machine: MachineState): boolean {
  return machine.reach === "online" && machine.scopes.includes("session:write");
}

function unusableReason(machine: MachineState): string | null {
  if (canStartOn(machine)) return null;
  return machine.reach === "online" ? "read-only" : reachText(machine.reach, machine.offlineReason);
}

function MachinePicker({
  machines,
  value,
  onChange,
}: {
  machines: readonly DrawnMachine[];
  value: MachineId | null;
  onChange: (id: MachineId) => void;
}): ReactNode {
  const current = machines.find((one) => one.machine.id === value);
  const reason = current === undefined ? null : unusableReason(current.machine);

  return (
    <div className="space-y-1">
      <Dropdown
        items={machines.map(({ machine, name }) => {
          const why = unusableReason(machine);
          return {
            value: machine.id,
            label: name,
            description: why,
            disabled: why !== null,
            adornment: <Dot tone={why === null ? "on" : "off"} />,
          };
        })}
        value={value}
        onChange={onChange}
        heading="Machine"
        trigger={
          <span className="flex min-w-0 items-center gap-1.5">
            <Dot tone={current !== undefined && reason === null ? "on" : "off"} />
            <span className="truncate">{current?.name ?? "Choose a machine"}</span>
          </span>
        }
        className="w-full"
      />
      {reason !== null && <p className="text-2xs text-muted">{reason}</p>}
    </div>
  );
}

/** One mount for `/new` and `/agent/*` so going deeper does not re-animate the panel; the folder rides the address (Q3.472). */
export function StartSheet({
  state,
  route,
}: {
  state: AppState;
  route: Extract<Route, { name: "new" } | { name: "agent" }>;
}): ReactNode {
  // Held here, per machine, because `NewSession` unmounts for the whole agent flow (Q3.482).
  // Seeded from `heldPick` so a choice survives the settings pop-up, which unmounts this too.
  const [picks, setPicks] = useState<ReadonlyMap<MachineId, Picked>>(() => {
    const seed = new Map<MachineId, Picked>();
    const machine = route.machineId;
    if (machine === null) return seed;
    const held = heldPick(machine);
    if (held !== null) seed.set(machine, held);
    return seed;
  });
  const picksRef = useRef<ReadonlyMap<MachineId, Picked>>(picks);
  const choose = (machine: MachineId, next: Picked | null): void => {
    const updated = new Map(picksRef.current);
    if (next === null) updated.delete(machine);
    else updated.set(machine, next);
    picksRef.current = updated;
    setPicks(updated);
    if (next === null) forgetPick(machine);
    else keepPick(machine, next);
  };

  return (
    <>
      {route.name === "new" ? (
        <NewSession
          state={state}
          machineId={route.machineId}
          cwd={route.cwd}
          picks={picks}
          picksRef={picksRef}
          onPick={choose}
        />
      ) : (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <AgentBuilder
            machineId={route.machineId}
            cwd={route.cwd}
            step={route.step}
            preset={route.preset}
            harness={route.harness}
          />
        </Suspense>
      )}
    </>
  );
}

const SCROLLBAR_FADE_MS = 1000;

const MIN_THUMB_PX = 24;

const AgentBuilder = lazy(async () => ({
  default: (await import("./AgentBuilder")).AgentBuilder,
}));

function NewSession({
  state,
  machineId: fromRoute = null,
  cwd: fromRouteCwd = null,
  picks,
  picksRef,
  onPick,
}: {
  state: AppState;
  machineId?: MachineId | null;
  cwd?: string | null;
  picks: ReadonlyMap<MachineId, Picked>;
  /** `picks` as it stands now, for the hand-off effect, which must see a choice made after its render. */
  picksRef: RefObject<ReadonlyMap<MachineId, Picked>>;
  onPick: (machineId: MachineId, next: Picked | null) => void;
}): ReactNode {
  // Through `machinesAsDrawn` so the picker's order, names and default match the rail.
  const drawn = machinesAsDrawn(state);
  const reachable = drawn.map((one) => one.machine).filter((machine) => canStartOn(machine));
  const [machine, setMachine] = useState<MachineId | null>(fromRoute);
  const choose = (next: Picked): void => {
    if (selected === null) return;
    onPick(selected, next);
  };
  const [agents, setAgents] = useState<AgentAvailability[] | null>(null);
  /** Set when `GET /agents` failed, so a failure is never drawn as a machine with no agents. */
  const [agentsFailure, setAgentsFailure] = useState<string | null>(null);
  /** `[]` with `canConfigure` false means a daemon too old for assembled agents; any other failure keeps the gear. */
  const [customAgents, setCustomAgents] = useState<CustomAgent[] | null>(null);
  const [presetsFailure, setPresetsFailure] = useState<string | null>(null);
  const [systems, setSystems] = useState<SystemInfo[]>([]);
  const [stored, setStored] = useState<AgentStripEntry[]>([]);
  /** One flag for `/custom-agents`, `/systems` and `/agent-strip`: they shipped together, so one envelope-free 404 means none exist. */
  const [canConfigure, setCanConfigure] = useState(false);
  const [cwd, setCwd] = useState<string | null>(fromRouteCwd);
  // The folder rides the URL (replace, not push) so a trip into the builder keeps it.
  useEffect(() => {
    if (machine === null && fromRoute === null) return;
    const target = machine ?? fromRoute;
    if (target === null || cwd === null) return;
    if (target === fromRoute && cwd === fromRouteCwd) return;
    navigate(newPath(target, cwd), true);
  }, [machine, cwd, fromRoute, fromRouteCwd]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentsEpoch, setAgentsEpoch] = useState(0);

  const selected = machine ?? reachable[0]?.id ?? null;
  const hiddenHere = new Set(
    stored.filter((one) => one.hidden).map((one) => stripKey(one.kind, one.ref)),
  );
  // Ordered strip rows, shared by the default and the empty state; null until the presets read lands.
  const stripRows =
    customAgents === null
      ? null
      : orderStrip(
          [
            ...(agents ?? [])
              .filter(shownHere)
              .map((one) => ({ kind: "harness" as const, id: one.id })),
            ...customAgents.map((one) => ({ kind: "custom" as const, id: one.id })),
          ],
          stored,
        );
  const defaulted =
    stripRows === null ? null : defaultRow(stripRows, (row) => startableHere(row, agents, customAgents));
  /** This machine's pick, else the default, each checked by `offeredHere`; `null` disables Start. */
  const picked =
    offeredHere(
      selected === null ? null : (picks.get(selected) ?? null),
      agents,
      customAgents,
      hiddenHere,
    ) ??
    offeredHere(
      defaulted === null ? null : { kind: defaulted.kind, id: defaulted.id },
      agents,
      customAgents,
      hiddenHere,
    );
  /** Decided once for the strip's sentence and the footer, so a failed read is never called an empty machine. */
  const empty =
    agents === null || stripRows === null
      ? null
      : stripEmpty({
          agents,
          presets: customAgents,
          rows: stripRows,
          canConfigure,
          failed: agentsFailure !== null || presetsFailure !== null,
        });
  // Hand-offs consume, so they are taken in an effect; both channels every run, removal first.
  useEffect(() => {
    if (selected === null) return;
    const removed = takeRemoval(selected);
    if (removed !== null) {
      const standing = picksRef.current.get(selected);
      if (standing?.kind === "custom" && standing.id === removed) onPick(selected, null);
    }
    const fresh = takePick(selected);
    if (fresh === null) return;
    setCustomAgents((held) => [...(held ?? []), fresh]);
    onPick(selected, { kind: "custom", id: fresh.id });
  }, [selected, agentsEpoch]);
  // Resolved outside the effects so the client is a dependency: an early-returned effect must re-run once it exists.
  const daemon = selected === null ? undefined : store.daemonFor(selected);

  useEffect(() => {
    if (daemon === undefined || selected === null) return;
    // Clear every per-machine value, or machine A's presets show under B until B's reads land.
    setAgents(null);
    setAgentsFailure(null);
    setCustomAgents(null);
    setPresetsFailure(null);
    setSystems([]);
    setStored([]);
    setCanConfigure(false);
    let cancelled = false;
    // Never clear `cwd` here: the picker reports once per path, so a wipe leaves Start dead; it resets by remounting.
    void daemon
      .agents()
      .then((result) => {
        if (cancelled) return;
        setAgents(result.agents);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setAgents([]);
        setAgentsFailure(errorText(cause));
      });
    // Not awaited with `agents()`: a daemon without these routes must still list its built-in tiles.
    void Promise.all([daemon.customAgents(), daemon.systems(), daemon.agentStrip()])
      .then(([mine, listing, strip]) => {
        if (cancelled) return;
        setCustomAgents(mine.customAgents);
        setSystems(listing.systems);
        setStored(strip.entries);
        setCanConfigure(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCustomAgents([]);
        setSystems([]);
        // Only an envelope-free 404 (`http_404`) means an old daemon; anything else is a failure to show.
        const absent =
          ApiError.isApiError(cause) && cause.status === 404 && cause.code === `http_${cause.status}`;
        setStored([]);
        setCanConfigure(!absent);
        setPresetsFailure(absent ? null : errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, agentsEpoch]);

  const create = (): void => {
    if (busy) return;
    if (selected === null || cwd === null) {
      setError("Pick a machine and a folder first.");
      return;
    }
    if (picked === null) {
      setError("Choose an agent first.");
      return;
    }
    if (daemon === undefined) {
      setError("That machine is not connected right now.");
      return;
    }
    setBusy(true);
    setError(null);
    void daemon
      // Neither `worktree` nor `branch` is sent: the daemon's `auto` default decides.
      .createSession(
        picked.kind === "custom"
          ?
            { agent: "", customAgent: picked.id, cwd }
          : { agent: picked.id, cwd },
      )
      .then((result) => {
        const ref = refOf(selected, sessionId(result.session.id));
        store.applySnapshot(ref, result.session);
        navigate(sessionPath(ref), true);
      })
      .catch((cause: unknown) => {
        // A start timeout still created the session and names its id, so go there.
        if (ApiError.isApiError(cause) && cause.code === "agent_start_timeout") {
          const detail = cause.detail as { sessionId?: string } | null;
          if (typeof detail?.sessionId === "string") {
            navigate(sessionPath(refOf(selected, sessionId(detail.sessionId))), true);
            return;
          }
        }
        setError(errorText(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className={SHEET_SCREEN}>
      {/* The one scroller: fixed rows are `shrink-0` and the folder list takes the rest (Q3.553). */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
        <div className="shrink-0">
          <MachineLine
            machines={drawn}
            reachable={reachable}
            value={selected}
            fromRoute={fromRoute}
            me={state.me}
            onChange={setMachine}
          />
        </div>

        <div className="shrink-0">
          <FieldLabel>Agent</FieldLabel>
          {/* With no machine no read is sent, so `agents` would stay `null` and spin forever. */}
          {selected === null ? (
            <p className="text-sm text-muted">Pick a machine first.</p>
          ) : agents === null ? (
            <Spinner />
          ) : (
            <AgentStrip
              agents={agents}
              customAgents={customAgents}
              systems={systems}
              stored={stored}
              canConfigure={canConfigure}
              failure={agentsFailure}
              presetsFailure={presetsFailure}
              empty={empty}
              value={picked}
              onChange={choose}
              // Leaving is safe only because the folder is in the URL and the pick in `agentPick.ts` (Q3.640).
              onConfigure={() => {
                if (selected === null) return;
                // Make the address whole (replace) before pushing: a bare `/new` restores nothing on return.
                navigate(newPath(selected, cwd ?? undefined), true);
                navigate(agentStripPath(selected));
              }}
              machineId={selected}
              onChanged={() => setAgentsEpoch((n) => n + 1)}
            />
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <FieldLabel>Directory</FieldLabel>
          {selected === null ? (
            <p className="text-sm text-muted">Pick a machine first.</p>
          ) : (
            // `key` on the machine: a remount is how the picker resets for another machine's tree.
            <DirectoryPicker
              key={selected}
              machineId={selected}
              initial={selected === fromRoute ? fromRouteCwd : null}
              // Local by identity and the shell's declared `picksFolder`; not in `key`, since a remount would drop the walked folder.
              osDialog={nativeBoot()?.picksFolder === true && state.localMachineId === selected}
              onPick={setCwd}
            />
          )}
        </div>
      </div>

      {/* Mounted unconditionally, only the text swaps: a status region inserted with its content is often not announced. */}
      <div className={SHEET_FOOT}>
        <span
          role="status"
          aria-live="polite"
          className={`min-w-0 flex-1 text-2xs wrap-anywhere ${error === null ? "text-muted" : "text-danger"}`}
        >
          {error !== null ? (
            error
          ) : busy ? (
            "this can take up to 45 seconds"
          ) : agents !== null && picked === null ? (
            agentsFailure !== null ? "" : empty !== null ? "no agent to start" : "choose an agent"
          ) : cwd !== null ? (
            ""
          ) : (
            "choosing a folder…"
          )}
        </span>
        <Button
          tone="primary"
          onClick={create}
          disabled={busy || selected === null || cwd === null || picked === null}
        >
          {busy ? "Starting the agent…" : "Start"}
        </Button>
      </div>
    </div>
  );
}

/** Tagged: `POST /sessions` takes `agent` or `customAgent`, and a preset may share a harness's name. */
export type Picked = { kind: "harness"; id: string } | { kind: "custom"; id: string };

const shownHere = offersStripTile;

/** `pick` if this machine's listing still offers it (not hidden, startable); `null` while a list is unread. */
export function offeredHere(
  pick: Picked | null,
  agents: AgentAvailability[] | null,
  customAgents: CustomAgent[] | null,
  hidden: ReadonlySet<string> = new Set(),
): Picked | null {
  if (pick === null) return null;
  if (hidden.has(stripKey(pick.kind, pick.id))) return null;
  return startableHere(pick, agents, customAgents) ? pick : null;
}

export type StripEmpty = "hidden" | "not_set_up" | "not_ready" | "none_listed" | "too_old";

/** Copy as data so `webcheck` can sweep every arm; nothing here installs or signs in (Q3.640). */
export const STRIP_EMPTY: Readonly<
  Record<StripEmpty, { line: string; action: "settings" | "check_again" | null }>
> = {
  hidden: { line: "Every agent that can start here is hidden.", action: "settings" },
  not_set_up: { line: "No agent is set up on this machine yet.", action: "settings" },
  not_ready: { line: "No agent on this machine is ready to start.", action: "settings" },
  none_listed: { line: "This machine reports no agents.", action: "check_again" },
  too_old: {
    line: "This machine needs an update before agents can be set up here.",
    action: null,
  },
};

/** `null` while a read is out or failed, or when a drawn row can start; the arms are checked in order. */
export function stripEmpty(input: {
  agents: readonly AgentAvailability[];
  presets: readonly CustomAgent[] | null;
  rows: readonly StripRow[];
  canConfigure: boolean;
  failed: boolean;
}): StripEmpty | null {
  if (input.presets === null || input.failed) return null;
  const presets = input.presets;
  const can = (row: StripRow): boolean => startableHere(row, input.agents, presets);
  if (input.rows.some((row) => !row.hidden && can(row))) return null;
  if (input.agents.length === 0 && presets.length === 0) return "none_listed";
  if (input.rows.some((row) => row.hidden && can(row))) return "hidden";
  if (!input.canConfigure) return "too_old";
  return presets.length === 0 && !input.agents.some((one) => one.available)
    ? "not_set_up"
    : "not_ready";
}

// Order and hiding come from the stored strip via orderStrip; offersStripTile decides which harnesses get a tile.
function AgentStrip({
  agents,
  customAgents,
  systems,
  stored,
  canConfigure,
  failure,
  presetsFailure,
  empty,
  value,
  onChange,
  onConfigure,
  machineId,
  onChanged,
}: {
  agents: AgentAvailability[];
  customAgents: CustomAgent[] | null;
  systems: SystemInfo[];
  stored: readonly AgentStripEntry[];
  canConfigure: boolean;
  failure: string | null;
  presetsFailure: string | null;
  empty: StripEmpty | null;
  value: Picked | null;
  onChange: (next: Picked) => void;
  onConfigure: () => void;
  machineId: MachineId | null;
  onChanged: () => void;
}): ReactNode {
  // Scroll the chosen tile into view: a newly assembled agent lands off-screen at the row's end.
  const chosen = useRef<HTMLButtonElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const fade = useRef<HTMLDivElement | null>(null);
  const thumb = useRef<HTMLDivElement | null>(null);
  // A vertical wheel scrolls the row (a mouse has no other way); native listener because React's `onWheel` is passive.
  useEffect(() => {
    const box = track.current;
    const bar = thumb.current;
    const edge = fade.current;
    if (box === null || bar === null || edge === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      const room = box.scrollWidth - box.clientWidth;
      if (room <= 0) return;
      const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientWidth : 1;
      const next = Math.min(room, Math.max(0, box.scrollLeft + event.deltaY * step));
      if (next === box.scrollLeft) return;
      event.preventDefault();
      box.scrollLeft = next;
    };
    // The app's own scrollbar, since the native one cannot fade (see `index.css`); DOM writes because it runs every frame.
    const layout = (): void => {
      const rail = box.clientWidth;
      const room = box.scrollWidth - rail;
      // One pixel of slack: rounded metrics leave a remainder of 1 at the end.
      edge.classList.toggle("is-cut", rail > 0 && box.scrollLeft < room - 1);
      if (room <= 0 || rail === 0) {
        bar.style.width = "0px";
        bar.classList.remove("is-scrolling");
        return;
      }
      const width = Math.max(MIN_THUMB_PX, Math.round((rail * rail) / box.scrollWidth));
      bar.style.width = `${width}px`;
      bar.style.transform = `translateX(${Math.round(((rail - width) * box.scrollLeft) / room)}px)`;
    };
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onScroll = (): void => {
      layout();
      bar.classList.add("is-scrolling");
      clearTimeout(idle);
      idle = setTimeout(() => bar.classList.remove("is-scrolling"), SCROLLBAR_FADE_MS);
    };
    // Observe the row too: its width changes when the listing lands after this effect.
    const sizes = new ResizeObserver(layout);
    sizes.observe(box);
    const row = box.firstElementChild;
    if (row !== null) sizes.observe(row);
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(idle);
      sizes.disconnect();
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("scroll", onScroll);
    };
  }, []);
  const key = value === null ? "" : `${value.kind}:${value.id}`;
  useEffect(() => {
    chosen.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [key]);
  const presets = customAgents ?? [];
  const shown = agents.filter(shownHere);
  const rows = orderStrip(
    [
      ...shown.map((one) => ({ kind: "harness" as const, id: one.id })),
      ...presets.map((one) => ({ kind: "custom" as const, id: one.id })),
    ],
    stored,
  );
  const drawn = rows.filter((row) => !row.hidden);

  // No `opacity` on a disabled tile: it would drop the reason line below 4.5:1; keep in step with `ChoiceRow`.
  const tile = ({
    key: tileKey,
    picked,
    disabled = false,
    onClick,
    glyph,
    title,
    subline,
    label,
    hint,
  }: {
    key: string;
    picked: boolean;
    disabled?: boolean;
    onClick: () => void;
    glyph: ReactNode;
    title: string;
    subline: string;
    label?: string;
    hint?: string;
  }): ReactNode => {
    // `disabled` first, so picked-and-disabled gets the inert border, as in `ChoiceRow`.
    const bound = disabled
      ? "border-edge"
      : picked
        ? "border-edge-strong"
        : "border-edge-strong hover:bg-raised";
    return (
      <button
        key={tileKey}
        ref={picked ? chosen : null}
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-pressed={picked}
        aria-label={label}
        title={hint}
        className={`tap press flex min-h-16 w-28 shrink-0 flex-col items-start justify-center gap-1 rounded-lg border p-2.5 text-left ${bound} ${
          picked ? "bg-raised font-medium text-fg" : "bg-surface text-fg"
        }`}
      >
        <span className={disabled ? "text-faint" : "text-muted"}>{glyph}</span>
        <span className={`w-full truncate text-2xs ${disabled ? "text-muted" : ""}`}>{title}</span>
        {/* `min-h` reserves the line: an empty span is 0px tall and would misalign the tile. */}
        <span className="min-h-[var(--text-2xs--line-height)] w-full truncate text-2xs text-faint">
          {subline}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-2">
      <div>
        <div className="relative">
          <div ref={track} className="fade-scrollbar overflow-x-auto">
            <div className="flex w-max gap-2">
              {drawn.map((row) => {
                if (row.kind === "harness") {
                  const candidate = shown.find((one) => one.id === row.id);
                  if (candidate === undefined) return null;
                  return tile({
                    // `stripKey`, not the bare id: a harness and a preset may share an id.
                    key: stripKey("harness", candidate.id),
                    picked: value?.kind === "harness" && candidate.id === value.id,
                    disabled: !candidate.available,
                    onClick: () => onChange({ kind: "harness", id: candidate.id }),
                    glyph: <AgentGlyph agent={candidate.id} size={18} />,
                    title: harnessName(candidate),
                    subline: harnessSubline(candidate.id, systems, candidate.contributedBy),
                  });
                }
                const one = presets.find((preset) => preset.id === row.id);
                if (one === undefined) return null;
                // A preset is only as startable as its harness, as `startableHere` rules.
                const runs = agents.find((candidate) => candidate.id === one.harness) ?? null;
                const missing = runs === null || !runs.available;
                const refused = !missing && runs?.lastStartRefusal?.routed === true;
                const ranBy = harnessName(runs ?? { id: one.harness });
                const where = customAgentSubline(one, systems);
                const why = missing ? "not installed" : refused ? "would not start" : null;
                return tile({
                  key: stripKey("custom", one.id),
                  picked: value?.kind === "custom" && one.id === value.id,
                  disabled: why !== null,
                  onClick: () => onChange({ kind: "custom", id: one.id }),
                  glyph: <AgentGlyph agent={one.harness} size={18} />,
                  title: one.name,
                  subline: why === null ? where : `${ranBy} ${why}`,
                  // Names the harness too, since `AgentGlyph` is `aria-hidden`.
                  label: why === null
                    ? `${one.name}, ${ranBy}, ${where}`
                    : `${one.name}, ${ranBy} ${why}`,
                  hint: one.name,
                });
              })}
              {canConfigure && machineId !== null && (
                <button
                  type="button"
                  onClick={onConfigure}
                  aria-label="Agent settings"
                  className="tap press flex min-h-16 w-11 shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-edge-strong bg-surface text-muted hover:bg-raised hover:text-fg"
                >
                  <Icon as={Settings2} size={18} />
                </button>
              )}
            </div>
          </div>
          {/* A sibling, not a `mask-image` on the scroller, which would mask the rail; `pointer-events-none` keeps the gear pressable. */}
          <div
            ref={fade}
            aria-hidden="true"
            className="edge-fade pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-surface/70 to-transparent"
          />
        </div>
        <div aria-hidden className="pointer-events-none mt-1 h-1">
          <div ref={thumb} className="fade-thumb h-full w-0 rounded-full bg-edge-strong" />
        </div>
      </div>

      {empty !== null && (
        <Empty
          action={
            STRIP_EMPTY[empty].action === "settings" ? (
              <Button onClick={onConfigure}>
                <Icon as={Settings2} size={14} />
                Agent settings
              </Button>
            ) : STRIP_EMPTY[empty].action === "check_again" ? (
              <Button onClick={onChanged}>Check again</Button>
            ) : undefined
          }
        >
          {STRIP_EMPTY[empty].line}
        </Empty>
      )}
      {/* Independent of the empty state: a failed read is not an empty machine. */}
      {failure !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-2xs text-muted wrap-anywhere">
            The agents installed on this machine could not be read. {failure}
          </p>
          <Button onClick={onChanged}>Try again</Button>
        </div>
      )}
      {presetsFailure !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-2xs text-muted wrap-anywhere">
            The agents assembled on this machine could not be read. {presetsFailure}
          </p>
          <Button onClick={onChanged}>Try again</Button>
        </div>
      )}

    </div>
  );
}

function MachineLine({
  machines,
  reachable,
  value,
  fromRoute,
  me,
  onChange,
}: {
  machines: readonly DrawnMachine[];
  reachable: MachineState[];
  value: MachineId | null;
  fromRoute: MachineId | null;
  // Passed whole so this file calls `mayAddMachine` itself, which `webcheck` asserts.
  me: Me | null;
  onChange: (id: MachineId) => void;
}): ReactNode {
  const settled = fromRoute !== null || reachable.length === 1;
  const [open, setOpen] = useState(!settled);
  const current = machines.find((candidate) => candidate.machine.id === value) ?? null;

  if (machines.length === 0) {
    return (
      <div>
        <FieldLabel>Machine</FieldLabel>
        <p className="text-sm text-muted">No machines yet.</p>
        {mayAddMachine(me) ? (
          <Button className="mt-2" onClick={() => navigate(settingsPath("machines"))}>
            Add a machine
          </Button>
        ) : (
          <p className="mt-2 max-w-sm text-xs text-muted">{machineQuotaNotice(me)}</p>
        )}
      </div>
    );
  }

  if (!open && current !== null) {
    return (
      <div className="flex min-h-8 items-center gap-2 text-sm">
        <Dot tone={current.machine.reach === "online" ? "on" : "off"} />
        <span className="min-w-0 truncate">
          on <span className="font-medium">{current.name}</span>
        </span>
        {reachable.length > 1 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="tap -my-2 inline-flex min-h-11 items-center rounded-sm px-1.5 text-xs text-muted hover:bg-raised hover:text-fg"
          >
            change
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <FieldLabel>Machine</FieldLabel>
      <MachinePicker machines={machines} value={value} onChange={onChange} />
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <h2 className={`pb-1.5 ${SETTINGS_HEADING}`}>{children}</h2>
  );
}

function DirectoryPicker({
  machineId: id,
  initial,
  osDialog,
  onPick,
}: {
  machineId: MachineId;
  initial: string | null;
  /** Chooses the OS panel or the tree; state and the one-writer rule are shared by both. */
  osDialog: boolean;
  onPick: (path: string | null) => void;
}): ReactNode {
  const [roots, setRoots] = useState<readonly string[]>([]);
  const [path, setPath] = useState<string | null>(initial);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  /** Bumped by Try again; nothing else re-requests, since a refusal moves no dependency. */
  const [attempt, setAttempt] = useState(0);
  const daemon = store.daemonFor(id);

  useEffect(() => {
    if (daemon === undefined) return;
    let cancelled = false;
    setError(null);
    void daemon
      .roots()
      .then((result) => {
        if (cancelled) return;
        const first = result.roots[0] ?? null;
        setRoots(result.roots);
        // Not on the panel arm: a seed there would arm Start over a folder nobody picked.
        if (!osDialog) setPath((current) => current ?? first);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, attempt, osDialog]);

  // Report every move including `null`, so the parent's `cwd` strictly mirrors `path`.
  useEffect(() => {
    onPick(path);
  }, [path]);

  useEffect(() => {
    if (daemon === undefined || path === null || osDialog) return;
    let cancelled = false;
    setEntries(null);
    setError(null);
    void daemon
      .listDir(path)
      .then((result) => {
        if (!cancelled) setEntries(result.entries);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, path, attempt, osDialog]);

  /** A cancel keeps `path`; a failure toasts, since the error row's retry re-reads roots. */
  const choose = (): void => {
    if (busy) return;
    setBusy(true);
    void pickFolderNative(path ?? roots[0] ?? null)
      .then((picked) => {
        if (picked !== null) setPath(picked);
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  const create = (): void => {
    if (daemon === undefined || path === null || name.trim().length === 0 || busy) return;
    setBusy(true);
    void daemon
      .makeDir(path, name.trim())
      .then((result) => {
        setName("");
        setCreating(false);
        setPath(result.path);
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  /** Via `pathCrumbs`, the same longest-root rule as `displayCwd` (Q3.441). */
  const crumbs = pathCrumbs(path ?? "", roots);
  const parent = crumbs.length >= 2 ? (crumbs[crumbs.length - 2]?.path ?? null) : null;

  if (osDialog) {
    return (
      <div className="flex shrink-0 flex-col items-start gap-2">
        <div className="flex min-h-5 w-full min-w-0 items-center gap-2">
          {path === null ? (
            <span className="text-xs text-muted">No folder chosen yet.</span>
          ) : (
            <>
              <span className="shrink-0 text-faint">
                <Icon as={Folder} size={13} />
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
                {displayCwd(path, roots)}
              </span>
            </>
          )}
        </div>
        <Button onClick={choose} disabled={busy}>
          Choose directory
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-edge-strong bg-surface">
      <div className="flex flex-wrap items-center gap-y-0.5 border-b border-edge bg-raised px-2.5 py-2">
        {/* Walks the remote filesystem, not app history, so it must not look like the back control. */}
        <button
          type="button"
          onClick={() => {
            if (parent !== null) setPath(parent);
          }}
          disabled={parent === null}
          aria-label="Up one folder"
          title={parent === null ? "Already at the top" : `Up to ${crumbs[crumbs.length - 2]?.label ?? ""}`}
          className="tap -my-2 mr-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border-r border-edge text-muted hover:bg-surface hover:text-fg disabled:pointer-events-none disabled:border-transparent disabled:text-faint"
        >
          <Icon as={CornerLeftUp} size={17} />
        </button>
        <span className="mr-1.5 text-faint">
          <Icon as={Folder} size={12} />
        </span>
        {crumbs.length === 0 ? (
          error === null ? (
            <span className="font-mono text-2xs text-muted">loading…</span>
          ) : (
            <span className="text-2xs text-muted">could not be read</span>
          )
        ) : (
          crumbs.map((crumb, index) => {
            const leaf = index === crumbs.length - 1;
            return (
              <button
                key={crumb.path}
                onClick={() => setPath(crumb.path)}
                disabled={leaf}
                title={crumb.path}
                // `-my-2` reaches 44px inside the bar's padding; a pseudo-element would reach the first folder row.
                className={`tap -my-2 inline-flex min-h-11 items-center font-mono text-2xs ${
                  leaf ? "text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {crumb.label}
                {!leaf && <span className="text-faint">/</span>}
              </button>
            );
          })
        )}
      </div>

      {error !== null && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-danger wrap-anywhere">{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      )}

      <div className="min-h-32 flex-1 overflow-auto overscroll-contain">
        {entries === null && error === null && (
          <p className="px-3 py-3 text-xs text-muted">Loading…</p>
        )}
        {entries !== null && entries.length === 0 && (
          <p className="px-3 py-3 text-xs text-muted">
            This folder has nothing in it. That is fine — the agent can work here.
          </p>
        )}
        {entries?.map((entry) => (
          <button
            key={entry.path}
            onClick={() => setPath(entry.path)}
            className="tap flex min-h-11 w-full items-center gap-2 border-b border-edge/50 px-3 py-2.5 text-left last:border-0 hover:bg-raised/60"
          >
            <span className={entry.isGitRepo ? "text-fg" : "text-faint"}>
              <Icon as={entry.isGitRepo ? GitBranch : Folder} size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
            {entry.entries !== null && (
              <span className="shrink-0 text-2xs text-faint">{entry.entries}</span>
            )}
            <span className="shrink-0 text-faint">
              <Icon as={ChevronRight} size={13} />
            </span>
          </button>
        ))}
      </div>

      <div className="border-t border-edge px-2.5 py-2">
        {creating ? (
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  create();
                }
                if (event.key === "Escape") setCreating(false);
              }}
              autoFocus
              placeholder="folder name"
              aria-label="New folder name"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-edge-strong bg-ink px-3 py-2 font-mono text-xs outline-none"
            />
            <Button onClick={create} disabled={busy || name.trim().length === 0}>
              {busy ? <Spinner /> : "Create"}
            </Button>
            <Button tone="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCreating(true)}
              disabled={path === null}
              className="tap press flex min-h-11 items-center gap-1.5 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
            >
              <Icon as={FolderPlus} size={13} />
              New folder here
            </button>
            <button
              onClick={() => setImporting(true)}
              disabled={path === null}
              className="tap press flex min-h-11 items-center gap-1.5 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
            >
              <Icon as={FileArchive} size={13} />
              Import code
            </button>
          </div>
        )}
      </div>
      {importing && path !== null && (
        <ImportCode
          machineId={id}
          into={path}
          roots={roots}
          onClose={() => setImporting(false)}
          onImported={(imported) => setPath(imported)}
        />
      )}
    </div>
  );
}
