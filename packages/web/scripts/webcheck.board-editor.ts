import { boardHash } from "@reemoat/board";
import type { MachineId } from "../src/ids.js";
import { check, report } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";

const saving = await import("../src/boardSave.js");
const { ApiError } = await import("../src/http.js");

// The board's own screen is its YAML and nothing else (Q3.742): pasted or typed, refused by line, saved to every machine.
process.stdout.write("\nthe board's screen: the YAML, refused by line, saved to every machine that runs the board\n");
{
  const M = (id: string): MachineId => id as MachineId;
  check(
    "a refusal's line and column put the caret there",
    [saving.offsetOf("ab\ncdef\ng", 2, 3), saving.offsetOf("ab\ncdef\ng", 9, 1), saving.offsetOf("ab\ncdef\ng", 1, 40)],
    [5, 9, 2],
  );
  process.stdout.write("  saving to every machine that runs the board\n");
  const machine = (id: string, patch: Partial<{ reach: "online" | "offline"; writable: boolean; read: boolean }> = {}) => ({
    id: M(id),
    name: id,
    reach: "online" as const,
    writable: true,
    read: true,
    ...patch,
  });
  const plan = saving.savePlan(
    [machine("m_a"), machine("m_b", { reach: "offline" }), machine("m_c", { writable: false }), machine("m_d"), machine("m_e", { read: false }), machine("m_f")],
    new Map([
      [M("m_a"), { revision: 3 }],
      [M("m_b"), { revision: 3 }],
      [M("m_c"), { revision: 2 }],
      [M("m_f"), { revision: 1 }],
    ]),
  );
  check(
    "each reachable machine that runs the board is written against its own revision; every other is named with why it was not",
    [plan.targets.map((one) => `${one.id}@${one.revision}`), plan.skipped.map((one) => `${one.id}:${one.why}`)],
    [["m_a@3", "m_f@1"], ["m_b:unreachable", "m_c:read_only", "m_d:older", "m_e:unread"]],
  );
  const theirs = "version: 1\ncolumns:\n  - { id: a, title: A }\n";
  const outcomes = [
    saving.saveOutcome({ ok: true, written: { version: 1, revision: 4, hash: boardHash(theirs), text: theirs, changed: true } }),
    saving.saveOutcome({ ok: true, written: { version: 1, revision: 3, hash: boardHash(theirs), text: theirs, changed: false } }),
    saving.saveOutcome({ ok: false, cause: new ApiError(409, "board_revision", "the board is at revision 5 now", { revision: 5, hash: boardHash(theirs), text: theirs }) }),
    saving.saveOutcome({
      ok: false,
      cause: new ApiError(400, "board_invalid", "3:5 columns[0].id: x", { errors: [{ line: 3, col: 5, path: "columns[0].id", message: "x", text: "3:5 columns[0].id: x" }] }),
    }),
    saving.saveOutcome({ ok: false, cause: new ApiError(503, "no_tunnel", "that machine is not connected", null) }),
    saving.saveOutcome({ ok: false, cause: new ApiError(409, "board_revision", "a conflict that says nothing", null) }),
  ];
  check(
    "each answer is one outcome: saved, already held, a conflict carrying the board that machine holds now, a refusal by line, a failure",
    outcomes.map((one) => one.kind),
    ["saved", "saved", "conflict", "refused", "failed", "failed"],
  );
  check(
    "and each is said in words, a conflict and a refusal as what went wrong",
    [...outcomes.map(saving.outcomeSentence), saving.outcomeSentence({ kind: "skipped", why: "older" })],
    [
      "saved, revision 4",
      "already held this board",
      "changed meanwhile, now at revision 5; nothing was written",
      "refused it for one reason",
      "that machine is not connected",
      "a conflict that says nothing",
      "runs no configurable board, so not written",
    ],
  );
  const conflict = outcomes[2]!;
  check("a conflict hands over that machine's text, to load or write over", conflict.kind === "conflict" ? [conflict.revision, conflict.text] : null, [5, theirs]);
  const refused = outcomes[3]!;
  check("a refusal hands over every line it named", refused.kind === "refused" ? refused.errors.map((one) => `${one.line}:${one.col} ${one.path}`) : null, ["3:5 columns[0].id"]);

  process.stdout.write("  the screen\n");
  const screen = stripComments(srcFile("ui/board/BoardEditor.tsx"));
  report("the board screen was found", screen.length > 2000, `${screen.length} chars`);
  check(
    "it is the text alone: no form, no second view, and nothing here edits YAML as a document",
    [/BoardForm|aria-label="Edit as"|setView\(/.test(screen), /from "yaml"|parseDocument\(|new Document\(/.test(screen), /from "\.\.\/\.\.\/boardSave"/.test(screen)],
    [false, false, true],
  );
  check(
    "a save writes each machine against its own revision and draws the board that machine took before its next read",
    [
      /daemon\.putBoard\(text, target\.revision\)/.test(screen),
      /boardStore\.applyBoard\(target\.id, \{ revision: written\.revision, hash: written\.hash, text: written\.text, board: read\.board \}\);/.test(screen),
      /plan\.targets\.map\(\(target\) => writeOne\(target, text\)\)/.test(screen),
    ],
    [true, true, true],
  );
  check(
    "a draft the account's board moved under is kept and the screen says so; an untouched one follows it",
    [/if \(draft !== base\) return;\s*setBase\(account\.text\);\s*setDraft\(account\.text\);/.test(screen), /The board changed since you started editing\./.test(screen)],
    [true, true],
  );
  check(
    "with no machine running the board the editor says so in one line and writes nothing",
    [/const readOnly = snap\.configured\.size === 0;/.test(screen), /No machine runs the configurable board yet\./.test(screen), /readOnly=\{readOnly\}/.test(screen)],
    [true, true, true],
  );
  check(
    "the text is mono, takes no rewritten keystroke, and every refusal is listed by line and puts the caret there",
    [/<textarea\s+\{\.\.\.VERBATIM_FIELD\}/.test(screen), /font-mono text-xs/.test(screen), /formatBoardError\(error\)/.test(screen), /onClick=\{\(\) => goTo\(error\)\}/.test(screen)],
    [true, true, true, true],
  );
  check("nothing opens over the screen: no sheet, no dialog, no menu of its own", /<Sheet|role="dialog"|createPortal/.test(screen), false);
}
