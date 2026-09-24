import { useEffect, useId, useState, type ReactNode } from "react";
import * as cp from "../../cp";
import { errorText } from "../../http";
import {
  canResetField,
  draftAfterClear,
  fieldOrigin,
  mailTrouble,
  originText,
  secretFieldText,
  seedPublicUrl,
  senderMismatch,
  smtpProblem,
  type SmtpDraft,
} from "../../instance";
import { store } from "../../store";
import { controlPlaneOrigin } from "../../native";
import { Button, Empty, FIELD, SETTINGS_HEADING, Spinner, TwoStep } from "../bits";
import { toast } from "../Toast";
import { FIELD_LABEL, SettingField, settingValue } from "./SettingField";

/** One draft and one Save for every SMTP key; each answer also refreshes the store's config, which reports mail state. */
export function EmailSection(): ReactNode {
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

  const adopt = (next: cp.SettingsAnswer): void => {
    setAnswer(next);
    void store.refreshConfig();
  };

  if (error !== null) {
    return (
      <Empty failed action={<Button size="sm" onClick={load}>Try again</Button>}>
        {error}
      </Empty>
    );
  }
  if (answer === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Loading…
      </div>
    );
  }
  return <SmtpForm answer={answer} onChanged={adopt} />;
}

function SmtpForm({
  answer,
  onChanged,
}: {
  answer: cp.SettingsAnswer;
  onChanged: (next: cp.SettingsAnswer) => void;
}): ReactNode {
  const fromAnswer = (source: cp.SettingsAnswer): SmtpDraft => ({
    host: settingValue(source, "smtp.host"),
    port: settingValue(source, "smtp.port"),
    security: settingValue(source, "smtp.security") || "starttls",
    username: settingValue(source, "smtp.username"),
    from: settingValue(source, "mail.from"),
    publicUrl: settingValue(source, "mail.public_url"),
  });

  const field = (key: string): cp.SettingsAnswer["settings"][number] | undefined =>
    answer.settings.find((entry) => entry.key === key);

  // The public URL seed is load-only; seeded keeps the server's problems visible while the seed is the only edit.
  const [seed] = useState(() => seedPublicUrl(fromAnswer(answer), field("mail.public_url"), controlPlaneOrigin()));
  const [draft, setDraft] = useState<SmtpDraft>(seed.draft);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(seed.dirty);
  const [seeded, setSeeded] = useState(seed.dirty);
  const [removing, setRemoving] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const securityId = useId();
  const passwordId = useId();
  const testId = useId();

  // Follow the server's answer only while the form has no unsaved edits.
  useEffect(() => {
    if (!dirty) setDraft(fromAnswer(answer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer]);

  const passwordField = field("smtp.password");
  // Removable only when stored here: a password from the environment cannot be removed on this screen.
  const passwordStored = passwordField?.set === true;
  const problem = smtpProblem(draft);

  const edit = (patch: Partial<SmtpDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
    setSeeded(false);
  };

  const save = (): void => {
    if (problem !== null) return;
    setBusy(true);
    const wanted: Record<string, string> = {
      "smtp.host": draft.host.trim(),
      "smtp.port": draft.port.trim(),
      "smtp.security": draft.security,
      "smtp.username": draft.username.trim(),
      "mail.from": draft.from.trim(),
      "mail.public_url": draft.publicUrl.trim(),
    };
    // An empty password field keeps the stored one; clearing is its own act.
    if (password.length > 0) wanted["smtp.password"] = password;

    // An empty field is cleared, not stored: an empty string is a real value that would shadow the environment.
    const set: Record<string, string> = {};
    const clear: string[] = [];
    for (const [key, entry] of Object.entries(wanted)) {
      if (entry.length === 0) clear.push(key);
      else set[key] = entry;
    }

    void cp
      .adminSaveSettings({ set, clear })
      .then((updated) => {
        setDirty(false);
        setSeeded(false);
        setDraft(fromAnswer(updated));
        onChanged(updated);
        setPassword("");
        toast("ok", "Saved.");
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  // The draft drops the cleared key so the next Save does not write it back; busy blocks an overlapping write.
  const clear = (key: string): Promise<void> => {
    setBusy(true);
    return cp
      .adminSaveSettings({ clear: [key] })
      .then((updated) => {
        onChanged(updated);
        const synced = fromAnswer(updated);
        setDraft((current) => (dirty ? draftAfterClear(current, key, synced) : synced));
      })
      .finally(() => setBusy(false));
  };
  const clearKey = (key: string): void => {
    void clear(key).catch((cause: unknown) => toast("error", errorText(cause)));
  };

  const sendTest = (): void => {
    setBusy(true);
    setTestResult(null);
    void cp
      .adminTestMail(testTo.trim().length > 0 ? testTo.trim() : undefined)
      .then((queued) => setTestResult(`Queued to ${queued.to}.`))
      .catch((cause: unknown) => setTestResult(errorText(cause)))
      .finally(() => setBusy(false));
  };

  // A test sends with the stored configuration, so it needs a saved and configured form.
  const sendBlocked = dirty ? "Save first." : !answer.mail.configured ? "Configure the server first." : null;

  return (
    <div>
      <p className="text-xs text-muted">Needed for sign-up confirmation and password resets.</p>

      <SettingField
        label="Host"
        value={draft.host}
        onChange={(next) => edit({ host: next })}
        field={field("smtp.host")}
        onReset={() => clearKey("smtp.host")}
        busy={busy}
        placeholder="smtp.example.com"
      />
      <SettingField
        label="Port"
        value={draft.port}
        onChange={(next) => edit({ port: next })}
        field={field("smtp.port")}
        onReset={() => clearKey("smtp.port")}
        busy={busy}
        placeholder="587"
        hint="Not 25 — usually blocked."
      />

      <div className="mt-3 max-w-sm">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={securityId} className={`block ${FIELD_LABEL}`}>
            Security
          </label>
          <SecurityReset field={field("smtp.security")} disabled={busy} onReset={() => clearKey("smtp.security")} />
        </div>
        <select
          id={securityId}
          value={draft.security}
          onChange={(event) => edit({ security: event.target.value })}
          className={`mt-1 w-full ${FIELD}`}
        >
          <option value="starttls">STARTTLS (port 587)</option>
          <option value="implicit_tls">TLS (port 465)</option>
          <option value="plaintext">None (local relay only)</option>
        </select>
        <p className="mt-1 text-2xs text-faint">
          <ProvenanceText field={field("smtp.security")} />
        </p>
      </div>

      <SettingField
        label="Username"
        value={draft.username}
        onChange={(next) => edit({ username: next })}
        field={field("smtp.username")}
        onReset={() => clearKey("smtp.username")}
        busy={busy}
        placeholder="register@example.com"
      />

      {/* Write-only: never pre-filled, and no dots that would claim a value. */}
      <div className="mt-3 max-w-sm">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={passwordId} className={`block ${FIELD_LABEL}`}>
            Password
          </label>
          {passwordStored && (
            <TwoStep
              armed={removing}
              onArm={setRemoving}
              className="justify-end"
              question="Remove the stored password?"
              act={{ label: "Remove" }}
              onAct={() => clear("smtp.password")}
              disabled={busy}
              rest={
                <Button size="sm" tone="ghost" disabled={busy} onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              }
            />
          )}
        </div>
        <input
          id={passwordId}
          type="password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setDirty(true);
          }}
          autoComplete="off"
          placeholder={passwordStored ? "leave empty to keep the stored one" : "app password"}
          className={`mt-1 w-full ${FIELD}`}
        />
        <p className="mt-1 text-2xs text-faint">{secretFieldText(passwordField)}</p>
      </div>

      <SettingField
        label="From address"
        value={draft.from}
        onChange={(next) => edit({ from: next })}
        field={field("mail.from")}
        onReset={() => clearKey("mail.from")}
        busy={busy}
        placeholder="register@example.com"
      />
      <SettingField
        label="Public URL"
        value={draft.publicUrl}
        onChange={(next) => edit({ publicUrl: next })}
        field={field("mail.public_url")}
        onReset={() => clearKey("mail.public_url")}
        busy={busy}
        placeholder={controlPlaneOrigin()}
        hint="Links in mail point here."
        type="url"
      />

      {senderMismatch(draft) && (
        <p className="mt-3 max-w-sm text-xs text-muted">
          From address differs from the username; many providers refuse that.
        </p>
      )}
      {problem !== null && <p className="mt-3 text-sm text-danger">{problem}</p>}

      <Button tone="primary" className="mt-4" disabled={busy || problem !== null || !dirty} onClick={save}>
        {busy ? <Spinner /> : "Save"}
      </Button>

      <div className="mt-6">
        <h3 className={SETTINGS_HEADING}>Send a test</h3>
        <label htmlFor={testId} className={`mt-2 block ${FIELD_LABEL}`}>
          Test recipient
        </label>
        <div className="mt-1 flex max-w-sm gap-2">
          <input
            id={testId}
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
            placeholder="you@example.com"
            type="email"
            className={`min-w-0 flex-1 ${FIELD}`}
          />
          <Button disabled={busy || sendBlocked !== null} onClick={sendTest}>
            Send
          </Button>
        </div>
        {sendBlocked !== null && <p className="mt-2 text-xs text-muted">{sendBlocked}</p>}
        {testResult !== null && <p className="mt-2 max-w-sm text-sm">{testResult}</p>}
        {(!dirty || seeded) &&
          !answer.mail.configured &&
          answer.mail.problems.map((sentence) => (
            <p key={sentence} className="mt-1 max-w-sm text-xs text-muted">
              {sentence}
            </p>
          ))}
        <MailTroubleNotice delivery={answer.mail.delivery} />
      </div>
    </div>
  );
}

function ProvenanceText({ field }: { field: cp.SettingsAnswer["settings"][number] | undefined }): ReactNode {
  return field === undefined ? "not set" : originText(fieldOrigin(field));
}

function SecurityReset({
  field,
  disabled,
  onReset,
}: {
  field: cp.SettingsAnswer["settings"][number] | undefined;
  disabled: boolean;
  onReset: () => void;
}): ReactNode {
  if (field === undefined || !canResetField(field)) return null;
  return (
    <Button size="sm" tone="ghost" disabled={disabled} onClick={onReset}>
      Reset
    </Button>
  );
}

/** The only surface that reports delivery trouble; mailTrouble is also null when nothing is known, so no false all-clear. */
function MailTroubleNotice({ delivery }: { delivery: cp.MailDelivery | undefined }): ReactNode {
  const trouble = mailTrouble(delivery);
  if (trouble === null) return null;
  return (
    <div className="mt-3 max-w-sm rounded-md border border-edge-strong p-3">
      <p className="text-sm">{trouble.text}</p>
      {/* Remote text, already truncated and CR/LF-stripped where it is recorded. */}
      {delivery?.lastError != null && trouble.kind !== "backlog" && (
        <p className="mt-1 break-words font-mono text-xs text-muted">{delivery.lastError}</p>
      )}
    </div>
  );
}
