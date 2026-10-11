import type { MachineCatalogue, SystemId, SystemSignInPort } from "../acp/systems.js";
import type { IdentityTransport, SignInFlow } from "./signin/types.js";
import { SignInError } from "./signin/types.js";
import type { GatewayFault } from "./types.js";

/** Refreshed this long before it would stop working, so a request sent now is not refused on arrival. */
const REFRESH_AHEAD_MS = 60_000;

export interface SystemCredentialsDeps {
  machine(): MachineCatalogue;
  /** A pasted key, or null. Takes a system and no harness: a harness's own sign-in is not reachable from here. */
  keyFor(system: SystemId): string | null;
  signIns: SystemSignInPort | null;
  flows: Readonly<Record<string, SignInFlow>>;
  transport: IdentityTransport;
  now?: () => number;
}

/** What signs a request for a system: its pasted key, or the access token of the sign-in it takes in place of one. */
export class SystemCredentials {
  private readonly refreshing = new Map<SystemId, Promise<string | GatewayFault>>();
  private readonly now: () => number;

  constructor(private readonly deps: SystemCredentialsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** A sentence where nothing could sign a request for this system now; read at a start, so a session that cannot run is refused before it opens. */
  missing(system: SystemId): string | null {
    const spec = this.deps.machine().system(system);
    if (spec === null) return `This session's provider is no longer on this machine.`;
    if (spec.signIn === null) {
      return this.deps.keyFor(system) === null
        ? `No key is saved for ${spec.displayName} on this machine, so nothing can sign these requests.`
        : null;
    }
    return this.deps.signIns?.get(system) == null ? `Nobody is signed in to ${spec.displayName} on this machine.` : null;
  }

  async secretFor(system: SystemId, signal: AbortSignal): Promise<string | GatewayFault> {
    const spec = this.deps.machine().system(system);
    const absent = this.missing(system);
    if (spec === null || absent !== null) {
      return { code: spec === null ? "gateway_provider_gone" : "gateway_no_credential", message: absent ?? "", retryable: false };
    }
    if (spec.signIn === null) return this.deps.keyFor(system) as string;

    const held = this.deps.signIns?.get(system) ?? null;
    const flow = held === null ? undefined : this.deps.flows[held.flow];
    if (held === null || flow === undefined) {
      return { code: "gateway_no_credential", message: `Nobody is signed in to ${spec.displayName} on this machine.`, retryable: false };
    }
    if (held.expiresAt - this.now() > REFRESH_AHEAD_MS) return held.access;

    // One refresh for however many requests found the token stale: a refresh token is spent by its first use.
    const running = this.refreshing.get(system);
    if (running !== undefined) return running;
    const refreshed = (async (): Promise<string | GatewayFault> => {
      try {
        const next = await flow.refresh(held, this.deps.transport, this.now(), signal);
        if (next === "signed_out") {
          this.deps.signIns?.remove(system);
          return { code: "gateway_signed_out", message: `${spec.displayName} signed this machine out. Sign in again to carry on.`, retryable: false };
        }
        // Stored before it is spent: the old refresh token is dead from here, and a crash between would sign the machine out.
        this.deps.signIns?.save(system, held.flow, next, held.signedInBy);
        return next.access;
      } catch (error) {
        return {
          code: "gateway_upstream_unreachable",
          message: error instanceof SignInError ? error.message : `${spec.displayName} could not be asked to renew this machine's sign-in.`,
          retryable: true,
        };
      } finally {
        this.refreshing.delete(system);
      }
    })();
    this.refreshing.set(system, refreshed);
    return refreshed;
  }
}
