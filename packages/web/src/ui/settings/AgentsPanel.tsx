import { Check, Copy, Download, ExternalLink, LogIn, LogOut, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DaemonClient } from "../../daemon";
import type { CredentialWritten } from "../../wire";
import { ApiError, errorText } from "../../http";
import type { MachineId } from "../../ids";
import { store } from "../../store";
import type {
  AgentAuthInfo,
  AgentAuthListing,
  AgentCredentialSlot,
  AgentId,
  AgentLoginSupport,
  InstallRunView,
} from "../../wire";
import { Badge, Button, DangerButton, Empty, FIELD, Icon, IconButton, Spinner, TwoStep } from "../bits";
import { copyText } from "../clipboard";
import { CommandLine } from "../CommandLine";
import {
  installElapsed,
  installFailure,
  installResult,
  installResultLine,
  installStep,
  keepInstallTail,
  primaryControl,
  rawInstallIsOpen,
} from "../agentInstall";
import { loginOutcome, rawTranscriptIsOpen, readLoginTranscript, type LoginOutcome } from "../login";
import {
  harnessName,
  agentBadge,
  agentStance,
  credentialCaveat,
  credentialLabel,
  dividerWord,
  multiSlotLine,
  signOutSentence,
  stanceLine,
  STALE_READ,
  storedChip,
  tokenBlockFor,
  type AgentStance,
} from "../agentCard";
import { toast } from "../Toast";

/**
 * Everything about one agent, on one machine.
 *
 * The screen used to be a fleet-wide **Agents** section that opened with a
 * machine dropdown, stacking all three agents as cards. Both halves of that were
 * wrong for the same reason: an agent is signed in *on a machine*, in that
 * daemon's database and that host's home — so the machine is the thing you pick
 * first, and it is now in the URL rather than in a control. And most people use
 * one agent, so three cards of equal weight made the one that mattered the
 * hardest to find.
 *
 * What is here now: `AgentDetail`, one agent's whole configuration — sign in,
 * credentials, permissions. The list it used to sit under, `AgentChooser`, is
 * deleted: the rows became *systems* (`SystemChooser`, one file over) and it
 * was left exported with no call site for three releases.
 */

/** Reads `GET /agent-auth` for one machine, and hands the whole listing down. */
function useAgentAuth(machineId: MachineId): {
  listing: AgentAuthListing | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [listing, setListing] = useState<AgentAuthListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /*
   * Which read owns the state — a counter, and deliberately not the `cancelled`
   * flag `useSystems` uses one file over.
   *
   * A flag scoped to the effect is enough there because that hook's only trigger
   * *is* the effect: its `refresh` bumps an epoch and the effect runs again.
   * This one is called imperatively — on mount, from `AgentDetail` after every
   * sign-in, and from every "Check again" tap — so two reads can be in flight
   * inside a single effect run, and one flag cannot tell them apart.
   *
   * What that cost is the worst moment on this screen. You finish a device-code
   * login, the card says "Signed in to Claude Code", and then a probe that
   * started *before* the login finished lands carrying the pre-login answer: the
   * badge reverts to "not signed in", so you sign in again — the one flow in
   * this product with the least tolerance for being repeated.
   *
   * Bumped in the effect's teardown too, so a read still in flight for a machine
   * that has been navigated away from cannot write into the next one's state.
   */
  const epoch = useRef(0);

  const refresh = (): void => {
    const mine = (epoch.current += 1);
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setError("That machine is not reachable.");
      setLoading(false);
      return;
    }
    setLoading(true);
    void daemon
      .agentAuth()
      .then((next) => {
        if (mine !== epoch.current) return;
        setListing(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (mine !== epoch.current) return;
        /*
         * Framed here rather than at the two places that draw it, and this one
         * has to be: `error` is rendered as the *whole* of an `Empty`, where
         * `errorText`'s answer alone is a lower-case clause with no subject and
         * no full stop — "the connection failed, and whether the request arrived
         * is not known", centred in an empty pane, about nothing named. Every
         * other arm of this state is already a complete sentence.
         */
        setError(`Couldn't read this machine's agents — ${errorText(cause)}.`);
      })
      .finally(() => {
        // Only the live read owns the spinner. A stale one clearing it would
        // report "checked" while the read somebody is waiting on is still out.
        if (mine === epoch.current) setLoading(false);
      });
  };

  useEffect(() => {
    refresh();
    return () => {
      epoch.current += 1;
    };
  }, [machineId]);
  return { listing, error, loading, refresh };
}

/**
 * The badge, off the shared decision.
 *
 * ⚠ **This used to decide four states inline, where `webcheck` could not reach
 * it.** The rules it carries — that "cannot check" is not an alarm, and now that
 * an agent needing no sign-in says so rather than falling into that arm — live in
 * `agentCard.ts` with everything else this panel decides. See {@link agentBadge}.
 */
function statusOf(agent: AgentAuthInfo): { tone: "plain" | "strong"; text: string } | null {
  return agentBadge(
    agentStance(agent.available, agent.loggedIn, agent.login?.blocked, agent.lastStartRefusal != null),
  );
}

/**
 * ⚠ It was `px-1 py-0.5` — roughly 20px — on a control a non-technical person is
 * being asked to tap on a phone. `-mx-2` keeps its ink where it was while the box
 * grows to the 44px floor.
 */
function RecheckButton({ onClick, busy }: { onClick: () => void; busy: boolean }): ReactNode {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="tap press -mx-2 inline-flex min-h-11 items-center gap-1.5 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
    >
      <Icon as={RefreshCw} size={12} /> {busy ? "Checking…" : "Check again"}
    </button>
  );
}

/**
 * The read failed and what is on screen is the last good answer.
 *
 * ⚠ **One sentence, and it is `agentCard.ts`'s `STALE_READ` — the same string
 * `SystemsPanel` draws directly above this card.** `AgentDetail`'s `error` was
 * once rendered solely inside its `listing === null` branch, so a machine that
 * went unreachable *after* a successful read froze the card on a stale badge for
 * ever with nothing saying so; and once the arm existed it had its own spelling,
 * so `SystemDetail` drew two near-identical sentences about one machine for the
 * ordinary case where both reads fail together. One constant, two call sites.
 *
 * `text-muted` and not `text-danger`: nothing has failed permanently here. What
 * is below was true a moment ago, and "Check again" is on screen.
 */
function StaleNotice(): ReactNode {
  return <p className="text-xs text-muted">{STALE_READ}</p>;
}

/** One agent: sign in, credentials, permissions. */
export function AgentDetail({
  machineId,
  agentId,
  title,
  keyEnv,
}: {
  machineId: MachineId;
  agentId: AgentId;
  /**
   * What to call this card, where the harness's own name is not what the reader
   * came for.
   *
   * The systems screen passes the *system's* name — "Anthropic" over a card that
   * drives `claude auth login` — because that is what somebody has an account
   * with. Omitted, it is the harness, which is what the two harness leaves want:
   * the Agents list's **Set up**, opened from a row that says `Claude Code`, and
   * the Sign-ins list's row for a harness no provider speaks for. A card headed
   * `Anthropic` under either would read as a different subject from the row
   * somebody tapped.
   */
  title?: string;
  /**
   * The one credential this card is about, where it is mounted for a **system**.
   *
   * ⚠ **A harness's card holds every key that harness reads, and under a system's
   * name that is somebody else's account.** opencode takes one for OpenRouter and
   * one for OpenCode Zen, so the screen headed `OpenRouter` drew both boxes, each
   * under the same repeated sentence about Zen's free models. Given, this card is
   * about that one variable and says nothing else: no stance sentence, no caveat,
   * no divider, no "either one will do" — those are all facts about the *harness*,
   * and the reader is here about an account. `null` keeps the whole card, which is
   * what both harness leaves want — the Agents list's **Set up** and the Sign-ins
   * list's harness row.
   */
  keyEnv?: string | null;
  /*
   * ⚠ **There is no `onChanged` here any more, and its one caller is why.** It
   * existed for `NewSession`, which mounted this card inline and drew its tiles
   * from a different route (`GET /agents`), so a sign-in finished in here had to
   * tell the strip to re-read. That door is gone (Q3.640): every screen that
   * mounts this card now is a leaf, and leaving it remounts whatever reads the
   * listing. Q3.431 is where the signal came from.
   */
}): ReactNode {
  const { listing, error, loading, refresh } = useAgentAuth(machineId);

  if (loading && listing === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Asking that machine…
      </div>
    );
  }
  if (listing === null) {
    return (
      // `failed`, and a way out of the branch: "Check again" otherwise lives only
      // in the success arm, so a first read that failed left the card inert.
      <Empty
        failed
        action={
          <Button size="sm" onClick={refresh}>
            Try again
          </Button>
        }
      >
        {error ?? "Could not read this machine's agents."}
      </Empty>
    );
  }

  const agent = listing.agents.find((candidate) => candidate.id === agentId);
  // A settled answer rather than a read that did not come back, so no `failed`
  // and no live region: the machine was asked and it does not have that agent.
  if (agent === undefined) return <Empty>This machine doesn't have that agent.</Empty>;

  const status = statusOf(agent);
  /*
   * Per agent where the daemon says so, daemon-wide where it does not.
   *
   * The fallback is what an older daemon sends, and it is the behaviour this
   * screen had before: one boolean for the whole host, and an input box for
   * every agent whether or not anything reads one.
   */
  const login = agent.login ?? { supported: listing.loginSupported, needsInput: true };

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-2">
        {/* `harnessName`, so the title is "Codex" rather than "Codex (codex-acp)":
            the package name is the wall of text in miniature, and the daemon's own
            `displayName` is the log line that carries it. A harness a plugin added
            has no row in this product's table and takes its manifest's name — which
            is the whole reason that name rides its own field rather than reusing
            `displayName`. */}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {title ?? harnessName(agent)}
        </span>
        {/*
         * ⚠ **While a re-probe is in flight the previous listing is still on
         * screen** — this component early-returns on `loading` only while
         * `listing === null`. After a sign-in that previous value is "not signed
         * in" *by construction*, since it is what put the button there, so the
         * badge contradicted the wizard for the whole window. It now says nothing.
         */}
        {loading ? (
          <Badge tone="plain">checking…</Badge>
        ) : (
          status !== null && <Badge tone={status.tone}>{status.text}</Badge>
        )}
      </div>

      {/*
       * `agent.hint` is gone from here, and from `NewSession`, which drew the same
       * five lines. It was written for whoever runs the daemon — adapter against
       * CLI, `~/.codex/auth.json`, `session/new … -32000` — and read by whoever is
       * holding the phone. The daemon still sends it and still needs it: the same
       * string is the body of the session-start failure in `session.ts`. What a
       * person can act on is re-derived client-side in `agentCard.ts`. Q3.431.
       *
       * This line is the arm that rendered nowhere: `error` was drawn only in the
       * `listing === null` branch, so a machine that went unreachable mid-login
       * froze this card on a stale badge for ever with nothing saying so.
       * `SystemChooser` had the identical gap and now draws the identical
       * sentence, which is why it is {@link StaleNotice} rather than a `<p>`.
       */}
      {error !== null && <StaleNotice />}

      <SignIn
        machineId={machineId}
        agent={agent}
        login={login}
        keyEnv={keyEnv ?? null}
        os={listing.os}
        checking={loading}
        checkFailed={error !== null}
        onChanged={refresh}
      />

      <RecheckButton onClick={refresh} busy={loading} />
    </div>
  );
}

