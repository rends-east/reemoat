/* ──────────────────────────────────────────────────────────────────────────
 * Installing a plugin from a commit somebody named, rather than from a file
 * somebody picked.
 *
 * ⚠ **This is the third `fetch` in `src/`, and the count is written down in
 * `.claude/rules/plugins.md` on purpose.** The other two are `enroll.ts` and
 * `net.fetch` made on a plugin's own behalf. What that rule protects is the
 * property that *the daemon asks the control plane nothing* — Q1.9, Q1.615 —
 * and this call does not go to the control plane. It goes to one hardcoded
 * host, on a request a person made, on no start path and no session path.
 *
 * What Q7.104 refused was **a registry to poll**, which would make somebody
 * else's outage able to stop an install on your own machine. Nothing here
 * polls, nothing here discovers, and nothing here updates a plugin by itself:
 * the catalogue lives in the browser's world entirely, and what reaches this
 * daemon is a repository and a commit that a person read the permissions of and
 * pressed a button about.
 *
 * Q7.106 assumed the browser could carry the bytes and it cannot:
 * `codeload.github.com` answers `access-control-allow-origin:
 * https://render.githubusercontent.com`, so a cross-origin fetch from the app's
 * own page is refused before it leaves. That is a measured fact about GitHub
 * rather than a change of mind, and it is the whole reason this file exists.
 *
 * Everything here except {@link fetchArchive} is pure, so `daemoncheck` reaches
 * every refusal with no network and no filesystem.
 * ────────────────────────────────────────────────────────────────────────── */

import type { PluginManifest } from "./protocol.js";

/**
 * Where an archive came from, as the client is allowed to say it.
 *
 * ⚠ **A repository and a commit, never a URL.** A URL from the caller is a URL
 * the caller chose, and this daemon would then be a general-purpose fetcher
 * running as its owner. The address is built here from two fields this file
 * validates itself — which makes the host a real fence, unlike the manifest's
 * `net` allowlist, whose own docblock correctly calls itself a spelling check.
 *
 * `kind` is a union of one. It is here so that a second forge is an added arm
 * rather than a second shape, and so the wire says which it meant rather than
 * leaving it to be inferred from the fields present.
 */
export interface PluginSource {
  kind: "github";
  repo: string;
  commit: string;
}

/**
 * What the person installing was shown, and therefore what they agreed to.
 *
 * ⚠ **Three fields, and it is deliberately not the manifest.** These are the
 * three that decide what a plugin can *do* on the machine: which host APIs it
 * may call, which hosts it may reach, and which events it is told about. A name
 * or a screen title being different is a cosmetic surprise; a scope being
 * different is somebody else's decision about your sessions.
 *
 * The narrowness is also what makes the check *work* rather than merely exist —
 * see {@link consentGap}.
 */
export interface PluginConsent {
  scopes: readonly string[];
  net: readonly string[];
  hooks: readonly string[];
  /**
   * The harnesses and providers a person was shown, each as one string.
   *
   * ⚠ **Flattened to strings, and that is what keeps this comparison working
   * rather than merely existing.** The other three fields are `readonly string[]`
   * on both sides, so `gained` is a set difference and there is nothing to
   * normalise. Objects here would put a shape reader in `readConsent`, and a shape
   * reader is exactly where a normalisation mismatch creeps in and the alarm starts
   * crying wolf on healthy plugins — which is the failure the three-field rule was
   * chosen to avoid in the first place.
   *
   * ⚠ **And the *whole* base URL is in the string, though the screen draws only
   * the origin.** A plugin that showed `https://api.groq.com` and shipped
   * `https://api.groq.com/../evil` passes an origin comparison; `parseManifest`
   * normalises the URL — `new URL` resolves `..` — so both sides are comparing the
   * address the daemon will actually send a key to.
   *
   * Optional on the wire for `compatibility.md`'s rule 2, and absent means the
   * empty list rather than "anything": a client too old to send them is one that
   * cannot have drawn them either, and `PluginHost` refuses an install whose
   * consent omits a contribution the manifest makes.
   */
  adds: readonly string[];
}

