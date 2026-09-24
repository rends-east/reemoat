import { ListTodo, MoreVertical, Pencil, Pin, PinOff, Play, Puzzle, Square } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { errorText } from "../http";
import { keyOf, type SessionRef } from "../ids";
import { store, type AppState } from "../store";
import { isParked, isResumable, isTerminal, parkedByOlderDaemon } from "../wire";
import { Icon, IconButton, MENU_PANEL, menuPlacement } from "./bits";
import { useDismissible } from "./overlay";
import { toast } from "./Toast";
import { pluginFailure, sessionActions } from "../plugins";

/** Resolves rather than rejects: a failure is toasted and the store re-synced. */
export function resumeSession(sessionRef: SessionRef): Promise<void> {
  const daemon = store.daemonFor(sessionRef.machineId);
  if (daemon === undefined) return Promise.resolve();
  return daemon
    .resumeSession(sessionRef.sessionId)
    .then((result) => {
      store.applySnapshot(sessionRef, result.session);
    })
    .catch((cause: unknown) => {
      toast("error", cause instanceof Error ? cause.message : String(cause));
      void store.resume("action-failed");
    });
}

export function SessionMenu({
  sessionRef,
  state,
  onRename,
  onOpenTasks,
  size = "lg",
}: {
  sessionRef: SessionRef;
  state: AppState;
  onRename: () => void;
  /** Opens the background-tasks panel; absent on a list row (Q3.631). */
  onOpenTasks?: () => void;
  size?: "sm" | "lg";
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"up" | "down">("down");
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const row = state.rowsByKey.get(keyOf(sessionRef));
  const session = row?.snapshot;
  // A parked session gets no Resume, since a message is the way back, unless an older daemon parked it (Q2.224, Q7.103).
  const canResume =
    session !== undefined &&
    isTerminal(session.status) &&
    isResumable(session) &&
    (!isParked(session) || parkedByOlderDaemon(session));
  const pinned = session?.pinned === true;

  // Pointerdown rather than blur, which fires before a menu button's click lands; Escape belongs to overlay.ts.
  useDismissible("menu", () => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const run = (action: "stop" | "resume"): void => {
    if (busy) return;
    if (action === "resume") {
      setBusy(true);
      void resumeSession(sessionRef).finally(() => setBusy(false));
      return;
    }
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) return;
    setBusy(true);
    void daemon
      .stopSession(sessionRef.sessionId)
      .then((result) => store.applySnapshot(sessionRef, result.session))
      .catch((cause: unknown) => {
        toast("error", cause instanceof Error ? cause.message : String(cause));
        void store.resume("action-failed");
      })
      .finally(() => setBusy(false));
  };

  const setMeta = (patch: { pinned?: boolean; rank?: number | null }, whatDidNotHappen: string): void => {
    const issued = store.setSessionMeta(sessionRef, patch, (message) => toast("error", message));
    if (!issued) toast("error", `That machine is not reachable right now, ${whatDidNotHappen}`);
  };

  // Read from the store's copy: a fetch per row would be a request per session per poll.
  const offers = sessionActions(state.pluginsByMachine.get(sessionRef.machineId) ?? []);

  const press = (pluginId: string, actionId: string): void => {
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) {
      toast("error", "That machine is not reachable right now, so the action did not run.");
      return;
    }
    setBusy(true);
    void daemon
      .pluginAction(pluginId, actionId, { session: sessionRef.sessionId })
      .then((answer) => {
        // A toast either way, never a navigation: a plugin does not choose where somebody goes.
        toast(
          answer.result.kind === "toast" && answer.result.tone === "danger" ? "error" : "ok",
          answer.result.kind === "toast" ? answer.result.text : "Done",
        );
      })
      .catch((cause: unknown) => toast("error", pluginFailure(cause)))
      .finally(() => setBusy(false));
  };

  if (session === undefined) return null;

  return (
    <div ref={boxRef} className="relative shrink-0">
      <IconButton
        icon={MoreVertical}
        label="Session actions"
        size={size}
        disabled={busy}
        active={open}
        // Measured at the tap so the panel never grows the rail's scroller; see menuPlacement.
        onClick={() => {
          if (!open) setPlacement(menuPlacement(boxRef.current));
          setOpen(!open);
        }}
      />
      {open && (
        <div
          role="menu"
          className={`absolute right-0 w-52 max-w-[calc(100vw-2rem)] ${
            placement === "up" ? "bottom-full mb-1" : "top-full mt-1"
          } ${MENU_PANEL}`}
        >
          {/* Close this menu first: both register on overlay.ts's LIFO stack, so Escape would close the wrong one. */}
          {onOpenTasks !== undefined && (
            <MenuItem
              icon={ListTodo}
              label="Background tasks"
              haspopup="dialog"
              onClick={() => {
                setOpen(false);
                onOpenTasks();
              }}
            />
          )}
          <MenuItem
            icon={Pencil}
            label="Rename"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          />
          <MenuItem
            icon={pinned ? PinOff : Pin}
            label={pinned ? "Unpin" : "Pin"}
            onClick={() => {
              setOpen(false);
              setMeta({ pinned: !pinned }, "so the pin was not changed.");
            }}
          />

          {/* Plugins sit above the separator so Stop stays the last row whatever is installed. */}
          {offers.length > 0 && <div className="my-1 border-t border-edge/60" />}
          {offers.map((offer) => (
            <MenuItem
              key={`${offer.plugin.id}:${offer.actionId}`}
              icon={Puzzle}
              label={offer.title}
              note={offer.plugin.name}
              onClick={() => {
                setOpen(false);
                press(offer.plugin.id, offer.actionId);
              }}
            />
          ))}

          {(canResume || !isTerminal(session.status) || isParked(session)) && (
            <div className="my-1 border-t border-edge/60" />
          )}

          {canResume && (
            <MenuItem
              icon={Play}
              label="Resume"
              onClick={() => {
                setOpen(false);
                run("resume");
              }}
            />
          )}
          {/* isParked keeps Stop on a parked session, which is terminal but can still be ended. */}
          {(!isTerminal(session.status) || isParked(session)) && (
            <MenuItem
              icon={Square}
              label="Stop"
              tone="danger"
              onClick={() => {
                setOpen(false);
                run("stop");
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  note,
  onClick,
  tone = "plain",
  disabled = false,
  haspopup,
}: {
  icon: ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  /** Whose row this is; a separate element so the plugin's name truncates before the verb. */
  note?: string;
  onClick: () => void;
  tone?: "plain" | "danger";
  disabled?: boolean;
  haspopup?: "dialog";
}): ReactNode {
  return (
    <button
      role="menuitem"
      aria-haspopup={haspopup}
      onClick={onClick}
      disabled={disabled}
      title={note === undefined ? label : `${label} · ${note}`}
      className={`tap flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm disabled:pointer-events-none disabled:text-faint ${
        tone === "danger" ? "text-danger hover:bg-danger/15" : "text-fg hover:bg-raised"
      }`}
    >
      <Icon as={icon} size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {note !== undefined && (
        <span className="min-w-0 max-w-[45%] shrink-0 truncate text-2xs text-muted">{note}</span>
      )}
    </button>
  );
}

/** The longest title the daemon accepts; it answers 400 above this. */
export const MAX_TITLE_CHARS = 120;

/** Shared inline rename: empty commits as null, and the daemon's normalized snapshot is folded back rather than the typed string. */
export function RenameField({
  sessionRef,
  current,
  placeholder,
  onDone,
  className = "",
}: {
  sessionRef: SessionRef;
  current: string | null;
  placeholder: string;
  onDone: () => void;
  /** Where the box sits against the name it replaces; the text itself never moves (Q3.665). */
  className?: string;
}): ReactNode {
  const [value, setValue] = useState(current ?? "");

  const commit = (raw: string): void => {
    onDone();
    const next = raw.trim();
    if (next === (current ?? "").trim()) return;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) {
      toast("error", "That machine is not reachable right now, so the new name was not saved.");
      return;
    }
    void daemon
      .setSessionMeta(sessionRef.sessionId, { title: next.length === 0 ? null : next })
      .then((result) => store.applySnapshot(sessionRef, result.session))
      .catch((cause: unknown) => toast("error", errorText(cause)));
  };

  // The hidden copy sizes the grid cell, so the box hugs what is typed and is one text line tall.
  return (
    <span className={`inline-grid min-w-0 max-w-full ${className}`}>
      <span aria-hidden={true} className="invisible col-start-1 row-start-1 overflow-hidden px-1 text-sm whitespace-pre">
        {`${value.length > 0 ? value : placeholder}\u00a0`}
      </span>
      <input
        value={value}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setValue(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
          }
          if (event.key === "Escape") onDone();
        }}
        maxLength={MAX_TITLE_CHARS}
        placeholder={placeholder}
        aria-label="Session name"
        className="no-focus-ring col-start-1 row-start-1 h-[var(--text-sm--line-height)] w-full min-w-0 rounded-sm border-0 bg-transparent px-1 py-0 text-sm outline-none ring-1 ring-edge-strong"
      />
    </span>
  );
}
