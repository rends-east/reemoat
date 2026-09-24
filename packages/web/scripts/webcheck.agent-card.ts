import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

/** One vocabulary for every flow's sentences: other drivers import this rather than keep a copy. */
export const JARGON_WORDS =
  /\bPATH\b|_KEY|_TOKEN|session\/new|-32000|~\/|\.json\b|daemon|adapter|CLI\b|stdin|env\b|API key from the|npm |pnpm /;

process.stdout.write("\nwhat one agent's card says\n");
{
  const {
    agentBadge,
    agentLabel,
    agentStance,
    harnessName,
    MAX_HARNESS_NAME_CHARS,
    tokenBlockFor,
    stanceLine,
    credentialCaveat,
    credentialLabel,
    CREDENTIAL_LABELS,
    storedChip,
    signOutSentence,
    dividerWord,
    multiSlotLine,
  } = await import("../src/ui/agentCard.js");
  const { AGENT_IDS } = await import("../src/wire.js");
  const agentCardRaw = readFileSync(new URL("../src/ui/agentCard.ts", import.meta.url), "utf8");

  check(
    "a harness is named as the program it is, not its package or its model",
    AGENT_IDS.map((id) => agentLabel(id)),
    ["Claude Code", "Kimi Code", "Codex", "Opencode", "Grok"],
  );
  // Asks the table, not the output: a missing label falls back to the id and can still read right.
  check(
    "and every one of them was named on purpose rather than falling through",
    AGENT_IDS.filter((id) => !/\bAGENT_LABEL[\s\S]*?\}/.test(agentCardRaw) || !agentCardRaw.includes(`  ${id}: `)),
    [],
  );
  check("an unknown agent still has a name", agentLabel("newthing"), "newthing");

  // A plugin's harness is named from the listing, never the daemon's displayName, which carries the package.
  check(
    "this product's own table wins, whatever a manifest calls a built-in",
    harnessName({ id: "claude", label: "Something Else" }),
    "Claude Code",
  );
  check("a harness it has never heard of takes the manifest's name", harnessName({ id: "acme:gemini", label: "Gemini" }), "Gemini");
  check("and one that named itself nothing is drawn as its id", harnessName({ id: "acme:gemini" }), "acme:gemini");
  // Bounded, not filtered: a plugin's name is somebody else's prose, so only its shape is constrained.
  check("a name longer than the row is cut", harnessName({ id: "a:b", label: "G".repeat(200) }).length, MAX_HARNESS_NAME_CHARS);
  check(
    "and control characters never reach a sentence",
    harnessName({ id: "a:b", label: "Gem\u0000ini\nCLI\u202e" }),
    "Gem ini CLI",
  );
  check("an empty name falls back rather than drawing nothing", harnessName({ id: "a:b", label: "   " }), "a:b");
  check(
    "a hostile name is still one line with nothing in it that can reorder a sentence",
    (() => {
      const drawn = harnessName({ id: "a:b", label: "\u202eAnthropic\nOpenAI/\u0007" });
      return [drawn.includes("\n"), drawn.includes("\u202e"), drawn.length <= MAX_HARNESS_NAME_CHARS];
    })(),
    [false, false, true],
  );
  check(
    "a name cut at the bound is cut between characters",
    (() => {
      const drawn = harnessName({ id: "a:b", label: `${"A".repeat(31)}\u{1F680} Tools` });
      return [Array.from(drawn).length, drawn.includes("\uFFFD"), /[\uD800-\uDBFF]$/.test(drawn)];
    })(),
    [MAX_HARNESS_NAME_CHARS, false, false],
  );
  check(
    "a name made of nothing visible falls back rather than drawing blank",
    [
      harnessName({ id: "a:b", label: "\u200b\u200b" }),
      harnessName({ id: "a:b", label: "\u00ad\u2060\ufeff" }),
      harnessName({ id: "a:b", label: "\u061c" }),
    ],
    ["a:b", "a:b", "a:b"],
  );
  check("while one that merely contains them keeps its words", harnessName({ id: "a:b", label: "Acme\u061cCorp" }), "Acme Corp");

  // opencode runs against an empty XDG_DATA_HOME with no provider variables, so there is nothing to sign in to.
  check(
    "an agent with no sign-in is a state of its own, whatever it holds",
    [
      agentStance(true, null, "no_flow"),
      agentStance(true, true, "no_flow"),
      agentBadge(agentStance(true, null, "no_flow")),
    ],
    ["no_login", "no_login", null],
  );
  check(
    "while the three reasons that are about the host leave the state alone",
    (["no_script", "no_cli", "interactive_pty", null, undefined] as const).map((b) =>
      agentStance(true, null, b),
    ),
    ["unchecked", "unchecked", "unchecked", "unchecked", "unchecked"],
  );
  check(
    "and every state draws exactly one badge, or none where there is nothing to report",
    (["not_installed", "start_refused", "no_login", "signed_in", "signed_out", "unchecked"] as const).map(
      (one) => {
        const badge = agentBadge(one);
        return badge === null ? `${one}: none` : `${one}: ${badge.tone}/${badge.text}`;
      },
    ),
    [
      "not_installed: strong/not installed",
      "start_refused: strong/would not start",
      "no_login: none",
      "signed_in: plain/signed in",
      "signed_out: strong/not signed in",
      "unchecked: plain/cannot check",
    ],
  );
  check(
    "and it is the only state that draws none",
    (["not_installed", "start_refused", "no_login", "signed_in", "signed_out", "unchecked"] as const).filter(
      (one) => agentBadge(one) === null,
    ),
    ["no_login"],
  );
  const noLoginLine = stanceLine({ id: "opencode" }, "no_login", false, "darwin");
  check(
    "and its sentence says nothing is missing, and what the box below is for",
    [
      noLoginLine !== null,
      /can't|cannot|couldn't|only way in|isn't installed/i.test(noLoginLine ?? ""),
      /key/i.test(noLoginLine ?? ""),
    ],
    [true, false, true],
  );
  check("and the key box is still offered", tokenBlockFor("no_login", 0), "editable");

  check(
    "a harness that refused to start outranks having nothing to sign in to",
    [
      agentStance(true, null, "no_flow", true),
      agentStance(true, false, "no_flow", false),
      agentStance(true, null, "no_flow", false),
      agentStance(false, null, "no_flow", true),
      agentStance(true, true, null, true),
    ],
    ["start_refused", "no_login", "no_login", "not_installed", "start_refused"],
  );
  check(
    "and a daemon that never mentions it changes nothing",
    [agentStance(true, null, "no_flow", undefined), agentStance(true, false, null, undefined)],
    ["no_login", "signed_out"],
  );
  const refusedLine = stanceLine({ id: "byo:gemini", label: "Gemini" }, "start_refused", false, "darwin");
  check(
    "and its sentence blames the harness rather than the machine it is on",
    [
      refusedLine !== null,
      /macOS|Windows|Linux|this machine can't/i.test(refusedLine ?? ""),
      /session\/new|auth_required|-32000/.test(refusedLine ?? ""),
      /key/i.test(refusedLine ?? ""),
      (refusedLine ?? "").includes("Gemini"),
      (refusedLine ?? "").includes("byo:gemini"),
    ],
    [true, false, false, true, true, false],
  );
  check(
    "and it stops there where there is a control to press",
    /key|machine itself/i.test(stanceLine({ id: "claude" }, "start_refused", true) ?? ""),
    false,
  );
  check(
    "the divider needs something above it here too",
    [dividerWord("start_refused", false, "editable"), dividerWord("start_refused", true, "editable")],
    [null, "or"],
  );
  check(
    "and a stored key does not read as a working one",
    storedChip({ id: "byo:gemini", label: "Gemini" }, "start_refused"),
    "saved — Gemini still wouldn't start",
  );
  check("and the key box is offered", tokenBlockFor("start_refused", 0), "editable");

  // The positive anchor: the screen's predicate must be offersStripTile by name, since a reworded ladder passes every negative.
  const newSessionRaw = readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8");
  const agentsRaw = readFileSync(new URL("../src/agents.ts", import.meta.url), "utf8");
  check(
    "the New session tiles hold no vocabulary of their own",
    [
      /function agentStatusText/.test(newSessionRaw),
      /return "state unknown"/.test(newSessionRaw),
      // Comments and whitespace stripped: the subject is the argument list, not its formatting.
      stripComments(agentsRaw)
        .replace(/\s+/g, "")
        .includes(
          "agentStance(candidate.available,candidate.loggedIn,candidate.login?.blocked,candidate.lastStartRefusal!=null",
        ),
      /agentStance\(/.test(stripComments(newSessionRaw)),
      newSessionRaw.includes("const shownHere = offersStripTile;"),
    ],
    [false, false, true, false, true],
  );
  {
    const paneVocab = stripComments(
      readFileSync(new URL("../src/ui/settings/MachineAgentsSection.tsx", import.meta.url), "utf8"),
    );
    check(
      "and neither screen keeps a membership ladder of its own",
      [
        /import \{[^}]*\bstartableHere\b[^}]*\} from "\.\.\/agents"/.test(
          stripComments(newSessionRaw),
        ),
        /import \{[^}]*\bstartableHere\b[^}]*\} from "\.\.\/\.\.\/agents"/.test(paneVocab),
        /offersTile\(/.test(paneVocab),
      ],
      [true, true, false],
    );
  }
  // Both install and sign-in live on the machine's Agents screen; New session offers neither (Q3.640).
  {
    const ns = stripComments(newSessionRaw);
    check(
      "New session offers no install and no sign-in, and mounts no card that does",
      [
        /\bAgentDetail\b/.test(ns),
        /from "\.\/settings\/AgentsPanel"/.test(ns),
        /\b(agentDoor|doorLabel|AgentDoor)\b/.test(ns),
        /\b(Download|LogIn)\b/.test(ns),
        /\b(startInstall|startLogin|liveInstall|agentAuth)\(/.test(ns),
        /sign[ -]?in/i.test(ns),
        /["'`>]\s*Install\b/.test(ns),
      ],
      [false, false, false, false, false, false, false],
    );
  }

  check(
    "the stance is a total partition",
    [
      agentStance(false, true),
      agentStance(true, true),
      agentStance(true, false),
      agentStance(true, null),
    ],
    ["not_installed", "signed_in", "signed_out", "unchecked"],
  );

  const stances = [
    "not_installed",
    "start_refused",
    "no_login",
    "signed_in",
    "signed_out",
    "unchecked",
  ] as const;
  check(
    "a saved key is never hidden, whatever the stance",
    stances.map((stance) => tokenBlockFor(stance, 1) === "hidden"),
    [false, false, false, false, false, false],
  );
  check(
    "and nothing is typeable where nothing could help",
    stances.map((stance) => tokenBlockFor(stance, 0)),
    ["hidden", "editable", "editable", "hidden", "editable", "editable"],
  );

  check(
    "the card is silent where a sentence could only repeat the badge",
    [stanceLine({ id: "codex" }, "signed_in", true), stanceLine({ id: "codex" }, "signed_out", true)],
    [null, null],
  );
  check("and speaks where there is no way in", stanceLine({ id: "codex" }, "signed_out", false) !== null, true);

  const codexCaveat = credentialCaveat("codex", true) ?? "";
  check("codex warns that a key alone is not enough", codexCaveat.length > 0, true);
  check("and does not overclaim that it does nothing", /does nothing|ignored|useless/i.test(codexCaveat), false);
  check("claude needs no caveat", credentialCaveat("claude", true), null);

  const JARGON = JARGON_WORDS;
  const sentences: string[] = [];
  for (const id of AGENT_IDS) {
    for (const stance of stances) {
      for (const can of [true, false]) {
        const line = stanceLine({ id }, stance, can);
        if (line !== null) sentences.push(line);
      }
    }
    const caveat = credentialCaveat(id, true);
    if (caveat !== null) sentences.push(caveat);
    sentences.push(signOutSentence(id, 0), signOutSentence(id, 1));
    for (const stance of stances) sentences.push(storedChip({ id }, stance));
    const multi = multiSlotLine({ id }, 2);
    if (multi !== null) sentences.push(multi);
  }
  check(
    "nothing the card can say is written for a developer",
    sentences.filter((line) => JARGON.test(line)),
    [],
  );

  const wordCount = (text: string): number => text.trim().split(/\s+/).length;
  const overCap: string[] = [];
  for (const id of AGENT_IDS) {
    for (const stance of ["unchecked", "start_refused"] as const) {
      for (const can of [true, false]) {
        for (const os of [undefined, "linux", "darwin"]) {
          const line = stanceLine({ id }, stance, can, os);
          if (line !== null && wordCount(line) > 14) overCap.push(line);
        }
      }
    }
    for (const can of [true, false]) {
      const caveat = credentialCaveat(id, can);
      if (caveat !== null && wordCount(caveat) > 10) overCap.push(caveat);
    }
  }
  for (const { note } of Object.values(CREDENTIAL_LABELS)) if (wordCount(note) > 6) overCap.push(note);
  check("every trimmed arm sits at or under its cap", overCap, []);
  check(
    "and a host that cannot run the sign-in is told to paste a key instead of to start a chat",
    stanceLine({ id: "claude" }, "unchecked", false, "darwin"),
    "Claude Code's sign-in state is unknown. macOS can't run sign-in; paste a key.",
  );
  check("and the two-word host sits exactly at the cap", wordCount(stanceLine({ id: "kimi" }, "unchecked", false, undefined) ?? ""), 14);
  check("while one that can is told to start a chat", /Start a chat to find out\.$/.test(stanceLine({ id: "claude" }, "unchecked", true, "darwin") ?? ""), true);

  const agentsSrc = readFileSync(new URL("../../../src/acp/agents.ts", import.meta.url), "utf8");
  const declared = [...agentsSrc.matchAll(/envNames: \[([^\]]*)\]/g)]
    .flatMap((match) => [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((inner) => inner[1] ?? ""));
  check("the daemon declares credentials at all", declared.length > 0, true);
  // Against the table, not credentialLabel: its fallback never echoes the name, so equality could never fail.
  check(
    "and every one of them is named in the table rather than auto-humanised",
    declared.filter((envName) => !(envName in CREDENTIAL_LABELS)),
    [],
  );
  check(
    "an unknown credential is humanised rather than shown raw",
    credentialLabel("SOME_NEW_API_KEY").name,
    "Some new api key",
  );

  check(
    "the divider says what it separates",
    [
      dividerWord("signed_out", true, "editable"),
      dividerWord("signed_out", false, "editable"),
      dividerWord("signed_out", true, "stored_only"),
      dividerWord("signed_out", true, "hidden"),
    ],
    ["or", "or paste a key", "Saved keys", null],
  );
  check(
    "and an agent with nothing to sign in to gets no divider at all",
    (["editable", "stored_only", "hidden"] as const).flatMap((block) => [
      dividerWord("no_login", true, block),
      dividerWord("no_login", false, block),
    ]),
    [null, null, null, null, null, null],
  );
  check("claude is the only agent told it has a choice", multiSlotLine({ id: "claude" }, 1), null);
  check(
    "an agent that needs no key at all carries no caveat, and the one that does still warns",
    [credentialCaveat("opencode", false), credentialCaveat("claude", true), credentialCaveat("codex", true) !== null],
    [null, null, true],
  );
}

process.stdout.write("\nthe sign-in screens, cut\n");
{
  const settings = (name: string): string =>
    stripComments(readFileSync(new URL(`../src/ui/settings/${name}`, import.meta.url), "utf8"));
  const agentsPanel = settings("AgentsPanel.tsx");
  const systemsPanel = settings("SystemsPanel.tsx");
  const machineSystems = settings("MachineSystemsSection.tsx");
  const card = stripComments(readFileSync(new URL("../src/ui/agentCard.ts", import.meta.url), "utf8"));
  check("all four files were found", [agentsPanel, systemsPanel, machineSystems, card].map((one) => one.length > 0), [true, true, true, true]);

  check("AgentChooser is gone", /AgentChooser/.test(agentsPanel), false);
  check("and the hook it shared with AgentDetail stays", /function useAgentAuth\(/.test(agentsPanel), true);

  const signOut = agentsPanel.slice(agentsPanel.indexOf("function SignOutButton("), agentsPanel.indexOf("function CredentialSlot("));
  check("SignOutButton was found", signOut.length > 0, true);
  check(
    "it reads the daemon at render, refuses the act without one, and never toasts a tap",
    [
      /const daemon = store\.daemonFor\(machineId\);/.test(signOut),
      /disabled=\{daemon === undefined\}\s*onAct=\{run\}/.test(signOut),
      /if \(daemon === undefined\) return undefined;/.test(signOut),
      /not reachable/.test(signOut),
    ],
    [true, true, true, false],
  );

  const { STALE_READ } = await import("../src/ui/agentCard.js");
  check("STALE_READ is defined exactly once, in agentCard", (card.match(/export const STALE_READ\b/g) ?? []).length, 1);
  check("and neither panel spells its own", [/const STALE_READ\b/.test(systemsPanel), /const STALE_READ\b/.test(agentsPanel)], [false, false]);
  check("and both draw the shared one", [/\{STALE_READ\}/.test(systemsPanel), /\{STALE_READ\}/.test(agentsPanel)], [true, true]);
  check("which is seven words and names the subject", [STALE_READ.split(/\s+/).length, /^Machine status/.test(STALE_READ)], [7, true]);

  const keyForm = systemsPanel.slice(systemsPanel.indexOf("export function KeyOnly("));
  check("the key input sits in a form that submits", [/<form[^>]*onSubmit=/.test(keyForm), /<Button type="submit"/.test(keyForm)], [true, true]);
  check("and no Enter handler is wired by hand", /onKeyDown/.test(keyForm), false);
  const routed = /`(For agents routed to \$\{system\.displayName\}[^`]*)`/.exec(systemsPanel)?.[1] ?? "";
  check("the routed key-box blurb says whose sign-in does not cover it", /; its CLI sign-in doesn't cover this\.$/.test(routed), true);
  check("at the eleven-word cap, the name as one word", routed.replace("${system.displayName}", "X").trim().split(/\s+/).length, 11);
  const slotForm = agentsPanel.slice(agentsPanel.indexOf("function CredentialSlot("), agentsPanel.indexOf("function loginKey("));
  check("the harness card's key input sits in a form that submits", [/<form[^>]*onSubmit=/.test(slotForm), /type="submit"/.test(slotForm)], [true, true]);
  check("and wires no Enter handler by hand either", /onKeyDown/.test(slotForm), false);
  const sendBody = agentsPanel.slice(agentsPanel.indexOf("const send = (): void => {"), agentsPanel.indexOf("const close = (cancel: boolean)"));
  check("the device-code box is cleared inside .then(", /\.writeLogin\(loginId, text\)\s*\.then\(\(\) => setInput\(""\)\)/.test(sendBody), true);
  check("and not before the write", sendBody.indexOf('setInput("")') > sendBody.indexOf(".writeLogin("), true);
  check("a second send during the round trip is refused", /if \(daemon === undefined \|\| loginId === null \|\| sending\) return;/.test(sendBody), true);
  const arms = sendBody.indexOf("setSending(true);");
  const writes = sendBody.indexOf(".writeLogin(");
  check("armed before the write", arms >= 0 && writes >= 0 && arms < writes, true);
  check("and disarmed after it, on either outcome", /\.finally\(\(\) => setSending\(false\)\)/.test(sendBody), true);
  check("and the button says so", /<Button onClick=\{send\} disabled=\{loginId === null \|\| sending\}>/.test(agentsPanel), true);
  check("the removal question names the key and its cost", /Remove the \{keyName\}\? New sessions pointed at/.test(keyForm), true);
  check("and no paragraph at rest restates it", /Sessions pointed at \{system\.displayName\} sign with this key/.test(keyForm), false);

  check("MachineSystemsSection takes no lede", /\blede\b/.test(machineSystems), false);
  check("and says nothing about where credentials are stored", /Stored on/.test(machineSystems), false);
  check("while the unreachable arm keeps its sentence, mounted rather than copied", /<NotReachable machine=\{machine\} \/>/.test(machineSystems), true);
  check("without the trailing clause about the system", /can be read or changed/.test(machineSystems), false);
}
