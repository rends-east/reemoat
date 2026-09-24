import { Suspense, lazy, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { parseGateRoute } from "../../gate";
import type { InstanceConfig } from "../../instance";
import { usePathname } from "../../router";
import { legalPublishable, legalTitle, type LegalDoc } from "../../legal";
import { store } from "../../gateStore";
import { Button, Spinner } from "../bits";
import { Gate } from "./Gate";
import { GateCard, HANDOFF_LABEL, HANDOFF_PATH, ToHandoff } from "./GateCard";
import { Handoff } from "./Handoff";

// Routes by parseGateRoute, not router.ts's Route: a browser may reach only this closed list.

const LegalScreen = lazy(async () => ({ default: (await import("../legal/LegalScreen")).LegalScreen }));

export function GateApp(): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const route = parseGateRoute(usePathname());

  if (route.name === "legal") return <LegalRoute doc={route.doc} config={state.config} />;
  if (route.name === "gate") return <Gate screen={route.screen} state={state} />;
  return <Handoff config={state.config} />;
}

/** Waits for the instance config, but latches settled so a failed read offers a retry instead of a spinner for ever. */
function LegalRoute({ doc, config }: { doc: LegalDoc; config: InstanceConfig | null }): ReactNode {
  const [settled, setSettled] = useState(false);
  /** Bumped by Try again, and the only reason the probe below can run twice. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (config !== null) return;
    let live = true;
    // refreshConfig swallows its failure, so completion is observed rather than caught.
    void store.refreshConfig().then(() => {
      if (live) setSettled(true);
    });
    return () => {
      live = false;
    };
  }, [config, attempt]);

  if (config === null) {
    if (settled) {
      return (
        <GateCard
          title="Cannot show this document"
          lead="This control plane did not say which documents it publishes, so this page cannot tell whether this is one of them. It may be down, or it may be older than this screen."
          footer={<ToHandoff />}
        >
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
        </GateCard>
      );
    }
    return <Waiting doc={doc} />;
  }

  if (config.legal && legalPublishable()) {
    return (
      <Suspense fallback={<Waiting doc={doc} />}>
        <LegalScreen doc={doc} up={HANDOFF_PATH} signedIn={false} upLabel={HANDOFF_LABEL} />
      </Suspense>
    );
  }

  return (
    <Handoff
      config={config}
      title="No document at this address"
      lead={
        config.legal
          ? "This server claims its own legal documents but has not finished writing them, so there is nothing to show yet."
          : "This server publishes no legal documents, so this address names nothing on it."
      }
    />
  );
}

/** Always carries a footer: a card somebody can only wait on must say how to leave it. */
function Waiting({ doc }: { doc: LegalDoc }): ReactNode {
  return (
    <GateCard title={legalTitle(doc)} footer={<ToHandoff />}>
      <div className="mt-6 flex justify-center">
        <Spinner />
      </div>
    </GateCard>
  );
}
