import { useState, type ReactNode } from "react";
import { errorText } from "../../http";
import { store } from "../../store";
import type { Me } from "../../wire";
import { SwitchRow } from "../bits";
import { Group } from "../kit/List";

/**
 * One switch for every machine you own, at the head of Machines; it outranks and locks each machine's own switch
 * (Q2.244, Q3.675). A control plane that cannot store it draws nothing: no switch claims a state and no line explains.
 */
export function AccountMessaging({ me }: { me: Me | null }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const held = me?.permissions;
  if (held === undefined) return null;

  const toggle = (): void => {
    setBusy(true);
    setError(null);
    void store
      .saveAccountMessaging(!held.agentMessaging)
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <Group title="All machines" error={error}>
      <SwitchRow
        title="Agent messaging"
        subline="Agents in your sessions can message each other."
        on={held.agentMessaging}
        busy={busy}
        onToggle={toggle}
      />
    </Group>
  );
}
