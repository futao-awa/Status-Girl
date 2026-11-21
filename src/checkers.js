import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import os from 'node:os';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

function normalizeUrl(value) {
  if (!/^https?:\/\//i.test(value)) return `https://${value}`;
  return value;
}

async function fetchCheck(monitor) {
  const url = normalizeUrl(monitor.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(monitor.timeoutMs) || 10000));
  const started = performance.now();
  try {
    const headers = { 'user-agent': 'Status-Girl/1.0.1', ...(monitor.headers || {}) };
    const response = await fetch(url, {
      method: monitor.method || 'GET',
      headers,
      body: ['GET', 'HEAD'].includes((monitor.method || 'GET').toUpperCase()) ? undefined : (monitor.body || undefined),
      signal: controller.signal,
      redirect: 'follow'
    });
    const text = await response.text();
    const expected = Number(monitor.expectedStatus || 200);
    const bodyOk = !monitor.expectedText || text.includes(monitor.expectedText);
    const ok = response.status === expected && bodyOk;
    return { ok, statusCode: response.status, latency: Math.round(performance.now() - started), error: ok ? '' : (!bodyOk ? '响应内容不匹配' : `状态码 ${response.status}`) };
  } catch (error) {
    return { ok: false, statusCode: 0, latency: Math.round(performance.now() - started), error: error.name === 'AbortError' ? '请求超时' : error.message };
  } finally { clearTimeout(timer); }
}

function parseHostPort(value) {
  const input = value.includes('://') ? new URL(value) : new URL(`tcp://${value}`);
  return { host: input.hostname, port: Number(input.port || 80) };
}

async function tcpCheck(monitor) {
  const { host, port } = parseHostPort(monitor.url);
  const timeout = Math.max(1000, Number(monitor.timeoutMs) || 10000);
  const started = performance.now();
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = result => { if (!settled) { settled = true; socket.destroy(); resolve({ ...result, latency: Math.round(performance.now() - started) }); } };
    socket.setTimeout(timeout, () => done({ ok: false, statusCode: 0, error: '连接超时' }));
    socket.once('connect', () => done({ ok: true, statusCode: 200, error: '' }));
    socket.once('error', error => done({ ok: false, statusCode: 0, error: error.message }));
  });
}

export async function inspectSsl(url, timeoutMs = 10000) {
  try {
    const parsed = new URL(normalizeUrl(url));
    if (parsed.protocol !== 'https:') return { supported: false, valid: false, daysRemaining: null, error: '非 HTTPS 地址' };
    const timeout = Math.max(1000, Number(timeoutMs) || 10000);
    return await new Promise(resolve => {
      const socket = tls.connect({ host: parsed.hostname, port: Number(parsed.port || 443), servername: parsed.hostname, rejectUnauthorized: false });
      let done = false;
      const finish = value => { if (!done) { done = true; socket.destroy(); resolve(value); } };
      socket.setTimeout(timeout, () => finish({ supported: true, valid: false, daysRemaining: null, error: 'TLS 连接超时' }));
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        const expiresAt = cert.valid_to ? new Date(cert.valid_to) : null;
        const daysRemaining = expiresAt ? Math.ceil((expiresAt - Date.now()) / 86400000) : null;
        finish({ supported: true, valid: Boolean(expiresAt && daysRemaining >= 0), daysRemaining, expiresAt: expiresAt?.toISOString() || null, issuer: cert.issuer?.O || cert.issuer?.CN || '' , error: '' });
      });
      socket.once('error', error => finish({ supported: true, valid: false, daysRemaining: null, error: error.message }));
    });
  } catch (error) { return { supported: true, valid: false, daysRemaining: null, error: error.message }; }
}

export async function checkMonitor(monitor) {
  const result = monitor.type === 'tcp' ? await tcpCheck(monitor) : await fetchCheck(monitor);
  const ssl = monitor.checkSsl ? await inspectSsl(monitor.url, monitor.timeoutMs) : null;
  if (ssl?.supported && (!ssl.valid || ssl.daysRemaining <= Number(monitor.sslWarningDays || 30))) {
    result.ssl = ssl;
    if (ssl.daysRemaining !== null && ssl.daysRemaining < 0) result.error = `SSL 已过期（${Math.abs(ssl.daysRemaining)} 天）`;
  } else if (ssl) result.ssl = ssl;
  return result;
}

export async function resolveDomain(domain) {
  try { return await dns.lookup(domain); } catch { return null; }
}

export async function getServerMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  let disk = { total: 0, free: 0, used: 0, usedPercent: 0 };
  try {
    const stat = await fs.statfs(process.cwd());
    disk.total = Number(stat.blocks) * Number(stat.bsize);
    disk.free = Number(stat.bavail) * Number(stat.bsize);
    disk.used = Math.max(0, disk.total - disk.free);
    disk.usedPercent = disk.total ? Math.round(disk.used / disk.total * 100) : 0;
  } catch { /* statfs may not be available on older Node/hosts */ }
  return {
    load: os.loadavg().map(n => Number(n.toFixed(2))),
    cpuCount: os.cpus().length,
    memory: { total: totalMem, free: freeMem, used: totalMem - freeMem, usedPercent: Math.round((1 - freeMem / totalMem) * 100) },
    disk,
    uptime: os.uptime(),
    processUptime: process.uptime(),
    platform: `${os.platform()} ${os.arch()}`,
    hostname: os.hostname(),
    checkedAt: new Date().toISOString()
  };
}
