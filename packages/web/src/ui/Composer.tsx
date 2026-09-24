import { Paperclip, RefreshCw, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  addAttachments,
  admitFiles,
  attachmentsFor,
  canSend,
  attachmentsVersion,
  echoAttachments,
  forgetAttachments,
  removeAttachment,
  restoreAttachments,
  pastedName,
  sendableAttachments,
  subscribeAttachments,
  updateAttachment,
  type PendingAttachment,
} from "../attach";
import type { DaemonClient } from "../daemon";
import { clearEcho, sendFloor, setEcho, type PendingEcho } from "../echo";
import { errorText } from "../http";
import { keyOf, type SessionRef } from "../ids";
import { composerKey } from "../keys";
import { formatBytes } from "../paths";
import { store, type AgentCommandList, type AppState } from "../store";
import {
  acceptsMidTurn,
  canCancelTurn,
  cancelInFlight,
  MAX_PROMPT_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  resumeStalled,
  needsHuman,
  showsWorking,
  turnInFlight,
  waitingForDaemon,
  type AgentConfigOption,
  type StoredEvent,
} from "../wire";
import { AgentConfigBar, applyConfigChange } from "./AgentConfigBar";
import { choiceRefusal, configProse, drawnControls } from "./agentConfig";
import { fitToContent } from "./autosize";
import {
  composerPlaceholder,
  focusWorthKeeping,
  sentText,
  shouldFocusComposer,
  shouldReleaseComposer,
  takeKeyNav,
  VERBATIM_FIELD,
} from "./composing";
import { COLUMN, IconButton, Spinner } from "./bits";
import {
  buildCommands,
  completion,
  configChoices,
  filterCommands,
  slashQuery,
  typedConfigCommand,
} from "./commands";
import { CommandMenu } from "./CommandMenu";
import { SendSlot } from "./SendSlot";
import { slotOccupant } from "./slotSwap";
import { toast } from "./Toast";

// Outside the store: a draft outlives an unmount without waking every subscriber per keystroke.
const drafts = new Map<string, string>();

// Stable identity, so memos over the event window survive each keystroke.
const EMPTY_EVENTS: readonly StoredEvent[] = [];
const EMPTY_COMMANDS: AgentCommandList = { commands: [], dropped: 0 };

function stalled(list: readonly PendingAttachment[]): boolean {
  return list.some((item) => item.state === "failed");
}

// A failed attachment holds Send too: sending would drop the file, and the chip's Retry is the way out.
function sendable(text: string, list: readonly PendingAttachment[], refused: boolean): boolean {
  return canSend(text, list, refused) && !stalled(list);
}

const CLEAR_REFUSAL = "/clear waits for the agent to finish — stop it, or send it after";

let uploadSeq = 0;

