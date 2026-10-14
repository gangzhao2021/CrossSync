// CrossSync web client: Utility drawer, menus, the downloads/outbox file lists and page bootstrap.
// Loaded as ordered classic scripts that share one global scope; see app.html.

function setUtilityDrawer(open, { restoreFocus = false } = {}) {
  if (!els.utilityDrawer) return;
  els.utilityDrawer.open = open;
  els.btnSettings?.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('utility-open', open);
  if (els.utilityBackdrop) els.utilityBackdrop.hidden = !open;
  if (open) {
    window.setTimeout(() => els.btnCloseUtility?.focus({ preventScroll: true }), 0);
  } else if (restoreFocus) {
    els.btnSettings?.focus({ preventScroll: true });
  }
}

els.btnSettings?.addEventListener('click', () => setUtilityDrawer(!els.utilityDrawer?.open));
els.btnCloseUtility?.addEventListener('click', () => setUtilityDrawer(false, { restoreFocus: true }));
els.utilityBackdrop?.addEventListener('click', () => setUtilityDrawer(false, { restoreFocus: true }));

els.utilityDrawer?.addEventListener('toggle', () => {
  const open = els.utilityDrawer.open;
  els.btnSettings?.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('utility-open', open);
  if (els.utilityBackdrop) els.utilityBackdrop.hidden = !open;
});

els.utilityDrawer?.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !els.utilityDrawer?.open) return;
  const focusable = [...els.utilityDrawer.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

els.btnPauseAll?.addEventListener('click', () => tasks.forEach((task) => task.pause?.()));
els.btnResumeAll?.addEventListener('click', () => tasks.forEach((task) => task.resume?.()));
els.btnClearFinished?.addEventListener('click', () => {
  for (let idx = tasks.length - 1; idx >= 0; idx -= 1) {
    const task = tasks[idx];
    if (['completed', 'failed', 'cancelled'].includes(task.state)) {
      document.querySelector(`[data-task-id="${task.id}"]`)?.remove();
      tasks.splice(idx, 1);
    }
  }
  hideBatchResult();
  updateSummary();
  // Failed uploads that were cleared from the queue become "re-select to resume" items.
  renderPendingUploads();
});

document.querySelectorAll('[data-menu]').forEach((button) => {
  const id = button.getAttribute('data-menu');
  const menu = $(`menu-${id}`);
  if (!menu) return;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const wasOpen = menu.classList.contains('is-open');
    document.querySelectorAll('.menu').forEach((item) => item.classList.remove('is-open'));
    menu.classList.toggle('is-open', !wasOpen);
  });
});
document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((menu) => menu.classList.remove('is-open')));
document.querySelectorAll('.more-menu button').forEach((button) => {
  button.addEventListener('click', () => button.closest('details')?.removeAttribute('open'));
});
document.addEventListener('click', (event) => {
  if (event.target.closest?.('.more-actions')) return;
  document.querySelectorAll('.more-actions[open]').forEach((item) => item.removeAttribute('open'));
});

const areaState = {
  downloads: {
    list: $('downloads-list'),
    selectedBar: $('selbar-dl'),
    selectedCount: $('selcount-dl'),
    selectedDownload: $('btn-download-dl-selected'),
    allDownload: $('btn-download-dl-all'),
    open: $('btn-open-downloads'),
    refresh: $('btn-refresh-downloads'),
    selectAll: $('btn-selectall-dl'),
    invertSelection: $('btn-invert-dl'),
    selectNone: $('btn-selectnone-dl'),
    deleteSelected: $('btn-del-dl-selected'),
    deleteQuick: $('btn-dl-del-quick'),
    cancelSelection: $('btn-dl-cancel-sel'),
    clear: $('btn-clear-dl'),
    more: $('more-actions-dl'),
    files: [],
    total: 0,
    // The receive folder can be a large personal folder; show the newest files only.
    limit: 200,
    get empty() {
      return runtimeConfig.isHostDevice
        ? '还没有收到文件。点右上角“扫码”，用 iPhone 扫一下就能开始发。'
        : '电脑上还没有收到文件。';
    },
  },
  outbox: {
    list: $('outbox-list'),
    selectedBar: $('selbar-ob'),
    selectedCount: $('selcount-ob'),
    selectedDownload: $('btn-download-ob-selected'),
    allDownload: $('btn-download-ob-all'),
    open: $('btn-open-outbox'),
    refresh: $('btn-refresh-outbox'),
    selectAll: $('btn-selectall-ob'),
    invertSelection: $('btn-invert-ob'),
    selectNone: $('btn-selectnone-ob'),
    deleteSelected: $('btn-del-ob-selected'),
    deleteQuick: $('btn-ob-del-quick'),
    cancelSelection: $('btn-ob-cancel-sel'),
    clear: $('btn-clear-ob'),
    more: $('more-actions-ob'),
    files: [],
    total: 0,
    limit: 500,
    get empty() {
      return runtimeConfig.isHostDevice
        ? '还没有放文件。点上面的按钮，或者把文件拖进窗口。'
        : '电脑还没有发来文件。';
    },
  },
};

