import { useRef, useState, useEffect, type ReactNode } from "react";
import { AlertTriangle, ChevronRight, MoreHorizontal, Trash2, Upload } from "lucide-react";
import { consentBroken, MACHINE_GONE, pluginFailure, pluginPath, pluginStateText } from "../../plugins";
import { peekPluginArchive, type ArchivePeek, type ManifestPreview } from "../../pluginArchive";
import { PLUGIN_ARCHIVE_ACCEPT, PluginArchiveNote, PluginConsent, PluginUnreadable } from "../PluginConsent";
import type { MachineId } from "../../ids";
import { marketEntryPath } from "../../market";
import { navigate } from "../../router";
import { store } from "../../store";
import type { PluginSummary } from "../../wire";
import {
  Button,
  DangerButton,
  Empty,
  Icon,
  IconButton,
  Menu,
  RowAction,
  SETTINGS_HEADING,
  Spinner,
} from "../bits";
import { toast } from "../Toast";

/**
 * What is installed on one machine, and handing that machine a file.
 *
 * ⚠ **One depth, and the leaf that used to sit under it is gone.** This was
 * `AgentsPanel`'s shape beside it — a list, and one screen per named plugin
 * holding that plugin's own settings — on the argument that a plugin's code is on
 * one host's disk and its data in one daemon's database, so a fleet-wide screen
 * would have to open by asking which machine. That argument was **answered rather
 * than reversed**: the plugin's own page already knows which machines it is on, so
 * it asks over *those* and does not ask where there is one. What was here was six
 * taps behind a kebab and nobody found it.
 *
 * So every row below is a link to the plugin's page, and what stays is only what
 * cannot be anywhere else: which plugins this daemon has, whether each is switched
 * on, what a failed one said, and the picker at the foot.
 */

function usePlugins(machineId: MachineId): {
  plugins: PluginSummary[] | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * ⚠ **A re-read in flight, which nothing tracked at all.** Every toggle and
   * every removal on this screen calls `refresh`, and until the answer landed
   * there was nothing on screen saying one had been asked for — so a "Check
   * again" beside a failure could be pressed twice with no evidence the first
   * press had done anything, which is the shape of the defect this whole section
   * exists to remove.
   */
  const [loading, setLoading] = useState(true);

  const refresh = (): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      /*
       * ⚠ **Not "not reachable right now", which is what both guards on this
       * screen said.** `store.daemonFor` answers `undefined` only where the
       * machine is absent from the listing — `daemons` and `connections` are
       * written and dropped together — so this is a grant revoked in another tab
       * or a machine retired, and waking the host does not touch it. An
       * *unreachable* machine keeps its client and says so through `machine.reach`.
       * {@link MACHINE_GONE} is the argument in full, and the reason this is a
       * constant rather than the string that used to be typed here.
       */
      setError(MACHINE_GONE);
      // Nothing was sent, so nothing is in flight: without this the initial
      // `true` never comes down and the control that would ask again is disabled
      // for as long as the screen is open, on the one path where asking again is
      // the whole remedy.
      setLoading(false);
      return;
    }
    setLoading(true);
    void daemon
      .plugins()
      .then((listing) => {
        setPlugins(listing.plugins);
        setError(null);
        // The launcher in the rail and a session's menu read the store's copy, so
        // installing something here has to move all three. Not the other way round
        // — this screen keeps its own so that a failure is drawn *on it* rather
        // than becoming a machine that silently has no plugins.
        store.refreshPlugins(machineId);
      })
      .catch((cause: unknown) => setError(pluginFailure(cause)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, [machineId]);
  return { plugins, error, loading, refresh };
}

