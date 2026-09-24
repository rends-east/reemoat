import { ChevronLeft } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { navigate } from "../router";
import { LAYER } from "./overlay";
import { IconButton } from "./bits";

/** A screen's sticky top bar. Its chevron always goes to the list (`/`), never `history.back()`. */
export function Header({
  title,
  subtitle,
  close = false,
  backRef,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  close?: boolean;
  /** The chevron is laid out exactly where a back swipe may run (Q3.663). */
  backRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}): ReactNode {
  return (
    <header
      // One `max()` for the top inset: unlayered `.pt-safe` would beat any `pt-*` here.
      className={`sticky top-0 ${LAYER.header} flex items-center gap-2 bg-surface/95 px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-3 backdrop-blur`}
    >
      {close && (
        <IconButton
          ref={backRef}
          icon={ChevronLeft}
          label="Back to sessions"
          onClick={() => navigate("/")}
          size="bar"
          className="-ml-1 lg:hidden"
        />
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
