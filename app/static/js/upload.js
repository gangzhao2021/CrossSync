// CrossSync web client: Transfer direction, runtime config, upload queue (chunked and streamed),
// file selection and drag-and-drop.
// Loaded as ordered classic scripts that share one global scope; see app.html.

const isMobileApple = isAppleMobile();
let currentDirection = 'downloads';

function currentTarget() {
  return els.dirToPC?.checked ? 'downloads' : 'outbox';
}

function setDirection(target) {
  currentDirection = target;
  if (els.dirToPC) els.dirToPC.checked = target === 'downloads';
  if (els.dirToIphone) els.dirToIphone.checked = target === 'outbox';

  if (target === 'downloads') {
    if (els.transferTitle) els.transferTitle.textContent = '手机照片，直接保存到电脑';
    if (els.directionCopy) {
      els.directionCopy.textContent = runtimeConfig.isHostDevice
        ? '手机上传会直接落到下方保存位置，无需在电脑再次下载。'
        : '选好后会自动传到电脑的接收文件夹，无需再让电脑下载一遍。';
    }
    if (els.dropTitle) els.dropTitle.textContent = '发送到电脑';
    if (els.dropSubtitle) els.dropSubtitle.textContent = '返回本页后立即上传，常亮守护会从这时开始。';
    if (els.pickerNote) {
      els.pickerNote.hidden = !isMobileApple;
      els.pickerNote.textContent = '若选完后相册仍停留，通常是 iOS 正在下载或准备原片；此时网页尚未收到文件。';
    }
  } else {
    if (els.transferTitle) els.transferTitle.textContent = '把电脑文件放进 iPhone 共享箱';
    if (els.directionCopy) els.directionCopy.textContent = '选择电脑文件，放入 iPhone 共享箱。';
    if (els.dropTitle) els.dropTitle.textContent = '发送到 iPhone';
    if (els.dropSubtitle) els.dropSubtitle.textContent = 'iPhone 打开本页后可在共享箱下载。';
    if (els.pickerNote) els.pickerNote.hidden = true;
  }
}

function renderRuntimeConfig() {
  document.documentElement.classList.toggle('host-device', runtimeConfig.isHostDevice);
  document.documentElement.classList.toggle('config-error', runtimeConfig.configError);
  if (els.downloadsPath) {
    const pathLabel = runtimeConfig.configError
      ? '无法读取保存位置'
      : runtimeConfig.isHostDevice
        ? (runtimeConfig.downloadsDir || '电脑接收文件夹')
        : '由电脑端设置';
    els.downloadsPath.textContent = pathLabel;
    els.downloadsPath.title = runtimeConfig.isHostDevice && !runtimeConfig.configError
      ? (runtimeConfig.downloadsDir || '')
      : '';
  }
  if (els.downloadsPathStatus) {
    els.downloadsPathStatus.textContent = runtimeConfig.configError
      ? '配置请求失败。点击“重新读取”即可重试。'
      : runtimeConfig.isHostDevice
        ? '手机传完后会直接出现在这个文件夹。'
        : '保存位置只能在运行 CrossSync 的电脑上更改。';
  }
  if (els.downloadsFree) {
    els.downloadsFree.textContent = Number.isFinite(runtimeConfig.downloadsFreeBytes)
      ? `可用空间 ${formatBytes(runtimeConfig.downloadsFreeBytes)}`
      : '可用空间暂时无法读取';
  }
  if (els.computerName) {
    const displayName = runtimeConfig.computerName || 'Home PC';
    els.computerName.textContent = displayName;
    els.computerName.title = runtimeConfig.computerName || '运行 CrossSync 的电脑';
    if (els.computerNameHeading) els.computerNameHeading.textContent = displayName;
  }
  if (els.btnChooseDownloads) {
    els.btnChooseDownloads.hidden = !runtimeConfig.configError && !runtimeConfig.canChooseDownloadsDir;
    els.btnChooseDownloads.textContent = runtimeConfig.configError ? '重新读取' : '更改保存位置…';
  }
  renderEnvironmentStatus();
  setDirection(currentDirection);
  renderArea('downloads');
}

