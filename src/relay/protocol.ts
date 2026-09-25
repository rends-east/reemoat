export const RELAY_PROTOCOL_VERSION = 2;

/** Not 1: v1 streams are plaintext. */
export const RELAY_PROTOCOL_MIN_VERSION = 2;

/** A literal, never the floor: a peer sending no version header predates negotiation and speaks 1. */
export const PRE_NEGOTIATION_PROTOCOL_VERSION = 1;

export function negotiateProtocolVersion(offered: number): number | null {
  if (!Number.isInteger(offered)) return null;
  if (offered < RELAY_PROTOCOL_MIN_VERSION) return null;
  return Math.min(offered, RELAY_PROTOCOL_VERSION);
}

export const TUNNEL_PATH = "/__relay/tunnel";

/** Credential only: the relay derives the machine id from it. */
export const TUNNEL_AUTH_HEADER = "authorization";

export const TUNNEL_VERSION_HEADER = "x-reemoat-relay-version";

export const TUNNEL_AGREED_VERSION_HEADER = "x-reemoat-relay-agreed";

export const DAEMON_VERSION_HEADER = "x-reemoat-daemon-version";

export const MAX_DAEMON_VERSION_CHARS = 64;

/** Advisory; a malformed list is refused whole, since a cut one is a false inventory (Q7.42). */
export const AGENT_CLIS_HEADER = "x-reemoat-agent-clis";

export const MAX_AGENT_CLIS_CHARS = 512;

export const AGENT_CLI_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export const AGENT_CLI_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;

export type AgentClis = Record<string, string | null>;

export function formatAgentClis(clis: AgentClis): string {
  return Object.entries(clis)
    .map(([id, version]) => `${id}=${version ?? "-"}`)
    .join(";");
}

export function parseAgentClis(text: string): AgentClis | null {
  if (text.length === 0 || text.length > MAX_AGENT_CLIS_CHARS) return null;
  const clis: AgentClis = {};
  for (const entry of text.split(";")) {
    const at = entry.indexOf("=");
    if (at === -1) return null;
    const id = entry.slice(0, at);
    const version = entry.slice(at + 1);
    if (!AGENT_CLI_ID_RE.test(id) || !AGENT_CLI_VERSION_RE.test(version)) return null;
    if (Object.hasOwn(clis, id)) return null;
    clis[id] = version === "-" ? null : version;
  }
  return clis;
}

export const MACHINE_KEY_HEADER = "x-reemoat-machine-key";

export const MAX_MACHINE_KEY_CHARS = 43;

// Strict alphabet: base64url decoding skips unknown characters.
export function parseMachineKey(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (value.length !== MAX_MACHINE_KEY_CHARS) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return value;
}

export const STREAM_VERSION_HEADER = "reemoat-v";

export const STREAM_ENCRYPTION_HEADER = "reemoat-enc";

// No STREAM_ENCRYPTION_NONE: plaintext is deliberately not a value a stream can ask for.

export const STREAM_ENCRYPTION_NOISE_IK = "noise-ik-25519-chachapoly-blake2s/1";

export const STREAM_SUBJECT_HEADER = "reemoat-sub";

export const RELAY_HEADER_PREFIX = "reemoat-";

export const CLOSE_TUNNEL_SUPERSEDED = 4409;

export const CLOSE_TUNNEL_BACKPRESSURE = 4013;

/** Keep above EVENTS_PAGE_BYTES, or a transcript page can wedge the proxied stream (Q6.104). */
export const STREAM_WINDOW_BYTES = 1024 * 1024;

export const MAX_CONCURRENT_STREAMS = 256;

export const MAX_STREAMS_PER_SUBJECT = 64;

/** A link's own share of a tunnel, keyed on the link and never on its owner, so a looping agent cannot lock the owner out (Q7.150). */
export const MAX_STREAMS_PER_LINK = 4;

/** Every link's streams on one tunnel together; the owner's MAX_STREAMS_PER_SUBJECT is untouched by them. */
export const MAX_LINK_STREAMS_PER_TUNNEL = 32;

/** Channel opens per link: a burst, then one per LINK_CONNECT_REFILL_MS. The caller is a machine that never sleeps. */
export const LINK_CONNECT_BURST = 20;

export const LINK_CONNECT_REFILL_MS = 1_000;

/** On a 421 wrong_relay: where the relay holding the machine's tunnel is reached. */
export const RELAY_URL_HEADER = "x-reemoat-relay-url";

/** Deliberately separate from CONNECTION_WINDOW_BYTES although the values match. */
export const MAX_TUNNEL_BUFFERED_BYTES = 8 * 1024 * 1024;

export const MAX_TUNNEL_MESSAGE_BYTES = 8 * 1024 * 1024;

export const CONNECTION_WINDOW_BYTES = 8 * 1024 * 1024;

export const TUNNEL_STABLE_AFTER_MS = 60_000;

export const TUNNEL_PING_INTERVAL_MS = 20_000;

export const TUNNEL_PING_MAX_MISSES = 2;

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const window = Math.min(RECONNECT_MIN_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS);
  return Math.round(random() * window);
}
