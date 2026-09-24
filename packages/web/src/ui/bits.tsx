import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { errorText } from "../http";
import { listNavKey, nextOptionIndex } from "../keys";
import { folderLabel, shortPath } from "../paths";
import type { OfflineReason, Reach } from "../machine";
import {
  isParked,
  isTerminal,
  resumeStalled,
  waitingForDaemon,
  type ExitReason,
  type SessionSnapshot,
} from "../wire";
import { LAYER, useDismissible } from "./overlay";
// Toast.tsx imports Icon from here; the cycle is benign because each side reads the other only inside function bodies.
import { toast } from "./Toast";

// Tap-target pads exist only under a coarse pointer: a pad that grows hit-testing grows hover with it.

/** Every class keeps the coarse-pointer prefix and is written out whole, since Tailwind cannot see an interpolated class. */
export const TAP_GROW_Y =
  "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:-top-1 [@media(pointer:coarse)]:after:-bottom-2 [@media(pointer:coarse)]:after:content-['']";

export const COLUMN = "mx-auto w-full max-w-[45rem]";

/** A complete string rather than FIELD plus a left padding, which would race FIELD's own padding by stylesheet order. */
export const SEARCH_FIELD =
  "min-h-9 w-full rounded-md border border-edge-strong bg-surface py-2 pr-2.5 pl-8 text-sm outline-none [@media(pointer:coarse)]:min-h-11";

export const FIELD =
  "min-h-9 rounded-md border border-edge-strong bg-surface px-3 text-sm leading-5 outline-none [@media(pointer:coarse)]:min-h-11";

// Never compose FIELD with a vertical padding: equal-specificity utilities race by stylesheet order, so state a min height instead.

export const LINK = "text-fg underline decoration-edge-strong decoration-1 underline-offset-2 hover:decoration-fg";

export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}


export { shortPath };

/** The session's name, else its folder; plain text, never rendered through Markdown. */
export function sessionLabel(
  row: { snapshot: { title?: string | null; workspace: { requestedCwd: string } } },
  // folderLabel, not displayCwd: SessionLine compares this with its subline to avoid drawing one folder twice.
  roots: readonly string[] = [],
): string {
  const title = row.snapshot.title?.trim();
  if (title !== undefined && title.length > 0) return title;
  return folderLabel(row.snapshot.workspace.requestedCwd, roots);
}

export type StatusTone =
  | "blocked"
  | "running"
  | "starting"
  | "stopping"
  | "waiting"
  | "stalled"
  | "idle"
  | "ended"
  | "failed";

export function statusTone(
  session: Pick<SessionSnapshot, "status" | "exit" | "agentSessionId" | "resume">,
): StatusTone {
  if (!isTerminal(session.status)) {
    switch (session.status) {
      case "blocked":
        return "blocked";
      case "running":
        return "running";
      case "starting":
        return "starting";
      case "stopping":
        return "stopping";
      default:
        return "idle";
    }
  }
  // A parked agent reads as idle, never ended; this must run before the terminal arms below.
  if (isParked(session as SessionSnapshot)) return "idle";
  if (resumeStalled(session as SessionSnapshot)) return "stalled";
  if (waitingForDaemon(session as SessionSnapshot)) return "waiting";
  return session.status === "failed" ? "failed" : "ended";
}

// Nine tones on four non-colour axes (fill, ring, motion, shape); blocked stays static so reduced motion cannot erase it.
const TONE_DOT: Record<StatusTone, string> = {
  blocked: "bg-fg ring-[3px] ring-fg/25",
  // `text-*` beside `bg-*` because the keyframe's ring is `currentColor` — one
  // animation, inked by whoever uses it.
  running: "bg-fg text-fg animate-blink",
  starting: "border border-edge-strong bg-transparent animate-pulse",
  stopping: "border border-edge-strong bg-transparent animate-pulse",
  waiting: "border border-edge-strong bg-transparent animate-pulse",
  idle: "border border-edge-strong bg-transparent",
  ended: "border border-edge-strong bg-transparent",
  failed: "",
  stalled: "",
};

function drawnAsGlyph(tone: StatusTone): boolean {
  return tone === "failed" || tone === "stalled";
}

const TONE_TEXT: Record<StatusTone, string> = {
  blocked: "waiting for you",
  running: "running",
  starting: "starting",
  stopping: "stopping",
  waiting: "reconnecting after a restart",
  idle: "idle",
  ended: "ended",
  failed: "failed to start",
  stalled: "could not reconnect",
};

