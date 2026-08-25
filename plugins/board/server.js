/**
 * A board, whose cards are this machine's sessions.
 *
 * This is the reference plugin: it uses all four contribution points and reaches
 * nothing outside the machine, which is what lets `daemoncheck` drive the whole
 * of it. Read it beside `docs/PLUGINS.md` — everything here is in that document,
 * and everything in that document is here.
 *
 * Plain JavaScript on purpose. The daemon happens to run under `tsx` today, so a
 * TypeScript `server.js` would also load; that is a measurement rather than a
 * promise, and a plugin must not depend on this daemon's toolchain.
 */

/**
 * The columns, in order.
 *
 * Adding one is what `docs/PLUGINS.md` walks through as an update: bump the
 * version in `plugin.json`, add a column here, reinstall. The cards survive it,
 * because `plugin_data` is keyed on the plugin's id and never on its version.
 */
const COLUMNS = [
  { id: "todo", title: "Todo" },
  { id: "doing", title: "Doing" },
  { id: "done", title: "Done" },
];

const CARD = "card:";

/** The last two segments of a path, which is the part somebody recognises. */
function shortPath(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.slice(-2).join("/") || path;
}
const SETTINGS = "settings";

async function settingsOf(ctx) {
  const held = await ctx.store.get(SETTINGS);
  // A plugin's own defaults live in the plugin, never in the host: an unset value
  // is "this has never been saved", and the plugin is the only thing that knows
  // what that should mean.
  return { advanceOnTurn: held?.advanceOnTurn !== false };
}

async function cards(ctx) {
  const out = [];
  /*
   * One call per page, never one per card.
   *
   * This was `keys()` and then an awaited `get()` for each of them, which reads
   * naturally and is a round trip to the daemon per card: at the 1000 keys a
   * plugin may hold that is 2002 messages and 1000 sequential turns of the
   * daemon's event loop, for a screen that asks to be re-read every five seconds
   * and is also what `advance` and `forget` return. Measured beside `entries`:
   * 20.9ms against 0.30ms for the same thousand cards.
   *
   * `more` is the host saying the page hit its byte budget rather than the end of
   * the data, and the next page starts after the last key this one handed back —
   * echoed rather than computed, because the order is the store's.
   */
  let after = "";
  for (;;) {
    const page = await ctx.store.entries(CARD, after);
    for (const entry of page.entries) {
      if (entry.value !== null) out.push({ ...entry.value, session: entry.key.slice(CARD.length) });
    }
    // The length test is not redundant with `more`: a page that is empty and
    // claims there is more would be a loop with no end, and a plugin is the wrong
    // place to find out that the host stopped being able to promise otherwise.
    if (!page.more || page.entries.length === 0) break;
    after = page.entries[page.entries.length - 1].key;
  }
  // Newest first inside a column, which is the order somebody scanning a board
  // wants. Ties broken on the session id so the list does not shuffle between
  // reads — a board that reorders under a thumb is the one thing this must not do.
  return out.sort((a, b) => b.at - a.at || a.session.localeCompare(b.session));
}

async function move(ctx, session, to) {
  const key = CARD + session;
  const card = await ctx.store.get(key);
  if (card === null) return null;
  const next = { ...card, column: to, at: Date.now() };
  await ctx.store.set(key, next);
  return next;
}

