import { useEffect, useState, type ReactNode } from "react";
import { LINK_DIRECTION_TEXT, linkNote, linkRows, type LinkRow } from "../../agentLinks";
import * as cp from "../../cp";
import { ApiError, errorText, meansRouteAbsent } from "../../http";
import { machineId as asMachineId, type MachineId } from "../../ids";
import { daemonRead, type MachineState } from "../../machine";
import { MACHINE_GONE } from "../../plugins";
import { store, type AppState } from "../../store";
import type { MachineLinkRecord, PeerLinkView } from "../../wire";
import { Button, Empty, NotReachable, SETTINGS_HEADING, SETTINGS_SECTION, SkeletonRow, Spinner, shortDuration } from "../bits";
import { toast } from "../Toast";

type Held =
  | { kind: "reading" }
  | { kind: "read"; links: PeerLinkView[] }
  | { kind: "too_old" }
  | { kind: "failed"; text: string };

/** The control plane's list, beside what this machine's daemon holds; owner only, like the route under it. */
export function MachineLinksSection({ state, machineId }: { state: AppState; machineId: MachineId }): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;
  if (machine === null) return <Empty>{MACHINE_GONE}</Empty>;
  if (!machine.owned) {
    return <p className="text-xs text-muted">Only whoever owns {machine.name} can see its agent links.</p>;
  }
  // Keyed so a revoke still in flight can never redraw another machine's list.
  return <LinksView key={machineId} machine={machine} />;
}

function LinksView({ machine }: { machine: MachineState }): ReactNode {
  const [links, setLinks] = useState<MachineLinkRecord[] | "failed" | "absent" | null>(null);
  const [held, setHeld] = useState<Held>({ kind: "reading" });
  const [revoking, setRevoking] = useState<string | null>(null);
  const readable = daemonRead(machine.reach) === "readable";

  // The control plane's own unrouted answer: a server older than links, which a retry would only ask again.
  const loadLinks = (): Promise<void> =>
    cp.machineLinks(machine.id).then(
      (rows) => setLinks(rows),
      (cause: unknown) => setLinks(ApiError.isApiError(cause) && cause.code === "not_found" ? "absent" : "failed"),
    );

  const loadHeld = (): Promise<void> => {
    const daemon = store.daemonFor(machine.id);
    if (!readable || daemon === undefined) return Promise.resolve();
    return daemon.peerLinks().then(
      (answer) => setHeld({ kind: "read", links: answer.links }),
      (cause: unknown) => setHeld(meansRouteAbsent(cause) ? { kind: "too_old" } : { kind: "failed", text: errorText(cause) }),
    );
  };

  useEffect(() => {
    void loadLinks();
  }, []);
  useEffect(() => {
    void loadHeld();
  }, [readable]);

  const status = store.linkStatus(machine.id);
  const tooOld = held.kind === "too_old" || status?.tooOld === true;
  const rows = Array.isArray(links) ? linkRows(links, machine.id) : [];

  // The source is re-synced even when it is the other machine, since its daemon holds the token just revoked.
  const revoke = (row: LinkRow): void => {
    setRevoking(row.id);
    void cp
      .revokeLink(row.id)
      .catch((cause: unknown) => {
        if (ApiError.isApiError(cause) && cause.code === "link_not_found") return;
        throw cause;
      })
      .then(() => store.resyncLinks(asMachineId(row.source)))
      .then(() => Promise.all([loadLinks(), loadHeld()]))
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setRevoking(null));
  };

  return (
    <div>
      <p className="text-xs text-muted">
        Agents on {machine.name} can message agents on the machines listed here. It lists your own machines on this
        server and nothing else: each one you own is linked to every other, both ways, and a machine somebody shared
        with you never is.
      </p>

      {tooOld && (
        <p role="status" className="mt-3 text-sm text-fg">
          {machine.name}’s daemon needs updating before its agents can reach other machines.
        </p>
      )}
      {!tooOld && links !== "absent" && status !== null && status.failure !== null && (
        <p className="mt-3 text-xs text-muted">
          {`Handing ${machine.name} its links failed ${shortDuration(Math.max(0, Date.now() - status.failure.at))} ago: ${status.failure.text}. This app tries again later.`}
        </p>
      )}

      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Links</h2>
        {links === null ? (
          <SkeletonRow />
        ) : links === "absent" ? (
          <Empty>This server is too old for agent links.</Empty>
        ) : links === "failed" ? (
          <Empty
            failed
            action={
              <Button size="sm" onClick={() => void loadLinks()}>
                Try again
              </Button>
            }
          >
            Could not read this machine’s links.
          </Empty>
        ) : rows.length === 0 ? (
          <Empty>No links yet. Once you have another machine enrolled on this server, the two are linked the next time this app opens.</Empty>
        ) : (
          <LinkTable>
            {rows.map((row) => (
              <LinkTableRow
                key={row.id}
                row={row}
                note={linkNote(row, held.kind === "read" ? held.links : null, machine.name)}
                machineName={machine.name}
                busy={revoking === row.id}
                disabled={revoking !== null}
                onRevoke={() => revoke(row)}
              />
            ))}
          </LinkTable>
        )}

        {rows.length > 0 && (
          <>
            {!readable ? (
              <p className="mt-2 text-xs text-muted">
                <NotReachable machine={machine} tail=", so what it last hit using each link is not shown." />
              </p>
            ) : (
              held.kind === "failed" && (
                <p className="mt-2 text-xs text-muted">{`What ${machine.name} holds could not be read: ${held.text}.`}</p>
              )
            )}
            <p className="mt-3 text-xs text-muted">
              Replace ends a link and its token at once, and this app then hands the machine a new one: it answers a
              token that got out. Retiring a machine is what takes it off this list.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

/** Direction first, so a row reads as the sentence it is: this machine can message that one. */
function LinkTable({ children }: { children: ReactNode }): ReactNode {
  return (
    <table className="mt-2 w-full text-sm">
      <thead>
        <tr className={`text-left ${SETTINGS_HEADING}`}>
          <th className="py-1.5 pr-3 font-semibold">Direction</th>
          <th className="py-1.5 pr-3 font-semibold">Machine</th>
          <th className="py-1.5">
            <span className="sr-only">Action</span>
          </th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function LinkTableRow({
  row,
  note,
  machineName,
  busy,
  disabled,
  onRevoke,
}: {
  row: LinkRow;
  note: { text: string; failed: boolean } | null;
  machineName: string;
  busy: boolean;
  disabled: boolean;
  onRevoke: () => void;
}): ReactNode {
  const said = LINK_DIRECTION_TEXT[row.direction];
  return (
    <tr className="h-12 border-t border-edge/60 align-middle">
      <td className="pr-3 text-xs whitespace-nowrap text-muted">{said}</td>
      <td className="py-2 pr-3">
        <span className="block break-words">{row.other.name}</span>
        {note !== null && (
          <span className={`mt-0.5 block text-2xs break-words ${note.failed ? "text-danger" : "text-muted"}`}>
            {note.text}
          </span>
        )}
      </td>
      <td className="text-right">
        <Button size="sm" disabled={disabled} onClick={onRevoke} ariaLabel={`Replace: ${machineName} ${said} ${row.other.name}`}>
          {busy ? <Spinner /> : "Replace"}
        </Button>
      </td>
    </tr>
  );
}
