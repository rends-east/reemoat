import { readFileSync } from "node:fs";
import { check, fetchChannel, report, storage } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * The path that does not go through the relay
 *
 * **Everything this drives is one field and one candidate**, and that is the
 * point of driving it: `Route` grew a `kind`, `probeRoute` grew a first candidate
 * and `settleAnswer` grew a rule that may only fire on one of the two arms.
 * Nothing above `MachineConnection` changed, so nothing above it can notice a
 * regression here — a local route that silently stops being offered looks exactly
 * like a fleet that is working, only slower, and one that keeps being offered
 * after the daemon on this computer became a different machine looks like an app
 * that cannot reach a machine it can plainly see.
 *
 * The harness is `webcheck.stream-and-http.ts`'s: stub `globalThis.fetch`, drive a
 * real connection. The shell is installed and removed around the sections that
 * need it — `inNativeShell()` reads the injected global on *every* call rather
 * than latching it at import time, which is what makes both arms reachable in one
 * process without re-importing anything.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe local route, and the browser that may never take it\n");

const LOCAL = "http://127.0.0.1:7887";
const RELAY = "https://r1.example";
/*
 * A machine that has announced a key, which `probeRoute` now requires before it
 * will settle on the relay at all. Any 43 base64url characters: nothing in this
 * module runs a handshake, and the refusal for a machine with *no* key is its own
 * assertion below.
 */
const MACHINE_KEY = "A".repeat(43);

/** What `host_local_daemon` will answer. `null` is "no daemon on this computer". */
let announced: { machineId: string; base: string; instanceId: string } | null = null;

type Shell = { core: { invoke: (command: string, args?: unknown) => Promise<unknown> } };

/**
 * The bridge, to the extent this section needs one.
 *
 * ⚠ **`host_cp` has to be here even though nothing in this file is about the
 * control plane.** In the shell `cp.ts` sends every `/v1` request through the host
 * rather than through `fetch`, so a stub that answered only `host_local_daemon`
 * would fail the token mint — and a connection with no token never reaches a route
 * candidate at all, which reads as "the local arm is broken" for a reason that has
 * nothing to do with it. It is routed back through the same `globalThis.fetch`
 * stub, so each section still describes its fleet in one place.
 */
function installShell(): void {
  (globalThis as unknown as { window: { __TAURI__?: Shell } }).window.__TAURI__ = {
    core: {
      invoke: async (command: string, args?: unknown): Promise<unknown> => {
        if (command === "host_local_daemon") return announced;
        if (command === "host_credential_set" || command === "host_credential_clear") return null;
        if (command === "host_cp") {
          const request = (args as { req: { path: string; method: string; body: string | null } }).req;
          const answer = await globalThis.fetch(request.path, {
            method: request.method,
            body: request.body,
          });
          return { status: answer.status, statusText: answer.statusText, body: await answer.text() };
        }
        throw new TypeError(`unexpected command ${command}`);
      },
    },
  };
}

function removeShell(): void {
  delete (globalThis as unknown as { window: { __TAURI__?: Shell } }).window.__TAURI__;
}

/** Every URL the client asked for, in order, so a probe nobody wanted is visible. */
let asked: string[] = [];

interface Answers {
  /** What `/fs/roots` on loopback answers. A number is a bare status. */
  roots: number | { status: number; code: string };
  /** Whether the relay holds a tunnel. */
  relayUp?: boolean;
  /**
   * Whether `POST /v1/tokens` names a key for this machine.
   *
   * `false` omits the field entirely, which is what an Authority answers for a
   * daemon that has never announced one — a build older than the encryption, or
   * one whose row was cleared. It is *absence* rather than `null` on purpose:
   * `mint` reads `issued.machine.key ?? null`, so the two have to be the same
   * thing here or the check is about a spelling.
   */
  machineKey?: false;
  /**
   * How `POST /v1/tokens` refuses, where it refuses at all.
   *
   * ⚠ **409 rather than 401, and nothing keys on the status.**
   * `packages/control-plane/src/app.ts` answers `409 device_key_required` for an
   * installation that has registered no key — `relaycheck` pins that exact pair —
   * and `meansDeviceKeyMissing` reads the **code**, which is the claim the
   * unrelated-409 control below exists to hold. Driving it as a 401 would also
   * drag `authFailure` → `clearSession()` into a section that is about which
   * reason a machine settles on, and would leave the store signed out for the
   * sections that run after this one in the same process.
   *
   * `"transport"` throws instead of answering: `isTransportFailure` is a
   * negation, so an outage cannot be expressed as a status.
   */
  mint?: { status: number; code: string } | "transport";
}

/** How many times the token mint was asked, which is how a re-mint is observed. */
let mints = 0;

function stubFetch(answers: Answers): () => void {
  const real = globalThis.fetch;
  asked = [];
  mints = 0;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === "/v1/tokens") {
      /*
       * Counted before it is refused, because `mints` is *how many times the mint
       * was asked* and a refusal is still an ask. The device-key section below
       * reads the count to prove the one self-repair `mint` has was **not**
       * attempted where there is nothing to register, and a counter that only
       * counted successes would answer 0 for both shapes.
       */
      mints += 1;
      const refusal = answers.mint;
      if (refusal === "transport") throw new TypeError("Failed to fetch");
      if (refusal !== undefined) {
        return json({ error: { code: refusal.code, message: refusal.code } }, refusal.status);
      }
      const now = Date.now();
      return json({
        token: `jws-${String(mints)}`,
        expiresAt: now + 300_000,
        serverTime: now,
        machine: {
          relayUrl: RELAY,
          relayOnline: answers.relayUp !== false,
          ...(answers.machineKey === false ? {} : { key: MACHINE_KEY }),
        },
      });
    }
    asked.push(url);
    if (url.startsWith(LOCAL)) {
      if (url.endsWith("/health")) return json({ ok: true, instanceId: "i_x", authMode: "signed" });
      const answer = answers.roots;
      if (typeof answer === "number") return json({ roots: [] }, answer);
      return json({ error: { code: answer.code, message: answer.code } }, answer.status);
    }
    if (url.endsWith("/health")) return json({ ok: true, instanceId: "i_relay" });
    return json({ sessions: [] });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function connect(id: string, channels: never = fetchChannel) {
  const cp = await import("../src/cp.js");
  const { MachineConnection } = await import("../src/machine.js");
  cp.setSession("rs_local");
  /*
   * `fetchChannel`, because everything this module asserts is about *which arm*
   * a request lands on, and the relay arm has to answer for that to be visible.
   * The encryption itself is `webcheck.e2ee.ts`'s subject.
   *
   * ⚠ **Overridable, and that override is the only way one whole class of rule
   * gets driven at all.** `fetchChannel` sends over `fetch`, so it can fail and
   * it can answer a status — but it can never throw a `ChannelRefused`, which is
   * the shape the *real* channel raises when the daemon turns a handshake away.
   * Every arm `machine.ts` grew for that refusal was therefore unreachable from
   * this driver, which is why the section at the end of this file passes a
   * factory that refuses instead.
   */
  return new MachineConnection(
    { id, name: "laptop", relayUrl: RELAY, relayOnline: true, enrolled: true, owned: true, scopes: [] } as never,
    () => {},
    channels,
  );
}

