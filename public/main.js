// CrossSync client - clean minimal implementation
;(function(){
  var $ = function(id){ return document.getElementById(id); };

  var ui = {
    setStatus: function(text){
      var el = $('connectionStatus'); if(!el) return;
      var dot = $('connectionIndicator');
      if (dot) { el.innerHTML=''; el.appendChild(dot); el.appendChild(document.createTextNode(' '+text)); }
      else { el.textContent = text; }
    },
    setIndicator: function(state){
      var dot = $('connectionIndicator'); if(!dot) return;
      dot.classList.remove('connected','connecting','offline');
      if (state) dot.classList.add(state);
    },
    setRoomId: function(id){ var el=$('roomId'); if(el) el.textContent=id; },
    renderQR: function(roomId, data){
      var qr = $('qrContainer'); if(!qr) return;
      qr.innerHTML = '<img src="'+data.qrCode+'" alt="QR Code" style="max-width:220px;">'
                   + '<p style="margin-top:10px;font-size:0.9rem;color:#64748b;">用另一台设备扫描加入</p>';
    },
    showTransfer: function(){ var s=$('fileTransfer'); if(s) s.style.display='block'; },
    setDeviceOnline: function(){ var b=$('deviceStatus'); if(b){ b.className='badge badge-online'; b.textContent='在线'; } },
    collapseConnection: function(){ var c=$('connectionArea'); if(c){ c.style.display='none'; } },
    setConnectedDeviceTitle: function(text){ var t=$('connectTitle'); if(t) t.textContent=text; var n=$('deviceName'); if(n) n.textContent=text; }
  };

  function detectName(){
    var ua = navigator.userAgent.toLowerCase();
    if(/iphone|ipad|ipod/.test(ua)) return (/ipad/.test(ua)?'iPad':'iPhone');
    if(/android/.test(ua)) return 'Android';
    if(/windows/.test(ua)) return 'Windows';
    if(/macintosh|mac os x/.test(ua)) return 'Mac';
    return 'Device';
  }

  function fetchQR(roomId){
    return fetch('/api/qr/'+roomId).then(function(r){ if(!r.ok) throw new Error('qr'); return r.json(); });
  }

  var App = window.App = { downloadItems: [], pendingFiles: [],
    socket: null,
    roomId: null,
    rtcConfig: { iceServers: [{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}] },
    peerConnections: new Map(),
    dataChannels: new Map(),
    receivingFiles: new Map(),
    peerNames: new Map(),

    init: function(){
      var self=this;
      // expose minimal actions to inline buttons
      window.app = {
        manualReconnect: function(){ try{ self.socket && self.socket.connect(); }catch(e){} },
        resetConnection: function(){ location.reload(); },
        copyRoomId: function(){ var id=($('roomId')?$('roomId').textContent:'').trim(); if(!id||id==='-')return; navigator.clipboard.writeText(id).catch(function(){}); }
      };

      // Help/About modal
      var helpBtn=$('helpBtn'), aboutBtn=$('aboutBtn'), helpModal=$('helpModal'), closeHelp=$('closeHelp');
      if(helpBtn&&helpModal) helpBtn.addEventListener('click', function(e){ e.preventDefault(); helpModal.style.display='block'; });
      if(closeHelp&&helpModal) closeHelp.addEventListener('click', function(){ helpModal.style.display='none'; });
      if(helpModal) helpModal.addEventListener('click', function(e){ if(e.target===helpModal) helpModal.style.display='none'; });
      if(aboutBtn) aboutBtn.addEventListener('click', function(e){ e.preventDefault(); alert('CrossSync\n跨平台文件直连传输'); });

      // File inputs
      var fileInput=$('fileInput'), selectBtn=$('selectBtn'), uploadArea=$('uploadArea');
      if(selectBtn && fileInput) selectBtn.addEventListener('click', function(){ fileInput.click(); });
      if(fileInput) fileInput.addEventListener('change', function(e){ var fs=e.target.files; if(fs&&fs.length) self.processFiles(fs); });
      if(uploadArea){
        uploadArea.addEventListener('dragover', function(e){ e.preventDefault(); uploadArea.classList.add('dragover'); });
        uploadArea.addEventListener('dragleave', function(e){ e.preventDefault(); uploadArea.classList.remove('dragover'); });
        uploadArea.addEventListener('drop', function(e){ e.preventDefault(); uploadArea.classList.remove('dragover'); var fs=e.dataTransfer && e.dataTransfer.files; if(fs&&fs.length) self.processFiles(fs); });
        uploadArea.addEventListener('click', function(){ if(fileInput) fileInput.click(); });
        uploadArea.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); if(fileInput) fileInput.click(); }});
      }

      var zipBtn=$('zipAllBtn'); if(zipBtn){ zipBtn.addEventListener('click', function(){ App.zipAndDownloadAll(); }); }
      var clearBtn=$('clearReceivedBtn'); if(clearBtn){ clearBtn.addEventListener('click', function(){ App.clearReceived(); }); }

      // Socket
      this.socket = io();
      this.socket.on('connect', function(){ ui.setStatus('已连接服务器'); ui.setIndicator('connecting'); self.socket.emit('register-device',{name:detectName()}); });
      this.socket.on('device-registered', function(){ var p=new URLSearchParams(location.search); var rm=p.get('room'); if(rm) self.joinRoom(rm); else self.createRoom(); });
      this.socket.on('room-created', function(o){ self.roomId=o.roomId; ui.setRoomId(o.roomId); try{ var u=new URL(location.href); u.searchParams.set('room',o.roomId); history.replaceState(null,'',u.toString()); }catch(e){} ui.setStatus('等待对端扫码加入...'); ui.setIndicator('connecting'); ui.showTransfer(); fetchQR(o.roomId).then(function(d){ ui.renderQR(o.roomId,d); }).catch(function(){ ui.setStatus('二维码生成失败'); }); });
      this.socket.on('room-joined', function(o){ self.roomId=o.roomId; ui.setRoomId(o.roomId); ui.setStatus('已加入房间，正在连接...'); ui.setIndicator('connecting'); ui.showTransfer(); var qr=$('qrContainer'); if(qr) qr.innerHTML=''; });
      this.socket.on('room-devices-updated', function(payload){ var list=(payload&&payload.devices)||[]; self.updatePeerNames(list); self.autoConnectToPeers(list); });
      this.socket.on('webrtc-offer', function(d){ self.handleOffer(d); });
      this.socket.on('webrtc-answer', function(d){ self.handleAnswer(d); });
      this.socket.on('webrtc-ice-candidate', function(d){ self.handleIce(d); });
    },

    createRoom: function(){ this.socket.emit('create-room'); ui.setStatus('正在创建房间...'); ui.setIndicator('connecting'); },
    joinRoom: function(roomId){ this.socket.emit('join-room',{roomId:roomId}); ui.setStatus('正在加入房间 '+roomId+'...'); ui.setIndicator('connecting'); },

    updatePeerNames: function(devices){ var self=this; (devices||[]).forEach(function(d){ if(d && d.id) self.peerNames.set(d.id, d.name||'设备'); }); },
    updateConnectedLabel: function(){ var names=[]; var self=this; this.dataChannels.forEach(function(dc,id){ if(dc && dc.readyState==='open'){ var nm=self.peerNames.get(id); if(nm) names.push(nm); }}); if(names.length){ var text= names.length===1? ('已连接设备：'+names[0]) : ('已连接设备（'+names.length+' 台）'); ui.setConnectedDeviceTitle(text); } else { ui.setConnectedDeviceTitle('连接设备'); } },
    shouldInitiate: function(peerId){ try{ return String(this.socket.id) < String(peerId); }catch(e){ return true; } },
    autoConnectToPeers: function(devs){ var self=this; var ids=(devs||[]).map(function(d){return d.id;}).filter(function(id){ return id && self.socket && id!==self.socket.id; }); if(ids.length===0) return; ids.forEach(function(id){ var dc=self.dataChannels.get(id); var ok= dc && dc.readyState==='open'; if(!ok && self.shouldInitiate(id)){ ui.setStatus('正在连接...'); ui.setIndicator('connecting'); self.connectToDevice(id); } }); },

    connectToDevice: function(targetId){ if(!targetId || this.peerConnections.has(targetId)) return; var self=this; var pc=new RTCPeerConnection(this.rtcConfig); this.peerConnections.set(targetId,pc); var dc=pc.createDataChannel('file',{ordered:true}); this.setupDataChannel(dc,targetId); this.dataChannels.set(targetId,dc); pc.onicecandidate=function(ev){ if(ev.candidate) self.socket.emit('webrtc-ice-candidate',{targetId:targetId,candidate:ev.candidate}); }; pc.onconnectionstatechange=function(){ if(pc.connectionState==='connected'){ ui.setStatus('已连接，可开始传输'); ui.setIndicator('connected'); ui.collapseConnection(); self.updateConnectedLabel(); } else if(pc.connectionState==='disconnected'||pc.connectionState==='failed'){ ui.setIndicator('offline'); self.updateConnectedLabel(); } }; ui.setIndicator('connecting'); pc.createOffer().then(function(of){ return pc.setLocalDescription(of).then(function(){return of;}); }).then(function(of){ self.socket.emit('webrtc-offer',{targetId:targetId, offer:of}); }).catch(function(e){ console.error('createOffer failed',e); }); },

    handleOffer: function(payload){ var sourceId=payload&&payload.sourceId, offer=payload&&payload.offer; if(!sourceId||!offer) return; var self=this; var pc=new RTCPeerConnection(this.rtcConfig); this.peerConnections.set(sourceId,pc); pc.ondatachannel=function(ev){ var dc=ev.channel; self.setupDataChannel(dc,sourceId); self.dataChannels.set(sourceId,dc); }; pc.onicecandidate=function(ev){ if(ev.candidate) self.socket.emit('webrtc-ice-candidate',{targetId:sourceId,candidate:ev.candidate}); }; pc.onconnectionstatechange=function(){ if(pc.connectionState==='connected'){ ui.setStatus('已连接，可开始传输'); ui.setIndicator('connected'); ui.collapseConnection(); self.updateConnectedLabel(); } else if(pc.connectionState==='disconnected'||pc.connectionState==='failed'){ ui.setIndicator('offline'); self.updateConnectedLabel(); } }; pc.setRemoteDescription(offer).then(function(){ return pc.createAnswer(); }).then(function(ans){ return pc.setLocalDescription(ans).then(function(){return ans;}); }).then(function(ans){ self.socket.emit('webrtc-answer',{targetId:sourceId, answer:ans}); }).catch(function(e){ console.error('handleOffer failed',e); }); },

    handleAnswer: function(payload){ var sourceId=payload&&payload.sourceId, ans=payload&&payload.answer; var pc=this.peerConnections.get(sourceId); if(pc) pc.setRemoteDescription(ans).catch(function(e){ console.error('setRemoteDescription(answer) failed',e); }); },
    handleIce: function(payload){ var sourceId=payload&&payload.sourceId, cand=payload&&payload.candidate; var pc=this.peerConnections.get(sourceId); if(pc) pc.addIceCandidate(cand).catch(function(e){ console.error('addIceCandidate failed',e); }); },
    setupDataChannel: function(dc, peerId){ var self=this; dc._busy=false; dc.onopen=function(){ ui.setStatus('已连接，可开始传输'); ui.setIndicator('connected'); ui.showTransfer(); ui.setDeviceOnline(); ui.collapseConnection(); self.updateConnectedLabel(); self.flushPending(); }; dc.onclose=function(){ dc._busy=false; ui.setIndicator('offline'); self.updateConnectedLabel(); }; dc.onerror=function(){ dc._busy=false; ui.setIndicator('offline'); }; dc.onmessage=function(ev){ self.onDataMessage(ev,peerId); }; },

    processFiles: function(fileList){ var files = Array.prototype.slice.call(fileList||[]); if(!files.length) return; var dc=null, targetId=null; var self=this; this.dataChannels.forEach(function(v,k){ if(!dc && v && v.readyState==='open'){ dc=v; targetId=k; } }); if(!dc){ // 缓存到队列，待连接后发送
        Array.prototype.push.apply(this.pendingFiles, files);
        ui.setStatus('已添加到队列，连接后自动发送');
        return; }
      files.forEach(function(f,i){ setTimeout(function(){ self.sendFile(dc,targetId,f); }, i*100); }); },

    flushPending: function(){ if(!this.pendingFiles.length) return; var dc=null, targetId=null, self=this; this.dataChannels.forEach(function(v,k){ if(!dc && v && v.readyState==='open'){ dc=v; targetId=k; } }); if(!dc) return; var files=this.pendingFiles.splice(0); files.forEach(function(f,i){ setTimeout(function(){ self.sendFile(dc,targetId,f); }, i*100); }); },
    sendFile: function(dc, peerId, file){ if(dc._busy){ var self=this; return void setTimeout(function(){ self.sendFile(dc,peerId,file); },500); } dc._busy=true; var self=this; var chunkSize=64*1024, offset=0, index=0; var fileId=peerId+'_'+Date.now()+'_'+Math.random().toString(36).slice(2); dc.send(JSON.stringify({type:'file-info', fileId:fileId, name:file.name, size:file.size, totalChunks:Math.ceil(file.size/chunkSize)})); var reader=new FileReader(); var update=function(){ self.showFileProgress(file.name, Math.round((offset/file.size)*100)); }; reader.onload=function(){ var buf=reader.result; dc.send(JSON.stringify({type:'file-chunk-header', fileId:fileId, chunkIndex:index, chunkSize:buf.byteLength})); dc.send(buf); offset += buf.byteLength; index++; update(); if(offset<file.size){ if(dc.bufferedAmount>512*1024) setTimeout(readNext,50); else readNext(); } else { dc.send(JSON.stringify({type:'file-end', fileId:fileId})); dc._busy=false; self.showFileProgress(file.name,100); } }; reader.onerror=function(){ dc._busy=false; alert('读取文件失败'); }; var readNext=function(){ var slice=file.slice(offset, Math.min(offset+chunkSize,file.size)); reader.readAsArrayBuffer(slice); }; update(); readNext(); },
    onDataMessage: function(ev, peerId){ var data=ev.data; var self=this; if(typeof data==='string'){ try{ var msg=JSON.parse(data); if(msg.type==='file-info'){ self.receivingFiles.set(msg.fileId,{name:msg.name,size:msg.size,total:msg.totalChunks,chunks:[],received:0,expect:null}); self.showReceivedFile(msg.name,0); } else if(msg.type==='file-chunk-header'){ var f=self.receivingFiles.get(msg.fileId); if(!f) return; f.expect={index:msg.chunkIndex,size:msg.chunkSize}; } else if(msg.type==='file-end'){ var f2=self.receivingFiles.get(msg.fileId); if(!f2) return; var blob=new Blob(f2.chunks,{type:'application/octet-stream'}); var url=URL.createObjectURL(blob); self.addReceivedFile(f2.name,f2.size,url); if(!self.downloadItems) self.downloadItems=[]; self.downloadItems.push({name:f2.name,url:url,size:f2.size}); self.showReceivedFile(f2.name,100); self.receivingFiles.delete(msg.fileId); } }catch(e){} } else { var matched=false; self.receivingFiles.forEach(function(f,fid){ if(!matched && f.expect && data.byteLength===f.expect.size){ f.chunks[f.expect.index]=new Uint8Array(data); f.received+=1; var p=Math.round((f.received/f.total)*100); self.showReceivedFile(f.name,p); f.expect=null; matched=true; } }); if(!matched) console.warn('unmatched binary chunk'); } },
    showFileProgress: function(fileName, progress){ var area=$('progressArea'), fill=$('progressFill'), text=$('progressText'), name=$('fileName'); if(!area||!fill||!text||!name) return; area.style.display='block'; name.textContent=fileName; fill.style.width=progress+'%'; text.textContent=progress+'%'; if(progress>=100) setTimeout(function(){ area.style.display='none'; },1500); },
    showReceivedFile: function(fileName, progress){ var area=$('progressArea'), fill=$('progressFill'), text=$('progressText'), name=$('fileName'); if(!area||!fill||!text||!name) return; area.style.display='block'; name.textContent='接收: '+fileName; fill.style.width=progress+'%'; fill.style.backgroundColor='#28a745'; text.textContent=progress+'%'; if(progress>=100) setTimeout(function(){ area.style.display='none'; fill.style.backgroundColor=''; },1500); },
    addReceivedFile: function(fileName, size, url){ var panel=$('receivedFiles'), list=$('filesList'); if(panel) panel.style.display='block'; if(!list) return; var div=document.createElement('div'); div.className='file-item'; div.innerHTML = '<div class="file-info">' + '<div class="file-details"><h4>'+fileName+'</h4><div class="file-size">'+(size/1024/1024).toFixed(2)+' MB</div></div></div>' + '<button class="download-btn">下载</button>'; div.querySelector('.download-btn').addEventListener('click', function(){ var a=document.createElement('a'); a.href=url; a.download=fileName; document.body.appendChild(a); a.click(); setTimeout(function(){ document.body.removeChild(a); },200); }); list.insertBefore(div, list.firstChild); if(!App.downloadItems) App.downloadItems=[]; App.downloadItems.push({name:fileName, url:url, size:size}); }
  };

  // ZIP & Clear actions
  App.zipAndDownloadAll = function(){ if(!window.JSZip){ alert('JSZip 未加载'); return; } var items=(this.downloadItems||[]).slice(); if(items.length===0){ alert('暂无可打包的文件'); return; } var zip=new JSZip(); var addOne=function(it){ return fetch(it.url).then(function(r){ return r.blob(); }).then(function(b){ zip.file(it.name,b); }); }; var seq=Promise.resolve(); items.forEach(function(it){ seq=seq.then(function(){ return addOne(it); }); }); seq.then(function(){ return zip.generateAsync({type:'blob'}); }).then(function(blob){ var url=URL.createObjectURL(blob); var a=document.createElement('a'); a.href=url; var ts=new Date().toISOString().replace(/[:.]/g,'-'); a.download='CrossSync-'+ts+'.zip'; document.body.appendChild(a); a.click(); setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); },500); }).catch(function(e){ console.error('zip error',e); alert('打包失败'); }); };

  App.clearReceived = function(){
    try{
      (this.downloadItems||[]).forEach(function(it){
        if(it && typeof it.url==='string' && it.url.indexOf('blob:')===0){
          try{ URL.revokeObjectURL(it.url); }catch(e){}
        }
      });
    }catch(e){}
    var list=$('filesList'); if(list){ while(list.firstChild){ list.removeChild(list.firstChild); } }
    this.downloadItems=[]; var panel=$('receivedFiles'); if(panel) panel.style.display='none';
  };

  document.addEventListener('DOMContentLoaded', function(){ App.init(); });
})();

// Legacy compatibility
if (window.App) {
  window.App.downloadAll = function(){ window.App.zipAndDownloadAll(); };
}
