import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, type AgentId, type AgentLaunchConfig } from "../src/acp/agents.js";
import { AgentLoginRuns } from "../src/agentauth.js";
import { resolveCwd } from "../src/browse.js";
import { CORS_ALLOW_METHODS } from "../src/cors.js";
import { MemoryEventStore } from "../src/events.js";
import {
  MAX_TITLE_CHARS,
  SessionRegistry,
  dedupeAliasChoices,
  deriveSessionTitle,
  narrowToSystem,
  normalizeTitle,
  usageWorthAnnouncing,
} from "../src/registry.js";
import { LocalRuntime, loginBlockedReason } from "../src/runtime/local.js";
import type { AgentAvailability } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { tmp } from "./tmp.js";
import { check, report } from "./daemoncheck.env.js";
import { users, now, tokenFor, verifier, credentials, app, get, stubAgentConfig } from "./daemoncheck.fixtures.js";

process.stdout.write("\nnaming a session\n");
{
  check("a title is the first line, not the first 60 characters", deriveSessionTitle("Fix reconnect\n\nstack trace here"), "Fix reconnect");
  check("leading blank lines are skipped", deriveSessionTitle("\n\n  Rework the rail\n"), "Rework the rail");
  check("whitespace collapses", normalizeTitle("a   b\t\tc"), "a b c");
  check("control characters are stripped, not refused", normalizeTitle("a\u0000b\u001fc"), "a b c");
  check("and the paragraph separator counts as one", normalizeTitle("a\u2029b"), "a b");
  // null, never an empty string: the column distinguishes never named from named.
  check("nothing left means null, never an empty string", normalizeTitle("   \t  "), null);
  check("an empty prompt names nothing", deriveSessionTitle("\n\n"), null);
  check("a long title is clipped with an ellipsis", (normalizeTitle("x".repeat(200)) ?? "").length, MAX_TITLE_CHARS);
  {
    const derived = deriveSessionTitle("Rework the reconnect backoff so a dead tunnel does not spin for ever") ?? "";
    check("a derived title breaks on a word", derived.endsWith("…") && !/\s…$/.test(derived), true);
    check("and stays within its own shorter bound", derived.length <= 60, true);
    check("a single long word is still clipped", (deriveSessionTitle("x".repeat(300)) ?? "").length <= 60, true);
  }
}

