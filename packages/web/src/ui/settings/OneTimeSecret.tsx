import { Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Icon, SETTINGS_HEADING } from "../bits";
import { copyText } from "../clipboard";

/**
 * A value that exists in one response and nowhere else.
 *
 * Two of them use this: a new user's password and a machine's enrollment code.
 * Both are stored as a hash, neither can be recovered, and the card says so
 * rather than letting somebody discover it by closing the panel.
 *
 * **Monospace, wrapping, and still selectable.** Wrapping because an enrollment
 * code is 46 characters and truncating it on a phone would hide the part that
 * matters; selectable because the copy button uses `navigator.clipboard`, which
 * needs a secure context — a dev host that is not `localhost` over plain http does
 * not have one, and neither does an older browser. Text you can select is the
 * fallback that always works.
 */
export function OneTimeSecret({
  label,
  value,
  note,
  onDone,
}: {
  label: string;
  value: string;
  note: string;
  onDone?: () => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    /*
     * Through `copyText`, and this is the call site that most needed it: the value
     * is shown **once**, and on a plain-http LAN origin `navigator.clipboard` is
     * absent rather than refusing — so the button did nothing on exactly the
     * deployment where an enrollment secret is read off a phone. Selecting it by
     * hand was the stated fallback and still is, one line down, if both paths fail.
     */
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      // Long enough to read, short enough that it is clearly about the last tap.
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="mt-3 rounded-lg border border-edge-strong bg-raised p-3">
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 ${SETTINGS_HEADING}`}>{label}</span>
        <Button onClick={copy} ariaLabel={`Copy ${label}`}>
          <Icon as={Copy} size={13} />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {/* `bg-raised`, and this is the one block in the app that may not be
          subtle. It was `bg-ink`, which is the rail's tone — 1.06:1 on the
          surface this is drawn on since the palette went delicate, i.e. a
          password or an API key shown *once* in a box with no fill and no border.
          A value you are being asked to copy before it stops existing gets the
          full step. */}
      <pre className="mt-2 rounded-sm bg-raised p-2 font-mono text-2xs whitespace-pre-wrap wrap-anywhere select-all text-fg">
        {value}
      </pre>
      <p className="mt-2 text-2xs text-muted">{note}</p>
      {onDone !== undefined && (
        <Button tone="ghost" className="mt-2" onClick={onDone}>
          Done
        </Button>
      )}
    </div>
  );
}