/* ------------------------------------------------------------------ *
 * A browser never touches loopback, and that is structural
 * ------------------------------------------------------------------ */
{
  /*
   * ⚠ **The arm is dead in a browser rather than merely unused**, and the check is
   * that nothing tries. A page served over `https:` cannot reach `http://127.0.0.1`
   * at all — mixed content, refused before a byte leaves — so a browser build that
   * probed would spend a request per route resolution to learn nothing, on the
   * phone this client is shaped around. `canHostDaemonHere()` is the whole gate
   * and it lives in `native.ts`, behind `localDaemon()` — two modules away from
   * the router, and with no bridge in the page it answers `false`.
   */
  removeShell();
  announced = { machineId: "m_1", base: LOCAL, instanceId: "i_x" };
  const restore = stubFetch({ roots: 200 });
  const connection = await connect("m_1");
  const route = await connection.resolveRoute();
  check("a browser settles on the relay", [route?.base, route?.kind], [RELAY, "relay"]);
  check(
    "and asked loopback nothing at all",
    asked.filter((url) => url.startsWith(LOCAL)),
    [],
  );
  restore();
}

/* ------------------------------------------------------------------ *
 * In the shell, an announced daemon that proves itself is the route
 * ------------------------------------------------------------------ */
{
  installShell();
  announced = { machineId: "m_2", base: LOCAL, instanceId: "i_x" };
  const restore = stubFetch({ roots: 200 });
  const connection = await connect("m_2");
  const route = await connection.resolveRoute();
  check("the app takes the local path", [route?.base, route?.kind], [LOCAL, "local"]);
  /*
   * The order is the assertion. `/fs/roots` carries the credential and settles
   * *which machine this is*; `/health` is unauthenticated and therefore proves
   * nothing, so it is asked afterwards or it would be a stranger's 200.
   */
  check(
    "having proved it with a credential before believing anything unauthenticated",
    asked.map((url) => url.slice(LOCAL.length)),
    ["/fs/roots", "/health"],
  );
  restore();
}

/* ------------------------------------------------------------------ *
 * Which refusals are proof, and which are not
 * ------------------------------------------------------------------ */
{
  /*
   * ⚠ **Any status but 401 is proof, and requiring 200 is the bug this prevents.**
   * `src/server.ts` mounts authentication above every route and authorization per
   * route below it, so a `403 insufficient_scope` from a read-only grant and a bare
   * 404 from a daemon older than a route are both answers from *after* the gate —
   * which means the signature, the issuer, the audience and the window all passed.
   * That is the whole identity claim. A client that insisted on 200 would refuse to
   * use a local daemon over a scope it never needed for the probe.
   */
  installShell();
  for (const [what, roots] of [
    ["a 403 about a scope", { status: 403, code: "insufficient_scope" }],
    ["a 404 from an older daemon", { status: 404, code: "http_404" }],
  ] as const) {
    announced = { machineId: "m_3", base: LOCAL, instanceId: "i_x" };
    const restore = stubFetch({ roots });
    const connection = await connect("m_3");
    const route = await connection.resolveRoute();
    check(`${what} still establishes the machine`, route?.kind, "local");
    restore();
  }

  /*
   * And the one that is not. `wrong_machine` is the only code `src/auth.ts` answers
   * when the audience names another machine, so from loopback it means the
   * announcement is stale — a daemon re-enrolled, or a second one took the port.
   */
  announced = { machineId: "m_4", base: LOCAL, instanceId: "i_x" };
  const restore = stubFetch({ roots: { status: 401, code: "wrong_machine" } });
  const connection = await connect("m_4");
  const route = await connection.resolveRoute();
  check("but a wrong_machine refusal is not", [route?.base, route?.kind], [RELAY, "relay"]);

  /*
   * **Sticky, and that is about cost rather than about correctness.** Route
   * resolution runs on a wake and on the fifteen-second offline retry, so without
   * the memo a machine that is simply shut earns an authenticated loopback request
   * every fifteen seconds for as long as the app is open.
   */
  connection.forgetRoute();
  const before = asked.filter((url) => url.startsWith(LOCAL)).length;
  await connection.resolveRoute();
  check(
    "and it is not asked again in the same session",
    asked.filter((url) => url.startsWith(LOCAL)).length,
    before,
  );

  /*
   * Until the next wake. `store.ts`'s `runResume` calls `update` per machine, which
   * is the cadence at which a re-enrolled or restarted daemon should be re-tested —
   * so this recovers without a reload.
   */
  connection.update({
    id: "m_4",
    name: "laptop",
    relayUrl: RELAY,
    relayOnline: true,
    enrolled: true,
    owned: true,
    scopes: [],
  } as never);
  connection.forgetRoute();
  await connection.resolveRoute();
  report(
    "a wake asks loopback again",
    asked.filter((url) => url.startsWith(LOCAL)).length > before,
    `loopback calls: ${asked.filter((url) => url.startsWith(LOCAL)).length}`,
  );
  restore();
}

/* ------------------------------------------------------------------ *
 * A route that goes stale under a live request gives itself up
 * ------------------------------------------------------------------ */
{
  installShell();
  announced = { machineId: "m_5", base: LOCAL, instanceId: "i_x" };
  let roots: number | { status: number; code: string } = 200;
  const real = globalThis.fetch;
  const calls: string[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === "/v1/tokens") {
      const now = Date.now();
      return json({
        token: "jws-1",
        expiresAt: now + 300_000,
        serverTime: now,
        machine: { relayUrl: RELAY, relayOnline: true, key: MACHINE_KEY },
      });
    }
    calls.push(url);
    if (url.startsWith(LOCAL)) {
      if (url.endsWith("/health")) return json({ ok: true, instanceId: "i_x", authMode: "signed" });
      if (typeof roots === "number") return json({ roots: [] }, roots);
      return json({ error: { code: roots.code, message: roots.code } }, roots.status);
    }
    return json({ sessions: ["from the relay"] });
  }) as typeof fetch;

  const connection = await connect("m_5");
  check("it starts local", (await connection.resolveRoute())?.kind, "local");

  /*
   * The daemon is replaced under the app — the case the memo above cannot reach,
   * because the route is already settled and no probe runs before a request. The
   * refusal has to be read *in flight*, the local arm dropped, and the request
   * retried on the relay so the person never sees it.
   *
   * ⚠ Retrying a `POST` is safe here and nowhere else: `wrong_machine` comes from
   * the middleware above every route, so no handler ran.
   */
  roots = { status: 401, code: "wrong_machine" };
  const answer = await connection.request<{ sessions: string[] }>("/fs/roots", { method: "POST" });
  check("a stale route repairs itself mid-request", answer.sessions, ["from the relay"]);
  check("landing on the relay", connection.currentRoute()?.kind, "relay");

  globalThis.fetch = real;
  removeShell();
}

