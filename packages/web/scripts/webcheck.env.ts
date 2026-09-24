// Evaluated first (webcheck.modules.ts imports it for that) so the `window` stub exists before any packages/web/src module body runs.

let failures = 0;
let skipped = 0;

export function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

/** Counted and shown in the summary, but does not fail the run: a skip is not a pass. */
export function skip(name: string, detail: string): void {
  skipped += 1;
  process.stdout.write(`  skip  ${name}  (${detail})\n`);
}

export function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        ${detail}\n`);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const storage = new Map<string, string>();
(globalThis as Record<string, unknown>)["window"] = {
  // Read by native.ts's controlPlaneOrigin(); add only fields a real browser answers the same way.
  location: { href: "http://127.0.0.1/", origin: "http://127.0.0.1", protocol: "http:" },
  localStorage: {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => void storage.set(key, value),
    removeItem: (key: string): void => void storage.delete(key),
  },
};

// Deliberately without `startViewTransition`, so every navigate() takes the plain, unanimated path.
(globalThis as Record<string, unknown>)["document"] = {
  documentElement: { dataset: {} as Record<string, string> },
};

export function finish(): void {
  const tail = skipped === 0 ? "" : ` (${skipped} skipped)`;
  process.stdout.write(failures === 0 ? `\nall green${tail}\n\n` : `\n${failures} FAILED${tail}\n\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Test-only ChannelFactory over `fetch` for routing checks; the real Noise channel is driven in webcheck.e2ee.ts. */
export const fetchChannel = ((options: { relayUrl: string }) => ({
  async request(wanted: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Uint8Array | null;
  }): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: Uint8Array }> {
    const response = await fetch(new URL(wanted.path, options.relayUrl), {
      method: wanted.method,
      headers: wanted.headers ?? {},
      ...(wanted.body === null || wanted.body === undefined ? {} : { body: wanted.body as Uint8Array<ArrayBuffer> }),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body: new Uint8Array(await response.arrayBuffer()),
    };
  },
  openSocket(path: string): unknown {
    const url = new URL(path, options.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url.toString());
  },
  dispose(): void {},
})) as never;
