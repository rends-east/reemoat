import { useEffect, useId, useState, type ReactNode } from "react";
import * as cp from "../../cp";
import { errorText } from "../../http";
import {
  canResetField,
  fieldOrigin,
  mailTrouble,
  originText,
  secretFieldText,
  senderMismatch,
  smtpProblem,
  type SmtpDraft,
} from "../../instance";
import { store } from "../../store";
import { Button, Empty, FIELD, SETTINGS_HEADING, Spinner } from "../bits";
import { toast } from "../Toast";
import { FIELD_LABEL, SettingField, settingValue } from "./SettingField";

/**
 * The SMTP form, the test send, and what is wrong with delivery.
 *
 * Its own section since the settings redesign, split out of `ServerSection`
 * (decision D-IA-2): the one admin screen somebody sets up once from a phone was
 * nine fields down a scroll that also held registration and the machine limit,
 * under a heading that was also the pop-up's name.
 *
 * **One draft, one Save, and that is a fix rather than a preference.** This block
 * shipped with *two* saving mechanisms: some fields owned their own state and
 * committed on blur, the rest were bound to a shared `draft` written by the Save
 * button — and `save()` wrote all of them from `draft`. So the fields that saved
 * themselves left `draft` holding their original empty value, Save sent that
 * empty value, and an empty value means `clear`. **Pressing Save deleted exactly
 * the fields that had just been saved**, and the screen then correctly reported
 * them as not set, which reads as the form having ignored everything typed into
 * it. Two ways to write one piece of state is not redundancy, it is a race with
 * a winner nobody chose. `webcheck` pins exactly one draft of the SMTP keys
 * and no `onBlur` in this file.
 *
 * Like `ServerSection`, this changes what `GET /v1/instance` reports — SMTP
 * state is `config.email`, and `adminMayInvite` fails closed on it — so every
 * answer goes through `store.refreshConfig()` as well as `setAnswer`.
 */
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

  const [draft, setDraft] = useState<SmtpDraft>(() => fromAnswer(answer));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  // The three controls on this screen `SettingField` does not draw, which is why
  // they are the three that had a `<label>` naming nothing — see that
  // component's own pairing.
  const securityId = useId();
  const passwordId = useId();
  const testId = useId();

  /*
   * Re-sync when the server's answer changes, but **never over unsaved edits**.
   *
   * Without the guard a "Reset to environment" on one field would throw away
   * whatever was typed into the other five; with it, the form follows the server
   * only while it has nothing of its own to lose.
   */
  useEffect(() => {
    if (!dirty) setDraft(fromAnswer(answer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer]);

  const field = (key: string): cp.SettingsAnswer["settings"][number] | undefined =>
    answer.settings.find((entry) => entry.key === key);
  const passwordField = field("smtp.password");
  /*
   * **Whether a password is stored here is `set` alone**, which is a narrower
   * question than "does one exist": one supplied by the environment exists,
   * works, and cannot be removed from a screen. The placeholder promising to
   * keep the stored one, and the Remove button, are drawn only in this arm — on
   * a fresh server the placeholder is an example and there is nothing to remove.
   * The sentence under the field is `secretFieldText`'s and nobody else's.
   */
  const passwordStored = passwordField?.set === true;
  const problem = smtpProblem(draft);

  const edit = (patch: Partial<SmtpDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
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
    /*
     * **An empty password field leaves the stored one alone.** The other reading
     * — empty clears it — is the one that silently breaks delivery, so the field
     * says so on screen and clearing is its own act below.
     */
    if (password.length > 0) wanted["smtp.password"] = password;

    // A field left empty is *cleared* rather than stored as "", because "" is a
    // real value here — `smtp.username = ""` means "this server wants no
    // username" — and storing it would shadow the environment with a blank.
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
        setDraft(fromAnswer(updated));
        onChanged(updated);
        setPassword("");
        // The toast is the whole of the success signal (decision 6A). The
        // button never becomes a label: "Saved" as a disabled button read as a
        // control that had stopped working.
        toast("ok", "Saved.");
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  /*
   * A per-field reset or the password's Remove: one key cleared, **regardless of
   * the form's dirtiness**. `dirty` is left alone rather than reset — the other
   * fields' edits are still the person's and are not thrown away because one
   * value went back to the environment. The re-sync effect above is what would
   * have discarded them, and it is gated on `dirty` for exactly this reason.
   */
  const clearKey = (key: string): void => {
    setBusy(true);
    void cp
      .adminSaveSettings({ clear: [key] })
      .then((updated) => {
        setRemoving(false);
        onChanged(updated);
        if (!dirty) setDraft(fromAnswer(updated));
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
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

  /*
   * Why Send is off, said beside it whether or not the form is dirty. A test
   * sends with what is *stored*, so "the test passed" has to be a statement
   * about the configuration that will actually run — and a server with nothing
   * stored has nothing to test.
   */
  const sendBlocked = dirty ? "Save first." : !answer.mail.configured ? "Configure the server first." : null;

  return (
    <div>
      {/*
       * The one scope line a screen may keep: the title cannot carry what this
       * is *for*, and this is the screen where somebody decides not to bother.
       * With SMTP unconfigured there is no recovery channel at all.
       */}
      <p className="text-xs text-muted">Needed for sign-up confirmation and password resets.</p>

      <SettingField
        label="Host"
        value={draft.host}
        onChange={(next) => edit({ host: next })}
        field={field("smtp.host")}
        onReset={() => clearKey("smtp.host")}
        placeholder="smtp.example.com"
      />
      <SettingField
        label="Port"
        value={draft.port}
        onChange={(next) => edit({ port: next })}
        field={field("smtp.port")}
        onReset={() => clearKey("smtp.port")}
        placeholder="587"
        hint="Not 25 — usually blocked."
      />

      <div className="mt-3 max-w-sm">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={securityId} className={`block ${FIELD_LABEL}`}>
            Security
          </label>
          {/* The same provenance line and Reset its siblings get: the select
              was the one field on the form that said nothing about where its
              value came from. */}
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
        placeholder="register@example.com"
      />

      {/*
        **Write-only, and the screen never claims to know it.** Empty on every
        load, and the placeholder is not dots — dots are the lie, because they
        claim a value. What it shows instead is a sentence the server's answer
        decides.
      */}
      <div className="mt-3 max-w-sm">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={passwordId} className={`block ${FIELD_LABEL}`}>
            Password
          </label>
          {passwordStored &&
            (removing ? (
              <span className="flex flex-wrap items-center justify-end gap-2">
                <span className="text-xs text-muted">Remove the stored password?</span>
                <Button size="sm" tone="plain" disabled={busy} onClick={() => clearKey("smtp.password")}>
                  {busy ? <Spinner /> : "Remove"}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => setRemoving(false)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button size="sm" tone="ghost" disabled={busy} onClick={() => setRemoving(true)}>
                Remove
              </Button>
            ))}
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
        {/* One sentence, carrying both existence and provenance, because as two
            it could contradict itself — see `secretFieldText`. */}
        <p className="mt-1 text-2xs text-faint">{secretFieldText(passwordField)}</p>
      </div>

      <SettingField
        label="From address"
        value={draft.from}
        onChange={(next) => edit({ from: next })}
        field={field("mail.from")}
        onReset={() => clearKey("mail.from")}
        placeholder="register@example.com"
      />
      <SettingField
        label="Public URL"
        value={draft.publicUrl}
        onChange={(next) => edit({ publicUrl: next })}
        field={field("mail.public_url")}
        onReset={() => clearKey("mail.public_url")}
        // The value the app already knows: the origin this page was served
        // from is, on every ordinary deployment, the one links in mail should
        // point at.
        placeholder={window.location.origin}
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
        {/* Inline and persistent rather than a toast: an SMTP failure is a
            paragraph, and a toast is a dismissible paragraph. */}
        {testResult !== null && <p className="mt-2 max-w-sm text-sm">{testResult}</p>}
        {!dirty &&
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

/**
 * The provenance line for the one control `SettingField` does not draw.
 *
 * Two tiny pieces rather than a `select` variant of `SettingField`: the field
 * primitive is an `<input>` by construction and a `kind` union there would be a
 * second component wearing one name. They call the same two `instance.ts`
 * functions that primitive does, so the select's line cannot drift from its
 * siblings'.
 */
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

/**
 * What is wrong with delivery, on the screen an admin already configures it from.
 *
 * The only surface in the product that can say mail is broken. Everything else
 * reports the *queue*: `send()` answers whether a row was inserted and the Users
 * screen says "Invitation sent", so a provider that started rejecting the
 * sender produced a green toast and a person who never heard from us.
 *
 * **Bordered rather than filled.** `bg-fg` is the affirmative action inside a
 * decision and nothing else, and there is no decision here — this is a
 * statement. `edge-strong` is what identifies a bounded box in this palette,
 * which is the same treatment every field on this screen already has.
 *
 * `mailTrouble` returning `null` covers three different states on purpose —
 * nothing wrong, nothing queued, and *nothing known* — because a control plane
 * rolled back past the `delivery` object should draw no banner rather than an
 * all-clear it cannot support.
 *
 * No `cpctl admin mail` line any more: CLI on a settings screen is a white-list
 * of three (decision 11A) and this was not one of them. The last error is still
 * drawn, because "550 sender not allowed" names the fix and a count never can.
 */
function MailTroubleNotice({ delivery }: { delivery: cp.MailDelivery | undefined }): ReactNode {
  const trouble = mailTrouble(delivery);
  if (trouble === null) return null;
  return (
    <div className="mt-3 max-w-sm rounded-md border border-edge-strong p-3">
      <p className="text-sm">{trouble.text}</p>
      {/*
        The last thing the server was told, verbatim. It is remote text from an
        admin-supplied host, truncated and CR/LF-stripped where it is recorded.
      */}
      {delivery?.lastError != null && trouble.kind !== "backlog" && (
        <p className="mt-1 break-words font-mono text-xs text-muted">{delivery.lastError}</p>
      )}
    </div>
  );
}
