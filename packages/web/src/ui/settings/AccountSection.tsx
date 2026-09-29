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
  Empty,
  FIELD,
  Monogram,
  SkeletonRow,
  Spinner,
  TwoStep,
  personEmoji,
  shortDuration,
} from "../bits";
import { toast } from "../Toast";
import { Field } from "../kit/Field";
import { ActionRow, EmptyRow, Group, LinkRow, TABLE, TD, TWO_STEP_ROW, ValueRow } from "../kit/List";

/** Your own account as grouped rows; each form is its own leaf route that walks back here by replace (Q3.549). */
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
          <Profile me={me} />
          <Group>
            <EmailRow me={me} config={config} />
            <PasswordRow me={me} />
            <ServerRow />
          </Group>
          <SignIns />
        </>
      )}

      {/* Outside the me === null branch: Sign out must stay drawn while the control plane is down. */}
      <Group footer={nativeBoot() !== null ? "Removes this account from this computer." : undefined}>
        <ActionRow title="Sign out" glyph={LogOut} tone="danger" onClick={() => void store.signOut()} />
      </Group>
    </div>
  );
}

/** Who this is: the drawer's own face and name, so the account reads the same in both places. */
function Profile({ me }: { me: Me }): ReactNode {
  return (
    <div className="mb-6 flex items-center gap-3 px-4">
      <Monogram name={me.name} glyph={personEmoji(me.name)} size="md" className="bg-raised" />
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-base font-semibold">{me.name}</span>
        {me.isAdmin && (
          <span className="shrink-0">
            <Badge tone="strong">admin</Badge>
          </span>
        )}
      </span>
    </div>
  );
}

const fieldCol = "flex max-w-sm flex-col gap-4";

/** States the server and never changes it: another server is another account, added from the menu (Q3.643, Q5.120). */
function ServerRow(): ReactNode {
  const server = nativeBoot()?.server ?? null;
  if (server === null) return null;
  return <ValueRow title="Server address" value={server} mono />;
}

/** `Set` for an account whose password predates the change date, `Not set` for one whose API key signs it in. */
function PasswordRow({ me }: { me: Me }): ReactNode {
  const value =
    me.hasPassword === false
      ? "Not set"
      : typeof me.passwordChangedAt === "number"
        ? `Changed ${ageText(Date.now() - me.passwordChangedAt)} ago`
        : "Set";
  return <LinkRow title="Password" value={value} onClick={() => navigate(settingsLeafPath("password"))} />;
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
    <form onSubmit={submit} className={fieldCol}>
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
        <Field label="Current password">
          {({ id }) => (
            <input
              id={id}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              autoFocus
              className={FIELD}
            />
          )}
        </Field>
      )}

      {/* The rule is said once: as the hint until it is broken, then as the problem under the fields. */}
      <Field label="New password" hint={problem === null ? `At least ${PASSWORD_MIN} characters.` : undefined}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoFocus={firstTime}
            className={FIELD}
          />
        )}
      </Field>

      <Field label="New password again">
        {({ id }) => (
          <input
            id={id}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className={FIELD}
          />
        )}
      </Field>

      {problem !== null && <p className="text-sm font-medium text-fg">{passwordProblemText(problem)}</p>}
      {error !== null && <p className="text-sm text-danger">{error}</p>}
      {/* Said where the change is made, not at rest on the Account row. */}
      {!firstTime && <p className="text-xs text-muted">Changing it signs out other devices.</p>}

      {/* Cancel last — Q3.218's ordering, on a form as on a row. */}
      <div className="flex items-center gap-2">
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

/** Unconfirmed is said aloud because it cannot receive a reset; with mail unusable the row goes to Email settings or nowhere. */
function EmailRow({ me, config }: { me: Me; config: InstanceConfig | null }): ReactNode {
  const address = typeof me.email === "string" && me.email.length > 0 ? me.email : null;
  const unconfirmed = address !== null && me.emailVerified !== true ? <Badge tone="strong">unconfirmed</Badge> : undefined;

  if (!mailUsable(config)) {
    // Said, not hidden: the held address stays, and only the way to change it goes.
    return me.isAdmin ? (
      <LinkRow
        title="Email"
        value={address}
        badge={unconfirmed}
        subline="This server cannot send mail."
        onClick={() => navigate(settingsPath("email"))}
      />
    ) : (
      <ValueRow title="Email" value={address} badge={unconfirmed} subline="This server cannot send mail." />
    );
  }

  return (
    <LinkRow
      title="Email"
      value={address ?? "Add"}
      badge={unconfirmed}
      subline={address === null ? "Needed to reset your own password." : unconfirmed === undefined ? undefined : "Open the link we sent to confirm."}
      onClick={() => navigate(settingsLeafPath("email"))}
    />
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
    <form onSubmit={submit} className={fieldCol}>
      {/* No password asked: the session is the proof (Q1.630). */}
      <Field label="Address" error={error}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            type="email"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            autoComplete="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className={FIELD}
          />
        )}
      </Field>
      <div className="flex items-center gap-2">
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
    <Group title="Signed in" count={rows === null || rows.length === 0 ? undefined : String(rows.length)}>
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
        <EmptyRow>Signed in with an API key — nothing to end.</EmptyRow>
      )}
      {!failed && rows !== null && rows.length > 0 && (
        <table className={TABLE}>
          <tbody>
            {rows.map((row) => (
              <SignInRow key={row.id} row={row} onChanged={refresh} />
            ))}
          </tbody>
        </table>
      )}
      {/* One act over N rows, so it confirms in place (Q3.218); the per-row Sign out stays one tap. */}
      {!failed && others > 0 && (
        <TwoStep
          armed={confirming}
          onArm={setConfirming}
          align="end"
          className={TWO_STEP_ROW}
          question={`Sign out ${others} other device${others === 1 ? "" : "s"}?`}
          act={{ label: "Sign out", danger: true, icon: LogOut }}
          onAct={signOutOthers}
          rest={
            <Button size="sm" onClick={() => setConfirming(true)} className="ml-auto">
              {`Sign out ${others} other${others === 1 ? "" : "s"}`}
            </Button>
          }
        />
      )}
    </Group>
  );
}

function SignInRow({ row, onChanged }: { row: SessionRecord; onChanged: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const ip = row.ip !== null && row.ip !== undefined && row.ip !== "unknown" ? row.ip : null;

  return (
    <tr className="border-t border-edge first:border-t-0">
      {/* `max-w-0 w-full` lets the name truncate in an auto-layout table instead of widening its column. */}
      <td className={`${TD} w-full max-w-0`}>
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate font-medium"
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
        <span className="block truncate text-2xs text-faint">
          {ip !== null && <span className="font-mono">{ip}</span>}
          {ip !== null && " · "}
          {row.current ? "in use" : `last used ${shortDuration(Math.max(0, now - row.lastSeenAt))} ago`}
        </span>
      </td>

      {/* Absent on your own row: Sign out at the bottom is the one way to end this session. Plain, since one danger control per view. */}
      <td className={`${TD} w-px text-right whitespace-nowrap`}>
        {!row.current && (
          <Button
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
          </Button>
        )}
      </td>
    </tr>
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
