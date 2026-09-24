import { MoreHorizontal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import type { AdminUserRow } from "../../cp";
import { userState, userStateText } from "../../account";
import { errorText } from "../../http";
import { adminMayInvite, type InstanceConfig } from "../../instance";
import { machineLimitChangeNotice, machineLimitProblem } from "../../quota";
import type { Me } from "../../wire";
import { Badge, Button, Empty, FIELD, IconButton, Menu, RowAction, SETTINGS_HEADING, SETTINGS_SECTION, SkeletonRow, Spinner, TWO_STEP_BOX, TwoStep, menuPlacement } from "../bits";
import { toast } from "../Toast";
import { OneTimeSecret } from "./OneTimeSecret";
import { FIELD_LABEL } from "./SettingField";

/** Hiding this screen is not the guard: every route it calls sits behind requireAdmin on the control plane. */
export function UsersSection({ me, config }: { me: Me | null; config: InstanceConfig | null }): ReactNode {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; password?: string; email?: string } | null>(null);

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

  return (
    <div>
      {error !== null && (
        <Empty failed action={<Button size="sm" onClick={refresh}>Try again</Button>}>
          {error}
        </Empty>
      )}

      <CreateUser
        canInvite={adminMayInvite(config)}
        onCreated={(user) => {
          setCreated(user);
          refresh();
        }}
      />

      {/* With mail configured the server invites and no password ever exists, so there is nothing to copy. */}
      {created !== null && created.password !== undefined && (
        <OneTimeSecret
          label={`Password for ${created.name}`}
          value={created.password}
          note="Shown once. They must change it at first sign-in."
          onDone={() => setCreated(null)}
        />
      )}
      {created !== null && created.password === undefined && (
        <p className="mt-3 text-sm text-muted">
          Invitation sent to {created.email}.{" "}
          <button type="button" onClick={() => setCreated(null)} className="tap underline hover:text-fg">
            Dismiss
          </button>
        </p>
      )}

      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>People</h2>
        {users === null ? (
          error === null && <SkeletonRow />
        ) : (
          <>
          {users.length > 0 && (
          // No overflow-hidden: Menu never portals, so nothing between its trigger and the scroller may clip.
          <div className="mt-2 rounded-lg border border-edge">
            {users.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                isSelf={user.id === me?.id}
                emailEnabled={adminMayInvite(config)}
                onChanged={refresh}
              />
            ))}
          </div>
          )}
          {users.length <= 1 && <p className="mt-2 text-xs text-muted">Only you so far.</p>}
          </>
        )}
      </section>
    </div>
  );
}

const LABEL = `mt-3 block ${FIELD_LABEL}`;

