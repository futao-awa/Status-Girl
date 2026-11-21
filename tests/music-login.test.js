import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { test } from 'node:test';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import QRCode from 'qrcode';
import { cookieValue, mergeCookies, normalizeQr, qrStatus, musicAuthError } from '../src/music-auth.js';
import { qishuiSignedRequest, acceptQishuiSignature } from '../src/qishui-signing.js';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const frontendSource = readFileSync(new URL('../public/assets/admin.js', import.meta.url), 'utf8');
const json = (res, data, cookies = [], status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json', 'set-cookie': cookies });
  res.end(JSON.stringify(data));
};
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('生产安全响应头允许隔离签名组件加载，后台脚本仍使用原有资源策略', async t => {
  const app = express();
  const context = vm.createContext({ app, express, helmet, cookieParser, path });
  vm.runInContext(source.slice(source.indexOf("app.disable('x-powered-by')"), source.indexOf('const loginLimiter')), context);
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const frame = await fetch(base + '/assets/qishui-security-frame.js');
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('cross-origin-resource-policy'), 'cross-origin');
  const admin = await fetch(base + '/assets/admin.js');
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('cross-origin-resource-policy'), 'same-origin');
});

// 实际 Express 路由 + 请求/加密函数，通过本地 HTTP 上游检查请求和 Set-Cookie。
// 数据持久化在独立临时目录，既有账号和配置不参与测试。
async function fixture(t, provider, upstream, adapter = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'status-girl-login-test-'));
  const file = path.join(dir, 'db.json');
  const calls = [];
  let upstreamFailure;
  const mock = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const call = { url: new URL(req.url, 'https://api.qishui.com'), method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
      calls.push(call);
      await upstream(call, res, calls.length);
    } catch (error) { upstreamFailure = error; json(res, { error_code: 9999 }, [], 500); }
  });
  const mockUrl = await listen(mock);
  const app = express();
  app.use(express.json());
  const db = { settings: { music: { provider, cookie: '', sessionId: '', account: null } } };
  let clock = Date.now();
  const context = vm.createContext({
    app, db, Date: class extends Date { static now() { return clock; } }, crypto: { ...crypto, randomInt: (min, max) => max === undefined ? 0 : crypto.randomInt(min, max) }, Buffer, URL, URLSearchParams, AbortSignal, AbortController, setTimeout, clearTimeout,
    process: { env: {} }, musicAuthError, mergeCookies, cookieValue, normalizeQr, qrStatus,
    requireAdmin(req, _res, next) { req.user = { userId: req.headers['x-test-user'] || 'test-admin' }; next(); },
    id: () => crypto.randomUUID(), saveDb: data => writeFile(file, JSON.stringify(data)),
    musicQrData: url => QRCode.toDataURL(url),
    qishuiSignedRequest, acceptQishuiSignature,
    fetch(url, options) {
      const target = new URL(String(url));
      return fetch(`${mockUrl}${target.pathname}${target.search}`, options);
    }
  });
  vm.runInContext(source.slice(source.indexOf('const musicQrFlows'), source.indexOf('function pickArray')), context);
  if (adapter) vm.runInContext("musicBaseUrl = () => 'https://adapter.test'", context);
  vm.runInContext(source.slice(source.indexOf('function removeMusicQrFlow('), source.indexOf("app.get('/api/music/playlists'")), context);
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(async () => {
    vm.runInContext('clearMusicQrFlows()', context);
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => mock.close(resolve))]);
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(dir);
    if (upstreamFailure) throw upstreamFailure;
  });
  async function request(url, options) {
    let res = await fetch(base + url, options);
    let data = await res.json();
    if (data.signing) {
      // 签名算法在浏览器验证；本地上游验证此处传送与服务端固定请求的绑定。
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.ok(!('cookie' in data.signing.headers));
      const signed = new URL(data.signing.url);
      signed.searchParams.set('a_bogus', 'a'.repeat(44));
      res = await fetch(base + '/api/music/login/qr/signature', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: data.token, requestId: data.signing.requestId, signedUrl: signed.href, userAgent: 'Status-Girl Browser Test' }) });
      data = await res.json();
    }
    return { http: res.status, data };
  }
  return {
    db, calls, context, base,
    async create() { const result = await request('/api/music/login/qr'); assert.equal(result.http, 200, JSON.stringify(result.data)); return result.data; },
    async poll(qr, advance = true) { if (advance) clock += 6000; return request('/api/music/login/qr/status?token=' + qr.token); },
    async persisted() { return JSON.parse(await readFile(file, 'utf8')); },
    loggedIn() { return vm.runInContext('musicLoggedIn()', context); }
  };
}

