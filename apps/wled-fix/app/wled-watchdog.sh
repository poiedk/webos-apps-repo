#!/bin/sh
APP="/media/developer/apps/usr/palm/applications/org.webosbrew.wledfix"
CFG="/home/root/.config/wled-fix-watch.conf"
PID="/tmp/wledfix-watchdog.pid"
LOG="/tmp/wledfix-watchdog.log"

if [ "$1" = "stop" ]; then
  P=$(cat "$PID" 2>/dev/null)
  [ -n "$P" ] && kill "$P" 2>/dev/null || true
  rm -f "$PID"
  exit 0
fi

P=$(cat "$PID" 2>/dev/null)
[ -n "$P" ] && kill -0 "$P" 2>/dev/null && exit 0

(
  while true; do
    INTERVAL=60
    AUTO_REPAIR=0
    PICCAP_RECOVERY=1
    [ -r "$CFG" ] && . "$CFG"
    sleep "$INTERVAL"
    OUT=$(sh "$APP/wled-auto.sh" --action check --fast 1 --full 0 --verify 1 --restart 0 --backup 0 --piccap-recovery "$PICCAP_RECOVERY" 2>&1)
    echo "$(date) CHECK"
    echo "$OUT"
    if [ "$AUTO_REPAIR" = "1" ] && ! echo "$OUT" | grep -q '^STATUS=OK$'; then
      echo "$(date) AUTO_REPAIR"
      sh "$APP/wled-auto.sh" --action repair --fast 1 --full 1 --verify 1 --restart 1 --backup 1 --piccap-recovery "$PICCAP_RECOVERY" 2>&1
      sleep 300
    fi
  done
) >>"$LOG" 2>&1 &
echo $! > "$PID"
exit 0
