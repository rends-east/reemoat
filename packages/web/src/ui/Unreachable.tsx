import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { errorText } from "../http";
import { controlPlaneOrigin, nativeAccounts, type NativeAccountSummary } from "../native";
import { machinesWords, NO_NETWORK, serverSentence, serverTroubled, sessionsWords, wantsServer } from "../reach";
import { serverLabel } from "../slot";
import { store, type AppState } from "../store";
import { AccountRow } from "./AccountRow";
import { Button, Empty, SETTINGS_HEADING, SkeletonRow, Spinner } from "./bits";
import { toast } from "./Toast";

/** A press is drawn for at least this long, so an attempt that fails at once still reads as one. */
export const RETRY_FLOOR_MS = 400;

export type UnreachableCause =
  | { what: "network" }
  | { what: "server"; why: "unreachable" | "refusing" }
  | { what: "machines"; names: readonly string[] }
  | { what: "sessions"; name: string | null };

/**
 * A body with nothing to draw because something was not reached: what, by name, a way to ask again, and for the server the
 * other accounts on this device. Drawn only where there are no rows; over held rows the pill says it (Q3.659, Q3.709).
 */
export function Unreachable({
  cause,
  split = false,
  accounts = true,
  onConnected,
}: {
  cause: UnreachableCause;
  /** Off inside a sheet, where the way to another account is not this screen's to offer. */
  accounts?: boolean;
  /** In the rail: at `lg` the pane beside it carries the control and the accounts, as it carries the installer's command. */
  split?: boolean;
  /** A retry the reader pressed worked, and this block is gone. */
  onConnected?: () => void;
}): ReactNode {
  const whole = (
    <>
      <Empty failed action={<RetryButton onConnected={onConnected} />}>
        <Words cause={cause} />
      </Empty>
      {/* Not for this device's own network: they would not open either. */}
      {accounts && cause.what === "server" && <OtherAccounts />}
    </>
  );
  if (!split) return whole;
  return (
    <>
      <div className="lg:hidden">{whole}</div>
      <div className="hidden lg:block">
        <Empty failed>
          <Words cause={cause} />
        </Empty>
      </div>
    </>
  );
}

function Words({ cause }: { cause: UnreachableCause }): ReactNode {
  switch (cause.what) {
    case "network":
      return NO_NETWORK;
    case "server": {
      const { lead, tail } = serverSentence(cause.why);
      return (
        <>
          {lead}
          <span className="font-mono text-xs break-all">{serverLabel(controlPlaneOrigin())}</span>
          {tail}
        </>
      );
    }
    case "machines":
      return machinesWords(cause.names);
    case "sessions":
      return sessionsWords(cause.name);
  }
}

/** Owns its attempt: `store.retry` starts a pass or adopts the one already out, and the mark is drawn for exactly that. */
function RetryButton({ onConnected }: { onConnected?: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = (): void => {
    if (busy) return;
    const held = wrap.current?.contains(document.activeElement) === true;
    // From the pane beside the rail the list is not an ancestor: the first in the document is the rail's own.
    const list =
      wrap.current?.closest<HTMLElement>("[data-session-list]") ?? document.querySelector<HTMLElement>("[data-session-list]");
    setBusy(true);
    const floor = new Promise<void>((resolve) => window.setTimeout(resolve, RETRY_FLOOR_MS));
    void Promise.all([store.retry(), floor]).finally(() => {
      if (mounted.current) {
        setBusy(false);
        return;
      }
      // Gone because it worked: a keyboard's place goes to the list this block gave way to.
      onConnected?.();
      if (held) window.requestAnimationFrame(() => list?.querySelector<HTMLElement>("button:not([disabled])")?.focus());
    });
  };

  return (
    <span ref={wrap} className="inline-flex">
      <Button size="sm" onClick={run} disabled={busy} ariaLabel="Try again" className="min-w-20">
        {busy ? <Spinner /> : "Try again"}
      </Button>
    </span>
  );
}

/** Asked of the host, which reads no keyring and no network for it, so it answers through any outage. */
function OtherAccounts(): ReactNode {
  const [accounts, setAccounts] = useState<readonly NativeAccountSummary[]>([]);
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    let live = true;
    void nativeAccounts().then((list) => {
      if (live && list !== null) setAccounts(list.accounts.filter((account) => !account.current));
    });
    return () => {
      live = false;
    };
  }, []);
  if (accounts.length === 0) return null;

  return (
    <div className="px-1.5 pb-2">
      <p className={`px-3 py-1.5 ${SETTINGS_HEADING}`}>Other accounts</p>
      {accounts.map((account) => (
        <AccountRow
          key={account.key}
          account={account}
          disabled={moving}
          onPick={() => {
            setMoving(true);
            void store
              .switchAccount(account.key)
              .catch((cause: unknown) => toast("error", errorText(cause)))
              // Where the host shows another window this page lives on, hidden, and is come back to.
              .finally(() => setMoving(false));
          }}
        />
      ))}
    </div>
  );
}

