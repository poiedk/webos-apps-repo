(function(){
  var SVC='luna://org.webosbrew.wifiwatch.service/';
  function call(method, params, cb){
    try {
      var bridge=new PalmServiceBridge();
      bridge.onservicecallback=function(raw){
        var r; try{r=JSON.parse(raw);}catch(e){return cb&&cb(e);}
        if(r.returnValue===false) return cb&&cb(r);
        cb&&cb(null,r);
      };
      bridge.call(SVC+method, JSON.stringify(params||{}));
    } catch(e){ cb&&cb(e); }
  }
  function fmt(n){ if(n===undefined||n===null) return '—'; return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,','); }
  function render(r){
    document.getElementById('state').textContent=r.state||'Unknown';
    document.getElementById('dot').className='dot '+(r.state==='Connected'?'ok':(r.state==='Problem'?'fail':'warn'));
    document.getElementById('ssid').textContent=r.ssid||'—'; document.getElementById('ip').textContent=r.ip||'—';
    document.getElementById('gateway').textContent='Gateway '+(r.gateway||'—'); document.getElementById('latency').textContent=r.latencyMs!=null?r.latencyMs+' ms':'—';
    document.getElementById('rxPackets').textContent=fmt(r.rxPackets); document.getElementById('rxDropped').textContent=fmt(r.rxDropped);
    document.getElementById('lastFailure').textContent=r.lastFailure||'Never'; document.getElementById('assoc').textContent=r.association||'—';
    document.getElementById('connman').textContent=r.connman||'—'; document.getElementById('monitor').textContent=r.monitoring?'Running':'Stopped';
    document.getElementById('monitorToggle').textContent=r.monitoring?'Stop monitoring':'Start monitoring';
  }
  function refresh(){call('status',{},function(e,r){if(!e)render(r);});}
  document.getElementById('refresh').onclick=refresh;
  document.getElementById('monitorToggle').onclick=function(){call('toggleMonitor',{},function(){refresh();});};
  document.getElementById('diagnostics').onclick=function(){call('diagnostics',{},function(e,r){var p=document.getElementById('diag');p.classList.remove('hidden');p.textContent=e?JSON.stringify(e):r.text;});};
  document.getElementById('settings').onclick=function(){alert('v0.1: fixed 5 s checks, 3 failures, 2 MB rotating log. Advanced settings come next.');};
  document.addEventListener('keydown',function(ev){ if(ev.keyCode===461){ var p=document.getElementById('diag'); if(!p.classList.contains('hidden')){p.classList.add('hidden');ev.preventDefault();return;} window.close(); }});
  setInterval(function(){document.getElementById('clock').textContent=new Date().toLocaleTimeString();},1000);
  setInterval(refresh,5000); refresh();
})();
