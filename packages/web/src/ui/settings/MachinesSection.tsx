import { ChevronRight } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../../cp";
import { enrollmentExpiryText, enrollmentLines } from "../../enrollment";
import { errorText } from "../../http";
import {
  machineAllowanceText,
  machineBadgeText,
  machineQuotaNotice,
  mayAddMachine,
} from "../../quota";
import { navigate } from "../../router";
import { settingsPath } from "../../settings";
import { store, type AppState } from "../../store";
import { ambiguousNames, lastSeenText } from "../../wire";
import {
  Badge,
  Button,
  Dot,
  Empty,
  FIELD,
  Icon,
  SETTINGS_HEADING,
  SETTINGS_SECTION,
  Spinner,
  reachText,
} from "../bits";
import { OneTimeSecret } from "./OneTimeSecret";

/**
 * Your machines, and adding one.
 *
 * **This screen is what took the admin off the critical path.** Registering a
 * machine, granting it to somebody, and minting its enrollment code used to be
 * three separate administrative acts, none implying the others — and both install
 * wizards printed the missing third as a hint and ran neither, so a daemon could
 * enroll, dial the relay, hold a tunnel, and appear in nobody's list. It is one
 * request now, and the person who needs the machine is the one making it.
 *
 * **This screen offers a setup code once, before the machine has enrolled.** The
 * route deliberately allows a re-mint — that is how a host is re-installed, and
 * redeeming such a code rotates the machine's tunnel credential — but the row
 * stopped offering it, because on a host that is already running it read as a
 * step you still owe. Everything a re-mint is for is `cpctl enroll <machineId>`
 * now, and Retire-then-Add is expressly not the substitute: it mints a new machine
 * id and silently drops every grant but the creator's. Q3.428.
 */

/** A code that exists in one response and nowhere else, plus the host it is for. */
interface PendingCode {
  /** Named, because a code pasted on the wrong host is spent and unrecoverable. */
  machine: string;
  url: string;
  code: string;
  expiresAt: number;
}

