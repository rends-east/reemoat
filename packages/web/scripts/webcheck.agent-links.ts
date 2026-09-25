import { check, report, storage } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";
import { ApiError } from "../src/http.js";

const {
  LINK_DIRECTION_TEXT,
  LINK_RENEW_WITHIN_MS,
  LINK_RESYNC_AFTER_MS,
  LINK_RETRY_AFTER_MS,
  LinkSync,
  linkNote,
  linkRecordKey,
  linkRows,
  linkSyncDecision,
  linkTargets,
  readLinkRecord,
} = await import("../src/agentLinks.js");

type Candidate = Parameters<typeof linkTargets>[0][number];
type Grant = import("../src/wire.js").MachineLinkGrant;

const DAY = 24 * 60 * 60 * 1000;
const machine = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  owned: true,
  enrolled: true,
  relayOnline: true,
  reachable: true,
  overLimit: false,
  ownerDisabled: false,
  daemon: `i_${id}`,
  ...over,
});

process.stdout.write("\nwhen a machine is handed its links again\n");
{
  const now = 1_800_000_000_000;
  const record = (over: Partial<{ targets: string[]; earliestExpiresAt: number | null; syncedAt: number }> = {}) => ({
    targets: ["m_b", "m_c"],
    earliestExpiresAt: now + 80 * DAY,
    syncedAt: now - 60_000,
    ...over,
  });
  const decide = (over: Partial<Parameters<typeof linkSyncDecision>[0]> = {}) =>
    linkSyncDecision({
      machine: machine("m_a"),
      targets: ["m_b", "m_c"],
      last: record(),
      tooOldOn: undefined,
      failedAt: null,
      now,
      ...over,
    });

  check("the two numbers are the contract's", [LINK_RENEW_WITHIN_MS / DAY, LINK_RESYNC_AFTER_MS / DAY], [45, 1]);
  check("a machine handed the same set a minute ago is left alone", decide(), { sync: false, why: "current" });
  check("one never handed anything is handed its links", decide({ last: null }), { sync: true, why: "never_synced" });
  check("even when there is nobody to link it to, so a set left behind is cleared", decide({ last: null, targets: [] }), {
    sync: true,
    why: "never_synced",
  });

  check(
    "a machine added, a machine gone, and one swapped for another are each a change",
    [decide({ targets: ["m_b", "m_c", "m_d"] }), decide({ targets: ["m_b"] }), decide({ targets: ["m_b", "m_d"] })].map(
      (one) => one.why,
    ),
    ["targets_changed", "targets_changed", "targets_changed"],
  );
  check("while the same set in another order is not", decide({ targets: ["m_c", "m_b"] }).why, "current");

  const expiring = (left: number) => decide({ last: record({ earliestExpiresAt: now + left }) });
  check(
    "under 45 days left on the earliest token re-mints, and 45 exactly does not",
    [expiring(45 * DAY - 1).why, expiring(45 * DAY).why, expiring(45 * DAY + 1).why],
    ["expiring", "current", "current"],
  );
  check("an expiry already past re-mints too", expiring(-DAY).why, "expiring");
  check("and a set with no token in it never expires", decide({ last: record({ earliestExpiresAt: null }) }).why, "current");

  const aged = (age: number) => decide({ last: record({ syncedAt: now - age }) });
  check(
    "over a day old re-syncs, and a day exactly does not",
    [aged(DAY + 1).why, aged(DAY).why, aged(DAY - 1).why],
    ["stale", "current", "current"],
  );

  check(
    "a daemon that answered 404 is not asked again",
    decide({ tooOldOn: "i_m_a", last: null }),
    { sync: false, why: "daemon_too_old" },
  );
  check(
    "until a different daemon process answers for the machine",
    decide({ tooOldOn: "i_before_the_update", last: null }),
    { sync: true, why: "never_synced" },
  );
  check(
    "and one that 404'd before any probe stays remembered until a probe says who it is",
    [
      decide({ tooOldOn: null, machine: machine("m_a", { daemon: null }), last: null }).why,
      decide({ tooOldOn: null, last: null }).why,
    ],
    ["daemon_too_old", "never_synced"],
  );

  check(
    "a failure waits out the retry interval, and not a millisecond more",
    [
      decide({ failedAt: now - LINK_RETRY_AFTER_MS + 1, last: null }).why,
      decide({ failedAt: now - LINK_RETRY_AFTER_MS, last: null }).why,
    ],
    ["backing_off", "never_synced"],
  );
  check(
    "a person's revoke passes the timing rules",
    [
      decide({ force: true }),
      decide({ force: true, failedAt: now }),
    ],
    [
      { sync: true, why: "forced" },
      { sync: true, why: "forced" },
    ],
  );

  const refusals: [string, Candidate][] = [
    ["not_owned", machine("m_a", { owned: false })],
    ["not_enrolled", machine("m_a", { enrolled: false })],
    ["switched_off", machine("m_a", { overLimit: true })],
    ["switched_off", machine("m_a", { ownerDisabled: true })],
    ["offline", machine("m_a", { relayOnline: false })],
    ["offline", machine("m_a", { reachable: false })],
  ];
  check(
    "nothing is attempted for a machine not owned, not enrolled, switched off or offline, forced or not",
    refusals.map(([, one]) => [decide({ machine: one, last: null }), decide({ machine: one, force: true })]),
    refusals.map(([why]) => [
      { sync: false, why },
      { sync: false, why },
    ]),
  );
  check("nor does a revoke reach past a daemon too old to take the answer", decide({ force: true, tooOldOn: "i_m_a" }).why, "daemon_too_old");

  // Swept against an oracle written out separately, over every combination of the inputs above.
  const bools = [false, true];
  const lasts = [null, record(), record({ targets: ["m_b"] }), record({ earliestExpiresAt: now + 10 * DAY }), record({ syncedAt: now - 2 * DAY })];
  const tooOlds = [undefined, null, "i_m_a", "i_other"];
  const fails = [null, now - 60_000, now - LINK_RETRY_AFTER_MS];
  let swept = 0;
  const wrong: string[] = [];
  for (const owned of bools)
    for (const enrolled of bools)
      for (const relayOnline of bools)
        for (const reachable of bools)
          for (const overLimit of bools)
            for (const last of lasts)
              for (const tooOldOn of tooOlds)
                for (const failedAt of fails)
                  for (const force of bools) {
                    swept += 1;
                    const one = machine("m_a", { owned, enrolled, relayOnline, reachable, overLimit });
                    const got = linkSyncDecision({ machine: one, targets: ["m_b", "m_c"], last, tooOldOn, failedAt, now, force }).sync;
                    const eligible = owned && enrolled && relayOnline && reachable && !overLimit;
                    const tooOld = tooOldOn !== undefined && tooOldOn === one.daemon;
                    const waiting = failedAt !== null && now - failedAt < LINK_RETRY_AFTER_MS;
                    const due =
                      last === null ||
                      last.targets.join() !== "m_b,m_c" ||
                      (last.earliestExpiresAt !== null && last.earliestExpiresAt - now < LINK_RENEW_WITHIN_MS) ||
                      now - last.syncedAt > LINK_RESYNC_AFTER_MS;
                    const want = eligible && !tooOld && (force || (!waiting && due));
                    if (got !== want) wrong.push(JSON.stringify({ owned, enrolled, relayOnline, reachable, overLimit, last, tooOldOn, failedAt, force }));
                  }
  report("the sweep covered the whole grid", swept === 2 ** 6 * lasts.length * tooOlds.length * fails.length, `${String(swept)} cases`);
  check("and the decision matches the oracle on every one of them", wrong.slice(0, 3), []);

  check(
    "a machine is linked to every other one you own that is enrolled and switched on, and never to itself",
    linkTargets(
      [
        machine("m_z"),
        machine("m_a"),
        machine("m_shared", { owned: false }),
        machine("m_new", { enrolled: false }),
        machine("m_over", { overLimit: true }),
        machine("m_banned", { ownerDisabled: true }),
        machine("m_offline", { relayOnline: false, reachable: false }),
        machine("m_b"),
      ],
      "m_a",
    ),
    ["m_b", "m_offline", "m_z"],
  );
}

