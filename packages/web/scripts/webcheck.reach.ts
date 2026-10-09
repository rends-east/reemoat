import { check, report } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

process.stdout.write("\nwhat was not reached is three facts, and an unread list is never called empty\n");
{
  const { ApiError } = await import("../src/http.js");
  const {
    deviceNetwork,
    listingFailure,
    machinesWords,
    NO_NETWORK,
    registryOf,
    SERVER_UNASKED,
    serverAfter,
    serverEvidence,
    serverSentence,
    serverWords,
    sessionsWords,
    WAITING_FOR_NETWORK,
    wantsServer,
    doubtedOf,
    onTheWire,
    wireDownSince,
  } = await import("../src/reach.js");

  // `navigator.onLine` proves nothing when it says true: a WebView with no way to ask the system answers true for ever.
  check(
    "this device is offline only on a positive signal",
    [deviceNetwork(false), deviceNetwork(true), deviceNetwork(undefined)],
    ["offline", "online", "online"],
  );
  check(
    "a listing that never arrived is the server unreachable, and one answered with an error is the server refusing",
    [
      listingFailure(new TypeError("Failed to fetch")),
      listingFailure(new DOMException("timed out", "TimeoutError")),
      listingFailure(new ApiError(500, "internal", "boom")),
      listingFailure(new ApiError(502, "bad_gateway", "<html>")),
    ],
    ["unreachable", "unreachable", "refusing", "refusing"],
  );
  const failed = serverAfter(SERVER_UNASKED, "unreachable", 1_000);
  check(
    "the trouble's start is the attempt's own, kept across its two kinds, and ended by nothing but an answer",
    [
      failed,
      serverAfter(failed, "unreachable", 9_000),
      serverAfter(failed, "refusing", 9_000),
      serverAfter(failed, "ok", 9_000),
      serverAfter(failed, "unknown", 9_000),
    ],
    [
      { state: "unreachable", since: 1_000 },
      { state: "unreachable", since: 1_000 },
      { state: "refusing", since: 1_000 },
      { state: "ok", since: null },
      { state: "unknown", since: null },
    ],
  );
  const held = (patch: object) => ({ reach: "online", offlineReason: null, tokenDegraded: false, ...patch }) as never;
  // F11: with rows held the registry was never asked again, so a dead server surfaced only as machines named unreachable.
  check(
    "a token the server never answered for is evidence about the server, held or expired, and nothing else is",
    [
      serverEvidence([held({})]),
      serverEvidence([held({}), held({ tokenDegraded: true })]),
      serverEvidence([held({ reach: "offline", offlineReason: "cp_unreachable" })]),
      serverEvidence([held({ reach: "offline", offlineReason: "no_route" })]),
      serverEvidence([held({ reach: "offline", offlineReason: "no_token" })]),
      serverEvidence([]),
    ],
    [false, true, true, false, false, false],
  );
  check(
    "a machine offline for want of the server is that and no other reason",
    [wantsServer("offline", "cp_unreachable"), wantsServer("offline", "no_route"), wantsServer("online", "cp_unreachable" as never)],
    [true, false, false],
  );
  // A full outage takes the relay with the server: the machine goes down first, and was named for minutes before a mint failed.
  const fleetAt = (studio: [string, string | null], mini: [string, string | null]) =>
    [
      { id: "studio", reach: studio[0], offlineReason: studio[1] },
      { id: "mini", reach: mini[0], offlineReason: mini[1] },
    ] as never;
  const first = wireDownSince(new Map(), fleetAt(["offline", "no_route"], ["online", null]), 100);
  const later = wireDownSince(first, fleetAt(["offline", null], ["offline", "no_route"]), 300);
  check(
    "a machine down on the wire is remembered from when it was first seen down, and forgotten the moment it is not",
    [
      [...first],
      [...later],
      [...wireDownSince(later, fleetAt(["online", null], ["offline", "no_route"]), 500)],
      [...wireDownSince(later, fleetAt(["offline", "no_token"], ["offline", "cp_unreachable"]), 500)],
      [onTheWire("offline", "no_route"), onTheWire("offline", null), onTheWire("offline", "cp_unreachable"), onTheWire("online", null)],
    ],
    [[["studio", 100]], [["studio", 100], ["mini", 300]], [["mini", 300]], [], [true, true, false, false]],
  );
  check(
    "it is in doubt until the server answers after it went down, and an answer ends every doubt older than itself",
    [[...doubtedOf(later, 0)], [...doubtedOf(later, 200)], [...doubtedOf(later, 300)], [...doubtedOf(new Map(), 0)]],
    [["studio", "mini"], ["mini"], [], []],
  );
  check(
    "a registry once read stays read; before that a failed listing is failed and anything else is unread",
    [
      registryOf(true, "unreachable"),
      registryOf(true, "ok"),
      registryOf(false, "unreachable"),
      registryOf(false, "refusing"),
      registryOf(false, "ok"),
      registryOf(false, "unknown"),
    ],
    ["known", "known", "failed", "failed", "unknown", "unknown"],
  );
  check(
    "the sentences, written once: the network by that word, the server by its host, a machine by its name",
    [
      NO_NETWORK,
      WAITING_FOR_NETWORK,
      serverWords("unreachable", "app.example"),
      serverWords("refusing", "http://10.0.0.5:7888"),
      serverSentence("unreachable"),
      machinesWords(["studio"]),
      machinesWords(["studio", "mini"]),
      sessionsWords("studio"),
      sessionsWords(null),
    ],
    [
      "No network connection",
      "Waiting for network…",
      "Can’t reach app.example",
      "http://10.0.0.5:7888 answered with an error",
      { lead: "Can’t reach ", tail: "" },
      "studio is unreachable",
      "2 machines are unreachable",
      "Couldn’t load studio’s sessions",
      "Couldn’t load some sessions",
    ],
  );
  const reach = stripComments(srcFile("reach.ts"));
  check(
    "and none of them says internet or control plane: a server on the LAN needs neither word",
    [/internet/i.test(reach), /control plane/i.test(reach)],
    [false, false],
  );
}

