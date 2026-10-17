(function(){
  var SVC='luna://org.webosbrew.wifiwatch.service/';
  var screen='home',focus=0,current={},settings=null,busy=false;
  var networks=[],selectedNetwork=null,netActions=[];

  var simpleItems=[
    {k:'backgroundWatchdog',label:'Background watchdog',hint:'Start WiFi Watch automatically after TV boot',type:'bool'},
    {k:'autoFix',label:'Auto Fix',hint:'Reconnect Wi-Fi automatically after a confirmed failure',type:'bool'},
    {k:'intervalSec',label:'Check interval',hint:'How often the watchdog tests the gateway',type:'cycle',vals:[5,10,15,30],suffix:' sec'},
    {k:'failureThreshold',label:'Failure threshold',hint:'Failed checks before recovery is allowed',type:'cycle',vals:[1,2,3,5]},
    {k:'recoveryCooldownSec',label:'Recovery cooldown',hint:'Minimum delay between automatic recoveries',type:'cycle',vals:[30,60,120,300],suffix:' sec'},
    {action:'advanced',label:'Advanced settings',hint:'Recovery limits, interface and diagnostics',value:'OPEN'}
  ];

  var advancedItems=[
    {k:'aggressiveFix',label:'Aggressive recovery',hint:'Allow Wi-Fi OFF/ON if a quick reconnect fails',type:'bool'},
    {k:'iface',label:'Network interface',hint:'Interface used by the watchdog',type:'cycle',vals:['wlan0','eth0']},
    {k:'pingTimeout',label:'Ping timeout',hint:'Gateway ping timeout',type:'cycle',vals:[1,2,3],suffix:' sec'},
    {k:'maxRecoveries',label:'Max recoveries',hint:'Maximum recovery attempts within 10 minutes',type:'cycle',vals:[1,2,3,5]},
    {k:'logSizeMB',label:'Log size',hint:'Local watchdog log size before rotation',type:'cycle',vals:[1,2,5],suffix:' MB'},
    {action:'fullFix',label:'Full Wi-Fi restart',hint:'Turn Wi-Fi off/on and reconnect now',value:'RUN'},
    {action:'clearHistory',label:'Clear history',hint:'Delete recovery history and last failure snapshot',value:'CLEAR',danger:true},
    {action:'reset',label:'Reset defaults',hint:'Restore safe WiFi Watch defaults',value:'RESET',danger:true}
  ];

  function call(method,params,cb){
    try{
      var bridge=new PalmServiceBridge();
      bridge.onservicecallback=function(raw){
        var r;
        try{r=JSON.parse(raw);}catch(e){if(cb)cb(e);return;}
        if(r.returnValue===false){if(cb)cb(r);return;}
        if(cb)cb(null,r);
      };
      bridge.call(SVC+method,JSON.stringify(params||{}));
    }catch(e){if(cb)cb(e);}
  }

  function fmt(n){
    if(n===undefined||n===null)return '--';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,',');
  }

  function checkTime(v){
    if(!v)return '--';
    try{
      var d=new Date(v),h=d.getHours(),m=d.getMinutes(),s=d.getSeconds();
      return (h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
    }catch(e){return '--';}
  }

  function renderServiceError(e){
    var badge=document.getElementById('stateBadge');
    badge.className='badge fail';
    badge.textContent='ERR';
    document.getElementById('state').textContent='Service unavailable';
    document.getElementById('ssid').textContent=String((e&&(e.errorText||e.errorCode||e.message))||'Background service is not running');
    document.getElementById('autoFix').textContent='--';
  }

  function lastRecoveryText(r){
    if(!r.lastRecovery)return 'None';
    var state=r.lastRecoveryResult==='success'?'Success':(r.lastRecoveryResult==='failed'?'Failed':(r.lastRecoveryResult==='running'?'Running':'Blocked'));
    return state+' '+checkTime(r.lastRecovery);
  }

  function renderStatus(r){
    current=r||{};
    var badge=document.getElementById('stateBadge');
    var state=r.state||'Unknown';
    var fail=(state==='Problem'||state==='Offline'||state==='Unavailable');
    document.getElementById('state').textContent=r.recoveryInProgress?'Recovering...':state;
    badge.className='badge '+(state==='Connected'?'ok':(fail?'fail':(state==='Degraded'?'warn':'idle')));
    badge.textContent=r.recoveryInProgress?'FIX':(state==='Connected'?'OK':(fail?'ERR':(state==='Degraded'?'WARN':'--')));
    document.getElementById('ssid').textContent=(r.ssid||'No SSID')+' | '+(r.cause||'')+' | '+checkTime(r.lastCheck);
    document.getElementById('ip').textContent=r.ip||'--';
    document.getElementById('gateway').textContent='Gateway '+(r.gateway||'--');
    document.getElementById('latency').textContent=r.latencyMs!=null?r.latencyMs+' ms':'--';
    document.getElementById('signal').textContent=(r.signalDbm!=null&&r.signalDbm!==0)?r.signalDbm+' dBm':(r.signalQuality!=null&&r.signalQuality>0?r.signalQuality+'%':'N/A');
    document.getElementById('rxDropped').textContent=fmt(r.rxDropped);
    document.getElementById('recoveries').textContent=fmt(r.recoveryCount||0);
    document.getElementById('watchdog').textContent=r.watchdogActive?'Active':(r.backgroundWatchdog?'Pending':'Off');
    document.getElementById('autoFix').textContent=r.autoFix?(r.autoFixGraceSec>0?'ARMING':'ON'):'OFF';
    document.getElementById('lastRecovery').textContent=lastRecoveryText(r);
    document.getElementById('dropDelta').textContent=r.rxDropDelta==null?'--':'+'+fmt(r.rxDropDelta);
    document.getElementById('autoFixAction').textContent=r.autoFix?(r.autoFixGraceSec>0?'Auto Fix ARMING':'Auto Fix ON'):'Auto Fix OFF';
    document.getElementById('fixAction').textContent=r.recoveryInProgress?'Recovering...':'Fix now';
  }

  function refresh(){
    if(busy)return;
    call('status',{},function(e,r){if(e)renderServiceError(e);else renderStatus(r);});
  }

  function setScreen(id){
    document.getElementById('home').className='screen home'+(id==='home'?' active':'');
    document.getElementById('diagnosticsScreen').className='screen page'+(id==='diagnostics'?' active':'');
    document.getElementById('settingsScreen').className='screen page'+(id==='settings'?' active':'');
    document.getElementById('passwordScreen').className='screen page'+(id==='password'?' active':'');
    document.getElementById('networksScreen').className='screen page'+(id==='networks'?' active':'');
    document.getElementById('networkDetailScreen').className='screen page'+(id==='networkDetail'?' active':'');
    document.getElementById('advancedScreen').className='screen page'+(id==='advanced'?' active':'');
    screen=id;focus=0;renderFocus();
  }

  function renderFocus(){
    var i,a;
    if(screen==='home'){
      a=document.querySelectorAll('#home .action');
      for(i=0;i<a.length;i++)a[i].className='action'+(i===focus?' focus':'')+(i===a.length-1?' last':'');
    }else if(screen==='networks'){
      renderNetworks();
    }else if(screen==='password'){
      renderPasswordFocus();
    }else if(screen==='networkDetail'){
      renderNetworkActions();
    }else if(screen==='settings'){
      renderRows('settingsList',simpleItems);
    }else if(screen==='advanced'){
      renderRows('advancedList',advancedItems);
    }
  }

  function valueText(it){
    if(it.action)return it.value||'';
    if(!settings)return '--';
    if(it.type==='bool')return settings[it.k]?'ON':'OFF';
    return String(settings[it.k])+(it.suffix||'');
  }

  function renderRows(id,items){
    var host=document.getElementById(id),html='',i,it;
    for(i=0;i<items.length;i++){
      it=items[i];
      html+='<div class="row '+(i===focus?'focus ':'')+(it.danger?'danger':'')+'">'+
        '<div class="rowText"><div class="rowTitle">'+it.label+'</div><div class="rowHint">'+it.hint+'</div></div>'+
        '<div class="rowValue">'+valueText(it)+'</div></div>';
    }
    host.innerHTML=html;
  }

  function loadSettings(openScreen){
    call('getSettings',{},function(e,r){
      if(e){renderServiceError(e);setScreen('home');return;}
      if(r.settings)settings=r.settings;
      if(openScreen)setScreen(openScreen);else renderFocus();
    });
  }

  function savePatch(patch,cb){
    call('setSettings',{settings:patch},function(e,r){
      if(!e&&r.settings){
        settings=r.settings;
        renderFocus();
        refresh();
      }
      if(cb)cb(e,r);
    });
  }

  function changeSetting(it,dir){
    var vals,i,patch={};
    if(!settings)return;
    if(it.type==='bool')patch[it.k]=!settings[it.k];
    else{
      vals=it.vals;i=vals.indexOf(settings[it.k]);if(i<0)i=0;
      i=(i+(dir>0?1:-1)+vals.length)%vals.length;patch[it.k]=vals[i];
    }
    savePatch(patch);
  }

  function fixNow(level){
    if(busy)return;
    busy=true;
    document.getElementById('state').textContent=level==='full'?'Restarting Wi-Fi...':'Recovering Wi-Fi...';
    document.getElementById('stateBadge').className='badge warn';
    document.getElementById('stateBadge').textContent='FIX';
    document.getElementById('fixAction').textContent='Recovering...';
    call('fixNow',{level:level||'quick'},function(e,r){
      busy=false;
      if(e){renderServiceError(e);return;}
      if(r&&r.status)renderStatus(r.status);else refresh();
    });
  }

  function toggleAutoFix(){
    savePatch({autoFix:!current.autoFix});
  }

  function showDiagnostics(){
    setScreen('diagnostics');
    document.getElementById('diag').textContent='Loading diagnostics and history...';
    call('diagnostics',{},function(e,r){
      document.getElementById('diag').textContent=e?('Diagnostics error: '+JSON.stringify(e)):(r.text||'No diagnostic data');
    });
  }


  function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function loadNetworks(){
    setScreen('networks');
    document.getElementById('netNotice').textContent='Reading ConnMan services and saved profiles...';
    call('listNetworks',{},function(e,r){
      networks=e?[]:(r.networks||[]);
      document.getElementById('netNotice').textContent=e?'Network listing failed: '+String(e.errorText||e):'Saved profiles and visible services. Refresh updates this list.';
      renderFocus();
    });
  }
  function renderNetworks(){
    var html='<div class="row '+(focus===0?'focus':'')+'"><div class="rowText"><div class="rowTitle">Refresh networks</div><div class="rowHint">Read current services and stored profiles</div></div><div class="rowValue">OK</div></div>';
    networks.forEach(function(n,i){
      html+='<div class="row '+(focus===i+1?'focus':'')+'"><div class="rowText"><div class="rowTitle">'+esc(n.name||'(Hidden)')+'</div><div class="rowHint">'+esc(n.saved?'Stored profile':'Visible service')+'</div></div><div class="rowValue">'+esc(n.connected?'CONNECTED':(n.favorite?'SAVED':''))+'</div></div>';
    });
    document.getElementById('networksList').innerHTML=html;
  }
  function openNetwork(n){
    if(!n)return;
    selectedNetwork=n;
    document.getElementById('netDetailTitle').textContent=n.name||'Network';
    document.getElementById('netDetailInfo').textContent='Service: '+n.id+' | Favorite: '+!!n.favorite+' | Connected: '+!!n.connected+' | Password never displayed';
    netActions=[];
    if(n.visible&&!n.connected)netActions.push({id:'connect',label:'Connect (saved credentials only)'});
    if(n.id.indexOf('_managed_psk')>=0)netActions.push({id:'password',label:'Enter password and save'});
    if(n.visible&&n.connected)netActions.push({id:'disconnect',label:'Disconnect'});
    if(n.favorite)netActions.push({id:'forget',label:'Forget saved network',danger:true});
    netActions.push({id:'back',label:'Back to networks'});
    setScreen('networkDetail');
  }
  function renderNetworkActions(){
    document.getElementById('networkActions').innerHTML=netActions.map(function(n,i){
      return '<div class="row '+(focus===i?'focus ':'')+(n.danger?'danger':'')+'"><div class="rowText"><div class="rowTitle">'+esc(n.label)+'</div></div><div class="rowValue">OK</div></div>';
    }).join('');
  }
  function networkAction(action){
    if(action.id==='back'){setScreen('networks');return;}
    if(action.id==='password'){openPassword();return;}
    if(!selectedNetwork||busy)return;
    if(action.id==='forget'&&!window.confirm('Forget '+selectedNetwork.name+'? You may need the Wi-Fi password again.'))return;
    if(action.id==='disconnect'&&!window.confirm('Disconnect '+selectedNetwork.name+'? Remote access may be lost.'))return;
    busy=true;
    document.getElementById('netDetailInfo').textContent='Working...';
    call('networkAction',{action:action.id,id:selectedNetwork.id},function(e,r){
      busy=false;
      if(e||!r.success){
        document.getElementById('netDetailInfo').textContent='Action failed: '+String(e&&(e.errorText||e.message)||r&&r.message||'Unknown error');
        return;
      }
      loadNetworks();
    });
  }

  function exitApp(){
    if(busy)return;
    document.getElementById('state').textContent='Closing WiFi Watch...';
    call('closeApp',{},function(){});
    setTimeout(function(){
      try{window.close();}catch(e){}
    },700);
  }

  function activate(){
    var items,it;
    if(screen==='home'){
      if(focus===0)fixNow('quick');
      else if(focus===1)toggleAutoFix();
      else if(focus===2)loadNetworks();
      else if(focus===3)showDiagnostics();
      else if(focus===4)loadSettings('settings');
      else exitApp();
      return;
    }

    if(screen==='diagnostics'){
      showDiagnostics();return;
    }
    if(screen==='password'){
      if(focus===0)document.getElementById('networkPassword').focus();
      else if(focus===1)submitPassword();
      else setScreen('networkDetail');
      return;
    }
    if(screen==='networks'){
      if(focus===0)loadNetworks();else openNetwork(networks[focus-1]);
      return;
    }
    if(screen==='networkDetail'){
      var action=netActions[focus];if(action)networkAction(action);
      return;
    }

    items=screen==='settings'?simpleItems:advancedItems;
    it=items[focus];

    if(it.action==='advanced'){loadSettings('advanced');return;}
    if(it.action==='fullFix'){setScreen('home');fixNow('full');return;}
    if(it.action==='clearHistory'){
      call('clearHistory',{},function(){refresh();});
      return;
    }
    if(it.action==='reset'){
      savePatch({reset:true});return;
    }
    changeSetting(it,1);
  }

  document.addEventListener('keydown',function(ev){
    var code=ev.keyCode||ev.which,items,max,it;

    if(code===461||code===27){
      if(screen==='advanced')setScreen('settings');
      else if(screen==='networkDetail')setScreen('networks');
      else if(screen==='password'){document.getElementById('networkPassword').value='';setScreen('networkDetail');}
      else if(screen==='settings'||screen==='diagnostics')setScreen('home');
      ev.preventDefault();return;
    }

    if(screen==='home'){
      if(code===37||code===38){focus=(focus+5)%6;renderFocus();ev.preventDefault();}
      else if(code===39||code===40){focus=(focus+1)%6;renderFocus();ev.preventDefault();}
      else if(code===13){activate();ev.preventDefault();}
      return;
    }

    if(screen==='diagnostics'){
      if(code===13){activate();ev.preventDefault();}
      return;
    }

    if(screen==='networks'||screen==='networkDetail'||screen==='password'){
      if(screen==='password'&&document.activeElement===document.getElementById('networkPassword'))return;
      max=screen==='networks'?networks.length+1:(screen==='password'?3:netActions.length);
      if(code===38){focus=(focus-1+max)%max;renderFocus();ev.preventDefault();}
      else if(code===40){focus=(focus+1)%max;renderFocus();ev.preventDefault();}
      else if(code===13){activate();ev.preventDefault();}
      return;
    }
    items=screen==='settings'?simpleItems:advancedItems;max=items.length;
    if(code===38){focus=(focus-1+max)%max;renderFocus();ev.preventDefault();}
    else if(code===40){focus=(focus+1)%max;renderFocus();ev.preventDefault();}
    else if(code===37||code===39){
      it=items[focus];if(!it.action)changeSetting(it,code===39?1:-1);
      ev.preventDefault();
    }else if(code===13){activate();ev.preventDefault();}
  });

  setInterval(function(){
    var d=new Date(),h=d.getHours(),m=d.getMinutes();
    document.getElementById('clock').textContent=(h<10?'0':'')+h+':'+(m<10?'0':'')+m;
  },1000);

  setInterval(function(){if(screen==='home')refresh();},5000);
  renderFocus();
  refresh();
}());
