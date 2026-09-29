import { Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import type { AdminUserRow } from "../../cp";
import { userState, userStateText } from "../../account";
import { errorText } from "../../http";
import { adminMayInvite, type InstanceConfig } from "../../instance";
import { machineLimitChangeNotice, machineLimitProblem } from "../../quota";
import { navigate } from "../../router";
import { settingsLeafPath, settingsPath, userLimitPath } from "../../settings";
import type { Me } from "../../wire";
import { Badge, Button, Empty, FIELD, RowAction, RowMenu, SkeletonRow, Spinner, SwitchRow, TWO_STEP_BOX, TwoStep } from "../bits";
import { toast } from "../Toast";
import { Field } from "../kit/Field";
import { Group, TABLE, TD, TH } from "../kit/List";
import { Pending } from "../kit/Status";
import { OneTimeSecret } from "./OneTimeSecret";

const back = (): void => navigate(settingsPath("users"), true);

/** Hiding this screen is not the guard: every route it calls sits behind requireAdmin on the control plane. */
export function UsersSection({ me, config }: { me: Me | null; config: InstanceConfig | null }): ReactNode {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    void cp
      .adminUsers()
      .then((next) => {
        setUsers(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorText(cause)));
  };

  useEffect(refresh, []);

  const listed = users !== null && error === null ? users : null;

  return (
    <Group
      title="People"
      count={listed === null ? undefined : String(listed.length)}
      action={
        <Button size="sm" onClick={() => navigate(settingsLeafPath("new-user"))}>
          Add person
        </Button>
      }
      footer={listed !== null && listed.length <= 1 ? "Only you so far." : undefined}
    >
      {users === null && error === null && <SkeletonRow />}
      {error !== null && (
        <Empty failed action={<Button size="sm" onClick={refresh}>Try again</Button>}>
          {error}
        </Empty>
      )}
      {listed !== null && (
        // Fixed widths: a row asking to delete spans every column, which would otherwise reflow the others.
        <table className={`${TABLE} table-fixed`}>
          <colgroup>
            <col />
            <col className="w-28" />
            <col className="w-14" />
          </colgroup>
          <thead>
            <tr>
              <th className={TH}>Person</th>
              <th className={TH}>Machines</th>
              <th className={TH}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {listed.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                isSelf={user.id === me?.id}
                emailEnabled={adminMayInvite(config)}
                onChanged={refresh}
              />
            ))}
          </tbody>
        </table>
      )}
    </Group>
  );
}

