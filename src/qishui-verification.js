import crypto from 'node:crypto';
import { cookieValue } from './music-auth.js';

const apiHosts = new Set(['api.qishui.com', 'auth.zijieapi.com', 'bff-pc.qishui.com']);
const captchaHosts = new Set(['verify.snssdk.com', 'verify.zijieapi.com']);
const assetHost = /\.(?:bytescm\.com|bytetos\.com|yhgfb-cn-static\.com|bytegoofy\.com|byteimg\.com|bytednsdoc\.com|zijieapi\.com)$/;
const credentialFields = /^(?:cookie|session_cookie|sessionid|sessionid_ss|session_id|session_id_ss|sid_guard|sid_tt|auth|__proto__|constructor|prototype)$/i;

export function verificationObject(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
// 验证组件需要平台的决策、短信票据等字段；登录凭据只保存在服务器。
export function publicVerificationData(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map(item => publicVerificationData(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !credentialFields.test(key)).map(([key, item]) => [key, publicVerificationData(item, depth + 1)]));
}
export function verificationScript(value) {
  let url;
  try {
    if (value && typeof value === 'object') {
      const host = String(value.host || '').replace(/^https:\/\//, '');
      value = `https://${host}/${String(value.path || '').replace(/^\//, '')}`;
    }
    url = new URL(String(value), 'https://api.qishui.com');
  } catch { throw new Error('平台未返回可用的身份验证组件，请重新扫码'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !assetHost.test(url.hostname) || !/^\/(?:(?:obj|static|ucenter_web)\/.*)\.js$/.test(url.pathname)) throw new Error('平台返回的身份验证组件地址不受支持');
  return url.href;
}
export function verificationRequest(input, flow) {
  const request = verificationObject(input);
  let url;
  try { url = new URL(String(request.url)); } catch { throw new Error('身份验证请求地址无效'); }
  // 仅允许官方身份验证接口，拒绝任意代理、授权跳转及登录/账号修改接口。
  const passport = apiHosts.has(url.hostname) && (/^\/passport\/(?:safe|verify|upsms|mobile|web\/(?:sms|captcha|verify|verification|safe|account|email|mobile))\/[a-z0-9_/-]+\/$/i.test(url.pathname) || /^\/passport\/web\/(?:send_code|send_voice_code|validate_code|get_qrcode)\/[a-z0-9_/-]*$/i.test(url.pathname));
  const captcha = captchaHosts.has(url.hostname) && /^\/captcha\/(?:get|verify|refresh)\/?$/.test(url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(passport || captcha)) throw new Error('身份验证请求超出允许范围');
  if (url.searchParams.has('aid') && url.searchParams.get('aid') !== '386088') throw new Error('身份验证应用不匹配');
  const method = String(request.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw new Error('身份验证请求方式无效');
  const body = request.body == null ? undefined : String(request.body);
  if ((method === 'GET' && body) || Buffer.byteLength(body || '') > 65536 || url.href.length > 16384) throw new Error('身份验证请求过大');
  const headers = { accept: 'application/json', referer: 'https://qishui.com/', 'user-agent': flow.userAgent };
  for (const [name, value] of Object.entries(verificationObject(request.headers))) {
    if (/^(?:content-type|x-ss-stub|x-tt-passport-[a-z-]+|x-vc-bdturing-sdk-version)$/i.test(name) && String(value).length <= 2000 && !/[\r\n]/.test(String(value))) headers[name.toLowerCase()] = String(value);
  }
  headers.cookie = flow.cookie || '';
  const csrf = cookieValue(flow.cookie, 'passport_csrf_token');
  if (csrf) headers['x-tt-passport-csrf-token'] = csrf;
  headers['x-tt-passport-verify-portrait'] = flow.verification.decision.verify_portrait_id || flow.verifyPortraitId;
  if (captcha) { delete headers.cookie; delete headers['x-tt-passport-csrf-token']; delete headers['x-tt-passport-verify-portrait']; }
  if (body !== undefined) headers['x-ss-stub'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
  return { url, method, headers, body };
}
export async function verificationResponse(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > 262144) throw new Error('身份验证响应过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error(`身份验证接口返回异常（HTTP ${response.status}）`); }
}
export function verificationForm(decision, generalParams) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...decision, ...generalParams, aid: '386088' })) {
    if (key !== 'is_login' && value != null) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return form.toString();
}
export function verificationBizParams(decision) {
  let values = decision?.biz_params;
  if (typeof values === 'string') { try { values = JSON.parse(values); } catch { values = Object.fromEntries(new URLSearchParams(values)); } }
  return Object.fromEntries(Object.entries(verificationObject(values)).filter(([key, value]) => !credentialFields.test(key) && !['token', 'aid', 'next', 'is_new_login', 'is_frontier', 'need_logo', 'need_short_url'].includes(key) && value != null).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(publicVerificationData(value)) : String(value)]));
}
