/* ──────────────────────────────────────────────────────────────────────────
 * The plugin catalogue: what official plugins exist, and what each one is.
 *
 * ⚠ **A hand mirror of `services/plugins/src/catalogue.ts`, which is in a
 * different repository, and a relative import across that boundary is not
 * available at any price.** This package is `rends-east/reemoat` (public); the
 * catalogue service is `rends-east/reemoat-prod` (private). `app/` happens to
 * sit inside that working copy on the machine this was written on — and is
 * `.gitignore`d out of it, so `git ls-files app` is empty. Three consequences,
 * any one of which is decisive:
 *
 *   - this repository's CI has no copy of the other one, so an import up and
 *     across compiles on one laptop and fails on the first run in CI;
 *   - `deploy.sh` moves the private copy with `git reset --hard`, so a path
 *     crossing the boundary is a path a deploy can delete;
 *   - copying a private service's internal shape into a public repository
 *     publishes it.
 *
 * So this is `wire.ts`'s arrangement exactly, for `wire.ts`'s reason, and the
 * rule is the same: **the file named above is the source of truth, and a field
 * added there is added here by hand.**
 *
 * ⚠ **The manifest vocabulary is mirrored from the *original*, not from the
 * service's copy of it.** `PluginScope`, `PluginHook` and `PluginContributions`
 * originate in `src/plugins/protocol.ts` in this repository and are already
 * mirrored into `wire.ts`; the catalogue service has its own copy of the same
 * types. Mirroring from that copy would make this a copy of a copy, with two
 * places to drift instead of one — so everything below imports from `wire.ts`.
 * Only {@link CatalogueEntry} and {@link compareVersions} originate over there.
 *
 * DOM-free on purpose, so `webcheck` can import it.
 * ────────────────────────────────────────────────────────────────────────── */

import type { ManifestPreview } from "./pluginArchive";
import type { PluginContributions } from "./wire";

/**
 * The schema this client speaks.
 *
 * ⚠ **Not a negotiated range, unlike `PLUGIN_API_VERSION`, and the difference is
 * deliberate on the service's side rather than an oversight here.** Fields are
 * added to a `CatalogueEntry` and never reused, so a client reading schema 1 out
 * of a richer document is reading exactly what it always read. The number moves
 * only when that stops being enough — which is precisely the case a client must
 * not guess its way through. See {@link readCatalogue}.
 */
export const CATALOGUE_SCHEMA = 1;

/**
 * Where the code actually is.
 *
 * Every field is present on every read — the service assigns each key on each
 * read and `JSON.stringify` keeps an explicit `null` — so this reader takes
 * required keys with nullable values and never asks whether a key exists. Use
 * `??` and never `||` against these: `archiveBytes` can be a legitimate `0`.
 */
export interface CatalogueSource {
  kind: "github";
  /**
   * `owner/name`. The daemon refuses anything else, and so does this — and every
   * address below is built out of it, so it is a path segment as well as a name.
   */
  repo: string;
  /** A full 40-character commit. The daemon refuses anything else, and so does this. */
  commit: string;
  /** The repository tree at that commit, for a person. */
  browse: string;
  /** `plugin.json` at that commit, for a person. */
  manifest: string;
  /** The same file for a program: `raw.githubusercontent.com`, which answers CORS `*`. */
  /**
   * ⚠ **Derived from `repo` and `commit` rather than taken from the catalogue**,
   * and a catalogue that spells it differently loses the entry — see
   * {@link readSource}. This is the address whose *bytes* become the permission
   * list somebody agrees to, so a value chosen over there would be a disclosure
   * chosen over there.
   */
  manifestRaw: string;
  /**
   * The tarball.
   *
   * ⚠ **This client never fetches it and cannot.** `codeload.github.com` answers
   * `access-control-allow-origin: https://render.githubusercontent.com`, so a
   * cross-origin fetch from this page is refused before it leaves — which is the
   * whole reason `POST /plugins/source` exists on the daemon. The field is here
   * because it is part of the contract and because it is worth showing a person
   * who wants to fetch it themselves.
   */
  archive: string;
  archiveName: string;
  archiveBytes: number | null;
  /** An SVG at that commit, or `null` — which is a common answer, not an edge. */
  icon: string | null;
  /**
   * The digest the catalogue saw once, at publish.
   *
   * ⚠ **Never a gate, and the name is the warning.** GitHub's generated tarballs
   * are not byte-stable by contract — the compression under them has changed
   * before — so a mismatch means the packaging moved, not that the code did.
   * Refusing on it would stop healthy plugins installing on the day GitHub
   * changes zlib. The pin is {@link CatalogueSource.commit}, which is
   * content-addressed and is the only thing here that proves anything.
   */
  sha256Seen: string | null;
}

