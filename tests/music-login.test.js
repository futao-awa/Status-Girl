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
import * as verificationHelpers from '../src/qishui-verification.js';
import * as musicContent from '../src/music-content.js';

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
  for (const name of ['qishui-react', 'qishui-react-dom']) {
    const dependency = await fetch(base + `/assets/${name}.js`);
    assert.equal(dependency.status, 200);
    assert.equal(dependency.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(dependency.headers.get('access-control-allow-origin'), '*');
  }
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
    process: { env: {} }, musicAuthError, mergeCookies, cookieValue, normalizeQr, qrStatus, musicContent,
    requireAdmin(req, _res, next) { req.user = { userId: req.headers['x-test-user'] || 'test-admin' }; next(); },
    id: () => crypto.randomUUID(), saveDb: data => writeFile(file, JSON.stringify(data)),
    musicQrData: url => QRCode.toDataURL(url),
    qishuiSignedRequest, acceptQishuiSignature, ...verificationHelpers,
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
    db, calls, context, base, request, advance: ms => { clock += ms; },
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

const verifyScript = 'https://lf3-cdn-tos.bytescm.com/obj/static/ies/passport/verify.js';
test('汽水 2046 展开官方决策，共用 Cookie 验证后带原始 biz_params 重发确认并自动保存', async t => {
  let checks = 0;
  const f = await fixture(t, 'qishui', (call, res) => {
    if (call.url.pathname.endsWith('/get_qrcode/')) return json(res, { data: { token: 'original-qr', qrcode_index_url: 'https://qishui.com/official' } }, ['passport_csrf_token=original-csrf; Path=/']);
    if (call.url.pathname.endsWith('/pack_verify_ways_data/')) {
      const form = new URLSearchParams(call.body);
      assert.equal(form.get('aid'), '386088');
      assert.equal(form.get('is_login'), null);
      assert.equal(form.get('verify_from'), 'verify_center');
      assert.equal(call.headers['x-tt-passport-verify-portrait'], 'official-portrait');
      assert.equal(call.headers['x-tt-passport-csrf-token'], 'original-csrf');
      return json(res, { data: { url: { host: 'lf3-cdn-tos.bytescm.com', path: '/obj/static/ies/passport/verify.js' }, verify_ways: [{ way: 'mobile' }], biz_params: { verify_ticket: 'wrong-expanded-ticket' } } });
    }
    if (call.url.pathname.endsWith('/validate_code/')) {
      assert.match(call.headers.cookie, /passport_csrf_token=original-csrf/);
      assert.equal(call.headers['user-agent'], 'Status-Girl Browser Test');
      assert.equal(call.body, 'code=123456');
      return json(res, { data: { status: true, ticket: 'component-ticket', session_cookie: 'hidden-credential' } }, ['verified_device=verified; Path=/']);
    }
    if (call.url.pathname === '/captcha/get') {
      assert.equal(call.headers.cookie, undefined);
      assert.equal(call.headers['x-tt-passport-csrf-token'], undefined);
      return json(res, { data: { challenge: 'captcha-challenge' } }, ['sessionid=ignore-captcha-cookie; Path=/']);
    }
    checks++;
    if (checks === 1) return json(res, { message: 'error', data: { error_code: 2046, is_login: true, verify_from: 'verify_center', verify_portrait_id: 'official-portrait', event_params: '{"verify_scene":"login"}', biz_params: '{"verify_ticket":"original-ticket","context":{"scene":"qr"},"token":"cannot-replace-qr","next":"https://evil.test"}' } });
    assert.equal(call.url.searchParams.get('isResend'), 'true');
    const form = new URLSearchParams(call.body);
    assert.equal(form.get('token'), 'original-qr');
    assert.equal(form.get('verify_ticket'), 'original-ticket');
    assert.deepEqual(JSON.parse(form.get('context')), { scene: 'qr' });
    assert.equal(form.get('next'), 'https://api.qishui.com');
    assert.match(call.headers.cookie, /verified_device=verified/);
    json(res, { data: { status: 'confirmed' } }, ['sessionid=actual-new-session; Path=/; HttpOnly']);
  });
  const qr = await f.create();
  const required = (await f.poll(qr)).data;
  assert.equal(required.status, 'verification_required');
  assert.equal(required.verification.available, true);
  assert.ok(Date.parse(required.verification.expiresAt) > Date.parse(qr.expiresAt));
  assert.equal(JSON.stringify(required).includes('original-ticket'), false);
  const input = { token: qr.token, verificationId: required.verification.id };
  const post = (suffix, extra = {}) => f.request('/api/music/login/qr/verification/' + suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, ...extra }) });
  assert.equal((await post('complete')).http, 409);
  f.advance(181000);
  assert.equal((await f.poll(qr, false)).data.status, 'verification_required');
  assert.equal(checks, 1);
  const start = await post('start');
  assert.equal(start.http, 200);
  assert.equal(start.data.scriptUrl, verifyScript);
  assert.equal((await f.poll(qr, false)).data.status, 'verification_required');
  const captcha = await post('request', { request: { url: 'https://verify.snssdk.com/captcha/get', method: 'GET' } });
  assert.equal(captcha.http, 200);
  assert.equal(JSON.parse(captcha.data.body).data.challenge, 'captcha-challenge');
  assert.equal(f.loggedIn(), false);
  const relay = await post('request', { request: { url: 'https://api.qishui.com/passport/safe/validate_code/?aid=386088', method: 'POST', body: 'code=123456', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'must-not-forward' } } });
  assert.equal(relay.http, 200);
  assert.equal(JSON.parse(relay.data.body).data.ticket, 'component-ticket');
  assert.equal(JSON.stringify(relay).includes('hidden-credential'), false);
  assert.equal(JSON.stringify(relay).includes('verified_device'), false);
  const complete = await post('complete');
  assert.equal(complete.data.loggedIn, true);
  assert.equal(f.loggedIn(), true);
  assert.equal(cookieValue((await f.persisted()).settings.music.cookie, 'sessionid'), 'actual-new-session');
  assert.equal((await f.poll(qr, false)).data.loggedIn, true);
  assert.equal(checks, 2);
  assert.equal((await post('request', { request: {} })).http, 409);
});