process.stdout.write("\nthe list's body is one total function\n");
{
  const { listBody } = await import("../src/ui/groups.js");
  type Input = Parameters<typeof listBody>[0];
  type Machine = Input["fleet"][number];

  const REASONS = [null, "no_route", "cp_unreachable", "not_enrolled", "no_token", "no_machine_key", "no_device_key", "machine_key_changed", "device_pending"] as const;
  const shapes: Machine[] = [];
  for (const reach of ["unknown", "probing"] as const) {
    shapes.push({ name: "m", reach, offlineReason: null, ownerDisabled: false, overLimit: false, sessions: "unknown", doubted: false });
  }
  for (const sessions of ["unknown", "failed", "known"] as const) {
    shapes.push({ name: "m", reach: "online", offlineReason: null, ownerDisabled: false, overLimit: false, sessions, doubted: false });
  }
  for (const reason of REASONS) {
    for (const sessions of ["unknown", "known"] as const) {
      shapes.push({ name: "m", reach: "offline", offlineReason: reason, ownerDisabled: false, overLimit: false, sessions, doubted: false });
    }
  }
  shapes.push({ name: "m", reach: "offline", offlineReason: "owner_disabled", ownerDisabled: true, overLimit: false, sessions: "unknown", doubted: false });
  shapes.push({ name: "m", reach: "offline", offlineReason: "over_limit", ownerDisabled: false, overLimit: true, sessions: "unknown", doubted: false });
  // Down since the server last answered: which of the two it is has been asked and not answered yet.
  shapes.push({ name: "m", reach: "offline", offlineReason: "no_route", ownerDisabled: false, overLimit: false, sessions: "known", doubted: true });
  shapes.push({ name: "m", reach: "offline", offlineReason: null, ownerDisabled: false, overLimit: false, sessions: "unknown", doubted: true });

  const fleets: Machine[][] = [[]];
  for (const one of shapes) fleets.push([{ ...one, name: "studio" }]);
  for (const one of shapes) for (const two of shapes) fleets.push([{ ...one, name: "studio" }, { ...two, name: "mini" }]);

  const reached = new Map<string, number>();
  const broken: string[] = [];
  let asked = 0;
  const offender = (rule: string, input: Input, kind: string): void => {
    if (broken.length < 5) broken.push(`${rule}: ${kind} from ${JSON.stringify(input)}`);
  };
  const wireDown = (machine: Machine): boolean =>
    machine.reach === "offline" && (machine.offlineReason === null || machine.offlineReason === "no_route");
  const unsettled = (machine: Machine): boolean =>
    machine.reach === "unknown" ||
    machine.reach === "probing" ||
    (machine.doubted && wireDown(machine)) ||
    (machine.reach === "online" && machine.sessions === "unknown");

  for (const device of ["online", "offline"] as const) {
    for (const server of ["unknown", "ok", "unreachable", "refusing"] as const) {
      for (const registry of ["unknown", "failed", "known"] as const) {
        for (const fleet of fleets) {
          for (const selected of [null, ...(fleet.length > 0 ? [fleet[0] as Machine] : [])]) {
            for (const rows of [0, 3]) {
              for (const needle of [false, true]) {
                for (const hidden of [0, 2]) {
                  const input: Input = { device, server, registry, fleet, selected, rows, needle, hidden };
                  const body = listBody(input);
                  asked += 1;
                  reached.set(body.kind, (reached.get(body.kind) ?? 0) + 1);
                  const read = selected === null ? fleet : [selected];

                  // The three sentences that claim something is empty, each only from a read that answered.
                  if (body.kind === "no_machines" && !(registry === "known" && fleet.length === 0)) offender("no machines", input, body.kind);
                  if (body.kind === "no_sessions" && !read.some((machine) => machine.sessions === "known")) offender("no sessions", input, body.kind);
                  if (body.kind === "no_match" && (!needle || read.some(unsettled))) offender("no match", input, body.kind);
                  // Rows are drawn whenever there are rows, whatever else is true.
                  if ((body.kind === "rows") !== (fleet.length > 0 && rows > 0)) offender("rows", input, body.kind);
                  // A shape is a wait: something is being asked, or nothing has been yet.
                  if (body.kind === "skeleton" && fleet.length > 0 && !read.some(unsettled)) offender("skeleton", input, body.kind);
                  if (body.kind === "skeleton" && fleet.length === 0 && (registry === "known" || server === "unreachable" || server === "refusing")) {
                    offender("skeleton", input, body.kind);
                  }
                  // What was not reached is named for what it is, never one for another.
                  if (body.kind === "network" && device !== "offline") offender("network", input, body.kind);
                  // Offline renames a failure and is none by itself: with nothing held it waits for the listing to have failed.
                  if (body.kind === "network" && fleet.length === 0 && server !== "unreachable") offender("offline with nothing failed", input, body.kind);
                  if (body.kind === "network" && fleet.length > 0 && !read.some((machine) => machine.reach === "offline")) {
                    offender("offline with nothing failed", input, body.kind);
                  }
                  // A server that answered with an error was reached, so it alone keeps its name on a device that says it is offline.
                  if (body.kind === "server" && device === "offline" && body.why !== "refusing") offender("server", input, body.kind);
                  if (body.kind === "unreachable" && (device === "offline" || body.names.length === 0)) offender("machine", input, body.kind);
                  if (
                    body.kind === "unreachable" &&
                    read.some((machine) => machine.reach === "offline" && machine.offlineReason === "cp_unreachable")
                  ) {
                    offender("a machine named for the server", input, body.kind);
                  }
                  // Nor is one named while the server is still being asked which of the two it is.
                  if ((body.kind === "unreachable" || body.kind === "network") && read.some((machine) => machine.doubted && wireDown(machine))) {
                    offender("a machine named while in doubt", input, body.kind);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  report("the grid was walked", asked > 10_000, `${asked} states`);
  check("and no state breaks a rule", broken, []);
  const KINDS = [
    "rows",
    "skeleton",
    "network",
    "server",
    "no_machines",
    "no_match",
    "filtered",
    "owner_disabled",
    "over_limit",
    "unreachable",
    "refused",
    "sessions_failed",
    "no_sessions",
  ];
  // Differenced, never counted: a kind the grid cannot reach is a rule nothing above exercised.
  check("every kind is reached, and nothing outside the union is answered", [...reached.keys()].sort(), [...KINDS].sort());

  const nothing = { fleet: [], selected: null, rows: 0, needle: false, hidden: 0 } as const;
  check(
    "with nothing held: a wait until the listing has answered or failed, then what was not reached, and no machines only from an answer",
    [
      listBody({ ...nothing, device: "online", server: "unknown", registry: "unknown" }),
      listBody({ ...nothing, device: "online", server: "unreachable", registry: "failed" }),
      listBody({ ...nothing, device: "online", server: "refusing", registry: "failed" }),
      listBody({ ...nothing, device: "offline", server: "unreachable", registry: "failed" }),
      listBody({ ...nothing, device: "offline", server: "unknown", registry: "unknown" }),
      listBody({ ...nothing, device: "offline", server: "refusing", registry: "failed" }),
      listBody({ ...nothing, device: "online", server: "ok", registry: "known" }),
      listBody({ ...nothing, device: "offline", server: "unreachable", registry: "known" }),
    ],
    [
      { kind: "skeleton" },
      { kind: "server", why: "unreachable" },
      { kind: "server", why: "refusing" },
      { kind: "network" },
      { kind: "skeleton" },
      { kind: "server", why: "refusing" },
      { kind: "no_machines" },
      { kind: "no_machines" },
    ],
  );
  const one = (patch: Partial<Machine>): Machine => ({
    name: "studio",
    reach: "online",
    offlineReason: null,
    ownerDisabled: false,
    overLimit: false,
    sessions: "known",
    doubted: false,
    ...patch,
  });
  const tab = (machine: Machine, patch: Partial<Input> = {}): ReturnType<typeof listBody> =>
    listBody({ device: "online", server: "ok", registry: "known", fleet: [machine], selected: machine, rows: 0, needle: false, hidden: 0, ...patch });
  // The sentence this used to be: "No sessions here yet. New session, at the bottom of this list, starts one."
  check(
    "a machine's tab with nothing to draw says why, and calls it empty only once its sessions were read",
    [
      tab(one({})),
      tab(one({ sessions: "unknown" })),
      tab(one({ sessions: "failed" })),
      tab(one({ reach: "offline", offlineReason: "no_route", sessions: "unknown" })),
      tab(one({ reach: "offline", offlineReason: "no_route", doubted: true })),
      tab(one({ reach: "offline", offlineReason: null })),
      tab(one({ reach: "offline", offlineReason: "cp_unreachable" })),
      tab(one({ reach: "offline", offlineReason: "cp_unreachable" }), { server: "refusing" }),
      tab(one({ reach: "offline", offlineReason: "no_route" }), { device: "offline" }),
      tab(one({ reach: "offline", offlineReason: "not_enrolled", sessions: "unknown" })),
      tab(one({ reach: "probing", sessions: "unknown" })),
    ],
    [
      { kind: "no_sessions" },
      { kind: "skeleton" },
      { kind: "sessions_failed", name: "studio" },
      { kind: "unreachable", names: ["studio"] },
      { kind: "skeleton" },
      { kind: "unreachable", names: ["studio"] },
      { kind: "server", why: "unreachable" },
      { kind: "server", why: "refusing" },
      { kind: "network" },
      { kind: "refused", name: "studio", reason: "not_enrolled" },
      { kind: "skeleton" },
    ],
  );
  check(
    "a needle and a filter keep their own sentences, a wait outranks both, and the ban is said before the limit",
    [
      tab(one({}), { needle: true }),
      tab(one({ sessions: "unknown" }), { needle: true }),
      tab(one({}), { hidden: 4 }),
      tab(one({ reach: "offline", offlineReason: "owner_disabled", ownerDisabled: true, overLimit: true })),
      tab(one({ reach: "offline", offlineReason: "over_limit", overLimit: true }), { hidden: 4 }),
    ],
    [{ kind: "no_match" }, { kind: "skeleton" }, { kind: "filtered", hidden: 4 }, { kind: "owner_disabled" }, { kind: "over_limit" }],
  );
  const under = (fleet: Machine[]): ReturnType<typeof listBody> =>
    listBody({ device: "online", server: "ok", registry: "known", fleet, selected: null, rows: 0, needle: false, hidden: 0 });
  check(
    "under All every machine is read: one still asked is a wait, one unreachable is named, and several are counted",
    [
      under([one({}), one({ name: "mini" })]),
      under([one({}), one({ name: "mini", reach: "unknown", sessions: "unknown" })]),
      under([one({}), one({ name: "mini", reach: "offline", offlineReason: "no_route" })]),
      under([one({ reach: "offline", offlineReason: null }), one({ name: "mini", reach: "offline", offlineReason: "no_route" })]),
      under([one({ sessions: "failed" }), one({ name: "mini", sessions: "failed" })]),
      under([one({ reach: "offline", offlineReason: "no_token", sessions: "unknown" })]),
    ],
    [
      { kind: "no_sessions" },
      { kind: "skeleton" },
      { kind: "unreachable", names: ["mini"] },
      { kind: "unreachable", names: ["studio", "mini"] },
      { kind: "sessions_failed", name: null },
      { kind: "refused", name: "studio", reason: "no_token" },
    ],
  );
}

process.stdout.write("\nand every screen that could call an unread list empty asks first\n");
{
  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  const shell = stripComments(srcFile("ui/AppShell.tsx"));
  const block = stripComments(srcFile("ui/Unreachable.tsx"));
  const store = stripComments(srcFile("store.ts"));

  check(
    "the list draws from the one function, and a sentence names a machine by its own label",
    [
      /const body = listBody\(\{/.test(browser),
      /fleet: state\.machines\.map\(\(machine\) => bodyMachine\(state, machine\)\)/.test(browser),
      /sessions: state\.listed\.has\(machine\.id\) \? "known" : state\.sessionsFailed\.has\(machine\.id\) \? "failed" : "unknown",\s*doubted: state\.doubted\.has\(machine\.id\),/.test(browser),
      /const probing =/.test(browser),
    ],
    [true, true, true, false],
  );
  const empties = [...browser.matchAll(/No sessions here yet\.|No machines yet\./g)].length;
  check(
    "each empty sentence is written once in the list, behind the kind that earns it",
    [
      empties,
      /\{body\.kind === "no_machines" && \(\s*<div className="px-4 py-6 text-center">\s*<p className="text-sm text-muted">No machines yet\.<\/p>/.test(browser),
      /\) : \(\s*<>\s*<p className="text-sm text-muted">No sessions here yet\.<\/p>/.test(browser),
    ],
    [2, true, true],
  );
  check(
    "what was not reached is drawn by the one block, for each of the four things it can be",
    [
      /\{body\.kind === "network" && <Unreachable cause=\{\{ what: "network" \}\}/.test(browser),
      /\{body\.kind === "server" && \(\s*<Unreachable cause=\{\{ what: "server", why: body\.why \}\}/.test(browser),
      /\{body\.kind === "unreachable" && <Unreachable cause=\{\{ what: "machines", names: body\.names \}\}/.test(browser),
      /\{body\.kind === "sessions_failed" && <Unreachable cause=\{\{ what: "sessions", name: body\.name \}\}/.test(browser),
    ],
    [true, true, true, true],
  );
  check(
    "a body that names what is unreachable reports it, so the pill beside it is silent",
    [
      /const speaks = body\.kind === "network" \|\| body\.kind === "server" \|\| body\.kind === "unreachable";/.test(browser),
      /useEffect\(\(\) => onSpeaks\?\.\(speaks\), \[onSpeaks, speaks\]\);/.test(browser),
      /onSpeaks=\{setSpeaks\}/.test(browser),
    ],
    [true, true, true],
  );
  // The pane used to say "No machines yet." beside an install command while the registry had never been read.
  check(
    "the pane at lg asks the same function, and draws its two sentences only from an answer",
    [
      /const body = listBody\(\{[\s\S]{0,260}fleet: \[\],/.test(shell),
      /if \(body\.kind === "network" \|\| body\.kind === "server"\) \{\s*return \(\s*<div className="mx-auto w-full max-w-xs pt-2">\s*<Unreachable/.test(shell),
      /if \(body\.kind !== "no_machines"\) return null;/.test(shell),
      /const probing =/.test(shell),
    ],
    [true, true, true, false],
  );
  check(
    "in the rail the control and the accounts step aside for the pane only where the pane draws them",
    [
      /function splits\(state: AppState, activeKey: SessionKey \| null\): boolean \{\s*return state\.machines\.length === 0 && activeKey === null;/.test(browser),
      /<div className="lg:hidden">\{whole\}<\/div>\s*<div className="hidden lg:block">\s*<Empty failed>/.test(block),
    ],
    [true, true],
  );

  check(
    "the block offers the other accounts for a server alone, and never inside a sheet",
    [
      /\{accounts && cause\.what === "server" && <OtherAccounts \/>\}/.test(block),
      /list\.accounts\.filter\(\(account\) => !account\.current\)/.test(block),
      /store\s*\.switchAccount\(account\.key\)/.test(block),
      (block.match(/accounts=\{false\}/g) ?? []).length >= 4,
    ],
    [true, true, true, true],
  );
  const { RETRY_FLOOR_MS } = await import("../src/ui/Unreachable.js");
  check("a press is drawn for at least 400 ms", RETRY_FLOOR_MS, 400);
  const retry = /async retry\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(store)?.[1] ?? "";
  report("the store's retry was found", retry.length > 0, retry.replace(/\s+/g, " ").trim());
  // F15: with nothing held the poll already asked every four seconds, and a press only joined that pass.
  check(
    "the reader's attempt starts or adopts a pass, and puts the automatic one off a full interval",
    [
      /this\.nextListingAt = Date\.now\(\) \+ OFFLINE_RETRY_MS;/.test(retry),
      /await this\.resume\("retry"\);/.test(retry),
      /Promise\.all\(\[store\.retry\(\), floor\]\)/.test(block),
      /if \(this\.registryFailed\(\)\) \{\s*const now = Date\.now\(\);\s*if \(now < this\.nextListingAt\) return;\s*this\.nextListingAt = now \+ \(this\.serverRaw\.state === "unreachable" \? DOWN_RETRY_MS : OFFLINE_RETRY_MS\);/.test(store),
      // Q3.716: the pass it adopts may be waiting on a listing that went out before the link was back, so it asks for itself too.
      /if \(this\.resumeInFlight !== null && this\.listingOut !== null && this\.listingFree\(\) && cp\.currentCredential\(\) !== null\) void this\.listMachines\(this\.epoch\);\s*await this\.resume\("retry"\);/.test(retry),
    ],
    [true, true, true, true, true],
  );
  check(
    "the listing is asked again on a degraded token or a failed mint, and at once for a machine newly down on the wire",
    [
      /const troubled = this\.snapshot\.cpError !== null \|\| this\.awayAsks !== null \|\| serverEvidence\(\[\.\.\.this\.connections\.values\(\)\]\.map\(\(c\) => c\.state\(\)\)\);/.test(store),
      /const doubt = this\.snapshot\.cpError === null && \[\.\.\.this\.snapshot\.doubted\]\.some\(\(id\) => !this\.answeredFor\.has\(id\)\);\s*if \(\(troubled \|\| doubt\) && this\.connections\.size > 0/.test(store),
      /if \(this\.listingFree\(\) && \(doubt \|\| Date\.now\(\) >= this\.nextListingAt\)\) this\.askListing\(epoch\);/.test(store),
      /if \(next === "ok"\) \{\s*this\.serverAnsweredAt = monotonicNow\(\);/.test(store),
      /this\.wireDown = wireDownSince\(this\.wireDown, raw, now\);/.test(store),
    ],
    [true, true, true, true, true],
  );
  check(
    "a sign-out is the credential's and says nothing about the server, and a new sign-in asks afresh",
    [
      /if \(authFailure\(error\) !== null\) return;\s*if \(epoch === this\.epoch && asked > this\.listingLanded\) \{[^}]*this\.patch\(\{ cpError: describe\(error\), \.\.\.this\.serverFacts\(listingFailure\(error\), began, retried\) \}\);/.test(store),
      /this\.patch\(\{ phase: "loading", cpError: null, \.\.\.this\.serverFacts\("unknown", monotonicNow\(\)\) \}\);/.test(store),
    ],
    [true, true],
  );
  check(
    "a session listing the daemon refused is an answer of its own, and the wire failing is not",
    [
      /const answered = ApiError\.isApiError\(error\) && !meansLater\(error\);\s*if \(answered\) this\.sessionsFailed\.add\(connection\.id\);/.test(store),
      /this\.listed\.add\(connection\.id\);\s*this\.sessionsFailed\.delete\(connection\.id\);/.test(store),
      // The wire failing is dated instead, from the failure: a probe that passes is no proof a listing will (Q3.714).
      /if \(answered\) this\.listFailing\.delete\(connection\.id\);\s*else if \(first\) this\.listFailing\.set\(connection\.id, monotonicNow\(\)\);/.test(store),
      /this\.sessionsFailed\.delete\(connection\.id\);\s*this\.listFailing\.delete\(connection\.id\);/.test(store),
    ],
    [true, true, true, true],
  );

  // The nine sentences of the review's F3, each now behind a read that answered. A census by file, so a new copy is found.
  const GUARDED: readonly (readonly [string, RegExp, RegExp])[] = [
    ["ui/NewSession.tsx", /No machines yet\./, /if \(machines\.length === 0 && unread !== null\) \{[\s\S]{0,160}\{unread\}/],
    ["ui/plugins/MachineInstalls.tsx", /noRowsText\(0, "", filter\)/, /\{registryUnread\(state\) \?\? <Empty>\{noRowsText\(0, "", filter\)\}<\/Empty>\}/],
    ["ui/SessionView.tsx", /That machine is no longer granted to you\./, /const unread = machine === undefined && state\.registry !== "known";/],
    ["ui/settings/MachineSection.tsx", /MACHINE_GONE\}/, /registryUnread\(state\) \?\? <Empty>\{MACHINE_GONE\}<\/Empty>/],
    ["ui/settings/MachineSystemsSection.tsx", /MACHINE_GONE\}/, /registryUnread\(state\) \?\? \(\s*<Empty/],
    ["ui/settings/MachineAgentsSection.tsx", /MACHINE_GONE\}/, /registryUnread\(state\) \?\? \(\s*<Empty/],
    ["ui/settings/MachinePluginsSection.tsx", /MACHINE_GONE\}/, /registryUnread\(state\) \?\? \(\s*<Empty/],
    ["ui/AgentBuilder.tsx", /MACHINE_GONE\}/, /\{registryUnread\(state\) \?\? <Empty>\{MACHINE_GONE\}<\/Empty>\}/],
    ["ui/plugins/PluginSettings.tsx", /None of those machines is in your list any more/, /const unread = registryUnread\(state\);\s*if \(unread !== null\) return/],
    ["ui/plugins/InstalledList.tsx", /Nothing is installed on any of your machines yet\./, /registryUnread\(state\) \?\? pluginsUnread\(state\) \?\? <Empty>Nothing is installed/],
    ["ui/plugins/PluginsSheet.tsx", /\{NO_CATALOGUE\}/, /configUnread\(state\) \?\? <Empty>\{NO_CATALOGUE\}<\/Empty>/],
    ["ui/settings/LogsSection.tsx", /nothingHere\(status, stranger\)/, /unread \? \(\s*<Empty failed>Couldn’t load the daemon’s output<\/Empty>\s*\) : \(/],
  ];
  const sources = new Map(GUARDED.map(([rel]) => [rel, stripComments(srcFile(rel))] as const));
  report("every guarded file still holds its sentence", GUARDED.every(([rel, sentence]) => sentence.test(sources.get(rel) ?? "")), `${GUARDED.length} files`);
  check(
    "and none of them draws it without asking",
    GUARDED.filter(([rel, , guard]) => !guard.test(sources.get(rel) ?? "")).map(([rel]) => rel),
    [],
  );
  // Every file that draws the gone sentence as a screen's body, found rather than listed: a new one owes the same guard.
  const bodies = srcFiles()
    .filter((rel) => /<Empty[^>]*>\s*\{MACHINE_GONE\}|>\s*\{MACHINE_GONE\}\s*<\/Empty>/.test(stripComments(srcFile(rel))))
    .sort();
  report("the screens that draw a gone machine were found", bodies.length >= 5, bodies.join(", "));
  check(
    "each of them asks whether the list was read first",
    bodies.filter((rel) => !/registryUnread\(state\) \?\?/.test(stripComments(srcFile(rel)))),
    [],
  );
  check(
    "the guards themselves: a wait until asked, what was not reached after, and null only from an answer",
    [
      /export function registryUnread\(state: Unread\): ReactNode \| null \{\s*if \(state\.registry === "known"\) return null;/.test(block),
      /if \(state\.config !== null \|\| state\.configRead === "known"\) return null;/.test(block),
      /const unread = state\.machines\.filter\(\(machine\) => state\.pluginsRead\.get\(machine\.id\) !== "known"\);\s*if \(unread\.length === 0\) return null;/.test(block),
    ],
    [true, true, true],
  );
  check(
    "a plugin read that failed is marked and asked for again by the reader's own retry, and an older server's 404 is an answer",
    [
      /this\.pluginsRead\.set\(id, "failed"\);/.test(store),
      /if \(this\.pluginsRead\.get\(id\) === "failed"\) \{\s*this\.pluginsByMachine\.delete\(id\);\s*this\.pluginsRead\.delete\(id\);/.test(store),
      /this\.patch\(\{ configRead: ApiError\.isApiError\(error\) \? "known" : "failed" \}\);/.test(store),
    ],
    [true, true, true],
  );
}

process.stdout.write("\nthe shell is drawn at once, and claims nothing before the first answer\n");
{
  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  const drawer = stripComments(srcFile("ui/MenuDrawer.tsx"));
  const column = stripComments(srcFile("ui/MachineColumn.tsx"));
  const { refusedSectionText } = await import("../src/settings.js");

  check(
    "nothing can be started, and nothing is said to be waiting, while no machine is held and the registry is unread",
    [
      /const nowhere = state\.machines\.length === 0 && state\.registry !== "known";/.test(browser),
      /<SidebarFoot machine=\{view\.machine\} disabled=\{nowhere\} \/>/.test(browser),
      /label=\{\s*unchecked\s*\? "Not checked yet"\s*: waiting\.length > 0/.test(browser),
    ],
    [true, true, true],
  );
  // They used to mount when `me` landed: a row arriving under a finger that had already opened the drawer.
  check(
    "the drawer's two destinations are drawn from the first frame, and open once the account is known",
    [
      /\{me !== null && \(\s*<button/.test(drawer),
      (drawer.match(/disabled=\{me === null\}/g) ?? []).length,
      (drawer.match(/disabled:bg-transparent disabled:text-faint/g) ?? []).length,
    ],
    [false, 2, 2],
  );
  check(
    "the machine column's Add is drawn on an unknown account, since the door fails open, and opens on a known one",
    /disabled=\{state\.meRead !== "known"\}\s*onClick=\{\(\) => navigate\(settingsPath\("machines"\)\)\}/.test(column),
    true,
  );
  check(
    "an account not read yet has not been found wanting: an admin section refuses only a known one",
    [
      refusedSectionText("users" as never, null),
      refusedSectionText("users" as never, { isAdmin: false } as never) !== null,
      refusedSectionText("users" as never, { isAdmin: true } as never),
    ],
    [null, true, null],
  );
}

process.stdout.write("\na link that drops and is back inside the quiet window is drawn nowhere\n");
{
  const { doubtedOf, drawnReach, drawnServer, onTheWire, outlasted, RECONNECT_QUIET_MS, retriedDown, retryDelay, SERVER_CONFIRM_MS, SERVER_NAMED_AFTER_MS, serverDrawnAt, wantsServer, wireDownSince } =
    await import("../src/reach.js");
  const Q = RECONNECT_QUIET_MS;

  check("the quiet window, and that a server is still a reconnect when it ends", [Q, Q < SERVER_NAMED_AFTER_MS], [5_000, true]);
  check(
    "a spell has outlasted it at the millisecond and not before, and one nothing dated never has",
    [outlasted(100, 100 + Q - 1), outlasted(100, 100 + Q), outlasted(null, 1e9), outlasted(100, 400, 300)],
    [false, true, false, true],
  );
  // The first reconnects of every client read for this are near at once; a flat fifteen seconds made one lost request a drawn outage.
  check(
    "a first failure is asked again a second later, and each one after it later, up to the pace an outage is asked at",
    [0, 1, 2, 3, 4, 5, 6, 40].map((failures) => retryDelay(failures, 15_000)),
    [1_000, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000],
  );
  // Q3.716: fifteen seconds between asks, on top of ten for one to time out, was most of half a minute after the link was back.
  check(
    "and what nothing answered is never asked more slowly than the poll asks what answers",
    [1, 2, 3, 4, 40].map((failures) => retryDelay(failures, 4_000)),
    [1_000, 2_000, 4_000, 4_000, 4_000],
  );

  const REASONS = [null, "no_route", "cp_unreachable", "no_token", "not_enrolled", "over_limit", "owner_disabled", "no_machine_key", "no_device_key", "machine_key_changed", "device_pending"] as const;
  check(
    "down for a reason the app keeps retrying is the wire or the server a token is minted by, and every other reason is an answer",
    REASONS.filter((reason) => retriedDown("offline", reason)),
    [null, "no_route", "cp_unreachable"],
  );
  check(
    "and it is exactly the two the reader already has names for",
    REASONS.filter((reason) => retriedDown("offline", reason) !== (onTheWire("offline", reason) || wantsServer("offline", reason))),
    [],
  );
  check(
    "since when is kept over those reasons too, by the function that keeps it for the wire",
    [...wireDownSince(new Map([["studio", 100]]), [{ id: "studio", reach: "offline", offlineReason: "cp_unreachable" }, { id: "mini", reach: "offline", offlineReason: "no_token" }] as never, 300, retriedDown)],
    [["studio", 100]],
  );

  const down = (reason: (typeof REASONS)[number], relayOnline = true) => ({ reach: "offline" as const, offlineReason: reason, relayOnline });
  check(
    "a machine found down keeps what it was drawn as until it has been down for the window, and not a millisecond longer",
    [
      drawnReach(down("no_route"), "online", 100, 100 + Q - 1, "online"),
      drawnReach(down("no_route"), "online", 100, 100 + Q, "online"),
      drawnReach(down(null), "online", 100, 200, "online"),
      drawnReach(down("cp_unreachable"), "online", 100, 200, "online"),
    ],
    ["online", "offline", "online", "online"],
  );
  check(
    "one never drawn up is held only while the server says its daemon is dialled in: a machine that is off is said to be at once",
    [
      drawnReach(down("no_route"), "probing", 100, 200, "online"),
      drawnReach(down("no_route", false), "probing", 100, 200, "online"),
      drawnReach(down("cp_unreachable"), "unknown", 100, 200, "online"),
      drawnReach(down("no_route", false), "online", 100, 200, "online"),
    ],
    ["probing", "offline", "unknown", "online"],
  );
  check(
    "nothing is held that was an answer, that nothing dated, that was refused before, or on a device that says it is offline",
    [
      drawnReach(down("over_limit"), "online", 100, 200, "online"),
      drawnReach(down("no_route"), "online", undefined, 200, "online"),
      drawnReach(down("no_route"), "offline", 100, 200, "online"),
      drawnReach(down("no_route"), undefined, 100, 200, "online"),
      drawnReach(down("no_route"), "online", 100, 200, "offline"),
      drawnReach({ reach: "online", offlineReason: null, relayOnline: true }, "online", undefined, 200, "online"),
    ],
    ["offline", "offline", "offline", "offline", "offline", "online"],
  );
  // The rule as a property over every state: what is drawn is the fact or what was drawn before it, and the fact once the window is spent.
  const REACHES = ["unknown", "probing", "online", "offline"] as const;
  let walked = 0;
  const broken: string[] = [];
  for (const reach of REACHES) {
    for (const reason of REASONS) {
      for (const before of [undefined, ...REACHES]) {
        for (const relayOnline of [true, false]) {
          for (const device of ["online", "offline"] as const) {
            for (const elapsed of [0, 1, Q - 1, Q, Q * 4]) {
              walked += 1;
              const raw = { reach, offlineReason: reach === "offline" ? reason : null, relayOnline };
              const drawn = drawnReach(raw, before, 1_000, 1_000 + elapsed, device);
              const held = drawn !== raw.reach;
              const state = `${reach}/${String(reason)} before ${String(before)} relay ${String(relayOnline)} ${device} +${String(elapsed)}`;
              if (held && drawn !== before) broken.push(`${state}: drawn as ${drawn}, which is neither`);
              if (held && (elapsed >= Q || device === "offline")) broken.push(`${state}: held past the window or offline`);
              if (held && !retriedDown(raw.reach, raw.offlineReason)) broken.push(`${state}: an answer was held`);
              if (held && drawn === "offline") broken.push(`${state}: held as down`);
            }
          }
        }
      }
    }
  }
  report("the grid of machine states was walked", walked > 3_000, `${String(walked)} states`);
  check("and none is drawn as anything but the fact or what stood before it", broken, []);

  const ok = { state: "ok" as const, since: null };
  const unasked = { state: "unknown" as const, since: null };
  const unreachable = (since: number) => ({ state: "unreachable" as const, since });
  const refusing = { state: "refusing" as const, since: 100 };
  check(
    "a server that stopped answering is drawn as what it was until that has outlasted the window: answering, or still unasked",
    [
      drawnServer(unreachable(100), ok, 100 + Q - 1, "online"),
      drawnServer(unreachable(100), ok, 100 + Q, "online"),
      drawnServer(unreachable(100), unasked, 200, "online"),
      drawnServer(unreachable(100), refusing, 200, "online"),
    ],
    [ok, unreachable(100), unasked, refusing],
  );
  check(
    "an answer is drawn at once, an error included; so is a failure nothing dated apart from its start, and anything on an offline device",
    [
      drawnServer(refusing, ok, 100, "online"),
      drawnServer(ok, unreachable(100), 200, "online"),
      drawnServer(unreachable(100), ok, 100 + 10_000, "online"),
      drawnServer(unreachable(100), ok, 200, "offline"),
      drawnServer(unreachable(100), unreachable(100), 200, "online"),
    ],
    [refusing, ok, unreachable(100), unreachable(100), unreachable(100)],
  );
  // Q3.716: a request that timed out is known to have failed long after it was asked, with its window already spent. One
  // lost listing was drawn the moment it was known, and gone a second later when the next one answered.
  const C = SERVER_CONFIRM_MS;
  check(
    "a listing whose failure landed late is asked again before it is drawn: held from when it was learned, not from when it was asked",
    [
      drawnServer(unreachable(100), ok, 10_100, "online", 10_100),
      drawnServer(unreachable(100), ok, 10_100 + C - 1, "online", 10_100),
      drawnServer(unreachable(100), ok, 10_100 + C, "online", 10_100),
      serverDrawnAt(unreachable(100), 10_100),
    ],
    [ok, ok, unreachable(100), 10_100 + C],
  );
  check(
    "one that failed at once is held by the quiet window as before, the confirmation being the shorter of the two",
    [C < Q, serverDrawnAt(unreachable(100), 105), drawnServer(unreachable(100), ok, 100 + Q - 1, "online", 105), drawnServer(unreachable(100), ok, 100 + Q, "online", 105)],
    [true, 100 + Q, ok, unreachable(100)],
  );
  check(
    "and what was already drawn, or is said on an offline device, waits for neither",
    [drawnServer(unreachable(100), unreachable(100), 10_100, "online", 10_100), drawnServer(unreachable(100), ok, 10_100, "offline", 10_100)],
    [unreachable(100), unreachable(100)],
  );
  // A link that was down for everything comes back to the server first. The machine found down before that has not been
  // asked since, and was named as its own trouble for the seconds until it was.
  const downAt = new Map([["studio", 100]]);
  const proof = (answered: number | null, probed: number | null): { answered: Map<string, number>; probed: Map<string, number> } => ({
    answered: new Map(answered === null ? [] : [["studio", answered]]),
    probed: new Map(probed === null ? [] : [["studio", probed]]),
  });
  check(
    "a machine found down is in doubt until the server has answered since, and a probe begun after that answer has failed",
    [
      [...doubtedOf(downAt, 50, proof(null, 90))],
      [...doubtedOf(downAt, 300, proof(null, 400))],
      [...doubtedOf(downAt, 300, proof(300, 90))],
      [...doubtedOf(downAt, 300, proof(300, 299))],
      [...doubtedOf(downAt, 300, proof(300, null))],
    ],
    [["studio"], ["studio"], ["studio"], ["studio"], ["studio"]],
  );
  const { MachineConnection } = await import("../src/machine.js");
  const unenrolled = new MachineConnection({ id: "m_probe", name: "probe", relayUrl: "wss://relay.invalid", relayOnline: true, enrolled: false, owned: true, scopes: [] } as never, () => {});
  const unprobed = unenrolled.probedSince();
  await unenrolled.resolveRoute();
  const firstProbe = unenrolled.probedSince();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await unenrolled.resolveRoute();
  check("a machine dates each probe from its own start, so the newest failure is not taken for the first", [unprobed, firstProbe > 0, unenrolled.probedSince() > firstProbe], [0, true, true]);
  // The answer it is held to is the first since the machine went down, and stays that. Held to the newest, every later
  // listing put a machine already named back in doubt, and each doubt asked for another listing.
  check(
    "and one begun at that answer or after it settles it, whatever answers later; a caller that keeps no probes is told as before",
    [[...doubtedOf(downAt, 300, proof(300, 300))], [...doubtedOf(downAt, 9_000, proof(300, 400))], [...doubtedOf(downAt, 300)], [...doubtedOf(downAt, 50)]],
    [[], [], [], ["studio"]],
  );
  const { undialled } = await import("../src/reach.js");
  check(
    "a daemon is not dialled in where the server said so and nothing was asked of it: never one whose probe failed on the wire, or that was refused",
    [
      undialled({ reach: "offline", offlineReason: "no_route", relayOnline: false }),
      undialled({ reach: "offline", offlineReason: "no_route", relayOnline: true }),
      undialled({ reach: "offline", offlineReason: "over_limit", relayOnline: false }),
      undialled({ reach: "online", offlineReason: null, relayOnline: false }),
    ],
    [true, false, false, false],
  );

  const store = stripComments(srcFile("store.ts"));
  const tick = store.slice(store.indexOf("private async tick(early = false)"), store.indexOf("private async fetchRoots("));
  report("the poll was found", tick.length > 0, `${String(tick.length)} chars`);
  check(
    "the hold is what is drawn and nothing else: the poll, the doubt and the retries read the facts as the connections and the listings gave them",
    [
      /this\.machinesCache = raw\.map\(\(machine\) => this\.drawnMachine\(machine, now\)\);/.test(store),
      /this\.downAt = wireDownSince\(was, raw, now, retriedDown\);/.test(store),
      /const state = connection\.state\(\);\s*if \(state\.reach === "offline"\) \{/.test(tick),
      /this\.snapshot\.machines/.test(store),
      /this\.serverRaw = serverAfter\(this\.serverRaw, next, began\);[\s\S]{0,700}return this\.serverDrawn\(\);/.test(store),
      /return registryOf\(this\.registryKnown, this\.serverRaw\.state\) === "failed";/.test(store),
      /this\.snapshot\.registry === "failed"/.test(store),
    ],
    [true, true, true, false, true, true, false],
  );
  check(
    "a pass between two polls asks again about what is down, and leaves what answers to the poll",
    [
      /\} else if \(early\) return;/.test(tick),
      // A machine that answers and whose sessions could not be read is not one that answers: the pass reads them again.
      /\} else if \(early && !this\.listFailing\.has\(connection\.id\)\) return;/.test(tick),
      /if \(document\.visibilityState !== "visible"\) return;\s*void this\.tick\(true\);/.test(store),
    ],
    [true, true, true],
  );
  check(
    "a failure sets the next attempt by the count of them, an answer starts the count over, and a refusal keeps the outage's own pace",
    [
      /this\.listingFailures = serverTroubled\(next\) \? this\.listingFailures \+ 1 : 0;/.test(store),
      /this\.nextListingAt = pacedFrom \+ this\.listingWait\(\);\s*this\.soon\(Math\.max\(0, this\.nextListingAt - Date\.now\(\)\)\);/.test(store),
      // Q3.716: what nothing answered is asked at the poll's own pace, and only a refusal keeps the outage's.
      /return retryDelay\(this\.listingFailures, this\.serverRaw\.state === "refusing" \? OFFLINE_RETRY_MS : DOWN_RETRY_MS\);/.test(store),
      /const wait = failures === null \? OFFLINE_RETRY_MS : unsettled \? 0 : retryDelay\(failures, DOWN_RETRY_MS\);/.test(store),
      /const POLL_INTERVAL_MS = 4_000;[\s\S]{0,400}const DOWN_RETRY_MS = 4_000;/.test(store),
      /const failures = retriedDown\(state\.reach, state\.offlineReason\) \? \(this\.probeFailures\.get\(connection\.id\) \?\? 0\) \+ 1 : null;/.test(store),
      // Up by whatever door: a stream's own probe or a request's answer brings a machine back without the poll knowing.
      /if \(machine\.reach !== "online"\) continue;\s*this\.probeFailures\.delete\(machine\.id\);\s*this\.nextProbeAt\.delete\(machine\.id\);/.test(store),
      /if \(\[\.\.\.this\.downAt\.keys\(\)\]\.some\(\(id\) => !was\.has\(id\)\)\) this\.soon\(retryDelay\(1, OFFLINE_RETRY_MS\)\);/.test(store),
    ],
    [true, true, true, true, true, true, true, true],
  );
  check(
    "a spell once drawn as down is never taken back while it lasts: what was drawn is what a later hold would keep",
    /if \(reach === machine\.reach\) \{\s*this\.drawnAs\.set\(machine\.id, reach\);\s*return machine;\s*\}\s*this\.held\.add\(machine\.id\);/.test(store),
    true,
  );
  check(
    "a probe that brings a machine back redials its streams, bar one still live: that one outlived the failure and is its probation's to judge",
    /if \(stream\.ref\.machineId === connection\.id && stream\.status\(\)\.phase !== "live"\) stream\.reconnect\(\);/.test(tick),
    true,
  );
  check(
    "one timer releases the earliest hold, and what it publishes is weighed again rather than assumed",
    [
      /this\.holdTimer = due === null \? null : setTimeout\(\(\) => this\.releaseHolds\(\), Math\.max\(0, due - monotonicNow\(\)\)\);/.test(store),
      /let due: number \| null = this\.serverRaw !== this\.snapshot\.server \? serverDrawnAt\(this\.serverRaw, this\.serverLearnedAt\) : null;/.test(store),
      /if \(since !== undefined && \(due === null \|\| since \+ RECONNECT_QUIET_MS < due\)\) due = since \+ RECONNECT_QUIET_MS;/.test(store),
      /private releaseHolds\(\): void \{\s*this\.holdTimer = null;\s*this\.holdDue = null;\s*this\.snapshot = \{ \.\.\.this\.snapshot, \.\.\.this\.serverDrawn\(\) \};\s*this\.emit\(\);/.test(store),
      /this\.armHold\(\);\s*for \(const listener of this\.listeners\) listener\(\);/.test(store),
    ],
    [true, true, true, true, true],
  );
  check(
    "the device's word is set before anything is weighed under it, and a sign-out leaves no fact and no timer behind",
    [
      /this\.snapshot = \{ \.\.\.this\.snapshot, device \};\s*if \(online && this\.registryFailed\(\)\) \{/.test(store),
      /this\.serverRaw = SERVER_UNASKED;\s*this\.serverLearnedAt = null;\s*this\.listingFailures = 0;/.test(store),
      /if \(this\.soonTimer !== null\) clearTimeout\(this\.soonTimer\);\s*this\.soonTimer = null;/.test(store),
      /this\.probeFailures\.delete\(id\);\s*this\.probing\.delete\(id\);\s*this\.provedDown\.delete\(id\);\s*this\.answeredFor\.delete\(id\);\s*this\.away\.delete\(id\);\s*this\.drawnAs\.delete\(id\);\s*this\.listFailing\.delete\(id\);/.test(store),
    ],
    [true, true, true, true],
  );

  const stream = stripComments(srcFile("stream.ts"));
  check(
    "a stream dates its own loss: null while live, and otherwise the moment it stopped being, which a retry does not move",
    [
      /private downSince: number \| null = monotonicNow\(\);/.test(stream),
      /if \(phase === "live"\) this\.downSince = null;\s*else this\.downSince \?\?= monotonicNow\(\);/.test(stream),
      /downSince: this\.downSince,/.test(stream),
    ],
    [true, true, true],
  );
  const past = stripComments(srcFile("ui/past.ts"));
  check(
    "the hook that waits out a window renders once more at the crossing, and counts a timer that fired a hair early",
    [
      /const timer = window\.setTimeout\(\(\) => setCrossed\(since\), wait\);/.test(past),
      /return since !== null && \(crossed === since \|\| monotonicNow\(\) - since >= afterMs\);/.test(past),
    ],
    [true, true],
  );
}