function selectedPaths(area) {
  const cfg = areaState[area];
  if (!cfg?.list) return [];
  return [...cfg.list.querySelectorAll('input[type=checkbox]:checked')]
    .map((checkbox) => checkbox.closest('.file-item')?.dataset.path)
    .filter(Boolean);
}

function updateSelection(area) {
  const cfg = areaState[area];
  const count = selectedPaths(area).length;
  if (cfg.selectedCount) cfg.selectedCount.textContent = String(count);
  if (cfg.selectedBar) cfg.selectedBar.hidden = count === 0;
  if (cfg.selectedDownload) cfg.selectedDownload.disabled = count === 0;
  if (area === 'outbox' && els.btnPhotosSelected) {
    els.btnPhotosSelected.hidden = !photoSaveSupported() || runtimeConfig.isHostDevice;
    els.btnPhotosSelected.disabled = !selectedPaths(area).some((path) => photoMimeType(path));
  }
  if (cfg.deleteSelected) cfg.deleteSelected.disabled = count === 0;
  if (cfg.deleteQuick) cfg.deleteQuick.disabled = count === 0;
  const empty = cfg.files.length === 0;
  [cfg.allDownload, cfg.selectAll, cfg.invertSelection, cfg.selectNone, cfg.clear].forEach((control) => {
    if (control) control.disabled = empty;
  });
  if (cfg.more) {
    cfg.more.toggleAttribute('data-disabled', empty);
    cfg.more.querySelector('summary')?.setAttribute('aria-disabled', String(empty));
    if (empty) cfg.more.removeAttribute('open');
  }
}

function downloadUrl(area, path) {
  return `/dl/${area}/${encodePath(path)}`;
}

function zipUrl(area, paths = []) {
  const url = new URL(`/dl/${area}.zip`, window.location.origin);
  paths.forEach((path) => url.searchParams.append('paths', path));
  return url.toString();
}

function startDownload(area, paths = []) {
  wakeKeeper.enable('auto');
  window.setTimeout(() => wakeKeeper.releaseIfIdle(), 10 * 60 * 1000);
  window.location.href = zipUrl(area, paths);
}

function checksumLabel(file) {
  if (!file.sha256) return '';
  if (!file.checksum_fresh) return '校验值待复核';
  return file.checksum_source === 'sidecar' ? '旧校验值' : '有校验值';
}

function fileIconPath(path) {
  const extension = basename(path).split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'tif', 'tiff'].includes(extension)) {
    return '/static/icons/tabler/photo.svg';
  }
  if (extension === 'pdf') return '/static/icons/tabler/file-type-pdf.svg';
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(extension)) return '/static/icons/tabler/archive.svg';
  return '/static/icons/tabler/file.svg';
}

function setVerifyStatus(file, statusEl, text, tone = '') {
  file.verifyStatusText = text;
  file.verifyStatusTone = tone;
  if (!statusEl) return;
  statusEl.className = `verify-status ${tone}`.trim();
  statusEl.textContent = text;
}

