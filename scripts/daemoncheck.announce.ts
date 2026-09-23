import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./daemoncheck.env.js";
import { tmp } from "./tmp.js";
import { ANNOUNCE_VERSION, announcedControlPlane, announcePath, removeAnnounce, writeAnnounce } from "../src/announce.js";

/* ------------------------------------------------------------------ *
 * What a daemon says about itself to the computer it is running on
 *
 * **The file is the security argument, so the mode is the assertion.** A client on
 * this machine has to carry a machine token to prove anything to a daemon, and a
 * token shown to the wrong listener is a 300-second bearer spendable through the
 * relay from anywhere. What makes this safe rather than a port probe is that the
 * announcement lives somewhere only this uid can write — so the whole of what is
 * being checked here is that it actually does, including on an upgrade into a
 * directory that already existed with wider permissions.
 *
 * `packages/native/src-tauri/src/local.rs` is the only reader; `nativecheck`
 * compares the two shapes off disk, since neither language can see the other.
 *
 * Every call names the **state root** rather than a home — `~/.reemoat` for a
 * daemon started any ordinary way, `~/.reemoat/servers/<server>/` or
 * `~/.reemoat/servers/<server>@<userId>/` for one the desktop app runs for another
 * server or another account on it (Q7.148, Q7.149) — so the fixture is a home with a
 * `.reemoat` inside it, which is the shape both of those are.
 * ------------------------------------------------------------------ */

process.stdout.write("\nannouncing a daemon to its own computer\n");

const home = tmp("daemoncheck-announce-");
const root = join(home, ".reemoat");

const announce = {
  v: ANNOUNCE_VERSION,
  machineId: "m_ab12",
  host: "127.0.0.1",
  port: 7887,
  instanceId: "i_x",
  authMode: "signed" as const,
  controlPlane: "https://cp.example",
};

{
  writeAnnounce(announce, root);
  const path = announcePath(root);
  check("it lands where a client looks for it", path, join(root, "daemon.json"));
  check("and round-trips as itself", JSON.parse(readFileSync(path, "utf8")) as unknown, announce);

  /*
   * ⚠ **0600 and 0700, and the second one is the one that matters.** A file another
   * OS user can *write* is a file that can name a port they control, which is the
   * whole attack this design exists to close — a harvested machine token, spendable
   * from anywhere through the relay. `store/sqlite.ts` makes the same argument for
   * the database beside it.
   */
  check("the file is readable by nobody else", statSync(path).mode & 0o777, 0o600);
  check("nor is the directory holding it", statSync(root).mode & 0o777, 0o700);
}

{
  /*
   * ⚠ **Whose daemon this is, written down beside where it is.** `~/.reemoat` is
   * shared by every daemon started without `REEMOAT_HOME`, so the machine id alone
   * could not tell the desktop app that the daemon announced there was enrolled
   * with another control plane — and it told somebody a daemon *for this server*
   * was running as a machine they could not see. The host compares this field with
   * the server it is on; `nativecheck` holds the two shapes together and the
   * comparison in place.
   */
  check(
    "the file names the control plane the daemon enrolled with",
    (JSON.parse(readFileSync(announcePath(root), "utf8")) as { controlPlane?: unknown }).controlPlane,
    "https://cp.example",
  );
  writeAnnounce({ ...announce, controlPlane: null }, root);
  check(
    "and an unknown one is written as null rather than left out",
    Object.hasOwn(JSON.parse(readFileSync(announcePath(root), "utf8")) as object, "controlPlane"),
    true,
  );
  writeAnnounce(announce, root);
  /*
   * The identity's column holds a string and never `NULL`, so a blank one is the
   * only "not known" it can say. Trimmed and nothing else — the reader normalizes,
   * and a second normalizer here would be a second opinion about what an origin is.
   */
  check("a blank enrolled address is announced as unknown", announcedControlPlane("  "), null);
  check("and a real one as it was typed, trimmed", announcedControlPlane(" https://cp.example/ "), "https://cp.example/");
}

{
  /*
   * **The upgrade case, which `mkdirSync(mode)` does not cover.** That mode applies
   * only to directories it actually created, so a `~/.reemoat` that already exists
   * at 0755 — every machine enrolled before this shipped — would keep its mode and
   * the announcement would be world-readable. `store/sqlite.ts` learnt this for the
   * WAL files; the same `chmodSync` is why it holds here.
   */
  const older = tmp("daemoncheck-announce-old-");
  mkdirSync(join(older, ".reemoat"), { recursive: true });
  chmodSync(join(older, ".reemoat"), 0o755);
  writeAnnounce(announce, join(older, ".reemoat"));
  check("an existing wide directory is narrowed rather than left", statSync(join(older, ".reemoat")).mode & 0o777, 0o700);
  rmSync(older, { recursive: true, force: true });
}

{
  /*
   * **Published by a rename, so a reader never sees half a file.** The reader is a
   * separate process polling on its own schedule; a partial write is a parse
   * failure, which degrades to the relay — but a temporary file left behind is a
   * file somebody finds in `~/.reemoat` and wonders about.
   */
  writeAnnounce({ ...announce, port: 7899 }, root);
  check("a second write replaces the first", (JSON.parse(readFileSync(announcePath(root), "utf8")) as { port: number }).port, 7899);
  const leftovers = readdirSafe(root).filter((name) => name !== "daemon.json");
  check("and leaves no temporary file behind", leftovers, []);
}

{
  /*
   * ⚠ **Another daemon's stop may not take this one's file.** Two daemons sharing
   * a root are last-writer-wins by design, and the removal used to unlink whatever
   * was at the path — so the daemon that *lost* the race deleted the winner's
   * announcement on its own clean stop, and the desktop app lost the local route
   * to a daemon that was still running. `i_x` wrote the file; `i_other` is the
   * loser shutting down.
   */
  removeAnnounce("i_other", root);
  check("a daemon removes only its own announcement", existsSafe(announcePath(root)), true);
  check("and the file it left is still the winner's", (JSON.parse(readFileSync(announcePath(root), "utf8")) as { instanceId: string }).instanceId, "i_x");

  removeAnnounce("i_x", root);
  report("a clean shutdown stops advertising", !existsSafe(announcePath(root)), announcePath(root));
  /*
   * Twice, because a daemon that never announced — `shared_secret`, or one that
   * could not write — still runs this on the way out, and a shutdown path that
   * threw there would turn a tidy-up into a failed stop.
   */
  removeAnnounce("i_x", root);
  report("and doing it twice is not an error", true, "no throw on a second remove");

  /*
   * And a file that does not parse is left alone: this daemon publishes by
   * rename, so it never leaves half a file, and a malformed one is therefore not
   * one it wrote.
   */
  writeFileSync(announcePath(root), "{ not json");
  removeAnnounce("i_x", root);
  check("a file this daemon cannot read as its own is left in place", existsSafe(announcePath(root)), true);
  rmSync(announcePath(root), { force: true });
}

{
  /*
   * A daemon whose home is not writable at all. The caller reports and carries on:
   * every client can still reach this machine the way every other one does.
   */
  const blocked = join(tmp("daemoncheck-announce-blocked-"), "not-a-directory");
  writeFileSync(blocked, "");
  let threw = false;
  try {
    writeAnnounce(announce, join(blocked, ".reemoat"));
  } catch {
    threw = true;
  }
  report("an unwritable home throws rather than half-announcing", threw, "caller reports and continues");
  check("and nothing was created", existsSafe(announcePath(join(blocked, ".reemoat"))), false);
}

rmSync(home, { recursive: true, force: true });

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function existsSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
