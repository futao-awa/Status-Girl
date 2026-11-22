import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as musicContent from '../src/music-content.js';
import { mergeCookies, cookieValue, musicAuthError } from '../src/music-auth.js';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const track = (id, name = '歌曲') => ({ type: 'track', id: 'card-' + id, entity: { track_wrapper: { track: { id, name, artists: [{ name: '歌手甲' }, { name: '歌手乙' }], album: { name: '专辑', url_cover: { urls: ['https://example.com/img/'], uri: 'cover', template_prefix: 'tplv-luna' } } } } } });
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
async function listen(server) { server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); return `http://127.0.0.1:${server.address().port}`; }

async function fixture(t, upstream, provider = 'qishui', adapter = false) {
  const calls = [];
  let failed;
  const mock = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const call = { url: new URL(req.url, 'https://upstream.test'), method: req.method, headers: req.headers, body };
      calls.push(call);
      await upstream(call, res);
    } catch (error) { failed = error; json(res, {}, 500); }
  });
  const mockBase = await listen(mock);
  const app = express();
  app.use(express.json());
  const db = { settings: { music: { provider, sessionId: provider === 'qishui' ? 'private-session' : '', cookie: provider === 'qishui' ? 'sessionid=private-session' : 'MUSIC_U=private-session', deviceId: '1234567890123456', installId: '2345678901234567', queue: [], randomEnabled: true } } };
  let persisted = 0;
  const context = vm.createContext({ app, db, crypto, Buffer, URL, URLSearchParams, Date, AbortController, setTimeout, clearTimeout, Readable, pipeline, musicContent, mergeCookies, cookieValue, musicAuthError, process: { env: {} }, requireAdmin: (_req, _res, next) => next(), saveDb: async () => { persisted++; },
    fetch(url, options) {
      const target = new URL(url);
      return fetch(mockBase + target.pathname + target.search, { ...options, headers: { ...options.headers, 'x-test-upstream-host': target.hostname } });
    }
  });
  vm.runInContext(source.slice(source.indexOf('const musicQrFlows'), source.indexOf('async function musicQrData(')), context);
  if (adapter) vm.runInContext("musicBaseUrl = () => 'https://adapter.test'", context);
  vm.runInContext(source.slice(source.indexOf("app.get('/api/music/random'"), source.indexOf('function removeMusicQrFlow(')), context);
  vm.runInContext(source.slice(source.indexOf("app.get('/api/music/playlists'"), source.indexOf("app.post('/api/music/logout'")), context);
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => mock.close(resolve))]);
    if (failed) throw failed;
  });
  return { context, db, calls, persisted: () => persisted, raw: (url, options) => fetch(base + url, options), request: async (url, options) => { const res = await fetch(base + url, options); return { http: res.status, data: await res.json() }; } };
}

