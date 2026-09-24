// Recognition, not identification: a User-Agent is written by the caller, so these words decide nothing.

// Most specific first: each agent string also claims its predecessors, so an earlier Chrome or Safari would swallow Edge and the rest.
const BROWSERS: ReadonlyArray<readonly [needle: string, name: string]> = [
  ["EdgiOS", "Edge"],
  ["Edg", "Edge"],
  ["OPiOS", "Opera"],
  ["OPR", "Opera"],
  ["SamsungBrowser", "Samsung Internet"],
  ["CriOS", "Chrome"],
  ["FxiOS", "Firefox"],
  ["Firefox", "Firefox"],
  ["Chromium", "Chromium"],
  ["Chrome", "Chrome"],
  ["Safari", "Safari"],
];

// Linux last, since Android agents contain it; an iPad reporting Macintosh cannot be told from a Mac.
const PLATFORMS: ReadonlyArray<readonly [needle: string, name: string]> = [
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
  ["Android", "Android"],
  ["CrOS", "ChromeOS"],
  ["Macintosh", "macOS"],
  ["Mac OS X", "macOS"],
  ["Windows", "Windows"],
  ["Linux", "Linux"],
];

function firstMatch(ua: string, table: ReadonlyArray<readonly [string, string]>): string | null {
  for (const [needle, name] of table) {
    if (ua.includes(needle)) return name;
  }
  return null;
}

export function describeAgent(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== "string") return null;
  const ua = userAgent.trim();
  if (ua.length === 0) return null;

  const browser = firstMatch(ua, BROWSERS);
  const platform = firstMatch(ua, PLATFORMS);

  if (browser !== null && platform !== null) return `${browser} on ${platform}`;
  return browser ?? platform;
}

export function agentWasRecorded(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && userAgent.trim().length > 0;
}

export function deviceLine(userAgent: string | null | undefined): string {
  const described = describeAgent(userAgent);
  if (described !== null) return described;
  return agentWasRecorded(userAgent) ? "Unrecognised browser" : "Signed in before this was recorded";
}
