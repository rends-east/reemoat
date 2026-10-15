import { useState, useSyncExternalStore, type ReactNode } from "react";
import { outcomeSentence } from "../../boardSave";
import { store } from "../../store";
import type { BoardAppliedEvent, BoardProposedEvent, FileChangeEvent } from "../../wire";
import { Button, Spinner } from "../bits";
import { DiffView } from "../DiffView";
import { planFor, writeEverywhere, type WriteResult } from "./boardWrite";
import { useBoard } from "./useBoard";

// No router here: the transcript draws this card, and webcheck imports the transcript with no address bar.

/** The diff a card draws, as a file change on the board's one document. */
function asChange(before: string | null, after: string): FileChangeEvent {
  return { type: "file_change", path: "board.yaml", oldText: before, newText: after, source: "fs_write", toolCallId: null };
}

/**
 * A board an agent wrote, in its conversation: applied by the config agent, with an Undo, or proposed by any agent, with an Apply
 * (Q2.268, Q2.270). Either press writes every machine as Save does, and only while the account's board is still the one the card
 * was written against: anything newer is the person's or another agent's, and a press here would quietly undo it.
 */
export function BoardChangeCard({ event }: { event: BoardAppliedEvent | BoardProposedEvent }): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { board: account, read, configured } = useBoard();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<WriteResult[] | null>(null);
  const applied = event.type === "board_applied";
  const current = account.hash === event.hash;
  const before = applied ? event.previousText : current ? account.text : null;
  const write = applied ? event.previousText : event.text;
  const plan = planFor(state, read, configured);
  const press = (): void => {
    if (write === null || busy) return;
    setBusy(true);
    void writeEverywhere(plan, write)
      .then(setResults)
      .finally(() => setBusy(false));
  };
  const heading = applied ? "Changed the board" : "Proposed a board change";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-edge px-3 py-2.5">
      <p className="text-sm font-medium">{heading}</p>
      <p className="text-sm whitespace-pre-wrap wrap-anywhere text-fg/85">{event.why}</p>
      {before !== null && <DiffView change={asChange(before, event.text)} />}
      {results === null ? (
        write !== null &&
        (current ? (
          <span className="flex">
            <Button size="sm" tone={applied ? "plain" : "primary"} disabled={busy || plan.targets.length === 0} onClick={press}>
              {busy ? <Spinner /> : applied ? "Undo" : "Apply"}
            </Button>
          </span>
        ) : (
          <p className="text-2xs text-muted">The board has changed since.</p>
        ))
      ) : (
        <ul className="text-2xs text-muted">
          {results.map((result) => (
            <li key={result.id}>
              <span className="text-fg">{result.name}</span> {outcomeSentence(result.outcome)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
