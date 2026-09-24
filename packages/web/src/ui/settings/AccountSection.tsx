import { LogOut } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  ageText,
  changePasswordError,
  CONTROL_PLANE_UNREACHABLE,
  PASSWORD_MIN,
  passwordProblem,
  passwordProblemText,
} from "../../account";
import * as cp from "../../cp";
import { agentWasRecorded, describeAgent, deviceLine } from "../../device";
import { errorText } from "../../http";
import { mailUsable, type InstanceConfig } from "../../instance";
import { nativeBoot } from "../../native";
import { navigate } from "../../router";
import { settingsLeafPath, settingsPath } from "../../settings";
import { store } from "../../store";
import type { Me, SessionRecord } from "../../wire";
import {
  Badge,
  Button,
  DangerButton,
  Empty,
  FIELD,
  LINK,
  SETTINGS_HEADING,
  SETTINGS_SECTION,
  SkeletonRow,
  Spinner,
  TwoStep,
  shortDuration,
} from "../bits";
import { toast } from "../Toast";
import { FIELD_LABEL } from "./SettingField";

/** Your own account as rows; each form is its own leaf route that walks back here by replace (Q3.549). */
export function AccountSection({
  me,
  config,
}: {
  me: Me | null;
  config: InstanceConfig | null;
}): ReactNode {
  return (
    <div>
      {me === null ? (
        // Reachable: bootstrap can be ready with no me when the control plane is down; refreshMe is the retry.
        <Empty
          failed
          action={
            <Button size="sm" onClick={() => void store.refreshMe()}>
              Try again
            </Button>
          }
        >
          {CONTROL_PLANE_UNREACHABLE}
        </Empty>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm">
            <span className="min-w-0 truncate font-medium">{me.name}</span>
            {me.isAdmin && (
              <span className="shrink-0">
                <Badge tone="strong">admin</Badge>
              </span>
            )}
          </p>

          <PasswordRow me={me} />
          <EmailRow me={me} config={config} />
          <SignIns />
        </>
      )}

      {/* Outside the me === null branch: Sign out must stay drawn while the control plane is down. */}
      <ServerRow />

      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Sign out</h2>
        <p className="mt-1 text-xs text-muted">
          {nativeBoot() !== null
            ? "Ends this sign-in on the server too, and takes this account off this computer."
            : "Ends this sign-in on the server too."}
        </p>
        <DangerButton icon={LogOut} className="mt-3" onClick={() => void store.signOut()}>
          Sign out
        </DangerButton>
      </section>
    </div>
  );
}

const fieldLabel = `mt-3 block ${FIELD_LABEL}`;

/** block is load-bearing: an inline-block input leaves room for the submit button to float up beside it. */
const field = `mt-1.5 block w-full max-w-sm ${FIELD}`;

function FactRow({
  value,
  subline,
  action,
}: {
  value: ReactNode;
  subline: string | null;
  action: ReactNode;
}): ReactNode {
  return (
    <div className="mt-2 flex min-h-11 items-center gap-3">
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2 text-sm">{value}</span>
        {subline !== null && <span className="block text-xs text-muted">{subline}</span>}
      </span>
      <span className="shrink-0">{action}</span>
    </div>
  );
}

/** States the server and never changes it: another server is another account, added from the menu (Q3.643, Q5.120). */
function ServerRow(): ReactNode {
  const server = nativeBoot()?.server ?? null;
  if (server === null) return null;
  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Server address</h2>
      <FactRow
        value={<span className="truncate font-mono">{server}</span>}
        subline="Another server is another account, from the menu."
        action={null}
      />
    </section>
  );
}

function PasswordRow({ me }: { me: Me }): ReactNode {
  const firstTime = me.hasPassword === false;

  const value = firstTime
    ? "Not set"
    : typeof me.passwordChangedAt === "number"
      ? `Changed ${ageText(Date.now() - me.passwordChangedAt)} ago`
      : "Set";

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Password</h2>
      <FactRow
        value={value}
        subline={firstTime ? "Your API key is what signs you in." : "Changing it signs out other devices."}
        action={
          <Button size="sm" onClick={() => navigate(settingsLeafPath("password"))}>
            {firstTime ? "Set" : "Change"}
          </Button>
        }
      />
    </section>
  );
}

