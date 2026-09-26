var Service=require('webos-service');
var service=new Service('org.webosbrew.wifiwatch.service');
var cp=require('child_process'),fs=require('fs');

var LOG='/tmp/wifi-watch.log';
var OLD='/tmp/wifi-watch.log.old';
var CONFIG='/home/root/.config/wifi-watch.json';
var DEFAULTS={autoMonitor:true,intervalSec:5,failureThreshold:3,iface:'wlan0',pingTimeout:2,logSizeMB:1};

var cfg=loadConfig();
var timer=null,failures=0,lastFailure=null,last={};

function sh(cmd){
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
    sh('mkdir -p /home/root/.config');
    fs.writeFileSync(CONFIG,JSON.stringify(cfg,null,2));
  }catch(e){}
}

function gateway(){
  return sh("route -n 2>/dev/null | awk '$1==\"0.0.0.0\" {print $2; exit}'");
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

function captureFailure(gw){
  log('\n######## WIFI FAILURE '+lastFailure+' ########\n'+
    sh('date; ifconfig '+cfg.iface+'; route -n; cat /proc/net/wireless; cat /proc/net/arp; connmanctl services; dmesg | tail -n 120')+
    '\nGATEWAY='+gw);
}

function collect(){
  var IF=cfg.iface,GW=gateway();
  var ifc=sh('ifconfig '+IF+' 2>/dev/null');
  var ipm=ifc.match(/inet addr:([0-9.]+)/);
  var rxm=ifc.match(/RX packets:(\d+).*dropped:(\d+)/);
  var pingOut=GW?sh('ping -c 1 -W '+cfg.pingTimeout+' '+GW+' 2>/dev/null'):'';
  var lm=pingOut.match(/time[=<]([0-9.]+) ?ms/);
  var ok=!!GW && /1 packets received|1 received|1 packets transmitted, 1 received/.test(pingOut);

  if(!ok){
    failures++;
    if(failures===cfg.failureThreshold){
      lastFailure=new Date().toISOString();
      captureFailure(GW||'none');
    }
  }else failures=0;

  var services=sh('connmanctl services 2>/dev/null');
  var lines=services.split('\n'),active='',i;
  for(i=0;i<lines.length;i++){if(/^\*A/.test(lines[i])){active=lines[i];break;}}
  var sm=active.match(/^\*A[OFR]*\s+(.+?)\s+wifi_/);
  var oper=sh('cat /sys/class/net/'+IF+'/operstate 2>/dev/null');
  var state=ok?'Connected':(failures>=cfg.failureThreshold?'Problem':'Degraded');

  last={
    returnValue:true,
    state:state,
    ssid:sm?sm[1].trim():'--',
    ip:ipm?ipm[1]:null,
    gateway:GW||null,
    latencyMs:lm?Number(lm[1]):null,
    rxPackets:rxm?Number(rxm[1]):null,
    rxDropped:rxm?Number(rxm[2]):null,
    failureCount:failures,
    lastFailure:lastFailure,
    association:oper||'unknown',
    connman:active?'connected':'unknown',
    monitoring:!!timer,
    iface:IF,
    lastCheck:new Date().toISOString()
  };

  if(!ok)log(new Date().toISOString()+' state='+state+' failures='+failures+' oper='+oper+' ip='+(last.ip||'-')+' gateway='+(GW||'-'));
  return last;
}

function start(){
  if(timer)return;
  collect();
  timer=setInterval(collect,cfg.intervalSec*1000);
}

function stop(){
  if(timer){clearInterval(timer);timer=null;}
  last.monitoring=false;
}

function applyPatch(patch){
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
}

service.register('status',function(m){
  if(!timer)collect();
  last.monitoring=!!timer;
  m.respond(last);
});

service.register('toggleMonitor',function(m){
  if(timer)stop();else start();
  m.respond({returnValue:true,monitoring:!!timer});
});

service.register('diagnostics',function(m){
  var r=collect();
  var text='=== STATUS ===\n'+JSON.stringify(r,null,2)+
    '\n\n=== SETTINGS ===\n'+JSON.stringify(cfg,null,2)+
    '\n\n=== ROUTES ===\n'+sh('route -n')+
    '\n\n=== WIRELESS ===\n'+sh('cat /proc/net/wireless')+
    '\n\n=== CONNMAN ===\n'+sh('connmanctl services')+
    '\n\n=== LAST LOG ===\n'+sh('tail -n 250 '+LOG+' 2>/dev/null');
  m.respond({returnValue:true,text:text});
});

service.register('getSettings',function(m){
  m.respond({returnValue:true,settings:cfg});
});

service.register('setSettings',function(m){
  applyPatch((m.payload&&m.payload.settings)||{});
  m.respond({returnValue:true,settings:cfg,monitoring:!!timer});
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
