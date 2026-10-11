import type { WireProtocol } from "../acp/systems.js";
import type { GatewayFault } from "./types.js";

/** 400 for what will not clear by itself: every harness measured ends a turn on it at once, where a 401 reads as a sign-in failure and a 5xx is retried for minutes (Q6.123–Q6.127). */
export function faultStatus(fault: GatewayFault): number {
  return fault.retryable ? 502 : 400;
}

/** The refusal in the shape the harness's own protocol reports an error in, so its sentence is what the harness shows. */
export function faultBody(protocol: WireProtocol, fault: GatewayFault): unknown {
  if (protocol === "anthropic-messages") {
    return { type: "error", error: { type: fault.retryable ? "api_error" : "invalid_request_error", message: fault.message } };
  }
  return {
    error: { message: fault.message, type: fault.retryable ? "server_error" : "invalid_request_error", code: fault.code },
  };
}
