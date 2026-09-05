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

/**
 * Your own account: who you are, the password, the address, the devices, and
 * the way out.
 *
 * **Rows, not forms.** This screen opened on an always-expanded three-field
 * password form, with the address form, the key list and the device list one
 * scroll below it — so the first thing on "Account" was a form almost nobody
 * came to fill in. Every fact is a row now (its value, one subline, one verb),
 * and the form it stands for is its own screen — `/settings/account/password`,
 * `/settings/account/email`, each a `SettingsLeaf` the verb navigates to, with
 * Done and Cancel walking back to this row by `replace` (Q3.549). Not a form
 * opening in place: that is the screen jumping under a thumb. What you came for
 * is scannable; what you came to do is one tap away.
 *
 * **API keys left.** They are a section of their own (`KeysSection`), because a
 * key is minted for `cpctl` on another machine and this screen is about you.
 * **Devices stayed** (decision 1B): its verbs are Sign out's verbs, and a
 * section that is one sentence for an API-key credential fails the subtraction
 * test.
 *
 * **It takes the instance as well as the person**, because the Email row is
 * about something only the instance can do — see `mailUsable`.
 */
export function AccountSection({
  me,
  config,
}: {
  me: Me | null;
  /**
   * What this instance allows, or `null` while it is unknown.
   *
   * A prop rather than a read of the store, `SignIn`'s reason: the caller holds
   * whatever there is and this file decides what to do with it, so both states
   * are reachable from a driver.
   */
  config: InstanceConfig | null;
}): ReactNode {
  return (
    <div>
      {me === null ? (
        // Reachable: `bootstrap` keeps `phase: "ready"` with `me: null` when the
        // control plane is unreachable but machines are already known. One
        // `GET /v1/me` is the retry, which is exactly what `refreshMe` is.
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
          {/* The name and nothing before it: "Signed in as" was three words
              restating the screen's own title. */}
          <p className="flex items-center gap-2 text-sm">
            <span className="min-w-0 truncate font-medium">{me.name}</span>
            {me.isAdmin && (
              <span className="shrink-0">
                <Badge tone="strong">admin</Badge>
              </span>
            )}
          </p>

          <PasswordRow me={me} />
          {/*
            Directly under the password row, because it is that row's
            completion rather than a separate concern: an address is the **only**
            way an account that predates this feature ever becomes able to reset
            its own password.
          */}
          <EmailRow me={me} config={config} />
          <Devices />
        </>
      )}

      {/*
       * **Outside the `me === null` branch, and that is the fix rather than a
       * layout preference.**
       *
       * This whole screen used to early-return the notice above, with Sign out
       * inside the returned tree — so the one moment somebody most needs to leave
       * (a control plane that is down, or a credential this tab is no longer sure
       * about) was the one moment the button was not drawn, and the app had no
       * other way out. The flat `Settings.tsx` this section was split out of
       * rendered it unconditionally; that property was lost in the split rather
       * than decided against.
       *
       * It works in that state, which is what makes hiding it purely a loss:
       * `cp.logout` puts the local half in a `finally` precisely so a control
       * plane that is down cannot trap somebody in an app they are trying to
       * leave.
       *
       * "On the server too" rather than "everywhere": other devices keep their
       * sign-ins, and the Devices list above is where those are ended.
       */}
      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Sign out</h2>
        <p className="mt-1 text-xs text-muted">Ends this sign-in on the server too.</p>
        <DangerButton icon={LogOut} className="mt-3" onClick={() => void store.signOut()}>
          Sign out
        </DangerButton>
      </section>
    </div>
  );
}

/**
 * A field's name, at 12px.
 *
 * Deliberately **not** `SETTINGS_HEADING`, which is `text-2xs`: that size is
 * for section headings, which sit over whitespace; a field label sits over a
 * box somebody is about to type into and 10px there is the smallest type on the
 * screen naming the one thing they must get right.
 */
const fieldLabel = "mt-3 block text-xs font-semibold tracking-wider text-muted uppercase";

