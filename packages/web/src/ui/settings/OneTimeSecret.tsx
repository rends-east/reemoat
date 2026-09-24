import { Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Icon, SETTINGS_HEADING } from "../bits";
import { copyText } from "../clipboard";
import { toast } from "../Toast";

/** A value shown once and stored only as a hash: selectable for when copy fails, `text-xs` to transcribe, `onDone` required. */
export function OneTimeSecret({
  label,
  value,
  note,
  onDone,
}: {
  label: string;
  value: string;
  note: string;
  onDone: () => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void copyText(value).then((ok) => {
      if (!ok) {
        toast("error", "Could not copy — select it by hand.");
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="mt-3 rounded-lg border border-edge-strong bg-raised p-3">
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 ${SETTINGS_HEADING}`}>{label}</span>
        {/* A live label: the swap under a focused button is otherwise not announced. */}
        <Button onClick={copy} ariaLabel={`Copy ${label}`}>
          <Icon as={Copy} size={13} />
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      {/* The full `bg-raised` step: a once-only secret may not sit in a subtle box. */}
      <pre className="mt-2 rounded-sm bg-raised p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere select-all text-fg">
        {value}
      </pre>
      <p className="mt-2 text-2xs text-muted">{note}</p>
      <Button tone="ghost" className="mt-2" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
