import { Download, ExternalLink } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  CATALOGUE_PATHS,
  CATALOGUE_TIMEOUT_MS,
  catalogueNotice,
  previewOf,
  readOne,
  readVersions,
  type CatalogueEntry,
} from "../../catalogue";
import type { TargetOutcome } from "../../install";
import { readManifestText, type ManifestPreview } from "../../pluginArchive";
import { consentBroken, ConsentBrokenError } from "../../plugins";
import { marketSettingsPath } from "../../market";
import { navigate } from "../../router";
import type { AppState } from "../../store";
import { DangerButton, Disclosure, Empty, Icon, SETTINGS_HEADING, SETTINGS_SECTION, Spinner } from "../bits";
import { ConsentDoubt, PluginConsent } from "../PluginConsent";
import { MachineInstalls, type InstallAct } from "./MachineInstalls";
import { useCatalogue } from "./MarketList";

/** Everything drawn is derived from the pinned plugin.json or links to it; the catalogue carries no free text. */
export function MarketEntry({
  state,
  base,
  entryId,
  onIdentified,
}: {
  state: AppState;
  /** The catalogue's address, or null on an instance with none, where Offline still renders. */
  base: string | null;
  entryId: string;
  /** Hands the name to the sheet's head, which draws it; carries the id so a stale name can be refused. */
  onIdentified: (identity: { id: string; name: string; version: string; icon: string | null }) => void;
}): ReactNode {
  const read = useCatalogue(base, CATALOGUE_PATHS.get(entryId), readOne);

  // No catalogue is not a failed read: go straight to Offline with no notice.
  if (base === null) {
    return <Offline state={state} pluginId={entryId} notice={null} onIdentified={onIdentified} />;
  }

  if (read === null) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  const entry = read.kind === "ok" ? (read.entries[0] ?? null) : null;
  if (entry === null) {
    // The Installed tab links here, so a plugin the catalogue lacks still gets a page.
    return <Offline state={state} pluginId={entryId} notice={catalogueNotice(read)} onIdentified={onIdentified} />;
  }
  // Keyed on the id so moving between plugins drops the chosen machines.
  return <Entry key={entry.id} state={state} base={base} entry={entry} onIdentified={onIdentified} />;
}

function Entry({
  state,
  base,
  entry,
  onIdentified,
}: {
  state: AppState;
  base: string;
  entry: CatalogueEntry;
  onIdentified: (identity: { id: string; name: string; version: string; icon: string | null }) => void;
}): ReactNode {
  const consent = usePinnedManifest(entry);
  /** The commit an unpinned install was accepted for, so a new commit re-gates it. */
  const [unpinnedAt, setUnpinnedAt] = useState<string | null>(null);

  // Depends on the fields, not entry, so an equal re-read does not set state on every poll.
  useEffect(() => {
    onIdentified({ id: entry.id, name: entry.name, version: entry.version, icon: entry.source.icon });
  }, [onIdentified, entry.id, entry.name, entry.version, entry.source.icon]);

  // The manifest at the pinned commit when readable; the catalogue's summary only as a gated fallback.
  const shown: ManifestPreview = consent.kind === "ok" ? consent.manifest : previewOf(entry);

  /** Whether the machine table may be drawn: never while the pinned read is in flight. */
  const canAct =
    consent.kind === "ok" || (consent.kind === "unreadable" && unpinnedAt === entry.source.commit);

  // Takes all four parameters: dropping signal still compiles but makes Cancel abort nothing.
  const install: InstallAct = async (daemon, machineId, _onProgress, signal): Promise<TargetOutcome> => {
    const answer = await daemon.installPluginFromSource(
      { kind: "github", repo: entry.source.repo, commit: entry.source.commit },
      { scopes: shown.scopes, net: shown.net, hooks: shown.hooks, adds: shown.adds },
      signal,
    );
    // Checked per machine against what this screen drew, on top of the daemon's own check.
    const broken = consentBroken(shown, answer.plugin);
    // Thrown as ConsentBrokenError so the row fails unticked and pluginFailure keeps the sentence.
    if (broken !== null) throw new ConsentBrokenError(`${machineId}: ${broken}`);
    return answer.replaced === null
      ? { kind: "installed", version: answer.plugin.version, enabled: answer.plugin.enabled }
      : { kind: "updated", from: answer.replaced, to: answer.plugin.version, enabled: answer.plugin.enabled };
  };

  return (
    <div>
      {entry.description !== null && <p className="text-sm text-fg">{entry.description}</p>}
      <p className="mt-1.5 text-2xs text-muted">
        {[
          entry.author,
          entry.license,
          entry.categories.length > 0 ? entry.categories.join(", ") : null,
          publishedText(entry.publishedAt),
        ]
          .filter((part): part is string => part !== null && part.length > 0)
          .join(" · ")}
      </p>

      <div className="mt-3 flex flex-col gap-1.5">
        <SourceLink
          href={entry.source.browse}
          title={entry.source.repo}
          subline={`the tree at ${shortCommit(entry.source.commit)}`}
        />
        <SourceLink href={entry.source.manifest} title="plugin.json" subline="what it declares, at that commit" />
      </div>

      {consent.kind === "reading" && (
        <ConsentDoubt title="Checking what it declares">
          <p className="mt-1 text-xs text-muted">
            Reading <code className="text-muted/80">plugin.json</code> at{" "}
            <code className="text-muted/80">{shortCommit(entry.source.commit)}</code>. Until that lands, what follows is
            the catalogue&rsquo;s own summary and nothing can be installed.
          </p>
        </ConsentDoubt>
      )}

      {consent.kind === "unreadable" && (
        <ConsentDoubt title="The pinned manifest could not be read here">
          <p className="mt-1 text-xs text-muted">
            {entry.source.manifestRaw} could not be read from here ({consent.reason}), so what follows is the
            catalogue&rsquo;s own summary rather than the manifest at that commit. The machine checks the real one on
            arrival and refuses anything more than this.
          </p>
          {unpinnedAt !== entry.source.commit && (
            <DangerButton icon={Download} className="mt-3" onClick={() => setUnpinnedAt(entry.source.commit)}>
              Install without checking the pin
            </DangerButton>
          )}
        </ConsentDoubt>
      )}
      <PluginConsent manifest={shown} names={false} />

      {canAct && (
        <section className={SETTINGS_SECTION}>
          <MachineInstalls
            pluginId={entry.id}
            state={state}
            install={install}
            available={entry.version}
            heading={INSTALL_HEADING}
            onConfigure={(machines) => navigate(marketSettingsPath(entry.id, machines))}
          />
        </section>
      )}

      {consent.kind === "reading" && (
        <section className={SETTINGS_SECTION}>
          <h2 className={SETTINGS_HEADING}>{INSTALL_HEADING}</h2>
          <Empty>{`Nothing can be installed until plugin.json at ${shortCommit(entry.source.commit)} has been read.`}</Empty>
        </section>
      )}

      <Versions base={base} entry={entry} />
    </div>
  );
}

