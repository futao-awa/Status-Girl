(() => {
  let frame;
  let ready;
  let counter = 0;
  const pending = new Map();
  window.addEventListener('message', event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== 'null') return;
    if (event.data?.type === 'qishui-signer-ready') { clearTimeout(ready?.timer); ready?.resolve(); return; }
    if (event.data?.type !== 'qishui-signed') return;
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    clearTimeout(entry.timer);
    if (event.data.error) entry.reject(Object.assign(new Error(event.data.error), { retryable: false }));
    else entry.resolve(event.data.signature);
  });
  function dispose() {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error('扫码已取消'), { retryable: false })); }
    pending.clear();
    clearTimeout(ready?.timer);
    ready?.reject(new Error('扫码已取消'));
    frame?.remove();
    frame = null;
    ready = null;
  }
  async function sign(request) {
    if (!frame) {
      const promise = new Promise((resolve, reject) => { ready = { resolve, reject }; });
      ready.promise = promise;
      ready.timer = setTimeout(() => ready?.reject(Object.assign(new Error('汽水扫码组件未能打开，请重新生成二维码'), { retryable: false })), 10000);
      frame = document.createElement('iframe');
      frame.hidden = true;
      frame.sandbox = 'allow-scripts';
      frame.referrerPolicy = 'no-referrer';
      frame.src = '/qishui-signing.html?v=1.0.2';
      document.body.append(frame);
    }
    await ready.promise;
    return new Promise((resolve, reject) => {
      const id = ++counter;
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('汽水安全组件响应超时，请重新生成二维码'), { retryable: false })); }, 35000);
      pending.set(id, { resolve, reject, timer });
      frame.contentWindow.postMessage({ type: 'qishui-sign', id, request }, '*');
    });
  }
  window.qishuiSigning = { sign, dispose };
})();
