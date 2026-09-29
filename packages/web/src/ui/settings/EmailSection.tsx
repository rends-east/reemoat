import { Send } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import { errorText } from "../../http";
import {
  draftAfterClear,
  mailTrouble,
  secretFieldText,
  secretPresent,
  seedPublicUrl,
  senderMismatch,
  smtpProblem,
  type ConfigField,
  type SmtpDraft,
} from "../../instance";
import { controlPlaneOrigin } from "../../native";
import { navigate } from "../../router";
import { settingsLeafPath, settingsPath } from "../../settings";
import { Button, Dropdown, FIELD, Spinner, TwoStep } from "../bits";
import { toast } from "../Toast";
import { Field } from "../kit/Field";
import { ActionRow, Group, LinkRow } from "../kit/List";
import { Notice } from "../kit/Status";
import {
  SettingField,
  SettingReset,
  WithAdminSettings,
  fieldNotes,
  provenanceBadge,
  settingField,
  settingValue,
} from "./SettingField";

const SECURITY_CHOICES: readonly { value: string; label: string }[] = [
  { value: "starttls", label: "STARTTLS (port 587)" },
  { value: "implicit_tls", label: "TLS (port 465)" },
  { value: "plaintext", label: "None (local relay only)" },
];

const securityLabel = (value: string): string =>
  SECURITY_CHOICES.find((choice) => choice.value === value)?.label ?? value;

const back = (): void => navigate(settingsPath("email"), true);

/** Delivery trouble, the SMTP settings as rows onto one form, and a test send. */
export function EmailSection(): ReactNode {
  return <WithAdminSettings>{(answer) => <EmailRows answer={answer} />}</WithAdminSettings>;
}

function EmailRows({ answer }: { answer: cp.SettingsAnswer }): ReactNode {
  const field = (key: string): ConfigField | undefined => settingField(answer, key);
  const value = (key: string): string => settingValue(answer, key).trim();
  const host = value("smtp.host");
  const port = value("smtp.port");
  const unset = "Not set";
  // Every row opens the one form: the keys are saved together, so they are edited together.
  const smtp = (): void => navigate(settingsLeafPath("smtp"));

  return (
    <div>
      <MailTroubleNotice delivery={answer.mail.delivery} />
      <Group title="SMTP">
        <LinkRow
          title="Server"
          value={host.length === 0 ? unset : port.length === 0 ? host : `${host}:${port}`}
          badge={provenanceBadge(field("smtp.host"), field("smtp.port"))}
          onClick={smtp}
        />
        <LinkRow
          title="Security"
          value={securityLabel(value("smtp.security") || "starttls")}
          badge={provenanceBadge(field("smtp.security"))}
          onClick={smtp}
        />
        <LinkRow
          title="Username"
          value={value("smtp.username") || unset}
          badge={provenanceBadge(field("smtp.username"))}
          onClick={smtp}
        />
        <LinkRow
          title="Password"
          value={secretPresent(field("smtp.password")) ? "Set" : unset}
          badge={provenanceBadge(field("smtp.password"))}
          onClick={smtp}
        />
        <LinkRow
          title="From"
          value={value("mail.from") || unset}
          badge={provenanceBadge(field("mail.from"))}
          onClick={smtp}
        />
        <LinkRow
          title="Public URL"
          value={value("mail.public_url") || unset}
          badge={provenanceBadge(field("mail.public_url"))}
          onClick={smtp}
        />
      </Group>
      <Group>
        <ActionRow title="Send a test" glyph={Send} onClick={() => navigate(settingsLeafPath("test-mail"))} />
      </Group>
    </div>
  );
}