async function refreshRuntimeConfig() {
  try {
    const data = await fetchJson('/api/config');
    runtimeConfig.configError = false;
    runtimeConfig.downloadsDir = data.downloads_dir || '';
    runtimeConfig.isHostDevice = Boolean(data.is_host_device);
    runtimeConfig.canChooseDownloadsDir = Boolean(data.can_choose_downloads_dir);
    runtimeConfig.downloadsFreeBytes = Number.isFinite(data.downloads_free_bytes) ? data.downloads_free_bytes : null;
    runtimeConfig.computerName = data.computer_name || '';
    runtimeConfig.lanIp = data.lan_ip || '';
    runtimeConfig.requestScheme = data.request_scheme || '';
    runtimeConfig.caCertificateAvailable = Boolean(data.ca_certificate_available);
    renderRuntimeConfig();
  } catch (err) {
    runtimeConfig.configError = true;
    runtimeConfig.isHostDevice = false;
    runtimeConfig.canChooseDownloadsDir = false;
    console.error('[CrossSync] 无法读取运行配置', err);
    renderRuntimeConfig();
  }
}

setDirection(currentDirection);
els.dirToPC?.addEventListener('change', () => setDirection('downloads'));
els.dirToIphone?.addEventListener('change', () => setDirection('outbox'));

if (els.chkOpen) {
  els.chkOpen.checked = storeGet(OPEN_KEY) === '1';
  els.chkOpen.addEventListener('change', () => storeSet(OPEN_KEY, els.chkOpen.checked ? '1' : '0'));
}

if (els.chkDateSubdir) {
  els.chkDateSubdir.checked = storeGet(DATE_SUBDIR_KEY) === '1';
  els.chkDateSubdir.addEventListener('change', () => storeSet(DATE_SUBDIR_KEY, els.chkDateSubdir.checked ? '1' : '0'));
}

if (els.chkVerify) {
  els.chkVerify.checked = storeGet(VERIFY_KEY) === '1';
  els.chkVerify.addEventListener('change', () => storeSet(VERIFY_KEY, els.chkVerify.checked ? '1' : '0'));
}

function updateSummary() {
  let active = 0;
  let completed = 0;
  let failed = 0;
  let preparing = 0;
  let waiting = 0;
  let uploading = 0;
  let total = 0;
  let uploaded = 0;

  tasks.forEach((task) => {
    if (task.state !== 'cancelled') {
      total += task.size || 0;
      uploaded += task.uploaded || 0;
    }
    if (['preparing', 'active', 'paused', 'finishing'].includes(task.state)) active += 1;
    if (task.state === 'completed') completed += 1;
    if (task.state === 'failed') failed += 1;
    if (task.state === 'preparing') preparing += 1;
    if (task.state === 'paused' || task.waiting) waiting += 1;
    if (['active', 'finishing'].includes(task.state) && !task.waiting) uploading += 1;
  });

  const now = performance.now();
  const deltaBytes = Math.max(0, uploaded - lastAggBytes);
  const deltaTime = Math.max(0.001, (now - lastAggTime) / 1000);
  const speed = deltaBytes / deltaTime;
  const remaining = Math.max(0, total - uploaded);
  const eta = speed > 0 ? remaining / speed : 0;
  lastAggBytes = uploaded;
  lastAggTime = now;

  if (els.sumActive) els.sumActive.textContent = String(active);
  if (els.sumCompleted) els.sumCompleted.textContent = String(completed);
  if (els.sumFailed) els.sumFailed.textContent = String(failed);
  if (els.sumSpeed) els.sumSpeed.textContent = `${formatBytes(speed)}/s`;
  if (els.sumEta) els.sumEta.textContent = formatEta(eta);
  const pct = total > 0 ? Math.min(100, (uploaded / total) * 100) : 0;
  if (els.sumBar) {
    els.sumBar.style.width = `${pct.toFixed(2)}%`;
  }

  const pickerPreparing = currentWakeMode === 'picker';
  if (els.stagePreparingTitle) els.stagePreparingTitle.textContent = pickerPreparing ? 'iCloud 准备中' : '照片准备';
  if (els.stagePreparingCount) els.stagePreparingCount.textContent = pickerPreparing ? '…' : String(preparing);
  if (els.stagePreparingCopy) {
    els.stagePreparingCopy.textContent = pickerPreparing
      ? 'iOS 正在下载或导出所选原片'
      : preparing > 0 ? '正在建立高速续传任务' : '等待 iOS 返回所选文件';
  }
  if (els.stagePreparingBar) els.stagePreparingBar.style.width = pickerPreparing ? '42%' : preparing > 0 ? '72%' : '0%';
  if (els.stageWaitingCount) els.stageWaitingCount.textContent = String(waiting);
  if (els.stageWaitingCopy) els.stageWaitingCopy.textContent = waiting > 0 ? '网络等待或任务已暂停' : '就绪文件会自动进入高速通道';
  if (els.stageWaitingBar) els.stageWaitingBar.style.width = waiting > 0 ? '68%' : '0%';
  if (els.stageUploadCount) els.stageUploadCount.textContent = String(uploading);
  if (els.stageSpeedInline) els.stageSpeedInline.textContent = ` · ${formatBytes(speed)}/s`;
  if (els.stageUploadCopy) els.stageUploadCopy.textContent = uploading > 0 ? '正在写入电脑保存位置' : completed > 0 ? `${completed} 项已安全保存` : '局域网直写电脑保存位置';
  if (els.stageUploadBar) els.stageUploadBar.style.width = `${pct.toFixed(2)}%`;
  if (els.lanePreparing) els.lanePreparing.dataset.active = String(pickerPreparing || preparing > 0);
  if (els.laneWaiting) els.laneWaiting.dataset.active = String(waiting > 0);
  if (els.laneUploading) els.laneUploading.dataset.active = String(uploading > 0);
  if (els.liveTransferRegion) els.liveTransferRegion.dataset.hasActive = String(active > 0 || pickerPreparing);
  if (els.btnPauseAll) els.btnPauseAll.disabled = !tasks.some((task) => ['preparing', 'active'].includes(task.state));
  if (els.btnResumeAll) els.btnResumeAll.disabled = !tasks.some((task) => task.state === 'paused');
  if (els.btnClearFinished) {
    els.btnClearFinished.disabled = !tasks.some((task) => ['completed', 'failed', 'cancelled'].includes(task.state));
  }
}

