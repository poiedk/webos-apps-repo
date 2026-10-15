#!/bin/sh

DB="/home/root/.hyperion/db/hyperion.db"
SERVICE="org.webosbrew.hyperion.ng.loader.service"
IFACE="wlan0"
TIMEOUT="1"
INSTANCE="0"
PROTOCOL="auto"
FAST="1"
FULL="1"
VERIFY="1"
RESTART="1"
BACKUP="1"
KEEP_BACKUPS="3"
TEST_LEDS="0"
VERBOSE="0"
SCAN_BATCH="24"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --interface|--iface) IFACE="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --instance) INSTANCE="$2"; shift 2 ;;
    --protocol) PROTOCOL="$2"; shift 2 ;;
    --fast) FAST="$2"; shift 2 ;;
    --full) FULL="$2"; shift 2 ;;
    --verify) VERIFY="$2"; shift 2 ;;
    --restart) RESTART="$2"; shift 2 ;;
    --backup) BACKUP="$2"; shift 2 ;;
    --keep-backups) KEEP_BACKUPS="$2"; shift 2 ;;
    --test-leds) TEST_LEDS="$2"; shift 2 ;;
    --verbose) VERBOSE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

case "$PROTOCOL" in
  auto|AUTO) PROTOCOL="auto" ;;
  ddp|DDP) PROTOCOL="ddp" ;;
  raw|RAW) PROTOCOL="raw" ;;
  *) PROTOCOL="auto" ;;
esac

log(){ [ "$VERBOSE" = "1" ] && echo "LOG=$1"; }
fail(){ echo "STATUS=ERROR"; echo "ERROR=$1"; exit 1; }

[ -r "$DB" ] || fail "Hyperion database not found"
command -v ifconfig >/dev/null 2>&1 || fail "ifconfig not found"
command -v wget >/dev/null 2>&1 || fail "wget not found"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 not found"

get_ip(){
  ifconfig "$1" 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p' | head -n 1
}

MYIP=$(get_ip "$IFACE")
if [ -z "$MYIP" ]; then
  for cand in wlan0 eth0; do
    ip=$(get_ip "$cand")
    if [ -n "$ip" ]; then
      IFACE="$cand"
      MYIP="$ip"
      echo "INTERFACE_FALLBACK=$cand"
      break
    fi
  done
fi

[ -n "$MYIP" ] || fail "No IPv4 address found on wlan0 or eth0"
NET=$(echo "$MYIP" | cut -d. -f1-3)
[ -n "$NET" ] || fail "Could not determine current subnet"

echo "TV_IP=$MYIP"
echo "INTERFACE=$IFACE"
log "Subnet $NET.0/24 via $IFACE"

DEVICE_CONFIG=$(sqlite3 "$DB" "SELECT config FROM settings WHERE type='device' AND hyperion_inst=$INSTANCE AND config LIKE '%\"type\":\"wled\"%' LIMIT 1;" 2>/dev/null)
OLD=$(echo "$DEVICE_CONFIG" | sed -n 's/.*"host":"\([^"]*\)".*/\1/p')

if [ -z "$OLD" ]; then
  AUTO_ROW=$(sqlite3 -separator '|' "$DB" "SELECT hyperion_inst, config FROM settings WHERE type='device' AND config LIKE '%\"type\":\"wled\"%' ORDER BY hyperion_inst LIMIT 1;" 2>/dev/null)
  AUTO_INSTANCE=$(echo "$AUTO_ROW" | cut -d'|' -f1)
  AUTO_CONFIG=$(echo "$AUTO_ROW" | cut -d'|' -f2-)
  AUTO_OLD=$(echo "$AUTO_CONFIG" | sed -n 's/.*"host":"\([^"]*\)".*/\1/p')

  if [ -n "$AUTO_INSTANCE" ] && [ -n "$AUTO_OLD" ]; then
    echo "INSTANCE_FALLBACK=$INSTANCE->$AUTO_INSTANCE"
    INSTANCE="$AUTO_INSTANCE"
    DEVICE_CONFIG="$AUTO_CONFIG"
    OLD="$AUTO_OLD"
  fi
