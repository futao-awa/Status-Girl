export function parseVersion(value) {
  const match = String(value ?? '').trim().match(/^(?:v|release[-/]v?)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\w.-]+)?$/i);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return { parts, normalized: parts.join('.') };
}

export function normalizeVersion(value) {
  return parseVersion(value)?.normalized || '';
}

export function compareVersions(left, right) {
  const a = parseVersion(left)?.parts;
  const b = parseVersion(right)?.parts;
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function chooseVersionedRelease(entries = []) {
  return entries
    .filter((entry) => !entry?.draft && !entry?.prerelease)
    .map((entry) => {
      const version = normalizeVersion(entry?.tag_name ?? entry?.name ?? entry);
      return version ? { entry, version } : null;
    })
    .filter(Boolean)
    .sort((left, right) => compareVersions(right.version, left.version))[0] || null;
}

export function changelogSection(markdown, version) {
  const normalized = normalizeVersion(version);
  if (!normalized) return '';
  const lines = String(markdown ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = line.match(/^##[ \t]+\[?([^\]\s]+)\]?(?:[ \t]|$)/);
    return heading && normalizeVersion(heading[1]) === normalized;
  });
  if (start < 0) return '';
  const next = lines.findIndex((line, index) => index > start && /^##[ \t]+/.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next)
    .filter((line) => !/^\[[^\]]+\]:[ \t]+/.test(line)).join('\n').trim();
}