type Unread = Pick<AppState, "registry" | "server" | "device">;

/** What a read that failed was a failure of. Offline renames it and is none by itself: null until the server has been asked and has failed. */
export function unreadCause(state: Pick<AppState, "server" | "device">): UnreachableCause | null {
  const why = state.server.state;
  if (!serverTroubled(why)) return null;
  return why === "unreachable" && state.device === "offline" ? { what: "network" } : { what: "server", why };
}

/**
 * In place of a claim about the machine list while that list has not been read: a wait, or what was not reached. Null once
 * it has been read, and only then may a screen say a machine is gone or that there are none (Q3.709).
 */
export function registryUnread(state: Unread): ReactNode | null {
  if (state.registry === "known") return null;
  const cause = unreadCause(state);
  return cause === null ? <SkeletonRow /> : <Unreachable cause={cause} accounts={false} />;
}

/** Nothing may be called uninstalled until every machine's plugin list has been read. Null once each has. */
export function pluginsUnread(
  state: Pick<AppState, "machines" | "pluginsRead" | "sessionsFailed" | "doubted" | "server" | "device">,
): ReactNode | null {
  const unread = state.machines.filter((machine) => state.pluginsRead.get(machine.id) !== "known");
  if (unread.length === 0) return null;
  // The plugin read follows a session listing that answered, so a machine whose listing was refused is not being asked.
  const asking = (reach: string, id: AppState["machines"][number]["id"]): boolean =>
    reach === "unknown" ||
    reach === "probing" ||
    state.doubted.has(id) ||
    (reach === "online" && !state.pluginsRead.has(id) && !state.sessionsFailed.has(id));
  if (unread.some((machine) => asking(machine.reach, machine.id))) return <SkeletonRow />;
  const cause = unreadCause(state);
  if (cause !== null) return <Unreachable cause={cause} accounts={false} />;
  const offline: UnreachableCause | null = state.device === "offline" ? { what: "network" } : null;
  if (unread.some((machine) => wantsServer(machine.reach, machine.offlineReason))) {
    return <Unreachable cause={offline ?? { what: "server", why: "unreachable" }} accounts={false} />;
  }
  const down = unread.filter((machine) => machine.reach === "offline");
  if (down.length > 0) {
    return <Unreachable cause={offline ?? { what: "machines", names: down.map((machine) => machine.name) }} accounts={false} />;
  }
  return (
    <Empty failed action={<AskAgain ask={() => store.retry()} />}>
      Couldn’t load what is installed on {unread.length === 1 ? (unread[0]?.name ?? "one machine") : "some machines"}
    </Empty>
  );
}

/** The same for what the server says of itself, asked before a screen says the server lacks something. */
export function configUnread(state: Pick<AppState, "config" | "configRead" | "server" | "device">): ReactNode | null {
  if (state.config !== null || state.configRead === "known") return null;
  const cause = unreadCause(state);
  if (cause !== null) return <Unreachable cause={cause} accounts={false} />;
  if (state.configRead === "unknown") return <SkeletonRow />;
  return (
    <Empty failed action={<AskAgain ask={() => store.refreshConfig()} />}>
      Couldn’t load this server’s settings
    </Empty>
  );
}

/** The account's own screens before `me` is known: a wait until it has been asked for, a sentence only once that failed. */
export function MeUnread(): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (state.meRead !== "failed") return <SkeletonRow />;
  const cause = unreadCause(state);
  if (cause !== null) return <Unreachable cause={cause} accounts={false} />;
  return (
    <Empty failed action={<AskAgain ask={() => store.refreshMe()} />}>
      Couldn’t load your account
    </Empty>
  );
}

/** A retry that stands on a second failure: the mark is drawn while it runs and the sentence beside it never leaves. */
function AskAgain({ ask }: { ask: () => Promise<unknown> }): ReactNode {
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return (
    <Button
      size="sm"
      disabled={busy}
      ariaLabel="Try again"
      className="min-w-20"
      onClick={() => {
        setBusy(true);
        const floor = new Promise<void>((resolve) => window.setTimeout(resolve, RETRY_FLOOR_MS));
        void Promise.all([ask().catch(() => undefined), floor]).finally(() => {
          if (live.current) setBusy(false);
        });
      }}
    >
      {busy ? <Spinner /> : "Try again"}
    </Button>
  );
}
