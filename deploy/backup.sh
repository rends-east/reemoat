#!/bin/sh
# deploy/backup.sh [--dir <path>] [--keep <n>]
# deploy/backup.sh --schedule [--dir <path>] [--keep <n>] | --unschedule   # daily, via this host's init
set -eu

# shellcheck source=deploy/lib.sh
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/lib.sh"

# Outside the checkout: a backup written into it would make deploy.sh refuse a dirty tree.
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

mkdir -p "$DIR"
chmod 700 "$DIR" 2>/dev/null || true

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/control-plane-$STAMP.db"

# VACUUM INTO, never cp: the database is in WAL mode. Run in the container, the only place that can open the volume.
IN_CONTAINER="/tmp/reemoat-backup-$STAMP.db"

echo "snapshotting the control plane's database"
compose exec -T "$(compose_service control-plane)" node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.REEMOAT_CP_DB || '/var/lib/reemoat/control-plane.db', { readOnly: true });
  db.exec(\"VACUUM INTO '$IN_CONTAINER'\");
  db.close();
"

compose cp "$(compose_service control-plane):$IN_CONTAINER" "$OUT.part"
# Best-effort: a snapshot that reached the host must not be discarded because cleanup failed.
compose exec -T "$(compose_service control-plane)" rm -f "$IN_CONTAINER" || true

chmod 600 "$OUT.part"
mv "$OUT.part" "$OUT"

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

# The glob names only files this script writes, so the rm cannot reach anything else.
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
