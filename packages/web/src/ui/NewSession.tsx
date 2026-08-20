import { ChevronRight, FileArchive, Folder, FolderPlus, GitBranch, LogIn } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ApiError, errorText } from "../http";
import { refOf, sessionId, type MachineId } from "../ids";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import { settingsPath } from "../settings";
import { navigate, sessionPath } from "../router";
import { store, type AppState } from "../store";
import type { AgentId, AgentInfo, DirEntry, Me } from "../wire";
import { ImportCode } from "./ImportCode";
import { Sheet } from "./Sheet";
import { agentLabel } from "./agentCard";
import { AgentDetail } from "./settings/AgentsPanel";
import {
  Button,
  Dot,
  Dropdown,
  Icon,
  SHEET_FOOT,
  Spinner,
  reachText,
} from "./bits";
import { toast } from "./Toast";
import type { MachineState } from "../machine";

/*
 * There is deliberately no "workspace" control on this screen.
 *
 * `createSession` accepts `worktree` and `branch`, and this screen briefly
 * offered them. That was a mistake, and the reason is worth writing down so it
 * is not re-added: the choice it exposed — an isolated checkout on its own
 * branch, or editing the folder in place — is one a person can only weigh if
 * they have that folder open somewhere else. Here the code lives in the tenant's
 * home on the daemon's host and this UI is the only way to it, so there is no
 * second view to protect, and the question had no answerable form.
 *
 * Worse, picking the isolated option produced a branch that this UI then gave no
 * way to see, diff or merge — it manufactured the "where did my code go" problem
 * it appeared to prevent.
 *
 * The daemon's default (`auto`) already does the right thing in both cases: a
 * git repository gets its own branch, anything else is worked in place. What the
 * session then reports is rendered in `SessionView`'s header, because the useful
 * thing is knowing what happened, not being asked to decide it in advance.
 */

/** Reachable now, and the grant allows creating a session on it. */
function canStartOn(machine: MachineState): boolean {
  return machine.reach === "online" && machine.scopes.includes("session:write");
}

/** Why this machine cannot be started on, or `null` if it can. */
function unusableReason(machine: MachineState): string | null {
  if (canStartOn(machine)) return null;
  // A reachable machine you merely lack the scope for is a *different* problem
  // from one that is switched off, and telling them apart is the difference
  // between "ask for access" and "turn it on".
  return machine.reach === "online" ? "read-only" : reachText(machine.reach, machine.offlineReason);
}

/**
 * Which machine to start on.
 *
 * A dropdown and not a wrap of buttons, which is the rule this change writes down:
 * **a control whose option count can exceed about five is a dropdown; a fixed set
 * of five or fewer is chips.** A fleet is unbounded, so the wrap reflowed the whole
 * form every time a machine appeared or went away, and on a phone it pushed the
 * agent and folder fields off the screen. Those buttons also had no hover state at
 * all, so there was nothing to say which of them could be pressed.
 *
 * Unusable machines stay in the list, disabled and *labelled with why*. Filtering
 * them out would answer "where did my laptop go" with silence.
 */
function MachinePicker({
  machines,
  value,
  onChange,
}: {
  machines: readonly MachineState[];
  value: MachineId | null;
  onChange: (id: MachineId) => void;
}): ReactNode {
  const current = machines.find((machine) => machine.id === value);
  const reason = current === undefined ? null : unusableReason(current);

  return (
    <div className="space-y-1">
      <Dropdown
        items={machines.map((machine) => {
          const why = unusableReason(machine);
          return {
            value: machine.id,
            label: machine.name,
            description: why,
            disabled: why !== null,
            adornment: <Dot tone={why === null ? "on" : "off"} />,
          };
        })}
        value={value}
        onChange={onChange}
        heading="Machine"
        trigger={
          <span className="flex min-w-0 items-center gap-1.5">
            <Dot tone={current !== undefined && reason === null ? "on" : "off"} />
            <span className="truncate">{current?.name ?? "Choose a machine"}</span>
          </span>
        }
        className="w-full"
      />
      {/* The reason below rather than inside the trigger, exactly as `AgentPicker`
          does: a status that lengthens the button makes the button jump. */}
      {reason !== null && <p className="text-2xs text-muted">{reason}</p>}
    </div>
  );
}

