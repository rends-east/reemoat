import { useSyncExternalStore, type ReactNode } from "react";
import type { InstanceConfig } from "../../instance";
import { navigate } from "../../router";
import { store } from "../../store";

/**
 * Where this instance's source is — the AGPL §13 offer, on screen.
 *
 * **Drawn on the signed-out screen because that is where the people it is owed
 * to are.** Section 13 is about anybody who interacts with the program over a
 * network, and somebody looking at a sign-in form has already done so. Putting
 * the offer behind the sign-in would exclude exactly the users who most need it:
 * the ones a modified instance never lets in.
 *
 * **The URL comes from the control plane, never from this bundle.** A fork's
 * instance has to offer *its own* source, so hardcoding this project's
 * repository here would make every fork silently non-compliant while looking
 * answered. `null` — an older control plane, or one that did not say — draws
 * nothing at all, for the same reason: no offer is honest, and a wrong one is
 * not.
 *
 * Deliberately plain and quiet. This is a licence notice, not a footer ad.
 */
export function SourceNotice({ source }: { source: InstanceConfig["source"] }): ReactNode {
  if (source === null) return null;
  return (
    <p className="mt-8 text-xs text-faint">
      <a href={source.url} target="_blank" rel="noreferrer noopener" className="tap underline hover:text-muted">
        Source
      </a>
      {source.version !== null && ` · ${source.version}`} · AGPL-3.0
    </p>
  );
}

/**
 * The box every pre-auth screen sits in, and `SignIn`'s box too.
 *
 * Six screens, one layout. `SignIn` adopts it in the same change that adds the
 * other five, because six independent copies of `flex min-h-full items-center
 * justify-center` around a `max-w-sm` is exactly the drift `FIELD` exists to
 * close, one level up.
 *
 * Sized against `html, body, #root { height: 100% }` with `min-h-full` rather
 * than `AppShell`'s `h-dvh`: these render **outside** the shell, which is what
 * the loading screen already does and for the same reason — there is no rail, no
 * header and nothing to lay out beside.
 */
export function GateCard({
  title,
  lead,
  children,
  footer,
}: {
  title: string;
  lead?: string;
  children: ReactNode;
  /** Usually the way back. Kept out of `children` so every screen has one place for it. */
  footer?: ReactNode;
}): ReactNode {
  /*
   * ⚠ **The §13 offer is drawn here, by the box, rather than by each screen.** It
   * was mounted on `SignIn` alone — one of six pre-auth screens — so /register,
   * /forgot, /reset, /verify and /confirm made no offer at all, against a docblock
   * one function up saying the clause is about anybody who interacts with the
   * program over a network. Somebody who followed a mailed reset link and never
   * reached the sign-in form is exactly such a person.
   *
   * Read off the store rather than taken as a prop, and that is the point: a prop
   * is six call sites that can each forget, which is the drift this component
   * exists to close. `SignIn` keeps its own mount because it does **not** use this
   * box — it has its own, for the two-field form.
   */
  const config = useSyncExternalStore(store.subscribe, store.getSnapshot).config;
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold">{title}</h1>
        {lead !== undefined && <p className="mt-1 text-sm text-muted">{lead}</p>}
        {children}
        {footer !== undefined && <div className="mt-5 border-t border-edge pt-4">{footer}</div>}
        <SourceNotice source={config?.source ?? null} />
      </div>
    </div>
  );
}

/**
 * Back to the sign-in screen.
 *
 * **`replace`, always**, and it is the rule rather than a preference on this one
 * control: the entry being replaced is the one holding a token in its fragment,
 * so overwriting it is what stops Back returning to a spent link. Every
 * navigation out of a gate screen does this, and `webcheck` reads these files to
 * assert that none of them forgets.
 */
export function BackToSignIn({ children = "Back to sign in" }: { children?: ReactNode }): ReactNode {
  return (
    <button type="button" onClick={() => navigate("/", true)} className="tap text-xs text-muted hover:text-fg">
      {children}
    </button>
  );
}
