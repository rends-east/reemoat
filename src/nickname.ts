/** A session's handle: what a person types after `@` and what other agents address it by. Q2.245. */

export const MIN_NICKNAME_CHARS = 2;
export const MAX_NICKNAME_CHARS = 32;

/** No underscore: `PeerHub.resolve` reads an underscored word as a session id. Passes every daemon's `isPeerName`. */
export const NICKNAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Mirrored in packages/web/src/nickname.ts, and webcheck compares the two. None is a harness id or a word people write after `@` anyway. */
export const NICKNAMES: readonly string[] = [
  "ada", "alba", "alma", "amos", "anya", "arlo", "asha", "aura", "basil", "bea",
  "bruno", "cara", "cleo", "cora", "dara", "dina", "eden", "elio", "elsa", "emil",
  "enzo", "esme", "ezra", "fern", "finn", "flora", "frida", "gaia", "gus", "hana",
  "hugo", "ida", "ilse", "indy", "ines", "iris", "ivo", "ivy", "jada", "joni",
  "juno", "kaia", "kira", "lana", "lars", "lea", "leo", "lina", "lior", "lola",
  "lou", "luca", "luna", "lyra", "mae", "maia", "mako", "mara", "mila", "milo",
  "mira", "moss", "nadia", "nell", "nico", "nina", "noa", "nora", "nova", "odin",
  "olga", "olive", "omar", "oona", "orla", "otto", "pax", "pia", "pip", "quin",
  "rafa", "remy", "rhea", "rio", "rita", "romy", "rosa", "ruby", "rune", "sage",
  "sami", "sol", "suki", "sven", "tara", "tess", "theo", "tove", "uma", "una",
  "vera", "vida", "vito", "wren", "xena", "yara", "yuki", "yuri", "zadie", "zara",
  "zeno", "zoe", "zola",
];

export function isNickname(value: string): boolean {
  return value.length >= MIN_NICKNAME_CHARS && value.length <= MAX_NICKNAME_CHARS && NICKNAME.test(value);
}

/** What a person typed, as it will be stored, or null when it cannot be one. */
export function normalizeNickname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return isNickname(value) ? value : null;
}

/** A free name from the list, else one of them with the first free `-2`, `-3`… suffix. */
export function pickNickname(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  const free = NICKNAMES.filter((name) => !taken.has(name));
  if (free.length > 0) return free[Math.floor(random() * free.length)]!;
  const base = NICKNAMES[Math.floor(random() * NICKNAMES.length)]!;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