/**
 * One contributed harness or provider, as the exact string both sides compare.
 *
 * Built here and in the browser's mirror, and it is the *screen's* string rather
 * than a hash: whatever this returns is what the consent card has to have drawn,
 * because a disclosure and a comparison over two different renderings of the same
 * fact is two facts.
 */
export function addedLine(one: { kind: "harness"; id: string; argv: readonly string[] } | { kind: "system"; id: string; baseUrl: string | null }): string {
  return one.kind === "harness"
    ? `harness ${one.id} runs ${one.argv.join(" ")}`
    : `system ${one.id} sends keys to ${one.baseUrl ?? "nowhere"}`;
}

/** Every contributed line one manifest declares, in the order it declared them. */
export function addedLines(manifest: PluginManifest): string[] {
  return [
    ...manifest.contributes.harnesses.map((one) =>
      addedLine({ kind: "harness", id: one.id, argv: [one.command, ...one.args] }),
    ),
    ...manifest.contributes.systems.map((one) => addedLine({ kind: "system", id: one.id, baseUrl: one.baseUrl })),
  ];
}

/** Why a `{repo, commit}` is not one this daemon will fetch. */
export interface SourceRefusal {
  code: string;
  message: string;
}

/**
 * The only host this daemon will take a plugin from.
 *
 * `codeload` rather than `github.com/<repo>/archive/<commit>.tar.gz`, and that
 * is not a preference: measured, the `github.com` form answers `302` to this
 * host, and this file refuses redirects. Asking for the destination directly is
 * one hop fewer and one fewer thing to reason about.
 */
const ARCHIVE_HOST = "codeload.github.com";

/**
 * `owner/name`, in the character set GitHub actually allows.
 *
 * Anchored, and every segment bounded, because this string is interpolated into
 * a URL path. A `/` inside either half would let a caller reach a third path
 * segment and therefore a different endpoint on the same host.
 */
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * A full commit, and nothing else.
 *
 * ⚠ **No tags and no short shas, and this is a security decision rather than
 * pedantry.** A tag moves — `git tag -f` is one command — so a plugin installed
 * "at v1.2.0" is a plugin whose code can change under an identifier that did
 * not. A short sha is a prefix, and a prefix is a thing that can be made to
 * collide. What is being pinned here is code that will run as this machine's
 * owner with no sandbox, and the commit is the only content-addressed name
 * GitHub offers for it.
 */
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * What the wire said, as a source — or why it is not one.
 *
 * Refusals are specific because the two mistakes have different remedies: a
 * malformed repository is a client bug, and a tag where a commit belongs is
 * somebody doing a reasonable-looking thing this daemon will not do.
 */
export function readSource(raw: unknown): PluginSource | SourceRefusal {
  if (raw === null || typeof raw !== "object") {
    return { code: "plugin_source_invalid", message: "expected a source object" };
  }
  const body = raw as Record<string, unknown>;
  if (body["kind"] !== "github") {
    return { code: "plugin_source_invalid", message: "the only source this daemon installs from is github" };
  }
  const repo = body["repo"];
  const commit = body["commit"];
  if (typeof repo !== "string" || !REPO.test(repo)) {
    return { code: "plugin_source_invalid", message: "repo must be spelled owner/name" };
  }
  if (typeof commit !== "string" || !COMMIT.test(commit)) {
    return {
      code: "plugin_source_invalid",
      // Names the thing somebody will actually have tried. A tag and a short sha
      // are both well-formed-looking and both refused, and "invalid commit" sends
      // them looking for a typo that is not there.
      message: "commit must be a full 40-character commit sha — a tag or a short sha is not a pin",
    };
  }
  return { kind: "github", repo, commit };
}

