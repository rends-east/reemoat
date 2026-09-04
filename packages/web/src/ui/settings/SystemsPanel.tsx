import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { errorText, meansRouteAbsent } from "../../http";
import type { MachineId } from "../../ids";
import { MACHINE_GONE } from "../../plugins";
import { store } from "../../store";
import type { AgentAuthInfo, SystemInfo } from "../../wire";
import { anyKeySet, unspokenFor } from "../../agents";
import { boundedName, harnessName } from "../agentCard";
import { Badge, Button, ChoiceRow, DangerButton, Empty, FIELD, Icon, Spinner } from "../bits";
import { toast } from "../Toast";
import { AgentDetail } from "./AgentsPanel";

/*
 * Signing in to a *system*, on one machine.
 *
 * ⚠ **This screen used to be called Agents and asked you to sign in to `claude`.**
 * What you sign in to is Anthropic; `claude` is a program that reaches it. The two
 * were indistinguishable while each harness spoke only to its own vendor, and they
 * came apart the moment a harness could be pointed somewhere else — one Moonshot
 * key now serves `kimi` natively *and* Claude Code routed, so filing it under an
 * agent would have meant storing it twice and answering "signed in?" two ways.
 *
 * ⚠ **The wizard is still per harness, and that is not an inconsistency.** A
 * device-code login is a program being run — `claude auth login`, `codex login
 * --device-auth` — and a program belongs to a CLI. `SystemInfo.loginVia` is which
 * CLI drives a given system's flow, `null` where no CLI ships for it, and the two
 * arms below are that field read once.
 */

