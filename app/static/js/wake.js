// CrossSync web client: PWA registration and the keep-awake guard (Screen Wake Lock + video fallback).
// Loaded as ordered classic scripts that share one global scope; see app.html.

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