/**
 * **`block` is load-bearing, not decoration.** An `<input>` is `inline-block`
 * by default, so `w-full max-w-sm` caps it at 384px and leaves the rest of the
 * line free — and the submit button, which is `inline-flex`, floated up into
 * that gap and sat beside the last field as though it belonged to it. Making
 * every field its own block ends that class of bug rather than the one instance.
 *
 * The chrome comes from `FIELD`. These were `py-2` against `SignIn`'s `py-3` —
 * the same control one screen earlier, ~39px against ~47px once `index.css`
 * forces 16px on a coarse pointer, i.e. below the 44px minimum on this side of
 * the drift and above it on the other.
 */
const field = `mt-1.5 block w-full max-w-sm ${FIELD}`;

/**
 * One fact and the verb that changes it, the shape every row on this screen
 * takes: a value, a subline of at most eight words, and a `size="sm"` button
 * at the trailing edge. `min-h-11` so the row is a target on a phone even
 * where the button inside it is 36px on a mouse.
 */
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

/* ------------------------------------------------------------------ *
 * Password
 * ------------------------------------------------------------------ */

/**
 * The password as a row: when it was last changed, what changing it costs, and
 * the verb — which goes to `/settings/account/password` (`PasswordScreen`),
 * whose Done and Cancel walk back to this row (Q3.549).
 *
 * Three values, decided from two fields on `Me`. `passwordChangedAt` is written
 * only by a change the person made themselves (`POST /v1/me/password` and the
 * mailed reset), so "Changed 3mo ago" is a fact about *their* act; `null` with
 * `hasPassword` is a password somebody else issued — the bootstrap admin, a
 * temporary one — or a row from before the column, and "Set" is all that can be
 * said of it. `hasPassword === false` is the account that predates passwords,
 * proved by its API key.
 */
