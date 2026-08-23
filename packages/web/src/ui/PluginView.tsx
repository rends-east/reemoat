import { useState, type ReactNode } from "react";
import { seedForm } from "../plugins";
import type { PluginBlock, PluginField, PluginOpen, PluginRow, PluginView as PluginViewShape } from "../wire";
import { Button, DangerButton, Dot, Empty, FIELD, Spinner } from "./bits";
import { Trash2 } from "lucide-react";

/**
 * A plugin's screen, drawn with this app's own components.
 *
 * **No plugin code runs in this origin, ever.** A plugin sends a description and
 * this file draws it, which is the one real security boundary the whole plugin
 * subsystem has: `reemoat.credential` sits in this origin's `localStorage`, and a
 * plugin bundle executing here would have it. Everything else about plugins — the
 * child process, the scope table, the stripped environment — is hygiene by
 * comparison, because the plugin already runs as this user on its own machine.
 *
 * It also buys three things that are not security and are worth as much daily: a
 * plugin screen matches the rest of the app without its author thinking about it,
 * works on a phone without its author thinking about it, and cannot make the
 * session list slow.
 *
 * Everything here is fed by `plugins.ts`, which has already dropped what it could
 * not read. So there is no unknown-block arm below: by the time a block arrives
 * here it is one of the five.
 */

export function PluginView({
  view,
  busy,
  onAction,
  onOpen,
}: {
  view: PluginViewShape;
  busy: boolean;
  /** A press. `row` is set from a row's action, `form` from a form's submit. */
  onAction: (actionId: string, context: { row?: string; form?: Record<string, string> }) => void;
  /** A row tapped. `null` from a caller with nowhere to go, which leaves rows inert. */
  onOpen?: ((where: PluginOpen) => void) | undefined;
}): ReactNode {
  if (view.blocks.length === 0) {
    return <Empty>This plugin drew nothing.</Empty>;
  }
  return (
    <div className="flex flex-col gap-5">
      {view.blocks.map((block, index) => (
        // Index as the key, deliberately. A block carries no id — the vocabulary
        // has none, because a plugin re-renders its whole view on every read
        // rather than patching it — so position is the only honest identity, and
        // inventing one from the contents would reorder text under somebody's
        // cursor the first time two blocks matched.
        <Block key={index} block={block} busy={busy} onAction={onAction} onOpen={onOpen} />
      ))}
    </div>
  );
}

