(() => {
  // 此页面在无同源权限的沙盒中运行，不能读取后台 Cookie、账号或存储。
  const values = new Map();
  const storage = { getItem: key => values.get(String(key)) ?? null, setItem: (key, value) => values.set(String(key), String(value)), removeItem: key => values.delete(String(key)), clear: () => values.clear() };
  Object.defineProperty(window, 'localStorage', { value: storage });
  Object.defineProperty(window, 'sessionStorage', { value: storage });
  Object.defineProperty(document, 'cookie', { get: () => '', set: () => {} });
  // 沙盒没有持久化存储，官方组件查询存储容量时返回当前空会话的容量。
  Object.defineProperty(navigator, 'storage', { value: { estimate: async () => ({ quota: 0, usage: 0 }), persisted: async () => false } });
  const requests = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    const state = requests.get(this);
    if (state) state.url = String(url);
    return nativeOpen.call(this, method, url, ...args);
  };
  // 官方 SDK 在 send 前生成签名；只收集签名 URL，不从浏览器发出音乐请求。
  XMLHttpRequest.prototype.send = function () {
    const state = requests.get(this);
    if (state) state.resolve({ signedUrl: state.url, userAgent: navigator.userAgent });
  };
  let ready;
  function loadSdk() {
    ready ??= (async () => {
      for (const host of ['https://lf-c-flwb.bytetos.com', 'https://lf-headquarters-speed.yhgfb-cn-static.com']) {
        const loaded = await new Promise(resolve => {
          const script = document.createElement('script');
          const timer = setTimeout(() => { script.remove(); resolve(false); }, 12000);
          script.src = host + '/obj/rc-client-security/web/stable/1.0.0.41/bdms.js';
          script.referrerPolicy = 'no-referrer';
          script.onload = () => { clearTimeout(timer); resolve(Boolean(window.bdms)); };
          script.onerror = () => { clearTimeout(timer); script.remove(); resolve(false); };
          document.head.append(script);
        });
        if (loaded) { window.bdms.init({ aid: 386088, paths: ['/passport'] }); return; }
      }
      throw new Error('汽水官方安全组件加载失败，请检查浏览器网络后重试');
    })();
    return ready;
  }
  window.addEventListener('message', async event => {
    if (event.source !== parent || event.data?.type !== 'qishui-sign') return;
    const { id, request } = event.data;
    try {
      const url = new URL(request.url);
      if (url.origin !== 'https://api.qishui.com' || !['/passport/web/get_qrcode/', '/passport/web/check_qrconnect/'].includes(url.pathname)) throw new Error('汽水签名请求无效');
      storage.setItem('xmst', request.msToken);
      storage.setItem('xmsty', request.msToken);
      await loadSdk();
      const signature = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const timer = setTimeout(() => reject(new Error('汽水签名生成超时，请重试')), 5000);
        requests.set(xhr, { url: '', resolve: result => { clearTimeout(timer); resolve(result); } });
        xhr.open(request.method, request.url);
        for (const [name, value] of Object.entries(request.headers || {})) xhr.setRequestHeader(name, value);
        xhr.send(request.body);
      });
      if (new URL(signature.signedUrl).searchParams.get('a_bogus')?.length !== 44) throw new Error('汽水官方签名生成失败，请重试');
      parent.postMessage({ type: 'qishui-signed', id, signature }, '*');
    } catch (error) { parent.postMessage({ type: 'qishui-signed', id, error: error.message || '汽水签名失败' }, '*'); }
  });
  parent.postMessage({ type: 'qishui-signer-ready' }, '*');
})();
