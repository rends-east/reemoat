import { memo, useState, type ReactNode } from "react";
import { seedForm } from "../plugins";
import type { PluginBlock, PluginField, PluginOpen, PluginRow, PluginView as PluginViewShape } from "../wire";
import { Button, DangerButton, Dot, Dropdown, Empty, FIELD, SETTINGS_HEADING, Spinner } from "./bits";
import { Trash2 } from "lucide-react";

/** A plugin's view drawn with this app's components: no plugin code ever runs in this origin, which holds the credential. */

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
  onOpen?: ((where: PluginOpen) => void) | undefined;
}): ReactNode {
  if (view.blocks.length === 0) {
    return <Empty>This plugin drew nothing.</Empty>;
  }
  return (
    <div className="flex flex-col gap-5">
      {view.blocks.map((block, index) => (
        // Index as key: a block has no id, and a content-derived key would reorder text under the cursor.
        <PluginBlockView key={index} block={block} busy={busy} onAction={onAction} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** Exported for the settings pane, which draws blocks from several machines and needs the same notice markup (Q3.460). */
export const PluginBlockView = memo(function PluginBlockView({
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
      // No markdown: a link whose href a plugin chose is the sink Markdown.tsx refuses.
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
      return (
        <div className="flex flex-col gap-4 overflow-x-auto sm:flex-row">
          {block.columns.map((column, index) => (
            <section key={index} className="min-w-0 flex-1 sm:min-w-40">
              <h3 className={`mb-1.5 ${SETTINGS_HEADING}`}>{column.title}</h3>
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
}, sameBlockProps);

/** Memoised on sameRowProps, since readView hands back a fresh object graph on every read. */
const Row = memo(function Row({
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
  // Cancel stays last, so a second tap aimed at an inert-looking button lands on it rather than on the irreversible half.
  const [confirming, setConfirming] = useState<string | null>(null);
  const pending = row.actions.find((action) => action.id === confirming) ?? null;

  const where = onOpen !== undefined && row.open !== null ? row.open : null;

  const body = (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
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
    <li className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5 border-b border-edge py-2 last:border-b-0">
      {where === null ? (
        <div className="min-w-0 flex-1 basis-40">{body}</div>
      ) : (
        // A button, not a link: the destination comes from pluginDestination, never from an href a plugin wrote.
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
}, sameRowProps);

function Form({
  block,
  busy,
  onAction,
}: {
  block: Extract<PluginBlock, { type: "form" }>;
  busy: boolean;
  onAction: (actionId: string, context: { form: Record<string, string> }) => void;
}): ReactNode {
  // Seeded once per mount; a re-seed is the caller's remount, since a content key would wipe typing on every refresh.
  const [values, setValues] = useState<Record<string, string>>(() => seedForm(block.fields));
  const set = (key: string, value: string): void => setValues((held) => ({ ...held, [key]: value }));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onAction(block.action, { form: values });
      }}
    >
      {block.fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          // Object.hasOwn: a field keyed __proto__ would otherwise read back Object.prototype.
          value={Object.hasOwn(values, field.key) ? (values[field.key] ?? "") : ""}
          onChange={(value) => set(field.key, value)}
        />
      ))}
      <div>
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

  if (field.kind === "select") {
    // Dropdown, never a native select; a value outside the options is drawn as itself.
    const chosen = field.options.find((option) => option.value === value) ?? null;
    return (
      // help sits outside the label: inside it, every word of the help opened the picker.
      <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-sm">{field.label}</span>
        <Dropdown
          items={field.options.map((option) => ({ value: option.value, label: option.label || option.value }))}
          value={value}
          onChange={onChange}
          heading={field.label || undefined}
          trigger={
            <span className={`min-w-0 truncate ${chosen === null && value.length === 0 ? "text-muted" : ""}`}>
              {chosen?.label || chosen?.value || value || field.placeholder || "Choose"}
            </span>
          }
        />
      </label>
      {help}
      </div>
    );
  }

  return (
    /* Same split as the `select` arm above, for its reason: inside the label, the
       help text focuses the input from wherever it is clicked. */
    <div className="flex flex-col gap-1">
    <label className="flex flex-col gap-1">
      <span className="text-sm">{field.label}</span>
      <input
        type={field.kind === "password" ? "password" : field.kind === "number" ? "number" : "text"}
        className={FIELD}
        value={value}
        placeholder={field.placeholder ?? undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
    {help}
    </div>
  );
}

// Field by field and total: a PluginRow field missing here is a row that silently stops redrawing.
function samePluginRow(a: PluginRow, b: PluginRow): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.badge === b.badge &&
    a.tone === b.tone &&
    sameOpen(a.open, b.open) &&
    a.actions.length === b.actions.length &&
    a.actions.every((action, index) => {
      const other = b.actions[index];
      return (
        other !== undefined &&
        action.id === other.id &&
        action.label === other.label &&
        action.tone === other.tone &&
        action.confirm === other.confirm
      );
    })
  );
}

// Total over the five block types, with type compared first.
function samePluginBlock(a: PluginBlock, b: PluginBlock): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "text": {
      const other = b as Extract<PluginBlock, { type: "text" }>;
      return a.text === other.text && a.tone === other.tone;
    }
    case "notice": {
      const other = b as Extract<PluginBlock, { type: "notice" }>;
      return a.text === other.text && a.tone === other.tone;
    }
    case "list": {
      const other = b as Extract<PluginBlock, { type: "list" }>;
      return a.empty === other.empty && sameRows(a.rows, other.rows);
    }
    case "columns": {
      const other = b as Extract<PluginBlock, { type: "columns" }>;
      return (
        a.columns.length === other.columns.length &&
        a.columns.every((column, index) => {
          const twin = other.columns[index];
          return twin !== undefined && column.title === twin.title && sameRows(column.rows, twin.rows);
        })
      );
    }
    case "form": {
      const other = b as Extract<PluginBlock, { type: "form" }>;
      return (
        a.action === other.action &&
        a.submit === other.submit &&
        a.fields.length === other.fields.length &&
        a.fields.every((field, index) => {
          const twin = other.fields[index];
          return twin !== undefined && sameField(field, twin);
        })
      );
    }
  }
}

function sameOpen(a: PluginOpen | null, b: PluginOpen | null): boolean {
  if (a === null || b === null) return a === b;
  if ("session" in a) return "session" in b && a.session === b.session;
  return !("session" in b);
}

function sameRows(a: readonly PluginRow[], b: readonly PluginRow[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((row, index) => {
    const other = b[index];
    return other !== undefined && samePluginRow(row, other);
  });
}

function sameField(a: PluginField, b: PluginField): boolean {
  return (
    a.key === b.key &&
    a.label === b.label &&
    a.kind === b.kind &&
    a.value === b.value &&
    a.placeholder === b.placeholder &&
    a.help === b.help &&
    a.options.length === b.options.length &&
    a.options.every((option, index) => {
      const other = b.options[index];
      return other !== undefined && option.value === other.value && option.label === other.label;
    })
  );
}

// Callbacks compared by identity, which is why PluginScreen hoists both into useCallback.
function sameRowProps(
  a: { row: PluginRow; busy: boolean; onAction: unknown; onOpen?: unknown },
  b: { row: PluginRow; busy: boolean; onAction: unknown; onOpen?: unknown },
): boolean {
  return (
    a.busy === b.busy && a.onAction === b.onAction && a.onOpen === b.onOpen && samePluginRow(a.row, b.row)
  );
}

function sameBlockProps(
  a: { block: PluginBlock; busy: boolean; onAction: unknown; onOpen?: unknown },
  b: { block: PluginBlock; busy: boolean; onAction: unknown; onOpen?: unknown },
): boolean {
  return (
    a.busy === b.busy && a.onAction === b.onAction && a.onOpen === b.onOpen && samePluginBlock(a.block, b.block)
  );
}
