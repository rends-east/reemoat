import type { ReactNode } from "react";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import { Button, Icon, Spinner } from "../bits";

/** A standing state that is not an error line under a field: delivery trouble, mixed values, a plugin that stopped. */
export function Notice({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }): ReactNode {
  return (
    <div
      role={tone === "warn" ? "status" : undefined}
      className="flex items-start gap-2 rounded-lg border border-edge-strong px-3 py-2 text-sm text-fg"
    >
      <span className="inline-flex h-[var(--text-sm--line-height)] shrink-0 items-center text-muted">
        <Icon as={tone === "warn" ? AlertTriangle : Info} size={14} />
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** Waiting on something that will answer: one line, the state said in words, never a bare spinner. */
export function Pending({ children }: { children: ReactNode }): ReactNode {
  return (
    <p role="status" className="flex items-center gap-2 py-3 text-sm text-muted">
      <Spinner />
      {children}
    </p>
  );
}

/** Ask the machine again. One look for every "Check again", which had five. */
export function RecheckButton({
  onClick,
  busy = false,
  disabled = false,
}: {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
}): ReactNode {
  return (
    <Button size="sm" tone="ghost" onClick={onClick} disabled={busy || disabled}>
      {busy ? <Spinner /> : <Icon as={RefreshCw} size={13} />}
      Check again
    </Button>
  );
}
