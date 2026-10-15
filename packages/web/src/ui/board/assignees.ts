import { useEffect, useSyncExternalStore } from "react";
import { orderStrip } from "../../agentStrip";
import { drawnInNoList } from "../../boardAgent";
import { offersStripTile, startableHere } from "../../agents";
import { errorText } from "../../http";
import type { MachineId } from "../../ids";
import type { MachineState } from "../../machine";
import { machinesAsDrawn, store, type AppState } from "../../store";
import type { AgentAvailability, CustomAgent } from "../../wire";
import { agentLabel } from "../agentCard";
import { folderPathOf } from "../groups";

// No router here: the proposals card draws these pickers, and webcheck imports the transcript with no address bar.

/** Who can take a task: one agent New session would offer on one machine, in that machine's order (Q3.725). */
export interface Assignee {
  machineId: MachineId;
  kind: "harness" | "custom";
  id: string;
  /** The harness under it, for the glyph: an assembled agent runs on one. */
  harness: string;
  label: string;
}

export interface AgentRoster {
  agents: Assignee[];
  /** Folders its daemon remembers starting in, newest first. */
  recent: string[];
  roots: string[];
  failure: string | null;
}

const ROSTER_TTL_MS = 60_000;

const held = new Map<MachineId, { at: number; offer: AgentRoster | null }>();
const asking = new Set<MachineId>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Asked once a minute at most, and at once after a press that may have changed it. */
export function loadRoster(machineId: MachineId, force = false): void {
  const last = held.get(machineId);
  if (asking.has(machineId) || (!force && last !== undefined && Date.now() - last.at < ROSTER_TTL_MS)) return;
  const daemon = store.daemonFor(machineId);
  if (daemon === undefined) return;
  asking.add(machineId);
  void Promise.all([
    daemon.agents(),
    // A daemon older than assembled agents still lists its built-in ones.
    daemon.customAgents().catch(() => ({ customAgents: [] as CustomAgent[] })),
    daemon.agentStrip().catch(() => ({ entries: [] })),
    daemon.roots().catch(() => ({ roots: [] as string[], recent: [] as string[] })),
  ])
    .then(([listed, mine, strip, roots]) => {
      held.set(machineId, { at: Date.now(), offer: rosterOf(machineId, listed.agents, mine.customAgents, strip.entries, roots) });
    })
    .catch((cause: unknown) => {
      held.set(machineId, { at: Date.now(), offer: { agents: [], recent: [], roots: [], failure: errorText(cause) } });
    })
    .finally(() => {
      asking.delete(machineId);
      bump();
    });
}

function rosterOf(
  machineId: MachineId,
  agents: readonly AgentAvailability[],
  presets: readonly CustomAgent[],
  entries: Parameters<typeof orderStrip>[1],
  roots: { roots: string[]; recent?: string[] },
): AgentRoster {
  const rows = orderStrip(
    [
      ...agents.filter(offersStripTile).map((one) => ({ kind: "harness" as const, id: one.id })),
      ...presets.map((one) => ({ kind: "custom" as const, id: one.id })),
    ],
    entries,
  ).filter((row) => !row.hidden && startableHere(row, agents, presets));
  return {
    agents: rows.map((row) => {
      const preset = row.kind === "custom" ? presets.find((one) => one.id === row.id) : undefined;
      return {
        machineId,
        kind: row.kind,
        id: row.id,
        harness: preset?.harness ?? row.id,
        label: preset?.name ?? agentLabel(row.id),
      };
    }),
    recent: roots.recent ?? [],
    roots: roots.roots,
    failure: null,
  };
}

/** What a machine was last read to offer, outside a render: for a handler that already holds the choice. */
export function heldRoster(machineId: MachineId): AgentRoster | null {
  return held.get(machineId)?.offer ?? null;
}

/** Each machine's offer as far as it has been read, asked for on mount; null while the first read is out. */
export function useRosters(machineIds: readonly MachineId[]): ReadonlyMap<MachineId, AgentRoster | null> {
  useSyncExternalStore(subscribe, () => version);
  const key = machineIds.join(",");
  useEffect(() => {
    for (const id of machineIds) loadRoster(id);
  }, [key]);
  const out = new Map<MachineId, AgentRoster | null>();
  for (const id of machineIds) out.set(id, held.get(id)?.offer ?? null);
  return out;
}

/** Why a machine can take no task now, or null: reachable, writable, and its daemon keeps tasks. */
export function cannotTake(machine: MachineState, supported: ReadonlySet<MachineId>, read: ReadonlySet<MachineId>): string | null {
  if (machine.reach !== "online") return "not reachable";
  if (!machine.scopes.includes("session:write")) return "read-only";
  // Read and not kept: a daemon older than tasks.
  if (read.has(machine.id) && !supported.has(machine.id)) return "too old for tasks";
  return null;
}

export interface TakingMachine {
  id: MachineId;
  name: string;
  /** Null when it can take a task now. */
  refused: string | null;
}

/** Every machine in the order and under the names the strip draws them. */
export function takingMachines(state: AppState, supported: ReadonlySet<MachineId>, read: ReadonlySet<MachineId>): TakingMachine[] {
  return machinesAsDrawn(state).map(({ machine, name }) => ({ id: machine.id, name, refused: cannotTake(machine, supported, read) }));
}

export function assigneeValue(machineId: string, kind: "harness" | "custom", id: string): string {
  return `${machineId}\u0000${kind}\u0000${id}`;
}

export function parseAssigneeValue(value: string): { machineId: MachineId; kind: "harness" | "custom"; id: string } | null {
  const [machineId, kind, id] = value.split("\u0000");
  if (machineId === undefined || id === undefined || (kind !== "harness" && kind !== "custom")) return null;
  return { machineId: machineId as MachineId, kind, id };
}

/** Folders a machine's sessions and tasks already use, then what its daemon remembers: a project is one of them. */
export function projectsOn(
  state: AppState,
  machineId: MachineId,
  taskFolders: readonly string[],
  offer: AgentRoster | null,
): string[] {
  const seen: string[] = [];
  const add = (path: string): void => {
    if (path.length > 0 && !seen.includes(path)) seen.push(path);
  };
  for (const row of state.sessions) if (row.ref.machineId === machineId && !drawnInNoList(row.snapshot)) add(folderPathOf(row));
  for (const path of taskFolders) add(path);
  for (const path of offer?.recent ?? []) add(path);
  for (const path of offer?.roots ?? []) add(path);
  return seen;
}
