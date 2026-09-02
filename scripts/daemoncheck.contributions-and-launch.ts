import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore } from "../src/events.js";
// Type only: every *value* in that module is reached through a dynamic import
// inside the block that drives it, so each section reads the table rather than a
// binding somebody could have shadowed at the top of this file.
import type { SystemId } from "../src/acp/systems.js";
import { hostGit } from "../src/git.js";
import { SessionRegistry } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { openStores } from "../src/store/sqlite.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { stubAgentConfig } from "./daemoncheck.fixtures.js";
import { tarOf, bodyOf } from "./daemoncheck.bodies.js";

/* ------------------------------------------------------------------ *
 * What a plugin may add to a machine
 *
 * ⚠ **The section above sweeps what this repository *ships*, and this one sweeps
 * what a machine may be *told about*. They are deliberately not merged.** That
 * one is a transcription of four measured adapter answers into a 28-cell matrix,
 * and its value is exactly that both sides were written down by hand — a sweep
 * that computes both halves passes whenever both are wrong, which this file names
 * as its own failure mode. This one is the opposite shape on purpose: a synthetic
 * catalogue, driven as a **property**, because there is nothing measured to
 * transcribe and never will be. What a plugin names is somebody else's binary at
 * somebody else's endpoint.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a plugin may add to a machine\n");
{
  const { parseManifest, isContributedId, contributedId, MAX_PLUGIN_HARNESSES, MAX_PLUGIN_SYSTEMS } = await import(
    "../src/plugins/manifest.js"
  );
  const { Contributions } = await import("../src/plugins/contributions.js");
  type Installed = Parameters<typeof Contributions.prototype.refresh>[0][number];
  const { hostable, routedModelNaming, systemSecretFor, BUILTIN_CATALOGUE, SYSTEM_IDS } = await import("../src/acp/systems.js");
  const { SESSION_SCOPED_ENV, AGENT_IDS, AGENT_LOGIN, resolveAgent } = await import("../src/acp/agents.js");
  const { PLUGIN_API_VERSION } = await import("../src/plugins/protocol.js");

  /** A manifest holding whatever `contributes` is handed, at the current rung. */
  const withContributes = (contributes: unknown, scopes: string[] = ["harness", "system"]): ReturnType<typeof parseManifest> =>
    parseManifest(
      JSON.stringify({ id: "acme", name: "Acme", version: "1.0.0", api: PLUGIN_API_VERSION, scopes, contributes }),
    );
  const said = (contributes: unknown, scopes?: string[]): string => {
    const answer = withContributes(contributes, scopes);
    return answer.ok ? "ok" : answer.message;
  };

  const HARNESS = { id: "gemini", name: "Gemini", command: "gemini", args: ["acp"], envNames: ["GEMINI_API_KEY"] };
  const SYSTEM = {
    id: "groq",
    name: "Groq",
    apiType: "anthropic",
    baseUrl: "https://api.groq.com/anthropic",
    authHeader: { name: "authorization", prefix: "Bearer " },
    models: [{ id: "llama-4", name: "Llama 4" }],
  };
  const both = { harnesses: [HARNESS], systems: [SYSTEM] };

  check("a plugin that adds a harness and a provider", said(both), "ok");

  /* ---------------------------------------------------------------- *
   * ⭐ The machine asks the harness itself, rather than waiting to be told
   *
   * Reported: a plugin was installed, its harness was offered, and the daemon did
   * not know it would not start until somebody pressed Start and paid a worktree
   * for the answer. The record of a refused start is written by `Session.start`,
   * so what was missing was not a mechanism but an *occasion* — nothing ever
   * started that harness on the machine's own initiative.
   *
   * `probeContributed` fires the existing capability read, which is a real
   * handshake and a real `session/new`. Nothing reads its result: whichever way it
   * goes, the answer is on `GET /agents` before anybody taps anything.
   *
   * ⚠ **What is asserted is the *occasions*, since the call is detached and every
   * outcome is swallowed.** Three that must probe and three that must not, and the
   * three that must not are the interesting half: remove and disable have nothing
   * to ask about, and boot would put a spawn per contributed harness in front of
   * `autoResume`, which is already starting an agent per interrupted session.
   * ---------------------------------------------------------------- */
  {
    const { PluginHost } = await import("../src/plugins/host.js");
    const asked: string[] = [];
    const ask = {
      capabilities: (agent: string) => {
        asked.push(agent);
        // Refusing is the interesting outcome and the one this exists to provoke;
        // the host must swallow it, because no request is waiting on it.
        return Promise.reject(new Error("gemini rejected session/new: authentication required."));
      },
    } as never;
    const PROBE_SERVER = "export async function settings() { return { title: null, blocks: [] }; }";
    const probeStores = openStores({ path: join(tmp("probe-db-"), "d.db"), instanceId: "i_probe" });
    const probeRegistry = {
      watchSessions: () => () => {},
      list: () => [],
      get: () => undefined,
      sessionRuntime: { forgetStartRefusal: () => {}, forgetAvailability: () => {} },
    } as unknown as SessionRegistry;
    const probeRoot = join(tmp("probe-root-"), "plugins");
    const probeHost = await PluginHost.open({
      root: probeRoot,
      records: probeStores.plugins,
      data: probeStores.pluginData,
      registry: probeRegistry,
      api: { git: hostGit, ask },
      timeouts: { start: 3_000, invoke: 3_000 },
    });
    const manifest = JSON.stringify({
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      api: PLUGIN_API_VERSION,
      scopes: ["harness"],
      contributes: { harnesses: [HARNESS] },
    });
    // The capability read is fired and not awaited, so a tick has to pass before
    // the array holds anything — the same shape the ask-runner's own park uses.
    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    };

    const put = async (version: string): Promise<void> => {
      await probeHost.install({
        body: bodyOf(tarOf({ "plugin.json": manifest.replace("1.0.0", version), "server.js": PROBE_SERVER })),
        name: "p.tar.gz",
      });
      await settle();
    };

    await put("1.0.0");
    check("installing a plugin asks its harness whether it starts", asked, ["acme:gemini"]);

    asked.length = 0;
    await put("1.1.0");
    check("and so does updating it, since the program may be a different one", asked, ["acme:gemini"]);

    asked.length = 0;
    await probeHost.setEnabled("acme", false);
    await settle();
    check("switching it off asks nothing, there being nothing to start", asked, []);

    await probeHost.setEnabled("acme", true);
    await settle();
    check("and switching it on asks again", asked, ["acme:gemini"]);

    asked.length = 0;
    await probeHost.remove("acme");
    await settle();
    check("removing it asks nothing", asked, []);

    /*
     * ⚠ **And a boot does not**, which is the exclusion worth pinning rather than
     * the inclusions. A restart deliberately forgets what was measured — the
     * record is in memory — so a machine that has just come up is honestly
     * ignorant, and one press is what that costs. Probing here instead would put N
     * spawns in front of the resume pass.
     */
    await put("1.2.0");
    asked.length = 0;
    await probeHost.shutdown();
    const rebooted = await PluginHost.open({
      root: probeRoot,
      records: probeStores.plugins,
      data: probeStores.pluginData,
      registry: probeRegistry,
      api: { git: hostGit, ask },
      timeouts: { start: 3_000, invoke: 3_000 },
    });
    await settle();
    check("and a daemon coming up asks nothing either", asked, []);
    await rebooted.shutdown();
  }

  /*
   * ⚠ **The machine-wide ceiling, which nothing drove at all.**
   * `plugin_too_many_contributions` appeared exactly once in this repository — its
   * own `return` in `host.ts` — and `MAX_CONTRIBUTED_HARNESSES` was read by no
   * driver, while the per-plugin siblings `MAX_PLUGIN_HARNESSES`/`MAX_PLUGIN_SYSTEMS`
   * are each driven three times a few hundred lines up. The two are different
   * questions: those bound one manifest, this bounds the *machine*, and only this
   * one has to reason about what is already installed.
   *
   * Which is where the half worth pinning is. `contributionsOver` skips the
   * incumbent — `if (row.id === manifest.id) continue` — so **reinstalling** a
   * plugin on a machine already at the ceiling must not be refused for the
   * contributions it is about to replace. Its own comment calls getting that wrong
   * "the same class of mistake as clearing a target directory before the new build
   * is proven, arrived at through arithmetic". Delete that one line and every other
   * assertion in this file stays green while updating any plugin on a full machine
   * starts answering `plugin_too_many_contributions`; the update case below is what
   * goes red instead, which is this repository's standing rule that a pin is only
   * real once it has been seen to fail.
   */
  {
    const { PluginHost, MAX_CONTRIBUTED_HARNESSES } = await import("../src/plugins/host.js");
    const CEIL_SERVER = "export async function settings() { return { title: null, blocks: [] }; }";
    const ceilStores = openStores({ path: join(tmp("ceiling-db-"), "d.db"), instanceId: "i_ceiling" });
    const ceilRegistry = {
      watchSessions: () => () => {},
      list: () => [],
      get: () => undefined,
      sessionRuntime: { forgetStartRefusal: () => {}, forgetAvailability: () => {} },
    } as unknown as SessionRegistry;
    /*
     * The real catalogue rather than a counter of this driver's own, so what is
     * asserted below is what a machine would actually offer — `PluginHost` calls
     * `refresh` on it after every install, update and remove, and that wiring is
     * the thing a hand-kept tally would stop testing.
     */
    const ceilContributions = new Contributions([]);
    const contributedCount = (): number =>
      ceilContributions.harnessIds().filter((id) => isContributedId(id)).length;
    const ceilHost = await PluginHost.open({
      root: join(tmp("ceiling-root-"), "plugins"),
      records: ceilStores.plugins,
      data: ceilStores.pluginData,
      registry: ceilRegistry,
      contributions: ceilContributions,
      api: { git: hostGit, ask: { capabilities: () => Promise.resolve({}) } as never },
      timeouts: { start: 3_000, invoke: 3_000 },
    });

    /** A plugin contributing `count` harnesses, each with a name of its own. */
    const ceilManifest = (id: string, version: string, count: number): string =>
      JSON.stringify({
        id,
        name: id,
        version,
        api: PLUGIN_API_VERSION,
        scopes: ["harness"],
        contributes: {
          harnesses: Array.from({ length: count }, (_, n) => ({
            id: `h${n}`,
            name: `H${n}`,
            command: "gemini",
            args: ["acp"],
            envNames: [`GEMINI_${n}_API_KEY`],
          })),
        },
      });
    const ceilInstall = async (
      id: string,
      version: string,
      count: number,
    ): Promise<Awaited<ReturnType<typeof ceilHost.install>>> =>
      ceilHost.install({
        body: bodyOf(tarOf({ "plugin.json": ceilManifest(id, version, count), "server.js": CEIL_SERVER })),
        name: `${id}.tar.gz`,
      });
    const ceilCode = (outcome: Awaited<ReturnType<typeof ceilHost.install>>): string =>
      outcome.kind === "refused" ? outcome.code : outcome.kind;
    const ceilMessage = (outcome: Awaited<ReturnType<typeof ceilHost.install>>): string =>
      outcome.kind === "refused" ? outcome.message : `not refused: ${outcome.kind}`;

    // `MAX_PLUGIN_HARNESSES` is 2, so the machine ceiling of 8 is four plugins.
    const perPlugin = 2;
    const plugins = MAX_CONTRIBUTED_HARNESSES / perPlugin;
    for (let n = 0; n < plugins; n += 1) {
      check(
        `filling the machine to its ceiling, plugin ${n + 1} of ${plugins}`,
        ceilCode(await ceilInstall(`fill${n}`, "1.0.0", perPlugin)),
        "ok",
      );
    }

    /*
     * At the ceiling rather than past it — the acceptance that makes the refusal
     * below a bound rather than a blanket, the same pairing every other bound in
     * this file is driven with.
     */
    check(
      "the machine is at its ceiling and not over it",
      contributedCount(),
      MAX_CONTRIBUTED_HARNESSES,
    );

    check(
      "one contribution past the ceiling is refused",
      ceilCode(await ceilInstall("over", "1.0.0", 1)),
      "plugin_too_many_contributions",
    );
    check(
      "and the refusal names the ceiling rather than blaming the plugin",
      ceilMessage(await ceilInstall("over", "1.0.0", 1)),
      `this machine already has ${MAX_CONTRIBUTED_HARNESSES} agents added by plugins, which is as many as it will run`,
    );
    check(
      "and nothing was installed for it",
      ceilStores.plugins.list().some((one) => one.id === "over"),
      false,
    );

    /*
     * ⚠ **The one that goes red if the incumbent skip is removed.** The machine is
     * full; this plugin already owns two of those eight, and is replacing them with
     * two more. Counting its own incumbent contributions would put the arithmetic at
     * ten and refuse an ordinary update.
     */
    check(
      "updating a plugin on a machine already at the ceiling is not refused",
      ceilCode(await ceilInstall("fill0", "1.1.0", perPlugin)),
      "ok",
    );
    check(
      "and the update really replaced the row rather than adding one",
      ceilStores.plugins.list().find((one) => one.id === "fill0")?.version,
      "1.1.0",
    );
    check(
      "and the machine is still exactly at its ceiling afterwards",
      contributedCount(),
      MAX_CONTRIBUTED_HARNESSES,
    );

    /*
     * And removing one makes room again, which is what says the ceiling counts what
     * is installed now rather than what has ever been installed.
     */
    await ceilHost.remove("fill0");
    check(
      "removing a plugin makes room under the ceiling",
      ceilCode(await ceilInstall("over", "1.0.0", perPlugin)),
      "ok",
    );
    await ceilHost.shutdown();
  }

  /*
   * ⚠ **The rung, and it is v3's shape rather than v2's.** `readContributions`
   * reads the keys it knows and ignores the rest, so without this an `api: 4`
   * manifest holding a `harnesses` block installs cleanly on every daemon and
   * contributes nothing — and unlike a lost `refreshMs` there is no degraded half
   * of the feature left over, because the harness *is* the plugin.
   */
  const atApi = (api: number): string => {
    const answer = parseManifest(
      JSON.stringify({ id: "acme", name: "Acme", version: "1.0.0", api, scopes: ["harness"], contributes: { harnesses: [HARNESS] } }),
    );
    return answer.ok ? "ok" : answer.message;
  };
  check("declared below the rung it needs", atApi(4).includes("need plugin API 5"), true);
  check("and at it", atApi(5), "ok");
  /*
   * ⚠ **And the gate fires on a *non-empty* block, which is what keeps
   * `parseManifest` idempotent over its own output.** It normalises an absent
   * `contributes` into one carrying `harnesses: []`, and `SqlitePluginRecordStore`
   * re-validates `manifest_json` through it on **every read** — so a presence test
   * refused, on the second read, every plugin it had itself accepted on the first,
   * and every installed plugin vanished from `list()` at the next daemon start.
   */
  check(
    "an empty block at an older rung is not a contribution",
    (() => {
      const answer = parseManifest(
        JSON.stringify({ id: "acme", name: "Acme", version: "1.0.0", api: 1, scopes: [], contributes: { harnesses: [], systems: [] } }),
      );
      return answer.ok;
    })(),
    true,
  );

  /*
   * The scope biconditional, both directions — `net`'s rule applied to the two
   * things on this card that are larger than `net`.
   */
  check("a scope with nothing under it", said({ systems: [SYSTEM] }, ["harness", "system"]).includes("needs contributes.harnesses"), true);
  check("and a block with no scope", said({ harnesses: [HARNESS] }, []).includes('"harness" scope is not declared'), true);
  check("and `contributes` left out entirely, with a scope declared", said(undefined, ["harness"]).includes("needs contributes.harnesses"), true);

  /* ── the argv this daemon will spawn ─────────────────────────────────── */

  const harnessSaid = (patch: Record<string, unknown>): string =>
    said({ harnesses: [{ ...HARNESS, ...patch }] }, ["harness"]);
  check("a command with a path in it", harnessSaid({ command: "/usr/bin/gemini" }).includes("program name"), true);
  check("a command with a capital in it", harnessSaid({ command: "Gemini" }).includes("program name"), true);
  /*
   * ⚠ **Not tidiness.** Naming `claude` here would let a plugin drive the
   * operator's own signed-in CLI, with its credentials, under a row the consent
   * screen labels with the plugin's name — a command line that is true under a
   * heading that is a lie.
   */
  check(
    "a command that is one of this machine's own agents",
    AGENT_IDS.map((id) => harnessSaid({ command: AGENT_LOGIN[id].command }).includes("already runs that program")),
    AGENT_IDS.map(() => true),
  );
  check("and `script`, which is what a login's pty is allocated with", harnessSaid({ command: "script" }).includes("already runs that program"), true);
  check("an argument that is not a string", harnessSaid({ args: [1] }).includes("not a string"), true);
  check("two harnesses with one id", said({ harnesses: [HARNESS, HARNESS] }, ["harness"]).includes("declared twice"), true);
  check(
    "more harnesses than one plugin may add",
    said({ harnesses: Array.from({ length: MAX_PLUGIN_HARNESSES + 1 }, (_, at) => ({ ...HARNESS, id: `h${at}` })) }, ["harness"]).includes(
      `at most ${MAX_PLUGIN_HARNESSES}`,
    ),
    true,
  );
  check(
    "more providers than one plugin may add",
    said({ systems: Array.from({ length: MAX_PLUGIN_SYSTEMS + 1 }, (_, at) => ({ ...SYSTEM, id: `s${at}` })) }, ["system"]).includes(
      `at most ${MAX_PLUGIN_SYSTEMS}`,
    ),
    true,
  );

  /* ── the variables a manifest may claim ──────────────────────────────── */

  check("a variable name that is not one", harnessSaid({ envNames: ["gemini key"] }).includes("in capitals"), true);
  check("this daemon's own prefix", harnessSaid({ envNames: ["REEMOAT_TOKEN"] }).includes("belongs to this daemon"), true);
  /*
   * ⚠ **Swept rather than sampled, and both halves matter.** `LocalRuntime.launch`
   * spreads the routed-model environment **last**, so a manifest naming
   * `CLAUDE_CODE_SESSION_ID` restores exactly the variable `agentEnv()` had just
   * deleted, and `CODEX_SANDBOX_NETWORK_DISABLED` takes the network away from an
   * agent nobody confined. A name added to that list later and not reflected here
   * is the drift this sweep exists to refuse.
   */
  check(
    "every session-scoped variable this daemon strips",
    SESSION_SCOPED_ENV.filter((name) => !harnessSaid({ envNames: [name] }).includes("another agent on this machine reads it")),
    [],
  );
  /*
   * ⚠ **The sharpest one, and it is not hygiene.** `envNames` decides which
   * variable names a *person* is invited to paste a secret into, under a card
   * headed with the plugin's own name. `CLAUDE_CODE_OAUTH_TOKEN` there is a
   * phishing box.
   */
  check(
    "and every credential slot a built-in reads",
    AGENT_IDS.flatMap((id) => AGENT_LOGIN[id].envNames).filter(
      (name) => !harnessSaid({ envNames: [name] }).includes("another agent on this machine reads it"),
    ),
    [],
  );
  check(
    "and the variable that names a built-in's binary",
    harnessSaid({ envNames: ["CLAUDE_CODE_EXECUTABLE"] }).includes("another agent on this machine reads it"),
    true,
  );
  check("routedModelEnv is held to the same rule", harnessSaid({ routedModelEnv: ["ANTHROPIC_API_KEY"] }).includes("another agent"), true);

  /* ── where a pasted key is sent ──────────────────────────────────────── */

  const systemSaid = (patch: Record<string, unknown>): string => said({ systems: [{ ...SYSTEM, ...patch }] }, ["system"]);
  check("a protocol this daemon cannot configure", systemSaid({ apiType: "vertex" }).includes('must be "anthropic" or "openai"'), true);
  /*
   * ⚠ **`routingHeaders` builds `{[name]: prefix + secret}` and hands it straight
   * to `providers/set`.** A CR or an LF in either half is header injection into
   * whatever the adapter does with the pair.
   */
  check(
    "a header name with a newline in it",
    systemSaid({ authHeader: { name: "x-api-key\r\nx-forwarded-for", prefix: "" } }).includes("lower-case header name"),
    true,
  );
  check("a header prefix that is not one", systemSaid({ authHeader: { name: "authorization", prefix: "Bearer \n" } }).includes("short word"), true);
  check("a base URL that is not a URL", systemSaid({ baseUrl: "api.groq.com" }).includes("not a URL"), true);
  check("a base URL carrying a password", systemSaid({ baseUrl: "https://me:pw@api.groq.com/x" }).includes("user name or a password"), true);
  check("a base URL carrying a query", systemSaid({ baseUrl: "https://api.groq.com/x?k=1" }).includes("query or a fragment"), true);
  /*
   * ⚠ **Normalised on the way in, which is what makes the consent comparison
   * mean anything.** A plugin showing `https://api.groq.com` and shipping
   * `https://api.groq.com/../evil` would pass an origin comparison; `new URL`
   * resolves the `..` away here, so what is stored and what is compared is the
   * address a key is actually sent to.
   */
  check(
    "and a base URL is stored resolved rather than as written",
    (() => {
      const answer = withContributes({ systems: [{ ...SYSTEM, baseUrl: "https://api.groq.com/a/../evil/" }] }, ["system"]);
      return answer.ok ? answer.manifest.contributes.systems[0]?.baseUrl : answer.message;
    })(),
    "https://api.groq.com/evil",
  );

  /*
   * ⚠ **`http` is permitted to this machine and this network, and to nothing
   * else — which is the opposite decision from `net`'s allowlist forty lines up in
   * the same file.** That one refuses a local target in a plugin's outbound list,
   * where it is a mistake somebody is approving without reading. This is where the
   * *operator's own pasted key* goes to a model they named, and a private address
   * is the one case where they plainly mean it: Ollama, vLLM, LM Studio.
   */
  const httpTo = (host: string): boolean => systemSaid({ baseUrl: `http://${host}/v1` }) === "ok";
  check(
    "http to this machine and to this network",
    ["127.0.0.1:11434", "localhost:11434", "[::1]:8000", "10.0.0.5:8000", "172.16.3.4", "192.168.1.5:1234", "ollama.local", "box.internal"].map(httpTo),
    [true, true, true, true, true, true, true, true],
  );
  check(
    "and to nowhere else",
    ["api.groq.com", "172.32.0.1", "192.169.1.1", "8.8.8.8", "example.com", "localhost.evil.example"].map(httpTo),
    [false, false, false, false, false, false],
  );
  /*
   * ⚠ **The spellings that dodge a hand-rolled address parser, and the reason
   * none of them dodges this one is `URL` rather than anything written here.**
   * Measured: `new URL` canonicalises every IPv4 form before `hostname` is read —
   * `0x7f.0.0.1`, `2130706433`, `127.1` and `0177.0.0.1` all become `127.0.0.1`,
   * and `010.0.0.1` becomes **`8.0.0.1`** because `010` is octal. So the octal one
   * is correctly *refused* under `http` (it is a public address) and the other
   * three are correctly allowed (they are loopback), which is the opposite of what
   * a regex over the written string would have concluded for all four.
   *
   * Driven rather than reasoned about, because the failure is silent in both
   * directions and this is the parser the whole `http` arm rests on.
   */
  check(
    "an address written the long way round is classified by what it is, not by how it is spelled",
    ["0x7f.0.0.1", "2130706433", "127.1", "0177.0.0.1", "010.0.0.1"].map(httpTo),
    [true, true, true, true, false],
  );
  /*
   * ⚠ **Refused under `https` as well, which every other private address is not.**
   * `169.254.169.254` is cloud instance metadata — a base URL pointed at one is not
   * a self-hosted model somebody stood up, it is a request for this daemon to sign
   * a call to its own host's credentials service with a key the operator pasted.
   */
  check(
    "an address that is never an inference endpoint, under either scheme",
    [
      systemSaid({ baseUrl: "http://169.254.169.254/latest" }).includes("metadata service"),
      systemSaid({ baseUrl: "https://169.254.169.254/latest" }).includes("metadata service"),
      systemSaid({ baseUrl: "https://[fd00:ec2::254]/latest" }).includes("metadata service"),
      // The IPv4-mapped spelling, which `URL` serialises as `[::ffff:a9fe:a9fe]`
      // — so the dotted-quad arm never sees it.
      systemSaid({ baseUrl: "https://[::ffff:169.254.169.254]/latest" }).includes("metadata service"),
    ],
    [true, true, true, true],
  );
  /*
   * ⚠ **And by *name*, which is the arm that was missing and the one that made the
   * `http` allowance and the metadata refusal fail on the same string.** GCP's
   * metadata service is `metadata.google.internal`; `isPrivateHost` returns `true`
   * for anything ending `.internal`, so without a name check a manifest could point
   * a base URL at the host's own credentials service, **in the clear**, and be
   * accepted. This file already disagreed with itself about it — `LOCAL_HOST`
   * refuses `internal` in a `net` allowlist on exactly those grounds.
   */
  check(
    "and a metadata service named rather than numbered, which is how anybody would reach one",
    [
      systemSaid({ baseUrl: "http://metadata.google.internal/computeMetadata/v1" }).includes("metadata service"),
      systemSaid({ baseUrl: "https://metadata.google.internal/computeMetadata/v1" }).includes("metadata service"),
      systemSaid({ baseUrl: "http://metadata/computeMetadata/v1" }).includes("metadata service"),
    ],
    [true, true, true],
  );
  // …while an ordinary name on the same private zone is still reachable, which is
  // the whole point of allowing `.internal` at all.
  check("while a model on the same private zone still is", httpTo("llm.corp.internal"), true);
  /*
   * ⚠ **The reserved-program list has to cover the whole argv, or it is a rule
   * about one word rather than about a command line.** `env claude` and
   * `sh -c "exec claude"` both walk past a check on the program name and spawn the
   * operator's *signed-in* CLI, with its credentials, under a row the consent
   * screen labels with the plugin's name — verbatim what that list says it exists
   * to prevent. It cannot be complete; what it closes is the shape a reader of that
   * card would not think to look for.
   */
  check(
    "a reserved program passed as an argument rather than named as the command",
    [
      harnessSaid({ command: "env", args: ["claude"] }).includes("as an argument"),
      harnessSaid({ command: "sh", args: ["-c", "exec claude"] }).includes("as an argument"),
      harnessSaid({ command: "sh", args: ["--agent=codex"] }).includes("as an argument"),
    ],
    [true, true, true],
  );
  // Word by word rather than by substring: a flag that merely contains a name is
  // not a program being invoked, and refusing it would be this daemon having an
  // opinion about somebody's own command line.
  check("while a flag that merely contains one is left alone", harnessSaid({ args: ["--profile", "codexish"] }), "ok");

  /* ── a provider may only ever name its own plugin's harness ──────────── */

  check(
    "a provider naming a harness this plugin does not add",
    said({ harnesses: [HARNESS], systems: [{ ...SYSTEM, nativeHarness: "claude" }] }).includes("not a harness this plugin adds"),
    true,
  );
  check(
    "and one naming its own",
    said({
      harnesses: [HARNESS],
      systems: [{ ...SYSTEM, baseUrl: null, authHeader: null, nativeHarness: "gemini", loginVia: "gemini", models: [] }],
    }),
    "ok",
  );
  /*
   * The four rules that keep a row from being a control nobody can spend, each of
   * which the built-in table is already swept for one section up.
   */
  check(
    "a provider with no endpoint and no harness of its own",
    said({ systems: [{ ...SYSTEM, baseUrl: null, authHeader: null }] }, ["system"]).includes("needs a nativeHarness"),
    true,
  );
  check("a provider with an endpoint and no header", systemSaid({ authHeader: null }).includes("needs an authHeader"), true);
  check(
    "a routed provider naming no model",
    systemSaid({ models: [] }).includes("at least one model"),
    true,
  );
  check(
    "a keyEnv its own harness does not read",
    said({
      harnesses: [HARNESS],
      systems: [{ ...SYSTEM, baseUrl: null, authHeader: null, nativeHarness: "gemini", loginVia: "gemini", models: [], keyEnv: "OTHER_KEY" }],
    }).includes("does not read"),
    true,
  );

  /* ── ids ─────────────────────────────────────────────────────────────── */

  /*
   * ⚠ **Shape, and shape only — which is the whole reason this predicate is
   * exported.** Membership is asked where nothing has been created yet, so a
   * refusal is free. Shape is asked where the row *is* the memory: `fromRow` and
   * `readCustomAgent` run at boot, and a membership test there would delete every
   * session on a harness whose plugin somebody switched off an hour ago.
   */
  check(
    "what could be an id a plugin contributed",
    ["acme:gemini", "a:b", "acme-tools:gemini-cli"].map(isContributedId),
    [true, true, true],
  );
  check(
    "and what could not",
    ["claude", "", ":", "acme:", ":gemini", "acme:gemini:extra", "Acme:gemini", "acme:GEMINI"].map(isContributedId),
    [false, false, false, false, false, false, false, false],
  );
  check("a built-in id can never be mistaken for one", AGENT_IDS.filter(isContributedId), []);
  check("and the namespace is applied by this daemon rather than written by an author", contributedId("acme", "gemini"), "acme:gemini");

  /* ── the registry these turn into ───────────────────────────────────── */

  const installed = (id: string, contributes: unknown, enabled = true): Installed => {
    /*
     * The scopes follow the blocks, for the reason `manifestWith` gives one
     * section over: each is a biconditional, so a fixture declaring both and
     * carrying one is refused before it reaches the thing under test.
     */
    const holds = (contributes ?? {}) as Record<string, unknown>;
    const scopes = [
      ...(Array.isArray(holds["harnesses"]) && holds["harnesses"].length > 0 ? ["harness"] : []),
      ...(Array.isArray(holds["systems"]) && holds["systems"].length > 0 ? ["system"] : []),
    ];
    const answer = parseManifest(
      JSON.stringify({ id, name: id.toUpperCase(), version: "1.0.0", api: PLUGIN_API_VERSION, scopes, contributes }),
    );
    if (!answer.ok) throw new Error(`${id}: ${answer.message}`);
    return { id, version: "1.0.0", manifest: answer.manifest, enabled, installedAt: 1, updatedAt: 1, source: null };
  };

  const acme = installed("acme", both);
  const machine = new Contributions([acme]);

  check("a contributed harness is namespaced on the way out", machine.harness("acme:gemini")?.command ?? null, "gemini");
  check("and a local id on its own reaches nothing", machine.harness("gemini"), null);
  /*
   * ⚠ **The built-ins first and the contributed after, never interleaved.** This
   * array is the reading order: `GET /systems` maps over it, `groupModels` groups
   * by first appearance rather than by sorting, and `readyFirst` orders each of its
   * two halves by position. A group *appearing* at the end is a group appearing; a
   * group inserted in the middle is every heading below it moving under a thumb.
   */
  check("the built-ins keep their order and the contributed follow", machine.systemIds().slice(0, SYSTEM_IDS.length), [...SYSTEM_IDS]);
  check("and the contributed are after them", machine.systemIds().slice(SYSTEM_IDS.length), ["acme:groq"]);
  check("harnesses the same way", machine.harnessIds(), [...AGENT_IDS, "acme:gemini"]);
  /*
   * ⚠ **Sorted by plugin id rather than by install order**, or the picker's
   * headings depend on the order somebody happened to install things in — which
   * reorders a screen for a reason nobody can see, and differently on two machines
   * holding the same plugins.
   */
  const two = new Contributions([installed("zeta", { systems: [{ ...SYSTEM, id: "z" }] }), installed("alpha", { systems: [{ ...SYSTEM, id: "a" }] })]);
  check("two plugins are ordered by their own ids, not by which arrived first", two.systemIds().slice(SYSTEM_IDS.length), ["alpha:a", "zeta:z"]);

  /*
   * ⚠ **Three answers, because "switched off" and "never existed" have opposite
   * remedies.** A `400` says *fix your request*, which is the truth for an id
   * nobody has ever offered and a lie for one that worked yesterday.
   */
  const off = new Contributions([installed("acme", both, false)]);
  check(
    "a plugin somebody switched off still owns its ids",
    [off.harnessState("acme:gemini"), off.systemState("acme:groq")],
    ["disabled", "disabled"],
  );
  check("and offers neither of them", [off.harness("acme:gemini"), off.system("acme:groq")], [null, null]);
  check("and does not list them", [off.harnessIds().length, off.systemIds().length], [AGENT_IDS.length, SYSTEM_IDS.length]);
  check(
    "while a plugin nobody has is a different answer entirely",
    [machine.harnessState("other:thing"), machine.systemState("other:thing")],
    ["unknown", "unknown"],
  );
  check("and a built-in is never either of those", [machine.harnessState("claude"), machine.systemState("anthropic")], ["enabled", "enabled"]);
  /*
   * ⚠ **The two namespaces are asked separately, and this is the assertion the
   * split of `declaredHarnesses` from `declaredSystems` actually rests on.**
   *
   * One set held both kinds. `harnessState` then answered `"disabled"` for a
   * *provider* id belonging to a plugin that is switched **on**, and `POST
   * /sessions` turns that into `503 harness_unavailable, "this agent comes from a
   * plugin that is switched off on this machine"` — sending somebody to a switch
   * already in the position they want.
   *
   * ⚠ **Nothing above can see that, which is why this is here rather than folded
   * into one of them.** The three assertions before this one ask a *disabled*
   * plugin about its own ids, or ask about an id nobody has ever declared, or ask
   * about a built-in — and a merged set answers all three identically. The only
   * question that separates the two implementations is a live plugin asked about
   * its own id in the *other* table, and `acme` declares one of each.
   */
  check(
    "a live plugin's provider is not a harness it switched off, nor the other way round",
    [machine.harnessState("acme:groq"), machine.systemState("acme:gemini")],
    // `unknown`, not `disabled`: this plugin is enabled, and neither id is a
    // member of the table being asked. There is nothing to switch on.
    ["unknown", "unknown"],
  );

  /*
   * ⚠ **The two sentences a launch can produce, and neither is "not installed".**
   * Sending somebody to `npm i -g` for a package that does not exist is worse than
   * saying nothing, and it is what a fall-through to the built-in arm would have
   * said about a plugin's harness.
   */
  const refusalOf = (id: string, cat: typeof machine): string => {
    try {
      resolveAgent(id, cat);
      return "ok";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  check("a harness whose plugin is switched off", refusalOf("acme:gemini", off).includes("switched off on this machine"), true);
  check("and one whose plugin is gone", refusalOf("acme:gemini", new Contributions([])).includes("no longer installed"), true);
  check("and neither of them mentions installing anything", [refusalOf("acme:gemini", off), refusalOf("acme:gemini", new Contributions([]))].filter((why) => /npm|PATH/.test(why)), []);

  /* ── the matrix, as a property over a catalogue nobody measured ──────── */

  /** A contributed harness that names a model variable, beside a routed provider. */
  const smartRouted = new Contributions([
    installed("acme", { harnesses: [{ ...HARNESS, routedModelEnv: ["GEMINI_MODEL"] }], systems: [SYSTEM] }),
  ]);
  const claudeRouting = { providerId: "main", supported: ["anthropic", "bedrock", "vertex"] };
  const codexRouting = { providerId: "custom-gateway", supported: ["openai"] };
  const geminiRouting = { providerId: "g", supported: ["anthropic"] };
  /*
   * The four measured answers, restated here rather than reached for across the
   * section boundary — the block above owns them as *its* transcription, and a
   * second reader of one variable is how two sections come to disagree about what
   * was measured. What this block does with them is different: it asks whether the
   * cells change, never what they are.
   */
  const routings: Record<string, { providerId: string; supported: string[] } | null> = {
    claude: claudeRouting,
    codex: codexRouting,
    kimi: null,
    opencode: null,
  };

  /*
   * Native short-circuits before `routing` is consulted at all, exactly as kimi at
   * Moonshot does — which is what makes a contributed pair that declares no
   * provider methods runnable.
   */
  const native = new Contributions([
    installed("acme", {
      harnesses: [HARNESS],
      systems: [{ ...SYSTEM, baseUrl: null, authHeader: null, nativeHarness: "gemini", loginVia: "gemini", models: [] }],
    }),
  ]);
  check("a contributed harness on its own contributed provider is native", hostable("acme:gemini", "acme:groq", null, native), null);
  /*
   * ⚠ **And the same provider reached by anything else is refused with the
   * sentence that names the CLI it ships with** — `zen`'s row, arrived at from a
   * manifest. The name in it is the plugin author's, which is the one place this
   * daemon's own refusals carry somebody else's prose.
   */
  check(
    "while nothing else can reach a provider with no endpoint",
    hostable("claude", "acme:groq", claudeRouting, native),
    "Groq can only be reached by the CLI it ships with.",
  );
  check("a contributed harness routed at a contributed provider it can speak to", hostable("acme:gemini", "acme:groq", geminiRouting, smartRouted), null);
  check("a built-in routed at a contributed provider it can speak to", hostable("claude", "acme:groq", claudeRouting, machine), null);
  /*
   * ⚠ **This is the arm `ROUTED_MODEL_ENV`'s own comment predicted, and a plugin
   * adding an openai-shaped provider is the day it fires.** codex answers
   * `supported: ["openai"]`, so it passes the protocol test and dies one line
   * later. The *sentence* is asserted rather than merely `!== null`, so the next
   * reader cannot close it by inventing a codex arm nobody measured — which
   * variable codex reads for a custom-gateway model is a measurement this
   * repository has never taken.
   */
  const openaiShaped = new Contributions([installed("acme", { systems: [{ ...SYSTEM, apiType: "openai" }] })]);
  check(
    "an openai-shaped provider paired with codex is refused on the pinning arm",
    hostable("codex", "acme:groq", codexRouting, openaiShaped),
    "This agent cannot be told which model to use on another system.",
  );
  check(
    "and on the protocol arm where the protocol is the thing that is wrong",
    hostable("codex", "acme:groq", codexRouting, machine),
    "This agent cannot run Groq models.",
  );
  /*
   * ⚠ **A contributed harness that named no model variable cannot host a foreign
   * provider either**, and it is refused by the same arm rather than being allowed
   * to start and quietly run the endpoint's default — the failure with no symptom
   * that folding `ROUTED_MODEL_ENV` into `hostable` exists to prevent.
   */
  const dumb = new Contributions([
    installed("acme", { harnesses: [{ ...HARNESS, id: "plain" }], systems: [SYSTEM] }),
  ]);
  check("a contributed harness with no model variable", hostable("acme:plain", "acme:groq", geminiRouting, dumb), "This agent cannot be told which model to use on another system.");
  const smart = new Contributions([
    installed("acme", { harnesses: [{ ...HARNESS, id: "plain", routedModelEnv: ["GEMINI_MODEL"] }], systems: [SYSTEM] }),
  ]);
  check("and one that named one", hostable("acme:plain", "acme:groq", geminiRouting, smart), null);
  check(
    "and what it names is set to the model, without a template language anywhere",
    routedModelNaming("acme:plain", smart)?.("llama-4") ?? null,
    { GEMINI_MODEL: "llama-4" },
  );
  check("a built-in's naming is untouched by any of this", routedModelNaming("claude", machine)?.("m") ?? null, {
    ANTHROPIC_MODEL: "m",
    ANTHROPIC_CUSTOM_MODEL_OPTION: "m",
  });
  /*
   * ⚠ **And a system this machine no longer offers answers a sentence rather than
   * throwing**, because the pairing is only reachable through something *stored* —
   * a preset whose plugin was removed — and a preset whose only button throws is
   * worse than one whose row says why.
   */
  check("a provider that is no longer here", hostable("claude", "acme:groq", claudeRouting, new Contributions([])), "This provider is no longer on this machine.");
  check("and one whose plugin is switched off", hostable("claude", "acme:groq", claudeRouting, off), "This provider comes from a plugin that is switched off on this machine.");
  /*
   * The whole built-in matrix, asked through a catalogue that also holds
   * contributions — the assertion that adding rows changed no cell of it.
   */
  check(
    "and every built-in pairing answers exactly what it did with no plugins at all",
    AGENT_IDS.flatMap((harness) =>
      SYSTEM_IDS.filter(
        (system) =>
          hostable(harness, system, routings[harness] ?? null, machine) !==
          hostable(harness, system, routings[harness] ?? null, BUILTIN_CATALOGUE),
      ).map((system) => `${harness}/${system}`),
    ),
    [],
  );

  /*
   * ⚠ **One account, one box, across a contributed pair too.** `systemSecretFor`
   * fills a system's gap from its native harness's own credential store, gated on
   * `keyEnv` — and the manifest is refused unless that variable is one the harness
   * actually reads, which is the property that makes this reachable at all.
   */
  const paired = new Contributions([
    installed("acme", {
      harnesses: [{ ...HARNESS, id: "gemini", envNames: ["GEMINI_API_KEY"] }],
      systems: [{ ...SYSTEM, baseUrl: null, authHeader: null, nativeHarness: "gemini", loginVia: "gemini", models: [], keyEnv: "GEMINI_API_KEY" }],
    }),
  ]);
  check(
    "a key saved on a contributed harness answers for its own provider",
    systemSecretFor(
      "acme:groq",
      null,
      (agent): Record<string, string> => (agent === "acme:gemini" ? { GEMINI_API_KEY: "sk-x" } : {}),
      paired,
    ),
    "sk-x",
  );
  check(
    "and a provider this machine does not offer has no key, borrowed or otherwise",
    systemSecretFor("acme:groq", null, () => ({ GEMINI_API_KEY: "sk-x" }), new Contributions([])),
    null,
  );

  /*
   * ⚠ **A secret must never become unreachable because the thing that named it
   * stopped being offered**, and there were two ways that could have happened.
   * `doRemove` sweeps both credential tables on an uninstall — driven in the
   * lifecycle section above — and `DELETE /agent-auth/:agent` removes **before** it
   * validates, so a key pasted under a plugin's harness is still deletable while
   * that plugin is switched off. Without the second, disabling a plugin would have
   * hidden the row from `GET /agent-auth` and refused the one route that could
   * clear it, in the same instant.
   *
   * Read off the source because the order is the property and nothing typed can
   * hold an order — the same shape as `DELETE /systems/:system`'s own assertion.
   */
  {
    const routes = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const del = /app\.delete\("\/agent-auth\/:agent"[\s\S]*?\n  \}\);/.exec(routes)?.[0] ?? "";
    check(
      "the route that clears a pasted credential does not depend on the harness still being offered",
      [
        del.length > 0,
        // It removes whatever was named, without asking the catalogue first…
        /const had = credentials\.list\(\)\.some/.test(del) && /credentials\.remove\(named, envName\);/.test(del),
        // …and it answers what the lookup saw rather than an error, which is the
        // half that was missing: a route that removes and then 400s has neither
        // property, and skips both invalidation steps on the way out.
        /removed: had/.test(del),
        !/return jsonError\(c, 400, "invalid_agent"/.test(del),
        // The slot is still checked where the harness does resolve.
        /agent !== null && !registry\.sessionRuntime\.credentialSlots\(agent\)/.test(del),
      ],
      [true, true, true, true, true],
    );
  }
}

/* ------------------------------------------------------------------ *
 * What an assembled session is actually launched as
 *
 * The section above drives the table and the one below drives the routes. This
 * one drives the only thing either is for: the option bag a `ManagedSession`
 * hands `Session.start` and `Session.resume`, which is where a preset stops
 * being a row and becomes an agent process pointed at somebody's endpoint.
 *
 * ⚠ **Every failure here is silent, which is why it is driven rather than
 * reasoned about.** Lose the system out of the bag and `spawnEnvOf` returns `{}`
 * so no routed-model variable is set, and `applySystem` returns at its first
 * line so `client.routing()`, `hostable` and `providers/set` are never reached —
 * there is no refusal path left to fire. The session opens on the harness's own
 * vendor, account and default model while its row, its snapshot and the tile on
 * screen all go on naming the assembled agent. So the assertions are on what the
 * *agent process* was handed — the environment it was spawned with and the
 * `providers/set` it did or did not receive — and never on the absence of an
 * error, which is exactly what the broken path also produced.
 *
 * ⚠ **The sweep is {empty, non-empty} × {assembled, bare} rather than the one
 * cell that was wrong.** `doResume` has two arms and `start` is a third launch
 * site; the defect was that one of the three wrote its bag out by hand. A matrix
 * is what stops a fourth site being added the same way.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat an assembled session is launched as\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const { SYSTEMS } = await import("../src/acp/systems.js");

  /** One agent process, and everything about the launch that produced it. */
  interface Launch {
    agent: AgentId;
    /** Exactly what `spawnEnvOf` handed the runtime. */
    env: NodeJS.ProcessEnv;
    /** Which arm this was: `session/new` opens a conversation, `session/resume` restores one. */
    how: "opened" | "resumed" | "(neither)";
    /** The base URL `applySystem` configured, or `null` where it configured nothing. */
    routed: string | null;
    /**
     * The conversation-opening call's params, minus the id only a resume sends.
     *
     * The whole of what makes the two arms comparable: `Session.start` and
     * `Session.openResumed` build the same request but for `sessionId`, so an
     * equality between two of these is the assertion that one bag reached both.
     */
    bag: Record<string, unknown> | null;
    /**
     * Every `session/set_config_option` this process was sent, as `id=value`.
     *
     * ⚠ **The only honest reading of a native pin.** A native pairing is named to
     * the agent by this call and by nothing else — `spawnEnvOf` answers `{}` and
     * `applySystem` returns at its first line — so a launch that never sent it
     * still *succeeds*, on the agent's own default, with the row, the chip and the
     * snapshot all naming the model it is not running. The outcome cannot see that
     * and the wire can, which is why the sweep below reads calls rather than
     * results.
     */
    configCalls: string[];
    /** What `providers/set` was given, or `null` where it was never sent. */
    routedHeaders: Record<string, string> | null;
    /**
     * Whether this process's stdin was closed, which is what `AcpClient.close`
     * does first and is the whole of a dispose as seen from out here.
     *
     * Read by the one cell that refuses: a `Session.start` that throws must leave
     * no live agent behind, and "it threw" says nothing at all about that.
     */
    closed: boolean;
  }

  const launches: Launch[] = [];
  let conversations = 0;

  /**
   * What the fake agent publishes as its model control, and what it is on.
   *
   * ⚠ **A `let`, because the third axis of the pin sweep is a CLI that retired a
   * model between the start and the resume.** That is not a corner: the pinned
   * model is a string in a preset somebody saved months ago, and the list is
   * whatever the agent's own binary decided this week — which is exactly why
   * `pinNativeModel` weighs it against the agent standing in front of us rather
   * than against a cache.
   *
   * `{ choices: [] }` publishes **no** model option at all, which is what this rig
   * did for its whole life before the sweep existed. That is the state every
   * assertion above this point was measured in, and it is left as the default so
   * they keep being measured in it — a `modelOption` of `null` is also a real
   * agent (kimi publishes none), so it is not a fixture nobody ships.
   *
   * `current` is deliberately never the pinned model, so "the pin was sent" and
   * "the agent happened to already be there" can never be confused.
   */
  let published: { choices: readonly string[]; current: string } = { choices: [], current: "" };

  /**
   * ACP's `category: "model"` select, in the shape `toConfigOptions` reads.
   *
   * Found by `category` and never by `id`, which is this fleet's standing rule
   * about every agent control and is what `Session.modelOption` implements — so
   * the id here is deliberately not the word "model".
   */
  const modelControl = (current: string, choices: readonly string[]): Record<string, unknown> => ({
    id: "model-picker",
    name: "Model",
    description: null,
    category: "model",
    type: "select",
    currentValue: current,
    options: choices.map((value) => ({ value, name: value, description: null })),
  });

  const spawnRouted = (agent: AgentId, extra: NodeJS.ProcessEnv): AgentProcess => {
    // Copied rather than held: `routedModelEnv` builds a fresh object per launch
    // and nothing else keeps it, so a reference here would still be readable —
    // but a copy is what makes it obvious that this is a record of one spawn.
    const launch: Launch = {
      agent,
      env: { ...extra },
      how: "(neither)",
      routed: null,
      routedHeaders: null,
      bag: null,
      configCalls: [],
      closed: false,
    };
    launches.push(launch);
    /*
     * Per process, exactly as a real agent's config is: a `set_config_option` on
     * one launch must not be visible to the next, or the resume arm of the sweep
     * below would read the start arm's pin as its own and the defect being fixed
     * would still be green.
     */
    let currentModel = published.current;
    const configOptions = (): Record<string, unknown>[] =>
      published.choices.length === 0 ? [] : [modelControl(currentModel, published.choices)];
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        const params = (message["params"] ?? {}) as Record<string, any>;
        const conversation = (how: "opened" | "resumed"): void => {
          launch.how = how;
          const { sessionId: _conversationId, ...rest } = params;
          launch.bag = rest;
        };
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                // Both markers are empty objects, exactly as the real adapters
                // send them: `supportsSessionResume` and `AcpClient.routing`
                // read `!= null` rather than `=== true`, and a `true` here would
                // drive a shape no agent produces.
                agentCapabilities: { sessionCapabilities: { resume: {} }, providers: {} },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.providers.list:
            // `claude-agent-acp` 0.63.0's measured answer, which is what makes
            // `hostable` permit moonshot over this harness at all.
            send({
              jsonrpc: "2.0",
              id,
              result: { providers: [{ providerId: "main", supported: ["anthropic", "bedrock", "vertex"] }] },
            });
            break;
          case acp.methods.agent.providers.set:
            launch.routed = String(params["baseUrl"] ?? "");
            // The other half of "the key travels as a header and never in the
            // environment", recorded so the two can be compared against each
            // other over one launch. Kept as whatever arrived rather than parsed:
            // what is being asserted is where the bytes went, not their shape.
            launch.routedHeaders = { ...((params["headers"] ?? {}) as Record<string, string>) };
            send({ jsonrpc: "2.0", id, result: {} });
            break;
          case acp.methods.agent.session.new:
            conversation("opened");
            conversations += 1;
            send({ jsonrpc: "2.0", id, result: { sessionId: `conv_${conversations}`, modes: null, configOptions: configOptions() } });
            break;
          case acp.methods.agent.session.resume:
            conversation("resumed");
            /*
             * ⚠ **A resume carries the *full* `configOptions`, exactly as
             * `session/new` does**, and this fixture answered `{}` for its whole
             * life. Read off the SDK's `ResumeSessionResponse` and off
             * `claude-agent-acp` 0.63.0's `getOrCreateSession`, which builds one
             * answer for both. An empty answer here is what made every native cell
             * of the sweep below unreachable: with no list, `modelOption` is
             * `null`, `pinNativeModel` takes its "offers no choice" arm, and a
             * resume that pinned nothing looked identical to one that did.
             */
            send({ jsonrpc: "2.0", id, result: { modes: null, configOptions: configOptions() } });
            break;
          case acp.methods.agent.session.setConfigOption:
            launch.configCalls.push(`${String(params["configId"])}=${String(params["value"])}`);
            currentModel = String(params["value"]);
            // The complete option set comes back, which is what ACP defines the
            // response as and what `Session.setConfigOption` re-reads it for.
            send({ jsonrpc: "2.0", id, result: { configOptions: configOptions() } });
            break;
          case acp.methods.agent.session.prompt:
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => {
        // `AcpClient.close` ends stdin first and only escalates if the child does
        // not exit — which this one always does — so this is the only signal a
        // dispose leaves out here.
        launch.closed = true;
        toAgent.end();
      },
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class RoutedRig extends LocalRuntime {
    // `create` asks before it builds anything, and the real answer depends on
    // whether this machine happens to have a `claude` on its PATH.
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "claude", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(agent: AgentId, extra: NodeJS.ProcessEnv = {}): Promise<AgentProcess> {
      return spawnRouted(agent, extra);
    }
    // Without a key `applySystem` refuses one line before `providers/set`, and
    // every routed assertion below would then be green for the wrong reason.
    override systemSecret(): string | null {
      return "sekrit";
    }
  }

  /**
   * What the preset store answers, swung under sessions that are already on it.
   *
   * A `let` rather than a map because there is one preset in this whole section
   * and what is under test is what happens when its *contents* change — which is
   * a thing only `PATCH /custom-agents/:id` can do to a live session.
   */
  let preset: { harness: AgentId; system: SystemId; model: string } | null = {
    harness: "claude",
    system: "moonshot",
    model: "kimi-k2-thinking",
  };
  // Held rather than built inline: the demotion notice the sweep below asserts is
  // an `error` event on the session's own log, and there is no other way in.
  const ownLog = new MemoryEventStore();
  const own = new SessionRegistry(ownLog, null, undefined, new RoutedRig());
  own.setCustomAgents((id) => (id === "ca_assembled" ? preset : null));

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

  /**
   * One launch as one line, which is what makes a three-launch expectation
   * readable as a diff rather than as four separate equalities.
   *
   * `ANTHROPIC_MODEL` is the cheapest proof the bag was not the bare one:
   * `spawnEnvOf` sets `ROUTED_MODEL_ENV`'s variables only when the options carry
   * **both** a system and a model, so a `-` here is a bag that lost the pairing.
   * `routed` is the other half and cannot be derived from it — the environment is
   * set before the process starts and `providers/set` happens after, so a launch
   * with the variable and no base URL is a distinct, reachable failure.
   */
  const summary = (one: Launch | undefined): string =>
    one === undefined
      ? "(no launch)"
      : `${one.agent} ${one.how} model=${one.env["ANTHROPIC_MODEL"] ?? "-"} routed=${one.routed ?? "-"}`;

  /**
   * One session through both arms of `doResume`, in order, and every launch it
   * caused.
   *
   * The first resume is taken at `turnCounter === 0`, which is what makes
   * `conversationKnownEmpty()` true: that arm **opens** a conversation rather
   * than resuming one, and it is the arm the defect lived in. One turn later the
   * same session takes the other. Driving one session rather than two is what
   * lets the two bags be compared directly — they share a worktree, so the only
   * field that may differ is the one a resume adds.
   */
  const bothArms = async (customAgent: string | null): Promise<Launch[]> => {
    launches.length = 0;
    const managed = await own.create({ agent: "claude", cwd: tmp("assembled-"), customAgent });
    await own.stop(managed.id);
    await managed.resume(5_000);
    check(`${customAgent ?? "bare"}: a turn is accepted before the second stop`, managed.prompt("hello").kind, "accepted");
    await settle();
    await own.stop(managed.id);
    await managed.resume(5_000);
    await own.stop(managed.id);
    return launches.slice();
  };

  const assembled = await bothArms("ca_assembled");
  check("an assembled session: the start, the empty arm and the resume arm", assembled.map(summary), [
    "claude opened model=kimi-k2-thinking routed=https://api.moonshot.ai/anthropic",
    "claude opened model=kimi-k2-thinking routed=https://api.moonshot.ai/anthropic",
    "claude resumed model=kimi-k2-thinking routed=https://api.moonshot.ai/anthropic",
  ]);
  /*
   * ⚠ **The assertion a fourth launch site would break.** Both arms are handed
   * one bag by `ManagedSession.launchOptions`, and a resume adds `agentSessionId`
   * and nothing else — so the request that reaches the agent is equal on every
   * other field. This is what the hand-written arm could not have satisfied.
   */
  /**
   * Everything a launch is, minus the one thing the two arms are allowed to
   * disagree about.
   *
   * `bag` alone is not enough and was measured not to be: the ACP request carries
   * `cwd`, `mcpServers` and `_meta`, and losing the system out of the option bag
   * changes **none** of them — it changes the spawn environment and whether
   * `providers/set` was sent, which is why those travel here too.
   */
  const shapeOf = (one: Launch | undefined): unknown =>
    one === undefined ? null : { agent: one.agent, env: one.env, routed: one.routed, bag: one.bag };
  check("and both arms hand the agent the same bag but for the conversation id", shapeOf(assembled[1]), shapeOf(assembled[2]));
  // The expectations above are literals on purpose — a change to any cell shows
  // as a diff rather than as a count — so this is the one line that reads the
  // table, which is what stops those three strings agreeing with each other and
  // with nothing else.
  check("and the endpoint it was pointed at is the table's own", assembled[2]?.routed, SYSTEMS.moonshot.baseUrl);

  /*
   * ⚠ **The key travels as a header and never in the environment, driven over a
   * launch that really carries one.** `RoutedRig.systemSecret` answers `sekrit`,
   * so these three launches are the only place in this file where a secret is
   * genuinely in play — the agent process was spawned with one environment and
   * sent `providers/set` with the other, and this is the disjointness between
   * them. An agent runs as this uid and can print its own environment into a
   * transcript that is appended to the log and rendered in a browser, which is the
   * accident `agentEnv`'s strip exists to prevent and the reason
   * `ROUTED_MODEL_ENV` carries a model id and nothing else.
   *
   * ⚠ **This assertion used to sit beside the table, over `routedModelEnv`'s
   * return value, and could not fail.** That function is pure in a harness, a
   * system and a model id; the driver handed it three literals, none of them a
   * credential, so no implementation short of one hardcoding the string would have
   * gone red. Both halves are asserted here instead — that the secret *is* in the
   * headers, and that it is in no environment value — because either alone passes
   * against a daemon that sends it nowhere at all.
   */
  const carried = assembled.map((one) => one.routedHeaders?.["authorization"] ?? null);
  check("every routed launch signed its traffic with the stored key", carried, [
    "Bearer sekrit",
    "Bearer sekrit",
    "Bearer sekrit",
  ]);
  check(
    "and not one of them put it in the environment the agent can print",
    assembled.flatMap((one) =>
      Object.entries(one.env).flatMap(([name, value]) => (String(value).includes("sekrit") ? [name] : [])),
    ),
    [],
  );
  check("which is a bag rather than nothing at all", assembled[1]?.bag === null || assembled[1]?.bag === undefined, false);

  const bare = await bothArms(null);
  check("a bare harness takes both arms with nothing routed", bare.map(summary), [
    "claude opened model=- routed=-",
    "claude opened model=- routed=-",
    "claude resumed model=- routed=-",
  ]);
  check("and its two arms agree with each other too", shapeOf(bare[1]), shapeOf(bare[2]));

  /* ---------------------------------------------------------------- *
   * A preset re-pointed at another harness, under a live session
   * ---------------------------------------------------------------- */

  launches.length = 0;
  const live = await own.create({ agent: "claude", cwd: tmp("repointed-"), customAgent: "ca_assembled" });
  check("a session on a preset starts routed", live.prompt("hello").kind, "accepted");
  await settle();
  await own.stop(live.id);
  check("and one turn puts it on the resume arm for the rest of this block", launches.map(summary), [
    "claude opened model=kimi-k2-thinking routed=https://api.moonshot.ai/anthropic",
  ]);

  /**
   * Resume, and say whether it threw rather than letting a rejection end the run.
   *
   * The loud half of this defect is a resume that fails *for ever*, so "did it
   * come back at all" has to be an assertion rather than the shape of the driver.
   */
  const resumed = async (): Promise<string> => {
    launches.length = 0;
    return live
      .resume(5_000)
      .then(() => "(resumed)", (error: unknown) => (error instanceof Error ? error.name : String(error)));
  };

  /*
   * ⚠ **The loud repro.** `{codex, openai, gpt-5-codex}` over a claude session:
   * OpenAI has no routed endpoint, so `hostable("claude", "openai", …)` refuses,
   * `applySystem` throws `SystemRoutingError` and the route answers `502
   * system_not_routable` — on this resume and on every resume after it, with
   * nothing on any screen connecting it to the edit that caused it. A session
   * cannot change vendor underneath itself, so the honest answer is the harness
   * its own `agent` column names.
   */
  preset = { harness: "codex", system: "openai", model: "gpt-5-codex" };
  check("re-pointing its preset at another harness does not strand the session", await resumed(), "(resumed)");
  check("it comes back on the harness it was started with, and bare", launches.map(summary), [
    "claude resumed model=- routed=-",
  ]);

  /*
   * ⚠ **The quiet repro, which is the one with no symptom.** `{kimi, moonshot,
   * kimi-k2-thinking}` is a pairing `hostable` **permits** — over kimi. Spread
   * over the claude session that named this preset it starts, looks right, and
   * runs the claude harness against Moonshot's endpoint on Moonshot's model,
   * while the preset, the tile and the glyph all say Kimi Code. Nothing refuses
   * it, so the only assertion that can catch it is on the launch itself.
   */
  await own.stop(live.id);
  preset = { harness: "kimi", system: "moonshot", model: "kimi-k2-thinking" };
  check("and a re-pointing the matrix permits is demoted just as flatly", await resumed(), "(resumed)");
  check("rather than pointing this harness at somebody else's endpoint", launches.map(summary), [
    "claude resumed model=- routed=-",
  ]);

  /*
   * ⚠ **The guard is a comparison and not a blanket disable.** Without this, a
   * mistake that made `assembled` answer `{}` for every session would leave every
   * assertion above green and every assembled session silently bare — which is
   * the original defect, arrived at from the other side. The model is a
   * *different* one from the session's start, so this also says the preset is
   * re-read at the launch rather than remembered from it.
   */
  await own.stop(live.id);
  preset = { harness: "claude", system: "moonshot", model: "kimi-k2-0905-preview" };
  check("while a preset still naming this harness is applied", await resumed(), "(resumed)");
  check("at whatever it holds now, read fresh at the launch", launches.map(summary), [
    "claude resumed model=kimi-k2-0905-preview routed=https://api.moonshot.ai/anthropic",
  ]);

  /*
   * The deleted-preset arm, unchanged and pinned here rather than elsewhere: it
   * sits one line above the harness comparison in `ManagedSession.assembled`, the
   * two are the same demotion for two different facts about the world, and a
   * reordering that swallows one swallows both.
   */
  await own.stop(live.id);
  preset = null;
  check("and a preset deleted underneath it still degrades rather than failing", await resumed(), "(resumed)");
  check("to the same bare harness, by the same rule", launches.map(summary), ["claude resumed model=- routed=-"]);

  /* ---------------------------------------------------------------- *
   * Which model the agent is actually put on
   *
   * ⚠ **{start, resume} × {native, routed} × {the agent still offers it, the
   * agent no longer does}, driven as a sweep and not at the cell that was
   * wrong.** `Session.openResumed` never called `pinNativeModel`, so a resumed
   * session on a **native** pairing was named to the agent by nothing at all:
   * `spawnEnvOf` answers `{}` for a native system and `applySystem` returns at its
   * first line for one, so there was no other mechanism and no refusal left to
   * fire. The session came back on the agent's own default while the row, the chip
   * and the snapshot all went on naming the assembled agent. Measured against a
   * fake peer publishing a `category: "model"` select: start sent
   * `set_config_option`, resume sent nothing.
   *
   * ⚠ **Every cell reads the calls on the wire, never the outcome.** Both resumes
   * *succeed*, before the fix and after it — that is the whole of why the defect
   * survived a green driver — so an assertion on "did it come back" would be the
   * false coverage Q2.215 already names once. What separates them is a
   * `session/set_config_option` that was or was not sent, which is why `Launch`
   * grew `configCalls`.
   *
   * ⚠ **The third axis is the one carrying a decision, and the two ends of it
   * disagree on purpose.** A start refuses an un-pinnable model: nothing exists
   * yet to strand, and carrying on would be a session running a model nobody
   * chose. A resume must not, because the conversation is already there and a
   * model the CLI has since retired would make every resume of it fail for ever —
   * the permanent refusal Q2.216 chose a demotion over. So the resume comes back
   * *and says so*, in the transcript, and a driver asserting only one of the two
   * records nothing about the asymmetry. Silence is the other trap and it is the
   * defect above relocated, so the notice is counted rather than merely allowed.
   * ---------------------------------------------------------------- */

  /** One launch, read as the two doors a model can arrive through. */
  const pinOf = (one: Launch | undefined): string =>
    one === undefined
      ? "(no launch)"
      : `${one.how} config=[${one.configCalls.join(" ")}] env=${one.env["ANTHROPIC_MODEL"] ?? "-"} routed=${one.routed ?? "-"}`;

  /** The demotion notices on a session's own log, in order. */
  const notices = (id: string): { message: string; model: unknown }[] =>
    ownLog.read(id, -1, 1000, Number.MAX_SAFE_INTEGER).flatMap(({ event }) => {
      if (event.type !== "error") return [];
      const data = event.data as { code?: unknown; model?: unknown } | null;
      return data?.code === "model_not_pinned" ? [{ message: event.message, model: data.model }] : [];
    });

  /**
   * One column of the sweep: four cells over one pairing.
   *
   * The three resume cells share a session on purpose — a resume needs something
   * to resume, and "the agent retired the model between the start and the resume"
   * is the real sequence rather than two unrelated launches. The fourth cannot
   * share it: a start that refuses never produces a session at all, which is the
   * asymmetry being asserted.
   *
   * A turn is sent before the first stop because `conversationKnownEmpty()` is
   * true at `turnCounter === 0` and that arm **opens** a conversation rather than
   * resuming one — the empty arm is already driven above, and what is wanted here
   * is `session/resume` itself.
   */
  const column = async (
    pairing: { harness: AgentId; system: SystemId; model: string },
    offering: readonly string[],
    withoutIt: readonly string[],
    /** What the agent says it is *on* once the model has left its list. */
    currentWhenGone = "sonnet",
  ): Promise<{ lines: string[]; id: string }> => {
    preset = { ...pairing };

    published = { choices: offering, current: "sonnet" };
    launches.length = 0;
    const managed = await own.create({ agent: pairing.harness, cwd: tmp("pinned-"), customAgent: "ca_assembled" });
    const lines = [`start, offered:  ${pinOf(launches[0])}`];
    check(`${pairing.system}: a turn is accepted before the model is retired`, managed.prompt("hi").kind, "accepted");
    await settle();
    await own.stop(managed.id);

    launches.length = 0;
    await managed.resume(5_000);
    await settle();
    lines.push(`resume, offered: ${pinOf(launches[0])} notices=${notices(managed.id).length}`);
    await own.stop(managed.id);

    published = { choices: withoutIt, current: currentWhenGone };
    launches.length = 0;
    const came = await managed
      .resume(5_000)
      .then(() => "(resumed)", (error: unknown) => (error instanceof Error ? error.name : String(error)));
    // The queue is drained by `startIdleDrain`, which is armed on adoption — so
    // the notice is in the log a tick after the resume resolves rather than
    // synchronously with it.
    await settle();
    lines.push(`resume, gone:    ${came} ${pinOf(launches[0])} notices=${notices(managed.id).length}`);
    await own.stop(managed.id);

    launches.length = 0;
    const refused = await own
      .create({ agent: pairing.harness, cwd: tmp("pinned-"), customAgent: "ca_assembled" })
      .then(() => "(started)", (error: unknown) => (error instanceof Error ? error.name : String(error)));
    lines.push(`start, gone:     ${refused} ${pinOf(launches[0])} disposed=${launches[0]?.closed ?? false}`);
    return { lines, id: managed.id };
  };

  /*
   * `{claude, anthropic, opus}` — the pairing `SYSTEMS.anthropic` calls native, so
   * there is no `providers/set` and no `ROUTED_MODEL_ENV` and the whole of the
   * routing is one `set_config_option`. The published list does not start on the
   * pinned model, so "opus" in `config=[…]` can only have got there by being sent.
   */
  const native = await column({ harness: "claude", system: "anthropic", model: "opus" }, ["opus", "sonnet"], ["sonnet"]);
  check("a native pairing, across both launches and both list states", native.lines, [
    "start, offered:  opened config=[model-picker=opus] env=- routed=-",
    "resume, offered: resumed config=[model-picker=opus] env=- routed=- notices=0",
    "resume, gone:    (resumed) resumed config=[] env=- routed=- notices=1",
    "start, gone:     SystemRoutingError opened config=[] env=- routed=- disposed=true",
  ]);
  /*
   * ⚠ **What the notice *says*, because "not silent" is a claim about a sentence.**
   * Both models are in it — the one that was asked for and the one the session
   * came back on — and without the second half the row says a conversation is
   * running something unnamed. A typo here is how the demotion becomes silent
   * again while the count above stays at one.
   */
  check("and the demotion names both models, and its own code", notices(native.id), [
    {
      message:
        'claude has no model called "opus" — it offers sonnet. ' +
        "The conversation was resumed anyway, running sonnet.",
      model: "opus",
    },
  ]);

  /*
   * ⚠ **The same pairing with one cell changed: the agent no longer *lists* the
   * model and is nevertheless still *on* it.** Every case above moves `current` to
   * something else, so the whole "gone" column was only ever driven as a real
   * demotion — and the sentence that shipped was the one nothing had produced.
   *
   * Reported from the app, verbatim: *"opencode has no model called
   * `opencode/hy3-free` — it offers … and 352 more. The conversation was resumed
   * anyway, running opencode/hy3-free."* Both halves were true and the row was
   * still wrong: the clause `openResumed` appends names what the session came back
   * on, and it came back on exactly what the preset asked for. There was nothing to
   * announce.
   *
   * ⚠ **Four cells, and the last two are the fix.** `resume, gone` resumes with
   * **nothing sent** (`config=[]`) and **no notice** — the pin's job is that the
   * session runs the model, and it already does, so there is neither work nor news.
   * `start, gone` is the half that is easy to forget: `Session.start` turns this
   * same refusal into `SystemRoutingError`, so before the fix a preset whose model
   * the agent is *currently running* answered a permanent `502` — which is exactly
   * the stranding Q2.216 chose a demotion over, reached from the other side.
   */
  const still = await column({ harness: "claude", system: "anthropic", model: "opus" }, ["opus", "sonnet"], ["sonnet"], "opus");
  check("a model the agent no longer offers but is already running", still.lines, [
    "start, offered:  opened config=[model-picker=opus] env=- routed=-",
    "resume, offered: resumed config=[model-picker=opus] env=- routed=- notices=0",
    "resume, gone:    (resumed) resumed config=[] env=- routed=- notices=0",
    "start, gone:     (started) opened config=[] env=- routed=- disposed=false",
  ]);
  check("and it says nothing, because there is no demotion to report", notices(still.id), []);

  /*
   * `{claude, moonshot, kimi-k2-thinking}` — routed, and the regression fence for
   * the fix above. The model is named at spawn and validated by the endpoint, so
   * there is **no** "gone" for it at all: the last two cells publish a list this
   * model is not in, and the correct answer is that nothing changes. A native pin
   * leaking into this column would show as a `config=[…]` that is not empty, and
   * a refusal leaking in would show as the fourth line refusing.
   */
  const routed = await column(
    { harness: "claude", system: "moonshot", model: "kimi-k2-thinking" },
    ["kimi-k2-thinking", "sonnet"],
    ["opus", "sonnet"],
  );
  const endpoint = SYSTEMS.moonshot.baseUrl;
  check("a routed pairing takes neither the pin nor the refusal", routed.lines, [
    `start, offered:  opened config=[] env=kimi-k2-thinking routed=${endpoint}`,
    `resume, offered: resumed config=[] env=kimi-k2-thinking routed=${endpoint} notices=0`,
    `resume, gone:    (resumed) resumed config=[] env=kimi-k2-thinking routed=${endpoint} notices=0`,
    `start, gone:     (started) opened config=[] env=kimi-k2-thinking routed=${endpoint} disposed=false`,
  ]);
  check("and says nothing in the transcript about a model it never asked the agent for", notices(routed.id), []);

  /*
   * `{opencode, openrouter, qwen/qwen3-coder}` — native, like the first column,
   * and the only pairing in the fleet where the id that was **stored** is not the
   * id that is **sent**.
   *
   * ⚠ **The published list here is spelled the way a real agent spells it.**
   * Measured 2026-08-27: a keyed opencode publishes 356 ids under
   * `openrouter/…`, while everything upstream of this — the picker, the route,
   * the `custom_agents` row — carries the endpoint's own `qwen/qwen3-coder`. So
   * the fixture offers only the prefixed spelling and the preset names only the
   * bare one, which means the pin can only succeed by respelling and the cell
   * would be green for the wrong reason if either half were written the same way.
   *
   * The "gone" cells are the other direction: a list that carries the *bare*
   * spelling is a list this pairing must refuse, because that is not a name
   * opencode answers to. Without it a respelling that quietly fell back to the
   * unprefixed id would pass every cell above.
   */
  const prefixed = await column(
    { harness: "opencode", system: "openrouter", model: "qwen/qwen3-coder" },
    ["openrouter/qwen/qwen3-coder", "openrouter/z-ai/glm-5.3"],
    ["qwen/qwen3-coder", "openrouter/z-ai/glm-5.3"],
  );
  check("a native pairing whose ids the harness respells", prefixed.lines, [
    "start, offered:  opened config=[model-picker=openrouter/qwen/qwen3-coder] env=- routed=-",
    "resume, offered: resumed config=[model-picker=openrouter/qwen/qwen3-coder] env=- routed=- notices=0",
    "resume, gone:    (resumed) resumed config=[] env=- routed=- notices=1",
    "start, gone:     SystemRoutingError opened config=[] env=- routed=- disposed=true",
  ]);
  /*
   * ⚠ **The refusal names the spelling that was actually looked for.** Saying
   * `"qwen/qwen3-coder"` here would be true of the store and useless on screen:
   * the list beside it is prefixed, so a reader comparing the two would be looking
   * for a string that was never going to be in it.
   */
  check("and its refusal names the id it asked for, not the one it was given", notices(prefixed.id).slice(-1), [
    {
      message:
        'opencode has no model called "openrouter/qwen/qwen3-coder" — ' +
        "it offers qwen/qwen3-coder, openrouter/z-ai/glm-5.3. " +
        "The conversation was resumed anyway, running sonnet.",
      model: "qwen/qwen3-coder",
    },
  ]);

  // Back to the state the block was left in, so nothing below inherits a fixture.
  published = { choices: [], current: "" };

  await own.shutdown();

  /*
   * The resolver's third field, read off the one caller that fills it in.
   *
   * `harness` is the only member of the triple with no downstream *use* —
   * `ManagedSession.assembled` compares it and then throws it away — so nothing
   * else in this file, or in the fleet, would notice it going missing from
   * `scripts/daemon.ts`'s thunk. Everything above would keep passing on this
   * file's own stub.
   */
  const wiring = readFileSync(new URL("../scripts/daemon.ts", import.meta.url), "utf8");
  check(
    "and the daemon's own thunk hands the harness back beside the pair",
    /setCustomAgents\(\(id\) => \{[\s\S]{0,400}?harness: one\.harness[\s\S]{0,200}?\}\);/.test(wiring),
    true,
  );
  /*
   * ⚠ **And both setters run *before* `restore()`, which is an ordering no
   * in-process driver can reach.** It lives in the entry script, so it is read off
   * the same text the assertion above already holds.
   *
   * `restore()` rebuilds every persisted session, and `ManagedSession.assembled`
   * reads `custom_agents` through a resolver that validates the harness and
   * **drops** the row rather than repairing it. With the catalogue and the preset
   * thunk still unset at that moment, every preset on a contributed harness is
   * dropped and every session on one comes back demoted to the bare harness it was
   * started with — with `autoResume` firing inside the window, so the demotion is
   * live before anybody looks. Nothing throws and nothing is logged; the rows, the
   * snapshots and the tiles all go on naming the assembled agent.
   *
   * Indices rather than a regex spanning all three, because what is being asserted
   * is an order and a regex would also have to survive anything anybody puts
   * between them.
   */
  check(
    "and the catalogue and the presets are both wired before the restore",
    [
      wiring.indexOf("registry.setMachineCatalogue(") < wiring.indexOf("registry.restore("),
      wiring.indexOf("registry.setCustomAgents(") < wiring.indexOf("registry.restore("),
      // Or two -1s would compare as an order and pass with the calls deleted.
      [wiring.indexOf("registry.setMachineCatalogue("), wiring.indexOf("registry.setCustomAgents("), wiring.indexOf("registry.restore(")].every((at) => at > 0),
    ],
    [true, true, true],
  );
}
