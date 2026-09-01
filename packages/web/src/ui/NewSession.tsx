import {
  ChevronRight,
  FileArchive,
  Folder,
  FolderPlus,
  GitBranch,
  LogIn,
  Settings2,
} from "lucide-react";
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ApiError, errorText } from "../http";
import { forgetPick, heldPick, keepPick, takePick, takeRemoval } from "../agentPick";
import { refOf, sessionId, type MachineId } from "../ids";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import { agentStripPath, settingsPath } from "../settings";
import { navigate, newPath, sessionPath, type Route } from "../router";
import { store, type AppState } from "../store";
import type { AgentInfo, AgentStripEntry, CustomAgent, DirEntry, Me, SystemInfo } from "../wire";
import { customAgentSubline, harnessSubline, offersStripTile, startableHere } from "../agents";
import { defaultRow, orderStrip, stripKey } from "../agentStrip";
import { AgentGlyph } from "./AgentIcons";
import { ImportCode } from "./ImportCode";
import { harnessName, startsBare } from "./agentCard";
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
  /*
   * ⚠ **And seeded from `agentPick.ts`, because this component's mount is no
   * longer the whole of the flow.** Everything above holds while the only place a
   * tile-chooser could walk to was `/agent`, which this component is mounted for.
   * The strip's gear opens `/settings/machines/:id/agents` — a different pop-up —
   * and that unmounts this, so the state above is gone by the time somebody
   * chevrons back. `heldPick` survives it: a module map, **read** rather than
   * taken, which is the opposite discipline from the two hand-offs beside it and
   * for the reason written down there.
   *
   * The state is kept rather than replaced by it. A module map cannot re-render,
   * and this component has to: what makes the strip redraw when a tile is tapped
   * is `setPicks`, and what makes the choice survive a walk to another pop-up is
   * `keepPick`. Three copies of one value, each answering something the others
   * cannot — the ref answers a `.then` that closed over an old prop.
   */
  const [picks, setPicks] = useState<ReadonlyMap<MachineId, Picked>>(() => {
    const seed = new Map<MachineId, Picked>();
    /*
     * Only the machine this route names, and only if there is one. The map holds
     * every machine somebody has chosen on in this tab, but a mount can only
     * honestly restore the one it is about: `/new` with no machine takes the first
     * reachable one, which is a guess this component makes *after* mounting, and
     * seeding against a guess is how the wrong machine's tile gets drawn.
     */
    const machine = route.machineId;
    if (machine === null) return seed;
    const held = heldPick(machine);
    if (held !== null) seed.set(machine, held);
    return seed;
  });
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
    // And outside this mount, for the walk to the settings pop-up and back. A
    // removal clears it for the same reason it clears the map: the tile it named
    // is gone.
    if (next === null) forgetPick(machine);
    else keepPick(machine, next);
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
            harness={route.harness}
          />
        </Suspense>
      )}
    </>
  );
}

/**
 * How long the agent strip's scrollbar stays after the last scroll event.
 *
 * Long enough to still be there between two flicks of one gesture, short enough
 * that a row nobody is touching is a row of tiles rather than a row of tiles with
 * a rule under it. A macOS overlay bar is about a second; this matches it rather
 * than inventing a number.
 */
const SCROLLBAR_FADE_MS = 1000;

/**
 * The narrowest the strip's thumb is ever drawn.
 *
 * A thumb sized honestly by ratio is what says how much more row there is, and on
 * a machine with a long list of assembled agents that number goes under a
 * fingertip: eleven tiles in a 306px box is a 28px thumb, and it keeps shrinking.
 * Below this the bar stops being a thing you can see move, which is the whole of
 * what it is for. 24px is `BUTTON_SIZE`'s floor halved — this is not a target and
 * nothing may be dragged by it.
 */