export function PluginList({ machineId }: { machineId: MachineId }): ReactNode {
  const { plugins, error, loading, refresh } = usePlugins(machineId);

  /*
   * "Check again" and not "Try again": what failed is a **read**, so pressing
   * this asks the same question rather than repeating something that had an
   * effect — which matters here more than most, because the commonest way to see
   * this failure is the refresh fired by a switch or a removal that already
   * landed.
   */
  const again = (
    <Button onClick={refresh} disabled={loading}>
      {loading ? "Checking…" : "Check again"}
    </Button>
  );

  if (plugins === null) {
    // Nothing has ever been read, so there is no list to keep: the failure is the
    // whole screen, and it takes the triangle, the live region and the way out.
    if (error !== null) {
      return (
        <Empty failed action={again}>
          {error}
        </Empty>
      );
    }
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      {/*
       * ⚠ **A failed re-read sits above the list; it does not replace it.** This
       * was `if (error !== null) return <Empty>{error}</Empty>` — and `refresh`
       * runs after *every* toggle and *every* removal, so switching a plugin off
       * on a machine that then went unreachable toasted "Switched off" and
       * replaced the whole section, rows and file picker together, with one
       * centred grey sentence. There was no way back to it but leaving the screen
       * and returning.
       *
       * What is on screen is still the last thing this daemon actually said, so
       * it stays and this line says how much to trust it. `role="status"` for
       * {@link Empty}'s reason: the rows did not change, so this line is the only
       * thing on screen that knows anything happened.
       */}
      {error !== null && (
        <div role="status" className="mb-3 flex flex-wrap items-center gap-2 px-1">
          <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs text-fg">
            <Icon as={AlertTriangle} size={14} className="mt-0.5 shrink-0 text-muted" />
            <span>{error}</span>
          </p>
          {again}
        </div>
      )}
      {plugins.length === 0 ? (
        <Empty>Nothing installed.</Empty>
      ) : (
        <ul className="flex flex-col">
          {plugins.map((plugin) => (
            <PluginRow key={plugin.id} machineId={machineId} plugin={plugin} onChanged={refresh} />
          ))}
        </ul>
      )}
      {/*
       * ⚠ **A heading *inside* this component, not a section beside its parent's.**
       * This was `<section className={SETTINGS_SECTION}><h2>Install</h2>`, which is
       * the machine screen's own section idiom — the full-width rule and the same
       * `<h2>` — drawn from inside that screen's `Plugins` section. So the picker
       * for this list read as a sibling of `Systems`, `Agents` and `Retire this
       * machine` rather than as a control belonging to the plugins above it, and
       * two `<h2>`s nested with no change of level. `<h3>` under the pane's own
       * `<h2>`, the same type at the same weight with no rule — `ServerSection`'s
       * "Send a test" is the same subordinate group, one level in.
       */}
      <div className="mt-6">
        <h3 className={SETTINGS_HEADING}>Install</h3>
        <InstallPlugin machineId={machineId} onInstalled={refresh} />
      </div>
    </div>
  );
}

