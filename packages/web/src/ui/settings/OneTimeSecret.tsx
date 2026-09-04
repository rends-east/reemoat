import { Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Icon, SETTINGS_HEADING } from "../bits";
import { copyText } from "../clipboard";
import { toast } from "../Toast";

/**
 * A value that exists in one response and nowhere else.
 *
 * Four of them use this: a new user's temporary password, a machine's enrollment
 * code, the provisioning key and your own new API key. All are stored as a hash,
 * none can be recovered, and the card says so rather than letting somebody
 * discover it by closing the panel.
 *
 * **Monospace, wrapping, and still selectable.** Wrapping because an enrollment
 * code is 46 characters and truncating it on a phone would hide the part that
 * matters; selectable because the copy button uses `navigator.clipboard`, which
 * needs a secure context — a dev host that is not `localhost` over plain http does
 * not have one, and neither does an older browser. Text you can select is the
 * fallback that always works.
 *
 * ⚠ **`text-xs`, not `text-2xs`.** This is the one string on the screen that must
 * be transcribed — read off a phone into a terminal on another machine — and it
 * was the smallest type on the page. 10px monospace is where `0`/`O` and `l`/`1`
 * stop being distinguishable, which is the exact failure a secret shown once
 * cannot afford.
 *
 * ⚠ **`onDone` is required.** It was optional, and a caller that omitted it
 * shipped a card with no way to dismiss it — the secret stayed on screen until
 * the section unmounted, on a sheet somebody may leave open on a desk. Every
 * caller has a `setX(null)` to hand it, so the type is the reminder.
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
  onDone: () => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    /*
     * Through `copyText`, and this is the call site that most needed it: the value
     * is shown **once**, and on a plain-http LAN origin `navigator.clipboard` is
     * absent rather than refusing — so the button did nothing on exactly the
     * deployment where an enrollment secret is read off a phone. Selecting it by
     * hand was the stated fallback and still is — but a button that does nothing
     * *silently* is not a fallback anybody finds, so a failure now says so.
     */
    void copyText(value).then((ok) => {
      if (!ok) {
        toast("error", "Could not copy — select it by hand.");
        return;
      }
      setCopied(true);
      // Long enough to read, short enough that it is clearly about the last tap.
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="mt-3 rounded-lg border border-edge-strong bg-raised p-3">
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 ${SETTINGS_HEADING}`}>{label}</span>
        {/*
         * `aria-live="polite"` on the label swap: "Copied" is the only
         * confirmation the tap gets, and a label that changes under an already
         * focused button is not announced on its own. Mounted with the button and
         * only its text changing, which is the arrangement `Sheet` and
         * `SettingsNav` record as the one that reliably speaks.
         */}
        <Button onClick={copy} ariaLabel={`Copy ${label}`}>
          <Icon as={Copy} size={13} />
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      {/* `bg-raised`, and this is the one block in the app that may not be
          subtle. It was `bg-ink`, which is the rail's tone — 1.06:1 on the
          surface this is drawn on since the palette went delicate, i.e. a
          password or an API key shown *once* in a box with no fill and no border.
          A value you are being asked to copy before it stops existing gets the
          full step. */}
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