/** The board. Named `screen`, which is the export the host calls for `contributes.screen`. */
export async function screen(ctx) {
  const held = await cards(ctx);
  return {
    title: "Board",
    /*
     * Re-read while somebody is looking. The host floors this at two seconds and
     * stops it when the tab goes to the background, so the number here is a
     * preference rather than a promise — five is "a board that keeps up with an
     * agent" without being a thing that flickers.
     */
    refreshMs: 5_000,
    blocks: [
      {
        type: "columns",
        columns: COLUMNS.map((column) => ({
          title: column.title,
          rows: held
            .filter((card) => card.column === column.id)
            .map((card) => ({
              id: card.session,
              title: card.title,
              subtitle: card.agent ?? null,
              badge: null,
              // What the row *means*; the host picks the ink. A card in the last
              // column is finished, and `ok` is the tone for that. Read off the
              // end of `COLUMNS` rather than written as "done" so that it names
              // the same column `session.ended` moves a card to, which is the end
              // of the same list — one of the two written as a literal is how the
              // mark and the move come to disagree.
              tone: card.column === COLUMNS[COLUMNS.length - 1].id ? "ok" : null,
              // Tapping the card opens the session it is about. A destination
              // this app has, never a URL — see docs/PLUGINS.md.
              open: { session: card.session },
              actions: [
                { id: "advance", label: "Move on", tone: "plain", confirm: null },
                { id: "forget", label: "Forget", tone: "destructive", confirm: "Forget this card?" },
              ],
            })),
        })),
      },
      held.length === 0
        ? { type: "text", text: "Start a session and it appears here.", tone: "muted" }
        : { type: "text", text: `${held.length} cards`, tone: "muted" },
    ],
  };
}

export async function settings(ctx) {
  const held = await settingsOf(ctx);
  return {
    title: null,
    // No `refreshMs`: this is a form somebody types into, and the host would not
    // honour one here anyway. See `PluginSettings`.
    refreshMs: null,
    blocks: [
      {
        type: "form",
        submit: "Save",
        action: "save",
        fields: [
          {
            key: "advanceOnTurn",
            label: "Move a card on when a turn ends",
            kind: "toggle",
            value: held.advanceOnTurn ? "true" : "false",
            options: [],
            placeholder: null,
            help: "With this off, cards only move when you move them.",
          },
        ],
      },
    ],
  };
}

export async function action(ctx, event) {
  // `event.session` is set when the press came from a session's menu, `event.row`
  // when it came from a row on this screen. Either names the same thing here.
  const session = event.session ?? event.row ?? null;

  if (event.action === "save") {
    await ctx.store.set(SETTINGS, { advanceOnTurn: event.form?.advanceOnTurn === "true" });
    return { kind: "toast", text: "Saved", tone: "default" };
  }

  if (session === null) return { kind: "toast", text: "That was not about a card", tone: "danger" };

  if (event.action === "forget") {
    await ctx.store.delete(CARD + session);
    // Returning a view rather than a toast redraws the board under the press,
    // which is what makes a row disappear rather than merely being reported gone.
    return screen(ctx);
  }

  if (event.action === "advance") {
    const card = await ctx.store.get(CARD + session);
    if (card === null) return { kind: "toast", text: "No card for that session", tone: "danger" };
    const at = COLUMNS.findIndex((column) => column.id === card.column);
    const next = COLUMNS[Math.min(at + 1, COLUMNS.length - 1)];
    await move(ctx, session, next.id);
    return screen(ctx);
  }

  return { kind: "toast", text: "Nothing to do", tone: "default" };
}

export async function hook(ctx, event) {
  const session = event.session;
  if (session === undefined || session === null) return;

  if (event.hook === "session.created") {
    // Only if there is no card, so the seeding a fresh install does — every
    // session on the machine, announced at once — cannot overwrite a board
    // somebody has already been moving cards around on.
    const existing = await ctx.store.get(CARD + session.id);
    if (existing !== null) return;
    await ctx.store.set(CARD + session.id, {
      // A session has no title until somebody has sent it something, so a card
      // made at `session.created` falls back to where it is running — and to the
      // last two segments of that, because the whole path is a temp directory
      // three lines long on the machine this was written on.
      title: session.title ?? shortPath(session.workspace?.root) ?? session.id,
      agent: session.agent ?? null,
      column: "todo",
      at: Date.now(),
    });
    return;
  }

  if (event.hook === "turn.ended") {
    const held = await settingsOf(ctx);
    if (!held.advanceOnTurn) return;
    const card = await ctx.store.get(CARD + session.id);
    // Only out of the first column. A card somebody has moved to Done should not
    // walk backwards because the agent said one more thing.
    if (card !== null && card.column === "todo") await move(ctx, session.id, "doing");
    return;
  }

  if (event.hook === "session.ended") {
    const card = await ctx.store.get(CARD + session.id);
    if (card !== null) await move(ctx, session.id, COLUMNS[COLUMNS.length - 1].id);
  }
}