/** One draft and one Save for every SMTP key. */
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

  const field = (key: string): ConfigField | undefined => settingField(answer, key);

  // The public URL seed is load-only; seeded keeps the server's problems visible while the seed is the only edit.
  const [seed] = useState(() => seedPublicUrl(fromAnswer(answer), field("mail.public_url"), controlPlaneOrigin()));
  const [draft, setDraft] = useState<SmtpDraft>(seed.draft);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(seed.dirty);
  const [seeded, setSeeded] = useState(seed.dirty);
  const [removing, setRemoving] = useState(false);

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

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || problem !== null || !dirty) return;
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
        back();
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

  return (
    <form onSubmit={save} className="flex max-w-sm flex-col gap-4">
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
      />

      <Field label="Security" hint={fieldNotes(field("smtp.security"))}>
        {({ id, labelledBy, describedBy }) => (
          <div className="flex items-center gap-2">
            <Dropdown
              id={id}
              labelledBy={labelledBy}
              describedBy={describedBy}
              className="min-w-0 flex-1"
              items={SECURITY_CHOICES}
              value={draft.security}
              onChange={(next) => edit({ security: next })}
              trigger={<span className="truncate">{securityLabel(draft.security)}</span>}
            />
            <SettingReset field={field("smtp.security")} busy={busy} onReset={() => clearKey("smtp.security")} />
          </div>
        )}
      </Field>

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
      <Field label="Password" hint={secretFieldText(passwordField) ?? undefined}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setDirty(true);
            }}
            autoComplete="off"
            placeholder={passwordStored ? "leave empty to keep the stored one" : "app password"}
            className={FIELD}
          />
        )}
      </Field>
      {/* Under the hint that says a password is stored, right-aligned in both arms, so Cancel lands where Remove was (Q3.218). */}
      {passwordStored && (
        <TwoStep
          armed={removing}
          onArm={setRemoving}
          className="-mt-2 justify-end"
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
        <p className="text-xs text-muted">From address differs from the username; many providers refuse that.</p>
      )}
      {problem !== null && <p className="text-sm text-danger">{problem}</p>}
      {(!dirty || seeded) &&
        !answer.mail.configured &&
        answer.mail.problems.map((sentence) => (
          <p key={sentence} className="text-xs text-muted">
            {sentence}
          </p>
        ))}

      <div className="flex items-center gap-2">
        <Button
          tone="primary"
          type="submit"
          disabled={busy || problem !== null || !dirty}
        >
          {busy ? <Spinner /> : "Save"}
        </Button>
        <Button disabled={busy} onClick={back}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TestMail({ answer }: { answer: cp.SettingsAnswer }): ReactNode {
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // A test sends with the stored configuration, and nothing on this screen is a draft of it.
  const sendBlocked = !answer.mail.configured ? "Configure the server first." : null;

  const sendTest = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || sendBlocked !== null) return;
    setBusy(true);
    setTestResult(null);
    void cp
      .adminTestMail(testTo.trim().length > 0 ? testTo.trim() : undefined)
      .then((queued) => setTestResult({ ok: true, text: `Queued to ${queued.to}.` }))
      .catch((cause: unknown) => setTestResult({ ok: false, text: errorText(cause) }))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={sendTest} className="flex max-w-sm flex-col gap-4">
      <Field label="Recipient" hint="Empty sends to your own address.">
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            type="email"
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
            placeholder="you@example.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className={FIELD}
          />
        )}
      </Field>
      <div className="flex items-center gap-2">
        <Button tone="primary" type="submit" disabled={busy || sendBlocked !== null}>
          {busy ? <Spinner /> : "Send"}
        </Button>
      </div>
      {sendBlocked !== null && <p className="text-xs text-muted">{sendBlocked}</p>}
      {testResult !== null && <p className={`text-sm ${testResult.ok ? "" : "text-danger"}`}>{testResult.text}</p>}
    </form>
  );
}

/** The only surface that reports delivery trouble; mailTrouble is also null when nothing is known, so no false all-clear. */
function MailTroubleNotice({ delivery }: { delivery: cp.MailDelivery | undefined }): ReactNode {
  const trouble = mailTrouble(delivery);
  if (trouble === null) return null;
  return (
    <Notice tone="warn">
      {trouble.text}
      {/* Remote text, already truncated and CR/LF-stripped where it is recorded. */}
      {delivery?.lastError != null && trouble.kind !== "backlog" && (
        <span className="mt-1 block font-mono text-xs break-words text-muted">{delivery.lastError}</span>
      )}
    </Notice>
  );
}

export function SmtpScreen(): ReactNode {
  return <WithAdminSettings>{(answer, adopt) => <SmtpForm answer={answer} onChanged={adopt} />}</WithAdminSettings>;
}

export function TestMailScreen(): ReactNode {
  return <WithAdminSettings>{(answer) => <TestMail answer={answer} />}</WithAdminSettings>;
}