setInterval(updateSummary, 1000);
updateSummary();

function buildRelName(file) {
  let relName = file.relativePath || file.webkitRelativePath || file.name;
  if (storeGet(DATE_SUBDIR_KEY) === '1') {
    const date = new Date(file.lastModified || Date.now());
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    relName = `${y}-${m}-${d}/${basename(relName)}`;
  }
  return relName;
}

function bytesAlreadyUploaded(totalChunks, missing, chunkSize, size) {
  let bytes = 0;
  for (let idx = 0; idx < totalChunks; idx += 1) {
    if (!missing.has(idx)) {
      const start = idx * chunkSize;
      bytes += Math.max(0, Math.min(chunkSize, size - start));
    }
  }
  return bytes;
}

function createTaskItem(file, target) {
  const barInner = h('div');
  const title = h('strong', { text: file.name || '未命名文件' });
  const route = h('span', { text: target === 'downloads' ? '到电脑接收区' : '到 iPhone 共享箱' });
  const sizeSpan = h('span', { text: `0 / ${formatBytes(file.size)}` });
  const speedSpan = h('span', { text: '0 B/s' });
  const etaSpan = h('span', { text: 'ETA -' });
  const stateSpan = h('span', { class: 'task-state', text: '准备中' });
  const hashLine = h('div', { class: 'hash-line' });
  const pauseBtn = h('button', { class: 'btn small', type: 'button', text: '暂停' });
  const resumeBtn = h('button', { class: 'btn small', type: 'button', text: '继续' });
  const retryBtn = h('button', { class: 'btn small', type: 'button', text: '重试' });
  const cancelBtn = h('button', { class: 'btn small ghost', type: 'button', text: '取消' });
  resumeBtn.disabled = true;
  retryBtn.disabled = true;

  const item = h('div', { class: 'task-item' },
    h('div', { class: 'task-top' },
      h('div', { class: 'task-title' }, title, route),
      stateSpan
    ),
    h('div', { class: 'bar' }, barInner),
    h('div', { class: 'task-meta' }, sizeSpan, h('span', { text: '·' }), speedSpan, h('span', { text: '·' }), etaSpan),
    h('div', { class: 'task-actions' }, pauseBtn, resumeBtn, retryBtn, cancelBtn),
    hashLine
  );

  els.listUpload?.prepend(item);
  return { item, barInner, sizeSpan, speedSpan, etaSpan, stateSpan, hashLine, pauseBtn, resumeBtn, retryBtn, cancelBtn };
}

