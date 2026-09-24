import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./bits";

/** The single root boundary: a throw shows what happened and a way back instead of a blank page; reloading is safe since the daemon holds the state. */
export class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Logged so devtools gets the component stack; a boundary that catches silently is worse than none.
    console.error("render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="flex min-h-full items-center justify-center bg-surface p-6 text-fg">
        <div className="w-full max-w-sm">
          <h1 className="text-xl font-semibold">Something in this screen broke</h1>
          <p className="mt-1 text-sm text-muted wrap-anywhere">{error.message}</p>
          <p className="mt-3 text-sm text-muted">
            Nothing on the machine is affected — agents keep running, and reloading re-attaches to them.
          </p>
          {/* A new document rather than navigate: the caught error is never cleared, and Reload alone loops on a deterministic throw. */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button tone="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button tone="plain" onClick={() => window.location.assign("/")}>
              Go to sessions
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
