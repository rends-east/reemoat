// Fetches a plugin from one hardcoded host on a person's request; never polls or discovers (Q1.9, Q1.615, Q7.104, Q7.106).

import type { PluginManifest } from "./protocol.js";

/** A repository and a commit, never a URL: the address is built here, so the host is a real fence. */
export interface PluginSource {
  kind: "github";
  repo: string;
  commit: string;
}

export interface PluginConsent {
  scopes: readonly string[];
  net: readonly string[];
  hooks: readonly string[];
  /** Contributions as addedLine strings; absent means empty, not anything. */
  adds: readonly string[];
}

export function addedLine(one: { kind: "harness"; id: string; argv: readonly string[] } | { kind: "system"; id: string; baseUrl: string | null }): string {
  return one.kind === "harness"
    ? `harness ${one.id} runs ${one.argv.join(" ")}`
    : `system ${one.id} sends keys to ${one.baseUrl ?? "nowhere"}`;
}

export function addedLines(manifest: PluginManifest): string[] {
  return [
    ...manifest.contributes.harnesses.map((one) =>
      addedLine({ kind: "harness", id: one.id, argv: [one.command, ...one.args] }),
    ),
    ...manifest.contributes.systems.map((one) => addedLine({ kind: "system", id: one.id, baseUrl: one.baseUrl })),
  ];
}

export interface SourceRefusal {
  code: string;
  message: string;
}

// Codeload directly: the github.com archive form redirects, and redirects are refused.
const ARCHIVE_HOST = "codeload.github.com";

// Anchored and bounded: it is interpolated into a URL path, so no extra segment may slip in.
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// A full sha only: a tag moves and a short sha can be made to collide.
const COMMIT = /^[0-9a-f]{40}$/;

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
      message: "commit must be a full 40-character commit sha — a tag or a short sha is not a pin",
    };
  }
  return { kind: "github", repo, commit };
}

export function isSourceRefusal(value: object): value is SourceRefusal {
  return "code" in value && "message" in value;
}

function archiveUrlFor(source: PluginSource): string {
  return `https://${ARCHIVE_HOST}/${source.repo}/tar.gz/${source.commit}`;
}

export function sourceLabel(source: PluginSource): string {
  return `github:${source.repo}@${source.commit}`;
}

/** Reports only what was gained, over fields that survive parseManifest normalisation unchanged. */
export function consentGap(consent: PluginConsent, manifest: PluginManifest): string | null {
  const gained = (declared: readonly string[], agreed: readonly string[]): string[] => {
    const known = new Set(agreed);
    return declared.filter((one) => !known.has(one));
  };
  const scopes = gained(manifest.scopes, consent.scopes);
  const net = gained(manifest.net, consent.net);
  const hooks = gained(manifest.contributes.hooks, consent.hooks);
  // Refuses a contribution an older client could not have drawn: its consent carries no adds.
  const adds = gained(addedLines(manifest), consent.adds);
  const parts: string[] = [];
  if (scopes.length > 0) parts.push(`it may ${scopes.join(", ")}`);
  if (net.length > 0) parts.push(`it reaches ${net.join(", ")}`);
  if (hooks.length > 0) parts.push(`it is told when ${hooks.join(", ")}`);
  if (adds.length > 0) parts.push(`it adds ${adds.join("; ")}`);
  if (parts.length === 0) return null;
  return `that commit asks for more than was shown: ${parts.join("; ")}`;
}

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

// Below the client's 90s route budget, so this refusal is what a person sees.
export const PLUGIN_SOURCE_TIMEOUT_MS = 30_000;

export type ArchiveFetcher = (url: string, signal: AbortSignal) => Promise<Response>;

export interface ArchiveAnswer {
  body: ReadableStream<Uint8Array>;
  done: () => void;
}

/** Size is bounded by unpackArchive as it streams (codeload sends no content-length); redirects are refused. */
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
      message: `${ARCHIVE_HOST} did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!answer.ok) {
    // Cancelled rather than left open: a refusal that stops reading parks the sender.
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

/** No credential and no redirects: a private repository is a 404 on purpose. */
export const REAL_ARCHIVE_FETCHER: ArchiveFetcher = (url, signal) =>
  fetch(url, { redirect: "error", signal });
