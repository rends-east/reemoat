import { MoreHorizontal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import type { AdminUserRow, ApiKeyRecord } from "../../cp";
import { orderKeys, userState, userStateText } from "../../account";
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
  SkeletonRow,
  Spinner,
} from "../bits";
import { toast } from "../Toast";
import { KeyRow, KeyTable } from "./KeyRow";
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
 * shape on a phone and no demand behind it. The screen used to open with that
 * sentence — the first line an admin read was a limitation of a CLI they may
 * never use — and it is a fact for this docblock and `web-shell.md`, not for the
 * screen (decision 11A: CLI on a settings screen is a white-list of three lines,
 * and this is not one of them).
 *
 * **Two things on screen, in this order: Add a person, then the People list.**
 * Nothing narrates either; the headings are the instructions.
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
      {/*
       * **Above the form, not under it.** A listing that failed is the first
       * fact about this screen — every row's act goes to the same control plane
       * — and a form drawn above a failure invites a create that will answer the
       * same way. `Empty failed` is the app's one failure shape, with the retry
       * beside it.
       */}
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

      {/*
        Two results, told apart here rather than smoothed over.

        With mail configured the server **invites** and no password exists at any
        moment — so there is nothing to copy, and rendering a one-time card with
        an absent value would print "copy this" over `undefined`. That is exactly
        why `CreatedUser.password` became optional: it forces the two shapes to be
        distinguished at the call site. **The card is the explanation**: the form
        used to say in advance which of the two would happen, in twenty-one
        words, and the result says it in one line after the fact.
      */}
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

      {/*
       * A table rather than a stack of cards.
       *
       * Each person was a bordered card with the name on one line, the id and a
       * session count on another, and the buttons on a third — 90px of vertical
       * space to say four things, so four people filled the screen. Everything
       * here is one short row: who they are, what state they are in, and the two
       * things you can do about it. Nothing is lost, because the card had no
       * fourth line to lose.
       *
       * **The heading is always drawn**, in all three states. A list that has not
       * arrived yet stands one `SkeletonRow` under it — never a sentence, and
       * never "Nobody yet.", which was unreachable: the admin reading this is a
       * row, so the shortest real list is one.
       */}
      <section className={SETTINGS_SECTION}>
        {/* `h2` under `Settings.tsx`'s `h1`. In the app's one settings-section
            chrome rather than a hand-written `mt-6` with no rule: see
            `SETTINGS_SECTION` for what those three spellings cost. */}
        <h2 className={SETTINGS_HEADING}>People</h2>
        {users === null ? (
          error === null && <SkeletonRow />
        ) : (
          <>
          {/* Drawn whenever there is a row, the admin's own included: that row
              carries the kebab with the limit readout and Resend invitation,
              which a sentence standing in for it would hide. The sentence sits
              under the one row rather than instead of it. */}
          {users.length > 0 && (
          /*
           * **No `overflow-hidden`, and its removal is required rather than
           * cosmetic.** `Menu` is `absolute` against its trigger and never
           * portals — that is what lets it anchor without measuring the viewport
           * — so its one stated caller obligation is that nothing between the
           * trigger and the scroll container may clip. This box was clipping, and
           * a kebab on the last row would have opened into nothing. It was only
           * ever rounding the corners of rows that have no fill of their own, and
           * `last:border-b-0` already handles the bottom rule.
           */
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

/** A field's visible name. 12px, never `text-2xs`: a label is read, not scanned. */
const LABEL = "mt-3 block text-xs font-semibold tracking-wider text-muted uppercase";

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

  /*
   * **Every field has a visible label, and placeholders are examples.** The form
   * had `placeholder="name"` as its only label — gone the moment somebody types
   * — and "email (optional)" the same. `Gate.tsx` already keeps the rule for the
   * sign-up form this creates the same kind of account as.
   *
   * **The admin checkbox comes before Create in DOM order.** It came after, so
   * the tab order and the reading order both reached the button before the one
   * choice that changes what the button does; a keyboard user who tabbed to
   * Create and pressed it had made an admin decision by omission. `webcheck` pins
   * the order as source text.
   */
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
      <div className="mt-2">
        <Button type="submit" tone="primary" disabled={busy || name.trim().length === 0}>
          {busy ? <Spinner /> : "Create"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Which panel under a row is open. **One at a time**: the keys list and the
 * machine limit used to be two booleans, so both could be open under one row and
 * the limit panel — drawn second — sat under a key list that had just changed
 * height. A union makes "both" unspellable.
 */
type RowPanel = "keys" | "limit" | null;

/**
 * How much room a kebab's panel needs below the row before it opens upward.
 *
 * `w-56` and four items measure about 190px; the margin is for the sheet's own
 * bottom padding. The row's *position* is measured, on the tap, and that is a
 * different thing from the breakpoint-in-JavaScript `AppShell` forbids: no
 * render branches on it, no width is read, and the answer is about *this* row
 * at *this* moment — which its index in the list, the previous answer, could
 * not know. The last two rows opened upward by index, so a two-row list opened
 * both up on a desktop with a whole pane of room below them, and a ten-row list
 * on a phone opened the third-from-last into the sheet's footer.
 */
const MENU_ROOM_PX = 240;

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
  const [panel, setPanel] = useState<RowPanel>(null);
  const [placement, setPlacement] = useState<"up" | "down">("down");
  const rowRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * **A panel that opens off screen is a panel nobody finds.** On a phone the
   * kebab is at the bottom of the sheet more often than not, and the panel it
   * opens is drawn *under* the row — below the fold. `nearest` so a panel that
   * is already visible moves nothing, which is the case on a desktop.
   */
  useEffect(() => {
    if (panel !== null) panelRef.current?.scrollIntoView({ block: "nearest" });
  }, [panel]);

  /**
   * `done` receives the answer, which it used to be handed no way to read.
   *
   * Generic rather than `Promise<unknown>` so a route whose *body* says something
   * an admin needs can say it without a second code path around this helper.
   * Every existing callback takes no parameter and is unaffected.
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
   * Nothing on this row asks for a password — an admin may revoke a key here and
   * may not issue one.
   */
  const toggleKeys = (): void => {
    if (panel === "keys") {
      setPanel(null);
      return;
    }
    setPanel("keys");
    // Back to the placeholder on every open: rows held from a previous open are
    // a claim about a list somebody may have changed since.
    setKeys(null);
    void cp
      .adminUserKeys(user.id)
      .then((rows) => setKeys(orderKeys(rows)))
      .catch((cause: unknown) => {
        setPanel(null);
        toast("error", errorText(cause));
      });
  };

  const over = user.machinesOverLimit ?? 0;
  const atLimit =
    over === 0 && typeof user.machineLimit === "number" && (user.machines ?? 0) >= user.machineLimit && user.machineLimit > 0;

  return (
    <div ref={rowRef} className="border-b border-edge/60 last:border-b-0">
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
            it appears only on a row that is genuinely at or over its limit —
            a fault an admin caused and can undo, on a different axis from the
            credential states above it. Every other row draws nothing extra.

            **This is where the toast's fact went** (decision D-U-1). "2 machines
            stopped working" used to be said once, for four seconds, after the
            save; it is a fact about the row for as long as it is true, and the
            listing already carries it as `machinesOverLimit`. A fact nobody can
            re-read is a toast by another name, so the row says it and the toast
            says only that the save landed.
          */}
          {over > 0 && <Badge tone="strong">{`${over} machine${over === 1 ? "" : "s"} off`}</Badge>}
          {atLimit && <Badge>{`${user.machines ?? 0} of ${user.machineLimit}`}</Badge>}
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
           * being deleted is right beside it, unmoved — and **named in the
           * question**, which is every confirmation's rule now: action, subject,
           * effect.
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
              <span className="text-xs text-muted">
                Delete <span className="font-medium text-fg">{user.name}</span> for good?
              </span>
              <DangerButton
                icon={Trash2}
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(
                    /*
                     * "N machines they registered are off the network — enrolling
                     * again brings them back" used to ride this toast. It was a
                     * fact about machines that are no longer in any list an admin
                     * can open, so nothing on screen could carry it as state; a
                     * fact nobody can re-read is dropped rather than flashed
                     * (D-U-1). The row is gone, and the toast says that.
                     */
                    cp.adminDeleteUser(user.id).then((answer) => toast("ok", `${answer.name} is gone.`)),
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
             *
             * `placement` is measured on the tap — see `MENU_ROOM_PX` — and handed
             * to `Menu` as the prop it insists on; the menu itself detects nothing.
             */
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
                    const rect = rowRef.current?.getBoundingClientRect();
                    if (rect !== undefined) {
                      setPlacement(window.innerHeight - rect.bottom < MENU_ROOM_PX ? "up" : "down");
                    }
                    toggle();
                  }}
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
                   * their limit without opening anything — the row's badge is
                   * drawn only at or over it.
                   */}
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
                        /*
                         * A disable burns every unredeemed enrollment code this
                         * person minted, and `Enable` does not give them back. The
                         * toast used to say how many. **It no longer does**
                         * (D-U-1): nothing on the row can re-derive that number,
                         * so a four-second sentence was the only copy of it, and
                         * a fact nobody can re-read is a toast by another name.
                         * The permanent fact — that they are disabled — is the
                         * badge `userState` draws for as long as it is true; the
                         * toast says only that the act landed.
                         */
                        run(cp.adminSetDisabled(user.id, !user.disabled), (answer) => {
                          if (answer.disabled) toast("ok", `${user.name} is disabled.`);
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

      {panel === "keys" && (
        <div ref={panelRef} className="border-t border-edge/50 px-3 pb-3 pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className={SETTINGS_HEADING}>API keys</span>
            {/* Both panels close the same way — this one had no Close while the
                limit panel did, so the only way to fold it was the kebab again. */}
            <Button size="sm" tone="ghost" onClick={() => setPanel(null)}>
              Close
            </Button>
          </div>
          {/*
           * Revoked rows are **listed rather than filtered**: the question this
           * panel answers is "is the one that leaked dead yet", which a row that
           * vanishes on revocation cannot answer. Newest first, revoked last —
           * `orderKeys`, the same order the person's own API keys screen draws.
           *
           * `KeyRow` is the one shared with that screen, with `confirm` on: an
           * admin retiring *somebody else's* credential is two taps, and the
           * question names the key (Q3.219). No sentence about this browser's own
           * key here — an admin's own keys are the API keys section's job, and
           * the row cannot know which one this tab holds without repeating that
           * screen's logic.
           */}
          {keys === null ? (
            <SkeletonRow />
          ) : keys.length === 0 ? (
            <p className="mt-1 text-xs text-muted">No keys.</p>
          ) : (
            <KeyTable>
              {keys.map((record) => (
                <KeyRow
                  key={record.id}
                  record={record}
                  confirm={true}
                  revoke={() => cp.adminRevokeKey(user.id, record.id)}
                  onRevoked={() => {
                    // Same rule as the mint path: a failed re-read keeps the rows
                    // on screen rather than dropping into the placeholder state.
                    void cp
                      .adminUserKeys(user.id)
                      .then((rows) => setKeys(orderKeys(rows)))
                      .catch(() => undefined);
                    onChanged();
                  }}
                />
              ))}
            </KeyTable>
          )}
        </div>
      )}

      {panel === "limit" && (
        <div ref={panelRef}>
          <MachineLimitPanel user={user} onChanged={onChanged} onClose={() => setPanel(null)} />
        </div>
      )}
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
 * **same** validator `ServerSection` calls. Save is always drawn and disabled
 * until dirty, the same as every Save on the admin screens now: a button that
 * materialises on the first keystroke moves the row under the finger typing.
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
        /*
         * Eight words, and the count is the only part that is not on the row: the
         * "N machines off" badge carries the standing fact (D-U-1), and "nothing
         * was deleted" is what the badge's own remedy — raise the limit — says.
         */
        if (answer.suspended.length > 0) {
          const n = answer.suspended.length;
          toast("ok", `${n} machine${n === 1 ? "" : "s"} stopped. Raise the limit to restore ${n === 1 ? "it" : "them"}.`);
        }
        onChanged();
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="border-t border-edge/50 px-3 pb-3 pt-2">
      {/* A readout, not a sentence: the numbers are what the panel is about and
          the word after the dot is where they came from. */}
      <p className="text-xs text-muted">
        {`${owned} of ${current} · ${user.machineLimitSource === "override" ? "override" : "default"}`}
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
            {clearingCost ?? "Drops to the default; machines over it stop. Raising it brings them back."}
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
          <Button
            tone="primary"
            size="sm"
            disabled={busy || !dirty}
            onClick={() =>
              // Raising costs nobody anything and lands at once; only a change
              // that switches somebody's machine off states itself first.
              consequence === null ? write(cp.adminSetMachineLimit(user.id, next)) : setConfirming("save")
            }
          >
            {busy ? <Spinner /> : "Save"}
          </Button>
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

/*
 * `KeyRow` was here, and it is `./KeyRow` now — one row for this panel and for
 * the person's own API keys screen, which drew the same key in a second markup
 * with a second spacing and no age. The two-step-versus-one-tap decision that
 * used to be the difference between the two copies is that component's
 * `confirm` prop.
 *
 * `RowAction` was here before that, and it is in `bits.tsx` now.
 *
 * It moved when `MachinesSection` grew a kebab of its own: a second hand-written
 * copy is how one of the two loses `role="menuitem"` or picks a different danger
 * wash, with nothing anywhere saying they were meant to match. The argument for
 * why a menu act is a *tone* rather than a `DangerButton` moved with it, since
 * that is the part a reader would otherwise come here looking for.
 */
