import { useEffect, useState, type ReactNode } from "react";
import type { InstanceConfig } from "../../instance";
import { store } from "../../gateStore";
import { Button, LINK, Spinner } from "../bits";
import { GateCard } from "./GateCard";

/** Where every gate flow ends. Never claims a download exists, and tells an unanswered read from a server with no build. */
export function Handoff({
  config,
  title = "Reemoat runs in its own app",
  lead,
  children,
}: {
  config: InstanceConfig | null;
  title?: string;
  lead?: string;
  children?: ReactNode;
}): ReactNode {
  const [settled, setSettled] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (config !== null) return;
    let live = true;
    // `refreshConfig` swallows failures, so observe the attempt ending rather than catching.
    void store.refreshConfig().then(() => {
      if (live) setSettled(true);
    });
    return () => {
      live = false;
    };
  }, [config, attempt]);

  // A null config has not answered; only an answered null means no published build.
  const download = config === null ? null : config.appDownload;

  return (
    <GateCard title={title} lead={lead ?? "Everything else happens there: your machines, your agents, your sessions."}>
      {children}
      {config === null ? (
        settled ? (
          <>
            <p className="mt-4 text-sm text-muted">
              This server could not be asked whether it publishes a build. It may be down, or it may be older than this
              screen.
            </p>
            <Button
              tone="primary"
              className="mt-4 w-full"
              onClick={() => {
                setSettled(false);
                setAttempt((previous) => previous + 1);
              }}
            >
              Try again
            </Button>
          </>
        ) : (
          <div className="mt-6 flex justify-center">
            <Spinner />
          </div>
        )
      ) : download === null ? (
        <p className="mt-4 text-sm text-muted">
          This server does not publish a build. You can build the app from source — see{" "}
          <a className={LINK} href="https://github.com/rends-east/reemoat/blob/main/docs/NATIVE.md">
            docs/NATIVE.md
          </a>{" "}
          — or ask whoever runs this server where to get it.
        </p>
      ) : (
        <>
          {/* The anchor is the button: nesting one doubles the tab stop, and an anchor keeps middle-click and the native link interceptor. */}
          <a
            href={download}
            rel="noreferrer"
            className="tap press mt-4 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-fg px-3 text-sm font-medium text-ink hover:bg-fg/85"
          >
            Download Reemoat
          </a>
          <p className="mt-2 text-xs text-muted">Then sign in there with the account you just used.</p>
        </>
      )}
    </GateCard>
  );
}