function decryptWeapi(form) {
  const decrypt = (data, key) => {
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from('0102030405060708'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString();
  };
  const params = new URLSearchParams(form);
  assert.equal(params.get('encSecKey').length, 256);
  return JSON.parse(decrypt(decrypt(params.get('params'), 'aaaaaaaaaaaaaaaa'), '0CoJUm6Qyw8W8jud'));
}

test('网易云本地 HTTP 完整流程使用 type=3、同一设备与二维码 Cookie，确认后持久化并可重新读取', async t => {
  let poll = 0;
  const f = await fixture(t, 'netease', (call, res) => {
    assert.equal(call.method, 'POST');
    const body = decryptWeapi(call.body);
    assert.equal(body.type, 3);
    assert.match(call.headers.cookie, /os=pc/);
    if (call.url.pathname.endsWith('/unikey')) {
      return json(res, { code: 200, unikey: 'upstream-key' }, ['NMTID=device-cookie; Path=/; HttpOnly']);
    }
    assert.equal(body.key, 'upstream-key');
    assert.match(call.headers.cookie, /NMTID=device-cookie/);
    const codes = [801, 802, 801, 803];
    const code = codes[poll++];
    json(res, { code }, code === 803 ? ['MUSIC_U=authenticated==; Path=/; HttpOnly', '__csrf=csrf-value; Path=/'] : []);
  });
  const qr = await f.create();
  assert.match(qr.qrCode, /^data:image\/png;base64,/);
  assert.equal((await f.poll(qr)).data.status, 'pending');
  assert.equal((await f.poll(qr)).data.status, 'scanned');
  assert.equal((await f.poll(qr)).data.status, 'scanned');
  const final = await f.poll(qr);
  assert.equal(final.data.loggedIn, true);
  assert.equal(JSON.stringify(final).includes('authenticated'), false);
  assert.equal(f.loggedIn(), true);
  const saved = await f.persisted();
  assert.equal(cookieValue(saved.settings.music.cookie, 'MUSIC_U'), 'authenticated==');
  f.db.settings.music = saved.settings.music;
  assert.equal(f.loggedIn(), true);
  assert.equal((await f.poll(qr)).data.loggedIn, true);
  assert.equal(poll, 4);
});

test('汽水签名绑定管理员与原始请求，不泄露 Cookie，不接受改地址或重放', async t => {
  const f = await fixture(t, 'qishui', (_call, res) => json(res, { data: { token: 'official', qrcode_index_url: 'https://qishui.com/official' } }, ['passport_csrf_token=private-csrf; Path=/']));
  const challenge = await (await fetch(f.base + '/api/music/login/qr')).json();
  assert.ok(challenge.signing);
  assert.equal(f.calls.length, 0);
  const signed = new URL(challenge.signing.url);
  signed.searchParams.set('a_bogus', 'a'.repeat(44));
  const payload = { token: challenge.token, requestId: challenge.signing.requestId, signedUrl: signed.href, userAgent: 'Browser Test' };
  const submit = input => fetch(f.base + '/api/music/login/qr/signature', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  for (const changed of [signed.href.replace('api.qishui.com', 'example.invalid'), signed.href.replace('get_qrcode', 'anything'), signed.href.replace('aid=386088', 'aid=1')]) assert.equal((await submit({ ...payload, signedUrl: changed })).status, 400);
  assert.equal((await submit({ ...payload, requestId: 'unknown' })).status, 400);
  assert.equal((await submit({ ...payload, userAgent: 'bad\r\nCookie: leak' })).status, 400);
  const otherUser = await fetch(f.base + '/api/music/login/qr/signature', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'other-admin' }, body: JSON.stringify(payload) });
  assert.equal(otherUser.status, 404);
  assert.equal(f.calls.length, 0);
  assert.equal((await submit(payload)).status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal((await submit(payload)).status, 400);
  const statusChallenge = await (await fetch(f.base + '/api/music/login/qr/status?token=' + challenge.token)).json();
  assert.ok(statusChallenge.signing);
  assert.ok(!('cookie' in statusChallenge.signing.headers));
  assert.equal(JSON.stringify(statusChallenge).includes('Cookie'), false);
  assert.equal(f.calls.length, 1);
});

test('网易云 MUSIC_A 匿名凭据不能登录，已确认的授权进度不会被 pending 覆盖', async t => {
  let poll = 0;
  const f = await fixture(t, 'netease', (call, res) => {
    if (call.url.pathname.endsWith('/unikey')) return json(res, { code: 200, unikey: 'key' });
    json(res, { code: ++poll === 1 ? 803 : 801 }, ['MUSIC_A=anonymous; Path=/']);
  });
  const qr = await f.create();
  assert.equal((await f.poll(qr)).data.status, 'authorizing');
  assert.equal((await f.poll(qr)).data.status, 'authorizing');
  assert.equal(f.loggedIn(), false);
});

test('汽水 HTTP Passport 流程携带完整表单及 CSRF Cookie；扫码 2、确认 3 后保存会话', async t => {
  let poll = 0;
  let identity;
  const image = await QRCode.toDataURL('https://bff-pc.qishui.com/ucenter_web/app/sdk-next?token=official-token');
  const f = await fixture(t, 'qishui', (call, res) => {
    const query = call.url.searchParams;
    assert.equal(query.get('passport_jssdk_type'), 'normal');
    assert.equal(query.get('passport_jssdk_version'), '2.4.13');
    assert.equal(query.get('account_sdk_source'), 'web');
    assert.equal(query.get('version_code'), '3.5.2');
    assert.equal(query.get('device_platform'), 'PC');
    assert.equal(query.get('a_bogus'), 'a'.repeat(44));
    assert.equal(call.headers['user-agent'], 'Status-Girl Browser Test');
    assert.equal(query.get('did'), query.get('device_id'));
    assert.equal(query.get('install_id'), query.get('iid'));
    assert.equal(call.headers['x-tt-passport-trace-id'], query.get('biz_trace_id'));
    assert.match(call.headers['x-tt-passport-verify-portrait'], /\.login$/);
    assert.ok(query.get('msToken'));
    assert.notEqual(query.get('device_id'), query.get('iid'));
    const current = [query.get('device_id'), query.get('iid')];
    if (call.url.pathname.endsWith('/get_qrcode/')) {
      identity = current;
      assert.equal(query.get('is_new_login'), '1');
      return json(res, { message: 'success', data: { token: 'token', qrcode: image, copywriting: '请使用抖音 APP 扫码', expire_time: Math.floor(Date.now() / 1000) + 180 } }, ['passport_csrf_token=csrf; Path=/']);
    }
    assert.deepEqual(current, identity);
    assert.equal(call.method, 'POST');
    assert.match(call.headers['content-type'], /application\/x-www-form-urlencoded/);
    assert.equal(call.headers['x-ss-stub'], crypto.createHash('md5').update(call.body).digest('hex').toUpperCase());
    assert.match(call.headers.cookie, /passport_csrf_token=csrf/);
    assert.equal(call.headers['x-tt-passport-csrf-token'], 'csrf');
    const body = new URLSearchParams(call.body);
    for (const [name, value] of Object.entries({ token: 'token', is_frontier: 'true', need_logo: 'false', need_short_url: 'false', is_new_login: '1', next: 'https://api.qishui.com' })) assert.equal(body.get(name), value);
    const status = [1, 2, 1, 3][poll++];
    json(res, { message: 'success', data: { status } }, status === 3 ? ['sessionid=real-session; Path=/; HttpOnly', 'sid_guard=guard; Path=/'] : []);
  });
  const qr = await f.create();
  assert.equal(qr.qrCode, image);
  assert.equal(qr.scanApp, 'douyin');
  assert.equal((await f.poll(qr)).data.status, 'pending');
  assert.equal((await f.poll(qr)).data.status, 'scanned');
  assert.equal((await f.poll(qr)).data.status, 'scanned');
  assert.equal((await f.poll(qr)).data.loggedIn, true);
  const saved = await f.persisted();
  assert.equal(saved.settings.music.sessionId, 'real-session');
  assert.equal(cookieValue(saved.settings.music.cookie, 'sid_guard'), 'guard');
  assert.equal(f.loggedIn(), true);
});

test('汽水确认后的多次跳转保留每一跳 Cookie；回调失败可重试而不用再次消费二维码', async t => {
  let checks = 0;
  let callbacks = 0;
  const f = await fixture(t, 'qishui', (call, res) => {
    if (call.url.pathname.endsWith('/get_qrcode/')) return json(res, { data: { token: 'key', qrcode_index_url: 'https://qishui.com/official' } });
    if (call.url.pathname.endsWith('/check_qrconnect/')) {
      checks++;
      res.writeHead(302, { location: '/finish/start', 'set-cookie': ['sid_guard=guard; Path=/'] });
      return res.end();
    }
    assert.match(call.headers.cookie, /sid_guard=guard/);
    if (call.url.pathname.endsWith('/start')) {
      if (++callbacks === 1) return json(res, {}, [], 503);
      res.writeHead(302, { location: './complete', 'set-cookie': ['sid_tt=callback-marker; Path=/'] });
      return res.end();
    }
    assert.equal(call.url.pathname, '/finish/complete');
    assert.match(call.headers.cookie, /sid_tt=callback-marker/);
    json(res, {}, ['sessionid=callback-session; Path=/']);
  });
  const qr = await f.create();
  const retry = await f.poll(qr);
  assert.equal(retry.http, 502);
  assert.equal(retry.data.retryable, true);
  assert.equal(f.loggedIn(), false);
  assert.equal((await f.poll(qr)).data.loggedIn, true);
  assert.equal(checks, 1);
  assert.equal((await f.persisted()).settings.music.sessionId, 'callback-session');
});

test('汽水先下发会话再跳转至 404 落地页时保留授权，不再次消费二维码', async t => {
  let checks = 0;
  const f = await fixture(t, 'qishui', (call, res) => {
    if (call.url.pathname.endsWith('/get_qrcode/')) return json(res, { data: { token: 'token', qrcode_index_url: 'https://qishui.com/official' } });
    if (call.url.pathname.endsWith('/check_qrconnect/')) {
      checks++;
      res.writeHead(302, { location: 'https://api.qishui.com/', 'set-cookie': ['sessionid_ss=confirmed-session; Path=/; HttpOnly'] });
      return res.end();
    }
    if (call.url.pathname === '/luna/pc/me') {
      assert.match(call.headers.cookie, /sessionid_ss=confirmed-session/);
      return json(res, { my_info: { id: 'verified-account' } });
    }
    json(res, {}, [], 404);
  });
  const qr = await f.create();
  assert.equal((await f.poll(qr)).data.loggedIn, true);
  assert.equal((await f.persisted()).settings.music.sessionId, 'confirmed-session');
  assert.equal((await f.poll(qr)).data.loggedIn, true);
  assert.equal(checks, 1);
  const account = await vm.runInContext("musicRequest('/me')", f.context);
  assert.equal(account.my_info.id, 'verified-account');
  assert.equal(f.calls.some(call => call.url.pathname === '/'), false);
});

test('guowenye 适配服务的双层 data 与 auth.sessionid 可以完整落盘并用于后续请求', async t => {
  const f = await fixture(t, 'qishui', (call, res) => {
    if (call.url.pathname === '/auth/qrcode') return json(res, { code: 0, data: { data: { token: 'token', qrcode_index_url: 'https://qishui.com/official' }, token: 'token' } });
    if (call.url.pathname === '/auth/qrcode/status') {
      assert.equal(JSON.parse(call.body).token, 'token');
      return json(res, { code: 0, data: { data: { status: 'confirmed' }, status: 'confirmed', auth: { sessionid: 'adapter-session' } } });
    }
    assert.match(call.headers.cookie, /sessionid=adapter-session/);
    json(res, { code: 0, data: {} });
  }, true);
  const qr = await f.create();
  assert.equal((await f.poll(qr)).data.loggedIn, true);
  assert.equal(cookieValue((await f.persisted()).settings.music.cookie, 'sessionid'), 'adapter-session');
  await vm.runInContext("musicRequest('/auth/me', {method:'POST',body:{}})", f.context);
});

test('平台限流及额外验证有明确状态；未知返回和非 JSON 不会变成等待扫码', async t => {
  assert.equal(qrStatus('qishui', { message: 'error', data: { error_code: 7 } }).retryAfterMs, 5000);
  assert.equal(qrStatus('qishui', { message: 'error', data: { error_code: 7, session_cookie: 'sessionid=completed' } }).status, 'confirmed');
  assert.equal(qrStatus('qishui', { message: 'error', data: { error_code: 2046 } }).status, 'verification_required');
  assert.throws(() => qrStatus('netease', { code: 405 }), /405/);
  assert.throws(() => qrStatus('qishui', { data: { status: 'unexpected' } }), /请求失败/);
  const f = await fixture(t, 'qishui', (call, res) => {
    if (call.url.pathname.endsWith('/get_qrcode/')) return json(res, { data: { token: 'key', qrcode_index_url: 'https://qishui.com/official' } });
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html>denied secret-token</html>');
  });
  const result = await f.poll(await f.create());
  assert.equal(result.http, 502);
  assert.match(result.data.error, /HTTP 403/);
  assert.equal(result.data.retryable, false);
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

test('汽水服务端执行限流冷却，重复前端请求不重复访问平台', async t => {
  let checks = 0;
  const f = await fixture(t, 'qishui', (call, res) => {
    if (call.url.pathname.endsWith('/get_qrcode/')) return json(res, { data: { token: 'key', qrcode_index_url: 'https://qishui.com/official' } });
    checks++;
    json(res, { message: 'error', data: { error_code: 7 } });
  });
  const qr = await f.create();
  assert.equal((await f.poll(qr)).data.status, 'retrying');
  assert.equal((await f.poll(qr, false)).data.status, 'retrying');
  assert.equal((await f.poll(qr, false)).data.retryAfterMs, 5000);
  assert.equal(checks, 1);
  await f.poll(qr);
  assert.equal(checks, 2);
});

test('前端保留扫码进度和授权提示，额外身份验证停止重试，未落盘的 confirmed 不显示成功', async () => {
  const elements = Object.fromEntries(['musicQrButton', 'musicQrBox', 'musicQrImage', 'musicQrHint', 'musicProvider'].map(id => ['#' + id, { hidden: true, value: id === 'musicProvider' ? 'qishui' : '' }]));
  const timers = [];
  const statuses = [{ status: 'scanned' }, { status: 'pending' }, { status: 'confirmed' }, { status: 'pending' }, { status: 'verification_required', message: '需要身份验证' }];
  let successes = 0;
  const context = vm.createContext({ Date, musicQrGeneration: 0, musicQrTimer: 0,
    state: { settings: { music: {} } }, $: selector => elements[selector],
    window: { clearTimeout() {}, setTimeout(fn) { timers.push(fn); return timers.length; } },
    api: async url => url.endsWith('/qr') ? { token: 'test', qrCode: 'data:image/png;base64,test', scanApp: 'douyin', expiresAt: new Date(Date.now() + 180000).toISOString() } : statuses.shift(),
    renderMusicAdmin() {}, toast() { successes++; }, reload() {}, loadMusicPlaylists() {}
  });
  vm.runInContext(frontendSource.slice(frontendSource.indexOf('function stopMusicQr('), frontendSource.indexOf('async function loadMusicPlaylists(')), context);
  await vm.runInContext('startMusicQr()', context);
  assert.match(elements['#musicQrHint'].textContent, /抖音 APP/);
  await timers.shift()();
  await timers.shift()();
  assert.match(elements['#musicQrHint'].textContent, /已扫码/);
  await timers.shift()();
  await timers.shift()();
  assert.match(elements['#musicQrHint'].textContent, /授权/);
  await timers.shift()();
  assert.equal(timers.length, 0);
  assert.equal(successes, 0);
  assert.equal(elements['#musicQrHint'].textContent, '需要身份验证');
});
