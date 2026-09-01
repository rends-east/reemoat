import { ChevronRight, Puzzle, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CATALOGUE_PATHS, catalogueNotice, fetchCatalogue, readCatalogue, type CatalogueEntry, type CatalogueRead } from "../../catalogue";
import { installedSummary } from "../../install";
import { navigate } from "../../router";
import { groupCatalogue, marketEntryPath } from "../../market";
import type { AppState } from "../../store";
import { Badge, Button, Empty, Icon, SEARCH_FIELD, SETTINGS_HEADING, Spinner } from "../bits";

/**
 * The official plugins, as a list.
 *
 * ⚠ **Nothing here is drawn before the catalogue has answered**, and nothing is
 * drawn *partially*. `readCatalogue` fails closed — the one reader in this client
 * that does — because every row on this screen is a claim about what a plugin may
 * do on somebody's machine, and four of five scopes is worse than none: the
 * person cannot tell which they are looking at. The four states it can answer are
 * all drawn, each with its own sentence, by `catalogueNotice`.
 */
export function MarketList({ state, base }: { state: AppState; base: string }): ReactNode {
  /*
   * ⚠ **A counter rather than a `refetch()` handed back by the hook, because the
   * effect already owns the read.** {@link useCatalogue} holds a late-write gate
   * over exactly one in-flight request; a second entry point would need its own,
   * and two of them is how an answer for the previous attempt lands under the
   * current one. Bumping a dependency re-runs the effect the hook already has,
   * with the gate it already has.
   */
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
    /*
     * ⚠ **A catalogue that did not come back is not an empty one, and this drew
     * them identically.** Both were a grey centred sentence — and because `Found`
     * is what mounts the search box, a failed read took the *only control on the
     * tab* with it: the Market tab became one grey line with nothing on it to
     * press, on a state that is very often a phone that dropped to LTE for a
     * second. `Empty`'s failure variant is the partition said out loud — the
     * triangle, `text-fg`, and a live region — and the retry is the control that
     * came back.
     *
     * ⚠ **`too_new` is not one of them.** An answer *did* come back and this build
     * refused to read it; pressing Try again fetches the same document and refuses
     * it again, which is a button that does nothing about a sentence that already
     * names the remedy (somebody deploys the control plane). The partition
     * `Empty` documents is absence against failure, and a settled refusal is an
     * answer.
     */
    const failed = read.kind === "unreachable" || read.kind === "malformed";
    return (
      <Empty
        failed={failed}
        /* Default `md`, not `sm`: `BUTTON_SIZE` reserves the short one for a
           confirmation that has replaced the controls on a row and therefore has
           nothing adjacent to mis-hit. This is the only control on the tab. */
        action={failed ? <Button onClick={() => setAttempt((one) => one + 1)}>Try again</Button> : undefined}
      >
        {notice}
      </Empty>
    );
  }
  return <Found entries={read.entries} state={state} />;
}

/**
 * The catalogue, searchable and grouped.
 *
 * ⚠ **Its own component so the search box is mounted once, under the read.** With
 * the field inside `MarketList` every catalogue refresh would remount it and drop
 * what somebody had typed — and the read *does* refresh, because `useCatalogue`
 * re-runs on the address. Under the read there is nothing above it that changes.
 */