fi

[ -n "$OLD" ] || fail "No Hyperion WLED device configuration found"

OLD_PROTOCOL=$(echo "$DEVICE_CONFIG" | sed -n 's/.*"streamProtocol":"\([^"]*\)".*/\1/p')
[ -n "$OLD_PROTOCOL" ] || OLD_PROTOCOL="DDP"
OLD_PORT=$(echo "$DEVICE_CONFIG" | sed -n 's/.*"port":\([0-9][0-9]*\).*/\1/p')
if [ -z "$OLD_PORT" ]; then
  [ "$OLD_PROTOCOL" = "RAW" ] && OLD_PORT="19446" || OLD_PORT="4048"
fi
LED_COUNT=$(echo "$DEVICE_CONFIG" | sed -n 's/.*"hardwareLedCount":\([0-9][0-9]*\).*/\1/p')

echo "HYPERION_INSTANCE=$INSTANCE"
echo "HYPERION_TARGET=$OLD"
echo "PROTOCOL_OLD=$OLD_PROTOCOL"
echo "PORT_OLD=$OLD_PORT"

case "$OLD" in
  "$NET".*) ;;
  *) echo "STALE_TARGET=1" ;;
esac

is_wled(){
  CANDIDATE="$1"
  [ -n "$CANDIDATE" ] || return 1
  INFO=$(wget -T "$TIMEOUT" -qO- "http://$CANDIDATE/json/info" 2>/dev/null) || return 1
  echo "$INFO" | grep -Eq '"brand"[[:space:]]*:[[:space:]]*"WLED"'
}

WLED_IP=""
DISCOVERY=""

if [ "$FAST" = "1" ]; then
  case "$OLD" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*)
      log "Trying current Hyperion target $OLD"
      if is_wled "$OLD"; then
        WLED_IP="$OLD"
        DISCOVERY="current-target"
      fi
      ;;
  esac

  if [ -z "$WLED_IP" ] && [ -r /proc/net/arp ]; then
    for IP in $(awk -v net="$NET." 'NR>1 && $3=="0x2" && index($1,net)==1 {print $1}' /proc/net/arp 2>/dev/null); do
      [ "$IP" = "$MYIP" ] && continue
      log "Trying ARP candidate $IP"
      if is_wled "$IP"; then
        WLED_IP="$IP"
        DISCOVERY="arp"
        break
      fi
    done
  fi
fi

