#!/bin/sh
# deploy/backup.sh [--dir <path>] [--keep <n>]
# deploy/backup.sh --schedule [--dir <path>] [--keep <n>]   # daily, via this host's init
# deploy/backup.sh --unschedule
#
# A consistent snapshot of the control plane's database, which holds the Ed25519
# key that signs every token in the fleet.
#
# **This is the only unrecoverable failure in the system, and until this file
# existed nothing automated it.** The repository carried the right *technique* —
# five lines of `VACUUM INTO` in `deploy/docker/README.md` — inside a section
# about Time Machine on macOS, framed as a caveat to the named-volume decision.
# There was no script, no timer, no CI step and no line in the runbook, and
# `deploy.sh` never touched the volume before swapping the image.
#
# What the volume holds: `signing_keys.private_pem`, every user and password
# hash, every machine and grant, and `instance_settings` including the SMTP
# password. A daemon records `keys_json` at enrollment and **never refetches it**
# (`src/enroll.ts`), so losing this file does not mean restoring a service — it
# means visiting every machine in the fleet with a fresh enrollment code, and
# `deploy/docker/README.md` already says out loud that there is no other way
# back.
#
# **`VACUUM INTO`, never `cp` and never a tar of the volume.** The database runs
# in WAL mode, so the file on disk is not the database — it is the database minus
# whatever is in `-wal`, and a copy taken mid-checkpoint restores as a corrupt
# page. `VACUUM INTO` is SQLite's own consistent snapshot, taken through a
# read-only handle inside the container that already has the file open.
#
# It runs against the **live** service and needs no downtime: a read-only
# connection under WAL does not block writers and is not blocked by them.
set -eu

# shellcheck source=deploy/lib.sh
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

# Beside the env file rather than in the repository, for the reason `deploy.sh`
# refuses a dirty tree: a backup written into the checkout is a file that stops
# the next deploy, and one written into a directory `.gitignore` covers is a file
# somebody deletes without knowing what it was.
DIR="${REEMOAT_BACKUP_DIR:-$HOME/.reemoat/backups}"
KEEP=14
MODE=run

while [ $# -gt 0 ]; do
  case "$1" in
    --schedule)
      MODE=schedule
      shift
      ;;
    --unschedule)
      MODE=unschedule
      shift
      ;;
    --dir)
      [ $# -ge 2 ] || {
        echo "--dir needs a value" >&2
        exit 2
      }
      DIR="$2"
      shift 2
      ;;
    --keep)
      [ $# -ge 2 ] || {
        echo "--keep needs a value" >&2
        exit 2
      }
      KEEP="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,4p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$KEEP" in
  '' | *[!0-9]*)
    echo "--keep takes a whole number of snapshots to keep, got '$KEEP'" >&2
    exit 2
    ;;
esac

# ------------------------------------------------------------------
# Scheduling
#
# **A backup that somebody has to remember is the state this file replaces.** The
# technique was already written down and never ran, so the script alone would be
# the same artifact one level better. This is the part that makes it a mechanism.
#
# Written directly rather than through `render_unit`, and that is a deliberate
# exception to "one template per init system": those templates carry eleven
# substitutions and exist because the daemon's unit differs per machine in
# eleven ways. This one has a single variable — the absolute path of this script
# — so a template would be a second file to keep in agreement with a one-line
# `ExecStart`.
#
# The launchd job goes in `~/Library/LaunchAgents` on purpose, which is the
# directory `install.sh` deliberately avoids for the *daemon*: that avoidance is
# about a unit carrying `RunAtLoad`/`KeepAlive` that is not meant to be started
# yet, and this one is meant to be started and carries neither.
# ------------------------------------------------------------------

SELF=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")
LAUNCHD_LABEL=com.reemoat.backup
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
SYSTEMD_DIR="$HOME/.config/systemd/user"

schedule() {
  detect_init
  require_init
  mkdir -p "$DIR"
  chmod 700 "$DIR" 2>/dev/null || true
  case "$INIT_SYSTEM" in
    launchd)
      mkdir -p "$(dirname "$LAUNCHD_PLIST")"
      # 04:17 rather than a round hour: every backup on every host firing at
      # 04:00 is a thundering herd against whatever they all write to.
      cat > "$LAUNCHD_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(esc_xml "$SELF")</string>
    <string>--dir</string><string>$(esc_xml "$DIR")</string>
    <string>--keep</string><string>$(esc_xml "$KEEP")</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>$(esc_xml "$DIR")/backup.log</string>
  <key>StandardErrorPath</key><string>$(esc_xml "$DIR")/backup.log</string>
