import { ChevronRight, FileArchive, Folder, FolderPlus, GitBranch, LogIn, Pencil, Plus } from "lucide-react";
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ApiError, errorText } from "../http";
import { takePick, takeRemoval } from "../agentPick";
import { refOf, sessionId, type MachineId } from "../ids";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import { settingsPath } from "../settings";
import { agentEditPath, agentPath, navigate, newPath, sessionPath, type Route } from "../router";
import { store, type AppState } from "../store";
import type { AgentInfo, CustomAgent, DirEntry, Me, SystemInfo } from "../wire";
import { customAgentSubline } from "../agents";
import { AgentGlyph } from "./AgentIcons";
import { ImportCode } from "./ImportCode";
import { agentLabel } from "./agentCard";
import { AgentDetail } from "./settings/AgentsPanel";
import {
  Button,
  Dot,
  Dropdown,
  Empty,
  Icon,
  SHEET_FOOT,
  SHEET_SCREEN,
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
 * The New session pop-up's body: the session screen, and the agent flow.
 *
 * ⚠ **One mount across `/new` and `/agent/*`, which is what stopped a pop-up
 * appearing to collapse when it went one screen deeper.** Each route used to
 * render a `Sheet` of its own, so walking into the builder *unmounted* one panel
 * and mounted another — firing `SHEET_PANEL`'s `animate-sheet` again, sliding a
 * bottom sheet up from off-screen a second time, *inside* a `section-push` view
 * transition that was already moving the pane sideways. Measured at 390px: the
 * New session panel travelled downwards while the arriving screen came in from
 * the right. Q3.472.
 *
 * The panel itself is `OverlaySheet`'s now and serves every route-backed pop-up,
 * which generalises that fix — see Q3.484. What is left here is the dispatch and
 * the two values that must survive it.
 *
 * ⚠ **The two bodies do not overlap in the tree**, so nothing `NewSession` holds
 * survives a trip into the builder. That is why the folder rides the address; it
 * is stated at `cwd` below and in the `agent` route.
 */
export function StartSheet({
  state,
  route,
}: {
  state: AppState;
  route: Extract<Route, { name: "new" } | { name: "agent" }>;
}): ReactNode {
  /*
   * ⚠ **The chosen tile lives here rather than in `NewSession`, because the agent
   * flow is a *route*.** `NewSession` unmounts for the whole of it, so a tile
   * chosen and then a trip into the builder — even one left by ◀ with nothing
   * assembled — put the strip back on the first available harness with nothing on
   * screen saying so. This component is mounted for `/new` and `/agent` alike.
   *
   * ⚠ **A choice *per machine*, not the last machine a choice was made on.** This
   * was one `touchedOn: MachineId | null` — a flag saying "somebody has tapped,
   * and it was over there" — which suppresses a re-default on the machine it
   * names and nothing else. Two machines is all it takes: tap a tile on A, switch
   * to B (the listing re-defaults, deliberately leaving the flag alone), come back
   * to A — the flag still says A, so A's re-default is skipped while the single
   * chosen value is still whatever B defaulted to. A then drew B's harness
   * selected *and* disabled, said "not installed", offered its sign-in, and
   * `Start` posted it for a `503 agent_unavailable`. A map restores A's own
   * choice instead of merely silencing A's default, which is the thing the flag
   * was standing in for. Q3.482.
   *
   * ⚠ **And a ref of the same map, because the value is read from a `.then` that
   * cannot be re-created.** `NewSession`'s listing effect depends on the daemon
   * client, which `store.daemonFor` keeps stable per machine — so the effect does
   * not re-run when a tile is tapped, and its pending `.then` closes over the prop
   * from the render that created it. The state is what makes the choice survive
   * `/agent`'s unmount and re-render the strip; the ref is what makes the answer
   * read the choice *as it is when the answer lands*. Both are needed and each has
   * its own failure: with no state the tile reverts on the way back from the
   * builder, and with no ref the agent just assembled is overwritten one round trip
   * later by the first available harness — tap `+` without tapping a tile first,
   * which is the whole of what it takes, since assembling one never went through
   * the flag that suppressed the default.
   */
  const [picks, setPicks] = useState<ReadonlyMap<MachineId, Picked>>(new Map());
  const picksRef = useRef<ReadonlyMap<MachineId, Picked>>(picks);
  const choose = (machine: MachineId, next: Picked | null): void => {
    const updated = new Map(picksRef.current);
    if (next === null) updated.delete(machine);
    else updated.set(machine, next);
    // Written before the render that will carry it: this is the copy the listing's
    // `.then` reads, and it has to be true the moment the tap happens rather than
    // one render later.
    picksRef.current = updated;
    setPicks(updated);
  };

  return (
    <>
      {route.name === "new" ? (
        <NewSession
          state={state}
          machineId={route.machineId}
          cwd={route.cwd}
          picks={picks}
          picksRef={picksRef}
          onPick={choose}
        />
      ) : (
        /* Lazy for the reason the sheets around it are: it fetches nothing until
           it is opened, and it is opened rarely. The boundary is *inside* the
           panel, so a chunk still in flight is a spinner in the pane rather than a
           frame with no pop-up in it at all. */
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          {/* `preset` is the whole of what "edit" means here: the same three
              screens, seeded from a row the daemon already holds and saved with
              `PATCH` rather than `POST`. It rides the address for the reason the
              folder does — this component unmounts for the whole of the flow, so
              anything held here is gone by the time the builder is drawn. */}
          <AgentBuilder
            machineId={route.machineId}
            cwd={route.cwd}
            step={route.step}
            preset={route.preset}
          />
        </Suspense>
      )}
    </>
  );
}

const AgentBuilder = lazy(async () => ({
  default: (await import("./AgentBuilder")).AgentBuilder,
}));

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
function NewSession({
  state,
  machineId: fromRoute = null,
  cwd: fromRouteCwd = null,
  picks,
  picksRef,
  onPick,
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
  /**
   * The tile chosen **on each machine**, held by `StartSheet` so it survives the
   * agent flow. A machine with no entry is one nobody has chosen on.
   */
  picks: ReadonlyMap<MachineId, Picked>;
  /**
   * The same map, as it stands right now rather than as it stood when a render
   * ran. Read from the two places that must see a choice made after their own
   * render — the listing's `.then` and the hand-off effect — and nowhere else, the
   * strip itself drawing from `picks`. See `StartSheet`, which owns both.
   */
  picksRef: RefObject<ReadonlyMap<MachineId, Picked>>;
  /** Records a choice against the machine it was made on; `null` withdraws it. */
  onPick: (machineId: MachineId, next: Picked | null) => void;
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
  /*
   * The choices live in `StartSheet`, one level up, and the reason is a *route*.
   *
   * ⚠ **This component unmounts for the whole of the agent flow**, so a tile
   * chosen here and then a trip into the builder — even one left by the ◀ without
   * assembling anything — put the strip back on the first available harness and
   * said nothing. `StartSheet` is mounted for `/new` and `/agent` alike, so the
   * choice survives the walk that this screen cannot.
   */
  const choose = (next: Picked): void => {
    // Recorded against the machine it was made on, never as one value plus a flag
    // saying where it came from: the effect below re-defaults per machine, and a
    // flag can only *silence* the machine it names while the one chosen value goes
    // on being whatever some other machine defaulted to. See `StartSheet`.
    if (selected === null) return;
    onPick(selected, next);
  };
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  /**
   * What this machine's listing defaulted to, kept **apart from what somebody
   * chose**.
   *
   * ⚠ **One value for both was what made a stale choice indistinguishable from a
   * fresh default.** The default belongs to a machine and to a listing — it is
   * recomputed every time either changes, and cleared beside `agents` below — so
   * holding it in `StartSheet`'s per-machine map would write a choice nobody made
   * into the record of choices people made, and the next visit would restore it as
   * though it had been tapped. A chosen tile outranks this one; see `picked`.
   */
  const [defaulted, setDefaulted] = useState<Picked | null>(null);
  /**
   * Why `GET /agents` came back with nothing, when it came back with nothing
   * because it failed.
   *
   * ⚠ **A failed read is not an empty machine**, and this screen drew one as the
   * other: the catch set `[]` and nothing else, so the strip said "This machine
   * reports no agents" over a transport failure, a 503, or a grant revoked while
   * the sheet was open — with the real reason nowhere, on the one screen somebody
   * is looking at. `AgentBuilder`'s `ModelPicker` holds the same field for the
   * same reason, one file over in this same change.
   */
  const [agentsFailure, setAgentsFailure] = useState<string | null>(null);
  /**
   * The agents assembled on this machine, or `null` while unread.
   *
   * ⚠ **`[]` *with `canAssemble` false* means "this daemon is older than
   * assembled agents", and only that.** The client knows an old daemon by the
   * *shape of its refusal* rather than by a version — `compatibility.md`'s rule,
   * the same one the plugin market keeps — so an envelope-free 404 from `GET
   * /custom-agents` lands here as an empty list and takes the `+` tile with it,
   * rather than drawing a control whose every press answers "update your
   * machine".
   *
   * ⚠ **Every other failure keeps the `+` and says why**, which is the half that
   * was missing: one catch mapped a timeout, a 500 and a revoked grant onto the
   * same silence as an old daemon, so the entry point to the whole assembled-agent
   * feature vanished with nothing on screen saying it had. See the catch below.
   */
  const [customAgents, setCustomAgents] = useState<CustomAgent[] | null>(null);
  /** Why that read failed, when it failed as anything but a daemon too old to have the route. */
  const [presetsFailure, setPresetsFailure] = useState<string | null>(null);
  /**
   * The systems this machine knows, for naming an assembled agent's tile.
   *
   * Cheap enough for this screen — `GET /systems` is a table and spawns nothing,
   * unlike `GET /agents/capabilities`, which starts an agent per harness and is
   * why the *builder* is the only thing that calls it.
   */
  const [systems, setSystems] = useState<SystemInfo[]>([]);
  const [canAssemble, setCanAssemble] = useState(false);
  /** Reported up by the picker, so the footer can name the folder as the agent will. */
  const [cwd, setCwd] = useState<string | null>(fromRouteCwd);
  /*
   * ⚠ **The address follows the folder, and the agent builder is why.**
   *
   * This used to live only here, which was fine while nothing on this screen
   * navigated. The builder is a pop-up one depth down now, so leaving and coming
   * back remounts this component — and a folder somebody had walked several
   * levels into would have been thrown away, which is precisely the failure that
   * put the *sign-in* flow inline. `router.ts` states the remedy: state feeding a
   * routed dialog goes in the URL.
   *
   * `replace`, never push: walking a directory tree is not a history somebody
   * wants to step back through one folder at a time, and `depthOf` answers the
   * same depth either way so nothing animates. Guarded on a real change, so this
   * cannot loop against its own re-render.
   */
  useEffect(() => {
    if (machine === null && fromRoute === null) return;
    const target = machine ?? fromRoute;
    if (target === null || cwd === null) return;
    if (target === fromRoute && cwd === fromRouteCwd) return;
    navigate(newPath(target, cwd), true);
  }, [machine, cwd, fromRoute, fromRouteCwd]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by the inline sign-in, so the tiles re-read `GET /agent-auth`. */
  const [agentsEpoch, setAgentsEpoch] = useState(0);

  const selected = machine ?? reachable[0]?.id ?? null;
  /**
   * The tile this screen draws as chosen, and the id `Start` will post.
   *
   * Two sources in order — what somebody chose on *this* machine, then what this
   * machine's listing defaulted to — and **both are weighed against the listing**
   * by {@link offeredHere}. A pick that the machine no longer offers is dropped
   * rather than drawn, which is one rule covering three failures that were three
   * separate bugs: a harness chosen on a machine that has it and restored on one
   * that does not; a preset deleted from the builder; and a preset deleted on
   * another device, where no hand-off exists to be told about it. All three ended
   * the same way — a tile drawn selected while disabled, or no tile drawn at all,
   * with `Start` enabled and posting an id the daemon answers 503 or 404 for.
   *
   * `null` is a real state and the button is gated on it: nothing is chosen while
   * the listing is still out, and a machine offering nothing startable leaves it
   * `null` rather than pointing at the first tile in the row.
   */
  const picked =
    offeredHere(selected === null ? null : (picks.get(selected) ?? null), agents, customAgents) ??
    offeredHere(defaulted, agents, customAgents);
  /*
   * What the pop-up that just closed did, adopted once.
   *
   * ⚠ **Read in an effect rather than during render**, because both of these
   * *consume*: a render that ran twice — which React does in development, and may
   * do at any time — would swallow the hand-off and leave the strip on whatever it
   * had. The assembled row is added to the list as well as selected, because
   * `offeredHere` draws a choice only against a listing that holds it — and the
   * effect below returns before its request for a machine with no client, which is
   * the one path where nothing else ever fills that list in.
   *
   * ⚠ **Both channels are taken on every run, and neither may be skipped because
   * the other answered.** `agentPick.ts` holds them as two maps for exactly that
   * reason — one machine can be carrying a removal *and* an assembly — and a
   * hand-off left behind is one that fires on some later visit, which is why it
   * takes rather than reads. The removal goes first, so a pick made after it
   * cannot be withdrawn by it. Nothing is spliced out of
   * `customAgents` for a removal: the builder navigates back, so this component has
   * just mounted with that list still `null` and the effect below re-reads it from
   * the daemon on this same mount.
   */
  useEffect(() => {
    if (selected === null) return;
    const removed = takeRemoval(selected);
    if (removed !== null) {
      // The ref rather than the prop, for `StartSheet`'s stated reason: this is the
      // map as it stands, and the pick being withdrawn may have been made in this
      // very flush.
      const standing = picksRef.current.get(selected);
      if (standing?.kind === "custom" && standing.id === removed) onPick(selected, null);
    }
    const fresh = takePick(selected);
    if (fresh === null) return;
    setCustomAgents((held) => [...(held ?? []), fresh]);
    onPick(selected, { kind: "custom", id: fresh.id });
  }, [selected, agentsEpoch]);
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
    // `selected` is in the guard as well as `daemon`, which is redundant at
    // runtime — the client is resolved from it — and is what lets the `.then`
    // below name the machine it is answering for without an assertion.
    if (daemon === undefined || selected === null) return;
    /*
     * ⚠ **Every one of these, not just `agents`.** Clearing only the render gate
     * left the *previous* machine's assembled agents, its system table and its
     * `+` gate on screen the instant the new machine's `GET /agents` answered —
     * two requests, so that is the ordinary interleaving rather than a race. The
     * strip then drew machine A's presets under machine B's name, and tapping one
     * posted a `customAgent` id that does not exist there.
     *
     * ⚠ **`defaulted` is one of them, and what somebody *chose* is not.** The
     * default is a fact about this listing and dies with it; the choices are
     * `StartSheet`'s, keyed by machine, and survive on purpose.
     */
    setAgents(null);
    setDefaulted(null);
    setAgentsFailure(null);
    setCustomAgents(null);
    setPresetsFailure(null);
    setSystems([]);
    setCanAssemble(false);
    /*
     * ⚠ **And a cancel flag, for the reason the two sibling effects in this file
     * already have one.** Nothing re-requests, so a slow answer for the machine
     * you left can land after the one you are on and win permanently.
     */
    let cancelled = false;
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
        if (cancelled) return;
        setAgents(result.agents);
        const available = result.agents.find((candidate) => candidate.available);
        /*
         * Only where nobody has chosen **on this machine**, and the choice is read
         * through the ref rather than through the prop this closure captured.
         *
         * ⚠ **The capture is the defect this arm had.** The effect's deps are the
         * daemon client and the epoch, and `store.daemonFor` answers the same
         * object for a machine's whole life — so nothing re-runs this effect when a
         * tile is tapped, and the `.then` created a round trip ago still sees the
         * props of the render it was created in. The adoption effect above runs in
         * the same flush and is declared *first*, so an agent assembled in the
         * pop-up was recorded and then overwritten here a beat later by the first
         * available harness, with nothing on screen saying so. `picksRef` is the
         * same map at answer time.
         *
         * Where somebody has chosen, no default is computed at all — so a choice
         * this machine turns out not to offer ends as *nothing* chosen rather than
         * as a quiet substitution. `Start` is disabled there and the footer asks
         * for an agent, which is the honest shape: this screen may not swap the
         * agent under somebody and then start a session with it.
         */
        if (available !== undefined && picksRef.current.get(selected) === undefined) {
          setDefaulted({ kind: "harness", id: available.id });
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // `[]` so the spinner leaves — an empty strip beside a stated reason is
        // honest, a spinner that never stops is not — and the reason beside it,
        // because this is the state the strip would otherwise describe as a
        // machine with no agents on it.
        setAgents([]);
        setAgentsFailure(errorText(cause));
      });
    /*
     * Separate from the agent read and deliberately not awaited with it: a daemon
     * that has never heard of this route must not cost the three built-in tiles
     * their listing. The refusal *is* the version check — see `customAgents`.
     */
    void Promise.all([daemon.customAgents(), daemon.systems()])
      .then(([mine, listing]) => {
        if (cancelled) return;
        // Assigned, not merged: this is the daemon's own list and it is
        // authoritative. The adopted hand-off above is in it — the row was
        // written before the pop-up closed — so nothing is lost by replacing.
        setCustomAgents(mine.customAgents);
        setSystems(listing.systems);
        setCanAssemble(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCustomAgents([]);
        setSystems([]);
        /*
         * ⚠ **Only an envelope-free 404 is an old daemon.** `parseBody` gives a
         * Hono 404 carrying no body of ours the code `http_404`, and that exact
         * test is what `importSupported` and `pluginFailure` already ask — a route
         * this daemon has never registered. Either read reaching here answers it
         * the same way, since both routes shipped together. Anything else answered
         * *about* the route: `503 systems_unavailable`, a 500, a relay
         * `no_tunnel`, a `TypeError` from a dead network. Collapsing the two is
         * what made a transient failure indistinguishable from a machine that will
         * never have this feature — and it took the `+`, the only door to it, with
         * it.
         */
        const absent =
          ApiError.isApiError(cause) && cause.status === 404 && cause.code === `http_${cause.status}`;
        setCanAssemble(!absent);
        setPresetsFailure(absent ? null : errorText(cause));
      });
    return () => {
      cancelled = true;
    };
    /*
     * `selected` and the chosen tile are read rather than depended on: this effect
     * is about which daemon answers, and re-running it because somebody tapped a
     * tile would re-fetch the whole listing on every tap.
     *
     * ⚠ **They are fresh for two different reasons, and one of them used to be
     * missing.** `selected` is fresh because `daemon` changes exactly when it does.
     * The chosen tile is not — `store.daemonFor` is stable per machine, so no
     * dependency here can carry a tap — which is why it is reached through
     * `picksRef` rather than through the prop, at the one place above that reads
     * it. A value captured in this closure is the value as it was when the request
     * was sent, and the interesting choices are all made after that.
     */
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
    /*
     * ⚠ **The last gate against posting an id this machine does not have.** The
     * button is disabled here too, so this arm is as unreachable as the one above
     * — and it is written all the same, because everything that made `picked`
     * `null` (a harness that is not installed, a preset somebody deleted on another
     * device) is a *stale* value that used to be sent: `503 agent_unavailable` and
     * `404` respectively, after a request somebody waited on.
     */
    if (picked === null) {
      setError("Choose an agent first.");
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
      .createSession(
        picked.kind === "custom"
          ? // `agent` is filled in by the daemon from the preset's own harness, so
            // the two cannot disagree. See `POST /sessions`.
            { agent: "", customAgent: picked.id, cwd }
          : { agent: picked.id, cwd },
      )
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
    <div className={SHEET_SCREEN}>
      {/*
       * One scroller, and the folder list is it.
       *
       * `DirectoryPicker` used to carry its own `max-h-56`, which inside a sheet
       * is the classic phone failure: you scroll the list, hit its end, the sheet
       * starts moving under you, and you lose your place. So this column does not
       * scroll, the fixed things above are `shrink-0`, and the list takes whatever
       * height is left with a floor. The technique is `AskCard`'s: fixed head and
       * foot, shrinkable middles.
       *
       * The padding is restored here because `SHEET_SCREEN` cancels the body's, so
       * the bar below can reach both edges.
       *
       * ⚠ **It scrolls, and the `shrink-0` children above are why it has to.**
       * `SHEET_BODY` used to be the scroller of last resort; with the bar moved
       * inside it, this column is `min-h-0 flex-1` of a box that no longer
       * overflows, so anything the fixed rows cannot fit escapes and paints over
       * the bar rather than scrolling. The inline sign-in reaches it in one tap: a
       * device-code transcript adds a couple of hundred pixels to a `shrink-0`
       * block on a 667px screen. The folder list keeps its `min-h-32` floor, so
       * this only moves once there is genuinely nowhere left to shrink to.
       */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
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
            <AgentStrip
              agents={agents}
              /* Nullable rather than `?? []`, because "still reading" and "there
                 are none" are the two states the empty sentence has to tell
                 apart: flattened here, a slow second read drew "This machine
                 reports no agents" over a listing that was on its way. */
              customAgents={customAgents}
              systems={systems}
              canAssemble={canAssemble}
              failure={agentsFailure}
              presetsFailure={presetsFailure}
              value={picked}
              onChange={choose}
              /* Its own screen, one depth down, carrying the folder so the way
                 back can restore it — see the `agent` route. */
              onAssemble={() => selected !== null && navigate(agentPath(selected, cwd))}
              /* The same screen, seeded from a preset that already exists. The
                 address is built here rather than in the strip for the reason
                 `onAssemble` is: this is where the folder lives. */
              onEdit={(preset) =>
                selected !== null && navigate(agentEditPath(selected, preset, cwd ?? undefined))
              }
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

      {/* Says what Start is about to do. The picker has no confirming tap — the
          folder you are in is the one you get — so this is where that choice is
          stated plainly rather than inferred from a breadcrumb.

          **One arm per thing this screen is still waiting for, and the number of
          them is deliberately not written down here — it was three.** With no
          folder yet this was empty, which is precisely the state in which
          `Start` is disabled: a
          40%-opacity button and nothing anywhere saying what it is waiting for.
          The agent arm arrived with the same argument — a machine whose harnesses
          are all uninstalled, or a preset deleted out from under the strip, leaves
          nothing chosen — and it is asked **before** the folder because the folder
          answers itself and this one needs a tap. It waits for the listing, or it
          would ask for an agent over a row that is still loading. */}
      <div className={SHEET_FOOT}>
        <span className="min-w-0 flex-1 text-2xs text-muted wrap-anywhere">
          {busy ? (
            "this can take up to 45 seconds"
          ) : agents !== null && picked === null ? (
            "choose an agent"
          ) : cwd !== null ? (
            <>in <span className="font-mono text-fg">{cwd}</span></>
          ) : (
            "choosing a folder…"
          )}
        </span>
        <Button
          tone="primary"
          onClick={create}
          disabled={busy || selected === null || cwd === null || picked === null}
        >
          {busy ? "Starting the agent…" : "Start"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Which tile is chosen, as a harness or as an assembled agent.
 *
 * A tagged pair rather than one string, because the two are different things on
 * the wire — `POST /sessions` takes `agent` or `customAgent` — and a single id
 * would have to be disambiguated by looking it up in two lists, which is the join
 * that goes wrong the first time somebody names a preset `claude`.
 */
export type Picked = { kind: "harness"; id: string } | { kind: "custom"; id: string };

/**
 * The same choice back, or `null` where this machine's listing does not offer it.
 *
 * ⚠ **A choice is about a *machine*, and nothing about it is portable.** A harness
 * is installed per machine, a preset is a row in that machine's database, and both
 * are read again every time the strip is drawn for a different one. So a stored
 * choice is a claim to be checked against the answer rather than a value to
 * restore, and every state this rejects is one that was on screen: a tile drawn
 * `aria-pressed` *and* `disabled`, saying "not installed" beside a `Start` that
 * posted it anyway.
 *
 * ⚠ **An unread listing offers nothing, deliberately.** `null` for both lists is
 * the loading state, and answering "yes, still offered" there would be a guess
 * about a machine that has not spoken — the guess that made `Start` live over a
 * default nobody had checked. The cost is that `Start` is disabled for the beat
 * before `GET /agents` answers, and the strip is a spinner for exactly that beat.
 *
 * A harness has to be **available**, not merely listed: an uninstalled one is
 * drawn and labelled on purpose, and choosing it is the thing the tile's own
 * `disabled` already refuses.
 *
 * Exported for the driver rather than for a caller: this is the one rule on this
 * screen that is a pure function of the two listings, and the states it rejects
 * are reachable from no assertion about a class string.
 */
export function offeredHere(
  pick: Picked | null,
  agents: AgentInfo[] | null,
  customAgents: CustomAgent[] | null,
): Picked | null {
  if (pick === null) return null;
  if (pick.kind === "harness") {
    return agents?.some((candidate) => candidate.id === pick.id && candidate.available) === true
      ? pick
      : null;
  }
  /*
   * ⚠ **The preset's *harness* is weighed too, and it was not.** This arm asked
   * only whether the row still exists, so a preset assembled on a harness that has
   * since been uninstalled stayed chosen with `Start` live — and posting it
   * answers `503` from the daemon's own availability check. The paragraph above
   * already states the rule for the other arm ("a harness has to be **available**,
   * not merely listed"); a preset is a harness plus two more facts, so it cannot be
   * exempt from the one that decides whether anything can run at all.
   */
  const preset = customAgents?.find((one) => one.id === pick.id) ?? null;
  if (preset === null) return null;
  return agents?.some((candidate) => candidate.id === preset.harness && candidate.available) === true
    ? pick
    : null;
}

/**
 * Every agent this machine can start, as a strip you drag sideways.
 *
 * ⚠ **A scroller rather than the `grid grid-cols-3` this replaced, and the rule
 * it used to cite is what forced the change.** `bits.tsx` puts the picker
 * threshold at "about five" and names the reason as *unboundedness*: a wrap of
 * buttons over a growing set reflows the page every time the set changes size.
 * Three built-in harnesses were a closed set and earned the exception; assembled
 * agents are unbounded, so the exception expired. A horizontal strip is the shape
 * this app already uses for the one other unbounded run of chips — the machine
 * tabs in `SessionBrowser` — down to the class strings, because a second idiom
 * for one problem is one of them going stale.
 *
 * ⚠ **`+` sits *outside* the scroller.** With a dozen assembled agents a button
 * at the end of the strip is unreachable without dragging to it, which is exactly
 * why the machine tabs put their own `+` outside. It is drawn as a tile of the
 * same size so it still reads as one more item in the row.
 *
 * Unavailable harnesses stay, disabled, saying why — `MachinePicker`'s rule
 * verbatim: filtering them out answers "where did claude go" with silence.
 *
 * ⚠ **Nothing here early-returns over the row any more, and the `+` is why.**
 * "This machine reports no agents" used to be returned *above* the strip, so a
 * transient failure of the cheap `GET /agents` took the entry point to the whole
 * assembled-agent feature off the screen — and the inline sign-in with it — while
 * `canAssemble` was true and the daemon was perfectly willing. The sentence is a
 * row inside the strip now: the `+` is drawn on exactly the condition it is about
 * (`canAssemble && machineId !== null`) and nothing upstream of it can decide
 * whether it exists.
 */
function AgentStrip({
  agents,
  customAgents,
  systems,
  canAssemble,
  failure,
  presetsFailure,
  value,
  onChange,
  onAssemble,
  onEdit,
  machineId,
  onChanged,
}: {
  agents: AgentInfo[];
  /**
   * The assembled agents, or `null` while that read is still out.
   *
   * ⚠ **Nullable rather than flattened by the caller**, because the empty
   * sentence has to tell "there are none" from "still reading". `?? []` at the
   * call site made them one value and drew a machine's whole listing as absent
   * for as long as the second request took.
   */
  customAgents: CustomAgent[] | null;
  systems: SystemInfo[];
  /** Whether this daemon knows about assembled agents at all. See `NewSession`. */
  canAssemble: boolean;
  /** Why `GET /agents` answered nothing, when it answered nothing by failing. */
  failure: string | null;
  /** The same for the assembled agents, which is a separate read and a separate row. */
  presetsFailure: string | null;
  /**
   * The chosen tile, or `null` when this machine offers nothing that was chosen.
   *
   * ⚠ **Nullable rather than always naming something**, because the alternative is
   * a tile drawn as chosen that nobody chose. It held a harness id unconditionally
   * and fell back to `agents[0]`, so a machine that had none of them installed
   * drew its first tile `aria-pressed` and `disabled` at once. `offeredHere` is
   * what empties it; nothing here re-guesses.
   */
  value: Picked | null;
  onChange: (next: Picked) => void;
  onAssemble: () => void;
  /** Opens the chosen preset's own edit screen. See the control below the strip. */
  onEdit: (preset: string) => void;
  machineId: MachineId | null;
  /** Re-reads the agent listing once a sign-in has changed something. */
  onChanged: () => void;
}): ReactNode {
  const [signingIn, setSigningIn] = useState<string | null>(null);
  /*
   * ⚠ **The chosen tile is scrolled to, and assembling one is why.** The strip
   * overflows at four tiles on a 390px phone, and a new agent lands at the end of
   * it — so `Add agent` selected something nobody could see and left the row
   * looking unchanged. Measured: 408px of tiles in a 294px box.
   *
   * `block: "nearest"` and `inline: "nearest"` so it moves only when the tile is
   * actually out of view: re-selecting something already on screen must not drag
   * the row under a thumb. Keyed on the value, so a poll cannot re-fire it.
   */
  const chosen = useRef<HTMLButtonElement | null>(null);
  const key = value === null ? "" : `${value.kind}:${value.id}`;
  useEffect(() => {
    chosen.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [key]);
  /*
   * The sign-in block below is about a *harness*, so it is drawn only when one is
   * chosen. An assembled agent that cannot start says so at `POST /sessions` by
   * name — "no key saved for Moonshot" — and the remedy for that is a system's
   * key rather than a CLI's login, which is a different screen.
   *
   * ⚠ **The second arm keeps the sign-in door on a machine that can start
   * nothing, and it is not a selection.** This resolution used to fall back to
   * `agents[0]` and the tiles drew themselves against *it*, so a machine with every
   * harness uninstalled put its first tile on screen `aria-pressed` and `disabled`
   * at once. The tiles ask `value` now and nothing there is pressed — but that
   * machine's only way forward is this block, since every tile in the row is
   * disabled and none of them can be tapped to reach a sign-in. So the door hangs
   * off the first row with nothing claiming to be chosen. Narrowed to exactly that
   * state: with something startable on the machine, a `null` selection means a
   * *preset* went away, and offering a CLI login for that answers the wrong
   * question.
   */
  const harness =
    value?.kind === "harness"
      ? (agents.find((candidate) => candidate.id === value.id) ?? null)
      : value === null && !agents.some((candidate) => candidate.available)
        ? (agents[0] ?? null)
        : null;
  const presets = customAgents ?? [];
  /**
   * The chosen tile, when it is an assembled agent — the one kind there is
   * anything to edit about. A built-in harness is whatever is installed on the
   * machine and this app changes none of it.
   */
  const chosenPreset =
    value?.kind === "custom" ? (presets.find((one) => one.id === value.id) ?? null) : null;
  /*
   * ⚠ **Said only once the second read has settled.** With `customAgents`
   * flattened to `[]` while it was still out, a fast `GET /agents` answering
   * nothing put "This machine reports no agents" on screen over a listing that
   * was on its way — and it is drawn *below* the row rather than instead of it,
   * so the `+` survives whatever either read did.
   */
  const nothingAtAll = agents.length === 0 && presets.length === 0 && customAgents !== null;

  /*
   * The tile. One shape for both kinds, because they are one choice — and the
   * treatment for "picked" is `AskCard`'s: border, fill and weight together,
   * three signals for one state.
   *
   * ⚠ **No `opacity` anywhere on it, and the subline is why.**
   * `disabled:opacity-40` composites the *whole* control, and the one line
   * saying why a tile cannot be pressed is inside it. Measured over
   * `--color-surface` (#ffffff): `--color-faint` at 40% is #C2BFB9, **1.83:1** —
   * against the ≥4.5:1 `index.css` bounds that token by, because almost every use
   * of it is 12px and this one is. A refusal has to be *more* legible than the
   * label it refuses, never less. So the tokens are named per element instead,
   * `BUTTON_TONE.plain`'s pattern: the title drops to `text-muted` (7.75:1 on
   * surface), the glyph to `text-faint`, and the subline **stays** at full
   * `text-faint` (6.23:1). Computed here rather than written as `disabled:`
   * variants so only one of each pair is ever emitted — between two conflicting
   * utilities in one class string the winner is the stylesheet's order rather
   * than the attribute's, which `bits.tsx` measured at `BUTTON_SIZE`.
   *
   * ⚠ **`border-edge-strong` when it is live, `border-edge` when it is not.** This
   * was `border-edge bg-surface` in both states: a white control on a white sheet
   * identified by a 1.31:1 hairline. `index.css` says outright that `edge` is
   * decorative and **may never be the sole identification of a control**, and that
   * `edge-strong` is held at ≥3:1 (4.40:1 on `surface`) because WCAG 1.4.11 asks
   * that of a non-text control with no fill of its own.
   *
   * The disabled arm is that same rule rather than an exception to it, and the
   * specification is explicit: 1.4.11 asks 3:1 of "visual information required to
   * identify user interface components and states, **except for inactive
   * components** or where the appearance of the component is determined by the user
   * agent and not modified by the author". In this app the strong edge is what says
   * *press me*, so wearing it on a tile that refuses to be pressed is a claim the
   * tile cannot honour — and a run of tiles is exactly where that misreads, since
   * the neighbour differing only in whether it can be taken is 8px away. `edge`
   * costs nothing here because it is identifying nothing. The box does not change
   * either way, so nothing reads as having grown when a harness gets installed.
   *
   * That leaves **three signals for one state** — the boundary handed back, the
   * title down to `muted`, the refusal at full `faint` — which is the count
   * `AskCard`'s `CHOSEN` argues for and the count the rail spends on a waiting
   * session. `ChoiceRow` in `bits.tsx` is the same three, decided the same way and
   * in the same order; this stayed a hand-rolled tile because it is 112px wide with
   * a stacked glyph rather than a 56px row, but the two must not drift.
   *
   * Hover still moves the **fill** and never the border, for the reason `index.css`
   * gives beside the two tokens.
   */
  const tile = ({
    key: tileKey,
    picked,
    disabled = false,
    onClick,
    glyph,
    title,
    subline,
    label,
    hint,
  }: {
    key: string;
    picked: boolean;
    disabled?: boolean;
    onClick: () => void;
    glyph: ReactNode;
    title: string;
    subline: string;
    /** The accessible name, where the visible text is not the whole of it. */
    label?: string;
    /** The pointer's tooltip, for the one value on a tile that can be cut. */
    hint?: string;
  }): ReactNode => {
    // Named rather than nested in the class template, because the three states do
    // not multiply: a live tile carries the boundary and takes the hover fill, a
    // picked one carries the boundary and already *has* the fill, and a disabled
    // one hands the boundary back and can be hovered to no purpose.
    //
    // `disabled` is asked **first**, so picked-and-disabled resolves to the inert
    // boundary while keeping the fill that says which tile is chosen — `ChoiceRow`'s
    // order, for its reason. `offeredHere` is meant to make that pair unreachable on
    // this screen, and this is written as though it were not: it is the exact state
    // that shipped once, drawn `aria-pressed` and `disabled` at the same time.
    const bound = disabled
      ? "border-edge"
      : picked
        ? "border-edge-strong"
        : "border-edge-strong hover:bg-raised";
    return (
      <button
        key={tileKey}
        ref={picked ? chosen : null}
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-pressed={picked}
        aria-label={label}
        title={hint}
        className={`tap press flex min-h-16 w-28 shrink-0 flex-col items-start justify-center gap-1 rounded-lg border p-2.5 text-left ${bound} ${
          picked ? "bg-raised font-medium text-fg" : "bg-surface text-fg"
        }`}
      >
        <span className={disabled ? "text-faint" : "text-muted"}>{glyph}</span>
        <span className={`w-full truncate text-2xs ${disabled ? "text-muted" : ""}`}>{title}</span>
        <span className="w-full truncate text-2xs text-faint">{subline}</span>
      </button>
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-stretch gap-2">
        {/* `no-scrollbar` for the one shape it is for: a strip dragged sideways
            whose contents announce there is more of them by being cut off at the
            edge. Never a vertical list. */}
        <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
          <div className="flex w-max gap-2">
            {agents.map((candidate) =>
              /* No `label`: the visible text is the whole of what this tile says
                 — the harness's name and its status — and the glyph repeats the
                 first of them. No `hint` either, since a fixed three-word label
                 in a 112px tile cannot be cut. */
              tile({
                key: candidate.id,
                /* Against `value` and never against the resolved `harness`, which
                   carries the sign-in door's fallback and would draw a tile as
                   chosen on a machine where nothing can be. */
                picked: value?.kind === "harness" && candidate.id === value.id,
                disabled: !candidate.available,
                onClick: () => onChange({ kind: "harness", id: candidate.id }),
                glyph: <AgentGlyph agent={candidate.id} size={18} />,
                title: agentLabel(candidate.id),
                subline: agentStatusText(candidate),
              }),
            )}
            {presets.map((one) => {
              /*
               * ⚠ **A preset is only as startable as the harness under it**, and
               * this tile drew pressable regardless — so a machine without
               * `claude` showed a greyed "Claude Code · not installed" tile beside
               * an enabled preset carrying the same glyph, and `Start` posted it
               * for a 503. The harness tiles two blocks up have always passed
               * `disabled: !candidate.available`; this is that same fact, reached
               * through the preset's own `harness`. `offeredHere` folds it in too,
               * so a stale pick clears rather than being posted.
               */
              const runs = agents.find((candidate) => candidate.id === one.harness) ?? null;
              const missing = runs === null || !runs.available;
              const where = customAgentSubline(one, systems);
              return tile({
                key: one.id,
                picked: value?.kind === "custom" && one.id === value.id,
                disabled: missing,
                onClick: () => onChange({ kind: "custom", id: one.id }),
                glyph: <AgentGlyph agent={one.harness} size={18} />,
                title: one.name,
                // The reason displaces the system, for `agentStatusText`'s rule on
                // the harness tiles: a tile that cannot be pressed says why on the
                // one line it has, rather than describing a pairing nothing can run.
                subline: missing ? `${agentLabel(one.harness)} not installed` : where,
                /*
                 * ⚠ **All three facts, because one of them is a glyph and
                 * `AgentGlyph` draws its svg `aria-hidden`.** Read out, this tile
                 * said its name and its system and left the *harness* off — the
                 * one fact assembling an agent exists to make choosable. The
                 * visible name comes first, so voice control's "click <name>"
                 * still lands on it.
                 */
                label: missing
                  ? `${one.name}, ${agentLabel(one.harness)} not installed`
                  : `${one.name}, ${agentLabel(one.harness)}, ${where}`,
                /*
                 * ⚠ **The tooltip is kept, and it is the name and nothing else.**
                 * `AgentBuilder`'s `Supports` docblock measured what `title` is
                 * worth — about a second of delay, unstyleable, reported as simply
                 * not appearing — and it does not exist on touch at all, which is
                 * why it may never be how a tile says something. It earns its place
                 * on exactly the one value here that gets cut: 12px in a 112px tile
                 * truncates at ~92px against a bound of 80 characters, so a preset
                 * named after a long model id is unreadable on screen and there is
                 * no other pointer affordance for it. Everything the tooltip cannot
                 * carry is in `aria-label` above, and the edit screen one tap below
                 * shows the name in full on every device.
                 */
                hint: one.name,
              });
            })}
          </div>
        </div>
        {canAssemble && machineId !== null && (
          <button
            type="button"
            onClick={onAssemble}
            aria-label="Add an agent"
            /* The same box as a real tile, dashed — it is one more item in the
               row rather than a control of a different kind — and bounded like
               one: dashed or not, this border is the whole of what says the
               control is there, which is what `edge-strong` is held at ≥3:1 for
               and what `edge` may never be used as. */
            className="tap press flex min-h-16 w-28 shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-edge-strong bg-surface text-muted hover:bg-raised hover:text-fg"
          >
            <Icon as={Plus} size={18} />
          </button>
        )}
      </div>

      {/* Below the row rather than instead of it — see the note on the early
          return this replaced. `failure` is the whole point: a read that failed
          is not a machine with nothing on it, and the reason was otherwise only
          on the screen behind this one. */}
      {nothingAtAll && failure === null && <Empty>This machine reports no agents.</Empty>}
      {/*
        * ⚠ **Unconditional, where it used to ride inside `nothingAtAll`.** That
        * predicate also requires `presets.length === 0`, so on any machine holding
        * one assembled agent a failed `GET /agents` said nothing at all: the strip
        * simply lost its harness tiles. "A failed read is not an empty machine" is
        * the rule, and the sibling row below has always been drawn this way — the
        * two reads are separate, so their failures are separate rows.
        */}
      {failure !== null && (
        <p className="text-2xs text-muted wrap-anywhere">
          The agents installed on this machine could not be read. {failure}
        </p>
      )}
      {presetsFailure !== null && (
        <p className="text-2xs text-muted wrap-anywhere">
          The agents assembled on this machine could not be read. {presetsFailure}
        </p>
      )}

      {/*
       * ⚠ **Editing hangs under the strip, not on the tile**, and the shape is
       * the sign-in block directly below it: one control about the chosen tile,
       * outside the scroller, drawn only while that tile is the kind it applies
       * to. Exactly one of the two is ever on screen, since a tile is a harness
       * or an assembled agent and never both — a built-in harness is whatever is
       * installed on the machine and has nothing here to edit.
       *
       * A kebab on the tile was the obvious answer and is the one this app has a
       * rule against: on a 112px tile inside a strip you drag sideways it puts a
       * target on another target's face, which is the mis-tap pair `TAP_GROW_Y`
       * exists to prevent and the reason this app grows tap areas with
       * pseudo-elements rather than boxes. A pencil drawn only on the chosen tile
       * is that same object one size smaller, and it fails in the direction that
       * costs: missing the pencil and hitting the tile re-selects what is already
       * selected and nothing happens, while missing the tile and hitting the
       * pencil leaves a screen holding a machine, an agent and a folder somebody
       * walked to. A second tap on the chosen tile has no affordance at all —
       * nothing says the tile became two controls — and on a strip that scrolls,
       * a tap ending a drag is routinely one nobody meant.
       */}
      {chosenPreset !== null && machineId !== null && (
        <div>
          <button
            type="button"
            onClick={() => onEdit(chosenPreset.id)}
            className="tap press -my-2 inline-flex min-h-11 max-w-full items-center gap-1 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg"
          >
            <Icon as={Pencil} size={12} />
            <span className="min-w-0 truncate">Edit {chosenPreset.name}</span>
          </button>
        </div>
      )}

      {/*
       * **Signing in happens here, not somewhere else.**
       *
       * This used to `navigate(settingsPath(...))`. From inside a pop-up that is a
       * pop-up replacing a pop-up, and it discards the folder already chosen — the
       * dialog appears to have wandered off. So the same `AgentDetail` the settings
       * sheet renders opens *inline* instead: one flow, one door, the folder
       * untouched, and the `sessionStorage` reattach works identically because it
       * is keyed on machine and agent rather than on where it is mounted.
       *
       * The old `navigate` is removed rather than kept as a fallback. Two doors
       * into one flow is how one of them rots.
       */}
      {harness !== null &&
        (harness.available === false || harness.loggedIn === false) &&
        machineId !== null && (
          <div>
            <button
              type="button"
              onClick={() => setSigningIn(signingIn === harness.id ? null : harness.id)}
              aria-expanded={signingIn === harness.id}
              className="tap press -my-2 inline-flex min-h-11 items-center gap-1 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg"
            >
              <Icon as={LogIn} size={12} />
              {signingIn === harness.id ? "Hide sign-in" : `Sign in to ${agentLabel(harness.id)}`}
            </button>
            {/* `bg-raised/50` — the quiet grade, the one a tool card uses. This is
                a container for the wizard rather than a value to read. */}
            {signingIn === harness.id && (
              <div className="mt-2 rounded-lg border border-edge bg-raised/50 p-3">
                {/*
                 * Keyed on machine and agent so wizard state cannot leak across a
                 * switch, exactly as `MachineSystemsSection` keys it.
                 *
                 * ⚠ The sheet's ✕, its scrim and Escape must never be wired to
                 * this — only the wizard's own Cancel may call `cancelLogin`.
                 * Closing a dialog looks like it should cancel what it was doing,
                 * and here that would kill a live device-code flow with the code
                 * already on somebody's clipboard. Unmounting is safe: the run id
                 * is in `sessionStorage` and reopening replays the transcript.
                 */}
                <AgentDetail
                  key={`${machineId}:${harness.id}`}
                  machineId={machineId}
                  agentId={harness.id}
                  onChanged={onChanged}
                />
              </div>
            )}
          </div>
        )}
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
            /*
             * ⚠ **`min-h-11`, because the padding lands this one pixel short.**
             * Measured: `text-sm` carries a 22px line box, `py-2.5` adds 20, and
             * the separator adds the last — 43px against the 44 this app names as
             * the platform minimum at `ICON_BUTTON_SIZE.lg`. One pixel is invisible
             * and is still a mis-tap on the rows somebody walks a directory tree
             * with, where the cost is opening the wrong folder rather than missing.
             * The floor is asked for rather than the padding retuned, so the row's
             * density is unchanged wherever the content is already taller.
             */
            className="tap flex min-h-11 w-full items-center gap-2 border-b border-edge/50 px-3 py-2.5 text-left last:border-0 hover:bg-raised/60"
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