function PluginRow({
  machineId,
  plugin,
  onChanged,
}: {
  machineId: MachineId;
  plugin: PluginSummary;
  onChanged: () => void;
}): ReactNode {
  /**
   * What this row is in the middle of doing, as the words it puts on its own
   * subline — `null` when it is doing nothing.
   *
   * ⚠ **A boolean was not enough, because nothing on the row changed.** The
   * switch is a menu row: `RowAction` closes the menu and `run` set a flag that
   * only greyed the kebab, so for the width of the 90s slow-route budget the row
   * still read `Running` under a plugin that was being switched off, with the
   * menu gone and no evidence anywhere that a request existed. The toast arrives
   * at the *end* of that window, which is the half that was already right.
   */
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const busy = pending !== null;

  const run = (work: Promise<unknown>, doing: string, done: string): void => {
    setPending(doing);
    void work
      .then(() => {
        toast("ok", done);
        onChanged();
      })
      .catch((cause: unknown) => toast("error", pluginFailure(cause)))
      .finally(() => setPending(null));
  };

  const daemon = store.daemonFor(machineId);

  /**
   * The one way past "will not be tried again", which nothing on screen named.
   *
   * `MAX_PLUGIN_STARTS` is three **launches**, and a plugin that spends them is
   * left alone permanently: `resetBudget` is called from exactly one place a
   * client can reach, `PluginHost.setEnabled` with `enabled: true`. So the escape
   * hatch existed and was spelled *switch it off, then switch it on* — two taps
   * through a kebab, in an order nobody would guess from a row that says the
   * plugin will not be tried again. The route is idempotent by construction (the
   * body is the state a caller wants, not the transition it thinks it is making),
   * so sending `true` for a plugin that is already on is the whole of it: the
   * budget comes back and a supervised start is awaited before the answer.
   *
   * ⚠ **Not `run`, because its report is not a fixed string.** `setEnabled`
   * awaits the start, so the summary that comes back already says whether the
   * plugin came up — and "Restarted" over a plugin that has just failed for the
   * fourth time is the same lie the row is here to stop telling. The answer
   * decides both the tone and the sentence.
   */
  const restart = (): void => {
    if (daemon === undefined || busy) return;
    setPending("Starting…");
    void daemon
      .setPluginEnabled(plugin.id, true)
      .then((answer) => {
        const up = answer.plugin.state === "running";
        toast(
          up ? "ok" : "error",
          up ? `${plugin.name} is running again.` : `${plugin.name} did not start — see its row.`,
        );
        onChanged();
      })
      .catch((cause: unknown) => toast("error", pluginFailure(cause)))
      .finally(() => setPending(null));
  };

  return (
    <li className="border-b border-edge last:border-b-0">
      {/*
       * **The confirmation still leaves the menu and lands on the row — and it
       * lands *in place of* the row's controls, not under them.** A menu held
       * open to hold a two-step confirm would be a second dismissable layer over
       * the sheet, for one tap; `UsersSection` settled that. And drawn *below*
       * the row, which is where it was, the link and the kebab stayed live above
       * the question, so a second tap aimed at the kebab opened it over a
       * confirmation still waiting for an answer. Both groups lay out in the same
       * box now, which is the settings-row rule kept for its measured reason: the
       * last child occupies the same pixels, so a second tap aimed at a button
       * that looked inert lands on Cancel. This one earns it more than most,
       * because uninstalling takes the plugin's data with it and nothing brings
       * that back.
       *
       * The question names the plugin: "Remove it?" over a list of three is a
       * question about whichever row the eye happened to be on.
       *
       * Cancel is **last** and in the default tone. It was `tone="primary"` —
       * the only filled button on the screen — which made the undo the loudest
       * object in a row about deleting something. `BUTTON_TONE`'s rule is that a
       * fill is the affirmative act inside a decision; here there is none to
       * affirm, only one to decline.
       */}
      {confirming ? (
        <div className="flex min-h-14 min-w-0 flex-wrap items-center gap-2 px-1 py-2.5">
          <span className="min-w-0 flex-1 text-xs text-muted">
            Remove <span className="font-medium text-fg">{plugin.name}</span> and its data?
          </span>
          <DangerButton
            icon={Trash2}
            size="sm"
            className="[@media(pointer:coarse)]:min-h-11"
            disabled={busy || daemon === undefined}
            onClick={() => {
              setConfirming(false);
              if (daemon !== undefined) run(daemon.removePlugin(plugin.id), "Removing…", "Removed");
            }}
          >
            Remove
          </DangerButton>
          <Button size="sm" className="[@media(pointer:coarse)]:min-h-11" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
      <div className="flex min-w-0 items-center gap-1">
        {/*
         * ⚠ **The row is a link to the plugin, and the wall of text it used to be
         * is on the page it links to.** It drew the plugin's description and then
         * every scope as a sentence — *"Read your sessions, their transcripts and
         * what they changed"*, four of those — on the argument that a capability
         * nobody re-reads is a capability nobody withdraws. What that produced was
         * a machine screen where three installed plugins filled a phone twice
         * over with prose that is identical on every machine, and the *settings*
         * of the plugin were a kebab entry underneath it that nobody found.
         *
         * The scopes are one tap away, in the permissions fold on the plugin's own
         * page, which is also where its settings now are. What stays on this row
         * is what is true of *this host* and cannot be read anywhere else: the
         * version installed here, whether it is running, and what it said if it
         * failed.
         */}
        <button
          type="button"
          onClick={() => navigate(marketEntryPath(plugin.id))}
          className="tap press flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-2.5 text-left hover:bg-raised"
        >
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-x-2">
              <span className="truncate text-sm font-medium">{plugin.name}</span>
              <span className="shrink-0 text-xs text-muted">{plugin.version}</span>
            </span>
            {/* The act's own words while one is in flight, and the plugin's state
                otherwise — one line, never both, because they answer the same
                question and the newer answer is the true one. The spinner is what
                says it is *this row* rather than the screen. */}
            <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
              {pending !== null && <Spinner />}
              <span className="truncate">{pending ?? pluginStateText(plugin)}</span>
            </span>
          </span>
          <Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />
        </button>
        <Menu
          align="right"
          panelClassName="w-56"
          trigger={(open, toggle) => (
            /*
             * ⚠ **`size="lg"` and never `size="sm"`**, which is `MachineInstalls`'
             * decision one directory over and it applies here for the same
             * arithmetic. `sm` is 24px of ink reaching 44px through
             * `after:-inset-2.5` — 10px on every side — and this sits `gap-1` from
             * a full-width row button. So its grown target overlapped that
             * button's right-hand 10px, and being later in the DOM it won the hit
             * test: a tap aimed at the end of the plugin's name opened this menu
             * instead of the plugin. `lg` is a real 44px box, and the row is
             * `min-h-14`, so it costs no height.
             */
            <IconButton
              icon={MoreHorizontal}
              label={`Actions for ${plugin.name}`}
              size="lg"
              active={open}
              disabled={busy}
              onClick={toggle}
            />
          )}
        >
          {(close) => (
            <>
              {/* Disabled rather than absent while the plugin is switched off: the
                  row above says why, and a control that vanishes is one somebody
                  goes looking for. `focusableRows` skips a disabled button, so it
                  is not a stop on the way to one either. */}
              {plugin.contributes.screen !== null && (
                <RowAction
                  label="Open"
                  disabled={!plugin.enabled}
                  onClick={() => {
                    close();
                    navigate(pluginPath(machineId, plugin.id));
                  }}
                />
              )}
              {/*
               * ⚠ **No `Settings` row here any more, and that is the point of the
               * link above rather than an omission.** A plugin's settings are on
               * the plugin's page, drawn for the machines it is actually on. Two
               * doors to one pane is how the one nobody uses drifts.
               */}
              <RowAction
                label={plugin.enabled ? "Switch off" : "Switch on"}
                onClick={() => {
                  close();
                  if (daemon === undefined) return;
                  run(
                    daemon.setPluginEnabled(plugin.id, !plugin.enabled),
                    plugin.enabled ? "Switching off…" : "Switching on…",
                    plugin.enabled ? "Switched off" : "Switched on",
                  );
                }}
              />
              <RowAction
                label="Remove"
                danger
                onClick={() => {
                  close();
                  setConfirming(true);
                }}
              />
            </>
          )}
        </Menu>
      </div>
      )}

      {plugin.failure !== null && (
        <PluginFailure
          failure={plugin.failure}
          /* Only where a start is the act. A plugin somebody switched off keeps
             whatever it last said — `stop()` does not clear the sentence, only
             `resetBudget` does — so its failure is history, and the way back is
             `Switch on` in the menu above, which resets the same budget. */
          restartable={plugin.enabled}
          onRestart={restart}
          busy={busy}
        />
      )}

    </li>
  );
}