/*
 * `SectionHeading` was here, drawing "CREDENTIALS" above this card's one control.
 *
 * Deleted rather than restyled: it was a `<div>` wearing heading type, it had a
 * single call site, and a section title over a card that holds one button is
 * furniture. The card stops being a section and becomes one thing. Q3.431.
 */

/**
 * The one card, and everything on it.
 *
 * It was a section titled CREDENTIALS holding a primary Sign-in button and a
 * `<details>` marked "Paste a token" — a disclosure a person had to know existed,
 * over a control labelled with a raw environment variable name. It is now two
 * pure decisions (`agentStance`, `tokenBlockFor` in `agentCard.ts`) and five
 * slots that collapse to nothing rather than reorder: a stance sentence that is
 * empty in the two commonest states, one act, a divider, the key rows, and
 * "Check again".
 *
 * **The key rows are drawn even while the wizard is open**, and that is load
 * bearing twice: a stored credential is then removable in every state without
 * exception, and the macOS pty failure — which tells you to save a key instead —
 * points at a control that is already on screen rather than at one you must go
 * and find. Q3.431.
 */
function SignIn({
  machineId,
  agent,
  login,
  keyEnv,
  os,
  checking,
  checkFailed,
  onChanged,
}: {
  machineId: MachineId;
  agent: AgentAuthInfo;
  login: AgentLoginSupport;
  /** The one credential this card is about, or `null` for the whole harness. */
  keyEnv: string | null;
  /** The daemon's own platform, for the one sentence that has to name it. */
  os: string | undefined;
  /** A re-probe is in flight, so no verdict may be claimed yet. */
  checking: boolean;
  /** The re-probe could not be made at all — a different thing from a verdict. */
  checkFailed: boolean;
  onChanged: () => void;
}): ReactNode {
  /*
   * Open by itself when this tab already has a login running.
   *
   * Without this the `sessionStorage` reattach below is dead code: after a
   * reload the section renders closed, so nothing mounts the wizard, so nothing
   * reads the stored id — and the person is back at a "Sign in" button with a
   * code on their clipboard and a live flow they cannot reach. Read in the
   * initialiser rather than an effect so there is no frame showing the button.
   */
  const [wizard, setWizard] = useState(() => {
    try {
      return window.sessionStorage.getItem(loginKey(machineId, agent.id)) !== null;
    } catch {
      // Storage disabled. The flow still works; it just will not survive a reload.
      return false;
    }
  });
  // The same reattach, for the same reason, on the other flow. An install runs
  // longer than a login, so surviving a reload matters here at least as much.
  const [installing, setInstalling] = useState(() => heldInstall(machineId, agent.id) !== null);
  /**
   * This daemon has said it installs nothing at all.
   *
   * ⚠ **A second source for the same suppression, and on *this* card it is the
   * only one that works.** `GET /agents` folds `installs !== null` into
   * `installable` per row — the daemon's own docblock says a row that says yes
   * to one and no to the other is a button that answers `503` — but this card
   * reads `GET /agent-auth`, which spreads the runtime's `installable` **with
   * no such fold**. So on a machine running `REEMOAT_AGENT_UPDATES=off` this
   * card drew a button whose `POST` answers `503 install_unsupported`. And the
   * machine's Agents list draws no Install at all since Q3.640 — this card is the
   * one surface that starts a run — so this flag is the only suppression on the
   * one Install this app still draws.
   *
   * ⚠ **A flag that only ever rises, never a tri-state.** `false` is "nothing
   * heard", which is what an older daemon's `404` and a dropped request both
   * are, and neither may take away a control the listing offered.
   */
  const [noInstallRoute, setNoInstallRoute] = useState(false);
  /*
   * ⚠ **What the daemon is already running, adopted rather than guessed at.**
   * There is one install run daemon-wide and the seed above is per tab and per
   * agent, so it was silent about three real states: a run started on this card
   * in another tab or on another device (through either list that opens it, the
   * Agents list's **Set up** or the Sign-ins list's harness row), a reload in a
   * private window, and a key left behind by a run the daemon has since swept —
   * that last one opening the pane onto a dead id. One read answers all three,
   * and its negative arm is the one that clears a stale key before anything
   * polls it.
   *
   * **Unconditional, and that is one small `GET` per card opened.** It could be
   * narrowed to the states that draw an Install — but a live run outranks every
   * stance in `primaryControl` on purpose, precisely so that re-installing a
   * working harness is visible, and a gate on the stance would make the one
   * state this cannot see the one the field was added for. This card already
   * spends a listing read on every open; the run is the other half of what it
   * needs to draw a control that is true.
   */
  useEffect(() => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return;
    /*
     * Read before the request rather than inside the answer, so the arm below
     * can tell a pane *seeded from storage* — whose id this machine may have
     * forgotten — from one somebody has pressed Install on while the read was in
     * the air, which has no id written down yet and must not be taken away.
     */
    const held = heldInstall(machineId, agent.id);
    let cancelled = false;
    void daemon
      .liveInstall()
      .then((live) => {
        if (cancelled) return;
        if (!live.supported) setNoInstallRoute(true);
        const running = live.run;
        if (running !== null && running.agent === agent.id) {
          /*
           * ⚠ **A *finished* run of this agent's is left alone, and that is what
           * keeps the two answers from racing.** The daemon retains one for ten
           * minutes, and the pane's own poll is what draws its result line and
           * removes the key — clearing it from here as well would mean whichever
           * response landed first decided whether somebody saw the outcome of
           * the install they had just run. The id is written down before the
           * pane is opened, so the pane adopts rather than starting anything.
           */
          if (!running.done) {
            rememberInstall(machineId, agent.id, running.installId);
            setInstalling(true);
          }
          return;
        }
        /*
         * Nothing running here, so a stored id names a run this machine has
         * swept or one belonging to another agent entirely. Cleared *before* the
         * pane polls it, which is the confusing press this closes.
         *
         * ⚠ **Against the id read before the request, which is the other half of
         * that ordering.** `held !== null` alone says only that *something* was
         * stored; a press made while this read was in the air writes its own id,
         * and this arm would then clear a run that is live.
         * {@link forgetInstallIf} is the comparison, and the pane stays open
         * where it refuses.
         */
        if (held !== null && forgetInstallIf(machineId, agent.id, held)) {
          setInstalling(false);
        }
      })
      .catch(() => {
        // An older daemon answers `404` here and a dropped request looks the
        // same. Neither is evidence about a run or about the route, so nothing
        // is adopted and nothing is withdrawn.
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, agent.id]);

  // The wire type says `credentials` is required, but a daemon predating the
  // field would take this whole panel down on a `.filter` of undefined.
  const all = agent.credentials ?? [];
  /*
   * Narrowed to the system's own key where this card is mounted for one — and
   * never on an empty result: a daemon too old to send `keyEnv`, or one that
   * renames a variable, must leave the boxes drawn rather than leave a screen with
   * no way to paste anything at all.
   */
  const scoped = keyEnv === null ? all : all.filter((slot) => slot.envName === keyEnv);
  const slots = scoped.length > 0 ? scoped : all;
  const wholeAgent = slots.length === all.length;
  const stored = slots.filter((slot) => slot.set).length;
  // The blocked reason is read here too, so the sentence and the badge cannot
  // come to disagree about whether this agent has a sign-in at all.
  const stance = agentStance(agent.available, agent.loggedIn, login.blocked, agent.lastStartRefusal != null);
  /*
   * Two axes, not one. `available` is the *adapter*; `login.supported` is
   * `script` plus the agent's own CLI, a different binary — so "adapter missing
   * but the wizard could run" is a real state, and the old
   * `disabled={!agent.available}` button was a control that could not act.
   */
  const canSignIn = login.supported && agent.available;
  const block = tokenBlockFor(stance, stored);
  // Every one of these is a sentence about the *harness*, so a card scoped to one
  // of its keys draws none of them: the box's own label and note say what the key
  // is for, and that is the whole of what somebody opened this screen to read.
  /*
   * ⚠ **One binding, read by the sentence and by the button.** `stanceLine`'s
   * `not_installed` arm names the control eight pixels below it when this is
   * true and sends somebody to the machine itself when it is not, so the two
   * disagreeing is a card telling a person to press a button that is not drawn.
   * `=== true` and never `!== false`, which is `login.canSignOut` a dozen lines
   * down and deliberately the opposite call: that refusal is a `503` carrying
   * the route's own sentence, this one could be a bare `404` with nothing to
   * render.
   */
  const canInstall = agent.installable === true && !noInstallRoute;
  const line = wholeAgent ? stanceLine(agent, stance, canSignIn, os, canInstall) : null;
  // Stays true while the wizard runs, or the divider would flip to "Sign in with
  // a key instead" beside a live sign-in.
  const signInAbove = canSignIn && stance !== "signed_in";
  const divider = wholeAgent ? dividerWord(stance, signInAbove, block) : null;
  const caveat = wholeAgent ? credentialCaveat(agent.id, canSignIn) : null;
  const choice = wholeAgent ? multiSlotLine(agent, slots.length) : null;

  return (
    /*
     * **No border, no fill, no padding of its own.** This was a card, back when it
     * had a CREDENTIALS heading and two competing paths inside it. With the
     * heading gone and one act left, the border drew a box around mostly nothing —
     * most visibly when signed in, where it framed a single button and a lot of
     * air. The sheet is already the surface; a second one inside it earns nothing.
     */
    <div>
      {line !== null && <p className="text-xs text-muted">{line}</p>}

      {/*
       * ⚠ **One call decides this slot**, where it was a three-way ternary that
       * read `stance` and `canSignIn` inline. The fourth arm is what made that
       * untenable: `canSignIn` is `login.supported && agent.available`, so a
       * harness that is not on the machine reached the final `: null` and the card
       * drew **nothing at all** under a sentence saying it was not installed. The
       * ordering that fixes it — `not_installed` above the credential axis — is a
       * rule with a `never` arm in `agentInstall.ts` rather than a ladder written
       * out here, because a ladder in JSX is what nothing can sweep.
       */}
      {(() => {
        switch (
          primaryControl({
            stance,
            installRunning: installing,
            wizardOpen: wizard,
            installable: canInstall,
            canSignIn,
            // `!== false` on purpose, and the one flag here that is read that
            // way — `canInstall` above is `=== true`, and somebody will try to
            // make the two match: this control's refusal is a 503 carrying the
            // route's own sentence, so offering it costs a clean error. See the
            // field's own docblock.
            canSignOut: login.canSignOut !== false,
          })
        ) {
          case "installing":
            return (
              <InstallPane
                machineId={machineId}
                agent={agent.id}
                displayName={harnessName(agent)}
                available={agent.available}
                checking={checking}
                checkFailed={checkFailed}
                onDone={onChanged}
                onClose={() => {
                  setInstalling(false);
                  onChanged();
                }}
              />
            );
          case "wizard":
            return (
              <LoginWizard
                machineId={machineId}
                agent={agent.id}
                displayName={harnessName(agent)}
                needsInput={login.needsInput}
                loggedIn={agent.loggedIn}
                checking={checking}
                checkFailed={checkFailed}
                onDone={onChanged}
                onClose={() => {
                  setWizard(false);
                  onChanged();
                }}
              />
            );
          case "install":
            return (
              <Button tone="primary" className="mt-2 w-full" onClick={() => setInstalling(true)}>
                <Icon as={Download} size={14} />
                Install {harnessName(agent)}
              </Button>
            );
          case "sign_out":
            /*
             * **Signed in, so the card holds one control and it is centred.**
             *
             * "✓ Signed in" is deleted: it repeated the badge 40px above it, and
             * deleting it is what frees the box to be centred at all.
             */
            return <SignOutButton machineId={machineId} agent={agent} onChanged={onChanged} />;
          case "sign_in":
            return (
              <Button tone="primary" className="mt-2 w-full" onClick={() => setWizard(true)}>
                <Icon as={LogIn} size={14} />
                Sign in to {harnessName(agent)}
              </Button>
            );
          case "none":
            /*
             * The one sentence this slot still owes: a harness signed in with no
             * sign-out command has a control nothing can draw, and the reason has
             * to be somewhere. Every other `none` is a state `stanceLine` above
             * has already explained.
             */
            return stance === "signed_in" ? (
              <p className="mt-2 text-xs text-muted">{signOutSentence(agent.id, stored)}</p>
            ) : null;
        }
      })()}

      {/*
       * ⚠ **The card that *states* the refusal is where the control for it has to
       * be, and for a whole draft it was not.** The strip's own remedy lives in
       * the machine's agent list, which excludes every harness `startsBare` is
       * false for — opencode, and every one a plugin added — so
       * exactly the harnesses that live on presets had a card saying "would not
       * start" with nothing beside it. `stanceLine` above already named both
       * remedies; this is the one of them that is a button.
       *
       * Below the sign-in block rather than instead of it: a harness with a wizard
       * can be in this state too, and there the sign-in is the *first* answer —
       * this is what to press after signing in somewhere this app cannot see.
       */}
      {wholeAgent && stance === "start_refused" && (
        <Button
          className="mt-2 w-full"
          onClick={() => {
            const daemon = store.daemonFor(machineId);
            if (daemon === undefined) {
              toast("error", "That machine is not reachable.");
              return;
            }
            void daemon
              .recheckAgent(agent.id)
              // Framed rather than dumped, which is this screen's rule for all
              // five of its writes: `errorText` answers in an `ApiError`'s
              // register and has no subject of its own.
              .catch((cause: unknown) =>
                toast("error", `Couldn't ask ${harnessName(agent)} again — ${errorText(cause)}.`),
              )
              .finally(onChanged);
          }}
        >
          Check again
        </Button>
      )}

      {/* Drawn only when there is something on both sides of it: an "or" with one
          branch missing is a lie. */}
      {divider !== null && (
        <div className="mt-3 flex items-center gap-3">
          <span className="h-px flex-1 bg-edge" />
          <span className="shrink-0 text-2xs text-muted">{divider}</span>
          <span className="h-px flex-1 bg-edge" />
        </div>
      )}

      {block !== "hidden" && (
        <>
          {block === "editable" && choice !== null && (
            <p className="mt-2 text-xs text-muted">{choice}</p>
          )}
          {slots.map((slot) => (
            <CredentialSlot
              key={slot.envName}
              machineId={machineId}
              agent={agent}
              slot={slot}
              stance={stance}
              caveat={caveat}
              /* Only where the wizard cannot run, and only on the slot that
                 command actually fills. Offered next to the API-key box it would
                 be an instruction that produces the wrong credential. */
              howTo={
                login.blocked === "interactive_pty" && slot.envName === "CLAUDE_CODE_OAUTH_TOKEN"
                  ? "claude setup-token"
                  : null
              }
              editable={block === "editable"}
              onChanged={onChanged}
            />
          ))}
        </>
      )}
    </div>
  );
}


/**
 * Two taps, with the undo **last**.
 *
 * The same shape and the same reason as retiring a machine or deleting a person,
 * and the same primitive: `TwoStep` lays both groups out left-to-right in one
 * box so the last child occupies the same pixels, and `.tap` removes the
 * double-tap delay — so a second tap aimed at a control that looked like it did
 * nothing lands on Cancel rather than on the irreversible half. Held per row, in
 * the row's own component.
 *
 * `danger` on the **first** tap, unlike Retire on the machines list: retiring a
 * machine is undone by enrolling it again from the same screen, while signing out
 * ends the session on that host for every use of the CLI, not only for Reemoat,
 * and getting back in is a device-code flow through another tab. That is the
 * resting control's decision, which is why `rest` is this component's
 * `DangerButton` and not the primitive's.
 *
 * **Centred, and Cancel still last.** This shipped `justify-end` on a geometric
 * argument — the undo must occupy the pixels the resting button had, so a second
 * tap on a laggy connection cannot land on the irreversible half — and the
 * visible result was a Sign out button pinned to the right of an empty box,
 * which is not what was asked for and not what this state should look like.
 * The ordering rule survives the centring: Cancel is still the last child, so it
 * takes the right-hand side of a centred pair, and the resting button's own
 * centre falls in the **gap** between the two answers rather than on Sign out.
 * A second tap there hits nothing, which is the safe outcome; the property the
 * rule protects is that it must not hit the destructive half, and it does not.
 * `align="center"` is that shape, and it also puts the question on its own line
 * (`basis-full text-center`), so the answers are never crushed on a 390px phone
 * — in CSS, with no breakpoint anywhere. (The `justify-end` this replaced argued
 * the geometry the other way, and its paragraph sat here above `justify-center`
 * code for a revision, stating a rule the box did not implement.)
 */
function SignOutButton({
  machineId,
  agent,
  onChanged,
}: {
  machineId: MachineId;
  agent: AgentAuthInfo;
  onChanged: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const daemon = store.daemonFor(machineId);

  /*
   * Handed to `TwoStep`, which owns the wait. The `daemon` guard is for the
   * type, the way `KeyOnly`'s is one card over: the act is `disabled` on the
   * same condition, so this arm is not reached. It used to answer a toast and
   * return nothing — which the primitive reads as an act with no wait, and
   * closes the question on: a refusal drawn as a success, and the one site
   * whose failure did not stand beside its toast (E7's review). A machine
   * `daemonFor` cannot find has left the list (`dropMachine`) rather than gone
   * quiet, which `refresh` above already says for the whole screen; a greyed
   * act is what that fact looks like on a control.
   */
  const run = (): Promise<void> | undefined => {
    if (daemon === undefined) return undefined;
    return daemon.signOut(agent.id).then(onChanged);
  };

  return (
    <TwoStep
      armed={confirming}
      onArm={setConfirming}
      align="center"
      size="md"
      className="mt-2"
      question={<>Sign {harnessName(agent)} out on this machine?</>}
      act={{ label: "Sign out", danger: true, icon: LogOut }}
      disabled={daemon === undefined}
      onAct={run}
      /*
       * **Framed, not dumped** — the first of four writes on this screen that
       * used to hand `errorText`'s answer straight to a toast, which is why this
       * one does not take the primitive's default.
       *
       * That function answers in an `ApiError` message's register: lower case,
       * unpunctuated and with no subject, so that a caller cannot tell which arm
       * it got. It reads correctly *inside* a sentence, and alone in a toast it
       * has no subject at all. Since `http.ts` grew its transport arm the point
       * is unavoidable — a dropped connection here now pops up "the connection
       * failed, and whether the request arrived is not known" over a screen
       * carrying a sign-out, two key boxes and a sign-in wizard, naming none of
       * them. The call site is the only thing left that knows what was tried.
       */
      onFailure={(cause) => toast("error", `Couldn't sign ${harnessName(agent)} out — ${errorText(cause)}.`)}
      rest={
        <DangerButton icon={LogOut} onClick={() => setConfirming(true)}>
          Sign out
        </DangerButton>
      }
    />
  );
}

/**
 * One saved key, named by what it *is*.
 *
 * The visible label and the accessible name were both the raw environment
 * variable, so a screen reader spelled out "C L A U D E underscore C O D E
 * underscore O A U T H underscore T O K E N" and a non-technical reader was shown
 * the name of a variable they will never set. The raw name survives as a `title`
 * and as the wire key, and nowhere else. Q3.431.
 */
function CredentialSlot({
  machineId,
  agent,
  slot,
  stance,
  caveat,
  howTo,
  editable,
  onChanged,
}: {
  machineId: MachineId;
  /* The row rather than the id: `storedChip` names the harness in a sentence, and
     a name is not derivable from an id for one a plugin added. */
  agent: { id: string; label?: string };
  slot: AgentCredentialSlot;
  stance: AgentStance;
  /** The one thing to read before typing. See `credentialCaveat`. */
  caveat: string | null;
  /** A command that produces this credential, where one exists. See `CommandLine`. */
  howTo: string | null;
  /** False where nothing typed here could help — see `tokenBlockFor`. */
  editable: boolean;
  onChanged: () => void;
}): ReactNode {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  // Read before `withDaemon` rather than after it, because the failure toast
  // below names the key it was about and a closure reaching forward into a
  // `const` is a needless thing to have to reason about.
  const label = credentialLabel(slot.envName);

  const withDaemon = (
    run: (daemon: DaemonClient) => Promise<CredentialWritten>,
    removing = false,
  ): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      toast("error", "That machine is not reachable.");
      return;
    }
    setBusy(true);
    void run(daemon)
      .then((answer) => {
        setValue("");
        /*
         * True by construction rather than optimistic: `PUT /agent-auth/:agent`
         * and its `DELETE` both call `forgetAvailability()`, so the refetch below
         * re-spawns the probe **with the new key in its environment** and the chip
         * corrects itself within about a second.
         *
         * **And the chats already open are told about**, because they are the half
         * that used to go silently wrong: a credential reaches an agent only at
         * spawn, so a token saved mid-conversation changed nothing for the one in
         * front of you. They are relaunched now, and saying how many is what
         * connects "I saved a key" to "my chat stopped answering for a second".
         */
        toast("ok", credentialToast(removing, answer.restarting));
        onChanged();
      })
      // Framed for the reason `SignOutButton` gives at length. Here there is a
      // second thing only the call site knows: which of two acts, on which of
      // two keys — a bare "the connection failed…" over a card drawing both
      // boxes says neither.
      .catch((cause: unknown) =>
        toast(
          "error",
          `Couldn't ${removing ? "remove" : "save"} the ${label.name} — ${errorText(cause)}.`,
        ),
      )
      .finally(() => setBusy(false));
  };

  // Exactly `MAX_CREDENTIAL_CHARS` in `src/server.ts`, not a guess under it: a
  // lower bound would refuse a key the daemon accepts, with a sentence that lies.
  const tooLong = value.length > 8192;
  const canSave = !busy && value.trim().length > 0 && !tooLong;
  // The form's submit, guarded by the same predicate that disables its button:
  // implicit submission from the field fires the default button only while it
  // is enabled, and stating the rule once here is what makes that not matter.
  const save = (): void => {
    if (!canSave) return;
    withDaemon((daemon) => daemon.saveCredential(agent.id, slot.envName, value));
  };
  const remove = (
    <IconButton
      icon={X}
      tone="destructive"
      /*
       * ⚠ **`chip`, and `lg` was rejected on a measurement rather than on
       * taste.** This passed no `size` at all, so it took the deleted `md`
       * default — 36px of box with no growth mechanism of any kind, the one
       * entry in `ICON_BUTTON_SIZE` that never reached the 44px floor — on the
       * only irreversible control in this row.
       *
       * `lg` is the obvious replacement and is wrong here for a reason that can
       * be measured: it is a fixed `h-11`, while every other box in this row
       * states a `min-h` and stretches. A 44px Remove therefore drags the field
       * and Save up to 44px on a desktop, where both are 36px — and the field
       * then no longer lines up with the `CommandLine` box above it, which
       * is a height `webcheck` holds to one stated number on purpose. `chip` is
       * 32px, so it sits *inside* the row's existing height and moves no layout
       * at either pointer size, and it reaches 44px through `TAP_GROW_Y`.
       */
      size="chip"
      /*
       * 4px on top of the row's `gap-2`, and it is about the eye now rather than
       * about the target. It used to claim it was the clearance "this button's
       * expanded target" needed from the control on its left — reasoning about a
       * growth mechanism `md` did not have, and which `chip` does not have
       * either: `TAP_GROW_Y` grows the top and bottom edges only and leaves both
       * sides on the face, so nothing this button can be tapped through ever
       * reaches Save. What the 12px buys is that the irreversible control does
       * not sit at the same rhythm as the affirmative one beside it.
       */
      className="ml-1"
      label={`Remove ${label.name}`}
      onClick={() => withDaemon((daemon) => daemon.clearCredential(agent.id, slot.envName), true)}
      disabled={busy}
    />
  );

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        {/* The raw name is what the credential *is* — the variable the CLI reads
            it from — so it survives as a `title`. It is not the label and it is
            not the accessible name. */}
        <span className="min-w-0 flex-1 truncate text-xs text-fg" title={slot.envName}>
          {label.name}
        </span>
        {slot.set && (
          <span className="flex shrink-0 items-center gap-1 text-2xs text-muted">
            <Icon as={Check} size={11} /> {storedChip(agent, stance)}
          </span>
        )}
      </div>
      <p className="text-2xs text-muted">{label.note}</p>

      {/*
        * **How to make the thing this field wants, on the field that wants it.**
        *
        * It was a paragraph above the divider once, and that was two mistakes: it
        * restated the sentence `stanceLine` already draws at the top of the card,
        * and it said "paste the token below" with a divider, a heading and two
        * inputs between it and the box it meant. A command belongs against the
        * field it fills.
        */}
      {howTo !== null && editable && <CommandLine command={howTo} />}

      {/* Above the input and before the first keystroke — not a tooltip, which a
          phone has none of, and not a toast after saving. */}
      {editable && caveat !== null && <p className="mt-1 text-xs text-fg">{caveat}</p>}

      {editable ? (
        <>
          {/*
            * `gap-2` between the field and Save, and 4px more put on Remove
            * itself.
            *
            * The gap used to be `gap-3` for all of it, and the reason given was
            * only ever about Remove: that its `after:-inset-2.5` target reached
            * 10px past its face, so at 8px spacing it would land 2px onto its
            * neighbour. ⚠ **That was never true of this button.** It named no
            * `size`, so it took the 36px `md` default, which had no growth
            * mechanism at all — the sentence described `sm`, one entry over. It
            * is `chip` now, whose growth is vertical only, so the sides of its
            * target are its own face and the spacing here is a visual one. The
            * conclusion outlives its premise: the field and Save are two ordinary
            * boxes with no overhanging targets and need no extra gap.
            *
            * **One row, so the field is narrower than the command box above it by
            * exactly Save plus a gap.** That was tried the other way and taken
            * back: matching the widths costs a whole row of height on every slot,
            * and there are two of them on this screen alone.
            */}
          <form
            className="mt-3 flex gap-2"
            /* A real form, as `SystemsPanel`'s key box already is: Enter submits
               through the one path a browser owns and assistive technology knows.
               This was a `div` with a Save `onClick` beside that form, so Enter
               landed a provider key and did nothing to a harness key one screen
               over (review D22). */
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              /* The same three reasons `SystemsPanel` gives at length: a
                 `type="password"` here is what makes a browser offer an account
                 password, `autocomplete="off"` is documented not to stop it, and
                 this box only ever holds a value somebody has just pasted. */
              type="text"
              name="reemoat-agent-key"
              data-1p-ignore=""
              data-lpignore="true"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder={slot.set ? "paste a new key" : "paste the key"}
              aria-label={label.name}
              className={`${FIELD} min-w-0 flex-1 font-mono`}
            />
            <Button
              size="sm"
              type="submit"
              /* Shrunk with the field beside it and floored with it too. `min-w-20`
                 because `sm`'s `px-2.5` around four characters is a button narrower
                 than its own label is long. */
              className="min-w-20 [@media(pointer:coarse)]:min-h-11"
              disabled={!canSave}
            >
              {busy ? <Spinner /> : "Save"}
            </Button>
            {slot.set && remove}
          </form>
          {tooLong && <p className="mt-1 text-xs text-danger">That&apos;s too long to be a key.</p>}
        </>
      ) : (
        // Nothing typed here could help — but a key already saved must still be
        // removable, which is the whole property `tokenBlockFor` exists to hold.
        slot.set && <div className="mt-1 flex justify-end">{remove}</div>
      )}
    </div>
  );
}

