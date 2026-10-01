import { check, report } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";

// Q2.244 names the three switches, Q3.675 how each is drawn: every one of them shows what the server last said.

const words = (text: string): number => text.split(/\s+/).filter((one) => one.length > 0).length;
const between = (text: string, start: string, end: string): string => {
  const at = text.indexOf(start);
  return at < 0 ? "" : text.slice(at, text.indexOf(end, at + start.length));
};

process.stdout.write("\nthe account's switch, at the head of Machines\n");
{
  const React = await import("react");
  // tsx compiles these with the classic JSX runtime (the root tsconfig names no jsx), so rendering needs a global React.
  (globalThis as Record<string, unknown>)["React"] = React;
  const { createElement: h } = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { SwitchRow } = await import("../src/ui/bits.js");
  const { AccountMessaging } = await import("../src/ui/settings/AccountMessaging.js");
  const { parseSettingsRoute, parseSettingsSection } = await import("../src/settings.js");

  // Permissions was one switch; it heads the list of the machines it governs, and its old address falls to the index.
  check("it has no section of its own any more", [parseSettingsSection("permissions"), parseSettingsRoute(["permissions"]).section], [null, null]);
  check("and it is drawn by Machines", /<AccountMessaging me=\{state\.me\} \/>/.test(stripComments(srcFile("ui/settings/MachinesSection.tsx"))), true);

  const me = (over: Record<string, unknown> = {}) => ({ id: "u_1", name: "ada", isAdmin: false, ...over }) as never;
  const on = renderToStaticMarkup(h(AccountMessaging, { me: me({ permissions: { agentMessaging: true } }) }));
  const off = renderToStaticMarkup(h(AccountMessaging, { me: me({ permissions: { agentMessaging: false } }) }));
  check(
    "one switch, announced with the account's own answer",
    [(on.match(/role="switch"/g) ?? []).length, /aria-checked="true"/.test(on), /aria-checked="false"/.test(off)],
    [1, true, true],
  );
  check("named for what it switches", [on.includes("Agent messaging"), on.includes("Agents in your sessions can message each other.")], [true, true]);
  // No switch may claim a state the server cannot hold, and no line explains why it is missing (Q3.675, the owner's 2026-09-26 rule).
  check(
    "a control plane that cannot store it draws nothing at all, and neither does an account nobody could read",
    [renderToStaticMarkup(h(AccountMessaging, { me: me() })), renderToStaticMarkup(h(AccountMessaging, { me: null }))],
    ["", ""],
  );

  const row = (over: Partial<Parameters<typeof SwitchRow>[0]> = {}): string =>
    renderToStaticMarkup(h(SwitchRow, { title: "Agent messaging", on: true, onToggle: () => {}, ...over }));
  const waiting = row({ busy: true });
  check(
    "a switch whose write is out stays where the server left it, says it is busy and cannot be pressed again",
    [/aria-checked="true"/.test(waiting), /aria-busy="true"/.test(waiting), /disabled=""/.test(waiting)],
    [true, true, true],
  );
  check("at rest it claims no wait and can be pressed", [/aria-busy/.test(row()), /disabled=""/.test(row())], [false, false]);
  check("a refused one cannot be pressed either", /disabled=""/.test(row({ disabled: true })), true);

  const bits = stripComments(srcFile("ui/bits.tsx"));
  const fn = between(bits, "export function SwitchRow(", "\n}\n");
  report("the switch row was found", fn.length > 300, `${fn.length} chars`);
  check("the press only asks: the row holds no state of its own to flip", [/useState/.test(fn), /onClick=\{onToggle\}/.test(fn)], [false, true]);

  const section = stripComments(srcFile("ui/settings/AccountMessaging.tsx"));
  check(
    "the switch draws the account's answer and sends its opposite, holding only the wait and the failure",
    [
      /on=\{held\.agentMessaging\}/.test(section),
      /saveAccountMessaging\(!held\.agentMessaging\)/.test(section),
      (section.match(/useState[<(]/g) ?? []).length,
    ],
    [true, true, 2],
  );
  check("and says a failure under its group, never as a toast", [/toast\(/.test(section), /<Group title="All machines" error=\{error\}>/.test(section)], [false, true]);

  const store = stripComments(srcFile("store.ts"));
  const account = between(store, "async saveAccountMessaging(", "\n  }\n");
  const machine = between(store, "async saveMachinePermissions(", "\n  }\n");
  check(
    "the store takes the flag from the 200 and never from the press",
    [
      account.indexOf("await cp.saveAccountPermissions(on)") >= 0 &&
        account.indexOf("await cp.saveAccountPermissions(on)") < account.indexOf("this.patch("),
      /permissions: \{ agentMessaging: answer\.agentMessaging \}/.test(account),
      machine.indexOf("await cp.saveMachinePermissions(id, patch)") >= 0 &&
        machine.indexOf("await cp.saveMachinePermissions(id, patch)") < machine.indexOf("noteOwnMessaging("),
      /noteOwnMessaging\(answer\)/.test(machine),
    ],
    [true, true, true, true],
  );
  check(
    "and hands every machine the change past its backoff, through the one sync a resume starts",
    [
      /this\.linksForced = true;\s*await this\.machinesChanged\("permissions-changed"\)/.test(store),
      /void this\.links\.syncAll\(scope, this\.linkCandidates\(\), forceLinks\)/.test(store),
    ],
    [true, true],
  );
  check(
    "a resume takes the force as it starts, so one already listing machines cannot spend it on the old list",
    /const epoch = \+\+this\.epoch;\s*const forceLinks = this\.linksForced;\s*this\.linksForced = false;/.test(store),
    true,
  );
}

process.stdout.write("\na machine's own switch\n");
{
  const section = stripComments(srcFile("ui/settings/MachineSection.tsx"));
  const gate = "{owned && machine.enrolled && machine.agentMessagingMachine !== undefined && (";
  check("drawn in one place", (section.match(/<MachineMessaging /g) ?? []).length, 1);
  report(
    "for its owner, once enrolled, and only when the control plane said what it is: absent otherwise, never disabled",
    section.indexOf(gate) >= 0 && section.indexOf("<MachineMessaging ", section.indexOf(gate)) - section.indexOf(gate) < 200,
    `gate at ${String(section.indexOf(gate))}`,
  );
  const gateOpens = section.indexOf("{listable ? (");
  const gateCloses = section.indexOf("\n      )}", gateOpens);
  check("outside the reachability gate, since the switch is the control plane's", section.indexOf(gate) > gateCloses, true);

  const fn = between(section, "function MachineMessaging(", "\n}\n");
  check(
    "it shows the machine's own answer, off and unpressable while the account's is off",
    [
      /const messagingOn = own && !locked;/.test(fn),
      /on=\{messagingOn\}/.test(fn),
      /disabled=\{locked \|\| busy === "isolated"\}/.test(fn),
      /onToggle=\{\(\) => save\("messaging", \{ agentMessaging: !own \}\)\}/.test(fn),
    ],
    [true, true, true, true],
  );
  check(
    "each switch sends only its own field, and the store draws neither before the 200",
    /\.saveMachinePermissions\(machine\.id, patch\)/.test(fn) && !/noteOwnMessaging|useState<boolean>/.test(fn),
    true,
  );
  check("its row says what it switches in under eight words", words("Its agents can message your other sessions.") <= 8 && fn.includes('subline="Its agents can message your other sessions."'), true);
}

process.stdout.write("\nisolating a machine's sessions, under its switch (Q2.244, Q3.675)\n");
{
  const section = stripComments(srcFile("ui/settings/MachineSection.tsx"));
  const fn = between(section, "function MachineMessaging(", "\n}\n");
  const first = fn.indexOf('title="Agent messaging"');
  const second = fn.indexOf('title="Isolate sessions on this machine"');
  check("a second switch, drawn under the first", first > 0 && second > first, true);
  const row = fn.slice(fn.lastIndexOf("{machine.agentMessagingIsolated !== undefined && (", second), fn.indexOf("/>", second));
  check(
    "only when the control plane said what it is: absent from an older one, never guessed",
    row.startsWith("{machine.agentMessagingIsolated !== undefined && ("),
    true,
  );
  check(
    "locked until messaging is on for this machine, and drawn off while locked",
    [/disabled=\{!messagingOn \|\| busy === "messaging"\}/.test(row), /on=\{messagingOn && isolated\}/.test(row)],
    [true, true],
  );
  check(
    "it sends the opposite of the machine's own answer, and waits on the 200 like the first",
    [/onToggle=\{\(\) => save\("isolated", \{ isolated: !isolated \}\)\}/.test(row), /busy=\{busy === "isolated"\}/.test(row)],
    [true, true],
  );
  check(
    "and says what it does inside a row subline's eight words (Q3.544)",
    [row.includes('subline="Its sessions message only each other."'), words("Its sessions message only each other.") <= 8],
    [true, true],
  );
  check("the answer to either press is drawn from the 200 alone", /noteOwnMessaging\(answer: \{ agentMessaging: boolean; isolated: boolean \}\)/.test(stripComments(srcFile("machine.ts"))), true);
}

process.stdout.write("\nthe account's switch says nothing under it (Q3.675)\n");
{
  const React = await import("react");
  const { createElement: h } = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AccountMessaging } = await import("../src/ui/settings/AccountMessaging.js");
  const me = { id: "u_1", name: "ada", isAdmin: false, permissions: { agentMessaging: false } } as never;
  const drawn = renderToStaticMarkup(h(AccountMessaging, { me }));
  check("off, it is a switch drawn off and nothing more", [/role="switch"/.test(drawn), /aria-checked="false"/.test(drawn), (drawn.match(/<p[ >]/g) ?? []).length], [true, true, 0]);
}

process.stdout.write("\nthe settings rails draw the chosen row inset and rounded\n");
{
  const bits = stripComments(srcFile("ui/bits.tsx"));
  const row = between(bits, "export function RailRow(", "\n}\n");
  check(
    "a rounded fill with its own inset, the chosen one raised and the others only hinted at on hover",
    [/rounded-lg/.test(row), /\bpx-3\b/.test(row), /active \? "bg-raised" : "hover:bg-raised\/50"/.test(row), /\bpx-4\b/.test(row)],
    [true, true, true, false],
  );
  const nav = stripComments(srcFile("ui/settings/SettingsNav.tsx"));
  const market = stripComments(srcFile("ui/plugins/MarketNav.tsx"));
  check(
    "and both rails hold it off their edges, with a group heading lined up on the row's text",
    [/<nav aria-label="Settings" className="px-2 py-1">/.test(nav), /className=\{`px-3 pt-4 pb-1 \$\{SETTINGS_HEADING\}`\}/.test(nav), /className="space-y-0\.5 px-2 py-1"/.test(market)],
    [true, true, true],
  );
}

process.stdout.write("\na conversation's own switch, in its menu\n");
{
  const menu = stripComments(srcFile("ui/SessionMenu.tsx"));
  const item = between(menu, "function MenuCheckItem(", "\n}\n");
  check(
    "it is a checkbox item carrying the daemon's answer, never a plain menu item",
    [/role="menuitemcheckbox"/.test(item), /aria-checked=\{checked\}/.test(item)],
    [true, true],
  );
  check(
    "offered only where the daemon can turn it off and this machine allows messaging at all",
    [
      /const machineAllows = state\.machines\.find\(\(one\) => one\.id === sessionRef\.machineId\)\?\.agentMessaging === true;/.test(menu),
      /const peerMessages = machineAllows \? session\?\.peerMessages : undefined;/.test(menu),
      /\{peerMessages !== undefined && \(\s*<MenuCheckItem/.test(menu),
    ],
    [true, true, true],
  );
  check("it sends the opposite of what the daemon said", /setMeta\(\{ peerMessages: !peerMessages \}/.test(menu), true);
  const at = menu.indexOf("<MenuCheckItem");
  check("after Pin, and before a plugin's rows and Stop", at > menu.indexOf('label={pinned ? "Unpin" : "Pin"}') && at < menu.indexOf("offers.map("), true);

  const store = stripComments(srcFile("store.ts"));
  const { mergeOptimistic } = await import("../src/sessionOrder.js");
  const drawn = mergeOptimistic({ pinned: false, peerMessages: true } as never, { pinned: true, peerMessages: false } as never) as {
    pinned: boolean;
    peerMessages: boolean;
  };
  check(
    "and the store draws only a pin or a position early, so the mark follows the snapshot",
    [
      drawn.pinned,
      drawn.peerMessages,
      /metaWrites = new Map<\s*SessionKey,\s*\{ patch: \{ pinned\?: boolean; rank\?: number \| null \};/.test(store),
      /peerMessages\?: boolean/.test(between(store, "  setSessionMeta(", "\n  }\n")),
    ],
    [true, true, true, true],
  );
}