/**
 * Whether a two-armed answer from this file is the refusal arm.
 *
 * Typed against `object` rather than a named union so that both producers here —
 * {@link readSource} and {@link fetchArchive} — narrow through one guard. The
 * discriminant is the pair rather than `code` alone: `PluginSource` has neither
 * field, and asking for both is what keeps this honest if a future success shape
 * grows a `code` of its own.
 */
export function isSourceRefusal(value: object): value is SourceRefusal {
  return "code" in value && "message" in value;
}

/**
 * Where the archive for this source lives. Built here, never taken from a caller.
 *
 * File-local, and that is the honest standing rather than an oversight: the one
 * caller is {@link fetchArchive} below. Exported, it reads as an address other
 * modules may build — which is the opposite of what {@link PluginSource}'s own
 * docblock is about, where the whole point is that exactly one place decides what
 * URL this daemon fetches.
 */
function archiveUrlFor(source: PluginSource): string {
  return `https://${ARCHIVE_HOST}/${source.repo}/tar.gz/${source.commit}`;
}

/**
 * What goes in the row's `source` column.
 *
 * Written and never read for a decision, exactly as the archive filename was
 * before it — so this is a record of where something came from rather than a
 * key anything resolves.
 */
export function sourceLabel(source: PluginSource): string {
  return `github:${source.repo}@${source.commit}`;
}

/**
 * What the plugin turned out to want that nobody agreed to — or `null`.
 *
 * ⚠ **Compare like against like.** Three of the four compared fields survive
 * normalisation untouched; the fourth is built by `addedLines` below.
 * `parseManifest`
 * **normalises**: it trims `name` and every action title, turns an absent
 * `description` into `null`, and synthesises an absent `contributes` into
 * `{screen: null, settings: false, actions: [], hooks: []}`. A plugin that
 * simply did not write a `contributes` block therefore does not match its own
 * raw `plugin.json` field for field — and a check that fired on that would fire
 * on most plugins, which is how people learn to click through the one alarm this
 * whole path exists to raise.
 *
 * Scopes, hosts and hooks survive that normalisation as plain string arrays on
 * both sides, which is the other half of why those three need no normalising.
 *
 * **One direction only.** A plugin asking for *less* than it was shown is not a
 * breach of anything — it is a person who agreed to more than they had to — so
 * only what was *gained* is reported. Same rule and same reason as
 * `consentBroken` in `packages/web/src/plugins.ts`, which is this check's
 * after-the-fact counterpart on the upload path.
 */
export function consentGap(consent: PluginConsent, manifest: PluginManifest): string | null {
  const gained = (declared: readonly string[], agreed: readonly string[]): string[] => {
    const known = new Set(agreed);
    return declared.filter((one) => !known.has(one));
  };
  const scopes = gained(manifest.scopes, consent.scopes);
  const net = gained(manifest.net, consent.net);
  const hooks = gained(manifest.contributes.hooks, consent.hooks);
  /*
   * ⚠ **The fourth comparison, and it is the one that makes an *older client*
   * safe.** A browser deployed before contributions existed draws no row for them,
   * `catalogue.ts`'s tolerance of unknown fields guarantees it goes on working, and
   * therefore guarantees it under-discloses — there is no fix on that side. What it
   * sends is a consent with no `adds`, so a commit that adds a harness is refused
   * here with a sentence instead of installing a command line nobody was shown.
   */
  const adds = gained(addedLines(manifest), consent.adds);
  const parts: string[] = [];
  if (scopes.length > 0) parts.push(`it may ${scopes.join(", ")}`);
  if (net.length > 0) parts.push(`it reaches ${net.join(", ")}`);
  if (hooks.length > 0) parts.push(`it is told when ${hooks.join(", ")}`);
  if (adds.length > 0) parts.push(`it adds ${adds.join("; ")}`);
  if (parts.length === 0) return null;
  return `that commit asks for more than was shown: ${parts.join("; ")}`;
}

/** What the wire said, as a consent — or `null` for a caller that sent none. */
export function readConsent(raw: unknown): PluginConsent | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
  return {
    scopes: strings(body["scopes"]),
    net: strings(body["net"]),
    hooks: strings(body["hooks"]),
    adds: strings(body["adds"]),
  };
}