/**
 * How often a live run is re-read, in both flows, and what their backoff
 * multiplies.
 *
 * ⚠ **It was the bare literal `700` in four places** — each poll body and each
 * of their two backoffs — so changing the cadence was a four-site edit with
 * nothing to say the fourth had been missed. 700ms is a transcript being read as
 * it arrives against one `GET` on a daemon that already holds the bytes.
 *
 * ⚠ **Two loops, and deliberately not one hook.** They share this number, a
 * `cancelled` flag, a cursor and a failure count — and they differ in the thing
 * that matters: a vanished *login* is restarted up to three times, and a
 * vanished *install* must never be, because an install restart is a second
 * `npm i -g` that may race the first one still running. Folding them would leave
 * a hook with one callback per difference — the 404 policy, the storage key, the
 * sentences, the run view, the tail cap — which is this structure again with an
 * indirection in front of it. The shared number was the part that could actually
 * drift, so that is the part that is shared.
 */
const POLL_MS = 700;

/** Scoped per machine and agent, so two wizards cannot adopt each other's run. */
function loginKey(machineId: MachineId, agent: string): string {
  return `reemoat.login.${machineId}.${agent}`;
}

/**
 * The same, for an install.
 *
 * ⚠ **A different prefix, and that is not tidiness.** A login run id and an
 * install run id are two id spaces on the daemon, and the two `DELETE` routes are
 * different routes — so a key one flow wrote and the other read would cancel the
 * wrong run, with the right-looking id in the request.
 */