process.stdout.write("\nwhat the sync sends, and to whom\n");
{
  let clock = 1_800_000_000_000;
  const scope = { origin: "https://cp.example", account: "u_1" };
  const grants = (source: string): Grant[] =>
    [
      {
        id: `lk_${source}_b`,
        token: `tok-${source}-b`,
        expiresAt: clock + 90 * DAY,
        target: { id: "m_b", name: "studio", key: "k_b", relayUrl: "https://relay.example" },
        // A field this client has never heard of, which must reach the daemon anyway.
        issuedBy: "u_1",
      },
      {
        id: `lk_${source}_c`,
        token: `tok-${source}-c`,
        expiresAt: clock + 60 * DAY,
        target: { id: "m_c", name: "server", key: "k_c", relayUrl: null },
      },
    ] as Grant[];

  const calls: string[] = [];
  const minted = new Map<string, Grant[]>();
  const pushedLinks = new Map<string, readonly Grant[]>();
  let daemonRefusal: ((id: string) => unknown) | null = null;
  let controlPlaneRefusal: unknown = null;
  const sync = new LinkSync({
    link: async (id) => {
      calls.push(`link ${id}`);
      if (controlPlaneRefusal !== null) throw controlPlaneRefusal;
      const answer = grants(id);
      minted.set(id, answer);
      return answer;
    },
    push: async (id, links) => {
      calls.push(`push ${id}`);
      pushedLinks.set(id, links);
      const refusal = daemonRefusal?.(id);
      if (refusal !== undefined) throw refusal;
      return { links: [] };
    },
    now: () => clock,
  });

  storage.delete("reemoat.agentLinks");
  const fleet = [
    machine("m_a"),
    machine("m_b"),
    machine("m_c"),
    machine("m_shared", { owned: false }),
    machine("m_new", { enrolled: false }),
    machine("m_off", { relayOnline: false }),
    machine("m_over", { overLimit: true }),
  ];
  await sync.syncAll(scope, fleet);
  check(
    "every owned, enrolled, reachable machine is minted for and then handed its links, and nothing else is touched",
    [...calls].sort(),
    ["link m_a", "link m_b", "link m_c", "push m_a", "push m_b", "push m_c"],
  );
  check(
    "each daemon is sent the very objects the control plane answered, unknown fields included",
    ["m_a", "m_b", "m_c"].map((id) => pushedLinks.get(id) === minted.get(id)),
    [true, true, true],
  );
  check(
    "and they survive the trip as JSON, byte for byte",
    JSON.stringify({ links: pushedLinks.get("m_a") }),
    JSON.stringify({ links: grants("m_a") }),
  );
  const held = readLinkRecord(linkRecordKey(scope, "m_a"));
  check(
    "what was handed over is remembered: the earliest expiry, when, and who it would link to by this client's count",
    held,
    { targets: ["m_b", "m_c", "m_off"], earliestExpiresAt: clock + 60 * DAY, syncedAt: clock },
  );
  check(
    "under a key naming the server, the account and the machine",
    linkRecordKey(scope, "m_a"),
    "https://cp.example u_1 m_a",
  );

  calls.length = 0;
  clock += 60_000;
  await sync.syncAll(scope, fleet);
  check("a minute later nothing is asked of anybody", calls, []);

  await sync.syncAll({ ...scope, account: "u_2" }, fleet.slice(0, 1));
  check("while another account on the same server starts from nothing", calls, ["link m_a", "push m_a"]);
  calls.length = 0;

  await sync.syncAll(scope, [...fleet, machine("m_d")]);
  check(
    "a machine joining the fleet re-links every other one, and is linked itself",
    [...calls].sort(),
    ["link m_a", "link m_b", "link m_c", "link m_d", "push m_a", "push m_b", "push m_c", "push m_d"],
  );
  calls.length = 0;

  clock += DAY + 1;
  await sync.syncAll(scope, [...fleet, machine("m_d")]);
  check("and a day on, every one is handed a fresh set", calls.filter((one) => one.startsWith("push")).length, 4);
  calls.length = 0;

  // An older daemon: Hono's bare 404, which parseBody turns into http_404.
  daemonRefusal = (id) => (id === "m_old" ? new ApiError(404, "http_404", "Not Found") : undefined);
  const old = machine("m_old");
  const withOld = [...fleet, machine("m_d"), old];
  const first = await sync.syncOne(scope, withOld, "m_old");
  check("an older daemon's 404 is recognised as one", first.outcome, "daemon_too_old");
  check("and says so to the screen, without calling it a failure", sync.status(old), { tooOld: true, failure: null });
  calls.length = 0;
  clock += 2 * DAY;
  await sync.syncAll(scope, withOld);
  check(
    "after which that machine is never minted for again, while the rest carry on",
    calls.filter((one) => one.endsWith("m_old")),
    [],
  );
  check("the rest did carry on", calls.filter((one) => one.startsWith("push")).length, 4);
  calls.length = 0;
  await sync.syncOne(scope, withOld, "m_old", true);
  check("not even for a revoke", calls, []);
  const updated = { ...old, daemon: "i_after_update" };
  check("until the machine answers from another daemon process", sync.status(updated).tooOld, false);
  daemonRefusal = null;
  const retried = await sync.syncOne(scope, [...fleet, machine("m_d"), updated], "m_old");
  check("which is tried once more, and taken", [retried.outcome, calls], ["synced", ["link m_old", "push m_old"]]);
  calls.length = 0;

  daemonRefusal = (id) => (id === "m_a" ? new ApiError(404, "session_not_found", "no such session") : undefined);
  const refused = await sync.syncOne(scope, fleet, "m_a", true);
  check("a 404 that carries an envelope is a refusal, never an old daemon", [refused.outcome, sync.status(machine("m_a")).tooOld], ["failed", false]);
  check("and it is kept for the screen, in errorText's words", sync.status(machine("m_a")).failure?.text, "no such session");
  calls.length = 0;
  daemonRefusal = null;
  clock += LINK_RETRY_AFTER_MS - 1;
  const waiting = await sync.syncOne(scope, fleet, "m_a");
  check("a failed machine is not retried on the next wake", [waiting.verdict.why, calls], ["backing_off", []]);
  clock += 1;
  const again = await sync.syncOne(scope, fleet, "m_a");
  check("but is once the interval is up, and a success clears the failure", [again.outcome, sync.status(machine("m_a")).failure], ["synced", null]);
  calls.length = 0;

  controlPlaneRefusal = new ApiError(409, "machine_key_missing", "that machine has not announced a key");
  const cpRefused = await sync.syncOne(scope, fleet, "m_b", true);
  check("a control-plane refusal hands the daemon nothing", [cpRefused.outcome, calls], ["failed", ["link m_b"]]);
  controlPlaneRefusal = null;
  calls.length = 0;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = new LinkSync({
    link: async (id) => {
      calls.push(`link ${id}`);
      await gate;
      return grants(id);
    },
    push: async (id) => {
      calls.push(`push ${id}`);
    },
    now: () => clock,
  });
  storage.delete("reemoat.agentLinks");
  const both = [slow.syncOne(scope, fleet, "m_a"), slow.syncOne(scope, fleet, "m_a")];
  release();
  await Promise.all(both);
  check("two wakes at once mint once", calls, ["link m_a", "push m_a"]);
  calls.length = 0;

  const win = globalThis as unknown as { window: { localStorage: unknown } };
  const kept = win.window.localStorage;
  win.window.localStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  let threw = false;
  try {
    const answered = await new LinkSync({
      link: async (id) => grants(id),
      push: async () => undefined,
      now: () => clock,
    }).syncOne(scope, fleet, "m_a");
    check("storage that throws costs a mint, never an exception", answered.outcome, "synced");
  } catch {
    threw = true;
  } finally {
    win.window.localStorage = kept;
  }
  check("and nothing escaped", threw, false);
  storage.delete("reemoat.agentLinks");
}

