import { useEffect, useState, type ReactNode } from "react";
import * as cp from "../../cp";
import { errorText } from "../../http";
import { MACHINE_LIMIT_KEY, fleetMachineLimitNotice, machineLimitProblem } from "../../quota";
import { store } from "../../store";
import { Badge, Button, Empty, SETTINGS_HEADING, SETTINGS_SECTION, Spinner } from "../bits";
import { toast } from "../Toast";
import { OneTimeSecret } from "./OneTimeSecret";
import { SettingField, settingValue } from "./SettingField";

/**
 * Registration, the domains it is open to, the machine limit, and the
 * provisioning key. Four decisions, one screen.
 *
 * **The SMTP form is not here any more** — it is `EmailSection`, its own row
 * under Admin. It was nine fields and a test send at the bottom of this scroll,
 * under three controls that each fit on one line, and the one admin screen
 * somebody sets up once from a phone was the one furthest down. The split is by
 * what you came to do; what stays here is what decides *who gets an account and
 * how many machines they get*.
 *
 * Registration comes first even though it depends on email, because burying a
 * one-decision control under anything is the wrong shape — and the dependency
 * is stated by the confirmation rather than by the order.
 *
 * Both this screen and `EmailSection` are things that change what
 * `GET /v1/instance` reports, so both call `store.refreshConfig()` beside their
 * own `setAnswer` — see `adopt`.
 */
export function ServerSection(): ReactNode {
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

  /**
   * Take the new answer, and tell the store the instance changed underneath it.
   *
   * **Both halves, because this screen can change what `GET /v1/instance`
   * reports and the store had no way to find out.** `config` is loaded once by
   * `bootstrap` and then only re-read when it is `null`, on the strength of a
   * comment saying this screen patches it — which nothing did. So opening
   * registration left `state.config.registration` stale for the life of the
   * tab. Fire-and-forget: the section has already re-rendered from its own
   * answer, and a failure here is the same non-event `loadConfig`'s bare catch
   * describes.
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

  return (
    <div>
      <Registration answer={answer} onChanged={adopt} />
      {/* Its own section with a rule above it, like every other block here.
          It was nested inside Registration, which made the two read as one
          control with a stray field under it. */}
      <Domains answer={answer} onChanged={adopt} />
      {/*
       * Its own section rather than a child of either neighbour: it is neither
       * registration nor provisioning, so it cannot sit under one of their
       * headings without the heading making a claim about it. It is
       * registration-adjacent on the merits, since it decides what somebody
       * finds after they confirm.
       */}
      <MachineLimit answer={answer} onChanged={adopt} />
      <ProvisioningKey />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/**
 * Open or closed, as a badge and one verb.
 *
 * **Not a switch, and it was one** (decision 7A). A `role="switch"` promises
 * that a tap flips it, and this one could not keep that promise in either
 * direction: opening waits behind a confirmation, so the knob sat still after
 * the tap and read as broken; and drawing it moved before the server answered
 * would have been the optimistic paint `web-shell.md` forbids. A badge reports
 * the stored state and a button names the act, which is the shape every other
 * confirming control on a settings row already has.
 *
 * **Asymmetric on purpose** (Q3.220): only the act that *widens* authority is
 * confirmed. Opening replaces the button with the question and its two answers,
 * Cancel last; closing is one tap. The badge flips on the 200 and never before.
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
      <div className="mt-2 flex min-h-11 flex-wrap items-center gap-2">
        <Badge tone="strong">{open ? "Open" : "Closed"}</Badge>
        {confirming ? (
          /*
           * The consequence lives here and nowhere at rest (decision 10A): a
           * two-step control is a bare button until it is tapped, and its cost
           * is the confirmation's text. Without mail nothing verifies who signs
           * up — which is the one thing worth saying before opening the door.
           */
          <>
            <span className="text-sm">Open registration to anyone?</span>
            <Button tone="plain" size="sm" disabled={busy} onClick={() => set(true)}>
              {busy ? <Spinner /> : "Open"}
            </Button>
            {/* Cancel last: the same pixels the confirming button occupied. */}
            <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => (open ? set(false) : setConfirming(true))}>
            {busy ? <Spinner /> : open ? "Close registration" : "Open registration"}
          </Button>
        )}
      </div>
      {confirming && !answer.mail.configured && (
        <p className="mt-1 text-xs text-muted">Without email nobody is verified.</p>
      )}
    </section>
  );
}

/**
 * The one field in this section, with an explicit Save of its own.
 *
 * Explicit rather than committing on blur, for the reason `EmailSection`'s
 * docblock records at length: a field that writes itself is a second way to save
 * the same state, and the moment anything else can write that key the two race.
 * Here there is nothing else — and it is still explicit, so the next field added
 * beside it inherits the safe shape rather than the convenient one.
 *
 * **Save is always drawn and disabled until dirty.** A button that materialises
 * on the first keystroke is a layout shift under the finger that caused it, and
 * a form whose only button appears after you type is a form with no visible way
 * to finish.
 */
