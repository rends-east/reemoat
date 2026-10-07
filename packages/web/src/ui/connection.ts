import type { MachineId } from "../ids";
import type { MachineState, OfflineReason } from "../machine";
import {
  CONNECTING,
  machinesWords,
  RECONNECT_QUIET_MS,
  SERVER_NAMED_AFTER_MS,
  serverWords,
  WAITING_FOR_NETWORK,
  wantsServer,
  type DeviceNetwork,
  type ServerFact,
} from "../reach";
import type { StreamStatus } from "../stream";

// What the connection pill says, as pure functions over the store's own state (Q3.659, Q3.710).

/** Offline for these is the wire failing, which the app keeps retrying; every other reason is a refusal somebody acts on where it is drawn. */
const TRANSPORT_REASONS: ReadonlySet<OfflineReason> = new Set<OfflineReason>(["no_route", "cp_unreachable", null]);

/** What a positive word waits: the device saying it is offline, or the server answering with an error. */
export const TROUBLE_GRACE_MS = 1_000;

/** Once drawn the pill stays this long, so a spell that ends a moment after it is drawn is not a flash. */
export const TROUBLE_MIN_SHOWN_MS = 1_500;

/** No spell is drawn on the render that first sees it: the body beside the pill is given a commit to say it first. */
export const TROUBLE_SIGHT_MS = 100;

export type Trouble =
  | { kind: "connecting"; e2ee: boolean }
  | { kind: "network" }
  | { kind: "server"; why: "unreachable" | "refusing" }
  | { kind: "unreachable"; names: readonly string[] };

export interface ConnectionScope {
  /** Every machine for the list's All tab, else the ones this screen reads; under All only a probe counts, never a machine that is off. */
  machines: "all" | readonly MachineId[];
  /** The conversation on screen: its machine is read too, and its stream has to be live. */
  open: { machine: MachineId; stream: StreamStatus | null } | null;
}

type Watched = Pick<MachineState, "id" | "name" | "reach" | "offlineReason" | "route">;

interface Watching {
  device: DeviceNetwork;
  server: ServerFact;
  machines: readonly Watched[];
  /** Down since the server last answered, so not yet known to be the machine's own trouble; optional for a caller that keeps none. */
  doubted?: ReadonlySet<MachineId>;
  /** Monotonic, when each machine now down was first found so; optional for a caller that keeps none. */
  downSince?: ReadonlyMap<MachineId, number>;
  /** Monotonic, since when a machine's session listing has failed in transit; optional likewise. */
  listFailingSince?: ReadonlyMap<MachineId, number>;
  /** This computer's machine, and whether the host is still bringing its daemon up; optional for a caller with no host. */
  localMachineId?: MachineId | null;
  localDaemonStarting?: boolean;
}

/** A cause, and when it began on the monotonic clock; null where nothing dated it, and the pill counts from when it first saw it. */
export interface Spell {
  trouble: Trouble;
  since: number | null;
}

/**
 * A device that says it is offline is the name for whatever else failed, and never trouble by itself: a server on this same
 * computer answers without any network. A server that answered with an error was reached, so it keeps its own name.
 */
export function connectionSpell(state: Watching, scope: ConnectionScope, now: number): Spell | null {
  const found = spellOf(state, scope, now);
  if (found === null || state.device !== "offline") return found;
  if (found.trouble.kind === "server" && found.trouble.why === "refusing") return found;
  return { trouble: { kind: "network" }, since: found.since };
}

export function connectionTrouble(state: Watching, scope: ConnectionScope, now: number): Trouble | null {
  return connectionSpell(state, scope, now)?.trouble ?? null;
}

/**
 * The server first, by name once its spell has outlasted a reconnect, since nothing else can be asked without it; then a
 * machine that cannot be reached, by name; then the open conversation's stream reconnecting, which is end-to-end encrypted
 * only over the relay (e2ee.md); then a first probe. `now` is monotonic, as every `since` is.
 */
