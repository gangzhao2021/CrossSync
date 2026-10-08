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
    empty: '电脑接收区暂无文件',
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
    empty: 'iPhone 共享箱暂无文件',
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
    const download = alreadyOnHost
      ? h('span', { class: 'saved-badge', text: '已在电脑' })
      : h('a', { class: 'btn small', href: downloadUrl(area, file.path), download: basename(file.path), text: '下载' });
    if (!alreadyOnHost) download.addEventListener('click', () => wakeKeeper.enable('auto'));

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
    const data = await fetchJson(`/api/list/${area}`);
    const snapshot = JSON.stringify(data.files || []);
    if (snapshot === cfg.serverSnapshot) return;
    cfg.serverSnapshot = snapshot;
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
  refreshArea('downloads');
  refreshArea('outbox');
});

$('nav-to-computer')?.addEventListener('click', () => {
  setDirection('downloads');
  els.dzUpload?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  els.btnChooseUpload?.focus({ preventScroll: true });
});

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
