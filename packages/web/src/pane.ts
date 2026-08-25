/**
 * What several machines' settings panes add up to.
 *
 * A plugin's settings are configured on *the machines somebody selected*, and
 * `plugin_data` is a table in one daemon's SQLite — so there is no such thing as
 * this plugin's settings across a fleet, only N configurations that may or may not
 * agree. This module is the one place that decides whether they do.
 *
 * ⚠ **Its own module rather than lines in `plugins.ts`, and the reason is a
 * posture rather than a line count.** Everything in `plugins.ts` fails **open**: an
 * unknown block is dropped, an unknown field kind becomes a text input and still
 * round-trips, nothing throws — because a dropped block costs a row nobody sees.
 * What is decided here fails the other way. It refuses to draw one form when the
 * machines disagree about its shape, because submitting one machine's keys to
 * another writes fields that machine does not have and omits ones it does, and
 * both are silent. Two opposite postures in one file is how the next reader applies
 * the wrong one; `catalogue.ts` already records that argument from the other side.
 *
 * DOM-free, so `webcheck` can import it.
 */

import type { MachineId } from "./ids";
import { seedForm } from "./plugins";
import type { PluginBlock, PluginField, PluginView } from "./wire";

type FormBlock = Extract<PluginBlock, { type: "form" }>;
type SaidBlock = Extract<PluginBlock, { type: "text" | "notice" }>;

/** One machine's answer, already narrowed to the settings vocabulary. */
export interface PaneReading {
  machineId: MachineId;
  /**
   * `null` where the machine could not be read at all.
   *
   * ⚠ **It takes no part in the agreement and is never written to.** Writing a
   * setting you never saw the current value of is the same class of failure as
   * writing to a machine nobody selected — `install.ts`'s `unreachable` arm already
   * makes the argument: drawing an unticked box for a machine nobody can read would
   * be a claim.
   */
  view: PluginView | null;
}

/**
 * Why a selected machine is named on screen and written to by nothing.
 *
 * ⚠ **Three reasons, and a machine that left the fleet is deliberately not one of
 * them.** {@link paneAgreement} is handed readings, so every member here is
 * something a *reading* can show; a revoked machine has no reading to show it
 * with, and the screen derives that list from the route instead — the ids in the
 * path that `state.machines` no longer holds. A fourth member here would have had
 * no producer, which leaves the next reader two equally wrong moves: handle a case
 * that cannot occur, or route the real list through this union and derive the same
 * fact a second time, in the one place that cannot see it.
 */
export type PaneExclusion = "unreadable" | "no_form" | "divergent";

export type PaneForm =
  /** Every readable machine sent the same form *and* the same values. */
  | { kind: "agreed"; block: FormBlock; values: Record<string, string> }
  /** The same form with different values: `values` is blank, `differing` says which keys. */
  | { kind: "mixed"; block: FormBlock; values: Record<string, string>; differing: readonly string[] }
  /** Different forms. No single form can honestly be drawn — see {@link paneAgreement}. */
  | { kind: "divergent"; groups: readonly { machines: readonly MachineId[] }[] }
  /** Nothing readable offered a form at all. */
  | { kind: "none" };

export interface PaneAgreement {
  form: PaneForm;
  /** The machines a submit of that form goes to. Empty for `divergent` and `none`. */
  targets: readonly MachineId[];
  /** Named on screen, written to by nothing. */
  excluded: readonly { machineId: MachineId; reason: PaneExclusion }[];
  /** Every `text` and `notice`, deduplicated and attributed. See {@link paneSaid}. */
  said: readonly { block: SaidBlock; machines: readonly MachineId[] }[];
}

/**
 * The blank form, as {@link seedForm} would seed one whose plugin sent no values.
 *
 * `text` and `select` become `""`; a `toggle` becomes `"false"`, because every
 * field is a string on the wire including a toggle and `seedForm` already makes
 * exactly that narrowing. One rule with two spellings, and `webcheck` pins them
 * equal rather than trusting them to stay so.
 *
 * ⚠ **A blanked toggle is not empty, it is *off*, and a checkbox has no third
 * state.** That is why `mixed` also carries the keys that actually disagreed: with
 * the warning naming them, somebody re-setting a fleet knows a switch they never
 * looked at is about to be written as off. The form still opens fully blank.
 */