/**
 * One plugin, as the catalogue describes it.
 *
 * ⚠ **`scopes`, `net` and `contributes` are *derived from the pinned
 * `plugin.json` on every read*, and there is no second editable copy of them.**
 * That is the property the whole service is built around, and it is why there is
 * no README, no screenshot and no permissions prose in this type: anything free
 * text would not be subject to that derivation, and it would become the first
 * place the catalogue could lie — on the very screen where somebody grants a
 * plugin access to their sessions.
 *
 * What the expanded view draws instead is these fields plus links to
 * {@link CatalogueSource.browse} and {@link CatalogueSource.manifest}, so
 * everything on it is either derived from the code or is the code.
 */
export interface CatalogueEntry {
  id: string;
  name: string;
  description: string | null;
  version: string;
  api: number;
  /**
   * Raw strings rather than `PluginScope[]`.
   *
   * A scope this client has not heard of has to be **shown**, legibly, rather
   * than dropped from the very list it exists to disclose — `pluginArchive.ts`'s
   * rule, and it matters more here than there. `PLUGIN_SCOPE_TEXT` is read
   * through `Record<string, string>` at the one place these are drawn.
   */
  scopes: readonly string[];
  net: readonly string[];
  contributes: PluginContributions;
  source: CatalogueSource;
  homepage: string | null;
  author: string | null;
  license: string | null;
  categories: readonly string[];
  /** ISO 8601. */
  publishedAt: string;
}

/**
 * What a read of the catalogue produced.
 *
 * ⚠ **Three arms, and this is the one reader in the client that fails
 * *closed*.** `packages/web/src/plugins.ts` fails open on every narrowing, on
 * purpose — an unknown block there costs a row nobody sees, and refusing to draw
 * would take a working screen away for a field nobody needed. The trade is the
 * other way round here: a half-read entry is a **half-read permission list**, and
 * this is the screen where somebody decides whether a stranger's code may read
 * their sessions. Showing four of five scopes is worse than showing none, because
 * the person cannot tell which they are looking at.
 *
 * So `too_new` says "update the app" and draws nothing, and a malformed document
 * is reported rather than partially parsed.
 *
 * ⚠ **"Fails closed" means exactly one thing, and it is worth spelling out because
 * the other reading would break the fleet.** It means: *reject an entry whose
 * required field is absent or of the wrong type.* It does **not** mean: reject an
 * entry carrying a field this build has not heard of.
 *
 * The service's own rule is that fields are **added and never repurposed**, and
 * that `schema` moves only when that stops being enough. This reader is the other
 * half of that rule, and the half that can silently break it: a reader that
 * refused unknown keys would go dark on every already-deployed client the next
 * time a field is added — not immediately, and not for whoever added it, but for
 * everyone whose web client is older than that deploy. `source.icon` was added
 * that way already. `webcheck` pins the tolerance at all three depths (the
 * document, the entry, and `source`) rather than leaving it as a property nobody
 * restates.
 */
export type CatalogueRead =
  /**
   * Everything this build could read in full.
   *
   * One shape for all three endpoints — a list, one plugin, a version history —
   * so every screen has one set of arms to draw rather than three. The
   * single-plugin read answers zero or one entry, and "zero" is the same sentence
   * as "that plugin is not in the catalogue".
   */
  | { kind: "ok"; entries: CatalogueEntry[] }
  /** The service speaks a schema this build does not. Never partially parsed. */
  | { kind: "too_new"; schema: number }
  | { kind: "malformed"; reason: string }
  /**
   * It could not be asked at all.
   *
   * ⚠ **A CSP refusal is indistinguishable from an outage in here**, and lands on
   * this arm: the browser blocks the request before it leaves and `fetch` rejects
   * with a bare `TypeError` naming nothing. Which is why the control plane derives
   * its `connect-src` entry from the very value it publishes as the catalogue
   * address — the state where the two disagree is not reachable, so this arm never
   * has to explain itself.
   */
  | { kind: "unreachable"; reason: string };

