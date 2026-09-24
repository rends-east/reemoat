import { readFileSync } from "node:fs";
import { check, fetchChannel, report, sleep } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";
import {
  attachWithin,
  attaches,
  events,
  forgotten,
  hello,
  newStream,
  nextAttach,
  recorder,
} from "./webcheck.ws.js";

process.stdout.write("\nthe cursor across a rotation\n");
{
  attaches.length = 0;
  const rec = recorder();
  const stream = newStream(rec.sink, 0);
  stream.start();

  const first = await nextAttach(1);
  check("the first socket attaches from the cursor it was given", first.since, 0);
  hello(first, 0);
  events(first, 1, 5);
  await sleep(50);
  check("events arrive once", rec.seqs, [1, 2, 3, 4, 5]);
  check("and the cursor follows them", stream.cursor, 5);

  // The old socket keeps delivering during the handshake, so the replacement's `hello` must not rewind the cursor.
  (stream as unknown as { rotate: () => Promise<void> }).rotate();
  const second = await nextAttach(2);
  check("the replacement attaches from the live cursor", second.since, 5);

  events(first, 6, 8);
  await sleep(30);
  check("the old socket keeps delivering during the handshake", stream.cursor, 8);

  hello(second, 5);
  events(second, 6, 10);
  await sleep(50);

  check("nothing is delivered twice across the rotation", rec.seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  check("and the cursor never went backwards", stream.cursor, 10);
  report("no gap was invented", rec.gaps.length === 0, `${rec.gaps.length} gap(s)`);
  stream.stop();
}

// A primary dying mid-handshake must still release `successor`, or every later rotation is silently skipped.

process.stdout.write("\na rotation the primary died underneath\n");
{
  attaches.length = 0;
  const rec = recorder();
  const stream = newStream(rec.sink, 0);
  const rotate = (): void => void (stream as unknown as { rotate: () => Promise<void> }).rotate();
  stream.start();

  const first = await nextAttach(1);
  hello(first, 0);
  events(first, 1, 3);
  await sleep(40);

  rotate();
  const orphan = await nextAttach(2);

  first.terminate();
  const third = await attachWithin(3, 3_000);
  report("the stream still comes back", third !== null, `${attaches.length} socket(s) opened`);
  if (third !== null) {
    hello(third, 3);
    await sleep(40);
    report("and the orphaned replacement was closed rather than left attached", orphan.closed, `closed: ${orphan.closed}`);

    rotate();
    const fourth = await attachWithin(4, 1_000);
    report(
      "a later rotation still happens, so the successor slot was given back",
      fourth !== null,
      `${attaches.length} socket(s) opened`,
    );
    check("and it asks from the live cursor", fourth?.since, 3);
  }
  stream.stop();
}

process.stdout.write("\nreplay across a reconnect\n");
{
  attaches.length = 0;
  const rec = recorder();
  const stream = newStream(rec.sink, 0);
  stream.start();

  const first = await nextAttach(1);
  hello(first, 0);
  events(first, 1, 3);
  await sleep(50);

  const before = forgotten;
  first.terminate();
  await sleep(60);
  report("a transport close drops the route memo", forgotten > before, `forgetRoute called ${forgotten - before}×`);

  const second = await nextAttach(2);
  check("and reconnects from the cursor, not from zero", second.since, 3);
  hello(second, 3);
  events(second, 4, 6);
  await sleep(50);
  check("no event is repeated and none is skipped", rec.seqs, [1, 2, 3, 4, 5, 6]);
  stream.stop();
}

process.stdout.write("\nwhich answered request means the machine is gone\n");
{
  const { ApiError, meansMachineGone, meansRestartRefused } = await import("../src/http.js");
  const err = (status: number, code: string): unknown => new ApiError(status, code, `${code}`);

  check("the relay saying there is no tunnel does", meansMachineGone(err(503, "no_tunnel")), true);
  check("and the relay refusing one over the machine limit", meansMachineGone(err(403, "machine_over_limit")), true);
  check("and one whose owner is banned", meansMachineGone(err(403, "owner_disabled")), true);

  // `turn_in_flight` is the one config refusal the strip swallows; keyed on the code, since other 409s stay loud. Q3.429.
  check("the restart refusal is the one the row already answered", meansRestartRefused(err(409, "turn_in_flight")), true);
  check(
    "and every other config refusal still reaches the screen",
    [
      meansRestartRefused(err(409, "session_busy")),
      meansRestartRefused(err(409, "session_not_ready")),
      meansRestartRefused(err(409, "session_terminal")),
      meansRestartRefused(err(502, "agent_config_failed")),
      meansRestartRefused(err(400, "invalid_config_value")),
      meansRestartRefused(new TypeError("fetch failed")),
    ],
    [false, false, false, false, false, false],
  );
  {
    const bar = readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    check("the strip still raises a toast, twice", (bar.match(/toast\(/g) ?? []).length, 2);
    check("and suppresses exactly one code", (bar.match(/meansRestartRefused\(/g) ?? []).length, 1);
    const registrySrc = readFileSync(new URL("../../../src/registry.ts", import.meta.url), "utf8");
    check("the mirrored ultracode value is the daemon's", /ULTRACODE_CHOICE = "ultracode"/.test(registrySrc), true);
    check("and the name the chip reserves width for", /name: "Ultracode"/.test(registrySrc), true);
  }
  check("but the caller being banned is not a fact about a route", meansMachineGone(err(403, "user_disabled")), false);
  check("the daemon saying a path is unresponsive does not", meansMachineGone(err(503, "unresponsive")), false);
  check("nor does an expired token", meansMachineGone(err(401, "token_expired")), false);
  check("nor does an unknown session", meansMachineGone(err(404, "session_not_found")), false);
  check("nor does a transport failure", meansMachineGone(new TypeError("fetch failed")), false);
}

process.stdout.write("\na machine that moved to another relay\n");
{
  const cp = await import("../src/cp.js");
  const { MachineConnection } = await import("../src/machine.js");
  const { ApiError } = await import("../src/http.js");

  const realFetch = globalThis.fetch;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // `probeRoute` refuses the relay arm without an announced key, so every mint fixture carries one.
  const MACHINE_KEY = "A".repeat(43);
  let routedTo = "https://r1.example";
  let holdsTunnel = "https://r1.example";
  let transportDown = false;
  const mints: string[] = [];
  const daemonCalls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === "/v1/tokens") {
      mints.push(routedTo);
      const now = Date.now();
      return json({
        token: `jws-${mints.length}`,
        expiresAt: now + 300_000,
        serverTime: now,
        machine: { relayUrl: routedTo, relayOnline: true, key: MACHINE_KEY },
      });
    }
    daemonCalls.push(url);
    if (transportDown) throw new TypeError("fetch failed");
    if (!url.startsWith(holdsTunnel)) {
      return json({ error: { code: "no_tunnel", message: "no tunnel for this machine" } }, 503);
    }
    return json(url.endsWith("/health") ? { ok: true } : { sessions: [] });
  }) as typeof fetch;

  cp.setSession("rs_relaymove");
  const connection = new MachineConnection(
    {
      id: "m_move",
      name: "laptop",
      relayUrl: "https://r1.example",
      relayOnline: true,
      enrolled: true,
      owned: true,
      scopes: [],
    } as never,
    () => {},
    fetchChannel,
  );

  const settled = await connection.resolveRoute();
  check("it settles on the relay the control plane named", settled?.base, "https://r1.example");
  check("having minted exactly once to learn that", mints.length, 1);

  routedTo = "https://r2.example";
  holdsTunnel = "https://r2.example";

  const refused = await connection.request("/sessions").then(
    () => "resolved",
    (error: unknown) => (ApiError.isApiError(error) ? error.code : String(error)),
  );
  check("the next request is refused by the relay it still believes in", refused, "no_tunnel");

  // `refetchRoute` runs in the background so the failing request still throws its own error.
  await sleep(30);
  report(
    "which re-asks the control plane where the machine is",
    mints.length === 2,
    `mints: ${JSON.stringify(mints)}`,
  );
  check("so the held route moves with it", connection.state().relayUrl, "https://r2.example");

  const moved = await connection.resolveRoute();
  check("and the next resolve lands on the relay that holds the tunnel", moved?.base, "https://r2.example");
  report(
    "with no probe ever aimed at the wrong relay twice",
    daemonCalls.filter((url) => url.startsWith("https://r1.example")).length === 2,
    `r1: ${JSON.stringify(daemonCalls.filter((url) => url.startsWith("https://r1.example")))}`,
  );

  // A transport failure re-probes without re-minting, or flaky LTE would mint a token per dropped request.
  const before = mints.length;
  transportDown = true;
  await connection.request("/sessions").then(
    () => undefined,
    () => undefined,
  );
  check("but a dropped request re-probes without re-asking", mints.length, before);
  check("and still gives up the route memo", connection.state().route, null);

  globalThis.fetch = realFetch;
  cp.clearSession();
}