export function StatusDot({ session }: { session: SessionSnapshot }): ReactNode {
  const tone = statusTone(session);
  return (
    <span
      className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center"
      title={TONE_TEXT[tone]}
    >
      {drawnAsGlyph(tone) ? (
        <Icon as={X} size={10} className="text-fg" />
      ) : (
        <span className={`inline-block h-2 w-2 rounded-full ${TONE_DOT[tone]}`} />
      )}
      <span className="sr-only">{TONE_TEXT[tone]}</span>
    </span>
  );
}

/** Three tones only, so StreamDot draws a first connect and a backoff retry alike as pending. */
export function Dot({ tone }: { tone: "on" | "pending" | "off" }): ReactNode {
  const style =
    tone === "on"
      ? "bg-fg"
      : tone === "pending"
        ? "border border-edge-strong bg-transparent animate-pulse"
        : "border border-edge-strong bg-transparent";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${style}`} />;
}

export function Badge({
  children,
  tone = "plain",
}: {
  children: ReactNode;
  tone?: "plain" | "strong";
}): ReactNode {
  const style = tone === "strong" ? "bg-raised text-fg font-semibold" : "bg-raised text-muted";
  return (
    <span className={`rounded-sm px-1.5 py-0.5 text-2xs leading-tight font-medium ${style}`}>
      {children}
    </span>
  );
}

// Derived from the name, never random, and every entry is a single code point (no joiners or variation selectors).
const FACES = ["🧑", "👩", "👨", "🧔", "👱", "🧓", "🤠", "🦸", "🧙", "🧚", "👮", "👷"] as const;

export function personEmoji(name: string | null): string {
  const seed = name?.trim() ?? "";
  if (seed === "") return FACES[0];
  let total = 0;
  for (const ch of seed) total += ch.codePointAt(0) ?? 0;
  return FACES[total % FACES.length] ?? FACES[0];
}

export function Monogram({
  name,
  glyph,
  size = "sm",
  className = "",
}: {
  name: string | null;
  glyph?: string;
  size?: "sm" | "row" | "md" | "lg";
  className?: string;
}): ReactNode {
  const letter = name === null ? "" : [...name.trim()][0]?.toUpperCase() ?? "";
  const box =
    size === "lg"
      ? "h-12 w-12 rounded-full text-xl"
      : size === "md"
        ? "h-10 w-10 rounded-full text-lg"
        : size === "row"
          ? "h-8 w-8 rounded-full text-base"
          : "h-7 w-7 rounded-md text-2xs font-semibold";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center ${box} ${className}`}
    >
      {glyph ?? letter}
    </span>
  );
}

/** Every OfflineReason member has an entry, and each names a different thing to do. */
export const OFFLINE_TEXT: Record<NonNullable<OfflineReason>, string> = {
  no_route: "unreachable",
  no_token: "no token",
  not_enrolled: "not enrolled",
  cp_unreachable: "control plane unreachable",
  over_limit: "over the machine limit",
  owner_disabled: "its owner is disabled",
  no_machine_key: "needs a newer daemon",
  // About this device, not the row's machine: only a keyless shell reaches it, and Re-key under Devices clears it.
  no_device_key: "re-key this device under Settings → Devices",
};

/** A phrase for inside a sentence, so unknown reads as words, never a bare ellipsis. */
export function reachText(reach: Reach, reason: OfflineReason): string {
  if (reach === "online") return "online";
  if (reach === "probing") return "probing…";
  if (reach === "unknown") return "not checked yet";
  return reason === null ? "unreachable" : OFFLINE_TEXT[reason];
}

/** The one place the "not reachable" sentence is composed; webcheck's REACH_SCREENS are the screens that mount it. */
export function NotReachable({
  machine,
  tail = ".",
}: {
  machine: { name: string; reach: Reach; offlineReason: OfflineReason };
  tail?: ReactNode;
}): ReactNode {
  return (
    <>
      {machine.name} is not reachable right now — {reachText(machine.reach, machine.offlineReason)}
      {tail}
    </>
  );
}