function useSystems(machineId: MachineId): {
  systems: SystemInfo[] | null;
  /**
   * Every harness this machine offers, or `null` where that read has not landed.
   *
   * ⚠ **A second read on a screen that had one, and it is not free.**
   * `GET /systems` is a table and spawns nothing; `GET /agent-auth` runs the login
   * probe, which is a CLI per agent. It is fetched because the list cannot be
   * assembled without it — `unspokenFor` needs the harnesses and their credential
   * slots, and no cheaper route carries them — and it is fetched *beside* the
   * first rather than after it, so the cost is one round trip rather than two.
   *
   * ⚠ **Its failure is not the list's failure.** A refused `GET /agent-auth`
   * leaves this `null` and `unspokenFor` answers nothing, so the screen draws the
   * providers exactly as it did before this existed. The reverse is not true and
   * must not be made so: without the systems there is no way to tell which
   * harnesses are already spoken for, and drawing them anyway is a duplicate row
   * for claude.
   */
  agents: AgentAuthInfo[] | null;
  error: string | null;
  /**
   * Whether this daemon has `GET /systems` at all.
   *
   * ⚠ **A third state, because "no answer" and "an answer that says this build is
   * older" need opposite screens** — and the pane below already described that
   * partition while this hook could not produce it. Every rejection set `error`,
   * so `systems === null` after a settled read implied `error !== null`, which
   * made the settled arm unreachable and drew a red triangle with a *Check again*
   * that asks the same daemon the same question for ever. `MachineAgentsSection`
   * has the same three states and is where the shape is copied from.
   */
  supported: boolean;
  loading: boolean;
  refresh: () => void;
} {
  const [systems, setSystems] = useState<SystemInfo[] | null>(null);
  const [agents, setAgents] = useState<AgentAuthInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const daemon = store.daemonFor(machineId);

  useEffect(() => {
    if (daemon === undefined) {
      /*
       * `store.daemonFor` answers `undefined` only where the machine is absent from
       * the listing, so this is a grant revoked in another tab or a machine retired
       * — never an unreachable host, which keeps its client. `PluginsPanel` carries
       * the argument in full.
       */
      setError(MACHINE_GONE);
      // Nothing was sent, so nothing is in flight: without this the initial `true`
      // never comes down, and the screen is a spinner with no way to ask again for
      // as long as it is open.
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    /*
     * Settled rather than raced, and the systems half decides `error`. What that
     * word means on this screen is "the list you are looking at may be out of
     * date", and a harness read that failed on its own leaves a list that is
     * complete about providers and silent about a row nobody has seen yet.
     */
    void Promise.allSettled([daemon.systems(), daemon.agentAuth()])
      .then(([listing, auth]) => {
        if (cancelled) return;
        if (listing.status === "fulfilled") {
          setSystems(listing.value.systems);
          setSupported(true);
          setError(null);
        } else {
          // An envelope-free 404 is this daemon saying it predates the route, which
          // is a settled answer and not a failure. See {@link meansRouteAbsent} and
          // the `Empty` below, which has always drawn the two arms differently.
          const absent = meansRouteAbsent(listing.reason);
          setSupported(!absent);
          setError(absent ? null : errorText(listing.reason));
        }
        // Never cleared on failure: a stale harness list beside a fresh provider
        // list is what `STALE_READ` above is already the sentence for.
        if (auth.status === "fulfilled") setAgents(auth.value.agents);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, epoch]);

  return {
    systems,
    agents,
    error,
    supported,
    loading,
    refresh: useCallback(() => setEpoch((n) => n + 1), []),
  };
}

/**
 * What a screen says when a **re**-read failed and the previous answer is still
 * drawn under it.
 *
 * ⚠ **This is `AgentDetail`'s line one file over, with this screen's own noun in
 * it — and the noun is the deliberate part.** `SystemDetail` mounts that
 * component directly below this sentence, so the two would otherwise draw the
 * identical string twice about one machine for the ordinary case where both
 * reads fail together (they share a transport: if `GET /systems` could not be
 * made, `GET /agent-auth` could not either). Two copies of one sentence read as a
 * bug rather than as two failed reads.
 *
 * A constant rather than a component because the *margin* differs at the two call
 * sites — one lands inside a `space-y-2` box, the other is the first child of a
 * bare `<div>` — and layout stays with the caller for the reason `FIELD` gives.
 * As a string rather than JSX text it also keeps its own apostrophes. The
 * wording was cut on 2026-09-04 for fewer words; the noun "systems" and the
 * "may be out of date" half are what it keeps.
 */
const STALE_READ = "Couldn't re-check this machine's systems — what's below may be out of date.";

/**
 * The way out of a failed read, drawn as the one thing to do about it.
 *
 * Two call sites, both {@link Empty}'s `action` slot, and a component rather than
 * two inline expressions because the *label* is the half that drifts: this file
 * writes "Checking…"/"Check again" a third time at the foot of the chooser's
 * list, where the shape is deliberately different — a quiet text button under a
 * list of rows, rather than the only control on an otherwise empty pane. Two
 * shapes, one vocabulary.
 *
 * **"Check again" and not "Try again": nothing was done.** What failed is a read,
 * so pressing this asks the same question rather than re-running something that
 * had an effect — the distinction `NewSession` already draws in as many words.
 */
function Recheck({ onClick, busy }: { onClick: () => void; busy: boolean }): ReactNode {
  return (
    <Button onClick={onClick} disabled={busy}>
      {busy ? "Checking…" : "Check again"}
    </Button>
  );
}

/**
 * The list. A list rather than a dropdown, for `AgentChooser`'s reason: at this
 * count it is not a close call, and every row carries a state worth seeing at a
 * glance.
 */
export function SystemChooser({
  machineId,
  onPick,
  onPickHarness,
}: {
  machineId: MachineId;
  onPick: (system: string) => void;
  /**
   * The other kind of row, which lands on a different leaf.
   *
   * Its own callback rather than a `kind` on {@link onPick}, because the two
   * resolve in different id spaces — a plugin may name the same local id in both
   * of its contribution blocks — so a single string reaching the parent would be
   * ambiguous at exactly the point it is turned into an address.
   */
  onPickHarness: (agent: string) => void;
}): ReactNode {
  const { systems, agents, error, supported, loading, refresh } = useSystems(machineId);

  if (loading && systems === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Asking that machine…
      </div>
    );
  }
  if (systems === null) {
    return (
      /*
       * ⚠ **`failed` only on the arm that really is one, which is the whole of
       * the primitive's partition.** A read that threw is the absence of an
       * *answer* and takes the triangle, the live region and a way to ask again;
       * the fallback beside it is a settled answer — the daemon replied, and what
       * it replied is that it has no such route — so it gets the plain sentence
       * and no retry, because pressing one would ask the same daemon the same
       * question.
       *
       * A daemon that has never heard of this route is the ordinary case during a
       * rollout — the client knows one by the shape of its refusal rather than by
       * a version, and says the one thing that can be acted on.
       */
      <Empty failed={supported} action={supported ? <Recheck onClick={refresh} busy={loading} /> : undefined}>
        {supported
          ? (error ?? "Could not read this machine's systems.")
          : "Update this machine's daemon to sign in here."}
      </Empty>
    );
  }

  return (
    <div className="mt-4 space-y-2">
      {/*
       * ⚠ **The arm that rendered nowhere.** `error` was drawn only in the
       * `systems === null` branch above, so a re-check that failed *after* one had
       * already worked changed nothing on screen at all: the button's label
       * flipped to "Checking…" and back, every row kept whatever it last said —
       * "sign in", on a machine that had just been signed in to — and the only
       * evidence the request had happened was that nothing had. So it was pressed
       * again. `AgentDetail` records the identical defect in the past tense and
       * this is its line; see {@link STALE_READ} for why the noun differs.
       */}
      {error !== null && <p className="text-xs text-muted">{STALE_READ}</p>}
      {/*
        * ⚠ **`ChoiceRow` rather than this row's own class string, and every
        * difference it lands is a correction.** It was `border-edge` with
        * `hover:border-edge-strong`, which is a white control on the sheet's white
        * ground identified only by a 1.31:1 hairline, and then a hover that moves
        * that hairline instead of a fill — the two things `index.css` states about
        * those tokens, broken in one attribute. The subline was `text-muted` here
        * and `text-faint` on the two rows in `AgentBuilder.tsx` that are otherwise
        * the same object, and the title was the only one of the three drawn
        * `font-medium`; the primitive settles all of it, since these rows and those
        * sit one tap apart inside pop-ups meant to read as one app.
        */}
      {systems.map((system) => (
        <ChoiceRow
          key={system.id}
          title={system.displayName}
          /*
           * ⚠ **The id, or where it came from — and the second is the more useful
           * fact about a row somebody does not recognise.** The id is what this
           * screen has always shown, and for the seven this product ships it is a
           * word anybody reading the list already knows. A provider a plugin added
           * carries a namespaced id nobody has seen, and the question it raises is
           * not *what is it called* but *where did it come from* — which is the one
           * this line can answer and the plugin's page is where it leads.
           */
          subline={
            system.contributedBy === undefined
              ? system.id
              : // ⚠ **Bounded, and this was the one contributed name drawn raw.**
                // `harnessSubline` puts the identical sentence through the same
                // function; the daemon does no control-character stripping on a
                // plugin's `name`, so an override here reorders the row and
                // everything this app wrote after it.
                `from ${boundedName(system.contributedBy.pluginName, "a plugin")}`
          }
          trailing={<Badge tone={system.keySet ? "plain" : "strong"}>{stateText(system)}</Badge>}
          onClick={() => onPick(system.id)}
        />
      ))}
      {/*
       * ⚠ **After every provider, and the order is the same argument
       * `GET /systems` makes about its own.** These rows exist only where a plugin
       * added a harness and no provider speaks for it, so they are the newest and
       * least familiar thing on the screen; putting them last means a group
       * *appears* rather than a group *moving* under a reader's thumb.
       *
       * They are the same `ChoiceRow` and lead to the same component one tap in —
       * what differs is which of the machine's two catalogues resolved the name,
       * which is an internal difference and gets no presentation of its own.
       */}
      {unspokenFor(agents, systems).map((agent) => (
        <ChoiceRow
          key={`harness:${agent.id}`}
          title={harnessName(agent)}
          /*
           * Where it came from rather than what it is called, which is the
           * provider rows' own rule: every harness that reaches this list came
           * from a plugin, and a namespaced id nobody has seen answers the wrong
           * question.
           */
          subline={
            agent.contributedBy === undefined
              ? agent.id
              : `from ${boundedName(agent.contributedBy.pluginName, "a plugin")}`
          }
          /*
           * ⚠ **A key, never a sign-in.** These are exactly the harnesses with no
           * wizard — that is why no provider names them — so "signed in" is a word
           * this row cannot honestly use, and `loggedIn` is `null` for all of them
           * anyway. What it can say is whether the box below holds anything.
           */
          trailing={
            <Badge tone={anyKeySet(agent) ? "plain" : "strong"}>
              {anyKeySet(agent) ? "key saved" : "no key"}
            </Badge>
          }
          onClick={() => onPickHarness(agent.id)}
        />
      ))}
      <button
        type="button"
        onClick={refresh}
        disabled={loading}
        className="tap press inline-flex min-h-11 items-center gap-1.5 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
      >
        <Icon as={RefreshCw} size={13} />
        {loading ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

/**
 * What a row says about a system, in the one line it has.
 *
 * ⚠ **A system with a CLI does not answer "signed in" here and must not pretend
 * to.** Whether `claude` is signed in is `GET /agent-auth`'s answer, arrived at
 * by running a probe, and it is drawn inside `AgentDetail` one tap in. What
 * `keySet` knows is only whether a *pasted key* is stored — which for a native
 * system is the weaker of two paths and for a key-only one is the whole of it.
 * Saying "not signed in" from this field would contradict a working agent.
 */
function stateText(system: SystemInfo): string {
  if (system.loginVia !== null) return system.keySet ? "key saved" : "sign in";
  return system.keySet ? "key saved" : "no key";
}

/** One system: its sign-in, or its key box. */
export function SystemDetail({
  machineId,
  systemId,
}: {
  machineId: MachineId;
  systemId: string;
}): ReactNode {
  const { systems, error, supported, loading, refresh } = useSystems(machineId);

  if (loading && systems === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Asking that machine…
      </div>
    );
  }
  if (systems === null) {
    // `failed` on every arm but one, unlike the chooser's: a read that threw and a
    // read that came back with nothing this screen could use are both the absence
    // of an answer. The exception is the same settled answer the chooser draws — a
    // daemon that predates the route — which is a sentence and no retry, because
    // this leaf is reachable by a deep link into a machine nobody has updated.
    return (
      <Empty failed={supported} action={supported ? <Recheck onClick={refresh} busy={loading} /> : undefined}>
        {supported
          ? (error ?? "Could not read this machine's systems.")
          : "Update this machine's daemon to sign in here."}
      </Empty>
    );
  }
  const system = systems.find((candidate) => candidate.id === systemId);
  // A settled answer, and the one thing to do about it is on the screen above:
  // no `failed`, no retry. See the chooser's branch for the partition.
  if (system === undefined) return <Empty>This machine doesn&apos;t have that system.</Empty>;

  return (
    <div>
      {/* The same arm the chooser draws, and it was missing here too — with more
          at stake, because what a stale read leaves on this screen is a `keySet`
          badge and the sentence under it, both of them claims about a credential.
          See {@link STALE_READ}. */}
      {error !== null && <p className="mt-4 text-xs text-muted">{STALE_READ}</p>}

      {system.loginVia !== null ? (
        /*
         * The harness's own card, under the system's name.
         *
         * ⚠ **The same component the New session sheet mounts inline**, keyed the
         * same way — one flow, one door. Two implementations of a device-code
         * login is how one of them rots, and this one would be the copy that
         * never gets the next fix.
         */
        <AgentDetail
          key={`${machineId}:${system.loginVia}`}
          machineId={machineId}
          agentId={system.loginVia}
          title={system.displayName}
          keyEnv={system.keyEnv ?? null}
        />
      ) : (
        <KeyOnly machineId={machineId} system={system} onChanged={refresh} />
      )}

      {/*
        * ⚠ **Both, where a system has a CLI *and* can be routed to — and this was
        * missing, which made half the feature unreachable.**
        *
        * The card above signs the system's own CLI in, and what that writes is an
        * *agent* credential: `KIMI_API_KEY`, merged into kimi's environment at
        * spawn. A routed session is a different path entirely — Claude Code
        * pointed at Moonshot's endpoint — and it signs its requests with the
        * *system* credential, in `providers/set`'s headers. Two credentials, two
        * destinations, and signing one in does not sign the other in. With only
        * the card drawn, `Claude Code · Kimi K2` could be assembled and could
        * never start.
        */}
      {system.loginVia !== null && system.routable === true && (
        <div className="mt-6 border-t border-edge pt-5">
          <KeyOnly machineId={machineId} system={system} onChanged={refresh} routing={true} />
        </div>
      )}
    </div>
  );
}

/**
 * The key box, and the two things you can do to a saved key.
 *
 * ⚠ **Mounted twice from this file, and the builder mounts it not at all.** A
 * system with a CLI *and* an endpoint to route to draws both: the sign-in card
 * for its own agent credential, and this box for the system credential a routed
 * session signs with. `SystemDetail` above is both call sites.
 *
 * ⚠ **The builder deliberately draws no credential control**, and `webcheck`
 * asserts it — "the builder names no credential control, in its code or in its
 * prose", swept over that file's source for `KeyOnly`, `keyMissing` and any
 * import from `./settings/`. An earlier draft of this paragraph said the builder
 * mounted this component, which is the opposite of the rule the driver enforces.
 * The export exists for `SystemDetail`'s two mounts and for that sweep. Q3.485.
 */
export function KeyOnly({
  machineId,
  system,
  onChanged,
  routing = false,
}: {
  machineId: MachineId;
  system: SystemInfo;
  onChanged: () => void;
  /** Drawn *beside* a CLI sign-in rather than instead of one. See the call site. */
  routing?: boolean;
}): ReactNode {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const daemon = store.daemonFor(machineId);

  /*
   * The credential's own name, once, for the box's placeholder **and** for its
   * accessible name — so the two cannot come apart.
   *
   * ⚠ **Two of these boxes can be on one screen and both said "paste the key".**
   * `SystemDetail` draws the harness's own credential card *and* this box
   * wherever a system has a CLI and can be routed to, which is the state the
   * second box was added for: two write-only fields, one screen, two different
   * destinations, and nothing in either field saying which. A key pasted into the
   * wrong one is stored, reported saved, and signs nothing — silently wrong in
   * exactly the way the second box exists to prevent. The prose above them has
   * always distinguished them; the fields did not.
   *
   * **The distinguishing word goes early**, which is why this is not "Moonshot
   * routing key": the field shares its row with Save, so a placeholder is clipped
   * from the right on a phone, and `paste the routing key for Moonshot` still
   * reads as the routing one at half its length.
   */
  const keyName = routing ? `routing key for ${system.displayName}` : `${system.displayName} key`;

  const save = (): void => {
    if (daemon === undefined || value.trim().length === 0 || busy) return;
    setBusy(true);
    void daemon
      .saveSystemKey(system.id, value.trim())
      .then(() => {
        setValue("");
        /*
         * ⚠ **A save that works changes nothing on screen, so the report cannot
         * live in here.** This already said `toast("error", …)` on a failure and
         * nothing at all on success, and that asymmetry is worst in the case that
         * matters most. *Replacing* a key leaves the badge already reading
         * "key saved" and clears the field, so the screen returns to exactly what it
         * was before the paste and nothing on it separates a write that landed from
         * one that never happened.
         *
         * A toast is what can say it, because `ToastHost` is portaled outside
         * `#root` — it outlives the control that raised it, which is the property
         * an inline line under the field does not have.
         *
         * ⚠ **Removing says so too now, and the paragraph this replaces argued the
         * opposite.** It read: *removing stays silent, and that is not an
         * oversight — it always changes what is on screen, since the badge flips
         * to "no key" and the button that was pressed goes away with it.* That is
         * true of the **fact** and says nothing about the **consequence**, which
         * is on another screen entirely: every session pointed at this system now
         * refuses to start, and a badge reading "no key" does not say that. The
         * removal is a two-step act with the consequence in prose above it, and
         * somebody who has just answered that question is owed a sentence saying
         * it happened.
         */
        toast(
          "ok",
          // Named apart because `SystemDetail` draws both boxes for one system, and
          // the two are different credentials with different destinations — the
          // whole point of that screen's second half.
          routing
            ? `Routing key saved for ${system.displayName}.`
            : `${system.displayName} key saved.`,
        );
        onChanged();
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  const remove = (): void => {
    if (daemon === undefined || busy) return;
    setBusy(true);
    void daemon
      .removeSystemKey(system.id)
      .then(() => {
        // Left open on a failure, so the toast below lands beside the question it
        // failed to answer and the two ways on from it are still under a thumb.
        setConfirmingRemove(false);
        // Named apart for the same reason the save is: two credentials, two
        // destinations, and on this screen both boxes can be drawn at once.
        toast(
          "ok",
          routing
            ? `Routing key removed for ${system.displayName}.`
            : `${system.displayName} key removed.`,
        );
        onChanged();
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  /*
   * ⚠ **Borrowed rather than stored, which is a third state and not a shade of
   * "saved".** The daemon answers `keySet` from `systemSecretFor`, which falls
   * back to the key this system's own harness already holds — one OpenRouter
   * account, one secret, and a second empty box under a second name was a trap
   * that refused a session start over a machine that plainly had a key. So
   * `keySet` is true here while `keyUpdatedAt` is `null`, which is the only pair
   * that can mean it: a *stored* key always has a timestamp.
   *
   * What it must not do is offer a Save and a Clear over a secret that is not
   * here — a Clear that removes nothing is worse than no Clear. One sentence
   * instead, naming where it comes from, and the box comes back the moment
   * somebody wants to override it, which is what the button under it is for.
   */
  const borrowed = routing && system.keySet && system.keyUpdatedAt === null;
  const [overriding, setOverriding] = useState(false);

  /*
   * The removal's box, **one string rendered in both states**, which is what makes
   * the ordering rule below a geometry rather than a sentence about one. It is
   * `SignOutButton`'s own — `mt-3` rather than its `mt-2` because this one follows
   * a paragraph rather than a row — and the argument for every part of it is at
   * the confirmation itself.
   */
  const removeBox = "mt-3 flex flex-wrap items-center justify-center gap-2";

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {routing ? "Routing key" : system.displayName}
        </span>
        <Badge tone={system.keySet ? "plain" : "strong"}>
          {system.keySet ? "key saved" : "no key"}
        </Badge>
      </div>

      <p className="text-xs text-muted">
        {routing
          /*
           * ⚠ **"above" is gone, because this is drawn on two screens now.** In
           * settings a CLI sign-in really is directly above it; in the agent
           * builder there is no sign-in on the screen at all, and a sentence
           * pointing at one is a sentence pointing at nothing — the failure the
           * refusal strings one file over were rewritten for. What is true in both
           * places is the fact, not its position. All three were cut on 2026-09-04
           * for fewer words; what each keeps is which requests the key signs and
           * whether a sign-in already covers it.
           */
          ? borrowed
            ? `Signs requests when another agent is pointed at ${system.displayName} — the key saved above already covers it.`
            : `Signs requests when another agent is pointed at ${system.displayName}. Signing in to its CLI does not cover it.`
          : `${system.displayName} has no sign-in here, so a key is the only way in.`}
      </p>

      {borrowed && !overriding ? (
        /* The door out, for the one case the sentence above does not cover: a
           different account for the routed path than for the CLI. Drawn as the
           quiet text button this file already uses, never as a second key box
           standing open. */
        <button
          type="button"
          onClick={() => setOverriding(true)}
          className="tap press -my-1.5 inline-flex min-h-11 items-center rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg"
        >
          Use a different key here
        </button>
      ) : (
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            }
          }}
          /*
           * ⚠ **Not `type="password"`, and `autoComplete="off"` was never going to
           * be enough.** Reported from the Z.ai row: the browser offered to fill an
           * *account password* into it, and offered to save the key as one
           * afterwards. Chrome's password manager keys on the input **type** and
           * ignores `autocomplete="off"` on it by design — that is documented
           * behaviour, not a bug — so the only thing that stops the offer is not
           * being a password field.
           *
           * Nothing is lost by that here. This box never holds a *stored* value:
           * it is write-only, the placeholder says so, and the only thing ever in
           * it is a key somebody has just pasted and wants to see landed. That is
           * the same argument `AccountSection` makes for the one-time secret and
           * the device code, which take a real fill for the same reason.
           *
           * `name` is what the heuristics read after the type, so it names this
           * thing rather than borrowing a word from a login form. The two `data-`
           * attributes are 1Password's and LastPass's own published opt-outs.
           */
          type="text"
          name="reemoat-provider-key"
          data-1p-ignore=""
          data-lpignore="true"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          // Both halves from {@link keyName}, where the argument for naming this
          // box at all is written down. The accessible name is that same string
          // rather than a second spelling of it, so what a screen reader is told
          // and what is written in the box cannot come apart.
          placeholder={system.keySet ? `paste a new ${keyName}` : `paste the ${keyName}`}
          aria-label={keyName}
          className={`${FIELD} min-w-0 flex-1 font-mono`}
        />
        <Button onClick={save} disabled={busy || value.trim().length === 0}>
          {busy ? <Spinner /> : "Save"}
        </Button>
      </div>
      )}

      {/* Never over a borrowed key: it removes a row that is not there, and the
          screen would then report the same `key saved` back, from the fallback. */}
      {system.keySet && !borrowed && (
        <div>
          {/*
           * ⚠ **This was one tap on an unbordered 36px ghost button, with the
           * consequence written nowhere and success reported by nothing.** Three
           * separate rules, each broken:
           *
           * `web-shell.md` — *a control is drawn in the colour of what it sits on,
           * so `edge-strong` is its only identification* — makes `tone="ghost"`
           * the one shape carrying no identification at all, which is the wrong
           * end of the scale for the one irreversible act this component has.
           * `size="sm"` on a `Button` is 36px (`BUTTON_SIZE` reserves it for a
           * confirmation that has *replaced* a row's controls, which this is not),
           * and it is a different scale from `IconButton`'s `sm`, which reaches
           * 44px through a pseudo-element. And a single tap took a credential that
           * every session pointed at this system signs with.
           *
           * So: the consequence as prose above the control — `MachineSection`'s
           * Retire idiom, stated where somebody reads it *before* deciding rather
           * than crammed into a question they are already halfway through — and
           * the two-step `SignOutButton` shape underneath it, which is the same
           * shape for a strictly less damaging act. The sentence was cut on
           * 2026-09-04 for fewer words; it keeps that sessions sign with the key,
           * that the next one refuses to start, and that the refusal shows on the
           * session rather than on this screen.
           */}
          <p className="text-xs text-muted">
            Sessions pointed at {system.displayName} sign with this key. Remove it and the next one
            refuses to start — it says so on the session, not here.
          </p>
          {/*
           * ⚠ **The geometry this paragraph claimed was never on the screen, and
           * it is the safety property rather than a description of one.** It read:
           * *both groups lay out in the same box, so the last child occupies the
           * pixels the resting button had … a second tap aimed at a control that
           * looked inert lands on Cancel rather than on the irreversible half.*
           * There was no shared box. The resting control was a bare wide
           * `DangerButton` hanging off this `<div>` at the left edge, and the
           * question was a left-aligned flex row — so the pixels it had were taken
           * by *Remove*, and Cancel sat at the far right where nothing could reach
           * it by accident. The one thing the sentence promised not to happen was
           * the thing the layout did, on the tap that takes a credential every
           * session pointed at this system signs with.
           *
           * Implemented rather than corrected, in `SignOutButton`'s shape — which
           * is what the block above already said this control took. One class
           * string in both states, so nothing else can move under a thumb, and
           * `justify-center` rather than `justify-end`: that one shipped on this
           * exact argument and drew a lone destructive button pinned to the right
           * of an empty box, which is not what this state should look like.
           * Centred, the resting button's own centre falls in the **gap** between
           * the two answers, so a second tap — which `.tap` makes possible at all,
           * by removing the 300ms double-tap delay — hits nothing. That is the safe
           * outcome; what the rule protects is that it must not hit the
           * irreversible half, and it cannot.
           *
           * Cancel is still **last** and still takes the default tone rather than
           * the filled one, which is the only reading `BUTTON_TONE`'s prohibition
           * allows: the destructive button is never the filled one. The question
           * takes `basis-full text-center`, so it is always on its own line and the
           * two answers are never crushed on a 390px phone — in CSS, with no
           * breakpoint anywhere.
           */}
          {confirmingRemove ? (
            <div className={removeBox}>
              <span className="basis-full text-center text-xs text-muted">Remove it?</span>
              <DangerButton icon={Trash2} disabled={busy} onClick={remove}>
                {busy ? <Spinner /> : "Remove"}
              </DangerButton>
              <Button disabled={busy} onClick={() => setConfirmingRemove(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className={removeBox}>
              {/* Named, because `SystemDetail` can draw this box beside the
                  harness's own credential card and both of them offer a removal. */}
              <DangerButton icon={Trash2} disabled={busy} onClick={() => setConfirmingRemove(true)}>
                Remove the {keyName}
              </DangerButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
