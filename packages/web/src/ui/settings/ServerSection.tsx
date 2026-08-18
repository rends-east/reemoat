import { useEffect, useId, useState, type ReactNode } from "react";
import * as cp from "../../cp";
import { errorText } from "../../http";
import { MACHINE_LIMIT_KEY, fleetMachineLimitNotice, machineLimitProblem } from "../../quota";
import { store } from "../../store";
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
import { Button, Empty, FIELD, SETTINGS_HEADING, SETTINGS_SECTION, Spinner } from "../bits";
import { toast } from "../Toast";
import { OneTimeSecret } from "./OneTimeSecret";

/**
 * Registration, email, and what actually went out.
 *
 * Registration comes first even though it depends on email, because burying a
 * one-decision control under a nine-field form is the wrong shape — and the
 * dependency is stated by the control itself rather than by the order.
 */
export function ServerSection(): ReactNode {
  const [answer, setAnswer] = useState<cp.SettingsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    void cp
      .adminSettings()
      .then(setAnswer)
      .catch((cause: unknown) => setError(errorText(cause)));
  };
  useEffect(load, []);

  /**
   * Take the new answer, and tell the store the instance changed underneath it.
   *
   * **Both halves, because this screen is the only thing that can change what
   * `GET /v1/instance` reports and the store had no way to find out.** `config`
   * is loaded once by `bootstrap` and then only re-read when it is `null`, on the
   * strength of a comment saying this screen patches it — which nothing did. So
   * turning SMTP on left `state.config.email` false for the life of the tab, and
   * `adminMayInvite` fails closed, so Settings → Users went on offering no
   * address field and no invitations while mail worked.
   *
   * Fire-and-forget: the section has already re-rendered from its own answer, and
   * a failure here is the same non-event `loadConfig`'s bare catch describes.
   */
  const adopt = (next: cp.SettingsAnswer): void => {
    setAnswer(next);
    void store.refreshConfig();
    /*
     * And the admin's own quota, because they are subject to the limit they just
     * changed. Without this, an admin who sets the default to 0 keeps their own
     * `+` in the rail — and the add form in Settings → Machines — for the life
     * of the tab, both of them onto a `409 machine_limit`. The same class of
     * staleness `refreshConfig` is here for, about a different route.
     */
    void store.refreshMe();
  };

  if (error !== null) return <Empty>{error}</Empty>;
  if (answer === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  return (
    <div>
      <Registration answer={answer} onChanged={adopt} />
      {/* Its own section with a rule above it, like every other block here.
          It was nested inside Registration, which made the two read as one
          control with a stray field under it. */}
      <Domains answer={answer} onChanged={adopt} />
      {/*
       * Above Email, and its own section rather than a child of either.
       *
       * It is neither registration nor mail, so it cannot sit under one of their
       * headings without the heading making a claim about it. Above the SMTP
       * form for the reason this section's own docblock gives about burying a
       * one-decision control under a nine-field one — and it is
       * registration-adjacent on the merits, since it decides what somebody
       * finds after they confirm.
       */}
      <MachineLimit answer={answer} onChanged={adopt} />
      <ProvisioningKey />
      <Email answer={answer} onChanged={adopt} />
    </div>
  );
}

const value = (answer: cp.SettingsAnswer, key: string): string =>
  answer.settings.find((field) => field.key === key)?.value ?? "";

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/**
 * A switch, hand-rolled, because there is no shared one and the palette decides
 * how it may look.
 *
 * This was a single button labelled with its destination ("Open registration" /
 * "Close registration"), which was chosen over a segmented control on the
 * grounds that this palette cannot express *selection*: `bg-fg` is the
 * affirmative action inside a decision and may not mean "on", and `bg-raised` —
 * the one fill spent on state — is 1.10:1 against the surface.
 *
 * That constraint did not go away, so the switch answers it the way the rest of
 * this app answers "no colour left to spend": **with position.** The knob moving
 * is the signal, the track's `bg-raised` supports it, `edge-strong` bounds it
 * like every other unfilled control, and the word beside it makes the state
 * readable without decoding a 16px dot.
 *
 * `AgentConfigBar`'s `Toggle` was not reused: it is a chip typed to
 * `AgentConfigOption`, sized for the composer strip, and generalising it for one
 * settings row would couple two screens that share nothing but a shape.
 */
