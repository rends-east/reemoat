import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatBoardError, parseBoard, type BoardError } from "@reemoat/board";
import { board as boardStore } from "../../boardStore";
import { offsetOf, outcomeSentence, saveOutcome, savePlan, type SaveOutcome } from "../../boardSave";
import type { MachineId } from "../../ids";
import { machinesAsDrawn, store, type AppState } from "../../store";
import { Button, GROUP_ROW, Spinner } from "../bits";
import { VERBATIM_FIELD } from "../composing";
import { Header } from "../Header";
import { Group } from "../kit/List";
import { Notice } from "../kit/Status";
import { useBoard, useBoardWatch } from "./useBoard";

interface Result {
  id: MachineId;
  name: string;
  outcome: SaveOutcome;
}

/**
 * The account's board as its YAML, pasted or typed, and nothing else (Q3.742). Saving writes it to every reachable machine that
 * runs the board, each against the revision it was read at, and says what each answered.
 */
export function BoardEditor({ state }: { state: AppState }): ReactNode {
  const snap = useBoard();
  useBoardWatch();
  const account = snap.board;
  // The text the draft began from: a draft equal to it follows the account's board, any other is kept when that board moves.
  const [base, setBase] = useState(account.text);
  const [draft, setDraft] = useState(account.text);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const dirty = draft !== base;

  useEffect(() => {
    if (draft !== base) return;
    setBase(account.text);
    setDraft(account.text);
  }, [account.text]);

  const parsed = useMemo(() => parseBoard(draft), [draft]);
  const errors = parsed.ok ? [] : parsed.errors;
  const plan = savePlan(
    machinesAsDrawn(state).map(({ machine, name }) => ({
      id: machine.id,
      name,
      reach: machine.reach,
      writable: machine.scopes.includes("session:write"),
      read: snap.read.has(machine.id),
    })),
    snap.configured,
  );
  const readOnly = snap.configured.size === 0;
  const movedUnder = dirty && account.text !== base;

  const load = (text: string): void => {
    setBase(account.text);
    setDraft(text);
  };
  const goTo = (error: BoardError): void => {
    const box = textRef.current;
    if (box === null) return;
    const at = offsetOf(box.value, error.line, error.col);
    box.focus();
    box.setSelectionRange(at, at);
  };

  const writeOne = async (target: { id: MachineId; name: string; revision: number }, text: string): Promise<Result> => {
    const daemon = store.daemonFor(target.id);
    if (daemon === undefined) return { id: target.id, name: target.name, outcome: { kind: "skipped", why: "unreachable" } };
    const outcome = await daemon.putBoard(text, target.revision).then(
      (written) => {
        const read = parseBoard(written.text);
        if (read.ok) boardStore.applyBoard(target.id, { revision: written.revision, hash: written.hash, text: written.text, board: read.board });
        boardStore.refresh(target.id);
        return saveOutcome({ ok: true, written });
      },
      (cause: unknown) => saveOutcome({ ok: false, cause }),
    );
    return { id: target.id, name: target.name, outcome };
  };

  const save = (): void => {
    if (saving || !parsed.ok || plan.targets.length === 0) return;
    const text = draft;
    setSaving(true);
    void Promise.all(plan.targets.map((target) => writeOne(target, text)))
      .then((written) => {
        const skipped: Result[] = plan.skipped.map((one) => ({ id: one.id, name: one.name, outcome: { kind: "skipped", why: one.why } }));
        setResults([...written, ...skipped]);
        // Taken by any machine, it is the account's board now: the draft is no longer a draft.
        if (written.some((one) => one.outcome.kind === "saved")) setBase(text);
      })
      .finally(() => setSaving(false));
  };

  const overwrite = (result: Result, revision: number): void => {
    const text = draft;
    setSaving(true);
    void writeOne({ id: result.id, name: result.name, revision }, text)
      .then((next) => {
        setResults((before) => (before ?? []).map((one) => (one.id === next.id ? next : one)));
        if (next.outcome.kind === "saved") setBase(text);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <Header title={<span className="truncate text-sm font-semibold">Board</span>} close board>
        {dirty && !readOnly && (
          <Button size="sm" tone="ghost" disabled={saving} onClick={() => load(account.text)}>
            Discard
          </Button>
        )}
        {!readOnly && (
          <Button size="sm" tone="primary" disabled={!dirty || !parsed.ok || plan.targets.length === 0 || saving} onClick={save}>
            {saving ? <Spinner /> : "Save"}
          </Button>
        )}
      </Header>

      <div className="w-full px-4 pt-1 pb-10 lg:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {readOnly && <Notice>No machine runs the configurable board yet.</Notice>}
          {movedUnder && (
            <Notice tone="warn">
              <span className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">The board changed since you started editing.</span>
                <Button size="sm" onClick={() => load(account.text)}>
                  Load it
                </Button>
              </span>
            </Notice>
          )}

          <textarea
            {...VERBATIM_FIELD}
            ref={textRef}
            aria-label="The board as YAML"
            placeholder="Paste the board's YAML"
            value={draft}
            readOnly={readOnly}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(40, Math.max(12, draft.split("\n").length + 1))}
            className="w-full resize-y rounded-md border border-edge-strong bg-surface px-3 py-2 font-mono text-xs leading-5 outline-none"
          />

          {errors.length > 0 && (
            <Group title="What is wrong" count={String(errors.length)} still>
              {errors.map((error) => (
                <button
                  key={`${error.line}:${error.col}:${error.path}:${error.message}`}
                  type="button"
                  onClick={() => goTo(error)}
                  className={`tap ${GROUP_ROW} hover:bg-raised`}
                >
                  <span className="min-w-0 flex-1 text-sm text-danger">
                    <span className="font-mono text-2xs">{formatBoardError(error).split(": ")[0]}</span>
                    <span>: {error.message}</span>
                  </span>
                </button>
              ))}
            </Group>
          )}

          {results !== null && (
            <Group title="Last save" still>
              {results.map((result) => (
                <SaveRow
                  key={result.id}
                  result={result}
                  busy={saving}
                  onUse={(text) => {
                    setBase(text);
                    setDraft(text);
                    setResults(null);
                  }}
                  onOverwrite={(revision) => overwrite(result, revision)}
                  onGoTo={goTo}
                />
              ))}
            </Group>
          )}
        </div>
      </div>
    </div>
  );
}

function SaveRow({
  result,
  busy,
  onUse,
  onOverwrite,
  onGoTo,
}: {
  result: Result;
  busy: boolean;
  onUse: (text: string) => void;
  onOverwrite: (revision: number) => void;
  onGoTo: (error: BoardError) => void;
}): ReactNode {
  const { outcome } = result;
  const bad = outcome.kind === "conflict" || outcome.kind === "refused" || outcome.kind === "failed";
  return (
    <div className={`${GROUP_ROW} flex-wrap`}>
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-medium">{result.name}</span>
        <span className={bad ? "text-danger" : "text-muted"}> {outcomeSentence(outcome)}</span>
      </span>
      {outcome.kind === "conflict" && (
        <span className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => onUse(outcome.text)}>
            Use its board
          </Button>
          <Button size="sm" disabled={busy} onClick={() => onOverwrite(outcome.revision)}>
            Save over it
          </Button>
        </span>
      )}
      {outcome.kind === "refused" && (
        <ul className="w-full">
          {outcome.errors.map((error) => (
            <li key={error.text}>
              <button type="button" onClick={() => onGoTo(error)} className="tap min-h-9 text-left text-xs text-danger hover:underline">
                {error.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