/* ── reading ─────────────────────────────────────────────────────────────── */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
}

/**
 * The manifest's contribution block, as the catalogue publishes it.
 *
 * Lenient in the direction of *saying more*: an action shape this build does not
 * recognise is dropped rather than refused, because the alternative is a plugin
 * nobody can look at because of a field nobody reads. `hooks` is the exception in
 * spirit — it is a raw string list, so an unknown hook survives to be shown.
 */
function readContributes(raw: unknown): PluginContributions {
  const source = isObject(raw) ? raw : {};
  const screen = source["screen"];
  const title = isObject(screen) ? text(screen["title"]) : null;
  return {
    screen: title === null ? null : { title },
    settings: source["settings"] === true,
    actions: Array.isArray(source["actions"])
      ? source["actions"].flatMap((one) => {
          if (!isObject(one)) return [];
          const id = text(one["id"]);
          const label = text(one["title"]);
          const on = one["on"];
          if (id === null || label === null || (on !== "session" && on !== "screen")) return [];
          return [{ id, title: label, on }];
        })
      : [],
    // Cast rather than filtered against a known set, for `CatalogueEntry.scopes`'
    // reason: a hook this build has not heard of must reach the disclosure, and
    // the one place it is drawn falls through to the raw identifier.
    hooks: strings(source["hooks"]) as PluginContributions["hooks"],
  };
}

/**
 * `owner/name`, in the character set GitHub actually allows.
 *
 * ⚠ **The same expression as `REPO` in `src/plugins/source.ts`, mirrored by hand
 * for the reason {@link COMMIT} is.** `POST /plugins/source` refuses anything
 * else with `plugin_source_invalid`, so an entry spelled another way is one this
 * app could draw and never install.
 *
 * ⚠ **And here it does a second job the daemon's copy does not have to.** Every
 * address below is built by interpolating this string into a URL *path*, so a
 * `/` inside either half reaches a third path segment: a `repo` read as
 * `owner/name/tree` derives a `browse` of
 * `https://github.com/owner/name/tree/tree/<sha>`, and the raw host would serve
 * a different repository's `plugin.json` under this plugin's name. That is
 * `src/plugins/source.ts`'s own argument, one process over — no part of the
 * address comes from whoever sent it, which is what makes the host a fence
 * rather than the spelling check `net`'s allowlist honestly calls itself.
 */
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The two hosts an entry may name, and nothing else.
 *
 * The same pair the control plane writes into this document's own CSP —
 * `PLUGIN_MANIFEST_ORIGIN` beside the catalogue's origin in
 * `packages/control-plane/src/app.ts`. Which is half of why the check belongs
 * here as well as there: **the browser's refusal is silent.** An `<img>` off
 * `img-src` draws the broken-image glyph until `onError` fires, and a `fetch` off
 * `connect-src` rejects with a bare `TypeError` that `MarketEntry` correctly
 * reports as the manifest not being readable from here — so an entry naming
 * somewhere it should not looks exactly like GitHub being down.
 */
const FORGE_HOST = "github.com";
const RAW_HOST = "raw.githubusercontent.com";

/**
 * A URL the catalogue supplied, or `null` unless it is `https` on `host`.
 *
 * ⚠ **Parsed rather than prefix-matched**, because `new URL` is what decides what
 * the browser would actually do with it and a hand-rolled test is how a host
 * check acquires a hole: `https://github.com@evil.example/x` starts with the
 * right string and has host `evil.example`, and `https://github.com.evil.example/x`
 * contains it. `host` rather than `hostname`, so a port is a difference too.
 *
 * `openableHref` in `ui/links.ts` is this same parse for agent-authored links and
 * is deliberately **not** imported: its rule is `http`, `https` or `mailto`
 * *anywhere*, which is right for a link an agent cited in a message and far too
 * wide for one this screen labels with a repository's name.
 */