export function resumeFailureText(
  code: string,
  message: string,
  agent: string,
  machine: string,
): string {
  switch (code) {
    case "no_agent_session_id":
      return "there is no agent conversation to reconnect to";
    case "resume_unsupported":
      return `${agent} cannot reattach to an earlier conversation`;
    case "agent_forgot_session":
      return `${agent} no longer has this conversation — the transcript here is intact`;
    case "workspace_missing":
      return "this session's folder is gone";
    case "workspace_unresponsive":
      return "this session's folder is not answering";
    case "agent_unavailable":
      return `${agent} is not installed on ${machine}`;
    case "agent_start_timeout":
      return `${agent} did not start in time`;
    case "agent_auth_required":
      return `${agent} is not signed in on ${machine}`;
    default:
      return message;
  }
}

/** False only for codes a retry can never fix; workspace_missing stays retryable because the folder can be put back. */
export function resumeRetryable(code: string): boolean {
  return (
    code !== "no_agent_session_id" &&
    code !== "resume_unsupported" &&
    code !== "agent_forgot_session"
  );
}

export interface SessionNotice {
  tone: "quiet" | "warn";
  text: string;
  action: "reconnect" | "sign_in" | null;
}

// agent_signed_out and the daemon exit reasons are answered before this table; an unknown reason is drawn as itself.
const EXIT_TEXT: Partial<Record<ExitReason, string>> = {
  stopped: "you stopped this conversation",
  agent_exited: "the agent exited",
  start_failed: "the agent could not be started",
  start_timeout: "the agent did not start in time",
  agent_kill_failed: "the agent could not be stopped",
  parked: "the agent was released after a quiet spell",
};

export function exitText(reason: ExitReason): string {
  return EXIT_TEXT[reason] ?? `ended: ${reason}`;
}

export function sessionNotice(
  session: SessionSnapshot,
  agent: string,
  machineName: string,
): SessionNotice | null {
  if (session.exit === null) return null;
  // A parked session draws no notice; without this it would fall through to the exit-text catch-all.
  if (isParked(session)) return null;
  if (resumeStalled(session)) {
    const error = session.resume?.error;
    const code = error?.code ?? "no_agent_session_id";
    // The only place "sign in" is earned: the daemon tried to resume and was refused.
    return {
      tone: "warn",
      text: `could not reconnect the agent — ${resumeFailureText(code, error?.message ?? "", agent, machineName)}`,
      action:
        code === "agent_auth_required" ? "sign_in" : resumeRetryable(code) ? "reconnect" : null,
    };
  }
  if (waitingForDaemon(session)) {
    // A deferred wait (no CLI yet, no attempt spent) shows the short reason, never the daemon's message.
    const deferred =
      session.resume?.state === "waiting" && session.resume.attempts === 0 && session.resume.error?.code === "agent_unavailable";
    return {
      tone: "quiet",
      text: deferred
        ? `${resumeFailureText("agent_unavailable", "", agent, machineName)} — waiting for it to be installed`
        : session.resume?.state === "running"
          ? "reconnecting the agent…"
          : "the daemon restarted — reconnecting the agent",
      action: null,
    };
  }
  // The exit is history, not a live login state, so the remedy is Reconnect rather than Sign in.
  if (session.exit.reason === "agent_signed_out") {
    return {
      tone: "quiet",
      text: `${agent} could not authenticate on ${machineName}, so this conversation stopped.`,
      action: "reconnect",
    };
  }
  const detail = session.exit.detail === null ? "" : ` — ${session.exit.detail}`;
  const orphan = session.exit.agentConfirmedDead ? "" : " (agent not confirmed dead)";
  return { tone: "quiet", text: `${exitText(session.exit.reason)}${detail}${orphan}`, action: null };
}

export function Spinner(): ReactNode {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-fg"
      aria-hidden="true"
    />
  );
}