async function verifyFile(area, file, statusEl, button) {
  if (!statusEl || !button) return;
  button.disabled = true;
  setVerifyStatus(file, statusEl, '校验中...');

  try {
    const data = await fetchJson('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ area, path: file.path }),
    });

    if (data.status === 'matched') {
      setVerifyStatus(file, statusEl, '文件一致', 'ok');
    } else if (data.status === 'recorded') {
      setVerifyStatus(file, statusEl, '已记录当前校验值', 'ok');
    } else {
      setVerifyStatus(file, statusEl, '校验不一致', 'danger');
    }
  } catch (err) {
    setVerifyStatus(file, statusEl, err?.message ? `校验失败：${err.message}` : '校验失败', 'danger');
  } finally {
    button.disabled = false;
  }
}

function renderArea(area) {
  const cfg = areaState[area];
  if (!cfg?.list) return;

  const keptSelection = new Set(selectedPaths(area));
  cfg.list.innerHTML = '';

  if (!cfg.files.length) {
    cfg.list.append(h('div', { class: 'empty-state', text: cfg.empty }));
    updateSelection(area);
    return;
  }

  cfg.files.forEach((file) => {
    const checkbox = h('input', { class: 'file-check', type: 'checkbox', 'aria-label': `选择 ${file.path}` });
    checkbox.checked = keptSelection.has(file.path);
    checkbox.addEventListener('change', () => updateSelection(area));

    const alreadyOnHost = area === 'downloads' && runtimeConfig.isHostDevice;
    const link = alreadyOnHost
      ? h('span', { class: 'file-name', text: file.path })
      : h('a', { href: downloadUrl(area, file.path), download: basename(file.path), text: file.path });
    if (!alreadyOnHost) link.addEventListener('click', () => wakeKeeper.enable('auto'));

    const meta = h('span', {
      title: file.sha256 ? `SHA-256: ${file.sha256}` : '',
      text: [formatBytes(file.size), formatFileTime(file.mtime), checksumLabel(file)].filter(Boolean).join(' · '),
    });
    const verifyStatus = h('span', {
      class: `verify-status ${file.verifyStatusTone || ''}`.trim(),
      text: file.verifyStatusText || '',
    });
    const verify = h('button', { class: 'btn small ghost', type: 'button', text: '校验' });
    verify.addEventListener('click', () => verifyFile(area, file, verifyStatus, verify));
    let download;
    if (alreadyOnHost) {
      download = h('span', { class: 'saved-badge', text: '已在电脑' });
    } else if (canOfferPhotoSave(area, file.path)) {
      // On the iPhone, photos and videos go to the Photos app, not the Files app.
      download = h('button', { class: 'btn small primary', type: 'button', text: '存到相册', dataset: { label: '存到相册' } });
      download.addEventListener('click', () => void saveToPhotos(area, [file.path], download));
    } else {
      download = h('a', { class: 'btn small', href: downloadUrl(area, file.path), download: basename(file.path), text: '下载' });
      download.addEventListener('click', () => wakeKeeper.enable('auto'));
    }

    const item = h('div', { class: 'file-item', dataset: { path: file.path } },
      h('div', { class: 'file-row' },
        h('label', { class: 'file-check-wrap' }, checkbox),
        h('img', { class: 'file-type-icon', src: fileIconPath(file.path), alt: '' }),
        h('div', { class: 'file-main' }, link, meta, verifyStatus),
        h('div', { class: 'file-actions' }, verify, download)
      )
    );
    cfg.list.append(item);
  });

  if (area === 'outbox') updateShareNotice();
  if (cfg.total > cfg.files.length) {
    cfg.list.append(h('div', {
      class: 'list-note',
      text: `只显示最新的 ${cfg.files.length} 个，共 ${cfg.total} 个文件；打开文件夹可查看全部。`,
    }));
  }
  updateSelection(area);
}

async function refreshArea(area) {
  const cfg = areaState[area];
  if (!cfg) return;
  if (cfg.refreshPromise) {
    if (cfg.refreshFetching) cfg.refreshAgain = true;
    return cfg.refreshPromise;
  }
  cfg.refreshPromise = (async () => {
    // Collapse a batch of upload completions into one list request.
    await new Promise((resolve) => setTimeout(resolve, 120));
    do {
      cfg.refreshAgain = false;
      cfg.refreshFetching = true;
      await loadArea(area);
      cfg.refreshFetching = false;
    } while (cfg.refreshAgain);
  })().finally(() => {
    cfg.refreshPromise = null;
    cfg.refreshFetching = false;
  });
  return cfg.refreshPromise;
}

