// Fails closed, unlike `plugins.ts`: machines that disagree on a form's shape get no shared form, or one machine's keys would be written to another.

import type { MachineId } from "./ids";
import { seedForm } from "./plugins";
import type { PluginBlock, PluginField, PluginView } from "./wire";

type FormBlock = Extract<PluginBlock, { type: "form" }>;
type SaidBlock = Extract<PluginBlock, { type: "text" | "notice" }>;

export interface PaneReading {
  machineId: MachineId;
  /** `null` when unreadable: excluded, and never written to. */
  view: PluginView | null;
}

/** Only what a reading can show; a revoked machine is derived from the route instead. */
export type PaneExclusion = "unreadable" | "no_form" | "divergent";

export type PaneForm =
  | { kind: "agreed"; block: FormBlock; values: Record<string, string> }
  | { kind: "mixed"; block: FormBlock; values: Record<string, string>; differing: readonly string[] }
  | { kind: "divergent"; groups: readonly { machines: readonly MachineId[] }[] }
  | { kind: "none" };

export interface PaneAgreement {
  form: PaneForm;
  /** The machines a submit of that form goes to. Empty for `divergent` and `none`. */
  targets: readonly MachineId[];
  excluded: readonly { machineId: MachineId; reason: PaneExclusion }[];
  said: readonly { block: SaidBlock; machines: readonly MachineId[] }[];
}

/** A blanked toggle is off, not empty, which is why `mixed` also names the differing keys. */
export function blankForm(fields: readonly PluginField[]): Record<string, string> {
  return seedForm(fields.map((one) => ({ ...one, value: null })));
}

/** Same form: same action id and sorted (key, kind) pairs; labels, order and select options are ignored (Q3.463). */
function formSignature(block: FormBlock): string {
  const shape = block.fields.map((one) => [one.key, one.kind] as const);
  return JSON.stringify([block.action, [...shape].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))]);
}

function formOf(view: PluginView): FormBlock | null {
  for (const block of view.blocks) if (block.type === "form") return block;
  return null;
}

/** Deduplicated by type, text and tone and attributed, never dropped (Q3.460). */
function paneSaid(readings: readonly PaneReading[]): { block: SaidBlock; machines: MachineId[] }[] {
  const byKey = new Map<string, { block: SaidBlock; machines: MachineId[] }>();
  const order: string[] = [];
  for (const reading of readings) {
    if (reading.view === null) continue;
    for (const block of reading.view.blocks) {
      if (block.type !== "text" && block.type !== "notice") continue;
      const key = JSON.stringify([block.type, block.text, block.tone]);
      const held = byKey.get(key);
      if (held === undefined) {
        byKey.set(key, { block, machines: [reading.machineId] });
        order.push(key);
      } else if (!held.machines.includes(reading.machineId)) {
        held.machines.push(reading.machineId);
      }
    }
  }
  return order.flatMap((key) => {
    const held = byKey.get(key);
    return held === undefined ? [] : [held];
  });
}

/** Every machine ends up a target or excluded, exactly once; values are compared after `seedForm` normalisation. */
export function paneAgreement(readings: readonly PaneReading[]): PaneAgreement {
  const said = paneSaid(readings);
  const excluded: { machineId: MachineId; reason: PaneExclusion }[] = [];
  const withForm: { machineId: MachineId; block: FormBlock; values: Record<string, string> }[] = [];

  for (const reading of readings) {
    if (reading.view === null) {
      excluded.push({ machineId: reading.machineId, reason: "unreadable" });
      continue;
    }
    const block = formOf(reading.view);
    if (block === null) {
      // No form is an exclusion, not a divergence: a fleet mid-update is ordinary.
      excluded.push({ machineId: reading.machineId, reason: "no_form" });
      continue;
    }
    withForm.push({ machineId: reading.machineId, block, values: seedForm(block.fields) });
  }

  const first = withForm[0];
  if (first === undefined) return { form: { kind: "none" }, targets: [], excluded, said };

  const bySignature = new Map<string, MachineId[]>();
  for (const one of withForm) {
    const key = formSignature(one.block);
    const held = bySignature.get(key);
    if (held === undefined) bySignature.set(key, [one.machineId]);
    else held.push(one.machineId);
  }
  if (bySignature.size > 1) {
    return {
      form: { kind: "divergent", groups: [...bySignature.values()].map((machines) => ({ machines })) },
      targets: [],
      excluded: [
        ...excluded,
        ...withForm.map((one) => ({ machineId: one.machineId, reason: "divergent" as const })),
      ],
      said,
    };
  }

  const keys = first.block.fields.map((one) => one.key);
  const differing = keys.filter((key) => withForm.some((one) => one.values[key] !== first.values[key]));
  const targets = withForm.map((one) => one.machineId);
  if (differing.length === 0) {
    return { form: { kind: "agreed", block: first.block, values: first.values }, targets, excluded, said };
  }
  return {
    form: { kind: "mixed", block: first.block, values: blankForm(first.block.fields), differing },
    targets,
    excluded,
    said,
  };
}
