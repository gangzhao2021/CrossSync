// CrossSync web client: Shared constants, DOM handles, persisted settings, pending-upload memory,
// theme, small helpers and environment/readiness status.
// Loaded as ordered classic scripts that share one global scope; see app.html.

const $ = (id) => document.getElementById(id);

const THEME_KEY = 'crosssync_theme';
const OPEN_KEY = 'crosssync_open_on_finish';
const DATE_SUBDIR_KEY = 'crosssync_date_subdir';
const VERIFY_KEY = 'crosssync_verify_chunks';
const CLIENT_ID_KEY = 'crosssync_client_id';
const PENDING_UPLOADS_KEY = 'crosssync_pending_uploads_v1';
const PENDING_UPLOAD_TTL_MS = 48 * 60 * 60 * 1000;
const MOBILE_CHUNK_SIZE = 16 * 1024 * 1024;
const MOBILE_MAX_CONCURRENCY = 4;
const DESKTOP_MAX_CONCURRENCY = 4;
const CHUNK_TIMEOUT_MS = 180000;
const MAX_CHUNK_ATTEMPTS = 60;
const WAKE_KEEPALIVE_INTERVAL_MS = 15000;
const WAKE_REQUEST_TIMEOUT_MS = 2500;

const els = {
  themeBtn: $('theme-toggle'),
  themeIcon: $('theme-icon'),
  wakeToggle: $('wake-toggle'),
  wakeStatus: $('wake-status'),
  securityBadge: $('security-badge'),
  appModeBadge: $('app-mode-badge'),
  readinessCard: $('transfer-readiness'),
  readinessTitle: $('readiness-title'),
  readinessCopy: $('readiness-copy'),
  btnEnableWake: $('btn-enable-wake'),
  installGuide: $('install-guide'),
  installCopy: $('install-copy'),
  btnInstallApp: $('btn-install-app'),
  caDownload: $('ca-download'),
  dirToPC: $('dir-pc'),
  dirToIphone: $('dir-iphone'),
  transferTitle: $('transfer-title'),
  directionCopy: $('direction-copy'),
  dropTitle: $('drop-title'),
  dropSubtitle: $('drop-subtitle'),
  dzUpload: $('dropzone-upload'),
  btnChooseUpload: $('btn-choose-upload'),
  inputUpload: $('input-upload'),
  liveTransferRegion: $('transfer-live-region'),
  listUpload: $('upload-list'),
  chkOpen: $('chk-open'),
  chkDateSubdir: $('chk-date-subdir'),
  chkVerify: $('chk-verify'),
  pickerNote: $('picker-note'),
  pendingResume: $('pending-resume'),
  pendingResumeCount: $('pending-resume-count'),
  pendingResumeList: $('pending-resume-list'),
  btnPickToResume: $('btn-pick-to-resume'),
  downloadsPath: $('downloads-path'),
  downloadsPathStatus: $('downloads-path-status'),
  downloadsFree: $('downloads-free'),
  computerName: $('computer-name'),
  computerNameHeading: $('computer-name-heading'),
  btnChooseDownloads: $('btn-choose-downloads'),
  inputOutbox: $('input-outbox'),
  btnSendToIphone: $('btn-send-to-iphone'),
  btnSettings: $('btn-settings'),
  utilityDrawer: $('utility-drawer'),
  utilityBackdrop: $('utility-backdrop'),
  btnCloseUtility: $('btn-close-utility'),
  selectedCount: $('selected-count'),
  selectedMeta: $('selected-meta'),
  selectedMediaGrid: $('selected-media-grid'),
  lanePreparing: $('lane-preparing'),
  laneWaiting: $('lane-waiting'),
  laneUploading: $('lane-uploading'),
  stagePreparingTitle: $('stage-preparing-title'),
  stagePreparingCount: $('stage-preparing-count'),
  stagePreparingCopy: $('stage-preparing-copy'),
  stagePreparingBar: $('stage-preparing-bar'),
  stageWaitingCount: $('stage-waiting-count'),
  stageWaitingCopy: $('stage-waiting-copy'),
  stageWaitingBar: $('stage-waiting-bar'),
  stageUploadCount: $('stage-upload-count'),
  stageUploadCopy: $('stage-upload-copy'),
  stageUploadBar: $('stage-upload-bar'),
  stageSpeedInline: $('stage-speed-inline'),
  btnPauseAll: $('btn-pause-all'),
  btnResumeAll: $('btn-resume-all'),
  btnClearFinished: $('btn-clear-finished'),
  sumActive: $('sum-active'),
  sumCompleted: $('sum-completed'),
  sumFailed: $('sum-failed'),
  sumSpeed: $('sum-speed'),
  sumEta: $('sum-eta'),
  sumBar: $('sum-bar'),
};

const tasks = [];
window.CS_TASKS = tasks;
const runtimeConfig = {
  downloadsDir: '',
  isHostDevice: false,
  canChooseDownloadsDir: false,
  downloadsFreeBytes: null,
  computerName: '',
  lanIp: '',
  requestScheme: '',
  caCertificateAvailable: false,
  configError: false,
};
let taskSeq = 0;
let lastAggBytes = 0;
let lastAggTime = performance.now();
const claimedPendingUploadIds = new Set();

