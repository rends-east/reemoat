import { MoreVertical, Pencil, Pin, PinOff, Play, Square } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { errorText } from "../http";
import { keyOf, type SessionRef } from "../ids";
import { store, type AppState } from "../store";
import { isResumable, isTerminal } from "../wire";
import { Icon, IconButton, MENU_PANEL } from "./bits";
import { useDismissible } from "./overlay";
import { toast } from "./Toast";

/**
 * Ask the daemon to put an agent back on this session.
 *
 * Extracted because there are three doors to it now — this menu, the banner on a
 * session whose automatic resume gave up, and (indirectly) simply sending a
 * message, which the daemon resumes in front of. The two explicit ones have to
 * agree about what happens afterwards: apply the returned snapshot, and on a
 * failure toast the daemon's own words *and* re-sync, because the commonest
 * reason a resume fails is something that also changed elsewhere.
 *
 * Resolves rather than rejects. Every caller's only remaining job is to stop
 * showing a spinner, and none of them has anything to add to the toast.
 */
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

/**
 * Everything you can do to a session, behind one button.
 *
 * A kebab rather than a row of controls in the header, which is where `Stop` used
 * to live on its own. Three reasons, in order of how much they matter: a header
 * with a permanently visible **Stop** invites the one action here that cannot be
 * undone; the actions are not all available at once (stop and resume are mutually
 * exclusive), so a fixed row either shifts or leaves a hole; and rename and pin had
 * nowhere to go but the title itself, which made a heading double as a control.
 *
 * Deliberately no keyboard letters printed beside the items. The bindings that do
 * exist are a debugging convenience and mostly do not fire — see the note in
 * `AppShell` — and printing them here would re-make the claim that was just removed.
 */
export function SessionMenu({
  sessionRef,
  state,
  onRename,
  size = "md",
}: {
  sessionRef: SessionRef;
  state: AppState;
  onRename: () => void;
  /** `sm` for a list row, where the menu must not outweigh the row it sits on. */
  size?: "sm" | "md";
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const row = state.rowsByKey.get(keyOf(sessionRef));
  const session = row?.snapshot;
  const canResume = session !== undefined && isTerminal(session.status) && isResumable(session);
  const pinned = session?.pinned === true;

  // Same dismissal as every other popover here: pointerdown rather than blur,
  // because the menu is made of buttons and blur fires before the click lands.
  // Escape is not here any more — it belongs to `overlay.ts`, which is the only
  // thing that knows whether something has opened over this menu since.
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

  const setMeta = (patch: { pinned?: boolean }): void => {
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) {
      toast("error", "that machine is not reachable");
      return;
    }
    setBusy(true);
    void daemon
      .setSessionMeta(sessionRef.sessionId, patch)
      .then((result) => store.applySnapshot(sessionRef, result.session))
      .catch((cause: unknown) => toast("error", errorText(cause)))
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
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div
          role="menu"
          // `MENU_PANEL` rather than a fourth hand-written copy of it, which is
          // what this was — byte-adjacent to the shared string and drifting from
          // it in the radius, the padding and the shadow.
          className={`absolute top-full right-0 mt-1 w-52 max-w-[calc(100vw-2rem)] ${MENU_PANEL}`}
        >
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
              setMeta({ pinned: !pinned });
            }}
          />

          {(canResume || !isTerminal(session.status)) && <div className="my-1 border-t border-edge/60" />}

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
          {/* Last, separated, and the only red thing in the menu. Stopping an
              agent mid-turn is the one action here with no way back. */}
          {!isTerminal(session.status) && (
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
  onClick,
  tone = "plain",
}: {
  icon: ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  onClick: () => void;
  tone?: "plain" | "danger";
}): ReactNode {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      // `min-h-11` — 44px, and deliberately the same number `Dropdown`'s option
      // rows use rather than a second menu-row height living in this file. This
      // menu was 37px, which is under the platform minimum on the one popover in
      // the app containing `Stop`, described above as the action with no way back.
      className={`tap flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-raised ${
        tone === "danger" ? "text-danger hover:bg-danger/15" : "text-fg"
      }`}
    >
      <Icon as={icon} size={13} />
      {label}
    </button>
  );
}

/** The longest title the daemon accepts; it answers 400 above this. */
export const MAX_TITLE_CHARS = 120;

/**
 * The inline rename input, shared by the session header and a list row.
 *
 * One component because renaming has three rules that are easy to get subtly
 * different in a second copy: **empty commits as `null`** (which is how you undo a
 * name, and what re-arms the daemon's derivation from the next prompt), the
 * placeholder is the fallback label so that outcome is visible *before* you commit
 * to it, and the daemon's own snapshot is folded back rather than the typed string
 * — a title is normalized on the way in, so what was typed and what was stored are
 * not always the same.
 *
 * `preventDefault` on Enter so this can never submit an enclosing form. The bare
 * `j`/`k` shortcuts are already safe: `isTypingInto` in `keys.ts` covers `INPUT`.
 */
export function RenameField({
  sessionRef,
  current,
  placeholder,
  onDone,
}: {
  sessionRef: SessionRef;
  current: string | null;
  placeholder: string;
  onDone: () => void;
}): ReactNode {
  const [value, setValue] = useState(current ?? "");

  const commit = (raw: string): void => {
    onDone();
    const next = raw.trim();
    if (next === (current ?? "").trim()) return;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) {
      toast("error", "that machine is not reachable");
      return;
    }
    void daemon
      .setSessionMeta(sessionRef.sessionId, { title: next.length === 0 ? null : next })
      .then((result) => store.applySnapshot(sessionRef, result.session))
      .catch((cause: unknown) => toast("error", errorText(cause)));
  };

  return (
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
      className="min-w-0 flex-1 rounded-sm border border-edge-strong bg-ink px-1.5 py-0.5 text-sm outline-none"
    />
  );
}