function installKey(machineId: MachineId, agent: string): string {
  return `reemoat.install.${machineId}.${agent}`;
}

/**
 * The install id this tab last saw for one (machine, agent), or `null`.
 *
 * ⚠ **The install key is handed to `sessionStorage` here and in the two writers
 * below it, and nowhere else, so the `try` is written once.** `webcheck` sweeps
 * this file for a fourth place that touches it, which is the shape of claim that
 * survives: the count of readers and writers that used to stand in this sentence
 * was wrong about both halves one release after it was written.
 * `sessionStorage` *throws* rather than answering in a private window, and the
 * seeded-closed pane, the pane's own reattach, the live-run check and every
 * clearing arm each have to survive that — without storage the flow still works,
 * it simply will not survive a reload.
 */
function heldInstall(machineId: MachineId, agent: string): string | null {
  try {
    return window.sessionStorage.getItem(installKey(machineId, agent));
  } catch {
    // Private mode, or storage disabled. Only reattachment is lost.
    return null;
  }
}

function rememberInstall(machineId: MachineId, agent: string, installId: string): void {
  try {
    window.sessionStorage.setItem(installKey(machineId, agent), installId);
  } catch {
    // As above: the run is live either way, it just will not reattach.
  }
}

function forgetInstall(machineId: MachineId, agent: string): void {
  try {
    window.sessionStorage.removeItem(installKey(machineId, agent));
  } catch {
    // As above; nothing was stored, so there is nothing to remove.
  }
}

