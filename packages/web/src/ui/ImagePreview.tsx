import { useEffect, useState, type ReactNode } from "react";

// A blob URL inherits this origin: draw it only in an img, never via window.open, a link without download, or an iframe.

const MAX_CACHED = 12;
const MAX_CACHED_BYTES = 48 * 1024 * 1024;

interface Entry {
  url: string;
  bytes: number;
}

// An LRU that revokes on eviction, since the revoke is what frees the bytes.
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
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return hit.url;
  }
  const running = inFlight.get(cacheKey);
  if (running !== undefined) return running;

  const promise = (async () => {
    try {
      const blob = await fetcher();
      // Left as octet-stream; a type, if ever needed, comes from PREVIEWABLE_TYPES and never from the agent's mime.
      const url = URL.createObjectURL(blob);
      cache.set(cacheKey, { url, bytes: blob.size });
      evictIfNeeded();
      return url;
    } catch {
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
      // Not revoked here: the cache owns the URL's lifetime.
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
