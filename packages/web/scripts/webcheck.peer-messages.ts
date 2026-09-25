import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";
import { buildTail, foldRuns } from "./webcheck.modules.js";
import { drawn } from "./webcheck.rows.js";

const { peerBody, peerHeadline } = await import("../src/peer.js");

process.stdout.write("\na message from another agent is drawn as one, never as the person's own\n");
{
  const task =
    '<peer-message from="reviewer [s_1a2b3c4d]" harness="codex" id="pm_1">\n' +
    "check the login form\nand the signup one\n</peer-message>\nFrom another agent through Reemoat, not from your user.";
  check("the body comes out of the envelope, without the footer", peerBody(task), "check the login form\nand the signup one");
  check(
    "a defused closing tag inside it is part of the body, not its end",
    peerBody('<peer-message from="a [s_1]" id="pm_2">\nsee <\\/peer-message> here\n</peer-message>\nfooter'),
    "see <\\/peer-message> here",
  );
  check(
    "a notice is its one sentence",
    peerBody('<peer-notice from="a [s_1]" id="pn_1">a finished what it was doing and went idle without writing back to you.</peer-notice>'),
    "a finished what it was doing and went idle without writing back to you.",
  );
  check("text that is not an envelope comes through whole", peerBody("just words"), "just words");

  const origin = { name: "reviewer", ref: "s_1", machineId: null, machineLabel: null, harness: "codex", messageId: "pm_1", hops: 1 };
  check("a message says so", peerHeadline({ ...origin, kind: "message" }), "Message from reviewer");
  check("a notice is only who it is about", peerHeadline({ ...origin, kind: "notice" }), "From reviewer");
  check("another machine is named", peerHeadline({ ...origin, kind: "message", machineLabel: "studio" }), "Message from reviewer on studio");
  check(
    "a kind from a newer daemon, or a note an older build logged, claims no more than a message does",
    ["invented", "context", "task"].map((kind) => peerHeadline({ ...origin, kind: kind as never })),
    ["Message from reviewer", "Message from reviewer", "Message from reviewer"],
  );

  // wire.ts hand-mirrors src/events.ts; a field the daemon adds and the client lacks would be dropped silently.
  const fieldsOf = (source: string, name: string): string[] => {
    const code = stripComments(source);
    const at = code.indexOf(`export interface ${name} {`);
    const body = at < 0 ? "" : code.slice(at, code.indexOf("\n}", at));
    return [...body.matchAll(/^\s+([a-zA-Z]+)\??:/gm)].map((m) => m[1] ?? "").sort();
  };
  const daemon = readFileSync(new URL("../../../src/events.ts", import.meta.url), "utf8");
  const wire = srcFile("wire.ts");
  check("PeerOrigin has the daemon's fields, all of them", fieldsOf(wire, "PeerOrigin"), fieldsOf(daemon, "PeerOrigin"));
  check("and PromptEvent carries from on both sides", [fieldsOf(daemon, "PromptEvent").includes("from"), fieldsOf(wire, "PromptEvent").includes("from")], [true, true]);

  const row = stripComments(srcFile("ui/EventList.tsx"));
  const promptRow = row.slice(row.indexOf("function PromptRow("), row.indexOf("function TextRun("));
  check(
    "the prompt row tests from before it reaches the person's bubble",
    promptRow.indexOf("event.from != null") >= 0 && promptRow.indexOf("event.from != null") < promptRow.indexOf("<UserBubble"),
    true,
  );
  const peerRow = stripComments(srcFile("ui/PeerMessage.tsx"));
  check("and the peer row never draws one", peerRow.includes("UserBubble"), false);
  check("nor says a message waits for a turn: every one starts or joins one (Q2.243)", peerRow.includes("next turn"), false);
  // Markdown holds a changed text back for its stream throttle, so a swapped text lands after the label that swapped it.
  check("show all and show less mount their own Markdown rather than changing its text", /<Markdown\s+key=\{open\b/.test(peerRow), true);

  let seq = 0;
  const ev = (event: Record<string, unknown>): never => ({ seq: (seq += 1), ts: seq * 1000, event }) as never;
  const text = (body: string): never => ev({ type: "text", role: "agent", thought: false, text: body, messageId: null });
  const events = [
    text("working on it"),
    ev({ type: "prompt", text: task, attachments: null, from: { ...origin, kind: "message" } }),
    text("on it"),
  ];
  const rows = foldRuns(buildTail(events, []).rows);
  check("it is a row of its own, never folded into the agent's run", drawn(rows).includes("e2"), true);
}