/**
 * The daemon's sentence, and the child's own output under it.
 *
 * ⚠ **One string, joined by the daemon, and this is the only reader that can
 * take it apart.** `withLogs` in `src/plugins/host.ts` writes
 * `` `${detail}\n${logs.join("\n")}` `` — the sentence *it* composed, then
 * whatever the child printed on stdout and stderr — so the first line is the
 * claim and the rest is evidence. Drawn as one blob they were the same 12px ink
 * as the plugin's own name two rows up, which is how a `SyntaxError` from
 * somebody else's `server.js` came to look like something this app was saying.
 *
 * Where `detail` is itself multi-line — a child that failed with a stack — the
 * split still lands correctly enough: the first line is that error's headline and
 * the rest still reads as output, which is what the two halves are drawn as.
 */
function failureParts(failure: string): { said: string; log: string | null } {
  const cut = failure.indexOf("\n");
  return cut === -1
    ? { said: failure, log: null }
    : { said: failure.slice(0, cut), log: failure.slice(cut + 1) };
}

/**
 * What a plugin said when it stopped working, and the one thing to do about it.
 *
 * ⚠ **It was ~500 unlabelled characters at `text-fg` with no control beside it**,
 * inside a `max-h-56 overflow-auto` of its own — a nested scroller inside the
 * settings sheet's own scroller, which on a touch screen is a trap: a drag that
 * starts on the log scrolls the log to its end and then stops, and the sheet does
 * not move. Three things follow, and each is a separate rule:
 *
 * **The log is bounded by the daemon, so it needs no scroller here.**
 * `MAX_FAILURE_CHARS` clips the whole string — sentence and output together — at
 * 500 characters before it is ever put on a row, so the worst case is about a
 * dozen lines. `MachineInstalls` argues the other half beside its own failure
 * subline: a failure is never clipped by the client, because `truncate` throws
 * away the half that identifies what went wrong.
 *
 * **The evidence is drawn as evidence.** Monospace, `text-2xs`, `text-muted`,
 * under a label — against the sentence above it at `text-fg`, which is the one
 * line this daemon wrote itself. Both halves at `text-fg` in one paragraph is
 * what made it impossible to tell whose problem this was. The two are told apart
 * by type and ink rather than by a second box: the whole thing is already the
 * `bg-raised/50` well this app uses for a tool call's captured output, and a
 * bordered box inside a bordered row inside a sheet is three frames for one
 * paragraph.
 *
 * **And the responses are part of the object.** The only controls adjacent to
 * this were Switch off and Remove, behind a kebab, so a person reading "will not
 * be tried again" had a dead end on screen and a working remedy nowhere near it.
 */
