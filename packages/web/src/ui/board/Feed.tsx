import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BOARD_WATCH_MS, type BoardTask } from "../../board";
import { authorName, deliveredText, feedOrder, historyOrder, openStop, questionShown } from "../../feed";
import { errorText, meansRouteAbsent } from "../../http";
import { keyOf, refOf, sessionId } from "../../ids";
import { answerKey } from "../../keys";
import type { AppState } from "../../store";
import type { TaskCommentView, TaskFeed as Feed } from "../../wire";
import { AgentMark } from "../AgentIcons";
import { fitToContent } from "../autosize";
import { Button, Icon, SETTINGS_HEADING, shortDuration, Spinner } from "../bits";
import { sentText, VERBATIM_FIELD } from "../composing";
import { ElicitationCard } from "../ElicitationCard";
import { Markdown } from "../Markdown";
import { PermissionCard } from "../PermissionCard";
import { toast } from "../Toast";
import { addComment, readFeed } from "./actions";

function ago(at: number): string {
  if (at <= 0) return "";
  const said = shortDuration(Math.max(0, Date.now() - at));
  return said === "<1m" ? "just now" : `${said} ago`;
}

export type FeedRead = { kind: "reading" } | { kind: "absent" } | { kind: "failed"; error: string } | { kind: "known"; feed: Feed };

/** Read while the page is open, at the board's own watching pace and never while the page is hidden, and again on each change of the task. */
export function useTaskFeed(entry: BoardTask): { read: FeedRead; reload: () => void } {
  const [read, setRead] = useState<FeedRead>({ kind: "reading" });
  const [nonce, setNonce] = useState(0);
  const latest = useRef(entry);
  latest.current = entry;
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const ask = (): void => {
      if (typeof document !== "undefined" && document.hidden) {
        timer = window.setTimeout(ask, BOARD_WATCH_MS);
        return;
      }
      void readFeed(latest.current).then(
        (feed) => {
          if (!cancelled) setRead({ kind: "known", feed });
        },
        (cause: unknown) => {
          if (cancelled) return;
          // An older daemon has no feed: the page keeps what it always drew, and asks nothing again.
          if (meansRouteAbsent(cause)) {
            setRead({ kind: "absent" });
            return;
          }
          // What was read stands through a lost answer; only a page that never read anything says it failed.
          setRead((before) => (before.kind === "known" ? before : { kind: "failed", error: errorText(cause) }));
        },
      ).finally(() => {
        if (!cancelled) timer = window.setTimeout(ask, BOARD_WATCH_MS);
      });
    };
    ask();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [entry.machineId, entry.task.id, entry.task.updatedAt, nonce]);
  return { read, reload: () => setNonce((n) => n + 1) };
}