process.stdout.write("\nwhat a failed call puts on screen\n");
{
  const { ApiError, errorText } = await import("../src/http.js");

  check(
    "an answered failure reads as the service wrote it",
    errorText(new ApiError(409, "machine_exists", "you already have a machine called that")),
    "you already have a machine called that",
  );
  check("and the code is not smuggled into it", errorText(new ApiError(503, "no_tunnel", "no daemon")), "no daemon");

  // `TRANSPORT_TEXT` is not exported, so the literal is copied here and these checks tie it to http.ts.
  const TRANSPORT = "the connection failed, and whether the request arrived is not known";
  check("a dead network says what is known and what is not", errorText(new TypeError("Failed to fetch")), TRANSPORT);
  check("an abort says the same thing, because it means the same thing", errorText(new DOMException("The operation was aborted.", "TimeoutError")), TRANSPORT);
  check("and so does a request this client gave up on", errorText(new TypeError("upload stalled")), TRANSPORT);
  check("in the register of the answers it sits beside", [/^[a-z]/.test(TRANSPORT), /[.!?]$/.test(TRANSPORT)], [true, false]);
  check("and it does not advise a retry it cannot promise", /try again|retry|reload|refresh/i.test(TRANSPORT), false);
  check("a thrown string renders", errorText("boom"), "boom");
  check("so does a thrown object", errorText({ nope: true }), "[object Object]");
  check("and nothing at all still says something", [errorText(null), errorText(undefined)], ["null", "undefined"]);
}

