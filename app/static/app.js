// Theme toggle
const THEME_KEY = 'crosssync_theme';
function applyTheme(mode){
  if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
  else document.documentElement.removeAttribute('data-theme');
}
const themeBtn = document.getElementById('theme-toggle');
let themeMode = localStorage.getItem(THEME_KEY) || 'auto';
applyTheme(themeMode);
if (themeBtn){
  function setIcon(){ themeBtn.textContent = themeMode==='dark'?'🌙': themeMode==='light'?'🌞':'🌗'; themeBtn.title = '主题：' + (themeMode==='auto'?'跟随系统': themeMode==='light'?'浅色':'深色'); }
  setIcon();
  themeBtn.onclick = () => { themeMode = themeMode==='auto'?'light': themeMode==='light'?'dark':'auto'; localStorage.setItem(THEME_KEY, themeMode); applyTheme(themeMode); setIcon(); };
}

// Direction toggle
const dirToPC = document.getElementById('dir-pc');
const dirToIphone = document.getElementById('dir-iphone');
function currentTarget(){ return (dirToPC && dirToPC.checked) ? 'downloads' : 'outbox'; }
// Auto default based on device
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
if (dirToPC && dirToIphone){
  if (isMobile) dirToPC.checked = true; else dirToIphone.checked = true;
}

// Helpers
function h(tag, attrs={}, ...children) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'class') el.className = v; else if (k === 'style') el.style.cssText = v; else el.setAttribute(k, v);
  });
  for (const c of children) el.append(c);
  return el;
}

function formatBytes(bytes) {
  const units = ['B','KB','MB','GB','TB'];
  let i = 0; let num = bytes;
  while (num >= 1024 && i < units.length-1) { num/=1024; i++; }
  return `${num.toFixed(num>=10||i===0?0:1)} ${units[i]}`;
}

// Upload logic
const dzUpload = document.getElementById('dropzone-upload');
const inputUpload = document.getElementById('input-upload');
const listUpload = document.getElementById('upload-list');
const chkOpen = document.getElementById('chk-open');
const chkDateSubdir = document.getElementById('chk-date-subdir');
const chkVerify = document.getElementById('chk-verify');
const btnPauseAll = document.getElementById('btn-pause-all');
const btnResumeAll = document.getElementById('btn-resume-all');
const listDownloads = document.getElementById('downloads-list');
const btnOpenDownloads = document.getElementById('btn-open-downloads');
const btnRefreshDownloads = document.getElementById('btn-refresh-downloads');
const btnDelDlSelected = document.getElementById('btn-del-dl-selected');
const btnClearDl = document.getElementById('btn-clear-dl');
const btnSelectAllDl = document.getElementById('btn-selectall-dl');
const btnSelectNoneDl = document.getElementById('btn-selectnone-dl');
const selbarDl = document.getElementById('selbar-dl');
const selcountDl = document.getElementById('selcount-dl');

const listOutbox = document.getElementById('outbox-list');
const btnDelObSelected = document.getElementById('btn-del-ob-selected');
const btnClearOb = document.getElementById('btn-clear-ob');
const btnOpenOutbox = document.getElementById('btn-open-outbox');
const btnRefreshOutbox = document.getElementById('btn-refresh-outbox');
const btnSelectAllOb = document.getElementById('btn-selectall-ob');
const btnSelectNoneOb = document.getElementById('btn-selectnone-ob');
const selbarOb = document.getElementById('selbar-ob');
const selcountOb = document.getElementById('selcount-ob');

// Simple menu toggles
document.querySelectorAll('[data-menu]')?.forEach(btn => {
  const id = btn.getAttribute('data-menu');
  const menu = document.getElementById(`menu-${id}`);
  if (!menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const visible = menu.style.display === 'block';
    document.querySelectorAll('.menu').forEach(m=>m.style.display='none');
    menu.style.display = visible ? 'none' : 'block';
  });
});
document.addEventListener('click', () => { document.querySelectorAll('.menu').forEach(m=>m.style.display='none'); });