/** A folded block of a task's page, as a tracker draws its history: a box with its name and count on a header that opens it. */
export function TaskBlock({ title, count, children }: { title: string; count?: number; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="overflow-hidden rounded-lg border border-edge">
      <h3 className="flex min-h-10 items-center bg-raised/50">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="tap flex min-h-10 w-full items-center gap-2 px-3 text-left hover:bg-raised"
        >
          <Icon as={ChevronRight} size={13} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
          <span className={SETTINGS_HEADING}>{title}</span>
          {count !== undefined && <span className="text-2xs text-faint tabular-nums">{count}</span>}
        </button>
      </h3>
      <div id={id} inert={!open} className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="overflow-hidden">
          <div className="border-t border-edge px-3 py-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

/** The task's history, newest first, folded: what moved it, who decided, what ran (Q3.741). An older daemon keeps none. */
export function FeedHistory({ read }: { read: FeedRead }): ReactNode {
  if (read.kind !== "known") return null;
  const history = historyOrder(read.feed.events);
  if (history.length === 0) return null;
  return (
    <TaskBlock title="History" count={history.length}>
      <ol className="flex flex-col">
        {history.map((event) => (
          <li key={event.seq} className="flex min-h-9 items-start gap-2.5 py-1.5 text-sm">
            <span className="flex h-5 w-4 shrink-0 items-center justify-center">
              <span className="h-1.5 w-1.5 rounded-full bg-edge-strong" />
            </span>
            <span className="min-w-0 flex-1 wrap-anywhere">{event.text}</span>
            <span className="shrink-0 text-xs text-muted tabular-nums" title={new Date(event.at).toLocaleString()}>
              {ago(event.at)}
            </span>
          </li>
        ))}
      </ol>
    </TaskBlock>
  );
}

/**
 * A task's comments (spec: questions and comments), last on its page: one box, then every one of them, newest first (the
 * owner's call, 2026-10-15; Q3.741). A question is the same card the conversation draws, on the same request and the same
 * routes, so an answer in either place is the one answer; a stop takes a reply, which goes into the run's own conversation.
 * An older daemon keeps no feed, and nothing is drawn for it.
 */
export function FeedComments({ read, reload, entry, state }: { read: FeedRead; reload: () => void; entry: BoardTask; state: AppState }): ReactNode {
  if (read.kind === "absent") return null;
  const comments = read.kind === "known" ? feedOrder(read.feed.comments).reverse() : [];
  const stop = read.kind === "known" ? openStop(read.feed.comments, entry.phase) : null;
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2">
        <span className={SETTINGS_HEADING}>Comments</span>
        {comments.length > 0 && <span className="text-2xs text-faint tabular-nums">{comments.length}</span>}
      </h3>
      {read.kind === "failed" && <p className="text-xs text-danger wrap-anywhere">{read.error}</p>}
      <CommentBox entry={entry} replying={stop !== null} onSent={reload} />
      {read.kind === "reading" && (
        <div className="flex justify-center py-3">
          <Spinner />
        </div>
      )}
      {comments.length > 0 && (
        <ol className="flex flex-col gap-3">
          {comments.map((comment) => (
            <li key={comment.id}>
              <Entry comment={comment} entry={entry} state={state} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const KIND_CAPTION: Record<TaskCommentView["kind"], string> = {
  question: "asked",
  stop: "stopped",
  report: "reported",
  comment: "wrote",
};

function Entry({ comment, entry, state }: { comment: TaskCommentView; entry: BoardTask; state: AppState }): ReactNode {
  const session = entry.task.sessions.find((one) => one.id === comment.author) ?? null;
  const caption = deliveredText(comment);
  const head = (
    <p className="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
      {session !== null && <AgentMark agent={session.agent} />}
      <span className="min-w-0 truncate">
        {authorName(comment.author, entry.task.sessions)} {KIND_CAPTION[comment.kind] ?? "wrote"}
      </span>
      <span className="shrink-0">· {ago(comment.at)}</span>
      {caption !== null && <span className="shrink-0">· {caption}</span>}
    </p>
  );

  if (comment.kind === "question" && comment.sessionId !== null) {
    const ref = refOf(entry.machineId, sessionId(comment.sessionId));
    const row = state.rowsByKey.get(keyOf(ref));
    const shown = questionShown(comment, row?.snapshot);
    if (shown.kind === "permission") {
      return (
        <div className="flex flex-col gap-1.5">
          {head}
          <PermissionCard
            inline
            sessionRef={ref}
            pending={shown.pending}
            events={state.transcripts.get(keyOf(ref))?.events ?? []}
            agent={row?.snapshot.agent ?? session?.agent ?? ""}
            more={0}
          />
        </div>
      );
    }
    if (shown.kind === "elicitation") {
      return (
        <div className="flex flex-col gap-1.5">
          {head}
          <ElicitationCard inline sessionRef={ref} pending={shown.pending} more={0} />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        {head}
        <div className="rounded-lg border border-edge px-3 py-2.5">
          <p className="text-sm whitespace-pre-wrap wrap-anywhere">{comment.text}</p>
          <p className="mt-1 text-2xs text-muted">Closed</p>
        </div>
      </div>
    );
  }

  // What its agent last said is drawn as the conversation draws an agent's words; a person's and a report's are drawn as sent.
  return (
    <div className="flex flex-col gap-1">
      {head}
      <div className="rounded-lg border border-edge px-3 py-2.5">
        {comment.kind === "stop" ? (
          <div className="text-sm">
            <Markdown text={comment.text} />
          </div>
        ) : (
          <p className="text-sm whitespace-pre-wrap wrap-anywhere">{comment.text}</p>
        )}
      </div>
    </div>
  );
}

/** One box over the feed: a reply to a stop when one waits, a comment otherwise. Keyboard Enter sends, as the composer's does. */
function CommentBox({ entry, replying, onSent }: { entry: BoardTask; replying: boolean; onSent: () => void }): ReactNode {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const ready = sentText(text).trim().length > 0 && !busy && !entry.unavailable;
  const send = (): void => {
    if (!ready) return;
    const body = sentText(text);
    setBusy(true);
    void addComment(entry, body)
      .then(
        () => {
          setText("");
          if (area.current !== null) {
            area.current.value = "";
            fitToContent(area.current);
          }
          onSent();
        },
        (cause: unknown) => toast("error", errorText(cause)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex items-end gap-2">
      <textarea
        {...VERBATIM_FIELD}
        ref={area}
        rows={1}
        aria-label={replying ? "Reply to the agent" : "Comment"}
        placeholder={replying ? "Reply to the agent" : "Write a comment"}
        value={text}
        disabled={entry.unavailable}
        onChange={(event) => {
          setText(event.target.value);
          fitToContent(event.target);
        }}
        onKeyDown={(event) => {
          if (answerKey(event, !window.matchMedia("(pointer: coarse)").matches) !== "advance") return;
          event.preventDefault();
          send();
        }}
        className="min-h-11 min-w-0 flex-1 resize-none rounded-md border border-edge-strong bg-surface px-3 py-2.5 text-sm leading-5 outline-none"
      />
      <Button tone="primary" size="sm" disabled={!ready} onClick={send} className="mb-1">
        {busy ? <Spinner /> : replying ? "Reply" : "Comment"}
      </Button>
    </div>
  );
}