process.stdout.write("\nreading a body without a Response\n");
{
  const { ApiError, parseBody } = await import("../src/http.js");
  const caught = (fn: () => unknown): InstanceType<typeof ApiError> | null => {
    try {
      fn();
      return null;
    } catch (error) {
      return ApiError.isApiError(error) ? error : null;
    }
  };

  check("a 2xx parses to its body", parseBody(200, "OK", '{"a":1}'), { a: 1 });
  check("an empty 2xx is null rather than a throw", parseBody(202, "Accepted", ""), null);

  const repeat = caught(() => parseBody(409, "", '{"recorded":true,"repeat":true,"outcome":"selected"}'));
  check("a 409 with a success-shaped body still throws", repeat !== null, true);
  check("and keeps the whole body, so the caller can see it landed", repeat?.body, {
    recorded: true,
    repeat: true,
    outcome: "selected",
  });
  check("with no envelope, the code falls back to the status", repeat?.code, "http_409");

  const envelope = caught(() =>
    parseBody(404, "", '{"error":{"code":"session_not_found","message":"no such session","detail":{"id":"x"}}}'),
  );
  check("an envelope maps to code", envelope?.code, "session_not_found");
  check("to message", envelope?.message, "no such session");
  check("and to detail", envelope?.detail, { id: "x" });

  check("a 2xx of HTML parses to null rather than throwing", parseBody(200, "OK", "<html>x</html>"), null);
  const html = caught(() => parseBody(502, "Bad Gateway", "<html>captive portal</html>"));
  check("HTML on a 502 becomes the message", html?.message, "<html>captive portal</html>");
  check("and the status becomes the code", html?.code, "http_502");
  const bare = caught(() => parseBody(500, "Internal Server Error", ""));
  check("an empty error body falls back to the status text", bare?.message, "Internal Server Error");
}

process.stdout.write("\nwhat content type a body gets\n");
{
  const { contentTypeFor } = await import("../src/http.js");

  check("a string is json", contentTypeFor(JSON.stringify({ text: "hi" })), "application/json");
  check("a blob is bytes", contentTypeFor(new Blob([new Uint8Array([1, 2])])), "application/octet-stream");
  check("so is an array buffer", contentTypeFor(new ArrayBuffer(4)), "application/octet-stream");
  check("and a typed array", contentTypeFor(new Uint8Array([1])), "application/octet-stream");
  check("no body means no header", contentTypeFor(undefined), null);
  check("and neither does an explicit null", contentTypeFor(null), null);
}

