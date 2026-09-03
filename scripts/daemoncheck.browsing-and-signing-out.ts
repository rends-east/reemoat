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
import { createApp } from "../src/server.js";
import { tmp } from "./tmp.js";
import { check, report } from "./daemoncheck.env.js";
import { users, now, tokenFor, verifier, credentials, app, get, stubAgentConfig } from "./daemoncheck.fixtures.js";

process.stdout.write("\nnaming a session\n");
{
  // Pure functions, asserted with no session, for the same reason `containerRunArgs`
  // and `shouldSend` are: the rule they encode is the whole feature, and driving it
  // through a live agent would test the agent instead.
  check("a title is the first line, not the first 60 characters", deriveSessionTitle("Fix reconnect\n\nstack trace here"), "Fix reconnect");
  check("leading blank lines are skipped", deriveSessionTitle("\n\n  Rework the rail\n"), "Rework the rail");
  check("whitespace collapses", normalizeTitle("a   b\t\tc"), "a b c");
  // Controls are stripped rather than refused: on the derived path the input is a
  // prompt somebody wrote for an agent, and there is nobody to refuse to.
  check("control characters are stripped, not refused", normalizeTitle("a\u0000b\u001fc"), "a b c");
  check("and the paragraph separator counts as one", normalizeTitle("a\u2029b"), "a b");
  // `null` and never "": the column distinguishes "never named" from "named", and
  // "" would be a third state that renders as a blank header.
  check("nothing left means null, never an empty string", normalizeTitle("   \t  "), null);
  check("an empty prompt names nothing", deriveSessionTitle("\n\n"), null);
  check("a long title is clipped with an ellipsis", (normalizeTitle("x".repeat(200)) ?? "").length, MAX_TITLE_CHARS);
  {
    // Breaking on a nearby space is the difference between "the reconnect back"
    // and "the reconnect ba". Only a *nearby* one — a single 200-character word
    // has no space worth breaking on and must still be clipped.
    const derived = deriveSessionTitle("Rework the reconnect backoff so a dead tunnel does not spin for ever") ?? "";
    check("a derived title breaks on a word", derived.endsWith("…") && !/\s…$/.test(derived), true);
    check("and stays within its own shorter bound", derived.length <= 60, true);
    check("a single long word is still clipped", (deriveSessionTitle("x".repeat(300)) ?? "").length <= 60, true);
  }
}

process.stdout.write("\nan agent's own placeholder choices\n");
{
  /*
   * Measured 2026-07-31 against claude 0.63.0: its model list opens with a
   * placeholder, `default` / "Default (recommended)", whose description is
   * character-for-character that of `opus[1m]`. Offering both is offering one model
   * twice under two names, and a session left on the placeholder is why the control
   * read "Default" and answered nothing.
   *
   * Here rather than in `webcheck` because this is the only side that *has* every
   * description — `snapshotConfig` keeps only the selected choice's prose, so the
   * browser cannot see that two rows match.
   */
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
  // A rename of an equivalent, not an invention: the agent said they are the same
  // thing by giving them the same description.
  check("and the session is shown on the real one", deduped.value, "opus[1m]");

  // Where nothing duplicates, nothing is dropped — and that is right rather than a
  // gap. Claude's effort choices carry no descriptions at all, and there the
  // placeholder is the only way back to the agent's own default.
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

  // Empty strings are not a statement that two rows are the same thing.
  const blank = {
    ...model,
    choices: [
      { value: "a", name: "A", description: "", group: null },
      { value: "b", name: "B", description: "   ", group: null },
    ],
  };
  check("blank descriptions do not make two choices aliases", dedupeAliasChoices(blank).choices.length, 2);

  /* ---------------------------------------------------------------- *
   * A session pinned to one system is offered that system's models
   *
   * ⭐ Reported twice, the second time after a fix that only *grouped* them.
   * opencode is the native side of two systems and publishes ONE model control
   * holding both — 356 `openrouter/…` and six `opencode/…`. A session assembled
   * as OpenRouter offered six OpenCode Zen models at the bottom of its own
   * picker, and choosing one leaves the session running a model from a system its
   * preset does not name, with the chip, the tile and the glyph all still saying
   * OpenRouter. Q2.216's dishonesty, reached through the model menu.
   * ---------------------------------------------------------------- */
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
  /*
   * ⚠ The one exemption, and it is what keeps a fix from stranding somebody. A
   * session switched by hand before any of this must keep the row it is *on*: a
   * list missing the selected value makes the chip fall back to a raw id and makes
   * `pinNativeModel` refuse the next resume with "has no model called …".
   */
  check(
    "a session already switched to the other system keeps a way back to itself",
    narrowToSystem({ ...mixed, value: "opencode/big-pickle" }, "openrouter/").choices.map((c) => c.value),
    ["openrouter/aion-labs/aion-3.0-mini", "openrouter/z-ai/glm-5.3-flash", "opencode/big-pickle"],
  );
  /*
   * Narrow twice over, and both by identity: no other control's values are
   * namespaced, and a bare harness or a routed pairing has no namespace at all.
   */
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
  // Measured 2026-07-31 against claude-agent-acp 0.63.0: `usage_update` fires from
  // the `message_delta` handler, i.e. on every streaming token. `touchSafe()` costs
  // a snapshot, a row write and a WS frame *per attached client*, on the agent's
  // own synchronous emit path — so this predicate is the only thing between a
  // working context readout and thousands of unperceivable frames per turn.
  const at = (used: number, size = 200_000) => ({ used, size, cost: null });

  check("a token that does not move the percent is not announced", usageWorthAnnouncing(at(1000), at(1001)), false);
  check("crossing a whole percent is", usageWorthAnnouncing(at(1000), at(3000)), true);
  check("and it is the rounded value that decides", usageWorthAnnouncing(at(2000), at(2999)), false);
  // The window itself changing is rare and always visible — a model switch resizes
  // it, and every percentage on screen becomes wrong at once.
  check("a resized window is always announced", usageWorthAnnouncing(at(1000), at(1000, 100_000)), true);
  check("and so is a cost change", usageWorthAnnouncing({ ...at(1000), cost: null }, { ...at(1000), cost: { amount: 0.4, currency: "USD" } }), true);
  // `size: 0` is "cannot tell", and crossing into or out of it flips a client
  // between drawing a percentage and drawing nothing at all.
  check("entering cannot-tell is announced", usageWorthAnnouncing(at(1000), at(1000, 0)), true);
  check("leaving it is too", usageWorthAnnouncing(at(1000, 0), at(1000)), true);
  check("and inside it any movement counts, since nothing can be rounded", usageWorthAnnouncing(at(1000, 0), at(1001, 0)), true);
  check("a repeat of the same reading is not announced", usageWorthAnnouncing(at(1000), at(1000)), false);
}

