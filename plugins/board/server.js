// The reference plugin for screen, settings, actions and hooks; read it beside docs/PLUGINS.md.
// Plain JavaScript on purpose: a plugin must not depend on the daemon's toolchain.

// Adding a column is an update; cards survive it because plugin_data is keyed on the plugin id, not its version.
const COLUMNS = [
  { id: "todo", title: "Todo" },
  { id: "doing", title: "Doing" },
  { id: "done", title: "Done" },
];

const CARD = "card:";

function shortPath(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.slice(-2).join("/") || path;
}
const SETTINGS = "settings";

async function settingsOf(ctx) {
  const held = await ctx.store.get(SETTINGS);
  // A plugin's defaults live in the plugin: unset means never saved.
  return { advanceOnTurn: held?.advanceOnTurn !== false };
}

async function cards(ctx) {
  const out = [];
  // One entries call per page, never a get per card. The next page starts after the last key returned.
  let after = "";
  for (;;) {
    const page = await ctx.store.entries(CARD, after);
    for (const entry of page.entries) {
      if (entry.value !== null) out.push({ ...entry.value, session: entry.key.slice(CARD.length) });
    }
    // The length check stops an empty page that claims more from looping forever.
    if (!page.more || page.entries.length === 0) break;
    after = page.entries[page.entries.length - 1].key;
  }
  // Newest first, ties broken on the session id so the board never reorders under a thumb.
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

/** Named screen: the export the host calls for contributes.screen. */
export async function screen(ctx) {
  const held = await cards(ctx);
  return {
    title: "Board",
    // The host floors this at two seconds and pauses it in a background tab.
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
              // Read off the end of COLUMNS: the same column session.ended moves a card to.
              tone: card.column === COLUMNS[COLUMNS.length - 1].id ? "ok" : null,
              // A destination in this app, never a URL.
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
  // session when pressed from a session's menu, row when pressed on this screen.
  const session = event.session ?? event.row ?? null;

  if (event.action === "save") {
    await ctx.store.set(SETTINGS, { advanceOnTurn: event.form?.advanceOnTurn === "true" });
    return { kind: "toast", text: "Saved", tone: "default" };
  }

  if (session === null) return { kind: "toast", text: "That was not about a card", tone: "danger" };

  if (event.action === "forget") {
    await ctx.store.delete(CARD + session);
    // Returning a view redraws the board, so the row disappears.
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
    // Only if there is no card, so a fresh install's seeding cannot overwrite a board already in use.
    const existing = await ctx.store.get(CARD + session.id);
    if (existing !== null) return;
    await ctx.store.set(CARD + session.id, {
      // A new session has no title yet, so fall back to the tail of its workspace path.
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
    // Only out of the first column, so a finished card never walks backwards.
    if (card !== null && card.column === "todo") await move(ctx, session.id, "doing");
    return;
  }

  if (event.hook === "session.ended") {
    const card = await ctx.store.get(CARD + session.id);
    if (card !== null) await move(ctx, session.id, COLUMNS[COLUMNS.length - 1].id);
  }
}
