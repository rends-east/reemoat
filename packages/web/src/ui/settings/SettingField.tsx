import { useId, type ReactNode } from "react";
import type * as cp from "../../cp";
import { canResetField, fieldOrigin, originText } from "../../instance";
import { Button, FIELD } from "../bits";

/** One step above the section heading, same family, so a field label is not mistaken for a section. */
export const FIELD_LABEL = "text-xs font-semibold tracking-wider text-muted uppercase";

export const settingValue = (answer: cp.SettingsAnswer, key: string): string =>
  answer.settings.find((field) => field.key === key)?.value ?? "";

/** Presentational: owns no draft and saves nothing. Reset waits on the caller's `busy`, like Save. */
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
