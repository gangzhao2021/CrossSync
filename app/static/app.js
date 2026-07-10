const $ = (id) => document.getElementById(id);

const THEME_KEY = 'crosssync_theme';
const OPEN_KEY = 'crosssync_open_on_finish';
const DATE_SUBDIR_KEY = 'crosssync_date_subdir';
const VERIFY_KEY = 'crosssync_verify_chunks';
const CLIENT_ID_KEY = 'crosssync_client_id';
const MOBILE_CHUNK_SIZE = 16 * 1024 * 1024;
const MOBILE_MAX_CONCURRENCY = 4;
const DESKTOP_MAX_CONCURRENCY = 4;
const CHUNK_TIMEOUT_MS = 180000;
const MAX_CHUNK_ATTEMPTS = 8;
const WAKE_KEEPALIVE_INTERVAL_MS = 15000;
const WAKE_REQUEST_TIMEOUT_MS = 2500;

const els = {
  themeBtn: $('theme-toggle'),
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
  inputUpload: $('input-upload'),
  listUpload: $('upload-list'),
  chkOpen: $('chk-open'),
  chkDateSubdir: $('chk-date-subdir'),
  chkVerify: $('chk-verify'),
  pickerNote: $('picker-note'),
  downloadsPath: $('downloads-path'),
  downloadsPathStatus: $('downloads-path-status'),
  downloadsFree: $('downloads-free'),
  computerName: $('computer-name'),
  btnChooseDownloads: $('btn-choose-downloads'),
  inputOutbox: $('input-outbox'),
  btnSendToIphone: $('btn-send-to-iphone'),
  btnSettings: $('btn-settings'),
  utilityDrawer: $('utility-drawer'),
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
    els.themeBtn.textContent = themeMode === 'dark' ? '☾' : themeMode === 'light' ? '☼' : '◐';
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

function shouldVerifyUploadChunks() {
  return storeGet(VERIFY_KEY) === '1' && !isAppleMobile();
}

function shouldUseStreamUpload(file) {
  return isAppleMobile() && file.size <= 32 * 1024 * 1024 && storeGet(VERIFY_KEY) !== '1';
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
    els.securityBadge.textContent = secure ? 'HTTPS 安全连接' : 'HTTP 降级模式';
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

async function initPwa() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch (_) {}
  }
  renderEnvironmentStatus();
}

class WakeKeeper {
  constructor(button, statusEl) {
    this.button = button;
    this.statusEl = statusEl;
    this.sentinel = null;
    this.video = null;
    this.mode = 'off';
    this.manual = false;
    this.wanted = false;
    this.guard = null;
    this.keepAliveTimer = null;
    this.enabling = false;
    this.pickerSuspended = false;

    this.button?.addEventListener('click', () => this.toggleManual());
    const resumeKeepAwake = () => {
      if (this.pickerSuspended) this.resumeAfterPicker();
      if (!document.hidden && (this.wanted || this.manual || hasActiveTransfers())) {
        this.enable('auto');
      }
    };
    document.addEventListener('visibilitychange', resumeKeepAwake);
    window.addEventListener('pageshow', resumeKeepAwake);
    window.addEventListener('focus', resumeKeepAwake);
    document.addEventListener('pointerdown', resumeKeepAwake, { passive: true });
    document.addEventListener('touchstart', resumeKeepAwake, { passive: true });
  }

  ensureVideo() {
    if (this.video) return this.video;
    const guard = document.createElement('div');
    guard.className = 'wake-video-guard';
    guard.hidden = true;
    const video = document.createElement('video');
    video.src = '/static/keep-awake.mp4';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-hidden', 'true');
    video.disablePictureInPicture = true;
    video.addEventListener('ended', () => video.play().catch(() => {}));
    video.addEventListener('pause', () => {
      if (!this.pickerSuspended && (this.wanted || this.manual || hasActiveTransfers())) {
        window.setTimeout(() => video.play().catch(() => {}), 250);
      }
    });
    guard.append(video);
    document.body.append(guard);
    this.guard = guard;
    this.video = video;
    return video;
  }

  setGuardVisible(active) {
    if (!this.guard) return;
    this.guard.hidden = !(active && isAppleMobile());
  }