function spellOf(state: Watching, scope: ConnectionScope, now: number): Spell | null {
  const since = state.server.since;
  if (state.server.state === "refusing") return { trouble: { kind: "server", why: "refusing" }, since };
  if (state.server.state === "unreachable") {
    const named = since !== null && now - since >= SERVER_NAMED_AFTER_MS;
    return { trouble: named ? { kind: "server", why: "unreachable" } : { kind: "connecting", e2ee: false }, since };
  }
  // Unasked with a shell on screen means the first listing is out.
  if (state.server.state === "unknown") return { trouble: { kind: "connecting", e2ee: false }, since: null };
  // A daemon the host is still starting has not failed to answer; it has not been asked yet (Q3.692).
  const starting = state.localDaemonStarting === true ? (state.localMachineId ?? null) : null;
  const watched = state.machines.filter(
    (machine) => scope.machines === "all" || scope.machines.includes(machine.id) || scope.open?.machine === machine.id,
  );
  // Under All a machine that is simply switched off would hold the pill for as long as it stays off.
  const named = (machine: Watched) => scope.machines !== "all" || scope.open?.machine === machine.id;
  const down = watched.filter(
    (machine) =>
      machine.reach === "offline" && TRANSPORT_REASONS.has(machine.offlineReason) && named(machine) && machine.id !== starting,
  );
  if (down.length > 0) {
    const began = down.map((machine) => state.downSince?.get(machine.id)).filter((at): at is number => at !== undefined);
    const first = began.length === 0 ? null : Math.min(...began);
    // A machine offline for want of the server, or down since the server last answered, is never named: the listing the store
    // has just asked says which of the two it is.
    if (down.some((machine) => wantsServer(machine.reach, machine.offlineReason) || state.doubted?.has(machine.id) === true)) {
      return { trouble: { kind: "connecting", e2ee: false }, since: first };
    }
    return { trouble: { kind: "unreachable", names: down.map((machine) => machine.name) }, since: first };
  }
  const stream = scope.open?.stream ?? null;
  if (stream !== null && (stream.phase === "connecting" || stream.phase === "waiting")) {
    const machine = watched.find((candidate) => candidate.id === scope.open?.machine);
    return { trouble: { kind: "connecting", e2ee: machine?.route?.kind === "relay" }, since: stream.downSince ?? null };
  }
  // Drawn as up, and its sessions cannot be read: a probe that passes is no proof that a listing will (Q3.714).
  const unread = watched
    .filter((machine) => machine.reach === "online")
    .map((machine) => state.listFailingSince?.get(machine.id))
    .filter((at): at is number => at !== undefined);
  if (unread.length > 0) return { trouble: { kind: "connecting", e2ee: false }, since: Math.min(...unread) };
  if (
    watched.some(
      (machine) =>
        machine.reach === "unknown" ||
        machine.reach === "probing" ||
        (machine.id === starting && machine.reach === "offline" && TRANSPORT_REASONS.has(machine.offlineReason)),
    )
  ) {
    return { trouble: { kind: "connecting", e2ee: false }, since: null };
  }
  return null;
}

/** `host` is the server as the drawer names it; the sentences themselves are `reach.ts`'s. */
export function troubleWords(trouble: Trouble, host: string): string {
  switch (trouble.kind) {
    case "connecting":
      return CONNECTING;
    case "network":
      return WAITING_FOR_NETWORK;
    case "server":
      return serverWords(trouble.why, host);
    case "unreachable":
      return machinesWords(trouble.names);
  }
}

/** A reconnect says nothing a spinner does not; every other cause is a fact the reader acts on, and a finger has no hover to find it with. */
export function opensByItself(trouble: Trouble): boolean {
  return trouble.kind !== "connecting";
}

/** When this screen first found trouble, kept across a change of kind: a reconnect that becomes an outage is one spell. */
export function troubleSince(previous: number | null, troubled: boolean, now: number): number | null {
  if (!troubled) return null;
  return previous ?? now;
}

/** A positive word is said after the grace; anything inferred from a failure waits out the quiet window (Q3.714). */
export function troubleWait(trouble: Trouble): number {
  const positive = trouble.kind === "network" || (trouble.kind === "server" && trouble.why === "refusing");
  return positive ? TROUBLE_GRACE_MS : RECONNECT_QUIET_MS;
}

/** When a spell may first be drawn. A cause older than this screen's sight of it counts from its own start, and none is drawn at first sight. */
export function troubleDue(spell: Spell, seen: number): number {
  return Math.max(Math.min(seen, spell.since ?? seen) + troubleWait(spell.trouble), seen + TROUBLE_SIGHT_MS);
}

/**
 * Whether the spell on hand is drawn: once it is due, and from then until it ends. A change of kind takes nothing back, or a
 * positive word that gives way to an inference would hide the pill and raise it again. `due` is null with no trouble.
 */
export function troubleLive(due: number | null, drawn: boolean, now: number): boolean {
  return due !== null && (drawn || now >= due);
}

/** The pill is up while its spell is drawn, and then until `TROUBLE_MIN_SHOWN_MS` from when it came up. */
export function troubleShown(live: boolean, shownAt: number | null, now: number): boolean {
  return live || (shownAt !== null && now - shownAt < TROUBLE_MIN_SHOWN_MS);
}
