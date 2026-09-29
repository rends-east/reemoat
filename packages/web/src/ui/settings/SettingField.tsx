import { useEffect, useState, type ReactNode } from "react";
import * as cp from "../../cp";
import { errorText } from "../../http";
import { canResetField, fieldOrigin, originBadge, originText, type ConfigField } from "../../instance";
import { store } from "../../store";
import { Badge, Button, Empty, FIELD } from "../bits";
import { Field } from "../kit/Field";
import { Pending } from "../kit/Status";

export const settingField = (answer: cp.SettingsAnswer, key: string): ConfigField | undefined =>
  answer.settings.find((field) => field.key === key);

export const settingValue = (answer: cp.SettingsAnswer, key: string): string => settingField(answer, key)?.value ?? "";

/** Where a row's value came from, as the badge on the row that opens its field. */
export function provenanceBadge(...fields: (ConfigField | undefined)[]): ReactNode {
  const text = originBadge(...fields);
  return text === null ? undefined : <Badge>{text}</Badge>;
}

/** What a field says under itself on its form: its hint, then where the value came from. */
export function fieldNotes(field: ConfigField | undefined, hint?: string): ReactNode {
  return (
    <>
      {hint !== undefined && <span className="block">{hint}</span>}
      <span className="block text-2xs text-faint">{field === undefined ? "not set" : originText(fieldOrigin(field))}</span>
    </>
  );
}

/** Offered only where a row here overrides the environment, which is the one value clearing gives back. */
export function SettingReset({
  field,
  busy,
  onReset,
}: {
  field: ConfigField | undefined;
  busy: boolean;
  onReset: () => void;
}): ReactNode {
  if (field === undefined || !canResetField(field)) return null;
  return (
    <Button size="sm" tone="ghost" disabled={busy} onClick={onReset}>
      Reset
    </Button>
  );
}

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
  error = null,
  type = "text",
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  field: ConfigField | undefined;
  onReset: () => void;
  /** The caller's write in flight; Reset is disabled on it, like Save. */
  busy?: boolean;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  type?: "text" | "url";
  autoFocus?: boolean;
}): ReactNode {
  return (
    <Field label={label} hint={fieldNotes(field, hint)} error={error}>
      {({ id, describedBy }) => (
        <div className="flex items-center gap-2">
          <input
            id={id}
            aria-describedby={describedBy}
            type={type}
            value={current}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={autoFocus}
            className={`min-w-0 flex-1 ${FIELD}`}
          />
          <SettingReset field={field} busy={busy} onReset={onReset} />
        </div>
      )}
    </Field>
  );
}

/**
 * The read every Server and Email screen starts from, and its two waiting states. An answer a write hands back also
 * refreshes the store's config, since these screens change what `GET /v1/instance` reports.
 */
export function WithAdminSettings({
  onAdopt,
  children,
}: {
  /** What else a write owes, such as the admin's own quota after a limit changes. */
  onAdopt?: () => void;
  children: (answer: cp.SettingsAnswer, adopt: (next: cp.SettingsAnswer) => void) => ReactNode;
}): ReactNode {
  const [answer, setAnswer] = useState<cp.SettingsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    setError(null);
    void cp
      .adminSettings()
      .then(setAnswer)
      .catch((cause: unknown) => setError(errorText(cause)));
  };
  useEffect(load, []);

  if (error !== null) {
    return (
      <Empty failed action={<Button size="sm" onClick={load}>Try again</Button>}>
        {error}
      </Empty>
    );
  }
  if (answer === null) return <Pending>Loading…</Pending>;
  return children(answer, (next) => {
    setAnswer(next);
    void store.refreshConfig();
    onAdopt?.();
  });
}
