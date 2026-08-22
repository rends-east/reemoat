import { Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import { enrollmentExpiryText, enrollmentLines } from "../../enrollment";
import { errorText } from "../../http";
import type { MachineId } from "../../ids";
import { navigate } from "../../router";
import { settingsPath } from "../../settings";
import { store, type AppState } from "../../store";
import {
  Button,
  DangerButton,
  Empty,
  FIELD,
  SETTINGS_HEADING,
  SETTINGS_SECTION,
  Spinner,
} from "../bits";
import { toast } from "../Toast";
import { MachineAgentsSection } from "./MachineAgentsSection";
import { MachinePluginsSection } from "./MachinePluginsSection";
import { OneTimeSecret } from "./OneTimeSecret";

/**
 * One machine: what it is doing, its name, its agents, and retiring it.
 *
 * **The acts moved off the row and onto the thing they act on.** A machine row
 * carried a navigate button, a kebab holding three more, an inline rename form,
 * a one-time secret panel and a two-step confirmation — five affordances on one
 * 56px line, four of them behind a 24px square. The row is a link now and this
 * is where it goes, which is also what makes `/settings/machines/<id>` an
 * address for the first time: it always parsed, and nothing could emit it.
 *
 * `machine.owned === true` gates three of the five blocks rather than a kebab.
 * Absent, never disabled: the control plane answers **404 rather than 403** to
 * prove a machine is not yours to act on, so a greyed-out Retire would claim an
 * act that does not exist for you rather than one you lack permission for.
 */
export function MachineSection({
  state,
  machineId,
}: {
  state: AppState;
  machineId: MachineId;
}): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ url: string; code: string; expiresAt: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (machine === null) {
    /*
     * A stale link, a typo — `machineId()` is a bare cast and validates nothing
     * — or a machine revoked in another tab. The list one level up is the
     * answer, and the pane's chevron goes there. (Not the ✕, which is `useUnder`
     * and leaves settings entirely.)
     */
    return <Empty>That machine is not in your list any more.</Empty>;
  }

  const owned = machine.owned === true;

  const mint = (): void => {
    setBusy(true);
    void cp
      .mintEnrollment(machine.id)
      .then((minted) =>
        setCode({ url: minted.controlPlaneUrl, code: minted.code, expiresAt: minted.expiresAt }),
      )
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  const revoke = (): void => {
    setBusy(true);
    void cp
      .revokeMachine(machine.id)
      .then((answer) => {
        /*
         * ⚠ **Leave the screen before the machine leaves the list, and in this
         * order.** `machinesChanged` drops it from `state.machines`, and this
         * component is still mounted on `/settings/machines/<id>` — so reversed,
         * the person reads "That machine is not in your list any more" about the
         * machine they just retired. Replace rather than push: shallower.
         * The toast is global and survives the navigation, which is what tells
         * them it worked.
         */
        navigate(settingsPath("machines"), true);
        const burned = answer.enrollmentCodesInvalidated ?? 0;
        const seconds = answer.outstandingTokensExpireWithinSeconds;
        toast(
          "ok",
          `${machine.name} is retired.` +
            (burned > 0 ? ` ${burned} outstanding enrollment code${burned === 1 ? "" : "s"} stopped working.` : "") +
            (seconds !== undefined ? ` Tokens already issued for it expire within ${seconds}s.` : ""),
        );
        void store.machinesChanged("machine-revoked");
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      {/* The lede, and the only thing above the first rule — `MachinesSection`'s
          intro paragraph in the same position, so `SETTINGS_SECTION` is right on
          every block below and there is no owner/grantee branch in the chrome.
          **No id here**: it is drawn once, by the Agents block's own sentence,
          which is where it is doing work. `ambiguousNames` stays a property of
          the list — a screen has no siblings to be ambiguous against. */}
      {/*
       * **No status on this screen at all** — no dot, no badge, no "online".
       *
       * This is the settings for a machine, and reachability is a fact about the
       * *fleet*: the list one level up already carries it on every row, as a dot
       * and a subline, which is where it is scanned. Repeating it in the chrome of
       * a screen you opened deliberately is the same restatement the heading was
       * carrying when it drew the machine's name. Q3.433.
       *
       * The one line that survives is not status: it explains why two sections are
       * **absent**, which is the rule that every screen must be true in the state
       * it is drawn in. Without it a grantee meets a machine screen holding only
       * Agents, with nothing saying why.
       */}
      {!owned && (
        <p className="text-xs text-muted">This machine is not yours to rename or retire.</p>
      )}

      {/*
       * **The first section on the screen, so no rule above it** —
       * `SETTINGS_SECTION`'s own rule: a line above the first thing on a page is a
       * line under the title. It used to sit below an identity paragraph that was
       * the lede; with the status gone there is nothing above it to be separated
       * from.
       *
       * When it is absent — a machine you do not own — the note above *is* the
       * lede, so Agents below keeps its rule and the shape holds either way.
       */}
      {owned && (
        <section>
          <h2 className={SETTINGS_HEADING}>Name</h2>
          <RenameMachine machine={machine} />
        </section>
      )}

      {/* Outside the ownership gate, deliberately. Rename, re-enroll and retire
          are acts on the *registry*, which answers 404 to anybody but the owner;
          configuring an agent is an act on the *daemon*, reached with the
          `session:write` grant a shared machine carries. Q3.415.

          Reused whole rather than reimplemented, which is also what keeps the
          offline case right: its `Empty` replaces this SECTION, not the screen,
          so Retire survives for exactly the machine you came to retire. */}
      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Agents</h2>
        <MachineAgentsSection state={state} machineId={machineId} agent={null} />
      </section>

      {/* The machine's second list, drawn here for the reason Agents is: what is
          installed lives on this host's disk and what it stores lives in this
          daemon's database, so there is nowhere else it could honestly go. Below
          Agents rather than above, because an agent is what the machine is *for*
          and a plugin is something added to it.

          Outside the ownership gate for Agents' reason as well: installing a
          plugin is an act on the daemon, reached with a grant, while renaming and
          retiring are acts on the registry the owner alone can perform. The
          daemon's own `machine:admin` scope is what actually decides, and it
          answers `403 insufficient_scope` to a read-only grant. */}
      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Plugins</h2>
        <MachinePluginsSection state={state} machineId={machineId} plugin={null} />
      </section>

      {/*
       * **A setup code is offered exactly once in a machine's life: before it
       * has enrolled.** Two gates refusing for unrelated reasons —
       * `!machine.enrolled` is the product decision (Q3.428: six recovery flows
       * are `cpctl enroll <machineId>` now, and Retire-then-Add is expressly not
       * the substitute — new machine id, every grant but the creator's dropped
       * silently), `!machine.overLimit` is because the route answers
       * `403 machine_over_limit` and Retire below is the remedy.
       *
       * ⚠ **Never minted on mount.** There is one live code per machine and
       * minting burns the previous one, so a screen that mints on entry destroys
       * a code on every visit and every reload. The button is offered; the code
       * is not. That is also why this block sits between Agents and Retire: the
       * `!machine.enrolled` gate implies the daemon has never dialled in, which
       * implies `reach !== "online"`, which means the Agents section above is a
       * one-line `Empty` with nothing tappable in it.
       */}
      {owned && !machine.enrolled && !machine.overLimit && (
        <section className={SETTINGS_SECTION}>
          <h2 className={SETTINGS_HEADING}>Setup code</h2>
          <p className="mt-2 text-xs text-muted">
            Single-use and shown once — only its hash is stored. Redeeming it gives this host its
            identity and rotates its tunnel key, and it replaces any code already outstanding.
          </p>
          <Button className="mt-3" disabled={busy} onClick={mint}>
            {busy ? <Spinner /> : "Setup code"}
          </Button>
          {code !== null && (
            <div className="mt-2">
              <OneTimeSecret
                label={`Start the daemon on ${machine.name} with`}
                value={enrollmentLines(code.url, code.code)}
                note={`Single-use, ${enrollmentExpiryText(code.expiresAt, Date.now())}. Shown once — only its hash is stored.`}
                onDone={() => setCode(null)}
              />
            </div>
          )}
        </section>
      )}

      {owned && (
        <section className={SETTINGS_SECTION}>
          <h2 className={SETTINGS_HEADING}>Retire this machine</h2>
          {/* The consequence as prose above the control — `AccountSection`'s
              own-keys idiom — rather than crammed into a confirmation. */}
          <p className="mt-2 text-xs text-muted">
            Frees the name and a slot against your machine limit, and stops any outstanding setup
            code working. It mints no new id and deletes no sessions, and tokens already issued for
            it keep verifying at the daemon until they expire. ⚠ Retiring and adding again is not a
            re-install: the new machine has a new id, and everybody it was shared with loses it
            silently.
          </p>
          {confirming ? (
            /* The answer that undoes the question is **last**: `.tap` removes the
               double-tap delay, and a second tap aimed at a control that looked
               like it did nothing must land on Cancel. `md`/44px at both steps —
               `BUTTON_SIZE` reserves `sm` for a confirmation that has replaced a
               row's controls, which is the opposite of a section on a screen. */
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">Retire it?</span>
              <DangerButton icon={Trash2} disabled={busy} onClick={revoke}>
                {busy ? <Spinner /> : "Retire"}
              </DangerButton>
              <Button disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <DangerButton icon={Trash2} className="mt-3" disabled={busy} onClick={() => setConfirming(true)}>
              Retire {machine.name}
            </DangerButton>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Rename a machine you own — your **label** for it, not the row's fleet-wide
 * name, which nobody chooses and nothing here can change.
 *
 * A real `<form>`, so Enter commits without an `onKeyDown` and without the IME
 * question `keys.ts` answers for the composer.
 *
 * Two things it lost when it stopped being revealed by a menu and became the
 * first thing on a screen: `autoFocus`, because a field focused on mount raises
 * the soft keyboard on a 92dvh sheet — the exact reason `Sheet` focuses its
 * panel rather than a control — and `Cancel`, because there is nothing to cancel
 * back to. Save is disabled while the value is unchanged instead, which is
 * "every control true in the state it is drawn in" said properly.
 */
function RenameMachine({ machine }: { machine: AppState["machines"][number] }): ReactNode {
  const [value, setValue] = useState(machine.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = value.trim();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || next.length === 0 || next === machine.name) return;
    setBusy(true);
    setError(null);
    void cp
      .renameMachine(machine.id, next)
      // The list is the one source of fleet state; this redraws from the registry
      // rather than from what was just typed into it. `resume`, not
      // `machinesChanged`: a rename moves no count.
      .then(() => void store.resume("machine-renamed"))
      // `409 machine_exists` is the one worth reading — two rows with one word in
      // a list is also what `POST /v1/tokens` resolves against, which is why the
      // server refuses more widely than the unique index does.
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit} className="mt-3">
      <div className="flex max-w-sm gap-2">
        <input
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={`Rename ${machine.name}`}
          className={`min-w-0 flex-1 ${FIELD}`}
        />
        <Button type="submit" tone="primary" disabled={busy || next.length === 0 || next === machine.name}>
          {busy ? <Spinner /> : "Save"}
        </Button>
      </div>
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
    </form>
  );
}