async function loadArea(area) {
  const cfg = areaState[area];
  try {
    const statusByPath = new Map(cfg.files.map((file) => [
      file.path,
      {
        verifyStatusText: file.verifyStatusText,
        verifyStatusTone: file.verifyStatusTone,
      },
    ]));
    const data = await fetchJson(`/api/list/${area}?limit=${cfg.limit || 0}`);
    const snapshot = JSON.stringify([data.total, data.files || []]);
    if (snapshot === cfg.serverSnapshot) return;
    cfg.serverSnapshot = snapshot;
    cfg.total = data.total ?? (data.files || []).length;
    cfg.files = (data.files || []).sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    cfg.files.forEach((file) => {
      const status = statusByPath.get(file.path);
      if (status?.verifyStatusText) {
        file.verifyStatusText = status.verifyStatusText;
        file.verifyStatusTone = status.verifyStatusTone;
      }
    });
    renderArea(area);
  } catch (_) {
    if (cfg.list && !cfg.files.length) {
      cfg.list.innerHTML = '';
      cfg.list.append(h('div', { class: 'empty-state', text: '无法刷新列表' }));
    }
  }
}

async function deleteFiles(area, paths) {
  if (!paths.length) return;
  const label = area === 'downloads' ? '电脑接收区' : 'iPhone 共享箱';
  if (!confirm(`将 ${label} 中选中的 ${paths.length} 个文件移到电脑的回收站？`)) return;
  const result = await fetchJson('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ area, paths }),
  });
  reportDeleteFailures(result);
  await refreshArea(area);
}

async function clearArea(area) {
  const label = area === 'downloads' ? '电脑接收区' : 'iPhone 共享箱';
  const message = `将${label}中由 CrossSync 传入、之后未被修改的文件移到回收站？\n文件夹里原有的其他文件不会受影响。`;
  if (!confirm(message)) return;
  const result = await fetchJson('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ area, clear: true }),
  });
  reportDeleteFailures(result);
  await refreshArea(area);
}

function reportDeleteFailures(result) {
  const failed = result?.failed || [];
  if (!failed.length) return;
  const shown = failed.slice(0, 5).join('\n');
  const more = failed.length > 5 ? `\n…另有 ${failed.length - 5} 个` : '';
  alert(`以下文件未能移到回收站（可能正被占用），已保留原位：\n${shown}${more}`);
}

Object.entries(areaState).forEach(([area, cfg]) => {
  cfg.more?.querySelector('summary')?.addEventListener('click', (event) => {
    if (!cfg.files.length) event.preventDefault();
  });
  cfg.open?.addEventListener('click', async () => {
    try {
      const data = await fetchJson(`/api/open/${area}`, { method: 'POST' });
      if (!data.ok) alert('当前系统未能打开目录。');
    } catch (_) {
      alert('当前系统未能打开目录。');
    }
  });
  cfg.refresh?.addEventListener('click', () => refreshArea(area));
  cfg.selectedDownload?.addEventListener('click', () => {
    const paths = selectedPaths(area);
    if (paths.length) startDownload(area, paths);
  });
  cfg.allDownload?.addEventListener('click', () => {
    if (!cfg.files.length) return alert('没有可下载的文件。');
    startDownload(area);
  });
  cfg.selectAll?.addEventListener('click', () => {
    cfg.list?.querySelectorAll('input[type=checkbox]').forEach((checkbox) => { checkbox.checked = true; });
    updateSelection(area);
  });
  cfg.invertSelection?.addEventListener('click', () => {
    cfg.list?.querySelectorAll('input[type=checkbox]').forEach((checkbox) => { checkbox.checked = !checkbox.checked; });
    updateSelection(area);
  });
  cfg.selectNone?.addEventListener('click', () => {
    cfg.list?.querySelectorAll('input[type=checkbox]').forEach((checkbox) => { checkbox.checked = false; });
    updateSelection(area);
  });
  cfg.deleteSelected?.addEventListener('click', () => deleteFiles(area, selectedPaths(area)));
  cfg.deleteQuick?.addEventListener('click', () => deleteFiles(area, selectedPaths(area)));
  cfg.cancelSelection?.addEventListener('click', () => {
    cfg.list?.querySelectorAll('input[type=checkbox]').forEach((checkbox) => { checkbox.checked = false; });
    updateSelection(area);
  });
  cfg.clear?.addEventListener('click', () => clearArea(area));
});