function UserRow({
  user,
  isSelf,
  onChanged,
  emailEnabled,
}: {
  user: AdminUserRow;
  isSelf: boolean;
  onChanged: () => void;
  /** Whether anybody on this instance could confirm an address at all. */
  emailEnabled: boolean;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const state = userState(user, emailEnabled);
  // One badge per row: the account's state outranks admin.
  const badge = state !== null ? userStateText(state) : user.isAdmin ? "admin" : null;
  const over = user.machinesOverLimit ?? 0;
  const owned = user.machines ?? 0;

  const run = <T,>(work: Promise<T>, done?: (value: T) => void): void => {
    setBusy(true);
    void work
      .then((value) => {
        done?.(value);
        onChanged();
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  // Asked across the whole row, its Cancel last where the kebab was (Q3.218).
  if (confirming) {
    return (
      <tr className="border-t border-edge">
        <td colSpan={3} className="px-4 align-middle">
          <TwoStep
            armed
            onArm={setConfirming}
            align="end"
            className="min-h-11"
            question={
              <>
                Delete <span className="font-medium">{user.name}</span> for good?
              </>
            }
            act={{ label: "Delete", danger: true, icon: Trash2 }}
            onAct={() =>
              cp.adminDeleteUser(user.id).then((answer) => {
                toast("ok", `${answer.name} is gone.`);
                onChanged();
              })
            }
          />
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-edge">
      <td className={TD}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-medium" title={user.name}>
            {user.name}
          </span>
          {isSelf && <span className="shrink-0 text-2xs text-faint">you</span>}
          {badge !== null && <Badge tone="strong">{badge}</Badge>}
        </span>
      </td>
      {/* Over the limit reads in full ink: the newest of them are switched off. */}
      <td className={`${TD} truncate ${over > 0 ? "font-medium text-fg" : "text-muted"}`}>
        {typeof user.machineLimit === "number" ? `${owned} of ${user.machineLimit}` : String(owned)}
      </td>
      <td className="pr-1.5 text-right align-middle">
        {/* Disable and Delete are absent on your own row: the server refuses both, and nothing undoes them. */}
        <RowMenu label={`Actions for ${user.name}`}>
          {(close) => (
            <>
              {/* No API keys item: an admin can neither see nor act on another person's keys (Q1.631). */}
              <RowAction
                label="Machine limit…"
                onClick={() => {
                  close();
                  navigate(userLimitPath(user.id));
                }}
              />
              {/* Only for an invited account (no password, an address, mail enabled); anything else answers 409. */}
              {!user.hasPassword && user.email !== null && emailEnabled && (
                <RowAction
                  label="Resend invitation"
                  disabled={busy}
                  onClick={() => {
                    close();
                    run(cp.adminInviteUser(user.id), (answer) => {
                      toast(
                        answer.mailQueued ? "ok" : "error",
                        answer.mailQueued
                          ? `Invitation sent to ${answer.email}.`
                          : "Invitation not queued — check Email settings.",
                      );
                    });
                  }}
                />
              )}
              {!isSelf && (
                <RowAction
                  label={user.disabled ? "Enable" : "Disable"}
                  disabled={busy}
                  onClick={() => {
                    close();
                    run(cp.adminSetDisabled(user.id, !user.disabled), (answer) => {
                      if (answer.disabled) toast("ok", `${user.name} is disabled.`);
                    });
                  }}
                />
              )}
              {!isSelf && (
                <RowAction
                  label="Delete"
                  danger
                  onClick={() => {
                    close();
                    setConfirming(true);
                  }}
                />
              )}
            </>
          )}
        </RowMenu>
      </td>
    </tr>
  );
}

function CreateUser({
  canInvite,
  onCreated,
  onCancel,
}: {
  /** The email field is drawn only when the address can be confirmed; an unverified one would invite takeover. */
  canInvite: boolean;
  onCreated: (user: { name: string; password?: string; email?: string }) => void;
  onCancel: () => void;
}): ReactNode {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || name.trim().length === 0) return;
    setBusy(true);
    setError(null);
    void cp
      .adminCreateUser(name.trim(), isAdmin, canInvite ? email : undefined)
      .then((user) => onCreated({ name: user.name, password: user.password, email: user.email }))
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  // The admin switch precedes Create in DOM order, so tabbing reaches the choice before the button.
  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
      <Field label="Name">
        {({ id }) => (
          <input
            id={id}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="ada"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className={FIELD}
          />
        )}
      </Field>
      {canInvite && (
        <Field label="Email" hint="Optional. Sends an invitation instead of a password.">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ada@example.com"
              type="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={FIELD}
            />
          )}
        </Field>
      )}
      <Group>
        <SwitchRow
          title="Admin"
          subline="Manages the server, email and users."
          on={isAdmin}
          disabled={busy}
          onToggle={() => setIsAdmin(!isAdmin)}
        />
      </Group>
      {error !== null && <p className="text-sm text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          tone="primary"
          type="submit"
          disabled={busy || name.trim().length === 0}
        >
          {busy ? <Spinner /> : "Create"}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The limit's form on a screen of its own; its answers share TWO_STEP_BOX with both questions, so Cancel keeps the last place (Q3.552). */
function MachineLimitPanel({
  user,
  onChanged,
  onCancel,
}: {
  user: AdminUserRow;
  onChanged: () => void;
  onCancel: () => void;
}): ReactNode {
  const owned = user.machines ?? 0;
  const current = user.machineLimit ?? 0;
  const [draft, setDraft] = useState(String(current));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"save" | "clear" | null>(null);
  const problem = machineLimitProblem(draft);
  const next = Number.parseInt(draft.trim(), 10);
  const dirty = draft.trim().length > 0 && problem === null && next !== current;
  // Whether to confirm is machineLimitChangeNotice's pure answer, so webcheck can test it.
  const consequence = dirty ? machineLimitChangeNotice(user.name, owned, next) : null;
  // Clearing an override can stop machines too, so it confirms; with no known default it asks anyway.
  const clearingCost =
    user.machineLimitSource === "override" && typeof user.machineLimitDefault === "number"
      ? machineLimitChangeNotice(user.name, owned, user.machineLimitDefault)
      : null;
  const clearingUnknown =
    user.machineLimitSource === "override" && typeof user.machineLimitDefault !== "number";
  const standing =
    user.machineLimitSource === "override"
      ? typeof user.machineLimitDefault === "number"
        ? ` Default is ${user.machineLimitDefault}.`
        : ""
      : user.machineLimitSource === "default"
        ? " This is the default."
        : "";

  // busy is held here, not in write: the confirmed acts hand apply to the primitive, and the one-tap ones go through it too.
  const apply = (work: Promise<cp.MachineLimitAnswer>): Promise<void> => {
    setBusy(true);
    return work
      .then((answer) => {
        setDraft(String(answer.maxMachines));
        if (answer.suspended.length > 0) {
          const n = answer.suspended.length;
          toast("ok", `${n} machine${n === 1 ? "" : "s"} stopped; raise the limit.`);
        }
        onChanged();
      })
      .finally(() => setBusy(false));
  };
  // One-tap paths reset confirming, which otherwise outlives an armed that went false (Q3.552).
  const write = (work: Promise<cp.MachineLimitAnswer>): void => {
    void apply(work)
      .then(() => setConfirming(null))
      .catch((cause: unknown) => toast("error", errorText(cause)));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !dirty) return;
    // Raising lands at once; only a change that stops machines confirms first.
    if (consequence === null) write(cp.adminSetMachineLimit(user.id, next));
    else setConfirming("save");
  };

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
      <Field label={`Limit for ${user.name}`} hint={`Owns ${owned} machine${owned === 1 ? "" : "s"}.${standing}`} error={problem}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            value={draft}
            // An edit disarms, so a question never stands over a number other than the one it names.
            onChange={(event) => {
              setDraft(event.target.value);
              setConfirming(null);
            }}
            inputMode="numeric"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className={FIELD}
          />
        )}
      </Field>

      {confirming === "save" && consequence !== null ? (
        // plain, not danger: lowering the limit undoes itself once the number goes back up.
        <TwoStep
          armed={confirming === "save"}
          onArm={(armed) => setConfirming(armed ? "save" : null)}
          disabled={busy}
          question={consequence}
          act={{ label: "Save limit" }}
          onAct={() => apply(cp.adminSetMachineLimit(user.id, next))}
        />
      ) : confirming === "clear" ? (
        <TwoStep
          armed={confirming === "clear"}
          onArm={(armed) => setConfirming(armed ? "clear" : null)}
          disabled={busy}
          question={clearingCost ?? "Drops to the default; machines over it stop. Raising it brings them back."}
          act={{ label: "Use the default" }}
          onAct={() => apply(cp.adminClearMachineLimit(user.id))}
        />
      ) : (
        <div className={TWO_STEP_BOX}>
          <Button
            tone="primary"
            type="submit"
            disabled={busy || !dirty}
          >
            {busy ? <Spinner /> : "Save"}
          </Button>
          {user.machineLimitSource === "override" && (
            <Button
              disabled={busy}
              onClick={() =>
                clearingCost === null && !clearingUnknown
                  ? write(cp.adminClearMachineLimit(user.id))
                  : setConfirming("clear")
              }
            >
              Use the default
            </Button>
          )}
          <Button disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}

/** Adding a person is a screen of its own, which then shows the one-time password or where the invitation went. */
export function NewUserScreen({ config }: { config: InstanceConfig | null }): ReactNode {
  const [created, setCreated] = useState<{ name: string; password?: string; email?: string } | null>(null);

  if (created === null) return <CreateUser canInvite={adminMayInvite(config)} onCreated={setCreated} onCancel={back} />;
  // With mail configured the server invites and no password ever exists, so there is nothing to copy.
  if (created.password !== undefined) {
    return (
      <OneTimeSecret
        label={`Password for ${created.name}`}
        value={created.password}
        note="Shown once. They must change it at first sign-in."
        onDone={back}
      />
    );
  }
  return (
    <div className="flex max-w-sm flex-col gap-4">
      <p className="text-sm">Invitation sent to {created.email}.</p>
      <div className="flex items-center gap-2">
        <Button onClick={back}>Done</Button>
      </div>
    </div>
  );
}

/** Read fresh rather than handed over, so the form never starts from a stale row; somebody no longer listed walks back. */
export function UserLimitScreen({ userId }: { userId: string }): ReactNode {
  const [user, setUser] = useState<AdminUserRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    setError(null);
    void cp
      .adminUsers()
      .then((rows) => setUser(rows.find((row) => row.id === userId) ?? null))
      .catch((cause: unknown) => setError(errorText(cause)));
  };
  useEffect(load, [userId]);
  useEffect(() => {
    if (user === null) back();
  }, [user]);

  if (error !== null) {
    return (
      <Empty failed action={<Button size="sm" onClick={load}>Try again</Button>}>
        {error}
      </Empty>
    );
  }
  if (user === undefined) return <Pending>Loading…</Pending>;
  if (user === null) return null;
  return <MachineLimitPanel user={user} onChanged={back} onCancel={back} />;
}
