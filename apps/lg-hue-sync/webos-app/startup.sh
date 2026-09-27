#!/bin/sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
STATE_DIR="/var/home/root/lg-hue-sync"
BIN="$APP_DIR/bin/lg-hue-sync"
CONFIG="$STATE_DIR/config.json"
PIDFILE="$STATE_DIR/lg-hue-sync.pid"
LOGFILE="$STATE_DIR/daemon.log"

mkdir -p "$STATE_DIR"

if [ ! -f "$CONFIG" ] && [ -f "$APP_DIR/config.example.json" ]; then
  cp "$APP_DIR/config.example.json" "$CONFIG"
  chmod 600 "$CONFIG" 2>/dev/null || true
fi

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    exit 0
  fi
  rm -f "$PIDFILE"
fi

if [ ! -x "$BIN" ]; then
  echo "LG Hue Sync binary missing or not executable: $BIN" >> "$LOGFILE"
  exit 1
fi

nohup "$BIN" run --config "$CONFIG" >> "$LOGFILE" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

sleep 1
if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PIDFILE"
  exit 1
fi

exit 0