</dict>
</plist>
PLIST
      launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST"
      echo "scheduled daily at 04:17 — $LAUNCHD_PLIST"
      ;;
    systemd)
      mkdir -p "$SYSTEMD_DIR"
      cat > "$SYSTEMD_DIR/reemoat-backup.service" <<UNIT
[Unit]
Description=Snapshot the Reemoat control plane's database

[Service]
Type=oneshot
ExecStart=$SELF --dir $DIR --keep $KEEP
UNIT
      cat > "$SYSTEMD_DIR/reemoat-backup.timer" <<UNIT
[Unit]
Description=Daily Reemoat control-plane backup

[Timer]
OnCalendar=*-*-* 04:17:00
# So a host that was asleep or off at 04:17 still takes one, rather than
# silently skipping a day and reporting nothing.
Persistent=true

[Install]
WantedBy=timers.target
UNIT
      systemctl --user daemon-reload
      systemctl --user enable --now reemoat-backup.timer
      echo "scheduled daily at 04:17 — $SYSTEMD_DIR/reemoat-backup.timer"
      ;;
  esac
  echo "  snapshots: $DIR (keeping $KEEP)"
  echo "  ⚠ this host is not somewhere to *keep* them. Copy them off it."
}

unschedule() {
  detect_init
  case "$INIT_SYSTEM" in
    launchd)
      launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
      rm -f "$LAUNCHD_PLIST"
      ;;
    systemd)
      systemctl --user disable --now reemoat-backup.timer 2>/dev/null || true
      rm -f "$SYSTEMD_DIR/reemoat-backup.timer" "$SYSTEMD_DIR/reemoat-backup.service"
      systemctl --user daemon-reload 2>/dev/null || true
      ;;
  esac
  echo "unscheduled. Existing snapshots in $DIR are left alone."
}

case "$MODE" in
  schedule)
    schedule
    exit 0
    ;;
  unschedule)
    unschedule
    exit 0
    ;;
esac

# 0700 before anything is written into it, and `mkdir -p` will not narrow a
# directory that already exists — so the chmod is separate and unconditional, the
# same discipline `store.ts` applies to the database's own directory.
mkdir -p "$DIR"
chmod 700 "$DIR" 2>/dev/null || true

# The one-second resolution matters: two snapshots in the same second would
# otherwise overwrite each other, and the case that produces them is a retry loop
# in whatever calls this.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/control-plane-$STAMP.db"

# Inside the container, because the database lives in a named volume that the
# host cannot open — on macOS it is inside the VM entirely. `/tmp` is the
# writable tmpfs the compose file mounts; everything else in that image is
# read-only.
#
# Written to a `.part` name and moved into place at the end, so a snapshot that
# died half-way is never mistaken for one that finished. A backup you cannot tell
# is truncated is worse than no backup, because it is the one you will reach for.
IN_CONTAINER="/tmp/reemoat-backup-$STAMP.db"

echo "snapshotting the control plane's database"
compose exec -T "$(compose_service control-plane)" node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.REEMOAT_CP_DB || '/var/lib/reemoat/control-plane.db', { readOnly: true });
  db.exec(\"VACUUM INTO '$IN_CONTAINER'\");
  db.close();
"

compose cp "$(compose_service control-plane):$IN_CONTAINER" "$OUT.part"
# Best-effort: the tmpfs is cleared on restart anyway, and a snapshot that
# reached the host must not be discarded because the cleanup failed.
compose exec -T "$(compose_service control-plane)" rm -f "$IN_CONTAINER" || true

chmod 600 "$OUT.part"
mv "$OUT.part" "$OUT"

# Proof rather than a claim. `PRAGMA integrity_check` on the snapshot is the only
# thing that distinguishes "a file was produced" from "a database was produced",
# and it costs a second on a file this size.
VERDICT=$(node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  process.stdout.write(String(db.prepare('PRAGMA integrity_check').get().integrity_check));
  db.close();
" "$OUT" 2>/dev/null || echo "unreadable")

if [ "$VERDICT" != "ok" ]; then
  echo "  the snapshot did not verify: $VERDICT" >&2
  echo "  kept at $OUT so it can be looked at; do not treat it as a backup." >&2
  exit 1
fi

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "  $OUT ($SIZE bytes, integrity_check ok)"

# Retention, oldest first, and only over files this script itself names. A glob
# narrow enough that a stray file in the directory is never a candidate for
# deletion — the one `rm` here must not be able to reach anything it did not
# write.
if [ "$KEEP" -gt 0 ]; then
  # shellcheck disable=SC2012 # `ls -t` is the sort; these names carry no newlines.
  ls -t "$DIR"/control-plane-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old"
    echo "  removed $old"
  done
fi

echo ""
echo "That file is the key that signs every token in the fleet."
echo "Put it where you would put a signing key — off this host."