process.stdout.write("\nthe Agent links screen's rows\n");
{
  const links = [
    { id: "lk_2", source: { id: "m_z", name: "zeta" }, target: { id: "m_a", name: "laptop" }, createdAt: 2 },
    { id: "lk_1", source: { id: "m_a", name: "laptop" }, target: { id: "m_z", name: "zeta" }, createdAt: 1 },
    { id: "lk_3", source: { id: "m_b", name: "beta" }, target: { id: "m_a", name: "laptop" }, createdAt: 3 },
    { id: "lk_x", source: { id: "m_b", name: "beta" }, target: { id: "m_z", name: "zeta" }, createdAt: 4 },
  ];
  const rows = linkRows(links, "m_a");
  check(
    "each row names the other machine and which way it goes, grouped by machine, outgoing first",
    rows.map((row) => `${LINK_DIRECTION_TEXT[row.direction]} ${row.other.name}`),
    ["can be messaged by beta", "can message zeta", "can be messaged by zeta"],
  );
  check("a link between two other machines is not this machine's row", rows.some((row) => row.id === "lk_x"), false);
  check(
    "and every row knows whose daemon holds its token",
    rows.map((row) => row.source),
    ["m_b", "m_a", "m_z"],
  );
  const out = rows.find((row) => row.id === "lk_1");
  const into = rows.find((row) => row.id === "lk_2");
  if (out === undefined || into === undefined) throw new Error("fixture rows missing");
  const view = (id: string, lastError: string | null) => ({
    id,
    target: { id: "m_z", name: "zeta", relayUrl: null },
    expiresAt: 0,
    lastError,
    lastErrorAt: lastError === null ? null : 1,
  });
  check(
    "an outgoing row carries the daemon's last error, and nothing when there is none",
    [linkNote(out, [view("lk_1", "peer_too_old: zeta's daemon is older than agent links")], "laptop"), linkNote(out, [view("lk_1", null)], "laptop")],
    [{ text: "peer_too_old: zeta's daemon is older than agent links", failed: true }, null],
  );
  check(
    "one the daemon does not hold says so rather than claiming a link that cannot be used",
    linkNote(out, [], "laptop"),
    { text: "Not handed to laptop yet.", failed: false },
  );
  check(
    "while an incoming row, or a daemon not read yet, says nothing",
    [linkNote(into, [view("lk_2", "boom")], "laptop"), linkNote(out, null, "laptop")],
    [null, null],
  );
}

