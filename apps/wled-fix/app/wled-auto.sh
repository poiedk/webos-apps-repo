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
ACTION="repair"
TARGET_MODE="auto"
MANUAL_IP=""
PICCAP_RECOVERY="1"
STATE="/home/root/.config/wled-fix-controller.state"
PICCAP_SERVICE="org.webosbrew.piccap.service"
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
    --action) ACTION="$2"; shift 2 ;;
    --target-mode) TARGET_MODE="$2"; shift 2 ;;
    --manual-ip) MANUAL_IP="$2"; shift 2 ;;
    --piccap-recovery) PICCAP_RECOVERY="$2"; shift 2 ;;
    *) shift ;;
  esac
done

stage "Selecting streaming protocol"
case "$PROTOCOL" in
  auto|AUTO) PROTOCOL="auto" ;;
  ddp|DDP) PROTOCOL="ddp" ;;
  raw|RAW) PROTOCOL="raw" ;;
  *) PROTOCOL="auto" ;;
esac
case "$ACTION" in check|repair|test) ;; *) ACTION="repair" ;; esac
case "$TARGET_MODE" in auto|last|manual|wled-ap) ;; *) TARGET_MODE="auto" ;; esac

stage(){ echo "STAGE=$1"; }
log(){ [ "$VERBOSE" = "1" ] && echo "LOG=$1"; }
fail(){ echo "STATUS=ERROR"; echo "ERROR=$1"; exit 1; }
fail_kind(){ echo "STATUS=ERROR"; echo "ERROR_KIND=$1"; echo "ERROR=$2"; exit 1; }

piccap_running(){
  ps w 2>/dev/null | grep '/org.webosbrew.piccap.service/hyperion-webos' | grep -v grep >/dev/null 2>&1
}
capture_input_active(){
  PINFO=$(wget -T 2 -qO- http://127.0.0.1:8090/json-rpc --post-data='{"command":"serverinfo","tan":171}' --header='Content-Type: application/json' 2>/dev/null)
  echo "$PINFO" | tr '\n' ' ' | grep -Eq '"active"[[:space:]]*:[[:space:]]*true[^}]*"priority"[[:space:]]*:[[:space:]]*150|"priority"[[:space:]]*:[[:space:]]*150[^}]*"active"[[:space:]]*:[[:space:]]*true'
}
restart_piccap(){
  [ "$PICCAP_RECOVERY" = "1" ] || return 0
  stage "Restarting PicCap"
  luna-send -w 3000 -n 1 "luna://$PICCAP_SERVICE/stop" '{}' >/dev/null 2>&1 || true
  sleep 1
  luna-send -w 3000 -n 1 "luna://$PICCAP_SERVICE/start" '{}' >/dev/null 2>&1 || true
  sleep 3
  echo "PICCAP_RECOVERY=restarted"
}

stage "Checking prerequisites"
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

stage "Reading network"
echo "TV_IP=$MYIP"
echo "INTERFACE=$IFACE"
log "Subnet $NET.0/24 via $IFACE"

stage "Reading Hyperion configuration"
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
LAST_IP=""
if [ -r "$STATE" ]; then LAST_IP=$(sed -n 's/^IP=//p' "$STATE" | head -n 1); fi

stage "Discovering WLED"
if [ "$TARGET_MODE" = "wled-ap" ]; then
  is_wled "4.3.2.1" && { WLED_IP="4.3.2.1"; DISCOVERY="wled-ap"; }
elif [ "$TARGET_MODE" = "manual" ]; then
  [ -n "$MANUAL_IP" ] && is_wled "$MANUAL_IP" && { WLED_IP="$MANUAL_IP"; DISCOVERY="manual"; }
elif [ "$TARGET_MODE" = "last" ]; then
  [ -n "$LAST_IP" ] && is_wled "$LAST_IP" && { WLED_IP="$LAST_IP"; DISCOVERY="last-known"; }
fi

if [ -z "$WLED_IP" ] && [ "$FAST" = "1" ]; then
  case "$OLD" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*)
      log "Trying current Hyperion target $OLD"
      if is_wled "$OLD"; then
        WLED_IP="$OLD"
        DISCOVERY="current-target"
      fi
      ;;
  esac

  if [ -z "$WLED_IP" ] && [ -n "$LAST_IP" ] && [ "$LAST_IP" != "$OLD" ]; then
    log "Trying last known WLED $LAST_IP"
    is_wled "$LAST_IP" && { WLED_IP="$LAST_IP"; DISCOVERY="last-known"; }
  fi

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

