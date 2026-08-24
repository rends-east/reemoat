import { MoreHorizontal, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import type { AdminUserRow, ApiKeyRecord } from "../../cp";
import { userState, userStateText } from "../../account";
import { errorText } from "../../http";
import { adminMayInvite, type InstanceConfig } from "../../instance";
import { machineLimitChangeNotice, machineLimitProblem } from "../../quota";
import type { Me } from "../../wire";
import {
  Badge,
  Button,
  DangerButton,
  Empty,
  FIELD,
  IconButton,
  Menu,
  RowAction,
  SETTINGS_HEADING,
  SETTINGS_SECTION,
  Spinner,
  shortDuration,
} from "../bits";
import { toast } from "../Toast";
import { OneTimeSecret } from "./OneTimeSecret";

/**
 * Who else may use this control plane.
 *
 * **This screen is not the guard, and saying so is the point.** Every route it
 * calls sits behind `requireAdmin` on the control plane, which is the
 * enforcement; `visibleSections`/`sectionAllowed` in `settings.ts` only stop the
 * app *offering* a screen whose every request would answer 403. "The client hides
 * it" is the sentence that precedes somebody deleting the server check as
 * redundant, so it is written down here rather than assumed.
 *
 * `CLAUDE.md` used to list an admin UI as a deliberate non-goal — "no admin UI
 * for users, machines or grants (that stays `cpctl`)". Two thirds of that is
 * reversed here. **Grants are not**: sharing a machine with a second person is
 * still `cpctl admin grant`, because it is the one operation with no obvious
 * shape on a phone and no demand behind it.
 */
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
      <p className="text-xs text-muted">
        Everybody here signs in with a name and a password, and adds their own machines. Sharing one machine between
        two people is still <code className="font-mono">cpctl admin grant</code>.
      </p>

      <CreateUser
        canInvite={adminMayInvite(config)}
        onCreated={(user) => {
          setCreated(user);
          refresh();
        }}
      />

      {/*
        Two results, told apart here rather than smoothed over.

        With mail configured the server **invites** and no password exists at any
        moment — so there is nothing to copy, and rendering a one-time card with
        an absent value would print "copy this" over `undefined`. That is exactly
        why `CreatedUser.password` became optional: it forces the two shapes to be
        distinguished at the call site.
      */}
      {created !== null && created.password !== undefined && (
        <OneTimeSecret
          label={`Password for ${created.name}`}
          value={created.password}
          note="Shown once — only its hash is stored. They must replace it the first time they sign in."
          onDone={() => setCreated(null)}
        />
      )}
      {created !== null && created.password === undefined && (
        <p className="mt-3 text-sm text-muted">
          Invitation sent to {created.email}. They choose their own password from the link — nobody else ever
          sees one.{" "}
          <button type="button" onClick={() => setCreated(null)} className="tap underline hover:text-fg">
            Dismiss
          </button>
        </p>
      )}

      {error !== null && <Empty>{error}</Empty>}
      {users === null && error === null && (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted">
          <Spinner /> reading users…
        </div>
      )}

      {/*
       * A table rather than a stack of cards.
       *
       * Each person was a bordered card with the name on one line, the id and a
       * session count on another, and the buttons on a third — 90px of vertical
       * space to say four things, so four people filled the screen. Everything
       * here is one short row: who they are, what state they are in, and the two
       * things you can do about it. Nothing is lost, because the card had no
       * fourth line to lose.
       */}
      {users !== null && users.length > 0 && (
        <section className={SETTINGS_SECTION}>
          {/* `h2` under `Settings.tsx`'s `h1`, and the only label this list has —
              the intro above it is prose about grants, not a heading. In the app's
              one settings-section chrome rather than a hand-written `mt-6` with no
              rule: see `SETTINGS_SECTION` for what those three spellings cost. */}
          <h2 className={SETTINGS_HEADING}>People</h2>
          {/*
           * **No `overflow-hidden`, and its removal is required rather than
           * cosmetic.** `Menu` is `absolute` against its trigger and never
           * portals — that is what lets it anchor without measuring the viewport
           * — so its one stated caller obligation is that nothing between the
           * trigger and the scroll container may clip. This box was clipping, and
           * a kebab on the last row would have opened into nothing. It was only
           * ever rounding the corners of rows that have no fill of their own, and
           * `last:border-b-0` already handles the bottom rule.
           */}
          <div className="mt-2 rounded-lg border border-edge">
            {users.map((user, index) => (
              <UserRow
                key={user.id}
                user={user}
                isSelf={user.id === me?.id}
                /*
                 * **The bottom two rows open their menu upward, and it is a prop
                 * because measuring the viewport is forbidden.**
                 *
                 * `Menu` is `absolute` and defaults to `top-full`, so the last
                 * row's panel is drawn past the bottom of the settings pane.
                 * Measured on a 375×667 phone with three users, the 190px panel
                 * ended 50px below the pane and "Delete" — the last item — was off
                 * screen; with six users only the top edge of the first item
                 * showed. Since every per-row act moved into this menu, that is
                 * every act on the bottom row unreachable until the reader
                 * discovers a scrollbar their own tap created.
                 *
                 * Two rows rather than one, because a menu that clears the edge by
                 * a few pixels is still a menu somebody has to scroll. `placement`
                 * is a prop on `Menu` for the reason its docblock gives — a
                 * detected direction is breakpoint-state-in-JavaScript wearing a
                 * hat — so the caller answers it from what it knows, which here is
                 * the row's index.
                 */
                openUp={index >= users.length - 2 && users.length > 2}
                emailEnabled={adminMayInvite(config)}
                onChanged={refresh}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function CreateUser({
  onCreated,
  canInvite,
}: {
  onCreated: (user: { name: string; password?: string; email?: string }) => void;
  /**
   * Whether an address can be taken at all.
   *
   * **The field is not drawn without it**, and that is the whole rule: an address
   * recorded here would be *unverified*, so it is either trusted for a reset — in
   * which case an admin's typo is account takeover by whoever owns the typo'd
   * domain — or untrusted, in which case it is a field that does nothing.
   * `adminMayInvite` fails closed while the config is unknown, because the cost
   * of being wrong is that the admin hands a password over by hand, which is the
   * status quo.
   */
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
    /*
     * **The server generates the password.** An admin typing one for somebody else
     * picks a weaker one and sends it through a chat app anyway; generating it
     * fixes the first half and keeps a second password policy — one person
     * choosing for another — out of the client entirely. It is the same shape
     * `POST /v1/admin/users` already had for `apiKey`: the only time the value
     * exists anywhere.
     */
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

  return (
    <form onSubmit={submit} className="mt-3">
      <div className="flex max-w-sm gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="name"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="New user name"
          className={`min-w-0 flex-1 ${FIELD}`}
        />
        <Button type="submit" tone="primary" disabled={busy || name.trim().length === 0}>
          {busy ? <Spinner /> : "Create"}
        </Button>
      </div>
      {canInvite && (
        <>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="email (optional)"
            type="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="New user email"
            className={`mt-2 w-full max-w-sm ${FIELD}`}
          />
          <p className="mt-1 max-w-sm text-xs text-muted">
            With an address they are invited and choose their own password. Without one you are handed a temporary
            password to pass on, and they must replace it before they can do anything.
          </p>
        </>
      )}
      {/*
       * **A 44px target on the control that decides whether somebody is an
       * admin.** It was a bare native checkbox — 16 to 20px depending on the
       * platform — inside a `text-xs` label, in an app where `Button` and
       * `menuRow` are both `min-h-11`. The `<label>` wraps the input, so the
       * whole 44px strip toggles it; `w-fit` keeps that strip the width of the
       * control and its words rather than the width of the form, since a
       * full-bleed toggle catches taps aimed at nothing.
       */}
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
    </form>
  );
}

function UserRow({
  user,
  isSelf,
  openUp = false,
  onChanged,
  emailEnabled,
}: {
  user: AdminUserRow;
  isSelf: boolean;
  /** Near the bottom of the list, so the kebab's panel opens upward. */
  openUp?: boolean;
  onChanged: () => void;
  /** Whether anybody on this instance could confirm an address at all. */
  emailEnabled: boolean;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  /*
   * Per row rather than "which row is confirming" in the parent, because the
   * parent re-renders on every refresh and the list is keyed by id: a row that
   * disappears takes its own pending confirmation with it, and cannot leave the
   * question pointing at whoever moved into that position.
   */
  /*
   * `emailEnabled` is the second argument because on an instance with no SMTP
   * *nobody* has a confirmed address, so a badge on every row would be noise.
   */
  const state = userState(user, emailEnabled);
  const [confirming, setConfirming] = useState(false);
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [limitOpen, setLimitOpen] = useState(false);

  /**
   * `done` receives the answer, which it used to be handed no way to read.
   *
   * Generic rather than `Promise<unknown>` so a route whose *body* says something
   * an admin needs — how many enrollment codes a ban just burned — can say it
   * without a second code path around this helper. Every existing callback takes
   * no parameter and is unaffected.
   */
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

  /**
   * Open or close the key list for this row, re-reading it on every open.
   *
   * (The docblock that used to sit here described `needsProof`, which went with
   * the reset-password and mint-key actions; it was left attached to the next
   * function down when they were deleted. Nothing on this row asks for a
   * password any more — an admin may revoke a key here and may not issue one.)
   */
  const toggleKeys = (): void => {
    if (keysOpen) {
      setKeysOpen(false);
      return;
    }
    setKeysOpen(true);
    // Back to the spinner on every open: rows held from a previous open are a
    // claim about a list somebody may have changed since.
    setKeys(null);
    void cp
      .adminUserKeys(user.id)
      .then(setKeys)
      .catch((cause: unknown) => {
        setKeysOpen(false);
        toast("error", errorText(cause));
      });
  };

  return (
    <div className="border-b border-edge/60 last:border-b-0">
      {/*
       * **One line at every width, because there is one control on it.**
       *
       * This row used to carry every action as a peer button — "Reset password",
       * "Keys (N)", Enable/Disable, Delete, plus a reserved 184px slot so rows
       * without the last two did not shift. Measured, that is about 370px of
       * controls before the gaps; inside this screen's `px-4`, the table's border
       * and the row's own `px-3`, a 390px phone has roughly 330px of row. So the
       * name got single digits of pixel, the badges got none, and below `sm` the
       * whole thing stacked into a wrapping column — the collapse that was
       * reported.
       *
       * Every action is behind one kebab now, which is the remedy this codebase
       * already uses for exactly this problem on exactly this shape:
       * `SessionMenu` on a session row. It also removes the reserved slot, since
       * the trigger is a fixed square that is present on every row whether or not
       * the menu under it has two items or four — the alignment the slot was
       * buying comes free.
       */}
      {/*
       * **The resting row is one line and the confirming row is two, below `sm`.**
       *
       * One line is right while the only control is a kebab. It is wrong the
       * moment the confirmation replaces it: the answers are `shrink-0` and the
       * name is the only flexible child, so on a 390px phone the name span was
       * measured at 25.7px against the 80px `christina.wu` needs — even `alice`
       * truncated. The row's own rule below says the point of drawing the question
       * in place of the buttons is that "the name being deleted is right beside
       * it, unmoved", and a name cut to two characters and an ellipsis is not that.
       * So while confirming it stacks, which gives the name a full-width line of
       * its own, and from `sm` up — where the measurement was never the problem —
       * nothing changes.
       */}
      <div
        className={`flex min-h-11 gap-2 px-3 ${
          confirming
            ? "flex-col items-start py-2 sm:flex-row sm:items-center"
            : "items-center py-1.5"
        }`}
      >
        {/*
         * Name and badges in **one** group, and that is the fix rather than a
         * tidy-up. The name span used to be the `flex-1`, so it swallowed every
         * free pixel and pushed the badges hard against the buttons at the far
         * right — a row where "admin" sat four inches from the person it was
         * about and an inch from a control it had nothing to do with. What is
         * `flex-1` now is the pair, so the badges stay where the eye already is.
         *
         * `w-full` in the stacked state for the reason a `truncate` always needs:
         * a column flex container sizes its children to their content, so a
         * truncation with no width to truncate against does nothing.
         */}
        <span className={`flex min-w-0 items-center gap-1.5 ${confirming ? "w-full sm:flex-1" : "flex-1"}`}>
          <span className="truncate text-sm font-medium">{user.name}</span>
          {isSelf && <span className="shrink-0 text-2xs font-normal text-faint">you</span>}
          {/*
            **`admin` is a role and always draws; everything else is one badge.**

            A row could now say admin, disabled, no password, temporary password
            and unconfirmed email at once — five boxes beside a truncating name
            on a 390px phone, which is the exact collapse the kebab was
            introduced to end. `userState` picks one by precedence, ordered by
            how stuck the person is, each strictly subsuming the next.
          */}
          {user.isAdmin && <Badge tone="strong">admin</Badge>}
          {state !== null && <Badge tone="strong">{userStateText(state)}</Badge>}
          {/*
            A second badge beside `userState`'s one-by-precedence, and bounded:
            it appears only on a row that is genuinely over — which is a fault an
            admin caused and can undo, on a different axis from the credential
            states above it. Every other row draws nothing extra.
          */}
          {(user.machinesOverLimit ?? 0) > 0 && (
            <Badge tone="strong">{`${user.machines ?? 0} of ${user.machineLimit ?? 0} machines`}</Badge>
          )}
        </span>

        <span
          className={`flex shrink-0 items-center gap-1.5 ${confirming ? "w-full justify-end sm:w-auto" : ""}`}
        >
          {/*
           * **Two steps, and the order of the second one is the safety property.**
           *
           * Delete is the only irreversible act on this screen — there is an
           * `enable` for a disable and nothing at all for this — and it sits one
           * button away from "Reset password" on a row that is 44 pixels tall on a
           * phone. So the first tap replaces the row's controls with the question
           * and its two answers, drawn *in place of* the buttons they are about,
           * so there is nothing else on the row to hit by accident and the name
           * being deleted is right beside it, unmoved.
           *
           * **Cancel is last, and that is not arbitrary.** Both groups are laid
           * out left to right in the same box, so a child in the same position
           * lands on the same pixels; `setConfirming(true)` is synchronous, and
           * `.tap` sets `touch-action: manipulation`, which removes the 300ms
           * double-tap delay a browser would otherwise spend before dispatching
           * the second click. With Delete last in both states, a double-tap on a
           * laggy connection — the ordinary response to a button that appears not
           * to have done anything — put the second tap on the confirm and deleted
           * a person irreversibly. Ending the confirm row with Cancel means the
           * second tap lands on the one control that undoes the first.
           *
           * Inline rather than a modal because this app has none, and inventing
           * one for a settings row would be a second dismissal mechanism competing
           * with `AskCard`'s — which is the one thing on screen that must never
           * have to argue about who owns Escape. It stays on the row now that
           * everything else has moved into a menu: a question, its answer and its
           * undo laid out left-to-right is a *row* shape, and a menu that stayed
           * open to hold a confirmation would be a second dismissable layer over
           * the sheet for one tap.
           *
           * `size="sm"` narrows both answers, and it is a **prop** because the
           * `className` this first tried is silently dropped — see `BUTTON_SIZE`.
           * Measured on the shipped CSS before the prop existed, those buttons
           * reported 44px and 12px of padding rather than the 36px and 8px the
           * source asked for, and the row grew from 44px to 56px on the tap, so
           * every row beneath it shifted 12px down at the exact moment a finger
           * was over the confirmation. The 44px floor is about a *tap target*, and
           * these two are the only controls on the row while they are drawn —
           * nothing adjacent to mis-hit.
           */}
          {confirming ? (
            <>
              <span className="text-xs text-muted">Delete for good?</span>
              <DangerButton
                icon={Trash2}
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(
                    cp.adminDeleteUser(user.id).then((answer) => {
                      toast(
                        "ok",
                        answer.machinesRevoked > 0
                          ? `${answer.name} is gone. ${answer.machinesRevoked} machine${
                              answer.machinesRevoked === 1 ? "" : "s"
                            } they registered ${
                              answer.machinesRevoked === 1 ? "is" : "are"
                            } off the network — getting ${
                              answer.machinesRevoked === 1 ? "it" : "them"
                            } back means enrolling on the host again.`
                          : `${answer.name} is gone.`,
                      );
                    }),
                    () => setConfirming(false),
                  )
                }
              >
                {busy ? <Spinner /> : "Delete"}
              </DangerButton>
              <Button size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            /*
             * **Everything a row can do, behind one kebab.**
             *
             * The two acts that are absent for your own row are absent here too:
             * disabling yourself locks the fleet out of its own control plane and
             * deleting yourself does the same with nothing to undo it. The server
             * refuses both, and not offering them is the half that stops somebody
             * finding that out by hitting one — which is also what makes "there is
             * always an enabled admin left" true by construction rather than by a
             * guard, since every caller is an enabled admin and cannot be the row
             * being removed.
             *
             * The reserved 184px slot those two used to sit in is gone with them:
             * this trigger is the same square on every row, so nothing shifts.
             */
            <Menu
              align="right"
              placement={openUp ? "up" : "down"}
              panelClassName="w-56"
              trigger={(open, toggle) => (
                <IconButton
                  icon={MoreHorizontal}
                  label={`Actions for ${user.name}`}
                  size="sm"
                  active={open}
                  disabled={busy}
                  onClick={toggle}
                />
              )}
            >
              {(close) => (
                <>
                  {/*
                   * **An admin could not previously see that a key exists at all.**
                   *
                   * `revoked_at` was a column nothing could write, so the one
                   * credential here that never expires was both immortal and absent
                   * from the list read to answer "who can use this". The count comes
                   * from the fleet list and the rows from `GET
                   * /v1/admin/users/:id/keys`; `undefined` is an older control plane
                   * that did not count, which is a different fact from zero and is
                   * drawn as no number rather than as `0`.
                   *
                   * **It is in the menu rather than deleted, and that is the one
                   * place this row keeps something it was asked to lose.** The
                   * panel behind it is the only caller of `adminRevokeKey`
                   * anywhere in the product — an admin revoking *somebody else's*
                   * key has no other door, in any client, since `cpctl`'s
                   * `keys --revoke` retires only your own. Removing it outright
                   * would take that capability out of the product entirely, which
                   * is precisely the state the invariant "a credential the code
                   * can read is a credential something must be able to write"
                   * exists to end. Off the row it is; out of the product it is
                   * not.
                   */}
                  <RowAction
                    label={typeof user.keys === "number" ? `API keys (${user.keys})` : "API keys"}
                    onClick={() => {
                      close();
                      toggleKeys();
                    }}
                  />
                  {/*
                   * The numbers ride the label, exactly as `API keys (N)` does
                   * one line up: zero row width, and an absent field degrades to
                   * no number rather than to `0 of undefined`. This is the only
                   * place in the app an admin can see how close somebody is to
                   * their limit without opening anything.
                   */}
                  <RowAction
                    label={
                      typeof user.machineLimit === "number"
                        ? `Machine limit (${user.machines ?? 0} of ${user.machineLimit})`
                        : "Machine limit"
                    }
                    onClick={() => {
                      close();
                      setLimitOpen(!limitOpen);
                    }}
                  />
                  {/*
                   * **Only in the one state it is the remedy for**, which is also
                   * the only state this product could not otherwise get out of: an
                   * invited account has no password and an unverified address, so
                   * it can neither sign in nor use the forgotten-password link,
                   * and creating it again answers `409`. An invitation that was
                   * never delivered or never opened left the row looking ordinary
                   * and the person permanently locked out.
                   *
                   * Drawn from the same two facts `userState` orders by, rather
                   * than from a new flag: no password, and an address to send to.
                   * `emailEnabled` gates it too, because with no SMTP there is
                   * nothing to send with and the button would be a 409.
                   */}
                  {!user.hasPassword && user.email !== null && emailEnabled && (
                    <RowAction
                      label="Resend invitation"
                      onClick={() => {
                        close();
                        run(cp.adminInviteUser(user.id), (answer) => {
                          toast(
                            answer.mailQueued ? "ok" : "error",
                            answer.mailQueued
                              ? `Invitation queued for ${answer.email}.`
                              : `Could not queue an invitation for ${answer.email} — check Server settings.`,
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
                          /*
                           * Said out loud for the reason `MachinesSection` says
                           * the identical number out loud: a disable burns every
                           * unredeemed enrollment code this person minted, each
                           * of which mints a full machine identity and rotates a
                           * tunnel key — and **`Enable` does not give them
                           * back**. Silent, the reversible-looking button had an
                           * irreversible half nothing on screen mentioned.
                           *
                           * Only on the disable direction and only when there
                           * were any: `enable` answers `{disabled: false}` alone,
                           * and a toast reporting zero is a toast people learn to
                           * dismiss unread.
                           */
                          const burned = answer.enrollmentCodesInvalidated ?? 0;
                          if (burned > 0) {
                            toast(
                              "ok",
                              `${user.name} is disabled. ${burned} unredeemed enrollment code${burned === 1 ? "" : "s"} ` +
                                `stopped working, and enabling them again will not restore ${burned === 1 ? "it" : "them"}.`,
                            );
                          }
                        });
                      }}
                    />
                  )}
                  {/*
                   * The one `danger` item, and the confirmation is still a *row*
                   * rather than a second menu level: choosing this closes the menu
                   * and arms the two-step above, whose ordering rule is the safety
                   * property.
                   */}
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
        </span>
      </div>

      {keysOpen && (
        <div className="px-3 pb-3">
          {/*
           * Revoked rows are **listed rather than filtered**: the question this
           * panel answers is "is the one that leaked dead yet", which a row that
           * vanishes on revocation cannot answer.
           */}
          {keys === null ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Spinner /> reading keys…
            </div>
          ) : (
            <>
              {keys.length === 0 && <p className="text-xs text-muted">No API keys.</p>}
              {keys.map((record) => (
                <KeyRow
                  key={record.id}
                  userId={user.id}
                  record={record}
                  onChanged={() => {
                    // Same rule as the mint path: a failed re-read keeps the rows
                    // on screen rather than dropping into the spinner state.
                    void cp.adminUserKeys(user.id).then(setKeys).catch(() => undefined);
                    onChanged();
                  }}
                />
              ))}
              {isSelf && (
                // Said before the button rather than after the surprise: cp.ts
                // makes the same point at `revokeMyKey`. There is no self-refusal
                // on the server, deliberately — the account this most needs to
                // work on is the one whose key just leaked.
                <p className="mt-2 text-2xs text-faint">
                  These are your own. Revoking the one this browser is holding signs this tab out on its next
                  request.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {limitOpen && <MachineLimitPanel user={user} onChanged={onChanged} onClose={() => setLimitOpen(false)} />}
    </div>
  );
}

/**
 * How many machines this person may own, raised or lowered.
 *
 * **An expandable panel under the row, opened from the kebab** — the shape
 * `toggleKeys` already established. Not a `Sheet`: that is a second dismissable
 * layer over the settings sheet, for one control. Not inline on the row: that
 * reopens the ~370px-of-controls measurement the kebab was introduced to end.
 * And not a two-step row confirmation, because this is a *form* — a number, a
 * Save, a Reset and a sentence — rather than a yes/no.
 *
 * `Domains`' draft/dirty/explicit-Save shape, and `machineLimitProblem` is the
 * **same** validator `ServerSection` calls.
 */
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
  /*
   * Which act is being confirmed, rather than a boolean.
   *
   * Two controls on this panel switch machines off — saving a lower number and
   * clearing the override — and they state different sentences. A second boolean
   * would make "both true" spellable; a union makes the JSX a partition.
   */
  const [confirming, setConfirming] = useState<"save" | "clear" | null>(null);
  const problem = machineLimitProblem(draft);
  const next = Number.parseInt(draft.trim(), 10);
  const dirty = draft.trim().length > 0 && problem === null && next !== current;
  /*
   * **Whether to confirm is this function's answer, not a `<` in the JSX.**
   *
   * Pure, so `webcheck` can assert both the sentence and the decision to ask;
   * written inline it would be a rule with no way to test it and two places to
   * get the off-by-one wrong.
   */
  const consequence = dirty ? machineLimitChangeNotice(user.name, owned, next) : null;
  /*
   * **The same question asked of "use the default", which used to skip it.**
   *
   * That button wrote straight through `write()` with no gate, and it is not the
   * harmless one: clearing an override of ten on an instance whose default is
   * two stops eight machines on one tap. The only feedback was the `suspended`
   * toast, which arrives after they are already off — and the docblock on
   * `machineLimitChangeNotice` claims "the admin screen draws its confirmation
   * iff this is non-null", which was false for exactly this path.
   *
   * `machineLimitDefault` is what the row now carries so the sentence can name
   * the number. Absent — an older control plane — it is `null` and the arm below
   * confirms anyway with a sentence that names no number, because "I cannot tell
   * you what this costs" is a reason to ask rather than a reason to skip asking.
   */
  const clearingCost =
    user.machineLimitSource === "override" && typeof user.machineLimitDefault === "number"
      ? machineLimitChangeNotice(user.name, owned, user.machineLimitDefault)
      : null;
  const clearingUnknown =
    user.machineLimitSource === "override" && typeof user.machineLimitDefault !== "number";

  const write = (work: Promise<cp.MachineLimitAnswer>): void => {
    setBusy(true);
    void work
      .then((answer) => {
        setConfirming(null);
        setDraft(String(answer.maxMachines));
        if (answer.suspended.length > 0) {
          toast(
            "ok",
            `${answer.suspended.length} machine${answer.suspended.length === 1 ? "" : "s"} stopped working. ` +
              "Nothing was deleted — raising the limit brings them back.",
          );
        }
        onChanged();
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="border-t border-edge/50 px-3 pb-3 pt-2">
      <p className="text-xs text-muted">
        {user.name} owns {owned} machine{owned === 1 ? "" : "s"}. Their limit is {current}
        {user.machineLimitSource === "override" ? ", set for them" : ", from the instance default"}.
      </p>

      {confirming === "save" && consequence !== null ? (
        <>
          <p className="mt-2 text-xs text-muted">{consequence}</p>
          {/*
           * `plain`, not `DangerButton` — that glyph is reserved for the
           * irreversible, and this is the one destructive-looking act in the app
           * that undoes itself the moment the number goes back up. Cancel is
           * **last**, the ordering safety property every confirming row here
           * shares: both groups occupy the same box, `.tap` removes the
           * double-tap delay, and a second tap aimed at a control that looked
           * inert must land on the undo.
           */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button tone="plain" size="sm" disabled={busy} onClick={() => write(cp.adminSetMachineLimit(user.id, next))}>
              {busy ? <Spinner /> : "Save limit"}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </>
      ) : confirming === "clear" ? (
        <>
          {/*
           * The same shape and the same Cancel-last ordering as the arm above.
           * The sentence is `machineLimitChangeNotice` where the row told us what
           * the default is, and the honest admission where it did not.
           */}
          <p className="mt-2 text-xs text-muted">
            {clearingCost ??
              `${user.name}'s limit becomes the instance default, which may be lower than the one set for them ` +
                "and may stop machines. Raising it again brings them back."}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button tone="plain" size="sm" disabled={busy} onClick={() => write(cp.adminClearMachineLimit(user.id))}>
              {busy ? <Spinner /> : "Use the default"}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
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
          {dirty && (
            <Button
              tone="primary"
              size="sm"
              disabled={busy}
              onClick={() =>
                // Raising costs nobody anything and lands at once; only a change
                // that switches somebody's machine off states itself first.
                consequence === null ? write(cp.adminSetMachineLimit(user.id, next)) : setConfirming("save")
              }
            >
              {busy ? <Spinner /> : "Save"}
            </Button>
          )}
          {/*
           * Offered for exactly one origin, which is `canResetField`'s rule:
           * where there is no override there is nothing to reset *to*.
           *
           * Gated like Save and for its reason: this drops them onto the instance
           * default, which can be far below the override being cleared, and it
           * was the one control on this panel that wrote without asking. Silent
           * only when the default is known to cost nothing — `clearingCost` is
           * `null` for a default at or above what they own — and never silent
           * when the row did not say what the default is.
           */}
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

/**
 * One API key, and the two-step that retires it.
 *
 * Its own component for the reason `UserRow`'s confirmation is: the confirming
 * state belongs to the row it is about, so a refreshed list cannot leave the
 * question pointing at a different key. Same ordering rule as well — the answer
 * that undoes the question is **last**, so a second tap on a laggy connection
 * cancels rather than confirms.
 */
function KeyRow({
  userId,
  record,
  onChanged,
}: {
  userId: string;
  record: ApiKeyRecord;
  onChanged: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const revoked = record.revokedAt !== null;

  return (
    <div className="flex flex-col items-start gap-2 border-b border-edge/50 py-2 last:border-b-0 sm:flex-row sm:items-center sm:gap-3">
      <span className="flex w-full min-w-0 items-center gap-2 sm:flex-1">
        {/* The eight clear characters the lookup is indexed on — never the key and
            never its hash, neither of which this route will ever send. It is the
            only thing that lets somebody holding two keys tell which row is
            which. */}
        <span className="truncate font-mono text-xs">{record.prefix}…</span>
        {revoked && <Badge tone="plain">revoked</Badge>}
      </span>
      <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
        <span className="text-2xs text-muted">
          {`made ${shortDuration(Math.max(0, Date.now() - record.createdAt))} ago`}
        </span>
        {!revoked &&
          (confirming ? (
            <>
              <span className="text-xs text-muted">Revoke it?</span>
              <DangerButton
                icon={Trash2}
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void cp
                    .adminRevokeKey(userId, record.id)
                    .then(() => {
                      setConfirming(false);
                      onChanged();
                    })
                    .catch((cause: unknown) => toast("error", errorText(cause)))
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? <Spinner /> : "Revoke"}
              </DangerButton>
              <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              Revoke
            </Button>
          ))}
      </span>
    </div>
  );
}


/*
 * `RowAction` was here, and it is in `bits.tsx` now.
 *
 * It moved when `MachinesSection` grew a kebab of its own: a second hand-written
 * copy is how one of the two loses `role="menuitem"` or picks a different danger
 * wash, with nothing anywhere saying they were meant to match. The argument for
 * why a menu act is a *tone* rather than a `DangerButton` moved with it, since
 * that is the part a reader would otherwise come here looking for.
 */