test('汽水官方歌单读取真实标题和数量，详情按游标读取并使用歌曲实体 ID', async t => {
  const f = await fixture(t, (call, res) => {
    assert.match(call.headers.cookie, /sessionid=private-session/);
    if (call.url.pathname.endsWith('/me/playlist')) return json(res, { playlists: [{ id: 'p1', title: '我的歌单', count_tracks: 3 }] });
    assert.equal(call.url.pathname, '/luna/pc/playlist/detail');
    assert.equal(call.method, 'GET');
    assert.equal(call.url.searchParams.get('playlist_id'), 'p1');
    assert.equal(call.url.searchParams.get('version_code'), '30060000');
    const next = call.url.searchParams.get('cursor');
    json(res, { media_resources: next ? [track('t2'), track('t3'), { type: 'video', id: 'v1' }] : [track('t1'), track('t2')], next_cursor: next ? '' : 'page-2' });
  });
  const list = await f.request('/api/music/playlists');
  assert.deepEqual(list.data.playlists[0], { id: 'p1', name: '我的歌单', cover: '', trackCount: 3 });
  const result = await f.request('/api/music/playlist/p1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '我的歌单' }) });
  assert.equal(result.http, 200);
  assert.deepEqual(result.data.tracks.map(item => item.id), ['t1', 't2', 't3']);
  assert.equal(result.data.tracks[0].artist, '歌手甲 / 歌手乙');
  assert.match(result.data.tracks[0].cover, /\/img\/cover~tplv-luna/);
});

test('汽水 PC 搜索空响应回退官方公开目录，目录请求和输出均不携带登录凭据', async t => {
  const f = await fixture(t, (call, res) => {
    if (call.url.pathname === '/luna/pc/search/track') {
      assert.equal(call.method, 'GET');
      assert.equal(call.url.searchParams.get('q'), '周杰伦');
      res.end(); return;
    }
    assert.equal(call.url.pathname, '/v2/search/type');
    assert.equal(call.headers['x-test-upstream-host'], 'api-vehicle.volcengine.com');
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers['x-session-id'], undefined);
    assert.equal(call.url.searchParams.has('device_id'), false);
    assert.equal(call.url.searchParams.get('search_source'), 'qishui');
    json(res, { errno: 0, data: { list: [{ item_id: 'real-song', title: '晴天', author_info: { name: '周杰伦' }, cover_url: 'https://example.com/cover.jpg' }] } });
  });
  const result = await f.request('/api/music/search?q=' + encodeURIComponent('周杰伦'));
  assert.equal(result.http, 200);
  assert.equal(result.data.tracks[0].id, 'real-song');
  assert.equal(result.data.tracks[0].artist, '周杰伦');
  assert.equal(JSON.stringify(result).includes('private-session'), false);
});

test('随机音乐调用官方推荐并保留真实错误；已有自选队列不被覆盖', async t => {
  let failing = true;
  const f = await fixture(t, (call, res) => {
    assert.equal(call.url.pathname, '/luna/pc/feed/song-tab');
    assert.equal(call.method, 'POST');
    const body = JSON.parse(call.body);
    assert.deepEqual(body.feed_counts, { mix_session_count: 1 });
    assert.equal(body.is_first_request, true);
    json(res, failing ? { error_code: 7, token: 'private-session' } : { items: [track('t1')] }, failing ? 503 : 200);
  });
  const failed = await f.request('/api/music/random');
  assert.equal(failed.http, 502);
  assert.match(failed.data.error, /错误（7）/);
  assert.equal(JSON.stringify(failed).includes('private-session'), false);
  assert.equal(f.persisted(), 0);
  failing = false;
  const success = await f.request('/api/music/random');
  assert.equal(success.http, 200);
  assert.equal(success.data.queue[0].id, 't1');
  f.db.settings.music.queue = [{ id: 'chosen', title: '自选歌曲' }];
  assert.equal((await f.request('/api/music/random')).data.queue[0].id, 'chosen');
  assert.equal(f.calls.length, 2);
});

test('随机请求期间退出或切换平台不写入旧队列', async t => {
  const f = await fixture(t, (_call, res) => {
    vm.runInContext('musicAuthGeneration += 1', f.context);
    json(res, { items: [track('old-account')] });
  });
  const result = await f.request('/api/music/random');
  assert.equal(result.http, 502);
  assert.equal(f.persisted(), 0);
  assert.deepEqual(f.db.settings.music.queue, []);
});

test('网页音源解析 video_model JSON，标识试听，拒绝加密流及无音源歌曲', async t => {
  let encrypted = false;
  const f = await fixture(t, (call, res) => {
    assert.equal(call.url.pathname, '/luna/h5/seo_track');
    assert.equal(call.headers['x-test-upstream-host'], 'beta-luna.douyin.com');
    assert.equal(call.method, 'GET');
    assert.equal(call.url.searchParams.get('track_id'), 't1');
    json(res, { seo_track: { track: { duration: 180000 } }, track_player: { video_model: JSON.stringify({ status: 10, media_type: 'audio', video_duration: 30, video_list: [{ main_url: 'https://audio.douyinvod.com/audio.mp3', video_meta: { vtype: 'mp3' }, ...(encrypted ? { spade_a: 'private-audio-key' } : {}) }] }) } });
  });
  const result = await f.request('/api/music/track/t1/url');
  assert.deepEqual(result.data, { url: '/api/music/track/t1/audio', duration: 30, preview: true });
  encrypted = true;
  vm.runInContext('musicAudioSources.clear()', f.context);
  const unavailable = await f.request('/api/music/track/t1/url');
  assert.equal(unavailable.http, 404);
  assert.match(unavailable.data.error, /会员或版权限制/);
  assert.equal(JSON.stringify(unavailable).includes('private-audio-key'), false);
});

