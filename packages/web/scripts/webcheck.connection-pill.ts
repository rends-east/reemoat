import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

process.stdout.write("\nconnection trouble is one pill at the bottom-left, never a banner\n");
{
  const { connectionTrouble, TROUBLE_GRACE_MS, troubleShown, troubleSince, troubleWords } = await import("../src/ui/connection.js");
  const machine = (id: string, patch: object = {}) =>
    ({ id, name: id, reach: "online", offlineReason: null, route: { base: "https://r", kind: "relay" }, ...patch }) as never;
  const healthy = { cpError: null, machines: [machine("studio"), machine("laptop")] };
  const all = { machines: "all" as const, open: null };

  check("a healthy fleet says nothing", connectionTrouble(healthy, all), null);
  check("an unreachable server is connecting, and not end-to-end", connectionTrouble({ ...healthy, cpError: "timeout" }, all), {
    kind: "connecting",
    e2ee: false,
  });
  const down = (reason: string | null) => ({ ...healthy, machines: [machine("studio", { reach: "offline", offlineReason: reason, route: null })] });
  const tab = { machines: ["studio" as never], open: null };
  check(
    "under All a machine that is off is not trouble: it would hold the pill for as long as it stays off",
    [connectionTrouble(down("no_route"), all), connectionTrouble(down("cp_unreachable"), all), connectionTrouble(down(null), all)],
    [null, null, null],
  );
  check(
    "a machine the wire cannot reach is named on its own tab",
    [connectionTrouble(down("no_route"), tab), connectionTrouble(down("cp_unreachable"), tab), connectionTrouble(down(null), tab)],
    [
      { kind: "unreachable", names: ["studio"] },
      { kind: "unreachable", names: ["studio"] },
      { kind: "unreachable", names: ["studio"] },
    ],
  );
  check(
    "a refusal somebody must act on is not connection trouble, and stays where it is drawn",
    ["over_limit", "owner_disabled", "not_enrolled", "no_token", "no_machine_key", "no_device_key"].map((reason) =>
      connectionTrouble(down(reason), tab),
    ),
    [null, null, null, null, null, null],
  );
  check("a machine this screen does not read is not its trouble", connectionTrouble(down("no_route"), { machines: ["laptop" as never], open: null }), null);
  check(
    "the open conversation's machine is read whatever the list shows",
    connectionTrouble(down("no_route"), { machines: [], open: { machine: "studio" as never, stream: null } }),
    { kind: "unreachable", names: ["studio"] },
  );
  const stream = (phase: string) => ({ phase, lastAppliedSeq: 0, instanceId: null, error: null }) as never;
  const opened = (phase: string) => ({ machines: [] as never[], open: { machine: "studio" as never, stream: stream(phase) } });
  check(
    "a stream reattaching is connecting, end-to-end only down the relay",
    [
      connectionTrouble(healthy, opened("waiting")),
      connectionTrouble(healthy, opened("connecting")),
      connectionTrouble({ ...healthy, machines: [machine("studio", { route: { base: "http://127.0.0.1", kind: "local" } })] }, opened("waiting")),
    ],
    [
      { kind: "connecting", e2ee: true },
      { kind: "connecting", e2ee: true },
      { kind: "connecting", e2ee: false },
    ],
  );
  check("a live, idle or closed stream is not trouble", ["live", "idle", "closed"].map((phase) => connectionTrouble(healthy, opened(phase))), [null, null, null]);
  check(
    "a first probe is connecting",
    connectionTrouble({ ...healthy, machines: [machine("studio", { reach: "probing", route: null })] }, all),
    { kind: "connecting", e2ee: false },
  );
  check(
    "the server outranks a machine, and a machine outranks its own stream",
    [
      connectionTrouble({ ...down("no_route"), cpError: "timeout" }, tab),
      connectionTrouble(down("no_route"), opened("waiting")),
    ],
    [
      { kind: "connecting", e2ee: false },
      { kind: "unreachable", names: ["studio"] },
    ],
  );
  check(
    "the words",
    [
      troubleWords({ kind: "connecting", e2ee: true }),
      troubleWords({ kind: "unreachable", names: ["studio"] }),
      troubleWords({ kind: "unreachable", names: ["studio", "laptop"] }),
    ],
    ["Connecting…", "studio is unreachable", "2 machines are unreachable"],
  );

  check("the grace", TROUBLE_GRACE_MS, 1_000);
  check(
    "a spell begins once, survives a change of kind, and ends with the trouble",
    [troubleSince(null, true, 100), troubleSince(100, true, 900), troubleSince(100, false, 900)],
    [100, 100, null],
  );
  check(
    "so a sub-second reconnect never draws the pill",
    [troubleShown(null, 5_000), troubleShown(100, 1_099), troubleShown(100, 1_100)],
    [false, false, true],
  );

  const pill = stripComments(srcFile("ui/ConnectionPill.tsx"));
  check(
    "a pointer opens it on hover, a finger with a tap, a keyboard on focus",
    [
      /pointer-fine:group-hover:grid-cols-\[1fr\]/.test(pill),
      /onClick=\{\(\) => setExpanded\(!expanded\)\}/.test(pill),
      /group-focus-visible:grid-cols-\[1fr\]/.test(pill),
      /aria-expanded=\{expanded\}/.test(pill),
    ],
    [true, true, true, true],
  );
  check(
    "the live region is mounted for good and says the words only while shown",
    /<p role="status" aria-live="polite" className="sr-only">\s*\{shown \? words : ""\}\s*<\/p>\s*\{mounted && /.test(pill),
    true,
  );
  check("it floats and displaces nothing", /pointer-events-none absolute z-10 \$\{placement\}/.test(pill), true);
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