function hostedUrl(value: unknown, host: string): string | null {
  const raw = text(value);
  if (raw === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Not a URL at all — no scheme, or a relative path. `new URL` throws rather
    // than answering, so this is the whole of the negative case.
    return null;
  }
  // The string as it was sent rather than `parsed.toString()`, `openableHref`'s
  // precedent: what was checked is what is drawn, with no normalisation in
  // between for anybody to have to reason about.
  return parsed.protocol === "https:" && parsed.host === host ? raw : null;
}

function readSource(raw: unknown): CatalogueSource | null {
  if (!isObject(raw) || raw["kind"] !== "github") return null;
  const repo = text(raw["repo"]);
  const commit = text(raw["commit"]);
  const archive = text(raw["archive"]);
  /*
   * ⚠ **The commit is checked *here*, by the same rule the daemon uses.** An
   * entry whose pin is a tag is one this app cannot install — `POST
   * /plugins/source` refuses anything but a full sha — so admitting it would draw
   * a market row whose only button 400s. A tag moves under `git tag -f`, which is
   * why neither side accepts one.
   */
  if (repo === null || !REPO.test(repo) || commit === null || !COMMIT.test(commit) || archive === null) {
    return null;
  }
  /*
   * ⚠ **`plugin.json` at the root of the repository, because that is the only
   * shape this fleet can install.** `POST /plugins/source` is handed `{repo,
   * commit}` and nothing else, and `findManifestRoot` in `src/plugins/host.ts`
   * looks for `plugin.json` at the top of the tarball or one wrapper directory
   * in — which is GitHub's own `{repo}-{commit}/` prefix and no deeper. A plugin
   * in a monorepo subdirectory is therefore not installable from here at all, so
   * for a pin this build has accepted there is exactly one address its manifest
   * can be at, and this is it.
   */
  const manifestRaw = `https://${RAW_HOST}/${repo}/${commit}/plugin.json`;
  /*
   * ⚠ **Derived, and the catalogue's own spelling is accepted only where it is
   * that same string.** This is the field a *program* reads: `MarketEntry`
   * fetches it and the bytes that come back **are** the permission list somebody
   * agrees to. Taken verbatim it made {@link previewOf}'s claim — that what
   * somebody agrees to is provably the same commit as the code — untrue, and this
   * app's control plane puts the catalogue's own origin in `connect-src`, so a
   * `manifestRaw` pointing back at the service fetches perfectly and this screen
   * draws a hand-typed list under the words *the manifest at that commit*.
   *
   * ⚠ **Nothing downstream restores the claim, and it is worth being exact about
   * why — not because the consent checks are absent, but because of what they
   * compare.** `consentGap` in `src/plugins/source.ts` and `consentBroken` in
   * `plugins.ts` both compare *scopes, `net` and hooks* and nothing else, so a
   * forged manifest that under-declares those three is refused as
   * `plugin_consent_broken` before the plugin ever starts. What neither compares
   * is everything else this screen draws: `id`, `name`, `version`, `description`,
   * and the `screen`, `settings` and `actions` a plugin contributes.
   * `consentBroken`'s own docblock says so out loud — *names and versions are
   * deliberately not compared, a manifest is free to say what it likes about
   * itself*. So what a catalogue-chosen address bought was a false name, a false
   * description and a false account of the screens and session actions, none of
   * which any check downstream is looking at.
   *
   * The entry is dropped rather than quietly corrected, which is this module's
   * posture everywhere: the two disagreeing is not a cosmetic difference, it is
   * the service asserting something about this pin that this build can show to be
   * false.
   */
  if (text(raw["manifestRaw"]) !== manifestRaw) return null;
  const bytes = raw["archiveBytes"];
  return {
    kind: "github",
    repo,
    commit,
    /*
     * ⚠ **The two a *person* reads are anchored by host rather than matched
     * against the derivation, and a failure takes the derivation rather than the
     * entry.** They are `<a href>`s on the screen where somebody decides whether
     * to trust a stranger's code, labelled with the repository's own name — so a
     * value off `github.com` is a link that says it goes to the code and goes
     * elsewhere. Anchoring the host and not the whole string leaves the service
     * free to deep-link inside the same commit without this reader having to
     * predict the form, which changes where somebody lands and not what they read.
     *
     * The fallback is the one that was already here, and it is provably the right
     * address: a person gets a link to exactly the code either way, and losing a
     * whole plugin over the spelling of a link is the going-dark failure this
     * reader's own docblock warns about.
     */
    browse: hostedUrl(raw["browse"], FORGE_HOST) ?? `https://${FORGE_HOST}/${repo}/tree/${commit}`,
    manifest: hostedUrl(raw["manifest"], FORGE_HOST) ?? `https://${FORGE_HOST}/${repo}/blob/${commit}/plugin.json`,
    manifestRaw,
    archive,
    archiveName: text(raw["archiveName"]) ?? `${repo}-${commit}.tar.gz`,
    // `typeof` rather than `??`, because zero is a legitimate size and `||` would
    // turn it into `null`.
    archiveBytes: typeof bytes === "number" && Number.isFinite(bytes) ? bytes : null,
    /*
     * ⚠ **`null` rather than a dropped entry, alone among these addresses.** An
     * icon is a picture: `icon: null` is the commonest answer and the market draws
     * a fallback glyph for it as the ordinary case, so a plugin disappearing over
     * its picture would be wildly out of proportion to what is wrong. What the
     * check buys is that the fallback is drawn *at once* rather than after the
     * browser refuses a request `img-src` never allowed and `onError` fires.
     */
    icon: hostedUrl(raw["icon"], RAW_HOST),
    sha256Seen: text(raw["sha256Seen"]),
  };
}