// Persist open-on-finish toggle in localStorage
const OPEN_KEY = 'crosssync_open_on_finish';
chkOpen.checked = localStorage.getItem(OPEN_KEY) === '1';
chkOpen.addEventListener('change', () => localStorage.setItem(OPEN_KEY, chkOpen.checked ? '1' : '0'));
const DATE_SUBDIR_KEY = 'crosssync_date_subdir';
chkDateSubdir.checked = localStorage.getItem(DATE_SUBDIR_KEY) === '1';
chkDateSubdir.addEventListener('change', () => localStorage.setItem(DATE_SUBDIR_KEY, chkDateSubdir.checked ? '1' : '0'));
const VERIFY_KEY = 'crosssync_verify_chunks';
chkVerify.checked = localStorage.getItem(VERIFY_KEY) === '1';
chkVerify.addEventListener('change', () => localStorage.setItem(VERIFY_KEY, chkVerify.checked ? '1' : '0'));

// Global task registry for pause/resume all
window.CS_TASKS = window.CS_TASKS || [];
btnPauseAll && (btnPauseAll.onclick = () => { window.CS_TASKS.forEach(t => t.pause && t.pause()); });
btnResumeAll && (btnResumeAll.onclick = () => { window.CS_TASKS.forEach(t => t.resume && t.resume()); });

// Summary elements and updater
const elActive = document.getElementById('sum-active');
const elCompleted = document.getElementById('sum-completed');
const elFailed = document.getElementById('sum-failed');
const elSpeed = document.getElementById('sum-speed');
const elEta = document.getElementById('sum-eta');
const elSumBar = document.getElementById('sum-bar');
const btnClearFinished = document.getElementById('btn-clear-finished');
let TASK_SEQ = 0;
let lastAggBytes = 0, lastAggTime = performance.now();
function updateSummary(){
  const tasks = window.CS_TASKS;
  let active = 0, completed = 0, failed = 0, total = 0, uploaded = 0;
  tasks.forEach(t => {
    total += t.size || 0;
    uploaded += (t.uploaded || 0);
    if (t.state === 'failed') failed++;
    else if (t.state === 'completed' || t.state === 'cancelled') completed++;
    else active++;
  });
  const now = performance.now();
  const deltaBytes = Math.max(0, uploaded - lastAggBytes);
  const deltaTime = Math.max(0.001, (now - lastAggTime) / 1000);
  const speed = deltaBytes / deltaTime;
  lastAggBytes = uploaded; lastAggTime = now;
  const remaining = Math.max(0, total - uploaded);
  const eta = speed > 0 ? (remaining / speed) : 0;
  elActive && (elActive.textContent = active);
  elCompleted && (elCompleted.textContent = completed);
  elFailed && (elFailed.textContent = failed);
  elSpeed && (elSpeed.textContent = `${formatBytes(speed)}/s`);
  elEta && (elEta.textContent = eta ? `${eta.toFixed(1)}s` : '—');
  const pct = total > 0 ? Math.min(100, (uploaded / total) * 100) : 0;
  elSumBar && (elSumBar.style.width = pct.toFixed(2) + '%');
}
setInterval(updateSummary, 1000);

btnClearFinished && (btnClearFinished.onclick = () => {
  const tasks = window.CS_TASKS;
  const remains = [];
  tasks.forEach(t => {
    if (t.state === 'completed'){
      const el = document.querySelector(`[data-task-id="${t.id}"]`);
      if (el) el.remove();
    } else {
      remains.push(t);
    }
  });
  window.CS_TASKS = remains;
});

function preventDefaults(e){ e.preventDefault(); e.stopPropagation(); }
['dragenter','dragover','dragleave','drop'].forEach(ev => {
  dzUpload.addEventListener(ev, preventDefaults, false);
});
['dragenter','dragover'].forEach(ev => {
  dzUpload.addEventListener(ev, () => dzUpload.classList.add('dragover'));
});
['dragleave','drop'].forEach(ev => {
  dzUpload.addEventListener(ev, () => dzUpload.classList.remove('dragover'));
});

dzUpload.addEventListener('drop', async (e) => {
  const files = await extractDroppedFiles(e.dataTransfer);
  handleFiles(files.length ? files : [...e.dataTransfer.files], currentTarget());
});
inputUpload.addEventListener('change', (e) => handleFiles([...e.target.files], currentTarget()));

function handleFiles(files, target){
  for (const file of files){
    startUpload(file, target);
  }
}

