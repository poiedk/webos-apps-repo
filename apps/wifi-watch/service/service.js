var Service=require('webos-service');
var service=new Service('org.webosbrew.wifiwatch.service');
var cp=require('child_process'),fs=require('fs');

var LOG='/tmp/wifi-watch.log';
var OLD='/tmp/wifi-watch.log.old';
var CONFIG='/home/root/.config/wifi-watch.json';
var ROOT_EXEC='luna://org.webosbrew.hbchannel.service/exec';
var DEFAULTS={autoMonitor:true,intervalSec:5,failureThreshold:3,iface:'wlan0',pingTimeout:2,logSizeMB:1};

var cfg=loadConfig();
var timer=null,failures=0,lastFailure=null,last={
  returnValue:true,state:'Starting',ssid:'--',ip:null,gateway:null,latencyMs:null,
  rxPackets:null,rxDropped:null,failureCount:0,lastFailure:null,association:'unknown',
  connman:'unknown',monitoring:false,iface:'wlan0',lastCheck:null,probeError:null
};
var collecting=false;

function localSh(cmd){
  try{return cp.execSync(cmd,{encoding:'utf8'}).trim();}
  catch(e){return (e.stdout||'').toString().trim();}
}

function saneNumber(v,allowed,fallback){
  var n=Number(v),i;
  for(i=0;i<allowed.length;i++)if(n===allowed[i])return n;
  return fallback;
}

function sanitize(input){
  var out={},x=input||{};
  out.autoMonitor=typeof x.autoMonitor==='boolean'?x.autoMonitor:DEFAULTS.autoMonitor;
  out.intervalSec=saneNumber(x.intervalSec,[5,10,15,30],DEFAULTS.intervalSec);
  out.failureThreshold=saneNumber(x.failureThreshold,[1,2,3,5],DEFAULTS.failureThreshold);
  out.iface=(x.iface==='eth0'||x.iface==='wlan0')?x.iface:DEFAULTS.iface;
  out.pingTimeout=saneNumber(x.pingTimeout,[1,2,3],DEFAULTS.pingTimeout);
  out.logSizeMB=saneNumber(x.logSizeMB,[1,2,5],DEFAULTS.logSizeMB);
  return out;
}

function loadConfig(){
  try{
    if(fs.existsSync(CONFIG))return sanitize(JSON.parse(fs.readFileSync(CONFIG,'utf8')));
  }catch(e){}
  return sanitize(DEFAULTS);
}

function saveConfig(){
  try{
    localSh('mkdir -p /home/root/.config');
    fs.writeFileSync(CONFIG,JSON.stringify(cfg,null,2));
  }catch(e){}
}

function rotate(){
  try{
    var limit=cfg.logSizeMB*1048576;
    if(fs.existsSync(LOG)&&fs.statSync(LOG).size>limit){
      try{fs.unlinkSync(OLD);}catch(e){}
      fs.renameSync(LOG,OLD);
      fs.writeFileSync(LOG,'===== ROTATED '+new Date().toISOString()+' =====\n');
    }
  }catch(e){}
}

function log(s){
  try{fs.appendFileSync(LOG,s+'\n');rotate();}catch(e){}
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
  q.push('if [ -n "$ACTIVE" ]; then echo "CONNMAN=connected"; else echo "CONNMAN=unknown"; fi');
  q.push('echo "LATENCY=$LAT"');
  q.push('echo "PING_OK=$OK"');
  return q.join('; ');
}

function captureFailure(gw){
  var cmd='date; ifconfig '+cfg.iface+'; route -n; cat /proc/net/wireless; cat /proc/net/arp; connmanctl services; dmesg | tail -n 120';
  rootExec(cmd,function(err,out){
    log('\n######## WIFI FAILURE '+lastFailure+' ########\n'+(out||('probe error: '+err))+'\nGATEWAY='+(gw||'none'));
  });
}

