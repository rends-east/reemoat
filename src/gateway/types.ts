import type { MachineCatalogue, SystemId, WireProtocol } from "../acp/systems.js";

/** Read by data.code and by drivers; the sentence beside it is what a person reads. */
export type GatewayFaultCode =
  | "gateway_no_credential"
  | "gateway_signed_out"
  | "gateway_provider_gone"
  | "gateway_wrong_model"
  | "gateway_untranslatable"
  | "gateway_upstream_refused"
  | "gateway_usage_limit"
  | "gateway_upstream_unreachable";

export interface GatewayFault {
  code: GatewayFaultCode;
  message: string;
  /** Whether asking again could succeed with nothing changed on this machine. */
  retryable: boolean;
}

export interface GrantSpec {
  system: SystemId;
  /** The one model this launch may ask for; null where the launch named none. */
  model: string | null;
  /** What the harness speaks to this daemon. */
  inbound: WireProtocol;
  /** Where its requests go. Another protocol than inbound only where a translator carries one into the other. */
  outbound: { protocol: WireProtocol; baseUrl: string };
  /** Told of each refusal made here, beside the answer the harness gets: not every harness shows what an endpoint says (Q6.125). */
  onFault?(fault: GatewayFault): void;
}

/** What one agent process is handed in place of a vendor's address and key. */
export interface GatewayGrant {
  /** Loopback, no path: each harness appends its own. */
  origin: string;
  bearer: string;
  close(): void;
}

export interface GatewayGrants {
  open(spec: GrantSpec): GatewayGrant;
}

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  signal: AbortSignal;
}

export interface UpstreamResponse {
  status: number;
  header(name: string): string | null;
  body: ReadableStream<Uint8Array> | null;
}

export interface UpstreamTransport {
  send(request: UpstreamRequest): Promise<UpstreamResponse>;
}

export interface GatewayDeps {
  /** Asked on every request and never held, so a replaced key signs the next one and a sign-in is renewed when it is due. Takes a system and no harness: a harness's own sign-in is not reachable from here. */
  secretFor(system: SystemId, signal: AbortSignal): Promise<string | GatewayFault>;
  machine(): MachineCatalogue;
  transport: UpstreamTransport;
}
