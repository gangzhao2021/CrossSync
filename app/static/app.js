// Basic tab switching
const tabUpload = document.getElementById('tab-upload');
const tabOutbox = document.getElementById('tab-outbox');
const panelUpload = document.getElementById('panel-upload');
const panelOutbox = document.getElementById('panel-outbox');

tabUpload.addEventListener('click', () => {
  tabUpload.classList.add('active');
  tabOutbox.classList.remove('active');
  panelUpload.style.display = '';
  panelOutbox.style.display = 'none';
});
tabOutbox.addEventListener('click', () => {
  tabOutbox.classList.add('active');
  tabUpload.classList.remove('active');
  panelOutbox.style.display = '';
  panelUpload.style.display = 'none';
});

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
const listDownloads = document.getElementById('downloads-list');
const btnOpenDownloads = document.getElementById('btn-open-downloads');
const btnRefreshDownloads = document.getElementById('btn-refresh-downloads');
const btnDelDlSelected = document.getElementById('btn-del-dl-selected');
const btnClearDl = document.getElementById('btn-clear-dl');

const dzOutbox = document.getElementById('dropzone-outbox');
const inputOutbox = document.getElementById('input-outbox');
const listOutbox = document.getElementById('outbox-list');
const btnZipSelected = document.getElementById('btn-zip-selected');
const btnZipAll = document.getElementById('btn-zip-all');
const btnDelObSelected = document.getElementById('btn-del-ob-selected');
const btnClearOb = document.getElementById('btn-clear-ob');

// Persist open-on-finish toggle in localStorage
const OPEN_KEY = 'crosssync_open_on_finish';
chkOpen.checked = localStorage.getItem(OPEN_KEY) === '1';
chkOpen.addEventListener('change', () => localStorage.setItem(OPEN_KEY, chkOpen.checked ? '1' : '0'));

function preventDefaults(e){ e.preventDefault(); e.stopPropagation(); }
['dragenter','dragover','dragleave','drop'].forEach(ev => {
  dzUpload.addEventListener(ev, preventDefaults, false);
  dzOutbox.addEventListener(ev, preventDefaults, false);
});
['dragenter','dragover'].forEach(ev => {
  dzUpload.addEventListener(ev, () => dzUpload.classList.add('dragover'));
  dzOutbox.addEventListener(ev, () => dzOutbox.classList.add('dragover'));
});
['dragleave','drop'].forEach(ev => {
  dzUpload.addEventListener(ev, () => dzUpload.classList.remove('dragover'));
  dzOutbox.addEventListener(ev, () => dzOutbox.classList.remove('dragover'));
});

dzUpload.addEventListener('drop', async (e) => {
  const files = await extractDroppedFiles(e.dataTransfer);
  handleFiles(files.length ? files : [...e.dataTransfer.files], 'downloads');
});
dzOutbox.addEventListener('drop', async (e) => {
  const files = await extractDroppedFiles(e.dataTransfer);
  handleFiles(files.length ? files : [...e.dataTransfer.files], 'outbox');
});
inputUpload.addEventListener('change', (e) => handleFiles([...e.target.files], 'downloads'));
inputOutbox.addEventListener('change', (e) => handleFiles([...e.target.files], 'outbox'));

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
  const btnPause = h('button', {class:'tab'}, '暂停');
  const btnResume = h('button', {class:'tab'}, '继续');
  const btnCancel = h('button', {class:'tab'}, '取消');
  btnResume.disabled = true;
  const item = h('div', {class:'item'},
    h('div', {class:'row'}, h('div', {class:'grow'}, name), sizeSpan),
    h('div', {class:'bar'}, barInner),
    h('div', {class:'row'}, speedSpan, etaSpan, h('div', {class:'grow'}, ''), btnPause, btnResume, btnCancel)
  );
  return { item, barInner, sizeSpan, speedSpan, etaSpan, btnPause, btnResume, btnCancel };
}

async function startUpload(file, target){
  const ui = createItem(file.name, file.size);
  (target === 'downloads' ? listUpload : listOutbox).prepend(ui.item);

  // Init or resume
  const initRes = await fetch('/api/init-upload', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: file.relativePath || file.webkitRelativePath || file.name, size: file.size, chunk_size: DEFAULT_CHUNK, last_modified: file.lastModified, target })
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
      try {
        await fetch(`/api/upload/${uploadId}/${idx}`, { method:'PUT', body: chunk, signal: controller.signal });
      } catch (e) {
        controllers.delete(controller);
        if (cancelled) return; // stop
        if (paused) continue; // retry on resume
        throw e; // unexpected error
      }
      controllers.delete(controller);
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

  await Promise.all(queue);
  if (cancelled) { ui.etaSpan.textContent = '已取消'; return; }
  const open = (localStorage.getItem(OPEN_KEY) === '1');
  await fetch(`/api/finish-upload/${uploadId}?open=${open?1:0}`, { method:'POST' });
  ui.barInner.style.width = '100%';
  ui.etaSpan.textContent = '完成';
  if (target === 'downloads') refreshDownloads(); else refreshOutbox();
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
}
refreshDownloads();
setInterval(refreshDownloads, 4000);

btnOpenDownloads && (btnOpenDownloads.onclick = async () => {
  try { await fetch('/api/open/downloads', {method:'POST'}); } catch(e){}
});
btnRefreshDownloads && (btnRefreshDownloads.onclick = () => refreshDownloads());
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

btnZipAll.onclick = () => {
  window.location.href = '/dl/outbox.zip';
};
btnZipSelected.onclick = () => {
  const selected = [...listOutbox.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.closest('.item').dataset.path);
  if (!selected.length) return alert('请先选择文件');
  const q = selected.map(p => 'paths=' + encodeURIComponent(p)).join('&');
  window.location.href = '/dl/outbox.zip?' + q;
};
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