function Block({
  block,
  busy,
  onAction,
  onOpen,
}: {
  block: PluginBlock;
  busy: boolean;
  onAction: (actionId: string, context: { row?: string; form?: Record<string, string> }) => void;
  onOpen?: ((where: PluginOpen) => void) | undefined;
}): ReactNode {
  switch (block.type) {
    case "text":
      // `whitespace-pre-wrap`, so a plugin's own line breaks survive — and no
      // markdown. Markdown here would mean a link, and a link whose href a plugin
      // chose is the sink `Markdown.tsx` already refuses for agent output.
      return (
        <p className={`text-sm whitespace-pre-wrap wrap-anywhere ${block.tone === "muted" ? "text-muted" : "text-fg"}`}>{block.text}</p>
      );

    case "notice":
      return (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            block.tone === "danger" ? "border-edge-strong text-fg" : "border-edge text-muted"
          }`}
        >
          {block.text}
        </div>
      );

    case "list":
      return block.rows.length === 0 ? (
        <Empty>{block.empty || "Nothing here."}</Empty>
      ) : (
        <ul className="flex flex-col">
          {block.rows.map((row) => (
            <Row key={row.id} row={row} busy={busy} onAction={onAction} onOpen={onOpen} />
          ))}
        </ul>
      );

    case "columns":
      /*
       * Columns side by side above `sm`, stacked below it — in CSS, never in
       * JavaScript. `AppShell`'s rule holds here for its reason: a breakpoint read
       * in JS renders a layout the viewport does not have the moment a window is
       * resized, and this screen is drawn on a phone more often than not.
       *
       * `overflow-x-auto` on the strip and `min-w-0` inside it: a board with six
       * columns scrolls itself rather than making the page scroll sideways.
       */
      return (
        <div className="flex flex-col gap-4 overflow-x-auto sm:flex-row">
          {block.columns.map((column, index) => (
            /*
             * `min-w-40` rather than `min-w-56`, measured: the sheet's pane is
             * 672px, so at 224px a *three*-column board already overflowed and the
             * last column's actions were clipped by the panel edge. The strip
             * scrolls by design — a board may have eight columns — but it must not
             * scroll for the ordinary case. At 160px three fit with room and four
             * fit exactly; past that it scrolls, which is the honest answer.
             */
            <section key={index} className="min-w-0 flex-1 sm:min-w-40">
              <h3 className="mb-1.5 text-2xs font-semibold tracking-wider text-muted uppercase">{column.title}</h3>
              {column.rows.length === 0 ? (
                <p className="text-sm text-muted">—</p>
              ) : (
                <ul className="flex flex-col">
                  {column.rows.map((row) => (
                    <Row key={row.id} row={row} busy={busy} onAction={onAction} onOpen={onOpen} />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      );

    case "form":
      return <Form block={block} busy={busy} onAction={onAction} />;
  }
}

function Row({
  row,
  busy,
  onAction,
  onOpen,
}: {
  row: PluginRow;
  busy: boolean;
  onAction: (actionId: string, context: { row?: string }) => void;
  onOpen?: ((where: PluginOpen) => void) | undefined;
}): ReactNode {
  /*
   * The two-step confirmation, per row, exactly as a settings row does it — and
   * for the measured reason: both groups lay out in the same box so the last child
   * occupies the same pixels, `setConfirming` is synchronous, and `.tap` removes
   * the double-tap delay, so a second tap aimed at a button that looked inert
   * lands on **Cancel** rather than on the irreversible half. Cancel is last for
   * that reason and must stay there.
   *
   * Per-row state, because this list re-renders whenever the plugin redraws.
   */
  const [confirming, setConfirming] = useState<string | null>(null);
  const pending = row.actions.find((action) => action.id === confirming) ?? null;

  /*
   * Tappable only when there is both somewhere to go and somebody to take it
   * there. A row whose plugin named a destination but whose *caller* passed no
   * `onOpen` — the settings pane, which is inside a sheet the destination would
   * have to close — stays inert rather than drawing an affordance that does
   * nothing.
   */
  const where = onOpen !== undefined && row.open !== null ? row.open : null;

  const body = (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
          {/*
           * `break-words` rather than `truncate`, and it is not a preference.
           *
           * A row title is whatever a plugin put there, and the first real one was
           * an absolute path — a single unbreakable token, which `min-w-0` cannot
           * help with: measured in a three-column board, it ran straight through
           * the column beside it and under the next one's heading. `truncate` is
           * the app's answer for a *session* title, where the body opens to the
           * whole thing; a plugin row has nothing to open to, so cutting it would
           * throw the identifying half of a path away with nowhere to get it back.
           * Wrapping keeps every character and costs a line.
           */}
          {/*
           * The tone, as a dot rather than as the row's colour.
           *
           * A plugin says what a row *means* and this decides the ink — which is
           * the whole answer to "why can a plugin not send CSS". Drawn as a shape
           * beside the title rather than applied to the text, because the palette
           * is monochrome and a coloured title would be the loudest object on a
           * screen whose attention budget belongs to the session list.
           */}
          {row.tone !== null && <Dot tone={row.tone === "ok" ? "on" : row.tone === "warn" ? "pending" : "off"} />}
          <span className="min-w-0 text-sm break-words">{row.title}</span>
          {row.badge !== null && (
            <span className="shrink-0 rounded border border-edge px-1 text-2xs text-muted">{row.badge}</span>
          )}
        </div>
        {row.subtitle !== null && <p className="text-xs break-words text-muted">{row.subtitle}</p>}
    </>
  );

  return (
    /*
     * **Wraps, and that is what makes one row shape work in both blocks.**
     *
     * A `list` is the full width of the sheet and a `columns` block divides that
     * by up to eight, so the same row has to hold a title and its actions beside
     * each other in one and stack them in the other. Measured at 672px with three
     * columns: the actions won, the title was squeezed to about six characters a
     * line, and `Forget` was still clipped by the panel's edge.
     *
     * `flex-wrap` with a basis on the body is the whole fix, and it is CSS —
     * `AppShell`'s rule holds here for its reason: a width read in JavaScript
     * renders a layout the viewport does not have the moment anything resizes,
     * and this screen is drawn on a phone more often than not.
     */
    <li className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5 border-b border-edge py-2 last:border-b-0">
      {where === null ? (
        <div className="min-w-0 flex-1 basis-40">{body}</div>
      ) : (
        /*
         * A `<button>` rather than an `<a>`, because the destination is decided by
         * `pluginDestination` at the call site rather than being a href a plugin
         * wrote — there is no URL here for a middle-click to open, and pretending
         * there is would be the one thing this shape exists to refuse.
         *
         * ⚠ **`min-h-11` spelled out, because `tap` does not carry it.** `.tap` in
         * `index.css` is three `transition` properties and nothing else — no
         * height, no padding, no `::after` growth — so this said it had the 44px
         * reach while being one line of `text-sm`, about 20px, on the control that
         * navigates to a session from a phone. The `<li>` is `items-start`, so the
         * button does not stretch to the row either.
         */
        <button
          type="button"
          className="tap min-h-11 min-w-0 flex-1 basis-40 text-left"
          onClick={() => onOpen?.(where)}
        >
          {body}
        </button>
      )}
      {row.actions.length > 0 && (
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
          {pending !== null ? (
            <>
              <span className="text-xs text-muted">{pending.confirm}</span>
              <Button
                tone={pending.tone === "destructive" ? "destructive" : "plain"}
                size="sm"
                className="[@media(pointer:coarse)]:min-h-11"
                disabled={busy}
                onClick={() => {
                  setConfirming(null);
                  onAction(pending.id, { row: row.id });
                }}
              >
                {pending.label}
              </Button>
              <Button tone="primary" size="sm" className="[@media(pointer:coarse)]:min-h-11" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
            </>
          ) : (
            row.actions.map((action) =>
              /*
               * ⚠ **`sm` keeps the desktop density and the coarse-pointer floor
               * puts the 44px back.** `BUTTON_SIZE`'s docblock licenses `sm` for
               * one shape — "a confirmation that has replaced the controls on a
               * settings row, so it is the only thing on that row and has nothing
               * adjacent to mis-hit" — which is the *confirming* branch above, not
               * this one. These are several resting controls, `gap-1.5` apart, and
               * a plugin may mark any of them destructive. `AgentsPanel` already
               * spells the same escape at its own `sm` button.
               */
              action.confirm !== null && action.tone === "destructive" ? (
                <DangerButton
                  key={action.id}
                  icon={Trash2}
                  size="sm"
                  className="[@media(pointer:coarse)]:min-h-11"
                  disabled={busy}
                  onClick={() => setConfirming(action.id)}
                >
                  {action.label}
                </DangerButton>
              ) : (
                <Button
                  key={action.id}
                  size="sm"
                  className="[@media(pointer:coarse)]:min-h-11"
                  tone={action.tone === "destructive" ? "destructive" : "plain"}
                  disabled={busy}
                  onClick={() => (action.confirm === null ? onAction(action.id, { row: row.id }) : setConfirming(action.id))}
                >
                  {action.label}
                </Button>
              ),
            )
          )}
        </div>
      )}
    </li>
  );
}

function Form({
  block,
  busy,
  onAction,
}: {
  block: Extract<PluginBlock, { type: "form" }>;
  busy: boolean;
  onAction: (actionId: string, context: { form: Record<string, string> }) => void;
}): ReactNode {
  /*
   * Seeded once per mount, from the fields as they arrived.
   *
   * ⚠ **Once per mount is the whole contract, and the re-seed is the caller's.**
   * This said it was "keyed on what the plugin sent" and nothing keyed it — the
   * only ancestor key is `Block`'s positional index — so a plugin that normalised
   * a value on save showed the un-normalised one until reload. The key is not put
   * here because this component also draws a plugin's *screen*, which
   * `PluginScreen` re-reads on `refreshMs`: a content-derived key there would wipe
   * what somebody was typing every two seconds. `PluginSettings` has no timer and
   * remounts this on its own save counter, which is the only moment a re-seed is
   * both wanted and safe.
   */
  const [values, setValues] = useState<Record<string, string>>(() => seedForm(block.fields));
  const set = (key: string, value: string): void => setValues((held) => ({ ...held, [key]: value }));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        // A real `<form>`, so Enter submits natively and a password manager can see
        // a password field — `SignIn` makes the same argument for the same reason.
        event.preventDefault();
        onAction(block.action, { form: values });
      }}
    >
      {block.fields.map((field) => (
        <Field key={field.key} field={field} value={values[field.key] ?? ""} onChange={(value) => set(field.key, value)} />
      ))}
      <div>
        {/*
          The spinner, not just `disabled`'s dimming: an action goes over the
          relay against the daemon's 10s call deadline, so Save can sit unchanged
          for seconds. `AgentsPanel`'s own submit and `InstallPlugin` one file
          over both swap the label the same way.
        */}
        <Button type="submit" tone="primary" disabled={busy}>
          {busy ? <Spinner /> : block.submit}
        </Button>
      </div>
    </form>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: PluginField;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  const help = field.help === null ? null : <p className="text-xs text-muted">{field.help}</p>;

  if (field.kind === "toggle") {
    return (
      /*
       * The same coarse-pointer floor every other field gets through `FIELD`. A
       * toggle drawn without it is a ~20px target sitting beside 44px text inputs
       * in the same form.
       */
      <label className="flex items-start gap-3 [@media(pointer:coarse)]:min-h-11">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-fg"
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
        />
        <span className="min-w-0">
          <span className="block text-sm">{field.label}</span>
          {help}
        </span>
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{field.label}</span>
      {field.kind === "select" ? (
        <select className={FIELD} value={value} onChange={(event) => onChange(event.target.value)}>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label || option.value}
            </option>
          ))}
        </select>
      ) : (
        <input
          // An unknown kind arrives here as `text` — `plugins.ts` has already made
          // that substitution, so a field a newer plugin invented is still readable
          // and still round-trips rather than vanishing.
          type={field.kind === "password" ? "password" : field.kind === "number" ? "number" : "text"}
          className={FIELD}
          value={value}
          placeholder={field.placeholder ?? undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {help}
    </label>
  );
}
