import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import { errorText } from "../../http";
import { HARD_MACHINE_CEILING, MACHINE_LIMIT_KEY, fleetMachineLimitNotice, machineLimitProblem } from "../../quota";
import { navigate } from "../../router";
import { settingsLeafPath, settingsPath } from "../../settings";
import { store } from "../../store";
import { Badge, Button, Empty, SkeletonRow, Spinner, SwitchRow, TwoStep } from "../bits";
import { toast } from "../Toast";
import { Group, LinkRow, TWO_STEP_ROW } from "../kit/List";
import { OneTimeSecret } from "./OneTimeSecret";
import { SettingField, WithAdminSettings, provenanceBadge, settingField, settingValue } from "./SettingField";

// The minted key, handed to its leaf in module state rather than the URL; peeked in state, cleared on mount.
let handoff: string | null = null;

function peekHandoff(): string | null {
  return handoff;
}

function clearHandoff(): void {
  handoff = null;
}

const DOMAINS_KEY = "registration.email_domains";

// The admin is subject to the limit they change, so a write re-reads their own quota too.
const refreshOwnQuota = (): void => void store.refreshMe();

const back = (): void => navigate(settingsPath("server"), true);

export function ServerSection(): ReactNode {
  return (
    <WithAdminSettings onAdopt={refreshOwnQuota}>
      {(answer, adopt) => (
        <div>
          <Registration answer={answer} onChanged={adopt} />
          <Limits answer={answer} />
          <ProvisioningKey />
        </div>
      )}
    </WithAdminSettings>
  );
}

// Only opening, which widens authority, is confirmed; the switch draws the answer, so it flips on the 200 and never before (Q3.220).
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
    <Group>
      {/* Cancel lands on the knob's pixels (Q3.218); the resting switch carries its own row padding. */}
      <TwoStep
        armed={confirming}
        onArm={setConfirming}
        align="end"
        className={confirming ? TWO_STEP_ROW : ""}
        rest={<SwitchRow title="Open registration" on={open} busy={busy} onToggle={() => (open ? close() : setConfirming(true))} />}
        question="Open registration to anyone?"
        consequence={answer.mail.configured ? undefined : "Without email nobody is verified."}
        act={{ label: "Open" }}
        onAct={() => save(true)}
      />
    </Group>
  );
}

function Limits({ answer }: { answer: cp.SettingsAnswer }): ReactNode {
  const domains = settingValue(answer, DOMAINS_KEY).trim();
  const limit = settingValue(answer, MACHINE_LIMIT_KEY).trim();

  return (
    <Group title="Limits">
      <LinkRow
        title="Allowed domains"
        value={domains.length > 0 ? domains : "Any"}
        badge={provenanceBadge(settingField(answer, DOMAINS_KEY))}
        onClick={() => navigate(settingsLeafPath("domains"))}
      />
      <LinkRow
        title="Machines per person"
        // Unset is the ceiling, which is what an instance ran before the setting existed.
        value={limit.length > 0 ? limit : String(HARD_MACHINE_CEILING)}
        badge={provenanceBadge(settingField(answer, MACHINE_LIMIT_KEY))}
        onClick={() => navigate(settingsLeafPath("machine-limit"))}
      />
    </Group>
  );
}

// A credential rather than a setting, so it reads its own state. Remint is two-step because its cost
// lands on whatever script provisions with the old key (Q3.219).
function ProvisioningKey(): ReactNode {
  const [minted, setMinted] = useState<boolean | null>(null);
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

  // Minted on the tap, never on the leaf's mount; the leaf only shows what came back (Q3.549).
  const mint = (): Promise<void> =>
    cp.adminMintProvisioningKey().then((answer) => {
      handoff = answer.key;
      navigate(settingsLeafPath("provisioning-key"));
    });
  const mintNow = (): void => {
    setBusy(true);
    void mint()
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <Group>
      {loadError !== null ? (
        <Empty failed action={<Button size="sm" onClick={load}>Try again</Button>}>
          {loadError}
        </Empty>
      ) : minted === null ? (
        <SkeletonRow />
      ) : (
        // Never the key, a prefix or an id: only whether one exists.
        <TwoStep
          armed={minted && confirming}
          onArm={setConfirming}
          align="end"
          className={TWO_STEP_ROW}
          question="Replace the provisioning key?"
          consequence="Retires the current key. Anything provisioning with it stops."
          act={{ label: "Replace" }}
          onAct={mint}
          rest={
            <>
              <span className="min-w-0 flex-1 truncate text-sm">Provisioning key</span>
              <Badge tone="strong">{minted ? "minted" : "none"}</Badge>
              <Button size="sm" disabled={busy} onClick={minted ? () => setConfirming(true) : mintNow}>
                {busy ? <Spinner /> : minted ? "Remint" : "Mint a key"}
              </Button>
            </>
          }
        />
      )}
    </Group>
  );
}

