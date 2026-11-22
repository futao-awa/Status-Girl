(() => {
  let frame;
  let dialog;
  let verification;
  let previousFocus;
  let ready;
  let counter = 0;
  const pending = new Map();
  window.addEventListener('message', async event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== 'null') return;
    if (event.data?.type === 'qishui-signer-ready') { clearTimeout(ready?.timer); ready?.resolve(); return; }
    if (event.data?.type === 'qishui-verify-request') {
      const current = verification;
      if (!current || !current.active() || event.data.verificationId !== current.config.verificationId) return;
      const target = frame.contentWindow;
      try {
        const result = await current.request('/api/music/login/qr/verification/request', { method: 'POST', body: JSON.stringify({ token: current.config.token, verificationId: current.config.verificationId, request: event.data.request }) });
        if (verification === current && current.active()) target.postMessage({ type: 'qishui-verify-response', id: event.data.id, result }, '*');
      } catch (error) { if (verification === current && current.active()) target.postMessage({ type: 'qishui-verify-response', id: event.data.id, error: error.message }, '*'); }
      return;
    }
    if (event.data?.type === 'qishui-verified') {
      if (!verification || event.data.id !== verification.id) return;
      if (event.data.error) finishVerification({ success: false, message: event.data.error });
      else finishVerification(event.data.result);
      return;
    }
    if (event.data?.type !== 'qishui-signed') return;
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    clearTimeout(entry.timer);
    if (event.data.error) entry.reject(Object.assign(new Error(event.data.error), { retryable: false }));
    else entry.resolve(event.data.signature);
  });
  function finishVerification(result, disposing = false) {
    const current = verification;
    if (!current) return;
    verification = null;
    clearTimeout(current.timer);
    dialog.classList.add('hidden');
    frame.hidden = true;
    previousFocus?.focus();
    current.resolve(result);
    if (!result?.success && !disposing) dispose();
  }
  function dispose() {
    finishVerification({ success: false, message: '身份验证已取消' }, true);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error('扫码已取消'), { retryable: false })); }
    pending.clear();
    clearTimeout(ready?.timer);
    ready?.reject(new Error('扫码已取消'));
    dialog?.remove();
    frame = null;
    dialog = null;
    ready = null;
  }
  async function ensureFrame() {
    if (!frame) {
      const promise = new Promise((resolve, reject) => { ready = { resolve, reject }; });
      ready.promise = promise;
      ready.timer = setTimeout(() => ready?.reject(Object.assign(new Error('汽水扫码组件未能打开，请重新生成二维码'), { retryable: false })), 10000);
      frame = document.createElement('iframe');
      frame.hidden = true;
      frame.sandbox = 'allow-scripts';
      frame.referrerPolicy = 'no-referrer';
      frame.title = '汽水音乐官方身份验证';
      frame.src = '/qishui-signing.html?v=1.0.5';
      dialog = document.createElement('div');
      dialog.className = 'qishui-verification-dialog hidden';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'qishuiVerificationTitle');
      const card = document.createElement('section');
      card.className = 'qishui-verification-card';
      const header = document.createElement('header');
      const title = document.createElement('h2');
      title.id = 'qishuiVerificationTitle';
      title.textContent = '汽水音乐 · 身份验证';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'secondary';
      close.textContent = '取消验证';
      close.onclick = () => finishVerification({ success: false, message: '身份验证已取消，可点击继续身份验证' });
      dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') close.click();
        if (event.key === 'Tab' && document.activeElement === close && event.shiftKey) { event.preventDefault(); frame.focus(); }
      });
      header.append(title, close);
      card.append(header, frame);
      dialog.append(card);
      document.body.append(dialog);
    }
    await ready.promise;
  }
  async function sign(request) {
    await ensureFrame();
    return new Promise((resolve, reject) => {
      const id = ++counter;
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('汽水安全组件响应超时，请重新生成二维码'), { retryable: false })); }, 35000);
      pending.set(id, { resolve, reject, timer });
      frame.contentWindow.postMessage({ type: 'qishui-sign', id, request }, '*');
    });
  }
  async function verify(config, options) {
    if (verification) throw new Error('身份验证正在进行');
    await ensureFrame();
    previousFocus = document.activeElement;
    dialog.classList.remove('hidden');
    frame.hidden = false;
    dialog.querySelector('button').focus();
    return new Promise(resolve => {
      const id = ++counter;
      const timer = setTimeout(() => finishVerification({ success: false, message: '身份验证已过期，请重新扫码' }), Math.max(1, Date.parse(config.expiresAt) - Date.now()));
      verification = { id, config, ...options, resolve, timer };
      frame.contentWindow.postMessage({ type: 'qishui-verify', id, config }, '*');
    });
  }
  window.qishuiSigning = { sign, verify, dispose };
})();