  startKeepAliveLoop() {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = window.setInterval(() => {
      if (this.pickerSuspended) return;
      if (!(this.wanted || this.manual || hasActiveTransfers())) {
        this.stopKeepAliveLoop();
        return;
      }
      if (this.video?.paused) {
        this.video.play().catch(() => {});
      }
      if (!this.sentinel && !document.hidden && 'wakeLock' in navigator) {
        navigator.wakeLock.request('screen')
          .then((sentinel) => {
            this.sentinel = sentinel;
            this.mode = 'native';
            this.setState('原生常亮', 'active', this.mode);
            sentinel.addEventListener('release', () => {
              this.sentinel = null;
              this.mode = 'released';
              this.setState('需恢复', 'warning', this.mode);
            });
          })
          .catch(() => {});
      }
    }, WAKE_KEEPALIVE_INTERVAL_MS);
  }

  stopKeepAliveLoop() {
    if (!this.keepAliveTimer) return;
    window.clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  async playVideoFallback() {
    const video = this.ensureVideo();
    this.setGuardVisible(true);
    try {
      video.muted = true;
      video.playsInline = true;
      if (video.readyState < 2) video.load();
      await video.play();
      return true;
    } catch (_) {
      return false;
    }
  }

  setState(label, tone = 'idle', mode = this.mode) {
    if (this.statusEl) this.statusEl.textContent = label;
    if (!this.button) return;
    this.button.classList.toggle('is-active', tone === 'active');
    this.button.classList.toggle('is-warning', tone === 'warning');
    this.button.setAttribute('aria-pressed', tone === 'active' ? 'true' : 'false');
    updateReadiness(mode);
  }

  async enable(source = 'auto') {
    if (this.pickerSuspended) return false;
    if (this.enabling) return true;
    if (source === 'manual') this.manual = true;
    this.wanted = true;
    this.enabling = true;
    this.startKeepAliveLoop();
    this.mode = 'starting';
    this.setState('启动中', 'warning', this.mode);

    try {
      let nativeOk = Boolean(this.sentinel);
      if (!this.sentinel && 'wakeLock' in navigator) {
        try {
          let timedOut = false;
          const request = navigator.wakeLock.request('screen').then((sentinel) => {
            if (timedOut) {
              sentinel.release().catch(() => {});
              return null;
            }
            return sentinel;
          });
          const candidate = await Promise.race([
            request,
            delay(WAKE_REQUEST_TIMEOUT_MS).then(() => {
              timedOut = true;
              return null;
            }),
          ]);
          if (candidate) {
            this.sentinel = candidate;
            this.sentinel.addEventListener('release', () => {
              this.sentinel = null;
              if (this.wanted || this.manual || hasActiveTransfers()) {
                this.mode = 'released';
                this.setState('需恢复', 'warning', this.mode);
                if (!document.hidden) window.setTimeout(() => this.enable('auto'), 0);
              }
            });
            nativeOk = true;
          }
        } catch (_) {}
      }

      const videoOk = isAppleMobile() || !nativeOk ? await this.playVideoFallback() : false;
      if (nativeOk || videoOk) {
        this.mode = nativeOk && videoOk ? 'native+video' : nativeOk ? 'native' : 'video';
        const label = this.mode === 'native+video' ? '双重守护' : this.mode === 'native' ? '原生常亮' : '视频守护';
        this.setState(label, this.mode === 'video' ? 'warning' : 'active', this.mode);
        return true;
      }

      this.mode = 'blocked';
      this.setState('需手动', 'warning', this.mode);
      return false;
    } finally {
      this.enabling = false;
    }
  }

  async requestForTransfer() {
    const enabled = await this.enable('auto');
    window.setTimeout(() => this.releaseIfIdle(), 30000);
    return enabled;
  }

  async toggleManual() {
    if (this.manual || (this.wanted && !hasActiveTransfers())) {
      this.manual = false;
      this.wanted = false;
      await this.release();
      return;
    }
    await this.enable('manual');
  }

  async suspendForPicker() {
    this.pickerSuspended = true;
    this.stopKeepAliveLoop();
    try {
      if (this.sentinel) await this.sentinel.release();
    } catch (_) {}
    this.sentinel = null;
    if (this.video) {
      try {
        this.video.pause();
      } catch (_) {}
    }
    this.setGuardVisible(false);
    this.mode = 'picker';
    this.setState('选取中', 'idle', this.mode);
  }

  resumeAfterPicker() {
    if (!this.pickerSuspended) return;
    this.pickerSuspended = false;
    if (this.manual || hasActiveTransfers()) this.enable('auto');
    else {
      this.mode = 'off';
      this.setState('未启用', 'idle', this.mode);
    }
  }

  async release() {
    this.stopKeepAliveLoop();
    try {
      if (this.sentinel) await this.sentinel.release();
    } catch (_) {}
    this.sentinel = null;

    if (this.video) {
      try {
        this.video.pause();
        this.video.currentTime = 0;
      } catch (_) {}
    }
    this.setGuardVisible(false);

    this.mode = 'off';
    this.setState('未启用', 'idle', this.mode);
  }

  releaseIfIdle() {
    if (this.manual || hasActiveTransfers()) return;
    this.wanted = false;
    this.release();
  }
}

const wakeKeeper = new WakeKeeper(els.wakeToggle, els.wakeStatus);
els.btnEnableWake?.addEventListener('click', () => wakeKeeper.toggleManual());

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  renderEnvironmentStatus();
});