process.stdout.write("\nhow long an upload is given\n");
{
  const { uploadDeadlines } = await import("../src/machine.js");
  const { MAX_UPLOAD_BYTES } = await import("../src/wire.js");
  const MiB = 1024 * 1024;

  check("a tiny upload gets at least what any request gets", uploadDeadlines(1).hardMs >= 15_000, true);
  check(
    "the largest file this daemon takes is still governed by the formula",
    uploadDeadlines(MAX_UPLOAD_BYTES).hardMs < uploadDeadlines(1024 * MiB).hardMs,
    true,
  );
  check("and the ceiling is what bounds anything past it", uploadDeadlines(1024 * MiB).hardMs, 45 * 60_000);
  check(
    "so 100 MiB gets a budget matched to the floor it assumes",
    uploadDeadlines(MAX_UPLOAD_BYTES).hardMs,
    20_000 + Math.ceil((100 * MiB) / 50),
  );

  let monotone = true;
  let previous = 0;
  for (const bytes of [0, 1, 64 * 1024, MiB, 5 * MiB, 25 * MiB, 100 * MiB]) {
    const { hardMs } = uploadDeadlines(bytes);
    if (hardMs < previous) monotone = false;
    previous = hardMs;
  }
  check("and the cap never shrinks as the file grows", monotone, true);

  check("the stall budget is independent of size", uploadDeadlines(MiB).stallMs, uploadDeadlines(100 * MiB).stallMs);
  check("a nonsense size still gets the floor", uploadDeadlines(-1).hardMs >= 15_000, true);
}