/* ------------------------------------------------------------------ *
 * The switch, and what it is stored as
 * ------------------------------------------------------------------ */
{
  installShell();
  const { localOff, setLocalOff, localAnnouncedFor, localBaseFor } = await import("../src/localRoute.js");
  announced = { machineId: "m_6", base: LOCAL, instanceId: "i_x" };

  check("a machine nobody has touched is on", localOff("m_6"), false);
  check("and has a local base", await localBaseFor("m_6"), LOCAL);

  setLocalOff("m_6", true);
  check("switching it off is remembered", localOff("m_6"), true);
  check("and takes the base away", await localBaseFor("m_6"), null);
  /*
   * ⚠ **The two nulls Settings has to tell apart.** "No daemon announced itself"
   * and "you switched it off" are the same absence to the router and must never be
   * the same sentence on the screen, which is the whole reason there are two
   * functions rather than one with a flag.
   */
  check("while the announcement itself is still there to say so", await localAnnouncedFor("m_6"), LOCAL);

  check(
    "it is stored as the off list rather than as every machine",
    storage.get("reemoat.localDaemons"),
    '{"off":["m_6"]}',
  );
  setLocalOff("m_6", false);
  check("and switching it back leaves nothing behind", storage.get("reemoat.localDaemons"), '{"off":[]}');

  // A daemon that announced a *different* machine is not this one, however healthy.
  announced = { machineId: "m_other", base: LOCAL, instanceId: "i_x" };
  check("an announcement for another machine is not an answer", await localBaseFor("m_6"), null);

  announced = null;
  check("and no announcement at all is the ordinary case", await localBaseFor("m_6"), null);
  removeShell();
}

/* ------------------------------------------------------------------ *
 * A machine that has announced no key is refused before a socket is dialled
 * ------------------------------------------------------------------ */
{
  /*
   * ⚠ **The refusal to downgrade, and the assertion is *where* it happens.**
   *
   * Everything past the relay candidate reaches the machine through an encrypted
   * channel; there is no second path, no plaintext arm and no flag that would
   * produce one. So a daemon that has never announced an X25519 static is not a
   * machine this client reaches badly — it is a machine it does not reach, with a
   * reason that says what to do about it. `OFFLINE_TEXT` draws that as *"needs a
   * newer daemon"*, which is cleared by updating that machine: the announcement
   * rides its next dial, and nobody re-enrolls anything.
   *
   * ⚠ **And the half that is easy to lose: nothing is dialled.** A check that
   * only read `offlineReason` would still pass for a client that opened a channel,
   * failed the handshake for want of a remote static, and reported the same word —
   * spending a dial, a `credential()` mint and a twenty-second
   * `CHANNEL_READY_TIMEOUT_MS` per route resolution, on a phone, for a state that
   * is knowable from a field already in hand. So the channel handed over here is
   * one that *would* answer `/health` with a 200: if the route resolution reaches
   * it at all, the machine settles online and the reason assertion fails loudly
   * rather than a dial going unnoticed.
   */
  removeShell();
  let dialled = 0;
  const wouldAnswer = (() => ({
    async request(): Promise<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: Uint8Array;
    }> {
      dialled += 1;
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        body: new TextEncoder().encode(JSON.stringify({ ok: true, instanceId: "i_relay" })),
      };
    },
    openSocket(): never {
      throw new Error("this section never opens one");
    },
    dispose(): void {},
  })) as never;

  announced = null;
  const restore = stubFetch({ roots: 200, machineKey: false });
  const connection = await connect("m_nokey", wouldAnswer);
  const route = await connection.resolveRoute();
  check("a machine with no announced key has no route", route, null);
  check("and says which of the two key states it is in", connection.state().offlineReason, "no_machine_key");
  check("while the machine itself is not drawn as reachable", connection.state().reach, "offline");
  report("⭐ and no channel was opened to find that out", dialled === 0, `${String(dialled)} channel request(s)`);
  check(
    "nor was anything asked of the relay by any other route",
    asked.filter((url) => url.startsWith(RELAY)),
    [],
  );

  /*
   * The negative control. Everything above passes for a client that has simply
   * stopped resolving relay routes, so the same fleet with the key present has to
   * settle on the relay through the same factory.
   */
  restore();
  const withKey = stubFetch({ roots: 200 });
  const second = await connect("m_haskey", wouldAnswer);
  check("the same fleet with a key settles on the relay", (await second.resolveRoute())?.kind, "relay");
  report("having actually opened one", dialled > 0, `${String(dialled)} channel request(s)`);
  withKey();
}

