import type { ReactNode } from "react";
import { DEFAULT_BOARD } from "@reemoat/board";
import { cardHolder, projectName, type Board, type BoardTask } from "../../board";
import type { MachineId } from "../../ids";
import { displayCwd } from "../../paths";
import type { AppState } from "../../store";
import { AgentMark } from "../AgentIcons";
import { agentLabel } from "../agentCard";
import { Dropdown, type DropdownItem } from "../bits";
import {
  assigneeValue,
  parseAssigneeValue,
  projectsOn,
  takingMachines,
  useRosters,
  type Assignee,
  type AgentRoster,
  type TakingMachine,
} from "./assignees";
import { HolderAvatar } from "./Holder";
import { useBoard } from "./useBoard";

// No router here either: the proposals card draws both pickers.

export interface Assigned {
  machineId: MachineId;
  kind: "harness" | "custom";
  id: string;
}

/** What the assignee control holds: an agent on a machine, nobody yet, or the task's person (Q3.727). */
export type AssigneeChoice = Assigned | "nobody" | "you";

export const NOBODY = "\u0000nobody";
export const YOU = "\u0000you";

/** What a task's assignee control holds: as its card names it (`cardHolder`). */
export function assigneeChoiceOf(entry: BoardTask, board: Board = DEFAULT_BOARD): AssigneeChoice {
  const holder = cardHolder(entry, board);
  if (holder.kind !== "agent") return holder.kind;
  const custom = holder.customAgent;
  return { machineId: entry.machineId, kind: custom === null ? "harness" : "custom", id: custom ?? holder.agent };
}

/** The agent a task holds as the reader is shown it: its own name where its machine was read, else its harness's. */
export function assignedLabel(assigned: Assigned & { harness: string }, offer: AgentRoster | null): string {
  const found = offer?.agents.find((one) => one.kind === assigned.kind && one.id === assigned.id);
  if (found !== undefined) return found.label;
  return assigned.kind === "custom" ? `${agentLabel(assigned.harness)}, assembled` : agentLabel(assigned.harness);
}

type Shape =
  | { variant: "row"; title: string; subline?: string }
  | { variant: "field"; id?: string; labelledBy?: string; describedBy?: string }
  | { variant: "chip"; label: string };

export interface AgentChoices {
  items: DropdownItem<string>[];
  machines: TakingMachine[];
  offers: ReadonlyMap<MachineId, AgentRoster | null>;
  /** The agent a row stands for, or null for a row that is not one. */
  pick: (raw: string) => Assignee | null;
}

/** Every machine that can take a task and, under each, what New session would offer there, as the rows of one list (Q3.725). */
export function useAgentChoices(state: AppState, only: MachineId | null): AgentChoices {
  const { supported, read } = useBoard();
  const machines = takingMachines(state, supported, read).filter((machine) => only === null || machine.id === only);
  const offers = useRosters(machines.filter((machine) => machine.refused === null).map((machine) => machine.id));
  const items = machines.flatMap((machine): DropdownItem<string>[] => {
    const offer = offers.get(machine.id) ?? null;
    if (machine.refused !== null) {
      return [{ value: `${machine.id}\u0000none`, label: machine.name, group: machine.name, disabled: true, description: machine.refused }];
    }
    if (offer === null) {
      return [{ value: `${machine.id}\u0000none`, label: "…", group: machine.name, disabled: true, description: "reading its agents" }];
    }
    if (offer.agents.length === 0) {
      return [
        {
          value: `${machine.id}\u0000none`,
          label: "No agent to start",
          group: machine.name,
          disabled: true,
          description: offer.failure ?? "set one up in its Agents settings",
        },
      ];
    }
    return offer.agents.map((agent) => ({
      value: assigneeValue(machine.id, agent.kind, agent.id),
      label: agent.label,
      group: machine.name,
      adornment: <AgentMark agent={agent.harness} />,
    }));
  });
  const pick = (raw: string): Assignee | null => {
    const parsed = parseAssigneeValue(raw);
    if (parsed === null) return null;
    return offers.get(parsed.machineId)?.agents.find((one) => one.kind === parsed.kind && one.id === parsed.id) ?? null;
  };
  return { items, machines, offers, pick };
}

/**
 * Who does a task, as one choice: nobody yet, its person, or one of the agents New session would offer on each machine that
 * can take one (Q3.725, Q3.727). `only` keeps the agents to one machine, for a task whose conversations already live there.
 */