scan_batch(){
  START="$1"
  END="$2"
  TMP="/tmp/wledfix-scan-$$"
  rm -rf "$TMP"
  mkdir -p "$TMP" || return 1

  i="$START"
  while [ "$i" -le "$END" ]; do
    IP="$NET.$i"
    if [ "$IP" != "$MYIP" ]; then
      (
        if is_wled "$IP"; then
          echo "$IP" > "$TMP/$i.hit"
        fi
      ) &
    fi
    i=$((i+1))
  done
  wait

  HIT=$(cat "$TMP"/*.hit 2>/dev/null | head -n 1)
  rm -rf "$TMP"
  [ -n "$HIT" ] || return 1
  WLED_IP="$HIT"
  return 0
}

if [ -z "$WLED_IP" ] && [ "$FULL" = "1" ]; then
  echo "SCAN_MODE=parallel"
  i=1
  while [ "$i" -le 254 ]; do
    end=$((i+SCAN_BATCH-1))
    [ "$end" -gt 254 ] && end=254
    log "Scanning $NET.$i-$end"
    if scan_batch "$i" "$end"; then
      DISCOVERY="parallel-scan"
      break
    fi
    i=$((end+1))
  done
fi

[ -n "$WLED_IP" ] || fail "WLED not found on $NET.0/24"
echo "WLED_IP=$WLED_IP"
echo "DISCOVERY=$DISCOVERY"

WLED_INFO=$(wget -T "$TIMEOUT" -qO- "http://$WLED_IP/json/info" 2>/dev/null) || fail "WLED stopped responding during verification"
WLED_AP_INFO="0"
echo "$WLED_INFO" | grep -Eq '"ap"[[:space:]]*:[[:space:]]*true' && WLED_AP_INFO="1"

GATEWAY=""
if command -v route >/dev/null 2>&1; then
  GATEWAY=$(route -n 2>/dev/null | awk -v iface="$IFACE" '$1=="0.0.0.0" && $8==iface {print $2; exit}')
fi
if [ -z "$GATEWAY" ] && command -v ip >/dev/null 2>&1; then
  GATEWAY=$(ip route 2>/dev/null | awk -v iface="$IFACE" '$1=="default" && $0 ~ ("dev " iface) {for(i=1;i<=NF;i++) if($i=="via"){print $(i+1); exit}}')
fi

DIRECT_AP="0"
if [ -n "$GATEWAY" ] && [ "$GATEWAY" = "$WLED_IP" ]; then
  DIRECT_AP="1"
fi

echo "WLED_AP_INFO=$WLED_AP_INFO"
echo "DIRECT_WLED_AP=$DIRECT_AP"
[ -n "$GATEWAY" ] && echo "GATEWAY=$GATEWAY"

case "$PROTOCOL" in
  raw)
    NEW_PROTOCOL="RAW"
    NEW_PORT="19446"
    PROTOCOL_REASON="manual-raw"
    ;;
  ddp)
    NEW_PROTOCOL="DDP"
    NEW_PORT="4048"
    PROTOCOL_REASON="manual-ddp"
    ;;
  *)
    if [ "$DIRECT_AP" = "1" ]; then
      NEW_PROTOCOL="RAW"
      NEW_PORT="19446"
      PROTOCOL_REASON="direct-wled-ap"
    else
      NEW_PROTOCOL="DDP"
      NEW_PORT="4048"
      PROTOCOL_REASON="normal-network"
    fi
    ;;
esac

if [ "$NEW_PROTOCOL" = "RAW" ] && [ -n "$LED_COUNT" ] && [ "$LED_COUNT" -gt 490 ] 2>/dev/null; then
  fail "UDP RAW supports at most 490 LEDs; select DDP"
fi

echo "PROTOCOL_NEW=$NEW_PROTOCOL"
echo "PORT=$NEW_PORT"
echo "PROTOCOL_REASON=$PROTOCOL_REASON"

NEEDS_UPDATE="0"
[ "$OLD" = "$WLED_IP" ] || NEEDS_UPDATE="1"
[ "$OLD_PROTOCOL" = "$NEW_PROTOCOL" ] || NEEDS_UPDATE="1"
[ "$OLD_PORT" = "$NEW_PORT" ] || NEEDS_UPDATE="1"

if [ "$NEEDS_UPDATE" = "0" ]; then
  echo "STATUS=OK"
  exit 0
fi

if [ "$BACKUP" = "1" ]; then
  TS=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo now)
  BK="$DB.wledfix-$TS.bak"
  cp "$DB" "$BK" || fail "Could not create Hyperion DB backup"
  echo "BACKUP=$BK"

  i=$(ls -1t "$DB".wledfix-*.bak 2>/dev/null | awk -v keep="$KEEP_BACKUPS" 'NR>keep {print}')
  [ -n "$i" ] && echo "$i" | while IFS= read -r f; do rm -f "$f"; done
fi

NEW_CONFIG=$(echo "$DEVICE_CONFIG" |
  sed 's/"host":"[^"]*"/"host":"'"$WLED_IP"'"/' |
  sed 's/"hostList":"[^"]*"/"hostList":"'"$WLED_IP"'"/')

if echo "$NEW_CONFIG" | grep -q '"streamProtocol":"[^"]*"'; then
  NEW_CONFIG=$(echo "$NEW_CONFIG" | sed 's/"streamProtocol":"[^"]*"/"streamProtocol":"'"$NEW_PROTOCOL"'"/')
else
  NEW_CONFIG=$(echo "$NEW_CONFIG" | sed 's/"type":"wled"/"streamProtocol":"'"$NEW_PROTOCOL"'","type":"wled"/')
fi

if echo "$NEW_CONFIG" | grep -q '"port":[0-9][0-9]*'; then
  NEW_CONFIG=$(echo "$NEW_CONFIG" | sed 's/"port":[0-9][0-9]*/"port":'"$NEW_PORT"'/')
else
  NEW_CONFIG=$(echo "$NEW_CONFIG" | sed 's/"streamProtocol":"'"$NEW_PROTOCOL"'"/"streamProtocol":"'"$NEW_PROTOCOL"'","port":'"$NEW_PORT"'/')
fi

SQL_CONFIG=$(printf "%s" "$NEW_CONFIG" | sed "s/'/''/g")
sqlite3 "$DB" "
UPDATE settings
SET config='$SQL_CONFIG',
    updated_at=datetime('now')
WHERE type='device'
  AND hyperion_inst=$INSTANCE
  AND config LIKE '%\"type\":\"wled\"%';
" || fail "Could not update Hyperion database"

VERIFY_CONFIG=$(sqlite3 "$DB" "SELECT config FROM settings WHERE type='device' AND hyperion_inst=$INSTANCE AND config LIKE '%\"type\":\"wled\"%' LIMIT 1;" 2>/dev/null)
VERIFY_HOST=$(echo "$VERIFY_CONFIG" | sed -n 's/.*"host":"\([^"]*\)".*/\1/p')
VERIFY_PROTOCOL=$(echo "$VERIFY_CONFIG" | sed -n 's/.*"streamProtocol":"\([^"]*\)".*/\1/p')
VERIFY_PORT=$(echo "$VERIFY_CONFIG" | sed -n 's/.*"port":\([0-9][0-9]*\).*/\1/p')

[ "$VERIFY_HOST" = "$WLED_IP" ] || fail "Hyperion target verification failed"
[ "$VERIFY_PROTOCOL" = "$NEW_PROTOCOL" ] || fail "Hyperion protocol verification failed"
[ "$VERIFY_PORT" = "$NEW_PORT" ] || fail "Hyperion port verification failed"

echo "OLD_TARGET=$OLD"
echo "NEW_TARGET=$VERIFY_HOST"

if [ "$RESTART" = "1" ]; then
  luna-send -n 1 "luna://$SERVICE/stop" '{}' >/dev/null 2>&1
  sleep 2
  luna-send -n 1 "luna://$SERVICE/start" '{}' >/dev/null 2>&1
  sleep 3
fi

VERIFIED="0"
if [ "$VERIFY" = "1" ]; then
  SINFO=$(wget -T 2 -qO- http://127.0.0.1:8090/json-rpc     --post-data='{"command":"serverinfo","tan":71}'     --header='Content-Type: application/json' 2>/dev/null)
  echo "$SINFO" | tr '\n' ' ' | grep -Eq '"enabled"[[:space:]]*:[[:space:]]*true[^}]*"name"[[:space:]]*:[[:space:]]*"LEDDEVICE"|"name"[[:space:]]*:[[:space:]]*"LEDDEVICE"[^}]*"enabled"[[:space:]]*:[[:space:]]*true' && VERIFIED="1"
  [ "$VERIFIED" = "1" ] || fail "Hyperion updated, but LEDDEVICE did not verify as enabled"
fi
echo "VERIFIED=$VERIFIED"

if [ "$TEST_LEDS" = "1" ]; then
  wget -T 2 -qO- http://127.0.0.1:8090/json-rpc     --post-data='{"command":"color","color":[40,80,255],"priority":50,"duration":500,"tan":72}'     --header='Content-Type: application/json' >/dev/null 2>&1
fi

echo "STATUS=UPDATED"
exit 0