test('验证请求绑定管理员和决策，拒绝代理绕过、失效回执；组件成功回调不能伪造平台登录', async t => {
  let checks = 0;
  const f = await fixture(t, 'qishui', (call, res) => {
    if (call.url.pathname.endsWith('/get_qrcode/')) return json(res, { data: { token: 'qr', qrcode_index_url: 'https://qishui.com/official' } });
    checks++;
    json(res, { error_code: 2046, data: { verify_from: 'verify', url: verifyScript, biz_params: {} } });
  });
  const qr = await f.create();
  const required = (await f.poll(qr)).data;
  const input = { token: qr.token, verificationId: required.verification.id };
  const post = (suffix, extra = {}, user = 'test-admin') => f.request('/api/music/login/qr/verification/' + suffix, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify({ ...input, ...extra }) });
  assert.equal((await post('start', {}, 'another-admin')).http, 404);
  assert.equal((await post('start', { verificationId: 'invalid' })).http, 409);
  assert.equal((await post('start')).data.scriptUrl, verifyScript);
  for (const url of ['https://evil.test/passport/safe/verify/', 'https://api.qishui.com@evil.test/passport/safe/verify/', 'https://api.qishui.com:8443/passport/safe/verify/', 'http://api.qishui.com/passport/safe/verify/', 'https://api.qishui.com/passport/web/login/', 'https://api.qishui.com/passport/safe/../web/login/', 'https://api.qishui.com/passport/safe/verify/?aid=123']) {
    assert.equal((await post('request', { request: { url, method: 'GET' } })).http, 400, url);
  }
  assert.equal(checks, 1);
  const again = (await post('complete', { success: true, sessionid: 'forged' })).data;
  assert.equal(again.status, 'verification_required');
  assert.notEqual(again.verification.id, input.verificationId);
  assert.equal(f.loggedIn(), false);
  assert.equal((await post('complete')).http, 409);
  f.advance(600001);
  assert.equal((await post('request')).data.status, 'expired');
  assert.equal(checks, 2);
});

test('二次验证的待签名操作不会被普通状态轮询替换', async t => {
  const f = await fixture(t, 'qishui', (call, res) => {
    if (call.url.pathname.endsWith('/get_qrcode/')) return json(res, { data: { token: 'qr', qrcode_index_url: 'https://qishui.com/official' } });
    if (call.url.pathname.endsWith('/pack_verify_ways_data/')) return json(res, { data: { url: verifyScript } });
    json(res, { data: { error_code: 2046, verify_from: 'verify_center' } });
  });
  const qr = await f.create();
  const status = (await f.poll(qr)).data;
  const response = await fetch(f.base + '/api/music/login/qr/verification/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: qr.token, verificationId: status.verification.id }) });
  const challenge = await response.json();
  assert.ok(challenge.signing);
  await f.poll(qr, false);
  const signed = new URL(challenge.signing.url);
  signed.searchParams.set('a_bogus', 'a'.repeat(44));
  const result = await f.request('/api/music/login/qr/signature', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: qr.token, requestId: challenge.signing.requestId, signedUrl: signed.href, userAgent: 'Status-Girl Browser Test' }) });
  assert.equal(result.data.scriptUrl, verifyScript);
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

