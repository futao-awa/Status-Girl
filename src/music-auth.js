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
export function normalizeQr(payload) {
  const data = payload?.data ?? payload ?? {};
  if (payload?.message === 'error' || Number(data.error_code) > 0) throw new Error(data.description || payload.message || '音乐平台拒绝生成二维码');
  return {
    token: String(data.token ?? data.qr_token ?? data.unikey ?? data.key ?? ''),
    image: String(data.qrcode ?? data.qrCode ?? data.qrimg ?? ''),
    url: String(data.qrcode_index_url ?? data.qrcode_url ?? data.qrurl ?? ''),
    expiresAt: Number(data.expire_time) > 0 ? Number(data.expire_time) * 1000 : Date.now() + 180000
  };
}
export function qrStatus(provider, payload, adapter = false) {
  const data = payload?.data ?? payload ?? {};
  if (provider === 'netease') {
    const code = Number(payload?.code ?? data.code ?? 801);
    return { status: code === 803 ? 'confirmed' : code === 802 ? 'scanned' : code === 800 ? 'expired' : 'pending', cookie: String(payload?.cookie ?? data.cookie ?? ''), sessionId: '', redirect: '' };
  }
  if (payload?.message === 'error' || Number(data.error_code) > 0) throw new Error(data.description || '汽水扫码状态获取失败');
  const value = String(data.status ?? data.code ?? '').toLowerCase();
  const sessionId = String(data.sessionid ?? data.sessionId ?? data.sessionid_ss ?? data.auth?.sessionid ?? payload?.sessionid ?? '');
  const confirmed = sessionId || ['confirmed', 'success', 'login', 'confirmed_login'].includes(value) || (adapter && value === '2');
  const expired = ['expired', 'expire', 'invalid', 'cancelled', 'canceled', '4'].includes(value) || (adapter && value === '3');
  const scanned = ['scanned', 'scan', 'scanned_qrcode', '2', '3'].includes(value) || (adapter && value === '1');
  return { status: confirmed ? 'confirmed' : expired ? 'expired' : scanned ? 'scanned' : 'pending', sessionId, cookie: String(data.cookie ?? payload?.cookie ?? ''), redirect: String(data.redirect_url ?? data.redirectUrl ?? '') };
}
