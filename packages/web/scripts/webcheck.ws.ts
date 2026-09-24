/** A real loopback WebSocketServer, started when this module loads: the rotation cases are a race between two live sockets. */

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";
import { sleep } from "./webcheck.env.js";
import { SessionStream, type Stream } from "./webcheck.modules.js";
// Type-only, so machine.ts is not evaluated ahead of the window stub.
import type { StreamSocket } from "../src/e2ee.js";
import type { Route } from "../src/machine.js";

export interface Attach {
  since: number;
  send: (frame: unknown) => void;
  close: (code: number, reason: string) => void;
  /** An abrupt drop: 1006 cannot be sent, so a dead network is simulated by killing the socket. */
  terminate: () => void;
  /** Closed from the server's side; close and terminate above set it too. */
  closed: boolean;
}

export const attaches: Attach[] = [];
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });

export const workspaceAt = (cwd: string, repoRoot: string | null = null) => ({
  mode: repoRoot === null ? "plain" : "worktree",
  root: cwd,
  requestedCwd: cwd,
  git: repoRoot === null ? null : { repoRoot, commonDir: `${repoRoot}/.git`, branch: "main", createdBranch: null, baseCommit: null },
  plainReason: repoRoot === null ? "not_requested" : null,
  createdAt: 0,
});

export const snapshot = {
  id: "s_1",
  agent: "kimi",
  cwd: "/tmp",
  workspace: workspaceAt("/tmp"),
  status: "running",
  pendingPermissions: [],
  firstSeq: 1,
  lastSeq: 0,
  dropped: 0,
  createdAt: 0,
  lastEventAt: null,
  exit: null,
};

wss.on("connection", (socket: ServerSocket, request) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const since = Number(url.searchParams.get("since") ?? "0");
  const send = (frame: unknown): void => socket.send(JSON.stringify(frame));
  const attach: Attach = {
    since,
    send,
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
    closed: false,
  };
  socket.on("close", () => void (attach.closed = true));
  attaches.push(attach);
});

await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
export const port = (wss.address() as AddressInfo).port;

/** A `hello`, as the daemon sends it: always first, and it carries the snapshot. */
export function hello(attach: Attach, since: number, gap = false): void {
  attach.send({
    type: "hello",
    instanceId: "i_1",
    session: snapshot,
    firstSeq: 1,
    lastSeq: since,
    since,
    gap,
  });
}

export function events(attach: Attach, from: number, to: number): void {
  const batch = [];
  for (let seq = from; seq <= to; seq += 1) {
    batch.push({ seq, ts: seq, event: { type: "text", role: "assistant", thought: false, text: `#${seq} ` } });
  }
  attach.send({ type: "events", events: batch });
}

export let forgotten = 0;
let tokenExpiresAt: number | null = null;

export const machine = {
  id: "m_1",
  ensureToken: async (): Promise<string> => "t_ok",
  // kind is read by settleAnswer, and the stub is passed as never so nothing type-checks it; relay because rotation is the same on both arms.
  resolveRoute: async (): Promise<Route> => ({ base: `http://127.0.0.1:${port}`, kind: "relay" }),
  currentRoute: (): Route => ({ base: `http://127.0.0.1:${port}`, kind: "relay" }),
  forgetRoute: (): void => void (forgotten += 1),
  tokenExpiresAt: (): number | null => tokenExpiresAt,
  streamUrl: (session: string, since: number, _token: string, _route: Route): string =>
    `ws://127.0.0.1:${port}/sessions/${session}/stream?since=${since}&token=t_ok`,
  // A plain WebSocket on purpose: rotation and the cursor are the same on both transports, and webcheck.e2ee.ts drives the channel.
  openStream: (session: string, since: number, token: string, route: Route): StreamSocket =>
    new WebSocket(machine.streamUrl(session, since, token, route)),
};

/** Everything the sink was told, in order, so gaps and duplicates are both visible. */
export function recorder() {
  const seqs: number[] = [];
  const gaps: { from: number; to: number }[] = [];
  let vanished = 0;
  return {
    seqs,
    gaps,
    get vanished(): number {
      return vanished;
    },
    sink: {
      onEvents: (_ref: unknown, batch: { seq: number }[]): void => {
        for (const stored of batch) seqs.push(stored.seq);
      },
      onSnapshot: (): void => {},
      onGap: (_ref: unknown, from: number, to: number): void => void gaps.push({ from, to }),
      onStatus: (): void => {},
      onVanished: (): void => void (vanished += 1),
    },
  };
}

export function newStream(sink: unknown, since: number): Stream {
  return new SessionStream(
    { machineId: machine.id, sessionId: "s_1" } as never,
    machine as never,
    sink as never,
    since,
  );
}

export async function nextAttach(count: number): Promise<Attach> {
  for (let i = 0; i < 200; i += 1) {
    if (attaches.length >= count) return attaches[count - 1]!;
    await sleep(10);
  }
  throw new Error(`attach ${count} never arrived`);
}

/** Like nextAttach, but answers null instead of throwing, for cases where no socket arriving is the answer. */
export async function attachWithin(count: number, ms: number): Promise<Attach | null> {
  for (let i = 0; i * 10 < ms; i += 1) {
    if (attaches.length >= count) return attaches[count - 1]!;
    await sleep(10);
  }
  return null;
}

export function closeWss(): void {
  wss.close();
}
