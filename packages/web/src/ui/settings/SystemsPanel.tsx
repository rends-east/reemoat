import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { errorText } from "../../http";
import type { MachineId } from "../../ids";
import { store } from "../../store";
import type { SystemInfo } from "../../wire";
import { Badge, Button, ChoiceRow, Empty, FIELD, Icon, Spinner } from "../bits";
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
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [systems, setSystems] = useState<SystemInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const daemon = store.daemonFor(machineId);

  useEffect(() => {
    if (daemon === undefined) return;
    let cancelled = false;
    setLoading(true);
    void daemon
      .systems()
      .then((result) => {
        if (cancelled) return;
        setSystems(result.systems);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, epoch]);

  return { systems, error, loading, refresh: useCallback(() => setEpoch((n) => n + 1), []) };
}

/**
 * The list. A list rather than a dropdown, for `AgentChooser`'s reason: at this
 * count it is not a close call, and every row carries a state worth seeing at a
 * glance.
 */
export function SystemChooser({
  machineId,
  onPick,
}: {
  machineId: MachineId;
  onPick: (system: string) => void;
}): ReactNode {
  const { systems, error, loading, refresh } = useSystems(machineId);

  if (loading && systems === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Asking that machine…
      </div>
    );
  }
  if (systems === null) {
    return (
      <Empty>
        {/* A daemon that has never heard of this route is the ordinary case
            during a rollout — the client knows one by the shape of its refusal
            rather than by a version, and says the one thing that can be acted
            on. */}
        {error ?? "This machine is running a build without systems. Update it to sign in here."}
      </Empty>
    );
  }

  return (
    <div className="mt-4 space-y-2">
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
          subline={system.id}
          trailing={<Badge tone={system.keySet ? "plain" : "strong"}>{stateText(system)}</Badge>}
          onClick={() => onPick(system.id)}
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
  const { systems, error, loading, refresh } = useSystems(machineId);

  if (loading && systems === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Asking that machine…
      </div>
    );
  }
  if (systems === null) {
    return <Empty>{error ?? "Could not read this machine's systems."}</Empty>;
  }
  const system = systems.find((candidate) => candidate.id === systemId);
  if (system === undefined) return <Empty>This machine doesn&apos;t have that system.</Empty>;

  return (
    <div>
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
  const daemon = store.daemonFor(machineId);

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
         * Removing stays silent, and that is not an oversight: it always changes
         * what is on screen, since the badge flips to "no key" and the button that
         * was pressed goes away with it. A toast there would be a second copy of a
         * fact the row states in place.
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
      .then(onChanged)
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

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
           * places is the fact, not its position.
           */
          ? `Signs the requests when another agent is pointed at ${system.displayName}. Signing in to ${system.displayName}'s own CLI does not cover it.`
          : `${system.displayName} has no sign-in program on this machine, so a key is the only way in.`}
      </p>

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
          placeholder={system.keySet ? "paste a new key to replace it" : "paste the key"}
          aria-label={`${system.displayName} key`}
          className={`${FIELD} min-w-0 flex-1 font-mono`}
        />
        <Button onClick={save} disabled={busy || value.trim().length === 0}>
          {busy ? <Spinner /> : "Save"}
        </Button>
      </div>

      {system.keySet && (
        <Button tone="ghost" size="sm" onClick={remove} disabled={busy}>
          Remove
        </Button>
      )}
    </div>
  );
}