function Registration({
  answer,
  onChanged,
}: {
  answer: cp.SettingsAnswer;
  onChanged: (next: cp.SettingsAnswer) => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = answer.registration.enabled;

  const set = (next: boolean): void => {
    setBusy(true);
    void cp
      .adminSaveSettings({ set: { "registration.enabled": next ? "true" : "false" } })
      .then((updated) => {
        onChanged(updated);
        setConfirming(false);
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section>
      <h2 className={SETTINGS_HEADING}>Registration</h2>

      {/*
       * A switch, and **position is what carries the state**, not colour.
       *
       * This spot rejected a segmented control once with a reason that binds a
       * toggle just as hard: `bg-fg` is the affirmative action *inside* a
       * decision and may not mean "on", and the only fill this palette spends on
       * state is `raised`, which is 1.10:1 against the surface. So the knob
       * moving is the signal a person actually reads, `bg-raised` on the track
       * supports it, and `edge-strong` bounds it — the same identification every
       * other unfilled control here gets. The word beside it is the switch's own
       * label rather than a caption: without it the state is one 12px knob.
       */}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={open}
          aria-label="Registration"
          disabled={busy}
          onClick={() => (open ? set(false) : setConfirming(true))}
          className={`tap relative h-6 w-11 shrink-0 rounded-full border border-edge-strong transition-colors ${
            open ? "bg-raised" : "bg-surface"
          } ${busy ? "opacity-40" : ""}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-fg transition-[left] ${
              open ? "left-[calc(100%-1.25rem)]" : "left-0.5"
            }`}
          />
        </button>
        <span className="text-sm">{open ? "Open" : "Closed"}</span>
        {busy && <Spinner />}
      </div>

      {confirming && (
        /*
         * The two-step confirmation survives the toggle, and only on the act
         * that **widens** authority — closing narrows it and flips at once. The
         * consequence sits where the decision is being made and depends on
         * whether mail works, because without it nothing verifies who signs up
         * and nobody can recover a password afterwards.
         *
         * The switch stays *off* until this is answered: it reports the stored
         * state, not the intent, so cancelling leaves nothing to undo.
         */
        <div className="mt-3 max-w-sm rounded-lg border border-edge-strong p-3">
          <p className="text-sm">
            {answer.mail.configured
              ? "They must confirm an email address before the account exists."
              : "Nothing will verify who they are, and nobody will be able to reset a password until email is configured."}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button tone="plain" disabled={busy} onClick={() => set(true)}>
              {busy ? <Spinner /> : "Open registration"}
            </Button>
            {/* Cancel last: the same pixels the confirming button occupied. */}
            <Button disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The one field in this section, with an explicit Save of its own.
 *
 * Explicit rather than committing on blur, for the reason the Email block's
 * docblock records at length: a field that writes itself is a second way to save
 * the same state, and the moment anything else can write that key the two race.
 * Here there is nothing else — and it is still explicit, so the next field added
 * beside it inherits the safe shape rather than the convenient one.
 */
function Domains({
  answer,
  onChanged,
}: {
  answer: cp.SettingsAnswer;
  onChanged: (next: cp.SettingsAnswer) => void;
}): ReactNode {
  const stored = value(answer, "registration.email_domains");
  const [draft, setDraft] = useState(stored);
  const [busy, setBusy] = useState(false);
  const dirty = draft !== stored;
  const field = answer.settings.find((entry) => entry.key === "registration.email_domains");

  const write = (patch: { set?: Record<string, string>; clear?: string[] }): void => {
    setBusy(true);
    void cp
      .adminSaveSettings(patch)
      .then((updated) => {
        onChanged(updated);
        setDraft(value(updated, "registration.email_domains"));
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Allowed domains</h2>
      <Field
        label="Allowed domains"
        value={draft}
        onChange={setDraft}
        field={field}
        onReset={() => write({ clear: ["registration.email_domains"] })}
        placeholder="reemoat.com"
        hint="Comma-separated. Empty means any address. A refused address reads exactly like a malformed one — the list is never published."
      />
      {dirty && (
        <Button
          tone="primary"
          size="sm"
          className="mt-2"
          disabled={busy}
          onClick={() =>
            write(
              draft.trim().length === 0
                ? { clear: ["registration.email_domains"] }
                : { set: { "registration.email_domains": draft.trim() } },
            )
          }
        >
          {busy ? <Spinner /> : "Save domains"}
        </Button>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Machines
 * ------------------------------------------------------------------ */

/**
 * How many machines each person gets, unless an admin says otherwise.
 *
 * `Domains`' shape exactly — local draft, a `dirty` flag, an explicit Save, and
 * empty meaning `clear` rather than a stored `""`. Validation goes through
 * `machineLimitProblem`, which is the **same** function the per-user panel in
 * `UsersSection` calls: one rule with two screens, rather than the `smtpProblem`
 * situation of one rule with two copies.
 *
 * The key is a module constant instead of the four string literals `Domains`
 * carries, so the read, the reset, the set and the clear cannot drift apart.
 */
function MachineLimit({
  answer,
  onChanged,
}: {
  answer: cp.SettingsAnswer;
  onChanged: (next: cp.SettingsAnswer) => void;
}): ReactNode {
  const stored = value(answer, MACHINE_LIMIT_KEY);
  const [draft, setDraft] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const dirty = draft !== stored;
  const field = answer.settings.find((entry) => entry.key === MACHINE_LIMIT_KEY);
  const problem = machineLimitProblem(draft);
  /*
   * **This screen moves every account on the instance, and it used to do it on
   * one tap.** The per-user panel in `UsersSection` confirms a lowering; this
   * one, which is strictly wider, did not — no question, no sentence, and no
   * feedback afterwards either, because `adminSaveSettings` answers settings
   * rather than the `suspended` list the per-user verb returns.
   *
   * Same rule as its sibling: confirm iff the notice is non-null.
   */
  const consequence = dirty && problem === null ? fleetMachineLimitNotice(stored, draft) : null;

  const write = (patch: { set?: Record<string, string>; clear?: string[] }): void => {
    setBusy(true);
    void cp
      .adminSaveSettings(patch)
      .then((updated) => {
        setConfirming(false);
        onChanged(updated);
        setDraft(value(updated, MACHINE_LIMIT_KEY));
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  const save = (): void =>
    write(
      draft.trim().length === 0 ? { clear: [MACHINE_LIMIT_KEY] } : { set: { [MACHINE_LIMIT_KEY]: draft.trim() } },
    );

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Machines</h2>

      {/* No blurb and no hint: the explanation goes in the docs rather than on
          the screen. `Field`'s provenance line stays, because that is state
          rather than prose — it says which of the row and the environment won. */}
      <Field
        label="Machines per person"
        value={draft}
        onChange={setDraft}
        field={field}
        onReset={() => write({ clear: [MACHINE_LIMIT_KEY] })}
        placeholder="2"
      />
      {problem !== null && <p className="mt-2 text-sm text-danger">{problem}</p>}
      {confirming && consequence !== null ? (
        <>
          <p className="mt-2 text-xs text-muted">{consequence}</p>
          {/*
           * `plain` and Cancel **last**, the same pair every confirming control
           * in this app uses: both groups occupy one box so the last child lands
           * on the pixels the tapped button just left, `.tap` removes the
           * double-tap delay, and a second tap aimed at a control that looked
           * inert must reach the undo rather than the act.
           */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button tone="plain" size="sm" disabled={busy} onClick={save}>
              {busy ? <Spinner /> : "Save limit"}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        dirty && (
          <Button
            tone="primary"
            size="sm"
            className="mt-2"
            disabled={busy || problem !== null}
            // Raising costs nobody anything and lands at once; only a lowering,
            // which switches machines off across the whole fleet, states itself
            // first.
            onClick={() => (consequence === null ? save() : setConfirming(true))}
          >
            {busy ? <Spinner /> : "Save limit"}
          </Button>
        )
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The fleet provisioning key
 * ------------------------------------------------------------------ */

/**
 * One key that adds a daemon for anybody, and the two acts that manage it.
 *
 * **It fetches its own state rather than riding `SettingsAnswer`.** Everything
 * else on this screen is a *setting* — a value with an environment underneath it
 * and a provenance line — and this is a credential: it has a prefix rather than
 * a value, no environment fallback, and the only write that produces anything is
 * one that cannot be repeated. Folding it into `settings` would have meant a
 * secret-shaped member of a table whose whole contract is "value, and where it
 * came from".
 *
 * The minted key is shown through `OneTimeSecret` for the reason an admin-created
 * password is: only a hash is stored, so this is the one moment it exists.
 */
function ProvisioningKey(): ReactNode {
  const [minted, setMinted] = useState<boolean | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * **A spinner is a claim that a request is in flight, and this one outlived
   * every request it described.** The catch below only raised a toast, which is
   * transient, and left `minted` at `null` — the value the render reads as
   * "still loading" — so a failed read parked this panel on `Loading…` for the
   * life of the mount, with no sentence, no retry, and no way to reach the one
   * control that mints a key. `ServerSection` itself has an `error !== null` arm
   * for exactly this; this panel loads separately and had none.
   */
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = (): void => {
    setLoadError(null);
    void cp
      .adminHasProvisioningKey()
      .then(setMinted)
      .catch((cause: unknown) => setLoadError(errorText(cause)));
  };
  useEffect(load, []);

  const remint = (): void => {
    setBusy(true);
    void cp
      .adminMintProvisioningKey()
      .then((answer) => {
        setShown(answer.key);
        setMinted(true);
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Provisioning key</h2>

      {loadError !== null ? (
        <div className="mt-3">
          <p className="text-sm text-danger">{loadError}</p>
          <Button size="sm" className="mt-2" onClick={load}>
            Try again
          </Button>
        </div>
      ) : minted === null ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Spinner /> Loading…
        </div>
      ) : (
        <>
          {/*
           * **The key is never drawn — not the value, not a prefix, not an id.**
           * The only thing on screen is whether one exists, because that is the
           * only thing an admin can act on: there is one key and one verb.
           * Anything more would be a second place a live credential can be read
           * from, which is the rule `GET /v1/admin/settings` already follows by
           * sending `null` for `smtp.password`.
           */}
          <p className="mt-3 text-2xs text-faint">{minted ? "A key is minted." : "No key yet."}</p>

          {/*
           * One button, and no confirmation. Reminting is how a leak is closed,
           * so the tap somebody most needs must not be behind a question — and
           * the old key stopping is the point rather than a surprise. There is
           * deliberately no way to turn provisioning off: it would be a third
           * state for a fleet that either hands out hosts or does not.
           */}
          <Button size="sm" className="mt-2" disabled={busy} onClick={remint}>
            {busy ? <Spinner /> : minted ? "Remint" : "Mint a key"}
          </Button>

          {shown !== null && (
            <div className="mt-3">
              <OneTimeSecret
                label="Provisioning key"
                value={shown}
                /*
                 * **The warning replaced advice that was actively wrong.** This
                 * said "put it in REEMOAT_CP_PROVISION_KEY where a host is
                 * installed" — which is the one place it must never go: an agent
                 * on that host runs as its owner, and `agentEnv`'s strip is
                 * hygiene rather than a fence. Keep it where you provision
                 * *from*; what travels to a host is the enrollment code.
                 */
                note="Shown once — only its hash is stored. Keep it on the machine you provision from; never on a host that will run a daemon."
                onDone={() => setShown(null)}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Email
 * ------------------------------------------------------------------ */

/**
 * The SMTP form.
 *
 * **One draft, one Save, and that is a fix rather than a preference.** This block
 * shipped with *two* saving mechanisms: some fields owned their own state and
 * committed on blur, the rest were bound to a shared `draft` written by the Save
 * button — and `save()` wrote all of them from `draft`. So the fields that saved
 * themselves left `draft` holding their original empty value, Save sent that
 * empty value, and an empty value means `clear`. **Pressing Save deleted exactly
 * the fields that had just been saved**, and the screen then correctly reported
 * them as not set, which reads as the form having ignored everything typed into
 * it.
 *
 * The lesson is the one this codebase keeps relearning: two ways to write one
 * piece of state is not redundancy, it is a race with a winner nobody chose.
 */
function Email({
  answer,
  onChanged,
}: {
  answer: cp.SettingsAnswer;
  onChanged: (next: cp.SettingsAnswer) => void;
}): ReactNode {
  const fromAnswer = (source: cp.SettingsAnswer): SmtpDraft => ({
    host: value(source, "smtp.host"),
    port: value(source, "smtp.port"),
    security: value(source, "smtp.security") || "starttls",
    username: value(source, "smtp.username"),
    from: value(source, "mail.from"),
    publicUrl: value(source, "mail.public_url"),
  });

  const [draft, setDraft] = useState<SmtpDraft>(() => fromAnswer(answer));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  // The two controls on this screen `Field` does not draw, which is why they are
  // the two that had a `<label>` naming nothing — see `Field`'s own pairing.
  const securityId = useId();
  const passwordId = useId();

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

  const passwordField = answer.settings.find((field) => field.key === "smtp.password");
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
        toast("ok", "Saved.");
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  const resetField = (key: string): void => {
    setBusy(true);
    void cp
      .adminSaveSettings({ clear: [key] })
      .then((updated) => {
        setDirty(false);
        setDraft(fromAnswer(updated));
        onChanged(updated);
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  const sendTest = (): void => {
    setBusy(true);
    setTestResult(null);
    void cp
      .adminTestMail(testTo.trim().length > 0 ? testTo.trim() : undefined)
      // No longer "the result appears below" — there is no log below any more.
      // `cpctl admin mail` is where a delivery is looked up.
      .then((queued) => setTestResult(`Queued to ${queued.to}.`))
      .catch((cause: unknown) => setTestResult(errorText(cause)))
      .finally(() => setBusy(false));
  };

  const field = (key: string): cp.SettingsAnswer["settings"][number] | undefined =>
    answer.settings.find((entry) => entry.key === key);

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Email</h2>
      {/*
       * The one consequence an operator cannot recover from a field label, and
       * the reason this section is not optional-feeling: with SMTP unconfigured
       * there is no recovery channel at all, so a forgotten password is an
       * account an admin has to delete and recreate — which leaves that person's
       * machines revoked. Kept on screen rather than moved to the docs, because
       * this is the screen where somebody decides not to bother.
       */}
      <p className="mt-1 text-xs text-muted">
        Without it there is no registration confirmation and no password reset — an account that loses its password has
        no way back.
      </p>

      <Field
        label="Host"
        value={draft.host}
        onChange={(next) => edit({ host: next })}
        field={field("smtp.host")}
        onReset={() => resetField("smtp.host")}
        placeholder="mail.example.com"
        hint="The provider's submission server, not your own domain."
      />
      <Field
        label="Port"
        value={draft.port}
        onChange={(next) => edit({ port: next })}
        field={field("smtp.port")}
        onReset={() => resetField("smtp.port")}
        placeholder="587"
        hint="587 for STARTTLS, 465 for TLS. Never 25 — every major cloud blocks it outbound, and a blocked port hangs rather than refuses."
      />

      <label htmlFor={securityId} className={`mt-3 block ${SETTINGS_HEADING}`}>
        Security
      </label>
      <select
        id={securityId}
        value={draft.security}
        onChange={(event) => edit({ security: event.target.value })}
        className={`mt-1 w-full max-w-sm ${FIELD}`}
      >
        <option value="starttls">STARTTLS — upgrade a plain connection, usually port 587</option>
        <option value="implicit_tls">TLS — encrypted from the first byte, usually port 465</option>
        <option value="plaintext">None — plain SMTP, for a local relay only</option>
      </select>

      <Field
        label="Username"
        value={draft.username}
        onChange={(next) => edit({ username: next })}
        field={field("smtp.username")}
        onReset={() => resetField("smtp.username")}
        placeholder="register@example.com"
        hint="Almost always the full mailbox address, not the part before the @."
      />

      {/*
        **Write-only, and the screen never claims to know it.** Empty on every
        load, and the placeholder is not dots — dots are the lie, because they
        claim a value. What it shows instead is a boolean the server sent.
      */}
      <label htmlFor={passwordId} className={`mt-3 block ${SETTINGS_HEADING}`}>
        Password
      </label>
      <input
        id={passwordId}
        type="password"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          setDirty(true);
        }}
        autoComplete="off"
        placeholder="leave empty to keep the stored one"
        className={`mt-1 w-full max-w-sm ${FIELD}`}
      />
      <p className="mt-1 max-w-sm text-2xs text-faint">
        {/*
          One sentence, carrying both existence and provenance, because as two
          it could contradict itself — see `secretFieldText`. "Remove it" stays
          on `set` alone and that is not the same question: only a row here can
          be cleared, and an environment value cannot.
        */}
        {secretFieldText(passwordField)}
        {passwordField?.set === true && (
          <>
            {" · "}
            <button
              type="button"
              className="tap underline hover:text-fg"
              onClick={() => resetField("smtp.password")}
            >
              Remove it
            </button>
          </>
        )}
      </p>

      <Field
        label="From address"
        value={draft.from}
        onChange={(next) => edit({ from: next })}
        field={field("mail.from")}
        onReset={() => resetField("mail.from")}
        placeholder="register@example.com"
        hint="Both the From header and the envelope sender."
      />
      <Field
        label="Public URL"
        value={draft.publicUrl}
        onChange={(next) => edit({ publicUrl: next })}
        field={field("mail.public_url")}
        onReset={() => resetField("mail.public_url")}
        placeholder="https://cp.example.com"
        hint="Where links in messages point — the address people open in a browser, not the API's bind address."
      />

      {senderMismatch(draft) && (
        <p className="mt-3 max-w-sm text-xs text-muted">
          The from address is not the mailbox you sign in as. Many providers refuse that unless it is an alias of it
          — a relay that authorises a whole domain is the case where it is fine.
        </p>
      )}
      {problem !== null && <p className="mt-3 text-sm text-danger">{problem}</p>}

      <Button tone="primary" className="mt-4" disabled={busy || problem !== null || !dirty} onClick={save}>
        {busy ? <Spinner /> : dirty ? "Save" : "Saved"}
      </Button>

      <div className="mt-6">
        <h3 className={SETTINGS_HEADING}>Send a test</h3>
        <div className="mt-2 flex max-w-sm gap-2">
          <input
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
            placeholder="your address"
            type="email"
            aria-label="Test recipient"
            className={`min-w-0 flex-1 ${FIELD}`}
          />
          <Button disabled={busy || dirty || !answer.mail.configured} onClick={sendTest}>
            Send
          </Button>
        </div>
        {/*
          **Disabled while the form is dirty, with the reason on screen.** A test
          sends with what is *stored*, not with what is typed — so "the test
          passed" has to be a statement about the configuration that will
          actually run.
        */}
        {dirty && <p className="mt-2 text-xs text-muted">Save first — a test sends with what is stored.</p>}
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
    </section>
  );
}

/**
 * What is wrong with delivery, on the screen an admin already configures it from.
 *
 * The only surface in the product that can say mail is broken. Everything else
 * reports the *queue*: `send()` answers whether a row was inserted and the Users
 * screen says "Invitation queued", so a provider that started rejecting the
 * sender produced a green toast and a person who never heard from us.
 *
 * **Bordered rather than filled.** `bg-fg` is the affirmative action inside a
 * decision and nothing else, and there is no decision here — this is a statement,
 * and the one control it offers is the terminal command that answers the next
 * question. `edge-strong` is what identifies a bounded box in this palette, which
 * is the same treatment every field on this screen already has.
 *
 * `mailTrouble` returning `null` covers three different states on purpose —
 * nothing wrong, nothing queued, and *nothing known* — because a control plane
 * rolled back past the `delivery` object should draw no banner rather than an
 * all-clear it cannot support.
 */
function MailTroubleNotice({ delivery }: { delivery: cp.MailDelivery | undefined }): ReactNode {
  const trouble = mailTrouble(delivery);
  if (trouble === null) return null;
  return (
    <div className="mt-3 max-w-sm rounded-md border border-edge-strong p-3">
      <p className="text-sm">{trouble.text}</p>
      {/*
        The last thing the server was told, verbatim. It is remote text from an
        admin-supplied host, truncated and CR/LF-stripped where it is recorded —
        and it is the single most useful line here, because "550 sender not
        allowed" names the fix and a count never can.
      */}
      {delivery?.lastError != null && trouble.kind !== "backlog" && (
        <p className="mt-1 break-words font-mono text-xs text-muted">{delivery.lastError}</p>
      )}
      <p className="mt-2 text-xs text-muted">
        Where each message ended up is <code>cpctl admin mail</code>.
      </p>
    </div>
  );
}

/**
 * One field, its provenance, and the offer to give it back.
 *
 * **Presentational.** It owns no draft and saves nothing — that is the whole
 * repair: this component used to commit on blur while the Save button wrote the
 * same keys from a different state, and the two overwrote each other.
 *
 * The origin line is `text-2xs text-faint` under the field and **always
 * present**, so nothing shifts as a value is edited. Deliberately not a `Badge`:
 * six badges on a six-field form is six boxes, and `Badge`'s own rule is that a
 * box inside a row that already has one reads as a control somebody can press.
 *
 * Reset is drawn **only** where `canResetField` — the one case where its absence
 * is unambiguous, because the line underneath says why. No confirmation:
 * retyping the value undoes it.
 */
function Field({
  label,
  value: current,
  onChange,
  field,
  onReset,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  field: cp.SettingsAnswer["settings"][number] | undefined;
  onReset: () => void;
  placeholder?: string;
  hint?: string;
}): ReactNode {
  // `htmlFor`/`id`, the same pairing every other labelled control in this package
  // uses. Without it this `<label>` names nothing: nine of the eleven controls on
  // this screen are drawn by this component, and each announced as a bare "edit
  // text" — on the screen that configures the instance's only recovery channel.
  const id = useId();
  return (
    <div className="mt-3 max-w-sm">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className={`block ${SETTINGS_HEADING}`}>
          {label}
        </label>
        {field !== undefined && canResetField(field) && (
          <Button size="sm" tone="ghost" onClick={onReset}>
            Reset
          </Button>
        )}
      </div>
      <input
        id={id}
        value={current}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={`mt-1 w-full ${FIELD}`}
      />
      <p className="mt-1 text-2xs text-faint">{field === undefined ? "not set" : originText(fieldOrigin(field))}</p>
      {hint !== undefined && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