export function Composer({
  sessionRef,
  state,
  onSent,
  revising,
}: {
  sessionRef: SessionRef;
  state: AppState;
  /** Fires on the optimistic half of a send, never for a typed config command. */
  onSent: () => void;
  /** A plan is waiting: the one parked request that does not gate this box, which answers it. */
  revising: boolean;
}): ReactNode {
  const key = keyOf(sessionRef);
  const row = state.rowsByKey.get(key);
  const [text, setText] = useState(() => drafts.get(key) ?? "");
  const [busy, setBusy] = useState(false);
  // The cancel round trip only; reusing `busy` would put Send's spinner over Stop.
  const [stopping, setStopping] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [stage, setStage] = useState<AgentConfigOption | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const pendingCaret = useRef<number | null>(null);
  // This instance is not remounted on a session switch, so shared state written after an await must check this.
  const liveKey = useRef(key);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useSyncExternalStore(subscribeAttachments, attachmentsVersion);
  const attachments = attachmentsFor(key);
  const slotsFull =
    attachments.filter((item) => item.state !== "failed").length >= MAX_PROMPT_ATTACHMENTS;

  const upload = async (
    daemon: DaemonClient,
    item: { localId: string; file: File; name: string },
    controller: AbortController,
  ): Promise<void> => {
    try {
      const answer = await daemon.uploadFile(
        sessionRef.sessionId,
        item.file,
        item.name,
        (fraction) => updateAttachment(key, item.localId, { progress: fraction }),
        controller.signal,
      );
      updateAttachment(key, item.localId, {
        state: "ready",
        progress: 1,
        uploadId: answer.upload.uploadId,
        name: answer.upload.name,
        cancel: null,
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      updateAttachment(key, item.localId, {
        state: "failed",
        error: errorText(cause),
        cancel: null,
      });
    }
  };

  // A fresh controller: the failed chip's signal is already aborted.
  const retry = (item: PendingAttachment): void => {
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined || item.state !== "failed") return;
    const controller = new AbortController();
    updateAttachment(key, item.localId, {
      state: "uploading",
      progress: 0,
      error: null,
      cancel: () => controller.abort(),
    });
    void upload(daemon, item, controller);
  };

  // Upload on select, sequentially, so a batch does not contend for one tunnel window.
  const attach = (picked: readonly File[]): void => {
    if (picked.length === 0) return;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) return;

    const { accepted, refused } = admitFiles(attachmentsFor(key), picked);
    for (const item of refused) {
      toast(
        "error",
        item.reason === "too_large"
          ? `${item.file.name} is larger than ${formatBytes(MAX_UPLOAD_BYTES)}`
          : item.reason === "empty"
            ? `${item.file.name} is empty`
            : `at most ${MAX_PROMPT_ATTACHMENTS} files per message`,
      );
    }
    if (accepted.length === 0) return;

    const stampedAt = Date.now();
    const staged = accepted.map((file: File) => {
      const controller = new AbortController();
      return {
        localId: `a_${uploadSeq++}`,
        file,
        // A pasted screenshot can be nameless, and the daemon refuses an empty name.
        name: pastedName(file.name, file.type, stampedAt),
        size: file.size,
        mimeType: file.type,
        state: "uploading" as const,
        progress: 0,
        uploadId: null,
        error: null,
        cancel: () => controller.abort(),
        controller,
      };
    });
    addAttachments(
      key,
      staged.map(({ controller, ...item }) => { void controller; return item; }),
    );

    void (async () => {
      for (const item of staged) await upload(daemon, item, item.controller);
    })();
  };

  useEffect(() => {
    liveKey.current = key;
    setText(drafts.get(key) ?? "");
    setStage(null);
    setDismissed(false);
    setCaret(0);
    setApplying(null);
    setBusy(false);
    // Its only other reset is gated on `onScreen`, so a switch mid-cancel would leave it stuck.
    setStopping(false);
  }, [key]);

  // An effect on `key`, not autoFocus: at lg a session switch does not remount this.
  const composerShows = row !== undefined;
  useEffect(() => {
    const fromKeyboardNav = takeKeyNav();
    const active = document.activeElement;
    if (
      !shouldFocusComposer({
        hasBox: composerShows,
        pointerCoarse: window.matchMedia("(pointer: coarse)").matches,
        // Only focus that would be stolen: Chromium focuses a tapped session row.
        focusHeldElsewhere: focusWorthKeeping(active),
        blocked: row !== undefined && needsHuman(row.snapshot),
        fromKeyboardNav,
      })
    ) {
      return;
    }
    areaRef.current?.focus({ preventScroll: true });
    // `row` is not a dependency: the store replaces it every poll, which would refocus the box.
  }, [key, composerShows]);

  // Layout effect so the height is set before paint; `visualViewport` because a soft keyboard does not shrink `vh`. Q3.422.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    fitToContent(area);
  }, [text]);

  // The cap moves without the text; only the visual viewport fires for the soft keyboard.
  useEffect(() => {
    const refit = (): void => {
      const area = areaRef.current;
      if (area !== null) fitToContent(area);
    };
    window.addEventListener("resize", refit);
    window.visualViewport?.addEventListener("resize", refit);
    return () => {
      window.removeEventListener("resize", refit);
      window.visualViewport?.removeEventListener("resize", refit);
    };
  }, []);

  const transcript = state.transcripts.get(key);

  // Keyed on the revision: claude republishes its commands mid-session.
  const revision = row?.snapshot.commandsRevision;
  useEffect(() => {
    store.ensureCommands(sessionRef, revision);
  }, [sessionRef.machineId, sessionRef.sessionId, revision]);

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    areaRef.current?.setSelectionRange(at, at);
    setCaret(at);
  }, [text]);

  const events = transcript?.events ?? EMPTY_EVENTS;
  const commandList = state.commands.get(key) ?? EMPTY_COMMANDS;
  const commands = commandList.commands;
  const agentConfig = row?.snapshot.agentConfig;

  // These deps change on every poll and streamed event, so nothing may key a reset on their identity.
  const prose = useMemo(() => configProse(events), [events]);
  const entries = useMemo(
    () => buildCommands(commands, agentConfig, prose, row?.snapshot.agent),
    [commands, agentConfig, prose, row?.snapshot.agent],
  );
  const query = dismissed ? null : slashQuery(text, caret);
  const matches = useMemo(
    () => (query === null ? [] : filterCommands(entries, query.query)),
    [entries, query?.query],
  );
  // From `row`: `session` is bound below the early return.
  const turnRunning = row !== undefined && turnInFlight(row.snapshot);
  const choices = useMemo(
    () => (stage === null ? null : configChoices(stage, prose.get(stage.id), turnRunning)),
    [stage, prose, turnRunning],
  );

  const rows: readonly unknown[] = choices ?? matches;
  const menuOpen = !dismissed && rows.length > 0 && (stage !== null || query !== null);

  // Reset on the question, never on list identity (which moves every poll), or aiming at `/dontAsk` can land on `/default`.
  useEffect(() => {
    setActive(0);
  }, [query?.query, stage]);

  useEffect(() => {
    setActive((at) => (at < rows.length ? at : 0));
  }, [rows.length]);

  // Release the caret when a request parks so the card's keys work (not for a plan); above the early returns for hook order.
  const parked = row !== undefined && needsHuman(row.snapshot) && !revising;
  useEffect(() => {
    const box = areaRef.current;
    if (box === null) return;
    if (
      shouldReleaseComposer({
        blocked: parked,
        focused: document.activeElement === box,
        draftEmpty: text.trim().length === 0,
      })
    ) {
      box.blur();
    }
  }, [parked]);

  if (row === undefined) return null;
  const session = row.snapshot;
  // Nothing takes this box off the screen: Send is gated, never the box.

  const blocked = needsHuman(session);
  const working = showsWorking(session);
  const midTurnOk = acceptsMidTurn(session);
  const sessionRefused = revising
    ? false
    : session.status === "stopping" || (!midTurnOk && (blocked || working));
  // The daemon refuses `/clear` while the agent works or waits, turn or not, so it is refused here too (Q2.232).
  const clearRefused = !revising && canCancelTurn(session) && text.trim() === "/clear";
  const sendRefused = sessionRefused || clearRefused;
  const slotSends = sendable(text, attachments, sendRefused);
  // A refusal about the draft keeps a disabled Send rather than putting Stop under a thumb aimed at Send.
  const draftAnswerable = !sessionRefused && !slotSends && (text.trim().length > 0 || attachments.length > 0);
  const stoppable = canCancelTurn(session) && !revising && !slotSends && !draftAnswerable;
  // Computed once, so the drawn line and Send's label cannot disagree.
  const sendRefusal = sendRefused
    ? session.status === "stopping"
      ? "This session is stopping — it cannot take a message"
      : clearRefused
        ? CLEAR_REFUSAL
        : "Wait for the agent — this machine's daemon cannot take a message yet"
    : stalled(attachments)
      ? "An attachment did not upload — retry it or remove it"
      : null;
  const pendingCancel = cancelInFlight(session);
  const occupant = slotOccupant({ sending: busy, stopping: stopping || pendingCancel, sends: slotSends, stoppable });
  // The refusal line is about Send, so it shows only while Send holds the slot.
  const sendDrawn = occupant === "send";

  const reconnecting = waitingForDaemon(session) || resumeStalled(session);

  const update = (next: string): void => {
    setText(next);
    if (next.length === 0) drafts.delete(key);
    else drafts.set(key, next);
  };

  // Ask only after an await: `liveKey` is written from an effect.
  const onScreen = (): boolean => liveKey.current === key;

  const closeMenu = (): void => {
    setStage(null);
    setDismissed(true);
  };

  const applyValue = (option: AgentConfigOption, value: string, onDone?: (ok: boolean) => void): void => {
    if (choiceRefusal(option, value, turnRunning) !== null) {
      onDone?.(false);
      return;
    }
    setApplying(value);
    void applyConfigChange(sessionRef, option.id, value).then((ok) => {
      const present = onScreen();
      if (present) setApplying(null);
      onDone?.(ok);
      if (ok && present) closeMenu();
    });
  };

  const choose = (index: number): void => {
    if (query === null) return;
    const entry = matches[index];
    if (entry === undefined) return;
    const next = completion(text, query, entry);

    if (entry.option !== null && entry.value !== null) {
      // Rewrite the draft only if the daemon agreed, so a refusal leaves the token to retry from.
      applyValue(entry.option, entry.value, (ok) => {
        if (!ok) return;
        if (onScreen()) {
          update(next.text);
          pendingCaret.current = next.caret;
        } else if (next.text.length === 0) drafts.delete(key);
        else drafts.set(key, next.text);
      });
      return;
    }

    update(next.text);
    pendingCaret.current = next.caret;
    setStage(entry.kind === "config" ? entry.option : null);
  };

  const chooseValue = (index: number): void => {
    const value = choices?.[index]?.value;
    if (stage === null || value === undefined) return;
    applyValue(stage, value);
  };

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    const daemon = store.daemonFor(sessionRef.machineId);
    if (busy || daemon === undefined) return;
    if (!sendable(text, attachments, sendRefused)) return;

    // A typed control applies like a chosen one instead of reaching the agent as a prompt.
    const typed = typedConfigCommand(text, entries);
    if (typed !== null) {
      const { entry, option, rest } = typed;
      if (entry.value === null) {
        // Clear `dismissed` too: pressing Send already dismissed the menu, leaving a stage nothing draws.
        update(`/${entry.name}`);
        setStage(option);
        setDismissed(false);
        return;
      }
      // Send only if the daemon agreed: a prompt written for plan mode must not run in the previous mode.
      setBusy(true);
      applyValue(option, entry.value, (ok) => {
        if (onScreen()) setBusy(false);
        if (!ok) return;
        if (onScreen()) update(rest);
        else if (rest.length === 0) drafts.delete(key);
        else drafts.set(key, rest);
        if (sendable(rest, attachmentsFor(key), sendRefused)) send(rest, true);
      });
      return;
    }

    send(sentText(text), false);
  };

  // `late`: whether the caller awaited since the gesture, so it knows whether to ask `onScreen`.
  const send = (body: string, late: boolean): void => {
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) return;

    // Read live: a late caller may have gained a chip since this render, and the live list is cleared below.
    const sent = [...attachmentsFor(key)];
    const { ids: sending } = sendableAttachments(sent);
    const echo: PendingEcho = {
      text: body,
      seq: Number.MAX_SAFE_INTEGER,
      after: sendFloor(key, store.getSnapshot().transcripts.get(key)?.events.at(-1)?.seq ?? 0),
      attachments: echoAttachments(sent),
    };
    setEcho(key, echo);
    if (!late || onScreen()) {
      setBusy(true);
      update("");
      onSent();
    } else {
      drafts.delete(key);
    }
    forgetAttachments(key);
    // Before a plan, cancel first, turn or not: the daemon dismisses the parked plan either way (Q2.232).
    const settled = revising
      ? daemon.cancelTurn(sessionRef.sessionId).then((result) => {
          store.applySnapshot(sessionRef, result.session);
        })
      : Promise.resolve();

    void settled
      .then(() => daemon.prompt(sessionRef.sessionId, body, sending))
      .then((result) => {
        // `promptLanded` also settles the echo, since the prompt event often beats this answer.
        store.promptLanded(sessionRef, echo, result.seq);
        store.applySnapshot(sessionRef, result.session);
      })
      .catch((cause: unknown) => {
        // Restore the chips with the text: the uploads are still valid.
        clearEcho(key, echo);
        if (onScreen()) {
          update(body);
        } else if (body.length === 0) {
          drafts.delete(key);
        } else {
          drafts.set(key, body);
        }
        restoreAttachments(key, sent);
        // Every refusal toasts: the box is unconditional and `onAuthFailure` no longer ends the session.
        toast("error", errorText(cause));
      })
      .finally(() => {
        if (onScreen()) setBusy(false);
      });
  };

  // Nothing optimistic: the pending state comes only from the daemon's snapshot.
  const cancelTurn = (): void => {
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined || stopping) return;
    setStopping(true);
    void daemon
      .cancelTurn(sessionRef.sessionId)
      .then((result) => {
        store.applySnapshot(sessionRef, result.session);
      })
      .catch((cause: unknown) => {
        toast("error", errorText(cause));
      })
      .finally(() => {
        if (onScreen()) setStopping(false);
      });
  };

  return (
    <div
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files];
        setDragging(false);
        if (files.length === 0) return;
        event.preventDefault();
        attach(files);
      }}
      className="pb-safe sticky bottom-0 bg-surface pt-1.5"
    >
      {/* `pb-2` here: beside the unlayered `.pb-safe` it would lose. */}
      <div className={`${COLUMN} px-4 pb-2`}>
      {/* The box is the form, so every hand-rolled button under it needs an explicit type; never overflow-hidden (menus open above it). */}
      <form
        onSubmit={submit}
        className={`relative rounded-xl border border-edge-strong px-1.5 pt-1 pb-1.5 ${
          dragging ? "bg-raised ring-1 ring-edge-strong ring-inset" : "bg-surface"
        }`}
      >
      {/* Row gap 12px so the grown tap targets of wrapped chips do not overlap. */}
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-x-1.5 gap-y-3 pb-2">
          {attachments.map((item) => (
            <li
              key={item.localId}
              className={`flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-2xs ${
                item.state === "failed" ? "border-danger/50 bg-danger/5" : "border-transparent bg-raised"
              }`}
            >
              {/* Retry leads the chip, away from Remove, so their grown targets cannot overlap. */}
              {item.state === "uploading" ? (
                <Spinner />
              ) : item.state === "failed" ? (
                <IconButton
                  icon={RefreshCw}
                  label={`Upload ${item.name} again`}
                  size="sm"
                  disabled={slotsFull}
                  onClick={() => retry(item)}
                />
              ) : (
                <Paperclip size={11} className="shrink-0 text-faint" />
              )}
              <span className="min-w-0 truncate font-mono">{item.name}</span>
              <span className="shrink-0 text-faint">
                {item.state === "uploading"
                  ? item.progress > 0
                    ? `${Math.round(item.progress * 100)}%`
                    : "sending…"
                  : item.state === "failed"
                    ? (item.error ?? "failed")
                    : formatBytes(item.size)}
              </span>
              <IconButton
                icon={X}
                label={`Remove ${item.name}`}
                size="sm"
                onClick={() => removeAttachment(key, item.localId)}
              />
            </li>
          ))}
        </ul>
      )}

        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            attach([...(event.currentTarget.files ?? [])]);
            // Cleared so picking the same file twice in a row fires `change`
            // again — otherwise the second attempt does nothing, silently.
            event.currentTarget.value = "";
          }}
        />
        {menuOpen && (
          <CommandMenu
            entries={matches}
            choices={choices}
            active={active}
            stage={stage}
            busy={applying}
            dropped={commandList.dropped}
            anchorRef={areaRef}
            onHover={setActive}
            onChoose={choose}
            onChooseValue={chooseValue}
            onDismiss={closeMenu}
          />
        )}
        <textarea
          ref={areaRef}
          {...VERBATIM_FIELD}
          value={text}
          onChange={(event) => {
            update(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setDismissed(false);
            setStage(null);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          // Only when there are files: a text paste must fall through untouched.
          onPaste={(event) => {
            const files = [...(event.clipboardData?.files ?? [])];
            if (files.length === 0) return;
            event.preventDefault();
            attach(files);
          }}
          onKeyDown={(event) => {
            // React does not forward `isComposing`; the pointer is read per keystroke so an attached keyboard is seen.
            const action = composerKey(
              { ...event, isComposing: event.nativeEvent.isComposing },
              menuOpen,
              !window.matchMedia("(pointer: coarse)").matches,
            );
            if (action === null) return;
            event.preventDefault();
            if (action === "send") submit();
            else if (action === "next") setActive((at) => (at + 1) % rows.length);
            else if (action === "prev") setActive((at) => (at - 1 + rows.length) % rows.length);
            else if (action === "choose") {
              if (stage === null) choose(active);
              else chooseValue(active);
            } else {
              // `useKeyboard` blurs on a window Escape, which would also close the soft keyboard.
              event.stopPropagation();
              closeMenu();
            }
          }}
          rows={1}
          enterKeyHint="enter"
          placeholder={composerPlaceholder({
            blocked,
            reconnecting: busy && reconnecting,
            working,
            revising,
            hasCommands: entries.length > 0,
          })}
          aria-label="Message"
          role="combobox"
          // `combobox` on a textarea drops the multiline semantics, so they are restored explicitly.
          aria-multiline={true}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? "composer-command-menu" : undefined}
          aria-activedescendant={menuOpen ? `composer-command-${active}` : undefined}
          // `no-focus-ring`: the unlayered focus-visible rule beats any layered outline utility, and a textarea matches it on every tap.
          className="no-focus-ring block min-h-11 w-full resize-none overflow-hidden bg-transparent px-2 py-2.5 text-sm outline-none"
        />

      {sendDrawn && sendRefusal === CLEAR_REFUSAL && (
        <p className="px-2 pt-1 text-2xs text-muted">{CLEAR_REFUSAL}</p>
      )}

      <div className="mt-1.5 flex items-center gap-2 sm:gap-3">
        <IconButton
          icon={Paperclip}
          label="Attach a file"
          tone="ghost"
          size="chip"
          // ACP requires every agent to support `resource_link`.
          disabled={slotsFull}
          onClick={() => fileInput.current?.click()}
        />
        <AgentConfigBar
          sessionRef={sessionRef}
          controls={drawnControls(session, row?.heldConfig)}
          events={transcript?.events ?? EMPTY_EVENTS}
          turnRunning={turnRunning}
          disabled={busy}
        />
        {/* `ml-auto` keeps Send at the end when no config bar renders. */}
        <div className="ml-auto flex shrink-0 items-center pl-1">
          <SendSlot
            occupant={occupant}
            scope={key}
            sendLabel={sendRefusal ?? "Send"}
            sendEnabled={slotSends}
            onStop={cancelTurn}
            box={areaRef}
          />
        </div>
      </div>
      </form>
      </div>
    </div>
  );
}
