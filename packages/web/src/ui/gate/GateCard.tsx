import type { ReactNode } from "react";
import { navigate } from "../../router";

// No screen draws the source notice: the §13 offer is in LICENSE, README and the OCI label (Q3.440); consent sits in `Register`'s form (Q3.598, Q3.599).

/** The box every pre-auth screen and `SignIn` sit in; `min-h-full` because these render outside the shell. */
export function GateCard({
  title,
  lead,
  children,
  footer,
}: {
  title: string;
  lead?: string;
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold">{title}</h1>
        {lead !== undefined && <p className="mt-1 text-sm text-muted">{lead}</p>}
        {children}
        {footer !== undefined && <div className="mt-5 border-t border-edge pt-4">{footer}</div>}
      </div>
    </div>
  );
}

/** Mirrors `APP_HANDOFF_PATH` on the control plane, which relaycheck compares; kept here so the app bundle never imports `Handoff.tsx`. */
export const HANDOFF_PATH = "/app";

export const HANDOFF_LABEL = "Where to get the app";

/** The one way off a gate screen, formerly `BackToSignIn`; always `replace`, so Back never returns to a spent link. */
export function ToHandoff(): ReactNode {
  return (
    <button
      type="button"
      onClick={() => navigate(HANDOFF_PATH, true)}
      className="tap text-xs text-muted hover:text-fg"
    >
      {HANDOFF_LABEL}
    </button>
  );
}
