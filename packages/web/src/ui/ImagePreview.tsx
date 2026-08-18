import { useEffect, useState, type ReactNode } from "react";

/**
 * An image, fetched with a credential and drawn inline.
 *
 * **`<img>` and nothing else, from a `blob:` URL this component owns.** A blob
 * URL inherits the origin that created it, and this origin's `localStorage` holds
 * the control-plane credential this session runs on. `<img>` cannot execute script for any
 * content it accepts — but a top-level document from the same URL can, so the
 * rules that go with this component are: never `window.open`, never a link
 * without `download`, never an `<iframe>`. `preview.ts`'s allowlist is the other
 * half, and it excludes SVG precisely so none of this rests on engines agreeing
 * that `<img>` disables scripting.
 *
 * The URL is never put in the DOM by anything but this element, and never
 * persisted: an authenticated fetch produces it, and the cache below owns its
 * lifetime.
 */

/** How many decoded images are held at once, and how much they may weigh. */
const MAX_CACHED = 12;
const MAX_CACHED_BYTES = 48 * 1024 * 1024;

interface Entry {
  url: string;
  bytes: number;
}

/*
 * A module-level LRU, and it exists for a measured reason rather than tidiness.
 *
 * The transcript renders up to 400 events and a phone scrolls through them
 * freely. Without a cache, every scroll past an old message re-pulls the whole
 * image through the relay; with a cache but no eviction, every object URL lives
 * until the tab closes, which is a leak of exactly the size of the pictures
 * somebody has looked at. So: keyed by `(session, id)`, oldest evicted first,
 * and **revoked** on eviction — the revoke is the part that actually frees the
 * bytes, and dropping the map entry alone would not.
 */
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<string | null>>();

function evictIfNeeded(): void {
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  while (cache.size > MAX_CACHED || total > MAX_CACHED_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) return;
    const entry = cache.get(oldest.value);
    if (entry !== undefined) {
      URL.revokeObjectURL(entry.url);
      total -= entry.bytes;
    }
    cache.delete(oldest.value);
  }
}

async function load(cacheKey: string, fetcher: () => Promise<Blob>): Promise<string | null> {
  const hit = cache.get(cacheKey);
  if (hit !== undefined) {
    // Touch, so the LRU order reflects what is actually being looked at.
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return hit.url;
  }
  const running = inFlight.get(cacheKey);
  // Two rows for one image — a chip and the same file named in prose — must not
  // fetch it twice.
  if (running !== undefined) return running;

  const promise = (async () => {
    try {
      const blob = await fetcher();
      /*
       * **Left as `application/octet-stream`, which is what the daemon sent.**
       *
       * This comment used to claim the blob was re-typed to its own image type,
       * and no re-typing happened — the code below is exactly what it was. The
       * claim is removed rather than implemented, because the current behaviour
       * is the safe one and `download.ts` next door spends a docblock saying
       * that re-typing *to* `application/octet-stream` is the line that must not
       * change. An `<img>` sniffs the bytes and renders it regardless; a
       * top-level document from the same URL would not be given a type it could
       * execute.
       *
       * If a declared type is ever genuinely needed, it must come from
       * `PREVIEWABLE_TYPES` after the `previewable()` gate — never from the
       * event's `mime`, which is a string an agent chose.
       */
      const url = URL.createObjectURL(blob);
      cache.set(cacheKey, { url, bytes: blob.size });
      evictIfNeeded();
      return url;
    } catch {
      // A preview that cannot load is not an error worth a toast — the download
      // button beside it still works and says what went wrong when pressed.
      return null;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();
  inFlight.set(cacheKey, promise);
  return promise;
}

export function ImagePreview({
  cacheKey,
  fetcher,
  alt,
}: {
  cacheKey: string;
  fetcher: () => Promise<Blob>;
  alt: string;
}): ReactNode {
  const [url, setUrl] = useState<string | null>(() => cache.get(cacheKey)?.url ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    void load(cacheKey, fetcher).then((next) => {
      if (!live) return;
      if (next === null) setFailed(true);
      else setUrl(next);
    });
    return () => {
      // Deliberately **not** revoking here. The cache owns the URL's lifetime, and
      // revoking on unmount would free a picture the reader is about to scroll
      // back to — turning the cache into a guarantee of refetching.
      live = false;
    };
  }, [cacheKey, fetcher]);

  if (failed || url === null) return null;
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className="mt-1.5 max-h-64 w-auto max-w-full rounded-md border border-edge object-contain"
    />
  );
}