test('汽水音频由本站流式转发，支持 Range 拖动和音源缓存，CDN 请求不携带账号 Cookie', async t => {
  const audio = Buffer.from('0123456789');
  let resolved = 0;
  const f = await fixture(t, (call, res) => {
    if (call.url.pathname.endsWith('/seo_track')) {
      resolved++;
      return json(res, { track_player: { video_model: JSON.stringify({ status: 10, media_type: 'audio', video_list: [{ main_url: 'https://audio.douyinvod.com/song.m4a', video_meta: { vtype: 'm4a' } }] }) } });
    }
    assert.equal(call.headers['x-test-upstream-host'], 'audio.douyinvod.com');
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers['x-session-id'], undefined);
    const partial = call.headers.range === 'bytes=3-5';
    const body = partial ? audio.subarray(3, 6) : audio;
    res.writeHead(partial ? 206 : 200, { 'content-type': 'audio/mp4', 'content-length': body.length, 'accept-ranges': 'bytes', ...(partial ? { 'content-range': 'bytes 3-5/10' } : {}) });
    res.end(body);
  });
  await f.request('/api/music/track/t1/url');
  const full = await f.raw('/api/music/track/t1/audio');
  assert.equal(full.status, 200);
  assert.equal(await full.text(), '0123456789');
  const partial = await f.raw('/api/music/track/t1/audio', { headers: { range: 'bytes=3-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 3-5/10');
  assert.equal(await partial.text(), '345');
  assert.equal(resolved, 1);
  assert.equal((await f.raw('/api/music/track/t1/audio', { headers: { range: 'bytes=0-1,3-5' } })).status, 416);
});

test('音频转发拒绝非官方主机和跨主机跳转，不成为任意地址代理', async t => {
  const f = await fixture(t, (call, res) => {
    if (call.url.pathname.endsWith('/seo_track')) return json(res, { track_player: { video_model: JSON.stringify({ video_list: [{ main_url: 'https://audio.douyinvod.com/song.m4a' }] }) } });
    res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end();
  });
  const result = await f.request('/api/music/track/t1/audio');
  assert.equal(result.http, 502);
  assert.equal(f.calls.length, 2);
  for (const url of ['https://douyinvod.com.evil.test/file', 'http://audio.douyinvod.com/file', 'https://user:pass@audio.douyinvod.com/file', 'https://audio.douyinvod.com:3000/file', 'http://127.0.0.1/file']) assert.throws(() => musicContent.audioSourceUrl(url));
});

test('网易云及外部汽水适配器仍使用各自接口与音源结构', async t => {
  const netease = await fixture(t, (call, res) => { assert.equal(call.url.pathname, '/api/song/enhance/player/url'); json(res, { code: 200, data: [{ url: 'https://example.com/netease.mp3' }] }); }, 'netease');
  assert.equal((await netease.request('/api/music/track/1/url')).data.url, 'https://example.com/netease.mp3');
  const adapter = await fixture(t, (call, res) => { assert.equal(call.url.pathname, '/download/url'); json(res, { data: { audio_url: 'https://example.com/adapter.mp3' } }); }, 'qishui', true);
  assert.equal((await adapter.request('/api/music/track/1/url')).data.url, 'https://example.com/adapter.mp3');
});

test('音源解析保留主备地址供转发回退', () => {
  const result = musicContent.playback({ track_player: { video_model: JSON.stringify({ video_duration: 30, video_list: [{ main_url: 'https://a.douyinvod.com/main.m4a', backup_url: 'https://b.douyinvod.com/backup.m4a' }] }) } });
  assert.equal(result.url, 'https://a.douyinvod.com/main.m4a');
  assert.deepEqual(result.candidates, ['https://a.douyinvod.com/main.m4a', 'https://b.douyinvod.com/backup.m4a']);
});
