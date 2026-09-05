import { useId, type ReactNode } from "react";
import type * as cp from "../../cp";
import { canResetField, fieldOrigin, originText } from "../../instance";
import { Button, FIELD } from "../bits";

/**
 * The label a settings *field* wears, as distinct from a section heading.
 *
 * `SETTINGS_HEADING` at `text-2xs` is the 10px letter-spaced caps this screen
 * uses for a section; a field's name at 10px was the smallest type on a form
 * somebody fills in from a phone. 12px floor (`text-xs`), same weight and
 * tracking, so the two still read as one family and a label is not mistaken for
 * a section.
 */
export const FIELD_LABEL = "text-xs font-semibold tracking-wider text-muted uppercase";

/** The stored value of one setting, or `""` when there is none. */
export const settingValue = (answer: cp.SettingsAnswer, key: string): string =>
  answer.settings.find((field) => field.key === key)?.value ?? "";

/**
 * One field, its provenance, and the offer to give it back.
 *
 * **Presentational.** It owns no draft and saves nothing — that is the whole
 * repair: this component used to commit on blur while the Save button wrote the
 * same keys from a different state, and the two overwrote each other.
 *
 * Shared by `ServerSection` and `EmailSection` since the split, rather than
 * copied: two copies of the label/provenance/reset shape is how one of them
 * loses its `htmlFor` again.
 *
 * The origin line is `text-2xs text-faint` under the field and **always
 * present**, so nothing shifts as a value is edited. Deliberately not a `Badge`:
 * six badges on a six-field form is six boxes, and `Badge`'s own rule is that a
 * box inside a row that already has one reads as a control somebody can press.
 *
 * Reset is drawn **only** where `canResetField` — the one case where its absence
 * is unambiguous, because the line underneath says why. No confirmation:
 * retyping the value undoes it. **It waits with the rest of the form**: `busy`
 * is the caller's in-flight flag, the one Save and the password's Remove already
 * read, and Reset was the one control on these two screens that stayed live
 * during a write (review D8) — a second clear racing a Save, both of them
 * answering with the whole settings table, in an order nobody chose.
 *
 * `hint` sits directly under the input, above the provenance line, and is a
 * field hint in the copy table's sense: at most eight words, only where the
 * placeholder cannot teach it.
 */
export function SettingField({
  label,
  value: current,
  onChange,
  field,
  onReset,
  busy = false,
  placeholder,
  hint,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  field: cp.SettingsAnswer["settings"][number] | undefined;
  onReset: () => void;
  /** The caller's write in flight; Reset is disabled on it, like Save. */
  busy?: boolean;
  placeholder?: string;
  hint?: string;
  type?: "text" | "url";
}): ReactNode {
  // `htmlFor`/`id`, the same pairing every other labelled control in this package
  // uses. Without it this `<label>` names nothing: most of the controls on the
  // two admin screens are drawn by this component, and each announced as a bare
  // "edit text" — on the screen that configures the instance's only recovery
  // channel.
  const id = useId();
  return (
    <div className="mt-3 max-w-sm">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className={`block ${FIELD_LABEL}`}>
          {label}
        </label>
        {field !== undefined && canResetField(field) && (
          <Button size="sm" tone="ghost" disabled={busy} onClick={onReset}>
            Reset
          </Button>
        )}
      </div>
      <input
        id={id}
        type={type}
        value={current}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={`mt-1 w-full ${FIELD}`}
      />
      {hint !== undefined && <p className="mt-1 text-xs text-muted">{hint}</p>}
      <p className="mt-1 text-2xs text-faint">{field === undefined ? "not set" : originText(fieldOrigin(field))}</p>
    </div>
  );
}
