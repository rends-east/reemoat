import { useState, type ReactNode } from "react";
import { errorText } from "../http";
import { store } from "../store";
import { useBackAccount } from "./backAccount";
import { Button } from "./bits";

/** For the forced password change, which has no drawer; a component because `App`'s hooks all run above its first early return. */
export function UseAnotherAccount(): ReactNode {
  const back = useBackAccount();
  const [said, setSaid] = useState<string | null>(null);
  if (back === null || back === undefined) return null;
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
