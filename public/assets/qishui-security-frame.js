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
  const relayPending = new Map();
  let relayCounter = 0;
  let verification;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    const state = requests.get(this) || { headers: {} };
    Object.assign(state, { url: String(url), method: String(method).toUpperCase() });
    requests.set(this, state);
    return nativeOpen.call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const state = requests.get(this);
    if (state) state.headers[name] = value;
    return nativeHeader.call(this, name, value);
  };
  function relay(request) {
    if (!verification) return Promise.reject(new Error('身份验证已结束'));
    const verificationId = verification.verificationId;
    return new Promise((resolve, reject) => {
      const id = ++relayCounter;
      const timer = setTimeout(() => { relayPending.delete(id); reject(new Error('身份验证请求超时，请重试')); }, 30000);
      relayPending.set(id, { resolve, reject, timer });
      parent.postMessage({ type: 'qishui-verify-request', id, verificationId, request }, '*');
    });
  }
  function completeXhr(xhr, result) {
    const text = String(result.body || '');
    const headers = result.headers || {};
    let response = text;
    if (xhr.responseType === 'json') { try { response = JSON.parse(text); } catch { response = null; } }
    for (const [name, value] of Object.entries({ status: result.status, statusText: result.status === 200 ? 'OK' : '', response, responseText: text, responseURL: requests.get(xhr).url })) Object.defineProperty(xhr, name, { configurable: true, value });
    xhr.getResponseHeader = name => headers[String(name).toLowerCase()] || null;
    xhr.getAllResponseHeaders = () => Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
    Object.defineProperty(xhr, 'readyState', { configurable: true, value: 4 });
    xhr.dispatchEvent(new Event('readystatechange'));
    xhr.dispatchEvent(new Event('load'));
    xhr.dispatchEvent(new Event('loadend'));
  }
  // 官方 SDK 在 send 前生成签名；只收集签名 URL，不从浏览器发出音乐请求。
  XMLHttpRequest.prototype.send = function (body) {
    const state = requests.get(this);
    if (state?.resolve) { state.resolve({ signedUrl: state.url, userAgent: navigator.userAgent }); return; }
    if (!state || !verification) return;
    relay({ url: state.url, method: state.method, headers: state.headers, body: body == null ? null : String(body) }).then(result => completeXhr(this, result)).catch(() => {
      Object.defineProperty(this, 'readyState', { configurable: true, value: 4 });
      this.dispatchEvent(new Event('error'));
      this.dispatchEvent(new Event('loadend'));
    });
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
  async function sign(request) {
    storage.setItem('xmst', request.msToken);
    storage.setItem('xmsty', request.msToken);
    await loadSdk();
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const timer = setTimeout(() => reject(new Error('汽水签名生成超时，请重试')), 5000);
      requests.set(xhr, { url: '', headers: {}, resolve: result => { clearTimeout(timer); resolve(result); } });
      xhr.open(request.method, request.url);
      for (const [name, value] of Object.entries(request.headers || {})) xhr.setRequestHeader(name, value);
      xhr.send(request.body);
    });
  }
  // 官方组件的 fetch 也通过同一沙盒签名、同一服务器会话发送，避免跨域丢失 Cookie。
  window.fetch = async (input, options = {}) => {
    if (!verification) throw new Error('身份验证已结束');
    const request = new Request(input, options);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/passport/')) {
      for (const [key, value] of Object.entries(verification.generalParams || {})) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
      url.searchParams.set('msToken', storage.getItem('xmst'));
    }
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.text();
    const headers = Object.fromEntries(request.headers);
    const signature = await sign({ url: url.href, method: request.method, body, headers, msToken: storage.getItem('xmst') });
    const result = await relay({ url: signature.signedUrl, method: request.method, body, headers });
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); reject(new Error('身份验证组件加载超时，请重试')); }, 15000);
      script.src = url;
      script.crossOrigin = 'anonymous';
      script.referrerPolicy = 'no-referrer';
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('身份验证组件加载失败，请检查浏览器网络')); };
      document.head.append(script);
    });
  }
  async function loadReact() {
    if (window.React && window.ReactDOM) return;
    if (!window.React) await loadScript('/assets/qishui-react.js?v=17.0.2');
    if (!window.ReactDOM) await loadScript('/assets/qishui-react-dom.js?v=17.0.2');
  }
  async function verify(config) {
    verification = config;
    storage.setItem('xmst', config.msToken);
    storage.setItem('xmsty', config.msToken);
    const status = document.querySelector('#verificationStatus');
    status.textContent = '正在加载官方身份验证…';
    await loadSdk();
    await loadReact();
    window.ucSecondVerifyReact = window.React;
    window.ucSecondVerifyReactDom = window.ReactDOM;
    const decision = config.decision;
    const resource = new URL(config.scriptUrl);
    if (resource.protocol !== 'https:' || !/\.(?:bytescm\.com|bytetos\.com|yhgfb-cn-static\.com|bytegoofy\.com|byteimg\.com|bytednsdoc\.com)$/.test(resource.hostname)) throw new Error('官方验证组件地址无效');
    const object = value => { if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } } return value && typeof value === 'object' ? value : {}; };
    const events = object(decision.event_params);
    resource.searchParams.set('aid', '386088');
    resource.searchParams.set('verify_reason', String(events.verify_reason || ''));
    resource.searchParams.set('verify_scene', String(events.verify_scene || ''));
    window.$$account_verify_portrait_id = decision.verify_portrait_id || '';
    await loadScript(resource.href);
    if (typeof window.ucWebSecondVerify !== 'function') throw new Error('官方身份验证组件未能启动，请重试');
    status.textContent = '请按官方窗口提示完成身份验证';
    return new Promise(resolve => {
      window.ucWebSecondVerify({
        ...decision, aid: 386088, isNewVerifyUI: true, generalParams: config.generalParams,
        event_params: events,
        newSecondVerifyWebOptions: { host: 'https://api.qishui.com', verifyAppName: '汽水音乐移动端' },
        newSecondVerificationCall: { reportAppLog() {} },
        monitorTime: { startTime: Date.now(), fetchEndTime: Date.now(), scriptLoadStartTime: 0, scriptLoadEndTime: Date.now(), renderStartTime: Date.now() },
        fun: decision.verify_from === 'verify_center' ? 'verify_center' : 'verify', uc_account_verify_version: '1.0.29',
        verifyFinishCallback: result => resolve({ success: result?.status === true, message: result?.status === true ? '' : '身份验证未完成，可点击继续验证' })
      });
    });
  }
  window.addEventListener('message', async event => {
    if (event.source !== parent) return;
    if (event.data?.type === 'qishui-verify-response') {
      const entry = relayPending.get(event.data.id);
      if (!entry) return;
      relayPending.delete(event.data.id);
      clearTimeout(entry.timer);
      if (event.data.error) entry.reject(new Error(event.data.error));
      else entry.resolve(event.data.result);
      return;
    }
    if (event.data?.type === 'qishui-verify') {
      try { parent.postMessage({ type: 'qishui-verified', id: event.data.id, result: await verify(event.data.config) }, '*'); }
      catch (error) { parent.postMessage({ type: 'qishui-verified', id: event.data.id, error: error.message || '身份验证失败，请重试' }, '*'); }
      return;
    }
    if (event.data?.type !== 'qishui-sign') return;
    const { id, request } = event.data;
    try {
      const url = new URL(request.url);
      if (url.origin !== 'https://api.qishui.com' || !['/passport/web/get_qrcode/', '/passport/web/check_qrconnect/', '/passport/safe/pack_verify_ways_data/'].includes(url.pathname)) throw new Error('汽水签名请求无效');
      const signature = await sign(request);
      if (new URL(signature.signedUrl).searchParams.get('a_bogus')?.length !== 44) throw new Error('汽水官方签名生成失败，请重试');
      parent.postMessage({ type: 'qishui-signed', id, signature }, '*');
    } catch (error) { parent.postMessage({ type: 'qishui-signed', id, error: error.message || '汽水签名失败' }, '*'); }
  });
  parent.postMessage({ type: 'qishui-signer-ready' }, '*');
})();
