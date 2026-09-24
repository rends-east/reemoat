import { useEffect, useState, type ReactNode } from "react";
import * as cp from "../../cp";
import { errorText } from "../../http";
import { MACHINE_LIMIT_KEY, fleetMachineLimitNotice, machineLimitProblem } from "../../quota";
import { store } from "../../store";
import { Badge, Button, Empty, SETTINGS_HEADING, SETTINGS_SECTION, Spinner, TwoStep } from "../bits";
import { toast } from "../Toast";
import { OneTimeSecret } from "./OneTimeSecret";
import { SettingField, settingValue } from "./SettingField";

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

  // This screen changes what GET /v1/instance reports, so the store's config is refreshed too.
  const adopt = (next: cp.SettingsAnswer): void => {
    setAnswer(next);
    void store.refreshConfig();
    // The admin is subject to the limit they just changed, so their own quota is refreshed too.
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
      <Domains answer={answer} onChanged={adopt} />
      <MachineLimit answer={answer} onChanged={adopt} />
      <ProvisioningKey />
    </div>
  );
}

// Only opening, which widens authority, is confirmed; the badge flips on the 200 and never before (Q3.220).
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

  const save = (next: boolean): Promise<void> =>
    cp
      .adminSaveSettings({ set: { "registration.enabled": next ? "true" : "false" } })
      .then((updated) => onChanged(updated));
  const close = (): void => {
    setBusy(true);
    void save(false)
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section>
      <h2 className={SETTINGS_HEADING}>Registration</h2>
      <TwoStep
        armed={confirming}
        onArm={setConfirming}
        className="mt-2 min-h-11"
        lead={<Badge tone="strong">{open ? "Open" : "Closed"}</Badge>}
        question="Open registration to anyone?"
        act={{ label: "Open" }}
        onAct={() => save(true)}
        rest={
          <Button size="sm" disabled={busy} onClick={() => (open ? close() : setConfirming(true))}>
            {busy ? <Spinner /> : open ? "Close registration" : "Open registration"}
          </Button>
        }
      />
      {confirming && !answer.mail.configured && (
        <p className="mt-1 text-xs text-muted">Without email nobody is verified.</p>
      )}
    </section>
  );
}

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
      <h2 className={SETTINGS_HEADING}>Domains</h2>
      <SettingField
        label="Allowed"
        value={draft}
        onChange={setDraft}
        field={field}
        onReset={() => write({ clear: ["registration.email_domains"] })}
        busy={busy}
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
  const consequence = dirty && problem === null ? fleetMachineLimitNotice(stored, draft) : null;

  // One lock around every write, so the field's Reset is greyed while a confirmed lowering is out.
  const write = (patch: { set?: Record<string, string>; clear?: string[] }): Promise<void> => {
    setBusy(true);
    return cp
      .adminSaveSettings(patch)
      .then((updated) => {
        onChanged(updated);
        setDraft(settingValue(updated, MACHINE_LIMIT_KEY));
      })
      .finally(() => setBusy(false));
  };
  // One-tap paths clear the arming flag, or the next lowering would draw the pair with no tap on Save.
  const writeNow = (patch: { set?: Record<string, string>; clear?: string[] }): void => {
    void write(patch)
      .then(() => setConfirming(false))
      .catch((cause: unknown) => toast("error", errorText(cause)));
  };

  const savePatch = (): { set?: Record<string, string>; clear?: string[] } =>
    draft.trim().length === 0 ? { clear: [MACHINE_LIMIT_KEY] } : { set: { [MACHINE_LIMIT_KEY]: draft.trim() } };

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Machine limit</h2>

      <SettingField
        label="Per person"
        value={draft}
        onChange={setDraft}
        field={field}
        onReset={() => writeNow({ clear: [MACHINE_LIMIT_KEY] })}
        busy={busy}
        placeholder="2"
      />
      {problem !== null && <p className="mt-2 text-sm text-danger">{problem}</p>}
      <TwoStep
        armed={confirming && consequence !== null}
        onArm={setConfirming}
        className="mt-2"
        question={consequence}
        act={{ label: "Save limit" }}
        onAct={() => write(savePatch())}
        disabled={busy}
        rest={
          <Button
            tone="primary"
            size="sm"
            disabled={busy || !dirty || problem !== null}
            // Only a lowering, which switches machines off fleet-wide, confirms first.
            onClick={() => (consequence === null ? writeNow(savePatch()) : setConfirming(true))}
          >
            {busy ? <Spinner /> : "Save"}
          </Button>
        }
      />
    </section>
  );
}

// A credential rather than a setting, so it fetches its own state. Remint is two-step because its cost
// lands on whatever script provisions with the old key (Q3.219).
function ProvisioningKey(): ReactNode {
  const [minted, setMinted] = useState<boolean | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = (): void => {
    setLoadError(null);
    void cp
      .adminHasProvisioningKey()
      .then(setMinted)
      .catch((cause: unknown) => setLoadError(errorText(cause)));
  };
  useEffect(load, []);

  const mint = (): Promise<void> =>
    cp.adminMintProvisioningKey().then((answer) => {
      setShown(answer.key);
      setMinted(true);
    });
  const mintNow = (): void => {
    setBusy(true);
    void mint()
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
          {/* Never draw the key, a prefix or an id: only whether one exists. */}
          <TwoStep
            armed={minted && confirming}
            onArm={setConfirming}
            className="mt-2 min-h-11"
            lead={<Badge tone="strong">{minted ? "minted" : "none"}</Badge>}
            question="Replace the provisioning key?"
            act={{ label: "Replace" }}
            onAct={mint}
            rest={
              <Button size="sm" disabled={busy} onClick={minted ? () => setConfirming(true) : mintNow}>
                {busy ? <Spinner /> : minted ? "Remint" : "Mint a key"}
              </Button>
            }
          />
          {minted && confirming && (
            <p className="mt-1 text-xs text-muted">Retires the current key. Anything provisioning with it stops.</p>
          )}

          {shown !== null && (
            <div className="mt-3">
              <OneTimeSecret
                label="Provisioning key"
                value={shown}
                // Never advise storing it on a daemon host: an agent there runs as its owner.
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
