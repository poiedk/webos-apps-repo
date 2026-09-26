#!/bin/sh
(
  sleep 12
  LUNA="$(command -v luna-send 2>/dev/null)"
  [ -n "$LUNA" ] || LUNA="$(command -v luna-send-pub 2>/dev/null)"
  [ -n "$LUNA" ] || exit 0
  i=0
  while [ "$i" -lt 3 ]; do
    OUT="$("$LUNA" -n 1 luna://org.webosbrew.wifiwatch.service/boot '{"source":"boot"}' 2>&1)"
    printf '%s\n' "$OUT" | grep -q '"returnValue":true' && exit 0
    i=$((i+1))
    sleep 10
  done
) >/tmp/wifi-watch-autostart.log 2>&1 &
exit 0
