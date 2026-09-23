import { useState, type ReactNode } from "react";
import { errorText } from "../http";
import { store } from "../store";
import { useBackAccount } from "./backAccount";
import { Button } from "./bits";

/**
 * A way to another account from a screen that has no drawer.
 *
 * ⚠ **The trap several accounts create, and the one screen it is still set in.**
 * The drawer is where accounts are switched, and it belongs to the app shell — so
 * a window that never reaches the shell has no way to any other account. That is
 * **the forced password change**, which an account added with a temporary password
 * lands on, with nothing to press but the form and Sign out. This bypasses nothing:
 * the wall is about *this* account and stays in front of it.
 *
 * ⚠ **There were two, and the other was removed rather than patched.** An
 * unreachable server kept the app on the loading screen, and this button sat under
 * the outage sentence. The owner's call (2026-09-23) was that an outage is not a
 * screen at all: the shell is drawn — drawer included — and the outage is a line
 * under the conversation's title (`store.bootstrap`'s catch, `SessionView`).
 *
 * Drawn only where the host's **live** list names an account to go back to
 * (`useBackAccount`), and nowhere in a browser, which has no list. A component of
 * its own rather than a hook in `App`, because `App`'s hooks all run above its
 * first early return and `webcheck` holds that — this one belongs to the screen
 * that draws it. A refusal is said under the control, because that screen draws no
 * toast host.
 */
export function UseAnotherAccount(): ReactNode {
  const back = useBackAccount();
  const [said, setSaid] = useState<string | null>(null);
  if (typeof back !== "string") return null;
  return (
    <>
      <Button
        tone="ghost"
        onClick={() => {
          setSaid(null);
          void store.switchBack().catch((cause: unknown) => setSaid(errorText(cause)));
        }}
      >
        Use another account
      </Button>
      {said !== null && <p className="text-sm text-danger">{said}</p>}
    </>
  );
}
