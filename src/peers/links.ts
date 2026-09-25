import { announceableMachineKey } from "../machinekey.js";
import type { PeerLink, SqliteMachineKeyStore, SqlitePeerLinkStore } from "../store/sqlite.js";
import { peerRequest, type PeerAnswer } from "./channel.js";
import type { PeerNetwork } from "./hub.js";

export const MAX_PEER_LINKS = 128;
const MAX_LINK_TOKEN_CHARS = 8_192;
const MAX_LINK_FIELD_CHARS = 256;

export type LinkInput = Omit<PeerLink, "updatedAt" | "lastError" | "lastErrorAt">;

/** The key is read at every request, never captured: a 409 on the dial can promote another one (machineKeyRotation). */
export function createPeerNetwork(
  links: Pick<SqlitePeerLinkStore, "list" | "noteError">,
  machineKeys: Pick<SqliteMachineKeyStore, "active">,
): PeerNetwork {
  return {
    links: () => links.list(),
    request: async (link, request, timeoutMs) => {
      const active = machineKeys.active();
      if (active === null) return { ok: false, status: 0, code: "no_machine_key", relayUrl: null };
      if (link.relayUrl === null) return { ok: false, status: 0, code: "no_relay_url", relayUrl: null };
      const staticKey = announceableMachineKey(active).staticKey;
      const target = { relayUrl: link.relayUrl, machineKey: link.targetKey, token: link.token };
      let answer: PeerAnswer = await peerRequest(target, staticKey, request, timeoutMs);
      // Once: a second 421 is a relay pointing in a circle, and the refusal is the honest answer.
      if (!answer.ok && answer.status === 421 && answer.relayUrl !== null) {
        answer = await peerRequest({ ...target, relayUrl: answer.relayUrl }, staticKey, request, timeoutMs);
      }
      return answer;
    },
    noteError: (link, message) => {
      try {
        links.noteError(link.id, message);
      } catch {
        // A diagnostic only; the caller has already been told.
      }
    },
  };
}

/** The body of PUT /peers/links, exactly what the control plane's link route answered; a string says what is wrong. */
export function linksFromBody(body: unknown): LinkInput[] | string {
  if (typeof body !== "object" || body === null) return "expected a JSON object";
  const list = (body as Record<string, unknown>)["links"];
  if (!Array.isArray(list)) return "links must be an array";
  if (list.length > MAX_PEER_LINKS) return `at most ${MAX_PEER_LINKS} links`;
  const out: LinkInput[] = [];
  const ids = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) return "each link must be an object";
    const link = entry as Record<string, unknown>;
    const target = link["target"];
    if (typeof target !== "object" || target === null) return "each link needs a target";
    const t = target as Record<string, unknown>;
    const id = link["id"];
    const token = link["token"];
    const expiresAt = link["expiresAt"];
    const relayUrl = t["relayUrl"];
    if (!field(id) || ids.has(id)) return "each link needs a distinct id";
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_LINK_TOKEN_CHARS) return "each link needs a token";
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "each link needs expiresAt";
    if (!field(t["id"]) || !field(t["name"])) return "each target needs an id and a name";
    const key = t["key"];
    if (typeof key !== "string" || Buffer.from(key, "base64url").length !== 32) return "each target needs its machine key";
    if (relayUrl !== null && !httpUrl(relayUrl)) return "a target's relayUrl must be an http or https URL, or null";
    ids.add(id);
    out.push({
      id,
      targetMachineId: t["id"],
      targetName: t["name"],
      targetKey: key,
      relayUrl: relayUrl as string | null,
      token,
      expiresAt,
    });
  }
  return out;
}

function field(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LINK_FIELD_CHARS && !/[\u0000-\u001f]/.test(value);
}

function httpUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
