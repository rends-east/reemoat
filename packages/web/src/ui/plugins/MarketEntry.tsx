import { useEffect, useState, type ReactNode } from "react";
import {
  CATALOGUE_PATHS,
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
import { Empty, LINK, SETTINGS_HEADING, SETTINGS_SECTION, Spinner } from "../bits";
import { PluginConsent } from "../PluginConsent";
import { MachineInstalls, type InstallAct } from "./MachineInstalls";
import { useCatalogue } from "./MarketList";

/**
 * One plugin, in full, and the screen it is installed from.
 *
 * ⚠ **Everything drawn here is either derived from the code being installed, or
 * is a link to that code.** The catalogue carries no README, no screenshots and
 * no permissions prose, on purpose: `scopes`, `net` and `contributes` are
 * re-derived from the pinned `plugin.json` on every read and there is no second
 * editable copy of them, so anything free text would be the first place this
 * screen could lie — on the one screen where somebody grants a stranger's code
 * access to their sessions. What stands in for a description page is a link to
 * the repository tree at the pinned commit.
 */
export function MarketEntry({
  state,
  base,
  entryId,
  onIdentified,
}: {
  state: AppState;
  /**
   * The catalogue's address, or `null` on an instance that has none.
   *
   * ⚠ **Nullable, because the caller testing it first is what made `Offline`
   * unreachable on the deployment it exists for.** `PluginsSheet` answered
   * `base === null` with the market's own "nothing to browse" sentence at *every*
   * depth, including an entry — so on an instance with no
   * `REEMOAT_CP_PLUGIN_CATALOGUE_URL`, which the code calls an ordinary
   * deployment two comments away, every plugin row in the settings sheet and the
   * Installed tab opened a line about browsing, about a plugin sitting on the
   * person's own disk. Fleet-wide removal disappeared with it, since that lives in
   * `MachineInstalls` inside this component.
   */
  base: string | null;
  entryId: string;
  /**
   * What this plugin turned out to be called, handed to the sheet's head.
   *
   * ⚠ **The name and the version are drawn there and nowhere here.** The head can
   * only know the catalogue *id* before this fetch lands, and an id over a name —
   * `autotitle` above `Auto title 0.3.0` — reads as two objects about two
   * different plugins. So the head is told, rather than the body drawing a second
   * copy underneath it. Carries the id so the head can refuse a name that belongs
   * to the plugin somebody just navigated away from.
   */
  onIdentified: (identity: { id: string; name: string; version: string; icon: string | null }) => void;
}): ReactNode {
  const read = useCatalogue(base, CATALOGUE_PATHS.get(entryId), readOne);

  /*
   * No catalogue at all, which is not a failed read and must not draw one. There
   * is nothing to wait for — `useCatalogue` answers `null` for ever on a null base
   * by design — so this goes straight to the page a plugin gets when the market
   * cannot describe it, with no notice, because nothing here went wrong.
   */
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
    /*
     * ⚠ **A plugin the catalogue does not carry still has a page, because the
     * Installed tab links here.** Every row over there is a link to this screen,
     * and a plugin that arrived as a file — or one whose entry has been withdrawn
     * — would otherwise open a dead end saying it does not exist, about something
     * the person is looking at on their own machine.
     *
     * What it can offer is narrower and says so: there is no pinned commit to send
     * a second daemon, so `MachineInstalls` gets `install={null}` and the boxes
     * only come off. That is the case that component was written for.
     */
    return <Offline state={state} pluginId={entryId} notice={catalogueNotice(read)} onIdentified={onIdentified} />;
  }
  // Keyed on the id, so walking from one plugin to another remounts rather than
  // carrying the previous one's chosen machines and its results panel across —
  // `MachinePluginsSection`'s rule, and it matters more here because the state
  // being carried decides what gets installed where.
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

  // The head is told what this is, once per plugin. Depending on the three
  // fields rather than on `entry` so that a catalogue re-read returning an equal
  // object does not set state on every poll.
  useEffect(() => {
    onIdentified({ id: entry.id, name: entry.name, version: entry.version, icon: entry.source.icon });
  }, [onIdentified, entry.id, entry.name, entry.version, entry.source.icon]);

  /*
   * What the disclosure block draws, and therefore what somebody agreed to.
   *
   * ⚠ **The manifest at the pinned commit wherever it can be read, and the
   * catalogue's summary only when it cannot.** They should be identical — the
   * catalogue derives its copy from that same file at that same commit — but
   * "should be" is not a check, and this is the screen where being wrong means
   * somebody grants a capability they never saw. So the authoritative reading is
   * the one from `raw.githubusercontent.com`, and the fallback says out loud that
   * it is one.
   */
  const shown: ManifestPreview = consent.kind === "ok" ? consent.manifest : previewOf(entry);

  /*
   * Installing on one machine. Handed to `MachineInstalls`, which decides *when* —
   * a box being ticked — and reports the outcome on that machine's own row.
   *
   * ⚠ **Throws on a broken consent rather than reporting it**, so the row lands on
   * `failed` and the box stays unticked. `MachineInstalls` cannot tell a refusal
   * from a success it was handed, and a screen that ticked a box for a plugin it
   * had just refused to trust would be the one lie this whole page exists to
   * prevent.
   */
  /*
   * ⚠ **Annotated as `InstallAct`, and it takes every parameter it is handed.**
   * It took two, and TypeScript accepted that against a four-parameter type —
   * fewer parameters is assignable, silently — so the `signal` `MachineInstalls`
   * passes for cancellation was dropped on the floor here while the Cancel button
   * it belongs to was still drawn. Pressing it aborted controllers nothing was
   * listening to, the POSTs ran to completion against the 90s slow-route budget,
   * and the plugin landed on every ticked machine after somebody had called it
   * off. The annotation does not catch a missing parameter on its own; naming all
   * four is what makes the omission visible to a reader.
   */
  const install: InstallAct = async (daemon, machineId, _onProgress, signal): Promise<TargetOutcome> => {
    const answer = await daemon.installPluginFromSource(
      { kind: "github", repo: entry.source.repo, commit: entry.source.commit },
      { scopes: shown.scopes, net: shown.net, hooks: shown.hooks },
      signal,
    );
    /*
     * ⚠ **Checked again on the answer, per machine, even though the daemon already
     * refuses a breach before starting anything.** Two different checks: the
     * daemon's compares its own parse against what it was told and is what prevents
     * the plugin running; this compares the *row that came back* against what this
     * screen actually drew. The second is what catches a divergence nobody thought
     * of — `consentBroken` exists for exactly that, and it is the half that does
     * not depend on having predicted the failure.
     */
    const broken = consentBroken(shown, answer.plugin);
    // Thrown so the row lands on `failed` with its box unticked, and thrown as
    // `ConsentBrokenError` so the sentence survives `pluginFailure` — a plain
    // `Error` was answered with "That did not work. Try again."
    if (broken !== null) throw new ConsentBrokenError(`${machineId}: ${broken}`);
    return answer.replaced === null
      ? { kind: "installed", version: answer.plugin.version, enabled: answer.plugin.enabled }
      : { kind: "updated", from: answer.replaced, to: answer.plugin.version, enabled: answer.plugin.enabled };
  };

  return (
    <div>
      {/*
       * ⚠ **The description, once.** The name and the version are the sheet's
       * head — see `onIdentified` — so this opens on what the plugin *does*
       * rather than on a second spelling of what it is called. The screen has one
       * identity block and it is above this one.
       */}
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

      {/*
       * ⚠ **The pin, named and linkable.** A commit is the only content-addressed
       * thing GitHub offers, and it is what both this screen and the daemon are
       * pinned to — so somebody who wants to read the code before agreeing has a
       * link to *exactly* what will be installed, rather than to a branch that has
       * moved since. `sha256Seen` is deliberately not drawn as a guarantee
       * anywhere: it is what the catalogue saw once, and GitHub's tarballs are not
       * byte-stable by contract.
       */}
      <p className="mt-2 text-2xs text-muted">
        <a href={entry.source.browse} target="_blank" rel="noreferrer" className={LINK}>
          {entry.source.repo}
        </a>{" "}
        at <code className="text-2xs text-muted/80">{entry.source.commit.slice(0, 12)}</code> ·{" "}
        <a href={entry.source.manifest} target="_blank" rel="noreferrer" className={LINK}>
          its plugin.json
        </a>
      </p>

      {consent.kind === "unreadable" && (
        /*
         * ⚠ **Not a refusal, and not silence either.** The catalogue's own summary
         * is derived from this same commit, so it is very probably right — but this
         * screen cannot prove it right now, and the whole point of the pinned read
         * is that what somebody agrees to provably belongs to the code. So it says
         * which reading is on screen. `pluginArchive.ts` takes the same posture one
         * door over: admit you could not read it rather than pretend.
         */
        <p className="mt-3 text-xs text-muted">
          {entry.source.manifestRaw} could not be read from here ({consent.reason}), so what follows is the
          catalogue&rsquo;s own summary rather than the manifest at that commit. The machine checks the real one on
          arrival and refuses anything more than this.
        </p>
      )}
      {/*
       * ⚠ **`names={false}`: the heading three lines up already said all three.**
       * The card drew the name, the version and the description a second time, so
       * one object read as two about two different plugins. The file picker keeps
       * them, because there the card is the only thing that names what was chosen.
       */}
      <PluginConsent manifest={shown} names={false} />

      <section className={SETTINGS_SECTION}>
        {/*
         * ⚠ **Named for the acts under it rather than for the state**, which is the
         * rule the old heading already followed — it read *Install* rather than
         * "where it is installed" because the control below it was an act. It names
         * both now because the section holds both: the way onto a machine, and the
         * way into what the plugin does once it is there.
         *
         * ⚠ **"Settings" here is the *plugin's* settings pane**, not this app's
         * settings screen — `SETTINGS_HEADING` and `SETTINGS_SECTION` are the
         * chrome idiom and are unrelated to the word.
         */}
        <MachineInstalls
          pluginId={entry.id}
          state={state}
          install={install}
          available={entry.version}
          heading="Settings and installation"
          onConfigure={(machines) => navigate(marketSettingsPath(entry.id, machines))}
        />
      </section>

      <Versions base={base} entry={entry} />
    </div>
  );
}