/**
 * Machine, agent, directory. Three questions, and there used to be a fourth.
 *
 * **The first prompt is gone.** It was a four-row textarea justified as optional,
 * and optional is exactly what was wrong with it: it sat between the folder and
 * the Start button on every single session anybody has ever created, asking for
 * something most of them did not want to type there. The composer is one
 * navigation away, it is where every *other* message is written, and it has the
 * `/` menu, attachments and the agent's own controls beside it — none of which
 * this box had. A session that exists and is idle is useful on its own.
 *
 * It also removed the one place this screen sent a request it could not report
 * on: the prompt was fired best-effort after `POST /sessions`, swallowing its own
 * failure, because by then the session existed and navigating to it was the more
 * useful outcome than an error about a message. There is now nothing to swallow.
 *
 * `POST /sessions` blocks until the agent has actually started — up to 45 seconds
 * — so the button says what it is waiting for rather than appearing hung.
 */
export function NewSession({
  state,
  machineId: fromRoute = null,
  cwd: fromRouteCwd = null,
}: {
  state: AppState;
  /**
   * Preselected by "New session on <machine>" in that machine's section.
   *
   * From the route rather than a prop drilled through the shell, so going back
   * and forward again does not forget which machine you meant.
   */
  machineId?: MachineId | null;
  /**
   * The folder to open the picker in, from `/new/:machineId/:cwd`.
   *
   * Set when this was opened from a folder's own `+` in the rail, so the answer
   * to "where" is already the folder you were looking at. It rides the route for
   * the same reason the machine does — `router.ts` says it: sidebar state feeding
   * a routed dialog forgets itself on back-and-forward.
   */
  cwd?: string | null;
}): ReactNode {
  /*
   * Online *and* granted `session:write`.
   *
   * Reachability alone is not enough to start a session: the grant carries scopes,
   * and a read-only grant is refused by the daemon at `POST /sessions`. Filtering
   * here rather than there is the difference between a machine that is visibly
   * unavailable and one that accepts a machine, an agent, a directory and a typed
   * prompt before answering 403.
   */
  const reachable = state.machines.filter((machine) => canStartOn(machine));
  const [machine, setMachine] = useState<MachineId | null>(fromRoute);
  const [agent, setAgent] = useState<string>("claude");
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  /** Reported up by the picker, so the footer can name the folder as the agent will. */
  const [cwd, setCwd] = useState<string | null>(fromRouteCwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by the inline sign-in, so the tiles re-read `GET /agent-auth`. */
  const [agentsEpoch, setAgentsEpoch] = useState(0);

  const selected = machine ?? reachable[0]?.id ?? null;
  /*
   * Resolved here rather than inside the effects, so it can *be* the dependency.
   *
   * Keyed on `selected`, the `daemon === undefined` arm below was a dead end: the
   * client is created for every machine in `bootstrap`, but nothing re-runs an
   * effect that returned before reaching its request, so a screen that mounted a
   * beat early — a machine re-granted mid-session, a `dropMachine` and back — kept
   * a spinner where the agent tiles go and an empty folder list, for ever.
   * `store.daemons` holds one client per machine for that machine's whole life, so
   * the identity is stable and the dependency costs nothing in the ordinary case.
   */
  const daemon = selected === null ? undefined : store.daemonFor(selected);

  useEffect(() => {
    if (daemon === undefined) return;
    setAgents(null);
    /*
     * ⚠ **This must not clear `cwd`, and doing so is what made `Start` dead.**
     *
     * The folder is `DirectoryPicker`'s to report and this effect is about
     * agents. Clearing it here raced the picker in a way nothing could recover
     * from: the picker reports through an effect keyed on its own `path`, so once
     * that value had been reported and then wiped from under it, `path` never
     * changed again and it was never reported again — `Start` stayed disabled
     * with the chosen folder sitting on screen and named in the footer. Three
     * ordinary routes reached it: the rail's folder `+` (`/new/:machineId/:cwd`,
     * where child effects run before parent effects, so the wipe landed second),
     * the "re-check" button after an inline sign-in (`agentsEpoch`), and any
     * change of machine. The picker resets itself now, by being remounted — see
     * its `key` below.
     */
    void daemon
      .agents()
      .then((result) => {
        setAgents(result.agents);
        const available = result.agents.find((candidate) => candidate.available);
        if (available !== undefined) setAgent(available.id);
      })
      .catch(() => setAgents([]));
  }, [daemon, agentsEpoch]);

  const create = (): void => {
    if (busy) return;
    /*
     * Both of these used to be silent `return`s, which is the shape of defect this
     * screen has already had once: a control that looks live, does nothing, and
     * says nothing. The button is disabled in the first state and cannot be
     * disabled in the second — `daemonFor` can answer `undefined` while everything
     * on screen is filled in — so the arm that can be reached by tapping is the
     * one that has to speak.
     */
    if (selected === null || cwd === null) {
      setError("Pick a machine and a folder first.");
      return;
    }
    if (daemon === undefined) {
      setError("That machine is not connected right now.");
      return;
    }
    setBusy(true);
    setError(null);
    void daemon
      // Neither `worktree` nor `branch` is sent, deliberately — see the note on
      // `WorktreeChoice` above. The daemon's own default covers both sensible
      // cases and the session says afterwards which one it got.
      .createSession({ agent, cwd })
      .then((result) => {
        const ref = refOf(selected, sessionId(result.session.id));
        store.applySnapshot(ref, result.session);
        navigate(sessionPath(ref), true);
      })
      .catch((cause: unknown) => {
        /*
         * A start timeout still created the session — the daemon says so, and
         * says at which id. Navigating there is more useful than an error about
         * a session that exists.
         */
        if (ApiError.isApiError(cause) && cause.code === "agent_start_timeout") {
          const detail = cause.detail as { sessionId?: string } | null;
          if (typeof detail?.sessionId === "string") {
            navigate(sessionPath(refOf(selected, sessionId(detail.sessionId))), true);
            return;
          }
        }
        setError(errorText(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <Sheet
      title="New session"
      footer={
        <div className={SHEET_FOOT}>
          {/* Says what Start is about to do. The picker has no confirming tap —
              the folder you are in is the one you get — so this is where that
              choice is stated plainly rather than inferred from a breadcrumb.

              **Three arms, and the third is the one that was missing.** With no
              folder yet this was empty, which is precisely the state in which
              `Start` is disabled: a 40%-opacity button and nothing anywhere
              saying what it is waiting for. */}
          <span className="min-w-0 flex-1 text-2xs text-muted wrap-anywhere">
            {busy ? (
              "this can take up to 45 seconds"
            ) : cwd !== null ? (
              <>in <span className="font-mono text-fg">{cwd}</span></>
            ) : (
              "choosing a folder…"
            )}
          </span>
          <Button
            tone="primary"
            onClick={create}
            disabled={busy || selected === null || cwd === null}
          >
            {busy ? "Starting the agent…" : "Start"}
          </Button>
        </div>
      }
    >
      {/*
       * One scroller, and the folder list is it.
       *
       * `SHEET_BODY` scrolls by default and `DirectoryPicker` used to carry its
       * own `max-h-56`, which inside a sheet is the classic phone failure: you
       * scroll the list, hit its end, the sheet starts moving under you, and you
       * lose your place. So the body does not scroll, the fixed things above it
       * are `shrink-0`, and the list takes whatever height is left with a floor.
       * The technique is `AskCard`'s: fixed head and foot, shrinkable middles.
       */}
      <div className="-my-5 flex min-h-0 flex-1 flex-col gap-4 py-4">
        <div className="shrink-0">
          <MachineLine
            machines={state.machines}
            reachable={reachable}
            value={selected}
            fromRoute={fromRoute}
            me={state.me}
            onChange={setMachine}
          />
        </div>

        <div className="shrink-0">
          <FieldLabel>Agent</FieldLabel>
          {agents === null ? (
            <Spinner />
          ) : (
            <AgentTiles
              agents={agents}
              value={agent}
              onChange={setAgent}
              machineId={selected}
              onChanged={() => setAgentsEpoch((n) => n + 1)}
            />
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <FieldLabel>Directory</FieldLabel>
          {selected === null ? (
            <p className="text-sm text-muted">Pick a machine first.</p>
          ) : (
            /*
             * **`key` on the machine, which is what makes a reset a remount.**
             *
             * The picker holds its own `path`, seeded once, and a machine's
             * folders are a different tree — so without this it kept pointing at
             * the previous machine's directory, `path` never changed, and the
             * report effect below never fired again. A remount is the reset that
             * the parent used to attempt with `setCwd(null)` from an effect that
             * had no business touching it.
             *
             * `initial` is the route's folder only for the machine the route
             * names; walking to another machine starts at that machine's root.
             */
            <DirectoryPicker
              key={selected}
              machineId={selected}
              initial={selected === fromRoute ? fromRouteCwd : null}
              onPick={setCwd}
            />
          )}
        </div>

        {error !== null && <p className="shrink-0 text-sm text-danger wrap-anywhere">{error}</p>}
      </div>
    </Sheet>
  );
}

/**
 * Three agents, as three buttons in a row.
 *
 * **A narrowing of the picker rule rather than a breach of it.** `bits.tsx` puts
 * the threshold at "about five" and names the reason as *unboundedness*: a wrap of
 * buttons over a set that can grow reflows the page every time the set changes
 * size. `AGENT_IDS` is a closed set of three, validated in `settings.ts` and pinned
 * by `pincheck`, so nothing here can reflow. It is the chips side of a rule that
 * already had two sides — and `AgentChooser` in settings draws the same three the
 * same way, one screen over.
 *
 * `grid grid-cols-3` and not `flex-wrap`, so a fourth agent from a newer daemon
 * wraps onto a second row instead of squeezing three tiles into two thirds of the
 * width.
 *
 * Unavailable agents stay, disabled, saying why — `MachinePicker`'s rule verbatim:
 * filtering them out answers "where did claude go" with silence.
 */
function AgentTiles({
  agents,
  value,
  onChange,
  machineId,
  onChanged,
}: {
  agents: AgentInfo[];
  value: string;
  onChange: (id: string) => void;
  machineId: MachineId | null;
  /** Re-reads the agent listing once a sign-in has changed something. */
  onChanged: () => void;
}): ReactNode {
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const selected = agents.find((candidate) => candidate.id === value) ?? agents[0] ?? null;
  if (selected === null) return <p className="text-sm text-muted">This machine reports no agents.</p>;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {agents.map((candidate) => {
          const picked = candidate.id === selected.id;
          return (
            <button
              key={candidate.id}
              type="button"
              disabled={!candidate.available}
              onClick={() => onChange(candidate.id)}
              aria-pressed={picked}
              /*
               * The same treatment `AskCard` gives a chosen answer — border, fill
               * and weight together, three signals for one state — because
               * "picked" should look the same wherever it appears. Kept local
               * rather than promoted to `bits.tsx` on the second copy; the third
               * one earns the constant.
               */
              className={`tap press flex min-h-16 flex-col items-start justify-center gap-1 rounded-lg border p-2.5 text-left disabled:opacity-40 ${
                picked
                  ? "border-edge-strong bg-raised font-medium text-fg"
                  : "border-edge bg-surface text-fg hover:bg-raised"
              }`}
            >
              <span className="w-full truncate text-sm">{candidate.displayName}</span>
              <span className="w-full truncate text-2xs text-muted">
                {agentStatusText(candidate)}
              </span>
            </button>
          );
        })}
      </div>

      {/*
       * **Signing in happens here, not somewhere else.**
       *
       * This used to `navigate(settingsPath("machines", machineId, agent))`. From
       * inside a pop-up that is a pop-up replacing a pop-up, and it discards the
       * folder already chosen — the dialog appears to have wandered off. So the
       * same `AgentDetail` the settings sheet renders opens *inline* instead: one
       * flow, one door, the folder untouched, and the `sessionStorage` reattach
       * works identically because it is keyed on machine and agent rather than on
       * where it is mounted.
       *
       * The old `navigate` is removed rather than kept as a fallback. Two doors
       * into one flow is how one of them rots.
       */}
      {(selected.available === false || selected.loggedIn === false) && machineId !== null && (
        <div>
          <button
            type="button"
            onClick={() => setSigningIn(signingIn === selected.id ? null : selected.id)}
            aria-expanded={signingIn === selected.id}
            className="tap press -my-2 inline-flex min-h-11 items-center gap-1 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg"
          >
            <Icon as={LogIn} size={12} />
            {signingIn === selected.id ? "Hide sign-in" : `Sign in to ${agentLabel(selected.id)}`}
          </button>
          {/* `bg-raised/50` — the quiet grade, the one a tool card uses. This is a
              container for the wizard rather than a value to read, so it marks out
              a region without competing with the code inside it. */}
          {signingIn === selected.id && (
            <div className="mt-2 rounded-lg border border-edge bg-raised/50 p-3">
              {/*
               * Keyed on machine and agent so wizard state cannot leak across a
               * switch, exactly as `MachineAgentsSection` keys it.
               *
               * ⚠ The sheet's ✕, its scrim and Escape must never be wired to this
               * — only the wizard's own Cancel may call `cancelLogin`. Closing a
               * dialog looks like it should cancel what it was doing, and here
               * that would kill a live device-code flow with the code already on
               * somebody's clipboard. Unmounting is safe: the run id is in
               * `sessionStorage` and reopening replays the transcript.
               */}
              {/* `AgentDetail` carries its own "Check again" two lines above
                  this, so the duplicate here is deleted rather than restyled. */}
              <AgentDetail
                key={`${machineId}:${selected.id}`}
                machineId={machineId}
                agentId={selected.id as AgentId}
                onChanged={onChanged}
              />
            </div>
          )}
        </div>
      )}

      {/*
       * **The second render site of `agent.hint`, and the reason deleting only
       * the one on the agents card would not have worked.** The same five lines
       * of adapter-vs-CLI and `session/new … -32000` were drawn here too, on the
       * screen a person actually starts a session from. What they can act on is
       * re-derived in `agentCard.ts` and drawn by `AgentDetail` above. Q3.431.
       */}
    </div>
  );
}

/**
 * The four states, in words, on a tile that has room for one line.
 *
 * `loggedIn: null` is "unknown", never "not signed in": kimi has no
 * non-interactive way to answer, and saying the stronger thing would send somebody
 * to a login screen they do not need.
 */
function agentStatusText(agent: AgentInfo): string {
  if (!agent.available) return "not installed";
  if (agent.loggedIn === true) return "signed in";
  if (agent.loggedIn === false) return "not signed in";
  return "state unknown";
}

/**
 * Which machine, as a line rather than a control — until it has to be one.
 *
 * The machine comes from the route (`/new/:machineId`), which `router.ts` already
 * defends: component state forgets itself on back-and-forward, and the sidebar's
 * tab bar *writes* that route rather than being read here, because sidebar state
 * feeding a routed dialog is the same forgetting one level up.
 *
 * The picker is not deleted, though, and that matters more than it looks: `/new`
 * with no machine is reachable two ways — the sidebar's own button and a cold
 * link — and it silently takes the first reachable machine. With three agent tiles
 * that guess got worse, because **agent status is per machine**: the wrong machine
 * shows the wrong sign-in state on all three tiles at once.
 */
function MachineLine({
  machines,
  reachable,
  value,
  fromRoute,
  me,
  onChange,
}: {
  machines: MachineState[];
  reachable: MachineState[];
  value: MachineId | null;
  fromRoute: MachineId | null;
  /*
   * Passed rather than a precomputed boolean, so this file *calls*
   * `mayAddMachine` — which is what `webcheck` reads off disk to assert that no
   * add-a-machine affordance re-derives the rule at its own call site.
   */
  me: Me | null;
  onChange: (id: MachineId) => void;
}): ReactNode {
  const settled = fromRoute !== null || reachable.length === 1;
  const [open, setOpen] = useState(!settled);
  const current = machines.find((candidate) => candidate.id === value) ?? null;

  if (machines.length === 0) {
    return (
      <div>
        <FieldLabel>Machine</FieldLabel>
        <p className="text-sm text-muted">No machines yet.</p>
        {/* The same three-arm shape as the rail's empty fleet, and the same
            rule: a door, or the sentence saying why there is not one. */}
        {mayAddMachine(me) ? (
          <Button className="mt-2" onClick={() => navigate(settingsPath("machines"))}>
            Add a machine
          </Button>
        ) : (
          <p className="mt-2 max-w-sm text-xs text-muted">{machineQuotaNotice(me)}</p>
        )}
      </div>
    );
  }

  if (!open && current !== null) {
    return (
      <div className="flex min-h-8 items-center gap-2 text-sm">
        <Dot tone={current.reach === "online" ? "on" : "off"} />
        <span className="min-w-0 truncate">
          on <span className="font-medium">{current.name}</span>
        </span>
        {/* A picker of one is a question with one answer. */}
        {reachable.length > 1 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="tap -my-2 inline-flex min-h-11 items-center rounded-sm px-1.5 text-xs text-muted hover:bg-raised hover:text-fg"
          >
            change
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <FieldLabel>Machine</FieldLabel>
      <MachinePicker machines={machines} value={value} onChange={onChange} />
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <h2 className="pb-1.5 text-2xs font-semibold tracking-wider text-muted uppercase">{children}</h2>
  );
}

/**
 * Where the agent will work.
 *
 * The model is the one every file dialog uses: **the folder you are in is the
 * folder you have chosen.** Rows only ever navigate. The current path is stated at
 * the top and is what `Start` will use, "New folder" creates and walks straight
 * into it, and the breadcrumb is how you go back up. The previous version made you
 * play a guessing game — every row had two tap targets, one that walked *into* a
 * folder and one that *chose* it, with nothing on screen saying which was which.
 *
 * Paths are shown as they are: the agent runs on the daemon's own filesystem, so
 * what this lists is what the transcript will print.
 *
 * **It is the sheet's only scroller**, which is why the list below takes the
 * height that is left rather than the `max-h-56` it used to carry. That constant
 * was sized for a full screen with a header and a footer around it; inside a sheet
 * it produced two nested scrollers, and the phone failure that follows is
 * unmistakable — you reach the end of the list, the sheet starts moving instead,
 * and you have lost your place.
 *
 * That paragraph described an intention rather than the build for as long as it
 * stood here: `SHEET_BODY` was a *block* container, so the `min-h-0 flex-1` chain
 * between it and the list resolved to nothing, the list sized to its content, and
 * it scrolled in neither direction — while its `overscroll-contain` stopped the
 * wheel from reaching the one box that could move. The fix is one class string in
 * `bits.tsx` and the rules here are unchanged; see `SHEET_BODY`.
 */
function DirectoryPicker({
  machineId: id,
  initial,
  onPick,
}: {
  machineId: MachineId;
  /**
   * The folder to open in, from `/new/:machineId/:cwd` — a **seed, not a value**.
   *
   * Named `initial` rather than `value` because it is read exactly once, into
   * `useState` below, and the old name invited the other reading: a `value` prop
   * that the parent could set back to `null` while this component went on
   * displaying the folder it had, which is very close to the defect that was
   * actually there. A machine change is a remount, not a new `value` — see the
   * `key` at the call site.
   */
  initial: string | null;
  /** Lifted so the footer can render the chosen path the same way this does. */
  onPick: (path: string | null) => void;
}): ReactNode {
  const [root, setRoot] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(initial);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // The dependency rather than a lookup inside each effect, for the reason given
  // where `NewSession` resolves its own: an effect that returns before its
  // request has nothing to bring it back.
  const daemon = store.daemonFor(id);

  useEffect(() => {
    if (daemon === undefined) return;
    void daemon
      .roots()
      .then((result) => {
        const first = result.roots[0] ?? null;
        setRoot(first);
        // `result.recent` is read by nothing now — see the note where the strip
        // it fed used to be drawn.
        // Start at the top of their own tree rather than at nothing. There is
        // exactly one root — a tenant's own directory — so a "pick a root" step
        // would be a list of one.
        setPath((current) => current ?? first);
      })
      .catch((cause: unknown) => setError(errorText(cause)));
  }, [daemon]);

  /*
   * The current folder *is* the selection, so the parent form is told on every
   * move rather than by a separate confirming tap.
   *
   * **Unconditional, including `null`.** Guarded on `path !== null` this was half
   * a rule: the parent could be left holding a folder this picker was no longer
   * showing, with no event able to correct it, which is exactly how `Start` came
   * to be disabled over a folder named in its own footer. Reporting the absence
   * too makes the parent's `cwd` a strict mirror of `path` — one value, one
   * writer — so the two cannot disagree in either direction.
   */
  useEffect(() => {
    onPick(path);
  }, [path]);

  useEffect(() => {
    if (daemon === undefined || path === null) return;
    let cancelled = false;
    setEntries(null);
    setError(null);
    void daemon
      .listDir(path)
      .then((result) => {
        if (!cancelled) setEntries(result.entries);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, path]);

  const create = (): void => {
    if (daemon === undefined || path === null || name.trim().length === 0 || busy) return;
    setBusy(true);
    void daemon
      .makeDir(path, name.trim())
      .then((result) => {
        setName("");
        setCreating(false);
        // Straight into it: creating a folder to work in and then having to find
        // it in the list is the same needless step this rewrite removed.
        setPath(result.path);
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  /**
   * The path as clickable segments.
   *
   * Built from the *host* path against the root, then labelled with the agent's
   * name for it, so a click navigates somewhere real while the text reads like
   * the machine the person thinks they are on.
   */
  const crumbs: { label: string; path: string }[] = [];
  if (root !== null && path !== null && path.startsWith(root)) {
    crumbs.push({ label: root, path: root });
    const rest = path.slice(root.length).split("/").filter((part) => part.length > 0);
    let walked = root;
    for (const part of rest) {
      walked = `${walked}/${part}`;
      crumbs.push({ label: part, path: walked });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-edge-strong bg-surface">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-edge bg-raised px-2.5 py-2">
        <span className="text-faint">
          <Icon as={Folder} size={12} />
        </span>
        {crumbs.length === 0 ? (
          <span className="font-mono text-2xs text-muted">loading…</span>
        ) : (
          crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex items-center gap-1">
              {index > 0 && <span className="text-faint">/</span>}
              <button
                onClick={() => setPath(crumb.path)}
                disabled={index === crumbs.length - 1}
                /* An 11px glyph with no vertical padding was a 16px target, and
                   this is the *only* way back up the tree — rows in the list below
                   only ever descend. `-my-2` keeps the bar from growing by the full
                   difference: the crumbs occupy 28px of layout and the remaining
                   8px above and below is hit area over the bar's own padding. */
                className={`tap -my-2 inline-flex min-h-11 items-center px-1 font-mono text-2xs ${
                  index === crumbs.length - 1 ? "text-fg font-medium" : "text-muted hover:underline"
                }`}
              >
                {crumb.label}
              </button>
            </span>
          ))
        )}
      </div>

      {/*
       * There was a "recent" strip here, and it is gone rather than moved.
       *
       * It mounted only at the root and only when the daemon had sent any, so it
       * was a row that appeared and disappeared *inside* the one control on this
       * screen that has to hold still while a thumb travels down it — and it took
       * the folder list's height with it every time. That is the same objection
       * the sheet's own fixed height answers one level up, at a smaller scale.
       * What it saved was one tap on a breadcrumb that is right above it.
       *
       * `RootListing.recent` still arrives on the wire and now has no reader.
       */}
      {error !== null && <p className="px-3 py-2 text-xs text-danger wrap-anywhere">{error}</p>}

      <div className="min-h-32 flex-1 overflow-auto overscroll-contain">
        {entries === null && error === null && (
          <p className="px-3 py-3 text-xs text-muted">Loading…</p>
        )}
        {entries !== null && entries.length === 0 && (
          <p className="px-3 py-3 text-xs text-muted">
            This folder has nothing in it. That is fine — the agent can work here.
          </p>
        )}
        {entries?.map((entry) => (
          <button
            key={entry.path}
            onClick={() => setPath(entry.path)}
            className="tap flex w-full items-center gap-2 border-b border-edge/50 px-3 py-2.5 text-left last:border-0 hover:bg-raised/60"
          >
            <span className={entry.isGitRepo ? "text-fg" : "text-faint"}>
              <Icon as={entry.isGitRepo ? GitBranch : Folder} size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
            {entry.entries !== null && (
              <span className="shrink-0 text-2xs text-faint">{entry.entries}</span>
            )}
            <span className="shrink-0 text-faint">
              <Icon as={ChevronRight} size={13} />
            </span>
          </button>
        ))}
      </div>

      <div className="border-t border-edge px-2.5 py-2">
        {creating ? (
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  create();
                }
                if (event.key === "Escape") setCreating(false);
              }}
              autoFocus
              placeholder="folder name"
              aria-label="New folder name"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-edge-strong bg-ink px-3 py-2 font-mono text-xs outline-none"
            />
            <Button onClick={create} disabled={busy || name.trim().length === 0}>
              {busy ? <Spinner /> : "Create"}
            </Button>
            <Button tone="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          /* Two controls, and they belong together: this bar is the one place on
             the screen for getting somewhere the list cannot take you, and both
             of these act on the folder you are standing in rather than on a row.
             Neither takes `tone="primary"` — `bg-fg` is the affirmative action
             inside a decision, and on this screen that is `Start`. */
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCreating(true)}
              disabled={path === null}
              /* 44px, with no negative margin: this row's other state is the two
                 `Button`s of the create form, which are 44px already, so matching
                 them is what stops the panel changing height when the form opens
                 and closes. It was a 22px target on the one control that gets you
                 somewhere the list cannot. */
              className="tap press flex min-h-11 items-center gap-1.5 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
            >
              <Icon as={FolderPlus} size={13} />
              New folder here
            </button>
            <button
              onClick={() => setImporting(true)}
              disabled={path === null}
              className="tap press flex min-h-11 items-center gap-1.5 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
            >
              <Icon as={FileArchive} size={13} />
              Import code
            </button>
          </div>
        )}
      </div>
      {importing && path !== null && (
        <ImportCode
          machineId={id}
          into={path}
          onClose={() => setImporting(false)}
          /* Straight into it, for the reason creating a folder walks into the one
             it just made: the folder somebody imported is the folder they meant to
             work in, and making them find it in the list is the step this screen
             exists to remove. */
          onImported={(imported) => setPath(imported)}
        />
      )}
    </div>
  );
}
