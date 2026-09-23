import { check, report } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";
import type { NativeBoot } from "../src/native.js";

/* ------------------------------------------------------------------ *
 * Several accounts on one computer, from the page's side
 *
 * The host decides which account a window is — it proves a sign-in by asking the
 * control plane itself, and binds a window's commands to its document — and the
 * page's share is small and easy to get wrong in silence: reading the answer the
 * same way on every screen, doing the three bootstrap steps in the host's order,
 * and never detaching a document that is one account for its whole life. Each rule
 * here was a design argument before it was a line, and none of them has a symptom
 * a person would report as the rule.
 *
 * The table is `slot.ts`, pure, and driven. The store's half is read off the
 * source, comment-stripped, because the store cannot be constructed here with a
 * shell behind it — `hostReady` settled at import with no shell, and the shell
 * sections of this driver install theirs afterwards (`webcheck.local-route.ts`
 * pins that fact about itself).
 * ------------------------------------------------------------------ */

process.stdout.write("\naccounts on this computer\n");

const slot = await import("../src/slot.js");

/** A boot payload with only the fields the table reads set, and the rest inert. */
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

/* ---- what a window is ---- */
{
  check(
    "a window is pending, legacy or an account, and nothing in a browser",
    [slot.slotOf(null), slot.slotOf(pending), slot.slotOf(legacy), slot.slotOf(account)],
    [null, "pending", "legacy", "account"],
  );
  /*
   * ⚠ **The account is read before the legacy flag.** The host keeps `legacy` true
   * for an attributed account while anything it kept for that server still waits
   * for proof; reading the flag first would call a signed-in account a legacy one
   * and take away its ‹ Server-less screen for the wrong reason.
   */
  check("an attributed account is an account whatever else waits for proof", slot.slotOf(accountAwaitingProof), "account");
}

/* ---- the ways off the sign-in screen ---- */
{
  /*
   * The whole table, both `back` answers for every kind of window. ‹ Server only
   * where nobody has signed in (an account is a server and a person) **and** there
   * is an account to return to — a first sign-in has no way back, the owner's call
   * of 2026-09-24; ‹ *that account* only on a listed window with somewhere to go;
   * never both; Remove only where the window is on the list. A browser, and the
   * gate, offer none of the three.
   */
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
  /*
   * ⚠ **Not answered yet is not an answer.** `useBackAccount` gives `undefined`
   * until the host replies; a way back drawn on it would go nowhere.
   */
  check(
    "and a list not answered yet offers no way back",
    [exits(pending, undefined)[0], exits(account, undefined)[1], exits(account, "")[1]],
    [false, false, false],
  );
}

/* ---- when the host is asked to prove an account again ---- */
{
  /*
   * ⚠ **A kept sign-in nobody has attributed is proved on every launch until it
   * has been**, with or without `me` — the host's own request is what decides, and
   * a page that skipped it while the control plane was down would never ask again
   * this session. A cached name the server no longer gives is the other reason,
   * and it is the only way a rename reaches the drawer.
   */
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

/* ---- a server, drawn under a name ---- */
{
  /*
   * Display only, never compared: `https` loses its scheme and nothing else does,
   * because `http://x` and `https://x` are different trust boundaries and two
   * accounts on them must not draw the same line.
   */
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

/* ---- the store's half, off the source ---- */
{
  const store = stripComments(srcFile("store.ts"));
  report("the store was read", store.length > 10_000, `${store.length} chars`);

  /*
   * ⚠ **A switch never detaches this document's session.** A document is one
   * account for its whole life: where the host shows another window this page
   * stays alive, hidden, with its sockets and poll — a detach would strand it with
   * no credential — and where it rebinds this one, the generation already refuses
   * anything late. Reloads only when told, with `replace`.
   */
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

  /*
   * ⚠ **Confirm, then register, then set up — the host's order.** Confirming a
   * kept sign-in is what moves its device under the account it turns out to be and
   * records whose the daemon root is, so a registration before it would describe
   * nobody's device and a setup before it would start a database nobody has proved
   * is theirs. Indices inside `bootstrap`, each checked against `>= 0` first.
   */
  const boot = /async bootstrap\(\): Promise<void> \{([\s\S]*?)\n  \}\n/.exec(store)?.[1] ?? "";
  const confirmAt = boot.indexOf("this.confirmAccount()");
  const deviceAt = boot.indexOf("this.ensureDevice()");
  const setUpAt = boot.indexOf("this.beginSetUp()");
  check("bootstrap still does all three", [confirmAt >= 0, deviceAt >= 0, setUpAt >= 0], [true, true, true]);
  check("and confirms before it registers, and registers before it sets up", confirmAt < deviceAt && deviceAt < setUpAt, true);
  check("and stops where the confirm says this document is leaving", /if \(await this\.confirmAccount\(\)\) return;/.test(boot), true);
  check("and patches in the live snapshot, not the first answer", /this\.patch\(\{ host: nativeBoot\(\) \?\? boot \}\);/.test(boot), true);

  /*
   * ⚠ **A known device id is not a bound one.** In the shell the id is an
   * account's, known before the sign-in that uses it, so "has an id" would skip the
   * registration a fresh sign-in needs.
   */
  check("a device is registered unless it is known and bound", /cp\.currentDevice\(\) !== null && cp\.deviceBound\(\)/.test(store), true);

  /*
   * The confirm asks the pure rule, calls the host with nothing, and on `existing`
   * signs out narrowly: the kept session revoked and the window taken off the list,
   * with the remembered controls deliberately left — the same person's other window
   * is still open on them.
   */
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

  /*
   * An account already on this computer is a move, not a failure: the sign-in
   * belongs in that account's window.
   */
  check(
    "a sign-in to an account already here moves the window there",
    /instanceof cp\.AccountAlreadyOpen[\s\S]{0,160}this\.switchAccount\(cause\.account\)/.test(store),
    true,
  );

  /*
   * ⚠ **Signing out in the shell takes the account off this computer; in a browser
   * it is the navigation it always was.** Both arms, since either alone is the
   * edit that looks like a tidy-up.
   */
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

/* ---- cp.ts: the sign-in names no device ---- */
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
  /*
   * ⚠ **One registration at a time.** `ensureDevice` after a sign-in and a mint
   * refused for a missing key can meet; with no id both would describe none, and
   * the control plane would register two rows for one computer.
   */
  check("the registration is single-flight", /registering \?\?= registerOnce\(\)/.test(cp), true);
}
