import crypto from 'node:crypto';

function failure(message) {
  return Object.assign(new Error(message), { code: 'QISHUI_SIGNATURE', retryable: false });
}
function publicRequest(request) {
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => /^(content-type|x-ss-stub|x-tt-passport-)/i.test(name)));
  return { requestId: request.requestId, url: request.url, method: request.method, body: request.body ?? null, headers, msToken: new URL(request.url).searchParams.get('msToken') };
}
// 服务器提供待签名的固定请求；后台浏览器计算官方签名，Cookie 始终留在服务器。
export function qishuiSignedRequest(url, options, flow) {
  if (flow.signedRequest) {
    const request = flow.signedRequest;
    flow.signedRequest = null;
    if (new URL(request.url).pathname !== url.pathname || request.method !== options.method) throw failure('汽水签名请求已失效，请重新生成二维码');
    return request;
  }
  let request = flow.signingRequest;
  if (!request || request.expiresAt < Date.now()) {
    request = { ...options, url: String(url), requestId: crypto.randomUUID(), expiresAt: Date.now() + 60000 };
    flow.signingRequest = request;
  }
  throw Object.assign(failure('汽水请求需要后台浏览器签名'), { signing: publicRequest(request) });
}
export function acceptQishuiSignature(flow, input) {
  const request = flow.signingRequest;
  if (!request || request.requestId !== input.requestId || request.expiresAt < Date.now()) throw failure('汽水签名已过期，请重新获取二维码');
  let signed;
  try { signed = new URL(input.signedUrl); } catch { throw failure('汽水签名无效'); }
  const original = new URL(request.url);
  const signature = signed.searchParams.get('a_bogus');
  const token = signed.searchParams.get('msToken');
  if (signed.searchParams.getAll('a_bogus').length !== 1 || !/^[A-Za-z0-9/_+=-]{44}$/.test(signature || '') || !/^[A-Za-z0-9/_+=-]{20,200}$/.test(token || '')) throw failure('汽水官方签名生成失败，请重新生成二维码');
  const comparison = new URL(signed);
  comparison.searchParams.delete('a_bogus');
  comparison.searchParams.set('msToken', original.searchParams.get('msToken'));
  if (comparison.href !== original.href) throw failure('汽水签名与原请求不匹配');
  const userAgent = String(input.userAgent || '');
  if (!userAgent || userAgent.length > 500 || /[\x00-\x1f\x7f]/.test(userAgent)) throw failure('汽水浏览器身份无效');
  flow.msToken = token;
  flow.userAgent = userAgent;
  flow.signedRequest = { ...request, url: signed.href, headers: { ...request.headers, 'user-agent': userAgent } };
  flow.signingRequest = null;
}
