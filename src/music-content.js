const httpUrl = value => typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const first = (...values) => values.find(value => value !== undefined && value !== null && value !== '');

export function imageUrl(value) {
  if (typeof value === 'string') return httpUrl(value);
  if (Array.isArray(value)) return value.map(imageUrl).find(Boolean) || '';
  if (!value || typeof value !== 'object') return '';
  const base = imageUrl(value.urls || value.url_list || value.urlList);
  if (base && value.uri && !httpUrl(value.uri)) {
    const suffix = value.template || (value.template_prefix ? `${value.template_prefix}-crop-center:192:192.jpg` : '');
    return `${base.replace(/\/+$/, '')}/${value.uri}${suffix ? `~${suffix}` : ''}`;
  }
  return base || imageUrl(value.url || value.uri);
}

function artistNames(value, depth = 0) {
  if (depth > 4 || !value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => artistNames(item, depth + 1));
  const name = first(value.name, value.nickname, value.author_name, value.artist_name);
  return name ? [String(name)] : ['artist', 'artists', 'author', 'author_info', 'user_info', 'link', 'entity'].flatMap(key => artistNames(value[key], depth + 1));
}

export function normalizeTrack(item) {
  const entity = item?.entity || item?.media || item;
  const track = entity?.track_wrapper?.track || entity?.track_entity || entity?.track || entity?.song || entity;
  // 推荐和歌单的卡片 ID 不是歌曲 ID，只接收实际 track 实体。
  if (item?.type && !['track', 'music', 'song'].includes(item.type) && !entity?.track_wrapper?.track && !entity?.track) return { id: '', title: '', artist: '', album: '', cover: '', duration: 0 };
  const base = track?.base_info || track;
  const album = first(base?.al, base?.album, track?.related_info?.album_link, item?.album_info, item?.album);
  const artists = first(base?.ar, base?.artists, base?.artist, base?.author, base?.singer, track?.related_info?.artist_links, item?.author_info, item?.artist, item?.author_name);
  return {
    id: String(first(base?.id, base?.track_id, base?.trackId, item?.item_id, item?.song_id, item?.music_id) || ''),
    title: String(first(base?.name, base?.title, base?.track_name, item?.title) || '未命名歌曲'),
    artist: [...new Set(artistNames(artists))].join(' / ') || '未知歌手',
    album: String(typeof album === 'string' ? album : first(album?.name, album?.title, item?.album_name) || ''),
    cover: imageUrl(first(base?.al?.picUrl, base?.album?.picUrl, base?.cover, base?.cover_url, base?.url_cover, track?.display_info?.url_cover, item?.cover_url, album?.url_cover)),
    duration: Number(first(base?.duration_ms, base?.duration, base?.dt, item?.duration) || 0)
  };
}

export function normalizePlaylist(item) {
  const playlist = item?.playlist || item;
  return {
    id: String(first(playlist?.id, playlist?.playlist_id, playlist?.playlistId) || ''),
    name: String(first(playlist?.name, playlist?.title) || '未命名歌单'),
    cover: imageUrl(first(playlist?.coverImgUrl, playlist?.cover, playlist?.cover_url, playlist?.url_cover)),
    trackCount: Number(first(playlist?.trackCount, playlist?.count_tracks, playlist?.track_count, playlist?.song_count, playlist?.resource_cnt?.track_cnt, playlist?.tracks?.length) || 0)
  };
}

export function trackRows(payload) {
  if (Array.isArray(payload)) return payload;
  const data = payload?.data ?? payload ?? {};
  const arrays = [data.media_resources, data.track_list, data.tracks, data.items, data.list, data.songs, data.result?.songs, data.result?.result, data.result?.recommend, data.result, data.recommend, data.data?.songs, data.data?.tracks, data.search_result, data.music_list];
  return arrays.find(value => Array.isArray(value) && value.length) || [];
}

function parsedObject(value) {
  if (typeof value !== 'string') return object(value);
  if (value.length > 2000000) return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}
export function playback(payload) {
  const data = payload?.data ?? payload ?? {};
  const player = data.track_player || {};
  const model = parsedObject(player.video_model);
  // video_model 的 status=10 也有有效音源，不能套用业务 status_code 的规则。
  const streams = Array.isArray(model.video_list) ? model.video_list : [];
  // 网页已授权的标准音频直接播放；不把加密文件或视频地址当成音频。
  const playable = streams.filter(stream => !first(stream.spade_a, stream.play_auth, stream.encrypt_info?.spade_a, model.spade_a, model.play_auth) && !/video/i.test(String(stream.video_meta?.vtype || model.media_type || '')));
  playable.sort((a, b) => Number(!/mp3|aac|m4a/i.test(a.video_meta?.vtype || '')) - Number(!/mp3|aac|m4a/i.test(b.video_meta?.vtype || '')));
  const stream = playable.find(item => httpUrl(item.main_url) || httpUrl(item.backup_url));
  if (stream) {
    const duration = Number(model.video_duration || 0);
    const track = data.seo_track?.track || data.track || {};
    const fullDuration = Number(track.duration || 0) / 1000;
    return { url: httpUrl(stream.main_url) || httpUrl(stream.backup_url), duration, preview: fullDuration > 0 && duration > 0 && duration + 3 < fullDuration };
  }
  if (streams.length) return { url: '' };
  if (Array.isArray(data)) return data.map(playback).find(value => value.url) || { url: '' };
  for (const key of ['url', 'audio_url', 'audioUrl', 'playUrl', 'play_url', 'download_url', 'downloadUrl', 'main_url']) if (httpUrl(data[key])) return { url: data[key] };
  for (const key of ['result', 'song', 'music', 'media', 'track_player', 'video_model']) {
    const result = playbackNode(data[key]);
    if (result.url) return result;
  }
  return { url: '' };
}
function playbackNode(value) {
  return value && typeof value === 'object' ? playback(value) : { url: '' };
}

export function contentError(provider, payload, httpStatus = 200, empty = false) {
  const code = contentCode(provider, payload);
  const label = provider === 'qishui' ? '汽水音乐' : '网易云音乐';
  const auth = [301, 401, 403].includes(Number(code)) || httpStatus === 401;
  const detail = auth ? '登录已失效，请在后台重新扫码' : empty ? '接口返回空响应，请稍后重试' : Number(code) ? `接口返回错误（${code}）` : `请求失败（HTTP ${httpStatus}）`;
  return Object.assign(new Error(label + detail), { code: String(code || (empty ? 'UPSTREAM_EMPTY' : 'UPSTREAM_ERROR')), retryable: empty || httpStatus === 429 || httpStatus >= 500 });
}

export function assertContent(provider, payload) {
  const data = payload?.data ?? payload ?? {};
  const code = contentCode(provider, payload);
  if ((code && !(provider === 'netease' && code === 200)) || data.message === 'error') throw contentError(provider, payload);
}
export function audioSourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('音乐平台返回了无效音源地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !['douyinvod.com', 'bytecdn.cn'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('音乐平台返回了不支持的音源地址');
  return url;
}
function contentCode(provider, payload) {
  const data = payload?.data ?? payload ?? {};
  return [data.status_info?.status_code, data.status_code, data.error_code, payload?.errno, provider === 'netease' ? payload?.code : undefined].map(Number).find(value => Number.isFinite(value) && value !== 0) || 0;
}