function Domains({
  answer,
  onChanged,
}: {
  answer: cp.SettingsAnswer;
  onChanged: (next: cp.SettingsAnswer) => void;
}): ReactNode {
  const stored = settingValue(answer, "registration.email_domains");
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
        setDraft(settingValue(updated, "registration.email_domains"));
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section className={SETTINGS_SECTION}>
      {/* The `<h2>` is back: a section with no heading between two that have
          one read as a stray field under Registration. The field's own label
          is "Allowed", which is what the heading does not already say. */}
      <h2 className={SETTINGS_HEADING}>Domains</h2>
      <SettingField
        label="Allowed"
        value={draft}
        onChange={setDraft}
        field={field}
        onReset={() => write({ clear: ["registration.email_domains"] })}
        placeholder="reemoat.com"
        hint="Comma-separated; empty allows any."
      />
      <Button
        tone="primary"
        size="sm"
        className="mt-2"
        disabled={busy || !dirty}
        onClick={() =>
          write(
            draft.trim().length === 0
              ? { clear: ["registration.email_domains"] }
              : { set: { "registration.email_domains": draft.trim() } },
          )
        }
      >
        {busy ? <Spinner /> : "Save"}
      </Button>
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
  const stored = settingValue(answer, MACHINE_LIMIT_KEY);
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
   * Same rule as its sibling: confirm iff the notice is non-null. The notice is
   * drawn **only in the confirm arm** (decision 10A) — at rest this is a field
   * and a disabled Save.
   */
  const consequence = dirty && problem === null ? fleetMachineLimitNotice(stored, draft) : null;

  const write = (patch: { set?: Record<string, string>; clear?: string[] }): void => {
    setBusy(true);
    void cp
      .adminSaveSettings(patch)
      .then((updated) => {
        setConfirming(false);
        onChanged(updated);
        setDraft(settingValue(updated, MACHINE_LIMIT_KEY));
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
      <h2 className={SETTINGS_HEADING}>Machine limit</h2>

      {/* Hint from `quota.ts` rather than prose here: the ceiling is a number
          that module owns, and a sentence about it written twice drifts. */}
      <SettingField
        label="Per person"
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
        <Button
          tone="primary"
          size="sm"
          className="mt-2"
          disabled={busy || !dirty || problem !== null}
          // Raising costs nobody anything and lands at once; only a lowering,
          // which switches machines off across the whole fleet, states itself
          // first.
          onClick={() => (consequence === null ? save() : setConfirming(true))}
        >
          {busy ? <Spinner /> : "Save"}
        </Button>
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
 * **Remint is two-step, and that reverses "no confirmation, a leak must be
 * closable in one tap"** (decision 12A). The argument that won: the cost of a
 * remint does not land on the person tapping. It lands on whatever script is
 * provisioning with the old key, on a machine the admin may not be looking at —
 * which is Q3.219's mirror. Your own API key is one tap because you are the one
 * who pays; a provisioning key is two because somebody else's script does. A
 * leak is still closable in two taps on one row, and the first mint, which
 * retires nothing, stays one.
 *
 * The minted key is shown through `OneTimeSecret` for the reason an admin-created
 * password is: only a hash is stored, so this is the one moment it exists.
 */
function ProvisioningKey(): ReactNode {
  const [minted, setMinted] = useState<boolean | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
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

  const mint = (): void => {
    setBusy(true);
    void cp
      .adminMintProvisioningKey()
      .then((answer) => {
        setShown(answer.key);
        setMinted(true);
        setConfirming(false);
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
           * sending `null` for `smtp.password`. There is deliberately no way to
           * turn provisioning off: it would be a third state for a fleet that
           * either hands out hosts or does not.
           */}
          <div className="mt-2 flex min-h-11 flex-wrap items-center gap-2">
            <Badge tone="strong">{minted ? "minted" : "none"}</Badge>
            {minted && confirming ? (
              <>
                <span className="text-sm">Replace the provisioning key?</span>
                <Button tone="plain" size="sm" disabled={busy} onClick={mint}>
                  {busy ? <Spinner /> : "Replace"}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={busy} onClick={minted ? () => setConfirming(true) : mint}>
                {busy ? <Spinner /> : minted ? "Remint" : "Mint a key"}
              </Button>
            )}
          </div>
          {minted && confirming && (
            <p className="mt-1 text-xs text-muted">Retires the current key. Anything provisioning with it stops.</p>
          )}

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
                note="Shown once. Never store it on a daemon host."
                onDone={() => setShown(null)}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