process.stdout.write("\nevery verb this app registers is one a browser may send\n");
{
  // `CORS_ALLOW_METHODS`'s comment claims to be "every method any route uses",
  // and for two releases it was not: `PUT /agent-auth/:agent` shipped without
  // being added, so the paste-a-token path preflight-failed in every browser
  // while working perfectly from `curl` — the failure a literal list exists to
  // prevent rather than cause. That claim is checkable, and only here: this is
  // the one driver that mounts the real app, so it is the only place that can
  // see the routes and the list at the same time.
  //
  // The direction matters. A method the list carries and no route uses is
  // harmless; a method a route uses and the list omits is a route no browser can
  // reach. So this asserts containment one way only.
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
// Unfiltered now. Every recent cwd is one a session really can start in, so
// dropping the ones outside the roots would hide exactly the useful ones.
check("and every recent directory is offered", roots.body.recent.length > 0, true);

const outsideRoots = realpathSync(tmp("elsewhere-"));
const listOutside = await get(`/fs/list?path=${encodeURIComponent(outsideRoots)}`, "u_alice");
check("listing outside the roots is refused", listOutside.status, 403);
check("with a code naming what to change", listOutside.body.error.code, "outside_roots");

// And the asymmetry, asserted rather than left as prose: the roots narrow the
// *listing* and nothing else, so a directory the picker will not show is still a
// directory a session may start in. That is the point — somebody keeping a
// repository outside their browse roots must not be locked out of it.
//
// Asserted on `resolveCwd` directly, because that is where the property lives:
// `registry.create` resolves the cwd *before* it asks whether the agent exists,
// so this is the whole of the decision and it needs nothing installed.
check("but resolving it as a session cwd is not", await resolveCwd(outsideRoots), outsideRoots);

/*
 * The route agrees, and this asserts that it was **not refused for the path**
 * rather than that it succeeded.
 *
 * `check(..., 201)` was wrong in two directions at once. It failed in CI, where
 * no agent is installed and `create` therefore answers `503 agent_unavailable` —
 * the same lesson as the deleted `dockercheck` driver, which needed a real agent
 * on PATH and was removed because that is the one thing CI cannot have,
 * relearned one driver later. And it *passed* on a developer machine only by
 * really spawning `kimi` and completing an ACP
 * handshake, inside the driver whose own header promises no agent is involved,
 * leaving a session and a worktree behind for a line that was never about either.
 *
 * So what is checked is the refusal that would be a regression: `outside_roots`.
 * Anything else means the path was accepted and the request went on to fail, or
 * not, for reasons that have nothing to do with the browse roots.
 */
const createOutside = await app.fetch(
  new Request("http://d/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
    body: JSON.stringify({ agent: "kimi", cwd: outsideRoots }),
  }),
);
const outsideBody = (await createOutside.json()) as { error?: { code?: string } };
check("and the route does not refuse it for being outside them", outsideBody.error?.code === "outside_roots", false);
check("nor with the status that refusal carries", createOutside.status === 403, false);

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

  // The name is a single segment, so traversal is not a thing to normalize away
  // — there is nowhere to put a separator that the daemon then has to unpick.
  const climb = await mkdir("u_alice", { parent: join(users, "u_alice"), name: "../u_bob/sneaky" });
  check("a separator in the name is refused outright", climb.status, 400);
  check("with a code that says why", (await climb.json() as any).error.code, "invalid_path");
  check("and nothing was created", existsSync(join(users, "u_bob", "sneaky")), false);

  const dots = await mkdir("u_alice", { parent: join(users, "u_alice"), name: ".." });
  check("and `..` alone is not a folder name", dots.status, 400);

  // The parent is resolved exactly as `POST /sessions` resolves a cwd — which now
  // means neither is confined, so a folder can be made anywhere a session could
  // run. The single-segment rule above is what makes that safe to say: there is
  // still no way to express a traversal, only a place.
  const outside = await mkdir("u_alice", { parent: join(users, "u_bob"), name: "made-here" });
  check("a parent outside the browse roots is accepted", outside.status, 201);
  check("and the folder is there", existsSync(join(users, "u_bob", "made-here")), true);

  const missing = await mkdir("u_alice", { parent: join(users, "u_alice", "nowhere"), name: "x" });
  check("but a parent that does not exist is not", missing.status, 400);
  check("with a code that says which half was wrong", (await missing.json() as any).error.code, "not_found");
}

