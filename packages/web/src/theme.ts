/** Which palette the page is drawn in; index.css keys the dark one on `data-theme` (Q3.669). */
export type Theme = "light" | "dark";

/**
 * The switch's choice, kept per device rather than per account: every seat shares one store, and signing out keeps it.
 * public/theme.js reads the same key before the first paint.
 */
export const THEME_KEY = "reemoat.theme";

/** Held here too, so a switch still works for this page where storage refuses the write. */
let held: Theme = "light";
let shown: Theme = "light";
const listeners = new Set<() => void>();
let tellHost: ((theme: Theme) => void) | null = null;

/** Light until the switch says dark; the system's appearance is not asked (Q3.670). */
export function chosenTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage refused: what this page was told is all there is.
  }
  return held;
}

export function currentTheme(): Theme {
  return shown;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTheme(theme: Theme): void {
  held = theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Kept in `held` for this page; the next launch is light again.
  }
  apply();
}

/** Once, from the app's entry point. `host` is the shell's window, told the theme so its title bar follows. */
export function installTheme(host?: (theme: Theme) => void): void {
  tellHost = host ?? null;
  apply();
  // Another account's webview flipped the switch: they share one store, and each draws its own document.
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY || event.key === null) apply();
  });
  // A hidden seat is refused by the host, so the one that comes on screen says it again.
  document.addEventListener("visibilitychange", syncHost);
}

function apply(): void {
  const next = chosenTheme();
  const root = document.documentElement;
  if (root.dataset["theme"] !== next) swap(root, next);
  shown = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  const ink = getComputedStyle(root).getPropertyValue("--color-ink").trim();
  if (meta !== null && ink !== "") meta.setAttribute("content", ink);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", next);
  syncHost();
  for (const listener of listeners) listener();
}

/** Transitions off until two frames have painted the new palette, so nothing fades between the two. */
function swap(root: HTMLElement, next: Theme): void {
  root.dataset["themeSwap"] = "";
  root.dataset["theme"] = next;
  void getComputedStyle(document.body).backgroundColor;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      delete root.dataset["themeSwap"];
    }),
  );
}

function syncHost(): void {
  if (tellHost !== null && document.visibilityState === "visible") tellHost(chosenTheme());
}