function createItem(name, size){
  const barInner = h('div');
  const sizeSpan = h('span', {class:'muted'}, `0 / ${formatBytes(size)}`);
  const speedSpan = h('span', {class:'muted'}, '0 MB/s');
  const etaSpan = h('span', {class:'muted'}, '—');
  const hashSpan = h('span', {class:'muted'}, '');
  const btnPause = h('button', {class:'tab'}, '暂停');
  const btnResume = h('button', {class:'tab'}, '继续');
  const btnCancel = h('button', {class:'tab'}, '取消');
  btnResume.disabled = true;
  const item = h('div', {class:'item'},
    h('div', {class:'row'}, h('div', {class:'grow'}, name), sizeSpan),
    h('div', {class:'bar'}, barInner),
    h('div', {class:'row'}, speedSpan, etaSpan, h('div', {class:'grow'}, ''), btnPause, btnResume, btnCancel),
    h('div', {class:'row'}, hashSpan)
  );
  return { item, barInner, sizeSpan, speedSpan, etaSpan, hashSpan, btnPause, btnResume, btnCancel };
}

async function startUpload(file, target){
  const ui = createItem(file.name, file.size);
  (target === 'downloads' ? listUpload : listOutbox).prepend(ui.item);

  // Init or resume
  // build name with optional date subdir
  let relName = file.relativePath || file.webkitRelativePath || file.name;
  if (localStorage.getItem(DATE_SUBDIR_KEY) === '1'){
    try {
      const d = new Date(file.lastModified || Date.now());
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      relName = `${y}-${m}-${day}/` + relName.split('/').pop();
    } catch(e){}
  }

  const initRes = await fetch('/api/init-upload', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: relName, size: file.size, chunk_size: DEFAULT_CHUNK, last_modified: file.lastModified, target })
  }).then(r=>r.json());

  const uploadId = initRes.upload_id;
  const chunkSize = initRes.chunk_size;
  const totalChunks = initRes.total_chunks;
  let missing = new Set(initRes.missing);

  const lastChunkSize = file.size - chunkSize * (totalChunks - 1);
  const completedChunks = totalChunks - missing.size;
  const completedFullChunks = Math.max(0, Math.min(completedChunks, totalChunks - 1));
  let uploadedBytes = completedFullChunks * chunkSize;
  if (!missing.has(totalChunks - 1) && totalChunks > 0) {
    uploadedBytes += lastChunkSize;
  }
  let startTime = performance.now();
  let lastBytes = 0;
  let paused = false;
  let cancelled = false;
  const controllers = new Set();

  ui.btnPause.onclick = () => { paused = true; ui.btnPause.disabled = true; ui.btnResume.disabled = false; controllers.forEach(c => { try { c.abort(); } catch(_){} }); };
  ui.btnResume.onclick = () => { paused = false; ui.btnPause.disabled = false; ui.btnResume.disabled = true; };
  ui.btnCancel.onclick = () => { cancelled = true; paused = false; controllers.forEach(c => { try { c.abort(); } catch(_){} }); };

  // Register to global task list
  const taskId = (++TASK_SEQ);
  ui.item.dataset.taskId = String(taskId);
  const task = { id: taskId, pause: ()=>ui.btnPause.onclick(), resume: ()=>ui.btnResume.onclick(), cancel: ()=>ui.btnCancel.onclick(), size: file.size, get uploaded(){ return uploadedBytes; }, state:'active' };
  window.CS_TASKS.push(task);

  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, 4));
  let nextIndex = 0;

  const queue = [];
  for (let i=0;i<concurrency;i++){
    queue.push(worker());
  }

  async function worker(){
    while(true){
      if (cancelled) return;
      while (paused && !cancelled) await new Promise(r=>setTimeout(r, 150));
      let idx = null;
      // find next missing
      while(nextIndex < totalChunks && !missing.has(nextIndex)) nextIndex++;
      if (nextIndex >= totalChunks) return;
      idx = nextIndex++;
      if (!missing.has(idx)) continue;
      const start = idx * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);
      const controller = new AbortController();
      controllers.add(controller);
      // retry with exponential backoff up to 5 times
      let attempt = 0, ok = false, lastErr;
      while(attempt < 5 && !ok){
        try {
          let body = chunk;
          const verify = (localStorage.getItem(VERIFY_KEY) === '1');
          const headers = {};
          if (verify && window.crypto && crypto.subtle){
            const buf = await chunk.arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-256', buf);
            const hex = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
            headers['x-sha256'] = hex;
            body = buf;
          }
          await fetch(`/api/upload/${uploadId}/${idx}`, { method:'PUT', headers, body, signal: controller.signal });
          ok = true;
        } catch (e) {
          lastErr = e;
          if (cancelled) break;
          if (paused) { await new Promise(r=>setTimeout(r,200)); continue; }
          const delay = Math.min(2000, 150 * Math.pow(2, attempt));
          await new Promise(r=>setTimeout(r, delay));
          attempt++;
        }
      }
      controllers.delete(controller);
      if (!ok){ if (cancelled) return; throw lastErr || new Error('upload failed'); }
      missing.delete(idx);
      uploadedBytes += (end - start);
      // update UI
      const elapsed = (performance.now() - startTime) / 1000;
      const speed = uploadedBytes / (elapsed || 1);
      const remain = Math.max(0, file.size - uploadedBytes);
      const eta = remain / (speed || 1);
      const pct = Math.min(100, (uploadedBytes / file.size) * 100);
      ui.barInner.style.width = pct.toFixed(2) + '%';
      ui.sizeSpan.textContent = `${formatBytes(uploadedBytes)} / ${formatBytes(file.size)}`;
      ui.speedSpan.textContent = `${formatBytes(speed)}/s`;
      ui.etaSpan.textContent = `ETA ${eta>0?eta.toFixed(1):0}s`;
    }
  }

  try {
    await Promise.all(queue);
    if (cancelled) { ui.etaSpan.textContent = '已取消'; task.state='cancelled'; return; }
    const open = (localStorage.getItem(OPEN_KEY) === '1');
    const finishRes = await fetch(`/api/finish-upload/${uploadId}?open=${open?1:0}`, { method:'POST' }).then(r=>r.json()).catch(()=>({}));
    ui.barInner.style.width = '100%';
    ui.etaSpan.textContent = '完成';
    if (finishRes && finishRes.sha256){ ui.hashSpan.textContent = 'SHA-256: ' + finishRes.sha256; }
    task.state = 'completed';
    if (target === 'downloads') refreshDownloads(); else refreshOutbox();
  } catch (e) {
    ui.etaSpan.textContent = '失败';
    task.state = 'failed';
  }
}

