(() => {
  const defaults = { backgroundMode: 'random', randomBackgroundUrl: 'https://api.elaina.cat/random/', fixedBackgroundUrl: '', backgroundBlur: 0, backgroundOpacity: 1, surfaceOpacity: .82 };
  let source = '', loading = null, generation = 0;
  function apply(input = {}) {
    const settings = { ...defaults, ...input };
    const style = document.documentElement.style;
    style.setProperty('--wallpaper-blur', Math.max(0, Math.min(30, Number(settings.backgroundBlur) || 0)) + 'px');
    style.setProperty('--wallpaper-opacity', Math.max(0, Math.min(1, Number(settings.backgroundOpacity))));
    style.setProperty('--surface-opacity', Math.max(.35, Math.min(1, Number(settings.surfaceOpacity) || .82)));
    const random = document.body.classList.contains('admin-body') || settings.backgroundMode !== 'fixed';
    const next = random ? settings.randomBackgroundUrl : settings.fixedBackgroundUrl;
    if (source === next && loading) return loading;
    source = next;
    const revision = ++generation;
    loading = new Promise((resolve) => {
      const target = document.querySelector('#randomWallpaper');
      if (!target || !next) { resolve({ ok: false }); return; }
      let url;
      try {
        url = new URL(next, location.href);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid image URL');
        if (random) url.searchParams.set('_wallpaper', Date.now() + '-' + Math.random().toString(36).slice(2, 7));
      } catch { resolve({ ok: false }); return; }
      const image = new Image();
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (revision === generation) {
          if (ok) { target.src = image.src; document.body.classList.add('wallpaper-loaded'); document.body.classList.remove('wallpaper-fallback'); }
          else document.body.classList.add('wallpaper-fallback');
        }
        resolve({ ok });
      };
      const timer = setTimeout(() => finish(false), 5200);
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url.href;
    });
    return loading;
  }
  window.PageAppearance = { apply };
})();