/**
 * The same, but only where the key still names the run the caller was watching.
 * Answers whether it did.
 *
 * ⚠ **One slot per (machine, agent) and more than one writer, so a clear that
 * does not compare can delete a *live* run's id.** The card's live-run adoption
 * and the install pane's two writes — its own start, and its adoption of a run it
 * did not start — are the three that write the
 * same key. So a pane seeded from a **stale** key — Hide while a run was going,
 * then the daemon's ten-minute sweep — polls an id that 404s, and by then the
 * key may hold a *newer* run's id that the adoption has just written down. A
 * clear by (machine, agent) at that moment throws away the only thing a later
 * mount could reattach to, and the next press meets `409 install_busy` about a
 * run nothing is watching. Every clearing arm goes through here; `forgetInstall`
 * above has no other caller, and `webcheck` pins that.
 */
function forgetInstallIf(machineId: MachineId, agent: string, installId: string | null): boolean {
  if (heldInstall(machineId, agent) !== installId) return false;
  forgetInstall(machineId, agent);
  return true;
}

/**
 * `POST /agent-install` calls that have been made and not yet answered, by
 * {@link installKey}.
 *
 * ⚠ **Because the effect that makes one runs twice.** React's development
 * `StrictMode` mounts, unmounts and remounts, and the remount is immediate: the
 * first `POST` has not answered, so the second run finds no id in
 * `sessionStorage`, and the live-run read it makes instead is too early to be
 * told about one either — so it falls through to a `POST` of its own. There is
 * one install run daemon-wide, so that second `POST` is refused with `409
 * install_busy` and the pane draws *Couldn't start the install* over a run that
 * is live and that it is about to adopt. Joining the promise instead means one
 * `POST` and one id for both mounts. The same map is what stops a double tap on
 * a slow link asking for two installs. **What it is no longer answerable for is
 * the id surviving a close** — `start()` writes it down above its own
 * `cancelled` test, which is where that fix lives.
 *
 * Module scope rather than a ref, because the two mounts share no component
 * instance. **Dropped as soon as it settles**: by the time anything could ask
 * again the id is in `sessionStorage`, `GET /agent-install` is the durable answer
 * regardless, and a promise held past its run would be a later press adopting a
 * finished install.
 */
const pendingInstalls = new Map<string, Promise<InstallRunView>>();

/** One `POST` per (machine, agent) in flight, whatever asks for it. */
function startInstall(
  daemon: DaemonClient,
  machineId: MachineId,
  agent: string,
): Promise<InstallRunView> {
  const key = installKey(machineId, agent);
  const inFlight = pendingInstalls.get(key);
  if (inFlight !== undefined) return inFlight;
  const started = daemon.startInstall(agent).finally(() => {
    pendingInstalls.delete(key);
  });
  pendingInstalls.set(key, started);
  return started;
}

/**
 * Something went wrong in the wizard, and whether it has given up.
 *
 * ⚠ **A state that is still retrying is not a failure, and one `text-danger` for
 * both said it was.** "Lost contact with that machine. Still trying…" was drawn
 * in precisely the red of "Cannot reach that machine right now." and of a
 * recognised, terminal login failure — so a single dropped poll on LTE, in the
 * middle of the one interaction that *requires* leaving the app and coming back,
 * looked exactly like the sign-in having died. It has not: the run lives ten
 * minutes on the daemon, the next poll is already scheduled, and the only
 * control on screen is Cancel, which is the one thing that would really end it.
 *
 * Carried as a field rather than decided at the `<p>` by matching on the
 * sentence, because a screen that picks its own colour by reading its own words
 * is one reword away from being wrong about it.
 */
interface Trouble {
  text: string;
  /** A poll is still scheduled. Drawn `text-muted`; only a give-up is red. */
  retrying: boolean;
}