function publishedText(iso: string): string | null {
  if (iso.length === 0) return null;
  const at = Date.parse(iso);
  // A date this client cannot read is drawn as nothing rather than as `Invalid
  // Date`, which is `wire.ts`'s posture about every value it did not produce.
  return Number.isFinite(at) ? `published ${new Date(at).toLocaleDateString()}` : null;
}

/**
 * The versions before this one, behind a disclosure.
 *
 * Folded by default and deliberately: a plugin's release history is a thing
 * somebody occasionally wants and never wants *first*, and a wall of rows above
 * the install control would push the permissions somebody has to read off a
 * phone's screen.
 */
function Versions({ base, entry }: { base: string; entry: CatalogueEntry }): ReactNode {
  const read = useCatalogue(base, CATALOGUE_PATHS.versions(entry.id), readVersions);
  const older = read?.kind === "ok" ? read.entries.filter((one) => one.version !== entry.version) : [];
  if (older.length === 0) return null;
  return (
    <section className={SETTINGS_SECTION}>
      <details>
        <summary className="tap min-h-11 cursor-pointer text-xs text-muted">
          <span className={SETTINGS_HEADING}>Earlier versions ({older.length})</span>
        </summary>
        <ul className="mt-2 flex flex-col gap-1">
          {older.map((one) => (
            <li key={one.source.commit} className="flex min-w-0 items-baseline gap-2 text-xs">
              <span className="shrink-0 text-fg">{one.version}</span>
              <a
                href={one.source.browse}
                target="_blank"
                rel="noreferrer"
                className={`min-w-0 flex-1 truncate text-2xs text-muted ${LINK}`}
              >
                {one.source.commit.slice(0, 12)}
              </a>
              <span className="shrink-0 text-2xs text-muted">{publishedText(one.publishedAt) ?? ""}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/**
 * `plugin.json` at the pinned commit, read with the archive reader.
 *
 * ⚠ **The same reader the file picker uses, and that is the point.** Two screens
 * in this app ask somebody to agree to what a plugin may do, and they must draw
 * the same sentences with the same fall-through for a scope this build has not
 * heard of. `readManifestText` is `pluginArchive.ts`'s own reader with the bytes
 * already decoded, so there is one set of rules rather than two.
 *
 * `raw.githubusercontent.com` answers CORS `*`, which is what makes this reachable
 * from the browser at all — unlike the archive itself, which is why the *daemon*
 * fetches that.
 */
function usePinnedManifest(entry: CatalogueEntry): { kind: "reading" } | ReturnType<typeof readManifestText> {
  const [state, setState] = useState<{ kind: "reading" } | ReturnType<typeof readManifestText>>({ kind: "reading" });
  useEffect(() => {
    let live = true;
    setState({ kind: "reading" });
    void fetch(entry.source.manifestRaw, { signal: AbortSignal.timeout(15_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
        return await response.text();
      })
      .then((text) => {
        if (live) setState(readManifestText(text));
      })
      .catch((cause: unknown) => {
        /*
         * A CSP refusal lands here as a bare `TypeError` naming nothing, exactly
         * as an outage does. Which is why the control plane derives its
         * `connect-src` entry from the same value it publishes as the catalogue
         * address — the state where the two disagree is not reachable, so this
         * arm never has to tell them apart.
         */
        if (live) setState({ kind: "unreadable", reason: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      live = false;
    };
  }, [entry.source.manifestRaw]);
  return state;
}

/**
 * A plugin this catalogue cannot describe, drawn from what the machines say.
 *
 * ⚠ **Not an error page.** The catalogue being unreachable and the plugin not
 * being in it are different facts and only the first is worth a sentence — a
 * plugin installed from a file is *never* in the catalogue and that is ordinary,
 * so saying "not found" about it every time would teach somebody to ignore the
 * line that matters. `catalogueNotice` is drawn only when the read actually
 * failed.
 */
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
    // No catalogue entry, so no icon — the glyph is the ordinary case here.
    onIdentified({ id: pluginId, name, version, icon: null });
  }, [onIdentified, pluginId, name, version]);

  if (first === null) {
    // Not installed anywhere either: this really is nothing, and the notice — or
    // the plain sentence — is the whole of the answer.
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
        {/* ⚠ **Settings still work here**, and that is why `settingsBlockFor`
            consults nothing about installing: a plugin that arrived as a file is
            exactly the one whose settings somebody wants, and this screen makes no
            catalogue request to draw them. */}
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
