import type { MachineId } from "../src/ids.js";
import { check, report } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";

const { boardAgentHome, boardAgentOf, drawnInNoList, supersededAgents } = await import("../src/boardAgent.js");

// The board's config agent: one per account, found by asking every machine; Edit board is its conversation (Q2.270, Q3.743).
process.stdout.write("\nthe config agent: found on every machine, the newest kept, Edit board its conversation\n");
{
  const M = (id: string): MachineId => id as MachineId;
  const agent = (id: string, createdAt: number, purpose: string | null = "board") => ({ id, createdAt, purpose }) as never;
  check(
    "only the two purposes this build knows hide a session",
    [drawnInNoList({ purpose: "board" }), drawnInNoList({ purpose: "board_retired" }), drawnInNoList({ purpose: null }), drawnInNoList({}), drawnInNoList({ purpose: "x" as never })],
    [true, true, false, false, false],
  );
  const copies = [
    { machineId: M("m_old"), kind: "known" as const, session: agent("s_old", 10) },
    { machineId: M("m_new"), kind: "known" as const, session: agent("s_new", 20) },
    { machineId: M("m_none"), kind: "known" as const, session: null },
    { machineId: M("m_gone"), kind: "absent" as const },
    { machineId: M("m_late"), kind: "known" as const, session: agent("s_late", 99, "board_retired") },
  ];
  const found = boardAgentOf(copies);
  check("the newest config agent any machine answered with is the one, and a retired one never is", [found?.machineId, found?.session.id], ["m_new", "s_new"]);
  check("an older one on another machine is what gets retired once it answers", supersededAgents(copies, found), ["m_old"]);
  check("with none found nothing is retired", supersededAgents(copies.slice(2), boardAgentOf(copies.slice(2))), []);
  check(
    "a new one starts on this computer's machine, else the first that answered, else nowhere",
    [boardAgentHome(M("m_b"), [M("m_a"), M("m_b")]), boardAgentHome(M("m_x"), [M("m_a"), M("m_b")]), boardAgentHome(null, [])],
    ["m_b", "m_a", null],
  );

  const watch = stripComments(srcFile("ui/board/BoardAgent.tsx"));
  const chat = stripComments(srcFile("ui/board/BoardChat.tsx"));
  report("the config agent's screen was found", chat.length > 4000, `${chat.length} chars`);
  check(
    "it asks every machine running the board, and Edit board draws the conversation it found under its own header",
    [
      /daemon\.boardAgent\(\)/.test(watch),
      /<SessionView\s+state=\{state\}\s+sessionRef=\{ref\}\s+chrome=\{\{ title: TITLE, subtitle: agentLine\(found\)/.test(chat),
      /store\.applySnapshot\(ref, found\.session\)/.test(chat),
    ],
    [true, true, true],
  );
  check(
    "nothing is sent until every machine asked has answered once, nor while the agent's machine is away: a send then would start a second one",
    [/settled: answered === key/.test(watch), /disabled=\{finding \|\| away !== null \|\| home === null\}/.test(chat), /const finding = !readOnly && \(!settled \|\| found !== null\);/.test(chat)],
    [true, true, true],
  );
  check(
    "the first message starts it and then goes as any message does, and a send refused after the start is handed to the conversation's box",
    [/startConfigAgent\(chosen, false, null\)/.test(chat), /daemon\.prompt\(ref\.sessionId, body\)/.test(chat), /holdDraft\(keyOf\(ref\), body\);/.test(chat)],
    [true, true, true],
  );
  check(
    "starting over is a screen of its own that names what ends and confirms with the danger tone; picking an agent arms nothing",
    [
      /startConfigAgent\(chosen, true, found\)/.test(chat),
      /This conversation ends/.test(chat),
      /<DangerButton icon=\{RotateCcw\}/.test(chat),
      /<TwoStep|setArmed/.test(chat),
    ],
    [true, true, true, false],
  );
  const view = stripComments(srcFile("ui/SessionView.tsx"));
  check(
    "opened by its own address, its conversation leads back to Edit board, at every width",
    [/board=\{board \|\| drawnInNoList\(session\)\}/.test(view), /back=\{drawnInNoList\(session\) \? \{ to: boardConfigPath\(\), label: "Back to Edit board" \} : null\}/.test(view)],
    [true, true],
  );
  const card = stripComments(srcFile("ui/board/BoardChange.tsx"));
  check(
    "under Edit board's header, Background tasks stays closed while the YAML is docked where it docks",
    [/if \(docked\) setTasksOpen\(false\);/.test(view), /tasksOpen \|\| docked \? TASK_PANEL_GUTTER/.test(view)],
    [true, true],
  );
  check(
    "the board card writes as Save does, only over the board it was written against, and leads nowhere",
    [/writeEverywhere\(plan, write\)/.test(card), /const current = account\.hash === event\.hash;/.test(card), /from "\.\.\/\.\.\/router"/.test(card)],
    [true, true, false],
  );
}