export function MachinesSection({ state }: { state: AppState }): ReactNode {
  /*
   * **The Add form's own result, and nothing else.**
   *
   * Every row used to lift its code up here, which put a single-use,
   * single-showing value above a list it was minted from the middle of: tap "New
   * code" on the fourth machine on a phone and the thing you asked for renders
   * off-screen. Worse, a second tap on any *other* row overwrote it — the value
   * is gone from the server's side of the conversation too, so that is a code
   * destroyed rather than a panel replaced. A row's code is drawn in the row now,
   * exactly as `UserRow` already draws a reset password.
   */
  const [pending, setPending] = useState<PendingCode | null>(null);
  /*
   * **The shared predicate, asked once and never re-derived here.**
   *
   * `mayAddMachine` reads the control plane's own `canAddMachine`; deriving it
   * from `machineLimit`/`machineCount` at this call site is the exact defect
   * `showsGateLink` was extracted to end, and `webcheck` reads this file off
   * disk to assert neither number is mentioned in it.
   */
  const canAdd = mayAddMachine(state.me);
  /*
   * **The readout, which is a different sentence from the notice.**
   *
   * `machineQuotaNotice` is `null` **iff** the door is drawn, which is the
   * invariant `webcheck` asserts on it — so it can never carry "2 of 5" while
   * there is room. This is the second function that invariant's own docblock
   * names, and it answers the question the screen could not: how much is left,
   * asked *before* running out rather than at the moment of refusal.
   */
  const allowance = machineAllowanceText(state.me);
  /*
   * Which names are worth an id beside them, asked once for the whole list rather
   * than per row — it is a property *of the list*, and a row cannot see its
   * siblings. See `ambiguousNames`.
   */
  const ambiguous = ambiguousNames(state.machines);

  return (
    /*
     * **No padding of its own.** `Settings.tsx` already gives this column
     * `px-4 py-4 sm:px-5`, and a second `px-4 pt-4` here inset the content twice —
     * 32px on a phone against `ServerSection`'s 16px, which is one screen and two
     * different left edges.
     */
    <div>
      {/*
       * The intro is a claim about what this screen does, and in the two states
       * where there is no form it is false — "adding one here gives you a code"
       * over nothing that adds one. The notice takes its place rather than
       * joining it, so exactly one sentence on this screen is about the limit.
       */}
      <p className="text-xs text-muted">
        {canAdd
          ? "A machine is a host running the daemon. Adding one here gives you a code to start it with; nobody else has to do anything."
          : machineQuotaNotice(state.me)}
      </p>

      {/*
       * **Removed, not disabled.** Every control has to be true in the state it
       * is drawn in, and a disabled field with a Add button beside it is a form
       * that claims it would work. The heading and the explanation stay; the
       * control goes — `mailUsable`'s pattern on the settings screen next door.
       */}
      {canAdd && <AddMachine onAdded={setPending} />}

      {pending !== null && (
        <OneTimeSecret
          label={`Start the daemon on ${pending.machine} with`}
          value={enrollmentLines(pending.url, pending.code)}
          note={`Single-use, ${enrollmentExpiryText(pending.expiresAt, Date.now())}. Shown once — only its hash is stored.`}
          onDone={() => setPending(null)}
        />
      )}

      {/* `h2` under `Sheet`'s `h1` and the pane's own heading, in the app's one
          settings-section chrome — see `SETTINGS_SECTION`. */}
      <section className={SETTINGS_SECTION}>
        <div className="flex items-baseline gap-2">
          <h2 className={SETTINGS_HEADING}>Your machines</h2>
          {/* `text-faint` and beside the heading: a fact about the list, which must
              never look like the notice — the one sentence here allowed to be
              about a *problem*. */}
          {allowance !== null && <span className="text-2xs text-faint">{allowance}</span>}
        </div>

        <div className="mt-3 space-y-2">
        {state.machines.length === 0 ? (
          /*
           * **"Add one above" is false while the control plane is unreachable**,
           * and it is the one state where this list is empty for a reason that
           * has nothing to do with how many machines you have. `bootstrap` keeps
           * `phase: "ready"` with no machines and `cpError` set on a cold load
           * against a dead control plane, and the banner that says so
           * (`ControlPlaneNotice`) is rendered in `AppShell`'s *sessions* arm and
           * in `Home` — neither of which is on screen here. So an outage drew a
           * confident empty state with a remedy that could not work: `POST
           * /v1/machines` goes to the same service.
           */
          state.cpError !== null ? (
            <Empty>
              Cannot reach the control plane, so your machines cannot be listed. They are not gone — this list is read
              from it, and so is adding one.
            </Empty>
          ) : canAdd ? (
            <Empty>No machines yet. Add one above.</Empty>
          ) : (
            // "Add one above" drops exactly when there is nothing above — the
            // same correction the `cpError` arm makes, for the same reason. The
            // sentence saying why is the intro, which has already become the
            // notice.
            <Empty>No machines yet.</Empty>
          )
        ) : (
          state.machines.map((machine) => (
            <MachineRow
              key={machine.id}
              machine={machine}
              showId={ambiguous.has(machine.name.toLowerCase())}
            />
          ))
        )}
        </div>
      </section>
    </div>
  );
}

function AddMachine({ onAdded }: { onAdded: (pending: PendingCode) => void }): ReactNode {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || name.trim().length === 0) return;
    const label = name.trim();
    setBusy(true);
    setError(null);
    void cp
      .createMachine(label)
      .then((created) => {
        setName("");
        onAdded({
          machine: label,
          url: created.controlPlaneUrl,
          code: created.enrollment.code,
          expiresAt: created.enrollment.expiresAt,
        });
        // The new machine appears in the list through the ordinary refresh rather
        // than being spliced in here — one source of fleet state, not two.
        // `machinesChanged`, not `resume`: this just consumed a slot, and the
        // number the limit is enforced against lives on `me`, which `resume`
        // re-reads only on a `loading → ready` promotion.
        void store.machinesChanged("machine-added");
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
          placeholder="laptop"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Machine name"
          className={`min-w-0 flex-1 ${FIELD}`}
        />
        <Button type="submit" tone="primary" disabled={busy || name.trim().length === 0}>
          {busy ? <Spinner /> : "Add"}
        </Button>
      </div>
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
    </form>
  );
}

