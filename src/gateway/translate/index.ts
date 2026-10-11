import type { WireProtocol } from "../../acp/systems.js";
import { messagesToResponses } from "./messages-to-responses.js";
import type { Translator } from "./types.js";

/** One per pair in TRANSLATIONS, which is what routeFor reads; gatewaycheck holds the two lists to each other. */
export const TRANSLATORS: readonly Translator[] = [messagesToResponses];

export function translatorFor(inbound: WireProtocol, outbound: WireProtocol): Translator | null {
  return TRANSLATORS.find((one) => one.inbound === inbound && one.outbound === outbound) ?? null;
}