function renderTask(task, ui) {
  const pct = task.size > 0 ? Math.min(100, (task.uploaded / task.size) * 100) : task.state === 'completed' ? 100 : 0;
  ui.barInner.style.width = `${pct.toFixed(2)}%`;
  ui.sizeSpan.textContent = `${formatBytes(task.uploaded)} / ${formatBytes(task.size)}`;

  const elapsed = Math.max(0.001, (performance.now() - task.startedAt) / 1000);
  const speed = task.uploaded / elapsed;
  const remain = Math.max(0, task.size - task.uploaded);
  ui.speedSpan.textContent = `${formatBytes(speed)}/s`;
  ui.etaSpan.textContent = `ETA ${formatEta(speed > 0 ? remain / speed : 0)}`;

  const labels = {
    preparing: '准备中',
    active: '传输中',
    paused: '已暂停',
    finishing: '合并中',
    completed: '完成',
    failed: '失败',
    cancelled: '已取消',
  };
  if (task.state === 'active' && task.retrying) {
    ui.stateSpan.textContent = `重试中 ${task.retrying}/${MAX_CHUNK_ATTEMPTS}`;
  } else if (task.state === 'active' && task.waiting) {
    ui.stateSpan.textContent = '网络等待';
  } else {
    ui.stateSpan.textContent = labels[task.state] || task.state;
  }
  ui.item.classList.toggle('is-completed', task.state === 'completed');
  ui.item.classList.toggle('is-failed', task.state === 'failed');

  ui.pauseBtn.disabled = !['active', 'preparing'].includes(task.state);
  ui.resumeBtn.disabled = task.state !== 'paused';
  ui.retryBtn.disabled = task.state !== 'failed';
  ui.cancelBtn.disabled = ['completed', 'cancelled'].includes(task.state);
  ui.cancelBtn.textContent = task.state === 'failed' ? '放弃续传' : '取消';
  if (task.lastError && ['active', 'failed'].includes(task.state)) {
    ui.hashLine.textContent = task.lastError;
  } else if (task.state !== 'completed') {
    ui.hashLine.textContent = '';
  }
  updateSummary();
}

function cancelServerUpload(uploadId) {
  if (!uploadId) return Promise.resolve();
  return fetch(`/api/upload/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    keepalive: true,
  }).catch(() => {});
}

async function uploadChunkWithRetry({ uploadId, idx, chunk, verify, task, controllers, render }) {
  for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt += 1) {
    while (task.state === 'paused') await delay(150);
    if (task.state === 'cancelled') throw new Error('cancelled');

    const releaseLane = await uploadLanePool.acquire();
    if (task.state === 'cancelled') {
      releaseLane();
      throw new Error('cancelled');
    }
    if (task.state === 'paused') {
      releaseLane();
      attempt -= 1;
      continue;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      task.waiting = true;
      render?.();
      controller.abort();
    }, CHUNK_TIMEOUT_MS);
    controllers.add(controller);
    try {
      task.waiting = false;
      task.retrying = attempt > 0 ? attempt + 1 : 0;
      task.lastError = '';
      render?.();
      let body = chunk;
      const headers = {};
      if (verify && window.crypto?.subtle) {
        const buf = await chunk.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buf);
        headers['x-sha256'] = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
        body = buf;
      }

      const res = await fetch(`/api/upload/${uploadId}/${idx}`, {
        method: 'PUT',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = '';
        try {
          const data = await res.json();
          detail = data.detail || '';
        } catch (_) {}
        throw new Error(detail || `${res.status} ${res.statusText}`);
      }
      task.retrying = 0;
      task.waiting = false;
      task.lastProgressAt = performance.now();
      render?.();
      return;
    } catch (err) {
      if (task.state === 'cancelled') throw err;
      if (task.state === 'paused') {
        attempt -= 1;
        await delay(150);
        continue;
      }
      task.waiting = false;
      task.retrying = attempt + 1;
      task.lastError = err?.name === 'AbortError' ? '当前分片超时，正在重试' : (err?.message || '当前分片失败，正在重试');
      render?.();
      if (attempt === MAX_CHUNK_ATTEMPTS - 1) throw new Error(task.lastError);
      await delay(Math.min(5000, 300 * 2 ** attempt));
    } finally {
      window.clearTimeout(timeoutId);
      controllers.delete(controller);
      releaseLane();
    }
  }
}

function uploadFileStream({ file, target, relName, task, controllers, render }) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      name: relName,
      target,
      size: String(file.size),
      last_modified: String(file.lastModified || ''),
      open: storeGet(OPEN_KEY) === '1' ? '1' : '0',
      checksum: '0',
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload-stream?${params.toString()}`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      task.uploaded = Math.min(task.size, event.loaded);
      task.lastProgressAt = performance.now();
      render?.();
    };
    xhr.onload = () => {
      controllers.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response || {});
        return;
      }
      const detail = xhr.response?.detail || `${xhr.status} ${xhr.statusText}`;
      reject(new Error(detail));
    };
    xhr.onerror = () => {
      controllers.delete(xhr);
      reject(new Error('stream upload failed'));
    };
    xhr.onabort = () => {
      controllers.delete(xhr);
      reject(new Error('stream upload aborted'));
    };
    controllers.add(xhr);
    xhr.send(file);
  });
}

