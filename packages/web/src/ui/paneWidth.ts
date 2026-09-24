// No DOM here: webcheck imports it with only a stubbed `window`.
// The width travels as a CSS custom property, so a re-render mid-drag cannot snap the pane back.

/** `width` answering `null` means nobody chose, so the stylesheet's breakpoints stand; `reset` hands them back. */
export interface PaneWidth {
  readonly min: number;
  readonly max: number;
  readonly prop: string;
  clamp(px: number): number;
  width(): number | null;
  setWidth(px: number): void;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

/** `unset` is null where the stylesheet decides; `fallback` is what a non-number clamps to. */
export function createPaneWidth(spec: {
  key: string;
  min: number;
  max: number;
  unset: number | null;
  fallback: number;
  prop: string;
}): PaneWidth {
  const clamp = (px: number): number => {
    if (!Number.isFinite(px)) return spec.fallback;
    return Math.min(spec.max, Math.max(spec.min, Math.round(px)));
  };

  const read = (): number | null => {
    try {
      const raw = window.localStorage.getItem(spec.key);
      if (raw === null) return spec.unset;
      return clamp(Number.parseInt(raw, 10));
    } catch {
      // Private mode or quota: the unset width is a working app.
      return spec.unset;
    }
  };

  let committed = read();
  const listeners = new Set<() => void>();
  const announce = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    min: spec.min,
    max: spec.max,
    prop: spec.prop,
    clamp,
    width: (): number | null => committed,
    setWidth: (px: number): void => {
      const next = clamp(px);
      if (next === committed) return;
      committed = next;
      try {
        window.localStorage.setItem(spec.key, String(next));
      } catch {
        // The in-memory value still works this session.
      }
      announce();
    },
    // Removes the key: a stored default would still beat the stylesheet's breakpoints.
    reset: (): void => {
      if (committed === spec.unset) return;
      committed = spec.unset;
      try {
        window.localStorage.removeItem(spec.key);
      } catch {
        // As above. The in-memory value is what the shell reads.
      }
      announce();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
