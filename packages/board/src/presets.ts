// The board a machine runs before anybody writes one, and the review loop every driver is checked against.
import { parseBoard, type Board } from "./config.js";

/** Today's four columns, written out: what a daemon with no stored board runs, at revision 0. */
export const DEFAULT_BOARD_TEXT = `version: 1
columns:
  - { id: backlog, title: Backlog }
  - id: running
    title: Running
    run: {}            # the task's own agent; the run ends on its report
    next: review
  - { id: review, title: Review, holder: you }
  - { id: done, title: Done, final: true }
`;

/** The reference: build, review in a fresh conversation on another machine, fix or ship, then a person approves. */
export const REVIEW_LOOP_TEXT = `version: 1
budget: 8
roles:
  coder:    { agent: claude }
  reviewer: { agent: claude, on: server }   # the reviewer is pinned to the server
  cheap:    { agent: claude, model: haiku }
columns:
  - { id: chats, title: Chats, show: sessions }
  - { id: backlog, title: Backlog }
  - id: build
    title: Build
    limit: 3
    run: { role: coder }                      # ends on the coder's report
    next: review
  - id: review
    title: Review
    run: { role: reviewer, conversation: new, skill: review, done_when: turn }
    next:
      fix:  { to: build,   means: "the review found problems that need code" }
      ship: { to: approve, means: "nothing blocking is left" }
    decide: [self, cheap, human]
    sees: [report, last_message, diff_stat]
  - id: approve
    title: Approve
    holder: you
    next:
      merge:   { to: done,  label: Merge }
      changes: { to: build, label: Request changes }
  - { id: done, title: Done, final: true }
`;

/** The same loop on one machine: the drivers' fixture where every role runs here. */
export const REVIEW_LOOP_LOCAL_TEXT = REVIEW_LOOP_TEXT.replace("reviewer: { agent: claude, on: server }   # the reviewer is pinned to the server", "reviewer: { agent: claude }");

function parsed(text: string): Board {
  const result = parseBoard(text);
  if (!result.ok) throw new Error(`a preset does not parse: ${JSON.stringify(result.errors)}`);
  return result.board;
}

export const DEFAULT_BOARD: Board = parsed(DEFAULT_BOARD_TEXT);