const INSTALL_HEADING = "Settings and installation";

/** Twelve characters everywhere a commit is shown, so one pin never reads as two. */
function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

function SourceLink({ href, title, subline }: { href: string; title: string; subline: string }): ReactNode {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="tap press flex min-h-11 items-center gap-2.5 rounded-lg border border-edge-strong bg-surface px-3 hover:bg-raised"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-fg">{title}</span>
        <span className="block truncate text-2xs text-muted">{subline}</span>
      </span>
      <Icon as={ExternalLink} size={14} className="text-faint" />
    </a>
  );
}

function publishedText(iso: string): string | null {
  if (iso.length === 0) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? `published ${new Date(at).toLocaleDateString()}` : null;
}

function Versions({ base, entry }: { base: string; entry: CatalogueEntry }): ReactNode {
  const read = useCatalogue(base, CATALOGUE_PATHS.versions(entry.id), readVersions);
  const older = read?.kind === "ok" ? read.entries.filter((one) => one.version !== entry.version) : [];
  if (older.length === 0) return null;
  return (
    <section className={SETTINGS_SECTION}>
      <Disclosure first label={<span className={SETTINGS_HEADING}>Earlier versions ({older.length})</span>}>
        <ul className="mt-2 flex flex-col gap-1.5">
          {older.map((one) => (
            <li key={one.source.commit}>
              <SourceLink
                href={one.source.browse}
                title={one.version}
                subline={[shortCommit(one.source.commit), publishedText(one.publishedAt)]
                  .filter((part): part is string => part !== null)
                  .join(" · ")}
              />
            </li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}

/** Uses the file picker's reader so both consent screens draw the same sentences. */
function usePinnedManifest(entry: CatalogueEntry): { kind: "reading" } | ReturnType<typeof readManifestText> {
  const [state, setState] = useState<{ kind: "reading" } | ReturnType<typeof readManifestText>>({ kind: "reading" });
  useEffect(() => {
    let live = true;
    setState({ kind: "reading" });
    void fetch(entry.source.manifestRaw, { signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
        return await response.text();
      })
      .then((text) => {
        if (live) setState(readManifestText(text));
      })
      .catch((cause: unknown) => {
        if (live) setState({ kind: "unreadable", reason: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      live = false;
    };
  }, [entry.source.manifestRaw]);
  return state;
}

/** Not an error page: catalogueNotice is drawn only when the read actually failed. */
function Offline({
  state,
  pluginId,
  notice,
  onIdentified,
}: {
  state: AppState;
  pluginId: string;
  notice: string | null;
  onIdentified: (identity: { id: string; name: string; version: string; icon: string | null }) => void;
}): ReactNode {
  const on = [...state.pluginsByMachine.values()].flatMap((plugins) => plugins.filter((one) => one.id === pluginId));
  const first = on[0] ?? null;
  const name = first?.name ?? pluginId;
  const version = [...new Set(on.map((one) => one.version))].join(", ");

  useEffect(() => {
    onIdentified({ id: pluginId, name, version, icon: null });
  }, [onIdentified, pluginId, name, version]);

  if (first === null) {
    return <Empty>{notice ?? "That plugin is not in the catalogue and is not on any of your machines."}</Empty>;
  }

  return (
    <div>
      {first.description !== null && <p className="text-sm text-fg">{first.description}</p>}
      <p className="mt-1.5 text-2xs text-muted">
        This plugin did not come from the market{notice === null ? "" : ` — ${notice}`}, so there is nothing here to
        install it from. It can still be removed.
      </p>

      <section className={SETTINGS_SECTION}>
        <MachineInstalls
          pluginId={pluginId}
          state={state}
          install={null}
          heading="Where it is"
          onConfigure={(machines) => navigate(marketSettingsPath(pluginId, machines))}
        />
      </section>
    </div>
  );
}
