import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { appearanceDefaults } from './appearance.js';

const dataDir = path.resolve('data');
const dbFile = path.join(dataDir, 'db.json');

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

const defaults = (username, password) => ({
  settings: {
    siteName: 'Status姬',
    siteDescription: '服务状态与基础设施监控',
    announcement: '欢迎来到服务状态页。系统每 5 分钟自动检查一次。',
    refreshSeconds: 300,
    historyDays: 7,
    publicMetrics: true,
    ...appearanceDefaults,
    accentColor: '#6aa9f7',
    logoText: 'SG',
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' },
    webhookUrl: '',
    sslWarningDays: 30,
    domainWarningDays: 30,
    music: { provider: process.env.MUSIC_PROVIDER || 'netease', cookie: '', sessionId: '', account: null, playlistId: '', playlistName: '', queue: [], randomEnabled: true, playMode: 'random', deviceId: '' },
    apiTokenHash: '',
    apiTokenPrefix: '',
    apiTokenCreatedAt: '',
    weather: { enabled: true, city: '杭州' }
  },
  users: [{ id: id(), username, passwordHash: bcrypt.hashSync(password, 12), mustChangePassword: password === 'ChangeMe123!', createdAt: now() }],
  categories: [{ id: 'cat-core', name: '核心服务', sort: 0 }, { id: 'cat-api', name: 'API 接口', sort: 1 }],
  monitors: [],
  domains: [],
  results: {},
  notifications: [],
  incidents: []
});

export async function loadDb() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(dbFile, 'utf8');
    const db = JSON.parse(raw);
    return migrate(db);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const db = defaults(process.env.ADMIN_USERNAME || 'admin', process.env.ADMIN_PASSWORD || 'ChangeMe123!');
    await saveDb(db);
    return db;
  }
}

function migrate(db) {
  db.settings ??= {};
  if (db.settings.siteName === 'Pulse Watch') db.settings.siteName = 'Status姬';
  if (db.settings.logoText === 'PW') db.settings.logoText = 'SG';
  for (const [key, value] of Object.entries(appearanceDefaults)) db.settings[key] ??= value;
  delete db.settings.background;
  delete db.settings.headerBackground;
  db.settings.smtp ??= { host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' };
  db.settings.apiTokenHash ??= '';
  db.settings.apiTokenPrefix ??= '';
  db.settings.apiTokenCreatedAt ??= '';
  db.settings.weather ??= { enabled: true, city: '杭州' };
  db.settings.refreshSeconds = Math.max(60, Number(db.settings.refreshSeconds) || 300);
  db.settings.historyDays = Math.min(30, Math.max(1, Number(db.settings.historyDays) || 7));
  db.settings.music ??= { provider: process.env.MUSIC_PROVIDER || 'netease', cookie: '', sessionId: '', account: null, playlistId: '', playlistName: '', queue: [], randomEnabled: true, playMode: 'random', deviceId: '' };
  db.settings.music.provider = ['netease', 'qishui'].includes(db.settings.music.provider) ? db.settings.music.provider : (process.env.MUSIC_PROVIDER || 'netease');
  db.settings.music.cookie = String(db.settings.music.cookie || '');
  db.settings.music.sessionId = String(db.settings.music.sessionId || '');
  db.settings.music.account = db.settings.music.account && typeof db.settings.music.account === 'object' ? db.settings.music.account : null;
  db.settings.music.playlistId = String(db.settings.music.playlistId || '');
  db.settings.music.playlistName = String(db.settings.music.playlistName || '');
  db.settings.music.queue = Array.isArray(db.settings.music.queue) ? db.settings.music.queue.slice(0, 300) : [];
  db.settings.music.randomEnabled = !db.settings.music.queue.length || db.settings.music.randomEnabled !== false;
  db.settings.music.playMode = ['random', 'sequential'].includes(db.settings.music.playMode) ? db.settings.music.playMode : 'random';
  db.settings.music.deviceId = String(db.settings.music.deviceId || '');
  db.settings.music.installId = String(db.settings.music.installId || '');
  db.users ??= [];
  db.categories ??= [];
  db.categories.forEach((category, index) => { category.sort = Number.isFinite(Number(category.sort)) ? Number(category.sort) : index; });
  db.monitors ??= [];
  db.monitors.forEach((monitor, index) => { monitor.sort = Number.isFinite(Number(monitor.sort)) ? Number(monitor.sort) : index; });
  db.domains ??= [];
  db.results ??= {};
  db.notifications ??= [];
  db.incidents ??= [];
  const cutoff = Date.now() - db.settings.historyDays * 86400000;
  for (const result of Object.values(db.results)) {
    if (!Array.isArray(result?.history)) continue;
    result.history = result.history.filter((point) => {
      const timestamp = Date.parse(point?.checkedAt || '');
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
  }
  return db;
}

let writeQueue = Promise.resolve();
export function saveDb(db) {
  writeQueue = writeQueue.then(async () => {
    const temp = `${dbFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(temp, dbFile);
  });
  return writeQueue;
}

export { id, now };
