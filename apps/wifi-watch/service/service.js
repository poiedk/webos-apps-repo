var Service=require('webos-service');
if(process.argv.indexOf('--disable-timeouts')===-1)process.argv.push('--disable-timeouts');
var service=new Service('org.webosbrew.wifiwatch.service');
var cp=require('child_process'),fs=require('fs');

var CONFIG='/home/root/.config/wifi-watch.json';
var HISTORY='/home/root/.config/wifi-watch-history.log';
var LAST_FAILURE='/home/root/.config/wifi-watch-last-failure.txt';
var LOCAL_LOG='/tmp/wifi-watch.log';
var ROOT_EXEC='luna://org.webosbrew.hbchannel.service/exec';
var HOOK='/var/lib/webosbrew/init.d/60-wifi-watch';
var AUTOSTART='/media/developer/apps/usr/palm/services/org.webosbrew.wifiwatch.service/autostart.sh';
var DEFAULTS={
  backgroundWatchdog:true,
  autoFix:false,
  aggressiveFix:false,
  intervalSec:5,
  failureThreshold:3,
  recoveryCooldownSec:60,
  maxRecoveries:3,
  iface:'wlan0',
  pingTimeout:2,
  logSizeMB:1
};

var cfg=copy(DEFAULTS);
var configLoaded=false,configLoading=false,configWaiters=[];
var timer=null,collecting=false,recoveryInProgress=false;
var serviceStartedAt=Date.now(),autoFixGraceMs=45000;
var failures=0,lastFailure=null,sessionRxLastRaw=null,sessionRxDropped=0;
var recoveryTimes=[],sessionRecoveryCount=0,sessionLastRecovery=null,sessionLastRecoveryResult=null;
var lifetimeRecoveryCount=0,lifetimeLastRecovery=null;
var last={
  returnValue:true,state:'Starting',cause:'Starting watchdog',ssid:'--',ip:null,gateway:null,
  latencyMs:null,signalDbm:null,rxPackets:null,rxDropped:null,rxDropDelta:null,
  failureCount:0,lastFailure:null,association:'unknown',connman:'unknown',
  monitoring:false,backgroundWatchdog:true,autoFix:false,iface:'wlan0',
  lastCheck:null,probeError:null,recoveryInProgress:false,recoveryCount:0,
  lastRecovery:null,lastRecoveryResult:null
};

function copy(o){var n={},k;for(k in o)n[k]=o[k];return n;}