function Found({ entries, state }: { entries: readonly CatalogueEntry[]; state: AppState }): ReactNode {
  /*
   * ⚠ **Local state, deliberately unlike the rail's search**, which lives in a
   * module so it survives the phone's list → detail → back. This one is a way
   * through a list somebody is standing in front of; carrying it into the next
   * visit would mean opening the market and finding it already filtered by a word
   * typed last week, with the box the only thing saying why.
   */
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
          /* The shared string, not a copy of it. This box and `MachineInstalls`'s
             are one tap apart on adjacent screens, and the copy that was here was
             already byte-identical — so it was not a variant, it was a second
             chance to be wrong the next time `FIELD`'s padding rule is applied. */
          className={SEARCH_FIELD}
        />
      </div>

      {found === 0 ? (
        /*
         * Says what was searched rather than "no results": on a catalogue of a
         * handful, the useful answer is that this word matched none of them.
         *
         * ⚠ **Real quotation marks, never `JSON.stringify`.** `install.ts` names
         * this as the defect it declined to copy into `noRowsText` one screen over:
         * a serialiser is right by accident for every ordinary query and shows
         * somebody their own input escaped the moment it holds a quote or a
         * backslash. The two sentences now quote the same way.
         */
        <Empty>{`Nothing here is called \u201c${query.trim()}\u201d.`}</Empty>
      ) : (
        groups.map((group) => (
          <section key={group.name} className="mt-4 first:mt-3">
            {/*
             * ⚠ **Drawn only where there is more than one group.** A category
             * heading over the whole list names nothing — it is a label for
             * "everything" — and a catalogue of one plugin under a heading reads
             * as a section somebody forgot to fill.
             */}
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

/**
 * One plugin, as a link to the whole of it.
 *
 * The settings-row class string this app uses everywhere a row opens something,
 * and a plain `<button>` for `MachineRow`'s second reason as much as its first: a
 * `<button>` may hold no interactive descendant, so nothing can ever be mounted
 * into this row later. Everything a person can *do* to a plugin is one level in,
 * beside the permissions they have to read first.
 */
function MarketRow({ entry, state }: { entry: CatalogueEntry; state: AppState }): ReactNode {
  /*
   * Where it already is, read here rather than fetched: the store already holds
   * every machine's plugin list for the rail's launcher, so this is a read of
   * something on screen elsewhere rather than a second source.
   *
   * ⚠ **`state.machines` is walked rather than the map's keys**, `gather`'s reason
   * one file over: a plugin sitting on a machine that has dropped out of the grant
   * list would otherwise be counted under a host this client has no name for.
   */
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
        {/*
         * ⚠ **`flex-wrap`, which is `InstalledRow`'s shape and is what gives the
         * name priority.** The name was the only child with `min-w-0`, so it was
         * the only thing that could yield — a flex item's `min-width` is `auto`
         * otherwise — and at 390px the plugin's identity truncated to keep a badge
         * about where it is installed. Wrapping puts the name on the line at its
         * own width and pushes the version and the badge to the next one, so the
         * thing being identified is the thing that survives.
         */}
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 truncate text-sm font-medium">{entry.name}</span>
          <span className="shrink-0 text-xs text-muted">{entry.version}</span>
          {/*
           * ⚠ **`installedSummary`, and it is the same symbol `InstalledRow` calls
           * for the same fact.** This row spelled it `on 1 of 3` while a row one tab
           * over said `on laptop` — and `InstalledList`'s own docblock claims the
           * shared symbol exists precisely so two sentences for one fact cannot
           * happen. It was true only because this caller had never been wired up.
           * Names answer the question somebody actually has; a count makes them open
           * the list to find out which.
           *
           * ⚠ **`plain` rather than `strong`.** Where a plugin already is, is a
           * standing state; the strong tone is for news, which is what
           * `InstalledRow` spends it on ("0.4.0 available"). At `strong` this was
           * the boldest thing on a row whose subject is the plugin's name.
           */}
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

/**
 * A plugin's icon, or the glyph that stands in for one.
 *
 * ⚠ **Only ever `<img src>`, never markup put into the DOM.** An SVG loaded as an
 * *image* executes no script; the identical bytes inserted as same-origin markup
 * do. The catalogue refuses scripts, handlers and external references at publish
 * — but that is a second lock covering only what that catalogue published, and
 * this is the origin holding `reemoat.credential`.
 *
 * `icon: null` is a common answer rather than an edge — most plugins ship no
 * `icon.svg` — so the fallback is the ordinary case and is drawn as such rather
 * than as an absence. `onError` covers the other half: a commit whose icon has
 * been deleted since publish, which no amount of validation at publish can catch.
 */
export function MarketIcon({ icon, size = 32 }: { icon: string | null; size?: number }): ReactNode {
  const [broken, setBroken] = useState(false);
  /*
   * ⚠ **The box is a style so the two callers cannot drift**, and `size` is a
   * number rather than a class because it is also the `<img>`'s own attribute — an
   * intrinsic size is what stops the row reflowing when the bytes land.
   */
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

/**
 * One read of the catalogue, or `null` while it is in flight.
 *
 * A late-write gate on the effect rather than a cancel, `PluginScreen`'s shape:
 * nothing here can be aborted usefully — the browser's own cache is what makes a
 * second read cheap — and what matters is that an answer for the previous address
 * is not drawn under the current one.
 */
export function useCatalogue(
  base: string | null,
  path: string,
  read: (raw: unknown) => CatalogueRead,
  /**
   * Bump this to ask again.
   *
   * ⚠ **A dependency rather than a `refetch` handed back**, so a retry goes
   * through the one effect that already holds the late-write gate. A second entry
   * point would need a gate of its own, and two of them is exactly how an answer
   * for the previous attempt gets drawn under the current one — the failure this
   * hook exists to prevent, reintroduced by the control added to recover from it.
   *
   * Defaults to `0`, so the three callers that never retry are unchanged.
   */
  attempt = 0,
): CatalogueRead | null {
  const [answer, setAnswer] = useState<CatalogueRead | null>(null);
  useEffect(() => {
    let live = true;
    setAnswer(null);
    /*
     * ⚠ **No catalogue is not a failed read, and this arm is why the hook takes a
     * nullable base at all.** An instance with no market still has an Installed
     * tab, and that tab asks for the catalogue only so a row can say an update
     * exists. Fetching `""` would resolve against this origin, and the SPA
     * fallback would hand back `index.html` — so the tab would report the
     * catalogue as malformed on every instance that simply has none.
     */
    if (base === null || base.length === 0 || path.length === 0) return;
    void fetchCatalogue(base, path, read).then((result) => {
      if (live) setAnswer(result);
    });
    return () => {
      live = false;
    };
    // `read` is a module-level function at every call site, so it is stable and is
    // deliberately not a dependency — including it would make this effect a
    // function of an identity nothing here controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, path, attempt]);
  return answer;
}