async function refreshOutbox(){
  const data = await fetch('/api/list/outbox').then(r=>r.json());
  listOutbox.innerHTML = '';
  for (const f of (data.files || [])){
    const id = 'cb-' + Math.random().toString(36).slice(2,8);
    const cb = h('input', {type:'checkbox', id});
    const link = h('a', {href: `/dl/outbox/${encodeURIComponent(f.path)}`}, f.path + ` (${formatBytes(f.size)})`);
    const row = h('div', {class:'item'}, h('div', {class:'row'}, cb, link));
    row.dataset.path = f.path;
    listOutbox.append(row);
  }
  updateSelOb();
}

refreshOutbox();
setInterval(refreshOutbox, 3000);

async function refreshDownloads(){
  const data = await fetch('/api/list/downloads').then(r=>r.json());
  listDownloads.innerHTML = '';
  for (const f of (data.files || [])){
    const id = 'dlcb-' + Math.random().toString(36).slice(2,8);
    const cb = h('input', {type:'checkbox', id});
    const link = h('a', {href: `/dl/downloads/${encodeURIComponent(f.path)}`}, f.path + ` (${formatBytes(f.size)})`);
    const row = h('div', {class:'item'}, h('div', {class:'row'}, cb, link));
    row.dataset.path = f.path;
    listDownloads.append(row);
  }
  updateSelDl();
}
refreshDownloads();
setInterval(refreshDownloads, 4000);

