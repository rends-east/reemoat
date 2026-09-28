import { useState, type ReactNode } from "react";
import { CONTROL_PLANE_UNREACHABLE } from "../../account";
import { errorText } from "../../http";
import { store } from "../../store";
import type { Me } from "../../wire";
import { Empty, SETTINGS_HEADING, SwitchRow } from "../bits";

/** One switch for every machine you own; it outranks each machine's own, which is kept while this is off (Q2.244, Q3.675). */
export function PermissionsSection({ me }: { me: Me | null }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (me === null) return <Empty failed>{CONTROL_PLANE_UNREACHABLE}</Empty>;
  const held = me.permissions;
  if (held === undefined) return <Empty>This server can’t store it yet.</Empty>;

  const toggle = (): void => {
    setBusy(true);
    setError(null);
    void store
      .saveAccountMessaging(!held.agentMessaging)
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section>
      <h2 className={SETTINGS_HEADING}>Agents</h2>
      <div className="mt-3">
        <SwitchRow
          title="Agent messaging"
          subline="Agents in your sessions can message each other."
          on={held.agentMessaging}
          busy={busy}
          onToggle={toggle}
        />
      </div>
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
