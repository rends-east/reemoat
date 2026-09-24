// Session ids are unique only within one daemon: key maps by SessionKey, pass SessionRef to components, never route on a bare SessionId.

declare const brand: unique symbol;

export type MachineId = string & { readonly [brand]: "MachineId" };
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