/**
 * One entry, or `null` for one this build cannot read in full.
 *
 * `null` rather than a partial entry, which is this module's whole posture: the
 * caller drops it from the list and says how many were dropped, so a person is
 * never shown an incomplete description of what they are about to install.
 */
export function readEntry(raw: unknown): CatalogueEntry | null {
  if (!isObject(raw)) return null;
  const id = text(raw["id"]);
  const name = text(raw["name"]);
  const version = text(raw["version"]);
  const api = raw["api"];
  const source = readSource(raw["source"]);
  if (id === null || name === null || version === null || typeof api !== "number" || source === null) return null;
  return {
    id,
    name,
    description: text(raw["description"]),
    version,
    api,
    scopes: strings(raw["scopes"]),
    net: strings(raw["net"]),
    contributes: readContributes(raw["contributes"]),
    source,
    homepage: text(raw["homepage"]),
    author: text(raw["author"]),
    license: text(raw["license"]),
    categories: strings(raw["categories"]),
    publishedAt: text(raw["publishedAt"]) ?? "",
  };
}

/**
 * The whole document, read.
 *
 * ⚠ **An empty catalogue is `ok` with no entries, not an error.** A service that
 * has published nothing yet is an ordinary state, and drawing "something went
 * wrong" over it sends somebody looking for a fault that is not there.
 */
export function readCatalogue(raw: unknown): CatalogueRead {
  if (!isObject(raw)) return { kind: "malformed", reason: "that is not a catalogue" };
  const schema = raw["schema"];
  if (typeof schema !== "number") return { kind: "malformed", reason: "that catalogue names no schema" };
  if (schema > CATALOGUE_SCHEMA) return { kind: "too_new", schema };
  const plugins = raw["plugins"];
  if (!Array.isArray(plugins)) return { kind: "malformed", reason: "that catalogue has no list of plugins" };
  return { kind: "ok", entries: plugins.map(readEntry).filter((one): one is CatalogueEntry => one !== null) };
}

/**
 * The single-entry shape, from `/api/plugins/get/:id`.
 *
 * Answers the same union as the list, with zero or one entry, so a screen drawing
 * one plugin has the same arms as the screen drawing all of them. An entry this
 * build cannot read in full is `ok` with none rather than `malformed`: the
 * document was fine, and what the reader owes the person is "this is not
 * something you can install from here" rather than "something went wrong".
 */