if [ -z "$WLED_IP" ]; then
  KIND="WLED_OFFLINE"
  case "$OLD" in
    "$NET".*)
      ping -c 1 -W 1 "$OLD" >/dev/null 2>&1 || true
      ARP_LINE=$(grep "^$OLD " /proc/net/arp 2>/dev/null)
      [ -z "$ARP_LINE" ] && KIND="NETWORK_ISOLATION_OR_OFFLINE"
      echo "$ARP_LINE" | grep -q '00:00:00:00:00:00' && KIND="NETWORK_ISOLATION_OR_OFFLINE"
      ;;
  esac
  fail_kind "$KIND" "WLED not found or reachable on $NET.0/24"
fi
echo "WLED_IP=$WLED_IP"
echo "DISCOVERY=$DISCOVERY"
WLED_INFO=$(wget -T "$TIMEOUT" -qO- "http://$WLED_IP/json/info" 2>/dev/null)
WLED_MAC=$(echo "$WLED_INFO" | sed -n 's/.*"mac"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
WLED_NAME=$(echo "$WLED_INFO" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
WLED_LED_COUNT=$(echo "$WLED_INFO" | sed -n 's/.*"leds"[[:space:]]*:[[:space:]]*{[^}]*"count"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
[ -n "$WLED_MAC" ] && echo "WLED_MAC=$WLED_MAC"
[ -n "$WLED_NAME" ] && echo "WLED_NAME=$WLED_NAME"
[ -n "$WLED_LED_COUNT" ] && echo "WLED_LED_COUNT=$WLED_LED_COUNT"
if [ -n "$LED_COUNT" ] && [ -n "$WLED_LED_COUNT" ] && [ "$LED_COUNT" != "$WLED_LED_COUNT" ]; then
  echo "LED_COUNT_NOTE=Hyperion logical LEDs ($LED_COUNT) differ from WLED physical LEDs ($WLED_LED_COUNT)"
fi
mkdir -p /home/root/.config 2>/dev/null || true
{ echo "IP=$WLED_IP"; echo "MAC=$WLED_MAC"; echo "NAME=$WLED_NAME"; } > "$STATE" 2>/dev/null || true

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

CONFIG_CHANGED="0"
[ "$NEEDS_UPDATE" = "1" ] && CONFIG_CHANGED="1"
if [ "$ACTION" != "repair" ] && [ "$NEEDS_UPDATE" = "1" ]; then
  fail_kind "NEEDS_REPAIR" "Hyperion target/protocol differs from the detected WLED; run Repair"
fi

if [ "$NEEDS_UPDATE" = "1" ]; then
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
  
  
else
  VERIFY_HOST="$WLED_IP"
  VERIFY_PROTOCOL="$NEW_PROTOCOL"
  VERIFY_PORT="$NEW_PORT"
fi

echo "OLD_TARGET=$OLD"
echo "NEW_TARGET=$VERIFY_HOST"
echo "CONFIG_CHANGED=$CONFIG_CHANGED"

if [ "$RESTART" = "1" ] && [ "$CONFIG_CHANGED" = "1" ]; then
  echo "RESTARTING_HYPERION=1"
  PICCAP_WAS_RUNNING="0"
  piccap_running && PICCAP_WAS_RUNNING="1"
  stage "Restarting Hyperion"
  luna-send -n 1 "luna://$SERVICE/stop" '{}' >/dev/null 2>&1
  sleep 2
  luna-send -n 1 "luna://$SERVICE/start" '{}' >/dev/null 2>&1
  sleep 3
  [ "$PICCAP_WAS_RUNNING" = "1" ] && restart_piccap
else
  echo "RESTARTING_HYPERION=0"
fi

VERIFIED="0"
LIVE_VERIFIED="0"
LIVE_SOURCE=""

if [ "$VERIFY" = "1" ]; then
  SINFO=$(wget -T 2 -qO- http://127.0.0.1:8090/json-rpc \
    --post-data='{"command":"serverinfo","tan":71}' \
    --header='Content-Type: application/json' 2>/dev/null)
  echo "$SINFO" | tr '\n' ' ' | grep -Eq '"enabled"[[:space:]]*:[[:space:]]*true[^}]*"name"[[:space:]]*:[[:space:]]*"LEDDEVICE"|"name"[[:space:]]*:[[:space:]]*"LEDDEVICE"[^}]*"enabled"[[:space:]]*:[[:space:]]*true' && VERIFIED="1"

  if [ "$VERIFIED" != "1" ]; then
    [ "$ACTION" = "repair" ] || fail_kind "LEDDEVICE_DISABLED" "Hyperion LEDDEVICE is not enabled; run Repair"
    echo "LEDDEVICE_RECOVERY=attempt"
    stage "Enabling Hyperion LEDDEVICE"
    ENABLE_REPLY=$(wget -T 3 -qO- http://127.0.0.1:8090/json-rpc \
      --post-data='{"command":"componentstate","componentstate":{"component":"LEDDEVICE","state":true},"tan":90}' \
      --header='Content-Type: application/json' 2>/dev/null)
    echo "$ENABLE_REPLY" | grep -Eq '"success"[[:space:]]*:[[:space:]]*true' || fail "Hyperion refused to enable LEDDEVICE"
    sleep 1

    SINFO=$(wget -T 2 -qO- http://127.0.0.1:8090/json-rpc \
      --post-data='{"command":"serverinfo","tan":91}' \
      --header='Content-Type: application/json' 2>/dev/null)
    echo "$SINFO" | tr '\n' ' ' | grep -Eq '"enabled"[[:space:]]*:[[:space:]]*true[^}]*"name"[[:space:]]*:[[:space:]]*"LEDDEVICE"|"name"[[:space:]]*:[[:space:]]*"LEDDEVICE"[^}]*"enabled"[[:space:]]*:[[:space:]]*true' && VERIFIED="1"
    [ "$VERIFIED" = "1" ] || fail "Hyperion LEDDEVICE could not be enabled"
    echo "LEDDEVICE_RECOVERY=enabled"
  else
    echo "LEDDEVICE_RECOVERY=not-needed"
  fi

  stage "Testing realtime output"
  # End-to-end probe: ask Hyperion for a short color frame, then confirm
  # that WLED reports itself in realtime mode. This detects the exact case
  # where the DB looks correct but UDP packets never reach WLED.
  wget -T 2 -qO- http://127.0.0.1:8090/json-rpc \
    --post-data='{"command":"color","color":[24,64,160],"priority":50,"duration":1800,"tan":72}' \
    --header='Content-Type: application/json' >/dev/null 2>&1
  sleep 1
  LIVE_INFO=$(wget -T 2 -qO- "http://$WLED_IP/json/info" 2>/dev/null)
  echo "$LIVE_INFO" | grep -Eq '"live"[[:space:]]*:[[:space:]]*true' && LIVE_VERIFIED="1"
  LIVE_SOURCE=$(echo "$LIVE_INFO" | sed -n 's/.*"lip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  echo "LIVE_VERIFIED=$LIVE_VERIFIED"
  [ -n "$LIVE_SOURCE" ] && echo "LIVE_SOURCE=$LIVE_SOURCE"

  if [ "$LIVE_VERIFIED" != "1" ] && [ "$ACTION" = "repair" ] && [ "$PROTOCOL" = "auto" ]; then
    stage "Trying protocol fallback"
    if [ "$NEW_PROTOCOL" = "DDP" ]; then ALT_PROTOCOL="RAW"; ALT_PORT="19446"; else ALT_PROTOCOL="DDP"; ALT_PORT="4048"; fi
    CUR=$(sqlite3 "$DB" "SELECT config FROM settings WHERE type='device' AND hyperion_inst=$INSTANCE AND config LIKE '%\"type\":\"wled\"%' LIMIT 1;" 2>/dev/null)
    ALT=$(echo "$CUR" | sed 's/"streamProtocol":"[^"]*"/"streamProtocol":"'"$ALT_PROTOCOL"'"/')
    if echo "$ALT" | grep -q '"port":[0-9][0-9]*'; then ALT=$(echo "$ALT" | sed 's/"port":[0-9][0-9]*/"port":'"$ALT_PORT"'/'); else ALT=$(echo "$ALT" | sed 's/"streamProtocol":"'"$ALT_PROTOCOL"'"/"streamProtocol":"'"$ALT_PROTOCOL"'","port":'"$ALT_PORT"'/'); fi
    SQL_ALT=$(printf "%s" "$ALT" | sed "s/'/''/g")
    sqlite3 "$DB" "UPDATE settings SET config='$SQL_ALT',updated_at=datetime('now') WHERE type='device' AND hyperion_inst=$INSTANCE AND config LIKE '%\"type\":\"wled\"%';" >/dev/null 2>&1
    PICCAP_WAS_RUNNING="0"; piccap_running && PICCAP_WAS_RUNNING="1"
    luna-send -w 3000 -n 1 "luna://$SERVICE/stop" '{}' >/dev/null 2>&1 || true
    sleep 1
    luna-send -w 3000 -n 1 "luna://$SERVICE/start" '{}' >/dev/null 2>&1 || true
    sleep 3
    [ "$PICCAP_WAS_RUNNING" = "1" ] && restart_piccap
    wget -T 3 -qO- http://127.0.0.1:8090/json-rpc --post-data='{"command":"componentstate","componentstate":{"component":"LEDDEVICE","state":true},"tan":92}' --header='Content-Type: application/json' >/dev/null 2>&1 || true
    wget -T 2 -qO- http://127.0.0.1:8090/json-rpc --post-data='{"command":"color","color":[24,64,160],"priority":50,"duration":1800,"tan":93}' --header='Content-Type: application/json' >/dev/null 2>&1
    sleep 1
    LIVE_INFO=$(wget -T 2 -qO- "http://$WLED_IP/json/info" 2>/dev/null)
    echo "$LIVE_INFO" | grep -Eq '"live"[[:space:]]*:[[:space:]]*true' && LIVE_VERIFIED="1"
    if [ "$LIVE_VERIFIED" = "1" ]; then NEW_PROTOCOL="$ALT_PROTOCOL"; NEW_PORT="$ALT_PORT"; echo "PROTOCOL_FALLBACK=$ALT_PROTOCOL"; echo "PORT=$ALT_PORT"; fi
  fi

  if [ "$LIVE_VERIFIED" != "1" ]; then
    fail_kind "REALTIME_FAILED" "Hyperion is configured, but WLED did not enter realtime mode"
  fi

  if [ "$PICCAP_RECOVERY" = "1" ] && piccap_running; then
    stage "Checking PicCap capture"
    if ! capture_input_active; then
      if [ "$ACTION" = "repair" ]; then
        restart_piccap
        capture_input_active && echo "PICCAP_STATE=recovered" || echo "PICCAP_STATE=running-no-input"
      else
        fail_kind "PICCAP_CAPTURE_MISSING" "PicCap is running but Hyperion has no active capture input; run Repair"
      fi
    else
      echo "PICCAP_STATE=running"
    fi
  else
    piccap_running && echo "PICCAP_STATE=running" || echo "PICCAP_STATE=stopped"
  fi
fi

echo "VERIFIED=$VERIFIED"

if [ "$TEST_LEDS" = "1" ]; then
  wget -T 2 -qO- http://127.0.0.1:8090/json-rpc \
    --post-data='{"command":"color","color":[40,80,255],"priority":50,"duration":1500,"tan":73}' \
    --header='Content-Type: application/json' >/dev/null 2>&1
fi

if [ "$CONFIG_CHANGED" = "1" ]; then
  echo "STATUS=UPDATED"
else
  echo "STATUS=OK"
fi
exit 0