els.btnInstallApp?.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null;
    renderEnvironmentStatus();
    return;
  }
  if (els.installCopy) {
    els.installCopy.textContent = 'iPhone：点 Safari 的分享按钮，再选“添加到主屏幕”；安装后从桌面图标打开。';
  }
});

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
    els.computerName.textContent = 'Home PC';
    els.computerName.title = runtimeConfig.computerName || '运行 CrossSync 的电脑';
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
  const cancelBtn = h('button', { class: 'btn small ghost', type: 'button', text: '取消' });
  resumeBtn.disabled = true;

  const item = h('div', { class: 'task-item' },
    h('div', { class: 'task-top' },
      h('div', { class: 'task-title' }, title, route),
      stateSpan
    ),
    h('div', { class: 'bar' }, barInner),
    h('div', { class: 'task-meta' }, sizeSpan, h('span', { text: '·' }), speedSpan, h('span', { text: '·' }), etaSpan),
    h('div', { class: 'task-actions' }, pauseBtn, resumeBtn, cancelBtn),
    hashLine
  );

  els.listUpload?.prepend(item);
  return { item, barInner, sizeSpan, speedSpan, etaSpan, stateSpan, hashLine, pauseBtn, resumeBtn, cancelBtn };
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
  ui.cancelBtn.disabled = ['completed', 'failed', 'cancelled'].includes(task.state);
  if (task.lastError && ['active', 'failed'].includes(task.state)) {
    ui.hashLine.textContent = task.lastError;
  } else if (task.state !== 'completed') {
    ui.hashLine.textContent = '';
  }
  updateSummary();
}