async function startUpload(file, target) {
  const relName = buildRelName(file);
  const pendingUpload = await rememberPendingUpload(file, target, relName);
  const pendingUploadId = pendingUpload.id;
  const ui = createTaskItem(file, target);
  const controllers = new Set();
  let fatalError = null;
  let uploadId = null;

  const task = {
    id: ++taskSeq,
    size: file.size,
    uploaded: 0,
    state: 'preparing',
    startedAt: performance.now(),
    lastProgressAt: performance.now(),
    retrying: 0,
    waiting: false,
    lastError: '',
    pause() {
      if (!['preparing', 'active'].includes(this.state)) return;
      this.state = 'paused';
      controllers.forEach((controller) => controller.abort());
      renderTask(this, ui);
    },
    resume() {
      if (this.state !== 'paused') return;
      this.state = 'active';
      wakeKeeper.requestForTransfer();
      renderTask(this, ui);
    },
    cancel() {
      if (['completed', 'cancelled'].includes(this.state)) return;
      this.state = 'cancelled';
      controllers.forEach((controller) => controller.abort());
      void cancelServerUpload(uploadId);
      forgetPendingUpload(pendingUploadId);
      renderTask(this, ui);
      wakeKeeper.releaseIfIdle();
    },
    retry() {
      if (this.state !== 'failed') return;
      const index = tasks.indexOf(this);
      if (index >= 0) tasks.splice(index, 1);
      ui.item.remove();
      releasePendingUpload(pendingUploadId);
      updateSummary();
      void startUpload(file, target);
    },
  };

  ui.item.dataset.taskId = String(task.id);
  ui.pauseBtn.addEventListener('click', () => task.pause());
  ui.resumeBtn.addEventListener('click', () => task.resume());
  ui.retryBtn.addEventListener('click', () => task.retry());
  ui.cancelBtn.addEventListener('click', () => task.cancel());
  tasks.push(task);
  renderTask(task, ui);

  try {
    await wakeKeeper.requestForTransfer();
    if (shouldUseStreamUpload(file)) {
      try {
        task.state = 'active';
        task.lastError = '';
        renderTask(task, ui);
        const streamRes = await uploadFileStream({
          file,
          target,
          relName,
          task,
          controllers,
          render: () => renderTask(task, ui),
        });
        if (task.state === 'cancelled') return task;
        task.uploaded = task.size;
        task.state = 'completed';
        forgetPendingUpload(pendingUploadId);
        if (streamRes?.sha256) ui.hashLine.textContent = `SHA-256: ${streamRes.sha256}`;
        renderTask(task, ui);
        refreshArea(target);
        return task;
      } catch (err) {
        if (task.state === 'cancelled') return task;
        while (task.state === 'paused') await delay(150);
        task.uploaded = 0;
        task.state = 'preparing';
        task.lastError = '高速通道中断，切换到续传模式';
        renderTask(task, ui);
      }
    }
    const initRes = await fetchJson('/api/init-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: relName,
        size: file.size,
        chunk_size: uploadChunkSize(),
        last_modified: file.lastModified,
        client_id: browserClientId(),
        resume_key: pendingUpload.resumeKey,
        target,
      }),
    });

    uploadId = initRes.upload_id;
    if (task.state === 'cancelled') {
      void cancelServerUpload(uploadId);
      return task;
    }
    while (task.state === 'paused') await delay(150);
    if (task.state === 'cancelled') {
      void cancelServerUpload(uploadId);
      return task;
    }

    const chunkSize = initRes.chunk_size;
    const totalChunks = initRes.total_chunks;
    const missing = new Set(initRes.missing || []);
    const missingQueue = [...missing].sort((a, b) => a - b);
    let nextQueueIndex = 0;
    task.uploaded = bytesAlreadyUploaded(totalChunks, missing, chunkSize, file.size);
    task.state = 'active';
    renderTask(task, ui);

    const claimNext = () => {
      if (nextQueueIndex >= missingQueue.length) return null;
      const idx = missingQueue[nextQueueIndex];
      nextQueueIndex += 1;
      return idx;
    };

    async function worker() {
      while (!fatalError && task.state !== 'cancelled') {
        while (task.state === 'paused') await delay(150);
        const idx = claimNext();
        if (idx === null) return;

        const start = idx * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const chunk = file.slice(start, end);

        try {
          await uploadChunkWithRetry({
            uploadId,
            idx,
            chunk,
            verify: shouldVerifyUploadChunks(),
            task,
            controllers,
            render: () => renderTask(task, ui),
          });
          task.uploaded += end - start;
          renderTask(task, ui);
        } catch (err) {
          if (task.state === 'cancelled') return;
          fatalError = err;
          controllers.forEach((controller) => controller.abort());
          return;
        }
      }
    }

    const concurrency = uploadConcurrency(missingQueue.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (task.state === 'cancelled') return task;
    if (fatalError) throw fatalError;

    task.state = 'finishing';
    renderTask(task, ui);
    const open = storeGet(OPEN_KEY) === '1';
    const checksum = storeGet(VERIFY_KEY) === '1' && !isAppleMobile();
    const finishRes = await fetchJson(`/api/finish-upload/${uploadId}?open=${open ? 1 : 0}&checksum=${checksum ? 1 : 0}`, { method: 'POST' });

    task.uploaded = task.size;
    task.state = 'completed';
    forgetPendingUpload(pendingUploadId);
    if (finishRes?.sha256) ui.hashLine.textContent = `SHA-256: ${finishRes.sha256}`;
    renderTask(task, ui);
    refreshArea(target);
  } catch (err) {
    if (task.state !== 'cancelled') {
      task.state = 'failed';
      task.lastError = err?.message ? `错误：${err.message}` : '传输失败';
      releasePendingUpload(pendingUploadId);
      renderTask(task, ui);
    }
  } finally {
    wakeKeeper.releaseIfIdle();
  }
  return task;
}

