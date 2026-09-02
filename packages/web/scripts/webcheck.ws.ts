/**
 * The loopback daemon, and the machine `SessionStream` is given instead of a
 * control plane.
 *
 * A real `WebSocketServer` on purpose: the rotation cases are a race between two
 * live sockets, and stubbing that away would remove the only thing worth testing.
 * The server is created when this module is evaluated — which the runner does
 * before it runs any section — and closed by {@link closeWss}.
 */

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";
import { sleep } from "./webcheck.env.js";
import { SessionStream, type Stream } from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * A daemon-shaped WebSocket server
 *
 * Speaks only the frames `stream.ts` reads. Each connection records the `since`
 * it was opened with, which is what the rotation cases assert against.
 * ------------------------------------------------------------------ */

export interface Attach {
  since: number;
  send: (frame: unknown) => void;
  close: (code: number, reason: string) => void;
  /**
   * An abrupt drop, which is what a network change actually looks like.
   *
   * `1006` cannot be *sent* — it is reserved for "the connection went away without
   * a close frame" — so a dead network has to be simulated by killing the socket,
   * not by closing it politely with that code.
   */
  terminate: () => void;
  /**
   * This socket is no longer open, from the *server's* side of it.
   *
   * Not "the client closed it" on its own — `close()` and `terminate()` above set
   * it too — but on a socket this side never touched, that is exactly what it
   * means, and it is the only way to see the difference between a client that
   * released an abandoned socket and one that left it attached to the daemon.
   */
  closed: boolean;
}

export const attaches: Attach[] = [];
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });

/*
 * A `workspace`, because the fixture never had one.
 *
 * Every row below was built from a legacy `cwd` and no `workspace` at all, which
 * was harmless while nothing read it — and stops being harmless the moment
 * `folderPathOf` does. Fixed here rather than by writing `?.` into `groups.ts`:
 * optional chaining there would silently file every real session under the
 * fallback bucket and nothing would ever fail.
 */
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

/* ------------------------------------------------------------------ *
 * A machine, to the extent `SessionStream` needs one
 * ------------------------------------------------------------------ */

export let forgotten = 0;
let tokenExpiresAt: number | null = null;

export const machine = {
  id: "m_1",
  ensureToken: async (): Promise<string> => "t_ok",
  // `{base}` alone: `Route` lost its `kind` with the direct path, and a stub that
  // kept the old shape would be the last place the deleted vocabulary survived.
  resolveRoute: async (): Promise<{ base: string }> => ({ base: `http://127.0.0.1:${port}` }),
  currentRoute: (): { base: string } => ({ base: `http://127.0.0.1:${port}` }),
  forgetRoute: (): void => void (forgotten += 1),
  tokenExpiresAt: (): number | null => tokenExpiresAt,
  streamUrl: (session: string, since: number): string =>
    `ws://127.0.0.1:${port}/sessions/${session}/stream?since=${since}&token=t_ok`,
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
  // Duck-typed on purpose: constructing a real `MachineConnection` would pull in
  // the control plane, and the collaborator is exactly the seam that makes this
  // testable without one.
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

/**
 * `nextAttach`, for the cases where a socket that never arrives is the *answer*.
 *
 * A throw would be right for a fixture that cannot proceed and wrong for an
 * assertion whose whole subject is "does the client still open one" — the
 * orphaned-rotation case below fails by opening nothing, and a driver that
 * threw there would take every section after it down with the crash-truncation
 * failure CLAUDE.md records rather than printing one FAIL.
 */
export async function attachWithin(count: number, ms: number): Promise<Attach | null> {
  for (let i = 0; i * 10 < ms; i += 1) {
    if (attaches.length >= count) return attaches[count - 1]!;
    await sleep(10);
  }
  return null;
}

/**
 * Shut the server down.
 *
 * Called by the runner between the last section that uses it and the first that
 * does not, which is where the bare `wss.close()` sat when this was one file.
 */
export function closeWss(): void {
  wss.close();
}