function shellQuote(s){
  return "'"+String(s).replace(/'/g,"'\\''")+"'";
}

function localLog(s){
  try{
    fs.appendFileSync(LOCAL_LOG,s+'\n');
    if(fs.existsSync(LOCAL_LOG)&&fs.statSync(LOCAL_LOG).size>cfg.logSizeMB*1048576){
      fs.writeFileSync(LOCAL_LOG,'===== ROTATED '+new Date().toISOString()+' =====\n');
    }
  }catch(e){}
}

function saneNumber(v,allowed,fallback){
  var n=Number(v),i;
  for(i=0;i<allowed.length;i++)if(n===allowed[i])return n;
  return fallback;
}

function sanitize(input){
  var x=input||{},out={};
  out.backgroundWatchdog=typeof x.backgroundWatchdog==='boolean'?x.backgroundWatchdog:DEFAULTS.backgroundWatchdog;
  out.autoFix=typeof x.autoFix==='boolean'?x.autoFix:DEFAULTS.autoFix;
  out.aggressiveFix=typeof x.aggressiveFix==='boolean'?x.aggressiveFix:DEFAULTS.aggressiveFix;
  out.intervalSec=saneNumber(x.intervalSec,[5,10,15,30],DEFAULTS.intervalSec);
  out.failureThreshold=saneNumber(x.failureThreshold,[1,2,3,5],DEFAULTS.failureThreshold);
  out.recoveryCooldownSec=saneNumber(x.recoveryCooldownSec,[30,60,120,300],DEFAULTS.recoveryCooldownSec);
  out.maxRecoveries=saneNumber(x.maxRecoveries,[1,2,3,5],DEFAULTS.maxRecoveries);
  out.iface=(x.iface==='eth0'||x.iface==='wlan0')?x.iface:DEFAULTS.iface;
  out.pingTimeout=saneNumber(x.pingTimeout,[1,2,3],DEFAULTS.pingTimeout);
  out.logSizeMB=saneNumber(x.logSizeMB,[1,2,5],DEFAULTS.logSizeMB);
  return out;
}

function parseKv(text){
  var out={},lines=String(text||'').split(/\r?\n/),i,p,k,v;
  for(i=0;i<lines.length;i++){
    p=lines[i].indexOf('=');
    if(p>0){
      k=lines[i].slice(0,p);
      v=lines[i].slice(p+1);
      out[k]=v;
    }
  }
  return out;
}

function rootExec(command,cb){
  service.call(ROOT_EXEC,{command:command},function(m){
    var p=m&&m.payload?m.payload:{};
    if(p.returnValue===false||p.errorCode||p.errorText){
      cb(p.errorText||p.errorCode||'Root exec failed','',p);
      return;
    }
    cb(null,p.stdoutString||'',p);
  });
}

function flushConfigWaiters(){
  var list=configWaiters.slice(0),i;
  configWaiters=[];
  for(i=0;i<list.length;i++)try{list[i]();}catch(e){}
}

function ensureConfigLoaded(cb){
  if(configLoaded){cb();return;}
  configWaiters.push(cb);
  if(configLoading)return;
  configLoading=true;
  var cmd='CFG="$(cat '+CONFIG+' 2>/dev/null | tr -d "\\r\\n")"; '+
    'echo "CONFIG=$CFG"; '+
    'echo "RECOVERY_COUNT=$(grep "|RECOVERY_OK|" '+HISTORY+' 2>/dev/null | wc -l)"; '+
    'echo "LAST_RECOVERY=$(grep "|RECOVERY_" '+HISTORY+' 2>/dev/null | tail -n 1)"';
  rootExec(cmd,function(err,out){
    var d=parseKv(out),saved;
    if(!err&&d.CONFIG){
      try{saved=JSON.parse(d.CONFIG);cfg=sanitize(saved);}catch(e){cfg=copy(DEFAULTS);}
    }else{
      cfg=copy(DEFAULTS);
    }
    lifetimeRecoveryCount=Number(d.RECOVERY_COUNT||0)||0;
    lifetimeLastRecovery=d.LAST_RECOVERY||null;
    configLoaded=true;configLoading=false;
    updateBootHook(function(){});
    flushConfigWaiters();
  });
}

function persistConfig(cb){
  var json=JSON.stringify(cfg);
  rootExec('mkdir -p /home/root/.config; printf %s '+shellQuote(json)+' > '+CONFIG,function(err){
    if(cb)cb(err);
  });
}

function updateBootHook(cb){
  var cmd;
  if(cfg.backgroundWatchdog){
    cmd='mkdir -p /var/lib/webosbrew/init.d; chmod +x '+AUTOSTART+
      '; ln -sf '+AUTOSTART+' '+HOOK;
  }else{
    cmd='rm -f '+HOOK;
  }
  rootExec(cmd,function(err){if(cb)cb(err);});
}

function addHistory(type,detail){
  var line=new Date().toISOString()+'|'+type+'|'+String(detail||'').replace(/[\r\n|]+/g,' ');
  var cmd='mkdir -p /home/root/.config; printf "%s\\n" '+shellQuote(line)+' >> '+HISTORY+
    '; tail -n 200 '+HISTORY+' > '+HISTORY+'.tmp 2>/dev/null || true; '+
    'if [ -s '+HISTORY+'.tmp ]; then mv '+HISTORY+'.tmp '+HISTORY+'; else rm -f '+HISTORY+'.tmp; fi';
  rootExec(cmd,function(){});
}

function buildProbeCommand(){
  var q=[];
  q.push('IF='+cfg.iface);
  q.push('TIMEOUT='+cfg.pingTimeout);
  q.push('IFC="$(ifconfig "$IF" 2>/dev/null)"');
  q.push('IP="$(printf "%s\\n" "$IFC" | sed -n "s/.*inet addr:\\([0-9.]*\\).*/\\1/p" | head -n 1)"');
  q.push('GW="$(route -n 2>/dev/null | awk \'$1=="0.0.0.0" {print $2; exit}\')"');
  q.push('RXP="$(cat /sys/class/net/"$IF"/statistics/rx_packets 2>/dev/null)"');
  q.push('RXD="$(cat /sys/class/net/"$IF"/statistics/rx_dropped 2>/dev/null)"');
  q.push('OPER="$(cat /sys/class/net/"$IF"/operstate 2>/dev/null)"');
  q.push('WLINE="$(awk -v i="$IF:" \'$1==i {print $3 "|" $4; exit}\' /proc/net/wireless 2>/dev/null)"');
  q.push('QUAL="${WLINE%%|*}"; LEVEL="${WLINE#*|}"');
  q.push('QUAL="$(printf "%s" "$QUAL" | sed "s/\\.$//")"; LEVEL="$(printf "%s" "$LEVEL" | sed "s/\\.$//")"');
  q.push('if [ "$LEVEL" = "0" ] || [ "$LEVEL" = "0.0" ]; then LEVEL=""; fi');
  q.push('QPCT="$(awk -v q="$QUAL" \'BEGIN{if(q=="" || q<=0){exit}; p=(q<=70?q*100/70:q); if(p>100)p=100; if(p<1){exit}; printf "%.0f",p}\')"');
  q.push('ACTIVE="$(connmanctl services 2>/dev/null | grep "^\\*A" | head -n 1)"');
  q.push('SSID="$(printf "%s\\n" "$ACTIVE" | sed "s/^\\*A[OFR]*[[:space:]]*//" | sed "s/[[:space:]]wifi_.*$//" | sed "s/[[:space:]]*$//")"');
  q.push('if [ -n "$GW" ]; then PING="$(ping -c 1 -W "$TIMEOUT" "$GW" 2>/dev/null)"; else PING=""; fi');
  q.push('LAT="$(printf "%s\\n" "$PING" | sed -n "s/.*time[=<]\\([0-9.]*\\)[[:space:]]*ms.*/\\1/p" | head -n 1)"');
  q.push('if printf "%s\\n" "$PING" | grep -Eq "1 packets received|1 received|1 packets transmitted, 1 received"; then OK=1; else OK=0; fi');
  q.push('echo "IP=$IP"');
  q.push('echo "GW=$GW"');
  q.push('echo "SSID=$SSID"');
  q.push('echo "RX_PACKETS=$RXP"');
  q.push('echo "RX_DROPPED=$RXD"');
  q.push('echo "OPER=$OPER"');
  q.push('echo "SIGNAL_DBM=$LEVEL"');
  q.push('echo "SIGNAL_QUALITY=$QPCT"');
  q.push('if readlink /var/lib/webosbrew/init.d/60-wifi-watch >/dev/null 2>&1 && [ -x /media/developer/apps/usr/palm/services/org.webosbrew.wifiwatch.service/autostart.sh ]; then echo "HOOK_ACTIVE=1"; else echo "HOOK_ACTIVE=0"; fi');
  q.push('if [ -n "$ACTIVE" ]; then echo "CONNMAN=connected"; else echo "CONNMAN=unknown"; fi');
  q.push('echo "LATENCY=$LAT"');
  q.push('echo "PING_OK=$OK"');
  return q.join('; ');
}

function causeFor(data,ok){
  if(data.OPER!=='up'&&data.OPER!=='dormant'&&!data.IP)return 'Wi-Fi interface is '+(data.OPER||'down');
  if(!data.IP)return 'No IP address';
  if(!data.GW)return 'No default gateway';
  if(!ok)return 'Gateway unreachable';
  return 'Connection healthy';
}

function captureFailure(cause){
  var cmd='mkdir -p /home/root/.config; ('+
    'date; echo "CAUSE='+String(cause||'unknown').replace(/"/g,'')+'"; '+
    'echo "=== IFCONFIG ==="; ifconfig '+cfg.iface+'; '+
    'echo "=== ROUTES ==="; route -n; '+
    'echo "=== WIRELESS ==="; cat /proc/net/wireless; '+
    'echo "=== ARP ==="; cat /proc/net/arp; '+
    'echo "=== CONNMAN ==="; connmanctl services; '+
    'echo "=== DMESG ==="; dmesg | tail -n 120'+
    ') > '+LAST_FAILURE+' 2>&1; cat '+LAST_FAILURE;
  rootExec(cmd,function(err,out){
    localLog('\n######## WIFI FAILURE '+lastFailure+' ########\n'+(out||('snapshot error: '+err)));
  });
}

function resetSessionStats(reason){
  serviceStartedAt=Date.now();
  failures=0;
  lastFailure=null;
  sessionRxLastRaw=null;
  sessionRxDropped=0;
  recoveryTimes=[];
  sessionRecoveryCount=0;
  sessionLastRecovery=null;
  sessionLastRecoveryResult=null;
  if(reason)addHistory('SESSION_START',reason);
}

function pruneRecoveries(){
  var now=Date.now(),cut=now-600000,next=[],i;
  for(i=0;i<recoveryTimes.length;i++)if(recoveryTimes[i]>=cut)next.push(recoveryTimes[i]);
  recoveryTimes=next;
}

function canRecover(source){
  pruneRecoveries();
  if(cfg.iface!=='wlan0')return {ok:false,reason:'Automatic recovery is only available for wlan0'};
  if(recoveryInProgress)return {ok:false,reason:'Recovery already running'};
  if(source==='auto'&&recoveryTimes.length>=cfg.maxRecoveries)return {ok:false,reason:'Automatic recovery limit reached'};
  if(source==='auto'&&sessionLastRecovery){
    var age=(Date.now()-new Date(sessionLastRecovery).getTime())/1000;
    if(age<cfg.recoveryCooldownSec)return {ok:false,reason:'Recovery cooldown active'};
  }
  return {ok:true};
}

function recoveryCommand(level){
  var findSvc='SVC="$(connmanctl services 2>/dev/null | awk \'/^\\*A/ {for(i=1;i<=NF;i++) if($i ~ /^wifi_/) {print $i; exit}}\')"; ';
  var reconnect=findSvc+
    'if [ -n "$SVC" ]; then connmanctl disconnect "$SVC" >/dev/null 2>&1 || true; sleep 2; '+
      'connmanctl connect "$SVC" >/dev/null 2>&1 || true; fi; sleep 7';
  if(level==='full'){
    return 'connmanctl disable wifi >/dev/null 2>&1 || true; sleep 2; '+
      'connmanctl enable wifi >/dev/null 2>&1 || true; sleep 5; '+reconnect;
  }
  return reconnect;
}

function runRecovery(level,source,reason,cb){
  var gate=canRecover(source),started;
  if(!gate.ok){
    addHistory('RECOVERY_BLOCKED',gate.reason);
    sessionLastRecovery=new Date().toISOString();
    sessionLastRecoveryResult='blocked';
    if(cb)cb(false,gate.reason);
    return;
  }
  level=level==='full'?'full':'quick';
  started=new Date();
  recoveryInProgress=true;
  if(source==='auto')recoveryTimes.push(started.getTime());
  sessionLastRecovery=started.toISOString();
  sessionLastRecoveryResult='running';
  addHistory('RECOVERY_START',source+' '+level+' '+(reason||''));
  rootExec(recoveryCommand(level),function(err){
    if(err){
      recoveryInProgress=false;
      sessionLastRecoveryResult='failed';
      addHistory('RECOVERY_FAIL',String(err));
      if(cb)cb(false,String(err));
      return;
    }
    collect(function(probeErr,r){
      if(!probeErr&&r.state==='Connected'){
        recoveryInProgress=false;
        sessionRecoveryCount++;
        lifetimeRecoveryCount++;
        sessionLastRecoveryResult='success';
        addHistory('RECOVERY_OK',source+' '+level+' restored in '+Math.max(1,Math.round((Date.now()-started.getTime())/1000))+'s');
        if(cb)cb(true,'Connection restored');
        return;
      }
      if(source==='auto'&&level==='quick'&&cfg.aggressiveFix){
        recoveryInProgress=false;
        runRecovery('full','auto','quick recovery failed',cb);
        return;
      }
      recoveryInProgress=false;
      sessionLastRecoveryResult='failed';
      addHistory('RECOVERY_FAIL',(r&&r.cause)||'Connection still unavailable');
      if(cb)cb(false,(r&&r.cause)||'Connection still unavailable');
    },true);
  });
}

function autoFixGraceRemaining(){
  return Math.max(0,Math.ceil((serviceStartedAt+autoFixGraceMs-Date.now())/1000));
}

function maybeAutoRecover(r){
  if(!cfg.autoFix||recoveryInProgress)return;
  // Safe by default: no automatic changes during SSID switching or without a stable service.
  if(!r.ssid||r.ssid==='--'||!r.ip||r.connman!=='connected')return;
  if(r.cause==='Wi-Fi interface is dormant')return;
  // Gateway-only devices may intentionally refuse ICMP; never auto-reset those links.
  if(r.cause==='Gateway unreachable')return;
  if(autoFixGraceRemaining()>0)return;
  if(r.state!=='Problem'&&r.state!=='Offline')return;
  runRecovery('quick','auto',r.cause,function(){});
}

function finishCollect(err,data,suppressAuto){
  var now=new Date().toISOString(),ok,delta,cause,state,rawRxDropped;
  if(err){
    last.returnValue=true;
    last.state='Unavailable';
    last.cause='Root probe unavailable';
    last.probeError=String(err);
    last.lastCheck=now;
    last.monitoring=!!timer;
    last.backgroundWatchdog=cfg.backgroundWatchdog;
    last.watchdogActive=false;
    last.autoFix=cfg.autoFix;
    last.autoFixGraceSec=autoFixGraceRemaining();
    last.iface=cfg.iface;
    last.recoveryInProgress=recoveryInProgress;
    collecting=false;
    localLog(now+' probe unavailable: '+err);
    return last;
  }

  ok=data.PING_OK==='1';
  if(!ok){
    failures++;
    if(failures===cfg.failureThreshold){
      lastFailure=now;
      captureFailure(causeFor(data,ok));
      addHistory('FAILURE',causeFor(data,ok));
    }
  }else{
    if(failures>0)addHistory('RESTORED','Gateway reachable without recovery');
    failures=0;
  }

  rawRxDropped=data.RX_DROPPED?Number(data.RX_DROPPED):null;
  delta=null;
  if(rawRxDropped!==null){
    if(sessionRxLastRaw===null){
      delta=0;
    }else if(rawRxDropped>=sessionRxLastRaw){
      delta=rawRxDropped-sessionRxLastRaw;
      sessionRxDropped+=delta;
    }else{
      delta=0;
    }
    sessionRxLastRaw=rawRxDropped;
  }

  cause=causeFor(data,ok);
  if(ok)state='Connected';
  else if(failures>=cfg.failureThreshold){
    state=(!data.IP)?'Offline':'Problem';
  }else{
    state='Degraded';
  }

  last={
    returnValue:true,
    state:state,
    cause:cause,
    ssid:data.SSID||'--',
    ip:data.IP||null,
    gateway:data.GW||null,
    latencyMs:data.LATENCY?Number(data.LATENCY):null,
    signalDbm:data.SIGNAL_DBM?Number(data.SIGNAL_DBM):null,
    signalQuality:data.SIGNAL_QUALITY?Number(data.SIGNAL_QUALITY):null,
    rxPackets:data.RX_PACKETS?Number(data.RX_PACKETS):null,
    rxDropped:sessionRxDropped,
    rxDroppedRaw:rawRxDropped,
    rxDropDelta:delta,
    failureCount:failures,
    lastFailure:lastFailure,
    association:data.OPER||'unknown',
    connman:data.CONNMAN||'unknown',
    monitoring:!!timer,
    backgroundWatchdog:cfg.backgroundWatchdog,
    watchdogActive:data.HOOK_ACTIVE==='1',
    autoFix:cfg.autoFix,
    autoFixGraceSec:autoFixGraceRemaining(),
    iface:cfg.iface,
    lastCheck:now,
    probeError:null,
    recoveryInProgress:recoveryInProgress,
    recoveryCount:sessionRecoveryCount,
    lastRecovery:sessionLastRecovery,
    lastRecoveryResult:sessionLastRecoveryResult,
    sessionStartedAt:new Date(serviceStartedAt).toISOString(),
    lifetimeRecoveryCount:lifetimeRecoveryCount,
    lifetimeLastRecovery:lifetimeLastRecovery
  };

  collecting=false;
  if(!suppressAuto)maybeAutoRecover(last);
  return last;
}

function collect(cb,suppressAuto){
  if(collecting){
    if(cb)cb(null,last);
    return;
  }
  collecting=true;
  rootExec(buildProbeCommand(),function(err,out){
    var r=finishCollect(err,parseKv(out),suppressAuto);
    if(cb)cb(err,r);
  });
}

function start(){
  if(timer)return;
  collect();
  timer=setInterval(function(){collect();},cfg.intervalSec*1000);
  last.monitoring=true;
}

function restartTimer(){
  if(timer){clearInterval(timer);timer=null;}
  start();
}

function applyPatch(patch,cb){
  var merged={},k;
  if(patch&&patch.reset===true){
    cfg=copy(DEFAULTS);
  }else{
    for(k in cfg)merged[k]=cfg[k];
    for(k in patch)merged[k]=patch[k];
    cfg=sanitize(merged);
  }
  persistConfig(function(){
    updateBootHook(function(){
      restartTimer();
      if(cb)cb();
    });
  });
}

function diagnosticsText(cb){
  var cmd='echo "=== ROUTES ==="; route -n; echo; '+
    'echo "=== WIRELESS ==="; cat /proc/net/wireless; echo; '+
    'echo "=== ARP ==="; cat /proc/net/arp; echo; '+
    'echo "=== CONNMAN ==="; connmanctl services; echo; '+
    'echo "=== IFCONFIG ==="; ifconfig '+cfg.iface+'; echo; '+
    'echo "=== RECENT HISTORY ==="; tail -n 30 '+HISTORY+' 2>/dev/null; echo; '+
    'echo "=== LAST FAILURE SNAPSHOT ==="; cat '+LAST_FAILURE+' 2>/dev/null';
  rootExec(cmd,function(err,out){
    var local='';
    try{local=fs.readFileSync(LOCAL_LOG,'utf8').slice(-8000);}catch(e){}
    cb('=== STATUS ===\n'+JSON.stringify(last,null,2)+
      '\n\n=== SETTINGS ===\n'+JSON.stringify(cfg,null,2)+
      '\n\n'+(out||('ROOT PROBE ERROR: '+err))+
      '\n\n=== LOCAL LOG ===\n'+local);
  });
}


/* Network management: fixed ConnMan IDs only; never log credentials. */
function networkId(id){return /^wifi_[0-9a-f]{12}_[0-9a-f]+_managed_(psk|none|ieee8021x|wep)$/.test(String(id||''));}
function parsedNetworks(output){
  var items={},lines=String(output||'').split(/\r?\n/),v,id;
  lines.forEach(function(line){
    if(line.indexOf('PROFILE|')===0){
      v=line.split('|');id=v[1];if(!networkId(id))return;
      items[id]={id:id,name:v.slice(2).join('|'),saved:true,visible:false,connected:false,favorite:false};
    }else if(line.indexOf('DETAIL|')===0){
      v=line.split('|');id=v[1];if(!items[id])return;
      items[id].favorite=v[2]==='true';
    }else if(line.indexOf('SERVICE|')===0){
      v=line.split('|');id=v[1];if(!networkId(id))return;
      if(!items[id])items[id]={id:id,name:v.slice(3).join('|'),saved:false,favorite:false};
      items[id].visible=true;items[id].connected=v[2]==='1';
    }
  });
  return Object.keys(items).map(function(k){return items[k];}).sort(function(a,b){return (b.connected?1:0)-(a.connected?1:0)||a.name.localeCompare(b.name);});
}
service.register('listNetworks',function(m){
  ensureConfigLoaded(function(){
    var cmd='for f in /var/lib/connman/wifi_*/settings; do [ -f "$f" ] || continue; '+
      'id="${f%/settings}"; id="${id##*/}"; '+
      'name="$(sed -n "s/^Name=//p" "$f" | head -n 1 | tr "\\r\\n| " "   ")"; '+
      'fav="$(sed -n "s/^Favorite=//p" "$f" | head -n 1)"; '+
      'printf "PROFILE|%s|%s\\nDETAIL|%s|%s\\n" "$id" "$name" "$id" "$fav"; done; '+
      'connmanctl services | while IFS= read -r line; do '+
      'case "$line" in *wifi_*_managed_*) ;; *) continue ;; esac; '+
      'id="${line##* }"; case "$id" in wifi_*_managed_*) ;; *) continue ;; esac; '+
      'prefix="${line%$id}"; case "$prefix" in \\*A*) connected=1 ;; *) connected=0 ;; esac; '+
      'name="$(printf "%s" "$prefix" | sed "s/^[*AORF[:space:]]*//; s/[[:space:]]*$//")"; '+
      'printf "SERVICE|%s|%s|%s\\n" "$id" "$connected" "$name"; done';
    rootExec(cmd,function(err,out){m.respond(err?{returnValue:false,errorText:String(err)}:{returnValue:true,networks:parsedNetworks(out)});});
  });
});
// Orphan profiles are on disk but absent from ConnMan's currently advertised services.
// Move (never delete) an inactive profile to a root-only backup directory.
service.register('archiveOrphanProfile',function(m){
  ensureConfigLoaded(function(){
    var id=m.payload&&m.payload.id;
    if(!networkId(id)){
      m.respond({returnValue:false,success:false,message:'Invalid profile ID'});return;
    }
    var q=shellQuote(id);
    var cmd='ID='+q+'; '+
      'SRC="/var/lib/connman/$ID"; '+
      'BACKUP="/home/root/.config/wifi-watch-profile-backups"; '+
      'if [ ! -d "$SRC" ] || [ ! -f "$SRC/settings" ]; then echo "PROFILE_NOT_FOUND"; exit 0; fi; '+
      'ACTIVE="$(connmanctl services | grep "^\\*A" | head -n 1)"; ACTIVE="${ACTIVE##* }"; '+
      'if [ "$ACTIVE" = "$ID" ]; then echo "BLOCKED_ACTIVE"; exit 0; fi; '+
      'if connmanctl services | grep -F "$ID" >/dev/null 2>&1; then echo "BLOCKED_LISTED_SERVICE"; exit 0; fi; '+
      'mkdir -p "$BACKUP" || exit 2; chmod 700 "$BACKUP" || exit 2; '+
      'STAMP="$(date +%Y%m%d-%H%M%S)"; DST="$BACKUP/$ID-$STAMP-$"; '+
      'mv "$SRC" "$DST" || exit 2; chmod 700 "$DST" || exit 2; echo "ARCHIVED"';
    rootExec(cmd,function(err,out){
      var result=String(out||'').trim();
      m.respond({returnValue:true,success:!err&&result==='ARCHIVED',
        message:err?String(err):result==='ARCHIVED'?'Profile moved to secure backup':result.slice(0,160)});
    });
  });
});

service.register('networkAction',function(m){
  ensureConfigLoaded(function(){
    var p=m.payload||{},id=p.id,action=p.action;
    if(!networkId(id)||['forget','connect','disconnect'].indexOf(action)<0){
      m.respond({returnValue:false,errorText:'Invalid network or action'});return;
    }
    // Never delete a network while it is the active one.
    var cmd='ACTIVE="$(connmanctl services | grep "^\\*A" | head -n 1)"; '+
      'ACTIVE="${ACTIVE##* }"; '+
      'if [ "$ACTIVE" = '+shellQuote(id)+' ] && [ '+shellQuote(action)+' = forget ]; then echo "BLOCKED_ACTIVE"; exit 0; fi; '+
      'connmanctl '+(action==='forget'?'remove':action)+' '+shellQuote(id)+' 2>&1';
    rootExec(cmd,function(err,out){
      m.respond({returnValue:true,success:!err&&!/Error|Failed|BLOCKED_ACTIVE|not found|not supported|invalid/i.test(out||''),message:err?String(err):String(out||'Completed').slice(0,300)});
    });
  });
});


service.register('connectWithPassword',function(m){
  ensureConfigLoaded(function(){
    var p=m.payload||{},ssid=p.ssid,pass=p.password;
    if(typeof ssid!=='string'||!ssid||ssid.length>128||typeof pass!=='string'||pass.length<8||pass.length>63){
      m.respond({returnValue:false,errorText:'SSID or WPA2 password length invalid'});return;
    }
    // Luna connect is used rather than echoing credentials into a shell or storing them in our files.
    service.call('luna://com.webos.service.wifi/connect',{
      ssid:ssid,storeProfile:true,security:{securityType:'psk',simpleSecurity:{passKey:pass}}
    },function(reply){
      var r=reply&&reply.payload||{};
      m.respond({returnValue:true,success:r.returnValue===true,message:r.returnValue===true?'Connected and profile requested':String(r.errorText||'Connection rejected')});
    });
  });
});

/* Root-only profile snapshots. Credentials never enter Luna responses or logs.
 * Restore is intentionally refused for the active profile and does not
 * restart ConnMan: users must reconnect explicitly after restoration. */
service.register('backupNetworkProfile',function(m){
  ensureConfigLoaded(function(){
    var id=m.payload&&m.payload.id;
    if(!networkId(id)){m.respond({returnValue:false,errorText:'Invalid profile ID'});return;}
    var cmd='ID='+shellQuote(id)+'; SOURCE="/var/lib/connman/$ID"; '+
      'DEST="/home/root/.config/wifi-watch-profile-backups"; '+
      'if [ ! -f "$SOURCE/settings" ]; then echo MISSING; exit 0; fi; '+
      'umask 077; mkdir -p "$DEST" || exit 1; chmod 700 "$DEST"; '+
      'STAMP="$(date +%Y%m%d-%H%M%S)"; '+
      'TARGET="$DEST/$ID-$STAMP.snapshot"; '+
      'mkdir "$TARGET" || exit 1; cp -p "$SOURCE/settings" "$TARGET/settings" || exit 1; '+
      'if [ -f "$SOURCE/data" ]; then cp -p "$SOURCE/data" "$TARGET/data" || exit 1; fi; '+
      'chmod 700 "$TARGET"; chmod 600 "$TARGET/"*; echo SAVED';
    rootExec(cmd,function(err,out){
      var success=!err&&String(out||'').trim()==='SAVED';
      m.respond({returnValue:true,success:success,message:success?'Encrypted credentials, if present, copied to root-only snapshot':'Backup failed or profile missing'});
    });
  });
});
service.register('listProfileBackups',function(m){
  ensureConfigLoaded(function(){
    var cmd='for d in /home/root/.config/wifi-watch-profile-backups/*.snapshot; do '+
      '[ -f "$d/settings" ] || continue; name="${d##*/}"; printf "%s\\n" "$name"; done';
    rootExec(cmd,function(err,out){
      var backups=String(out||'').split(/\\r?\\n/).filter(function(x){return /^wifi_[0-9a-f]{12}_[0-9a-f]+_managed_(psk|none|ieee8021x|wep)-[0-9]{8}-[0-9]{6}\\.snapshot$/.test(x);});
      m.respond(err?{returnValue:false,errorText:String(err)}:{returnValue:true,backups:backups});
    });
  });
});
service.register('restoreNetworkProfile',function(m){
  ensureConfigLoaded(function(){
    var p=m.payload||{},id=p.id,name=p.backup;
    if(!networkId(id)||typeof name!=='string'||!/^wifi_[0-9a-f]{12}_[0-9a-f]+_managed_(psk|none|ieee8021x|wep)-[0-9]{8}-[0-9]{6}\.snapshot$/.test(name)||name.indexOf(id+'-')!==0){
      m.respond({returnValue:false,errorText:'Invalid snapshot selection'});return;
    }
    var cmd='ID='+shellQuote(id)+'; NAME='+shellQuote(name)+'; '+
      'SOURCE="/home/root/.config/wifi-watch-profile-backups/$NAME"; TARGET="/var/lib/connman/$ID"; '+
      'ACTIVE="$(connmanctl services | grep "^\\*A" | head -n 1)"; ACTIVE="${ACTIVE##* }"; '+
      'if [ "$ACTIVE" = "$ID" ]; then echo ACTIVE_BLOCKED; exit 0; fi; '+
      '[ -f "$SOURCE/settings" ] || { echo MISSING; exit 0; }; '+
      'umask 077; mkdir -p "$TARGET" || exit 1; '+
      'cp -p "$SOURCE/settings" "$TARGET/settings" || exit 1; '+
      'if [ -f "$SOURCE/data" ]; then cp -p "$SOURCE/data" "$TARGET/data" || exit 1; fi; '+
      'chmod 700 "$TARGET"; chmod 600 "$TARGET/settings"; echo RESTORED';
    rootExec(cmd,function(err,out){
      var result=String(out||'').trim();
      m.respond({returnValue:true,success:!err&&result==='RESTORED',
        message:result==='RESTORED'?'Profile restored on disk; reconnect explicitly':result==='ACTIVE_BLOCKED'?'Cannot overwrite active Wi-Fi profile':err?String(err):result});
    });
  });
});
service.register('boot',function(m){
  ensureConfigLoaded(function(){
    resetSessionStats('boot');
    updateBootHook(function(){});
    if(cfg.backgroundWatchdog||cfg.autoFix)start();
    else collect();
    m.respond({returnValue:true,monitoring:!!timer,backgroundWatchdog:cfg.backgroundWatchdog,autoFix:cfg.autoFix});
  });
});

service.register('status',function(m){
  ensureConfigLoaded(function(){
    if(!timer)start();
    collect(function(){
      last.monitoring=!!timer;
      m.respond(last);
    });
  });
});

service.register('fixNow',function(m){
  ensureConfigLoaded(function(){
    var level=(m.payload&&m.payload.level)==='full'?'full':'quick';
    runRecovery(level,'manual','user requested',function(ok,msg){
      m.respond({returnValue:true,success:ok,message:msg,status:last});
    });
  });
});

service.register('diagnostics',function(m){
  ensureConfigLoaded(function(){
    diagnosticsText(function(text){m.respond({returnValue:true,text:text});});
  });
});

service.register('getSettings',function(m){
  ensureConfigLoaded(function(){
    m.respond({returnValue:true,settings:cfg});
  });
});

service.register('setSettings',function(m){
  ensureConfigLoaded(function(){
    applyPatch((m.payload&&m.payload.settings)||{},function(){
      m.respond({returnValue:true,settings:cfg,monitoring:!!timer});
    });
  });
});

service.register('clearHistory',function(m){
  rootExec('rm -f '+HISTORY+' '+LAST_FAILURE+'; true',function(){
    lifetimeRecoveryCount=0;lifetimeLastRecovery=null;
    m.respond({returnValue:true});
  });
});

service.register('clearLog',function(m){
  try{if(fs.existsSync(LOCAL_LOG))fs.unlinkSync(LOCAL_LOG);}catch(e){}
  m.respond({returnValue:true});
});

service.register('closeApp',function(m){
  m.respond({returnValue:true});
  setTimeout(function(){
    var cmd="(luna-send -n 1 -f luna://com.webos.applicationManager/dev/closeByAppId '{\"id\":\"org.webosbrew.wifiwatch\"}' >/dev/null 2>&1 || luna-send -n 1 -f luna://com.webos.service.applicationManager/closeByAppId '{\"id\":\"org.webosbrew.wifiwatch\"}' >/dev/null 2>&1) &";
    rootExec(cmd,function(){});
  },100);
});

ensureConfigLoaded(function(){
  if(cfg.backgroundWatchdog||cfg.autoFix)start();
  else collect();
});