btnOpenDownloads && (btnOpenDownloads.onclick = async () => {
  try { await fetch('/api/open/downloads', {method:'POST'}); } catch(e){}
});
btnRefreshDownloads && (btnRefreshDownloads.onclick = () => refreshDownloads());
btnSelectAllDl && (btnSelectAllDl.onclick = () => { listDownloads.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true); updateSelDl(); });
btnSelectNoneDl && (btnSelectNoneDl.onclick = () => { listDownloads.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false); updateSelDl(); });
document.addEventListener('change', (e)=>{
  if (listDownloads.contains(e.target)) updateSelDl();
  if (listOutbox.contains(e.target)) updateSelOb();
});
function updateSelDl(){
  const count = listDownloads.querySelectorAll('input[type=checkbox]:checked').length;
  selcountDl && (selcountDl.textContent = String(count));
  selbarDl && (selbarDl.style.display = count>0 ? '' : 'none');
}
function updateSelOb(){
  const count = listOutbox.querySelectorAll('input[type=checkbox]:checked').length;
  selcountOb && (selcountOb.textContent = String(count));
  selbarOb && (selbarOb.style.display = count>0 ? '' : 'none');
}
document.getElementById('btn-dl-del-quick')?.addEventListener('click', async ()=>{
  const selected = [...listDownloads.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.closest('.item').dataset.path);
  if (!selected.length) return;
  if (!confirm('确定删除选中的文件吗？')) return;
  await fetch('/api/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ area:'downloads', paths: selected })});
  refreshDownloads();
});
document.getElementById('btn-dl-cancel-sel')?.addEventListener('click', ()=>{ listDownloads.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.checked=false); updateSelDl(); });
document.getElementById('btn-ob-del-quick')?.addEventListener('click', async ()=>{
  const selected = [...listOutbox.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.closest('.item').dataset.path);
  if (!selected.length) return;
  if (!confirm('确定删除选中的共享箱文件吗？')) return;
  await fetch('/api/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ area:'outbox', paths: selected })});
  refreshOutbox();
});
document.getElementById('btn-ob-cancel-sel')?.addEventListener('click', ()=>{ listOutbox.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.checked=false); updateSelOb(); });
btnDelDlSelected && (btnDelDlSelected.onclick = async () => {
  const selected = [...listDownloads.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.closest('.item').dataset.path);
  if (!selected.length) return alert('请先选择文件');
  if (!confirm('确定删除选中的文件吗？')) return;
  await fetch('/api/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ area:'downloads', paths: selected })});
  refreshDownloads();
});
btnClearDl && (btnClearDl.onclick = async () => {
  if (!confirm('确定清空接收目录吗？此操作不可撤销。')) return;
  await fetch('/api/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ area:'downloads' })});
  refreshDownloads();
});

// Notify server that a device opened /app (for desktop auto-redirect)
(function notifyScanned(){
  const m = location.search.match(/[?&]sid=([a-f0-9]+)/);
  if (m) {
    fetch('/api/scanned?sid=' + encodeURIComponent(m[1]), { method:'POST' }).catch(()=>{});
  }
})();

btnDelObSelected && (btnDelObSelected.onclick = async () => {
  const selected = [...listOutbox.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.closest('.item').dataset.path);
  if (!selected.length) return alert('请先选择文件');
  if (!confirm('确定删除选中的共享箱文件吗？')) return;
  await fetch('/api/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ area:'outbox', paths: selected })});
  refreshOutbox();
});
btnClearOb && (btnClearOb.onclick = async () => {
  if (!confirm('确定清空共享箱吗？此操作不可撤销。')) return;
  await fetch('/api/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ area:'outbox' })});
  refreshOutbox();
});

// Try to read directories from DataTransfer (desktop Chrome/Edge/Safari)
async function extractDroppedFiles(dt){
  const items = dt && dt.items ? dt.items : [];
  const out = [];
  const pending = [];
  for (let i=0; i<items.length; i++){
    const it = items[i];
    const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
    if (!entry) continue;
    pending.push(traverse(entry, ''));
  }
  await Promise.all(pending);
  return out;

  function fileFromEntry(entry, path){
    return new Promise((resolve) => {
      entry.file((file) => {
        Object.defineProperty(file, 'relativePath', { value: path + file.name });
        out.push(file);
        resolve();
      }, () => resolve());
    });
  }
  async function traverse(entry, path){
    if (entry.isFile){
      await fileFromEntry(entry, path);
    } else if (entry.isDirectory){
      const reader = entry.createReader();
      await new Promise((res) => {
        const read = () => reader.readEntries(async (entries) => {
          if (!entries.length) return res();
          for (const e of entries){
            await traverse(e, path + entry.name + '/');
          }
          read();
        });
        read();
      });
    }
  }
}
btnOpenOutbox && (btnOpenOutbox.onclick = async () => { try { await fetch('/api/open/outbox', {method:'POST'});} catch(e){} });
btnRefreshOutbox && (btnRefreshOutbox.onclick = () => refreshOutbox());
btnSelectAllOb && (btnSelectAllOb.onclick = () => { listOutbox.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true); });
btnSelectNoneOb && (btnSelectNoneOb.onclick = () => { listOutbox.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false); });