test('前端自动打开二次验证，取消后可继续；提交暂时失败仅重试授权，成功后自动连接', async () => {
  const elements = Object.fromEntries(['musicQrButton', 'musicQrBox', 'musicQrImage', 'musicQrHint', 'musicVerifyButton', 'musicProvider'].map(id => ['#' + id, { hidden: true, value: id === 'musicProvider' ? 'qishui' : '' }]));
  const required = { status: 'verification_required', message: '需要验证', verification: { id: 'decision', available: true, expiresAt: new Date(Date.now() + 600000).toISOString() } };
  const timers = [];
  let verifies = 0, submits = 0, successes = 0, connected = false;
  const state = { settings: { music: { loggedIn: false } } };
  const context = vm.createContext({ Date, Set, musicQrGeneration: 0, musicQrTimer: 0, state, $: selector => elements[selector],
    window: { clearTimeout() {}, setTimeout(fn) { timers.push(fn); return timers.length; }, qishuiSigning: { dispose() {}, async verify() { verifies++; return { success: verifies > 1, message: '取消验证' }; } } },
    api: async url => {
      if (url.endsWith('/verification/start')) return { token: 'test', verificationId: 'decision' };
      if (url.endsWith('/verification/complete')) { submits++; if (submits === 1) throw new Error('连接中断'); connected = true; return { status: 'confirmed', loggedIn: true }; }
      if (url.endsWith('/qr')) return { token: 'test', qrCode: 'data:image/png;base64,test', expiresAt: new Date(Date.now() + 180000).toISOString() };
      return connected ? { status: 'confirmed', loggedIn: true } : required;
    }, renderMusicAdmin() {}, toast() { successes++; }, reload: async () => {}, loadMusicPlaylists() {}
  });
  vm.runInContext(frontendSource.slice(frontendSource.indexOf('function stopMusicQr('), frontendSource.indexOf('async function loadMusicPlaylists(')), context);
  await vm.runInContext('startMusicQr()', context);
  await timers.shift()();
  assert.equal(verifies, 1);
  assert.equal(elements['#musicVerifyButton'].hidden, false);
  assert.equal(elements['#musicQrHint'].textContent, '取消验证');
  assert.equal(timers.length, 0);
  await elements['#musicVerifyButton'].onclick();
  assert.equal(verifies, 2);
  assert.equal(submits, 1);
  assert.equal(elements['#musicQrHint'].textContent, '连接中断');
  assert.equal(state.settings.music.loggedIn, false);
  await elements['#musicVerifyButton'].onclick();
  assert.equal(verifies, 2);
  assert.equal(submits, 2);
  await timers.shift()();
  assert.equal(state.settings.music.loggedIn, true);
  assert.equal(successes, 1);
  assert.equal(elements['#musicQrBox'].hidden, true);
});

test('身份验证组件地址与转发范围覆盖官方二次验证组件的真实接口', () => {
  const { verificationScript, verificationRequest } = verificationHelpers;
  const flow = { userAgent: 'UA', cookie: 'a=1', verifyPortraitId: 'portrait', verification: { decision: { verify_portrait_id: 'portrait' } } };
  const realScript = 'https://auth.zijieapi.com/ucenter_web/app/second_verification_web/dist/index.umd.production.js?error_code=2046&std_verify_token=abc';
  assert.equal(String(verificationScript(realScript)), realScript);
  assert.equal(String(verificationScript({ host: 'lf3-cdn-tos.bytescm.com', path: '/obj/static/ies/passport/verify.js' })), 'https://lf3-cdn-tos.bytescm.com/obj/static/ies/passport/verify.js');
  for (const bad of ['https://evil.example.com/x.js', 'https://auth.zijieapi.com/not-asset/tool.exe', 'javascript:alert(1)']) assert.throws(() => verificationScript(bad));
  for (const ok of ['/passport/web/send_code/', '/passport/web/send_voice_code/', '/passport/web/validate_code/', '/passport/web/mobile/check_code/', '/passport/web/account/verify/', '/passport/web/email/send_code/', '/passport/upsms/verify/', '/passport/mobile/can_mobile_auth_verify/', '/passport/safe/query_decision/']) {
    assert.doesNotThrow(() => verificationRequest({ url: 'https://api.qishui.com' + ok + '?aid=386088', method: 'POST', body: 'x=1' }, flow), ok);
  }
  for (const bad of ['/passport/web/logout/', '/passport/web/bind_phone/', '/account/modify/']) {
    assert.throws(() => verificationRequest({ url: 'https://api.qishui.com' + bad + '?aid=386088', method: 'POST', body: 'x=1' }, flow), /超出允许范围/);
  }
});