function LoginWizard({
  machineId,
  agent,
  displayName,
  needsInput,
  loggedIn,
  checking,
  checkFailed,
  onClose,
  onDone,
}: {
  machineId: MachineId;
  /**
   * The id string, and it must stay one: the login effect's deps are
   * `[machineId, agent, attempt]`, so passing the `AgentAuthInfo` object would
   * restart a live login on every refetch.
   */
  agent: string;
  displayName: string;
  needsInput: boolean;
  /** The re-probed answer. Not in scope before, which is why the card deferred to a badge. */
  loggedIn: boolean | null | undefined;
  checking: boolean;
  checkFailed: boolean;
  onClose: () => void;
  /** The flow ended. Re-read the agent's status now rather than on close. */
  onDone: () => void;
}): ReactNode {
  const [attempt, setAttempt] = useState(0);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [done, setDone] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [trouble, setTrouble] = useState<Trouble | null>(null);
  const paneRef = useRef<HTMLPreElement | null>(null);
  /*
   * Held in a ref, and deliberately not in the effect's dependency list.
   *
   * `onDone` is recreated on every render of the section above, so listing it
   * would tear down and restart the login on every render — killing a flow
   * somebody is in the middle of. A ref keeps the effect stable while still
   * calling the current function rather than one captured on mount.
   */
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setTrouble({ text: "That machine is not reachable.", retrying: false });
      return;
    }

    const storageKey = loginKey(machineId, agent);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let id: string | null = null;
    let cursor = 0;
    /*
     * Consecutive failed polls.
     *
     * A dropped request used to end the flow: the catch below set an error and
     * simply stopped rescheduling, so one blip on LTE — mid-way through the one
     * interaction that *requires* leaving the app and coming back — left a live
     * login on the daemon with nothing reading it, and the only control on
     * screen was Cancel, which kills it. The run lives ten minutes; a poll is
     * cheap and idempotent; so it keeps trying, and only gives up once the
     * failures are plainly not transient.
     */
    let failures = 0;
    const MAX_FAILURES = 5;
    /*
     * How many times a vanished run has been restarted.
     *
     * A 404 means the run is gone, and restarting is right — it is how a wizard
     * recovers from an expired run or a daemon that restarted under it. What is
     * not right is doing it without a bound: paired with a daemon that superseded
     * this run for a reason that will recur, an unconditional restart is an
     * infinite loop of pty spawns with no backoff.
     */
    let restarts = 0;
    const MAX_RESTARTS = 3;

    const finish = (): void => {
      setDone(true);
      // Immediately, not when the wizard is dismissed. The result line says the
      // login worked and the badge two lines above it said "not signed in" until
      // the card was closed, which reads as the login not having worked.
      onDoneRef.current();
      // The run is over; nothing to reattach to on the next mount.
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        // Private mode, or storage disabled. Only reattachment is lost.
      }
    };

    const poll = (): void => {
      if (cancelled || id === null) return;
      void daemon
        .readLogin(id, cursor)
        .then((page) => {
          if (cancelled) return;
          failures = 0;
          setTrouble(null);
          cursor = page.cursor;
          if (page.chunk.length > 0) setOutput((previous) => previous + page.chunk);
          if (page.done) {
            finish();
            return;
          }
          timer = setTimeout(poll, POLL_MS);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          // A 404 means the run is gone — expired, superseded, or from a daemon
          // that has restarted since. Start a fresh one rather than showing an
          // error about an id the person never saw.
          if (ApiError.isApiError(cause) && cause.status === 404) {
            try {
              window.sessionStorage.removeItem(storageKey);
            } catch {
              // As above.
            }
            id = null;
            if (restarts >= MAX_RESTARTS) {
              setTrouble({
                text: "That machine keeps stopping this sign-in. Try again in a moment.",
                retrying: false,
              });
              return;
            }
            restarts += 1;
            begin();
            return;
          }
          failures += 1;
          /*
           * ⚠ Two failure channels, and merging them would tell somebody to save
           * a key because their phone dropped to LTE. `view.message` means *the
           * sign-in program on your machine cannot do this*; this one means *we
           * lost contact, it may still be fine*. The daemon's own wording moves
           * into the terminal pane, which is where developer detail lives.
           *
           * And this channel splits again on the same line that decides whether
           * to reschedule, which is the only place the two can be guaranteed to
           * agree: while a poll is still coming the sentence is `retrying`, and
           * it is drawn quietly. See {@link Trouble}.
           */
          setTrouble(
            failures < MAX_FAILURES
              ? { text: "Lost contact with that machine. Still trying…", retrying: true }
              : {
                  text: "Cannot reach that machine — the sign-in may still be running.",
                  retrying: false,
                },
          );
          // Kept alive across a transient failure. Backed off a little so a
          // daemon that is genuinely struggling is not polled harder for it, and
          // given up on only after several in a row.
          if (failures < MAX_FAILURES) timer = setTimeout(poll, POLL_MS * failures);
        });
    };

    const adopt = (runId: string): void => {
      id = runId;
      setLoginId(runId);
      try {
        window.sessionStorage.setItem(storageKey, runId);
      } catch {
        // As above: the flow still works, it just will not survive a reload.
      }
      poll();
    };

    const begin = (): void => {
      void daemon
        .startLogin(agent)
        .then((run) => {
          if (cancelled) {
            // Started and abandoned in the same tick — cancel it rather than
            // leaving a pty waiting on stdin for its ten-minute TTL.
            void daemon.cancelLogin(run.loginId).catch(() => {});
            return;
          }
          adopt(run.loginId);
        })
        .catch((cause: unknown) => {
          // Framed for `SignOutButton`'s reason, and terminal: nothing
          // reschedules a start, so this is the wizard giving up before it had
          // anything to poll.
          if (!cancelled) {
            setTrouble({ text: `Couldn't start the sign-in — ${errorText(cause)}.`, retrying: false });
          }
        });
    };

    let existing: string | null = null;
    try {
      existing = window.sessionStorage.getItem(storageKey);
    } catch {
      // As above.
    }

    // Reattach if this tab already had one running. Reading from cursor 0 replays
    // the whole transcript the daemon still holds, so the page link and the code
    // are back on screen exactly as they were.
    if (existing !== null) adopt(existing);
    else begin();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [machineId, agent, attempt]);

  /*
   * A fresh run, in place. Safe to add to the deps above for the same reason the
   * ref is kept out of them: `refresh()` landing changes `loggedIn`/`checking`,
   * neither of which is a dependency.
   */
  const retry = (): void => {
    setOutput("");
    setDone(false);
    setLoginId(null);
    setTrouble(null);
    setAttempt((n) => n + 1);
  };

  // Follow the tail of the raw pane, for whoever opened it.
  useEffect(() => {
    const pane = paneRef.current;
    if (pane !== null) pane.scrollTop = pane.scrollHeight;
  }, [output]);

  const send = (): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined || loginId === null || sending) return;
    const text = input;
    /*
     * The box empties only once the daemon confirms the code landed. It was
     * cleared before the write (review D8), which is the optimistic paint
     * `web-shell.md` forbids: a device code is sent once and unrecoverable if it
     * evaporates, so a failed write left an empty box beside a toast saying to
     * try again, with nothing left to try with. Framed for `SignOutButton`'s
     * reason: on this card a bare "the connection failed…" could be about the
     * sign-in, the sign-out or either key box.
     *
     * **And once at a time.** `sending` refuses a second Enter or tap while the
     * first is in flight: before the clear moved into `.then` the second send
     * was an empty line, and after it the same code twice (E9's review). The
     * early return is the guard and the button says so; the box stays enabled,
     * because disabling a focused input drops the caret out of it. An *empty*
     * send is still allowed on purpose — the daemon appends the newline, so it
     * is a bare Enter, which a prompt may be waiting for.
     */
    setSending(true);
    void daemon
      .writeLogin(loginId, text)
      .then(() => setInput(""))
      .catch((cause: unknown) => toast("error", `Couldn't send that — ${errorText(cause)}.`))
      .finally(() => setSending(false));
  };

  const close = (cancel: boolean): void => {
    const daemon = store.daemonFor(machineId);
    if (cancel && daemon !== undefined && loginId !== null) {
      void daemon.cancelLogin(loginId).catch(() => {});
    }
    try {
      window.sessionStorage.removeItem(loginKey(machineId, agent));
    } catch {
      // Nothing to do — the run expires on its own.
    }
    onClose();
  };

  const view = readLoginTranscript(output, done, needsInput);
  /*
   * Only on a clean exit. A recognised failure IS the outcome and already says
   * what to do; drawing a verdict under it would be two answers to one question.
   */
  const outcome: LoginOutcome | null =
    view.phase === "done" ? loginOutcome(checking, checkFailed, loggedIn) : null;

  /*
   * ⚠ **The step numbers are counted off what is actually on screen, because two
   * blocks wrote "Step 2" and neither could see the other.**
   *
   * They were three hardcoded ordinals under three independent conditions:
   * "Step 1 — open this page" on `view.url !== null`, "Step 2 — enter this code
   * there" on `view.code !== null`, and "Step 2 — paste what the page gives you
   * back here" on `needsInput && !done`. Both ways of getting that wrong are
   * reachable, on the flow in this product with the least tolerance for either.
   * An agent with `interactiveStdin` during `starting` — claude, before its CLI
   * has printed anything — drew a spinner and a Step 2 with no Step 1 anywhere.
   * And `extractCode`'s patterns are declared guesses in `ui/login.ts` matched
   * against prose any vendor may reword, so one hit on claude's paste flow put
   * two different Step 2s on screen at once.
   *
   * So an ordinal is a position among the blocks actually drawn, in `order` —
   * this component's own render order, stated once. **Each block's gate below is
   * the same `const` that puts it in `steps`**, so a block cannot be drawn
   * without being counted or counted without being drawn; a second expression
   * mirroring the first is exactly how three ordinals came apart in the first
   * place. `url` and `code` are read out of `view` for the same reason and one
   * more: a property access cannot be narrowed inside the code block's callback,
   * which is why that one needed a `?? ""` that could never fire.
   *
   * **And the number is dropped entirely when only one block is drawn.** "Step 1"
   * with no step 2 anywhere promises a sequence that does not exist, and the
   * imperative on its own is already the whole instruction. That is also the
   * `starting` case above, which is the state this was worst in.
   *
   * The page block's caption was cut on 2026-09-04 for fewer words: the ordinal
   * now rides the link's own text, through the same `stepLabel` and the same
   * `showPage` const that gates the block, so the counting invariant is unchanged.
   */
  const { url, code } = view;
  const showPage = url !== null;
  const showCode = code !== null;
  const showInput = needsInput && !done;
  const steps = { page: showPage, code: showCode, input: showInput };
  const order: (keyof typeof steps)[] = ["page", "code", "input"];
  const stepLabel = (which: keyof typeof steps, imperative: string): string => {
    const drawn = order.filter((key) => steps[key]);
    const at = drawn.indexOf(which);
    if (drawn.length < 2 || at < 0) return imperative;
    return `Step ${at + 1} — ${imperative}`;
  };

  return (
    <div className="mt-2 space-y-2">
      {trouble !== null && (
        // Muted while a poll is still coming, red only once the wizard has
        // stopped trying. See {@link Trouble} for what one red for both cost.
        <p className={`text-xs ${trouble.retrying ? "text-muted" : "text-danger"}`}>
          {trouble.text}
        </p>
      )}
      {view.message !== null && (
        <p className={`text-xs ${view.phase === "failed" ? "text-danger" : "text-fg font-medium"}`}>
          {view.message}
        </p>
      )}

      {view.phase === "starting" && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner /> starting {agent}'s sign-in…
        </p>
      )}

      {/* `plain`, not `bg-fg`. That fill is the affirmative action *inside* a
          decision — Send, and the reversible approval on the ask card — and this
          is a navigation, to another origin in another tab. The value on this
          screen that earns a real fill is the device code below, which is one of
          the three documented exceptions and takes `bg-raised`. */}
      {showPage && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="tap press flex min-h-11 items-center gap-2 rounded-md border border-edge-strong bg-surface px-3 text-sm font-medium text-fg hover:bg-raised"
        >
          <Icon as={ExternalLink} size={14} />
          {stepLabel("page", "Open the sign-in page")}
        </a>
      )}

      {/* Same argument as `OneTimeSecret`: a device code expires in fifteen
          minutes and is the whole of what this screen is for, so it gets the full
          `raised` step rather than the rail's tone, which is 1.06:1 here. */}
      {showCode && (
        <div className="rounded-md border border-edge bg-raised p-3">
          <div className="text-2xs text-muted">{stepLabel("code", "enter this code there")}</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-lg tracking-widest">
              {code}
            </code>
            {/* An `IconButton`, not a `Button` wrapping an `<Icon>` — that was
                44px tall and ~38px wide, on the one control a person taps to
                capture a code that is shown once, on a phone. */}
            <IconButton icon={Copy} label="Copy the code" size="lg" onClick={() => copy(code)} />
          </div>
        </div>
      )}

      {(view.phase === "acting" || view.phase === "waiting") && (
        <p className="text-xs text-muted">You can leave this page.</p>
      )}

      {view.phase === "waiting" && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner /> Waiting for you to finish on that page…
        </p>
      )}

      {/*
       * **The card says what happened, instead of pointing at a badge.**
       *
       * It read "Finished. The status above says whether it worked." while the
       * badge above was drawing the pre-login listing — "not signed in" by
       * construction, since that is what put the button on screen. The fact was
       * never unknowable; it was simply never passed down. `finish()` calls
       * `onDone` → `refresh()` in the same batch as `setDone(true)`, so the first
       * frame with `done` already has `checking`, and the answer is fresh: the
       * read that reported `done` had already dropped the probe cache. Q3.430.
       */}
      {outcome === "checking" && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner /> Checking with your machine…
        </p>
      )}
      {outcome === "signedIn" && (
        <p className="flex items-center gap-1.5 text-xs text-fg">
          <Icon as={Check} size={14} /> Signed in to {displayName}.
        </p>
      )}
      {outcome === "notSignedIn" && (
        <p className="text-xs text-fg">That didn&apos;t sign {displayName} in. Try again.</p>
      )}
      {/* Never "signed in", never "failed", and never styled as an alarm: for
          kimi this is the ordinary ending. */}
      {outcome === "cannotTell" && (
        <p className="text-xs text-muted">Finished — start a chat to check.</p>
      )}
      {outcome === "unreachable" && (
        <p className="text-xs text-danger">Couldn&apos;t reach that machine to check whether it worked.</p>
      )}

      {showInput && (
        <div>
          <label className="text-2xs text-muted" htmlFor={`login-${agent}`}>
            {stepLabel("input", "paste the code from that page")}
          </label>
          <div className="mt-1 flex gap-3">
          <input
            id={`login-${agent}`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                send();
              }
            }}
            disabled={loginId === null}
            className={`${FIELD} min-w-0 flex-1 font-mono disabled:opacity-40`}
          />
          <Button onClick={send} disabled={loginId === null || sending}>
            {sending ? <Spinner /> : "Send"}
          </Button>
          </div>
        </div>
      )}

      {/*
        Open by itself when nothing was recognised — the fallback rule, and the
        reason the parser is allowed to be a guess at all. `transcriptIsTheAnswer`
        is a predicate in `ui/login.ts` rather than a condition spelled out here,
        so `webcheck` asserts the rule and not a copy of it.
      */}
      <details open={rawTranscriptIsOpen(view, outcome)}>
        <summary className="tap list-none text-2xs text-muted hover:text-fg">
          Show terminal output
        </summary>
        <pre
          ref={paneRef}
          className="mt-1 max-h-56 overflow-auto rounded-sm bg-surface p-2 font-mono text-2xs whitespace-pre-wrap wrap-anywhere text-fg/80"
        >
          {output.length === 0 ? "starting…" : output}
        </pre>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        {outcome === "notSignedIn" && (
          <Button tone="primary" onClick={retry}>
            Try again
          </Button>
        )}
        {outcome === "unreachable" && <Button onClick={onDone}>Check again</Button>}
        <Button tone="ghost" onClick={() => close(!done)}>
          {done ? "Close" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Putting a harness on a machine, with its own run attached.
 *
 * ⚠ **Beside `LoginWizard` rather than inside `src/install.ts`'s world**, because
 * it is the same *shape* of thing: one card, one machine, one agent, a run id in
 * `sessionStorage` and a cursor transcript. What it deliberately does not copy
 * from that wizard is its restart, below.
 */
function InstallPane({
  machineId,
  agent,
  displayName,
  available,
  checking,
  checkFailed,
  onDone,
  onClose,
}: {
  machineId: MachineId;
  agent: string;
  displayName: string;
  available: boolean;
  checking: boolean;
  checkFailed: boolean;
  onDone: () => void;
  onClose: () => void;
}): ReactNode {
  const [run, setRun] = useState<InstallRunView | null>(null);
  const [output, setOutput] = useState("");
  const [gap, setGap] = useState(false);
  const [trouble, setTrouble] = useState<Trouble | null>(null);
  const [now, setNow] = useState(0);
  // `LoginWizard`'s reason verbatim: listing it would restart the run on every
  // render of the section above.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  /*
   * The same, for the one arm that hands the slot back rather than reporting on
   * it: a run this pane adopted and the daemon has never heard of. See the 404
   * branch below.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setTrouble({ text: "That machine is not reachable.", retrying: false });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let id: string | null = null;
    let cursor = 0;
    let failures = 0;
    const MAX_FAILURES = 5;
    /**
     * The transcript, held beside the state rather than only in it.
     *
     * ⚠ **So the drop and the notice are decided in one place.** The cap is on
     * the string this pane keeps, and *whether anything was dropped* is
     * {@link keepInstallTail} having answered a shorter one — which a `setOutput`
     * updater may not report, because an updater that sets other state is a
     * side effect React is free to run twice. A local per effect run also means
     * a reattach replaying from cursor 0 rebuilds it exactly.
     */
    let text = "";
    /**
     * Whether any read has come back, which is what the 404 arm branches on.
     */
    let seen = false;

    const poll = (): void => {
      if (cancelled || id === null) return;
      void daemon
        .readInstall(id, cursor)
        .then((chunk) => {
          if (cancelled) return;
          failures = 0;
          seen = true;
          setTrouble(null);
          cursor = chunk.cursor;
          if (chunk.chunk.length > 0) {
            const grown = text + chunk.chunk;
            text = keepInstallTail(grown);
            /*
             * ⚠ **A drop on this side is the same claim as a drop on the
             * daemon's, and owes the same sentence.** The raw pane's whole
             * licence is that it is the complete record, so the notice is not
             * `gap`'s alone: the daemon front-drops past its own 64 KiB and so
             * does this, and a reader cannot tell — nor should have to.
             */
            if (text.length < grown.length) setGap(true);
            setOutput(text);
          }
          if (chunk.gap) setGap(true);
          setRun(chunk);
          if (chunk.done) {
            /*
             * Immediately, not on dismissal — `LoginWizard.finish`'s measured
             * rule: the result line saying it worked, over a badge two lines up
             * still reading "not installed", reads as it not having worked.
             */
            onDoneRef.current();
            forgetInstallIf(machineId, agent, id);
            return;
          }
          timer = setTimeout(poll, POLL_MS);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          /*
           * ⚠ **A vanished run is not restarted, and this is the one place this
           * pane must not copy the login wizard.** That one restarts up to three
           * times because a lost pty costs nothing and restarting is how it
           * recovers from an expired run. An install restart is a *second* `npm
           * i -g`, which may race a first one still running on the daemon. So:
           * stop, drop the key if it is still this run's, and let the re-read say
           * what actually happened — `installResult` has a definite answer either
           * way.
           */
          if (ApiError.isApiError(cause) && cause.status === 404) {
            // By the id this poll was made with, never by (machine, agent):
            // `forgetInstallIf` is the whole of why.
            forgetInstallIf(machineId, agent, id);
            id = null;
            /*
             * ⚠ **A run this pane never saw a byte of is not news, and the
             * Install button is the honest answer.** "Hide" leaves the stored id
             * in place on purpose — a run somebody walked away from is still
             * there when they come back — so ten minutes later the daemon has
             * swept the run and the key names nothing. The pane then opened
             * straight onto *That machine stopped reporting the install*, where
             * the truth was that there was nothing to report. Handing the slot
             * back draws the button instead. Where a read **has** landed the
             * sentence is right and stays: that run existed, this tab watched
             * it, and it went away mid-flight.
             */
            if (!seen) {
              onCloseRef.current();
              return;
            }
            onDoneRef.current();
            setTrouble({ text: `That machine stopped reporting the install.`, retrying: false });
            return;
          }
          failures += 1;
          setTrouble({ text: errorText(cause), retrying: failures < MAX_FAILURES });
          if (failures < MAX_FAILURES) timer = setTimeout(poll, POLL_MS * failures);
        });
    };

    const follow = (installId: string): void => {
      id = installId;
      poll();
    };

    const start = (): void => {
      void startInstall(daemon, machineId, agent)
        .then((view) => {
          /*
           * ⚠ **Written down before the `cancelled` test, and that order is the
           * fix.** The run is on the daemon either way, so a pane closed before
           * the `POST` answered used to drop the only id anybody had — and there
           * is one run daemon-wide, so the next press met `409 install_busy`
           * about a run nothing was watching. Now the id survives the close and
           * the next mount adopts it.
           */
          rememberInstall(machineId, agent, view.installId);
          if (cancelled) return;
          setRun(view);
          follow(view.installId);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          // Never reached a transcript, so it is framed rather than forwarded —
          // `SignOutButton`'s rule, which every write on this card follows.
          setTrouble({ text: `Couldn't start the install — ${errorText(cause)}.`, retrying: false });
        });
    };

    const held = heldInstall(machineId, agent);
    if (held !== null) {
      follow(held);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    /*
     * ⚠ **The daemon is asked what it is already running before anything is
     * started.** There is one install run daemon-wide and the stored id is per
     * tab and per agent, so two real cases reached this pane with nothing to
     * reattach to: a reload where storage is unavailable, and a run this tab never
     * learned the id of — one started on this card in another tab or on another
     * device. Each of them pressed Install and got `409 install_busy` about a run
     * it could have been watching instead. `GET /agent-install` names it, and the
     * id it answers with is the id `DELETE` takes — so Stop works on an adopted
     * run exactly as on one this pane started.
     *
     * ⚠ **`run.agent` is checked, and `done` with it.** The daemon retains a
     * finished run for ten minutes to answer a late poll, and adopting one would
     * be this pane reporting on somebody else's install — or replaying a result
     * for an agent whose card this is not.
     */
    void daemon
      .liveInstall()
      .then((live) => {
        if (cancelled) return;
        const running = live.run;
        if (running !== null && running.agent === agent && !running.done) {
          rememberInstall(machineId, agent, running.installId);
          setRun(running);
          follow(running.installId);
          return;
        }
        start();
      })
      .catch(() => {
        /*
         * An older daemon has no such route and answers a bare `404`, and a
         * dropped request looks the same. Neither is evidence about a run, so
         * this falls through to the press somebody actually made — which is the
         * behaviour this whole branch replaced, and `409` is still a sentence
         * `errorText` can draw.
         */
        if (!cancelled) start();
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [machineId, agent]);

  const running = run !== null && !run.done;
  /*
   * ⚠ **One interval, re-reading `Date.now()` rather than counting ticks** —
   * `MachineInstalls`' measured shape, so a phone that slept through half an
   * install comes back with the true elapsed time. Torn down the moment nothing
   * is running.
   */
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(clock);
  }, [running]);

  const result = run?.done === true ? installResult(checking, checkFailed, available) : null;
  const failure = run?.done === true ? installFailure(run.outcome, displayName) : null;
  const elapsed = run === null ? null : installElapsed(run.startedAt, now);
  const step = installStep(run?.phase ?? null);

  return (
    <div className="mt-2">
      {running && (
        <>
          <p className="flex items-center gap-2 text-xs text-muted">
            <Spinner />
            <span className="min-w-0 flex-1 truncate">
              {step ?? `Installing ${displayName}…`}
              {elapsed === null ? "" : ` · ${elapsed}`}
            </span>
          </p>
          {/* An `sr-only` live region, because the line above changes under a
              spinner nobody reading by ear can see. `polite` and one sentence:
              this must not chatter once a second. */}
          <p className="sr-only" role="status" aria-live="polite">
            {step ?? `Installing ${displayName}`}
          </p>
        </>
      )}
      {failure !== null && <p className="mt-2 text-xs wrap-anywhere text-danger">{failure}</p>}
      {result !== null && failure === null && (
        <p className={`mt-2 text-xs ${result === "unreachable" ? "text-danger" : "text-muted"}`}>
          {result === "checking" ? (
            <span className="flex items-center gap-2">
              <Spinner /> Checking with your machine…
            </span>
          ) : (
            installResultLine(result, displayName)
          )}
        </p>
      )}
      {trouble !== null && (
        <p className={`mt-2 text-xs ${trouble.retrying ? "text-muted" : "text-danger"}`}>
          {trouble.retrying ? `${trouble.text} — still trying` : trouble.text}
        </p>
      )}
      {output.length > 0 && (
        <details className="mt-2" open={rawInstallIsOpen(run)}>
          {/* The same class string the login transcript's summary carries, and
              `tap list-none` rather than a cursor: only `PaneHandle` may set one,
              because a pointer shape claiming ordinary text is pressable is the
              thing that ban is about. `webcheck` sweeps every file for it. */}
          <summary className="tap list-none text-2xs text-muted hover:text-fg">
            What the installer said
          </summary>
          {gap && (
            // The one thing the raw pane's whole licence rests on is that it is
            // the complete record; when it is not, it has to say so.
            <p className="mt-1 text-2xs text-muted">Some earlier output was dropped.</p>
          )}
          <pre className="mt-1 max-h-56 overflow-auto rounded-sm bg-surface p-2 font-mono text-2xs whitespace-pre-wrap wrap-anywhere text-fg/80">
            {output}
          </pre>
        </details>
      )}
      <div className="mt-2 flex justify-end gap-2">
        {running && (
          <Button
            tone="ghost"
            onClick={() => {
              const daemon = store.daemonFor(machineId);
              const id = run?.installId;
              if (daemon === undefined || id === undefined) return;
              void daemon
                .cancelInstall(id)
                .catch((cause: unknown) => setTrouble({ text: errorText(cause), retrying: false }));
            }}
          >
            Stop
          </Button>
        )}
        <Button tone="ghost" onClick={onClose}>
          {running ? "Hide" : "Close"}
        </Button>
      </div>
    </div>
  );
}

/*
 * Through `copyText`: this is a device code being read off a phone against a
 * plain-http LAN origin, where `navigator.clipboard` is absent rather than
 * refusing — so the error arm below was the *only* arm that ever ran there, and it
 * ran as a rejection that never happened. Both outcomes are still reported,
 * because a device code has a clock on it and silence costs a retry.
 */
function copy(text: string): void {
  void copyText(text).then((ok) => {
    toast(ok ? "ok" : "error", ok ? "code copied" : "could not copy — select it by hand");
  });
}



/**
 * What to say after a credential is written, given how many chats were relaunched.
 *
 * `undefined` is **not** zero: a daemon predating the relaunch omits the field
 * entirely, and telling somebody "0 chats" there would be a confident claim about
 * behaviour that daemon does not have. It falls back to the sentence that was
 * always true.
 *
 * ⚠ **Every tail was written for a save and then reused for a removal, where
 * each of them is false.** `credentialToast(true, 2)` read "Removed. 2 chats are
 * restarting to pick it up." — there is nothing to pick up; they are restarting
 * for the opposite reason, which is that the key they were holding is gone. And
 * "Checking whether it works…" is about a key that now exists: after a removal
 * the refetch is checking what that agent is left with, not whether anything
 * works. Only the head varied, so only the head was ever right.
 */
export function credentialToast(removing: boolean, restarting: number | undefined): string {
  const head = removing ? "Removed." : "Saved.";
  /*
   * A removal with nothing to relaunch ends at the full stop. The chip beside
   * the box going out is the confirmation, and a tail here would have to invent
   * a claim about a machine that was asked to stop using something.
   */
  const quiet = removing ? head : `${head} Checking whether it works…`;
  if (restarting === undefined) return quiet;
  if (restarting === 0) return quiet;
  const chats = restarting === 1 ? "1 chat is" : `${restarting} chats are`;
  return `${head} ${chats} restarting ${removing ? "without it" : "to pick it up"}.`;
}