/** Absence against failure: only a failure is a live region and carries the warning glyph. */
export function Empty({
  children,
  failed = false,
  action,
}: {
  children: ReactNode;
  failed?: boolean;
  action?: ReactNode;
}): ReactNode {
  if (!failed && action === undefined) {
    return <p className="px-4 py-6 text-center text-sm text-muted">{children}</p>;
  }
  return (
    <div role={failed ? "status" : undefined} className="px-4 py-6">
      <p
        className={
          failed
            ?
              "flex items-start justify-center gap-1.5 text-sm text-fg"
            : "text-center text-sm text-muted"
        }
      >
        {failed && (
          <Icon as={AlertTriangle} size={14} className="mt-0.5 text-muted" />
        )}
        <span>{children}</span>
      </p>
      {action !== undefined && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }): ReactNode {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-2 px-4 py-3.5">
          <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-edge" />
          <div className="min-w-0 flex-1">
            <div className="h-3 w-1/3 animate-pulse rounded-sm bg-edge" />
            <div className="mt-1.5 h-2.5 w-2/3 animate-pulse rounded-sm bg-edge/60" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Exactly one row and no count, since these lists usually hold zero or one item (Q3.548). */
export function SkeletonRow({ tall = false }: { tall?: boolean } = {}): ReactNode {
  return (
    <div aria-busy="true" className={`flex ${tall ? "min-h-14" : "min-h-11"} items-center`}>
      <div aria-hidden="true" className="h-3 w-1/3 animate-pulse rounded-sm bg-raised/50" />
    </div>
  );
}

/** No animation-delay to hide the fast case: under reduced motion an element starting at zero opacity would stay invisible. */
export function TranscriptSkeleton(): ReactNode {
  const bar = (width: string, tone = "bg-raised/50"): ReactNode => (
    <div className={`h-3.5 ${width} animate-pulse rounded-sm ${tone}`} />
  );
  return (
    <div aria-hidden="true" className="space-y-4 py-2">
      <div className="space-y-1.5">
        {bar("w-4/5")}
        {bar("w-3/5")}
      </div>
      <div className="flex justify-end">
        <div className="h-9 w-1/2 animate-pulse rounded-lg bg-raised" />
      </div>
      <div className="space-y-1.5">
        {bar("w-3/4")}
        {bar("w-2/5")}
      </div>
    </div>
  );
}

export type ButtonTone = "primary" | "plain" | "destructive" | "ghost";

/**
 * Disabled dims the ink and keeps the box: border-danger/45 measures only 2.27:1 on surface,
 * so the outlined tones keep edge-strong when disabled and only primary and ghost use opacity.
 */
const BUTTON_TONE: Record<ButtonTone, string> = {
  primary: "bg-fg text-ink hover:bg-fg/85 disabled:opacity-40",
  plain: "border border-edge-strong bg-surface text-fg hover:bg-raised disabled:bg-surface disabled:text-faint",
  destructive:
    "border border-danger/45 bg-surface text-danger font-medium hover:bg-danger/10 disabled:border-edge-strong disabled:bg-surface disabled:text-faint",
  ghost: "text-muted hover:bg-raised hover:text-fg disabled:opacity-40",
};

/** Size is a prop, not a className, because equal-specificity utilities race by stylesheet order; sm keeps a 44px coarse-pointer floor. */
const BUTTON_SIZE = {
  md: "min-h-11 px-3 text-sm",
  sm: "min-h-9 px-2.5 text-xs [@media(pointer:coarse)]:min-h-11",
} as const;

export type ButtonSize = keyof typeof BUTTON_SIZE;

export function Button({
  children,
  onClick,
  tone = "plain",
  size = "md",
  disabled = false,
  type = "button",
  title,
  className = "",
  ariaLabel,
  autoFocus,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: ButtonTone;
  size?: ButtonSize;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
  ariaLabel?: string;
  /** For ChooseServer, whose locked field cannot take focus. */
  autoFocus?: boolean;
}): ReactNode {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      className={`tap press inline-flex items-center justify-center gap-1.5 rounded-md font-medium ${BUTTON_SIZE[size]} ${BUTTON_TONE[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

/** The only door to the destructive tone; its required glyph is what identifies it. */
export function DangerButton({
  icon,
  children,
  onClick,
  size = "md",
  disabled = false,
  title,
  className = "",
  ariaLabel,
}: {
  icon: DangerIcon;
  children: ReactNode;
  onClick?: () => void;
  size?: ButtonSize;
  disabled?: boolean;
  title?: string;
  className?: string;
  ariaLabel?: string;
}): ReactNode {
  return (
    <Button tone="destructive" size={size} onClick={onClick} disabled={disabled} title={title} className={className} ariaLabel={ariaLabel}>
      <Icon as={icon} size={13} />
      {children}
    </Button>
  );
}

export type DangerIcon = ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean }>;

/** danger requires the glyph as a union, so a missing icon is a compile error. */
export type TwoStepAct =
  | { label: string; danger: true; icon: DangerIcon; ariaLabel?: string }
  | { label: string; danger?: false; icon?: undefined; ariaLabel?: string };

/** A promise keeps the question open until it resolves and leaves it standing on rejection; void closes it on the tap. */
export function twoStepAct(
  outcome: Promise<unknown> | void,
  hooks: { setBusy: (busy: boolean) => void; disarm: () => void; fail: (cause: unknown) => void },
): void {
  if (outcome === undefined) {
    hooks.disarm();
    return;
  }
  hooks.setBusy(true);
  void outcome.then(
    () => {
      hooks.setBusy(false);
      hooks.disarm();
    },
    (cause: unknown) => {
      hooks.setBusy(false);
      hooks.fail(cause);
    },
  );
}

/** Exported for MachineLimitPanel, which draws the box itself (Q3.552). */
export const TWO_STEP_BOX = "flex flex-wrap items-center gap-2";

/**
 * One box in both arms, the act then Cancel, and Cancel never filled; busy is owned here for a promise-returning act (Q3.218, Q3.552).
 * Arming is controlled by the caller because the flag is per row on a polled list.
 */
export function TwoStep({
  armed,
  onArm,
  question,
  consequence,
  act,
  onAct,
  onFailure,
  disabled = false,
  rest,
  size = "sm",
  align,
  lead,
  className = "",
}: {
  armed: boolean;
  onArm: (next: boolean) => void;
  question: ReactNode;
  consequence?: ReactNode;
  act: TwoStepAct;
  onAct: () => Promise<unknown> | void;
  onFailure?: (cause: unknown) => void;
  disabled?: boolean;
  rest?: ReactNode;
  size?: ButtonSize;
  align?: "end" | "center";
  lead?: ReactNode;
  className?: string;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const run = (): void =>
    twoStepAct(onAct(), {
      setBusy,
      disarm: () => onArm(false),
      fail: onFailure ?? ((cause) => toast("error", errorText(cause))),
    });
  const label = busy ? <Spinner /> : act.label;
  return (
    <div className={`${TWO_STEP_BOX} ${align === "center" ? "justify-center" : ""} ${className}`}>
      {lead}
      {armed ? (
        <>
          <span
            className={`min-w-0 text-xs text-fg ${
              align === "center" ? "basis-full text-center" : align === "end" ? "flex-1" : ""
            }`}
          >
            {question}
            {consequence !== undefined && <span className="block text-muted">{consequence}</span>}
          </span>
          {act.danger === true ? (
            <DangerButton icon={act.icon} size={size} disabled={busy || disabled} onClick={run} ariaLabel={act.ariaLabel}>
              {label}
            </DangerButton>
          ) : (
            <Button tone="plain" size={size} disabled={busy || disabled} onClick={run} ariaLabel={act.ariaLabel}>
              {label}
            </Button>
          )}
          <Button size={size} disabled={busy} onClick={() => onArm(false)}>
            Cancel
          </Button>
        </>
      ) : (
        rest
      )}
    </div>
  );
}

// A fixed height rather than a max height, so a pop-up never resizes between screens; layering lives in overlay.ts.
export const SHEET_PANEL =
  "pb-safe animate-sheet sm:animate-rise relative flex h-[92dvh] min-h-0 w-full flex-col overflow-hidden rounded-t-2xl border-t border-edge bg-surface shadow-2xl sm:h-[min(44rem,88dvh)] sm:max-w-2xl sm:rounded-2xl sm:border sm:pb-0";
export const SHEET_HEAD =
  "flex min-h-14 shrink-0 items-center gap-2 border-b border-edge px-4 sm:px-5";
/** Must be a flex column that clips, never scrolls or pads, and paints its own ground for the section slide (Q3.553). */
export const SHEET_BODY = "flex min-h-0 flex-1 flex-col overflow-hidden bg-surface";
export const SHEET_FOOT =
  "flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-edge px-4 py-3.5 sm:px-5";

/** A screen's action bar goes inside the body, not in Sheet's footer, so the body is one height on every screen (Q3.472). */
export const SHEET_SCREEN = "flex min-h-0 flex-1 flex-col";
export const SHEET_SCROLL =
  "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-5";
export const POPOVER = "rounded-lg border border-edge bg-surface p-1.5 shadow-lg";

// sm, chip and nav grow to 44px only under a coarse pointer; lg is a 44px box everywhere.
const ICON_BUTTON_SIZE = {
  sm: "relative h-6 w-6 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']",
  chip: `relative h-8 w-8 ${TAP_GROW_Y}`,
  // One per row edge: two adjacent overlap by 12px of invisible target.
  nav: "relative h-8 w-8 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1.5 [@media(pointer:coarse)]:after:content-['']",
  lg: "h-11 w-11",
} as const;

const ICON_BUTTON_GLYPH: Record<keyof typeof ICON_BUTTON_SIZE, number> = {
  sm: 12,
  chip: 14,
  nav: 16,
  lg: 16,
};

const ICON_BUTTON_TONE: Record<ButtonTone, string> = {
  ghost: "text-muted hover:bg-raised hover:text-fg",
  primary: "bg-fg text-ink hover:bg-fg/85",
  plain: "border border-edge-strong bg-surface text-fg hover:bg-raised",
  destructive: "text-danger hover:bg-danger/10",
};

/** label and size are both required, so no call site ships without a name or below the 44px floor. */
export function IconButton({
  icon,
  label,
  onClick,
  tone = "ghost",
  size,
  shape = "square",
  disabled = false,
  active,
  expanded,
  haspopup,
  title,
  type = "button",
  className = "",
}: {
  icon: ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean }>;
  label: string;
  onClick?: () => void;
  tone?: ButtonTone;
  size: keyof typeof ICON_BUTTON_SIZE;
  /** A prop rather than a className because radius utilities would race by emission order; only the composer's send slot is round. */
  shape?: "square" | "round";
  disabled?: boolean;
  /** Renders as `aria-pressed`. Omit for buttons that are not a toggle. */
  active?: boolean;
  expanded?: boolean;
  haspopup?: "menu" | "listbox" | "dialog";
  title?: string;
  type?: "button" | "submit";
  className?: string;
}): ReactNode {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      aria-expanded={expanded}
      aria-haspopup={haspopup}
      title={title ?? label}
      className={`tap press inline-flex shrink-0 items-center justify-center ${
        shape === "round" ? "rounded-full" : "rounded-md"
      } disabled:pointer-events-none disabled:opacity-40 ${ICON_BUTTON_SIZE[size]} ${ICON_BUTTON_TONE[tone]} ${className}`}
    >
      <Icon as={icon} size={ICON_BUTTON_GLYPH[size]} />
    </button>
  );
}

export function Icon({
  as: Component,
  size = 14,
  className = "",
}: {
  as: ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean }>;
  size?: number;
  className?: string;
}): ReactNode {
  return <Component size={size} className={`shrink-0 ${className}`} aria-hidden={true} />;
}

/**
 * A button with a grid-rows transition rather than details, so React owns the open state and the height can animate;
 * inert keeps a closed fold out of the tab order.
 */
export function Disclosure({
  label,
  children,
  first,
  defaultOpen = false,
}: {
  label: ReactNode;
  children: ReactNode;
  first: boolean;
  /** Read once at mount; the fold is uncontrolled after that. */
  defaultOpen?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={first ? "" : "mt-2"}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="tap flex w-full items-center gap-1.5 text-left text-xs text-muted hover:text-fg"
      >
        <Icon
          as={ChevronRight}
          size={13}
          className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-fg">{label}</span>
      </button>
      <div
        id={id}
        inert={!open}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <div className="pb-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

export const MENU_PANEL = `${LAYER.menu} max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-edge bg-surface p-1.5 shadow-lg`;

/** Must match MENU_PANEL's 18rem height cap. */
export const MENU_MAX_PX = 288;

/** Bounded by the nearest scrolling ancestor, not the viewport, because an overflowing panel grows that scroller. */
export function menuPlacement(trigger: Element | null, needed: number = MENU_MAX_PX): "up" | "down" {
  if (trigger === null) return "down";
  const rect = trigger.getBoundingClientRect();
  let floor = window.innerHeight;
  for (let node = trigger.parentElement; node !== null; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) break;
    const overflow = window.getComputedStyle(node).overflowY;
    // overlay is WebKit's and scrolls exactly like auto.
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") {
      floor = Math.min(floor, node.getBoundingClientRect().bottom);
      break;
    }
  }
  return floor - rect.bottom < needed ? "up" : "down";
}
/** Alignment is an argument because an appended alignment utility loses to the base one by stylesheet order. */
export function menuRow(align: "start" | "center"): string {
  // Both class names written out: Tailwind never generates an interpolated utility.
  const cross = align === "center" ? "items-center" : "items-start";
  return `tap flex min-h-11 w-full ${cross} gap-2 rounded-md px-2.5 py-3 text-left text-xs`;
}
/** The caps idiom (uppercase, tracking-wider, font-semibold) belongs to these constants and FIELD_LABEL; webcheck's census lists every hand-written copy (Q5.115). */
export const MENU_HEADING =
  "px-2.5 py-1.5 text-2xs font-semibold tracking-wider text-faint uppercase";

/** The first section on a screen takes this alone; later ones add SETTINGS_SECTION. */
export const SETTINGS_HEADING = "text-2xs font-semibold tracking-wider text-muted uppercase";
export const SETTINGS_SECTION = "mt-8 border-t border-edge pt-5";

export function tabPill(selected: boolean): string {
  return `tap flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs whitespace-nowrap ${
    selected ? "bg-raised font-medium text-fg" : "bg-raised/50 text-muted hover:bg-raised hover:text-fg"
  }`;
}

export function RailRow({
  title,
  blurb,
  active,
  onClick,
}: {
  title: string;
  blurb?: string;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={`tap press flex min-h-11 w-full items-center gap-2 px-4 py-3.5 text-left hover:bg-raised ${
        active ? "bg-raised" : ""
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        {blurb !== undefined && <span className="block truncate text-xs text-muted">{blurb}</span>}
      </span>
      <Icon as={ChevronRight} size={14} className="shrink-0 text-faint" />
    </button>
  );
}

/** A disabled row hands back the strong border and dims its title and glyph, never the subline, which carries the refusal. */
export function ChoiceRow({
  glyph,
  title,
  placeholder = false,
  subline = null,
  trailing,
  selected,
  disabled = false,
  onClick,
}: {
  glyph?: ReactNode;
  title: string;
  placeholder?: boolean;
  subline?: string | null;
  trailing?: ReactNode;
  /** Omit where nothing is being chosen: no aria-pressed and no check slot. */
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      // Hover is granted by state, since hover still matches a disabled button; border sits in both arms because webcheck matches each literal.
      className={`tap press flex min-h-14 w-full items-center gap-2.5 rounded-lg ${
        disabled ? "border border-edge" : "border border-edge-strong"
      } px-3 text-left ${
        selected === true ? "bg-raised" : `bg-surface ${disabled ? "" : "hover:bg-raised"}`
      }`}
    >
      {glyph !== undefined && (
        <span className={`shrink-0 ${disabled ? "text-faint" : "text-muted"}`}>{glyph}</span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm ${selected === true ? "font-medium" : ""} ${
            disabled || placeholder ? "text-muted" : ""
          }`}
        >
          {title}
        </span>
        {subline !== null && subline.length > 0 && (
          <span className="block truncate text-2xs text-faint">{subline}</span>
        )}
      </span>
      {trailing}
      {selected !== undefined && (
        <span className="inline-flex w-4 shrink-0 justify-center text-fg">
          {selected && <Icon as={Check} size={14} />}
        </span>
      )}
    </button>
  );
}

/** Opens the two-step confirmation and never performs the act; danger is a tone here, not a DangerButton. */
export function RowAction({
  label,
  onClick,
  danger = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`${menuRow("center")} disabled:text-muted ${
        danger ? "text-danger hover:bg-danger/15" : "text-fg hover:bg-raised"
      }`}
    >
      {label}
    </button>
  );
}

function focusableRows(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>("button:not(:disabled)"));
}

/** Scrolls only the panel, since focus alone would also scroll the enclosing sheet. */
function revealWithin(panel: HTMLElement, row: HTMLElement): void {
  const rowBox = row.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  if (rowBox.top < panelBox.top) panel.scrollTop -= panelBox.top - rowBox.top;
  else if (rowBox.bottom > panelBox.bottom) panel.scrollTop += rowBox.bottom - panelBox.bottom;
}

/** Arrow keys on the panel element, never on window; Escape belongs to overlay.ts, and focus returns to the trigger on close. */
function useListKeys(open: boolean): {
  panelRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
} {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    returnRef.current = document.activeElement as HTMLElement | null;
    const rows = focusableRows(panel);
    const selected = rows.findIndex((row) => row.getAttribute("aria-selected") === "true");
    const target = rows[selected < 0 ? 0 : selected] ?? panel;
    target.focus({ preventScroll: true });
    if (target !== panel) revealWithin(panel, target);
    return () => {
      const back = returnRef.current;
      returnRef.current = null;
      if (back === null) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body && !panel.contains(active)) return;
      if (back.isConnected) back.focus({ preventScroll: true });
      else document.body.focus();
    };
  }, [open]);

  return {
    panelRef,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>): void => {
      // Built by hand: isComposing lives only on the native event.
      const action = listNavKey({
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
      });
      if (action === null) return;
      const panel = panelRef.current;
      if (panel === null) return;
      const rows = focusableRows(panel);
      const at = nextOptionIndex(action, rows.indexOf(document.activeElement as HTMLElement), rows.length);
      if (at === null) return;
      event.preventDefault();
      const row = rows[at];
      if (row === undefined) return;
      row.focus({ preventScroll: true });
      revealWithin(panel, row);
    },
  };
}

/** A panel anchored to its trigger: absolute and never portalled, so no ancestor between trigger and scroller may clip. */
export function Menu({
  trigger,
  children,
  placement = "down",
  align = "left",
  className = "",
  panelClassName = "",
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: "up" | "down";
  align?: "left" | "right";
  className?: string;
  panelClassName?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { panelRef, onKeyDown } = useListKeys(open);

  useDismissible("menu", () => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    // `pointerdown` and never `blur`: the menu is made of buttons, and blur fires
    // before the click that chose one lands.
    const close = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      {trigger(open, () => setOpen(!open))}
      {open && (
        <div
          ref={panelRef}
          onKeyDown={onKeyDown}
          tabIndex={-1}
          role="menu"
          className={`absolute ${LAYER.menu} ${POPOVER} ${
            placement === "up" ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export interface DropdownItem<T> {
  value: T;
  label: string;
  /** On a disabled item this is the refusal, so it stays at full strength. */
  description?: string | null;
  group?: string | null;
  /** Unusable but still listed; a disabled item owes a description saying why. */
  disabled?: boolean;
  adornment?: ReactNode;
}

/** The one popover picker, for any control whose option count can exceed about five; placement is the caller's, read at the tap. */
export function Dropdown<T extends string>({
  items,
  value,
  onChange,
  trigger,
  heading,
  placement = "down",
  disabled = false,
  busy = false,
  title,
  align = "left",
  className = "",
}: {
  items: readonly DropdownItem<T>[];
  value: T | null;
  onChange: (value: T) => void;
  trigger: ReactNode;
  heading?: string;
  placement?: "up" | "down";
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  align?: "left" | "right";
  className?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { panelRef, onKeyDown } = useListKeys(open);

  // Escape goes through overlay.ts; only the outside press is handled here.
  useDismissible("menu", () => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        // The disabled trigger dims its label only: its border is all that marks it as a control.
        className="tap press inline-flex min-h-8 w-full items-center gap-1.5 rounded-md border border-edge-strong bg-surface px-2.5 text-xs text-fg hover:bg-raised disabled:text-faint [@media(pointer:coarse)]:min-h-11"
      >
        {trigger}
        {busy ? <Spinner /> : <Icon as={ChevronDown} size={12} className="ml-auto text-faint" />}
      </button>

      {open && (
        <div
          ref={panelRef}
          onKeyDown={onKeyDown}
          tabIndex={-1}
          role="listbox"
          className={`absolute w-60 max-w-[min(20rem,calc(100vw-2rem))] ${MENU_PANEL} ${
            placement === "up" ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          {heading !== undefined && <p className={MENU_HEADING}>{heading}</p>}
          {items.map((item, index) => {
            const showGroup =
              item.group !== null && item.group !== undefined && item.group !== items[index - 1]?.group;
            const selected = item.value === value;
            const unavailable = item.disabled === true;
            return (
              <div key={`${item.group ?? ""}:${item.value}`}>
                {showGroup && <p className="mt-1 px-2 py-0.5 text-2xs text-faint">{item.group}</p>}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={unavailable}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) onChange(item.value);
                  }}
                  // No opacity when disabled: the description is the refusal and must stay legible, and hover is granted by state.
                  className={`${menuRow("start")} text-fg ${unavailable ? "" : "hover:bg-raised"} ${
                    selected ? "font-medium" : ""
                  }`}
                >
                  <span className="mt-0.5 w-3 shrink-0">{selected && <Icon as={Check} size={11} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      {item.adornment}
                      <span className={`min-w-0 truncate ${unavailable ? "text-muted" : ""}`}>
                        {item.label}
                      </span>
                    </span>
                    {item.description !== null && item.description !== undefined && (
                      <span className="block text-2xs text-faint">{item.description}</span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