/* ------------------------------------------------------------------ *
 * The other key state: an installation no capability can be bound to
 * ------------------------------------------------------------------ */
{
  /*
   * ⚠ **The device-side twin, and it was asserted only as a string.** Every
   * assertion `no_device_key` had is in the section below and every one of them is
   * about the *sentence* — that it exists, that it is not `no_token`'s, that it is
   * not `no_machine_key`'s. **Nothing drove a connection into the state at all**,
   * so the defect the reason exists to fix — `device_key_required` landing on
   * `no_token`, which draws a sentence about a *credential* on **every** machine on
   * the account for one cause that has nothing to do with any of them — is one arm
   * of `mint`'s ternary away from returning with all of them still green. The
   * machine-side twin got this treatment one section up when it landed; this is the
   * half that did not.
   *
   * The refusal driven is `409 device_key_required`, which is what
   * `packages/control-plane/src/app.ts` answers and what `relaycheck` pins as a
   * pair — **not** a 401, for the reason the `mint` field's own docblock gives.
   *
   * ⚠ **The arm driven here is the mechanically reachable one, NOT the production
   * one, and that distinction is the whole caveat on this section.**
   * `registerDevice()` answers `null` wherever `describeDevice()` does, and
   * `describeDevice()` does whenever `inNativeShell()` is false — so with the
   * shell removed `mint`'s one self-repair finds nothing to register and what
   * reaches the ternary is the first attempt's own error. That is what makes the
   * arm drivable in one `settle`.
   *
   * ⚠ **What it is not is the browser's real state.** An earlier spelling of this
   * paragraph said a browser reaches `no_device_key` permanently, and that is
   * false in two independent places. `POST /v1/tokens` guards the refusal on
   * `caller.deviceId !== null` (in `packages/control-plane/src/app.ts`, cited by
   * symbol rather than by line for the reason `machine.ts` gives), and a
   * browser sign-in sends no device at all (`cp.ts`'s `describeDevice()` answers
   * null off `inNativeShell()`), so the Authority mints an **unbound** capability
   * rather than refusing. And even if it did refuse, a browser never gets that
   * far: `e2ee.ts`'s `deviceStaticKey()` answers null with no boot payload, so
   * `dial()` throws a plain `Error` rather than an `ApiError`, `probe` swallows it
   * and `probeRoute` settles `no_route`. The permanent browser state is
   * `no_route`.
   *
   * The production path for `no_device_key` is the **retry** — the first of the
   * two causes {@link OfflineReason.no_device_key} names: a shell where
   * `registerDevice()` answers a row id and the Authority still holds no key for
   * it, so the re-mint is refused a second time. `mints === 1` below therefore
   * pins the shape production does **not** take.
   *
   * ⚠ **And `mints === 2` is not reachable from any driver in this repository**,
   * which is a structural fact rather than work nobody has got to. An earlier
   * spelling of this paragraph called for "a sixth fleet with a shell installed,
   * asserting `mints === 2`"; that fleet cannot exist. `registerDevice()` answers
   * a row id only where `describeDevice()` does, and `describeDevice()` needs a
   * boot payload. `native.ts`'s `boot` is filled in exactly one place — inside the
   * promise `hostReady` starts — and `hostReady` is a module-level `const`
   * evaluated at **import**; the only two other writes to it are both guarded on
   * `boot !== null`. Every run reaches `native.ts` long before this file:
   * `webcheck.stream-and-http.ts` — the first module in `webcheck.ts`'s running
   * order, where this one is line 90 of 92 — imports `cp.ts`, and with it
   * `native.ts`, in a section body with no `__TAURI__` installed; this file's own
   * opening section does the same, with the shell explicitly removed. So
   * `installShell()` here is a bridge with no payload behind it, which
   * `webcheck.native-bridge.ts` pins outright — `nativeBoot()` is `null`.
   * `webcheck.e2ee.ts` records the same constraint for the device *key* and names
   * the seam that answers it (`ChannelOptions.deviceKey`); `registerDevice` has no
   * equivalent, being a static ESM binding in `machine.ts` behind a constructor
   * that takes only a record, an `onChange` and a channel factory.
   *
   * A sixth fleet would therefore drive a shell whose `registerDevice()` still
   * answers `null` — a second copy of the arm below wearing the retry's name,
   * which is the assertion-that-cannot-fail shape this file exists to avoid. What
   * stands in its place is the **cause**, driven at the foot of this section so
   * the gap announces itself the day a seam closes it, and the **ordering**, read
   * off disk, which is the only instrument that reaches it.
   */
  removeShell();
  announced = null;

  /**
   * One fleet, one connection, one route resolution — and what it settled on.
   *
   * A helper rather than five copies because what is interesting is the
   * *difference* between the arms: they are identical but for how `/v1/tokens`
   * answers, which is what makes this read as a partition over one ternary rather
   * than as five unrelated assertions.
   */
  const settle = async (
    id: string,
    mint?: { status: number; code: string } | "transport",
  ): Promise<{ route: string | null; reason: string | null; reach: string; asked: string[]; mints: number }> => {
    const restore = stubFetch({ roots: 200, mint });
    try {
      const connection = await connect(id);
      const route = await connection.resolveRoute();
      return {
        route: route?.kind ?? null,
        reason: connection.state().offlineReason,
        reach: connection.state().reach,
        asked: [...asked],
        mints,
      };
    } finally {
      /*
       * ⚠ **`restore` was on the happy path only, and `globalThis.fetch` is
       * process-wide.** Nothing on this path throws today — `resolveRoute`
       * swallows the mint refusal, which is why the five arms read as a partition
       * rather than as five `try`s — but `connect` awaits two dynamic imports,
       * calls `cp.setSession` and runs the `MachineConnection` constructor, and a
       * refusal added to any of them would leave the stub installed for every
       * section after this one in the same process. That turns one real failure
       * into a cascade of unrelated ones with the cause buried in the middle of
       * them. The returned object is fully evaluated before this runs, so `asked`
       * and `mints` are still captured pre-restore and no arm's value moves.
       */
      restore();
    }
  };

  const missing = await settle("m_nodevice", { status: 409, code: "device_key_required" });
  check("⭐ an installation with no device key has no route", missing.route, null);
  check("and is told so as the device half rather than as a missing token", missing.reason, "no_device_key");
  check("while the machine is not drawn as reachable over a cause on this device", missing.reach, "offline");
  /*
   * And it cost one round trip rather than two. `mint` repairs this refusal
   * **once** — register the key the shell is already holding, then mint again — and
   * in a browser there is nothing to register, so the repair must not be attempted
   * at all. The count is the only observable there is: both shapes reach the caller
   * with the same error and settle on the same reason.
   */
  check("having asked for exactly one capability, there being nothing to register", missing.mints, 1);
  /*
   * ⚠ **And nothing was probed.** A state knowable from the mint's own refusal, and
   * read at the route candidate instead, spends a `/health` per route resolution —
   * on a phone, every fifteen seconds — to learn what was already in hand. The same
   * rule as the "no channel was opened" report one section up, measured with the
   * only instrument this arm has. It is not a vacuous emptiness: the positive
   * control at the foot of this section reads the same array through the same
   * helper and *requires* the relay probe to be in it.
   */
  check("and probed nothing to find that out", missing.asked, []);

  /*
   * ⚠ **The controls, and the first is the sharp one.** Everything above passes for
   * a client that answers `no_device_key` for any refusal at all — and also for one
   * keyed on the **status**, since `device_key_required` is a 409. So the first
   * control is another 409 **from the same route**: `machine_not_enrolled` is what
   * `POST /v1/tokens` answers one guard earlier, which is exactly the claim
   * `meansDeviceKeyMissing` makes for itself — the code, never the status.
   *
   * That is the second reason this section is driven as a 409 rather than as the
   * 401 it reads like. An unrelated 401 control catches the first mutant and lets
   * the status-keyed one straight through, because a 401 is not a 409 either way.
   */
  const notEnrolled = await settle("m_notenrolled", { status: 409, code: "machine_not_enrolled" });
  check("another 409 from the same route is not the device half", notEnrolled.reason, "no_token");
  const revoked = await settle("m_revoked", { status: 403, code: "machine_revoked" });
  check("nor is a refusal that arrives under another status", revoked.reason, "no_token");

  /*
   * The arm the device one was inserted **under**, and the only row that holds it
   * still reachable. It has to be driven from the other side of a negation:
   * `isTransportFailure` is "not an `ApiError`", so a control plane that cannot be
   * reached has refused nothing, and reading an outage as a missing key would send
   * somebody to a Devices screen that cannot load either. Folding the outage into
   * either code — the shape of edit that adds a third arm to a two-arm ternary —
   * passes every row above and fails only here.
   */
  const down = await settle("m_cpdown", "transport");
  check("and an unreachable control plane is neither of them", down.reason, "cp_unreachable");

  /*
   * The positive control none of the four above can supply between them: every
   * assertion so far is satisfied by a client that has quietly stopped settling
   * routes and reports offline for everything, so the same fleet with the mint
   * answering has to reach the relay carrying no reason at all — and has to have
   * asked the relay something to get there.
   */
  const minted = await settle("m_minted");
  check(
    "while the same fleet with a mint that answers settles on the relay",
    [minted.route, minted.reason, minted.reach],
    ["relay", null, "online"],
  );
  report(
    "having actually probed it, which is what makes the emptiness above a measurement",
    minted.asked.some((url) => url.startsWith(RELAY)),
    minted.asked.join(", ") || "(nothing was asked)",
  );

  /*
   * ⚠ **The cause of the gap, driven rather than argued** — so the paragraph at
   * the head of this section is a measurement and not a recollection, and so the
   * gap announces itself the day it closes.
   *
   * The claim is about `describeDevice()` rather than about this driver: with the
   * bridge installed and no boot payload behind it, `registerDevice()` must still
   * answer `null`, and must not have asked the control plane anything to find that
   * out (`inNativeShell()` reads `window.__TAURI__` on every call, so the shell is
   * seen; `nativeBoot()` is what stays `null`).
   *
   * It goes red two ways and both are worth having. If `describeDevice()` ever
   * starts guessing a device where there is no boot payload, a row of the
   * account's device limit is spent per launch — the outcome `cp.ts`'s own
   * docblock refuses a browser name for — and this fails. And the day somebody
   * adds the seam that makes a boot payload installable late, this fails too,
   * which is the day this section owes the sixth fleet the paragraph above says
   * cannot be written.
   */
  {
    installShell();
    const { registerDevice } = await import("../src/cp.js");
    const restore = stubFetch({ roots: 200 });
    try {
      /*
       * Caught rather than left to throw, so a regression that starts *sending*
       * lands as a FAIL on this line instead of as an unhandled rejection that
       * takes the thirty sections after this one with it.
       */
      const registered = await registerDevice().catch((error: unknown) => `threw: ${String(error)}`);
      check("a shell with no boot payload describes no device to register", registered, null);
      /*
       * Not a vacuous emptiness: `asked` is the same array the `minted` control
       * twenty lines up *requires* to carry the relay probe, filled through the
       * same stub — and in the shell `cp.ts` routes every `/v1` request back
       * through it, so a registration that went out would be in here.
       */
      check("and asked the control plane nothing to find that out", asked, []);
    } finally {
      restore();
      removeShell();
    }
  }

  /*
   * ⚠ **The ordering the fleets above cannot produce, read off disk.** Register,
   * then re-mint, then settle a reason — the production path for `no_device_key`,
   * and the one thing no driver here can reach. Worth pinning precisely because
   * the arm that *is* driven reaches the ternary from the other side: `mints === 1`
   * above is satisfied by a `mint` with no retry in it at all.
   *
   * Comment-stripped, this repository's standing rule — the block sliced below is
   * wrapped in three docblocks that restate every one of these facts in prose —
   * and whitespace-flattened, because prettier decides where these lines wrap.
   */
  {
    const mint =
      /private async mint\(firstAttempt = true\): Promise<string> \{([\s\S]*?)\n  \}/.exec(
        stripComments(readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8")),
      )?.[1] ?? "";
    /*
     * Proof of life. Every assertion below reads a slice that defaults to the
     * empty string, so a pattern that stopped matching `mint` at all would fail
     * them for a reason that has nothing to do with `mint`'s body. 1327 bytes when
     * this was written.
     */
    report("mint was found to read", mint.length > 0, `${String(mint.length)} bytes`);
    const flat = mint.replace(/\s+/g, " ");

    check(
      "the one self-repair is guarded on the first attempt rather than run on every refusal",
      flat.includes("if (firstAttempt && meansDeviceKeyMissing(error)) {"),
      true,
    );
    /*
     * And the recursion says so. Without the `false` the guard above is not a
     * guard: a registration that does not take mints, is refused, registers,
     * mints — a loop against the control plane rather than the refusal it is.
     */
    check(
      "and the re-mint it runs says it is not the first attempt",
      flat.includes("if (registered !== null) return await this.mint(false);"),
      true,
    );
    /*
     * Reversed — the reason written before the repair is tried — a machine that
     * repairs itself is still drawn offline until something asks again.
     */
    const repairAt = mint.indexOf("registerDevice");
    const reasonAt = mint.indexOf("this.offlineReason");
    report(
      "and the repair is tried before a reason is settled rather than after",
      repairAt > 0 && repairAt < reasonAt,
      `registerDevice at ${String(repairAt)}, offlineReason at ${String(reasonAt)}`,
    );
    /*
     * ⚠ **The reason is keyed on the code, never on the attempt**, which is the
     * whole of why the first-attempt case — the one with no registration to
     * re-fail, and the only one this file can drive — is covered by the same line.
     * Pinned as the entire expression rather than as a `/no_device_key/` search: a
     * third arm inserted anywhere in it, the two key arms swapped, or the transport
     * arm folded into either code reads identically to a search and fails here.
     */
    check(
      "and the reason it settles is keyed on the refusal's code rather than on the attempt",
      (/this\.offlineReason = [\s\S]*?;/.exec(mint)?.[0] ?? "").replace(/\s+/g, " "),
      'this.offlineReason = isTransportFailure(error) ? "cp_unreachable" : meansDeviceKeyMissing(error) ? "no_device_key" : "no_token";',
    );
  }
}

/* ------------------------------------------------------------------ *
 * The two key states, and the two sentences they are owed
 * ------------------------------------------------------------------ */
{
  const { OFFLINE_TEXT } = await import("../src/ui/bits.js");

  /*
   * ⚠ **`no_device_key` was reported as `no_token`, which is a sentence about a
   * *credential* for a cause that is a missing **key**.** "no token" sends
   * somebody to look at their sign-in, which is working, and then at their
   * machines, which are also working, and there was no remedy anywhere on the
   * screen. The machine-side twin got its own reason and its own instruction when
   * it landed; this half got neither, so every machine on the account drew
   * "no token" for one cause that had nothing to do with any of them.
   *
   * The sweep over the whole table is `webcheck.machine-limit-and-probe.ts`'s and
   * stays there. What this adds is the one pair that has to *differ*: a table is
   * total and every entry is a non-empty phrase long before two of its entries
   * say the same thing.
   */
  report("both key states have a sentence", OFFLINE_TEXT.no_device_key.length > 0 && OFFLINE_TEXT.no_machine_key.length > 0, `${OFFLINE_TEXT.no_machine_key} / ${OFFLINE_TEXT.no_device_key}`);
  check("and the device half is not the credential half's", OFFLINE_TEXT.no_device_key === OFFLINE_TEXT.no_token, false);
  /*
   * ⚠ **Nor the machine half's**, which is the other way this pair collapses: the
   * two are twins pointed in opposite directions — one is *that computer needs a
   * newer daemon*, the other is *this one cannot reach anything* — and a person
   * told the first about the second updates a machine that was never at fault.
   */
  check("nor the machine half's", OFFLINE_TEXT.no_device_key === OFFLINE_TEXT.no_machine_key, false);
  /*
   * And both read as instructions rather than as faults, which is the property
   * that separates them from everything else in that table: they are the only two
   * entries a person can act on, and a word like "unreachable" in either is a
   * state somebody waits out for ever.
   */
  check(
    "and each names the computer its remedy is on",
    [/daemon/.test(OFFLINE_TEXT.no_machine_key), /this device/.test(OFFLINE_TEXT.no_device_key)],
    [true, true],
  );
}

/* ------------------------------------------------------------------ *
 * A channel the daemon refused, said in this client's own vocabulary
 *
 * ⚠ **None of this was driven anywhere, and it could not be.** `fetchChannel` —
 * the relay arm every other section here runs on — sends over `fetch`, so it can
 * fail and it can answer a status, and it can never throw a `ChannelRefused`.
 * That class is what the *real* channel raises when the daemon turns a handshake
 * away, and `asAnsweredRefusal` is the translation that lets the rest of
 * `machine.ts` read one. Until this section there was no factory in this
 * repository that refused, so every arm below was reachable only in production.
 *
 * `ChannelRefused` is an `Error`, and `isTransportFailure` is a *negation* — "not
 * an `ApiError`" — so before the translation existed every refusal the daemon
 * took the trouble to deliver was classified as a dropped connection. Three
 * behaviours were wrong because of it, and each one is an arm below.
 * ------------------------------------------------------------------ */
{
  removeShell();
  const { ChannelRefused } = await import("../src/e2ee.js");
  const { errorText } = await import("../src/http.js");

  /** Refusals answered, not counting the `/health` the route probe spends. */
  let refusals = 0;

  /*
   * A channel that comes up, answers the probe, and then refuses — which is the
   * real shape of every one of these. A factory that refused the probe too would
   * never settle a route at all, and `prepare()` would throw `503 unreachable`
   * before a single arm below was reached.
   */
  const refusing = (status: number, reason: string) =>
    (() => ({
      async request(wanted: { path: string }): Promise<{
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: Uint8Array;
      }> {
        if (wanted.path === "/health") {
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: new TextEncoder().encode(JSON.stringify({ ok: true, instanceId: "i_relay" })),
          };
        }
        refusals += 1;
        throw new ChannelRefused(status, reason);
      },
      openSocket(): never {
        throw new Error("this section never opens one");
      },
      dispose(): void {},
    })) as never;

  const refused = async (
    id: string,
    status: number,
    reason: string,
  ): Promise<{ code: string; message: string; sentence: string; attempts: number; mints: number; reach: string; route: string | null }> => {
    const restore = stubFetch({ roots: 200 });
    refusals = 0;
    const connection = await connect(id, refusing(status, reason));
    check(`${reason}: the route settles before anything is refused`, (await connection.resolveRoute())?.kind, "relay");
    const mintsAfterRoute = mints;
    let caught: unknown;
    try {
      await connection.request("/sessions");
    } catch (error) {
      caught = error;
    }
    const answer = {
      code: (caught as { code?: string }).code ?? "(not an ApiError)",
      message: (caught as Error).message,
      sentence: errorText(caught),
      attempts: refusals,
      mints: mints - mintsAfterRoute,
      reach: connection.state().reach,
      route: connection.currentRoute()?.kind ?? null,
    };
    restore();
    return answer;
  };

  /* -- ⚠ a 502 truncated, which is the one that was replayed --------------- */

  {
    /*
     * ⚠ **`src/e2ee.ts`'s `fail()` `end()`s the stream rather than `destroy()`ing
     * it precisely so this frame survives and reaches the app as a refusal** —
     * which `settleTransport` then read as a dead link, dropped the route memo,
     * and **replayed** for any replayable method. `GET /sessions` is replayable,
     * so it is the method this arm has to be driven with or the bug hides behind
     * the whitelist. Q6.103 is the measurement that bought the frame; this is
     * what it was for.
     *
     * The assertion is the **count**. A refusal that is thrown once and a refusal
     * that is thrown, replayed and thrown again reach the caller with the same
     * message, so the only thing that tells them apart is how many times the
     * daemon was asked.
     */
    const truncated = await refused("m_truncated", 502, "truncated");
    check("⭐ a 502 truncated is asked exactly once", truncated.attempts, 1);
    check("and reaches the caller as an answered refusal", [truncated.code, truncated.route], ["truncated", "relay"]);
    /*
     * And the route memo is kept. Dropping it is the other half of the replay:
     * `forgetRoute` sends the next request through a full re-probe, so a daemon
     * that gave up on one body costs every subsequent request a round trip.
     */
    check("the machine is not drawn as unreachable over it", truncated.reach, "online");
    check(
      "and the sentence names what happened rather than the weather",
      truncated.sentence,
      "laptop refused this connection: truncated",
    );
  }

  /* -- 401 token_expired, the one refusal with a remedy -------------------- */

  {
    /*
     * ⚠ **The unconditional re-mint lives on the `ApiError` path and a
     * `ChannelRefused` never joined it**, so a capability that aged out between
     * two requests failed as weather instead of being renewed.
     *
     * And re-minting alone does not reach it: `src/e2ee.ts` pins the capability
     * presented at `HELLO` onto every inner request and *replaces* whatever the
     * client sent, so a fresh token handed to a pooled connection is a header the
     * daemon throws away. The channel has to go with the token, which is why
     * `settleRefusal` calls `closeChannel()` first.
     */
    const expired = await refused("m_expired", 401, "token_expired");
    check("⭐ a token_expired refusal is retried once", expired.attempts, 2);
    report("having minted a fresh capability in between", expired.mints > 0, `${String(expired.mints)} mint(s)`);
    check("and the second refusal is the one the caller gets", expired.code, "token_expired");
    check("the route is still believed", [expired.reach, expired.route], ["online", "relay"]);
    check(
      "with the daemon's own word in the sentence",
      expired.sentence,
      "laptop refused this connection: token_expired",
    );
  }

  /* -- 401 wrong_machine, from the arm that may not act on it -------------- */

  {
    /*
     * ⚠ **`route.kind` is the guard rather than the code alone.** Down the tunnel
     * the relay has already derived the machine from the same verified `aud`
     * before a byte moved, so a `wrong_machine` from *there* is two services
     * disagreeing about one fact — not a reason for one client to abandon the
     * only path it has. The local arm's drop-and-retry is driven four sections
     * up; this is the same code arriving through the other door and doing
     * nothing.
     */
    const wrong = await refused("m_wrongmachine", 401, "wrong_machine");
    check("⭐ a wrong_machine from the relay is not retried", wrong.attempts, 1);
    check("and the relay route survives it", [wrong.reach, wrong.route], ["online", "relay"]);
    check("while the caller is told the code rather than a network story", wrong.code, "wrong_machine");
    check(
      "and the sentence says which machine refused it",
      wrong.sentence,
      "laptop refused this connection: wrong_machine",
    );
  }

  /* -- 401 unbound_capability, which nothing can fix from here ------------- */

  {
    /*
     * A capability with no `cnf` is refused on a channel rather than treated as
     * unbound — without that the binding is optional, and a caller gets bearer
     * semantics by not asking for a binding. There is no remedy on this side, so
     * the only requirement is that the verifier's own word survives: `errorText`
     * said *"the connection failed, and whether the request arrived is not
     * known"* for this, for `wrong_machine` and for `wrong_device` alike, burying
     * the one part of the failure anybody can act on.
     */
    const unbound = await refused("m_unbound", 401, "unbound_capability");
    check("⭐ an unbound capability is reported by its own name", unbound.code, "unbound_capability");
    check("once, with no replay", unbound.attempts, 1);
    check(
      "and the sentence carries the verifier's word",
      unbound.sentence,
      "laptop refused this connection: unbound_capability",
    );
    /*
     * The negative control for all four sentences above: the transport sentence
     * is what they must *not* be, and it is the string every one of them used to
     * be. Asserted against a genuine transport failure so the comparison is
     * against the live value rather than against a copy of it typed here.
     */
    check(
      "which is not the sentence a dropped connection draws",
      unbound.sentence === errorText(new TypeError("Failed to fetch")),
      false,
    );
  }
}

