import 'node:process';
import fsSync from 'node:fs';
if (fsSync.existsSync('.env')) process.loadEnvFile('.env');
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import path from 'node:path';
import { loadDb, saveDb, id, now } from './src/store.js';
import { appearanceSettings, validateAppearance } from './src/appearance.js';
import { mergeCookies, normalizeQr, qrStatus, cookieValue, musicAuthError } from './src/music-auth.js';
import { qishuiSignedRequest, acceptQishuiSignature } from './src/qishui-signing.js';
import { publicVerificationData, verificationScript, verificationRequest, verificationResponse, verificationForm, verificationBizParams } from './src/qishui-verification.js';
import { checkMonitor, getServerMetrics, inspectSsl } from './src/checkers.js';
import { changelogSection, chooseVersionedRelease, compareVersions, normalizeVersion } from './src/update-check.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (isProduction && !process.env.SESSION_SECRET) console.warn('SESSION_SECRET 未设置，已使用临时随机密钥；重启后会话会失效。');
const sessions = new Map();
const db = await loadDb();
const packageInfo = JSON.parse(fsSync.readFileSync(path.resolve('package.json'), 'utf8'));
const appVersion = normalizeVersion(process.env.APP_VERSION || packageInfo.version) || '0.0.0';
const githubRepository = 'futao-awa/Status-Girl';
const githubProjectUrl = `https://github.com/${githubRepository}`;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
// 签名沙盒没有同源权限；只让不含用户数据的引导脚本可从该沙盒加载。
app.get('/assets/qishui-security-frame.js', (_req, res, next) => { res.setHeader('cross-origin-resource-policy', 'cross-origin'); next(); });
for (const [asset, file] of [['qishui-react', 'react/umd/react.production.min.js'], ['qishui-react-dom', 'react-dom/umd/react-dom.production.min.js']]) {
  app.get(`/assets/${asset}.js`, (_req, res) => {
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    res.setHeader('access-control-allow-origin', '*');
    res.sendFile(path.resolve('node_modules', file));
  });
}
app.use(express.static(path.resolve('public'), { extensions: ['html'] }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: '登录尝试过于频繁，请稍后再试' } });
const adminLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/admin', adminLimiter);
app.use('/api/v1', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

function publicSettings() {
  const s = db.settings;
  return { siteName: s.siteName, siteDescription: s.siteDescription, announcement: s.announcement, refreshSeconds: s.refreshSeconds, historyDays: s.historyDays, publicMetrics: s.publicMetrics, ...appearanceSettings(s), accentColor: s.accentColor, logoText: s.logoText };
}

const musicQrFlows = new Map();
let musicAuthGeneration = 0;
const NETEASE_ORIGIN = 'https://music.163.com';
const QISHUI_ORIGIN = 'https://api.qishui.com/luna/pc';
const NETEASE_RSA_MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const NETEASE_PRESET_KEY = '0CoJUm6Qyw8W8jud';
const NETEASE_IV = '0102030405060708';
const musicDeviceId = () => {
  const music = db.settings.music || (db.settings.music = {});
  if (!/^\d{12,24}$/.test(String(music.deviceId || ''))) music.deviceId = `${Date.now()}${crypto.randomInt(1000, 9999)}`.slice(-18);
  return music.deviceId;
};
function musicProvider() { return db.settings.music?.provider || process.env.MUSIC_PROVIDER || 'netease'; }
function musicBaseUrl() { return String(process.env.MUSIC_API_BASE_URL || '').trim().replace(/\/$/, ''); }
function musicConfigured() { return ['netease', 'qishui'].includes(musicProvider()); }
function musicLoggedIn() {
  const music = db.settings.music || {};
  const provider = music.provider || musicProvider();
  if (provider === 'qishui') return Boolean(music.sessionId || cookieValue(music.cookie, 'sessionid') || cookieValue(music.cookie, 'sessionid_ss'));
  return Boolean(cookieValue(music.cookie, 'MUSIC_U'));
}
function musicSessionHeaders() {
  const music = db.settings.music || {};
  const headers = { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' };
  if (music.provider === 'qishui' && music.sessionId) headers['x-session-id'] = music.sessionId;
  if (music.cookie) headers.cookie = music.cookie;
  if (music.provider === 'qishui' && music.sessionId && !cookieValue(headers.cookie, 'sessionid')) headers.cookie = mergeCookies(headers.cookie, [`sessionid=${music.sessionId}`]);
  return headers;
}
function mergeSetCookies(headers, flow) {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : (headers.get('set-cookie') ? headers.get('set-cookie').split(/,(?=\s*[^;,=]+=[^;,]*)/) : []);
  if (flow) flow.cookie = mergeCookies(flow.cookie, values);
  else db.settings.music.cookie = mergeCookies(db.settings.music?.cookie, values);
}

function aesEncrypt(value, key, iv = NETEASE_IV) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]).toString('base64');
}
function modPow(base, exponent, modulus) {
  let result = 1n;
  let value = base % modulus;
  let power = exponent;
  while (power > 0n) { if (power & 1n) result = (result * value) % modulus; value = (value * value) % modulus; power >>= 1n; }
  return result;
}
function neteaseWeapi(payload) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let secret = '';
  for (let index = 0; index < 16; index += 1) secret += alphabet[crypto.randomInt(alphabet.length)];
  const params = aesEncrypt(aesEncrypt(JSON.stringify(payload), NETEASE_PRESET_KEY), secret);
  const reversed = Buffer.from(secret.split('').reverse().join(''), 'utf8');
  const rsa = modPow(BigInt(`0x${reversed.toString('hex')}`), 0x10001n, BigInt(`0x${NETEASE_RSA_MODULUS}`));
  const encSecKey = rsa.toString(16).padStart(256, '0');
  return new URLSearchParams({ params, encSecKey }).toString();
}
function musicData(payload) { return payload?.data ?? payload; }
function qishuiQuery() {
  return { aid: 386088, app_name: 'luna_pc', device_id: musicDeviceId(), iid: db.settings.music.installId || musicDeviceId(), version_name: '3.5.1', version_code: 30050100, channel: 'official', region: 'cn', geo_region: 'cn', os_region: 'cn', device_platform: 'windows', device_type: 'Windows' };
}
function qishuiPassportQuery() {
  const music = db.settings.music;
  if (!/^\d{12,24}$/.test(String(music.installId || '')) || music.installId === musicDeviceId()) music.installId = `${Date.now()}${crypto.randomInt(10000, 99999)}`;
  // 对齐 PC Passport SDK 的参数，不能混入歌曲接口的设备平台参数。
  return { aid: '386088', device_id: musicDeviceId(), did: musicDeviceId(), install_id: music.installId, iid: music.installId, passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1', account_sdk_source: 'web', language: 'zh', p_js_v: '2.4.13', p_js_t: 'pro', p_zt: '3.3.5', p_ver: '1.0.29', request_host: 'app%3A%2F%2Fresources', p_bd: '1.0.0.41', is_from_iesaccountsaas: '1', device_platform: 'PC', version_code: '3.5.2', account_sdk_source_info: '00' };
}
async function musicRequest(pathname, options = {}) {
  const adapterBase = musicBaseUrl();
  const provider = options.flow?.provider || musicProvider();
  const base = adapterBase || (provider === 'qishui' && String(pathname).startsWith('/passport') ? 'https://api.qishui.com' : provider === 'qishui' ? QISHUI_ORIGIN : NETEASE_ORIGIN);
  const url = new URL(`${base}/${String(pathname).replace(/^\//, '')}`);
  Object.entries(options.search || {}).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value)); });
  if (!adapterBase && provider === 'qishui' && !String(pathname).startsWith('/passport')) Object.entries(qishuiQuery()).forEach(([key, value]) => { if (!url.searchParams.has(key)) url.searchParams.set(key, String(value)); });
  const headers = { ...musicSessionHeaders(), ...(options.headers || {}) };
  if (options.flow) { delete headers.cookie; delete headers['x-session-id']; if (options.flow.cookie) headers.cookie = options.flow.cookie; }
  let body;
  if (options.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = typeof options.form === 'string' ? options.form : new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    if (typeof options.body === 'string') body = options.body;
    else { headers['content-type'] = 'application/json'; body = JSON.stringify(options.body); }
  }
  if (!adapterBase && provider === 'netease') headers.referer = 'https://music.163.com/';
  if (!adapterBase && provider === 'qishui') headers.referer = 'https://qishui.com/';
  if (!adapterBase && provider === 'qishui' && String(pathname).startsWith('/passport')) {
    const csrf = cookieValue(headers.cookie, 'passport_csrf_token');
    if (csrf) headers['x-tt-passport-csrf-token'] = csrf;
    if (options.flow) {
      const trace = crypto.randomBytes(4).toString('hex');
      url.searchParams.set('biz_trace_id', trace);
      url.searchParams.set('msToken', options.flow.msToken);
      headers['x-tt-passport-trace-id'] = trace;
      headers['x-tt-passport-verify-portrait'] = options.headers?.['x-tt-passport-verify-portrait'] || options.flow.verifyPortraitId;
      if (body !== undefined) headers['x-ss-stub'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const request = !adapterBase && provider === 'qishui' && options.flow && String(pathname).startsWith('/passport')
      ? qishuiSignedRequest(url, { method: options.method || 'GET', headers, body }, options.flow)
      : { url, method: options.method || 'GET', headers, body };
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: options.flow ? 'manual' : 'follow', signal: controller.signal });
    if (options.flow || provider === musicProvider()) mergeSetCookies(response.headers, options.flow);
    // Passport 可能先下发会话，再跳转到没有网页的 API 根地址。授权已完成时
    // 直接交还会话，避免把落地页 404 当作扫码失败或再次消费二维码。
    if (options.flow && provider === 'qishui' && String(pathname).includes('/check_qrconnect/') && (cookieValue(options.flow.cookie, 'sessionid') || cookieValue(options.flow.cookie, 'sessionid_ss'))) {
      await response.body?.cancel();
      return { data: { status: 'confirmed' } };
    }
    if (options.flow && provider === 'qishui' && response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel();
      return { data: { status: 'confirmed', redirect_url: new URL(response.headers.get('location'), url).href } };
    }
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { throw musicAuthError(provider, {}, response.status); }
    if (!response.ok) throw musicAuthError(provider, payload, response.status);
    return payload;
  } catch (error) {
    if (error.code && error.retryable !== undefined) throw error;
    const failure = new Error(controller.signal.aborted ? '音乐平台响应超时，请稍后重试' : '无法连接音乐平台，请检查部署服务器的网络');
    failure.code = controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK';
    failure.retryable = true;
    throw failure;
  } finally { clearTimeout(timeout); }
}
function pickArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}
function pickMusicUrl(value) {
  if (!value || typeof value !== 'object') return '';
  const keys = ['url', 'audio_url', 'audioUrl', 'playUrl', 'play_url', 'download_url', 'downloadUrl', 'main_url'];
  for (const key of keys) if (typeof value[key] === 'string' && /^https?:\/\//i.test(value[key])) return value[key];
  for (const key of ['data', 'result', 'song', 'music', 'media', 'track_player', 'video_model']) {
    const found = Array.isArray(value[key]) ? value[key].find((item) => pickMusicUrl(item)) : pickMusicUrl(value[key]);
    if (found) return typeof found === 'string' ? found : pickMusicUrl(found);
  }
  return '';
}
function normalizePlaylist(item) {
  return { id: String(item?.id ?? item?.playlist_id ?? item?.playlistId ?? ''), name: String(item?.name ?? item?.title ?? '未命名歌单'), cover: String(item?.coverImgUrl ?? item?.cover ?? item?.cover_url ?? ''), trackCount: Number(item?.trackCount ?? item?.track_count ?? item?.song_count ?? item?.trackNumberUpdate ?? item?.tracks?.length ?? 0) };
}
function normalizeTrack(item) {
  const nested = item?.track || item?.entity || item?.song || item;
  const artist = Array.isArray(nested?.ar) ? nested.ar.map((entry) => entry.name).filter(Boolean).join(' / ') : (nested?.artist ?? nested?.author ?? nested?.singer ?? nested?.artists?.[0]?.name ?? '未知歌手');
  return { id: String(nested?.id ?? nested?.track_id ?? nested?.trackId ?? ''), title: String(nested?.name ?? nested?.title ?? nested?.track_name ?? '未命名歌曲'), artist: String(artist), album: String(nested?.al?.name ?? nested?.album?.name ?? nested?.album ?? ''), cover: String(nested?.al?.picUrl ?? nested?.album?.picUrl ?? nested?.cover ?? nested?.cover_url ?? '') };
}
function sanitizeMusicTrack(input) {
  const track = normalizeTrack(input);
  return { id: track.id.slice(0, 120), title: track.title.slice(0, 180), artist: track.artist.slice(0, 180), album: track.album.slice(0, 180), cover: track.cover.slice(0, 500) };
}
function musicSearchRows(payload) {
  const data = musicData(payload) || {};
  return [data.result?.songs, data.data?.songs, data.songs, data.tracks, data.items, data.list, data.search_result, data.music_list].find(Array.isArray) || [];
}
function musicRandomRows(payload) {
  const data = musicData(payload) || {};
  return [data, data.result, data.result?.songs, data.result?.result, data.result?.recommend, data.data?.songs, data.data?.tracks, data.songs, data.tracks, data.items, data.list, data.recommend].find(Array.isArray) || [];
}
let randomMusicLoading = null;
async function ensureRandomMusicQueue() {
  const music = db.settings.music || {};
  if (music.randomEnabled === false || !musicLoggedIn()) return Array.isArray(music.queue) ? music.queue : [];
  if (Array.isArray(music.queue) && music.queue.length) return music.queue;
  if (randomMusicLoading) return randomMusicLoading;
  randomMusicLoading = (async () => {
    try {
      const provider = musicProvider();
      const payload = provider === 'qishui'
        ? await musicRequest('/recommend', { method: musicBaseUrl() ? 'GET' : 'POST', body: musicBaseUrl() ? undefined : { count: 50, page: 1 } })
        : await musicRequest(musicBaseUrl() ? '/personalized/newsong' : '/api/personalized/newsong', { search: { limit: 50, timestamp: Date.now() } });
      const rows = musicRandomRows(payload).map(normalizeTrack).map(sanitizeMusicTrack).filter((track) => track.id).slice(0, 100);
      if (rows.length) {
        music.queue = rows;
        music.playlistId = '';
        music.playlistName = '平台随机音乐';
        await saveDb(db);
      }
      return music.queue;
    } catch {
      return Array.isArray(music.queue) ? music.queue : [];
    } finally {
      randomMusicLoading = null;
    }
  })();
  return randomMusicLoading;
}
async function syncMusicAccount() {
  if (!musicConfigured() || !musicLoggedIn()) return null;
  const provider = musicProvider();
  const payload = provider === 'qishui'
    ? await musicRequest(musicBaseUrl() ? '/auth/me' : '/me', { method: musicBaseUrl() ? 'POST' : 'GET', body: musicBaseUrl() ? { sessionid: db.settings.music.sessionId } : undefined })
    : await musicRequest(musicBaseUrl() ? '/user/account' : '/weapi/nuser/account/get', musicBaseUrl() ? {} : { method: 'POST', form: neteaseWeapi({ csrf_token: cookieValue(db.settings.music.cookie, '__csrf') }) });
  if (provider !== musicProvider()) throw new Error('音乐平台已切换');
  const data = musicData(payload) || {};
  const profile = data.my_info || data.profile || data.account || data.user || data;
  if (!(profile.userId ?? profile.uid ?? profile.id)) throw new Error('平台暂未返回账号资料');
  db.settings.music.account = { id: String(profile.userId ?? profile.uid ?? profile.id ?? ''), name: String(profile.nickname ?? profile.name ?? profile.username ?? profile.screen_name ?? '已登录账号'), avatar: String(profile.avatarUrl ?? profile.avatar ?? profile.avatar_url ?? '') };
  await saveDb(db);
  return db.settings.music.account;
}
async function musicQrData(url) {
  return QRCode.toDataURL(url, { width: 256, margin: 2, errorCorrectionLevel: 'M' });
}
function getSession(req) {
  const raw = req.cookies.pulse_session;
  const [token, signature] = String(raw || '').split('.');
  const expected = token ? crypto.createHmac('sha256', sessionSecret).update(token).digest('hex') : '';
  if (!token || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) { if (token) sessions.delete(token); return null; }
  return session;
}
function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: '未登录或会话已过期' });
  req.user = session;
  next();
}

function hashApiToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function createApiToken() {
  const token = `pw_${crypto.randomBytes(30).toString('base64url')}`;
  db.settings.apiTokenHash = hashApiToken(token);
  db.settings.apiTokenPrefix = token.slice(0, 11);
  db.settings.apiTokenCreatedAt = now();
  return token;
}
function apiTokenFromRequest(req) {
  const authorization = String(req.get('authorization') || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return String(req.get('x-api-key') || '').trim();
}
function requireApiToken(req, res, next) {
  const presented = apiTokenFromRequest(req);
  const expected = String(db.settings.apiTokenHash || '');
  const actual = presented ? hashApiToken(presented) : '';
  const valid = Boolean(expected && actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)));
  if (!valid) return res.status(401).json({ error: '缺少有效 API Token', code: 'API_TOKEN_REQUIRED' });
  req.apiTokenAuthenticated = true;
  next();
}
function setSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, username: user.username, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  const signature = crypto.createHmac('sha256', sessionSecret).update(token).digest('hex');
  res.cookie('pulse_session', `${token}.${signature}`, { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 8 * 60 * 60 * 1000, path: '/' });
}
function cleanMonitor(input, existing = {}) {
  const type = ['http', 'api', 'tcp'].includes(input.type) ? input.type : (existing.type || 'http');
  const url = String(input.url ?? existing.url ?? '').trim();
  if (!url || url.length > 2048) throw new Error('请输入有效的监控地址');
  if (type !== 'tcp' && !/^https?:\/\//i.test(url)) throw new Error('HTTP/API 地址必须以 http:// 或 https:// 开头');
  const sort = input.sort !== undefined ? Number(input.sort) : Number(existing.sort ?? db.monitors.length);
  return { ...existing, id: existing.id || id(), name: String(input.name ?? existing.name ?? '未命名服务').trim().slice(0, 100), url, type, method: String(input.method ?? existing.method ?? 'GET').toUpperCase().slice(0, 10), expectedStatus: Number(input.expectedStatus ?? existing.expectedStatus ?? 200), expectedText: String(input.expectedText ?? existing.expectedText ?? '').slice(0, 500), timeoutMs: Math.min(60000, Math.max(1000, Number(input.timeoutMs ?? existing.timeoutMs ?? 10000))), headers: typeof input.headers === 'object' && input.headers ? input.headers : (existing.headers || {}), body: String(input.body ?? existing.body ?? '').slice(0, 10000), categoryId: String(input.categoryId ?? existing.categoryId ?? ''), sort: Number.isFinite(sort) ? sort : db.monitors.length, note: String(input.note ?? existing.note ?? '').slice(0, 500), enabled: input.enabled === undefined ? (existing.enabled ?? true) : Boolean(input.enabled), checkSsl: Boolean(input.checkSsl ?? existing.checkSsl ?? false), sslWarningDays: Math.max(1, Number(input.sslWarningDays ?? existing.sslWarningDays ?? db.settings.sslWarningDays ?? 30)), createdAt: existing.createdAt || now(), updatedAt: now() };
}
function cleanDomain(input, existing = {}) {
  const domain = String(input.domain ?? existing.domain ?? '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error('请输入有效域名');
  const expiryDate = String(input.expiryDate ?? existing.expiryDate ?? '');
  if (expiryDate && Number.isNaN(Date.parse(expiryDate))) throw new Error('到期日期格式无效');
  return { ...existing, id: existing.id || id(), domain, expiryDate, registrar: String(input.registrar ?? existing.registrar ?? '').slice(0, 100), note: String(input.note ?? existing.note ?? '').slice(0, 300), enabled: input.enabled === undefined ? (existing.enabled ?? true) : Boolean(input.enabled), createdAt: existing.createdAt || now(), updatedAt: now() };
}
function statusFor(monitor) {
  const result = db.results[monitor.id];
  if (!result) return { status: 'unknown', ...result };
  return result;
}
function incidentViews(limit = 200) {
  const active = new Map();
  const ordered = db.incidents.slice().sort((a, b) => (Date.parse(a.createdAt || '') || 0) - (Date.parse(b.createdAt || '') || 0)).map((item) => ({ id: item.id, monitorId: item.monitorId, monitorName: item.monitorName, status: item.status, error: item.error || '', createdAt: item.createdAt, startedAt: item.startedAt || (item.status === 'down' ? item.createdAt : null) || null, resolvedAt: item.resolvedAt || null, durationMs: item.durationMs != null && Number.isFinite(Number(item.durationMs)) ? Number(item.durationMs) : null }));
  for (const incident of ordered) {
    if (incident.status === 'down') { active.set(incident.monitorId, incident); continue; }
    const open = active.get(incident.monitorId);
    if (!open) continue;
    const startedAt = open.startedAt || open.createdAt;
    const durationMs = Math.max(0, (Date.parse(incident.createdAt || '') || Date.now()) - (Date.parse(startedAt || '') || Date.now()));
    open.resolvedAt = incident.createdAt;
    open.durationMs = durationMs;
    incident.startedAt = startedAt;
    incident.resolvedAt = incident.createdAt;
    incident.durationMs = durationMs;
    active.delete(incident.monitorId);
  }
  return ordered.reverse().slice(0, limit);
}
function publicData() {
  const monitorOrder = (left, right) => (Number(left.sort) || 0) - (Number(right.sort) || 0);
  const categories = [...db.categories].sort((a, b) => a.sort - b.sort).map(category => ({ ...category, monitors: db.monitors.filter(m => m.enabled && m.categoryId === category.id).sort(monitorOrder).map(m => ({ ...m, headers: undefined, body: undefined, ...statusFor(m) })) }));
  const uncategorized = db.monitors.filter(m => m.enabled && !db.categories.some(c => c.id === m.categoryId)).sort(monitorOrder);
  if (uncategorized.length) categories.push({ id: 'uncategorized', name: '其他服务', sort: 999, monitors: uncategorized.map(m => ({ ...m, headers: undefined, body: undefined, ...statusFor(m) })) });
  const monitors = categories.flatMap(c => c.monitors);
  const up = monitors.filter(m => m.status === 'up').length;
  const down = monitors.filter(m => m.status === 'down').length;
  const overall = down ? 'down' : (monitors.length && up === monitors.length ? 'up' : 'partial');
  const domains = db.domains.filter(d => d.enabled).map(d => ({ ...d, daysRemaining: d.expiryDate ? Math.ceil((new Date(`${d.expiryDate}T23:59:59`) - Date.now()) / 86400000) : null }));
  const incidents = incidentViews(200);
  return { settings: publicSettings(), categories, summary: { overall, total: monitors.length, up, down, checked: up + down, checkedAt: Math.max(...monitors.map(m => Date.parse(m.checkedAt || 0) || 0), 0) || null }, scheduler: { running: schedulerRunning, nextCheckAt: schedulerNextAt ? new Date(schedulerNextAt).toISOString() : null }, domains, incidents };
}
function apiStatusData() {
  const data = publicData();
  return { generatedAt: now(), summary: data.summary, categories: data.categories, domains: data.domains };
}
function apiAlertsData() {
  const data = publicData();
  const monitors = data.categories.flatMap(category => category.monitors);
  const alerts = [];
  for (const monitor of monitors) {
    if (monitor.status === 'down') alerts.push({ type: 'service_down', severity: 'critical', monitorId: monitor.id, name: monitor.name, url: monitor.url, status: monitor.status, error: monitor.error || '', checkedAt: monitor.checkedAt || null });
    if (monitor.ssl?.daysRemaining !== null && monitor.ssl?.daysRemaining !== undefined && monitor.ssl.daysRemaining <= Number(monitor.sslWarningDays || db.settings.sslWarningDays || 30)) alerts.push({ type: 'ssl_expiring', severity: monitor.ssl.daysRemaining < 0 ? 'critical' : 'warning', monitorId: monitor.id, name: monitor.name, url: monitor.url, daysRemaining: monitor.ssl.daysRemaining, expiresAt: monitor.ssl.expiresAt || null });
  }
  for (const domain of data.domains) if (domain.daysRemaining !== null && domain.daysRemaining <= Number(db.settings.domainWarningDays || 30)) alerts.push({ type: 'domain_expiring', severity: domain.daysRemaining < 0 ? 'critical' : 'warning', domainId: domain.id, domain: domain.domain, daysRemaining: domain.daysRemaining, expiryDate: domain.expiryDate || null });
  return { generatedAt: now(), count: alerts.length, alerts };
}

let updateCheckCache = { expiresAt: 0, data: null };
async function githubJson(pathname) {
  const response = await fetch(`https://api.github.com/repos/${githubRepository}/${pathname}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Status-Girl-update-check' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  return response.json();
}
async function githubText(tag, pathname) {
  const response = await fetch(`https://raw.githubusercontent.com/${githubRepository}/${encodeURIComponent(tag)}/${pathname}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`GitHub 文件返回 ${response.status}`);
  return response.text();
}
async function checkGitHubUpdate() {
  const base = { currentVersion: appVersion, latestVersion: appVersion, updateAvailable: false, title: '', body: '', publishedAt: '', releaseUrl: githubProjectUrl, tagUrl: githubProjectUrl, checkedAt: now() };
  try {
    const results = await Promise.allSettled([githubJson('releases?per_page=20'), githubJson('tags?per_page=20')]);
    let candidate = null;
    for (const result of results) {
      if (result.status !== 'fulfilled' || !Array.isArray(result.value)) continue;
      const found = chooseVersionedRelease(result.value);
      if (found && (!candidate || compareVersions(found.version, candidate.version) > 0)) candidate = found;
    }
    if (!candidate) return { ...base, unavailable: true };
    const entry = candidate.entry;
    const tag = String(entry?.tag_name ?? entry?.name ?? candidate.version);
    const tagUrl = `${githubProjectUrl}/tree/${encodeURIComponent(tag)}`;
    const releaseUrl = String(entry?.html_url || tagUrl);
    let body = String(entry?.body || '').trim();
    if (!body) {
      try {
        body = changelogSection(await githubText(tag, 'CHANGELOG.md'), candidate.version);
      } catch { /* 更新记录不可用时保留版本信息 */ }
    }
    return {
      ...base,
      latestVersion: candidate.version,
      updateAvailable: compareVersions(candidate.version, appVersion) > 0,
      title: String(entry?.name || `Status姬 v${candidate.version}`).slice(0, 180),
      body: String(body || 'GitHub 已发布新版本，去看看这次为值班室带来了什么变化吧。').slice(0, 4000),
      publishedAt: String(entry?.published_at || entry?.created_at || ''),
      releaseUrl,
      tagUrl,
      source: entry?.html_url ? 'release' : 'tag'
    };
  } catch {
    return { ...base, unavailable: true };
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), now: now() }));
app.get('/api/public', (_req, res) => res.json(publicData()));
app.get('/api/music/config', async (_req, res) => {
  let account = db.settings.music?.account || null;
  if (musicConfigured() && musicLoggedIn() && !account) { try { account = await syncMusicAccount(); } catch { /* keep public playback available while the provider is slow */ } }
  const music = db.settings.music || {};
  if (music.randomEnabled !== false && musicLoggedIn() && !music.queue?.length) await ensureRandomMusicQueue();
  res.json({ configured: musicConfigured(), provider: musicProvider(), loggedIn: musicLoggedIn(), account, providerLabel: musicProvider() === 'qishui' ? '汽水音乐' : '网易云音乐', playlistName: music.playlistName || '', randomEnabled: music.randomEnabled !== false, playMode: music.playMode || 'random', queue: Array.isArray(music.queue) ? music.queue.slice(0, 300) : [] });
});
app.get('/api/music/random', async (_req, res) => {
  const queue = await ensureRandomMusicQueue();
  if (!queue.length) return res.status(404).json({ error: musicLoggedIn() ? '平台暂时没有返回随机歌曲' : '请先在后台连接音乐平台' });
  res.json({ queue: queue.slice(0, 300), playlistName: db.settings.music.playlistName || '平台随机音乐' });
});
function removeMusicQrFlow(token) {
  const flow = musicQrFlows.get(token);
  if (flow) { clearTimeout(flow.expiryTimer); flow.cancelled = true; flow.signingRequest = null; flow.signedRequest = null; }
  musicQrFlows.delete(token);
}
function clearMusicQrFlows() {
  for (const token of musicQrFlows.keys()) removeMusicQrFlow(token);
}
function registerMusicQrFlow(req) {
  for (const [token, flow] of musicQrFlows) if (flow.expiresAt < Date.now() || flow.userId === req.user.userId) removeMusicQrFlow(token);
  const flow = { token: id(), provider: musicProvider(), generation: musicAuthGeneration, userId: req.user.userId, cookie: '', sessionId: '', expiresAt: Date.now() + 180000, confirmed: false, progress: 'pending', stage: 'create' };
  flow.expiryTimer = setTimeout(() => removeMusicQrFlow(flow.token), 181000);
  flow.expiryTimer.unref();
  musicQrFlows.set(flow.token, flow);
  return flow;
}
async function createMusicQr(flow) {
  const provider = flow.provider;
  let qr;
  if (musicBaseUrl()) {
    if (provider === 'qishui') qr = normalizeQr(await musicRequest('/auth/qrcode', { flow }));
    else {
      const key = normalizeQr(await musicRequest('/login/qr/key', { flow, search: { timestamp: Date.now() } })).token;
      qr = normalizeQr(await musicRequest('/login/qr/create', { flow, search: { key, qrimg: 'true', timestamp: Date.now() } }));
      qr.token = key;
    }
  } else if (provider === 'qishui') {
    if (!flow.passportQuery) {
      flow.passportQuery = qishuiPassportQuery();
      flow.verifyPortraitId = crypto.randomUUID() + '.login';
      flow.msToken = crypto.randomBytes(88).toString('base64url') + '==';
      await saveDb(db);
    }
    qr = normalizeQr(await musicRequest('/passport/web/get_qrcode/', { flow, search: { ...flow.passportQuery, need_logo: 'false', need_short_url: 'false', is_new_login: '1', next: 'https://api.qishui.com' } }));
  } else {
    flow.cookie = `__remember_me=true; os=pc; appver=3.1.17.204416; channel=netease; deviceId=${musicDeviceId()}; _ntes_nuid=${crypto.randomBytes(16).toString('hex')}`;
    qr = normalizeQr(await musicRequest('/weapi/login/qrcode/unikey', { flow, method: 'POST', form: neteaseWeapi({ type: 3, csrf_token: '' }) }));
    qr.url = NETEASE_ORIGIN + '/login?codekey=' + encodeURIComponent(qr.token);
  }
  if (!qr.token || !(qr.image || qr.url)) throw new Error('音乐平台未返回完整二维码，请重试');
  const candidate = qr.image || qr.url;
  const qrCode = /^data:image\/(png|jpe?g|webp);base64,/i.test(candidate) ? candidate : await musicQrData(qr.url || candidate);
  if (flow.cancelled || provider !== musicProvider() || flow.generation !== musicAuthGeneration) throw Object.assign(new Error('二维码已失效，请重新获取'), { status: 409 });
  flow.upstreamToken = qr.token;
  flow.expiresAt = Math.min(Date.now() + 180000, qr.expiresAt);
  clearTimeout(flow.expiryTimer);
  flow.expiryTimer = setTimeout(() => removeMusicQrFlow(flow.token), Math.max(0, flow.expiresAt - Date.now()) + 1000);
  flow.expiryTimer.unref();
  flow.stage = 'status';
  return { provider, providerLabel: provider === 'qishui' ? '汽水音乐' : '网易云音乐', token: flow.token, qrCode, scanApp: qr.scanApp, expiresAt: new Date(flow.expiresAt).toISOString() };
}
async function respondMusicQr(flow, res, action = flow.stage) {
  res.setHeader('cache-control', 'no-store');
  if (flow.pending && flow.pendingAction !== action) return res.status(409).json({ error: '正在处理登录请求，请稍后重试', retryable: true });
  try {
    flow.pendingAction = action;
    flow.pending ??= (action === 'verification-start' ? startQishuiVerification(flow) : action === 'create' ? createMusicQr(flow) : checkMusicQr(flow)).finally(() => { flow.pending = null; });
    res.json(await flow.pending);
  } catch (error) {
    if (error.signing && !flow.cancelled) { flow.signingAction = action; return res.json({ token: flow.token, signing: error.signing }); }
    if (flow.stage === 'create') removeMusicQrFlow(flow.token);
    res.status(error.status || 502).json({ error: error.message || '音乐登录请求失败', code: error.code, retryable: error.retryable ?? true });
  }
}
app.get('/api/music/login/qr', requireAdmin, async (req, res) => {
  await respondMusicQr(registerMusicQrFlow(req), res);
});
async function exchangeQishuiRedirect(flow, redirect) {
  let next = redirect;
  const signal = AbortSignal.timeout(12000);
  for (let hop = 0; next && hop < 5; hop += 1) {
    const url = new URL(next, 'https://api.qishui.com');
    if (url.protocol !== 'https:' || !['qishui.com', 'api.qishui.com', 'bff-pc.qishui.com', 'auth.zijieapi.com'].includes(url.hostname) || url.username || url.password) throw new Error('平台返回了无效登录跳转');
    const response = await fetch(url, { redirect: 'manual', headers: { cookie: flow.cookie || '', 'user-agent': flow.userAgent || musicSessionHeaders()['user-agent'] }, signal });
    mergeSetCookies(response.headers, flow);
    if (cookieValue(flow.cookie, 'sessionid') || cookieValue(flow.cookie, 'sessionid_ss')) { await response.body?.cancel(); return; }
    next = response.status >= 300 && response.status < 400 && response.headers.get('location') ? new URL(response.headers.get('location'), url).href : '';
    if (!response.ok && !(response.status >= 300 && response.status < 400)) { await response.body?.cancel(); throw musicAuthError('qishui', {}, response.status); }
    flow.sessionId ||= url.searchParams.get('sessionid') || url.searchParams.get('session_id') || url.searchParams.get('sessionid_ss') || '';
    await response.body?.cancel();
  }
  if (next) throw new Error('汽水登录授权跳转次数过多，请重新生成二维码');
}
async function checkMusicQr(flow) {
  if (flow.confirmed) return { status: 'confirmed', loggedIn: true, account: db.settings.music.account };
  if (flow.verification && !flow.verification.resend) return flow.lastResult;
  if (flow.provider === 'qishui' && flow.nextCheckAt > Date.now() && flow.lastResult) return flow.lastResult;
  const adapter = Boolean(musicBaseUrl());
  let payload;
  // 授权回调若暂时失败，重试该回调，避免再次读取已消费的二维码状态。
  if (flow.redirect) payload = { data: { status: 'confirmed', redirect_url: flow.redirect, sessionid: flow.sessionId } };
  else if (adapter) payload = flow.provider === 'qishui'
    ? await musicRequest('/auth/qrcode/status', { flow, method: 'POST', body: { token: flow.upstreamToken } })
    : await musicRequest('/login/qr/check', { flow, search: { key: flow.upstreamToken, timestamp: Date.now() } });
  else payload = flow.provider === 'qishui'
    ? await musicRequest('/passport/web/check_qrconnect/', { flow, method: 'POST', search: { ...flow.passportQuery, ...(flow.verification?.resend ? { isResend: 'true' } : {}) }, form: { ...verificationBizParams(flow.verification?.decision), token: flow.upstreamToken, need_logo: 'false', need_short_url: 'false', is_frontier: 'true', next: 'https://api.qishui.com', is_new_login: '1' } })
    : await musicRequest('/weapi/login/qrcode/client/login', { flow, method: 'POST', form: neteaseWeapi({ key: flow.upstreamToken, type: 3, csrf_token: cookieValue(flow.cookie, '__csrf') }) });
  const result = qrStatus(flow.provider, payload, adapter);
  if (result.status === 'verification_required') {
    const repeated = Boolean(flow.verification);
    flow.verification = { id: id(), decision: publicVerificationData(result.decision), ready: false, resend: false };
    // 官方验证可能需要短信/滑块；只放宽本地会话，不伪造二维码的官方有效期。
    flow.verificationExpiresAt ||= Date.now() + 600000;
    flow.expiresAt = flow.verificationExpiresAt;
    clearTimeout(flow.expiryTimer);
    flow.expiryTimer = setTimeout(() => removeMusicQrFlow(flow.token), Math.max(0, flow.expiresAt - Date.now()) + 1000);
    flow.expiryTimer.unref();
    flow.lastResult = { status: 'verification_required', message: repeated ? '平台仍要求验证，请点击继续身份验证。' : result.message, verification: { id: flow.verification.id, expiresAt: new Date(flow.expiresAt).toISOString(), available: !adapter } };
    return flow.lastResult;
  }
  if (result.cookie) flow.cookie = mergeCookies(flow.cookie, result.cookie.split(';').map(value => value.trim()));
  if (result.status === 'pending' && flow.progress === 'authorizing' && (flow.provider === 'qishui' ? cookieValue(flow.cookie, 'sessionid') || cookieValue(flow.cookie, 'sessionid_ss') : cookieValue(flow.cookie, 'MUSIC_U'))) result.status = 'confirmed';
  if (result.status === 'scanned' && flow.progress !== 'authorizing') flow.progress = 'scanned';
  if (result.status === 'confirmed') flow.progress = 'authorizing';
  if (result.status !== 'confirmed') {
    flow.lastResult = { status: result.status === 'pending' ? (flow.progress || 'pending') : result.status, message: result.message, retryAfterMs: result.retryAfterMs };
    if (flow.provider === 'qishui') flow.nextCheckAt = Date.now() + (result.retryAfterMs || 2500);
    return flow.lastResult;
  }
  if (flow.provider === 'qishui' && result.redirect && !(result.sessionId || cookieValue(flow.cookie, 'sessionid') || cookieValue(flow.cookie, 'sessionid_ss'))) {
    flow.redirect = result.redirect;
    await exchangeQishuiRedirect(flow, flow.redirect);
    flow.redirect = '';
  }
  flow.sessionId = result.sessionId || flow.sessionId || cookieValue(flow.cookie, 'sessionid') || cookieValue(flow.cookie, 'sessionid_ss') || '';
  const sessionId = flow.sessionId;
  const credential = flow.provider === 'qishui' ? sessionId : cookieValue(flow.cookie, 'MUSIC_U');
  if (!credential) return { status: 'authorizing', message: '手机已确认，正在等待平台完成授权…' };
  if (flow.cancelled || flow.provider !== musicProvider() || flow.generation !== musicAuthGeneration) return { status: 'expired' };
  if (flow.provider === 'qishui' && !cookieValue(flow.cookie, 'sessionid')) flow.cookie = mergeCookies(flow.cookie, [`sessionid=${sessionId}`]);
  db.settings.music.cookie = flow.cookie;
  db.settings.music.sessionId = flow.provider === 'qishui' ? sessionId : '';
  db.settings.music.account = null;
  await saveDb(db);
  flow.confirmed = true;
  flow.verification = null;
  flow.signingRequest = null;
  flow.signedRequest = null;
  // 资料、歌单查询失败不回滚已落盘的登录；由后续配置请求独立同步。
  return { status: 'confirmed', loggedIn: true, account: null };
}
function findMusicQrFlow(req, res) {
  const token = String(req.query.token || req.body?.token || '');
  const flow = musicQrFlows.get(token);
  if (!flow || flow.userId !== req.user.userId) { res.status(404).json({ error: '二维码登录流程已失效，请重新获取' }); return null; }
  if (flow.expiresAt < Date.now() || flow.provider !== musicProvider() || flow.generation !== musicAuthGeneration) { removeMusicQrFlow(token); res.json({ status: 'expired' }); return null; }
  return flow;
}
app.get('/api/music/login/qr/status', requireAdmin, async (req, res) => {
  const flow = findMusicQrFlow(req, res);
  if (flow) await respondMusicQr(flow, res);
});
app.post('/api/music/login/qr/signature', requireAdmin, async (req, res) => {
  const flow = findMusicQrFlow(req, res);
  if (!flow) return;
  try {
    if (flow.pending) return res.status(409).json({ error: '正在处理汽水登录请求，请稍后重试', retryable: true });
    acceptQishuiSignature(flow, req.body || {});
  } catch (error) { return res.status(400).json({ error: error.message, code: error.code, retryable: false }); }
  await respondMusicQr(flow, res, flow.signingAction);
});
async function startQishuiVerification(flow) {
  const verification = flow.verification;
  if (!verification || flow.provider !== 'qishui' || musicBaseUrl()) throw Object.assign(new Error('当前登录流程没有可用的身份验证'), { status: 409 });
  let decision = verification.decision;
  if (!verification.ready && decision.verify_from === 'verify_center') {
    const payload = await musicRequest('/passport/safe/pack_verify_ways_data/', { flow, method: 'POST', search: { aid: '386088' }, form: verificationForm(decision, flow.passportQuery), headers: { 'x-tt-passport-verify-portrait': decision.verify_portrait_id || flow.verifyPortraitId } });
    const expanded = musicData(payload);
    if (!expanded || Number(expanded.error_code) > 0 || payload.message === 'error') throw musicAuthError('qishui', payload);
    decision = { ...decision, ...publicVerificationData(expanded), biz_params: decision.biz_params };
  }
  const scriptUrl = verificationScript(decision.url);
  if (flow.cancelled || flow.verification !== verification) throw Object.assign(new Error('身份验证已失效'), { status: 409 });
  verification.decision = decision;
  verification.ready = true;
  return { token: flow.token, verificationId: verification.id, decision, scriptUrl, generalParams: flow.passportQuery, msToken: flow.msToken, expiresAt: new Date(flow.expiresAt).toISOString() };
}
function findQishuiVerification(req, res) {
  res.setHeader('cache-control', 'no-store');
  const flow = findMusicQrFlow(req, res);
  if (!flow) return null;
  if (flow.provider !== 'qishui' || musicBaseUrl() || !flow.verification || flow.verification.id !== req.body?.verificationId || flow.confirmed) { res.status(409).json({ error: '身份验证会话已失效，请重新扫码', retryable: false }); return null; }
  return flow;
}
app.post('/api/music/login/qr/verification/start', requireAdmin, async (req, res) => {
  const flow = findQishuiVerification(req, res);
  if (flow) await respondMusicQr(flow, res, 'verification-start');
});
app.post('/api/music/login/qr/verification/request', requireAdmin, async (req, res) => {
  const flow = findQishuiVerification(req, res);
  if (!flow) return;
  if (!flow.verification.ready || flow.verification.resend || flow.verification.pending >= 4) return res.status(409).json({ error: '验证请求正在处理或已经结束', retryable: true });
  let request;
  try { request = verificationRequest(req.body.request, flow); }
  catch (error) { return res.status(400).json({ error: error.message, retryable: false }); }
  const verification = flow.verification;
  verification.pending = (verification.pending || 0) + 1;
  try {
    const response = await fetch(request.url, { method: request.method, body: request.body, headers: request.headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (request.url.pathname.startsWith('/passport/')) {
      mergeSetCookies(response.headers, flow);
      const token = response.headers.get('x-ms-token') || request.url.searchParams.get('msToken');
      if (/^[A-Za-z0-9/_+=-]{20,200}$/.test(token || '')) flow.msToken = token;
    }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('身份验证接口返回了不受支持的跳转'); }
    const data = await verificationResponse(response);
    if (flow.cancelled || flow.verification !== verification) return res.status(409).json({ error: '身份验证已取消', retryable: false });
    const headers = Object.fromEntries(['content-type', 'x-tt-logid', 'x-ms-token'].map(name => [name, response.headers.get(name)]).filter(([, value]) => value));
    res.json({ status: response.status, body: JSON.stringify(publicVerificationData(data)), headers });
  } catch (error) { res.status(502).json({ error: error.message || '无法连接身份验证接口，请重试', retryable: true }); }
  finally { verification.pending -= 1; }
});
app.post('/api/music/login/qr/verification/complete', requireAdmin, async (req, res) => {
  const flow = findQishuiVerification(req, res);
  if (!flow) return;
  if (!flow.verification.ready || flow.verification.pending || flow.pending) return res.status(409).json({ error: '身份验证尚未就绪，请稍后重试', retryable: true });
  flow.verification.resend = true;
  flow.nextCheckAt = 0;
  flow.signingRequest = null;
  flow.signedRequest = null;
  await respondMusicQr(flow, res, 'status');
});
app.get('/api/music/playlists', requireAdmin, async (_req, res) => {
  try {
    if (!musicLoggedIn()) return res.status(401).json({ error: '请先扫码登录音乐平台' });
    const provider = musicProvider();
    const payload = provider === 'qishui'
      ? await musicRequest(musicBaseUrl() ? '/me/playlists' : '/me/playlist', { method: musicBaseUrl() ? 'POST' : 'GET', body: musicBaseUrl() ? { sessionid: db.settings.music.sessionId } : undefined })
      : await musicRequest(musicBaseUrl() ? '/user/playlist' : '/api/user/playlist', { search: { uid: (db.settings.music.account || await syncMusicAccount())?.id, limit: 50, offset: 0, timestamp: Date.now() } });
    const data = musicData(payload);
    const rows = pickArray(data, ['playlist', 'playlists', 'items', 'list']).map(normalizePlaylist).filter((item) => item.id);
    res.json({ playlists: rows });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/music/search', requireAdmin, async (req, res) => {
  try {
    if (!musicLoggedIn()) return res.status(401).json({ error: '请先扫码登录音乐平台' });
    const query = String(req.query.q || '').trim().slice(0, 80);
    if (!query) return res.status(400).json({ error: '请输入歌曲名或歌手' });
    const provider = musicProvider();
    let payload;
    if (musicBaseUrl()) {
      payload = await musicRequest('/search', { search: { q: query, keyword: query, limit: 30, page: 1 } });
    } else if (provider === 'netease') {
      payload = await musicRequest('/weapi/cloudsearch/pc', { method: 'POST', form: neteaseWeapi({ s: query, type: 1, offset: 0, total: true, limit: 30 }) });
    } else {
      payload = await musicRequest('/search', { method: 'POST', body: { keyword: query, query, page: 1, page_size: 30, count: 30 } });
    }
    const tracks = musicSearchRows(payload).map(sanitizeMusicTrack).filter((track) => track.id).slice(0, 30);
    res.json({ tracks });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.post('/api/music/queue', requireAdmin, async (req, res) => {
  try {
    if (!musicLoggedIn()) return res.status(401).json({ error: '请先扫码登录音乐平台' });
    const track = sanitizeMusicTrack(req.body || {});
    if (!track.id) return res.status(400).json({ error: '歌曲信息无效' });
    const music = db.settings.music;
    const queue = Array.isArray(music.queue) ? music.queue.filter((item) => String(item?.id) !== track.id) : [];
    queue.push(track);
    music.queue = queue.slice(-300);
    music.playlistName = music.playlistId ? `${music.playlistName || '歌单'} + 搜索` : '后台搜索队列';
    await saveDb(db);
    res.json({ track, queue: music.queue });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/music/queue', requireAdmin, async (_req, res) => {
  db.settings.music.queue = [];
  db.settings.music.playlistId = '';
  db.settings.music.playlistName = '';
  db.settings.music.randomEnabled = true;
  db.settings.music.playMode = 'random';
  await saveDb(db);
  res.json({ ok: true });
});
app.delete('/api/music/queue/:id', requireAdmin, async (req, res) => {
  const trackId = String(req.params.id || '');
  const music = db.settings.music;
  const before = Array.isArray(music.queue) ? music.queue.length : 0;
  music.queue = (music.queue || []).filter((track) => String(track?.id) !== trackId);
  if (!music.queue.length) { music.playlistId = ''; music.playlistName = ''; music.randomEnabled = true; music.playMode = 'random'; }
  await saveDb(db);
  res.json({ ok: true, removed: before - music.queue.length, queue: music.queue });
});
app.put('/api/admin/music/random', requireAdmin, async (req, res) => {
  const music = db.settings.music;
  music.randomEnabled = !music.queue?.length || req.body?.enabled !== false;
  music.playMode = music.randomEnabled ? 'random' : 'sequential';
  if (music.randomEnabled && !music.queue.length) await ensureRandomMusicQueue();
  await saveDb(db);
  res.json({ ok: true, randomEnabled: music.randomEnabled, playMode: music.playMode, queue: music.queue || [] });
});
app.post('/api/music/playlist/:id', requireAdmin, async (req, res) => {
  try {
    if (!musicLoggedIn()) return res.status(401).json({ error: '请先扫码登录音乐平台' });
    const playlistId = String(req.params.id);
    const provider = musicProvider();
    const payload = provider === 'qishui'
      ? await musicRequest('/playlist/detail', { search: { playlist_id: playlistId, cursor: '', count: 100 } })
      : await musicRequest(musicBaseUrl() ? '/playlist/track/all' : '/api/playlist/track/all', { search: { id: playlistId, limit: 100, offset: 0, timestamp: Date.now() } });
    const data = musicData(payload);
    const rows = pickArray(data, ['songs', 'tracks', 'items', 'list', 'media_resources']).map(normalizeTrack).filter((item) => item.id).slice(0, 300);
    if (!rows.length) return res.status(404).json({ error: '这个歌单没有可播放歌曲' });
    db.settings.music.playlistId = playlistId;
    db.settings.music.playlistName = String(req.body?.name || db.settings.music.playlistName || '已选歌单').slice(0, 120);
    db.settings.music.queue = rows;
    db.settings.music.randomEnabled = true;
    db.settings.music.playMode = 'random';
    await saveDb(db);
    res.json({ tracks: rows, playlistName: db.settings.music.playlistName });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/music/track/:id/url', async (req, res) => {
  try {
    if (!musicLoggedIn()) return res.status(401).json({ error: '请先扫码登录音乐平台' });
    const trackId = String(req.params.id);
    const payload = musicProvider() === 'qishui'
      ? await musicRequest(musicBaseUrl() ? '/download/url' : '/track_v2', { method: musicBaseUrl() ? 'GET' : 'POST', search: musicBaseUrl() ? { track_id: trackId } : {}, body: musicBaseUrl() ? undefined : { track_id: trackId, media_type: 'audio', queue_type: 'search_one_track', scene_name: 'search' } })
      : await musicRequest(musicBaseUrl() ? '/song/url/v1' : '/api/song/enhance/player/url', { search: musicBaseUrl() ? { id: trackId, level: 'standard', timestamp: Date.now() } : { ids: `[${trackId}]`, br: 192000, timestamp: Date.now() } });
    const url = pickMusicUrl(payload);
    if (!url) return res.status(404).json({ error: '当前歌曲没有可播放音源' });
    res.json({ url });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.post('/api/music/logout', requireAdmin, async (_req, res) => { musicAuthGeneration += 1; clearMusicQrFlows(); db.settings.music.cookie = ''; db.settings.music.sessionId = ''; db.settings.music.account = null; db.settings.music.playlistId = ''; db.settings.music.playlistName = ''; db.settings.music.queue = []; await saveDb(db); res.json({ ok: true }); });
app.put('/api/admin/music/provider', requireAdmin, async (req, res) => {
  const provider = ['netease', 'qishui'].includes(req.body?.provider) ? req.body.provider : 'netease';
  if (provider !== db.settings.music.provider) {
    musicAuthGeneration += 1; clearMusicQrFlows();
    db.settings.music.provider = provider;
    db.settings.music.cookie = '';
    db.settings.music.sessionId = '';
    db.settings.music.account = null;
    db.settings.music.playlistId = '';
    db.settings.music.playlistName = '';
    db.settings.music.queue = [];
    db.settings.music.randomEnabled = true;
    db.settings.music.playMode = 'random';
  }
  await saveDb(db);
  res.json({ ok: true, provider });
});
app.get('/api/v1/health', (_req, res) => res.json({ ok: true, service: 'status-girl', uptime: process.uptime(), now: now() }));
app.get('/api/v1/status', requireApiToken, (_req, res) => res.json(apiStatusData()));
app.get('/api/v1/status/:id', requireApiToken, (req, res) => {
  const data = apiStatusData();
  const monitor = data.categories.flatMap(category => category.monitors).find(item => item.id === req.params.id);
  if (!monitor) return res.status(404).json({ error: '服务不存在', code: 'MONITOR_NOT_FOUND' });
  res.json({ generatedAt: data.generatedAt, monitor });
});
app.get('/api/v1/events', requireApiToken, (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const since = req.query.since ? Date.parse(String(req.query.since)) : NaN;
  const events = incidentViews(200).filter(item => Number.isNaN(since) || Date.parse(item.createdAt) > since).slice(0, limit);
  res.json({ generatedAt: now(), count: events.length, events });
});
app.get('/api/v1/alerts', requireApiToken, (_req, res) => res.json(apiAlertsData()));
app.get('/api/metrics', async (_req, res) => {
  if (!db.settings.publicMetrics) return res.status(403).json({ error: '服务器指标未公开' });
  res.json(await getServerMetrics());
});
const weatherCache = new Map();
const weatherLabel = code => ({0:'晴朗',1:'大部晴朗',2:'局部多云',3:'阴天',45:'雾',48:'雾凇',51:'小毛雨',53:'毛雨',55:'中雨',61:'小雨',63:'中雨',65:'大雨',71:'小雪',73:'中雪',75:'大雪',80:'阵雨',81:'阵雨',82:'强阵雨',95:'雷雨',96:'雷雨冰雹',99:'强雷雨冰雹'}[code] || '天气变化');
const fallbackWeather = city => { const base = new Date(); return { city, country: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, current: { temperature: 21, apparent: 20, humidity: 62, precipitation: 0, wind: 9, code: 1, label: '大部晴朗', isDay: 1 }, hourly: Array.from({ length: 5 }, (_, i) => { const d = new Date(base.getTime() + i * 3600000); return { time: d.toISOString(), temperature: 21 + Math.round(Math.sin(i) * 3), probability: 5 + i * 3, code: i === 2 ? 2 : 1, label: i === 2 ? '局部多云' : '大部晴朗' }; }), daily: Array.from({ length: 3 }, (_, i) => { const d = new Date(base.getTime() + i * 86400000); return { time: d.toISOString().slice(0, 10), max: 23 + i, min: 15 + i, code: i === 2 ? 2 : 1, label: i === 2 ? '局部多云' : '大部晴朗' }; }), fetchedAt: now(), isFallback: true }; };

app.get('/api/weather', async (req, res) => {
  if (db.settings.weather?.enabled === false) return res.status(404).json({ error: '天气组件未启用' });
  const city = String(req.query.city || db.settings.weather?.city || '杭州').trim().slice(0, 80);
  const cached = weatherCache.get(city);
  if (cached && cached.expiresAt > Date.now()) return res.json(cached.data);
  try {
    const geoResponse = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`);
    if (!geoResponse.ok) throw new Error('天气位置查询失败');
    const geo = await geoResponse.json();
    const place = geo.results?.[0];
    if (!place) return res.status(404).json({ error: `未找到城市：${city}` });
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude: place.latitude, longitude: place.longitude, current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day', hourly: 'temperature_2m,weather_code,precipitation_probability', daily: 'weather_code,temperature_2m_max,temperature_2m_min', timezone: 'auto', forecast_days: '5' });
    const response = await fetch(url);
    if (!response.ok) throw new Error('天气预报请求失败');
    const forecast = await response.json();
    const current = forecast.current;
    const nowIndex = Math.max(0, forecast.hourly.time.findIndex(t => t >= current.time));
    const data = { city: place.name, country: place.country, timezone: forecast.timezone, current: { temperature: current.temperature_2m, apparent: current.apparent_temperature, humidity: current.relative_humidity_2m, precipitation: current.precipitation, wind: current.wind_speed_10m, code: current.weather_code, label: weatherLabel(current.weather_code), isDay: current.is_day }, hourly: forecast.hourly.time.slice(nowIndex, nowIndex + 5).map((time, i) => ({ time, temperature: forecast.hourly.temperature_2m[nowIndex + i], probability: forecast.hourly.precipitation_probability?.[nowIndex + i] ?? 0, code: forecast.hourly.weather_code[nowIndex + i], label: weatherLabel(forecast.hourly.weather_code[nowIndex + i]) })), daily: forecast.daily.time.slice(0, 3).map((time, i) => ({ time, max: forecast.daily.temperature_2m_max[i], min: forecast.daily.temperature_2m_min[i], code: forecast.daily.weather_code[i], label: weatherLabel(forecast.daily.weather_code[i]) })), fetchedAt: now() };
    weatherCache.set(city, { expiresAt: Date.now() + 10 * 60 * 1000, data });
    res.json(data);
  } catch (error) { const fallback = fallbackWeather(city); weatherCache.set(city, { expiresAt: Date.now() + 5 * 60 * 1000, data: fallback }); res.json(fallback); }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = db.users.find(item => item.username === username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: '用户名或密码错误' });
  setSession(res, user);
  res.json({ ok: true, username: user.username, mustChangePassword: Boolean(user.mustChangePassword) });
});
app.post('/api/logout', (req, res) => { const token = String(req.cookies.pulse_session || '').split('.')[0]; if (token) sessions.delete(token); res.clearCookie('pulse_session'); res.json({ ok: true }); });

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ username: req.user.username, mustChangePassword: Boolean(db.users.find(u => u.id === req.user.userId)?.mustChangePassword) }));
app.get('/api/admin/state', requireAdmin, async (req, res) => {
  const settings = JSON.parse(JSON.stringify(db.settings));
  if (settings.smtp) settings.smtp.pass = settings.smtp.pass ? '••••••••' : '';
  if (settings.music) { settings.music.loggedIn = musicLoggedIn(); settings.music.cookie = ''; settings.music.sessionId = ''; }
  res.json({ admin: { username: req.user.username, mustChangePassword: Boolean(db.users.find(u => u.id === req.user.userId)?.mustChangePassword) }, settings, categories: db.categories, monitors: db.monitors.map(m => ({ ...m, ...statusFor(m) })), domains: db.domains.map(d => ({ ...d, daysRemaining: d.expiryDate ? Math.ceil((new Date(`${d.expiryDate}T23:59:59`) - Date.now()) / 86400000) : null })), notifications: db.notifications.slice(-50).reverse(), incidents: incidentViews(50), metrics: await getServerMetrics(), apiToken: { configured: Boolean(db.settings.apiTokenHash), prefix: db.settings.apiTokenPrefix || '', createdAt: db.settings.apiTokenCreatedAt || '' } });
});
app.get('/api/admin/update-check', requireAdmin, async (_req, res) => {
  if (updateCheckCache.data && updateCheckCache.expiresAt > Date.now()) return res.json(updateCheckCache.data);
  const data = await checkGitHubUpdate();
  updateCheckCache = { data, expiresAt: Date.now() + (data.unavailable ? 2 : 10) * 60 * 1000 };
  res.json(data);
});
app.get('/api/admin/api-token', requireAdmin, (_req, res) => res.json({ configured: Boolean(db.settings.apiTokenHash), prefix: db.settings.apiTokenPrefix || '', createdAt: db.settings.apiTokenCreatedAt || '' }));
app.post('/api/admin/api-token', requireAdmin, async (_req, res) => { const token = createApiToken(); await saveDb(db); res.json({ ok: true, token, prefix: db.settings.apiTokenPrefix, createdAt: db.settings.apiTokenCreatedAt }); });
app.delete('/api/admin/api-token', requireAdmin, async (_req, res) => { db.settings.apiTokenHash = ''; db.settings.apiTokenPrefix = ''; db.settings.apiTokenCreatedAt = ''; await saveDb(db); res.json({ ok: true }); });
app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const input = req.body || {};
  let presentation;
  try { presentation = validateAppearance(input); } catch (error) { return res.status(400).json({ error: error.message }); }
  if ((presentation.backgroundMode ?? db.settings.backgroundMode) === 'fixed' && !(presentation.fixedBackgroundUrl ?? db.settings.fixedBackgroundUrl)) return res.status(400).json({ error: '使用固定背景时请填写图片地址' });
  Object.assign(db.settings, presentation);
  const allowed = ['siteName', 'siteDescription', 'announcement', 'refreshSeconds', 'historyDays', 'publicMetrics', 'accentColor', 'logoText', 'sslWarningDays', 'domainWarningDays'];
  for (const key of allowed) if (input[key] !== undefined) {
    if (key === 'refreshSeconds') db.settings[key] = Math.max(60, Math.min(86400, Number(input[key]) || 300));
    else if (key === 'historyDays') db.settings[key] = Math.min(30, Math.max(1, Number(input[key]) || 7));
    else db.settings[key] = input[key];
  }
  if (input.historyDays !== undefined) pruneAllHistories();
  if (input.smtp) db.settings.smtp = { ...db.settings.smtp, ...input.smtp, pass: input.smtp.pass === '••••••••' ? db.settings.smtp.pass : String(input.smtp.pass || '') };
  if (input.weather) db.settings.weather = { ...db.settings.weather, enabled: input.weather.enabled !== false, city: String(input.weather.city || db.settings.weather.city || '杭州').slice(0, 80) };
  if (input.webhookUrl !== undefined) db.settings.webhookUrl = String(input.webhookUrl).slice(0, 2048);
  await saveDb(db); restartScheduler(); res.json({ ok: true });
});
app.put('/api/admin/password', requireAdmin, async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 12) return res.status(400).json({ error: '密码至少 12 位' });
  const user = db.users.find(u => u.id === req.user.userId);
  user.passwordHash = await bcrypt.hash(password, 12); user.mustChangePassword = false; await saveDb(db); res.json({ ok: true });
});
app.put('/api/admin/account', requireAdmin, async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  if (!username || username.length > 64 || /[\u0000-\u001f\u007f]/.test(username)) return res.status(400).json({ error: '用户名不能为空且不能超过 64 个字符' });
  const user = db.users.find((item) => item.id === req.user.userId);
  if (!user) return res.status(404).json({ error: '管理员账号不存在' });
  const duplicate = db.users.some((item) => item.id !== user.id && item.username.toLocaleLowerCase() === username.toLocaleLowerCase());
  if (duplicate) return res.status(409).json({ error: '用户名已被占用' });
  user.username = username;
  req.user.username = username;
  await saveDb(db);
  res.json({ ok: true, username });
});
app.post('/api/admin/categories', requireAdmin, async (req, res) => { const category = { id: id(), name: String(req.body?.name || '').trim().slice(0, 80), sort: Number(req.body?.sort || db.categories.length) }; if (!category.name) return res.status(400).json({ error: '分类名称不能为空' }); db.categories.push(category); await saveDb(db); res.json(category); });
app.delete('/api/admin/categories/:id', requireAdmin, async (req, res) => { const i = db.categories.findIndex(x => x.id === req.params.id); if (i < 0) return res.status(404).json({ error: '分类不存在' }); db.monitors.forEach(m => { if (m.categoryId === req.params.id) m.categoryId = ''; }); db.categories.splice(i, 1); await saveDb(db); res.json({ ok: true }); });
app.put('/api/admin/categories/order', requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds.map((value) => String(value)) : [];
  if (ids.length !== db.categories.length || new Set(ids).size !== ids.length || ids.some((categoryId) => !db.categories.some((category) => category.id === categoryId))) return res.status(400).json({ error: '分类排序列表已变化，请刷新后重试' });
  const positions = new Map(ids.map((categoryId, index) => [categoryId, index]));
  db.categories.forEach((category) => { category.sort = positions.get(category.id); });
  await saveDb(db);
  res.json({ ok: true, categoryIds: ids });
});
app.put('/api/admin/categories/:id', requireAdmin, async (req, res) => { const c = db.categories.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: '分类不存在' }); c.name = String(req.body?.name || c.name).trim().slice(0, 80); c.sort = Number(req.body?.sort ?? c.sort); await saveDb(db); res.json(c); });
app.put('/api/admin/monitors/order', requireAdmin, async (req, res) => {
  const categoryId = String(req.body?.categoryId || '');
  if (categoryId && !db.categories.some((category) => category.id === categoryId)) return res.status(400).json({ error: '分类不存在' });
  const ids = Array.isArray(req.body?.monitorIds) ? req.body.monitorIds.map((value) => String(value)) : [];
  const validCategory = (monitor) => categoryId ? monitor.categoryId === categoryId : !db.categories.some((category) => category.id === monitor.categoryId);
  const monitors = db.monitors.filter(validCategory);
  if (ids.length !== monitors.length || new Set(ids).size !== ids.length || ids.some((monitorId) => !monitors.some((monitor) => monitor.id === monitorId))) return res.status(400).json({ error: '排序列表与当前分类不一致，请刷新后重试' });
  const positions = new Map(ids.map((monitorId, index) => [monitorId, index]));
  monitors.forEach((monitor) => { monitor.sort = positions.get(monitor.id); });
  await saveDb(db);
  res.json({ ok: true, categoryId, monitorIds: ids });
});
app.post('/api/admin/monitors', requireAdmin, async (req, res) => { try { const m = cleanMonitor(req.body || {}); db.monitors.push(m); await saveDb(db); runMonitor(m.id); res.json(m); } catch (e) { res.status(400).json({ error: e.message }); } });
app.put('/api/admin/monitors/:id', requireAdmin, async (req, res) => { try { const i = db.monitors.findIndex(x => x.id === req.params.id); if (i < 0) return res.status(404).json({ error: '监控不存在' }); db.monitors[i] = cleanMonitor(req.body || {}, db.monitors[i]); await saveDb(db); if (db.monitors[i].enabled) runMonitor(db.monitors[i].id); res.json(db.monitors[i]); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/admin/monitors/:id', requireAdmin, async (req, res) => { const i = db.monitors.findIndex(x => x.id === req.params.id); if (i < 0) return res.status(404).json({ error: '监控不存在' }); db.monitors.splice(i, 1); delete db.results[req.params.id]; await saveDb(db); res.json({ ok: true }); });
app.post('/api/admin/domains', requireAdmin, async (req, res) => { try { const d = cleanDomain(req.body || {}); db.domains.push(d); await saveDb(db); res.json(d); } catch (e) { res.status(400).json({ error: e.message }); } });
app.put('/api/admin/domains/:id', requireAdmin, async (req, res) => { try { const i = db.domains.findIndex(x => x.id === req.params.id); if (i < 0) return res.status(404).json({ error: '域名不存在' }); db.domains[i] = cleanDomain(req.body || {}, db.domains[i]); await saveDb(db); res.json(db.domains[i]); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/admin/domains/:id', requireAdmin, async (req, res) => { const i = db.domains.findIndex(x => x.id === req.params.id); if (i < 0) return res.status(404).json({ error: '域名不存在' }); db.domains.splice(i, 1); await saveDb(db); res.json({ ok: true }); });
app.post('/api/admin/check-now', requireAdmin, async (_req, res) => { await checkAll(); res.json({ ok: true, data: publicData() }); });
app.get('/api/admin/ssl', requireAdmin, async (req, res) => res.json(await inspectSsl(String(req.query.url || ''))));

async function sendNotification(subject, text) {
  const s = db.settings;
  const targets = [];
  if (s.smtp?.host && s.smtp?.to) {
    try {
      const transport = nodemailer.createTransport({ host: s.smtp.host, port: Number(s.smtp.port || 587), secure: Boolean(s.smtp.secure), auth: s.smtp.user ? { user: s.smtp.user, pass: s.smtp.pass } : undefined });
      await transport.sendMail({ from: s.smtp.from || s.smtp.user, to: s.smtp.to, subject, text }); targets.push('email');
    } catch (error) { db.notifications.push({ id: id(), channel: 'email', ok: false, error: error.message, createdAt: now() }); }
  }
  if (s.webhookUrl) {
    try { const r = await fetch(s.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject, text, source: 'status-girl', createdAt: now() }) }); targets.push(`webhook:${r.status}`); } catch (error) { db.notifications.push({ id: id(), channel: 'webhook', ok: false, error: error.message, createdAt: now() }); }
  }
  db.notifications.push({ id: id(), channel: targets.join(',') || 'none', ok: targets.length > 0, subject, createdAt: now() });
  await saveDb(db);
}
function pruneHistory(history) {
  const cutoff = Date.now() - Math.min(30, Math.max(1, Number(db.settings.historyDays) || 7)) * 86400000;
  return (Array.isArray(history) ? history : []).filter((point) => {
    const timestamp = Date.parse(point?.checkedAt || '');
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
}
function pruneAllHistories() {
  Object.values(db.results).forEach((result) => { if (result?.history) result.history = pruneHistory(result.history); });
}
function shouldNotify(key) { const previous = db.notifications.find(n => n.key === key && n.ok); return !previous || Date.now() - Date.parse(previous.createdAt) > 24 * 3600 * 1000; }
async function runMonitor(monitorId) {
  const monitor = db.monitors.find(m => m.id === monitorId);
  if (!monitor || !monitor.enabled) return;
  const result = await checkMonitor(monitor);
  const old = db.results[monitor.id];
  const history = pruneHistory(old?.history);
  const point = { ok: result.ok, checkedAt: now(), latency: result.latency, statusCode: result.statusCode || 0 };
  const next = { ...result, status: result.ok ? 'up' : 'down', checkedAt: point.checkedAt, history: pruneHistory([...history, point]) };
  db.results[monitor.id] = next;
  if ((!old && next.status === 'down') || (old && old.status !== next.status)) {
    if (next.status === 'down') {
      db.incidents.push({ id: id(), monitorId: monitor.id, monitorName: monitor.name, status: 'down', error: next.error || '', createdAt: point.checkedAt, startedAt: point.checkedAt, resolvedAt: null, durationMs: null });
    } else {
      const openIncident = [...db.incidents].reverse().find((incident) => incident.monitorId === monitor.id && incident.status === 'down' && !incident.resolvedAt);
      const trailingDown = [];
      for (const previous of [...(old?.history || [])].reverse()) { if (previous.ok) break; trailingDown.push(previous); }
      const startedAt = openIncident?.startedAt || openIncident?.createdAt || trailingDown.at(-1)?.checkedAt || null;
      const durationMs = startedAt ? Math.max(0, Date.parse(point.checkedAt) - Date.parse(startedAt)) : null;
      if (openIncident) { openIncident.resolvedAt = point.checkedAt; openIncident.durationMs = durationMs; }
      db.incidents.push({ id: id(), monitorId: monitor.id, monitorName: monitor.name, status: 'up', error: '', createdAt: point.checkedAt, startedAt, resolvedAt: point.checkedAt, durationMs });
    }
    await sendNotification(`[Status姬] ${monitor.name} 状态变更为 ${next.status === 'up' ? '正常' : '异常'}`, `${monitor.name}\n地址：${monitor.url}\n状态：${next.status}\n${next.error || ''}`);
  }
  if (result.ssl?.daysRemaining !== null && result.ssl?.daysRemaining <= Number(monitor.sslWarningDays || db.settings.sslWarningDays || 30)) {
    const key = `ssl:${monitor.id}:${result.ssl.expiresAt}`;
    if (shouldNotify(key)) { db.notifications.push({ id: id(), key, ok: true, channel: 'pending', subject: 'SSL 到期提醒', createdAt: now() }); await sendNotification(`[Status姬] SSL 证书即将到期：${monitor.name}`, `${monitor.url}\n剩余 ${result.ssl.daysRemaining} 天`); }
  }
  await saveDb(db);
}
async function checkAll() { for (const monitor of db.monitors.filter(m => m.enabled)) await runMonitor(monitor.id); await checkDomains(); }
async function checkDomains() { for (const d of db.domains.filter(x => x.enabled && x.expiryDate)) { const days = Math.ceil((new Date(`${d.expiryDate}T23:59:59`) - Date.now()) / 86400000); if (days <= Number(db.settings.domainWarningDays || 30)) { const key = `domain:${d.id}:${d.expiryDate}`; if (shouldNotify(key)) { db.notifications.push({ id: id(), key, ok: true, channel: 'pending', subject: '域名到期提醒', createdAt: now() }); await sendNotification(`[Status姬] 域名即将到期：${d.domain}`, `到期日期：${d.expiryDate}\n剩余 ${days} 天`); } } } }
let scheduler;
let schedulerNextAt = 0;
let schedulerRunning = true;
function schedulerIntervalMs() { return Math.max(60, Number(db.settings.refreshSeconds) || 300) * 1000; }
function scheduleNextCheck(delay = schedulerIntervalMs()) {
  clearTimeout(scheduler);
  schedulerNextAt = Date.now() + delay;
  scheduler = setTimeout(async () => {
    schedulerNextAt = 0;
    schedulerRunning = true;
    try { await checkAll(); }
    catch (error) { console.error('scheduled check failed', error); }
    finally { schedulerRunning = false; scheduleNextCheck(); }
  }, delay);
}
function restartScheduler() {
  clearTimeout(scheduler);
  if (!schedulerRunning) scheduleNextCheck();
}
checkAll().catch(error => console.error('initial check failed', error)).finally(() => { schedulerRunning = false; scheduleNextCheck(); });

app.get('*', (req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.resolve('public/index.html')); });
app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: '服务器内部错误' }); });
app.listen(port, '0.0.0.0', () => console.log(`Status姬 listening on http://0.0.0.0:${port}`));
