import { check, report } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";
import type { NativeBoot } from "../src/native.js";
import type { BackAccount } from "../src/ui/backAccount.js";

// The store's half is read off the source, comment-stripped: it cannot be constructed here with a shell behind it.

process.stdout.write("\naccounts on this computer\n");

const slot = await import("../src/slot.js");

function bootWith(fields: Partial<NativeBoot>): NativeBoot {
  return {
    server: "https://app.example",
    credential: null,
    platform: "macos",
    picksFolder: true,
    canHostDaemon: true,
    hostName: "laptop",
    appVersion: "0.0.0",
    durable: true,
    deviceId: null,
    devicePublicKey: null,
    deviceKeyAtRest: null,
    defaultServer: null,
    claimed: null,
    account: null,
    name: null,
    legacy: false,
    deviceBound: false,
    generation: "g_1",
    rebinding: false,
    ...fields,
  };
}

const pending = bootWith({});
const legacy = bootWith({ legacy: true });
const account = bootWith({ account: "https://app.example#u_ada", name: "ada" });
/* An account whose server still has kept items waiting for proof: an account, not a legacy one. */
const accountAwaitingProof = bootWith({ account: "https://app.example#u_ada", name: "ada", legacy: true });

{
  check(
    "a window is pending, legacy or an account, and nothing in a browser",
    [slot.slotOf(null), slot.slotOf(pending), slot.slotOf(legacy), slot.slotOf(account)],
    [null, "pending", "legacy", "account"],
  );
  // The account is read before the legacy flag: the host keeps `legacy` true for an account while kept items still wait for proof.
  check("an attributed account is an account whatever else waits for proof", slot.slotOf(accountAwaitingProof), "account");
}

{
  const exits = (boot: NativeBoot | null, back: string | null | undefined): [boolean, boolean, boolean] => {
    const e = slot.signInExits(boot, back);
    return [e.server, e.back, e.remove];
  };
  const OTHER = "https://other.example#u_bob";
  check(
    "the sign-in screen's exits, for every window and both answers",
    [
      exits(null, OTHER),
      exits(pending, null),
      exits(pending, OTHER),
      exits(legacy, null),
      exits(legacy, OTHER),
      exits(account, null),
      exits(account, OTHER),
    ],
    [
      [false, false, false],
      [false, false, false],
      [true, false, false],
      [false, false, true],
      [false, true, true],
      [false, false, true],
      [false, true, true],
    ],
  );
  // `useBackAccount` gives `undefined` until the host replies, and a way back drawn on that would go nowhere.
  check(
    "and a list not answered yet offers no way back",
    [exits(pending, undefined)[0], exits(account, undefined)[1], exits(account, "")[1]],
    [false, false, false],
  );
}

