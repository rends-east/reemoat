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
  /**
   * Whether somebody has said, in as many words, that they will install without
   * this screen having checked the pin.
   *
   * ⚠ **`ImportPlugin`'s `unread`, on the path that reaches a whole fleet from a
   * *catalogue's* summary rather than from an archive somebody picked.** That
   * screen charges a separate, named `DangerButton` for an archive it could not
   * read and draws no machine list until it is paid; this one drew a
   * `text-2xs text-muted` footnote — quieter than the plugin's own description
   * above it — and left the ordinary Install button live. Same doubt, one of them
   * a footnote.
   *
   * ⚠ **The commit it was paid for, not a boolean — and the boolean was wrong.**
   * The claim here was that reading it only in the `unreadable` arm was enough,
   * because a catalogue poll moving the entry to a new commit "puts the gate back".
   * It does not: {@link canAct} asks about the read's *kind*, `Entry` is keyed on
   * `entry.id` alone so a commit change does not remount it, and nothing reset the
   * flag — so when the re-read for the *new* commit also came back `unreadable`,
   * the stale `true` re-opened the install controls with no fresh press. That is a
   * consent decision about one commit carried onto another, which is the exact
   * thing the old sentence said could not happen.
   *
   * `consentGap` on the daemon still refuses anything the new commit *declares*
   * that was not shown, so this was never an escalation — but the gate on this
   * screen is what somebody is looking at, and it has to mean what it says.
   */
  const [unpinnedAt, setUnpinnedAt] = useState<string | null>(null);

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
   *
   * ⚠ **And the fallback is now *gated* as well as announced.** Saying which
   * reading is on screen was the whole of it, in a footnote, while every install
   * control below stayed live — so on a slow connection somebody acted on a
   * provisional summary without knowing a verification was still in flight. What
   * a person does about it is {@link canAct}.
   */
  const shown: ManifestPreview = consent.kind === "ok" ? consent.manifest : previewOf(entry);

  /**
   * Whether the machine table may be drawn at all.
   *
   * ⚠ **`reading` used to land here silently and it is the state this gate exists
   * for.** Only `unreadable` ever said anything, so the ordinary slow-network case
   * was a page that looked settled: the catalogue's summary drawn as though it
   * were the manifest, with Install live over it. A read that has not come back is
   * not a disclosure.
   *
   * ⚠ **The cost is named rather than hidden: while this is false the fleet's
   * Remove and Settings are off the screen too**, because they live in the same
   * component. A machine's own plugins panel still offers both per host, which is
   * why the trade is acceptable — and the alternative was worse: `MachineInstalls`
   * with `install={null}` draws *"not installed — this plugin did not come from
   * the market"* on every absent row, which is simply false here.
   */
  const canAct =
    consent.kind === "ok" || (consent.kind === "unreadable" && unpinnedAt === entry.source.commit);

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
      { scopes: shown.scopes, net: shown.net, hooks: shown.hooks, adds: shown.adds },
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
       *
       * ⚠ **Two rows rather than a sentence with links in it, and that is not
       * decoration.** *Read the code before you install it* is the whole of the
       * mitigation this design offers in place of a review process — the docblock
       * at the top of this file rests on it — and it was two bare `<a>`s inside a
       * `text-2xs` paragraph: an 18px line box, side by side, on a phone. See
       * {@link SourceLink}.
       */}
      <div className="mt-3 flex flex-col gap-1.5">
        <SourceLink
          href={entry.source.browse}
          title={entry.source.repo}
          subline={`the tree at ${shortCommit(entry.source.commit)}`}
        />
        <SourceLink href={entry.source.manifest} title="plugin.json" subline="what it declares, at that commit" />
      </div>

      {consent.kind === "reading" && (
        /*
         * ⚠ **A read that has not come back is not a disclosure, and this state
         * used to say nothing at all.** The catalogue's summary was drawn as though
         * it were the manifest at the pin, with every install control live under
         * it — so the slow-network case, which is the one this check exists for,
         * was indistinguishable from a verified one. It names the commit because
         * that is what is being verified *against*: the two rows above go to the
         * same twelve characters.
         */
        <ConsentDoubt title="Checking what it declares">
          <p className="mt-1 text-xs text-muted">
            Reading <code className="text-muted/80">plugin.json</code> at{" "}
            <code className="text-muted/80">{shortCommit(entry.source.commit)}</code>. Until that lands, what follows is
            the catalogue&rsquo;s own summary and nothing can be installed.
          </p>
        </ConsentDoubt>
      )}

      {consent.kind === "unreadable" && (
        /*
         * ⚠ **Not a refusal, and not silence either.** The catalogue's own summary
         * is derived from this same commit, so it is very probably right — but this
         * screen cannot prove it right now, and the whole point of the pinned read
         * is that what somebody agrees to provably belongs to the code. So it says
         * which reading is on screen. `pluginArchive.ts` takes the same posture one
         * door over: admit you could not read it rather than pretend.
         *
         * ⚠ **At the file picker's weight, and charging the file picker's press.**
         * This was a `text-2xs text-muted` paragraph — quieter than the plugin's
         * own description two lines up — beside an untouched Install button, while
         * the same doubt about an archive got a bordered card and a named
         * `DangerButton`. `ConsentDoubt` is that box, shared so the two cannot come
         * apart again.
         */
        <ConsentDoubt title="The pinned manifest could not be read here">
          <p className="mt-1 text-xs text-muted">
            {entry.source.manifestRaw} could not be read from here ({consent.reason}), so what follows is the
            catalogue&rsquo;s own summary rather than the manifest at that commit. The machine checks the real one on
            arrival and refuses anything more than this.
          </p>
          {/*
           * The separate, named press, inside the card for `PluginUnreadable`'s
           * reason: from here one act reaches every ticked machine, so the sentence
           * being bought past should be directly above the button that buys it. It
           * names what is given up rather than the act — the machine still refuses
           * anything beyond what is on screen, and a label implying otherwise would
           * be the second lie on a screen built to stop the first.
           */}
          {unpinnedAt !== entry.source.commit && (
            <DangerButton icon={Download} className="mt-3" onClick={() => setUnpinnedAt(entry.source.commit)}>
              Install without checking the pin
            </DangerButton>
          )}
        </ConsentDoubt>
      )}
      {/*
       * ⚠ **`names={false}`: the heading three lines up already said all three.**
       * The card drew the name, the version and the description a second time, so
       * one object read as two about two different plugins. The file picker keeps
       * them, because there the card is the only thing that names what was chosen.
       */}
      <PluginConsent manifest={shown} names={false} />

      {canAct && (
        <section className={SETTINGS_SECTION}>
          {/*
           * ⚠ **Named for the acts under it rather than for the state**, which is
           * the rule the old heading already followed — it read *Install* rather
           * than "where it is installed" because the control below it was an act.
           * It names both now because the section holds both: the way onto a
           * machine, and the way into what the plugin does once it is there.
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
            heading={INSTALL_HEADING}
            onConfigure={(machines) => navigate(marketSettingsPath(entry.id, machines))}
          />
        </section>
      )}

      {/*
       * ⚠ **The heading stays while the table is waiting, and the table is what is
       * missing rather than the section.** A section that appeared out of nowhere a
       * second later, under a rule that was already on screen, is a page that moves
       * while somebody is reading it — `SHEET_PANEL` argues the same thing about a
       * pop-up's height. The `unreadable` arm is the one case with no section at
       * all: there the way back is the press in the card above, and a heading over
       * a sentence pointing at a button two inches up is one more thing to read.
       *
       * A plain {@link Empty}: this is a wait rather than an event, so no `failed`
       * and no live region. Nothing has gone wrong yet.
       */}
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

/**
 * The one name for the section the machine table lives in.
 *
 * ⚠ **A constant because two things draw it now.** While the pinned manifest is
 * still being read the table is not drawn at all, and the heading has to stay put
 * or the whole section arrives out of nowhere a second later. Two literals for one
 * heading is how they come to disagree, and the disagreement is invisible until
 * somebody happens to be on a slow connection.
 */
const INSTALL_HEADING = "Settings and installation";

/**
 * How much of a commit is shown, in one place.
 *
 * ⚠ **Twelve, and it is not a taste question here.** The repository row's subline,
 * the line that says `plugin.json` is being read, the one that says nothing can be
 * installed until it has been, and every earlier version all draw the same commit,
 * and a screen that abbreviated one of them differently would look like two
 * different pins. Full 40-hex is what actually travels — `src/plugins/source.ts`
 * refuses anything shorter, because a tag moves under `git tag -f` and what is
 * pinned runs as the owner with no sandbox — so this is only ever how it is *read*.
 *
 * ⚠ **This read "both source rows", and the `plugin.json` row is not one of
 * them.** Its subline is "what it declares, at that commit" and names no
 * characters at all, which is why this function has four call sites and not five.
 * What the two rows share is the *href* — both resolve at the pin — and that,
 * rather than a drawn abbreviation, is what the reading state's own comment means
 * when it says they go to the same twelve characters.
 */
function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

/**
 * A link to the code being trusted, as a row somebody can actually hit.
 *
 * ⚠ **"Read the code before you install it" is the entire mitigation this design
 * offers in place of a review process, and it was an 18px tap target.** The
 * repository, `plugin.json` and every earlier version were bare `<a>`s inside
 * `text-2xs` paragraphs — an 18px line box, adjacent or stacked with no gap — on
 * the screen that hands a stranger's code this uid, these files and this `~/.ssh`.
 * `min-h-11` is the floor every other control in this app is held to, and this is
 * not the row to make the exception on.
 *
 * ⚠ **`ExternalLink` rather than the chevron a row usually ends in.** A chevron in
 * this app means a screen this pop-up is about to push; every one of these leaves
 * the origin for a new tab. On the one row whose entire job is saying *where the
 * code is*, a glyph making the wrong promise is the wrong glyph.
 *
 * The treatment is `ChoiceRow`'s, written out rather than reused because that
 * primitive is a `<button>` and this is a link off the origin: `edge-strong` is
 * what says a row is a control, and the hover moves the fill rather than the
 * boundary — `index.css`'s rule, `edge` → `edge-strong` under a pointer being a
 * jump louder than the press itself.
 */
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
 *
 * ⚠ **The shared {@link Disclosure}, not a native `<details>`.** This was the
 * second fold idiom on one screen — the platform's triangle and an instant snap,
 * about 200px below a hand-built chevron with a 200ms open — while the hand-built
 * one's own comment claimed it existed "so a fold in this app opens one way". A
 * claim about how an app behaves cannot be kept by a function only one file can
 * reach, so the fold moved to `bits.tsx` and this is the other half of that move.
 * `label` carries {@link SETTINGS_HEADING} on its own words, which beats the
 * wrapper's inherited `text-fg` the ordinary way — an element's own colour against
 * an inherited one, not the Tailwind ordering trap `FIELD` documents.
 */
function Versions({ base, entry }: { base: string; entry: CatalogueEntry }): ReactNode {
  const read = useCatalogue(base, CATALOGUE_PATHS.versions(entry.id), readVersions);
  const older = read?.kind === "ok" ? read.entries.filter((one) => one.version !== entry.version) : [];
  if (older.length === 0) return null;
  return (
    <section className={SETTINGS_SECTION}>
      <Disclosure first label={<span className={SETTINGS_HEADING}>Earlier versions ({older.length})</span>}>
        <ul className="mt-2 flex flex-col gap-1.5">
          {older.map((one) => (
            /* {@link SourceLink} for the reason it exists: these were the same
               18px links as the source block above, stacked, so the whole column
               was one mis-hit wide. */
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
    /*
     * The catalogue's own budget, and not a second literal spelling it. This read
     * is `catalogue.ts`'s in everything but the host it goes to — the same fifteen
     * seconds, on the address that module derived — and its docblock already claims
     * the number is shared, which it was not: this was the one bare timeout in the
     * plugin client, so the claim was true of every request except the one made
     * from the other side of the module boundary.
     */
    void fetch(entry.source.manifestRaw, { signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) })
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