function CreateUser({
  onCreated,
  canInvite,
}: {
  onCreated: (user: { name: string; password?: string; email?: string }) => void;
  /** The email field is drawn only when the address can be confirmed; an unverified one would invite takeover. */
  canInvite: boolean;
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
      .then((user) => {
        setName("");
        setEmail("");
        setIsAdmin(false);
        onCreated({ name: user.name, password: user.password, email: user.email });
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  // The admin checkbox precedes Create in DOM order, so tabbing reaches the choice before the button.
  return (
    <form onSubmit={submit} className="max-w-sm">
      <h2 className={SETTINGS_HEADING}>Add a person</h2>
      <label htmlFor="new-user-name" className={LABEL}>
        Name
      </label>
      <input
        id="new-user-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="ada"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={`mt-1 w-full ${FIELD}`}
      />
      {canInvite && (
        <>
          <label htmlFor="new-user-email" className={LABEL}>
            Email (optional)
          </label>
          <input
            id="new-user-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="ada@example.com"
            type="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={`mt-1 w-full ${FIELD}`}
          />
        </>
      )}
      <label className="mt-2 inline-flex min-h-11 w-fit items-center gap-2 pr-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={isAdmin}
          onChange={(event) => setIsAdmin(event.target.checked)}
          className="h-4 w-4 shrink-0"
        />
        also an admin
      </label>
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-2">
        <Button type="submit" tone="primary" disabled={busy || name.trim().length === 0}>
          {busy ? <Spinner /> : "Create"}
        </Button>
      </div>
    </form>
  );
}

// A union rather than booleans, so two panels can never be open under one row (Q1.631).
type RowPanel = "limit" | null;


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
  const state = userState(user, emailEnabled);
  const [confirming, setConfirming] = useState(false);
  const [panel, setPanel] = useState<RowPanel>(null);
  const [placement, setPlacement] = useState<"up" | "down">("down");
  const rowRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (panel !== null) panelRef.current?.scrollIntoView({ block: "nearest" });
  }, [panel]);

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

  const over = user.machinesOverLimit ?? 0;
  const atLimit =
    over === 0 && typeof user.machineLimit === "number" && (user.machines ?? 0) >= user.machineLimit && user.machineLimit > 0;

  return (
    <div ref={rowRef} className="border-b border-edge/60 last:border-b-0">
      <div
        className={`flex min-h-11 gap-2 px-3 ${
          confirming
            ? "flex-col items-start py-2 sm:flex-row sm:items-center"
            : "items-center py-1.5"
        }`}
      >
        <span className={`flex min-w-0 items-center gap-1.5 ${confirming ? "w-full sm:flex-1" : "flex-1"}`}>
          <span className="truncate text-sm font-medium">{user.name}</span>
          {isSelf && <span className="shrink-0 text-2xs font-normal text-faint">you</span>}
          {/* admin always draws; userState picks at most one other badge, by precedence. */}
          {user.isAdmin && <Badge tone="strong">admin</Badge>}
          {state !== null && <Badge tone="strong">{userStateText(state)}</Badge>}
          {over > 0 && <Badge tone="strong">{`${over} machine${over === 1 ? "" : "s"} off`}</Badge>}
          {atLimit && <Badge>{`${user.machines ?? 0} of ${user.machineLimit}`}</Badge>}
        </span>

        <div
          className={`flex shrink-0 items-center gap-1.5 ${confirming ? "w-full justify-end sm:w-auto" : ""}`}
        >
          {/* Cancel is last so a double-tap lands on the control that undoes the first tap (Q3.552). */}
          {confirming ? (
            <TwoStep
              armed
              onArm={setConfirming}
              question={
                <>
                  Delete <span className="font-medium">{user.name}</span> for good?
                </>
              }
              act={{ label: "Delete", danger: true, icon: Trash2 }}
              onAct={() =>
                // Not through run: its busy greys the kebab, which is not drawn while TwoStep owns the wait.
                cp.adminDeleteUser(user.id).then((answer) => {
                  toast("ok", `${answer.name} is gone.`);
                  onChanged();
                })
              }
            />
          ) : (
            // Disable and Delete are absent on your own row: the server refuses both, and nothing undoes them.
            <Menu
              align="right"
              placement={placement}
              panelClassName="w-56"
              trigger={(open, toggle) => (
                <IconButton
                  icon={MoreHorizontal}
                  label={`Actions for ${user.name}`}
                  size="sm"
                  active={open}
                  disabled={busy}
                  onClick={() => {
                    setPlacement(menuPlacement(rowRef.current));
                    toggle();
                  }}
                />
              )}
            >
              {(close) => (
                <>
                  {/* No API keys item: an admin can neither see nor act on another person's keys (Q1.631). */}
                  <RowAction
                    label={
                      typeof user.machineLimit === "number"
                        ? `Machine limit (${user.machines ?? 0} of ${user.machineLimit})`
                        : "Machine limit"
                    }
                    onClick={() => {
                      close();
                      setPanel(panel === "limit" ? null : "limit");
                    }}
                  />
                  {/* Only for an invited account (no password, an address, mail enabled); anything else answers 409. */}
                  {!user.hasPassword && user.email !== null && emailEnabled && (
                    <RowAction
                      label="Resend invitation"
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
            </Menu>
          )}
        </div>
      </div>

      {panel === "limit" && (
        <div ref={panelRef}>
          <MachineLimitPanel user={user} onChanged={onChanged} onClose={() => setPanel(null)} />
        </div>
      )}
    </div>
  );
}

/** An expandable form under the row; its box is TWO_STEP_BOX by name so the last child keeps its pixels (Q3.552). */
function MachineLimitPanel({
  user,
  onChanged,
  onClose,
}: {
  user: AdminUserRow;
  onChanged: () => void;
  onClose: () => void;
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

  // busy is held here, not in write: a poll can redraw the form while a confirmed act is still out.
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
  // One-tap paths reset confirming, which otherwise outlives a poll that empties the consequence.
  const write = (work: Promise<cp.MachineLimitAnswer>): void => {
    void apply(work)
      .then(() => setConfirming(null))
      .catch((cause: unknown) => toast("error", errorText(cause)));
  };

  return (
    <div className="border-t border-edge/50 px-3 pb-3 pt-2">
      <p className="text-xs text-muted">
        {`${owned} of ${current} · ${user.machineLimitSource === "override" ? "override" : "default"}`}
      </p>

      {confirming === "save" && consequence !== null ? (
        // plain, not danger: lowering the limit undoes itself once the number goes back up.
        <TwoStep
          armed={confirming === "save"}
          onArm={(next) => setConfirming(next ? "save" : null)}
          disabled={busy}
          className="mt-2"
          question={consequence}
          act={{ label: "Save limit" }}
          onAct={() => apply(cp.adminSetMachineLimit(user.id, next))}
        />
      ) : confirming === "clear" ? (
        <TwoStep
          armed={confirming === "clear"}
          onArm={(next) => setConfirming(next ? "clear" : null)}
          disabled={busy}
          className="mt-2"
          question={clearingCost ?? "Drops to the default; machines over it stop. Raising it brings them back."}
          act={{ label: "Use the default" }}
          onAct={() => apply(cp.adminClearMachineLimit(user.id))}
        />
      ) : (
        <div className={`${TWO_STEP_BOX} mt-2`}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            inputMode="numeric"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={`Machine limit for ${user.name}`}
            className={`w-20 ${FIELD}`}
          />
          <Button
            tone="primary"
            size="sm"
            disabled={busy || !dirty}
            onClick={() =>
              // Raising lands at once; only a change that stops machines confirms first.
              consequence === null ? write(cp.adminSetMachineLimit(user.id, next)) : setConfirming("save")
            }
          >
            {busy ? <Spinner /> : "Save"}
          </Button>
          {user.machineLimitSource === "override" && (
            <Button
              size="sm"
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
          <Button size="sm" tone="ghost" disabled={busy} onClick={onClose}>
            Close
          </Button>
        </div>
      )}
      {problem !== null && <p className="mt-2 text-sm text-danger">{problem}</p>}
    </div>
  );
}