process.stdout.write("\nwhere Agent links lives, and what reaches it\n");
{
  const { agentLinksPath, parseSettingsRoute, settingsPaneTitle, settingsUp, settingsUpLabel } = await import(
    "../src/settings.js"
  );
  const { depthOf, navMove } = await import("../src/nav.js");
  const seg = (path: string): string[] => path.split("/").filter((part) => part.length > 0).slice(1);
  const links = parseSettingsRoute(seg(agentLinksPath("m_1" as never)));
  check("the address is under its machine", agentLinksPath("m_1" as never), "/settings/machines/m_1/links");
  check("and parses back to the machine's links screen", links, {
    section: "machines",
    machineId: "m_1",
    system: null,
    signin: null,
    agents: false,
    links: true,
    leaf: null,
  });
  check(
    "no other address is the links screen",
    [
      parseSettingsRoute(["machines", "m_1"]).links,
      parseSettingsRoute(["machines", "m_1", "agents"]).links,
      parseSettingsRoute(["machines", "m_1", "systems", "moonshot"]).links,
      parseSettingsRoute(["machines", "m_1", "signin", "claude"]).links,
      parseSettingsRoute(["account", "links"]).links,
      parseSettingsRoute(["machines", "links"]).links,
    ],
    [false, false, false, false, false, false],
  );
  check("and a segment under it falls to the screen rather than past it", parseSettingsRoute(["machines", "m_1", "links", "lk_1"]).links, true);
  check("its chevron goes up to its machine, never to the list", settingsUp(links), { path: "/settings/machines/m_1", withinNav: false });
  check("and says so", [settingsPaneTitle(links), settingsUpLabel(links)], ["Agent links", "Machine settings"]);
  const at = (segments: string[]) => ({ name: "settings", ...parseSettingsRoute(segments) }) as never;
  check("it is a fourth depth, beside the Agents list", [depthOf(at(["machines", "m_1", "links"])), depthOf(at(["machines", "m_1", "agents"]))], [4, 4]);
  check(
    "so opening it from the machine slides in and its chevron slides back",
    [navMove(at(["machines", "m_1"]), at(["machines", "m_1", "links"])), navMove(at(["machines", "m_1", "links"]), at(["machines", "m_1"]))],
    ["section-push", "section-pop"],
  );

  const app = stripComments(srcFile("App.tsx"));
  check("and it is a screen of its own in the sheet, not the machine's", /route\.links \? "links"/.test(app), true);

  const settings = stripComments(srcFile("ui/settings/Settings.tsx"));
  check("Settings draws the screen from one place", (settings.match(/<MachineLinksSection /g) ?? []).length, 1);
  check("behind the machine's own flag", /route\.links \? \(\s*<MachineLinksSection state=\{state\} machineId=\{route\.machineId\} \/>/.test(settings), true);

  const section = stripComments(srcFile("ui/settings/MachineSection.tsx"));
  const row = section.indexOf('title="Agent links"');
  const opens = section.lastIndexOf("{owned && machine.enrolled && (", row);
  const gateOpens = section.indexOf("{listable ? (");
  const gateCloses = section.indexOf("\n      )}", gateOpens);
  const local = section.indexOf("<LocalPath ");
  report(
    "the machine's screen reaches it by a row, for its owner, once it is enrolled",
    row > 0 && opens > 0 && row - opens < 200,
    `row at ${String(row)}, gate at ${String(opens)}`,
  );
  check("the row leaves the screen rather than opening under itself", /onClick=\{\(\) => navigate\(agentLinksPath\(machineId\)\)\}/.test(section), true);
  report(
    "outside the reachability gate, since the links are the control plane's",
    gateCloses > gateOpens && opens > gateCloses && row < local,
    `gate ${String(gateOpens)}..${String(gateCloses)}, row at ${String(row)}, this device at ${String(local)}`,
  );

  const screen = stripComments(srcFile("ui/settings/MachineLinksSection.tsx"));
  check("the screen is a table, per the rule for anything holding a credential", /<LinkTable>/.test(screen) && /<table /.test(screen), true);
  check(
    "whose Replace is one tap, like an API key's revoke, since ending a token widens nothing",
    [/<TwoStep/.test(screen), /\{busy \? <Spinner \/> : "Replace"\}/.test(screen)],
    [false, true],
  );
  check(
    "and it re-syncs the machine that held the token, then reads both lists again",
    /\.then\(\(\) => store\.resyncLinks\(asMachineId\(row\.source\)\)\)\s*\.then\(\(\) => Promise\.all\(\[loadLinks\(\), loadHeld\(\)\]\)\)/.test(screen),
    true,
  );
  check("the screen says why the list is what it is", /It lists your own machines on this\s+server and nothing else/.test(screen), true);
  check(
    "and, plainly, when this machine's daemon is too old for any of it",
    /\{machine\.name\}’s daemon needs updating before its agents can reach other machines\./.test(screen),
    true,
  );
  check("reading that off the daemon's bare 404 through the one predicate", /meansRouteAbsent\(cause\)/.test(screen) && !/http_404/.test(screen), true);
  check("and it says the pair is linked again, since the next sync mints a new link", /this app then hands the machine a new\s+one/.test(screen), true);
  check(
    "a server older than links is said once, with no retry that would ask it again",
    [
      /cause\.code === "not_found" \? "absent" : "failed"/.test(screen),
      /links === "absent" \? \(\s*<Empty>This server is too old for agent links\.<\/Empty>/.test(screen),
    ],
    [true, true],
  );
}

process.stdout.write("\nthe sync rides the machine list, and nothing else\n");
{
  const store = stripComments(srcFile("store.ts"));
  const runResume = store.slice(store.indexOf("private async runResume("), store.indexOf("private linkScope("));
  const tick = store.slice(store.indexOf("private async tick("), store.indexOf("private async fetchRoots("));
  check("it is started in exactly one place", (store.match(/\.syncAll\(/g) ?? []).length, 1);
  report(
    "which is the end of a resume, after every machine has been listed and probed",
    runResume.includes("this.links.syncAll(") && runResume.indexOf("this.links.syncAll(") > runResume.indexOf("this.resumeMachine(connection, epoch)"),
    `${String(runResume.length)} chars of runResume`,
  );
  check("and only for the resume that is still current", /if \(epoch === this\.epoch\) \{[\s\S]{0,300}this\.links\.syncAll\(/.test(runResume), true);
  check("never from the four-second poll", /links/.test(tick), false);
  check("and it is not awaited, so a slow control plane holds up nothing", /void this\.links\.syncAll\(/.test(runResume), true);

  const module = stripComments(srcFile("agentLinks.ts"));
  check("the sync shows no toast and imports no UI", [/toast\(/.test(module), /from "\.\/ui\//.test(module)], [false, false]);
  check("and reads an older daemon through the one predicate", /meansRouteAbsent\(error\)/.test(module) && !/http_404/.test(module), true);
  check(
    "every storage access is inside a try",
    (module.match(/window\.localStorage\.\w+\(/g) ?? []).length,
    (module.match(/try \{\s*(?:const raw = )?window\.localStorage\.\w+\(/g) ?? []).length,
  );

  const daemon = stripComments(srcFile("daemon.ts"));
  check(
    "the daemon is sent { links } and nothing wrapped around them",
    /request\("\/peers\/links", \{ method: "PUT", body: JSON\.stringify\(\{ links \}\) \}\)/.test(daemon),
    true,
  );
  const cp = stripComments(srcFile("cp.ts"));
  check(
    "and the three control-plane routes are the contract's",
    [
      /`\/v1\/machines\/\$\{encodeURIComponent\(id\)\}\/links`, \{\s*method: "POST",/.test(cp),
      /cpFetch<\{ links: MachineLinkRecord\[\] \}>\(`\/v1\/machines\/\$\{encodeURIComponent\(id\)\}\/links`\)/.test(cp),
      /`\/v1\/links\/\$\{encodeURIComponent\(id\)\}`, \{ method: "DELETE" \}/.test(cp),
    ],
    [true, true, true],
  );
}