export function readOne(raw: unknown): CatalogueRead {
  if (!isObject(raw)) return { kind: "malformed", reason: "that is not a plugin" };
  const schema = raw["schema"];
  if (typeof schema !== "number") return { kind: "malformed", reason: "that answer names no schema" };
  if (schema > CATALOGUE_SCHEMA) return { kind: "too_new", schema };
  const entry = readEntry(raw["plugin"]);
  return { kind: "ok", entries: entry === null ? [] : [entry] };
}

/** The version-history shape, from `/api/plugins/versions/:id`. Newest first. */
export function readVersions(raw: unknown): CatalogueRead {
  if (!isObject(raw)) return { kind: "malformed", reason: "that is not a version list" };
  const schema = raw["schema"];
  if (typeof schema !== "number") return { kind: "malformed", reason: "that answer names no schema" };
  if (schema > CATALOGUE_SCHEMA) return { kind: "too_new", schema };
  const versions = raw["versions"];
  if (!Array.isArray(versions)) return { kind: "malformed", reason: "that answer has no versions" };
  return { kind: "ok", entries: versions.map(readEntry).filter((one): one is CatalogueEntry => one !== null) };
}

/**
 * A catalogue entry, in the shape the consent block draws.
 *
 * ⚠ **A conversion rather than a second disclosure component.** `PluginConsent`
 * is the one copy of the sentence somebody reads before granting a plugin access
 * to their sessions, and both ways into this app have to draw it identically —
 * see that file's own head. What differs between the two is only where the facts
 * came from, which is what this function is.
 *
 * ⚠ **Used only where the manifest at the pinned commit could not be read.** The
 * market fetches `source.manifestRaw` and builds the disclosure from *that*, so
 * what somebody agrees to is provably the same commit as the code — provably
 * because that address is **derived** from the pin in {@link readSource} rather
 * than taken from the catalogue, which is what makes this sentence a fact about
 * the code rather than a promise about the service. This is the
 * fallback, and the screen using it says so out loud rather than passing the
 * catalogue's summary off as the manifest — `pluginArchive.ts`'s standing rule
 * that a reader may admit it does not know but may never invent.
 */
export function previewOf(entry: CatalogueEntry): ManifestPreview {
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    description: entry.description,
    scopes: [...entry.scopes],
    net: [...entry.net],
    screen: entry.contributes.screen?.title ?? null,
    settings: entry.contributes.settings,
    actions: entry.contributes.actions.map((action) => ({ id: action.id, title: action.title, on: action.on })),
    hooks: [...entry.contributes.hooks],
  };
}

/* ── versions ────────────────────────────────────────────────────────────── */