export function AssigneeDropdown({
  state,
  value,
  harness,
  onChange,
  only = null,
  nobody = false,
  you = false,
  disabled = false,
  busy = false,
  shape,
}: {
  state: AppState;
  value: AssigneeChoice | null;
  /** The harness under the current value, for its glyph while its machine is unread. */
  harness: string | null;
  onChange: (next: Assignee | "nobody" | "you") => void;
  only?: MachineId | null;
  /** Offers Not assigned, first: what a task is until somebody takes it. */
  nobody?: boolean;
  /** Offers its person, who holds every task an agent has finished with. */
  you?: boolean;
  disabled?: boolean;
  busy?: boolean;
  shape: Shape;
}): ReactNode {
  const choices = useAgentChoices(state, only);
  const { machines, offers } = choices;
  const me = state.me?.name ?? null;
  const people: DropdownItem<string>[] = [
    ...(nobody ? [{ value: NOBODY, label: "Not assigned", adornment: <HolderAvatar holder={{ kind: "nobody" }} me={me} /> }] : []),
    ...(you ? [{ value: YOU, label: "You", adornment: <HolderAvatar holder={{ kind: "you" }} me={me} /> }] : []),
  ];
  const items = [...people, ...choices.items];
  const agent = value === null || typeof value === "string" ? null : value;
  const machineName = agent === null ? null : (machines.find((one) => one.id === agent.machineId)?.name ?? null);
  const offer = agent === null ? null : (offers.get(agent.machineId) ?? null);
  const glyph = harness ?? (agent?.kind === "harness" ? agent.id : null);
  const label = agent === null ? null : assignedLabel({ ...agent, harness: glyph ?? agent.id }, offer);
  const trigger =
    value === "nobody" || value === "you" ? (
      <>
        <HolderAvatar holder={{ kind: value }} me={me} />
        <span className={`min-w-0 truncate ${value === "nobody" ? "text-muted" : ""}`}>{value === "nobody" ? "Not assigned" : "You"}</span>
      </>
    ) : agent === null ? (
      <span className="truncate text-muted">Choose who does it</span>
    ) : shape.variant === "row" ? (
      // A row's value is narrow: the agent, then the machine under it, so neither is what truncates away.
      <>
        {glyph !== null && <AgentMark agent={glyph} />}
        <span className="flex min-w-0 flex-col items-end leading-tight">
          <span className="max-w-full truncate">{label}</span>
          {machineName !== null && <span className="max-w-full truncate text-2xs">{machineName}</span>}
        </span>
      </>
    ) : (
      <>
        {glyph !== null && <AgentMark agent={glyph} />}
        <span className="min-w-0 truncate">
          {label}
          {machineName !== null && <span className="text-muted"> · {machineName}</span>}
        </span>
      </>
    );
  const pick = (raw: string): void => {
    if (raw === NOBODY || raw === YOU) {
      onChange(raw === NOBODY ? "nobody" : "you");
      return;
    }
    const found = choices.pick(raw);
    if (found !== null) onChange(found);
  };
  const chosen =
    value === "nobody" ? NOBODY : value === "you" ? YOU : agent === null ? null : assigneeValue(agent.machineId, agent.kind, agent.id);
  return shape.variant === "row" ? (
    <Dropdown
      variant="row"
      title={shape.title}
      subline={shape.subline}
      items={items}
      value={chosen}
      onChange={pick}
      disabled={disabled}
      busy={busy}
      trigger={trigger}
    />
  ) : shape.variant === "chip" ? (
    <Dropdown variant="chip" label={shape.label} items={items} value={chosen} onChange={pick} disabled={disabled} busy={busy} trigger={trigger} />
  ) : (
    <Dropdown
      id={shape.id}
      labelledBy={shape.labelledBy}
      describedBy={shape.describedBy}
      items={items}
      value={chosen}
      onChange={pick}
      disabled={disabled}
      busy={busy}
      trigger={trigger}
    />
  );
}

/** Stands in the list for a folder nothing here has used yet. */
export const ANOTHER_FOLDER = "\u0000another";

/** Where on its machine a task runs: folders its sessions and tasks use, then what its daemon remembers. */
export function ProjectDropdown({
  state,
  machineId,
  value,
  onChange,
  another = false,
  disabled = false,
  busy = false,
  shape,
}: {
  state: AppState;
  machineId: MachineId;
  value: string;
  onChange: (next: string) => void;
  /** Offers a typed folder, as the New task form does. */
  another?: boolean;
  disabled?: boolean;
  busy?: boolean;
  shape: Shape;
}): ReactNode {
  const { tasks } = useBoard();
  const offer = useRosters([machineId]).get(machineId) ?? null;
  const roots = state.rootsByMachine.get(machineId) ?? [];
  const folders = projectsOn(
    state,
    machineId,
    tasks.filter((entry) => entry.machineId === machineId).map((entry) => entry.task.cwd),
    offer,
  );
  if (value.length > 0 && value !== ANOTHER_FOLDER && !folders.includes(value)) folders.unshift(value);
  const items: DropdownItem<string>[] = [
    ...folders.map((path) => ({ value: path, label: displayCwd(path, roots) })),
    ...(another ? [{ value: ANOTHER_FOLDER, label: "Another folder" }] : []),
  ];
  const trigger = (
    <span className={`truncate ${value.length === 0 ? "text-muted" : ""}`}>
      {value === ANOTHER_FOLDER ? "Another folder" : value.length === 0 ? "Choose a folder" : displayCwd(value, roots)}
    </span>
  );
  return shape.variant === "row" ? (
    <Dropdown variant="row" title={shape.title} items={items} value={value} onChange={onChange} disabled={disabled} busy={busy} trigger={trigger} />
  ) : shape.variant === "chip" ? (
    <Dropdown variant="chip" label={shape.label} items={items} value={value} onChange={onChange} disabled={disabled} busy={busy} trigger={trigger} />
  ) : (
    <Dropdown
      id={shape.id}
      labelledBy={shape.labelledBy}
      describedBy={shape.describedBy}
      items={items}
      value={value}
      onChange={onChange}
      disabled={disabled}
      busy={busy}
      trigger={trigger}
    />
  );
}

/** Where a task lands on a machine it moves to: the folder it had if that machine uses it, else one of the same name, else that machine's newest. */
export function folderOn(state: AppState, machineId: MachineId, wanted: string, offer: AgentRoster | null, taskFolders: readonly string[]): string {
  const folders = projectsOn(state, machineId, taskFolders, offer);
  if (folders.includes(wanted)) return wanted;
  const named = wanted.length === 0 ? undefined : folders.find((path) => projectName(path) === projectName(wanted));
  return named ?? folders[0] ?? wanted;
}