function Domains({
  answer,
  onChanged,
}: {
  answer: cp.SettingsAnswer;
  onChanged: (next: cp.SettingsAnswer) => void;
}): ReactNode {
  const stored = settingValue(answer, DOMAINS_KEY);
  const [draft, setDraft] = useState(stored);
  const [busy, setBusy] = useState(false);
  const dirty = draft !== stored;
  const field = settingField(answer, DOMAINS_KEY);

  const write = (patch: { set?: Record<string, string>; clear?: string[] }): void => {
    setBusy(true);
    void cp
      .adminSaveSettings(patch)
      .then((updated) => {
        onChanged(updated);
        back();
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !dirty) return;
    write(draft.trim().length === 0 ? { clear: [DOMAINS_KEY] } : { set: { [DOMAINS_KEY]: draft.trim() } });
  };

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
      <SettingField
        label="Domains"
        value={draft}
        onChange={setDraft}
        field={field}
        onReset={() => write({ clear: [DOMAINS_KEY] })}
        busy={busy}
        placeholder="reemoat.com"
        hint="Comma-separated; empty allows any."
        autoFocus
      />
      <div className="flex items-center gap-2">
        <Button
          tone="primary"
          type="submit"
          disabled={busy || !dirty}
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
  const field = settingField(answer, MACHINE_LIMIT_KEY);
  const problem = machineLimitProblem(draft);
  const consequence = dirty && problem === null ? fleetMachineLimitNotice(stored, draft) : null;

  // One lock around every write, so the field's Reset is greyed while a confirmed lowering is out.
  const write = (patch: { set?: Record<string, string>; clear?: string[] }): Promise<void> => {
    setBusy(true);
    return cp
      .adminSaveSettings(patch)
      .then((updated) => {
        onChanged(updated);
        back();
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

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !dirty || problem !== null) return;
    // Only a lowering, which switches machines off fleet-wide, confirms first.
    if (consequence === null) writeNow(savePatch());
    else setConfirming(true);
  };

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
      <SettingField
        label="Machines per person"
        value={draft}
        // An edit disarms, so the question never stands over a number other than the one it names.
        onChange={(next) => {
          setDraft(next);
          setConfirming(false);
        }}
        field={field}
        onReset={() => writeNow({ clear: [MACHINE_LIMIT_KEY] })}
        busy={busy}
        placeholder="2"
        error={problem}
        autoFocus
      />
      <TwoStep
        armed={confirming && consequence !== null}
        onArm={setConfirming}
        question={consequence}
        act={{ label: "Save limit" }}
        onAct={() => write(savePatch())}
        disabled={busy}
        rest={
          <>
            <Button
              tone="primary"
              type="submit"
              disabled={busy || !dirty || problem !== null}
            >
              {busy ? <Spinner /> : "Save"}
            </Button>
            <Button disabled={busy} onClick={back}>
              Cancel
            </Button>
          </>
        }
      />
    </form>
  );
}

export function DomainsScreen(): ReactNode {
  return <WithAdminSettings>{(answer, adopt) => <Domains answer={answer} onChanged={adopt} />}</WithAdminSettings>;
}

export function MachineLimitScreen(): ReactNode {
  return (
    <WithAdminSettings onAdopt={refreshOwnQuota}>
      {(answer, adopt) => <MachineLimit answer={answer} onChanged={adopt} />}
    </WithAdminSettings>
  );
}

/** Shows the handed-off key once and never mints; with nothing in hand it walks back. */
export function ProvisioningKeyScreen(): ReactNode {
  const [minted] = useState<string | null>(peekHandoff);

  useEffect(() => {
    clearHandoff();
    if (minted === null) back();
  }, [minted]);

  if (minted === null) return null;
  return (
    <OneTimeSecret
      label="Provisioning key"
      value={minted}
      // Never advise storing it on a daemon host: an agent there runs as its owner (Q1.53).
      note="Shown once. Never store it on a daemon host."
      onDone={back}
    />
  );
}