els.btnChooseDownloads?.addEventListener('click', async () => {
  els.btnChooseDownloads.disabled = true;
  try {
    if (runtimeConfig.configError) {
      if (els.downloadsPathStatus) els.downloadsPathStatus.textContent = '正在重新读取配置…';
      await refreshRuntimeConfig();
      return;
    }
    if (els.downloadsPathStatus) els.downloadsPathStatus.textContent = '请在电脑弹出的窗口中选择文件夹…';
    const data = await fetchJson('/api/config/downloads-dir/pick', { method: 'POST' });
    if (data.cancelled) {
      if (els.downloadsPathStatus) els.downloadsPathStatus.textContent = '未更改保存位置。';
      return;
    }
    runtimeConfig.downloadsDir = data.downloads_dir || runtimeConfig.downloadsDir;
    runtimeConfig.downloadsFreeBytes = Number.isFinite(data.downloads_free_bytes)
      ? data.downloads_free_bytes
      : runtimeConfig.downloadsFreeBytes;
    renderRuntimeConfig();
    if (els.downloadsPathStatus) els.downloadsPathStatus.textContent = '已切换；之后手机上传会直接保存到这里。';
    await refreshArea('downloads');
  } catch (err) {
    if (els.downloadsPathStatus) {
      els.downloadsPathStatus.textContent = err?.message ? `选择失败：${err.message}` : '选择保存位置失败。';
    }
  } finally {
    els.btnChooseDownloads.disabled = false;
  }
});

refreshRuntimeConfig().finally(() => {
  void loadDevices();
  // Empty-list wording depends on which device this is, which is only known now.
  ['downloads', 'outbox'].forEach((area) => {
    if (!areaState[area].files.length) renderArea(area);
  });
  refreshArea('downloads');
  refreshArea('outbox');
});

// --- The two pages: "downloads" (to the computer) and "outbox" (to the iPhone) ---

let currentView = 'downloads';
const feedbackHome = { parent: els.transferFeedback?.parentNode, next: els.transferFeedback?.nextSibling };

function showView(view) {
  currentView = view === 'outbox' ? 'outbox' : 'downloads';
  const outbox = currentView === 'outbox';
  if (els.viewDownloads) els.viewDownloads.hidden = outbox;
  if (els.viewOutbox) els.viewOutbox.hidden = !outbox;
  [[$('nav-to-computer'), !outbox], [els.btnSendToIphone, outbox]].forEach(([tab, active]) => {
    if (!tab) return;
    tab.classList.toggle('is-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  // Progress and results belong to whichever page started the transfer.
  if (els.transferFeedback) {
    if (outbox) els.outboxFeedbackSlot?.append(els.transferFeedback);
    else feedbackHome.parent?.insertBefore(els.transferFeedback, feedbackHome.next);
  }
  setDirection(currentView);
  const hash = outbox ? '#iphone' : '';
  if (window.location.hash !== hash) history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  if (outbox) {
    updateShareNotice();
    void refreshArea('outbox');
  }
  window.scrollTo({ top: 0 });
}

$('nav-to-computer')?.addEventListener('click', () => showView('downloads'));
showView(window.location.hash === '#iphone' ? 'outbox' : 'downloads');

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !els.utilityDrawer?.open) return;
  setUtilityDrawer(false, { restoreFocus: true });
});
initPwa();
setInterval(() => {
  if (!document.hidden && !hasActiveTransfers() && !areaState.downloads.refreshPromise) refreshArea('downloads');
}, 15000);
setInterval(() => {
  if (!document.hidden && !hasActiveTransfers() && !areaState.outbox.refreshPromise) refreshArea('outbox');
}, 15000);

