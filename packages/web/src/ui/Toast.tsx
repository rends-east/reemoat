import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./bits";
import { LAYER } from "./overlay";

export type ToastTone = "error" | "ok";

export interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
}

const AUTO_DISMISS_MS: Record<ToastTone, number> = {
  // Long enough to read a daemon's error message, which is often a sentence.
  error: 8_000,
  ok: 3_000,
};

const listeners = new Set<() => void>();
let toasts: readonly Toast[] = [];
let nextId = 1;

function announce(): void {
  for (const listener of listeners) listener();
}

export function toast(tone: ToastTone, text: string): void {
  const id = nextId++;
  // Deduplicated by text, so a failing poll cannot stack identical toasts.
  toasts = [...toasts.filter((existing) => existing.text !== text), { id, tone, text }].slice(-3);
  announce();
  setTimeout(() => dismiss(id), AUTO_DISMISS_MS[tone]);
}

export function dismiss(id: number): void {
  const next = toasts.filter((entry) => entry.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  announce();
}

export function ToastHost(): ReactNode {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );

  // Portaled to body: overlay.ts makes #root inert while a sheet is open, and an ancestor's backdrop-filter would break fixed.
  // The status region stays mounted and only its contents swap, since a region inserted with its content is often not announced.
  return createPortal(
    // The stack ignores pointers and each toast takes them, so the gaps never swallow a tap on the composer.
    <div
      className={`pb-safe pointer-events-none fixed inset-x-0 bottom-0 ${LAYER.toast} flex flex-col items-center gap-2 px-3 pb-3`}
      role="status"
      aria-live="polite"
    >
      {current.map((entry) => (
        <div
          key={entry.id}
          // Errors are alerts: a polite announcement may be held past the dismissal timeout.
          role={entry.tone === "error" ? "alert" : undefined}
          className={`pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-lg border px-3 py-2.5 text-xs shadow-lg backdrop-blur ${
            entry.tone === "error"
              ? "border-edge-strong bg-surface text-fg font-medium"
              : "border-edge bg-surface text-fg"
          }`}
        >
          <Icon as={entry.tone === "error" ? AlertTriangle : CheckCircle2} size={14} className="mt-0.5" />
          <span className="min-w-0 flex-1 wrap-anywhere">{entry.text}</span>
          <button
            onClick={() => dismiss(entry.id)}
            // A coarse-pointer-only pad gives a 44px target without layout; on a mouse it would grow the hover area ahead of the glyph.
            className="tap relative -mt-0.5 -mr-1 flex h-6 w-6 items-center justify-center rounded-sm opacity-70 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-[''] hover:opacity-100"
            aria-label="Dismiss"
          >
            <Icon as={X} size={13} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