function PasswordForm({ me, onDone }: { me: Me; onDone: () => void }): ReactNode {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An account from before passwords sets a first one with no current password; its API key is the proof.
  const firstTime = me.hasPassword === false;
  const problem = next.length > 0 || confirm.length > 0 ? passwordProblem(current, next, confirm) : null;
  const ready = !busy && next.length > 0 && confirm.length > 0 && problem === null && (firstTime || current.length > 0);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    void cp
      .changePassword(firstTime ? undefined : current, next)
      .then(() => {
        toast("ok", "Password changed.");
        // refreshMe, not resume: only GET /v1/me moves hasPassword and passwordChangedAt.
        void store.refreshMe();
        onDone();
      })
      .catch((cause: unknown) => setError(changePasswordError(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit}>
      {/* A hidden username field, so a password manager updates the right saved entry. */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={me.name}
        readOnly
        tabIndex={-1}
        className="sr-only"
      />

      {!firstTime && (
        <>
          <label htmlFor="pw-current" className={fieldLabel}>
            Current password
          </label>
          <input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoFocus
            className={field}
          />
        </>
      )}

      <label htmlFor="pw-new" className={fieldLabel}>
        New password
      </label>
      <input
        id="pw-new"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(event) => setNext(event.target.value)}
        autoFocus={firstTime}
        className={field}
      />
      <p className="mt-1 text-xs text-muted">{`At least ${PASSWORD_MIN} characters.`}</p>

      <label htmlFor="pw-confirm" className={fieldLabel}>
        New password again
      </label>
      <input
        id="pw-confirm"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        className={field}
      />

      {problem !== null && <p className="mt-2 text-sm font-medium text-fg">{passwordProblemText(problem)}</p>}
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}

      {/* Cancel last — Q3.218's ordering, on a form as on a row. */}
      <div className="mt-4 flex items-center gap-2">
        <Button type="submit" tone="primary" disabled={!ready}>
          {busy ? <Spinner /> : firstTime ? "Set password" : "Change password"}
        </Button>
        <Button disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Unconfirmed is said aloud because it cannot receive a reset; with mail unusable the row has no controls. */
function EmailRow({ me, config }: { me: Me; config: InstanceConfig | null }): ReactNode {
  const has = typeof me.email === "string" && me.email.length > 0;

  const address = has ? (
    <>
      <span className="min-w-0 truncate">{me.email}</span>
      {me.emailVerified !== true && (
        <span className="shrink-0">
          <Badge tone="strong">unconfirmed</Badge>
        </span>
      )}
    </>
  ) : null;

  if (!mailUsable(config)) {
    // Said, not hidden: the heading and any held address stay, and only the controls go.
    return (
      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Email</h2>
        {address !== null && <p className="mt-2 flex min-w-0 items-center gap-2 text-sm">{address}</p>}
        <p className="mt-1 text-xs text-muted">
          This server cannot send mail.{" "}
          {me.isAdmin && (
            <button type="button" className={LINK} onClick={() => navigate(settingsPath("email"))}>
              Email settings
            </button>
          )}
        </p>
      </section>
    );
  }

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Email</h2>

      {has ? (
        <FactRow
          value={address}
          subline={me.emailVerified === true ? null : "Open the link we sent to confirm."}
          action={
            <Button size="sm" onClick={() => navigate(settingsLeafPath("email"))}>
              Change
            </Button>
          }
        />
      ) : (
        <>
          <p className="mt-1 text-xs text-muted">Needed to reset your own password.</p>
          <Button size="sm" tone="primary" className="mt-2" onClick={() => navigate(settingsLeafPath("email"))}>
            Add an address
          </Button>
        </>
      )}
    </section>
  );
}

function EmailForm({ onDone }: { onDone: () => void }): ReactNode {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || address.trim().length === 0) return;
    setBusy(true);
    setError(null);
    void cp
      .setMyEmail(address.trim())
      .then(() => {
        toast("ok", "Check that address for a link.");
        void store.refreshMe();
        onDone();
      })
      .catch((cause: unknown) => setError(changePasswordError(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit}>
      <label htmlFor="account-email" className={fieldLabel}>
        Address
      </label>
      <input
        id="account-email"
        type="email"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        autoComplete="email"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
        className={field}
      />
      {/* No password asked: the session is the proof (Q1.630). */}
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="submit"
          tone="primary"
          disabled={busy || address.trim().length === 0}
        >
          {busy ? <Spinner /> : "Send a link"}
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Where you are signed in; device fields are caller-supplied, so this ends sessions rather than judging them (Q1.630). */
function SignIns(): ReactNode {
  const [rows, setRows] = useState<SessionRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refresh = (): void => {
    void cp
      .sessions()
      .then((next) => {
        setRows(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  };

  useEffect(refresh, []);

  const others = rows === null ? 0 : rows.filter((row) => !row.current).length;

  // Handed to `TwoStep`, which owns the wait: the question closes on the 200 and
  // stands beside the toast on a failure.
  const signOutOthers = (): Promise<void> =>
    cp.revokeOtherSessions().then((count) => {
      // The count the server actually revoked; sign-in, not device, since a device survives this.
      toast("ok", count === 1 ? "1 other sign-in ended." : `${count} other sign-ins ended.`);
      refresh();
    });

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Signed in</h2>
      {rows === null && !failed && <SkeletonRow />}
      {failed && (
        <Empty
          failed
          action={
            <Button size="sm" onClick={refresh}>
              Try again
            </Button>
          }
        >
          Could not read your sessions.
        </Empty>
      )}
      {!failed && rows !== null && rows.length === 0 && (
        // An API key has no session row, so say so rather than draw an empty list.
        <p className="mt-1.5 text-xs text-muted">Signed in with an API key — nothing to end.</p>
      )}
      {!failed && rows !== null && rows.length > 0 && (
        <>
          <div className="mt-2">
            {rows.map((row) => (
              <SignInRow key={row.id} row={row} onChanged={refresh} />
            ))}
          </div>

          {/* One act over N rows, so it confirms in place (Q3.218); the per-row Sign out stays one tap. */}
          {others > 0 && (
            <TwoStep
              armed={confirming}
              onArm={setConfirming}
              className="mt-3"
              question={`Sign out ${others} other device${others === 1 ? "" : "s"}?`}
              act={{ label: "Sign out", danger: true, icon: LogOut }}
              onAct={signOutOthers}
              rest={
                <Button size="sm" onClick={() => setConfirming(true)}>
                  {`Sign out ${others} other${others === 1 ? "" : "s"}`}
                </Button>
              }
            />
          )}
        </>
      )}
    </section>
  );
}

function SignInRow({ row, onChanged }: { row: SessionRecord; onChanged: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const ip = row.ip !== null && row.ip !== undefined && row.ip !== "unknown" ? row.ip : null;

  return (
    <div className="flex min-h-11 items-center gap-3 border-b border-edge/60 py-2 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate text-sm font-medium"
            title={agentWasRecorded(row.userAgent) && describeAgent(row.userAgent) === null ? (row.userAgent ?? undefined) : undefined}
          >
            {/* A device name was chosen by the person, the fallback is a User-Agent guess; neither is evidence. */}
            {row.deviceName ?? deviceLine(row.userAgent)}
          </span>
          {row.current && (
            <span className="shrink-0">
              <Badge tone="strong">this device</Badge>
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-2xs text-muted">
          {ip !== null && <span className="font-mono">{ip}</span>}
          {ip !== null && " · "}
          {row.current ? "in use" : `last used ${shortDuration(Math.max(0, now - row.lastSeenAt))} ago`}
        </span>
      </span>

      {/* Absent on your own row: the Sign out at the bottom is the one way to end this session. */}
      {!row.current && (
        <span className="shrink-0">
          <DangerButton
            icon={LogOut}
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void cp
                .revokeSession(row.id)
                .then(onChanged)
                .catch((cause: unknown) => toast("error", errorText(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? <Spinner /> : "Sign out"}
          </DangerButton>
        </span>
      )}
    </div>
  );
}

/** Done and Cancel navigate back with replace, so Back pops out of the form rather than through it. */
export function PasswordScreen({ me }: { me: Me | null }): ReactNode {
  if (me === null) return <Empty failed>{CONTROL_PLANE_UNREACHABLE}</Empty>;
  return <PasswordForm me={me} onDone={() => navigate(settingsPath("account"), true)} />;
}

export function EmailScreen({ me, config }: { me: Me | null; config: InstanceConfig | null }): ReactNode {
  if (me === null) return <Empty failed>{CONTROL_PLANE_UNREACHABLE}</Empty>;
  if (!mailUsable(config)) return <p className="text-xs text-muted">This server cannot send mail.</p>;
  return <EmailForm onDone={() => navigate(settingsPath("account"), true)} />;
}