async function uploadChunkWithRetry({ uploadId, idx, chunk, verify, task, controllers, render }) {
  for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt += 1) {
    while (task.state === 'paused') await delay(150);
    if (task.state === 'cancelled') throw new Error('cancelled');

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
  const ui = createTaskItem(file, target);
  const controllers = new Set();
  let fatalError = null;

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
      if (['completed', 'failed', 'cancelled'].includes(this.state)) return;
      this.state = 'cancelled';
      controllers.forEach((controller) => controller.abort());
      renderTask(this, ui);
      wakeKeeper.releaseIfIdle();
    },
  };

  ui.item.dataset.taskId = String(task.id);
  ui.pauseBtn.addEventListener('click', () => task.pause());
  ui.resumeBtn.addEventListener('click', () => task.resume());
  ui.cancelBtn.addEventListener('click', () => task.cancel());
  tasks.push(task);
  renderTask(task, ui);

  try {
    await wakeKeeper.requestForTransfer();
    const relName = buildRelName(file);
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
        if (task.state === 'cancelled') return;
        task.uploaded = task.size;
        task.state = 'completed';
        if (streamRes?.sha256) ui.hashLine.textContent = `SHA-256: ${streamRes.sha256}`;
        renderTask(task, ui);
        refreshArea(target);
        return;
      } catch (err) {
        if (task.state === 'cancelled') return;
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
        resume_key: `${file.name}:${file.size}:${file.lastModified}`,
        target,
      }),
    });

    if (task.state === 'cancelled') return;

    const uploadId = initRes.upload_id;
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

    if (task.state === 'cancelled') return;
    if (fatalError) throw fatalError;

    task.state = 'finishing';
    renderTask(task, ui);
    const open = storeGet(OPEN_KEY) === '1';
    const checksum = storeGet(VERIFY_KEY) === '1' && !isAppleMobile();
    const finishRes = await fetchJson(`/api/finish-upload/${uploadId}?open=${open ? 1 : 0}&checksum=${checksum ? 1 : 0}`, { method: 'POST' });

    task.uploaded = task.size;
    task.state = 'completed';
    if (finishRes?.sha256) ui.hashLine.textContent = `SHA-256: ${finishRes.sha256}`;
    renderTask(task, ui);
    refreshArea(target);
  } catch (err) {
    if (task.state !== 'cancelled') {
      task.state = 'failed';
      ui.hashLine.textContent = err?.message ? `错误：${err.message}` : '传输失败';
      renderTask(task, ui);
    }
  } finally {
    wakeKeeper.releaseIfIdle();
  }
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
  const selected = [...files].filter(Boolean);
  if (!selected.length) {
    wakeKeeper.releaseIfIdle();
    return;
  }
  renderSelection(selected);
  wakeKeeper.requestForTransfer();
  selected.forEach((file) => startUpload(file, target));
  if (els.inputUpload) els.inputUpload.value = '';
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
    if (event.target.closest?.('.pick-btn, .choose-photos-button')) return;
    els.inputUpload.click();
  });
  els.dzUpload.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.inputUpload.click();
    }
  });
  els.inputUpload.addEventListener('click', () => wakeKeeper.suspendForPicker());
  els.inputUpload.addEventListener('cancel', () => wakeKeeper.resumeAfterPicker());
  els.inputUpload.addEventListener('change', (event) => handleFiles(event.target.files, 'downloads'));
}

if (els.btnSendToIphone && els.inputOutbox) {
  els.btnSendToIphone.addEventListener('click', () => els.inputOutbox.click());
  els.inputOutbox.addEventListener('change', (event) => {
    handleFiles(event.target.files, 'outbox');
    els.inputOutbox.value = '';
  });
}

els.btnSettings?.addEventListener('click', () => {
  if (!els.utilityDrawer) return;
  els.utilityDrawer.open = true;
  els.utilityDrawer.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

els.btnPauseAll?.addEventListener('click', () => tasks.forEach((task) => task.pause?.()));
els.btnResumeAll?.addEventListener('click', () => tasks.forEach((task) => task.resume?.()));
els.btnClearFinished?.addEventListener('click', () => {
  for (let idx = tasks.length - 1; idx >= 0; idx -= 1) {
    const task = tasks[idx];
    if (['completed', 'cancelled'].includes(task.state)) {
      document.querySelector(`[data-task-id="${task.id}"]`)?.remove();
      tasks.splice(idx, 1);
    }
  }
  updateSummary();
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
  if (!file.sha256) return '无校验值';
  if (!file.checksum_fresh) return '校验值待复核';
  return file.checksum_source === 'sidecar' ? '旧校验值' : '有校验值';
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
      text: `${formatBytes(file.size)} · ${new Date(file.mtime * 1000).toLocaleString()} · ${checksumLabel(file)}`,
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
        checkbox,
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
  try {
    const statusByPath = new Map(cfg.files.map((file) => [
      file.path,
      {
        verifyStatusText: file.verifyStatusText,
        verifyStatusTone: file.verifyStatusTone,
      },
    ]));
    const data = await fetchJson(`/api/list/${area}`);
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
  if (!confirm(`确定删除 ${label} 中选中的 ${paths.length} 个文件吗？`)) return;
  await fetchJson('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ area, paths }),
  });
  await refreshArea(area);
}

async function clearArea(area) {
  const label = area === 'downloads' ? '电脑接收区' : 'iPhone 共享箱';
  if (!confirm(`确定清空${label}吗？此操作不可撤销。`)) return;
  await fetchJson('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ area, clear: true }),
  });
  await refreshArea(area);
}

Object.entries(areaState).forEach(([area, cfg]) => {
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
initPwa();
setInterval(() => {
  if (!hasActiveTransfers()) refreshArea('downloads');
}, 15000);
setInterval(() => {
  if (!hasActiveTransfers()) refreshArea('outbox');
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