/**
 * One machine, as a link to its own screen.
 *
 * **The row stopped being a control panel.** It carried a navigate button, a
 * kebab holding three more acts, an inline rename form, a one-time secret and a
 * two-step confirmation — and the name, the only flexible child beside three
 * `shrink-0` groups, rendered at 0px inside the settings sheet at 1280px. All of
 * it moved onto the machine, which is what "like with the agents" means
 * literally: `AgentChooser`'s row shape, so the two depths read as one object.
 *
 * A `<button>` may hold no interactive descendant, which is the second and
 * independent reason the kebab could not survive as a trailing control — and it
 * takes three pieces of machinery with it: the `openUp` placement rule (nothing
 * opens a panel from a row now), the confirming column layout, and the measured
 * `gap-3` (there is no `IconButton::after` left to land on a neighbour's face).
 *
 * **A machine you do not own gets the same link.** `Agents` already sat outside
 * the ownership gate on purpose — configuring an agent is an act on the daemon,
 * reached with a `session:write` grant — so a non-owned row already meant "one
 * tap, to a real screen", and the destination simply arrives without the three
 * owner-only blocks. An unopenable row wearing a chevron would be a control lying
 * about the state it is drawn in. Q3.432.
 */
function MachineRow({
  machine,
  showId,
}: {
  machine: AppState["machines"][number];
  /** Another machine in this list answers to the same name. See `ambiguousNames`. */
  showId: boolean;
}): ReactNode {
  const badge = machineBadgeText(machine);

  const standing = machine.ownerDisabled
    ? // Only ever a machine somebody else owns — a banned owner cannot reach
      // this screen — so the remedy named is the admin's, not theirs.
      "its owner has been disabled, so it is switched off until that is lifted"
    : machine.overLimit
      ? machine.owned === true
        ? "over your machine limit — retire another to bring it back"
        : "over its owner's machine limit"
      : machine.reach === "online"
        ? "online"
        : machine.enrolled
          ? /*
             * The reach, and **how long it has been that way** where that adds
             * anything. "Offline" alone was the same word for a lid that closed a
             * minute ago and a host that died last week, which is the one thing
             * somebody looking at this row wants to know. `lastSeenText` returns
             * `null` for the three cases where the number would be noise or a
             * claim — see it for which.
             */
            [reachText(machine.reach, machine.offlineReason), lastSeenText(machine.lastSeenAt)]
              .filter((part) => part !== null)
              .join(" · ")
          : "waiting for the daemon to dial in";

  return (
    <button
      onClick={() => navigate(settingsPath("machines", machine.id))}
      className="tap press flex w-full min-h-14 items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2.5 text-left hover:border-edge-strong"
    >
      <Dot tone={machine.reach === "online" ? "on" : "off"} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium">{machine.name}</span>
          {badge !== null && <Badge tone="strong">{badge}</Badge>}
        </span>
        <span className="block truncate text-2xs text-muted">
          {showId && (
            <>
              <code className="text-2xs text-muted/80">{machine.id}</code>
              {" · "}
            </>
          )}
          {standing}
          {machine.owned === true ? "" : " · not yours to rename or retire"}
        </span>
      </span>
      {/* `AgentChooser` needs no such glyph — its whole content is three tappable
          rows, so the block itself establishes that rows open. This list
          interleaves rows with prose, a form, a one-time secret and three empty
          states, and one of its rows may be a machine you do not own, which is
          exactly where a reader would otherwise assume it is inert. */}
      <Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />
    </button>
  );
}