let selectionObjectUrls = [];

function renderSelection(files) {
  selectionObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  selectionObjectUrls = [];
  const selected = [...files].filter(Boolean);
  const imageCount = selected.filter((file) => file.type?.startsWith('image/')).length;
  const videoCount = selected.filter((file) => file.type?.startsWith('video/')).length;

  if (els.selectedCount) els.selectedCount.textContent = String(selected.length);
  if (els.selectedMeta) {
    els.selectedMeta.textContent = selected.length
      ? `${imageCount} 张照片 · ${videoCount} 个视频`
      : '选择照片或视频后会立即回到 CrossSync';
  }
  if (!els.selectedMediaGrid) return;
  els.selectedMediaGrid.innerHTML = '';
  if (!selected.length) {
    els.selectedMediaGrid.append(h('div', { class: 'media-empty', text: '照片准备完成后会在这里预览' }));
    return;
  }

  selected.slice(0, 8).forEach((file) => {
    const tile = h('div', { class: `media-tile${file.type?.startsWith('video/') ? ' video' : ''}` });
    if (file.type?.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      selectionObjectUrls.push(url);
      tile.append(h('img', { src: url, alt: file.name || '所选照片' }));
    } else if (file.type?.startsWith('video/')) {
      const url = URL.createObjectURL(file);
      selectionObjectUrls.push(url);
      tile.append(h('video', { src: url, muted: true, playsinline: true, preload: 'metadata', 'aria-label': file.name || '所选视频' }));
    } else {
      tile.append(h('span', { text: basename(file.name || '文件') }));
    }
    els.selectedMediaGrid.append(tile);
  });

  if (selected.length > 8) {
    els.selectedMediaGrid.append(h('div', { class: 'media-tile more', text: `+${selected.length - 8}` }));
  }
}

