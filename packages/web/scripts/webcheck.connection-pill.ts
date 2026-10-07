import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

process.stdout.write("\nconnection trouble is one pill at the bottom-left, never a banner\n");
{
  const {
    connectionSpell,
    connectionTrouble,
    opensByItself,
    TROUBLE_GRACE_MS,
    TROUBLE_MIN_SHOWN_MS,
    TROUBLE_SIGHT_MS,
    troubleDue,
    troubleLive,
    troubleShown,
    troubleSince,
    troubleWait,
    troubleWords,
  } = await import("../src/ui/connection.js");
  const { RECONNECT_QUIET_MS, SERVER_NAMED_AFTER_MS } = await import("../src/reach.js");
  const machine = (id: string, patch: object = {}) =>
    ({ id, name: id, reach: "online", offlineReason: null, route: { base: "https://r", kind: "relay" }, ...patch }) as never;
  const healthy = {
    device: "online" as const,
    server: { state: "ok" as const, since: null as number | null },
    machines: [machine("studio"), machine("laptop")],
  };
  const all = { machines: "all" as const, open: null };
  // Monotonic, as the server's spell is: the pill is handed the clock rather than reading one.
  const NOW = 100_000;
  type Asked = Parameters<typeof connectionTrouble>;
  const ask = (state: Asked[0], scope: Asked[1]) => connectionTrouble(state, scope, NOW);
  const serverDown = (since: number) => ({ ...healthy, server: { state: "unreachable" as const, since } });

  check("a healthy fleet says nothing", ask(healthy, all), null);
  check("a server that has just stopped answering is a reconnect, and not end-to-end", ask(serverDown(NOW - 1), all), {
    kind: "connecting",
    e2ee: false,
  });
  check(
    "and it is named once its spell has outlasted a reconnect, to the millisecond",
    [ask(serverDown(NOW - SERVER_NAMED_AFTER_MS + 1), all), ask(serverDown(NOW - SERVER_NAMED_AFTER_MS), all)],
    [
      { kind: "connecting", e2ee: false },
      { kind: "server", why: "unreachable" },
    ],
  );
  check("which is ten seconds", SERVER_NAMED_AFTER_MS, 10_000);
  check(
    "a server that answers with an error is named at once: nothing is being waited for",
    ask({ ...healthy, server: { state: "refusing", since: NOW } }, all),
    { kind: "server", why: "refusing" },
  );
  // A server on this same computer answers with the network off, so offline alone is no trouble: it is the name for one.
  check(
    "this device being offline renames whatever failed, and says nothing over a fleet that still answers",
    [
      ask({ ...serverDown(0), device: "offline" }, all),
      ask({ ...serverDown(NOW - 1), device: "offline" }, all),
      ask({ ...healthy, device: "offline" }, all),
      ask({ ...healthy, device: "offline", machines: [machine("studio", { reach: "offline", offlineReason: "no_route", route: null })] }, { machines: ["studio" as never], open: null }),
      ask({ ...healthy, device: "offline" }, { machines: [] as never[], open: { machine: "studio" as never, stream: { phase: "waiting", lastAppliedSeq: 0, instanceId: null, error: null } as never } }),
    ],
    [{ kind: "network" }, { kind: "network" }, null, { kind: "network" }, { kind: "network" }],
  );
  check(
    "but a server that answered with an error was reached, and keeps its own name",
    ask({ ...healthy, device: "offline", server: { state: "refusing", since: NOW } }, all),
    { kind: "server", why: "refusing" },
  );
  check(
    "an unasked server with the shell on screen is the first listing still out",
    ask({ ...healthy, machines: [], server: { state: "unknown", since: null } }, all),
    { kind: "connecting", e2ee: false },
  );
  const down = (reason: string | null) => ({ ...healthy, machines: [machine("studio", { reach: "offline", offlineReason: reason, route: null })] });
  const tab = { machines: ["studio" as never], open: null };
  check(
    "under All a machine that is off is not trouble: it would hold the pill for as long as it stays off",
    [ask(down("no_route"), all), ask(down("cp_unreachable"), all), ask(down(null), all)],
    [null, null, null],
  );
  check(
    "a machine the wire cannot reach is named on its own tab",
    [ask(down("no_route"), tab), ask(down(null), tab)],
    [
      { kind: "unreachable", names: ["studio"] },
      { kind: "unreachable", names: ["studio"] },
    ],
  );
  // F11: a token the server never answered for used to name the machine, one tab at a time, and never the server.
  check(
    "a machine offline for want of the server is never named itself: it is a reconnect until the listing says which it is",
    ask(down("cp_unreachable"), tab),
    { kind: "connecting", e2ee: false },
  );
  // A full outage takes the relay with the server, so the machine goes down first: named at once, it was blamed for minutes.
  const doubtful = { ...down("no_route"), doubted: new Set(["studio"]) as never };
  check(
    "a machine down since the server last answered is a reconnect too, and is named only once the server has answered again",
    [ask(doubtful, tab), ask({ ...doubtful, doubted: new Set() as never }, tab), ask({ ...doubtful, server: { state: "unreachable", since: 0 } }, tab)],
    [{ kind: "connecting", e2ee: false }, { kind: "unreachable", names: ["studio"] }, { kind: "server", why: "unreachable" }],
  );
  check(
    "and it does not lend its silence to a machine beside it that the wire cannot reach",
    ask(
      {
        ...healthy,
        machines: [
          machine("studio", { reach: "offline", offlineReason: "cp_unreachable", route: null }),
          machine("laptop", { reach: "offline", offlineReason: "no_route", route: null }),
        ],
      },
      { machines: ["laptop" as never], open: null },
    ),
    { kind: "unreachable", names: ["laptop"] },
  );
  check(
    "a refusal somebody must act on is not connection trouble, and stays where it is drawn",
    ["over_limit", "owner_disabled", "not_enrolled", "no_token", "no_machine_key", "no_device_key"].map((reason) => ask(down(reason), tab)),
    [null, null, null, null, null, null],
  );
  check("a machine this screen does not read is not its trouble", ask(down("no_route"), { machines: ["laptop" as never], open: null }), null);
  // Q3.692: at launch the page asks before the host's child has announced, so this computer's machine reads offline for a few seconds.
  const launching = (starting: boolean) => ({ ...down("no_route"), localMachineId: "studio" as never, localDaemonStarting: starting });
  check(
    "this computer's daemon still starting is connecting rather than unreachable, on its tab and under All",
    [ask(launching(true), tab), ask(launching(true), all)],
    [
      { kind: "connecting", e2ee: false },
      { kind: "connecting", e2ee: false },
    ],
  );
  check("and once the host has stopped starting it, the same offline machine is named again", ask(launching(false), tab), {
    kind: "unreachable",
    names: ["studio"],
  });
  check(
    "while another machine the wire cannot reach is still named beside it",
    ask(
      {
        ...launching(true),
        machines: [
          machine("studio", { reach: "offline", offlineReason: "no_route", route: null }),
          machine("laptop", { reach: "offline", offlineReason: "no_route", route: null }),
        ],
      },
      { machines: ["studio" as never, "laptop" as never], open: null },
    ),
    { kind: "unreachable", names: ["laptop"] },
  );
  check(
    "and a refusal on this computer's machine is still nobody's connection trouble",
    ask({ ...launching(true), machines: [machine("studio", { reach: "offline", offlineReason: "over_limit", route: null })] }, tab),
    null,
  );
  check(
    "the open conversation's machine is read whatever the list shows",
    ask(down("no_route"), { machines: [], open: { machine: "studio" as never, stream: null } }),
    { kind: "unreachable", names: ["studio"] },
  );
  const stream = (phase: string) => ({ phase, lastAppliedSeq: 0, instanceId: null, error: null }) as never;
  const opened = (phase: string) => ({ machines: [] as never[], open: { machine: "studio" as never, stream: stream(phase) } });
  check(
    "a stream reattaching is connecting, end-to-end only down the relay",
    [
      ask(healthy, opened("waiting")),
      ask(healthy, opened("connecting")),
      ask({ ...healthy, machines: [machine("studio", { route: { base: "http://127.0.0.1", kind: "local" } })] }, opened("waiting")),
    ],
    [
      { kind: "connecting", e2ee: true },
      { kind: "connecting", e2ee: true },
      { kind: "connecting", e2ee: false },
    ],
  );
  check("a live, idle or closed stream is not trouble", ["live", "idle", "closed"].map((phase) => ask(healthy, opened(phase))), [null, null, null]);
  check("a first probe is connecting", ask({ ...healthy, machines: [machine("studio", { reach: "probing", route: null })] }, all), {
    kind: "connecting",
    e2ee: false,
  });
  check(
    "the server outranks a machine, and a machine outranks its own stream",
    [ask({ ...down("no_route"), server: { state: "unreachable", since: 0 } }, tab), ask(down("no_route"), opened("waiting"))],
    [
      { kind: "server", why: "unreachable" },
      { kind: "unreachable", names: ["studio"] },
    ],
  );
  check(
    "the words: three for the connection, and a machine by its name",
    [
      troubleWords({ kind: "connecting", e2ee: true }, "app.example"),
      troubleWords({ kind: "network" }, "app.example"),
      troubleWords({ kind: "server", why: "unreachable" }, "app.example"),
      troubleWords({ kind: "server", why: "refusing" }, "app.example"),
      troubleWords({ kind: "unreachable", names: ["studio"] }, "app.example"),
      troubleWords({ kind: "unreachable", names: ["studio", "laptop"] }, "app.example"),
    ],
    [
      "Connecting…",
      "Waiting for network…",
      "Can’t reach app.example",
      "app.example answered with an error",
      "studio is unreachable",
      "2 machines are unreachable",
    ],
  );
  check(
    "a reconnect says nothing a spinner does not, so it alone stays folded under a finger",
    [
      opensByItself({ kind: "connecting", e2ee: false }),
      opensByItself({ kind: "network" }),
      opensByItself({ kind: "server", why: "unreachable" }),
      opensByItself({ kind: "server", why: "refusing" }),
      opensByItself({ kind: "unreachable", names: ["studio"] }),
    ],
    [false, true, true, true, true],
  );

  // Q3.714: a link that drops and is back inside the quiet window is never drawn, and what is drawn does not flash.
  check("the three waits", [TROUBLE_GRACE_MS, RECONNECT_QUIET_MS, TROUBLE_MIN_SHOWN_MS], [1_000, 5_000, 1_500]);
  check(
    "a spell begins once, survives a change of kind, and ends with the trouble",
    [troubleSince(null, true, 100), troubleSince(100, true, 900), troubleSince(100, false, 900)],
    [100, 100, null],
  );
  const dated = (phase: string, downSince: number | null) =>
    ({ machines: [] as never[], open: { machine: "studio" as never, stream: { phase, lastAppliedSeq: 0, instanceId: null, error: null, downSince } as never } });
  const downAt = { ...down("no_route"), downSince: new Map([["studio" as never, 70_000]]) };
  check(
    "each cause is dated from its own start: the server's spell, a machine first found down, a stream no longer live",
    [
      connectionSpell(serverDown(NOW - 300), all, NOW)?.since,
      connectionSpell(serverDown(NOW - SERVER_NAMED_AFTER_MS), all, NOW)?.since,
      connectionSpell({ ...healthy, server: { state: "refusing", since: 40 } }, all, NOW)?.since,
      connectionSpell(downAt, tab, NOW)?.since,
      connectionSpell({ ...downAt, doubted: new Set(["studio" as never]) }, tab, NOW)?.since,
      connectionSpell(healthy, dated("waiting", 90_000), NOW)?.since,
      connectionSpell({ ...healthy, device: "offline" }, dated("waiting", 90_000), NOW)?.since,
    ],
    [NOW - 300, NOW - SERVER_NAMED_AFTER_MS, 40, 70_000, 70_000, 90_000, 90_000],
  );
  check(
    "and what nothing dated is counted from when this screen first saw it: a first listing, a first probe, a caller that keeps no dates",
    [
      connectionSpell({ ...healthy, server: { state: "unknown", since: null } }, all, NOW)?.since,
      connectionSpell({ ...healthy, machines: [machine("studio", { reach: "probing", route: null })] }, all, NOW)?.since,
      connectionSpell(down("no_route"), tab, NOW)?.since,
      connectionSpell(healthy, all, NOW),
    ],
    [null, null, null, null],
  );
  check(
    "a positive word waits the grace, the device's own or a server's error; anything inferred from a failure waits out the quiet window",
    [
      troubleWait({ kind: "network" }),
      troubleWait({ kind: "server", why: "refusing" }),
      troubleWait({ kind: "server", why: "unreachable" }),
      troubleWait({ kind: "connecting", e2ee: true }),
      troubleWait({ kind: "unreachable", names: ["studio"] }),
    ],
    [TROUBLE_GRACE_MS, TROUBLE_GRACE_MS, RECONNECT_QUIET_MS, RECONNECT_QUIET_MS, RECONNECT_QUIET_MS],
  );
  const reconnect = { kind: "connecting" as const, e2ee: false };
  check(
    "it is due a quiet window after the cause began, and a cause older than this screen's sight of it has already spent its wait",
    [
      troubleDue({ trouble: reconnect, since: null }, 2_000),
      troubleDue({ trouble: reconnect, since: 2_400 }, 2_000),
      troubleDue({ trouble: reconnect, since: 500 }, 2_000),
      troubleDue({ trouble: { kind: "network" }, since: 1_500 }, 2_000),
    ],
    [2_000 + RECONNECT_QUIET_MS, 2_000 + RECONNECT_QUIET_MS, 500 + RECONNECT_QUIET_MS, 1_500 + TROUBLE_GRACE_MS],
  );
  // The body beside the pill reports that it speaks one commit late, and a hold that has just run out hands the pill a
  // cause already past its wait: drawn at first sight, the pill would come up and be silenced a frame later.
  check(
    "no spell is drawn on the render that first sees it, however old its cause",
    [troubleDue({ trouble: reconnect, since: 0 }, 50_000), troubleDue({ trouble: { kind: "network" }, since: 0 }, 50_000), TROUBLE_SIGHT_MS],
    [50_000 + TROUBLE_SIGHT_MS, 50_000 + TROUBLE_SIGHT_MS, 100],
  );
  check(
    "so a reconnect shorter than the window never draws the pill",
    [troubleLive(null, false, 9_000), troubleLive(7_000, false, 6_999), troubleLive(7_000, false, 7_000)],
    [false, false, true],
  );
  // The device says offline and back while a machine is down: the positive word is due at one second, the inference
  // that follows it at five. Taken back in between, the pill came down and up again inside one spell.
  check(
    "a spell once drawn stays drawn until it ends: a change of cause to one not yet due takes nothing back",
    [troubleLive(9_000, true, 7_000), troubleLive(null, true, 7_000), troubleLive(9_000, false, 7_000)],
    [true, false, false],
  );
  check(
    "and once up the pill stays its minimum whatever became of the trouble, so a spell that ends a moment later is not a flash",
    [
      troubleShown(true, null, 7_000),
      troubleShown(false, 7_000, 7_001),
      troubleShown(false, 7_000, 7_000 + TROUBLE_MIN_SHOWN_MS - 1),
      troubleShown(false, 7_000, 7_000 + TROUBLE_MIN_SHOWN_MS),
      troubleShown(false, null, 7_001),
    ],
    [true, true, true, false, false],
  );
  // A probe that passes is no proof a listing will: such a machine is never drawn as down, and without this nothing says its list has stopped.
  const failing = (since: number, patch: object = {}) => ({ ...healthy, machines: [machine("studio", patch), machine("laptop")], listFailingSince: new Map([["studio" as never, since]]) });
  check(
    "a machine drawn as up whose sessions cannot be read is a reconnect, dated from the first listing that failed",
    [
      connectionSpell(failing(60_000), all, NOW),
      connectionSpell(failing(60_000), tab, NOW),
      connectionSpell(failing(60_000), { machines: ["laptop" as never], open: null }, NOW),
      // Down, it is the machine's own trouble, which outranks this and is dated by its own start.
      connectionSpell({ ...failing(60_000, { reach: "offline", offlineReason: "no_route", route: null }), downSince: new Map([["studio" as never, 80_000]]) }, tab, NOW),
    ],
    [
      { trouble: { kind: "connecting", e2ee: false }, since: 60_000 },
      { trouble: { kind: "connecting", e2ee: false }, since: 60_000 },
      null,
      { trouble: { kind: "unreachable", names: ["studio"] }, since: 80_000 },
    ],
  );

  const pill = stripComments(srcFile("ui/ConnectionPill.tsx"));
  check(
    "a pointer opens it on hover, a finger with a tap, a keyboard on focus",
    [
      /pointer-fine:group-hover:grid-cols-\[1fr\]/.test(pill),
      // What is open is the stylesheet's answer, so the tap reads it back rather than keeping a second copy.
      /onClick=\{\(\) => setChoice\(\(wordsBox\.current\?\.offsetWidth \?\? 0\) > 0 \? "folded" : "open"\)\}/.test(pill),
      /group-focus-visible:grid-cols-\[1fr\]/.test(pill),
      /aria-expanded=\{choice === null \? undefined : choice === "open"\}/.test(pill),
    ],
    [true, true, true, true],
  );
  // F12: a finger has no hover, so the words a reader acts on were behind a tap nobody knew to make.
  const arms = /const cols =([\s\S]*?);\n/.exec(pill)?.[1] ?? "";
  report("the three arms of the fold were found", arms.length > 0, arms.replace(/\s+/g, " ").trim());
  check(
    "under a finger it opens by itself, for every cause but a reconnect, and only until the reader folds it",
    [
      /: "grid-cols-\[0fr\] \[@media\(pointer:coarse\)\]:grid-cols-\[1fr\]"$/.test(arms.trim()),
      /choice === "folded" \|\| drawn === null \|\| !opensByItself\(drawn\)\s*\? "grid-cols-\[0fr\]"/.test(arms),
      (pill.match(/\[@media\(pointer:coarse\)\]:grid-cols-\[1fr\]/g) ?? []).length,
      /matchMedia/.test(pill),
    ],
    [true, true, 1, false],
  );
  check(
    "a long host is cut with an ellipsis and never by the window's edge",
    [
      /pointer-events-none absolute z-10 \$\{placement\} right-3 flex/.test(pill),
      /relative flex h-9 max-w-full min-w-0 items-center/.test(pill),
      /<span className="truncate">\{words\}<\/span>/.test(pill),
      /whitespace-nowrap/.test(pill),
    ],
    [true, true, true, false],
  );
  check("and the server is named as the drawer names it", /troubleWords\(drawn, serverLabel\(controlPlaneOrigin\(\)\)\)/.test(pill), true);
  check(
    "the live region is mounted for good and says the words only while shown",
    /<p role="status" aria-live="polite" className="sr-only">\s*\{shown \? words : ""\}\s*<\/p>\s*\{mounted && /.test(pill),
    true,
  );
  check("it floats and displaces nothing", /pointer-events-none absolute z-10 \$\{placement\}/.test(pill), true);
  check(
    "the pill reads one monotonic clock, keeps the words it drew only for a spell that is due, and sets its timer again after one that fired early",
    [
      /const at = monotonicNow\(\);/.test(pill),
      /Date\.now\(\)/.test(pill),
      /const due = spell === null \|\| seen\.current === null \? null : troubleDue\(spell, seen\.current\);/.test(pill),
      /const shown = !silent && troubleShown\(live, shownAt\.current, at\);/.test(pill),
      /const live = troubleLive\(due, drawing\.current, at\);\s*drawing\.current = live;/.test(pill),
      /if \(live && trouble !== null\) said\.current = trouble;/.test(pill),
      /\}, \[next, turn\]\);/.test(pill),
    ],
    [true, false, true, true, true, true, true],
  );
  check("the shield is drawn only for a relay stream", /drawn\.kind === "connecting" && drawn\.e2ee && <Icon as=\{Shield\}/.test(pill), true);
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const riseOut = Number(/--animate-rise-out: rise-out (\d+)ms/.exec(css)?.[1] ?? "NaN");
  const exitMs = Number(/export const PILL_EXIT_MS = (\d+);/.exec(pill)?.[1] ?? "NaN");
  check("it arrives and leaves on the rise tokens, and the backstop is the exit's own length", [/animate-rise-out/.test(pill), exitMs], [true, riseOut]);

  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  const window = browser.slice(browser.indexOf("<BesidePane"), browser.indexOf("<SidebarFoot"));
  check(
    "on the list it sits in the pager's window, so it is over the rows and above New session",
    [/<ConnectionPill[\s\S]*placement="bottom-3 left-3"/.test(window), /openKey=\{activeKey\}/.test(window)],
    [true, true],
  );
  check(
    "and it says nothing where the list's own body names what is unreachable: one place says it",
    [/<ConnectionPill[\s\S]*silent=\{speaks\}/.test(window), /const spell = silent\s*\? null\s*: connectionSpell\(/.test(pill)],
    [true, true],
  );
  const view = stripComments(srcFile("ui/SessionView.tsx"));
  check(
    "in a conversation it is the phone's alone, and lifted over a parked card",
    [
      /<div className="contents lg:hidden">\s*<ConnectionPill/.test(view),
      /machines=\{\[sessionRef\.machineId\]\}/.test(view),
      /bottom: askHeight \+ PILL_OVER_CARD_PX/.test(view),
    ],
    [true, true, true],
  );

  const client = srcFiles().map((rel) => [rel, stripComments(srcFile(rel))] as const);
  check(
    "and the banners it replaced are gone by name",
    client
      .filter(([rel, body]) => /ControlPlaneNotice|"Server unreachable|reconnecting\{stream/.test(body) || (rel === "ui/SessionView.tsx" && /const reconnecting =/.test(body)))
      .map(([rel]) => rel),
    [],
  );
}
