import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Icon } from "../bits";
import { copyText } from "../clipboard";
import { toast } from "../Toast";

/** Copy one value from beside it: a ghost square whose glyph turns into a check, and a toast when the platform refuses. */
export function CopyButton({ value, label }: { value: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (ok) setCopied(true);
          else toast("error", "Could not copy — select it by hand.");
        });
      }}
      aria-label={copied ? "Copied" : `Copy ${label}`}
      title={`Copy ${label}`}
      className="tap press relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
    >
      <Icon as={Copy} size={16} className={`absolute transition-opacity duration-300 ${copied ? "opacity-0" : "opacity-100"}`} />
      <Icon as={Check} size={16} className={`absolute transition-opacity duration-300 ${copied ? "opacity-100" : "opacity-0"}`} />
    </button>
  );
}
