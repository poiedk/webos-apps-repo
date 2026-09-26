var Service=require('webos-service');
var service=new Service('org.webosbrew.wifiwatch.service');
var cp=require('child_process'), fs=require('fs');
var LOG='/tmp/wifi-watch.log', OLD='/tmp/wifi-watch.log.old', GW='192.168.1.254', IF='wlan0';
var timer=null, failures=0, lastFailure=null, last={};
function sh(cmd){try{return cp.execSync(cmd,{encoding:'utf8'}).trim();}catch(e){return (e.stdout||'').toString().trim();}}
function rotate(){try{if(fs.existsSync(LOG)&&fs.statSync(LOG).size>1048576){try{fs.unlinkSync(OLD);}catch(e){} fs.renameSync(LOG,OLD);fs.writeFileSync(LOG,'===== ROTATED '+new Date().toISOString()+' =====\n');}}catch(e){}}
function log(s){try{fs.appendFileSync(LOG,s+'\n');rotate();}catch(e){}}
function collect(){
  var ifc=sh('ifconfig '+IF+' 2>/dev/null');
  var ipm=ifc.match(/inet addr:([0-9.]+)/), rxm=ifc.match(/RX packets:(\d+).*dropped:(\d+)/);
  var pingOut=sh('ping -c 1 -W 2 '+GW+' 2>/dev/null');
  var lm=pingOut.match(/time[=<]([0-9.]+) ?ms/), ok=/1 packets received|1 received|1 packets transmitted, 1 received/.test(pingOut);
  if(!ok){failures++; if(failures===1){lastFailure=new Date().toISOString(); log('\n######## WIFI FAILURE '+lastFailure+' ########\n'+sh('date; ifconfig '+IF+'; route -n; cat /proc/net/wireless; cat /proc/net/arp; connmanctl services; dmesg | tail -n 120'));}} else failures=0;
  var services=sh('connmanctl services 2>/dev/null');
  var active=services.split('\n').filter(function(x){return /^\*A/.test(x);})[0]||'';
  var sm=active.match(/^\*A[OFR]*\s+(.+?)\s+wifi_/);
  var oper=sh('cat /sys/class/net/'+IF+'/operstate 2>/dev/null');
  last={returnValue:true,state:ok?'Connected':'Problem',ssid:sm?sm[1].trim():'—',ip:ipm?ipm[1]:null,gateway:GW,latencyMs:lm?Number(lm[1]):null,rxPackets:rxm?Number(rxm[1]):null,rxDropped:rxm?Number(rxm[2]):null,lastFailure:lastFailure,association:oper||'unknown',connman:active?'connected':'unknown',monitoring:!!timer};
  if(!ok) log(new Date().toISOString()+' state=FAIL failures='+failures+' oper='+oper+' ip='+(last.ip||'-'));
  return last;
}
function start(){if(timer)return; collect(); timer=setInterval(collect,5000);}
function stop(){if(timer){clearInterval(timer);timer=null;} last.monitoring=false;}
service.register('status',function(m){if(!timer) collect(); last.monitoring=!!timer; m.respond(last);});
service.register('toggleMonitor',function(m){if(timer)stop();else start();m.respond({returnValue:true,monitoring:!!timer});});
service.register('diagnostics',function(m){var text='=== STATUS ===\n'+JSON.stringify(collect(),null,2)+'\n\n=== ROUTES ===\n'+sh('route -n')+'\n\n=== WIRELESS ===\n'+sh('cat /proc/net/wireless')+'\n\n=== CONNMAN ===\n'+sh('connmanctl services')+'\n\n=== LAST LOG ===\n'+sh('tail -n 250 '+LOG+' 2>/dev/null');m.respond({returnValue:true,text:text});});
start();