/* ------------------------------------------------------------------ *
 * The rules that are easier to read off disk than to drive
 * ------------------------------------------------------------------ */
{
  const machine = stripComments(readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8"));

  /*
   * ⚠ **The guard is the tag, not the predicate.** `meansWrongMachine` alone would
   * apply the drop to the relay arm too — where the relay has already derived the
   * machine from the same verified `aud` before a byte moved, so the code would
   * mean two services disagreeing about one fact rather than "reach it the other
   * way". Asserted off the source because a driver cannot make a relay send it.
   */
  check(
    "the mid-request drop is guarded on the local tag",
    /this\.chosen\?\.kind === "local" && meansWrongMachine\(error\)/.test(machine),
    true,
  );

  /*
   * ⚠ **`forgetRoute` is not what gives the local arm up**, and calling it would be
   * a loop: it drops the memo, and the very next `resolveRoute` probes loopback
   * again, for ever. `denyLocal` is the one that also stops asking.
   */
  check("and it is denyLocal rather than forgetRoute that runs", /denyLocal\(\);\s*\n\s*if \(firstAttempt\)/.test(machine), true);

  /*
   * The loopback candidate has to sit **above** the `relayOnline` check. Below it,
   * a laptop whose tunnel is down — the machine this whole feature is for, three
   * feet away and running — never reaches the candidate at all.
   */
  /*
   * ⚠ **The switch is drawn where an unreachable machine can still reach it**, and
   * it shipped once inside the gate that hides everything read *from* the daemon.
   * That gate is `listable = machine.enrolled && read === "readable"`, and the state
   * it excludes — tunnel down, relay down, control plane unreachable — is the exact
   * state where a daemon three feet away is still answering on loopback. Hidden
   * there, the one control that repairs the screen disappears when it would have
   * worked. Asserted by position because nothing typed can hold a placement, the
   * same reason the plugin settings screen is pinned that way.
   */
  const section = readFileSync(
    new URL("../src/ui/settings/MachineSection.tsx", import.meta.url),
    "utf8",
  );
  const gateOpens = section.indexOf("{listable ? (");
  /*
   * The ternary's own close, found by indentation: everything inside it is nested
   * deeper, so the first `)}` back at this JSX level is where it ends. Cheaper and
   * less brittle than matching brackets, and it fails loudly rather than quietly if
   * the file is ever reformatted.
   */
  const gateCloses = section.indexOf("\n      )}", gateOpens);
  const drawn = section.indexOf("<LocalPath ");
  report(
    "the local-path switch survives a machine reading unreachable",
    gateOpens > 0 && gateCloses > gateOpens && drawn > gateCloses,
    `gate ${gateOpens}..${gateCloses}, drawn at ${drawn}`,
  );

  const localAt = machine.indexOf("localBaseFor(this.id)");
  const relayAt = machine.indexOf("this.relayOnline ? this.relayUrl : null");
  report(
    "and the candidate is tried above the control plane's own opinion",
    localAt > 0 && relayAt > 0 && localAt < relayAt,
    `local at ${localAt}, relayOnline at ${relayAt}`,
  );
}

/* ------------------------------------------------------------------ *
 * Which machine is *this* one, and why that is not the route
 *
 * ⚠ **The 2026-09-15 reversal's other half.** The machine this app sets up is
 * labelled after the computer now, like every other machine, because that label
 * is read by a phone and by every other client of the account. What is left
 * saying "you are sitting at this one" is drawn per client — a `this device` badge
 * in Settings → Machines, and the name `local`, first, on the home screen — and
 * both need a fact that is true per client: the announce file, which is what
 * `localDaemon` reads.
 *
 * Driven above for the value (`localAnnouncedFor` against a stubbed
 * `host_local_daemon`); asserted off disk here for the two wirings a value test
 * cannot see — where the store gets it from, and when it asks again.
 * ------------------------------------------------------------------ */
{
  const store = stripComments(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));

  check("the store keeps which machine this computer is", /localMachineId: MachineId \| null;/.test(store), true);
  check("and fills it from the daemon's announce file", /const found = await localDaemon\(\);/.test(store), true);

  /*
   * ⚠ **Not `route.kind === "local"`, and this is a negative on purpose.** The
   * route is a *preference*: `setLocalOff` turns the loopback path off per machine
   * (driven two sections up), and a badge keyed on it would vanish from the
   * machine somebody is sitting at the moment they chose the relay. Identity and
   * reachability are the same file read and two different questions.
   */
  const refresher = /private async refreshLocalMachine\(\)[\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
  check("refreshLocalMachine was found to read", refresher.length > 0, true);
  check("and it never consults the routing preference", /localOff|localBaseFor|kind === "local"/.test(refresher), false);

  /*
   * ⚠ **A memo, where `localBaseFor` refuses one — so *when* it is refreshed is
   * the whole of its correctness.** `runResume` is the funnel every wake, every
   * machine mutation (`machinesChanged`) and the bootstrap promotion already pass
   * through. Asked anywhere narrower and a daemon that starts *after* the app — on
   * a laptop where both come up at login, the ordinary case — is never badged.
   */
  const resume = /private async runResume\([\s\S]*?\n    this\.patch\(\{ resuming: true \}\);[\s\S]{0,400}/.exec(store)?.[0] ?? "";
  check("and the resume funnel is what asks again", /await this\.refreshLocalMachine\(\);/.test(resume), true);
  /*
   * ⚠ **And once before the first paint of the rail**, beside the two listings
   * `bootstrap` already awaits. The home screen calls this machine `local` and
   * puts it first, so a read that landed only in `runResume` — after
   * `phase: "ready"` had drawn the list — renamed and moved it once on every
   * launch where the daemon was already up.
   */
  const boot = /async bootstrap\(\)[\s\S]*?this\.patch\(\{ phase: "ready", me/.exec(store)?.[0] ?? "";
  check("bootstrap was found to read", boot.length > 0, true);
  check(
    "and it asks which computer this is inside the same wait as the listing",
    /await Promise\.all\(\[[\s\S]*?cp\.machines\(\)[\s\S]*?this\.refreshLocalMachine\(\),\s*\]\);/.test(boot),
    true,
  );
  /*
   * ⚠ **And before that wait, the seed — because on a cold launch that read has
   * nothing to find.** The app stops its own daemon at quit, the daemon removes
   * its announce file on the clean stop, and `setUpThisComputer` starts it again
   * only after `phase: "ready"`. So the read above answered `null` on every launch
   * of the app-run daemon, and the rail renamed and reordered itself a moment
   * after the first paint. The claim the host keeps for this server is on disk
   * and needs nothing listening; the section below drives what the two methods
   * do with it.
   */
  const seedAt = boot.indexOf("this.seedLocalMachine(boot.claimed);");
  check("bootstrap seeds it from the boot payload's claim", seedAt > 0, true);
  check("before the live read is asked", seedAt < boot.indexOf("await Promise.all(["), true);
  check("and the live read is weighed rather than assigned", /this\.weighLocalMachine\(\);/.test(refresher), true);
  check(
    "against what is known and the machines held",
    /weighLocalMachine\(answer: MachineId \| null = this\.announcedMachine\)[\s\S]{0,160}localMachineAfter\(known, answer, /.test(store),
    true,
  );
  /*
   * ⚠ **And weighed again once each listing lands.** *"A machine of ours"* is a
   * question about the list, and both reads are made before it is current —
   * `bootstrap`'s beside the listing, `runResume`'s ahead of the re-list — so a
   * machine this app has only just created, the daemon that has just come up, is
   * ours only after them. Without the second weighing a claim for a machine since
   * switched off outranks it until the next wake.
   */
  check(
    "bootstrap weighs it again before the first paint",
    /this\.weighLocalMachine\(\);\s*this\.patch\(\{ phase: "ready", me/.test(store),
    true,
  );
  check(
    "and a resume, after its re-list",
    (store.match(/this\.dropMachine\(id\);\s*\}\s*this\.weighLocalMachine\(\);/g) ?? []).length,
    1,
  );
  /*
   * ⚠ **And the machine just created is this computer at once, on both paths that
   * create one.** It is in the list from the `machinesChanged` before it, so it is
   * weighed like a live answer there; left to `settleDaemon`, the new tile was
   * drawn under the host name, in name order, until its child announced itself.
   */
  check(
    "a machine created for this computer is weighed as it the moment the listing holds it",
    (
      store.match(
        /await this\.machinesChanged\("machine-added"\);\s*this\.weighLocalMachine\(machineId\(created\.machine\.id\)\);\s*await this\.settleDaemon\(created\.machine\.id/g,
      ) ?? []
    ).length,
    2,
  );

  /*
   * **The second reader of that fact, and it wants it for the same reason the
   * badge does.** New session draws this computer's own file panel instead of
   * walking the daemon's tree over the wire — which is only ever right where the
   * daemon *is* this computer, and `localMachineId` is the only thing in the
   * client that answers that. The negative beside it is the one that matters: a
   * picker keyed on `route.kind` would put the tree back the moment somebody chose
   * the relay on the machine they are sitting at, and a screen could not reach
   * `route.kind` anyway — `MachineConnection` is pinned to four modules a section
   * up and no `ui/` file is among them.
   */
  const start = stripComments(readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"));
  check(
    "the OS panel is gated on which computer this is, and on the shell saying it can",
    /osDialog=\{nativeBoot\(\)\?\.picksFolder === true && state\.localMachineId === selected\}/.test(start),
    true,
  );
  /*
   * ⚠ **`picksFolder` rather than `inNativeShell()`, and an APK that would not
   * compile is why.** A shell exists on Android too and has no folder panel there:
   * `tauri-plugin-dialog` offers no `blocking_pick_folder`, because the platform's
   * own answer is a Storage Access Framework tree URI rather than a path. So "is
   * there a shell" is not the question — "can this shell do it" is, and the shell
   * is what answers. `nativecheck` holds that capability to the `#[cfg]` its
   * implementation actually carries.
   */
  check("and a shell that cannot do it is not asked", /inNativeShell\(\)/.test(start), false);
  check("and never on the routing preference", /localOff|route\.kind|kind === "local"/.test(start), false);
  /*
   * One derivation and one mount. Two `<DirectoryPicker` call sites would be two
   * places for the predicate to disagree with itself, and a second
   * `localMachineId` in this file would be the copy that gets it wrong.
   */
  check("it is derived once", (start.match(/localMachineId/g) ?? []).length, 1);
  check("and there is one picker for both arms to live in", (start.match(/<DirectoryPicker/g) ?? []).length, 1);
  /*
   * ⚠ **And no listing is issued on that arm.** The point of the panel is the
   * round trip it removes; a tree drawn beside it would be two controls answering
   * one question, which is the defect the one-writer rule in
   * `webcheck.machine-limit-and-probe.ts` already exists for.
   */
  check("the listing effect stands down where the panel stands up", /path === null \|\| osDialog\) return;/.test(start), true);
}

/* ------------------------------------------------------------------ *
 * Seeded, then sticky — the store's own two methods, driven
 *
 * `localMachineAfter` is asserted by value one driver over; what that cannot see
 * is that the store calls it, with *which* `known`, and against *which* list. So
 * this drives `seedLocalMachine` and `refreshLocalMachine` on the real store,
 * through the stubbed `host_local_daemon`, in the order a cold launch takes them:
 * the claim first, then a live read that finds nothing, then the reads a wake and
 * a restart can produce.
 *
 * ⚠ **Two stand-in connections, and nothing yields while they are there.** The
 * live read asks `connections.has`, and a patch publishes each entry's `state()`
 * — so a stand-in answers that and nothing else. Every await below is a resolved
 * promise or the stub's own `async`, so no poll tick can reach an entry that is
 * not a `MachineConnection` before they are deleted, and the last patch publishes
 * the list without them.
 * ------------------------------------------------------------------ */
process.stdout.write("\nwhich computer this is, seeded and then sticky\n");
{
  const { store } = await import("../src/store.js");
  const internals = store as unknown as {
    seedLocalMachine(claimed: string | null): void;
    refreshLocalMachine(): Promise<void>;
    weighLocalMachine(): void;
    patch(fields: { localMachineId: string | null }): void;
    connections: Map<string, unknown>;
  };
  const local = (): string | null => store.getSnapshot().localMachineId;
  const live = (id: string) => ({ machineId: id, base: LOCAL, instanceId: "i_sticky" });

  installShell();
  internals.patch({ localMachineId: null });
  const standIn = (id: string) => ({ state: () => ({ id, name: id }) });
  internals.connections.set("m_claim", standIn("m_claim"));
  internals.connections.set("m_moved", standIn("m_moved"));
  announced = null;

  internals.seedLocalMachine("m_claim");
  check("the claim is which computer this is before any daemon has answered", local(), "m_claim");
  await internals.refreshLocalMachine();
  check("and a live read that finds nothing — every cold launch — leaves it", local(), "m_claim");
  announced = live("m_stranger");
  await internals.refreshLocalMachine();
  check("a daemon for another fleet answering first does not move it", local(), "m_claim");
  announced = live("m_moved");
  await internals.refreshLocalMachine();
  check("a different machine of ours, live, replaces it", local(), "m_moved");
  announced = null;
  await internals.refreshLocalMachine();
  check("and a /health that misses its probe does not clear that either", local(), "m_moved");
  internals.seedLocalMachine("m_claim");
  check("while a seed never replaces what a live read said", local(), "m_moved");
  internals.patch({ localMachineId: null });
  internals.seedLocalMachine(null);
  check("and no claim seeds nothing", local(), null);

  /*
   * The machine this app has just created: its daemon answers before the re-list
   * that makes it ours. Not at the read, then — and at the weighing after it.
   */
  internals.seedLocalMachine("m_claim");
  announced = live("m_fresh");
  await internals.refreshLocalMachine();
  check("a machine not in the list yet does not replace one that is", local(), "m_claim");
  internals.connections.set("m_fresh", standIn("m_fresh"));
  internals.weighLocalMachine();
  check("and does once the listing that holds it has landed", local(), "m_fresh");

  internals.connections.delete("m_claim");
  internals.connections.delete("m_moved");
  internals.connections.delete("m_fresh");
  internals.patch({ localMachineId: null });
  announced = null;
  removeShell();
}