function PluginFailure({
  failure,
  restartable,
  onRestart,
  busy,
}: {
  failure: string;
  /** Whether starting it again is an act here at all. See the call site. */
  restartable: boolean;
  onRestart: () => void;
  busy: boolean;
}): ReactNode {
  const { said, log } = failureParts(failure);
  return (
    <div className="mb-2 rounded-md bg-raised/50 px-2.5 py-2">
      <p className="text-xs text-fg">{said}</p>
      {log !== null && (
        <>
          {/*
           * Labelled, because an unheaded wall of somebody else's stack trace
           * under a sentence this app wrote reads as one thing said by one
           * author.
           *
           * A `<p>` wearing the heading's type rather than an `<h3>`: this labels
           * a block inside a list row, and every failed plugin on the machine
           * would otherwise put another identical entry into the document's
           * outline, between the pane's own headings.
           */}
          <p className={`${SETTINGS_HEADING} mt-2`}>What it printed</p>
          <pre className="mt-1 font-mono text-2xs leading-snug whitespace-pre-wrap wrap-anywhere text-muted">
            {log}
          </pre>
        </>
      )}
      {restartable && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {/* `sm` with the coarse-pointer floor put back, which is `BUTTON_SIZE`'s
              documented escape: this keeps the desktop density of a control that
              sits inside a list row, and a finger still gets 44px. */}
          <Button size="sm" className="[@media(pointer:coarse)]:min-h-11" disabled={busy} onClick={onRestart}>
            {busy ? <Spinner /> : "Start it again"}
          </Button>
          {/* The other two answers, neither named nor drawn: both are one tap away
              in the menu on the row above, and a Remove 44px from a start button
              is the adjacency `MachineInstalls` refuses on its own rows — there
              the destructive one wins the overlap. The sentence that named them
              here was cut on 2026-09-04 for fewer words; what is kept is that
              nothing destructive is drawn beside this button. */}
        </div>
      )}
    </div>
  );
}