/* ------------------------------------------------------------------ *
 * Signing out, as a state of the machine
 *
 * A credential is read once, at spawn, so signing out used to reach nothing that
 * was already running: the conversation carried on answering for an account its
 * owner had just revoked, and the only sign anything had changed was a badge on
 * another screen. What is asserted here is that the sign-out ends them, that
 * nothing brings them back on its own, and that signing in brings back exactly
 * those and no others.
 *
 * The `null` rule is the one worth breaking the build over. `loginState` has
 * three answers, and kimi's permanent, correct one is "could not tell" — it
 * publishes no status verb. A refusal written as `!== true` would take every kimi
 * conversation on the machine off the air for ever, on the strength of a question
 * kimi cannot be asked.
 * ------------------------------------------------------------------ */

process.stdout.write("\nsigning out, as a state of the machine\n");
{
  const events = readFileSync(new URL("../src/events.ts", import.meta.url), "utf8");
  const reg = readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../src/runtime/local.ts", import.meta.url), "utf8");

  check("there is a reason for it", /\| "agent_signed_out"/.test(events), true);
  /*
   * **Not a daemon exit.** That list is "the daemon went away rather than anybody
   * deciding anything", and it is what the boot pass resumes. A person decided
   * this, so putting it there would have the daemon relaunch, at every restart,
   * an agent whose credential was deliberately taken away.
   */
  check(
    "and it is not one of the daemon's own",
    /DAEMON_EXIT_REASONS = \["daemon_restarted", "daemon_shutdown", "config_changed"\]/.test(events),
    true,
  );
  /*
   * ⚠ **A prompt resumes it and a boot pass does not**, which reverses half of
   * what this line used to assert (`return false;` on both triggers).
   *
   * The old rule made the state unreachable from inside the app: `reloadCredentials`
   * is the only other reversal and every one of its callers is an in-app credential
   * write, so a CLI that refreshed its own token — or somebody signing in from
   * their own terminal — left a conversation nothing could bring back. Asserted
   * against the *function* rather than its source text, which is what a regex on
   * `return false;` could never tell apart from the arm above it.
   */
  // The trigger split for this reason is asserted with the rest of the table, in
  // "what a restart brings back" — a regex over `return false;` could never tell
  // this arm from the one above it.

  check("signing out ends the live conversations", /async signOutSessions\(agent: AgentId\): Promise<number>/.test(reg), true);
  check("with that reason", /session\.stop\("agent_signed_out"\)/.test(reg), true);
  /*
   * Deliberately not filtered by `takesCredentialChange`: that spares a turn in
   * flight because a working turn is evidence of a working credential. Here the
   * credential is being taken away, and a turn still running on it is exactly
   * what somebody signing out means to stop.
   */
  check("including one mid-turn, unlike a credential being added", /takesCredentialChange/.test(
    /async signOutSessions[\s\S]*?\n  \}/.exec(reg)?.[0] ?? "",
  ), false);
  check("and the route waits for it before answering", /await registry\.signOutSessions\(agent\)/.test(routes), true);

  /*
   * **A credential that went away some other way is reported by the agent**, not
   * discovered by asking. The prompt path deliberately has no probe: one there
   * cost a spawn per message, was only ever as fresh as a 3s cache, and made this
   * driver depend on whether the person running it was signed in — a stub runtime
   * inherits the real probe, and `resolveLoginBinary` found the copy this
   * repository vendored then, which on CI is signed in to nothing.
   */
  check("the prompt path asks no CLI whether anybody is signed in", /sessionRuntime\.signedOut\(/.test(routes), false);
  /*
   * Comments stripped, because the docblocks here quote the call this used to
   * make and the message it must never read — which is the point of writing them
   * down, and would otherwise make these assertions fail on their own
   * explanation.
   */
  const code = reg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the agent's own failure is what it reacts to", /isAuthFailure\(event\)/.test(reg), true);
  /*
   * ⚠ **And it replaces the agent rather than ending the conversation.**
   *
   * This asserted `this.stop("agent_signed_out")` on the event pump, which is the
   * line Q7.99 had already measured wrong: a session idle 5h36m reported
   * `authentication_failed` while the token on disk was valid for another 1.4h,
   * and a fresh agent worked four minutes later. What was stale was the process.
   * Ending the conversation threw away the half that was fine.
   *
   * The error is in the log either way — `record` appends before this runs — so
   * what is asserted here is that nothing *else* is done to the session but give
   * it a new process.
   */
  check("and replaces the agent instead of ending the conversation", /onAgentUnusable\(\): void \{[\s\S]*?restartAgent\(\)/.test(reg), true);
  check("never stopping it on the pump", /onAgentUnusable\(\): void \{[\s\S]*?\n  \}/.exec(reg)?.[0].includes('stop("agent_signed_out")'), false);
  /*
   * ⚠ **And the second caller, which is the one a screenshot found.** An ACP
   * session that dies under a *live* process leaves `status: idle` and answers
   * every message with the same `-32603` — no `errorKind`, so `isAuthFailure`
   * quite correctly ignores it, and no way out of the conversation from inside
   * the app. Four messages, four identical errors.
   *
   * `failed` is the precise signal: reaching the pump's own `catch` means
   * `session.prompt()` **rejected** rather than streamed a failure, so the agent
   * never took the message. Anything that goes wrong *inside* a turn arrives
   * through `record` and never comes near it — which is what stops this firing
   * on an ordinary bad turn.
   */
  check("a prompt the agent never took also replaces it", /if \(failed\) this\.onAgentUnusable\(\);/.test(code), true);
  check("and the message is never what decides", /describeError\(error\)[\s\S]{0,400}onAgentUnusable/.test(code), false);
  /*
   * Armed per prompt, which is the difference between a retry and a loop: a
   * credential that really is gone fails the fresh agent too, and the second
   * failure must not start a third process.
   */
  check("one replacement per message somebody sends", /this\.authRestartArmed = true;/.test(reg), true);
  check("spent when it fires", /onAgentUnusable\(\): void \{[\s\S]*?this\.authRestartArmed = false;/.test(reg), true);
  /*
   * Still the only writer of the reason, so signing out still ends conversations.
   *
   * Counted with the comments stripped, which is not fastidiousness: the docblock
   * on `onAuthFailure` quotes the call it used to make, so a naive count reads 2
   * and the assertion would have to be loosened to a number that no longer means
   * "one call site".
   */
  check("only an explicit sign-out still writes the reason", (code.match(/stop\("agent_signed_out"\)/g) ?? []).length, 1);
  check("and it is the sign-out route's own sweep", /signOutSessions[\s\S]*?stop\("agent_signed_out"\)/.test(code), true);

  /*
   * The kind, never the message: `describeError`'s text is the agent's own prose
   * and moves with its version, and matching "authenticate" in it would end a
   * conversation because of a sentence somebody's CLI happens to print.
   */
  const { isAuthFailure } = await import("../src/events.js");
  check("an auth failure is recognised", isAuthFailure({ type: "error", data: { code: -32603, data: { errorKind: "authentication_failed" } } }), true);
  check("another agent error is not", isAuthFailure({ type: "error", data: { code: -32603, data: { errorKind: "something_else" } } }), false);
  check("nor is the message alone", isAuthFailure({ type: "error", data: { code: -32603, data: {} } }), false);
  check("a non-error event never is", isAuthFailure({ type: "text", data: { data: { errorKind: "authentication_failed" } } }), false);
  // Every shape it must survive rather than throw on, since this runs on the pump.
  for (const shape of [undefined, null, "text", 7, {}, { data: null }, { data: "x" }] as unknown[]) {
    check(`and a payload of ${JSON.stringify(shape) ?? "undefined"} is refused quietly`, isAuthFailure({ type: "error", data: shape }), false);
  }

  /*
   * The probe that used to sit on the prompt path is **deleted**, not merely
   * unused — with the note saying why in its place, for the reason `paths.ts`
   * gives about `atOrUnderReal`: a method with no callers and a docblock arguing
   * for itself reads as live policy to whoever finds it next.
   */
  check("the probe is gone rather than left for a future caller", /async signedOut\(/.test(runtime), false);
  check("with the reason it is gone written where it was", /`signedOut\(agent\)` used to live here/.test(runtime), true);

  /* ---------------------------------------------------------------- *
   * ⭐ A harness that refused to open a session
   *
   * The other half of the same subject, and the one that had no field to live in.
   * `readLoginState` answers `pasted ? true : null` for every harness with no
   * status command — opencode, and every harness a plugin adds — so a New session
   * tile was drawn for one that had never been shown to work, and each press cost
   * a worktree, a branch and a session row before the agent declined.
   *
   * ⚠ **It is not `loggedIn: false`, and that is the whole design.** Writing it
   * there would have been read by `AgentAskRuns.admit`, which guards `claim` —
   * the one thing that ever spawns such a harness again, and therefore the only
   * thing that could ever discover it had been fixed. The record would have shut
   * the door it needs to be let out of.
   * ---------------------------------------------------------------- */
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
    /*
     * ⚠ **The assertion this whole section exists for.** The harness has just
     * refused, in as many words, and the credential axis still answers "cannot
     * tell" — because it still cannot. `AGENT_LOGIN.opencode.status` is `null`,
     * and manufacturing a `false` here is what would have reached `admit`.
     */
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

    /*
     * ⚠ **The expiry driven through the reader the listing actually uses**, and
     * not only through the exported helper. Asserted on the helper alone, deleting
     * both the `startRefusalLive` call and the `delete` from `startRefusal` left
     * every driver green — measured — because both round trips above read entries
     * noted microseconds earlier. A never-expiring reader is the one failure this
     * whole design's fourth point rests on not happening.
     *
     * The clock is faked around one call rather than injected into the runtime:
     * `LocalRuntimeOptions` takes `exec` and `secrets` and neither is a test hook,
     * so a `now` beside them would be the first, on the class whose subject is
     * spawning programs.
     */
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
    /*
     * ⚠ **And *dropped* it rather than filtering it, which is what the clock going
     * back is for.** A reader that only filtered would hand the entry straight
     * back here, since `now - at` is inside the budget again.
     */
    check("and dropped it rather than hiding it", (await rowFor(rt, "opencode"))?.lastStartRefusal, null);

    /*
     * The arithmetic itself, at the boundary. It is the load-bearing half of the
     * design: an observation ages and a verdict does not, which is what makes the
     * list of things that *clear* one not have to be exhaustive — nobody who signs
     * in by running the CLI on the machine itself tells this daemon anything.
     */
    const held = { at: 1_000_000, routed: false, message: "no" };
    check("a refusal is believed inside its budget", [
      startRefusalLive(held, held.at),
      startRefusalLive(held, held.at + START_REFUSAL_TTL_MS - 1),
      startRefusalLive(held, held.at + START_REFUSAL_TTL_MS),
      startRefusalLive(held, held.at + START_REFUSAL_TTL_MS * 4),
    ], [true, true, false, false]);

    /*
     * ⚠ **Written from two places and from nowhere else.** The event pump says
     * "authentication" too, and Q7.99 measured that signal against a token with
     * 1.4 hours left on it — so recording it would take a harness off every strip
     * in the fleet because one conversation's agent had gone stale.
     */
    const session = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");
    check("only a typed auth_required writes it", (session.match(/noteStartRefusal\(/g) ?? []).length, 2);
    check("on the start path", /session\/new: authentication required[\s\S]{0,900}noteStartRefusal\(/.test(session), true);
    check("and on the resume path", /session\/resume: authentication required[\s\S]{0,600}noteStartRefusal\(/.test(session), true);
    check("and the pump writes nothing", /noteStartRefusal/.test(code), false);
    /*
     * ⚠ **Anchored to the statement that follows a *successful* open, not counted
     * over the file.** Two calls sitting in the two catch arms would satisfy a
     * count and mean the opposite: a refusal forgotten by the refusal itself.
     * `response` is assigned only where `session/new` or `session/resume` came
     * back, so a clear textually after it is on the path that succeeded.
     */
    check("while a session that opens forgets it", (session.match(/forgetStartRefusal\(options\.agent\)/g) ?? []).length, 2);
    check("on the start path, after the agent answered", /const session = Session\.adopt\(options, client, response\.sessionId/.test(session) && /forgetStartRefusal\(options\.agent\);[\s\S]{0,600}Session\.adopt\(options, client, response\.sessionId/.test(session), true);
    check("and on the resume path, after it answered there", /forgetStartRefusal\(options\.agent\);[\s\S]{0,400}Session\.adopt\(options, client, options\.agentSessionId/.test(session), true);

    /*
     * ⚠ **Exactly one of the five `forgetAvailability` call sites clears it, and
     * it is the one where a credential *arrived*.** The other four are a key being
     * deleted, a sign-out, a login run ending and a login cancelled — none of them
     * evidence that a harness which would not start now would, and one of them is
     * the opposite. This counts rather than naming a line, because the failure
     * mode is somebody pairing the two calls everywhere out of tidiness.
     */
    /*
     * ⚠ **Per handler, never as a count over the file — and this assertion shipped
     * as a count for one revision.** Measured: moving the call out of the `PUT`
     * handler and into `POST …/logout` left the total at two, left the anchored
     * half matching, and left `daemoncheck` green — while inverting the rule the
     * code beside it argues for. `reloadCredentials`' own pair two blocks down
     * already uses this technique and says why.
     */
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
    /*
     * The three that must not, and they are the reason this is per handler:
     * deleting a key, signing out and abandoning a login are all a credential
     * going *away*, and none is evidence that a harness which would not start now
     * would. `DELETE` is the sharpest — it would erase the record of the refusal
     * the key it deletes was pasted against.
     */
    check("while deleting a key does not", /forgetStartRefusal/.test(del), false);
    check("and neither does signing out", /forgetStartRefusal/.test(out), false);
    check("nor abandoning a login", /forgetStartRefusal/.test(bodyOfRoute("delete", "/agent-auth/login/:loginId")), false);
    // The count stays as a backstop, so a fourth site cannot appear unremarked.
    check("and those are the only three", (routes.match(/forgetStartRefusal\(/g) ?? []).length, 3);
    check("which refuses nothing, unlike its neighbours", /logout_unsupported/.test(again), false);
    /*
     * ⚠ **And it answers the same row shape the listings do.** `availability()`
     * carries no `login` object — that is spread on by hand at the two listings —
     * so a third route answering an agent row drops the one field whose absence
     * makes every reader fall to *cannot check*.
     */
    check("and it answers the row with the field availability() does not carry", /loginSupportOf\(found\.id\)/.test(again), true);

    /*
     * ⚠ **And the second press costs no worktree**, which is the half of
     * `registry.create`'s existing fence that had never been extended to this
     * axis. The refusal happens *after* the spawn, so without this the branch and
     * the session row are made before anything knows — the growth inside somebody
     * else's repository that the `available` check above it was written for.
     */
    /*
     * ⚠ **Comments off, and this assertion shipped wrong for one run without
     * it.** The fence carries a paragraph naming the field it reads, so a slice of
     * the raw source is satisfied by the explanation whether or not the code is
     * there — measured: deleting the `throw` outright left this green. `code` is
     * the same stripped copy the assertions above already use, for the same
     * reason and one docblock away.
     */
    const workspaceAt = code.indexOf("await createWorkspace(");
    // `indexOf` answers -1 for a call that has been renamed, and `slice(0, -1)` is
    // the whole file minus one character — an assertion that cannot fail, about an
    // ordering that no longer exists.
    check("the workspace call this ordering is about is still called that", workspaceAt > 0, true);
    const beforeWorkspace = code.slice(0, workspaceAt);
    check(
      "a remembered refusal is refused before a workspace exists",
      // The `throw`, not merely the read: deleting the refusal and keeping the
      // `const` left this green, which is a check satisfied by a variable nobody
      // acts on.
      /lastStartRefusal[\s\S]{0,600}throw new Error\(refusal\.message\)/.test(beforeWorkspace),
      true,
    );
    /*
     * ⚠ **Bare and native starts only, unless routing has itself been refused.**
     * `applySystem` runs before `session/new`, so a refusal measured while routed
     * condemns every way of starting the harness — but one measured bare says
     * nothing about a start that runs on somebody else's key, which is the
     * signed-out Claude Code on OpenRouter this repository documents as working.
     */
    check("and a bare refusal does not condemn a routed preset", /refusal\.routed \|\| options\.customAgent == null/.test(code), true);
    /*
     * ⚠ **And a *native* pairing is fenced too, which `customAgent == null` alone
     * does not reach.** `applySystem` returns at `spec.nativeHarness ===
     * options.agent`, before `providers/set` and before any key is read, so such a
     * session runs on the harness's own credential exactly as a bare start does —
     * making a bare refusal precisely as dispositive. Left to the two disjuncts
     * above, the press that had just been refused was the one press the fence never
     * caught, and every repeat cost a worktree and a branch again.
     */
    check("and a native pairing is fenced by the same bare refusal", /nativeHarness === options\.agent[\s\S]{0,400}refusal\.routed \|\| options\.customAgent == null \|\| nativeHere/.test(code), true);
    /*
     * The lockout test, as source rather than as behaviour: `admit` may never read
     * this field, or the capability sweep — the only live re-measurement a harness
     * with no probe has — would be refused by the record it is the cure for.
     */
    const ask = readFileSync(new URL("../src/agentask.ts", import.meta.url), "utf8");
    check("and the one thing that could clear it is never gated on it", /lastStartRefusal/.test(ask), false);

    /*
     * ⚠ **And the whole of it driven over HTTP**, because everything between the
     * runtime and the response is where a field is quietly dropped — `GET /agents`
     * spreads the availability row, and the re-check route has to answer with what
     * its own lookup saw rather than with a claim of its own.
     *
     * This is also the only assertion that the route **refuses nothing** where its
     * two neighbours answer `503`: `opencode` has no sign-out verb and no login
     * flow, which is exactly the harness this control exists for.
     */
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
    /*
     * ⚠ **The same row, key for key, and not merely the same id.** `availability()`
     * carries no `login`; the two listings spread it on by hand, so a third route
     * answering an agent row silently drops it — and a row without it falls to
     * *cannot check* in both this repository's clients, which is the permanent
     * wrong badge `local.ts` answers `no_flow` to prevent. Measured before this
     * assertion existed: `pnpm client agents` printed "no sign-in needed" and
     * `pnpm client agents recheck` printed "cannot check", for one harness in one
     * state, seconds apart.
     *
     * Compared as **key sets** rather than as values: `hint` and `loggedIn` are
     * answers to a live probe and may legitimately differ between two calls, while
     * the shape may not.
     */
    const listedRow = ((await call("/agents"))["agents"] as { id: string }[]).find(
      (one) => one.id === "opencode",
    );
    const rowAgain = (await call("/agent-auth/opencode/recheck", "POST"))["info"];
    check(
      "and the row it answers is the shape the listing answers",
      Object.keys(rowAgain as object).sort(),
      Object.keys(listedRow as object).sort(),
    );
    // The one this route exists for: `logout` refuses opencode outright, and a
    // harness with no sign-out verb is precisely the population that can be hidden.
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

    /* ---------------------------------------------------------------- *
     * ⭐ And the write itself, driven against an agent that really refuses
     *
     * Everything above this pins the *record*; this is the one case that pins
     * where it comes from. A scripted agent answers `initialize` and then refuses
     * `session/new` with ACP's `auth_required`, which is a typed JSON-RPC code and
     * the whole reason this signal is believed at all — the message match this
     * daemon also carries is a concession `isAuthRequiredMessage` documents, and
     * matching prose is not what writes the record.
     * ---------------------------------------------------------------- */
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
      /*
       * Read first, because the property is that this axis does **not** move — and
       * on a developer's own machine kimi's credential file may or may not exist,
       * so a literal here would be an assertion about whoever ran the driver.
       */
      const before = (await refusing.availability()).find((one) => one.id === "kimi")?.loggedIn ?? null;
      let said = "";
      try {
        await Session.start({ agent: "kimi", cwd: process.cwd(), runtime: refusing });
      } catch (error) {
        said = error instanceof Error ? error.message : String(error);
      }
      check("a real refusal reaches the caller as the agent's own sentence", /authentication required/i.test(said), true);
      /*
       * ⚠ **A full re-probe first, and it must not take the record with it.**
       * `forgetAvailability` is the credential cache's clear and the record is
       * deliberately not under it — three of its five callers are a credential
       * going *away*, and losing a key is not evidence that a harness which would
       * not start now would.
       */
      refusing.forgetAvailability();
      const row = (await refusing.availability()).find((one) => one.id === "kimi") ?? null;
      check("and is what wrote the record, which a re-probe does not clear", row?.lastStartRefusal?.message, said);
      /*
       * ⚠ **`routed: false`, and this is the cell that keeps a bare refusal from
       * condemning a routed preset.** No system was named, so `applySystem`
       * returned at its first line — the harness refused on its own credential and
       * has said nothing about a start that would run on somebody else's key.
       */
      check("under the configuration it was measured with", row?.lastStartRefusal?.routed, false);
      /*
       * ⚠ **And the credential axis did not move**, which is the property the
       * whole design rests on: `admit` reads that field, and `admit` guards the
       * only spawn that could ever clear this record.
       */
      check("while the credential axis did not move at all", row?.loggedIn, before);
    }
  }
}

/* ------------------------------------------------------------------ *
 * A credential saved while an agent is already running
 *
 * Secrets are injected at spawn — `env: { ...agentEnv(), ...this.secrets(agent) }`
 * — so a token saved afterwards reaches a running agent never. Measured on a live
 * daemon: a token saved at 00:23:02, a prompt refused at 00:23:12 with
 * `Failed to authenticate`, and a session created four minutes later working at
 * once. The save updated the database, turned the badge green, and changed
 * nothing for the conversation somebody was looking at.
 *
 * What is asserted here is the *decision*, which is pure: which sessions take a
 * relaunch and which are left alone. The relaunch itself is `applyUltracode`'s
 * sequence, already covered, and the fan-out is deliberately not awaited.
 *
 * The refusals matter more than the acceptance. A mid-turn session is one whose
 * credential is demonstrably working, and stopping it would kill the turn; a
 * blocked one is somebody being waited on, and a relaunch drops the question
 * without answering it.
 * ------------------------------------------------------------------ */

process.stdout.write("\na credential saved while an agent is already running\n");
{
  const src = readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");

  // The guard set, read off the predicate itself: each of these is a state in
  // which a relaunch would destroy something a person is waiting on.
  const guard = /get takesCredentialChange\(\): boolean \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
  report("a relaunch is refused for a session that has ended", /this\.terminal \|\| this\.stopRequested/.test(guard), "terminal");
  report("and for one with a turn in flight", /this\.turn !== null/.test(guard), "mid-turn");
  report("and for one with somebody parked on a question", /this\.awaitingCount > 0/.test(guard), "blocked");
  // Both flags read, however the predicate happens to be phrased — the guard was
  // written as `!this.clearing && !this.restarting`, and pinning one spelling
  // would fail on a rewrite that changed nothing.
  report(
    "and while another process boundary is already open",
    /this\.clearing/.test(guard) && /this\.restarting/.test(guard),
    "clearing/restarting",
  );

  /*
   * The count has to be decided before the work starts. The first version
   * incremented and then decremented inside a `.then`, which resolves after the
   * return — so every refusal was still counted as a restart and the screen would
   * have reported chats it never touched.
   */
  /*
   * The parameter list is matched loosely on purpose: what these assertions are
   * about is the body, and pinning the signature here meant that adding `revive`
   * emptied `fan` — which the positive `.test()` checks below caught loudly, being
   * `false` against an expected `true`. The one that does **not** is the negated
   * one, `!/void session\.applyCredentialChange\(\)/`, which is vacuously true
   * against `""` and would have gone on passing while asserting nothing at all.
   * That asymmetry is the reason for the guard on the next line rather than for
   * the loosened regex: one negated assertion over an extracted string is enough
   * to need it.
   */
  const fan = /reloadCredentials\([^)]*\): number \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
  check("the fan-out was found at all, so the checks below mean something", fan.length > 0, true);
  check("the fan-out counts what it filtered", /session\.takesCredentialChange/.test(fan), true);
  check(
    "and returns that, not a number it hoped to correct later",
    /return restarting\.length \+ returning\.length;/.test(fan),
    true,
  );
  /*
   * Detached, and *within* that, serialised — two properties that pull opposite
   * ways and are both required.
   *
   * Detached is the old rule and the reason this method returns `number` rather
   * than `Promise<number>`: the caller answers with the count and does not wait
   * for a single teardown. Serialised is the new one. Each of these restarts is a
   * SIGTERM, a process teardown, a spawn and an ACP handshake; issued as N bare
   * `void` calls they all began at once, so one credential save on a full machine
   * was `DEFAULT_MAX_SESSIONS` of them against this one event loop — the
   * thundering herd `signOutSessions` refuses in this same file, over this same
   * work. The `void` therefore has to sit on the *loop* rather than on each call,
   * which is what these two assertions pin between them.
   */
  check("without awaiting the restarts", /void \(async \(\) => \{/.test(fan), true);
  check(
    "but one at a time inside that, not a herd of SIGTERMs at once",
    /await session\.applyCredentialChange\(\)/.test(fan) && !/void session\.applyCredentialChange\(\)/.test(fan),
    true,
  );
  /*
   * **Signing in reverses a sign-out and nothing else.** The reason is the record
   * of who ended a session: one this daemon ended because the credential went
   * away is owed a resume when a credential returns, and one a person stopped by
   * hand carries `stopped` and stays stopped. Keying on `terminal` alone would
   * revive both, which is the daemon overruling somebody.
   */
  check("and signing in brings back what the sign-out ended", /exit\?\.reason === "agent_signed_out"/.test(fan), true);
  check("keyed on the reason rather than on being terminal at all", /session\.terminal && session\.exit\?\.reason/.test(fan), true);

  /*
   * One sequence, two callers. It was written for `ultracode` and is subtle
   * enough — a synchronously-opened window, five guard sites, one `finally` — that
   * a second copy would drift.
   */
  check("the restart sequence has one definition", (src.match(/private async restartAgent\(/g) ?? []).length, 1);
  check("and ultracode goes through it", /await this\.restartAgent\(\);[\s\S]{0,80}\}/.test(src), true);
  check("and so does a credential change", /takesCredentialChange[\s\S]{0,400}await this\.restartAgent\(\)/.test(src), true);

  // The route reports it, so a client can say what happened rather than guessing.
  const routes = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  check("saving a credential relaunches and says how many", /saved: true, agent, envName, restarting/.test(routes), true);
  /*
   * ⚠ **`removed` reports what the lookup saw rather than being the literal
   * `true` it was.** `DELETE /systems/:system` already answered that way, and this
   * route now has to for the same reason: a harness a plugin added stops being
   * *offered* the moment somebody switches that plugin off, and the one control
   * that can clear its saved key must not be the one that disappears with it. So
   * the removal happens whatever the catalogue says, and the answer is a fact about
   * the row rather than an error about the request.
   */
  check("and so does removing one", /removed: had, agent: named, envName, restarting/.test(routes), true);

  /*
   * ⚠ **Which direction the credential went, which both routes used to lose.**
   *
   * `reloadCredentials` does two things: it restarts the sessions still running,
   * because a secret is injected at spawn and neither a save nor a removal reaches
   * one that is already up; and it resumes the sessions that were ended *because
   * there was no credential*. The first is right for both callers. The second is
   * right for exactly one — and DELETE reached it too, so removing a credential
   * revived every `agent_signed_out` conversation and handed each a fresh agent
   * with nothing to authenticate with, which is the `Internal error: Failed to
   * authenticate` this file argues against elsewhere. A removal is a sign-out's
   * second half, never its reversal.
   *
   * Three assertions rather than one, because each half can regress alone: that
   * the resume is gated at all, that DELETE asks for it not to happen, and that
   * PUT still leaves it on.
   */
  check("the resume half is gated on which way the change went", /revive\s*\?/.test(fan), true);
  check("and the default is the one that revives, so a save needs no argument", /revive = true/.test(fan), true);

  /*
   * Anchored to each handler rather than grepped over the whole file, because the
   * two calls differ only in an argument and the lines around them are identical
   * — so a file-wide test for both strings passes just as happily with the PUT and
   * the DELETE swapped, which is the one mistake these assertions exist to catch.
   */
  const put = /app\.put\("\/agent-auth\/:agent"[\s\S]*?\n  \}\);/.exec(routes)?.[0] ?? "";
  const del = /app\.delete\("\/agent-auth\/:agent"[\s\S]*?\n  \}\);/.exec(routes)?.[0] ?? "";
  check("both agent-auth handlers were found, so the two below mean something", [put.length > 0, del.length > 0], [true, true]);
  check("removing a credential does not revive what a sign-out ended", /reloadCredentials\(named, false\)/.test(del), true);
  check("and saving one still does", /reloadCredentials\(agent\)/.test(put), true);
}

/* ------------------------------------------------------------------ *
 * A login that cannot be offered
 *
 * `loginStdio` fixed BSD `script` for the flows that read nothing, and the one
 * that reads something was left with an enabled button that opens a wizard and
 * dies in a `<pre>`. `loginBlockedReason` is the answer *before* the button is
 * drawn, and it is asserted for every platform from a machine that is one of
 * them — the same reason `loginStdio` and `hostLoginArgs` are pure.
 * ------------------------------------------------------------------ */

process.stdout.write("\na login that cannot be offered\n");
{
  // The fifth argument says the agent *has* a sign-in; `loginBlockedReason` lost
  // its default for it, so every call here states which agent it is standing in for.
  const ok = (p: NodeJS.Platform, interactive: boolean) => loginBlockedReason(p, interactive, true, true, true);

  check("claude on macOS cannot be offered a wizard", ok("darwin", true), "interactive_pty");
  check("nor on the other BSDs", [ok("freebsd", true), ok("openbsd", true), ok("netbsd", true)], [
    "interactive_pty",
    "interactive_pty",
    "interactive_pty",
  ]);
  // The whole point of the distinction: the device-code flows are fine there,
  // because `loginStdio` can hand them /dev/null.
  check("a device-code flow on macOS is fine", ok("darwin", false), null);
  check("and everything is fine on Linux, including the interactive one", [ok("linux", true), ok("linux", false)], [
    null,
    null,
  ]);

  // The two older reasons still answer first, and in this order: a host with no
  // `script` cannot run any login, whatever the flow.
  check("no script outranks the platform", loginBlockedReason("darwin", true, false, true, true), "no_script");
  check("and a missing CLI outranks the flow", loginBlockedReason("darwin", true, true, false, true), "no_cli");
  check("with a present CLI and script on Linux clearing it", loginBlockedReason("linux", true, true, true, true), null);

  /*
   * `supported` is `blocked === null` and nothing else, asserted against the
   * **real** `loginSupport` rather than by re-deriving it here. Comparing the
   * pure function to itself is a tautology that passes whatever the runtime does,
   * which is precisely the "assertion passing for the wrong reason" this file
   * warns about elsewhere.
   */
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
    // On this machine, which is the one running the driver.
    const claude = runtime.loginSupport("claude");
    report(
      "and on a BSD host the interactive flow is the one that is blocked",
      process.platform !== "darwin" || claude.blocked === "interactive_pty" || claude.blocked === "no_cli",
      `${process.platform}: claude blocked=${String(claude.blocked)}`,
    );
  }
}
