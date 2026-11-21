export function mergeCookies(current = '', updates = []) {
  const jar = new Map();
  for (const part of String(current).split(';')) {
    const at = part.indexOf('=');
    if (at > 0) jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  for (const line of updates) {
    const pair = String(line).split(';', 1)[0];
    const at = pair.indexOf('=');
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => name + '=' + value).join('; ');
}
export function cookieValue(cookie, name) {
  const part = String(cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
  return part ? part.slice(name.length + 1) : '';
}
// 直连、API 适配服务可能各包一层 data/body；只沿响应封装读取。
function responseLayers(payload) {
  const layers = [];
  let value = payload;
  for (let depth = 0; value && typeof value === 'object' && !Array.isArray(value) && depth < 6; depth += 1) {
    layers.push(value);
    value = value.data ?? value.body;
  }
  return layers.reverse();
}
function field(layers, names) {
  for (const layer of layers) for (const name of names) if (layer[name] !== undefined && layer[name] !== null && layer[name] !== '') return layer[name];
  return '';
}
export function musicAuthError(provider, payload, httpStatus = 200) {
  const layers = responseLayers(payload);
  const code = field(layers, ['error_code']) || (provider === 'netease' ? field(layers, ['code']) : '');
  const label = provider === 'qishui' ? '汽水音乐' : '网易云音乐';
  // 保留可诊断的状态码；不把平台响应中的 token、Cookie 或跳转地址回显给前端。
  const message = code ? `${label}登录接口返回错误（${code}）` : `${label}登录接口请求失败（HTTP ${httpStatus}）`;
  const error = new Error(message);
  error.code = String(code || 'UPSTREAM_ERROR');
  error.retryable = httpStatus === 429 || httpStatus >= 500 || String(code) === '7';
  return error;
}
export function normalizeQr(payload) {
  const layers = responseLayers(payload);
  if (Number(field(layers, ['error_code'])) > 0 || layers.some(layer => layer.message === 'error')) throw musicAuthError('qishui', payload);
  const expiry = Number(field(layers, ['expire_time', 'expiresAt']));
  const copywriting = String(field(layers, ['copywriting']));
  return {
    token: String(field(layers, ['token', 'qr_token', 'qrcode_token', 'qrcode_id', 'unikey', 'key'])),
    image: String(field(layers, ['qrcode', 'qrCode', 'qr_code', 'qrimg'])),
    url: String(field(layers, ['qrcode_index_url', 'qrcode_url', 'qr_code_url', 'qrurl', 'login_url'])),
    expiresAt: expiry > 0 ? (expiry > 1e12 ? expiry : expiry * 1000) : Date.now() + 180000,
    scanApp: copywriting.includes('抖音') || field(layers, ['scan_app']) === 'douyin' ? 'douyin' : ''
  };
}
export function qrStatus(provider, payload) {
  const layers = responseLayers(payload);
  const cookie = field(layers, ['cookie', 'session_cookie']);
  const result = { cookie: Array.isArray(cookie) ? cookie.map(line => String(line).split(';', 1)[0]).join('; ') : String(cookie), sessionId: '', redirect: '' };
  if (provider === 'netease') {
    const code = layers.map(layer => Number(layer.code)).find(code => [800, 801, 802, 803].includes(code));
    if (!code) throw musicAuthError(provider, payload);
    return { ...result, status: code === 803 ? 'confirmed' : code === 802 ? 'scanned' : code === 800 ? 'expired' : 'pending' };
  }
  const value = String(field(layers, ['status', 'state'])).toLowerCase();
  const sessionNames = ['sessionid', 'sessionId', 'session_id', 'sessionid_ss', 'session_id_ss'];
  const sessionId = String(field(layers, sessionNames) || field(layers.map(layer => layer.auth || {}), sessionNames));
  const credential = sessionId || cookieValue(result.cookie, 'sessionid') || cookieValue(result.cookie, 'sessionid_ss');
  const errorCode = Number(field(layers, ['error_code']));
  if (errorCode === 2) return { ...result, status: 'expired' };
  if (errorCode === 7 && !credential) return { ...result, status: 'retrying', retryAfterMs: 5000, message: '平台请求较频繁，5 秒后继续检查…' };
  if (errorCode === 2046 && !credential) return { ...result, status: 'verification_required', decision: layers.find(layer => layer.verify_from || layer.url || layer.verify_ways) || layers[0], message: '平台要求额外身份验证，请在后台验证窗口完成验证。' };
  if (!credential && (errorCode > 0 || layers.some(layer => layer.message === 'error'))) throw musicAuthError(provider, payload);
  const states = { new: 'pending', waiting: 'pending', pending: 'pending', '1': 'pending', scanned: 'scanned', scan: 'scanned', scanned_qrcode: 'scanned', '2': 'scanned', confirm: 'confirmed', confirmed: 'confirmed', success: 'confirmed', login: 'confirmed', confirmed_login: 'confirmed', '3': 'confirmed', expired: 'expired', expire: 'expired', invalid: 'expired', cancelled: 'expired', canceled: 'expired', '4': 'expired' };
  const status = credential ? 'confirmed' : states[value];
  if (!status) throw musicAuthError(provider, payload);
  return { ...result, status, sessionId, redirect: String(field(layers, ['redirect_url', 'redirectUrl'])) };
}
