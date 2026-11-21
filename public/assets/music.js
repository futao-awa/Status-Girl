(() => {
  const json = async (url, options = {}) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json', ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '音乐服务请求失败');
    return payload;
  };

  class PlatformMusicPlayer {
    constructor(root) {
      this.root = root;
      this.toggle = root.querySelector('#musicToggle');
      this.previous = root.querySelector('#musicPrev');
      this.next = root.querySelector('#musicNext');
      this.random = root.querySelector('#musicRandom');
      this.repeat = root.querySelector('#musicRepeat');
      this.volume = root.querySelector('#musicVolume');
      this.volumeToggle = root.querySelector('#musicVolumeToggle');
      this.title = root.querySelector('#musicTitle');
      this.state = root.querySelector('#musicState');
      this.fill = root.querySelector('#musicProgressFill');
      this.seek = root.querySelector('#musicSeek');
      this.time = root.querySelector('#musicTime');
      this.audio = new Audio();
      this.audio.preload = 'metadata';
      this.config = { configured: true, loggedIn: false, providerLabel: '平台音乐', playlistName: '', queue: [], randomEnabled: true, playMode: 'random' };
      this.queue = [];
      this.trackIndex = -1;
      this.history = [];
      this.isPlaying = false;
      this.repeatMode = 'all';
      this.loadingTrack = false;
      this.shuffle = true;
      this.autoplayBlocked = false;
      this.played = new Set();
      this.scrubbing = false;
      this.previewTime = null;
      this.isPreview = false;
      this.bind();
      this.loadConfig();
    }

    bind() {
      this.toggle?.addEventListener('click', () => this.togglePlayback());
      this.previous?.addEventListener('click', () => this.playPrevious());
      this.next?.addEventListener('click', () => this.playNext());
      this.random?.addEventListener('click', () => { this.shuffle = !this.shuffle; this.played.clear(); this.setState(this.shuffle ? '已切换随机播放' : '已切换顺序播放'); this.render(); });
      this.repeat?.addEventListener('click', () => this.toggleRepeat());
      this.volumeToggle?.addEventListener('click', (event) => { event.stopPropagation(); this.root.classList.toggle('volume-open'); });
      this.volume?.addEventListener('input', () => { this.audio.volume = Number(this.volume.value); this.paintVolume(); });
      this.seek?.addEventListener('pointerdown', () => { if (!this.seek.disabled) this.scrubbing = true; });
      this.seek?.addEventListener('input', () => {
        const duration = this.duration();
        if (!duration) return;
        this.previewTime = Number(this.seek.value) / 1000 * duration;
        if (!this.scrubbing) this.seekTo(this.previewTime);
        this.renderProgress();
      });
      this.seek?.addEventListener('change', () => {
        this.seekTo(Number(this.seek.value) / 1000 * this.duration());
        this.scrubbing = false;
        this.previewTime = null;
        this.renderProgress();
      });
      this.seek?.addEventListener('pointercancel', () => { this.scrubbing = false; this.previewTime = null; this.renderProgress(); });
      this.seek?.addEventListener('blur', () => { this.scrubbing = false; this.previewTime = null; this.renderProgress(); });
      document.addEventListener('click', (event) => { if (!this.root.contains(event.target)) this.root.classList.remove('volume-open'); });
      this.audio.volume = Number(this.volume?.value || 0.28);
      this.audio.addEventListener('timeupdate', () => this.renderProgress());
      this.audio.addEventListener('loadedmetadata', () => this.renderProgress());
      this.audio.addEventListener('durationchange', () => this.renderProgress());
      this.audio.addEventListener('emptied', () => this.renderProgress());
      this.audio.addEventListener('ended', () => this.handleEnded());
      this.audio.addEventListener('play', () => { this.isPlaying = true; this.autoplayBlocked = false; this.setState(this.isPreview ? '正在试听 · 完整播放受平台限制' : '正在播放'); this.render(); });
      this.audio.addEventListener('pause', () => { this.isPlaying = false; if (!this.loadingTrack && !this.audio.ended) this.setState('已暂停'); this.render(); });
      this.audio.addEventListener('error', () => { this.isPlaying = false; this.setState('当前音源无法播放 · 请切换歌曲'); this.render(); });
      const resumeAutoplay = (event) => {
        if (!event.isTrusted || !this.autoplayBlocked || !this.audio.src || this.root.contains(event.target)) return;
        this.audio.play().catch(() => {});
      };
      document.addEventListener('pointerdown', resumeAutoplay, { passive: true });
      document.addEventListener('keydown', resumeAutoplay);
      this.paintVolume();
    }

    async loadConfig() {
      try {
        this.config = await json('/api/music/config');
        this.queue = Array.isArray(this.config.queue) ? this.config.queue : [];
        this.shuffle = this.config.playMode === 'random';
        this.render();
        const autoplay = this.root.dataset?.autoplay !== 'false';
        this.setState(this.config.loggedIn ? (autoplay ? '正在准备音乐…' : '点击播放以试听') : '请在后台连接音乐平台');
        if (autoplay && this.config.loggedIn && (this.queue.length || this.config.randomEnabled !== false)) {
          this.shuffle ? this.playRandomTrack(false, true) : this.playTrack(0, true);
        }
      } catch (error) { this.setState(error.message); }
    }

    setState(message) { if (this.state) this.state.textContent = message; this.emitState(); }

    emitState() {
      this.root.dispatchEvent?.(new CustomEvent('pulse-music-change', { bubbles: true, detail: { track: this.queue[this.trackIndex] || null, playing: this.isPlaying, message: this.state?.textContent || '', count: this.queue.length } }));
    }

    updateQueue(queue, config = {}) {
      const currentId = this.queue[this.trackIndex]?.id;
      this.config = { ...this.config, ...config };
      this.queue = Array.isArray(queue) ? queue : [];
      this.trackIndex = currentId == null ? -1 : this.queue.findIndex((track) => track.id === currentId);
      this.history = [];
      this.played.clear();
      if (currentId != null && this.trackIndex < 0) {
        this.audio.pause();
        this.audio.src = '';
        this.audio.load();
        this.isPlaying = false;
        this.setState('队列已更新 · 点击播放以试听');
      }
      this.render();
    }

    paintVolume() {
      if (!this.volume) return;
      const percent = Math.round(Number(this.volume.value || 0) * 100);
      this.volume.style.background = `linear-gradient(90deg, #84afd9 0 ${percent}%, rgba(113,145,177,.2) ${percent}% 100%)`;
    }

    async loadRandomQueue() {
      const result = await json('/api/music/random');
      this.queue = Array.isArray(result.queue) ? result.queue : [];
      this.config.playlistName = result.playlistName || '平台随机音乐';
      return this.queue;
    }

    nextIndex(random = false) {
      if (!this.queue.length) return -1;
      if (random || this.shuffle) {
        if (this.queue.length < 2) return 0;
        let index = Math.floor(Math.random() * this.queue.length);
        while (index === this.trackIndex) index = Math.floor(Math.random() * this.queue.length);
        return index;
      }
      return (this.trackIndex + 1) % this.queue.length;
    }

    async playTrack(index, autoplay = true, remember = true) {
      if (index < 0 || !this.queue[index] || this.loadingTrack) return;
      const track = this.queue[index];
      this.loadingTrack = true;
      this.render();
      try {
        this.setState('正在准备音源…');
        const result = await json(`/api/music/track/${encodeURIComponent(track.id)}/url`);
        if (!result.url) throw new Error('当前歌曲没有可播放音源');
        if (remember && this.trackIndex >= 0 && this.trackIndex !== index) this.history.push(this.trackIndex);
        this.history = this.history.slice(-30);
        this.trackIndex = index;
        this.isPreview = result.preview === true;
        this.played.add(index);
        this.isPlaying = false;
        this.autoplayBlocked = false;
        this.audio.src = result.url;
        this.scrubbing = false;
        this.previewTime = null;
        this.audio.load();
        this.setState('等待播放');
        this.render();
        if (autoplay) {
          try { await this.audio.play(); }
          catch (error) { this.autoplayBlocked = error.name === 'NotAllowedError'; this.setState(this.autoplayBlocked ? '自动播放受限 · 点击页面后播放' : error.message); }
        }
      } catch (error) { this.setState(error.message); this.isPlaying = false; this.render(); }
      finally { this.loadingTrack = false; this.render(); }
    }

    async playRandomTrack(forceNext = true, autoplay = true) {
      if (!this.config.loggedIn) return this.setState('请在后台连接音乐平台');
      if (!this.queue.length && this.config.randomEnabled !== false) {
        try { await this.loadRandomQueue(); } catch (error) { return this.setState(error.message); }
      }
      if (!this.queue.length) return this.setState('请在后台选择歌单或启用随机音乐');
      const index = this.nextIndex(true);
      await this.playTrack(index, autoplay, forceNext);
    }

    async playNext() {
      this.played.clear();
      if (!this.queue.length && this.config.randomEnabled !== false) return this.playRandomTrack(true);
      if (!this.queue.length) return this.setState('播放队列为空');
      await this.playTrack(this.nextIndex(false), true);
    }

    async playPrevious() {
      this.played.clear();
      const index = this.history.pop();
      if (Number.isInteger(index)) return this.playTrack(index, true, false);
      if (this.queue.length) return this.playTrack((this.trackIndex - 1 + this.queue.length) % this.queue.length, true, false);
      this.setState('没有上一首');
    }

    async togglePlayback() {
      if (!this.config.loggedIn) return this.setState('请在后台连接音乐平台');
      if (!this.audio.src) return this.playRandomTrack(false);
      if (this.audio.paused) {
        try { await this.audio.play(); }
        catch (error) { this.setState(error.message); }
      } else { this.autoplayBlocked = false; this.audio.pause(); }
    }

    toggleRepeat() {
      this.repeatMode = this.repeatMode === 'off' ? 'all' : this.repeatMode === 'all' ? 'one' : 'off';
      this.render();
    }

    async handleEnded() {
      if (this.repeatMode === 'one') return this.playTrack(this.trackIndex, true, false);
      if (this.shuffle) {
        const remaining = this.queue.map((_track, index) => index).filter((index) => !this.played.has(index));
        if (remaining.length) return this.playTrack(remaining[Math.floor(Math.random() * remaining.length)], true);
        if (this.repeatMode === 'all' && this.queue.length) { this.played.clear(); return this.playTrack(this.nextIndex(true), true); }
      } else if (this.trackIndex < this.queue.length - 1 || (this.repeatMode === 'all' && this.queue.length)) {
        return this.playTrack((this.trackIndex + 1) % this.queue.length, true);
      }
      this.setState('队列播放完成');
      this.render();
    }

    formatTime(value) {
      if (!Number.isFinite(value)) return '00:00';
      const seconds = Math.max(0, Math.floor(value));
      return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }

    duration() {
      return Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : 0;
    }

    seekTo(seconds) {
      const duration = this.duration();
      if (!duration || !Number.isFinite(seconds) || this.loadingTrack) return;
      try { this.audio.currentTime = Math.max(0, Math.min(seconds, duration)); }
      catch { this.setState('当前音源暂不支持跳转'); }
    }

    renderProgress() {
      const duration = this.duration();
      const current = this.previewTime ?? (this.audio.currentTime || 0);
      if (this.fill) this.fill.style.transform = `scaleX(${duration ? Math.min(1, current / duration) : 0})`;
      if (this.time) this.time.textContent = `${this.formatTime(current)} / ${this.formatTime(duration)}`;
      if (this.seek) {
        this.seek.disabled = !duration || this.loadingTrack;
        if (!this.scrubbing) this.seek.value = String(duration ? Math.round(current / duration * 1000) : 0);
        this.seek.setAttribute('aria-valuetext', `${this.formatTime(current)} / ${this.formatTime(duration)}`);
      }
    }

    render() {
      const track = this.queue[this.trackIndex];
      if (this.root.querySelector('#musicProviderMini')) this.root.querySelector('#musicProviderMini').textContent = this.config.providerLabel || '平台音乐';
      if (this.title) this.title.textContent = track ? `${track.title} · ${track.artist}` : (this.config.playlistName || (this.config.loggedIn ? '随机音乐待播放' : '后台未连接音乐'));
      if (this.toggle) { this.toggle.classList.toggle('is-playing', this.isPlaying); this.toggle.setAttribute('aria-label', this.isPlaying ? '暂停音乐' : '播放音乐'); }
      for (const control of [this.toggle, this.previous, this.next]) if (control) control.disabled = this.loadingTrack;
      if (this.random) { this.random.classList.toggle('active', this.shuffle); this.random.setAttribute('aria-pressed', String(this.shuffle)); this.random.title = this.shuffle ? '随机播放已开启 · 切换顺序播放' : '顺序播放 · 开启随机播放'; }
      if (this.repeat) { this.repeat.classList.toggle('active', this.repeatMode !== 'off'); this.repeat.textContent = this.repeatMode === 'one' ? '↻1' : '↻'; this.repeat.title = this.repeatMode === 'one' ? '单曲循环' : this.repeatMode === 'all' ? '列表循环' : '不循环'; this.repeat.setAttribute('aria-label', this.repeat.title); }
      this.renderProgress();
      this.emitState();
    }
  }

  const root = document.querySelector('#musicPlayer');
  if (root) window.platformMusicPlayer = new PlatformMusicPlayer(root);
})();
