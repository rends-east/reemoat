import { Check, Copy, ExternalLink, LogIn, LogOut, RefreshCw, X } from "lucide-react";
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
} from "../../wire";
import { Badge, Button, ChoiceRow, DangerButton, Empty, FIELD, Icon, IconButton, Spinner } from "../bits";
import { copyText } from "../clipboard";
import { CommandLine } from "../CommandLine";
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
 * What is here now: `AgentChooser`, a list of three with their status, and
 * `AgentDetail`, one agent's whole configuration — sign in, credentials,
 * permissions.
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
   * This one is called imperatively — on mount, from `changed()` after every
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
 * Pick an agent.
 *
 * A list rather than a dropdown, and with three entries that is not a close
 * call: the list is the size of the control that would hide it, and it shows all
 * three statuses at once — which is the question somebody arriving here is
 * usually asking.
 */
export function AgentChooser({
  machineId,
  onPick,
}: {
  machineId: MachineId;
  onPick: (agent: AgentId) => void;
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
      // A read that did not come back, which is what `failed` is for — and the
      // one branch on this screen that had no way out of itself: "Check again"
      // lives in the success arm, so a first read that failed left the whole
      // section inert until somebody navigated away and back.
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

  return (
    <div className="mt-4 space-y-2">
      {/* The read failed and the rows below are the last good answer. The same
          arm, the same sentence and the same defect as `AgentDetail`'s — see
          {@link StaleNotice} — and it rendered nowhere here for just as long. */}
      {error !== null && <StaleNotice />}
      {listing.agents.map((agent) => {
        const status = statusOf(agent);
        return (
          /*
           * ⚠ **`ChoiceRow`, and the border is the reason.** This was the row's
           * own class string: `border-edge` with `hover:border-edge-strong`. That
           * is a decorative 1.31:1 hairline standing as the *sole* identification
           * of a control on the sheet's white ground, and then a hover that moves
           * that hairline instead of a fill — the two things `index.css` states
           * about those tokens, broken in one attribute. A phone has no hover at
           * all, so what was actually on screen there was three passive-looking
           * cards.
           *
           * `SystemChooser` one file over is the same list with the same badge and
           * has already made this move; the two sit one tap apart inside pop-ups
           * meant to read as one app, so they may not differ. The badge goes in
           * `trailing`, which is what this row could do and the other two copies
           * of it — `MachinesSection`'s and `InstalledList`'s — cannot: theirs sit
           * *inside* the title line, and that is a prop `ChoiceRow` does not have.
           */
          <ChoiceRow
            key={agent.id}
            title={agent.displayName}
            subline={agent.id}
            /* `null` is a state with nothing to report rather than a state that
               failed to load — see `agentBadge`. Nothing is drawn, and the row's
               own name is then the whole of it. */
            trailing={status !== null ? <Badge tone={status.tone}>{status.text}</Badge> : undefined}
            onClick={() => onPick(agent.id)}
          />
        );
      })}
      <RecheckButton onClick={refresh} busy={loading} />
    </div>
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
 * ⚠ **One sentence for both halves of this screen, and for a release only one of
 * them drew it at all.** `AgentDetail` records the fix — `error` was rendered
 * solely inside its `listing === null` branch, so a machine that went unreachable
 * *after* a successful read froze the card on a stale badge for ever with nothing
 * saying so — and `AgentChooser` had exactly the same arm with exactly the same
 * gap. Shared rather than typed out twice, because a second copy is how one of
 * the two gets reworded and the two screens start disagreeing about the same
 * failure.
 *
 * `text-muted` and not `text-danger`: nothing has failed permanently here. What
 * is below was true a moment ago, and "Check again" is on screen.
 */
function StaleNotice(): ReactNode {
  return (
    <p className="text-xs text-muted">
      Couldn&apos;t reach that machine — what&apos;s below may be out of date.
    </p>
  );
}

/** One agent: sign in, credentials, permissions. */
export function AgentDetail({
  machineId,
  agentId,
  title,
  keyEnv,
  onChanged,
}: {
  machineId: MachineId;
  agentId: AgentId;
  /**
   * What to call this card, where the harness's own name is not what the reader
   * came for.
   *
   * The systems screen passes the *system's* name — "Anthropic" over a card that
   * drives `claude auth login` — because that is what somebody has an account
   * with. Omitted, it is the harness, which is what `NewSession`'s inline
   * sign-in wants: there the tile above it says `Claude`, and a card underneath
   * headed `Anthropic` would read as a different subject.
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
   * what the agents screen and `NewSession`'s inline door both want.
   */
  keyEnv?: string | null;
  /**
   * Something here changed what another screen already read.
   *
   * `NewSession` mounts this inline and drives its agent tiles from a *different*
   * route (`GET /agents`), so a sign-in finished in here left those tiles stale.
   * It used to bump its own epoch from a duplicate "re-check" button sitting
   * under this component; that button is gone, so the signal travels properly
   * instead. Fired only from acts a person took — never on mount, which would
   * spend a request on every open. Q3.431.
   */
  onChanged?: () => void;
}): ReactNode {
  const { listing, error, loading, refresh } = useAgentAuth(machineId);
  const changed = (): void => {
    refresh();
    onChanged?.();
  };

  if (loading && listing === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Asking that machine…
      </div>
    );
  }
  if (listing === null) {
    return (
      // `failed`, and a way out of the branch — see `AgentChooser`'s twin above.
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
       * `AgentChooser` had the identical gap and now draws the identical
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
        onChanged={changed}
      />

      <RecheckButton onClick={changed} busy={loading} />
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
  const line = wholeAgent ? stanceLine(agent, stance, canSignIn, os) : null;
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

      {wizard ? (
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
      ) : stance === "signed_in" ? (
        /*
         * **Signed in, so the card holds one control and it is centred.**
         *
         * "✓ Signed in" is deleted: it repeated the badge 40px above it, and
         * deleting it is what frees the box to be centred at all.
         *
         * `canSignOut !== false` and not `=== true`: an older daemon sends no
         * `login` object, so the field is `undefined`, and the old test sent
         * claude and codex down kimi's "no sign-out command" sentence — false for
         * two of the three, in the arm nobody tests. Offer the button and let the
         * route answer `503` with its own correct sentence.
         */
        login.canSignOut !== false ? (
          <SignOutButton machineId={machineId} agent={agent} onChanged={onChanged} />
        ) : (
          <p className="mt-2 text-xs text-muted">{signOutSentence(agent.id, stored)}</p>
        )
      ) : canSignIn ? (
        <Button tone="primary" className="mt-2 w-full" onClick={() => setWizard(true)}>
          <Icon as={LogIn} size={14} />
          Sign in to {harnessName(agent)}
        </Button>
      ) : null}

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
 * The same shape and the same reason as retiring a machine or deleting a person:
 * both groups lay out left-to-right in one box so the last child occupies the
 * same pixels, and `.tap` removes the double-tap delay — so a second tap aimed at
 * a control that looked like it did nothing lands on Cancel rather than on the
 * irreversible half. Held per row, in the row's own component.
 *
 * `danger` on the **first** tap, unlike Retire on the machines list: retiring a
 * machine is undone by enrolling it again from the same screen, while signing out
 * ends the session on that host for every use of the CLI, not only for Reemoat,
 * and getting back in is a device-code flow through another tab.
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
  const [busy, setBusy] = useState(false);

  const run = (): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      toast("error", "That machine is not reachable.");
      return;
    }
    setBusy(true);
    void daemon
      .signOut(agent.id)
      .then(() => {
        setConfirming(false);
        onChanged();
      })
      /*
       * **Framed, not dumped** — the first of four writes on this screen that
       * used to hand `errorText`'s answer straight to a toast.
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
      .catch((cause: unknown) =>
        toast("error", `Couldn't sign ${harnessName(agent)} out — ${errorText(cause)}.`),
      )
      .finally(() => setBusy(false));
  };

  /*
   * **Centred, and Cancel still last.**
   *
   * This shipped `justify-end` on a geometric argument — the undo must occupy the
   * pixels the resting button had, so a second tap on a laggy connection cannot
   * land on the irreversible half — and the visible result was a Sign out button
   * pinned to the right of an empty box, which is not what was asked for and not
   * what this state should look like. The ordering rule survives the centring:
   * Cancel is still the last child, so it takes the right-hand side of a centred
   * pair, and the resting button's own centre falls in the **gap** between the two
   * answers rather than on Sign out. A second tap there hits nothing, which is the
   * safe outcome; the property the rule protects is that it must not hit the
   * destructive half, and it does not.
   *
   * One box, rendered identically in both states, so nothing else on the row can
   * move under a thumb — and the question takes `basis-full text-center`
   * unconditionally, so it is always on its own line and the answers are never
   * crushed on a 390px phone. In CSS, with no breakpoint anywhere.
   *
   * (The `justify-end` this replaced argued the geometry the other way, and its
   * paragraph sat here above `justify-center` code for a revision, stating a rule
   * the box did not implement.)
   */
  const box = "mt-2 flex flex-wrap items-center justify-center gap-2";

  if (!confirming) {
    return (
      <div className={box}>
        <DangerButton icon={LogOut} onClick={() => setConfirming(true)}>
          Sign out
        </DangerButton>
      </div>
    );
  }

  return (
    <div className={box}>
      <span className="basis-full text-center text-xs text-muted">
        Sign {harnessName(agent)} out on this machine?
      </span>
      <DangerButton icon={LogOut} disabled={busy} onClick={run}>
        {busy ? <Spinner /> : "Sign out"}
      </DangerButton>
      {/* Plain, not filled: `BUTTON_TONE`'s rule is a prohibition — a destructive
          button is never the filled one — which `plain` satisfies, and all eight
          shipped confirmations in this app use a default-tone Cancel. */}
      <Button disabled={busy} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </div>
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
          <div className="mt-3 flex gap-2">
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
              /* Shrunk with the field beside it and floored with it too. `min-w-20`
                 because `sm`'s `px-2.5` around four characters is a button narrower
                 than its own label is long. */
              className="min-w-20 [@media(pointer:coarse)]:min-h-11"
              onClick={() => withDaemon((daemon) => daemon.saveCredential(agent.id, slot.envName, value))}
              disabled={busy || value.trim().length === 0 || tooLong}
            >
              {busy ? <Spinner /> : "Save"}
            </Button>
            {slot.set && remove}
          </div>
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

/** Scoped per machine and agent, so two wizards cannot adopt each other's run. */
function loginKey(machineId: MachineId, agent: string): string {
  return `reemoat.login.${machineId}.${agent}`;
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
          timer = setTimeout(poll, 700);
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
                  text: "Cannot reach that machine right now. The sign-in may still be running on it.",
                  retrying: false,
                },
          );
          // Kept alive across a transient failure. Backed off a little so a
          // daemon that is genuinely struggling is not polled harder for it, and
          // given up on only after several in a row.
          if (failures < MAX_FAILURES) timer = setTimeout(poll, 700 * failures);
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
    if (daemon === undefined || loginId === null) return;
    const text = input;
    setInput("");
    // Framed for `SignOutButton`'s reason: on this card a bare "the connection
    // failed…" could be about the sign-in, the sign-out or either key box.
    void daemon
      .writeLogin(loginId, text)
      .catch((cause: unknown) => toast("error", `Couldn't send that — ${errorText(cause)}.`));
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
        <p className="text-xs text-muted">
          You can leave — this page will say when it&apos;s done.
        </p>
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
        <p className="text-xs text-fg">
          That didn&apos;t sign {displayName} in — the code may have expired, or the page
          wasn&apos;t finished.
        </p>
      )}
      {/* Never "signed in", never "failed", and never styled as an alarm: for
          kimi this is the ordinary ending. */}
      {outcome === "cannotTell" && (
        <p className="text-xs text-muted">
          Finished. This machine can&apos;t check whether {displayName} is signed in — start a chat
          to find out.
        </p>
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
          <Button onClick={send} disabled={loginId === null}>
            Send
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
        <summary className="tap cursor-pointer list-none text-2xs text-muted hover:text-fg">
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