const MIN_THUMB_PX = 24;

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
   * ⚠ **`[]` *with `canConfigure` false* means "this daemon is older than
   * assembled agents", and only that.** The client knows an old daemon by the
   * *shape of its refusal* rather than by a version — `compatibility.md`'s rule,
   * the same one the plugin market keeps — so an envelope-free 404 from `GET
   * /custom-agents` lands here as an empty list and takes the gear with it,
   * rather than drawing a control whose every press answers "update your
   * machine".
   *
   * ⚠ **Every other failure keeps the gear and says why**, which is the half that
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
  /**
   * The order and the hidden set this machine remembers, or `[]` while unread.
   *
   * ⚠ **`[]` is honest in both of the states it covers, which is why there is no
   * `null` here.** An unread strip and a strip nobody has ever touched produce the
   * identical row — `orderStrip` falls back to natural order and hides nothing —
   * so a loading flag would distinguish two states that draw the same. What is
   * *not* the same is whether the gear may be drawn, and that is `canConfigure`
   * below, which is a fact about the daemon rather than about the list.
   */
  const [stored, setStored] = useState<AgentStripEntry[]>([]);
  /**
   * Whether this daemon knows about assembled agents and the strip at all.
   *
   * ⚠ **One flag for three routes, because one refusal answers for all three.**
   * `GET /custom-agents`, `GET /systems` and `GET /agent-strip` are read together
   * and shipped together, so a daemon that has never heard of one has never heard
   * of any — and the client knows that by the *shape of the refusal* rather than
   * by a version, which is `compatibility.md`'s rule and the one the plugin market
   * already keeps.
   *
   * ⚠ **It was `canAssemble` and it gates the gear now**, which is a wider claim
   * than the name it replaced made: the `+` it used to gate opened the builder, and
   * the gear opens a screen that also stores an order. Renamed rather than joined
   * by a second boolean, because two flags read off one catch are two things to
   * keep in step for no question either can answer alone.
   */
  const [canConfigure, setCanConfigure] = useState(false);
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
  /*
   * What this machine's strip has been told to leave out, as keys.
   *
   * Derived on every render rather than held, because it is a projection of
   * `stored` and holding it would be a second thing to clear when the machine
   * changes. It is read twice below and once by the strip, all in the same render.
   */
  const hiddenHere = new Set(
    stored.filter((one) => one.hidden).map((one) => stripKey(one.kind, one.ref)),
  );
  /**
   * What this machine's listing defaults to, kept **apart from what somebody
   * chose** — and it is the row's own first tile.
   *
   * ⚠ **Derived here, where it used to be state set inside `GET /agents`'s own
   * `.then`, and both halves of that move are corrections.**
   *
   * The *value* was `agents.find(shownHere)` — the first harness in `AGENT_IDS`
   * order — which stopped being the first thing on screen the moment the row
   * gained an order and a hidden set. Hiding `claude` left the default naming it,
   * `offeredHere` refused it for being hidden, and the screen drew no chosen tile
   * at all with `Start` disabled until somebody tapped one. It is now the first
   * row the strip draws **that a session can be started on** — see the paragraph
   * below for why the second half of that is not pedantry — which is also the
   * better answer on its own terms: somebody who dragged their agent to the front
   * meant it to be first.
   *
   * The *timing* was a `.then` closure, which is why it needed `picksRef` to read
   * the choice as it stood at answer time rather than at request time. Derived,
   * there is no capture to be stale: a choice outranks this because `??` says so,
   * one line down, in the render that draws both.
   *
   * ⚠ **`customAgents === null` answers `null` rather than defaulting to a
   * harness.** The two reads land separately, so a default computed off the first
   * of them would name a harness for one beat and then jump to whatever the
   * stored order actually puts first — a selection moving under somebody on the
   * screen where the selection is the point. Nothing is chosen while the listing
   * is still out, which is the rule this screen already keeps.
   *
   * ⚠ **And it skips a row it cannot start, which `.find((row) => !row.hidden)`
   * did not.** The harness half of the row is filtered by `shownHere` on the way
   * in, so a signed-out one is not a candidate — but a *preset* is listed whatever
   * state its harness is in, and it draws a disabled tile saying so. First in the
   * order, that tile was the default: `offeredHere` refused it one line down, and
   * the screen drew nothing chosen with `Start` dead, which is the same failure as
   * the hidden one arriving through the other door. {@link defaultRow} weighs both,
   * and the *marked* default on the Agents screen is that same call — one rule, so
   * the badge over there cannot name a row this line would skip.
   */
  const defaulted =
    customAgents === null
      ? null
      : defaultRow(
          orderStrip(
            [
              ...(agents ?? [])
                .filter(shownHere)
                .map((one) => ({ kind: "harness" as const, id: one.id })),
              ...customAgents.map((one) => ({ kind: "custom" as const, id: one.id })),
            ],
            stored,
          ),
          (row) => startableHere(row, agents, customAgents),
        );
  /**
   * The tile this screen draws as chosen, and the id `Start` will post.
   *
   * Two sources in order — what somebody chose on *this* machine, then what this
   * machine's listing defaults to — and **both are weighed against the listing**
   * by {@link offeredHere}. A pick that the machine no longer offers is dropped
   * rather than drawn, which is one rule covering four failures that were four
   * separate bugs: a harness chosen on a machine that has it and restored on one
   * that does not; a preset deleted from the builder; a preset deleted on another
   * device, where no hand-off exists to be told about it; and an agent somebody
   * hid. All four ended the same way — a tile drawn selected while disabled, or no
   * tile drawn at all, with `Start` enabled and posting an id the daemon answers
   * 503 or 404 for.
   *
   * `null` is a real state and the button is gated on it: nothing is chosen while
   * the listing is still out, and a machine offering nothing startable leaves it
   * `null` rather than pointing at the first tile in the row.
   */
  const picked =
    offeredHere(
      selected === null ? null : (picks.get(selected) ?? null),
      agents,
      customAgents,
      hiddenHere,
    ) ??
    offeredHere(
      defaulted === null ? null : { kind: defaulted.kind, id: defaulted.id },
      agents,
      customAgents,
      hiddenHere,
    );
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
    setAgentsFailure(null);
    setCustomAgents(null);
    setPresetsFailure(null);
    setSystems([]);
    setStored([]);
    setCanConfigure(false);
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
    void Promise.all([daemon.customAgents(), daemon.systems(), daemon.agentStrip()])
      .then(([mine, listing, strip]) => {
        if (cancelled) return;
        // Assigned, not merged: this is the daemon's own list and it is
        // authoritative. The adopted hand-off above is in it — the row was
        // written before the pop-up closed — so nothing is lost by replacing.
        setCustomAgents(mine.customAgents);
        setSystems(listing.systems);
        /*
         * ⚠ **The strip rides with the presets rather than with `GET /agents`,
         * and the grouping is the version check rather than tidiness.** All three
         * of these routes shipped together, so one envelope-free 404 answers for
         * all three — while the harness listing is older than every one of them
         * and must keep its own tiles on a daemon that has none of this.
         */
        setStored(strip.entries);
        setCanConfigure(true);
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
         * the same way, since all three routes shipped together. Anything else answered
         * *about* the route: `503 systems_unavailable`, a 500, a relay
         * `no_tunnel`, a `TypeError` from a dead network. Collapsing the two is
         * what made a transient failure indistinguishable from a machine that will
         * never have this feature — and it took the `+`, the only door to it, with
         * it.
         */
        const absent =
          ApiError.isApiError(cause) && cause.status === 404 && cause.code === `http_${cause.status}`;
        setStored([]);
        setCanConfigure(!absent);
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
          {/*
           * ⚠ **Three states here, and the third one was a spinner that never
           * stopped.** The listing effect returns before its request when there is
           * no machine to send it to, and nothing re-runs an effect that returned
           * early — so `agents` stayed `null` for the life of the mount and this
           * ternary spun for a read that had never been started. It is not a rare
           * state: `/new` from the rail's **All** tab names no machine, and
           * `reachable[0]` is `null` on a fleet where nothing is online, which is
           * precisely when somebody needs to be told what the screen is waiting for.
           *
           * The sentence is the Directory field's own, word for word. Both are
           * gated on `selected` and a screen that answers one question two ways —
           * one field asking for a machine while the other claims to be reading
           * from one — sends somebody looking for a fault that is not there.
           */}
          {selected === null ? (
            <p className="text-sm text-muted">Pick a machine first.</p>
          ) : agents === null ? (
            <Spinner />
          ) : (
            <AgentStrip
              agents={agents}
              /* Nullable rather than `?? []`, because "still reading" and "there
                 are none" are the two states the empty sentence has to tell
                 apart: flattened here, a slow second read drew "This machine
                 reports no agents" over a listing that was on its way.

                 The third state — nobody has named a machine, so neither read was
                 ever sent — never reaches this component. It is answered by the
                 arm above, because with no daemon to ask both lists stay `null` for
                 ever, and "still reading" is a claim about a request that does not
                 exist. */
              customAgents={customAgents}
              systems={systems}
              stored={stored}
              canConfigure={canConfigure}
              failure={agentsFailure}
              presetsFailure={presetsFailure}
              value={picked}
              onChange={choose}
              /*
               * ⚠ **Another pop-up, and leaving this one for it is affordable
               * only because both halves of what is on screen survive the walk.**
               * The folder is in the address — `/new/:machineId/:cwd` — so the way
               * back restores it, and the chosen tile is in `agentPick.ts`'s
               * standing map, which outlives this mount. Without those two, this
               * is exactly the navigation that put the sign-in wizard inline: a
               * pop-up replacing a pop-up, discarding a folder somebody had walked
               * several levels into, so the dialog appears to have wandered off.
               *
               * `navigate` and not `replace`: the settings screen is somewhere you
               * go *from* here, and the phone's Back button has to come back.
               */
              onConfigure={() => {
                if (selected === null) return;
                /*
                 * ⚠ **The address is made whole before we leave, because a bare
                 * `/new` is a real state and it remembers nothing.** `/new` with
                 * no machine is reached from the rail's **All** tab and from a
                 * cold link; the sync effect above deliberately does not rewrite
                 * it, and `StartSheet` can only seed a pick for a machine the
                 * route names. So walking to another pop-up from there and coming
                 * back landed on `/new` with the folder unwalked and the tile
                 * unchosen — the very loss this door is only affordable because
                 * it avoids.
                 *
                 * `replace` first, so the entry somebody comes back to is the
                 * complete one rather than a second history step to pass through.
                 */
                navigate(newPath(selected, cwd ?? undefined), true);
                navigate(agentStripPath(selected));
              }}
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
      </div>

      {/* Says what Start is about to do, or what it just did. The picker has no
          confirming tap — the folder you are in is the one you get — so this is
          where that choice is stated plainly rather than inferred from a
          breadcrumb.

          **One arm per thing this screen is still waiting for, and the number of
          them is deliberately not written down here — it was three.** With no
          folder yet this was empty, which is precisely the state in which
          `Start` is disabled: a
          40%-opacity button and nothing anywhere saying what it is waiting for.
          The agent arm arrived with the same argument — a machine whose harnesses
          are all uninstalled, or a preset deleted out from under the strip, leaves
          nothing chosen — and it is asked **before** the folder because the folder
          answers itself and this one needs a tap. It waits for the listing, or it
          would ask for an agent over a row that is still loading.

          ⚠ **And the refusal is one of the arms now, where it used to be the last
          paragraph of the scroller — which is a place nobody was looking.** That
          column ends in a `flex-1` directory picker with a `min-h-32` floor, so
          the failure was a `shrink-0` line *below* a box that has already taken
          every pixel the fixed rows left: on a 390×667 phone it rendered under
          the fold, nothing scrolled it into view, and pressing `Start` to have the
          daemon refuse looked exactly like pressing it and having nothing happen.
          It outranks every arm under it because a request that was made and failed
          is newer than anything this screen is still waiting for, and it is
          `text-danger` for the same reason the arms below it are not.

          ⚠ **Mounted unconditionally with only its text swapping**, which is the
          one arrangement that is reliably spoken: a `role="status"` inserted in
          the same paint as its content is commonly not announced at all,
          VoiceOver on iOS included. `Sheet`'s own region records that, and
          `AgentBuilder`'s footer — the same bar, one screen deeper — is this
          arrangement already, down to the tone swap. So the failure joins the
          ternary rather than arriving as a `<p>` of its own. */}
      <div className={SHEET_FOOT}>
        <span
          role="status"
          aria-live="polite"
          className={`min-w-0 flex-1 text-2xs wrap-anywhere ${error === null ? "text-muted" : "text-danger"}`}
        >
          {error !== null ? (
            error
          ) : busy ? (
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
 * Whether the strip draws a tile for a harness, which is two rules rather than
 * one: {@link startsBare} asks whether the harness is a whole answer by itself,
 * and {@link offersTile} asks whether it is in a state anything could be started
 * from. Neither implies the other — opencode is perfectly signed in and still has
 * no tile, and claude is a whole answer and still has none while it is signed out.
 *
 * Read through one function rather than at the four places that need it, because
 * the row, the default, a restored pick and the sign-in fallback all have to mean
 * the same thing by *offered*. Every time two of them have disagreed the result
 * was on screen: a tile drawn `aria-pressed` and `disabled` at once, or a `Start`
 * live over a row with nothing selected in it.
 *
 * ⚠ **The rule moved to `agents.ts` and the name stayed here.** It was a local
 * `function` for as long as this screen was the only one asking — and the moment
 * the Agents screen had to point at *the tile this row lands on by default*, that
 * was a fifth place needing the same meaning of "offered", in a different file.
 * A second copy is the shape the paragraph above is about, one module further
 * out. Bound rather than re-wrapped so that the four call sites below, and the
 * one thing this screen names itself by, read exactly as they did.
 *
 * ⚠ **A `const` where a `function` was, which is a real difference and a safe one
 * here.** A declaration was hoisted; a binding is not, so a call from module scope
 * above this line would now throw rather than work. Nothing calls it from module
 * scope — every reader is inside a component body, which React runs long after this
 * module is evaluated — and moving one out would be the change to think about.
 */
const shownHere = offersStripTile;

/**
 * Whether this screen has a sign-in to offer for an agent.
 *
 * The daemon's own reason (`no_flow`) rather than a boolean re-derived here, which
 * is how the strip's old status line came to disagree with the settings card about
 * the same agent on the same machine.
 *
 * Named because two places have to agree exactly: the block that draws the wizard,
 * and the fallback that decides which agent it is about. A fallback naming an agent
 * the block then declines to draw for is a screen with an empty row, no door and
 * nothing saying why — which is the state hiding signed-out tiles would otherwise
 * have created on a machine where nothing is signed in.
 */
function signInOffered(candidate: AgentInfo): boolean {
  return (
    candidate.login?.blocked !== "no_flow" && (!candidate.available || candidate.loggedIn === false)
  );
}

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
  /**
   * What the machine's strip has been told to leave out.
   *
   * ⚠ **Hidden is weighed here and not only in the row, and it is the fourth
   * member of the family this docblock lists.** Hiding an agent takes its tile
   * away; a pick of it restored past this point would be `Start` live over a row
   * where nothing is drawn as chosen. It is *not* an availability failure — the
   * daemon would start it perfectly well — which is exactly why it has to be
   * refused here rather than left to the tile's own `disabled`: there is no tile.
   *
   * Keyed strings rather than the entries, so this function stays a pure test over
   * a set and the merge stays in one place. Defaulted, because three of the four
   * call sites in `webcheck` predate the strip and the states they drive are
   * unchanged by it.
   */
  hidden: ReadonlySet<string> = new Set(),
): Picked | null {
  if (pick === null) return null;
  if (hidden.has(stripKey(pick.kind, pick.id))) return null;
  /*
   * ⚠ **Everything below the hidden test is `startableHere`, and it is one line
   * here because it is two functions away rather than because it got simpler.**
   * The four rules it holds — a harness has to be a whole answer on its own, it
   * has to be in a state the row draws, a preset's *harness* is weighed and not
   * only its row, and that harness has to be installed rather than signed in — are
   * every one of them a state that was once on this screen, and they are written
   * out where they live.
   *
   * ⚠ **The split falls exactly here because `hidden` is the half that is not
   * about startability at all.** A hidden agent is one the daemon would run
   * perfectly; it has no tile because somebody took it off this screen. So the
   * Agents screen — which draws hidden rows on purpose, since un-hiding is what
   * takes somebody there — asks the other function, and the two cannot answer
   * differently about anything else.
   */
  return startableHere(pick, agents, customAgents) ? pick : null;
}

/**
 * Every agent this machine can start **from a tile**, as a strip you drag
 * sideways. Not quite the same set as "every agent this machine can start": a
 * harness that is a router rather than a model has no tile, because the tile would
 * name no model — see `startsBare`, which is also what keeps a stored pick of one
 * from being restored onto a row that no longer draws it.
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
 * ⚠ **The order is the machine's, not this component's, and that is the newest
 * rule here.** The row used to be harnesses in `AGENT_IDS` order followed by
 * presets in `created_at` order, which is a listing rather than a preference —
 * there was no way to bring the one agent somebody always starts to the front, and
 * on a phone that is usually the one off the right edge. `orderStrip` merges the
 * daemon's stored order over the live listing, so what is drawn is what somebody
 * arranged, with anything the store has never heard of appended and visible.
 *
 * ⚠ **And what is drawn is a *subset* of what can be started.** A hidden entry has
 * no tile at all. It is not a refusal — the daemon would start it — which is why
 * it is weighed in `offeredHere` as well: a hidden pick would otherwise leave
 * `Start` live over a row where nothing is drawn as chosen.
 *
 * ⚠ **The last item inside the scroller is a gear, and it used to be a `+`.**
 * Where it sits was settled twice over and neither answer is being reopened: it
 * sat outside, pinned right, where it overlapped the last tile; then inside and
 * `sticky right-0`, where it paints at the scrollport's right edge at *every*
 * scroll position and therefore still read as pinned. It is an ordinary item you
 * scroll to. What changed is only what it *opens*: adding an agent is one thing
 * you do to this list among four, so the door leads to the screen that holds all
 * four rather than straight into the builder.
 *
 * **The cost, accepted.** Three harness tiles (opencode is not a starting point —
 * see `startsBare`) are 3 × 112 + 2 × 8 = **352px**, the gap and the button add 52,
 * and the window at 390px is 358 — so on a first run at that width the gear begins
 * two pixels past the edge and is one short drag away. Three things answer that
 * now where two did before: the wheel handler below, the scrollbar this strip
 * stopped hiding, and the fade at the right edge, which is the only one of the
 * three that says there is more *before* you touch anything.
 *
 * ⚠ **It is a 44px pill and *not* a tile, which is the same correction the
 * machine tabs already carry** — theirs takes the row's height and shape and not
 * an item's width, with the reason written out beside it. At 112px it ate the
 * strip's window: 390 − 32 of page padding − 112 − 8 leaves **238px**, and tiles
 * sit at 0–112 and 120–232, so the third begins at 240 and **six pixels** of it
 * are visible. Six pixels of ink is no cue that a row scrolls.
 *
 * Unavailable harnesses stay, disabled, saying why — `MachinePicker`'s rule
 * verbatim: filtering them out answers "where did claude go" with silence.
 *
 * ⚠ **`startsBare` is the one exception and it is a different question.** That
 * rule is about an agent this machine *cannot run*, where a missing tile hides a
 * fact somebody needs. This one runs perfectly and has no answer for **which
 * model** — and the control that does is the `+` at the end of the same row. A
 * disabled tile there would be a control you have to tap to learn is not one.
 *
 * ⚠ **Nothing here early-returns over the row any more, and the trailing control
 * is why.** "This machine reports no agents" used to be returned *above* the
 * strip, so a transient failure of the cheap `GET /agents` took the entry point to
 * the whole assembled-agent feature off the screen — and the inline sign-in with
 * it — while the daemon was perfectly willing. The sentence is a row inside the
 * strip now: the gear is drawn on exactly the condition it is about
 * (`canConfigure && machineId !== null`) and nothing upstream of it can decide
 * whether it exists.
 */
function AgentStrip({
  agents,
  customAgents,
  systems,
  stored,
  canConfigure,
  failure,
  presetsFailure,
  value,
  onChange,
  onConfigure,
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
  /**
   * The order and the hidden set this machine remembers.
   *
   * Not nullable, unlike `customAgents` above, and the asymmetry is honest: an
   * unread strip and one nobody has arranged draw the identical row, so there is
   * no second state for a `null` to name. What the *gear* needs to know is
   * `canConfigure`, which is a fact about the daemon rather than about this list.
   */
  stored: readonly AgentStripEntry[];
  /** Whether this daemon can hold an order at all. See `NewSession`. */
  canConfigure: boolean;
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
  /** Opens the machine's Agents screen — where this row is ordered, hidden from and added to. */
  onConfigure: () => void;
  machineId: MachineId | null;
  /**
   * Re-drives every read this row is drawn from — the harness listing, the
   * assembled agents, the systems table and the stored order. They are one
   * effect in `NewSession` and therefore one door.
   *
   * ⚠ **It was the inline sign-in's alone, and the retries below press the same
   * thing.** Nothing else on this screen re-sends a read: that effect depends on
   * the daemon client, which `store.daemonFor` keeps stable for the machine's
   * whole life, so a refusal stands for the life of the mount unless somebody
   * asks again through here.
   */
  onChanged: () => void;
}): ReactNode {
  const [signingIn, setSigningIn] = useState<string | null>(null);
  /*
   * ⚠ **The chosen tile is scrolled to, and assembling one is why.** The strip
   * overflows at **three** tiles on a 390px phone, and a new agent lands at the end
   * of it — so `Add agent` selected something nobody could see and left the row
   * looking unchanged. Re-measured after the `+` was narrowed: 3 tiles are
   * 3 × 112 + 2 × 8 = 352px in a 306px box. (It said 408px in 294px, which was
   * neither the tile count nor either width — the box was 238px at the time.)
   *
   * `block: "nearest"` and `inline: "nearest"` so it moves only when the tile is
   * actually out of view: re-selecting something already on screen must not drag
   * the row under a thumb. Keyed on the value, so a poll cannot re-fire it.
   */
  const chosen = useRef<HTMLButtonElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  /**
   * The gradient at the right edge, and it is a ref for `layout`'s reason.
   *
   * ⚠ **It says the row is cut, which is the one thing the rail under it cannot.**
   * That bar reports a *position* and fades out a second after you stop moving, so
   * on a screen nobody has touched — which is every first paint — there is nothing
   * at all saying the row continues past the edge. The tiles do not say it either:
   * the last item is a fully drawn dashed box, which reads as the row's deliberate
   * end, and that is exactly why `.no-scrollbar` was taken off this strip in the
   * first place ("a half-cut pill still says more"; a whole one does not).
   */
  const fade = useRef<HTMLDivElement | null>(null);
  const thumb = useRef<HTMLDivElement | null>(null);
  /*
   * ⚠ **A wheel moves this row, because on a desktop nothing else does.**
   * Reported three times as "it does not scroll with a mouse". The layout was never
   * the problem — the box overflows and is scrollable — but a mouse has no gesture
   * for a horizontal one: there is no drag on a scroll container, the row cannot
   * take focus (Chrome's keyboard-focusable-scroller feature excludes a container
   * holding focusable children, and these are `<button>`s), and shift+wheel works
   * and is known to nobody. The bar below the row is a cue rather than a way to
   * move it a notch at a time — and it is the app's own now, on every pointer,
   * because a browser's could not be made to fade (see `index.css`).
   *
   * ⚠ **`addEventListener` and not `onWheel`.** React attaches its wheel listener
   * **passive**, so `preventDefault` inside a JSX handler is swallowed with a
   * console warning and the page scrolls anyway. `{ passive: false }` here is the
   * whole reason this is an effect rather than a prop.
   *
   * ⚠ **And it hands the gesture back at both ends rather than trapping it.** The
   * strip consumes a notch only when it can actually absorb one in that direction;
   * at either end `preventDefault` is never called, so the page goes on scrolling
   * under a cursor that happens to be over a 64px strip. A horizontal gesture
   * (`deltaX`) is left alone entirely — a trackpad already does the right thing
   * with it, and re-handling it would double every swipe.
   */
  useEffect(() => {
    const box = track.current;
    const bar = thumb.current;
    const edge = fade.current;
    if (box === null || bar === null || edge === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      const room = box.scrollWidth - box.clientWidth;
      if (room <= 0) return;
      /*
       * Firefox reports lines rather than pixels, and a page delta exists too.
       * `16` is a line at this app's base size; the page arm is the box itself,
       * which is what "a page" means for a horizontal strip.
       */
      const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientWidth : 1;
      const next = Math.min(room, Math.max(0, box.scrollLeft + event.deltaY * step));
      if (next === box.scrollLeft) return;
      event.preventDefault();
      box.scrollLeft = next;
    };
    /*
     * ⚠ **The bar under this row is the app's own, and it is drawn from here.**
     * The browser's is hidden — `index.css` measures why a styled one cannot be
     * made to fade in this app at all — so the geometry a scrollbar normally gets
     * for free is arithmetic: the thumb takes the same fraction of the rail that
     * the visible strip takes of the whole row, floored at `MIN_THUMB_PX` so a row
     * of thirty tiles still leaves something to see, and it travels the leftover
     * width in step with `scrollLeft`.
     *
     * `room <= 0` is the row that fits, and it answers with a **zero-width** thumb
     * rather than a hidden rail: there is nothing to say about a strip that does
     * not scroll, and the rail keeps its own height either way, so the screen is
     * not a few pixels shorter on a machine with two agents than on one with five.
     *
     * A class and two inline styles on the node rather than React state: this
     * fires on every frame of a flick, and re-rendering the whole strip for it
     * would be a scroll handler that costs a render per frame.
     */
    const layout = (): void => {
      const rail = box.clientWidth;
      const room = box.scrollWidth - rail;
      /*
       * ⚠ **The fade is toggled here rather than in a second handler**, because
       * this function already holds all three numbers and runs on exactly the two
       * events that can change the answer — a scroll and a resize. A separate
       * `onScroll` reading the same box would be the same arithmetic twice, and the
       * failure of that shape is silent: the two disagree for one frame and the
       * gradient blinks at the end of every flick.
       *
       * The one-pixel slack is not decoration. `scrollWidth`, `clientWidth` and
       * `scrollLeft` are integers rounded from fractional layout, so a strip
       * scrolled fully to its end routinely reports a remainder of 1 — and without
       * the slack the gradient stays on at the end of the row, saying there is more
       * where there is nothing. It is the opposite call from `scrolledDown` in
       * `SessionView`, which takes no slack at all and says why: there the question
       * is "is a line cut off by the header", and one pixel of scroll is already
       * one cut line.
       *
       * `rail > 0` is the un-laid-out box, which the `ResizeObserver` really does
       * report: with a `clientWidth` of 0 the remainder is the whole row and the
       * arithmetic would say "cut" about a box that has not been measured. Nothing
       * would be *drawn* — a zero-height parent gives the fade no height either —
       * but a class asserting something false about the first frame is a class the
       * next reader has to reason about.
       */
      edge.classList.toggle("is-cut", rail > 0 && box.scrollLeft < room - 1);
      if (room <= 0 || rail === 0) {
        bar.style.width = "0px";
        bar.classList.remove("is-scrolling");
        return;
      }
      const width = Math.max(MIN_THUMB_PX, Math.round((rail * rail) / box.scrollWidth));
      bar.style.width = `${width}px`;
      bar.style.transform = `translateX(${Math.round(((rail - width) * box.scrollLeft) / room)}px)`;
    };
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onScroll = (): void => {
      layout();
      bar.classList.add("is-scrolling");
      clearTimeout(idle);
      idle = setTimeout(() => bar.classList.remove("is-scrolling"), SCROLLBAR_FADE_MS);
    };
    /*
     * ⚠ **Both boxes are watched, because either one moving changes the answer.**
     * The scrollport's width is the window's, and the row's is however many agents
     * this machine reported — which lands a round trip *after* this effect runs, so
     * observing only the scrollport would leave a thumb sized for an empty row and
     * nothing to re-measure it. `ResizeObserver` fires once on `observe`, which is
     * also where the first layout comes from.
     */
    const sizes = new ResizeObserver(layout);
    sizes.observe(box);
    const row = box.firstElementChild;
    if (row !== null) sizes.observe(row);
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(idle);
      sizes.disconnect();
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("scroll", onScroll);
    };
  }, []);
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
   * machine's only way forward is this block, since there is no tile to tap to
   * reach a sign-in. So the door hangs off the first row with nothing claiming to
   * be chosen. Narrowed to exactly that state: with something startable on the
   * machine, a `null` selection means a *preset* went away, and offering a CLI
   * login for that answers the wrong question.
   *
   * ⚠ **Both halves of it moved when signed-out tiles stopped being drawn**, and
   * they had to move together. The condition is now "no tile at all" rather than
   * "nothing installed" — a machine whose only harness is installed and signed out
   * draws an empty row, which the old test called *startable* — and the fallback
   * picks the first agent this screen has a sign-in **for** rather than the first
   * one listed, so the door cannot land on an agent `signInOffered` then refuses to
   * draw the wizard for. `agents[0]` survives as the tail of that chain and is now
   * only reachable when nothing can be signed in at all, where the block below
   * draws nothing and the row's `+` is the answer.
   */
  const harness =
    value?.kind === "harness"
      ? (agents.find((candidate) => candidate.id === value.id) ?? null)
      : value === null && !agents.some(shownHere)
        ? (agents.find(signInOffered) ?? agents[0] ?? null)
        : null;
  const presets = customAgents ?? [];
  /*
   * The harnesses this row actually draws — see `shownHere`. Resolved once,
   * because the row is drawn from it and the "nothing here" line below is decided
   * by it, and those two disagreeing is a screen that says a machine is empty over
   * a row of tiles.
   */
  const shown = agents.filter(shownHere);
  /**
   * The row, in the order this machine remembers.
   *
   * ⚠ **`shownHere` decides membership and the stored strip decides only order
   * and hiding**, which is `orderStrip`'s own rule and the one that keeps this
   * from drawing a tile for something that cannot be started. So a harness that is
   * signed out is absent because it has no tile, not because anybody hid it — and
   * it keeps its stored position for when it comes back.
   *
   * Two lists in, one out, and the two kinds are told apart by `kind` from here
   * down. It used to be two `.map`s in sequence, which is the same thing written
   * as an order nobody could change.
   */
  const rows = orderStrip(
    [
      ...shown.map((one) => ({ kind: "harness" as const, id: one.id })),
      ...presets.map((one) => ({ kind: "custom" as const, id: one.id })),
    ],
    stored,
  );
  /**
   * What is left after the hidden entries, which is what is drawn.
   *
   * ⚠ **Kept apart from `rows`, because "nothing is offered" and "everything is
   * hidden" are two sentences below and telling them apart needs both counts.**
   * One list would make a machine with four hidden agents say it reports none,
   * pointing somebody at a sign-in screen for a problem one tap away in the other
   * direction.
   */
  const drawn = rows.filter((row) => !row.hidden);
  /*
   * ⚠ **Said only once the second read has settled.** With `customAgents`
   * flattened to `[]` while it was still out, a fast `GET /agents` answering
   * nothing put "This machine reports no agents" on screen over a listing that
   * was on its way — and it is drawn *below* the row rather than instead of it,
   * so the `+` survives whatever either read did.
   */
  const nothingAtAll = shown.length === 0 && presets.length === 0 && customAgents !== null;

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
        {/*
          ⚠ **The line is reserved, and an empty string does not reserve it.** A
          harness tile has nothing on this row and a preset always has something,
          so the two kinds sit side by side with a different number of *lines* —
          and the row is `items-stretch` while each tile is `justify-center`, so
          the shorter content column is centred inside the taller box. Measured
          against the built stylesheet in a headless browser: an empty `<span>`
          generates no line box and is 0px tall, and the harness tile's glyph and
          name each landed **9px** below the preset's beside it — exactly the
          drift rendering the span was supposed to prevent, since a zero-height
          third child buys back only the 4px `gap-1`.

          `min-h` on the span rather than `justify-start` on the tile: the
          centring is deliberate and shared with the picked/disabled treatments,
          and this holds the slot at the height the text would have had. Keyed to
          the same token `text-2xs` sets its line-height from, so the two cannot
          drift apart. */}
        <span className="min-h-[var(--text-2xs--line-height)] w-full truncate text-2xs text-faint">
          {subline}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-2">
      {/* Two children — the row and the bar the app draws under it — so the
          wrapper is a plain block rather than the flex row that used to stretch a
          sibling `+` to the tiles' height. The trailing button sets its own
          `min-h-16`.

          It stays a plain block now that there is a fade as well: that one hangs
          off a positioned box around the *track alone*, one level in, so it cannot
          reach over the bar. */}
      <div>
        {/*
          * ⚠ **`no-scrollbar` was here, then was not, and the class this carries
          * now does the same job with the app's own pixels in place of the
          * browser's.** That class is for a strip "whose contents announce there is
          * more of them by being cut off at the edge" — true while the last thing
          * in the row was half a tile, and false the moment it is a fully drawn
          * dashed box that reads as the row's deliberate end. So the bar came back;
          * then it was a permanent dark rule under a row of tiles; then a native
          * one that would not fade. `fade-scrollbar` hides the browser's bar and
          * the rail below draws ours, which is the only shape that both says the
          * row can move and gets out of the way when it is not moving.
          *
          * The machine tabs in `SessionBrowser` keep `.no-scrollbar` for exactly
          * the reason this one lost it: a half-cut pill still says "more".
          */}
        {/*
         * ⚠ **A positioned box around the track alone, and not around the wrapper
         * above.** The wrapper holds the row *and* the rail beneath it, so an
         * `inset-y-0` fade hung off it would paint over the scrollbar as well —
         * and the wrapper is a plain block on purpose, for the reason stated
         * where it is. This adds a containing block and nothing else: it has no
         * padding, no margin and no height of its own.
         */}
        <div className="relative">
          <div ref={track} className="fade-scrollbar overflow-x-auto">
            <div className="flex w-max gap-2">
              {drawn.map((row) => {
                /*
                 * ⚠ **One `.map` over an ordered list, where this was two in
                 * sequence.** Harnesses then presets was an order nobody could
                 * change written as a shape nobody could change — the two lists went
                 * through `tile()` separately, so "the harnesses come first" was not
                 * a rule anywhere, it was the order of two JSX children. `orderStrip`
                 * decides it now and this branches on `kind`, which is the same two
                 * tiles with the sequencing taken out of the markup.
                 */
                if (row.kind === "harness") {
                  const candidate = shown.find((one) => one.id === row.id);
                  // Cannot happen — `drawn` is built from `shown` — and it is a
                  // `find` rather than a cast for `MachineAgentsSection`'s reason:
                  // this file may not promise on `orderStrip`'s behalf that a row it
                  // emitted is in the list it was given.
                  if (candidate === undefined) return null;
                  /* No `label`: the visible text is the whole of what this tile says
                     — the harness's name — and the glyph repeats it. No `hint`
                     either, since a fixed three-word label in a 112px tile cannot be
                     cut.

                     ⚠ **That claim was false for one day and the tile was 128px wide
                     for it.** A fifth status, `no sign-in needed`, is 7.95em of
                     advance; at `--text-2xs` (0.75rem) that is 5.96rem against a
                     content box of 112px − 20 of `p-2.5` − 2 of border = **5.625rem**,
                     both sides in rem, so it always clipped. The width came back the
                     moment that badge did. There is no status line at all now, which
                     is the end of a measurement this strip paid for twice (Q7.119). */
                  return tile({
                    // `stripKey` and not the bare id: this is one array now, and
                    // the whole argument for that key is that a harness and an
                    // assembled agent sharing an id must not collapse into one row.
                    // Applying it everywhere but the JSX key would leave out the one
                    // place React actually reads.
                    key: stripKey("harness", candidate.id),
                    /* Against `value` and never against the resolved `harness`, which
                       carries the sign-in door's fallback and would draw a tile as
                       chosen on a machine where nothing can be. */
                    picked: value?.kind === "harness" && candidate.id === value.id,
                    /* ⚠ **Structurally false, and kept.** `shownHere` filters out an
                       uninstalled harness before the row is built, so nothing here can
                       be drawn disabled any more. It stays because the tile's own
                       refusal must not depend on which list happened to build it —
                       this is the state that shipped once, `aria-pressed` and
                       `disabled` at the same time, and the assertion that it cannot
                       recur is `offeredHere`'s rather than this row's. */
                    disabled: !candidate.available,
                    onClick: () => onChange({ kind: "harness", id: candidate.id }),
                    glyph: <AgentGlyph agent={candidate.id} size={18} />,
                    title: harnessName(candidate),
                    /* ⚠ **The vendor, where this was a status and then was empty.**
                       It carried `agentCard`'s badge and printed `signed in` on every
                       tile — `shownHere` draws a tile only for an agent something can
                       be started on, so that is the only word it could ever say, and a
                       fact true of every tile in the row tells the reader nothing. It
                       was reported as noise and it was. The line then went blank,
                       which is a reserved slot saying nothing at all, and it was
                       reported again.

                       What belongs there is the fact the preset tiles beside it
                       already carry: **which system serves the model**. Claude Code is
                       Anthropic, Codex is OpenAI, Kimi Code is Moonshot. Read off
                       `GET /systems` through `harnessSubline`, so the name is the
                       daemon's rather than a fourth copy of a vendor table.

                       ⚠ **The line is still reserved and may still be empty**, and
                       the span holds its own height either way. These tiles are
                       `items-stretch` and `justify-center`: a tile with fewer lines
                       than its neighbour has them centred inside the taller box,
                       putting its *name* on a different baseline from every preset
                       beside it. Rendering the span is not enough — an empty one
                       generates no line box and is 0px tall, measured — so the height
                       is held by `min-h` on the span itself. See the tile.

                       ⚠ **It fits, which the badge it replaced did not.** Q7.119
                       measured a fifth status at 7.95em of advance against a
                       5.625rem content box, and the tile was 128px wide for a day
                       because of it. The vendor names that can appear here —
                       Anthropic, OpenAI, Moonshot — are all under 5em at
                       `--text-2xs`. */
                    subline: harnessSubline(candidate.id, systems, candidate.contributedBy),
                  });
                }
                const one = presets.find((preset) => preset.id === row.id);
                if (one === undefined) return null;
                /*
                 * ⚠ **A preset is only as startable as the harness under it**, and
                 * this tile drew pressable regardless — so a machine without
                 * `claude` showed a greyed "Claude Code · not installed" tile beside
                 * an enabled preset carrying the same glyph, and `Start` posted it
                 * for a 503. The harness tiles above have always passed
                 * `disabled: !candidate.available`; this is that same fact, reached
                 * through the preset's own `harness`. `offeredHere` folds it in too,
                 * so a stale pick clears rather than being posted.
                 */
                const runs = agents.find((candidate) => candidate.id === one.harness) ?? null;
                const missing = runs === null || !runs.available;
                // The harness's own name, from the listing where there is one — a
                // preset whose harness came from a plugin has a namespaced id, and
                // `harnessName` is where the label lives.
                const ranBy = harnessName(runs ?? { id: one.harness });
                const where = customAgentSubline(one, systems);
                return tile({
                  key: stripKey("custom", one.id),
                  picked: value?.kind === "custom" && one.id === value.id,
                  disabled: missing,
                  onClick: () => onChange({ kind: "custom", id: one.id }),
                  glyph: <AgentGlyph agent={one.harness} size={18} />,
                  title: one.name,
                  // The reason displaces the system, for the same rule the harness
                  // tiles' status line follows: a tile that cannot be pressed says why
                  // on the one line it has, rather than describing a pairing nothing
                  // can run.
                  subline: missing ? `${ranBy} not installed` : where,
                  /*
                   * ⚠ **All three facts, because one of them is a glyph and
                   * `AgentGlyph` draws its svg `aria-hidden`.** Read out, this tile
                   * said its name and its system and left the *harness* off — the
                   * one fact assembling an agent exists to make choosable. The
                   * visible name comes first, so voice control's "click <name>"
                   * still lands on it.
                   */
                  label: missing
                    ? `${one.name}, ${ranBy} not installed`
                    : `${one.name}, ${ranBy}, ${where}`,
                  /*
                   * ⚠ **The tooltip is kept, and it is the name and nothing else.**
                   * `AgentBuilder`'s `Supports` docblock measured what `title` is
                   * worth — about a second of delay, unstyleable, reported as simply
                   * not appearing — and it does not exist on touch at all, which is
                   * why it may never be how a tile says something. It earns its place
                   * on exactly the one value here that gets cut: 12px in a 112px tile
                   * truncates at 90px against a bound of 80 characters, so a preset
                   * named after a long model id is unreadable on screen and there is
                   * no other pointer affordance for it. Everything the tooltip cannot
                   * carry is in `aria-label` above, and the Agents screen the gear
                   * opens shows the name in full on every device.
                   */
                  hint: one.name,
                });
              })}
              {canConfigure && machineId !== null && (
                <button
                  type="button"
                  onClick={onConfigure}
                  aria-label="Agent settings"
                  /* ⚠ **An ordinary item, and every attempt to make it cleverer has
                     been rejected by the person asking for it.** It was pinned
                     outside the scroller; then it was moved inside and made
                     `sticky right-0`, which paints at the scrollport's right edge and
                     therefore still *looks* pinned — which was the complaint, stated
                     a third time. It is the row's last item now and you scroll to it,
                     which is what was asked for in those words.

                     ⚠ **It was a `+` and it is a gear, and only the destination
                     changed.** Adding an agent turned out to be one of four things
                     somebody does to this list — the others are ordering it, hiding
                     from it and editing a row — so a door straight into the builder
                     was the narrowest of the four wearing the shape of all of them.
                     The `+` is on the screen this opens, at the foot of the list it
                     adds to.

                     The row's height and shape, dashed — and **not** an item's width.
                     44px is `BUTTON_SIZE`'s floor, so the target is untouched.

                     Bounded either way: dashed or not, this border is the whole of
                     what says the control is there, which is what `edge-strong` is
                     held at ≥3:1 for and what `edge` may never be used as. */
                  className="tap press flex min-h-16 w-11 shrink-0 flex-col items-center justify-center rounded-lg border border-dashed border-edge-strong bg-surface text-muted hover:bg-raised hover:text-fg"
                >
                  <Icon as={Settings2} size={18} />
                </button>
              )}
            </div>
          </div>
          {/*
           * ⚠ **A sibling of the scroller and never a `mask-image` on it**, which
           * is the transcript's own answer at the top of a conversation, written
           * down there: a mask on a scroll container applies to the scrollbar too.
           * Here that would be this app's own bar, one sibling down.
           *
           * `pointer-events-none` is load-bearing rather than tidy: this covers the
           * right 40px of the row, which is where the gear is when the strip is
           * scrolled anywhere but its end.
           *
           * Two stops and no middle one, and 70% rather than opaque — both copied
           * from the transcript's fade with its measurement intact. A middle stop
           * is a kink the eye catches, which is the hard edge this exists to
           * avoid, moved inwards; and an opaque band would delete the tile under
           * it rather than saying there is one.
           *
           * `aria-hidden="true"` in full rather than the bare attribute the rail
           * below uses. They are the same value to a browser and not to
           * `webcheck`, which slices this component by the literal text of that
           * rail's opening tag — so writing them alike would make a fade the anchor
           * for every assertion about the scrollbar.
           */}
          <div
            ref={fade}
            aria-hidden="true"
            className="edge-fade pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-surface/70 to-transparent"
          />
        </div>
        {/*
         * The bar, and it is `aria-hidden` and untouchable on purpose: it reports
         * a position rather than offering one. A native scrollbar can be dragged
         * and this cannot, so it must not look like it can — `pointer-events-none`
         * is what keeps a press from landing on a thing that would do nothing.
         * The row itself is reachable with a wheel, a trackpad, a finger and, for
         * a keyboard, the tiles' own focus ring scrolling them into view.
         *
         * The rail's height is unconditional; only the thumb inside it changes.
         */}
        <div aria-hidden className="pointer-events-none mt-1 h-1">
          <div ref={thumb} className="fade-thumb h-full w-0 rounded-full bg-edge-strong" />
        </div>
      </div>

      {/* Below the row rather than instead of it — see the note on the early
          return this replaced. `failure` is the whole point: a read that failed
          is not a machine with nothing on it, and the reason was otherwise only
          on the screen behind this one. */}
      {/*
       * ⚠ **Three sentences, because an empty row now has three causes.** It used
       * to have one: the daemon listed nothing. Since a harness that is not signed
       * in has no tile, a machine can list three agents and draw none of them —
       * and "this machine reports no agents" over a machine that reported three is
       * the kind of false line that sends somebody to the wrong screen. The third
       * arrived with the strip: everything this machine offers can be *hidden*,
       * which is a row somebody chose and the one cause with a one-tap remedy. It
       * is asked **first**, because it is the only one of the three that is true
       * of a machine with nothing wrong with it, and the sentence names the gear
       * rather than a screen — the control is at the end of the row directly
       * above.
       *
       * What is *not* said in the second — a machine that listed agents and can
       * draw none of them — is which agent or why: the sign-in door below is drawn
       * in exactly that state and says both, and repeating it here would be two
       * answers to one question.
       *
       * ⚠ **The first has no such door, which is why it is the one that ended up
       * carrying a control.** That door hangs off a harness
       * (`agents.find(signInOffered) ?? agents[0]`), and the whole of what "reports
       * no agents" says is that there were none to resolve it from — so it is
       * `null`, the block below draws nothing, and for as long as that sentence
       * stood alone it was a screen stating a fact with nowhere to go from it.
       */}
      {drawn.length === 0 && rows.length > 0 && (
        <Empty>Every agent on this machine is hidden. The gear above is where to bring one back.</Empty>
      )}
      {nothingAtAll && failure === null && (
        <Empty
          /*
           * ⚠ **The door belongs to the empty-listing arm only.** The other one is
           * drawn in exactly the state the sign-in block below is drawn in, and that
           * block names the agent and says why — so a control here would be the
           * two-answers-to-one-question the paragraph above already refuses.
           *
           * **"Check again" and not "Try again": nothing failed.** The daemon
           * answered, and what it answered was nothing — this is a re-ask, and the
           * thing that makes it worth pressing happens on the host rather than
           * here. No `failed`, for the same reason: an empty listing is a settled
           * answer, and dressing it as an event would send somebody hunting for a
           * fault this screen has no evidence of.
           */
          action={agents.length === 0 ? <Button onClick={onChanged}>Check again</Button> : undefined}
        >
          {/* ⚠ **Both sentences stay string literals rather than becoming JSX
              text**, for the reason the fade above writes `aria-hidden="true"` in
              full: `webcheck` tells these two states apart by the quoted strings
              and by nothing else — neither is a value any function on this screen
              returns — so a rewrite that drops the quotes takes the assertion with
              it and says nothing while doing so. */}
          {agents.length === 0 ? (
            <>
              {"This machine reports no agents."} That list is the host's, and every
              harness on it is a CLI installed there — so this is a machine to go
              and look at rather than a screen to fix.
            </>
          ) : harness !== null && signInOffered(harness) ? (
            "No agent on this machine is ready to start."
          ) : (
            /*
             * ⚠ **The same state, with the door taken away — and the sentence has
             * to carry it.** The arm above is bare because the sign-in block below
             * is drawn in exactly that state and names the agent and the remedy.
             * That block hangs off `signInOffered`, which answers `false` for every
             * harness with no wizard — and those are precisely the harnesses that
             * can be hidden by `start_refused`, since a harness that refused and
             * *has* a wizard is `signed_out`-shaped and reaches the arm above. So
             * on a machine whose only harness a plugin added, this used to be one
             * sentence with nothing under it and nowhere to go.
             *
             * The gear, for the hidden arm's reason: it is at the end of the row
             * directly above, and the list behind it keeps the row this screen has
             * stopped drawing, with the badge saying what happened and the control
             * that asks again.
             */
            <>
              {"No agent on this machine is ready to start."}{" "}
              {/*
               * ⚠ **And the gear is only worth naming for what it will actually
               * show.** That screen lists harnesses `startsBare` answers true for
               * and nothing else — opencode, and any a plugin added without
               * one a plugin added, have no row there at all — so on a machine holding
               * only those, "lists them all" pointed at a screen that would draw
               * *This machine reports no agents*: two screens answering one
               * question, one of them wrong. The bar at its foot is drawn either
               * way, which is what the second arm names instead.
               */}
              {agents.some(startsBare)
                ? "The gear above lists them all, with what each one said."
                : "The gear above is where to add one."}
            </>
          )}
        </Empty>
      )}
      {/*
        * ⚠ **Unconditional, where it used to ride inside `nothingAtAll`.** That
        * predicate also requires `presets.length === 0`, so on any machine holding
        * one assembled agent a failed `GET /agents` said nothing at all: the strip
        * simply lost its harness tiles. "A failed read is not an empty machine" is
        * the rule, and the sibling row below has always been drawn this way — the
        * two reads are separate, so their failures are separate rows.
        *
        * ⚠ **And each says what to do about it, which for a whole release it did
        * not.** A sentence naming a read that failed, with no control beside it, is
        * a dead end on this screen in the strongest sense: the effect that sent the
        * request depends on the daemon client and nothing else, and that client
        * lives as long as the machine does — so the strip stayed empty, and said
        * why, until somebody closed the pop-up and opened it again.
        *
        * ⚠ **One epoch drives all four reads, so either button re-sends both
        * rows' requests.** That is honest rather than lazy: the failures are two
        * rows because the reads are two requests, but they are sent by one effect
        * and there is nothing finer to aim a retry at. The cost is one extra `GET`
        * in the case where only one of them failed; the alternative is a button
        * whose promise is narrower than what it does.
        */}
      {failure !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-2xs text-muted wrap-anywhere">
            The agents installed on this machine could not be read. {failure}
          </p>
          <Button onClick={onChanged}>Try again</Button>
        </div>
      )}
      {presetsFailure !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-2xs text-muted wrap-anywhere">
            The agents assembled on this machine could not be read. {presetsFailure}
          </p>
          <Button onClick={onChanged}>Try again</Button>
        </div>
      )}

      {/*
       * ⚠ **There is no Edit control here any more, and its absence is the
       * decision rather than a deletion.** It was one control about the chosen
       * tile, hanging under the strip — the shape the sign-in block below still
       * has — and the argument for it was that a kebab *on* a 112px tile inside a
       * strip you drag sideways puts a target on another target's face. That
       * argument is unchanged and this is not a reversal of it: editing moved to a
       * row on the Agents screen, where the tile it is about is a full-width row
       * with room for a kebab and nothing to mis-tap.
       *
       * What it cost was a line under the picker that appeared and disappeared as
       * you tapped along the row, moving the folder picker and the footer with it
       * — on the one screen where what is below the strip is what you came to
       * choose. The gear is in the layout unconditionally; that control never was.
       */}

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
      {/* ⚠ **And never for an agent with nothing to sign in to** — see
          `signInOffered`, which is where that test lives now. It was written out
          here and the fallback above tested something subtly different, which is
          exactly the pair that had to stop drifting: the two states this block
          draws are reachable for opencode in one way only (not installed), and the
          panel that opened for it held one true sentence and no controls, under a
          button offering a sign-in that does not exist. */}
      {harness !== null && signInOffered(harness) && machineId !== null && (
        <div>
          <button
            type="button"
            onClick={() => setSigningIn(signingIn === harness.id ? null : harness.id)}
            aria-expanded={signingIn === harness.id}
            className="tap press -my-2 inline-flex min-h-11 items-center gap-1 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg"
          >
            <Icon as={LogIn} size={12} />
            {signingIn === harness.id ? "Hide sign-in" : `Sign in to ${harnessName(harness)}`}
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
  /**
   * Bumped by the retry beside the failure below, and it is the only thing in
   * this component that re-requests anything.
   *
   * ⚠ **Neither read is re-sent by anything that a refusal changes.** The roots
   * effect depends on the daemon client alone — stable for the machine's whole
   * life, by `store.daemonFor` — and the listing effect adds `path`, which a
   * failed listing does not move. So one refused `GET /fs/roots` was the end of
   * this picker for the life of the mount: no root, therefore no crumbs,
   * therefore no way to walk anywhere and nothing that would ask again.
   *
   * A counter in both dependency lists is the same shape `NewSession` uses one
   * component up, where `agentsEpoch` re-drives its listing.
   */
  const [attempt, setAttempt] = useState(0);
  // The dependency rather than a lookup inside each effect, for the reason given
  // where `NewSession` resolves its own: an effect that returns before its
  // request has nothing to bring it back.
  const daemon = store.daemonFor(id);

  useEffect(() => {
    if (daemon === undefined) return;
    /*
     * ⚠ **A cancel flag and a cleared error, neither of which this effect needed
     * while it could only run once.** With `attempt` in the dependencies it can
     * run again over a request that is still out, and the two costs are separate:
     * an older answer landing last restores the failure a retry has just cleared,
     * and an error left on screen for the length of the retry says the thing being
     * retried has already failed again. The two sibling effects in this file
     * carry the flag for the first reason and are the precedent for it.
     */
    let cancelled = false;
    setError(null);
    void daemon
      .roots()
      .then((result) => {
        if (cancelled) return;
        const first = result.roots[0] ?? null;
        setRoot(first);
        // `result.recent` is read by nothing now — see the note where the strip
        // it fed used to be drawn.
        // Start at the top of their own tree rather than at nothing. There is
        // exactly one root — a tenant's own directory — so a "pick a root" step
        // would be a list of one.
        setPath((current) => current ?? first);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, attempt]);

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
    // `attempt` for the roots read's reason, and it costs nothing here: this
    // effect already re-runs whenever `path` moves, so the counter only adds the
    // one case `path` cannot express — the same folder, asked for again.
  }, [daemon, path, attempt]);

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
          /*
           * ⚠ **A read that failed used to sit here reading `loading…` for ever.**
           * `crumbs` is empty until `root` lands, `root` is written only in the
           * roots read's `.then`, and nothing re-requested — so a refusal left this
           * bar making a claim about a request that had already ended, on the one
           * control this screen exists to drive. Every state below it agrees
           * already: the folder list draws its own "Loading…" only while `error` is
           * null.
           *
           * What this arm owes is only that it stops saying "loading". The reason
           * itself is one row down, beside the retry that can change it, because a
           * sentence and the button that acts on it are one object.
           *
           * No `font-mono` on it, unlike the arm beside it and every crumb below:
           * that family is here because those are paths, and this is a sentence
           * about one there is no path for.
           */
          error === null ? (
            <span className="font-mono text-2xs text-muted">loading…</span>
          ) : (
            <span className="text-2xs text-muted">could not be read</span>
          )
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
      {/*
       * ⚠ **The reason and the way out are one object**, which is the whole of
       * this row: a failure with nothing beside it is where this picker dead-ended,
       * since neither read is re-sent by anything a refusal moves — see `attempt`.
       *
       * ⚠ **One button for both reads, and it is drawn for either failure.** This
       * line is the roots read's and the listing read's alike, because two error
       * lines is the row that appears and disappears inside a control that has to
       * hold still — the objection the "recent" strip above was deleted for. So
       * the retry re-drives both, which is exactly what it says it does.
       *
       * Not `tone="primary"`: `bg-fg` is the affirmative action inside a decision
       * and on this screen that is `Start`, one box down — the same rule the two
       * controls at the foot of this panel already keep.
       */}
      {error !== null && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-danger wrap-anywhere">{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      )}

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
