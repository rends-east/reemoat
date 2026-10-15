import { ChevronLeft } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { navigate } from "../router";
import { BOARD, selectMachine } from "./groups";
import { LAYER } from "./overlay";
import { IconButton } from "./bits";

/** A screen's sticky top bar. Its chevron goes to a fixed address, the list (`/`) unless told another, never `history.back()`. */
export function Header({
  title,
  subtitle,
  close = false,
  board = false,
  back = null,
  backRef,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  close?: boolean;
  /** A screen in the board's folder: its chevron goes back to the board, and is drawn at lg too, where the board is beside no list (Q3.734). */
  board?: boolean;
  /** Where the chevron goes instead, with its label: a task's page opened from a conversation goes back to it (Q3.736). */
  back?: { to: string; label: string } | null;
  /** The chevron is laid out exactly where a back swipe may run (Q3.663). */
  backRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}): ReactNode {
  const toBoard = (): void => {
    selectMachine(BOARD);
    navigate("/");
  };
  const leave = back !== null ? () => navigate(back.to) : board ? toBoard : () => navigate("/");
  const label = back !== null ? back.label : board ? "Back to the board" : "Back to sessions";
  return (
    <header
      // One `max()` for the top inset: unlayered `.pt-safe` would beat any `pt-*` here.
      className={`sticky top-0 ${LAYER.header} flex items-center gap-2 bg-surface/95 px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-3 backdrop-blur`}
    >
      {close && (
        <IconButton
          ref={backRef}
          icon={ChevronLeft}
          label={label}
          onClick={leave}
          size="bar"
          className="-ml-1 lg:hidden"
        />
      )}
      {/* A second chevron, at lg only: the first is the back swipe's gate, which a wide screen must not open. */}
      {close && board && (
        <span className="-ml-1 hidden lg:flex">
          <IconButton icon={ChevronLeft} label={label} onClick={leave} size="bar" />
        </span>
      )}
      {/* Centred below `lg` between the chevron and the kebab, which must stay the same size. */}
      <div className="min-w-0 flex-1">
        <h1 className="flex min-w-0 items-center justify-center gap-1.5 lg:justify-start">{title}</h1>
        {subtitle !== undefined && (
          <div className="flex min-w-0 justify-center text-2xs text-muted lg:justify-start">{subtitle}</div>
        )}
      </div>
      {children}
    </header>
  );
}