process.stdout.write("\nan agent's own placeholder choices\n");
{
  // Tested here rather than in webcheck: only the daemon sees every choice's description.
  const model = {
    id: "model",
    name: "Model",
    description: "AI model to use",
    category: "model",
    kind: "select" as const,
    value: "default",
    choices: [
      { value: "default", name: "Default (recommended)", description: "Opus 5 with 1M context · Best for everyday", group: null },
      { value: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday", group: null },
      { value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", group: null },
    ],
  };
  const deduped = dedupeAliasChoices(model);
  check("the placeholder leaves the menu", deduped.choices.map((c) => c.value), ["opus[1m]", "sonnet"]);
  check("and the session is shown on the real one", deduped.value, "opus[1m]");

  const effort = {
    ...model,
    id: "effort",
    category: "thought_level",
    choices: [
      { value: "default", name: "Default", description: null, group: null },
      { value: "high", name: "High", description: null, group: null },
    ],
  };
  check("a control with no descriptions keeps every choice", dedupeAliasChoices(effort).choices.length, 2);
  check("and its selection is untouched", dedupeAliasChoices(effort).value, "default");

  const blank = {
    ...model,
    choices: [
      { value: "a", name: "A", description: "", group: null },
      { value: "b", name: "B", description: "   ", group: null },
    ],
  };
  check("blank descriptions do not make two choices aliases", dedupeAliasChoices(blank).choices.length, 2);

  // The second alias shape: the placeholder's description is the concrete row's name rather than its blurb.
  const named = {
    ...model,
    choices: [
      { value: "default", name: "Default (recommended)", description: "Opus (1M context)", group: null },
      { value: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday", group: null },
      { value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", group: null },
    ],
  };
  const dedupedNamed = dedupeAliasChoices(named);
  check("a placeholder whose description is another row's name leaves the menu", dedupedNamed.choices.map((c) => c.value), ["opus[1m]", "sonnet"]);
  check("and the session is shown on that row", dedupedNamed.value, "opus[1m]");

  const unmatched = {
    ...model,
    choices: [
      { value: "default", name: "Default (recommended)", description: "claude-opus-5[1m]", group: null },
      { value: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday", group: null },
    ],
  };
  check("a placeholder whose description matches neither a blurb nor a name is kept", dedupeAliasChoices(unmatched).choices.length, 2);
  check("and stays the selection", dedupeAliasChoices(unmatched).value, "default");

  const concrete = {
    ...model,
    value: "sonnet",
    choices: [
      { value: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday", group: null },
      { value: "sonnet", name: "Sonnet", description: "Opus (1M context)", group: null },
    ],
  };
  check("a concrete row is never collapsed by the name arm", dedupeAliasChoices(concrete).choices.length, 2);
  const twoPlaceholders = {
    ...model,
    choices: [
      { value: "default", name: "Default", description: "Default", group: null },
      { value: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday", group: null },
    ],
  };
  check("a placeholder's own name is not a target", dedupeAliasChoices(twoPlaceholders).choices.length, 2);

  // opencode publishes one model control for two systems; a pinned session is offered only its own (Q2.216).
  const mixed = {
    id: "model",
    name: "Model",
    description: null,
    category: "model",
    kind: "select" as const,
    value: "openrouter/aion-labs/aion-3.0-mini",
    choices: [
      { value: "openrouter/aion-labs/aion-3.0-mini", name: "OpenRouter/Aion-3.0-Mini", description: null, group: null },
      { value: "openrouter/z-ai/glm-5.3-flash", name: "OpenRouter/GLM 5.3 Flash", description: null, group: null },
      { value: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle", description: null, group: null },
    ],
  };
  check(
    "an OpenRouter session is offered OpenRouter models and nothing else",
    narrowToSystem(mixed, "openrouter/").choices.map((choice) => choice.value),
    ["openrouter/aion-labs/aion-3.0-mini", "openrouter/z-ai/glm-5.3-flash"],
  );
  check(
    "and a Zen session is offered the other six",
    narrowToSystem({ ...mixed, value: "opencode/big-pickle" }, "opencode/").choices.map((c) => c.value),
    ["opencode/big-pickle"],
  );
  // A session already on another system's model keeps that row, or pinNativeModel refuses its next resume.
  check(
    "a session already switched to the other system keeps a way back to itself",
    narrowToSystem({ ...mixed, value: "opencode/big-pickle" }, "openrouter/").choices.map((c) => c.value),
    ["openrouter/aion-labs/aion-3.0-mini", "openrouter/z-ai/glm-5.3-flash", "opencode/big-pickle"],
  );
  check(
    "a bare session is offered everything the agent published",
    narrowToSystem(mixed, null) === mixed,
    true,
  );
  check(
    "and no other control is touched, whatever its values look like",
    narrowToSystem({ ...mixed, category: "thought_level" }, "openrouter/").choices.length,
    3,
  );
  check(
    "a list already inside one system is returned as it came",
    narrowToSystem({ ...mixed, choices: mixed.choices.slice(0, 2) }, "openrouter/").choices.length,
    2,
  );
}

process.stdout.write("\ncontext usage is fanned out on what a client can see\n");
{
  // usage_update fires on every streamed token, so this predicate is all that stops a frame per token per client.
  const at = (used: number, size = 200_000) => ({ used, size, cost: null });

  check("a token that does not move the percent is not announced", usageWorthAnnouncing(at(1000), at(1001)), false);
  check("crossing a whole percent is", usageWorthAnnouncing(at(1000), at(3000)), true);
  check("and it is the rounded value that decides", usageWorthAnnouncing(at(2000), at(2999)), false);
  check("a resized window is always announced", usageWorthAnnouncing(at(1000), at(1000, 100_000)), true);
  check("and so is a cost change", usageWorthAnnouncing({ ...at(1000), cost: null }, { ...at(1000), cost: { amount: 0.4, currency: "USD" } }), true);
  check("entering cannot-tell is announced", usageWorthAnnouncing(at(1000), at(1000, 0)), true);
  check("leaving it is too", usageWorthAnnouncing(at(1000, 0), at(1000)), true);
  check("and inside it any movement counts, since nothing can be rounded", usageWorthAnnouncing(at(1000, 0), at(1001, 0)), true);
  check("a repeat of the same reading is not announced", usageWorthAnnouncing(at(1000), at(1000)), false);
}

process.stdout.write("\nevery verb this app registers is one a browser may send\n");
{
  // Containment one way only: a verb a route uses and CORS omits is a route no browser can reach.
  const registered = [...new Set(app.routes.map((route) => route.method.toUpperCase()))]
    .filter((method) => method !== "ALL") // Hono's middleware wildcard, not a verb a client sends
    .sort();
  const advertised = new Set<string>(CORS_ALLOW_METHODS);
  check("no route uses a verb the CORS list withholds", registered.filter((m) => !advertised.has(m)), []);
  check("and OPTIONS is advertised, or nothing preflights at all", advertised.has("OPTIONS"), true);
}

process.stdout.write("\nbrowsing and health\n");
const roots = await get("/fs/roots", "u_alice");
check("the picker starts at the configured roots", roots.body.roots, [users]);
check("and every recent directory is offered", roots.body.recent.length > 0, true);

const outsideRoots = realpathSync(tmp("elsewhere-"));
const listOutside = await get(`/fs/list?path=${encodeURIComponent(outsideRoots)}`, "u_alice");
check("listing outside the roots is refused", listOutside.status, 403);
check("with a code naming what to change", listOutside.body.error.code, "outside_roots");

// The roots narrow the listing only; a session may still start outside them.
check("but resolving it as a session cwd is not", await resolveCwd(outsideRoots), outsideRoots);

// A stub runtime with nothing installed: no agent is spawned, and agent_unavailable proves the cwd was accepted.
class UninstalledRuntime extends LocalRuntime {
  override async availability(): Promise<AgentAvailability[]> {
    return AGENT_IDS.map((id) => ({
      id,
      displayName: id,
      available: false,
      installable: true,
      loggedIn: null,
      hint: null,
      lastStartRefusal: null,
    }));
  }
}
const uninstalled = new SessionRegistry(new MemoryEventStore(), null, undefined, new UninstalledRuntime());
const { app: noAgents } = createApp({
  registry: uninstalled,
  verifier,
  instanceId: "i_daemoncheck_noagents",
  startedAt: now,
  credentials,
  roots: [users],
});
const createOutside = await noAgents.fetch(
  new Request("http://d/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
    body: JSON.stringify({ agent: "kimi", cwd: outsideRoots }),
  }),
);
const outsideBody = (await createOutside.json()) as { error?: { code?: string } };
check("and the route does not refuse it for being outside them", outsideBody.error?.code === "outside_roots", false);
check("nor with the status that refusal carries", createOutside.status === 403, false);
check("it got past the path and refused for the agent instead", [createOutside.status, outsideBody.error?.code], [503, "agent_unavailable"]);

process.stdout.write("\ncreating a folder\n");
{
  const mkdir = async (sub: string, body: unknown) =>
    app.fetch(
      new Request("http://d/fs/mkdir", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor(sub)}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const made = await mkdir("u_alice", { parent: join(users, "u_alice"), name: "fresh" });
  check("a folder is created where it was asked for", made.status, 201);
  check("and it is where they asked", (await made.json() as any).path, join(users, "u_alice", "fresh"));

  const climb = await mkdir("u_alice", { parent: join(users, "u_alice"), name: "../u_bob/sneaky" });
  check("a separator in the name is refused outright", climb.status, 400);
  check("with a code that says why", (await climb.json() as any).error.code, "invalid_path");
  check("and nothing was created", existsSync(join(users, "u_bob", "sneaky")), false);

  const dots = await mkdir("u_alice", { parent: join(users, "u_alice"), name: ".." });
  check("and `..` alone is not a folder name", dots.status, 400);

  // The parent is unconfined like a session cwd; the single-segment name is what keeps traversal inexpressible.
  const outside = await mkdir("u_alice", { parent: join(users, "u_bob"), name: "made-here" });
  check("a parent outside the browse roots is accepted", outside.status, 201);
  check("and the folder is there", existsSync(join(users, "u_bob", "made-here")), true);

  const missing = await mkdir("u_alice", { parent: join(users, "u_alice", "nowhere"), name: "x" });
  check("but a parent that does not exist is not", missing.status, 400);
  check("with a code that says which half was wrong", (await missing.json() as any).error.code, "not_found");
}

process.stdout.write("\nsigning out, as a state of the machine\n");
{
  const events = readFileSync(new URL("../src/events.ts", import.meta.url), "utf8");
  const reg = readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../src/runtime/local.ts", import.meta.url), "utf8");

  check("there is a reason for it", /\| "agent_signed_out"/.test(events), true);
  // A person signed out, so the reason must not be a daemon exit, which the boot pass resumes.
  check(
    "and it is not one of the daemon's own",
    /DAEMON_EXIT_REASONS = \["daemon_restarted", "daemon_shutdown", "config_changed"\]/.test(events),
    true,
  );

  check("signing out ends the live conversations", /async signOutSessions\(agent: AgentId\): Promise<number>/.test(reg), true);
  check("with that reason", /session\.stop\("agent_signed_out"\)/.test(reg), true);
  // Not filtered by takesCredentialChange: a turn running on a revoked credential is what a sign-out means to stop.
  check("including one mid-turn, unlike a credential being added", /takesCredentialChange/.test(
    /async signOutSessions[\s\S]*?\n  \}/.exec(reg)?.[0] ?? "",
  ), false);
  check("and the route waits for it before answering", /await registry\.signOutSessions\(agent\)/.test(routes), true);
  // A parked session is terminal with no process, so the sweep must select it explicitly.
  const sweep = /async signOutSessions[\s\S]*?\n  \}/.exec(reg)?.[0] ?? "";
  check(
    "and the ones it had parked, which have no process to stop",
    [/exit\?\.reason === "parked"/.test(sweep), /RELABELS_PARKED/.test(reg)],
    [true, true],
  );

  check("the prompt path asks no CLI whether anybody is signed in", /sessionRuntime\.signedOut\(/.test(routes), false);
  // Comments stripped: the docblocks quote the calls these assertions forbid.
  const code = reg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the agent's own failure is what it reacts to", /isAuthFailure\(event\)/.test(reg), true);
  // An auth failure on the pump replaces the process rather than ending the conversation: the process was what went stale (Q7.99).
  check("and replaces the agent instead of ending the conversation", /onAgentUnusable\(\): void \{[\s\S]*?restartAgent\(\)/.test(reg), true);
  check("never stopping it on the pump", /onAgentUnusable\(\): void \{[\s\S]*?\n  \}/.exec(reg)?.[0].includes('stop("agent_signed_out")'), false);
  // failed means the prompt was rejected, so the agent never took the message; errors inside a turn never reach it.
  check("a prompt the agent never took also replaces it", /if \(failed\) this\.onAgentUnusable\(\);/.test(code), true);
  // A condition, not a distance: a character window went red when an unrelated line between the two was deleted.
  const byMessage = /if \([^;]*(describeError|\.message\b|isAuthRequiredMessage)[^;]*this\.onAgentUnusable/;
  check("and the message is never what decides", byMessage.test(code), false);
  check(
    "which is a test that would see one",
    byMessage.test("if (isAuthRequiredMessage(describeError(error))) this.onAgentUnusable();"),
    true,
  );
  check("one replacement per message somebody sends", /this\.authRestartArmed = true;/.test(reg), true);
  check("spent when it fires", /onAgentUnusable\(\): void \{[\s\S]*?this\.authRestartArmed = false;/.test(reg), true);
  check("only an explicit sign-out still writes the reason", (code.match(/stop\("agent_signed_out"\)/g) ?? []).length, 1);
  check("and it is the sign-out route's own sweep", /signOutSessions[\s\S]*?stop\("agent_signed_out"\)/.test(code), true);

  // The kind, never the message: an agent's prose moves with its version.
  const { isAuthFailure } = await import("../src/events.js");
  check("an auth failure is recognised", isAuthFailure({ type: "error", data: { code: -32603, data: { errorKind: "authentication_failed" } } }), true);
  check("another agent error is not", isAuthFailure({ type: "error", data: { code: -32603, data: { errorKind: "something_else" } } }), false);
  check("nor is the message alone", isAuthFailure({ type: "error", data: { code: -32603, data: {} } }), false);
  check("a non-error event never is", isAuthFailure({ type: "text", data: { data: { errorKind: "authentication_failed" } } }), false);
  for (const shape of [undefined, null, "text", 7, {}, { data: null }, { data: "x" }] as unknown[]) {
    check(`and a payload of ${JSON.stringify(shape) ?? "undefined"} is refused quietly`, isAuthFailure({ type: "error", data: shape }), false);
  }

  // Deleted rather than left unused, for the reason paths.ts gives about atOrUnderReal.
  check("the probe is gone rather than left for a future caller", /async signedOut\(/.test(runtime), false);
  check("with the reason it is gone written where it was", /`signedOut\(agent\)` used to live here/.test(runtime), true);

  // A start refusal is kept apart from loggedIn: admit reads loggedIn and guards the only spawn that could clear it.
  {
    const { startRefusalLive, START_REFUSAL_TTL_MS, MAX_START_REFUSAL_CHARS } = await import(
      "../src/runtime/local.js"
    );

    const rowFor = async (rt: LocalRuntime, agent: string) =>
      (await rt.availability()).find((one) => one.id === agent) ?? null;

    const rt = new LocalRuntime({ exec: async () => null });
    check("nothing is remembered until something is measured", (await rowFor(rt, "opencode"))?.lastStartRefusal, null);

    rt.noteStartRefusal("opencode", "opencode rejected session/new: authentication required.", false);
    const noted = await rowFor(rt, "opencode");
    check("a refused start is remembered against the harness", noted?.lastStartRefusal?.message, "opencode rejected session/new: authentication required.");
    check("and it says whether the refusal had been routed", noted?.lastStartRefusal?.routed, false);
    check("and the credential axis is untouched by it", noted?.loggedIn, null);

    rt.noteStartRefusal("claude", "x".repeat(MAX_START_REFUSAL_CHARS + 50), true);
    const clipped = await rowFor(rt, "claude");
    check("what is stored is bounded", clipped?.lastStartRefusal?.message.length, MAX_START_REFUSAL_CHARS);
    check("and a routed refusal says so", clipped?.lastStartRefusal?.routed, true);

    rt.forgetStartRefusal("opencode");
    check("one can be forgotten", (await rowFor(rt, "opencode"))?.lastStartRefusal, null);
    check("without taking the others with it", (await rowFor(rt, "claude"))?.lastStartRefusal !== null, true);
    rt.forgetStartRefusal();
    check("and all of them at once, which is what a plugin change does", (await rowFor(rt, "claude"))?.lastStartRefusal, null);

    // Driven through the reader the listing uses; the clock is faked around one call rather than injected.
    rt.noteStartRefusal("opencode", "opencode rejected session/new: authentication required.", false);
    const realNow = Date.now;
    let aged: unknown;
    try {
      Date.now = () => realNow.call(Date) + START_REFUSAL_TTL_MS;
      aged = (await rowFor(rt, "opencode"))?.lastStartRefusal;
    } finally {
      Date.now = realNow;
    }
    check("the reader the listing uses ages one out", aged, null);
    check("and dropped it rather than hiding it", (await rowFor(rt, "opencode"))?.lastStartRefusal, null);

    const held = { at: 1_000_000, routed: false, message: "no" };
    check("a refusal is believed inside its budget", [
      startRefusalLive(held, held.at),
      startRefusalLive(held, held.at + START_REFUSAL_TTL_MS - 1),
      startRefusalLive(held, held.at + START_REFUSAL_TTL_MS),
      startRefusalLive(held, held.at + START_REFUSAL_TTL_MS * 4),
    ], [true, true, false, false]);

    // Only a typed auth_required writes it: the pump's auth signal can come from a stale process (Q7.99).
    const session = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");
    check("only a typed auth_required writes it", (session.match(/noteStartRefusal\(/g) ?? []).length, 2);
    check("on the start path", /session\/new: authentication required[\s\S]{0,900}noteStartRefusal\(/.test(session), true);
    check("and on the resume path", /session\/resume: authentication required[\s\S]{0,600}noteStartRefusal\(/.test(session), true);
    check("and the pump writes nothing", /noteStartRefusal/.test(code), false);
    // Anchored after a successful open: two calls in the catch arms would satisfy a count and mean the opposite.
    check("while a session that opens forgets it", (session.match(/forgetStartRefusal\(options\.agent\)/g) ?? []).length, 2);
    check("on the start path, after the agent answered", /const session = Session\.adopt\(options, client, response\.sessionId/.test(session) && /forgetStartRefusal\(options\.agent\);[\s\S]{0,600}Session\.adopt\(options, client, response\.sessionId/.test(session), true);
    check("and on the resume path, after it answered there", /forgetStartRefusal\(options\.agent\);[\s\S]{0,400}Session\.adopt\(options, client, options\.agentSessionId/.test(session), true);

    // Per handler, not a file-wide count: moving a call between handlers leaves the count unchanged.
    const bodyOfRoute = (verb: string, path: string): string =>
      new RegExp(`app\\.${verb}\\("${path.replace(/[/:]/g, (one) => `\\${one}`)}"[\\s\\S]*?\\n  \\}\\);`).exec(routes)?.[0] ?? "";
    const put = bodyOfRoute("put", "/agent-auth/:agent");
    const del = bodyOfRoute("delete", "/agent-auth/:agent");
    const out = bodyOfRoute("post", "/agent-auth/:agent/logout");
    const again = bodyOfRoute("post", "/agent-auth/:agent/recheck");
    const chunk = bodyOfRoute("get", "/agent-auth/login/:loginId");
    check("all five agent-auth handlers were found", [put, del, out, again, chunk].map((one) => one.length > 0), [true, true, true, true, true]);
    check("a saved credential clears the refusal", /forgetStartRefusal\(/.test(put), true);
    check("and so does a sign-in that ran to the end", /forgetStartRefusal\(chunk\.agent\)/.test(chunk), true);
    check("and the re-check route, which is what it is for", /forgetStartRefusal\(agent\)/.test(again), true);
    // A credential going away is no evidence that a harness which would not start now would.
    check("while deleting a key does not", /forgetStartRefusal/.test(del), false);
    check("and neither does signing out", /forgetStartRefusal/.test(out), false);
    check("nor abandoning a login", /forgetStartRefusal/.test(bodyOfRoute("delete", "/agent-auth/login/:loginId")), false);
    // The count stays as a backstop, so a fourth site cannot appear unremarked.
    check("and those are the only three", (routes.match(/forgetStartRefusal\(/g) ?? []).length, 3);
    check("which refuses nothing, unlike its neighbours", /logout_unsupported/.test(again), false);
    // The re-check row is built by agentRowExtras like GET /agents, and the client replaces its held row with it.
    check("and it answers the row through the one place those fields are built", /\.\.\.extras\(found\)/.test(again), true);
    check("rather than spreading them by hand", /loginSupportOf\(found\.id\)/.test(again), false);

    // The refusal must fire before a workspace exists, or every repeat press still costs a worktree and a branch.
    const workspaceAt = code.indexOf("await createWorkspace(");
    // indexOf answers -1 for a renamed call, which would make the slice below vacuous.
    check("the workspace call this ordering is about is still called that", workspaceAt > 0, true);
    const beforeWorkspace = code.slice(0, workspaceAt);
    check(
      "a remembered refusal is refused before a workspace exists",
      // The throw, not merely the read.
      /lastStartRefusal[\s\S]{0,600}throw new Error\(refusal\.message\)/.test(beforeWorkspace),
      true,
    );
    // A refusal measured bare says nothing about a routed start on somebody else's key.
    check("and a bare refusal does not condemn a routed preset", /refusal\.routed \|\| options\.customAgent == null/.test(code), true);
    // A native pairing runs on the harness's own credential, so a bare refusal fences it too.
    check("and a native pairing is fenced by the same bare refusal", /nativeHarness === options\.agent[\s\S]{0,400}refusal\.routed \|\| options\.customAgent == null \|\| nativeHere/.test(code), true);
    // admit may never read this field, or the capability sweep that could clear it would be refused by it.
    const ask = readFileSync(new URL("../src/agentask.ts", import.meta.url), "utf8");
    check("and the one thing that could clear it is never gated on it", /lastStartRefusal/.test(ask), false);

    // Driven over HTTP, where a field can be dropped between the runtime and the response.
    const own = new SessionRegistry(new MemoryEventStore(), null, undefined, new LocalRuntime());
    const app = createApp({
      registry: own,
      verifier,
      instanceId: "i_refusal",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;
    const call = async (path: string, method = "GET"): Promise<Record<string, unknown>> => {
      const response = await app.fetch(
        new Request(`http://d${path}`, { method, headers: { authorization: `Bearer ${tokenFor("u_a")}` } }),
      );
      return JSON.parse(await response.text()) as Record<string, unknown>;
    };
    const refusalOn = async (agent: string): Promise<unknown> =>
      ((await call("/agents"))["agents"] as { id: string; lastStartRefusal: unknown }[]).find(
        (one) => one.id === agent,
      )?.lastStartRefusal;

    check("a fresh listing carries no refusal", await refusalOn("opencode"), null);
    own.sessionRuntime.noteStartRefusal("opencode", "opencode rejected session/new: authentication required.", false);
    check("one that has been measured rides GET /agents", (await refusalOn("opencode")) !== null, true);
    const rechecked = await call("/agent-auth/opencode/recheck", "POST");
    check("the re-check answers the row its own lookup saw", [
      rechecked["rechecked"],
      (rechecked["info"] as { id?: string } | undefined)?.id,
      (rechecked["info"] as { lastStartRefusal?: unknown } | undefined)?.lastStartRefusal,
    ], [true, "opencode", null]);
    check("and the listing agrees on the next read", await refusalOn("opencode"), null);
    // Compared as key sets: hint and loggedIn are live answers, while the shape may not differ.
    const listedRow = ((await call("/agents"))["agents"] as { id: string }[]).find(
      (one) => one.id === "opencode",
    );
    const rowAgain = (await call("/agent-auth/opencode/recheck", "POST"))["info"];
    check(
      "and the row it answers is the shape the listing answers",
      Object.keys(rowAgain as object).sort(),
      Object.keys(listedRow as object).sort(),
    );
    const refused = await app.fetch(
      new Request("http://d/agent-auth/opencode/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_a")}` },
      }),
    );
    check("where its neighbour refuses the same harness", refused.status, 503);
    check("and an agent this machine does not have is still a 400", (await call("/agent-auth/nobody/recheck", "POST"))["error"], {
      code: "invalid_agent",
      message: "unknown agent",
      detail: null,
    });

    // A scripted agent refuses session/new with ACP's typed auth_required, which is what writes the record.
    {
      const acp = await import("@agentclientprotocol/sdk");
      const { Session } = await import("../src/session.js");
      const { PassThrough } = await import("node:stream");
      const toAgent = new PassThrough();
      const toClient = new PassThrough();
      let buffer = "";
      toAgent.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim().length === 0) continue;
          const message = JSON.parse(line) as Record<string, any>;
          const id = message["id"];
          if (message["method"] === acp.methods.agent.initialize) {
            toClient.write(
              `${JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] } })}\n`,
            );
          } else if (message["method"] === acp.methods.agent.session.new) {
            // -32000 is ACP's `auth_required`, the code `isAuthRequired` reads.
            toClient.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "not signed in" } })}\n`);
          }
        }
      });
      class RefusingRuntime extends LocalRuntime {
        override describe(agent: AgentId): AgentLaunchConfig {
          return stubAgentConfig(agent);
        }
        override async launch(): Promise<any> {
          return {
            stdin: toAgent,
            stdout: toClient,
            stderr: new PassThrough(),
            handle: null,
            onceStartError: () => () => {},
            onceExit: () => () => {},
            hasExited: false,
            waitForExit: async () => true,
            endStdin: () => toAgent.end(),
            kill: async () => {},
          };
        }
      }
      const refusing = new RefusingRuntime();
      // Read first: kimi's credential file may or may not exist on the machine running this.
      const before = (await refusing.availability()).find((one) => one.id === "kimi")?.loggedIn ?? null;
      let said = "";
      try {
        await Session.start({ agent: "kimi", cwd: process.cwd(), runtime: refusing });
      } catch (error) {
        said = error instanceof Error ? error.message : String(error);
      }
      check("a real refusal reaches the caller as the agent's own sentence", /authentication required/i.test(said), true);
      // The record is not under forgetAvailability's clear: losing a key is no evidence a harness would now start.
      refusing.forgetAvailability();
      const row = (await refusing.availability()).find((one) => one.id === "kimi") ?? null;
      check("and is what wrote the record, which a re-probe does not clear", row?.lastStartRefusal?.message, said);
      check("under the configuration it was measured with", row?.lastStartRefusal?.routed, false);
      check("while the credential axis did not move at all", row?.loggedIn, before);
    }
  }
}

// Secrets are injected at spawn, so a saved credential reaches only a relaunched agent; mid-turn and blocked sessions are left alone.

process.stdout.write("\na credential saved while an agent is already running\n");
{
  const src = readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");

  const guard = /get takesCredentialChange\(\): boolean \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
  report("a relaunch is refused for a session that has ended", /this\.terminal \|\| this\.stopRequested/.test(guard), "terminal");
  report("and for one with a turn in flight", /this\.turn !== null/.test(guard), "mid-turn");
  report("and for one with somebody parked on a question", /this\.awaitingCount > 0/.test(guard), "blocked");
  report(
    "and while another process boundary is already open",
    /this\.clearing/.test(guard) && /this\.restarting/.test(guard),
    "clearing/restarting",
  );

  // The negated check below is vacuous against an empty match, hence the found-at-all guard.
  const fan = /reloadCredentials\([^)]*\): number \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
  check("the fan-out was found at all, so the checks below mean something", fan.length > 0, true);
  check("the fan-out counts what it filtered", /session\.takesCredentialChange/.test(fan), true);
  check(
    "and returns that, not a number it hoped to correct later",
    /return restarting\.length \+ returning\.length;/.test(fan),
    true,
  );
  // Detached from the caller but serialised inside: parallel restarts would be a herd of SIGTERMs on one event loop.
  check("without awaiting the restarts", /void \(async \(\) => \{/.test(fan), true);
  check(
    "but one at a time inside that, not a herd of SIGTERMs at once",
    /await session\.applyCredentialChange\(\)/.test(fan) && !/void session\.applyCredentialChange\(\)/.test(fan),
    true,
  );
  // Keyed on agent_signed_out, so a session somebody stopped by hand stays stopped.
  check("and signing in brings back what the sign-out ended", /exit\?\.reason === "agent_signed_out"/.test(fan), true);
  check("keyed on the reason rather than on being terminal at all", /session\.terminal && session\.exit\?\.reason/.test(fan), true);

  check("the restart sequence has one definition", (src.match(/private async restartAgent\(/g) ?? []).length, 1);
  check("and ultracode goes through it", /await this\.restartAgent\(\);[\s\S]{0,80}\}/.test(src), true);
  check("and so does a credential change", /takesCredentialChange[\s\S]{0,400}await this\.restartAgent\(\)/.test(src), true);

  const routes = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  check("saving a credential relaunches and says how many", /saved: true, agent, envName, restarting/.test(routes), true);
  // removed reports what the lookup saw: a harness a disabled plugin added must still be able to clear its key.
  check("and so does removing one", /removed: had, agent: named, envName, restarting/.test(routes), true);

  // Removing a credential must not revive agent_signed_out sessions: it is a sign-out's second half, never its reversal.
  check("the resume half is gated on which way the change went", /revive\s*\?/.test(fan), true);
  check("and the default is the one that revives, so a save needs no argument", /revive = true/.test(fan), true);

  // Anchored per handler: the two calls differ only in an argument, so a file-wide grep passes with them swapped.
  const put = /app\.put\("\/agent-auth\/:agent"[\s\S]*?\n  \}\);/.exec(routes)?.[0] ?? "";
  const del = /app\.delete\("\/agent-auth\/:agent"[\s\S]*?\n  \}\);/.exec(routes)?.[0] ?? "";
  check("both agent-auth handlers were found, so the two below mean something", [put.length > 0, del.length > 0], [true, true]);
  check("removing a credential does not revive what a sign-out ended", /reloadCredentials\(named, false\)/.test(del), true);
  check("and saving one still does", /reloadCredentials\(agent\)/.test(put), true);
}

// loginBlockedReason is pure, so every platform is asserted from whichever host runs this.

process.stdout.write("\na login that cannot be offered\n");
{
  // The fifth argument says the agent has a sign-in at all.
  const ok = (p: NodeJS.Platform, interactive: boolean) => loginBlockedReason(p, interactive, true, true, true);

  check("claude on macOS cannot be offered a wizard", ok("darwin", true), "interactive_pty");
  check("nor on the other BSDs", [ok("freebsd", true), ok("openbsd", true), ok("netbsd", true)], [
    "interactive_pty",
    "interactive_pty",
    "interactive_pty",
  ]);
  // Device-code flows are fine on macOS because loginStdio hands them /dev/null.
  check("a device-code flow on macOS is fine", ok("darwin", false), null);
  check("and everything is fine on Linux, including the interactive one", [ok("linux", true), ok("linux", false)], [
    null,
    null,
  ]);

  check("no script outranks the platform", loginBlockedReason("darwin", true, false, true, true), "no_script");
  check("and a missing CLI outranks the flow", loginBlockedReason("darwin", true, true, false, true), "no_cli");
  check("with a present CLI and script on Linux clearing it", loginBlockedReason("linux", true, true, true, true), null);

  // Asserted against the real loginSupport: comparing the pure function to itself would be a tautology.
  {
    const runtime = new LocalRuntime();
    for (const agent of AGENT_IDS) {
      const support = runtime.loginSupport(agent);
      check(
        `${agent}: supported is exactly "nothing is blocking it"`,
        support.supported,
        support.blocked === null,
      );
    }
    const claude = runtime.loginSupport("claude");
    report(
      "and on a BSD host the interactive flow is the one that is blocked",
      process.platform !== "darwin" || claude.blocked === "interactive_pty" || claude.blocked === "no_cli",
      `${process.platform}: claude blocked=${String(claude.blocked)}`,
    );
  }
}