function PasswordRow({ me }: { me: Me }): ReactNode {
  const firstTime = me.hasPassword === false;

  const value = firstTime
    ? "Not set"
    : typeof me.passwordChangedAt === "number"
      ? `Changed ${ageText(Date.now() - me.passwordChangedAt)} ago`
      : "Set";

  return (
    <section className={SETTINGS_SECTION}>
      {/* `h2` under `Settings.tsx`'s `h1`. It was `h3`, which skipped a level —
          and there was no `h2` anywhere on the screen for it to be under. */}
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

  /*
   * A user carried over from before passwords existed has none, and sets a first
   * one with no current password to prove — their API key is the proof, and it was
   * already full authority over the account. `hasPassword` is how the client knows
   * which of the two forms this is; without it, "set a password" is
   * indistinguishable from "you have forgotten yours".
   */
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
        // The other devices signed out are rows the Devices list below no longer
        // draws; the toast does not repeat a number the screen shows.
        toast("ok", "Password changed.");
        /*
         * `refreshMe()`, not `resume()` — one `GET /v1/me`, which is the request
         * this line always meant to make.
         *
         * `resume()` re-lists *machines*; `cp.me()` is called from `bootstrap`
         * alone. So `hasPassword` never moved: after setting a first password
         * this form stayed in its first-time shape with no current-password box,
         * and the next submit answered `400 currentPassword is required` about a
         * field that was not on screen. It is also what moves `passwordChangedAt`
         * on the row this form gives back.
         */
        void store.refreshMe();
        onDone();
      })
      .catch((cause: unknown) => setError(changePasswordError(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit}>
      {/* A password manager updating a saved entry has to know *which* entry.
          Without a username field on the form, Chrome and Safari either save a
          second, nameless credential for this origin or offer to save nothing. */}
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
      {/* The rule, as the hint of the field it is about, rather than a sentence
          over the whole form. */}
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

/* ------------------------------------------------------------------ *
 * Your address
 * ------------------------------------------------------------------ */

/**
 * The address this account can be reset from, as a row.
 *
 * Three shapes, and the middle one is the state most worth naming: an address
 * that has been *claimed* and not proved reserves nothing and cannot receive a
 * reset, so saying "unconfirmed" out loud is the difference between somebody
 * believing they have a way back and having one.
 *
 * **A confirmed address wears no badge.** `Badge`'s `strong` tone means "this
 * one is not like the others", so the ordinary case is the absence of one.
 * **The badge sits outside the truncating span, `shrink-0`.** A 47-character
 * address at 390px truncates; the badge is the fact that makes the row worth
 * reading and never does.
 *
 * **A fourth shape, and it has no controls at all.** On an instance with no SMTP
 * every one of the three above is a promise nothing can keep: `PUT /v1/me/email`
 * answers `409 mail_unconfigured` before it reads the body, so "Add an address"
 * led straight to a refusal and the sentence under it — *"reset your own
 * password"* — described the exact capability the instance does not have, to
 * the people who most need to know they have no way back. `mailUsable` decides,
 * fails **open** on an unknown config, and its docblock carries the argument for
 * both halves. `webcheck` pins that the promise is made only downstream of it.
 */
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
    /*
     * **Said, not hidden.** A block that quietly disappears is a block somebody
     * hunts for, and what they would fail to learn is the thing that matters
     * most about this account: there is no self-service way back into it. So
     * the heading stays, an address the account already holds stays — it is a
     * fact, and it predates SMTP being switched off — and the only thing removed
     * is every control, because each one could now only be refused.
     *
     * The remedy is named on the side the reader is on: an admin gets the link
     * to the screen that fixes it, everybody else has somebody to ask and is
     * told nothing they cannot do. "cannot send mail" is verbatim, which
     * `webcheck` pins.
     */
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
          {/* Why anybody would: the one consequence of not having one. */}
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
      {/* No password: the session is the proof (Q1.630, the owner's decision);
          the control plane's docblock on `PUT /v1/me/email` records the cost. */}
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

/* ------------------------------------------------------------------ *
 * Devices
 * ------------------------------------------------------------------ */

/**
 * Where you are signed in, one row each, and how to end any of them.
 *
 * **The list is back, and what it needed was something to say.** It printed
 * `s_69ad31c3` and a date — an id of *ours*, naming a row in our database and
 * corresponding to nothing a person could recognise — so the only question it
 * exists to answer, *which of these is not me?*, was unanswerable and the per-row
 * sign-out was a coin flip between identical things. A count replaced it for
 * exactly as long as it took to give the rows a device and an address.
 *
 * That took a table rather than two columns, because this package has no
 * `migrate()`; the consequence reaches all the way here, as a row that predates
 * the table and can still only say when it was used. It is listed anyway, and it
 * is the one you are most likely to want to end. Such a row simply has no
 * device line — the two sentences that used to explain the gap are gone, since
 * the row's own shape says it.
 *
 * **Recognition, not evidence.** Both fields are caller-supplied — see
 * `device.ts` — so this list is a way to end sessions rather than a way to judge
 * them, and the remedy it offers is the same whatever a row says. That used to
 * be a sentence over the list; it is this docblock now, because the person
 * reading the list has one question and the sentence did not answer it.
 *
 * **Inside Account rather than a section of its own** (decision 1B): every verb
 * here is a sign-out, and for an API-key credential the whole section is one
 * sentence — a rail row for that fails the subtraction test.
 */
function Devices(): ReactNode {
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
      // The number the server actually revoked, not the number this button
      // was labelled with — the list is a poll old, and `revokedCount` is
      // the answer to what just happened.
      toast("ok", count === 1 ? "1 device signed out." : `${count} devices signed out.`);
      refresh();
    });

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Devices</h2>
      {/*
       * One placeholder row while the first listing is in flight, so the heading
       * never stands over nothing and the rows arriving do not shove Sign out
       * down the page. One rather than three: this list is commonly one row
       * long, and a three-row skeleton collapsing to one implied two devices
       * that never existed.
       */}
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
        // An API key has no session row. Said rather than shown as an empty list,
        // which would read as "you are signed in nowhere" while you plainly are.
        <p className="mt-1.5 text-xs text-muted">Signed in with an API key — nothing to end.</p>
      )}
      {!failed && rows !== null && rows.length > 0 && (
        <>
          <div className="mt-2">
            {rows.map((row) => (
              <DeviceRow key={row.id} row={row} onChanged={refresh} />
            ))}
          </div>

          {/*
           * Ending every other sign-in is one act over N rows, so it confirms in
           * place — the question names the count, and Cancel is last (Q3.218,
           * `TwoStep`'s). The per-row Sign out stays one tap: it names one device
           * the person has just read.
           */}
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

function DeviceRow({ row, onChanged }: { row: SessionRecord; onChanged: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const ip = row.ip !== null && row.ip !== undefined && row.ip !== "unknown" ? row.ip : null;

  return (
    <div className="flex min-h-11 items-center gap-3 border-b border-edge/60 py-2 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          {/* The raw agent on hover, and only where the row could not read it —
              elsewhere it would be 130 characters of tooltip repeating two words
              already on screen. It is the escape hatch for "unrecognised by
              what?" without putting that string in the layout. */}
          <span
            className="min-w-0 truncate text-sm font-medium"
            title={agentWasRecorded(row.userAgent) && describeAgent(row.userAgent) === null ? (row.userAgent ?? undefined) : undefined}
          >
            {deviceLine(row.userAgent)}
          </span>
          {/* Which row you are on is the one thing here that is certain, so it is
              the badge and not the title — the title is what the agent said. And
              it is `shrink-0` beside a truncating title: the badge is the fact
              that makes the row recognisable and never gives way. */}
          {row.current && (
            <span className="shrink-0">
              <Badge tone="strong">this device</Badge>
            </span>
          )}
        </span>
        {/* **Wrapping, not truncating.** The age is what makes a stale row
            recognisable, and it is the last thing on the line — a `truncate`
            here cut exactly the fact the row exists to show. The address first,
            because it is the half somebody scans for. */}
        <span className="mt-0.5 block text-2xs text-muted">
          {ip !== null && <span className="font-mono">{ip}</span>}
          {ip !== null && " · "}
          {row.current ? "in use" : `last used ${shortDuration(Math.max(0, now - row.lastSeenAt))} ago`}
        </span>
      </span>

      {/*
       * Absent on your own row, and that is the same rule the Users table
       * applies to disabling yourself: the act exists, it is the Sign out button
       * at the bottom of this screen, and offering it twice — once as the
       * dangerous-looking one beside four other devices — is how somebody ends
       * the session they are reading this in by aiming at a neighbour.
       */}
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

/* ------------------------------------------------------------------ *
 * The two form screens, each its own address
 * ------------------------------------------------------------------ */

/**
 * `/settings/account/password`. The row's verb comes here; Done and Cancel walk
 * back to Account with `replace`, so Android's Back pops out of the form rather
 * than through it. The forms above are unchanged — only where they are drawn
 * moved, because a form opening inside a row is the screen jumping under a
 * thumb (`SettingsLeaf`).
 */
export function PasswordScreen({ me }: { me: Me | null }): ReactNode {
  if (me === null) return <Empty failed>{CONTROL_PLANE_UNREACHABLE}</Empty>;
  return <PasswordForm me={me} onDone={() => navigate(settingsPath("account"), true)} />;
}

/** `/settings/account/email`. Same shape; the mail-off arm is the row's own line. */
export function EmailScreen({ me, config }: { me: Me | null; config: InstanceConfig | null }): ReactNode {
  if (me === null) return <Empty failed>{CONTROL_PLANE_UNREACHABLE}</Empty>;
  if (!mailUsable(config)) return <p className="text-xs text-muted">This server cannot send mail.</p>;
  return <EmailForm onDone={() => navigate(settingsPath("account"), true)} />;
}