async function extractDroppedFiles(dataTransfer) {
  const items = dataTransfer?.items ? [...dataTransfer.items] : [];
  const out = [];
  const pending = [];

  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) pending.push(traverseEntry(entry, ''));
  }

  await Promise.all(pending);
  return out;

  function fileFromEntry(entry, path) {
    return new Promise((resolve) => {
      entry.file((file) => {
        Object.defineProperty(file, 'relativePath', { value: `${path}${file.name}` });
        out.push(file);
        resolve();
      }, () => resolve());
    });
  }

  async function traverseEntry(entry, path) {
    if (entry.isFile) {
      await fileFromEntry(entry, path);
      return;
    }
    if (!entry.isDirectory) return;

    const reader = entry.createReader();
    while (true) {
      const entries = await new Promise((resolve) => reader.readEntries(resolve));
      if (!entries.length) break;
      for (const child of entries) {
        await traverseEntry(child, `${path}${entry.name}/`);
      }
    }
  }
}

(function notifyScanned() {
  const sid = new URLSearchParams(location.search).get('sid');
  if (sid) {
    fetch(`/api/scanned?sid=${encodeURIComponent(sid)}`, { method: 'POST' }).catch(() => {});
  }
})();

window.addEventListener('beforeunload', (event) => {
  if (!hasActiveTransfers()) return;
  event.preventDefault();
  event.returnValue = '';
});

// --- iPhone share box: what the computer sent, as seen from the phone ---

function shareSeenMtime() {
  return Number(storeGet(SHARE_SEEN_KEY, '0')) || 0;
}

function markShareSeen() {
  const newest = Math.max(0, ...areaState.outbox.files.map((file) => Number(file.mtime) || 0));
  if (newest > shareSeenMtime()) storeSet(SHARE_SEEN_KEY, String(newest));
}

function updateShareNotice() {
  if (!runtimeConfig.isHostDevice && currentView === 'outbox') markShareSeen();
  const unseen = runtimeConfig.isHostDevice ? 0 : countUnseen(areaState.outbox.files, shareSeenMtime());
  if (els.shareBadge) {
    els.shareBadge.hidden = unseen === 0;
    els.shareBadge.textContent = unseen > 99 ? '99+' : String(unseen);
  }
  if (els.shareNotice) {
    els.shareNotice.hidden = unseen === 0;
    if (els.shareNoticeText) els.shareNoticeText.textContent = `电脑发来 ${unseen} 个新文件`;
  }
}

function openShareBox() {
  showView('outbox');
}

els.btnShareNotice?.addEventListener('click', () => openShareBox());

// --- Live events: instant list refresh, arrival notifications on the computer ---

const announcedUploads = new Set();
let pendingArrivals = [];
let arrivalTimer = null;

function notificationsAllowed() {
  return 'Notification' in window && Notification.permission === 'granted' && storeGet(NOTIFY_KEY) === '1';
}

function renderNotifyControls() {
  const supported = 'Notification' in window;
  if (els.chkNotify) {
    els.chkNotify.disabled = !supported;
    els.chkNotify.checked = supported && notificationsAllowed();
  }
  if (els.btnEnableNotify) {
    els.btnEnableNotify.hidden = !supported || !runtimeConfig.isHostDevice
      || Notification.permission === 'denied' || notificationsAllowed();
  }
}

async function enableNotifications() {
  if (!('Notification' in window)) return false;
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  storeSet(NOTIFY_KEY, permission === 'granted' ? '1' : '0');
  if (permission !== 'granted') {
    alert('浏览器没有允许通知。可以在地址栏左侧的站点设置里打开“通知”。');
  }
  renderNotifyControls();
  return permission === 'granted';
}

els.chkNotify?.addEventListener('change', async () => {
  if (els.chkNotify.checked) {
    await enableNotifications();
  } else {
    storeSet(NOTIFY_KEY, '0');
    renderNotifyControls();
  }
});
els.btnEnableNotify?.addEventListener('click', () => void enableNotifications());

function flushArrivals() {
  const arrivals = pendingArrivals;
  pendingArrivals = [];
  if (!arrivals.length) return;
  const away = document.hidden || !document.hasFocus();
  if (!away) return; // The list on screen already shows them.
  titleState.unread += arrivals.length;
  updateDocumentTitle();
  if (notificationsAllowed()) {
    const note = new Notification('CrossSync', {
      body: arrivalSummary(arrivals),
      tag: 'crosssync-arrival',
      icon: '/static/app-icon-192.png',
    });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  }
}

