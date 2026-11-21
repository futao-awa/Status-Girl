export const appearanceDefaults = Object.freeze({
  backgroundMode: 'random',
  randomBackgroundUrl: 'https://api.elaina.cat/random/',
  fixedBackgroundUrl: '',
  backgroundBlur: 0,
  backgroundOpacity: 1,
  surfaceOpacity: 0.82
});
export function appearanceSettings(settings = {}) {
  return Object.fromEntries(Object.entries(appearanceDefaults).map(([key, value]) => [key, settings[key] ?? value]));
}
export function validateAppearance(input) {
  const patch = {};
  for (const key of Object.keys(appearanceDefaults)) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (key === 'backgroundMode') {
      if (!['random', 'fixed'].includes(value)) throw new Error('请选择随机或固定背景');
      patch[key] = value;
    } else if (key.endsWith('Url')) {
      const url = String(value).trim();
      if (!url && key === 'fixedBackgroundUrl') { patch[key] = ''; continue; }
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error('背景地址必须是完整的 HTTP 或 HTTPS 图片地址'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 2048) throw new Error('背景地址格式无效');
      patch[key] = url;
    } else {
      const number = Number(value);
      const min = key === 'surfaceOpacity' ? 0.35 : 0;
      const max = key === 'backgroundBlur' ? 30 : 1;
      if (value === '' || !Number.isFinite(number) || number < min || number > max) throw new Error('背景模糊度或透明度超出范围');
      patch[key] = number;
    }
  }
  return patch;
}
