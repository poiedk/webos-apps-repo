(function(){
  var SVC='luna://org.webosbrew.wifiwatch.service/';
  var screen='home',focus=0,current={},settings=null,busy=false;

  var simpleItems=[
    {k:'autoMonitor',label:'Auto monitoring',hint:'Start monitoring automatically after service launch',type:'bool'},
    {k:'intervalSec',label:'Check interval',hint:'How often WiFi Watch tests the connection',type:'cycle',vals:[5,10,15,30],suffix:' sec'},
    {k:'failureThreshold',label:'Failure threshold',hint:'Consecutive failed checks before Problem state',type:'cycle',vals:[1,2,3,5]},
    {action:'advanced',label:'Advanced settings',hint:'Interface, ping timeout and log controls',value:'OPEN'}
  ];

  var advancedItems=[
    {k:'iface',label:'Network interface',hint:'Interface used for Wi-Fi monitoring',type:'cycle',vals:['wlan0','eth0']},
    {k:'pingTimeout',label:'Ping timeout',hint:'Gateway ping timeout',type:'cycle',vals:[1,2,3],suffix:' sec'},
    {k:'logSizeMB',label:'Log size',hint:'Rotate the diagnostic log after this size',type:'cycle',vals:[1,2,5],suffix:' MB'},
    {action:'clearLog',label:'Clear diagnostic log',hint:'Delete the current and rotated logs',value:'CLEAR',danger:true},
    {action:'reset',label:'Reset defaults',hint:'Restore default WiFi Watch settings',value:'RESET',danger:true}
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

  function formatCheckTime(v){
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
    var msg=(e&&(e.errorText||e.errorCode||e.message))||'Background service is not running';
    document.getElementById('ssid').textContent=String(msg);
    document.getElementById('monitor').textContent='Unavailable';
  }

  function renderStatus(r){
    current=r||{};
    var badge=document.getElementById('stateBadge');
    var state=r.state||'Unknown';
    document.getElementById('state').textContent=state;
    badge.className='badge '+(state==='Connected'?'ok':(state==='Problem'?'fail':(state==='Degraded'?'warn':'idle')));
    badge.textContent=state==='Connected'?'OK':(state==='Problem'?'ERR':(state==='Degraded'?'WARN':'--'));
    document.getElementById('ssid').textContent=(r.ssid||'No SSID')+' | checked '+formatCheckTime(r.lastCheck);
    document.getElementById('ip').textContent=r.ip||'--';
    document.getElementById('gateway').textContent='Gateway '+(r.gateway||'--');
    document.getElementById('latency').textContent=r.latencyMs!=null?r.latencyMs+' ms':'--';
    document.getElementById('rxPackets').textContent=fmt(r.rxPackets);
    document.getElementById('rxDropped').textContent=fmt(r.rxDropped);
    document.getElementById('failures').textContent=fmt(r.failureCount||0);
    document.getElementById('iface').textContent=r.iface||'--';
    document.getElementById('assoc').textContent=r.association||'--';
    document.getElementById('connman').textContent=r.connman||'--';
    document.getElementById('monitor').textContent=r.monitoring?'Running':'Stopped';
    document.getElementById('monitorAction').textContent=r.monitoring?'Stop monitor':'Start monitor';
  }

  function refresh(){
    if(busy)return;
    call('status',{},function(e,r){if(e)renderServiceError(e);else renderStatus(r);});
  }

  function setScreen(id){
    document.getElementById('home').className='screen home'+(id==='home'?' active':'');
    document.getElementById('diagnosticsScreen').className='screen page'+(id==='diagnostics'?' active':'');
    document.getElementById('settingsScreen').className='screen page'+(id==='settings'?' active':'');
    document.getElementById('advancedScreen').className='screen page'+(id==='advanced'?' active':'');
    screen=id;focus=0;renderFocus();
  }

  function renderFocus(){
    var i,a;
    if(screen==='home'){
      a=document.querySelectorAll('#home .action');
      for(i=0;i<a.length;i++)a[i].className='action'+(i===focus?' focus':'')+(i===a.length-1?' last':'');
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

  function savePatch(patch){
    call('setSettings',{settings:patch},function(e,r){
      if(!e&&r.settings){settings=r.settings;renderFocus();refresh();}
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

  function showDiagnostics(){
    setScreen('diagnostics');
    document.getElementById('diag').textContent='Loading diagnostics...';
    call('diagnostics',{},function(e,r){
      document.getElementById('diag').textContent=e?('Diagnostics error: '+JSON.stringify(e)):(r.text||'No diagnostic data');
    });
  }

  function exitApp(){
    if(busy)return;
    call('closeApp',{},function(){});
  }

  function activate(){
    var items,it;
    if(screen==='home'){
      if(focus===0)refresh();
      else if(focus===1)call('toggleMonitor',{},function(e){if(e)renderServiceError(e);else refresh();});
      else if(focus===2)showDiagnostics();
      else if(focus===3)loadSettings('settings');
      else exitApp();
      return;
    }

    if(screen==='diagnostics'){
      showDiagnostics();return;
    }

    items=screen==='settings'?simpleItems:advancedItems;
    it=items[focus];

    if(it.action==='advanced'){loadSettings('advanced');return;}
    if(it.action==='clearLog'){
      call('clearLog',{},function(){document.getElementById('diag').textContent='';});
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
      else if(screen==='settings'||screen==='diagnostics')setScreen('home');
      ev.preventDefault();return;
    }

    if(screen==='home'){
      if(code===37||code===38){focus=(focus+4)%5;renderFocus();ev.preventDefault();}
      else if(code===39||code===40){focus=(focus+1)%5;renderFocus();ev.preventDefault();}
      else if(code===13){activate();ev.preventDefault();}
      return;
    }

    if(screen==='diagnostics'){
      if(code===13){activate();ev.preventDefault();}
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
  renderFocus();refresh();
}());