{
  // Run over every value the hook's type admits: a guard for a shape it never returns compiles clean and hides the control for good.
  check(
    "useBackAccount still answers an account, null or undefined",
    /export function useBackAccount\(\): BackAccount \| null \| undefined \{/.test(stripComments(srcFile("ui/backAccount.ts"))),
    true,
  );
  const control = stripComments(srcFile("ui/UseAnotherAccount.tsx"));
  const guard = /const back = useBackAccount\(\);[\s\S]*?if \((.+)\) return null;/.exec(control)?.[1] ?? "";
  report("UseAnotherAccount's guard was found", guard.length > 0, guard);
  const hides = new Function("back", `return ${guard};`) as (back: BackAccount | null | undefined) => boolean;
  const other: BackAccount = { key: "https://other.example#u_bob", label: "bob" };
  check(
    "the forced password change offers another account once the host names one, and not before",
    [hides(undefined), hides(null), hides(other)],
    [true, true, false],
  );
}

{
  // A legacy sign-in is proved on every launch until attributed; for an account, a changed name is the only way a rename reaches the drawer.
  check(
    "a legacy window is always confirmed, an account only when its name moved",
    [
      slot.confirmDue(legacy, null),
      slot.confirmDue(legacy, { name: "ada" }),
      slot.confirmDue(account, { name: "ada" }),
      slot.confirmDue(account, { name: "ada lovelace" }),
      slot.confirmDue(account, null),
      slot.confirmDue(pending, { name: "ada" }),
      slot.confirmDue(null, { name: "ada" }),
    ],
    [true, true, false, true, false, false, false],
  );
}

{
  // Display only, never compared: `http` and `https` are different trust boundaries, so only `https` loses its scheme.
  check(
    "a server is drawn as its host on https and whole otherwise",
    [
      slot.serverLabel("https://app.example"),
      slot.serverLabel("https://app.example:8443"),
      slot.serverLabel("http://127.0.0.1:8787"),
      slot.serverLabel("http://app.example"),
      slot.serverLabel("not an address"),
    ],
    ["app.example", "app.example:8443", "http://127.0.0.1:8787", "http://app.example", "not an address"],
  );
}

{
  const store = stripComments(srcFile("store.ts"));
  report("the store was read", store.length > 10_000, `${store.length} chars`);

  // A document is one account for its whole life, so a switch never detaches its session.
  const switchBody = /async switchAccount\(account: string \| null\): Promise<void> \{([\s\S]*?)\n  \}/.exec(store)?.[1] ?? "";
  report("switchAccount's body was found", switchBody.length > 0, switchBody.trim());
  check(
    "a switch asks the host, reloads only when told, and detaches nothing",
    [
      /switchNativeAccount\(account\)/.test(switchBody),
      /if \(moved\.reload\) window\.location\.replace\("\/"\);/.test(switchBody),
      /detachSession/.test(switchBody),
      /location\.assign/.test(switchBody),
    ],
    [true, true, false, false],
  );
  check(
    "and so do adding and forgetting, and Cancel is a switch back",
    [
      /async addAccount\(\): Promise<void> \{\s*const moved = await addNativeAccount\(\);\s*if \(moved\.reload\) window\.location\.replace\("\/"\);/.test(store),
      /async forgetAccount\(\): Promise<void> \{\s*const moved = await forgetNativeAccount\(\);\s*if \(moved\.reload\) window\.location\.replace\("\/"\);/.test(store),
      /switchBack\(\): Promise<void> \{\s*return this\.switchAccount\(null\);/.test(store),
    ],
    [true, true, true],
  );

  // Confirming moves the device under the account it turns out to be, so it must precede registration and setup.
  const boot = /async bootstrap\(\): Promise<void> \{([\s\S]*?)\n  \}\n/.exec(store)?.[1] ?? "";
  const confirmAt = boot.indexOf("this.confirmAccount()");
  const deviceAt = boot.indexOf("this.ensureDevice()");
  const setUpAt = boot.indexOf("this.beginSetUp()");
  check("bootstrap still does all three", [confirmAt >= 0, deviceAt >= 0, setUpAt >= 0], [true, true, true]);
  check("and confirms before it registers, and registers before it sets up", confirmAt < deviceAt && deviceAt < setUpAt, true);
  check("and stops where the confirm says this document is leaving", /if \(await this\.confirmAccount\(\)\) return;/.test(boot), true);
  check("and patches in the live snapshot, not the first answer", /this\.patch\(\{ host: nativeBoot\(\) \?\? boot \}\);/.test(boot), true);

  // In the shell a device id is known before the sign-in that uses it, so having an id does not mean bound.
  check("a device is registered unless it is known and bound", /cp\.currentDevice\(\) !== null && cp\.deviceBound\(\)/.test(store), true);

  // A duplicate leaves the remembered controls alone: the same person's other window is still open on them.
  const confirmBody = /private async confirmAccount\(\): Promise<boolean> \{([\s\S]*?)\n  \}/.exec(store)?.[1] ?? "";
  report("confirmAccount's body was found", confirmBody.length > 0, `${confirmBody.length} chars`);
  check(
    "a window that owes a proof reaches the host's confirm",
    [/if \(!confirmDue\(nativeBoot\(\), this\.snapshot\.me\)\) return false;/.test(confirmBody), /await confirmNativeAccount\(\)/.test(confirmBody)],
    [true, true],
  );
  check(
    "and a duplicate is revoked and forgotten without sweeping the remembered controls",
    [
      /answer\.outcome === "existing"[\s\S]*?await cp\.logout\(\);[\s\S]*?forgetNativeAccount\(\)/.test(confirmBody),
      /forgetAllConfig/.test(confirmBody),
    ],
    [true, false],
  );

  check(
    "a sign-in to an account already here moves the window there",
    /instanceof cp\.AccountAlreadyOpen[\s\S]{0,160}this\.switchAccount\(cause\.account\)/.test(store),
    true,
  );

  const signOutBody = /async signOut\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(store)?.[1] ?? "";
  report("signOut's body was found", signOutBody.length > 0, `${signOutBody.length} chars`);
  check(
    "sign-out revokes first, keeps the browser's navigation, and forgets the account in the shell",
    [
      /^\s*await cp\.logout\(\);/.test(signOutBody),
      /if \(this\.snapshot\.host === null\) \{\s*window\.location\.href = "\/";\s*return;\s*\}/.test(signOutBody),
      signOutBody.indexOf("cp.logout()") < signOutBody.indexOf("forgetNativeAccount()"),
    ],
    [true, true, true],
  );
}

{
  const cp = stripComments(srcFile("cp.ts"));
  const loginBody = /export async function login\([\s\S]*?\n\}/.exec(cp)?.[0] ?? "";
  const registerBody = /async function registerOnce\([\s\S]*?\n\}/.exec(cp)?.[0] ?? "";
  report("the two bodies were found", loginBody.length > 0 && registerBody.length > 0, `${loginBody.length} and ${registerBody.length} chars`);
  check(
    "the sign-in describes no device, and the registration after it does",
    [/describeDevice\(\)/.test(loginBody), /describeDevice\(\)/.test(registerBody)],
    [false, true],
  );
  check("the sign-in adopts only what the host bound", /if \(bound\.outcome !== "bound"\) throw/.test(loginBody), true);
  // `ensureDevice` after a sign-in and a mint refused for a missing key can meet; two in flight would register two rows for one computer.
  check("the registration is single-flight", /registering \?\?= registerOnce\(\)/.test(cp), true);
}