function handleFiles(files, target) {
  wakeKeeper.resumeAfterPicker();
  const selected = Array.from(files || []).filter(Boolean);
  if (!selected.length) {
    if (els.pickerNote) {
      els.pickerNote.hidden = false;
      els.pickerNote.dataset.tone = 'error';
      els.pickerNote.textContent = '没有收到所选照片。请重新打开照片图库，选择后点击右上角“添加”。';
    }
    wakeKeeper.releaseIfIdle();
    return;
  }
  if (els.pickerNote) {
    els.pickerNote.hidden = false;
    els.pickerNote.dataset.tone = 'success';
    els.pickerNote.textContent = `已收到 ${selected.length} 项，正在创建可续传任务…`;
  }
  try {
    renderSelection(selected);
  } catch (error) {
    if (els.pickerNote) {
      els.pickerNote.dataset.tone = 'error';
      els.pickerNote.textContent = `已收到照片，但预览失败；仍将继续传输。${error?.message || ''}`;
    }
  }
  wakeKeeper.requestForTransfer();
  const started = selected.map((file) => startUpload(file, target));
  Promise.allSettled(started).then((results) => {
    const completed = results.filter((result) => result.status === 'fulfilled' && result.value?.state === 'completed').length;
    const failed = results.length - completed;
    renderSelection([]);
    if (!els.pickerNote) return;
    els.pickerNote.hidden = false;
    if (failed > 0) {
      els.pickerNote.dataset.tone = 'error';
      els.pickerNote.textContent = `本批已完成 ${completed} 项，${failed} 项待重试；失败原因显示在任务卡片中。`;
    } else {
      els.pickerNote.dataset.tone = 'success';
      els.pickerNote.textContent = `${completed} 项已全部保存到${target === 'downloads' ? '电脑' : ' iPhone 共享箱'}。`;
    }
  });
  if (els.inputUpload) els.inputUpload.value = '';
  window.setTimeout(() => {
    els.liveTransferRegion?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 120);
}

function preventDefaults(event) {
  event.preventDefault();
  event.stopPropagation();
}

if (els.dzUpload && els.inputUpload) {
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
    els.dzUpload.addEventListener(eventName, preventDefaults);
  });
  ['dragenter', 'dragover'].forEach((eventName) => {
    els.dzUpload.addEventListener(eventName, () => els.dzUpload.classList.add('dragover'));
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    els.dzUpload.addEventListener(eventName, () => els.dzUpload.classList.remove('dragover'));
  });
  els.dzUpload.addEventListener('drop', async (event) => {
    const files = await extractDroppedFiles(event.dataTransfer);
    handleFiles(files.length ? files : [...event.dataTransfer.files], 'downloads');
  });
  els.dzUpload.addEventListener('click', (event) => {
    if (event.target === els.inputUpload) return;
    if (event.target.closest?.('.workspace-upload-action, .pick-btn, .choose-photos-button')) return;
    els.inputUpload.click();
  });
  els.btnChooseUpload?.addEventListener('click', (event) => {
    event.stopPropagation();
    els.inputUpload.click();
  });
  els.inputUpload.addEventListener('click', () => wakeKeeper.suspendForPicker());
  els.inputUpload.addEventListener('cancel', () => wakeKeeper.resumeAfterPicker());
  els.inputUpload.addEventListener('change', (event) => {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    handleFiles(files, 'downloads');
  });
}

els.btnPickToResume?.addEventListener('click', () => {
  wakeKeeper.suspendForPicker();
  els.inputUpload?.click();
});
renderPendingUploads();

if (els.btnSendToIphone && els.inputOutbox) {
  els.btnSendToIphone.addEventListener('click', () => els.inputOutbox.click());
  els.inputOutbox.addEventListener('change', (event) => {
    handleFiles(event.target.files, 'outbox');
    els.inputOutbox.value = '';
  });
}