// --- New devices asking to connect (shown on the computer only) ---

const deviceRequestsEl = $('device-requests');
const approvedDevicesEl = $('approved-devices');
const notifiedDevices = new Set();

function formatSeen(seconds) {
  return seconds ? formatFileTime(seconds) : '';
}

async function decideDevice(id, action) {
  try {
    await fetchJson(`/api/devices/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  } catch (err) {
    alert(`没能完成操作：${describeError(err)}`);
  }
  void loadDevices();
}

async function forgetDevice(id, name) {
  if (!confirm(`移除“${name}”？它下次连接时需要重新允许。`)) return;
  try {
    await fetchJson(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (err) {
    alert(`没能移除：${describeError(err)}`);
  }
  void loadDevices();
}

function renderDevices(data) {
  if (deviceRequestsEl) {
    const pending = data.pending || [];
    deviceRequestsEl.hidden = pending.length === 0;
    deviceRequestsEl.replaceChildren(...pending.map((item) => h('div', { class: 'device-request' },
      h('div', { class: 'device-request-copy' },
        h('strong', { text: `${item.name} 想连接这台电脑` }),
        h('span', { text: item.address ? `来自 ${item.address}` : '' }),
      ),
      h('div', { class: 'device-request-actions' },
        h('button', { class: 'btn small primary', type: 'button', text: '允许', onclick: () => decideDevice(item.id, 'approve') }),
        h('button', { class: 'btn small ghost', type: 'button', text: '拒绝', onclick: () => decideDevice(item.id, 'deny') }),
      ),
    )));
    pending.forEach((item) => {
      if (notifiedDevices.has(item.id)) return;
      notifiedDevices.add(item.id);
      if ((document.hidden || !document.hasFocus()) && 'Notification' in window && Notification.permission === 'granted') {
        const note = new Notification('CrossSync', { body: `${item.name} 想连接，点这里允许或拒绝`, tag: `device-${item.id}`, icon: '/static/app-icon-192.png' });
        note.onclick = () => { window.focus(); note.close(); };
      }
    });
  }
  if (approvedDevicesEl) {
    const approved = data.approved || [];
    approvedDevicesEl.replaceChildren(...(approved.length
      ? approved.map((item) => h('div', { class: 'device-row' },
        h('div', { class: 'device-row-copy' },
          h('strong', { text: item.name }),
          h('span', { text: item.last_seen ? `最近使用：${formatSeen(item.last_seen)}` : '' }),
        ),
        h('button', { class: 'btn small ghost danger', type: 'button', text: '移除', onclick: () => forgetDevice(item.id, item.name) }),
      ))
      : [h('p', { class: 'subtle', text: data.enabled === false ? '已关闭设备确认，任何拿到二维码的设备都能连接。' : '还没有允许过任何设备。' })]));
  }
}

async function loadDevices() {
  if (!runtimeConfig.isHostDevice) return;
  try {
    renderDevices(await fetchJson('/api/devices'));
  } catch (_) {}
}

function handleLiveEvent(event) {
  if (event?.type === 'device-request' || event?.type === 'device-decided') {
    void loadDevices();
    return;
  }
  if (!['downloads', 'outbox'].includes(event?.area)) return;
  void refreshArea(event.area);
  if (event.type !== 'received') return;
  const id = event.upload_id || '';
  if (id && announcedUploads.has(id)) return; // A retried finish repeats the event.
  if (id) announcedUploads.add(id);
  if (id && ownUploadIds.has(id)) return; // This page sent it.
  if (event.area === 'downloads' && runtimeConfig.isHostDevice) {
    pendingArrivals.push(event);
    window.clearTimeout(arrivalTimer);
    arrivalTimer = window.setTimeout(flushArrivals, 1500);
  }
}

function startLiveEvents() {
  if (!('EventSource' in window)) return;
  const source = new EventSource('/api/events');
  source.onmessage = (message) => {
    try {
      handleLiveEvent(JSON.parse(message.data));
    } catch (_) {}
  };
  // EventSource reconnects on its own; the health check reports the connection state.
}

function clearUnreadArrivals() {
  if (document.hidden || !titleState.unread) return;
  titleState.unread = 0;
  updateDocumentTitle();
}

document.addEventListener('visibilitychange', clearUnreadArrivals);
window.addEventListener('focus', clearUnreadArrivals);
renderNotifyControls();
startLiveEvents();

// --- Save photos and videos from the share box into the iPhone Photos app ---
// Safari only offers "Save Image / Save Video" through the system share sheet,
// and the sheet must open from a tap. Large files take a moment to arrive, so
// the first tap downloads them and, if iOS no longer counts that as the tap,
// the button asks for a second tap that opens the sheet straight away.

const PHOTO_SAVE_LIMIT_BYTES = 1536 * 1024 * 1024; // iPhone Safari memory headroom.
const preparedPhotos = new Map(); // "area:path" -> File

function photoSaveSupported() {
  return window.isSecureContext && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
}

function canOfferPhotoSave(area, path) {
  return area === 'outbox' && !runtimeConfig.isHostDevice && photoSaveSupported() && Boolean(photoMimeType(path));
}

async function fetchAsFile(area, path, onProgress) {
  const res = await fetch(downloadUrl(area, path));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body?.getReader();
  let blob;
  if (reader) {
    const parts = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
    blob = new Blob(parts);
  } else {
    blob = await res.blob();
  }
  return new File([blob], basename(path), { type: photoMimeType(path) || blob.type });
}

async function saveToPhotos(area, paths, button) {
  const mediaPaths = paths.filter((path) => photoMimeType(path));
  if (!mediaPaths.length) return;
  const keyOf = (path) => `${area}:${path}`;
  const original = button?.dataset.label || '存到相册';
  const setLabel = (text, busy = false) => {
    if (!button) return;
    button.textContent = text;
    button.disabled = busy;
  };

  const missing = mediaPaths.filter((path) => !preparedPhotos.has(keyOf(path)));
  if (missing.length) {
    const sizes = new Map(areaState[area].files.map((file) => [file.path, file.size]));
    const totalBytes = mediaPaths.reduce((sum, path) => sum + (sizes.get(path) || 0), 0);
    if (totalBytes > PHOTO_SAVE_LIMIT_BYTES) {
      alert('选中的文件太大，iPhone 浏览器一次装不下。请分几次保存，每次不超过 1.5 GB。');
      return;
    }
    let done = 0;
    try {
      for (const path of missing) {
        preparedPhotos.set(keyOf(path), await fetchAsFile(area, path, (received) => {
          const percent = totalBytes ? Math.min(99, Math.floor(((done + received) / totalBytes) * 100)) : 0;
          setLabel(`准备中 ${percent}%`, true);
        }));
        done += sizes.get(path) || 0;
      }
    } catch (err) {
      setLabel(original);
      alert(`没能从电脑取回文件：${describeError(err)}`);
      return;
    }
  }

  const files = mediaPaths.map((path) => preparedPhotos.get(keyOf(path)));
  if (!navigator.canShare({ files })) {
    setLabel(original);
    alert('这个浏览器不能把这些文件交给“照片”。可以先点文件名下载，再从“文件”App 里存储。');
    return;
  }
  try {
    await navigator.share({ files });
    mediaPaths.forEach((path) => preparedPhotos.delete(keyOf(path)));
    setLabel(original);
  } catch (err) {
    if (err?.name === 'AbortError') {
      setLabel(original); // The share sheet was closed; keep the files ready for another try.
    } else if (err?.name === 'NotAllowedError') {
      setLabel('已准备好，点此存到相册');
    } else {
      setLabel(original);
      alert(`没能打开分享面板：${describeError(err)}`);
    }
  }
}

if (els.btnPhotosSelected) els.btnPhotosSelected.dataset.label = els.btnPhotosSelected.textContent;
els.btnPhotosSelected?.addEventListener('click', () => {
  void saveToPhotos('outbox', selectedPaths('outbox'), els.btnPhotosSelected);
});
if (els.shareHttpsHint) els.shareHttpsHint.hidden = photoSaveSupported();
