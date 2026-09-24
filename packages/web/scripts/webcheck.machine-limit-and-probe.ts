import { readFileSync, readdirSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

process.stdout.write("\nthe machine limit\n");
{
  const {
    HARD_MACHINE_CEILING,
    machineBadgeText,
    machineLimitChangeNotice,
    machineLimitProblem,
    machineQuota,
    machineQuotaNotice,
    mayAddMachine,
  } = await import("../src/quota.js");

  const me = (over: Record<string, unknown>): never =>
    ({ id: "u_1", name: "ada", isAdmin: false, ...over }) as never;

  const CASES: { what: string; me: never | null; kind: string; may: boolean }[] = [
    { what: "no `me` at all", me: null, kind: "unknown", may: true },
    { what: "a control plane that predates the field", me: me({}), kind: "unknown", may: true },
    { what: "an explicit no-limit", me: me({ machineCount: 2, machineLimit: null }), kind: "unknown", may: true },
    {
      what: "room to spare",
      me: me({ machineCount: 0, machineLimit: 2, canAddMachine: true }),
      kind: "room",
      may: true,
    },
    {
      what: "one slot left",
      me: me({ machineCount: 1, machineLimit: 2, canAddMachine: true }),
      kind: "room",
      may: true,
    },
    {
      what: "exactly at the limit",
      me: me({ machineCount: 2, machineLimit: 2, canAddMachine: false }),
      kind: "full",
      may: false,
    },
    {
      what: "past it, which is what a lowering looks like",
      me: me({ machineCount: 3, machineLimit: 2, canAddMachine: false }),
      kind: "full",
      may: false,
    },
    {
      what: "a limit of zero and nothing owned",
      me: me({ machineCount: 0, machineLimit: 0, canAddMachine: false }),
      kind: "none",
      may: false,
    },
    {
      what: "a limit of zero lowered onto machines they had",
      me: me({ machineCount: 1, machineLimit: 0, canAddMachine: false }),
      kind: "none",
      may: false,
    },
  ];

  for (const one of CASES) {
    check(`${one.what}: kind`, machineQuota(one.me).kind, one.kind);
    check(`${one.what}: may add`, mayAddMachine(one.me), one.may);
  }

  // Over a generated cross-product, not `CASES`: every entry there agrees with itself, so the property could not fail on it.
  for (const machineCount of [0, 1, 2, 3]) {
    for (const machineLimit of [undefined, null, 0, 1, 2, 5]) {
      for (const canAddMachine of [undefined, true, false]) {
        const subject = me({ machineCount, machineLimit, canAddMachine });
        report(
          `a sentence is drawn exactly where the door is not (${machineCount}/${String(machineLimit)}/${String(canAddMachine)})`,
          (machineQuotaNotice(subject) === null) === mayAddMachine(subject),
          `notice ${machineQuotaNotice(subject) === null ? "null" : "sentence"} / may ${mayAddMachine(subject)}`,
        );
      }
    }
  }

  check(
    "`canAddMachine` decides, not the two numbers beside it",
    mayAddMachine(me({ machineCount: 0, machineLimit: 5, canAddMachine: false })),
    false,
  );

  const noticeOf = (over: Record<string, unknown>): string => machineQuotaNotice(me(over)) ?? "";
  report(
    "a fresh account on a closed instance is told what to ask for",
    noticeOf({ machineCount: 0, machineLimit: 0 }).includes("Ask for it to be raised"),
    noticeOf({ machineCount: 0, machineLimit: 0 }),
  );
  report(
    "and one whose machines just went dark is told they went dark",
    noticeOf({ machineCount: 2, machineLimit: 0 }).includes("your machines are off"),
    noticeOf({ machineCount: 2, machineLimit: 0 }),
  );
  report(
    "at the limit, the count is in the sentence",
    noticeOf({ machineCount: 2, machineLimit: 2 }).includes("All 2 machines in use"),
    noticeOf({ machineCount: 2, machineLimit: 2 }),
  );
  report(
    "over it, one machine is singular",
    noticeOf({ machineCount: 3, machineLimit: 2 }).includes("newest one is off"),
    noticeOf({ machineCount: 3, machineLimit: 2 }),
  );
  report(
    "and two are plural",
    noticeOf({ machineCount: 4, machineLimit: 2 }).includes("newest 2 are off"),
    noticeOf({ machineCount: 4, machineLimit: 2 }),
  );
  for (const [count, limit] of [[0, 0], [2, 0], [2, 2], [3, 2], [4, 2], [0, 5]] as const) {
    const text = noticeOf({ machineCount: count, machineLimit: limit, canAddMachine: false });
    report(`the notice for ${count}/${limit} is at most 14 words`, text.split(/\s+/).length <= 14, text);
  }

  check("raising costs nothing and asks nothing", machineLimitChangeNotice("ada", 3, 5), null);
  check("nor does setting it to what it already is", machineLimitChangeNotice("ada", 3, 3), null);
  check("nor does zero when they own nothing", machineLimitChangeNotice("ada", 0, 0), null);
  report(
    "lowering onto two machines says two, and says they come back",
    (machineLimitChangeNotice("ada", 3, 1) ?? "").includes("newest 2 working") &&
      (machineLimitChangeNotice("ada", 3, 1) ?? "").includes("brings them back"),
    machineLimitChangeNotice("ada", 3, 1) ?? "(null)",
  );
  report(
    "and onto one says one",
    (machineLimitChangeNotice("ada", 2, 1) ?? "").includes("newest one working"),
    machineLimitChangeNotice("ada", 2, 1) ?? "(null)",
  );
  // Fourteen whitespace-separated words is the confirmation cap, so a dash counts as one.
  {
    const { fleetMachineLimitNotice } = await import("../src/quota.js");
    const wordCount = (text: string): number => text.trim().split(/\s+/).length;
    check("lowering onto two machines is at the fourteen-word cap", wordCount(machineLimitChangeNotice("ada", 3, 1) ?? ""), 14);
    check("and onto one", wordCount(machineLimitChangeNotice("ada", 2, 1) ?? ""), 14);
    check("the fleet line is at the fourteen-word cap", wordCount(fleetMachineLimitNotice("50", "5") ?? ""), 14);
    check("and names only the value being set", /from 50/.test(fleetMachineLimitNotice("50", "5") ?? ""), false);
    check("with the closing arm under it", wordCount(fleetMachineLimitNotice("50", "0") ?? "") <= 14, true);
  }

  check("empty is legal — it hands the value back to the default", machineLimitProblem(""), null);
  check("and so is a field holding only a space", machineLimitProblem("   "), null);
  // Zero is the value the feature exists for, and a truthiness test would refuse it.
  check("zero is legal", machineLimitProblem("0"), null);
  check("and so is the ceiling itself", machineLimitProblem(String(HARD_MACHINE_CEILING)), null);
  for (const bad of ["-1", "2.5", "abc", "5 machines"]) {
    report(`"${bad}" is refused`, machineLimitProblem(bad) !== null, String(machineLimitProblem(bad)));
  }
  report(
    "and one past the ceiling names it",
    (machineLimitProblem(String(HARD_MACHINE_CEILING + 1)) ?? "").includes(String(HARD_MACHINE_CEILING)),
    String(machineLimitProblem(String(HARD_MACHINE_CEILING + 1))),
  );

  check("over the limit outranks not enrolled", machineBadgeText({ overLimit: true, enrolled: false }), "over the limit");
  check("and is the only badge when it applies", machineBadgeText({ overLimit: true, enrolled: true }), "over the limit");
  check("otherwise not-enrolled still draws", machineBadgeText({ overLimit: false, enrolled: false }), "not enrolled");
  check("and an ordinary machine draws nothing", machineBadgeText({ overLimit: false, enrolled: true }), null);
  // A banned owner outranks the limit: retiring a machine does nothing for it, so naming the limit would send the reader to the wrong act.
  check(
    "a banned owner outranks the limit",
    machineBadgeText({ overLimit: true, ownerDisabled: true, enrolled: true }),
    "owner disabled",
  );
  check(
    "and an absent field degrades to not-banned",
    machineBadgeText({ overLimit: false, enrolled: true }),
    null,
  );

  const machinesTs = readFileSync(new URL("../../control-plane/src/machines.ts", import.meta.url), "utf8");
  check(
    "the mirrored ceiling is the one `machines.ts` declares",
    Number(/MAX_MACHINES_PER_USER = (\d+)/.exec(machinesTs)?.[1]),
    HARD_MACHINE_CEILING,
  );

  // Each door asks the shared predicate, never the two numbers nor the machine list's length, which also counts machines granted to you.
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // `store.ts` creates this computer's machine with no press, so it must ask `mayAddMachine` like the doors do.
  {
    const store = strip(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
    check("the store asks the shared predicate before creating a machine", /mayAddMachine\(/.test(store), true);
    check("and never re-derives it from the fields", /machineLimit|machineCount|canAddMachine/.test(store), false);
    // Gated on the native shell, never on an empty fleet: the live bootstrap driver's fetch stub would answer a machine POST with a 200.
    check(
      "and reaches the host before it decides anything",
      /const boot = this\.snapshot\.host;\s*if \(boot === null\) return;/.test(store),
      true,
    );
    const setUp = /private async setUpThisComputer\(\)[\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
    check("the setup path exists to be checked", setUp.length > 0, true);
    check("and it never writes cpError", /cpError/.test(setUp), false);
    check("and it never moves the phase", /phase:/.test(setUp), false);
    check("and it re-mints against a machine it already made", /state\.claimed/.test(setUp), true);
    // Setup reads the env file before buying: `elsewhere` protects somebody else's daemon, `here` avoids a second machine, and an empty-code start adopts.
    check("and it reads what the env file here already says", /state\.config/.test(setUp), true);
    for (const arm of ["elsewhere", "here"] as const) {
      check(`and it has an arm for ${arm}`, new RegExp(`DAEMON_CONFIG\\.${arm}`).test(setUp), true);
    }
    check('and adoption starts with no code at all', /startLocalDaemon\("",\s*""\)/.test(setUp), true);
    // Adoption before re-minting: a new code is a new fingerprint, so re-minting re-enrolls and rotates the tunnel key on every launch.
    check(
      "and adoption comes before re-minting",
      setUp.indexOf("DAEMON_CONFIG.here") < setUp.indexOf("remintFor("),
      true,
    );
    check('only a refusal falls through to buying one', /!== "dead"/.test(setUp), true);

    // A foreign daemon in this server's root is adopted if this account sees its machine, else a sentence, only once the list is in hand (Q7.148).
    check(
      "a foreign daemon this account can see is adopted without a word",
      /status === "foreign"[\s\S]{0,300}this\.connections\.has\(/.test(setUp),
      true,
    );
    check("and one it cannot see is a sentence rather than silence", /status === "foreign"[\s\S]{0,500}FOREIGN_DAEMON_DETAIL/.test(setUp), true);
    check(
      "and the sentence waits for the machine list",
      /status === "running"\) \{\s*if \(state\.stranger\) return;\s*if \(this\.snapshot\.phase !== "ready"\) return;/.test(setUp),
      true,
    );
    // A stranger (a daemon enrolled with another control plane) is silence: any sentence about this server would be false.
    check(
      "a stranger's daemon is silence, whatever the list says",
      /state\.status === "foreign" \|\| state\.status === "running"\) \{\s*if \(state\.stranger\) return;/.test(setUp),
      true,
    );
    // `running` on the first read owes the answer `foreign` does: a sign-out leaves the previous account's child running.
    check(
      "a running daemon this account cannot see gets the same sentence",
      /state\.status === "foreign" \|\| state\.status === "running"\)[\s\S]{0,500}FOREIGN_DAEMON_DETAIL/.test(setUp),
      true,
    );
    check(
      "and foreign is answered before the running-or-starting return",
      [setUp.indexOf('state.status === "foreign"') > 0, setUp.indexOf('state.status === "foreign"') < setUp.indexOf('state.status !== "absent"')],
      [true, true],
    );
    check(
      "a live daemon this account already reaches is adopted before re-minting or buying",
      /DAEMON_CONFIG\.here[\s\S]*await localDaemon\(\)[\s\S]*this\.connections\.has\([\s\S]*remintFor\(/.test(setUp),
      true,
    );
    check("and no sentence tells anybody to move ~/.reemoat/daemon.env", /move ~\/\.reemoat\/daemon\.env aside/.test(store), false);
    check("while a file in this server's own folder still has one", /~\/\.reemoat\/servers aside/.test(store), true);
    {
      const chooseServer = strip(readFileSync(new URL("../src/ui/ChooseServer.tsx", import.meta.url), "utf8"));
      check("the server picker reads no daemon capability any more", /canHostDaemon/.test(chooseServer), false);
    }

    // `bootstrap` has three callers, so two racing setups would each read absent and each buy a machine.
    check("the setup flow is single-flight", /this\.settingUp \?\?=/.test(store), true);
    // Released, never latched: a latched guard would make Retry a no-op for setup until the app restarts.
    check("and it is released when the run settles", /\.finally\(\(\) => \{\s*this\.settingUp = null;/.test(store), true);
    check("the setup flow settles rather than assuming a spawn worked", /settleDaemon\(/.test(setUp), true);
    const settle = /private async settleDaemon\([\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
    const remint = /private async remintFor\([\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
    check("and the settle loop exists to be checked", settle.length > 0, true);
    // The notice is a sentence pointing at Settings → Logs, never the daemon's output; both halves, since a negative alone passes over silence.
    check("and the settle loop never puts the daemon's output in the notice", /state\.detail/.test(settle), false);
    check("while every failure with evidence names where it is", /LOGS_POINTER|DAEMON_STOPPED_DETAIL|GAVE_UP_DETAIL/.test(settle), true);
    const pointer = /const LOGS_POINTER = "([^"]+)"/.exec(store)?.[1] ?? "";
    check("and the pointer names a real settings section", /Logs/.test(pointer), true);
    const sections = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
    check("which the section table actually has", /title: "Logs"/.test(sections), true);
    // Retry on the exit status, never on log text the daemon is free to reword.
    check("and it never pattern-matches the log to decide", /code_unusable|code_rejected/.test(settle), false);
    check("a mint answers a refused code and nothing else", /DAEMON_EXIT\.codeRefused/.test(settle), true);
    check("a slow start is waited out, not called a failure", /SETUP_SLOW_POLL_MS/.test(settle), true);
    check("a failed adoption can still provision", /provisionOver\(\)/.test(settle), true);
    const provision = /private async provisionOver\([\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
    check("and buying there asks the shared predicate too", /mayAddMachine\(/.test(provision), true);
    check("a control plane that could not be reached is not reported as a bad code", /!== "dead"/.test(settle), true);
    // `foreign` inside a settle means the started child is gone and never enrolled, so it is not success.
    check("a foreign daemon does not clear the notice", /status === "foreign"/.test(settle), true);
    check("and only a daemon this app started does", /status === "running"[\s\S]{0,120}setup: null/.test(settle), true);
    check(
      "and the settle loop's running arm asks nothing about the list",
      /status === "running"\) \{\s*this\.patch\(\{ setup: null \}\);\s*await this\.machinesChanged\("machine-added"\);\s*return;\s*\}/.test(settle),
      true,
    );
    check("a stranger in the settle loop gets its own sentence", /state\.stranger \? STRANGER_DAEMON_DETAIL : ANOTHER_DAEMON_DETAIL/.test(settle), true);
    {
      const raw = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
      const strangerSaid = /const STRANGER_DAEMON_DETAIL =\s*`\$\{DAEMON_STOPPED_DETAIL\} ` \+\s*"([^"]+)";/.exec(raw)?.[1] ?? "";
      check("which was found to read", strangerSaid.length > 0, true);
      check("and never calls the other daemon this server's", /for this server/.test(strangerSaid), false);
      check("and says whose it is", /for a different server/.test(strangerSaid), true);
      const logs = strip(readFileSync(new URL("../src/ui/settings/LogsSection.tsx", import.meta.url), "utf8"));
      check("the logs screen reads the flag off the poll", /setStranger\(state\?\.stranger === true\)/.test(logs), true);
      const foreignSaid = /case "foreign":\s*return stranger\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)";/.exec(logs);
      check("and picks its foreign sentence by it", foreignSaid !== null, true);
      check(
        "a stranger's is about a different server, and the other names this one",
        [/found here is for a different server/.test(foreignSaid?.[1] ?? ""), /The daemon for this server/.test(foreignSaid?.[2] ?? "")],
        [true, true],
      );
    }
    // Only a named refusal means the machine is gone: the default must be the answer that spends nothing.
    for (const code of ["machine_not_found", "machine_revoked"] as const) {
      check(`a dead claim is ${code}`, remint.includes(code), true);
    }
    check("and the mint failure is classified rather than swallowed", /ApiError\.isApiError\(/.test(remint), true);
  }

  // Asserted against the server's `MACHINE_LABEL` pattern: a label it refuses is a 400 nobody can act on, and duplicates are refused case-insensitively.
  {
    const { machineLabelFor } = await import("../src/store.js");
    const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    const cases: [string | null, string][] = [
      ["Rendss-MacBook-Pro", "an ordinary host name survives intact"],
      ["Ann's Mac", "an apostrophe becomes a separator rather than vanishing"],
      ["--weird--", "leading punctuation is dropped, since a label must start alphanumeric"],
      ["...", "a name with nothing usable in it still yields a label"],
      ["", "so does an empty one"],
      [null, "and so does no name at all"],
      ["Ы-машина", "and a name in another script"],
      ["x".repeat(200), "and one far past the length bound"],
    ];
    for (const [input, name] of cases) {
      check(name, LABEL.test(machineLabelFor(input)), true);
    }
    check(
      "two names that differ only in punctuation stay different machines",
      machineLabelFor("Anns Mac") !== machineLabelFor("Ann's Mac"),
      true,
    );
    // Named after the host, never `local`: to a phone or anybody holding a grant, `local` names another computer.
    const storeSrc = stripComments(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
    const creating = /private async createForThisComputer\([\s\S]*?\n  \}/.exec(storeSrc)?.[0] ?? "";
    check("createForThisComputer was found to read", creating.length > 0, true);
    check("the machine this app sets up is named after the computer", /const base = machineLabelFor\(boot\.hostName\)/.test(creating), true);
    check("and nothing there names a machine `local`", /"local"/.test(creating), false);
    check("the constant that used to is gone", /LOCAL_MACHINE_NAME/.test(storeSrc), false);

    // `machineLabelFor` slices to 64 last, so the base is cut to 61 before the suffix or the retry re-posts the name that collided.
    check("a disambiguated name is still a label", LABEL.test(machineLabelFor(`${machineLabelFor(null)}-2`)), true);
    const longest = machineLabelFor("x".repeat(200));
    check("a maximal label is the full sixty-four", longest.length, 64);
    check("and re-shaping it with a suffix gives the name back", machineLabelFor(`${longest}-2`), longest);
    check("so the retry slices first", machineLabelFor(`${longest.slice(0, 61)}-2`).endsWith("-2"), true);
    check("and the code does the slicing", /base\.slice\(0, 61\)/.test(creating), true);
  }

  // A census of UI files asking the predicate against the list: a count cannot see a skipped door.
  const quotaDoors = [
    "ui/AppShell.tsx",
    "ui/SessionBrowser.tsx",
    "ui/MachineColumn.tsx",
    "ui/NewSession.tsx",
    "ui/settings/MachinesSection.tsx",
  ];
  const asksQuota = srcFiles()
    .filter((file) => file.startsWith("ui/"))
    .filter((file) => /mayAddMachine\(/.test(strip(srcFile(file))))
    .sort();
  check("every door the quota gates is on the list, and nothing else is", asksQuota, [...quotaDoors].sort());
  for (const file of quotaDoors) {
    const src = strip(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
    check(`${file} asks the shared predicate`, /mayAddMachine\(/.test(src), true);
    check(`${file} never re-derives it from the fields`, /machineLimit|machineCount|canAddMachine/.test(src), false);
    check(`${file} never counts the machine list instead`, /machines\.length\s*>=?\s*[A-Za-z]/.test(src), false);
  }

  // One writer for the chosen folder: the picker reports up on its own `path`, so a parent write to `cwd` is unrecoverable.
  {
    const src = strip(readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"));
    check("nothing but the picker clears the chosen folder", /setCwd\(null\)/.test(src), false);
    check("the picker is keyed on the machine", /<DirectoryPicker\s+key=\{selected\}/.test(src), true);
    check("and reports the absence of a folder too", /if \(path !== null\) onPick/.test(src), false);
    check("reporting it unconditionally instead", /onPick\(path\);/.test(src), true);
    // Keyed on `path` alone: `osDialog` arriving after the first render would re-fire the report as a second writer.
    check("and the report is keyed on the folder and nothing else", /onPick\(path\);\s*\}, \[path\]\);/.test(src), true);
    check("a cancelled panel is not a choice", /if \(picked !== null\) setPath\(picked\);/.test(src), true);
    check("there is one route to making a folder, and it is the tree's", (src.match(/\.makeDir\(/g) ?? []).length, 1);
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/MachinesSection.tsx", import.meta.url), "utf8"));
    // Both indices are guarded with `>= 0`, since -1 is less than every position; the door is the one-line installer, never a by-name form.
    const asks = src.indexOf("mayAddMachine(");
    const door = src.indexOf("<CommandLine");
    check("the screen still asks whether a machine may be added", asks >= 0, true);
    check("and the one-line installer is the door it gates", door >= 0, true);
    check("with no by-name form beside it", /<AddMachine/.test(src), false);
    report(
      "the door is downstream of the check that it is offerable",
      asks >= 0 && door >= 0 && asks < door,
      `${asks} < ${door}`,
    );
    const listHeading = src.indexOf("Your machines");
    const addHeading = src.indexOf("Add a machine");
    check("the installer sits under its own heading", addHeading >= 0, true);
    check("with no sentence introducing it", /host running the daemon|run this on it/.test(src), false);
    check("and the list comes first", listHeading >= 0 && addHeading >= 0 && listHeading < addHeading, true);
    const skeletons = src.split("<SkeletonRow").length - 1;
    check("one skeleton row stands in for the first listing", skeletons, 1);
    check("and it is asked before the empty state is claimed", src.indexOf("<SkeletonRow") < src.indexOf("No machines yet."), true);
    const outageOwn = /<Empty failed>\{CONTROL_PLANE_UNREACHABLE\} ([^<{]+)<\/Empty>/.exec(src)?.[1] ?? null;
    check("the outage arm draws the shared sentence and keeps its own second one", outageOwn !== null, true);
    {
      const { CONTROL_PLANE_UNREACHABLE } = await import("../src/account.js");
      check("at the eight-word empty-state cap", `${CONTROL_PLANE_UNREACHABLE} ${outageOwn ?? ""}`.trim().split(/\s+/).length, 8);
    }
    check("imported from where the sibling sentences live", /import \{ CONTROL_PLANE_UNREACHABLE \} from "\.\.\/\.\.\/account";/.test(src), true);
    check("and the old spelling is gone", /Control plane unreachable/.test(src), false);
    check("a machine you do not own carries a `shared` badge", /"shared"/.test(src), true);
    check("and no longer says so in the subline", /not yours to rename or retire/.test(src), false);
    // `this device` outranks `shared`, since the badge is the only thing saying which row you are at; a state badge outranks both.
    check(
      "with the state badge outranking both",
      /machineBadgeText\(machine\)[\s\S]{0,260}\?\? \(isThisDevice \? "this device" : machine\.owned === true \? null : "shared"\)/.test(src),
      true,
    );
    check("and `this device` comes from the store rather than from the route", /isThisDevice=\{machine\.id === state\.localMachineId\}/.test(src), true);
    check("never from the routing preference, which can be switched off", /route[\s\S]{0,40}=== "local"/.test(src), false);
    // A setup code is offered before enrollment and never after (Q3.428), pinned on `mintEnrollment`, the call itself.
    check("the list never mints a code for a machine already on it", /mintEnrollment/.test(src), false);
    // A machine is added from a terminal: the poll re-lists an empty fleet and re-reads `me` once the first one lands.
    check(
      "nothing on this screen adds a machine by name",
      /machinesChanged\("machine-added"\)|"\/v1\/machines",\s*\{\s*method:\s*"POST"/.test(src),
      false,
    );
    {
      const storeSrc = strip(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
      check("an empty fleet is re-listed by the poll rather than waiting for a wake", /resume\(this\.snapshot\.phase === "loading" \? "cp-retry" : "awaiting-first-machine"\)/.test(storeSrc), true);
      check("and the first machine landing re-reads who you are", /if \(this\.connections\.size > 0 && epoch === this\.epoch\) await this\.refreshMe\(\);/.test(storeSrc), true);
    }
    const machineSrc = strip(
      readFileSync(new URL("../src/ui/settings/MachineSection.tsx", import.meta.url), "utf8"),
    );
    check("a setup code is offered only before a machine has enrolled", /!machine\.enrolled &&/.test(machineSrc), true);
    check(
      "the not-enrolled state is eight words with its remedy",
      /Not enrolled yet\.\s*\{setupOffered \? " Use the setup code above\." : ""\}/.test(machineSrc),
      true,
    );
    check("and no longer names the machine or its daemon", /has not enrolled yet|Start its daemon/.test(machineSrc), false);
    check("the machine's own screen says it is not yours to rename or retire", /This machine is not yours to rename or retire\./.test(machineSrc), true);
    check("retiring one re-reads who you are too", /machinesChanged\("machine-revoked"\)/.test(machineSrc), true);
    check(
      "neither goes through resume alone",
      /resume\("machine-(added|revoked)"\)/.test(src) || /resume\("machine-(added|revoked)"\)/.test(machineSrc),
      false,
    );
    check("a rename still does not", /resume\("machine-renamed"\)/.test(machineSrc), true);
    // Retiring must leave the screen before the store drops the machine, or it reads as missing from your list (Q3.432).
    // The store's drop is handed to `navigate` and runs in the route's own flush, so the list is told at once.
    const leavesScreen = machineSrc.indexOf("navigate(settingsPath(\"machines\"), true, () => store.forgetMachine(machine.id))");
    const dropsMachine = machineSrc.indexOf("machinesChanged(\"machine-revoked\")");
    check("retiring navigates away from the machine's screen with the store's drop in the route's own flush", leavesScreen >= 0, true);
    check("and drops it nowhere else", machineSrc.split("store.forgetMachine(").length - 1, 1);
    check("and still tells the store the machine is gone", dropsMachine >= 0, true);
    check(
      "and retiring leaves the screen before the re-list",
      leavesScreen >= 0 && dropsMachine >= 0 && leavesScreen < dropsMachine,
      true,
    );
    {
      const routerSrc = strip(readFileSync(new URL("../src/router.ts", import.meta.url), "utf8"));
      check("the router runs that work inside the flush that tells the route, under a transition", /flushSync\(\(\) => \{\s*tell\(\);\s*alongside\?\.\(\);\s*\}\);/.test(routerSrc), true);
      check("and on the instant path", /tell\(\);\s*alongside\?\.\(\);\s*return;/.test(routerSrc), true);
      check("and popstate passes none", /addEventListener\("popstate", \(\) => announce\(\)\)/.test(routerSrc), true);
      const storeSrc = strip(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
      check("and the store's forget is the re-list's own drop, published whole", /forgetMachine\(id: MachineId\): void \{\s*this\.dropMachine\(id\);\s*this\.emit\(\);\s*\}/.test(storeSrc), true);
    }
    // Retire's cost is `TwoStep`'s consequence, drawn only while armed, and the question names the machine (Q3.218, Q3.552).
    const question = machineSrc.indexOf("Retire {machine.name}?");
    const cost = machineSrc.indexOf('consequence="Frees the name and a slot.');
    const branch = machineSrc.indexOf("armed={confirming}");
    check("the retire confirmation names the machine", question >= 0, true);
    check("and states the cost", cost >= 0, true);
    // Where the element closes: its own `/>` on a line of its own, since a `<>…</>` fragment inside `question` carries a `/>` too.
    check("only inside the confirming arm", branch >= 0 && cost > branch && cost < branch + machineSrc.slice(branch).search(/^\s*\/>/m), true);
    check("with nothing of it drawn at rest", /voids any outstanding setup code|loses it silently/.test(machineSrc), false);
    // Minting and retiring hold separate locks; the retire's wait is `TwoStep`'s (Q3.552).
    check(
      "minting holds its own flag and the retire's wait is the primitive's",
      [/setMinting\(/.test(machineSrc), /setRetiring\(/.test(machineSrc), /onAct=\{revoke\}/.test(machineSrc)],
      [true, false, true],
    );
    check("and Retire's resting button is not locked by a mint", /rest=\{\s*<DangerButton icon=\{Trash2\} onClick=\{\(\) => setConfirming\(true\)\}>/.test(machineSrc), true);
    check("the retire toast carries no facts nothing can re-read", /enrollment code.*stopped working|expire within/.test(machineSrc), false);
    check("the unreachable line names the reason and stops", /so its systems, agents and plugins/.test(machineSrc), false);
    // `enrolledBy` is the only disclosure that somebody else enrolled a machine for you, so a client drawing nothing hides it.
    {
      const { enrolledByText } = await import("../src/wire.js");
      // `null` (unknown) and `undefined` (an older control plane) are both silence: the one place two absences may collapse.
      check("nobody is named where the reader enrolled it themselves", enrolledByText(null), null);
      check("nor on a control plane that predates the field", enrolledByText(undefined), null);
      check("nor on an empty name, which would otherwise draw a sentence with nobody in it", enrolledByText(""), null);
      check("somebody else's code names them", enrolledByText("casey"), "Enrolled by casey");
      check("a provisioning key is named as one", enrolledByText("a provisioning key"), "Enrolled by a provisioning key");
      check("and so is an account that has gone since", enrolledByText("a deleted account"), "Enrolled by a deleted account");
      check(
        "a machine enrolled before this was recorded says so rather than nothing",
        enrolledByText("somebody this control plane did not record"),
        "Enrolled by somebody this control plane did not record",
      );
      check("the fragment carries no punctuation of its own", /[.!?]$/.test(enrolledByText("casey") ?? ""), false);
    }
    // Nothing typed can hold a placement, so both surfaces are read off disk.
    check("the list row draws it as a subline of its own", /\{provenance !== null && <span className="block truncate text-2xs text-muted">\{provenance\}<\/span>\}/.test(src), true);
    check("the machine's own screen draws it as a sentence", /\{provenance !== null && <p className="mt-1 text-xs text-muted">\{provenance\}\.<\/p>\}/.test(machineSrc), true);
    check(
      "both from the one shared sentence",
      [
        /const provenance = enrolledByText\(machine\.enrolledBy\);/.test(src),
        /const provenance = enrolledByText\(machine\.enrolledBy\);/.test(machineSrc),
      ],
      [true, true],
    );
    check(
      "and neither spells it by hand",
      [/["`>]Enrolled by/.test(src), /["`>]Enrolled by/.test(machineSrc)],
      [false, false],
    );
    // Provenance may not ride the truncating `standing` line, which also turns over on every poll.
    const standingExpr = /const standing =([\s\S]*?);\n/.exec(src)?.[1] ?? "";
    check("the standing line is still there to be kept clear of", standingExpr.length > 0, true);
    check("and carries no part of the provenance", /provenance|enrolledBy/.test(standingExpr), false);
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/UsersSection.tsx", import.meta.url), "utf8"));
    check("the admin panel validates with the shared rule", /machineLimitProblem\(/.test(src), true);
    check(
      "the lowering toast is six words and names the count",
      /`\$\{n\} machine\$\{n === 1 \? "" : "s"\} stopped; raise the limit\.`/.test(src),
      true,
    );
    check("and states the consequence before lowering", /machineLimitChangeNotice\(/.test(src), true);
    check(
      "and the decision to confirm is that function's answer",
      /consequence\s*===\s*null\s*\?/.test(src) && /consequence\s*=\s*dirty\s*\?\s*machineLimitChangeNotice\(/.test(src),
      true,
    );
    // Lowering undoes itself once raised again, so it is `TwoStep`'s plain act, never a `DangerButton`.
    check("lowering is not dressed as irreversible", /DangerButton[\s\S]{0,200}Save limit/.test(src), false);
    check("and both acts are plain", [/act=\{\{ label: "Save limit" \}\}/.test(src), /act=\{\{ label: "Use the default" \}\}/.test(src)], [true, true]);
    // `busy` is held in `apply`, which every write goes through, and a one-tap write resets the arming flag.
    check(
      "every write holds the panel's busy, from the promise it hands over",
      /const apply = \(work: Promise<cp\.MachineLimitAnswer>\): Promise<void> => \{\s*setBusy\(true\);\s*return work\s*\.then\(/.test(src) && /onChanged\(\);\s*\}\)\s*\.finally\(\(\) => setBusy\(false\)\);\s*\};/.test(src),
      true,
    );
    check("and a one-tap write puts the arming flag back", /const write = \(work: Promise<cp\.MachineLimitAnswer>\): void => \{\s*void apply\(work\)\s*\.then\(\(\) => setConfirming\(null\)\)/.test(src), true);
    // An admin draws nobody's keys: no key panel on the users screen and no admin key function in `cp.ts` (Q1.631).
    check("the users screen imports nothing from KeyRow", /from "\.\/KeyRow"/.test(src), false);
    check("and names neither admin key function", [/adminUserKeys/.test(src), /adminRevokeKey/.test(src)], [false, false]);
    check("and offers no API keys item", /"API keys"/.test(src), false);
    const cpSrc = strip(readFileSync(new URL("../src/cp.ts", import.meta.url), "utf8"));
    check(
      "and cp.ts exports neither",
      [/export (?:async )?function adminUserKeys\b/.test(cpSrc), /export (?:async )?function adminRevokeKey\b/.test(cpSrc)],
      [false, false],
    );
    check("nor declares a keys count on the fleet row", /^\s*keys\?: number;/m.test(cpSrc), false);
    check("a failed user listing says so with Try again wired to refresh", /\{error !== null && \(\s*<Empty failed action=\{<Button size="sm" onClick=\{refresh\}>Try again<\/Button>\}>\s*\{error\}\s*<\/Empty>\s*\)\}/.test(src), true);
    // One panel per row, as a union of one (Q1.631): the next panel is a member, never a boolean beside it.
    check("the row's panels are one union, of one", /type RowPanel = "limit" \| null;/.test(src), true);
    check("held in one state per row", (src.match(/useState<RowPanel>\(null\)/g) ?? []).length, 1);
    check("and the one panel is gated on it", [/\{panel === "limit" && \(/.test(src), /panel === "keys"/.test(src)], [true, false]);
    const adminBox = src.indexOf('type="checkbox"');
    const createButton = src.indexOf('type="submit"');
    check("the admin checkbox is drawn", adminBox >= 0, true);
    check("and so is Create", createButton >= 0, true);
    check("and the checkbox comes first", adminBox >= 0 && createButton >= 0 && adminBox < createButton, true);
    check("the grant sentence has left the screen", /cpctl admin grant/.test(src), false);
    check("and the empty arm is one somebody can reach", /Only you so far\./.test(src), true);
    check("and \"Nobody yet\" is not drawn over a list that always has you in it", /Nobody yet/.test(src), false);
    // The panel's direction is measured on the tap, never taken from the index.
    check(
      "the kebab's direction is measured, not indexed",
      /menuPlacement\(/.test(src) && !/openUp/.test(src) && !/index/.test(src.slice(src.indexOf("setPlacement") - 200, src.indexOf("setPlacement") + 200)),
      true,
    );
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/ServerSection.tsx", import.meta.url), "utf8"));
    check("the settings key is named once, not written out", /"machines\.per_user"/.test(src), false);
    report(
      "and reached through the shared constant",
      src.split("MACHINE_LIMIT_KEY").length - 1 >= 4,
      `${src.split("MACHINE_LIMIT_KEY").length - 1} uses`,
    );
    // An admin is subject to the limit they changed, so saving re-reads their own quota.
    check("saving a server setting re-reads the admin's own quota", /refreshMe\(\)/.test(src), true);
    check("the fleet consequence is drawn only in the confirm arm", /armed=\{confirming && consequence !== null\}/.test(src) && /question=\{consequence\}/.test(src), true);
    // Every write goes through `write`, which holds `busy`, and a one-tap write resets the arming flag.
    check(
      "the limit's every write holds the section's busy, from the promise it hands over",
      /const write = \(patch: \{ set\?: Record<string, string>; clear\?: string\[\] \}\): Promise<void> => \{\s*setBusy\(true\);\s*return cp\s*\.adminSaveSettings\(patch\)\s*\.then\([\s\S]*?\)\s*\.finally\(\(\) => setBusy\(false\)\);\s*\};/.test(src),
      true,
    );
    check("and the primitive's act is refused while one is out", /onAct=\{\(\) => write\(savePatch\(\)\)\}\s*disabled=\{busy\}/.test(src), true);
    check(
      "and a one-tap write on the fleet limit puts the arming flag back",
      /const writeNow = \(patch: \{ set\?: Record<string, string>; clear\?: string\[\] \}\): void => \{\s*void write\(patch\)\s*\.then\(\(\) => setConfirming\(false\)\)/.test(src),
      true,
    );
  }
}

process.stdout.write("\na re-probe is not the host going away, and asking is not failing\n");
{
  const { daemonRead, daemonReadable } = await import("../src/machine.js");
  const { reachText, OFFLINE_TEXT } = await import("../src/ui/bits.js");
  const mach = stripComments(readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8"));

  check("a machine that answered is readable", daemonReadable("online"), true);
  check("one that did not answer is not", daemonReadable("offline"), false);
  check("nor is one never asked", daemonReadable("unknown"), false);
  check("⭐ nor is one whose probe has not answered yet", daemonReadable("probing"), false);

  // `unknown`/`probing` (no answer yet) and `offline` (did not answer) are one false to `daemonReadable`; only `offline` has earned "not reachable".
  check(
    "the partition tells the two falses apart",
    [daemonRead("online"), daemonRead("probing"), daemonRead("offline"), daemonRead("unknown")],
    ["readable", "asking", "unreachable", "asking"],
  );
  // `daemonReadable` is derived from `daemonRead`, so the two cannot drift apart.
  check(
    "and the boolean is exactly its first arm, at every value",
    (["unknown", "probing", "online", "offline"] as const).filter(
      (reach) => daemonReadable(reach) !== (daemonRead(reach) === "readable"),
    ),
    [],
  );
  check("derived rather than stated a second time", /return daemonRead\(reach\) === "readable";/.test(mach), true);

  // A re-probe keeps the answer held, online or offline; webcheck.local-route.ts drives it and records every publish.
  check(
    "only a first probe publishes probing",
    /if \(this\.reach === "unknown"\) \{\s*this\.reach = "probing";\s*this\.onChange\(\);\s*\}/.test(mach),
    true,
  );
  check("and nothing else assigns it", (mach.match(/this\.reach = "probing"/g) ?? []).length, 1);

  // Reasons come from `OFFLINE_TEXT`'s keys, never re-typed: a hand list cannot notice the table growing.
  const REASONS = [null, ...(Object.keys(OFFLINE_TEXT) as (keyof typeof OFFLINE_TEXT)[])];
  const phrases = (["unknown", "probing", "online", "offline"] as const).flatMap((reach) =>
    REASONS.map((reason) => reachText(reach, reason)),
  );
  check("the sweep found every reach and every reason", phrases.length, 4 * (Object.keys(OFFLINE_TEXT).length + 1));
  report(
    "and the table it swept is the shipped one",
    Object.keys(OFFLINE_TEXT).length > 0,
    `${String(Object.keys(OFFLINE_TEXT).length)} reasons`,
  );
  check("and none of them is punctuation standing in for a phrase", phrases.filter((one) => !/[a-z]/.test(one)), []);
  check(
    "the four reaches read as the four things they are",
    [reachText("online", null), reachText("probing", null), reachText("unknown", null), reachText("offline", "over_limit")],
    ["online", "probing…", "not checked yet", "over the machine limit"],
  );
  check("and the one that keeps an ellipsis has a word in front of it", /^probing…$/.test(reachText("probing", null)), true);

  // Every screen branches on the partition, and only `NotReachable` in `bits.tsx` composes the sentence.
  // `MachinePluginsSection` is absent on purpose: its one caller says it for it.
  const REACH_SCREENS = [
    "ui/settings/MachineSystemsSection.tsx",
    "ui/settings/MachineAgentsSection.tsx",
    "ui/settings/MachineSection.tsx",
    "ui/AgentBuilder.tsx",
  ] as const;
  const asksTheBoolean: string[] = [];
  const claimsWithoutMeasuring: string[] = [];
  const failureNotMarked: string[] = [];
  const treatsProbingAsOutage: string[] = [];
  const composesByHand: string[] = [];
  for (const file of REACH_SCREENS) {
    const src = stripComments(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (!/daemonRead\(machine\.reach\)/.test(src) || /!daemonReadable\(/.test(src)) asksTheBoolean.push(name);
    if (/machine\.reach !== "online"/.test(src)) treatsProbingAsOutage.push(name);
    // Positional rather than by pattern: an `action` prop may sit between the tag and the words.
    const waiting = src.indexOf("Checking whether");
    const failing = src.indexOf("<NotReachable");
    const waitTag = src.slice(src.lastIndexOf("<Empty", waiting), waiting);
    const failTag = src.slice(src.lastIndexOf("<Empty", failing), failing);
    if (waiting < 0 || /\bfailed\b/.test(waitTag)) claimsWithoutMeasuring.push(name);
    if (failing < 0 || !/\bfailed\b/.test(failTag)) failureNotMarked.push(name);
    if (/is not reachable right now —/.test(src)) composesByHand.push(name);
  }
  check("every screen that draws reachability asks the partition", asksTheBoolean, []);
  check("and none of them reads a measurement in progress as an outage", treatsProbingAsOutage, []);
  // The wait carries no `failed`, so no triangle and no live region announces an outage before anything was measured.
  check("the wait is drawn as a wait", claimsWithoutMeasuring, []);
  check("and the failure is drawn as one", failureNotMarked, []);
  check("and none of them composes the sentence by hand", composesByHand, []);
  {
    const bits = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
    const start = bits.indexOf("export function NotReachable(");
    const body = start < 0 ? "" : bits.slice(start, bits.indexOf("\nexport ", start + 1));
    check(
      "the one place the sentence lives composes it through reachText",
      /\{machine\.name\} is not reachable right now — \{reachText\(machine\.reach, machine\.offlineReason\)\}/.test(body),
      true,
    );
    check("and the full stop is the default ending", /tail = "\."/.test(body), true);
  }
  {
    const plugins = stripComments(
      readFileSync(new URL("../src/ui/settings/MachinePluginsSection.tsx", import.meta.url), "utf8"),
    );
    check(
      "the section whose caller says it for it does not say it twice",
      [/daemonRead\(/.test(plugins), /is not reachable right now/.test(plugins), /NotReachable/.test(plugins)],
      [false, false, false],
    );
  }

  // Exactly one of the two is announced: a failure happened, while an absence is what the reader just did.
  {
    const bits = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
    const emptyAt = bits.indexOf("export function Empty(");
    const empty = emptyAt < 0 ? "" : bits.slice(emptyAt, bits.indexOf("\n}\n", emptyAt));
    // Guarded on the index: a slice from -1 returns the tail, and every negative below would pass on it.
    check("the primitive was found", emptyAt >= 0, true);
    check("only a failure is announced", /role=\{failed \? "status" : undefined\}/.test(empty), true);
    check("and there is no second way to announce one", (empty.match(/role=/g) ?? []).length, 1);
    check(
      "an absence with nothing to do about it is the same paragraph it always was",
      /if \(!failed && action === undefined\) \{\s*return <p className="px-4 py-6 text-center text-sm text-muted">\{children\}<\/p>;/.test(empty),
      true,
    );
    check("and it takes this app's failure glyph rather than a colour", /\{failed && \(\s*<Icon as=\{AlertTriangle\}/.test(empty), true);
    // `action` is gated on itself alone, never inside the `failed` branch: an absence can have a next move too.
    check(
      "a way out is offered on its own terms rather than only on a failure",
      /\{action !== undefined && <div className="mt-3 flex justify-center">\{action\}<\/div>\}/.test(empty),
      true,
    );
  }

  // `install.ts`'s two predicates ask the same question outside JSX, so they are swept by call over every `Reach`.
  {
    const { settingsBlockFor, skipReasonFor } = await import("../src/install.js");
    const at = (reach: string): never =>
      ({
        id: "m_1",
        name: "laptop",
        scopes: ["session:read", "session:write", "machine:admin"],
        owned: true,
        overLimit: false,
        ownerDisabled: false,
        reach,
        offlineReason: null,
      }) as never;
    const pane = { version: "1.0.0", contributes: { settings: true } };
    // Installing is an act, whose request joins a probe in flight; configuring reads what is there, so it waits for the answer.
    check(
      "installing asks the partition rather than the boolean, and attempts a machine mid-probe",
      (["online", "probing", "offline", "unknown"] as const).map((reach) => skipReasonFor(at(reach))),
      [null, null, "unreachable", "asking"],
    );
    check(
      "and configuring asks it at every reach",
      (["online", "probing", "offline", "unknown"] as const).map((reach) => settingsBlockFor(at(reach), pane)),
      [null, "asking", "unreachable", "asking"],
    );
    check(
      "so a machine nobody has asked is never reported as one that did not answer",
      [skipReasonFor(at("unknown")) === skipReasonFor(at("offline")), daemonReadable("unknown") === daemonReadable("offline")],
      [false, true],
    );
  }

  // Each docblock in `bits.tsx` and `machine.ts` must name `REACH_SCREENS`, so a reader finds this list rather than a copy of it.
  {
    const bitsRaw = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
    const machineRaw = readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8");
    check(
      "both docblocks that restate this list send the reader to it",
      [bitsRaw.includes("REACH_SCREENS"), machineRaw.includes("REACH_SCREENS")],
      [true, true],
    );
  }
}

process.stdout.write("\nsaving a credential while a chat is open\n");
{
  const { credentialToast } = await import("../src/ui/settings/AgentsPanel.js");

  check("one chat is singular", credentialToast(false, 1), "Saved. 1 chat is restarting to pick it up.");
  check("and several are not", credentialToast(false, 3), "Saved. 3 chats are restarting to pick it up.");
  check("removing says removed", credentialToast(true, 2), "Removed. 2 chats are restarting without it.");
  check("nothing to restart keeps the old sentence", credentialToast(false, 0), "Saved. Checking whether it works…");
  check("and a removal with nothing to relaunch ends there", credentialToast(true, 0), "Removed.");
  check("and a daemon that does not say is not read as zero", credentialToast(false, undefined), "Saved. Checking whether it works…");
}

process.stdout.write("\na sign-in that is not offered\n");
{
  const panel = stripComments(readFileSync(new URL("../src/ui/settings/AgentsPanel.tsx", import.meta.url), "utf8"));
  const { stanceLine, osName } = await import("../src/ui/agentCard.js");

  // The system's name comes from the daemon: the refusal covers every BSD, and a hardcoded macOS would be false on FreeBSD.
  check("the sentence names the system", stanceLine({ id: "claude" }, "signed_out", false, "darwin"), "macOS can't run Claude Code's own sign-in, so a saved key is the only way in.");
  check("and a different BSD gets its own name", osName("freebsd"), "FreeBSD");
  check("while a daemon that does not say names nothing", osName(undefined), "This machine");
  check("a wizard that can run says nothing at all", stanceLine({ id: "claude" }, "signed_out", true, "darwin"), null);
  // `installable` picks which of two true sentences the not-installed arm draws; the panel passes the `canInstall` conjunction, not `installable` alone.
  const installDecision = /const canInstall = agent\.installable === true && !noInstallRoute;/.test(panel);
  check(
    "and the panel passes the platform through, and whether it can install",
    [/stanceLine\(agent, stance, canSignIn, os, canInstall\)/.test(panel), installDecision],
    [true, true],
  );
  check(
    "an older daemon that sends no such field keeps the sentence it always had",
    [
      stanceLine({ id: "claude" }, "not_installed", false, "darwin"),
      stanceLine({ id: "claude" }, "not_installed", false, "darwin", true),
    ],
    [
      "Claude Code isn't installed. Install it on the machine itself.",
      "Claude Code isn't installed on this machine.",
    ],
  );

  check("the command is rendered inside the credential slot", /howTo !== null && editable && <CommandLine/.test(panel), true);
  check("and only on the slot that command actually fills", /slot\.envName === "CLAUDE_CODE_OAUTH_TOKEN"/.test(panel), true);
  check("and only where the wizard cannot run", /login\.blocked === "interactive_pty"/.test(panel), true);
  check("naming the command the CLI really has", /"claude setup-token"/.test(panel), true);
  const commandLine = stripComments(readFileSync(new URL("../src/ui/CommandLine.tsx", import.meta.url), "utf8"));
  check("the copy control is a sibling of the field, not an overlay on it", /items-stretch/.test(commandLine), true);
  check("so it cannot be positioned out of the box it belongs to", /absolute top-/.test(commandLine), false);
  check("the button is still gated on supported, not on the reason", /login\.supported && agent\.available/.test(panel), true);

  {
    const bits = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
    check("the field constant states its height", /export const FIELD =\s*\n?\s*"min-h-9/.test(bits), true);
    check("and carries no padding for a caller to lose to", /export const FIELD =\s*\n?\s*"[^"]*\bpy-\d/.test(bits), false);
    check("with the touch floor written down beside it", /export const FIELD =[\s\S]{0,240}\[@media\(pointer:coarse\)\]:min-h-11/.test(bits), true);
    check("and no second field constant to drift from it", /FIELD_SM/.test(bits), false);

    check("the key field uses the standard one", /\$\{FIELD\} min-w-0 flex-1 font-mono/.test(panel), true);
  {
    const withFields = readdirSync(new URL("../src/ui/settings/", import.meta.url))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => readFileSync(new URL(`../src/ui/settings/${f}`, import.meta.url), "utf8"));
    for (const extra of ["SignIn.tsx", "ForcedPasswordChange.tsx", "gate/Gate.tsx", "gate/GateCard.tsx"]) {
      withFields.push(readFileSync(new URL(`../src/ui/${extra}`, import.meta.url), "utf8"));
    }
    const offenders = withFields.filter((src) => /\$\{FIELD\}[^`]*\bpy-\d/.test(src)).length;
    report("no screen composes FIELD with a padding that cannot win", offenders === 0, `${withFields.length} files scanned`);
  }
    check("the command box states the same height", /flex min-h-9 items-stretch/.test(commandLine), true);
    check(
      "and the same floor, so the two cannot drift",
      [/\[@media\(pointer:coarse\)\]:min-h-11/.test(panel), /\[@media\(pointer:coarse\)\]:min-h-11/.test(commandLine)],
      [true, true],
    );
  }
  check("and its width is left alone", /max-w-80/.test(panel), false);

  // Remove's target reaches 10px past its face, so it keeps an extra 4px where the row tightens to an 8px gap.
  check("the field and Save sit closer", /mt-3 flex gap-2/.test(panel), true);
  check("and Remove carries the room its own target needs", /tone="destructive"[\s\S]{0,220}className="ml-1"/.test(panel), true);
  check("with Save wide enough to hold its label", /min-w-20/.test(panel), true);
}

process.stdout.write("\nimporting a codebase\n");
{
  const src = stripComments(readFileSync(new URL("../src/ui/ImportCode.tsx", import.meta.url), "utf8"));
  const picker = stripComments(readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"));
  const client = stripComments(readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8"));

  const { importFailure } = await import("../src/ui/ImportCode.js");
  const { ApiError } = await import("../src/http.js");
  const envelope = (status: number, code: string, detail: unknown = null): unknown =>
    new ApiError(status, code, "refused", detail, { error: { code, detail } });
  /** What `parseBody` makes of a response carrying no envelope at all. */
  const bare = (status: number): unknown =>
    new ApiError(status, `http_${status}`, "Not Found", null, null);

  check(
    "a daemon with no such route is named as old rather than shown a 404",
    importFailure(bare(404)).includes("too old"),
    true,
  );
  // The 404 is probed before the archive moves: an old daemon refusing mid-upload surfaces through the relay as a 502.
  // This sheet has no route, so `Sheet`'s default close would navigate past it; the caller hands `onClose`, taken as an override.
  const sheet = stripComments(readFileSync(new URL("../src/ui/Sheet.tsx", import.meta.url), "utf8"));
  check("the import sheet closes back to the form rather than out of it", /onClose=\{onClose\}/.test(src), true);
  check("and its chevron goes to the same place", /up=\{onClose\}/.test(src), true);
  check("and names where that is", /upLabel="New session"/.test(src), true);
  check("which is a thing only a caller can hand over", /const close = onClose \?\?/.test(sheet), true);
  // `POST /fs/import` is one at a time per machine, so an abandoned upload is aborted or it holds the lock.
  check("an abandoned upload does not keep the machine's import lock", /useEffect\(\(\) => \(\) => abort\.current\?\.abort\(\), \[\]\)/.test(src), true);

  check("the route is probed before any bytes are sent", /importSupported\(\)/.test(src), true);
  check(
    "and the upload only starts once that has answered",
    src.indexOf("importSupported()") < src.indexOf("importArchive("),
    true,
  );
  check(
    "with the probe carrying no body of its own",
    /await this\.machine\.request\("\/fs\/import", \{ method: "POST" \}\)/.test(client),
    true,
  );
  // A tunnel can still die for its own reasons, so the code keeps a sentence.
  check(
    "and a stream that dies mid-upload still says something actionable",
    importFailure(envelope(502, "tunnel_failed")).includes("Try again"),
    true,
  );
  check(
    "and a 404 that *is* this system's own is not",
    importFailure(envelope(404, "not_found")).includes("too old"),
    false,
  );
  check(
    "nothing reads the daemon's version to decide that",
    /DAEMON_VERSION|daemonVersion/.test(src),
    false,
  );
  check(
    "a name collision says which name",
    importFailure(envelope(409, "import_exists", { name: "my-app" })).includes("my-app"),
    true,
  );
  check(
    "and survives a detail that is not the shape it expected",
    typeof importFailure(envelope(409, "import_exists", "nonsense")),
    "string",
  );
  for (const code of ["archive_unsafe", "unsupported_archive", "import_busy", "import_too_large"]) {
    check(`${code} draws a sentence of its own`, importFailure(envelope(400, code)) !== code, true);
  }

  check("the text being copied is rendered, not only put on the clipboard", /\{IMPORT_SKILL\}/.test(src), true);
  check("in a box that scrolls on its own", /overflow-y-auto/.test(src), true);
  check("without dragging the sheet behind it when it ends", /overscroll-contain/.test(src), true);
  check("and the control over it carries an icon rather than a word", /as=\{Copy\}/.test(src), true);
  check("the tick is mounted beside it rather than swapped in", /as=\{Check\}/.test(src), true);
  check("and neither is drawn conditionally", !/\{copied \? <Icon|copied \? \(/.test(src), true);
  check("they cross-fade instead", (src.match(/transition-opacity/g) ?? []).length >= 2, true);
  check("and it takes itself down again", /setCopied\(false\), 1400\)/.test(src), true);
  check("with the name following it, for anybody who cannot see either glyph", /aria-label=\{copied \? "Copied" : "Copy to clipboard"\}/.test(src), true);
  // Lit only on a copy that worked: an absent clipboard, as on every LAN origin, is not a refusal (see `clipboard.ts`).
  check("and it is only ever lit on a copy that worked", !/setCopied\(ok\)/.test(src), true);

  // Machine already means an enrolled host on this screen, so the instructions may not use it for the source; the refusals are exempt.
  {
    const steps = [...src.matchAll(/\stext="([^"]*)"/g)].map((m) => m[1] ?? "");
    const intro = /<p className="text-sm text-muted">([^<]*)<\/p>/.exec(src)?.[1] ?? "";
    const lines = [intro, ...steps].filter((line) => line.length > 0);
    report(
      "the instructions never call the source a machine",
      lines.length >= 4 && lines.every((line) => !/machine/i.test(line)),
      `${lines.length} lines checked`,
    );
    check("naming the project instead, which cannot be one", /that project/.test(steps.join(" ")), true);
  }

  check("dragover preventDefaults, or drop never fires", /onDragOver=\{[\s\S]*?preventDefault\(\)/.test(src), true);
  check("and the drop target is the body rather than the box alone", /onDrop=\{/.test(src), true);

  check("the picker is moved to the path the daemon answered", /onImported\(answer\.import\.path\)/.test(src), true);
  check("and only after it has answered", /onImported\([^)]*\)[\s\S]{0,200}\.catch/.test(src), true);

  check("the control sits in the picker beside New folder here", /Import code/.test(picker), true);
  check("and does not wear the affirmative action's fill", /Import code[\s\S]{0,200}bg-fg/.test(picker), false);
  {
    const control = /<button[^>]*onClick=\{\(\) => setImporting\(true\)\}[\s\S]*?>/.exec(picker)?.[0] ?? "";
    check("and clears 44px like the control beside it", /min-h-11/.test(control), true);
  }

  {
    const { IMPORT_SKILL } = await import("../src/importSkill.js");
    const { safeMemberPath } = await import("../../../src/archive.js");
    // `safeMemberPath` refuses a whole archive with a `.git` member, so the skill must say to exclude it.
    check("the extractor refuses .git", safeMemberPath("app/.git/config").ok, false);
    check("and the skill says so rather than leaving it to be discovered", /Exclude \.git/.test(IMPORT_SKILL), true);
    check("the skill asks for one top-level folder", /\*\*one\*\* folder named after/.test(IMPORT_SKILL), true);
    check("and names a size the daemon will actually take", /under 50 MB/.test(IMPORT_SKILL), true);
    check("the skill names no vendor path", !/\.claude\//.test(IMPORT_SKILL), true);
    check("and no agent by name", !/Claude Code|Cursor|Copilot/.test(IMPORT_SKILL), true);
    check("it is runnable as pasted, with the skill file optional", /If your agent keeps skills/.test(IMPORT_SKILL), true);
  }
}