// A client that gives up first turns a slow, healthy answer into a transport failure, and a healthy machine is drawn unreachable.
process.stdout.write("\nhow long a slow route is given\n");
{
  const { SLOW_ROUTE_FLOOR_MS, SLOW_ROUTE_MARGIN_MS, slowRoute, slowRouteTimeout } = await import("../src/machine.js");

  // Read off src/, never restated here, so raising a daemon budget fails this section rather than a request.
  const sources = new Map<string, string>();
  const daemonMs = (file: string, name: string): number => {
    const src = sources.get(file) ?? readFileSync(new URL(`../../../src/${file}`, import.meta.url), "utf8");
    sources.set(file, src);
    const expr = new RegExp(`^(?:export )?const ${name} = ([^;]+);`, "m").exec(src)?.[1];
    if (expr === undefined) return Number.NaN;
    return expr
      .split("*")
      .map((factor) => factor.trim())
      .reduce((product, factor) => product * (/^[\d_]+$/.test(factor) ? Number(factor.replaceAll("_", "")) : daemonMs(file, factor)), 1);
  };

  type Budget = readonly [file: string, name: string];
  // A CLI's --version, then its status command.
  const availability: Budget[] = [
    ["runtime/local.ts", "LOGIN_PROBE_TIMEOUT_MS"],
    ["runtime/local.ts", "LOGIN_PROBE_TIMEOUT_MS"],
  ];
  // Session.start on an ask: nothing races it end to end the way START_TIMEOUT_MS does a session's.
  const askedStart: Budget[] = [
    ["acp/client.ts", "HANDSHAKE_TIMEOUT_MS"],
    ["acp/client.ts", "AUTHENTICATE_TIMEOUT_MS"],
    ["session.ts", "LAUNCH_SESSION_TIMEOUT_MS"],
  ];
  // A queued ask may wait out SLOT_WAIT_MS before its spawn; ASK_TIMEOUT_MS bounds a prompt, which a capability read sends none of.
  const capabilities: Budget[] = [
    ...availability,
    ["agentask.ts", "SLOT_WAIT_MS"],
    ...askedStart,
    ["acp/client.ts", "LIST_PROVIDERS_TIMEOUT_MS"],
  ];
  const pluginRestart: Budget[] = [
    ["plugins/runtime.ts", "PLUGIN_STOP_DEADLINE_MS"],
    ["plugins/runtime.ts", "PLUGIN_START_TIMEOUT_MS"],
    ["plugins/runtime.ts", "PLUGIN_STOP_DEADLINE_MS"],
  ];
  const agentStart: Budget = ["registry.ts", "START_TIMEOUT_MS"];
  const chains: [verb: string, path: string, budgets: Budget[]][] = [
    ["POST", "/sessions", [...availability, ["git.ts", "GIT_TIMEOUT_MUTATE_MS"], agentStart]],
    ["POST", "/sessions/s_1/resume", [agentStart]],
    // A control that restarts the agent, then restores the rest of its config.
    ["POST", "/sessions/s_1/config", [agentStart, ["session.ts", "SET_CONFIG_TIMEOUT_MS"]]],
    // Waits out a restart already running, wakes an interrupted session, then may open a fresh conversation for a /clear.
    ["POST", "/sessions/s_1/prompt", [agentStart, ["session.ts", "SET_CONFIG_TIMEOUT_MS"], agentStart, ["session.ts", "NEW_SESSION_TIMEOUT_MS"]]],
    ["GET", "/agents", availability],
    ["GET", "/agents/capabilities", capabilities],
    ["GET", "/agent-auth", availability],
    // CAPABILITY_READ_BUDGET_MS is tested only before the read starts, and a write joins a sweep's queued read.
    ["POST", "/custom-agents", capabilities],
    ["PATCH", "/custom-agents/ca_1234abcd", capabilities],
    ["POST", "/plugins/source", [["plugins/source.ts", "PLUGIN_SOURCE_TIMEOUT_MS"], ...pluginRestart]],
    ["POST", "/plugins/p_1/state", pluginRestart],
  ];
  const total = (budgets: Budget[]): number => budgets.reduce((sum, [file, name]) => sum + daemonMs(file, name), 0);

  check(
    "every budget a chain names is still in src/",
    [
      ...new Set(
        chains
          .flatMap(([, , budgets]) => budgets)
          .filter(([file, name]) => !(daemonMs(file, name) > 0))
          .map(([file, name]) => `${file} ${name}`),
      ),
    ],
    [],
  );
  check("and every chain is about a slow route", chains.filter(([verb, path]) => !slowRoute(verb, path)).map(([verb, path]) => `${verb} ${path}`), []);

  // Each branch of the client's table is evaluated alone, so a slow route added without a chain here fails.
  const machine = stripComments(readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8"));
  const at = machine.indexOf("function daemonChainMs(");
  const table = at < 0 ? "" : machine.slice(at, machine.indexOf("\n}\n", at));
  const branches = [...table.matchAll(/if \(([\s\S]*?)\) return [\d_]+;/g)].map((one) => one[1] ?? "");
  const matches = branches.map((branch) => new Function("verb", "path", `return ${branch};`) as (verb: string, path: string) => boolean);
  report("the client's branches were found", branches.length > 1, `${String(branches.length)} branches`);
  check(
    "and every one of them has a chain",
    branches.filter((_, index) => !chains.some(([verb, path]) => matches[index]?.(verb, path) === true)),
    [],
  );

  const outwaits = chains.map(([verb, path, budgets]) => {
    const timeout = slowRouteTimeout(verb, path) ?? 0;
    return { route: `${verb} ${path}`, timeout, chain: total(budgets) };
  });
  const short = outwaits.filter((one) => !(one.timeout >= one.chain + SLOW_ROUTE_MARGIN_MS));
  report(
    "⭐ each slow route outwaits its own daemon chain by the margin",
    short.length === 0,
    (short.length === 0 ? outwaits : short).map((one) => `${one.route} ${String(one.timeout)} over ${String(one.chain)}`).join("; "),
  );
  check("and none gets less than the floor", outwaits.filter((one) => one.timeout < SLOW_ROUTE_FLOOR_MS).map((one) => one.route), []);
  check("while a route with no chain keeps the ordinary deadline", slowRouteTimeout("GET", "/sessions"), null);

  // Not a check: the daemon's relay end cuts an idle request and answers 502, below these chains, and that is src/e2ee.ts's to change.
  const idleCut = daemonMs("e2ee.ts", "UPSTREAM_IDLE_TIMEOUT_MS");
  const cut = outwaits.filter((one) => one.chain > idleCut).map((one) => `${one.route} (${String(one.chain)})`);
  if (cut.length > 0) {
    process.stdout.write(`  note  over the relay the daemon answers 502 after ${String(idleCut)}ms idle, before: ${cut.join(", ")}\n`);
  }
}

process.stdout.write("\nthe close-code table\n");
{
  for (const [code, label, shouldForget] of [
    [4401, "an expiry close", false],
    [4003, "a slow-consumer close", false],
    [1011, "an internal-error close", true],
  ] as const) {
    attaches.length = 0;
    const rec = recorder();
    const stream = newStream(rec.sink, 0);
    stream.start();
    const attach = await nextAttach(1);
    hello(attach, 0);
    await sleep(30);

    const before = forgotten;
    attach.close(code, "bye");
    await sleep(80);
    check(`${label} ${shouldForget ? "drops" : "keeps"} the route memo`, forgotten > before, shouldForget);
    stream.stop();
  }

  attaches.length = 0;
  const rec = recorder();
  const stream = newStream(rec.sink, 0);
  stream.start();
  const attach = await nextAttach(1);
  hello(attach, 0);
  await sleep(30);
  attach.close(4404, "no such session");
  await sleep(80);
  check("a 4404 reports the session as gone", rec.vanished, 1);
  stream.stop();
}
