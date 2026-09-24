import { ChevronRight, Puzzle, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CATALOGUE_PATHS, catalogueNotice, fetchCatalogue, readCatalogue, type CatalogueEntry, type CatalogueRead } from "../../catalogue";
import { installedSummary } from "../../install";
import { navigate } from "../../router";
import { groupCatalogue, marketEntryPath } from "../../market";
import type { AppState } from "../../store";
import { Badge, Button, Empty, Icon, SEARCH_FIELD, SETTINGS_HEADING, Spinner } from "../bits";

/** Nothing is drawn until the catalogue answers, and never partially: readCatalogue fails closed. */
export function MarketList({ state, base }: { state: AppState; base: string }): ReactNode {
  const [attempt, setAttempt] = useState(0);
  const read = useCatalogue(base, CATALOGUE_PATHS.list, readCatalogue, attempt);

  if (read === null) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  const notice = catalogueNotice(read);
  if (read.kind !== "ok" || read.entries.length === 0) {
    // A failed read gets a retry; too_new is a settled answer, and retrying would refetch the same refusal.
    const failed = read.kind === "unreachable" || read.kind === "malformed";
    return (
      <Empty
        failed={failed}
        action={failed ? <Button onClick={() => setAttempt((one) => one + 1)}>Try again</Button> : undefined}
      >
        {notice}
      </Empty>
    );
  }
  return <Found entries={read.entries} state={state} />;
}

/** Its own component so a catalogue refresh does not remount the search box and drop the query. */
function Found({ entries, state }: { entries: readonly CatalogueEntry[]; state: AppState }): ReactNode {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupCatalogue(entries, query), [entries, query]);
  const found = groups.reduce((sum, group) => sum + group.entries.length, 0);

  return (
    <div>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-faint">
          <Icon as={Search} size={13} />
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search plugins"
          placeholder="Search plugins"
          className={SEARCH_FIELD}
        />
      </div>

      {found === 0 ? (
        // Real quotation marks, never JSON.stringify, which escapes quotes in the query.
        <Empty>{`Nothing here is called \u201c${query.trim()}\u201d.`}</Empty>
      ) : (
        groups.map((group) => (
          <section key={group.name} className="mt-4 first:mt-3">
            {groups.length > 1 && (
              <h2 className={`${SETTINGS_HEADING} mb-1.5`}>
                {group.name} <span className="font-normal normal-case">· {group.entries.length}</span>
              </h2>
            )}
            <ul className="flex flex-col gap-2">
              {group.entries.map((entry) => (
                <li key={entry.id}>
                  <MarketRow entry={entry} state={state} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function MarketRow({ entry, state }: { entry: CatalogueEntry; state: AppState }): ReactNode {
  const on = state.machines.filter((machine) =>
    (state.pluginsByMachine.get(machine.id) ?? []).some((plugin) => plugin.id === entry.id),
  );

  return (
    <button
      onClick={() => navigate(marketEntryPath(entry.id))}
      className="tap press flex w-full min-h-14 items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2.5 text-left hover:border-edge-strong"
    >
      <MarketIcon icon={entry.source.icon} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 truncate text-sm font-medium">{entry.name}</span>
          <span className="shrink-0 text-xs text-muted">{entry.version}</span>
          {on.length > 0 && <Badge>{installedSummary(state.machines.length, on.map((one) => one.name))}</Badge>}
        </span>
        {entry.description !== null && (
          <span className="block truncate text-2xs text-muted">{entry.description}</span>
        )}
      </span>
      <Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />
    </button>
  );
}

/** Only ever an img, never inserted markup: an SVG loaded as an image runs no script on the credential's origin. */
export function MarketIcon({ icon, size = 32 }: { icon: string | null; size?: number }): ReactNode {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size };
  if (icon === null || broken) {
    return (
      <span
        aria-hidden="true"
        style={box}
        className="inline-flex shrink-0 items-center justify-center rounded-md bg-raised text-muted"
      >
        <Icon as={Puzzle} size={Math.round(size / 2)} />
      </span>
    );
  }
  return (
    <img
      src={icon}
      alt=""
      width={size}
      height={size}
      style={box}
      onError={() => setBroken(true)}
      className="shrink-0 rounded-md"
    />
  );
}

/** One catalogue read, or null in flight; a late-write gate keeps an earlier address's answer off screen. */
export function useCatalogue(
  base: string | null,
  path: string,
  read: (raw: unknown) => CatalogueRead,
  /** Bump to ask again; the retry goes through the effect's one late-write gate. */
  attempt = 0,
): CatalogueRead | null {
  const [answer, setAnswer] = useState<CatalogueRead | null>(null);
  useEffect(() => {
    let live = true;
    setAnswer(null);
    // No catalogue is not a failed read, so nothing is fetched.
    if (base === null || base.length === 0 || path.length === 0) return;
    void fetchCatalogue(base, path, read).then((result) => {
      if (live) setAnswer(result);
    });
    return () => {
      live = false;
    };
    // read is a module-level function at every call site, so it is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, path, attempt]);
  return answer;
}