function storeGet(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function storeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {}
}

function legacyPendingUploadIdentity({ relName, size, lastModified, target }) {
  return [target, relName, size, lastModified || 0].map((value) => encodeURIComponent(String(value))).join('|');
}

function randomResumeKey() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fileSampleSignature(file) {
  if (!window.crypto?.subtle || typeof file?.slice !== 'function') return '';
  const sampleSize = 64 * 1024;
  const head = await file.slice(0, Math.min(file.size, sampleSize)).arrayBuffer();
  const tailStart = Math.max(0, file.size - sampleSize);
  const tail = tailStart > 0 ? await file.slice(tailStart, file.size).arrayBuffer() : new ArrayBuffer(0);
  const bytes = new Uint8Array(head.byteLength + tail.byteLength);
  bytes.set(new Uint8Array(head), 0);
  bytes.set(new Uint8Array(tail), head.byteLength);
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function readPendingUploads() {
  try {
    const parsed = JSON.parse(storeGet(PENDING_UPLOADS_KEY, '[]'));
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - PENDING_UPLOAD_TTL_MS;
    return parsed
      .filter((item) => item && typeof item.id === 'string' && Number(item.updatedAt || 0) >= cutoff)
      .slice(0, 500);
  } catch (_) {
    return [];
  }
}

function writePendingUploads(items) {
  storeSet(PENDING_UPLOADS_KEY, JSON.stringify(items.slice(0, 500)));
  renderPendingUploads();
}

async function rememberPendingUpload(file, target, relName) {
  let assetSignature = '';
  try {
    assetSignature = await fileSampleSignature(file);
  } catch (_) {}

  const pending = readPendingUploads();
  const exactLegacyId = legacyPendingUploadIdentity({
    relName,
    size: file.size,
    lastModified: file.lastModified,
    target,
  });
  const match = pending.find((item) => (
    !claimedPendingUploadIds.has(item.id)
    && item.target === target
    && Number(item.size) === file.size
    && (
      (assetSignature && item.assetSignature === assetSignature)
      || item.id === exactLegacyId
    )
  ));
  const resumeKey = match?.resumeKey || (match ? `${file.name}:${file.size}:${file.lastModified}` : randomResumeKey());
  const record = {
    id: match?.id || [target, resumeKey].map((value) => encodeURIComponent(String(value))).join('|'),
    resumeKey,
    assetSignature,
    name: file.name || relName,
    relName,
    size: file.size,
    lastModified: file.lastModified || 0,
    target,
    updatedAt: Date.now(),
  };
  claimedPendingUploadIds.add(record.id);
  const existing = pending.filter((item) => item.id !== record.id);
  writePendingUploads([record, ...existing]);
  return record;
}

function forgetPendingUpload(id) {
  if (!id) return;
  claimedPendingUploadIds.delete(id);
  writePendingUploads(readPendingUploads().filter((item) => item.id !== id));
}

function releasePendingUpload(id) {
  if (id) claimedPendingUploadIds.delete(id);
}

function renderPendingUploads() {
  if (!els.pendingResume) return;
  const pending = readPendingUploads().filter((item) => item.target === 'downloads');
  els.pendingResume.hidden = pending.length === 0;
  if (!pending.length) return;
  if (els.pendingResumeCount) els.pendingResumeCount.textContent = String(pending.length);
  if (els.pendingResumeList) {
    const names = pending.slice(0, 3).map((item) => item.name).join('、');
    const more = pending.length > 3 ? ` 等 ${pending.length} 项` : '';
    els.pendingResumeList.textContent = `${names}${more}；重新选择原文件后自动跳过已完成分片。`;
  }
}

function browserClientId() {
  let value = storeGet(CLIENT_ID_KEY);
  if (!value) {
    value = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    storeSet(CLIENT_ID_KEY, value);
  }
  return value;
}

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.setAttribute('data-theme', mode);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

let themeMode = storeGet(THEME_KEY, 'auto');
applyTheme(themeMode);
if (els.themeBtn) {
  const renderTheme = () => {
    const label = themeMode === 'auto' ? '主题：跟随系统' : themeMode === 'light' ? '主题：浅色' : '主题：深色';
    if (els.themeIcon) {
      els.themeIcon.src = themeMode === 'light'
        ? '/static/icons/tabler/sun.svg'
        : '/static/icons/tabler/moon.svg';
    }
    els.themeBtn.title = label;
    els.themeBtn.setAttribute('aria-label', `${label}，点击切换`);
  };
  renderTheme();
  els.themeBtn.addEventListener('click', () => {
    themeMode = themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto';
    storeSet(THEME_KEY, themeMode);
    applyTheme(themeMode);
    renderTheme();
  });
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === false || value === null || value === undefined) return;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  });
  children.flat().forEach((child) => {
    if (child === null || child === undefined) return;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return el;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class UploadLanePool {
  constructor(limit) {
    this.limit = Math.max(1, limit || 1);
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.waiters.shift()?.();
    };
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = value >= 10 || idx === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[idx]}`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  if (seconds < 60) return `${seconds.toFixed(0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes} 分 ${rest} 秒`;
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function basename(path) {
  return String(path).split('/').filter(Boolean).pop() || path;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.detail || '';
    } catch (_) {}
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function hasActiveTransfers() {
  return tasks.some((task) => ['preparing', 'active', 'paused', 'finishing'].includes(task.state));
}

function isAppleMobile() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function uploadChunkSize() {
  return isAppleMobile() ? MOBILE_CHUNK_SIZE : DEFAULT_CHUNK;
}

function uploadConcurrency(missingCount) {
  const cap = isAppleMobile() ? MOBILE_MAX_CONCURRENCY : DESKTOP_MAX_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY || 1, cap, Math.max(1, missingCount || 1)));
}

// One shared pool avoids hundreds of simultaneous requests when a user picks a
// large photo batch, while still keeping all four LAN lanes busy.
const uploadLanePool = new UploadLanePool(Math.min(MAX_CONCURRENCY || 1, MOBILE_MAX_CONCURRENCY));

function shouldVerifyUploadChunks() {
  return storeGet(VERIFY_KEY) === '1' && !isAppleMobile();
}

function shouldUseStreamUpload(file) {
  // iOS can suspend Safari at any time. Always use the resumable chunk protocol
  // so even small photos never have to restart from byte zero after interruption.
  return false;
}

function isStandaloneMode() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function hasTrustedHttpsContext() {
  return runtimeConfig.requestScheme === 'https' && window.isSecureContext;
}

let deferredInstallPrompt = null;
let currentWakeMode = 'off';

function updateReadiness(mode = 'off') {
  currentWakeMode = mode;
  if (!els.readinessCard) return;
  let tone = 'idle';
  let title = '传输开始时自动常亮';
  let copy = hasTrustedHttpsContext() && 'wakeLock' in navigator
    ? '已具备原生常亮能力；传输期间请保持 CrossSync 在前台。'
    : '当前只能使用视频守护，iOS 仍可能锁屏；建议使用 HTTPS 并添加到主屏幕。';
  let button = '立即开启';

  if (mode === 'starting') {
    tone = 'warning';
    title = '正在开启常亮守护';
    copy = '正在向系统申请屏幕常亮权限。';
  } else if (mode === 'native') {
    tone = 'active';
    title = '原生常亮已开启';
    copy = '系统 Wake Lock 正在工作；不要切到其他 App 或手动锁屏。';
    button = '关闭常亮';
  } else if (mode === 'native+video') {
    tone = 'active';
    title = '双重常亮守护已开启';
    copy = '原生 Wake Lock 与视频守护同时工作；传输期间保持本页前台。';
    button = '关闭常亮';
  } else if (mode === 'video') {
    tone = 'warning';
    title = '视频守护已开启';
    copy = '这是兼容模式，不能完全保证 iOS 不锁屏；HTTPS 主屏幕模式更可靠。';
    button = '关闭常亮';
  } else if (mode === 'blocked') {
    tone = 'warning';
    title = '常亮未能启用';
    copy = '请点“重新开启”，并确认没有开启低电量模式。';
    button = '重新开启';
  } else if (mode === 'picker') {
    title = '正在由 iOS 准备照片';
    copy = '相册返回网页后才会启动常亮和传输。';
    button = '等待返回';
  } else if (mode === 'released') {
    tone = 'warning';
    title = '常亮被系统释放';
    copy = '回到本页并点一下即可重新开启。';
    button = '重新开启';
  }

  els.readinessCard.dataset.tone = tone;
  if (els.readinessTitle) els.readinessTitle.textContent = title;
  if (els.readinessCopy) els.readinessCopy.textContent = copy;
  if (els.btnEnableWake) {
    els.btnEnableWake.textContent = button;
    els.btnEnableWake.disabled = mode === 'picker';
  }
}

function renderEnvironmentStatus() {
  const secure = hasTrustedHttpsContext();
  const standalone = isStandaloneMode();
  document.documentElement.classList.toggle('secure-context', secure);
  document.documentElement.classList.toggle('standalone-mode', standalone);

  if (els.securityBadge) {
    const label = els.securityBadge.querySelector('strong') || els.securityBadge;
    label.textContent = secure ? 'HTTPS 加密连接' : '本地连接 · 未加密';
    els.securityBadge.classList.toggle('warning', !secure);
  }
  if (els.appModeBadge) {
    els.appModeBadge.textContent = standalone ? '主屏幕应用' : '浏览器模式';
  }
  if (els.caDownload) els.caDownload.hidden = !runtimeConfig.caCertificateAvailable;
  if (els.installGuide) els.installGuide.hidden = !isAppleMobile() || standalone;
  if (els.btnInstallApp) {
    els.btnInstallApp.textContent = deferredInstallPrompt ? '安装应用' : '查看安装步骤';
  }
  updateReadiness(currentWakeMode);
}