export function blankForm(fields: readonly PluginField[]): Record<string, string> {
  return seedForm(fields.map((one) => ({ ...one, value: null })));
}

/**
 * What makes two machines' forms *the same form*.
 *
 * The action id and the sorted `(key, kind)` pairs, and nothing else:
 *
 *   - **`label`, `help`, `placeholder` and `submit` are excluded.** A version that
 *     only reworded a label must not stop a fleet being configured at once.
 *   - **Field order is excluded** — the pairs are sorted — because a submit is
 *     keyed, so order decides nothing about what is written.
 *   - ⚠ **`options` values are excluded, and this is the one lenient call.** A
 *     `select` whose options differ per machine is usually a plugin describing
 *     *local* facts — this host's folders, this host's models — and including them
 *     would make every heterogeneous fleet permanently divergent. The cost is real
 *     and is not covered: a value chosen on a machine that offers it, saved to one
 *     that does not, reaches a daemon whose plugin may not recognise it. What
 *     bounds it is that the plugin's own handler is the authority on what it
 *     accepts, and `Dropdown` draws an out-of-options value as itself rather than
 *     silently showing the first (Q3.463).
 *   - **`action` and `kind` are included, because they are what breaks a write.** A
 *     different action id is a different POST; a key that is `text` on one machine
 *     and `select` on another takes a different value.
 */
function formSignature(block: FormBlock): string {
  const shape = block.fields.map((one) => [one.key, one.kind] as const);
  return JSON.stringify([block.action, [...shape].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))]);
}

function formOf(view: PluginView): FormBlock | null {
  for (const block of view.blocks) if (block.type === "form") return block;
  return null;
}

/**
 * Every `text` and `notice`, deduplicated by content and attributed where it is not
 * unanimous.
 *
 * ⚠ **Nothing is dropped, and that is Q3.460 holding across a fleet.** `notice` is
 * the *entire* diagnostic channel for a plugin with no screen of its own — a hook's
 * refusal owes nobody an error and has no session left to warn through — so drawing
 * the first machine's and hiding four others' is exactly the failure that rule
 * exists to prevent.
 *
 * ⚠ **And the collapse is what makes a real diagnostic visible rather than what
 * hides one.** The ordinary case is a pane opening with one identical explanatory
 * paragraph per host; drawn five times with five machine names beside them it is a
 * wall, and a wall teaches people to skip the block that matters. Collapsed, a
 * `danger` notice appearing on **one** machine is the only attributed line on the
 * screen — the signal, drawn for free.
 *
 * Compared by `type`, `text` and `tone`, never by position: the same sentence at
 * index 0 on one host and index 2 on another is one sentence. Drawn in the first
 * readable machine's order, with anything it did not send appended in machine
 * order, so the result is stable under the poll.
 */
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

/**
 * What the selected machines' panes add up to.
 *
 * ⚠ **The partition is the property worth asserting**: every machine handed in is
 * either a target or is named in `excluded`, exactly once. One that fell out of
 * both is a machine somebody selected and never heard about again, which is the
 * failure `planTargets` is shaped around one module over.
 *
 * ⚠ **Values are compared after {@link seedForm} normalisation, never as raw
 * `value`.** `null` on one machine and `""` on another are the same on screen and
 * the same on submit, so they agree; comparing the wire values would report `mixed`
 * for a fleet that is identical, and the red warning that follows would be a lie
 * about somebody's configuration.
 *
 * The form drawn is the first readable machine's — the signature deliberately
 * ignores labels and order, so any of them would do, and "the first" is stable.
 */
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
      /*
       * ⚠ **Excluded, and deliberately not `divergent`.** A machine on a version
       * whose manifest had no `settings` is `offersSettings`' *anywhere, not
       * everywhere* rule holding end to end: a fleet mid-update is the ordinary
       * case rather than an error, and calling it a disagreement would refuse the
       * whole screen over a host that simply has nothing to say.
       */
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
    /*
     * ⚠ **Different forms, so no single form is drawn — and the machines are
     * grouped rather than merely refused.** Because the scope is an address, each
     * group is a link to its own settings screen, which turns "these hosts disagree"
     * into two taps rather than a dead end. That is the strongest argument for the
     * machines living in the URL at all.
     */
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
