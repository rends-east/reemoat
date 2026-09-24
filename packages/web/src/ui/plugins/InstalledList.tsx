import { ChevronRight, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { CATALOGUE_PATHS, isNewer, readCatalogue, type CatalogueEntry } from "../../catalogue";
import type { MachineId } from "../../ids";
import type { MachineState } from "../../machine";
import { marketEntryPath } from "../../market";
import type { DaemonClient } from "../../daemon";
import { installedSummary, type TargetOutcome } from "../../install";
import { peekPluginArchive, type ArchivePeek } from "../../pluginArchive";
import { consentBroken, ConsentBrokenError } from "../../plugins";
import { navigate } from "../../router";
import type { AppState } from "../../store";
import type { PluginSummary } from "../../wire";
import { Badge, Button, DangerButton, Empty, Icon, SETTINGS_HEADING, SETTINGS_SECTION } from "../bits";
import { PLUGIN_ARCHIVE_ACCEPT, PluginArchiveNote, PluginConsent, PluginUnreadable } from "../PluginConsent";
import { MachineInstalls } from "./MachineInstalls";
import { useCatalogue } from "./MarketList";

/** Plugins gathered across machines by plugin; configuration stays per machine, on the plugin's page. */
export function InstalledList({ state, base }: { state: AppState; base: string | null }): ReactNode {
  const read = useCatalogue(base, CATALOGUE_PATHS.list, readCatalogue);
  const catalogue = read?.kind === "ok" ? read.entries : [];

  const rows = gather(state);

  return (
    <div>
      {rows.length === 0 ? (
        <Empty>Nothing is installed on any of your machines yet.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <InstalledRow state={state} row={row} entry={catalogue.find((one) => one.id === row.id) ?? null} />
            </li>
          ))}
        </ul>
      )}

      <section className={rows.length === 0 ? "" : SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Import a plugin</h2>
        <ImportPlugin state={state} />
      </section>
    </div>
  );
}

interface Row {
  id: string;
  name: string;
  on: { machine: MachineState; plugin: PluginSummary }[];
}

/** Name order so the list does not reorder as machines come back; walks machines so an ungranted host is not drawn. */
function gather(state: AppState): Row[] {
  const byId = new Map<string, Row>();
  for (const machine of state.machines) {
    for (const plugin of state.pluginsByMachine.get(machine.id) ?? []) {
      const held = byId.get(plugin.id);
      if (held === undefined) byId.set(plugin.id, { id: plugin.id, name: plugin.name, on: [{ machine, plugin }] });
      else held.on.push({ machine, plugin });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function InstalledRow({ state, row, entry }: { state: AppState; row: Row; entry: CatalogueEntry | null }): ReactNode {
  const versions = [...new Set(row.on.map((one) => one.plugin.version))];
  const behind = entry !== null && versions.some((version) => isNewer(entry.version, version));

  return (
    <button
      onClick={() => navigate(marketEntryPath(row.id))}
      className="tap press flex w-full min-h-14 items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2.5 text-left hover:border-edge-strong"
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 truncate text-sm font-medium">{row.name}</span>
          <span className="shrink-0 text-xs text-muted">{versions.join(", ")}</span>
          {behind && entry !== null && <Badge tone="strong">{entry.version} available</Badge>}
        </span>
        <span className="block truncate text-2xs text-muted">{whereText(state, row)}</span>
      </span>
      <Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />
    </button>
  );
}

function whereText(state: AppState, row: Row): string {
  return installedSummary(
    state.machines.length,
    row.on.map((one) => one.machine.name),
  );
}

/** Nothing is sent before the archive is read and shown; each daemon parses it again, so consentBroken is checked per answer. */
function ImportPlugin({ state }: { state: AppState }): ReactNode {
  const input = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<
    { kind: "idle" } | { kind: "reading" } | { kind: "confirming"; file: File; peek: ArchivePeek }
  >({ kind: "idle" });
  // An unreadable archive needs its own DangerButton press, reset with each new file.
  const [unread, setUnread] = useState(false);
  const [sending, setSending] = useState(false);

  const shown = phase.kind === "confirming" && phase.peek.kind === "ok" ? phase.peek.manifest : null;
  const file = phase.kind === "confirming" ? phase.file : null;

  const install =
    file === null
      ? null
      : async (
          daemon: DaemonClient,
          machineId: MachineId,
          onProgress: (fraction: number) => void,
          signal: AbortSignal,
        ): Promise<TargetOutcome> => {
          // Use the caller's signal: MachineInstalls owns one controller per machine.
          const answer = await daemon.installPlugin(file, onProgress, signal);
          const broken = shown === null ? null : consentBroken(shown, answer.plugin);
          // Thrown so the row fails with its box unticked.
          if (broken !== null) throw new ConsentBrokenError(`${machineId}: ${broken}`);
          return answer.replaced === null
            ? { kind: "installed", version: answer.plugin.version, enabled: answer.plugin.enabled }
            : { kind: "updated", from: answer.replaced, to: answer.plugin.version, enabled: answer.plugin.enabled };
        };

  return (
    <div className="mt-2">
      <PluginArchiveNote />
      <input
        ref={input}
        type="file"
        accept={PLUGIN_ARCHIVE_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          // Cleared so choosing the same file again still fires change.
          event.target.value = "";
          if (chosen === undefined) return;
          setUnread(false);
          setPhase({ kind: "reading" });
          void peekPluginArchive(chosen).then((peek) => setPhase({ kind: "confirming", file: chosen, peek }));
        }}
      />

      {phase.kind === "confirming" && phase.peek.kind === "ok" && <PluginConsent manifest={phase.peek.manifest} />}
      {phase.kind === "confirming" && phase.peek.kind === "unreadable" && (
        <PluginUnreadable reason={phase.peek.reason} checker="Each machine">
          {!unread && (
            <DangerButton icon={Upload} className="mt-3" onClick={() => setUnread(true)}>
              Install without reading it
            </DangerButton>
          )}
        </PluginUnreadable>
      )}

      {phase.kind === "confirming" && (phase.peek.kind === "ok" || unread) && (
        <div className="mt-4">
          {/* pluginId is the archive's own id, so machines that already have it show ticked. */}
          {/* available is the archive's version; without it no row offers Update and only the destructive Remove is left. */}
          {/* No settings control: navigating away would unmount this and drop the chosen file. */}
          <MachineInstalls
            pluginId={shown?.id ?? ""}
            state={state}
            install={install}
            available={shown?.version ?? null}
            onBusyChange={setSending}
            heading="Install"
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {phase.kind !== "confirming" ? (
          <Button disabled={phase.kind === "reading"} onClick={() => input.current?.click()}>
            <Upload size={14} />
            {phase.kind === "reading" ? "Reading\u2026" : "Choose a file"}
          </Button>
        ) : (
          // Both disabled while the fan-out runs, or unmounting would drop every answer still in flight.
          <>
            <Button disabled={sending} onClick={() => input.current?.click()}>
              Choose another file
            </Button>
            <Button disabled={sending} onClick={() => setPhase({ kind: "idle" })}>
              Done
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
