import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { JARGON_WORDS } from "./webcheck.agent-card.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

process.stdout.write("\ninstalling a harness, from this side\n");
{
  const {
    installElapsed,
    installFailure,
    installResult,
    installResultLine,
    installStage,
    installStep,
    keepInstallTail,
    primaryControl,
    rawInstallIsOpen,
    ELAPSED_AFTER_MS,
    MAX_INSTALL_OUTPUT_CHARS,
  } = await import("../src/ui/agentInstall.js");
  const { stanceLine } = await import("../src/ui/agentCard.js");

  const STANCES = [
    "not_installed",
    "start_refused",
    "no_login",
    "signed_in",
    "signed_out",
    "unchecked",
  ] as const;
  const FLAGS = ["installRunning", "wizardOpen", "installable", "canSignIn", "canSignOut"] as const;

  // Both axes are differenced against their comment-stripped declarations: a subset of the union still type-checks.
  const cardSrc = stripComments(srcFile("ui/agentCard.ts"));
  const declaredStances = [
    ...(/export type AgentStance =([^;]*);/.exec(cardSrc)?.[1] ?? "").matchAll(/"([^"]+)"/g),
  ].map((one) => one[1] ?? "");
  report(
    "the stance union was read off its own declaration",
    declaredStances.length > 0,
    `${declaredStances.length} members`,
  );
  check(
    "and the sweep's stance list is that union, neither short nor long",
    [
      declaredStances.filter((one) => !STANCES.includes(one as (typeof STANCES)[number])),
      STANCES.filter((one) => !declaredStances.includes(one)),
    ],
    [[], []],
  );
  const installSrc = stripComments(srcFile("ui/agentInstall.ts"));
  const declaredFlags = [
    ...(/export function primaryControl\(input: \{([^}]*)\}/.exec(installSrc)?.[1] ?? "").matchAll(
      /(\w+): boolean/g,
    ),
  ].map((one) => one[1] ?? "");
  report(
    "and the flag axis off the input it is a product of",
    declaredFlags.length > 0,
    `${declaredFlags.length} flags`,
  );
  check(
    "which the sweep's flag list is too, neither short nor long",
    [
      declaredFlags.filter((one) => !FLAGS.includes(one as (typeof FLAGS)[number])),
      FLAGS.filter((one) => !declaredFlags.includes(one)),
    ],
    [[], []],
  );

  // An unknown stance comes back as itself from the never arm, so only the set of answers below can see it.
  const cells: { stance: string; flags: number; answer: string }[] = [];
  const bools = [false, true];
  // The literal call is kept so a new required flag is a compile error here.
  for (const stance of declaredStances) {
    for (let mask = 0; mask < 2 ** FLAGS.length; mask += 1) {
      const set = (bit: number): boolean => (mask & (1 << bit)) !== 0;
      cells.push({
        stance,
        flags: mask,
        answer: primaryControl({
          stance: stance as (typeof STANCES)[number],
          installRunning: set(0),
          wizardOpen: set(1),
          installable: set(2),
          canSignIn: set(3),
          canSignOut: set(4),
        }),
      });
    }
  }
  check("the sweep iterates as many flag bits as the card's own input declares", FLAGS.length, declaredFlags.length);
  report(
    "every stance and flag combination has an answer",
    cells.length > 0,
    `${declaredStances.length} stances × ${2 ** FLAGS.length} flag combinations = ${cells.length} cells`,
  );
  check(
    "and every answer is one this card can draw",
    [...new Set(cells.map((one) => one.answer))].sort(),
    ["install", "installing", "none", "sign_in", "sign_out", "wizard"],
  );

  // An old daemon omits installable; an Install there would meet a bare 404 with nothing to render.
  check(
    "a harness this machine cannot install offers no install, whatever else is true",
    [
      // Written as the derivation, not a bare 4: installable halves it, then a live run, then an open wizard.
      cells.filter((one) => one.stance === "not_installed" && one.answer === "install").length,
      cells.filter((one) => one.stance === "not_installed").length,
    ],
    [2 ** FLAGS.length / 2 / 2 / 2, 2 ** FLAGS.length],
  );
  check(
    "and with no install store at all it is never offered",
    STANCES.flatMap((stance) =>
      bools.flatMap((canSignIn) =>
        bools.map((canSignOut) =>
          primaryControl({ stance, installRunning: false, wizardOpen: false, installable: false, canSignIn, canSignOut }),
        ),
      ),
    ).includes("install"),
    false,
  );
  check(
    "a harness that is not installed offers the install, even where a sign-in could run",
    primaryControl({ stance: "not_installed", installRunning: false, wizardOpen: false, installable: true, canSignIn: true, canSignOut: true }),
    "install",
  );
  check(
    "a run in flight is what the slot shows, in every stance",
    STANCES.map((stance) =>
      primaryControl({ stance, installRunning: true, wizardOpen: true, installable: true, canSignIn: true, canSignOut: true }),
    ),
    STANCES.map(() => "installing"),
  );
  check(
    "and nothing but not_installed ever answers install",
    [...new Set(cells.filter((one) => one.answer === "install").map((one) => one.stance))],
    ["not_installed"],
  );
  check(
    "while only signed_in signs out, and only under a sign-out command",
    [
      [...new Set(cells.filter((one) => one.answer === "sign_out").map((one) => one.stance))],
      primaryControl({ stance: "signed_in", installRunning: false, wizardOpen: false, installable: false, canSignIn: true, canSignOut: false }),
    ],
    [["signed_in"], "none"],
  );

  {
    const mod: Record<string, unknown> = await import("../src/ui/agentInstall.js");
    check(
      "the strip's door is gone from the module that held it",
      ["agentDoor", "doorLabel"].filter((name) => name in mod),
      [],
    );
  }

  const run = (over: Record<string, unknown> = {}) =>
    ({ done: false, outcome: "running", phase: null, ...over }) as never;
  check(
    "a run with no checkpoint yet is starting, and one with a real step is working",
    [installStage(run()), installStage(run({ phase: "start" })), installStage(run({ phase: "download" }))],
    ["starting", "starting", "working"],
  );
  check(
    "and a finished one is read off the outcome, never the exit code",
    [
      installStage(run({ done: true, outcome: "installed" })),
      installStage(run({ done: true, outcome: "failed" })),
      installStage(run({ done: true, outcome: "locked" })),
    ],
    ["done", "failed", "failed"],
  );
  check(
    "the step line is a word for a checkpoint, and silent where there is none",
    [installStep(null), installStep("start"), installStep("download"), installStep("install"), installStep("link"), installStep("done")],
    [null, null, "Downloading…", "Installing…", "Finishing…", null],
  );
  check(
    "the clock says nothing until it is worth saying, and then says seconds",
    [installElapsed(0, ELAPSED_AFTER_MS - 1), installElapsed(0, ELAPSED_AFTER_MS), installElapsed(0, 0), installElapsed(0, 42_000)],
    [null, "10s", null, "42s"],
  );

  // No sentence for a network failure: a recognised failure names something a retry cannot fix.
  check(
    "a running or installed run has nothing to apologise for",
    [installFailure("running", "Kimi"), installFailure("installed", "Kimi")],
    [null, null],
  );
  check(
    "and every other outcome has exactly one sentence",
    (["failed", "locked", "timeout", "cancelled", "spawn_failed"] as const).map((one) => installFailure(one, "Kimi") !== null),
    [true, true, true, true, true],
  );
  check(
    "the success line points at the sign-in, because the tile is not back yet",
    installResultLine("installed", "Claude Code"),
    "Claude Code is installed. Sign in to start a chat with it.",
  );
  check(
    "and the re-read has a definite answer either way — there is no cannot-tell here",
    [
      installResult(true, false, false),
      installResult(false, true, false),
      installResult(false, false, true),
      installResult(false, false, false),
    ],
    ["checking", "unreachable", "installed", "notInstalled"],
  );
  // The true cell is what makes this a partition: a constant false passed without it.
  check(
    "the installer's own output opens by itself, and only where the sentence is the generic one",
    [
      rawInstallIsOpen(null),
      rawInstallIsOpen({ done: false, outcome: "running" } as never),
      rawInstallIsOpen({ done: false, outcome: "failed" } as never),
      rawInstallIsOpen({ done: true, outcome: "installed" } as never),
      rawInstallIsOpen({ done: true, outcome: "failed" } as never),
    ],
    [false, false, false, false, true],
  );
  check(
    "every other settled outcome keeps its own sentence instead",
    (["installed", "locked", "timeout", "cancelled", "spawn_failed"] as const).map((one) =>
      rawInstallIsOpen({ done: true, outcome: one } as never),
    ),
    [false, false, false, false, false],
  );

  check(
    "the client keeps the tail of a long transcript and the whole of a short one",
    [
      keepInstallTail("abc"),
      keepInstallTail("x".repeat(MAX_INSTALL_OUTPUT_CHARS)).length,
      keepInstallTail(`head${"x".repeat(MAX_INSTALL_OUTPUT_CHARS)}`).length,
      // The head is what goes: keeping the first MAX characters satisfies every length above and keeps the wrong half.
      keepInstallTail(`head${"x".repeat(MAX_INSTALL_OUTPUT_CHARS)}`).startsWith("head"),
      keepInstallTail(`head${"x".repeat(MAX_INSTALL_OUTPUT_CHARS)}`).endsWith("x"),
    ],
    ["abc", MAX_INSTALL_OUTPUT_CHARS, MAX_INSTALL_OUTPUT_CHARS, false, true],
  );
  // Parsed as a product against the daemon's constant, since packages/web may not import from src/.
  const daemonInstall = stripComments(
    readFileSync(new URL("../../../src/agentinstall.ts", import.meta.url), "utf8"),
  );
  const ceiling = /MAX_OUTPUT_BYTES = ([^;]+);/.exec(daemonInstall)?.[1] ?? "";
  const factors = ceiling.split("*").map((part) => Number(part.trim()));
  report(
    "the daemon's own ceiling was found to compare against",
    ceiling.length > 0 && factors.every((one) => Number.isFinite(one)),
    `MAX_OUTPUT_BYTES = ${ceiling.trim()}`,
  );
  check(
    "and the client keeps exactly what the daemon will ever hand out",
    factors.reduce((product, one) => product * one, 1),
    MAX_INSTALL_OUTPUT_CHARS,
  );

  // Callers, not the declaration: a method nothing calls is the defect, so daemon.ts is excluded.
  const callers = srcFiles().filter(
    (rel) => rel !== "daemon.ts" && /liveInstall\(/.test(stripComments(srcFile(rel))),
  );
  check(
    "both screens that draw a run ask the machine what it is already running",
    callers.sort(),
    ["ui/settings/AgentsPanel.tsx", "ui/settings/MachineAgentsSection.tsx"],
  );

  const sentences: string[] = [];
  for (const outcome of ["running", "installed", "failed", "locked", "timeout", "cancelled", "spawn_failed"] as const) {
    const line = installFailure(outcome, "Claude Code");
    if (line !== null) sentences.push(line);
  }
  for (const result of ["checking", "installed", "notInstalled", "unreachable"] as const) {
    const line = installResultLine(result, "Claude Code");
    if (line !== null) sentences.push(line);
  }
  for (const phase of ["download", "install", "link"] as const) {
    const line = installStep(phase);
    if (line !== null) sentences.push(line);
  }
  sentences.push(stanceLine({ id: "claude" }, "not_installed", false, "darwin", true) ?? "");
  report("there are sentences to sweep", sentences.length > 10, `${sentences.length} sentences`);
  check(
    "nothing this flow can say is written for a developer",
    sentences.filter((line) => JARGON_WORDS.test(line)),
    [],
  );
  const words = (text: string): number => text.trim().split(/\s+/).length;
  check("and none of it runs past a screen line", sentences.filter((line) => words(line) > 14), []);

  const panel = stripComments(
    readFileSync(new URL("../src/ui/settings/AgentsPanel.tsx", import.meta.url), "utf8"),
  );
  check(
    "one call decides which control the card draws",
    [
      panel.includes("primaryControl({"),
      // Anchored on the old chain's middle arm, since one switch arm still legitimately reads stance.
      /\) : canSignIn \? \(/.test(panel),
      /agent\.available \?/.test(panel),
    ],
    [true, false, false],
  );
  // installable must be true, not merely not-false: an old daemon refuses with a bare 404, unlike canSignOut's 503.
  const loose = srcFiles().filter((rel) => /installable\s*!==\s*false/.test(stripComments(srcFile(rel))));
  check("and installable is never read the way canSignOut is", loose, []);
  report(
    "the sweep looked at both authored trees",
    srcFiles().length > 100,
    `${srcFiles().length} files`,
  );

  // Several writers share one key per machine and agent, so every clear goes through forgetInstallIf, which compares the id.
  const declaredAt = (source: string): { at: number; name: string }[] =>
    [...source.matchAll(/^(?:export )?function (\w+)/gm)].map((one) => ({
      at: one.index ?? 0,
      name: one[1] ?? "",
    }));
  const panelFns = declaredAt(panel);
  const inside = (at: number): string => panelFns.filter((one) => one.at <= at).at(-1)?.name ?? "";
  const clears = [...panel.matchAll(/\bforgetInstall\(/g)].map((one) => inside(one.index ?? 0));
  report("the install slot is cleared somewhere", clears.length > 0, `${clears.length} sites`);
  check(
    "and nothing clears it without comparing the id first",
    [...new Set(clears)].sort(),
    ["forgetInstall", "forgetInstallIf"],
  );
  // The try that survives a private window is written once, so only these helpers may name installKey.
  const keyed = [...panel.matchAll(/\binstallKey\(/g)].map((one) => inside(one.index ?? 0));
  report("the install key is built somewhere", keyed.length > 0, `${keyed.length} sites`);
  check(
    "and only the three storage helpers and the in-flight map name it",
    [...new Set(keyed)].sort(),
    ["forgetInstall", "heldInstall", "installKey", "rememberInstall", "startInstall"],
  );

  // The card is the one surface that starts a run; the list only adopts one, through its kebab (Q3.640).
  const section = stripComments(
    readFileSync(new URL("../src/ui/settings/MachineAgentsSection.tsx", import.meta.url), "utf8"),
  );
  const menuAt = section.indexOf("<Menu");
  check(
    "the list starts no run of its own, and its way to the card is inside the row's one menu",
    [
      menuAt >= 0,
      section.indexOf("agentSetupPath(machineId, behind.id)") > menuAt,
      /\.startInstall\(/.test(section),
    ],
    [true, true, false],
  );
  check(
    "and the row's reserved widths did not move",
    [section.includes('className="inline-flex w-4 shrink-0 justify-center"'), section.includes("w-5")],
    [true, true],
  );
  // The cursor is threaded as the next since; the report stops a renamed call from passing as the property.
  const reads = [...section.matchAll(/readInstall\(/g)].length;
  report("the strip screen still polls a run at all", reads > 0, `${reads} reads`);
  check(
    "and it threads the cursor rather than re-reading from zero",
    [/readInstall\([^)]*,\s*0\s*\)/.test(section), section.includes("chunk.cursor")],
    [false, true],
  );
  const newSession = stripComments(
    readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"),
  );
  // Sliced to the strip's own body, with a report so an empty slice cannot pass.
  const stripAt = newSession.indexOf("function AgentStrip(");
  const stripBody = stripAt < 0 ? "" : newSession.slice(stripAt, newSession.indexOf("\nfunction ", stripAt + 1));
  report("the strip's own body was isolated", stripBody.length > 0, `${String(stripBody.length)} chars`);
  check(
    "the tiles carry no install control, and nothing under them opens one",
    [/installable/.test(stripBody), /doorLabel\(|AgentDetail/.test(newSession)],
    [false, false],
  );
}