/**
 * Which of two `x.y.z` versions is newer: negative, zero or positive.
 *
 * ⚠ **Numeric, component by component, and a string compare gets it backwards.**
 * `"0.10.0" < "0.9.0"` is true lexicographically, because `"1" < "9"` — so a
 * plugin that has had ten minor releases would report an update *available* on
 * the version already installed, for ever. Measured against the ten-minor case
 * because that is the first time it bites and it bites silently.
 *
 * `parseManifest` on the daemon admits exactly three numeric components and no
 * pre-release, so there is no `-beta.1` to order and none is invented here.
 * Anything unparseable sorts as zero rather than throwing, `plugins.ts`'s posture
 * — a version this client cannot read is not a reason to refuse to draw a row.
 */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] =>
    value.split(".").map((one) => {
      const parsed = Number.parseInt(one, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Whether the catalogue is ahead of what is installed. */
export function isNewer(catalogue: string, installed: string): boolean {
  return compareVersions(catalogue, installed) > 0;
}

/* ── fetching ────────────────────────────────────────────────────────────── */

/**
 * How long the catalogue has to answer.
 *
 * The same fifteen seconds every other request in this client gets. A catalogue
 * that is slow is a tab that says so; there is nothing here worth a longer
 * budget, because nothing here is on a path anybody is blocked on.
 *
 * ⚠ **Exported, because the sentence above claims a budget this module does not
 * hold alone.** A market entry makes a second read the person is waiting on —
 * `usePinnedManifest`, straight to `raw.githubusercontent.com` rather than
 * through {@link fetchCatalogue}, since that is the one address answering CORS
 * `*` — and while this was module-private that screen spelled a bare `15_000`
 * instead. Two literals cannot keep "the same fifteen seconds" true — the next
 * person to change the wait changes one of them — and `ROTATE_RETRY_MS` is named
 * one module over for the weaker half of the same reason: so a reader does not
 * have to prove that bare `15_000`s were meant to be one number.
 */
export const CATALOGUE_TIMEOUT_MS = 15_000;

/**
 * Where each of the three reads lives, given the base this instance published.
 *
 * `new URL` against the base rather than string concatenation, so a base with or
 * without a trailing slash reaches the same address — and so a base that is not a
 * URL throws here rather than producing a relative path that the control plane's
 * SPA fallback would answer with `index.html`.
 */
export function catalogueEndpoint(base: string, path: string): string {
  return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`).toString();
}

/**
 * Ask the catalogue something, and read the answer.
 *
 * ⚠ **No credential, ever.** The catalogue has no authentication and is not
 * going to grow any: it answers `GET` and `OPTIONS` and nothing else, and
 * publishing is a CLI inside its own container. Sending this app's credential to
 * a third origin would be exactly what `cp.ts`'s standing "only ever to this
 * origin" rule exists to prevent.
 *
 * No cache of our own either. The service sends `cache-control: max-age=60` with
 * an `ETag`, so the browser revalidates by itself and a second visit to the
 * screen is a `304`. That is a cache this client does not have to invalidate and
 * therefore cannot get wrong — and the deliberately absent
 * `stale-while-revalidate` is what makes a plugin withdrawn from the catalogue
 * stop being offered within the minute.
 *
 * ⚠ **Relying on the browser's own cache is not merely tidier here, it is the
 * only thing that works — and the alternative fails *silently*.** The catalogue
 * sends no `access-control-expose-headers`, so `ETag` is unreadable from script
 * cross-origin; and `If-None-Match` is not a safelisted request header, so setting
 * one by hand triggers a preflight the service does not answer. Hand-rolled
 * revalidation would therefore not throw and not warn — it would just get a plain
 * `200` every time and quietly do more work than doing nothing. Measured against
 * the live service. If that ever needs to change it is two lines in the
 * catalogue's own CORS, not a change here.
 *
 * The reader is passed in rather than switched on the path, so the three
 * endpoints share one transport and one set of failure arms while each keeps its
 * own shape rule.
 */
export async function fetchCatalogue(
  base: string,
  path: string,
  read: (raw: unknown) => CatalogueRead,
): Promise<CatalogueRead> {
  let response: Response;
  let url: string;
  try {
    url = catalogueEndpoint(base, path);
  } catch (error) {
    // A base that is not a URL. `instance.ts` already refuses one, so this is the
    // belt rather than the braces — but `new URL` throws rather than answering,
    // and an exception escaping a fetch helper would take the screen down.
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) });
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    return {
      kind: "unreachable",
      reason: response.status === 404 ? "the catalogue has no such plugin" : `the catalogue answered ${response.status}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }
  return read(body);
}

/** The three addresses, in one place so a screen never spells one. */
export const CATALOGUE_PATHS = {
  list: "api/plugins/list",
  get: (id: string): string => `api/plugins/get/${encodeURIComponent(id)}`,
  versions: (id: string): string => `api/plugins/versions/${encodeURIComponent(id)}`,
} as const;

/**
 * The one sentence a screen says when a read did not produce entries.
 *
 * Here rather than in the components for `pluginFailure`'s reason: three screens
 * draw these same four states, and a refusal worded three ways is three chances
 * to word one of them badly.
 */
export function catalogueNotice(read: CatalogueRead): string | null {
  switch (read.kind) {
    case "ok":
      return read.entries.length === 0 ? "There is nothing in the catalogue yet." : null;
    case "too_new":
      /*
       * ⚠ **Named as the app being behind, not the catalogue being wrong**, and
       * pointing at the remedy that exists. The web client rides the control
       * plane's image, so "update" here means whoever runs the control plane
       * deploys — which is a different person from the one reading this on a
       * phone, and the sentence has to survive that.
       */
      return "This catalogue is newer than this app. Nothing here can be read safely until the app is updated.";
    case "malformed":
      return `The catalogue could not be read: ${read.reason}.`;
    case "unreachable":
      return `The catalogue could not be reached: ${read.reason}.`;
  }
}
