import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./bits";
import { LAYER } from "./overlay";

/**
 * Transient messages, out of the way of the thing they are about.
 *
 * These used to be inline `<p className="text-danger">` strings inside the
 * composer, the permission card and the session header. Three problems with
 * that: the message shifted the layout of a form somebody was mid-way through
 * using, it was invisible if the failing control had scrolled off, and it
 * survived only as long as that component was mounted — so an error from an
 * action that navigated away was never seen at all.
 *
 * An external store rather than context, for the same reason `store.ts` is one:
 * these are raised from promise callbacks that are not inside a render, and a
 * `useState` setter reachable only through a hook is awkward to call from there.
 */

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
  // Deduplicated by text: a failing poll can raise the same message every few
  // seconds, and a stack of eight identical toasts hides everything else.
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

  /*
   * Portaled to `document.body`, and both halves of that are required rather than
   * tidy.
   *
   * **`inert`.** `overlay.ts` puts `inert` on `#root` while a sheet is open, which
   * is what gives focus containment and background inertness in one attribute
   * instead of a hand-rolled focus trap. `ToastHost` is rendered inside `App`,
   * inside `#root` — so left there it would go `aria-hidden` and untappable
   * exactly when it is most needed, since a sheet is where most of this app's
   * failures are reported from.
   *
   * **`fixed`.** `position: fixed` only means "the viewport" while no ancestor
   * carries `filter`, `backdrop-filter`, `transform`, `perspective` or `contain`,
   * and this app is one hop from a `backdrop-blur` almost everywhere.
   *
   * The z moves up a step with it: every action inside the settings sheet reports
   * failure through `toast()`, and a toast painted *under* the sheet that raised
   * it is an error message nobody can read.
   *
   * **The stack is mounted unconditionally and only its contents swap**, which is
   * the one arrangement that reliably announces: a `role="status"` inserted into
   * the DOM in the same paint as its content is commonly not spoken at all,
   * VoiceOver on iOS included — and this app is used from a phone. `EventList`
   * records the same measurement about its own live region. It costs nothing
   * while empty: the box is `pointer-events-none`, so the padding it holds open
   * over the composer swallows no tap.
   */
  return createPortal(
    // `pointer-events-none` on the stack and `auto` on each toast: this sits
    // over the composer, and a toast must not swallow a tap aimed at the input
    // underneath the gap between them.
    <div
      className={`pb-safe pointer-events-none fixed inset-x-0 bottom-0 ${LAYER.toast} flex flex-col items-center gap-2 px-3 pb-3`}
      role="status"
      aria-live="polite"
    >
      {current.map((entry) => (
        <div
          key={entry.id}
          // A failure is its own live region, above the polite one it sits in: a
          // toast is how every action in this app reports that it did not
          // happen, and "polite" means a screen reader may hold it until the
          // reader has finished whatever they are doing — by which time the 8s
          // dismissal has taken it away.
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
            // 24px of glyph, 44px of target — the same transparent `::after`
            // trick `IconButton`'s `sm` size uses, and for the same reason: a
            // toast has to stay a thin strip over the composer, so the target
            // cannot be bought with layout. It matters more here than it looks:
            // this button sits over the composer, and a miss lands in the text
            // field of a message somebody is part-way through writing.
            className="tap relative -mt-0.5 -mr-1 flex h-6 w-6 items-center justify-center rounded-sm opacity-70 after:absolute after:-inset-2.5 after:content-[''] hover:opacity-100"
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