function InstallPlugin({ machineId, onInstalled }: { machineId: MachineId; onInstalled: () => void }): ReactNode {
  const input = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<
    | { kind: "idle" }
    | { kind: "reading" }
    | { kind: "confirming"; file: File; peek: ArchivePeek }
    | { kind: "sending"; fraction: number }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });
  /**
   * Aborts the upload in flight. Held in a ref rather than state because nothing
   * on screen reads it — it exists so a hung send can be called off, which the
   * old flow could not do at all: it created an `AbortController`, never wired
   * `abort` to anything, and disabled the only button for the duration.
   */
  const stop = useRef<AbortController | null>(null);

  const choose = (file: File): void => {
    setPhase({ kind: "reading" });
    void peekPluginArchive(file).then((peek) => setPhase({ kind: "confirming", file, peek }));
  };

  /*
   * `shown` is what the consent screen described, carried through the send so the
   * answer can be checked against it. `null` when nobody was shown anything — the
   * "Install without reading it" path, where there is no claim to break.
   */
  const send = (file: File, shown: ManifestPreview | null): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      // Same fact and therefore the same sentence as the read guard above: the
      // machine left the listing between opening this screen and pressing send.
      setPhase({ kind: "failed", message: MACHINE_GONE });
      return;
    }
    setPhase({ kind: "sending", fraction: 0 });
    const controller = new AbortController();
    stop.current = controller;
    void daemon
      .installPlugin(file, (fraction) => setPhase({ kind: "sending", fraction }), controller.signal)
      .then((answer) => {
        setPhase({ kind: "idle" });
        onInstalled();
        /*
         * ⚠ **Checked after the fact, because the reader can be wrong.** The
         * daemon returns the manifest it really parsed; if it holds authority the
         * screen did not show, that is said here rather than nowhere. `error`
         * rather than `ok`, and it replaces the success line: "Installed Clock
         * 1.0.0" beside a plugin that can answer every permission on the machine
         * is the same lie one step later. See {@link consentBroken}.
         */
        const broken = shown === null ? null : consentBroken(shown, answer.plugin);
        if (broken !== null) {
          toast("error", broken);
          return;
        }
        // The verb the daemon decided, not the one this screen guessed: `replaced`
        // is how a client learns whether it installed or updated, and guessing from
        // the list it fetched before sending would be wrong for a concurrent tab.
        toast(
          "ok",
          answer.replaced === null
            ? `Installed ${answer.plugin.name} ${answer.plugin.version}`
            : `Updated ${answer.plugin.name} to ${answer.plugin.version}`,
        );
      })
      .catch((cause: unknown) => {
        // An abort is somebody pressing Cancel, and `pluginFailure` has no arm for
        // one — it fell through to "That did not work. Try again." for an act they
        // took on purpose. `ImportCode` guards the same way for the same reason.
        // `controller`, not `stop.current`: a second install started in the
        // meantime would have replaced the ref, and this answer is about this one.
        if (controller.signal.aborted) return;
        setPhase({ kind: "failed", message: pluginFailure(cause) });
      })
      .finally(() => {
        stop.current = null;
      });
  };

  return (
    <div className="mt-2">
      <PluginArchiveNote />
      <input
        ref={input}
        type="file"
        accept={PLUGIN_ARCHIVE_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared before the read, so choosing the same file twice in a row after
          // a failure fires `change` again — the input holds the previous value
          // otherwise and the second attempt silently does nothing.
          event.target.value = "";
          if (file !== undefined) choose(file);
        }}
      />

      {phase.kind === "confirming" && phase.peek.kind === "ok" && <PluginConsent manifest={phase.peek.manifest} />}
      {/* `This machine`, because this picker reaches exactly the one host this
          settings pane is about. The fleet-wide import passes the other word. */}
      {phase.kind === "confirming" && phase.peek.kind === "unreadable" && (
        <PluginUnreadable reason={phase.peek.reason} checker="This machine" />
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button
          disabled={phase.kind === "sending" || phase.kind === "reading"}
          onClick={() => {
            // ⚠ The label is "Choose another file" when the archive could not be
            // read, and it has to open the picker or it is a dead control on the
            // one screen where the only other press is "Install without reading
            // it". Returning here left the safe way out inert and the unsafe one
            // working, which is the opposite of what this screen is for.
            if (phase.kind === "confirming" && phase.peek.kind === "ok") {
              // The manifest, never `null`: the `if` above has already narrowed the
              // peek to `ok`, so the second test this line used to carry could only
              // ever answer the same way — and reading as though there were a
              // no-manifest path through *this* press is the thing that matters,
              // because the one that really exists is the `DangerButton` below and
              // it is the whole point of the two being different controls.
              send(phase.file, phase.peek.manifest);
              return;
            }
            input.current?.click();
          }}
        >
          {phase.kind === "sending" ? <Spinner /> : <Upload size={14} />}
          {phase.kind === "sending"
            ? `${Math.round(phase.fraction * 100)}%`
            : phase.kind === "reading"
              ? "Reading…"
              : phase.kind === "confirming"
                ? phase.peek.kind === "ok"
                  ? "Install it"
                  : "Choose another file"
                : "Choose a file"}
        </Button>
        {phase.kind === "confirming" && phase.peek.kind === "unreadable" && (
          <DangerButton icon={Upload} onClick={() => send(phase.file, null)}>
            Install without reading it
          </DangerButton>
        )}
        {phase.kind === "confirming" && <Button onClick={() => setPhase({ kind: "idle" })}>Cancel</Button>}
        {phase.kind === "sending" && (
          <Button
            onClick={() => {
              stop.current?.abort();
              setPhase({ kind: "idle" });
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      {phase.kind === "failed" && <p className="mt-2 max-h-56 overflow-auto text-xs whitespace-pre-wrap wrap-anywhere text-fg">{phase.message}</p>}
    </div>
  );
}