/**
 * How long the archive has to arrive.
 *
 * Longer than `net.fetch`'s ten seconds, because codeload generates the tarball
 * on the fly for a commit nobody has asked for recently, and shorter than the
 * client's own 90s budget for this route so the daemon's refusal is what the
 * person sees rather than a transport failure that drops their route memo.
 */
export const PLUGIN_SOURCE_TIMEOUT_MS = 30_000;

/**
 * The seam, and the reason it is one.
 *
 * `daemoncheck` has no network. `PluginRuntime` and `PluginScheduler` are both
 * interfaces with one implementation for exactly this reason, and a seam nothing
 * can use is worse than no seam — which is the lesson `PluginScheduler`'s own
 * docblock records about the `now` that could never age a backoff.
 */
export type ArchiveFetcher = (url: string, signal: AbortSignal) => Promise<Response>;

export interface ArchiveAnswer {
  body: ReadableStream<Uint8Array>;
  /** Released whatever happens: the caller may return before the body is drained. */
  done: () => void;
}

/**
 * Ask for the archive, and hand back a body to unpack.
 *
 * ⚠ **Nothing here bounds the size, and that is correct rather than an
 * omission.** Measured: codeload sends **no `content-length`** — the tarball is
 * generated as it is sent — so a guard built on that header bounds precisely
 * nothing on the one URL this function fetches. The real bound is
 * `unpackArchive` charging `written += chunk.byteLength` against
 * `PLUGIN_LIMITS.maxBytes` as it reads, which is why the body is streamed
 * straight through rather than buffered here first. A `content-length` check
 * would only ever be a way to refuse *earlier* when the header happens to exist,
 * and adding one would invite the next reader to believe it was the bound.
 *
 * ⚠ **Redirects are refused rather than followed**, `net.fetch`'s posture. Both
 * of the URLs this daemon reaches — the archive here, and nothing else — answer
 * `200` directly; it is the `github.com/<repo>/archive/…` spelling that
 * redirects, and that spelling is not built anywhere.
 */
export async function fetchArchive(
  source: PluginSource,
  fetcher: ArchiveFetcher,
): Promise<ArchiveAnswer | SourceRefusal> {
  const url = archiveUrlFor(source);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLUGIN_SOURCE_TIMEOUT_MS);
  const done = (): void => clearTimeout(timer);

  let answer: Response;
  try {
    answer = await fetcher(url, controller.signal);
  } catch (error) {
    done();
    return {
      code: "plugin_source_unavailable",
      // The host is named because the remedy differs by which one it is: a
      // machine with no route out says something different from a commit that
      // does not exist.
      message: `${ARCHIVE_HOST} did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!answer.ok) {
    // The body is drained rather than left open: a refusal that stops reading
    // parks the sender, which is the same discipline the relay forces on every
    // streaming route here.
    await answer.body?.cancel().catch(() => {
      // Already closed, or never had one.
    });
    done();
    return {
      code: answer.status === 404 ? "plugin_source_not_found" : "plugin_source_unavailable",
      message:
        answer.status === 404
          ? "that repository and commit are not there, or the repository is private"
          : `${ARCHIVE_HOST} answered ${answer.status}`,
    };
  }

  if (answer.body === null) {
    done();
    return { code: "plugin_source_unavailable", message: `${ARCHIVE_HOST} answered with no body` };
  }

  return { body: answer.body as ReadableStream<Uint8Array>, done };
}

/**
 * The default fetcher: the third `fetch` call in `src/`, and the one this file's
 * header is about.
 *
 * `redirect: "error"` and no headers beyond what the runtime sends. No
 * credential travels here — a private repository is a `404` and is meant to be.
 */
export const REAL_ARCHIVE_FETCHER: ArchiveFetcher = (url, signal) =>
  fetch(url, { redirect: "error", signal });
