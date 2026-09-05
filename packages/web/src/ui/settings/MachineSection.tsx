import { ChevronRight, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import { enrollmentExpiryText, enrollmentLines } from "../../enrollment";
import { errorText } from "../../http";
import type { MachineId } from "../../ids";
import { daemonRead } from "../../machine";
import { MACHINE_GONE } from "../../plugins";
import { navigate } from "../../router";
import { agentStripPath, settingsPath } from "../../settings";
import { store, type AppState } from "../../store";
import {
  Button,
  ChoiceRow,
  DangerButton,
  Empty,
  FIELD,
  Icon,
  NotReachable,
  SETTINGS_HEADING,
  SETTINGS_SECTION,
  Spinner,
  TwoStep,
} from "../bits";
import { toast } from "../Toast";
import { MachineSystemsSection } from "./MachineSystemsSection";
import { MachinePluginsSection } from "./MachinePluginsSection";
import { OneTimeSecret } from "./OneTimeSecret";

/**
 * `SETTINGS_HEADING` in the one colour this palette has left.
 *
 * ⚠ **Written out rather than `` `${SETTINGS_HEADING} text-danger` ``.** Tailwind
 * v4 emits utilities in alphabetical order, so `.text-danger` is written to the
 * stylesheet *before* `.text-muted` — appending it to a string that already
 * carries `text-muted` therefore loses, with the class sitting in the DOM
 * attribute looking as though it should have won. `FIELD`'s docblock states the
 * general rule; this is the second call site to need it and the first to need it
 * for a colour.
 *
 * ⚠ **And it is a non-control use of `danger`, which `index.css` allows and asks
 * to be argued for.** The category it names is *a failure a second look does not
 * repair*, and retiring a machine is the clearest case of it on this surface: a
 * new id, every grant but the creator's dropped silently, and nothing anywhere
 * that brings the old one back. The absolute half of that token's rule — never a
 * fill, never more than one control in a view — is untouched: the section still
 * holds exactly one destructive control.
 */
const RETIRE_HEADING = "text-2xs font-semibold tracking-wider text-danger uppercase";

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
 *
 * ⚠ **Every fact that is about the *machine* is stated here once, and the two
 * sections below used to state two of them each.** `MachineSystemsSection` and
 * `MachinePluginsSection` both drew a paragraph ending word-for-word *"Nothing
 * here is shared with your other machines."* and both drew `` `${machine.name} is
 * not reachable right now — …` `` — the same two sentences about the same host,
 * two hundred pixels apart, each written in isolation with a comment defending
 * itself against being silently empty and neither knowing about the other. The
 * shared clause is the lede below; the reachability answer is one line that
 * replaces Systems, Agents and Plugins **together**, since there is no state in
 * which one of the three can be read and the others cannot.
 */
export function MachineSection({
  state,
  machineId,
}: {
  state: AppState;
  machineId: MachineId;
}): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;
  /*
   * Minting holds its own flag, and the retire's wait is `TwoStep`'s. A single
   * `busy` once disabled Retire's Cancel while a setup code minted — two acts on
   * two sections, sharing a lock because they shared a file — and with the
   * confirmation owning its own busy the two cannot share one again.
   */
  const [minting, setMinting] = useState(false);
  const [code, setCode] = useState<{ url: string; code: string; expiresAt: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (machine === null) {
    /*
     * A stale link, a typo — `machineId()` is a bare cast and validates nothing
     * — or a machine revoked in another tab. The list one level up is the
     * answer, and the pane's chevron goes there. (Not the ✕, which is `useUnder`
     * and leaves settings entirely.) No `action` and no `failed`: this screen's
     * chevron really does walk out of it, which is the half the two leaves below
     * could not claim, and a machine that is not in your list is a settled
     * answer rather than a read that failed.
     */
    return <Empty>{MACHINE_GONE}</Empty>;
  }

  const owned = machine.owned === true;
  /*
   * ⚠ **Three answers rather than two, and the missing one was the ordinary
   * path.** `daemonReadable` answers `false` for `unknown`, which is a machine
   * nobody has *asked* yet — `bootstrap` promotes to `ready` on the machine list
   * and `resumeMachine` forgets the route on every wake — so a cold load or a
   * deep link asserted an outage for the two or three seconds before the first
   * probe landed. `daemonRead` is the partition; `probing` is deliberately
   * readable, for the reason its docblock gives at length.
   */
  const read = daemonRead(machine.reach);
  /*
   * ⚠ **Enrollment is asked *before* reachability, because it is a settled fact
   * rather than a measurement.** A machine that has never enrolled is `unknown`
   * until `probeRoute` runs and only then `offline`/`not_enrolled` — so branching
   * on `read` alone would open this screen with "Checking whether laptop is
   * reachable…" about a host the registry can already prove has never dialled in.
   */
  const setupOffered = owned && !machine.enrolled && !machine.overLimit;
  const listable = machine.enrolled && read === "readable";

  const mint = (): void => {
    setMinting(true);
    void cp
      .mintEnrollment(machine.id)
      .then((minted) =>
        setCode({ url: minted.controlPlaneUrl, code: minted.code, expiresAt: minted.expiresAt }),
      )
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setMinting(false));
  };

  // Handed to `TwoStep`: it owns the wait, and a failure leaves the question
  // standing beside the toast.
  const revoke = (): Promise<void> =>
    cp
      .revokeMachine(machine.id)
      .then(() => {
        /*
         * ⚠ **Leave the screen before the machine leaves the list, and in this
         * order.** `machinesChanged` drops it from `state.machines`, and this
         * component is still mounted on `/settings/machines/<id>` — so reversed,
         * the person reads "That machine is not in your list any more" about the
         * machine they just retired. Replace rather than push: shallower.
         * The toast is global and survives the navigation, which is what tells
         * them it worked.
         *
         * **And the list is told at once, in the same flush as the navigation.**
         * `forgetMachine` drops the row synchronously (the 200 has landed, so
         * that is a fact and not a guess), where the re-list alone left the
         * retired row on the list for a round trip (review D9). It is handed to
         * `navigate` rather than called after it — ⚠ **and not for the sentence
         * above, which the fix round claimed of the next-statement order and
         * which cannot happen there**: `App` reads the route through
         * `useSyncExternalStore` beside its store subscription, and `announce`
         * writes the route before it opens a transition, so the render a store
         * emit forces after `navigate` returns already carries the list. This
         * screen was unmounted in the very render that dropped its machine, on
         * both paths. What the shared flush buys is the ordering by
         * construction, the drop landing where the route lands, and nothing a
         * person sees today: the re-list below patches `resuming` in this same
         * task, so on a phone `App` re-draws on the new route before the old
         * frame is captured either way (`announce`'s docblock holds the
         * reading). Kept because it is where the drop belongs, and pinned
         * whole. `machinesChanged` still follows, for the count the limit is
         * enforced against.
         *
         * Three words. It used to add how many enrollment codes were burned and
         * when issued tokens expire — facts read from `answer` — and a toast is
         * the one place a fact cannot be re-read (decision D-U-1): the machine is
         * gone from every screen that could carry them, so they went too. The
         * confirmation above already said what retiring costs, before the tap.
         */
        navigate(settingsPath("machines"), true, () => store.forgetMachine(machine.id));
        toast("ok", `${machine.name} is retired.`);
        void store.machinesChanged("machine-revoked");
      });

  return (
    <div>
      {/*
       * **No status on this screen at all** — no dot, no badge, no "online".
       *
       * This is the settings for a machine, and reachability is a fact about the
       * *fleet*: the list one level up already carries it on every row, as a dot
       * and a subline, which is where it is scanned. Repeating it in the chrome of
       * a screen you opened deliberately is the same restatement the heading was
       * carrying when it drew the machine's name. Q3.433.
       *
       * The two lines that survive are not status: each explains why something is
       * **absent**, which is the rule that every screen must be true in the state
       * it is drawn in. Without the first, a grantee meets a machine screen with
       * no Name and no Retire and nothing saying why; without the second — the one
       * standing in for Systems, Agents and Plugins further down — they meet a
       * screen with the machine's whole contents missing.
       */}
      {!owned && (
        <p className="text-xs text-muted">This machine is not yours to rename or retire.</p>
      )}

      {/*
       * **The lede, and the one place the per-machine facts are stated.**
       *
       * ⚠ **The id is here rather than inside the Systems block's own sentence,
       * and the shared clause is here rather than inside *both* siblings'.** It
       * moved up because it is a fact about the machine rather than about either
       * list: what is on this screen belongs to one daemon's database and one
       * host's home, and a plugin among them runs on that host as you. Said once
       * at the top, `MachineSystemsSection` and `MachinePluginsSection` draw no
       * prose at all here — the first has no lede at any depth any more, the second has none
       * left to suppress. `ambiguousNames` stays a property of the list: a screen
       * has no siblings to be ambiguous against, which is why this names the id
       * and not the machine. Nine words: what it keeps is the id, that nothing
       * here is shared with the other machines ("only"), and that a plugin runs
       * there as you — "one daemon's database and one host's home" is this
       * comment's fact rather than the sentence's.
       */}
      <p className="text-xs text-muted">
        Belongs to <code className="text-muted/80">{machine.id}</code> only. Plugins run there as you.
      </p>

      {/*
       * ⚠ **A rule above it again, where this deliberately had none.** It was the
       * first thing on the screen for a release, so `SETTINGS_SECTION`'s own rule
       * applied — a line above the first thing on a page is a line under the title
       * — and there was nothing above it to be separated *from*. The lede is back
       * above it, so the rule is back with it.
       *
       * When it is absent — a machine you do not own — the lede is still there, so
       * whatever follows keeps its rule and the shape holds either way.
       */}
      {owned && (
        <section className={SETTINGS_SECTION}>
          <h2 className={SETTINGS_HEADING}>Name</h2>
          <RenameMachine machine={machine} />
        </section>
      )}

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
       * is not. No sentence over the button: the one fact that bears on pressing
       * it — that it replaces any code already outstanding — is said on the
       * minted panel's note beside single-use and shown-once, where it is read
       * once, after the tap, rather than above a button most visits never press.
       * What redeeming does (identity, tunnel-key rotation) is this comment's.
       *
       * ⚠ **It sits directly under Name, and it used to sit between Systems and
       * Retire on an argument that pointed the other way.** That argument was
       * written out here: the `!machine.enrolled` gate implies the daemon has
       * never dialled in, so the sections above are empty. All three of them are —
       * Systems and Plugins draw nothing and Agents links to a screen that says
       * the same thing — which makes them the wrong things to put *in front of*
       * the one act that unblocks the machine. On a phone that was the whole first
       * screenful spent on three dead rows before the button anybody came for.
       * They collapse to a single line below now, and this is above it.
       */}
      {setupOffered && (
        <section className={SETTINGS_SECTION}>
          <h2 className={SETTINGS_HEADING}>Setup code</h2>
          <Button className="mt-3" disabled={minting} onClick={mint}>
            {minting ? <Spinner /> : "Generate"}
          </Button>
          {code !== null && (
            <div className="mt-2">
              <OneTimeSecret
                label={`Start the daemon on ${machine.name} with`}
                value={enrollmentLines(code.url, code.code)}
                note={`Single-use, ${enrollmentExpiryText(code.expiresAt, Date.now())}. Shown once. Replaces any earlier code.`}
                onDone={() => setCode(null)}
              />
            </div>
          )}
        </section>
      )}

      {listable ? (
        <>
          {/* Outside the ownership gate, deliberately. Rename, re-enroll and retire
              are acts on the *registry*, which answers 404 to anybody but the owner;
              configuring an agent is an act on the *daemon*, reached with the
              `session:write` grant a shared machine carries. Q3.415.

              Reused whole rather than reimplemented, and it draws no lede of its
              own: the paragraph it used to open with is the one at the top of this
              screen. Its own three-way reachability branch survives because it is
              also a whole screen one level down, where there is nothing above it to
              have said anything. */}
          <section className={SETTINGS_SECTION}>
            {/*
             * ⚠ **"Sign-ins", and the word is the point rather than a tidy.** These
             * rows were providers — who serves a model, and whose key you paste —
             * and the list now also holds a harness that reads a key of its own,
             * because signing in on this machine is not only about inference. What
             * a reader is looking at either way is a thing they have or have not
             * given a credential to; naming the list after the half that came first
             * left the other half homeless, which is exactly how a key box could be
             * declared in a manifest and drawn on no screen at all.
             */}
            <h2 className={SETTINGS_HEADING}>Sign-ins</h2>
            <MachineSystemsSection
              state={state}
              machineId={machineId}
              system={null}
              signin={null}
            />
          </section>

          {/*
           * ⚠ **A link, where Systems and Plugins above and below it draw their lists
           * in place** — and the difference is what the screen behind each is *for*.
           * Those two are lists you read: which system is signed in, which plugin is
           * running. This one is a list you **rearrange**, with a drag on every row, and
           * a drag inside a section of a screen that itself scrolls is a gesture with
           * two possible owners. It gets the whole width and its own scroll.
           *
           * ⚠ **The second door, and the one somebody arrives at without meaning to
           * start a session.** The first is the gear at the end of the New session
           * strip, which is a shortcut from the place the order is felt. Both are the
           * same route, so this is not the two-doors-into-one-flow that collapsed the
           * sign-in wizard inline — that was one door navigating and one drawing, which
           * is how one of them rots.
           */}
          <section className={SETTINGS_SECTION}>
            {/* **No `h2` over this row.** "Agents" was drawn twice 40px apart — as
                the section heading and as the row's own title — and a heading
                that restates the one row under it is the row said louder. The
                `ChoiceRow` carries the word; the pane it opens is titled "Agents"
                by `settingsPaneTitle`, so the reader meets it there too. Three
                words of subline: the verbs, without the machine, since the lede
                at the top has already said which daemon this screen belongs to. */}
            <ChoiceRow
              title="Agents"
              subline="Reorder, hide, add."
              trailing={<Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />}
              onClick={() => navigate(agentStripPath(machineId))}
            />
          </section>

          {/* The machine's second list, drawn here for the reason Systems is: what is
              installed lives on this host's disk and what it stores lives in this
              daemon's database, so there is nowhere else it could honestly go. Below
              Systems rather than above, because a system is what the machine is
              signed in to and a plugin is something added to it.

              Outside the ownership gate for Systems' reason as well: installing a
              plugin is an act on the daemon, reached with a grant, while renaming and
              retiring are acts on the registry the owner alone can perform. The
              daemon's own `machine:admin` scope is what actually decides, and it
              answers `403 insufficient_scope` to a read-only grant. */}
          <section className={SETTINGS_SECTION}>
            <h2 className={SETTINGS_HEADING}>Plugins</h2>
            <MachinePluginsSection state={state} machineId={machineId} />
          </section>
        </>
      ) : (
        /*
         * ⚠ **One line where three sections were, and it is a heading short on
         * purpose.** Systems, Agents and Plugins are all reads of the same daemon,
         * so there is no state in which one is answerable and the others are not —
         * three headings over three copies of one sentence is the shape this
         * replaces, and three headings over three blanks would be worse. What is
         * left is the sentence itself, in the place the reader is looking for the
         * lists.
         *
         * The two acts that are **not** the daemon's keep their sections above and
         * below it: Name and Retire are the registry's, and the setup code is the
         * remedy for the commonest reason this branch is drawn at all. That was the
         * property the old per-section `Empty` had — "its `Empty` replaces this
         * SECTION, not the screen, so Retire survives for exactly the machine you
         * came to retire" — and it survives the collapse for the same reason.
         */
        <section className={SETTINGS_SECTION}>
          {!machine.enrolled ? (
            /*
             * Not `failed`, and asked first: this is the registry's own settled
             * answer rather than a probe that did not come back, so it takes
             * neither the triangle nor the live region. Eight words with the
             * remedy, the empty-state cap (review D10): the name went, since the
             * pane's head is the name, and "Use" says what "Start its daemon
             * with" said.
             */
            <Empty>
              Not enrolled yet.
              {setupOffered ? " Use the setup code above." : ""}
            </Empty>
          ) : read === "asking" ? (
            /*
             * ⚠ **A wait, drawn as one.** Nothing has been measured — this is the
             * value before the first probe answers — so there is no failure to
             * claim, no `role="status"` to announce and no remedy to offer. The
             * spinner is `SystemChooser`'s "Asking that machine…" shape, one level
             * down, so the two reads of the same daemon look like the same wait.
             */
            <Empty>
              <span className="inline-flex items-center gap-2">
                <Spinner /> Checking whether {machine.name} is reachable…
              </span>
            </Empty>
          ) : (
            /*
             * Asked, and no answer came back — the one arm that has earned the
             * words "not reachable", and the one that is genuinely the absence of
             * an answer, so it takes `failed`. It sits where the three lists would
             * be, which is what says they are not listed; the clause that used to
             * name them was the position said again.
             */
            <Empty failed>
              <NotReachable machine={machine} />
            </Empty>
          )}
        </section>
      )}

      {owned && (
        /*
         * ⚠ **The one section here that is not another field, drawn so that it is
         * not another field.** Five headings at one weight in this file — Name,
         * Setup code, Sign-ins, Plugins, Retire, with Install an `<h3>` inside the
         * plugin list and no heading at all over the Agents row — gave the screen
         * a rhythm rather than a shape, and the block that destroys a machine carried exactly the
         * typographic weight of the rename box. Two signals, written out rather
         * than appended: a wider break above it than the rule this screen repeats,
         * and {@link RETIRE_HEADING}. Neither is a fill and neither adds a second
         * destructive control.
         */
        <section className="mt-12 border-t border-edge pt-5">
          <h2 className={RETIRE_HEADING}>Retire this machine</h2>
          {/* **Nothing at rest but the button** (decision 10A). The consequence
              used to be a 45-word paragraph above it, the own-keys idiom — but
              that idiom is for a *one-tap* control, where the prose is the only
              warning there is. This control is two-step, so its cost is the
              confirmation's text, read at the moment of deciding: the name and
              the slot come back, re-adding is a new id, shares are lost. Sessions
              and issued tokens surviving, and the setup code dying, are true and
              are this comment's rather than the screen's. */}
          {/* `TwoStep` draws the pair: the answer that undoes the question is
              **last**, so a second tap aimed at a control that looked like it
              did nothing lands on Cancel. `md`/44px at both steps — this is a
              section on a screen, not a confirmation that has replaced a row's
              controls, and a mis-aimed trackpad click retires exactly as
              irreversibly as a mis-aimed thumb. */}
          {/* ⚠ **The name is in the question, not only in the resting label.**
              It read "Retire laptop" and then, at the moment of deciding,
              "Retire it?" — dropping the subject on the one screen where this
              app explicitly supports two machines called the same thing, and
              reversing what `SignOutButton` does with the identical pair of
              taps. A confirmation that does not name what it is about is a
              confirmation of nothing. */}
          <TwoStep
            armed={confirming}
            onArm={setConfirming}
            className="mt-3"
            size="md"
            question={<>Retire {machine.name}?</>}
            consequence="Frees the name and a slot. Re-adding gives a new id; shares are lost."
            act={{ label: "Retire", danger: true, icon: Trash2 }}
            onAct={revoke}
            rest={
              <DangerButton icon={Trash2} onClick={() => setConfirming(true)}>
                Retire {machine.name}
              </DangerButton>
            }
          />
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
      //
      // ⚠ **Awaited, and `.finally` used to fire before it.** `store.resume` is a
      // promise and this line dropped it, so `busy` cleared with `machine.name`
      // still the old value — which left Save live over a field whose contents no
      // longer differed from anything, for as long as the round trip took. The
      // chain holds the button down until the registry has answered, which is the
      // only moment `next === machine.name` becomes true.
      //
      // `runResume` swallows every failure it can have — the registry read is
      // best-effort and the per-machine work is `allSettled` — so nothing it does
      // can turn a rename that landed into an error below. What it can do is
      // *coalesce*: a wake in the same instant returns that call's promise
      // instead, and the queued re-run lands a poll later. The button unsticks
      // either way.
      .then(() => store.resume("machine-renamed"))
      // ⚠ **Every other write on this surface toasts, and this one reported
      // nothing at all.** The field kept the typed value and the button went
      // quiet, which is indistinguishable from a form that did not submit. Both
      // names, because the whole reason a machine is renamed is that its old name
      // was not telling two hosts apart.
      .then(() => toast("ok", `${machine.name} is now ${next}.`))
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
