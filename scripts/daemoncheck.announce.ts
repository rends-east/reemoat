import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./daemoncheck.env.js";
import { tmp } from "./tmp.js";
import { ANNOUNCE_VERSION, announcedControlPlane, announcePath, removeAnnounce, writeAnnounce } from "../src/announce.js";

// Calls name the state root rather than a home, so the fixture is a home with .reemoat inside it (Q7.148, Q7.149).

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

  // A file another OS user can write could name a port they control and harvest a machine token.
  check("the file is readable by nobody else", statSync(path).mode & 0o777, 0o600);
  check("nor is the directory holding it", statSync(root).mode & 0o777, 0o700);
}

{
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
  check("a blank enrolled address is announced as unknown", announcedControlPlane("  "), null);
  check("and a real one as it was typed, trimmed", announcedControlPlane(" https://cp.example/ "), "https://cp.example/");
}

{
  // mkdirSync's mode applies only to directories it creates, so an existing 0755 root must be narrowed explicitly.
  const older = tmp("daemoncheck-announce-old-");
  mkdirSync(join(older, ".reemoat"), { recursive: true });
  chmodSync(join(older, ".reemoat"), 0o755);
  writeAnnounce(announce, join(older, ".reemoat"));
  check("an existing wide directory is narrowed rather than left", statSync(join(older, ".reemoat")).mode & 0o777, 0o700);
  rmSync(older, { recursive: true, force: true });
}

{
  writeAnnounce({ ...announce, port: 7899 }, root);
  check("a second write replaces the first", (JSON.parse(readFileSync(announcePath(root), "utf8")) as { port: number }).port, 7899);
  const leftovers = readdirSafe(root).filter((name) => name !== "daemon.json");
  check("and leaves no temporary file behind", leftovers, []);
}

{
  // Two daemons sharing a root are last-writer-wins: the loser's clean stop must not unlink the winner's file.
  removeAnnounce("i_other", root);
  check("a daemon removes only its own announcement", existsSafe(announcePath(root)), true);
  check("and the file it left is still the winner's", (JSON.parse(readFileSync(announcePath(root), "utf8")) as { instanceId: string }).instanceId, "i_x");

  removeAnnounce("i_x", root);
  report("a clean shutdown stops advertising", !existsSafe(announcePath(root)), announcePath(root));
  removeAnnounce("i_x", root);
  report("and doing it twice is not an error", true, "no throw on a second remove");

  writeFileSync(announcePath(root), "{ not json");
  removeAnnounce("i_x", root);
  check("a file this daemon cannot read as its own is left in place", existsSafe(announcePath(root)), true);
  rmSync(announcePath(root), { force: true });
}

{
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