function finishCollect(err,data){
  var now=new Date().toISOString();
  if(err){
    last.returnValue=true;
    last.state='Unavailable';
    last.probeError=String(err);
    last.lastCheck=now;
    last.monitoring=!!timer;
    last.iface=cfg.iface;
    collecting=false;
    log(now+' probe unavailable: '+err);
    return last;
  }

  var ok=data.PING_OK==='1';
  var hasNetwork=!!(data.IP||data.GW||data.OPER);
  if(hasNetwork&&!ok){
    failures++;
    if(failures===cfg.failureThreshold){
      lastFailure=now;
      captureFailure(data.GW||'none');
    }
  }else if(ok){
    failures=0;
  }

  var state;
  if(!hasNetwork)state='Unavailable';
  else if(ok)state='Connected';
  else state=failures>=cfg.failureThreshold?'Problem':'Degraded';

  last={
    returnValue:true,
    state:state,
    ssid:data.SSID||'--',
    ip:data.IP||null,
    gateway:data.GW||null,
    latencyMs:data.LATENCY?Number(data.LATENCY):null,
    rxPackets:data.RX_PACKETS?Number(data.RX_PACKETS):null,
    rxDropped:data.RX_DROPPED?Number(data.RX_DROPPED):null,
    failureCount:failures,
    lastFailure:lastFailure,
    association:data.OPER||'unknown',
    connman:data.CONNMAN||'unknown',
    monitoring:!!timer,
    iface:cfg.iface,
    lastCheck:now,
    probeError:null
  };

  if(state!=='Connected'){
    log(now+' state='+state+' failures='+failures+' oper='+(data.OPER||'-')+' ip='+(data.IP||'-')+' gateway='+(data.GW||'-'));
  }
  collecting=false;
  return last;
}

function collect(cb){
  if(collecting){
    if(cb)cb(null,last);
    return;
  }
  collecting=true;
  rootExec(buildProbeCommand(),function(err,out){
    var r=finishCollect(err,parseKv(out));
    if(cb)cb(err,r);
  });
}

function start(){
  if(timer)return;
  collect();
  timer=setInterval(function(){collect();},cfg.intervalSec*1000);
  last.monitoring=true;
}

function stop(){
  if(timer){clearInterval(timer);timer=null;}
  last.monitoring=false;
}

function applyPatch(patch,cb){
  var wasRunning=!!timer,key;
  if(patch&&patch.reset===true){
    cfg=sanitize(DEFAULTS);
  }else{
    var merged={};
    for(key in cfg)merged[key]=cfg[key];
    for(key in patch)merged[key]=patch[key];
    cfg=sanitize(merged);
  }
  saveConfig();
  if(wasRunning){
    stop();start();
  }else if(cfg.autoMonitor){
    start();
  }else{
    collect();
  }
  if(cb)cb();
}

service.register('status',function(m){
  collect(function(){
    last.monitoring=!!timer;
    m.respond(last);
  });
});

service.register('toggleMonitor',function(m){
  if(timer)stop();else start();
  m.respond({returnValue:true,monitoring:!!timer});
});

service.register('diagnostics',function(m){
  var cmd='echo "=== ROUTES ==="; route -n; echo; echo "=== WIRELESS ==="; cat /proc/net/wireless; echo; echo "=== ARP ==="; cat /proc/net/arp; echo; echo "=== CONNMAN ==="; connmanctl services; echo; echo "=== IFCONFIG ==="; ifconfig '+cfg.iface;
  rootExec(cmd,function(err,out){
    var text='=== STATUS ===\n'+JSON.stringify(last,null,2)+
      '\n\n=== SETTINGS ===\n'+JSON.stringify(cfg,null,2)+
      '\n\n'+(out||('ROOT PROBE ERROR: '+err))+
      '\n\n=== LAST LOG ===\n'+localSh('tail -n 250 '+LOG+' 2>/dev/null');
    m.respond({returnValue:true,text:text});
  });
});

service.register('getSettings',function(m){
  m.respond({returnValue:true,settings:cfg});
});

service.register('setSettings',function(m){
  applyPatch((m.payload&&m.payload.settings)||{},function(){
    m.respond({returnValue:true,settings:cfg,monitoring:!!timer});
  });
});

service.register('clearLog',function(m){
  try{if(fs.existsSync(LOG))fs.unlinkSync(LOG);}catch(e){}
  try{if(fs.existsSync(OLD))fs.unlinkSync(OLD);}catch(e){}
  m.respond({returnValue:true});
});

service.register('closeApp',function(m){
  m.respond({returnValue:true});
  setTimeout(function(){
    cp.exec("(luna-send -n 1 luna://com.webos.service.applicationmanager/closeByAppId '{\"id\":\"org.webosbrew.wifiwatch\"}' >/dev/null 2>&1; sleep 1; luna-send -n 1 luna://com.webos.applicationManager/dev/close '{\"id\":\"org.webosbrew.wifiwatch\"}' >/dev/null 2>&1) &");
  },100);
});

if(cfg.autoMonitor)start();else collect();
