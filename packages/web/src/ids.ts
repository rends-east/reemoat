/**
 * A session's identity is `(machineId, sessionId)`, and the type system is what
 * enforces it.
 *
 * Session ids are `s_<8 hex>`, minted per daemon. They are unique **within one
 * daemon** and nowhere else, so two machines will eventually hold the same id —
 * and every way that goes wrong is silent. A map keyed by the bare id shows one
 * machine's transcript under the other's name; a prompt routed by the bare id
 * reaches the wrong agent, on the wrong machine, in the wrong repository. None of
 * those throw.
 *
 * So the bare id is made unusable rather than discouraged:
 *
 *   1. Every map is keyed by `SessionKey`, never `SessionId`.
 *   2. No component prop is a session id. Components take a `SessionRef`.
 *   3. The daemon client is built per machine and closes over it, so there is no
 *      function anywhere taking an id and a URL as separate arguments.
 *
 * The brands are `unique symbol` declarations that do not exist at runtime — a
 * branded value is a plain string, so `JSON.stringify`, `fetch` and template
 * literals all work — but one cannot be produced by accident. Passing a raw
 * string does not compile, which is the entire point.
 */

declare const brand: unique symbol;

export type MachineId = string & { readonly [brand]: "MachineId" };
/** Unique within one daemon. Never a key, never a prop, never routed on alone. */
export type SessionId = string & { readonly [brand]: "SessionId" };
/** `${machineId}/${sessionId}`. The only thing that is globally unique. */
export type SessionKey = string & { readonly [brand]: "SessionKey" };

export interface SessionRef {
  readonly machineId: MachineId;
  readonly sessionId: SessionId;
}

export function machineId(value: string): MachineId {
  return value as MachineId;
}

export function sessionId(value: string): SessionId {
  return value as SessionId;
}

export function refOf(machine: MachineId, session: SessionId): SessionRef {
  return { machineId: machine, sessionId: session };
}

export function keyOf(ref: SessionRef): SessionKey {
  return `${ref.machineId}/${ref.sessionId}` as SessionKey;
}
