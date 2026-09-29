import { useId, type ReactNode } from "react";

/** A field's name on a form: sentence case, so it is never mistaken for a group heading (owner's call, 2026-09-28). */
export const FIELD_LABEL = "text-xs font-medium text-fg";

/** Pick several: a native box in the palette's ink, since WebKit otherwise paints its own blue into a monochrome app. */
export const CHECKBOX = "size-4 shrink-0 accent-fg";

/**
 * A label, one control and what is said under it. The label is a sibling and never a wrapper: a `<label>` activates its
 * first labelable descendant, and a Dropdown trigger is one (plugin-ui.md). The control takes its ids from the render prop.
 */
export function Field({
  label,
  hint,
  error = null,
  className = "",
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: (ids: { id: string; labelledBy: string; describedBy: string | undefined }) => ReactNode;
}): ReactNode {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const said = [hint === undefined ? null : hintId, error === null ? null : errorId].filter((one) => one !== null);
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label id={labelId} htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      {children({ id, labelledBy: labelId, describedBy: said.length === 0 ? undefined : said.join(" ") })}
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error !== null && (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
