// A hand mirror of src/nickname.ts (packages/web may not import src/); webcheck compares the list and every verdict. Q3.677.

export const MIN_NICKNAME_CHARS = 2;
export const MAX_NICKNAME_CHARS = 32;

export const NICKNAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

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

export function normalizeNickname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return isNickname(value) ? value : null;
}

/** The daemon's `pickNickname`: a free name from the list, else one of them with the first free `-2`, `-3`… suffix. */
export function randomNickname(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  const free = NICKNAMES.filter((name) => !taken.has(name));
  if (free.length > 0) return free[Math.floor(random() * free.length)]!;
  const base = NICKNAMES[Math.floor(random() * NICKNAMES.length)]!;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// One leading `@` is how the name is drawn everywhere, so a field holding one is not refused for it.
function withoutAt(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

/** What the field holds, as it will be sent. */
export function typedNickname(raw: string): string | null {
  return normalizeNickname(withoutAt(raw));
}

/** Why the field cannot be sent, or null exactly when `typedNickname` answers a name. */
export function nicknameProblem(raw: string): string | null {
  const value = withoutAt(raw).trim().toLowerCase();
  if (value.length === 0) return "A session needs a nickname — type one, or roll the dice.";
  if (isNickname(value)) return null;
  if (value.length > MAX_NICKNAME_CHARS) return `At most ${MAX_NICKNAME_CHARS} characters.`;
  if (/[^a-z0-9-]/.test(value)) return "Only latin letters, digits and hyphens.";
  if (!/^[a-z]/.test(value)) return "Start with a letter.";
  if (value.length < MIN_NICKNAME_CHARS) return `At least ${MIN_NICKNAME_CHARS} characters.`;
  return "A hyphen goes between two letters or digits.";
}

/** Every nickname among these rows; a row from a daemon older than nicknames has none. */
export function nicknamesIn(rows: Iterable<{ snapshot: { nickname?: string | null } }>): Set<string> {
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.snapshot.nickname;
    if (typeof name === "string") names.add(name);
  }
  return names;
}
