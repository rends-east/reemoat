import type { ComponentType, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { CONTROL, GROUP_ROW, Icon, SETTINGS_HEADING, Spinner } from "../bits";

type Glyph = ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean }>;

const ROW = GROUP_ROW;

/** A record list's table inside a Group's box: `TH` on the head row, `TD` on every cell, corner cells round themselves. */
export const TABLE = "w-full text-sm";
export const TH = `px-4 py-2 text-left ${SETTINGS_HEADING}`;
export const TD = "px-4 py-2 align-middle";

/**
 * A band of settings: an optional caps header, one bordered box of rows, and an optional footer. The box is edge-strong
 * because its rows are controls and carry no border of their own; `still` gives a box holding no control the hairline.
 */
export function Group({
  title,
  count,
  action,
  footer,
  error = null,
  still = false,
  unboxed = false,
  children,
}: {
  title?: string;
  count?: string;
  action?: ReactNode;
  /** A consequence at rest, six words at most (Q3.544); never an explanation of the rows above it. */
  footer?: ReactNode;
  /** A failure about these rows, drawn under the box rather than inside it as another row. */
  error?: string | null;
  still?: boolean;
  /** For content that is itself one bordered control, such as a command line or a log: no box around a box. */
  unboxed?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="mt-6 first:mt-0">
      {(title !== undefined || action !== undefined) && (
        <div className="mb-2 flex min-h-6 items-center gap-2 px-4">
          {title !== undefined && <h3 className={SETTINGS_HEADING}>{title}</h3>}
          {count !== undefined && <span className="text-2xs text-faint">{count}</span>}
          {action !== undefined && <span className="ml-auto flex items-center">{action}</span>}
        </div>
      )}
      {unboxed ? (
        children
      ) : (
        <div className={`divide-y divide-edge rounded-lg border ${still ? "border-edge" : "border-edge-strong"}`}>
          {children}
        </div>
      )}
      {error !== null && <p className="mt-2 px-4 text-xs text-danger">{error}</p>}
      {footer !== undefined && <p className="mt-2 px-4 text-xs text-muted">{footer}</p>}
    </section>
  );
}

function RowText({
  title,
  subline,
  detail,
  muted,
}: {
  title: ReactNode;
  subline?: ReactNode;
  detail?: ReactNode;
  muted?: boolean;
}): ReactNode {
  // A floor rather than min-w-0: a long value beside a badge otherwise truncates the title to a few letters.
  return (
    <span className="min-w-[40%] flex-1">
      <span className={`block truncate text-sm ${muted === true ? "text-muted" : ""}`}>{title}</span>
      {subline !== undefined && subline !== null && <span className="block truncate text-2xs text-faint">{subline}</span>}
      {detail !== undefined && detail !== null && <span className="block truncate text-2xs text-faint">{detail}</span>}
    </span>
  );
}

/** Goes deeper: a title, the value it holds, and a chevron. The whole row is the control. */
export function LinkRow({
  title,
  value,
  subline,
  detail,
  glyph,
  badge,
  disabled = false,
  onClick,
}: {
  title: ReactNode;
  value?: ReactNode;
  subline?: ReactNode;
  /** A second line under the subline, for a fact that would truncate away if joined to it. */
  detail?: ReactNode;
  glyph?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`${ROW} tap ${disabled ? "" : "hover:bg-raised"}`}>
      {glyph}
      <RowText title={title} subline={subline} detail={detail} muted={disabled} />
      {badge}
      {value !== undefined && value !== null && <span className="min-w-0 max-w-[55%] truncate text-sm text-muted">{value}</span>}
      <Icon as={ChevronRight} size={16} className="text-faint" />
    </button>
  );
}

/** A fact nobody edits here. A machine-written value is mono and takes the step below the line, as every path does. */
export function ValueRow({
  title,
  value,
  subline,
  mono = false,
  badge,
}: {
  title: ReactNode;
  value?: ReactNode;
  subline?: ReactNode;
  mono?: boolean;
  badge?: ReactNode;
}): ReactNode {
  return (
    <div className={ROW}>
      <RowText title={title} subline={subline} />
      {badge}
      {value !== undefined && value !== null && (
        <span className={`min-w-0 max-w-[60%] truncate text-muted ${mono ? "font-mono text-2xs" : "text-sm"}`}>{value}</span>
      )}
    </div>
  );
}

/** Does one thing: the title is the verb, and the trailing glyph says it acts rather than goes somewhere. */
export function ActionRow({
  title,
  subline,
  glyph,
  tone = "plain",
  busy = false,
  disabled = false,
  onClick,
}: {
  title: ReactNode;
  subline?: ReactNode;
  glyph: Glyph;
  /** `danger` for a one-tap act that ends something, such as signing out; never a fill, and one per view. */
  tone?: "plain" | "danger";
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): ReactNode {
  const still = busy || disabled;
  const ink = tone === "danger" ? "text-danger" : "";
  const hover = still ? "" : tone === "danger" ? "hover:bg-danger/10" : "hover:bg-raised";
  return (
    <button type="button" disabled={still} aria-busy={busy || undefined} onClick={onClick} className={`${ROW} tap ${ink} ${hover}`}>
      <RowText title={title} subline={subline} muted={disabled} />
      {busy ? <Spinner /> : <Icon as={glyph} size={16} className={disabled ? "text-faint" : tone === "danger" ? "" : "text-muted"} />}
    </button>
  );
}

/**
 * The resting control of a destructive TwoStep, sized to its label. It never spans the row: the act lands to the right
 * of the question when armed, and a double tap on a full-width rest could land on it (Q3.218).
 */
export function DangerRow({
  label,
  icon,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: Glyph;
  disabled?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`tap -mx-2 inline-flex ${CONTROL} items-center gap-2 rounded-md px-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:text-faint`}
    >
      <Icon as={icon} size={16} />
      {label}
    </button>
  );
}

/** The box around a TwoStep that stands for a whole row, the same height in both arms, so nothing below it moves when it arms. */
export const TWO_STEP_ROW = "min-h-11 px-4 py-1.5";

/** A list with nothing in it says so inside its box, on the rows' axis rather than centred under them. */
export function EmptyRow({ children, action }: { children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className={ROW}>
      <span className="min-w-0 flex-1 text-sm text-muted">{children}</span>
      {action}
    </div>
  );
}
