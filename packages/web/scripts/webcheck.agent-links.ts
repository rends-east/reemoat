import { check, report, storage } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";
import { ApiError } from "../src/http.js";

const {
  LINK_RENEW_WITHIN_MS,
  LINK_RESYNC_AFTER_MS,
  LINK_RETRY_AFTER_MS,
  LinkSync,
  POLICY_RETRY_AFTER_MS,
  linkRecordKey,
  linkSyncDecision,
  linkTargets,
  messagingEcho,
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
  messaging: true,
  isolated: false,
  daemon: `i_${id}`,
  ...over,
});

process.stdout.write("\nwhen a machine is handed its links again\n");
{
  const now = 1_800_000_000_000;
  const record = (
    over: Partial<{ targets: string[]; earliestExpiresAt: number | null; syncedAt: number; messaging: boolean; isolated: boolean }> = {},
  ) => ({
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
  check(
    "a machine off the relay that this app reaches over loopback is left alone, unless somebody pressed something",
    [decide({ machine: machine("m_a", { relayOnline: false }), last: null }), decide({ machine: machine("m_a", { relayOnline: false }), force: true })],
    [
      { sync: false, why: "offline" },
      { sync: true, why: "forced" },
    ],
  );
  check("nor does a revoke reach past a daemon too old to take the answer", decide({ force: true, tooOldOn: "i_m_a" }).why, "daemon_too_old");

  const off = machine("m_a", { messaging: false });
  check(
    "a machine switched off since its last handover is handed the policy, and one switched back on too",
    [decide({ machine: off }), decide({ last: record({ messaging: false }) })],
    [
      { sync: true, why: "policy_changed" },
      { sync: true, why: "policy_changed" },
    ],
  );
  check(
    "while one handed the same policy is left alone, and a record older than the flag reads as on",
    [decide({ machine: off, last: record({ messaging: false }) }).why, decide().why],
    ["current", "current"],
  );
  check(
    "a changed policy is named before changed targets, since turning a source off empties them too",
    decide({ machine: off, targets: [] }).why,
    "policy_changed",
  );
  const loopback = machine("m_a", { messaging: false, relayOnline: false, reachable: true });
  check(
    "a changed policy reaches a machine this app has over loopback alone, where its local agents are",
    [decide({ machine: loopback }), decide({ machine: { ...loopback, messaging: true } })],
    [
      { sync: true, why: "policy_changed" },
      { sync: false, why: "offline" },
    ],
  );
  check(
    "but never one that cannot be reached at all",
    decide({ machine: machine("m_a", { messaging: false, relayOnline: false, reachable: false }) }).why,
    "offline",
  );
  check(
    "and it still waits out a failure unless forced",
    [decide({ machine: off, failedAt: now }).why, decide({ machine: off, failedAt: now, force: true }).why],
    ["backing_off", "forced"],
  );
  check(
    "but its own short wait, not the links': a switch that has not landed leaves local agents messaging",
    [
      decide({ machine: off, failedAt: now - POLICY_RETRY_AFTER_MS + 1 }).why,
      decide({ machine: off, failedAt: now - POLICY_RETRY_AFTER_MS }).why,
      decide({ failedAt: now - POLICY_RETRY_AFTER_MS, last: record({ syncedAt: now - 2 * DAY }) }).why,
    ],
    ["backing_off", "policy_changed", "backing_off"],
  );

  // Swept against an oracle written out separately, over every combination of the inputs above.
  const bools = [false, true];
  const lasts = [
    null,
    record(),
    record({ targets: ["m_b"] }),
    record({ earliestExpiresAt: now + 10 * DAY }),
    record({ syncedAt: now - 2 * DAY }),
    record({ messaging: false }),
    record({ messaging: true }),
    record({ isolated: true }),
    record({ messaging: false, isolated: true }),
  ];
  const tooOlds = [undefined, null, "i_m_a", "i_other"];
  const fails = [null, now - 1_000, now - 60_000, now - LINK_RETRY_AFTER_MS];
  let swept = 0;
  const wrong: string[] = [];
  for (const owned of bools)
    for (const enrolled of bools)
      for (const relayOnline of bools)
        for (const reachable of bools)
          for (const overLimit of bools)
            for (const messaging of bools)
              for (const isolated of bools)
              for (const last of lasts)
                for (const tooOldOn of tooOlds)
                  for (const failedAt of fails)
                    for (const force of bools) {
                      swept += 1;
                      const one = machine("m_a", { owned, enrolled, relayOnline, reachable, overLimit, messaging, isolated });
                      const got = linkSyncDecision({ machine: one, targets: ["m_b", "m_c"], last, tooOldOn, failedAt, now, force }).sync;
                      const handed = last === null || !("messaging" in last) ? true : last.messaging;
                      const handedIsolated = last !== null && "isolated" in last ? last.isolated : false;
                      const moved = handed !== messaging || handedIsolated !== isolated;
                      const eligible = owned && enrolled && reachable && (relayOnline || moved || force) && !overLimit;
                      const tooOld = tooOldOn !== undefined && tooOldOn === one.daemon;
                      const waiting = failedAt !== null && now - failedAt < (moved ? POLICY_RETRY_AFTER_MS : LINK_RETRY_AFTER_MS);
                      const due =
                        last === null ||
                        moved ||
                        last.targets.join() !== "m_b,m_c" ||
                        (last.earliestExpiresAt !== null && last.earliestExpiresAt - now < LINK_RENEW_WITHIN_MS) ||
                        now - last.syncedAt > LINK_RESYNC_AFTER_MS;
                      const want = eligible && !tooOld && (force || (!waiting && due));
                      if (got !== want) {
                        wrong.push(JSON.stringify({ owned, enrolled, relayOnline, reachable, overLimit, messaging, isolated, last, tooOldOn, failedAt, force }));
                      }
                    }
  report("the sweep covered the whole grid", swept === 2 ** 8 * lasts.length * tooOlds.length * fails.length, `${String(swept)} cases`);
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
  check(
    "a machine with messaging off is nobody's target, and one that is off itself has none",
    [
      linkTargets([machine("m_a"), machine("m_b"), machine("m_quiet", { messaging: false })], "m_a"),
      linkTargets([machine("m_a", { messaging: false }), machine("m_b")], "m_a"),
    ],
    [["m_b"], []],
  );
  check(
    "an isolated machine is nobody's target and has none, while it still messages at home (Q2.244)",
    [
      linkTargets([machine("m_a"), machine("m_b"), machine("m_alone", { isolated: true })], "m_a"),
      linkTargets([machine("m_a", { isolated: true }), machine("m_b")], "m_a"),
    ],
    [["m_b"], []],
  );
  const alone = machine("m_a", { isolated: true });
  check(
    "isolating a machine, or letting it out again, is a policy to hand over like the switch",
    [decide({ machine: alone }).why, decide({ last: record({ isolated: true }) }).why, decide({ machine: alone, last: record({ isolated: true }) }).why],
    ["policy_changed", "policy_changed", "current"],
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
  const pushedPolicy = new Map<string, unknown>();
  let daemonRefusal: ((id: string) => unknown) | null = null;
  let controlPlaneRefusal: unknown = null;
  const sync = new LinkSync({
    link: async (id) => {
      calls.push(`link ${id}`);
      if (controlPlaneRefusal !== null) throw controlPlaneRefusal;
      const answer = grants(id);
      minted.set(id, answer);
      return { links: answer };
    },
    push: async (id, links, policy) => {
      calls.push(`push ${id}`);
      pushedLinks.set(id, links);
      pushedPolicy.set(id, policy);
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
    "what was handed over is remembered: the earliest expiry, when, who it would link to by this client's count, and the switches",
    held,
    { targets: ["m_b", "m_c", "m_off"], earliestExpiresAt: clock + 60 * DAY, syncedAt: clock, messaging: true, isolated: false },
  );
  check(
    "a control plane that answered no policy hands the daemon none, so an older server never switches one off",
    ["m_a", "m_b", "m_c"].map((id) => pushedPolicy.get(id)),
    [null, null, null],
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
  check("and remembers it, without calling it a failure", sync.status(old), { tooOld: true, failure: null, env: null });
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
      return { links: grants(id) };
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
      link: async (id) => ({ links: grants(id) }),
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

process.stdout.write("\na forced sync the machine could not take is still owed at the next wake\n");
{
  let clock = 1_800_000_000_000;
  const scope = { origin: "https://cp.example", account: "u_1" };
  const key = linkRecordKey(scope, "m_a");
  const grants = (): Grant[] => [
    { id: "lk_a_b", token: "tok-a-b", expiresAt: clock + 90 * DAY, target: { id: "m_b", name: "studio", key: "k_b", relayUrl: null } },
  ];
  const calls: string[] = [];
  let linkRefusal: unknown = null;
  let pushRefusal: unknown = null;
  const deps = {
    link: async (id: string) => {
      calls.push(`link ${id}`);
      if (linkRefusal !== null) throw linkRefusal;
      return { links: grants() };
    },
    push: async (id: string) => {
      calls.push(`push ${id}`);
      if (pushRefusal !== null) throw pushRefusal;
    },
    now: () => clock,
  };
  const sync = new LinkSync(deps);
  const online = [machine("m_a"), machine("m_b")];
  const offline = [machine("m_a", { relayOnline: false, reachable: false }), machine("m_b")];
  const wake = async (on = sync): Promise<string[]> => {
    calls.length = 0;
    await on.syncAll(scope, online);
    return calls.filter((one) => one.endsWith("m_a"));
  };

  storage.delete("reemoat.agentLinks");
  await wake();
  clock += 60_000;
  check("a machine handed its links a minute ago is left alone", await wake(), []);

  const unreached = await sync.syncOne(scope, offline, "m_a", true);
  check("a forced sync cannot reach a machine this app cannot reach", [unreached.verdict.why, unreached.outcome], ["offline", "skipped"]);
  check("and forgets what was last handed to it", readLinkRecord(key), null);
  clock += 60_000;
  check("so the next wake that reaches it hands it a new set, not one a day later", await wake(), ["link m_a", "push m_a"]);
  clock += 60_000;
  check("after which it is left alone again", await wake(), []);

  await sync.syncOne(scope, offline, "m_a", true);
  clock += 60_000;
  check("the debt outlives the page: a reopened app hands the set over too", await wake(new LinkSync(deps)), [
    "link m_a",
    "push m_a",
  ]);

  pushRefusal = new ApiError(503, "no_tunnel", "that machine is not connected");
  const unpushed = await sync.syncOne(scope, online, "m_a", true);
  check("a forced sync the daemon did not take is a failure, and leaves no record", [unpushed.outcome, readLinkRecord(key)], ["failed", null]);
  pushRefusal = null;
  clock += LINK_RETRY_AFTER_MS - 1;
  check("it waits out the retry interval like any other failure", await wake(), []);
  clock += 1;
  check("and is then handed over, rather than read as current until the day is out", await wake(), ["link m_a", "push m_a"]);

  linkRefusal = new ApiError(429, "rate_limited", "too many requests");
  const unminted = await sync.syncOne(scope, online, "m_a", true);
  check("so is one the control plane refused to mint", [unminted.outcome, readLinkRecord(key)], ["failed", null]);
  linkRefusal = null;
  clock += LINK_RETRY_AFTER_MS;
  check("which the next wake past the interval hands over", await wake(), ["link m_a", "push m_a"]);

  const landed = await sync.syncOne(scope, online, "m_a", true);
  check("a forced sync that lands is remembered like any sync", [landed.outcome, readLinkRecord(key)?.syncedAt], ["synced", clock]);
  clock += 60_000;
  check("so the wake after it asks nothing", await wake(), []);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = new LinkSync({
    ...deps,
    link: async (id) => {
      await gate;
      return deps.link(id);
    },
  });
  storage.delete("reemoat.agentLinks");
  const inFlight = slow.syncOne(scope, online, "m_a");
  const behind = slow.syncOne(scope, offline, "m_a", true);
  release();
  const [first, forced] = await Promise.all([inFlight, behind]);
  check(
    "a forced sync behind a wake in flight forgets the record that wake wrote, since it may name a revoked token",
    [first.outcome, forced.verdict.why, readLinkRecord(key)],
    ["synced", "offline", null],
  );
  storage.delete("reemoat.agentLinks");
}

process.stdout.write("\nthe messaging policy rides the links, and only as the control plane said it (Q1.654)\n");
{
  const clock = 1_800_000_000_000;
  const scope = { origin: "https://cp.example", account: "u_1" };
  const grant: Grant = {
    id: "lk_a_b",
    token: "tok",
    expiresAt: clock + 90 * DAY,
    target: { id: "m_b", name: "studio", key: "k_b", relayUrl: null },
  };
  const pushed: { id: string; links: readonly Grant[]; policy: unknown }[] = [];
  let answer: { messaging?: boolean; policyAt?: number } = {};
  let echo: unknown = undefined;
  const sync = new LinkSync({
    link: async () => ({ links: [grant], ...answer }),
    push: async (id, links, policy) => {
      pushed.push({ id, links, policy });
      return echo === undefined ? { links: [] } : { links: [], messaging: echo };
    },
    now: () => clock,
  });
  storage.delete("reemoat.agentLinks");
  const fleet = [machine("m_a", { messaging: false }), machine("m_b")];

  answer = { messaging: false, policyAt: 7 };
  echo = { policy: false, isolated: false, env: true, policyAt: 7 };
  await sync.syncOne(scope, fleet, "m_a");
  check(
    "the control plane's flag and stamp reach the daemon beside the very links it answered",
    [pushed[0]?.policy, pushed[0]?.links[0] === grant],
    [{ messaging: false, policyAt: 7 }, true],
  );
  check(
    "and what was handed over is remembered, so a moved switch is noticed",
    [readLinkRecord(linkRecordKey(scope, "m_a"))?.messaging, readLinkRecord(linkRecordKey(scope, "m_a"))?.policyAt],
    [false, 7],
  );
  check("a daemon's echo is kept for the one thing read from it, its own configuration", sync.status(fleet[0]!), {
    tooOld: false,
    failure: null,
    env: true,
  });

  pushed.length = 0;
  answer = { messaging: false };
  echo = undefined;
  await sync.syncOne(scope, fleet, "m_a", true);
  check("a stamp the control plane left out is not made up", pushed[0]?.policy, { messaging: false });
  check("and a daemon whose answer echoes nothing says nothing about it", sync.status(fleet[0]!).env, null);

  echo = { policy: false, isolated: false, env: false, policyAt: 7 };
  await sync.syncOne(scope, fleet, "m_a", true);
  check("a daemon switched off in its own configuration says so", sync.status(fleet[0]!).env, false);

  check(
    "the echo is read field by field, and anything malformed is an older daemon's silence",
    [
      messagingEcho({ messaging: { policy: true, isolated: true, env: true, policyAt: 1 } }),
      messagingEcho({ messaging: { policy: "yes", isolated: false, env: true, policyAt: 1 } }),
      messagingEcho({ messaging: { policy: true, isolated: false, env: true } }),
      messagingEcho({ messaging: { policy: true, env: true, policyAt: 1 } }),
      messagingEcho({ messaging: null }),
      messagingEcho({ links: [] }),
      messagingEcho(null),
    ],
    [{ policy: true, isolated: true, env: true, policyAt: 1 }, null, null, null, null, null, null],
  );

  pushed.length = 0;
  const minted: string[] = [];
  let answers = [
    { messaging: true, policyAt: 8 },
    { messaging: false, policyAt: 9 },
  ];
  const stale = new LinkSync({
    link: async (id) => {
      minted.push(id);
      const next = answers.shift() ?? { messaging: false, policyAt: 9 };
      return { links: [], ...next };
    },
    push: async (id, links, policy) => {
      pushed.push({ id, links, policy });
      return { links: [], messaging: { policy: false, isolated: false, env: true, policyAt: 9 } };
    },
    now: () => clock,
  });
  await stale.syncOne(scope, fleet, "m_a", true);
  check(
    "an answer minted before somebody moved the switch is asked for again, once",
    [minted.length, pushed.map((one) => one.policy)],
    [2, [{ messaging: true, policyAt: 8 }, { messaging: false, policyAt: 9 }]],
  );
  minted.length = 0;
  answers = [
    { messaging: true, policyAt: 8 },
    { messaging: true, policyAt: 8 },
    { messaging: true, policyAt: 8 },
  ];
  await stale.syncOne(scope, fleet, "m_a", true);
  check("and never more than once, whatever the daemon keeps saying", minted.length, 2);

  pushed.length = 0;
  storage.delete("reemoat.agentLinks");
  let refusal: unknown = new ApiError(409, "machine_key_missing", "no key", { messaging: true, policyAt: 11 });
  const keyless = new LinkSync({
    link: async () => {
      throw refusal;
    },
    push: async (id, links, policy) => {
      pushed.push({ id, links, policy });
      return { links: [], messaging: { policy: true, isolated: false, env: true, policyAt: 11 } };
    },
    now: () => clock,
  });
  const refused = await keyless.syncOne(scope, fleet, "m_a", true);
  check(
    "a machine that can hold no link is still handed its switch, with an empty set, and the link failure stands",
    [refused.outcome, pushed[0]?.links.length, pushed[0]?.policy, keyless.status(fleet[0]!).failure?.text],
    ["failed", 0, { messaging: true, policyAt: 11 }, "no key"],
  );
  check(
    "and the handover is remembered without calling its links synced",
    [readLinkRecord(linkRecordKey(scope, "m_a"))?.messaging, readLinkRecord(linkRecordKey(scope, "m_a"))?.syncedAt],
    [true, 0],
  );
  pushed.length = 0;
  refusal = new ApiError(503, "no_signing_key", "no signing key");
  await keyless.syncOne(scope, fleet, "m_a", true);
  refusal = new ApiError(409, "machine_key_missing", "no key", { messaging: "yes", policyAt: 11 });
  await keyless.syncOne(scope, fleet, "m_a", true);
  check("but never from a refusal that carries no policy, or a malformed one", pushed.length, 0);
  storage.delete("reemoat.agentLinks");


  storage.set(
    "reemoat.agentLinks",
    JSON.stringify({
      [linkRecordKey(scope, "m_old")]: { targets: ["m_b"], earliestExpiresAt: null, syncedAt: clock },
      [linkRecordKey(scope, "m_bad")]: { targets: ["m_b"], earliestExpiresAt: null, syncedAt: clock, messaging: "off" },
    }),
  );
  check(
    "a record written before the flag still reads, as on, while one with a mangled flag is dropped",
    [
      readLinkRecord(linkRecordKey(scope, "m_old")) !== null,
      linkSyncDecision({ machine: machine("m_old"), targets: ["m_b"], last: readLinkRecord(linkRecordKey(scope, "m_old")), tooOldOn: undefined, failedAt: null, now: clock }).why,
      readLinkRecord(linkRecordKey(scope, "m_bad")),
    ],
    [true, "current", null],
  );
  storage.delete("reemoat.agentLinks");
}

process.stdout.write("\nnothing is said under a switch: the account's outranks the machine's (Q3.675)\n");
{
  const machinePage = stripComments(srcFile("ui/settings/MachineSection.tsx"));
  const fn = machinePage.slice(machinePage.indexOf("function MachineMessaging("), machinePage.indexOf("function RenameMachine("));
  const permissions = stripComments(srcFile("ui/settings/PermissionsSection.tsx"));
  const agentLinks = stripComments(srcFile("agentLinks.ts"));
  check(
    "no line explains a switch, on the machine page or on Permissions",
    [/<p className="[^"]*text-muted/.test(fn), /Not in force|not in force/.test(permissions), /MESSAGING_NOTE_TEXT|messagingNotes|notInForce/.test(agentLinks)],
    [false, false, false],
  );
  check(
    "the machine's switch is drawn off and locked by the account's switch and by its own configuration",
    /const locked = accountOn === false \|\| \(own && !effective\) \|\| store\.linkStatus\(machine\.id\)\?\.env === false;/.test(fn) &&
      /on=\{messagingOn\}/.test(fn) &&
      /disabled=\{locked \|\|/.test(fn),
    true,
  );
}

process.stdout.write("\nthere is no Agent links screen (Q3.676)\n");
{
  const { parseSettingsRoute, settingsPaneTitle, settingsUp } = await import("../src/settings.js");
  const { depthOf } = await import("../src/nav.js");
  const { existsSync, readdirSync, readFileSync: read } = await import("node:fs");
  const old = parseSettingsRoute(["machines", "m_1", "links"]);
  check(
    "an old /settings/machines/:id/links address falls up to its machine, as any unknown leaf does",
    [old, settingsPaneTitle(old), settingsUp(old)],
    [parseSettingsRoute(["machines", "m_1"]), settingsPaneTitle(parseSettingsRoute(["machines", "m_1"])), settingsUp(parseSettingsRoute(["machines", "m_1"]))],
  );
  check("and sits at the machine's depth", depthOf({ name: "settings", ...old } as never), 3);
  check("the route carries no flag for it", "links" in old, false);

  const root = new URL("../src/", import.meta.url);
  check("the screen's file is gone", existsSync(new URL("ui/settings/MachineLinksSection.tsx", root)), false);
  const walk = (dir: URL): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir)) : /\.tsx?$/.test(entry.name) ? [new URL(entry.name, dir).pathname] : [],
    );
  const mentions = walk(root).filter((file) => /Agent links|MachineLinksSection|agentLinksPath|resyncLinks|revokeLink|machineLinks\(/.test(stripComments(read(file, "utf8"))));
  check("nothing in the client names it, draws it or calls for it", mentions, []);

  const cp = stripComments(srcFile("cp.ts"));
  const daemon = stripComments(srcFile("daemon.ts"));
  check(
    "the client asks the control plane only to mint links, and the daemon only to take them",
    [
      (cp.match(/\/links`/g) ?? []).length,
      /`\/v1\/links\//.test(cp),
      (daemon.match(/"\/peers\/links"/g) ?? []).length,
      /request\("\/peers\/links", \{ method: "PUT"/.test(daemon),
    ],
    [1, false, 1, true],
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
    "the daemon is sent { links } unread, with the control plane's policy beside them only when it answered one",
    [
      /const body = policy === null \? \{ links \} : \{ links, \.\.\.policy \};/.test(daemon),
      /request\("\/peers\/links", \{ method: "PUT", body: JSON\.stringify\(body\) \}\)/.test(daemon),
    ],
    [true, true],
  );
  check(
    "and the policy is only ever what the control plane typed as one",
    [/typeof body\.messaging === "boolean"/.test(stripComments(srcFile("cp.ts"))), /answer\.messaging === undefined\s*\? null/.test(module)],
    [true, true],
  );
  const cp = stripComments(srcFile("cp.ts"));
  check(
    "and the one control-plane route is the contract's",
    /`\/v1\/machines\/\$\{encodeURIComponent\(id\)\}\/links`, \{\s*method: "POST",/.test(cp),
    true,
  );
}
